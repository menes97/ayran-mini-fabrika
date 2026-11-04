// OEE, kayıp ağacı, alarm Pareto'su, vardiyalar.
// Payda vardiya (takvim) süresidir; yalnızca VERI_YOK (PLC'ye ulaşılamayan ya da izlemenin
// kapalı olduğu, hiç kaydı olmayan süre) düşülür. URETIM dışındaki her kategori kayıptır.
import { MON_CELLS, OEE_CATEGORIES } from '../public/iomap.js';

const CATS = Object.keys(OEE_CATEGORIES);

// [t0, t1) aralığında hücrenin kategori süreleri (ms). Açık aralık son örneğe (last) kadar sayılır;
// son örnekten şimdiye (now) kadar ve hiç kaydı olmayan süre VERI_YOK'tur (izleme durmuş olabilir).
export function categoryTimes(db, cell, t0, t1, now = t1, last = now) {
  const end = Math.min(t1, now);
  const openEnd = Math.min(end, last);
  const rows = db.prepare(`SELECT category, ts_start, ts_end FROM state_interval
    WHERE cell = ? AND ts_start < ? AND (ts_end IS NULL OR ts_end > ?)`).all(cell, end, t0);
  const out = Object.fromEntries(CATS.map((k) => [k, 0]));
  let covered = 0;
  for (const r of rows) {
    const d = Math.min(r.ts_end ?? openEnd, end) - Math.max(r.ts_start, t0);
    if (d <= 0) continue;
    out[r.category] = (out[r.category] || 0) + d;
    covered += d;
  }
  out.VERI_YOK += Math.max(0, end - t0 - covered);   // kaydı olmayan süre
  return { times: out, span: Math.max(0, end - t0) };
}

export function cellOee(db, cellId, t0, t1, now = t1, last = now) {
  const cfg = MON_CELLS.find((c) => c.id === cellId);
  const { times, span } = categoryTimes(db, cellId, t0, t1, now, last);
  const planned = span - times.VERI_YOK;
  const run = times.URETIM;
  const p = db.prepare(`SELECT COALESCE(SUM(good), 0) AS good, COALESCE(SUM(reject), 0) AS reject
    FROM production WHERE cell = ? AND gap = 0 AND ts > ? AND ts <= ?`).get(cellId, t0, Math.min(t1, now));
  const gapP = db.prepare(`SELECT COALESCE(SUM(good + reject), 0) AS n FROM production
    WHERE cell = ? AND gap = 1 AND ts > ? AND ts <= ?`).get(cellId, t0, Math.min(t1, now)).n;
  const total = p.good + p.reject;
  const ms = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(MIN(ts_start + dur_ms, ?) - MAX(ts_start, ?)), 0) AS dur
    FROM micro_stop WHERE cell = ? AND ts_start < ? AND ts_start + dur_ms > ?`).get(t1, t0, cellId, t1, t0);
  const A = planned > 0 ? run / planned : null;
  const res = { cell: cellId, name: cfg.name, unit: cfg.unit, oee: cfg.oee, span, planned, times,
    good: p.good, reject: p.reject, total, unobserved: gapP, micro: { n: ms.n, ms: ms.dur }, A };
  if (!cfg.oee) {
    res.utilization = A;     // lojistik ve proses: kullanım oranı
    return res;
  }
  const idealMs = cfg.idealS * 1000;
  const Praw = run > 0 ? (total * idealMs) / run : null;
  const P = Praw == null ? null : Math.min(1, Praw);
  // Ölçülmeyen kalite Q = null döner (panelde "—"); bu hücrelerde OEE = A × P ve qualityMeasured = false
  // ile "OEE (Q ölçülmüyor)" diye etiketlenir, kalite ölçen hücreyle doğrudan kıyaslanmaz.
  const Q = cfg.quality ? (total > 0 ? p.good / total : null) : null;
  const OEE = A != null && P != null ? A * P * (Q ?? 1) : null;
  // kayıp ağacı: her kaybın süresi ve "kayıp adet" karşılığı
  const losses = CATS.filter((k) => OEE_CATEGORIES[k].loss && times[k] > 0)
    .map((k) => ({ cat: k, label: OEE_CATEGORIES[k].label, own: OEE_CATEGORIES[k].own, ms: times[k],
      units: times[k] / idealMs }))
    .sort((a, b) => b.ms - a.ms);
  const speedLossMs = Praw != null ? Math.max(0, run - total * idealMs) : 0;
  return { ...res, idealS: cfg.idealS, Praw, P, Q, qualityMeasured: !!cfg.quality, OEE, losses,
    speedLossMs, warnIdeal: Praw != null && Praw > 1.02 };
}

// Alarm Pareto'su: adet ve [t0, t1) içindeki toplam süre
export function alarmPareto(db, t0, t1, now = t1, { severity = 'alarm', cell } = {}) {
  const end = Math.min(t1, now);
  const rows = db.prepare(`SELECT cell, bit, text, severity, COUNT(*) AS n,
      SUM(MIN(COALESCE(ts_off, ?), ?) - MAX(ts_on, ?)) AS ms
    FROM alarm_event
    WHERE ts_on < ? AND (ts_off IS NULL OR ts_off > ?) ${severity ? 'AND severity = ?' : ''} ${cell ? 'AND cell = ?' : ''}
    GROUP BY cell, bit ORDER BY n DESC, ms DESC`)
    .all(...[end, end, t0, end, t0, ...(severity ? [severity] : []), ...(cell ? [cell] : [])]);
  const total = rows.reduce((a, r) => a + r.n, 0);
  let acc = 0;
  return rows.map((r) => { acc += r.n; return { ...r, cum: total ? acc / total : 0 }; });
}

// Vardiyalar: varsayılan 06-14-22 (yerel saat); demo için shiftMin dakikalık vardiyalar (çağdan itibaren).
export function shiftOf(ts, { shiftMin = 0, starts = [6, 14, 22] } = {}) {
  if (shiftMin > 0) {
    const len = shiftMin * 60000, i = Math.floor(ts / len);
    return { id: `V${i}`, name: `Vardiya ${i}`, t0: i * len, t1: (i + 1) * len };
  }
  const d = new Date(ts);
  const h = d.getHours() + d.getMinutes() / 60;
  let idx = starts.length - 1;
  for (let i = 0; i < starts.length; i++) if (h >= starts[i]) idx = i;
  const s = new Date(d); s.setHours(starts[idx], 0, 0, 0);
  if (h < starts[0]) s.setDate(s.getDate() - 1);
  const e = new Date(s); e.setHours(starts[(idx + 1) % starts.length], 0, 0, 0);
  if (e <= s) e.setDate(e.getDate() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  const id = `${s.getFullYear()}${pad(s.getMonth() + 1)}${pad(s.getDate())}-${idx + 1}`;
  return { id, name: `${pad(s.getDate())}.${pad(s.getMonth() + 1)} ${idx + 1}. vardiya (${pad(starts[idx])}:00)`,
    t0: s.getTime(), t1: e.getTime() };
}
