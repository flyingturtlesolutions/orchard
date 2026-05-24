/**
 * @file Studio/FragmentForm.js
 * @description Fragment primitive authoring, walk panel, and post-walk
 * review panel + EXTRACT authoring. Fragments are sequences of recorded
 * DOM actions (CLICK, FILL, WAIT, ENUMERATE, EXTRACT, EMIT) that an LLM
 * walks live on a target page; the resulting trace is reviewed and saved
 * as a strategy step.
 *
 * ── Module shape ──────────────────────────────────────────────────────
 *
 * Internal state (file-local):
 *   - fragmentDrafts          : Map<fragmentId, draftMetadata> for in-flight
 *                               walks (pageClass, antecedent, isRewalk, etc.)
 *   - fragmentWalkPanels      : Map<fragmentId, panelEl> for live walk display
 *   - fragmentReviews         : Map<fragmentId, fragment> for post-walk review
 *   - fragmentAssertionCache  : Map<fragmentId, assertions[]> for review panel
 *   - fragmentPerspectiveCache     : Map<fragmentId, perspectives[]> for review panel
 *
 * Exported entry points (post v2.74.22 — review panel + lifecycle only;
 * the new-fragment form was removed alongside the AI-walked path):
 *   - editFragment(fragmentId)                       : open review panel
 *   - rewalkFragment(fragmentId)                     : open sidepanel author
 *                                                       mode with prefilled
 *                                                       actions
 *   - deleteFragment(fragmentId)                     : delete with confirm
 *   - enhanceFragment(fragmentId)                    : auto-insert WAIT /
 *                                                       BLUR / WAIT_FOR
 *                                                       gates between actions
 *   - showFragmentReviewPanel(fragment, actions)     : called by migration
 *                                                       tool to open review
 *                                                       panel on a built
 *                                                       fragment
 *   - dropFragmentDraft(fragmentId)                  : drop in-flight review
 *                                                       state
 *   - setupFragmentForm({ refreshGroundList,
 *                          renderConditionEditor,
 *                          decodeConditionTypeValue,
 *                         })                          : one-time wiring
 *
 * Dependencies (direct imports):
 *   - StorageManager       : Fragment + cross-primitive reads
 *   - shared.js helpers    : $, escAttr, escHtml, toast, uid
 *   - Services/Assertion   : CONDITION_FIELDS, emptyCondition, getFamily
 *
 * Setup-time injections (studio.js-internal editor surface):
 *   - renderConditionEditor / decodeConditionTypeValue — shared editor
 *   - refreshGroundList — host's refresh callback
 *
 * Extracted from studio.js (Pass 17f) — the largest decomposition pass.
 *
 * @module Studio/FragmentForm
 * @author Agent HUB
 * @version 2.74.22
 */

import { StorageManager } from '../Services/StorageManager.js';
import { uid, $, escAttr, escHtml, toast, openSidepanelHere } from '../shared.js';
import { CONDITION_FIELDS, emptyCondition, getFamily } from '../Services/Assertion.js';
import { checkAssertionRefFamilies } from './assertionFamilyCheck.js';
import { composeDescriptions } from '../Services/FragmentDescription.js';

// ─── Setup-time injections ──────────────────────────────────────────────

let _refreshGroundList = null;
let _renderConditionEditor = null;
let _decodeConditionTypeValue = null;

// ─── Fragment authoring ──────────────────────────────────────────────────
//
// v2.74.22 — Authoring is wholly owned by the sidepanel fragment-author
// mode. Studio's role:
//   1. + Fragment on a Ground row opens sidepanel.html and dispatches
//      BEGIN_FRAGMENT_AUTHOR (handler in studio.js).
//   2. Re-walk on a saved fragment opens the same sidepanel mode with
//      prefilledActions (handler is rewalkFragment in this module).
//   3. After save, the mode broadcasts STORAGE_CHANGED and Studio's
//      Ground card refreshes its fragment list.
//
// The legacy AI-walked (T3) path — Studio fragment form, fragmentTier
// gating, START_FRAGMENT_WALK dispatch, fragment-walk sidepanel mode,
// in-Studio walk panel — is gone. The form-related state vars
// (fragmentFormGroundId, editingFragmentId, fragmentTier, etc.) and
// helpers (openFragmentForm, closeFragmentForm, renderFragmentTierUI,
// refreshAntecedentPreview) were all removed.

/** @type {Map<string, Object>} fragmentId → draft metadata (name, desc, pageClass) */
const fragmentDrafts = new Map();

/**
 * Delete a Fragment after confirmation. Cascade-cleans its walk session
 * (via StorageManager.deleteFragment).
 */
export async function deleteFragment(fragmentId) {
  const frag = await StorageManager.getFragment(fragmentId);
  if (!frag) return;

  // Pass B+ — warn about dependents. Other Fragments on the same Ground may
  // reference this one as their antecedent. Deleting without surfacing that
  // would silently break their chains.
  const siblings = await StorageManager.listFragments(frag.groundId);
  const dependents = siblings.filter(s => s.antecedentFragmentId === fragmentId);

  let msg = `Delete Fragment "${frag.name}"? This cannot be undone.`;
  if (dependents.length > 0) {
    const names = dependents.map(d => `"${d.name}"`).join(', ');
    msg = `Delete Fragment "${frag.name}"?\n\n⚠ ${dependents.length} other Fragment${dependents.length === 1 ? ' uses' : 's use'} this as an antecedent: ${names}\nTheir antecedent link will be cleared. This cannot be undone.`;
  }
  if (!confirm(msg)) return;

  // Clear the antecedent pointer on dependents so their chain doesn't break
  for (const dep of dependents) {
    await new Promise(r => chrome.runtime.sendMessage({
      type: 'UPDATE_FRAGMENT',
      payload: { fragmentId: dep.id, patch: { antecedentFragmentId: null, antecedentParamBindings: null } },
    }, r));
  }

  await new Promise(r => chrome.runtime.sendMessage({
    type: 'DELETE_FRAGMENT', payload: { fragmentId },
  }, r));
  toast(dependents.length > 0
    ? `Fragment deleted (${dependents.length} antecedent link${dependents.length === 1 ? '' : 's'} cleared)`
    : 'Fragment deleted');
  await _refreshGroundList();
}

/**
 * v2.74.22 — Re-walk now opens the fragment-author sidepanel mode
 * directly with prefilledActions, mirroring + Fragment. The Studio
 * fragment-form-card is gone; antecedent picking happens in the
 * sidepanel's antecedent + Run card.
 */
export async function rewalkFragment(fragmentId) {
  const existing = await StorageManager.getFragment(fragmentId);
  if (!existing) { toast('Fragment not found', 'err'); return; }

  const ground = await StorageManager.getGround(existing.groundId);
  if (!ground) { toast('Ground not found', 'err'); return; }

  // Parse the existing rawJson so the sidepanel can pre-populate its
  // action list. Each row marks verified=null in the mode so the user
  // re-verifies on the live page.
  let prefilledActions = null;
  if (existing.rawJson) {
    try {
      const parsed = JSON.parse(existing.rawJson);
      if (Array.isArray(parsed)) prefilledActions = parsed;
    } catch (e) {
      console.warn('[FragmentForm] re-walk could not parse rawJson:', e?.message);
    }
  }

  // Open the sidepanel synchronously so the user-gesture chain stays
  // intact for chrome.sidePanel.open (matches + Fragment pattern).
  // v2.74.140 — Use openSidepanelHere so a prior per-tab Chat override
  // doesn't leave the panel on chat.html. The shared helper sets BOTH
  // the global default AND the active tab's per-tab path, displacing
  // any in-flight Chat override.
  await openSidepanelHere('sidepanel.html');

  chrome.runtime.sendMessage({
    type: 'BEGIN_FRAGMENT_AUTHOR',
    payload: {
      fragmentId : existing.id,
      groundId   : existing.groundId,
      groundUrl  : existing.startUrl ?? ground.url,
      name       : '',                 // mode reads rewalkName for title
      description: '',                 // mode reads rewalkDescription
      pageClass  : existing.pageClass ?? null,
      isRewalk   : true,
      antecedentFragmentId    : existing.antecedentFragmentId    ?? null,
      antecedentParamBindings : existing.antecedentParamBindings ?? null,
      prefilledActions,
      rewalkName       : existing.name,
      rewalkDescription: existing.description,
    },
  }, (response) => {
    if (!response?.success && !response?.aborted) {
      toast(`Re-walk failed to start: ${response?.error ?? 'unknown'}`, 'err');
    }
  });
}

/**
 * v2.72.81 — Studio Enhance: auto-insert WAIT / WAIT_FOR / BLUR transition
 * gates between actions in a saved T1 Fragment. Heuristic-based (no LLM).
 *
 * Rules applied (in order, scanning pairs of adjacent actions):
 *   - TYPE/SELECT followed by another TYPE/SELECT (different selector):
 *     insert BLUR for the first field (commit before next focuses).
 *   - TYPE/SELECT followed by CLICK: insert BLUR + WAIT 200ms (commit,
 *     then let any client-side validation settle).
 *   - CLICK followed by TYPE/SELECT/CLICK: insert WAIT_FOR pointing at
 *     the next action's selector (wait for next field/button to be
 *     ready post-state-change).
 *   - CLICK at end of fragment with postconditions declared: insert
 *     WAIT 500ms before end (let page settle for postcondition check).
 *
 * Cap enforcement: the saved fragment must not exceed the user's
 * configured fragment-cap setting (default 7, or unlimited when
 * fragment_cap_unlimited is set). If proposed insertions would exceed
 * the cap, only insert what fits and warn the user.
 *
 * Confirmation: prompts the user to confirm before saving (the change
 * is destructive — overwrites rawJson). User can cancel.
 *
 * Verification: all newly-inserted gates AND any actions whose timing
 * shifted are marked unverified... wait — saved Fragments don't carry
 * per-action verified state. The verified state lives only in the
 * fragment-author mode session. Saved fragments are just rawJson +
 * pre/post conditions. So no per-action invalidation needed at save
 * time — Enhance just rewrites rawJson and saves. If the user wants
 * to re-verify, they re-walk the fragment (rewalkFragment loads the
 * actions into the mode for re-verification).
 *
 * @param {string} fragmentId
 */
