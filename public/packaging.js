// Paketleme hattı: gruplama şeridi ve kapısı, sıra/grup iticileri, karton altlık, sleeve sarma makinesi,
// shrink fırını (camlı yan, ısıtıcı parıltısı, fan), soğutma ve çıkış bandı.
import * as THREE from 'three';
import { M, box, cyl, label, makeCup, applyCup, CUP_H } from './scene.js';
import { bitOf } from './iomap.js';

const TY = 0.9;                  // tabla üstü
const PITCH = 0.082;             // bardak aralığı
const LANE_STOP = 2.24;          // şeritteki ilk bardağın durduğu x
const OUT_END = 2.04;            // çıkış bandının sonu (bardak buradan şeride geçer)
const PLATE_Z = -0.16;           // grup plakası
const PLATE_X = LANE_STOP - PITCH;
const WRAP_X = 2.62;             // sarma makinesi merkezi
const GRP_D = WRAP_X - PLATE_X;  // grup iticisinin itme mesafesi
const BELT_X0 = 2.9;             // fırın bandının başı (s = 0)
const TUNNEL = 1.2, COOL_END = 1.6, EXIT_END = 2.3, PACK_LEN = 0.26;
const ease = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

const padMat = new THREE.MeshStandardMaterial({ color: 0xb08850, roughness: 0.9 });
const filmMat = new THREE.MeshPhysicalMaterial({
  color: 0xffffff, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0, clearcoat: 1, depthWrite: false,
});
const filmLooseMat = filmMat.clone(); filmLooseMat.opacity = 0.32; filmLooseMat.color.setHex(0xeef4ff);
const filmBurntMat = filmMat.clone(); filmBurntMat.opacity = 0.5; filmBurntMat.color.setHex(0x8a6a40);

// 6'lı paket: altlık + 2x3 bardak + film
export function makePack() {
  const g = new THREE.Group();
  const pad = box(PITCH * 3 + 0.02, 0.006, PITCH * 2 + 0.02, padMat, 0, 0.003, 0);
  g.add(pad);
  const cups = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
    const cup = makeCup();
    cup.position.set((c - 1) * PITCH, 0.006, (r - 0.5) * PITCH);
    g.add(cup); cups.push(cup);
  }
  const film = new THREE.Mesh(new THREE.BoxGeometry(PITCH * 3 + 0.02, CUP_H + 0.02, PITCH * 2 + 0.02), filmMat);
  film.position.y = (CUP_H + 0.02) / 2;
  film.renderOrder = 3;
  g.add(film);
  g.userData = { pad, cups, film };
  return g;
}

export function applyPack(g, p) {
  g.userData.pad.visible = p.pad !== false;
  g.userData.cups.forEach((cg, i) => {
    const c = p.cups[i];
    cg.visible = !!c;
    if (c) applyCup(cg, { ...c, burnt: false, damaged: false, overfill: false });
  });
  const f = g.userData.film;
  f.visible = !!p.wrapped;
  // film fırında ısındıkça büzülür: 135 °C altı gevşek, üstü sıkı
  const shrunk = p.filmT >= 135 || p.defect === 'film gevşek' ? (p.defect === 'film gevşek' ? 0 : 1) : Math.max(0, (p.filmT - 60) / 75);
  const k = 1.12 - 0.1 * Math.min(1, shrunk);
  f.scale.set(k, 1.0 + (k - 1) * 0.5, k);
  f.material = p.defect === 'film yandı' ? filmBurntMat : shrunk < 1 ? filmLooseMat : filmMat;
}

export class PackagingArea {
  constructor(scene) {
    this.scene = scene;
    this.cups = new Map();
    this.packs = new Map();
    this.build();
  }

