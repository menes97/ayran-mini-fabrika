// İzleme senaryoları için kontroller: izleme veritabanı simülatörün gerçeğiyle tutuyor mu?
import { palletLabel } from '../monitor/db.js';

const s = (ms) => ms / 1000;

// Depodaki her paletin kimlikli izlemesi (slot → paket → bardaklar) raftaki gerçek paletle aynı mı?
export function traceMatchesSim(sim, mon) {
  const pallets = sim.asrs.rack.filter(Boolean);
  for (const p of pallets) {
    const tr = mon.trace(palletLabel(sim.trace.run, p.id));
    if (!tr) return { err: `palet #${p.id} izleme DB'sinde yok`, n: pallets.length };
    for (let i = 0; i < p.slots.length; i++) {
      const real = p.slots[i];
      const got = tr.packs.find((k) => k.slot === i + 1);
      if (!real && !got) continue;
      if (!real || !got || real.id !== got.pack) {
        return { err: `palet #${p.id} slot ${i + 1}: rafta ${real?.id}, izlemede ${got?.pack}`, n: pallets.length };
      }
      if (real.test) continue;
      const a = real.cups.map((c) => c.id).join(','), b = got.cups.map((c) => c.cup).join(',');
      if (a !== b) return { err: `paket #${real.id}: bardaklar rafta [${a}], izlemede [${b}]`, n: pallets.length };
    }
  }
  return { err: null, n: pallets.length };
}

// kategori süreleri toplamı aralık süresine eşit mi (hiçbir an iki kez ya da hiç sayılmamış mı)
export function timesConsistent(o) {
  const sum = Object.values(o.times).reduce((a, b) => a + b, 0);
  return Math.abs(sum - o.span) < 1 ? null : `${o.cell}: kategori toplamı ${s(sum)} s, aralık ${s(o.span)} s`;
}

export const fmt = (o) => ({
  A: o.A?.toFixed(3), P: o.P?.toFixed(3), Q: o.Q?.toFixed(3), OEE: o.OEE?.toFixed(3), n: o.total,
  ...Object.fromEntries(Object.entries(o.times).filter(([, v]) => v > 0).map(([k, v]) => [k, Math.round(v / 1000)])),
});

export const oeeOf = (mon, cell, t0 = 0, t1 = mon.lastTs) => mon.oee(t0, t1).find((o) => o.cell === cell);
