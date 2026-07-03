// canvas.js — CA-5 (DESIGN_canvas.md §3): the Canvas TAB — an app's roomy presentation surface. Reads the per-anchor
// CanvasSpec (CanvasStore) and renders the CLOSED, safe vocabulary: markdown (escape-FIRST via markdown.js), metric
// tiles, hand-rolled SVG charts from a DATA spec (never code), sanitized <img>, an editable compose region. Live: it
// subscribes to chrome.storage.onChanged for its key, diffs the new spec against the painted one (canvasSpec.diffSpec)
// and animates the delta WITHOUT clobbering a focused editor. No build step → ESM imports straight from source.

import { loadCanvasSpec, writeCanvasSpec } from './Services/Storage/CanvasStore.js';
import { canvasDocId, normalizeCanvasSpec, newCanvasSpec, diffSpec, setBlockText } from './Core/canvasSpec.js';
import { builtinApp } from './Core/appCatalog.js';
// v2.74.1341 (review G) — markdown renders through the SHARED lowering (canvasLower.mdToHtml: escape-first, the
// same parser as the gdoc preview + the delivery HTML), so inline `![alt](kb:…)` images and `[title](kb:N)` source
// links RESOLVE from the trusted banked map on the tab too. The chat renderer (markdown.js renderMarkdown) had no
// image rule and its isSafeUrl refused kb: targets — refs rendered as literal text on the tab backend, while
// BACKEND_PROFILES claimed tab all-native.
import { mdToHtml } from './Core/canvasLower.js';
import { mergedRefMap } from './Core/sourceBank.js';

// ── the anchor, from the hash (#app=<appId>&conv=<conversationId>) ──
function _anchorFromHash() {
  const p = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  return { appId: p.get('app') || null, conversationId: p.get('conv') || null };
}
const _anchor = _anchorFromHash();
const _storageKey = `canvas:${canvasDocId(_anchor)}`;

// v2.74.1341 (review G) — the app's banked source ref→url map (same store the SW reads), so inline kb: refs in
// markdown text resolve on the TAB backend too. Loaded at boot, refreshed when the bank changes.
const _srcKey = _anchor.appId ? `canvas:sources:${_anchor.appId}` : null;
let _refMap = {};
async function _loadRefMap() {
  if (!_srcKey) return;
  try { const got = await chrome.storage.local.get(_srcKey); _refMap = mergedRefMap(Array.isArray(got[_srcKey]) ? got[_srcKey] : []); } catch { /* */ }
}

const $root = document.getElementById('cv-root');
const $title = document.getElementById('cv-title');
const $meta = document.getElementById('cv-meta');

let _current = newCanvasSpec({ anchor: _anchor });   // what's painted now (the diff baseline)
let _selfWriting = false;                            // suppress the storage echo of our OWN compose edit

