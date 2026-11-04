// Otonom elektrikli transpalet (AGV, fabrikanın 5. bloğu). Paletleme hücresinin alım noktasından (D)
// dolu paleti alır, otomatik deponun giriş konveyörüne bırakır; şarj ve park istasyonuna gider.
//
// Araç kontrolcüsü kendi navigasyonunu yapar (yol ağı + düğümler). PLC basit bir "ana kontrol" gibi
// iş verir: ORDER + SEQ; araç ACK_SEQ, RES_SEQ, RES_CODE döner (robotla aynı el sıkışma).
// Bu, VDA 5050 değildir; o arayüz filo yönetimi ve farklı üreticiler için gerekir.
//
// Yük aktarma el sıkışması (E84 benzeri): araç istasyonun yaklaşma noktasında PLC'nin istasyon izni
// gelene kadar bekler. İzin, çatallar istasyona girip yük alınana/bırakılana kadar tutulmalıdır; düşerse
// araç olduğu yerde durur. Araç "çatallar istasyonun dışında" bilgisini verir; PLC çatallar içerideyken
// o istasyonun konveyörünü çalıştırmaz.
//
// Güvenlik: lazer tarayıcı aracın kendisindedir (Modbus'a bağlı değildir): uyarı alanında yavaşlar,
// koruma alanında durur, alan 2 s boş kalınca devam eder. Acil stopta enerji kesilir.
//
// Basitleştirmeler: araç yerinde döner (gerçek transpaletlerin dönüş yarıçapı vardır), yol ağı sabit,
// tek araç olduğu için trafik yönetimi yok, batarya modeli doğrusal.
import { bitOf, packBits } from '../../public/iomap.js';
import { NODES, EDGES, DOCKS } from '../../public/logisticsgeo.js';

const C = {
  v: 0.8, vSlow: 0.3, turn: 1.4,   // m/s, rad/s
  liftT: 1.5,                       // s
  drainDrive: 0.22, drainIdle: 0.02, charge: 1.6,   // %/s
  critical: 5,
  resume: 2.0,                      // s, koruma alanı boşaldıktan sonra
  dockClear: 1.05,                  // m, çatal ucu istasyondan bu kadar uzaksa "dışarıda"
};
const ORDER = { TRANSPORT: 1, DELIVER: 2, CHARGE: 3, PARK: 4 };
const RES = { OK: 1, NO_LOAD: 10, LOAD_LOST: 11, REJECTED: 12, ABORTED: 13, LIFT_FAULT: 14, BATTERY: 15, DELIVERED_ABORTED: 17 };
const NODE_IDS = Object.keys(NODES);

const ang = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function route(from, to) {
  if (from === to) return [from];
  const prev = { [from]: null }, q = [from];
  while (q.length) {
    const n = q.shift();
    for (const [a, b] of EDGES) {
      const m = a === n ? b : b === n ? a : null;
      if (m && !(m in prev)) { prev[m] = n; q.push(m); }
    }
  }
  if (!(to in prev)) return null;
  const path = [];
  for (let n = to; n; n = prev[n]) path.unshift(n);
  return path;
}

export class AgvCell {
  constructor(fab) {
    this.fab = fab;
    const p = NODES.PARK;
    this.pose = { x: p.x, z: p.z, yaw: Math.PI / 2 };
    this.node = 'PARK';               // son geçilen düğüm
    this.seg = null;                  // { from, to } hareket hâlindeyken
    this.lift = 0; this.load = null;
    this.battery = 85;
    this.error = false;
    this.ackSeq = 0; this.resSeq = 0; this.resCode = 0;
    this.order = null;                // { seq, type, steps, i, t, delivered }
    this.scan = { stop: false, warn: false, clearT: 0 };
    this.waitPermit = false;
    this.delivered = 0;
    this.out = 0; this.cmd = { order: 0, seq: 0 };
    this.distance = 0;
  }

  get faults() { return this.fab.faults; }
  get kpi() { return this.fab.kpi; }
  log(t, l) { this.fab.log(t, l); }

  get power() { return bitOf(this.out, 0) && !this.fab.estop && !this.error; }
  get ready() { return bitOf(this.out, 0) && !this.fab.estop && !this.order && !this.error; }
  get atNode() { return !this.seg ? this.node : null; }
  get charging() { return this.atNode === 'CHARGE' && !this.order && bitOf(this.out, 0) && this.battery < 100; }
  forksClear(dock) {
    const d = NODES[dock];
    return Math.hypot(this.pose.x - d.x, this.pose.z - d.z) > C.dockClear;
  }

