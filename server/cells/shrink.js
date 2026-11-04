// Gruplama, shrink sarma ve shrink fırını (fabrikanın 3. bloğu).
// Çıkış bandından gelen bardaklar tek şeritte 3'er 3'er toplanır, iki sıra karton altlık üstünde
// 2x3'lük paket olur, sleeve makinesinde filmle sarılır, fırından geçip çıkış bandına düşer.
// Karar vermez: kapıyı, iticileri, filmi, fırın bandını, ısıtıcıyı ve fanı PLC sürer.
//
// Basitleştirmeler:
// - Tek bölgeli fırın; hava dolaşımı ve paket yönü modellenmez.
// - Film ve ürün sıcaklığı birinci dereceden gecikmeyle hesaplanır. Eşikler (film 135 °C altında gevşek,
//   170 °C üstünde 2 s'den uzun kalırsa yanık, ürün +2 °C) bu projenin reçetesidir, genel standart değildir.
// - Isınma süreleri demo için hızlandırılmıştır.
import { bitOf, packBits } from '../../public/iomap.js';

const C = {
  laneCap: 3,
  laneEnter: 0.45,          // s, bardağın şeride girişi
  gateStroke: 0.4,          // s
  rowTravel: 0.6,           // s, sıra iticisi
  grpTravel: 1.0,           // s, grup iticisi
  padTime: 0.8,             // s, altlık yerleştirme
  wrapTime: 2.5,            // s, sarma çevrimi
  diverterTime: 0.25,       // s, çıkış ayırıcı stroku (0 kapalı, +1 geçir, -1 red)
  beltSpeed: 0.2,           // m/s
  packLen: 0.26,            // m
  gap: 0.04,                // m, iki paket arası en az boşluk
  tunnelEnd: 1.2,           // m, fırın 0..1.2
  coolEnd: 1.6,             // m, soğutma 1.2..1.6
  exitEnd: 2.3,             // m, çıkış bandının sonu
  exitCap: 2,               // çıkış bölümünde en çok paket
  ambient: 22,
  heaterEq: 235, heatTau: 40, coolTauFan: 60, coolTauNoFan: 300,
  otTrip: 210,              // °C, bağımsız aşırı sıcaklık kesmesi
  filmTau: 2.0, filmCoolTau: 4.0,
  cupTau: 600,              // s, ürün ısınması (yavaş)
  shrinkMin: 135, burnT: 170, burnTime: 2.0,
  warmLimit: 2.0,           // °C
  filmStart: 100,           // %
  filmPerPack: 0.5,         // %
  padsStart: 80,
};

const approach = (v, target, rate, dt) =>
  v < target ? Math.min(target, v + rate * dt) : Math.max(target, v - rate * dt);

export class ShrinkCell {
  constructor(fab) {
    this.fab = fab;
    this.lane = [];            // şeritteki bardaklar: { cup, enter: 0..1 }
    this.gate = 0;             // 0 açık, 1 kapalı
    this.rowP = 0;             // sıra iticisi 0 geride, 1 ileride
    this.grpP = 0;
    this.plate = { pad: false, padT: -1, rows: [] };   // rows: [[cup, cup, cup], ...]
    this.wrapper = { pack: null, busy: 0, done: false, fault: false };
    this.belt = [];            // fırın bandındaki paketler: { pack, s }
    this.temp = C.ambient;
    this.otTripped = false;
    this.film = C.filmStart;
    this.pads = C.padsStart;
    this.inCnt = 0; this.outCnt = 0; this.exitCnt = 0;
    this.rejectCnt = 0;
    this.diverter = 0;
    this.rejected = [];        // fiziksel karantina kasası; karar yalnız PLC çıkışında
    this.nextPack = 1;
    this.done = [];            // tüketiciye giden son paketler (görselleştirme)
    this.out = 0; this.prevOut = 0;
  }

  get faults() { return this.fab.faults; }
  get kpi() { return this.fab.kpi; }
  log(t, l) { this.fab.log(t, l); }

  // ---- paletleme robotunun alma noktası: çıkış bandının sonundaki paket ----
  get headAtPick() { return this.belt.find((b) => b.s >= C.exitEnd - 1e-6) || null; }
  takeHead() {
    const head = this.headAtPick;
    if (!head) return null;
    this.belt = this.belt.filter((b) => b !== head);
    this.exitCnt = (this.exitCnt + 1) % 30000;
    this.finish(head.pack);
    return head.pack;
  }

