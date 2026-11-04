// Simülatör ↔ PLC sinyal haritası (sürüm 6). Sunucu, tarayıcı, JS test PLC'si ve ST kod
// üreticisi (tools/gen-plc.js) bu dosyayı paylaşır; adres değişikliği yalnızca burada yapılır.
//
// Simülatör Modbus TCP sunucusudur (slave), PLC istemcidir (master). Her istasyona
// 16 register'lık bir blok ayrılır:
//
//   Input Register  blok*16 + n   simülatör → PLC (sensörler, ölçümler)
//   Holding Register blok*16 + n  PLC → simülatör (aktüatörler, durum)
//
// Blok 0 fabrikanın ortak alanıdır (operatör paneli, acil stop, kalp atışları).
// 7 blok = 112 register: tek bir FC4 okuma ve tek bir FC16 yazma isteğine sığar (sınır 125/123).

export const MAP_VERSION = 7;
export const BLOCK = 16;
export const N_BLOCKS = 7;

export const CELLS = [
  { id: 'fab',    block: 0, prefix: 'FAB',   name: 'Fabrika' },
  { id: 'dolum',  block: 1, prefix: 'DOL',   name: 'Dolum-kapama' },
  { id: 'tank',   block: 2, prefix: 'TNK',   name: 'Tank ve transfer' },
  { id: 'shrink', block: 3, prefix: 'SHR',   name: 'Shrink ve fırın' },
  { id: 'palet',  block: 4, prefix: 'PAL',   name: 'Paletleme' },
  { id: 'agv',    block: 5, prefix: 'AGV',   name: 'AGV transpalet' },
  { id: 'asrs',   block: 6, prefix: 'ASRS',  name: 'Otomatik depo' },
];

