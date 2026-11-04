import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Fabrika } from '../plc/fabrika.js';
import { FB_Pallet } from '../plc/fb_pallet.js';
import { FB_Shrink } from '../plc/fb_shrink.js';
import { PAL_CHECK_FIELDS, palletChecksum } from '../plc/retain.js';
import { Factory } from '../server/factory.js';
import { PG } from '../public/palletgeo.js';
import { Monitor } from '../monitor/monitor.js';
import { MAP_VERSION, tagAddr } from '../public/iomap.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`OK   FAZ6 birim: ${name}`); };
const ledger = (extra = {}) => {
  const ret = { RET_MAGIC: 0xa55a, RET_MAPVER: MAP_VERSION, PAL_COUNT: 3, PAL_ID: 1,
    PAL_DONE: 0, PAL_WRAPPED: 0, PAL_SHEETS: 1, PAL_LAST_SEQ: 8, PAL_ACTIVE: 1, PAL_C_PHASE: 0, PAL_UNDERWRAP: 0, ...extra };
  return { ...ret, RET_CHECK: palletChecksum(ret) };
};
const robot = (extra = {}) => ({ RESTART: true, START: false, STOP_OK: true, ESTOP_OK: true, RESET: false,
  IO_READY: true, COMM_FAULT: false, IW_DI: 0x08a4, IW_ROB_DI: 0x0210, IW_ACK_SEQ: 8, IW_RES_SEQ: 8,
  IW_RES_JOB: 2, IW_RES_CODE: 1, IW_RES_SLOT: 3, IW_TURNS: 0, IW_PALLETS: 10, AGV_CLEAR: true, ...extra });

check('harita 7; karantina giriş/çıkışları boş ofsetlerde', () => {
  assert.equal(MAP_VERSION, 7); assert.equal(tagAddr('SHR_IW_PLATE'), 56); assert.equal(tagAddr('PAL_IW_RES_JOB'), 75);
  assert.equal(tagAddr('SHR_IW_DIVERT'), 57); assert.equal(tagAddr('SHR_IW_REJECT_CNT'), 58);
  assert.equal(tagAddr('SHR_QW_REJECT'), 55); assert.equal(tagAddr('SHR_QW_GOOD'), 56);
});
check('üretilen ST ASCII; role göre benzersiz program %MW adresleri', () => {
  for (const file of ['fabrika', 'proses', 'paketleme', 'lojistik']) {
    const st = fs.readFileSync(`plc/build/${file}.st`, 'utf8');
    assert(!/[^\x00-\x7f]/.test(st));
    const mw = [...st.matchAll(/(\w+) AT %MW(\d+) : (\w+)/g)];
    assert.equal(new Set(mw.map(m => m[2])).size, mw.length);
    assert.equal(mw.length, { fabrika: 13, proses: 1, paketleme: 12, lojistik: 0 }[file]);
    if (file === 'fabrika' || file === 'paketleme') {
      for (const field of ['RET_MAGIC', 'RET_MAPVER', 'PAL_COUNT', 'PAL_ID', 'PAL_DONE', 'PAL_WRAPPED', 'PAL_SHEETS', 'PAL_LAST_SEQ'])
        assert(mw.some(m => m[1] === field), `${file}: ${field}`);
      assert.equal(mw.find(m => m[1] === 'PAL_SHEETS')[3], 'WORD');
      assert.match(st, /SHR_IW_PLATE\s+AT %IW\d+ : WORD/);
      assert.match(st, /SHR_IW_DIVERT\s+AT %IW\d+ : WORD/);
    }
  }
  for (const f of fs.readdirSync('plc/src').filter(f => f.endsWith('.st')))
    assert(!/[^\x00-\x7f]/.test(fs.readFileSync(`plc/src/${f}`, 'utf8')), f);
});

for (const role of ['tek', 'proses', 'paketleme', 'lojistik']) check(`${role}: START basılı açılış hareket üretmez; bırakıp basmak gerekir`, () => {
  const sim = new Factory({ seed: 42 });
  const plc = new Fabrika({ role });
  sim.buttons.start = true; sim.hb = 1; sim.updateIr();
  let hr;
  for (let ms = 0; ms <= 500; ms += 20) hr = plc.scan(sim.ir, ms);
  const tags = { proses: ['DOL', 'TNK'], paketleme: ['SHR', 'PAL'], lojistik: ['AGV', 'ASRS'] };
  const prefixes = role === 'tek' ? Object.values(tags).flat() : tags[role];
  for (const p of prefixes) {
    assert.equal(hr[tagAddr(`${p}_QW_DO`)], p === 'PAL' ? 3 : 0, p);
    assert(hr[tagAddr(`${p}_QW_STATUS`)] & 0x80, p);
  }
  sim.buttons.start = false; sim.updateIr(); plc.scan(sim.ir, 520);
  sim.buttons.start = true; sim.updateIr(); hr = plc.scan(sim.ir, 540);
  for (const p of prefixes) assert.equal(hr[tagAddr(`${p}_QW_STATUS`)] & 0x80, 0, p);
});

