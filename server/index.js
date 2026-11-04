// Simülatör sunucusu: fabrika modeli + Modbus TCP slave + 3D arayüz için HTTP/WebSocket.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import Modbus from 'modbus-serial';
import { Factory } from './factory.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTTP_PORT = Number(process.env.PORT || 8080);
const MODBUS_PORT = Number(process.env.MODBUS_PORT || 5020);
const SIM_DT = 0.005;

export const sim = new Factory({ wallBase: Date.now() });

// ---- Simülasyon döngüsü (gerçek zaman) ------------------------------
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  let elapsed = Math.min(0.1, (now - last) / 1000);
  last = now;
  while (elapsed > 1e-6) {
    const dt = Math.min(SIM_DT, elapsed);
    sim.step(dt);
    elapsed -= dt;
  }
}, 5);

// ---- Modbus TCP slave -----------------------------------------------
function guard(fn) {
  return (...args) => {
    if (sim.faults.commLoss) throw new Error('simulated cable cut');
    sim.touchPlc();
    return fn(...args);
  };
}

// Yalnızca register'lar kullanılır (FC3, FC4, FC6, FC16); bitler register'lara paketlidir.
const vector = {
  getInputRegister: guard((addr) => sim.ir[addr] ?? 0),
  getHoldingRegister: guard((addr) => sim.hr[addr] ?? 0),
  setRegister: guard((addr, value) => { if (addr < sim.hr.length) sim.hr[addr] = value & 0xffff; }),
};

const modbus = new Modbus.ServerTCP(vector, { host: '0.0.0.0', port: MODBUS_PORT, unitID: 255 });
modbus.on('socketError', (err) => console.error('[modbus] soket hatası:', err.message));
modbus.on('serverError', (err) => console.error('[modbus] sunucu hatası:', err.message));

// ---- HTTP: statik dosyalar ------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.wasm': 'application/wasm',
};
const MOUNTS = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/')],
  ['/', path.join(ROOT, 'public/')],
];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const url = decodeURIComponent(u.pathname);
  // hat takip olay akışı (izleme servisi çeker): ?after=<seq>&max=<n>
  if (url === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ monitorPort: Number(process.env.MON_PORT || 8081) }));
    return;
  }
  if (url === '/api/events') {
    const after = Number(u.searchParams.get('after') || 0);
    const max = Math.min(5000, Number(u.searchParams.get('max') || 2000));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...sim.trace.since(after, max), t: sim.t, ts: Date.now() }));
    return;
  }
  for (const [prefix, dir] of MOUNTS) {
    if (!url.startsWith(prefix)) continue;
    let file = path.join(dir, url.slice(prefix.length) || 'index.html');
    if (!file.startsWith(dir)) break;
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) break;
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',   // geliştirme sırasında eski modüller önbellekten gelmesin
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404).end('not found');
});

// ---- WebSocket: arayüze durum yayını, arayüzden komutlar -------------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try { sim.command(JSON.parse(data)); } catch { /* bozuk mesajı yok say */ }
  });
});
setInterval(() => {
  if (wss.clients.size === 0) return;
  const msg = JSON.stringify(sim.snapshot());
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}, 33);

server.listen(HTTP_PORT, () => {
  console.log(`[sim] 3D arayüz:   http://localhost:${HTTP_PORT}`);
  console.log(`[sim] Modbus TCP:  0.0.0.0:${MODBUS_PORT} (her Slave ID kabul edilir)`);
});