// Her istasyonun register ve bit tanımları. `off` blok içindeki sıradır.
export const IO = {
  fab: {
    ir: [
      { off: 0, tag: 'FAB_IW_DI',     label: 'Fabrika paneli girişleri (bit paketli)' },
      { off: 1, tag: 'FAB_IW_MAPVER', label: 'Sinyal haritası sürümü' },
      { off: 2, tag: 'FAB_IW_SIM_HB', label: 'Simülatör kalp atışı (100 ms)' },
    ],
    hr: [
      { off: 0, tag: 'FAB_QW_DO',     label: 'Fabrika çıkışları (bit paketli)' },
      { off: 1, tag: 'FAB_QW_PLC_HB', label: 'Proses PLC (ya da tek PLC) kalp atışı (her tarama)' },
      { off: 2, tag: 'FAB_QW_STATE',  label: 'Fabrika durumu' },
      { off: 3, tag: 'FAB_QW_ALARM',  label: 'Fabrika alarm özeti' },
    ],
    di: [
      { bit: 0, tag: 'START',    label: 'Start butonu (NO)' },
      { bit: 1, tag: 'STOP_OK',  label: 'Stop butonu (NC, 1 = basılı değil)' },
      { bit: 2, tag: 'ESTOP_OK', label: 'Acil stop zinciri (NC, 1 = sağlam)' },
      { bit: 3, tag: 'RESET',    label: 'Reset / alarm onay' },
    ],
    do: [
      { bit: 0, tag: 'RUNNING',  label: 'Fabrika üretimde' },
    ],
  },

  dolum: {
    ir: [
      { off: 0, tag: 'DOL_IW_DI',    label: 'Dijital girişler (bit paketli)' },
      { off: 1, tag: 'DOL_IW_FILL',  label: 'Dolum terazisi (net)', unit: '0,1 g' },
      { off: 2, tag: 'DOL_IW_TANK',  label: 'Dolum tankı seviyesi', unit: '0,1 %' },
      { off: 3, tag: 'DOL_IW_TEMP',  label: 'Kapama kafası sıcaklığı', unit: '0,1 °C' },
      { off: 4, tag: 'DOL_IW_CHECK', label: 'Kontrol tartısı (brüt)', unit: '0,1 g' },
    ],
    hr: [
      { off: 0, tag: 'DOL_QW_DO',     label: 'Dijital çıkışlar (bit paketli)' },
      { off: 1, tag: 'DOL_QW_STATE',  label: 'Makine modu' },
      { off: 2, tag: 'DOL_QW_ALARM',  label: 'Alarm kelimesi' },
      { off: 3, tag: 'DOL_QW_GOOD',   label: 'Sağlam bardak sayacı' },
      { off: 4, tag: 'DOL_QW_REJECT', label: 'Red sayacı' },
      { off: 5, tag: 'DOL_QW_STATUS', label: 'Durum bitleri (bit 7: yeniden başladı, START bekliyor)' },
    ],
    di: [
      { bit: 0,  tag: 'INDEX',        label: 'Endeksleyici bekleme konumunda' },
      { bit: 1,  tag: 'CUP_EMPTY',    label: 'Bardak magazini boş' },
      { bit: 2,  tag: 'CUP_AT_FILL',  label: 'Dolum istasyonunda bardak var' },
      { bit: 3,  tag: 'NOZ_UP',       label: 'Dolum ağzı yukarıda' },
      { bit: 4,  tag: 'NOZ_DN',       label: 'Dolum ağzı aşağıda' },
      { bit: 5,  tag: 'FOIL_EMPTY',   label: 'Folyo magazini boş' },
      { bit: 6,  tag: 'FOIL_AT_SEAL', label: 'Kapama istasyonunda folyolu bardak' },
      { bit: 7,  tag: 'SEAL_UP',      label: 'Kapama kafası yukarıda' },
      { bit: 8,  tag: 'SEAL_DN',      label: 'Kapama kafası aşağıda' },
      { bit: 9,  tag: 'TANK_LOW',     label: 'Dolum tankı alt seviye' },
      { bit: 10, tag: 'CUP_AT_REJ',   label: 'Red istasyonunda bardak var' },
      { bit: 11, tag: 'REJ_EXT',      label: 'Red pistonu ileride' },
      { bit: 12, tag: 'OUT_FULL',     label: 'Çıkış bandı dolu' },
    ],
    do: [
      { bit: 0,  tag: 'CONV',      label: 'Endeksleyici motor (1 adım)' },
      { bit: 1,  tag: 'CUP_DROP',  label: 'Bardak ayırıcı' },
      { bit: 2,  tag: 'NOZ_DN',    label: 'Dolum ağzı aşağı' },
      { bit: 3,  tag: 'FILL_FAST', label: 'Dolum vanası, kaba akış' },
      { bit: 4,  tag: 'FILL_FINE', label: 'Dolum vanası, ince akış' },
      { bit: 5,  tag: 'FOIL',      label: 'Folyo yerleştirici' },
      { bit: 6,  tag: 'SEAL_DN',   label: 'Kapama kafası aşağı' },
      { bit: 7,  tag: 'HEATER',    label: 'Kapama ısıtıcısı' },
      { bit: 8,  tag: 'REJECT',    label: 'Red pistonu' },
      { bit: 9,  tag: 'RESERVED9', label: '(boş: tank beslemesi artık tank istasyonunda)' },
      { bit: 10, tag: 'GREEN',     label: 'Kule lambası yeşil' },
      { bit: 11, tag: 'YELLOW',    label: 'Kule lambası sarı' },
      { bit: 12, tag: 'RED',       label: 'Kule lambası kırmızı' },
      { bit: 13, tag: 'HORN',      label: 'Korna' },
    ],
  },

  tank: {
    ir: [
      { off: 0, tag: 'TNK_IW_DI',      label: 'Dijital girişler (bit paketli)' },
      { off: 1, tag: 'TNK_IW_T1_LVL',  label: 'Üretim tankı T1 seviyesi', unit: '0,1 %' },
      { off: 2, tag: 'TNK_IW_FLOW',    label: 'Debimetre FT1', unit: '0,01 kg/s' },
      { off: 3, tag: 'TNK_IW_TOTAL',   label: 'Debimetre toplayıcı (30000\'de sıfırlanır)', unit: '0,1 kg' },
      { off: 4, tag: 'TNK_IW_COND',    label: 'Hat iletkenliği QT1 (25 °C\'ye düzeltilmiş)', unit: '0,1 mS/cm' },
      { off: 5, tag: 'TNK_IW_RET_T',   label: 'Hat dönüş sıcaklığı TT1', unit: '0,1 °C' },
      { off: 6, tag: 'TNK_IW_CIP_T',   label: 'Kostik tankı sıcaklığı TT2', unit: '0,1 °C' },
      { off: 7, tag: 'TNK_IW_CIP_LVL', label: 'Kostik tankı seviyesi', unit: '0,1 %' },
    ],
    hr: [
      { off: 0,  tag: 'TNK_QW_DO',      label: 'Dijital çıkışlar (bit paketli)' },
      { off: 1,  tag: 'TNK_QW_STATE',   label: 'İstasyon durumu' },
      { off: 2,  tag: 'TNK_QW_ALARM',   label: 'Alarm kelimesi' },
      { off: 3,  tag: 'TNK_QW_STEP_T',  label: 'Adım süresi', unit: 's' },
      { off: 4,  tag: 'TNK_QW_SINCE',   label: 'Son CIP\'ten beri aktarılan', unit: '0,1 kg' },
      { off: 5,  tag: 'TNK_QW_BATCH',   label: 'Bu aktarımda aktarılan', unit: '0,1 kg' },
      // son CIP kaydı
      { off: 6,  tag: 'TNK_QW_CIP_RES', label: 'Son CIP sonucu (0 yok, 1 başarılı, 2 iptal, 3 başarısız)' },
      { off: 7,  tag: 'TNK_QW_CIP_MINT', label: 'Son CIP: tutma sırasında en düşük dönüş sıcaklığı', unit: '0,1 °C' },
      { off: 8,  tag: 'TNK_QW_CIP_MINF', label: 'Son CIP: tutma sırasında en düşük debi', unit: '0,01 kg/s' },
      { off: 9,  tag: 'TNK_QW_CIP_COND', label: 'Son CIP: son durulama iletkenliği', unit: '0,1 mS/cm' },
      { off: 10, tag: 'TNK_QW_CIP_DUR',  label: 'Son CIP: toplam süre', unit: 's' },
      { off: 11, tag: 'TNK_QW_STATUS', label: 'Durum bitleri (bit 7: yeniden başladı, START bekliyor)' },
    ],
    di: [
      { bit: 0,  tag: 'T1_LOW',      label: 'Üretim tankı alt seviye' },
      { bit: 1,  tag: 'CIP_START',   label: 'CIP başlat butonu' },
      { bit: 2,  tag: 'CIP_ABORT',   label: 'CIP iptal butonu' },
      { bit: 3,  tag: 'P1_RUN',      label: 'Pompa kontaktör geri bildirimi' },
      { bit: 4,  tag: 'P1_TRIP',     label: 'Pompa motor koruma attı' },
      { bit: 5,  tag: 'VPROD_CL',    label: 'Üretim tankı vanası kapalı (sınır anahtarı)' },
      { bit: 6,  tag: 'VWATER_CL',   label: 'Su vanası kapalı' },
      { bit: 7,  tag: 'VCAUSTIC_CL', label: 'Kostik vanası kapalı' },
      { bit: 8,  tag: 'VFILL_CL',    label: 'Dolum tankı vanası kapalı (çift oturmalı)' },
      { bit: 9,  tag: 'VDRAIN_CL',   label: 'Gider vanası kapalı' },
      { bit: 10, tag: 'VCIPRET_CL',  label: 'CIP dönüş vanası kapalı' },
      { bit: 11, tag: 'VFILL_LEAK',  label: 'Dolum vanası kaçak odasında sıvı' },
    ],
    do: [
      { bit: 0, tag: 'P1',        label: 'Transfer pompası' },
      { bit: 1, tag: 'V_PROD',    label: 'Üretim tankı çıkış vanası' },
      { bit: 2, tag: 'V_WATER',   label: 'Su besleme vanası' },
      { bit: 3, tag: 'V_CAUSTIC', label: 'Kostik besleme vanası' },
      { bit: 4, tag: 'V_FILL',    label: 'Dolum tankı giriş vanası' },
      { bit: 5, tag: 'V_DRAIN',   label: 'Gidere boşaltma vanası' },
      { bit: 6, tag: 'V_CIPRET',  label: 'CIP dönüş vanası (kostik tankına)' },
      { bit: 7, tag: 'CIP_HEAT',  label: 'Kostik tankı ısıtıcısı' },
      { bit: 8, tag: 'CIP_LAMP',  label: 'CIP çalışıyor lambası' },
    ],
  },

  shrink: {
    ir: [
      { off: 0, tag: 'SHR_IW_DI',      label: 'Dijital girişler (bit paketli)' },
      { off: 1, tag: 'SHR_IW_LANE',    label: 'Şeritteki bardak sayısı (bileşik sensör)' },
      { off: 2, tag: 'SHR_IW_TEMP',    label: 'Fırın hava sıcaklığı', unit: '0,1 °C' },
      { off: 3, tag: 'SHR_IW_IN_CNT',  label: 'Fırın girişi paket sayacı (30000\'de sıfırlanır)' },
      { off: 4, tag: 'SHR_IW_OUT_CNT', label: 'Fırın çıkışı paket sayacı' },
      { off: 5, tag: 'SHR_IW_FILM',    label: 'Film bobini kalan', unit: '0,1 %' },
      { off: 6, tag: 'SHR_IW_PADS',    label: 'Altlık magazini adedi' },
      { off: 7, tag: 'SHR_IW_EXIT_CNT', label: 'Çıkıştan alınan paket sayacı' },
      { off: 8, tag: 'SHR_IW_PLATE', label: 'Plaka fotoselleri (bit 0: sıra 1, bit 1: sıra 2)' },
      { off: 9, tag: 'SHR_IW_DIVERT', label: 'Çıkış ayırıcı: bit 0 paket var, 1 red konumu, 2 geçiş konumu' },
      { off: 10, tag: 'SHR_IW_REJECT_CNT', label: 'Karantina kasasına ayrılan paket sayacı (30000 modül)' },
    ],
    hr: [
      { off: 0, tag: 'SHR_QW_DO',      label: 'Dijital çıkışlar (bit paketli)' },
      { off: 1, tag: 'SHR_QW_STATE',   label: 'İstasyon durumu' },
      { off: 2, tag: 'SHR_QW_ALARM',   label: 'Alarm kelimesi' },
      { off: 3, tag: 'SHR_QW_STATUS',  label: 'Durum bitleri (PackML benzeri)' },
      { off: 4, tag: 'SHR_QW_PACKS',   label: 'Fırına bırakılan paket sayacı' },
      { off: 5, tag: 'SHR_QW_INSIDE',  label: 'Fırın içindeki paket' },
      { off: 6, tag: 'SHR_QW_SP',      label: 'Geçerli fırın ayar değeri', unit: '0,1 °C' },
      { off: 7, tag: 'SHR_QW_REJECT', label: 'Fotoselden doğrulanan karantina paket sayacı (30000 modül)' },
      { off: 8, tag: 'SHR_QW_GOOD', label: 'İyi ürün bandına geçirilen paket sayacı (30000 modül)' },
      { off: 15, tag: 'SHR_QW_PLC_HB', label: 'Paketleme PLC kalp atışı (her tarama)' },
    ],
    di: [
      { bit: 0,  tag: 'LANE_FULL',   label: 'Şeritte 3 bardak hazır' },
      { bit: 1,  tag: 'ROWP_EXT',    label: 'Sıra iticisi ileride' },
      { bit: 2,  tag: 'ROWP_RET',    label: 'Sıra iticisi geride' },
      { bit: 3,  tag: 'GRPP_EXT',    label: 'Grup iticisi ileride' },
      { bit: 4,  tag: 'GRPP_RET',    label: 'Grup iticisi geride' },
      { bit: 5,  tag: 'PAD_PRESENT', label: 'Plakada karton altlık var' },
      { bit: 6,  tag: 'PAD_LOW',     label: 'Altlık magazini azaldı' },
      { bit: 7,  tag: 'WRAP_READY',  label: 'Sarma makinesi paket alabilir' },
      { bit: 8,  tag: 'WRAP_BUSY',   label: 'Sarma çevrimi sürüyor' },
      { bit: 9,  tag: 'WRAP_DONE',   label: 'Sarma bitti (istek düşene kadar)' },
      { bit: 10, tag: 'WRAP_FAULT',  label: 'Sarma arızası (film koptu)' },
      { bit: 11, tag: 'PACK_IN_WRAP', label: 'Sarma makinesinde paket var' },
      { bit: 12, tag: 'FAN_RUN',     label: 'Fırın fanı dönüyor' },
      { bit: 13, tag: 'BELT_RUN',    label: 'Fırın bandı hareket ediyor' },
      { bit: 14, tag: 'OT_TRIP',     label: 'Aşırı sıcaklık kesmesi attı' },
      { bit: 15, tag: 'EXIT_FULL',   label: 'Çıkış bandı dolu' },
    ],
    do: [
      { bit: 0, tag: 'GATE',     label: 'Şerit giriş kapısı kapalı' },
      { bit: 1, tag: 'ROW_PUSH', label: 'Sıra iticisi' },
      { bit: 2, tag: 'GRP_PUSH', label: 'Grup iticisi' },
      { bit: 3, tag: 'PAD_FEED', label: 'Altlık yerleştir' },
      { bit: 4, tag: 'WRAP_REQ', label: 'Sarma isteği (bitti gelene kadar tutulur)' },
      { bit: 5, tag: 'RELEASE',  label: 'Paketi fırın bandına bırak' },
      { bit: 6, tag: 'TUN_CONV', label: 'Fırın bandı' },
      { bit: 7, tag: 'HEATER',   label: 'Fırın ısıtıcısı' },
      { bit: 8, tag: 'FAN',      label: 'Fırın fanı' },
      { bit: 9, tag: 'EXIT_PASS', label: 'Fırın çıkış ayırıcı: iyi ürün bandına geçir' },
      { bit: 10, tag: 'EXIT_REJECT', label: 'Fırın çıkış ayırıcı: karantina kasasına ayır' },
    ],
  },

  palet: {
    ir: [
      { off: 0, tag: 'PAL_IW_DI',      label: 'Hat ve güvenlik girişleri (bit paketli)' },
      { off: 1, tag: 'PAL_IW_ROB_DI',  label: 'Robot kontrolcüsü durum bitleri' },
      { off: 2, tag: 'PAL_IW_ACK_SEQ', label: 'Robot: kabul edilen son iş numarası' },
      { off: 3, tag: 'PAL_IW_RES_SEQ', label: 'Robot: biten son iş numarası' },
      { off: 4, tag: 'PAL_IW_RES_CODE', label: 'Robot: son iş sonucu (1 tamam, 10+ hata)' },
      { off: 5, tag: 'PAL_IW_RES_SLOT', label: 'Robot: son işin slotu' },
      { off: 6, tag: 'PAL_IW_TURNS',   label: 'Streç sarma: bu çevrimdeki tur' },
      { off: 7, tag: 'PAL_IW_PALLETS', label: 'Boş palet magazini adedi' },
      { off: 8, tag: 'PAL_IW_SHEETS',  label: 'Karton levha magazini adedi' },
      { off: 9, tag: 'PAL_IW_PICKUP_CNT', label: 'Alım noktasından alınan palet sayacı' },
      { off: 10, tag: 'PAL_IW_IL',     label: 'İstasyon el sıkışma girişleri (AGV optik I/O)' },
      { off: 11, tag: 'PAL_IW_RES_JOB', label: 'Robot: biten son işin tipi' },
    ],
    hr: [
      { off: 0,  tag: 'PAL_QW_DO',     label: 'Dijital çıkışlar (bit paketli)' },
      { off: 1,  tag: 'PAL_QW_JOB',    label: 'Robot işi (1 al, 2 bırak, 3 levha, 4 eve dön)' },
      { off: 2,  tag: 'PAL_QW_SLOT',   label: 'Robot slotu (bırak: 1..18, levha: 0 alt / 1 üst)' },
      { off: 3,  tag: 'PAL_QW_SEQ',    label: 'Robot iş numarası (değişince iş başlar)' },
      { off: 4,  tag: 'PAL_QW_STATE',  label: 'İstasyon durumu' },
      { off: 5,  tag: 'PAL_QW_ALARM',  label: 'Alarm kelimesi' },
      { off: 6,  tag: 'PAL_QW_STATUS', label: 'Durum bitleri (PackML benzeri)' },
      { off: 7,  tag: 'PAL_QW_COUNT',  label: 'İstifteki paletin paket sayısı (doğrulanmış)' },
      { off: 8,  tag: 'PAL_QW_DONE',   label: 'Tamamlanan palet sayacı' },
      { off: 9,  tag: 'PAL_QW_PALLET_ID', label: 'İstifteki paletin numarası' },
      { off: 10, tag: 'PAL_QW_WRAPPED', label: 'Streçlenen palet sayacı' },
    ],
    di: [
      { bit: 0,  tag: 'PACK_AT_PICK', label: 'Alma noktasında paket var' },
      { bit: 1,  tag: 'PAL_A',        label: 'A: besleme konumunda palet' },
      { bit: 2,  tag: 'PAL_B',        label: 'B: istif konumunda palet' },
      { bit: 3,  tag: 'PAL_C',        label: 'C: streç makinesinde palet' },
      { bit: 4,  tag: 'PAL_D',        label: 'D: alım noktasında palet' },
      { bit: 5,  tag: 'PIN_UP',       label: 'Durdurma pimi yukarıda' },
      { bit: 6,  tag: 'DISP_BUSY',    label: 'Palet besleyici çalışıyor' },
      { bit: 7,  tag: 'WRAP_HOME',    label: 'Döner tabla başlangıç konumunda' },
      { bit: 8,  tag: 'WRAP_BUSY',    label: 'Streç sarma çalışıyor' },
      { bit: 9,  tag: 'WRAP_DONE',    label: 'Streç sarma bitti (istek düşene kadar)' },
      { bit: 10, tag: 'WRAP_FAULT',   label: 'Streç sarma arızası (film koptu)' },
      { bit: 11, tag: 'SAFETY_OK',    label: 'Güvenlik kontrolcüsü: hücre güvenli' },
      { bit: 12, tag: 'DOOR_CLOSED',  label: 'Hücre kapısı kapalı ve kilitli' },
      { bit: 13, tag: 'CURTAIN_CLEAR', label: 'Işık perdesi serbest' },
      { bit: 14, tag: 'MUTING',       label: 'Muting etkin (palet perdeden geçiyor)' },
      { bit: 15, tag: 'SAFE_RST_RDY', label: 'Güvenlik resetlenmeye hazır' },
    ],
    rob: [
      { bit: 0, tag: 'POWER_ON',    label: 'Robot sürücüleri enerjili' },
      { bit: 1, tag: 'READY',       label: 'Robot iş alabilir' },
      { bit: 2, tag: 'BUSY',        label: 'İş sürüyor' },
      { bit: 3, tag: 'AT_HOME',     label: 'Bekleme konumunda' },
      { bit: 4, tag: 'CLEAR_PAL',   label: 'Palet bölgesinin dışında' },
      { bit: 5, tag: 'PART_ON',     label: 'Tutucuda parça var' },
      { bit: 6, tag: 'VACUUM_OK',   label: 'Vakum var' },
      { bit: 7, tag: 'ERROR',       label: 'Robot hatası' },
      { bit: 8, tag: 'HOLDING',     label: 'Duraklatıldı (HOLD)' },
      { bit: 9, tag: 'HOMED',       label: 'Konumu doğrulanmış' },
    ],
    do: [
      { bit: 0,  tag: 'ROB_ENABLE', label: 'Robot sürücü enerjisi isteği' },
      { bit: 1,  tag: 'ROB_HOLD',   label: 'Robotu duraklat' },
      { bit: 2,  tag: 'ROB_ABORT',  label: 'Robot işini iptal et' },
      { bit: 3,  tag: 'ROB_RESET',  label: 'Robot hata reseti' },
      { bit: 4,  tag: 'DISPENSE',   label: 'Boş palet ver' },
      { bit: 5,  tag: 'CONV_A',     label: 'A konveyörü' },
      { bit: 6,  tag: 'CONV_B',     label: 'B konveyörü' },
      { bit: 7,  tag: 'CONV_C',     label: 'C konveyörü (streç)' },
      { bit: 8,  tag: 'CONV_D',     label: 'D konveyörü (alım)' },
      { bit: 9,  tag: 'PIN',        label: 'Durdurma pimi yukarı' },
      { bit: 10, tag: 'WRAP_REQ',   label: 'Streç sarma isteği (bitti gelene kadar)' },
      { bit: 11, tag: 'PICKUP_RDY', label: 'Palet alınmaya hazır (forklift / AGV)' },
      { bit: 12, tag: 'ZONE_PERMIT', label: 'Robota palet bölgesine giriş izni' },
    ],
    il: [
      { bit: 0, tag: 'AGV_CLEAR', label: 'AGV çatalları alım noktasının dışında (aracın optik sinyali)' },
    ],
  },

  agv: {
    ir: [
      { off: 0, tag: 'AGV_IW_DI',      label: 'AGV durum bitleri' },
      { off: 1, tag: 'AGV_IW_ACK_SEQ', label: 'AGV: kabul edilen son iş' },
      { off: 2, tag: 'AGV_IW_RES_SEQ', label: 'AGV: biten son iş' },
      { off: 3, tag: 'AGV_IW_RES_CODE', label: 'AGV: son iş sonucu' },
      { off: 4, tag: 'AGV_IW_BATTERY', label: 'Batarya', unit: '%' },
      { off: 5, tag: 'AGV_IW_NODE',    label: 'Bulunduğu / gittiği düğüm' },
      { off: 6, tag: 'AGV_IW_LOAD_ID', label: 'Çataldaki paletin numarası' },
      { off: 7, tag: 'AGV_IW_DELIVERED', label: 'Teslim edilen palet sayacı' },
      { off: 8, tag: 'AGV_IW_IL',      label: 'İstasyon el sıkışma girişleri (paletleme hücresinden kablo)' },
    ],
    hr: [
      { off: 0, tag: 'AGV_QW_DO',     label: 'AGV ve istasyon izinleri (bit paketli)' },
      { off: 1, tag: 'AGV_QW_ORDER',  label: 'AGV işi (1 taşı D→depo, 2 yükü depoya bırak, 3 şarj, 4 park)' },
      { off: 2, tag: 'AGV_QW_SEQ',    label: 'AGV iş numarası' },
      { off: 3, tag: 'AGV_QW_STATE',  label: 'AGV durumu' },
      { off: 4, tag: 'AGV_QW_ALARM',  label: 'Alarm kelimesi' },
      { off: 5, tag: 'AGV_QW_STATUS', label: 'Durum bitleri' },
      { off: 6, tag: 'AGV_QW_MOVES',  label: 'Tamamlanan taşıma sayacı' },
      { off: 15, tag: 'AGV_QW_PLC_HB', label: 'Lojistik PLC kalp atışı (her tarama)' },
    ],
    di: [
      { bit: 0,  tag: 'READY',       label: 'İş alabilir' },
      { bit: 1,  tag: 'BUSY',        label: 'İş sürüyor' },
      { bit: 2,  tag: 'LOADED',      label: 'Çatalda palet var' },
      { bit: 3,  tag: 'LIFT_UP',     label: 'Çatal yukarıda' },
      { bit: 4,  tag: 'AT_D',        label: 'Alım noktasında (çatallar içeride)' },
      { bit: 5,  tag: 'AT_IN',       label: 'Depo girişinde (çatallar içeride)' },
      { bit: 6,  tag: 'CLEAR_D',     label: 'Çatallar alım noktasının dışında' },
      { bit: 7,  tag: 'CLEAR_IN',    label: 'Çatallar depo girişinin dışında' },
      { bit: 8,  tag: 'CHARGING',    label: 'Şarj oluyor' },
      { bit: 9,  tag: 'ERROR',       label: 'Araç hatası' },
      { bit: 10, tag: 'SCAN_WARN',   label: 'Tarayıcı uyarı alanı (yavaş)' },
      { bit: 11, tag: 'SCAN_STOP',   label: 'Tarayıcı koruma alanı (durdu)' },
      { bit: 12, tag: 'WAIT_PERMIT', label: 'İstasyon izni bekliyor' },
      { bit: 13, tag: 'AT_PARK',     label: 'Park yerinde' },
      { bit: 14, tag: 'POWER',       label: 'Enerjili' },
      { bit: 15, tag: 'AT_CHARGER',  label: 'Şarj istasyonunda' },
    ],
    do: [
      { bit: 0, tag: 'ENABLE',    label: 'AGV enerji/çalışma izni' },
      { bit: 1, tag: 'PAUSE',     label: 'Duraklat' },
      { bit: 2, tag: 'RESET',     label: 'Hata reseti' },
      { bit: 3, tag: 'PERMIT_D',  label: 'Alım noktası izni (palet hazır, konveyör duruyor)' },
      { bit: 4, tag: 'PERMIT_IN', label: 'Depo girişi izni (giriş boş, konveyör duruyor)' },
    ],
    il: [
      { bit: 0, tag: 'D_READY', label: 'Paletleme: alım noktasında palet hazır (PAL_QW_DO bit 11, kablo)' },
    ],
  },

  asrs: {
    ir: [
      { off: 0,  tag: 'ASRS_IW_DI',     label: 'Vinç, konveyör ve güvenlik bitleri' },
      { off: 1,  tag: 'ASRS_IW_ACK_SEQ', label: 'Vinç: kabul edilen son iş' },
      { off: 2,  tag: 'ASRS_IW_RES_SEQ', label: 'Vinç: biten son iş' },
      { off: 3,  tag: 'ASRS_IW_RES_CODE', label: 'Vinç: son iş sonucu' },
      { off: 4,  tag: 'ASRS_IW_RES_LOC', label: 'Vinç: son işin gözü' },
      { off: 5,  tag: 'ASRS_IW_RES_ID',  label: 'Vinç: son işte okunan palet numarası (0 boş)' },
      { off: 6,  tag: 'ASRS_IW_IN_ID',   label: 'Giriş okuyucusu: palet numarası (0 okunamadı)' },
      { off: 7,  tag: 'ASRS_IW_FORK_ID', label: 'Vinç çatalındaki palet numarası' },
      { off: 8,  tag: 'ASRS_IW_TEMP',    label: 'Depo sıcaklığı', unit: '0,1 °C' },
      { off: 9,  tag: 'ASRS_IW_SHIP_REQ', label: 'Sevkiyat siparişi sayacı (palet)' },
      { off: 10, tag: 'ASRS_IW_SHIPPED', label: 'Kamyona yüklenen palet sayacı' },
    ],
    hr: [
      { off: 0,  tag: 'ASRS_QW_DO',     label: 'Dijital çıkışlar (bit paketli)' },
      { off: 1,  tag: 'ASRS_QW_JOB',    label: 'Vinç işi (1 depola, 2 çıkar, 3 eve dön, 4 göz kontrolü)' },
      { off: 2,  tag: 'ASRS_QW_LOC',    label: 'Göz numarası (1..36)' },
      { off: 3,  tag: 'ASRS_QW_SEQ',    label: 'Vinç iş numarası' },
      { off: 4,  tag: 'ASRS_QW_STATE',  label: 'Depo durumu' },
      { off: 5,  tag: 'ASRS_QW_ALARM',  label: 'Alarm kelimesi' },
      { off: 6,  tag: 'ASRS_QW_STATUS', label: 'Durum bitleri' },
      { off: 7,  tag: 'ASRS_QW_OCC_A',  label: 'PLC envanteri: dolu gözler 1-16 (bit)' },
      { off: 8,  tag: 'ASRS_QW_OCC_B',  label: 'PLC envanteri: dolu gözler 17-32 (bit)' },
      { off: 9,  tag: 'ASRS_QW_OCC_C',  label: 'PLC envanteri: dolu gözler 33-36 (bit)' },
      { off: 10, tag: 'ASRS_QW_STOCK',  label: 'Stoktaki palet' },
      { off: 11, tag: 'ASRS_QW_UNKNOWN', label: 'Durumu belirsiz göz (kontrol bekliyor)' },
      { off: 12, tag: 'ASRS_QW_STORED', label: 'Depolanan palet sayacı' },
      { off: 13, tag: 'ASRS_QW_PICKED', label: 'Sevkiyata çıkarılan palet sayacı' },
      { off: 14, tag: 'ASRS_QW_NEXT_ID', label: 'Sıradaki sevk paleti (FIFO, 0 yok)' },
    ],
    di: [
      { bit: 0,  tag: 'CR_READY',    label: 'Vinç iş alabilir' },
      { bit: 1,  tag: 'CR_BUSY',     label: 'Vinç işi sürüyor' },
      { bit: 2,  tag: 'CR_HOMED',    label: 'Vinç konumu doğrulanmış' },
      { bit: 3,  tag: 'FORK_CENTER', label: 'Çatal ortada' },
      { bit: 4,  tag: 'FORK_LOAD',   label: 'Çatalda palet var' },
      { bit: 5,  tag: 'CR_ERROR',    label: 'Vinç hatası' },
      { bit: 6,  tag: 'IN_ENTRY',    label: 'Giriş: AGV bırakma noktasında palet' },
      { bit: 7,  tag: 'IN_CHECK',    label: 'Giriş: kontrol noktasında palet' },
      { bit: 8,  tag: 'IN_PD',       label: 'Giriş P&D noktasında palet' },
      { bit: 9,  tag: 'OUT_PD',      label: 'Çıkış P&D noktasında palet' },
      { bit: 10, tag: 'OUT_DOCK',    label: 'Kamyon rampasında palet' },
      { bit: 11, tag: 'CHECK_DONE',  label: 'Kontur ve etiket ölçümü hazır' },
      { bit: 12, tag: 'CONTOUR_OK',  label: 'Kontur uygun' },
      { bit: 13, tag: 'SAFETY_OK',   label: 'Depo güvenlik devresi tamam' },
      { bit: 14, tag: 'DOOR_CLOSED', label: 'Koridor kapısı kapalı' },
      { bit: 15, tag: 'POWER',       label: 'Vinç enerjili' },
    ],
    do: [
      { bit: 0, tag: 'CR_ENABLE',  label: 'Vinç enerjisi isteği' },
      { bit: 1, tag: 'CR_HOLD',    label: 'Vinci duraklat' },
      { bit: 2, tag: 'CR_RESET',   label: 'Vinç hata reseti' },
      { bit: 3, tag: 'IN1',        label: 'Giriş konveyörü: bırakma → kontrol' },
      { bit: 4, tag: 'IN2',        label: 'Giriş konveyörü: kontrol → P&D' },
      { bit: 5, tag: 'OUT',        label: 'Çıkış konveyörü' },
      { bit: 6, tag: 'COOLING',    label: 'Soğutma' },
      { bit: 7, tag: 'REJECT_LAMP', label: 'Ret lambası (operatör paleti alsın)' },
    ],
  },
};

