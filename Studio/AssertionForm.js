/**
 * @file Studio/AssertionForm.js
 * @description Assertion library form. Assertions are vocabulary: named
 * logical-condition expressions stored per Ground, referenced by id from
 * primitive contracts (DETECT/LOOP/WAIT branches, fragment pre/post,
 * Analysis pre/post). Authoring is a small form: name + description +
 * match mode + a list of conditions, plus an optional Generate-from-
 * description panel (Pass 16) that uses Claude to author the body.
 *
 * ── Module shape ──────────────────────────────────────────────────────
 *
 * Internal state (file-local):
 *   - assertionDraft            : the in-progress Assertion
 *   - _libraryAssertionCache    : OTHER assertions on the ground (for
 *                                 nested assertion_ref dropdown). Excludes
 *                                 the assertion being edited.
 *   - _libraryLocaleCache       : Locales on the ground (for locale_ref
 *                                 dropdown).
 *
 * Exported entry points:
 *   - openAssertionForm(groundId, assertionId | null) : show form
 *   - deleteAssertion(assertionId)                    : delete with confirm
 *   - setupAssertionForm({ refreshGroundList,
 *                          renderConditionEditor,
 *                          decodeConditionTypeValue,
 *                          emptyCondition })          : one-time wiring
 *
 * Three of those setup deps are functions defined in studio.js (or
 * imported there). They're injected at setup time rather than imported
 * directly: they're "studio editor surface" functions that the form
 * shares with other forms, and threading them through setup keeps the
 * dependency direction tidy (forms depend on a host they don't import
 * back into).
 *
 * Dependencies (direct):
 *   - StorageManager        : Assertion + cross-primitive reads
 *   - shared.js helpers     : $, toast
 *   - Studio/conditionWalker: walkStrategyConditions for usage counting
 *   - Services/Assertion    : CONDITION_FIELDS for field-validation in
 *                             value-input handler
 *
 * Extracted from studio.js (Pass 17c) following the Locale form pattern
 * established in Pass 17b.
 *
 * @module Studio/AssertionForm
 * @author Agent HUB
 * @version 2.72.33
 */

import { StorageManager } from '../Services/StorageManager.js';
import { $, toast, escHtml } from '../shared.js';
import { walkStrategyConditions } from './conditionWalker.js';
import { CONDITION_FIELDS, getFamily } from '../Services/Assertion.js';
// v2.72.47 (Pass 18) — Live-DOM verify against the active tab.
import { Logger } from '../Core/Logger.js';

// ─── Internal state (file-local) ────────────────────────────────────────

/** In-flight assertion draft. Keyed nowhere — there's only ever one form open. */
let assertionDraft = null;

// v2.70.6 — Cache of OTHER library assertions on the current ground (not
// including the one being edited). Lets the assertion editor surface
// nested assertion_ref options under the Custom group. Self-references
// are excluded to prevent obvious cycles at authoring time.
let _libraryAssertionCache = [];

// v2.72.31 (Pass 17a) — Locales on the current ground for the locale_ref
// picker. v2.72.33 (Pass 17c) — now file-local; was a module-global
// before extraction.
let _libraryLocaleCache = [];

// Setup-time injections. See setupAssertionForm below.
let _refreshGroundList = null;
let _renderConditionEditor = null;
let _decodeConditionTypeValue = null;
let _emptyCondition = null;

// ─── v2.72.47 (Pass 18) — Live-DOM verify state ─────────────────────────
// Per-condition verify result, indexed by condition position. Cleared
// whenever a condition is edited or the active tab changes.
//   { matched: bool, error?: string, family: 'page' | 'scope' | 'reference' }
// 'page' family is the only one that gets actually probed; the others
// carry a "skipped" pseudo-result so the UI can render an explanation.
let _lastVerify = [];
// Active tab id we last checked against. Stored so the result banner
// can show "verified against tab N at <url>" and cleared on tab change.
let _lastVerifyTabId = null;
let _lastVerifyTabUrl = '';

// ─── Form lifecycle ─────────────────────────────────────────────────────

