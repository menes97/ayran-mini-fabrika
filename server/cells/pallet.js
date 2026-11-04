// Paletleme hücresi (fabrikanın 4. bloğu): 4 eksenli paletleme robotu ve kendi kontrolcüsü,
// palet besleme magazini, makaralı palet hattı (A besleme → B istif → C streç → D alım noktası),
// streç sarma makinesi ve hücrenin bağımsız güvenlik kontrolcüsü.
//
// PLC robotu doğrudan sürmez. Gerçek hücrelerde olduğu gibi robot kontrolcüsüne iş gönderir:
//   PLC → robot: JOB, SLOT, SEQ (SEQ değişince iş başlar; aynı SEQ ikinci kez çalışmaz)
//   robot → PLC: ACK_SEQ (iş kabul edildi), RES_SEQ + RES_CODE + RES_SLOT (iş bitti, sonucu)
// Sonuç kayıtları kalıcıdır: PLC haberleşmeyi kaybedip geri gelse de son işin sonucunu okuyabilir.
// İstif deseni robot programındadır; PLC yalnızca slot numarasını ve paletteki paket sayısını tutar.
//
// Güvenlik: kapı kilidi, ışık perdesi + muting ve acil stop simülatördeki ayrı bir güvenlik
// kontrolcüsünde değerlendirilir (gerçekte güvenlik rölesi / güvenlik PLC'si). Robot gücünü ve hücre
// motorlarını o keser; OpenPLC yalnızca durumunu okur. Bu bir eğitim modelidir, sertifikalı bir
// güvenlik tasarımı değildir.
//
// Basitleştirmeler:
// - Robot kartezyen yörünge izler (yumuşatılmış doğrusal hareket); eksen dinamiği yok, IK yalnızca 3B'de.
// - Güç kesilince robot olduğu yerde durur (kategori 0), vakum çek valfle korunur, paket düşmez.
// - Paletler yalnızca bölge merkezlerinde durur; konveyör tek hızlı.
// - Alım noktasındaki paleti AGV alır (server/cells/agv.js).
import { bitOf, packBits } from '../../public/iomap.js';
import { PG, PACK, slotPos, inPalletZone } from '../../public/palletgeo.js';
import { packView } from './shrink.js';

const C = {
  vH: 1.4, vV: 0.6,           // m/s robot yatay ve dikey hız (demo)
  gripT: 0.35, releaseT: 0.25,
  convV: 0.25,                // m/s palet konveyörü
  pinStroke: 0.3,             // s
  dispenseT: 3.0,             // s
  wrapRps: 0.25,              // tur/s (15 dev/dk)
  wrapTurns: 9,               // 3 alt + 2 çıkış + 2 üst + 2 iniş
  stretchPerPallet: 1.0,      // % bobin
  mutingMax: 12,              // s, muting süre sınırı
  palletMag: 10, sheetMag: 24,
};

const JOB = { NONE: 0, PICK: 1, PLACE: 2, SHEET: 3, HOME: 4 };
const RES = { OK: 1, NO_PART: 10, DROPPED: 11, REJECTED: 12, ABORTED: 13, COLLISION: 14, NO_SHEET: 15, ZONE: 16, PLACED_ABORTED: 17 };
const HOME = { x: PG.pick.x + 0.08, y: PG.travelY, z: PG.pick.z - 0.12 };

const approach = (v, target, rate, dt) =>
  v < target ? Math.min(target, v + rate * dt) : Math.max(target, v - rate * dt);
