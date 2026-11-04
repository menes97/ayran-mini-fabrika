// PLC yoklamasından olay temelli kayıt: durum aralıkları, alarm olayları, sayaç farkları,
// mikro duruşlar, CIP kayıtları, haberleşme boşlukları. Değişmeyen değer yazılmaz.
//
// sample(ts, images): images = { [plcId]: hr dizisi (simülatör adresleriyle, 112) | null (ulaşılamadı) }
import * as M from '../public/iomap.js';
import { tx } from './db.js';

const ALARM_TEXTS = { ALARMS: M.ALARMS, TANK_ALARMS: M.TANK_ALARMS, SHRINK_ALARMS: M.SHRINK_ALARMS,
  PAL_ALARMS: M.PAL_ALARMS, AGV_ALARMS: M.AGV_ALARMS, ASRS_ALARMS: M.ASRS_ALARMS };

// Sayaç farkı. wrap: 0..wrap-1 sarar. level: palet başına sıfırlanan seviye (yalnızca artışlar).
// Azalma: fark yarım turdan büyükse sarma, değilse PLC yeniden başlamış (yeni değerin tamamı sayılır).
export function counterDelta(cfg, old, now) {
  if (old == null) return { d: 0 };
  if (cfg.level) return { d: now > old ? now - old : now < old ? now : 0 };
  if (now >= old) return { d: now - old };
  if (old - now > cfg.wrap / 2) return { d: now + cfg.wrap - old, wrapped: true };
  return { d: now, reset: true };
}

