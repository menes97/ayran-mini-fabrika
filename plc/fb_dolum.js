// plc/src/FB_Dolum.st fonksiyon bloğunun satır satır JavaScript karşılığı.
// OpenPLC kurmadan simülatörü test etmek için kullanılır. ST dosyasını
// değiştirirseniz buradaki aynı bölümü de güncelleyin.

export class TON {
  constructor(ptMs) { this.pt = ptMs; this.start = null; this.Q = false; this.ET = 0; }
  call(IN, now) {
    if (!IN) { this.start = null; this.Q = false; this.ET = 0; return; }
    if (this.start === null) this.start = now;
    this.ET = Math.min(this.pt, now - this.start);
    this.Q = this.ET >= this.pt;
  }
}

export class R_TRIG {
  constructor() {
    this.WAIT_START = true; this.prev = false; this.Q = false; }
  call(CLK) { this.Q = CLK && !this.prev; this.prev = CLK; }
}

export class FB_Dolum {
  constructor() {
    // Reçete ve ayarlar
    this.FILL_TARGET = 2060; this.FILL_TOL = 40; this.COARSE_MARGIN = 400;
    this.PREACT = 20; this.TARE = 49;
    this.TEMP_SP = 1950; this.TEMP_MIN = 1700; this.TEMP_MAX = 2200;
    this.TANK_ON = 400; this.TANK_OFF = 800;

    this.Q = {
      CONV: false, CUP_DROP: false, NOZ_DN: false, FILL_FAST: false, FILL_FINE: false, FOIL: false,
      SEAL_DN: false, HEATER: false, REJECT: false, GREEN: false, YELLOW: false,
      RED: false, HORN: false,
    };
    this.MODE = 0; this.CYC = 0; this.PURGE = 0; this.HEAT_WAIT = false; this.OUT_WAIT = false;
    this.ALARMS = 0; this.ALARM_PREV = false; this.HORN_LATCH = false; this.FILL_WARN = false;
    this.BLINK = false; this.GOOD_CNT = 0; this.REJ_CNT = 0;
    this.TR_CUP = Array(8).fill(false); this.TR_BAD = Array(8).fill(false);
    this.DROP_SUB = 9; this.FILL_SUB = 9; this.FOIL_SUB = 9;
    this.SEAL_SUB = 9; this.CHK_SUB = 9; this.REJ_SUB = 9;
    this.FILL_ERR = 0;

    this.RT_START = new R_TRIG(); this.RT_RESET = new R_TRIG();
    this.T = {
      HEAT: new TON(45000), IDX: new TON(2000), DROP: new TON(300), DROPWAIT: new TON(400),
      NOZ: new TON(2000), FILL: new TON(6000), SETTLE: new TON(400), FINE: new TON(10000), FOIL: new TON(550),
      SEALMV: new TON(2000), DWELL: new TON(800), CHK: new TON(600), REJ: new TON(1000),
      RET: new TON(250), BLINK_A: new TON(500), BLINK_B: new TON(500),
    };
  }