// v2.74.12 — Fragment cap is now a configurable setting (not a hard
// constant). Read at enhance time so the trimmer respects user choice
// (default 7, or unlimited if the user opted in via Settings).
async function _readFragmentCapSetting() {
  try {
    const capRes = await new Promise(r =>
      chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'fragment_cap', defaultValue: 7 } }, r)
    );
    const unlimRes = await new Promise(r =>
      chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'fragment_cap_unlimited', defaultValue: false } }, r)
    );
    const cap = Number(capRes?.value);
    return {
      cap: (Number.isFinite(cap) && cap > 0) ? cap : 7,
      unlimited: unlimRes?.value === true,
    };
  } catch (_) {
    return { cap: 7, unlimited: false };
  }
}

export async function enhanceFragment(fragmentId) {
  const existing = await StorageManager.getFragment(fragmentId);
  if (!existing) { toast('Fragment not found', 'err'); return; }
  if (existing.authoringTier !== 'T1') {
    toast('Enhance is T1-only (Frontier fragments are AI-walked)', 'err');
    return;
  }

  // Parse current rawJson into an array of {action, selector, value, smoothScroll?}.
  let actions;
  try {
    actions = JSON.parse(existing.rawJson ?? '[]');
  } catch (e) {
    toast('Fragment rawJson is malformed', 'err');
    return;
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    toast('Fragment has no actions to enhance', 'err');
    return;
  }

  // Build the enhanced sequence by walking pairs and inserting heuristic
  // gates. We work on a fresh array; original `actions` stays untouched
  // for the rules to read.
  const enhanced = [];
  for (let i = 0; i < actions.length; i++) {
    enhanced.push(actions[i]);
    const cur = actions[i];
    const next = actions[i + 1];
    if (!next) continue;

    const curIsInput  = cur.action  === 'TYPE' || cur.action  === 'SELECT';
    const nextIsInput = next.action === 'TYPE' || next.action === 'SELECT';
    // v2.72.91 — CLICK_BY_LABEL behaves like CLICK for the purpose of
    // these heuristics (it fires a click event that may trigger a
    // navigation or settle). Treat them identically.
    const nextIsClick = next.action === 'CLICK' || next.action === 'CLICK_BY_LABEL';
    const curIsClick  = cur.action  === 'CLICK' || cur.action  === 'CLICK_BY_LABEL';
    const nextHasSelector = !!(next.selector && next.selector.trim());

    // Rule 1: TYPE/SELECT → TYPE/SELECT (different selector) → insert BLUR.
    if (curIsInput && nextIsInput && cur.selector !== next.selector) {
      enhanced.push({ action: 'BLUR', selector: cur.selector ?? '', value: '' });
      continue;
    }
    // Rule 2: TYPE/SELECT → CLICK → insert BLUR + small WAIT.
    if (curIsInput && nextIsClick) {
      enhanced.push({ action: 'BLUR', selector: cur.selector ?? '', value: '' });
      enhanced.push({ action: 'WAIT', selector: '', value: '200' });
      continue;
    }
    // Rule 3: CLICK → anything-with-selector → insert WAIT_FOR for the next.
    if (curIsClick && nextHasSelector) {
      enhanced.push({ action: 'WAIT_FOR', selector: next.selector, value: '' });
      continue;
    }
  }
  // Rule 4: CLICK at end + postconditions exist → insert WAIT 500ms.
  // v2.72.91 — CLICK_BY_LABEL also treated as a clicking action.
  const last = enhanced[enhanced.length - 1];
  if ((last?.action === 'CLICK' || last?.action === 'CLICK_BY_LABEL')
      && Array.isArray(existing.postconditions) && existing.postconditions.length > 0) {
    enhanced.push({ action: 'WAIT', selector: '', value: '500' });
  }

  const inserted = enhanced.length - actions.length;
  if (inserted === 0) {
    toast('No transition gates needed — fragment is already well-paced', 'info');
    return;
  }

  // Cap enforcement.
  // v2.74.12 — Read user's fragment-cap setting. Unlimited mode skips
  // trimming entirely.
  const capSetting = await _readFragmentCapSetting();
  let trimmed = enhanced;
  let trimmedCount = 0;
  if (!capSetting.unlimited && enhanced.length > capSetting.cap) {
    trimmed = enhanced.slice(0, capSetting.cap);
    trimmedCount = enhanced.length - capSetting.cap;
  }

  // Confirm with the user. Show the count of inserts and any cap warning.
  const msgLines = [
    `Insert ${inserted} transition gate${inserted === 1 ? '' : 's'} into "${existing.name ?? 'Fragment'}"?`,
    '',
    'Heuristic rules applied:',
    '  • BLUR after TYPE/SELECT before another field',
    '  • WAIT_FOR after CLICK pointing at next selector',
    '  • Small WAIT before CLICK after a field commit',
  ];
  if (trimmedCount > 0) {
    msgLines.push('');
    msgLines.push(`⚠ Capped at ${capSetting.cap} — ${trimmedCount} action${trimmedCount === 1 ? '' : 's'} dropped from the end.`);
  }
  if (!confirm(msgLines.join('\n'))) return;

  // Re-number step indices and persist rawJson.
  const reIndexed = trimmed.map((a, i) => ({ ...a, step: i + 1 }));
  const updated = { ...existing, rawJson: JSON.stringify(reIndexed) };

  const res = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'SAVE_FRAGMENT', payload: { fragment: updated } }, resolve);
  });
  if (!res?.success) {
    toast(`Save failed: ${res?.error ?? 'unknown'}`, 'err');
    return;
  }
  toast(`Enhanced — ${inserted} gate${inserted === 1 ? '' : 's'} inserted${trimmedCount > 0 ? ` (${trimmedCount} dropped)` : ''}`);
  if (typeof _refreshGroundList === 'function') _refreshGroundList();
}

/**
 * Pass Cα/v2.25.3 — Open the Fragment review panel to edit metadata and
 * conditions on an existing Fragment. Does NOT touch rawJson (the recorded
 * DOM action body) — that requires a re-walk.
 *
 * Reuses showFragmentReviewPanel — a full editable form already exists; we
 * just need to open it on an existing record and flag it as edit-mode so
 * titling and affordances adjust.
 */
export async function editFragment(fragmentId) {
  const existing = await StorageManager.getFragment(fragmentId);
  if (!existing) { toast('Fragment not found', 'err'); return; }

  // Build a mutable payload from the stored Fragment in the shape the
  // review panel expects (preconditions/postconditions/params arrays
  // owned by the panel). The `isEdit` flag adjusts titling and copy.
  const payload = {
    ...existing,
    preconditions : Array.isArray(existing.preconditions)  ? existing.preconditions.map(c => ({ ...c }))  : [],
    postconditions: Array.isArray(existing.postconditions) ? existing.postconditions.map(c => ({ ...c })) : [],
    params        : Array.isArray(existing.params) ? [...existing.params] : [],
    isEdit        : true,    // signals the review panel to switch title/copy
    isRewalk      : false,   // distinguish from rewalk save path
  };

  let actions = [];
  try { actions = JSON.parse(existing.rawJson ?? '[]'); } catch { /* keep empty */ }

  showFragmentReviewPanel(payload, actions);
}


// v2.74.22 — Walk lifecycle handlers (handleFragmentWalkProgress,
// handleFragmentWalkComplete) and the AI-walked path that fed them
// (fragment-walk sidepanel mode, FRAGMENT_WALK_* events) are gone.
// The in-Studio review panel below (showFragmentReviewPanel) is
// reachable only via editFragment for editing existing Fragments.

// ─── Fragment review panel ───────────────────────────────────────────────────

/** @type {Map<string, Object>} fragmentId → draft Fragment being reviewed */
const fragmentReviews = new Map();

/**
 * v2.42.0 (Pass M2) — per-fragment cache of named assertions on the fragment's
 * ground. Populated when the review panel opens. Used by renderReviewConditions
 * to pass the assertion list into renderConditionEditor.
 * @type {Map<string, Array<Object>>} fragmentId → assertions list
 */
const fragmentAssertionCache = new Map();

/**
 * v2.72.31 (Pass 17a) — per-fragment cache of perspectives on the fragment's
 * ground. Mirrors fragmentAssertionCache. Used by the review panel's
 * pre/post condition editor to populate the perspective_ref picker.
 * @type {Map<string, Array<Object>>} fragmentId → perspectives list
 */
const fragmentPerspectiveCache = new Map();

/**
 * Render the post-walk review panel. Conditions/params are editable inline;
 * Save persists, Discard drops the draft.
 */
