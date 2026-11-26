import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { STYLES, state, save, esc, $, $$, toast, api, pickFiles, upload, loadModels, unitCost, money, costText, modal, fmtDate } from './core.js';
import { go } from './main.js';

const MODEL_RE = /\.(glb|gltf|obj|stl|blend)$/i;
const DISPLAY_H = 1.6; // models are normalised to this height on screen

let ctx = null; // persistent three.js context across visits
// { name, url, object, stats, report (Blender scene report), wrapScale, nodes: [{name, node, ...}], selected, problems, measure }
let current = null;
let opts = { clay: false, wire: false, spin: false, grid: true, problems: false, measure: false, section: '', cut: 0.5, units: 'auto', target: 12 };

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
  const marks = new THREE.Group(); scene.add(marks); // selection box + measure points
  const clayMat = new THREE.MeshStandardMaterial({ color: 0xd9cfc4, roughness: 0.65, metalness: 0 });
  const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  ctx = { renderer, scene, camera, controls, grid, holder, marks, clayMat, plane, ray: new THREE.Raycaster() };
  const loop = () => {
    requestAnimationFrame(loop);
    if (!renderer.domElement.isConnected) return;
    if (opts.spin) holder.rotation.y += 0.008;
    controls.update();
    if (current?.selBox) current.selBox.update();
    renderer.render(scene, camera);
  };
  loop();
  new ResizeObserver(() => resize()).observe(document.body);
  // click (not drag) on the model: select an object, or place a measuring point
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    down = null;
    onPick(e);
  });
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

const shown = (o, root) => { for (let n = o; n && n !== root.parent; n = n.parent) if (!n.visible) return false; return true; };

// Signed-tetrahedron volume (exact for closed meshes) in model units³. Hidden objects are skipped.
function meshStats(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  let vol = 0, tris = 0;
  const box = new THREE.Box3(), m = new THREE.Matrix4();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !shown(o, root)) return;
    m.multiplyMatrices(inv, o.matrixWorld); // mesh → root (model units)
    const g = o.geometry, pos = g.attributes.position, idx = g.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m);
      vol += a.dot(b.clone().cross(c)) / 6;
      tris++;
    }
    if (!g.boundingBox) g.computeBoundingBox();
    box.union(g.boundingBox.clone().applyMatrix4(m));
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(), new THREE.Vector3());
  return { vol: Math.abs(vol), tris, size: box.getSize(new THREE.Vector3()) };
}
// millimetres per model unit
function unitScale(size, mmPerUnit) {
  if (opts.units === 'mm') return 1;
  if (opts.units === 'cm') return 10;
  if (opts.units === 'm') return 1000;
  if (mmPerUnit) return mmPerUnit; // Blender files say exactly
  const m = Math.max(size.x, size.y, size.z);
  return m < 2 ? 1000 : m < 40 ? 10 : 1; // metres (glTF) / centimetres / millimetres
}

// Open/non-manifold edges on welded positions, in root space. Returns line positions for an overlay.
function edgeCheck(root, onlyShown = true) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), m = new THREE.Matrix4();
  const keys = new Map(), pts = [], edges = new Map();
  const box = new THREE.Box3().setFromObject(root), q = Math.max(box.getSize(new THREE.Vector3()).length() * 2e-6, 1e-9);
  const v = new THREE.Vector3();
  let skipped = false;
  root.traverse((o) => {
    if (!o.isMesh || (onlyShown && !shown(o, root))) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    if (n > 3.6e6) { skipped = true; return; }
    m.multiplyMatrices(inv, o.matrixWorld);
    const id = (i) => {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      const k = Math.round(v.x / q) + ',' + Math.round(v.y / q) + ',' + Math.round(v.z / q);
      let r = keys.get(k);
      if (r === undefined) { r = pts.length / 3; keys.set(k, r); pts.push(v.x, v.y, v.z); }
      return r;
    };
    for (let t = 0; t + 2 < n; t += 3) {
      const a = id(idx ? idx.getX(t) : t), b = id(idx ? idx.getX(t + 1) : t + 1), c = id(idx ? idx.getX(t + 2) : t + 2);
      for (const [p, r] of [[a, b], [b, c], [c, a]]) { if (p === r) continue; const e = p < r ? p * 4194304 + r : r * 4194304 + p; edges.set(e, (edges.get(e) || 0) + 1); }
    }
  });
  let open = 0, multi = 0; const line = [];
  for (const [e, c] of edges) {
    if (c === 2) continue;
    c === 1 ? open++ : multi++;
    const p = Math.floor(e / 4194304), r = e % 4194304;
    line.push(pts[p * 3], pts[p * 3 + 1], pts[p * 3 + 2], pts[r * 3], pts[r * 3 + 1], pts[r * 3 + 2]);
  }
  return { open, multi, line, checked: edges.size > 0 && !skipped };
}

