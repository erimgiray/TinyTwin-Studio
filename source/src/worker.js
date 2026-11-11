// Heavy geometry work off the UI thread.
import * as S from './snap.js';

const T0 = Date.now();
const say = (id, msg) => postMessage({ id, type: 'progress', msg });
self.onerror = (e) => { postMessage({ id: -1, type: 'error', error: String(e.message || e) }); };
const pack = (m) => ({ pos: m.pos, idx: m.idx, col: m.col });
const transfer = (m) => [m.pos.buffer, m.idx.buffer, ...(m.col ? [m.col.buffer] : [])];

onmessage = async (e) => {
  const { id, op, data } = e.data;
  try {
    if (op === 'base') {
      say(id, 'Scaling to 100 mm and finding the plinth…');
      let m = S.yaw(data.mesh, data.yaw || 0);
      m = S.normalize(m, { height: data.height || 100 }).mesh;
      say(id, 'Measuring head, neck, shoulders…');
      const measurements = S.measureBase(m);
      const anchors = S.anchorBoxes(measurements);
      say(id, 'Rebuilding as a watertight solid…');
      const sol = S.solidify(m, data.pitch || 0.3);
      const volumeMm3 = S.count(sol.vox) * sol.grid.pitch ** 3;
      let solid = sol.mesh;
      say(id, 'Smoothing and simplifying…');
      solid = S.dropTiny(await S.simplify(S.taubin(solid, 6), data.maxTris || 160000));
      postMessage({ id, type: 'done', result: { mesh: pack(solid), measurements, anchors, volumeMm3 } }, transfer(solid));
    } else if (op === 'part') {
      say(id, 'Lining the model up with the base plinth…');
      let m = S.yaw(data.mesh, data.yaw || 0);
      m = S.normalize(m, { plinthDiameter: data.plinthDiameter }).mesh;
      let fit = null;
      if (data.measurements) {
        say(id, 'Fitting the head to the base head…');
        const rf = S.refineToBase(data.base, m, data.measurements, data.box);
        m = rf.mesh; fit = { scale: rf.scale, shiftMm: rf.shift, agreement: rf.agreement };
      }
      say(id, 'Cutting away the base and keeping the part…');
      const r = S.extractPart(data.base, m, data.box, data.opts);
      r.stats.fit = fit;
      if (!r.mesh.idx.length) throw new Error('Nothing was found inside the ' + (data.box.label || 'anchor') + ' box. Check the category, or try rotating the model.');
      say(id, 'Smoothing and simplifying…');
      const mesh = S.dropTiny(await S.simplify(S.taubin(r.mesh, 5), data.maxTris || 70000));
      postMessage({ id, type: 'done', result: { mesh: pack(mesh), stats: r.stats } }, transfer(mesh));
    } else if (op === 'body') {
      say(id, 'Lining the body model up with the plinth…');
      let m = S.yaw(data.mesh, data.yaw || 0);
      m = S.normalize(m, { plinthDiameter: data.measurements.plinth.diameter }).mesh;
      say(id, 'Fitting the body between the master plinth and head…');
      const r = S.composeBody(data.master, m, data.measurements, data.pitch || 0.3);
      say(id, 'Smoothing and simplifying…');
      const sm = S.taubin(r.mesh, 6);
      say(id, `Simplifying ${(sm.idx.length / 3).toLocaleString()} triangles…`);
      const simp = await S.simplify(sm, data.maxTris || 160000);
      say(id, 'Cleaning up…');
      const mesh = S.dropTiny(simp);
      postMessage({ id, type: 'done', result: { mesh: pack(mesh), volumeMm3: r.volumeMm3, stretch: r.stretch } }, transfer(mesh));
    } else if (op === 'replace') {
      say(id, 'Lining the pose model up with the plinth…');
      let m = S.yaw(data.mesh, data.yaw || 0);
      m = S.normalize(m, { plinthDiameter: data.measurements.plinth.diameter }).mesh;
      say(id, 'Fitting the head to the master head…');
      const rf = S.refineToBase(data.body, m, data.measurements, data.box);
      say(id, 'Cutting off the old arm and fusing the new one at the shoulder…');
      const r = S.replaceArm(data.body, rf.mesh, data.measurements, data.opts);
      say(id, 'Smoothing and simplifying…');
      const mesh = S.dropTiny(await S.simplify(S.taubin(r.mesh, 6), data.maxTris || 170000));
      postMessage({ id, type: 'done', result: { mesh: pack(mesh), side: r.side, torsoHalfMm: r.torsoHalfMm, stats: { ...r.stats, fit: { scale: rf.scale, shiftMm: rf.shift, agreement: rf.agreement } } } }, transfer(mesh));
    } else if (op === 'union') {
      say(id, 'Merging into one printable body…');
      const u = S.unionForPrint(data.meshes, data.pitch || 0.25);
      say(id, 'Smoothing and writing STL…');
      const sm = S.dropTiny(await S.simplify(S.taubin(u.mesh, 4), data.maxTris || 400000));
      const stl = S.toSTL(sm, true);
      postMessage({ id, type: 'done', result: { stl, volumeMm3: u.volumeMm3, triangles: sm.idx.length / 3, pieces: u.pieces } }, [stl]);
    } else throw new Error('unknown op ' + op);
  } catch (err) {
    postMessage({ id, type: 'error', error: String(err.message || err) });
  }
};
