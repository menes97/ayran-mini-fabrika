// Hızlandırılmış uçtan uca test: simülatör + JS PLC aynı süreçte, Modbus gecikmesi taklit edilir.
// Kullanım: node test/smoke.js
import { Factory } from '../server/factory.js';
import { Fabrika, plcOf } from '../plc/fabrika.js';
import { Monitor } from '../monitor/monitor.js';
import { palletLabel } from '../monitor/db.js';
import { traceMatchesSim, timesConsistent, fmt, oeeOf } from './monitor-checks.js';
import { ALARMS, TANK_ALARMS, TANK_STATES, SHRINK_ALARMS, SHRINK_STATES, PAL_ALARMS, PAL_STATES, AGV_ALARMS, AGV_STATES,
  ASRS_ALARMS, ASRS_STATES, addr } from '../public/iomap.js';

const DOL_STATE = addr('dolum', 1);
const DOL_ALARM = addr('dolum', 2);
const TNK = { state: addr('tank', 1), alarm: addr('tank', 2), since: addr('tank', 4), res: addr('tank', 6),
  minT: addr('tank', 7), minF: addr('tank', 8), cond: addr('tank', 9), dur: addr('tank', 10) };
const SHR = { do: addr('shrink', 0), state: addr('shrink', 1), alarm: addr('shrink', 2), inside: addr('shrink', 5) };
const PAL = { do: addr('palet', 0), state: addr('palet', 4), alarm: addr('palet', 5), count: addr('palet', 7),
  done: addr('palet', 8), wrapped: addr('palet', 10) };
const AGV = { state: addr('agv', 3), alarm: addr('agv', 4) };
const ASRS = { state: addr('asrs', 4), alarm: addr('asrs', 5), stock: addr('asrs', 10), unknown: addr('asrs', 11) };
const ONLY = process.argv[2];   // node test/smoke.js Tank:  → yalnızca adında "Tank:" geçen senaryolar

// Bir FB'nin hangi PLC rolünde çalıştığı (bölünmüş modda testler FB'lere bu yoldan ulaşır)
const OWNER = { DOLUM: 'proses', TANK: 'proses', SHRINK: 'paketleme', PALLET: 'paketleme', AGV: 'lojistik', ASRS: 'lojistik' };

// lagMs: yoklamaya ek olarak her yönde gecikme (OpenPLC v3'te ölçülen toplam gidiş-dönüş ~300 ms)
// plcs: 'tek' (bir PLC bütün fabrika) ya da 'bolunmus' (proses, paketleme, lojistik; her biri kendi
//   okuma/yazma aralığıyla). Senaryo sim._plcDown = { paketleme: true } ile bir PLC'yi durdurabilir
//   (program ve Modbus master'ı durur), sim._plcRestart = { role, retain } ile yeniden başlatır;
//   eski string biçimi soğuk başlatmadır. ret her 1000 ms'de diske alınmış gibi kopyalanır.
//   sim._retFreeze = role bu rolün disk kopyasını olay anında dondurur; null ile çözülür.
//   sim._plcCommCut = { paketleme: true } ile yalnızca o PLC'nin saha haberleşmesini keser.
// monitor: true ise izleme servisi aynı süreçte çalışır (her monMs'de PLC görüntüsü + olay akışı);
//   PLC görüntüsü PLC'nin kendi çıkış görüntüsüdür (gerçek SCADA gibi PLC'yi okur), simülatörü değil.
function run({ name, seconds = 300, pollMs = 20, lagMs = 0, plcs = 'tek', monitor = false, monMs = 250,
  scenario = () => {}, expect, probe }) {
  if (ONLY && !name.includes(ONLY)) return true;
  let probeResult = true;
  let bookErr = 'ok';
  let invErr = 'ok';
  const sim = new Factory({ seed: 42 });
  const roles = plcs === 'tek' ? ['tek'] : ['proses', 'paketleme', 'lojistik'];
  // Factory.reset() temiz, devreye alınmış hat kurar. Bu tek kullanımlık token yalnızca ilk
  // açılışı temsil eder; PLC tüketir, 1 s görüntülerine temiz izin olarak tekrar yazılmaz.
  const units = roles.map((role) => ({ role, cfg: plcOf(role),
    plc: new Fabrika({ role, ret: { TNK_COMMISSION: 0xc1ea } }),
    savedRet: {}, nextSave: 1000, epoch: 0, ir: [...sim.ir], lastHr: null }));
  const unitOf = (k) => (units.length === 1 ? units[0] : units.find((u) => u.role === OWNER[k]));
  // senaryolar ve defter kontrolleri tek bir "PLC" görür: FB'ler sahibi olan role yönlendirilir
  const plc = new Proxy({}, {
    get: (_, k) => (OWNER[k] ? unitOf(k).plc[k] : units[0].plc[k]),
    set: (_, k, v) => { (OWNER[k] ? unitOf(k).plc : units[0].plc)[k] = v; return true; },
  });
  const mon = monitor ? new Monitor({ mode: plcs }) : null;
  const down = (u) => !!sim._plcDown?.[u.role];
  const DT = 0.005;
  let nextPoll = 0;
  let nextScan = 0;
  let nextMon = 0;
  const pending = [];                     // gecikmeli teslim kuyruğu: { at, apply }
  for (let t = 0; t < seconds; t += DT) {
    const ms = t * 1000;
    scenario(sim, t, plc);
    if (sim._plcRestart) {
      const req = typeof sim._plcRestart === 'string' ? { role: sim._plcRestart, retain: false } : sim._plcRestart;
      const u = units.find((x) => x.role === req.role);
      if (!u) throw new Error(`Yeniden başlatma rolü yok: ${req.role}`);
      u.epoch++;
      u.plc = new Fabrika({ role: u.role, ret: req.retain ? structuredClone(u.savedRet) : {} }); u.lastHr = null;
      // Restart destroys the old master's pending transactions, not the field controller's records.
      u.ir = [...sim.ir];
      sim._plcRestart = null;
    }
    if (ms >= nextPoll) {                 // Modbus yoklaması: her PLC kendi aralığını okur ve yazar
      nextPoll += pollMs;
      if (!sim.faults.commLoss) {
        for (const u of units) {
          if (down(u) || sim._plcCommCut?.[u.role]) continue;
          const [r0, rn] = u.cfg.read, [w0, wn] = u.cfg.write;
          const snap = sim.ir.map((v, i) => (i >= r0 && i < r0 + rn ? v : 0));
          const hr = u.lastHr && u.lastHr.slice(w0, w0 + wn);
          const epoch = u.epoch;
          sim.touchPlc();
          pending.push({ at: ms + lagMs, apply: () => { if (epoch === u.epoch) u.ir = snap; } });
          if (hr) pending.push({ at: ms + lagMs, apply: () => { if (epoch === u.epoch) hr.forEach((v, i) => { sim.hr[w0 + i] = v; }); } });
        }
      }
    }
    while (pending.length && pending[0].at <= ms) pending.shift().apply();
    if (ms >= nextScan) {
      nextScan += 20;
      for (const u of units) if (!down(u)) u.lastHr = u.plc.scan(u.ir, ms);
    }
    for (const u of units) if (ms >= u.nextSave) {
      u.nextSave += 1000;
      if (!down(u) && sim._retFreeze !== u.role) u.savedRet = structuredClone(u.plc.ret);
    }
    sim._retImages = Object.fromEntries(units.map((u) => [u.role, u.savedRet]));
    sim.step(DT);
    if (mon && ms >= nextMon) {
      nextMon += monMs;
      const ts = Math.round(sim.t * 1000);
      mon.sample(ts, Object.fromEntries(units.map((u) => [u.role, down(u) || !u.lastHr || sim._monBlind?.[u.role] ? null : [...u.lastHr]])));
      if (!sim._monEventsPaused) {
        do { mon.events(sim.trace.since(mon.ingest.cursor.last_seq, 2000), ts); }
        while (sim.trace.seq > mon.ingest.cursor.last_seq && sim.trace.run === mon.ingest.cursor.run);
      }
    }
    if (probe && Math.abs(t - probe.at) < DT / 2) probeResult = probe.check(sim);
    if (Math.abs(t % 1) < DT / 2 && bookErr === 'ok') {     // her saniye: defter gerçek paletle tutuyor mu
      const b = bookkeeping(sim, plc);
      if (b !== 'ok') bookErr = `t=${t.toFixed(0)} s: ${b}`;
      const v = inventory(sim, plc);
      if (v !== 'ok' && invErr === 'ok') invErr = `t=${t.toFixed(0)} s: ${v}`;
    }
  }
  const k = sim.kpi;
  const alarms = ALARMS.filter((a) => (sim.hr[DOL_ALARM] >> a.bit) & 1).map((a) => a.text);
  const fb = plc.DOLUM;
  const tankAlarms = TANK_ALARMS.filter((a) => (sim.hr[TNK.alarm] >> a.bit) & 1).map((a) => a.text);
  const r2 = (v) => +v.toFixed(2);
  const result = {
    ...k, spilledKg: r2(k.spilledKg), drainProductKg: r2(k.drainProductKg), causticLostKg: r2(k.causticLostKg),
    causticToProductKg: +k.causticToProductKg.toFixed(5), hygieneRiskKg: r2(k.hygieneRiskKg),
    mode: sim.hr[DOL_STATE], preact: fb.PREACT, margin: fb.COARSE_MARGIN, alarms,
    tank: TANK_STATES[sim.hr[TNK.state]], tankAlarms, cipRes: sim.hr[TNK.res], sinceKg: sim.hr[TNK.since] / 10,
    cip: { minT: sim.hr[TNK.minT] / 10, minF: sim.hr[TNK.minF] / 100, cond: sim.hr[TNK.cond] / 10, dur: sim.hr[TNK.dur] },
    soil: r2(sim.tank.soil), fillerTankPct: r2(sim.dolum.level),
    shrink: SHRINK_STATES[sim.hr[SHR.state]],
    shrinkAlarms: SHRINK_ALARMS.filter((a) => (sim.hr[SHR.alarm] >> a.bit) & 1).map((a) => a.text),
    burntPacks: sim.shrink.done.filter((pk) => pk.defect === 'film yandı').length
      + sim.shrink.belt.filter((b) => sim.shrink.quality(b.pack) === 'film yandı').length,
    cupsShipped: k.shippedGood,
    pal: PAL_STATES[sim.hr[PAL.state]],
    palAlarms: PAL_ALARMS.filter((a) => (sim.hr[PAL.alarm] >> a.bit) & 1).map((a) => a.text),
    palCount: sim.hr[PAL.count], palDone: sim.hr[PAL.done],
    bookkeeping: bookErr,
    agv: AGV_STATES[sim.hr[AGV.state]],
    agvAlarms: AGV_ALARMS.filter((a) => (sim.hr[AGV.alarm] >> a.bit) & 1).map((a) => a.text),
    asrs: ASRS_STATES[sim.hr[ASRS.state]],
    asrsAlarms: ASRS_ALARMS.filter((a) => (sim.hr[ASRS.alarm] >> a.bit) & 1).map((a) => a.text),
    stock: sim.hr[ASRS.stock], inventory: invErr, shippedIds: sim.asrs.shipped,
  };
  const problems = expect(result, sim, mon);
  if (probeResult !== true) problems.push(probeResult);
  console.log(`${problems.length ? 'FAIL' : 'OK  '} ${name}`);
  console.log('     ', JSON.stringify(result));
  for (const p of problems) console.log('      -', p);
  return problems.length === 0;
}

// PLC'nin paletteki paket sayısı istif konumundaki gerçek paletle tutuyor mu?
function bookkeeping(sim, plc) {
  const p = sim.pallet.palletAt(1);
  // iş sürerken (bırakıldı ama sonuç PLC'ye henüz ulaşmadı) karşılaştırılmaz
  if (!p || !plc.PALLET.BOOK_OK || plc.PALLET.RECOVERING || plc.PALLET.B_STP !== 10 || plc.PALLET.R_STP !== 0 || sim.pallet.rob.job) return 'ok';
  const real = p.slots.filter(Boolean).length;
  return real === plc.PALLET.COUNT ? 'ok' : `PLC ${plc.PALLET.COUNT}, palette ${real}`;
}

