// İzleme servisi (SCADA/MES katmanı): PLC'leri Modbus TCP ile yoklar, simülatörün hat takip olay
// akışını çeker, SQLite'a yazar, gösterge panelini ve JSON API'yi sunar.
//
//   node monitor/server.js        (npm run monitor)
//   MON_PORT=8081                 panel ve API
//   MON_MODE=tek|bolunmus         tek PLC ya da üç PLC
//   MON_PLCS=tek=127.0.0.1:5030   PLC slave adresleri (bölünmüşte proses=..:5031,paketleme=..:5032,lojistik=..:5033;
//                                 OpenPLC v3'ün kendi slave'i 502)
//   MON_SOURCE=plc|sim            sim: PLC'ler yerine simülatörün Modbus portundan oku (yalnızca hata ayıklama)
//   SIM_URL=http://127.0.0.1:8080 olay akışı;  SIM_MODBUS=127.0.0.1:5020 (MON_SOURCE=sim için)
//   MON_DB=monitor/data/izleme.db ; SHIFT_MIN=0 (demo için kısa vardiya, dakika)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Modbus from 'modbus-serial';
import { Monitor } from './monitor.js';
import { PLCS, SINGLE_PLC, PLC_SLAVE_BASE, N_BLOCKS, BLOCK, MON_CELLS, OEE_CATEGORIES, PLCS as PLC_LIST } from '../public/iomap.js';
import * as MAP from '../public/iomap.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const N_REGS = N_BLOCKS * BLOCK;

