// JS PLC ile aynı senaryo: 150 s üretim + test paketleri, sonra kalıcı bellekli yeniden başlama, START.
// Robot işi sürüyor mu? (OpenPLC denemesinde palet 15'te kaldı.)
import assert from 'node:assert/strict';
const R = new URL('../', import.meta.url).href;
const { Factory } = await import(R + 'server/factory.js');
const { Fabrika } = await import(R + 'plc/fabrika.js');
const { tagAddr, PAL_STATES } = await import(R + 'public/iomap.js');
const sim = new Factory({ seed: 7 });
let plc = new Fabrika({ ret: { TNK_COMMISSION: 0xc1ea } });
let saved = { ...plc.ret }, nextSave = 0, lf = -99;
let interruptedPallet, restarted = false;
const press = (t, at, name) => { sim.buttons[name] = t >= at && t < at + 0.6; };
const RESTART_AT = Number(process.argv[2] || 150);
for (let t = 0, i = 0; t < RESTART_AT + 370; t += 0.005, i++) {
  press(t, 1, 'reset'); if (t > 1.6) press(t, 3, 'start');
  if (t > RESTART_AT) press(t, RESTART_AT + 6, 'start');
  if (sim.dolum.cupMag < 5) sim.dolum.cupMag = 60;
  if (sim.dolum.foilMag < 5) sim.dolum.foilMag = 80;
  if (t > 30 && t - lf > 8 && sim.shrink.injectTestPack()) lf = t;
  if (t * 1000 >= nextSave) { saved = { ...plc.ret }; nextSave += 1000; }
  if (!restarted && t >= RESTART_AT) {
    restarted = true; interruptedPallet = sim.pallet.palletAt(1);
    const r = sim.pallet.rob;
    console.log('restart @', t.toFixed(2), 'ACK/RES', r.ackSeq, r.resSeq, 'JOB/SLOT', r.job?.type, r.job?.slot, 'R_PART', !!r.part);
    plc = new Fabrika({ ret: { ...saved } });
  }
  if (i % 20 === 0) { const ir = [...sim.ir]; sim.touchPlc(); const hr = plc.scan(ir, t * 1000); hr.forEach((v, k) => { sim.hr[k] = v; }); }
  sim.step(0.005);
  if (i % 4000 === 0 && t > RESTART_AT - 25) {
    const P = plc.PALLET, rd = sim.ir[tagAddr('PAL_IW_ROB_DI')];
    console.log(t.toFixed(0), PAL_STATES[sim.hr[tagAddr('PAL_QW_STATE')]], 'COUNT', P.COUNT, 'B', P.B_STP, 'R', P.R_STP, 'MODE', P.MODE,
      'HOLD', P.HOLD_LATCH, 'BOOT_OK', P.ROB_BOOT_OK, 'BOOK_OK', P.BOOK_OK, 'PEND', P.BOOT_PENDING, 'robDI', rd.toString(2),
      'ack/res', sim.ir[tagAddr('PAL_IW_ACK_SEQ')], sim.ir[tagAddr('PAL_IW_RES_SEQ')], 'lost', sim.kpi.lostCups, 'alarm', P.ALARMS.toString(16));
  }
}
const stored = sim.asrs.rack.find(p => p?.id === interruptedPallet?.id);
assert(restarted && interruptedPallet, 'Yeniden başlama B paletinde gerçekleşmeli');
assert(stored && stored.slots.filter(Boolean).length === 18 && stored.sheetBottom && stored.sheetTop && stored.wrapped,
  'START sonrası kesilen palet 18 paket ve iki levhayla tamamlanıp depolanmalı');
assert.equal(sim.kpi.lostCups, 0); assert.equal(sim.kpi.packsDropped, 0); assert.equal(sim.kpi.robotCrashes, 0);
assert.equal(plc.PALLET.ALARMS & 0x4000, 0);
console.log('OK: kesilen palet depoda, COUNT 18, kayıp 0; depolanan', sim.kpi.palletsStored);