export function showFragmentReviewPanel(fragment, actions) {
  hideFragmentReviewPanel(fragment.id);
  fragmentReviews.set(fragment.id, fragment);

  // v2.42.0 (Pass M2) — Cache assertions for this fragment's ground so the
  // condition editor can populate the named-assertion picker. Fire-and-forget
  // — if it lands after the first render, a re-render will pick it up.
  StorageManager.listAssertions(fragment.groundId).then(preds => {
    fragmentAssertionCache.set(fragment.id, preds);
    // Re-render in case the panel rendered before this resolved
    renderReviewConditions(fragment.id, 'pre');
    renderReviewConditions(fragment.id, 'post');
  }).catch(() => fragmentAssertionCache.set(fragment.id, []));

  // v2.72.31 (Pass 17a) — Cache perspectives for this fragment's ground.
  StorageManager.listPerspectives(fragment.groundId).then(locs => {
    fragmentPerspectiveCache.set(fragment.id, locs);
    renderReviewConditions(fragment.id, 'pre');
    renderReviewConditions(fragment.id, 'post');
  }).catch(() => fragmentPerspectiveCache.set(fragment.id, []));

  const panel = document.createElement('div');
  panel.className = 'fragment-review-panel';
  panel.id = `fragment-review-${fragment.id}`;

  const nActions = actions.length;
  const isEdit = !!fragment.isEdit;
  const titleText = isEdit ? 'Edit Fragment' : 'Review Fragment';
  const actionsHint = isEdit
    ? `${nActions} action${nActions === 1 ? '' : 's'} — re-walk to change`
    : `${nActions} action${nActions === 1 ? '' : 's'} recorded`;

  panel.innerHTML = `
    <div class="review-header">
      <span class="review-title">${titleText}: <strong>${escHtml(fragment.name)}</strong></span>
      <span class="review-summary">${actionsHint}</span>
    </div>
    ${fragment.rationale ? `<div class="review-rationale">💡 ${escHtml(fragment.rationale)}</div>` : ''}

    ${isEdit ? `
    <div class="review-section">
      <label class="review-field">
        <span class="review-field-label">Name</span>
        <input type="text" id="review-name-${fragment.id}" maxlength="80" value="${escAttr(fragment.name ?? '')}" />
      </label>
      <label class="review-field">
        <span class="review-field-label review-field-label-row">
          Description
          <button type="button" class="btn-secondary tiny" data-action="regenerate-desc"
                  title="Replace this textarea with a description auto-composed from the fragment's actions. Use this when the composer was updated (e.g., new chain shape, new branch detail) and you want to refresh the stored description.">↻ Regenerate from actions</button>
        </span>
        <textarea id="review-desc-${fragment.id}" rows="2" maxlength="280">${escHtml(fragment.description ?? '')}</textarea>
      </label>
    </div>
    ` : ''}

    <div class="review-section">
      <div class="review-section-head">
        <span class="review-section-label">Preconditions</span>
        <span class="review-section-hint">State that must hold <em>before</em> this Fragment runs</span>
        <button class="btn-secondary tiny" data-action="add-pre">+ Add</button>
      </div>
      <div class="review-condition-list" id="review-pre-${fragment.id}"></div>
    </div>

    <div class="review-section">
      <div class="review-section-head">
        <span class="review-section-label">Postconditions</span>
        <span class="review-section-hint">State that must hold <em>after</em> for the Fragment to be considered successful</span>
        <button class="btn-secondary tiny" data-action="add-post">+ Add</button>
        ${isEdit ? `<button class="btn-secondary tiny" data-action="test-post" title="Check each postcondition against the active browser tab">Test on current tab</button>` : ''}
      </div>
      <div class="review-condition-list" id="review-post-${fragment.id}"></div>
      <div class="review-test-results hidden" id="review-test-results-${fragment.id}"></div>
    </div>

    <div class="review-section">
      <div class="review-section-head">
        <span class="review-section-label">Parameters</span>
        <span class="review-section-hint">From <code>{{PARAM}}</code> tokens in TYPE values — click × to remove</span>
      </div>
      <div class="review-param-list" id="review-params-${fragment.id}"></div>
    </div>

    <div class="review-section">
      <div class="review-section-head">
        <span class="review-section-label">Recorded actions</span>
        <span class="review-section-hint">DOM actions captured during the walk — re-walk to change</span>
        <button class="btn-secondary tiny review-legacy-action" data-action="add-extract" title="Legacy: append EXTRACT to capture a value. Prefer authoring an Observation (scalar shape) for new work — Observations are typed, parameterizable, and have their own runtime.">+ Extract</button>
        <button class="btn-secondary tiny review-legacy-action" data-action="add-enumerate" title="Legacy: append ENUMERATE to capture a list. Prefer authoring an Observation (list_of_records shape) for new work — Observations are typed, parameterizable, and have their own runtime.">+ Enumerate</button>
        <button class="btn-secondary tiny" data-action="add-emit" title="Append an EMIT action that appends a structured record to a list — use inside a FOREACH to accumulate per-iteration results">+ Emit</button>
      </div>
      <button class="review-actions-toggle" id="review-actions-toggle-${fragment.id}">▶ Show recorded actions (${nActions})</button>
      <div class="review-actions-list hidden" id="review-actions-${fragment.id}"></div>
      <div class="review-extract-form hidden" id="review-extract-form-${fragment.id}"></div>
      <div class="review-enumerate-form hidden" id="review-enumerate-form-${fragment.id}"></div>
      <div class="review-emit-form hidden" id="review-emit-form-${fragment.id}"></div>
    </div>

    <div class="review-footer">
      <button class="btn-secondary" id="review-discard-${fragment.id}">${isEdit ? 'Cancel' : 'Discard'}</button>
      <button class="btn-primary" id="review-save-${fragment.id}">Save Fragment</button>
    </div>`;

  const list = $('ground-list');
  list.insertBefore(panel, list.firstChild);

  // Initial render of condition rows
  renderReviewConditions(fragment.id, 'pre');
  renderReviewConditions(fragment.id, 'post');
  renderReviewParams(fragment.id);
  // E1 (v2.26.0) — actions list now renders from a function so it can be
  // re-rendered when the user adds or removes EXTRACTs without rebuilding
  // the whole panel.
  renderRecordedActions(fragment.id);

  // Edit-mode: wire name/description inputs to the draft
  if (isEdit) {
    const nameInp = panel.querySelector(`#review-name-${fragment.id}`);
    const descInp = panel.querySelector(`#review-desc-${fragment.id}`);
    nameInp?.addEventListener('input', () => {
      const f = fragmentReviews.get(fragment.id);
      if (f) f.name = nameInp.value;
      // Update the header's strong tag live
      const strong = panel.querySelector('.review-title strong');
      if (strong) strong.textContent = nameInp.value || '(unnamed)';
    });
    descInp?.addEventListener('input', () => {
      const f = fragmentReviews.get(fragment.id);
      if (f) f.description = descInp.value;
    });

    // v2.74.11 — Regenerate-from-actions. Replaces the textarea contents
    // with a freshly composed description from the fragment's actions.
    // Useful when the composer was updated (new chain shape, new branch
    // detail) and the stored description is stale. Doesn't auto-save —
    // the author still has to click Save to persist.
    panel.querySelector('[data-action="regenerate-desc"]')?.addEventListener('click', () => {
      const f = fragmentReviews.get(fragment.id);
      if (!f) return;
      // The actions parameter the review panel was opened with is stored
      // separately (the second arg to showFragmentReviewPanel). It IS the
      // parsed rawJson at panel-open time. Re-parse the fragment's stored
      // rawJson here to be safe (in case the panel was opened on a
      // fragment without actions list passed).
      let actions = [];
      try {
        if (typeof fragment.rawJson === 'string' && fragment.rawJson) {
          const parsed = JSON.parse(fragment.rawJson);
          if (Array.isArray(parsed)) actions = parsed;
        }
      } catch { /* keep empty */ }
      if (actions.length === 0) {
        toast('No actions to compose from', 'err');
        return;
      }
      const fresh = composeDescriptions(actions).compact;
      descInp.value = fresh;
      f.description = fresh;
      toast('Description regenerated from actions');
    });

    // Wire "Test on current tab" for postconditions
    panel.querySelector('[data-action="test-post"]')?.addEventListener('click', async () => {
      const f = fragmentReviews.get(fragment.id);
      if (!f) return;
      const nonEmpty = (f.postconditions ?? []).filter(c => conditionValue(c).trim().length > 0);
      if (nonEmpty.length === 0) {
        toast('Add at least one postcondition to test', 'warn');
        return;
      }
      const resultsEl = panel.querySelector(`#review-test-results-${fragment.id}`);
      resultsEl.classList.remove('hidden');
      resultsEl.innerHTML = `<div class="review-test-probing">Probing current tab…</div>`;

      const response = await new Promise(r => chrome.runtime.sendMessage({
        type: 'PROBE_CONDITIONS',
        payload: { conditions: nonEmpty },
      }, r));

      if (!response?.success) {
        resultsEl.innerHTML = `<div class="review-test-error">Couldn't probe: ${escHtml(response?.error ?? 'unknown')}</div>`;
        return;
      }

      // response: { success, results: [{condition, matched, reason?}, ...] }
      const rows = response.results.map(r => {
        const label = conditionLabel(r.condition);
        if (r.matched) {
          return `<div class="review-test-row pass"><span class="test-icon">✓</span><code>${escHtml(label)}</code></div>`;
        }
        return `<div class="review-test-row fail"><span class="test-icon">✕</span><code>${escHtml(label)}</code><span class="test-reason">${escHtml(r.reason ?? 'not met')}</span></div>`;
      }).join('');
      const allPass = response.results.every(r => r.matched);
      const summary = allPass
        ? `<div class="review-test-summary pass">All ${response.results.length} postcondition${response.results.length === 1 ? '' : 's'} pass on the current tab — this Fragment would be skipped if invoked now.</div>`
        : `<div class="review-test-summary fail">${response.results.filter(r => !r.matched).length} of ${response.results.length} postcondition${response.results.length === 1 ? '' : 's'} failed — this Fragment would be invoked if called.</div>`;
      resultsEl.innerHTML = summary + rows;
    });
  }

  // Wire "+ Add precondition" / "+ Add postcondition"
  panel.querySelector('[data-action="add-pre"]').addEventListener('click', () => {
    const f = fragmentReviews.get(fragment.id);
    f.preconditions.push({ type: 'selector_present', selector: '' });
    renderReviewConditions(fragment.id, 'pre');
  });
  panel.querySelector('[data-action="add-post"]').addEventListener('click', () => {
    const f = fragmentReviews.get(fragment.id);
    f.postconditions.push({ type: 'selector_present', selector: '' });
    renderReviewConditions(fragment.id, 'post');
  });

  // Actions list disclosure — note the count is computed live from the
  // current draft, not the stale `nActions` from panel-creation, so
  // EXTRACTs added via "+ Extract" appear in the count immediately.
  panel.querySelector(`#review-actions-toggle-${fragment.id}`).addEventListener('click', () => {
    const listEl = panel.querySelector(`#review-actions-${fragment.id}`);
    const btn    = panel.querySelector(`#review-actions-toggle-${fragment.id}`);
    listEl.classList.toggle('hidden');
    const f = fragmentReviews.get(fragment.id);
    const liveCount = liveActionsForFragment(f).length;
    btn.textContent = listEl.classList.contains('hidden')
      ? `▶ Show recorded actions (${liveCount})`
      : `▼ Hide recorded actions (${liveCount})`;
  });

  // E1 (v2.26.0) — "+ Extract" opens an inline form for authoring an EXTRACT
  // action. EXTRACT is the only action verb users can hand-author (other
  // verbs come from walks against live DOM). Default = append to end of
  // recorded actions list. The form mounts into #review-extract-form-<id>.
  panel.querySelector('[data-action="add-extract"]').addEventListener('click', () => {
    showExtractForm(fragment.id);
  });

  // v2.29.1 (Pass E2-2) — "+ Enumerate" opens an inline form for authoring
  // an ENUMERATE action. Parallel to EXTRACT but produces a list binding
  // consumed by Strategy-level FOREACH nodes.
  panel.querySelector('[data-action="add-enumerate"]').addEventListener('click', () => {
    showEnumerateForm(fragment.id);
  });

  // v2.35.0 (Pass I1) — "+ Emit" opens an inline form for authoring an
  // EMIT action. Appends a structured record (built from already-extracted
  // scalars / iteration variables) to a named list. Used inside FOREACH
  // to accumulate per-iteration results.
  panel.querySelector('[data-action="add-emit"]').addEventListener('click', () => {
    showEmitForm(fragment.id);
  });

  // Discard (fresh walk) / Cancel (edit) — drop the in-panel state, no save
  panel.querySelector(`#review-discard-${fragment.id}`).addEventListener('click', () => {
    if (fragment.isEdit) {
      // Edit mode — the stored Fragment is untouched on disk; just close the panel.
      hideFragmentReviewPanel(fragment.id);
      toast('Edits discarded', 'warn');
    } else {
      if (!confirm('Discard this Fragment walk? The recorded actions will be lost.')) return;
      hideFragmentReviewPanel(fragment.id);
      fragmentDrafts.delete(fragment.id);
      toast('Fragment walk discarded', 'warn');
    }
  });

  // Save — persist and close
  panel.querySelector(`#review-save-${fragment.id}`).addEventListener('click', () => saveReviewedFragment(fragment.id));
}

