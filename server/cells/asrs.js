// Otomatik depo (AS/RS, fabrikanın 6. bloğu): tek koridorlu birim yük deposu, istif vinci,
// 2 taraf x 6 sütun x 3 kat = 36 göz, giriş konveyörü (kontur + etiket kontrolü), çıkış konveyörü ve
// kamyon rampası. Soğuk depo (2-6 °C).
//
// Vinç kontrolcüsü robot ve AGV ile aynı iş el sıkışmasını kullanır: JOB + LOC + SEQ; ACK, RES_SEQ,
// RES_CODE, RES_LOC, RES_ID. İşler: 1 depola (giriş P&D → göz), 2 çıkar (göz → çıkış P&D),
// 3 eve dön, 4 göz kontrolü (gider, çataldaki okuyucuyla etiketi okur, gözü değiştirmez).
// Çift depolamayı vinç fiziksel olarak engeller: dolu göze çatal uzatmaz ("göz dolu" sonucu).
//
// Gerçek durum (hangi palet nerede) burada, simülatördedir. PLC'deki göz tablosu beklenen envanterdir;
// belirsiz kalan göz vinçle kontrol edilerek uzlaştırılır.
//
// Güvenlik: koridor kapısı açılınca ya da acil stopta vinç enerjisi kesilir (bağımsız güvenlik devresi);
// reset fabrika RESET butonuyla, hareket için START gerekir.
import { bitOf, packBits } from '../../public/iomap.js';
import { RACK, CONV, loc as locPos } from '../../public/logisticsgeo.js';

const C = {
  vx: 2.0, vy: 0.6, fork: 0.6, forkReach: 0.75,   // m/s, m
  liftDy: 0.1,                                     // m, çatalın yükü kaldırma payı
  convV: 0.3,
  truckAfter: 15,                                  // s, rampadaki palet kamyona yüklenir
  tAmb: 14, tSet: 3.5, tauCool: 400, tauWarm: 900, doorHeat: 0.01,
};
const JOB = { STORE: 1, RETRIEVE: 2, HOME: 3, CHECK: 4 };
const RES = { OK: 1, NO_LOAD: 10, OCCUPIED: 11, REJECTED: 12, ABORTED: 13, TRAVEL_FAULT: 14, FORK_FAULT: 15, PLACED_ABORTED: 17 };
const HOME = { x: RACK.pdX, y: RACK.pdY - 0.06, f: 0 };
const IN_Z = [CONV.inX0, CONV.inCheckX, CONV.inX1];   // giriş: AGV bırakma, kontrol, P&D

export class AsrsCell {
  constructor(fab) {
    this.fab = fab;
    this.rack = Array(RACK.slots).fill(null);
    this.inConv = [];                 // { p, x, target }
    this.outConv = [];                // { p, x }
    this.check = null;                // kontrol istasyonundaki ölçüm: { id, contourOk, readOk, idRead }
    this.crane = { x: HOME.x, y: HOME.y, f: 0, load: null, error: false, homed: true,
      ackSeq: 0, resSeq: 0, resCode: 0, resLoc: 0, resId: 0, job: null, busyS: 0 };
    this.temp = 4.0;
    this.safe = { ok: true, door: true };
    this.shipReq = 0; this.shippedCnt = 0; this.truckT = 0;
    this.orders = []; this.nextOrder = 1;   // hat takibi: açık sevkiyat siparişleri { id, left }
    this.out = 0; this.cmd = { job: 0, loc: 0, seq: 0 };
    this.shipped = [];
  }

  get faults() { return this.fab.faults; }
  get kpi() { return this.fab.kpi; }
  log(t, l) { this.fab.log(t, l); }

