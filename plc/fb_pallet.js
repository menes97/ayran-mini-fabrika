// plc/src/FB_Pallet.st fonksiyon bloğunun satır satır JavaScript karşılığı.
// ST dosyasını değiştirirseniz buradaki aynı bölümü de güncelleyin.
import { TON, R_TRIG } from './fb_dolum.js';
import { MAP_VERSION } from '../public/iomap.js';
import { PAL_CHECK_FIELDS, palletChecksum } from './retain.js';

export class FB_Pallet {
  constructor(ret = {}) {
    this.ret = ret;
    this.WAIT_START = true;
    Object.assign(this, {
      SLOTS: 18, MIN_TURNS: 9, ALARM_MASK: 0x63ff,
      BOOK_OK: false, BOOT_PENDING: true, RECOVERING: false, RECOVER_SEQ: 0, LAST_SEQ: 0,
      MODE: 0, A_STP: 0, B_STP: 0, C_STP: 0, R_STP: 0, JOB: 0, SLOT: 0, SEQ: 0,
      COUNT: 0, DONE_CNT: 0, PALLET_ID: 0, WRAPPED: 0,
      SHEET_BOT: false, SHEET_TOP: false, SEQ_SYNC: false, RST_WIN: false, HOLD_LATCH: true, UNDERWRAP: false,
      ROB_BOOT_OK: false, ROB_BOOT_DONE: false,
      ALARMS: 0,
    });
    this.RT_START = new R_TRIG(); this.RT_RESET = new R_TRIG();
    this.T = {
      RSTWIN: new TON(3000), ACK: new TON(3000), RES: new TON(40000), DISP: new TON(8000),
      BTRANS: new TON(15000), CTRANS: new TON(15000), WRAP: new TON(60000),
      ROBSAFE: new TON(500),
    };
  }

