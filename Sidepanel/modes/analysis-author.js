/**
 * @file Sidepanel/modes/analysis-author.js
 * @description Sidepanel mode for authoring a named Analysis. Layout
 * mirrors fragment-author / observation-author:
 *
 *   [Banner]
 *   [Warning area]
 *   [Preconditions card     ] collapsible
 *   [Data inputs card       ] collapsible — pick bindings from
 *                              observations on this Ground; selected
 *                              ones render as chips
 *   [Operations list card   ] collapsible — + Operation footer; each
 *                              op card has a type dropdown (filter,
 *                              sort, take, group [stub], pluck [stub])
 *                              with per-type fields
 *   [Results card           ] collapsible — result binding name + type
 *                              dropdown (text, list, image, image_list,
 *                              section)
 *   [Postconditions card    ] collapsible
 *   [Name card              ] HIDDEN until Done; inline Save button
 *   [Bottom action row      ] Done (reveals Name card + collapses
 *                              everything else) / Cancel (exits)
 *
 * On Save the record stored is:
 *   {
 *     id, groundId, name, description,
 *     params: <auto-detected {{TOKENS}} from operations + result>,
 *     implementations: [{ tier: 'cache', body: { kind: 'operations',
 *                          inputs, operations } }],
 *     result: { name, type },
 *     preconditions, postconditions,
 *   }
 *
 * Pre/post conditions are layout-parity placeholders in v1 — the
 * cards render but no inline editor is wired. Conditions remain
 * authorable in Studio's full Analysis form.
 *
 * @module Sidepanel/modes/analysis-author
 * @version 2.74.63
 */

import { toast, exitToStudio, requestModeChange } from '../shell-api.js';

// ─── Op + result-type catalogs ────────────────────────────────────────────

const OPERATIONS = [
  { id: 'filter', label: 'filter', stub: false },
  { id: 'sort',   label: 'sort',   stub: false },
  { id: 'take',   label: 'take',   stub: false },
  { id: 'group',  label: 'group',  stub: true  },
  { id: 'pluck',  label: 'pluck',  stub: true  },
];

const RESULT_TYPES = [
  { id: 'text',       label: 'text' },
  { id: 'list',       label: 'list' },
  { id: 'image',      label: 'image' },
  { id: 'image_list', label: 'image_list' },
  { id: 'section',    label: 'section' },
];

const FILTER_COMPARATORS = [
  { id: 'eq',          label: 'equals' },
  { id: 'ne',          label: 'not equals' },
  { id: 'gt',          label: '>' },
  { id: 'gte',         label: '>=' },
  { id: 'lt',          label: '<' },
  { id: 'lte',         label: '<=' },
  { id: 'contains',    label: 'contains' },
  { id: 'starts_with', label: 'starts with' },
  { id: 'ends_with',   label: 'ends with' },
];

const SORT_DIRECTIONS = [
  { id: 'asc',  label: 'ascending'  },
  { id: 'desc', label: 'descending' },
];

const SORT_COERCE = [
  { id: 'string', label: 'as string' },
  { id: 'number', label: 'as number' },
  { id: 'date',   label: 'as date'   },
];

// ─── Helpers ──────────────────────────────────────────────────────────────

const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escAttr = escHtml;

