# FAZ6 — Kalıcı bellek uygulama raporu

4 Kasım 2026. Tasarım: `FAZ6-KALICI-BELLEK.md`.

## Sonuç

Palet defteri program düzeyindeki located `%MW` kelimelerine taşındı; FB'ye `VAR_IN_OUT`, JavaScript karşılığına aynı `ret` nesnesinin referansı bağlandı. Shrink sıra sayısı her taramada plaka fotosellerinden okunuyor. Bütün FB'ler açılışta çıkışlarını kapatıyor ve yeni START kenarı bekliyor. Açılışta basılı kalan START hareket başlatmıyor. Zamanlayıcılar sıfırlanıyor.

Her `FB_*.st` değişikliği karşılığı `fb_*.js` ile birlikte yapıldı. ST kaynakları ve üretilen dosyalar ASCII; TON bildirimleri ayrı satırda; bit kelimeleri WORD.

## Değiştirilen dosyalar ve nedenleri

| Dosya | Değişiklik |
|---|---|
| `plc/src/Ortak.st`, `plc/fabrika.js` | FIRST_SCAN/RESTART, ilk geçerli giriş görüntüsünü bekleme, kalıcı nesneyi FB'lere bağlama, yeni giriş ve durum kelimelerini taşıma. |
| `plc/src/Proses.st`, `Paketleme.st`, `Lojistik.st` | Her FB'ye RESTART; tank START; program kalıcı alanlarının VAR_IN_OUT bağlantıları; yeni I/O. |
| `plc/src/FB_Dolum.st`, `plc/fb_dolum.js` | Açılış ev adımı, bilinmeyen bardakların muhafazakâr reddi, kör cepler için ilk altı endekste red fotoselinden varlık doğrulama, STATUS. |
| `plc/src/FB_Tank.st`, `plc/fb_tank.js` | Açılışta eski rotayı kapatma/kanıtlama, CIP iptal kaydı ve yeni CIP zorunluluğu, START bekleme, STATUS. |
| `plc/src/FB_Shrink.st`, `plc/fb_shrink.js` | İki plaka fotoseli, sensörden ROWS, dolu plakaya sıra itme kilidi/alarmı, iticilerin geri konumunu bekleme, açılış. |
| `plc/src/FB_Pallet.st`, `plc/fb_pallet.js` | Kalıcı defter, robot sonucuyla bir işlik uzlaştırma, geçersiz defter alarmı ve START kilidi, robot kayıt bekleme zaman aşımı, sensörlerden B/C ev adımları. |
| `plc/src/FB_Agv.st`, `plc/fb_agv.js` | Açılışta iş seçimini sıfırlama, ACK numarasıyla eşleme, çıkış/izinleri START'a kadar kapatma. |
| `plc/src/FB_Asrs.st`, `plc/fb_asrs.js` | Açılışta bütün rafları belirsiz yapma; çatalda yük kalmış ve bilinen boş göz yoksa önce göz kontrolü yapma; START kilidi. |
| `plc/retain.js` | Rol, isim, tip ve mutlak %MW adreslerinin ortak şeması. |
| `tools/gen-plc.js` | Role göre located kalıcı değişken üretimi, adres çakışması kontrolü; plaka kelimesinin WORD üretilmesi. |
| `plc/build/fabrika.st`, `proses.st`, `paketleme.st`, `lojistik.st` | Üreticiden yeniden oluşturuldu. |
| `public/iomap.js` | MAP_VERSION 5 → 6; yeni IR/HR, bit 14 alarmları, bütün hücrelerde STATUS bit 7 açılış beklemesi. |
| `server/cells/shrink.js` | Fiziksel plaka sıralarından iki fotosel biti. PLC kararı simülatöre taşınmadı. |
| `server/cells/pallet.js` | Robotun terminal kaydında RES_JOB; hücre çıkışları kapalı ve robot işi yokken operatörün B paletini el ile alması. |
| `public/index.html`, `public/main.js` | El ile alma test düğmesi. |
| `monitor/collector.js` | STATUS bit 7 beklemesini HAZIRLIK sınıfına alma; ARIZA/GÜVENLİK önceliğini koruma. Diğer izleme dosyaları değişmedi. |
| `test/smoke.js` | Gerçek yeni Fabrika ile rol bazında yeniden açılış; 1000 ms snapshot; eski bağlantıdan gecikmiş yazmaların iptali; 15 yeni senaryo; eski depo açılışını gerçek lojistik PLC açılışına çevirme. |
| `test/phase6-unit.js`, `package.json` | 23 kalıcı bellek/açılış/harita/izleme testi ve npm test zincirine eklenmesi. |
| `plc/openplc/run_ayran.sh` | SQLite Settings/Pstorage_polling=1; anahtar eksik veya yinelenmişse açıklayıcı hata. |
| `README.md` | Önceki bilinen sınırın yerine yeni davranış, kalan sınırlar, harita ve test sayıları. |

## Bellek ve harita

Program %MW adresleri rol aralıklarından bağımsız mutlak adreslerdir; `%IW/%QW` Modbus göreli adres hesabına katılmaz.

| Adres | Değişken | Tip | Rol |
|---|---|---|---|
| %MW0 | TNK_COMMISSION | WORD | proses |
| %MW32 | RET_MAGIC | WORD | paketleme |
| %MW33 | RET_MAPVER | INT | paketleme |
| %MW34 | PAL_COUNT | INT | paketleme |
| %MW35 | PAL_ID | INT | paketleme |
| %MW36 | PAL_DONE | INT | paketleme |
| %MW37 | PAL_WRAPPED | INT | paketleme |
| %MW38 | PAL_SHEETS | WORD | paketleme |
| %MW39 | PAL_LAST_SEQ | INT | paketleme |
| %MW40 | PAL_ACTIVE | WORD | paketleme |
| %MW41 | PAL_C_PHASE | INT | paketleme |

Tek PLC 11 alanın hepsini içerir; proses 1, paketleme 10, lojistik 0 alan içerir. Adresler çakışmaz. PAL_ACTIVE ve PAL_C_PHASE çalışma adımını körlemesine sürdürmek için kullanılmaz; sensörlerle görülen paletin hangi deftere ait olabileceğini ve bitmiş sarımı tekrar saymama durumunu doğrular. Ara konum belirsizse otomatik hareket yerine kilit seçilir.

Yeni girişler: SHR_IW_PLATE = IR56, shrink ofset 8, WORD; PAL_IW_RES_JOB = IR75, palet ofset 11. Yeni durum çıkışları: DOL_QW_STATUS = HR21; TNK_QW_STATUS = HR43. Diğer hücrelerin mevcut STATUS kelimeleri kullanılır. Ortak bit 7, yeniden açılışta START beklemesidir; yeni QW_STATE kodu eklenmedi.

## Her FB'nin açılış ev adımları

