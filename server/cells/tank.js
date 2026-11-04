// Tank ve transfer istasyonunun proses modeli (fabrikanın 2. bloğu).
// Üretim tankı T1 → pompa P1 → debimetre FT1 → dolum tankı, ve aynı hat üzerinden CIP:
// su / kostik kaynakları, gider ve kostik dönüşü. Karar vermez; vanaları ve pompayı PLC sürer.
//
// Basitleştirmeler (README'de de yazılı):
// - Hat 6 kg; seri bağlı 6 küçük karışım hacmiyle modellenir (dağılımlı tıkaç akış), faz geçişleri ~3 s gecikir.
// - Debi kg/s; boru çapı ve akış hızı (m/s) modellenmez. Yerçekimiyle akış yok.
// - Isıtma demo için hızlandırılmış (gerçekte 300 kg kostiği ısıtmak ~20 kWh, dakikalar sürer).
// - "Kir" skoru mikrobiyoloji modeli değildir; yalnızca CIP'in koşulları sağlayıp sağlamadığını puanlar.
import { bitOf, packBits } from '../../public/iomap.js';

const C = {
  prodCap: 1000, prodStart: 600, prodLowKg: 30,     // kg
  causticCap: 300, causticStart: 240, causticLowPct: 30,
  pumpFlow: 2.0, pumpTau: 0.6,                       // kg/s, s
  lineKg: 6,                                         // hattaki sıvı
  lineCells: 6,                                      // seri karışım hacmi sayısı
  valveStroke: 0.8,                                  // s
  prodT: 6, waterT: 18, ambient: 20,                 // °C
  heaterEq: 95, heatTau: 90, coolTau: 900,           // demo ölçeği
  cond25: { p: 9.0, w: 0.4, c: 80 },                 // mS/cm, 25 °C'de
  dryTrip: 8,                                        // s, kuru çalışmada motor koruma
  soilPerKg: 1 / 60,                                 // 60 kg üründen sonra kir skoru 1
  cleanTime: 20,                                     // s, tam kir için gereken etkili kostik süresi
};

// Vana sırası DO bitleriyle aynı: 1 V_PROD, 2 V_WATER, 3 V_CAUSTIC, 4 V_FILL, 5 V_DRAIN, 6 V_CIPRET
const VALVES = ['prod', 'water', 'caustic', 'fill', 'drain', 'cipret'];
const approach = (v, target, rate, dt) =>
  v < target ? Math.min(target, v + rate * dt) : Math.max(target, v - rate * dt);

export class TankCell {
  constructor(fab) {
    this.fab = fab;
    this.prodKg = C.prodStart;
    this.causticKg = C.causticStart;
    this.causticStrength = 1;          // 1 = taze %1,5 NaOH; dönen su seyreltir
    this.causticT = 70;                // tank sıcak başlar; ısıtıcı açık tutulmazsa soğur
    this.valve = Object.fromEntries(VALVES.map((v) => [v, 0]));
    this.flow = 0;
    // hat bölümleri girişten çıkışa; ilk açılışta hat suyla dolu
    this.line = Array.from({ length: C.lineCells }, () => ({ p: 0, w: 1, c: 0 }));
    this.lineT = C.waterT;
    this.total = 0;                    // 0,1 kg birimli toplayıcı, 30000'de sıfırlanır
    this.totalAcc = 0;
    this.soil = 0;
    this.dryT = 0;
    this.tripped = false;
    this.out = 0;
    this.buttons = { cipStart: false, cipAbort: false };
    // hat takibi: üretim tankı partisi (her doldurmada yeni) ve dolum tankına aktarımlar
    this.lot = 1;
    this.xfer = null;                  // süren aktarım: { id, lot, kg, last }
    this.nextXfer = 1;
    fab.emit('lot', { lot: this.lot, kg: this.prodKg });
  }

  // Dolum tankına ürün akıyor: aktarım numarasını döndürür. 2 s akış olmazsa aktarım biter;
  // parti değişirse yeni aktarım başlar (bir aktarım tek partiden gelir).
  noteFill(kg) {
    let x = this.xfer;
    if (x && x.lot !== this.lot) { this.endTransfer(); x = null; }
    if (!x) {
      x = this.xfer = { id: this.nextXfer++, lot: this.lot, kg: 0, last: this.fab.t };
      this.fab.emit('transfer_start', { transfer: x.id, lot: x.lot });
    }
    x.kg += kg;
    x.last = this.fab.t;
    return x.id;
  }