function hideFragmentReviewPanel(fragmentId) {
  document.getElementById(`fragment-review-${fragmentId}`)?.remove();
  fragmentReviews.delete(fragmentId);
  fragmentAssertionCache.delete(fragmentId);
  fragmentPerspectiveCache.delete(fragmentId);
}

/**
 * Render (or re-render) the condition rows for preconditions or postconditions.
 * Each row has a type dropdown, a type-specific value input, and a delete button.
 * Changes are written directly into the in-memory draft via fragmentReviews.
 */
function renderReviewConditions(fragmentId, side /* 'pre' | 'post' */) {
  const container = $(`review-${side}-${fragmentId}`);
  if (!container) return;
  const fragment = fragmentReviews.get(fragmentId);
  if (!fragment) return;

  const list = side === 'pre' ? fragment.preconditions : fragment.postconditions;

  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state small review-empty">No ${side === 'pre' ? 'pre' : 'post'}conditions — click + Add to create one</div>`;
    return;
  }

  // v2.41.0 (Pass M1.1) — render rows using the unified condition editor.
  // v2.42.0 (Pass M2) — pass assertions list so the named-assertion option
  // appears in the type dropdown when assertions are available on this ground.
  // v2.72.31 (Pass 17a) — pass perspectives list for perspective_ref picker.
  const preds = fragmentAssertionCache.get(fragmentId) ?? [];
  const locs  = fragmentPerspectiveCache.get(fragmentId) ?? [];
  container.innerHTML = list.map((c, i) => {
    const editorHtml = _renderConditionEditor(c, { fragmentId, side, idx: i }, { context: 'fragment', assertions: preds, perspectives: locs });
    return `
      <div class="review-condition-row" data-idx="${i}">
        ${editorHtml}
        <button class="btn-action danger review-cond-remove" data-side="${side}" data-idx="${i}" title="Remove">✕</button>
      </div>`;
  }).join('');

  // Wire type changes — fragment context. data-fragment-id + data-side + data-idx.
  // Switching type seeds the right empty shape (mirrors strategy-side handler).
  // Skips the assertion-library form's editor (fragmentId='__assertion__') —
  // that's handled by renderAssertionConditions's own listeners.
  //
  // v2.45.0 — uses emptyCondition (schema-derived) instead of duplicating
  // per-type field initialization.
  container.querySelectorAll('.cond-type-select[data-context="fragment"]').forEach(sel => {
    if (sel.dataset.fragmentId === '__assertion__') return;
    sel.addEventListener('change', () => {
      const f  = fragmentReviews.get(sel.dataset.fragmentId);
      if (!f) return;
      const cs = sel.dataset.side === 'pre' ? f.preconditions : f.postconditions;
      const idx = parseInt(sel.dataset.idx, 10);
      // v2.70.6 — Decode synthetic 'pred_ref:<id>' values.
      const decoded = _decodeConditionTypeValue(sel.value);
      const fresh = emptyCondition(decoded.type);
      if (decoded.assertionId) fresh.assertionId = decoded.assertionId;
      if (decoded.perspectiveId) fresh.perspectiveId = decoded.perspectiveId;
      cs[idx] = fresh;
      renderReviewConditions(sel.dataset.fragmentId, sel.dataset.side);
    });
  });

  // Wire value inputs — fragment context. Skips assertion library form.
  // v2.45.0 — allowed-fields list derived from CONDITION_FIELDS schema.
  container.querySelectorAll('.cond-value-input[data-context="fragment"]').forEach(inp => {
    if (inp.dataset.fragmentId === '__assertion__') return;
    const handler = () => {
      const f  = fragmentReviews.get(inp.dataset.fragmentId);
      if (!f) return;
      const cs = inp.dataset.side === 'pre' ? f.preconditions : f.postconditions;
      const idx = parseInt(inp.dataset.idx, 10);
      const cond = cs[idx];
      if (!cond) return;
      const field = inp.dataset.field;
      if (CONDITION_FIELDS[cond.type]?.fields.includes(field)) {
        cond[field] = inp.value;
      }
    };
    inp.addEventListener('input', handler);
    inp.addEventListener('change', handler);  // for <select>-typed assertion_ref pickers
  });

  // Wire remove buttons (unchanged from M1.0)
  container.querySelectorAll('.review-cond-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const f  = fragmentReviews.get(fragmentId);
      const cs = btn.dataset.side === 'pre' ? f.preconditions : f.postconditions;
      const idx = parseInt(btn.dataset.idx, 10);
      cs.splice(idx, 1);
      renderReviewConditions(fragmentId, btn.dataset.side);
    });
  });
}

/**
 * Get the "value" of a condition regardless of its type. For
 * attribute_equals, returns the formatted "selector[attribute]=value"
 * representation since there's no single value field.
 *
 * Used by:
 *   - filter-empty checks at fragment-save time
 *   - the test-on-current-tab affordance for postconditions
 *   - conditionLabel
 */
function conditionValue(c) {
  if (!c) return '';
  switch (c.type) {
    case 'selector_present':
    case 'selector_absent':  return c.selector ?? '';
    case 'url_matches':      return c.pattern ?? '';
    case 'text_present':     return c.text ?? '';
    case 'attribute_equals': return `${c.selector ?? ''}[${c.attribute ?? ''}]=${c.value ?? ''}`;
    case 'assertion_ref':    return c.assertionId ?? '';
    default: return '';
  }
}

/** Build a human-readable label for a condition: `selector_present("[data-x]")`. */
function conditionLabel(c) {
  if (!c) return '?';
  const v = conditionValue(c);
  const short = v.length > 60 ? v.slice(0, 60) + '…' : v;
  return `${c.type}("${short}")`;
}


/** Render the param chip list. Clicking × removes a param. */
function renderReviewParams(fragmentId) {
  const container = $(`review-params-${fragmentId}`);
  if (!container) return;
  const fragment = fragmentReviews.get(fragmentId);
  if (!fragment) return;

  if (fragment.params.length === 0) {
    container.innerHTML = `<span class="empty-state small review-empty">No parameters — TYPE values don't include <code>{{TOKENS}}</code></span>`;
    return;
  }

  container.innerHTML = fragment.params.map((p, i) => `
    <span class="review-param-chip" data-idx="${i}">
      <code>{{${escHtml(p)}}}</code>
      <button class="review-param-remove" data-idx="${i}" title="Remove">×</button>
    </span>`).join('');

  container.querySelectorAll('.review-param-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = fragmentReviews.get(fragmentId);
      const idx = parseInt(btn.dataset.idx, 10);
      f.params.splice(idx, 1);
      renderReviewParams(fragmentId);
    });
  });
}

// ─── E1 (v2.26.0) — EXTRACT authoring in the review panel ─────────────────
//
// Users can append EXTRACT actions to a Fragment's body. EXTRACT is the only
// action verb users can hand-author — other verbs (CLICK, TYPE, etc.) come
// from walks against live DOM, where Claude proposed selectors observed on
// the page. EXTRACT is a read-only operation, so authoring it without a walk
// doesn't violate the "actions are based on observed DOM" discipline as
// strongly: even if the selector is wrong, the worst case is a runtime error
// rather than an unintended click.