export async function openAssertionForm(groundId, assertionId) {
  const card = $('assertion-form-card');
  const title = $('assertion-form-title');
  const groundLabel = $('assertion-form-ground-label');
  const ground = await StorageManager.getGround(groundId);

  if (!ground) {
    toast('Ground not found', 'err');
    return;
  }
  groundLabel.textContent = `on Ground: ${ground.name ?? '(unnamed)'}`;

  // v2.70.6 — Load other library assertions for the Custom-group dropdown.
  // Exclude the assertion being edited (would create a self-reference cycle).
  try {
    const all = await StorageManager.listAssertions(groundId);
    _libraryAssertionCache = all.filter(p => p.id !== assertionId);
  } catch (_) {
    _libraryAssertionCache = [];
  }

  // v2.72.31 (Pass 17a) — Load locales for the locale_ref picker.
  try {
    _libraryLocaleCache = await StorageManager.listLocales(groundId);
  } catch (_) {
    _libraryLocaleCache = [];
  }

  if (assertionId) {
    const existing = await StorageManager.getAssertion(assertionId);
    if (!existing) {
      toast('Assertion not found', 'err');
      return;
    }
    assertionDraft = {
      id: existing.id,
      groundId: existing.groundId,
      name: existing.name ?? '',
      description: existing.description ?? '',
      body: {
        match: existing.body?.match ?? 'all',
        conditions: (existing.body?.conditions ?? []).map(c => ({ ...c })),
      },
      // v2.72.28 (Pass 16) — authoring metadata. Preserve existing record's
      // authoredBy on edit; this session may flip it to 'model' if the
      // user clicks Generate and replaces the body.
      authoredBy: existing.authoredBy ?? 'human',
      authoredAt: existing.authoredAt,
    };
    title.textContent = `Edit Assertion`;
  } else {
    assertionDraft = {
      id: `pred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      groundId: ground.id,
      name: '',
      description: '',
      body: { match: 'all', conditions: [] },
      // v2.72.28 (Pass 16) — new assertions default to 'human'; flips to
      // 'model' if Generate is used.
      authoredBy: 'human',
    };
    title.textContent = 'New Assertion';
  }

  // Pre-fill inputs
  $('input-assertion-name').value = assertionDraft.name;
  $('input-assertion-description').value = assertionDraft.description;
  $('input-assertion-match').value = assertionDraft.body.match;
  // v2.47.0 (Pass O2) — k_of_n count + visibility
  const countRow = $('input-assertion-count-row');
  const countInp = $('input-assertion-count');
  if (assertionDraft.body.match === 'k_of_n') {
    countRow?.classList.remove('hidden');
    if (countInp) countInp.value = String(assertionDraft.body.count ?? 1);
  } else {
    countRow?.classList.add('hidden');
  }

  renderAssertionConditions();

  // v2.72.28 (Pass 16) — Reset generate panel to initial state.
  const genSection = $('assertion-generate-section');
  if (genSection) genSection.open = false;
  const genStatus = $('assertion-generate-status');
  if (genStatus) genStatus.textContent = '';
  const genFamily = $('input-assertion-generate-family');
  if (genFamily) genFamily.value = 'mixed';

  card.classList.remove('hidden');
  $('input-assertion-name').focus();

  // v2.72.47 (Pass 18) — start with a clean verify state and current tab info.
  clearVerifyState();
  refreshVerifyTabInfo();
}

function closeAssertionForm() {
  $('assertion-form-card').classList.add('hidden');
  assertionDraft = null;
  _libraryAssertionCache = [];
  _libraryLocaleCache = [];
  // v2.72.47 (Pass 18) — clear verify state on close so the next
  // form-open starts clean.
  clearVerifyState();
}

function renderAssertionConditions() {
  const container = $('assertion-conditions-list');
  if (!container || !assertionDraft) return;
  const cs = assertionDraft.body.conditions;

  if (cs.length === 0) {
    container.innerHTML = `<div class="empty-state small">No conditions yet — click + Add to create one.</div>`;
    return;
  }

  container.innerHTML = cs.map((c, i) => {
    const editorHtml = _renderConditionEditor(c, { fragmentId: '__assertion__', side: 'cond', idx: i }, { context: 'fragment', assertions: _libraryAssertionCache, locales: _libraryLocaleCache, allowedFamilies: ['page', 'scope'] });
    // v2.72.47 (Pass 18) — per-condition verify status pill, if a verify
    // run has been performed since the last edit. Pill placement: directly
    // after the condition row, full-width, color-coded.
    const v = _lastVerify[i];
    let statusHtml = '';
    if (v) {
      if (v.family === 'page') {
        if (v.matched === true) {
          statusHtml = `<div class="assertion-cond-status status-ok">✓ matched</div>`;
        } else {
          const reason = v.error ? ` — ${escHtml(v.error)}` : '';
          statusHtml = `<div class="assertion-cond-status status-err">✗ not matched${reason}</div>`;
        }
      } else if (v.family === 'scope') {
        statusHtml = `<div class="assertion-cond-status status-skip">scope condition — runtime-only, not page-verifiable</div>`;
      } else if (v.family === 'reference') {
        statusHtml = `<div class="assertion-cond-status status-skip">reference — recursive verify lands in a future pass</div>`;
      }
    }
    return `
      <div class="review-condition-row" data-idx="${i}">
        ${editorHtml}
        <button class="btn-action danger pred-cond-remove" data-idx="${i}" title="Remove">✕</button>
        ${statusHtml}
      </div>`;
  }).join('');

  // Wire — re-use the fragment-context handlers but route to assertionDraft
  // by checking dataset.fragmentId === '__assertion__'.
  // v2.45.0 — uses emptyCondition + CONDITION_FIELDS (schema-derived).
  container.querySelectorAll('.cond-type-select[data-context="fragment"]').forEach(sel => {
    if (sel.dataset.fragmentId !== '__assertion__') return;
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.idx, 10);
      // v2.70.6 — Decode synthetic 'pred_ref:<id>' values.
      const decoded = _decodeConditionTypeValue(sel.value);
      const fresh = _emptyCondition(decoded.type);
      if (decoded.assertionId) fresh.assertionId = decoded.assertionId;
      if (decoded.localeId) fresh.localeId = decoded.localeId;
      assertionDraft.body.conditions[idx] = fresh;
      // v2.72.47 — clear stale verify state on condition mutation.
      clearVerifyState();
      renderAssertionConditions();
    });
  });
  container.querySelectorAll('.cond-value-input[data-context="fragment"]').forEach(inp => {
    if (inp.dataset.fragmentId !== '__assertion__') return;
    inp.addEventListener('input', () => {
      const idx = parseInt(inp.dataset.idx, 10);
      const cond = assertionDraft.body.conditions[idx];
      if (!cond) return;
      const field = inp.dataset.field;
      if (CONDITION_FIELDS[cond.type]?.fields.includes(field)) {
        cond[field] = inp.value;
      }
      // v2.72.47 — input change invalidates this condition's verify result.
      // Clear just this row rather than all (less jarring) but for v1 a full
      // clear keeps things simple — the user has to re-verify anyway.
      if (_lastVerify.length > 0) {
        clearVerifyState();
        renderAssertionConditions();
      }
    });
  });
  container.querySelectorAll('.pred-cond-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      assertionDraft.body.conditions.splice(idx, 1);
      // v2.72.47 — clear stale verify state on condition removal.
      clearVerifyState();
      renderAssertionConditions();
    });
  });
}

async function saveAssertion() {
  if (!assertionDraft) return;
  assertionDraft.name        = $('input-assertion-name').value.trim();
  assertionDraft.description = $('input-assertion-description').value.trim();
  assertionDraft.body.match  = $('input-assertion-match').value;
  // v2.47.0 (Pass O2) — capture count when k_of_n; clear it otherwise so
  // a stale count from a previous mode doesn't sit on disk.
  if (assertionDraft.body.match === 'k_of_n') {
    const k = parseInt($('input-assertion-count').value, 10);
    assertionDraft.body.count = Number.isFinite(k) ? k : 0;
  } else {
    delete assertionDraft.body.count;
  }

  if (!assertionDraft.name) {
    toast('Assertion name is required', 'err');
    return;
  }
  if (assertionDraft.body.conditions.length === 0) {
    toast('Assertion needs at least one condition', 'err');
    return;
  }
  // Validate via Services/Assertion.js
  try {
    const validateRes = await import('../Services/Assertion.js');
    const { errors } = validateRes.validateAssertion(assertionDraft.body, 'assertion');
    if (errors.length > 0) {
      toast(`Assertion has errors: ${errors[0]}`, 'err');
      return;
    }
  } catch (e) {
    // import failure shouldn't block save — engine validates at runtime
  }

  const res = await new Promise(r => chrome.runtime.sendMessage({
    type: 'SAVE_ASSERTION', payload: { assertion: assertionDraft },
  }, r));
  if (!res?.success) {
    toast(`Save failed: ${res?.error ?? 'unknown'}`, 'err');
    return;
  }
  toast('Assertion saved');
  closeAssertionForm();
  if (typeof _refreshGroundList === 'function') {
    await _refreshGroundList();
  }
}

export async function deleteAssertion(assertionId) {
  const pred = await StorageManager.getAssertion(assertionId);
  if (!pred) return;
  // Find usages — strategies/fragments referencing this assertion via assertion_ref.
  // For M2 we surface a count; M3 will surface the actual list.
  const usageCount = await countAssertionUsages(assertionId, pred.groundId);
  let msg = `Delete Assertion "${pred.name}"? This cannot be undone.`;
  if (usageCount > 0) {
    msg = `Delete Assertion "${pred.name}"?\n\n⚠ ${usageCount} reference${usageCount === 1 ? '' : 's'} to this assertion exist in strategies/fragments — deleting will leave them broken until updated.\nThis cannot be undone.`;
  }
  if (!confirm(msg)) return;
  const res = await new Promise(r => chrome.runtime.sendMessage({
    type: 'DELETE_ASSERTION', payload: { assertionId },
  }, r));
  if (!res?.success) {
    toast(`Delete failed: ${res?.error ?? 'unknown'}`, 'err');
    return;
  }
  toast('Assertion deleted');
  if (typeof _refreshGroundList === 'function') {
    await _refreshGroundList();
  }
}

/**
 * Count the number of assertion_ref references to a given assertion id
 * across all strategies and fragments on the same ground.
 */
async function countAssertionUsages(assertionId, groundId) {
  let count = 0;
  const strategies = await StorageManager.listStrategies(groundId);
  const fragments  = await StorageManager.listFragments(groundId);

  // Scan strategies — walk their tree looking for any condition that's a assertion_ref.
  for (const s of strategies) {
    walkStrategyConditions(s.fragmentSteps ?? [], (cond) => {
      if (cond?.type === 'assertion_ref' && cond.assertionId === assertionId) count++;
    });
  }
  // Scan fragment pre/post
  for (const f of fragments) {
    [...(f.preconditions ?? []), ...(f.postconditions ?? [])].forEach(c => {
      if (c?.type === 'assertion_ref' && c.assertionId === assertionId) count++;
    });
  }
  return count;
}

// ─── Generate-from-description (Pass 16) ────────────────────────────────

async function handleGenerate() {
  if (!assertionDraft) return;
  const statusEl = $('assertion-generate-status');
  const setStatus = (msg, kind) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = `assertion-generate-status${kind ? ` status-${kind}` : ''}`;
  };

  const name = $('input-assertion-name').value.trim();
  const description = $('input-assertion-description').value.trim();
  const family = $('input-assertion-generate-family').value;

  if (!description) {
    setStatus('Add a description first — that\'s what the model uses to compose conditions.', 'err');
    return;
  }

  setStatus('Generating…', 'info');
  // Lazy-load AnthropicService to avoid pulling it in for users who never
  // open the assertion form.
  let AnthropicService;
  try {
    ({ AnthropicService } = await import('../Services/AnthropicService.js'));
  } catch (e) {
    setStatus(`Failed to load AnthropicService: ${e.message}`, 'err');
    return;
  }

  let result;
  try {
    result = await AnthropicService.composeAssertion(
      { name, description, family },
      { /* context: groundUrl/sampleScope can be added later */ }
    );
  } catch (e) {
    setStatus(`Generation failed: ${e.message}`, 'err');
    return;
  }

  if (!result?.ok) {
    setStatus(`Generation failed: ${result?.error ?? 'unknown error'}`, 'err');
    return;
  }

  // Apply the proposed body to the draft. Replaces conditions wholesale.
  assertionDraft.body = {
    match: result.body.match,
    conditions: result.body.conditions.map(c => ({ ...c })),
    ...(typeof result.body.count === 'number' ? { count: result.body.count } : {}),
  };
  assertionDraft.authoredBy = 'model';

  // Sync UI: match dropdown, count visibility, conditions list.
  $('input-assertion-match').value = assertionDraft.body.match;
  const countRow = $('input-assertion-count-row');
  const countInp = $('input-assertion-count');
  if (assertionDraft.body.match === 'k_of_n') {
    countRow?.classList.remove('hidden');
    if (countInp) countInp.value = String(assertionDraft.body.count ?? 1);
  } else {
    countRow?.classList.add('hidden');
  }
  renderAssertionConditions();

  setStatus(`Generated ${result.body.conditions.length} condition(s) (${result.body.match}). Review and edit before saving.`, 'ok');
}

// ─── v2.72.47 (Pass 18) — Live-DOM verify ───────────────────────────────
//
// Probes the active tab in the user's last-focused window and runs every
// page-family condition against it via CHECK_CONDITION messages to the
// content script. Scope-family and reference-family conditions skip with
// a clear pseudo-status. Results render as per-condition pills + an
// overall match-mode banner.
//
// Stale state cleanup:
//   - Any condition edit clears _lastVerify (handled in renderAssertionConditions)
//   - chrome.tabs.onActivated clears _lastVerify (registered in setupAssertionForm)
//   - chrome.tabs.onUpdated on the verified tab clears _lastVerify
//
// Result is purely runtime. Not stored on the assertion. Vacates on form
// close.

/** Wipe per-condition + tab info. Called on edit, tab change, navigation. */
function clearVerifyState() {
  _lastVerify = [];
  _lastVerifyTabId = null;
  _lastVerifyTabUrl = '';
  // Hide the result banner and clear text. Don't re-render conditions
  // here — callers do that.
  const resultEl = $('assertion-verify-result');
  if (resultEl) {
    resultEl.classList.add('hidden');
    resultEl.textContent = '';
    resultEl.className = 'assertion-verify-result hidden';
  }
}

/** Refresh the active-tab indicator above the verify button. */
async function refreshVerifyTabInfo() {
  const el = $('assertion-verify-tab-info');
  if (!el) return;
  let tab;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs?.[0];
  } catch {
    el.textContent = 'No active tab';
    return;
  }
  if (!tab) { el.textContent = 'No active tab'; return; }
  if (/^(chrome|chrome-extension|about|edge):/i.test(tab.url ?? '')) {
    el.textContent = `${tab.url} (extension page — verify won't work)`;
    return;
  }
  // Truncate long URLs for display.
  const url = tab.url ?? '(unknown)';
  el.textContent = url.length > 80 ? `${url.slice(0, 80)}…` : url;
}

/**
 * Send a CHECK_CONDITION message to the active tab. Mirrors the retry
 * pattern from PageProbe (without importing it — we want a self-contained
 * verify path here).
 */
async function checkConditionOnTab(tabId, condition) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => finish({ matched: false, error: 'timeout (1500ms)' }), 1500);
    try {
      chrome.tabs.sendMessage(
        tabId,
        { type: 'CHECK_CONDITION', payload: { condition } },
        { frameId: 0 },
        (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            finish({ matched: false, error: chrome.runtime.lastError.message });
            return;
          }
          if (response == null) {
            finish({ matched: false, error: 'empty response from content script' });
            return;
          }
          finish({ matched: !!response.matched, error: response.error });
        },
      );
    } catch (e) {
      clearTimeout(timer);
      finish({ matched: false, error: `threw: ${e.message}` });
    }
  });
}

