// İzleme servisinin çekirdeği: veritabanı + PLC toplayıcı + olay işleyici + raporlar.
// Canlı sunucu (monitor/server.js) ve testler (test/smoke.js) aynı sınıfı kullanır.
import { MON_CELLS, PLCS, SINGLE_PLC } from '../public/iomap.js';
import { openDb } from './db.js';
import { Collector } from './collector.js';
import { Ingest } from './ingest.js';
import { cellOee, alarmPareto, shiftOf, categoryTimes } from './oee.js';
import { palletTrace, palletCips, recall, reconcile, inferPackCups } from './queries.js';

// mode 'tek': bütün hücreler tek PLC'den; 'bolunmus': her hücre kendi PLC'sinden
export function cellPlcMap(mode) {
  return Object.fromEntries(MON_CELLS.map((c) => [c.id, mode === 'tek' ? SINGLE_PLC.id : c.plc]));
}

export class Monitor {
  // clock: canlıda Date.now; testlerde verilmez, "şimdi" son örnek zamanıdır
  constructor({ file = ':memory:', mode = 'tek', shiftMin = 0, clock = null } = {}) {
    this.clock = clock;
    this.db = openDb(file);
    this.mode = mode;
    this.shiftCfg = { shiftMin };
    this.cellPlc = cellPlcMap(mode);
    this.plcs = mode === 'tek' ? [SINGLE_PLC] : PLCS;
    this.collector = new Collector(this.db, { cellPlc: this.cellPlc });
    this.ingest = new Ingest(this.db);
    this.lastTs = 0;
  }

  get now() { return this.clock ? this.clock() : this.lastTs; }
  sample(ts, images) { this.lastTs = ts; this.collector.sample(ts, images); }
  events(resp, ts = this.lastTs) { return this.ingest.apply(resp, ts); }

  // ---- raporlar -------------------------------------------------------------------
  oee(t0, t1) {
    return MON_CELLS.map((c) => cellOee(this.db, c.id, t0, t1, this.now, this.lastTs));
  }

  current() {
    return this.db.prepare(`SELECT cell, state, category, ts_start FROM state_interval WHERE ts_end IS NULL`).all();
  }

  activeAlarms() {
    return this.db.prepare(`SELECT * FROM alarm_event WHERE ts_off IS NULL ORDER BY ts_on DESC`).all();
  }

  alarmHistory(t0, t1, limit = 200) {
    return this.db.prepare(`SELECT * FROM alarm_event WHERE ts_on < ? AND (ts_off IS NULL OR ts_off > ?)
      ORDER BY ts_on DESC LIMIT ?`).all(t1, t0, limit);
  }

  pareto(t0, t1, opts) { return alarmPareto(this.db, t0, t1, this.now, opts); }

  timeline(t0, t1) {
    const rows = this.db.prepare(`SELECT cell, state, category, ts_start, COALESCE(ts_end, ?) AS ts_end FROM state_interval
      WHERE ts_start < ? AND (ts_end IS NULL OR ts_end > ?) ORDER BY ts_start`).all(this.lastTs, t1, t0);
    return rows.map((r) => ({ ...r, ts_start: Math.max(r.ts_start, t0), ts_end: Math.min(r.ts_end, t1) }));
  }

  longestStops(t0, t1, limit = 10) {
    const end = Math.min(t1, this.lastTs);
    return this.db.prepare(`SELECT cell, state, category, ts_start, MIN(COALESCE(ts_end, ?), ?) - MAX(ts_start, ?) AS ms
      FROM state_interval WHERE category NOT IN ('URETIM', 'VERI_YOK') AND ts_start < ? AND COALESCE(ts_end, ?) > ?
      ORDER BY ms DESC LIMIT ?`).all(end, end, t0, end, end, t0, limit);
  }

