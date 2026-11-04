// Fabrika modeli: istasyonları bir arada tutar, Modbus görüntüsünü (blok başına 16 register)
// üretir, operatör panelini, acil stop zincirini ve PLC bekçisini yönetir.
import { BLOCK, N_BLOCKS, MAP_VERSION, FAULTS, PLCS, addr, packBits, tagAddr } from '../public/iomap.js';
import { DolumCell, cupView } from './cells/dolum.js';
import { Outfeed } from './cells/outfeed.js';
import { TankCell } from './cells/tank.js';
import { ShrinkCell } from './cells/shrink.js';
import { PalletCell } from './cells/pallet.js';
import { AgvCell } from './cells/agv.js';
import { AsrsCell } from './cells/asrs.js';
import { Trace } from './trace.js';

const COMM_TIMEOUT = 1.5;   // s: bu süre boyunca istek ya da PLC kalp atışı yoksa çıkışlar düşer

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const A = {
  fabDi: addr('fab', 0), fabHb: addr('fab', 2), fabMapVer: addr('fab', 1),
  palIl: tagAddr('PAL_IW_IL'), agvIl: tagAddr('AGV_IW_IL'),   // PLC'ler arası / istasyon el sıkışması
  dolIr: addr('dolum', 0), dolDo: addr('dolum', 0),
  tnkIr: addr('tank', 0), tnkDo: addr('tank', 0),
  shrIr: addr('shrink', 0), shrDo: addr('shrink', 0),
  palIr: addr('palet', 0), palDo: addr('palet', 0),
  agvIr: addr('agv', 0), agvDo: addr('agv', 0),
  asrsIr: addr('asrs', 0), asrsDo: addr('asrs', 0),
};

export class Factory {
  // wallBase: olaylardaki duvar saati = wallBase + t*1000 (ms). Testlerde 0: ts = simülasyon saati.
  constructor({ seed = Date.now(), wallBase = 0, run } = {}) {
    this.rng = mulberry32(seed);
    this.wallBase = wallBase;
    this.runId = run;
    this.reset();
  }

  reset() {
    this.t = 0;
    this.trace = new Trace({ run: this.runId });
    this.faults = Object.fromEntries(Object.keys(FAULTS).map((k) => [k, false]));
    this.kpi = {
      shippedGood: 0, shippedBad: 0, rejectedGood: 0, rejectedBad: 0,
      lostCups: 0, spilledKg: 0, foilWasted: 0,
      // tank ve CIP
      drainProductKg: 0, causticLostKg: 0, causticToProductKg: 0, hygieneRiskKg: 0,
      // paketleme
      packsGood: 0, packsBad: 0,
      packsRejected: 0, cupsQuarantined: 0,
      // paletleme
      palletsGood: 0, palletsBad: 0, palletPacks: 0, packsDropped: 0, robotCrashes: 0,
      // lojistik
      agvMoves: 0, palletsStored: 0, palletsShipped: 0, palletsRejected: 0,
    };
    this.events = [];
    this.buttons = { start: false, stop: false, reset: false };
    this.estop = false;
    this.ir = new Array(N_BLOCKS * BLOCK).fill(0);
    this.hr = new Array(N_BLOCKS * BLOCK).fill(0);
    this.hb = 0;
    this.hbAcc = 0;
    this.lastPlcIo = -1e9;
    // PLC başına bekçi: kalp atışı (PLCS[].hb) 1,5 s değişmezse yalnızca o PLC'nin hücreleri düşer.
    // Tek PLC üç kalp atışını da yazar.
    this.wd = Object.fromEntries(PLCS.map((p) => [p.id, { addr: tagAddr(p.hb), last: 0, change: -1e9 }]));
    this.outfeed = new Outfeed(this);
    this.dolum = new DolumCell(this);
    this.tank = new TankCell(this);
    this.shrink = new ShrinkCell(this);
    this.pallet = new PalletCell(this);
    this.agv = new AgvCell(this);
    this.asrs = new AsrsCell(this);
    this.updateIr();
  }

  // hat takip olayı (server/trace.js)
  emit(type, data) {
    return this.trace.emit({ type, t: +this.t.toFixed(3), ts: Math.round(this.wallBase + this.t * 1000), ...data });
  }

  log(text, level = 'info') {
    this.events.push({ t: this.t, text, level });
    if (this.events.length > 200) this.events.shift();
  }

  // ---- Modbus tarafı -------------------------------------------------
  touchPlc() { this.lastPlcIo = this.t; }

  // Modbus isteği gelmesi yetmez: PLC programı da çalışıyor olmalı (kalp atışı değişiyor).
  // Modbus isteği hangi PLC'den geldiğini taşımadığı için istek zamanı ortaktır, kalp atışı PLC başına.
  plcLive(id) {
    return this.t - this.lastPlcIo < COMM_TIMEOUT && this.t - this.wd[id].change < COMM_TIMEOUT;
  }
  get live() { return Object.fromEntries(PLCS.map((p) => [p.id, this.plcLive(p.id)])); }
  get plcConnected() { return PLCS.every((p) => this.plcLive(p.id)); }