// Mutlak Modbus adresi
export const addr = (cellId, off) => CELLS.find((c) => c.id === cellId).block * BLOCK + off;

export const MODES = [
  'DURUYOR', 'ÇALIŞIYOR', 'DURUYOR (çevrim sonu)', 'ALARM', 'ACİL STOP', 'ISINIYOR', 'BEKLİYOR: ÇIKIŞ DOLU',
  'BEKLİYOR: ÜRÜN YOK', 'BEKLİYOR: BARDAK YOK',
];

export const TANK_STATES = [
  'BEKLEMEDE', 'ÜRÜN AKTARIYOR', 'HAT ÜRÜNLE DOLDURULUYOR', 'ROTA DEĞİŞİYOR',
  'CIP: hazırlık', 'CIP: kostik ısınıyor', 'CIP: ön durulama', 'CIP: kostik', 'CIP: son durulama',
  'CIP GEREKLİ', 'ALARM', 'ACİL STOP',
];

export const TANK_ALARMS = [
  { bit: 0,  text: 'Acil stop' },
  { bit: 1,  text: 'Pompa çalışıyor ama debi yok' },
  { bit: 2,  text: 'Hatta yabancı sıvı (iletkenlik ürün penceresi dışında)' },
  { bit: 3,  text: 'Vana kapanmadı (rota kanıtlanamadı)' },
  { bit: 4,  text: 'Dolum vanası kaçak odasında sıvı' },
  { bit: 5,  text: 'Pompa motor koruması attı' },
  { bit: 6,  text: 'Pompa kontaktörü çekmedi' },
  { bit: 7,  text: 'CIP koşulları sağlanamadı (zaman aşımı)' },
  { bit: 8,  text: 'Kostik tankı aşırı sıcak / seviye düşük' },
  { bit: 9,  text: 'Hat ürünle doldurulamadı (iletkenlik yakalanamadı)' },
  { bit: 10, text: 'Uyarı: üretim tankı alt seviyede' },
  { bit: 11, text: 'Uyarı: CIP gerekli, yeni aktarım yok' },
  { bit: 12, text: 'Uyarı: CIP iptal edildi' },
  { bit: 13, text: 'Simülatör haberleşmesi kesildi' },
];

