# Aşama 6a — PLC yeniden başlaması ve kalıcı bellek (tasarım)

4 Kasım 2026. Aşama 5'te bulunan güvenlik sınırının çözümü (README "Bilinen sınır", FAZ5-TASARIM bölüm 10).

## 1. Sorun

PLC'nin aklında tutup sahada ölçemediği durum var:

| FB | Bellekteki durum | Kaybolursa / bayatlarsa |
|---|---|---|
| Shrink (gruplama) | `ROWS` (plakadaki sıra), `G_STP` | Plaka doluyken sıra itilir, 3 bardak düşer (sıcak devamda görüldü) |
| Pallet | `COUNT`, `PALLET_ID`, `DONE_CNT`, `WRAPPED`, `SHEET_BOT/TOP` | Soğuk başlamada paletteki paket sayısı 0 olur: robot dolu slota koyar / eksik palet sarılır |
| Pallet, robot işi | `R_STP`, `JOB`, `SLOT`, `SEQ` | `SEQ` zaten robotun `ACK_SEQ`'inden eşitleniyor |
| Dolum, tank, AGV, AS/RS | adım makineleri | AS/RS açılışta envanter sayımı yapar; diğerleri incelenecek |

OpenPLC v3 gerçeği (`webserver/core/persistent_storage.cpp`):
- Yalnızca `%MW`, `%MD`, `%ML` saklanır. FB içi değişken saklanmaz.
- En sık 1 saniyede bir dosyaya yazılır (`Pstorage_polling`, şu an kapalı).
- Program yüklenince dosya silinir.

Bu yüzden kalıcı bellek **en fazla ~1 s bayat** olabilir. Hızlı değişen adım durumu bununla korunamaz.

## 2. İlke

1. **Ölç, hatırlama.** Sahada ölçülebilen durum sensörle bilinir. Güvenlik kilidi de sensöre bağlanır: plaka doluysa sıra iticisi hiçbir adımda itmez.
2. **Hatırla, doğrula.** Ölçülemeyen ama yavaş değişen durum kalıcı belleğe yazılır. Açılışta bağımsız bir kaynakla (robotun kalıcı iş kaydı) doğrulanır.
3. **Açılışta güvenli dur.** Siemens OB100 gibi: her açılışta (soğuk ya da kalıcı bellekle) bütün FB'ler `MODE := 0`. Adım makineleri güvenli "ev" adımına alınır, çıkışlar kapalı kalır; operatör START'a basmadan hiçbir şey hareket etmez. Ev adımları sensörden yeniden değerlendirilir.
4. **Bilinmiyorsa söyle.** Kalıcı bellek yoksa ya da tutarsızsa ilgili hücre alarm verir ("durum bilinmiyor"). Operatör el ile müdahale eder. PLC tahmin etmez.

## 3. Değişiklikler

### 3.1 Ortak: açılış biti
- `Ortak.st`'de kalıcı olmayan bir `FIRST_SCAN` (başlangıç değeri TRUE) tutulur.
- İlk taramada `RESTART := TRUE` olur, sonraki taramada FALSE.
- Her FB'ye `RESTART : BOOL` girişi eklenir.
- `RESTART` ile her FB `MODE := 0` yapar, adımları ev adımına alır, zamanlayıcıları sıfırlar.
- Ev adımları her FB için ayrı ayrı belirlenir; aşağıda ve kod incelemesinde.
- Açılıştan sonra START gelene kadar yeni bir durum gösterilir: QW_STATE ile değil, `QW_STATUS`'ta "yeniden başladı, START bekliyor" biti.