  call({ RESTART = false, START, STOP_OK, ESTOP_OK, RESET, IO_READY, COMM_FAULT, IW_DI, IW_ROB_DI, IW_ACK_SEQ, IW_RES_SEQ,
    IW_RES_CODE, IW_RES_SLOT, IW_RES_JOB, IW_TURNS, IW_PALLETS, AGV_CLEAR }, now) {
    const ALARMS_BEFORE = this.ALARMS;
    const T = this.T;
    const bit = (w, b) => ((w >> b) & 1) === 1;

    if (RESTART) {
      this.MODE = 0; this.WAIT_START = true;
      this.A_STP = this.B_STP = this.C_STP = this.R_STP = this.JOB = this.SLOT = 0;
      this.SEQ_SYNC = this.RST_WIN = this.BOOK_OK = false; this.HOLD_LATCH = this.BOOT_PENDING = true;
      this.ROB_BOOT_OK = this.ROB_BOOT_DONE = false;
      this.RECOVERING = false; this.RECOVER_SEQ = 0;
      for (const timer of Object.values(T)) timer.call(false, now);
    }

    // 1. Girişleri çöz
    const DI_PICK = bit(IW_DI, 0), DI_PAL_A = bit(IW_DI, 1), DI_PAL_B = bit(IW_DI, 2), DI_PAL_C = bit(IW_DI, 3);
    const DI_PAL_D = bit(IW_DI, 4), DI_PIN_UP = bit(IW_DI, 5), DI_DISP_BUSY = bit(IW_DI, 6), DI_WRAP_HOME = bit(IW_DI, 7);
    const DI_WRAP_DONE = bit(IW_DI, 9), DI_WRAP_FAULT = bit(IW_DI, 10), DI_SAFETY_OK = bit(IW_DI, 11);
    const R_READY = bit(IW_ROB_DI, 1), R_CLEAR = bit(IW_ROB_DI, 4), R_PART = bit(IW_ROB_DI, 5);
    const R_ERROR = bit(IW_ROB_DI, 7), R_HOLDING = bit(IW_ROB_DI, 8), R_HOMED = bit(IW_ROB_DI, 9);
    this.RT_START.call(START);
    this.RT_RESET.call(RESET);

    // An accepted job belongs to the robot controller. Validate the predecessor
    // now, hold until START, then reconcile its terminal record through this same path.
    if (IO_READY && this.RECOVERING && IW_ACK_SEQ !== this.RECOVER_SEQ) {
      this.RECOVERING = false; this.BOOK_OK = false;
    }
    if (IO_READY && (this.BOOT_PENDING || (this.RECOVERING && IW_RES_SEQ === this.RECOVER_SEQ && !bit(IW_ROB_DI, 2)))) {
      const r = this.ret;
      this.BOOT_PENDING = this.RECOVERING = false;
      // Map 7 only adds shrink I/O: the checksummed %MW32..43 ledger is unchanged.
      // Validate a v6 image fully, then the normal commit below upgrades it to v7.
      this.BOOK_OK = r.RET_MAGIC === 0xa55a && (r.RET_MAPVER === MAP_VERSION || r.RET_MAPVER === 6) && r.RET_CHECK === palletChecksum(r)
        && r.PAL_COUNT >= 0 && r.PAL_COUNT <= this.SLOTS && r.PAL_ID >= 0 && r.PAL_ID <= 30000
        && r.PAL_DONE >= 0 && r.PAL_DONE <= 30000 && r.PAL_WRAPPED >= 0 && r.PAL_WRAPPED <= 30000
        && r.PAL_SHEETS >= 0 && r.PAL_SHEETS <= 3 && r.PAL_LAST_SEQ >= 0 && r.PAL_LAST_SEQ <= 30000
        && (r.PAL_ACTIVE === 0 || r.PAL_ACTIVE === 1) && [0, 1, 2, 3, 4].includes(r.PAL_C_PHASE)
        && (r.PAL_UNDERWRAP === 0 || r.PAL_UNDERWRAP === 1);
      // A virgin, physically empty cell is the only automatic cold commissioning case.
      if (!this.BOOK_OK && [...PAL_CHECK_FIELDS, 'RET_CHECK'].every(name => (r[name] ?? 0) === 0)
        && (IW_DI & 0x005e) === 0 && IW_ACK_SEQ === 0 && !R_PART) {
        this.BOOK_OK = true;
        r.PAL_COUNT = r.PAL_ID = r.PAL_DONE = r.PAL_WRAPPED = r.PAL_SHEETS = r.PAL_LAST_SEQ = r.PAL_ACTIVE = r.PAL_C_PHASE = 0;
        r.PAL_UNDERWRAP = 0;
      }
      if (this.BOOK_OK) {
        this.COUNT = r.PAL_COUNT; this.PALLET_ID = r.PAL_ID; this.DONE_CNT = r.PAL_DONE; this.WRAPPED = r.PAL_WRAPPED;
        this.SHEET_BOT = !!(r.PAL_SHEETS & 1); this.SHEET_TOP = !!(r.PAL_SHEETS & 2); this.LAST_SEQ = r.PAL_LAST_SEQ;
        this.UNDERWRAP = !!r.PAL_UNDERWRAP;
        if (IW_RES_SEQ > 0 && (!Number.isInteger(IW_RES_JOB) || IW_RES_JOB < 1 || IW_RES_JOB > 4)) this.BOOK_OK = false;
        if (IW_RES_SEQ > 0 && (!Number.isInteger(IW_RES_CODE) || !(IW_RES_CODE === 1 || (IW_RES_CODE >= 10 && IW_RES_CODE <= 17))
          || !Number.isInteger(IW_RES_SLOT) || (IW_RES_JOB <= 2 && (IW_RES_SLOT < 1 || IW_RES_SLOT > this.SLOTS))
          || (IW_RES_JOB === 3 && IW_RES_SLOT !== 0 && IW_RES_SLOT !== 1) || (IW_RES_JOB === 4 && IW_RES_SLOT !== 0))) this.BOOK_OK = false;
        if ((this.COUNT > 0 && !this.SHEET_BOT) || (this.SHEET_TOP && this.COUNT !== this.SLOTS)) this.BOOK_OK = false;
        if (DI_PAL_B && IW_RES_SEQ === this.LAST_SEQ && IW_RES_JOB === 2
          && (IW_RES_CODE === 1 || IW_RES_CODE === 17) && IW_RES_SLOT !== this.COUNT) this.BOOK_OK = false;
        if (DI_PAL_B && IW_RES_SEQ === this.LAST_SEQ && IW_RES_JOB === 3 && (IW_RES_CODE === 1 || IW_RES_CODE === 17)
          && !((IW_RES_SLOT === 0 && this.SHEET_BOT) || (IW_RES_SLOT === 1 && this.SHEET_TOP))) this.BOOK_OK = false;
        const next = this.LAST_SEQ >= 30000 ? 1 : this.LAST_SEQ + 1;
        if (IW_RES_SEQ !== this.LAST_SEQ) {
          if (!Number.isInteger(IW_RES_JOB) || IW_RES_SEQ !== next || IW_RES_JOB < 1 || IW_RES_JOB > 4) this.BOOK_OK = false;
          else if (IW_RES_CODE === 1 || IW_RES_CODE === 17) {
            if (IW_RES_JOB === 1) {
              if (!DI_PAL_B || !this.SHEET_BOT || IW_RES_SLOT !== this.COUNT + 1 || this.COUNT >= this.SLOTS) this.BOOK_OK = false;
            } else if (IW_RES_JOB === 2) {
              if (!DI_PAL_B || !this.SHEET_BOT || IW_RES_SLOT !== this.COUNT + 1 || IW_RES_SLOT > this.SLOTS) this.BOOK_OK = false;
              else this.COUNT = IW_RES_SLOT;
            } else if (IW_RES_JOB === 3) {
              if (!DI_PAL_B) this.BOOK_OK = false;
              else if (IW_RES_SLOT === 0 && this.COUNT === 0 && !this.SHEET_BOT) this.SHEET_BOT = true;
              else if (IW_RES_SLOT === 1 && this.COUNT === this.SLOTS && this.SHEET_BOT && !this.SHEET_TOP) this.SHEET_TOP = true;
              else this.BOOK_OK = false;
            }
          } else if (IW_RES_CODE < 10 || IW_RES_CODE > 16 || (IW_RES_JOB === 3 && R_PART)) this.BOOK_OK = false;
          this.LAST_SEQ = IW_RES_SEQ;
        }
        const nextResult = IW_RES_SEQ >= 30000 ? 1 : IW_RES_SEQ + 1;
        if (!Number.isInteger(IW_ACK_SEQ) || !Number.isInteger(IW_RES_SEQ)
          || IW_ACK_SEQ < 0 || IW_ACK_SEQ > 30000 || IW_RES_SEQ < 0 || IW_RES_SEQ > 30000
          || (IW_ACK_SEQ !== IW_RES_SEQ && IW_ACK_SEQ !== nextResult)
          || (bit(IW_ROB_DI, 2) && IW_ACK_SEQ === IW_RES_SEQ)) this.BOOK_OK = false;
        if (DI_PAL_B) {
          if (r.PAL_ACTIVE !== 1 || this.PALLET_ID === 0) this.BOOK_OK = false;
          this.B_STP = this.COUNT >= this.SLOTS && this.SHEET_TOP ? 20 : 10;
        } else {
          if (r.PAL_ACTIVE === 1 && !(DI_PAL_C && this.COUNT === this.SLOTS && this.SHEET_TOP)) this.BOOK_OK = false;
          else if (r.PAL_ACTIVE === 1) this.DONE_CNT = this.DONE_CNT >= 30000 ? 0 : this.DONE_CNT + 1;
          this.B_STP = 0; this.COUNT = 0; this.SHEET_BOT = this.SHEET_TOP = false;
        }
        if (DI_PAL_C) {
          // A stale snapshot can precede wrap completion. Independent wrapper
          // turns/done survive a PLC restart; consume that completion once.
          if (r.PAL_C_PHASE >= 2) this.C_STP = r.PAL_C_PHASE;
          else if (DI_WRAP_DONE || IW_TURNS >= this.MIN_TURNS) {
            this.C_STP = DI_WRAP_DONE ? 2 : 3;
            this.UNDERWRAP = IW_TURNS < this.MIN_TURNS;
            this.WRAPPED = this.WRAPPED >= 30000 ? 0 : this.WRAPPED + 1;
          } else this.C_STP = 1;
        }
        else if (r.PAL_C_PHASE !== 0 && !(r.PAL_C_PHASE === 4 && DI_PAL_D)) this.BOOK_OK = false;
        if (this.BOOK_OK && IW_ACK_SEQ !== IW_RES_SEQ) {
          this.RECOVERING = true; this.RECOVER_SEQ = IW_ACK_SEQ;
        }
      }
    }
    if (IO_READY && this.RECOVERING && IW_RES_SEQ !== this.LAST_SEQ && IW_RES_SEQ !== this.RECOVER_SEQ) {
      this.RECOVERING = false; this.BOOK_OK = false;
    }

    if (IO_READY && !this.SEQ_SYNC) { this.SEQ = IW_ACK_SEQ; this.SEQ_SYNC = true; }
    if (this.RT_RESET.Q) this.RST_WIN = true;
    T.RSTWIN.call(this.RST_WIN, now);
    if (T.RSTWIN.Q) this.RST_WIN = false;

    // 2. Alarmlar
    if (!ESTOP_OK) this.ALARMS |= 0x0001;
    if (ESTOP_OK && !DI_SAFETY_OK) this.ALARMS |= 0x0002;
    if (R_ERROR) this.ALARMS |= 0x0004;
    if (COMM_FAULT) this.ALARMS |= 0x2000;
    if (DI_WRAP_FAULT) this.ALARMS |= 0x0100;
    T.ACK.call(this.R_STP === 11 && !this.HOLD_LATCH, now);
    T.RES.call((this.R_STP === 12 || this.RECOVERING) && !this.WAIT_START && !this.HOLD_LATCH && !R_HOLDING, now);
    if (T.ACK.Q || T.RES.Q) this.ALARMS |= 0x0020;
    T.DISP.call(this.MODE === 1 && !this.RECOVERING && this.A_STP === 1 && DI_SAFETY_OK, now);
    T.BTRANS.call(this.MODE === 1 && !this.RECOVERING && DI_SAFETY_OK && (this.B_STP === 2 || this.B_STP === 21), now);
    T.CTRANS.call(this.MODE === 1 && !this.RECOVERING && DI_SAFETY_OK && this.C_STP === 4, now);
    if (T.DISP.Q || T.BTRANS.Q || T.CTRANS.Q) this.ALARMS |= 0x0080;
    T.WRAP.call(this.MODE === 1 && !this.RECOVERING && DI_SAFETY_OK && this.C_STP === 1, now);
    if (T.WRAP.Q) this.ALARMS |= 0x0100;
    if (!IO_READY) this.ALARMS = ALARMS_BEFORE;
    if (IO_READY && !this.BOOT_PENDING && !this.BOOK_OK) this.ALARMS |= 0x4000;

    if (this.ALARMS & this.ALARM_MASK) {
      if (this.ALARMS & 0x0001) this.MODE = 4; else if (this.MODE !== 4) this.MODE = 3;
      this.HOLD_LATCH = true;
    }
    if (this.RST_WIN && ESTOP_OK && DI_SAFETY_OK && !COMM_FAULT && !DI_WRAP_FAULT && !R_ERROR) {
      this.ALARMS &= 0x4000;
      this.RST_WIN = false;
      if (this.MODE === 3 || this.MODE === 4) {
        this.MODE = 0;
        if (this.R_STP === 10 || this.R_STP === 11) { this.SEQ = IW_ACK_SEQ; this.R_STP = 0; }
      }
    }
    if (this.MODE === 0 && this.RT_START.Q && IO_READY && !RESTART && this.BOOK_OK && !this.BOOT_PENDING && STOP_OK && (this.ALARMS & this.ALARM_MASK) === 0) {
      this.MODE = 1; this.HOLD_LATCH = !this.ROB_BOOT_OK;
    }
    if (this.MODE === 1) this.WAIT_START = false;
    if (this.MODE === 1 && !STOP_OK) this.MODE = 0;

    // READY is an idle-controller signal. An accepted job cannot be READY;
    // idle loaded/off-home robots use the existing place/home selection below.
    T.ROBSAFE.call(IO_READY && R_READY && !bit(IW_ROB_DI, 2)
      && (!DI_PAL_B || DI_PIN_UP) && IW_ACK_SEQ === IW_RES_SEQ && this.BOOK_OK && !this.BOOT_PENDING, now);
    if (!this.ROB_BOOT_DONE) this.ROB_BOOT_OK = (this.BOOK_OK && this.RECOVERING && (!DI_PAL_B || DI_PIN_UP)) || T.ROBSAFE.Q;
    if (!this.ROB_BOOT_OK) this.HOLD_LATCH = true;
    if (this.MODE === 1 && this.ROB_BOOT_OK && (this.ALARMS & this.ALARM_MASK) === 0) this.HOLD_LATCH = false;

    // 3. Robot işi
    const B = this.B_STP;
    switch (this.R_STP) {
      case 0:
        if (this.MODE === 1 && this.BOOK_OK && !this.RECOVERING && R_READY && this.SEQ_SYNC && !this.HOLD_LATCH) {
          const go = (job, slot) => { this.JOB = job; this.SLOT = slot; this.R_STP = 10; this.ROB_BOOT_DONE = true; };
          if (!R_HOMED) go(4, 0);
          else if (R_PART) { if (B === 10 && DI_PIN_UP && this.SHEET_BOT && this.COUNT < this.SLOTS) go(2, this.COUNT + 1); }
          else if (B === 10 && DI_PIN_UP && !this.SHEET_BOT) go(3, 0);
          else if (B === 10 && DI_PIN_UP && this.COUNT >= this.SLOTS && !this.SHEET_TOP) go(3, 1);
          else if (DI_PICK && B === 10 && this.SHEET_BOT && this.COUNT < this.SLOTS) go(1, this.COUNT + 1);
        }
        break;
      case 10:
        this.SEQ++;
        if (this.SEQ > 30000) this.SEQ = 1;
        this.R_STP = 11;
        break;
      case 11:
        if (IW_RES_SEQ === this.SEQ || IW_ACK_SEQ === this.SEQ) this.R_STP = 12;
        break;
      case 12:
        if (IW_RES_SEQ === this.SEQ) {
          this.R_STP = 0;
          this.LAST_SEQ = IW_RES_SEQ;
          if (IW_RES_SLOT !== this.SLOT || IW_RES_JOB !== this.JOB) { this.ALARMS |= 0x4200; this.BOOK_OK = false; }
          else if (IW_RES_CODE === 1 || IW_RES_CODE === 17) {
            if (this.JOB === 2) this.COUNT++;
            else if (this.JOB === 3) { if (this.SLOT === 0) this.SHEET_BOT = true; else this.SHEET_TOP = true; }
          } else if (IW_RES_CODE === 10) this.ALARMS |= 0x0010;
          else if (IW_RES_CODE === 11) this.ALARMS |= 0x0008;
          else if (IW_RES_CODE === 14) this.ALARMS |= 0x0004;
          else if (IW_RES_CODE === 15) this.ALARMS |= 0x0040;
          else if (IW_RES_CODE === 12 || IW_RES_CODE === 16) this.ALARMS |= 0x0200;
        }
        break;
    }

    // 4. Palet hattı
    if (this.MODE === 1 && !this.RECOVERING) {
      switch (this.A_STP) {
        case 0: if (!DI_PAL_A && !DI_DISP_BUSY && IW_PALLETS > 0 && this.B_STP !== 2) this.A_STP = 1; break;
        case 1: if (DI_PAL_A) this.A_STP = 0; break;
      }
      switch (this.B_STP) {
        case 0:
          if (DI_PAL_B) this.B_STP = 3;
          else if (DI_PAL_A && this.A_STP === 0) this.B_STP = 2;
          break;
        case 2: if (DI_PAL_B) this.B_STP = 3; break;
        case 3:
          this.PALLET_ID++;
          if (this.PALLET_ID > 30000) this.PALLET_ID = 1;
          this.COUNT = 0; this.SHEET_BOT = false; this.SHEET_TOP = false;
          this.B_STP = 10;
          break;
        case 10: if (this.COUNT >= this.SLOTS && this.SHEET_TOP) this.B_STP = 20; break;
        case 20:
          if (R_CLEAR && this.R_STP === 0 && this.C_STP === 0 && !DI_PAL_C && DI_WRAP_HOME) this.B_STP = 21;
          break;
        case 21:
          if (DI_PAL_C && !DI_PAL_B) {
            this.DONE_CNT++;
            if (this.DONE_CNT > 30000) this.DONE_CNT = 0;
            this.C_STP = 1; this.B_STP = 0;
          }
          break;
      }
      switch (this.C_STP) {
        case 0: if (DI_PAL_C && this.B_STP !== 21) this.C_STP = 1; break;
        case 1:
          if (DI_WRAP_DONE) {
            this.UNDERWRAP = IW_TURNS < this.MIN_TURNS;
            this.WRAPPED++;
            if (this.WRAPPED > 30000) this.WRAPPED = 0;
            this.C_STP = 2;
          }
          break;
        case 2: if (!DI_WRAP_DONE && DI_WRAP_HOME) this.C_STP = 3; break;
        case 3: if (!DI_PAL_D && AGV_CLEAR) this.C_STP = 4; break;
        case 4: if (DI_PAL_D && !DI_PAL_C) this.C_STP = 0; break;
      }
    }

    // 5. Çıkışlar
    if (this.BOOK_OK) {
      this.ret.RET_MAGIC = 0;
      Object.assign(this.ret, {
        RET_MAPVER: MAP_VERSION, PAL_COUNT: this.COUNT, PAL_ID: this.PALLET_ID,
        PAL_DONE: this.DONE_CNT, PAL_WRAPPED: this.WRAPPED, PAL_SHEETS: (this.SHEET_BOT ? 1 : 0) | (this.SHEET_TOP ? 2 : 0),
        PAL_LAST_SEQ: this.LAST_SEQ, PAL_ACTIVE: this.B_STP >= 10 ? 1 : 0, PAL_C_PHASE: this.C_STP,
        PAL_UNDERWRAP: this.UNDERWRAP ? 1 : 0,
      });
      this.ret.RET_CHECK = palletChecksum({ ...this.ret, RET_MAGIC: 0xa55a });
      this.ret.RET_MAGIC = 0xa55a;
    }
    const M1 = this.MODE === 1;
    const LINE_RUN = M1 && !this.RECOVERING;
    const Q_PICKUP = !this.WAIT_START && DI_PAL_D && this.C_STP !== 4;
    const Q = [
      ESTOP_OK && DI_SAFETY_OK && IO_READY && !COMM_FAULT,          // ROB_ENABLE
      this.HOLD_LATCH,                                              // ROB_HOLD
      false,                                                        // ROB_ABORT
      this.RST_WIN && R_ERROR,                                      // ROB_RESET
      LINE_RUN && this.A_STP === 1,                                 // DISPENSE
      LINE_RUN && this.B_STP === 2,                                 // CONV_A
      LINE_RUN && (this.B_STP === 2 || this.B_STP === 21),          // CONV_B
      LINE_RUN && (this.B_STP === 21 || this.C_STP === 4),          // CONV_C
      LINE_RUN && this.C_STP === 4,                                 // CONV_D
      this.B_STP !== 21,                                            // PIN
      LINE_RUN && this.C_STP === 1,                                 // WRAP_REQ
      Q_PICKUP,                                                     // PICKUP_RDY
      this.B_STP === 10 && DI_PAL_B && DI_PIN_UP,                   // ZONE_PERMIT
    ];
    let QW_DO = Q.reduce((w, b, i) => (b ? w | (1 << i) : w), 0);

    let WARNS = 0;
    if (IW_PALLETS === 0 && !DI_PAL_A && this.B_STP === 0) WARNS |= 0x0400;
    if (this.UNDERWRAP) WARNS |= 0x0800;
    if (this.C_STP === 3) WARNS |= 0x1000;

    let S;
    if (this.MODE === 4) S = 8;
    else if (this.MODE === 3) S = DI_SAFETY_OK ? 6 : 7;
    else if (this.MODE === 0) S = this.R_STP !== 0 ? 9 : 0;
    else if (this.B_STP === 20 && this.C_STP === 3) S = 4;
    else if (this.B_STP < 10 && !DI_PAL_A && IW_PALLETS === 0) S = 3;
    else if (this.B_STP < 10 || this.B_STP >= 20) S = 5;
    else if (this.R_STP === 0 && !DI_PICK && !R_PART) S = 2;
    else S = 1;

    let STATUS = 0;
    if (M1 && this.B_STP === 10 && this.COUNT < this.SLOTS) STATUS |= 0x0001;
    if (M1) STATUS |= 0x0002;
    if (this.MODE === 3 || this.MODE === 4) STATUS |= 0x0004;
    if (S === 2) STATUS |= 0x0008;
    if (S === 4) STATUS |= 0x0010;
    if (!DI_SAFETY_OK) STATUS |= 0x0020;
    if (Q_PICKUP) STATUS |= 0x0040;

    if (this.WAIT_START) STATUS |= 0x0080;
    if (this.WAIT_START || !IO_READY) {
      // Enable permits controller readiness under HOLD, never an automatic job.
      QW_DO = (Q[0] ? 1 : 0) | 2;
    }
    return {
      QW_DO, QW_JOB: this.JOB, QW_SLOT: this.SLOT, QW_SEQ: this.SEQ, QW_STATE: S, QW_ALARM: this.ALARMS | WARNS,
      QW_STATUS: STATUS, QW_COUNT: this.COUNT, QW_DONE: this.DONE_CNT, QW_PALLET_ID: this.PALLET_ID,
      QW_WRAPPED: this.WRAPPED, PICKUP_RDY: Q_PICKUP, RUNNING: M1,
    };
  }
}
