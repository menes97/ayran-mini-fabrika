// plc/src/Ortak.st + Proses.st + Paketleme.st + Lojistik.st'nin JavaScript karşılığı.
// tools/gen-plc.js ile aynı birleştirme: tek PLC (role 'tek') bütün parçaları çalıştırır,
// bölünmüş modda her PLC yalnızca kendi parçasını.
// scan(ir, now): 112 input register alır (rolün okuma aralığı dışı 0 olabilir), 112 holding register
// döndürür; yalnızca rolün yazma aralığı anlamlıdır (PLCS tablosu).
import { IO, MAP_VERSION, N_BLOCKS, BLOCK, addr, bitOf, PLCS, SINGLE_PLC } from '../public/iomap.js';
import { FB_Dolum, TON } from './fb_dolum.js';
import { FB_Tank } from './fb_tank.js';
import { FB_Shrink } from './fb_shrink.js';
import { FB_Pallet } from './fb_pallet.js';
import { FB_Agv } from './fb_agv.js';
import { FB_Asrs } from './fb_asrs.js';
import { RETAIN_FIELDS } from './retain.js';

// iomap'teki etiketlerden adres tablosu: FAB_IW_DI → 0, DOL_QW_DO → 16 ...
const AT = {};
for (const [cell, io] of Object.entries(IO)) {
  for (const r of [...io.ir, ...io.hr]) AT[r.tag] = addr(cell, r.off);
}

export const ROLES = {
  tek: ['proses', 'paketleme', 'lojistik'],
  proses: ['proses'], paketleme: ['paketleme'], lojistik: ['lojistik'],
};
export const plcOf = (role) => (role === 'tek' ? SINGLE_PLC : PLCS.find((p) => p.id === role));

export class Fabrika {
  constructor({ role = 'tek', ret = {} } = {}) {
    if (!ROLES[role]) throw new Error(`bilinmeyen PLC rolü: ${role}`);
    this.ret = ret;
    for (const f of RETAIN_FIELDS) this.ret[f.name] ??= 0;
    this.FIRST_SCAN = true;
    this.role = role;
    this.parts = ROLES[role];
    this.plc = plcOf(role);
    this.IO_READY = false;
    this.SIM_HB_LAST = 0;
    this.PLC_HB = 0;
    this.T_SIMHB = new TON(2000);
    // bütün FB'ler oluşturulur (testler doğrudan okur), yalnızca rolün parçaları çağrılır
    this.DOLUM = new FB_Dolum();
    this.TANK = new FB_Tank(this.ret);
    this.SHRINK = new FB_Shrink();
    this.PALLET = new FB_Pallet(this.ret);
    this.AGV = new FB_Agv();
    this.ASRS = new FB_Asrs();
  }

