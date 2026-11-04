// Proses alanı: üretim tankı T1, CIP kostik tankı, transfer pompası, debimetre, iletkenlik
// sensörü ve borular. Borular içinden ne aktığını renkle gösterir: ayran beyaz, su mavi, kostik turuncu.
import * as THREE from 'three';
import { M, box, cyl, label } from './scene.js';
import { bitOf } from './iomap.js';

const COLORS = { p: new THREE.Color(0xf6f3ea), w: new THREE.Color(0x5aa9ff), c: new THREE.Color(0xff8a1f) };
const R = 0.016;   // boru yarıçapı

// Sabit yerleşim (m). Dolum tankı makinenin arkasında (-0.33, 1.7, -0.34).
const P = {
  t1: new THREE.Vector3(-1.5, 0, -1.85),
  cip: new THREE.Vector3(-2.55, 0, -1.35),
  pump: new THREE.Vector3(-1.0, 0.14, -1.35),
  riserX: -0.72,
  headY: 2.12,
  fillTop: new THREE.Vector3(-0.33, 1.97, -0.34),
  drain: new THREE.Vector3(-0.5, 0.01, -1.7),
  waterIn: new THREE.Vector3(-3.1, 0.14, -1.35),
};

function mixColor(comp) {
  const c = new THREE.Color(0, 0, 0);
  for (const k of ['p', 'w', 'c']) c.add(COLORS[k].clone().multiplyScalar(comp[k] ?? 0));
  return c;
}

// A'dan B'ye düz boru
function pipe(a, b, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(R, R, len, 12), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  m.castShadow = true;
  return m;
}

export class ProcessArea {
  constructor(scene) {
    this.scene = scene;
    this.groups = {};      // boru grubu → malzeme
    this.valves = {};      // vana adı → gösterge malzemesi
    this.liquidMats = new Map();
    this.build();
  }

  // Dolum tankının gözetleme camı için bileşime göre renk
  liquidMaterial(comp) {
    if (!comp) return M.ayran;
    const key = `${comp.p.toFixed(2)}${comp.w.toFixed(2)}${comp.c.toFixed(3)}`;
    if (!this.liquidMats.has(key)) {
      this.liquidMats.set(key, new THREE.MeshStandardMaterial({ color: mixColor(comp), roughness: 0.45 }));
      if (this.liquidMats.size > 50) this.liquidMats.delete(this.liquidMats.keys().next().value);
    }
    return this.liquidMats.get(key);
  }

  group(name) {
    if (!this.groups[name]) {
      this.groups[name] = new THREE.MeshStandardMaterial({ color: 0xc9d0d6, metalness: 0.85, roughness: 0.3, emissive: 0x000000 });
    }
    return this.groups[name];
  }

  path(name, points) {
    const mat = this.group(name);
    for (let i = 0; i < points.length - 1; i++) this.scene.add(pipe(points[i], points[i + 1], mat));
  }

