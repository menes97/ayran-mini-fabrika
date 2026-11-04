// Arayüz: WebSocket bağlantısı, operatör paneli ve 3B sahnenin güncellenmesi.
import { MachineScene } from './scene.js';
import { IO, MODES, ALARMS, FAULTS, TANK_STATES, TANK_ALARMS, SHRINK_STATES, SHRINK_ALARMS, SHRINK_STATUS,
  PAL_STATES, PAL_ALARMS, PAL_STATUS, ROBOT_JOBS, ROBOT_RESULTS, AGV_STATES, AGV_ALARMS, AGV_STATUS, AGV_ORDERS, AGV_RESULTS,
  ASRS_STATES, ASRS_ALARMS, ASRS_STATUS, CRANE_JOBS, CRANE_RESULTS, addr, bitOf } from './iomap.js';
import { RACK } from './logisticsgeo.js';
import { PG } from './palletgeo.js';

const DOL = { state: addr('dolum', 1), alarm: addr('dolum', 2), good: addr('dolum', 3), rej: addr('dolum', 4) };
const TNK = Object.fromEntries(IO.tank.hr.map((r) => [r.tag, addr('tank', r.off)]));
const SHR = Object.fromEntries(IO.shrink.hr.map((r) => [r.tag, addr('shrink', r.off)]));
const PAL = Object.fromEntries(IO.palet.hr.map((r) => [r.tag, addr('palet', r.off)]));
const AGVA = Object.fromEntries(IO.agv.hr.map((r) => [r.tag, addr('agv', r.off)]));
const ASR = Object.fromEntries(IO.asrs.hr.map((r) => [r.tag, addr('asrs', r.off)]));
const CIP_LIMIT_KG = 50;   // FB_Tank CIP_LIMIT ile aynı

const $ = (id) => document.getElementById(id);
const scene = new MachineScene($('viewport'));
let state = null;
let ws = null;

// ---- Bağlantı ------------------------------------------------------------
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (e) => { state = JSON.parse(e.data); };
  ws.onclose = () => { state = null; setTimeout(connect, 1000); };
}
const send = (msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };
connect();

// ---- Operatör paneli -----------------------------------------------------
for (const btn of document.querySelectorAll('[data-btn], [data-tbtn]')) {
  const name = btn.dataset.btn || btn.dataset.tbtn;
  // Kısa tıklamalar da PLC'nin yoklama süresinden uzun görünsün diye buton en az 300 ms basılı kalır.
  let downAt = 0;
  const set = (v) => { btn.classList.toggle('held', v); send({ type: 'button', name, value: v }); };
  const release = () => setTimeout(() => set(false), Math.max(0, 300 - (performance.now() - downAt)));
  btn.addEventListener('pointerdown', (e) => {
    try { btn.setPointerCapture(e.pointerId); } catch { /* sentetik olaylarda yakalama olmayabilir */ }
    downAt = performance.now();
    set(true);
  });
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
}
$('estop').addEventListener('click', () => send({ type: 'estop', value: !state?.estop }));
for (const b of document.querySelectorAll('[data-refill]')) {
  b.addEventListener('click', () => send({ type: 'refill', name: b.dataset.refill }));
}
$('reset-kpi').addEventListener('click', () => send({ type: 'resetKpi' }));
$('pal-door').addEventListener('click', () => send({ type: 'door', value: !!state?.pallet.safe.door }));
$('pal-intrude').addEventListener('click', () => send({ type: 'intrude' }));
$('pal-remove').addEventListener('click', () => send({ type: 'removeUnknownPallet' }));
$('pal-testfeed').addEventListener('change', (e) => send({ type: 'testFeed', value: e.target.checked }));
for (const b of document.querySelectorAll('[data-ship]')) b.addEventListener('click', () => send({ type: 'shipOrder', value: +b.dataset.ship }));
$('asrs-door').addEventListener('click', () => send({ type: 'aisleDoor', value: !!state?.asrs.safe.door }));
$('asrs-reject').addEventListener('click', () => send({ type: 'removeReject' }));
$('agv-charge').addEventListener('click', () => send({ type: 'agvCharge' }));
// raf haritası: her taraf için 3 kat x 6 sütun
const rackCells = [];
for (let side = 0; side < 2; side++) {
  const tbl = document.createElement('div');
  tbl.className = 'rack';
  tbl.innerHTML = `<span class="rk-t">Taraf ${side + 1}</span>`;
  for (let level = RACK.levels - 1; level >= 0; level--) {
    for (let col = 0; col < RACK.cols; col++) {
      const n = side * RACK.cols * RACK.levels + col * RACK.levels + level + 1;
      const c = document.createElement('i');
      c.title = `Göz ${n}`;
      tbl.appendChild(c); rackCells[n] = c;
    }
  }
  $('rack').appendChild(tbl);
}

