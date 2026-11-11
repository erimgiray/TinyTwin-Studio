// TinyTwin "snap to spec" engine — pure JS, works in the browser and in Node.
// Meshes: { pos: Float32Array xyz, idx: Uint32Array, col?: Uint8Array rgb per vertex } in millimetres, Y up.
import { edgeTable, triTable } from 'three/examples/jsm/objects/MarchingCubes.js';

export const DEFAULT_PITCH = 0.3; // mm per voxel

// ---------- basic mesh helpers ----------
export function bounds(m) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.pos.length; i += 3) for (let a = 0; a < 3; a++) { const v = m.pos[i + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
  return { min: mn, max: mx };
}
export function transform(m, s, t) {
  const pos = new Float32Array(m.pos.length);
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) pos[i + a] = m.pos[i + a] * s + t[a];
  return { ...m, pos };
}
export function signedVolume(m) {
  let v = 0; const p = m.pos, f = m.idx;
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

// ---------- slicing measurements ----------
function slices(m, n = 200) {
  const b = bounds(m), h = b.max[1] - b.min[1];
  const s = Array.from({ length: n }, () => ({ x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, c: 0 }));
  for (let i = 0; i < m.pos.length; i += 3) {
    const k = Math.min(n - 1, Math.floor(((m.pos[i + 1] - b.min[1]) / h) * n));
    const q = s[k], x = m.pos[i], z = m.pos[i + 2];
    if (x < q.x0) q.x0 = x; if (x > q.x1) q.x1 = x; if (z < q.z0) q.z0 = z; if (z > q.z1) q.z1 = z; q.c++;
  }
  return { b, h, n, s: s.map((q, k) => ({ ...q, y: b.min[1] + ((k + 0.5) / n) * h, w: q.c ? q.x1 - q.x0 : 0, d: q.c ? q.z1 - q.z0 : 0 })) };
}

// Plinth = the wide disc at the bottom. Returns its diameter, height and centre.
export function findPlinth(m) {
  const b0 = bounds(m), H = b0.max[1] - b0.min[1];
  const { b, s } = voxSlices(m, H / 250);
  const filled = s.filter((q) => q.c);
  const base = filled.slice(0, 4);
  const dia = Math.max(...base.map((q) => (q.w + q.d) / 2));
  let topIdx = filled.findIndex((q, k) => k > 1 && (q.w + q.d) / 2 < dia * 0.75);
  if (topIdx < 0) topIdx = Math.min(filled.length - 1, 10);
  const bot = filled.slice(0, Math.max(1, topIdx));
  const cx = bot.reduce((a, q) => a + (q.x0 + q.x1) / 2, 0) / bot.length;
  const cz = bot.reduce((a, q) => a + (q.z0 + q.z1) / 2, 0) / bot.length;
  return { diameter: dia, height: filled[topIdx].y - b.min[1], bottom: b.min[1], cx, cz };
}

// Scale/translate so the plinth sits at the origin. Either target the base's plinth diameter
// (so every part lines up with the base) or, for the base itself, a total height.
export function normalize(m, target) {
  const p = findPlinth(m), b = bounds(m);
  const s = target.plinthDiameter ? target.plinthDiameter / p.diameter : target.height / (b.max[1] - b.min[1]);
  return { mesh: transform(m, s, [-p.cx * s, -p.bottom * s, -p.cz * s]), scale: s };
}

// Measurements that define the design system, taken from the normalised base.
function voxSlices(m, pitch = 0.5) {
  const b = bounds(m), g = makeGrid(b, pitch, 1), v = voxelize(m, g), [nx, ny, nz] = g.n;
  const s = [];
  for (let j = 0; j < ny; j++) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, c = 0;
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) if (v[at(g, i, j, k)]) { c++; if (i < x0) x0 = i; if (i > x1) x1 = i; if (k < z0) z0 = k; if (k > z1) z1 = k; }
    const X = (i) => g.min[0] + (i + 0.5) * pitch, Z = (k) => g.min[2] + (k + 0.5) * pitch;
    s.push({ c, y: g.min[1] + (j + 0.5) * pitch, x0: X(x0), x1: X(x1), z0: Z(z0), z1: Z(z1), w: c ? (x1 - x0 + 1) * pitch : 0, d: c ? (z1 - z0 + 1) * pitch : 0 });
  }
  return { b, s };
}

export function measureBase(m) {
  const p = findPlinth(m);
  const { b, s } = voxSlices(m);
  const top = b.max[1];
  // head: widest slice in the upper half; neck: narrowest slice between head and shoulders
  const upper = s.filter((q) => q.c && q.y > (p.height + top) / 2);
  const headMax = upper.reduce((a, q) => (q.w > a.w ? q : a), upper[0]);
  const below = s.filter((q) => q.c && q.y < headMax.y && q.y > p.height + (top - p.height) * 0.3);
  const neck = below.reduce((a, q) => (q.w < a.w ? q : a), below[below.length - 1]);
  const body = s.filter((q) => q.c && q.y > p.height + 1 && q.y < neck.y);
  const shoulder = body.reduce((a, q) => (q.w > a.w ? q : a), body[0]);
  const headSl = s.filter((q) => q.c && q.y >= neck.y);
  const head = {
    bottom: neck.y, top, height: top - neck.y,
    width: Math.max(...headSl.map((q) => q.w)), depth: Math.max(...headSl.map((q) => q.d)),
    front: Math.max(...headSl.map((q) => q.z1)), back: Math.min(...headSl.map((q) => q.z0)),
  };
  head.eyeLine = neck.y + head.height * 0.42;
  head.eyeLineSource = 'estimated';
  if (m.col) {
    // eyes = the band with most dark vertices on the front of the face
    const bins = new Map();
    for (let i = 0; i < m.pos.length / 3; i++) {
      const y = m.pos[i * 3 + 1], z = m.pos[i * 3 + 2];
      if (y < neck.y + head.height * 0.15 || y > neck.y + head.height * 0.8 || z < head.front - 8) continue;
      const l = 0.3 * m.col[i * 3] + 0.59 * m.col[i * 3 + 1] + 0.11 * m.col[i * 3 + 2];
      if (l > 75) continue;
      const b = Math.round(y); bins.set(b, (bins.get(b) || 0) + 1);
    }
    let best = null, bc = 0;
    for (const [b] of bins) { const c = (bins.get(b - 1) || 0) + bins.get(b) + (bins.get(b + 1) || 0); if (c > bc) { bc = c; best = b; } }
    if (best !== null && bc > 40) { head.eyeLine = best; head.eyeLineSource = 'from colours'; }
  }
  head.centerZ = (head.front + head.back) / 2;
  return {
    units: 'mm', height: top - b.min[1],
    plinth: { diameter: +p.diameter.toFixed(2), height: +p.height.toFixed(2) },
    head: Object.fromEntries(Object.entries(head).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v])),
    shoulders: { y: +shoulder.y.toFixed(2), width: +shoulder.w.toFixed(2), depth: +shoulder.d.toFixed(2) },
    body: { bottom: +p.height.toFixed(2), top: +neck.y.toFixed(2) },
  };
}

