/**
 * @file Sidepanel/modes/assertion-author.js
 * @description Sidepanel mode for authoring a named Assertion — a
 * library entry of saved conditions referenced from primitive
 * pre/post envelopes (DETECT, LOOP, WAIT, fragment/observation
 * pre/post, etc.) via `assertion_ref`.
 *
 * Minimal v1 surface mirroring perspective-capture's shape:
 *   - name (required), description (optional)
 *   - match mode: 'all' | 'any'  (k_of_n deferred to Studio for now)
 *   - conditions list, each editable inline via the same
 *     CONDITION_FIELDS-driven editor pattern fragment-author uses for
 *     pre/post
 *   - Save / Cancel — exit routes to ground-view when launched from
 *     the Ground sidepanel (returnTo === 'ground-view')
 *
 * @module Sidepanel/modes/assertion-author
 */

import { toast, exitToStudio, requestModeChange } from '../shell-api.js';
import { CONDITION_FIELDS, emptyCondition } from '../../Services/Assertion.js';

const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escAttr = escHtml;

// ─── State ────────────────────────────────────────────────────────────────

let _mountEl = null;
let _payload = null;
let _tabId = null;
let _draft = null;       // { id, groundId, name, description, body: {match, conditions} }
let _returnTo = null;
let _isEdit = false;
let _groundPerspectives = [];
let _groundAssertions = [];

// DOM refs (scoped to mountEl)
let nameInputEl, descInputEl, matchSelectEl;
let condListEl, addCondBtnEl, saveBtnEl, cancelBtnEl, warningEl;

// ─── Lifecycle ────────────────────────────────────────────────────────────

