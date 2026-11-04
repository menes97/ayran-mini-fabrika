// Paletleme hücresinin yerleşimi (metre, sahne koordinatı). Simülatördeki robot kontrolcüsü yörüngeleri,
// tarayıcı da 3B modeli bu sayılardan kurar; ikisi aynı geometriyi görür.
//
//            z
//   (arka)   ^      A ────── B ────── C ──┃── D        palet hattı (z = LINE_Z)
//            |    besleme  istif   streç  perde alım
//            |                 ROBOT
//            |   ═══ fırın çıkış bandı ═══▶ P (alma noktası)
//   (ön)     +──────────────▶ x
export const PACK = { lx: 0.266, lz: 0.184, h: 0.106 };   // 6'lı paket (altlık + bardak + film)

export const PG = {
  pick: { x: 5.07, y: 0.9 + PACK.h, z: -0.16 },     // fırın çıkış bandının sonundaki paketin üst yüzü
  base: { x: 5.75, z: -0.78 },                       // robot ayağı
  lineZ: -1.7,                                       // palet hattı ekseni
  zones: [4.45, 5.75, 6.95, 8.2],                    // A besleme, B istif, C streç, D alım noktası
  rollerTop: 0.34,                                   // makaralı konveyör üst yüzü
  palletH: 0.144,                                    // 800x600 yarım palet, 144 mm
  pallet: { lx: 0.8, lz: 0.6 },
  sheetH: 0.004,                                     // karton ara levha
  sheetMag: { x: 6.75, y: 0.62, z: -0.42 },          // levha magazini üst yüzü
  travelY: 1.48,                                     // robotun güvenli taşıma yüksekliği
  fence: { x0: 5.0, x1: 7.65, z0: -2.6, z1: 0.18 },  // çit; doğu kenarında ışık perdesi
  doorX: 6.55,                                       // ön çitteki bakım kapısı
  layers: 3, perLayer: 6,
};
PG.slots = PG.layers * PG.perLayer;                  // 18 paket / palet
PG.palletTop = PG.rollerTop + PG.palletH;            // boş paletin üst yüzü
PG.curtainX = PG.fence.x1;

// Slot 1..18: katman katman, her katmanda 2 (palet boyu, x) x 3 (palet eni, z). Paketler aynı yönde
// sütun hâlinde istiflenir (tie-sheet yok; kararlılığı alt/üst karton ve streç film sağlar).
export function slotPos(slot) {
  const k = slot - 1;
  const layer = Math.floor(k / PG.perLayer);
  const i = k % PG.perLayer;
  const col = i % 2, row = Math.floor(i / 2);
  return {
    layer,
    x: PG.zones[1] + (col - 0.5) * (PACK.lx + 0.004),
    z: PG.lineZ + (row - 1) * (PACK.lz + 0.004),
    y: PG.palletTop + PG.sheetH + layer * PACK.h,    // paketin alt yüzü
  };
}

// Palet istif bölgesi: robot takımı bu dikdörtgenin içindeyse "palet bölgesinde" sayılır.
export const ZONE_B = { x0: PG.zones[1] - 0.55, x1: PG.zones[1] + 0.55, z0: PG.lineZ - 0.45, z1: PG.lineZ + 0.45 };
export const inPalletZone = (p) => p.x > ZONE_B.x0 && p.x < ZONE_B.x1 && p.z > ZONE_B.z0 && p.z < ZONE_B.z1;