async function verifyAssertionOnActiveTab() {
  if (!assertionDraft) return;
  const conds = assertionDraft.body?.conditions ?? [];
  if (conds.length === 0) {
    toast('Add at least one condition first', 'err');
    return;
  }
  // Pull current values from inputs into draft so we verify what the user
  // sees, not stale state. (renderAssertionConditions's input handlers
  // write through, but a defensive sync here is cheap.)
  // [skipped: current handlers already write through, no extra work needed]

  let tab;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs?.[0];
  } catch (e) {
    toast(`Could not query active tab: ${e.message}`, 'err');
    return;
  }
  if (!tab) {
    toast('No active tab to verify against', 'err');
    return;
  }
  if (/^(chrome|chrome-extension|about|edge):/i.test(tab.url ?? '')) {
    toast(`Can't verify on ${new URL(tab.url).protocol} pages`, 'err');
    return;
  }

  Logger.info('AssertionForm', `Verify: starting`, {
    assertionId: assertionDraft.id,
    conditionCount: conds.length,
    tabId: tab.id,
    tabUrl: tab.url,
  });

  const verifyBtn = $('btn-assertion-verify');
  if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.textContent = 'Verifying…'; }

  // Iterate. For page-family conditions, send CHECK_CONDITION. For
  // scope/reference, mark skipped.
  const results = [];
  for (const cond of conds) {
    const family = getFamily(cond?.type);
    if (family === 'page') {
      const r = await checkConditionOnTab(tab.id, cond);
      results.push({ family, matched: r.matched, error: r.error });
    } else if (family === 'scope') {
      results.push({ family: 'scope' });
    } else {
      // reference family or unknown — surface as reference for v1.
      results.push({ family: 'reference' });
    }
  }

  _lastVerify = results;
  _lastVerifyTabId = tab.id;
  _lastVerifyTabUrl = tab.url ?? '';

  // Render pills inline.
  renderAssertionConditions();

  // Render the overall banner.
  renderVerifyBanner();

  Logger.info('AssertionForm', `Verify: done`, {
    results: results.map(r => ({ family: r.family, matched: r.matched })),
  });

  if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.textContent = '▶ Verify on active tab'; }
}

