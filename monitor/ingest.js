// Hat takip olaylarını izlenebilirlik tablolarına işler.
// En az bir kez teslim: her işleyici tekrar çalıştığında aynı sonucu verir (INSERT OR IGNORE,
// mutlak değerli UPDATE). İmleç (ingest.last_seq) olay grubuyla aynı işlemde yazılır.
import { tx, palletLabel } from './db.js';

export class Ingest {
  constructor(db, source = 'sim') {
    this.db = db;
    this.source = source;
    const p = (sql) => db.prepare(sql);
    this.q = {
      cursor: p('SELECT run, last_seq FROM ingest WHERE source = ?'),
      setCursor: p('INSERT OR REPLACE INTO ingest (source, run, last_seq) VALUES (?, ?, ?)'),
      gap: p('INSERT INTO ingest_gap (source, run, from_seq, to_seq, ts) VALUES (?, ?, ?, ?, ?)'),
      lot: p('INSERT OR IGNORE INTO lot (run, lot, ts, kg) VALUES (?, ?, ?, ?)'),
      xferStart: p('INSERT OR IGNORE INTO transfer (run, transfer, lot, ts_start, initial) VALUES (?, ?, ?, ?, ?)'),
      xferEnd: p('UPDATE transfer SET ts_end = ?, kg = ? WHERE run = ? AND transfer = ?'),
      cup: p(`INSERT OR IGNORE INTO cup (run, cup, ts_fill, ts_done, net_g, seal_c, result, sim_defect)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      cupXfer: p('INSERT OR IGNORE INTO cup_transfer (run, cup, transfer, frac) VALUES (?, ?, ?, ?)'),
      cupLost: p("UPDATE cup SET result = 'lost', lost_where = ? WHERE run = ? AND cup = ?"),
      pack: p(`INSERT OR IGNORE INTO pack (run, pack, ts_formed, n_cups, pad, crushed, is_test)
               VALUES (?, ?, ?, ?, ?, ?, ?)`),
      cupPack: p('UPDATE cup SET pack = ? WHERE run = ? AND cup = ?'),
      packOut: p('UPDATE pack SET ts_out = ?, film_peak = ?, sim_defect = ? WHERE run = ? AND pack = ?'),
      packReject: p('UPDATE pack SET ts_rejected = ?, reject_where = ?, film_peak = ?, sim_defect = ? WHERE run = ? AND pack = ?'),
      packPass: p('UPDATE pack SET ts_passed = ? WHERE run = ? AND pack = ?'),
      place: p('UPDATE pack SET pallet = ?, slot = ?, ts_placed = ? WHERE run = ? AND pack = ?'),
      drop: p('UPDATE pack SET dropped = 1 WHERE run = ? AND pack = ?'),
      palStart: p(`INSERT OR IGNORE INTO pallet (run, pallet, label, ts_start, status) VALUES (?, ?, ?, ?, 'istifte')`),
      palDone: p(`UPDATE pallet SET ts_done = ?, packs = ?, turns = ?, sheets = ?, sim_defect = ?, status = 'bitti'
                  WHERE run = ? AND pallet = ? AND status = 'istifte'`),
      check: p(`UPDATE pallet SET contour_ok = ?, read_ok = ? WHERE run = ? AND pallet = ?`),
      store: p(`UPDATE pallet SET loc = ?, ts_stored = ?, status = 'depoda' WHERE run = ? AND pallet = ?`),
      pick: p(`UPDATE pallet SET ts_picked = ?, status = 'sevkte' WHERE run = ? AND pallet = ?`),
      ship: p(`UPDATE pallet SET ts_shipped = ?, ship_order = ?, status = 'sevk edildi', loc = NULL WHERE run = ? AND pallet = ?`),
      reject: p(`UPDATE pallet SET status = 'reddedildi' WHERE run = ? AND pallet = ?`),
      order: p('INSERT OR IGNORE INTO shipment (run, ship_order, ts, n) VALUES (?, ?, ?, ?)'),
    };
  }

  get cursor() {
    return this.q.cursor.get(this.source) || { run: null, last_seq: 0 };
  }

  // Olay akışından gelen bir yanıtı işler: { run, first, last, events }
  // Simülatör yeniden başladıysa (run değişti) imleç sıfırlanır; arada olay kaybolduysa gap yazılır.
  apply(resp, now = Date.now()) {
    const { q } = this;
    return tx(this.db, () => {
      let { run, last_seq: after } = this.cursor;
      // Simülatör yeniden başladı: bu yanıt eski imleçle istendiği için baştaki olaylar eksik olabilir.
      // İmleci yeni run'ın başına al, hiçbir şey işleme; çağıran after=0 ile yeniden ister (-1).
      if (run && run !== resp.run) { q.setCursor.run(this.source, resp.run, 0); return -1; }
      if (!run) { run = resp.run; after = 0; }
      if (resp.first > after + 1) q.gap.run(this.source, run, after + 1, resp.first - 1, now);
      let n = 0;
      for (const ev of resp.events) {
        if (ev.seq <= after) continue;
        this.handle(run, ev);
        after = ev.seq;
        n++;
      }
      q.setCursor.run(this.source, run, after);
      return n;
    });
  }

  handle(run, e) {
    const { q } = this;
    switch (e.type) {
      case 'lot': q.lot.run(run, e.lot, e.ts, e.kg); break;
      case 'transfer_start': q.xferStart.run(run, e.transfer, e.lot, e.ts, e.initial ? 1 : 0); break;
      case 'transfer_end': q.xferEnd.run(e.ts, e.kg, run, e.transfer); break;
      case 'cup': {
        const tFill = e.tFill == null || e.t == null ? null : Math.round(e.ts - (e.t - e.tFill) * 1000);
        q.cup.run(run, e.cup, tFill, e.ts, e.netG ?? null, e.sealC ?? null, e.result, e.simDefect ?? null);
        for (const x of e.transfers || []) q.cupXfer.run(run, e.cup, x.id, x.frac);
        break;
      }
      case 'cup_lost': q.cupLost.run(e.where ?? null, run, e.cup); break;
      case 'pack':
        q.pack.run(run, e.pack, e.ts, e.cups.length, e.pad ? 1 : 0, e.crushed ? 1 : 0, e.test ? 1 : 0);
        for (const c of e.cups) q.cupPack.run(e.pack, run, c);
        break;
      case 'pack_out': q.packOut.run(e.ts, e.filmPeak ?? null, e.simDefect ?? null, run, e.pack); break;
      case 'pack_reject': q.packReject.run(e.ts, e.where, e.filmPeak ?? null, e.simDefect ?? null, run, e.pack); break;
      case 'pack_pass': q.packPass.run(e.ts, run, e.pack); break;
      case 'place': q.place.run(e.pallet, e.slot, e.ts, run, e.pack); break;
      case 'pack_drop': q.drop.run(run, e.pack); break;
      case 'pallet_start': q.palStart.run(run, e.pallet, palletLabel(run, e.pallet), e.ts); break;
      case 'pallet_done': q.palDone.run(e.ts, e.packs, e.turns, e.sheets, e.simDefect ?? null, run, e.pallet); break;
      case 'asrs_check': q.check.run(e.contourOk ? 1 : 0, e.readOk ? 1 : 0, run, e.pallet); break;
      case 'store': q.store.run(e.loc, e.ts, run, e.pallet); break;
      case 'pick': q.pick.run(e.ts, run, e.pallet); break;
      case 'ship': q.ship.run(e.ts, e.order || null, run, e.pallet); break;
      case 'reject_pallet': q.reject.run(run, e.pallet); break;
      case 'order': q.order.run(run, e.order, e.ts, e.n); break;
      default: break;   // bilinmeyen olay türü: yok say (ileri uyumluluk)
    }
  }
}
