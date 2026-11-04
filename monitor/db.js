// İzleme veritabanı: şema ve bağlantı (Node 22.13+ yerleşik node:sqlite, ek bağımlılık yok).
// Zamanlar ms (duvar saati; testlerde simülasyon saati × 1000).
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS ingest (source TEXT PRIMARY KEY, run TEXT, last_seq INTEGER);
CREATE TABLE IF NOT EXISTS ingest_gap (id INTEGER PRIMARY KEY, source TEXT, run TEXT, from_seq INTEGER, to_seq INTEGER, ts INTEGER);

-- ---------- izlenebilirlik (simülatörün hat takip olaylarından) ----------
CREATE TABLE IF NOT EXISTS lot (run TEXT, lot INTEGER, ts INTEGER, kg REAL, PRIMARY KEY (run, lot));
CREATE TABLE IF NOT EXISTS transfer (run TEXT, transfer INTEGER, lot INTEGER, ts_start INTEGER, ts_end INTEGER, kg REAL,
  initial INTEGER DEFAULT 0, PRIMARY KEY (run, transfer));
CREATE TABLE IF NOT EXISTS cup (run TEXT, cup INTEGER, ts_fill INTEGER, ts_done INTEGER, net_g REAL, seal_c REAL,
  result TEXT CHECK (result IN ('out', 'reject', 'lost')), lost_where TEXT, pack INTEGER, sim_defect TEXT,
  PRIMARY KEY (run, cup));
CREATE INDEX IF NOT EXISTS cup_pack ON cup (run, pack);
CREATE TABLE IF NOT EXISTS cup_transfer (run TEXT, cup INTEGER, transfer INTEGER, frac REAL, PRIMARY KEY (run, cup, transfer));
CREATE INDEX IF NOT EXISTS ct_transfer ON cup_transfer (run, transfer);
CREATE TABLE IF NOT EXISTS pack (run TEXT, pack INTEGER, ts_formed INTEGER, ts_out INTEGER, n_cups INTEGER, pad INTEGER,
  crushed INTEGER DEFAULT 0, pallet INTEGER, slot INTEGER, ts_placed INTEGER, dropped INTEGER DEFAULT 0,
  is_test INTEGER DEFAULT 0, film_peak REAL, sim_defect TEXT, ts_rejected INTEGER, reject_where TEXT,
  ts_passed INTEGER, PRIMARY KEY (run, pack));
CREATE INDEX IF NOT EXISTS pack_pallet ON pack (run, pallet);
CREATE TABLE IF NOT EXISTS pallet (run TEXT, pallet INTEGER, label TEXT UNIQUE, ts_start INTEGER, ts_done INTEGER,
  packs INTEGER, turns REAL, sheets INTEGER, status TEXT, contour_ok INTEGER, read_ok INTEGER, loc INTEGER,
  ts_stored INTEGER, ts_picked INTEGER, ts_shipped INTEGER, ship_order INTEGER, sim_defect TEXT,
  PRIMARY KEY (run, pallet));
CREATE TABLE IF NOT EXISTS shipment (run TEXT, ship_order INTEGER, ts INTEGER, n INTEGER, PRIMARY KEY (run, ship_order));

-- ---------- PLC tarafı (yoklamadan) ----------
-- ts_end: CIP'in en son görüldüğü an (aktarım CIP sırasında başlayamaz, bu yüzden ürün bağlamak için güvenli);
-- end_uncertain = 1: bitiş bir veri boşluğuna denk geldi, gerçek bitiş ts_end ile ilk görülen CIP dışı an arasında
CREATE TABLE IF NOT EXISTS cip (cip_id INTEGER PRIMARY KEY, plc TEXT, ts_start INTEGER, ts_end INTEGER, result INTEGER,
  min_temp REAL, min_flow REAL, final_cond REAL, duration_s INTEGER, end_uncertain INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS state_interval (id INTEGER PRIMARY KEY, plc TEXT, cell TEXT, state INTEGER, category TEXT,
  ts_start INTEGER, ts_end INTEGER);
CREATE INDEX IF NOT EXISTS si_cell ON state_interval (cell, ts_start);
CREATE TABLE IF NOT EXISTS alarm_event (id INTEGER PRIMARY KEY, cell TEXT, bit INTEGER, text TEXT, severity TEXT,
  ts_on INTEGER, ts_off INTEGER);
CREATE INDEX IF NOT EXISTS ae_on ON alarm_event (ts_on);
-- gap = 1: fark bir veri boşluğunu (PLC'ye ulaşılamadı / izleme kapalıydı) kapsıyor; uzlaştırmaya girer,
-- OEE'ye girmez (o sürenin çalışma zamanı bilinmiyor)
CREATE TABLE IF NOT EXISTS production (id INTEGER PRIMARY KEY, cell TEXT, ts INTEGER, good INTEGER, reject INTEGER,
  gap INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS prod_cell ON production (cell, ts);
CREATE TABLE IF NOT EXISTS micro_stop (id INTEGER PRIMARY KEY, cell TEXT, ts_start INTEGER, dur_ms INTEGER);
CREATE INDEX IF NOT EXISTS ms_cell ON micro_stop (cell, ts_start);
CREATE TABLE IF NOT EXISTS comm_gap (id INTEGER PRIMARY KEY, plc TEXT, ts_start INTEGER, ts_end INTEGER);
CREATE TABLE IF NOT EXISTS counter_reset (id INTEGER PRIMARY KEY, cell TEXT, counter TEXT, ts INTEGER, old INTEGER, new INTEGER);

-- Aktarımın CIP'i ilişki olarak saklanmaz, sorguda hesaplanır: aktarım başlamadan önce biten son CIP.
-- (Olay akışı ile PLC yoklaması ayrı geldiği için yazılırken CIP kaydı henüz gelmemiş olabilir.)
-- Başlangıç stoku (initial = 1) hiçbir CIP'e bağlanmaz: hangi temizlikten sonra üretildiği bilinmiyor.
DROP VIEW IF EXISTS transfer_cip;
CREATE VIEW transfer_cip AS
SELECT t.run, t.transfer, t.lot, t.ts_start, t.ts_end, t.kg, t.initial,
  CASE WHEN t.initial = 1 THEN NULL ELSE
    (SELECT c.cip_id FROM cip c WHERE c.ts_end <= t.ts_start ORDER BY c.ts_end DESC LIMIT 1) END AS last_cip,
  CASE WHEN t.initial = 1 THEN NULL ELSE
    (SELECT c.cip_id FROM cip c WHERE c.ts_end <= t.ts_start AND c.result = 1 ORDER BY c.ts_end DESC LIMIT 1) END AS last_ok_cip
FROM transfer t;
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  // eski veritabanları için sütun göçü
  for (const sql of ['ALTER TABLE production ADD COLUMN gap INTEGER DEFAULT 0',
    'ALTER TABLE cip ADD COLUMN end_uncertain INTEGER DEFAULT 0',
    'ALTER TABLE pack ADD COLUMN ts_rejected INTEGER',
    'ALTER TABLE pack ADD COLUMN ts_passed INTEGER',
    'ALTER TABLE pack ADD COLUMN reject_where TEXT']) { try { db.exec(sql); } catch { /* zaten var */ } }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));
  return db;
}

// tek işlemde çalıştır (olay grubu ya da yoklama örneği yarım kalmasın)
export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const palletLabel = (run, pallet) => `AY-${String(run).toUpperCase()}-${String(pallet).padStart(5, '0')}`;