check('ret nesnesi referansla kullanılır; snapshot kopyası bağımsızdır', () => {
  const ret = ledger(); const plc = new Fabrika({ role: 'paketleme', ret });
  assert.equal(plc.PALLET.ret, ret); assert.equal(plc.ret, ret);
  const image = structuredClone(ret); ret.PAL_COUNT = 4; assert.equal(image.PAL_COUNT, 3);
});
check('eşit robot sonucu ikinci kez sayılmaz', () => {
  const p = new FB_Pallet(ledger()); p.call(robot(), 0); p.call(robot({ RESTART: false }), 20);
  assert(p.BOOK_OK); assert.equal(p.COUNT, 3);
});
for (const code of [1, 17]) check(`bir iş bayat koyma, sonuç ${code}: tam bir kez işlenir`, () => {
  const p = new FB_Pallet(ledger());
  const input = robot({ IW_ACK_SEQ: 9, IW_RES_SEQ: 9, IW_RES_CODE: code, IW_RES_SLOT: 4 });
  p.call(input, 0); p.call({ ...input, RESTART: false }, 20);
  assert(p.BOOK_OK); assert.equal(p.COUNT, 4); assert.equal(p.ret.PAL_LAST_SEQ, 9);
});
check('30000 → 1 sonuç numarası sarması uzlaştırılır', () => {
  const p = new FB_Pallet(ledger({ PAL_LAST_SEQ: 30000 }));
  p.call(robot({ IW_ACK_SEQ: 1, IW_RES_SEQ: 1, IW_RES_SLOT: 4 }), 0);
  assert(p.BOOK_OK); assert.equal(p.COUNT, 4);
});
check('bir iş bayat üst karton sayıyı artırmaz', () => {
  const p = new FB_Pallet(ledger({ PAL_COUNT: 18 }));
  p.call(robot({ IW_ACK_SEQ: 9, IW_RES_SEQ: 9, IW_RES_JOB: 3, IW_RES_SLOT: 1 }), 0);
  assert(p.BOOK_OK); assert(p.SHEET_TOP); assert.equal(p.COUNT, 18);
});
for (const [name, ret, input] of [
  ['iki iş bayat', ledger(), robot({ IW_ACK_SEQ: 10, IW_RES_SEQ: 10, IW_RES_SLOT: 4 })],
  ['robot kaydı geriye gitmiş', ledger(), robot({ IW_ACK_SEQ: 7, IW_RES_SEQ: 7 })],
  ['RES_JOB yok', ledger(), robot({ IW_ACK_SEQ: 9, IW_RES_SEQ: 9, IW_RES_JOB: undefined })],
  ['eşit sonuçta RES_JOB yok', ledger(), robot({ IW_RES_JOB: 0 })],
  ['eşit üst karton sonucu defterde yok', ledger({ PAL_COUNT: 18 }), robot({ IW_RES_JOB: 3, IW_RES_SLOT: 1 })],
  ['yanlış slot', ledger(), robot({ IW_ACK_SEQ: 9, IW_RES_SEQ: 9, IW_RES_SLOT: 6 })],
  ['harita uyuşmazlığı', ledger({ RET_MAPVER: 5 }), robot()],
  ['magic yok', {}, robot()],
  ['sayı aralık dışında', ledger({ PAL_COUNT: 19 }), robot()],
  ['sonuç numarası eşit fakat sayı tutarsız', ledger({ PAL_COUNT: 4 }), robot()],
  ['ACK iki iş ileride', ledger(), robot({ IW_ACK_SEQ: 10 })],
]) check(`${name}: alarm + START kilidi, robot işi yok`, () => {
  const p = new FB_Pallet(ret); let out = p.call(input, 0);
  for (let ms = 20; ms <= 3600; ms += 20) out = p.call({ ...input, RESTART: false, RESET: ms === 3400, START: ms === 3500 }, ms);
  assert(!p.BOOK_OK); assert(out.QW_ALARM & 0x4000); assert.equal(out.QW_JOB, 0); assert.equal(out.QW_DO, 3);
});
check('plaka doluyken eski sıra adımı bile itme vermez', () => {
  const s = new FB_Shrink(); s.WAIT_START = false; s.MODE = 1; s.G_STP = 12;
  const out = s.call({ START: false, STOP_OK: true, ESTOP_OK: true, RESET: false, IO_READY: true,
    COMM_FAULT: false, IW_DI: 1, IW_PLATE: 3, IW_LANE: 3, IW_IN_CNT: 0, IW_OUT_CNT: 0,
    IW_FILM: 1000, IW_PADS: 10, IW_TEMP: 1600 }, 0);
  assert.equal(out.QW_DO & 2, 0); assert(out.QW_ALARM & 0x4000); assert.equal(s.ROWS, 2);
});
check('B → C aktarımı görüntüden sonra bitmişse tamamlanan palet bir kez sayılır', () => {
  const p = new FB_Pallet(ledger({ PAL_COUNT: 18, PAL_SHEETS: 3 }));
  const input = robot({ IW_DI: 0x08a8, IW_RES_JOB: 3, IW_RES_SLOT: 1 });
  p.call(input, 0); p.call({ ...input, RESTART: false }, 20);
  assert(p.BOOK_OK); assert.equal(p.DONE_CNT, 1); assert.equal(p.COUNT, 0); assert.equal(p.C_STP, 1);
});
check('el ile alınan bilinmeyen palet AGV yoluna ve sağlam sayacına gitmez', () => {
  const sim = new Factory({ seed: 42 });
  sim.pallet.pallets = [{ id: 42, x: PG.zones[1], target: null }];
  sim.pallet.out = 1; sim.pallet.command({ type: 'removeUnknownPallet' });
  assert.equal(sim.pallet.pallets.length, 1);
  sim.pallet.out = 0; sim.pallet.command({ type: 'removeUnknownPallet' });
  assert.equal(sim.pallet.pallets.length, 0); assert.equal(sim.kpi.palletsGood, 0); assert.equal(sim.kpi.agvMoves, 0);
  assert.equal(sim.pallet.rob.ackSeq, 0);
});
check('izleme açılışı HAZIRLIK, bilinmeyen defter alarmını ARIZA sayar', () => {
  const mon = new Monitor(); const img = Array(112).fill(0);
  img[tagAddr('PAL_QW_STATUS')] = 0x80;
  mon.sample(0, { tek: [...img] });
  img[tagAddr('PAL_QW_STATE')] = 6; img[tagAddr('PAL_QW_ALARM')] = 0x4000;
  mon.sample(1000, { tek: [...img] }); mon.sample(2000, { tek: [...img] });
  const t = mon.categoryTimes('palet', 0, 2000).times;
  assert.equal(t.HAZIRLIK, 1000); assert.equal(t.ARIZA, 1000); mon.db.close();
});
const shrinkInput = (extra = {}) => ({ RESTART: false, START: false, STOP_OK: true, ESTOP_OK: true,
  RESET: false, IO_READY: true, COMM_FAULT: false, IW_DI: 0x30b4, IW_PLATE: 0, IW_LANE: 0,
  IW_TEMP: 1600, IW_IN_CNT: 0, IW_OUT_CNT: 0, IW_FILM: 1000, IW_PADS: 10, ...extra });

