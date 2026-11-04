// plc/src/FB_Asrs.st fonksiyon bloğunun satır satır JavaScript karşılığı.
import { TON, R_TRIG } from './fb_dolum.js';

export class FB_Asrs {
  constructor() {
    this.WAIT_START = true;
    Object.assign(this, {
      TEMP_MAX: 60, ALARM_MASK: 0x23ff,
      LST: Array(37).fill(0), LID: Array(37).fill(0), INIT_DONE: false,
      MODE: 0, R_STP: 0, I_STP: 0, O_STP: 0, JOB: 0, LOC: 0, SEQ: 0, PEND_ID: 0, CHK_ID: 0, PD_ID: 0,
      SHIP_DONE: 0, STORED: 0, PICKED: 0, SEQ_SYNC: false, RST_WIN: false, HOLD_LATCH: false, ALARMS: 0,
    });
    this.RT_START = new R_TRIG(); this.RT_RESET = new R_TRIG();
    this.T = { RSTWIN: new TON(3000), ACK: new TON(3000), RES: new TON(60000), INCONV: new TON(15000),
      OUTCONV: new TON(20000), TEMP: new TON(30000) };
  }

  call({ RESTART = false, START, STOP_OK, ESTOP_OK, RESET, IO_READY, COMM_FAULT, IW_DI, IW_ACK_SEQ, IW_RES_SEQ, IW_RES_CODE,
    IW_RES_ID, IW_IN_ID, IW_FORK_ID, IW_TEMP, IW_SHIP_REQ, AGV_CLEAR_IN }, now) {
    const ALARMS_BEFORE = this.ALARMS;
    const T = this.T, LST = this.LST, LID = this.LID;
    if (RESTART) {
      this.MODE = 0; this.WAIT_START = true;
      this.R_STP = this.I_STP = this.O_STP = this.JOB = this.LOC = 0;
      this.INIT_DONE = this.SEQ_SYNC = this.RST_WIN = false; this.HOLD_LATCH = true;
      for (const timer of Object.values(T)) timer.call(false, now);
    }

    const bit = (b) => ((IW_DI >> b) & 1) === 1;
    const D_CR_READY = bit(0), D_HOMED = bit(2), D_FORK_CENTER = bit(3), D_FORK_LOAD = bit(4), D_CR_ERROR = bit(5);
    const D_IN_ENTRY = bit(6), D_IN_CHECK = bit(7), D_IN_PD = bit(8), D_OUT_PD = bit(9), D_OUT_DOCK = bit(10);
    const D_CHECK_DONE = bit(11), D_CONTOUR_OK = bit(12), D_SAFETY_OK = bit(13);
    this.RT_START.call(START); this.RT_RESET.call(RESET);

    if (!this.INIT_DONE) { for (let i = 1; i <= 36; i++) { LST[i] = 3; LID[i] = 0; } this.INIT_DONE = true; }
    if (IO_READY && !this.SEQ_SYNC) { this.SEQ = IW_ACK_SEQ; this.SHIP_DONE = IW_SHIP_REQ; this.SEQ_SYNC = true; }
    if (this.RT_RESET.Q) this.RST_WIN = true;
    T.RSTWIN.call(this.RST_WIN, now);
    if (T.RSTWIN.Q) this.RST_WIN = false;

    // 2. Göz tablosunu tara
    let BEST_E = 0, BEST_ESC = 32000, BEST_U = 0, BEST_USC = 32000, OLDEST = 0, OLDEST_ID = 32000, STOCK = 0, UNKNOWN = 0;
    for (let i = 1; i <= 36; i++) {
      const SIDE = Math.trunc((i - 1) / 18), COL = Math.trunc(((i - 1) % 18) / 3), LVL = (i - 1) % 3;
      const SC = LVL * 100 + (5 - COL) * 10 + SIDE;
      if (LST[i] === 0 && SC < BEST_ESC) { BEST_E = i; BEST_ESC = SC; }
      if (LST[i] === 3 && SC < BEST_USC) { BEST_U = i; BEST_USC = SC; }
      if (LST[i] === 2) { STOCK++; if (LID[i] > 0 && LID[i] < OLDEST_ID) { OLDEST = i; OLDEST_ID = LID[i]; } }
      if (LST[i] === 3) UNKNOWN++;
    }
    const FULL = BEST_E === 0 && UNKNOWN === 0;
    const SHIP_PEND = IW_SHIP_REQ !== this.SHIP_DONE;

    // 3. Alarmlar
    if (!ESTOP_OK) this.ALARMS |= 0x0001;
    if (ESTOP_OK && !D_SAFETY_OK) this.ALARMS |= 0x0002;
    if (COMM_FAULT) this.ALARMS |= 0x2000;
    if (D_CR_ERROR && (this.ALARMS & 0x000c) === 0) this.ALARMS |= 0x0004;
    T.ACK.call(this.R_STP === 11 && !this.HOLD_LATCH && !this.RST_WIN, now);
    T.RES.call(this.R_STP === 12 && !this.HOLD_LATCH && !this.RST_WIN, now);
    if (T.ACK.Q || T.RES.Q) this.ALARMS |= 0x0040;
    T.INCONV.call(this.MODE === 1 && D_SAFETY_OK && (this.I_STP === 1 || this.I_STP === 4), now);
    T.OUTCONV.call(this.MODE === 1 && D_SAFETY_OK && this.O_STP === 1, now);
    if (T.INCONV.Q || T.OUTCONV.Q) this.ALARMS |= 0x0100;
    if (!IO_READY) this.ALARMS = ALARMS_BEFORE;
    if (this.ALARMS & this.ALARM_MASK) {
      if (this.ALARMS & 0x0001) this.MODE = 4; else if (this.MODE !== 4) this.MODE = 3;
      this.HOLD_LATCH = true;
    }
    if (this.RST_WIN && ESTOP_OK && D_SAFETY_OK && !COMM_FAULT && !D_CR_ERROR && this.I_STP !== 5) {
      this.ALARMS = 0; this.RST_WIN = false;
      if (this.MODE === 3 || this.MODE === 4) {
        this.MODE = 0;
        if (this.R_STP === 10 || this.R_STP === 11) {
          if (this.JOB === 1 && this.LOC >= 1 && LST[this.LOC] === 1) LST[this.LOC] = 0;
          this.SEQ = IW_ACK_SEQ; this.R_STP = 0;
        }
      }
    }
    if (this.MODE === 0 && this.RT_START.Q && IO_READY && !RESTART && STOP_OK && (this.ALARMS & this.ALARM_MASK) === 0) {
      this.MODE = 1; this.HOLD_LATCH = false;
    }
    if (this.MODE === 1) this.WAIT_START = false;
    if (this.MODE === 1 && !STOP_OK) this.MODE = 0;

    // 4. Vinç işi
    switch (this.R_STP) {
      case 0:
        if (this.MODE === 1 && D_CR_READY && this.SEQ_SYNC && !this.HOLD_LATCH) {
          const go = (job, loc) => { this.JOB = job; this.LOC = loc; this.R_STP = 10; };
          if (!D_HOMED) go(3, 0);
          else if (D_FORK_LOAD) {
            if (BEST_E > 0) { go(1, BEST_E); LST[BEST_E] = 1; this.PEND_ID = IW_FORK_ID; }
            else if (BEST_U > 0) go(4, BEST_U); // restart: prove an empty location before putting the retained load
          }
          else if (D_IN_PD && BEST_E > 0 && this.I_STP !== 4) { go(1, BEST_E); LST[BEST_E] = 1; this.PEND_ID = this.PD_ID; }
          else if (SHIP_PEND && OLDEST > 0 && !D_OUT_PD && this.O_STP === 0) go(2, OLDEST);
          else if (BEST_U > 0) go(4, BEST_U);
        }
        break;
      case 10:
        this.SEQ++; if (this.SEQ > 30000) this.SEQ = 1;
        this.R_STP = 11;
        break;
      case 11:
        if (IW_RES_SEQ === this.SEQ || IW_ACK_SEQ === this.SEQ) this.R_STP = 12;
        break;
      case 12:
        if (IW_RES_SEQ === this.SEQ) {
          this.R_STP = 0;
          const L = this.LOC, C = IW_RES_CODE;
          if (this.JOB === 1) {
            if (C === 1 || C === 17) {
              if (this.PEND_ID > 0) { LST[L] = 2; LID[L] = this.PEND_ID; } else LST[L] = 3;
              this.PD_ID = 0;
              this.STORED++; if (this.STORED > 30000) this.STORED = 0;
            } else if (C === 11) { LST[L] = 2; LID[L] = IW_RES_ID; this.ALARMS |= 0x0010; }
            else if (C === 10) { LST[L] = 0; this.ALARMS |= 0x0020; }
            else if (C === 12) { LST[L] = 0; this.ALARMS |= 0x0200; }
            else LST[L] = 3;
          } else if (this.JOB === 2) {
            if (C === 1 || C === 17) {
              LST[L] = 0; LID[L] = 0;
              this.SHIP_DONE++; if (this.SHIP_DONE > 29999) this.SHIP_DONE = 0;
              this.PICKED++; if (this.PICKED > 30000) this.PICKED = 0;
            } else if (C === 10) { LST[L] = 0; LID[L] = 0; this.ALARMS |= 0x0020; }
            else if (C === 12) this.ALARMS |= 0x0200;
            else if (C !== 11) LST[L] = 3;
          } else if (this.JOB === 4) {
            if (C === 1) { if (IW_RES_ID > 0) { LST[L] = 2; LID[L] = IW_RES_ID; } else { LST[L] = 0; LID[L] = 0; } }
            else if (C === 12) this.ALARMS |= 0x0200;
          }
          if (C === 14) this.ALARMS |= 0x0004;
          if (C === 15) this.ALARMS |= 0x0008;
        }
        break;
    }

    // 5. Giriş ve çıkış konveyörleri
    if (this.MODE === 1) {
      switch (this.I_STP) {
        case 0: if (D_IN_CHECK) this.I_STP = 2; else if (D_IN_ENTRY && AGV_CLEAR_IN) this.I_STP = 1; break;
        case 1: if (D_IN_CHECK) this.I_STP = 2; break;
        case 2:
          if (D_CHECK_DONE) {
            if (D_CONTOUR_OK && IW_IN_ID > 0) { this.CHK_ID = IW_IN_ID; this.I_STP = 3; }
            else { this.ALARMS |= 0x0080; this.I_STP = 5; }
          }
          break;
        case 3: if (!D_IN_PD && D_FORK_CENTER && this.R_STP !== 12) this.I_STP = 4; break;
        case 4: if (D_IN_PD) { this.PD_ID = this.CHK_ID; this.I_STP = 0; } break;
        case 5: if (!D_IN_CHECK) this.I_STP = 0; break;
      }
      switch (this.O_STP) {
        case 0: if (D_OUT_PD && !D_OUT_DOCK) this.O_STP = 1; break;
        case 1: if (D_OUT_DOCK) this.O_STP = 0; break;
      }
    }
    if (this.I_STP === 5 && !D_IN_CHECK) this.I_STP = 0;

    const M1 = this.MODE === 1;
    const Q_IN1 = M1 && this.I_STP === 1;
    const Q_IN2 = M1 && this.I_STP === 4 && D_FORK_CENTER;
    const Q_OUT = M1 && this.O_STP === 1;
    const IN_READY = !this.WAIT_START && !D_IN_ENTRY && !Q_IN1 && IO_READY;

    // 6. Çıkışlar
    const Q = [ESTOP_OK && D_SAFETY_OK && IO_READY && !COMM_FAULT, this.HOLD_LATCH, this.RST_WIN && D_CR_ERROR,
      Q_IN1, Q_IN2, Q_OUT, IO_READY, this.I_STP === 5];
    let QW_DO = Q.reduce((w, b, i) => (b ? w | (1 << i) : w), 0);
    T.TEMP.call(IW_TEMP > this.TEMP_MAX, now);
    let WARNS = 0;
    if (T.TEMP.Q) WARNS |= 0x0400;
    if (FULL && (D_IN_PD || D_FORK_LOAD)) WARNS |= 0x0800;
    if (UNKNOWN > 0) WARNS |= 0x1000;
    const OCC = [0, 0, 0];
    for (let i = 1; i <= 36; i++) if (LST[i] === 2) OCC[(i - 1) >> 4] |= 1 << ((i - 1) & 15);

    let S;
    if (this.MODE === 4) S = 7;
    else if (this.MODE === 3) S = D_SAFETY_OK ? 5 : 6;
    else if (this.MODE === 0) S = this.R_STP !== 0 ? 8 : 0;
    else if (FULL && (D_IN_PD || D_FORK_LOAD)) S = 4;
    else if (this.R_STP !== 0 && this.JOB === 4) S = 3;
    else if (this.R_STP !== 0 || this.I_STP === 1 || this.I_STP === 4 || this.O_STP === 1) S = 1;
    else S = 2;
    let STATUS = 0;
    if (IN_READY && M1) STATUS |= 0x0001;
    if (M1) STATUS |= 0x0002;
    if (this.MODE === 3 || this.MODE === 4) STATUS |= 0x0004;
    if (S === 2) STATUS |= 0x0008;
    if (FULL) STATUS |= 0x0010;
    if (UNKNOWN > 0) STATUS |= 0x0020;
    if (SHIP_PEND) STATUS |= 0x0040;

    if (this.WAIT_START) STATUS |= 0x0080;
    if (this.WAIT_START || !IO_READY) {
      QW_DO = 0;
    }
    return {
      QW_DO, QW_JOB: this.JOB, QW_LOC: this.LOC, QW_SEQ: this.SEQ, QW_STATE: S, QW_ALARM: this.ALARMS | WARNS,
      QW_STATUS: STATUS, QW_OCC_A: OCC[0], QW_OCC_B: OCC[1], QW_OCC_C: OCC[2], QW_STOCK: STOCK, QW_UNKNOWN: UNKNOWN,
      QW_STORED: this.STORED, QW_PICKED: this.PICKED, QW_NEXT_ID: OLDEST > 0 ? OLDEST_ID : 0, IN_READY, RUNNING: M1,
    };
  }
}
