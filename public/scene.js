// Makinenin 3B modeli. Simülatörden gelen durum anlık görüntüsünü sahneye uygular.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { SPEC, bitOf } from './iomap.js';
import { ProcessArea } from './process.js';
import { PackagingArea } from './packaging.js';
import { PalletArea } from './palletizer.js';
import { LogisticsArea } from './logistics.js';

const PITCH = 0.22;
const TABLE_Y = 0.9;              // tabla üst yüzü
const PLATE_Y = TABLE_Y + 0.03;   // zincir plakalarının üst yüzü
const CUP_BASE = PLATE_Y - 0.045; // bardak cebe gömülü durur
const CUP_H = 0.095;
const ST = SPEC.station;
const OUT_X0 = 1.14;                                   // çıkış bandının başı
const OUT_LEN = (SPEC.outfeedCapacity - 1) * 0.082;   // server/cells/outfeed.js ile aynı
const stationX = (i) => (i - (SPEC.pockets - 1) / 2) * PITCH;
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);

// ---- Malzemeler ---------------------------------------------------------
const M = {
  steel: new THREE.MeshStandardMaterial({ color: 0xc9d0d6, metalness: 0.85, roughness: 0.28 }),
  steelDark: new THREE.MeshStandardMaterial({ color: 0x8a939c, metalness: 0.8, roughness: 0.4 }),
  plate: new THREE.MeshStandardMaterial({ color: 0xb8c0c7, metalness: 0.75, roughness: 0.35 }),
  hole: new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.9 }),
  frame: new THREE.MeshStandardMaterial({ color: 0x2f3a45, metalness: 0.3, roughness: 0.6 }),
  blue: new THREE.MeshStandardMaterial({ color: 0x1f5fa8, metalness: 0.2, roughness: 0.5 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.9 }),
  cup: new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.18, metalness: 0, transparent: true, opacity: 0.38,
    side: THREE.DoubleSide, depthWrite: false, clearcoat: 0.6,
  }),
  ayran: new THREE.MeshStandardMaterial({ color: 0xf6f3ea, roughness: 0.45 }),
  stream: new THREE.MeshStandardMaterial({ color: 0xf6f3ea, roughness: 0.3, transparent: true, opacity: 0.9 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0xdfefff, transparent: true, opacity: 0.18, roughness: 0.05, depthWrite: false }),
  floor: new THREE.MeshStandardMaterial({ color: 0xcfd4d9, roughness: 0.85 }),
  heater: new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.6, roughness: 0.4, emissive: 0x000000 }),
};

function foilTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 110, 10, 128, 128, 128);
  grd.addColorStop(0, '#f4f7fa'); grd.addColorStop(1, '#aeb8c2');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#1f5fa8'; g.lineWidth = 16; g.beginPath(); g.arc(128, 128, 104, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#1f5fa8'; g.font = 'bold 54px Segoe UI, sans-serif'; g.textAlign = 'center';
  g.fillText('AYRAN', 128, 140);
  g.font = '600 24px Segoe UI, sans-serif'; g.fillText('200 ml', 128, 178);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const FOIL_TEX = foilTexture();
M.foil = new THREE.MeshStandardMaterial({ map: FOIL_TEX, metalness: 0.7, roughness: 0.3, side: THREE.DoubleSide });
M.foilBurnt = new THREE.MeshStandardMaterial({ map: FOIL_TEX, color: 0x8a5a2b, metalness: 0.5, roughness: 0.6, side: THREE.DoubleSide });
M.foilPlain = new THREE.MeshStandardMaterial({ color: 0xd8dee4, metalness: 0.8, roughness: 0.3, side: THREE.DoubleSide });

// ---- Geometriler --------------------------------------------------------
const cupProfile = [
  new THREE.Vector2(0.0, 0), new THREE.Vector2(0.026, 0), new THREE.Vector2(0.036, CUP_H),
  new THREE.Vector2(0.041, CUP_H), new THREE.Vector2(0.041, CUP_H + 0.003),
];
const G = {
  cup: new THREE.LatheGeometry(cupProfile, 40),
  liquid: new THREE.CylinderGeometry(0.0345, 0.0252, 1, 32).translate(0, 0.5, 0),
  foil: new THREE.CircleGeometry(0.042, 40).rotateX(-Math.PI / 2),
  stream: new THREE.CylinderGeometry(0.0045, 0.006, 1, 12).translate(0, -0.5, 0),
};

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 32) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
}

