// plc/src/FB_Shrink.st fonksiyon bloğunun satır satır JavaScript karşılığı.
// ST dosyasını değiştirirseniz buradaki aynı bölümü de güncelleyin.
import { TON, R_TRIG } from './fb_dolum.js';

export class FB_Shrink {
  constructor() {
    this.WAIT_START = true;
    Object.assign(this, {
      SP_RUN: 1600, SP_STANDBY: 1200, TEMP_BAND: 150, HYST: 30, COOL_OFF: 600, FILM_LOW: 100,
      ALARM_MASK: 0x63ff,
      MODE: 0, LANE_LAST: 0, G_STP: 0, W_STP: 0, ROWS: 0, PACKS: 0, INSIDE: 0, OUT_LAST: 0, SP: 1600, ALARMS: 0,
      HEAT_BLOCK: false, Q_HEAT: false, Q_FAN: false, Q_CONV: false,
      QUARANTINE: false,
    });
    this.RT_START = new R_TRIG(); this.RT_RESET = new R_TRIG();
    this.T = {
      PAD: new TON(3000), GATE: new TON(600), MOVE: new TON(3000), WRAP: new TON(6000), FANFB: new TON(2000),
      HEATUP: new TON(90000), BELTFB: new TON(2000), STUCK: new TON(15000), EXITBLK: new TON(3000),
      IDLE: new TON(120000),
    };
  }

