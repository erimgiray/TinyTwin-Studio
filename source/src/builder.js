import { STYLES, KNOWN_GAPS, STATUS, MESHY_SETTINGS, state, save, esc, uid, $, $$, toast, copy, modal, pickFiles, upload, api, categories, partById, partStatus, withDefaults, skinHex, buildPrompt, turnaroundPrompts, specLines, unitCost, money, costsSet, loadLibrary } from './core.js';
import { go } from './main.js';
import { openJob } from './pipeline.js';

let curCat = null;
let heroId = null;
let compareMode = false;
let cmp = [];

function emptyLibrary(main, title) {
  main.innerHTML = `<div class="page-head"><div><h1>${title}</h1><p>Mix and match parts from the feature library.</p></div></div>
  <div class="card empty"><div class="big">▦</div><h3>The feature library isn't loaded yet</h3>
  <p>Import the Tiny Twin feature library (124 part images, 10 sheets) once and every option shows up here.</p>
  <button class="btn primary" data-go="library">Set up the library</button></div>`;
}

// ---------------- Figure builder ----------------
export function renderBuilder(main, params = {}) {
  if (!state.lib.parts.length) return emptyLibrary(main, 'Figure builder');
  const job = params.job ? state.db.jobs.find((j) => j.id === params.job) : null;
  const spec = job ? job.spec : state.db.draft;
  if (job) { spec.style = job.style; spec.size = job.size; }
  spec.sel = withDefaults(spec.sel || {});
  const cats = categories();
  if (!cats.find((c) => c.key === curCat)) curCat = cats[0].key;
  const cat = cats.find((c) => c.key === curCat);
  if (!heroId || !partById(heroId)) heroId = spec.sel[cat.sections[0].key] || cat.sections[0].parts[0].id;
  const hero = partById(heroId);
  const lines = specLines(spec);
  const changed = lines.filter((l) => l.part && !l.isDefault).length;
  const st = STYLES[spec.style] || STYLES.Pop;
  const sizeOk = st.sizes.includes(+spec.size);
  const cost = unitCost(spec.style, spec.size);

  main.innerHTML = `
  <div class="page-head"><div><h1>Figure builder</h1><p>${job ? `Editing the spec for <b>${esc(job.code)} · ${esc(job.customer || 'Unnamed')}</b>` : 'Scratch figure — test combinations, save presets, or apply to an order.'}</p></div><div class="sp"></div>
    <div class="seg"><button class="${compareMode ? '' : 'on'}" id="bModeSel">Select</button><button class="${compareMode ? 'on' : ''}" id="bModeCmp">Compare A/B</button></div>
    ${job ? `<button class="btn" id="bBack">← Back to order</button>` : `<button class="btn" id="bPresets">Presets (${state.db.presets.length})</button><button class="btn" id="bApply">Apply to order…</button>`}
    <button class="btn primary" id="bPrompt">Generate prompts</button></div>
  ${compareMode ? `<div class="banner plum" style="margin-bottom:14px">Compare mode: click any two options to see them side by side. ${cmp.length ? `<b>${cmp.length}/2 picked</b>` : ''}<span class="grow"></span>${cmp.length === 2 ? '<button class="btn sm primary" id="bShowCmp">Show comparison</button>' : ''}<button class="btn sm" id="bClrCmp">Clear</button></div>` : ''}
  <div class="builder">
    <div class="cats">${cats.map((c) => {
      const nonDef = c.sections.filter((s) => { const p = partById(spec.sel[s.key]); return p && !p.default; }).length;
      return `<button data-cat="${esc(c.key)}" class="${c.key === curCat ? 'on' : ''}">${esc(c.label)}${nonDef ? '<span class="dot" style="background:var(--gold)"></span>' : ''}<span class="n">${c.sections.reduce((a, s) => a + s.parts.length, 0)}</span></button>`; }).join('')}
      <div style="margin-top:10px;padding:0 6px"><button class="btn sm ghost" id="bReset">↺ Reset to standard</button></div></div>

    <div>${cat.sections.map((s) => {
      const hasDefault = s.parts.some((p) => p.default);
      return `<div class="sec-h">${esc(cat.sections.length > 1 || s.label !== 'Options' ? s.label : cat.label)}<span class="tiny">${s.parts.length} options</span></div>
      <div class="tiles">
        ${hasDefault ? '' : `<div class="tile ${spec.sel[s.key] == null ? 'on' : ''}" data-none="${esc(s.key)}"><div class="ph">∅</div><div class="cap">None</div></div>`}
        ${s.parts.map((p) => { const stt = partStatus(p.id); const sk = skinHex(p.name); return `<div class="tile ${spec.sel[s.key] === p.id ? 'on' : ''} ${cmp.includes(p.id) ? 'cmp' : ''}" data-part="${esc(p.id)}" data-sec="${esc(s.key)}">
          <img src="${p.thumb}" loading="lazy">${p.default ? '<span class="chip plum badge">default</span>' : ''}<span class="st" style="background:${STATUS[stt].color}" title="${STATUS[stt].label}"></span>
          <div class="cap">${sk && /skin/i.test(cat.label) ? `<span class="swatch" style="background:${sk}"></span> ` : ''}${esc(p.name)}</div></div>`; }).join('')}
      </div>`; }).join('')}</div>

    <div class="spec">
      <div class="card" style="padding:12px">
        <div class="hero"><img src="${hero.url}"><span class="lab chip plum">${esc(hero.catLabel)} · ${esc(hero.name)}</span></div>
        <div class="row" style="margin-top:8px;gap:6px"><span class="small muted">Mark this part:</span>
          ${Object.entries(STATUS).map(([k, v]) => `<button class="btn sm ${partStatus(hero.id) === k ? 'primary' : ''}" data-mark="${k}">${v.label}</button>`).join('')}</div>
        <input class="in" id="bNote" placeholder="Note on this part (what's wrong / what to try)" value="${esc(state.db.partMeta[hero.id]?.note || '')}" style="width:100%;margin-top:8px">
        <div class="mini" style="margin-top:10px">${lines.filter((l) => l.part).map((l) => `<img src="${l.part.thumb}" title="${esc(l.what + ': ' + l.part.name)}" data-hero="${esc(l.part.id)}" class="${l.part.id === hero.id ? 'on' : ''}">`).join('')}</div>
      </div>
      <div class="card"><h3>Spec card <span class="chip ${changed ? 'gold' : ''}">${changed} change${changed === 1 ? '' : 's'} from standard</span></h3>
        <div class="fgrid">
          <label class="f">Print style<select class="in" id="bStyle">${Object.keys(STYLES).map((s) => `<option ${s === spec.style ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <label class="f">Size (cm)<select class="in" id="bSize">${[5, 8, 10, 12, 18].map((s) => `<option ${s == spec.size ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        </div>
        <p class="small ${sizeOk ? 'muted' : ''}" style="margin:6px 0 0;${sizeOk ? '' : 'color:var(--bad)'}">${sizeOk ? `${esc(st.look)} · ${esc(st.printer)} · min ${st.thin} mm${costsSet() ? ' · est. ' + money(cost.total) + ' each' : ''}` : `${spec.size} cm is too small for ${spec.style} — fine parts drop below ${st.thin} mm. Use ${st.sizes.join(' / ')} cm.`}</p>
        <label class="f" style="margin-top:10px">Tattoo (printed on skin)<input class="in" id="bTattoo" value="${esc(spec.tattoo || '')}" placeholder="e.g. small rose on left forearm"></label>
        <label class="f" style="margin-top:8px">Plinth text<input class="in" id="bPlinth" value="${esc(spec.plinthText || '')}" placeholder="e.g. Sam & Alex · 12.06.27"></label>
        <label class="f" style="margin-top:8px">Matching notes<input class="in" id="bNotes" value="${esc(spec.notes || '')}" placeholder="e.g. slight gap in front teeth, freckles"></label>
        <dl class="speclist" style="margin-top:12px">${lines.map((l) => `<dt>${esc(l.what)}</dt><dd>${l.none ? '<span class="muted">None</span>' : esc(l.part.name) + (l.isDefault ? ' <span class="tiny">(std)</span>' : '')}</dd>`).join('')}</dl>
      </div>
    </div>
  </div>`;

  const rerender = () => renderBuilder(main, params);
  const persist = () => { if (job) job.updated = new Date().toISOString(); save(); };
  $$('[data-cat]', main).forEach((b) => (b.onclick = () => { curCat = b.dataset.cat; const c = cats.find((x) => x.key === curCat); heroId = spec.sel[c.sections[0].key] || c.sections[0].parts[0].id; rerender(); main.scrollTop = 0; }));
  $$('[data-part]', main).forEach((t) => (t.onclick = () => {
    const id = t.dataset.part;
    if (compareMode) {
      cmp = cmp.includes(id) ? cmp.filter((x) => x !== id) : [...cmp, id].slice(-2);
      rerender();
      if (cmp.length === 2) showCompare();
      return;
    }
    spec.sel[t.dataset.sec] = id; heroId = id; persist(); rerender();
  }));
  $$('[data-none]', main).forEach((t) => (t.onclick = () => { spec.sel[t.dataset.none] = null; persist(); rerender(); }));
  $$('[data-hero]', main).forEach((i) => (i.onclick = () => { heroId = i.dataset.hero; const p = partById(heroId); curCat = p.category; rerender(); }));
  $$('[data-mark]', main).forEach((b) => (b.onclick = () => { state.db.partMeta[hero.id] = { ...(state.db.partMeta[hero.id] || {}), status: b.dataset.mark }; save(); rerender(); }));
  $('#bNote', main).onchange = (e) => { state.db.partMeta[hero.id] = { ...(state.db.partMeta[hero.id] || {}), note: e.target.value }; save(); toast('Note saved'); };
  $('.hero', main).onclick = () => modal(`<img class="big" src="${hero.url}"><div class="row" style="margin-top:8px"><b>${esc(hero.catLabel)} · ${esc(hero.name)}</b><span class="grow"></span><button class="btn sm" data-close>Close</button></div>`);
  $('#bStyle', main).onchange = (e) => { spec.style = e.target.value; if (job) job.style = spec.style; persist(); rerender(); };
  $('#bSize', main).onchange = (e) => { spec.size = +e.target.value; if (job) job.size = spec.size; persist(); rerender(); };
  $('#bTattoo', main).onchange = (e) => { spec.tattoo = e.target.value; persist(); };
  $('#bPlinth', main).onchange = (e) => { spec.plinthText = e.target.value; persist(); };
  $('#bNotes', main).onchange = (e) => { spec.notes = e.target.value; persist(); };
  $('#bReset', main).onclick = () => { spec.sel = withDefaults({}); persist(); rerender(); };
  $('#bModeSel', main).onclick = () => { compareMode = false; cmp = []; rerender(); };
  $('#bModeCmp', main).onclick = () => { compareMode = true; rerender(); };
  $('#bShowCmp', main) && ($('#bShowCmp', main).onclick = showCompare);
  $('#bClrCmp', main) && ($('#bClrCmp', main).onclick = () => { cmp = []; rerender(); });
  $('#bPrompt', main).onclick = () => promptModal(spec);
  if (job) $('#bBack', main).onclick = () => { go('orders'); openJob(job.id); };
  else {
    $('#bPresets', main).onclick = () => presetsModal(spec, rerender);
    $('#bApply', main).onclick = () => applyModal(spec);
  }

  function showCompare() {
    const [a, b] = cmp.map(partById);
    modal(`<div class="row" style="margin-bottom:10px"><b>A/B comparison</b><span class="grow"></span><button class="btn sm" data-close>Close</button></div>
      <div class="compare">${[a, b].map((p, i) => `<div><img src="${p.url}"><div class="row" style="margin-top:8px"><b>${'AB'[i]} · ${esc(p.catLabel)} – ${esc(p.name)}</b><span class="grow"></span>
        ${Object.entries(STATUS).map(([k, v]) => `<button class="btn sm ${partStatus(p.id) === k ? 'primary' : ''}" data-cm="${esc(p.id)}" data-st="${k}">${v.label}</button>`).join('')}</div>
        ${state.db.partMeta[p.id]?.note ? `<p class="small muted">${esc(state.db.partMeta[p.id].note)}</p>` : ''}</div>`).join('')}</div>`, (box, close) => {
      $$('[data-cm]', box).forEach((btn) => (btn.onclick = () => { state.db.partMeta[btn.dataset.cm] = { ...(state.db.partMeta[btn.dataset.cm] || {}), status: btn.dataset.st }; save(); close(); rerender(); showCompare(); }));
    });
  }
}

function promptModal(spec) {
  const main = buildPrompt(spec);
  const turns = turnaroundPrompts();
  modal(`<div class="row" style="margin-bottom:10px"><h3 style="margin:0">Prompts for this figure</h3><span class="grow"></span><button class="btn sm" data-close>Close</button></div>
  <div class="grid g2" style="width:min(1000px,90vw)">
    <div><div class="row"><b>1 · Front render</b> <span class="tiny">Nano Banana Pro, 2k, close-up + full figure as references</span><span class="grow"></span><button class="btn sm primary" data-cp="main">Copy</button></div>
      <pre class="prompt" style="margin-top:6px">${esc(main)}</pre></div>
    <div><div class="row"><b>2 · Turnaround views</b><span class="tiny">reference = the approved front render</span></div>
      ${turns.map(([t, p], i) => `<div class="row" style="margin-top:8px"><span class="small">${t}</span><span class="grow"></span><button class="btn sm" data-cp="t${i}">Copy</button></div><pre class="prompt" style="margin-top:4px">${esc(p)}</pre>`).join('')}
      <div class="row" style="margin-top:10px"><b>3 · Image → 3D settings</b><span class="grow"></span><button class="btn sm" data-cp="meshy">Copy</button></div>
      <pre class="prompt" style="margin-top:4px">${esc(MESHY_SETTINGS)}</pre></div>
  </div>`, (box) => {
    $$('[data-cp]', box).forEach((b) => (b.onclick = () => { const k = b.dataset.cp; copy(k === 'main' ? main : k === 'meshy' ? MESHY_SETTINGS : turns[+k.slice(1)][1], 'Prompt copied'); }));
  });
}

function presetsModal(spec, rerender) {
  const db = state.db;
  modal(`<div style="width:min(560px,90vw)"><div class="row" style="margin-bottom:10px"><h3 style="margin:0">Presets</h3><span class="grow"></span><button class="btn sm" data-close>Close</button></div>
    <div class="row"><input class="in grow" id="pName" placeholder="Name this combination (e.g. Groom – classic tux)"><button class="btn primary" id="pSave">Save current</button></div>
    <table class="t" style="margin-top:12px">${db.presets.map((p, i) => `<tr><td><b>${esc(p.name)}</b><div class="tiny">${esc(p.spec.style)} · ${p.spec.size} cm</div></td><td style="text-align:right"><button class="btn sm" data-load="${i}">Load</button> <button class="btn sm ghost danger" data-del="${i}">✕</button></td></tr>`).join('') || '<tr><td class="muted">No presets yet.</td></tr>'}</table></div>`, (box, close) => {
    $('#pSave', box).onclick = () => { const n = $('#pName', box).value.trim(); if (!n) return toast('Give the preset a name', true); db.presets.push({ id: uid(), name: n, spec: structuredClone(spec) }); save(); close(); toast('Preset saved'); rerender(); };
    $$('[data-load]', box).forEach((b) => (b.onclick = () => { db.draft = structuredClone(db.presets[+b.dataset.load].spec); save(); close(); rerender(); }));
    $$('[data-del]', box).forEach((b) => (b.onclick = () => { db.presets.splice(+b.dataset.del, 1); save(); close(); presetsModal(spec, rerender); }));
  });
}

function applyModal(spec) {
  const jobs = state.db.jobs.filter((j) => j.stage !== 'done');
  modal(`<div style="width:min(520px,90vw)"><div class="row" style="margin-bottom:10px"><h3 style="margin:0">Apply this figure to an order</h3><span class="grow"></span><button class="btn sm" data-close>Close</button></div>
    <table class="t">${jobs.map((j) => `<tr><td><b>${esc(j.code)}</b> ${esc(j.customer || 'Unnamed')}<div class="tiny">${esc(j.occasion)} · ${esc(j.style)} ${j.size} cm</div></td><td style="text-align:right"><button class="btn sm primary" data-j="${j.id}">Apply</button></td></tr>`).join('') || '<tr><td class="muted">No open orders.</td></tr>'}</table>
    <button class="btn" id="aNew" style="margin-top:12px">+ Create a new order with this figure</button></div>`, (box, close) => {
    const apply = (j) => { j.spec = structuredClone(spec); j.style = spec.style; j.size = spec.size; j.history.push({ t: new Date().toISOString(), msg: 'Figure spec applied from builder' }); save(); close(); go('orders'); openJob(j.id); };
    $$('[data-j]', box).forEach((b) => (b.onclick = () => apply(state.db.jobs.find((j) => j.id === b.dataset.j))));
    $('#aNew', box).onclick = async () => { const { newJob } = await import('./pipeline.js'); apply(newJob()); };
  });
}

// ---------------- Parts library ----------------
let libTab = 'parts';
let libCat = 'all';
let libStatus = 'all';
export function renderLibrary(main) {
  const { parts, sheets } = state.lib;
  const cats = categories();
  const info = state.info;
  const shown = parts.filter((p) => (libCat === 'all' || p.category === libCat) && (libStatus === 'all' || partStatus(p.id) === libStatus));
  const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, parts.filter((p) => partStatus(p.id) === k).length]));
  main.innerHTML = `
  <div class="page-head"><div><h1>Parts library</h1><p>${parts.length ? `${parts.length} parts in ${cats.length} categories · ${sheets.length} sheets` : 'Import the Tiny Twin feature library to get started.'}</p></div><div class="sp"></div>
    <button class="btn" id="lDl">⤓ Download from saved link</button><button class="btn" id="lZip">Import zip…</button>
    ${parts.length ? '<button class="btn ghost" id="lOpen">Open folder</button><button class="btn ghost danger" id="lClear">Clear</button>' : ''}</div>
  <div id="lBusy"></div>
  ${parts.length ? `
  <div class="row" style="margin-bottom:14px">
    <div class="seg"><button data-tab="parts" class="${libTab === 'parts' ? 'on' : ''}">Parts</button><button data-tab="sheets" class="${libTab === 'sheets' ? 'on' : ''}">Sheets</button><button data-tab="gaps" class="${libTab === 'gaps' ? 'on' : ''}">Known gaps & notes</button></div>
    ${libTab === 'parts' ? `<select class="in" id="lCat"><option value="all">All categories</option>${cats.map((c) => `<option value="${esc(c.key)}" ${c.key === libCat ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
    <div class="seg">${[['all', 'All ' + parts.length], ...Object.entries(STATUS).map(([k, v]) => [k, v.label + ' ' + counts[k]])].map(([k, l]) => `<button data-stf="${k}" class="${libStatus === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
  </div>
  ${libTab === 'parts' ? cats.filter((c) => libCat === 'all' || c.key === libCat).map((c) => {
    const ps = shown.filter((p) => p.category === c.key);
    if (!ps.length) return '';
    return `<div class="sec-h" style="font-size:15px">${esc(c.label)} <span class="tiny">${ps.length}</span></div><div class="tiles">${ps.map((p) => `<div class="tile" data-lp="${esc(p.id)}"><img src="${p.thumb}" loading="lazy">${p.default ? '<span class="chip plum badge">default</span>' : ''}<span class="st" style="background:${STATUS[partStatus(p.id)].color}"></span><div class="cap">${esc(p.name)}<small>${esc(p.section)}</small></div></div>`).join('')}</div>`;
  }).join('') || '<div class="empty">Nothing matches that filter.</div>' : ''}
  ${libTab === 'sheets' ? `<div class="tiles" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${sheets.map((s, i) => `<div class="tile" data-sheet="${i}"><img src="${s.thumb}" loading="lazy" style="aspect-ratio:auto"><div class="cap">${esc(s.name)}</div></div>`).join('') || '<div class="empty">No sheets in this library.</div>'}</div>` : ''}
  ${libTab === 'gaps' ? `<div class="grid g2"><div class="card"><h3>Known gaps (from the figure standard)</h3>${KNOWN_GAPS.map((g) => `<p class="small" style="margin:6px 0">• ${esc(g)}</p>`).join('')}</div>
    <div class="card"><h3>Your part notes</h3>${parts.filter((p) => state.db.partMeta[p.id]?.note || partStatus(p.id) === 'rework').map((p) => `<div class="row" style="padding:5px 0;border-bottom:1px dashed var(--line)"><img src="${p.thumb}" style="width:36px;height:36px;border-radius:6px;object-fit:cover"><div class="grow"><b class="small">${esc(p.catLabel)} – ${esc(p.name)}</b><div class="tiny">${esc(state.db.partMeta[p.id]?.note || '')}</div></div><span class="chip ${STATUS[partStatus(p.id)].cls}">${STATUS[partStatus(p.id)].label}</span></div>`).join('') || '<p class="muted small">Mark parts as approved / needs rework in the builder or here, and add notes.</p>'}</div></div>` : ''}
  ` : `<div class="card empty"><div class="big">▦</div><h3>No library yet</h3>
    <p style="max-width:560px;margin:0 auto 14px">Use <b>Download from saved link</b> to fetch your feature library zip (53 MB) straight into the app, or <b>Import zip…</b> if you've already downloaded it. Any zip laid out as <code>parts/&lt;category&gt;/[section/]&lt;option&gt;.jpg</code> works, so new parts can be added the same way.</p>
    <div class="drop-zone" id="lDrop" style="max-width:520px;margin:auto">Or drop the zip here</div></div>`}`;

  const busy = (on, msg) => ($('#lBusy', main).innerHTML = on ? `<div class="banner plum" style="margin-bottom:14px"><span class="spin"></span>${esc(msg)}</div>` : '');
  const doImport = async (fn, msg) => {
    busy(true, msg);
    try { state.lib = await fn(); toast(`Library ready: ${state.lib.parts.length} parts`); renderLibrary(main); }
    catch (e) { busy(false); toast(e.message, true); }
  };
  $('#lDl', main).onclick = () => doImport(() => api('/api/library/import?url=' + encodeURIComponent(info.libraryURL), { method: 'POST' }), 'Downloading the feature library (53 MB) and building previews… this can take a minute.');
  const fromFiles = (files) => files[0] && doImport(() => upload('/api/library/import', [files[0]]), 'Importing and building previews…');
  $('#lZip', main).onclick = async () => fromFiles(await pickFiles('.zip', false));
  $('#lDrop', main) && (await_drop($('#lDrop', main), fromFiles));
  $('#lOpen', main) && ($('#lOpen', main).onclick = () => api('/api/open?path=library', { method: 'POST' }));
  $('#lClear', main) && ($('#lClear', main).onclick = async () => { if (confirm('Remove the imported library? Part notes are kept.')) { state.lib = await api('/api/library/clear', { method: 'POST' }); renderLibrary(main); } });
  $$('[data-tab]', main).forEach((b) => (b.onclick = () => { libTab = b.dataset.tab; renderLibrary(main); }));
  $$('[data-stf]', main).forEach((b) => (b.onclick = () => { libStatus = b.dataset.stf; renderLibrary(main); }));
  $('#lCat', main) && ($('#lCat', main).onchange = (e) => { libCat = e.target.value; renderLibrary(main); });
  $$('[data-sheet]', main).forEach((t) => (t.onclick = () => modal(`<img class="big" src="${sheets[+t.dataset.sheet].url}"><div class="row" style="margin-top:8px"><b>${esc(sheets[+t.dataset.sheet].name)}</b><span class="grow"></span><button class="btn sm" data-close>Close</button></div>`)));
  $$('[data-lp]', main).forEach((t) => (t.onclick = () => partModal(partById(t.dataset.lp), () => renderLibrary(main))));
}
function await_drop(el, fn) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); fn([...e.dataTransfer.files]); });
  el.onclick = async () => fn(await pickFiles('.zip', false));
}

function partModal(p, after) {
  const meta = state.db.partMeta[p.id] || {};
  modal(`<div style="display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:16px;width:min(1000px,90vw)">
    <img class="big" src="${p.url}">
    <div><div class="tiny">${esc(p.catLabel)} · ${esc(p.section)}</div><h2 style="margin:2px 0 10px">${esc(p.name)} ${p.default ? '<span class="chip plum">default</span>' : ''}</h2>
      <div style="display:flex;flex-direction:column;gap:6px">${Object.entries(STATUS).map(([k, v]) => `<button class="btn ${(meta.status || 'untested') === k ? 'primary' : ''}" data-s="${k}">${v.label}</button>`).join('')}</div>
      <label class="f" style="margin-top:12px">Note<textarea class="in" id="pmNote">${esc(meta.note || '')}</textarea></label>
      <div class="row" style="margin-top:12px"><button class="btn" id="pmUse">Use in builder</button><span class="grow"></span><button class="btn sm" data-close>Close</button></div>
      <p class="tiny" style="margin-top:12px">${esc(p.id)}</p></div></div>`, (box, close) => {
    const upd = (patch) => { state.db.partMeta[p.id] = { ...(state.db.partMeta[p.id] || {}), ...patch }; save(); };
    $$('[data-s]', box).forEach((b) => (b.onclick = () => { upd({ status: b.dataset.s }); $$('[data-s]', box).forEach((x) => x.classList.toggle('primary', x === b)); after(); }));
    $('#pmNote', box).onchange = (e) => upd({ note: e.target.value });
    $('#pmUse', box).onclick = () => {
      const d = state.db.draft; d.sel = withDefaults(d.sel || {}); d.sel[p.category + '|' + p.section] = p.id; save();
      curCat = p.category; heroId = p.id; close(); go('builder');
    };
  });
}