function _uid() { return `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

// Scan operations + result for {{NAME}} placeholders → params array.
function _extractParams(draft) {
  const seen = new Set();
  const re   = /\{\{([A-Z0-9_]+)\}\}/g;
  const visit = (s) => {
    if (typeof s !== 'string') return;
    let m;
    while ((m = re.exec(s)) !== null) seen.add(m[1]);
  };
  for (const op of draft.body.operations) {
    for (const v of Object.values(op)) visit(v);
  }
  visit(draft.result.name);
  return [...seen].sort();
}

// ─── State ────────────────────────────────────────────────────────────────

let _mountEl = null;
let _payload = null;
let _tabId = null;
let _draft = null;
let _returnTo = null;
let _isEdit = false;
// Bindings available to "Data inputs" — pulled from the Ground's
// observations (each extract's `output` name).
let _availableBindings = [];

// DOM refs
let bannerTitleEl, warningEl;
let preCardEl, preToggleBtnEl, preToggleGlyphEl, preListEl;
let dataCardEl, dataToggleBtnEl, dataToggleGlyphEl, dataSelectEl, dataChipsEl;
let opsCardEl, opsToggleBtnEl, opsToggleGlyphEl, opsListEl, addOpBtnEl;
let resultCardEl, resultToggleBtnEl, resultToggleGlyphEl, resultNameEl, resultTypeEl;
let postCardEl, postToggleBtnEl, postToggleGlyphEl, postListEl;
let nameCardEl, nameInputEl, saveBtnEl;
let doneRevealBtnEl, cancelBtnEl;

let _preCardCollapsed = false;
let _dataCardCollapsed = false;
let _opsCardCollapsed = false;
let _resultCardCollapsed = false;
let _postCardCollapsed = false;

// ─── Lifecycle ────────────────────────────────────────────────────────────

async function mount(payload, mountEl) {
  _mountEl  = mountEl;
  _payload  = payload ?? {};
  _tabId    = _payload.tabId ?? _payload.existingTabId ?? null;
  _returnTo = _payload.returnTo ?? null;

  const groundId = _payload.groundId;
  if (!groundId) {
    mountEl.innerHTML = `<div class="sidepanel-idle"><h3>Analysis</h3><p>No active groundId.</p></div>`;
    return;
  }

  // Hydrate draft from prefilled record (edit mode) or start fresh.
  const prefilled = _payload.prefilledAnalysis;
  if (prefilled && typeof prefilled === 'object' && prefilled.id) {
    _isEdit = true;
    const impl0 = Array.isArray(prefilled.implementations) && prefilled.implementations[0]
      ? prefilled.implementations[0] : null;
    const body  = impl0?.body ?? {};
    _draft = {
      id            : prefilled.id,
      groundId,
      name          : prefilled.name ?? '',
      description   : prefilled.description ?? '',
      body          : {
        kind       : 'operations',
        inputs     : Array.isArray(body.inputs) ? body.inputs.map(i => ({ ...i })) : [],
        operations : Array.isArray(body.operations) ? body.operations.map(op => ({ _uid: _uid(), ...op })) : [],
      },
      result        : {
        name : prefilled.result?.name ?? '',
        type : prefilled.result?.type ?? 'list',
      },
      preconditions : prefilled.preconditions  ?? { match: 'all', conditions: [] },
      postconditions: prefilled.postconditions ?? { match: 'all', conditions: [] },
    };
  } else {
    _isEdit = false;
    _draft = {
      id            : `ana_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      groundId,
      name          : '',
      description   : '',
      body          : { kind: 'operations', inputs: [], operations: [] },
      result        : { name: '', type: 'list' },
      preconditions : { match: 'all', conditions: [] },
      postconditions: { match: 'all', conditions: [] },
    };
  }

  mountEl.innerHTML = _renderHtml();
  _resolveRefs(mountEl);
  _wireStaticHandlers();
  _renderDataInputs();
  _renderOperations();
  _renderToggle('pre');
  _renderToggle('data');
  _renderToggle('ops');
  _renderToggle('result');
  _renderToggle('post');
  _updateSaveState();

  // Fetch the Ground's library so the Data inputs dropdown can list
  // available bindings (each Observation extract's `output` name).
  _loadGroundBindings();
}