async function mount(payload, mountEl) {
  _mountEl  = mountEl;
  _payload  = payload ?? {};
  _tabId    = _payload.tabId ?? _payload.existingTabId ?? null;
  _returnTo = _payload.returnTo ?? null;

  const groundId = _payload.groundId;
  if (!groundId) {
    mountEl.innerHTML = `<div class="sidepanel-idle"><h3>Assertion</h3><p>No active groundId.</p></div>`;
    return;
  }

  // Seed draft. Edit mode (prefilledAssertion with id) preserves the
  // existing record; new mode starts blank.
  const prefilled = _payload.prefilledAssertion;
  if (prefilled && typeof prefilled === 'object' && prefilled.id) {
    _isEdit = true;
    _draft = {
      id          : prefilled.id,
      groundId,
      name        : prefilled.name ?? '',
      description : prefilled.description ?? '',
      body        : {
        match      : prefilled.body?.match ?? 'all',
        conditions : Array.isArray(prefilled.body?.conditions)
          ? prefilled.body.conditions.map(c => ({ ...c }))
          : [],
      },
      authoredBy  : prefilled.authoredBy ?? 'human',
    };
  } else {
    _isEdit = false;
    _draft = {
      id          : `pred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      groundId,
      name        : '',
      description : '',
      body        : { match: 'all', conditions: [] },
      authoredBy  : 'human',
    };
  }

  mountEl.innerHTML = _renderHtml();
  _resolveRefs(mountEl);
  _wireHandlers();

  // Populate the editor dropdowns from the Ground's other assertions /
  // perspectives so referenced conditions (assertion_ref / perspective_ref)
  // surface in the type dropdown.
  _loadGroundCatalog();

  _renderConditions();
  _updateSaveState();
}

async function unmount() {
  if (_mountEl) _mountEl.innerHTML = '';
  _mountEl = null;
  _payload = null;
  _tabId = null;
  _draft = null;
  _returnTo = null;
  _isEdit = false;
  _groundPerspectives = [];
  _groundAssertions = [];
  nameInputEl = descInputEl = matchSelectEl = null;
  condListEl = addCondBtnEl = saveBtnEl = cancelBtnEl = warningEl = null;
}

function handleEvent(_message) { /* no-op for this mode */ }

// ─── Render ───────────────────────────────────────────────────────────────

function _renderHtml() {
  return `
    <div class="dbg-perspective-card">
      <div class="dbg-perspective-banner">
        <span class="dbg-perspective-banner-title">${escHtml(_isEdit ? 'Edit Assertion' : 'New Assertion')}</span>
      </div>
      <div data-aa="warning" class="dbg-perspective-warning hidden"></div>

      <section class="dbg-perspective-meta-card">
        <label class="dbg-perspective-field">
          <span class="dbg-perspective-field-label">Name</span>
          <input type="text" data-aa="name" maxlength="80"
                 placeholder="e.g. signed-in" value="${escAttr(_draft.name)}" />
        </label>
        <label class="dbg-perspective-field">
          <span class="dbg-perspective-field-label">Description</span>
          <textarea data-aa="description" rows="2"
                    placeholder="What this assertion checks for.">${escHtml(_draft.description)}</textarea>
        </label>
        <label class="dbg-perspective-field">
          <span class="dbg-perspective-field-label">Match mode</span>
          <select data-aa="match">
            <option value="all" ${_draft.body.match === 'all' ? 'selected' : ''}>all (AND)</option>
            <option value="any" ${_draft.body.match === 'any' ? 'selected' : ''}>any (OR)</option>
          </select>
        </label>
      </section>

      <section class="dbg-perspective-meta-card fa-conditions-card">
        <div class="fa-conditions-content">
          <div class="fa-conditions-head">
            <span class="fa-conditions-label">Conditions</span>
            <span class="fa-conditions-source"></span>
          </div>
          <div class="fa-conditions-body">
            <div data-aa="cond-list" class="fa-conditions-list"></div>
            <div class="fa-conditions-footer">
              <button data-aa="add-cond" class="btn-secondary fa-add-condition-btn" type="button">+ Add</button>
            </div>
          </div>
        </div>
      </section>

      <section class="dbg-perspective-actions">
        <button data-aa="save" class="btn-primary" type="button" disabled>${escHtml(_isEdit ? 'Update' : 'Save')}</button>
        <button data-aa="cancel" class="btn-secondary" type="button">Cancel</button>
      </section>
    </div>
  `;
}

function _resolveRefs(root) {
  const q = (k) => root.querySelector(`[data-aa="${k}"]`);
  nameInputEl    = q('name');
  descInputEl    = q('description');
  matchSelectEl  = q('match');
  condListEl     = q('cond-list');
  addCondBtnEl   = q('add-cond');
  saveBtnEl      = q('save');
  cancelBtnEl    = q('cancel');
  warningEl      = q('warning');
}

function _wireHandlers() {
  nameInputEl.addEventListener('input', () => {
    _draft.name = nameInputEl.value;
    _updateSaveState();
  });
  descInputEl.addEventListener('input', () => {
    _draft.description = descInputEl.value;
  });
  matchSelectEl.addEventListener('change', () => {
    _draft.body.match = matchSelectEl.value;
  });
  addCondBtnEl.addEventListener('click', () => {
    _draft.body.conditions.push(emptyCondition('selector_present'));
    _renderConditions();
    _updateSaveState();
  });
  saveBtnEl.addEventListener('click', _onSave);
  cancelBtnEl.addEventListener('click', _onCancel);
}

// ─── Conditions editor (page-family subset, mirrors fragment-author) ─────

function _renderConditions() {
  if (!condListEl) return;
  const list = _draft.body.conditions;
  if (list.length === 0) {
    condListEl.innerHTML = `<div class="fa-conditions-empty">No conditions yet — click + Add to create one.</div>`;
    return;
  }
  condListEl.innerHTML = list.map((c, idx) => _renderConditionRow(c, idx)).join('');
  _wireConditionRowHandlers();
}

function _renderConditionRow(c, idx) {
  const type = c?.type ?? 'selector_present';
  const attrs = `data-aa-cond="1" data-idx="${idx}"`;
  let valueHtml;
  if (type === 'selector_present' || type === 'selector_absent') {
    valueHtml = `<input type="text" class="cond-value-input" ${attrs} data-field="selector"
                        value="${escAttr(c?.selector ?? '')}"
                        placeholder="CSS selector, e.g. .signed-in-badge" />`;
  } else if (type === 'url_matches') {
    valueHtml = `<input type="text" class="cond-value-input" ${attrs} data-field="pattern"
                        value="${escAttr(c?.pattern ?? '')}"
                        placeholder="URL substring or regex" />`;
  } else if (type === 'text_present') {
    valueHtml = `<input type="text" class="cond-value-input" ${attrs} data-field="text"
                        value="${escAttr(c?.text ?? '')}"
                        placeholder="Text to look for (case-insensitive)" />`;
  } else if (type === 'attribute_equals') {
    valueHtml = `
      <div class="cond-attr-row">
        <input type="text" class="cond-value-input cond-value-narrow" ${attrs} data-field="selector"
               value="${escAttr(c?.selector ?? '')}" placeholder="CSS selector" />
        <input type="text" class="cond-value-input cond-value-narrow" ${attrs} data-field="attribute"
               value="${escAttr(c?.attribute ?? '')}" placeholder="attribute name" />
        <input type="text" class="cond-value-input" ${attrs} data-field="value"
               value="${escAttr(c?.value ?? '')}" placeholder="expected value" />
      </div>`;
  } else if (type === 'perspective_ref') {
    const meta = _groundPerspectives.find(l => l.id === c?.perspectiveId);
    valueHtml = meta
      ? `<span class="cond-pred-hint">${escHtml(meta.name ?? meta.id)}</span>`
      : `<span class="cond-pred-hint cond-pred-hint-empty">— pick a perspective from the dropdown —</span>`;
  } else if (type === 'assertion_ref') {
    const meta = _groundAssertions.find(p => p.id === c?.assertionId);
    valueHtml = meta
      ? `<span class="cond-pred-hint">${escHtml(meta.name ?? meta.id)}</span>`
      : `<span class="cond-pred-hint cond-pred-hint-empty">— pick an assertion from the dropdown —</span>`;
  } else {
    valueHtml = `<span class="cond-pred-hint cond-pred-hint-empty">unsupported type: ${escHtml(type)}</span>`;
  }
  return `
    <div class="review-condition-row" data-idx="${idx}">
      <div class="cond-editor" ${attrs}>
        <select class="cond-type-select" ${attrs}>${_buildTypeOptions(c)}</select>
        ${valueHtml}
      </div>
      <button class="btn-action danger" ${attrs} data-aa-cond-remove="1" type="button" title="Remove">✕</button>
    </div>`;
}

function _buildTypeOptions(c) {
  const cur = c?.type ?? 'selector_present';
  const curPredId = c?.assertionId ?? '';
  const curPerspectiveId = c?.perspectiveId ?? '';
  const opt = (v, l, sel) => `<option value="${escAttr(v)}"${sel ? ' selected' : ''}>${escHtml(l)}</option>`;
  const groups = [];
  groups.push(`<optgroup label="Page · DOM">
    ${opt('selector_present', 'selector appears',    cur === 'selector_present')}
    ${opt('selector_absent',  'selector disappears', cur === 'selector_absent')}
    ${opt('text_present',     'text appears',        cur === 'text_present')}
    ${opt('attribute_equals', 'attribute equals',    cur === 'attribute_equals')}
  </optgroup>`);
  groups.push(`<optgroup label="Page · Browser">
    ${opt('url_matches', 'URL matches', cur === 'url_matches')}
  </optgroup>`);
  if (_groundPerspectives.length > 0) {
    const opts = _groundPerspectives
      .slice().sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      .map(l => opt(`perspective_ref:${l.id}`, l.name ?? l.id, cur === 'perspective_ref' && curPerspectiveId === l.id))
      .join('');
    groups.push(`<optgroup label="Perspectives">${opts}</optgroup>`);
  }
  if (_groundAssertions.length > 0) {
    // Don't reference self (an assertion shouldn't recurse into itself).
    const opts = _groundAssertions
      .filter(p => p.id !== _draft.id)
      .slice().sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      .map(p => opt(`pred_ref:${p.id}`, p.name ?? p.id, cur === 'assertion_ref' && curPredId === p.id))
      .join('');
    if (opts) groups.push(`<optgroup label="Custom (other assertions)">${opts}</optgroup>`);
  }
  return groups.join('');
}

function _decodeTypeValue(value) {
  if (typeof value === 'string' && value.startsWith('pred_ref:'))
    return { type: 'assertion_ref', assertionId: value.slice('pred_ref:'.length) };
  if (typeof value === 'string' && value.startsWith('perspective_ref:'))
    return { type: 'perspective_ref', perspectiveId: value.slice('perspective_ref:'.length) };
  return { type: value };
}

function _wireConditionRowHandlers() {
  condListEl.querySelectorAll('select.cond-type-select[data-aa-cond="1"]').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.idx, 10);
      const decoded = _decodeTypeValue(sel.value);
      const fresh = emptyCondition(decoded.type);
      if (decoded.assertionId) fresh.assertionId = decoded.assertionId;
      if (decoded.perspectiveId)    fresh.perspectiveId    = decoded.perspectiveId;
      _draft.body.conditions[idx] = fresh;
      _renderConditions();
      _updateSaveState();
    });
  });
  condListEl.querySelectorAll('input.cond-value-input[data-aa-cond="1"]').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = parseInt(inp.dataset.idx, 10);
      const cond = _draft.body.conditions[idx];
      if (!cond) return;
      const field = inp.dataset.field;
      const schema = CONDITION_FIELDS[cond.type];
      if (schema && schema.fields.includes(field)) {
        cond[field] = inp.value;
        _updateSaveState();
      }
    });
  });
  condListEl.querySelectorAll('button[data-aa-cond-remove="1"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      _draft.body.conditions.splice(idx, 1);
      _renderConditions();
      _updateSaveState();
    });
  });
}

async function _loadGroundCatalog() {
  try {
    const [perspectiveRes, predRes] = await Promise.all([
      new Promise(r => chrome.runtime.sendMessage({ type: 'LIST_PERSPECTIVES',    payload: { groundId: _draft.groundId } }, r)),
      new Promise(r => chrome.runtime.sendMessage({ type: 'LIST_ASSERTIONS', payload: { groundId: _draft.groundId } }, r)),
    ]);
    if (perspectiveRes?.success)  _groundPerspectives    = perspectiveRes.perspectives    ?? [];
    if (predRes?.success) _groundAssertions = predRes.assertions ?? [];
    // Re-render conditions so the new dropdown options take effect.
    _renderConditions();
  } catch { /* fine — dropdown stays page-only */ }
}

// ─── Save / Cancel ───────────────────────────────────────────────────────

function _updateSaveState() {
  if (!saveBtnEl) return;
  const hasName  = (_draft.name ?? '').trim().length > 0;
  const hasConds = _draft.body.conditions.length > 0
    && _draft.body.conditions.every(c => _conditionLooksValid(c));
  saveBtnEl.disabled = !(hasName && hasConds);
}

function _conditionLooksValid(c) {
  if (!c || typeof c.type !== 'string') return false;
  const schema = CONDITION_FIELDS[c.type];
  if (!schema) return false;
  for (const field of schema.required ?? []) {
    if (typeof c[field] !== 'string' || c[field].trim() === '') return false;
  }
  return true;
}

async function _onSave() {
  _draft.name        = (nameInputEl.value ?? '').trim();
  _draft.description = (descInputEl.value ?? '').trim();
  _draft.body.match  = matchSelectEl.value;
  if (!_draft.name) {
    _showWarning('Name is required');
    return;
  }
  if (_draft.body.conditions.length === 0) {
    _showWarning('Add at least one condition');
    return;
  }
  // v2.74.120 — Capture the mount element BEFORE awaiting the save so we
  // can detect cancel/remount-during-save. Storage round-trips can take
  // hundreds of ms when there's concurrent index activity (post v2.74.119
  // chain serialization); a Cancel click during that window used to fire
  // the "Assertion saved" toast anyway and route a second mode change.
  // Disabling the Cancel button prevents the click in the first place;
  // the mountSnapshot check is the belt-and-suspenders fallback for any
  // other unmount source (mode switch, panel close).
  const mountSnapshot = _mountEl;
  saveBtnEl.disabled = true;
  if (cancelBtnEl) cancelBtnEl.disabled = true;
  saveBtnEl.textContent = 'Saving…';
  const res = await new Promise(resolve => {
    chrome.runtime.sendMessage({
      type: 'SAVE_ASSERTION',
      payload: { assertion: _draft },
    }, resolve);
  });
  // v2.74.120 — Bail silently if we've been unmounted (or remounted) while
  // the save was in flight. No toast, no exitOrReturn — the new context
  // owns the UI now.
  if (mountSnapshot !== _mountEl) return;
  if (!res?.success) {
    _showWarning(`Save failed: ${res?.error ?? 'unknown'}`);
    saveBtnEl.disabled = false;
    if (cancelBtnEl) cancelBtnEl.disabled = false;
    saveBtnEl.textContent = _isEdit ? 'Update' : 'Save';
    return;
  }
  toast(`Assertion "${_draft.name}" saved`, 'ok');
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

export default { name: 'assertion-author', mount, unmount, handleEvent };