/**
 * Parse a Fragment's rawJson into the live action array. Returns [] for
 * malformed JSON (defensive — review panel renders all the time, including
 * on partially-edited records).
 */
function liveActionsForFragment(fragment) {
  if (!fragment) return [];
  try {
    const arr = JSON.parse(fragment.rawJson ?? '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * v2.29.6 (Pass F1) — Derive the param set from an action list by scanning
 * BOTH `selector` and `value` fields for `{{NAME}}` tokens.
 *
 * Mirrors the same logic in TemplateWalker (#extractFragmentParams) so that
 * a selector edited here re-derives params the same way a freshly-walked
 * Fragment would. Sorted alphabetically for stable rendering.
 */
function deriveFragmentParams(actions) {
  const set = new Set();
  const re = /\{\{([A-Z0-9_]+)\}\}/g;
  for (const a of actions ?? []) {
    for (const field of ['selector', 'value']) {
      const src = String(a?.[field] ?? '');
      for (const m of src.matchAll(re)) set.add(m[1]);
    }
  }
  return [...set].sort();
}

/**
 * Render the recorded-actions list in the review panel. Re-invoked when an
 * EXTRACT is added or removed. The disclosure-toggle button text is also
 * updated so the count stays in sync.
 */
function renderRecordedActions(fragmentId) {
  const container = $(`review-actions-${fragmentId}`);
  if (!container) return;
  const fragment = fragmentReviews.get(fragmentId);
  if (!fragment) return;

  const actions = liveActionsForFragment(fragment);

  container.innerHTML = actions.map((a, i) => {
    const verb = a.action || '?';
    if (verb === 'EXTRACT') {
      // Distinct rendering: target name first, then the source.
      // Removable since it was added in the review panel (not from a walk).
      const attr = a.attribute && a.attribute !== 'text' ? ` (${escHtml(a.attribute)})` : '';
      const appendBadge = a.append ? ` <span class="action-append-badge" title="Appends to a list across iterations">append</span>` : '';
      return `
        <div class="review-action-row review-action-extract">
          <span class="action-idx">${i + 1}</span>
          <span class="action-name action-extract">EXTRACT</span>
          <code class="action-extract-target">→ {{${escHtml(a.target ?? '?')}}}</code>
          <code class="action-selector">${escHtml((a.selector || '').slice(0, 60))}${attr}</code>
          ${appendBadge}
          <button class="btn-action danger tiny review-extract-remove" data-action-idx="${i}" title="Remove this EXTRACT">✕</button>
        </div>`;
    }
    if (verb === 'ENUMERATE') {
      // v2.29.1 (E2-2) — distinct rendering for ENUMERATE. Shows target,
      // selector, and max cap. Removable like EXTRACT (hand-authored, not
      // from a walk).
      // v2.46.0 (Pass O1) — also shows field count if any are captured.
      const maxLabel = Number.isFinite(a.max) ? `max ${a.max}` : 'max 50';
      const fieldCount = Array.isArray(a.fields) ? a.fields.length : 0;
      const fieldsLabel = fieldCount > 0
        ? `<span class="action-enum-fields" title="${fieldCount} field(s) captured per item: ${escAttr(a.fields.map(f => f.name).join(', '))}">+${fieldCount} field${fieldCount === 1 ? '' : 's'}</span>`
        : '';
      return `
        <div class="review-action-row review-action-enumerate">
          <span class="action-idx">${i + 1}</span>
          <span class="action-name action-enumerate">ENUMERATE</span>
          <code class="action-extract-target">→ {{${escHtml(a.target ?? '?')}}}</code>
          <code class="action-selector">${escHtml((a.selector || '').slice(0, 60))}</code>
          <span class="action-enum-cap" title="Maximum items captured into the list">${escHtml(maxLabel)}</span>
          ${fieldsLabel}
          <button class="btn-action danger tiny review-enumerate-remove" data-action-idx="${i}" title="Remove this ENUMERATE">✕</button>
        </div>`;
    }
    if (verb === 'EMIT') {
      // v2.35.0 (I1) — rendering for EMIT. Shows target + a compact summary
      // of the field names. Full field templates are in the JSON; summary
      // is enough for the recorded-actions view.
      const fieldNames = Object.keys(a.fields ?? {});
      const fieldSummary = fieldNames.length > 0
        ? fieldNames.slice(0, 4).join(', ') + (fieldNames.length > 4 ? `, +${fieldNames.length - 4} more` : '')
        : '(no fields — counter only)';
      return `
        <div class="review-action-row review-action-emit">
          <span class="action-idx">${i + 1}</span>
          <span class="action-name action-emit">EMIT</span>
          <code class="action-extract-target">→ {{${escHtml(a.target ?? '?')}}} (append)</code>
          <code class="action-selector" title="Fields in this record">${escHtml(fieldSummary)}</code>
          <button class="btn-action danger tiny review-emit-remove" data-action-idx="${i}" title="Remove this EMIT">✕</button>
        </div>`;
    }
    // Regular walked actions — selector now editable via inline override
    // (v2.29.6 — Pass F1). Params re-derive from the updated selector on
    // commit, so adding `{{NAME}}` tokens surfaces them in the param list.
    //
    // v2.48.0 — also delete-able. Walks aren't always clean; the walker
    // captures cross-tab clicks as part of the original fragment (a known
    // bug). Authors need a way to delete spurious actions without re-walking.
    const isSelectorAction = !!(a.selector && a.selector.length > 0);
    const selectorHtml = isSelectorAction
      ? `<code class="action-selector" data-action-idx="${i}" data-raw-selector="${escAttr(a.selector)}">${escHtml((a.selector || '').slice(0, 80))}</code>
         <button class="btn-action tiny review-selector-edit" data-action-idx="${i}" title="Override the selector (template with {{NAME}} to parameterize)">✎</button>`
      : `<code class="action-selector">${escHtml((a.selector || '').slice(0, 80))}</code>`;
    return `
      <div class="review-action-row" data-action-row-idx="${i}">
        <span class="action-idx">${i + 1}</span>
        <span class="action-name action-${verb.toLowerCase()}">${escHtml(verb)}</span>
        ${selectorHtml}
        ${a.value ? `<code class="action-value">= ${escHtml(String(a.value).slice(0, 50))}</code>` : ''}
        <button class="btn-action danger tiny review-walked-remove" data-action-idx="${i}" title="Remove this ${escAttr(verb)} action">✕</button>
      </div>`;
  }).join('');

  // Wire EXTRACT remove buttons
  container.querySelectorAll('.review-extract-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = fragmentReviews.get(fragmentId);
      if (!f) return;
      const idx = parseInt(btn.dataset.actionIdx, 10);
      const arr = liveActionsForFragment(f);
      if (idx < 0 || idx >= arr.length) return;
      // Defensive: only allow removing EXTRACT actions, never walked ones
      if (arr[idx].action !== 'EXTRACT') return;
      arr.splice(idx, 1);
      f.rawJson = JSON.stringify(arr);
      // v2.29.6 (F1) — re-derive params in case the removed action was the
      // only carrier of a {{NAME}} token in its selector or value.
      f.params = deriveFragmentParams(arr);
      renderReviewParams(fragmentId);
      renderRecordedActions(fragmentId);
      // Update disclosure-toggle text
      const liveCount = arr.length;
      const tBtn = $(`review-actions-toggle-${fragmentId}`);
      if (tBtn) {
        const hidden = container.classList.contains('hidden');
        tBtn.textContent = hidden
          ? `▶ Show recorded actions (${liveCount})`
          : `▼ Hide recorded actions (${liveCount})`;
      }
    });
  });

  // v2.29.1 — Wire ENUMERATE remove buttons (parallel to EXTRACT removal).
  container.querySelectorAll('.review-enumerate-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = fragmentReviews.get(fragmentId);
      if (!f) return;
      const idx = parseInt(btn.dataset.actionIdx, 10);
      const arr = liveActionsForFragment(f);
      if (idx < 0 || idx >= arr.length) return;
      if (arr[idx].action !== 'ENUMERATE') return;
      arr.splice(idx, 1);
      f.rawJson = JSON.stringify(arr);
      // v2.29.6 (F1) — re-derive params
      f.params = deriveFragmentParams(arr);
      renderReviewParams(fragmentId);
      renderRecordedActions(fragmentId);
      const liveCount = arr.length;
      const tBtn = $(`review-actions-toggle-${fragmentId}`);
      if (tBtn) {
        const hidden = container.classList.contains('hidden');
        tBtn.textContent = hidden
          ? `▶ Show recorded actions (${liveCount})`
          : `▼ Hide recorded actions (${liveCount})`;
      }
    });
  });

  // v2.35.0 (I1) — Wire EMIT remove buttons (parallel to EXTRACT/ENUMERATE
  // removal). EMIT actions are hand-authored via + Emit form, so they're
  // always safe to remove.
  container.querySelectorAll('.review-emit-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = fragmentReviews.get(fragmentId);
      if (!f) return;
      const idx = parseInt(btn.dataset.actionIdx, 10);
      const arr = liveActionsForFragment(f);
      if (idx < 0 || idx >= arr.length) return;
      if (arr[idx].action !== 'EMIT') return;
      arr.splice(idx, 1);
      f.rawJson = JSON.stringify(arr);
      f.params = deriveFragmentParams(arr);
      renderReviewParams(fragmentId);
      renderRecordedActions(fragmentId);
      const liveCount = arr.length;
      const tBtn = $(`review-actions-toggle-${fragmentId}`);
      if (tBtn) {
        const hidden = container.classList.contains('hidden');
        tBtn.textContent = hidden
          ? `▶ Show recorded actions (${liveCount})`
          : `▼ Hide recorded actions (${liveCount})`;
      }
    });
  });

  // v2.48.0 — walked-action remove (CLICK / TYPE / NAVIGATE / etc).
  // Walks aren't always clean: the walker can capture cross-tab clicks as
  // part of the original fragment, leaving spurious actions behind. This
  // gives authors a way to delete those without re-walking the whole
  // fragment. No type guard (unlike EXTRACT/ENUMERATE/EMIT) — any walked
  // action can be removed. Warns softly when the user removes the LAST
  // action of a fragment (turns it into a no-op).
  container.querySelectorAll('.review-walked-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = fragmentReviews.get(fragmentId);
      if (!f) return;
      const idx = parseInt(btn.dataset.actionIdx, 10);
      const arr = liveActionsForFragment(f);
      if (idx < 0 || idx >= arr.length) return;
      const removedVerb = arr[idx].action ?? 'action';
      arr.splice(idx, 1);
      f.rawJson = JSON.stringify(arr);
      f.params = deriveFragmentParams(arr);
      renderReviewParams(fragmentId);
      renderRecordedActions(fragmentId);
      const liveCount = arr.length;
      const tBtn = $(`review-actions-toggle-${fragmentId}`);
      if (tBtn) {
        const hidden = container.classList.contains('hidden');
        tBtn.textContent = hidden
          ? `▶ Show recorded actions (${liveCount})`
          : `▼ Hide recorded actions (${liveCount})`;
      }
      // Soft signal — confirm the deletion succeeded; warn if it left empty.
      if (liveCount === 0) {
        toast(`Removed ${removedVerb} — fragment is now empty (will no-op when invoked)`, 'warn');
      } else {
        toast(`Removed ${removedVerb} action`);
      }
    });
  });

  // v2.29.6 (Pass F1) — Wire selector-override pencils. Clicking opens an
  // inline input. Commit on Enter or blur mutates actions[i].selector in the
  // live rawJson, re-derives params from the updated actions (so `{{NAME}}`
  // tokens in the new selector surface in the params list), and re-renders
  // both the action row and the params panel above.
  container.querySelectorAll('.review-selector-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.actionIdx, 10);
      const f = fragmentReviews.get(fragmentId);
      if (!f) return;
      const arr = liveActionsForFragment(f);
      if (idx < 0 || idx >= arr.length) return;

      const row = container.querySelector(`[data-action-row-idx="${idx}"]`);
      const codeEl = row?.querySelector('.action-selector');
      if (!row || !codeEl) return;
      const currentSelector = arr[idx].selector ?? '';

      // Replace <code> with <input>, focus + select, listen for commit/cancel
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'action-selector-edit-input';
      input.value = currentSelector;
      input.setAttribute('spellcheck', 'false');
      input.title = 'Use {{NAME}} to parameterize (e.g. {{JOB}} a.jcs-JobTitle). Enter to save, Esc to cancel.';
      codeEl.replaceWith(input);
      btn.style.display = 'none';
      input.focus();
      input.select();

      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        const next = input.value;
        const changed = next !== currentSelector;
        if (changed) {
          arr[idx].selector = next;
          f.rawJson = JSON.stringify(arr);
          // Re-derive params from updated actions (so new {{NAME}} tokens
          // show up / removed ones drop out).
          f.params = deriveFragmentParams(arr);
          renderReviewParams(fragmentId);
          toast(`Selector updated for step ${idx + 1}`, 'ok');
        }
        // Re-render the actions list either way to restore the row layout
        renderRecordedActions(fragmentId);
      };
      const cancel = () => {
        if (committed) return;
        committed = true;
        renderRecordedActions(fragmentId);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      });
      input.addEventListener('blur', commit);
    });
  });

  // If the list was hidden (default), keep it hidden but update the toggle
  // button to reflect the live count
  const tBtn = $(`review-actions-toggle-${fragmentId}`);
  if (tBtn && container.classList.contains('hidden')) {
    tBtn.textContent = `▶ Show recorded actions (${actions.length})`;
  }
}

