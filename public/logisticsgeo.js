// AGV yolu ve otomatik depo (AS/RS) yerleşimi (metre, sahne koordinatı). Simülatör ve 3B ortak kullanır.
//
//   z
//   ^   paletleme hücresi ── D (alım) ·· AGV ··┐
//   |                                          │ (doğu koridoru, şarj, park)
//   |   ┌──────── raf, taraf 1 ────────┐ [P&D giriş] ◄── giriş konveyörü ◄── AGV bırakır
//   |   │  vinç koridoru (x boyunca)   │
//   |   └──────── raf, taraf 2 ────────┘ [P&D çıkış] ──► çıkış konveyörü ──► kamyon rampası
//   +──────────────▶ x
import { PG } from './palletgeo.js';

export const RACK = {
  aisleZ: -5.0,
  sideZ: [-4.25, -5.75],          // taraf 1 / taraf 2 göz derinlik merkezi
  colX: [2.4, 3.4, 4.4, 5.4, 6.4, 7.4],
  levelY: [0.18, 0.93, 1.68],     // göz tabanı (paletin alt yüzü)
  pdX: 8.4,                       // P&D sütunu (giriş taraf 1, çıkış taraf 2)
  pdY: 0.34,                      // P&D konveyör üstü
  height: 2.5,
};
RACK.cols = RACK.colX.length;
RACK.levels = RACK.levelY.length;
RACK.slots = 2 * RACK.cols * RACK.levels;   // 36

// Göz numarası 1..36: taraf, sütun, kat. Aynı numara PLC'de ve simülatörde kullanılır.
export function loc(n) {
  const k = n - 1;
  const side = Math.floor(k / (RACK.cols * RACK.levels));
  const r = k % (RACK.cols * RACK.levels);
  const col = Math.floor(r / RACK.levels), level = r % RACK.levels;
  return { side, col, level, x: RACK.colX[col], y: RACK.levelY[level], z: RACK.sideZ[side] };
}

// Konveyörler: palet x boyunca hareket eder (uzun kenar önde)
export const CONV = {
  inZ: RACK.sideZ[0], inX0: 10.3, inCheckX: 9.35, inX1: RACK.pdX,     // AGV bırakma → kontur/ID → P&D
  outZ: RACK.sideZ[1], outX0: RACK.pdX, outX1: 10.3,                 // P&D → kamyon rampası
};

// AGV yol ağı. Konum = yük merkezi (çatal ortası); yön = çatalların baktığı yön (radyan, +x = 0).
// İstasyonlara çatal önde (geri geri) girilir, yolda gövde önde gidilir.
export const NODES = {
  D_DOCK: { x: PG.zones[3], z: PG.lineZ },            // alım noktası D (paletleme)
  D_PRE: { x: PG.zones[3] + 1.5, z: PG.lineZ },
  EAST_N: { x: 11.4, z: PG.lineZ },
  EAST_S: { x: 11.4, z: CONV.inZ },
  IN_PRE: { x: CONV.inX0 + 1.0, z: CONV.inZ },
  IN_DOCK: { x: CONV.inX0, z: CONV.inZ },             // giriş konveyörü başı
  CHARGE: { x: 12.4, z: -3.0 },
  PARK: { x: 12.4, z: -2.2 },
};
export const EDGES = [
  ['D_DOCK', 'D_PRE'], ['D_PRE', 'EAST_N'], ['EAST_N', 'PARK'], ['EAST_N', 'EAST_S'], ['EAST_S', 'IN_PRE'],
  ['IN_PRE', 'IN_DOCK'], ['EAST_S', 'CHARGE'], ['PARK', 'CHARGE'],
];
export const DOCKS = { D_DOCK: 'D_PRE', IN_DOCK: 'IN_PRE' };   // istasyon → yaklaşma düğümü (çatal önde son bölüm)
export const AGV = { forkLen: 1.15, bodyLen: 0.55, width: 0.72 };