check('RESTART ilk geçerli görüntüde yalnız bir tarama; sonraki START kenarını ezmez', () => {
  const sim = new Factory({ seed: 42 }); const plc = new Fabrika(); const pulses = [];
  const call = plc.SHRINK.call.bind(plc.SHRINK);
  plc.SHRINK.call = (input, now) => { pulses.push(input.RESTART); return call(input, now); };
  sim.ir[tagAddr('FAB_IW_SIM_HB')] = 0;
  for (let ms = 0; ms < 100; ms += 20) plc.scan(sim.ir, ms);
  assert(pulses.every(p => !p)); assert(plc.FIRST_SCAN);
  sim.hb = 1; sim.updateIr(); plc.scan(sim.ir, 100);
  sim.buttons.start = true; sim.updateIr(); plc.scan(sim.ir, 120);
  for (let ms = 140; ms < 1000; ms += 20) plc.scan(sim.ir, ms);
  assert.equal(pulses.filter(Boolean).length, 1); assert.equal(plc.SHRINK.MODE, 1);
});

check('dolu ve sıcak fırında START/RESET öncesi DRAINING, fan, ısıtıcı ve bant kapalı', () => {
  const s = new FB_Shrink(); let out;
  for (let ms = 0; ms < 5000; ms += 20) {
    out = s.call(shrinkInput({ RESTART: ms === 0, IW_IN_CNT: 2 }), ms);
    assert.equal(out.QW_DO, 0); assert.equal(out.QW_STATUS & 8, 0); assert(s.WAIT_START);
  }
  // RESET acknowledges faults; this implementation requires START for production.
  out = s.call(shrinkInput({ RESET: true, IW_IN_CNT: 2 }), 5000);
  assert.equal(out.QW_DO, 0);
  s.call(shrinkInput({ START: true, IW_IN_CNT: 2 }), 5020);
  out = s.call(shrinkInput({ STOP_OK: false, IW_IN_CNT: 2 }), 5040);
  assert(out.QW_STATUS & 8); assert(out.QW_DO & 0x40); // normal STOP can drain
});

for (const [name, bad] of [
  ['hazır değil', { IW_ROB_DI: 0x0210 }], ['robot meşgul, kabul kaydı yok', { IW_ROB_DI: 0x0216 }],
]) check(`açılışta ${name}: HOLD ulaşır, ilk robot işi verilmez`, () => {
  const p = new FB_Pallet(ledger()); let out;
  for (let ms = 0; ms <= 800; ms += 20) {
    out = p.call(robot({ ...bad, RESTART: ms === 0, START: ms === 20, IW_DI: 0x08a5 }), ms);
    assert.equal(out.QW_JOB, 0); assert(out.QW_DO & 2);
  }
});
check('ilk robot işi 500 ms sabit güvenli geri bildirim ve START gerektirir', () => {
  const p = new FB_Pallet(ledger()); let out;
  for (let ms = 0; ms <= 480; ms += 20) {
    out = p.call(robot({ RESTART: ms === 0, START: ms === 20, IW_DI: 0x08a5, IW_ROB_DI: 0x021a }), ms);
    assert.equal(out.QW_JOB, 0); assert(out.QW_DO & 2);
  }
  out = p.call(robot({ RESTART: false, IW_DI: 0x08a5, IW_ROB_DI: 0x021a }), 500);
  assert.equal(out.QW_JOB, 1); assert.equal(out.QW_DO & 2, 0);
});
check('güvenli geri bildirim kesilirse 500 ms süresi yeniden başlar', () => {
  const p = new FB_Pallet(ledger());
  for (let ms = 0; ms < 900; ms += 20) {
    const out = p.call(robot({ RESTART: ms === 0, START: ms === 20, IW_DI: 0x08a5,
      IW_ROB_DI: ms === 400 ? 0x0210 : 0x021a }), ms);
    assert.equal(out.QW_JOB, 0);
  }
  const out = p.call(robot({ RESTART: false, IW_DI: 0x08a5, IW_ROB_DI: 0x021a }), 920);
  assert.equal(out.QW_JOB, 1);
});
check('START beklerken eski hazır onayı kaybolursa ilk iş tekrar kilitlenir', () => {
  const p = new FB_Pallet(ledger());
  for (let ms = 0; ms <= 600; ms += 20) p.call(robot({ RESTART: ms === 0, IW_ROB_DI: 0x021a }), ms);
  assert(p.ROB_BOOT_OK);
  const out = p.call(robot({ RESTART: false, START: true, IW_DI: 0x08a5, IW_ROB_DI: 0x0230 }), 620);
  assert(!p.ROB_BOOT_OK); assert(out.QW_DO & 2); assert.equal(out.QW_JOB, 0);
});