// PLC'nin göz tablosu raftaki gerçek paletlerle tutuyor mu? (belirsiz ve ayrılmış gözler hariç)
function inventory(sim, plc) {
  const A = plc.ASRS;
  if (!A.INIT_DONE || A.R_STP !== 0 || sim.asrs.crane.job) return 'ok';
  for (let i = 1; i <= 36; i++) {
    const real = sim.asrs.rack[i - 1];
    if (A.LST[i] === 2 && (!real || real.id !== A.LID[i])) return `göz ${i}: PLC #${A.LID[i]}, rafta ${real ? '#' + real.id : 'boş'}`;
    if (A.LST[i] === 0 && real) return `göz ${i}: PLC boş, rafta #${real.id}`;
  }
  return 'ok';
}
const logiOk = (r) => [
  r.inventory !== 'ok' && `envanter tutmuyor: ${r.inventory}`,
  r.bookkeeping !== 'ok' && `palet defteri tutmuyor: ${r.bookkeeping}`,
  r.robotCrashes > 0 && `${r.robotCrashes} çarpışma`,
  r.palletsBad > 0 && `${r.palletsBad} hatalı palet`,
];
const noAlarms = (r) => [
  [...r.palAlarms, ...r.agvAlarms, ...r.asrsAlarms].some((a) => !a.startsWith('Uyarı'))
    && `alarm kaldı: ${[...r.palAlarms, ...r.agvAlarms, ...r.asrsAlarms]}`,
];

// Paletleme senaryolarını kısaltmak için alma noktasına hazır (sarılmış, sağlam) paket koyar.
const feedPacks = (sim, every = 5) => {
  if (sim.t - (sim._lastFeed ?? -99) < every) return;
  if (sim.shrink.injectTestPack()) sim._lastFeed = sim.t;
};
const palOk = (r) => [
  r.bookkeeping !== 'ok' && `defter tutmuyor: ${r.bookkeeping}`,
  r.robotCrashes > 0 && `${r.robotCrashes} robot çarpışması`,
  r.palletsBad > 0 && `${r.palletsBad} hatalı palet`,
];

// Butonu verilen anlarda 0,3 s basılı tutar; aynı butonun bütün anları tek çağrıda verilir.
const press = (sim, t, name, ...at) => { sim.buttons[name] = at.some((a) => t >= a && t < a + 0.3); };
const pressTank = (sim, t, name, ...at) => { sim.tank.buttons[name] = at.some((a) => t >= a && t < a + 0.3); };
// uzun senaryolarda bardak ve folyo bitmesin
const keepFed = (sim) => {
  if (sim.dolum.cupMag < 5) sim.dolum.cupMag = 60;
  if (sim.dolum.foilMag < 5) sim.dolum.foilMag = 80;
};
const noContamination = (r) => [
  r.causticToProductKg > 0 && `ürüne ${r.causticToProductKg} kg kostik geçti`,
  r.shippedBad > 0 && `${r.shippedBad} hatalı ürün sevk edildi`,
  r.hygieneRiskKg > 0 && `${r.hygieneRiskKg} kg ürün kirli hattan geçti`,
];