  // ---- giriş konveyörü ----
  inAt(i) { return this.inConv.find((e) => e.target == null && Math.abs(e.x - IN_Z[i]) < 0.02) || null; }
  inZoneBusy(i, self) { return this.inConv.some((e) => e !== self && (e.target === i || Math.abs(e.x - IN_Z[i]) < 0.85)); }
  acceptFromAgv(p) {
    if (this.inZoneBusy(0)) { this.log('Depo girişi dolu: AGV paleti bırakamadı', 'error'); return false; }
    this.inConv.push({ p, x: IN_Z[0], target: null });
    return true;
  }
  get outPd() { return this.outConv.find((e) => Math.abs(e.x - CONV.outX0) < 0.02 && !e.moving) || null; }
  get outDock() { return this.outConv.find((e) => Math.abs(e.x - CONV.outX1) < 0.02) || null; }

  get power() { return bitOf(this.out, 0) && this.safe.ok && !this.fab.estop; }
  get ready() { const c = this.crane; return this.power && !c.job && !c.error; }
  get forkCenter() { return Math.abs(this.crane.f) < 0.02; }

  get diWord() {
    const c = this.crane, ch = this.check;
    return packBits([
      this.ready, !!c.job, c.homed, this.forkCenter, !!c.load, c.error,
      !!this.inAt(0), !!this.inAt(1), !!this.inAt(2), !!this.outPd, !!this.outDock,
      !!ch, !!ch && ch.contourOk, this.safe.ok, this.safe.door, bitOf(this.out, 0) && !this.fab.estop,
    ]);
  }
  get ir() {
    const c = this.crane, ch = this.check;
    return [this.diWord, c.ackSeq, c.resSeq, c.resCode, c.resLoc, c.resId,
      ch && ch.readOk ? ch.id : 0, c.load ? c.load.id : 0, Math.round(this.temp * 10), this.shipReq, this.shippedCnt];
  }
  get occWords() {
    const w = [0, 0, 0];
    this.rack.forEach((p, i) => { if (p) w[i >> 4] |= 1 << (i & 15); });
    return w;
  }

  // ---- güvenlik devresi (koridor kapısı + acil stop) ----
  stepSafety() {
    const cause = this.fab.estop ? 'acil stop' : !this.safe.door ? 'koridor kapısı açık' : '';
    if (cause && this.safe.ok) { this.safe.ok = false; this.log(`Depo güvenlik durdurması: ${cause}`, 'warn'); }
    if (!this.safe.ok && !cause && this.fab.buttons.reset) { this.safe.ok = true; this.log('Depo güvenliği resetlendi'); }
  }

  // ---- vinç ----
  finish(code) {
    const c = this.crane, j = c.job;
    c.resSeq = j.seq; c.resCode = code; c.resLoc = j.loc; c.resId = j.resId ?? 0;
    c.job = null;
  }

  plan(type, n) {
    const steps = [];
    const c = this.crane;
    if (Math.abs(c.f) > 0.02) steps.push({ f: 0 });                       // önce çatalı ortala
    const at = (x, y) => steps.push({ x, y });
    const pd = (side) => ({ x: RACK.pdX, y: RACK.pdY, side });
    const pickFrom = (pos, act) => {
      at(pos.x, pos.y - C.liftDy / 2);
      steps.push({ f: pos.side === 0 ? 1 : -1, act: act + 'Reach' });
      steps.push({ dy: C.liftDy, act });
      steps.push({ f: 0 });
    };
    const putTo = (pos, act) => {
      at(pos.x, pos.y + C.liftDy / 2);
      steps.push({ f: pos.side === 0 ? 1 : -1, act: act + 'Reach' });
      steps.push({ dy: -C.liftDy, act });
      steps.push({ f: 0 });
    };
    const L = n >= 1 && n <= RACK.slots ? locPos(n) : null;
    if (type === JOB.STORE) {
      if (!c.load) pickFrom(pd(0), 'pickIn');
      putTo(L, 'putLoc');
    } else if (type === JOB.RETRIEVE) {
      if (!c.load) pickFrom(L, 'pickLoc');
      putTo(pd(1), 'putOut');
    } else if (type === JOB.CHECK) {
      at(L.x, L.y);
      steps.push({ wait: 0.6, act: 'scan' });
    } else if (type === JOB.HOME) {
      at(HOME.x, HOME.y);
      steps.push({ act: 'homed', wait: 0.2 });
    }
    return steps;
  }

