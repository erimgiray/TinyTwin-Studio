// Part kit: the design system, the 3D base + swappable parts, live preview, adding parts, print export.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { renderStandards, defaultStandards, MODES } from './standards.js';
import { STYLES, state, esc, $, $$, toast, api, modal, pickFiles, unitCost, money, uid } from './core.js';

export const CATEGORIES = [
  ['hair', 'Hair'], ['headwear', 'Headwear'], ['glasses', 'Glasses'], ['facialHair', 'Facial hair'], ['outfit', 'Outfit'],
  ['eyes', 'Eyes'], ['brows', 'Brows'], ['mouth', 'Mouth'], ['arms', 'Arms'],
];
const catLabel = (k) => (CATEGORIES.find((c) => c[0] === k) || [k, k])[1];
const PRINT = { Pop: 2, Classic: 1.2, Collector: 0.8 };
export const PRINTERS = {
  Pop: { label: 'Multi-colour filament', short: 'Filament', thin: 2, colours: 'About 4 solid colours per print (more with add-ons)', supports: 'Overhangs (chin, arms, buns) need supports, which leave marks', cost: 'Lowest cost per figure' },
  Classic: { label: 'Full-colour print service', short: 'Full colour', thin: 1.2, colours: 'Full colour — any pattern or texture', supports: 'No supports needed', cost: 'Highest cost per figure, posted to you' },
  Collector: { label: 'Resin printer', short: 'Resin', thin: 0.8, colours: 'One colour — needs painting', supports: 'Needs supports', cost: 'Low cost per figure' },
};
export const VIEW_RULES = [
  'Draw every part ON the blank base (standard face, full figure) — never floating on its own.',
  'Change only the part: same body, face, skin, plinth, background, light and camera.',
  'Views: front first, then back, left and right (Image → 3D takes 2–4 views). A top view is a useful check for hair and hats.',
  'Straight-on camera at chest height, same distance and framing in every view, 3:4 frame, plain light-grey background, soft even light.',
  'Design for printing: chunky, smooth, solid shapes; no thin strands, nothing floating, firmly touching the head or body.',
];

let kit = null; // kit.json
let tab = 'kit';
let sel = {}; // category -> part id
let showBoxes = false, xray = false, style = 'Pop', bodyId = 'base';
let pending = null; // freshly processed part awaiting save

// ---------- worker ----------
let worker, wid = 0;
const waiting = new Map();
function work(op, data, onProgress, transfer = []) {
  worker ||= new Worker('dist/worker.js');
  const failAll = (msg) => { for (const [id, w] of waiting) { waiting.delete(id); w.rej(new Error(msg)); } worker?.terminate(); worker = null; };
  worker.onerror = (e) => failAll('The 3D processor crashed: ' + (e.message || 'unknown error') + '. Try again, or use a larger voxel size in Design system settings.');
  worker.onmessageerror = () => failAll('The 3D processor sent back unreadable data.');
  worker.onmessage = (e) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    if (e.data.type === 'progress') w.onProgress?.(e.data.msg);
    else { waiting.delete(e.data.id); e.data.type === 'done' ? w.res(e.data.result) : w.rej(new Error(e.data.error)); }
  };
  return new Promise((res, rej) => { const id = ++wid; waiting.set(id, { res, rej, onProgress }); worker.postMessage({ id, op, data }, transfer); });
}

// ---------- three.js scene ----------
let ctx = null;
function ensureCtx() {
  if (ctx) return ctx;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 5000);
  camera.position.set(140, 110, 230);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9cfe6, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(150, 260, 200); scene.add(key);
  const rim = new THREE.DirectionalLight(0xe8dcff, 1.0); rim.position.set(-200, 150, -150); scene.add(rim);
  const grid = new THREE.GridHelper(200, 20, 0xb9aecb, 0xe2dbe9); scene.add(grid);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 50, 0); controls.enableDamping = true;
  const root = new THREE.Group(); scene.add(root);
  const boxes = new THREE.Group(); scene.add(boxes);
  ctx = { renderer, scene, camera, controls, root, boxes, cache: new Map() };
  const loop = () => { requestAnimationFrame(loop); if (!renderer.domElement.isConnected) return; controls.update(); renderer.render(scene, camera); };
  loop();
  new ResizeObserver(resize).observe(document.body);
  return ctx;
}
function resize() {
  const el = ctx?.renderer.domElement.parentElement;
  if (!el || !el.clientWidth) return;
  ctx.renderer.setSize(el.clientWidth, el.clientHeight, false);
  ctx.camera.aspect = el.clientWidth / el.clientHeight;
  ctx.camera.updateProjectionMatrix();
}
const matFor = (opts = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, transparent: !!opts.opacity, opacity: opts.opacity ?? 1, depthWrite: !opts.opacity });

function geomFromMesh(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  if (m.col) g.setAttribute('color', new THREE.BufferAttribute(m.col, 3, true));
  g.computeVertexNormals();
  return g;
}
async function loadGLB(url) {
  if (ctx.cache.has(url)) return ctx.cache.get(url);
  const gltf = await new GLTFLoader().loadAsync(url);
  let geom = null;
  gltf.scene.traverse((o) => { if (o.isMesh && !geom) geom = o.geometry; });
  ctx.cache.set(url, geom);
  return geom;
}
function meshFromGeometry(geom) {
  const pos = Float32Array.from(geom.attributes.position.array);
  const idx = geom.index ? Uint32Array.from(geom.index.array) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
  let col;
  const c = geom.attributes.color;
  if (c) { col = new Uint8Array(c.count * 3); for (let i = 0; i < c.count; i++) { col[i * 3] = c.getX(i) * 255; col[i * 3 + 1] = c.getY(i) * 255; col[i * 3 + 2] = c.getZ(i) * 255; } }
  return { pos, idx, col };
}

