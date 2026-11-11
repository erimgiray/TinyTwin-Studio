import { STYLES, DEFAULT_COSTS, DEFAULT_REFS, state, save, esc, $, $$, toast, api, money, unitCost, pickFiles, loadDB, costsSet } from './core.js';

let cStyle = 'Pop';
let cSize = 12;

export function renderCosting(main) {
  const costs = state.db.settings.costs;
  const s = costs.styles[cStyle];
  const r = unitCost(cStyle, cSize);
  const price = +costs.priceTarget;
  const margin = price - r.total;
  const parts = [['Material', r.material, '#5b2e8c'], ['Machine time', r.machine, '#7a5bd6'], ['Labour', r.labour, '#3d6fb6'], ['Finishing', r.finishing, '#2f8f8a'], ['Failed prints', r.failure, '#c2413b'], ['Packaging', r.packaging, '#d4a845'], ['Shipping', r.shipping, '#b7791f'], ['Payment fees', r.fees, '#8f889c']].filter((x) => x[1] > 0.004);
  const sizes = [5, 8, 10, 12, 15, 18];
  const maxC = Math.max(price, ...Object.keys(STYLES).flatMap((st) => sizes.map((z) => unitCost(st, z).total))) * 1.05;
  const W = 520, Hh = 210, bw = 22;
  const field = (k, label, step = 0.01, obj = costs, path = '') => `<label class="f">${label}<input class="in" type="number" step="${step}" data-f="${path}${k}" value="${obj[k]}"></label>`;

  const set = costsSet();
  main.innerHTML = `
  <div class="page-head"><div><h1>Costing</h1><p>Cost per figure by print style and size, worked out from your own numbers. Everything updates live.</p></div></div>
  ${set ? '' : `<div class="card empty" style="margin-bottom:14px"><div class="big">£</div><h3>No costs entered yet</h3><p style="max-width:560px;margin:0 auto">Fill in your real numbers below — material cost, print speed, labour, packaging and shipping. Unit costs and margins appear across the app once at least one cost is set.</p></div>`}
  <div class="grid g2" ${set ? '' : 'hidden'}>
    <div class="card"><div class="row"><h3 style="margin:0">Unit cost breakdown</h3><span class="grow"></span>
      <select class="in" id="cStyle">${Object.keys(STYLES).map((x) => `<option ${x === cStyle ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <select class="in" id="cSize">${sizes.map((x) => `<option ${x === cSize ? 'selected' : ''}>${x}</option>`).join('')}</select><span class="small">cm</span></div>
      <div class="row" style="margin:14px 0 6px;align-items:baseline"><span style="font-size:30px;font-weight:700">${money(r.total)}</span><span class="muted">per figure</span><span class="grow"></span>
        <span class="chip ${margin >= 0 ? 'ok' : 'bad'}" style="font-size:13px">${money(margin)} margin at ${money(price)} (${price ? Math.round((margin / price) * 100) : 0}%)</span></div>
      <div style="display:flex;height:22px;border-radius:7px;overflow:hidden">${parts.map(([l, v, c]) => `<div title="${l} ${money(v)}" style="width:${(v / r.total) * 100}%;background:${c}"></div>`).join('')}</div>
      <table class="t" style="margin-top:10px">${parts.map(([l, v, c]) => `<tr><td><span class="dot" style="background:${c}"></span> ${l}</td><td style="text-align:right">${money(v)}</td><td style="text-align:right" class="tiny">${Math.round((v / r.total) * 100)}%</td></tr>`).join('')}</table>
      <p class="tiny" style="margin-top:8px">${r.solid.toFixed(0)} cm³ solid → ${r.used.toFixed(0)} cm³ printed (${Math.round(s.fill * 100)}% fill) · ~${r.hours.toFixed(1)} h on the printer · ${STYLES[cStyle].sizes.includes(cSize) ? 'recommended size' : `<b style="color:var(--bad)">not a recommended ${cStyle} size</b>`}</p>
    </div>
    <div class="card"><h3>Cost vs size, all styles</h3>
      <svg class="chart" viewBox="0 0 ${W} ${Hh + 40}" width="100%">
        <line x1="56" x2="${W}" y1="${Hh - (price / maxC) * Hh + 10}" y2="${Hh - (price / maxC) * Hh + 10}" stroke="var(--ok)" stroke-dasharray="4 4"/>
        <text x="60" y="${Hh - (price / maxC) * Hh + 5}" style="fill:var(--ok);font-weight:600">selling price ${money(price)}</text>
        ${[0, 0.5, 1].map((f) => `<text x="50" y="${Hh - f * Hh + 14}" text-anchor="end">${state.db.settings.costs.currency}${Math.round(f * maxC)}</text>`).join('')}
        ${sizes.map((z, i) => { const x0 = 56 + i * ((W - 60) / sizes.length); return Object.keys(STYLES).map((st, k) => { const v = unitCost(st, z).total; const hh = (v / maxC) * Hh; const ok = STYLES[st].sizes.includes(z); return `<rect x="${x0 + k * (bw + 2)}" y="${Hh - hh + 10}" width="${bw}" height="${hh}" rx="3" fill="${['#7a5bd6', '#3d6fb6', '#d4a845'][k]}" opacity="${ok ? 1 : 0.25}"><title>${st} ${z} cm: ${money(v)}${ok ? '' : ' (not recommended)'}</title></rect>`; }).join('') + `<text x="${x0 + 36}" y="${Hh + 28}" text-anchor="middle">${z} cm</text>`; }).join('')}
      </svg>
      <div class="row small">${Object.keys(STYLES).map((st, k) => `<span><span class="dot" style="background:${['#7a5bd6', '#3d6fb6', '#d4a845'][k]}"></span> ${st}</span>`).join('')}<span class="tiny">faded = size not recommended for that style</span></div>
    </div>
  </div>
  <div class="grid g2" style="margin-top:14px">
    <div class="card"><h3>General inputs</h3><div class="fgrid">
      <label class="f">Currency symbol<input class="in" data-f="currency" data-str value="${esc(costs.currency)}"></label>
      ${field('priceTarget', 'Selling price per figure', 0.5)}
      ${field('baseVolume', 'Reference solid volume (cm³)', 0.1)}
      ${field('baseHeight', 'at reference height (cm)', 0.1)}
      ${field('labourPerHour', 'Labour rate per hour', 0.5)}
      ${field('failPct', 'Failed print allowance (%)', 1)}
      ${field('packaging', 'Packaging per figure', 0.05)}
      ${field('shipping', 'Shipping per figure', 0.05)}
      ${field('feePct', 'Payment / platform fee (%)', 0.1)}
    </div><p class="tiny" style="margin-top:8px">Reference volume is the measured solid of the first real model (103 cm³ at 10 cm). Load a model in the 3D viewer to replace it.</p></div>
    <div class="card"><h3>${esc(cStyle)} style inputs <span class="tiny">${esc(STYLES[cStyle].printer)}</span></h3><div class="fgrid">
      <label class="f">Material<input class="in" data-sf="material" data-str value="${esc(s.material)}"></label>
      <label class="f">Material cost per cm³<input class="in" type="number" step="0.001" data-sf="costPerCm3" value="${s.costPerCm3}"></label>
      <label class="f">Fill (share of solid actually printed)<input class="in" type="number" step="0.05" data-sf="fill" value="${s.fill}"></label>
      <label class="f">Print speed (cm³ per hour)<input class="in" type="number" step="0.5" data-sf="speed" value="${s.speed}"></label>
      <label class="f">Machine cost per hour<input class="in" type="number" step="0.05" data-sf="machine" value="${s.machine}"></label>
      <label class="f">Hands-on minutes per figure<input class="in" type="number" step="1" data-sf="labourMin" value="${s.labourMin}"></label>
      <label class="f">Finishing per figure (paint etc.)<input class="in" type="number" step="0.1" data-sf="finishing" value="${s.finishing}"></label>
    </div><div class="row" style="margin-top:10px"><span class="grow"></span><button class="btn sm ghost" id="cReset">Clear all cost inputs</button></div></div>
  </div>`;

  $('#cStyle', main).onchange = (e) => { cStyle = e.target.value; renderCosting(main); };
  $('#cSize', main).onchange = (e) => { cSize = +e.target.value; renderCosting(main); };
  $$('[data-f]', main).forEach((i) => (i.onchange = () => { costs[i.dataset.f] = i.hasAttribute('data-str') ? i.value : +i.value; save(); renderCosting(main); }));
  $$('[data-sf]', main).forEach((i) => (i.onchange = () => { s[i.dataset.sf] = i.hasAttribute('data-str') ? i.value : +i.value; save(); renderCosting(main); }));
  $('#cReset', main).onclick = () => { if (confirm('Clear all cost inputs?')) { state.db.settings.costs = { ...structuredClone(DEFAULT_COSTS), placeholdersCleared: true }; save(); renderCosting(main); } };
}

export function renderSettings(main) {
  const refs = state.db.settings.refs;
  const labels = { blank: 'Blank base (anchor)', fullFigure: 'Standard face, full figure', closeUp: 'Standard face, close-up', sample: 'Sample figure rebuilt from parts', wedding: 'Wedding pair', teeJeans: 'Tee + jeans outfit (front)' };
  main.innerHTML = `
  <div class="page-head"><div><h1>Settings</h1><p>Data, backups and the Higgsfield reference images used in prompts.</p></div></div>
  <div class="card" id="upd" style="margin-bottom:14px"></div>
  <div class="grid g2">
    <div class="card"><h3>Your data</h3>
      <p class="small muted" style="margin-top:0">Everything is stored on this PC in one folder: orders, photos, models and the parts library. Nothing is uploaded anywhere.</p>
      <code class="small" style="display:block;background:#faf8fc;padding:8px;border-radius:8px;word-break:break-all">${esc(state.info.dataDir)}</code>
      <div class="row" style="margin-top:10px"><button class="btn" id="sOpen">Open data folder</button><button class="btn" id="sExport">Export backup (.json)</button><button class="btn" id="sImport">Restore backup…</button></div>
      <p class="tiny" style="margin-top:10px">Portable mode: create a folder called <b>TinyTwinData</b> next to the exe and the app keeps everything there instead (handy on a USB stick).</p></div>
    <div class="card"><h3>Higgsfield reference job IDs</h3><div style="display:flex;flex-direction:column;gap:8px">
      ${Object.entries(labels).map(([k, l]) => `<label class="f">${l}<input class="in" data-ref="${k}" value="${esc(refs[k] || '')}" style="font-family:Consolas,monospace;font-size:12.5px"></label>`).join('')}</div>
      <div class="row" style="margin-top:10px"><span class="grow"></span><button class="btn sm ghost" id="sRefReset">Reset to figure standard v0.4</button></div></div>
  </div>
  <div class="card" style="margin-top:14px"><h3>About</h3><p class="small muted" style="margin:0">TinyTwin Studio ${esc(state.info.version || '')} · internal tool for testing figure parts and running orders from photo to print. The interface is plain HTML/CSS, so components (part picker, spec card, pipeline cards) can be lifted onto the website.</p></div>`;
  renderUpdates($('#upd', main));
  $('#sOpen', main).onclick = () => api('/api/open?path=', { method: 'POST' });
  $('#sExport', main).onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state.db, null, 2)], { type: 'application/json' }));
    a.download = `tinytwin-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $('#sImport', main).onclick = async () => {
    const [f] = await pickFiles('.json', false);
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || !Array.isArray(data.jobs)) throw new Error('That file is not a TinyTwin backup');
      if (!confirm(`Replace current data with this backup (${data.jobs.length} orders)?`)) return;
      await api('/api/db', { method: 'PUT', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } });
      await loadDB(); toast('Backup restored'); renderSettings(main);
    } catch (e) { toast(e.message, true); }
  };
  $$('[data-ref]', main).forEach((i) => (i.onchange = () => { refs[i.dataset.ref] = i.value.trim(); save(); toast('Saved'); }));
  $('#sRefReset', main).onclick = () => { state.db.settings.refs = { ...DEFAULT_REFS }; save(); renderSettings(main); };
}

