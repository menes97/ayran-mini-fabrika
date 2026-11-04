// node scripts/openplc-restart.mjs [saniye]   (önce: sudo ROLE=paketleme SIM_PORT=5022 ./plc/openplc/run_ayran.sh)
// Gerçek OpenPLC yeniden başlama denemesi: paketleme PLC'si OpenPLC v3 (WSL, kalıcı bellek açık),
// proses ve lojistik JS PLC. Üretim sürerken OpenPLC servisi iki kez yeniden başlatılır
// (systemctl restart = program yeniden yüklenir, %MW persistent.file'dan gelir).
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const R = new URL('../', import.meta.url).href;
const SECS = Number(process.argv[2] || 520);
process.env.PORT = '8090'; process.env.MODBUS_PORT = '5022';
const { sim } = await import(R + 'server/index.js');
const { startPlc } = await import(R + 'plc/js-plc.js');
const { tagAddr, PAL_STATES, SHRINK_STATES } = await import(R + 'public/iomap.js');
await startPlc({ role: 'proses', port: 5022, poll: 100, slavePort: 0, quiet: true, commission: true });
await startPlc({ role: 'lojistik', port: 5022, poll: 100, slavePort: 0, quiet: true, commission: true });

const t0 = Date.now();
const el = () => (Date.now() - t0) / 1000;
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const press = async (name) => { sim.buttons[name] = true; await wait(0.6); sim.buttons[name] = false; };
const log = (...a) => console.log(`[${el().toFixed(0).padStart(4)} s]`, ...a);
const A = (t) => sim.hr[tagAddr(t)];
const real = () => { const p = sim.pallet.palletAt(1); return p ? p.slots.filter(Boolean).length : null; };
const snap = () => ({ lost: sim.kpi.lostCups, crash: sim.kpi.robotCrashes, palBad: sim.kpi.palletsBad,
  dropped: sim.kpi.packsDropped, stored: sim.kpi.palletsStored, packs: sim.kpi.packsGood,
  quarantined: sim.kpi.packsRejected, quarantinedCups: sim.kpi.cupsQuarantined,
  plcReject: A('SHR_QW_REJECT'), inside: A('SHR_QW_INSIDE'),
  plcCount: A('PAL_QW_COUNT'), realCount: real(), palState: PAL_STATES[A('PAL_QW_STATE')],
  shrState: SHRINK_STATES[A('SHR_QW_STATE')], palAlarm: A('PAL_QW_ALARM'), palStatus: A('PAL_QW_STATUS'),
  shrStatus: A('SHR_QW_STATUS'), live: sim.live });

while (!sim.plcConnected) { if (el() > 60) { log('bağlanmadı', sim.live); process.exit(1); } await wait(0.5); }
log('üç PLC canlı'); await wait(2.5);
await press('reset'); await wait(1.5); await press('start'); log('RESET + START');

const restarts = [];
let book = { ok: 0, bad: 0, maxDiff: 0 }, moveWhileWaiting = 0;
const timer = setInterval(() => {
  if (sim.dolum.cupMag < 5) sim.dolum.cupMag = 60;
  if (sim.dolum.foilMag < 5) sim.dolum.foilMag = 80;
  if (el() > 30 && el() < SECS - 60 && (!sim._lf || el() - sim._lf > 8)) { if (sim.shrink.injectTestPack()) sim._lf = el(); }
  if (sim.plcLive('paketleme') && !sim.pallet.rob.job && real() != null && !(A('PAL_QW_STATUS') & 0x80)) {
    if (real() === A('PAL_QW_COUNT')) book.ok++; else { book.bad++; book.maxDiff = Math.max(book.maxDiff, Math.abs(real() - A('PAL_QW_COUNT'))); }
  }
  // START beklerken paketleme çıkışları kapalı olmalı (robot HOLD/ENABLE hariç, ayrı kontrol edilmez)
  if ((A('SHR_QW_STATUS') & 0x80) && A('SHR_QW_DO') !== 0) moveWhileWaiting++;
}, 250);

async function restart(tag) {
  const before = snap();
  log(`${tag}: OpenPLC yeniden başlatılıyor`, JSON.stringify(before));
  execSync('wsl -d Ubuntu-24.04 -u root -- systemctl restart openplc');
  const tr = el();
  while (!sim.plcLive('paketleme')) { if (el() - tr > 60) { log('OpenPLC geri gelmedi'); break; } await wait(0.25); }
  log(`${tag}: OpenPLC canlı (${(el() - tr).toFixed(1)} s)`);
  await wait(4);
  const after = snap();
  log(`${tag}: START öncesi`, JSON.stringify(after));
  await wait(2); await press('start'); log(`${tag}: START`);
  restarts.push({ tag, before, after, waitBit: !!(after.palStatus & 0x80) && !!(after.shrStatus & 0x80) });
}

await wait(150 - el()); await restart('1. yeniden başlama');
await wait(290 - el()); await restart('2. yeniden başlama');
const status = setInterval(() => log(JSON.stringify(snap())), 30000);
await wait(SECS - el());
clearInterval(timer); clearInterval(status);
const res = { secs: SECS, restarts, book, moveWhileWaiting, final: snap() };
fs.mkdirSync(new URL('../monitor/data/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../monitor/data/restart-result.json', import.meta.url), JSON.stringify(res, null, 2));
log('SONUÇ', JSON.stringify(res.final), JSON.stringify(book), 'START beklerken hareket', moveWhileWaiting);
process.exit(0);
