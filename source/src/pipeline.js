import { STAGES, STYLES, OCCASIONS, PHOTO_TAGS, state, save, esc, uid, $, $$, money, costsSet, costText, fmtDate, daysUntil, toast, copy, modal, pickFiles, dropZone, upload, api, stageIdx, unitCost, specLines, buildPrompt, partStatus, categories } from './core.js';
import { go } from './main.js';

export function newJob(extra = {}) {
  const db = state.db;
  db.seq = (db.seq || 0) + 1;
  const now = new Date().toISOString();
  const job = {
    id: uid(), code: 'TT-' + String(db.seq).padStart(4, '0'), customer: '', contact: '', occasion: 'Gift', style: 'Pop', size: 12, qty: 1,
    price: db.settings.costs.priceTarget, due: '', source: '', notes: '', stage: 'intake', created: now, updated: now,
    photos: [], concepts: [], models: [], checks: {}, spec: { sel: {}, style: 'Pop', size: 12 }, history: [{ t: now, msg: 'Order created' }], ...extra,
  };
  db.jobs.unshift(job);
  save();
  return job;
}
const jobById = (id) => state.db.jobs.find((j) => j.id === id);
function progress(job) {
  const st = STAGES[stageIdx(job.stage)];
  const done = st.checks.filter((_, i) => job.checks?.[st.key]?.[i]).length;
  return { st, done, total: st.checks.length, overall: (stageIdx(job.stage) + done / st.checks.length) / STAGES.length };
}
function nextTodo(job) {
  const { st } = progress(job);
  const i = st.checks.findIndex((_, i) => !job.checks?.[st.key]?.[i]);
  return i < 0 ? 'Ready to move on' : st.checks[i];
}
function dueChip(job) {
  const d = daysUntil(job.due);
  if (d == null || job.stage === 'done') return '';
  const cls = d < 0 ? 'bad' : d <= 3 ? 'warn' : '';
  return `<span class="chip ${cls}">${d < 0 ? Math.abs(d) + 'd late' : d === 0 ? 'Due today' : 'Due ' + fmtDate(job.due)}</span>`;
}

