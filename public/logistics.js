// Lojistik alanı 3B: otonom istif aracı (AGV), yol ağı, şarj ve park yerleri, soğuk depo (raf, istif vinci,
// koridor kapısı), giriş konveyörü ve kontur/etiket kapısı, çıkış konveyörü ve kamyon rampası.
// Yerleşim public/logisticsgeo.js'den gelir (simülatörle aynı).
import * as THREE from 'three';
import { M, box, cyl, label } from './scene.js';
import { makePallet } from './palletizer.js';
import { bitOf } from './iomap.js';
import { PG, PACK } from './palletgeo.js';
import { RACK, CONV, NODES, EDGES, AGV as AG, loc } from './logisticsgeo.js';

const agvMat = new THREE.MeshStandardMaterial({ color: 0xf2c230, metalness: 0.2, roughness: 0.5 });
const rackMat = new THREE.MeshStandardMaterial({ color: 0x2c64b0, metalness: 0.4, roughness: 0.5 });
const beamMat = new THREE.MeshStandardMaterial({ color: 0xe8742a, metalness: 0.3, roughness: 0.5 });
const loadMat = new THREE.MeshStandardMaterial({ color: 0xe9eef3, roughness: 0.35, transparent: true, opacity: 0.92 });
const coldMat = new THREE.MeshPhysicalMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.08, roughness: 0.1, depthWrite: false, side: THREE.DoubleSide });
const lampMat = (c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.05 });
const LOAD_H = PG.palletH + PG.sheetH * 2 + PG.layers * PACK.h;   // dolu palet yüksekliği

// Depoda yüzlerce paket çizmemek için dolu palet: palet + streçli yük bloğu
function makeLoad() {
  const g = makePallet();
  g.userData.sheetB.visible = false; g.userData.sheetT.visible = false; g.userData.film.visible = false;
  const blk = box(0.56, LOAD_H - PG.palletH, 0.58, loadMat, 0, PG.palletH + (LOAD_H - PG.palletH) / 2, 0);
  const top = box(0.56, 0.006, 0.58, new THREE.MeshStandardMaterial({ color: 0xb08850 }), 0, LOAD_H + 0.003, 0);
  g.add(blk, top);
  return g;
}

function convBed(len, z, x0, x1) {
  const g = new THREE.Group();
  const cx = (x0 + x1) / 2;
  g.add(box(len, PG.rollerTop - 0.07, 0.62, M.frame, cx, (PG.rollerTop - 0.07) / 2, z));
  for (const dz of [-0.33, 0.33]) g.add(box(len, 0.05, 0.05, M.steelDark, cx, PG.rollerTop - 0.04, z + dz));
  const rollers = [];
  const n = Math.round(len / 0.1);
  for (let i = 0; i < n; i++) {
    const r = cyl(0.024, 0.024, 0.64, M.steel, x0 + (i + 0.5) * (len / n), PG.rollerTop - 0.024, z, 12);
    r.rotation.x = Math.PI / 2;
    g.add(r); rollers.push(r);
  }
  g.userData.rollers = rollers;
  return g;
}

export class LogisticsArea {
  constructor(scene) {
    this.scene = scene;
    this.loads = new Map();
    this.build();
  }

