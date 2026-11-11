// Part standards: one rulebook per part type, so every version of a part is made the same way.
import { state, esc, $, $$, toast, copy, uid } from './core.js';

export const MODES = {
  add: { label: 'Add', help: 'A shape added on top of the body (glasses, hats, hair, beards).' },
  replace: { label: 'Replace', help: 'Swaps a zone of the body for a new version (arms, hands, legs, poses). Made once per body type.' },
  paint: { label: 'Paint', help: 'Colour only — a flat 2D design on a fixed template, painted onto the face or body (eyes, brows, mouth, tattoos).' },
};

const r1 = (v) => Math.round(v * 10) / 10;

// Draft standards built from the measured master figure.
export function defaultStandards(M) {
  const H = M.head, eye = H.eyeLine, front = H.front;
  return [
    {
      id: 'eyes', name: 'Eyes', category: 'eyes', mode: 'paint',
      zone: { center: [0, eye, front], size: [40, 22.5], depth: 16, note: 'Front-on area centred on the eye line, 40 × 22.5 mm on the 100 mm figure.' },
      limits: { colours: 3, minDetailMm: 0.8 },
      recipe: {
        reference: 'Eye template: a 40 × 22.5 mm crop of the master front image, centred on the eye line (16:9).',
        referenceId: 'a48ffafa-5dc3-4360-a208-0153bc8a9170', aspect: '16:9', views: 'Template crop only — no 3D step',
        prompt: 'Keep this exact close-up crop of a vinyl toy face identical: same skin, eyebrows, nose, blush, lighting, framing and size. Change ONLY the eyes: {expression}, with {iris} irises, keeping the signature eye (no white sclera, darker rim, near-black pupil, big catchlight upper right). Flat smooth toy-paint style.',
      },
      slots: [
        { name: 'expression', values: ['neutral open eyes', 'happy closed smiling arcs', 'a wink on one side', 'sleepy half-closed eyes', 'surprised round eyes'] },
        { name: 'iris', values: ['brown', 'green', 'blue', 'grey', 'hazel'] },
      ],
      checks: ['Paint stays inside the eye zone', `At most 3 colours (multi-colour filament)`, 'Eyes keep the template position and width', 'No white sclera (signature eye)'],
    },
    {
      id: 'brows', name: 'Brows', category: 'brows', mode: 'paint',
      zone: { center: [0, r1(eye + 8.5), front], size: [40, 9], depth: 16, note: 'Band above the eyes.' },
      limits: { colours: 1, minDetailMm: 1.2 },
      recipe: { reference: 'Brow band crop of the master front image (40 × 9 mm).', aspect: '21:9', views: 'Template crop only', prompt: 'Keep this exact close-up crop of a vinyl toy face identical. Change ONLY the eyebrows to {shape} brows in {colour}, smooth solid toy-paint style, same position.' },
      slots: [{ name: 'shape', values: ['soft arched', 'straight', 'thick', 'thin'] }, { name: 'colour', values: ['dark brown', 'black', 'light brown', 'blonde'] }],
      checks: ['One colour', 'Stays inside the brow band', 'Symmetric unless the variant says otherwise'],
    },
    {
      id: 'mouth', name: 'Mouth', category: 'mouth', mode: 'paint',
      zone: { center: [0, r1(eye - H.height * 0.24), front], size: [22, 11], depth: 18, note: 'Below the nose, above the chin.' },
      limits: { colours: 2, minDetailMm: 0.8 },
      recipe: { reference: 'Mouth crop of the master front image (22 × 11 mm, 2:1 → use 16:9).', aspect: '16:9', views: 'Template crop only', prompt: 'Keep this exact close-up crop of a vinyl toy face identical. Change ONLY the mouth to {mouth}, flat smooth toy-paint style, same position and width.' },
      slots: [{ name: 'mouth', values: ['a small closed smile', 'a big open smile', 'a neutral line', 'a cheeky grin'] }],
      checks: ['At most 2 colours', 'Stays inside the mouth zone'],
    },
    {
      id: 'arms', name: 'Arms', category: 'arms', mode: 'replace',
      zone: { note: 'Everything outside the torso on one side, from the plinth to the neck; the new arm joins at the shoulder. Made once per body type.' },
      limits: { colours: 2, minThicknessMm: 2 },
      recipe: {
        reference: 'Front view of the body type (bodysuit), then back and side views of the new pose.', aspect: '3:4', views: 'Front, back, side (faces the raised arm)',
        prompt: 'Keep this exact collectible vinyl figurine photo identical: same head, face, eyes, grey short-sleeved bodysuit, other arm, legs, plinth, background, lighting, camera and framing. Change ONLY the figure\'s {side} arm: {pose}. The arm is thick, smooth and solid like a designer toy, with chunky fingers held together like a mitten, joined firmly at the shoulder.',
      },
      slots: [{ name: 'pose', values: ['raised in a friendly wave, forearm pointing up, open hand facing the camera', 'hand resting on the hip', 'thumbs up in front of the chest', 'holding a small round object against the chest'] }, { name: 'side', values: ['left', 'right'] }],
      checks: ['Joins the body at the shoulder (one piece)', 'At least 2 mm thick everywhere', 'Overhangs flagged — they need print supports', 'Made on every body type'],
    },
    {
      id: 'glasses', name: 'Glasses', category: 'glasses', mode: 'add',
      zone: { note: 'The glasses anchor box: across the eye line, from the face front back to the ears.' },
      limits: { colours: 1, minThicknessMm: 2 },
      recipe: { reference: 'Front view of the master figure, then back and side views.', aspect: '3:4', views: 'Front, back, left, right', prompt: 'Keep this exact figurine photo identical. Change ONLY one thing: add {frame} glasses with thick {colour} frames — at least as thick as the eyebrows — open with no lenses, resting on the face with thick arms running back to the ears. Designed for 3D printing.' },
      slots: [{ name: 'frame', values: ['round', 'square', 'cat-eye'] }, { name: 'colour', values: ['matte black', 'tortoiseshell brown', 'red'] }],
      checks: ['At least 2 mm thick (filament) — the pilot round glasses failed this', 'Touches the face and ears', 'Stays inside the glasses box'],
    },
    {
      id: 'headwear', name: 'Headwear', category: 'headwear', mode: 'add',
      zone: { note: 'The headwear anchor box: crown and sides of the head, up to 30 mm above it.' },
      limits: { colours: 2, minThicknessMm: 2 },
      recipe: { reference: 'Front view of the master figure, then back and side views.', aspect: '3:4', views: 'Front, back, left, right', prompt: 'Keep this exact figurine photo identical. Change ONLY one thing: add a {hat} in {colour}, sitting firmly on the head, smooth and solid, no thin brims. Designed for 3D printing.' },
      slots: [{ name: 'hat', values: ['beanie', 'flat cap', 'baseball cap'] }, { name: 'colour', values: ['navy', 'grey', 'red'] }],
      checks: ['At least 2 mm thick', 'No brim overhang beyond 45° without support', 'Stays inside the headwear box'],
    },
    {
      id: 'outfit', name: 'Outfits', category: 'outfit', mode: 'add',
      zone: { note: 'Up to 15 mm around the body, plinth to neck. Made once per body type.' },
      limits: { colours: 3, minThicknessMm: 2 },
      recipe: { reference: 'Front view of the body type (bodysuit), then back and side views.', aspect: '3:4', views: 'Front, back, left, right', prompt: 'Keep this exact figurine photo identical: same head, face, plinth, background, lighting and camera. Change ONLY the clothes: dress the figure in {outfit} in {colour}, smooth solid toy shapes, no thin straps or loose pieces. Designed for 3D printing.' },
      slots: [{ name: 'outfit', values: ['a T-shirt and jeans', 'a hoodie and joggers', 'a tuxedo', 'a wedding gown'] }, { name: 'colour', values: ['navy', 'white', 'black'] }],
      checks: ['At most 3 colours', 'At least 2 mm thick', 'Within 15 mm of the body', 'Made on every body type'],
    },
  ];
}