  // Test besleyici: alma noktasına sarılmış, sağlam bir paket koyar (paletleme hücresini
  // 6'lı paket üretimini beklemeden denemek için; gerçek hatta karşılığı yok)
  injectTestPack() {
    if (this.headAtPick) return false;
    const id = () => (this.testId = (this.testId ?? 900000) + 1);
    const cups = Array.from({ length: 6 }, () => ({ id: id(), product: 206, foil: true, sealed: true }));
    const pack = { id: id(), cups, pad: true, wrapped: true, filmT: 40, filmPeak: 160,
      burnT: 0, cupT: 6.5, suspect: false, test: true };
    this.belt.push({ s: C.exitEnd, pack });
    this.fab.emit('pack', { pack: pack.id, cups: [], pad: true, crushed: false, test: true });
    return true;
  }

  // ---- çıkış bandından bardak kabulü ----
  canAccept() {
    return this.gate < 0.05 && this.lane.length < C.laneCap && !this.lane.some((l) => l.enter < 1);
  }
  acceptCup(cup) {
    if (!this.canAccept()) return false;
    this.lane.push({ cup, enter: 0 });
    return true;
  }

  get laneFull() { return this.lane.length === C.laneCap && this.lane.every((l) => l.enter >= 1); }
  get exitPacks() { return this.belt.filter((b) => b.s >= C.coolEnd).length; }
  get exitFull() { return this.exitPacks >= C.exitCap; }
  get beltRunning() { return bitOf(this.out, 6) && !this.faults.beltStall && !this.fab.estop; }
  get fanRunning() { return bitOf(this.out, 8) && !this.faults.fanFail && !this.fab.estop; }

  get diWord() {
    const w = this.wrapper;
    return packBits([
      this.laneFull,
      this.rowP > 0.97, this.rowP < 0.03,
      this.grpP > 0.97, this.grpP < 0.03,
      this.plate.pad,
      this.pads <= 5,
      !w.busy && !w.fault && this.film > 0 && !w.pack,     // WRAP_READY: yeni paket alabilir
      w.busy > 0,
      w.done,
      w.fault,
      !!w.pack,
      this.fanRunning,
      this.beltRunning,
      this.otTripped,
      this.exitFull,
    ]);
  }

  get ir() {
    const clamp = (v) => Math.max(0, Math.min(32767, Math.round(v)));
    return [
      this.diWord,
      this.lane.filter((l) => l.enter >= 1).length,
      clamp(this.temp * 10),
      this.inCnt, this.outCnt,
      clamp(this.film * 10),
      this.pads,
      this.exitCnt,
      packBits([this.plate.rows.length >= 1, this.plate.rows.length >= 2]),
      packBits([this.belt.some(b => Math.abs(b.s - C.tunnelEnd) < 1e-6),
        this.diverter < -0.99, this.diverter > 0.99]),
      this.rejectCnt,
    ];
  }