/**
 * Mount the inline form for adding a new EXTRACT action. The form drops into
 * #review-extract-form-<id>; only one is visible at a time. Submitting
 * appends the EXTRACT to the Fragment's rawJson, re-renders the list, and
 * collapses the form.
 */
function showExtractForm(fragmentId) {
  const formEl = $(`review-extract-form-${fragmentId}`);
  if (!formEl) return;

  // Toggle: clicking + Extract again while form is open closes it
  if (!formEl.classList.contains('hidden')) {
    formEl.classList.add('hidden');
    formEl.innerHTML = '';
    return;
  }

  formEl.classList.remove('hidden');
  formEl.innerHTML = `
    <div class="extract-form-card">
      <div class="extract-form-head">Add EXTRACT action</div>
      <p class="extract-form-hint">Captures a value from the page into the Strategy's scope. Available to subsequent steps as <code>{{NAME}}</code>.</p>

      <label class="extract-form-field">
        <span class="extract-form-label">Target name</span>
        <input type="text" class="extract-form-input" data-extract-field="target" placeholder="e.g. SALARY, TITLE, JOB_URL" maxlength="60" />
        <span class="extract-form-hint-inline">UPPER_SNAKE_CASE convention. Becomes a Strategy parameter.</span>
      </label>

      <label class="extract-form-field">
        <span class="extract-form-label">Selector</span>
        <input type="text" class="extract-form-input" data-extract-field="selector" placeholder="e.g. .salary-snippet, [data-testid='job-title']" />
      </label>

      <label class="extract-form-field">
        <span class="extract-form-label">What to read</span>
        <select class="extract-form-input" data-extract-field="attribute">
          <option value="text">text content (default)</option>
          <option value="innerText">innerText (visible only)</option>
          <option value="value">form field value</option>
          <option value="href">href attribute</option>
          <option value="src">src attribute</option>
          <option value="title">title attribute</option>
          <option value="__custom__">other attribute…</option>
        </select>
        <input type="text" class="extract-form-input extract-attr-custom hidden" data-extract-field="attribute-custom" placeholder="attribute name" maxlength="40" />
      </label>

      <label class="extract-form-field extract-form-checkbox">
        <input type="checkbox" data-extract-field="append" />
        <span class="extract-form-label">Append to list (for accumulating across iterations)</span>
      </label>

      <div class="extract-form-actions">
        <button class="btn-secondary tiny" data-extract-action="cancel">Cancel</button>
        <button class="btn-primary tiny" data-extract-action="submit">Add to Fragment</button>
      </div>
    </div>`;

  const targetInp = formEl.querySelector('[data-extract-field="target"]');
  const selInp    = formEl.querySelector('[data-extract-field="selector"]');
  const attrSel   = formEl.querySelector('[data-extract-field="attribute"]');
  const attrCust  = formEl.querySelector('[data-extract-field="attribute-custom"]');
  const appendInp = formEl.querySelector('[data-extract-field="append"]');

  // Show the custom attribute input only when "other attribute…" is picked
  attrSel.addEventListener('change', () => {
    if (attrSel.value === '__custom__') {
      attrCust.classList.remove('hidden');
      attrCust.focus();
    } else {
      attrCust.classList.add('hidden');
      attrCust.value = '';
    }
  });

  formEl.querySelector('[data-extract-action="cancel"]').addEventListener('click', () => {
    formEl.classList.add('hidden');
    formEl.innerHTML = '';
  });

  formEl.querySelector('[data-extract-action="submit"]').addEventListener('click', () => {
    const target   = (targetInp.value || '').trim();
    const selector = (selInp.value || '').trim();
    let attribute  = attrSel.value;
    if (attribute === '__custom__') attribute = (attrCust.value || '').trim();
    const append   = appendInp.checked;

    if (!target) { toast('Target name is required', 'err'); targetInp.focus(); return; }
    if (!/^[A-Z][A-Z0-9_]*$/.test(target)) {
      toast('Target name must be UPPER_SNAKE_CASE (letters, digits, underscores)', 'err');
      targetInp.focus();
      return;
    }
    if (!selector) { toast('Selector is required', 'err'); selInp.focus(); return; }
    if (!attribute) { toast('Choose what to read', 'err'); return; }

    const f = fragmentReviews.get(fragmentId);
    if (!f) return;
    const arr = liveActionsForFragment(f);
    arr.push({ action: 'EXTRACT', selector, attribute, target, append });
    f.rawJson = JSON.stringify(arr);
    // v2.29.6 (F1) — re-derive params in case the new EXTRACT's selector
    // contains {{NAME}} tokens.
    f.params = deriveFragmentParams(arr);
    renderReviewParams(fragmentId);

    formEl.classList.add('hidden');
    formEl.innerHTML = '';
    renderRecordedActions(fragmentId);

    // Auto-expand the actions list so the user sees the result
    const listEl = $(`review-actions-${fragmentId}`);
    const tBtn   = $(`review-actions-toggle-${fragmentId}`);
    if (listEl && listEl.classList.contains('hidden')) {
      listEl.classList.remove('hidden');
      if (tBtn) tBtn.textContent = `▼ Hide recorded actions (${arr.length})`;
    }

    toast(`Added EXTRACT → ${target}`);
  });

  setTimeout(() => targetInp.focus(), 0);
}

/**
 * v2.29.1 (Pass E2-2) — Mount the inline form for adding a new ENUMERATE
 * action. Drops into #review-enumerate-form-<id>; only one is visible at
 * a time. Mirrors showExtractForm's toggle + submit flow but with the
 * simpler ENUMERATE shape: { target, selector, max }.
 *
 * ENUMERATE captures a list of matching elements into the Strategy's
 * scope. At Fragment execution time, the walker counts matches and writes
 * a list-of-element-refs value. A Strategy FOREACH node then iterates
 * this list; each iteration binds its iteration variable to one item
 * whose selector is .base:nth-of-type(k).
 */