async function unmount() {
  if (_mountEl) _mountEl.innerHTML = '';
  _mountEl = null;
  _payload = null;
  _tabId = null;
  _draft = null;
  _returnTo = null;
  _isEdit = false;
  _availableBindings = [];
  bannerTitleEl = warningEl = null;
  preCardEl = preToggleBtnEl = preToggleGlyphEl = preListEl = null;
  dataCardEl = dataToggleBtnEl = dataToggleGlyphEl = dataSelectEl = dataChipsEl = null;
  opsCardEl = opsToggleBtnEl = opsToggleGlyphEl = opsListEl = addOpBtnEl = null;
  resultCardEl = resultToggleBtnEl = resultToggleGlyphEl = resultNameEl = resultTypeEl = null;
  postCardEl = postToggleBtnEl = postToggleGlyphEl = postListEl = null;
  nameCardEl = nameInputEl = saveBtnEl = null;
  doneRevealBtnEl = cancelBtnEl = null;
  _preCardCollapsed = _dataCardCollapsed = _opsCardCollapsed = _resultCardCollapsed = _postCardCollapsed = false;
}

function handleEvent(_message) { /* no-op */ }

// ─── Render ───────────────────────────────────────────────────────────────

function _renderHtml() {
  return `
    <div class="dbg-locale-card">
      <div class="dbg-locale-banner">
        <span data-aa="banner-title" class="dbg-locale-banner-title">${escHtml(_isEdit ? 'Edit Analysis' : 'New Analysis')}</span>
      </div>
      <div data-aa="warning" class="dbg-locale-warning hidden"></div>

      ${_collapsibleCardHtml('pre', 'Preconditions', `
        <div data-aa="pre-list" class="fa-conditions-list">
          <div class="fa-conditions-empty">Author preconditions in Studio.</div>
        </div>
      `)}

      ${_collapsibleCardHtml('data', 'Data inputs', `
        <label class="dbg-locale-field aa-data-input-field">
          <span class="dbg-locale-field-label">Add binding</span>
          <select data-aa="data-select">
            <option value="">— pick a binding —</option>
          </select>
        </label>
        <div data-aa="data-chips" class="aa-data-chips"></div>
      `)}

      ${_collapsibleCardHtml('ops', 'Operations', `
        <div data-aa="ops-list" class="aa-ops-list"></div>
        <div class="fa-conditions-footer">
          <button data-aa="add-op" class="btn-secondary fa-add-condition-btn" type="button">+ Operation</button>
        </div>
      `)}

      ${_collapsibleCardHtml('result', 'Results', `
        <label class="dbg-locale-field">
          <span class="dbg-locale-field-label">Result name</span>
          <input type="text" data-aa="result-name" maxlength="80"
                 placeholder="e.g. FILTERED_ITEMS" value="${escAttr(_draft.result.name)}" />
        </label>
        <label class="dbg-locale-field">
          <span class="dbg-locale-field-label">Type</span>
          <select data-aa="result-type">
            ${RESULT_TYPES.map(t => `<option value="${escAttr(t.id)}" ${_draft.result.type === t.id ? 'selected' : ''}>${escHtml(t.label)}</option>`).join('')}
          </select>
        </label>
      `)}

      ${_collapsibleCardHtml('post', 'Postconditions', `
        <div data-aa="post-list" class="fa-conditions-list">
          <div class="fa-conditions-empty">Author postconditions in Studio.</div>
        </div>
      `)}

      <!-- Name card: hidden until Done. Mirrors fragment-author. -->
      <section data-aa="name-card" class="dbg-locale-meta-card fa-name-card hidden">
        <div class="fa-name-row">
          <input type="text" data-aa="name" maxlength="80"
                 placeholder="Analysis name (e.g. top-rated-items)"
                 value="${escAttr(_draft.name)}" />
          <button data-aa="save" class="btn-primary fa-name-save-btn" type="button" disabled>${escHtml(_isEdit ? 'Update' : 'Save')}</button>
        </div>
        <label class="dbg-locale-field aa-name-desc-field">
          <span class="dbg-locale-field-label">Description</span>
          <textarea data-aa="description" rows="2"
                    placeholder="What this analysis does.">${escHtml(_draft.description)}</textarea>
        </label>
      </section>

      <section class="dbg-locale-actions">
        <button data-aa="reveal-done" class="btn-primary" type="button">Done</button>
        <button data-aa="cancel" class="btn-secondary" type="button">Cancel</button>
      </section>
    </div>
  `;
}