const results = [
  run({
    name: 'Normal üretim, 20 ms yoklama',
    scenario: (sim, t) => press(sim, t, 'start', 1),
    expect: (r) => [
      r.shippedGood < 40 && `çok az üretim: ${r.shippedGood}`,
      r.shippedBad > 0 && `${r.shippedBad} hatalı ürün sevk edildi`,
      r.rejectedGood > 2 && `${r.rejectedGood} sağlam ürün reddedildi`,
      r.alarms.some((a) => !a.startsWith('Uyarı')) && `alarm: ${r.alarms}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Normal üretim, 100 ms yoklama (OpenPLC v4 varsayılanı)',
    pollMs: 100,
    scenario: (sim, t) => press(sim, t, 'start', 1),
    expect: (r) => [
      r.shippedGood < 35 && `çok az üretim: ${r.shippedGood}`,
      r.shippedBad > 0 && `${r.shippedBad} hatalı ürün sevk edildi`,
      r.rejectedGood > 4 && `${r.rejectedGood} sağlam ürün reddedildi`,
    ].filter(Boolean),
  }),
  run({
    name: 'Normal üretim, 100 ms yoklama + 100 ms gecikme (OpenPLC v3 ölçümü)',
    pollMs: 100,
    lagMs: 100,
    scenario: (sim, t) => press(sim, t, 'start', 1),
    expect: (r) => [
      r.shippedGood < 35 && `çok az üretim: ${r.shippedGood}`,
      r.shippedBad > 0 && `${r.shippedBad} hatalı ürün sevk edildi`,
      // kaba akış payı 40 g'dan ~90 g'a her hatalı dolumda 10 g büyüyerek öğrenir: ~5 öğrenme reddi beklenir
      r.rejectedBad + r.rejectedGood > 6 && `${r.rejectedBad + r.rejectedGood} bardak reddedildi`,
      r.lostCups > 0 && `${r.lostCups} bardak kayboldu`,
    ].filter(Boolean),
  }),
  run({
    name: 'Bardak ayırıcı kaçırıyor + vana kaçırıyor',
    scenario: (sim, t) => {
      press(sim, t, 'start', 1);
      sim.faults.dropMiss = t > 60;
      sim.faults.valveLeak = t > 120 && t < 150;
    },
    expect: (r) => [
      // kaçağın terazide görülen kısmını uçuş payı düzeltir, kalanı toleransın içinde kalır
      r.shippedBad > 0 && `${r.shippedBad} hatalı ürün sevk edildi`,
      r.lostCups > 0 && `${r.lostCups} bardak kayboldu`,
    ].filter(Boolean),
  }),
  run({
    name: 'Isıtıcı arızası → bekle, alarm, onarım + reset → devam',
    seconds: 240,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1, 152);
      sim.faults.heaterFail = t > 60 && t < 140;
      press(sim, t, 'reset', 150);
      
    },
    expect: (r) => [
      r.shippedBad > 0 && `${r.shippedBad} hatalı ürün sevk edildi`,
      r.mode !== 1 && r.mode !== 5 && `son mod ${r.mode}, çalışıyor olmalıydı`,
      r.shippedGood < 15 && `üretim devam etmedi: ${r.shippedGood}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Acil stop üretim ortasında, sonra reset + start',
    seconds: 200,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1, 92);
      sim.estop = t > 80 && t < 85;
      press(sim, t, 'reset', 90);
      
    },
    expect: (r) => [
      r.shippedBad > 0 && `${r.shippedBad} hatalı ürün sevk edildi`,
      r.mode !== 1 && `son mod ${r.mode}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Dolum terazisi kayar → kontrol tartısı yakalar, red',
    seconds: 200,
    scenario: (sim, t) => { press(sim, t, 'start', 1); sim.faults.scaleDrift = t > 60 && t < 120; },
    expect: (r) => [
      r.shippedBad > 0 && `${r.shippedBad} hatalı ürün sevk edildi`,
      r.rejectedBad < 5 && `yalnızca ${r.rejectedBad} bardak reddedildi`,
      r.rejectedGood > 0 && `${r.rejectedGood} sağlam bardak reddedildi`,
    ].filter(Boolean),
  }),
  run({
    name: 'Çıkış bandı tıkanır → makine bekler, bant açılınca devam eder',
    seconds: 240,
    scenario: (sim, t) => { press(sim, t, 'start', 1); sim.faults.outBlocked = t > 40 && t < 140; },
    expect: (r, sim) => [
      r.lostCups > 0 && `${r.lostCups} bardak dolu banda itilip ezildi`,
      r.shippedBad > 0 && `${r.shippedBad} hatalı ürün sevk edildi`,
      r.mode !== 1 && `son mod ${r.mode}, çalışıyor olmalıydı`,
      r.shippedGood < 30 && `bant açılınca üretim devam etmedi: ${r.shippedGood}`,
      r.alarms.some((a) => !a.startsWith('Uyarı')) && `beklemede alarm olmamalı: ${r.alarms}`,
    ].filter(Boolean),
    // bekleme sırasında gerçekten "çıkış dolu" durumuna geçtiğini de kontrol et
    probe: { at: 130, check: (sim) => sim.hr[DOL_STATE] === 6 || `t=130 s'de mod ${sim.hr[DOL_STATE]}, 6 (çıkış dolu) olmalıydı` },
  }),
  run({
    name: 'Endeksleyici sıkışması → alarm',
    seconds: 120,
    scenario: (sim, t) => { press(sim, t, 'start', 1); sim.faults.jam = t > 60; },
    expect: (r) => [
      !r.alarms.includes('Endeksleyici sıkıştı') && 'sıkışma alarmı gelmedi',
      r.mode !== 3 && `mod ${r.mode}, alarm olmalıydı`,
    ].filter(Boolean),
  }),
  run({
    name: 'Folyo magazini biter → alarm',
    seconds: 400,
    scenario: (sim, t) => { press(sim, t, 'start', 1); if (t < 0.01) sim.dolum.foilMag = 10; },
    expect: (r) => [
      !r.alarms.includes('Folyo magazini boş') && 'folyo alarmı gelmedi',
      r.shippedBad > 0 && `${r.shippedBad} hatalı ürün sevk edildi`,
    ].filter(Boolean),
  }),
  run({
    name: 'Haberleşme kopar → PLC alarmı, simülatör çıkışları kapatır',
    seconds: 100,
    scenario: (sim, t) => { press(sim, t, 'start', 1); sim.faults.commLoss = t > 60 && t < 70; },
    expect: (r, sim) => [
      !r.alarms.includes('Simülatör haberleşmesi kesildi') && 'haberleşme alarmı gelmedi',
      r.shippedBad > 0 && `${r.shippedBad} hatalı ürün sevk edildi`,
    ].filter(Boolean),
  }),

  // ---------------- Tank, transfer, CIP ----------------
  run({
    name: 'Tank: uzun üretim, dolum tankı tanktan beslenir',
    seconds: 600,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); },
    expect: (r) => [
      ...noContamination(r),
      r.shippedGood < 100 && `çok az üretim: ${r.shippedGood}`,
      r.tankAlarms.some((a) => !a.startsWith('Uyarı')) && `tank alarmı: ${r.tankAlarms}`,
      r.alarms.includes('Uyarı: ürün tankı alt seviyede') && 'dolum tankı alt seviyeye düştü',
      r.drainProductKg > 8 && `gidere çok ürün gitti: ${r.drainProductKg} kg`,
    ].filter(Boolean),
  }),
  run({
    name: 'Tank: CIP üretim sırasında, sonra üretim devam eder',
    seconds: 700,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); pressTank(sim, t, 'cipStart', 200); },
    expect: (r) => [
      ...noContamination(r),
      r.cipRes !== 1 && `CIP sonucu ${r.cipRes}, başarılı olmalıydı (${r.tankAlarms})`,
      r.cip.minT < 70 && `kostik dönüş sıcaklığı ${r.cip.minT} °C, en az 70 olmalı`,
      r.cip.cond > 1.0 && `son durulama iletkenliği ${r.cip.cond} mS/cm`,
      // CIP sonrası kir yalnızca CIP'ten sonra geçen üründen gelmeli (60 kg'de 1,0)
      r.soil > r.sinceKg / 60 + 0.05 && `CIP hattı temizlemedi: kir ${r.soil}, CIP sonrası ${r.sinceKg} kg`,
      r.shippedGood < 100 && `CIP sırasında/sonrasında üretim aksadı: ${r.shippedGood}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Tank: CIP yapılmazsa aktarım durur, kirli hattan ürün geçmez',
    seconds: 1500,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); },
    expect: (r) => [
      ...noContamination(r),
      !r.tankAlarms.includes('Uyarı: CIP gerekli, yeni aktarım yok') && 'CIP gerekli uyarısı gelmedi',
      r.sinceKg > 52 && `CIP sınırı aşıldı: ${r.sinceKg} kg`,
    ].filter(Boolean),
  }),
  run({
    name: 'Tank: dolum vanası açık takılı → CIP başlamaz, kostik ürüne geçmez',
    seconds: 400,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim);
      sim.faults.vFillStuck = t > 150;
      pressTank(sim, t, 'cipStart', 200);
    },
    expect: (r) => [
      r.causticToProductKg > 0 && `ürüne ${r.causticToProductKg} kg kostik geçti`,
      !r.tankAlarms.includes('Vana kapanmadı (rota kanıtlanamadı)') && `vana alarmı gelmedi: ${r.tankAlarms}`,
      r.cipRes === 1 && 'CIP yapılmış görünüyor, yapılmamalıydı',
    ].filter(Boolean),
  }),
  run({
    name: 'Tank: CIP sırasında dolum vanası kaçırır → kaçak alarmı, CIP başarısız',
    seconds: 400,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim);
      pressTank(sim, t, 'cipStart', 100);
      // kaçak, CIP kostik adımındayken başlar (durum 7) ve kalır
      if (sim.hr[TNK.state] === 7) sim.faults.vFillLeak = true;
    },
    expect: (r) => [
      r.causticToProductKg > 0 && `ürüne ${r.causticToProductKg} kg kostik geçti`,
      !r.tankAlarms.includes('Dolum vanası kaçak odasında sıvı') && `kaçak alarmı gelmedi: ${r.tankAlarms}`,
      r.cipRes !== 3 && `CIP sonucu ${r.cipRes}, 3 (başarısız) olmalıydı`,
    ].filter(Boolean),
  }),
  run({
    name: 'Tank: kostik ısıtıcısı arızalı → CIP ısınma zaman aşımı',
    seconds: 600,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim);
      sim.faults.causticHeaterFail = true;
      if (t < 0.01) sim.tank.causticT = 30;
      pressTank(sim, t, 'cipStart', 60);
    },
    expect: (r) => [
      ...noContamination(r),
      !r.tankAlarms.includes('CIP koşulları sağlanamadı (zaman aşımı)') && `zaman aşımı alarmı gelmedi: ${r.tankAlarms}`,
      r.cipRes !== 3 && `CIP sonucu ${r.cipRes}, 3 olmalıydı`,
    ].filter(Boolean),
  }),
  run({
    name: 'Tank: pompa motor koruması atar → alarm, reset sonrası devam',
    seconds: 600,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1, 260); keepFed(sim);
      sim.faults.pumpTrip = t > 30 && t < 250;
      press(sim, t, 'reset', 255);
    },
    expect: (r) => [
      ...noContamination(r),
      r.tankAlarms.some((a) => !a.startsWith('Uyarı')) && `reset sonrası alarm kaldı: ${r.tankAlarms}`,
      r.shippedGood < 60 && `üretim devam etmedi: ${r.shippedGood}`,
    ].filter(Boolean),
    probe: { at: 200, check: (sim) => ((sim.hr[TNK.alarm] >> 5) & 1) === 1 || "motor koruma alarmı t=200 s'de yoktu" },
  }),
  run({
    name: 'Tank: debimetre sıfır okur → debi yok alarmı',
    seconds: 300,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); sim.faults.flowmeterFail = true; },
    expect: (r) => [
      !r.tankAlarms.includes('Pompa çalışıyor ama debi yok') && `debi alarmı gelmedi: ${r.tankAlarms}`,
      r.causticToProductKg > 0 && 'kostik geçti',
    ].filter(Boolean),
  }),

  // ---------------- Paketleme: gruplama, sarma, fırın ----------------
  run({
    name: 'Paket: normal üretim, 6\'lı paketler fırından sağlam çıkar',
    seconds: 600,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); },
    expect: (r) => [
      r.packsGood < 15 && `çok az paket: ${r.packsGood}`,
      r.packsBad > 0 && `${r.packsBad} hatalı paket`,
      r.lostCups > 0 && `${r.lostCups} bardak kayboldu`,
      r.shrinkAlarms.some((a) => !a.startsWith('Uyarı')) && `paketleme alarmı: ${r.shrinkAlarms}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Paket: film kopar → alarm, film takılıp reset sonrası devam',
    seconds: 500,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1, 192); keepFed(sim);
      sim.faults.filmBreak = t > 100 && t < 180;
      press(sim, t, 'reset', 190);
    },
    expect: (r) => [
      r.packsBad > 0 && `${r.packsBad} hatalı paket (sarılmamış paket fırına girmemeli)`,
      r.shrinkAlarms.some((a) => !a.startsWith('Uyarı')) && `reset sonrası alarm kaldı: ${r.shrinkAlarms}`,
      r.packsGood < 8 && `film değişince üretim devam etmedi: ${r.packsGood}`,
    ].filter(Boolean),
    probe: { at: 170, check: (sim) => ((sim.hr[SHR.alarm] >> 3) & 1) === 1 || "sarma alarmı t=170 s'de yoktu" },
  }),
  run({
    name: 'Paket: fırın fanı durur → alarm, ısıtıcı kapanır, aşırı sıcaklık kesmesi atmaz',
    seconds: 300,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); sim.faults.fanFail = t > 150; },
    expect: (r, sim) => [
      !r.shrinkAlarms.includes('Fırın fanı dönmüyor') && `fan alarmı gelmedi: ${r.shrinkAlarms}`,
      sim.shrink.otTripped && 'aşırı sıcaklık kesmesi attı (ısıtıcı fan yokken çalışmaya devam etti)',
      r.burntPacks > 0 && `${r.burntPacks} paket yandı`,
    ].filter(Boolean),
  }),
  run({
    name: 'Paket: çıkış tıkanır → fırındaki paketler için ısıtıcı kesilir, hat geriye doğru durur',
    seconds: 600,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); sim.faults.exitBlocked = t > 120 && t < 400; },
    expect: (r) => [
      r.burntPacks > 0 && `${r.burntPacks} paket fırında yandı`,
      r.lostCups > 0 && `${r.lostCups} bardak kayboldu`,
      r.cupsShipped === 0 && 'üretim hiç olmadı',
      r.shrinkAlarms.some((a) => !a.startsWith('Uyarı')) && `alarm: ${r.shrinkAlarms}`,
    ].filter(Boolean),
    probe: { at: 300, check: (sim) => (sim.hr[SHR.state] === 4 && !((sim.hr[SHR.do] >> 7) & 1))
      || `t=300 s: durum ${sim.hr[SHR.state]} (4 bekleniyordu), ısıtıcı ${((sim.hr[SHR.do] >> 7) & 1) ? 'açık' : 'kapalı'}` },
  }),
  run({
    name: 'Paket: fırın ısıtıcısı arızalı → ısınma alarmı, soğuk fırına paket girmez',
    seconds: 300,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); sim.faults.tunnelHeaterFail = true; },
    expect: (r) => [
      !r.shrinkAlarms.includes('Fırın ısınmıyor') && `ısınma alarmı gelmedi: ${r.shrinkAlarms}`,
      r.packsBad > 0 && `${r.packsBad} hatalı paket (soğuk fırına paket girdi)`,
    ].filter(Boolean),
  }),
  run({
    name: 'Paket: fırın bandı takılır → alarm',
    seconds: 300,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); sim.faults.beltStall = t > 150; },
    expect: (r) => [
      !r.shrinkAlarms.includes('Fırın bandı dönmüyor') && `bant alarmı gelmedi: ${r.shrinkAlarms}`,
      r.burntPacks > 0 && `${r.burntPacks} paket yandı`,
    ].filter(Boolean),
  }),
  run({
    name: 'Paket: stop basılınca fırın boşaltılır, sonra fan soğutup durur',
    seconds: 600,
    scenario: (sim, t) => { press(sim, t, 'start', 1); press(sim, t, 'stop', 200); keepFed(sim); },
    expect: (r, sim) => [
      r.packsBad > 0 && `${r.packsBad} hatalı paket`,
      sim.hr[SHR.inside] !== 0 && `fırında ${sim.hr[SHR.inside]} paket kaldı`,
      sim.shrink.temp > 60 && `fırın soğumadı: ${sim.shrink.temp.toFixed(0)} °C`,
      ((sim.hr[SHR.do] >> 8) & 1) === 1 && 'fırın soğuduğu hâlde fan hâlâ çalışıyor',
    ].filter(Boolean),
  }),
  run({
    name: 'Paket: sıra iticisi takılır → alarm, bardak kaybolmaz',
    seconds: 300,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); sim.faults.rowStuck = t > 120; },
    expect: (r) => [
      !r.shrinkAlarms.includes('Sıra iticisi hareket etmedi') && `itici alarmı gelmedi: ${r.shrinkAlarms}`,
      r.lostCups > 0 && `${r.lostCups} bardak kayboldu`,
    ].filter(Boolean),
  }),
  run({
    name: 'Paket: bardak gelmeyince enerji tasarrufu, bardak gelince ısınıp devam',
    seconds: 700,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1);
      if (t > 100 && t < 400) sim.dolum.cupMag = 0;           // bardak bitti, uzun bekleme
      else keepFed(sim);
      if (t > 400 && t < 400.01) sim.dolum.cupMag = 60;
    },
    expect: (r) => [
      r.packsBad > 0 && `${r.packsBad} hatalı paket (soğuk fırına paket girdi)`,
      r.packsGood < 8 && `bekleme sonrası üretim devam etmedi: ${r.packsGood}`,
    ].filter(Boolean),
    probe: { at: 380, check: (sim) => sim.hr[SHR.state] === 7 || `t=380 s: durum ${sim.hr[SHR.state]}, 7 (enerji tasarrufu) olmalıydı` },
  }),

  // ---------------- Paletleme: robot, palet hattı, streç (100 ms yoklama + 100 ms gecikme) ----------------
  run({
    name: 'Palet: normal döngü, iki palet istiflenir, streçlenir, alınır',
    seconds: 800, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); feedPacks(sim); },
    expect: (r) => [
      ...palOk(r),
      r.palletsGood < 2 && `çok az palet: ${r.palletsGood}`,
      r.packsDropped > 0 && `${r.packsDropped} paket düştü`,
      r.palAlarms.length > 0 && `alarm: ${r.palAlarms}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Palet: robot paketi bırakıp dönerken kapı açılır → güvenlik durdurması; paket sayılır, kapat + reset + start → devam',
    seconds: 500, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1, 132); keepFed(sim); feedPacks(sim);
      if (t >= 100 && !sim._doorDone && sim.pallet.rob.job?.released) {   // en zor an: paket bırakıldı, iş bitmedi
        sim._doorDone = true; sim._doorAt = t;
        sim.command({ type: 'door', value: true });
      }
      if (sim._doorAt && t >= sim._doorAt + 10 && sim.pallet.safe.door === false) sim.command({ type: 'door', value: false });
      if (sim.pallet.rob.resCode === 17) sim._code17 = true;
      press(sim, t, 'reset', 128);
    },
    expect: (r, sim) => [
      ...palOk(r),
      !sim._doorDone && 'kapı açılamadı (bırakma işi yakalanamadı)',
      !sim._code17 && 'robot "bırakıldı, sonra iptal" (17) bildirmedi',
      r.palletsGood < 1 && `kapıdan sonra üretim devam etmedi: ${r.palletsGood}`,
      r.palAlarms.length > 0 && `reset sonrası alarm kaldı: ${r.palAlarms}`,
    ].filter(Boolean),
    probe: { at: 120, check: (sim) => (sim.hr[PAL.state] === 7 && !sim.pallet.power) || `t=120 s: durum ${PAL_STATES[sim.hr[PAL.state]]}, robot gücü ${sim.pallet.power}` },
  }),
  run({
    name: 'Palet: robot taşırken paketi düşürür → alarm, slot boş kalır, reset sonrası aynı slota yeni paket',
    seconds: 600, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1, 102); keepFed(sim); feedPacks(sim);
      if (t > 60 && t < 60.01) sim.faults.vacuumDrop = true;
      press(sim, t, 'reset', 100);
    },
    expect: (r) => [
      ...palOk(r),
      r.packsDropped !== 1 && `${r.packsDropped} paket düştü (1 bekleniyordu)`,
      r.palletsGood < 1 && 'palet tamamlanmadı',
      r.palAlarms.length > 0 && `alarm kaldı: ${r.palAlarms}`,
    ].filter(Boolean),
    probe: { at: 90, check: (sim) => ((sim.hr[PAL.alarm] >> 3) & 1) === 1 || "t=90 s: 'paket düştü' alarmı yok" },
  }),
  run({
    name: 'Palet: robot çarpışması → alarm, reset, eve dönüş, sayı korunur',
    seconds: 600, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1, 102); keepFed(sim); feedPacks(sim);
      if (t > 60 && t < 60.01) sim.faults.robotCollision = true;
      press(sim, t, 'reset', 100);
    },
    expect: (r) => [
      r.bookkeeping !== 'ok' && `defter tutmuyor: ${r.bookkeeping}`,
      r.robotCrashes !== 1 && `${r.robotCrashes} çarpışma (yalnızca eklenen 1 bekleniyordu)`,
      r.palletsBad > 0 && `${r.palletsBad} hatalı palet`,
      r.palletsGood < 1 && 'palet tamamlanmadı',
      r.palAlarms.length > 0 && `alarm kaldı: ${r.palAlarms}`,
    ].filter(Boolean),
    probe: { at: 90, check: (sim) => (((sim.hr[PAL.alarm] >> 2) & 1) === 1 && !sim.pallet.rob.homed) || 't=90 s: çarpışma alarmı ya da eve dönüş ihtiyacı yok' },
  }),
  run({
    name: 'Palet: biri ışık perdesinden geçer → durur; palet geçerken muting ile durmaz',
    seconds: 600, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1, 112); keepFed(sim); feedPacks(sim);
      if (t > 80 && t < 80.01) sim.command({ type: 'intrude' });
      press(sim, t, 'reset', 110);
    },
    expect: (r) => [
      ...palOk(r),
      r.palletsGood < 1 && 'palet perdeden geçemedi (muting çalışmadı)',
      r.palAlarms.length > 0 && `alarm kaldı: ${r.palAlarms}`,
    ].filter(Boolean),
    probe: { at: 95, check: (sim) => sim.hr[PAL.state] === 7 || `t=95 s: durum ${PAL_STATES[sim.hr[PAL.state]]} (güvenlik durdurması bekleniyordu)` },
  }),
  run({
    name: 'Palet: streç film kopar → alarm, film değişir + reset + start → palet baştan sarılır',
    seconds: 700, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim); feedPacks(sim);
      if (sim.pallet.wrap.phase === 'run' && !sim._broke) { sim._broke = true; sim.faults.stretchBreak = true; sim._breakAt = t; }
      if (sim._breakAt && t > sim._breakAt + 20 && sim.faults.stretchBreak) { sim.faults.stretchBreak = false; sim._fixAt = t; }
      if (sim._fixAt) { press(sim, t, 'reset', sim._fixAt + 2); press(sim, t, 'start', 1, sim._fixAt + 5); }
    },
    expect: (r, sim) => [
      ...palOk(r),
      !sim._broke && 'streç hiç başlamadı',
      r.palletsGood < 1 && 'palet sarılıp alınmadı',
      r.palAlarms.length > 0 && `alarm kaldı: ${r.palAlarms}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Palet: iş ortasında haberleşme kopar → iş iptal, defter bozulmaz, aynı iş iki kez yapılmaz',
    seconds: 500, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim); feedPacks(sim);
      if (t >= 80 && !sim._cut && sim.pallet.rob.job?.type === 2) { sim._cut = true; sim._cutAt = t; }
      sim.faults.commLoss = !!sim._cutAt && t < sim._cutAt + 4;
      if (sim._cutAt) { press(sim, t, 'reset', sim._cutAt + 8); press(sim, t, 'start', 1, sim._cutAt + 10); }
    },
    expect: (r, sim) => [
      ...palOk(r),
      !sim._cut && 'kesinti yakalanamadı',
      r.palletsGood < 1 && 'kesintiden sonra palet tamamlanmadı',
      r.palAlarms.length > 0 && `alarm kaldı: ${r.palAlarms}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Palet: boş palet magazini biter → bekler, doldurulunca devam',
    seconds: 800, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim); feedPacks(sim);
      if (t < 0.01) sim.pallet.palletMag = 1;
      if (t > 450 && t < 450.01) sim.command({ type: 'refill', name: 'pallets' });
    },
    expect: (r) => [
      ...palOk(r),
      r.palletsGood < 2 && `doldurmadan sonra devam etmedi: ${r.palletsGood} palet`,
    ].filter(Boolean),
    probe: { at: 420, check: (sim) => sim.hr[PAL.state] === 3 || `t=420 s: durum ${PAL_STATES[sim.hr[PAL.state]]} (palet yok bekleniyordu)` },
  }),
  run({
    name: 'Palet: palet konveyörü sıkışır → aktarma zaman aşımı alarmı',
    seconds: 400, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); feedPacks(sim, 3); sim.faults.palletJam = true; },
    expect: (r) => [
      !r.palAlarms.includes('Palet hattı sıkıştı (aktarma zaman aşımı)') && `sıkışma alarmı gelmedi: ${r.palAlarms}`,
      r.robotCrashes > 0 && 'robot çarpıştı',
    ].filter(Boolean),
  }),

  // ---------------- Lojistik: AGV ve otomatik depo (100 ms yoklama + 100 ms gecikme, test besleyici) ----------------
  run({
    name: 'Depo: normal akış, AGV taşır, vinç depolar, sipariş FIFO ile çıkar, kamyona yüklenir',
    seconds: 900, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim); feedPacks(sim);
      if (t > 600 && !sim._ship) { sim._ship = true; sim.command({ type: 'shipOrder', value: 2 }); }
    },
    expect: (r) => [
      ...logiOk(r), ...noAlarms(r),
      r.palletsStored < 3 && `çok az depolama: ${r.palletsStored}`,
      r.palletsShipped !== 2 && `${r.palletsShipped} palet sevk edildi (2 bekleniyordu)`,
      r.shippedIds.join(',') !== '1,2' && `FIFO değil: sevk edilen ${r.shippedIds}`,
    ].filter(Boolean),
    probe: { at: 30, check: (sim) => sim.hr[ASRS.state] === 3 || `t=30 s: durum ${ASRS_STATES[sim.hr[ASRS.state]]} (başlangıçta envanter sayımı bekleniyordu)` },
  }),
  run({
    name: 'Depo: AGV yolunda engel → durur, engel kalkınca 2 s sonra kendiliğinden devam eder',
    seconds: 700, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim); feedPacks(sim);
      if (!sim._obs && sim.agv.order?.type === 1 && sim.agv.seg && !sim.agv.load) { sim._obs = t; }
      sim.faults.agvObstacle = !!sim._obs && t < sim._obs + 10;
      if (sim._obs && Math.abs(t - sim._obs - 5) < 0.003) sim._obsState = sim.hr[AGV.state];
    },
    expect: (r, sim) => [
      ...logiOk(r), ...noAlarms(r),
      !sim._obs && 'engel denemesi yapılamadı',
      sim._obsState !== 5 && `engel sırasında durum ${AGV_STATES[sim._obsState]} (ENGEL: DURDU bekleniyordu)`,
      r.palletsStored < 2 && `engelden sonra taşıma devam etmedi: ${r.palletsStored}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Depo: AGV çatal arızası → alarm, reset + start sonrası palet yine taşınır',
    seconds: 700, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim); feedPacks(sim);
      if (t > 50 && t < 50.01) sim.faults.agvLiftFault = true;
      if (!sim._liftAt && ((sim.hr[AGV.alarm] >> 6) & 1)) sim._liftAt = t;
      if (sim._liftAt) { press(sim, t, 'reset', sim._liftAt + 5); press(sim, t, 'start', 1, sim._liftAt + 8); }
    },
    expect: (r, sim) => [
      ...logiOk(r), ...noAlarms(r),
      !sim._liftAt && 'çatal arızası alarmı gelmedi',
      r.palletsStored < 2 && `arızadan sonra taşıma devam etmedi: ${r.palletsStored}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Depo: kontur hatası ve okunamayan etiket → depolanmaz, operatör alır, kimliksiz stok yok',
    seconds: 900, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim); feedPacks(sim);
      if (t > 10 && t < 10.01) sim.faults.contourFail = true;
      const rej = (sim.hr[ASRS.alarm] >> 7) & 1;
      if (rej && !sim._rejAt) sim._rejAt = t;
      if (sim._rejAt && Math.abs(t - sim._rejAt - 3) < 0.003) {
        sim.command({ type: 'removeReject' }); sim._rejN = (sim._rejN || 0) + 1;
        if (sim._rejN === 1) sim.faults.labelUnreadable = true;   // ikinci palet: etiket okunamaz
      }
      if (sim._rejAt) { press(sim, t, 'reset', sim._rejAt + 5); press(sim, t, 'start', 1, sim._rejAt + 8); }
      if (sim._rejAt && t > sim._rejAt + 9 && !rej) sim._rejAt = 0;
    },
    expect: (r) => [
      ...logiOk(r), ...noAlarms(r),
      r.palletsRejected !== 2 && `${r.palletsRejected} palet reddedildi (2 bekleniyordu)`,
      r.palletsStored < 1 && 'retten sonra depolama devam etmedi',
    ].filter(Boolean),
  }),
  run({
    name: 'Depo: vinç depolarken koridor kapısı açılır → iş iptal, göz kontrol edilir, envanter uzlaşır',
    seconds: 700, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim); feedPacks(sim);
      const j = sim.asrs.crane.job;
      if (!sim._door && j?.type === 1 && sim.asrs.crane.load && j.i >= 4) { sim._door = t; sim.command({ type: 'aisleDoor', value: true }); }
      if (sim._door && Math.abs(t - sim._door - 5) < 0.003) sim.command({ type: 'aisleDoor', value: false });
      if (sim._door) { press(sim, t, 'reset', sim._door + 7); press(sim, t, 'start', 1, sim._door + 10); }
    },
    expect: (r, sim) => [
      ...logiOk(r), ...noAlarms(r),
      !sim._door && 'kapı vinç taşırken açılamadı',
      r.palletsStored < 2 && `kapıdan sonra depolama devam etmedi: ${r.palletsStored}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Depo: vinç yürüme arızası → alarm, eve dönüş, yarım iş kontrol edilir',
    seconds: 700, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim); feedPacks(sim);
      if (!sim._tf && sim.asrs.inAt(2)) { sim._tf = t; sim.faults.craneTravelFault = true; }
      if (!sim._tfAt && ((sim.hr[ASRS.alarm] >> 2) & 1)) sim._tfAt = t;
      if (sim._tfAt) { press(sim, t, 'reset', sim._tfAt + 3); press(sim, t, 'start', 1, sim._tfAt + 6); }
    },
    expect: (r, sim) => [
      ...logiOk(r), ...noAlarms(r),
      !sim._tfAt && 'yürüme arızası alarmı gelmedi',
      r.palletsStored < 2 && `arızadan sonra depolama devam etmedi: ${r.palletsStored}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Depo: depo PLC\'si yeniden başlar (tablo kaybolur) → envanter sayımı, tablo raftaki paletlerle eşleşir',
    seconds: 900, pollMs: 100, lagMs: 100, plcs: 'bolunmus',
    scenario: (sim, t, plc) => {
      press(sim, t, 'start', 1, ...(sim._restart ? [sim._restart + 2] : [])); keepFed(sim); feedPacks(sim);
      // konveyörde hareket yokken (ara bölgede palet kalmasın)
      if (t > 600 && !sim._restart && sim.asrs.inConv.every((e) => e.target == null) && !sim.asrs.crane.job) {
        sim._restart = t; sim._before = sim.asrs.rack.filter(Boolean).length;
        sim._plcRestart = 'lojistik'; // eski string biçimi: gerçek soğuk PLC açılışı
      }
    },
    expect: (r, sim) => [
      ...logiOk(r), ...noAlarms(r),
      !(sim._before > 0) && 'yeniden başlatmadan önce depoda palet yoktu',
      r.stock !== sim.asrs.rack.filter(Boolean).length && `PLC stoku ${r.stock}, rafta ${sim.asrs.rack.filter(Boolean).length}`,
    ].filter(Boolean),
    probe: { at: 640, check: (sim) => sim.hr[ASRS.state] === 3 || `t=640 s: durum ${ASRS_STATES[sim.hr[ASRS.state]]} (envanter sayımı bekleniyordu)` },
  }),
  run({
    name: 'Depo: AGV bataryası düşer → önce şarja gider, sonra taşımaya devam eder',
    seconds: 700, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim); feedPacks(sim);
      if (t > 150 && t < 150.01) sim.faults.agvBatteryLow = true;
      if (sim.agv.charging && t > 150 && !sim._chg) sim._chg = t;
    },
    expect: (r, sim) => [
      ...logiOk(r), ...noAlarms(r),
      !sim._chg && 'AGV şarja gitmedi',
      r.palletsStored < 2 && `şarjdan sonra taşıma devam etmedi: ${r.palletsStored}`,
    ].filter(Boolean),
  }),
  run({
    name: 'Depo: soğutma arızası → depo sıcaklığı uyarısı',
    seconds: 500, pollMs: 100, lagMs: 100,
    scenario: (sim, t) => { press(sim, t, 'start', 1); sim.faults.coolingFail = t > 10; },
    expect: (r) => [
      !r.asrsAlarms.includes('Uyarı: depo sıcaklığı 6 °C üstünde') && `sıcaklık uyarısı gelmedi: ${r.asrsAlarms}`,
    ].filter(Boolean),
  }),

  // ===================== Aşama 5: izleme katmanı ve üç PLC =====================
  run({
    name: 'İzleme: normal üretim, tek PLC → palet → paket → bardak izlemesi raftaki paletle aynı',
    seconds: 1000, pollMs: 100, lagMs: 100, monitor: true,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); },
    expect: (r, sim, mon) => {
      const m = traceMatchesSim(sim, mon), rec = mon.reconcile(0, mon.lastTs);
      const d = oeeOf(mon, 'dolum'), inf = mon.inferPackCups(sim.trace.run);
      console.log('      izleme:', JSON.stringify({ dolum: fmt(d), palletsChecked: m.n, reconcile: rec.map((x) => x.diff), fifo: inf.rate }));
      return [
        ...logiOk(r),
        m.err, m.n < 1 && 'depoda kontrol edilecek palet yok',
        // PLC'nin sağlam sayacı red istasyonunda (cep 6), olay cepten çıkışta (cep 7): en çok 2 bardak fark
        (rec[0].diff > 0 || rec[0].diff < -2) && `dolum uzlaştırma farkı ${rec[0].diff}`,
        rec.slice(1).some((x) => x.diff) && `uzlaştırma farkı: ${JSON.stringify(rec)}`,
        inf.rate !== 1 && `FIFO çıkarımı kimlikli izlemeyle %${(inf.rate * 100).toFixed(0)} tutuyor`,
        ...mon.oee(0, mon.lastTs).map(timesConsistent),
        !(d.A > 0.9) && `dolum kullanılabilirliği ${d.A}`,
        // OpenPLC v3 gecikmesinde (100 + 100 ms) çevrim ~6 s: hız kaybı performansta görünür
        !(d.P > 0.65 && d.P <= 1) && `dolum performansı ${d.P}`,
        // kaba akış payı öğrenilirken ilk ~5 bardak reddedilir: gerçek kalite kaybı
        !(d.Q > 0.95 && d.reject === r.rejectedBad + r.rejectedGood) && `dolum kalitesi ${d.Q}, red ${d.reject}`,
        oeeOf(mon, 'palet').warnIdeal && 'paletleme ideal çevrimi gerçekleşenden yavaş',
      ].filter(Boolean);
    },
  }),
  run({
    name: 'Üç PLC: normal üretim (100 ms + 100 ms) → PLC\'ler arası kabloyla AGV paleti alır, izleme üç PLC\'yi birleştirir',
    seconds: 1000, pollMs: 100, lagMs: 100, plcs: 'bolunmus', monitor: true,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); },
    expect: (r, sim, mon) => {
      const m = traceMatchesSim(sim, mon), rec = mon.reconcile(0, mon.lastTs);
      return [
        ...logiOk(r), ...noAlarms(r), ...noContamination(r),
        r.palletsStored < 1 && `palet depolanmadı (${r.palletsStored})`,
        m.err,
        rec.slice(1).some((x) => x.diff) && `uzlaştırma farkı: ${JSON.stringify(rec)}`,
        mon.gaps().comm.length > 0 && `beklenmeyen haberleşme boşluğu: ${JSON.stringify(mon.gaps().comm)}`,
      ].filter(Boolean);
    },
  }),
  run({
    name: 'Üç PLC: paketleme PLC\'sinin saha haberleşmesi 120 s kopar → yalnızca shrink ve paletleme düşer, dolum tıkalı bekler',
    seconds: 600, pollMs: 100, lagMs: 100, plcs: 'bolunmus', monitor: true,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1, 278); press(sim, t, 'reset', 275); keepFed(sim);
      sim._plcCommCut = { paketleme: t >= 150 && t < 270 };
      if (t > 230 && t < 230.01) sim._probe = { shrDo: sim.shrink.out, palDo: sim.pallet.out, live: sim.live };
    },
    expect: (r, sim, mon) => {
      const sh = mon.categoryTimes('shrink', 0, mon.lastTs).times, dl = mon.categoryTimes('dolum', 0, mon.lastTs).times;
      const comm = mon.alarmHistory(0, mon.lastTs).filter((a) => a.text === 'Simülatör haberleşmesi kesildi');
      console.log('      izleme:', JSON.stringify({ shrinkAriza: sh.ARIZA / 1000, dolumTikali: dl.TIKALI / 1000,
        comm: comm.map((a) => [a.cell, a.ts_on, a.ts_off]), probe: sim._probe }));
      return [
        ...noContamination(r),
        r.lostCups > 0 && `${r.lostCups} bardak kayboldu`, r.packsBad > 0 && `${r.packsBad} hatalı paket`,
        r.bookkeeping !== 'ok' && `defter: ${r.bookkeeping}`,
        !(sim._probe && sim._probe.live.proses && !sim._probe.live.paketleme && sim._probe.live.lojistik)
          && `bekçi: ${JSON.stringify(sim._probe?.live)}`,
        !(sim._probe?.shrDo === 0 && sim._probe?.palDo === 0) && 'haberleşme kopukken paketleme çıkışları düşmedi',
        !(dl.TIKALI > 10000) && `dolum tıkalı kalmadı (${dl.TIKALI / 1000} s)`,
        !(sh.ARIZA > 100000) && `shrink ARIZA ${sh.ARIZA / 1000} s`,
        !(comm.some((a) => a.cell === 'shrink') && comm.some((a) => a.cell === 'palet')) && 'haberleşme alarmı olayları yok',
        comm.some((a) => a.cell === 'dolum' || a.cell === 'agv') && 'haberleşme alarmı başka PLC\'de de çıktı',
        r.packsGood < 12 && `haberleşme dönünce paketleme devam etmedi (${r.packsGood} paket)`,
      ].filter(Boolean);
    },
  }),
  run({
    name: 'İzleme: ısıtıcı arızası → alarm olayı ve ARIZA süresi tutarlı, kullanılabilirlik düşer',
    seconds: 240, monitor: true,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1, 152);
      sim.faults.heaterFail = t > 60 && t < 140;
      press(sim, t, 'reset', 150);
    },
    expect: (r, sim, mon) => {
      const al = mon.alarmHistory(0, mon.lastTs).filter((a) => a.cell === 'dolum' && a.severity === 'alarm');
      const d = oeeOf(mon, 'dolum');
      const aMs = al[0] ? al[0].ts_off - al[0].ts_on : 0;
      console.log('      izleme:', JSON.stringify({ dolum: fmt(d), alarms: al.map((a) => [a.text, a.ts_on, a.ts_off]) }));
      return [
        !(al.length === 1 && al[0].text === 'Isıtıcı ısınmıyor') && `alarm olayları: ${JSON.stringify(al.map((a) => a.text))}`,
        al[0] && !(al[0].ts_off > 150000 && al[0].ts_off < 151500) && `alarm kapanışı ${al[0].ts_off} ms (reset 150 s)`,
        Math.abs(d.times.ARIZA - aMs) > 1500 && `ARIZA süresi ${d.times.ARIZA} ms, alarm süresi ${aMs} ms`,
        !(d.A < 0.75) && `kullanılabilirlik düşmedi: ${d.A}`,
        timesConsistent(d),
      ].filter(Boolean);
    },
  }),
  run({
    name: 'İzleme: üretim tankı boşalır → dolum "ürün yok" (AÇ), doldurulunca yeni parti izlenir',
    seconds: 500, monitor: true,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim);
      // üretim tankı boşalır; dolum tankında da az ürün kalmıştır (sınamayı kısaltmak için)
      if (t > 100 && !sim._empty) {
        sim._empty = true; sim.command({ type: 'fault', name: 'prodEmpty', value: true });
        sim.dolum.drawMix((sim.dolum.tankKg - 7.5) * 1000); sim.dolum.tankKg = 7.5;
      }
      if (t > 102 && t < 102.01) sim.command({ type: 'fault', name: 'prodEmpty', value: false });
      if (t > 260 && !sim._refill) { sim._refill = true; sim.command({ type: 'refill', name: 'prod' }); }
    },
    expect: (r, sim, mon) => {
      const d = oeeOf(mon, 'dolum');
      const lots = mon.lots().map((l) => l.lot);
      const lot2 = mon.db.prepare(`SELECT COUNT(*) AS n FROM cup_transfer ct JOIN transfer t ON t.run = ct.run
        AND t.transfer = ct.transfer WHERE t.lot = 2`).get().n;
      console.log('      izleme:', JSON.stringify({ dolum: fmt(d), lots, lot2cups: lot2 }));
      return [
        ...noContamination(r),
        !(d.times.AC > 30000) && `dolum AÇ süresi ${d.times.AC / 1000} s`,
        d.losses[0]?.cat !== 'AC' && `en büyük kayıp ${d.losses[0]?.cat}, AÇ olmalıydı`,
        d.losses.find((l) => l.cat === 'AC')?.own !== false && 'AÇ kaybı dış kaynaklı işaretlenmedi',
        !lots.includes(2) && `parti 2 kaydı yok: ${lots}`,
        !(lot2 > 0) && 'parti 2 bardaklara ulaşmadı',
      ].filter(Boolean);
    },
  }),
  run({
    name: 'İzleme: bardak ayırıcı %35 kaçırır → performans düşer, kullanılabilirlik ve kalite etkilenmez',
    seconds: 400, monitor: true,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); sim.faults.dropMiss = t > 60; },
    expect: (r, sim, mon) => {
      const before = oeeOf(mon, 'dolum', 50000, 60000 + 1), after = oeeOf(mon, 'dolum', 120000, 400000);
      console.log('      izleme:', JSON.stringify({ after: fmt(after) }));
      return [
        // Açılışta ısıtıcı da START beklediğinden deterministik besleme fazı değişir;
        // yine en az %15 performans kaybı aranır, kalite ve kullanılabilirlik koşulları aynıdır.
        !(after.P < 0.85) && `performans düşmedi: ${after.P}`,
        !(after.A > 0.95) && `kullanılabilirlik ${after.A}`,
        after.Q !== 1 && `kalite ${after.Q}`,
        before.times.URETIM === 0 && 'karşılaştırma penceresinde üretim yok',
      ].filter(Boolean);
    },
  }),
  run({
    name: 'İzleme: üretim sırasında CIP → CIP kaydı PLC ile aynı, palette CIP öncesi ve sonrası ürün ayrılır, geri çağırma',
    seconds: 1000, pollMs: 100, lagMs: 100, monitor: true,
    scenario: (sim, t) => { press(sim, t, 'start', 1); keepFed(sim); pressTank(sim, t, 'cipStart', 150); },
    expect: (r, sim, mon) => {
      const cips = mon.cips();
      const c = cips[0];
      const stored = sim.asrs.rack.filter(Boolean);
      const first = stored[0] && palletLabel(sim.trace.run, stored[0].id);
      const pc1 = first ? mon.palletCips(first) : [];
      const rc = c ? mon.recall({ cipId: c.cip_id }) : [];
      const label = rc[0]?.label;
      const pc = label ? mon.palletCips(label) : [];
      console.log('      izleme:', JSON.stringify({ cip: c, first: pc1.map((x) => x.cip_id), mixed: pc.map((x) => x.cip_id),
        recall: rc.map((x) => [x.label, x.status, x.cups]) }));
      return [
        ...noContamination(r), ...logiOk(r),
        !(cips.length === 1 && c.result === 1) && `CIP kayıtları: ${JSON.stringify(cips)}`,
        c && (Math.abs(c.min_temp - r.cip.minT) > 0.01 || Math.abs(c.final_cond - r.cip.cond) > 0.01 || c.duration_s !== r.cip.dur)
          && `CIP kaydı PLC'den farklı: DB ${JSON.stringify(c)}, PLC ${JSON.stringify(r.cip)}`,
        !first && 'depoda palet yok',
        // tampon tank ~580 s yettiği için ilk palet tamamen CIP öncesi üründür
        first && pc1.some((x) => x.cip_id != null) && `ilk palette CIP sonrası ürün: ${JSON.stringify(pc1)}`,
        rc.some((x) => x.label === first) && 'geri çağırma CIP öncesi paleti de listeledi',
        // CIP sonrası ürünü taşıyan palet, tampondaki CIP öncesi ürünle karışık: iki dönem birlikte
        !label && 'CIP sonrası ürünü taşıyan palet yok',
        label && !(pc.some((x) => x.cip_id == null) && pc.some((x) => x.cip_id === c?.cip_id))
          && `karışık paletin CIP dönemleri: ${JSON.stringify(pc)}`,
      ].filter(Boolean);
    },
  }),
  run({
    name: 'İzleme: kostik ısıtıcısı arızalı → başarısız CIP kaydı, sonrasında aktarım yok, geri çağırma listesi boş',
    seconds: 600, monitor: true,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim);
      sim.faults.causticHeaterFail = true;
      if (t < 0.01) sim.tank.causticT = 30;
      pressTank(sim, t, 'cipStart', 60);
    },
    expect: (r, sim, mon) => {
      const cips = mon.cips(), c = cips[0];
      const rc = c ? mon.recall({ cipId: c.cip_id }) : null;
      const after = c ? mon.db.prepare('SELECT COUNT(*) AS n FROM transfer_cip WHERE last_cip = ?').get(c.cip_id).n : -1;
      return [
        ...noContamination(r),
        !(c && c.result === 3) && `CIP kaydı: ${JSON.stringify(cips)}`,
        after !== 0 && `başarısız CIP'ten sonra ${after} aktarım`,
        rc && rc.length !== 0 && `geri çağırma listesi boş değil: ${JSON.stringify(rc)}`,
      ].filter(Boolean);
    },
  }),
  run({
    name: 'İzleme: alarm Pareto\'su (2 × sıkışma, 1 × kapama kafası) → sıra ve süreler doğru',
    seconds: 260, monitor: true,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1, 77, 137, 197); keepFed(sim);
      sim.faults.jam = (t > 60 && t < 70) || (t > 120 && t < 130);
      sim.faults.sealerStuck = t > 180 && t < 190;
      press(sim, t, 'reset', 75, 135, 195);
    },
    expect: (r, sim, mon) => {
      const p = mon.pareto(0, mon.lastTs);
      console.log('      izleme:', JSON.stringify(p.map((x) => [x.text, x.n, Math.round(x.ms / 1000)])));
      const jam = p.find((x) => x.text === 'Endeksleyici sıkıştı'), seal = p.find((x) => x.text === 'Kapama kafası hareket etmedi');
      return [
        !(p[0]?.text === 'Endeksleyici sıkıştı' && p[0].n === 2) && `Pareto ilk sırası: ${JSON.stringify(p[0])}`,
        !(seal && seal.n === 1) && `kapama kafası alarmı: ${JSON.stringify(seal)}`,
        jam && !(jam.ms > 2 * 4000 && jam.ms < 2 * 14000) && `sıkışma alarmı toplam ${jam.ms} ms`,
        Math.abs(p[p.length - 1].cum - 1) > 1e-9 && 'Pareto birikimli oranı 1 değil',
      ].filter(Boolean);
    },
  }),
  run({
    name: 'İzleme: olay akışı 200 s okunmaz, tampon taşar → ingest_gap; tekrar oynatma kopya üretmez',
    seconds: 400, monitor: true,
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim);
      if (t < 0.01) sim.trace.cap = 40;
      sim._monEventsPaused = t > 100 && t < 300;
    },
    expect: (r, sim, mon) => {
      const g = mon.gaps().ingest;
      const n0 = mon.db.prepare('SELECT COUNT(*) AS n FROM cup').get().n;
      // en az bir kez teslim: imleci geri al, aynı olayları yeniden işle
      mon.db.prepare('UPDATE ingest SET last_seq = last_seq - 30').run();
      mon.events(sim.trace.since(mon.ingest.cursor.last_seq, 2000));
      const n1 = mon.db.prepare('SELECT COUNT(*) AS n FROM cup').get().n;
      return [
        g.length !== 1 && `ingest_gap kayıtları: ${JSON.stringify(g)}`,
        n1 !== n0 && `tekrar oynatma kopya üretti: ${n0} → ${n1}`,
        mon.ingest.cursor.last_seq !== sim.trace.seq && 'imleç olay akışına yetişmedi',
      ].filter(Boolean);
    },
  }),
  run({
    name: 'İzleme: izleme servisi proses PLC\'sine 60 s ulaşamaz → VERI_YOK, OEE paydasından düşülür',
    seconds: 300, monitor: true, plcs: 'bolunmus',
    scenario: (sim, t) => {
      press(sim, t, 'start', 1); keepFed(sim);
      sim._monBlind = { proses: t > 100 && t < 160 };
    },
    expect: (r, sim, mon) => {
      const d = oeeOf(mon, 'dolum'), sh = oeeOf(mon, 'shrink');
      return [
        Math.abs(d.times.VERI_YOK - 60000) > 600 && `dolum VERI_YOK ${d.times.VERI_YOK} ms`,
        sh.times.VERI_YOK > 300 && `shrink VERI_YOK ${sh.times.VERI_YOK} ms`,
        Math.abs(d.planned - (d.span - d.times.VERI_YOK)) > 1 && 'planlı süre VERI_YOK düşülmeden hesaplandı',
        r.shippedGood < 40 && 'PLC çalışmaya devam etmedi (yalnızca izleme kör olmalıydı)',
      ].filter(Boolean);
    },
  }),
];

