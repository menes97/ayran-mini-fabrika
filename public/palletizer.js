// Paletleme hücresi: 4 eksenli paletleme robotu (IK yalnızca görselde), palet besleyici, makaralı
// konveyörler, durdurma pimi, karton levha magazini, döner tablalı streç makinesi, çit, kapı,
// ışık perdesi ve alım noktası. Yerleşim public/palletgeo.js'den gelir (simülatörle aynı).
import * as THREE from 'three';
import { M, box, cyl, label } from './scene.js';
import { makePack, applyPack } from './packaging.js';
import { bitOf } from './iomap.js';
import { PG, PACK, slotPos } from './palletgeo.js';

const wood = new THREE.MeshStandardMaterial({ color: 0xc9a26b, roughness: 0.85 });
const woodDark = new THREE.MeshStandardMaterial({ color: 0xa9824f, roughness: 0.9 });
const card = new THREE.MeshStandardMaterial({ color: 0xb08850, roughness: 0.9 });
const robotMat = new THREE.MeshStandardMaterial({ color: 0xe8742a, metalness: 0.3, roughness: 0.45 });
const robotDark = new THREE.MeshStandardMaterial({ color: 0x3a3f45, metalness: 0.5, roughness: 0.5 });
const fenceMat = new THREE.MeshStandardMaterial({ color: 0xe0c341, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
const postMat = new THREE.MeshStandardMaterial({ color: 0xd9b62a, metalness: 0.3, roughness: 0.5 });
const stretchMat = new THREE.MeshPhysicalMaterial({ color: 0xe9f3ff, transparent: true, opacity: 0, roughness: 0.1, depthWrite: false, side: THREE.DoubleSide });
const lampMat = (c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.05 });

const L1 = 0.85, L2 = 0.95, SH_X = 0.1, SH_Y = 0.85, TOOL = 0.28;
const ZB = PG.zones[1];

export function makePallet() {
  const g = new THREE.Group();
  const { lx, lz } = PG.pallet;
  for (let i = 0; i < 5; i++) g.add(box(lx, 0.022, 0.1, wood, 0, PG.palletH - 0.011, (i - 2) * (lz - 0.1) / 4));
  for (const z of [-(lz - 0.1) / 2, 0, (lz - 0.1) / 2]) {
    g.add(box(lx, 0.022, 0.1, woodDark, 0, PG.palletH - 0.033, z));
    for (const x of [-(lx - 0.1) / 2, 0, (lx - 0.1) / 2]) g.add(box(0.1, 0.078, 0.1, woodDark, x, 0.061, z));
  }
  for (const x of [-(lx - 0.1) / 2, 0, (lx - 0.1) / 2]) g.add(box(0.1, 0.022, lz, wood, x, 0.011, 0));
  const sheetB = box(0.78, PG.sheetH, 0.58, card, 0, PG.palletH + PG.sheetH / 2, 0);
  const sheetT = box(0.78, PG.sheetH, 0.58, card, 0, 0, 0);
  const film = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), stretchMat.clone());
  film.renderOrder = 4;
  g.add(sheetB, sheetT, film);
  g.userData = { sheetB, sheetT, film, packs: [] };
  return g;
}

function rollerBed(len, n) {
  const g = new THREE.Group();
  g.add(box(len, 0.05, 0.05, M.steelDark, 0, PG.rollerTop - 0.04, -0.33));
  g.add(box(len, 0.05, 0.05, M.steelDark, 0, PG.rollerTop - 0.04, 0.33));
  const rollers = [];
  for (let i = 0; i < n; i++) {
    const r = cyl(0.024, 0.024, 0.64, M.steel, -len / 2 + (i + 0.5) * (len / n), PG.rollerTop - 0.024, 0, 12);
    r.rotation.x = Math.PI / 2;
    g.add(r); rollers.push(r);
  }
  g.userData.rollers = rollers;
  return g;
}

export class PalletArea {
  constructor(scene) {
    this.scene = scene;
    this.pallets = new Map();
    this.packCache = new Map();
    this.build();
  }