  counters(t0, t1) {
    const one = (sql, ...a) => this.db.prepare(sql).get(...a).n;
    return {
      cupsOut: one(`SELECT COUNT(*) AS n FROM cup WHERE result = 'out' AND ts_done > ? AND ts_done <= ?`, t0, t1),
      cupsRejected: one(`SELECT COUNT(*) AS n FROM cup WHERE result = 'reject' AND ts_done > ? AND ts_done <= ?`, t0, t1),
      cupsLost: one(`SELECT COUNT(*) AS n FROM cup WHERE result = 'lost' AND ts_done > ? AND ts_done <= ?`, t0, t1),
      packs: one(`SELECT COUNT(*) AS n FROM pack WHERE is_test = 0 AND crushed = 0 AND ts_formed > ? AND ts_formed <= ?`, t0, t1),
      pallets: one(`SELECT COUNT(*) AS n FROM pallet WHERE ts_done > ? AND ts_done <= ?`, t0, t1),
      stored: one(`SELECT COUNT(*) AS n FROM pallet WHERE ts_stored > ? AND ts_stored <= ?`, t0, t1),
      shipped: one(`SELECT COUNT(*) AS n FROM pallet WHERE ts_shipped > ? AND ts_shipped <= ?`, t0, t1),
      inStock: one(`SELECT COUNT(*) AS n FROM pallet WHERE status = 'depoda' AND ? >= 0 AND ? >= 0`, t0, t1),
      cips: one(`SELECT COUNT(*) AS n FROM cip WHERE ts_end > ? AND ts_end <= ?`, t0, t1),
    };
  }

  // hat sonu verimi: dolan bardaklardan depoya giren paletlerde olanların oranı (kimlikli izlemeden)
  lineYield(t0, t1) {
    const filled = this.db.prepare(`SELECT COUNT(*) AS n FROM cup WHERE ts_done > ? AND ts_done <= ?`).get(t0, t1).n;
    const stored = this.db.prepare(`SELECT COUNT(*) AS n FROM cup c JOIN pack k ON k.run = c.run AND k.pack = c.pack
      AND k.dropped = 0 JOIN pallet p ON p.run = k.run AND p.pallet = k.pallet
      WHERE p.ts_stored IS NOT NULL AND c.ts_done > ? AND c.ts_done <= ?`).get(t0, t1).n;
    return { filled, stored, rate: filled ? stored / filled : null };
  }

  pallets(limit = 50) {
    return this.db.prepare(`SELECT label, run, pallet, status, packs, loc, ts_done, ts_stored, ts_shipped, ship_order,
      (SELECT COUNT(*) FROM pack k WHERE k.run = p.run AND k.pallet = p.pallet AND k.dropped = 0) AS placed
      FROM pallet p ORDER BY ts_start DESC LIMIT ?`).all(limit);
  }

  cips(limit = 20) { return this.db.prepare('SELECT * FROM cip ORDER BY ts_end DESC LIMIT ?').all(limit); }
  lots() { return this.db.prepare('SELECT * FROM lot ORDER BY ts DESC').all(); }

  trace(label) { return palletTrace(this.db, label); }
  palletCips(label) { return palletCips(this.db, label); }
  recall(q) { return recall(this.db, q); }
  reconcile(t0, t1) { return reconcile(this.db, t0, t1); }
  inferPackCups(run) { return inferPackCups(this.db, run); }
  gaps() {
    return {
      ingest: this.db.prepare('SELECT * FROM ingest_gap ORDER BY ts DESC LIMIT 20').all(),
      comm: this.db.prepare('SELECT * FROM comm_gap ORDER BY ts_start DESC LIMIT 20').all(),
      counterResets: this.db.prepare('SELECT * FROM counter_reset ORDER BY ts DESC LIMIT 20').all(),
    };
  }

  shift(ts = this.lastTs) { return shiftOf(ts, this.shiftCfg); }

  // vardiya raporu
  report(t0, t1) {
    return {
      t0, t1, now: this.lastTs,
      oee: this.oee(t0, t1),
      counters: this.counters(t0, t1),
      lineYield: this.lineYield(t0, t1),
      pareto: this.pareto(t0, t1).slice(0, 5),
      longest: this.longestStops(t0, t1, 5),
      cips: this.db.prepare('SELECT * FROM cip WHERE ts_end > ? AND ts_end <= ? ORDER BY ts_end').all(t0, t1),
      reconcile: this.reconcile(t0, t1),
      gaps: this.gaps(),
    };
  }

  categoryTimes(cell, t0, t1) { return categoryTimes(this.db, cell, t0, t1, this.now, this.lastTs); }
}