export class Collector {
  // cellPlc: { dolum: 'tek' | 'proses', ... }  hücrenin hangi PLC görüntüsünden okunacağı
  constructor(db, { cellPlc }) {
    this.db = db;
    this.cellPlc = cellPlc;
    this.cells = M.MON_CELLS.map((c) => ({
      ...c,
      a: { state: M.tagAddr(c.state), alarm: M.tagAddr(c.alarm), status: M.tagAddr(c.state.replace(/STATE$/, 'STATUS')), good: c.good && M.tagAddr(c.good.tag),
        reject: c.reject && M.tagAddr(c.reject.tag) },
      texts: ALARM_TEXTS[c.alarmsKey],
      cur: null,          // { state, cat, id }
      alarm: 0, alarmRows: new Map(),
      micro: null,        // { lastTs, first }
      afterGap: true,     // son örnekten beri veri boşluğu var (açılış da sayılır): sonraki fark gap=1
    }));
    this.cip = { a: Object.fromEntries(['res', 'minT', 'minF', 'cond', 'dur'].map((k) => [k, M.tagAddr(M.MON_CIP[k])])),
      start: null, pending: null, lastIn: null, gap: false };
    this.plcGap = new Map();   // plc → açık comm_gap satırı
    const p = (sql) => db.prepare(sql);
    this.q = {
      openSi: p('INSERT INTO state_interval (plc, cell, state, category, ts_start) VALUES (?, ?, ?, ?, ?)'),
      closeSi: p('UPDATE state_interval SET ts_end = ? WHERE id = ?'),
      alarmOn: p('INSERT INTO alarm_event (cell, bit, text, severity, ts_on) VALUES (?, ?, ?, ?, ?)'),
      alarmOff: p('UPDATE alarm_event SET ts_off = ? WHERE id = ?'),
      prod: p('INSERT INTO production (cell, ts, good, reject, gap) VALUES (?, ?, ?, ?, ?)'),
      micro: p('INSERT INTO micro_stop (cell, ts_start, dur_ms) VALUES (?, ?, ?)'),
      cip: p(`INSERT INTO cip (plc, ts_start, ts_end, result, min_temp, min_flow, final_cond, duration_s, end_uncertain)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      gapOpen: p('INSERT INTO comm_gap (plc, ts_start) VALUES (?, ?)'),
      gapClose: p('UPDATE comm_gap SET ts_end = ? WHERE id = ?'),
      ctrGet: p('SELECT value FROM meta WHERE key = ?'),
      ctrSet: p('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
      reset: p('INSERT INTO counter_reset (cell, counter, ts, old, new) VALUES (?, ?, ?, ?, ?)'),
    };
    this.recover();
    // yarım kalan CIP izi (izleme servisi CIP sırasında ya da kayıt okunmadan kapandıysa)
    const saved = this.q.ctrGet.get('cip_state');
    if (saved) Object.assign(this.cip, JSON.parse(saved.value), { gap: true });
  }

  // İzleme servisi yeniden başladı: açık aralıklar ve alarmlar son örnek zamanında kapatılır.
  // Arada geçen süre kayıtsız kalır; OEE hesabı onu VERI_YOK sayar.
  recover() {
    const last = Number(this.q.ctrGet.get('last_sample_ts')?.value ?? 0);
    if (!last) return;
    this.db.prepare('UPDATE state_interval SET ts_end = ? WHERE ts_end IS NULL').run(last);
    this.db.prepare('UPDATE alarm_event SET ts_off = ? WHERE ts_off IS NULL').run(last);
    this.db.prepare('UPDATE comm_gap SET ts_end = ? WHERE ts_end IS NULL').run(last);
  }

  counter(cell, name, raw) {
    const key = `ctr:${cell.id}:${name}`;
    const old = this.q.ctrGet.get(key);
    this.q.ctrSet.run(key, String(raw));
    return old == null ? null : Number(old.value);
  }

  sample(ts, images) {
    tx(this.db, () => {
      for (const [plc, img] of Object.entries(images)) this.commGap(plc, ts, img == null);
      for (const c of this.cells) {
        const img = images[this.cellPlc[c.id]];
        if (img === undefined) continue;            // bu hücrenin PLC'si yoklanmıyor
        this.sampleCell(c, ts, img);
      }
      const tankImg = images[this.cellPlc.tank];
      if (tankImg !== undefined) this.sampleCip(ts, tankImg, this.cellPlc.tank);
      this.q.ctrSet.run('last_sample_ts', String(ts));
    });
  }

  commGap(plc, ts, down) {
    const open = this.plcGap.get(plc);
    if (down && open == null) this.plcGap.set(plc, this.q.gapOpen.run(plc, ts).lastInsertRowid);
    if (!down && open != null) { this.q.gapClose.run(ts, open); this.plcGap.delete(plc); }
  }

  sampleCell(c, ts, img) {
    const plc = this.cellPlc[c.id];
    const state = img ? img[c.a.state] : -1;
    let cat = img ? (c.cat[state] ?? 'ARIZA') : 'VERI_YOK';
    if (img && ((img[c.a.status] & 0x0080) || (c.id === 'shrink' && (img[c.a.status] & 0x0100)))
        && cat !== 'ARIZA' && cat !== 'GUVENLIK') cat = 'HAZIRLIK';
    // durum aralığı: durum kodu ya da kategori değişince
    if (!c.cur || c.cur.state !== state || c.cur.cat !== cat) {
      if (c.cur) this.q.closeSi.run(ts, c.cur.id);
      c.cur = { state, cat, id: this.q.openSi.run(plc, c.id, state, cat, ts).lastInsertRowid };
      c.micro = cat === 'URETIM' ? { lastTs: ts, first: true } : null;
    }
    if (!img) { c.afterGap = true; return; }   // ulaşılamayan PLC: alarm ve sayaç bilinmiyor, son değerler korunur

    // alarm kenarları
    const word = img[c.a.alarm];
    const changed = word ^ c.alarm;
    for (let bit = 0; bit < 16; bit++) {
      if (!((changed >> bit) & 1)) continue;
      if ((word >> bit) & 1) {
        const def = c.texts.find((x) => x.bit === bit);
        const text = def ? def.text : `bit ${bit}`;
        const sev = text.startsWith('Uyarı') ? 'uyari' : 'alarm';
        c.alarmRows.set(bit, this.q.alarmOn.run(c.id, bit, text, sev, ts).lastInsertRowid);
      } else if (c.alarmRows.has(bit)) {
        this.q.alarmOff.run(ts, c.alarmRows.get(bit));
        c.alarmRows.delete(bit);
      }
    }
    c.alarm = word;

    // üretim sayaçları
    let good = 0, rej = 0;
    if (c.good) {
      const raw = img[c.a.good], old = this.counter(c, 'good', raw);
      const r = counterDelta(c.good, old, raw);
      if (r.reset) this.q.reset.run(c.id, 'good', ts, old, raw);
      good = r.d;
    }
    if (c.reject) {
      const raw = img[c.a.reject], old = this.counter(c, 'reject', raw);
      const r = counterDelta(c.reject, old, raw);
      if (r.reset) this.q.reset.run(c.id, 'reject', ts, old, raw);
      rej = r.d;
    }
    const gap = c.afterGap;
    c.afterGap = false;
    if (good || rej) this.q.prod.run(c.id, ts, good, rej, gap ? 1 : 0);

    // mikro duruş: URETIM'de adet 3 × ideal çevrimden uzun gelmezse (ilk adet = hat dolumu, sayılmaz)
    if (c.oee && c.micro && good + rej > 0 && !gap) {
      const gap = ts - c.micro.lastTs, limit = 3 * c.idealS * 1000;
      if (!c.micro.first && gap > limit && gap <= 120000) this.q.micro.run(c.id, c.micro.lastTs, gap);
      c.micro = { lastTs: ts, first: false };
    }
  }

  // CIP kaydı: tank durumu CIP adımlarından (4..8) çıkınca, bir sonraki örnekte PLC'nin kayıt
  // register'ları okunur (aynı taramada güncellenmiş olmayabilir)
  // Bitiş zamanı olarak CIP'in en son görüldüğü an yazılır: aktarım CIP sırasında başlayamadığı için
  // bundan sonra başlayan her aktarım CIP sonrasıdır. Arada veri boşluğu varsa bitiş "belirsiz" işaretlenir.
  sampleCip(ts, img, plc) {
    const tank = this.cells.find((c) => c.id === 'tank');
    const inCip = M.MON_CIP.states.includes(tank.cur?.state);
    const s = this.cip;
    if (!img) { s.gap = true; return; }
    if (s.pending) {
      // kayıt register'ları bir boşluktan sonra okunuyorsa arada başka CIP bitmiş olabilir: belirsiz
      const a = s.a;
      this.q.cip.run(plc, s.pending.start, s.pending.end, img[a.res], img[a.minT] / 10, img[a.minF] / 100,
        img[a.cond] / 10, img[a.dur], s.pending.uncertain || s.gap ? 1 : 0);
      s.pending = null;
    }
    if (inCip) { if (s.start == null) s.start = ts; s.lastIn = ts; }
    if (!inCip && s.start != null) {
      // bitiş = CIP'in en son görüldüğü örnek (ilk CIP dışı örnek değil): ondan sonra başlayan
      // aktarım CIP sonrasıdır; yoklama gecikmesi aktarımı önceki CIP'e kaydırmasın
      s.pending = { start: s.start, end: s.lastIn, uncertain: s.gap };
      s.start = null; s.lastIn = null;
    }
    s.gap = false;
    this.q.ctrSet.run('cip_state', JSON.stringify({ start: s.start, pending: s.pending, lastIn: s.lastIn }));
  }
}