export const SHRINK_STATES = [
  'DURUYOR', 'ISINIYOR', 'ÇALIŞIYOR', 'BEKLİYOR: BARDAK YOK', 'BEKLİYOR: ÇIKIŞ DOLU',
  'BOŞALTIYOR', 'SOĞUTUYOR', 'BEKLEMEDE (enerji tasarrufu)', 'ALARM', 'ACİL STOP',
];

export const SHRINK_ALARMS = [
  { bit: 0,  text: 'Acil stop' },
  { bit: 1,  text: 'Sıra iticisi hareket etmedi' },
  { bit: 2,  text: 'Grup iticisi hareket etmedi' },
  { bit: 3,  text: 'Sarma arızası (film koptu ya da çevrim bitmedi)' },
  { bit: 4,  text: 'Fırın fanı dönmüyor' },
  { bit: 5,  text: 'Fırın ısınmıyor' },
  { bit: 6,  text: 'Aşırı sıcaklık kesmesi attı' },
  { bit: 7,  text: 'Fırın bandı dönmüyor' },
  { bit: 8,  text: 'Paket fırında sıkıştı' },
  { bit: 9,  text: 'Altlık yerleştirilemedi' },
  { bit: 14, text: 'Plaka doluyken sıra itme isteği engellendi' },
  { bit: 10, text: 'Uyarı: çıkış tıkalı, fırında paket var (ısıtıcı kapatıldı)' },
  { bit: 11, text: 'Uyarı: film bobini azaldı' },
  { bit: 12, text: 'Uyarı: altlık magazini azaldı' },
  { bit: 13, text: 'Simülatör haberleşmesi kesildi' },
];