  build() {
    const s = this.scene;
    const z = PG.lineZ;
    // zemin işaretleri: hücre alanı ve alım noktası
    const floorMark = (w, d, x, zz, color) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18 }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, 0.003, zz); s.add(m);
    };
    floorMark(PG.fence.x1 - PG.fence.x0, PG.fence.z1 - PG.fence.z0, (PG.fence.x0 + PG.fence.x1) / 2, (PG.fence.z0 + PG.fence.z1) / 2, 0x6b7785);
    floorMark(1.1, 0.95, PG.zones[3], z, 0x2fd17a);

    // konveyörler: A, B, D makaralı; C döner tabla üstünde
    this.beds = [];
    for (const i of [0, 1, 3]) {
      const x = PG.zones[i];
      s.add(box(1.1, PG.rollerTop - 0.07, 0.62, M.frame, x, (PG.rollerTop - 0.07) / 2, z));
      const bed = rollerBed(1.14, 11);
      bed.position.set(x, 0, z);
      s.add(bed); this.beds[i] = bed;
    }
    const xc = PG.zones[2];
    s.add(cyl(0.62, 0.66, 0.14, M.frame, xc, 0.07, z));
    this.turntable = new THREE.Group();
    this.turntable.position.set(xc, 0, z);
    this.turntable.add(cyl(0.6, 0.6, 0.06, M.steelDark, 0, 0.17, 0));
    this.turntable.add(box(1.0, PG.rollerTop - 0.24, 0.6, M.frame, 0, 0.2 + (PG.rollerTop - 0.24) / 2 - 0.05, 0));
    const bedC = rollerBed(1.0, 10);
    this.turntable.add(bedC); this.beds[2] = bedC;
    s.add(this.turntable);

    // palet besleyici (A): dört dikme ve palet yığını
    const xa = PG.zones[0];
    for (const dx of [-0.46, 0.46]) for (const dz of [-0.36, 0.36]) s.add(box(0.06, 1.55, 0.06, M.blue, xa + dx, 0.775, z + dz));
    s.add(box(1.0, 0.06, 0.06, M.blue, xa, 1.55, z - 0.36), box(1.0, 0.06, 0.06, M.blue, xa, 1.55, z + 0.36));
    this.stack = [];
    for (let i = 0; i < 6; i++) {
      const p = makePallet();
      p.userData.sheetB.visible = p.userData.sheetT.visible = p.userData.film.visible = false;
      s.add(p); this.stack.push(p);
    }
    s.add(label('Palet besleme', xa, 1.75, z));

    // durdurma pimi (B'nin akış yönündeki ucu)
    this.pin = cyl(0.02, 0.02, 0.12, M.steelDark, ZB + 0.44, PG.rollerTop - 0.06, z);
    s.add(this.pin);

    // karton levha magazini
    const m = PG.sheetMag;
    this.sheetStand = box(0.62, 1, 0.5, M.frame, m.x, 0.3, m.z);
    this.sheetStack = box(0.78, 1, 0.58, card, m.x, m.y, m.z);
    s.add(this.sheetStand, this.sheetStack);
    s.add(label('Karton levha', m.x, m.y + 0.35, m.z));

    // streç makinesi direği ve arabası
    const mz = z - 0.82;
    s.add(box(0.14, 2.0, 0.14, M.frame, xc, 1.0, mz), box(0.4, 0.06, 0.3, M.frame, xc, 0.03, mz));
    this.carriage = new THREE.Group();
    this.carriage.add(box(0.22, 0.26, 0.16, M.blue, 0, 0, 0));
    this.roll = cyl(0.055, 0.055, 0.32, new THREE.MeshStandardMaterial({ color: 0xdfe8ef, roughness: 0.3 }), 0, 0, 0.14);
    this.carriage.add(this.roll);
    this.carriage.position.set(xc, 0.6, mz + 0.12);
    s.add(this.carriage);
    this.wrapLamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), lampMat(0xffa020));
    this.wrapLamp.position.set(xc, 2.06, mz);
    s.add(this.wrapLamp);
    s.add(label('11 · Streç sarma', xc, 2.25, mz));

    // çit, kapı ve ışık perdesi
    const F = PG.fence, H = 1.6;
    const panel = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const p = new THREE.Mesh(new THREE.PlaneGeometry(len, H - 0.1), fenceMat);
      p.position.set((x0 + x1) / 2, 0.1 + (H - 0.1) / 2, (z0 + z1) / 2);
      p.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
      s.add(p);
      const n = Math.max(1, Math.round(len / 0.9));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        s.add(box(0.04, H, 0.04, postMat, x0 + (x1 - x0) * t, H / 2, z0 + (z1 - z0) * t));
      }
      s.add(box(Math.abs(x1 - x0) + 0.04, 0.03, Math.abs(z1 - z0) + 0.04, postMat, (x0 + x1) / 2, H, (z0 + z1) / 2));
    };
    const W = F.x0, E = F.x1;
    panel(W, F.z0, W, z - 0.42); panel(W, z + 0.42, W, -0.36); panel(W, 0.04, W, F.z1);
    panel(E, F.z0, E, z - 0.44); panel(E, z + 0.44, E, F.z1);
    panel(W, F.z0, E, F.z0);
    panel(W, F.z1, PG.doorX - 0.45, F.z1); panel(PG.doorX + 0.45, F.z1, E, F.z1);
    this.door = new THREE.Group();
    this.door.position.set(PG.doorX - 0.45, 0, F.z1);
    const dp = new THREE.Mesh(new THREE.PlaneGeometry(0.88, H - 0.1), fenceMat);
    dp.position.set(0.45, 0.1 + (H - 0.1) / 2, 0);
    this.door.add(dp, box(0.04, H, 0.04, postMat, 0.9, H / 2, 0), box(0.9, 0.03, 0.04, postMat, 0.45, H, 0));
    s.add(this.door);
    this.doorLamp = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), lampMat(0x30ff90));
    this.doorLamp.position.set(PG.doorX + 0.5, 1.3, F.z1 + 0.03);
    s.add(this.doorLamp, box(0.08, 0.14, 0.05, M.frame, PG.doorX + 0.5, 1.15, F.z1 + 0.02));
    s.add(label('Bakım kapısı', PG.doorX, 1.85, F.z1));

    const cz0 = z - 0.44, cz1 = z + 0.44;
    for (const cz of [cz0, cz1]) s.add(box(0.05, 1.3, 0.05, M.frame, E, 0.65, cz));
    this.beams = [];
    for (let i = 0; i < 8; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.006, cz1 - cz0),
        new THREE.MeshBasicMaterial({ color: 0x30ff90, transparent: true, opacity: 0.5 }));
      b.position.set(E, 0.2 + i * 0.14, z);
      s.add(b); this.beams.push(b);
    }
    this.muteLamps = [cz0, cz1].map((cz) => {
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), lampMat(0xffffff));
      l.position.set(E, 1.34, cz); s.add(l); return l;
    });
    s.add(label('Işık perdesi', E, 1.55, z));

    // alım noktası
    this.pickLamp = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 16), lampMat(0x30ff90));
    this.pickLamp.position.set(PG.zones[3] + 0.5, 1.2, z - 0.4);
    s.add(this.pickLamp, box(0.04, 1.16, 0.04, M.frame, PG.zones[3] + 0.5, 0.58, z - 0.4));
    s.add(label('Alım noktası (AGV)', PG.zones[3], 1.4, z));

    // robot
    const b = PG.base;
    s.add(cyl(0.24, 0.28, 0.45, robotDark, b.x, 0.225, b.z));
    this.turret = new THREE.Group();
    this.turret.position.set(b.x, 0.45, b.z);
    this.turret.add(cyl(0.22, 0.22, 0.12, robotMat, 0, 0.06, 0));
    this.turret.add(box(0.36, 0.34, 0.3, robotMat, 0.02, 0.29, 0));
    this.upper = new THREE.Group();
    this.upper.position.set(SH_X, SH_Y - 0.45, 0);
    this.upper.add(box(L1, 0.13, 0.14, robotMat, L1 / 2, 0, 0));
    this.upper.add(cyl(0.09, 0.09, 0.2, robotDark, 0, 0, 0).rotateX(Math.PI / 2));
    this.fore = new THREE.Group();
    this.fore.add(box(L2, 0.1, 0.11, robotMat, L2 / 2, 0, 0));
    this.fore.add(cyl(0.07, 0.07, 0.17, robotDark, 0, 0, 0).rotateX(Math.PI / 2));
    this.turret.add(this.upper, this.fore);
    s.add(this.turret);
    this.wrist = new THREE.Group();
    this.wrist.add(cyl(0.035, 0.035, TOOL - 0.03, robotDark, 0, -(TOOL - 0.03) / 2, 0));
    this.gripper = box(0.28, 0.03, 0.2, M.steelDark, 0, -TOOL + 0.015, 0);
    this.wrist.add(this.gripper);
    this.vacLamp = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), lampMat(0x4da3ff));
    this.vacLamp.position.set(0, -TOOL + 0.06, 0.1);
    this.wrist.add(this.vacLamp);
    s.add(this.wrist);
    this.heldSheet = box(0.78, PG.sheetH, 0.58, card, 0, 0, 0);
    this.heldSheet.visible = false;
    s.add(this.heldSheet);
    this.tower = ['red', 'yellow', 'green'].map((c, i) => {
      const l = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.06, 16), lampMat({ red: 0xff3030, yellow: 0xffc030, green: 0x30ff90 }[c]));
      l.position.set(PG.fence.x0 + 0.05, 1.86 - i * 0.065, PG.fence.z1);
      s.add(l); return l;
    });
    s.add(box(0.03, 0.2, 0.03, M.frame, PG.fence.x0 + 0.05, 1.7, PG.fence.z1));
    s.add(label('10 · Paletleme robotu', b.x, 2.3, b.z));
  }

  // 4 eksenli robot: taban dönüşü + iki kol (düzlemde IK); el her zaman yatay (paralelkenar mekanizması)
  pose(tcp) {
    const b = PG.base;
    const w = { x: tcp.x, y: tcp.y + TOOL, z: tcp.z };
    const dx = w.x - b.x, dz = w.z - b.z;
    this.turret.rotation.y = Math.atan2(-dz, dx);
    const d = Math.hypot(dx, dz) - SH_X, h = w.y - SH_Y;
    const c = Math.min(L1 + L2 - 1e-3, Math.max(0.05, Math.hypot(d, h)));
    const a = Math.atan2(h, d);
    const k = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + c * c - L2 * L2) / (2 * L1 * c))));
    const t1 = a + k;
    const ex = L1 * Math.cos(t1), ey = L1 * Math.sin(t1);
    this.upper.rotation.z = t1;
    this.fore.position.set(SH_X + ex, SH_Y - 0.45 + ey, 0);
    this.fore.rotation.z = Math.atan2(h - ey, d - ex);
    this.wrist.position.set(w.x, w.y, w.z);
  }

  packMesh(p) {
    let g = this.packCache.get(p.id);
    if (!g) { g = makePack(); this.scene.add(g); this.packCache.set(p.id, g); }
    applyPack(g, p);
    return g;
  }

  palletMesh(p) {
    let g = this.pallets.get(p.id);
    if (!g) { g = makePallet(); this.scene.add(g); this.pallets.set(p.id, g); }
    return g;
  }

  update(pal, dt) {
    if (!pal) return;
    const seenPacks = new Set(), seenPallets = new Set();
    const out = pal.do;
    const z = PG.lineZ;

    // konveyör makaraları
    [5, 6, 7, 8].forEach((bit, i) => {
      if (bitOf(out, bit) && pal.safe.ok) for (const r of this.beds[i].userData.rollers) r.rotation.y += dt * 12;
    });

    // besleyici yığını
    const shown = Math.min(this.stack.length, pal.palletMag);
    this.stack.forEach((g, i) => {
      g.visible = i < shown;
      const drop = i === 0 && pal.disp >= 0 ? pal.disp : 0;
      g.position.set(PG.zones[0], PG.rollerTop + 0.17 + i * (PG.palletH + 0.004) - drop * 0.17, z);
    });

    // paletler
    const wrapping = pal.wrap.phase === 'run';
    for (const p of pal.pallets) {
      const g = this.palletMesh(p);
      seenPallets.add(p.id);
      const onTable = Math.abs(p.x - PG.zones[2]) < 0.02;
      g.position.set(p.x, PG.rollerTop, z);
      g.rotation.y = onTable ? pal.wrap.angle : 0;
      const u = g.userData;
      u.sheetB.visible = p.sheetBottom;
      const n = p.slots.filter(Boolean).length;
      const layers = Math.ceil(n / PG.perLayer);
      const top = PG.palletH + PG.sheetH + layers * PACK.h;
      u.sheetT.visible = p.sheetTop;
      u.sheetT.position.y = top + PG.sheetH / 2;
      // paketler: slot konumu B'ye göre tanımlı, palet nerede olursa olsun onunla taşınır
      p.slots.forEach((k, i) => {
        if (!k) return;
        const m = this.packMesh(k);
        const sp = slotPos(i + 1);
        const lx = sp.x - ZB, lz = sp.z - z;
        const c = Math.cos(g.rotation.y), s = Math.sin(g.rotation.y);
        m.position.set(p.x + lx * c + lz * s, sp.y, z - lx * s + lz * c);
        m.rotation.y = g.rotation.y;
        seenPacks.add(k.id);
      });
      // streç film: tur sayısıyla kalınlaşır; sarılırken arabanın çıktığı yüksekliğe kadar
      const turns = p.turns;
      const f = u.film;
      f.visible = turns > 0.05;
      if (f.visible) {
        const hTop = top + (p.sheetTop ? PG.sheetH : 0) + 0.01;
        const reach = wrapping && onTable ? Math.min(1, 0.25 + Math.max(0, pal.wrap.turns - 3) / 2) : 1;
        const hh = Math.max(0.05, (hTop - PG.palletH * 0.5) * reach);
        f.scale.set(0.57, hh, 0.6);
        f.position.y = PG.palletH * 0.5 + hh / 2;
        f.material.opacity = Math.min(0.55, 0.08 + turns * 0.05);
      }
    }
    for (const [id, g] of this.pallets) if (!seenPallets.has(id)) { this.scene.remove(g); this.pallets.delete(id); }

    // döner tabla ve streç arabası
    this.turntable.rotation.y = pal.wrap.phase === 'run' ? pal.wrap.angle : 0;
    const t = pal.wrap.turns;
    const car = !wrapping ? 0 : t < 3 ? 0 : t < 5 ? (t - 3) / 2 : t < 7 ? 1 : Math.max(0, 1 - (t - 7) / 2);
    this.carriage.position.y = PG.palletTop + 0.12 + car * (PG.layers * PACK.h);
    if (wrapping) this.roll.rotation.y += dt * 8;
    this.wrapLamp.material.emissiveIntensity = wrapping ? 2 : pal.wrap.phase === 'fault' ? (Math.sin(performance.now() / 150) > 0 ? 2.5 : 0.1) : 0.05;
    this.wrapLamp.material.emissive.setHex(pal.wrap.phase === 'fault' ? 0xff3030 : 0xffa020);

    // pim, levha magazini
    this.pin.position.y = PG.rollerTop - 0.06 + pal.pin * 0.09;
    const sh = Math.max(0.01, pal.sheets * 0.006);
    const m = PG.sheetMag;
    this.sheetStack.scale.y = sh; this.sheetStack.position.y = m.y - sh / 2;
    this.sheetStand.scale.y = m.y - sh; this.sheetStand.position.y = (m.y - sh) / 2;

    // robot ve tuttuğu parça
    const r = pal.robot;
    this.pose(r.tcp);
    this.vacLamp.material.emissiveIntensity = r.vacuum ? 2.2 : 0.05;
    this.heldSheet.visible = !!r.part?.sheet;
    if (r.part?.sheet) this.heldSheet.position.set(r.tcp.x, r.tcp.y - PG.sheetH / 2, r.tcp.z);
    else if (r.part) {
      const g = this.packMesh(r.part);
      g.position.set(r.tcp.x, r.tcp.y - PACK.h, r.tcp.z);
      g.rotation.y = 0;
      seenPacks.add(r.part.id);
    }
    for (const [id, g] of this.packCache) if (!seenPacks.has(id)) { this.scene.remove(g); this.packCache.delete(id); }

    // güvenlik: kapı, perde, muting, lambalar
    const doorTarget = pal.safe.door ? 0 : 1.6;
    this.door.rotation.y += (doorTarget - this.door.rotation.y) * Math.min(1, dt * 5);
    this.doorLamp.material.emissive.setHex(pal.safe.door ? 0x30ff90 : 0xff3030);
    this.doorLamp.material.emissiveIntensity = 1.6;
    const beamCol = pal.safe.intrude && !pal.safe.muted ? 0xff3030 : pal.safe.muted ? 0xffc030 : 0x30ff90;
    for (const b of this.beams) b.material.color.setHex(beamCol);
    for (const l of this.muteLamps) l.material.emissiveIntensity = pal.safe.muted ? 2.2 : 0.05;
    this.pickLamp.material.emissiveIntensity = bitOf(out, 11) ? 2 : 0.05;
    const alarm = !pal.safe.ok || r.error || pal.wrap.phase === 'fault';
    const running = bitOf(out, 0) && (r.job || bitOf(out, 5) || bitOf(out, 7));
    this.tower[0].material.emissiveIntensity = alarm ? (Math.sin(performance.now() / 200) > 0 ? 2.4 : 0.2) : 0.05;
    this.tower[1].material.emissiveIntensity = !alarm && !running ? 1.8 : 0.05;
    this.tower[2].material.emissiveIntensity = !alarm && running ? 2 : 0.05;
  }
}