const faultBox = $('faults');
for (const [key, text] of Object.entries(FAULTS)) {
  const l = document.createElement('label');
  l.innerHTML = `<input type="checkbox" data-fault="${key}"> ${text}`;
  l.querySelector('input').addEventListener('change', (e) => send({ type: 'fault', name: key, value: e.target.checked }));
  faultBox.appendChild(l);
}

// Kamera ve panel
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => scene.setView(b.dataset.view));
const togglePanel = () => { document.body.classList.toggle('panel-hidden'); scene.resize(); };
$('toggle-panel').addEventListener('click', togglePanel);
window.addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') togglePanel();
  const views = { 1: 'overview', 2: 'fill', 3: 'seal', 4: 'reject', 5: 'process', 6: 'pack', 7: 'palet', 8: 'depo', 9: 'factory' };
  if (views[e.key]) scene.setView(views[e.key]);
});

// I/O listeleri
const ioList = (el, defs) => defs.map((d) => {
  const li = document.createElement('li');
  li.title = d.label;
  li.innerHTML = `<span class="n">${d.bit}</span><i></i>${d.tag}`;
  el.appendChild(li);
  return li;
});
const diItems = ioList($('di'), IO.dolum.di);
const doItems = ioList($('do'), IO.dolum.do);
const tdiItems = ioList($('tdi'), IO.tank.di);
const tdoItems = ioList($('tdo'), IO.tank.do);
const sdiItems = ioList($('sdi'), IO.shrink.di);
const sdoItems = ioList($('sdo'), IO.shrink.do);
const pdiItems = ioList($('pdi'), IO.palet.di);
const pdoItems = ioList($('pdo'), IO.palet.do);
const probItems = ioList($('prob'), IO.palet.rob);
const gdiItems = ioList($('gdi'), IO.agv.di);
const gdoItems = ioList($('gdo'), IO.agv.do);
const adiItems = ioList($('adi'), IO.asrs.di);
const adoItems = ioList($('ado'), IO.asrs.do);
// bit paketli kelimeler LED listesinde gösterildiği için tabloda yalnızca sayısal register'lar
const regRows = Object.entries(IO).flatMap(([cell, io]) => [
  ...io.ir.map((r) => ({ ...r, kind: 'IR', a: addr(cell, r.off) })),
  ...io.hr.map((r) => ({ ...r, kind: 'HR', a: addr(cell, r.off) })),
]).filter((r) => !/_(DI|DO)$/.test(r.tag))
  .map((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="k">${r.kind}${r.a}</td><td>${r.tag}</td><td class="k">${r.unit ?? ''}</td><td>-</td>`;
    $('regs').appendChild(tr);
    return { r, td: tr.lastChild };
  });

// ---- Panel güncelleme (saniyede ~10 kez yeterli) ---------------------------
const fmtTime = (t) => {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
let lastEventKey = '';

function updatePanel(st) {
  const badge = $('plc-badge');
  if (!st) { badge.textContent = 'Simülatör yok'; badge.className = 'badge off'; return; }
  // üç PLC'li fabrikada hangisinin düştüğünü göster
  const down = Object.entries(st.plcLive || {}).filter(([, v]) => !v).map(([k]) => k);
  badge.textContent = st.plcConnected ? 'PLC bağlı' : down.length === 3 || !st.plcLive ? 'PLC yok' : `${down.join(', ')} PLC yok`;
  badge.className = `badge ${st.plcConnected ? 'on' : 'off'}`;

  const d = st.dolum;
  const out = d.do;
  $('lamp-green').classList.toggle('on', bitOf(out, 10));
  $('lamp-yellow').classList.toggle('on', bitOf(out, 11));
  $('lamp-red').classList.toggle('on', bitOf(out, 12));
  $('estop').classList.toggle('active', st.estop);
  const mode = st.hr[DOL.state];
  $('mode').textContent = st.plcConnected ? (MODES[mode] ?? `? (${mode})`) : 'PLC bağlantısı bekleniyor';

  const alarmWord = st.plcConnected ? st.hr[DOL.alarm] : 0;
  $('alarms').innerHTML = ALARMS.filter((a) => bitOf(alarmWord, a.bit))
    .map((a) => `<li class="${a.bit >= 8 ? 'warn' : ''}">${a.text}</li>`).join('');

  $('tank').textContent = `%${d.level.toFixed(1)}`;
  $('tank-bar').style.width = `${d.level}%`;
  $('temp').textContent = `${d.temp.toFixed(1)} °C`;
  $('temp-bar').style.width = `${Math.min(100, (d.temp / 260) * 100)}%`;
  $('fill').textContent = `${Math.max(0, d.fillScale).toFixed(1)} g`;
  $('check').textContent = `${Math.max(0, d.checkScale).toFixed(1)} g`;
  $('cupmag').textContent = `${d.cupMag} adet`;
  $('foilmag').textContent = `${d.foilMag} adet`;
  $('outfeed').textContent = `${st.outfeed.length} adet`;

  const k = st.kpi;
  $('k-good').textContent = k.shippedGood;
  $('k-escape').textContent = k.shippedBad;
  $('k-rejbad').textContent = k.rejectedBad;
  $('k-rejgood').textContent = k.rejectedGood;
  $('k-lost').textContent = k.lostCups;
  $('k-spill').textContent = `${(k.spilledKg * 1000).toFixed(0)} g`;
  $('k-drain').textContent = `${k.drainProductKg.toFixed(1)} kg`;
  $('k-caustic').textContent = `${(k.causticToProductKg * 1000).toFixed(0)} g`;
  $('k-hyg').textContent = `${k.hygieneRiskKg.toFixed(1)} kg`;

  // tank ve CIP
  const t = st.tank;
  const hr = (tag) => st.hr[TNK[tag]];
  const tState = hr('TNK_QW_STATE');
  $('tank-state').textContent = st.plcConnected ? (TANK_STATES[tState] ?? `? (${tState})`) : '-';
  $('tank-step').textContent = st.plcConnected && tState !== 0 && tState !== 9 ? `${hr('TNK_QW_STEP_T')} s` : '';
  const tAlarm = st.plcConnected ? hr('TNK_QW_ALARM') : 0;
  $('tank-alarms').innerHTML = TANK_ALARMS.filter((a) => bitOf(tAlarm, a.bit))
    .map((a) => `<li class="${a.text.startsWith('Uyarı') ? 'warn' : ''}">${a.text}</li>`).join('');
  $('t1').textContent = `%${t.prodLevel.toFixed(1)}`;
  $('t1-bar').style.width = `${t.prodLevel}%`;
  $('flow').textContent = `${t.flow.toFixed(2)} kg/s`;
  $('cond').textContent = `${t.cond.toFixed(1)} mS/cm`;
  $('cond-bar').style.width = `${Math.min(100, t.cond)}%`;
  $('ret-t').textContent = `${t.lineT.toFixed(1)} °C`;
  $('cip-t').textContent = `${t.causticT.toFixed(1)} °C · %${t.causticLevel.toFixed(0)}`;
  $('cip-bar').style.width = `${Math.min(100, (t.causticT / 95) * 100)}%`;
  const since = hr('TNK_QW_SINCE') / 10;
  $('since').textContent = `${since.toFixed(1)} / ${CIP_LIMIT_KG} kg`;
  $('since-bar').style.width = `${Math.min(100, (since / CIP_LIMIT_KG) * 100)}%`;
  const res = hr('TNK_QW_CIP_RES');
  $('cip-report').innerHTML = res === 0 ? 'Henüz CIP yapılmadı.'
    : `Son CIP: <b class="${res === 1 ? 'ok' : 'fail'}">${['', 'BAŞARILI', 'İPTAL', 'BAŞARISIZ'][res]}</b>
       · süre <b>${hr('TNK_QW_CIP_DUR')} s</b>
       · tutmada en düşük <b>${(hr('TNK_QW_CIP_MINT') / 10).toFixed(1)} °C</b> / <b>${(hr('TNK_QW_CIP_MINF') / 100).toFixed(2)} kg/s</b>
       · son durulama <b>${(hr('TNK_QW_CIP_COND') / 10).toFixed(1)} mS/cm</b>`;
  tdiItems.forEach((li, i) => li.classList.toggle('on', bitOf(t.di, IO.tank.di[i].bit)));
  tdoItems.forEach((li, i) => li.classList.toggle('on', bitOf(t.do, IO.tank.do[i].bit)));

  // paketleme
  const sh = st.shrink;
  const sState = st.hr[SHR.SHR_QW_STATE];
  $('shr-state').textContent = st.plcConnected ? (SHRINK_STATES[sState] ?? `? (${sState})`) : '-';
  const sStatus = st.plcConnected ? st.hr[SHR.SHR_QW_STATUS] : 0;
  $('shr-status').innerHTML = SHRINK_STATUS.map((txt, i) => `<span class="chip ${bitOf(sStatus, i) ? 'on' : ''}">${txt}</span>`).join('');
  const sAlarm = st.plcConnected ? st.hr[SHR.SHR_QW_ALARM] : 0;
  $('shr-alarms').innerHTML = SHRINK_ALARMS.filter((a) => bitOf(sAlarm, a.bit))
    .map((a) => `<li class="${a.text.startsWith('Uyarı') ? 'warn' : ''}">${a.text}</li>`).join('');
  $('shr-temp').textContent = `${sh.temp.toFixed(0)} / ${(st.hr[SHR.SHR_QW_SP] / 10).toFixed(0)} °C`;
  $('shr-temp-bar').style.width = `${Math.min(100, (sh.temp / 220) * 100)}%`;
  $('shr-inside').textContent = `${st.hr[SHR.SHR_QW_INSIDE]} paket`;
  $('shr-film').textContent = `%${sh.film.toFixed(0)}`;
  $('shr-film-bar').style.width = `${sh.film}%`;
  $('shr-pads').textContent = `${sh.pads} adet`;
  $('k-packs').textContent = k.packsGood;
  $('k-packbad').textContent = k.packsBad;
  $('k-packreject').textContent = k.packsRejected;
  const last = sh.done.at(-1);
  $('k-lastpack').textContent = last ? (last.defect ? 'hatalı' : 'sağlam') : '-';
  $('k-lastpack').title = last?.defect ?? '';
  sdiItems.forEach((li, i) => li.classList.toggle('on', bitOf(sh.di, IO.shrink.di[i].bit)));
  sdoItems.forEach((li, i) => li.classList.toggle('on', bitOf(sh.do, IO.shrink.do[i].bit)));

  // paletleme
  const pl = st.pallet;
  const ph = (tag) => st.hr[PAL[tag]];
  const pState = ph('PAL_QW_STATE');
  $('pal-state').textContent = st.plcConnected ? (PAL_STATES[pState] ?? `? (${pState})`) : '-';
  const pStatus = st.plcConnected ? ph('PAL_QW_STATUS') : 0;
  $('pal-status').innerHTML = PAL_STATUS.map((txt, i) => `<span class="chip ${bitOf(pStatus, i) ? 'on' : ''}">${txt}</span>`).join('');
  const pAlarm = st.plcConnected ? ph('PAL_QW_ALARM') : 0;
  $('pal-alarms').innerHTML = PAL_ALARMS.filter((a) => bitOf(pAlarm, a.bit))
    .map((a) => `<li class="${a.text.startsWith('Uyarı') ? 'warn' : ''}">${a.text}</li>`).join('');
  const r = pl.robot;
  $('pal-job').textContent = r.job ? `${ROBOT_JOBS[r.job.type] ?? r.job.type}${r.job.type === 2 ? ' → slot ' + r.job.slot : ''} (#${r.job.seq})`
    : r.error ? 'HATA' : r.part ? 'paket tutuyor' : 'boşta';
  $('pal-res').textContent = `#${r.resSeq}: ${ROBOT_RESULTS[r.resCode] ?? r.resCode}`;
  const cnt = ph('PAL_QW_COUNT');
  $('pal-count').textContent = `${cnt} / ${PG.slots} · kat ${Math.min(PG.layers, Math.floor(cnt / PG.perLayer) + 1)}`;
  $('pal-count-bar').style.width = `${(cnt / PG.slots) * 100}%`;
  $('pal-mag').textContent = `${pl.palletMag} adet`;
  $('pal-sheets').textContent = `${pl.sheets} adet`;
  $('pal-stretch').textContent = `%${pl.stretch.toFixed(0)}`;
  $('pal-stretch-bar').style.width = `${pl.stretch}%`;
  $('pal-safe').textContent = pl.safe.ok ? (pl.safe.muted ? 'güvenli (muting)' : 'güvenli') : `DURDU: ${pl.safe.cause}`;
  $('pal-safe').className = pl.safe.ok ? 'ok' : 'fail';
  $('pal-door').textContent = pl.safe.door ? 'Kapıyı aç' : 'Kapıyı kapat';
  $('pal-testfeed').checked = pl.testFeed;
  $('k-pallets').textContent = k.palletsGood;
  $('k-palbad').textContent = k.palletsBad;
  $('k-dropped').textContent = k.packsDropped;
  $('k-cycle').textContent = r.lastCycle ? `${r.lastCycle.toFixed(1)} s` : '-';
  pdiItems.forEach((li, i) => li.classList.toggle('on', bitOf(pl.di, IO.palet.di[i].bit)));
  pdoItems.forEach((li, i) => li.classList.toggle('on', bitOf(pl.do, IO.palet.do[i].bit)));
  probItems.forEach((li, i) => li.classList.toggle('on', bitOf(pl.rob, IO.palet.rob[i].bit)));

  // AGV ve depo
  const ag = st.agv, as = st.asrs;
  const gh = (t) => st.hr[AGVA[t]], ah = (t) => st.hr[ASR[t]];
  const list = (el, A, w) => { $(el).innerHTML = A.filter((a) => bitOf(w, a.bit)).map((a) => `<li class="${a.text.startsWith('Uyarı') ? 'warn' : ''}">${a.text}</li>`).join(''); };
  const chips = (el, T, w) => { $(el).innerHTML = T.map((txt, i) => `<span class="chip ${bitOf(w, i) ? 'on' : ''}">${txt}</span>`).join(''); };
  $('agv-state').textContent = st.plcConnected ? (AGV_STATES[gh('AGV_QW_STATE')] ?? '?') : '-';
  chips('agv-status', AGV_STATUS, st.plcConnected ? gh('AGV_QW_STATUS') : 0);
  list('agv-alarms', AGV_ALARMS, st.plcConnected ? gh('AGV_QW_ALARM') : 0);
  $('agv-job').textContent = ag.order ? `${AGV_ORDERS[ag.order.type] ?? ag.order.type} (#${ag.order.seq})` : ag.error ? 'HATA' : 'boşta';
  $('agv-res').textContent = `#${ag.resSeq}: ${AGV_RESULTS[ag.resCode] ?? ag.resCode}`;
  $('agv-node').textContent = ag.node + (ag.load ? ` · yük #${ag.load.id}` : '');
  $('agv-bat').textContent = `%${ag.battery.toFixed(0)}${ag.charging ? ' (şarj)' : ''}`;
  $('agv-bat-bar').style.width = `${ag.battery}%`;
  $('asrs-state').textContent = st.plcConnected ? (ASRS_STATES[ah('ASRS_QW_STATE')] ?? '?') : '-';
  chips('asrs-status', ASRS_STATUS, st.plcConnected ? ah('ASRS_QW_STATUS') : 0);
  list('asrs-alarms', ASRS_ALARMS, st.plcConnected ? ah('ASRS_QW_ALARM') : 0);
  const cr = as.crane;
  $('asrs-job').textContent = cr.job ? `${CRANE_JOBS[cr.job.type] ?? cr.job.type}${cr.job.loc ? ' · göz ' + cr.job.loc : ''} (#${cr.job.seq})` : cr.error ? 'HATA' : 'boşta';
  $('asrs-res').textContent = `#${cr.resSeq}: ${CRANE_RESULTS[cr.resCode] ?? cr.resCode}${cr.resLoc ? ' · göz ' + cr.resLoc : ''}`;
  $('asrs-stock').textContent = `${ah('ASRS_QW_STOCK')} / ${RACK.slots}${ah('ASRS_QW_UNKNOWN') ? ` · ${ah('ASRS_QW_UNKNOWN')} belirsiz` : ''}`;
  $('asrs-stock-bar').style.width = `${(ah('ASRS_QW_STOCK') / RACK.slots) * 100}%`;
  $('asrs-temp').textContent = `${as.temp.toFixed(1)} °C`;
  $('asrs-temp').className = as.temp > 6 ? 'fail' : 'ok';
  $('asrs-ship').textContent = `sipariş ${as.shipReq} · kamyona ${as.shippedCnt} · sıradaki #${ah('ASRS_QW_NEXT_ID') || '-'}`;
  $('asrs-door').textContent = as.safe.door ? 'Koridor kapısını aç' : 'Koridor kapısını kapat';
  // raf haritası: gerçek palet (simülatör) ve PLC tablosu birlikte
  const occ = [ah('ASRS_QW_OCC_A'), ah('ASRS_QW_OCC_B'), ah('ASRS_QW_OCC_C')];
  for (let n = 1; n <= RACK.slots; n++) {
    const real = as.rack[n - 1], plcOcc = bitOf(occ[(n - 1) >> 4], (n - 1) & 15);
    const c = rackCells[n];
    c.textContent = real ? real : '';
    c.className = real && plcOcc ? 'full' : !real && !plcOcc ? '' : 'diff';
    c.title = `Göz ${n}: rafta ${real ? '#' + real : 'boş'}, PLC ${plcOcc ? 'dolu' : 'boş/belirsiz'}`;
  }
  $('k-stored').textContent = k.palletsStored;
  $('k-shipped').textContent = k.palletsShipped;
  $('k-rejected').textContent = k.palletsRejected;
  $('k-agv').textContent = k.agvMoves;
  gdiItems.forEach((li, i) => li.classList.toggle('on', bitOf(ag.di, IO.agv.di[i].bit)));
  gdoItems.forEach((li, i) => li.classList.toggle('on', bitOf(ag.do, IO.agv.do[i].bit)));
  adiItems.forEach((li, i) => li.classList.toggle('on', bitOf(as.di, IO.asrs.di[i].bit)));
  adoItems.forEach((li, i) => li.classList.toggle('on', bitOf(as.do, IO.asrs.do[i].bit)));

  $('c-good').textContent = st.hr[DOL.good];
  $('c-rej').textContent = st.hr[DOL.rej];

  diItems.forEach((li, i) => li.classList.toggle('on', bitOf(d.di, IO.dolum.di[i].bit)));
  doItems.forEach((li, i) => li.classList.toggle('on', bitOf(out, IO.dolum.do[i].bit)));
  for (const { r, td } of regRows) {
    const v = r.kind === 'IR' ? st.ir[r.a] : st.hr[r.a];
    td.textContent = r.tag.endsWith('ALARM') ? `16#${v.toString(16).toUpperCase().padStart(4, '0')}` : v;
  }

  for (const input of faultBox.querySelectorAll('input')) input.checked = !!st.faults[input.dataset.fault];

  const evKey = st.events.length ? `${st.events.at(-1).t}${st.events.length}` : '';
  if (evKey !== lastEventKey) {
    lastEventKey = evKey;
    $('events').innerHTML = st.events.slice().reverse()
      .map((e) => `<li class="${e.level}"><span class="t">${fmtTime(e.t)}</span>${e.text}</li>`).join('');
  }
}

// ---- Döngü -----------------------------------------------------------------
let last = performance.now();
let panelT = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  scene.update(state && { ...state.dolum, kpi: state.kpi, outfeed: state.outfeed, tank: state.tank, shrink: state.shrink, pallet: state.pallet, agv: state.agv, asrs: state.asrs }, dt);
  scene.render(dt);
  panelT += dt;
  if (panelT > 0.1) { panelT = 0; updatePanel(state); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Hata ayıklama ve ekran görüntüsü için: sayfa arka plandayken de tek kare çizdirilebilir.
window.__app = {
  scene,
  get state() { return state; },
  renderOnce(view, size) {
    if (size) {   // gizli sekmede pencere 0x0 olur: sabit boyutta çiz
      scene.renderer.setSize(size[0], size[1], false);
      scene.camera.aspect = size[0] / size[1];
      scene.camera.updateProjectionMatrix();
    }
    if (view) { scene.setView(view); scene.camTween.t = 1; }
    scene.update(state && { ...state.dolum, kpi: state.kpi, outfeed: state.outfeed, tank: state.tank, shrink: state.shrink, pallet: state.pallet, agv: state.agv, asrs: state.asrs }, 0.05);
    scene.render(0.05);
    updatePanel(state);
  },
};

// izleme panelinin adresi (izleme servisi ayrı bir süreç/port: SCADA/MES katmanı)
fetch('/api/info').then((r) => r.json()).then((i) => {
  document.getElementById('mon-link').href = `http://${location.hostname}:${i.monitorPort}`;
}).catch(() => {});