// ---------------- Updates ----------------
export function updSettings() {
  const st = state.db.settings;
  st.update = { repo: 'erimgiray/TinyTwin-Studio', auto: true, ...(st.update || {}) };
  return st.update;
}
export async function checkUpdate() {
  const u = updSettings();
  state.update = { checking: true };
  try { state.update = await api('/api/update/check?repo=' + encodeURIComponent(u.repo)); }
  catch (e) { state.update = { error: e.message }; }
  state.update.checkedAt = new Date();
  return state.update;
}
function renderUpdates(el) {
  const u = updSettings();
  const r = state.update || {};
  const notes = r.notes ? `<pre class="prompt" style="max-height:180px;margin-top:8px">${esc(r.notes)}</pre>` : '';
  let status;
  if (r.checking) status = '<span class="spin"></span> Checking…';
  else if (r.installing) status = `<span class="spin"></span> ${esc(r.installing)}`;
  else if (r.error) status = `<span class="chip warn">Couldn't check</span> <span class="small">${esc(r.error)}</span>`;
  else if (r.newer) status = `<span class="chip gold">Update available</span> <b>v${esc(r.latest)}</b> <span class="tiny">${r.published ? 'released ' + new Date(r.published).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''} · ${(r.size / 1048576).toFixed(1)} MB</span>`;
  else if (r.latest) status = `<span class="chip ok">Up to date</span> <span class="small muted">v${esc(r.current)} is the latest version</span>`;
  else status = '<span class="small muted">Not checked yet.</span>';
  el.innerHTML = `<div class="row"><h3 style="margin:0">Updates</h3><span class="chip plum">v${esc(state.info.version || '')}</span><span class="grow"></span>
      <button class="btn" id="uCheck" ${r.checking || r.installing ? 'disabled' : ''}>Check for updates</button>
      ${r.newer ? `<button class="btn primary" id="uInstall" ${r.installing ? 'disabled' : ''}>Install v${esc(r.latest)} and restart</button>` : ''}</div>
    <div style="margin-top:10px">${status}</div>${r.newer ? notes : ''}
    <div class="row" style="margin-top:12px">
      <label class="check" style="padding:0"><input type="checkbox" id="uAuto" ${u.auto ? 'checked' : ''}><span class="small">Check automatically when the app opens</span></label><span class="grow"></span>
      <label class="f" style="flex-direction:row;align-items:center;gap:8px">Update source (GitHub)<input class="in" id="uRepo" value="${esc(u.repo)}" style="width:240px;font-family:Consolas,monospace;font-size:12.5px"></label></div>
    <p class="tiny" style="margin:8px 0 0">Your orders, library and settings are kept — only the app file is replaced. The previous version is removed after a successful restart.</p>`;
  const again = () => renderUpdates(el);
  $('#uCheck', el).onclick = async () => { state.update = { checking: true }; again(); await checkUpdate(); again(); markNav(); };
  $('#uAuto', el).onchange = (e) => { u.auto = e.target.checked; save(); };
  $('#uRepo', el).onchange = (e) => { u.repo = e.target.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''); save(); state.update = null; again(); };
  const ib = $('#uInstall', el);
  if (ib) ib.onclick = async () => {
    if (!confirm(`Install TinyTwin Studio v${r.latest}? The app will close and reopen in a few seconds.`)) return;
    state.update = { ...r, installing: `Downloading and installing v${r.latest}…` }; again();
    try {
      await api('/api/update/install?repo=' + encodeURIComponent(u.repo), { method: 'POST' });
      state.update = { ...r, installing: 'Installed — restarting the app…' }; again();
      // In the app window the old process closes this window; in a browser tab, reload once the new version answers.
      const want = r.latest;
      const t = setInterval(async () => {
        try { const i = await (await fetch('/api/info')).json(); if (i.version === want) { clearInterval(t); location.reload(); } } catch {}
      }, 1000);
    } catch (e) { state.update = { ...r, error: e.message }; again(); }
  };
}
export function markNav() {
  const a = document.querySelector('#nav a[data-view="settings"]');
  if (!a) return;
  a.querySelector('.upd')?.remove();
  if (state.update?.newer) a.insertAdjacentHTML('beforeend', '<span class="upd chip gold" style="margin-left:auto;padding:0 7px">1</span>');
}