function _collapsibleCardHtml(key, label, bodyHtml) {
  return `
    <section data-aa-card="${escAttr(key)}" class="dbg-locale-meta-card fa-conditions-card">
      <button class="fa-conditions-collapse-toggle" data-aa-toggle="${escAttr(key)}" type="button"
              title="Collapse / expand ${escAttr(label.toLowerCase())}" aria-expanded="true">
        <span class="fa-conditions-collapse-chevron" data-aa-toggle-glyph="${escAttr(key)}">▾</span>
      </button>
      <div class="fa-conditions-content">
        <div class="fa-conditions-head">
          <span class="fa-conditions-label">${escHtml(label)}</span>
        </div>
        <div class="fa-conditions-body">
          ${bodyHtml}
        </div>
      </div>
    </section>
  `;
}

function _resolveRefs(root) {
  const q = (k) => root.querySelector(`[data-aa="${k}"]`);
  bannerTitleEl   = q('banner-title');
  warningEl       = q('warning');
  preListEl       = q('pre-list');
  dataSelectEl    = q('data-select');
  dataChipsEl     = q('data-chips');
  opsListEl       = q('ops-list');
  addOpBtnEl      = q('add-op');
  resultNameEl    = q('result-name');
  resultTypeEl    = q('result-type');
  postListEl      = q('post-list');
  nameCardEl      = q('name-card');
  nameInputEl     = q('name');
  saveBtnEl       = q('save');
  doneRevealBtnEl = q('reveal-done');
  cancelBtnEl     = q('cancel');

  const qCard = (k) => root.querySelector(`[data-aa-card="${k}"]`);
  const qTog  = (k) => root.querySelector(`[data-aa-toggle="${k}"]`);
  const qGly  = (k) => root.querySelector(`[data-aa-toggle-glyph="${k}"]`);
  preCardEl       = qCard('pre');     preToggleBtnEl    = qTog('pre');    preToggleGlyphEl    = qGly('pre');
  dataCardEl      = qCard('data');    dataToggleBtnEl   = qTog('data');   dataToggleGlyphEl   = qGly('data');
  opsCardEl       = qCard('ops');     opsToggleBtnEl    = qTog('ops');    opsToggleGlyphEl    = qGly('ops');
  resultCardEl    = qCard('result');  resultToggleBtnEl = qTog('result'); resultToggleGlyphEl = qGly('result');
  postCardEl      = qCard('post');    postToggleBtnEl   = qTog('post');   postToggleGlyphEl   = qGly('post');
}

function _wireStaticHandlers() {
  nameInputEl.addEventListener('input', () => {
    _draft.name = nameInputEl.value;
    if (bannerTitleEl) bannerTitleEl.textContent = _draft.name.trim()
      ? `Authoring: "${_draft.name}"`
      : (_isEdit ? 'Edit Analysis' : 'New Analysis');
    _updateSaveState();
  });
  const descEl = _mountEl.querySelector('[data-aa="description"]');
  descEl?.addEventListener('input', () => { _draft.description = descEl.value; });

  resultNameEl.addEventListener('input', () => {
    _draft.result.name = resultNameEl.value;
    _updateSaveState();
  });
  resultTypeEl.addEventListener('change', () => {
    _draft.result.type = resultTypeEl.value;
  });

  dataSelectEl.addEventListener('change', () => {
    const v = dataSelectEl.value;
    if (!v) return;
    if (!_draft.body.inputs.find(i => i.name === v)) {
      _draft.body.inputs.push({ name: v });
      _renderDataInputs();
      _updateSaveState();
    }
    // Reset to the placeholder option after a pick.
    dataSelectEl.value = '';
  });

  addOpBtnEl.addEventListener('click', () => {
    _draft.body.operations.push({ _uid: _uid(), op: 'filter', field: '', comparator: 'eq', value: '' });
    _renderOperations();
    _updateSaveState();
  });

  saveBtnEl.addEventListener('click', _onSave);
  doneRevealBtnEl.addEventListener('click', _onRevealNameClick);
  cancelBtnEl.addEventListener('click', _onCancel);

  // Collapse toggles for all five cards.
  for (const key of ['pre', 'data', 'ops', 'result', 'post']) {
    const btn = _mountEl.querySelector(`[data-aa-toggle="${key}"]`);
    btn?.addEventListener('click', () => _toggleCard(key));
  }
}

