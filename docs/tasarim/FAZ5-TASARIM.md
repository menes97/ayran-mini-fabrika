# Aşama 5 tasarım taslağı: fabrika izleme katmanı

Durum: inceleme öncesi taslak (4 Kasım 2026). Kod tabanı: `ayran-dolum-sim` (aşama 0–4 bitti, harita sürümü 4, 7 blok × 16 register, 46 test).

## 0. Amaç ve kapsam

Fabrikanın üstüne, gerçek bir tesisteki SCADA/MES katmanına benzeyen bir **izleme servisi** eklemek:

1. **İzlenebilirlik:** palet → paket → bardak → dolum → aktarım (transfer) → üretim tankı partisi → son CIP. Ayrıca depodaki göz ve sevkiyat.
2. **OEE:** hücre başına kullanılabilirlik × performans × kalite, duruş nedenleriyle birlikte. Mikro duruşlar ve vardiya raporu.
3. **Alarm geçmişi:** her alarm bitinin açılma/kapanma zamanı, süre, Pareto.
4. **Gösterge paneli:** OEE, duruş dağılımı, alarm Pareto'su, üretim sayaçları, palet izleme ekranı.
5. **Mimari:** fabrikayı 3 PLC'ye bölmek (proses / paketleme / lojistik), tek PLC modunu da korumak.

Kapsam dışı: kullanıcı yönetimi, ERP, reçete yönetimi, gerçek SSCC/GS1 etiket formatı (yalnızca biçimi taklit edilir).

## 1. Veri nereden okunacak: ikisi, ama görev ayrımıyla

Karar: **iki kaynak, her biri gerçekte karşılığı olan bir şey için.**

| Veri | Kaynak | Gerçek tesisteki karşılığı |
|---|---|---|
| Hücre durumu (STATE), alarm kelimeleri, durum bitleri, üretim sayaçları, CIP kaydı, depo sayaçları | **PLC register'ları** (Modbus TCP, PLC'nin kendi slave portu) | SCADA/historian PLC'yi yoklar |
| Kimlikli ürün hareketleri: bardak dolumu ve kontrol tartısı sonucu, paket oluşumu, robotun paketi hangi palete/slota koyduğu, palet bitişi, depo girişi, göz, sevkiyat | **Simülatörün olay akışı** (`/api/events`) | Hat takip sistemi / "edge" cihazları: kontrol tartısının seri çıkışı, etiket yazıcısı, palet etiket okuyucusu, robot kontrolcüsü, WMS |

Neden PLC tek başına yetmez: PLC bardak kimliği tutmaz (yalnızca cep başına "bardak var / hatalı" biti), paket ve bardak eşleşmesini hiç bilmez. 16 register'lık bloklara olay kuyruğu koymak (FIFO register'ları, el sıkışmalı olay okuma) mümkün ama 0,5 s'lik OpenPLC gidiş-dönüşünde bardak hızında (4 s) olay kaybetmeden yapmak zor ve eğitim açısından odağı kaydırır.

Neden simülatör tek başına yetmez: OEE ve alarm geçmişi, PLC'nin **ne gördüğünü ve neye karar verdiğini** yansıtmalı. Simülatörün gizli "gerçek" durumunu (kir skoru, gizli dolum hatası) izleme verisine katmak, izleme sistemine sahada olmayan bir bilgi vermek olur.

Kural: **izleme veritabanına yalnızca sahada ölçülebilen bilgi girer.** Simülatörün gizli gerçeği (`sim_defect`) ayrı bir sütunda ve "yalnızca simülasyon" etiketiyle saklanır; panelde gri, raporlarda hiç kullanılmaz. Testler bu sütunla izleme sisteminin kaçırdığını ölçer.

### 1.1 PLC'den okuma

