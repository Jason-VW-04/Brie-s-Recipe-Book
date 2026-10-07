/* Recipe Book. Everything is saved on this device (IndexedDB). No server. */
(() => {
'use strict';

/* ================= Storage ================= */
const DB_NAME = 'recipe-book';
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('recipes', { keyPath: 'id' });
      r.result.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const kvGet = k => tx('kv', 'readonly', s => s.get(k));
const kvSet = (k, v) => tx('kv', 'readwrite', s => s.put(v, k));
const allRecipes = () => tx('recipes', 'readonly', s => s.getAll());
const putRecipe = r => tx('recipes', 'readwrite', s => s.put(r));
const delRecipe = id => tx('recipes', 'readwrite', s => s.delete(id));

/* ================= State ================= */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const mk = name => ({ id: uid(), name });
function defaults() {
  return {
    bookTitle: 'The Recipe Book',
    helperUrl: '',
    mealTypes: ['Breakfast', 'Lunch', 'Dinner', 'Sides', 'Desserts', 'Appetizers'].map(mk),
    groups: [
      { id: uid(), name: 'Season', occasion: true, tags: ['Spring', 'Summer', 'Fall', 'Winter'].map(mk) },
      { id: uid(), name: 'Holiday', occasion: true, tags: ['Thanksgiving', 'Christmas', 'Easter', 'Fourth of July', 'Halloween'].map(mk) },
      { id: uid(), name: 'Kind of meal', occasion: false, tags: ['Comfort food', 'Easy meal prep', 'Quick weeknight', 'Healthy', 'For a crowd'].map(mk) },
    ],
  };
}
const state = { settings: null, recipes: [], grocery: [] };
const ui = { q: '', meal: 'all', tags: new Set(), fav: false, everyday: false, time: 0, sort: 'new', open: false };
let rv = { id: null, servings: null, struck: new Set() };   // recipe page state
let draft = null;                                           // recipe being edited
let homeScroll = 0;

const saveSettings = () => kvSet('settings', state.settings);
const saveGrocery = () => { kvSet('grocery', state.grocery); groceryDot(); };

/* ================= Helpers ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
function fmtMin(m) {
  m = Math.round(m || 0);
  if (!m) return '';
  const h = Math.floor(m / 60), r = m % 60;
  return [h ? `${h} hr` : '', r ? `${r} min` : ''].filter(Boolean).join(' ');
}
const totalMin = r => (Number(r.prep) || 0) + (Number(r.cook) || 0);
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}
function tagIndex() {
  const m = new Map();
  state.settings.groups.forEach((g, gi) => g.tags.forEach(t => m.set(t.id, { ...t, gi, group: g })));
  return m;
}
const mealName = id => state.settings.mealTypes.find(m => m.id === id)?.name;
const isHeading = line => /:\s*$/.test(line) && line.length < 60;
const hashTone = id => 'tone-' + ([...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % 4);
function photoHtml(r, cls = '') {
  const mono = `<div class="mono ${hashTone(r.id)}" aria-hidden="true">${esc((r.title || 'R').trim().charAt(0).toUpperCase())}</div>`;
  if (!r.photo) return mono;
  return `<img src="${esc(r.photo)}" alt="" loading="lazy" data-fallback="${esc(mono)}" class="${cls}">`;
}
document.addEventListener('error', e => {
  const el = e.target;
  if (el instanceof HTMLImageElement && el.dataset.fallback) el.outerHTML = el.dataset.fallback;
}, true);
function groceryDot() { $('#groceryDot').hidden = !state.grocery.some(g => !g.done); }

/* ================= Quantities (servings scaler) ================= */
const UNI = { '¼': .25, '½': .5, '¾': .75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': .125, '⅜': .375, '⅝': .625, '⅞': .875, '⅕': .2, '⅖': .4, '⅗': .6, '⅘': .8, '⅙': 1 / 6, '⅚': 5 / 6 };
const UC = Object.keys(UNI).join('');
const NUM = `(?:\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*/\\s*\\d+|\\d+\\s*[${UC}]|[${UC}]|\\d+(?:\\.\\d+)?)`;
const QTY_RE = new RegExp(`^(\\s*)(${NUM})(?:(\\s*[-–—]\\s*|\\s+to\\s+)(${NUM}))?`);
function parseNum(s) {
  s = s.trim();
  let m;
  if ((m = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/))) return +m[1] + m[2] / m[3];
  if ((m = s.match(/^(\d+)\s*\/\s*(\d+)$/))) return m[1] / m[2];
  if ((m = s.match(new RegExp(`^(\\d+)\\s*([${UC}])$`)))) return +m[1] + UNI[m[2]];
  if (UNI[s] != null) return UNI[s];
  return parseFloat(s);
}
function fmtQty(x, metric) {
  if (!isFinite(x) || x <= 0) return '0';
  if (metric) return String(x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
  if (x >= 20) return String(Math.round(x));
  const whole = Math.floor(x + 1e-9), frac = x - whole;
  const opts = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'], [1, '']];
  let best = opts[0];
  for (const o of opts) if (Math.abs(o[0] - frac) < Math.abs(best[0] - frac)) best = o;
  if (best[0] === 1) return String(whole + 1);
  if (!whole && !best[1]) return String(Math.round(x * 100) / 100);
  return [whole || '', best[1]].filter(Boolean).join(' ');
}
function scaleLine(line, f) {
  if (f === 1) return line;
  const m = line.match(QTY_RE);
  if (!m) return line;
  const rest = line.slice(m[0].length);
  if (/^\s*(?:-?\s*inch|"|x\s*\d|°|%|-\s*[a-z])/i.test(rest)) return line;   // "9x13", "1-inch", "350°"
  const metric = /^\s*(?:g|kg|ml|l|grams?|kilograms?|millilit\w+|lit\w+)\b/i.test(rest);
  let out = m[1] + fmtQty(parseNum(m[2]) * f, metric);
  if (m[4]) out += m[3].replace(/\s*[-–—]\s*/, '–') + fmtQty(parseNum(m[4]) * f, metric);
  return out + rest;
}

/* ================= Filtering ================= */
function matches(r, { skipMeal = false } = {}) {
  if (!skipMeal && ui.meal !== 'all' && !(r.mealTypes || []).includes(ui.meal)) return false;
  if (ui.fav && !r.favorite) return false;
  if (ui.time && !(totalMin(r) > 0 && totalMin(r) <= ui.time)) return false;
  const idx = tagIndex();
  if (ui.everyday && (r.tags || []).some(t => idx.get(t)?.group.occasion)) return false;
  if (ui.tags.size) {
    // any tag within a group, every group that has a selection
    const byGroup = new Map();
    for (const t of ui.tags) { const g = idx.get(t)?.group.id; if (g) (byGroup.get(g) || byGroup.set(g, []).get(g)).push(t); }
    for (const ids of byGroup.values()) if (!ids.some(t => (r.tags || []).includes(t))) return false;
  }
  const q = ui.q.trim().toLowerCase();
  if (q) {
    const hay = [r.title, ...(r.ingredients || []), r.notes, r.sourceName,
      ...(r.tags || []).map(t => idx.get(t)?.name), ...(r.mealTypes || []).map(mealName)].join(' ').toLowerCase();
    if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}
function sorted(list) {
  const l = [...list];
  if (ui.sort === 'az') l.sort((a, b) => a.title.localeCompare(b.title));
  else if (ui.sort === 'quick') l.sort((a, b) => (totalMin(a) || 1e9) - (totalMin(b) || 1e9));
  else l.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return l;
}
const filterCount = () => ui.tags.size + (ui.fav ? 1 : 0) + (ui.everyday ? 1 : 0) + (ui.time ? 1 : 0);

/* ================= Home ================= */
function viewHome() {
  const s = state.settings;
  document.title = s.bookTitle;
  app.innerHTML = `
    <header class="masthead"><h1>${esc(s.bookTitle)}</h1><p id="count"></p></header>
    <div class="wrap">
      <div class="searchrow">
        <label class="search">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6"/><path d="m14 14 4 4"/></svg>
          <input type="search" id="q" placeholder="Search recipes" aria-label="Search recipes or ingredients" value="${esc(ui.q)}" autocomplete="off">
        </label>
        <button class="filterbtn" id="filterBtn" data-act="toggle-filter" aria-expanded="${ui.open}" aria-controls="filterPanel">Filter<span class="badge" id="fbadge" hidden></span></button>
      </div>
      <div id="filterPanel" class="filterpanel" ${ui.open ? '' : 'hidden'}></div>
      <div id="active" class="active"></div>
    </div>
    <div class="tabs" id="tabs" role="tablist" aria-label="Meal"></div>
    <section class="drawer"><div class="wrap"><div id="grid"></div></div></section>`;
  $('#q').addEventListener('input', e => { ui.q = e.target.value; updateHome(); });
  renderFilterPanel();
  updateHome();
}
function renderFilterPanel() {
  const p = $('#filterPanel'); if (!p) return;
  const s = state.settings;
  const groups = s.groups.filter(g => g.tags.length).map((g, gi) => `
    <h3>${esc(g.name)}</h3>
    <div class="chips tone-${s.groups.indexOf(g) % 4}">${g.tags.map(t =>
      `<button class="chip" data-act="f-tag" data-id="${t.id}" aria-pressed="${ui.tags.has(t.id)}">${esc(t.name)}</button>`).join('')}</div>`).join('');
  p.innerHTML = `${groups}
    <h3>Also</h3>
    <div class="chips tone-m">
      <button class="chip" data-act="f-fav" aria-pressed="${ui.fav}">Favorites</button>
      <button class="chip" data-act="f-everyday" aria-pressed="${ui.everyday}">Everyday, no season or holiday</button>
      <button class="chip" data-act="f-time" data-v="30" aria-pressed="${ui.time === 30}">30 minutes or less</button>
      <button class="chip" data-act="f-time" data-v="60" aria-pressed="${ui.time === 60}">1 hour or less</button>
    </div>
    <label class="field"><span>Sort by</span>
      <select id="sort"><option value="new">Newest first</option><option value="az">A to Z</option><option value="quick">Quickest first</option></select>
    </label>
    <div class="foot">
      <button class="link" data-act="f-clear">Clear filters</button>
      <button class="btn small" data-act="toggle-filter" id="showBtn"></button>
    </div>`;
  $('#sort').value = ui.sort;
  $('#sort').addEventListener('change', e => { ui.sort = e.target.value; updateHome(); });
}
function updateHome() {
  const s = state.settings, idx = tagIndex();
  const list = sorted(state.recipes.filter(r => matches(r)));
  const total = state.recipes.length;
  $('#count').textContent = total ? `${plural(total, 'recipe')}, kept in one place` : 'A place for every recipe worth keeping';

  // tabs with counts that respect the other filters
  const base = state.recipes.filter(r => matches(r, { skipMeal: true }));
  const tabs = [{ id: 'all', name: 'All', n: base.length }, ...s.mealTypes.map(m => ({ ...m, n: base.filter(r => (r.mealTypes || []).includes(m.id)).length }))];
  $('#tabs').innerHTML = tabs.map(t =>
    `<button class="tab" role="tab" data-act="meal" data-id="${t.id}" aria-selected="${ui.meal === t.id}">${esc(t.name)}<small>${t.n}</small></button>`).join('');

  // filter badge and removable chips
  const n = filterCount();
  $('#fbadge').hidden = !n; $('#fbadge').textContent = n;
  const chips = [];
  for (const t of ui.tags) { const tag = idx.get(t); if (tag) chips.push(`<button class="chip tone-${tag.gi % 4}" data-act="f-tag" data-id="${t}" aria-label="Remove filter ${esc(tag.name)}">${esc(tag.name)}<span class="x" aria-hidden="true">×</span></button>`); }
  if (ui.fav) chips.push(`<button class="chip tone-m" data-act="f-fav">Favorites<span class="x" aria-hidden="true">×</span></button>`);
  if (ui.everyday) chips.push(`<button class="chip tone-m" data-act="f-everyday">Everyday<span class="x" aria-hidden="true">×</span></button>`);
  if (ui.time) chips.push(`<button class="chip tone-m" data-act="f-time" data-v="${ui.time}">${ui.time === 30 ? '30 minutes or less' : '1 hour or less'}<span class="x" aria-hidden="true">×</span></button>`);
  $('#active').innerHTML = chips.join('');
  $('#active').hidden = !chips.length;
  const show = $('#showBtn'); if (show) show.textContent = `Show ${plural(list.length, 'recipe')}`;
  $$('#filterPanel [data-act="f-tag"]').forEach(b => b.setAttribute('aria-pressed', ui.tags.has(b.dataset.id)));
  const setP = (sel, v) => $$(sel, $('#filterPanel')).forEach(b => b.setAttribute('aria-pressed', v(b)));
  setP('[data-act="f-fav"]', () => ui.fav); setP('[data-act="f-everyday"]', () => ui.everyday);
  setP('[data-act="f-time"]', b => ui.time === +b.dataset.v);

  const grid = $('#grid');
  if (!total) {
    grid.className = '';
    grid.innerHTML = `<div class="empty"><h2>Your book is empty</h2>
      <p>Add your first recipe. Paste a link from another site and it fills in the ingredients and steps for you, or type one in yourself.</p>
      <div class="btns"><a class="btn" href="#/add">Add a recipe</a></div></div>`;
  } else if (!list.length) {
    grid.className = '';
    grid.innerHTML = `<div class="empty"><h2>Nothing matches</h2><p>No recipes fit that search and those filters together.</p>
      <div class="btns"><button class="btn quiet" data-act="f-reset">Clear search and filters</button></div></div>`;
  } else {
    grid.className = 'grid';
    grid.innerHTML = list.map(r => {
      const meta = [(r.mealTypes || []).map(mealName).filter(Boolean)[0], fmtMin(totalMin(r))].filter(Boolean).join(', ');
      return `<a class="card" href="#/recipe/${r.id}">
        <div class="ph">${photoHtml(r)}${r.favorite ? `<span class="star-on" aria-label="Favorite">${STAR}</span>` : ''}</div>
        <h2>${esc(r.title)}</h2>${meta ? `<p>${esc(meta)}</p>` : ''}</a>`;
    }).join('');
  }
}
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.6 2.6 5.3 5.800.8-4.200 4.100 1 5.800-5.200-2.700-5.200 2.700 1-5.800-4.200-4.100 5.800-.8L12 3.600Z"/></svg>';

/* ================= Recipe page ================= */
function factor(r) {
  if (rv.servings == null) return 1;
  return rv.servings / (r.servings || 1);
}
function servingsLabel(r) {
  if (r.servings) return `${rv.servings ?? r.servings} ${esc(r.servingsUnit || 'servings')}`;
  const f = rv.servings ?? 1;
  return f === 0.5 ? 'Half batch' : f === 1 ? '1 batch' : `${f} batches`;
}
function ingListHtml(r) {
  const f = factor(r);
  return (r.ingredients || []).map((line, i) => isHeading(line)
    ? `<li class="sub">${esc(line.replace(/:\s*$/, ''))}</li>`
    : `<li><button data-act="strike" data-i="${i}" aria-pressed="${rv.struck.has(i)}">${esc(scaleLine(line, f))}</button></li>`).join('');
}
function viewRecipe(id) {
  const r = state.recipes.find(x => x.id === id);
  if (!r) { location.hash = '#/'; return; }
  if (rv.id !== id) rv = { id, servings: null, struck: new Set() };
  document.title = r.title;
  const idx = tagIndex();
  const meals = (r.mealTypes || []).map(mealName).filter(Boolean);
  const times = [r.prep ? `${fmtMin(r.prep)} to prep` : '', r.cook ? `${fmtMin(r.cook)} to cook` : ''].filter(Boolean).join(', ');
  const labels = (r.tags || []).map(t => idx.get(t)).filter(Boolean).map(t => `<span class="label tone-${t.gi % 4}">${esc(t.name)}</span>`).join('');
  app.innerHTML = `<div class="wrap">
    <div class="bar">
      <a class="back" href="#/">Recipes</a>
      <div class="row" style="flex:none;gap:8px">
        <button class="iconbtn" data-act="fav" data-id="${r.id}" aria-pressed="${!!r.favorite}" aria-label="Favorite">${STAR}</button>
        <a class="iconbtn" href="#/edit/${r.id}" aria-label="Edit recipe"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.500 6.500 4 4"/></svg></a>
      </div>
    </div>
    <div class="hero">${photoHtml(r)}</div>
    <div class="title">
      <h1>${esc(r.title)}</h1>
      ${meals.length || times ? `<p class="meta">${esc([meals.join(' and '), times].filter(Boolean).join('. '))}</p>` : ''}
      ${labels ? `<div class="labels">${labels}</div>` : ''}
      ${r.sourceUrl ? `<p class="source">From <a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">${esc(r.sourceName || 'the original page')}</a></p>` : ''}
    </div>
    <div class="cols">
      <section class="sect">
        <div class="sechead"><h2>Ingredients</h2>
          <div class="stepper"><button data-act="serv" data-d="-1" aria-label="Fewer">−</button><output id="servOut">${servingsLabel(r)}</output><button data-act="serv" data-d="1" aria-label="More">+</button></div>
        </div>
        <ul class="ings" id="ings">${ingListHtml(r)}</ul>
        ${(r.ingredients || []).length ? '' : '<p class="hint">No ingredients yet. Edit the recipe to add them.</p>'}
      </section>
      <section class="sect">
        <h2>Method</h2>
        <ol class="steps">${(r.steps || []).map(s => isHeading(s) ? `<li class="sub">${esc(s.replace(/:\s*$/, ''))}</li>` : `<li class="step">${esc(s)}</li>`).join('')}</ol>
        ${(r.steps || []).length ? '' : '<p class="hint">No steps yet. Edit the recipe to add them.</p>'}
      </section>
    </div>
    ${r.notes ? `<div class="notes"><b>Notes</b>${esc(r.notes)}</div>` : ''}
    <div class="actions">
      <a class="btn ${(r.steps || []).length ? '' : 'plain'}" href="#/cook/${r.id}">Start cooking</a>
      <button class="btn quiet" data-act="to-grocery" data-id="${r.id}">Add to grocery list</button>
    </div>
  </div>`;
}
function stepServings(r, d) {
  if (r.servings) {
    rv.servings = Math.max(1, (rv.servings ?? r.servings) + d);
  } else {
    const steps = [0.5, 1, 2, 3, 4, 5, 6];
    const i = steps.indexOf(rv.servings ?? 1);
    rv.servings = steps[Math.min(steps.length - 1, Math.max(0, i + d))];
  }
  $('#servOut').innerHTML = servingsLabel(r);
  $('#ings').innerHTML = ingListHtml(r);
}
function grocerySheet(r) {
  const f = factor(r);
  const lines = (r.ingredients || []).filter(l => !isHeading(l)).map(l => scaleLine(l, f));
  if (!lines.length) { toast('This recipe has no ingredients yet'); return; }
  const d = document.createElement('dialog');
  d.className = 'sheet';
  d.innerHTML = `<div class="in"><h2>Add to grocery list</h2><p>Uncheck anything you already have.</p>
    <ul class="glist">${lines.map((l, i) => `<li><button class="tick" data-i="${i}" aria-pressed="true">${esc(l)}</button></li>`).join('')}</ul>
    <div class="btns"><button class="btn plain" data-x="cancel">Cancel</button><button class="btn" data-x="add"></button></div></div>`;
  const count = () => { const n = $$('.tick[aria-pressed="true"]', d).length; $('[data-x="add"]', d).textContent = `Add ${plural(n, 'item')}`; $('[data-x="add"]', d).disabled = !n; };
  d.addEventListener('click', e => {
    const tick = e.target.closest('.tick');
    if (tick) { tick.setAttribute('aria-pressed', tick.getAttribute('aria-pressed') !== 'true'); count(); return; }
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'add') {
      const picked = $$('.tick[aria-pressed="true"]', d).map(b => lines[+b.dataset.i]);
      picked.forEach(text => state.grocery.push({ id: uid(), text, done: false, recipeId: r.id, recipeTitle: r.title }));
      saveGrocery(); toast(`Added ${plural(picked.length, 'item')} to your grocery list`);
    }
    if (x || e.target === d) d.close();
  });
  d.addEventListener('close', () => d.remove());
  document.body.append(d); count(); d.showModal();
}

/* ================= Cook mode ================= */
let cook = null, wake = null;
async function keepAwake() { try { wake = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ } }
function stopCook() { cook = null; document.body.classList.remove('cooking'); try { wake?.release(); } catch { } wake = null; }
document.addEventListener('visibilitychange', () => { if (cook && document.visibilityState === 'visible') keepAwake(); });
function viewCook(id) {
  const r = state.recipes.find(x => x.id === id);
  if (!r) { location.hash = '#/'; return; }
  if (rv.id !== id) rv = { id, servings: null, struck: new Set() };
  const steps = []; let sec = '';
  for (const s of r.steps || []) { if (isHeading(s)) sec = s.replace(/:\s*$/, ''); else steps.push({ text: s, sec }); }
  cook = { r, steps, i: 0, ings: !steps.length };
  document.body.classList.add('cooking');
  keepAwake();
  renderCook();
}
function renderCook() {
  const { r, steps, i, ings } = cook;
  const last = i >= steps.length - 1;
  const body = ings
    ? `<div class="sect"><div class="sechead"><h2>Ingredients</h2><span class="hint">${servingsLabel(r)}</span></div><ul class="ings" id="ings">${ingListHtml(r)}</ul></div>`
    : `<div class="num">${i + 1}</div><div class="of">of ${steps.length}${steps[i].sec ? `, ${esc(steps[i].sec)}` : ''}</div><div class="text">${esc(steps[i].text)}</div>`;
  app.innerHTML = `<div class="cook" id="cook">
    <div class="top">
      <a class="btn plain small" href="#/recipe/${r.id}">Close</a>
      <div class="name">${esc(r.title)}</div>
      <button class="btn plain small" data-act="cook-ings" aria-pressed="${ings}">${ings ? 'Steps' : 'Ingredients'}</button>
    </div>
    <div class="progress" aria-hidden="true"><i style="width:${steps.length ? ((i + 1) / steps.length) * 100 : 0}%"></i></div>
    <div class="body" ${ings ? 'style="justify-content:flex-start"' : ''}>${body}</div>
    <div class="bottom">
      <button class="btn plain" data-act="cook-prev" ${i === 0 || ings || !steps.length ? 'disabled' : ''}>Back</button>
      ${ings ? `<button class="btn" data-act="cook-ings" ${steps.length ? '' : 'disabled'}>Go to steps</button>`
        : last ? `<a class="btn" href="#/recipe/${r.id}">Done</a>` : `<button class="btn" data-act="cook-next">Next step</button>`}
    </div></div>`;
  const el = $('#cook'); let x0 = null;
  el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', e => {
    if (x0 == null || cook.ings) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (dx < -60 && cook.i < steps.length - 1) { cook.i++; renderCook(); }
    if (dx > 60 && cook.i > 0) { cook.i--; renderCook(); }
  }, { passive: true });
}
document.addEventListener('keydown', e => {
  if (!cook || cook.ings) return;
  if (e.key === 'ArrowRight' && cook.i < cook.steps.length - 1) { cook.i++; renderCook(); }
  if (e.key === 'ArrowLeft' && cook.i > 0) { cook.i--; renderCook(); }
});

/* ================= Add / edit ================= */
function blankDraft() {
  return { id: null, title: '', photo: '', mealTypes: [], tags: [], servings: '', servingsUnit: 'servings', prep: '', cook: '', ingredients: '', steps: '', notes: '', sourceUrl: '', sourceName: '' };
}
function viewEditor(id) {
  if (id) {
    const r = state.recipes.find(x => x.id === id);
    if (!r) { location.hash = '#/'; return; }
    draft = { ...blankDraft(), ...r, mealTypes: [...(r.mealTypes || [])], tags: [...(r.tags || [])], ingredients: (r.ingredients || []).join('\n'), steps: (r.steps || []).join('\n\n'), servings: r.servings || '', prep: r.prep || '', cook: r.cook || '' };
  } else if (!draft || draft.id) draft = blankDraft();
  document.title = id ? 'Edit recipe' : 'Add a recipe';
  renderEditor();
}
function renderEditor(msg) {
  const s = state.settings, d = draft, isNew = !d.id;
  app.innerHTML = `<div class="wrap narrow">
    <div class="bar"><a class="back" href="${isNew ? '#/' : '#/recipe/' + d.id}">${isNew ? 'Recipes' : 'Cancel'}</a>
      <button class="btn small" data-act="save">Save recipe</button></div>
    <div class="pagehead"><h1>${isNew ? 'Add a recipe' : 'Edit recipe'}</h1></div>
    ${isNew ? `<div class="importbox">
      <h2>Bring one in from a link</h2>
      <p>Paste the address of a recipe on another website. The title, photo, ingredients and steps fill in below.</p>
      <div class="go"><input type="url" id="importUrl" inputmode="url" placeholder="https://" aria-label="Recipe link" value="${esc(d.sourceUrl)}">
        <button class="btn" data-act="import" id="importBtn">Fill in</button></div>
      <div class="msg ${msg?.bad ? 'bad' : ''}" id="importMsg" ${msg ? '' : 'hidden'}>${esc(msg?.text || '')}</div>
      <details id="pasteBox" ${msg?.openPaste ? 'open' : ''}><summary>Or paste the recipe text instead</summary>
        <textarea id="pasteText" placeholder="Copy the whole recipe from the page and paste it here, with its Ingredients and Instructions headings." aria-label="Recipe text"></textarea>
        <button class="btn quiet small" data-act="paste-fill" style="margin-top:10px">Fill in from this text</button></details>
    </div><p class="or">or type it in yourself</p>` : ''}

    <label class="field" style="margin-top:${isNew ? 12 : 22}px"><span>Recipe name</span><input type="text" id="f-title" value="${esc(d.title)}" autocomplete="off"></label>

    <div class="field"><span class="legend">Picture</span>
      <div class="photo">
        <div class="thumb" id="thumb">${d.photo ? `<img src="${esc(d.photo)}" alt="">` : 'No picture yet'}</div>
        <div class="btns">
          <label class="btn quiet small" tabindex="0">${d.photo ? 'Change picture' : 'Choose a picture'}<input type="file" id="f-photo" accept="image/*" hidden></label>
          ${d.photo ? '<button class="link" data-act="photo-remove">Remove picture</button>' : ''}
        </div>
      </div>
    </div>

    <div class="field"><span class="legend">Meal</span>
      <div class="chips tone-m" id="f-meals">${s.mealTypes.map(m => `<button class="chip" data-act="d-meal" data-id="${m.id}" aria-pressed="${d.mealTypes.includes(m.id)}">${esc(m.name)}</button>`).join('')}</div>
    </div>

    <div class="field"><span class="legend">Tags</span>
      ${s.groups.map((g, gi) => `<div class="group"><div class="name">${esc(g.name)}</div>
        <div class="chips tone-${gi % 4}">${g.tags.map(t => `<button class="chip" data-act="d-tag" data-id="${t.id}" aria-pressed="${d.tags.includes(t.id)}">${esc(t.name)}</button>`).join('')}
        <button class="chip add" data-act="d-newtag" data-g="${g.id}">New tag</button></div></div>`).join('')}
    </div>

    <div class="row">
      <label class="field"><span>Makes</span><input type="number" id="f-servings" inputmode="numeric" min="1" value="${esc(d.servings)}" placeholder="4"></label>
      <label class="field"><span>Of what</span><input type="text" id="f-unit" value="${esc(d.servingsUnit)}" placeholder="servings" autocapitalize="off"></label>
    </div>
    <div class="row">
      <label class="field"><span>Prep, in minutes</span><input type="number" id="f-prep" inputmode="numeric" min="0" value="${esc(d.prep)}"></label>
      <label class="field"><span>Cooking, in minutes</span><input type="number" id="f-cook" inputmode="numeric" min="0" value="${esc(d.cook)}"></label>
    </div>

    <label class="field"><span>Ingredients</span><textarea id="f-ings" rows="9" placeholder="2 cups flour&#10;1 tsp baking soda&#10;½ cup butter, softened">${esc(d.ingredients)}</textarea>
      <p class="hint">One per line. Start with the amount so the servings scaler can adjust it. End a line with a colon to make a heading, like “For the frosting:”.</p></label>
    <label class="field"><span>Instructions</span><textarea id="f-steps" rows="11" placeholder="Heat the oven to 350°F.&#10;&#10;Cream the butter and sugar until fluffy.">${esc(d.steps)}</textarea>
      <p class="hint">One step per line. They are numbered for you.</p></label>
    <label class="field"><span>Notes</span><textarea id="f-notes" rows="3" style="min-height:90px" placeholder="Swaps, who loved it, what to change next time">${esc(d.notes)}</textarea></label>
    <label class="field"><span>Where it came from</span><input type="url" id="f-source" inputmode="url" value="${esc(d.sourceUrl)}" placeholder="Link to the original, if there is one"></label>

    <div class="savebar">
      <button class="btn block" data-act="save">Save recipe</button>
      ${isNew ? '' : `<button class="btn danger block" data-act="delete" data-id="${d.id}">Delete this recipe</button>`}
    </div>
  </div>`;
  $('#f-photo').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try { syncDraft(); draft.photo = await shrinkImage(file); renderEditor(); }
    catch { toast('That picture could not be opened'); }
  });
}
function syncDraft() {
  const v = id => $(id)?.value ?? '';
  if (!$('#f-title')) return;
  Object.assign(draft, {
    title: v('#f-title').trim(), servings: v('#f-servings'), servingsUnit: v('#f-unit').trim() || 'servings',
    prep: v('#f-prep'), cook: v('#f-cook'), ingredients: v('#f-ings'), steps: v('#f-steps'), notes: v('#f-notes').trim(), sourceUrl: v('#f-source').trim(),
    mealTypes: $$('#f-meals [aria-pressed="true"]').map(b => b.dataset.id),
    tags: $$('[data-act="d-tag"][aria-pressed="true"]').map(b => b.dataset.id),
  });
}
const lines = t => String(t || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
async function saveDraft() {
  syncDraft();
  if (!draft.title) { toast('Give the recipe a name first'); $('#f-title').focus(); return; }
  const now = Date.now();
  const old = draft.id ? state.recipes.find(r => r.id === draft.id) : null;
  const r = {
    id: draft.id || uid(), title: draft.title, photo: draft.photo || '',
    mealTypes: draft.mealTypes, tags: draft.tags,
    servings: parseInt(draft.servings, 10) || null, servingsUnit: draft.servingsUnit || 'servings',
    prep: parseInt(draft.prep, 10) || 0, cook: parseInt(draft.cook, 10) || 0,
    ingredients: lines(draft.ingredients), steps: lines(draft.steps), notes: draft.notes,
    sourceUrl: draft.sourceUrl, sourceName: draft.sourceUrl ? hostOf(draft.sourceUrl) : '',
    favorite: old?.favorite || false, createdAt: old?.createdAt || now, updatedAt: now,
  };
  try { await putRecipe(r); }
  catch { toast('Could not save. Your phone may be out of space.'); return; }
  const i = state.recipes.findIndex(x => x.id === r.id);
  if (i >= 0) state.recipes[i] = r; else state.recipes.push(r);
  draft = null; rv = { id: null, servings: null, struck: new Set() };
  toast('Saved');
  location.hash = '#/recipe/' + r.id;
}

/* ---------- pictures ---------- */
function shrinkImage(blob, max = 1200) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')); };
    img.src = url;
  });
}

/* ================= Import from a link ================= */
const HELPERS = [
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
];
function helperUrls(u) {
  const own = (state.settings.helperUrl || '').trim();
  const list = HELPERS.map(h => h(u));
  if (own) list.unshift(own + (own.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(u));
  return list;
}
async function getWithTimeout(url, ms = 15000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { signal: c.signal }); } finally { clearTimeout(t); }
}
async function fetchPage(u) {
  let sawPage = false, lastHtml = null;
  for (const h of helperUrls(u)) {
    try {
      const r = await getWithTimeout(h);
      if (!r.ok) continue;
      const text = await r.text();
      if (text.length < 600 || !/<html|<body|ld\+json/i.test(text)) continue;
      sawPage = true;
      if (parseRecipeHtml(text, u)?.ingredients.length) return { html: text };
      lastHtml = text;                    // keep trying: another helper may get past a block page
    } catch { /* try the next one */ }
  }
  return { html: lastHtml, sawPage };
}
async function fetchPhoto(u) {
  for (const h of helperUrls(u)) {
    try {
      const r = await getWithTimeout(h, 12000);
      if (!r.ok) continue;
      const b = await r.blob();
      if (b.size < 1500) continue;
      return await shrinkImage(b);
    } catch { /* next */ }
  }
  return null;
}
const decode = (() => { const t = document.createElement('textarea'); return s => { t.innerHTML = s; return t.value; }; })();
const clean = s => decode(String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
function findRecipes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => findRecipes(n, out)); return out; }
  const types = [].concat(node['@type'] || []).map(t => String(t).toLowerCase());
  if (types.includes('recipe')) out.push(node);
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'hasPart', 'itemListElement', 'item']) findRecipes(node[k], out);
  return out;
}
function flatSteps(x, out = []) {
  if (!x) return out;
  if (typeof x === 'string') { clean(x).split(/\n+/).forEach(s => s.trim() && out.push(s.trim())); return out; }
  if (Array.isArray(x)) { x.forEach(i => flatSteps(i, out)); return out; }
  const type = String([].concat(x['@type'] || [])[0] || '').toLowerCase();
  if (type === 'howtosection') {
    if (x.name) out.push(clean(x.name).replace(/:\s*$/, '') + ':');
    return flatSteps(x.itemListElement || x.steps, out);
  }
  if (x.text || x.name) return flatSteps(String(x.text || x.name), out);
  if (x.itemListElement) return flatSteps(x.itemListElement, out);
  return out;
}
function isoMinutes(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const m = String(v).match(/P(?:(\d+)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+)M)?/i);
  if (m && (m[1] || m[2] || m[3])) return Math.round((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0));
  const h = String(v).match(/(\d+)\s*h/i), mi = String(v).match(/(\d+)\s*m/i);
  return (h ? +h[1] * 60 : 0) + (mi ? +mi[1] : 0);
}
function imageUrl(img, base) {
  let u = '';
  if (typeof img === 'string') u = img;
  else if (Array.isArray(img)) return imageUrl(img[0], base);
  else if (img && typeof img === 'object') u = img.url || img.contentUrl || '';
  if (!u) return '';
  try { return new URL(u, base).href; } catch { return ''; }
}
function parseYield(y) {
  const all = [].concat(y ?? []).map(v => clean(v));
  const pick = all.find(v => /\d/.test(v) && /[a-z]/i.test(v)) || all.find(v => /\d/.test(v)) || '';
  const m = pick.match(/(\d+)(?:\s*(?:-|–|to)\s*\d+)?\s*([a-z][a-z ]{1,24})?/i);
  if (!m) return { servings: '', servingsUnit: 'servings' };
  let unit = (m[2] || 'servings').trim().toLowerCase();
  if (/^serv|^people|^portion/.test(unit)) unit = 'servings';
  return { servings: +m[1], servingsUnit: unit };
}
function parseRecipeHtml(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = { title: '', photoUrl: '', ingredients: [], steps: [], servings: '', servingsUnit: 'servings', prep: '', cook: '', cats: [] };
  const meta = n => doc.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.getAttribute('content') || '';
  let found = [];
  for (const s of doc.querySelectorAll('script[type*="ld+json"]')) {
    const raw = s.textContent.trim(); if (!raw) continue;
    let data;
    try { data = JSON.parse(raw); } catch { try { data = JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' ')); } catch { continue; } }
    findRecipes(data, found);
  }
  const r = found.sort((a, b) => [].concat(b.recipeIngredient || []).length - [].concat(a.recipeIngredient || []).length)[0];
  if (r) {
    out.title = clean(r.name || r.headline);
    out.photoUrl = imageUrl(r.image, url);
    out.ingredients = [].concat(r.recipeIngredient || r.ingredients || []).map(clean).filter(Boolean);
    out.steps = flatSteps(r.recipeInstructions);
    Object.assign(out, parseYield(r.recipeYield));
    const prep = isoMinutes(r.prepTime), cook = isoMinutes(r.cookTime), total = isoMinutes(r.totalTime);
    out.prep = prep || ''; out.cook = cook || (total > prep ? total - prep : '');
    const kw = v => [].concat(v || []).flatMap(x => String(x).split(/[,;]/));
    out.cats = [...kw(r.recipeCategory), ...kw(r.keywords), ...kw(r.recipeCuisine)].map(x => clean(x).toLowerCase()).filter(Boolean);
  }
  const texts = sel => [...doc.querySelectorAll(sel)].map(e => clean(e.innerHTML).replace(/\n+/g, ' ')).filter(Boolean);
  if (!out.ingredients.length) out.ingredients = texts('[itemprop="recipeIngredient"],[itemprop="ingredients"]');
  if (!out.ingredients.length) out.ingredients = texts('.wprm-recipe-ingredient, .tasty-recipes-ingredients li, .mv-create-ingredients li');
  if (!out.steps.length) out.steps = texts('[itemprop="recipeInstructions"] li, [itemprop="recipeInstructions"] p');
  if (!out.steps.length) out.steps = texts('[itemprop="recipeInstructions"], .wprm-recipe-instruction-text, .tasty-recipes-instructions li, .mv-create-instructions li');
  if (!out.title) out.title = clean(meta('og:title') || doc.querySelector('h1')?.textContent || doc.title).replace(/\s+[|–-]\s+[^|–-]+$/, '');
  if (!out.photoUrl) out.photoUrl = imageUrl(meta('og:image'), url);
  return out;
}
/* tick the meal and tags that the source page names, where they match ours */
function suggest(cats) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/s\b/g, '').trim();
  const alias = { 'main dish': 'dinner', 'main course': 'dinner', 'entree': 'dinner', 'main': 'dinner', 'side dish': 'side', 'side': 'side', 'brunch': 'breakfast', 'starter': 'appetizer', 'snack': 'appetizer', 'meal prep': 'easy meal prep', 'make ahead': 'easy meal prep', 'weeknight': 'quick weeknight', 'autumn': 'fall', '4th of july': 'fourth of july' };
  const have = new Set(cats.map(norm).flatMap(c => [c, alias[c]].filter(Boolean)));
  const hit = name => { const n = norm(name); return n && have.has(n); };
  return {
    mealTypes: state.settings.mealTypes.filter(m => hit(m.name)).map(m => m.id),
    tags: state.settings.groups.flatMap(g => g.tags).filter(t => hit(t.name)).map(t => t.id),
  };
}
function applyImport(p, url) {
  if (p.title) draft.title = p.title;
  if (p.ingredients.length) draft.ingredients = p.ingredients.join('\n');
  if (p.steps.length) draft.steps = p.steps.join('\n\n');
  if (p.servings) { draft.servings = p.servings; draft.servingsUnit = p.servingsUnit; }
  if (p.prep) draft.prep = p.prep;
  if (p.cook) draft.cook = p.cook;
  if (url) draft.sourceUrl = url;
  const s = suggest(p.cats || []);
  draft.mealTypes = [...new Set([...draft.mealTypes, ...s.mealTypes])];
  draft.tags = [...new Set([...draft.tags, ...s.tags])];
}
async function importFromLink() {
  let url = $('#importUrl').value.trim();
  if (!url) { $('#importUrl').focus(); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { renderEditorKeep({ bad: true, text: 'That does not look like a web address.' }); return; }
  const btn = $('#importBtn'); btn.disabled = true; btn.textContent = 'Reading…';
  const m = $('#importMsg'); m.hidden = false; m.className = 'msg'; m.textContent = 'Fetching the page. This can take a few seconds.';
  syncDraft();
  const { html, sawPage } = await fetchPage(url);
  const p = html ? parseRecipeHtml(html, url) : null;
  if (!location.hash.startsWith('#/add')) return;          // left the page while waiting
  if (!p || (!p.ingredients.length && !p.steps.length)) {
    draft.sourceUrl = url;
    if (p?.title && sawPage) draft.title = draft.title || p.title;
    renderEditor({ bad: true, openPaste: true, text: sawPage
      ? 'That page opened, but its ingredients and steps could not be read automatically. Paste the recipe text below instead.'
      : 'That site did not let the page through. Some sites block this. Paste the recipe text below instead.' });
    return;
  }
  applyImport(p, url);
  const got = `${plural(p.ingredients.length, 'ingredient')} and ${plural(p.steps.filter(s => !isHeading(s)).length, 'step')}`;
  renderEditor({ text: `Filled in ${got} from ${hostOf(url)}. Getting the picture…` });
  if (p.photoUrl) {
    const data = await fetchPhoto(p.photoUrl);
    if (draft && !draft.id && draft.sourceUrl === url) { syncDraft(); draft.photo = data || p.photoUrl; }
  }
  if (location.hash.startsWith('#/add') && draft?.sourceUrl === url)
    renderEditor({ text: `Filled in ${got} from ${hostOf(url)}. Check it over, pick the meal and tags, then save.` });
}
function renderEditorKeep(msg) { syncDraft(); renderEditor(msg); }

/* ---------- pasted text ---------- */
function parsePastedText(text) {
  const raw = text.split(/\r?\n/).map(l => l.trim());
  const H = { ing: /^(?:ingredients?)\s*:?$/i, steps: /^(?:instructions?|directions?|method|steps|preparation|how to make(?: it)?)\s*:?$/i, notes: /^(?:recipe\s+)?(?:notes?|tips?)\s*:?$/i, stop: /^(?:nutrition(?:\s+\w+)*|equipment|video|did you make this.*)\s*:?$/i };
  const bullet = l => l.replace(/^[-•*▢☐□■▪◦·]\s*/, '');
  const out = { title: '', ingredients: [], steps: [], notes: [], cats: [], photoUrl: '', servings: '', servingsUnit: 'servings', prep: '', cook: '' };
  let sec = 'head', sawHeading = false;
  for (const l of raw) {
    if (!l) continue;
    if (H.ing.test(l)) { sec = 'ing'; sawHeading = true; continue; }
    if (H.steps.test(l)) { sec = 'steps'; sawHeading = true; continue; }
    if (H.notes.test(l)) { sec = 'notes'; continue; }
    if (H.stop.test(l)) { sec = 'skip'; continue; }
    if (sec === 'head') { if (!out.title && l.length < 110) out.title = l; }
    else if (sec === 'ing') out.ingredients.push(bullet(l));
    else if (sec === 'steps') { if (!/^step\s*\d+\s*:?$/i.test(l)) out.steps.push(bullet(l).replace(/^(?:step\s*)?\d+\s*[.):]\s+/i, '')); }
    else if (sec === 'notes') out.notes.push(bullet(l));
  }
  if (!sawHeading) {                      // no headings: lines that start with an amount are ingredients
    const body = raw.filter(Boolean); out.title = ''; out.ingredients = []; out.steps = [];
    const qty = l => QTY_RE.test(bullet(l)) && l.length < 90 && !/^\d+\s*[.)]\s/.test(l);
    body.forEach((l, i) => {
      if (i === 0 && !qty(l) && l.length < 110) out.title = l;
      else if (qty(l)) out.ingredients.push(bullet(l));
      else out.steps.push(bullet(l).replace(/^(?:step\s*)?\d+\s*[.):]\s+/i, ''));
    });
  }
  return out;
}
function fillFromPaste() {
  const text = $('#pasteText').value;
  if (!text.trim()) { $('#pasteText').focus(); return; }
  syncDraft();
  const p = parsePastedText(text);
  if (!p.ingredients.length && !p.steps.length) { renderEditor({ bad: true, openPaste: true, text: 'No ingredients or steps were found in that text.' }); return; }
  const url = $('#importUrl').value.trim();
  if (p.title && draft.title) p.title = '';
  applyImport(p, /^https?:\/\//i.test(url) ? url : '');
  if (p.notes.length && !draft.notes) draft.notes = p.notes.join('\n');
  renderEditor({ text: `Filled in ${plural(p.ingredients.length, 'ingredient')} and ${plural(p.steps.length, 'step')}. Check it over, pick the meal and tags, then save.` });
}

/* ================= Grocery list ================= */
function viewGrocery() {
  document.title = 'Grocery list';
  const g = state.grocery;
  const groups = new Map();
  for (const it of g) { const k = it.recipeTitle || ''; (groups.get(k) || groups.set(k, []).get(k)).push(it); }
  const left = g.filter(i => !i.done).length;
  app.innerHTML = `<div class="wrap narrow">
    <div class="bar"><a class="back" href="#/">Recipes</a></div>
    <div class="pagehead"><h1>Grocery list</h1><p>${g.length ? (left ? `${plural(left, 'thing')} left to pick up` : 'Everything is checked off') : 'Nothing on the list yet'}</p></div>
    <form class="addline" id="gform"><input type="text" id="gnew" placeholder="Add something, like milk" aria-label="Add an item" autocomplete="off"><button class="btn">Add</button></form>
    <ul class="glist">${[...groups].map(([name, items]) => `
      <h3>${name ? esc(name) : 'Other things'}</h3>
      ${items.map(i => `<li><button class="tick" data-act="g-tick" data-id="${i.id}" aria-pressed="${i.done}">${esc(i.text)}</button><button class="rm" data-act="g-rm" data-id="${i.id}" aria-label="Remove ${esc(i.text)}">×</button></li>`).join('')}`).join('')}</ul>
    ${g.length ? `<div class="endlinks">${g.some(i => i.done) ? '<button class="link" data-act="g-clear-done">Remove checked</button>' : ''}<button class="link" data-act="g-clear">Clear the whole list</button></div>`
      : '<p class="hint" style="text-align:center;margin-top:26px">Open a recipe and tap “Add to grocery list” to send its ingredients here.</p>'}
  </div>`;
  $('#gform').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('#gnew').value.trim(); if (!text) return;
    state.grocery.push({ id: uid(), text, done: false, recipeId: '', recipeTitle: '' });
    saveGrocery(); viewGrocery(); $('#gnew').focus();
  });
}

/* ================= Tags and settings ================= */
function usage(kind, id) { return state.recipes.filter(r => (r[kind] || []).includes(id)).length; }
function viewSettings() {
  document.title = 'Tags';
  const s = state.settings;
  const chip = (act, t, extra = '') => `<span class="chip"><button data-act="${act}-rename" data-id="${t.id}" ${extra} aria-label="Rename ${esc(t.name)}">${esc(t.name)}</button><button class="x" data-act="${act}-rm" data-id="${t.id}" ${extra} aria-label="Remove ${esc(t.name)}">×</button></span>`;
  app.innerHTML = `<div class="wrap narrow">
    <div class="bar"><a class="back" href="#/">Recipes</a></div>
    <div class="pagehead"><h1>Tags</h1><p>Tap a name to rename it, × to remove it</p></div>

    <div class="panel"><h2>Meals</h2><p class="sub">These are the tabs across the top of your book.</p>
      <div class="chips tone-m">${s.mealTypes.map(m => chip('meal', m)).join('')}</div>
      <form class="addline" data-form="meal"><input type="text" placeholder="Add a meal, like Drinks" aria-label="New meal"><button class="btn small">Add</button></form>
    </div>

    ${s.groups.map((g, gi) => `<div class="panel">
      <div class="head"><h2>${esc(g.name)}</h2><span><button class="link" data-act="group-rename" data-g="${g.id}">Rename</button> &nbsp; <button class="link" data-act="group-rm" data-g="${g.id}">Remove</button></span></div>
      <div class="chips tone-${gi % 4}">${g.tags.map(t => chip('tag', t, `data-g="${g.id}"`)).join('') || '<span class="hint">No tags here yet.</span>'}</div>
      <form class="addline" data-form="tag" data-g="${g.id}"><input type="text" placeholder="Add a tag" aria-label="New tag in ${esc(g.name)}"><button class="btn small">Add</button></form>
    </div>`).join('')}
    <div class="stack"><button class="btn quiet" data-act="group-add">Add a new group of tags</button></div>

    <div class="panel"><h2>Your book</h2>
      <label class="field"><span>Name on the cover</span><input type="text" id="bookTitle" value="${esc(s.bookTitle)}"></label>
      <p class="sub" style="margin-top:16px">${plural(state.recipes.length, 'recipe')} saved on this device. Keep a backup file somewhere safe: it is the only other copy.</p>
      <div class="stack">
        <button class="btn quiet" data-act="backup">Save a backup file</button>
        <label class="btn plain" tabindex="0">Restore from a backup file<input type="file" id="restore" accept="application/json,.json" hidden></label>
      </div>
    </div>

    <div class="panel"><h2>Link import helper</h2>
      <p class="sub">Leave this empty unless importing from links stops working. If you set up your own helper (see the README), paste its address here.</p>
      <label class="field"><span>Helper address</span><input type="url" id="helperUrl" inputmode="url" value="${esc(s.helperUrl)}" placeholder="https://"></label>
    </div>
  </div>`;
  $('#bookTitle').addEventListener('change', e => { s.bookTitle = e.target.value.trim() || 'The Recipe Book'; saveSettings(); toast('Saved'); });
  $('#helperUrl').addEventListener('change', e => { s.helperUrl = e.target.value.trim(); saveSettings(); toast('Saved'); });
  $('#restore').addEventListener('change', e => restore(e.target.files[0]));
  $$('form[data-form]').forEach(f => f.addEventListener('submit', e => {
    e.preventDefault();
    const name = $('input', f).value.trim(); if (!name) return;
    if (f.dataset.form === 'meal') s.mealTypes.push(mk(name));
    else s.groups.find(g => g.id === f.dataset.g)?.tags.push(mk(name));
    saveSettings(); viewSettings();
  }));
}
async function stripFromRecipes(kind, id) {
  for (const r of state.recipes) if ((r[kind] || []).includes(id)) { r[kind] = r[kind].filter(x => x !== id); await putRecipe(r); }
}
async function backup() {
  const data = JSON.stringify({ app: 'recipe-book', version: 1, saved: new Date().toISOString(), settings: state.settings, recipes: state.recipes, grocery: state.grocery });
  const name = `recipe-book-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([data], name, { type: 'application/json' });
  try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; } }
  catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function restore(file) {
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file could not be read'); return; }
  if (data?.app !== 'recipe-book' || !Array.isArray(data.recipes)) { toast('That is not a recipe book backup'); return; }
  if (!confirm(`Replace everything in this book with the ${plural(data.recipes.length, 'recipe')} in the backup?`)) return;
  await tx('recipes', 'readwrite', s => { s.clear(); data.recipes.forEach(r => s.put(r)); });
  state.recipes = data.recipes; state.settings = { ...defaults(), ...data.settings }; state.grocery = data.grocery || [];
  await saveSettings(); saveGrocery();
  toast('Backup restored'); viewSettings();
}

/* ================= Clicks ================= */
const acts = {
  'toggle-filter'() { ui.open = !ui.open; $('#filterPanel').hidden = !ui.open; $('#filterBtn').setAttribute('aria-expanded', ui.open); },
  'meal'(b) { ui.meal = b.dataset.id; updateHome(); },
  'f-tag'(b) { const id = b.dataset.id; ui.tags.has(id) ? ui.tags.delete(id) : ui.tags.add(id); updateHome(); },
  'f-fav'() { ui.fav = !ui.fav; updateHome(); },
  'f-everyday'() { ui.everyday = !ui.everyday; updateHome(); },
  'f-time'(b) { const v = +b.dataset.v; ui.time = ui.time === v ? 0 : v; updateHome(); },
  'f-clear'() { ui.tags.clear(); ui.fav = ui.everyday = false; ui.time = 0; updateHome(); },
  'f-reset'() { ui.tags.clear(); ui.fav = ui.everyday = false; ui.time = 0; ui.q = ''; ui.meal = 'all'; $('#q').value = ''; updateHome(); },

  async 'fav'(b) { const r = state.recipes.find(x => x.id === b.dataset.id); r.favorite = !r.favorite; b.setAttribute('aria-pressed', r.favorite); await putRecipe(r); toast(r.favorite ? 'Added to favorites' : 'Removed from favorites'); },
  'strike'(b) { const i = +b.dataset.i; rv.struck.has(i) ? rv.struck.delete(i) : rv.struck.add(i); b.setAttribute('aria-pressed', rv.struck.has(i)); },
  'serv'(b) { stepServings(state.recipes.find(x => x.id === rv.id), +b.dataset.d); },
  'to-grocery'(b) { grocerySheet(state.recipes.find(x => x.id === b.dataset.id)); },
  'cook-next'() { cook.i++; renderCook(); },
  'cook-prev'() { cook.i--; renderCook(); },
  'cook-ings'() { cook.ings = !cook.ings; renderCook(); },

  'd-meal'(b) { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); },
  'd-tag'(b) { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); },
  'd-newtag'(b) {
    const g = state.settings.groups.find(x => x.id === b.dataset.g);
    const name = prompt(`New tag in ${g.name}`)?.trim(); if (!name) return;
    const t = mk(name); g.tags.push(t); saveSettings();
    syncDraft(); draft.tags.push(t.id);
    const y = scrollY; renderEditor(); scrollTo(0, y);
  },
  'photo-remove'() { syncDraft(); draft.photo = ''; const y = scrollY; renderEditor(); scrollTo(0, y); },
  'import'() { importFromLink(); },
  'paste-fill'() { fillFromPaste(); },
  'save'() { saveDraft(); },
  async 'delete'(b) {
    const r = state.recipes.find(x => x.id === b.dataset.id);
    if (!confirm(`Delete “${r.title}”? This cannot be undone.`)) return;
    await delRecipe(r.id); state.recipes = state.recipes.filter(x => x.id !== r.id); draft = null;
    toast('Recipe deleted'); location.hash = '#/';
  },

  'g-tick'(b) { const it = state.grocery.find(i => i.id === b.dataset.id); it.done = !it.done; saveGrocery(); viewGrocery(); },
  'g-rm'(b) { state.grocery = state.grocery.filter(i => i.id !== b.dataset.id); saveGrocery(); viewGrocery(); },
  'g-clear-done'() { state.grocery = state.grocery.filter(i => !i.done); saveGrocery(); viewGrocery(); },
  'g-clear'() { if (confirm('Clear the whole grocery list?')) { state.grocery = []; saveGrocery(); viewGrocery(); } },

  'meal-rename'(b) { const m = state.settings.mealTypes.find(x => x.id === b.dataset.id); const n = prompt('Rename this meal', m.name)?.trim(); if (n) { m.name = n; saveSettings(); viewSettings(); } },
  async 'meal-rm'(b) {
    const m = state.settings.mealTypes.find(x => x.id === b.dataset.id), n = usage('mealTypes', m.id);
    if (!confirm(`Remove “${m.name}”?${n ? ` It comes off ${plural(n, 'recipe')}. The recipes themselves stay.` : ''}`)) return;
    state.settings.mealTypes = state.settings.mealTypes.filter(x => x.id !== m.id);
    await stripFromRecipes('mealTypes', m.id); if (ui.meal === m.id) ui.meal = 'all';
    saveSettings(); viewSettings();
  },
  'tag-rename'(b) { const t = state.settings.groups.find(g => g.id === b.dataset.g).tags.find(x => x.id === b.dataset.id); const n = prompt('Rename this tag', t.name)?.trim(); if (n) { t.name = n; saveSettings(); viewSettings(); } },
  async 'tag-rm'(b) {
    const g = state.settings.groups.find(x => x.id === b.dataset.g), t = g.tags.find(x => x.id === b.dataset.id), n = usage('tags', t.id);
    if (!confirm(`Remove “${t.name}”?${n ? ` It comes off ${plural(n, 'recipe')}. The recipes themselves stay.` : ''}`)) return;
    g.tags = g.tags.filter(x => x.id !== t.id); ui.tags.delete(t.id);
    await stripFromRecipes('tags', t.id); saveSettings(); viewSettings();
  },
  'group-rename'(b) { const g = state.settings.groups.find(x => x.id === b.dataset.g); const n = prompt('Rename this group', g.name)?.trim(); if (n) { g.name = n; saveSettings(); viewSettings(); } },
  async 'group-rm'(b) {
    const g = state.settings.groups.find(x => x.id === b.dataset.g);
    if (!confirm(`Remove the whole “${g.name}” group and its ${plural(g.tags.length, 'tag')}? The recipes themselves stay.`)) return;
    for (const t of g.tags) { ui.tags.delete(t.id); await stripFromRecipes('tags', t.id); }
    state.settings.groups = state.settings.groups.filter(x => x.id !== g.id); saveSettings(); viewSettings();
  },
  'group-add'() { const n = prompt('Name the new group, like Cuisine or Who it is for')?.trim(); if (n) { state.settings.groups.push({ id: uid(), name: n, occasion: false, tags: [] }); saveSettings(); viewSettings(); } },
  'backup'() { backup(); },
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const fn = acts[b.dataset.act];
  if (fn) { e.preventDefault(); fn(b); }
});
document.addEventListener('keydown', e => {            // labels that act as buttons
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('label.btn')) { e.preventDefault(); e.target.click(); }
});

/* ================= Router ================= */
let lastRoute = '';
function route() {
  const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (lastRoute === '' && name) homeScroll = scrollY;
  stopCook();
  const page = name || 'home';
  if (page === 'recipe') viewRecipe(id);
  else if (page === 'add') viewEditor(null);
  else if (page === 'edit') viewEditor(id);
  else if (page === 'grocery') viewGrocery();
  else if (page === 'settings') viewSettings();
  else if (page === 'cook') viewCook(id);
  else viewHome();
  const navKey = { recipe: 'home', cook: 'home', edit: 'home' }[page] || page;
  $$('#nav a').forEach(a => a.dataset.nav === navKey ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  scrollTo(0, page === 'home' ? homeScroll : 0);
  lastRoute = name || '';
}
addEventListener('hashchange', route);

/* ================= Start ================= */
(async function start() {
  try {
    const [settings, recipes, grocery] = await Promise.all([kvGet('settings'), allRecipes(), kvGet('grocery')]);
    state.settings = settings || defaults();
    if (!settings) await saveSettings();
    state.recipes = recipes || []; state.grocery = grocery || [];
  } catch {
    state.settings = defaults();
    toast('Saving is turned off in this browser, so recipes will not be kept');
  }
  groceryDot();
  route();
  try { navigator.storage?.persist?.(); } catch { }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();

})();