export async function startMonitor(opts = {}) {
  const env = (k, d) => opts[k] ?? process.env[k] ?? d;
  const PORT = Number(env('MON_PORT', 8081));
  const MODE = env('MON_MODE', 'tek');
  const SOURCE = env('MON_SOURCE', 'plc');
  const SIM_URL = env('SIM_URL', 'http://127.0.0.1:8080');
  const DB = env('MON_DB', path.join(ROOT, 'data', 'izleme.db'));
  const POLL_MS = Number(env('MON_POLL', 250));
  const plcs = MODE === 'tek' ? [SINGLE_PLC] : PLCS;
  const defAddr = (p) => `127.0.0.1:${p.port}`;
  const given = Object.fromEntries(String(env('MON_PLCS', '')).split(',').filter(Boolean).map((s) => s.split('=')));
  const endpoints = plcs.map((p) => {
    const [host, port] = (SOURCE === 'sim' ? env('SIM_MODBUS', '127.0.0.1:5020') : given[p.id] || defAddr(p)).split(':');
    return { ...p, host, port: Number(port), client: null, busy: false, ok: false, lastOk: 0, err: '' };
  });
  if (DB !== ':memory:') fs.mkdirSync(path.dirname(DB), { recursive: true });
  const mon = new Monitor({ file: DB, mode: MODE, shiftMin: Number(env('SHIFT_MIN', 0)), clock: Date.now });
  const log = (...a) => { if (!opts.quiet) console.log('[izleme]', ...a); };

  // ---- PLC yoklaması: her PLC'nin %QW görüntüsü (holding register 100..) ------------------
  async function readPlc(ep) {
    if (!ep.client || !ep.client.isOpen) {
      ep.client = new Modbus();
      ep.client.setTimeout(400);
      await ep.client.connectTCP(ep.host, { port: ep.port });
      ep.client.setID(1);
    }
    const [w0, wn] = ep.write;
    const img = new Array(N_REGS).fill(0);
    if (SOURCE === 'sim') {
      const res = await ep.client.readHoldingRegisters(w0, wn);
      res.data.forEach((v, i) => { img[w0 + i] = v; });
    } else {
      const res = await ep.client.readHoldingRegisters(PLC_SLAVE_BASE, wn);   // %QW100.. = yazma aralığı
      res.data.forEach((v, i) => { img[w0 + i] = v; });
    }
    return img;
  }

  let sampling = false;
  setInterval(async () => {
    if (sampling) return;
    sampling = true;
    const images = {};
    await Promise.all(endpoints.map(async (ep) => {
      try {
        images[ep.id] = await readPlc(ep);
        if (!ep.ok) log(`${ep.name} (${ep.host}:${ep.port}) okunuyor`);
        ep.ok = true; ep.lastOk = Date.now(); ep.err = '';
      } catch (e) {
        images[ep.id] = null;
        if (ep.ok || !ep.err) log(`${ep.name} (${ep.host}:${ep.port}) okunamıyor: ${e.message}`);
        ep.ok = false; ep.err = e.message;
        try { ep.client?.close(() => {}); } catch { /* */ }
        ep.client = null;
      }
    }));
    try { mon.sample(Date.now(), images); } catch (e) { log('örnek yazılamadı:', e.message); }
    sampling = false;
  }, POLL_MS);

  // ---- olay akışı ----------------------------------------------------------------------
  const events = { ok: false, err: '', lastOk: 0 };
  async function pullEvents() {
    try {
      for (let i = 0; i < 20; i++) {
        const after = mon.ingest.cursor.last_seq;
        const r = await fetch(`${SIM_URL}/api/events?after=${after}&max=2000`, { signal: AbortSignal.timeout(2000) });
        const resp = await r.json();
        if (resp.run !== mon.ingest.cursor.run && mon.ingest.cursor.run) log(`simülatör yeniden başladı (run ${resp.run})`);
        mon.events(resp, Date.now());
        if (!events.ok) log(`olay akışı: ${SIM_URL}`);
        events.ok = true; events.lastOk = Date.now(); events.err = '';
        if (mon.ingest.cursor.last_seq >= resp.last) break;
      }
    } catch (e) {
      if (events.ok || !events.err) log(`olay akışı okunamıyor: ${e.message}`);
      events.ok = false; events.err = e.message;
    }
    setTimeout(pullEvents, 1000);
  }
  pullEvents();

  // ---- HTTP API ------------------------------------------------------------------------
  const num = (v, d) => (v == null || v === '' ? d : Number(v));
  const status = () => ({
    mode: MODE, source: SOURCE, now: Date.now(),
    plcs: endpoints.map((e) => ({ id: e.id, name: e.name, addr: `${e.host}:${e.port}`, ok: e.ok, lastOk: e.lastOk, err: e.err })),
    events: { ...events, url: SIM_URL, cursor: mon.ingest.cursor },
  });
  const routes = {
    '/api/meta': () => ({ cells: MON_CELLS, categories: OEE_CATEGORIES, plcs: PLC_LIST,
      states: Object.fromEntries(MON_CELLS.map((c) => [c.id, MAP[c.statesKey]])) }),
    '/api/status': status,
    '/api/overview': (q) => {
      const now = Date.now(), shift = mon.shift(now), win = num(q.window, 3600) * 1000;
      return {
        status: status(), shift,
        oeeShift: mon.oee(shift.t0, shift.t1), oeeWindow: mon.oee(now - win, now),
        current: mon.current(), active: mon.activeAlarms(),
        counters: mon.counters(shift.t0, shift.t1), lineYield: mon.lineYield(shift.t0, shift.t1),
        reconcile: mon.reconcile(shift.t0, now), gaps: mon.gaps(),
      };
    },
    '/api/timeline': (q) => { const now = Date.now(); return mon.timeline(num(q.from, now - 3600e3), num(q.to, now)); },
    '/api/alarms': (q) => {
      const now = Date.now(), t0 = num(q.from, now - 8 * 3600e3), t1 = num(q.to, now);
      return { history: mon.alarmHistory(t0, t1, 300), pareto: mon.pareto(t0, t1, { severity: q.all ? null : 'alarm' }),
        active: mon.activeAlarms() };
    },
    '/api/stops': (q) => {
      const now = Date.now(), t0 = num(q.from, now - 3600e3), t1 = num(q.to, now);
      return { oee: mon.oee(t0, t1), longest: mon.longestStops(t0, t1, 10),
        micro: mon.db.prepare(`SELECT cell, COUNT(*) AS n, SUM(MIN(ts_start + dur_ms, ?) - MAX(ts_start, ?)) AS ms FROM micro_stop
          WHERE ts_start < ? AND ts_start + dur_ms > ? GROUP BY cell`).all(t1, t0, t1, t0) };
    },
    '/api/pallets': (q) => mon.pallets(num(q.limit, 60)),
    '/api/trace': (q) => ({ trace: mon.trace(q.label), cips: mon.palletCips(q.label) }),
    '/api/recall': (q) => (q.cip ? mon.recall({ cipId: Number(q.cip) }) : mon.recall({ lot: Number(q.lot), run: q.run })),
    '/api/cips': () => mon.cips(50),
    '/api/lots': () => mon.lots(),
    '/api/report': (q) => {
      const now = Date.now();
      const s = q.from ? { t0: Number(q.from), t1: Number(q.to), name: 'Seçilen aralık' } : mon.shift(num(q.at, now));
      return { shift: s, ...mon.report(s.t0, s.t1), status: status() };
    },
  };
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const fn = routes[u.pathname];
    if (fn) {
      try {
        const body = JSON.stringify(fn(Object.fromEntries(u.searchParams)), (k, v) => (typeof v === 'bigint' ? Number(v) : v));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // iomap.js panelde de kullanılır (tek kaynak)
    const file = u.pathname === '/iomap.js' ? path.join(ROOT, '../public/iomap.js')
      : path.join(ROOT, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname));
    if (!file.startsWith(path.join(ROOT, 'public')) && !file.endsWith('iomap.js')) return res.writeHead(403).end();
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(PORT, r));
  log(`panel: http://localhost:${PORT}  (${MODE === 'tek' ? 'tek PLC' : 'üç PLC'}, kaynak ${SOURCE}, DB ${DB})`);
  return { mon, server };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await startMonitor();