// ─── Card collapse ────────────────────────────────────────────────────────

function _toggleCard(key) {
  const cardEl = { pre: preCardEl, data: dataCardEl, ops: opsCardEl, result: resultCardEl, post: postCardEl }[key];
  if (!cardEl) return;
  const collapsed = cardEl.classList.toggle('fa-conditions-card-collapsed');
  switch (key) {
    case 'pre':    _preCardCollapsed    = collapsed; break;
    case 'data':   _dataCardCollapsed   = collapsed; break;
    case 'ops':    _opsCardCollapsed    = collapsed; break;
    case 'result': _resultCardCollapsed = collapsed; break;
    case 'post':   _postCardCollapsed   = collapsed; break;
  }
  _renderToggle(key);
}

function _renderToggle(key) {
  const cardEl    = { pre: preCardEl,        data: dataCardEl,        ops: opsCardEl,        result: resultCardEl,        post: postCardEl        }[key];
  const toggleEl  = { pre: preToggleBtnEl,   data: dataToggleBtnEl,   ops: opsToggleBtnEl,   result: resultToggleBtnEl,   post: postToggleBtnEl   }[key];
  const glyphEl   = { pre: preToggleGlyphEl, data: dataToggleGlyphEl, ops: opsToggleGlyphEl, result: resultToggleGlyphEl, post: postToggleGlyphEl }[key];
  const collapsed = { pre: _preCardCollapsed, data: _dataCardCollapsed, ops: _opsCardCollapsed, result: _resultCardCollapsed, post: _postCardCollapsed }[key];
  if (!cardEl || !glyphEl) return;
  cardEl.classList.toggle('fa-conditions-card-collapsed', collapsed);
  glyphEl.textContent = collapsed ? '▸' : '▾';
  toggleEl?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

// ─── Data inputs ──────────────────────────────────────────────────────────

async function _loadGroundBindings() {
  try {
    const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_GROUND_LIBRARY' }, r));
    if (!res?.success) return;
    const ground = (res.grounds ?? []).find(g => g.ground?.id === _draft.groundId);
    if (!ground) return;
    // Flatten observation extracts → unique output names.
    const seen = new Set();
    const bindings = [];
    for (const obs of (ground.observations ?? [])) {
      const impl = obs.implementations?.[0] ?? {};
      const extracts = Array.isArray(impl.extracts) ? impl.extracts : [];
      for (const ex of extracts) {
        if (typeof ex.output !== 'string' || !ex.output) continue;
        if (seen.has(ex.output)) continue;
        seen.add(ex.output);
        bindings.push({
          name   : ex.output,
          source : obs.name ?? obs.id,
          shape  : ex.shape ?? '',
        });
      }
    }
    _availableBindings = bindings;
    _populateDataSelect();
  } catch { /* fine — dropdown stays minimal */ }
}

function _populateDataSelect() {
  if (!dataSelectEl) return;
  const opts = ['<option value="">— pick a binding —</option>'];
  // Skip bindings already selected.
  const taken = new Set(_draft.body.inputs.map(i => i.name));
  for (const b of _availableBindings) {
    if (taken.has(b.name)) continue;
    const meta = b.source ? ` (${b.source}${b.shape ? `:${b.shape}` : ''})` : '';
    opts.push(`<option value="${escAttr(b.name)}">${escHtml(b.name + meta)}</option>`);
  }
  // Allow manual entry of a binding name not in the list, via an
  // "Other…" option that prompts. Keeps the simple UX while supporting
  // bindings produced by Strategy steps that aren't Observation
  // extracts.
  opts.push('<option value="__other__">Other… (type a name)</option>');
  dataSelectEl.innerHTML = opts.join('');
}

function _renderDataInputs() {
  _populateDataSelect();
  if (!dataChipsEl) return;
  if (_draft.body.inputs.length === 0) {
    dataChipsEl.innerHTML = `<div class="aa-data-chips-empty">No data inputs yet — pick a binding above.</div>`;
    return;
  }
  dataChipsEl.innerHTML = _draft.body.inputs.map((i, idx) => `
    <span class="aa-data-chip" data-idx="${idx}">
      <span class="aa-data-chip-name">${escHtml(i.name)}</span>
      <button class="aa-data-chip-remove" data-aa-input-remove="${idx}" type="button" title="Remove">✕</button>
    </span>
  `).join('');
  dataChipsEl.querySelectorAll('[data-aa-input-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.aaInputRemove, 10);
      _draft.body.inputs.splice(idx, 1);
      _renderDataInputs();
      _updateSaveState();
    });
  });
  // Re-wire "Other…" prompt on the select since it was rebuilt.
  dataSelectEl.removeEventListener('change', _onOtherBindingPick);
  dataSelectEl.addEventListener('change', _onOtherBindingPick);
}

