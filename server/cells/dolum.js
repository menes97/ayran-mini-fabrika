// Dolum-kapama makinesinin proses modeli (fabrikanın 1. bloğu).
// Yalnızca fiziksel davranışı modeller; karar vermez. Bütün kararlar PLC'dedir.
// Ortak durumlar (zaman, arızalar, KPI, olay günlüğü, acil stop, çıkış bandı) fabrikadan gelir.
import { SPEC, bitOf, packBits } from '../../public/iomap.js';

const N = SPEC.pockets;
const ST = SPEC.station;

const C = {
  indexTime: 0.6,        // s, bir adım
  dropTime: 0.28,        // s, bardağın magazinden cebe düşüşü
  foilCycle: 0.5,        // s, folyo kolunun gidiş-dönüşü
  nozzleTravel: 0.35,    // s
  sealerTravel: 0.3,     // s
  rejectTravel: 0.15,    // s
  coarseFlow: 150,       // g/s
  fineFlow: 15,          // g/s
  valveTau: 0.05,        // s, vana tepki zamanı
  leakFlow: 4,           // g/s, kaçak arızasında
  cupCapacity: 245,      // g, üstü taşar
  tankCap: 60,           // kg
  tankLowPct: 10,
  ambient: 25,           // °C
  heaterEq: 265,         // °C, ısıtıcı sürekli açıkken dengelendiği sıcaklık
  heatTau: 14,           // s
  sealMin: 165, sealMax: 228, burnT: 240,
  sealNeed: 0.6,         // s, iyi kapama için gereken temas süresi
  scaleNoise: 0.15,      // g
  scaleTau: 0.08,        // s
};

const LAMPS = 0b11110000000000;   // kule lambası ve korna acil stopta da beslenir

const smooth = (x) => x * x * (3 - 2 * x);
const approach = (v, target, rate, dt) =>
  v < target ? Math.min(target, v + rate * dt) : Math.max(target, v - rate * dt);

export class DolumCell {
  constructor(fab) {
    this.fab = fab;
    this.reset();
  }

  get t() { return this.fab.t; }
  get rng() { return this.fab.rng; }
  get faults() { return this.fab.faults; }
  get kpi() { return this.fab.kpi; }
  get estop() { return this.fab.estop; }
  log(text, level) { this.fab.log(text, level); }

  reset() {
    this.nextId = 1;
    this.pockets = Array(N).fill(null);
    this.falling = [];       // magazinden düşen bardaklar
    this.done = [];          // sevk edilen ve reddedilen son bardaklar (görselleştirme için)
    this.phase = 0;
    this.moving = false;
    this.moveT = 0;
    this.cupMag = 60;
    this.foilMag = 80;
    this.nozzle = 0;
    this.sealer = 0;
    this.reject = 0;
    this.foilArm = -1;       // -1 boşta, 0..1 çevrim ilerlemesi
    this.foilCarry = false;
    this.flow = 0;
    this.spillFlow = 0;
    this.tankKg = 27;
    this.tankComp = { p: 1, w: 0, c: 0 };   // dolum tankındaki sıvının bileşimi
    // hat takibi: dolum tankındaki sıvı hangi aktarımlardan geldi (kg). Tam karışmış tank:
    // her çekişte her aktarımdan payı oranında eksilir. 0 = açılıştaki başlangıç stoku.
    this.tankMix = new Map([[0, this.tankKg]]);
    this.fab.emit('transfer_start', { transfer: 0, lot: 0, initial: true });
    this.fab.emit('transfer_end', { transfer: 0, lot: 0, kg: this.tankKg, initial: true });
    this.temp = C.ambient;
    this.fillScale = 0;
    this.checkScale = 0;
    this.out = 0;            // PLC'den gelen çıkış kelimesi (acil stop maskesi uygulanmış)
    this.prevOut = 0;
  }

  get level() { return (this.tankKg / C.tankCap) * 100; }

  // Tank istasyonundan gelen sıvı: bileşim karışarak izlenir (su seyreltir, kostik bulaştırır)
  receive(kg, comp, transfer = 0) {
    const total = this.tankKg + kg;
    for (const k of ['p', 'w', 'c']) this.tankComp[k] = (this.tankComp[k] * this.tankKg + comp[k] * kg) / total;
    this.tankMix.set(transfer, (this.tankMix.get(transfer) || 0) + kg);
    this.tankKg = total;
    if (this.tankKg > C.tankCap) {
      this.kpi.spilledKg += this.tankKg - C.tankCap;
      this.drawMix((this.tankKg - C.tankCap) * 1000);
      this.tankKg = C.tankCap;
    }
  }