  call({ RESTART = false, START, STOP_OK, ESTOP_OK, RESET, IO_READY, COMM_FAULT, IW_DI, IW_LANE, IW_TEMP, IW_IN_CNT,
    IW_OUT_CNT, IW_FILM, IW_PADS, IW_PLATE = 0, IW_REJECT_CNT = 0 }, now) {
    const ALARMS_BEFORE = this.ALARMS;
    const T = this.T;
    const bit = (b) => ((IW_DI >> b) & 1) === 1;
    const alarmed = () => (this.ALARMS & this.ALARM_MASK) !== 0;

    if (RESTART) {
      this.MODE = 0; this.WAIT_START = true;
      this.G_STP = 0; this.W_STP = 0; this.Q_HEAT = this.Q_FAN = this.Q_CONV = false;
      for (const timer of Object.values(T)) timer.call(false, now);
    }

    // 1. Girişleri çöz
    const DI_LANE_FULL = bit(0), DI_ROWP_EXT = bit(1), DI_ROWP_RET = bit(2), DI_GRPP_EXT = bit(3), DI_GRPP_RET = bit(4);
    const DI_PAD = bit(5), DI_PAD_LOW = bit(6), DI_WRAP_READY = bit(7), DI_WRAP_BUSY = bit(8), DI_WRAP_DONE = bit(9);
    const DI_WRAP_FAULT = bit(10), DI_PACK_IN_WRAP = bit(11), DI_FAN_RUN = bit(12), DI_BELT_RUN = bit(13);
    const DI_OT_TRIP = bit(14), DI_EXIT_FULL = bit(15);
    this.ROWS = (IW_PLATE & 1 ? 1 : 0) + (IW_PLATE & 2 ? 1 : 0);
    this.RT_START.call(START);
    this.RT_RESET.call(RESET);
    let INSIDE = IW_IN_CNT - IW_OUT_CNT;
    if (INSIDE < 0) INSIDE += 30000;
    this.INSIDE = INSIDE;
    // Reconstruct the interrupted batch from field sensors on every cold boot.
    // No fresh group may join it. A partial plate is completed and rejected too.
    if (RESTART) this.QUARANTINE = INSIDE > 0 || DI_PACK_IN_WRAP || this.ROWS > 0;
    if (this.QUARANTINE && !this.WAIT_START && INSIDE === 0 && !DI_PACK_IN_WRAP
        && this.ROWS === 0 && this.W_STP === 0 && this.G_STP === 0) this.QUARANTINE = false;
    const GROUP_OK = !this.QUARANTINE || this.ROWS > 0 || this.G_STP >= 11;

    // A full plate is a distinct interlock, not a failed actuator stroke.
    const ROW_BLOCKED = this.MODE === 1 && this.G_STP === 12 && this.ROWS >= 2 && IW_LANE > 0;
    if (ROW_BLOCKED) this.ALARMS |= 0x4000;
    // 2. Alarmlar
    if (!ESTOP_OK) this.ALARMS |= 0x0001;
    if (COMM_FAULT) this.ALARMS |= 0x2000;
    if (DI_OT_TRIP) this.ALARMS |= 0x0040;
    if (DI_WRAP_FAULT) this.ALARMS |= 0x0008;
    T.FANFB.call(this.Q_FAN && !DI_FAN_RUN, now);
    if (T.FANFB.Q) this.ALARMS |= 0x0010;
    T.HEATUP.call(this.Q_HEAT && IW_TEMP < this.SP - 300 && !this.RT_RESET.Q, now);
    if (T.HEATUP.Q) this.ALARMS |= 0x0020;
    T.BELTFB.call(this.Q_CONV && !DI_BELT_RUN, now);
    if (T.BELTFB.Q) this.ALARMS |= 0x0080;
    T.STUCK.call(INSIDE > 0 && DI_BELT_RUN && !DI_EXIT_FULL && IW_OUT_CNT === this.OUT_LAST, now);
    this.OUT_LAST = IW_OUT_CNT;
    if (T.STUCK.Q) this.ALARMS |= 0x0100;
    if (!IO_READY) this.ALARMS = ALARMS_BEFORE;

    if (alarmed()) {
      if (this.ALARMS & 0x0001) this.MODE = 4;
      else if (this.MODE !== 4) this.MODE = 3;
    }
    if (this.RT_RESET.Q && ESTOP_OK && !COMM_FAULT && !DI_OT_TRIP && !DI_WRAP_FAULT) {
      this.ALARMS = 0;
      if (this.MODE === 3 || this.MODE === 4) {
        this.MODE = 0;
        if (this.G_STP === 1) this.G_STP = 0;
        if (this.G_STP >= 11 && this.G_STP <= 13) this.G_STP = 10;
        if (this.G_STP >= 21 && this.G_STP <= 22) this.G_STP = 20;
        if (this.W_STP === 1) this.W_STP = 0;
      }
    }
    if (this.MODE === 0 && this.RT_START.Q && IO_READY && !RESTART && STOP_OK) this.MODE = 1;
    if (this.MODE === 1) this.WAIT_START = false;
    if (this.MODE === 1 && !STOP_OK) this.MODE = 0;

    // 3. Fırın
    T.IDLE.call(this.MODE === 1 && this.G_STP === 10 && IW_LANE === this.LANE_LAST && INSIDE === 0 && this.W_STP === 0, now);
    this.LANE_LAST = IW_LANE;
    const STANDBY = T.IDLE.Q;
    this.SP = STANDBY ? this.SP_STANDBY : this.SP_RUN;
    const TEMP_READY = IW_TEMP >= this.SP_RUN - this.TEMP_BAND && IW_TEMP <= this.SP_RUN + this.TEMP_BAND;
    T.EXITBLK.call(DI_EXIT_FULL && INSIDE > 0, now);
    if (T.EXITBLK.Q) this.HEAT_BLOCK = true;
    if (!DI_EXIT_FULL) this.HEAT_BLOCK = false;
    const DRAINING = !this.WAIT_START && this.MODE !== 1 && this.MODE !== 4 && INSIDE > 0 && (this.ALARMS & 0x0180) === 0;
    if (!ESTOP_OK || !DI_FAN_RUN || DI_OT_TRIP || this.HEAT_BLOCK || !(this.MODE === 1 || DRAINING)
      || (this.ALARMS & 0x00f0) !== 0) this.Q_HEAT = false;
    else if (IW_TEMP < this.SP - this.HYST) this.Q_HEAT = true;
    else if (IW_TEMP > this.SP + this.HYST) this.Q_HEAT = false;
    this.Q_FAN = !this.WAIT_START && ESTOP_OK && (this.MODE === 1 || DRAINING || IW_TEMP > this.COOL_OFF);
    this.Q_CONV = ESTOP_OK && (this.MODE === 1 || DRAINING) && (this.ALARMS & 0x0080) === 0;

    // 4. Gruplama
    T.PAD.call(this.G_STP === 1, now);
    T.GATE.call(this.G_STP === 11, now);
    T.MOVE.call(this.MODE === 1 && !ROW_BLOCKED && [12, 13, 21, 22].includes(this.G_STP), now);
    if (this.MODE === 1 && GROUP_OK) {
      switch (this.G_STP) {
        case 0:
          if (DI_ROWP_RET && DI_GRPP_RET) {
            if (this.ROWS >= 2) this.G_STP = 20;
            else if (DI_PAD) this.G_STP = 10;
            else if (IW_PADS > 0) this.G_STP = 1;
          }
          break;
        case 1: if (DI_PAD) this.G_STP = 10; else if (T.PAD.Q) this.ALARMS |= 0x0200; break;
        case 10:
          if (this.ROWS >= 2) this.G_STP = 20;
          else if (DI_LANE_FULL && DI_ROWP_RET && DI_GRPP_RET) this.G_STP = 11;
          break;
        case 11: if (T.GATE.Q) this.G_STP = 12; break;
        case 12:
          if (DI_ROWP_EXT || (this.ROWS >= 2 && IW_LANE === 0)) this.G_STP = 13;
          else if (T.MOVE.Q) this.ALARMS |= 0x0002;
          break;
        case 13:
          if (DI_ROWP_RET) this.G_STP = this.ROWS >= 2 ? 20 : 10;
          else if (T.MOVE.Q) this.ALARMS |= 0x0002;
          break;
        case 20:
          if (this.ROWS === 0) this.G_STP = 0;
          else if (this.ROWS >= 2 && DI_WRAP_READY && DI_ROWP_RET && DI_GRPP_RET) this.G_STP = 21;
          break;
        case 21: if (DI_GRPP_EXT) this.G_STP = 22; else if (T.MOVE.Q) this.ALARMS |= 0x0004; break;
        case 22:
          if (DI_GRPP_RET) this.G_STP = 0;
          else if (T.MOVE.Q) this.ALARMS |= 0x0004;
          break;
      }
    }

    // 5. Sarma ve bırakma
    T.WRAP.call(this.W_STP === 1, now);
    const REL_OK = this.MODE === 1 && TEMP_READY && !STANDBY && !DI_EXIT_FULL && DI_BELT_RUN && !this.HEAT_BLOCK;
    if (this.MODE === 1) {
      switch (this.W_STP) {
        case 0:
          if (DI_PACK_IN_WRAP) this.W_STP = DI_WRAP_DONE ? 2 : 1;
          break;
        case 1: if (DI_WRAP_DONE) this.W_STP = 2; else if (T.WRAP.Q) this.ALARMS |= 0x0008; break;
        case 2:
          if (!DI_PACK_IN_WRAP) { this.PACKS = this.PACKS >= 30000 ? 0 : this.PACKS + 1; this.W_STP = 0; }
          break;
      }
    }

    // 6. Çıkışlar
    const Q = [
      this.G_STP >= 11 && this.G_STP <= 13 && this.MODE !== 4,   // GATE
      this.MODE === 1 && this.G_STP === 12 && this.ROWS < 2,     // ROW_PUSH
      this.MODE === 1 && this.G_STP === 21,                      // GRP_PUSH
      this.MODE === 1 && this.G_STP === 1,                       // PAD_FEED
      this.MODE === 1 && this.W_STP === 1,                       // WRAP_REQ
      this.W_STP === 2 && REL_OK,                                // RELEASE
      this.Q_CONV, this.Q_HEAT, this.Q_FAN,
      this.Q_CONV && !this.QUARANTINE,                           // EXIT_PASS
      this.Q_CONV && this.QUARANTINE,                            // EXIT_REJECT
    ];
    let QW_DO = Q.reduce((w, b, i) => (b ? w | (1 << i) : w), 0);
    let WARNS = 0;
    if (this.HEAT_BLOCK) WARNS |= 0x0400;
    if (IW_FILM < this.FILM_LOW) WARNS |= 0x0800;
    if (DI_PAD_LOW) WARNS |= 0x1000;

    let S;
    if (this.MODE === 4) S = 9;
    else if (this.MODE === 3) S = DRAINING ? 5 : 8;
    else if (this.MODE === 0) S = DRAINING ? 5 : (this.Q_FAN && IW_TEMP > this.COOL_OFF ? 6 : 0);
    else if (STANDBY) S = 7;
    else if (!TEMP_READY) S = 1;
    else if (this.W_STP === 2 && !REL_OK && DI_EXIT_FULL) S = 4;
    else if (this.G_STP === 10 && !DI_LANE_FULL) S = 3;
    else S = 2;

    let STATUS = 0;
    if (this.MODE === 1 && this.G_STP === 10) STATUS |= 0x0001;
    if (this.MODE === 1) STATUS |= 0x0002;
    if (this.Q_HEAT && !TEMP_READY) STATUS |= 0x0004;
    if (DRAINING) STATUS |= 0x0008;
    if (this.MODE === 3 || this.MODE === 4) STATUS |= 0x0010;
    if (S === 4) STATUS |= 0x0020;
    if (S === 3) STATUS |= 0x0040;

    if (this.WAIT_START) STATUS |= 0x0080;
    if (this.QUARANTINE) STATUS |= 0x0100;
    if (this.WAIT_START || !IO_READY) {
      QW_DO = 0;
      this.Q_HEAT = this.Q_FAN = this.Q_CONV = false;
    }
    return {
      QW_DO, QW_STATE: S, QW_ALARM: this.ALARMS | WARNS, QW_STATUS: STATUS, QW_PACKS: this.PACKS,
      QW_INSIDE: INSIDE, QW_SP: this.SP, RUNNING: this.MODE === 1,
      QW_REJECT: IW_REJECT_CNT,
      QW_GOOD: (IW_OUT_CNT - IW_REJECT_CNT + 30000) % 30000,
    };
  }
}