for (const job of [0, 1]) for (const code of [1, 17]) check(`bayat ${job ? 'üst' : 'alt'} levha, kod ${code}: yalnız SHEET değişir`, () => {
  const count = job ? 18 : 0;
  const p = new FB_Pallet(ledger({ PAL_COUNT: count, PAL_SHEETS: job ? 1 : 0 }));
  p.call(robot({ IW_ACK_SEQ: 9, IW_RES_SEQ: 9, IW_RES_JOB: 3, IW_RES_SLOT: job, IW_RES_CODE: code }), 0);
  assert(p.BOOK_OK); assert.equal(p.COUNT, count); assert(job ? p.SHEET_TOP : p.SHEET_BOT);
});

check('her kalıcı kelime ve checksum bozulması defteri kilitler', () => {
  for (const name of [...PAL_CHECK_FIELDS, 'RET_CHECK']) {
    const ret = ledger(); ret[name] ^= 1;
    const p = new FB_Pallet(ret); const out = p.call(robot(), 0);
    assert(!p.BOOK_OK, name); assert(out.QW_ALARM & 0x4000, name); assert(out.QW_DO & 2);
  }
});
check('hücre boş olsa bile bozuk veya yarım kalıcı alan kendiliğinden sıfırlanmaz', () => {
  const p = new FB_Pallet({ ...ledger(), RET_MAGIC: 0 });
  p.call(robot({ IW_DI: 0x08a0, IW_ACK_SEQ: 0, IW_RES_SEQ: 0, IW_RES_JOB: 0 }), 0);
  assert(!p.BOOK_OK); assert.equal(p.ret.PAL_COUNT, 3);
});
check('commit sırasının her ara görüntüsü reddedilir; son checksum ve magic kabul edilir', () => {
  const images = []; let recording = false;
  const ret = new Proxy(ledger(), { set(target, key, value) {
    target[key] = value; if (recording) images.push({ ...target }); return true;
  } });
  const p = new FB_Pallet(ret); p.call(robot(), 0);
  p.COUNT = 4; p.LAST_SEQ = 9; recording = true;
  p.call(robot({ RESTART: false, IW_ACK_SEQ: 9, IW_RES_SEQ: 9, IW_RES_SLOT: 4 }), 20);
  assert(images.length > 10);
  for (const image of images.slice(0, -1)) {
    const cold = new FB_Pallet(image);
    cold.call(robot({ IW_ACK_SEQ: 9, IW_RES_SEQ: 9, IW_RES_SLOT: 4 }), 0);
    assert(!cold.BOOK_OK);
  }
  const cold = new FB_Pallet(images.at(-1));
  cold.call(robot({ IW_ACK_SEQ: 9, IW_RES_SEQ: 9, IW_RES_SLOT: 4 }), 0);
  assert(cold.BOOK_OK); assert.equal(cold.COUNT, 4);
});

check('dolu plaka kilidi 3 saniye sonra itme zaman aşımına dönüşmez; RESET ile ev adımına döner', () => {
  const s = new FB_Shrink(); s.WAIT_START = false; s.MODE = 1; s.G_STP = 12;
  let out;
  for (let ms = 0; ms <= 6000; ms += 20) {
    out = s.call(shrinkInput({ IW_PLATE: 3, IW_LANE: 3 }), ms);
    assert.equal(out.QW_DO & 2, 0); assert.equal(out.QW_ALARM & 2, 0);
  }
  assert(out.QW_ALARM & 0x4000); assert.equal(s.T.MOVE.ET, 0);
  s.call(shrinkInput({ RESET: true, IW_PLATE: 3, IW_LANE: 3 }), 6020);
  s.call(shrinkInput({ START: true, IW_PLATE: 3, IW_LANE: 3 }), 6040);
  assert.equal(s.G_STP, 20);
});
check('shrink sarma ortasında açılış: START sonrası çalışan sarmaya bağlanır, DONE tüketilir', () => {
  const s = new FB_Shrink();
  const busy = shrinkInput({ IW_DI: 0x39b4 }); // pack + busy, not done
  let out = s.call({ ...busy, RESTART: true }, 0); assert.equal(out.QW_DO, 0);
  out = s.call({ ...busy, START: true }, 20); assert.equal(s.W_STP, 1); assert(out.QW_DO & 16);
  out = s.call(shrinkInput({ IW_DI: 0x3ab4 }), 40); // pack + done
  assert.equal(s.W_STP, 2); assert(out.QW_DO & 32);
});

