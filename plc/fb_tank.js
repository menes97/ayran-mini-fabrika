// plc/src/FB_Tank.st fonksiyon bloğunun satır satır JavaScript karşılığı.
// ST dosyasını değiştirirseniz buradaki aynı bölümü de güncelleyin.
import { TON, R_TRIG } from './fb_dolum.js';

const R = {   // rotalar: DO bit 1..6 = V_PROD, V_WATER, V_CAUSTIC, V_FILL, V_DRAIN, V_CIPRET
  NONE: 0x0000, PUSHOUT: 0x0022, TRANSFER: 0x0012, RINSE: 0x0024, CAUSTIC_DRAIN: 0x0028, CAUSTIC_RET: 0x0048,
};

export class FB_Tank {
  constructor(ret = {}) {
    this.ret = ret;
    this.WAIT_START = true;
    Object.assign(this, {
      COND_MIN: 85, COND_MAX: 95, COND_CAUSTIC: 650, RINSE_MARGIN: 5, FLOW_MIN: 50, FLOW_CIP: 150,
      CIP_TEMP_MIN: 700, CAUSTIC_SP: 780, CAUSTIC_MAX: 900, CIP_LVL_MIN: 300, RINSE_KG: 300,
      CIP_LIMIT: 500, ALARM_MASK: 0x23ff,
    });
    Object.assign(this, {
      WANT: 0, CUR: 0, VALVES: 0, RSTATE: 0, PUMP_REQ: false, Q_P1: false, Q_HEAT: false, ROUTE_OK: true,
      MODE: 0, STP: 0, LAST_STP: 0, STEP_SCANS: 0, CIP_SCANS: 0, ALARMS: 0, ABORT_WARN: false,
      LINE_PRODUCT: false, CIP_REQ: false, CAUSTIC_IN: false, TOTAL_LAST: 0, TOTAL_INIT: false,
      SINCE: 0, BATCH: 0, VOL: 0, WATER_REF: 0, MIN_T: 32000, MIN_F: 32000,
      CIP_RES: 0, FINAL_COND: 0, CIP_DUR: 0, CIP_DUE: false,
    });
    this.RT_START = new R_TRIG(); this.RT_CIPSTART = new R_TRIG(); this.RT_CIPABORT = new R_TRIG(); this.RT_RESET = new R_TRIG();
    this.T = {
      ROUTE: new TON(3000), STROKE: new TON(1000), LEAKVAL: new TON(1000), NOFLOW: new TON(3000),
      RUNFB: new TON(1000), INWIN: new TON(1000), FOREIGN: new TON(1000), HOLD: new TON(30000),
      STALE: new TON(1200000),
    };
  }