// FAZ6: real restart (new Fabrika), at most one-second-old retained image.
for (const plcs of ['bolunmus', 'tek']) results.push(run({
  name: `FAZ6: ${plcs} üretimde kalıcı bellekle açılış → START, tamamlanan palet depoda`,
  seconds: 1150, pollMs: 100, lagMs: 100, plcs, monitor: true,
  scenario: (sim, t, plc) => {
    keepFed(sim);
    const role = plcs === 'tek' ? 'tek' : 'paketleme';
    // Single PLC also loses the filler tracking; choose the completed station cycle boundary.
    if (!sim._bootAt && t > 160 && plc.PALLET.COUNT >= 2 && plc.PALLET.R_STP === 0
        && (plcs !== 'tek' || plc.DOLUM.CYC === 0)) {
      sim._bootAt = t; sim._plcRestart = { role, retain: true };
    }
    const b = sim._bootAt;
    press(sim, t, 'start', 1, ...(b ? [b + 2] : []));
    if (b && t > b + 0.8 && t < b + 1.8) {
      sim._stopped = (sim._stopped ?? true) && sim.hr[SHR.do] === 0 && (sim.hr[PAL.do] & ~3) === 0 && (sim.hr[PAL.do] & 2) !== 0
        && (sim.hr[addr('shrink', 3)] & 0x80) !== 0 && plc.SHRINK.MODE === 0;
    }
    if (plcs === 'tek' && b) pressTank(sim, t, 'cipStart', b + 3);
  },
  expect: (r, sim, mon) => [
    ...logiOk(r), ...noAlarms(r), ...noContamination(r),
    !sim._bootAt && 'yeniden başlama tetiklenmedi', !sim._stopped && 'START öncesi çıkış veya durum biti hatalı',
    r.lostCups !== 0 && 'gruplamada bardak kaybı', r.palletsStored < 1 && 'yeniden başlamadan sonra palet depolanmadı',
    mon.categoryTimes('shrink', 0, mon.lastTs).times.HAZIRLIK < 1000 && 'açılış hazırlık olarak izlenmedi',
  ].filter(Boolean),
}));