export const PAL_STATES = [
  'DURUYOR', 'ÇALIŞIYOR', 'BEKLİYOR: PAKET YOK', 'BEKLİYOR: PALET YOK', 'BEKLİYOR: ALIM NOKTASI DOLU',
  'PALET DEĞİŞİYOR', 'ALARM', 'GÜVENLİK DURDURMASI', 'ACİL STOP', 'DURUYOR (iş bitiriliyor)',
];

export const PAL_ALARMS = [
  { bit: 0,  text: 'Acil stop' },
  { bit: 1,  text: 'Güvenlik durdurması (kapı / ışık perdesi)' },
  { bit: 2,  text: 'Robot hatası / çarpışma (eve dönüş gerekli)' },
  { bit: 3,  text: 'Robot paketi düşürdü (vakum kaybı)' },
  { bit: 4,  text: 'Robot paketi alamadı' },
  { bit: 5,  text: 'Robot cevap vermiyor (iş zaman aşımı)' },
  { bit: 6,  text: 'Karton levha magazini boş' },
  { bit: 7,  text: 'Palet hattı sıkıştı (aktarma zaman aşımı)' },
  { bit: 8,  text: 'Streç film koptu' },
  { bit: 9,  text: 'Robot işi reddetti (bölge izni / geçersiz iş)' },
  { bit: 14, text: 'Palet defteri bilinmiyor' },
  { bit: 10, text: 'Uyarı: boş palet magazini bitti' },
  { bit: 11, text: 'Uyarı: palet eksik sarıldı' },
  { bit: 12, text: 'Uyarı: alım noktası dolu, hat bekliyor' },
  { bit: 13, text: 'Simülatör haberleşmesi kesildi' },
];