// Where each part category is allowed to live (mm, base frame). Generated parts are clipped to these.
export function anchorBoxes(M) {
  const H = M.head, hw = H.width / 2;
  return {
    hair: { min: [-hw - 10, H.bottom - 4, H.back - 14], max: [hw + 10, H.top + 30, H.front + 3], label: 'Hair' },
    headwear: { min: [-hw - 14, H.eyeLine + 2, H.back - 16], max: [hw + 14, H.top + 30, H.front + 16], label: 'Headwear' },
    glasses: { min: [-hw - 3, H.eyeLine - H.height * 0.26, H.centerZ - 2], max: [hw + 3, H.eyeLine + H.height * 0.24, H.front + 10], label: 'Glasses' },
    facialHair: { min: [-hw, H.bottom - 6, H.centerZ], max: [hw, H.eyeLine - 2, H.front + 8], label: 'Facial hair' },
    outfit: { min: [-M.shoulders.width / 2 - 15, M.plinth.height + 0.5, -M.shoulders.depth / 2 - 15], max: [M.shoulders.width / 2 + 15, H.bottom + 3, M.shoulders.depth / 2 + 15], label: 'Outfit' },
  };
}

// ---------- voxels ----------
export function makeGrid(box, pitch = DEFAULT_PITCH, pad = 2) {
  const min = box.min.map((v) => v - pad * pitch);
  const n = box.max.map((v, a) => Math.max(1, Math.ceil((v - min[a]) / pitch) + pad));
  return { min, pitch, n, size: n[0] * n[1] * n[2] };
}
const at = (g, i, j, k) => (k * g.n[1] + j) * g.n[0] + i;

// Inside test by ray parity along all three axes, majority vote (tolerates small holes in AI meshes).
export function voxelize(m, g) {
  const votes = new Uint8Array(g.size);
  const P = m.pos, F = m.idx, [nx, ny, nz] = g.n, p = g.pitch;
  for (let ax = 0; ax < 3; ax++) {
    const u = (ax + 1) % 3, v = (ax + 2) % 3, nu = g.n[u], nv = g.n[v], nw = g.n[ax];
    const hits = Array.from({ length: nu * nv }, () => null);
    for (let t = 0; t < F.length; t += 3) {
      const a = F[t] * 3, b = F[t + 1] * 3, c = F[t + 2] * 3;
      const au = (P[a + u] - g.min[u]) / p - 0.5, av = (P[a + v] - g.min[v]) / p - 0.5;
      const bu = (P[b + u] - g.min[u]) / p - 0.5, bv = (P[b + v] - g.min[v]) / p - 0.5;
      const cu = (P[c + u] - g.min[u]) / p - 0.5, cv = (P[c + v] - g.min[v]) / p - 0.5;
      const i0 = Math.max(0, Math.ceil(Math.min(au, bu, cu))), i1 = Math.min(nu - 1, Math.floor(Math.max(au, bu, cu)));
      const j0 = Math.max(0, Math.ceil(Math.min(av, bv, cv))), j1 = Math.min(nv - 1, Math.floor(Math.max(av, bv, cv)));
      if (i0 > i1 || j0 > j1) continue;
      const det = (bv - cv) * (au - cu) + (cu - bu) * (av - cv);
      if (Math.abs(det) < 1e-12) continue;
      const aw = (P[a + ax] - g.min[ax]) / p - 0.5, bw = (P[b + ax] - g.min[ax]) / p - 0.5, cw = (P[c + ax] - g.min[ax]) / p - 0.5;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const l1 = ((bv - cv) * (i - cu) + (cu - bu) * (j - cv)) / det;
        const l2 = ((cv - av) * (i - cu) + (au - cu) * (j - cv)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const w = l1 * aw + l2 * bw + l3 * cw;
        const key = j * nu + i;
        (hits[key] ||= []).push(w);
      }
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const hs = hits[j * nu + i];
      if (!hs || hs.length < 2) continue;
      hs.sort((x, y) => x - y);
      // merge near-duplicate hits (shared edges/vertices) to keep parity correct
      const q = [hs[0]];
      for (let r = 1; r < hs.length; r++) if (hs[r] - q[q.length - 1] > 1e-4) q.push(hs[r]);
      for (let r = 0; r + 1 < q.length; r += 2) {
        const w0 = Math.max(0, Math.ceil(q[r])), w1 = Math.min(nw - 1, Math.floor(q[r + 1]));
        for (let w = w0; w <= w1; w++) {
          const c = [0, 0, 0]; c[ax] = w; c[u] = i; c[v] = j;
          votes[at(g, c[0], c[1], c[2])]++;
        }
      }
    }
  }
  const out = new Uint8Array(g.size);
  for (let i = 0; i < g.size; i++) out[i] = votes[i] >= 2 ? 1 : 0;
  return out;
}