async function convertBlend(path, force) {
  return api(`/api/blend/convert?path=${encodeURIComponent(path)}${force ? '&force=1' : ''}`, { method: 'POST' });
}
const dataPath = (url) => decodeURIComponent(url.replace(/^\/data\//, '').split('?')[0]);

async function loadObject(url, name, report) {
  const ext = name.split('.').pop().toLowerCase();
  let obj;
  if (ext === 'blend') {
    report ||= await convertBlend(dataPath(url));
    obj = (await new GLTFLoader().loadAsync(report.glb)).scene;
    obj.userData.blend = report;
  } else if (ext === 'glb' || ext === 'gltf') obj = (await new GLTFLoader().loadAsync(url)).scene;
  else if (ext === 'stl') {
    const geo = await new STLLoader().loadAsync(url);
    geo.computeVertexNormals();
    obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcdbfe6, roughness: 0.55 }));
    obj.name = name;
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

// The list of objects shown in the Scene card. Blender files use their own collections and names.
function sceneNodes(obj, report) {
  const byName = new Map();
  obj.traverse((o) => { if (o !== obj && o.name) byName.set(o.name, o); });
  if (report?.objects) {
    const out = [];
    for (const ro of report.objects) {
      const node = byName.get(THREE.PropertyBinding.sanitizeNodeName(ro.name)) || byName.get(ro.name);
      if (!node) continue; // cameras, lights, empties without geometry
      if (!ro.visible) node.visible = false;
      out.push({ name: ro.name, node, info: ro, group: ro.collections?.[0] || 'Scene' });
    }
    return out;
  }
  const kids = obj.children.length === 1 && !obj.children[0].isMesh && obj.children[0].children.length ? obj.children[0].children : obj.children;
  return kids.filter((n) => { let has = false; n.traverse((o) => (has ||= o.isMesh)); return has; }).map((node, i) => ({ name: node.name || `Part ${i + 1}`, node, group: '' }));
}

async function loadModel(url, name, report) {
  const c = ensureCtx();
  const obj = await loadObject(url, name, report);
  report = obj.userData.blend || null;
  obj.traverse((o) => { if (o.isMesh) o.userData.orig = o.material; });
  c.holder.clear(); c.holder.rotation.set(0, 0, 0); c.marks.clear();
  const wrap = new THREE.Group(); wrap.add(obj); c.holder.add(wrap);
  const nodes = sceneNodes(obj, report);
  const stats = meshStats(obj);
  // normalise for display: 1.6 units tall, sitting on the grid, centred (visible objects only)
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3(); obj.traverse((o) => { if (o.isMesh && shown(o, obj)) box.expandByObject(o); });
  if (box.isEmpty()) box.setFromObject(obj);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const s = DISPLAY_H / Math.max(size.y, size.x, size.z, 1e-6);
  wrap.scale.setScalar(s);
  wrap.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  current = { url, name, object: obj, stats, report, wrapScale: s, nodes, selected: null, problems: null, measure: [] };
  if (opts.problems) refreshProblems();
  view('front');
  applyLook();
}
function restat() {
  current.stats = meshStats(current.object);
  if (opts.problems) refreshProblems();
}
function refreshProblems() {
  if (!current) return;
  if (current.problemLines) { current.problemLines.removeFromParent(); current.problemLines.geometry.dispose(); current.problemLines = null; }
  const r = edgeCheck(current.object);
  current.problems = r;
  if (!r.line.length) return;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(r.line, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xe0245e, depthTest: false, transparent: true, opacity: 0.95 }));
  lines.renderOrder = 10;
  current.object.add(lines);
  current.problemLines = lines;
}
function applyLook() {
  if (!current) return;
  const sec = !!opts.section;
  current.object.traverse((o) => {
    if (!o.isMesh) return;
    o.material = opts.clay ? ctx.clayMat : o.userData.orig;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    ms.forEach((m) => { m.wireframe = opts.wire; if (m.userData.side0 === undefined) m.userData.side0 = m.side; m.side = sec ? THREE.DoubleSide : m.userData.side0; m.needsUpdate = true; });
  });
  if (current.problemLines) current.problemLines.visible = opts.problems;
  ctx.grid.visible = opts.grid;
  applySection();
}
function applySection() {
  const { renderer, plane, holder } = ctx;
  if (!opts.section || !current) { renderer.clippingPlanes = []; return; }
  const box = new THREE.Box3().setFromObject(holder);
  const ax = opts.section, n = new THREE.Vector3(); n[ax] = -1;
  plane.normal.copy(n);
  plane.constant = box.min[ax] + opts.cut * (box.max[ax] - box.min[ax]);
  renderer.clippingPlanes = [plane];
}
function view(which) {
  const { camera, controls } = ctx;
  const t = new THREE.Vector3(0, DISPLAY_H / 2, 0), d = 3.4;
  const dirs = { front: [0, 0.12, 1], back: [0, 0.12, -1], left: [-1, 0.12, 0], right: [1, 0.12, 0], top: [0, 1, 0.001], three: [0.55, 0.35, 0.85] };
  const v = new THREE.Vector3(...dirs[which]).normalize().multiplyScalar(d);
  if (current) ctx.holder.rotation.y = 0;
  controls.target.copy(t);
  camera.position.copy(t).add(v);
  controls.update();
}