for (const row of [0, 1]) for (const phase of [0.15, 0.5, 0.85]) results.push(run({
  name: `FAZ6: sıra ${row + 1} itilirken açılış, strok ${phase} → sensörden devam`,
  seconds: 300, pollMs: 100, lagMs: 100, plcs: 'bolunmus',
  scenario: (sim, t, plc) => {
    keepFed(sim);
    const pushing = plc.SHRINK.G_STP === 12 || plc.SHRINK.G_STP === 13;
    if (pushing && !sim._inPush) sim._pushRows = sim.shrink.plate.rows.length;
    sim._inPush = pushing;
    if (!sim._bootAt && pushing && sim._pushRows === row && sim.shrink.rowP >= phase) {
      sim._bootAt = t; sim._plcRestart = { role: 'paketleme', retain: true };
    }
    press(sim, t, 'start', 1, ...(sim._bootAt ? [sim._bootAt + 2] : []));
  },
  expect: (r, sim) => [
    ...palOk(r), !sim._bootAt && 'strokta yeniden başlama olmadı',
    r.lostCups !== 0 && `${r.lostCups} bardak kayboldu`, r.packsGood < 3 && 'gruplama devam etmedi',
    r.shrinkAlarms.some(a => !a.startsWith('Uyarı')) && `shrink alarmı: ${r.shrinkAlarms}`,
  ].filter(Boolean),
}));