// ---------------- Dashboard ----------------
export function renderDashboard(main) {
  const jobs = state.db.jobs;
  const active = jobs.filter((j) => j.stage !== 'done');
  const prod = jobs.filter((j) => ['prep', 'print', 'qc'].includes(j.stage));
  const dueSoon = active.filter((j) => { const d = daysUntil(j.due); return d != null && d <= 7; });
  const parts = state.lib.parts;
  const appr = parts.filter((p) => partStatus(p.id) === 'approved').length;
  const rew = parts.filter((p) => partStatus(p.id) === 'rework').length;
  const margins = active.map((j) => (+j.price || 0) - unitCost(j.style, j.size).total);
  const avgMargin = margins.length && costsSet() ? margins.reduce((a, b) => a + b, 0) / margins.length : null;
  const counts = STAGES.map((s) => jobs.filter((j) => j.stage === s.key).length);
  const max = Math.max(1, ...counts);
  const upcoming = [...active].sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).slice(0, 6);

  main.innerHTML = `
  <div class="page-head"><div><h1>Dashboard</h1><p>Photo → figure → print, at a glance.</p></div><div class="sp"></div>
    <button class="btn primary" id="dNew">+ New order</button></div>
  ${parts.length ? '' : `<div class="banner" style="margin-bottom:14px"><b>Feature library not loaded.</b><span class="muted">Import it once to test parts in the builder.</span><div class="sp grow"></div><button class="btn sm gold" data-go="library">Set up library</button></div>`}
  <div class="grid g4">
    <div class="card kpi"><div class="l">Active orders</div><div class="v">${active.length}</div><div class="s">${jobs.length - active.length} shipped</div></div>
    <div class="card kpi"><div class="l">In production</div><div class="v">${prod.length}</div><div class="s">print prep, printing, QC</div></div>
    <div class="card kpi"><div class="l">Due in 7 days</div><div class="v" style="color:${dueSoon.length ? 'var(--warn)' : 'inherit'}">${dueSoon.length}</div><div class="s">${active.filter((j) => daysUntil(j.due) < 0).length} late</div></div>
    <div class="card kpi"><div class="l">Avg margin / figure</div><div class="v">${avgMargin == null ? '–' : money(avgMargin)}</div><div class="s">${costsSet() ? 'price minus estimated unit cost' : 'enter your costs on the Costing page'}</div></div>
  </div>
  <div class="grid g2" style="margin-top:14px">
    <div class="card"><h3>Pipeline</h3>
      <svg class="chart" viewBox="0 0 460 ${STAGES.length * 30}" width="100%">
        ${STAGES.map((s, i) => `<g transform="translate(0,${i * 30})"><text x="0" y="17">${esc(s.label)}</text>
          <rect x="110" y="5" width="${Math.max(2, (counts[i] / max) * 300)}" height="16" rx="4" fill="${s.color}"/>
          <text x="${118 + (counts[i] / max) * 300}" y="17" style="font-weight:600;fill:var(--ink)">${counts[i]}</text></g>`).join('')}
      </svg>
    </div>
    <div class="card"><h3>Next up</h3>
      ${upcoming.length ? `<table class="t"><tr><th>Order</th><th>Stage</th><th>Next step</th><th></th></tr>
      ${upcoming.map((j) => `<tr data-job="${j.id}" style="cursor:pointer"><td><b>${esc(j.code)}</b><div class="tiny">${esc(j.customer || 'Unnamed')}</div></td>
        <td><span class="chip" style="background:${STAGES[stageIdx(j.stage)].color}22;color:${STAGES[stageIdx(j.stage)].color}">${STAGES[stageIdx(j.stage)].label}</span></td>
        <td class="small">${esc(nextTodo(j))}</td><td>${dueChip(j)}</td></tr>`).join('')}</table>`
        : `<div class="empty"><div class="big">🧸</div>No orders yet. Create a test order to try the flow.</div>`}
    </div>
  </div>
  <div class="grid g3" style="margin-top:14px">
    <div class="card"><h3>Parts library</h3>
      ${parts.length ? `<div class="bar" style="height:10px;display:flex"><i style="width:${(appr / parts.length) * 100}%;background:var(--ok)"></i><i style="width:${(rew / parts.length) * 100}%;background:var(--bad)"></i></div>
      <div class="row small" style="margin-top:8px"><span><span class="dot" style="background:var(--ok)"></span> ${appr} approved</span><span><span class="dot" style="background:var(--bad)"></span> ${rew} need rework</span><span class="muted">${parts.length - appr - rew} untested</span></div>` : '<p class="muted">Not imported yet.</p>'}
      <button class="btn sm" style="margin-top:10px" data-go="library">Open library</button></div>
    <div class="card"><h3>Unit cost at a glance</h3>
      <table class="t"><tr><th>Style</th>${[8, 12, 18].map((s) => `<th>${s} cm</th>`).join('')}</tr>
      ${Object.keys(STYLES).map((st) => `<tr><td>${st}</td>${[8, 12, 18].map((s) => `<td>${STYLES[st].sizes.includes(s) ? costText(unitCost(st, s).total) : '<span class="tiny">n/a</span>'}</td>`).join('')}</tr>`).join('')}</table>
      <button class="btn sm" style="margin-top:10px" data-go="costing">Open costing</button></div>
    <div class="card"><h3>Quick start</h3>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="btn" data-go="builder">✦ Test parts in the figure builder</button>
        <button class="btn" data-go="viewer">◈ Check a 3D model</button>
        <button class="btn" id="dNew2">▤ Run a test order end to end</button>
      </div></div>
  </div>`;
  const create = () => openJob(newJob().id);
  $('#dNew', main).onclick = create;
  $('#dNew2', main).onclick = create;
  $$('[data-job]', main).forEach((r) => (r.onclick = () => openJob(r.dataset.job)));
}