// Cube dilation by r voxels (separable running window).
export function dilate(src, g, r) {
  if (r <= 0) return src.slice();
  let cur = src;
  for (let ax = 0; ax < 3; ax++) {
    const out = new Uint8Array(g.size), n = g.n[ax];
    const stride = ax === 0 ? 1 : ax === 1 ? g.n[0] : g.n[0] * g.n[1];
    const o1 = (ax + 1) % 3, o2 = (ax + 2) % 3;
    for (let b2 = 0; b2 < g.n[o2]; b2++) for (let b1 = 0; b1 < g.n[o1]; b1++) {
      const c = [0, 0, 0]; c[o1] = b1; c[o2] = b2;
      const base = at(g, c[0], c[1], c[2]);
      let cnt = 0;
      for (let w = 0; w < Math.min(r, n); w++) cnt += cur[base + w * stride];
      for (let w = 0; w < n; w++) {
        if (w + r < n) cnt += cur[base + (w + r) * stride];
        if (w - r - 1 >= 0) cnt -= cur[base + (w - r - 1) * stride];
        out[base + w * stride] = cnt > 0 ? 1 : 0;
      }
    }
    cur = out;
  }
  return cur;
}
export function erode(src, g, r) {
  const inv = new Uint8Array(g.size);
  for (let i = 0; i < g.size; i++) inv[i] = 1 - src[i];
  const d = dilate(inv, g, r);
  for (let i = 0; i < g.size; i++) d[i] = 1 - d[i];
  return d;
}
export const count = (v) => { let c = 0; for (let i = 0; i < v.length; i++) c += v[i]; return c; };

// Remove islands smaller than minVox (6-connected).
export function islands(v, g) {
  const lab = new Int32Array(g.size), q = new Int32Array(g.size), sizes = [0];
  const [nx, ny] = g.n, sxy = nx * ny;
  for (let s = 0; s < g.size; s++) {
    if (!v[s] || lab[s]) continue;
    const id = sizes.length; let h = 0, t = 0; q[t++] = s; lab[s] = id;
    while (h < t) {
      const c = q[h++], i = c % nx, j = ((c / nx) | 0) % ny, k = (c / sxy) | 0;
      const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1, k > 0 ? c - sxy : -1, k < g.n[2] - 1 ? c + sxy : -1];
      for (const d of nb) if (d >= 0 && v[d] && !lab[d]) { lab[d] = id; q[t++] = d; }
    }
    sizes.push(t);
  }
  return { lab, sizes };
}
// Fill sealed internal air pockets (empty voxels not connected to the outside).
export function fillCavities(v, g) {
  const out = v.slice(), seen = new Uint8Array(g.size), q = new Int32Array(g.size);
  const [nx, ny, nz] = g.n, sxy = nx * ny;
  let h = 0, t = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i && j && k && i < nx - 1 && j < ny - 1 && k < nz - 1) continue;
    const c = at(g, i, j, k); if (!v[c] && !seen[c]) { seen[c] = 1; q[t++] = c; }
  }
  while (h < t) {
    const c = q[h++], i = c % nx, j = ((c / nx) | 0) % ny, k = (c / sxy) | 0;
    const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1, k > 0 ? c - sxy : -1, k < nz - 1 ? c + sxy : -1];
    for (const d of nb) if (d >= 0 && !v[d] && !seen[d]) { seen[d] = 1; q[t++] = d; }
  }
  for (let i = 0; i < g.size; i++) if (!v[i] && !seen[i]) out[i] = 1;
  return out;
}

export function keepLargest(v, g) {
  const { lab, sizes } = islands(v, g);
  let best = 0; for (let i = 1; i < sizes.length; i++) if (sizes[i] > (sizes[best] || 0)) best = i;
  const out = new Uint8Array(g.size); for (let i = 0; i < g.size; i++) out[i] = lab[i] === best && best ? 1 : 0;
  return out;
}

export function keepIslands(v, g, minVox) {
  const lab = new Int32Array(g.size), q = new Int32Array(g.size), out = new Uint8Array(g.size);
  const [nx, ny] = g.n, sxy = nx * ny;
  let id = 0;
  for (let s = 0; s < g.size; s++) {
    if (!v[s] || lab[s]) continue;
    id++; let h = 0, t = 0; q[t++] = s; lab[s] = id;
    while (h < t) {
      const c = q[h++], i = c % nx, j = ((c / nx) | 0) % ny, k = (c / sxy) | 0;
      const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1, k > 0 ? c - sxy : -1, k < g.n[2] - 1 ? c + sxy : -1];
      for (const d of nb) if (d >= 0 && v[d] && !lab[d]) { lab[d] = id; q[t++] = d; }
    }
    if (t >= minVox) for (let r = 0; r < t; r++) out[q[r]] = 1;
  }
  return out;
}
function boxMask(g, box) {
  const m = new Uint8Array(g.size);
  const lo = box.min.map((x, a) => Math.max(0, Math.floor((x - g.min[a]) / g.pitch))), hi = box.max.map((x, a) => Math.min(g.n[a] - 1, Math.ceil((x - g.min[a]) / g.pitch)));
  for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) m[at(g, i, j, k)] = 1;
  return m;
}

// ---------- surface extraction ----------
function blur(v, g) {
  let a = Float32Array.from(v);
  for (let ax = 0; ax < 3; ax++) {
    const b = new Float32Array(g.size), stride = ax === 0 ? 1 : ax === 1 ? g.n[0] : g.n[0] * g.n[1], n = g.n[ax];
    for (let idx = 0; idx < g.size; idx++) {
      const w = ax === 0 ? idx % g.n[0] : ax === 1 ? ((idx / g.n[0]) | 0) % g.n[1] : (idx / (g.n[0] * g.n[1])) | 0;
      const l = w > 0 ? a[idx - stride] : 0, r = w < n - 1 ? a[idx + stride] : 0;
      b[idx] = 0.25 * l + 0.5 * a[idx] + 0.25 * r;
    }
    a = b;
  }
  return a;
}
const CORNER = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const EDGE = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