export function variants(std) {
  const slots = (std.slots || []).filter((s) => s.values?.length);
  let combos = [{}];
  for (const s of slots) combos = combos.flatMap((c) => s.values.map((v) => ({ ...c, [s.name]: v })));
  return combos.map((c) => ({
    name: Object.values(c).map((v) => v.split(/[ ,]/).slice(0, 3).join(' ')).join(' · ') || std.name,
    values: c,
    prompt: (std.recipe?.prompt || '').replace(/\{(\w+)\}/g, (m, k) => c[k] ?? m),
  }));
}

let selId = 'eyes';
export function renderStandards(body, kit, saveKit) {
  const ds = kit.designSystem;
  ds.standards ||= defaultStandards(ds.measurements);
  const list = ds.standards;
  if (!list.find((s) => s.id === selId)) selId = list[0]?.id;
  const std = list.find((s) => s.id === selId);
  const made = (s) => kit.parts.filter((p) => (p.standard || p.category) === s.category).length;
  const vs = std ? variants(std) : [];
  body.innerHTML = `<div class="builder" style="grid-template-columns:220px minmax(0,1fr)">
    <div class="cats">${list.map((s) => `<button data-std="${s.id}" class="${s.id === selId ? 'on' : ''}">${esc(s.name)}<span class="chip ${s.mode === 'paint' ? 'plum' : s.mode === 'replace' ? 'gold' : ''}" style="margin-left:auto;font-size:10.5px">${MODES[s.mode].label}</span></button>`).join('')}
      <div style="margin-top:10px;padding:0 6px;display:flex;flex-direction:column;gap:6px"><button class="btn sm" id="sNew">+ New standard</button><button class="btn sm ghost" id="sReset">↺ Restore drafts</button></div></div>
    ${std ? `<div style="display:flex;flex-direction:column;gap:12px">
      <div class="card"><div class="row"><input class="in" id="sName" value="${esc(std.name)}" style="font-size:16px;font-weight:650;width:220px">
        <select class="in" id="sMode">${Object.entries(MODES).map(([k, m]) => `<option value="${k}" ${k === std.mode ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
        <span class="small muted grow">${esc(MODES[std.mode].help)}</span><span class="chip">${made(std)} made</span></div></div>
      <div class="grid g2">
        <div class="card"><h3>Zone</h3>
          ${std.mode === 'paint' ? `<div class="fgrid">
            <label class="f">Centre height (mm)<input class="in" type="number" step="0.5" data-z="cy" value="${std.zone.center[1]}"></label>
            <label class="f">Centre across (mm)<input class="in" type="number" step="0.5" data-z="cx" value="${std.zone.center[0]}"></label>
            <label class="f">Width (mm)<input class="in" type="number" step="0.5" data-z="w" value="${std.zone.size[0]}"></label>
            <label class="f">Height (mm)<input class="in" type="number" step="0.5" data-z="h" value="${std.zone.size[1]}"></label></div>` : ''}
          <p class="small muted" style="margin-bottom:0">${esc(std.zone?.note || '')}</p></div>
        <div class="card"><h3>Limits</h3><div class="fgrid">
          <label class="f">Max colours<input class="in" type="number" min="1" data-l="colours" value="${std.limits?.colours ?? ''}"></label>
          ${std.mode === 'paint' ? `<label class="f">Smallest painted detail (mm)<input class="in" type="number" step="0.1" data-l="minDetailMm" value="${std.limits?.minDetailMm ?? ''}"></label>` : `<label class="f">Thinnest part (mm)<input class="in" type="number" step="0.1" data-l="minThicknessMm" value="${std.limits?.minThicknessMm ?? ''}"></label>`}</div></div>
      </div>
      <div class="card"><h3>Recipe</h3>
        <div class="fgrid"><label class="f">Reference<input class="in" data-r="reference" value="${esc(std.recipe?.reference || '')}"></label>
        <label class="f">Views<input class="in" data-r="views" value="${esc(std.recipe?.views || '')}"></label></div>
        <label class="f" style="margin-top:8px">Prompt template — use {slot} for the parts that vary<textarea class="in" data-r="prompt" style="min-height:90px">${esc(std.recipe?.prompt || '')}</textarea></label>
        ${std.recipe?.referenceId ? `<p class="tiny" style="margin:6px 0 0">Reference image (Higgsfield): ${esc(std.recipe.referenceId)} · aspect ${esc(std.recipe.aspect || '')}</p>` : ''}</div>
      <div class="grid g2">
        <div class="card"><h3>Variant slots</h3><p class="tiny" style="margin-top:0">One per line: <code>name: value, value, value</code></p>
          <textarea class="in" id="sSlots" style="width:100%;min-height:120px">${esc((std.slots || []).map((s) => `${s.name}: ${s.values.join(', ')}`).join('\n'))}</textarea></div>
        <div class="card"><h3>Pass / fail checks</h3><p class="tiny" style="margin-top:0">One per line. The app runs the measurable ones automatically.</p>
          <textarea class="in" id="sChecks" style="width:100%;min-height:120px">${esc((std.checks || []).join('\n'))}</textarea></div>
      </div>
      <div class="card"><div class="row"><h3 style="margin:0">Versions to make <span class="chip plum">${vs.length}</span></h3><span class="grow"></span><button class="btn sm" id="sCopyAll">Copy all prompts</button></div>
        <table class="t" style="margin-top:8px">${vs.slice(0, 60).map((v, i) => { const done = kit.parts.some((p) => p.name.toLowerCase() === v.name.toLowerCase()); return `<tr><td class="small">${done ? '<span class="chip ok">made</span> ' : ''}${esc(v.name)}</td><td style="text-align:right"><button class="btn sm" data-cp="${i}">Copy prompt</button></td></tr>`; }).join('')}</table>
        ${vs.length > 60 ? `<p class="tiny">Showing 60 of ${vs.length}.</p>` : ''}
        <div class="row" style="margin-top:10px"><span class="grow"></span><button class="btn sm ghost danger" id="sDel">Delete this standard</button></div></div>
    </div>` : '<div class="card empty">No standards yet.</div>'}
  </div>`;
  const redraw = () => renderStandards(body, kit, saveKit);
  const commit = async (msg) => { await saveKit(); if (msg) toast(msg); };
  $$('[data-std]', body).forEach((b) => (b.onclick = () => { selId = b.dataset.std; redraw(); }));
  $('#sNew', body).onclick = async () => { const s = { id: uid(), name: 'New standard', category: 'custom', mode: 'add', zone: { note: '' }, limits: { colours: 2, minThicknessMm: 2 }, recipe: { reference: '', views: '', prompt: 'Keep this exact figurine photo identical. Change ONLY {thing}.' }, slots: [{ name: 'thing', values: ['…'] }], checks: [] }; list.push(s); selId = s.id; await commit(); redraw(); };
  $('#sReset', body).onclick = async () => { if (!confirm('Restore the draft standards? Your edits to them will be replaced.')) return; ds.standards = defaultStandards(ds.measurements); await commit('Drafts restored'); redraw(); };
  if (!std) return;
  $('#sName', body).onchange = async (e) => { std.name = e.target.value; await commit(); redraw(); };
  $('#sMode', body).onchange = async (e) => { std.mode = e.target.value; if (std.mode === 'paint' && !std.zone.center) std.zone = { ...std.zone, center: [0, ds.measurements.head.eyeLine, ds.measurements.head.front], size: [30, 15], depth: 16 }; await commit(); redraw(); };
  $$('[data-z]', body).forEach((i) => (i.onchange = async () => { const v = +i.value; ({ cy: () => (std.zone.center[1] = v), cx: () => (std.zone.center[0] = v), w: () => (std.zone.size[0] = v), h: () => (std.zone.size[1] = v) })[i.dataset.z](); await commit('Zone saved'); }));
  $$('[data-l]', body).forEach((i) => (i.onchange = async () => { std.limits[i.dataset.l] = +i.value; await commit('Saved'); }));
  $$('[data-r]', body).forEach((i) => (i.onchange = async () => { std.recipe[i.dataset.r] = i.value; await commit('Saved'); redraw(); }));
  $('#sSlots', body).onchange = async (e) => {
    std.slots = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [n, ...rest] = l.split(':'); return { name: n.trim(), values: rest.join(':').split(',').map((v) => v.trim()).filter(Boolean) }; }).filter((s) => s.name && s.values.length);
    await commit('Slots saved'); redraw();
  };
  $('#sChecks', body).onchange = async (e) => { std.checks = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean); await commit('Checks saved'); };
  $$('[data-cp]', body).forEach((b) => (b.onclick = () => copy(vs[+b.dataset.cp].prompt, 'Prompt copied')));
  $('#sCopyAll', body).onclick = () => copy(vs.map((v) => `## ${v.name}\n${v.prompt}`).join('\n\n'), `${vs.length} prompts copied`);
  $('#sDel', body).onclick = async () => { if (!confirm(`Delete the “${std.name}” standard? Parts already made are kept.`)) return; ds.standards = list.filter((s) => s !== std); await commit('Standard deleted'); redraw(); };
}
