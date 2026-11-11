// Shared state, API helpers and domain constants for TinyTwin Studio.

export const STAGES = [
  { key: 'intake', label: 'Photos in', color: '#8f889c', checks: ['Front face photo', 'Left and right profile (or ¾) photos', 'Full-body / outfit reference', 'Photos sharp and well lit', 'Occasion, style and size confirmed'] },
  { key: 'match', label: 'Feature match', color: '#7a5bd6', checks: ['Skin tone chosen', 'Eyes: expression, spacing, iris colour', 'Hair and facial hair', 'Brows, nose, mouth, ears', 'Outfit, headwear, glasses, extras', 'Spec checked side by side with photos'] },
  { key: 'concept', label: 'Concept render', color: '#5b2e8c', checks: ['Front render generated (Nano Banana, close-up as reference)', 'Back and side views generated', 'Likeness checked against photos', 'Internal sign-off'] },
  { key: 'model', label: '3D model', color: '#3d6fb6', checks: ['Multi-image → 3D run (Meshy, 4 views)', 'Scaled to target height incl. plinth', 'Voxel-remeshed to a watertight solid', 'Thinnest part OK for the print style', 'STL / OBJ exported'] },
  { key: 'prep', label: 'Print prep', color: '#2f8f8a', checks: ['Sliced', 'Supports / brim added', 'Material and colours loaded', 'Print time and material logged'] },
  { key: 'print', label: 'Printing', color: '#d48a1f', checks: ['Print started', 'Print finished', 'Supports removed and cleaned', 'Cured / finished'] },
  { key: 'qc', label: 'QC & pack', color: '#b7791f', checks: ['Matches the spec card', 'No defects (breaks, layer lines, stringing)', 'Photographed for the portfolio', 'Packed'] },
  { key: 'done', label: 'Shipped', color: '#2f8f5b', checks: ['Shipped or handed over', 'Tracking / receipt recorded'] },
];
export const stageIdx = (k) => Math.max(0, STAGES.findIndex((s) => s.key === k));

export const STYLES = {
  Pop: { label: 'Pop', look: 'Chunky, smooth designer toy', printer: 'Filament, up to 4 colours, no painting', thin: 2, sizes: [5, 8, 12, 18], pieces: 1 },
  Classic: { label: 'Classic', look: 'Sample proportions, patterns printed in colour', printer: 'Full-colour print (or resin + simple paint)', thin: 1.2, sizes: [8, 12, 18], pieces: 1 },
  Collector: { label: 'Collector', look: 'Fine texture, clear-lens glasses', printer: 'High-res resin, hand-painted', thin: 0.8, sizes: [12, 18], pieces: 4 },
};

export const SKIN = { porcelain: '#f4dccb', ivory: '#efcfb2', sand: '#e1b98f', honey: '#cf9c67', olive: '#b58757', caramel: '#9d6a40', chestnut: '#784a2b', espresso: '#4a2d1c' };

export const OCCASIONS = ['Wedding', 'Birthday', 'Anniversary', 'Graduation', 'Gift', 'Memorial', 'Corporate', 'Other'];
export const PHOTO_TAGS = ['Front', 'Left', 'Right', 'Full body', 'Outfit', 'Other'];

export const DEFAULT_REFS = {
  blank: '9ff22afd-45fc-4d9d-8a0d-4e8cea8076ee',
  fullFigure: '2de60d08-194e-49cc-8efd-c60b6493903f',
  closeUp: 'a787f28c-e26d-41a7-87cc-89fad2ed67a9',
  sample: '30dd0b91-6483-464e-8d58-f2fcc4e08640',
  wedding: 'c543b58f-c8a9-4098-a21f-76c17944a17d',
  teeJeans: 'b1266330-8a8e-412c-b6aa-ee18bf1b3a8b',
};

