import { state, $, $$, api, loadDB, loadLibrary, loadModels, toast } from './core.js';
import { renderDashboard, renderOrders } from './pipeline.js';
import { renderBuilder, renderLibrary } from './builder.js';
import { renderViewer } from './viewer.js';
import { renderKit } from './kit.js';
import { renderCosting, renderSettings, updSettings, checkUpdate, markNav } from './costing.js';

const VIEWS = { dashboard: renderDashboard, orders: renderOrders, builder: renderBuilder, library: renderLibrary, viewer: renderViewer, kit: renderKit, costing: renderCosting, settings: renderSettings };
let view = 'dashboard';
let params = {};

export async function go(v, p) {
  if (v) { view = v; params = p || {}; }
  if (view === 'viewer') await loadModels().catch(() => {});
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === view));
  const main = $('#main');
  try { VIEWS[view](main, params); }
  catch (e) { console.error(e); main.innerHTML = `<div class="card"><h3>Something went wrong on this page</h3><pre class="prompt">${String(e.stack || e)}</pre></div>`; }
  foot();
}

function foot() {
  const j = state.db.jobs;
  $('#navFoot').innerHTML = `${j.filter((x) => x.stage !== 'done').length} open orders<br>${state.lib.parts.length} parts loaded<br><span style="opacity:.6">v${state.info.version || ''}</span>`;
}

async function boot() {
  await loadDB();
  state.info = await api('/api/info').catch(() => ({}));
  await loadLibrary().catch(() => {});
  $$('#nav a').forEach((a) => (a.onclick = () => go(a.dataset.view, {})));
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) { e.preventDefault(); $('#drawer').hidden = true; $('#modal').hidden = true; go(g.dataset.go, {}); } });
  // keep the local server alive while the window is open; tell it when we close
  const beat = () => fetch('/api/heartbeat', { method: 'POST', headers: { 'X-TinyTwin': '1' } }).catch(() => {});
  beat(); setInterval(beat, 20000);
  addEventListener('pagehide', () => navigator.sendBeacon('/api/bye'));
  addEventListener('unhandledrejection', (e) => toast(String(e.reason?.message || e.reason), true));
  go('dashboard');
  if (updSettings().auto) {
    const r = await checkUpdate();
    markNav();
    if (r.newer) toast(`TinyTwin Studio v${r.latest} is available — install it from Settings.`);
    if (view === 'settings') go();
  }
}
boot();