// ---------------- Pipeline board ----------------
let filter = '';
export function renderOrders(main) {
  const q = filter.toLowerCase();
  const jobs = state.db.jobs.filter((j) => !q || [j.code, j.customer, j.occasion, j.notes].join(' ').toLowerCase().includes(q));
  main.innerHTML = `
  <div class="page-head"><div><h1>Pipeline</h1><p>Drag cards between stages, or open one to work through its checklist.</p></div><div class="sp"></div>
    <input class="in" id="oSearch" placeholder="Search orders…" value="${esc(filter)}" style="width:220px">
    <button class="btn primary" id="oNew">+ New order</button></div>
  <div class="board">
    ${STAGES.map((s) => {
      const list = jobs.filter((j) => j.stage === s.key);
      return `<div class="col" data-stage="${s.key}"><div class="col-h"><span class="dot" style="background:${s.color}"></span>${s.label}<span class="n">${list.length}</span></div>
      ${list.map((j) => { const p = progress(j); return `<div class="jc" draggable="true" data-id="${j.id}">
        <div class="row" style="gap:6px"><span class="t">${esc(j.customer || 'Unnamed')}</span><span class="grow"></span><span class="tiny">${esc(j.code)}</span></div>
        <div class="m">${esc(j.occasion)} · ${esc(j.style)} ${j.size} cm${j.qty > 1 ? ' ×' + j.qty : ''}</div>
        ${j.photos.length ? `<div class="thumbs">${j.photos.slice(0, 4).map((ph) => `<img src="${ph.url}" loading="lazy">`).join('')}</div>` : ''}
        <div class="row" style="margin-top:6px;gap:5px">${dueChip(j)}<span class="tiny">${p.done}/${p.total} checks</span></div>
        <div class="bar"><i style="width:${(p.done / p.total) * 100}%;background:${s.color}"></i></div></div>`; }).join('')}
      </div>`;
    }).join('')}
  </div>`;
  $('#oNew', main).onclick = () => { const j = newJob(); renderOrders(main); openJob(j.id); };
  const si = $('#oSearch', main);
  si.oninput = () => { filter = si.value; renderOrders(main); const n = $('#oSearch', main); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
  $$('.jc', main).forEach((c) => {
    c.onclick = () => openJob(c.dataset.id);
    c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.id);
  });
  $$('.col', main).forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('drop'); };
    col.ondragleave = () => col.classList.remove('drop');
    col.ondrop = (e) => { e.preventDefault(); col.classList.remove('drop'); const j = jobById(e.dataTransfer.getData('text/plain')); if (j) { setStage(j, col.dataset.stage); renderOrders(main); } };
  });
}

function setStage(job, key) {
  if (job.stage === key) return;
  job.history.push({ t: new Date().toISOString(), msg: `${STAGES[stageIdx(job.stage)].label} → ${STAGES[stageIdx(key)].label}` });
  job.stage = key;
  job.updated = new Date().toISOString();
  save();
}

// ---------------- Job drawer ----------------
export function openJob(id) {
  const job = jobById(id);
  if (!job) return;
  const d = $('#drawer');
  d.hidden = false;
  const close = () => { d.hidden = true; d.innerHTML = ''; document.removeEventListener('keydown', key); go(); };
  const key = (e) => e.key === 'Escape' && $('#modal').hidden && close();
  document.addEventListener('keydown', key);
  d.onclick = (e) => { if (e.target === d) close(); };
  const render = () => renderJob(d, job, close, render);
  render();
}

function photoChecks(job) {
  const tags = new Set(job.photos.map((p) => p.tag));
  return [['Front', tags.has('Front')], ['Left', tags.has('Left')], ['Right', tags.has('Right')], ['Full body / outfit', tags.has('Full body') || tags.has('Outfit')]];
}