// Any loaded model → one flat mesh with per-vertex colours sampled from its textures.
function sampleTexture(tex) {
  const img = tex?.image;
  if (!img || !img.width) return null;
  const s = Math.min(1, 1024 / Math.max(img.width, img.height));
  const cv = document.createElement('canvas'); cv.width = Math.max(1, img.width * s | 0); cv.height = Math.max(1, img.height * s | 0);
  const c2 = cv.getContext('2d'); c2.drawImage(img, 0, 0, cv.width, cv.height);
  const d = c2.getImageData(0, 0, cv.width, cv.height).data;
  return (u, v) => {
    u = u - Math.floor(u); v = v - Math.floor(v);
    const x = Math.min(cv.width - 1, u * cv.width | 0), y = Math.min(cv.height - 1, (tex.flipY ? 1 - v : v) * cv.height | 0);
    const k = (y * cv.width + x) * 4; return [d[k], d[k + 1], d[k + 2]];
  };
}
function objectToMesh(obj) {
  obj.updateMatrixWorld(true);
  const P = [], I = [], C = [];
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const pos = g.attributes.position, uv = g.attributes.uv, vc = g.attributes.color;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const samp = uv && mat?.map ? sampleTexture(mat.map) : null;
    const base = mat?.color ? [mat.color.r * 255, mat.color.g * 255, mat.color.b * 255] : [200, 180, 160];
    const off = P.length / 3;
    for (let i = 0; i < pos.count; i++) {
      P.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (vc) C.push(vc.getX(i) * 255, vc.getY(i) * 255, vc.getZ(i) * 255);
      else if (samp) C.push(...samp(uv.getX(i), uv.getY(i)));
      else C.push(...base);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) I.push(g.index.getX(i) + off);
    else for (let i = 0; i < pos.count; i++) I.push(i + off);
  });
  if (!P.length) throw new Error('No mesh found in that file.');
  return { pos: new Float32Array(P), idx: new Uint32Array(I), col: Uint8Array.from(C, (x) => Math.max(0, Math.min(255, Math.round(x)))) };
}
async function loadAnyModel(src) {
  // src: File or URL (remote URLs go through the local proxy)
  const name = src instanceof File ? src.name : src.split('?')[0];
  const ext = name.split('.').pop().toLowerCase();
  const url = src instanceof File ? URL.createObjectURL(src) : src.startsWith('/') ? src : '/api/fetch?url=' + encodeURIComponent(src);
  if (ext === 'stl') { const g = await new STLLoader().loadAsync(url); const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial()); m.rotation.x = -Math.PI / 2; return objectToMesh(m); }
  if (ext === 'obj') return objectToMesh(await new OBJLoader().loadAsync(url));
  return objectToMesh((await new GLTFLoader().loadAsync(url)).scene);
}
async function meshToGLB(m) {
  const mesh = new THREE.Mesh(geomFromMesh(m), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62 }));
  return new GLTFExporter().parseAsync(mesh, { binary: true });
}
async function saveFile(name, buf) {
  return api('/api/kit/file?name=' + encodeURIComponent(name), { method: 'POST', body: buf });
}
const saveKit = () => api('/api/kit', { method: 'PUT', body: JSON.stringify(kit, null, 1), headers: { 'Content-Type': 'application/json' } });

const bodies = () => [{ id: 'base', name: kit.base.name || 'Standard', file: kit.base.file, volumeMm3: kit.base.volumeMm3 }, ...(kit.bodies || [])];
const curBody = () => bodies().find((b) => b.id === bodyId) || bodies()[0];
const perBody = (p) => p.category === 'outfit' || p.mode === 'replace';
const partFits = (p) => !perBody(p) || (p.body || 'base') === curBody().id;
const stdList = () => (kit.designSystem.standards ||= defaultStandards(kit.designSystem.measurements));
const stdFor = (p) => stdList().find((x) => x.id === p.standard) || stdList().find((x) => x.category === p.category);
const replacePart = () => kit.parts.find((p) => p.mode === 'replace' && sel[p.category] === p.id && partFits(p));
const bodyFile = () => replacePart()?.file || curBody().file;

// Paint parts are flat images projected onto the front of the figure inside their zone.
const texCache = new Map();
async function addDecal(target, zone, url) {
  let tex = texCache.get(url);
  if (!tex) { tex = await new THREE.TextureLoader().loadAsync(url); tex.colorSpace = THREE.SRGBColorSpace; texCache.set(url, tex); }
  const [cx, cy, front] = zone.center, [w, h] = zone.size, depth = zone.depth || 16;
  const geo = new DecalGeometry(target, new THREE.Vector3(cx, cy, front - depth / 2 + 3), new THREE.Euler(0, 0, 0), new THREE.Vector3(w, h, depth));
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.45 });
  return new THREE.Mesh(geo, mat);
}

// ---------- scene content ----------
async function refreshScene() {
  const c = ensureCtx();
  c.root.clear(); c.boxes.clear();
  if (!kit?.base) return;
  const showPendingBody = pending?.mode === 'replace';
  const bodyMesh = showPendingBody
    ? new THREE.Mesh(geomFromMesh(pending.mesh), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: 0x6b4a00, emissiveIntensity: 0.25 }))
    : new THREE.Mesh(await loadGLB('/data/kit/' + bodyFile()), matFor(xray ? { opacity: 0.35 } : {}));
  c.root.add(bodyMesh);
  bodyMesh.updateMatrixWorld(true);
  for (const [cat, pid] of Object.entries(sel)) {
    const p = kit.parts.find((x) => x.id === pid);
    if (!p || !partFits(p) || p.mode === 'replace') continue;
    if (p.mode === 'paint') { if (pending?.mode === 'paint' && pending.cat === p.category) continue; c.root.add(await addDecal(bodyMesh, p.zone, '/data/kit/' + p.file)); continue; }
    c.root.add(new THREE.Mesh(await loadGLB('/data/kit/' + p.file), matFor()));
  }
  if (pending?.mode === 'paint') c.root.add(await addDecal(bodyMesh, pending.zone, pending.dataUrl));
  if (pending && !pending.mode) c.root.add(new THREE.Mesh(geomFromMesh(pending.mesh), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: 0x6b4a00, emissiveIntensity: 0.35 })));
  if (showBoxes && kit.designSystem?.anchors) {
    const colors = { hair: 0x7a5bd6, headwear: 0xd4a845, glasses: 0x2f8f8a, facialHair: 0xc2413b, outfit: 0x3d6fb6 };
    for (const [k, b] of Object.entries(kit.designSystem.anchors)) {
      const box = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
      c.boxes.add(new THREE.Box3Helper(box, colors[k] || 0x888888));
    }
  }
}

// ---------- page ----------
export async function renderKit(main) {
  kit = await api('/api/kit').catch(() => null);
  if (kit && !renderKit.styleSet) { style = kit.designSystem.printer || 'Pop'; renderKit.styleSet = true; }
  if (kit) { kit.bodies ||= []; if (!bodies().some((b) => b.id === bodyId)) bodyId = 'base'; for (const [c] of CATEGORIES) if (sel[c] && !kit.parts.some((p) => p.id === sel[c] && partFits(p))) delete sel[c]; }
  main.innerHTML = `
  <div class="page-head"><div><h1>Part kit</h1><p>The design system and the 3D parts built from it — swap parts live and export a print file.</p></div><div class="sp"></div>
    <div class="seg"><button data-tab="kit" class="${tab === 'kit' ? 'on' : ''}">3D kit</button><button data-tab="std" class="${tab === 'std' ? 'on' : ''}">Part standards</button><button data-tab="ds" class="${tab === 'ds' ? 'on' : ''}">Design system</button></div></div>
  <div id="kBusy"></div><div id="kBody"></div>`;
  $$('[data-tab]', main).forEach((b) => (b.onclick = () => { tab = b.dataset.tab; renderKit(main); }));
  const body = $('#kBody', main);
  if (!kit) return renderEmpty(body, main);
  if (tab === 'ds') return renderDS(body, main);
  if (tab === 'std') return renderStandards(body, kit, saveKit);
  renderKit3D(body, main);
}

function busy(main, msg) { $('#kBusy', main).innerHTML = msg ? `<div class="banner plum" style="margin-bottom:14px"><span class="spin"></span><span id="kMsg">${esc(msg)}</span></div>` : ''; }
const progress = (main) => (m) => { const e = $('#kMsg', main); if (e) e.textContent = m; };