results.push(run({
  name: 'FAZ6: soğuk paketleme açılışı → defter bilinmiyor, RESET ve START robotu başlatmaz',
  seconds: 430, pollMs: 100, lagMs: 100, plcs: 'bolunmus',
  scenario: (sim, t, plc) => {
    keepFed(sim);
    if (!sim._bootAt && plc.PALLET.COUNT >= 2 && plc.PALLET.R_STP === 0 && sim.shrink.plate.rows.length === 1) {
      sim._bootAt = t; sim._plcRestart = { role: 'paketleme', retain: false };
      sim._beforeIn = sim.shrink.inCnt;
    }
    const b = sim._bootAt;
    press(sim, t, 'start', 1, ...(b ? [b + 2, b + 5] : []));
    press(sim, t, 'reset', ...(b ? [b + 4] : []));
    if (b && t > b + 1 && sim._ackAfterBoot == null) sim._ackAfterBoot = sim.pallet.rob.ackSeq;
    if (b && t > b + 6) sim._locked = (sim._locked ?? true)
      && sim.pallet.rob.ackSeq === sim._ackAfterBoot && sim.hr[addr('palet', 1)] === 0 && !plc.PALLET.BOOK_OK;
  },
  expect: (r, sim) => [
    ...palOk(r), !sim._bootAt && 'soğuk açılış tetiklenmedi', !sim._locked && 'bilinmeyen defterde robot işi verildi',
    !r.palAlarms.includes('Palet defteri bilinmiyor') && 'bilinmeyen defter alarmı yok',
    r.lostCups !== 0 && 'soğuk açılışta gruplama bardak kaybetti',
    !(sim.shrink.inCnt > sim._beforeIn) && 'soğuk açılışta gruplama sensörden devam etmedi',
  ].filter(Boolean),
}));