export function marchingCubes(field, g, iso = 0.5) {
  const [nx, ny, nz] = g.n, p = g.pitch;
  const pos = [], idx = [], vmap = new Map();
  const ev = new Int32Array(12);
  const val = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let ci = 0;
    for (let c = 0; c < 8; c++) {
      val[c] = field[at(g, i + CORNER[c][0], j + CORNER[c][1], k + CORNER[c][2])];
      if (val[c] < iso) ci |= 1 << c;
    }
    const em = edgeTable[ci];
    if (!em) continue;
    for (let e = 0; e < 12; e++) {
      if (!(em & (1 << e))) continue;
      const [a, b] = EDGE[e];
      const A = CORNER[a], B = CORNER[b];
      const ga = [i + A[0], j + A[1], k + A[2]], gb = [i + B[0], j + B[1], k + B[2]];
      const lo = ga.map((x, d) => Math.min(x, gb[d])), axis = ga[0] !== gb[0] ? 0 : ga[1] !== gb[1] ? 1 : 2;
      const key = at(g, lo[0], lo[1], lo[2]) * 3 + axis;
      let vi = vmap.get(key);
      if (vi === undefined) {
        const t = (iso - val[a]) / (val[b] - val[a] || 1e-9);
        vi = pos.length / 3;
        pos.push(g.min[0] + (ga[0] + t * (gb[0] - ga[0])) * p, g.min[1] + (ga[1] + t * (gb[1] - ga[1])) * p, g.min[2] + (ga[2] + t * (gb[2] - ga[2])) * p);
        vmap.set(key, vi);
      }
      ev[e] = vi;
    }
    for (let t = ci * 16; triTable[t] !== -1; t += 3) idx.push(ev[triTable[t]], ev[triTable[t + 1]], ev[triTable[t + 2]]);
  }
  const m = { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
  if (signedVolume(m) < 0) for (let t = 0; t < m.idx.length; t += 3) { const x = m.idx[t + 1]; m.idx[t + 1] = m.idx[t + 2]; m.idx[t + 2] = x; }
  return m;
}

// Copy colours from the source mesh onto new vertices (nearest source vertex, 1 mm hash grid).
export function colorize(out, src, fallback = [200, 170, 140]) {
  const col = new Uint8Array((out.pos.length / 3) * 3);
  if (!src?.col) { for (let i = 0; i < col.length; i += 3) col.set(fallback, i); return { ...out, col }; }
  const cell = 1.0, grid = new Map(), key = (x, y, z) => `${x},${y},${z}`;
  for (let i = 0; i < src.pos.length / 3; i++) {
    const k = key(Math.floor(src.pos[i * 3] / cell), Math.floor(src.pos[i * 3 + 1] / cell), Math.floor(src.pos[i * 3 + 2] / cell));
    let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i);
  }
  for (let v = 0; v < out.pos.length / 3; v++) {
    const x = out.pos[v * 3], y = out.pos[v * 3 + 1], z = out.pos[v * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= 3 && best < 0; r++)
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let c = -r; c <= r; c++) {
        const l = grid.get(key(cx + a, cy + b, cz + c)); if (!l) continue;
        for (const i of l) { const dx = src.pos[i * 3] - x, dy = src.pos[i * 3 + 1] - y, dz = src.pos[i * 3 + 2] - z, d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = i; } }
      }
    col.set(best >= 0 ? [src.col[best * 3], src.col[best * 3 + 1], src.col[best * 3 + 2]] : fallback, v * 3);
  }
  return { ...out, col };
}

// ---------- pipeline steps ----------

// Watertight, coloured copy of any mesh (used for the base and for print export).
export function solidify(m, pitch = DEFAULT_PITCH) {
  const g = makeGrid(bounds(m), pitch, 3);
  const v = fillCavities(keepIslands(voxelize(m, g), g, 50), g);
  return { mesh: colorize(marchingCubes(blur(v, g), g), m), vox: v, grid: g };
}

// Turn a generated "base + part" model into just the part, fused into the base.
// base, pob: normalised meshes; box: anchor box; opts: { pitch, gapMm, fuseMm, minIslandMm3, thinMm }
export function extractPart(base, pob, box, opts = {}) {
  const pitch = opts.pitch || DEFAULT_PITCH;
  const g = makeGrid(box, pitch, 4);
  const B = voxelize(base, g), P = voxelize(pob, g);
  const clear = Math.max(1, Math.round((opts.gapMm ?? 0.6) / pitch));
  const Bd = dilate(B, g, clear);
  const inBox = boxMask(g, box);
  let part = new Uint8Array(g.size);
  for (let i = 0; i < g.size; i++) part[i] = P[i] && !Bd[i] && inBox[i] ? 1 : 0;
  // Colour rescue: where the two AI models' bodies disagree, the shape test cuts too much
  // (e.g. glasses rims sitting over eyes that bulge more on the base). Keep ambiguous voxels whose
  // colour matches the part's own colour AND differs from the base's colour at that spot.
  let rescued = 0;
  if (pob.col && base.col && opts.colorRescue !== false) rescued = colourRescue(base, pob, g, P, Bd, inBox, part, opts.colorTol ?? 45);
  // open slightly to drop skin-difference speckles, then drop small islands
  part = dilate(erode(part, g, 1), g, 1);
  const minVox = Math.round((opts.minIslandMm3 ?? 4) / pitch ** 3);
  part = keepIslands(part, g, minVox);
  const partVox = count(part);
  // fuse: grow the part back down into the base so it overlaps the body (prints as one piece)
  const fuse = dilate(part, g, clear + Math.max(1, Math.round((opts.fuseMm ?? 1) / pitch)));
  const solid = new Uint8Array(g.size);
  for (let i = 0; i < g.size; i++) solid[i] = part[i] || (fuse[i] && B[i]) ? 1 : 0;
  // thin-feature check for the chosen print style
  const r = Math.max(1, Math.round((opts.thinMm ?? 2) / 2 / pitch));
  const opened = dilate(erode(part, g, r), g, r);
  let thin = 0;
  for (let i = 0; i < g.size; i++) if (part[i] && !opened[i]) thin++;
  const mesh = partVox ? colorize(marchingCubes(blur(solid, g), g), pob) : { pos: new Float32Array(), idx: new Uint32Array(), col: new Uint8Array() };
  return {
    mesh,
    stats: { rescuedMm3: +(rescued * pitch ** 3).toFixed(1), volumeMm3: +(partVox * pitch ** 3).toFixed(1), thinShare: partVox ? +(thin / partVox).toFixed(3) : 0, triangles: mesh.idx.length / 3, pitch },
  };
}