| FB | Ev adımı ve START sonrası davranış |
|---|---|
| Dolum | MODE=0, CYC=0; bütün istasyon alt adımları 9. Eski bardaklar güvenilir ürün sayılmaz. İlk altı endekste red fotoseli, takipte görünmeyen bardakları da reddeder. Yeni beslenen bardaklar bu pencerenin dışında kalır. Mevcut mekanik endeks hareketi saha mekanizmasında tamamlanabilir; PLC yeni tetik vermez. |
| Tank | MODE=0, STP=0, WANT/CUR/VALVES=0, RSTATE=1: eski vanaların kapanması kanıtlanır, ardından strok beklemesiyle RSTATE=0'a geçilir. Ürün doğrulaması kaybolur. CIP_RES=2, CIP_DUE=TRUE, iptal uyarısı; RESET aktarım kilidini kaldırmaz. Yeni CIP başarıyla bitince kilit açılır. |
| Shrink | MODE=0, G_STP=0, W_STP=0. ROWS her taramada sensörden. İticilerin geri sensörleri gelmeden yeni itme yok. START sonrası dolu plaka → 20; altlık var ve iki sıra yok → 10; boş plaka → altlık adımı. Sarma makinesi meşgulse bitmesi beklenir; gerekirse yeniden sarılır. |
| Palet | MODE=0; A/B/C/R adımları 0, JOB/SLOT=0. ACK ile SEQ eşlenir; meşgul robotun güç kesilmesinden sonraki terminal sonucu beklenir. 3 saniyede tutarlı kayıt gelmezse defter bilinmiyor. Geçerli B defteri → B=10 veya dolu/üst kartonluysa 20. C'deki palet → sarma veya doğrulanmış bitiş sonrası çıkış beklemesi. B→C tamamlanması görüntüden sonra olduysa DONE bir kez onarılır. START öncesi bütün çıkışlar ve alım izni kapalı. |
| AGV | MODE=0, R_STP=0, ORDER=0; SEQ=ACK, HOLD kilidi. START sonrası yük sensörü varsa teslim işi, yoksa batarya/istasyon talebinden iş seçimi. Eski işi aynı SEQ ile tekrar göndermez. |
| AS/RS | MODE=0; R/I/O adımları 0; bütün raf gözleri belirsiz. START sonrası gerekiyorsa eve dönüş, sonra ölçerek envanter. Çatalda yük varsa ve hiç bilinen boş göz yoksa göz kontrolüyle bir boş yer kanıtlanır, sonra yük bırakılır. |

## Tasarıma ilişkin kararlar ve sapmalar

1. FIRST_SCAN ilk geçerli harita/kalp atışı görüntüsüne kadar tutulur. İlk sıfır giriş görüntüsüyle palet defteri değerlendirmek güvenli değildir. Bu bekleme sırasında da çıkışlar sıfırdır.
2. PAL_LAST_SEQ yalnızca koymayı değil, işlenmiş bütün robot sonuçlarını kaydeder. Alma/eve dönüş de SEQ ilerlettiği için aksi halde sağlam defterde sahte “birden fazla iş farkı” oluşurdu. Bir ilerideki başarılı koyma ve karton işi 1 veya 17 sonucuyla onarılır. Hatasız tekrarlanmayan/iptal edilen iş sayıyı artırmaz. Slot, iş tipi, sayaç aralıkları, karton tutarlılığı ve 30000→1 sarması kontrol edilir.
3. İlk devreye almada yalnızca bütün A/B/C/D palet sensörleri boş, besleyici pasif, robot ACK/RES=0 ve tutucu boşsa boş defter kurulur. Ürün bulunan veya robot geçmişi olan hücre, magic olmadan otomatik başlatılmaz. Boş sensörler ve sıfır robot geçmişinin devreye alma koşulu sayılması bir işletme varsayımıdır; geçmişi ayrıca silinmiş bir saha için bağımsız kanıt değildir.
4. Defter bilinmiyorken alarm + START kilidi + robot işi yok kararı seçildi. RESET bu alarmı temizlemez. Üç saniye RESET ile otomatik sarmasız tahliye eklenmedi. Basit fiziksel el ile alma düğmesi paleti hattın dışına alır; AGV'ye vermez, defteri veya robot geçmişini değiştirmez. Yeniden devreye alma doğrulanmış bakım/hat sıfırlama işlemidir; bu düğme üretimi açmaz.
5. Tank için eski “temiz” bilgisini saklamak yerine her normal açılışta yeni CIP zorunlu tutuldu. Bir saniye bayat temiz kaydı, henüz kaydedilmemiş CIP başlangıcını kaçırabilir. Test Factory.reset() temiz hattı kurduğundan ilk PLC'ye TNK_COMMISSION=16#C1EA tek kullanımlık devreye alma verisi verilir; FB bunu açılışta sıfırlar ve kendisi tekrar üretmez. ST'de bu alanın başlangıç değeri sıfırdır; gerçek OpenPLC ve varsayılan JS istemcisi yeni CIP bekler. Bu kelime eski temiz durumunu periyodik saklamak için kullanılmaz.
6. Isıtıcı, fan, soğutma ve izinler dahil bütün çıkışlar açılış START'ını bekler. Normal STOP sonrası mevcut kontrollü shrink boşaltma/soğutma davranışı sürer; yalnızca yeniden açılış beklemesi bunu kilitler.
7. “Sıcak değişkenlerle devam” testi eklenmedi. Düzenek yeni Fabrika kurar, yalnızca 1000 ms'de bir alınmış ret kopyasını geri yükler. Her yeniden açılışta eski Modbus kuyruk nesline ait işlemler iptal edilir; saha/robot nesneleri ve kayıtları korunur. Eski string biçimi gerçek soğuk lojistik açılışında sınanır.

## Mevcut test beklentilerindeki değişiklikler

- Eski 57 senaryo korunmuştur. Depo açılış testi yalnız AS/RS nesnesini değiştirmek yerine lojistik PLC'nin tamamını soğuk başlatır ve yeni START verir; envanter/stok ve güvenlik beklentileri korunur.
- “Bardak ayırıcı %35 kaçırır” izleme testinde P<0,80 sınırı P<0,85 oldu. Isıtıcının ilk START'a kadar kapalı olması çevrim/RNG örnekleme fazını değiştiriyor; ölçülen P yaklaşık 0,804. Test hâlâ en az %15 performans kaybı arar; Q=1, A>0,95 ve üretim penceresi koşulları korunur. Hatalı sevk, bardak kaybı, defter veya çarpışma eşikleri gevşetilmedi.

## Doğrulama