  step(dt, doWord) {
    const out = this.fab.estop ? 0 : doWord;
    this.out = out;
    const prev = this.prevOut;
    const q = (b) => bitOf(out, b);
    const rise = (b) => q(b) && !bitOf(prev, b);
    this.prevOut = out;
    // Two mutually exclusive valves; no command (or both) closes the stop gate.
    const target = q(9) === q(10) ? 0 : q(10) ? -1 : 1;
    this.diverter = approach(this.diverter, target, 1 / C.diverterTime, dt);

    if (this.fab.buttons.reset) {
      if (this.otTripped && this.temp < C.otTrip - 20) this.otTripped = false;
      if (this.wrapper.fault && !this.faults.filmBreak) this.wrapper.fault = false;
    }

    // şerit girişi ve kapı
    for (const l of this.lane) l.enter = Math.min(1, l.enter + dt / C.laneEnter);
    this.gate = approach(this.gate, q(0) ? 1 : 0, 1 / C.gateStroke, dt);

    // altlık
    if (rise(3) && !this.plate.pad && this.plate.padT < 0 && this.pads > 0) { this.plate.padT = 0; this.pads--; }
    if (this.plate.padT >= 0) {
      this.plate.padT += dt / C.padTime;
      if (this.plate.padT >= 1) { this.plate.pad = true; this.plate.padT = -1; }
    }

    // sıra iticisi: şeritteki bardakları plakaya iter
    const rowBefore = this.rowP;
    this.rowP = approach(this.rowP, q(1) && !this.faults.rowStuck ? 1 : 0, 1 / C.rowTravel, dt);
    if (rowBefore < 0.6 && this.rowP >= 0.6) {
      if (this.gate < 0.9 && this.lane.some((l) => l.enter < 1)) {
        // kapı kapanmadan itildi: girmekte olan bardak sıkıştı
        const victim = this.lane.find((l) => l.enter < 1);
        this.lane = this.lane.filter((l) => l !== victim);
        this.kpi.lostCups++;
        this.fab.emit('cup_lost', { cup: victim.cup.id, where: 'gruplama' });
        this.log(`Gruplama: kapı kapanmadan itildi, bardak #${victim.cup.id} sıkışıp düştü`, 'error');
      }
      const row = this.lane.filter((l) => l.enter >= 1).map((l) => l.cup);
      this.lane = this.lane.filter((l) => l.enter < 1);
      if (row.length) {
        if (this.plate.rows.length >= 2) {
          this.kpi.lostCups += row.length;
          for (const c of row) this.fab.emit('cup_lost', { cup: c.id, where: 'gruplama' });
          this.log('Gruplama: plaka doluyken sıra itildi, bardaklar düştü', 'error');
        } else {
          this.plate.rows.push(row);
        }
      }
    }

    // grup iticisi: plakadaki paketi sarma makinesine iter
    const grpBefore = this.grpP;
    this.grpP = approach(this.grpP, q(2) && !this.faults.groupStuck ? 1 : 0, 1 / C.grpTravel, dt);
    if (grpBefore < 0.9 && this.grpP >= 0.9 && this.plate.rows.length) {
      const pack = {
        id: this.nextPack++, cups: this.plate.rows.flat(), pad: this.plate.pad, wrapped: false,
        filmT: C.ambient, filmPeak: C.ambient, burnT: 0, cupT: 6, suspect: false,
      };
      this.plate = { pad: false, padT: -1, rows: [] };
      const crushed = !!this.wrapper.pack;
      this.fab.emit('pack', { pack: pack.id, cups: pack.cups.map((c) => c.id), pad: pack.pad, crushed });
      if (crushed) {
        this.kpi.packsBad++;
        this.log(`Paket #${pack.id} dolu sarma makinesine itildi, ezildi`, 'error');
      } else {
        this.wrapper.pack = pack;
      }
    }

    // sarma makinesi: istek tutulur, bitince "bitti" istek düşene kadar kalır
    const w = this.wrapper;
    if (rise(4) && w.pack && !w.busy && !w.fault && this.film > 0) w.busy = dt;
    if (w.busy > 0) {
      w.busy += dt;
      if (this.faults.filmBreak && w.busy > C.wrapTime * 0.4) {
        w.busy = 0; w.fault = true;
        this.log('Sarma makinesi: film koptu', 'warn');
      } else if (w.busy >= C.wrapTime) {
        w.busy = 0; w.done = true; w.pack.wrapped = true;
        this.film = Math.max(0, this.film - C.filmPerPack);
      }
    }
    if (!q(4)) w.done = false;
    // bırakma izni + bant çalışıyor + giriş boş → paket fırın bandına
    const entryClear = !this.belt.some((b) => b.s < C.packLen + C.gap);
    if (q(5) && w.pack && !w.busy && this.beltRunning && entryClear) {
      this.belt.push({ pack: w.pack, s: 0 });
      // Entry photocell is at the transfer itself: no uncounted 0..0.05 m gap.
      this.inCnt = (this.inCnt + 1) % 30000;
      w.pack = null; w.done = false;
    }

    // fırın bandı: birikmeli (öndeki pakete dayanan paket durur)
    if (this.beltRunning) {
      const sorted = [...this.belt].sort((a, b) => b.s - a.s);
      let limit = C.exitEnd;
      for (const b of sorted) {
        const before = b.s;
        const atEntrySide = before <= C.tunnelEnd;
        const pass = q(9) && !q(10) && this.diverter > 0.99;
        const stop = atEntrySide && !pass ? Math.min(limit, C.tunnelEnd) : limit;
        b.s = Math.max(before, Math.min(before + C.beltSpeed * dt, stop));
        if (atEntrySide && b.s > C.tunnelEnd) {
          this.outCnt = (this.outCnt + 1) % 30000;
          this.fab.emit('pack_pass', { pack: b.pack.id });
        }
        if (atEntrySide && b.s === C.tunnelEnd && q(10) && !q(9) && this.diverter < -0.99) {
          this.belt = this.belt.filter(item => item !== b);
          this.outCnt = (this.outCnt + 1) % 30000;
          this.rejectCnt = (this.rejectCnt + 1) % 30000;
          this.kpi.packsRejected++;
          this.kpi.cupsQuarantined += b.pack.cups.length;
          this.rejected.push(b.pack);
          this.fab.emit('pack_reject', { pack: b.pack.id, cups: b.pack.cups.map(c => c.id),
            where: 'shrink_exit', filmPeak: +b.pack.filmPeak.toFixed(1), simDefect: this.quality(b.pack) });
          this.log(`Paket #${b.pack.id} çıkış ayırıcısıyla karantina kasasına alındı`, 'warn');
          // Removed sideways: the following pack need not accumulate behind it.
          continue;
        }
        limit = b.s - C.packLen - C.gap;
      }
    }

    // fırın havası
    const heating = q(7) && this.fanRunning && !this.otTripped && !this.faults.tunnelHeaterFail;
    const fanless = q(7) && !this.fanRunning && !this.otTripped && !this.faults.tunnelHeaterFail && !this.fab.estop;
    if (heating) this.temp += (C.heaterEq - this.temp) * (dt / C.heatTau);
    else if (fanless) this.temp += 15 * dt;            // fan yokken rezistans hızla aşırı ısınır
    else this.temp += (C.ambient - this.temp) * (dt / (this.fanRunning ? C.coolTauFan : C.coolTauNoFan));
    if (this.temp > C.otTrip && !this.otTripped) {
      this.otTripped = true;
      this.log('Fırın aşırı sıcaklık kesmesi attı (bağımsız termostat)', 'error');
    }

    // paket sıcaklıkları
    for (const b of this.belt) {
      const p = b.pack;
      const inside = b.s < C.tunnelEnd;
      const air = inside ? this.temp : C.ambient;
      p.filmT += (air - p.filmT) * Math.min(1, dt / (inside ? C.filmTau : C.filmCoolTau));
      p.filmPeak = Math.max(p.filmPeak, p.filmT);
      if (p.filmT > C.burnT) p.burnT += dt;
      if (inside) p.cupT += (this.temp - p.cupT) * (dt / C.cupTau);
    }
  }