function showEnumerateForm(fragmentId) {
  const formEl = $(`review-enumerate-form-${fragmentId}`);
  if (!formEl) return;

  // Toggle: clicking + Enumerate again while form is open closes it
  if (!formEl.classList.contains('hidden')) {
    formEl.classList.add('hidden');
    formEl.innerHTML = '';
    return;
  }

  // Close the Extract form if it happens to be open, so only one form
  // shows at a time in the same section.
  const extractEl = $(`review-extract-form-${fragmentId}`);
  if (extractEl && !extractEl.classList.contains('hidden')) {
    extractEl.classList.add('hidden');
    extractEl.innerHTML = '';
  }

  // v2.46.0 (Pass O1) — fields list state lives on the formEl as a JS array.
  // Each entry is { name, source, type } where type is 'string' | 'presence'
  // | 'number' | 'attribute' (with attrName captured separately, then folded
  // into 'attribute:NAME' on submit).
  formEl._fields = [];

  formEl.classList.remove('hidden');
  formEl.innerHTML = `
    <div class="extract-form-card">
      <div class="extract-form-head">Add ENUMERATE action</div>
      <p class="extract-form-hint">Captures N matching elements from the page into the Strategy's scope as a list. Used with <strong>FOREACH</strong> in a Strategy to iterate over each item.</p>

      <label class="extract-form-field">
        <span class="extract-form-label">Target name</span>
        <input type="text" class="extract-form-input" data-enum-field="target" placeholder="e.g. JOBS, RESULTS, CARDS" maxlength="60" />
        <span class="extract-form-hint-inline">UPPER_SNAKE_CASE convention. A FOREACH node in a Strategy references this name.</span>
      </label>

      <label class="extract-form-field">
        <span class="extract-form-label">Selector (matches multiple)</span>
        <input type="text" class="extract-form-input" data-enum-field="selector" placeholder="e.g. .job-card, [data-testid='listing']" />
        <span class="extract-form-hint-inline">The selector should match ALL items you want to iterate. Each item will be referenced as <code>SELECTOR:nth-of-type(k)</code>.</span>
      </label>

      <label class="extract-form-field">
        <span class="extract-form-label">Max items (safety cap)</span>
        <input type="number" class="extract-form-input" data-enum-field="max" value="50" min="1" max="500" />
        <span class="extract-form-hint-inline">Caps iteration count even if more elements match. Default 50; raise for dense lists.</span>
      </label>

      <div class="extract-form-field">
        <div class="enum-fields-head">
          <span class="extract-form-label">Capture fields per item (optional)</span>
          <button class="btn-secondary tiny" data-enum-action="add-field" type="button">+ Field</button>
        </div>
        <span class="extract-form-hint-inline">For each item, capture named values that <code>field_*</code> conditions in DETECT/LOOP can read. Source selector is RELATIVE to the item.</span>
        <div class="enum-fields-list" data-enum-fields-list></div>
      </div>

      <div class="extract-form-actions">
        <button class="btn-secondary tiny" data-enum-action="cancel">Cancel</button>
        <button class="btn-primary tiny" data-enum-action="submit">Add to Fragment</button>
      </div>
    </div>`;

  const targetInp = formEl.querySelector('[data-enum-field="target"]');
  const selInp    = formEl.querySelector('[data-enum-field="selector"]');
  const maxInp    = formEl.querySelector('[data-enum-field="max"]');
  const fieldsListEl = formEl.querySelector('[data-enum-fields-list]');

  // ─── Fields list rendering + handlers (Pass O1) ───────────────────────
  function renderFields() {
    if (!fieldsListEl) return;
    if (formEl._fields.length === 0) {
      fieldsListEl.innerHTML = '';
      return;
    }
    fieldsListEl.innerHTML = formEl._fields.map((f, i) => {
      const isAttr = String(f.type ?? '').startsWith('attribute');
      const attrName = isAttr ? (f.type.includes(':') ? f.type.slice(f.type.indexOf(':') + 1) : '') : '';
      const baseType = isAttr ? 'attribute' : (f.type ?? 'string');
      return `
        <div class="enum-field-row" data-field-idx="${i}">
          <input type="text" class="enum-field-name" data-field-prop="name" value="${escAttr(f.name ?? '')}" placeholder="field name (e.g. salary)" maxlength="40" />
          <input type="text" class="enum-field-source" data-field-prop="source" value="${escAttr(f.source ?? '')}" placeholder="selector relative to item (empty = item itself)" />
          <select class="enum-field-type" data-field-prop="type">
            <option value="string"   ${baseType === 'string'   ? 'selected' : ''}>string</option>
            <option value="presence" ${baseType === 'presence' ? 'selected' : ''}>presence</option>
            <option value="number"   ${baseType === 'number'   ? 'selected' : ''}>number</option>
            <option value="attribute" ${baseType === 'attribute' ? 'selected' : ''}>attribute</option>
          </select>
          <input type="text" class="enum-field-attr" data-field-prop="attrName" value="${escAttr(attrName)}" placeholder="attribute name" style="${baseType === 'attribute' ? '' : 'display:none'}" />
          <button class="btn-action danger tiny" data-enum-action="remove-field" data-field-idx="${i}" type="button" title="Remove field">✕</button>
        </div>`;
    }).join('');
    // Wire change handlers
    fieldsListEl.querySelectorAll('.enum-field-row').forEach(row => {
      const idx = parseInt(row.dataset.fieldIdx, 10);
      row.querySelectorAll('[data-field-prop]').forEach(inp => {
        inp.addEventListener('input', () => updateField(idx, inp.dataset.fieldProp, inp.value));
        inp.addEventListener('change', () => updateField(idx, inp.dataset.fieldProp, inp.value));
      });
      const removeBtn = row.querySelector('[data-enum-action="remove-field"]');
      if (removeBtn) removeBtn.addEventListener('click', () => {
        formEl._fields.splice(idx, 1);
        renderFields();
      });
    });
  }

  function updateField(idx, prop, value) {
    if (!formEl._fields[idx]) return;
    if (prop === 'attrName') {
      // Combine type + attrName into 'attribute:NAME' on the field.type
      formEl._fields[idx].type = value ? `attribute:${value}` : 'attribute';
    } else if (prop === 'type') {
      // When switching to/from attribute, preserve attrName when present
      if (value === 'attribute') {
        // Initialize as bare 'attribute' — user fills NAME next
        formEl._fields[idx].type = 'attribute';
      } else {
        formEl._fields[idx].type = value;
      }
      renderFields();  // re-render so attribute name input shows/hides
    } else {
      formEl._fields[idx][prop] = value;
    }
  }

  formEl.querySelector('[data-enum-action="add-field"]').addEventListener('click', () => {
    formEl._fields.push({ name: '', source: '', type: 'string' });
    renderFields();
  });

  formEl.querySelector('[data-enum-action="cancel"]').addEventListener('click', () => {
    formEl.classList.add('hidden');
    formEl.innerHTML = '';
  });

  formEl.querySelector('[data-enum-action="submit"]').addEventListener('click', () => {
    const target   = (targetInp.value || '').trim();
    const selector = (selInp.value || '').trim();
    const maxRaw   = parseInt(maxInp.value, 10);
    const max      = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(maxRaw, 500) : 50;

    if (!target) { toast('Target name is required', 'err'); targetInp.focus(); return; }
    if (!/^[A-Z][A-Z0-9_]*$/.test(target)) {
      toast('Target name must be UPPER_SNAKE_CASE (letters, digits, underscores)', 'err');
      targetInp.focus();
      return;
    }
    if (!selector) { toast('Selector is required', 'err'); selInp.focus(); return; }

    // v2.46.0 — validate fields
    const fields = [];
    for (let i = 0; i < formEl._fields.length; i++) {
      const f = formEl._fields[i];
      const name = String(f.name ?? '').trim();
      if (!name) {
        toast(`Field ${i + 1}: name is required`, 'err'); return;
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        toast(`Field ${i + 1}: name "${name}" must be a valid identifier (letters, digits, underscores; no leading digit)`, 'err'); return;
      }
      const type = String(f.type ?? 'string');
      if (type === 'attribute') {
        toast(`Field "${name}": attribute type requires an attribute name`, 'err'); return;
      }
      fields.push({ name, source: String(f.source ?? '').trim(), type });
    }

    const f = fragmentReviews.get(fragmentId);
    if (!f) return;
    const arr = liveActionsForFragment(f);
    const action = { action: 'ENUMERATE', selector, target, max, value: '' };
    if (fields.length > 0) action.fields = fields;
    arr.push(action);
    f.rawJson = JSON.stringify(arr);
    // v2.29.6 (F1) — re-derive params (ENUMERATE selectors rarely contain
    // templates, but stay consistent with EXTRACT).
    f.params = deriveFragmentParams(arr);
    renderReviewParams(fragmentId);

    formEl.classList.add('hidden');
    formEl.innerHTML = '';
    renderRecordedActions(fragmentId);

    // Auto-expand the actions list so the user sees the result
    const listEl = $(`review-actions-${fragmentId}`);
    const tBtn   = $(`review-actions-toggle-${fragmentId}`);
    if (listEl && listEl.classList.contains('hidden')) {
      listEl.classList.remove('hidden');
      if (tBtn) tBtn.textContent = `▼ Hide recorded actions (${arr.length})`;
    }

    toast(`Added ENUMERATE → ${target}`);
  });

  setTimeout(() => targetInp.focus(), 0);
}

/**
 * v2.35.0 (Pass I1) — EMIT action authoring form.
 *
 * EMIT packages already-extracted values into a structured record and
 * appends it to a named list. Primary use: inside a FOREACH body, after
 * EXTRACTs capture per-iteration values, EMIT commits one record per
 * iteration. Result: a list-of-records available at strategy end.
 *
 * Form shape: target name + a dynamic list of {fieldName, template} rows.
 * Template strings may reference any {{PARAM}} visible at EMIT time:
 * strategy inputs, iteration variables, prior EXTRACTs in this fragment.
 */