for (const phase of [2, 3, 4]) check(`C=${phase} ile açılış sarma veya WRAPPED sayacını tekrarlamaz; UNDERWRAP korunur`, () => {
  const p = new FB_Pallet(ledger({ PAL_COUNT: 0, PAL_SHEETS: 0, PAL_ACTIVE: 0,
    PAL_C_PHASE: phase, PAL_UNDERWRAP: 1, PAL_WRAPPED: 5 }));
  let out = p.call(robot({ IW_DI: 0x08a8, IW_RES_JOB: 4, IW_RES_SLOT: 0 }), 0);
  assert.equal(p.C_STP, phase); assert(p.BOOK_OK); assert(out.QW_ALARM & 0x800);
  for (let ms = 20; ms < 200; ms += 20) {
    out = p.call(robot({ RESTART: false, START: ms === 20, IW_DI: 0x08a8,
      IW_RES_JOB: 4, IW_RES_SLOT: 0, AGV_CLEAR: false }), ms);
    assert.equal(out.QW_DO & 0x400, 0); assert.equal(p.WRAPPED, 5);
  }
  assert.equal(p.ret.PAL_UNDERWRAP, 1); assert.equal(p.ret.RET_CHECK, palletChecksum(p.ret));
});
check('B=21 bayat görüntü, fiziksel C sarımı tamamlanmış: DONE ve WRAPPED yalnız bir kez onarılır', () => {
  const p = new FB_Pallet(ledger({ PAL_COUNT: 18, PAL_SHEETS: 3 }));
  const input = robot({ IW_DI: 0x08a8, IW_RES_JOB: 3, IW_RES_SLOT: 1, IW_TURNS: 9 });
  p.call(input, 0); p.call({ ...input, RESTART: false }, 20);
  assert(p.BOOK_OK); assert.equal(p.C_STP, 3); assert.equal(p.DONE_CNT, 1); assert.equal(p.WRAPPED, 1);
});
check('geçersiz IO görüntüsü bütün FB’lerde mevcut ESTOP ve arıza alarmlarını silmez', () => {
  const plc = new Fabrika(); const ir = Array(112).fill(0);
  for (const name of ['DOLUM', 'TANK', 'SHRINK', 'PALLET', 'AGV', 'ASRS']) plc[name].ALARMS = 0x2001;
  plc.scan(ir, 0);
  for (const name of ['DOLUM', 'TANK', 'SHRINK', 'PALLET', 'AGV', 'ASRS']) assert.equal(plc[name].ALARMS & 0x2001, 0x2001, name);
});
check('RESET penceresi bekleyen robot ACK zaman aşımını yeniden başlatmaz', () => {
  const p = new FB_Pallet(ledger()); p.call(robot(), 0);
  Object.assign(p, { MODE: 1, WAIT_START: false, HOLD_LATCH: false, ROB_BOOT_OK: true,
    ROB_BOOT_DONE: true, R_STP: 11, JOB: 1, SLOT: 4, SEQ: 9 });
  let out;
  for (let ms = 20; ms <= 3020; ms += 20) out = p.call(robot({ RESTART: false, RESET: ms === 2020 }), ms);
  assert(out.QW_ALARM & 0x20); assert.equal(p.T.ACK.ET, 3000);
});

for (const [name, job, slot, count, sheets] of [
  ['alma', 1, 4, 3, 1], ['koyma', 2, 4, 3, 1],
  ['alt levha', 3, 0, 0, 0], ['üst levha', 3, 1, 18, 1], ['eve dönüş', 4, 0, 3, 1],
]) for (const code of [1, 17]) check(`${name}, kod ${code}: kabul edilmiş iş START bekler, terminal kayıt bir kez uzlaştırılır`, () => {
  const p = new FB_Pallet(ledger({ PAL_COUNT: count, PAL_SHEETS: sheets }));
  const input = robot({ IW_ACK_SEQ: 9, IW_ROB_DI: 0x0305, IW_RES_JOB: 4, IW_RES_SLOT: 0 });
  for (let ms = 0; ms <= 6000; ms += 20) {
    const out = p.call({ ...input, RESTART: ms === 0 }, ms);
    assert(p.BOOK_OK); assert(p.RECOVERING); assert.equal(out.QW_ALARM & 0x4000, 0);
    assert(out.QW_DO & 2); assert(out.QW_STATUS & 0x80); assert.equal(out.QW_DO & ~3, 0);
    assert.equal(out.QW_JOB, 0); assert.equal(out.QW_SEQ, 9); assert.equal(p.T.RES.ET, 0);
  }
  let out = p.call({ ...input, RESTART: false, START: true }, 6020);
  assert.equal(out.QW_DO & 2, 0); assert.equal(out.QW_JOB, 0); assert.equal(out.QW_SEQ, 9);
  const terminal = { ...input, RESTART: false, IW_ACK_SEQ: 9, IW_RES_SEQ: 9,
    IW_RES_JOB: job, IW_RES_SLOT: slot, IW_RES_CODE: code, IW_ROB_DI: job === 1 ? 0x0232 : 0x0212 };
  for (let ms = 6040; ms < 6440; ms += 20) {
    out = p.call(terminal, ms);
    assert(p.BOOK_OK); assert(!p.RECOVERING); assert.equal(p.LAST_SEQ, 9);
    assert.equal(p.COUNT, job === 2 ? count + 1 : count);
    assert.equal(p.SHEET_BOT, !!(sheets & 1) || (job === 3 && slot === 0));
    assert.equal(p.SHEET_TOP, job === 3 && slot === 1);
    assert.equal(out.QW_ALARM & 0x4000, 0);
  }
});