for (const job of [2, 3]) results.push(run({
  name: `FAZ6: kalıcı defter bir ${job === 2 ? 'koyma' : 'karton'} işi bayat → robot kaydıyla uzlaştır`,
  seconds: 520, pollMs: 100, lagMs: 100, plcs: 'bolunmus',
  scenario: (sim, t, plc) => {
    feedPacks(sim); keepFed(sim);
    const r = sim.pallet.rob, saved = sim._retImages?.paketleme;
    const next = saved?.PAL_LAST_SEQ >= 30000 ? 1 : (saved?.PAL_LAST_SEQ ?? 0) + 1;
    // Freeze the predecessor while the target job is in flight, before its result.
    if (!sim._frozenAt && t > 3 && r.job?.type === job
        && saved?.PAL_ACTIVE === 1 && saved.PAL_LAST_SEQ === r.resSeq
        && (job !== 2 || plc.PALLET.SLOT >= 2)) {
      sim._retFreeze = 'paketleme'; sim._frozenAt = t; sim._frozenImage = structuredClone(saved);
    }
    if (sim._frozenAt && !sim._bootAt && !r.job && r.resJob === job && r.resCode === 1 && r.resSeq === next) {
      sim._bootAt = t; sim._expectedCount = job === 2 ? r.resSlot : saved.PAL_COUNT;
      sim._robotRecord = [r.ackSeq, r.resSeq, r.resCode, r.resSlot, r.resJob];
      sim._plcRestart = { role: 'paketleme', retain: true };
    }
    const b = sim._bootAt;
    press(sim, t, 'start', 1, ...(b ? [b + 2] : []));
    if (b && t > b + 0.8 && t < b + 1.8) {
      sim._reconciled = plc.PALLET.BOOK_OK && plc.PALLET.COUNT === sim._expectedCount && (job !== 3 || plc.PALLET.SHEET_BOT);
      sim._recordPreserved = JSON.stringify(sim._robotRecord) === JSON.stringify([r.ackSeq, r.resSeq, r.resCode, r.resSlot, r.resJob]);
      sim._imageFrozen = JSON.stringify(saved) === JSON.stringify(sim._frozenImage);
    }
    if (b && t > b + 1.8) sim._retFreeze = null;
  },
  expect: (r, sim) => [
    ...logiOk(r), ...noAlarms(r), !sim._bootAt && 'bir iş bayat görüntü yakalanamadı',
    !sim._reconciled && 'bayat kayıt doğru uzlaştırılmadı', r.palletsStored < 1 && 'palet tamamlanıp depolanmadı',
    !sim._imageFrozen && 'disk kopyası olay anında dondurulmadı', !sim._recordPreserved && 'PLC restart robot kaydını değiştirdi',
  ].filter(Boolean),
}));

for (const retain of [true, false]) results.push(run({
  name: `FAZ6: tank CIP ortasında ${retain ? 'kalıcı' : 'soğuk'} açılış → iptal, yeni CIP olmadan aktarım yok`,
  seconds: 470, pollMs: 100, lagMs: 100, plcs: 'bolunmus',
  scenario: (sim, t, plc) => {
    keepFed(sim);
    if (!sim._bootAt && plc.TANK.STP === 43 && plc.TANK.T.HOLD.ET > 2000) {
      sim._bootAt = t; sim._plcRestart = { role: 'proses', retain };
    }
    const b = sim._bootAt;
    press(sim, t, 'start', 1, ...(b ? [b + 2] : []));
    pressTank(sim, t, 'cipStart', 50, ...(b ? [b + 45] : []));
    if (b && t > b + 1 && t < b + 44) {
      sim._hygieneHeld = (sim._hygieneHeld ?? true) && plc.TANK.CIP_DUE && plc.TANK.CIP_RES === 2
        && (sim.hr[addr('tank', 0)] & 0x11) === 0;
    }
    if (b && t > b + 0.8 && t < b + 1.8) sim._tankStopped = sim.hr[addr('tank', 0)] === 0 && plc.TANK.MODE === 0;
  },
  expect: (r, sim) => [
    !sim._bootAt && 'CIP sırasında yeniden başlama olmadı', !sim._tankStopped && 'tank START öncesi çıkış verdi',
    !sim._hygieneHeld && 'yeni CIP öncesinde aktarım kilidi açıldı', r.cipRes !== 1 && 'yeni CIP tamamlanmadı',
    r.causticToProductKg !== 0 && 'ürüne kostik geçti', r.hygieneRiskKg !== 0 && 'kirli hattan ürün geçti',
  ].filter(Boolean),
}));

results.push(run({
  name: 'FAZ6: dolum kör cebindeki takipsiz bardak → açılıştan sonra fiziksel red sensörüyle atılır',
  seconds: 120, pollMs: 100, lagMs: 100, plcs: 'bolunmus',
  scenario: (sim, t) => {
    sim.dolum.cupMag = 0;
    if (t > 3 && !sim._bootAt) {
      sim._bootAt = t;
      sim.dolum.pockets[3] = { id: 900001, product: 100, foil: false, sealT: 0, sealed: false,
        burnt: false, damaged: false, overfill: false, fall: 1 };
      sim._plcRestart = { role: 'proses', retain: false };
    }
    press(sim, t, 'start', 1, ...(sim._bootAt ? [sim._bootAt + 2] : []));
  },
  expect: r => [r.shippedBad !== 0 && 'takipsiz bardak sevk edildi',
    r.rejectedBad !== 1 && 'kör cepteki bardak red edilmedi', r.lostCups !== 0 && 'bardak kayboldu'].filter(Boolean),
}));

results.push(run({
  name: 'FAZ6: lojistik PLC çatalda yük varken açılır → boş göz ölçülür, yük depolanır',
  seconds: 700, pollMs: 100, lagMs: 100, plcs: 'bolunmus',
  scenario: (sim, t) => {
    keepFed(sim); feedPacks(sim);
    if (!sim._bootAt && sim.asrs.crane.load && sim.asrs.crane.job?.type === 1) {
      sim._bootAt = t; sim._loadId = sim.asrs.crane.load.id;
      sim._plcRestart = { role: 'lojistik', retain: true };
    }
    press(sim, t, 'start', 1, ...(sim._bootAt ? [sim._bootAt + 2] : []));
  },
  expect: (r, sim) => [...logiOk(r), ...noAlarms(r), !sim._bootAt && 'yüklü açılış tetiklenmedi',
    !sim.asrs.rack.some(p => p?.id === sim._loadId) && 'çataldaki palet boş göze konamadı'].filter(Boolean),
}));

results.push(run({
  name: 'FAZ6 ikinci tur: shrink sarma sürerken gerçek PLC açılışı → paket tamamlanır',
  seconds: 350, pollMs: 100, lagMs: 100, plcs: 'bolunmus',
  scenario: (sim, t, plc) => {
    keepFed(sim);
    if (!sim._bootAt && sim.shrink.wrapper.busy > 0.3 && sim.shrink.wrapper.busy < 1.8
        && plc.PALLET.R_STP === 0 && !sim.pallet.rob.job && !sim.pallet.rob.part) {
      sim._bootAt = t; sim._wrapPack = sim.shrink.wrapper.pack;
      sim._plcRestart = { role: 'paketleme', retain: true };
    }
    press(sim, t, 'start', 1, ...(sim._bootAt ? [sim._bootAt + 2] : []));
  },
  expect: (r, sim) => [...logiOk(r), ...noAlarms(r), !sim._bootAt && 'sarma ortasında açılış olmadı',
    !sim._wrapPack?.wrapped && 'kesilen sarma tamamlanmadı', sim.shrink.wrapper.pack === sim._wrapPack && 'paket sarma içinde kaldı',
    r.lostCups !== 0 && 'bardak kaybı', r.packsBad !== 0 && 'hatalı paket'].filter(Boolean),
}));

for (const moment of ['B21', 'C_DONE']) results.push(run({
  name: `FAZ6 ikinci tur: ${moment} açılışı → aynı palet ikinci kez sarılmaz`,
  seconds: 370, pollMs: 100, lagMs: 100, plcs: 'bolunmus',
  scenario: (sim, t, plc) => {
    if (t < 0.01) sim.pallet.palletMag = 1;
    feedPacks(sim); keepFed(sim);
    const saved = sim._retImages?.paketleme;
    if (moment === 'C_DONE' && !sim._frozenAt && plc.PALLET.C_STP === 1
        && sim.pallet.wrap.turns > 8 && saved?.PAL_C_PHASE === 1) {
      sim._retFreeze = 'paketleme'; sim._frozenAt = t;
    }
    const pc = sim.pallet.palletAt(2);
    const ready = moment === 'B21' ? plc.PALLET.B_STP === 21 && pc
      : sim._frozenAt && pc?.wrapped && sim.pallet.wrap.turns === 9;
    if (!sim._bootAt && ready && !sim.pallet.rob.job && !sim.pallet.rob.part) {
      sim._bootAt = t; sim._wrappedPallet = pc;
      sim._plcRestart = { role: 'paketleme', retain: true };
    }
    const b = sim._bootAt;
    press(sim, t, 'start', 1, ...(b ? [b + 2] : []));
    if (b && t > b + 1.8) sim._retFreeze = null;
    if (b && t > b + 4) sim._wrapCountOK = plc.PALLET.WRAPPED === 1 && plc.PALLET.DONE_CNT === 1;
  },
  expect: (r, sim) => [...logiOk(r), ...noAlarms(r), !sim._bootAt && `${moment} açılışı olmadı`,
    !sim._wrapCountOK && 'DONE/WRAPPED bir kez sayılmadı',
    !sim._wrappedPallet?.wrapped && 'palet sarılmadı', Math.abs((sim._wrappedPallet?.turns ?? 0) - 9) > 0.01 && 'aynı palet tekrar sarıldı',
    r.palletsStored !== 1 && 'tek palet depolanmadı'].filter(Boolean),
}));