function renderVerifyBanner() {
  const resultEl = $('assertion-verify-result');
  if (!resultEl || !assertionDraft) return;
  if (_lastVerify.length === 0) {
    resultEl.classList.add('hidden');
    return;
  }
  const pageResults = _lastVerify.filter(r => r.family === 'page');
  const skipCount = _lastVerify.length - pageResults.length;
  const passed = pageResults.filter(r => r.matched === true).length;
  const failed = pageResults.length - passed;
  const match = assertionDraft.body?.match ?? 'all';
  const k = assertionDraft.body?.count ?? 1;

  // Match-mode aware overall result. Skipped (scope/reference) conditions
  // are not counted; the verify only speaks for page conditions.
  let kind, msg;
  if (pageResults.length === 0) {
    kind = 'skip';
    msg = `No page-family conditions to verify (all conditions are scope or reference).`;
  } else if (match === 'all') {
    if (failed === 0) {
      kind = 'ok';
      msg = `✓ All ${pageResults.length} page condition${pageResults.length === 1 ? '' : 's'} matched (ALL mode).`;
    } else {
      kind = 'err';
      msg = `✗ ${failed} of ${pageResults.length} page condition${pageResults.length === 1 ? '' : 's'} failed (ALL mode).`;
    }
  } else if (match === 'any') {
    if (passed > 0) {
      kind = 'ok';
      msg = `✓ ${passed} of ${pageResults.length} page condition${pageResults.length === 1 ? '' : 's'} matched (ANY mode — assertion satisfied).`;
    } else {
      kind = 'err';
      msg = `✗ 0 of ${pageResults.length} page condition${pageResults.length === 1 ? '' : 's'} matched (ANY mode — assertion not satisfied).`;
    }
  } else if (match === 'k_of_n') {
    if (passed >= k) {
      kind = 'ok';
      msg = `✓ ${passed} of ${pageResults.length} page condition${pageResults.length === 1 ? '' : 's'} matched (k_of_n mode, k=${k} — assertion satisfied).`;
    } else {
      kind = 'err';
      msg = `✗ ${passed} of ${pageResults.length} matched, need ${k} (k_of_n mode).`;
    }
  } else {
    kind = 'skip';
    msg = `Unknown match mode "${match}".`;
  }

  if (skipCount > 0) {
    msg += ` (${skipCount} non-page condition${skipCount === 1 ? '' : 's'} skipped — runtime-only.)`;
  }

  resultEl.classList.remove('hidden');
  resultEl.className = `assertion-verify-result status-${kind}`;
  resultEl.textContent = msg;
}