### 3.2 Shrink: plaka sensörü (sim + harita)
- Yeni giriş `SHR_IW_PLATE` (IR, shrink bloğu ofset 8): bit 0 sıra 1 dolu, bit 1 sıra 2 dolu. Plakadaki fotoseller.
- PLC'de `ROWS` her taramada sensörden alınır: sensörde kaç sıra varsa o.
- **Kilit:** `ROW_PUSH` çıkışı ancak plaka sensörü 2 sıra göstermiyorsa verilir. Plaka doluyken sıra itilirse alarm verilir, itme yapılmaz.
- Açılış: `G_STP` 1→0, 11..13→10, 21..22→20 (grup iticisi geri çekilir, plakada sıra varsa 20'den devam).

### 3.3 Pallet: kalıcı defter + robot kaydıyla doğrulama
- Kalıcı alanda tutulanlar (`%MW`, program düzeyi, located):
  - `RET_MAGIC` (16#A55A) ve `RET_MAPVER`;
  - `PAL_COUNT`, `PAL_ID`, `PAL_DONE`, `PAL_WRAPPED`, `PAL_SHEETS` (bit 0 alt, bit 1 üst);
  - `PAL_LAST_SEQ`: COUNT'a işlenmiş son robot işinin numarası.
- FB bunları `VAR_IN_OUT` olarak alır; JS'te FB'ye geçirilen `ret` nesnesi.
- Açılışta:
  - `RET_MAGIC` ve `RET_MAPVER` doğruysa defter geçerli sayılır.
  - Robotun `RES_SEQ`'i `PAL_LAST_SEQ`'ten bir ilerideyse ve son iş başarılı bir koyma işiyse (`RES_CODE = 1`, iş tipi koyma), `COUNT := RES_SLOT` ve `PAL_LAST_SEQ := RES_SEQ` yapılır. Bu, belleğin en fazla 1 iş bayat kalmasını kapatır. Aynı yol karton levha işleri için de geçerli.
  - Fark birden büyükse ya da `RET_MAGIC` yoksa: alarm "Palet defteri bilinmiyor".
- Defter bilinmiyorken:
  - Robot işi verilmez, B istasyonu kilitli kalır.
  - Operatör paleti el ile reddeder: RESET 3 s basılı tutulur, B istasyonu paleti sarmadan çıkarır.
  - Simülatörde bu, paletin "eksik" işaretlenip AGV'ye gitmemesi demek. Kapsamı aşıyorsa: alarm ve START kilidi yeterli, palet el ile alınır; sim bunun için bir test düğmesi sunar.
- `RES_SEQ` / `RES_SLOT` iş tipini vermiyorsa: robotun kalıcı kaydına `RES_JOB` eklenir (pallet IR bloğunda boş ofset).

### 3.4 Diğer FB'ler
Dolum, tank, AGV ve AS/RS için açılış ev adımları belirlenir. Kural aynı: çıkış kapalı, `MODE 0`, sensörden yeniden başla.
- AS/RS envanter sayımı yapmaya devam eder.
- Tank CIP'in ortasında yeniden başlarsa CIP iptal sayılır ("CIP kesildi"). Ürün aktarımı, yeni bir CIP başarıyla bitene kadar engellenir. Bu, gıda güvenliği açısından doğru taraf.

### 3.5 OpenPLC
- `run_ayran.sh`: `Pstorage_polling = 1` (saniye) ayarlanır.
- `gen-plc.js`: kalıcı değişkenler `%MW` adresleriyle yazılır. Alan PLC başına ayrılır; tek PLC'de hepsi tek alanda.

### 3.6 Simülatör ve test düzeneği
- `smoke.js` `_plcRestart`:
  - `{ role, retain: true }`: kalıcı bellek, en fazla 1 s bayat. Düzenek her 1000 ms'de `ret` görüntüsünün kopyasını alır; yeni FB o kopyayla başlar.
  - `{ role, retain: false }`: soğuk başlama, bellek yok.
- Sıcak devam (değişkenler korunarak duraklama) gerçek bir OpenPLC durumu değil. Senaryodan kaldırılır ya da kalıcı bellekli başlamaya çevrilir.

## 4. Yeni senaryolar
1. Paketleme PLC'si üretimin ortasında kalıcı bellekle yeniden başlar, operatör START'a basar: 0 düşen bardak, palet defteri doğru, palet tamamlanır ve depolanır.
2. Yeniden başlama tam sıra itme sırasında (birkaç faz kaydırmasıyla): 0 düşen bardak.
3. Kalıcı bellek olmadan soğuk başlama: gruplama sensörden doğru devam eder. Paletleme "defter bilinmiyor" alarmı verir ve robot işi vermez; çarpışma ve yanlış slot yok.
4. Kalıcı bellek 1 iş bayat (robot koymayı bitirmiş, bellek yazılmamış): robot kaydıyla doğru sayı.
5. Tek PLC modunda da aynısı.
6. Tank CIP sırasında yeniden başlama: CIP iptal, yeni CIP bitene kadar aktarım yok.

## 5. Açık sorular (inceleme için)
- Defter bilinmiyorken paleti el ile reddetme akışı mı, yoksa yalnızca alarm ve kilit mi?
- `ROWS`'u her taramada sensörden almak mı, yalnızca açılışta mı? (Her tarama daha basit; sensör arızasında yanlış sayar. Kilit yine korur.)
- `QW_STATE` için yeni "yeniden başladı" durumu mu, yoksa durum biti mi? (OEE kategorisi: HAZIRLIK.)

## 6. Sonuç (4 Kasım 2026)

Uygulamayı Codex (gpt-6.1-sol) dört turda yazdı; ayrıntılar `FAZ6-KOD-RAPOR-CODEX.md`. DeepSeek tasarım incelemesi: `FAZ6-INCELEME-DEEPSEEK.md`.

| Tur | Ne | Kaynak |
|---|---|---|
| 1 | Tasarımın uygulanması: açılış biti, plaka fotoselleri, `%MW` palet defteri, robot kaydıyla doğrulama, tank CIP iptali, harita 6 | bu belge |
| 2 | START'a kadar hiçbir hareket yok, açılışta robot HOLD, `RES_JOB` zorunlu, sağlama kelimesi (MAGIC en son yazılır), `!IO_READY` alarmları silmiyor | DeepSeek |
| 3 | Robot işin ortasındayken yeniden başlama: kalıcı kilit (HOLD ↔ terminal kayıt beklemesi) ve alarmsız bekleme (evde/boş tutucu şartı). START kabul edilmiş işi bitirtir, sonuç defterle uzlaştırılır | gerçek OpenPLC denemesi 1 |
| 4 | Yeniden başlamada fırında kalan paket 85 s içeride kaldı, ürün 3 °C ısındı, iyi palete gitti. Fırın çıkışına karantina ayırıcısı; açılışta fırın/sarma/plakadaki ürün sensör ve sayaçlardan ölçülüp karantinaya gider. Harita 7 | gerçek OpenPLC denemesi 2 |

Doğrulama: `npm test` 208/208. Dört ST dosyası OpenPLC'de derlendi. Gerçek OpenPLC'de (paketleme rolü, kalıcı bellek açık) 520 s, iki `systemctl restart`:
- 2 palet hatasız depolandı;
- 2 paket (12 bardak) karantinaya gitti;
- palet sayısı iki açılışta da gerçekle aynıydı;
- START öncesi hiç hareket olmadı;
- 0 kayıp, 0 çarpışma.

Kalan sınırlar:
- Plakada bekleyen ve fırına hiç girmemiş bardaklar da temkinli olarak karantinaya gider.
- Birden fazla iş bayat bellek ya da robot kaydının da kaybolması bakım gerektirir.
- OpenPLC'ye program yüklemek kalıcı dosyayı siler.
- Tek kelimelik sağlama bir işlem günlüğü değildir.

## 7. Üç gerçek OpenPLC (4 Kasım 2026)

Üç PLC'nin üçü de tek WSL makinesinde, ayrı ağ alanlarında gerçek OpenPLC v3 olarak çalıştırıldı (`plc/openplc/oplc3.sh`, `scripts/oplc3-run.mjs`). 660 s'lik denemede paketleme, proses ve lojistik sırayla yeniden başlatıldı.
- 2 palet hatasız depolandı, 1'i sevk edildi.
- 1 paket karantinaya ayrıldı.
- Tank 2 CIP yaptı, ikisi de başarılı.
- AGV, lojistik açılışında yüklü taşıdığı paleti teslim etti.
- 0 kayıp, 0 çarpışma, 0 hatalı palet.

Bulunan hata: dolum ısınma bekçisi maskeli (kapalı) ısıtıcıyı açık sayıyordu. 45 s START beklemesinde sahte "Isıtıcı ısınmıyor" alarmı verip dolumu durdurdu. Düzeltildi (ST + JS + birim testi); proses açılışı gerçek OpenPLC'de tekrarlandı ve alarm çıkmadı. `npm test` 209/209.

Ayrıca `oplc3.sh restart`, WSL çağrısı bitince yeni OpenPLC'yi de öldürüyordu; süreç `setsid -f` ile ayrıldı.