  build() {
    const s = this.scene;
    // AGV yolu (zemin çizgileri) ve istasyon işaretleri
    const lineMat = new THREE.MeshBasicMaterial({ color: 0x2f8cff, transparent: true, opacity: 0.55 });
    for (const [a, b] of EDGES) {
      const p = NODES[a], q = NODES[b];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.05), lineMat);
      m.rotation.x = -Math.PI / 2; m.rotation.z = -Math.atan2(q.z - p.z, q.x - p.x);
      m.position.set((p.x + q.x) / 2, 0.004, (p.z + q.z) / 2);
      s.add(m);
    }
    for (const n of Object.values(NODES)) {
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.07, 16), new THREE.MeshBasicMaterial({ color: 0x2f8cff }));
      d.rotation.x = -Math.PI / 2; d.position.set(n.x, 0.005, n.z); s.add(d);
    }
    const mark = (x, z, w, d, color, text) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25 }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, 0.003, z); s.add(m);
      if (text) s.add(label(text, x, 0.5, z));
    };
    mark(NODES.PARK.x, NODES.PARK.z, 1.6, 0.9, 0xe8b923, 'AGV park');
    mark(NODES.CHARGE.x, NODES.CHARGE.z, 1.6, 0.9, 0x2fd17a, 'Şarj istasyonu');
    const c = NODES.CHARGE;
    s.add(box(0.2, 0.9, 0.35, M.frame, c.x + 1.05, 0.45, c.z));
    this.chargeLamp = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), lampMat(0x30ff90));
    this.chargeLamp.position.set(c.x + 0.94, 0.8, c.z); s.add(this.chargeLamp);

    // soğuk depo kabuğu
    const x0 = RACK.colX[0] - 0.65, x1 = RACK.pdX + 0.5, z0 = RACK.sideZ[1] - 0.5, z1 = RACK.sideZ[0] + 0.5, H = 2.9;
    const wall = (w, h, x, y, z, ry) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), coldMat); m.position.set(x, y, z); m.rotation.y = ry; s.add(m); };
    wall(x1 - x0, H, (x0 + x1) / 2, H / 2, z0, 0);
    wall(x1 - x0, H, (x0 + x1) / 2, H / 2, z1, 0);
    wall(z1 - z0, H, x1, H / 2, (z0 + z1) / 2, Math.PI / 2);
    for (const [x, z] of [[x0, z0], [x0, z1], [x1, z0], [x1, z1]]) s.add(box(0.06, H, 0.06, M.steelDark, x, H / 2, z));
    s.add(box(x1 - x0, 0.05, 0.06, M.steelDark, (x0 + x1) / 2, H, z0), box(x1 - x0, 0.05, 0.06, M.steelDark, (x0 + x1) / 2, H, z1));
    // batı ucunda koridor kapısı, yanında duvar
    wall(z1 - z0, H, x0, H / 2, (z0 + z1) / 2, Math.PI / 2);
    this.aisleDoor = new THREE.Group();
    this.aisleDoor.position.set(x0 - 0.01, 0, RACK.aisleZ + 0.45);
    const dp = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 2.0), new THREE.MeshStandardMaterial({ color: 0x9fb4c6, side: THREE.DoubleSide }));
    dp.position.set(0, 1.0, -0.45); dp.rotation.y = Math.PI / 2;
    this.aisleDoor.add(dp);
    s.add(this.aisleDoor);
    this.tCanvas = document.createElement('canvas'); this.tCanvas.width = 256; this.tCanvas.height = 96;
    this.tTex = new THREE.CanvasTexture(this.tCanvas); this.tTex.colorSpace = THREE.SRGBColorSpace;
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.15), new THREE.MeshBasicMaterial({ map: this.tTex }));
    disp.position.set(x1 + 0.01, 2.3, RACK.aisleZ); disp.rotation.y = Math.PI / 2;
    s.add(disp);
    s.add(label('12 · Soğuk depo (AS/RS, 36 göz)', (x0 + x1) / 2, H + 0.3, RACK.aisleZ));

    // raf
    for (let side = 0; side < 2; side++) {
      const zc = RACK.sideZ[side];
      for (let i = 0; i <= RACK.cols; i++) {
        const x = RACK.colX[0] - 0.5 + i;
        for (const dz of [-0.38, 0.38]) s.add(box(0.07, RACK.height, 0.07, rackMat, x, RACK.height / 2, zc + dz));
      }
      const L = RACK.cols * 1.0;
      const xm = RACK.colX[0] - 0.5 + L / 2;
      for (const y of RACK.levelY) {
        const by = y - 0.035;
        for (const dz of [-0.38, 0.38]) s.add(box(L, 0.07, 0.05, beamMat, xm, by, zc + dz));
      }
    }

    // vinç: zemin ve tavan rayı, direk, taşıyıcı, teleskopik çatal
    const az = RACK.aisleZ, rx0 = x0 + 0.1, rx1 = RACK.pdX + 0.4;
    s.add(box(rx1 - rx0, 0.06, 0.12, M.steelDark, (rx0 + rx1) / 2, 0.03, az));
    s.add(box(rx1 - rx0, 0.06, 0.1, M.steelDark, (rx0 + rx1) / 2, RACK.height + 0.25, az));
    this.crane = new THREE.Group();
    this.crane.add(box(0.5, 0.25, 0.4, M.blue, 0, 0.18, 0));
    this.crane.add(box(0.14, RACK.height + 0.1, 0.14, M.blue, -0.18, (RACK.height + 0.1) / 2 + 0.25, 0));
    this.crane.add(box(0.3, 0.1, 0.2, M.blue, -0.05, RACK.height + 0.2, 0));
    this.carriage = new THREE.Group();
    this.carriage.add(box(0.12, 0.3, 0.5, M.steelDark, -0.08, 0.1, 0));
    this.fork = new THREE.Group();
    for (const dx of [-0.25, 0.25]) this.fork.add(box(0.1, 0.04, 0.7, M.steel, dx, -0.02, 0));
    this.carriage.add(this.fork);
    this.crane.add(this.carriage);
    this.craneLamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), lampMat(0xffa020));
    this.craneLamp.position.set(-0.05, RACK.height + 0.3, 0);
    this.crane.add(this.craneLamp);
    s.add(this.crane);

    // giriş konveyörü ve kontur/etiket kapısı; çıkış konveyörü ve kamyon
    this.inBed = convBed(CONV.inX0 + 0.45 - (CONV.inX1 - 0.45), CONV.inZ, CONV.inX1 - 0.45, CONV.inX0 + 0.45);
    this.outBed = convBed(CONV.outX1 + 0.45 - (CONV.outX0 - 0.45), CONV.outZ, CONV.outX0 - 0.45, CONV.outX1 + 0.45);
    s.add(this.inBed, this.outBed);
    const gx = CONV.inCheckX;
    for (const dz of [-0.42, 0.42]) s.add(box(0.06, 1.25, 0.06, M.frame, gx, 0.62, CONV.inZ + dz));
    s.add(box(0.08, 0.08, 0.92, M.frame, gx, 1.27, CONV.inZ));
    this.gateLamp = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.3), lampMat(0x30ff90));
    this.gateLamp.position.set(gx, 1.33, CONV.inZ); s.add(this.gateLamp);
    this.scanner = box(0.08, 0.1, 0.06, M.steelDark, gx + 0.05, 0.75, CONV.inZ + 0.46); s.add(this.scanner);
    this.scanBeam = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.5), new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0 }));
    this.scanBeam.position.set(gx + 0.05, 0.75, CONV.inZ + 0.2); this.scanBeam.rotation.x = -Math.PI / 2;
    s.add(this.scanBeam);
    s.add(label('Kontur + etiket kontrolü', gx, 1.55, CONV.inZ));
    this.rejectLamp = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), lampMat(0xff3030));
    this.rejectLamp.position.set(gx, 1.45, CONV.inZ + 0.45); s.add(this.rejectLamp);
    // kamyon (dorse, arka kapı rampaya bakar)
    const tx = CONV.outX1 + 2.1, tz = CONV.outZ;
    const trailer = new THREE.MeshStandardMaterial({ color: 0xdfe3e7, roughness: 0.6 });
    s.add(box(3.4, 1.9, 1.5, trailer, tx + 0.5, 1.35, tz));
    s.add(box(0.8, 1.4, 1.4, new THREE.MeshStandardMaterial({ color: 0x1f5fa8 }), tx + 2.6, 1.1, tz));
    for (const dx of [-0.6, 1.4, 2.6]) for (const dz of [-0.62, 0.62]) {
      const w = cyl(0.3, 0.3, 0.2, M.rubber, tx + dx, 0.3, tz + dz); w.rotation.x = Math.PI / 2; s.add(w);
    }
    s.add(box(0.6, 0.06, 1.3, M.steelDark, CONV.outX1 + 0.7, 0.36, tz));       // rampa köprüsü
    s.add(label('Kamyon rampası', CONV.outX1 + 0.8, 2.6, tz));
    s.add(label('Depo girişi', CONV.inX0, 0.95, CONV.inZ));

    // AGV: gövde, direk, çatal, tarayıcı alanı
    this.agv = new THREE.Group();
    this.body = new THREE.Group();
    this.body.add(box(AG.bodyLen, 0.9, AG.width, agvMat, 0, 0.45, 0));
    this.body.add(box(AG.bodyLen * 0.9, 0.05, AG.width * 0.9, M.frame, 0, 0.93, 0));
    for (const dz of [-0.28, 0.28]) this.body.add(box(0.06, 1.5, 0.06, M.steelDark, AG.bodyLen / 2 + 0.04, 0.75, dz));
    this.agvLamp = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 14), lampMat(0x30ff90));
    this.agvLamp.position.set(-0.1, 1.0, 0); this.body.add(this.agvLamp);
    this.batt = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.3), new THREE.MeshBasicMaterial({ color: 0x2fd17a }));
    this.batt.position.set(-AG.bodyLen / 2 - 0.011, 0.75, 0); this.body.add(this.batt);
    this.field = new THREE.Mesh(new THREE.CircleGeometry(1.2, 24, Math.PI * 0.75, Math.PI * 0.5),
      new THREE.MeshBasicMaterial({ color: 0x30ff90, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    this.field.rotation.x = -Math.PI / 2; this.field.position.set(-AG.bodyLen / 2, 0.01, 0);
    this.body.add(this.field);
    this.forks = new THREE.Group();
    for (const dz of [-0.2, 0.2]) this.forks.add(box(AG.forkLen, 0.05, 0.14, M.steelDark, 0, 0, dz));
    this.forks.add(box(0.05, 0.5, 0.56, M.steelDark, -AG.forkLen / 2, 0.25, 0));
    this.agv.add(this.body, this.forks);
    s.add(this.agv);
  }

  loadMesh(id) {
    let g = this.loads.get(id);
    if (!g) { g = makeLoad(); this.scene.add(g); this.loads.set(id, g); }
    return g;
  }

  update(agv, asrs, dt) {
    if (!agv || !asrs) return;
    const seen = new Set();
    // AGV: konum yük merkezi, yaw çatal yönü; gövde çatalın arkasında
    const p = agv.pose;
    this.agv.position.set(p.x, 0, p.z);
    this.agv.rotation.y = p.yaw;
    this.body.position.set(-(AG.forkLen / 2 + AG.bodyLen / 2), 0, 0);
    const forkY = PG.rollerTop - 0.06 + agv.lift * 0.16;
    this.forks.position.set(0, forkY, 0);
    const col = agv.error ? 0xff3030 : agv.scan.stop ? 0xff3030 : agv.scan.warn ? 0xffc030 : agv.waitPermit ? 0x4da3ff : 0x30ff90;
    this.agvLamp.material.emissive.setHex(col); this.agvLamp.material.emissiveIntensity = agv.order || agv.error ? 2 : 0.6;
    this.field.material.color.setHex(agv.scan.stop ? 0xff3030 : agv.scan.warn ? 0xffc030 : 0x30ff90);
    this.field.material.opacity = agv.scan.stop ? 0.3 : 0.12;
    this.batt.scale.z = Math.max(0.05, agv.battery / 100);
    this.batt.position.z = -0.15 * (1 - agv.battery / 100);
    this.batt.material.color.setHex(agv.battery < 30 ? 0xff4d4f : 0x2fd17a);
    this.chargeLamp.material.emissiveIntensity = agv.charging ? 2 : 0.1;
    if (agv.load) {
      const g = this.loadMesh(agv.load.id);
      g.position.set(p.x, forkY + 0.06, p.z); g.rotation.y = p.yaw; seen.add(agv.load.id);
    }

    // konveyörler
    const roll = (bed, on) => { if (on) for (const r of bed.userData.rollers) r.rotation.y += dt * 10; };
    roll(this.inBed, bitOf(asrs.do, 3) || bitOf(asrs.do, 4));
    roll(this.outBed, bitOf(asrs.do, 5));
    for (const e of asrs.inConv) { const g = this.loadMesh(e.id); g.position.set(e.x, PG.rollerTop, CONV.inZ); g.rotation.y = 0; seen.add(e.id); }
    for (const e of asrs.outConv) { const g = this.loadMesh(e.id); g.position.set(e.x, PG.rollerTop, CONV.outZ); g.rotation.y = 0; seen.add(e.id); }
    const ch = asrs.check;
    this.gateLamp.material.emissive.setHex(!ch ? 0x30ff90 : ch.contourOk && ch.readOk ? 0x30ff90 : 0xff3030);
    this.gateLamp.material.emissiveIntensity = ch ? 1.8 : 0.3;
    this.scanBeam.material.opacity = ch ? 0.5 : 0;
    this.rejectLamp.material.emissiveIntensity = bitOf(asrs.do, 7) ? (Math.sin(performance.now() / 150) > 0 ? 2.5 : 0.1) : 0.05;

    // raf
    asrs.rack.forEach((id, i) => {
      if (!id) return;
      const l = loc(i + 1);
      const g = this.loadMesh(id); g.position.set(l.x, l.y, l.z); g.rotation.y = 0; seen.add(id);
    });

    // vinç
    const c = asrs.crane;
    this.crane.position.set(c.x, 0, RACK.aisleZ);
    this.carriage.position.set(0, c.y - 0.02, 0);
    this.fork.position.set(0, 0, c.f * 0.75);          // taraf 1 (+z) için f = +1
    this.craneLamp.material.emissive.setHex(c.error ? 0xff3030 : 0xffa020);
    this.craneLamp.material.emissiveIntensity = c.job || c.error ? 2 : 0.1;
    if (c.load) {
      const g = this.loadMesh(c.load.id);
      g.position.set(c.x, c.y, RACK.aisleZ + c.f * 0.75); g.rotation.y = 0; seen.add(c.load.id);
    }
    for (const [id, g] of this.loads) if (!seen.has(id)) { this.scene.remove(g); this.loads.delete(id); }

    // koridor kapısı ve sıcaklık
    const target = asrs.safe.door ? 0 : -1.4;
    this.aisleDoor.rotation.y += (target - this.aisleDoor.rotation.y) * Math.min(1, dt * 5);
    this.tT = (this.tT || 0) + dt;
    if (this.tT > 0.4) {
      this.tT = 0;
      const g = this.tCanvas.getContext('2d');
      g.fillStyle = '#0b1210'; g.fillRect(0, 0, 256, 96);
      g.fillStyle = asrs.temp > 6 ? '#ff4d4f' : '#5aa9ff';
      g.font = 'bold 54px Consolas, monospace'; g.textAlign = 'right';
      g.fillText(`${asrs.temp.toFixed(1)} °C`, 240, 68);
      this.tTex.needsUpdate = true;
    }
  }
}
