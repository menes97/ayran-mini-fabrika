// İzleme paneli: izleme servisinin JSON API'sini 2 s'de bir okur, SVG ile çizer (harici kütüphane yok).
const $ = (id) => document.getElementById(id);
const get = (url) => fetch(url).then((r) => r.json());
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)} %`);
const hms = (ms) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h} sa ${m} dk` : m ? `${m} dk ${x} s` : `${x} s`;
};
const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString('tr-TR') : '—');
const dt = (ts) => (ts ? new Date(ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

let META = null;
let tab = 'genel';
let stopWin = 3600;
let selected = null, selectedPack = null;
let reportAt = null;

const catColor = (c) => META.categories[c]?.color ?? '#555';
const catLabel = (c) => META.categories[c]?.label ?? c;
const cellName = (id) => META.cells.find((c) => c.id === id)?.name ?? id;
const stateText = (cell, s) => (s < 0 ? 'Veri yok' : META.states[cell]?.[s] ?? `durum ${s}`);

// ---------------------------------------------------------------- sekmeler
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === `tab-${tab}`));
  refresh();
}));
document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => {
  stopWin = b.dataset.win === 'shift' ? 'shift' : Number(b.dataset.win);
  document.querySelectorAll('[data-win]').forEach((x) => x.classList.toggle('on', x === b));
  refresh();
}));
$('alarm-all').addEventListener('change', refresh);
$('label-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { selected = e.target.value.trim(); selectedPack = null; refresh(); } });
$('print').addEventListener('click', () => window.print());
$('prev-shift').addEventListener('click', async () => {
  const r = await get(`/api/report${reportAt ? `?at=${reportAt}` : ''}`);
  reportAt = r.shift.t0 - 1; refresh();
});
$('this-shift').addEventListener('click', () => { reportAt = null; refresh(); });

// ---------------------------------------------------------------- üst bilgi
function renderStatus(st, shift) {
  $('shift').textContent = `${shift.name} · ${clock(shift.t0)}–${clock(shift.t1)} · ${st.mode === 'tek' ? 'tek PLC' : 'üç PLC'}`;
  $('status').innerHTML = [
    ...st.plcs.map((p) => `<span class="pill ${p.ok ? 'ok' : ''}" title="${esc(p.err || p.addr)}"><i></i>${esc(p.name)}</span>`),
    `<span class="pill ${st.events.ok ? 'ok' : ''}" title="${esc(st.events.err || st.events.url)}"><i></i>Hat takibi</span>`,
  ].join('');
}

// ---------------------------------------------------------------- genel bakış
function ring(svg, v) {
  const r = 50, c = 2 * Math.PI * r, f = v == null ? 0 : Math.max(0, Math.min(1, v));
  const col = v == null ? '#555' : v >= 0.85 ? 'var(--green)' : v >= 0.6 ? 'var(--yellow)' : 'var(--red)';
  svg.innerHTML = `<circle cx="60" cy="60" r="${r}" fill="none" stroke="#24303c" stroke-width="12"/>
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round"
      stroke-dasharray="${c * f} ${c}" transform="rotate(-90 60 60)"/>
    <text x="60" y="66" text-anchor="middle" style="font:600 24px var(--mono);fill:var(--text)">${v == null ? '—' : (v * 100).toFixed(0) + '%'}</text>`;
}
const bar = (label, v, color = 'var(--blue)', note = '') => `<div class="bar"><span>${label}</span>
  <div class="track"><div class="fill" style="width:${v == null ? 0 : Math.min(100, v * 100)}%;background:${color}"></div></div>
  <span class="v">${v == null ? (note || '—') : (v * 100).toFixed(1) + '%'}</span></div>`;

function renderOverview(o) {
  const d = o.oeeShift.find((x) => x.cell === 'dolum');
  ring($('oee-ring'), d.OEE);
  $('apq').innerHTML = bar('Kullanılabilirlik', d.A, 'var(--green)') + bar('Performans', d.P, 'var(--blue)')
    + bar('Kalite', d.Q, 'var(--yellow)') + `<div class="sub">Üretim ${hms(d.times.URETIM)} / planlı ${hms(d.planned)} · ${d.total} bardak, ${d.reject} red
      · ideal ${d.idealS} s/bardak${d.times.VERI_YOK > 1000 ? ` · veri yok ${hms(d.times.VERI_YOK)}` : ''}</div>`;
  const k = o.counters, y = o.lineYield;
  const counter = (n, l) => `<div class="counter"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  $('counters').innerHTML = counter(k.cupsOut, 'sağlam bardak') + counter(k.cupsRejected, 'reddedilen bardak')
    + counter(k.packs, '6\'lı paket') + counter(k.pallets, 'tamamlanan palet') + counter(k.stored, 'depolanan palet')
    + counter(k.inStock, 'depoda (stok)') + counter(k.shipped, 'sevk edilen palet') + counter(k.cips, 'CIP')
    + counter(y.rate == null ? '—' : `${(y.rate * 100).toFixed(0)}%`, 'hat sonu verimi (depoya ulaşan bardak)');

  const cur = Object.fromEntries(o.current.map((c) => [c.cell, c]));
  $('cells').innerHTML = o.oeeShift.map((c) => {
    const now = cur[c.cell] || { state: -1, category: 'VERI_YOK', ts_start: o.status.now };
    const plc = META.cells.find((x) => x.id === c.cell).plc;
    const val = c.oee ? c.OEE : c.utilization;
    return `<div class="cell" style="border-left-color:${catColor(now.category)}">
      <div class="name">${esc(c.name)}</div>
      <div class="plc">${o.status.mode === 'tek' ? 'tek PLC' : META.plcs.find((p) => p.id === plc).name}</div>
      <div class="state"><span class="chip" style="background:${catColor(now.category)}">${esc(catLabel(now.category))}</span>
        ${esc(stateText(c.cell, now.state))} <span class="muted">· ${hms(o.status.now - now.ts_start)}</span></div>
      <div class="big">${val == null ? '—' : (val * 100).toFixed(0) + '%'} <span class="sub">${c.oee ? (c.qualityMeasured ? 'OEE' : 'OEE (Q ölçülmüyor)') : 'kullanım'}</span></div>
      <div class="mini">${c.oee ? `A ${pct(c.A)} · P ${pct(c.P)} · Q ${c.qualityMeasured ? pct(c.Q) : '—'}` : `${c.total} ${c.unit}`}</div>
    </div>`;
  }).join('');

  $('active').innerHTML = o.active.length ? `<table><tr><th>Hücre</th><th>Alarm</th><th>Başlangıç</th><th class="num">Süre</th></tr>
    ${o.active.map((a) => `<tr><td>${esc(cellName(a.cell))}</td><td style="color:${a.severity === 'alarm' ? 'var(--red)' : 'var(--yellow)'}">${esc(a.text)}</td>
      <td>${clock(a.ts_on)}</td><td class="num">${hms(o.status.now - a.ts_on)}</td></tr>`).join('')}</table>`
    : '<div class="muted">Aktif alarm yok.</div>';
  $('reconcile').innerHTML = `<table><tr><th>Sayaç</th><th class="num">PLC</th><th class="num">Hat takibi</th><th class="num">Fark</th></tr>
    ${o.reconcile.map((r) => `<tr><td>${esc(r.what)}</td><td class="num">${r.plc}</td><td class="num">${r.trace ?? '—'}</td>
      <td class="num" style="color:${r.diff ? 'var(--yellow)' : 'inherit'}">${r.diff ?? '—'}</td></tr>`).join('')}</table>
    <div class="note">Dolum sayacı red istasyonunda, olay cepten çıkışta yazılır: en çok 2 bardaklık fark olağandır.
    ${o.gaps.ingest.length ? `<br><b style="color:var(--yellow)">Olay akışında ${o.gaps.ingest.length} kayıp aralığı var.</b>` : ''}</div>`;
}

async function renderTimeline() {
  const now = Date.now(), t0 = now - 3600e3;
  const rows = await get(`/api/timeline?from=${t0}&to=${now}`);
  const svg = $('timeline'), W = svg.clientWidth || 1000, L = 120, R = 10, H = 24, top = 6;
  const cells = META.cells.map((c) => c.id);
  const x = (ts) => L + ((ts - t0) / (now - t0)) * (W - L - R);
  let s = '';
  cells.forEach((id, i) => {
    const y = top + i * (H + 4);
    s += `<text x="0" y="${y + 16}">${esc(cellName(id))}</text><rect x="${L}" y="${y}" width="${W - L - R}" height="${H}" fill="#1b232b"/>`;
    for (const r of rows.filter((q) => q.cell === id)) {
      const a = x(r.ts_start), b = x(r.ts_end);
      if (b - a < 0.3) continue;
      s += `<rect x="${a}" y="${y}" width="${b - a}" height="${H}" fill="${catColor(r.category)}"><title>${esc(cellName(id))}: ${esc(stateText(id, r.state))}
${clock(r.ts_start)}–${clock(r.ts_end)} (${hms(r.ts_end - r.ts_start)})</title></rect>`;
    }
  });
  const yb = top + cells.length * (H + 4) + 14;
  for (let m = 0; m <= 60; m += 10) s += `<text x="${x(t0 + m * 60e3)}" y="${yb}" text-anchor="middle">${m === 60 ? 'şimdi' : `-${60 - m} dk`}</text>`;
  svg.setAttribute('height', yb + 6);
  svg.innerHTML = s;
  $('legend').innerHTML = Object.entries(META.categories).map(([k, v]) => `<span><i style="background:${v.color}"></i>${esc(v.label)}</span>`).join('');
}

// ---------------------------------------------------------------- duruşlar
async function renderStops(shift) {
  const now = Date.now(), t0 = stopWin === 'shift' ? shift.t0 : now - stopWin * 1000;
  const d = await get(`/api/stops?from=${t0}&to=${now}`);
  const cats = Object.keys(META.categories);
  $('stack').innerHTML = d.oee.map((c) => {
    const tot = c.span || 1;
    return `<div class="stack-row"><span>${esc(c.name)}</span><div class="stack">${cats.filter((k) => c.times[k] > 0).map((k) =>
      `<div style="width:${(c.times[k] / tot) * 100}%;background:${catColor(k)}" title="${esc(catLabel(k))}: ${hms(c.times[k])}"></div>`).join('')}</div>
      <span class="mono">${pct(c.oee ? c.OEE : c.utilization)}</span></div>`;
  }).join('') + `<div class="legend" style="margin:8px 0 0">${cats.map((k) => `<span><i style="background:${catColor(k)}"></i>${esc(catLabel(k))}</span>`).join('')}</div>
    <div class="note">Yüzde: OEE (dolum, shrink, paletleme) ya da kullanım oranı (tank, AGV, depo). Payda takvim süresi; yalnızca "veri yok" düşülür.</div>`;
  const dl = d.oee.find((c) => c.cell === 'dolum');
  const micro = d.micro.find((m) => m.cell === 'dolum');
  $('losstree').innerHTML = `<table><tr><th>Kayıp</th><th></th><th class="num">Süre</th><th class="num">Kayıp adet</th></tr>
    ${dl.losses.map((l) => `<tr><td><i class="chip" style="background:${catColor(l.cat)}">&nbsp;</i> ${esc(l.label)}</td>
      <td class="muted">${l.own ? 'kendi' : 'dış kaynaklı'}</td><td class="num">${hms(l.ms)}</td><td class="num">${l.units.toFixed(1)}</td></tr>`).join('')}
    <tr><td>Hız kaybı (performans)</td><td class="muted">kendi</td><td class="num">${hms(dl.speedLossMs)}</td><td class="num">${(dl.speedLossMs / (dl.idealS * 1000)).toFixed(1)}</td></tr>
    <tr><td>· mikro duruşlar</td><td></td><td class="num">${hms(micro?.ms ?? 0)}</td><td class="num">${micro?.n ?? 0} adet</td></tr>
    <tr><td>Kalite kaybı (red)</td><td class="muted">kendi</td><td class="num">${hms(dl.reject * dl.idealS * 1000)}</td><td class="num">${dl.reject}</td></tr>
    </table><div class="note">Kayıp adet = süre / ideal çevrim (${dl.idealS} s). Mikro duruş: üretimdeyken adet 3 ideal çevrimden uzun gelmedi.</div>`;
  $('longest').innerHTML = `<table><tr><th>Hücre</th><th>Durum</th><th>Başlangıç</th><th class="num">Süre</th></tr>
    ${d.longest.map((r) => `<tr><td>${esc(cellName(r.cell))}</td><td><i class="chip" style="background:${catColor(r.category)}">&nbsp;</i> ${esc(stateText(r.cell, r.state))}</td>
      <td>${clock(r.ts_start)}</td><td class="num">${hms(r.ms)}</td></tr>`).join('')}</table>`;
}

// ---------------------------------------------------------------- alarmlar
async function renderAlarms() {
  const d = await get(`/api/alarms${$('alarm-all').checked ? '?all=1' : ''}`);
  const svg = $('pareto'), W = svg.clientWidth || 1000, H = 300, L = 40, R = 40, B = 110, T = 10;
  const p = d.pareto.slice(0, 12), max = Math.max(1, ...p.map((x) => x.n));
  const bw = p.length ? Math.min(150, (W - L - R) / p.length) : 0;
  let s = `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#2a3440"/>`;
  for (let k = 0; k <= max; k += Math.max(1, Math.ceil(max / 5))) {
    const y = H - B - (k / max) * (H - B - T);
    s += `<text x="${L - 6}" y="${y + 4}" text-anchor="end">${k}</text><line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="#1f2830"/>`;
  }
  s += `<line x1="${L}" x2="${W - R}" y1="${H - B - 0.8 * (H - B - T)}" y2="${H - B - 0.8 * (H - B - T)}" stroke="#f5c54266" stroke-dasharray="4 4"/>
    <text x="${W - R + 4}" y="${H - B - 0.8 * (H - B - T) + 4}">80%</text>`;
  let line = '';
  p.forEach((a, i) => {
    const h = (a.n / max) * (H - B - T), x = L + i * bw;
    s += `<rect x="${x + bw * 0.15}" y="${H - B - h}" width="${bw * 0.7}" height="${h}" fill="${a.severity === 'alarm' ? '#d64545' : '#c9a227'}" rx="3">
      <title>${esc(cellName(a.cell))}: ${esc(a.text)}\n${a.n} kez, toplam ${hms(a.ms)}</title></rect>
      <text x="${x + bw / 2}" y="${H - B - h - 4}" text-anchor="middle" style="fill:var(--text)">${a.n}</text>
      <text transform="translate(${x + bw / 2},${H - B + 10}) rotate(35)" style="font-size:10.5px">${esc((a.text.length > 30 ? a.text.slice(0, 29) + '…' : a.text))}</text>`;
    line += `${i ? 'L' : 'M'}${x + bw / 2},${H - B - a.cum * (H - B - T)}`;
  });
  if (p.length) s += `<path d="${line}" fill="none" stroke="var(--blue)" stroke-width="2"/>`
    + p.map((a, i) => `<circle cx="${L + i * bw + bw / 2}" cy="${H - B - a.cum * (H - B - T)}" r="3" fill="var(--blue)"/>`).join('');
  else s += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">Bu aralıkta alarm yok</text>`;
  svg.innerHTML = s;
  $('history').innerHTML = `<table><tr><th>Hücre</th><th>Alarm</th><th>Önem</th><th>Açıldı</th><th>Kapandı</th><th class="num">Süre</th></tr>
    ${d.history.filter((a) => $('alarm-all').checked || a.severity === 'alarm').slice(0, 150).map((a) => `<tr><td>${esc(cellName(a.cell))}</td>
      <td>${esc(a.text)}</td><td style="color:${a.severity === 'alarm' ? 'var(--red)' : 'var(--yellow)'}">${a.severity}</td>
      <td>${dt(a.ts_on)}</td><td>${a.ts_off ? dt(a.ts_off) : '<b>aktif</b>'}</td><td class="num">${hms((a.ts_off ?? Date.now()) - a.ts_on)}</td></tr>`).join('')}</table>`;
}

// ---------------------------------------------------------------- palet izleme
const STATUS_CLASS = { depoda: 'depoda', 'sevk edildi': 'sevk', sevkte: 'sevk', reddedildi: 'red' };
async function renderPallets() {
  const [list, cips] = await Promise.all([get('/api/pallets'), get('/api/cips')]);
  if (!selected && list.length) selected = (list.find((p) => p.status !== 'istifte') ?? list.find((p) => p.placed > 0) ?? list[0]).label;
  $('pallets').innerHTML = list.map((p) => `<div class="pal-item ${p.label === selected ? 'on' : ''}" data-label="${esc(p.label)}">
    <span class="mono">${esc(p.label)}</span><span class="status-tag ${STATUS_CLASS[p.status] || ''}">${esc(p.status)}${p.status === 'istifte' ? ` · ${p.placed}/18` : ''}${p.loc ? ` · göz ${p.loc}` : ''}</span></div>`).join('')
    || '<div class="muted">Henüz palet yok.</div>';
  document.querySelectorAll('.pal-item').forEach((el) => el.addEventListener('click', () => { selected = el.dataset.label; selectedPack = null; refresh(); }));
  $('cips').innerHTML = cips.length ? cips.map((c) => `<div class="pal-item" data-cip="${c.cip_id}"><span>CIP #${c.cip_id} · ${clock(c.ts_end)}</span>
    <span class="${c.result === 1 ? 'cip-ok' : 'cip-bad'}">${['-', 'başarılı', 'iptal', 'başarısız'][c.result] ?? c.result}</span></div>`).join('')
    : '<div class="muted">CIP kaydı yok.</div>';
  document.querySelectorAll('[data-cip]').forEach((el) => el.addEventListener('click', async () => {
    const r = await get(`/api/recall?cip=${el.dataset.cip}`);
    $('recall').innerHTML = `<div class="note">CIP #${el.dataset.cip} sonrası aktarılan ürünü taşıyan ${r.length} palet:</div>`
      + r.map((p) => `<div class="pal-item" data-label="${esc(p.label)}"><span class="mono">${esc(p.label)}</span><span>${esc(p.status)} · ${p.cups} bardak</span></div>`).join('');
    document.querySelectorAll('#recall .pal-item').forEach((x) => x.addEventListener('click', () => { selected = x.dataset.label; refresh(); }));
  }));
  if (!selected) return;
  const { trace: tr, cips: pc } = await get(`/api/trace?label=${encodeURIComponent(selected)}`);
  if (!tr) { $('pallet-detail').innerHTML = `<div class="empty">${esc(selected)} bulunamadı.</div>`; return; }
  const P = tr.pallet;
  const fact = (l, v) => `<div class="fact"><div class="l">${l}</div><div class="v">${v}</div></div>`;
  const cipTxt = pc.map((c) => (c.cip_id == null ? `<span class="cip-none">${c.initial ? 'başlangıç stoku' : 'CIP kaydı öncesi'}</span>`
    : `<span class="${c.result === 1 ? 'cip-ok' : 'cip-bad'}">CIP #${c.cip_id}</span>`)).join(' + ');
  const bySlot = Object.fromEntries(tr.packs.map((k) => [k.slot, k]));
  const layer = (n) => `<div class="layer"><div class="t">${n}. kat</div><div class="slots">${[0, 1, 2, 3, 4, 5].map((i) => {
    const s = (n - 1) * 6 + i + 1, k = bySlot[s];
    return `<div class="slot ${k ? (k.is_test ? 'test' : 'full') : ''} ${k && k.pack === selectedPack ? 'on' : ''}" data-pack="${k ? k.pack : ''}">
      ${k ? `#${k.pack}` : '·'}<small>slot ${s}</small></div>`;
  }).join('')}</div></div>`;
  const pk = tr.packs.find((k) => k.pack === selectedPack) || tr.packs[0];
  $('pallet-detail').innerHTML = `<div class="pal-head"><div><div class="lbl">${esc(P.label)}</div>
      <div class="sub">palet #${P.pallet} · simülatör çalıştırması ${esc(P.run)}</div></div>
      <span class="status-tag ${STATUS_CLASS[P.status] || ''}" style="font-size:13px">${esc(P.status)}</span></div>
    <div class="facts">
      ${fact('Paket', `${tr.packs.length} / 18`)}${fact('Streç', P.turns != null ? `${P.turns} tur` : '—')}
      ${fact('Bitti', clock(P.ts_done))}${fact('Depoya girdi', P.ts_stored ? `${clock(P.ts_stored)} · göz ${P.loc ?? '—'}` : '—')}
      ${fact('Sevk', P.ts_shipped ? `${clock(P.ts_shipped)} · sipariş ${P.ship_order ?? '—'}` : '—')}
      ${fact('Net dolum', tr.fill ? `${tr.fill.min.toFixed(1)}–${tr.fill.max.toFixed(1)} g` : '—')}
      ${fact('Parti', tr.lots.map((l) => (l === 0 ? 'başlangıç' : l)).join(', ') || '—')}
      ${fact('Aktarım', tr.transfers.join(', ') || '—')}
    </div>
    <div class="note" style="margin:-4px 0 12px">CIP dönemi: ${cipTxt || '—'}
      ${tr.cips.length ? ' · ' + tr.cips.map((c) => `CIP #${c.cip_id}: ${hms(c.duration_s * 1000)}, en düşük ${c.min_temp} °C / ${c.min_flow} kg/s, son durulama ${c.final_cond} mS/cm`).join('; ') : ''}</div>
    <div class="layers">${layer(1)}${layer(2)}${layer(3)}</div>
    ${pk ? `<h2>Paket #${pk.pack}${pk.is_test ? ' (test besleyici: bardak kaydı yok)' : ''} · slot ${pk.slot} · ${clock(pk.ts_formed)} oluştu, ${clock(pk.ts_placed)} palete kondu</h2>
    <table><tr><th>Bardak</th><th class="num">Net (g)</th><th class="num">Kapama (°C)</th><th>Dolum</th><th>Aktarım (pay)</th><th>Parti</th><th>CIP</th><th class="sim">simülatörün gizli gerçeği</th></tr>
    ${pk.cups.map((c) => `<tr><td class="mono">#${c.cup}</td><td class="num">${c.net_g ?? '—'}</td><td class="num">${c.seal_c ?? '—'}</td>
      <td>${clock(c.ts_fill)}</td><td class="mono">${c.transfers.map((x) => `${x.transfer} (${(x.frac * 100).toFixed(0)}%)`).join(', ')}</td>
      <td>${[...new Set(c.transfers.map((x) => (x.lot === 0 ? 'başl.' : x.lot)))].join(', ')}</td>
      <td>${[...new Set(c.transfers.map((x) => (x.last_cip == null ? '—' : `#${x.last_cip}`)))].join(', ')}</td>
      <td class="sim">${esc(c.sim_defect ?? 'sağlam')}</td></tr>`).join('')}</table>
    <div class="note">Net dolum kontrol tartısından, kapama sıcaklığı kafa termokuplundan, aktarım payı dolum tankının karışım modelinden.
      Son sütun izleme sisteminin bilmediği simülatör gerçeğidir; hesaplarda kullanılmaz.</div>` : ''}`;
  document.querySelectorAll('.slot[data-pack]').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.pack) { selectedPack = Number(el.dataset.pack); refresh(); }
  }));
}

// ---------------------------------------------------------------- vardiya raporu
async function renderReport() {
  const r = await get(`/api/report${reportAt ? `?at=${reportAt}` : ''}`);
  const k = r.counters;
  $('report').innerHTML = `<h2>Vardiya raporu · ${esc(r.shift.name)}</h2>
    <div class="sub">${dt(r.shift.t0)} – ${dt(r.shift.t1)} · rapor zamanı ${dt(r.now)}</div>
    <h3>OEE ve kullanım</h3>
    <table><tr><th>Hücre</th><th class="num">OEE / kullanım</th><th class="num">A</th><th class="num">P</th><th class="num">Q</th>
      <th class="num">Adet</th><th class="num">Red</th><th>En büyük kayıp</th><th class="num">Veri yok</th></tr>
    ${r.oee.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${pct(c.oee ? c.OEE : c.utilization)}</td>
      <td class="num">${pct(c.A)}</td><td class="num">${c.oee ? pct(c.P) : '—'}</td><td class="num">${c.qualityMeasured ? pct(c.Q) : '—'}</td>
      <td class="num">${c.total}</td><td class="num">${c.reject}</td>
      <td>${c.losses?.[0] ? `${esc(c.losses[0].label)} (${hms(c.losses[0].ms)})` : '—'}</td><td class="num">${hms(c.times.VERI_YOK)}</td></tr>`).join('')}</table>
    <h3>Üretim</h3>
    <table><tr><td>Sağlam bardak</td><td class="num">${k.cupsOut}</td><td>Reddedilen</td><td class="num">${k.cupsRejected}</td><td>Kaybolan</td><td class="num">${k.cupsLost}</td></tr>
      <tr><td>Paket</td><td class="num">${k.packs}</td><td>Palet</td><td class="num">${k.pallets}</td><td>Depolanan</td><td class="num">${k.stored}</td></tr>
      <tr><td>Sevk edilen</td><td class="num">${k.shipped}</td><td>CIP</td><td class="num">${k.cips}</td><td>Hat sonu verimi</td><td class="num">${pct(r.lineYield.rate)}</td></tr></table>
    <h3>İlk 5 alarm</h3>
    <table><tr><th>Hücre</th><th>Alarm</th><th class="num">Adet</th><th class="num">Süre</th></tr>
      ${r.pareto.map((a) => `<tr><td>${esc(cellName(a.cell))}</td><td>${esc(a.text)}</td><td class="num">${a.n}</td><td class="num">${hms(a.ms)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Alarm yok</td></tr>'}</table>
    <h3>En uzun duruşlar</h3>
    <table>${r.longest.map((s) => `<tr><td>${esc(cellName(s.cell))}</td><td>${esc(stateText(s.cell, s.state))}</td><td>${clock(s.ts_start)}</td><td class="num">${hms(s.ms)}</td></tr>`).join('')}</table>
    <h3>CIP</h3>
    <table>${r.cips.map((c) => `<tr><td>CIP #${c.cip_id}</td><td>${clock(c.ts_start)}–${clock(c.ts_end)}</td><td class="${c.result === 1 ? 'cip-ok' : 'cip-bad'}">${['-', 'başarılı', 'iptal', 'başarısız'][c.result]}</td>
      <td>${c.min_temp} °C, ${c.min_flow} kg/s, ${c.final_cond} mS/cm</td></tr>`).join('') || '<tr><td class="muted">CIP yok</td></tr>'}</table>
    <h3>Veri kalitesi</h3>
    <table>${r.reconcile.map((x) => `<tr><td>${esc(x.what)}</td><td class="num">PLC ${x.plc}</td><td class="num">takip ${x.trace ?? '—'}</td><td class="num">fark ${x.diff ?? '—'}</td></tr>`).join('')}
      <tr><td>Olay akışı kayıpları</td><td colspan="3">${r.gaps.ingest.length}</td></tr>
      <tr><td>PLC haberleşme boşlukları</td><td colspan="3">${r.gaps.comm.map((g) => `${g.plc} ${clock(g.ts_start)}–${clock(g.ts_end)}`).join(', ') || 'yok'}</td></tr>
      <tr><td>Sayaç sıfırlanmaları (PLC yeniden başladı)</td><td colspan="3">${r.gaps.counterResets.length}</td></tr></table>`;
}

// ---------------------------------------------------------------- döngü
let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    META ??= await get('/api/meta');
    const o = await get('/api/overview');
    renderStatus(o.status, o.shift);
    if (tab === 'genel') { renderOverview(o); await renderTimeline(); }
    if (tab === 'durus') await renderStops(o.shift);
    if (tab === 'alarm') await renderAlarms();
    if (tab === 'palet') await renderPallets();
    if (tab === 'rapor') await renderReport();
  } catch (e) {
    $('status').innerHTML = `<span class="pill"><i></i>İzleme servisine ulaşılamıyor: ${esc(e.message)}</span>`;
  } finally { busy = false; }
}
refresh();
setInterval(() => { if (tab !== 'palet' && tab !== 'rapor') refresh(); }, 2000);
setInterval(() => { if (tab === 'palet') refresh(); }, 5000);