- İzleme servisi, gerçek bir SCADA gibi **her PLC'nin kendi Modbus slave portunu** yoklar (OpenPLC v3: TCP 502, `%IW` → input register, `%QW` → holding register, adresler aynı). JS PLC'ye de aynı eşlemeyle küçük bir Modbus slave eklenir.
- Yedek mod `--source sim`: simülatörün Modbus portundan PLC'lerin yazdığı holding register'ları okur (tek bağlantı, WSL'de port yönlendirmesi sorun çıkarırsa).
- Yoklama 500 ms. Durumlar ve sayaçlar her örnekte işlenir; değişmeyen değer yazılmaz (olay temelli kayıt).
- PLC'ye ulaşılamazsa o PLC'nin hücreleri için **"VERİ YOK"** aralığı açılır. Bu süre OEE'de ne duruş ne çalışma sayılır, payda dışıdır ve raporda ayrıca gösterilir.

### 1.2 Simülatörün olay akışı

- Simülatör, artan sıra numaralı bir halka tampon tutar (20 000 olay). `GET /api/events?after=<seq>` → `{ run, first, last, events: [...] }`.
- `run`: simülatörün her açılışında yeni bir kimlik. Kimlik değişirse izleme servisi imleci sıfırlar; kayıtlar `(run, id)` ile tutulduğu için yeniden başlayan bardak numaraları çakışmaz.
- `after < first` ise arada olay kaybolmuştur: `ingest_gap` kaydı yazılır, panelde uyarı çıkar.
- En az bir kez teslim: aynı olay iki kez gelirse `UNIQUE` kısıtları ve `INSERT OR IGNORE` ile etkisiz kalır.
- Zaman: olaylarda simülatör saati (`t`, s) ve duvar saati (`ts`, ms). Testlerde `ts = t × 1000`.

Olay türleri:

| Olay | Alanlar | Kaynağın gerçek karşılığı |
|---|---|---|
| `lot` | lot, kg | Üretim tankına yeni parti girişi (tank doldurma) |
| `transfer_start` / `transfer_end` | transfer, lot, kg | Dolum tankına ürün akışının başlayıp bitmesi (debimetre + vana) |
| `cup` | cup, tFill, netG (kontrol tartısından), sealC (kapama anındaki kafa sıcaklığı), result `out`/`reject`/`lost`, transfers [{id, frac}], simDefect | Kontrol tartısı + red istasyonu + konumsal takip |
| `pack` | pack, cups[], pad, test | Paket oluşumu (grup iticisi) |
| `pack_out` | pack, filmPeak, simDefect | Fırın çıkışı |
| `place` | pallet, slot, pack, code (1 / 17) | Robot kontrolcüsü: "şu paketi şu slota bıraktım" |
| `pack_drop` | pack | Robot vakum kaybı: paket hücreye düştü |
| `pallet_start` / `pallet_done` | pallet, packs, turns, sheets, simDefect | Palet besleyici / streç makinesi + palet etiketi |
| `asrs_check` | pallet, contourOk, readOk | Depo giriş kontrolü |
| `store` / `pick` | pallet, loc | Vinç kontrolcüsü |
| `reject_pallet` | pallet | Operatör ret paletini aldı |
| `ship` | pallet, order | Kamyona yükleme (sipariş numarasıyla) |

Dolum tankındaki karışım: simülatör dolum tankının içeriğini **aktarım numarasına göre** de izler (tam karışmış tank: her çekişte her aktarımdan payı oranında eksilir). Bardak olayında payı %0,5'ten büyük aktarımlar listelenir. Bu, süt sektöründeki "tampon tankta hangi partiler var" muhafazakâr izleme kuralının basit bir karşılığı.

Gerçekçilik notu (README'ye de yazılacak): gerçek bir ayran hattında bardaklar tek tek seri numaralı değildir. Bardak düzeyi izleme ancak konumsal takiple (sabit sıralı bant + sayaç) ve paket etiketiyle yapılır. Simülatör kimlikleri bildiği için bu katman "dijital ikiz" düzeyinde tutuluyor. Paket etiketinden geriye doğru sorgu (paket → bardak aralığı → dolum zamanı → aktarım → CIP) gerçekte de mümkündür; tek tek bardak ağırlığı ise kontrol tartısı kayıtlarından zaman damgasıyla eşleşir.

## 2. SQLite şeması

Node 24'ün yerleşik `node:sqlite` (`DatabaseSync`) modülü; ek bağımlılık yok. WAL modu, tek yazar (izleme servisi). Testlerde `:memory:`.

```sql
CREATE TABLE meta      (key TEXT PRIMARY KEY, value TEXT);          -- şema sürümü, harita sürümü
CREATE TABLE ingest    (source TEXT PRIMARY KEY, run TEXT, last_seq INTEGER);
CREATE TABLE ingest_gap(id INTEGER PRIMARY KEY, source TEXT, run TEXT, from_seq INTEGER, to_seq INTEGER, ts INTEGER);

-- ---------- izlenebilirlik (olay akışından) ----------
CREATE TABLE lot      (run TEXT, lot INTEGER, ts INTEGER, kg REAL, PRIMARY KEY (run, lot));
CREATE TABLE transfer (run TEXT, transfer INTEGER, lot INTEGER, ts_start INTEGER, ts_end INTEGER, kg REAL,
                       cip_id INTEGER REFERENCES cip(cip_id),       -- aktarım başladığında geçerli son başarılı CIP
                       PRIMARY KEY (run, transfer));
CREATE TABLE cup      (run TEXT, cup INTEGER, ts_fill INTEGER, ts_done INTEGER, net_g REAL, seal_c REAL,
                       result TEXT CHECK (result IN ('out','reject','lost')), pack INTEGER,
                       sim_defect TEXT, PRIMARY KEY (run, cup));
CREATE TABLE cup_transfer (run TEXT, cup INTEGER, transfer INTEGER, frac REAL, PRIMARY KEY (run, cup, transfer));
CREATE TABLE pack     (run TEXT, pack INTEGER, ts_formed INTEGER, ts_out INTEGER, n_cups INTEGER, pad INTEGER,
                       pallet INTEGER, slot INTEGER, ts_placed INTEGER, dropped INTEGER DEFAULT 0,
                       is_test INTEGER DEFAULT 0, sim_defect TEXT, PRIMARY KEY (run, pack));
CREATE TABLE pallet   (run TEXT, pallet INTEGER, label TEXT UNIQUE, ts_start INTEGER, ts_done INTEGER, packs INTEGER,
                       turns REAL, status TEXT,                     -- istifte / bitti / depoda / sevkte / sevk edildi / reddedildi
                       loc INTEGER, ts_stored INTEGER, ts_picked INTEGER, ts_shipped INTEGER, ship_order INTEGER,
                       sim_defect TEXT, PRIMARY KEY (run, pallet));

-- ---------- PLC tarafı (yoklamadan) ----------
CREATE TABLE cip (cip_id INTEGER PRIMARY KEY, run TEXT, ts_start INTEGER, ts_end INTEGER,
                  result INTEGER, min_temp REAL, min_flow REAL, final_cond REAL, duration_s INTEGER);
CREATE TABLE state_interval (id INTEGER PRIMARY KEY, plc TEXT, cell TEXT, state INTEGER, category TEXT,
                  ts_start INTEGER, ts_end INTEGER);                -- açık aralıkta ts_end NULL
CREATE INDEX si_cell_time ON state_interval (cell, ts_start);
CREATE TABLE alarm_event (id INTEGER PRIMARY KEY, cell TEXT, bit INTEGER, text TEXT, severity TEXT,  -- alarm / uyari
                  ts_on INTEGER, ts_off INTEGER);
CREATE INDEX ae_time ON alarm_event (ts_on);
CREATE TABLE production (cell TEXT, minute INTEGER, good INTEGER, reject INTEGER, PRIMARY KEY (cell, minute));
CREATE TABLE micro_stop (id INTEGER PRIMARY KEY, cell TEXT, ts_start INTEGER, dur_ms INTEGER);
CREATE TABLE comm_gap   (id INTEGER PRIMARY KEY, plc TEXT, ts_start INTEGER, ts_end INTEGER);
```

Notlar:

- **Sayaçlar:** PLC sayaçları (örn. `DOL_QW_GOOD`) 30000'de sıfırlanır ve PLC yeniden başlarsa sıfırdan başlar. Fark `d = yeni − eski`; `d < 0` ise önce 30000 sarmasını dene (`eski > 29000 ve yeni < 1000`), değilse PLC yeniden başlamış say ve `d = yeni`. Dakika kovasına yazılır.
- **Alarm olayları:** her alarm kelimesinin bit bazında yükselen ve düşen kenarı. Metinler `iomap.js`'den (tek kaynak); "Uyarı:" ile başlayanlar `uyari`. Haberleşme alarmı (bit 13/7) ve PLC'ye ulaşılamaması ayrı tutulur.
- **Saklama:** demo için sınırsız; `state_interval` ve `alarm_event` olay temelli olduğu için küçük kalır. `production` dakikalık.
- **Saat:** tüm zamanlar ms (duvar saati). Testte simülatör saati × 1000.

## 3. İzlenebilirlik sorguları

Hepsi `GET /api/trace/...` uç noktası ve panelde "Palet izleme" ekranı.

**3.1 Palet etiketinden geriye (palet → paket → bardak → aktarım → CIP):**

```sql
SELECT p.pallet, k.slot, k.pack, c.cup, c.net_g, c.seal_c, ct.transfer, t.lot, t.cip_id, x.ts_end AS cip_ts
FROM pallet p
JOIN pack k          ON k.run = p.run AND k.pallet = p.pallet AND k.dropped = 0
JOIN cup c           ON c.run = k.run AND c.pack = k.pack
LEFT JOIN cup_transfer ct ON ct.run = c.run AND ct.cup = c.cup
LEFT JOIN transfer t ON t.run = ct.run AND t.transfer = ct.transfer
LEFT JOIN cip x      ON x.cip_id = t.cip_id
WHERE p.label = ?
ORDER BY k.slot, c.cup;
```

**3.2 "Bu palette hangi CIP'ten sonraki ürün var?"** Aynı birleştirmeden `DISTINCT t.cip_id` ve CIP sonucu. Paletteki ürün iki CIP döneminden geliyorsa iki satır döner (CIP sırasında dolum makinesi tamponundan ürettiği için bu olağan).

**3.3 İleri yönde (geri çağırma):** "CIP #7 başarısızdı / lot 3 şüpheli: hangi paletler etkilendi, nerede?"

```sql
SELECT DISTINCT p.label, p.status, p.loc, p.ship_order
FROM transfer t
JOIN cup_transfer ct ON ct.run = t.run AND ct.transfer = t.transfer AND ct.frac >= 0.005
JOIN cup c  ON c.run = ct.run AND c.cup = ct.cup AND c.result = 'out'
JOIN pack k ON k.run = c.run AND k.pack = c.pack
JOIN pallet p ON p.run = k.run AND p.pallet = k.pallet
WHERE t.cip_id = ?   -- ya da t.lot = ?
```

**3.4 Kalite izleme:** bir paletin bardaklarının net dolum dağılımı (min/ort/max, toleransa yakınlık) ve kapama sıcaklığı.

**3.5 Uzlaştırma (izleme sisteminin kendi doğruluğu):** her vardiyada PLC sayacı (`DOL_QW_GOOD`) ile `cup.result='out'` sayısı, `PAL_QW_DONE` ile `pallet_done` olayı, `ASRS_QW_STORED` ile `store` olayı karşılaştırılır. Fark panelde gösterilir; testlerde 0 olmalı.

## 4. OEE

### 4.1 Hangi hücreler

- **Dolum (darboğaz):** hat OEE'si budur. İdeal çevrim 4,0 s/bardak (15 bardak/dk).
- **Shrink:** ideal 24 s/paket (6 bardak × 4 s; kendi makine kapasitesi daha yüksek ama besleme bu).
  - Seçenek: ideal çevrim makine kapasitesi (sarma + itme ≈ 8 s) alınırsa performans hep düşük çıkar; darboğazın hızı alınırsa "aç" kaybı ayrı görünür. Taslak: **makine kapasitesi** (gerçek OEE tanımı), aç kalma kullanılabilirlik kaybı olarak "dış kaynaklı" etiketiyle.
- **Paletleme:** birim paket; ideal 3,8 s/paket (robot al-bırak). Palet değişimi duruş değil, performans kaybıdır.
- **Tank, AGV, depo:** OEE anlamlı değil (proses ve lojistik). Bunlar için **kullanım oranı** (çalışma süresi / planlı süre), iş sayısı ve CIP süresi gösterilir.

### 4.2 Durum → kategori eşlemesi

Eşleme tablosu `iomap.js`'de (tek kaynak), izleme servisi ve panel aynı tabloyu kullanır.

| Kategori | Anlam | OEE'de |
|---|---|---|
| `URETIM` | Çalışıyor | çalışma süresi |
| `ARIZA` | Alarm | kullanılabilirlik kaybı (kendi kaynaklı) |
| `GUVENLIK` | Acil stop, güvenlik durdurması | kullanılabilirlik kaybı |
| `HAZIRLIK` | Isınma, boşaltma, soğutma, CIP | kullanılabilirlik kaybı (ayar/hazırlık) |
| `AC` | Malzeme / ürün / paket yok (starved) | kullanılabilirlik kaybı, **dış kaynaklı** |
| `TIKALI` | Çıkış dolu (blocked) | kullanılabilirlik kaybı, **dış kaynaklı** |
| `PLANLI` | Operatör durdurdu, enerji tasarrufu, çevrim sonu duruşu | planlı süreden düşülür |
| `VERI_YOK` | PLC'ye ulaşılamıyor | paydadan düşülür, ayrıca raporlanır |

Hücre eşlemesi (mevcut durum kodları):

- Dolum `DOL_QW_STATE`: 0 PLANLI, 1 URETIM, 2 URETIM (çevrim sonuna kadar), 3 ARIZA, 4 GUVENLIK, 5 HAZIRLIK, 6 TIKALI, **yeni 7 AC (ürün yok), yeni 8 AC (bardak yok)**.
- Shrink `SHR_QW_STATE`: 0 PLANLI, 1 HAZIRLIK, 2 URETIM, 3 AC, 4 TIKALI, 5–6 HAZIRLIK, 7 PLANLI, 8 ARIZA, 9 GUVENLIK.
- Paletleme `PAL_QW_STATE`: 0 PLANLI, 1 URETIM, 2 AC (paket yok), 3 AC (palet yok), 4 TIKALI, 5 URETIM (palet değişimi), 6 ARIZA, 7 GUVENLIK, 8 GUVENLIK, 9 URETIM.
- Tank `TNK_QW_STATE`: 0 PLANLI (bekleme), 1–3 URETIM, 4–8 HAZIRLIK (CIP), 9 AC (CIP gerekli → beklemede), 10 ARIZA, 11 GUVENLIK.
- AGV, depo: benzer tablolar.

PLC değişikliği (küçük): `FB_Dolum` şu an tank alt seviyedeyken ve bardak magazini boşken `QW_STATE = 1` yayınlıyor; izleme bu süreyi "çalışıyor ama üretmiyor" görür. PLC'nin bildiği bekleme nedeni `QW_STATE` 7 ve 8 olarak yayınlanacak (hem ST hem JS karşılığı). Harita sürümü 5'e çıkar.

### 4.3 Hesap

Bir hücre ve [t0, t1) aralığı için (vardiya ya da son 1 saat):

- `planli_sure = (t1 − t0) − PLANLI − VERI_YOK`
- `calisma = URETIM`
- `Kullanılabilirlik = calisma / planli_sure`
- `Performans = (toplam_adet × ideal_cevrim) / calisma`, 1'i aşarsa 1'e kırpılır ve "ideal çevrim yanlış" uyarısı çıkar.
- `Kalite = sağlam / toplam` (yalnızca PLC'nin ölçtüğü red; dolumda `DOL_QW_REJECT`). Shrink ve paletlemede red mekanizması yok: kalite "ölçülmüyor" diye gösterilir, OEE'ye 1 olarak girer.
- `OEE = K × P × Q`. Ayrıca kayıp ağacı: her kategorinin süresi ve "kayıp adet" karşılığı (`süre / ideal_cevrim`).

Mikro duruşlar: hücre `URETIM` durumundayken sayaç `2 × ideal_cevrim`'den uzun süre artmazsa, artış gelince `micro_stop` kaydı (≤ 60 s; daha uzunsa "kayıt dışı duruş" olarak işaretlenir). Mikro duruşlar performans kaybının bir alt kalemidir, kullanılabilirliği etkilemez.

### 4.4 Vardiya

Vardiyalar yapılandırılabilir; varsayılan 3 × 8 saat (06–14, 14–22, 22–06). Demo için `SHIFT_MIN=15` gibi kısa vardiyalar. Vardiya raporu (`/api/report?shift=...`, panelde yazdırılabilir sayfa): hücre başına OEE ve kayıp ağacı, üretim (bardak, paket, palet), ilk 5 alarm (adet ve süre), CIP'ler, depolanan ve sevk edilen paletler, uzlaştırma farkları, veri kayıpları.

## 5. Gösterge paneli

Ayrı bir HTTP sunucusu (izleme servisi, varsayılan port 8081), statik sayfa + JSON API. Harici kütüphane yok (SVG ile çizim), çevrimdışı çalışır. 3B arayüzün paneline "İzleme" bağlantısı.

Sekmeler:

1. **Genel bakış:** hat OEE göstergesi (dolum), hücre kartları (OEE, K/P/Q, şu anki durum ve ne zamandır), son 1 saatin durum zaman çizelgesi (hücre başına renkli şerit), üretim sayaçları (bardak, paket, palet, depoda, sevk).
2. **Duruşlar:** kategori dağılımı (yığılmış çubuk), mikro duruş sayısı/süresi, en uzun 10 duruş.
3. **Alarmlar:** aktif alarmlar, geçmiş liste (filtre: hücre, önem), Pareto (adet ve toplam süre, %80 çizgisi).
4. **Palet izleme:** etiket ara → palet kartı (durum, göz, sevkiyat) → slot ızgarası (3 kat × 6) → pakete tıklayınca bardaklar (net dolum, kapama sıcaklığı, aktarım, lot, CIP sonucu). Ters yön: CIP ya da lot seç → etkilenen paletler.
5. **Vardiya raporu.**

Yenileme: 2 s'de bir JSON yoklama (WebSocket gerekmez).

## 6. Fabrikayı 3 PLC'ye bölmek

### 6.1 Karar

**Üç PLC + tek PLC modu korunur.** Kapasite gerekçesi yok (tek OpenPLC 20 ms taramada rahat), gerekçe gerçekçilik ve eğitim:

- Hücre başına PLC, izleme katmanının birden fazla kaynağı birleştirmesini anlamlı kılar.
- PLC'ler arası el sıkışma, bir PLC durunca diğerlerinin aç/tıkalı kalıp zarar görmeden beklemesi gösterilebilir.

| PLC | Bloklar | Okuma (FC4) | Yazma (FC16) | Kalp atışı |
|---|---|---|---|---|
| **Proses** | 1 dolum, 2 tank | IR 0–47 (48) | HR 16–47 (32) | `DOL_QW_PLC_HB` (HR 31) |
| **Paketleme** | 3 shrink, 4 paletleme | IR 0–79 (80) | HR 48–79 (32) | `SHR_QW_PLC_HB` (HR 63) |
| **Lojistik** | 5 AGV, 6 depo | IR 0–111 (112) | HR 80–111 (32) | `AGV_QW_PLC_HB` (HR 95) |
| Tek PLC (bugünkü) | hepsi | IR 0–111 | HR 0–111 | üçü de + `FAB_QW_PLC_HB` |

- Her PLC okuma aralığının başında blok 0'ı (panel, acil stop, harita sürümü, simülatör kalp atışı) okur; okuma aralıkları bitişik olduğu için gerekmeyen blokları da okur (zararsız; OpenPLC slave cihazı tek aralık okur).
- Yazma aralıkları çakışmaz. Blok 0'ın holding register'ları yalnızca tek PLC modunda yazılır.
- Simülatörün PLC bekçisi PLC başına olur: bir PLC'nin kalp atışı 1,5 s değişmezse **yalnızca o PLC'nin bloklarının** çıkışları düşer.

### 6.2 PLC'ler arası sinyaller

Bugün PLC içinde iki FB arasında geçen sinyallerden yalnızca ikisi PLC sınırını aşıyor (paketleme ↔ lojistik):

| Sinyal | Bugün | Bölünmüş | Gerçek karşılığı |
|---|---|---|---|
| Paletleme → AGV: "alım noktasında palet hazır" | `PALLET.PICKUP_RDY` → `AGV.D_READY` | Paketleme PLC'sinin `PAL_QW_DO` bit 11 çıkışı, simülatörde kabloyla lojistik PLC'nin yeni `AGV_IW_IL` (IR 88) bit 0 girişine | İstasyon ile AGV kontrolü arasında sert kablolu el sıkışma |
| AGV → paletleme: "çatallar alım noktasının dışında" | `AGV_IW_DI` bit 6 (AGV aracının durumu) | AGV aracının istasyona verdiği optik sinyal: yeni `PAL_IW_IL` (IR 74) bit 0 | AGV ile istasyon arasında optik I/O (E84 tarzı PIO) |

- Tank ↔ dolum (`PRODUCT_REQ`) ve AGV ↔ depo (`IN_READY`, `AGV_CLEAR_IN`) aynı PLC'de kalır.
- "Kablo" simülatörde: kaynak PLC'nin bekçisi düşerse kablo 0 okur (çıkış kartı enerjisiz).
- Tek PLC modunda da aynı kablolar kullanılır, böylece iki modda program aynıdır. Bedeli bir yoklama gecikmesi (≤ 200 ms); el sıkışma zaten tutulan izinlerle çalıştığı için sorun beklenmiyor, testle doğrulanacak.
- Ortak start/stop/acil stop/reset: blok 0'dan her PLC kendisi okur (gerçekte panel butonları her PLC'ye ayrı kontakla gider, acil stop zinciri güvenlik rölesinden her PLC'ye bilgi olarak gelir).

### 6.3 ST tarafı

- `Fabrika.st` üç parçaya ayrılır: `Ortak.st` (panel, haberleşme bekçisi, kalp atışı), `Proses.st`, `Paketleme.st`, `Lojistik.st` (gövde + kendi VAR bölümü).
- `tools/gen-plc.js` dört dosya üretir: `fabrika.st` (tek PLC: Ortak + üçü, tek PROGRAM), `proses.st`, `paketleme.st`, `lojistik.st` (Ortak + biri). Her dosyanın `AT %IW/%QW` adresleri kendi okuma/yazma başlangıcına göre hesaplanır (OpenPLC slave cihazı `%QW100`'ü yazma aralığının ilk register'ına eşler).
  - Neden tek PROGRAM içinde birleştirme, üç PROGRAM örneği değil: üç program aynı located değişkeni (blok 0) bildirirse matiec/OpenPLC'nin `glueVars` aşamasında çakışma riski var; VAR_GLOBAL + VAR_EXTERNAL OpenPLC v3'te denenmedi.
- JS karşılığı: `plc/fabrika.js` → `plc/ortak.js`, `plc/proses.js`, `plc/paketleme.js`, `plc/lojistik.js`; `Fabrika` sınıfı tek PLC modunda üçünü sırayla çağırır.
- `run_ayran.sh` yeni parametre `ROLE=tek|proses|paketleme|lojistik` ile doğru dosyayı ve slave aralıklarını yazar.
- Gerçek OpenPLC denemesi: WSL'de tek OpenPLC çalışabildiği için **karma mod**: paketleme PLC'si OpenPLC'de, proses ve lojistik JS PLC'de (`node plc/js-plc.js --role proses` ...). Ayrıca tek PLC modunun da OpenPLC'de derlenip çalıştığı doğrulanır.

### 6.4 Harita sürümü 5

- `MAP_VERSION = 5`; yeni register'lar: `DOL_QW_PLC_HB` (HR 31), `SHR_QW_PLC_HB` (HR 63), `AGV_QW_PLC_HB` (HR 95), `PAL_IW_IL` (IR 74), `AGV_IW_IL` (IR 88). Dolum durumları 7–8.
- `PLCS` tablosu iomap'e eklenir (ad, bloklar, okuma/yazma aralıkları, kalp atışı adresi); simülatör bekçisi, gen-plc, js-plc, izleme servisi ve testler aynı tabloyu kullanır.

## 7. Dosyalar

```
public/iomap.js            + PLCS, OEE_CATEGORIES, STATE_CATEGORY, IDEAL_CYCLE, yeni register'lar
server/trace.js            olay halka tamponu (seq, run), /api/events
server/cells/*.js          olay üretimi (lot, transfer, cup, pack, place, pallet, asrs)
server/factory.js          PLC başına bekçi, PLC'ler arası kablolar
plc/src/Ortak.st, Proses.st, Paketleme.st, Lojistik.st
plc/ortak.js, proses.js, paketleme.js, lojistik.js, fabrika.js (tek PLC)
plc/js-plc.js              --role, Modbus slave (izleme için, OpenPLC eşlemesiyle)
monitor/db.js              şema, göç, sorgular
monitor/collector.js       PLC yoklama → state_interval, alarm_event, production, micro_stop, cip
monitor/ingest.js          olay akışı → izlenebilirlik tabloları
monitor/oee.js             OEE ve kayıp ağacı hesabı, vardiya raporu
monitor/server.js          HTTP API + statik panel (port 8081)
monitor/public/            panel (index.html, panel.js, panel.css)
test/smoke.js              + yeni senaryolar
test/monitor.js            izleme birim testleri (sayaç sarması, idempotent ingest, OEE matematiği)
```

## 8. Testler (yeni senaryolar)

Uçtan uca (simülatör + PLC'ler + izleme aynı süreçte, hızlandırılmış):

1. **İzleme: normal üretim, tek PLC.** Uzlaştırma farkı 0; her sevk bardağının paketi, her paketin paleti var; palet → bardak sorgusu simülatördeki gerçek palet slotlarıyla birebir.
2. **İzleme: üç PLC, normal üretim.** Aynı üretim; PLC'ler arası kablolarla AGV paleti alır.
3. **Üç PLC: paketleme PLC'si durur.** Yalnızca blok 3–4 çıkışları düşer; dolum "TIKALI", AGV "iş yok"; izleme paketleme için VERI_YOK, dolum için TIKALI kaydeder; PLC dönünce üretim sürer, defterler bozulmaz.
4. **OEE: ısıtıcı arızası.** Arıza süresi ±1 s ile ARIZA kategorisinde; alarm olayı açılma/kapanma zamanlarıyla; K < 1, P ve Q makul.
5. **OEE: ürün tankı boşalır.** Dolum durum 7 (AC); kayıp "dış kaynaklı".
6. **OEE: bardak ayırıcı kaçırıyor.** Mikro duruş yok ama performans düşer (boş cep), kalite 1'e yakın.
7. **CIP izleme:** üretim sırasında CIP; CIP kaydı izleme DB'sinde PLC değerleriyle aynı; CIP'ten önce ve sonra aktarılan ürünün paletleri doğru CIP numarasıyla sorgulanır.
8. **Geri çağırma:** başarısız CIP (kostik ısıtıcısı arızalı) → ileri sorgu etkilenen paletleri ve gözlerini verir (CIP gerekli olduğu için aktarım yoksa liste boş, bu da doğrulanır).
9. **Alarm Pareto:** üç farklı arıza (2×, 1×, 1×) → Pareto sırası ve süreler doğru.
10. **Olay akışı kopması:** izleme 30 s olay okumaz, halka tampon taşar → `ingest_gap` kaydı; tekrar oynatılan olaylar kopya üretmez.
11. **Sayaç sarması ve PLC yeniden başlaması:** birim test.
12. **Haberleşme kopması:** VERI_YOK, OEE paydasından düşülür.

Mevcut 46 senaryo tek PLC modunda değişmeden geçmeli (PLC'ler arası kablolar eklenince de).

## 9. Açık sorular (inceleme için)

1. Veri kaynağı ayrımı doğru mu? Olay akışı yerine PLC'ye olay FIFO'su koymak eğitim açısından daha mı değerli?
2. OEE: shrink ve paletleme için ideal çevrim makine kapasitesi mi, darboğaz hızı mı? "Aç/tıkalı" kullanılabilirlik kaybı mı sayılmalı?
3. Planlı duruş tanımı: operatörün STOP'u planlı mı? (Taslak: evet.)
4. 3 PLC bölünmesi doğru sınırdan mı (proses / paketleme / lojistik)? Kabloları tek PLC modunda da kullanmak doğru mu?
5. İzleme servisinin PLC'yi doğrudan (502) okuması mı, simülatörün I/O görüntüsünü okuması mı varsayılan olmalı?
6. Şemada eksik ya da fazla bir şey var mı? `(run, id)` bileşik anahtarı mantıklı mı?
7. Bardak düzeyi izlenebilirliği "dijital ikiz" olarak açıkça etiketlemek yeterli mi, yoksa konumsal takiple (FIFO çıkarımı) mi yapılmalı?

## 10. İnceleme sonrası kararlar (4 Kasım 2026)

Codex (gpt-6.1-sol) kullanım limitine takıldı (7 Kasım'a kadar); inceleme yalnızca DeepSeek v4.1'den geldi (tam metin: `FAZ5-INCELEME-DEEPSEEK.md`). Kabul edilen ve reddedilen öneriler:

| # | Öneri | Karar |
|---|---|---|
| R1 | Olay saati duvar saati olmalı | Kabul (zaten düzeltildi: `new Factory({ wallBase: Date.now() })`). Testlerde ikisi de simülasyon saati. |
| R2 | Sayaçlar tutarsız: dolum INT taşıyor, shrink 30000'de doyuyor, diğerleri sarıyor | Kabul. PLC'de bütün sayaçlar 0..30000 sarar. İzleme sayaç durumunu (`counter_state`) DB'de tutar; `yeni < eski` iken fark 15000'den büyükse sarma, değilse PLC yeniden başladı (`counter_reset` kaydı). Paletleme adedi `PAL_QW_COUNT`'tan (palet başına sıfırlanan seviye) türetilir. |
| R3 | Planlı süre durumdan değil takvimden gelmeli; operatör STOP'u ve otomatik bekleme (shrink enerji tasarrufu) planlı sayılmamalı | Kabul. Payda = vardiya süresi − VERI_YOK. `PLANLI` kategorisi kaldırıldı; yerine `DURDURULDU` (operatör) kullanılabilirlik kaybıdır. Shrink 7 (enerji tasarrufu) → `AC`. Mola tanımı demo dışı. |
| R4 | Ölçülmeyen kalite 1 sayılmaz | Kabul. Shrink ve paletlemede Q "ölçülmüyor"; OEE "A × P (Q yok)" diye gösterilir. |
| R5 | Uzlaştırma aynı sayım noktasından | Kabul. PLC `GOOD` sayacı red istasyonundan geçen sağlam bardak; karşılığı `cup.result IN ('out','lost')` olayları. |
| R6 | Bekçi PLC başına; blok 0'ın sahibi | Kabul. Proses PLC'si blok 0'ın sahibi (yazma HR 0–47, kalp atışı `FAB_QW_PLC_HB`). `DOL_QW_PLC_HB` gerekmedi. Paketleme `SHR_QW_PLC_HB`, lojistik `AGV_QW_PLC_HB`. |
| R7 | Üç adres uzayı (simülatör, `%IW/%QW`, PLC slave) ve rol başına `mbconfig` | Kabul. `PLCS` tablosu okuma/yazma başlangıcını taşır; gen-plc adresleri göreli hesaplar, `run_ayran.sh ROLE=...` doğru aralıkları yazar. |
| R8 | ST'deki `FAB_IW_MAPVER = 4` | Kabul. Sabit `(*@MAPVER@*)` ile üretilir. |
| - | Tek PLC modunda kablo kullanma | Kabul. Tek modda `D_READY := PALLET.PICKUP_RDY` (doğrudan); bölünmüş modda `AGV_IW_IL` kablosu. Gövde aynı, bağlama gen-plc'de. AGV'nin "çatallar dışarıda" sinyali her iki modda istasyonun kendi girişinden (`PAL_IW_IL`) okunur (araç sensörü, PLC üzerinden geçmez). |
| - | Tank 9 "CIP gerekli" aç değil | Kabul: ayrı `HIJYEN` kategorisi. |
| - | Mikro duruş eşiği dolum boru hattı gecikmesinden küçük | Kabul. Eşik 3 × ideal çevrim; `URETIM`'e girişten sonraki ilk adet (hat dolumu) mikro duruş sayılmaz. Tablo korunur (görevde istendi). |
| - | Paletleme ideal 3,8 s fazla iyimser | Kabul: 4,5 s/paket (18 al-bırak + 2 levha + palet değişimi payı); test P < 1 doğrular. Ham P saklanır, gösterimde kırpılır. |
| - | Vardiya sınırında aralıkları kırp; izleme kapalıyken boşluk | Kabul. Kapsanmayan süre VERI_YOK. İzleme açılışında açık aralıklar kapatılır. |
| - | Hat OEE ≠ dolum OEE | Kısmen: hat OEE darboğaz (dolum) OEE'si olarak kalır; ayrıca "hat sonu verimi" (depoya giren paletlerdeki bardak / dolan bardak) gösterilir. |
| - | FIFO ile konumsal çıkarım | Kabul (küçük): `inferPackCups` paket sırası × 6 − kayıplar; testler kimlikli izlemeyle uyumu ölçer (normalde %100, gruplamada bardak düşünce < %100). |
| - | Palet kimliğini el sıkışmada taşı | Reddedildi (bu aşamada): tek palet D'de durabiliyor, karışma yok; README'de not. |
| - | `cip` anahtarı run'a bağlı olmalı | Gerek yok: CIP kaydı PLC'den gelir, `cip_id` izleme DB'sinin kendi artan anahtarı. |
| - | `--source sim` yalnızca hata ayıklama | Kabul. |
| - | İzleme yoklaması 200–250 ms | Kabul: 250 ms. |

## 11. Kod incelemesi (Codex gpt-6.1-sol, 4 Kasım 2026)

Tam metin: `FAZ5-KOD-INCELEME-CODEX.md`. Yedi bulgunun hepsi düzeltildi ve teste bağlandı:
run değişiminde olay kaybı (yanıt işlenmez, baştan istenir), veri boşluğu sonrası üretimin OEE'yi şişirmesi (`production.gap`),
boşlukta biten CIP'in zamanı (son görülen CIP anı + `end_uncertain`), yeniden başlamada CIP izinin kaybı (`meta.cip_state`),
pencere sınırı sözleşmesi (bütün sayımlar `(t0, t1]`), en uzun duruş ve mikro duruşların pencereye kırpılması.
DeepSeek'in kod incelemesi ilk denemede takıldı; dosyalar doğrudan eklenerek yeniden çalıştırıldı (bölüm 12).

Karma mod OpenPLC denemesi (paketleme = OpenPLC, diğerleri JS): README "OpenPLC Runtime v3 (test edildi)" tablosunda.

## 12. Kod incelemesi (DeepSeek v4.1, 4 Kasım 2026)

Tam metin: `FAZ5-KOD-INCELEME-DEEPSEEK.md`. 8 bulgu; kodla karşılaştırıldı:

| # | Bulgu | Karar |
|---|---|---|
| 1 | Ölçülmeyen Q'da OEE = A × P | Tasarım gereği: panel "OEE (Q ölçülmüyor)" diye etiketliyor, Q "—". Yanıltıcı yorum düzeltildi. |
| 2 | CIP kaydı boşluktan sonra okunursa başka CIP'in değerleri gelebilir | **Kabul.** Boşluk sonrası okunan kayıt `end_uncertain = 1`. |
| 3 | Boşluksuz CIP'te bitiş ilk CIP dışı örnek (bir yoklama geç) | **Kabul, gerçek hata.** Bitiş artık her zaman son CIP örneği; yoklama aralığında başlayan aktarım önceki CIP'e düşüyordu. Birim testi eklendi. |
| 4 | `%QW100` okuması `w0` ile kayıyor | Yanlış okuma: PLC slave'i `100 + i = hr[w0 + i]` eşliyor, okuma doğru. |
| 5 | Sayaç farkı pencere sınırına bir yoklama kadar taşıyor | Kabul edilen çözünürlük (250 ms); boşluk farkları zaten `gap = 1` ile OEE dışında. |
| 6 | Haberleşme boşluğunda alarm kenarları | Boşlukta açılıp kapanan alarm görülemez (kaçınılmaz); "ikinci kez açılır" iddiası kodda yok. Boşluklar `comm_gap`'te. |
| 7 | Test paketi FIFO çıkarımını kaydırıyor | Yanlış: test paketinin olayında bardak yok, `is_test = 0` filtresi yeterli. |
| 8 | Başlangıç stoku CIP'e bağlanıyor; `frac ≥ 0.005` | **Kabul (ilk kısım).** `transfer_cip` görünümü başlangıç stokuna CIP vermez (eski DB'lerde görünüm yeniden kurulur). Eşik zaten olay üretilirken uygulanıyor, sorgu ile iz aynı. |

Sonuç: `npm test` 83/83 (26 birim + 57 senaryo).
