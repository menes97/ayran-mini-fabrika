// İzlenebilirlik sorguları: palet → paket → bardak → aktarım → parti → CIP, ters yönde geri çağırma,
// uzlaştırma ve FIFO (konumsal) çıkarım.

// Palet etiketinden (ya da run + numaradan) geriye: slotlar, paketler, bardaklar, aktarımlar, CIP'ler
export function palletTrace(db, label) {
  const pal = db.prepare('SELECT * FROM pallet WHERE label = ?').get(label);
  if (!pal) return null;
  const packs = db.prepare(`SELECT * FROM pack WHERE run = ? AND pallet = ? AND dropped = 0 ORDER BY slot`)
    .all(pal.run, pal.pallet);
  const cups = db.prepare(`SELECT c.cup, c.pack, c.net_g, c.seal_c, c.ts_fill, c.ts_done, c.result, c.sim_defect
    FROM cup c JOIN pack k ON k.run = c.run AND k.pack = c.pack
    WHERE k.run = ? AND k.pallet = ? AND k.dropped = 0 ORDER BY c.cup`).all(pal.run, pal.pallet);
  const xfers = db.prepare(`SELECT ct.cup, ct.transfer, ct.frac, t.lot, t.initial, t.ts_start, t.last_cip, t.last_ok_cip
    FROM cup_transfer ct JOIN transfer_cip t ON t.run = ct.run AND t.transfer = ct.transfer
    JOIN cup c ON c.run = ct.run AND c.cup = ct.cup JOIN pack k ON k.run = c.run AND k.pack = c.pack
    WHERE k.run = ? AND k.pallet = ? AND k.dropped = 0`).all(pal.run, pal.pallet);
  const byCup = new Map();
  for (const x of xfers) { if (!byCup.has(x.cup)) byCup.set(x.cup, []); byCup.get(x.cup).push(x); }
  const cipIds = [...new Set(xfers.map((x) => x.last_cip).filter((v) => v != null))];
  const cips = cipIds.length ? db.prepare(`SELECT * FROM cip WHERE cip_id IN (${cipIds.map(() => '?').join(',')})`).all(...cipIds) : [];
  const nets = cups.map((c) => c.net_g).filter((v) => v != null);
  return {
    pallet: pal,
    packs: packs.map((k) => ({ ...k, cups: cups.filter((c) => c.pack === k.pack)
      .map((c) => ({ ...c, transfers: byCup.get(c.cup) || [] })) })),
    lots: [...new Set(xfers.map((x) => x.lot))].sort((a, b) => a - b),
    transfers: [...new Set(xfers.map((x) => x.transfer))].sort((a, b) => a - b),
    cips,
    initialStock: xfers.some((x) => x.initial),
    fill: nets.length ? { n: nets.length, min: Math.min(...nets), max: Math.max(...nets),
      avg: nets.reduce((a, b) => a + b, 0) / nets.length } : null,
  };
}

// "Bu palette hangi CIP'ten sonraki ürün var?"
export function palletCips(db, label) {
  return db.prepare(`SELECT DISTINCT t.last_cip AS cip_id, x.result, x.ts_end, t.initial
    FROM pallet p JOIN pack k ON k.run = p.run AND k.pallet = p.pallet AND k.dropped = 0
    JOIN cup c ON c.run = k.run AND c.pack = k.pack
    JOIN cup_transfer ct ON ct.run = c.run AND ct.cup = c.cup
    JOIN transfer_cip t ON t.run = ct.run AND t.transfer = ct.transfer
    LEFT JOIN cip x ON x.cip_id = t.last_cip
    WHERE p.label = ? ORDER BY x.ts_end`).all(label);
}

