import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { STYLES, state, save, esc, $, $$, toast, api, pickFiles, upload, loadModels, unitCost, money, costText, modal, fmtDate } from './core.js';
import { go } from './main.js';

let ctx = null; // persistent three.js context across visits
let current = null; // { name, url, object, stats }
let opts = { clay: false, wire: false, spin: false, grid: true, units: 'auto', target: 12 };

function ensureCtx() {
  if (ctx) return ctx;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);
  camera.position.set(2.2, 1.6, 3.2);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9cfe6, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(3, 5, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0xe8dcff, 1.0); rim.position.set(-4, 3, -3); scene.add(rim);
  const grid = new THREE.GridHelper(4, 20, 0xb9aecb, 0xddd6e6); scene.add(grid);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  const holder = new THREE.Group(); scene.add(holder);
  const clayMat = new THREE.MeshStandardMaterial({ color: 0xd9cfc4, roughness: 0.65, metalness: 0 });
  ctx = { renderer, scene, camera, controls, grid, holder, clayMat };
  const loop = () => {
    requestAnimationFrame(loop);
    if (!renderer.domElement.isConnected) return;
    if (opts.spin) holder.rotation.y += 0.008;
    controls.update();
    renderer.render(scene, camera);
  };
  loop();
  new ResizeObserver(() => resize()).observe(document.body);
  return ctx;
}
function resize() {
  const el = ctx?.renderer.domElement.parentElement;
  if (!el) return;
  const { clientWidth: w, clientHeight: h } = el;
  if (!w || !h) return;
  ctx.renderer.setSize(w, h, false);
  ctx.camera.aspect = w / h;
  ctx.camera.updateProjectionMatrix();
}

// Signed-tetrahedron volume (exact for closed meshes) in model units³.
function meshStats(root) {
  root.updateMatrixWorld(true);
  let vol = 0, tris = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry, pos = g.attributes.position, idx = g.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      vol += a.dot(b.clone().cross(c)) / 6;
      tris++;
    }
  });
  const box = new THREE.Box3().setFromObject(root);
  return { vol: Math.abs(vol), tris, size: box.getSize(new THREE.Vector3()) };
}
function unitScale(size) {
  // returns mm per model unit
  if (opts.units === 'mm') return 1;
  if (opts.units === 'cm') return 10;
  if (opts.units === 'm') return 1000;
  const m = Math.max(size.x, size.y, size.z);
  return m < 2 ? 1000 : m < 40 ? 10 : 1; // metres (glTF) / centimetres / millimetres
}

async function loadObject(url, name) {
  const ext = name.split('.').pop().toLowerCase();
  let obj;
  if (ext === 'glb' || ext === 'gltf') obj = (await new GLTFLoader().loadAsync(url)).scene;
  else if (ext === 'stl') {
    const geo = await new STLLoader().loadAsync(url);
    geo.computeVertexNormals();
    obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcdbfe6, roughness: 0.55 }));
    obj.rotation.x = -Math.PI / 2; // STL is Z-up
    const g = new THREE.Group(); g.add(obj); obj = g;
  } else if (ext === 'obj') {
    const loader = new OBJLoader();
    if (!url.startsWith('blob:')) {
      try {
        const mtlUrl = url.replace(/\.obj$/i, '.mtl');
        const mats = await new MTLLoader().setPath(mtlUrl.slice(0, mtlUrl.lastIndexOf('/') + 1)).loadAsync(mtlUrl.split('/').pop());
        mats.preload(); loader.setMaterials(mats);
      } catch {}
    }
    obj = await loader.loadAsync(url);
  } else throw new Error('Unsupported file: ' + name);
  return obj;
}