  scan(ir, now) {
    const IW = (tag) => ir[AT[tag]] ?? 0;
    const hr = new Array(N_BLOCKS * BLOCK).fill(0);
    const QW = (tag, v) => { hr[AT[tag]] = v & 0xffff; };
    const has = (p) => this.parts.includes(p);
    const single = this.parts.length > 1;

    // ---- Ortak.st: panel, haberleşme bekçisi, kalp atışı
    const di = IW('FAB_IW_DI');
    const PB_START = bitOf(di, 0), PB_STOP_OK = bitOf(di, 1), PB_ESTOP_OK = bitOf(di, 2), PB_RESET = bitOf(di, 3);
    this.T_SIMHB.call(IW('FAB_IW_SIM_HB') === this.SIM_HB_LAST, now);
    this.SIM_HB_LAST = IW('FAB_IW_SIM_HB');
    const COMM_FAULT = this.T_SIMHB.Q;
    if (IW('FAB_IW_SIM_HB') !== 0 && IW('FAB_IW_MAPVER') === MAP_VERSION) this.IO_READY = true;
    this.PLC_HB = this.PLC_HB >= 30000 ? 0 : this.PLC_HB + 1;
    const RESTART = this.FIRST_SCAN && this.IO_READY;
    if (RESTART) this.FIRST_SCAN = false;
    const common = { RESTART, START: PB_START, STOP_OK: PB_STOP_OK, ESTOP_OK: PB_ESTOP_OK, RESET: PB_RESET,
      IO_READY: this.IO_READY, COMM_FAULT };
    const alarms = [];
    let d = null, pl = null;

    // ---- Proses.st
    if (has('proses')) {
      d = this.DOLUM.call({
        ...common,
        IW_DI: IW('DOL_IW_DI'), IW_FILL: IW('DOL_IW_FILL'), IW_TANK: IW('DOL_IW_TANK'),
        IW_TEMP: IW('DOL_IW_TEMP'), IW_CHECK: IW('DOL_IW_CHECK'),
      }, now);
      QW('DOL_QW_DO', d.QW_DO);
      QW('DOL_QW_STATE', d.QW_STATE);
      QW('DOL_QW_ALARM', d.QW_ALARM);
      QW('DOL_QW_GOOD', d.QW_GOOD);
      QW('DOL_QW_REJECT', d.QW_REJECT);
      QW('DOL_QW_STATUS', d.QW_STATUS);

      // el sıkışma: dolum makinesi ürün ister, tank istasyonu aktarır (aynı PLC)
      const k = this.TANK.call({
        START: PB_START, RESTART, ESTOP_OK: PB_ESTOP_OK, RESET: PB_RESET, IO_READY: this.IO_READY, COMM_FAULT, REQ: d.PRODUCT_REQ,
        IW_DI: IW('TNK_IW_DI'), IW_T1_LVL: IW('TNK_IW_T1_LVL'), IW_FLOW: IW('TNK_IW_FLOW'),
        IW_TOTAL: IW('TNK_IW_TOTAL'), IW_COND: IW('TNK_IW_COND'), IW_RET_T: IW('TNK_IW_RET_T'),
        IW_CIP_T: IW('TNK_IW_CIP_T'), IW_CIP_LVL: IW('TNK_IW_CIP_LVL'),
      }, now);
      for (const [out, tag] of [['QW_DO', 'TNK_QW_DO'], ['QW_STATE', 'TNK_QW_STATE'], ['QW_ALARM', 'TNK_QW_ALARM'],
        ['QW_STEP_T', 'TNK_QW_STEP_T'], ['QW_SINCE', 'TNK_QW_SINCE'], ['QW_BATCH', 'TNK_QW_BATCH'],
        ['QW_CIP_RES', 'TNK_QW_CIP_RES'], ['QW_CIP_MINT', 'TNK_QW_CIP_MINT'], ['QW_CIP_MINF', 'TNK_QW_CIP_MINF'],
        ['QW_STATUS', 'TNK_QW_STATUS'], ['QW_CIP_COND', 'TNK_QW_CIP_COND'], ['QW_CIP_DUR', 'TNK_QW_CIP_DUR']]) QW(tag, k[out]);
      alarms.push(d.QW_ALARM, k.QW_ALARM);
    }

    // ---- Paketleme.st
    if (has('paketleme')) {
      const sh = this.SHRINK.call({
        ...common,
        IW_PLATE: IW('SHR_IW_PLATE'), IW_DI: IW('SHR_IW_DI'), IW_LANE: IW('SHR_IW_LANE'), IW_TEMP: IW('SHR_IW_TEMP'), IW_IN_CNT: IW('SHR_IW_IN_CNT'),
        IW_OUT_CNT: IW('SHR_IW_OUT_CNT'), IW_FILM: IW('SHR_IW_FILM'), IW_PADS: IW('SHR_IW_PADS'),
        IW_REJECT_CNT: IW('SHR_IW_REJECT_CNT'),
      }, now);
      for (const [out, tag] of [['QW_DO', 'SHR_QW_DO'], ['QW_STATE', 'SHR_QW_STATE'], ['QW_ALARM', 'SHR_QW_ALARM'],
        ['QW_STATUS', 'SHR_QW_STATUS'], ['QW_PACKS', 'SHR_QW_PACKS'], ['QW_INSIDE', 'SHR_QW_INSIDE'], ['QW_SP', 'SHR_QW_SP'],
        ['QW_REJECT', 'SHR_QW_REJECT'], ['QW_GOOD', 'SHR_QW_GOOD']]) QW(tag, sh[out]);

      // AGV'nin "çatallar dışarıda" sinyali: aracın istasyona verdiği optik sinyal (istasyonun girişi)
      pl = this.PALLET.call({
        ...common,
        IW_DI: IW('PAL_IW_DI'), IW_ROB_DI: IW('PAL_IW_ROB_DI'), IW_ACK_SEQ: IW('PAL_IW_ACK_SEQ'), IW_RES_SEQ: IW('PAL_IW_RES_SEQ'),
        IW_RES_JOB: IW('PAL_IW_RES_JOB'), IW_RES_CODE: IW('PAL_IW_RES_CODE'), IW_RES_SLOT: IW('PAL_IW_RES_SLOT'), IW_TURNS: IW('PAL_IW_TURNS'),
        IW_PALLETS: IW('PAL_IW_PALLETS'), IW_SHEETS: IW('PAL_IW_SHEETS'), AGV_CLEAR: bitOf(IW('PAL_IW_IL'), 0),
      }, now);
      for (const [out, tag] of [['QW_DO', 'PAL_QW_DO'], ['QW_JOB', 'PAL_QW_JOB'], ['QW_SLOT', 'PAL_QW_SLOT'], ['QW_SEQ', 'PAL_QW_SEQ'],
        ['QW_STATE', 'PAL_QW_STATE'], ['QW_ALARM', 'PAL_QW_ALARM'], ['QW_STATUS', 'PAL_QW_STATUS'], ['QW_COUNT', 'PAL_QW_COUNT'],
        ['QW_DONE', 'PAL_QW_DONE'], ['QW_PALLET_ID', 'PAL_QW_PALLET_ID'], ['QW_WRAPPED', 'PAL_QW_WRAPPED']]) QW(tag, pl[out]);
      alarms.push(sh.QW_ALARM, pl.QW_ALARM);
    }

    // ---- Lojistik.st
    if (has('lojistik')) {
      const as = this.ASRS.call({
        ...common,
        IW_DI: IW('ASRS_IW_DI'), IW_ACK_SEQ: IW('ASRS_IW_ACK_SEQ'), IW_RES_SEQ: IW('ASRS_IW_RES_SEQ'),
        IW_RES_CODE: IW('ASRS_IW_RES_CODE'), IW_RES_LOC: IW('ASRS_IW_RES_LOC'), IW_RES_ID: IW('ASRS_IW_RES_ID'),
        IW_IN_ID: IW('ASRS_IW_IN_ID'), IW_FORK_ID: IW('ASRS_IW_FORK_ID'), IW_TEMP: IW('ASRS_IW_TEMP'),
        IW_SHIP_REQ: IW('ASRS_IW_SHIP_REQ'), AGV_CLEAR_IN: bitOf(IW('AGV_IW_DI'), 7),
      }, now);
      for (const t of ['DO', 'JOB', 'LOC', 'SEQ', 'STATE', 'ALARM', 'STATUS', 'OCC_A', 'OCC_B', 'OCC_C', 'STOCK', 'UNKNOWN',
        'STORED', 'PICKED', 'NEXT_ID']) QW(`ASRS_QW_${t}`, as[`QW_${t}`]);

      // "alım noktasında palet hazır": tek PLC'de doğrudan, bölünmüş modda paketleme PLC'sinden kablo
      const ag = this.AGV.call({
        ...common,
        IW_DI: IW('AGV_IW_DI'), IW_ACK_SEQ: IW('AGV_IW_ACK_SEQ'), IW_RES_SEQ: IW('AGV_IW_RES_SEQ'),
        IW_RES_CODE: IW('AGV_IW_RES_CODE'), IW_BATTERY: IW('AGV_IW_BATTERY'),
        D_READY: single ? pl.PICKUP_RDY : bitOf(IW('AGV_IW_IL'), 0), IN_READY: as.IN_READY,
      }, now);
      for (const t of ['DO', 'ORDER', 'SEQ', 'STATE', 'ALARM', 'STATUS', 'MOVES']) QW(`AGV_QW_${t}`, ag[`QW_${t}`]);
      alarms.push(as.QW_ALARM, ag.QW_ALARM);
    }

    // ---- program sonu: fabrika özeti (proses PLC'si blok 0'ın sahibi) ve kalp atışları
    if (has('proses')) {
      QW('FAB_QW_PLC_HB', this.PLC_HB);
      QW('FAB_QW_DO', d.RUNNING ? 1 : 0);
      QW('FAB_QW_STATE', d.QW_STATE);
      QW('FAB_QW_ALARM', alarms.reduce((a, b) => a | b, 0));
    }
    if (has('paketleme')) QW('SHR_QW_PLC_HB', this.PLC_HB);
    if (has('lojistik')) QW('AGV_QW_PLC_HB', this.PLC_HB);
    return hr;
  }
}