function _onOtherBindingPick() {
  if (dataSelectEl.value !== '__other__') return;
  const raw = prompt('Binding name (uppercase letters / digits / underscores):');
  dataSelectEl.value = '';
  if (!raw) return;
  const name = raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!name) return;
  if (_draft.body.inputs.find(i => i.name === name)) return;
  _draft.body.inputs.push({ name });
  _renderDataInputs();
  _updateSaveState();
}

// ─── Operations ───────────────────────────────────────────────────────────

function _renderOperations() {
  if (!opsListEl) return;
  if (_draft.body.operations.length === 0) {
    opsListEl.innerHTML = `<div class="aa-ops-empty">No operations yet — click + Operation below.</div>`;
    return;
  }
  opsListEl.innerHTML = _draft.body.operations.map((op, idx) => _renderOpCardHtml(op, idx)).join('');
  _wireOpHandlers();
}

function _renderOpCardHtml(op, idx) {
  const type = op.op ?? 'filter';
  const typeOpts = OPERATIONS.map(o =>
    `<option value="${escAttr(o.id)}"${o.id === type ? ' selected' : ''}>${escHtml(o.label)}${o.stub ? ' — stub' : ''}</option>`
  ).join('');
  let body = '';
  if (type === 'filter') {
    body = `
      <div class="aa-op-fields">
        <input type="text" class="aa-op-input aa-op-input-narrow" data-aa-op-field="field"
               placeholder="field" value="${escAttr(op.field ?? '')}" data-idx="${idx}" />
        <select class="aa-op-select" data-aa-op-field="comparator" data-idx="${idx}">
          ${FILTER_COMPARATORS.map(c => `<option value="${escAttr(c.id)}"${c.id === (op.comparator ?? 'eq') ? ' selected' : ''}>${escHtml(c.label)}</option>`).join('')}
        </select>
        <input type="text" class="aa-op-input" data-aa-op-field="value"
               placeholder="value or {{PARAM}}" value="${escAttr(op.value ?? '')}" data-idx="${idx}" />
      </div>`;
  } else if (type === 'sort') {
    body = `
      <div class="aa-op-fields">
        <input type="text" class="aa-op-input aa-op-input-narrow" data-aa-op-field="key"
               placeholder="key" value="${escAttr(op.key ?? '')}" data-idx="${idx}" />
        <select class="aa-op-select" data-aa-op-field="direction" data-idx="${idx}">
          ${SORT_DIRECTIONS.map(d => `<option value="${escAttr(d.id)}"${d.id === (op.direction ?? 'asc') ? ' selected' : ''}>${escHtml(d.label)}</option>`).join('')}
        </select>
        <select class="aa-op-select" data-aa-op-field="coerceAs" data-idx="${idx}">
          ${SORT_COERCE.map(c => `<option value="${escAttr(c.id)}"${c.id === (op.coerceAs ?? 'string') ? ' selected' : ''}>${escHtml(c.label)}</option>`).join('')}
        </select>
      </div>`;
  } else if (type === 'take') {
    body = `
      <div class="aa-op-fields">
        <input type="text" class="aa-op-input aa-op-input-narrow" data-aa-op-field="count"
               placeholder="count or {{PARAM}}" value="${escAttr(op.count ?? '')}" data-idx="${idx}" />
      </div>`;
  } else if (type === 'group') {
    body = `
      <div class="aa-op-fields">
        <input type="text" class="aa-op-input aa-op-input-narrow" data-aa-op-field="key"
               placeholder="group-by key" value="${escAttr(op.key ?? '')}" data-idx="${idx}" />
        <span class="aa-op-stub-hint">stub — engine support pending</span>
      </div>`;
  } else if (type === 'pluck') {
    body = `
      <div class="aa-op-fields">
        <input type="text" class="aa-op-input aa-op-input-narrow" data-aa-op-field="key"
               placeholder="field to pluck" value="${escAttr(op.key ?? '')}" data-idx="${idx}" />
        <span class="aa-op-stub-hint">stub — engine support pending</span>
      </div>`;
  }
  return `
    <div class="aa-op-card" data-idx="${idx}">
      <div class="aa-op-head">
        <span class="aa-op-order">${idx + 1}.</span>
        <select class="aa-op-type-select" data-aa-op-type="1" data-idx="${idx}">${typeOpts}</select>
        <span class="aa-op-spacer"></span>
        <button class="btn-action danger" data-aa-op-remove="1" data-idx="${idx}" type="button" title="Remove">✕</button>
      </div>
      <div class="aa-op-body">${body}</div>
    </div>
  `;
}