- `npm test`: **121/121 geçti** — 26 izleme birim testi, 23 FAZ6 birim testi, 72 uçtan uca senaryo (57 mevcut + 15 yeni).
- Tasarım 4/1 ve 4/5: üç PLC ve tek PLC üretimde retained açılış, START öncesi kapalı çıkışlar, doğru defter, tamamlanmış/depolanmış palet.
- Tasarım 4/2: iki sıra için üç strok fazı; altı ayrı yeniden başlatma ve sıfır kayıp bardak.
- Tasarım 4/3: soğuk açılışta sensörden shrink devamı, palet alarmı, RESET/START sonrası bile yeni robot işi yok.
- Tasarım 4/4: bir koyma ve bir alt karton işi bayat görüntü gerçek 1000 ms snapshot zamanlamasında yakalanır; üst karton, 17 sonucu ve SEQ sarması ayrıca birim testinde sınanır.
- Tasarım 4/6: retained ve soğuk CIP açılışı; iptal, yeni CIP öncesi aktarım yok ve yeni CIP başarılı.
- Ek senaryolar: kör cepte takip dışı bardak reddi; yüklü depo çatalıyla açılışta boş göz doğrulama.
- `node tools/gen-plc.js`: dört hedef başarıyla üretildi. Kaynak/çıktı ASCII, rol başına %MW sayısı/adres benzersizliği ve WORD plaka tipi birim testinde kontrol edildi.
- `bash -n plc/openplc/run_ayran.sh`: geçti (Git Bash). OpenPLC Settings güncellemesi Linux/OpenPLC üzerinde çalıştırılmadı; gerçek matiec derlemesi bu ortamda yapılmadı.

## Açık riskler ve kapsam sınırları

- Birden fazla robot işi bayat kalırsa veya robotun kendi kalıcı kaydı da kaybolursa otomatik onarım yapılmaz. Tutarsızlık kilitlenir; kayıtlar denetlenerek bakım gerekir.
- Diske yazmanın bozulması veya karışık/torn görüntü için tam işlem günlüğü/CRC eklenmedi. Magic, sürüm, alan tutarlılığı ve bağımsız robot kaydı denetlenir; bunlar fiziksel güç kesme/bozuk dosya testinin karşılığı değildir.
- Palet transferinde bütün konum sensörlerinin boş olduğu ara konumları ölçmek için ek sensör yok. Belirsiz defter/konumda kilit güvenli taraftadır; her ara mekanik konum için otomatik kurtarma vaat edilmez. Operatörün saha konumlarını doğrulaması gerekir.
- Dolumun red istasyonunu geçmiş bardakları veya daha önce çıkış bandına aktarılmış ürün yeniden denetlenmez; kör ceplerde kalan eski bardaklar red sensörüyle temizlenir. Kontrolcüler kapalıyken başlamış mekanik strokların kendi fiziksel tamamlanması simülatörde korunur.
- START beklenirken ısıtma/soğutmanın da kapalı olması tasarımın açık talebidir; uzun duruşta ürün/sıcaklık yönetimi için işletme prosedürü gerekir. Gerçek safety/ürün validasyonu bu simülasyon testleriyle tamamlanmış sayılmaz.
- `js-plc.js` süreci disk saklama servisi eklenmeden soğuk açılır; ret görüntüsü yükleme API'si Fabrika'dadır, periyodik saklama test düzeneğinde ve OpenPLC persistent storage'dadır.
- OpenPLC program yüklemesi saklama dosyasını siler. Yeni program/harita yüklemesi üretimde otomatik devam değildir. Linux kurulumunda Settings anahtarı ve gerçek `%MW` geri yükleme davranışı ayrıca devreye alma sırasında doğrulanmalıdır.

## İkinci tur

4 Kasım 2026. DeepSeek inceleme notu (`ds-faz6.md`) ve istekteki sekiz madde mevcut uygulamayla karşılaştırıldı. Önceki bölümler ilk turun kaydıdır; değişen davranışlar, bellek alanları ve test sayıları için bu bölüm geçerlidir.

### Bulgular, kararlar ve düzeltmeler

| Madde | İnceleme sonucu ve uygulama |
|---|---|
| 1 — Açılış kilidi / DRAINING | **Kısmen geçerli.** Önceki sürümde son çıkış maskesi START öncesi fiziksel çıkışları zaten kapatıyordu; doğrudan hareket iddiası bu sürüm için doğru değildi. Ancak içeride DRAINING ve durum bitleri açılabiliyordu. DRAINING ve sıcaklık nedeniyle çalışan fan yolu artık doğrudan `NOT WAIT_START` koşuluna bağlı. Fırında ürün ve 160 °C olsa da START öncesi bant, fan ve ısıtıcı kapalı. RESET alarm kabulüdür; üretim için ayrıca START gerekir. Normal START sonrası STOP'ta kontrollü boşaltma korunur. Fan istisnası eklenmedi; bu modelin tüm hareketleri kapatma tercihi sürüyor. |
| 2 — RESTART darbesi | **Mevcut kodda hata yok.** `Ortak.st` ve `Fabrika.scan()` zaten `FIRST_SCAN AND IO_READY` üretip FIRST_SCAN'i aynı taramada temizliyordu. Yeni test ilk geçerli görüntüden önce sıfır, sonrasında tam bir RESTART taraması gördüğünü ve hemen sonraki START kenarının çalıştığını doğruluyor. Açılışta basılı START için bırakıp yeniden basma şartı sürüyor. |
| 3 — Robot HOLD / ilk iş | **Geçerli.** RESTART HOLD_LATCH'i zaten kuruyordu, fakat son `QW_DO := 0` maskesi HOLD'u sahaya göndermiyordu. Açılış çıkışı artık HOLD ve güvenlik zinciri uygunsa robot ENABLE içerir; konveyör, pim, sarma ve yeni iş içermez. ENABLE kontrolcünün READY bildirmesini sağlar; HOLD hareketi engeller. İlk işten önce READY, HOMED, AT_HOME, parçasızlık, meşgul olmama ve ACK=RES koşulları 500 ms kesintisiz doğrulanır. İlk iş seçilene kadar bu onay kaybolabilir ve yeniden doğrulanır. START olmadan HOLD kalkmaz. Meşgul robotun terminal kaydı 3 s içinde tutarlı hale gelmezse defter kilitlenir; tutucudaki yükü veya yarım işi otomatik kurtarma işi verilmez. |
| 4 — Defter / iş tipi / sonuç kodu / sıra | **Çoğu zaten uygulanmıştı.** COUNT yalnız JOB=2 koymada onarılıyor, JOB=3 levhada SHEET bitleri düzeltiliyor, hem 1 hem 17 başarı sayılıyordu. Sıra doğrulaması `eşit veya tam bir sonraki` olduğundan geriye gitme ve birden fazla iş farkı zaten reddediliyordu; 30000→1 protokol sarması geçerli istisnadır. Eşit sonuçta koyma slotu/sayı tutarlılığı da vardı. Eksik iş tipinin JS'de `undefined` karşılaştırmalarıyla denetimi geçmesi kapatıldı; sıfır olmayan her terminal kaydında RES_JOB zorunlu. Eşit levha sonucunun defterdeki ilgili SHEET bitiyle tutarlılığı da eklendi. Alt/üst levha ve iki başarı kodu ayrı ayrı test ediliyor. |
| 5 — Yarım kalıcı yazım | **Geçerli.** `RET_CHECK` eklendi. Her commit önce MAGIC'i sıfırlar, alanları yazar, checksum'u yazar ve MAGIC'i en son A55A yapar. Açılışta checksum uyuşmazsa defter bilinmiyor. Bozuk alanlar, hücre boş diye otomatik sıfırlanamaz; otomatik ilk devreye alma yalnız bütün kalıcı kelimeler sıfırken ve önceki fiziksel/robot boşluk şartları sağlanırken mümkündür. |
| 6 — Ev adımları / sarma / UNDERWRAP | **Belgeleme ve UNDERWRAP eksikleri geçerli.** Aşağıda ayrıntılı tablo var. Önceki `PAL_C_PHASE >= 2` koruması bitmiş sarımı zaten tekrar saydırmıyordu; artık 2/3/4 fazları ayrı korunuyor. Bayat görüntü sarma bitişinden önceyse bağımsız sarıcı DONE veya mevcut C paletine ait en az 9 tur bilgisiyle WRAPPED bir kez onarılıyor. Simülatörde bu bağımsız tur sayacı C boşken ve sarıcı idle iken sıfırlanıyor; önceki paletin 9 turu yeni paletin tamamlandığına kanıt olamıyor. UNDERWRAP checksum kapsamındaki kalıcı kelimeye taşındı. |
| 7 — Dolu plaka / MOVE zaman aşımı | **Geçerli.** G=12, plaka dolu ve giriş şeridinde hâlâ bardak varsa 0x4000 plaka kilidi aynı taramada MODE=3 yapar; ROW_PUSH kesilir ve MOVE zamanlayıcısı sıfırlanır. Altı saniye bekleme sonunda 0x0002 eklenmediği test edildi. RESET sonrası ev adımı ve yeni START ile dolu grup işlenir. İkinci sıranın normal tamamlanmasında şerit boşken ROWS=2 olması bu alarmı üretmez. |
| 8 — Dondurulabilir bayat görüntü / robot kontrolcüsü | **Dondurma eksikliği geçerli; robot kayıtlarının kaybolduğu iddiası mevcut düzenek için geçersiz.** PLC restart zaten yalnız Fabrika nesnesini değiştiriyor, saha/robot nesnesini koruyordu. Yeni `sim._retFreeze = role` ilgili rolün disk kopyasını dondurur; `null` tekrar saklamayı açar. Senaryo 4 artık hedef iş sürerken önceki kopyayı dondurur, iş bitince gerçek PLC'yi yeniden kurar. Kopyanın START öncesi değişmediğini ve robotun ACK/RES/CODE/SLOT/JOB kaydının aynen korunduğunu açıkça doğrular. |