  // tanktan g gram çekildi: her aktarımın payı oranında eksilir; çekilen payları döndürür
  drawMix(grams) {
    const total = [...this.tankMix.values()].reduce((a, b) => a + b, 0);
    const shares = [];
    if (total <= 0) return shares;
    const f = Math.min(1, grams / 1000 / total);
    for (const [id, kg] of this.tankMix) {
      shares.push([id, (kg / total) * grams]);
      const left = kg * (1 - f);
      if (left < 1e-4) this.tankMix.delete(id); else this.tankMix.set(id, left);
    }
    return shares;
  }
  get aligned() { return !this.moving; }

  get diWord() {
    const p = this.pockets;
    return packBits([
      !this.moving,
      this.cupMag === 0,
      this.aligned && p[ST.fill] !== null,
      this.nozzle < 0.03,
      this.nozzle > 0.97,
      this.foilMag === 0,
      this.aligned && !!p[ST.seal]?.foil,
      this.sealer < 0.03,
      this.sealer > 0.97,
      this.level < C.tankLowPct,
      this.aligned && p[ST.reject] !== null,
      this.reject > 0.95,
      this.fab.outfeed.full,
    ]);
  }

  // Blok 1 input register'ları (iomap IO.dolum.ir sırasıyla)
  get ir() {
    const clamp = (v) => Math.max(0, Math.min(32767, Math.round(v)));
    return [
      this.diWord,
      clamp(this.fillScale * 10),
      clamp(this.level * 10),
      clamp(this.temp * 10),
      clamp(this.checkScale * 10),
    ];
  }

  // ---- Simülasyon adımı ---------------------------------------------
  step(dt, doWord) {
    const out = this.estop ? doWord & LAMPS : doWord;   // acil stop rölesi aktüatör gücünü keser
    this.out = out;
    const q = (b) => bitOf(out, b);
    const rise = (b) => q(b) && !bitOf(this.prevOut, b);

    this.stepIndexer(dt, q(0));
    this.stepDrop(dt, rise(1));
    this.nozzle = approach(this.nozzle, q(2) && !this.faults.nozzleStuck ? 1 : 0, 1 / C.nozzleTravel, dt);
    this.stepFill(dt, q(3), q(4));
    this.stepFoil(dt, rise(5));
    this.sealer = approach(this.sealer, q(6) && !this.faults.sealerStuck ? 1 : 0, 1 / C.sealerTravel, dt);
    this.stepSeal(dt, q(7));
    this.stepReject(dt, q(8));
    this.stepScales(dt);
    this.prevOut = out;
  }

  stepIndexer(dt, run) {
    if (!this.moving && run && !this.faults.jam && !this.estop) { this.moving = true; this.moveT = 0; }
    if (!this.moving) return;
    if (this.faults.jam || this.estop) return;   // fren tutar, hareket durur
    this.moveT += dt;
    this.phase = smooth(Math.min(1, this.moveT / C.indexTime));
    if (this.moveT >= C.indexTime) {
      this.phase = 0;
      this.moving = false;
      this.shift();
    }
  }

  shift() {
    const last = this.pockets[N - 1];
    if (last) {
      if (this.fab.outfeed.full) {
        // dolu banda itilen bardak ezilir
        this.kpi.lostCups++;
        this.emitCup(last, 'lost');
        this.log(`Bardak #${last.id} dolu çıkış bandına itildi, ezildi`, 'error');
      } else {
        this.finish(last, 'out');
        this.fab.outfeed.push(last);
      }
    }
    for (let i = N - 1; i > 0; i--) this.pockets[i] = this.pockets[i - 1];
    this.pockets[0] = null;
  }

  stepDrop(dt, trigger) {
    if (trigger) {
      if (this.faults.dropMiss && this.rng() < 0.35) {
        this.log('Bardak ayırıcı bardağı bırakmadı', 'warn');
      } else if (this.cupMag > 0) {
        this.cupMag--;
        this.falling.push({
          id: this.nextId++, product: 0, foil: false, sealT: 0, sealed: false,
          burnt: false, damaged: false, overfill: false, fall: 0,
        });
      }
    }
    for (const cup of this.falling) cup.fall += dt / C.dropTime;
    const landed = this.falling.filter((c) => c.fall >= 1);
    this.falling = this.falling.filter((c) => c.fall < 1);
    for (const cup of landed) {
      delete cup.fall;
      if (this.aligned && this.pockets[0] === null) {
        this.pockets[0] = cup;
      } else {
        this.kpi.lostCups++;
        this.log(`Bardak #${cup.id} cebe oturmadı, yere düştü`, 'warn');
      }
    }
  }