  get diWord() {
    return packBits([
      this.ready, !!this.order, !!this.load, this.lift > 0.95,
      this.atNode === 'D_DOCK', this.atNode === 'IN_DOCK',
      this.forksClear('D_DOCK'), this.forksClear('IN_DOCK'),
      this.charging, this.error, this.scan.warn, this.scan.stop, this.waitPermit,
      this.atNode === 'PARK', bitOf(this.out, 0) && !this.fab.estop, this.atNode === 'CHARGE',
    ]);
  }
  get ir() {
    const n = this.seg ? this.seg.to : this.node;
    return [this.diWord, this.ackSeq, this.resSeq, this.resCode, Math.round(this.battery),
      NODE_IDS.indexOf(n) + 1, this.load ? this.load.id : 0, this.delivered];
  }

  // ---- iş planı: düğüm düğüm hareket + istasyon işlemleri ----
  plan(type) {
    const start = this.seg ? this.seg.to : this.node;
    const steps = [];
    const lastNode = () => { for (let i = steps.length - 1; i >= 0; i--) if (steps[i].node) return steps[i].node; return start; };
    const goto = (target) => {
      for (const n of route(lastNode(), target).slice(1)) steps.push({ move: n, node: n });
    };
    const station = (dock, act) => {
      const pre = DOCKS[dock];
      if (lastNode() !== pre) goto(pre);
      steps.push({ permit: dock });
      steps.push({ move: dock, node: dock, permitted: dock });
      steps.push({ act, permitted: dock });
      steps.push({ move: pre, node: pre });
    };
    if (this.seg) steps.push({ move: this.seg.to, node: this.seg.to });   // yarım kalan bölümü tamamla
    if (type === ORDER.TRANSPORT) { station('D_DOCK', 'pick'); station('IN_DOCK', 'drop'); }
    else if (type === ORDER.DELIVER) station('IN_DOCK', 'drop');
    else if (type === ORDER.CHARGE) goto('CHARGE');
    else if (type === ORDER.PARK) goto('PARK');
    return steps;
  }

  finish(code) {
    const o = this.order;
    this.resSeq = o.seq; this.resCode = code;
    this.order = null; this.waitPermit = false;
  }

  accept() {
    const c = this.cmd;
    if (!c.seq || c.seq === this.ackSeq || !this.ready || bitOf(this.out, 1)) return;
    this.ackSeq = c.seq;
    this.order = { seq: c.seq, type: c.order, steps: [], i: 0, t: 0, delivered: false };
    let bad = ![1, 2, 3, 4].includes(c.order);
    if (c.order === ORDER.TRANSPORT && this.load) bad = true;
    if (c.order === ORDER.DELIVER && !this.load) bad = true;
    if (bad) { this.finish(RES.REJECTED); this.log(`AGV işi reddetti (iş ${c.order})`, 'warn'); return; }
    this.order.steps = this.plan(c.order);
  }

  doAct(act) {
    const pal = this.fab.pallet, asrs = this.fab.asrs;
    if (act === 'pick') {
      if (this.faults.agvLiftFault) {
        this.faults.agvLiftFault = false; this.error = true;
        this.log('AGV: çatal kaldırma motoru arızası', 'error');
        return RES.LIFT_FAULT;
      }
      const p = pal.takeFromD();
      if (!p) { this.log('AGV: alım noktasında palet yok', 'warn'); return RES.NO_LOAD; }
      this.load = p;
      return 0;
    }
    if (act === 'drop') {
      if (!asrs.acceptFromAgv(this.load)) return RES.REJECTED;
      this.load = null; this.order.delivered = true;
      this.delivered = (this.delivered + 1) % 30000;
      this.kpi.agvMoves++;
      return 0;
    }
    return 0;
  }

  stepScanner(dt, moving) {
    const s = this.scan;
    const person = this.faults.agvObstacle && moving;
    s.warn = person;
    if (person) { if (!s.stop) this.log('AGV tarayıcısı: koruma alanında engel, durdu', 'warn'); s.stop = true; s.clearT = 0; }
    else if (s.stop) { s.clearT += dt; if (s.clearT >= C.resume) { s.stop = false; this.log('AGV: alan boşaldı, devam'); } }
  }