// No made-up figures: every cost starts blank (0) until the owner enters real numbers.
const BLANK_STYLE = { costPerCm3: 0, fill: 0, speed: 0, machine: 0, labourMin: 0, finishing: 0 };
export const DEFAULT_COSTS = {
  currency: '$',
  priceTarget: 22,
  baseVolume: 103, // cm³ of the solid 10 cm print (measured from the first real model)
  baseHeight: 10,
  labourPerHour: 0,
  packaging: 0,
  shipping: 0,
  feePct: 0,
  failPct: 0,
  styles: {
    Pop: { material: 'PLA filament', ...BLANK_STYLE },
    Classic: { material: 'Full-colour print', ...BLANK_STYLE },
    Collector: { material: 'Resin + paint', ...BLANK_STYLE },
  },
};
// Placeholder figures shipped before v1.3.1 — cleared from saved settings unless the owner changed them.
const OLD_PLACEHOLDERS = {
  labourPerHour: 12, packaging: 1.2, shipping: 3.5, feePct: 4, failPct: 10,
  styles: {
    Pop: { costPerCm3: 0.025, fill: 0.35, speed: 10, machine: 0.3, labourMin: 8, finishing: 0 },
    Classic: { costPerCm3: 0.3, fill: 0.45, speed: 6, machine: 0.6, labourMin: 12, finishing: 0 },
    Collector: { costPerCm3: 0.042, fill: 0.4, speed: 15, machine: 0.4, labourMin: 35, finishing: 1.5 },
  },
};
function clearPlaceholders(c) {
  if (c.placeholdersCleared) return c;
  for (const k of ['labourPerHour', 'packaging', 'shipping', 'feePct', 'failPct']) if (+c[k] === OLD_PLACEHOLDERS[k]) c[k] = 0;
  for (const [st, old] of Object.entries(OLD_PLACEHOLDERS.styles)) {
    const s = c.styles[st]; if (!s) continue;
    for (const [k, v] of Object.entries(old)) if (+s[k] === v) s[k] = 0;
  }
  c.placeholdersCleared = true;
  return c;
}
// True once the owner has entered at least one real cost.
export function costsSet(c = state.db.settings.costs) {
  return [c.labourPerHour, c.packaging, c.shipping].some((v) => +v > 0) || Object.values(c.styles).some((s) => +s.costPerCm3 > 0 || +s.machine > 0);
}
export const costText = (v) => (costsSet() ? money(v) : '—');

// Feature-library category knowledge (from the figure standard). Keys match folder names loosely.
export const KNOWN_GAPS = [
  'Surprised/sad expressions show a little white around the iris (breaks the no-whites rule).',
  'Some nose and ear options differ only subtly at sheet size.',
  '3D model: plinth rim textured pale beige, not gold; eyes slightly more amber than the standard.',
  'Belt, stitching and pockets are colour only (not sculpted), so they vanish on a single-colour print.',
];

// ---------- API ----------
const H = { 'X-TinyTwin': '1' };
export async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}
export async function upload(path, files) {
  const fd = new FormData();
  for (const f of files) fd.append('file', f, f.name);
  return api(path, { method: 'POST', body: fd });
}

// ---------- store ----------
export const state = { db: null, lib: { parts: [], sheets: [] }, info: {}, models: [] };

function freshDB() {
  return { version: 1, seq: 0, jobs: [], presets: [], partMeta: {}, draft: { sel: {}, style: 'Pop', size: 12 }, settings: { costs: structuredClone(DEFAULT_COSTS), refs: { ...DEFAULT_REFS } } };
}
export async function loadDB() {
  let db = null;
  try { db = await api('/api/db'); } catch {}
  const base = freshDB();
  db = db && typeof db === 'object' ? { ...base, ...db } : base;
  db.settings = { ...base.settings, ...db.settings };
  db.settings.costs = clearPlaceholders({ ...structuredClone(DEFAULT_COSTS), ...db.settings.costs, styles: { ...structuredClone(DEFAULT_COSTS.styles), ...(db.settings.costs?.styles || {}) } });
  db.settings.refs = { ...DEFAULT_REFS, ...db.settings.refs };
  state.db = db;
}
let saveT;
export function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => api('/api/db', { method: 'PUT', body: JSON.stringify(state.db), headers: { 'Content-Type': 'application/json' } }).catch((e) => toast('Could not save: ' + e.message, true)), 300);
}
export async function loadLibrary() { state.lib = await api('/api/library'); }
export async function loadModels() { state.models = await api('/api/models'); }

// ---------- helpers ----------
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const money = (v) => state.db.settings.costs.currency + (Number(v) || 0).toFixed(2);
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
export const daysUntil = (d) => (d ? Math.ceil((new Date(d) - new Date(new Date().toDateString())) / 86400000) : null);

export function toast(msg, bad = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2800);
}
export async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(what + ' to clipboard'); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(what + ' to clipboard'); }
}
export function modal(html, onMount) {
  const m = $('#modal');
  m.innerHTML = `<div class="box">${html}</div>`;
  m.hidden = false;
  const close = () => { m.hidden = true; m.innerHTML = ''; document.removeEventListener('keydown', key); };
  const key = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', key);
  m.onclick = (e) => { if (e.target === m || e.target.closest('[data-close]')) close(); };
  onMount?.(m.firstElementChild, close);
  return close;
}
export function pickFiles(accept, multiple = true) {
  return new Promise((res) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept; i.multiple = multiple;
    i.onchange = () => res([...i.files]);
    i.click();
  });
}
export function dropZone(el, onFiles) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); });
}

// ---------- library helpers ----------
export function categories() {
  const map = new Map();
  for (const p of state.lib.parts) {
    if (!map.has(p.category)) map.set(p.category, { key: p.category, label: p.catLabel, sections: new Map() });
    const c = map.get(p.category);
    const sk = p.category + '|' + p.section;
    if (!c.sections.has(sk)) c.sections.set(sk, { key: sk, label: p.section, parts: [] });
    c.sections.get(sk).parts.push(p);
  }
  return [...map.values()].map((c) => ({ ...c, sections: [...c.sections.values()] }));
}
export const partById = (id) => state.lib.parts.find((p) => p.id === id);
export const partStatus = (id) => state.db.partMeta[id]?.status || 'untested';
export const STATUS = { untested: { label: 'Untested', cls: '', color: '#c9c2d1' }, approved: { label: 'Approved', cls: 'ok', color: '#2f8f5b' }, rework: { label: 'Needs rework', cls: 'bad', color: '#c2413b' } };