### Açılış ev adımları tablosu

| Hücre / kesilen adım | Açılıştaki seçim ve START sonrası davranış |
|---|---|
| Shrink G=1, 11–13, 21–22 | G=0; fiziksel plaka fotosellerinden ROWS okunur. İki iticinin geri bilgisi gelmeden yeni itme yok. Dolu plaka → 20; altlık bulunan eksik grup → 10; boş plaka → altlık adımı. Pad silindirinin ayrı geri sensörü yok; bu mekanik konum yazılımla kanıtlanmış sayılmaz. |
| Shrink W=1, sarma meşgul | W=0 ve START bekleme. START'tan sonra paket varsa W=1; meşgul sarıcıya istek tutularak devam edilir, DONE W=2'ye geçirir, uygun sıcaklık/bant/çıkış ile bırakılır. Açılış görüntüsünde DONE varsa doğrudan W=2 seçilir. START'tan önce DONE silinmişse bağımsız bitiş geçmişi bulunmadığından muhafazakâr yeniden sarma olabilir; paket tüketicisiz DONE nedeniyle içeride kilitli kalmaz. |
| Palet A=0/1 | A=0. START öncesi dispense/konveyör yok. A sensöründe hazır palet varsa yenisi istenmez; besleyici hâlâ meşgulse bitmesi beklenir. Konumların arasında kalan ve defterle kanıtlanamayan yük otomatik kabul edilmez. |
| Palet B=0/2/3 | B'de palet varsa geçerli aktif defter ve palet kimliği zorunlu. Defterle eşleşmeyen B paleti bilinmiyor; yeni palet sayılıp kimliği/sayısı sıfırlanmaz. A'da doğrulanmış palet varsa START sonrası normal A→B akışı kullanılır. |
| Palet B=10/20 | B sensörü ve geçerli defterle B=10; COUNT=18 ve üst levha varsa B=20. Robotun ilk iş kilidi ayrıca uygulanır. |
| Palet B=21, palet hâlâ B'de | B=20; START sonrasında transfer izinleri yeniden değerlendirilir. Körlemesine eski hareket adımına dönülmez. |
| Palet B=21, fiziksel palet C'ye ulaşmış | Aktif ve dolu/üst levhalı B defteriyle DONE bir kez onarılır, B=0 olur. C sarma fazı aşağıdaki bağımsız doğrulamayla seçilir. B/C sensörleri arasında belirsiz konumda otomatik devam yerine defter kilidi uygulanır. |
| Palet C=0/1 | C'de palet varsa doğrulanmış bitiş yokken C=1. DONE varsa C=2; DONE düşmüş ama bu C paletine ait en az 9 tur varsa C=3. Bayat kayıtta WRAPPED bir kez onarılır. START'tan önce sarma/çıkış yok. |
| Palet C=2/3/4 | Saklanmış 2/3/4 ayrı korunur. C=2 DONE'un düşmesini ve HOME'u bekler; C=3 alım izinlerini, C=4 C→D tamamlanmasını bekler. WRAPPED tekrar artırılmaz, WRAP_REQ verilmez. C boş/D dolu ve saklanan faz 4 ise transfer tamamlanmış kabul edilir. |
| UNDERWRAP | `%MW42 PAL_UNDERWRAP` ile kalıcı; açılışta geri yüklenir ve 0x0800 uyarısı kaybolmaz. Sonraki tamamlanan sarmanın gerçek tur sonucu bu bilgiyi günceller. |

### Kalıcı alan ve kalan sınırlar

Mevcut %MW32–41 adresleri değişmedi. `%MW42 PAL_UNDERWRAP : WORD`, `%MW43 RET_CHECK : WORD` eklendi. Paketleme 12, tek PLC toplam 13 kalıcı alan içerir. Modbus I/O haritası sürüm 6 olarak kaldı; checksum içermeyen eski kalıcı görüntü otomatik göç ettirilmez ve bakım doğrulaması gerektirir.