function makeCup() {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(G.cup, M.cup);
  shell.renderOrder = 2;
  const liquid = new THREE.Mesh(G.liquid, M.ayran);
  liquid.position.y = 0.002;
  liquid.castShadow = true;
  const foil = new THREE.Mesh(G.foil, M.foil);
  foil.position.y = CUP_H + 0.004;
  foil.castShadow = true;
  g.add(shell, liquid, foil);
  g.userData = { liquid, foil };
  return g;
}

function applyCup(g, c) {
  const h = Math.min(1, c.product / 245) * (CUP_H - 0.004);
  g.userData.liquid.visible = h > 0.001;
  g.userData.liquid.scale.y = Math.max(h, 0.0001);
  const r = 0.0252 + (0.0345 - 0.0252) * (h / CUP_H);   // koni şeklindeki bardakta üst yarıçap
  g.userData.liquid.scale.x = g.userData.liquid.scale.z = lerp(0.98, 1, r / 0.0345);
  const f = g.userData.foil;
  f.visible = !!c.foil;
  f.material = c.burnt ? M.foilBurnt : M.foil;
  f.rotation.z = c.sealed ? 0 : 0.06;                    // kapanmamış folyo hafif kalkık durur
  f.position.y = CUP_H + (c.sealed ? 0.0035 : 0.007);
}

function label(text, x, y, z) {
  const el = document.createElement('div');
  el.className = 'label3d';
  el.innerHTML = text;
  const o = new CSS2DObject(el);
  o.position.set(x, y, z);
  return o;
}

