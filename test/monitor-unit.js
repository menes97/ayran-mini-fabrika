// İzleme katmanı birim testleri: sayaç sarması / PLC yeniden başlaması, OEE matematiği,
// vardiya sınırı, izleme servisi yeniden başlaması, olay akışı run değişimi.
import { counterDelta } from '../monitor/collector.js';
import { Monitor } from '../monitor/monitor.js';
import { shiftOf } from '../monitor/oee.js';
import { tagAddr } from '../public/iomap.js';

let fails = 0;
const check = (name, cond, info = '') => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} Birim: ${name}${cond ? '' : ` (${info})`}`);
  if (!cond) fails++;
};

// ---- sayaçlar
const W = { wrap: 30001 };
check('sayaç normal artış', counterDelta(W, 10, 13).d === 3);
check('sayaç 30000 → 0 sarması', (() => { const r = counterDelta(W, 29999, 2); return r.d === 4 && r.wrapped; })());
check('PLC yeniden başladı (12000 → 3)', (() => { const r = counterDelta(W, 12000, 3); return r.d === 3 && r.reset; })());
check('ilk örnekte fark yok', counterDelta(W, null, 500).d === 0);
check('palet seviyesi: 17 → 18 → 0 → 1', [counterDelta({ level: true }, 17, 18).d, counterDelta({ level: true }, 18, 0).d,
  counterDelta({ level: true }, 0, 1).d].join() === '1,0,1');

// ---- sentetik PLC görüntüsüyle OEE: 60 s üretim (12 bardak), 30 s alarm, 30 s ısınma
{
  const mon = new Monitor();
  const img = new Array(112).fill(0);
  const S = tagAddr('DOL_QW_STATE'), G = tagAddr('DOL_QW_GOOD'), R = tagAddr('DOL_QW_REJECT'), AL = tagAddr('DOL_QW_ALARM');
  const at = (ts, state, good, rej = 0, alarm = 0) => {
    img[S] = state; img[G] = good; img[R] = rej; img[AL] = alarm; mon.sample(ts, { tek: [...img] });
  };
  at(0, 1, 29995);                                   // sayaç sarmaya yakın başlar
  for (let i = 1; i <= 12; i++) at(i * 5000, 1, (29995 + i) % 30001, i === 12 ? 1 : 0);
  at(60000, 3, 6, 1, 1 << 5);                        // ısıtıcı alarmı
  at(90000, 5, 6, 1, 0);                             // ısınma
  at(120000, 1, 6, 1, 0);
  const o = mon.oee(0, 120000).find((x) => x.cell === 'dolum');
  check('OEE: kullanılabilirlik 60/120', Math.abs(o.A - 0.5) < 1e-9, o.A);
  check('OEE: sayaç sarmasına rağmen 12 sağlam + 1 red', o.good === 12 && o.reject === 1, `${o.good}/${o.reject}`);
  check('OEE: performans = 13 × 4,5 s / 60 s', Math.abs(o.Praw - (13 * 4.5) / 60) < 1e-9, o.Praw);
  check('OEE: kalite 12/13', Math.abs(o.Q - 12 / 13) < 1e-9, o.Q);
  check('OEE: ARIZA 30 s, HAZIRLIK 30 s', o.times.ARIZA === 30000 && o.times.HAZIRLIK === 30000, JSON.stringify(o.times));
  const a = mon.alarmHistory(0, 120000);
  check('alarm olayı açılıp kapandı', a.length === 1 && a[0].ts_on === 60000 && a[0].ts_off === 90000, JSON.stringify(a));
  // vardiya sınırı: [30 s, 75 s) penceresi aralıkları kırpar
  const w = mon.categoryTimes('dolum', 30000, 75000).times;
  check('pencere kırpma: 30 s üretim + 15 s arıza', w.URETIM === 30000 && w.ARIZA === 15000, JSON.stringify(w));
  // izleme kapalıyken geçen süre: 120 s'den sonra örnek yok → VERI_YOK
  mon.clock = () => 200000;
  const g = mon.categoryTimes('dolum', 0, 200000).times;
  mon.clock = null;
  check('kayıtsız süre VERI_YOK sayılır', g.VERI_YOK === 80000, g.VERI_YOK);
}

// ---- izleme servisi yeniden başlar: açık aralık son örnekte kapanır, sayaç DB'den sürer
{
  const file = `${process.env.TEMP || '/tmp'}/ayran-mon-unit-${process.pid}.db`;
  const img = new Array(112).fill(0);
  const S = tagAddr('DOL_QW_STATE'), G = tagAddr('DOL_QW_GOOD');
  let mon = new Monitor({ file });
  img[S] = 1; img[G] = 100; mon.sample(1000, { tek: [...img] });
  img[G] = 105; mon.sample(10000, { tek: [...img] });
  mon.db.close();
  mon = new Monitor({ file });                       // servis 50 s kapalı kaldı, PLC 8 bardak daha üretti
  img[G] = 113; mon.sample(60000, { tek: [...img] });
  const o = mon.oee(0, 60000).find((x) => x.cell === 'dolum');
  check('yeniden başlama: kapalı süre VERI_YOK', o.times.VERI_YOK === 50000 + 1000, JSON.stringify(o.times));
  check('yeniden başlama: boşluğu kapsayan fark OEE\'ye girmez', o.good === 5 && o.unobserved === 8, `${o.good}/${o.unobserved}`);
  const rec = mon.reconcile(0, 60000)[0];
  check('yeniden başlama: sayaç farkı uzlaştırmada kaybolmaz', rec.plc === 13, rec.plc);
  mon.db.close();
}

// ---- olay akışı: simülatör yeniden başladı (run değişti) → imleç sıfırlanır, sahte boşluk yazılmaz
{
  const mon = new Monitor();
  const ev = (seq, cup) => ({ seq, type: 'cup', t: seq, ts: seq * 1000, cup, result: 'out', transfers: [] });
  mon.events({ run: 'aaaa', first: 1, last: 3, events: [ev(1, 1), ev(2, 2), ev(3, 3)] });
  const back = mon.events({ run: 'bbbb', first: 1, last: 2, events: [ev(2, 2)] });   // eski imleçle (after=1) istenmiş
  check('run değişimi: yanıt işlenmez, baştan yeniden istenir', back === -1 && mon.ingest.cursor.last_seq === 0);
  mon.events({ run: 'bbbb', first: 1, last: 2, events: [ev(1, 1), ev(2, 2)] });
  const n = mon.db.prepare('SELECT COUNT(*) AS n FROM cup').get().n;
  check('run değişimi: iki çalıştırmanın bardakları ayrı (3 + 2)', n === 5, n);
  check('run değişimi: sahte boşluk yok', mon.gaps().ingest.length === 0);
  mon.events({ run: 'bbbb', first: 10, last: 11, events: [ev(10, 10), ev(11, 11)] });
  const g = mon.gaps().ingest;
  check('olay kaybı: 3..9 boşluğu', g.length === 1 && g[0].from_seq === 3 && g[0].to_seq === 9, JSON.stringify(g));
}

// ---- CIP bir veri boşluğunda biter: bitiş = son görülen CIP anı, "belirsiz" işaretli
{
  const mon = new Monitor();
  const img = new Array(112).fill(0);
  const S = tagAddr('TNK_QW_STATE'), RES = tagAddr('TNK_QW_CIP_RES');
  for (let ts = 1000; ts <= 5000; ts += 1000) { img[S] = 7; mon.sample(ts, { tek: [...img] }); }
  for (let ts = 6000; ts <= 9000; ts += 1000) mon.sample(ts, { tek: null });
  img[S] = 1; img[RES] = 1; mon.sample(10000, { tek: [...img] }); mon.sample(10250, { tek: [...img] });
  const c = mon.cips()[0];
  check('CIP boşlukta biter: bitiş son görülen an, belirsiz', c && c.ts_end === 5000 && c.end_uncertain === 1 && c.result === 1,
    JSON.stringify(c));
}

// ---- boşluksuz CIP: bitiş = son CIP örneği; hemen sonra başlayan aktarım bu CIP'e bağlanır,
//      başlangıç stoku hiçbir CIP'e bağlanmaz
{
  const mon = new Monitor();
  const img = new Array(112).fill(0);
  const S = tagAddr('TNK_QW_STATE'), RES = tagAddr('TNK_QW_CIP_RES');
  for (let ts = 1000; ts <= 5000; ts += 1000) { img[S] = 7; mon.sample(ts, { tek: [...img] }); }
  img[S] = 1; img[RES] = 1; mon.sample(6000, { tek: [...img] }); mon.sample(7000, { tek: [...img] });
  const c = mon.cips()[0];
  check('CIP bitişi son görülen CIP örneği', c && c.ts_end === 5000 && c.end_uncertain === 0, JSON.stringify(c));
  mon.events({ run: 'cccc', first: 1, last: 2, events: [
    { seq: 1, type: 'transfer_start', t: 0, ts: 0, transfer: 0, lot: 0, initial: true },
    { seq: 2, type: 'transfer_start', t: 5.5, ts: 5500, transfer: 1, lot: 1 }] });
  const rows = mon.db.prepare('SELECT transfer, last_cip FROM transfer_cip ORDER BY transfer').all();
  check('yoklama gecikmesindeki aktarım CIP sonrası; başlangıç stoku CIP\'siz',
    rows.length === 2 && rows[0].last_cip == null && rows[1].last_cip === c.cip_id, JSON.stringify(rows));
}

// ---- vardiyalar
{
  const d = new Date(2026, 10, 4, 13, 59).getTime(), e = new Date(2026, 10, 4, 23, 30).getTime(), f = new Date(2026, 10, 5, 3, 0).getTime();
  const a = shiftOf(d), b = shiftOf(e), c = shiftOf(f);
  check('vardiya 06-14', a.t1 - a.t0 === 8 * 3600e3 && new Date(a.t0).getHours() === 6, a.name);
  check('gece vardiyası gece yarısını aşar', b.id === c.id && new Date(b.t0).getHours() === 22, `${b.id} ${c.id}`);
  const m = shiftOf(125 * 60000, { shiftMin: 15 });
  check('demo vardiyası 15 dk', m.t0 === 120 * 60000 && m.t1 === 135 * 60000, JSON.stringify(m));
}

{
  const mon = new Monitor(); const img = new Array(112).fill(0);
  const S = tagAddr('SHR_QW_STATE'), ST = tagAddr('SHR_QW_STATUS'), R = tagAddr('SHR_QW_REJECT');
  img[S] = 2; mon.sample(0, { tek: [...img] });
  img[ST] = 0x100; mon.sample(1000, { tek: [...img] });
  img[R] = 1; mon.sample(2000, { tek: [...img] });
  img[ST] = 0; mon.sample(3000, { tek: [...img] });
  mon.sample(4000, { tek: [...img] });
  const o = mon.oee(0, 4000).find(c => c.cell === 'shrink');
  check('karantina: aynı STATE içinde STATUS kategori değiştirir', o.times.HAZIRLIK === 2000 && o.times.URETIM === 2000);
  check('karantina: red, iyi üretime eklenmez', o.good === 0 && o.reject === 1 && o.total === 1);
}

if (fails) { console.log(`\n${fails} birim testi başarısız.`); process.exit(1); }