// ---------- picking: select / measure ----------
function onPick(e) {
  if (!current) return;
  const { renderer, camera, ray, holder, plane } = ctx;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObject(holder, true).find((h) => h.object.isMesh && shown(h.object, current.object) && (!opts.section || plane.distanceToPoint(h.point) >= 0));
  if (opts.measure) {
    if (!hit) return;
    if (current.measure.length >= 2) current.measure = [];
    current.measure.push(hit.point.clone());
    drawMarks(); measureLabel();
    return;
  }
  select(hit ? current.nodes.find((n) => { for (let o = hit.object; o; o = o.parent) if (o === n.node) return true; return false; }) : null);
  rerenderPanel?.();
}
function select(entry) {
  current.selected = entry || null;
  drawMarks();
}
function drawMarks() {
  const { marks } = ctx;
  marks.clear();
  current.selBox = null;
  if (current.selected) { current.selBox = new THREE.BoxHelper(current.selected.node, 0xd4a845); current.selBox.material.depthTest = false; current.selBox.renderOrder = 11; marks.add(current.selBox); }
  const pts = current.measure;
  for (const p of pts) { const s = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 12), new THREE.MeshBasicMaterial({ color: 0x5b2e8c, depthTest: false })); s.position.copy(p); s.renderOrder = 12; marks.add(s); }
  if (pts.length === 2) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x5b2e8c, depthTest: false })); l.renderOrder = 12; marks.add(l); }
}
const mmPer = () => (current ? unitScale(current.stats.size, current.report?.units?.mmPerUnit) : 1);
function measureLabel() {
  const el = $('#vMeasure');
  if (!el) return;
  const pts = current?.measure || [];
  el.hidden = !opts.measure;
  el.innerHTML = pts.length === 2 ? `<b>${((pts[0].distanceTo(pts[1]) / current.wrapScale) * mmPer()).toFixed(1)} mm</b> <span class="tiny">(click again to start a new measurement)</span>`
    : pts.length === 1 ? 'Click the second point…' : 'Click two points on the model to measure between them.';
}
let rerenderPanel = null;