export function skinHex(name) {
  const k = Object.keys(SKIN).find((s) => String(name).toLowerCase().includes(s));
  return k ? SKIN[k] : null;
}

// Fill unset sections with the library defaults ("(default)" in file name).
export function withDefaults(sel = {}) {
  const out = { ...sel };
  for (const c of categories()) for (const s of c.sections) {
    if (!(s.key in out)) { const d = s.parts.find((p) => p.default); out[s.key] = d ? d.id : null; }
  }
  return out;
}

// ---------- costing ----------
export function unitCost(style, sizeCm, costs = state.db.settings.costs) {
  const s = costs.styles[style] || costs.styles.Pop;
  const solid = costs.baseVolume * Math.pow(sizeCm / costs.baseHeight, 3);
  const used = solid * (+s.fill || 0);
  const hours = +s.speed > 0 ? used / s.speed : 0;
  const material = used * s.costPerCm3;
  const machine = hours * s.machine;
  const labour = (s.labourMin / 60) * costs.labourPerHour;
  const make = (material + machine + labour + (+s.finishing || 0)) * (1 + costs.failPct / 100);
  const fees = (costs.priceTarget * costs.feePct) / 100;
  const total = make + +costs.packaging + +costs.shipping + fees;
  return { solid, used, hours, material, machine, labour, finishing: +s.finishing || 0, failure: make - (material + machine + labour + (+s.finishing || 0)), packaging: +costs.packaging, shipping: +costs.shipping, fees, total };
}

// ---------- prompt generator ----------
export function specLines(spec) {
  const sel = withDefaults(spec.sel);
  const lines = [];
  for (const c of categories()) for (const s of c.sections) {
    const id = sel[s.key];
    const p = id && partById(id);
    const what = c.sections.length > 1 && s.label !== 'Options' ? `${c.label} – ${s.label}` : c.label;
    lines.push({ what, part: p, isDefault: !!p?.default, none: !p });
  }
  return lines;
}
export function buildPrompt(spec) {
  const r = state.db.settings.refs;
  const changes = specLines(spec).filter((l) => !l.isDefault && !l.none).map((l) => `- ${l.what}: ${l.part.name}`);
  const extras = [];
  if (spec.tattoo) extras.push(`- Tattoo (printed flat on exposed skin): ${spec.tattoo}`);
  if (spec.plinthText) extras.push(`- Plinth front text in small gold lettering: "${spec.plinthText}"`);
  if (spec.notes) extras.push(`- Notes from the customer photos: ${spec.notes}`);
  const st = STYLES[spec.style] || STYLES.Pop;
  return [
    `REFERENCE IMAGES: standard full figure (Higgsfield job ${r.fullFigure}) and standard close-up (${r.closeUp}).`,
    ``,
    `Keep this exact figurine identical: same blank base (large round full-cheeked head about 1/3 of the height, compact body, sculpted hands with a thumb), satin-matte resin finish, deep-purple plinth with a thin gold rim, same background, lighting and camera.`,
    `Keep the signature eye exactly: large, slightly vertical oval, all-brown iris with NO white sclera, darker rim, near-black pupil, big white catchlight upper right and a small dot lower left, gloss-varnished.`,
    ``,
    `Change ONLY the following:`,
    ...(changes.length ? changes : ['- (nothing — standard figure)']),
    ...extras,
    ``,
    `Print style: ${st.label} — ${st.look}. Keep every part at least ${st.thin} mm thick at ${spec.size || 12} cm; feet joined to the plinth, nothing floating.`,
  ].join('\n');
}
export function turnaroundPrompts() {
  const base = 'Exact same figurine, same plinth, background, lighting and camera — do not change any design detail.';
  return [
    ['Back view', `${base} The figurine is turned 180 degrees so we see its BACK.`],
    ['Side (facing left)', `${base} The figurine is turned 90 degrees so it faces LEFT; we see its side profile.`],
    ['Side (facing right)', `${base} The figurine is turned 90 degrees so it faces RIGHT; we see its side profile.`],
  ];
}
export const MESHY_SETTINGS = `generate_3d → model: multi_image_to_3d (Meshy)
images: front, back, side-left, side-right
should_texture: true · enable_pbr: true
target_polycount: 150000 · topology: triangle   (≈30 credits)

Blender: join → scale to target height incl. plinth → centre on plinth
→ voxel remesh copy at 0.25 mm (100 mm figure) → keep largest island
→ export STL (mm) for print, OBJ + textures for full-colour services.
Gotcha: glTF imports use quaternions — set rotation_mode = 'XYZ' before rotating.`;