function renderJob(d, job, close, render) {
  const si = stageIdx(job.stage);
  const st = STAGES[si];
  const cost = unitCost(job.style, job.size);
  const margin = (+job.price || 0) - cost.total;
  const lines = specLines(job.spec).filter((l) => l.part && !l.isDefault);
  const hasLib = state.lib.parts.length > 0;
  d.innerHTML = `<div class="panel">
  <div class="panel-h"><div><div class="tiny">${esc(job.code)} · created ${fmtDate(job.created)}</div><h2>${esc(job.customer || 'Unnamed order')}</h2></div>
    <div class="sp grow"></div>${dueChip(job)}
    ${si < STAGES.length - 1 ? `<button class="btn primary" id="jNext">Move to ${STAGES[si + 1].label} →</button>` : ''}
    <button class="btn ghost" id="jClose">✕</button></div>
  <div class="panel-b">
    <div class="stepper">${STAGES.map((s, i) => `<button data-st="${s.key}" class="${i < si ? 'done' : i === si ? 'cur' : ''}">${i + 1}. ${s.label}</button>`).join('')}</div>

    <div class="grid g2">
      <div class="card"><h3>Order details</h3><div class="fgrid">
        <label class="f">Customer<input class="in" data-k="customer" value="${esc(job.customer)}"></label>
        <label class="f">Contact<input class="in" data-k="contact" value="${esc(job.contact)}" placeholder="email / phone / @handle"></label>
        <label class="f">Occasion<select class="in" data-k="occasion">${OCCASIONS.map((o) => `<option ${o === job.occasion ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
        <label class="f">Due date<input class="in" type="date" data-k="due" value="${esc(job.due)}"></label>
        <label class="f">Print style<select class="in" data-k="style">${Object.keys(STYLES).map((s) => `<option ${s === job.style ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="f">Size (cm)<select class="in" data-k="size" data-num>${STYLES[job.style].sizes.map((s) => `<option ${s == job.size ? 'selected' : ''}>${s}</option>`).join('')}${STYLES[job.style].sizes.includes(+job.size) ? '' : `<option selected>${job.size}</option>`}</select></label>
        <label class="f">Quantity<input class="in" type="number" min="1" data-k="qty" data-num value="${job.qty}"></label>
        <label class="f">Price each (${esc(state.db.settings.costs.currency)})<input class="in" type="number" step="0.5" data-k="price" data-num value="${job.price}"></label>
      </div>
      <label class="f" style="margin-top:10px">Notes<textarea class="in" data-k="notes" placeholder="Anything from the customer: likeness details, colours, message on the plinth…">${esc(job.notes)}</textarea></label></div>

      <div class="card"><h3>${st.label} checklist</h3>
        ${st.checks.map((c, i) => `<label class="check ${job.checks?.[st.key]?.[i] ? 'done' : ''}"><input type="checkbox" data-chk="${i}" ${job.checks?.[st.key]?.[i] ? 'checked' : ''}><span>${esc(c)}</span></label>`).join('')}
        <div class="bar" style="margin-top:10px"><i style="width:${progress(job).overall * 100}%"></i></div>
        <div class="tiny" style="margin-top:4px">${Math.round(progress(job).overall * 100)}% through the whole pipeline</div>
        <h3 style="margin-top:16px">Economics</h3>
        <div class="stat"><span>Est. unit cost (${esc(job.style)}, ${job.size} cm)</span><b>${costText(cost.total)}</b></div>
        <div class="stat"><span>Margin per figure</span><b style="color:${!costsSet() ? 'inherit' : margin >= 0 ? 'var(--ok)' : 'var(--bad)'}">${costText(margin)}</b></div>
        <div class="stat"><span>Order total</span><b>${money((+job.price || 0) * (+job.qty || 1))}</b></div>
        <div class="stat"><span>Est. print time</span><b>${cost.hours ? cost.hours.toFixed(1) + ' h' : '—'}</b></div>
        ${costsSet() ? '' : '<p class="tiny" style="margin:6px 0 0">Add your real costs on the Costing page to see unit cost and margin.</p>'}
        ${STYLES[job.style].sizes.includes(+job.size) ? '' : `<p class="small" style="color:var(--bad)">${job.size} cm isn't a recommended size for ${job.style} (min. part thickness ${STYLES[job.style].thin} mm).</p>`}
      </div>
    </div>

    <div class="card"><div class="row"><h3 style="margin:0">Customer photos</h3><span class="grow"></span>
      ${photoChecks(job).map(([l, ok]) => `<span class="chip ${ok ? 'ok' : ''}">${ok ? '✓' : '○'} ${l}</span>`).join('')}</div>
      <div class="tiles sm" style="margin-top:10px">${job.photos.map((p, i) => `<div class="tile" data-ph="${i}"><img src="${p.url}" loading="lazy"><button class="del" data-delph="${i}">✕</button>
        <div class="cap"><select class="in" data-tag="${i}" style="padding:2px 4px;font-size:11.5px;width:100%">${PHOTO_TAGS.map((t) => `<option ${t === p.tag ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>`).join('')}</div>
      <div class="drop-zone" id="phDrop" style="margin-top:10px">Drop photos here or <b>browse</b> — tag each one front / left / right / full body</div></div>

    <div class="card"><div class="row"><h3 style="margin:0">Figure spec</h3><span class="grow"></span>
      <button class="btn sm" id="jCopyPrompt" ${hasLib ? '' : 'disabled'}>Copy Higgsfield prompt</button>
      <button class="btn sm primary" id="jBuilder">Open in figure builder</button></div>
      ${!hasLib ? '<p class="muted small">Import the feature library to build a spec.</p>' : lines.length ? `<div class="tiles sm" style="margin-top:10px">${lines.map((l) => `<div class="tile"><img src="${l.part.thumb}" loading="lazy"><div class="cap">${esc(l.part.name)}<small>${esc(l.what)}</small></div></div>`).join('')}</div>` : '<p class="muted small" style="margin-bottom:0">Standard figure (all defaults). Open the builder to match features to the photos.</p>'}
      ${job.spec.tattoo || job.spec.plinthText ? `<p class="small">${job.spec.tattoo ? 'Tattoo: ' + esc(job.spec.tattoo) + '. ' : ''}${job.spec.plinthText ? 'Plinth: “' + esc(job.spec.plinthText) + '”' : ''}</p>` : ''}
    </div>

    <div class="grid g2">
      <div class="card"><h3>Concept renders</h3>
        <div class="tiles sm">${job.concepts.map((p, i) => `<div class="tile" data-cimg="${i}"><img src="${p.url}" loading="lazy"><button class="del" data-delc="${i}">✕</button><div class="cap">${esc(p.name)}</div></div>`).join('')}</div>
        <div class="drop-zone" id="cDrop" style="margin-top:10px">Drop Higgsfield renders (front, back, sides)</div></div>
      <div class="card"><h3>3D model files</h3>
        ${job.models.length ? `<table class="t">${job.models.map((m, i) => `<tr><td>${esc(m.name)}</td><td style="text-align:right">${/\.(glb|gltf|obj|stl)$/i.test(m.name) ? `<button class="btn sm" data-view3d="${i}">View in 3D</button>` : ''} <button class="btn sm ghost danger" data-delm="${i}">✕</button></td></tr>`).join('')}</table>` : '<p class="muted small">No model yet.</p>'}
        <div class="drop-zone" id="mDrop" style="margin-top:10px">Drop GLB / OBJ / STL (+ textures)</div></div>
    </div>

    <div class="card"><h3>History</h3>${[...job.history].reverse().map((h) => `<div class="small" style="padding:3px 0"><span class="tiny">${new Date(h.t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span> · ${esc(h.msg)}</div>`).join('')}
      <div class="row" style="margin-top:12px"><button class="btn sm" id="jDup">Duplicate order</button><span class="grow"></span><button class="btn sm danger" id="jDel">Delete order</button></div></div>
  </div></div>`;

  const p = d.firstElementChild;
  const touch = () => { job.updated = new Date().toISOString(); save(); };
  $('#jClose', p).onclick = close;
  $('#jNext', p) && ($('#jNext', p).onclick = () => { setStage(job, STAGES[si + 1].key); render(); });
  $$('[data-st]', p).forEach((b) => (b.onclick = () => { setStage(job, b.dataset.st); render(); }));
  $$('[data-k]', p).forEach((el) => (el.onchange = () => {
    const k = el.dataset.k;
    job[k] = el.hasAttribute('data-num') ? +el.value : el.value;
    if (k === 'style') { if (!STYLES[job.style].sizes.includes(+job.size)) job.size = STYLES[job.style].sizes.find((s) => s >= job.size) || STYLES[job.style].sizes.at(-1); job.spec.style = job.style; }
    if (k === 'size') job.spec.size = job.size;
    touch();
    if (['style', 'size', 'price', 'qty', 'due', 'customer'].includes(k)) render();
  }));
  $$('[data-chk]', p).forEach((cb) => (cb.onchange = () => {
    job.checks[st.key] = job.checks[st.key] || {};
    job.checks[st.key][cb.dataset.chk] = cb.checked;
    touch(); render();
  }));
  const addFiles = (kind, list) => async (files) => {
    try {
      const res = await upload(`/api/files?job=${job.id}&kind=${kind}`, files);
      for (const r of res) list.push({ ...r, tag: kind === 'photos' ? guessTag(r.name, job) : undefined });
      if (kind === 'models') job.history.push({ t: new Date().toISOString(), msg: `Added model ${res.map((r) => r.name).join(', ')}` });
      touch(); render();
    } catch (e) { toast(e.message, true); }
  };
  const wire = (id, kind, list, accept) => { const z = $(id, p); dropZone(z, addFiles(kind, list)); z.onclick = async () => { const f = await pickFiles(accept); if (f.length) addFiles(kind, list)(f); }; };
  wire('#phDrop', 'photos', job.photos, 'image/*');
  wire('#cDrop', 'concepts', job.concepts, 'image/*');
  wire('#mDrop', 'models', job.models, '.glb,.gltf,.obj,.mtl,.stl,.png,.jpg,.jpeg,.bin');
  $$('[data-tag]', p).forEach((s) => { s.onclick = (e) => e.stopPropagation(); s.onchange = () => { job.photos[s.dataset.tag].tag = s.value; touch(); render(); }; });
  const delFile = (list, i) => { const f = list[i]; list.splice(i, 1); api('/api/files?path=' + encodeURIComponent(f.path), { method: 'DELETE' }).catch(() => {}); touch(); render(); };
  $$('[data-delph]', p).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); delFile(job.photos, +b.dataset.delph); }));
  $$('[data-delc]', p).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); delFile(job.concepts, +b.dataset.delc); }));
  $$('[data-delm]', p).forEach((b) => (b.onclick = () => delFile(job.models, +b.dataset.delm)));
  $$('[data-ph]', p).forEach((t) => (t.onclick = () => gallery(job.photos, +t.dataset.ph, job)));
  $$('[data-cimg]', p).forEach((t) => (t.onclick = () => gallery(job.concepts, +t.dataset.cimg, job)));
  $$('[data-view3d]', p).forEach((b) => (b.onclick = () => { const m = job.models[+b.dataset.view3d]; close(); go('viewer', { url: m.url, name: m.name, job: job.id }); }));
  $('#jBuilder', p).onclick = () => { close(); go('builder', { job: job.id }); };
  $('#jCopyPrompt', p).onclick = () => copy(buildPrompt({ ...job.spec, style: job.style, size: job.size }), 'Prompt copied');
  $('#jDup', p).onclick = () => { const n = newJob({ customer: job.customer + ' (copy)', occasion: job.occasion, style: job.style, size: job.size, price: job.price, spec: structuredClone(job.spec) }); close(); openJob(n.id); };
  $('#jDel', p).onclick = () => {
    if (!confirm(`Delete ${job.code}? Files stay in the data folder.`)) return;
    state.db.jobs = state.db.jobs.filter((j) => j !== job); save(); close();
  };
}