  endTransfer() {
    const x = this.xfer;
    if (!x) return;
    this.fab.emit('transfer_end', { transfer: x.id, lot: x.lot, kg: +x.kg.toFixed(2) });
    this.xfer = null;
  }

  get faults() { return this.fab.faults; }
  get kpi() { return this.fab.kpi; }
  log(text, level) { this.fab.log(text, level); }

  closed(v) { return this.valve[v] < 0.02; }
  open(v) { return this.valve[v] > 0.5; }
  get lineComp() { return this.line[this.line.length - 1]; }   // ölçüm hattın çıkışında
  get pumpRunning() { return bitOf(this.out, 0) && !this.tripped; }
  get prodLevel() { return (this.prodKg / C.prodCap) * 100; }
  get causticLevel() { return (this.causticKg / C.causticCap) * 100; }

  // 25 °C'ye düzeltilmiş iletkenlik (gerçek transmitterler de bunu verir)
  get cond() {
    const k = C.cond25, m = this.lineComp;
    return m.p * k.p + m.w * k.w + m.c * k.c;
  }

  get diWord() {
    return packBits([
      this.prodKg < C.prodLowKg,
      this.buttons.cipStart,
      this.buttons.cipAbort,
      this.pumpRunning,
      this.tripped,
      ...VALVES.map((v) => this.closed(v)),
      this.faults.vFillLeak && this.pumpRunning,   // çift oturmalı vananın kaçak odası
    ]);
  }

  get ir() {
    const clamp = (v) => Math.max(0, Math.min(32767, Math.round(v)));
    const flowMeas = this.faults.flowmeterFail ? 0 : this.flow;
    return [
      this.diWord,
      clamp(this.prodLevel * 10),
      clamp(flowMeas * 100),
      this.total,
      clamp(this.cond * 10),
      clamp(this.lineT * 10),
      clamp(this.causticT * 10),
      clamp(this.causticLevel * 10),
    ];
  }