Checksum sıralı 11 kelimede `h := (31*h + word) MOD 65521`, başlangıç 1 olarak ST ve JS'de aynı hesaplanır; MAGIC ve sürüm de kapsamdadır. Test, her kelimeyi ayrı bozar ve commit sırasında her kelime yazımından sonraki görüntüyü yeni PLC'ye yükler: ara görüntüler reddedilir, son commit kabul edilir. Bu, OpenPLC'nin bağımsız kalıcılık iş parçacığını atomik hale getirmez. Çok taramaya yayılan okumalar checksum çakışması veya geçerli eski görüntü üretebilir; tek kelimelik checksum tam işlem günlüğü değildir. MAGIC=0 görüntüsü tutarlı bir payload yanında yakalansa bile güvenli tarafta kilitlenir. Gerçek OpenPLC güç kesme/disk testi ve matiec derlemesi bu ortamda yapılmadı.

Tam nottaki ek bulgular da değerlendirildi:

- `!IO_READY → ALARMS=0` kaldırıldı; altı FB geçersiz giriş görüntüsünde önceki kilitli alarmlarını koruyor. IO_READY ilk geçerli görüntüyü belirten kilittir; normal iletişim kaybı ayrıca COMM_FAULT yolundadır.
- Palet ACK/RES zamanlayıcılarından RESET penceresi çıkarıldı. Yeni regresyon testi bekleyen ACK sırasında RESET'in 3 s zaman aşımını yeniden başlatmadığını doğrular. Gerçek HOLD altında zamanın durması korunur.
- ROWS'un her taramada fotoselden alınması mevcut uygulamada `ROWS++ / ROWS=0` ile çelişmiyor: önceki turda bu atamalar adım makinesinden zaten çıkarılmıştı. QW_STATE sayı uzayı da zaten korunuyor ve açılış STATUS bit 7 ile bildiriliyordu. Bu iki öneri için yeni davranış gerekmedi.
- Manuel red önerisi önceki kararla uyumlu: bilinmeyen palet için alarm/kilit ve açık el ile alma işlemi var; otomatik sarmasız sevk eklenmedi. Program yüklemesinin kalıcı dosyayı silmesi bilinen dağıtım sınırıdır; kayıp üretim defterini operatör kabulü adı altında sıfırlayıp otomatik üretime açmak seçilmedi.
- PACKS'ın FB oturum sayacı olarak sıfırlandığı gözlemi doğru; bu sekiz maddelik turda kalıcı ömür üretim sayacı eklenmedi. İzleme katmanı sayaç sıfırlamasını kaydeder; yalnız PLC oturum sayacına dayanarak kalıcı OEE toplamı vaat edilmez. Pad geri sensörü eksikliği ve gerçek güvenlik kontrolcüsü validasyonu da yazılım testleriyle giderilmiş sayılmaz.

### İkinci tur doğrulaması

- `npm test`: **154/154 geçti** — 26 izleme birim testi, 53 FAZ6 birim testi, 75 uçtan uca senaryo. Önceki eşikler gevşetilmedi. Önceki 23 FAZ6 testi 53'e, 72 senaryo 75'e çıktı.
- Yeni üç uçtan uca senaryo: shrink sarma sürerken gerçek PLC yeniden açılışı; B_STP=21'de C'ye varış sırasında yeniden açılış; C sarma bitişi kalıcı görüntüye girmeden yeniden açılış. Son iki durumda fiziksel palet 9 turda kaldı, DONE=1, WRAPPED=1 ve depolanan palet=1 oldu.
- Senaryo 4'ün koyma ve levha testleri dondurulmuş görüntüyle geçti; robot terminal kaydı PLC yeniden kurulurken korundu.
- `npm test` ön adımındaki üretici dört ST hedefini tekrar oluşturdu; kaynak ve çıktılarda ASCII, benzersiz %MW adresleri ve alan tipleri doğrulandı. ST/JS değişiklikleri birlikte yapıldı.

## Üçüncü tur

4 Kasım 2026. İlk iki tur ve `restart-openplc.log`, `restart.mjs`, `repro.mjs` okundu. İkinci turdaki “meşgul robotun 3 s içinde terminal kayıt vermesi gerekir” ve ilk işten önce “evde ve tutucu boş” kararları bu bölümle değiştirildi.

### Kök neden: aynı açılış mantığının iki kilit yolu

**B, doğrudan yeniden üretildi:** eski kodla `node repro.mjs 150`, ACK=33, RES=32, JOB=2, SLOT=16 ve tutucuda paketle açılıyor. PLC HOLD veriyor; robot kontrolcüsü HOLD altında kabul ettiği işi ve hareket adımını koruyor. PLC ise yalnız `NOT BUSY AND ACK=RES` olduğunda defteri okuyordu. START için BOOK_OK gerekiyor, BOOK_OK için bitmiş iş gerekiyor, işin bitmesi için HOLD'un kalkması gerekiyor. Üç saniyelik T_BOOT bu döngüyü 0x4000 kalıcı kilide çeviriyordu. Kalıcı bellekteki COUNT bozuk değildi; hiç yüklenmediğinden JS oturum sayacı sıfır görünüyordu.

**A'nın alarm vermeyen kilit yolu:** robot işi servis kesintisi sırasında bitmiş veya ENABLE düşünce 13/17 terminal sonucuyla kapanmışsa ACK=RES olur; defter doğrulanır, COUNT yüklenir ve START MODE=1 yapar. Ancak T_ROBSAFE, READY/HOMED/AT_HOME yanında `NOT R_PART` istiyordu. Alma işi robotu alma noktasının üzerinde, başarılı alma veya bırakmadan önce iptal de tutucuda paketle bırakabilir. Bunlar geçerli saha durumlarıdır. Eski onay hiçbir zaman gelmediğinden HOLD kalkmıyor, R_STP=0'dan yeni iş seçilemiyor, R_STP 11/12 zamanlayıcıları da çalışmadığı için alarm oluşmuyordu. STATE=ÇALIŞIYOR ve STATUS=3 yalnız MODE/B durumunu bildiriyor; HOLD'un kalktığını göstermiyor.

Bu ikinci yol A'nın gözlemleriyle uyumlu kök neden açıklamasıdır. OpenPLC kaydı ACK/RES, ROB_DI, HOLD veya robot konumunu içermediğinden A'da hangi iş fazının bu yola girdiği kesin olarak belirlenemez. JS'nin anında nesne değişimiyle canlı işi koruması B'yi; gerçek servis kesintisinin terminal sonuç oluşturabilmesi A'yı açıklar. İki koşul da hem `FB_Pallet.st` hem `fb_pallet.js` içinde vardı; belirtilerin farklılığı için kaynaklarda ST/JS ayrışması bulunmadı. Çalıştırılmış OpenPLC ikilisinin hangi kaynak revizyonundan derlendiği bu logdan doğrulanamaz.