  accept() {
    const c = this.crane, m = this.cmd;
    if (!m.seq || m.seq === c.ackSeq || !this.ready || bitOf(this.out, 1)) return;
    c.ackSeq = m.seq;
    c.job = { seq: m.seq, type: m.job, loc: m.loc, i: 0, t: 0, from: null, released: false };
    const validLoc = m.loc >= 1 && m.loc <= RACK.slots;
    let bad = ![1, 2, 3, 4].includes(m.job) || (m.job !== JOB.HOME && !validLoc);
    if (!c.homed && m.job !== JOB.HOME) bad = true;
    if (m.job === JOB.RETRIEVE && c.load) bad = true;
    if (bad) { this.finish(RES.REJECTED); this.log(`Vinç işi reddetti (iş ${m.job}, göz ${m.loc})`, 'warn'); return; }
    c.job.steps = this.plan(m.job, m.loc);
    if (this.faults.craneTravelFault) c.job.travelFault = true;
  }

  act(name) {
    const c = this.crane, j = c.job;
    switch (name) {
      case 'pickInReach': {
        const e = this.inAt(2);
        if (!e) { this.log('Vinç: giriş P&D noktasında palet yok', 'warn'); return RES.NO_LOAD; }
        return 0;
      }
      case 'pickIn': {
        const e = this.inAt(2);
        this.inConv = this.inConv.filter((x) => x !== e);
        c.load = e.p; return 0;
      }
      case 'putLocReach':
        if (this.rack[j.loc - 1]) {
          this.log(`Vinç: ${j.loc} numaralı göz dolu çıktı, çatal uzatılmadı (çift depolama engellendi)`, 'error');
          j.resId = this.rack[j.loc - 1].id;
          return RES.OCCUPIED;
        }
        return 0;
      case 'putLoc':
        this.rack[j.loc - 1] = c.load;
        this.fab.emit('store', { pallet: c.load.id, loc: j.loc });
        c.load = null; j.released = true;
        this.kpi.palletsStored++;
        return 0;
      case 'pickLocReach':
        if (!this.rack[j.loc - 1]) { this.log(`Vinç: ${j.loc} numaralı göz boş çıktı`, 'error'); return RES.NO_LOAD; }
        return 0;
      case 'pickLoc':
        c.load = this.rack[j.loc - 1]; this.rack[j.loc - 1] = null; j.resId = c.load.id;
        this.fab.emit('pick', { pallet: c.load.id, loc: j.loc });
        return 0;
      case 'putOutReach':
        if (this.outConv.some((e) => e.x < CONV.outX0 + 0.85)) { this.log('Vinç: çıkış P&D dolu', 'warn'); return RES.OCCUPIED; }
        return 0;
      case 'putOut':
        this.outConv.push({ p: c.load, x: CONV.outX0 }); j.resId = c.load.id; c.load = null; j.released = true;
        return 0;
      case 'scan':
        j.resId = this.rack[j.loc - 1]?.id ?? 0; return 0;
      case 'homed':
        c.homed = true; return 0;
      default: return 0;
    }
  }