for (const [name, terminal] of [
  ['slot sayıyı atlıyor', { IW_RES_JOB: 2, IW_RES_SLOT: 5 }],
  ['levha defterle tutarsız', { IW_RES_JOB: 3, IW_RES_SLOT: 1 }],
  ['iş tipi yok', { IW_RES_JOB: 0 }], ['sonuç kodu yok', { IW_RES_CODE: 0 }],
  ['eve dönüş slotu yanlış', { IW_RES_JOB: 4, IW_RES_SLOT: 1 }],
  ['ACK değişti', { IW_ACK_SEQ: 10 }], ['RES geriye gitti', { IW_RES_SEQ: 7 }],
]) check(`kurtarma terminali ${name}: defter bilinmiyor, yeni iş yok`, () => {
  const p = new FB_Pallet(ledger());
  const input = robot({ IW_ACK_SEQ: 9, IW_ROB_DI: 0x0305 });
  p.call(input, 0); p.call({ ...input, RESTART: false, START: true }, 4000);
  const out = p.call({ ...input, RESTART: false, IW_ROB_DI: 0x0212,
    IW_RES_SEQ: 9, IW_RES_JOB: 2, IW_RES_SLOT: 4, ...terminal }, 4020);
  assert(!p.BOOK_OK); assert(out.QW_ALARM & 0x4000); assert(out.QW_DO & 2); assert.equal(out.QW_JOB, 0);
});

check('kurtarma sırasında 30000 → 1 ACK sarması ve yeniden açılış kabul edilir', () => {
  const p = new FB_Pallet(ledger({ PAL_LAST_SEQ: 30000 }));
  const input = robot({ IW_ACK_SEQ: 1, IW_RES_SEQ: 30000, IW_ROB_DI: 0x0305 });
  p.call(input, 0); assert(p.RECOVERING);
  const again = new FB_Pallet(structuredClone(p.ret));
  again.call(input, 5000); assert(again.BOOK_OK); assert(again.RECOVERING);
  again.call({ ...input, RESTART: false, START: true }, 5020);
  again.call({ ...input, RESTART: false, IW_RES_SEQ: 1, IW_RES_SLOT: 4, IW_ROB_DI: 0x0212 }, 5100);
  assert(again.BOOK_OK); assert(!again.RECOVERING); assert.equal(again.COUNT, 4);
});

check('bayat terminal ve onun ardından kabul edilmiş iş ayrı ayrı uzlaştırılır', () => {
  const p = new FB_Pallet(ledger());
  p.call(robot({ IW_ACK_SEQ: 10, IW_RES_SEQ: 9, IW_RES_SLOT: 4, IW_ROB_DI: 0x0305 }), 0);
  assert(p.BOOK_OK); assert(p.RECOVERING); assert.equal(p.COUNT, 4); assert.equal(p.LAST_SEQ, 9);
  p.call(robot({ RESTART: false, IW_ACK_SEQ: 10, IW_RES_SEQ: 10, IW_RES_JOB: 1, IW_RES_SLOT: 5, IW_ROB_DI: 0x0232 }), 5000);
  assert(p.BOOK_OK); assert(!p.RECOVERING); assert.equal(p.COUNT, 4); assert.equal(p.LAST_SEQ, 10);
});

for (const loaded of [false, true]) check(`işsiz, ev dışında${loaded ? ', tutucuda paket' : ''}: START sonrası mevcut ${loaded ? 'koyma' : 'eve dönüş'} dalı`, () => {
  const p = new FB_Pallet(ledger());
  const input = robot({ IW_ROB_DI: loaded ? 0x0232 : 0x0012, IW_DI: 0x08a5 });
  for (let ms = 0; ms < 5000; ms += 20) {
    const out = p.call({ ...input, RESTART: ms === 0 }, ms);
    assert(out.QW_DO & 2); assert.equal(out.QW_JOB, 0);
  }
  const out = p.call({ ...input, RESTART: false, START: true }, 5000);
  assert.equal(out.QW_DO & 2, 0); assert.equal(out.QW_JOB, loaded ? 2 : 4);
});