function _wireOpHandlers() {
  // Type change resets per-op fields appropriate to the new type.
  opsListEl.querySelectorAll('select.aa-op-type-select[data-aa-op-type="1"]').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.idx, 10);
      const newType = sel.value;
      let fresh;
      if (newType === 'filter')      fresh = { op: 'filter', field: '', comparator: 'eq', value: '' };
      else if (newType === 'sort')   fresh = { op: 'sort',   key: '', direction: 'asc', coerceAs: 'string' };
      else if (newType === 'take')   fresh = { op: 'take',   count: '' };
      else if (newType === 'group')  fresh = { op: 'group',  key: '' };
      else if (newType === 'pluck')  fresh = { op: 'pluck',  key: '' };
      else                            fresh = { op: newType };
      fresh._uid = _draft.body.operations[idx]?._uid ?? _uid();
      _draft.body.operations[idx] = fresh;
      _renderOperations();
      _updateSaveState();
    });
  });
  opsListEl.querySelectorAll('input.aa-op-input[data-aa-op-field], select.aa-op-select[data-aa-op-field]').forEach(el => {
    el.addEventListener('input', () => _updateOpField(el));
    el.addEventListener('change', () => _updateOpField(el));
  });
  opsListEl.querySelectorAll('button[data-aa-op-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      _draft.body.operations.splice(idx, 1);
      _renderOperations();
      _updateSaveState();
    });
  });
}