function renderEmpty(body, main) {
  body.innerHTML = `<div class="card empty"><div class="big">◈</div><h3>No part kit yet</h3>
    <p style="max-width:600px;margin:0 auto 14px">A kit is one 3D base figure (which sets the design system’s measurements) plus 3D parts that snap onto it.
    Start from a 3D model of the blank base figure, or import a kit zip you exported earlier.</p>
    <div class="row" style="justify-content:center">
    <button class="btn primary" id="kNewBase">Create from a base model…</button><button class="btn" id="kZip">Import kit zip…</button></div></div>`;
  $('#kZip', body).onclick = () => importDialog(main);
  $('#kNewBase', body).onclick = () => baseDialog(main);
}
function importDialog(main) {
  modal(`<div style="width:min(520px,90vw)"><div class="row" style="margin-bottom:10px"><h3 style="margin:0">Import a kit</h3><span class="grow"></span><button class="btn sm" data-close>Close</button></div>
    <p class="small muted" style="margin-top:0">A kit zip exported from TinyTwin Studio, as a file or a download link. It replaces the current kit.</p>
    <div class="row"><input class="in grow" id="iUrl" placeholder="Paste a .zip link"><span class="small muted">or</span><button class="btn" id="iFile">Choose file…</button></div>
    <button class="btn primary" id="iGo" style="margin-top:12px">Import</button></div>`, (box, close) => {
    $('#iFile', box).onclick = async () => { const [f] = await pickFiles('.zip', false); if (!f) return; close(); importKit(main, () => { const fd = new FormData(); fd.append('file', f); return api('/api/kit/import', { method: 'POST', body: fd }); }, 'Importing kit…'); };
    $('#iGo', box).onclick = () => { const u = $('#iUrl', box).value.trim(); if (!u) return toast('Paste a link or choose a file', true); close(); importKit(main, () => api('/api/kit/import?url=' + encodeURIComponent(u), { method: 'POST' }), 'Downloading kit…'); };
  });
}
async function importKit(main, fn, msg) {
  busy(main, msg);
  try { await fn(); ctx?.cache.clear(); texCache.clear(); sel = {}; toast('Part kit ready'); renderKit(main); }
  catch (e) { busy(main); toast(e.message, true); }
}