  step(dt, doWord) {
    const out = this.fab.estop ? 0 : doWord;      // acil stop rölesi pompa ve vanaların gücünü keser
    this.out = out;
    if (this.faults.pumpTrip && bitOf(out, 0) && !this.tripped) {
      this.tripped = true;
      this.log('Transfer pompası motor koruması attı', 'warn');
    }
    if (this.tripped && this.fab.buttons.reset && !this.faults.pumpTrip) this.tripped = false;

    // vanalar: strok süresiyle açılır/kapanır; dolum vanası açık takılabilir
    VALVES.forEach((v, i) => {
      let cmd = bitOf(out, i + 1) ? 1 : 0;
      if (v === 'fill' && this.faults.vFillStuck) cmd = 1;
      this.valve[v] = approach(this.valve[v], cmd, 1 / C.valveStroke, dt);
    });

    // kaynaklar ve hedefler
    const src = [];
    if (this.open('prod') && this.prodKg > 0.5) src.push({ id: 'prod', comp: { p: 1, w: 0, c: 0 }, T: C.prodT });
    if (this.open('water')) src.push({ id: 'water', comp: { p: 0, w: 1, c: 0 }, T: C.waterT });
    if (this.open('caustic') && this.causticKg > 5) {
      src.push({ id: 'caustic', comp: { p: 0, w: 1 - this.causticStrength, c: this.causticStrength }, T: this.causticT });
    }
    const dst = ['fill', 'drain', 'cipret'].filter((v) => this.open(v));
    const target = this.pumpRunning && src.length && dst.length ? C.pumpFlow : 0;
    this.flow += (target - this.flow) * Math.min(1, dt / C.pumpTau);
    if (target === 0 && this.flow < 0.01) this.flow = 0;

    // kuru çalışma: pompa döner ama sıvı yok
    this.dryT = this.pumpRunning && this.flow < 0.2 ? this.dryT + dt : 0;
    if (this.dryT > C.dryTrip && !this.tripped) {
      this.tripped = true;
      this.log('Pompa kuru çalıştı, motor koruması attı', 'warn');
    }

    const kg = this.flow * dt;
    if (kg > 0 && src.length) {
      const inComp = { p: 0, w: 0, c: 0 };
      let inT = 0;
      for (const s of src) {
        for (const k of ['p', 'w', 'c']) inComp[k] += s.comp[k] / src.length;
        inT += s.T / src.length;
        const share = kg / src.length;
        if (s.id === 'prod') this.prodKg = Math.max(0, this.prodKg - share);
        if (s.id === 'caustic') this.causticKg = Math.max(0, this.causticKg - share);
      }
      // hatta karışım: giren sıvı her bölümü bir sonrakine iter
      const k = Math.min(1, kg / (C.lineKg / C.lineCells));
      for (let i = this.line.length - 1; i >= 0; i--) {
        const from = i === 0 ? inComp : this.line[i - 1];
        for (const key of ['p', 'w', 'c']) this.line[i][key] += (from[key] - this.line[i][key]) * k;
      }
      this.lineT += (inT - this.lineT) * Math.min(1, dt / 3);

      // hattan çıkan sıvı (bileşimi hattaki karışımla aynı)
      const m = this.lineComp;
      const part = kg / dst.length;
      for (const d of dst) {
        if (d === 'fill') {
          this.fab.dolum.receive(part, m, this.noteFill(part));
          if (m.c > 1e-4) this.kpi.causticToProductKg += part * m.c;
          if (this.soil > 1.0) this.kpi.hygieneRiskKg += part * m.p;
        } else if (d === 'drain') {
          this.kpi.drainProductKg += part * m.p;
          this.kpi.causticLostKg += part * m.c;
        } else {
          // kostik tankına dönüş: dönen su kostiği seyreltir
          const causticPart = this.causticKg * this.causticStrength + part * m.c;
          this.causticKg = Math.min(C.causticCap, this.causticKg + part);
          this.causticStrength = this.causticKg > 0 ? Math.min(1, causticPart / this.causticKg) : 1;
          this.kpi.drainProductKg += part * m.p;   // dönüşe kaçan ürün de kayıptır
        }
      }

      // gizli kir skoru: ürün geçtikçe artar, yalnızca koşulları sağlayan kostik temizler
      this.soil += kg * m.p * C.soilPerKg;
      if (m.c > 0.75 && this.lineT >= 70 && this.flow >= 1.5) this.soil = Math.max(0, this.soil - dt / C.cleanTime);

      // debimetre toplayıcısı
      if (!this.faults.flowmeterFail) {
        this.totalAcc += kg * 10;
        const whole = Math.floor(this.totalAcc);
        this.totalAcc -= whole;
        this.total = (this.total + whole) % 30000;
      }
    } else {
      this.lineT += (C.ambient - this.lineT) * Math.min(1, dt / 60);
    }

    if (this.xfer && this.fab.t - this.xfer.last > 2) this.endTransfer();

    // kostik tankı ısıtıcısı
    const heating = bitOf(out, 7) && !this.faults.causticHeaterFail && this.causticLevel > C.causticLowPct;
    this.causticT += ((heating ? C.heaterEq : C.ambient) - this.causticT) * (dt / (heating ? C.heatTau : C.coolTau));
  }

  command(msg) {
    if (msg.type === 'button' && msg.name in this.buttons) this.buttons[msg.name] = !!msg.value;
    if (msg.type === 'refill' && msg.name === 'prod') {
      this.prodKg = C.prodCap * 0.9; this.lot++;
      this.fab.emit('lot', { lot: this.lot, kg: this.prodKg });
      this.log(`Üretim tankı dolduruldu (parti ${this.lot})`);
    }
    if (msg.type === 'refill' && msg.name === 'caustic') {
      this.causticKg = C.causticCap * 0.85; this.causticStrength = 1; this.log('Kostik tankı tazelendi');
    }
    if (msg.type === 'fault' && msg.name === 'prodEmpty' && msg.value) this.prodKg = 3;
  }

  snapshot() {
    return {
      prodLevel: this.prodLevel, causticLevel: this.causticLevel, causticT: this.causticT,
      causticStrength: this.causticStrength, flow: this.flow, cond: this.cond, lineT: this.lineT,
      lineComp: this.lineComp, line: this.line, valve: this.valve, pump: this.pumpRunning, tripped: this.tripped,
      soil: this.soil, total: this.total, di: this.diWord, do: this.out,
    };
  }
}