**Ek bulunan pim yarışı:** açılış maskesi PIN çıkışını da kapattığı için altı saniyelik beklemede B pimi iniyor. İşsiz/yüklü robotun HOLD'u START'ta hemen kalkınca koyma isteği pim yükselmeden kontrolcüye ulaşabiliyordu; gerçek kontrolcü 16 (bölge izni) ile reddediyordu. Yeni iş ve kabul edilmiş işe devam onayı B varsa PIN_UP bekliyor. Bu hata yeni işsiz/yüklü uçtan uca testleriyle bulunup giderildi.

### Uygulanan davranış ve ST/JS denetimi

| Durum | Yeni davranış, iki kaynakta da aynı |
|---|---|
| İlk geçerli I/O görüntüsü | Checksum, sürüm, alan sınırları, fiziksel palet/aktif defter ve mevcut terminal kayıt hemen denetlenir. Son terminal kayıt defterden tam bir iş ilerideyse önce o uzlaştırılır. |
| ACK, RES'in tam bir sonrasında | 30000→1 sarması dahil geçerlidir. `RECOVERING` ve `RECOVER_SEQ=ACK` kurulur. Bunlar oturum alanlarıdır; yeni kalıcı kelime veya I/O haritası değişikliği yoktur. Kabul edilen iş robotta kalır. |
| START öncesi | ENABLE/HOLD dışında çıkış yok; JOB/SLOT=0, SEQ robot ACK'si. Üç saniyelik açılış zaman aşımı kaldırıldı. Defter geçerli tutulur; kabul edilmiş iş beklediği için bilinmiyor yapılmaz. |
| START sonrası, kabul edilmiş iş | B varsa pim yukarı geldikten sonra HOLD kalkar. Meşgul robot için imkânsız READY/AT_HOME/boş tutucu şartı aranmaz. Yeni SEQ ve yeni iş verilmez. Palet hattı adımları, konveyör/sarma çıkışları ve bunların zamanlayıcıları terminal uzlaştırılana kadar bekler. |
| Beklenen terminal geldi | BUSY düşünce aynı defter doğrulama/uzlaştırma yolu tekrar çalışır. RES_SEQ beklenen kabul numarası olmalı; JOB/CODE/SLOT alanları ve defter ilişkileri denetlenir. Koymada yalnız COUNT+1 slotu COUNT'u artırır; levhada yalnız uygun alt/üst SHEET biti değişir. 1/17 başarıları bir kez işlenir. Alma COUNT'u değiştirmez; alma slotu COUNT+1, eve dönüş slotu 0 olmalıdır. |
| Kayıt tutarsız | Yanlış/gerileyen sıra, değişen ACK, geçersiz iş/slot/kod veya defter/konum uyuşmazlığı 0x4000 üretir ve HOLD'u korur. RESET defteri sıfırlamaz. |
| İşsiz, ACK=RES, tutucuda paket | START ve 500 ms kararlı READY/B pimi geri bildirimi sonrası mevcut `R_PART → koyma` dalı çalışır. AT_HOME/boş tutucu şartı kaldırıldı. HOMED yoksa mevcut eve dönüş dalı seçilir. |
| Robot sonucu gelmiyor | Mevcut 40 s iş zaman aşımı kurtarma işini de kapsar; START beklerken ve HOLD altında işlemez. Zaman aşımı robot alarmı 0x0020'dir; tutarlı defteri 0x4000 yapmaz. |

Kaynaklar giriş çözme, RESTART sıfırlamaları, uzlaştırma sırası, ACK/RES sarması, ROBSAFE/RES koşulları, iş seçimi ve son çıkış maskesi bakımından karşılaştırıldı. JS'nin tamsayı denetimleri ST'nin INT tip sınırlarının karşılığıdır. Davranış değişikliği yalnız PLC tarafında; üretim simülatöründeki robot kontrolcüsü değiştirilmedi. Güç kesilmesi testinde kontrolcünün mevcut `stepRobot` güç kaybı yolu kullanıldı, terminal kayıt elle üretilmedi.

### Testler ve sonuçlar

- `npm test`: **187/187 geçti** — 26 izleme birim testi, 73 FAZ6 birim testi, 88 uçtan uca senaryo. Çıktı: `third-round-test.log`.
- Beş iş tipi × iki PLC düzeni: **10 yeni uçtan uca senaryo**. Alma, koyma, alt levha, üst levha ve eve dönüş gerçek robot işi sürerken kesildi; yalnız Fabrika/PLC değiştirildi, saha kontrolcüsü ve iş nesnesi korundu. Bir saniyelik disk görüntüsü geri yüklendi. START altı saniye geciktirildi; bu sürede iş nesnesi/konumu değişmedi, HOLD ve açılış biti korundu. START sonrası aynı SEQ/JOB/SLOT terminali doğrulandı. Her kesilen palet 18 paket, iki levha ve sarımla tamamlanıp aynı kimlikle rafa kondu; defter/envanter doğru, bardak kaybı, paket düşmesi, çarpışma ve hatalı palet sıfır.
- **İki yeni işsiz/yüklü senaryo:** alma terminalinden hemen sonra ve koyma sırasında ENABLE kesilerek gerçek 13 iptal sonucu üretildikten sonra yeniden açılış. ACK=RES ve R_PART, START öncesi terminal kayıt/HOLD korunması, START sonrası koyma ve aynı paletin depolanması doğrulandı. Bu senaryolar A'nın alarm vermeyen kilit yolunu kapsar.
- **`restart.mjs` JS paketleme eşdeğeri:** 520 s, üç JS PLC, 100 ms yoklama ve her yönde 100 ms gecikme; 30–460 s arasında 8 s aralıklı test paketi, sarf takviyesi, 150/290 s'de kalıcı paketleme restart, 156/296 s'de START. Her iki START'tan sonra DONE ilerledi; son durumda **2 sağlam palet / 36 paket depoda**, kayıp/düşme/çarpışma/hatalı palet 0, defter ve envanter doğru, palet alarmı yok.
- **`node repro.mjs 150`: geçti.** Aynı ACK=33/RES=32, JOB=2/SLOT=16, R_PART=true noktasında açıldı; 180 s'de COUNT=18 oldu. Betik depolamayı da doğrulamak için 520 s'ye uzatıldı ve assertion eklendi. Kesilen palet 18 paketle depoda; toplam depolanan 2, kayıp 0. Çıktı: `third-round-repro.log`.
- Birim kapsamı: her işte 1/17 sonucu ve yalnız bir kez sayma; altı saniyelik HOLD; yanlış terminal slot/levha/iş/kod, değişen ACK ve gerileyen RES; kabul sırası 30000→1; kurtarma sırasında ikinci restart; bir iş bayat terminalin ardından kabul edilmiş ikinci iş; işsiz/yüklü ve referanssız robot; B pimi kalkmadan HOLD'un açılmaması; 40 s iş zaman aşımı. Önceki “ev dışında/yüklü robot daima kilitli” beklentileri istenen yeni davranışla değiştirildi; kayıp, defter, çarpışma ve sevk eşikleri gevşetilmedi.
- `node tools/gen-plc.js`: dört hedef üretildi. Kaynak/üretilen ST ASCII, %MW adresleri ve tipleri mevcut testlerle doğrulandı; `plc/build/*.st` yeni FB ile güncellendi.