const ease = (t) => t * t * (3 - 2 * t);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export class PalletCell {
  constructor(fab) {
    this.fab = fab;
    this.rob = {
      tcp: { ...HOME }, part: null, vacuum: false, error: false, homed: true,
      ackSeq: 0, resSeq: 0, resCode: 0, resSlot: 0, resJob: 0,
      job: null,             // { seq, type, slot, steps, i, t, from, released }
      busyS: 0, pickT: null, lastCycle: 0,
    };
    this.pallets = [];       // hattaki paletler: { id, x, target, from, slots[18], sheetBottom, sheetTop, turns, wrapped }
    this.nextPallet = 1;
    this.disp = { t: -1 };
    this.palletMag = C.palletMag;
    this.sheets = C.sheetMag;
    this.stretch = 100;
    this.pin = 1;
    this.wrap = { phase: 'idle', turns: 0, angle: 0 };
    this.pickupT = 0; this.pickupCnt = 0;
    this.safe = { ok: true, door: true, intrudeT: 0, mutedT: 0, cause: '' };
    this.done = [];          // alınan son paletler (rapor)
    this.out = 0; this.cmd = { job: 0, slot: 0, seq: 0 };
    this.testFeed = false; this.testFeedT = 0;
  }

  get faults() { return this.fab.faults; }
  get kpi() { return this.fab.kpi; }
  log(t, l) { this.fab.log(t, l); }

  // ---------------- yardımcılar ----------------
  palletAt(zone) { return this.pallets.find((p) => p.target == null && Math.abs(p.x - PG.zones[zone]) < 0.02); }
  zoneBusy(zone, self) {
    return this.pallets.some((q) => q !== self && (q.target === zone || Math.abs(q.x - PG.zones[zone]) < 0.85));
  }
  get crossing() { return this.pallets.some((p) => Math.abs(p.x - PG.curtainX) < PG.pallet.lx / 2 + 0.05); }
  get motorsOk() { return this.safe.ok && !this.fab.estop; }
  motor(zone) { return bitOf(this.out, 5 + zone) && this.motorsOk; }
  get stackTop() {
    const p = this.palletAt(1);
    if (!p) return PG.palletTop;
    const n = p.slots.filter(Boolean).length;
    return PG.palletTop + (p.sheetBottom ? PG.sheetH : 0) + Math.ceil(n / PG.perLayer) * PACK.h;
  }
  get packAtPick() {
    const sh = this.fab.shrink;
    return !!sh.headAtPick && !this.faults.exitBlocked;
  }
  get power() { return bitOf(this.out, 0) && this.safe.ok && !this.fab.estop; }
  get robReady() { const r = this.rob; return this.power && !r.job && !r.error; }
  get atHome() { const t = this.rob.tcp; return Math.abs(t.x - HOME.x) + Math.abs(t.y - HOME.y) + Math.abs(t.z - HOME.z) < 0.02; }
  get clearOfPallet() { return !inPalletZone(this.rob.tcp); }

  get diWord() {
    const w = this.wrap;
    return packBits([
      this.packAtPick,
      !!this.palletAt(0), !!this.palletAt(1), !!this.palletAt(2), !!this.palletAt(3),
      this.pin > 0.95,
      this.disp.t >= 0,
      w.phase !== 'run',               // WRAP_HOME: döner tabla başlangıç konumunda
      w.phase === 'run',
      w.phase === 'done',
      w.phase === 'fault',
      this.safe.ok,
      this.safe.door,
      !(this.safe.intrudeT > 0 || this.crossing),
      this.muted,
      !this.safe.ok && !this.tripCause(),   // güvenlik resetlenmeye hazır
    ]);
  }
  get robWord() {
    const r = this.rob;
    return packBits([
      this.power, this.robReady, !!r.job, this.atHome, this.clearOfPallet,
      !!r.part, r.vacuum, r.error, bitOf(this.out, 1) && !!r.job, r.homed,
    ]);
  }
  get ir() {
    const r = this.rob;
    return [this.diWord, this.robWord, r.ackSeq, r.resSeq, r.resCode, r.resSlot,
      Math.floor(this.wrap.turns), this.palletMag, this.sheets, this.pickupCnt, 0, r.resJob];
  }

  // ---------------- güvenlik kontrolcüsü ----------------
  get muted() {
    // muting sensörleri: palet perdeden geçerken ve C/D konveyörleri dönerken perde köprülenir
    return this.crossing && bitOf(this.out, 7) && bitOf(this.out, 8) && this.safe.mutedT < C.mutingMax;
  }
  tripCause() {
    if (this.fab.estop) return 'acil stop';
    if (!this.safe.door) return 'hücre kapısı açık';
    if (this.safe.intrudeT > 0 && !this.muted) return 'ışık perdesi kesildi';
    if (this.crossing && this.safe.mutedT >= C.mutingMax) return 'muting süre aşımı';
    return '';
  }
  stepSafety(dt) {
    const s = this.safe;
    s.intrudeT = Math.max(0, s.intrudeT - dt);
    s.mutedT = this.crossing ? s.mutedT + dt : 0;
    const cause = this.tripCause();
    if (cause && s.ok) {
      s.ok = false; s.cause = cause;
      this.log(`Paletleme güvenlik durdurması: ${cause}`, 'warn');
    }
    // güvenlik resetı fabrika reset butonundan doğrudan güvenlik kontrolcüsüne gelir
    if (!s.ok && !cause && this.fab.buttons.reset) { s.ok = true; s.cause = ''; this.log('Paletleme güvenliği resetlendi'); }
  }

  // ---------------- robot kontrolcüsü ----------------
  finishJob(code) {
    const r = this.rob, j = r.job;
    r.resSeq = j.seq; r.resCode = code; r.resSlot = j.slot; r.resJob = j.type;
    r.job = null;
  }

  plan(type, slot) {
    const steps = [];
    const t = this.rob.tcp;
    if (t.y < PG.travelY - 0.01) steps.push({ to: { x: t.x, y: PG.travelY, z: t.z } });   // önce güvenli yüksekliğe
    const above = (p) => ({ x: p.x, y: PG.travelY, z: p.z });
    if (type === JOB.PICK) {
      steps.push({ to: above(PG.pick) }, { to: { ...PG.pick } },
        { wait: C.gripT, act: 'grip' }, { to: above(PG.pick), carry: true });
    } else if (type === JOB.PLACE) {
      const s = slotPos(slot);
      const top = { x: s.x, y: s.y + PACK.h + 0.004, z: s.z };
      steps.push({ to: above(top), carry: true }, { to: top, carry: true, act: 'descend' },
        { wait: C.releaseT, act: 'release' }, { to: above(top) }, { to: { ...HOME } });
    } else if (type === JOB.SHEET) {
      const m = PG.sheetMag;
      const dst = { x: PG.zones[1], y: this.stackTop + PG.sheetH, z: PG.lineZ };
      steps.push({ to: above(m) }, { to: { ...m } }, { wait: C.gripT, act: 'gripSheet' }, { to: above(m), carry: true },
        { to: above(dst), carry: true }, { to: dst, carry: true, act: 'descend' }, { wait: C.releaseT, act: 'releaseSheet' },
        { to: above(dst) }, { to: { ...HOME } });
    } else if (type === JOB.HOME) {
      steps.push({ to: { ...HOME } });
    }
    return steps;
  }

  acceptJob() {
    const r = this.rob, c = this.cmd;
    if (!c.seq || c.seq === r.ackSeq || !this.robReady || bitOf(this.out, 1)) return;
    r.ackSeq = c.seq;
    r.job = { seq: c.seq, type: c.job, slot: c.slot, steps: [], i: 0, t: 0, from: null, released: false };
    const pal = this.palletAt(1);
    const permit = bitOf(this.out, 12) && pal && this.pin > 0.95;
    let reject = 0;
    if (!r.homed && c.job !== JOB.HOME) reject = RES.REJECTED;
    else if (c.job === JOB.PICK && r.part) reject = RES.REJECTED;
    else if (c.job === JOB.PLACE && (!r.part || r.part.sheet || c.slot < 1 || c.slot > PG.slots)) reject = RES.REJECTED;
    else if ((c.job === JOB.PLACE || c.job === JOB.SHEET) && !permit) reject = RES.ZONE;
    else if (c.job === JOB.SHEET && (r.part || (c.slot !== 0 && c.slot !== 1))) reject = RES.REJECTED;
    else if (c.job === JOB.SHEET && this.sheets <= 0) reject = RES.NO_SHEET;
    else if (![JOB.PICK, JOB.PLACE, JOB.SHEET, JOB.HOME].includes(c.job)) reject = RES.REJECTED;
    if (reject) {
      this.finishJob(reject);
      this.log(`Robot işi reddetti (iş ${c.job}, slot ${c.slot}, kod ${reject})`, 'warn');
      return;
    }
    r.job.steps = this.plan(c.job, c.slot);
    if (this.faults.robotCollision) r.job.collideAt = 0.4;
  }

  doAction(act) {
    const r = this.rob, j = r.job;
    const sh = this.fab.shrink;
    switch (act) {
      case 'grip':
        if (this.faults.vacuumFail || !this.packAtPick) {
          this.log(this.faults.vacuumFail ? 'Robot: vakum oluşmadı, paket alınamadı' : 'Robot: alma noktasında paket yok', 'warn');
          return RES.NO_PART;
        }
        r.part = sh.takeHead(); r.vacuum = true; r.pickT = this.fab.t;
        return 0;
      case 'gripSheet':
        if (this.sheets <= 0) return RES.NO_SHEET;
        this.sheets--; r.part = { sheet: true }; r.vacuum = true;
        return 0;
      case 'descend': {
        if (j.type !== JOB.PLACE) return 0;
        const p = this.palletAt(1);
        if (p && p.slots[j.slot - 1]) {             // defter tutma hatası: dolu slota iniyor
          r.error = true; r.homed = false;
          this.kpi.robotCrashes++;
          this.log(`Robot çarpışması: slot ${j.slot} zaten dolu (paletteki paket sayısı PLC ile tutmuyor)`, 'error');
          return RES.COLLISION;
        }
        return 0;
      }
      case 'release': {
        const p = this.palletAt(1);
        p.slots[j.slot - 1] = r.part;
        this.fab.emit('place', { pallet: p.id, slot: j.slot, pack: r.part.id });
        r.part = null; r.vacuum = false; j.released = true;
        if (r.pickT != null) { r.lastCycle = this.fab.t - r.pickT; r.pickT = null; }
        return 0;
      }
      case 'releaseSheet': {
        const p = this.palletAt(1);
        if (j.slot === 0) p.sheetBottom = true; else p.sheetTop = true;
        r.part = null; r.vacuum = false; j.released = true;
        return 0;
      }
      default: return 0;
    }
  }

  stepRobot(dt) {
    const r = this.rob, j = r.job;
    if (!j) return;
    // güç kesildi ya da PLC iptal etti: iş yarıda kalır; bırakma noktası geçildiyse bu ayrıca bildirilir
    if (!this.power || bitOf(this.out, 2)) {
      this.finishJob(j.released ? RES.PLACED_ABORTED : RES.ABORTED);
      this.log(`Robot işi yarıda kesildi${j.released ? ' (paket bırakılmıştı)' : ''}`, 'warn');
      return;
    }
    if (bitOf(this.out, 1)) return;                  // HOLD: kontrollü duruş, iş devam edecek
    r.busyS += dt;
    const st = j.steps[j.i];
    if (!st) {
      if (j.type === JOB.HOME) r.homed = true;
      this.finishJob(RES.OK);
      return;
    }
    if (st.wait != null) {
      j.t += dt;
      if (j.t >= st.wait) {
        const code = this.doAction(st.act);
        if (code) { this.finishJob(code); return; }
        j.i++; j.t = 0; j.from = null;
      }
      return;
    }
    if (!j.from) {
      j.from = { ...r.tcp };
      if (st.act === 'descend') {
        const code = this.doAction('descend');
        if (code) { this.finishJob(code); return; }
      }
      const dh = dist(j.from, st.to), dv = Math.abs(j.from.y - st.to.y);
      j.dur = Math.max(0.15, dh / C.vH, dv / C.vV);
      if (st.carry && r.part && !r.part.sheet && this.faults.vacuumDrop) j.dropAt = 0.5;
    }
    j.t += dt;
    const k = Math.min(1, j.t / j.dur);
    const e = ease(k);
    for (const ax of ['x', 'y', 'z']) r.tcp[ax] = j.from[ax] + (st.to[ax] - j.from[ax]) * e;
    if (j.collideAt != null && k >= j.collideAt) {
      r.error = true; r.homed = false; this.faults.robotCollision = false;
      this.kpi.robotCrashes++;
      this.log('Robot çarpışma algıladı ve durdu (eve dönüş gerekli)', 'error');
      this.finishJob(RES.COLLISION);
      return;
    }
    if (j.dropAt != null && k >= j.dropAt && r.part) {
      this.faults.vacuumDrop = false;
      this.kpi.packsDropped++;
      this.log(`Robot taşırken vakum kaçırdı: paket #${r.part.id} hücreye düştü`, 'error');
      this.fab.emit('pack_drop', { pack: r.part.id });
      r.part = null; r.vacuum = false; r.error = true; r.pickT = null;
      this.finishJob(RES.DROPPED);
      return;
    }
    if (k >= 1) { j.i++; j.t = 0; j.from = null; j.dropAt = null; }
  }

  // ---------------- palet hattı ----------------
  stepLine(dt) {
    // besleme magazini
    if (bitOf(this.out, 4) && this.disp.t < 0 && this.palletMag > 0 && !this.zoneBusy(0) && this.motorsOk) this.disp.t = 0;
    if (this.disp.t >= 0 && this.motorsOk) {
      this.disp.t += dt;
      if (this.disp.t >= C.dispenseT) {
        this.disp.t = -1; this.palletMag--;
        this.pallets.push({ id: this.nextPallet++, x: PG.zones[0], target: null, from: 0,
          slots: Array(PG.slots).fill(null), sheetBottom: false, sheetTop: false, turns: 0, wrapped: false });
        this.fab.emit('pallet_start', { pallet: this.nextPallet - 1 });
      }
    }
    // durdurma pimi (B istasyonu)
    this.pin = approach(this.pin, bitOf(this.out, 9) ? 1 : 0, 1 / C.pinStroke, dt);

    const robotInZone = inPalletZone(this.rob.tcp) && this.rob.tcp.y < this.stackTop + 0.4;
    for (const p of [...this.pallets].sort((a, b) => b.x - a.x)) {
      if (p.target == null) {
        const z = PG.zones.findIndex((x) => Math.abs(p.x - x) < 0.02);
        if (z < 0 || z >= 3) continue;
        const can = this.motor(z) && this.motor(z + 1) && !this.zoneBusy(z + 1, p)
          && !(z === 1 && this.pin > 0.05) && !(z === 2 && this.wrap.phase === 'run');
        if (can) { p.target = z + 1; p.from = z; }
      } else {
        if (!(this.motor(p.from) && this.motor(p.target))) continue;
        if (this.faults.palletJam && p.from === 1 && p.x > PG.zones[1] + 0.35) continue;   // makara sıkıştı
        p.x = Math.min(PG.zones[p.target], p.x + C.convV * dt);
        if (p.target === 3 && !this.fab.agv.forksClear('D_DOCK') && !p.crashLogged) {
          p.crashLogged = true; this.kpi.robotCrashes++;
          this.log('Palet, AGV çatalları alım noktasındayken konveyöre sürüldü', 'error');
        }
        if (p.from === 1 && robotInZone && !p.crashLogged) {
          p.crashLogged = true; this.kpi.robotCrashes++;
          this.log('Palet, robot istif bölgesindeyken hareket etti (bölge kilidi ihlali)', 'error');
        }
        if (p.x >= PG.zones[p.target] - 1e-6) { p.x = PG.zones[p.target]; p.target = null; }
      }
    }

    // streç sarma makinesi (kendi kontrolcüsü; istek "bitti" görülene kadar tutulur)
    const w = this.wrap, pc = this.palletAt(2);
    const req = bitOf(this.out, 10);
    if (w.phase === 'idle' && req && pc && this.stretch > 0 && this.motorsOk) {
      w.phase = 'run'; w.turns = 0; w.pallet = pc;
    }
    if (w.phase === 'run' && this.motorsOk) {
      const d = C.wrapRps * dt;
      w.turns += d; w.angle += d * Math.PI * 2; w.pallet.turns += d;
      if (this.faults.stretchBreak && w.turns > 2) {
        w.phase = 'fault';
        this.log('Streç sarma: film koptu', 'warn');
      } else if (w.turns >= C.wrapTurns) {
        w.turns = C.wrapTurns; w.angle = 0; w.phase = 'done';
        w.pallet.wrapped = true;
        this.stretch = Math.max(0, this.stretch - C.stretchPerPallet);
      }
    }
    if (w.phase === 'done' && !req) w.phase = 'idle';
    if (!pc && w.phase === 'idle') w.turns = 0;
    if (w.phase === 'fault' && this.fab.buttons.reset && !this.faults.stretchBreak) { w.phase = 'idle'; w.angle = 0; }

  }

  // AGV çatalları paleti kaldırınca palet hücreden çıkar (alım noktası D)
  takeFromD() {
    const pd = this.palletAt(3);
    if (!pd) return null;
    this.pallets = this.pallets.filter((p) => p !== pd);
    this.pickupCnt = (this.pickupCnt + 1) % 30000;
    this.finishPallet(pd);
    return pd;
  }

  quality(p) {
    const n = p.slots.filter(Boolean).length;
    if (n < PG.slots) return `eksik (${n}/${PG.slots} paket)`;
    if (p.slots.some((k) => k.defect)) return 'hatalı paket var';
    if (!p.sheetBottom) return 'alt karton yok';
    if (!p.sheetTop) return 'üst karton yok';
    if (!p.wrapped) return 'streçlenmemiş';
    if (p.turns < C.wrapTurns - 0.01) return 'eksik sarım';
    return null;
  }

  finishPallet(p) {
    p.defect = this.quality(p);
    this.fab.emit('pallet_done', { pallet: p.id, packs: p.slots.filter(Boolean).length, turns: +p.turns.toFixed(1),
      sheets: (p.sheetBottom ? 1 : 0) + (p.sheetTop ? 1 : 0), simDefect: p.defect });
    if (p.defect) { this.kpi.palletsBad++; this.log(`HATALI PALET: #${p.id} (${p.defect})`, 'error'); }
    else { this.kpi.palletsGood++; this.log(`Palet #${p.id} AGV'ye verildi (${PG.slots} paket)`); }
    this.kpi.palletPacks += p.slots.filter(Boolean).length;
    this.done.push({ id: p.id, defect: p.defect, turns: +p.turns.toFixed(1) });
    if (this.done.length > 10) this.done.shift();
  }

  step(dt, hr) {
    this.out = this.fab.estop ? 0 : hr.do;
    this.cmd = hr;
    if (bitOf(this.out, 3) && this.rob.error) { this.rob.error = false; this.log('Robot hatası resetlendi'); }
    if (this.testFeed) {
      this.testFeedT += dt;
      if (this.testFeedT >= 5 && this.fab.shrink.injectTestPack()) this.testFeedT = 0;
    }
    this.stepSafety(dt);
    this.acceptJob();
    this.stepRobot(dt);
    this.stepLine(dt);
  }

  command(msg) {
    // Manual removal is an operator action, not a decision about the PLC ledger.
    // It never puts an incomplete pallet on the AGV route or changes robot records.
    if (msg.type === 'removeUnknownPallet') {
      const p = this.palletAt(1);
      if (this.out !== 0 || this.rob.job || !p) return;
      this.pallets = this.pallets.filter(q => q !== p);
      this.fab.emit('pallet_manual_remove', { pallet: p.id });
      this.log(`B istasyonu paleti #${p.id} operatör tarafından el ile alındı`, 'warn');
    }
    if (msg.type === 'door') {
      this.safe.door = !msg.value;
      this.log(msg.value ? 'Paletleme hücresi kapısı açıldı' : 'Paletleme hücresi kapısı kapandı', 'warn');
    }
    if (msg.type === 'testFeed') {
      this.testFeed = !!msg.value;
      this.log(msg.value ? 'Test besleyici açıldı (alma noktasına 5 s\'de bir hazır paket)' : 'Test besleyici kapandı', 'warn');
    }
    if (msg.type === 'intrude') { this.safe.intrudeT = 1.5; this.log('Biri ışık perdesinden geçti', 'warn'); }
    if (msg.type === 'refill' && msg.name === 'pallets') { this.palletMag = C.palletMag; this.log('Palet magazini dolduruldu'); }
    if (msg.type === 'refill' && msg.name === 'sheets') { this.sheets = C.sheetMag; this.log('Karton levha magazini dolduruldu'); }
    if (msg.type === 'refill' && msg.name === 'stretch') { this.stretch = 100; this.log('Streç film bobini değiştirildi'); }
  }

  snapshot() {
    const r = this.rob;
    const pv = (p) => (p.sheet ? { sheet: true } : packView(p));
    return {
      robot: {
        tcp: r.tcp, part: r.part && pv(r.part), vacuum: r.vacuum, error: r.error, homed: r.homed,
        job: r.job ? { type: r.job.type, slot: r.job.slot, seq: r.job.seq } : null,
        ackSeq: r.ackSeq, resSeq: r.resSeq, resCode: r.resCode, resSlot: r.resSlot, resJob: r.resJob,
        lastCycle: +r.lastCycle.toFixed(1), busyS: +r.busyS.toFixed(0),
      },
      pallets: this.pallets.map((p) => ({
        id: p.id, x: p.x, sheetBottom: p.sheetBottom, sheetTop: p.sheetTop, turns: +p.turns.toFixed(2), wrapped: p.wrapped,
        slots: p.slots.map((k) => k && packView(k)),
      })),
      disp: this.disp.t >= 0 ? this.disp.t / C.dispenseT : -1,
      palletMag: this.palletMag, sheets: this.sheets, stretch: this.stretch, pin: this.pin,
      wrap: { phase: this.wrap.phase, turns: this.wrap.turns, angle: this.wrap.angle },
      safe: { ok: this.safe.ok, door: this.safe.door, intrude: this.safe.intrudeT > 0, muted: this.muted, cause: this.safe.cause },
      pickupT: this.pickupT, done: this.done, testFeed: this.testFeed, di: this.diWord, rob: this.robWord, do: this.out,
    };
  }
}

export { C as PALLET_C, JOB as ROBOT_JOB, RES as ROBOT_RES };