  build() {
    const s = this.scene;
    // gruplama tablası
    s.add(box(0.62, 0.04, 0.6, M.steel, 2.2, TY - 0.02, -0.1));
    s.add(box(0.62, 0.6, 0.5, M.frame, 2.2, 0.55, -0.1));
    // şerit kılavuzları
    for (const z of [-0.048, 0.048]) s.add(box(0.36, 0.04, 0.008, M.steel, 2.16, TY + 0.03, z));
    // giriş kapısı
    this.gate = box(0.012, 0.1, 0.09, M.blue, 2.0, TY + 0.05, 0);
    s.add(this.gate);
    // sıra iticisi (+z tarafında, -z yönüne iter)
    this.rowBody = cyl(0.025, 0.025, 0.16, M.blue, PLATE_X, TY + 0.05, 0.22);
    this.rowBody.rotation.x = Math.PI / 2;
    s.add(this.rowBody);
    this.rowPlate = box(PITCH * 3 + 0.02, 0.07, 0.01, M.steelDark, PLATE_X, TY + 0.05, 0.07);
    s.add(this.rowPlate);
    // grup iticisi (plakanın solunda, +x yönüne iter)
    this.grpBody = cyl(0.025, 0.025, 0.18, M.blue, PLATE_X - 0.36, TY + 0.06, PLATE_Z);
    this.grpBody.rotation.z = Math.PI / 2;
    s.add(this.grpBody);
    this.grpPlate = box(0.01, 0.08, PITCH * 2 + 0.03, M.steelDark, PLATE_X - 0.16, TY + 0.06, PLATE_Z);
    s.add(this.grpPlate);
    // altlık magazini
    s.add(box(0.3, 0.12, 0.2, padMat, PLATE_X, TY + 0.38, PLATE_Z - 0.22));
    s.add(box(0.03, 0.4, 0.03, M.steel, PLATE_X - 0.17, TY + 0.2, PLATE_Z - 0.22));
    this.padFalling = box(PITCH * 3 + 0.02, 0.006, PITCH * 2 + 0.02, padMat, PLATE_X, TY + 0.2, PLATE_Z);
    this.padFalling.visible = false;
    s.add(this.padFalling);
    s.add(label('7 · Gruplama', 2.16, 1.45, -0.1));

    // sleeve sarma makinesi
    s.add(box(0.4, 0.04, 0.42, M.steel, WRAP_X, TY - 0.02, PLATE_Z));
    s.add(box(0.4, 0.6, 0.34, M.frame, WRAP_X, 0.55, PLATE_Z));
    for (const z of [PLATE_Z - 0.2, PLATE_Z + 0.2]) s.add(box(0.05, 0.55, 0.05, M.steel, WRAP_X, TY + 0.275, z));
    s.add(box(0.06, 0.06, 0.45, M.steel, WRAP_X, TY + 0.55, PLATE_Z));
    this.roll = cyl(0.07, 0.07, 0.3, new THREE.MeshStandardMaterial({ color: 0xdfe8ef, roughness: 0.3 }), WRAP_X + 0.12, TY + 0.4, PLATE_Z);
    this.roll.rotation.x = Math.PI / 2;
    s.add(this.roll);
    this.jaw = box(0.02, 0.03, 0.36, new THREE.MeshStandardMaterial({ color: 0x55585c, emissive: 0x000000 }), WRAP_X + 0.17, TY + 0.25, PLATE_Z);
    s.add(this.jaw);
    s.add(label('8 · Sleeve sarma', WRAP_X, 1.65, PLATE_Z));

    // fırın bandı ve gövde
    const beltLen = EXIT_END + 0.15;
    const bx = BELT_X0 - 0.05 + beltLen / 2;
    s.add(box(beltLen, 0.04, 0.34, M.steel, bx, TY - 0.02, PLATE_Z));
    s.add(box(beltLen, 0.6, 0.3, M.frame, bx, 0.55, PLATE_Z));
    s.add(box(beltLen - 0.04, 0.01, 0.3, new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.8 }), bx, TY + 0.005, PLATE_Z));
    const tx = BELT_X0 + TUNNEL / 2;
    const shell = new THREE.MeshStandardMaterial({ color: 0x9aa4ad, metalness: 0.7, roughness: 0.35 });
    s.add(box(TUNNEL, 0.04, 0.42, shell, tx, TY + 0.36, PLATE_Z));                // tavan
    s.add(box(TUNNEL, 0.36, 0.02, shell, tx, TY + 0.18, PLATE_Z - 0.2));          // arka duvar
    // ön cam (içi görünsün) ve çerçeve
    const glass = new THREE.Mesh(new THREE.BoxGeometry(TUNNEL - 0.06, 0.28, 0.01),
      new THREE.MeshPhysicalMaterial({ color: 0xffd9b0, transparent: true, opacity: 0.2, roughness: 0.05, depthWrite: false }));
    glass.position.set(tx, TY + 0.2, PLATE_Z + 0.2);
    s.add(glass);
    s.add(box(TUNNEL, 0.03, 0.03, shell, tx, TY + 0.05, PLATE_Z + 0.2));
    s.add(box(TUNNEL, 0.03, 0.03, shell, tx, TY + 0.34, PLATE_Z + 0.2));
    // giriş/çıkış perdeleri
    for (const x of [BELT_X0, BELT_X0 + TUNNEL]) s.add(box(0.01, 0.18, 0.32, new THREE.MeshStandardMaterial({ color: 0x222222, transparent: true, opacity: 0.55 }), x, TY + 0.25, PLATE_Z));
    // ısıtıcı parıltısı (iç tavanda)
    this.heatMat = new THREE.MeshStandardMaterial({ color: 0x402010, emissive: 0x000000 });
    s.add(box(TUNNEL - 0.1, 0.01, 0.3, this.heatMat, tx, TY + 0.335, PLATE_Z));
    this.heatLight = new THREE.PointLight(0xff7020, 0, 1.2);
    this.heatLight.position.set(tx, TY + 0.25, PLATE_Z);
    s.add(this.heatLight);
    // fan
    s.add(cyl(0.09, 0.09, 0.06, M.steelDark, tx, TY + 0.41, PLATE_Z));
    this.fan = box(0.16, 0.005, 0.025, new THREE.MeshStandardMaterial({ color: 0xdddddd }), tx, TY + 0.445, PLATE_Z);
    s.add(this.fan);
    // sıcaklık göstergesi
    this.tCanvas = document.createElement('canvas'); this.tCanvas.width = 256; this.tCanvas.height = 96;
    this.tTex = new THREE.CanvasTexture(this.tCanvas); this.tTex.colorSpace = THREE.SRGBColorSpace;
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.075), new THREE.MeshBasicMaterial({ map: this.tTex }));
    disp.position.set(BELT_X0 + 0.15, TY + 0.47, PLATE_Z + 0.215);
    s.add(box(0.22, 0.09, 0.02, M.frame, BELT_X0 + 0.15, TY + 0.47, PLATE_Z + 0.2), disp);
    s.add(label('9 · Shrink fırını', tx, 1.62, PLATE_Z));
    // soğutma fanları
    for (const x of [BELT_X0 + TUNNEL + 0.12, BELT_X0 + TUNNEL + 0.3]) {
      s.add(cyl(0.06, 0.06, 0.03, M.steelDark, x, TY + 0.36, PLATE_Z));
    }
    s.add(label('Soğutma', BELT_X0 + (TUNNEL + COOL_END) / 2, 1.35, PLATE_Z));
    // Çıkış ayırıcı + yandan alınan ürünler için ayrı karantina kasası.
    const rx = BELT_X0 + TUNNEL;
    this.diverter = box(0.025, 0.12, 0.3, M.blue, rx, TY + 0.06, PLATE_Z);
    s.add(this.diverter);
    const binMat = new THREE.MeshStandardMaterial({ color: 0xc05b22, roughness: 0.8 });
    s.add(box(0.72, 0.04, 0.62, binMat, rx, 0.5, PLATE_Z + 0.64));
    for (const z of [PLATE_Z + 0.33, PLATE_Z + 0.95]) s.add(box(0.72, 0.3, 0.025, binMat, rx, 0.65, z));
    for (const x of [rx - 0.36, rx + 0.36]) s.add(box(0.025, 0.3, 0.62, binMat, x, 0.65, PLATE_Z + 0.64));
    s.add(label('KARANTİNA · RED', rx, 1.1, PLATE_Z + 0.7));
    // çıkış bandı sonu ve durdurucu
    s.add(box(0.02, 0.06, 0.3, M.steelDark, BELT_X0 + EXIT_END + 0.02, TY + 0.03, PLATE_Z));
    this.exitEye = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0x000000 });
    s.add(new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), this.exitEye)
      .translateX(BELT_X0 + COOL_END + 0.05).translateY(TY + 0.07).translateZ(PLATE_Z + 0.17));
    s.add(label('Çıkış · robot alma noktası', BELT_X0 + (COOL_END + EXIT_END) / 2, 1.2, PLATE_Z));
  }

  cupMesh(c) {
    let g = this.cups.get(c.id);
    if (!g) { g = makeCup(); this.scene.add(g); this.cups.set(c.id, g); }
    applyCup(g, { ...c, burnt: false, damaged: false, overfill: false });
    return g;
  }

  packMesh(p) {
    let g = this.packs.get(p.id);
    if (!g) { g = makePack(); this.scene.add(g); this.packs.set(p.id, g); }
    applyPack(g, p);
    return g;
  }

  update(sh, dt) {
    const seenCups = new Set(), seenPacks = new Set();
    const y0 = TY + 0.006;

    // kapı ve iticiler
    this.gate.position.y = TY + 0.05 + (1 - sh.gate) * 0.1;
    this.rowPlate.position.z = 0.07 - sh.rowP * 0.14;
    this.grpPlate.position.x = PLATE_X - 0.16 + sh.grpP * GRP_D;

    // şeritteki bardaklar: çıkış bandının sonundan durağa
    sh.lane.forEach((c, i) => {
      const g = this.cupMesh(c);
      const target = LANE_STOP - i * PITCH;
      const k = ease(c.enter);
      g.position.set(lerp(OUT_END, target, k), y0, -sh.rowP * 0.14 * (c.enter >= 1 ? 1 : 0));
      seenCups.add(c.id);
    });
    // plakadaki sıralar (eski sıra daha arkada)
    const n = sh.plate.rows.length;
    sh.plate.rows.forEach((row, r) => {
      const z = PLATE_Z + 0.04 - (n - 1 - r) * PITCH;
      row.forEach((c, i) => {
        const g = this.cupMesh(c);
        g.position.set(LANE_STOP - i * PITCH + sh.grpP * GRP_D, y0 + (sh.plate.pad ? 0.006 : 0), z);
        seenCups.add(c.id);
      });
    });
    // altlık: düşüyor ya da plakada
    this.padFalling.visible = sh.plate.padT >= 0 || sh.plate.pad;
    this.padFalling.position.y = sh.plate.padT >= 0 ? lerp(TY + 0.3, TY + 0.003, ease(sh.plate.padT)) : TY + 0.003;
    this.padFalling.position.x = PLATE_X + (sh.plate.pad ? sh.grpP * GRP_D : 0);

    // sarma makinesindeki paket
    if (sh.wrapper.pack) {
      const g = this.packMesh(sh.wrapper.pack);
      g.position.set(WRAP_X, TY, PLATE_Z);
      seenPacks.add(sh.wrapper.pack.id);
    }
    const busy = sh.wrapper.busy > 0;
    this.jaw.position.y = TY + 0.25 - (busy ? Math.sin(sh.wrapper.busy * Math.PI) * 0.12 : 0);
    this.jaw.material.emissive.setHex(busy ? 0xaa3300 : sh.wrapper.fault ? 0x880000 : 0x000000);
    if (busy) this.roll.rotation.y += dt * 4;

    // fırın bandındaki paketler
    for (const b of sh.belt) {
      const g = this.packMesh(b);
      g.position.set(BELT_X0 + b.s - PACK_LEN / 2, TY + 0.01, PLATE_Z);
      seenPacks.add(b.id);
    }
    this.diverter.position.y = TY + 0.06 + Math.abs(sh.diverter ?? 0) * 0.18;
    this.diverter.rotation.y = (sh.diverter ?? 0) < 0 ? -Math.PI / 4 : 0;
    (sh.rejected ?? []).slice(-6).forEach((p, i) => {
      const g = this.packMesh(p);
      g.position.set(BELT_X0 + TUNNEL - 0.18 + (i % 2) * 0.3,
        0.53 + Math.floor(i / 4) * 0.12, PLATE_Z + 0.49 + (Math.floor(i / 2) % 2) * 0.25);
      seenPacks.add(p.id);
    });
    for (const [id, g] of this.cups) if (!seenCups.has(id)) { this.scene.remove(g); this.cups.delete(id); }
    for (const [id, g] of this.packs) if (!seenPacks.has(id)) { this.scene.remove(g); this.packs.delete(id); }

    // fırın: ısıtıcı ve fan
    const heat = Math.max(0, Math.min(1, (sh.temp - 40) / 150));
    this.heatMat.emissive.setRGB(heat, heat * 0.35, heat * 0.05);
    this.heatLight.intensity = bitOf(sh.do, 7) ? 0.8 * heat : 0.3 * heat;
    if (bitOf(sh.di, 12)) this.fan.rotation.y += dt * 30;
    this.exitEye.emissive.setHex(bitOf(sh.di, 15) ? 0xff5500 : 0x00aa44);

    this.tT = (this.tT || 0) + dt;
    if (this.tT > 0.25) {
      this.tT = 0;
      const g = this.tCanvas.getContext('2d');
      g.fillStyle = '#0b1210'; g.fillRect(0, 0, 256, 96);
      g.fillStyle = sh.otTripped ? '#ff4d4f' : sh.temp > 140 ? '#ff9f40' : '#5aa9ff';
      g.font = 'bold 54px Consolas, monospace'; g.textAlign = 'right';
      g.fillText(`${sh.temp.toFixed(0)} °C`, 240, 68);
      this.tTex.needsUpdate = true;
    }
  }
}