// ---------- page ----------
export function renderViewer(main, params = {}) {
  if (!kitCache && !renderViewer.kitAsked) { renderViewer.kitAsked = true; api('/api/kit').then((k) => { if (k) { kitCache = k; renderViewer(main, params); } }).catch(() => {}); }
  ensureCtx();
  rerenderPanel = () => renderViewer(main);
  const costs = state.db.settings.costs;
  const st = current?.stats;
  const mm = st ? mmPer() : 1;
  const h = st ? st.size.y * mm : 0;
  const volCm3 = st ? (st.vol * mm ** 3) / 1000 : 0;
  const scale = h ? (opts.target * 10) / h : 1;
  const scaledVol = volCm3 * scale ** 3;
  const groups = {};
  for (const m of state.models) (groups[m.group] ||= []).push(m);
  const rep = current?.report;
  const hidden = current ? current.nodes.filter((n) => !n.node.visible).length : 0;

  main.innerHTML = `
  <div class="page-head"><div><h1>3D viewer</h1><p>Check a model or a Blender file, look inside it, measure it, and feed its real volume into costing.</p></div><div class="sp"></div>
    <button class="btn" id="vOpen">Open file…</button></div>
  <div class="viewer">
    <div class="stage3d" id="stage"><div class="hud">
      ${[['clay', 'Clay'], ['wire', 'Wireframe'], ['spin', 'Turntable'], ['grid', 'Grid'], ['problems', 'Print problems'], ['measure', 'Measure']].map(([k, l]) => `<button class="btn sm ${opts[k] ? 'primary' : ''}" data-opt="${k}">${l}</button>`).join('')}
      <button class="btn sm" id="vShot">📷 Snapshot</button></div>
      <div class="hud views">${[['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['three', '¾']].map(([k, l]) => `<button class="btn sm" data-view="${k}">${l}</button>`).join('')}</div>
      <div class="hud bottom">
        <div class="seg">${[['', 'No section'], ['x', 'Cut X'], ['y', 'Cut Y'], ['z', 'Cut Z']].map(([k, l]) => `<button data-sec="${k}" class="${opts.section === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${opts.section ? `<input type="range" id="vCut" min="0" max="1" step="0.005" value="${opts.cut}" style="width:220px">` : ''}
        <div id="vMeasure" class="measure" ${opts.measure ? '' : 'hidden'}></div>
        ${opts.problems && current?.problems ? `<div class="measure">${current.problems.checked ? (current.problems.open + current.problems.multi ? `<b style="color:#e0245e">${current.problems.open.toLocaleString()} open · ${current.problems.multi.toLocaleString()} non-manifold edges</b> <span class="tiny">shown in pink</span>` : '<b style="color:var(--ok)">Watertight</b> <span class="tiny">no open or non-manifold edges</span>') : 'Too large to check here'}</div>` : ''}
      </div>
      ${current ? '' : `<div class="msg"><div style="font-size:40px">◈</div><b>No model loaded</b><span class="small">Drop a .blend, GLB, OBJ or STL here, or pick one on the right.</span></div>`}
      <div id="vBusy" class="msg" hidden><span class="spin"></span><span class="small" id="vBusyMsg" style="margin-top:8px"></span></div></div>
    <div style="display:flex;flex-direction:column;gap:12px;overflow:auto;max-height:calc(100vh - 150px)">
      <div class="card"><h3>${current ? esc(current.name) : 'Measurements'}</h3>
        ${st ? `
        ${hidden ? `<p class="tiny" style="margin-top:-4px">Measuring visible objects only (${hidden} hidden).</p>` : ''}
        <div class="stat"><span>Height</span><b>${h.toFixed(1)} mm</b></div>
        <div class="stat"><span>Width × depth</span><b>${(st.size.x * mm).toFixed(1)} × ${(st.size.z * mm).toFixed(1)} mm</b></div>
        <div class="stat"><span>Volume (solid)</span><b>${volCm3.toFixed(1)} cm³</b></div>
        <div class="stat"><span>Triangles</span><b>${st.tris.toLocaleString()}</b></div>
        <label class="f" style="margin-top:10px">Units in file<select class="in" id="vUnits">${['auto', 'mm', 'cm', 'm'].map((u) => `<option ${u === opts.units ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
        <p class="tiny">${rep ? `Blender scene units: ${esc(rep.units.length.toLowerCase())} (1 unit = ${+rep.units.mmPerUnit} mm). ` : ''}Volume is exact only for watertight meshes — use the remeshed print solid / STL for costing.</p>
        <h3 style="margin-top:14px">Scale to</h3>
        <div class="seg">${[5, 8, 10, 12, 18].map((s) => `<button data-tgt="${s}" class="${opts.target === s ? 'on' : ''}">${s} cm</button>`).join('')}</div>
        <div class="stat" style="margin-top:8px"><span>Scale factor</span><b>×${scale.toFixed(3)}</b></div>
        <div class="stat"><span>Solid volume at ${opts.target} cm</span><b>${scaledVol.toFixed(1)} cm³</b></div>
        ${Object.keys(STYLES).map((s) => { const sc = { ...costs, baseVolume: volCm3, baseHeight: h / 10 }; return `<div class="stat"><span>${s} unit cost</span><b>${costText(unitCost(s, opts.target, sc).total)}</b></div>`; }).join('')}
        <button class="btn sm primary" id="vUse" style="margin-top:10px">Use this model's volume in costing</button>` : '<p class="muted small">Load a model to measure it.</p>'}
      </div>
      ${current ? sceneCard() : ''}
      ${current?.selected ? selectedCard(current.selected) : ''}
      ${rep ? blendCard(rep) : ''}
      <div class="card"><h3>Models</h3>
        ${Object.keys(groups).length ? Object.entries(groups).map(([g, list]) => `<div class="tiny" style="margin-top:6px">${esc(groupLabel(g))}</div>${list.map((m) => `<div class="row" style="padding:3px 0;gap:6px"><span class="small grow" style="overflow:hidden;text-overflow:ellipsis" title="${esc(m.path)}">${m.ext === 'blend' ? '<span class="chip plum" style="padding:0 6px">blend</span> ' : ''}${esc(displayName(m))}</span><span class="tiny">${(m.size / 1048576).toFixed(1)} MB</span><button class="btn sm ghost" data-info="${esc(m.path)}" title="Model info" aria-label="Model info" style="padding:2px 7px">ⓘ</button><button class="btn sm" data-m="${esc(m.url)}" data-n="${esc(m.name)}">Load</button></div>`).join('')}`).join('') : '<p class="muted small">No saved models yet. Open a file, import a model zip, or add model files to an order.</p>'}
        <button class="btn sm ghost" id="vZip" style="margin-top:8px">Import model zip…</button></div>
    </div>
  </div>`;

  const stage = $('#stage', main);
  stage.prepend(ctx.renderer.domElement);
  resize();
  measureLabel();
  const busy = (on, msg = '') => { $('#vBusy', main).hidden = !on; $('#vBusyMsg', main).textContent = msg; };
  const load = async (url, name, report) => {
    busy(true, /\.blend$/i.test(name) && !report ? 'Opening in Blender and exporting… (first time only)' : '');
    try { await loadModel(url, name, report); renderViewer(main); }
    catch (e) { busy(false); toast('Could not load model: ' + e.message, true); }
  };
  $$('[data-opt]', main).forEach((b) => (b.onclick = () => {
    const k = b.dataset.opt; opts[k] = !opts[k];
    if (k === 'problems' && opts.problems && current && !current.problems) refreshProblems();
    if (k === 'measure' && current) { current.measure = []; drawMarks(); }
    applyLook(); renderViewer(main);
  }));
  $$('[data-view]', main).forEach((b) => (b.onclick = () => view(b.dataset.view)));
  $$('[data-sec]', main).forEach((b) => (b.onclick = () => { opts.section = b.dataset.sec; applyLook(); renderViewer(main); }));
  $('#vCut', main) && ($('#vCut', main).oninput = (e) => { opts.cut = +e.target.value; applySection(); });
  $$('[data-tgt]', main).forEach((b) => (b.onclick = () => { opts.target = +b.dataset.tgt; renderViewer(main); }));
  $('#vUnits', main) && ($('#vUnits', main).onchange = (e) => { opts.units = e.target.value; renderViewer(main); });
  $('#vUse', main) && ($('#vUse', main).onclick = () => { costs.baseVolume = +volCm3.toFixed(1); costs.baseHeight = +(h / 10).toFixed(2); save(); toast(`Costing now uses ${costs.baseVolume} cm³ at ${costs.baseHeight} cm`); });
  $$('[data-m]', main).forEach((b) => (b.onclick = () => load(b.dataset.m, b.dataset.n)));
  $$('[data-info]', main).forEach((b) => (b.onclick = () => modelInfo(state.models.find((m) => m.path === b.dataset.info), (url, name) => load(url, name))));

  // scene list: show/hide, isolate, select
  if (current) {
    const entry = (i) => current.nodes[+i];
    $$('[data-eye]', main).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const n = entry(b.dataset.eye); n.node.visible = !n.node.visible; restat(); renderViewer(main); }));
    $$('[data-iso]', main).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const n = entry(b.dataset.iso); current.nodes.forEach((x) => (x.node.visible = x === n)); select(n); restat(); renderViewer(main); }));
    $$('[data-sel]', main).forEach((r) => (r.onclick = () => { const n = entry(r.dataset.sel); select(current.selected === n ? null : n); renderViewer(main); }));
    $('#vShowAll', main) && ($('#vShowAll', main).onclick = () => { current.nodes.forEach((x) => (x.node.visible = true)); restat(); renderViewer(main); });
    $('#vDesel', main) && ($('#vDesel', main).onclick = () => { select(null); renderViewer(main); });
  }
  if (rep) {
    $('#vBlender', main).onclick = () => api('/api/blend/open?path=' + encodeURIComponent(rep.path), { method: 'POST' }).then(() => toast('Opening in Blender…')).catch((e) => toast(e.message, true));
    $('#vReexport', main).onclick = async () => { busy(true, 'Exporting from Blender again…'); try { const r = await convertBlend(rep.path, true); await loadModel(current.url, current.name, r); toast('Re-exported from Blender'); renderViewer(main); } catch (e) { busy(false); toast(e.message, true); } };
  }

  const openLocal = async (files) => {
    const f = files.find((x) => MODEL_RE.test(x.name));
    if (!f) return toast('Pick a .blend, .glb, .obj or .stl file', true);
    if (/\.blend$/i.test(f.name)) {
      busy(true, 'Opening in Blender and exporting…');
      try { const r = await upload('/api/blend/convert', [f]); await loadModels(); await loadModel('/data/' + r.path, r.name, r); renderViewer(main); }
      catch (e) { busy(false); toast('Could not open the Blender file: ' + e.message, true); }
      return;
    }
    load(URL.createObjectURL(f), f.name);
  };
  $('#vOpen', main).onclick = async () => openLocal(await pickFiles('.blend,.glb,.gltf,.obj,.stl', false));
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

function sceneCard() {
  const groups = {};
  current.nodes.forEach((n, i) => (groups[n.group] ||= []).push([n, i]));
  const probs = (n) => { const m = n.info?.mesh; return m && (m.openEdges || m.nonManifoldEdges) ? '<span class="dot" style="background:#e0245e" title="Not watertight"></span>' : ''; };
  return `<div class="card"><div class="row" style="margin-bottom:8px"><h3 style="margin:0">Scene</h3><span class="tiny">${current.nodes.length} object${current.nodes.length === 1 ? '' : 's'}</span><span class="grow"></span>
    ${current.nodes.some((n) => !n.node.visible) ? '<button class="btn sm ghost" id="vShowAll">Show all</button>' : ''}</div>
    <div class="outliner">${Object.entries(groups).map(([g, list]) => `${g ? `<div class="tiny" style="margin:6px 0 2px">▾ ${esc(g)}</div>` : ''}${list.map(([n, i]) => `<div class="ol ${current.selected === n ? 'on' : ''} ${n.node.visible ? '' : 'off'}" data-sel="${i}">
      <button class="eye" data-eye="${i}" title="${n.node.visible ? 'Hide' : 'Show'}">${n.node.visible ? '◉' : '○'}</button>
      <span class="grow" title="${esc(n.name)}">${esc(n.name)}</span>${probs(n)}${n.info?.type && n.info.type !== 'MESH' ? `<span class="tiny">${esc(n.info.type.toLowerCase())}</span>` : ''}
      <button class="btn sm ghost iso" data-iso="${i}" title="Show only this">Solo</button></div>`).join('')}`).join('') || '<p class="muted small">No separate objects in this file.</p>'}</div>
    <p class="tiny" style="margin:8px 0 0">Click an object here or on the model to inspect it.</p></div>`;
}

function selectedCard(n) {
  const mm = mmPer(), s = current.wrapScale;
  const box = new THREE.Box3().setFromObject(n.node), size = box.getSize(new THREE.Vector3()).multiplyScalar(mm / s);
  const ec = edgeCheck(n.node, false), st = meshStats(n.node);
  const i = n.info || {}, me = i.mesh;
  const row = (l, v) => (v === undefined || v === null || v === '' ? '' : `<div class="stat"><span>${l}</span><b style="text-align:right;max-width:62%;overflow-wrap:anywhere">${v}</b></div>`);
  const tight = ec.checked ? (ec.open + ec.multi === 0 ? '<span style="color:var(--ok)">Yes</span>' : `<span style="color:var(--warn)">No — ${ec.open} open, ${ec.multi} non-manifold</span>`) : '';
  const vol = me?.volume != null ? (me.volume * (current.report.units.mmPerUnit ** 3)) / 1000 : ec.checked && ec.open + ec.multi === 0 ? (st.vol * mm ** 3) / 1000 : null;
  return `<div class="card"><div class="row" style="margin-bottom:6px"><h3 style="margin:0">${esc(n.name)}</h3><span class="grow"></span><button class="btn sm ghost" id="vDesel">✕</button></div>
    ${row('Size (W × D × H)', `${size.x.toFixed(1)} × ${size.z.toFixed(1)} × ${size.y.toFixed(1)} mm`)}
    ${row('Triangles', (me?.tris ?? st.tris).toLocaleString())}${row('Vertices', me?.verts?.toLocaleString())}
    ${row('Watertight', tight)}${row('Solid volume', vol != null ? vol.toFixed(2) + ' cm³' : 'only for closed meshes')}
    ${row('Separate pieces', me?.islands > 1 ? `${me.islands} <span class="tiny">(may need joining)</span>` : me?.islands)}
    ${row('Collection', esc(i.collections?.join(', ') || ''))}${row('Parent', esc(i.parent || ''))}
    ${row('Modifiers', i.modifiers?.length ? i.modifiers.map((m) => esc(m.name) + (m.on ? '' : ' <span class="tiny">(off)</span>')).join(', ') + ' <span class="tiny">(applied in this view)</span>' : '')}
    ${row('Materials', esc(i.materials?.join(', ') || ''))}${row('Shape keys', esc(i.shapeKeys?.slice(1).join(', ') || ''))}
    ${row('Vertex groups', i.vertexGroups?.length || '')}${row('UV maps', esc(i.uvMaps?.join(', ') || ''))}
    ${row('Hidden in Blender', i.visible === false ? 'Yes' : '')}${row('Hidden in renders', i.hideRender ? 'Yes' : '')}
    ${i.props ? Object.entries(i.props).map(([k, v]) => row(esc(k), esc(v))).join('') : ''}</div>`;
}

function blendCard(r) {
  const c = r.counts || {};
  return `<div class="card"><div class="row" style="margin-bottom:8px"><h3 style="margin:0">Blender file</h3><span class="grow"></span>
      <button class="btn sm" id="vReexport" title="Run the export again (after editing the file)">↻ Re-export</button><button class="btn sm primary" id="vBlender">Open in Blender</button></div>
    <div class="stat"><span>Saved with</span><b>Blender ${esc(r.savedWith)}</b></div>
    <div class="stat"><span>Units</span><b>${esc(r.units.system.toLowerCase())} · ${esc(r.units.length.toLowerCase())}</b></div>
    <div class="stat"><span>Contents</span><b>${c.objects || 0} objects · ${c.meshes || 0} meshes · ${c.materials || 0} materials · ${c.images || 0} images</b></div>
    ${c.armatures ? `<div class="stat"><span>Rigs / animations</span><b>${c.armatures} / ${c.actions || 0}</b></div>` : ''}
    ${r.warnings?.length ? `<div style="margin-top:8px">${r.warnings.map((w) => `<div class="small" style="color:var(--warn);padding:2px 0">⚠ ${esc(w)}</div>`).join('')}</div>` : ''}
    ${r.materials?.length ? `<h4 style="margin:12px 0 4px">Materials</h4>${r.materials.map((m) => `<div class="row small" style="padding:3px 0;gap:8px"><span class="swatch" style="background:rgb(${m.color.map((v) => Math.round(Math.pow(Math.max(0, v), 1 / 2.2) * 255)).join(',')})"></span><span class="grow">${esc(m.name)}</span><span class="tiny">${m.images.length ? '🖼 ' + esc(m.images.join(', ')) : `rough ${m.roughness}`}</span></div>`).join('')}` : ''}
    ${r.images?.length ? `<h4 style="margin:12px 0 4px">Textures</h4>${r.images.map((im) => `<div class="row small" style="padding:2px 0"><span class="grow">${esc(im.name)}</span><span class="tiny">${im.size.join(' × ')} · ${im.packed ? 'packed' : im.missing ? '<span style="color:var(--bad)">missing</span>' : 'linked'}</span></div>`).join('')}` : ''}
    <p class="tiny" style="margin:10px 0 0">${esc(r.path || '')}</p></div>`;
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
  const rep = obj.userData.blend;
  const mm = unitScale(st.size, rep?.units?.mmPerUnit);
  let verts = 0; const mats = new Set(), tex = new Set();
  obj.traverse((o) => {
    if (!o.isMesh || !shown(o, obj)) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { mats.add(m); for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) if (m[k]) tex.add(m[k]); });
    verts += o.geometry.attributes.position.count;
  });
  const ec = edgeCheck(obj);
  return {
    tris: st.tris, verts, materials: mats.size, textures: tex.size, units: rep ? `Blender ${rep.units.length.toLowerCase()}` : mm === 1000 ? 'metres (glTF)' : mm === 10 ? 'centimetres' : 'millimetres',
    size: [st.size.x * mm, st.size.z * mm, st.size.y * mm], volumeCm3: (st.vol * mm ** 3) / 1000, openEdges: ec.checked ? ec.open + ec.multi : null,
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
        ${row('File name', esc(m.name))}${row('Format', m.ext === 'blend' ? 'Blender (.blend)' : m.ext.toUpperCase())}${row('Size', (m.size / 1048576).toFixed(2) + ' MB')}${row('Added / changed', m.modified ? new Date(m.modified).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '')}
        ${row('Location', '<span class="tiny">' + esc(m.path) + '</span>')}
        ${job ? row('Order', `${esc(job.code)} · ${esc(job.customer || 'Unnamed')} · ${esc(job.occasion)}`) + row('Order stage', esc(job.stage)) : ''}
        <div id="iBlend"></div>
        ${k ? `<h4 style="margin:12px 0 4px">Part kit</h4>${row('Type', esc(k.kind))}${row('Category', esc(k.category || ''))}${row('Made on body', k.kind === 'Part' && k.category === 'outfit' ? esc(((kitCache.bodies || []).find((b) => b.id === k.body) || { name: kitCache.base.name }).name) : '')}
          ${row('Solid volume', k.volumeMm3 || k.stats?.volumeMm3 ? (((k.volumeMm3 || k.stats.volumeMm3) / 1000).toFixed(2) + ' cm³') : '')}${row('Body stretch to master neck', k.stretch ? '×' + k.stretch : '')}
          ${k.stats ? row('Thinner than printer minimum', Math.round(k.stats.thinShare * 100) + '% (' + esc(k.stats.style || '') + ')') + row('Recovered by colour', k.stats.rescuedMm3 ? (k.stats.rescuedMm3 / 1000).toFixed(2) + ' cm³' : '') + row('Head fit', k.stats.fit ? k.stats.fit.shiftMm.join(', ') + ' mm · ×' + k.stats.fit.scale + ' · ' + Math.round(k.stats.fit.agreement * 100) + '% match' : '') : ''}
          ${row('Created', k.created ? fmtDate(k.created) : '')}${row('Source', src ? (src.startsWith('http') ? `<a href="${esc(src)}" target="_blank">${esc(src.split('/').pop())}</a>` : esc(src)) : '')}` : ''}
      </div>
      <div><h4 style="margin:4px 0">Geometry</h4><div id="iGeo"><span class="spin"></span> <span class="small muted">${m.ext === 'blend' ? 'Reading the Blender file…' : 'Measuring…'}</span></div>
        <label class="f" style="margin-top:12px">Notes<textarea class="in" id="iNote" placeholder="What is this model, what needs fixing, where it came from…">${esc(state.db.modelNotes[m.path] || '')}</textarea></label></div>
    </div>
    <div class="row" style="margin-top:12px"><button class="btn" id="iFolder">Open folder</button>${m.ext === 'blend' ? '<button class="btn" id="iBlender">Open in Blender</button>' : ''}<span class="grow"></span><button class="btn primary" id="iLoad">Load in viewer</button></div></div>`, async (box, close) => {
    $('#iNote', box).onchange = (e) => { state.db.modelNotes[m.path] = e.target.value; save(); toast('Note saved'); };
    $('#iFolder', box).onclick = () => api('/api/open?path=' + encodeURIComponent(m.path.split('/').slice(0, -1).join('/')), { method: 'POST' });
    $('#iBlender', box) && ($('#iBlender', box).onclick = () => api('/api/blend/open?path=' + encodeURIComponent(m.path), { method: 'POST' }).then(() => toast('Opening in Blender…')).catch((e) => toast(e.message, true)));
    $('#iLoad', box).onclick = () => { close(); onLoad(m.url, m.name); };
    try {
      const obj = await loadObject(m.url, m.name);
      const g = geometryReport(obj), r = obj.userData.blend;
      if (r && $('#iBlend', box)) $('#iBlend', box).innerHTML = `<h4 style="margin:12px 0 4px">Blender</h4>${row('Saved with', 'Blender ' + esc(r.savedWith))}${row('Objects', (r.counts?.objects || 0) + ' (' + r.objects.filter((o) => !o.visible).length + ' hidden)')}${row('Materials / images', (r.counts?.materials || 0) + ' / ' + (r.counts?.images || 0))}${row('Warnings', r.warnings.length ? `<span style="color:var(--warn)">${r.warnings.length}</span>` : 'None')}`;
      const el = $('#iGeo', box); if (!el) return;
      el.innerHTML = row('Size (W × D × H)', g.size.map((x) => x.toFixed(1)).join(' × ') + ' mm') + row('Units in file', g.units) + row('Triangles', g.tris.toLocaleString()) + row('Vertices', g.verts.toLocaleString())
        + row('Solid volume', g.volumeCm3.toFixed(2) + ' cm³') + row('Materials / textures', g.materials + ' / ' + g.textures)
        + row('Watertight (printable as is)', g.openEdges === null ? 'not checked (too large)' : g.openEdges === 0 ? '<span style="color:var(--ok)">Yes</span>' : `<span style="color:var(--warn)">No — ${g.openEdges.toLocaleString()} open edges</span>`)
        + (r ? '<p class="tiny">Visible objects only, with modifiers applied.</p>' : '');
    } catch (e) { const el = $('#iGeo', box); if (el) el.innerHTML = `<span class="small" style="color:var(--bad)">Couldn't read the model: ${esc(e.message)}</span>`; }
  });
}