  // Girişler ve çıkışlar ST'deki VAR_INPUT / VAR_OUTPUT ile aynı isimlerde
  call({ RESTART = false, START, STOP_OK, ESTOP_OK, RESET, IO_READY, COMM_FAULT, IW_DI, IW_FILL, IW_TANK, IW_TEMP, IW_CHECK }, now) {
    const ALARMS_BEFORE = this.ALARMS;
    const T = this.T, Q = this.Q, TR_CUP = this.TR_CUP, TR_BAD = this.TR_BAD;
    const bit = (b) => ((IW_DI >> b) & 1) === 1;

    if (RESTART) {
      this.MODE = 0; this.WAIT_START = true;
      this.CYC = 0; this.DROP_SUB = this.FILL_SUB = this.FOIL_SUB = this.SEAL_SUB = this.CHK_SUB = this.REJ_SUB = 9;
      this.PURGE = 7;
      this.TR_CUP.fill((IW_DI & 0x0444) !== 0); this.TR_BAD.fill(true);
      for (const timer of Object.values(T)) timer.call(false, now);
    }

    // 1. Girişleri çöz
    const DI_START = START, DI_STOP_OK = STOP_OK, DI_ESTOP_OK = ESTOP_OK, DI_RESET = RESET;
    const DI_INDEX = bit(0), DI_CUP_EMPTY = bit(1), DI_CUP_AT_FILL = bit(2), DI_NOZ_UP = bit(3);
    const DI_NOZ_DN = bit(4), DI_FOIL_EMPTY = bit(5), DI_FOIL_AT_SEAL = bit(6), DI_SEAL_UP = bit(7);
    const DI_SEAL_DN = bit(8), DI_TANK_LOW = bit(9), DI_CUP_AT_REJ = bit(10), DI_REJ_EXT = bit(11), DI_OUT_FULL = bit(12);

    this.RT_START.call(DI_START);
    this.RT_RESET.call(DI_RESET);
    const TEMP_OK = IW_TEMP >= this.TEMP_MIN && IW_TEMP <= this.TEMP_MAX;

    // 2. Güvenlik ve izleme
    if (COMM_FAULT) this.ALARMS |= 0x0080;
    if (!DI_ESTOP_OK) this.ALARMS |= 0x0001;

    if (!DI_ESTOP_OK) Q.HEATER = false;
    else if (IW_TEMP < this.TEMP_SP - 20) Q.HEATER = true;
    else if (IW_TEMP > this.TEMP_SP + 20) Q.HEATER = false;
    // ısınma bekçisi yalnızca ısıtıcı gerçekten sürülürken sayar: açılışta START beklenirken çıkış
    // kapalıdır (aşağıdaki maske), soğuyan ısıtıcı sahte "ısınmıyor" alarmı vermesin
    T.HEAT.call(Q.HEATER && !this.WAIT_START && IO_READY && IW_TEMP < this.TEMP_MIN && !this.RT_RESET.Q, now);
    if (T.HEAT.Q) this.ALARMS |= 0x0020;

    // dolum tankı seviyesi: ürün iste (vanayı ve pompayı tank istasyonu yönetir)
    if (!IO_READY) this.PRODUCT_REQ = false;   // ilk veri gelmeden seviye 0 görünür
    else if (IW_TANK < this.TANK_ON) this.PRODUCT_REQ = true;
    else if (IW_TANK > this.TANK_OFF) this.PRODUCT_REQ = false;

    if (!IO_READY) this.ALARMS = ALARMS_BEFORE;

    // 3. Mod yönetimi
    const ALARM_ANY = (this.ALARMS & 0x00ff) !== 0;
    if (ALARM_ANY) {
      this.MODE = (!DI_ESTOP_OK || this.MODE === 4 || (this.ALARMS & 0x0001) !== 0) ? 4 : 3;
    }
    if (ALARM_ANY && !this.ALARM_PREV) this.HORN_LATCH = true;
    this.ALARM_PREV = ALARM_ANY;

    if (this.RT_RESET.Q) {
      this.HORN_LATCH = false;
      this.FILL_WARN = false;
      if (DI_ESTOP_OK && !COMM_FAULT) {
        this.ALARMS = 0;
        if (this.MODE === 3 || this.MODE === 4) {
          if (this.FILL_SUB !== 9 && TR_CUP[2]) TR_BAD[2] = true;
          if (this.FOIL_SUB !== 9 && TR_CUP[3]) TR_BAD[3] = true;
          if (this.SEAL_SUB !== 9 && TR_CUP[4]) TR_BAD[4] = true;
          this.DROP_SUB = 9; this.FILL_SUB = 9; this.FOIL_SUB = 9; this.SEAL_SUB = 9;
          if (this.CHK_SUB !== 9) this.CHK_SUB = 0;
          if (this.REJ_SUB === 2) { this.REJ_CNT++; TR_CUP[6] = false; this.REJ_SUB = 9; }
          else if (this.REJ_SUB !== 9) this.REJ_SUB = 0;
          if (this.CYC === 11) this.CYC = 10;
          this.MODE = 0;
        }
      }
    }

    if (this.MODE === 0 && this.RT_START.Q && IO_READY && !RESTART && DI_STOP_OK) this.MODE = 1;
    if (this.MODE === 2 && this.RT_START.Q && IO_READY && !RESTART) this.MODE = 1;
    if (this.MODE === 1) this.WAIT_START = false;
    if (this.MODE === 1 && !DI_STOP_OK) this.MODE = 2;

    // 4. Endeks çevrimi
    const running = this.MODE === 1 || this.MODE === 2;
    T.IDX.call(running && (this.CYC === 10 || this.CYC === 11), now);
    if (T.IDX.Q) this.ALARMS |= 0x0002;

    if (running) {
      if (this.CYC === 0) {
        if (this.MODE === 2) this.MODE = 0;
        else if (!TEMP_OK) this.HEAT_WAIT = true;
        else if (TR_CUP[7] && DI_OUT_FULL) { this.HEAT_WAIT = false; this.OUT_WAIT = true; }
        else { this.HEAT_WAIT = false; this.OUT_WAIT = false; this.CYC = 10; }
      } else if (this.CYC === 10) {
        Q.CONV = true;
        if (!DI_INDEX) { Q.CONV = false; this.CYC = 11; }
      } else if (this.CYC === 11) {
        if (DI_INDEX) {
          if (this.PURGE > 0) this.PURGE--;
          for (let i = 7; i >= 1; i--) { TR_CUP[i] = TR_CUP[i - 1]; TR_BAD[i] = TR_BAD[i - 1]; }
          TR_CUP[0] = false; TR_BAD[0] = false;
          this.DROP_SUB = 0; this.FILL_SUB = 0; this.FOIL_SUB = 0;
          this.SEAL_SUB = 0; this.CHK_SUB = 0; this.REJ_SUB = 0;
          this.CYC = 20;
        }
      }
    }

    // 5. İstasyonlar
    T.DROP.call(this.DROP_SUB === 1, now);
    T.DROPWAIT.call(this.DROP_SUB === 2, now);
    T.NOZ.call(this.FILL_SUB === 1 || this.FILL_SUB === 5, now);
    T.FILL.call(this.FILL_SUB === 2 || this.FILL_SUB === 3, now);
    T.SETTLE.call(this.FILL_SUB === 4, now);
    T.FINE.call(this.FILL_SUB === 3, now);
    T.FOIL.call(this.FOIL_SUB === 1, now);
    T.SEALMV.call(this.SEAL_SUB === 1 || this.SEAL_SUB === 3, now);
    T.DWELL.call(this.SEAL_SUB === 2, now);
    T.CHK.call(this.CHK_SUB === 1, now);
    T.REJ.call(this.REJ_SUB === 1, now);
    T.RET.call(this.REJ_SUB === 2, now);

    if ((this.MODE === 1 || this.MODE === 2) && this.CYC === 20) {
      // Cep 0: bardak besleme
      if (this.DROP_SUB === 0) {
        if (this.MODE === 1 && !DI_CUP_EMPTY) { Q.CUP_DROP = true; this.DROP_SUB = 1; }
        else this.DROP_SUB = 9;
      } else if (this.DROP_SUB === 1) {
        if (T.DROP.Q) { Q.CUP_DROP = false; TR_CUP[0] = true; this.DROP_SUB = 2; }
      } else if (this.DROP_SUB === 2) {
        if (T.DROPWAIT.Q) this.DROP_SUB = 9;
      }

      // Cep 2: terazili dolum
      switch (this.FILL_SUB) {
        case 0:
          TR_CUP[2] = DI_CUP_AT_FILL;
          if (!DI_CUP_AT_FILL) this.FILL_SUB = 9;
          else if (!DI_TANK_LOW) { Q.NOZ_DN = true; this.FILL_SUB = 1; }
          break;
        case 1:
          if (DI_NOZ_DN) { Q.FILL_FAST = true; this.FILL_SUB = 2; }
          else if (T.NOZ.Q) this.ALARMS |= 0x0004;
          break;
        case 2:
          if (IW_FILL >= this.FILL_TARGET - this.COARSE_MARGIN) { Q.FILL_FAST = false; Q.FILL_FINE = true; this.FILL_SUB = 3; }
          break;
        case 3:
          if (IW_FILL >= this.FILL_TARGET - this.PREACT) {
            Q.FILL_FINE = false;
            if (T.FINE.ET < 500) this.COARSE_MARGIN = Math.min(1200, this.COARSE_MARGIN + 100);
            else if (T.FINE.ET > 2500) this.COARSE_MARGIN = Math.max(200, this.COARSE_MARGIN - 20);
            this.FILL_SUB = 4;
          }
          break;
        case 4:
          if (T.SETTLE.Q) {
            this.FILL_ERR = IW_FILL - this.FILL_TARGET;
            if (Math.abs(this.FILL_ERR) < 100) {
              this.PREACT += Math.trunc(this.FILL_ERR / 2);
              this.PREACT = Math.max(0, Math.min(150, this.PREACT));
            }
            if (Math.abs(this.FILL_ERR) > this.FILL_TOL) TR_BAD[2] = true;
            Q.NOZ_DN = false;
            this.FILL_SUB = 5;
          }
          break;
        case 5:
          if (DI_NOZ_UP) this.FILL_SUB = 9;
          else if (T.NOZ.Q) this.ALARMS |= 0x0004;
          break;
      }
      if (T.FILL.Q && (this.FILL_SUB === 2 || this.FILL_SUB === 3)) {
        Q.FILL_FAST = false; Q.FILL_FINE = false; TR_BAD[2] = true;
        this.FILL_WARN = true; Q.NOZ_DN = false; this.FILL_SUB = 5;
      }

      // Cep 3: folyo
      if (this.FOIL_SUB === 0) {
        if (!TR_CUP[3]) this.FOIL_SUB = 9;
        else if (DI_FOIL_EMPTY) this.ALARMS |= 0x0010;
        else { Q.FOIL = true; this.FOIL_SUB = 1; }
      } else if (this.FOIL_SUB === 1) {
        if (T.FOIL.Q) { Q.FOIL = false; this.FOIL_SUB = 9; }
      }

      // Cep 4: ısıl kapama
      switch (this.SEAL_SUB) {
        case 0:
          if (!TR_CUP[4]) this.SEAL_SUB = 9;
          else if (!DI_FOIL_AT_SEAL || !TEMP_OK) { TR_BAD[4] = true; this.SEAL_SUB = 9; }
          else { Q.SEAL_DN = true; this.SEAL_SUB = 1; }
          break;
        case 1:
          if (DI_SEAL_DN) this.SEAL_SUB = 2;
          else if (T.SEALMV.Q) this.ALARMS |= 0x0008;
          break;
        case 2:
          if (!TEMP_OK) TR_BAD[4] = true;
          if (T.DWELL.Q) { Q.SEAL_DN = false; this.SEAL_SUB = 3; }
          break;
        case 3:
          if (DI_SEAL_UP) this.SEAL_SUB = 9;
          else if (T.SEALMV.Q) this.ALARMS |= 0x0008;
          break;
      }

      // Cep 5: kontrol tartısı
      if (this.CHK_SUB === 0) {
        this.CHK_SUB = TR_CUP[5] ? 1 : 9;
      } else if (this.CHK_SUB === 1 && T.CHK.Q) {
        if (IW_CHECK < 20) TR_CUP[5] = false;
        else if (Math.abs(IW_CHECK - this.TARE - this.FILL_TARGET) > this.FILL_TOL) TR_BAD[5] = true;
        this.CHK_SUB = 9;
      }

      // Cep 6: red
      // Reconstruct presence at the reject photocell for the six pre-restart indices.
      if (this.REJ_SUB === 0 && this.PURGE > 0 && DI_CUP_AT_REJ) { TR_CUP[6] = true; TR_BAD[6] = true; }
      switch (this.REJ_SUB) {
        case 0:
          if (!TR_CUP[6]) this.REJ_SUB = 9;
          else if (TR_BAD[6]) { Q.REJECT = true; this.REJ_SUB = 1; }
          else { this.GOOD_CNT++; this.REJ_SUB = 9; }
          break;
        case 1:
          if (DI_REJ_EXT) { Q.REJECT = false; this.REJ_SUB = 2; }
          else if (T.REJ.Q) this.ALARMS |= 0x0040;
          break;
        case 2:
          if (T.RET.Q) { this.REJ_CNT++; TR_CUP[6] = false; TR_BAD[6] = false; this.REJ_SUB = 9; }
          break;
      }

      if ([this.DROP_SUB, this.FILL_SUB, this.FOIL_SUB, this.SEAL_SUB, this.CHK_SUB, this.REJ_SUB]
        .every((s) => s === 9)) this.CYC = 0;
    }

    // 6. Alarmda hareketleri durdur
    if (this.MODE === 3 || this.MODE === 4) {
      Q.CONV = Q.CUP_DROP = Q.NOZ_DN = Q.FILL_FAST = Q.FILL_FINE = false;
      Q.FOIL = Q.SEAL_DN = Q.REJECT = false;
    }

    // 7. Kule lambası
    T.BLINK_A.call(!this.BLINK, now);
    if (T.BLINK_A.Q) this.BLINK = true;
    T.BLINK_B.call(this.BLINK, now);
    if (T.BLINK_B.Q) this.BLINK = false;

    let WARNS = 0;
    if (DI_CUP_EMPTY) WARNS |= 0x0100;
    if (DI_TANK_LOW) WARNS |= 0x0200;
    if (this.FILL_WARN) WARNS |= 0x0400;
    if (this.OUT_WAIT && this.MODE === 1) WARNS |= 0x0800;

    Q.GREEN = this.MODE === 1 && !this.HEAT_WAIT && !this.OUT_WAIT;
    Q.YELLOW = WARNS !== 0 || this.MODE === 2 || (this.HEAT_WAIT && this.MODE === 1 && this.BLINK)
      || (this.MODE === 0 && !TEMP_OK && this.BLINK);
    Q.RED = (this.MODE === 3 || this.MODE === 4) && (this.BLINK || !this.HORN_LATCH);
    Q.HORN = this.HORN_LATCH;

    // 8. Çıkışları paketle
    const order = ['CONV', 'CUP_DROP', 'NOZ_DN', 'FILL_FAST', 'FILL_FINE', 'FOIL', 'SEAL_DN',
      'HEATER', 'REJECT', 'RESERVED9', 'GREEN', 'YELLOW', 'RED', 'HORN'];
    let QW_DO = order.reduce((w, k, i) => (Q[k] ? w | (1 << i) : w), 0);
    // OEE için bekleme nedeni: 7 ürün yok (dolumda bardak var, tank alt seviyede),
    // 8 bardak yok (magazin boş ve zincir boşaldı)
    const LINE_EMPTY = !TR_CUP.some(Boolean);
    let QW_STATE = this.MODE;
    if (this.MODE === 1 && this.HEAT_WAIT) QW_STATE = 5;
    else if (this.MODE === 1 && this.OUT_WAIT) QW_STATE = 6;
    else if (this.MODE === 1 && this.CYC === 20 && this.FILL_SUB === 0 && DI_CUP_AT_FILL && DI_TANK_LOW) QW_STATE = 7;
    else if (this.MODE === 1 && DI_CUP_EMPTY && LINE_EMPTY) QW_STATE = 8;
    // sayaçlar 0..30000 sarar (izleme katmanı bu kurala göre fark alır)
    if (this.GOOD_CNT > 30000) this.GOOD_CNT = 0;
    if (this.REJ_CNT > 30000) this.REJ_CNT = 0;
    if (this.WAIT_START || !IO_READY) {
      QW_DO = 0;
      Q.HEATER = false;
    }
    const QW_STATUS = this.WAIT_START ? 0x0080 : 0;
    return { QW_STATUS,
      QW_DO, QW_STATE, QW_ALARM: this.ALARMS | WARNS, QW_GOOD: this.GOOD_CNT, QW_REJECT: this.REJ_CNT,
      RUNNING: this.MODE === 1, PRODUCT_REQ: !!this.PRODUCT_REQ,
    };
  }
}