  stepCrane(dt) {
    const c = this.crane, j = c.job;
    if (!j) return;
    if (!this.power) return;
    if (bitOf(this.out, 1)) return;              // HOLD
    c.busyS += dt;
    const st = j.steps[j.i];
    if (!st) { this.finish(RES.OK); return; }
    if (j.t === 0 && st.act && (st.f != null) && st.act.endsWith('Reach')) {
      const code = this.act(st.act);
      if (code) { this.finish(code); return; }
      if (this.faults.forkFault) {
        this.faults.forkFault = false; c.error = true;
        this.log('Vinç çatalı takıldı', 'error');
        this.finish(RES.FORK_FAULT); return;
      }
    }
    if (st.wait != null) {
      j.t += dt;
      if (j.t >= st.wait) { const code = this.act(st.act); if (code) { this.finish(code); return; } j.i++; j.t = 0; }
      return;
    }
    if (!j.from) {
      j.from = { x: c.x, y: c.y, f: c.f };
      j.to = { x: st.x ?? c.x, y: st.dy != null ? c.y + st.dy : st.y ?? c.y, f: st.f ?? c.f };
      j.dur = Math.max(0.1, Math.abs(j.to.x - c.x) / C.vx, Math.abs(j.to.y - c.y) / C.vy,
        Math.abs(j.to.f - c.f) * C.forkReach / C.fork);
    }
    j.t += dt;
    const k = Math.min(1, j.t / j.dur);
    const e = k * k * (3 - 2 * k);
    c.x = j.from.x + (j.to.x - j.from.x) * e;
    c.y = j.from.y + (j.to.y - j.from.y) * e;
    c.f = j.from.f + (j.to.f - j.from.f) * e;
    if (j.travelFault && st.x != null && k > 0.5) {
      this.faults.craneTravelFault = false; c.error = true; c.homed = false;
      this.log('Vinç yürüme sürücüsü arıza verdi (konum referansı kayboldu)', 'error');
      this.finish(RES.TRAVEL_FAULT); return;
    }
    if (k >= 1) {
      if (st.dy != null && st.act) { const code = this.act(st.act); if (code) { this.finish(code); return; } }
      j.i++; j.t = 0; j.from = null;
    }
  }

  // ---- konveyörler, kontrol istasyonu, kamyon rampası ----
  stepConveyors(dt) {
    const run = (b) => bitOf(this.out, b) && this.power;
    // giriş: 0 → 1 (IN1), 1 → 2 (IN2). P&D'ye çatal uzanmışken palet sürülürse çarpar.
    for (const e of [...this.inConv].sort((a, b) => a.x - b.x)) {
      if (e.target == null) {
        const z = IN_Z.findIndex((x) => Math.abs(e.x - x) < 0.02);
        if (z < 0 || z >= 2) continue;
        const motor = z === 0 ? run(3) : run(4);
        if (motor && !this.inZoneBusy(z + 1, e)) {
          e.target = z + 1;
          if (z === 0) this.check = null;
        }
      } else {
        const motor = e.target === 1 ? run(3) : run(4);
        if (!motor || this.faults.inConvJam) continue;
        if (e.target === 2 && this.crane.f > 0.05 && this.crane.x > RACK.pdX - 0.5) {   // çatal giriş tarafına uzanmış
          if (!e.crashLogged) { e.crashLogged = true; this.kpi.robotCrashes++; this.log('Palet, vinç çatalı P&D\'deyken konveyöre sürüldü', 'error'); }
        }
        e.x = Math.max(IN_Z[e.target], e.x - C.convV * dt);
        if (e.x <= IN_Z[e.target] + 1e-6) {
          e.x = IN_Z[e.target]; const arrived = e.target; e.target = null;
          if (arrived === 1) this.measure(e.p);
          if (arrived === 2) this.check = null;
        }
      }
    }
    // çıkış konveyörü
    for (const e of this.outConv) {
      if (e.x >= CONV.outX1 - 1e-6) continue;
      const ahead = this.outConv.some((o) => o !== e && o.x > e.x && o.x - e.x < 0.85);
      e.moving = run(5) && !ahead;
      if (e.moving) e.x = Math.min(CONV.outX1, e.x + C.convV * dt);
    }
    // kamyon rampası: palet 15 s içinde yüklenir
    const dock = this.outDock;
    if (dock) {
      this.truckT += dt;
      if (this.truckT >= C.truckAfter) {
        this.truckT = 0;
        this.outConv = this.outConv.filter((e) => e !== dock);
        this.shippedCnt = (this.shippedCnt + 1) % 30000;
        this.kpi.palletsShipped++;
        this.shipped.push(dock.p.id); if (this.shipped.length > 10) this.shipped.shift();
        const order = this.orders.find((o) => o.left > 0);
        if (order) order.left--;
        this.orders = this.orders.filter((o) => o.left > 0);
        this.fab.emit('ship', { pallet: dock.p.id, order: order ? order.id : 0 });
        this.log(`Palet #${dock.p.id} kamyona yüklendi`);
      }
    } else this.truckT = 0;
  }