export const PAL_STATUS = ['Paket alabilir', 'Çalışıyor', 'Arıza', 'Paket bekliyor', 'Çıkış dolu', 'Güvenlik durdurması', 'Palet alınmaya hazır', 'Yeniden başladı, START bekliyor'];
export const ROBOT_JOBS = ['-', 'AL', 'BIRAK', 'LEVHA', 'EVE DÖN'];
export const ROBOT_RESULTS = { 0: '-', 1: 'tamam', 10: 'parça yok', 11: 'düşürdü', 12: 'reddedildi', 13: 'iptal',
  14: 'çarpışma', 15: 'levha yok', 16: 'bölge izni yok', 17: 'bırakıldı, sonra iptal' };

export const AGV_STATES = [
  'DURUYOR', 'TAŞIYOR', 'BEKLİYOR (iş yok)', 'ŞARJ OLUYOR', 'İSTASYON İZNİ BEKLİYOR', 'ENGEL: DURDU',
  'ALARM', 'ACİL STOP', 'DURUYOR (iş bitiriliyor)',
];
export const AGV_ALARMS = [
  { bit: 0,  text: 'Acil stop' },
  { bit: 2,  text: 'AGV araç hatası' },
  { bit: 3,  text: 'AGV alım noktasında palet bulamadı' },
  { bit: 5,  text: 'AGV cevap vermiyor (iş zaman aşımı)' },
  { bit: 6,  text: 'AGV çatal kaldırma arızası' },
  { bit: 7,  text: 'AGV bataryası kritik' },
  { bit: 8,  text: 'AGV işi reddetti' },
  { bit: 10, text: 'Uyarı: AGV yolunda engel' },
  { bit: 11, text: 'Uyarı: AGV bataryası düşük' },
  { bit: 12, text: 'Uyarı: AGV istasyon izni bekliyor' },
  { bit: 13, text: 'Simülatör haberleşmesi kesildi' },
];
export const AGV_STATUS = ['İş alabilir', 'Çalışıyor', 'Arıza', 'Boşta', 'Şarjda', 'Engel', 'Yüklü', 'Yeniden başladı, START bekliyor'];
export const AGV_ORDERS = ['-', 'TAŞI D→DEPO', 'DEPOYA BIRAK', 'ŞARJ', 'PARK'];
export const AGV_NODES = ['D_DOCK', 'D_PRE', 'EAST_N', 'EAST_S', 'IN_PRE', 'IN_DOCK', 'CHARGE', 'PARK'];

