// plc/src/FB_Agv.st fonksiyon bloğunun satır satır JavaScript karşılığı.
import { TON, R_TRIG } from './fb_dolum.js';

export class FB_Agv {
  constructor() {
    this.WAIT_START = true;
    Object.assign(this, {
      BAT_LOW: 30, BAT_FULL: 80, ALARM_MASK: 0x23ff,
      MODE: 0, R_STP: 0, ORDER: 0, SEQ: 0, MOVES: 0, SEQ_SYNC: false, RST_WIN: false, HOLD_LATCH: false, ALARMS: 0,
    });
    this.RT_START = new R_TRIG(); this.RT_RESET = new R_TRIG();
    this.T = { RSTWIN: new TON(3000), ACK: new TON(3000), RES: new TON(90000), PERMIT: new TON(30000) };
  }

  call({ RESTART = false, START, STOP_OK, ESTOP_OK, RESET, IO_READY, COMM_FAULT, IW_DI, IW_ACK_SEQ, IW_RES_SEQ, IW_RES_CODE, IW_BATTERY,
    D_READY, IN_READY }, now) {
    const ALARMS_BEFORE = this.ALARMS;
    const T = this.T;
    if (RESTART) {
      this.MODE = 0; this.WAIT_START = true;
      this.R_STP = this.ORDER = 0; this.SEQ_SYNC = this.RST_WIN = false; this.HOLD_LATCH = true;
      for (const timer of Object.values(T)) timer.call(false, now);
    }

    const bit = (b) => ((IW_DI >> b) & 1) === 1;
    const A_READY = bit(0), A_LOADED = bit(2), A_CHARGING = bit(8), A_ERROR = bit(9), A_SCAN_STOP = bit(11);
    const A_WAIT = bit(12), A_AT_PARK = bit(13), A_AT_CHG = bit(15);
    this.RT_START.call(START); this.RT_RESET.call(RESET);
    if (IO_READY && !this.SEQ_SYNC) { this.SEQ = IW_ACK_SEQ; this.SEQ_SYNC = true; }
    if (this.RT_RESET.Q) this.RST_WIN = true;
    T.RSTWIN.call(this.RST_WIN, now);
    if (T.RSTWIN.Q) this.RST_WIN = false;

    // 2. Alarmlar
    if (!ESTOP_OK) this.ALARMS |= 0x0001;
    if (A_ERROR) this.ALARMS |= 0x0004;
    if (COMM_FAULT) this.ALARMS |= 0x2000;
    T.ACK.call(this.R_STP === 11 && !this.HOLD_LATCH && !this.RST_WIN, now);
    T.RES.call(this.R_STP === 12 && !this.HOLD_LATCH && !A_WAIT && !A_SCAN_STOP && !this.RST_WIN, now);
    if (T.ACK.Q || T.RES.Q) this.ALARMS |= 0x0020;
    if (!IO_READY) this.ALARMS = ALARMS_BEFORE;
    if (this.ALARMS & this.ALARM_MASK) {
      if (this.ALARMS & 0x0001) this.MODE = 4; else if (this.MODE !== 4) this.MODE = 3;
      this.HOLD_LATCH = true;
    }
    if (this.RST_WIN && ESTOP_OK && !COMM_FAULT && !A_ERROR) {
      this.ALARMS = 0; this.RST_WIN = false;
      if (this.MODE === 3 || this.MODE === 4) {
        this.MODE = 0;
        if (this.R_STP === 10 || this.R_STP === 11) { this.SEQ = IW_ACK_SEQ; this.R_STP = 0; }
      }
    }
    if (this.MODE === 0 && this.RT_START.Q && IO_READY && !RESTART && STOP_OK && (this.ALARMS & this.ALARM_MASK) === 0) {
      this.MODE = 1; this.HOLD_LATCH = false;
    }
    if (this.MODE === 1) this.WAIT_START = false;
    if (this.MODE === 1 && !STOP_OK) this.MODE = 0;

    // 3. İş seçimi ve sonuç
    switch (this.R_STP) {
      case 0:
        if (this.MODE === 1 && A_READY && this.SEQ_SYNC && !this.HOLD_LATCH) {
          const go = (o) => { this.ORDER = o; this.R_STP = 10; };
          if (A_LOADED) go(2);
          else if (IW_BATTERY < this.BAT_LOW) { if (!A_AT_CHG) go(3); }
          else if (D_READY) go(1);
          else if (!A_AT_CHG && IW_BATTERY < this.BAT_FULL) go(3);
          else if (!A_AT_CHG && !A_AT_PARK) go(4);
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
          if (IW_RES_CODE === 1 || IW_RES_CODE === 17) {
            if (this.ORDER === 1 || this.ORDER === 2) { this.MOVES++; if (this.MOVES > 30000) this.MOVES = 0; }
          } else if (IW_RES_CODE === 10) this.ALARMS |= 0x0008;
          else if (IW_RES_CODE === 14) this.ALARMS |= 0x0040;
          else if (IW_RES_CODE === 15) this.ALARMS |= 0x0080;
          else if (IW_RES_CODE === 11 || IW_RES_CODE === 12) this.ALARMS |= 0x0100;
        }
        break;
    }

    // 4. Çıkışlar
    const PERMIT_D = D_READY && this.R_STP === 12 && this.ORDER === 1;
    const PERMIT_IN = IN_READY && this.R_STP === 12 && (this.ORDER === 1 || this.ORDER === 2);
    const Q = [ESTOP_OK && IO_READY && !COMM_FAULT, this.HOLD_LATCH, this.RST_WIN && A_ERROR, PERMIT_D, PERMIT_IN];
    let QW_DO = Q.reduce((w, b, i) => (b ? w | (1 << i) : w), 0);
    T.PERMIT.call(A_WAIT, now);
    let WARNS = 0;
    if (A_SCAN_STOP) WARNS |= 0x0400;
    if (IW_BATTERY < this.BAT_LOW) WARNS |= 0x0800;
    if (T.PERMIT.Q) WARNS |= 0x1000;

    let S;
    if (this.MODE === 4) S = 7;
    else if (this.MODE === 3) S = 6;
    else if (this.MODE === 0) S = this.R_STP !== 0 ? 8 : 0;
    else if (A_SCAN_STOP) S = 5;
    else if (A_WAIT) S = 4;
    else if (this.R_STP !== 0 && (this.ORDER === 1 || this.ORDER === 2)) S = 1;
    else if (A_CHARGING) S = 3;
    else S = 2;
    let STATUS = 0;
    if (this.MODE === 1 && this.R_STP === 0 && A_READY) STATUS |= 0x0001;
    if (this.MODE === 1) STATUS |= 0x0002;
    if (this.MODE === 3 || this.MODE === 4) STATUS |= 0x0004;
    if (S === 2) STATUS |= 0x0008;
    if (A_CHARGING) STATUS |= 0x0010;
    if (A_SCAN_STOP) STATUS |= 0x0020;
    if (A_LOADED) STATUS |= 0x0040;

    if (this.WAIT_START) STATUS |= 0x0080;
    if (this.WAIT_START || !IO_READY) {
      QW_DO = 0;
    }
    return { QW_DO, QW_ORDER: this.ORDER, QW_SEQ: this.SEQ, QW_STATE: S, QW_ALARM: this.ALARMS | WARNS, QW_STATUS: STATUS,
      QW_MOVES: this.MOVES, RUNNING: this.MODE === 1 };
  }
}