// One watertight body from base + parts, for printing.
export function unionForPrint(meshes, pitch = 0.25) {
  const all = meshes.map(bounds);
  const box = { min: [0, 1, 2].map((a) => Math.min(...all.map((b) => b.min[a]))), max: [0, 1, 2].map((a) => Math.max(...all.map((b) => b.max[a]))) };
  const g = makeGrid(box, pitch, 3);
  const v = new Uint8Array(g.size);
  for (const m of meshes) { const x = voxelize(m, g); for (let i = 0; i < g.size; i++) v[i] |= x[i]; }
  const solid = fillCavities(keepIslands(v, g, Math.round(1 / pitch ** 3)), g); // drop specks under 1 mm³, fill air pockets
  const pieces = islands(solid, g).sizes.length - 1;
  return { mesh: marchingCubes(blur(solid, g), g), volumeMm3: count(solid) * pitch ** 3, pieces };
}

export function toSTL(m, zUp = true) {
  const n = m.idx.length / 3, buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  dv.setUint32(80, n, true);
  const P = m.pos, F = m.idx;
  const get = (i) => (zUp ? [P[i * 3], -P[i * 3 + 2], P[i * 3 + 1]] : [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
  for (let t = 0; t < n; t++) {
    const a = get(F[t * 3]), b = get(F[t * 3 + 1]), c = get(F[t * 3 + 2]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...nn) || 1;
    let o = 84 + t * 50;
    for (const x of [...nn.map((x) => x / l), ...a, ...b, ...c]) { dv.setFloat32(o, x, true); o += 4; }
  }
  return buf;
}

// ---------- clean-up for display / storage ----------

// Taubin smoothing: removes voxel ripples without shrinking the shape.
export function taubin(m, iters = 6, lambda = 0.5, mu = -0.53) {
  const nv = m.pos.length / 3, F = m.idx;
  const deg = new Uint32Array(nv + 1);
  for (let t = 0; t < F.length; t += 3) for (let e = 0; e < 3; e++) { deg[F[t + e]] += 2; }
  const off = new Uint32Array(nv + 1);
  for (let i = 0; i < nv; i++) off[i + 1] = off[i] + deg[i];
  const nb = new Uint32Array(off[nv]), fill = off.slice(0, nv);
  for (let t = 0; t < F.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = F[t + e], b = F[t + ((e + 1) % 3)], c = F[t + ((e + 2) % 3)];
    nb[fill[a]++] = b; nb[fill[a]++] = c;
  }
  let p = Float32Array.from(m.pos);
  const tmp = new Float32Array(p.length);
  for (let it = 0; it < iters * 2; it++) {
    const f = it % 2 ? mu : lambda;
    for (let i = 0; i < nv; i++) {
      const s = off[i], e = off[i + 1];
      if (e === s) { tmp[i * 3] = p[i * 3]; tmp[i * 3 + 1] = p[i * 3 + 1]; tmp[i * 3 + 2] = p[i * 3 + 2]; continue; }
      let x = 0, y = 0, z = 0;
      for (let k = s; k < e; k++) { const n = nb[k] * 3; x += p[n]; y += p[n + 1]; z += p[n + 2]; }
      const c = e - s;
      tmp[i * 3] = p[i * 3] + f * (x / c - p[i * 3]);
      tmp[i * 3 + 1] = p[i * 3 + 1] + f * (y / c - p[i * 3 + 1]);
      tmp[i * 3 + 2] = p[i * 3 + 2] + f * (z / c - p[i * 3 + 2]);
    }
    p.set(tmp);
  }
  return { ...m, pos: p };
}

// Reduce triangle count (meshoptimizer), keeping per-vertex colours.
export async function simplify(m, targetTris) {
  if (m.idx.length / 3 <= targetTris) return m;
  const { MeshoptSimplifier: S } = await import('meshoptimizer');
  await S.ready;
  const [idx] = S.simplify(m.idx, m.pos, 3, targetTris * 3, 0.002, []);
  const remap = new Int32Array(m.pos.length / 3).fill(-1);
  let n = 0;
  for (const i of idx) if (remap[i] < 0) remap[i] = n++;
  const pos = new Float32Array(n * 3), col = m.col ? new Uint8Array(n * 3) : undefined;
  for (let i = 0; i < remap.length; i++) if (remap[i] >= 0) {
    pos.set(m.pos.subarray(i * 3, i * 3 + 3), remap[i] * 3);
    if (col) col.set(m.col.subarray(i * 3, i * 3 + 3), remap[i] * 3);
  }
  return { pos, idx: Uint32Array.from(idx, (i) => remap[i]), col };
}

// Rotate about the vertical axis by a multiple of 90° (to fix models that face the wrong way).
export function yaw(m, quarterTurns) {
  const q = ((quarterTurns % 4) + 4) % 4;
  if (!q) return m;
  const pos = new Float32Array(m.pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    let x = m.pos[i], z = m.pos[i + 2];
    for (let r = 0; r < q; r++) { const t = x; x = z; z = -t; }
    pos[i] = x; pos[i + 1] = m.pos[i + 1]; pos[i + 2] = z;
  }
  return { ...m, pos };
}

// ---------- head refinement ----------
// AI models of the same figure differ by a few mm at the head even when the plinths line up.
// Fit the part model's head to the base head (shift + small uniform scale), using only the
// head area OUTSIDE the part's anchor box (so the part itself doesn't skew the fit).
export function refineToBase(base, pob, M, box) {
  const H = M.head;
  const region = { min: [-H.width / 2 - 6, H.bottom - 3, H.back - 6], max: [H.width / 2 + 6, H.top + 4, H.front + 6] };
  const centre = [0, (H.bottom + H.top) / 2, H.centerZ];
  const inBox = (x, y, z) => x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1] && z >= box.min[2] && z <= box.max[2];
  const scaled = (m, s) => { const pos = new Float32Array(m.pos.length); for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) pos[i + a] = centre[a] + (m.pos[i + a] - centre[a]) * s; return { ...m, pos }; };
  const search = (pitch, scales, maxShift, seed) => {
    const g = makeGrid(region, pitch, maxShift + 1);
    const B = voxelize(base, g);
    // surface band of the base, outside the anchor box
    const band = [];
    const [nx, ny, nz] = g.n;
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const c = at(g, i, j, k), v = B[c];
      if (v === B[c + 1] && v === B[c - 1] && v === B[c + nx] && v === B[c - nx] && v === B[c + nx * ny] && v === B[c - nx * ny]) continue;
      const x = g.min[0] + (i + 0.5) * pitch, y = g.min[1] + (j + 0.5) * pitch, z = g.min[2] + (k + 0.5) * pitch;
      if (!inBox(x, y, z)) band.push(i, j, k, v);
    }
    let best = { score: -1 };
    for (const s of scales) {
      const P = voxelize(scaled(seed ? transform(pob, 1, seed.t) : pob, s), g);
      for (let dz = -maxShift; dz <= maxShift; dz++) for (let dy = -maxShift; dy <= maxShift; dy++) for (let dx = -maxShift; dx <= maxShift; dx++) {
        let score = 0;
        for (let b = 0; b < band.length; b += 4) {
          const i = band[b] + dx, j = band[b + 1] + dy, k = band[b + 2] + dz;
          if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
          if (P[at(g, i, j, k)] === band[b + 3]) score++;
        }
        if (score > best.score) best = { score, s, d: [-dx * pitch, -dy * pitch, -dz * pitch], n: band.length / 4 };
      }
    }
    return best;
  };
  // coarse: 1 mm voxels, ±6 mm, scale ±6 %; fine: 0.4 mm voxels, ±1.2 mm around it
  const c = search(1.0, [0.94, 0.97, 1.0, 1.03, 1.06], 6);
  const pre = (m) => { const sm = scaled(m, c.s); return transform(sm, 1, c.d); };
  const coarseMesh = pre(pob);
  const f = (() => { const save = pob; pob = coarseMesh; const r = search(0.4, [0.99, 1.0, 1.01], 3); pob = save; return r; })();
  const s = c.s * f.s;
  const fitted = transform(scaled(coarseMesh, f.s), 1, f.d);
  return { mesh: fitted, scale: +s.toFixed(4), shift: c.d.map((v, a) => +(v + f.d[a]).toFixed(2)), agreement: +(f.score / Math.max(1, f.n)).toFixed(3) };
}

