// Hat takip olay akışı: simülatördeki "saha cihazlarının" (kontrol tartısı, paket etiketi, robot
// kontrolcüsü, palet etiketi, depo okuyucuları, kamyon rampası) kimlikli ürün hareketlerini yayınlar.
// İzleme servisi bunları sıra numarasıyla çeker (GET /api/events?after=<seq>).
//
// - Halka tampon: en eski olaylar düşer; okuyucu geride kalırsa aradaki kaybı `first` ile fark eder.
// - `run`: simülatörün her açılışında yeni kimlik. Yeniden başlayınca bardak numaraları 1'den başlar,
//   izleme servisi kayıtları (run, numara) ile tuttuğu için çakışmaz.
// - Olaylar yalnızca sahada ölçülebilen bilgiyi taşır. `simDefect` simülatörün gizli gerçeğidir;
//   izleme servisi onu ayrı tutar ve hesaplarda kullanmaz.
import crypto from 'node:crypto';

export class Trace {
  constructor({ cap = 20000, run } = {}) {
    this.cap = cap;
    this.run = run ?? crypto.randomBytes(4).toString('hex');
    this.seq = 0;
    this.buf = [];
  }

  emit(ev) {
    ev.seq = ++this.seq;
    this.buf.push(ev);
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
    return ev;
  }

  get first() { return this.buf.length ? this.buf[0].seq : this.seq + 1; }

  // after'dan sonraki olaylar (en fazla max). first > after + 1 ise aradakiler kaybolmuştur.
  since(after = 0, max = 2000) {
    const first = this.first;
    let i = Math.max(0, after + 1 - first);
    const events = this.buf.slice(i, i + max);
    return { run: this.run, first, last: this.seq, events };
  }
}