async function loadModel(url, name) {
  const c = ensureCtx();
  const obj = await loadObject(url, name);
  obj.traverse((o) => { if (o.isMesh) o.userData.orig = o.material; });
  c.holder.clear(); c.holder.rotation.set(0, 0, 0);
  const wrap = new THREE.Group(); wrap.add(obj); c.holder.add(wrap);
  const stats = meshStats(obj);
  // normalise for display: 1.6 units tall, sitting on the grid, centred
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const s = 1.6 / Math.max(size.y, size.x, size.z, 1e-6);
  wrap.scale.setScalar(s);
  wrap.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  c.controls.target.set(0, 0.75, 0);
  c.camera.position.set(1.9, 1.35, 2.9);
  current = { url, name, object: obj, stats };
  applyLook();
}
function applyLook() {
  if (!current) return;
  current.object.traverse((o) => {
    if (!o.isMesh) return;
    o.material = opts.clay ? ctx.clayMat : o.userData.orig;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    ms.forEach((m) => (m.wireframe = opts.wire));
  });
  ctx.grid.visible = opts.grid;
}

export function renderViewer(main, params = {}) {
  if (!kitCache && !renderViewer.kitAsked) { renderViewer.kitAsked = true; api('/api/kit').then((k) => { if (k) { kitCache = k; renderViewer(main, params); } }).catch(() => {}); }
  ensureCtx();
  const costs = state.db.settings.costs;
  const st = current?.stats;
  const mm = st ? unitScale(st.size) : 1;
  const h = st ? st.size.y * mm : 0;
  const volCm3 = st ? (st.vol * mm ** 3) / 1000 : 0;
  const scale = h ? (opts.target * 10) / h : 1;
  const scaledVol = volCm3 * scale ** 3;
  const groups = {};
  for (const m of state.models) (groups[m.group] ||= []).push(m);

  main.innerHTML = `
  <div class="page-head"><div><h1>3D viewer</h1><p>Check a model, measure it, and feed its real volume into costing.</p></div><div class="sp"></div>
    <button class="btn" id="vOpen">Open file…</button></div>
  <div class="viewer">
    <div class="stage3d" id="stage"><div class="hud">
      ${[['clay', 'Clay'], ['wire', 'Wireframe'], ['spin', 'Turntable'], ['grid', 'Grid']].map(([k, l]) => `<button class="btn sm ${opts[k] ? 'primary' : ''}" data-opt="${k}">${l}</button>`).join('')}
      <button class="btn sm" id="vShot">📷 Snapshot</button></div>
      ${current ? '' : `<div class="msg"><div style="font-size:40px">◈</div><b>No model loaded</b><span class="small">Drop a GLB, OBJ or STL here, or pick one on the right.</span></div>`}
      <div id="vBusy" class="msg" hidden><span class="spin"></span></div></div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="card"><h3>${current ? esc(current.name) : 'Measurements'}</h3>
        ${st ? `
        <div class="stat"><span>Height</span><b>${h.toFixed(1)} mm</b></div>
        <div class="stat"><span>Width × depth</span><b>${(st.size.x * mm).toFixed(1)} × ${(st.size.z * mm).toFixed(1)} mm</b></div>
        <div class="stat"><span>Volume (solid)</span><b>${volCm3.toFixed(1)} cm³</b></div>
        <div class="stat"><span>Triangles</span><b>${st.tris.toLocaleString()}</b></div>
        <label class="f" style="margin-top:10px">Units in file<select class="in" id="vUnits">${['auto', 'mm', 'cm', 'm'].map((u) => `<option ${u === opts.units ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
        <p class="tiny">Volume is exact only for watertight meshes — use the remeshed print solid / STL for costing.</p>
        <h3 style="margin-top:14px">Scale to</h3>
        <div class="seg">${[5, 8, 10, 12, 18].map((s) => `<button data-tgt="${s}" class="${opts.target === s ? 'on' : ''}">${s} cm</button>`).join('')}</div>
        <div class="stat" style="margin-top:8px"><span>Scale factor</span><b>×${scale.toFixed(3)}</b></div>
        <div class="stat"><span>Solid volume at ${opts.target} cm</span><b>${scaledVol.toFixed(1)} cm³</b></div>
        ${Object.keys(STYLES).map((s) => { const sc = { ...costs, baseVolume: volCm3, baseHeight: h / 10 }; return `<div class="stat"><span>${s} unit cost</span><b>${costText(unitCost(s, opts.target, sc).total)}</b></div>`; }).join('')}
        <button class="btn sm primary" id="vUse" style="margin-top:10px">Use this model's volume in costing</button>` : '<p class="muted small">Load a model to measure it.</p>'}
      </div>
      <div class="card"><h3>Models</h3>
        ${Object.keys(groups).length ? Object.entries(groups).map(([g, list]) => `<div class="tiny" style="margin-top:6px">${esc(groupLabel(g))}</div>${list.map((m) => `<div class="row" style="padding:3px 0;gap:6px"><span class="small grow" style="overflow:hidden;text-overflow:ellipsis" title="${esc(m.path)}">${esc(displayName(m))}</span><span class="tiny">${(m.size / 1048576).toFixed(1)} MB</span><button class="btn sm ghost" data-info="${esc(m.path)}" title="Model info" aria-label="Model info" style="padding:2px 7px">ⓘ</button><button class="btn sm" data-m="${esc(m.url)}" data-n="${esc(m.name)}">Load</button></div>`).join('')}`).join('') : '<p class="muted small">No saved models yet. Open a file, import a model zip, or add model files to an order.</p>'}
        <button class="btn sm ghost" id="vZip" style="margin-top:8px">Import model zip…</button></div>
    </div>
  </div>`;

  const stage = $('#stage', main);
  stage.prepend(ctx.renderer.domElement);
  resize();
  const busy = (on) => ($('#vBusy', main).hidden = !on);
  const load = async (url, name) => {
    busy(true);
    try { await loadModel(url, name); renderViewer(main); }
    catch (e) { busy(false); toast('Could not load model: ' + e.message, true); }
  };
  $$('[data-opt]', main).forEach((b) => (b.onclick = () => { opts[b.dataset.opt] = !opts[b.dataset.opt]; applyLook(); b.classList.toggle('primary', opts[b.dataset.opt]); }));
  $$('[data-tgt]', main).forEach((b) => (b.onclick = () => { opts.target = +b.dataset.tgt; renderViewer(main); }));
  $('#vUnits', main) && ($('#vUnits', main).onchange = (e) => { opts.units = e.target.value; renderViewer(main); });
  $('#vUse', main) && ($('#vUse', main).onclick = () => { costs.baseVolume = +volCm3.toFixed(1); costs.baseHeight = +(h / 10).toFixed(2); save(); toast(`Costing now uses ${costs.baseVolume} cm³ at ${costs.baseHeight} cm`); });
  $$('[data-m]', main).forEach((b) => (b.onclick = () => load(b.dataset.m, b.dataset.n)));
  $$('[data-info]', main).forEach((b) => (b.onclick = () => modelInfo(state.models.find((m) => m.path === b.dataset.info), (url, name) => load(url, name))));
  const openLocal = (files) => { const f = files.find((x) => /\.(glb|gltf|obj|stl)$/i.test(x.name)); if (!f) return toast('Pick a .glb, .obj or .stl file', true); load(URL.createObjectURL(f), f.name); };
  $('#vOpen', main).onclick = async () => openLocal(await pickFiles('.glb,.gltf,.obj,.stl', false));
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('drop', (e) => { e.preventDefault(); openLocal([...e.dataTransfer.files]); });
  const importZip = async (fn, msg) => {
    toast(msg); busy(true);
    try { state.models = await fn(); busy(false); renderViewer(main); const m = state.models.find((x) => x.ext === 'glb' && x.group.startsWith('models/')); if (m && !current) load(m.url, m.name); }
    catch (e) { busy(false); toast(e.message, true); }
  };
  $('#vZip', main).onclick = async () => { const f = await pickFiles('.zip', false); if (f[0]) importZip(() => upload('/api/models/import?name=' + encodeURIComponent(f[0].name.replace(/\.zip$/i, '')), [f[0]]), 'Importing…'); };
  $('#vShot', main).onclick = () => {
    const a = document.createElement('a');
    a.href = ctx.renderer.domElement.toDataURL('image/png');
    a.download = (current?.name || 'tinytwin').replace(/\.\w+$/, '') + '-snapshot.png';
    a.click();
  };
  if (params.url && (!current || current.url !== params.url)) load(params.url, params.name);
}

// ---------- model info ----------
let kitCache = null;
function kitEntry(path) {
  if (!kitCache || !path.startsWith('kit/')) return null;
  const rel = path.slice(4);
  if (kitCache.base?.file === rel) return { kind: 'Master base', name: kitCache.base.name, volumeMm3: kitCache.base.volumeMm3, source: kitCache.base.source };
  const b = (kitCache.bodies || []).find((x) => x.file === rel);
  if (b) return { kind: 'Body type', name: b.name, volumeMm3: b.volumeMm3, stretch: b.stretch, source: b.source };
  const p = (kitCache.parts || []).find((x) => x.file === rel);
  if (p) return { kind: 'Part', name: p.name, category: p.category, body: p.body, stats: p.stats, source: p.source, created: p.created };
  return null;
}
function jobFor(path) {
  const m = path.match(/^jobs\/([^/]+)\//);
  return m ? state.db.jobs.find((j) => j.id === m[1]) : null;
}
function groupLabel(g) {
  if (g === 'kit') return 'Part kit';
  if (g.startsWith('jobs/')) { const j = jobFor(g + '/'); return j ? `Order ${j.code} · ${j.customer || 'Unnamed'}` : 'Order (deleted)'; }
  return 'Imported · ' + g.replace(/^models\//, '');
}
function displayName(m) { const k = kitEntry(m.path); return k ? `${k.name}${k.category ? ' (' + k.category + ')' : ''}` : m.name; }

function geometryReport(obj) {
  const st = meshStats(obj);
  const mm = unitScale(st.size);
  // open-edge check on welded positions
  const key = new Map(); const edges = new Map(); let verts = 0, mats = new Set(), tex = new Set();
  const v = new THREE.Vector3();
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (!o.isMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { mats.add(m); for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) if (m[k]) tex.add(m[k]); });
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    verts += pos.count;
    const id = (i) => { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); const k = `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`; let r = key.get(k); if (r === undefined) { r = key.size; key.set(k, r); } return r; };
    const n = idx ? idx.count : pos.count;
    if (n > 3.6e6) return;
    for (let t = 0; t + 2 < n; t += 3) {
      const a = id(idx ? idx.getX(t) : t), b = id(idx ? idx.getX(t + 1) : t + 1), c = id(idx ? idx.getX(t + 2) : t + 2);
      for (const [p, q] of [[a, b], [b, c], [c, a]]) { const e = p < q ? p * 4194304 + q : q * 4194304 + p; edges.set(e, (edges.get(e) || 0) + 1); }
    }
  });
  let open = 0; for (const c of edges.values()) if (c !== 2) open++;
  return {
    tris: st.tris, verts, materials: mats.size, textures: tex.size, units: mm === 1000 ? 'metres (glTF)' : mm === 10 ? 'centimetres' : 'millimetres',
    size: [st.size.x * mm, st.size.z * mm, st.size.y * mm], volumeCm3: (st.vol * mm ** 3) / 1000, openEdges: edges.size ? open : null,
  };
}

function modelInfo(m, onLoad) {
  if (!m) return;
  const k = kitEntry(m.path), job = jobFor(m.path);
  state.db.modelNotes ||= {};
  const row = (l, v) => (v === undefined || v === null || v === '' ? '' : `<div class="stat"><span>${l}</span><b style="text-align:right;max-width:60%;overflow-wrap:anywhere">${v}</b></div>`);
  const src = k?.source || '';
  modal(`<div style="width:min(620px,90vw)"><div class="row" style="margin-bottom:6px"><h3 style="margin:0">ⓘ ${esc(k ? k.name : m.name)}</h3><span class="grow"></span><button class="btn sm" data-close>Close</button></div>
    <div class="tiny" style="margin-bottom:10px">${esc(groupLabel(m.group))}</div>
    <div class="grid g2">
      <div><h4 style="margin:4px 0">File</h4>
        ${row('File name', esc(m.name))}${row('Format', m.ext.toUpperCase())}${row('Size', (m.size / 1048576).toFixed(2) + ' MB')}${row('Added / changed', m.modified ? new Date(m.modified).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '')}
        ${row('Location', '<span class="tiny">' + esc(m.path) + '</span>')}
        ${job ? row('Order', `${esc(job.code)} · ${esc(job.customer || 'Unnamed')} · ${esc(job.occasion)}`) + row('Order stage', esc(job.stage)) : ''}
        ${k ? `<h4 style="margin:12px 0 4px">Part kit</h4>${row('Type', esc(k.kind))}${row('Category', esc(k.category || ''))}${row('Made on body', k.kind === 'Part' && k.category === 'outfit' ? esc(((kitCache.bodies || []).find((b) => b.id === k.body) || { name: kitCache.base.name }).name) : '')}
          ${row('Solid volume', k.volumeMm3 || k.stats?.volumeMm3 ? (((k.volumeMm3 || k.stats.volumeMm3) / 1000).toFixed(2) + ' cm³') : '')}${row('Body stretch to master neck', k.stretch ? '×' + k.stretch : '')}
          ${k.stats ? row('Thinner than printer minimum', Math.round(k.stats.thinShare * 100) + '% (' + esc(k.stats.style || '') + ')') + row('Recovered by colour', k.stats.rescuedMm3 ? (k.stats.rescuedMm3 / 1000).toFixed(2) + ' cm³' : '') + row('Head fit', k.stats.fit ? k.stats.fit.shiftMm.join(', ') + ' mm · ×' + k.stats.fit.scale + ' · ' + Math.round(k.stats.fit.agreement * 100) + '% match' : '') : ''}
          ${row('Created', k.created ? fmtDate(k.created) : '')}${row('Source', src ? (src.startsWith('http') ? `<a href="${esc(src)}" target="_blank">${esc(src.split('/').pop())}</a>` : esc(src)) : '')}` : ''}
      </div>
      <div><h4 style="margin:4px 0">Geometry</h4><div id="iGeo"><span class="spin"></span> <span class="small muted">Measuring…</span></div>
        <label class="f" style="margin-top:12px">Notes<textarea class="in" id="iNote" placeholder="What is this model, what needs fixing, where it came from…">${esc(state.db.modelNotes[m.path] || '')}</textarea></label></div>
    </div>
    <div class="row" style="margin-top:12px"><button class="btn" id="iFolder">Open folder</button><span class="grow"></span><button class="btn primary" id="iLoad">Load in viewer</button></div></div>`, async (box, close) => {
    $('#iNote', box).onchange = (e) => { state.db.modelNotes[m.path] = e.target.value; save(); toast('Note saved'); };
    $('#iFolder', box).onclick = () => api('/api/open?path=' + encodeURIComponent(m.path.split('/').slice(0, -1).join('/')), { method: 'POST' });
    $('#iLoad', box).onclick = () => { close(); onLoad(m.url, m.name); };
    try {
      const g = geometryReport(await loadObject(m.url, m.name));
      const el = $('#iGeo', box); if (!el) return;
      el.innerHTML = row('Size (W × D × H)', g.size.map((x) => x.toFixed(1)).join(' × ') + ' mm') + row('Units in file', g.units) + row('Triangles', g.tris.toLocaleString()) + row('Vertices', g.verts.toLocaleString())
        + row('Solid volume', g.volumeCm3.toFixed(2) + ' cm³') + row('Materials / textures', g.materials + ' / ' + g.textures)
        + row('Watertight (printable as is)', g.openEdges === null ? 'not checked (too large)' : g.openEdges === 0 ? '<span style="color:var(--ok)">Yes</span>' : `<span style="color:var(--warn)">No — ${g.openEdges.toLocaleString()} open edges</span>`);
    } catch (e) { const el = $('#iGeo', box); if (el) el.innerHTML = `<span class="small" style="color:var(--bad)">Couldn't read the model: ${esc(e.message)}</span>`; }
  });
}