  valve(name, pos, axis = 'x', big = false) {
    const s = this.scene;
    const body = cyl(big ? 0.04 : 0.028, big ? 0.04 : 0.028, big ? 0.09 : 0.06, M.steelDark, pos.x, pos.y, pos.z);
    if (axis === 'x') body.rotation.z = Math.PI / 2;
    if (axis === 'z') body.rotation.x = Math.PI / 2;
    s.add(body);
    // pnömatik aktüatör ve konum göstergesi
    s.add(cyl(0.022, 0.022, 0.07, M.steel, pos.x, pos.y + 0.075, pos.z));
    const ind = new THREE.MeshStandardMaterial({ color: 0x555b61, emissive: 0x000000 });
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.018, 14, 10), ind);
    dot.position.set(pos.x, pos.y + 0.125, pos.z);
    s.add(dot);
    this.valves[name] = ind;
  }

  vessel({ pos, r, h, y0, mat = M.steel, legs = 0.35, name }) {
    const s = this.scene;
    const g = new THREE.Group();
    g.position.set(pos.x, y0 + h / 2, pos.z);
    g.add(cyl(r, r, h, mat));
    const top = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    top.position.y = h / 2; top.scale.y = 0.3;
    const bottom = new THREE.Mesh(new THREE.ConeGeometry(r, r * 0.5, 32), mat);
    bottom.position.y = -h / 2 - r * 0.25; bottom.rotation.x = Math.PI;
    g.add(top, bottom);
    for (const a of [0.8, 2.4, 4.0, 5.6]) {
      g.add(box(0.03, legs + r * 0.3, 0.03, M.steelDark, Math.cos(a) * r * 0.85, -h / 2 - (legs + r * 0.3) / 2 + 0.02, Math.sin(a) * r * 0.85));
    }
    // seviye camı
    g.add(box(0.035, h * 0.9, 0.01, M.hole, 0, 0, r + 0.002));
    const liq = box(0.03, h * 0.9, 0.012, M.ayran, 0, -h * 0.45, r + 0.004);
    liq.geometry.translate(0, h * 0.45, 0);
    liq.position.y = -h * 0.45;
    g.add(liq);
    s.add(g);
    return { group: g, liquid: liq };
  }

  build() {
    const s = this.scene;

    // ---- T1 üretim tankı ----
    this.t1 = this.vessel({ pos: P.t1, r: 0.32, h: 1.2, y0: 0.42, name: 't1' });
    this.t1.liquid.material = M.ayran;
    this.t1Label = label('T1 Üretim tankı <span class="v"></span>', P.t1.x, 2.05, P.t1.z);
    s.add(this.t1Label);

    // ---- CIP: kostik tankı, ısıtıcı ----
    const causticMat = new THREE.MeshStandardMaterial({ color: 0xb9c0c6, metalness: 0.8, roughness: 0.35 });
    this.cipTank = this.vessel({ pos: P.cip, r: 0.22, h: 0.75, y0: 0.32, mat: causticMat });
    this.cipTank.liquid.material = new THREE.MeshStandardMaterial({ color: COLORS.c, roughness: 0.5 });
    // ısıtıcı bandı
    this.heaterMat = new THREE.MeshStandardMaterial({ color: 0x3a3d40, emissive: 0x000000 });
    const band = cyl(0.225, 0.225, 0.08, this.heaterMat, P.cip.x, 0.45, P.cip.z);
    s.add(band);
    // CIP lambası
    this.cipLamp = new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0x000000, transparent: true, opacity: 0.9 });
    s.add(cyl(0.008, 0.008, 0.25, M.steelDark, P.cip.x + 0.28, 1.2, P.cip.z));
    s.add(cyl(0.035, 0.035, 0.07, this.cipLamp, P.cip.x + 0.28, 1.36, P.cip.z));
    this.cipLabel = label('CIP kostik tankı <span class="v"></span>', P.cip.x, 1.55, P.cip.z);
    s.add(this.cipLabel);
    // skid zemini
    s.add(box(1.0, 0.04, 0.6, M.frame, P.cip.x - 0.1, 0.02, P.cip.z - 0.05));

    // ---- Emiş: kaynaklar → pompa ----
    const y = P.pump.y, zh = P.pump.z;
    this.path('prod', [new THREE.Vector3(P.t1.x, 0.3, P.t1.z), new THREE.Vector3(P.t1.x, y, P.t1.z), new THREE.Vector3(P.t1.x, y, zh)]);
    this.path('caustic', [new THREE.Vector3(P.cip.x, 0.26, P.cip.z), new THREE.Vector3(P.cip.x, y, P.cip.z),
      new THREE.Vector3(P.cip.x, y, zh)]);
    this.path('water', [P.waterIn, new THREE.Vector3(P.cip.x, y, zh)]);
    this.path('suction', [new THREE.Vector3(P.cip.x, y, zh), new THREE.Vector3(P.t1.x, y, zh), new THREE.Vector3(P.pump.x - 0.1, y, zh)]);
    this.valve('prod', new THREE.Vector3(P.t1.x, y, (P.t1.z + zh) / 2), 'z');
    this.valve('caustic', new THREE.Vector3(P.cip.x, y, (P.cip.z + zh) / 2 + 0.02), 'z');
    this.valve('water', new THREE.Vector3((P.waterIn.x + P.cip.x) / 2, y, zh), 'x');
    // şebeke suyu: yerden gelen bağlantı ve flanş
    s.add(pipe(new THREE.Vector3(P.waterIn.x, 0.01, zh), new THREE.Vector3(P.waterIn.x, y, zh), this.group('water')));
    s.add(cyl(0.045, 0.045, 0.03, M.blue, P.waterIn.x, 0.02, zh));
    s.add(label('Şebeke suyu', P.waterIn.x, 0.34, zh));

    // ---- Pompa ----
    const pump = new THREE.Group();
    pump.position.copy(P.pump);
    this.motorMat = M.blue.clone();   // arızada yalnızca bu motor kızarsın
    const motor = cyl(0.07, 0.07, 0.22, this.motorMat, -0.02, 0, 0.0);
    motor.rotation.z = Math.PI / 2;
    const volute = cyl(0.08, 0.08, 0.06, M.steel, 0.12, 0, 0);
    volute.rotation.z = Math.PI / 2;
    pump.add(motor, volute, box(0.32, 0.03, 0.16, M.frame, 0.03, -0.09, 0));
    // dönüş göstergesi (fan kapağı)
    this.fan = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.11, 0.02), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    this.fan.position.set(-0.135, 0, 0);
    pump.add(this.fan);
    s.add(pump);
    this.pumpLabel = label('P1', P.pump.x, 0.42, P.pump.z);
    s.add(this.pumpLabel);

    // ---- Basma: pompa → yükselen boru (debimetre, iletkenlik) → dağıtım kolektörü ----
    // Kolektörün tepesinde üç kol üç ayrı yöne çıkar; her kolun vanası ayrımın hemen yanındadır,
    // böylece ürünün hangi hedefe gittiği tek bakışta görülür (aynı anda yalnızca biri açılır).
    const rx = P.riserX, hy = P.headY;
    const yRet = hy + 0.12, yFill = hy, yDrain = hy - 0.12;
    this.path('line', [new THREE.Vector3(P.pump.x + 0.15, y, zh), new THREE.Vector3(rx, y, zh), new THREE.Vector3(rx, yRet, zh)]);
    for (const yy of [yRet, yFill, yDrain]) {
      const tee = new THREE.Mesh(new THREE.SphereGeometry(R * 1.6, 14, 10), this.group('line'));
      tee.position.set(rx, yy, zh);
      s.add(tee);
    }
    s.add(label('Dağıtım kolektörü', rx - 0.05, yRet + 0.2, zh - 0.05));
    // debimetre (koriolis) ve gösterge
    s.add(box(0.12, 0.2, 0.08, M.steelDark, rx, 0.75, zh));
    this.ftCanvas = document.createElement('canvas');
    this.ftCanvas.width = 256; this.ftCanvas.height = 128;
    this.ftTex = new THREE.CanvasTexture(this.ftCanvas);
    this.ftTex.colorSpace = THREE.SRGBColorSpace;
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.08), new THREE.MeshBasicMaterial({ map: this.ftTex }));
    disp.position.set(rx, 0.98, zh + 0.045);
    s.add(box(0.18, 0.1, 0.03, M.frame, rx, 0.98, zh + 0.025), disp);
    s.add(label('FT1 debi · QT1 iletkenlik', rx, 1.12, zh + 0.05));
    // iletkenlik sensörü
    s.add(cyl(0.025, 0.025, 0.08, M.steel, rx, 1.4, zh + 0.04));

    // dolum kolu: +x yönünde, dolum tankının üstüne
    this.path('fill', [new THREE.Vector3(rx, yFill, zh), new THREE.Vector3(P.fillTop.x, yFill, zh),
      new THREE.Vector3(P.fillTop.x, yFill, P.fillTop.z), new THREE.Vector3(P.fillTop.x, P.fillTop.y, P.fillTop.z)]);
    this.valve('fill', new THREE.Vector3(rx + 0.13, yFill, zh), 'x', true);
    this.leakDrip = cyl(0.004, 0.004, 0.2, new THREE.MeshStandardMaterial({ color: COLORS.p, transparent: true, opacity: 0.85 }),
      rx + 0.13, yFill - 0.15, zh + 0.04);
    this.leakDrip.visible = false;
    s.add(this.leakDrip);
    s.add(label('→ Dolum tankı (çift oturmalı vana)', rx + 0.35, yFill + 0.16, zh));

    // gider kolu: arkaya (-z), sonra aşağı. Boru ızgaranın üstünde biter (hava boşluğu: giderden hatta geri tepme olmaz)
    const dz = zh - 0.32;
    this.path('drain', [new THREE.Vector3(rx, yDrain, zh), new THREE.Vector3(rx, yDrain, dz), new THREE.Vector3(rx, 0.25, dz)]);
    this.valve('drain', new THREE.Vector3(rx, yDrain, zh - 0.13), 'z');
    s.add(box(0.22, 0.01, 0.22, M.hole, rx, 0.006, dz));
    this.drainStream = cyl(0.009, 0.012, 0.24, new THREE.MeshStandardMaterial({ color: COLORS.w, transparent: true, opacity: 0.85 }),
      rx, 0.13, dz);
    this.drainStream.visible = false;
    s.add(this.drainStream);
    s.add(label('↓ Gider', rx + 0.12, 0.3, dz));

    // kostik dönüş kolu: -x yönünde, kostik tankının üstüne
    this.path('cipret', [new THREE.Vector3(rx, yRet, zh), new THREE.Vector3(P.cip.x, yRet, zh),
      new THREE.Vector3(P.cip.x, yRet, P.cip.z), new THREE.Vector3(P.cip.x, 1.2, P.cip.z)]);
    this.valve('cipret', new THREE.Vector3(rx - 0.13, yRet, zh), 'x');
    s.add(label('← CIP dönüşü', rx - 0.45, yRet + 0.16, zh));
  }

  update(t, dt) {
    const flowing = t.flow > 0.05;
    const lineColor = mixColor(t.lineComp);
    const light = (name, active, color) => {
      const m = this.group(name);
      if (active) { m.color.copy(color); m.emissive.copy(color).multiplyScalar(0.35); m.metalness = 0.2; }
      else { m.color.setHex(0xc9d0d6); m.emissive.setHex(0x000000); m.metalness = 0.85; }
    };
    const open = (v) => t.valve[v] > 0.5;
    light('prod', flowing && open('prod'), COLORS.p);
    light('water', flowing && open('water'), COLORS.w);
    const causticColor = mixColor({ p: 0, w: 1 - t.causticStrength, c: t.causticStrength });
    light('caustic', flowing && open('caustic'), causticColor);
    light('suction', flowing, mixColor(t.line[0]));
    light('line', flowing, lineColor);
    for (const d of ['fill', 'drain', 'cipret']) light(d, flowing && open(d), lineColor);

    // vana göstergeleri: yeşil açık, gri kapalı, sarı hareket halinde
    for (const [name, mat] of Object.entries(this.valves)) {
      const v = t.valve[name];
      const hex = v > 0.98 ? 0x2fd17a : v < 0.02 ? 0x555b61 : 0xf5c542;
      mat.color.setHex(hex);
      mat.emissive.setHex(v > 0.02 ? hex : 0x000000).multiplyScalar(0.6);
    }

    // pompa: dönüş ve renk
    if (t.pump) this.fan.rotation.x += dt * 25;
    this.motorMat.emissive.setHex(t.tripped ? 0x661111 : 0x000000);
    this.pumpLabel.element.innerHTML = t.tripped ? 'P1 <span class="v">MOTOR KORUMA</span>' : (t.pump ? 'P1 <span class="v">çalışıyor</span>' : 'P1');

    // tanklar
    this.t1.liquid.scale.y = Math.max(0.01, t.prodLevel / 100);
    this.t1Label.element.querySelector('.v').textContent = `%${t.prodLevel.toFixed(0)}`;
    this.cipTank.liquid.scale.y = Math.max(0.01, t.causticLevel / 100);
    this.cipTank.liquid.material.color.copy(causticColor);
    this.cipLabel.element.querySelector('.v').textContent = `${t.causticT.toFixed(1)} °C`;
    const heat = bitOf(t.do, 7);
    this.heaterMat.emissive.setHex(heat ? 0xff5a10 : 0x000000);
    this.cipLamp.emissive.setHex(bitOf(t.do, 8) ? 0xffa000 : 0x000000);

    // kaçak ve gider akışı
    this.leakDrip.visible = bitOf(t.di, 11);
    this.drainStream.visible = flowing && open('drain');
    this.drainStream.material.color.copy(lineColor);

    // debimetre / iletkenlik göstergesi
    this.ftT = (this.ftT || 0) + dt;
    if (this.ftT > 0.2) {
      this.ftT = 0;
      const g = this.ftCanvas.getContext('2d');
      g.fillStyle = '#0b1210'; g.fillRect(0, 0, 256, 128);
      g.fillStyle = '#2fd17a'; g.font = 'bold 40px Consolas, monospace'; g.textAlign = 'right';
      g.fillText(`${t.flow.toFixed(2)} kg/s`, 240, 52);
      g.fillStyle = t.cond > 30 ? '#ff8a1f' : t.cond > 8.4 && t.cond < 9.6 ? '#f6f3ea' : '#5aa9ff';
      g.fillText(`${t.cond.toFixed(1)} mS`, 240, 108);
      this.ftTex.needsUpdate = true;
    }
  }
}