function showEmitForm(fragmentId) {
  const formEl = $(`review-emit-form-${fragmentId}`);
  if (!formEl) return;

  // Toggle: clicking + Emit again while form is open closes it
  if (!formEl.classList.contains('hidden')) {
    formEl.classList.add('hidden');
    formEl.innerHTML = '';
    return;
  }

  // Close the Extract / Enumerate forms if open — only one form at a time
  for (const sibling of ['extract', 'enumerate']) {
    const el = $(`review-${sibling}-form-${fragmentId}`);
    if (el && !el.classList.contains('hidden')) {
      el.classList.add('hidden');
      el.innerHTML = '';
    }
  }

  // Local draft state — array of {fieldName, template} rows. Rendered
  // dynamically so + / - buttons can mutate it.
  let fieldRows = [{ name: '', template: '' }];

  const render = () => {
    formEl.classList.remove('hidden');
    formEl.innerHTML = `
      <div class="extract-form-card">
        <div class="extract-form-head">Add EMIT action</div>
        <p class="extract-form-hint">Packages values into a structured record and appends it to a list. Use inside a <strong>FOREACH</strong> to accumulate per-iteration results. Template strings can reference any <code>{{PARAM}}</code> in scope — strategy inputs, iteration variables, or prior EXTRACTs in this fragment.</p>

        <label class="extract-form-field">
          <span class="extract-form-label">Target list name</span>
          <input type="text" class="extract-form-input" data-emit-field="target" placeholder="e.g. JOBS_DATA, RESULTS, ITEMS" maxlength="60" />
          <span class="extract-form-hint-inline">UPPER_SNAKE_CASE. Each EMIT appends one record to this list. At strategy end, the list is available as <code>{{TARGET}}</code> (renders as JSON).</span>
        </label>

        <div class="extract-form-field">
          <span class="extract-form-label">Record fields</span>
          <div class="emit-fields-list">
            ${fieldRows.map((row, i) => `
              <div class="emit-field-row" data-idx="${i}">
                <input type="text" class="emit-field-name" data-idx="${i}"
                       placeholder="field name, e.g. title"
                       value="${escAttr(row.name)}" />
                <input type="text" class="emit-field-template" data-idx="${i}"
                       placeholder="template, e.g. {{TITLE}}"
                       value="${escAttr(row.template)}" />
                <button class="btn-action danger emit-field-remove" data-idx="${i}" title="Remove this field"${fieldRows.length <= 1 ? ' disabled' : ''}>✕</button>
              </div>
            `).join('')}
          </div>
          <button class="btn-secondary tiny emit-field-add" type="button">+ Add field</button>
          <span class="extract-form-hint-inline">Leave empty for a counter-style EMIT that just tracks iteration count.</span>
        </div>

        <div class="extract-form-actions">
          <button class="btn-secondary tiny" data-emit-action="cancel">Cancel</button>
          <button class="btn-primary tiny" data-emit-action="submit">Add to Fragment</button>
        </div>
      </div>`;

    // Wire dynamic field controls
    formEl.querySelectorAll('.emit-field-name').forEach(inp => {
      inp.addEventListener('input', () => {
        const i = parseInt(inp.dataset.idx, 10);
        if (fieldRows[i]) fieldRows[i].name = inp.value;
      });
    });
    formEl.querySelectorAll('.emit-field-template').forEach(inp => {
      inp.addEventListener('input', () => {
        const i = parseInt(inp.dataset.idx, 10);
        if (fieldRows[i]) fieldRows[i].template = inp.value;
      });
    });
    formEl.querySelectorAll('.emit-field-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.idx, 10);
        if (fieldRows.length > 1) {
          fieldRows.splice(i, 1);
          render();
        }
      });
    });
    formEl.querySelector('.emit-field-add').addEventListener('click', () => {
      fieldRows.push({ name: '', template: '' });
      render();
    });

    formEl.querySelector('[data-emit-action="cancel"]').addEventListener('click', () => {
      formEl.classList.add('hidden');
      formEl.innerHTML = '';
    });

    formEl.querySelector('[data-emit-action="submit"]').addEventListener('click', () => {
      const targetInp = formEl.querySelector('[data-emit-field="target"]');
      const target = (targetInp.value || '').trim();
      if (!target) { toast('Target name is required', 'err'); targetInp.focus(); return; }
      if (!/^[A-Z][A-Z0-9_]*$/.test(target)) {
        toast('Target name must be UPPER_SNAKE_CASE (letters, digits, underscores)', 'err');
        targetInp.focus();
        return;
      }

      // Build the fields object, filtering out fully-blank rows (both
      // name and template empty).
      const fields = {};
      const seenNames = new Set();
      for (const row of fieldRows) {
        const name = (row.name ?? '').trim();
        const tmpl = row.template ?? '';
        if (!name && !tmpl) continue;   // empty row — skip silently
        if (!name) {
          toast('Field name is required when template is provided', 'err');
          return;
        }
        if (seenNames.has(name)) {
          toast(`Duplicate field name "${name}"`, 'err');
          return;
        }
        seenNames.add(name);
        fields[name] = tmpl;
      }

      const f = fragmentReviews.get(fragmentId);
      if (!f) return;
      const arr = liveActionsForFragment(f);
      arr.push({ action: 'EMIT', target, fields, selector: '', value: '' });
      f.rawJson = JSON.stringify(arr);
      f.params = deriveFragmentParams(arr);
      renderReviewParams(fragmentId);

      formEl.classList.add('hidden');
      formEl.innerHTML = '';
      renderRecordedActions(fragmentId);

      // Auto-expand the actions list so the user sees the result
      const listEl = $(`review-actions-${fragmentId}`);
      const tBtn   = $(`review-actions-toggle-${fragmentId}`);
      if (listEl && listEl.classList.contains('hidden')) {
        listEl.classList.remove('hidden');
        if (tBtn) tBtn.textContent = `▼ Hide recorded actions (${arr.length})`;
      }

      toast(`Added EMIT → ${target}`);
    });

    setTimeout(() => formEl.querySelector('[data-emit-field="target"]')?.focus(), 0);
  };

  render();
}

/** Persist the reviewed Fragment via SAVE_FRAGMENT and close the panel. */
async function saveReviewedFragment(fragmentId) {
  const fragment = fragmentReviews.get(fragmentId);
  if (!fragment) return;

  // Strip UI-only fields before persisting
  const record = { ...fragment };
  delete record.isRewalk;
  delete record.isEdit;
  delete record.rationale;    // Keep rationale? It's useful for audit. Keep.
  record.rationale = fragment.rationale;

  // Clean up empty-value conditions — they're not useful at runtime
  record.preconditions  = record.preconditions.filter(c => conditionValue(c).trim().length > 0);
  record.postconditions = record.postconditions.filter(c => conditionValue(c).trim().length > 0);

  // v2.70.1 — Family-compat check on assertion_ref. Fragments only evaluate
  // page-family conditions at runtime (no scope is available during Fragment
  // execution outside the strategy's iteration context). If pre/post contains
  // a assertion_ref pointing at a library assertion that has scope-family
  // conditions, the reference will silently no-op at runtime — fail save with
  // a descriptive error.
  const refIncompat = await checkAssertionRefFamilies(
    [...record.preconditions, ...record.postconditions],
    ['page'],
    record.groundId
  );
  if (refIncompat.length > 0) {
    const first = refIncompat[0];
    toast(
      `Fragment can't use assertion "${first.name}" — it has ${first.foreignFamilies.join('/')} conditions which Fragments don't evaluate. Use only page-side library assertions.`,
      'err'
    );
    return;
  }

  // createdAt: preserve when the record already has one (re-walk or edit).
  // Only stamp it when the record is brand new (fresh walk, no prior timestamp).
  if (!record.createdAt) record.createdAt = Date.now();
  record.updatedAt = Date.now();

  const response = await new Promise(r => chrome.runtime.sendMessage({
    type: 'SAVE_FRAGMENT', payload: { fragment: record },
  }, r));

  if (!response?.success) {
    toast(`Failed to save Fragment: ${response?.error ?? 'unknown'}`, 'err');
    return;
  }

  hideFragmentReviewPanel(fragmentId);
  fragmentDrafts.delete(fragmentId);

  const nActions = JSON.parse(record.rawJson ?? '[]').length;
  toast(`Fragment saved — ${nActions} action${nActions === 1 ? '' : 's'}, ${record.preconditions.length} pre · ${record.postconditions.length} post · ${record.params.length} param${record.params.length === 1 ? '' : 's'}`);

  await _refreshGroundList();
}



// ─── Draft cleanup ──────────────────────────────────────────────────────

/**
 * Drop an in-flight Fragment draft. v2.74.22 — Used to be called by the
 * runtime dispatcher on FRAGMENT_WALK_FAILED / FRAGMENT_WALK_ABORTED;
 * the dispatcher and those events are gone with the AI-walked path.
 * Kept exported because the migration tool clears its draft via this
 * helper after a successful migration.
 */
export function dropFragmentDraft(fragmentId) {
  fragmentDrafts.delete(fragmentId);
}


// ─── Setup (one-time) ───────────────────────────────────────────────────

/**
 * Store injected dependencies. Fragment form has no top-level button
 * wirings (handlers attach to dynamically-created elements as the form
 * builds), so setup is just dependency wiring.
 */
export function setupFragmentForm({
  refreshGroundList,
  renderConditionEditor,
  decodeConditionTypeValue,
}) {
  _refreshGroundList = refreshGroundList;
  _renderConditionEditor = renderConditionEditor;
  _decodeConditionTypeValue = decodeConditionTypeValue;

  // v2.74.22 — Tier picker handlers removed. The form (and its tier
  // gating UI) is gone; new fragments default to T1 cache via the
  // sidepanel author mode.
}