function hashVerts(m, cell) {
  const grid = new Map();
  for (let i = 0; i < m.pos.length / 3; i++) {
    const k = `${Math.floor(m.pos[i * 3] / cell)},${Math.floor(m.pos[i * 3 + 1] / cell)},${Math.floor(m.pos[i * 3 + 2] / cell)}`;
    let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i);
  }
  return (x, y, z, maxD) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = -1, bd = maxD * maxD;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const l = grid.get(`${cx + a},${cy + b},${cz + c}`); if (!l) continue;
      for (const i of l) { const dx = m.pos[i * 3] - x, dy = m.pos[i * 3 + 1] - y, dz = m.pos[i * 3 + 2] - z, d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = i; } }
    }
    return best;
  };
}
const cdist = (c, i, r, g, b) => Math.hypot(c[i * 3] - r, c[i * 3 + 1] - g, c[i * 3 + 2] - b);

function colourRescue(base, pob, g, P, Bd, inBox, part, tol) {
  const p = g.pitch, [nx, ny] = g.n;
  const nearP = hashVerts(pob, 1.0), nearB = hashVerts(base, 1.5);
  // 1. the part's own colours: pob vertices inside clearly-kept part voxels
  const samples = [];
  for (let i = 0; i < pob.pos.length / 3; i++) {
    const vi = Math.floor((pob.pos[i * 3] - g.min[0]) / p), vj = Math.floor((pob.pos[i * 3 + 1] - g.min[1]) / p), vk = Math.floor((pob.pos[i * 3 + 2] - g.min[2]) / p);
    if (vi < 0 || vj < 0 || vk < 0 || vi >= nx || vj >= ny || vk >= g.n[2]) continue;
    if (part[at(g, vi, vj, vk)]) samples.push(pob.col[i * 3], pob.col[i * 3 + 1], pob.col[i * 3 + 2]);
  }
  if (samples.length < 30) return 0;
  // k-means (k=3) on the part colours
  const k = 3, cent = [];
  for (let c = 0; c < k; c++) { const j = Math.floor(((c + 0.5) / k) * (samples.length / 3)) * 3; cent.push([samples[j], samples[j + 1], samples[j + 2]]); }
  for (let it = 0; it < 8; it++) {
    const acc = cent.map(() => [0, 0, 0, 0]);
    for (let j = 0; j < samples.length; j += 3) {
      let bi = 0, bd = Infinity;
      cent.forEach((c, ci) => { const d = Math.hypot(c[0] - samples[j], c[1] - samples[j + 1], c[2] - samples[j + 2]); if (d < bd) { bd = d; bi = ci; } });
      acc[bi][0] += samples[j]; acc[bi][1] += samples[j + 1]; acc[bi][2] += samples[j + 2]; acc[bi][3]++;
    }
    acc.forEach((a, ci) => { if (a[3]) cent[ci] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  // 2. ambiguous voxels: inside the generated model and the box, but cut by the base test
  let added = 0;
  for (let kk = 0; kk < g.n[2]; kk++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = at(g, i, j, kk);
    if (!P[c] || !inBox[c] || !Bd[c] || part[c]) continue;
    const x = g.min[0] + (i + 0.5) * p, y = g.min[1] + (j + 0.5) * p, z = g.min[2] + (kk + 0.5) * p;
    const vp = nearP(x, y, z, 1.0); if (vp < 0) continue;
    const r = pob.col[vp * 3], gg = pob.col[vp * 3 + 1], b = pob.col[vp * 3 + 2];
    let dPart = Infinity; for (const ct of cent) dPart = Math.min(dPart, Math.hypot(ct[0] - r, ct[1] - gg, ct[2] - b));
    if (dPart > tol) continue;
    const vb = nearB(x, y, z, 1.5);
    if (vb >= 0 && cdist(base.col, vb, r, gg, b) < tol * 1.4) continue; // looks like the base here
    part[c] = 1; added++;
  }
  return added;
}

// ---------- body types ----------
// Keep the master head and plinth; take only the body (between plinth and neck) from the new model,
// stretched vertically so its neck meets the master neck. Every head part then fits every body type.
export function composeBody(master, body, M, pitch = DEFAULT_PITCH) {
  const bm = measureBase(body);
  const pt = M.plinth.height, nk = M.head.bottom;
  const k = (nk - pt) / Math.max(1, bm.head.bottom - bm.plinth.height);
  const pos = new Float32Array(body.pos.length);
  for (let i = 0; i < pos.length; i += 3) { pos[i] = body.pos[i]; pos[i + 2] = body.pos[i + 2]; pos[i + 1] = pt + (body.pos[i + 1] - bm.plinth.height) * k; }
  const stretched = { ...body, pos };
  const all = [bounds(master), bounds(stretched)];
  const box = { min: [0, 1, 2].map((a) => Math.min(all[0].min[a], all[1].min[a])), max: [0, 1, 2].map((a) => Math.max(all[0].max[a], all[1].max[a])) };
  const g = makeGrid(box, pitch, 3);
  const A = voxelize(master, g), B = voxelize(stretched, g);
  const v = new Uint8Array(g.size);
  const jNeck = Math.floor((nk - g.min[1]) / pitch), jPl = Math.floor((pt - g.min[1]) / pitch);
  const over = Math.round(1.5 / pitch);
  for (let kk = 0; kk < g.n[2]; kk++) for (let j = 0; j < g.n[1]; j++) for (let i = 0; i < g.n[0]; i++) {
    const c = at(g, i, j, kk);
    const head = j >= jNeck - 1 && A[c], plinth = j <= jPl && A[c], bod = j > jPl - over && j < jNeck + over && B[c];
    if (head || plinth || bod) v[c] = 1;
  }
  const solid = fillCavities(keepLargest(v, g), g);
  // colour only from what was kept: master head + plinth, the new model's body
  const P = [], C = [];
  const take = (m, keep) => { for (let i = 0; i < m.pos.length / 3; i++) { const y = m.pos[i * 3 + 1]; if (!keep(y)) continue; P.push(m.pos[i * 3], y, m.pos[i * 3 + 2]); if (m.col) C.push(m.col[i * 3], m.col[i * 3 + 1], m.col[i * 3 + 2]); } };
  take(master, (y) => y >= nk - 1 || y <= pt);
  take(stretched, (y) => y > pt - 1 && y < nk - 0.5);
  const src = { pos: new Float32Array(P), col: master.col && body.col ? new Uint8Array(C) : undefined };
  const mesh = colorize(marchingCubes(blur(solid, g), g), src);
  return { mesh, volumeMm3: count(solid) * pitch ** 3, stretch: +k.toFixed(3), bodyMeasurements: bm };
}

// Drop tiny disconnected bits (e.g. zero-volume slivers left by simplification).
export function dropTiny(m, minFaces = 12) {
  const nv = m.pos.length / 3, par = new Int32Array(nv).map((_, i) => i);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const F = m.idx;
  for (let t = 0; t < F.length; t += 3) { const a = find(F[t]), b = find(F[t + 1]), c = find(F[t + 2]); par[b] = a; par[find(c)] = a; }
  const cnt = new Map(), vol = new Map(), Pp = m.pos;
  for (let t = 0; t < F.length; t += 3) {
    const r = find(F[t]); cnt.set(r, (cnt.get(r) || 0) + 1);
    const a = F[t] * 3, b = F[t + 1] * 3, c = F[t + 2] * 3;
    vol.set(r, (vol.get(r) || 0) + (Pp[a] * (Pp[b + 1] * Pp[c + 2] - Pp[b + 2] * Pp[c + 1]) - Pp[a + 1] * (Pp[b] * Pp[c + 2] - Pp[b + 2] * Pp[c]) + Pp[a + 2] * (Pp[b] * Pp[c + 1] - Pp[b + 1] * Pp[c])) / 6);
  }
  for (const [r, v] of vol) if (Math.abs(v) < 1 && cnt.get(r) < 2000) cnt.set(r, 0); // sealed micro-voids and slivers
  const P = m.pos, q = (i) => `${Math.round(P[i * 3] * 1e4)},${Math.round(P[i * 3 + 1] * 1e4)},${Math.round(P[i * 3 + 2] * 1e4)}`;
  const seen = new Map();
  for (let t = 0; t < F.length; t += 3) { const k = [q(F[t]), q(F[t + 1]), q(F[t + 2])].sort().join('|'); seen.set(k, (seen.get(k) || 0) + 1); }
  const keep = [];
  for (let t = 0; t < F.length; t += 3) {
    const a = F[t], b = F[t + 1], c = F[t + 2];
    const qa = q(a), qb = q(b), qc = q(c);
    if (qa === qb || qb === qc || qa === qc) continue; // zero-length edge
    if (seen.get([qa, qb, qc].sort().join('|')) > 1) continue; // back-to-back duplicate
    if (cnt.get(find(a)) >= minFaces) keep.push(a, b, c);
  }
  return { ...m, idx: new Uint32Array(keep) };
}

// ---------- replace mode (arms) ----------
// Half-width of the torso without the arms: the narrowest central run across the waist band.
export function measureTorso(body, M, pitch = 0.5) {
  const g = makeGrid(bounds(body), pitch, 1), v = voxelize(body, g), [nx, ny, nz] = g.n;
  const y0 = M.plinth.height + (M.head.bottom - M.plinth.height) * 0.35, y1 = M.plinth.height + (M.head.bottom - M.plinth.height) * 0.7;
  const i0 = Math.round((0 - g.min[0]) / pitch);
  let best = Infinity;
  for (let j = Math.floor((y0 - g.min[1]) / pitch); j <= Math.floor((y1 - g.min[1]) / pitch); j++) {
    const col = new Uint8Array(nx);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) if (v[at(g, i, j, k)]) col[i] = 1;
    if (!col[i0]) continue;
    let a = i0, b = i0; while (a > 0 && col[a - 1]) a--; while (b < nx - 1 && col[b + 1]) b++;
    const half = Math.max(Math.abs(g.min[0] + a * pitch), Math.abs(g.min[0] + (b + 1) * pitch));
    if (half < best) best = half;
  }
  return Number.isFinite(best) ? +best.toFixed(2) : M.shoulders.width / 2 - 6;
}

// Swap one arm of `body` for the arm in `pose` (a model of the same figure in the new pose).
// Returns a full new body mesh; side is +1 (viewer's right, +x) or -1, or 0 to detect.
export function replaceArm(body, pose, M, opts = {}) {
  const pitch = opts.pitch || DEFAULT_PITCH;
  const torso = measureTorso(body, M);
  const all = [bounds(body), bounds(pose)];
  const box = { min: [0, 1, 2].map((a) => Math.min(all[0].min[a], all[1].min[a])), max: [0, 1, 2].map((a) => Math.max(all[0].max[a], all[1].max[a])) };
  const g = makeGrid(box, pitch, 3), [nx, ny, nz] = g.n;
  const B = voxelize(body, g), P = voxelize(pose, g);
  const X = (i) => g.min[0] + (i + 0.5) * pitch, Y = (j) => g.min[1] + (j + 0.5) * pitch;
  const edge = torso - 1;
  // which side changed most?
  let side = opts.side || 0;
  if (!side) {
    let dl = 0, dr = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = at(g, i, j, k); if (B[c] === P[c]) continue;
      const x = X(i); if (x > edge) dr++; else if (x < -edge) dl++;
    }
    side = dr >= dl ? 1 : -1;
  }
  const inZone = (i, j) => X(i) * side > edge && Y(j) > M.plinth.height + 0.5;
  // 1. remove the old arm (below the neck, outside the torso)
  const Bn = B.slice();
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (inZone(i, j) && Y(j) < M.head.bottom - 0.5) Bn[at(g, i, j, k)] = 0;
  // 2. the new arm: pose voxels in the zone that aren't the remaining body
  const gap = Math.max(1, Math.round((opts.gapMm ?? 0.6) / pitch));
  const Bd = dilate(Bn, g, gap);
  let part = new Uint8Array(g.size);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const c = at(g, i, j, k); if (P[c] && !Bd[c] && inZone(i, j)) part[c] = 1; }
  part = keepLargest(dilate(erode(part, g, 1), g, 1), g);
  const partVox = count(part);
  if (!partVox) throw new Error('No arm was found on that side of the model.');
  // 3. fuse it into the torso and shoulder
  const fuse = dilate(part, g, gap + Math.max(1, Math.round((opts.fuseMm ?? 1) / pitch)));
  const solid0 = new Uint8Array(g.size);
  for (let i = 0; i < g.size; i++) solid0[i] = Bn[i] || part[i] || (fuse[i] && B[i]) ? 1 : 0;
  const solid = fillCavities(keepLargest(solid0, g), g);
  const pieces = islands(solid0, g).sizes.length - 1;
  // checks: thin areas and overhangs (part voxels with nothing under them, needing supports)
  const r = Math.max(1, Math.round((opts.thinMm ?? 2) / 2 / pitch));
  const opened = dilate(erode(part, g, r), g, r);
  let thin = 0, over = 0;
  for (let k = 0; k < nz; k++) for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = at(g, i, j, k); if (!part[c]) continue;
    if (!opened[c]) thin++;
    if (!solid[c - nx]) over++;
  }
  // colour: remaining body from the body model, the new arm from the pose model
  const Pp = [], C = [];
  const take = (m, keep) => { for (let i = 0; i < m.pos.length / 3; i++) { const x = m.pos[i * 3], y = m.pos[i * 3 + 1]; if (!keep(x, y)) continue; Pp.push(x, y, m.pos[i * 3 + 2]); if (m.col) C.push(m.col[i * 3], m.col[i * 3 + 1], m.col[i * 3 + 2]); } };
  take(body, (x, y) => !(x * side > edge && y < M.head.bottom - 0.5 && y > M.plinth.height + 0.5));
  take(pose, (x, y) => x * side > edge && y > M.plinth.height + 0.5);
  const src = { pos: new Float32Array(Pp), col: body.col && pose.col ? new Uint8Array(C) : undefined };
  const mesh = colorize(marchingCubes(blur(solid, g), g), src);
  return {
    mesh, side, torsoHalfMm: torso,
    stats: { volumeMm3: +(count(solid) * pitch ** 3).toFixed(1), armMm3: +(partVox * pitch ** 3).toFixed(1), thinShare: +(thin / partVox).toFixed(3), overhangMm2: +(over * pitch * pitch).toFixed(1), joined: pieces <= 1, pitch },
  };
}