function renderKit3D(body, main) {
  const ds = kit.designSystem;
  const byCat = Object.fromEntries(CATEGORIES.map(([c]) => [c, kit.parts.filter((p) => p.category === c && partFits(p))]));
  const selParts = Object.values(sel).map((id) => kit.parts.find((p) => p.id === id)).filter((p) => p && partFits(p) && p.mode !== 'paint' && p.mode !== 'replace');
  const rp = replacePart();
  const vol = ((rp ? rp.stats.volumeMm3 : curBody().volumeMm3) || 0) + selParts.reduce((a, p) => a + (p.stats?.volumeMm3 || 0), 0);
  const thin = PRINT[style];
  const warn = selParts.filter((p) => (p.stats?.thinByStyle?.[style] ?? p.stats?.thinShare ?? 0) > 0.15);
  body.innerHTML = `<div class="viewer">
    <div class="stage3d" id="kStage"><div class="hud">
      <button class="btn sm ${showBoxes ? 'primary' : ''}" id="kBoxes">Anchor boxes</button>
      <button class="btn sm ${xray ? 'primary' : ''}" id="kXray">X-ray base</button>
      <button class="btn sm" id="kShot">📷 Snapshot</button></div></div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="card"><h3>Build a figure</h3>
        <label class="f" style="margin-bottom:8px">Body type<select class="in" id="kBodySel">${bodies().map((b) => `<option value="${b.id}" ${b.id === curBody().id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
        ${CATEGORIES.filter(([c]) => byCat[c].length).map(([c, l]) => `<label class="f" style="margin-bottom:8px">${l}<select class="in" data-cat="${c}"><option value="">None</option>${byCat[c].map((p) => `<option value="${p.id}" ${sel[c] === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>`).join('') || '<p class="muted small">No parts yet — add one below.</p>'}
        <div class="row" style="margin-top:6px"><span class="small muted">Printer</span><div class="seg">${Object.keys(PRINT).map((s) => `<button data-style="${s}" class="${s === style ? 'on' : ''}" title="${PRINTERS[s].label}">${PRINTERS[s].short}</button>`).join('')}</div></div>
        <div class="stat" style="margin-top:8px"><span>Solid volume (100 mm)</span><b>${(vol / 1000).toFixed(1)} cm³</b></div>
        ${warn.length ? `<p class="small" style="color:var(--warn);margin:6px 0 0">⚠ ${warn.map((p) => esc(p.name)).join(', ')} ha${warn.length > 1 ? 've' : 's'} areas thinner than ${thin} mm (${PRINTERS[style].label}).</p>` : ''}
        <button class="btn primary" id="kExport" style="margin-top:10px;width:100%">Export print STL</button>
        <div class="tiny" style="margin-top:6px">One watertight body in mm, Z up — ready for the slicer.</div></div>
      <div class="card"><div class="row"><h3 style="margin:0">Parts</h3><span class="grow"></span><button class="btn sm primary" id="kAdd">+ Add part</button></div>
        ${kit.parts.length ? `<table class="t" style="margin-top:8px">${kit.parts.map((p) => `<tr><td><b class="small">${esc(p.name)}</b><div class="tiny">${esc(catLabel(p.category))}${p.mode === 'paint' ? ` · paint · ${p.stats.colours} colour${p.stats.colours === 1 ? '' : 's'}${p.stats.colourLimit && p.stats.colours > p.stats.colourLimit ? ' · <span style="color:var(--warn)">over colour limit</span>' : ''}` : p.mode === 'replace' ? ` · ${esc((bodies().find((b) => b.id === (p.body || 'base')) || {}).name || '')} body${p.stats.overhangMm2 >= 20 ? ' · needs supports' : ''}` : ` · ${(p.stats.volumeMm3 / 1000).toFixed(2)} cm³`}${p.stats.thinShare > 0.15 ? ' · <span style="color:var(--warn)">thin areas</span>' : ''}</div></td><td style="text-align:right"><button class="btn sm ghost danger" data-del="${p.id}">✕</button></td></tr>`).join('')}</table>` : '<p class="muted small">None yet.</p>'}
      </div>
      <div class="card"><div class="row"><h3 style="margin:0">Body types</h3><span class="grow"></span><button class="btn sm" id="kAddBody">+ Add body type</button></div>
        <table class="t" style="margin-top:8px">${bodies().map((b) => `<tr><td><b class="small">${esc(b.name)}</b><div class="tiny">${b.id === 'base' ? 'master head + plinth' : 'body only · head + plinth from master'}${b.volumeMm3 ? ' · ' + (b.volumeMm3 / 1000).toFixed(1) + ' cm³' : ''}</div></td><td style="text-align:right">${b.id === 'base' ? '' : `<button class="btn sm ghost danger" data-delbody="${b.id}">✕</button>`}</td></tr>`).join('')}</table></div>
      <div class="card"><h3>Kit</h3><div class="small muted">Master: ${esc(kit.base.name || 'Base figure')} · ${ds.measurements.height} mm · plinth ⌀${ds.measurements.plinth.diameter} mm</div>
        <div class="row" style="margin-top:10px"><a class="btn sm" href="/api/kit/zip" download>Export kit zip</a><button class="btn sm" id="kImp">Import kit…</button><button class="btn sm" id="kOpen">Open folder</button><button class="btn sm ghost danger" id="kReset">Start over…</button></div></div>
    </div></div>`;
  const stage = $('#kStage', body);
  ensureCtx(); stage.prepend(ctx.renderer.domElement); resize();
  refreshScene().catch((e) => toast('Could not load the kit models: ' + e.message, true));
  $$('[data-cat]', body).forEach((s) => (s.onchange = () => { if (s.value) sel[s.dataset.cat] = s.value; else delete sel[s.dataset.cat]; renderKit3D(body, main); }));
  $('#kBodySel', body).onchange = (e) => { bodyId = e.target.value; renderKit(main); };
  $('#kAddBody', body).onclick = () => bodyDialog(main);
  $$('[data-delbody]', body).forEach((b) => (b.onclick = async () => {
    const bd = kit.bodies.find((x) => x.id === b.dataset.delbody);
    if (!confirm(`Delete the body type “${bd.name}” and its outfits?`)) return;
    kit.bodies = kit.bodies.filter((x) => x !== bd); kit.parts = kit.parts.filter((p) => p.body !== bd.id); await saveKit(); renderKit(main);
  }));
  $$('[data-style]', body).forEach((b) => (b.onclick = () => { style = b.dataset.style; renderKit3D(body, main); }));
  $('#kBoxes', body).onclick = () => { showBoxes = !showBoxes; renderKit3D(body, main); };
  $('#kXray', body).onclick = () => { xray = !xray; renderKit3D(body, main); };
  $('#kShot', body).onclick = () => { const a = document.createElement('a'); a.href = ctx.renderer.domElement.toDataURL('image/png'); a.download = 'tinytwin-kit.png'; a.click(); };
  $('#kOpen', body).onclick = () => api('/api/open?path=kit', { method: 'POST' });
  $('#kReset', body).onclick = async () => { if (!confirm('Remove the whole part kit (base, parts, design system)? Export a kit zip first if you want to keep it.')) return; await api('/api/kit/reset', { method: 'POST' }); ctx.cache.clear(); sel = {}; renderKit(main); };
  $$('[data-del]', body).forEach((b) => (b.onclick = async () => {
    const p = kit.parts.find((x) => x.id === b.dataset.del);
    if (!confirm(`Delete the part “${p.name}”?`)) return;
    kit.parts = kit.parts.filter((x) => x !== p); await saveKit();
    api('/api/kit/file?name=' + encodeURIComponent(p.file), { method: 'DELETE' }).catch(() => {});
    renderKit(main);
  }));
  $('#kAdd', body).onclick = () => partDialog(main);
  $('#kImp', body).onclick = () => { if (confirm('Importing replaces the current kit. Export it first if you want to keep it. Continue?')) importDialog(main); };
  $('#kExport', body).onclick = async () => {
    busy(main, 'Merging…');
    try {
      const meshes = [meshFromGeometry(await loadGLB('/data/kit/' + bodyFile()))];
      for (const p of selParts) meshes.push(meshFromGeometry(await loadGLB('/data/kit/' + p.file)));
      const r = await work('union', { meshes }, progress(main), meshes.flatMap((m) => [m.pos.buffer, m.idx.buffer]));
      busy(main);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.stl], { type: 'model/stl' }));
      a.download = ['tinytwin', curBody().name.toLowerCase().replace(/\W+/g, '-'), ...(rp ? [rp.name.toLowerCase().replace(/\W+/g, '-')] : []), ...selParts.map((p) => p.name.toLowerCase().replace(/\W+/g, '-'))].join('-') + '.stl';
      a.click();
      toast(`Print file ready: ${(r.volumeMm3 / 1000).toFixed(1)} cm³, ${r.triangles.toLocaleString()} triangles`);
      if (r.pieces > 1) toast(`Check the print file: it has ${r.pieces} separate pieces, so something isn’t joined to the body.`, true);
    } catch (e) { busy(main); toast(e.message, true); }
  };
}

// ---------- dialogs ----------
function sourcePicker(id) {
  return `<div class="row"><input class="in grow" id="${id}Url" placeholder="Paste a .glb link (e.g. a Higgsfield 3D result)"><span class="small muted">or</span><button class="btn" id="${id}File">Choose file…</button></div><div class="tiny" id="${id}Picked" style="margin-top:4px"></div>`;
}
function wireSource(box, id) {
  let file = null;
  $('#' + id + 'File', box).onclick = async () => { const [f] = await pickFiles('.glb,.gltf,.obj,.stl', false); if (f) { file = f; $('#' + id + 'Picked', box).textContent = 'Selected: ' + f.name; $('#' + id + 'Url', box).value = ''; } };
  return () => file || $('#' + id + 'Url', box).value.trim() || null;
}

function baseDialog(main) {
  modal(`<div style="width:min(560px,90vw)"><div class="row" style="margin-bottom:10px"><h3 style="margin:0">Create the kit from a base model</h3><span class="grow"></span><button class="btn sm" data-close>Close</button></div>
    <p class="small muted" style="margin-top:0">Use a 3D model of the blank base figure (standard face, full figure, on its plinth). It is scaled to 100 mm, measured, and becomes the design system every part snaps to.</p>
    ${sourcePicker('b')}
    <div class="fgrid" style="margin-top:10px"><label class="f">Name<input class="in" id="bName" value="Standard figure"></label>
    <label class="f">Model faces<select class="in" id="bYaw"><option value="0">Front (as generated)</option><option value="1">Rotate 90°</option><option value="2">Rotate 180°</option><option value="3">Rotate 270°</option></select></label></div>
    <button class="btn primary" id="bGo" style="margin-top:12px">Create kit</button></div>`, (box, close) => {
    const get = wireSource(box, 'b');
    $('#bGo', box).onclick = async () => {
      const src = get(); if (!src) return toast('Choose a model file or paste a link', true);
      const name = $('#bName', box).value.trim() || 'Base'; const yaw = +$('#bYaw', box).value;
      close(); busy(main, 'Loading model…');
      try {
        const mesh = await loadAnyModel(src);
        const r = await work('base', { mesh, yaw }, progress(main), [mesh.pos.buffer, mesh.idx.buffer, mesh.col.buffer]);
        busy(main, 'Saving…');
        await saveFile('base.glb', await meshToGLB(r.mesh));
        kit = {
          version: 1, created: new Date().toISOString(),
          designSystem: { measurements: r.measurements, anchors: r.anchors, settings: { pitch: 0.3, gapMm: 0.6, fuseMm: 1 }, print: PRINT, printer: 'Pop', views: VIEW_RULES },
          base: { file: 'base.glb', name, source: typeof src === 'string' ? src : src.name, volumeMm3: Math.round(r.volumeMm3) },
          parts: [],
        };
        await saveKit();
        ctx?.cache.clear(); busy(main); toast('Kit created — measurements saved to the design system'); renderKit(main);
      } catch (e) { busy(main); toast(e.message, true); }
    };
  });
}

function bodyDialog(main) {
  const ds = kit.designSystem;
  modal(`<div style="width:min(560px,90vw)"><div class="row" style="margin-bottom:10px"><h3 style="margin:0">Add a body type</h3><span class="grow"></span><button class="btn sm" data-close>Close</button></div>
    <p class="small muted" style="margin-top:0">Use a 3D model of the figure with the new build (e.g. Slim or Broad) in the grey base layer. Only its body between the plinth and the neck is used — the master head and plinth are kept, so every head part fits.</p>
    ${sourcePicker('y')}
    <div class="fgrid" style="margin-top:10px"><label class="f">Name<input class="in" id="yNm" placeholder="e.g. Slim"></label>
    <label class="f">Model faces<select class="in" id="yYaw"><option value="0">Front (as generated)</option><option value="1">Rotate 90°</option><option value="2">Rotate 180°</option><option value="3">Rotate 270°</option></select></label></div>
    <button class="btn primary" id="yGo" style="margin-top:12px">Create body type</button></div>`, (box, close) => {
    const get = wireSource(box, 'y');
    $('#yGo', box).onclick = async () => {
      const src = get(); if (!src) return toast('Choose a model file or paste a link', true);
      const name = $('#yNm', box).value.trim() || 'Body type ' + ((kit.bodies?.length || 0) + 1), yaw = +$('#yYaw', box).value;
      close(); busy(main, 'Loading model…');
      try {
        const mesh = await loadAnyModel(src);
        const master = meshFromGeometry(await loadGLB('/data/kit/' + kit.base.file));
        const r = await work('body', { mesh, master, yaw, measurements: ds.measurements, pitch: ds.settings.pitch }, progress(main), [mesh.pos.buffer, mesh.idx.buffer, mesh.col.buffer]);
        busy(main, 'Saving…');
        const id = uid(), file = `bodies/${id}.glb`;
        await saveFile(file, await meshToGLB(r.mesh));
        kit.bodies ||= []; kit.bodies.push({ id, name, file, volumeMm3: Math.round(r.volumeMm3), stretch: r.stretch, source: typeof src === 'string' ? src : src.name });
        await saveKit(); bodyId = id; busy(main); toast(`Body type “${name}” added`); renderKit(main);
      } catch (e) { busy(main); toast(e.message, true); }
    };
  });
}

function partDialog(main, stdId) {
  const ds = kit.designSystem, list = stdList();
  const std = list.find((x) => x.id === stdId) || list.find((x) => x.mode === 'add') || list[0];
  const mode = std.mode;
  const hasTemplate = !!std.recipe?.templateFile;
  const help = {
    add: 'Use a 3D model of the base figure <b>wearing</b> the part. It’s lined up by the plinth and head, the base is cut away, and what’s left inside the zone becomes the part — fused 1 mm into the body.',
    replace: `Use a 3D model of the <b>${esc(curBody().name)}</b> body in the new pose. The old arm is cut off at the shoulder and the new one fused on. Made separately for each body type.`,
    paint: 'Use the 2D design image made from this standard’s template crop. Everything that matches the template is made see-through, and the rest is painted onto the figure inside the zone.',
  }[mode];
  modal(`<div style="width:min(620px,90vw)"><div class="row" style="margin-bottom:10px"><h3 style="margin:0">Add a part version</h3><span class="grow"></span><button class="btn sm" data-close>Close</button></div>
    <div class="fgrid"><label class="f">Standard<select class="in" id="pStd">${list.map((x) => `<option value="${x.id}" ${x.id === std.id ? 'selected' : ''}>${esc(x.name)} — ${MODES[x.mode].label}</option>`).join('')}</select></label>
      <label class="f">Version name<input class="in" id="pName" placeholder="e.g. ${mode === 'paint' ? 'Happy' : mode === 'replace' ? 'Wave' : 'Round glasses'}"></label></div>
    <p class="small muted">${help}</p>
    ${mode === 'paint' ? `<label class="f">Design image (PNG/JPG)</label>${sourcePicker('p').replace('Paste a .glb link (e.g. a Higgsfield 3D result)', 'Paste an image link')}
      <label class="f" style="margin-top:10px">Template image ${hasTemplate ? '<span class="chip ok">saved</span> — only needed to replace it' : '<span class="chip warn">needed once</span>'}</label>${sourcePicker('t').replace('Paste a .glb link (e.g. a Higgsfield 3D result)', 'Paste the template image link')}`
      : `${sourcePicker('p')}<div class="fgrid" style="margin-top:10px">
      <label class="f">Check thickness for<select class="in" id="pStyle">${Object.keys(PRINT).map((x) => `<option value="${x}" ${x === style ? 'selected' : ''}>${PRINTERS[x].label} (${PRINT[x]} mm)</option>`).join('')}</select></label>
      <label class="f">Model faces<select class="in" id="pYaw"><option value="0">Front (as generated)</option><option value="1">Rotate 90°</option><option value="2">Rotate 180°</option><option value="3">Rotate 270°</option></select></label></div>`}
    <button class="btn primary" id="pGo" style="margin-top:12px">Process</button></div>`, (box, close) => {
    $('#pStd', box).onchange = (e) => { close(); partDialog(main, e.target.value); };
    const get = wireSource(box, 'p'), getT = mode === 'paint' ? wireSource(box, 't') : null;
    if (mode === 'paint') { $('#pFile', box).onclick = async () => { const [f] = await pickFiles('image/*', false); if (f) { box._pf = f; $('#pPicked', box).textContent = 'Selected: ' + f.name; } }; $('#tFile', box).onclick = async () => { const [f] = await pickFiles('image/*', false); if (f) { box._tf = f; $('#tPicked', box).textContent = 'Selected: ' + f.name; } }; }
    $('#pGo', box).onclick = async () => {
      const name = $('#pName', box).value.trim() || std.name;
      if (mode === 'paint') {
        const src = box._pf || $('#pUrl', box).value.trim(), tsrc = box._tf || $('#tUrl', box).value.trim();
        if (!src) return toast('Choose the design image', true);
        if (!tsrc && !hasTemplate) return toast('This standard needs its template image once', true);
        close(); return processPaint(main, { std, src, tsrc, name });
      }
      const src = get(); if (!src) return toast('Choose a model file or paste a link', true);
      const st = $('#pStyle', box).value, yaw = +$('#pYaw', box).value;
      close();
      if (mode === 'replace') return processReplace(main, { std, src, name, st, yaw });
      return processPart(main, { src, cat: std.category, name, st, yaw, standard: std.id });
    };
  });
}

// ---- paint mode: key a 2D design against its template, project onto the figure ----
async function loadImage(src) {
  const url = src instanceof File ? URL.createObjectURL(src) : src.startsWith('/') || src.startsWith('blob:') || src.startsWith('data:') ? src : '/api/fetch?url=' + encodeURIComponent(src);
  const img = new Image(); img.crossOrigin = 'anonymous'; img.src = url; await img.decode(); return img;
}
function keyDesign(img, tpl, limit = 0) {
  const W = tpl.naturalWidth, Hh = tpl.naturalHeight;
  const cv = (im) => { const c = document.createElement('canvas'); c.width = W; c.height = Hh; c.getContext('2d').drawImage(im, 0, 0, W, Hh); return c; };
  const cd = cv(img), ct = cv(tpl);
  const d = cd.getContext('2d').getImageData(0, 0, W, Hh), t = ct.getContext('2d').getImageData(0, 0, W, Hh).data;
  const A = new Float32Array(W * Hh);
  for (let i = 0; i < W * Hh; i++) { const k = i * 4, diff = Math.hypot(d.data[k] - t[k], d.data[k + 1] - t[k + 1], d.data[k + 2] - t[k + 2]); A[i] = Math.min(1, Math.max(0, (diff - 16) / 26)); }
  // close small holes, then soften the edge
  const r = Math.max(2, Math.round(W / 220));
  const pass = (src, fn) => { const o = new Float32Array(src.length); for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { let v = fn === 'max' ? 0 : 1; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= Hh) continue; const s = src[yy * W + xx]; v = fn === 'max' ? Math.max(v, s) : Math.min(v, s); } o[y * W + x] = v; } return o; };
  let a = pass(pass(A, 'max'), 'min');
  const feather = Math.max(1, Math.round(W / 300));
  for (let it = 0; it < feather; it++) { const o = new Float32Array(a.length); for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= Hh) continue; s += a[yy * W + xx]; n++; } o[y * W + x] = s / n; } a = o; }
  // edge fade so nothing paints right up to the zone border
  const m = Math.round(W * 0.03);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { const e = Math.min(x, y, W - 1 - x, Hh - 1 - y); if (e < m) a[y * W + x] *= e / m; }
  let on = 0; const samples = [];
  for (let i = 0; i < W * Hh; i++) { d.data[i * 4 + 3] = Math.round(a[i] * 255); if (a[i] > 0.5) { on++; if (i % 7 === 0) samples.push([d.data[i * 4], d.data[i * 4 + 1], d.data[i * 4 + 2]]); } }
  const raw = countColours(samples);
  let colours = raw, palette = null;
  // flatten to the standard's colour limit so the preview matches what a filament printer can do
  if (limit > 0 && raw > limit && samples.length) {
    palette = kmeans(samples, limit);
    for (let i = 0; i < W * Hh; i++) {
      if (d.data[i * 4 + 3] < 8) continue;
      const k = i * 4; let b = palette[0], bd = Infinity;
      for (const c of palette) { const dd = (c[0] - d.data[k]) ** 2 + (c[1] - d.data[k + 1]) ** 2 + (c[2] - d.data[k + 2]) ** 2; if (dd < bd) { bd = dd; b = c; } }
      d.data[k] = b[0]; d.data[k + 1] = b[1]; d.data[k + 2] = b[2];
    }
    colours = palette.length;
  }
  cd.getContext('2d').putImageData(d, 0, 0);
  return { canvas: cd, coverage: on / (W * Hh), colours, rawColours: raw, palette: palette && palette.map((c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')) };
}
function kmeans(px, k) {
  // deterministic k-means++ style seeding (farthest point), 12 iterations, drops empty clusters
  let cent = [px[Math.floor(px.length / 2)].slice()];
  while (cent.length < k) {
    let far = null, fd = -1;
    for (let i = 0; i < px.length; i += 3) { const p = px[i]; let m = Infinity; for (const c of cent) m = Math.min(m, (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2); if (m > fd) { fd = m; far = p; } }
    if (!far || fd < 1) break; cent.push(far.slice());
  }
  for (let it = 0; it < 12; it++) {
    const acc = cent.map(() => [0, 0, 0, 0]);
    for (const p of px) { let b = 0, bd = Infinity; cent.forEach((c, j) => { const dd = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2; if (dd < bd) { bd = dd; b = j; } }); const a = acc[b]; a[0] += p[0]; a[1] += p[1]; a[2] += p[2]; a[3]++; }
    cent = acc.filter((a) => a[3]).map((a) => [a[0] / a[3], a[1] / a[3], a[2] / a[3]]);
  }
  return cent.map((c) => c.map((v) => Math.round(v)));
}
function countColours(px) {
  if (!px.length) return 0;
  // k-means (k=8), then merge clusters closer than 45 and ignore tiny ones (<3 %)
  let cent = Array.from({ length: 8 }, (_, i) => px[Math.floor(((i + 0.5) / 8) * px.length)].slice());
  const lab = new Int32Array(px.length);
  for (let it = 0; it < 10; it++) {
    const acc = cent.map(() => [0, 0, 0, 0]);
    px.forEach((p, i) => { let b = 0, bd = Infinity; cent.forEach((c, j) => { const dd = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2; if (dd < bd) { bd = dd; b = j; } }); lab[i] = b; acc[b][0] += p[0]; acc[b][1] += p[1]; acc[b][2] += p[2]; acc[b][3]++; });
    cent = acc.map((a, j) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3], a[3]] : [...cent[j].slice(0, 3), 0]));
  }
  const big = cent.filter((c) => c[3] / px.length >= 0.03);
  const groups = [];
  for (const c of big) { const g = groups.find((x) => Math.hypot(x[0] - c[0], x[1] - c[1], x[2] - c[2]) < 45); if (!g) groups.push(c); }
  return groups.length;
}
async function processPaint(main, { std, src, tsrc, name }) {
  busy(main, 'Loading images…');
  try {
    if (tsrc) {
      const tImg = await loadImage(tsrc instanceof File ? tsrc : tsrc);
      const c = document.createElement('canvas'); c.width = tImg.naturalWidth; c.height = tImg.naturalHeight; c.getContext('2d').drawImage(tImg, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const file = `standards/${std.id}-template.png`;
      await saveFile(file, blob); std.recipe.templateFile = file; await saveKit();
    }
    const [img, tpl] = await Promise.all([loadImage(src), loadImage('/data/kit/' + std.recipe.templateFile + '?v=' + Date.now())]);
    busy(main, 'Keying the design against the template…');
    await new Promise((r) => setTimeout(r, 30));
    const flat = (kit.designSystem?.printer || 'Pop') !== 'Classic';
    const k = keyDesign(img, tpl, flat ? (std.limits?.colours || 0) : 0);
    const blob = await new Promise((r) => k.canvas.toBlob(r, 'image/png'));
    busy(main);
    pending = { mode: 'paint', std: std.id, cat: std.category, name, blob, dataUrl: URL.createObjectURL(blob), zone: structuredClone(std.zone), stats: { colours: k.colours, rawColours: k.rawColours, palette: k.palette, coverage: +k.coverage.toFixed(3), colourLimit: std.limits?.colours }, src: typeof src === 'string' ? src : src.name };
    renderKit(main);
    setTimeout(() => reviewPending(main), 300);
  } catch (e) { busy(main); toast(e.message, true); }
}

// ---- replace mode: swap an arm on the current body type ----
async function processReplace(main, { std, src, name, st, yaw }) {
  const ds = kit.designSystem;
  busy(main, 'Loading model…');
  try {
    const mesh = await loadAnyModel(src);
    const body = meshFromGeometry(await loadGLB('/data/kit/' + curBody().file));
    const M = ds.measurements;
    const box = { min: [-300, -50, -300], max: [300, M.head.bottom - 3, 300] }; // fit heads only
    const r = await work('replace', { mesh, body, yaw, measurements: M, box, opts: { ...ds.settings, thinMm: std.limits?.minThicknessMm || PRINT[st] } }, progress(main), [mesh.pos.buffer, mesh.idx.buffer, mesh.col.buffer]);
    busy(main);
    pending = { mode: 'replace', std: std.id, cat: std.category, name, st, body: curBody().id, mesh: r.mesh, stats: { ...r.stats, side: r.side > 0 ? 'right (as you look at it)' : 'left (as you look at it)' }, src: typeof src === 'string' ? src : src.name };
    renderKit(main);
    setTimeout(() => reviewPending(main), 300);
  } catch (e) { busy(main); toast(e.message, true); }
}

export async function processPart(main, { src, cat, name, st, yaw, standard }) {
  const ds = kit.designSystem;
  busy(main, 'Loading model…');
  try {
    const mesh = await loadAnyModel(src);
    const base = meshFromGeometry(await loadGLB('/data/kit/' + (cat === 'outfit' ? curBody().file : kit.base.file)));
    const r = await work('part', { mesh, base, yaw, measurements: ds.measurements, plinthDiameter: ds.measurements.plinth.diameter, box: ds.anchors[cat] || ds.anchors.headwear, opts: { ...ds.settings, thinMm: PRINT[st] } }, progress(main), [mesh.pos.buffer, mesh.idx.buffer, mesh.col.buffer]);
    busy(main);
    pending = { ...r, cat, name, st, standard, body: cat === 'outfit' ? curBody().id : undefined, src: typeof src === 'string' ? src : src.name };
    sel = { ...sel }; delete sel[cat];
    renderKit(main);
    setTimeout(() => reviewPending(main), 300);
  } catch (e) { busy(main); toast(e.message, true); }
}

function reviewPending(main) {
  const p = pending;
  const s = p.stats;
  const ok = (good) => `color:${good ? 'var(--ok)' : 'var(--warn)'}`;
  const paintStats = p.mode === 'paint' ? `<div class="stat"><span>Colours used (limit ${s.colourLimit ?? '–'})</span><b style="${ok(!s.colourLimit || s.colours <= s.colourLimit)}">${s.colours}</b></div>${s.palette ? `<div class="stat"><span>Flattened from ${s.rawColours} shades for filament</span><b>${s.palette.map((c) => `<i style="display:inline-block;width:12px;height:12px;border-radius:3px;margin-left:3px;vertical-align:middle;background:${c};border:1px solid #0002"></i>`).join('')}</b></div>` : ''}
    <div class="stat"><span>Share of the zone painted</span><b>${Math.round(s.coverage * 100)}%</b></div>` : '';
  const replStats = p.mode === 'replace' ? `<div class="stat"><span>Arm swapped</span><b>${esc(s.side)}</b></div>
    <div class="stat"><span>New arm volume</span><b>${(s.armMm3 / 1000).toFixed(2)} cm³</b></div>
    <div class="stat"><span>Thinner than ${PRINT[p.st]} mm</span><b style="${ok(s.thinShare <= 0.15)}">${Math.round(s.thinShare * 100)}%</b></div>
    <div class="stat"><span>Overhang needing supports</span><b style="${ok(s.overhangMm2 < 20)}">${s.overhangMm2 < 20 ? 'none' : s.overhangMm2.toFixed(0) + ' mm²'}</b></div>
    <div class="stat"><span>Joined as one piece</span><b style="${ok(s.joined)}">${s.joined ? 'Yes' : 'No'}</b></div>
    ${s.fit ? `<div class="stat"><span>Head match</span><b style="${ok(s.fit.agreement >= 0.85)}">${Math.round(s.fit.agreement * 100)}%</b></div>` : ''}` : '';
  modal(`<div style="width:min(440px,90vw)"><h3 style="margin:0 0 6px">Keep “${esc(p.name)}”?</h3>
    <p class="small muted" style="margin-top:0">${p.mode === 'paint' ? 'It’s painted onto the figure in the 3D view behind this box.' : p.mode === 'replace' ? 'The figure behind this box shows the new arm (gold tint).' : 'It’s highlighted in gold on the base in the 3D view behind this box.'}</p>
    ${paintStats}${replStats}${p.mode ? '' : `<div class="stat"><span>Part volume</span><b>${(s.volumeMm3 / 1000).toFixed(2)} cm³</b></div>
    <div class="stat"><span>Thinner than ${PRINT[p.st]} mm (${PRINTERS[p.st].short})</span><b style="color:${s.thinShare > 0.15 ? 'var(--warn)' : 'var(--ok)'}">${Math.round(s.thinShare * 100)}%</b></div>
    <div class="stat"><span>Triangles</span><b>${(p.mesh.idx.length / 3).toLocaleString()}</b></div>
    ${s.rescuedMm3 ? `<div class="stat"><span>Recovered by colour</span><b>${(s.rescuedMm3 / 1000).toFixed(2)} cm³</b></div>` : ''}
    ${s.fit ? `<div class="stat"><span>Head fit (shift / scale)</span><b>${s.fit.shiftMm.map((v) => v.toFixed(1)).join(', ')} mm · ×${s.fit.scale}</b></div><div class="stat"><span>Head match</span><b style="color:${s.fit.agreement < 0.85 ? 'var(--warn)' : 'var(--ok)'}">${Math.round(s.fit.agreement * 100)}%</b></div>` : ''}
    `}<div class="row" style="margin-top:14px"><button class="btn" id="rView">Look at it first</button><span class="grow"></span><button class="btn danger" id="rNo">Discard</button><button class="btn primary" id="rYes">Save to kit</button></div></div>`, (box, close) => {
    $('#rView', box).onclick = () => { close(); const b = document.createElement('div'); b.className = 'banner'; b.style.marginBottom = '14px'; b.innerHTML = `<b>Reviewing “${esc(p.name)}” (gold).</b><span class="grow"></span><button class="btn sm danger" id="rNo2">Discard</button><button class="btn sm primary" id="rYes2">Save to kit</button>`; $('#kBusy', main).replaceChildren(b); $('#rNo2', b).onclick = discard; $('#rYes2', b).onclick = keep; };
    $('#rNo', box).onclick = () => { close(); discard(); };
    $('#rYes', box).onclick = () => { close(); keep(); };
  });
  async function discard() { pending = null; renderKit(main); }
  async function keep() {
    try {
      const id = uid();
      if (p.mode === 'paint') {
        const file = `paint/${p.cat}-${id}.png`;
        await saveFile(file, p.blob);
        kit.parts.push({ id, mode: 'paint', standard: p.std, category: p.cat, name: p.name, file, zone: p.zone, stats: p.stats, source: p.src, created: new Date().toISOString() });
        await saveKit(); sel[p.cat] = id; pending = null; toast('Part saved'); return renderKit(main);
      }
      if (p.mode === 'replace') {
        const file = `parts/${p.cat}-${id}.glb`;
        await saveFile(file, await meshToGLB(p.mesh));
        kit.parts.push({ id, mode: 'replace', standard: p.std, category: p.cat, name: p.name, file, body: p.body, stats: { ...p.stats, style: p.st }, source: p.src, created: new Date().toISOString() });
        await saveKit(); sel[p.cat] = id; pending = null; toast('Part saved'); return renderKit(main);
      }
      const file = `parts/${p.cat}-${id}.glb`;
      await saveFile(file, await meshToGLB(p.mesh));
      kit.parts.push({ id, standard: p.standard, category: p.cat, name: p.name, file, body: p.body, stats: { ...p.stats, style: p.st }, source: p.src, created: new Date().toISOString() });
      await saveKit();
      sel[p.cat] = id; pending = null; toast('Part saved'); renderKit(main);
    } catch (e) { toast(e.message, true); }
  }
}

// ---------- design system tab ----------
function renderDS(body, main) {
  const ds = kit.designSystem, M = ds.measurements, A = ds.anchors;
  // front (x/y) and side (z/y) diagrams, scaled to fit
  const W = 260, Hh = 330, sc = (Hh - 30) / Math.max(M.height, ...Object.values(A).map((b) => b.max[1]));
  const colors = { hair: '#7a5bd6', headwear: '#d4a845', glasses: '#2f8f8a', facialHair: '#c2413b', outfit: '#3d6fb6' };
  const diagram = (axis, title) => {
    const X = (v) => W / 2 + v * sc, Y = (v) => Hh - 15 - v * sc;
    const hw = (axis === 0 ? M.head.width : M.head.depth) / 2, hc = axis === 0 ? 0 : M.head.centerZ;
    return `<svg viewBox="0 0 ${W} ${Hh}" width="100%" style="max-width:${W}px">
      <rect x="${X(-M.plinth.diameter / 2)}" y="${Y(M.plinth.height)}" width="${M.plinth.diameter * sc}" height="${M.plinth.height * sc}" rx="3" fill="#5b2e8c" opacity=".85"/>
      <rect x="${X(-(axis === 0 ? M.shoulders.width : M.shoulders.depth) / 2)}" y="${Y(M.body.top)}" width="${(axis === 0 ? M.shoulders.width : M.shoulders.depth) * sc}" height="${(M.body.top - M.body.bottom) * sc}" rx="8" fill="#e3bc94"/>
      <ellipse cx="${X(hc)}" cy="${Y((M.head.bottom + M.head.top) / 2)}" rx="${hw * sc}" ry="${M.head.height / 2 * sc}" fill="#e8c4a0"/>
      <line x1="10" x2="${W - 10}" y1="${Y(M.head.eyeLine)}" y2="${Y(M.head.eyeLine)}" stroke="#5a3418" stroke-dasharray="3 3" stroke-width="1"/>
      ${Object.entries(A).map(([k, b]) => `<rect x="${X(b.min[axis === 0 ? 0 : 2])}" y="${Y(b.max[1])}" width="${(b.max[axis === 0 ? 0 : 2] - b.min[axis === 0 ? 0 : 2]) * sc}" height="${(b.max[1] - b.min[1]) * sc}" fill="none" stroke="${colors[k]}" stroke-width="1.5" stroke-dasharray="${k === 'hair' ? '' : '5 3'}"/>`).join('')}
      <text x="${W / 2}" y="12" text-anchor="middle" style="font-size:11px;fill:var(--ink-2)">${title}</text></svg>`;
  };
  const row = (l, v) => `<tr><td>${l}</td><td style="text-align:right"><b>${v}</b></td></tr>`;
  body.innerHTML = `<div class="grid g2">
    <div class="card"><h3>Base measurements <span class="tiny">mm, figure scaled to ${M.height} mm tall</span></h3>
      <table class="t">${row('Total height', M.height)}${row('Plinth diameter × height', `${M.plinth.diameter} × ${M.plinth.height}`)}
      ${row('Head height (neck to crown)', M.head.height)}${row('Head width × depth', `${M.head.width} × ${M.head.depth}`)}${row('Neck height', M.head.bottom)}
      ${row('Eye line height (' + (M.head.eyeLineSource || 'estimated') + ')', M.head.eyeLine)}${row('Body width × depth', `${M.shoulders.width} × ${M.shoulders.depth}`)}
      ${row('Head share of height', Math.round((M.head.height / M.height) * 100) + '%')}</table>
      <p class="tiny">Measured automatically from the base model. Sizes scale linearly: a 12 cm figure is ×1.2.</p></div>
    <div class="card"><h3>Anchor boxes</h3><div class="row" style="justify-content:space-around;align-items:flex-start">${diagram(0, 'Front')}${diagram(2, 'Side (face → right)')}</div>
      <div class="row small" style="gap:12px;margin-top:6px">${Object.keys(A).map((k) => `<span><span class="dot" style="background:${colors[k]}"></span> ${catLabel(k)}</span>`).join('')}</div></div>
    <div class="card"><div class="row"><h3 style="margin:0">Printer profile</h3><span class="grow"></span>
      <select class="in" id="dsPrinter">${Object.entries(PRINTERS).map(([k, v]) => `<option value="${k}" ${k === (ds.printer || 'Pop') ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      <table class="t" style="margin-top:8px"><tr><th>Printer</th><th>Thinnest part</th><th>Colour</th><th>Supports</th></tr>
      ${Object.entries(PRINTERS).map(([k, v]) => `<tr class="${k === (ds.printer || 'Pop') ? 'hl' : ''}"><td>${v.label}<div class="tiny">${STYLES[k].label} style · ${STYLES[k].sizes.join(', ')} cm</div></td><td>${v.thin} mm</td><td class="small">${v.colours}</td><td class="small">${v.supports}</td></tr>`).join('')}</table>
      <p class="small muted" style="margin:8px 0 0">The default is the strictest (filament): parts that pass its checks also print on the others. Change it once you know your printer.</p>
      <p class="small" style="margin-bottom:0">Every part overlaps the body by ${ds.settings.fuseMm} mm so it fuses when merged. Nothing may float. Parts must stay inside their anchor box.</p></div>
    <div class="card"><h3>View rules for new parts</h3>${(ds.views || VIEW_RULES).map((v, i) => `<p class="small" style="margin:6px 0">${i + 1}. ${esc(v)}</p>`).join('')}</div>
    <div class="card"><h3>Processing settings</h3><div class="fgrid">
      <label class="f">Voxel size (mm)<input class="in" type="number" step="0.05" min="0.15" max="0.8" data-set="pitch" value="${ds.settings.pitch}"></label>
      <label class="f">Gap cut around the base (mm)<input class="in" type="number" step="0.1" min="0.2" data-set="gapMm" value="${ds.settings.gapMm}"></label>
      <label class="f">Fuse depth into body (mm)<input class="in" type="number" step="0.1" min="0.5" data-set="fuseMm" value="${ds.settings.fuseMm}"></label></div>
      <p class="tiny">Smaller voxels keep more detail but take longer. Changes apply to parts you add from now on.</p></div>
  </div>`;
  $('#dsPrinter', body).onchange = async (e) => { ds.printer = e.target.value; style = ds.printer; await saveKit(); toast('Printer profile: ' + PRINTERS[ds.printer].label); renderDS(body, main); };
  $$('[data-set]', body).forEach((i) => (i.onchange = async () => { ds.settings[i.dataset.set] = +i.value; await saveKit(); toast('Saved'); }));
}