// İleri yön (geri çağırma): bir CIP döneminin (o CIP'ten sonra, bir sonrakinden önce başlayan
// aktarımlar) ya da bir partinin ürününü içeren paletler ve şu anki yerleri
export function recall(db, { cipId, lot, run } = {}) {
  const where = cipId != null ? 't.last_cip = ?' : 't.lot = ? AND t.run = ?';
  const args = cipId != null ? [cipId] : [lot, run];
  return db.prepare(`SELECT p.label, p.run, p.pallet, p.status, p.loc, p.ship_order, p.ts_shipped,
      COUNT(DISTINCT c.cup) AS cups
    FROM transfer_cip t
    JOIN cup_transfer ct ON ct.run = t.run AND ct.transfer = t.transfer AND ct.frac >= 0.005
    JOIN cup c ON c.run = ct.run AND c.cup = ct.cup AND c.result = 'out'
    JOIN pack k ON k.run = c.run AND k.pack = c.pack AND k.dropped = 0
    JOIN pallet p ON p.run = k.run AND p.pallet = k.pallet
    WHERE ${where}
    GROUP BY p.run, p.pallet ORDER BY p.pallet`).all(...args);
}

// Uzlaştırma: PLC sayaçları ile hat takip olayları aynı sayım noktasından karşılaştırılır.
// Dolum: PLC GOOD sayacı red istasyonundan geçen sağlam bardak = 'out' + sonradan kaybolan ('lost').
export function reconcile(db, t0, t1) {
  const plc = (cell) => db.prepare(`SELECT COALESCE(SUM(good), 0) AS g, COALESCE(SUM(reject), 0) AS r
    FROM production WHERE cell = ? AND ts > ? AND ts <= ?`).get(cell, t0, t1);
  const ev = (sql) => db.prepare(sql).get(t0, t1).n;
  const d = plc('dolum');
  const rows = [
    { what: 'Dolum: sağlam bardak', plc: d.g,
      // sonradan ezilen ya da gruplamada düşen bardak da PLC'ye göre sağlamdır
      trace: ev(`SELECT COUNT(*) AS n FROM cup WHERE result IN ('out', 'lost') AND ts_done > ? AND ts_done <= ?`) },
    { what: 'Dolum: red', plc: d.r, trace: ev(`SELECT COUNT(*) AS n FROM cup WHERE result = 'reject' AND ts_done > ? AND ts_done <= ?`) },
    { what: 'Shrink: iyi ürün bandına geçen paket', plc: plc('shrink').g,
      trace: ev(`SELECT COUNT(*) AS n FROM pack WHERE ts_passed > ? AND ts_passed <= ?`) },
    { what: 'Shrink: karantina red', plc: plc('shrink').r,
      trace: ev(`SELECT COUNT(*) AS n FROM pack WHERE ts_rejected > ? AND ts_rejected <= ?`) },
    { what: 'Paletleme: palete konan paket', plc: plc('palet').g,
      trace: ev(`SELECT COUNT(*) AS n FROM pack WHERE ts_placed > ? AND ts_placed <= ?`) },
    { what: 'Depo: depolanan palet', plc: plc('asrs').g,
      trace: ev(`SELECT COUNT(*) AS n FROM pallet WHERE ts_stored > ? AND ts_stored <= ?`) },
  ];
  return rows.map((r) => ({ ...r, diff: r.trace == null ? null : r.trace - r.plc }));
}

// FIFO (konumsal) çıkarım: kimlik okunmadan, paketin bardaklarını sıradan tahmin et.
// Çıkış bandına giden bardaklar sırayla gruplanır; her paket sıradaki n bardağı alır.
// Gruplamada düşen bardağın hangisi olduğu bilinmez: çıkarım oradan sonra kayar.
export function inferPackCups(db, run) {
  const cups = db.prepare(`SELECT cup, pack FROM cup WHERE run = ? AND (result = 'out' OR lost_where IS NOT NULL)
    ORDER BY ts_done, cup`).all(run);
  const packs = db.prepare(`SELECT pack, n_cups FROM pack WHERE run = ? AND is_test = 0 ORDER BY ts_formed, pack`).all(run);
  let i = 0, ok = 0, n = 0;
  const out = [];
  for (const p of packs) {
    const inferred = cups.slice(i, i + p.n_cups).map((c) => c.cup);
    i += p.n_cups;
    const actual = cups.filter((c) => c.pack === p.pack).map((c) => c.cup);
    const match = inferred.length === actual.length && inferred.every((c, k) => c === actual[k]);
    out.push({ pack: p.pack, inferred, actual, match });
    n++; if (match) ok++;
  }
  return { packs: out, n, ok, rate: n ? ok / n : null };
}