  quality(p) {
    if (!p.wrapped) return 'sarılmamış';
    if (p.cups.length < 6) return `eksik paket (${p.cups.length} bardak)`;
    if (!p.pad) return 'altlıksız';
    if (p.burnT >= C.burnTime) return 'film yandı';
    if (p.filmPeak < C.shrinkMin) return 'film gevşek';
    if (p.cupT - 6 > C.warmLimit) return `ürün ısındı (+${(p.cupT - 6).toFixed(1)} °C)`;
    const badCup = p.cups.find((c) => c.defect);
    if (badCup) return `hatalı bardak (${badCup.defect})`;
    return null;
  }

  finish(pack) {
    pack.defect = this.quality(pack);
    this.fab.emit('pack_out', { pack: pack.id, filmPeak: +pack.filmPeak.toFixed(1), simDefect: pack.defect });
    if (pack.defect) {
      this.kpi.packsBad++;
      this.log(`HATALI PAKET: #${pack.id} (${pack.defect})`, 'error');
    } else {
      this.kpi.packsGood++;
    }
    this.done.push(pack);
    if (this.done.length > 12) this.done.shift();
  }

  command(msg) {
    if (msg.type === 'refill' && msg.name === 'film') { this.film = C.filmStart; this.log('Film bobini değiştirildi'); }
    if (msg.type === 'refill' && msg.name === 'pads') { this.pads = C.padsStart; this.log('Altlık magazini dolduruldu'); }
  }

  snapshot() {
    const pv = packView;
    return {
      lane: this.lane.map((l) => ({ ...cv(l.cup), enter: l.enter })),
      gate: this.gate, rowP: this.rowP, grpP: this.grpP,
      plate: { pad: this.plate.pad, padT: this.plate.padT, rows: this.plate.rows.map((r) => r.map(cv)) },
      wrapper: { pack: pv(this.wrapper.pack), busy: this.wrapper.busy / C.wrapTime, fault: this.wrapper.fault },
      belt: this.belt.map((b) => ({ ...pv(b.pack), s: b.s })),
      temp: this.temp, otTripped: this.otTripped, film: this.film, pads: this.pads,
      diverter: this.diverter, rejected: this.rejected.map(pv), rejectCnt: this.rejectCnt,
      done: this.done.map(pv), di: this.diWord, do: this.out,
    };
  }
}

const cupV = (c) => ({ id: c.id, product: +c.product.toFixed(1), foil: c.foil, sealed: c.sealed });
const cv = cupV;
export const packView = (p) => p && {
  id: p.id, cups: p.cups.map(cupV), pad: p.pad, wrapped: p.wrapped,
  filmT: +p.filmT.toFixed(1), cupT: +p.cupT.toFixed(2), defect: p.defect,
};

export { C as SHRINK_C };