Gerçek OpenPLC/matiec derleme ve servis yeniden başlatma testi bu turda çalıştırılamadı: yerel WSL çağrısı `Wsl/Service/E_ACCESSDENIED` döndürdü. Dolayısıyla verilen gerçek OpenPLC kaydı başlangıç kanıtıdır; düzeltilmiş sürüm için burada sağlanan çalışma kanıtı JS kontrolcü/saha testleridir. Kaynak eşdeğerliği ve ST üretimi, gerçek OpenPLC çalıştırma doğrulaması olarak sunulmuyor. Kalıcı checksum/atomiklik, robot kaydının da kaybolması ve paletin sensörler arası belirsiz konumlarıyla ilgili önceki kapsam sınırları sürer.

## Dördüncü tur

4 Kasım 2026. Önce raporun üç turu, ardından `restart-openplc-2.log`, `restart.mjs`, shrink fiziği ve ST/JS kontrolcüleri okundu. Üçüncü turun robot işi/defter kurtarması korunuyor. Bu tur, yeniden açılışta proses kontrolü kesilmiş ürünün iyi palete kabul edilmesini kapatıyor.

### Bulgular ve seçilen fiziksel yol

Verilen gerçek OpenPLC çalışmasında robot ve defter kurtarması başarılı; kalite kaçağı ayrı bir sorun. START beklemesinde kapalı kalan bant/ısıtıcı/fan ve yeniden ısınma, paketin termal geçmişini bozabiliyor. PLC'nin gördüğü fırın **hava** sıcaklığı, ürünün çekirdek sıcaklığını veya kesinti öncesi maruziyetini kanıtlamıyor. Dolayısıyla `cupT`, `cupTau`, `warmLimit` veya `simDefect` kullanılarak iyi/kötü kararı eklenmedi.

**Seçim: fırın çıkışında durduruculu, iki yollu ayırıcı ve ayrı karantina kasası.** Robotun iş kümesini, sonuç protokolünü, mevcut kabul edilmiş iş kurtarmasını ve palet defterini değiştirmeden şüpheli ürünü robotun önünden ayırıyor. PLC geçiş veya red yönünü seçiyor; simülatör yalnız 250 ms aktüatör strokunu, paket hareketini, konum/fotosel bilgilerini ve fiziksel sayaçları gerçekleştiriyor. Komut yokken veya iki komut birlikteyken durdurucu kapalı; uygun aktüatör konumu oluşmadan paket geçmiyor. Sağlam test paketi bile red çıkışı verilirse reddediliyor; gizli kalite bilgisi bu yolu seçmiyor.

PLC'de yeni kalıcı kuyruk yerine **sensörlerden yeniden kurulabilen karantina grubu** seçildi:

1. İlk geçerli I/O görüntüsündeki `RESTART` taramasında `(IN_CNT - OUT_CNT) MOD 30000 > 0`, `PACK_IN_WRAP` veya plaka sıra fotosellerinden herhangi biri varsa `QUARANTINE` kurulur. Eski `W_STP` kaybolmuş olsa da sarıcıdaki fiziksel paket ölçülür.
2. START öncesi bütün shrink çıkışları, ayırıcı dahil, sıfırdır. RESET, STOP ve alarm onayı karantinayı silmez.
3. START sonrası mevcut sarma tamamlanır; eski plakadaki grup işlenir. Tek sıra varsa ikinci sıra eklenir ve altı bardak birlikte karantinaya gider. Bu muhafazakâr seçim üç yeni bardağı da reddedebilir. Yeni bir plaka/grup üretime katılamaz; mevcut iticilerin dönüş adımları tamamlanabilir.
4. Karantina sürerken fırın bandıyla birlikte yalnız `EXIT_REJECT` verilir. Mevcut sıcaklık, sarma ve bırakma kilitleri korunur. `INSIDE=0`, sarıcı/plaka boş ve `G_STP=W_STP=0` birlikte görülmeden `EXIT_PASS` açılamaz.
5. Bu sırada ikinci PLC açılışı olursa aynı fiziksel ürünler sayaç/sensörlerde durur; oturum bayrağının kaybı ürünün iyi sayılmasına yol açmaz. Testte hem START öncesinde hem ilk red gerçekleşip boşaltma sürerken tekrar açılış yapıldı.

Fırın giriş fotoseli paket sarıcıdan banda geçtiği **s=0 transferine** taşındı. Önceki 0..0,05 m aralığında sarıcı boş göründüğü halde `IN_CNT` henüz artmamış olabiliyordu. Yeni sayaç, bu kısa fakat gerçek yeniden açılış körlüğünü kapatır. `OUT_CNT` ayırıcıdan normal geçişte veya fiziksel redde tam bir kez artar; kapıda bekleyen paket içeride sayılmaya devam eder. Böylece ikinci açılışta red borcu ayrıca saklanmak zorunda değildir. Ürünü beklerken duran/soğuyan bir sayaçtan iyi ürün varsayımı çıkarılmaz.

### Defter, sayım ve izleme

