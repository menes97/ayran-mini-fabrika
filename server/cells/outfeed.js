// Dolum makinesinin çıkış bandı: bardaklar birikir, bandın sonunda gruplama şeridi alır.
import { SPEC } from '../../public/iomap.js';

const C = {
  speed: 0.12,       // m/s bant hızı
  spacing: 0.082,    // m, yan yana iki bardağın merkez aralığı
};
export const OUTFEED_LENGTH = (SPEC.outfeedCapacity - 1) * C.spacing;

export class Outfeed {
  constructor(fab) {
    this.fab = fab;
    this.cups = [];    // [0] bandın sonuna en yakın (en eski)
  }

  // Giriş fotoseli: birikme bandın başına kadar geldiyse dolu
  get full() { return this.cups.length >= SPEC.outfeedCapacity; }

  push(cup) {
    cup.pos = 0;
    this.cups.push(cup);
  }

  step(dt) {
    // her bardak önündekine (ya da bandın sonuna) dayanana kadar ilerler
    this.cups.forEach((c, i) => {
      const limit = OUTFEED_LENGTH - i * C.spacing;
      c.pos = Math.min(limit, c.pos + C.speed * dt);
    });
    // bandın sonundaki bardak, gruplama şeridi kabul ederse geçer (kapı kapalıysa ya da şerit doluysa bekler)
    const head = this.cups[0];
    if (head && head.pos >= OUTFEED_LENGTH - 1e-6 && !this.fab.faults.outBlocked && this.fab.shrink.acceptCup(head)) {
      this.cups.shift();
    }
  }
}