  // kontur (taşma/yükseklik) ve etiket okuma, palet kontrol noktasına geldiğinde
  measure(p) {
    const contourOk = !this.faults.contourFail && p.wrapped && p.sheetTop;
    const readOk = !this.faults.labelUnreadable;
    if (this.faults.contourFail) this.faults.contourFail = false;
    if (this.faults.labelUnreadable) this.faults.labelUnreadable = false;
    this.check = { id: p.id, contourOk, readOk };
    this.fab.emit('asrs_check', { pallet: p.id, contourOk, readOk });
    if (!contourOk) this.log(`Depo girişi: palet #${p.id} kontur kontrolünden geçemedi`, 'warn');
    if (!readOk) this.log('Depo girişi: palet etiketi okunamadı', 'warn');
  }

  step(dt, hr) {
    this.out = this.fab.estop ? 0 : hr.do;
    this.cmd = hr;
    this.stepSafety();
    const c = this.crane;
    if (bitOf(this.out, 2) && c.error) { c.error = false; this.log('Vinç hatası resetlendi'); }
    if (c.job && !this.power) {
      this.finish(c.job.released ? RES.PLACED_ABORTED : RES.ABORTED);
      this.log('Vinç işi yarıda kesildi', 'warn');
    }
    this.accept();
    this.stepCrane(dt);
    this.stepConveyors(dt);
    // soğuk depo
    const cooling = bitOf(this.out, 6) && !this.faults.coolingFail;
    const target = cooling ? C.tSet : C.tAmb;
    this.temp += (target - this.temp) * (dt / (cooling ? C.tauCool : C.tauWarm)) + (this.safe.door ? 0 : C.doorHeat * dt);
  }

  command(msg) {
    if (msg.type === 'shipOrder') {
      const n = Math.max(1, Math.min(10, msg.value | 0 || 1));
      this.shipReq = (this.shipReq + n) % 30000;
      const order = { id: this.nextOrder++, left: n };
      this.orders.push(order);
      this.fab.emit('order', { order: order.id, n });
      this.log(`Sevkiyat siparişi: ${n} palet`);
    }
    if (msg.type === 'aisleDoor') {
      this.safe.door = !msg.value;
      this.log(msg.value ? 'Depo koridor kapısı açıldı' : 'Depo koridor kapısı kapandı', 'warn');
    }
    if (msg.type === 'removeReject') {
      const e = this.inAt(1);
      if (e && this.check && (!this.check.contourOk || !this.check.readOk)) {
        this.inConv = this.inConv.filter((x) => x !== e);
        this.check = null;
        this.kpi.palletsRejected++;
        this.fab.emit('reject_pallet', { pallet: e.p.id });
        this.log(`Reddedilen palet #${e.p.id} operatör tarafından alındı`);
      }
    }
  }

  snapshot() {
    const pv = (p) => p && { id: p.id, n: p.slots.filter(Boolean).length, turns: p.turns };
    const c = this.crane;
    return {
      rack: this.rack.map((p) => p && p.id),
      inConv: this.inConv.map((e) => ({ ...pv(e.p), x: e.x })),
      outConv: this.outConv.map((e) => ({ ...pv(e.p), x: e.x })),
      check: this.check,
      crane: { x: c.x, y: c.y, f: c.f, load: pv(c.load), error: c.error, homed: c.homed,
        job: c.job ? { type: c.job.type, loc: c.job.loc, seq: c.job.seq } : null,
        ackSeq: c.ackSeq, resSeq: c.resSeq, resCode: c.resCode, resLoc: c.resLoc, resId: c.resId },
      temp: this.temp, safe: { ...this.safe }, shipReq: this.shipReq, shippedCnt: this.shippedCnt,
      truckT: this.truckT, shipped: this.shipped, di: this.diWord, do: this.out,
    };
  }
}

export { C as ASRS_C, JOB as CRANE_JOB, RES as CRANE_RES, IN_Z };