// FAZ6 third round: keep the field controller alive while replacing the PLC.
// Every case waits six seconds under HOLD, longer than the former boot timeout.
for (const plcs of ['tek', 'bolunmus']) for (const [name, type, slot] of [
  ['alma', 1, null], ['koyma', 2, null], ['alt levha', 3, 0], ['üst levha', 3, 1], ['eve dönüş', 4, 0],
]) results.push(run({
  name: `FAZ6 üçüncü tur: ${plcs}, ${name} ortasında kalıcı açılış → aynı iş tamamlanır, palet depoda`,
  seconds: 520, pollMs: 100, lagMs: 100, plcs,
  scenario: (sim, t, plc) => {
    if (t < 0.01) sim.pallet.palletMag = 1;
    keepFed(sim); feedPacks(sim);
    const r = sim.pallet.rob, p = plc.PALLET;
    const role = plcs === 'tek' ? 'tek' : 'paketleme';
    const saved = sim._retImages?.[role];
    // Arrange a real controller HOME job away from home on a known B pallet.
    if (type === 4 && !sim._homeRequested && t > 40 && !r.job && p.B_STP === 10) {
      sim._homeRequested = true; r.homed = false; r.tcp.x += 4;
    }
    const j = r.job;
    const middle = type === 4 ? j?.t > 0.2 * j?.dur && j?.t < 0.5 * j?.dur
      : type === 1 ? r.part && j?.i === 3
      : j?.i >= (type === 2 ? 1 : 3) && !j?.released;
    if (!sim._bootAt && j?.type === type && (slot == null || j.slot === slot) && middle
        && saved?.PAL_ACTIVE === 1 && saved.PAL_LAST_SEQ === r.resSeq) {
      sim._bootAt = t; sim._acceptedJob = j; sim._acceptedSeq = r.ackSeq;
      sim._targetPallet = sim.pallet.palletAt(1);
      sim._expectedCount = saved.PAL_COUNT + (type === 2 ? 1 : 0);
      sim._plcRestart = { role, retain: true };
    }
    const b = sim._bootAt;
    press(sim, t, 'start', 1, ...(b ? [b + 6] : []));
    if (b && t > b + 0.8 && t < b + 5.8) {
      const position = JSON.stringify(r.tcp);
      sim._heldPosition ??= position;
      sim._held = (sim._held ?? true) && sim._heldPosition === position && r.job === sim._acceptedJob
        && p.BOOK_OK && p.RECOVERING && p.MODE === 0 && p.COUNT === saved.PAL_COUNT
        && sim.hr[SHR.do] === 0 && (sim.hr[PAL.do] & ~3) === 0 && (sim.hr[PAL.do] & 2) !== 0
        && (sim.hr[addr('palet', 6)] & 0x80) !== 0;
    }
    if (b && t > b + 6 && p.LAST_SEQ === sim._acceptedSeq && !p.RECOVERING && !sim._checkedTerminal) {
      sim._checkedTerminal = true;
      sim._terminalOK = p.BOOK_OK && p.COUNT === sim._expectedCount
        && r.resSeq === sim._acceptedSeq && r.resJob === type && r.resSlot === sim._acceptedJob.slot && r.resCode === 1
        && (type !== 3 || (slot === 0 ? p.SHEET_BOT : p.SHEET_TOP));
    }
  },
  expect: (r, sim) => {
    const target = sim._targetPallet;
    return [...logiOk(r), ...noAlarms(r), !sim._bootAt && 'iş ortasında yeniden başlama olmadı',
      !sim._held && 'START öncesi robot işi/konumu veya HOLD korunmadı',
      !sim._terminalOK && 'aynı işin terminal kaydı doğru uzlaştırılmadı',
      !target || target.slots.filter(Boolean).length !== 18 || !target.sheetBottom || !target.sheetTop || !target.wrapped
        ? 'kesilen palet 18 paket ve iki levhayla tamamlanmadı' : false,
      !sim.asrs.rack.some(p => p?.id === target?.id) && 'kesilen palet depolanmadı',
      r.lostCups !== 0 && 'bardak kaybı', r.packsDropped !== 0 && 'paket kaybı',
    ].filter(Boolean);
  },
}));

for (const idle of ['alma terminali', 'güç kesilince iptal']) results.push(run({
  name: `FAZ6 üçüncü tur: ${idle}, ACK=RES ve R_PART → START sonrası koyma ve depolama`,
  seconds: 520, pollMs: 100, lagMs: 100, plcs: 'bolunmus',
  scenario: (sim, t, plc) => {
    if (t < 0.01) sim.pallet.palletMag = 1;
    keepFed(sim); feedPacks(sim);
    const r = sim.pallet.rob;
    if (!sim._bootAt && t > 15 && r.part && !r.part.sheet && (idle === 'alma terminali' ? !r.job : r.job?.type === 2 && !r.job.released)) {
      sim._bootAt = t; sim._targetPallet = sim.pallet.palletAt(1);
      sim._plcRestart = { role: 'paketleme', retain: true };
      // A service restart can briefly remove ENABLE. Use the real field
      // controller's power-loss path; never fabricate its terminal record.
      if (idle === 'güç kesilince iptal') { sim.pallet.out = 0; sim.pallet.stepRobot(0.005); }
      sim._idleRecord = [r.ackSeq, r.resSeq, r.resJob, r.resCode, r.resSlot];
    }
    const b = sim._bootAt;
    press(sim, t, 'start', 1, ...(b ? [b + 6] : []));
    if (b && t > b + 0.8 && t < b + 5.8) sim._held = (sim._held ?? true)
      && plc.PALLET.BOOK_OK && !plc.PALLET.RECOVERING && !!r.part && !r.job
      && r.ackSeq === r.resSeq && JSON.stringify(sim._idleRecord) === JSON.stringify([r.ackSeq, r.resSeq, r.resJob, r.resCode, r.resSlot])
      && (sim.hr[PAL.do] & 2) !== 0;
    if (b && t > b + 6 && r.job?.type === 2) sim._placedNext = true;
  },
  expect: (r, sim) => [...logiOk(r), ...noAlarms(r), !sim._bootAt && 'yüklü işsiz açılış tetiklenmedi',
    !sim._held && 'START öncesi terminal kayıt/HOLD korunmadı', !sim._placedNext && 'koyma dalı çalışmadı',
    !sim.asrs.rack.some(p => p?.id === sim._targetPallet?.id && p.slots.filter(Boolean).length === 18) && 'palet tamamlanıp depolanmadı',
    r.lostCups !== 0 && 'bardak kaybı', r.packsDropped !== 0 && 'paket kaybı',
  ].filter(Boolean),
}));

results.push(run({
  name: 'FAZ6 üçüncü tur: restart.mjs JS eşdeğeri, paketleme 150/290 s yeniden başlar',
  seconds: 520, pollMs: 100, lagMs: 100, plcs: 'bolunmus', monitor: true,
  scenario: (sim, t, plc) => {
    keepFed(sim);
    if (t > 30 && t < 460) feedPacks(sim, 8);
    sim._restartChecks ??= [];
    for (const at of [150, 290]) if (t >= at && !sim._restartChecks.some(c => c.at === at)) {
      const s = sim.shrink;
      sim._restartChecks.push({ at, held: true, before: plc.PALLET.DONE_CNT,
        exposed: [...s.plate.rows.flat(), ...(s.wrapper.pack?.cups ?? []),
          ...s.belt.filter(b => b.s <= 1.2).flatMap(b => b.pack.cups)].map(c => c.id) });
      sim._plcRestart = { role: 'paketleme', retain: true };
    }
    press(sim, t, 'reset', 2.5);
    press(sim, t, 'start', 4.6, 156, 296);
    for (const c of sim._restartChecks) {
      if (t > c.at + 0.8 && t < c.at + 5.8) c.held &&= sim.hr[SHR.do] === 0 && (sim.hr[PAL.do] & ~3) === 0
        && (sim.hr[PAL.do] & 2) !== 0 && plc.PALLET.WAIT_START && plc.PALLET.BOOK_OK;
      if (t > c.at + 6 && t < c.at + 140 && plc.PALLET.DONE_CNT > c.before) c.progress = true;
    }
  },
  expect: (r, sim) => [...logiOk(r), ...noAlarms(r),
    sim._restartChecks?.length !== 2 && 'iki yeniden başlama gerçekleşmedi',
    sim._restartChecks?.some(c => !c.held) && 'START öncesi çıkış/HOLD hatası',
    sim._restartChecks?.some(c => !c.progress) && 'START sonrası palet tamamlanmadı',
    r.palletsStored < 2 && 'yeniden başlama sonrası paletler depolanmadı',
    r.packsRejected < 1 && 'kesilen ürün için red kaydı yok',
    sim._restartChecks?.some(c => c.exposed.some(id => !sim.shrink.rejected.some(p => p.cups.some(cup => cup.id === id))))
      && 'yeniden başlama anındaki ürün karantinaya gitmedi',
    r.lostCups !== 0 && 'bardak kaybı', r.packsDropped !== 0 && 'paket kaybı',
  ].filter(Boolean),
}));

// Every cup which left the filler is still in one physical location, including quarantine.
function downstreamCups(sim) {
  const s = sim.shrink, a = sim.asrs;
  const pallets = [...sim.pallet.pallets, sim.agv.load, ...a.inConv.map(e => e.p),
    ...a.outConv.map(e => e.p), a.crane.load, ...a.rack].filter(Boolean);
  const packs = [s.wrapper.pack, ...s.belt.map(b => b.pack), ...s.rejected, sim.pallet.rob.part,
    ...pallets.flatMap(p => p.slots)].filter(p => p?.cups && !p.test);
  return [...sim.outfeed.cups, ...s.lane.map(l => l.cup), ...s.plate.rows.flat(), ...packs.flatMap(p => p.cups)];
}

for (const plcs of ['tek', 'bolunmus']) for (const phase of ['tunnel', 'wrapper', 'plate1', 'entry']) results.push(run({
  name: `FAZ6 dördüncü tur: ${plcs} ${phase} kesintisi → karantina, doğru defter/envanter`,
  seconds: 620, pollMs: 100, lagMs: 100, plcs, monitor: true,
  scenario: (sim, t, plc) => {
    keepFed(sim);
    const s = sim.shrink;
    const target = phase === 'tunnel' ? s.belt.some(b => b.s > 0.2 && b.s < 0.8)
      : phase === 'wrapper' ? s.wrapper.busy > 0.3 && s.wrapper.busy < 1.8
      : phase === 'plate1' ? s.plate.rows.length === 1 && s.rowP < 0.03
      : s.belt.some(b => b.s < 0.04);
    if (!sim._bootAt && target) {
      sim._bootAt = t;
      sim._exposedCups = [...s.plate.rows.flat(), ...(s.wrapper.pack?.cups ?? []),
        ...s.belt.filter(b => b.s <= 1.2).flatMap(b => b.pack.cups)].map(c => c.id);
      sim._exposedPacks = s.belt.filter(b => b.s <= 1.2).length + (s.wrapper.pack ? 1 : 0) + (s.plate.rows.length ? 1 : 0);
      sim._plcRestart = { role: plcs === 'tek' ? 'tek' : 'paketleme', retain: true };
    }
    const boot = sim._bootAt;
    // Lose all session flags once again while the interrupted batch is held.
    if (boot && t > boot + 2 && !sim._again) {
      sim._again = true;
      sim._plcRestart = { role: plcs === 'tek' ? 'tek' : 'paketleme', retain: true };
    }
    press(sim, t, 'start', 1, ...(boot ? [boot + 8] : []));
    if (boot && t > boot + 3 && t < boot + 7) sim._held = (sim._held ?? true)
      && sim.hr[SHR.do] === 0 && plc.SHRINK.QUARANTINE;
    if (plcs === 'tek' && boot) pressTank(sim, t, 'cipStart', boot + 9);
    if (boot && t > boot + 40 && t < 500) feedPacks(sim, 8);
  },
  expect: (r, sim, mon) => {
    const red = sim.shrink.rejected, ids = red.flatMap(p => p.cups.map(c => c.id));
    const dbRed = mon.db.prepare('SELECT * FROM pack WHERE ts_rejected IS NOT NULL').all();
    const cups = downstreamCups(sim);
    const rec = mon.reconcile(0, mon.lastTs).find(row => row.what === 'Shrink: karantina red');
    return [...logiOk(r), ...noAlarms(r), ...noContamination(r),
      !sim._bootAt && 'kesinti gerçekleşmedi', !sim._again && 'ikinci açılış olmadı', !sim._held && 'START öncesi karantina/çıkış kilidi yok',
      sim._exposedCups?.some(id => !ids.includes(id)) && 'kesintiye uğrayan bardak karantinada değil',
      r.packsRejected !== sim._exposedPacks && `red ${r.packsRejected}, kesilen ${sim._exposedPacks}`,
      r.cupsQuarantined !== ids.length && 'karantina bardak KPI tutarsız',
      cups.length !== r.shippedGood + r.shippedBad && `bardak bilançosu ${cups.length}/${r.shippedGood + r.shippedBad}`,
      new Set(cups.map(c => c.id)).size !== cups.length && 'aynı bardak iki fiziksel konumda',
      r.lostCups !== 0 && 'bardak kaybı', r.packsDropped !== 0 && 'paket düşmesi',
      r.palletsStored < 1 && 'iyi palet tamamlanıp depolanmadı',
      dbRed.length !== red.length && 'izleme red adedi yanlış',
      dbRed.some(p => p.pallet != null || p.ts_placed != null || p.ts_passed != null) && 'reddedilen paket iyi akışta',
      rec?.diff !== 0 && 'PLC red sayacı ve olay izlemesi uzlaşmadı',
      traceMatchesSim(sim, mon).err,
    ].filter(Boolean);
  },
}));

const ok = results.every(Boolean);
console.log(ok ? '\nTüm senaryolar geçti.' : '\nBazı senaryolar başarısız.');
process.exit(ok ? 0 : 1);