  stepMotion(dt) {
    const o = this.order;
    if (!o) return;
    if (!this.power) return;
    const st = o.steps[o.i];
    if (!st) { this.finish(RES.OK); return; }

    // istasyon izni (yükleme/boşaltma bitene kadar tutulmalı)
    const permitBit = (dock) => bitOf(this.out, dock === 'D_DOCK' ? 3 : 4);
    if (st.permit) {
      this.waitPermit = !permitBit(st.permit);
      if (!this.waitPermit) { o.i++; o.t = 0; }
      return;
    }
    // izin: istasyona girerken, yük alınana kadar (alma) ve yük bırakılana kadar (bırakma) gerekir
    if (st.permitted) {
      const need = st.act === 'pick' ? o.t === 0 : true;
      if (need && !permitBit(st.permitted)) { this.waitPermit = true; return; }
    }
    this.waitPermit = false;
    if (bitOf(this.out, 1)) return;                  // PAUSE

    if (st.act) {
      // çatal kaldır / indir
      const up = st.act === 'pick';
      if (o.t === 0 && up) { const code = this.doAct('pick'); if (code) { this.finish(code); return; } }
      o.t += dt;
      this.lift = up ? Math.min(1, o.t / C.liftT) : Math.max(0, 1 - o.t / C.liftT);
      if (o.t >= C.liftT) {
        if (!up) { const code = this.doAct('drop'); if (code) { this.finish(code); return; } }
        o.i++; o.t = 0;
      }
      return;
    }

    // düğüme hareket: önce dön, sonra ilerle
    const target = NODES[st.move];
    const dx = target.x - this.pose.x, dz = target.z - this.pose.z;
    const dist = Math.hypot(dx, dz);
    if (!this.seg) this.seg = { from: this.node, to: st.move };
    const dock = DOCKS[st.move] ? st.move : DOCKS[this.seg.from] ? this.seg.from : null;
    // istasyon bölümlerinde çatallar istasyona bakar; yolda gövde önde (çatallar arkada)
    let yaw;
    if (dock) { const d = NODES[dock], p = NODES[DOCKS[dock]]; yaw = Math.atan2(-(d.z - p.z), d.x - p.x); }
    else yaw = Math.atan2(dz, -dx);
    if (dist < 1e-4) { this.seg = null; this.node = st.move; o.i++; return; }
    const dyaw = ang(yaw - this.pose.yaw);
    if (Math.abs(dyaw) > 1e-3) {
      const s = Math.sign(dyaw) * Math.min(Math.abs(dyaw), C.turn * dt);
      this.pose.yaw = ang(this.pose.yaw + s);
      return;
    }
    this.stepScanner(dt, true);
    if (this.scan.stop) return;
    const v = this.scan.warn ? C.vSlow : C.v;
    const step = Math.min(dist, v * dt);
    this.pose.x += (dx / dist) * step; this.pose.z += (dz / dist) * step;
    this.distance += step;
    this.battery = Math.max(0, this.battery - C.drainDrive * dt);
    if (step >= dist - 1e-9) { this.pose.x = target.x; this.pose.z = target.z; this.seg = null; this.node = st.move; o.i++; }
  }

  step(dt, hr) {
    this.out = this.fab.estop ? 0 : hr.do;
    this.cmd = hr;
    if (bitOf(this.out, 2) && this.error && this.battery > C.critical) { this.error = false; this.log('AGV hatası resetlendi'); }
    if (this.faults.agvBatteryLow) { this.faults.agvBatteryLow = false; this.battery = Math.min(this.battery, 24); this.log('AGV bataryası %24\'e düştü (arıza)', 'warn'); }

    // enerji kesildi ya da hata: iş yarıda kalır
    if (this.order && (!this.power)) {
      this.finish(this.order.delivered ? RES.DELIVERED_ABORTED : RES.ABORTED);
      this.log('AGV işi yarıda kesildi', 'warn');
    }
    this.accept();
    if (!this.order || !this.seg) this.stepScanner(dt, false);
    this.stepMotion(dt);

    this.battery = Math.max(0, this.battery - C.drainIdle * dt);
    if (this.charging) this.battery = Math.min(100, this.battery + C.charge * dt);
    if (this.battery <= C.critical && !this.error) {
      this.error = true;
      this.log('AGV bataryası kritik seviyede, araç durdu', 'error');
      if (this.order) this.finish(RES.BATTERY);
    }
  }

  command(msg) {
    if (msg.type === 'agvCharge') { this.battery = 100; this.log('AGV bataryası elle şarj edildi'); }
  }

  snapshot() {
    return {
      pose: this.pose, lift: this.lift, load: this.load && { id: this.load.id, turns: this.load.turns, n: this.load.slots.filter(Boolean).length },
      battery: this.battery, error: this.error, node: this.seg ? `${this.seg.from}→${this.seg.to}` : this.node,
      order: this.order ? { type: this.order.type, seq: this.order.seq } : null,
      ackSeq: this.ackSeq, resSeq: this.resSeq, resCode: this.resCode,
      scan: { ...this.scan }, waitPermit: this.waitPermit, charging: this.charging,
      di: this.diWord, do: this.out, delivered: this.delivered, distance: +this.distance.toFixed(1),
    };
  }
}

export { C as AGV_C, ORDER as AGV_ORDER, RES as AGV_RES, NODE_IDS };