// v2.74.1341 (review P1-4) — the edit save is a CAS write: this tab and the SW are DIFFERENT JS contexts, so the
// store's RMW chain (per-context) cannot order a textarea save against a compose-in-flight — an unconditional write
// here used to REVERT a concurrent SW render (rev clobber). Write against the rev we derived from; a refusal means
// a newer spec landed since — REBASE (re-read, re-apply the user's text onto it) and retry, so neither side's write
// is silently reverted.
async function _saveEdit(blockId, text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = attempt === 0 ? _current : ((await loadCanvasSpec(_anchor).catch(() => null)) || _current);
    const next = setBlockText(base, blockId, text);
    _selfWriting = true;
    let stored = null;
    try { stored = await writeCanvasSpec(_anchor, next, { ifRev: base.rev }); } catch { stored = null; }
    if (stored) {
      if (attempt > 0) {   // we rebased over someone else's write — paint THEIR block changes too (ours diffs to nothing)
        const d = diffSpec(_current, stored);
        if (d.added.length || d.removed.length || d.changed.length || d.moved.length) _applyDiff(stored, d);
      }
      _current = stored;   // rev advances locally so the NEXT save's CAS is against reality
      return;
    }
    _selfWriting = false;   // a refused write emits no storage event — don't swallow the next real one
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The app's presentation DEFAULT — shown until a real DISPLAY stores a spec (Core/appDef.presentation, opaque blocks).
function _defaultSpec() {
  let pres = null, name = '';
  try { const def = builtinApp(_anchor.appId); pres = def && def.presentation; name = (def && def.name) || ''; } catch { /* */ }
  return newCanvasSpec({ anchor: _anchor, title: (pres && pres.title) || name || 'Canvas', blocks: (pres && pres.blocks) || [] });
}

// A chart as a hand-rolled SVG from the DATA spec ({ labels[], series:[{name,values[]}] }). No third-party code —
// numbers + escaped labels only, so the closed-vocabulary safety holds. First series; bar | line | area.
function _chartSvg(block) {
  const data = (block && block.data) || {};
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const s0 = Array.isArray(data.series) && data.series[0] && Array.isArray(data.series[0].values) ? data.series[0].values : (Array.isArray(data.values) ? data.values : []);
  const series = s0.map(Number).filter((v) => Number.isFinite(v));
  if (!series.length) return '<div class="cv-chart-empty">no data</div>';
  const W = 540, H = 200, padL = 10, padR = 10, padT = 12, padB = 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(...series, 0), min = Math.min(...series, 0), span = (max - min) || 1;
  const x = (i) => padL + (series.length === 1 ? iw / 2 : (i * iw) / (series.length - 1));
  const y = (v) => padT + ih - ((v - min) / span) * ih;
  const type = block.chartType || 'line';
  let body = '';
  if (type === 'bar') {
    body = series.map((v, i) => {
      const bw = Math.max(4, (iw / series.length) * 0.6);
      const bx = padL + (i + 0.5) * (iw / series.length) - bw / 2;
      const by = y(Math.max(v, 0)), bh = Math.max(1, Math.abs(y(v) - y(0)));
      return `<rect class="cv-bar" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2"/>`;
    }).join('');
  } else {
    const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    if (type === 'area') body += `<polygon class="cv-area" points="${padL.toFixed(1)},${(padT + ih).toFixed(1)} ${pts} ${(padL + iw).toFixed(1)},${(padT + ih).toFixed(1)}"/>`;
    body += `<polyline class="cv-line" fill="none" points="${pts}"/>`;
    body += series.map((v, i) => `<circle class="cv-dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5"/>`).join('');
  }
  const ticks = labels.slice(0, series.length).map((l, i) => `<text class="cv-xlabel" x="${x(i).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(l)}</text>`).join('');
  return `<svg class="cv-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="chart">${body}${ticks}</svg>`;
}

// Build one block's DOM node (keyed by data-id so live updates are surgical).
function _blockNode(block) {
  const el = document.createElement('div');
  el.className = `cv-block cv-${block.kind}`;
  el.dataset.id = block.id;
  if (block.kind === 'markdown') {
    el.innerHTML = mdToHtml(block.text, { refMap: _refMap });   // escape-FIRST (shared lowering) — untrusted text renders inert; kb: refs resolve from the trusted map
    for (const a of el.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }   // links leave the canvas tab alone
  } else if (block.kind === 'metric') {
    const dn = (block.delta != null && block.delta !== '');
    const dir = dn && String(block.delta).trim().startsWith('-') ? 'down' : 'up';
    el.innerHTML = `<div class="cv-metric-label">${esc(block.label)}</div><div class="cv-metric-value">${esc(block.value)}${dn ? ` <span class="cv-delta ${dir}">${esc(block.delta)}</span>` : ''}</div>`;
  } else if (block.kind === 'chart') {
    el.innerHTML = _chartSvg(block);
  } else if (block.kind === 'image') {
    if (block.src) {                                             // GD-7e — a ref-only image (unresolved) renders its alt as a visible placeholder, never a broken img
      const img = document.createElement('img');
      img.className = 'cv-img'; img.src = block.src; img.alt = block.alt || '';   // src already sanitized by normalizeBlock
      el.appendChild(img);
    } else {
      el.textContent = `[image: ${block.alt || 'image'}]`;
    }
  } else if (block.kind === 'video') {
    // GD-7e (v2.74.1330) — the video tile: a LINK-OUT card (▶ label → opens the video), never an inline <video>/iframe
    // (no autoplay/embed surface on the canvas; the profile's "native" = a real, clickable representation).
    if (block.src) {
      const a = document.createElement('a');
      a.className = 'cv-video'; a.href = block.src; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = `▶ ${block.label || 'video'}`;
      el.appendChild(a);
    } else {
      el.textContent = `[video: ${block.label || 'video'}]`;
    }
  } else if (block.kind === 'compose') {
    const ta = document.createElement('textarea');
    ta.className = 'cv-compose-input'; ta.value = block.text || ''; ta.setAttribute('aria-label', 'Editable draft');
    let t = null;
    ta.addEventListener('input', () => {
      _current = setBlockText(_current, block.id, ta.value);   // update LOCAL first → our storage echo diffs to nothing
      if (t) clearTimeout(t);
      t = setTimeout(() => { _saveEdit(block.id, ta.value); }, 400);
    });
    el.appendChild(ta);
  }
  return el;
}

function _setMeta(spec) {
  $title.textContent = spec.title || 'Canvas';
  $meta.textContent = `${spec.blocks.length} block${spec.blocks.length === 1 ? '' : 's'}${_anchor.appId ? ` · ${esc(_anchor.appId)}` : ''}`;
}

function _renderAll(spec) {
  _setMeta(spec);
  $root.textContent = '';
  if (!spec.blocks.length) { const e = document.createElement('div'); e.className = 'cv-empty'; e.textContent = 'Nothing here yet — this app composes its view here.'; $root.appendChild(e); return; }
  for (const b of spec.blocks) $root.appendChild(_blockNode(b));
}

// Surgical update from a diff: replace changed blocks in place (flash), fade removed, slide in added, reorder only
// when the structure changed — so a pure metric refresh keeps a focused compose editor untouched.
function _applyDiff(next, d) {
  const byId = (id) => $root.querySelector(`[data-id="${CSS.escape(id)}"]`);
  for (const b of d.removed) { const n = byId(b.id); if (n) { n.classList.add('cv-leave'); setTimeout(() => n.remove(), 220); } }
  for (const c of d.changed) { const n = byId(c.id); if (n) { const f = _blockNode(c.next); f.classList.add('cv-changed'); n.replaceWith(f); } }
  if (d.added.length || d.moved.length || d.removed.length) {
    for (const b of next.blocks) { let n = byId(b.id); if (!n) { n = _blockNode(b); n.classList.add('cv-enter'); } $root.appendChild(n); }   // appendChild reorders existing nodes
  }
  if (!next.blocks.length) { _renderAll(next); return; }
  _setMeta(next);
}

async function _boot() {
  if (!_anchor.appId && !_anchor.conversationId) {
    _renderAll(newCanvasSpec({ anchor: _anchor, title: 'Canvas', blocks: [{ id: 'hint', kind: 'markdown', text: 'Open the canvas from an app conversation (the `canvas` command).' }] }));
    return;
  }
  let spec = null;
  await _loadRefMap();
  try { spec = await loadCanvasSpec(_anchor); } catch { /* */ }
  _current = spec || _defaultSpec();
  _renderAll(_current);
}

// Live: the storage write IS the broadcast (chrome.storage.onChanged fires in every extension context).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (_srcKey && changes[_srcKey]) _loadRefMap();   // v1341 — a re-banked source refreshes the resolve map for the next paint
  if (!changes[_storageKey]) return;
  if (_selfWriting) { _selfWriting = false; return; }   // our own compose write — already on screen
  const rec = changes[_storageKey].newValue;
  const next = normalizeCanvasSpec(rec && rec.spec);
  const d = diffSpec(_current, next);
  if (d.added.length || d.removed.length || d.changed.length || d.moved.length) _applyDiff(next, d);
  _current = next;
});

window.addEventListener('hashchange', () => location.reload());   // anchor changed → re-boot cleanly
_boot();