export class MachineScene {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.style.position = 'absolute';
    this.labels.domElement.style.top = '0';
    this.labels.domElement.style.pointerEvents = 'none';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a2129);
    this.scene.fog = new THREE.Fog(0x1a2129, 13, 32);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 18;
    this.views = {
      overview: [new THREE.Vector3(1.1, 2.9, 3.4), new THREE.Vector3(-0.55, 0.95, -0.6)],
      fill: [new THREE.Vector3(-0.05, 1.35, 0.85), new THREE.Vector3(-0.3, 1.05, 0)],
      seal: [new THREE.Vector3(0.25, 1.4, 0.8), new THREE.Vector3(0.0, 1.02, 0)],
      reject: [new THREE.Vector3(1.35, 1.6, 1.25), new THREE.Vector3(0.75, 0.98, -0.1)],
      process: [new THREE.Vector3(-3.7, 2.1, 0.9), new THREE.Vector3(-1.45, 0.85, -1.35)],
      pack: [new THREE.Vector3(2.0, 2.15, 1.25), new THREE.Vector3(3.05, 0.9, -0.2)],
      palet: [new THREE.Vector3(5.6, 3.4, 2.3), new THREE.Vector3(6.3, 0.55, -1.35)],
      depo: [new THREE.Vector3(10.2, 5.6, -11.2), new THREE.Vector3(6.6, 0.7, -4.2)],
      factory: [new THREE.Vector3(6.2, 11.5, 10.5), new THREE.Vector3(5.8, 0.3, -2.4)],
    };
    this.camTween = null;
    this.camera.position.copy(this.views.overview[0]);
    this.controls.target.copy(this.views.overview[1]);

    this.cups = new Map();   // id → mesh grubu
    this.doneAnim = new Map(); // id → {t0, from}
    this.build();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setView(name) {
    const v = this.views[name];
    if (!v) return;
    this.camTween = {
      t: 0, p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: v[0], t1: v[1],
    };
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  build() {
    const s = this.scene;

    // Işıklar
    s.add(new THREE.HemisphereLight(0xdfe9f5, 0x2a2f36, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    // gölge kutusu bütün fabrikayı (tanklardan paletleme hücresine) kapsar
    sun.position.set(7.5, 6.0, 1.5);
    sun.target.position.set(5.0, 0, -2.2);
    s.add(sun.target);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 6, bottom: -6, near: 0.5, far: 20 });
    sun.shadow.bias = -0.0004;
    s.add(sun);

    // Zemin
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), M.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    s.add(floor);
    const grid = new THREE.GridHelper(30, 60, 0x9aa3ac, 0xb5bcc3);
    grid.position.y = 0.001;
    grid.material.opacity = 0.35; grid.material.transparent = true;
    s.add(grid);
    // sarı güvenlik şeridi
    const stripe = new THREE.Mesh(new THREE.RingGeometry(1, 1.06, 4, 1), new THREE.MeshBasicMaterial({ color: 0xe8b923 }));
    stripe.rotation.x = -Math.PI / 2; stripe.rotation.z = Math.PI / 4;
    stripe.scale.set(2.25, 1.15, 1); stripe.position.set(0.15, 0.002, 0);
    s.add(stripe);

    // Gövde ve tabla
    const L = 2.2;
    s.add(box(L, 0.06, 0.42, M.steel, 0, TABLE_Y - 0.03, 0));
    s.add(box(L, 0.62, 0.36, M.frame, 0, 0.5, 0));
    for (const x of [-L / 2 + 0.06, L / 2 - 0.06]) for (const z of [-0.16, 0.16]) {
      s.add(box(0.05, 0.2, 0.05, M.steelDark, x, 0.1, z));
      s.add(cyl(0.035, 0.035, 0.015, M.rubber, x, 0.008, z));
    }
    // yan kızaklar
    for (const z of [-0.155, 0.155]) s.add(box(L, 0.05, 0.012, M.steel, 0, PLATE_Y + 0.005, z));
    // ön kapak etiketi
    const plateTex = (() => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 64;
      const g = c.getContext('2d');
      g.fillStyle = '#2f3a45'; g.fillRect(0, 0, 512, 64);
      g.fillStyle = '#e8eef4'; g.font = 'bold 30px Segoe UI, sans-serif'; g.fillText('AD-8 DOLUM · KAPAMA', 20, 43);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const nameplate = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.075), new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.5 }));
    nameplate.position.set(-0.6, 0.62, 0.181);
    s.add(nameplate);

    // Zincir plakaları (cepler)
    this.plates = [];
    const holeGeo = new THREE.CircleGeometry(0.031, 32).rotateX(-Math.PI / 2);
    for (let k = 0; k < 14; k++) {
      const g = new THREE.Group();
      const p = box(PITCH - 0.006, 0.014, 0.3, M.plate);
      const hole = new THREE.Mesh(holeGeo, M.hole);
      hole.position.y = 0.0075;
      g.add(p, hole);
      s.add(g);
      this.plates.push(g);
    }

    this.buildFeeder();
    this.buildFiller();
    this.buildFoiler();
    this.buildSealer();
    this.buildChecker();
    this.buildReject();
    this.buildOutfeed();
    this.buildTower();
    this.process = new ProcessArea(this.scene);
    this.packaging = new PackagingArea(this.scene);
    this.palletArea = new PalletArea(this.scene);
    this.logistics = new LogisticsArea(this.scene);

    // Çıkış istasyonu sonrası kayan bardaklar için
    const names = [
      [ST.drop, '1 · Bardak besleme'], [ST.fill, '2 · Dolum'], [ST.foil, '3 · Folyo'],
      [ST.seal, '4 · Isıl kapama'], [ST.check, '5 · Kontrol tartısı'], [ST.reject, '6 · Red'],
    ];
    for (const [i, n] of names) s.add(label(n, stationX(i), 1.78, 0));
    s.add(label('Çıkış bandı', OUT_X0 + OUT_LEN / 2, 1.12, 0));
    this.tankLabel = label('Ürün tankı <span class="v"></span>', stationX(ST.fill), 2.12, -0.32);
    s.add(this.tankLabel);
  }

  buildFeeder() {
    const s = this.scene, x = stationX(ST.drop);
    // magazin tüpü
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.5, 32, 1, true), M.glass);
    tube.position.set(x, 1.32, 0);
    s.add(tube);
    for (const z of [-0.07, 0.07]) s.add(box(0.025, 0.85, 0.025, M.steel, x, 1.32, z));
    s.add(box(0.025, 0.025, 0.17, M.steel, x, 1.74, 0));
    // ayırıcı halka ve pistonlar
    s.add(cyl(0.06, 0.06, 0.03, M.steelDark, x, 1.07, 0));
    for (const z of [-0.085, 0.085]) {
      const p = cyl(0.012, 0.012, 0.07, M.blue, x, 1.07, z);
      p.rotation.x = Math.PI / 2;
      s.add(p);
    }
    // magazindeki iç içe bardaklar
    this.stack = [];
    for (let i = 0; i < 30; i++) {
      const c = makeCup();
      c.userData.foil.visible = false;
      c.userData.liquid.visible = false;
      c.position.set(x, 1.085 + i * 0.012, 0);
      s.add(c);
      this.stack.push(c);
    }
  }

  buildFiller() {
    const s = this.scene, x = stationX(ST.fill);
    // portal
    for (const z of [-0.2, 0.2]) s.add(box(0.04, 0.75, 0.04, M.steel, x, TABLE_Y + 0.375, z));
    s.add(box(0.06, 0.05, 0.46, M.steel, x, TABLE_Y + 0.75, 0));
    // ürün tankı
    const tz = -0.34;
    const tank = new THREE.Group();
    tank.position.set(x, 1.7, tz);
    const shell = cyl(0.17, 0.17, 0.42, M.steel);
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.17, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.steel);
    top.position.y = 0.21; top.scale.y = 0.35;
    const bottom = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.12, 32), M.steel);
    bottom.position.y = -0.27; bottom.rotation.x = Math.PI;
    tank.add(shell, top, bottom);
    for (const a of [0.6, 2.2, 3.8, 5.4]) {
      const leg = box(0.025, 0.95, 0.025, M.steelDark, Math.cos(a) * 0.15, -0.48, Math.sin(a) * 0.15);
      tank.add(leg);
    }
    // gözetleme camı + seviye
    const sightBack = box(0.03, 0.36, 0.01, M.hole, 0, 0, 0.172);
    const sightLiquid = box(0.026, 0.36, 0.012, M.ayran, 0, -0.18, 0.174);
    sightLiquid.geometry.translate(0, 0.18, 0);
    sightLiquid.position.y = -0.18;
    tank.add(sightBack, sightLiquid);
    this.sightLiquid = sightLiquid;
    s.add(tank);
    // tanktan dolum ağzına boru
    const pipe1 = cyl(0.012, 0.012, 0.32, M.steel, x, 1.33, tz);
    s.add(pipe1);
    const pipe2 = cyl(0.012, 0.012, 0.34, M.steel, x, 1.18, tz / 2);
    pipe2.rotation.x = Math.PI / 2;
    s.add(pipe2);
    // hareketli dolum ağzı grubu
    const noz = new THREE.Group();
    noz.add(box(0.12, 0.05, 0.1, M.steelDark, 0, 0.12, 0));       // taşıyıcı
    noz.add(cyl(0.022, 0.022, 0.1, M.steel, 0, 0.05, 0));           // gövde
    noz.add(cyl(0.022, 0.009, 0.03, M.steel, 0, -0.015, 0));        // uç
    const hose = cyl(0.008, 0.008, 0.12, M.rubber, 0, 0.16, -0.06);
    hose.rotation.x = 0.6;
    noz.add(hose);
    s.add(noz);
    this.nozzle = noz;
    this.nozzleX = x;
    // pnömatik silindir
    s.add(cyl(0.02, 0.02, 0.16, M.blue, x, TABLE_Y + 0.66, 0));
    this.nozzleRod = cyl(0.007, 0.007, 0.2, M.steel, x, 0, 0);
    s.add(this.nozzleRod);
    // akış
    this.stream = new THREE.Mesh(G.stream, M.stream);
    this.stream.visible = false;
    s.add(this.stream);
    // dökülen ayran birikintisi
    this.puddle = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), M.ayran);
    this.puddle.position.set(x + 0.05, 0.003, 0.32);
    this.puddle.visible = false;
    s.add(this.puddle);
  }

  buildFoiler() {
    const s = this.scene, x = stationX(ST.foil);
    const mz = -0.33;   // magazin hattın arkasında, önden görüşü kapatmasın
    s.add(box(0.1, 0.14, 0.1, M.frame, x + 0.01, TABLE_Y + 0.07, mz));
    s.add(box(0.04, 0.38, 0.04, M.steel, x + 0.07, TABLE_Y + 0.19, -0.22));
    s.add(box(0.03, 0.03, 0.4, M.steel, x + 0.07, TABLE_Y + 0.37, -0.12));
    // folyo yığını
    this.foilStack = [];
    for (let i = 0; i < 40; i++) {
      const f = new THREE.Mesh(G.foil, M.foilPlain);
      f.position.set(x, TABLE_Y + 0.142 + i * 0.0012, mz);
      s.add(f);
      this.foilStack.push(f);
    }
    // vakumlu kol
    const arm = new THREE.Group();
    arm.add(box(0.03, 0.025, 0.12, M.steelDark, 0, 0.03, 0.05));
    arm.add(cyl(0.008, 0.008, 0.08, M.steel, 0, 0.0, 0));
    arm.add(cyl(0.03, 0.03, 0.01, M.rubber, 0, -0.04, 0));
    const carried = new THREE.Mesh(G.foil, M.foil);
    carried.position.y = -0.046;
    arm.add(carried);
    this.foilCarried = carried;
    s.add(arm);
    this.foilArmObj = arm;
    this.foilX = x; this.foilMz = mz;
  }

  buildSealer() {
    const s = this.scene, x = stationX(ST.seal);
    for (const z of [-0.2, 0.2]) s.add(box(0.05, 0.75, 0.05, M.steel, x, TABLE_Y + 0.375, z));
    s.add(box(0.08, 0.08, 0.46, M.steel, x, TABLE_Y + 0.75, 0));
    s.add(cyl(0.04, 0.04, 0.2, M.blue, x, TABLE_Y + 0.6, 0));
    const head = new THREE.Group();
    head.add(box(0.14, 0.08, 0.14, M.steelDark, 0, 0.06, 0));
    const plate = cyl(0.05, 0.05, 0.03, M.heater, 0, 0.005, 0);
    head.add(plate);
    for (const dx of [-0.05, 0.05]) head.add(box(0.012, 0.03, 0.012, M.rubber, dx, 0.11, 0.05));
    s.add(head);
    this.sealHead = head;
    this.sealRod = cyl(0.012, 0.012, 0.3, M.steel, x, 0, 0);
    s.add(this.sealRod);
    this.sealX = x;
  }

  buildChecker() {
    const s = this.scene, x = stationX(ST.check);
    s.add(box(0.13, 0.02, 0.13, M.steelDark, x, TABLE_Y + 0.01, 0.24));
    s.add(box(0.03, 0.42, 0.03, M.steel, x, TABLE_Y + 0.21, 0.24));
    const c = document.createElement('canvas'); c.width = 256; c.height = 96;
    this.checkCanvas = c;
    this.checkTex = new THREE.CanvasTexture(c);
    this.checkTex.colorSpace = THREE.SRGBColorSpace;
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.06), new THREE.MeshBasicMaterial({ map: this.checkTex }));
    const housing = box(0.18, 0.08, 0.03, M.frame, x, TABLE_Y + 0.44, 0.24);
    disp.position.set(x, TABLE_Y + 0.44, 0.256);
    s.add(housing, disp);
    this.drawCheck('---');
  }

  drawCheck(text, color = '#2fd17a') {
    const g = this.checkCanvas.getContext('2d');
    g.fillStyle = '#0b1210'; g.fillRect(0, 0, 256, 96);
    g.fillStyle = color; g.font = 'bold 54px Consolas, monospace'; g.textAlign = 'right';
    g.fillText(text, 236, 68);
    this.checkTex.needsUpdate = true;
  }

  buildReject() {
    const s = this.scene, x = stationX(ST.reject);
    // piston gövdesi
    const body = cyl(0.025, 0.025, 0.2, M.blue, x, PLATE_Y + 0.05, 0.36);
    body.rotation.x = Math.PI / 2;
    s.add(body);
    s.add(box(0.06, 0.12, 0.04, M.steelDark, x, TABLE_Y + 0.0, 0.46));
    const rod = cyl(0.008, 0.008, 0.25, M.steel, x, PLATE_Y + 0.05, 0);
    rod.rotation.x = Math.PI / 2;
    s.add(rod);
    const pusher = box(0.11, 0.07, 0.012, M.steelDark, x, PLATE_Y + 0.05, 0);
    s.add(pusher);
    this.rejRod = rod; this.rejPusher = pusher; this.rejX = x;
    // red kutusu
    const bin = new THREE.Group();
    bin.position.set(x, 0, -0.5);
    const binMat = new THREE.MeshStandardMaterial({ color: 0xd8342e, roughness: 0.6 });
    bin.add(box(0.36, 0.02, 0.3, binMat, 0, 0.52, 0));
    bin.add(box(0.36, 0.3, 0.02, binMat, 0, 0.67, -0.15));
    bin.add(box(0.36, 0.3, 0.02, binMat, 0, 0.67, 0.15));
    bin.add(box(0.02, 0.3, 0.3, binMat, -0.18, 0.67, 0));
    bin.add(box(0.02, 0.3, 0.3, binMat, 0.18, 0.67, 0));
    for (const dx of [-0.15, 0.15]) for (const dz of [-0.12, 0.12]) bin.add(box(0.025, 0.52, 0.025, M.steelDark, dx, 0.26, dz));
    s.add(bin);
    // kutuya kaydırma oluğu
    const chute = box(0.14, 0.01, 0.26, M.steel, x, TABLE_Y - 0.07, -0.3);
    chute.rotation.x = -0.45;
    s.add(chute);
    s.add(label('RED', x, 0.9, -0.5));
  }

  buildOutfeed() {
    const s = this.scene;
    // biriktirme bandı: bardaklar tek sıra birikir, sonunda bir sonraki istasyon alır
    const len = OUT_LEN + 0.12, cx = OUT_X0 - 0.04 + len / 2;
    s.add(box(len, 0.04, 0.2, M.steel, cx, TABLE_Y - 0.02, 0));
    s.add(box(len, 0.6, 0.16, M.frame, cx, 0.55, 0));
    s.add(box(len - 0.04, 0.01, 0.12, M.rubber, cx, TABLE_Y + 0.005, 0));
    for (const z of [-0.055, 0.055]) s.add(box(len, 0.05, 0.008, M.steel, cx, TABLE_Y + 0.04, z));
    // giriş fotoseli
    this.outEye = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0x000000 });
    s.add(box(0.02, 0.04, 0.02, M.steelDark, OUT_X0 + 0.02, TABLE_Y + 0.06, 0.075));
    s.add(new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), this.outEye)
      .translateX(OUT_X0 + 0.02).translateY(TABLE_Y + 0.06).translateZ(0.062));
  }

  buildTower() {
    const s = this.scene;
    const x = -1.05, z = -0.17, y0 = TABLE_Y;
    s.add(cyl(0.012, 0.012, 0.5, M.steelDark, x, y0 + 0.25, z));
    const mk = (color, y) => {
      const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.05, transparent: true, opacity: 0.92 });
      const c = cyl(0.03, 0.03, 0.06, m, x, y, z);
      s.add(c);
      return m;
    };
    this.lamps = { green: mk(0x2fd17a, y0 + 0.53), yellow: mk(0xf5c542, y0 + 0.595), red: mk(0xff4d4f, y0 + 0.66) };
    s.add(cyl(0.03, 0.03, 0.02, M.steelDark, x, y0 + 0.7, z));
    this.lampLight = new THREE.PointLight(0xff0000, 0, 1.5);
    this.lampLight.position.set(x, y0 + 0.6, z + 0.1);
    s.add(this.lampLight);
  }

  // ---- Durum uygulama ---------------------------------------------------
  update(st, dt) {
    if (!st) return;
    if (st.tank) this.process.update(st.tank, dt);
    if (st.shrink) this.packaging.update(st.shrink, dt);
    if (st.pallet) this.palletArea.update(st.pallet, dt);
    if (st.agv) this.logistics.update(st.agv, st.asrs, dt);
    const out = st.do;
    const phase = st.phase;

    // zincir plakaları
    const span = this.plates.length;
    this.plates.forEach((p, k) => {
      let u = ((k + phase) % span + span) % span;           // 0..span
      const x = (u - (SPEC.pockets - 1) / 2 - 3) * PITCH;
      p.position.set(x, PLATE_Y - 0.007, 0);
      p.visible = Math.abs(x) < 1.08;
    });

    // bardaklar
    const seen = new Set();
    const place = (c, x, y, z, rx = 0, rz = 0) => {
      let g = this.cups.get(c.id);
      if (!g) { g = makeCup(); this.scene.add(g); this.cups.set(c.id, g); }
      applyCup(g, c);
      g.position.set(x, y, z);
      g.rotation.set(rx, 0, rz);
      seen.add(c.id);
      return g;
    };
    st.pockets.forEach((c, i) => {
      if (c) place(c, (i - (SPEC.pockets - 1) / 2 + phase) * PITCH, CUP_BASE, 0);
    });
    for (const c of st.falling) {
      const top = 1.085, y = lerp(top, CUP_BASE, c.fall * c.fall);
      place(c, stationX(ST.drop), y, 0);
    }
    const now = performance.now() / 1000;
    const since = (id) => {
      if (!this.doneAnim.has(id)) this.doneAnim.set(id, now);
      return now - this.doneAnim.get(id);
    };
    // çıkış bandı: son cepten banda aktarım animasyonu, sonra bant üzerinde ilerleme
    const lastX = stationX(SPEC.pockets - 1);
    for (const c of st.outfeed) {
      const k = ease(Math.min(1, since(c.id) / 0.4));
      const x = OUT_X0 + c.pos;
      place(c, lerp(lastX + PITCH * 0.5, x, k), lerp(CUP_BASE, TABLE_Y + 0.012, k), 0);
    }
    this.outEye.emissive.setHex(st.outfeed.length >= SPEC.outfeedCapacity ? 0xff5500 : 0x00aa44);
    let rejected = 0;
    const doneList = st.done;
    for (let n = doneList.length - 1; n >= 0; n--) {
      const c = doneList[n];
      const t = Math.min(1, since(c.id) / 0.6);
      {
        if (rejected >= 18) continue;
        const slot = rejected++;
        const h = (c.id * 9301 + 49297) % 233280 / 233280;   // kararlı rastgele dağılım
        const tx = this.rejX - 0.12 + h * 0.24, tz = -0.58 + ((c.id * 7) % 10) / 10 * 0.16;
        const ty = 0.535 + Math.min(slot, 8) * 0.004;
        const k = ease(t);
        place(c, lerp(this.rejX, tx, k), lerp(CUP_BASE, ty, k) + Math.sin(k * Math.PI) * 0.05,
          lerp(0, tz, k), lerp(0, Math.PI / 2 * (h > 0.5 ? 1 : -1), k), (h - 0.5) * 1.2 * k);
      }
    }
    for (const [id, g] of this.cups) {
      if (!seen.has(id)) { this.scene.remove(g); this.cups.delete(id); this.doneAnim.delete(id); }
    }

    // magazin
    const visible = Math.min(st.cupMag, this.stack.length);
    this.stack.forEach((c, i) => { c.visible = i < visible; });
    this.foilStack.forEach((f, i) => { f.visible = i < Math.min(40, Math.ceil(st.foilMag / 2)); });

    // dolum ağzı
    const nozY = lerp(TABLE_Y + 0.22, CUP_BASE + CUP_H + 0.025, st.nozzle);
    this.nozzle.position.set(this.nozzleX, nozY, 0);
    this.nozzleRod.position.set(this.nozzleX, (nozY + 0.15 + TABLE_Y + 0.66) / 2, 0);
    this.nozzleRod.scale.y = (TABLE_Y + 0.66 - nozY - 0.15) / 0.2 + 0.4;
    const flowing = st.flow > 0.6;
    this.stream.visible = flowing;
    if (flowing) {
      const tipY = nozY - 0.03;
      const cup = !st.moving && st.pockets[ST.fill];
      const surface = cup ? CUP_BASE + 0.004 + Math.min(1, cup.product / 245) * (CUP_H - 0.004) : PLATE_Y;
      const len = Math.max(0.005, tipY - surface);
      this.stream.position.set(this.nozzleX, tipY, 0);
      this.stream.scale.set(0.5 + st.flow / 150, len, 0.5 + st.flow / 150);
    }
    const spill = st.kpi.spilledKg;
    this.puddle.visible = spill > 0.005;
    const r = Math.min(0.45, 0.05 + Math.sqrt(spill) * 0.25);
    this.puddle.scale.set(r, 1, r * 0.7);

    // tank
    this.sightLiquid.scale.y = Math.max(0.01, st.level / 100);
    this.tankLabel.element.querySelector('.v').textContent = `%${st.level.toFixed(0)}`;
    this.sightLiquid.material = this.process.liquidMaterial(st.tankComp);

    // folyo kolu: 0→0,5 magazinden cebe, 0,5→1 geri
    const p = st.foilArm < 0 ? 0 : st.foilArm;
    const k = p < 0.5 ? ease(p * 2) : 1 - ease((p - 0.5) * 2);
    const dip = Math.sin(Math.min(1, p * 2) * Math.PI) * 0.0 + (Math.abs(p - 0.5) < 0.08 ? 0.03 : 0) + (p < 0.06 && p > 0 ? 0.02 : 0);
    const armY = TABLE_Y + 0.2 - dip;
    this.foilArmObj.position.set(this.foilX, armY, lerp(this.foilMz, 0, k));
    this.foilCarried.visible = st.foilCarry && st.foilArm >= 0;

    // kapama kafası
    const sealY = lerp(TABLE_Y + 0.24, CUP_BASE + CUP_H + 0.012, st.sealer);
    this.sealHead.position.set(this.sealX, sealY, 0);
    this.sealRod.position.set(this.sealX, (sealY + TABLE_Y + 0.6) / 2 + 0.05, 0);
    this.sealRod.scale.y = Math.max(0.2, (TABLE_Y + 0.6 - sealY) / 0.3);
    const heat = Math.max(0, Math.min(1, (st.temp - 60) / 200));
    M.heater.emissive.setRGB(heat * 1.0, heat * 0.32, heat * 0.05);
    M.heater.emissiveIntensity = heat * 1.4;

    // kontrol tartısı göstergesi
    this.checkT = (this.checkT || 0) + dt;
    if (this.checkT > 0.15) {
      this.checkT = 0;
      const v = st.checkScale;
      if (v < 2) this.drawCheck('0.0 g', '#4a6b5a');
      else {
        const net = v - SPEC.cupTare - SPEC.foilMass;
        const ok = Math.abs(net - SPEC.targetNet) <= SPEC.tolerance;
        this.drawCheck(`${v.toFixed(1)} g`, ok ? '#2fd17a' : '#ff4d4f');
      }
    }

    // red pistonu
    const pz = lerp(0.14, -0.06, st.reject);
    this.rejPusher.position.z = pz;
    this.rejRod.position.z = (pz + 0.28) / 2;
    this.rejRod.scale.y = Math.max(0.2, (0.28 - pz) / 0.25);

    // kule lambası
    const on = (b) => bitOf(out, b);
    this.lamps.green.emissiveIntensity = on(10) ? 2.2 : 0.04;
    this.lamps.yellow.emissiveIntensity = on(11) ? 2.2 : 0.04;
    this.lamps.red.emissiveIntensity = on(12) ? 2.4 : 0.04;
    this.lampLight.color.set(on(12) ? 0xff3030 : on(11) ? 0xffc030 : 0x30ff90);
    this.lampLight.intensity = on(12) || on(11) || on(10) ? 0.6 : 0;
  }

  render(dt) {
    if (this.camTween) {
      const tw = this.camTween;
      tw.t = Math.min(1, tw.t + dt / 0.9);
      const k = ease(tw.t);
      this.camera.position.lerpVectors(tw.p0, tw.p1, k);
      this.controls.target.lerpVectors(tw.t0, tw.t1, k);
      if (tw.t >= 1) this.camTween = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}

export { M, box, cyl, label, makeCup, applyCup, CUP_H };