export const ASRS_STATES = [
  'DURUYOR', 'ÇALIŞIYOR', 'BEKLİYOR (iş yok)', 'ENVANTER SAYIMI', 'DEPO DOLU', 'ALARM', 'GÜVENLİK DURDURMASI',
  'ACİL STOP', 'DURUYOR (iş bitiriliyor)',
];
export const ASRS_ALARMS = [
  { bit: 0,  text: 'Acil stop' },
  { bit: 1,  text: 'Depo güvenlik durdurması (koridor kapısı)' },
  { bit: 2,  text: 'Vinç yürüme arızası (konum referansı gerekli)' },
  { bit: 3,  text: 'Vinç çatal arızası' },
  { bit: 4,  text: 'Göz dolu çıktı: çift depolama engellendi' },
  { bit: 5,  text: 'Göz ya da P&D boş çıktı' },
  { bit: 6,  text: 'Vinç cevap vermiyor (iş zaman aşımı)' },
  { bit: 7,  text: 'Palet reddedildi (kontur / etiket), operatör alsın' },
  { bit: 8,  text: 'Giriş konveyörü sıkıştı' },
  { bit: 9,  text: 'Vinç işi reddetti' },
  { bit: 10, text: 'Uyarı: depo sıcaklığı 6 °C üstünde' },
  { bit: 11, text: 'Uyarı: depo dolu' },
  { bit: 12, text: 'Uyarı: envanter sayımı sürüyor' },
  { bit: 13, text: 'Simülatör haberleşmesi kesildi' },
];
export const ASRS_STATUS = ['Palet alabilir', 'Çalışıyor', 'Arıza', 'Boşta', 'Depo dolu', 'Sayım', 'Sevkiyat bekliyor', 'Yeniden başladı, START bekliyor'];
export const CRANE_JOBS = ['-', 'DEPOLA', 'ÇIKAR', 'EVE DÖN', 'GÖZ KONTROL'];
export const CRANE_RESULTS = { 0: '-', 1: 'tamam', 10: 'yük yok', 11: 'göz/P&D dolu', 12: 'reddedildi', 13: 'iptal',
  14: 'yürüme arızası', 15: 'çatal arızası', 17: 'bıraktı, sonra iptal' };
export const AGV_RESULTS = { 0: '-', 1: 'tamam', 10: 'palet yok', 11: 'yük kayboldu', 12: 'reddedildi', 13: 'iptal',
  14: 'çatal arızası', 15: 'batarya kritik', 17: 'bıraktı, sonra iptal' };

// Blok 3 durum kelimesi bitleri (fabrika programı ve OEE için)
export const SHRINK_STATUS = ['Paket alabilir', 'Çalışıyor', 'Isınıyor', 'Boşaltıyor', 'Arıza', 'Çıkış tıkalı', 'Bardak bekliyor', 'Yeniden başladı, START bekliyor', 'Kesilen ürün karantinaya boşaltılıyor'];

export const ALARMS = [
  { bit: 0,  text: 'Acil stop' },
  { bit: 1,  text: 'Endeksleyici sıkıştı' },
  { bit: 2,  text: 'Dolum ağzı hareket etmedi' },
  { bit: 3,  text: 'Kapama kafası hareket etmedi' },
  { bit: 4,  text: 'Folyo magazini boş' },
  { bit: 5,  text: 'Isıtıcı ısınmıyor' },
  { bit: 6,  text: 'Red pistonu hareket etmedi' },
  { bit: 7,  text: 'Simülatör haberleşmesi kesildi' },
  { bit: 8,  text: 'Uyarı: bardak magazini boş' },
  { bit: 9,  text: 'Uyarı: ürün tankı alt seviyede' },
  { bit: 10, text: 'Uyarı: dolum zaman aşımı' },
  { bit: 11, text: 'Uyarı: çıkış bandı dolu' },
];

// Arayüzden eklenebilen arızalar.
export const FAULTS = {
  jam: 'Endeksleyici sıkışması',
  nozzleStuck: 'Dolum ağzı takılı',
  heaterFail: 'Isıtıcı rezistansı yanık',
  dropMiss: 'Bardak ayırıcı kaçırıyor (%35)',
  valveLeak: 'Dolum vanası damlatıyor',
  scaleDrift: 'Dolum terazisi kaymış (+8 g)',
  sealerStuck: 'Kapama kafası takılı',
  rejectStuck: 'Red pistonu takılı',
  outBlocked: 'Çıkış bandı tıkandı',
  pumpTrip: 'Transfer pompası motor koruması',
  flowmeterFail: 'Debimetre sıfır okuyor',
  vFillStuck: 'Dolum tankı vanası açık takıldı',
  vFillLeak: 'Dolum vanası contası kaçırıyor',
  causticHeaterFail: 'Kostik ısıtıcısı arızalı',
  prodEmpty: 'Üretim tankı boşaldı',
  filmBreak: 'Shrink filmi koptu',
  rowStuck: 'Sıra iticisi takılı',
  groupStuck: 'Grup iticisi takılı',
  fanFail: 'Fırın fanı arızalı',
  tunnelHeaterFail: 'Fırın ısıtıcısı arızalı',
  beltStall: 'Fırın bandı takıldı',
  exitBlocked: 'Paket durdurucuya ulaşmıyor (alma noktası tıkalı)',
  vacuumFail: 'Robot vakumu oluşmuyor',
  vacuumDrop: 'Robot vakum kaçağı: taşıdığı paketi düşürür (tek sefer)',
  robotCollision: 'Robot çarpışması (tek sefer)',
  palletJam: 'Palet konveyörü sıkıştı (B→C)',
  stretchBreak: 'Streç film koptu',
  agvObstacle: 'AGV yolunda insan / engel',
  agvLiftFault: 'AGV çatal kaldırma arızası (tek sefer)',
  agvBatteryLow: 'AGV bataryası %24\'e düşer (tek sefer)',
  contourFail: 'Sıradaki palet konturdan geçemez (tek sefer)',
  labelUnreadable: 'Sıradaki paletin etiketi okunamaz (tek sefer)',
  craneTravelFault: 'Vinç yürüme sürücüsü arızası (tek sefer)',
  forkFault: 'Vinç çatalı takılır (tek sefer)',
  inConvJam: 'Depo giriş konveyörü sıkıştı',
  coolingFail: 'Depo soğutması arızalı',
  commLoss: 'Modbus kablosu koptu',
};

// Proses sabitleri: hem simülatör hem PLC tarafı bunlara göre ayarlı.
export const SPEC = {
  pockets: 8,
  station: { drop: 0, fill: 2, foil: 3, seal: 4, check: 5, reject: 6 },
  targetNet: 206.0,   // g, 200 ml ayran (yoğunluk 1,03)
  tolerance: 4.0,     // g
  cupTare: 4.5,       // g
  foilMass: 0.4,      // g
  outfeedCapacity: 12, // çıkış bandında birikebilecek bardak
};

export const bitOf = (word, bit) => ((word >> bit) & 1) === 1;
export const packBits = (bits) => bits.reduce((w, b, i) => (b ? w | (1 << i) : w), 0);

