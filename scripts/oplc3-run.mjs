// Üç PLC'nin üçü de gerçek OpenPLC v3: tam hat denemesi.
//   1) WSL'de:  sudo ./plc/openplc/oplc3.sh setup && sudo SIM_PORT=5022 ./plc/openplc/oplc3.sh load && sudo ./plc/openplc/oplc3.sh start
//   2) Windows: node scripts/oplc3-run.mjs [saniye]
// Simülatör 8090 (3B) / 5022 (Modbus), izleme paneli 8094. İzleme üç OpenPLC'yi kendi Modbus
// slave'lerinden okur (WSL :5501 proses, :5502 paketleme, :5503 lojistik).
// Senaryo: RESET + START, tank yeni CIP ister → CIP; üretim + alma noktasına test paketi;
// 200 s paketleme, 360 s proses, 470 s lojistik OpenPLC'si yeniden başlatılır (START 45 s sonra,
// proseste CIP yeniden); sonra 1 paletlik sevkiyat. Sonuç: monitor/data/oplc3-result.json
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const R = new URL('../', import.meta.url).href;
const SECS = Number(process.argv[2] || 660);
const WSL = process.env.WSL_IP || execSync('wsl -d Ubuntu-24.04 -- hostname -I').toString().trim().split(/\s+/)[0];
process.env.PORT = '8090'; process.env.MODBUS_PORT = '5022';
const { sim } = await import(R + 'server/index.js');
const { startMonitor } = await import(R + 'monitor/server.js');
const { tagAddr, PAL_STATES, SHRINK_STATES, TANK_STATES } = await import(R + 'public/iomap.js');
const dataDir = new URL('../monitor/data/', import.meta.url);
// plc/openplc klasörünün WSL yolu (C:\x\y -> /mnt/c/x/y)
const OPLC_DIR = new URL('../plc/openplc', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, (_, d) => '/mnt/' + d.toLowerCase()).split('/').map(decodeURIComponent).join('/');
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = fileURLToPath(new URL('oplc3.db', dataDir));
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) try { fs.unlinkSync(f); } catch { /* */ }
const { mon } = await startMonitor({ MON_MODE: 'bolunmus', MON_PORT: 8094, SIM_URL: 'http://127.0.0.1:8090', MON_DB: dbFile,
  MON_PLCS: `proses=${WSL}:5501,paketleme=${WSL}:5502,lojistik=${WSL}:5503`, quiet: true });

const t0 = Date.now();
const el = () => (Date.now() - t0) / 1000;
const wait = (s) => new Promise((r) => setTimeout(r, Math.max(0, s) * 1000));
const press = async (obj, name) => { obj[name] = true; await wait(0.6); obj[name] = false; };
const log = (...a) => console.log(`[${el().toFixed(0).padStart(4)} s]`, ...a);
const A = (t) => sim.hr[tagAddr(t)];
const snap = () => ({ lost: sim.kpi.lostCups, crash: sim.kpi.robotCrashes, palGood: sim.kpi.palletsGood, palBad: sim.kpi.palletsBad,
  stored: sim.kpi.palletsStored, shipped: sim.kpi.palletsShipped, packs: sim.kpi.packsGood, quarantined: sim.kpi.packsRejected,
  cupsOut: sim.kpi.shippedGood, agvMoves: sim.kpi.agvMoves, plcCount: A('PAL_QW_COUNT'),
  tank: TANK_STATES[A('TNK_QW_STATE')], shr: SHRINK_STATES[A('SHR_QW_STATE')], pal: PAL_STATES[A('PAL_QW_STATE')], live: sim.live });

while (!sim.plcConnected) { if (el() > 90) { log('PLC\'ler bağlanmadı', sim.live); process.exit(1); } await wait(0.5); }
log(`üç OpenPLC canlı (WSL ${WSL})`); await wait(3);
await press(sim.buttons, 'reset'); await wait(1.5); await press(sim.buttons, 'start'); log('RESET + START');
await wait(3); await press(sim.tank.buttons, 'cipStart'); log('CIP başlat (temiz açılış: tank yeni CIP ister)');

const timer = setInterval(() => {
  if (sim.dolum.cupMag < 5) sim.dolum.cupMag = 60;
  if (sim.dolum.foilMag < 5) sim.dolum.foilMag = 80;
  if (el() > 40 && el() < SECS - 150 && (!sim._lf || el() - sim._lf > 8)) { if (sim.shrink.injectTestPack()) sim._lf = el(); }
}, 250);
const status = setInterval(() => log(JSON.stringify(snap())), 30000);

const restarts = [];
async function restart(role, at, { cip = false } = {}) {
  await wait(at - el());
  const before = snap();
  log(`YENİDEN BAŞLAT ${role}`, JSON.stringify(before));
  execSync(`wsl -d Ubuntu-24.04 -u root -- bash -c "cd '${OPLC_DIR}' && bash oplc3.sh restart ${role}"`);
  await wait(8);
  const waiting = snap();
  log(`START BEKLİYOR ${role} (45 s)`, JSON.stringify(waiting));
  await wait(37);
  await press(sim.buttons, 'start'); log(`START ${role}`);
  if (cip) { await wait(3); await press(sim.tank.buttons, 'cipStart'); log('CIP başlat (proses açılışı)'); }
  restarts.push({ role, before, waiting, after: snap() });
}
// OPLC3_PLAN="rol@saniye[:cip],..." ile değiştirilebilir
const PLAN = (process.env.OPLC3_PLAN || 'paketleme@200,proses@360:cip,lojistik@470').split(',').map((p) => {
  const [role, rest] = p.split('@'); const [at, opt] = rest.split(':'); return { role, at: Number(at), cip: opt === 'cip' };
});
for (const p of PLAN) await restart(p.role, p.at, { cip: p.cip });
await wait(Math.min(540, SECS - 120) - el());
if (sim.asrs.rack.filter(Boolean).length) { sim.command({ type: 'shipOrder', value: 1 }); log('sevkiyat siparişi: 1 palet'); }
await wait(SECS - el());
clearInterval(timer); clearInterval(status);
await wait(1.5);
const now = Date.now();
const res = { secs: SECS, wsl: WSL, restarts, final: snap(), gaps: mon.gaps(), reconcile: mon.reconcile(t0, now),
  oee: mon.oee(t0, now).map((o) => ({ cell: o.cell, A: o.A, P: o.P, Q: o.Q, OEE: o.OEE ?? o.utilization, total: o.total })),
  cips: mon.cips(10), alarms: mon.alarmHistory(t0, now, 50).map((a) => `${a.cell}: ${a.text}`) };
fs.writeFileSync(new URL('oplc3-result.json', dataDir), JSON.stringify(res, null, 2));
log('SONUÇ', JSON.stringify(res.final));
log('uzlaştırma', JSON.stringify(res.reconcile.map((r) => `${r.what}: plc ${r.plc} / iz ${r.trace}`)));
log('haberleşme boşlukları', JSON.stringify(res.gaps.comm?.length ?? res.gaps));
process.exit(0);