for (const recovering of [false, true]) check(`${recovering ? 'kabul edilmiş iş' : 'işsiz yüklü robot'}: START sonrası B pimi yukarı gelmeden hareket yok`, () => {
  const p = new FB_Pallet(ledger());
  const input = robot({ IW_DI: 0x0884, IW_ROB_DI: recovering ? 0x0305 : 0x0232, IW_ACK_SEQ: recovering ? 9 : 8 });
  let out = p.call(input, 0);
  for (let ms = 20; ms <= 6000; ms += 20) {
    out = p.call({ ...input, RESTART: false, START: ms === 4000 }, ms);
    assert(p.BOOK_OK); assert(out.QW_DO & 2); assert.equal(out.QW_JOB, 0);
    if (ms >= 4000) assert(out.QW_DO & 0x200, 'START pimi kaldırmalı');
  }
  for (let ms = 6020; ms <= 6540; ms += 20) out = p.call({ ...input, RESTART: false, IW_DI: 0x08a4 }, ms);
  assert.equal(out.QW_DO & 2, 0); assert.equal(out.QW_JOB, recovering ? 0 : 2);
});

check('kurtarma sonucu yalnız aktif çalışmada zaman aşar; tutarlı defteri bilinmiyor yapmaz', () => {
  const p = new FB_Pallet(ledger());
  const input = robot({ IW_ACK_SEQ: 9, IW_ROB_DI: 0x0205 });
  p.call(input, 0); p.call({ ...input, RESTART: false }, 60000);
  assert.equal(p.T.RES.ET, 0); assert(p.BOOK_OK);
  p.call({ ...input, RESTART: false, START: true }, 60020);
  p.call({ ...input, RESTART: false }, 60040);
  const out = p.call({ ...input, RESTART: false }, 100040);
  assert(out.QW_ALARM & 0x20); assert.equal(out.QW_ALARM & 0x4000, 0); assert(p.BOOK_OK);
});

for (const [where, extra] of [
  ['fırın', { IW_IN_CNT: 1 }], ['sarma', { IW_DI: 0x39b4 }], ['tek sıra', { IW_PLATE: 1 }],
  ['dolu plaka', { IW_PLATE: 3 }], ['sayaç sarması', { IW_IN_CNT: 0, IW_OUT_CNT: 29999 }],
]) check(`dördüncü tur: ${where} açılışı karantina; RESET/STOP ve START beklemesi silemez`, () => {
  const fb = new FB_Shrink();
  const input = shrinkInput(extra);
  let out = fb.call({ ...input, RESTART: true }, 0);
  assert(fb.QUARANTINE); assert(out.QW_STATUS & 0x100); assert.equal(out.QW_DO, 0);
  out = fb.call({ ...input, RESET: true }, 6000);
  assert(fb.QUARANTINE); assert.equal(out.QW_DO, 0);
  out = fb.call({ ...input, START: true }, 6020);
  assert(out.QW_DO & 0x400); assert.equal(out.QW_DO & 0x200, 0);
  fb.call({ ...input, STOP_OK: false }, 6040);
  assert(fb.QUARANTINE);
  // A second PLC loses all session memory and still reconstructs the hazard.
  const again = new FB_Shrink(); again.call({ ...input, RESTART: true }, 6060);
  assert(again.QUARANTINE);
});

check('dördüncü tur: boş plaka/boş fırın açılışında normal geçiş; red sayaç sarması', () => {
  const fb = new FB_Shrink();
  fb.call(shrinkInput({ RESTART: true }), 0);
  const out = fb.call(shrinkInput({ START: true, IW_REJECT_CNT: 29999, IW_OUT_CNT: 2 }), 20);
  assert(!fb.QUARANTINE); assert(out.QW_DO & 0x200); assert.equal(out.QW_DO & 0x400, 0);
  assert.equal(out.QW_REJECT, 29999); assert.equal(out.QW_GOOD, 3);
});

check('dördüncü tur: ayırıcı komutsuz paketi tutar; sağlam paketi bile yalnız red çıkışı ayırır', () => {
  const sim = new Factory(); const s = sim.shrink;
  s.injectTestPack(); s.belt[0].s = 1.19; s.inCnt = 29999; s.outCnt = 29998; s.rejectCnt = 29999;
  const pack = s.belt[0].pack;
  for (let i = 0; i < 100; i++) s.step(0.005, 0x40);
  assert.equal(s.belt[0].s, 1.2); assert.equal(s.outCnt, 29998);
  // Conflicting solenoids also keep the gate closed.
  for (let i = 0; i < 100; i++) s.step(0.005, 0x640);
  assert.equal(s.belt[0].s, 1.2); assert.equal(s.rejectCnt, 29999);
  for (let i = 0; i < 100; i++) s.step(0.005, 0x440);
  assert.equal(s.belt.length, 0); assert.equal(s.rejected[0], pack);
  assert.equal(s.rejectCnt, 0); assert.equal(s.outCnt, 29999);
  assert.equal(sim.kpi.packsRejected, 1); assert.equal(sim.kpi.cupsQuarantined, 6);
  assert.equal(sim.kpi.lostCups, 0); assert.equal(sim.kpi.packsDropped, 0);
  assert.equal(sim.kpi.packsGood + sim.kpi.packsBad, 0);
});

check('dördüncü tur: transfer fotoseli s=0 paketini de sayar', () => {
  const sim = new Factory(); const s = sim.shrink;
  s.injectTestPack(); const pack = s.belt.pop().pack;
  s.wrapper.pack = pack; s.inCnt = 29999;
  s.step(0.005, 0x60);
  assert.equal(s.inCnt, 0); assert.equal(s.belt.length, 1); assert(s.belt[0].s < 0.05);
  const fb = new FB_Shrink();
  fb.call(shrinkInput({ RESTART: true, IW_IN_CNT: s.inCnt, IW_OUT_CNT: 29999 }), 0);
  assert.equal(fb.INSIDE, 1); assert(fb.QUARANTINE);
});