// ---- PLC'ler (aşama 5) ----------------------------------------------------------------
// Fabrika tek PLC ile ya da üç PLC ile yönetilebilir. Her PLC simülatörün Modbus portunu tek bir
// FC4 okuma ve tek bir FC16 yazma aralığıyla yoklar; yazma aralıkları çakışmaz. Proses PLC'si
// blok 0'ın (fabrika özeti) da sahibidir. read/write: [başlangıç, adet] (simülatör adresi).
// OpenPLC v3'te %IW100 okuma aralığının, %QW100 yazma aralığının ilk register'ıdır.
// port: JS PLC'nin izleme için açtığı Modbus slave portu (OpenPLC'nin kendi slave'i 502).
export const PLCS = [
  { id: 'proses',    name: 'Proses PLC',    cells: ['dolum', 'tank'],  read: [0, 48],  write: [0, 48],  hb: 'FAB_QW_PLC_HB', port: 5031 },
  { id: 'paketleme', name: 'Paketleme PLC', cells: ['shrink', 'palet'], read: [0, 80], write: [48, 32], hb: 'SHR_QW_PLC_HB', port: 5032 },
  { id: 'lojistik',  name: 'Lojistik PLC',  cells: ['agv', 'asrs'],    read: [0, 112], write: [80, 32], hb: 'AGV_QW_PLC_HB', port: 5033 },
];
export const SINGLE_PLC = { id: 'tek', name: 'Tek PLC', cells: ['dolum', 'tank', 'shrink', 'palet', 'agv', 'asrs'],
  read: [0, 112], write: [0, 112], hb: 'FAB_QW_PLC_HB', port: 5030 };
export const PLC_SLAVE_BASE = 100;   // OpenPLC: %IW100 / %QW100 → slave'in input/holding register 100'ü

// Etiketin mutlak (simülatör) adresi
export const tagAddr = (tag) => {
  for (const c of CELLS) {
    const io = IO[c.id];
    const r = io && [...io.ir, ...io.hr].find((x) => x.tag === tag);
    if (r) return c.block * BLOCK + r.off;
  }
  throw new Error('etiket yok: ' + tag);
};

// ---- İzleme: OEE kategorileri ve hücre tanımları (aşama 5) ------------------------------
// Payda vardiya süresidir (takvim); yalnızca VERI_YOK düşülür. URETIM dışındaki her şey kayıptır.
export const OEE_CATEGORIES = {
  URETIM:     { label: 'Üretim',              color: '#2e9d57', loss: false },
  ARIZA:      { label: 'Arıza',               color: '#d64545', loss: true, own: true },
  GUVENLIK:   { label: 'Acil stop / güvenlik', color: '#9b3fbf', loss: true, own: true },
  HAZIRLIK:   { label: 'Hazırlık (ısınma, CIP, şarj, sayım)', color: '#e0a82e', loss: true, own: true },
  HIJYEN:     { label: 'Hijyen bekletmesi (CIP gerekli)', color: '#c77d2a', loss: true, own: true },
  DURDURULDU: { label: 'Operatör durdurdu',   color: '#7a8594', loss: true, own: true },
  AC:         { label: 'Aç (malzeme yok)',    color: '#4a90d9', loss: true, own: false },
  TIKALI:     { label: 'Tıkalı (çıkış dolu)', color: '#2bb3c0', loss: true, own: false },
  BOSTA:      { label: 'Boşta (talep yok)',   color: '#b9c2cc', loss: true, own: false },
  VERI_YOK:   { label: 'Veri yok (PLC bağlantısı yok)', color: '#333a44', loss: false },
};

// Sayaç türleri: wrap = modül (0..wrap-1 sarar), level = palet başına sıfırlanan seviye (artışlar sayılır)
// idealS: ideal çevrim (s/adet). oee: false → yalnızca kullanım oranı.
export const MON_CELLS = [
  { id: 'dolum', name: 'Dolum-kapama', plc: 'proses', oee: true, unit: 'bardak', idealS: 4.5, quality: true,
    state: 'DOL_QW_STATE', alarm: 'DOL_QW_ALARM', alarmsKey: 'ALARMS', statesKey: 'MODES',
    good: { tag: 'DOL_QW_GOOD', wrap: 30001 }, reject: { tag: 'DOL_QW_REJECT', wrap: 30001 },
    cat: ['DURDURULDU', 'URETIM', 'URETIM', 'ARIZA', 'GUVENLIK', 'HAZIRLIK', 'TIKALI', 'AC', 'AC'] },
  { id: 'tank', name: 'Tank ve CIP', plc: 'proses', oee: false, unit: '',
    state: 'TNK_QW_STATE', alarm: 'TNK_QW_ALARM', alarmsKey: 'TANK_ALARMS', statesKey: 'TANK_STATES',
    cat: ['BOSTA', 'URETIM', 'URETIM', 'URETIM', 'HAZIRLIK', 'HAZIRLIK', 'HAZIRLIK', 'HAZIRLIK', 'HAZIRLIK',
      'HIJYEN', 'ARIZA', 'GUVENLIK'] },
  { id: 'shrink', name: 'Shrink ve fırın', plc: 'paketleme', oee: true, unit: 'paket', idealS: 8.0, quality: false,
    state: 'SHR_QW_STATE', alarm: 'SHR_QW_ALARM', alarmsKey: 'SHRINK_ALARMS', statesKey: 'SHRINK_STATES',
    good: { tag: 'SHR_QW_GOOD', wrap: 30000 },
    reject: { tag: 'SHR_QW_REJECT', wrap: 30000 },
    cat: ['DURDURULDU', 'HAZIRLIK', 'URETIM', 'AC', 'TIKALI', 'DURDURULDU', 'DURDURULDU', 'AC', 'ARIZA', 'GUVENLIK'] },
  { id: 'palet', name: 'Paletleme', plc: 'paketleme', oee: true, unit: 'paket', idealS: 4.5, quality: false,
    state: 'PAL_QW_STATE', alarm: 'PAL_QW_ALARM', alarmsKey: 'PAL_ALARMS', statesKey: 'PAL_STATES',
    good: { tag: 'PAL_QW_COUNT', level: true },
    cat: ['DURDURULDU', 'URETIM', 'AC', 'AC', 'TIKALI', 'URETIM', 'ARIZA', 'GUVENLIK', 'GUVENLIK', 'DURDURULDU'] },
  { id: 'agv', name: 'AGV', plc: 'lojistik', oee: false, unit: 'taşıma',
    state: 'AGV_QW_STATE', alarm: 'AGV_QW_ALARM', alarmsKey: 'AGV_ALARMS', statesKey: 'AGV_STATES',
    good: { tag: 'AGV_QW_MOVES', wrap: 30001 },
    cat: ['DURDURULDU', 'URETIM', 'BOSTA', 'HAZIRLIK', 'AC', 'GUVENLIK', 'ARIZA', 'GUVENLIK', 'DURDURULDU'] },
  { id: 'asrs', name: 'Otomatik depo', plc: 'lojistik', oee: false, unit: 'palet',
    state: 'ASRS_QW_STATE', alarm: 'ASRS_QW_ALARM', alarmsKey: 'ASRS_ALARMS', statesKey: 'ASRS_STATES',
    good: { tag: 'ASRS_QW_STORED', wrap: 30001 },
    cat: ['DURDURULDU', 'URETIM', 'BOSTA', 'HAZIRLIK', 'TIKALI', 'ARIZA', 'GUVENLIK', 'GUVENLIK', 'DURDURULDU'] },
];
// CIP kaydı (tank bloğu): izleme CIP'i durumdan (4..8) çıkışta okur
export const MON_CIP = { states: [4, 5, 6, 7, 8], res: 'TNK_QW_CIP_RES', minT: 'TNK_QW_CIP_MINT',
  minF: 'TNK_QW_CIP_MINF', cond: 'TNK_QW_CIP_COND', dur: 'TNK_QW_CIP_DUR' };