- Red paket robot alma noktasına ulaşmaz, robot koyma sonucu üretmez ve `PAL_COUNT` artırmaz. Robotun kesintiden önce kabul ettiği mevcut işler üçüncü turdaki uzlaştırmayla sürer. `%MW` alanları ve checksum şeması değişmedi; yeni kalıcı alan yok.
- Harita 6'daki `%MW32..43` defter şeması aynıdır. Bu nedenle yalnız sağlam checksum, alan, robot sonucu ve fiziksel palet doğrulamalarını geçen v6 kayıt normal commit yoluyla v7'ye geçirilir. COUNT sıfırlanmaz; bir iş bayat koyma önceki kuralla bir kez uzlaştırılır. Bozuk v6 checksum göç sırasında kabul edilmez; eski v5/missing-checksum kayıtlar yine kilitlenir. Program yüklemesinin saklama dosyasını silebilmesiyle ilgili dağıtım sınırı devam eder.
- Sim KPI `packsRejected` ve `cupsQuarantined` fiziksel karantinayı ayrı sayar. Kontrollü red `lostCups` veya `packsDropped` değildir. `packsGood/packsBad` robotun aldığı paketlerdeki önceki kalite değerlendirmesi olarak kalır; dolum `shippedGood` sayacı dolumdan çıkan bardakları ifade etmeye devam eder. Testte bu bardakların tamamı çıkış bandı, şerit, plaka, sarıcı, paket bandı, robot, palet/depo veya karantina içinde bire bir bulundu; kayıp gizlenmedi.
- `SHR_QW_PACKS` eski fırına bırakma oturum sayacıdır. İzleme artık aynı fiziksel ayırıcı noktasındaki `GOOD = (OUT_CNT - REJECT_CNT) MOD 30000` ve `REJECT` sayaçlarını kullanır; red bir kez sayılır, bırakma toplamına ikinci kez eklenmez. Gizli sim kalitesi OEE hesabına katılmaz.
- `pack_pass` ve `pack_reject` olayları, izleme DB'sinde `ts_passed`, `ts_rejected`, `reject_where` ile kaydedilir. DB şeması 2'dir; mevcut DB'ye sütun göçü vardır. Red olayının tekrar oynatılması aynı mutlak kaydı günceller. Uzlaştırmaya ayrı karantina satırı eklendi. Karantina STATUS bit 8 ile HAZIRLIK sayılır; aynı STATE kodunda STATUS kategori değişimi de aralığı kapatıp açar. ARIZA/GÜVENLİK önceliği korunur.
- 3D sahnede çıkış ayırıcısı, ayrı etiketli kasa ve reddedilen paketler; panelde red adedi ve karantina durum biti gösterilir. `restart.mjs` çıktısına fiziksel/PLC red sayacı ve karantina bardak adedi eklendi; sonuç dosyası betiğin kendi dizinine yazılır.

### Harita 7 ve ST/JS eşliği

Mevcut Modbus aralıkları ve adresleri korunur; boş ofsetler kullanılır:

| Adres / bit | Etiket | Anlam |
|---|---|---|
| IR57, WORD | SHR_IW_DIVERT | Bit 0 çıkış durdurucusunda paket, bit 1 red konumu, bit 2 geçiş konumu |
| IR58, INT | SHR_IW_REJECT_CNT | Fiziksel red sayacı, 0..29999 |
| HR55, INT | SHR_QW_REJECT | PLC'nin okuduğu fiziksel red sayacı |
| HR56, INT | SHR_QW_GOOD | Normal ürün bandına geçiş sayacı, 0..29999 |
| SHR_QW_DO bit 9 / 10 | EXIT_PASS / EXIT_REJECT | Normal geçiş / karantina ayırma komutu |
| SHR_QW_STATUS bit 8 | QUARANTINE | Kesilen grubu karantinaya boşaltma |

`public/iomap.js` MAP_VERSION=7; ortak harita kontrolü ve dört üretilen ST hedefi 7. Palet commit'i sürüm 7 yazar; yukarıdaki doğrulanmış v6 okuma uyumluluğu bilinçlidir. `FB_Shrink.st`/`fb_shrink.js` içinde açılış kararı, yeni grup kilidi, fiziksel boşlukla temizleme, çıkış bitleri ve sayaç aritmetiği eşleştirildi; `Paketleme.st`/`fabrika.js` bağlantıları birlikte güncellendi. Üretici DIVERT bit kelimesini WORD olarak çıkarır. Kaynak/üretilen ST ASCII ve kalıcı adres/tip kontrolleri geçti.

### Dördüncü tur doğrulaması

- **`npm test`: 208/208 geçti** — 28 izleme birim testi, 84 FAZ6 birim testi, 96 uçtan uca senaryo. Tam çıktı: `fourth-round-test.log`. Önceki 187 test korunuyor; kalite/kayıp/defter eşikleri gevşetilmedi.
- **8 yeni uçtan uca senaryo:** tek PLC ve üç PLC × fırın içi, çalışan sarıcı, tek sıralı plaka, s=0 giriş bölgesi. 100 ms yoklama ve her yönde 100 ms gecikme; yeni Fabrika, 1000 ms disk kopyası, saha nesneleri korunuyor. Her testte karantina sırasında ikinci açılış, ilk kesintiden 8 s sonra START, kesilen bardakların tamamının red kasasında oluşu, red kayıtlarında palet/geçiş/koyma olmaması, fiziksel bardak bilançosu, izleme/PLC red uzlaştırması ve sağlam palet depolama doğrulandı. Her birinde 1 paket/6 bardak karantinada; hatalı palet, kayıp, düşme ve çarpışma 0. Tek PLC yeniden açılışında tankın yeni CIP şartı ayrıca yerine getirildi.
- **11 yeni FAZ6 birim testi:** fırın/sarma/tek sıra/dolu plaka ve sayaç sarması açılışları; RESET/STOP ve ikinci açılış; boş başlangıçta normal geçiş; komutsuz/çelişkili çıkışta fiziksel durdurma; red sayaç sarması; transfer körlüğü; iki fırın paketi + sarıcı + dolu plakanın birlikte 4 paket/24 bardak reddi ve ilk red sonrası yeniden açılış; sağlam v6 bayat koyma uzlaştırması; bozuk v6 checksum'un reddi. İki yeni izleme testi aynı STATE içinde karantina kategori geçişini ve reddin iyi adede eklenmemesini doğrular.
- **`restart.mjs` JS eşdeğeri:** 520 s; 150/290 s restart, 156/296 s START, test besleyici ve sarf takviyesi. Kesinti anındaki ürün kimlikleri sonradan karantina kasasında doğrulandı. Sonuç: **2 paket / 12 bardak karantinada, 2 sağlam palet / 36 paket depoda**, son B defteri 14, defter/envanter `ok`; `palletsBad=0`, `packsBad=0`, `lostCups=0`, `packsDropped=0`, `robotCrashes=0`. Her iki START'tan sonra palet tamamlama ilerledi; önceki robot kurtarma regresyonları geçti.
- **`node tools/gen-plc.js`: geçti**, dört hedef üretildi. `plc/build/*.st` güncel; program kalıcı adresleri/tipleri, WORD girişler ve ASCII test edildi.

Gerçek OpenPLC/matiec ve servis yeniden başlatma denemesi bu ortamda yapılmadı: `wsl --list --quiet` çağrısı `Wsl/EnumerateDistros/Service/E_ACCESSDENIED` döndürdü. Buradaki sonuçlar JS PLC + fiziksel saha modeli ve ST üretimi kanıtıdır; gerçek OpenPLC çalışma kanıtı olarak sunulmaz. Bu değişiklik yeniden açılışta ölçülen mevcut grubu karantinaya alır; bütün duruş türleri için genel raf ömrü/ürün sıcaklığı validasyonu eklemez. Karantina kasası, mevcut bardak red toplaması gibi kapasitesi sınırlandırılmayan bir toplama alanıdır; kasa doluluk sensörü/bakım akışı modellenmedi. Kalıcı dosya atomikliği ve bağımsız robot kayıtlarının kaybıyla ilgili önceki sınırlar sürer.