function _updateOpField(el) {
  const idx = parseInt(el.dataset.idx, 10);
  const field = el.dataset.aaOpField;
  const op = _draft.body.operations[idx];
  if (!op) return;
  op[field] = el.value;
  _updateSaveState();
}

// ─── Save / Cancel ────────────────────────────────────────────────────────

function _updateSaveState() {
  if (!saveBtnEl) return;
  const hasName       = (_draft.name ?? '').trim().length > 0;
  const hasResultName = (_draft.result.name ?? '').trim().length > 0;
  // Allow save with at least name + result name; operations / inputs
  // can be empty (user might be saving a stub to refine later).
  saveBtnEl.disabled = !(hasName && hasResultName);
}

function _onRevealNameClick() {
  nameCardEl?.classList.remove('hidden');
  _preCardCollapsed    = true; _renderToggle('pre');
  _dataCardCollapsed   = true; _renderToggle('data');
  _opsCardCollapsed    = true; _renderToggle('ops');
  _resultCardCollapsed = true; _renderToggle('result');
  _postCardCollapsed   = true; _renderToggle('post');
  nameInputEl?.focus();
}

async function _onSave() {
  _draft.name        = (nameInputEl.value     ?? '').trim();
  _draft.description = (_mountEl.querySelector('[data-aa="description"]')?.value ?? '').trim();
  _draft.result.name = (resultNameEl.value    ?? '').trim();
  if (!_draft.name)        { _showWarning('Name is required'); return; }
  if (!_draft.result.name) { _showWarning('Result name is required'); return; }

  // Auto-detect params from operations + result name.
  const params = _extractParams(_draft);

  // Strip _uid scratch fields before persisting operations.
  const cleanOps = _draft.body.operations.map(op => {
    const { _uid: _u, ...rest } = op;
    return rest;
  });

  const record = {
    id          : _draft.id,
    groundId    : _draft.groundId,
    name        : _draft.name,
    description : _draft.description,
    params,
    implementations: [{
      tier: 'cache',
      body: {
        kind       : 'operations',
        inputs     : _draft.body.inputs.map(i => ({ ...i })),
        operations : cleanOps,
      },
    }],
    result        : { ..._draft.result },
    preconditions : _draft.preconditions,
    postconditions: _draft.postconditions,
  };

  // v2.74.121 — Mount-snapshot guard + Cancel disable during save.
  // Same shape as assertion-author.js v2.74.120: Cancel-during-save used
  // to fire the success toast and route a second mode change after the
  // user had already left. Disable Cancel to prevent the click; snapshot
  // _mountEl to detect any other unmount source.
  const mountSnapshot = _mountEl;
  saveBtnEl.disabled = true;
  if (cancelBtnEl) cancelBtnEl.disabled = true;
  saveBtnEl.textContent = 'Saving…';
  const res = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'SAVE_ANALYSIS', payload: { analysis: record } }, resolve);
  });
  if (mountSnapshot !== _mountEl) return;
  if (!res?.success) {
    _showWarning(`Save failed: ${res?.error ?? 'unknown'}`);
    saveBtnEl.disabled = false;
    if (cancelBtnEl) cancelBtnEl.disabled = false;
    saveBtnEl.textContent = _isEdit ? 'Update' : 'Save';
    return;
  }
  toast(`Analysis "${_draft.name}" saved`, 'ok');
  _exitOrReturn();
}

function _onCancel() { _exitOrReturn(); }

function _exitOrReturn() {
  if (typeof _tabId === 'number') {
    chrome.runtime.sendMessage({
      type: 'CLEAR_TAB_SIDEPANEL_MODE',
      payload: { tabId: _tabId },
    }).catch(() => {});
  }
  if (_returnTo === 'ground-view') requestModeChange('ground-view', {});
  else exitToStudio();
}

function _showWarning(text) {
  if (!warningEl) return;
  warningEl.textContent = text;
  warningEl.classList.remove('hidden');
}

export default { name: 'analysis-author', mount, unmount, handleEvent };