  stepFill(dt, fast, fine) {
    let cmd = fast ? C.coarseFlow : fine ? C.fineFlow : 0;
    if (this.tankKg < 0.2) cmd = 0;
    cmd *= 0.8 + 0.2 * Math.min(1, this.level / 100);   // tank yüksekliği basıncı etkiler
    this.flow += (cmd - this.flow) * Math.min(1, dt / C.valveTau);
    if (cmd === 0 && this.flow < 0.05) this.flow = 0;
    let flow = this.flow;
    if (this.faults.valveLeak && cmd === 0) flow = Math.max(flow, C.leakFlow);
    const grams = flow * dt;
    this.tankKg = Math.max(0, this.tankKg - grams / 1000);
    const shares = grams > 0 ? this.drawMix(grams) : [];

    const cup = this.pockets[ST.fill];
    this.spillFlow = 0;
    if (grams <= 0) return;
    if (this.aligned && cup) {
      cup.mix ??= {};
      for (const [id, g] of shares) cup.mix[id] = (cup.mix[id] || 0) + g;
      cup.fillT ??= this.fab.t;
      // bardağa giren sıvının bileşimi (dolum tankından)
      const w0 = cup.product;
      cup.water = ((cup.water || 0) * w0 + this.tankComp.w * grams) / (w0 + grams);
      cup.caustic = ((cup.caustic || 0) * w0 + this.tankComp.c * grams) / (w0 + grams);
      cup.product += grams;
      if (cup.product > C.cupCapacity) {
        const over = cup.product - C.cupCapacity;
        cup.product = C.cupCapacity;
        cup.overfill = true;
        this.kpi.spilledKg += over / 1000;
        this.spillFlow = flow;
      }
    } else {
      this.kpi.spilledKg += grams / 1000;
      this.spillFlow = flow;
    }
  }

  stepFoil(dt, trigger) {
    if (trigger && this.foilArm < 0) {
      this.foilArm = 0;
      this.foilCarry = this.foilMag > 0;
      if (this.foilCarry) this.foilMag--;
    }
    if (this.foilArm < 0) return;
    const before = this.foilArm;
    this.foilArm += dt / C.foilCycle;
    if (before < 0.5 && this.foilArm >= 0.5 && this.foilCarry) {
      const cup = this.pockets[ST.foil];
      if (this.aligned && cup && !cup.foil) cup.foil = true;
      else { this.kpi.foilWasted++; this.log('Folyo boş cebe bırakıldı', 'warn'); }
      this.foilCarry = false;
    }
    if (this.foilArm >= 1) this.foilArm = -1;
  }

  stepSeal(dt, heater) {
    const heating = heater && !this.faults.heaterFail && !this.estop;
    this.temp += ((heating ? C.heaterEq : C.ambient) - this.temp) * (dt / C.heatTau);
    const cup = this.pockets[ST.seal];
    if (this.sealer > 0.95 && this.aligned && cup) {
      this.temp -= 4 * dt;                      // bardak ısıyı çeker
      if (!cup.foil) {
        if (!cup.damaged) this.log(`Bardak #${cup.id}: folyosuz kapama, ağız eridi`, 'warn');
        cup.damaged = true;
      } else {
        cup.sealC = this.temp;                  // kapama kafasının termokuplu (temas anındaki son değer)
        if (this.temp >= C.sealMin && this.temp <= C.sealMax) cup.sealT += dt;
        if (this.temp > C.burnT) cup.burnt = true;
        if (cup.sealT >= C.sealNeed) cup.sealed = true;
      }
    }
  }

  stepReject(dt, push) {
    this.reject = approach(this.reject, push && !this.faults.rejectStuck ? 1 : 0, 1 / C.rejectTravel, dt);
    const cup = this.pockets[ST.reject];
    if (this.reject > 0.6 && this.aligned && cup) {
      this.pockets[ST.reject] = null;
      this.finish(cup, 'reject');
    }
  }