// ─── Setup (one-time wiring) ────────────────────────────────────────────

/**
 * Wire button handlers and store callbacks/shared functions. Called once
 * at studio.js load time.
 *
 * @param {Object} opts
 * @param {Function} opts.refreshGroundList       — refresh Ground card after persistence
 * @param {Function} opts.renderConditionEditor   — shared editor renderer
 * @param {Function} opts.decodeConditionTypeValue — decode synthetic dropdown values
 * @param {Function} opts.emptyCondition          — empty condition factory
 */
export function setupAssertionForm({
  refreshGroundList,
  renderConditionEditor,
  decodeConditionTypeValue,
  emptyCondition,
}) {
  _refreshGroundList = refreshGroundList;
  _renderConditionEditor = renderConditionEditor;
  _decodeConditionTypeValue = decodeConditionTypeValue;
  _emptyCondition = emptyCondition;

  // Wire assertion form buttons (one-time)
  $('btn-cancel-assertion')?.addEventListener('click', () => closeAssertionForm());
  $('btn-save-assertion')?.addEventListener('click', () => saveAssertion());
  $('btn-add-assertion-condition')?.addEventListener('click', () => {
    if (!assertionDraft) return;
    assertionDraft.body.conditions.push({ type: 'selector_present', selector: '' });
    renderAssertionConditions();
  });
  $('input-assertion-match')?.addEventListener('change', (e) => {
    if (assertionDraft) assertionDraft.body.match = e.target.value;
    // v2.47.0 (Pass O2) — show/hide count row when mode toggles
    const countRow = $('input-assertion-count-row');
    const countInp = $('input-assertion-count');
    if (e.target.value === 'k_of_n') {
      countRow?.classList.remove('hidden');
      if (assertionDraft && countInp) {
        // Initialize count to 1 when first switching into k_of_n
        const k = parseInt(countInp.value, 10);
        if (!Number.isFinite(k) || k < 1) countInp.value = '1';
        assertionDraft.body.count = parseInt(countInp.value, 10) || 1;
      }
    } else {
      countRow?.classList.add('hidden');
    }
  });
  // v2.47.0 — count input change updates draft live so save sees the right value
  $('input-assertion-count')?.addEventListener('input', (e) => {
    if (assertionDraft && assertionDraft.body.match === 'k_of_n') {
      const k = parseInt(e.target.value, 10);
      assertionDraft.body.count = Number.isFinite(k) ? k : 0;
    }
  });

  // v2.72.28 (Pass 16) — Generate-from-description.
  $('btn-assertion-generate')?.addEventListener('click', handleGenerate);

  // v2.72.47 (Pass 18) — Live-DOM verify wirings.
  $('btn-assertion-verify')?.addEventListener('click', () => verifyAssertionOnActiveTab());

  // Track the active tab so the user can see which tab they're verifying
  // against. Refresh on tab activation, on URL changes, and when the form
  // first opens (handled in openAssertionForm).
  chrome.tabs?.onActivated?.addListener?.(() => {
    if (!assertionDraft) return;
    refreshVerifyTabInfo();
    // Active tab changed — any verify result is stale. Clear pills.
    if (_lastVerify.length > 0) {
      clearVerifyState();
      renderAssertionConditions();
    }
  });
  chrome.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
    if (!assertionDraft) return;
    // Refresh tab info if URL changed on the currently-active tab.
    if (changeInfo.url || changeInfo.status === 'complete') {
      refreshVerifyTabInfo();
    }
    // Verify state stale if the verified tab navigated.
    if (tabId === _lastVerifyTabId && (changeInfo.url || changeInfo.status === 'complete')) {
      clearVerifyState();
      renderAssertionConditions();
    }
  });
}