check('dördüncü tur: iki fırın + sarıcı + plaka birlikte boşalır; arada restart red kuyruğunu kaybetmez', () => {
  const sim = new Factory(); const s = sim.shrink;
  const fixture = () => { s.injectTestPack(); return s.belt.pop().pack; };
  const packs = Array.from({ length: 4 }, fixture);
  s.belt = [{ pack: packs[0], s: 0.65 }, { pack: packs[1], s: 0.1 }]; s.inCnt = 2;
  s.wrapper.pack = packs[2];
  s.plate = { pad: true, padT: -1, rows: [packs[3].cups.slice(0, 3), packs[3].cups.slice(3)] };
  s.temp = 160;
  let fb = new FB_Shrink(), boot = 0, restarted = false;
  for (let ms = 0; ms < 60000; ms += 20) {
    if (s.rejectCnt === 1 && !restarted) { fb = new FB_Shrink(); boot = ms; restarted = true; }
    const ir = s.ir;
    const out = fb.call(shrinkInput({ RESTART: ms === boot, START: ms === boot + 1000,
      IW_DI: ir[0], IW_LANE: ir[1], IW_TEMP: ir[2], IW_IN_CNT: ir[3], IW_OUT_CNT: ir[4],
      IW_FILM: ir[5], IW_PADS: ir[6], IW_PLATE: ir[8], IW_REJECT_CNT: ir[10] }), ms);
    s.step(0.02, out.QW_DO);
  }
  assert(restarted); assert.equal(s.rejectCnt, 4); assert.equal(s.belt.length, 0);
  assert.equal(s.wrapper.pack, null); assert.equal(s.plate.rows.length, 0);
  assert(!fb.QUARANTINE); assert.equal(s.inCnt, s.outCnt);
  assert.equal(sim.kpi.cupsQuarantined, 24); assert.equal(sim.kpi.packsGood, 0);
  const ids = s.rejected.flatMap(p => p.cups.map(c => c.id));
  assert.deepEqual([...ids].sort(), packs.flatMap(p => p.cups.map(c => c.id)).sort());
});

check('dördüncü tur: sağlam v6 defter COUNT korunarak v7 olur; bayat koyma bir kez uzlaşır', () => {
  const ret = ledger({ RET_MAPVER: 6, PAL_COUNT: 2, PAL_LAST_SEQ: 7 });
  const fb = new FB_Pallet(ret);
  fb.call(robot(), 0);
  assert(fb.BOOK_OK); assert.equal(fb.COUNT, 3); assert.equal(ret.PAL_COUNT, 3);
  assert.equal(ret.RET_MAPVER, 7); assert.equal(ret.RET_CHECK, palletChecksum(ret));
  fb.call(robot({ RESTART: false }), 20); assert.equal(fb.COUNT, 3);
});

check('dördüncü tur: bozuk v6 checksum sürüm göçüyle aklanmaz', () => {
  const ret = ledger({ RET_MAPVER: 6 }); ret.PAL_COUNT++;
  const fb = new FB_Pallet(ret); const out = fb.call(robot(), 0);
  assert(!fb.BOOK_OK); assert(out.QW_ALARM & 0x4000); assert.equal(ret.RET_MAPVER, 6);
});

// Üç OpenPLC denemesinde bulundu: proses açılışında START 45 s gecikince dolum ısıtıcısı (maskeli,
// kapalı) soğudu ve ısınma bekçisi iç komuta bakıp sahte "Isıtıcı ısınmıyor" alarmı verdi.
check('dolum: açılışta 60 s START beklemesi sahte ısınma alarmı üretmez; START sonrası ısınıp üretir', () => {
  const sim = new Factory({ seed: 3 });
  let plc = new Fabrika({ ret: { TNK_COMMISSION: 0xc1ea } });
  const run = (from, to, startAt) => {
    for (let t = from; t < to; t += 0.005) {
      sim.buttons.start = startAt != null && t >= startAt && t < startAt + 0.6;
      if (Math.round(t / 0.005) % 20 === 0) { const hr = plc.scan([...sim.ir], t * 1000); hr.forEach((v, k) => { sim.hr[k] = v; }); sim.touchPlc(); }
      sim.step(0.005);
    }
  };
  run(0, 90, 1);
  const hot = plc.DOLUM.ALARMS, good0 = sim.hr[tagAddr('DOL_QW_GOOD')];
  assert.equal(hot & 0x0020, 0);
  plc = new Fabrika({ ret: { ...plc.ret } });
  run(90, 155, null);                       // 65 s START yok: ısıtıcı kapalı, soğur
  assert.equal(plc.DOLUM.ALARMS & 0x0020, 0, 'START beklerken ısınma alarmı');
  assert(plc.DOLUM.WAIT_START);
  run(155, 260, 156);
  assert.equal(plc.DOLUM.ALARMS & 0x0020, 0, 'START sonrası ısınma alarmı');
  assert(sim.hr[tagAddr('DOL_QW_GOOD')] > good0, 'START sonrası üretim');
});

console.log(`FAZ6 birim: ${passed}/${passed} geçti.`);