  stepScales(dt) {
    const noise = () => (this.rng() - 0.5) * 2 * C.scaleNoise;
    const fillCup = this.aligned ? this.pockets[ST.fill] : null;
    const checkCup = this.aligned ? this.pockets[ST.check] : null;
    const drift = this.faults.scaleDrift ? 8 : 0;   // kalibrasyon kayması: kontrol tartısı yakalamalı
    const fillRaw = (fillCup ? fillCup.product : 0) + drift + noise();
    const checkRaw = checkCup
      ? SPEC.cupTare + (checkCup.foil ? SPEC.foilMass : 0) + checkCup.product + noise()
      : noise();
    const k = Math.min(1, dt / C.scaleTau);
    this.fillScale += (fillRaw - this.fillScale) * k;
    this.checkScale += (checkRaw - this.checkScale) * k;
    // kontrol tartısının bardak başına kaydı (net = brüt − dara − folyo): cep durduğu sürece son değer
    if (checkCup) checkCup.checkG = this.checkScale - SPEC.cupTare - (checkCup.foil ? SPEC.foilMass : 0);
  }

  quality(cup) {
    const err = cup.product - SPEC.targetNet;
    if (cup.caustic > 1e-4) return 'KOSTİK BULAŞMASI';
    if (cup.water > 0.05) return `sulanmış (%${(cup.water * 100).toFixed(0)} su)`;
    if (cup.damaged) return 'bardak ağzı eridi';
    if (cup.overfill) return 'taştı';
    if (!cup.foil) return 'folyo yok';
    if (cup.burnt) return 'folyo yandı';
    if (!cup.sealed) return 'kapama zayıf';
    if (Math.abs(err) > SPEC.tolerance) return `dolum ${err > 0 ? '+' : ''}${err.toFixed(1)} g`;
    return null;
  }

  // hat takip olayı: bardağın ölçülen değerleri ve hangi aktarımlardan dolduğu (pay ≥ %0,5)
  emitCup(cup, result) {
    const total = Object.values(cup.mix || {}).reduce((a, b) => a + b, 0);
    const transfers = Object.entries(cup.mix || {})
      .map(([id, g]) => ({ id: +id, frac: +(g / total).toFixed(4) })).filter((x) => x.frac >= 0.005);
    this.fab.emit('cup', {
      cup: cup.id, tFill: cup.fillT ?? null, result,
      netG: cup.checkG != null ? +cup.checkG.toFixed(1) : null,
      sealC: cup.sealC != null ? +cup.sealC.toFixed(1) : null,
      transfers, simDefect: this.quality(cup),
    });
  }

  finish(cup, where) {
    this.emitCup(cup, where);
    const defect = this.quality(cup);
    cup.defect = defect;
    cup.where = where;
    if (where === 'out') {
      if (defect) { this.kpi.shippedBad++; this.log(`HATALI ÜRÜN SEVK EDİLDİ: #${cup.id} (${defect})`, 'error'); }
      else this.kpi.shippedGood++;
    } else {
      if (defect) this.kpi.rejectedBad++;
      else { this.kpi.rejectedGood++; this.log(`Sağlam bardak gereksiz reddedildi: #${cup.id}`, 'warn'); }
      this.done.push(cup);
      if (this.done.length > 40) this.done.shift();
    }
  }

  // ---- Arayüz komutları ---------------------------------------------
  command(msg) {
    if (msg.type === 'refill') {
      if (msg.name === 'cups') this.cupMag = 60;
      if (msg.name === 'foil') this.foilMag = 80;
      this.log(msg.name === 'cups' ? 'Bardak magazini dolduruldu' : 'Folyo magazini dolduruldu');
    }
    if (msg.type === 'resetKpi') this.done = [];
  }

  snapshot() {
    return {
      phase: this.phase,
      moving: this.moving,
      pockets: this.pockets.map(cupView),
      falling: this.falling.map((c) => ({ ...cupView(c), fall: c.fall })),
      done: this.done.map((c) => ({ ...cupView(c), where: c.where, defect: c.defect })),
      cupMag: this.cupMag,
      foilMag: this.foilMag,
      nozzle: this.nozzle,
      sealer: this.sealer,
      reject: this.reject,
      foilArm: this.foilArm,
      foilCarry: this.foilCarry,
      flow: this.flow,
      spillFlow: this.spillFlow,
      level: this.level,
      tankComp: this.tankComp,
      temp: this.temp,
      fillScale: this.fillScale,
      checkScale: this.checkScale,
      di: this.diWord,
      do: this.out,
    };
  }
}

export const cupView = (c) => c && {
  id: c.id, product: +c.product.toFixed(1), foil: c.foil, sealed: c.sealed,
  burnt: c.burnt, damaged: c.damaged, overfill: c.overfill,
};