  updateIr() {
    const b = this.buttons;
    const fab = [packBits([b.start, !b.stop, !this.estop, b.reset]), MAP_VERSION, this.hb];
    fab.forEach((v, i) => { this.ir[A.fabDi + i] = v; });
    this.dolum.ir.forEach((v, i) => { this.ir[A.dolIr + i] = v; });
    this.tank.ir.forEach((v, i) => { this.ir[A.tnkIr + i] = v; });
    this.shrink.ir.forEach((v, i) => { this.ir[A.shrIr + i] = v; });
    this.pallet.ir.forEach((v, i) => { this.ir[A.palIr + i] = v; });
    this.agv.ir.forEach((v, i) => { this.ir[A.agvIr + i] = v; });
    this.asrs.ir.forEach((v, i) => { this.ir[A.asrsIr + i] = v; });
    // istasyon el sıkışması:
    // - AGV'nin "çatallar alım noktasının dışında" optik sinyali paletleme istasyonunun girişine gelir
    // - paletleme hücresinin "palet hazır" çıkışı (PAL_QW_DO bit 11) kabloyla lojistik PLC'sinin girişine;
    //   paketleme PLC'si düşerse çıkış kartı enerjisiz kalır, kablo 0 okur
    this.ir[A.palIl] = packBits([((this.agv.ir[0] >> 6) & 1) === 1]);
    const palDo = this.plcLive('paketleme') ? this.hr[A.palDo] : 0;
    this.ir[A.agvIl] = packBits([((palDo >> 11) & 1) === 1]);
  }

  // ---- Simülasyon adımı ---------------------------------------------
  step(dt) {
    this.t += dt;
    this.hbAcc += dt;
    if (this.hbAcc >= 0.1) { this.hbAcc -= 0.1; this.hb = (this.hb + 1) % 30000; }
    for (const w of Object.values(this.wd)) {
      if (this.hr[w.addr] !== w.last) { w.last = this.hr[w.addr]; w.change = this.t; }
    }

    // bağlantı yoksa o PLC'nin çıkış kartları güvenli konuma düşer
    const pr = this.plcLive('proses'), pk = this.plcLive('paketleme'), lj = this.plcLive('lojistik');
    this.tank.step(dt, pr ? this.hr[A.tnkDo] : 0);
    this.dolum.step(dt, pr ? this.hr[A.dolDo] : 0);
    this.outfeed.step(dt);
    this.shrink.step(dt, pk ? this.hr[A.shrDo] : 0);
    const h = this.hr, p = A.palDo;
    this.pallet.step(dt, pk ? { do: h[p], job: h[p + 1], slot: h[p + 2], seq: h[p + 3] } : { do: 0, job: 0, slot: 0, seq: 0 });
    const g = A.agvDo, r = A.asrsDo;
    this.agv.step(dt, lj ? { do: h[g], order: h[g + 1], seq: h[g + 2] } : { do: 0, order: 0, seq: 0 });
    this.asrs.step(dt, lj ? { do: h[r], job: h[r + 1], loc: h[r + 2], seq: h[r + 3] } : { do: 0, job: 0, loc: 0, seq: 0 });
    this.updateIr();
  }

  // ---- Arayüz komutları ---------------------------------------------
  command(msg) {
    switch (msg.type) {
      case 'button':
        if (msg.name in this.buttons) this.buttons[msg.name] = !!msg.value;
        else this.tank.command(msg);
        break;
      case 'estop':
        this.estop = !!msg.value;
        this.log(this.estop ? 'Acil stop basıldı' : 'Acil stop bırakıldı', 'warn');
        break;
      case 'fault':
        if (msg.name in this.faults) {
          this.faults[msg.name] = !!msg.value;
          this.log(`Arıza ${msg.value ? 'eklendi' : 'kaldırıldı'}: ${FAULTS[msg.name]}`, 'warn');
          this.tank.command(msg);
        }
        break;
      case 'resetKpi':
        for (const k of Object.keys(this.kpi)) this.kpi[k] = 0;
        this.dolum.command(msg);
        break;
      default:
        this.dolum.command(msg);
        this.tank.command(msg);
        this.shrink.command(msg);
        this.pallet.command(msg);
        this.agv.command(msg);
        this.asrs.command(msg);
    }
  }

  snapshot() {
    return {
      t: +this.t.toFixed(2),
      plcConnected: this.plcConnected,
      plcLive: this.live,
      estop: this.estop,
      buttons: this.buttons,
      faults: this.faults,
      kpi: this.kpi,
      events: this.events.slice(-30),
      ir: this.ir,
      hr: this.hr,
      dolum: this.dolum.snapshot(),
      tank: this.tank.snapshot(),
      shrink: this.shrink.snapshot(),
      pallet: this.pallet.snapshot(),
      agv: this.agv.snapshot(),
      asrs: this.asrs.snapshot(),
      outfeed: this.outfeed.cups.map((c) => ({ ...cupView(c), pos: c.pos, defect: c.defect })),
    };
  }
}