  call({ RESTART = false, START, ESTOP_OK, RESET, IO_READY, COMM_FAULT, REQ, IW_DI, IW_T1_LVL, IW_FLOW, IW_TOTAL, IW_COND,
    IW_RET_T, IW_CIP_T, IW_CIP_LVL }, now) {
    const ALARMS_BEFORE = this.ALARMS;
    const T = this.T;
    const bit = (b) => ((IW_DI >> b) & 1) === 1;
    const alarmed = () => (this.ALARMS & this.ALARM_MASK) !== 0;

    if (RESTART) {
      this.MODE = 0; this.WAIT_START = true;
      this.STP = this.LAST_STP = this.WANT = this.CUR = this.VALVES = this.RSTATE = 0;
      this.RSTATE = 1; // prove all old-route valves closed before accepting a new route
      this.Q_P1 = this.Q_HEAT = this.PUMP_REQ = this.LINE_PRODUCT = this.CIP_REQ = this.TOTAL_INIT = false;
      this.CIP_DUE = this.ret.TNK_COMMISSION !== 0xc1ea;
      if (this.CIP_DUE) { this.CIP_RES = 2; this.ABORT_WARN = true; }
      this.ret.TNK_COMMISSION = 0;
      for (const timer of Object.values(T)) timer.call(false, now);
    }

    // 1. Girişleri çöz
    const DI_T1_LOW = bit(0), DI_CIP_START = bit(1), DI_CIP_ABORT = bit(2);
    const DI_P1_RUN = bit(3), DI_P1_TRIP = bit(4), DI_LEAK = bit(11);
    const CLOSED = (IW_DI >> 4) & 0x007e;
    this.RT_CIPSTART.call(DI_CIP_START);
    this.RT_CIPABORT.call(DI_CIP_ABORT);
    this.RT_RESET.call(RESET);
    this.RT_START.call(START);
    if (this.RT_START.Q && IO_READY && !RESTART) { this.WAIT_START = false; this.MODE = 1; }

    if (!this.TOTAL_INIT) { this.TOTAL_LAST = IW_TOTAL; this.TOTAL_INIT = IO_READY; }
    let D_TOTAL = IW_TOTAL - this.TOTAL_LAST;
    if (D_TOTAL < 0) D_TOTAL += 30000;
    this.TOTAL_LAST = IW_TOTAL;
    const COND_OK = IW_COND >= this.COND_MIN && IW_COND <= this.COND_MAX;

    // 2. Güvenlik ve alarmlar
    if (!ESTOP_OK) this.ALARMS |= 0x0001;
    if (COMM_FAULT) this.ALARMS |= 0x2000;
    if (DI_P1_TRIP) this.ALARMS |= 0x0020;
    if (DI_LEAK) this.ALARMS |= 0x0010;
    this.ROUTE_OK = ((~this.CUR) & 0x007e & ~CLOSED) === 0;
    T.LEAKVAL.call(this.RSTATE === 0 && !this.ROUTE_OK, now);
    if (T.LEAKVAL.Q) this.ALARMS |= 0x0008;
    T.NOFLOW.call(this.Q_P1 && IW_FLOW < this.FLOW_MIN, now);
    if (T.NOFLOW.Q) this.ALARMS |= 0x0002;
    T.RUNFB.call(this.Q_P1 && !DI_P1_RUN, now);
    if (T.RUNFB.Q) this.ALARMS |= 0x0040;
    if (IW_CIP_T > this.CAUSTIC_MAX) this.ALARMS |= 0x0100;
    if (!IO_READY) this.ALARMS = ALARMS_BEFORE;

    if (alarmed()) {
      if (this.STP >= 40) { this.CIP_RES = 3; this.CIP_DUE = true; this.LINE_PRODUCT = false; }
      this.STP = 0;
    }
    if (this.RT_RESET.Q && ESTOP_OK && !COMM_FAULT && !DI_P1_TRIP && !DI_LEAK) this.ALARMS = 0;

    // 3. Adımlar
    if (this.STP !== this.LAST_STP) { this.STEP_SCANS = 0; this.VOL = 0; }
    this.LAST_STP = this.STP;
    if (this.STEP_SCANS < 30000) this.STEP_SCANS++;
    if (this.RSTATE === 0 && (this.STP === 42 || this.STP === 44)) this.VOL += D_TOTAL;
    if ((this.CUR === R.TRANSFER || this.CUR === R.PUSHOUT) && this.SINCE < 30000) this.SINCE += D_TOTAL;
    if (this.CUR === R.TRANSFER) this.BATCH += D_TOTAL;
    if (this.SINCE >= this.CIP_LIMIT) this.CIP_DUE = true;

    T.STALE.call(this.STP === 0 && this.LINE_PRODUCT, now);
    if (T.STALE.Q) this.LINE_PRODUCT = false;

    if (this.RT_CIPSTART.Q) this.CIP_REQ = true;
    if (this.RT_CIPABORT.Q && this.STP >= 40) {
      this.CIP_RES = 2; this.CIP_DUE = true; this.CIP_REQ = false; this.ABORT_WARN = true; this.LINE_PRODUCT = false; this.STP = 0;
    }

    T.INWIN.call(this.STP === 20 && this.RSTATE === 0 && this.Q_P1 && COND_OK, now);
    T.FOREIGN.call(this.STP === 10 && this.RSTATE === 0 && this.Q_P1 && !COND_OK, now);
    const HOLD_OK = this.STP === 43 && this.RSTATE === 0 && this.CUR === R.CAUSTIC_RET && this.Q_P1
      && IW_COND >= this.COND_CAUSTIC && IW_RET_T >= this.CIP_TEMP_MIN && IW_FLOW >= this.FLOW_CIP;
    T.HOLD.call(HOLD_OK, now);
    const STEP_TO = this.STEP_SCANS >= 15000;

    switch (this.STP) {
      case 0:
        this.WANT = R.NONE; this.PUMP_REQ = false;
        if (!this.WAIT_START && !alarmed()) {
          if (this.CIP_REQ) { this.CIP_REQ = false; this.STP = 40; }
          else if (REQ && !this.CIP_DUE && !DI_T1_LOW) {
            this.BATCH = 0;
            this.STP = this.LINE_PRODUCT ? 10 : 20;
          }
        }
        break;
      case 20:
        this.WANT = R.PUSHOUT; this.PUMP_REQ = true;
        if (T.INWIN.Q) { this.LINE_PRODUCT = true; this.STP = 10; }
        else if (this.STEP_SCANS > 2250) this.ALARMS |= 0x0200;
        break;
      case 10:
        this.WANT = R.TRANSFER; this.PUMP_REQ = true;
        if (T.FOREIGN.Q) { this.LINE_PRODUCT = false; this.ALARMS |= 0x0004; }
        else if (!REQ || DI_T1_LOW || this.SINCE >= this.CIP_LIMIT || this.CIP_REQ) this.STP = 0;
        break;
      case 40:
        this.WANT = R.NONE; this.PUMP_REQ = false;
        this.LINE_PRODUCT = false; this.CAUSTIC_IN = false; this.CIP_SCANS = 0;
        this.MIN_T = 32000; this.MIN_F = 32000; this.FINAL_COND = 0;
        if (IW_CIP_LVL < this.CIP_LVL_MIN) this.ALARMS |= 0x0100;
        else if (this.RSTATE === 0 && this.ROUTE_OK) this.STP = 41;
        break;
      case 41:
        this.WANT = R.NONE; this.PUMP_REQ = false;
        if (IW_CIP_T >= this.CAUSTIC_SP - 50) this.STP = 42;
        else if (STEP_TO) this.ALARMS |= 0x0080;
        break;
      case 42:
        this.WANT = R.RINSE; this.PUMP_REQ = true;
        if (this.VOL >= this.RINSE_KG) { this.WATER_REF = IW_COND; this.STP = 43; }
        else if (STEP_TO) this.ALARMS |= 0x0080;
        break;
      case 43:
        this.PUMP_REQ = true;
        if (!this.CAUSTIC_IN && this.RSTATE === 0 && IW_COND >= this.COND_CAUSTIC) this.CAUSTIC_IN = true;
        this.WANT = this.CAUSTIC_IN ? R.CAUSTIC_RET : R.CAUSTIC_DRAIN;
        if (HOLD_OK) {
          if (IW_RET_T < this.MIN_T) this.MIN_T = IW_RET_T;
          if (IW_FLOW < this.MIN_F) this.MIN_F = IW_FLOW;
        } else { this.MIN_T = 32000; this.MIN_F = 32000; }
        if (T.HOLD.Q) this.STP = 44;
        else if (STEP_TO) this.ALARMS |= 0x0080;
        break;
      case 44:
        this.WANT = R.RINSE; this.PUMP_REQ = true;
        if (this.VOL >= this.RINSE_KG && IW_COND <= this.WATER_REF + this.RINSE_MARGIN) {
          this.FINAL_COND = IW_COND; this.STP = 45;
        } else if (STEP_TO) this.ALARMS |= 0x0080;
        break;
      case 45:
        this.WANT = R.NONE; this.PUMP_REQ = false;
        this.SINCE = 0; this.CIP_DUE = false; this.ABORT_WARN = false;
        this.CIP_RES = 1; this.CIP_DUR = Math.trunc(this.CIP_SCANS / 50);
        this.STP = 0;
        break;
    }
    if (this.STP >= 40 && this.STP <= 44 && this.CIP_SCANS < 30000) this.CIP_SCANS++;
    if (this.CIP_RES === 2 || this.CIP_RES === 3) this.CIP_DUR = Math.trunc(this.CIP_SCANS / 50);

    // 4. Rota yöneticisi
    if (alarmed()) this.WANT = R.NONE;
    if (this.WANT !== this.CUR && this.RSTATE === 0) this.RSTATE = 1;
    T.ROUTE.call(this.RSTATE === 1, now);
    T.STROKE.call(this.RSTATE === 2, now);
    if (this.RSTATE === 1) {
      this.VALVES = this.CUR & this.WANT;
      if (((~this.WANT) & 0x007e & ~CLOSED) === 0) this.RSTATE = 2;
      else if (T.ROUTE.Q) { this.ALARMS |= 0x0008; this.RSTATE = 0; this.CUR &= this.WANT; }
    } else if (this.RSTATE === 2) {
      this.VALVES = this.WANT;
      if (T.STROKE.Q) { this.CUR = this.WANT; this.RSTATE = 0; }
    } else {
      this.VALVES = this.CUR;
    }
    this.Q_P1 = this.PUMP_REQ && this.RSTATE === 0 && this.CUR === this.WANT && this.CUR !== 0
      && this.ROUTE_OK && !alarmed();

    if (!ESTOP_OK || IW_CIP_LVL < this.CIP_LVL_MIN || IW_CIP_T > this.CAUSTIC_MAX) this.Q_HEAT = false;
    else if (IW_CIP_T < this.CAUSTIC_SP - 20) this.Q_HEAT = true;
    else if (IW_CIP_T > this.CAUSTIC_SP + 20) this.Q_HEAT = false;

    // 5. Çıkışlar
    let WARNS = 0;
    if (DI_T1_LOW) WARNS |= 0x0400;
    if (this.CIP_DUE) WARNS |= 0x0800;
    if (this.ABORT_WARN) WARNS |= 0x1000;
    let QW_DO = this.VALVES & 0x007e;
    if (this.Q_P1) QW_DO |= 0x0001;
    if (this.Q_HEAT) QW_DO |= 0x0080;
    if (this.STP >= 40) QW_DO |= 0x0100;

    let QW_STATE;
    if (this.ALARMS & 0x0001) QW_STATE = 11;
    else if (alarmed()) QW_STATE = 10;
    else if (this.STP === 0) QW_STATE = this.CIP_DUE ? 9 : 0;
    else if ((this.STP === 10 || this.STP === 20) && this.RSTATE !== 0) QW_STATE = 3;
    else if (this.STP === 10) QW_STATE = 1;
    else if (this.STP === 20) QW_STATE = 2;
    else QW_STATE = this.STP - 36;

    if (this.WAIT_START || !IO_READY) {
      QW_DO = 0;
      this.Q_HEAT = this.Q_P1 = false;
    }
    const QW_STATUS = this.WAIT_START ? 0x0080 : 0;
    return { QW_STATUS,
      QW_DO, QW_STATE, QW_ALARM: this.ALARMS | WARNS, QW_STEP_T: Math.trunc(this.STEP_SCANS / 50),
      QW_SINCE: this.SINCE, QW_BATCH: this.BATCH, QW_CIP_RES: this.CIP_RES,
      QW_CIP_MINT: this.MIN_T === 32000 ? 0 : this.MIN_T, QW_CIP_MINF: this.MIN_F === 32000 ? 0 : this.MIN_F,
      QW_CIP_COND: this.FINAL_COND, QW_CIP_DUR: this.CIP_DUR,
      TRANSFERRING: this.STP === 10 && this.Q_P1, CIP_DUE: this.CIP_DUE,
    };
  }
}