function guessTag(name, job) {
  const n = name.toLowerCase();
  if (/front|face/.test(n)) return 'Front';
  if (/left/.test(n)) return 'Left';
  if (/right/.test(n)) return 'Right';
  if (/full|body|outfit/.test(n)) return 'Full body';
  const have = new Set(job.photos.map((p) => p.tag));
  return ['Front', 'Left', 'Right', 'Full body'].find((t) => !have.has(t)) || 'Other';
}

// Side-by-side: customer photo next to the current concept, to judge likeness.
function gallery(list, i, job) {
  const concept = job.concepts.at(-1);
  modal(`<div class="row" style="margin-bottom:10px"><b>${esc(list[i].name)}</b><span class="grow"></span>
    ${concept && list !== job.concepts ? '<button class="btn sm" id="gCmp">Compare with latest concept</button>' : ''}<button class="btn sm" data-close>Close</button></div>
    <div id="gBody"><img class="big" src="${list[i].url}"></div>`, (box) => {
    const b = $('#gCmp', box);
    if (b) b.onclick = () => { $('#gBody', box).innerHTML = `<div class="compare"><div><div class="tiny">Customer photo</div><img src="${list[i].url}"></div><div><div class="tiny">Concept render</div><img src="${concept.url}"></div></div>`; };
  });
}
