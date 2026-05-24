/**
 * @file Sidepanel/modes/fragment-author.js
 * @description T1 (cache) Fragment authoring mode. Hand-author each
 * action in a Fragment, picking selectors and verifying on the live
 * page action by action. No LLM involvement; deterministic structured
 * authoring.
 *
 * Lifecycle:
 *   mount(payload, mountEl)    — render header + action list
 *   unmount()                   — drop listeners, clear state
 *   handleEvent(message)        — receives forwarded chrome.runtime
 *                                 messages (PICK_RESULT)
 *
 * Payload (set by background's BEGIN_FRAGMENT_AUTHOR handler):
 *   { fragmentId, groundId, groundUrl, name, description,
 *     pageClass, isRewalk, antecedentFragmentId, antecedentParamBindings,
 *     tabId }
 *
 * Per-action UI mirrors perspective-capture's per-landmark UI:
 *   [order #] [↑↓] [action-type dropdown] [selector input] [value input — conditional]
 *   [Pick]    [Verify]   [✕]
 *
 * Verify executes the single step against the live tab via
 * EXECUTE_AUTHORING_STEP background message. Page state advances after
 * each successful verify. Reordering invalidates ALL verifications.
 *
 * Save persists a Fragment record with rawJson = the verified action
 * sequence + authoringTier='T1' + the metadata from payload. Then
 * exitToStudio per the unified close UX.
 *
 * Action types in v1 (7): WAIT, WAIT_FOR, CLICK, TYPE, SELECT, BLUR,
 * SCROLL_TO. EXTRACT/ENUMERATE excluded (those are Observation
 * primitives, not Fragment actions). FIND_AI excluded (LLM-driven,
 * doesn't fit manual authoring). NAVIGATE excluded (changes
 * grounding context, belongs at Strategy level not Fragment).
 * v2.74.200 — WAIT_FOR_GONE added: polls until selector disappears
 * (the natural pair to WAIT_FOR). Maps to the "wait for loading
 * indicator to vanish" pattern critical for chat workflows.
 *
 * @module Sidepanel/modes/fragment-author
 * @author Agent HUB
 * @version 2.72.60
 */

import { toast, exitToStudio, requestModeChange } from '../shell-api.js';
import { composeCompactDescription } from '../../Services/FragmentDescription.js';
import { CONDITION_FIELDS, emptyCondition } from '../../Services/Assertion.js';
// v2.74.166 — Shared frame-aware picker broadcast helpers. Same code
// path also used by observation-author and perspective-capture.
import { broadcastStartPick, broadcastCancelPick } from '../../shared.js';
// v2.74.230 — Logger for "Ask Claude" suggestion logging.
import { Logger } from '../../Core/Logger.js';

// ─── Action catalog (v1) ──────────────────────────────────────────────────
//
// Each entry describes the per-action UI: which inputs are required vs
// hidden. The dropdown renders this list; row rendering uses these flags
// to show/hide selector and value fields per action type.

const ACTIONS = [
  // v2.72.65 — NAVIGATE removed from T1. NAVIGATE changes the URL,
  // which changes the grounding context. A Fragment's contract is
  // "deterministic DOM transition within a single grounding"; cross-
  // grounding moves belong at Strategy level (or above). The action
  // type still exists in SchemaValidator for backward compat with
  // existing T3-walked fragments and for Strategy node use.
  { type: 'WAIT',      selector: 'hidden',   value: { kind: 'ms',   label: 'milliseconds',       placeholder: '500' } },
  { type: 'WAIT_FOR',  selector: 'required', value: 'hidden' },
  // v2.74.200 — WAIT_FOR_GONE: polls until selector disappears. The
  // natural pair to WAIT_FOR. Uses an optional timeout value (default
  // 30000ms) so long-running events like AI streaming have headroom.
  // Critical for chat workflows: send → wait for "Stop generating" /
  // "Typing…" indicator to vanish → extract reply. value carries the
  // optional timeout override; placeholder shows the default.
  { type: 'WAIT_FOR_GONE', selector: 'required', value: { kind: 'ms', label: 'timeout milliseconds (optional, default 30000)', placeholder: '30000' } },
  { type: 'CLICK',     selector: 'required', value: 'hidden' },
  // v2.72.91 — CLICK_BY_LABEL: click an option inside a custom dropdown
  // or menu by its visible label. Selector points to the menu CONTAINER
  // (must be open at execute time — pair with a preceding CLICK that
  // opens it). Value is the option label, typically a parameter
  // ({{LABEL}}) so the same fragment serves multiple branching paths.
  { type: 'CLICK_BY_LABEL', selector: 'required', value: { kind: 'param', label: 'option label (e.g. {{COUNTRY}}) — or literal text', placeholder: 'PARAM_NAME or literal' } },
  // v2.72.62 — TYPE/SELECT value is a parameter name (resolves at runtime).
  // Wrapped as {{NAME}} on save; substituted with 'flying turtle' at Verify.
  { type: 'TYPE',      selector: 'required', value: { kind: 'param', label: 'parameter name (e.g. JOB_TITLE) — or literal text', placeholder: 'PARAM_NAME or literal' } },
  { type: 'SELECT',    selector: 'required', value: { kind: 'param', label: 'parameter name or literal option text/value',     placeholder: 'PARAM_NAME or literal' } },
  { type: 'BLUR',      selector: 'optional', value: 'hidden' },
  // v2.72.64 — SCROLL_TO is element-anchored at the Fragment level.
  // Selector points to a DOM element or page anchor (#section-id) to
  // scroll into view. Window-position scrolling (top/bottom/percentage/px)
  // is a Strategy concern, not a Fragment concern.
  // v2.72.72 — Optional smoothScroll toggle. Per-action checkbox. When
  // checked, content script scrolls with behavior:'smooth'; default is
  // behavior:'auto' (instant).
  { type: 'SCROLL_TO', selector: 'required', value: 'hidden', smoothToggle: true },
  // v2.74.49 — Simulate the Enter key. The content-script handler
  // dispatches keydown / keypress / keyup with key='Enter', and as a
  // fallback calls .form.requestSubmit() when the target is inside a
  // form and the keydown was not preventDefault'd — mirrors the
  // browser's implicit-submit behavior for single-line inputs.
  // v2.74.186 — Selector hidden from the authoring UI. The runtime
  // still accepts an optional selector (handleEnter targets that
  // element if non-empty, else document.activeElement / document.body),
  // and the schema validator still permits empty selector for ENTER,
  // but the field was confusing in practice — ENTER conceptually
  // operates on whatever has focus, not a picked element. Hiding the
  // field also drops the Pick / Verify selector inputs. Existing
  // ENTER actions with a saved selector keep working at runtime; on
  // type-switch to ENTER the editor clears any leftover selector so
  // a stale value can't silently route the keypress to a different
  // element than the visible focus.
  { type: 'ENTER',     selector: 'hidden',   value: 'hidden' },
  // v2.74.308 — ACTION_SPEC § 3: KEY sends a named keyboard key.
  // v2.74.315 — Selector field REMOVED. KEY now operates on the focused
  // element (document.activeElement), matching ENTER's UX (selector
  // 'hidden'). Keys are almost always sent to the just-focused element
  // (Escape to close a popover, ArrowDown through an open listbox, Tab
  // to advance) — requiring a landmark target added friction with no
  // real benefit. The content-script handleKey still accepts an optional
  // selector for forward-compat, but the authoring UI doesn't expose it.
  // DEVIATION from ACTION_SPEC § 3 (which lists KEY as landmark-targeting)
  // — documented in SPEC_DEV. The value carries the key name; a custom
  // KEY value row (dropdown + optional {{PARAM}}) replaces the generic
  // text input.
  { type: 'KEY',       selector: 'hidden',   value: { kind: 'param', label: 'key name', placeholder: 'Enter / Escape / ArrowDown' } },
];
const ACTION_BY_TYPE = Object.fromEntries(ACTIONS.map(a => [a.type, a]));

// v2.72.64 — Hard cap on Fragment length. A Fragment is a single named
// page-state transition; runs of 8+ actions almost always indicate two
// or more transitions that should be split into separate Fragments. The
// cap is a forcing function for proper decomposition.
// v2.74.12 — Fragment length cap is now configurable via Settings.
// Stored as a number in chrome.storage; 0 means unlimited.
// SOFT_CAP_THRESHOLD is the recommended ceiling — when over this, the
// UI shows a stability/composability warning regardless of the cap setting.
//
// At mode mount, _loadFragmentCap() reads the user's setting. Default
// remains 7 (matches pre-v2.74.12 behavior).
const SOFT_CAP_THRESHOLD = 7;
let _fragmentCap = 7;       // mutable; read from settings on mount
let _fragmentCapUnlimited = false;

/**
 * v2.74.12 — Load the fragment-cap setting from background storage.
 * Two settings:
 *   fragment_cap          — numeric, default 7
 *   fragment_cap_unlimited — boolean, default false
 *
 * When unlimited is true, _fragmentCap is unused but still read so the
 * "soft warning" threshold message can reference the user's last
 * configured numeric cap as a guideline.
 */
async function _loadFragmentCapSetting() {
  try {
    const capRes = await new Promise(r =>
      chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'fragment_cap', defaultValue: 7 } }, r)
    );
    const unlimRes = await new Promise(r =>
      chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'fragment_cap_unlimited', defaultValue: false } }, r)
    );
    const capVal = Number(capRes?.value);
    _fragmentCap = (Number.isFinite(capVal) && capVal > 0) ? capVal : 7;
    _fragmentCapUnlimited = unlimRes?.value === true;
  } catch (_) {
    _fragmentCap = 7;
    _fragmentCapUnlimited = false;
  }
}

// ─── Module-local state ───────────────────────────────────────────────────

let _payload = null;          // mode payload from background
let _tabId = null;            // walk tab id (set by FRAGMENT_AUTHOR_SETUP_RESULT)
let _actions = [];            // [{id, action, selector, value, verified}]
let _pickerSession = null;    // {sessionId, actionIdx} when picking
// v2.74.313 — Which action rows have their inline effect editor open.
// Keyed by a composite "idx:branchIdx:gateIdx" string so chain branches
// and gate sub-actions get independent open/closed state. Ephemeral
// (not persisted) — collapses on re-mount.
let _actionEffectEditorOpen = new Set();
let _mountEl = null;
let _onKeyDown = null;
// v2.72.62 — Setup phase tracking. Starts false when antecedent or
// tab-open setup is in flight; becomes true on FRAGMENT_AUTHOR_SETUP_RESULT.
// While false: Add action / Save disabled.
let _setupReady = true;
// v2.72.66 — Session chain. Each element is {id, name} of a fragment
// saved in the current authoring session. Used to:
//   (a) render a breadcrumb in the banner
//   (b) chain antecedents — the last entry becomes the antecedent for
//       the NEXT fragment authored after Save.
// Reset on unmount or Done.
let _savedChain = [];

// v2.72.67 — Auto-captured pre/post conditions.
//
// _preconditions populated:
//   - On mount, after antecedent setup completes (or immediately if no
//     antecedent), via EVALUATE_GROUND_PREDICATES.
//   - If antecedent fragment exists, INHERITED from antecedent.postconditions
//     instead of auto-capturing (antecedent is authoritative for start state).
//
// _postconditions populated:
//   - After every successful Verify (page state changed).
//   - At Save (final snapshot before persisting).
//
// Both are arrays of condition objects in the canonical shape:
//   { type: 'perspective_ref', perspectiveId }
//   { type: 'assertion_ref', assertionId }
//   { type: 'url_matches', pattern }
//
// Display metadata (perspective name, etc.) is derived at render time from
// the most recent EVALUATE_GROUND_PREDICATES response stored in
// _conditionDisplay.
let _preconditions = [];
let _postconditions = [];
let _conditionDisplay = {
  // Maps perspective id → {name, urlPattern, landmarkCount}
  perspectives: new Map(),
  // Maps assertion id → {name}
  assertions: new Map(),
};
// Source labels for the precondition/postcondition section headers.
let _preSource = '—';
let _postSource = '—';

// DOM refs scoped to mountEl, populated on mount.
let bannerTitleEl = null;
let bannerSubtitleEl = null;
// v2.74.26 — Bottom action row buttons.
//   doneRevealBtnEl ("Done"): reveals the Name card + collapses all
//   collapsible cards. Does NOT save.
//   cancelBtnEl ("Cancel"): exits to Studio without saving (the
//   previous-version "Done" behaviour).
let doneRevealBtnEl = null;
let cancelBtnEl = null;
let warningEl = null;
let actionsListEl = null;
let activePerspectivesEl = null;   // v2.74.317 — active-Perspective banner
let addActionBtnEl = null;
// v2.74.0 — Sibling button for inserting an action-chain card. Lives next
// to + Add action in the same footer; clicking adds a CLICK_BY_LABEL with
// branches:[] which the renderer treats as the chain shape.
let addActionChainBtnEl = null;
// v2.74.156 — Sibling button for inserting an action-gate card. Adds an
// ACTION_GATE action with `condition` + `negate` + `body[]`. The renderer
// treats any action with action==='ACTION_GATE' as the gate shape.
let addActionGateBtnEl = null;
let actionCountEl = null;
// v2.74.26 — saveBtnEl now references the Save button INSIDE the Name
// card (which appears below Postconditions and is hidden until Done is
// clicked). Same data-fa="save" attribute as the previous bottom
// "Save Fragment" button — _onSaveClick / _updateSaveState wire through
// this ref unchanged.
let saveBtnEl = null;
let nameCardEl = null;
let pickBannerEl = null;
let pickCancelBtnEl = null;
// v2.72.61 — Name + description live in the mode (not the Studio form).
let nameInputEl = null;
// v2.74.22 — Antecedent + Run sub-card. Populated from the Ground's
// fragments on mount; selection updates _payload.antecedentFragmentId so
// _capturePreconditions inherits from the new antecedent and _onSaveClick
// persists the chosen link. Disabled once the actions list is non-empty.
let anteSelectEl = null;
let anteRunBtnEl = null;
let anteStatusEl = null;
let anteCardEl = null;
// v2.74.23 — Param input row + order-label row. Visible when the chosen
// antecedent declares params; hidden otherwise. _anteFragments caches the
// {id, name, params} entries returned by LIST_FRAGMENTS_FOR_GROUND so a
// dropdown change can resolve params without a follow-up fetch.
let anteParamsInputEl = null;
let anteParamsWrapEl = null;
let anteParamsOrderEl = null;
let _anteFragments = [];
// v2.74.23 — Run / undo button state machine.
//   'run'  — clicking executes the chosen antecedent (with the params
//             input as bindings) and, on success, flips to 'undo'.
//   'undo' — clicking navigates the tab to the ground's default URL,
//             waits for load, and flips back to 'run'.
// The button label and title update with the mode. Selecting a different
// antecedent or starting authoring (actions list non-empty) resets to 'run'.
let _anteRunMode = 'run';
// v2.74.23 — Collapsible card. Chevron sits in its own left column;
// when collapsed the body (dropdown + params + run + order + status)
// hides via the .fa-antecedent-card-collapsed parent class. The
// collapsed-name span on the header row shows the picked fragment's
// name (lowercased) when collapsed; "none" when no selection.
let anteToggleBtnEl = null;
let anteToggleGlyphEl = null;
let anteBodyEl = null;
let anteCollapsedNameEl = null;
let _anteCardCollapsed = false;
// Auto-collapse-on-first-action flag. Tracks the previous _actions
// length so we can detect the 0 → >0 transition exactly once. After
// the first action is added we collapse the card; subsequent adds
// don't re-collapse (the user may have manually expanded).
let _anteLastActionCount = 0;
// v2.74.23 — Same collapsible pattern applied to the pre/postconditions
// cards. Each card has its own toggle button, chevron glyph, and
// collapsed-state flag; the card's wrapping <section> gets the
// .fa-conditions-card-collapsed class to hide just the list while
// keeping the head (label + source) visible.
let preCardEl = null;
let preToggleBtnEl = null;
let preToggleGlyphEl = null;
let _preCardCollapsed = false;
let postCardEl = null;
let postToggleBtnEl = null;
let postToggleGlyphEl = null;
let _postCardCollapsed = false;
// v2.74.25 — Actions card collapse. Same chevron pattern as pre/post and
// the antecedent card; the chevron lives inline in the head row (before
// the "Actions" label) so the card visual stays compact, and toggling
// hides the list + footer while leaving the head visible.
let actionsCardEl = null;
let actionsToggleBtnEl = null;
let actionsToggleGlyphEl = null;
let _actionsCardCollapsed = false;
// v2.72.90 — Description input removed from authoring mode. Auto-composed
// at save from labeled actions; user edits later in Studio Edit Fragment
// flow. The field still exists on the saved Fragment record; this mode
// just doesn't author it.
// v2.72.66 — Breadcrumb container for the saved-chain display.
let breadcrumbEl = null;
// v2.72.67 — Pre/Postcondition display containers.
let preListEl = null;
let preSourceEl = null;
let postListEl = null;
let postSourceEl = null;
// v2.74.24 — + Add buttons for pre/post conditions. Same pattern as the
// Edit Fragment review panel: clicking adds a fresh {selector_present, ''}
// row, which the inline editor then lets the author shape (type dropdown
// + per-type value input + ✕ delete). Once the author touches either
// side, that side switches to user-managed and auto-capture stops
// overwriting it — otherwise re-capturing after antecedent Run / Verify
// would clobber manual edits.
let preAddBtnEl = null;
let postAddBtnEl = null;
let _preUserModified = false;
let _postUserModified = false;
// Ground catalog cached at mount for the condition-type dropdown's
// Custom (assertions) and Perspectives optgroups. Same source-of-truth as
// the Studio review panel — fetched via GET_GROUND.
let _groundPerspectives = [];
let _groundAssertions = [];
// v2.74.317 — Active-Perspective set for the authoring tab (PERSPECTIVE_SPEC § 8/§ 9).
// Populated by _refreshActivePerspectives() via EVALUATE_GROUND_PREDICATES —
// the set of Perspectives whose predicates currently match the live page. Used
// to partition the landmark dropdown into "on this page" (active) vs
// "other perspectives" (inactive), so the author sees the landmarks that
// actually live on the page in front of them first. `null` = not yet
// evaluated (treat all as available until we know).
let _activePerspectiveIds = null;            // Set<perspectiveId> | null
let _activePerspectiveNames = [];            // [name, …] for the banner

// v2.74.236 — Action type → required landmark operation, used to filter
// the landmark dropdown so authors see only landmarks the action can
// actually use. WAIT / WAIT_FOR_GONE etc. that don't need a selector
// don't show the dropdown at all.
const ACTION_TO_LANDMARK_OP = Object.freeze({
  CLICK         : 'CLICK',
  CLICK_BY_LABEL: 'CLICK_BY_LABEL',
  TYPE          : 'TYPE',
  SELECT        : 'SELECT',
  WAIT_FOR      : 'WAIT_FOR',
  WAIT_FOR_GONE : 'WAIT_FOR_GONE',
  SCROLL_TO     : 'SCROLL_TO',
  BLUR          : 'BLUR',
  // v2.74.315 — KEY removed: it no longer targets a landmark (operates on
  // the focused element, selector field removed). No landmark dropdown.
});

/**
 * Flatten _groundPerspectives into landmark entries enriched with
 * perspectiveId/Name. Filters out landmarks with `mismatch` score (broken)
 * unless the action already references one — in which case the
 * dropdown surfaces it so the author can see + clear it.
 */
function _flatLandmarksForGround() {
  const out = [];
  for (const perspective of _groundPerspectives) {
    // v2.74.335 — PERSPECTIVE_SPEC § 12: don't offer landmarks from a deprecated
    // (retired) Perspective for new fragment links.
    if (perspective?.lifecycle === 'deprecated') continue;
    const lms = Array.isArray(perspective?.landmarks) ? perspective.landmarks : [];
    for (const lm of lms) {
      if (!lm || typeof lm.alias !== 'string' || !lm.selector) continue;
      const score = lm.verified?.score ?? null;
      out.push({
        perspectiveId         : perspective.id,
        perspectiveName       : perspective.name ?? perspective.id,
        // v2.74.275 — Storage field renamed: role → alias.
        alias            : lm.alias,
        uid              : lm.uid,
        selector         : lm.selector,
        frameUrl         : lm.frameUrl ?? null,
        description      : lm.description ?? '',
        operationsAllowed: lm.verified?.operationsAllowed ?? [],
        score,
        // v2.74.317 — PERSPECTIVE_SPEC § 8: is this landmark's Perspective active
        // on the authoring page right now? `null` active-set = not yet
        // evaluated → treat as active (don't hide anything before we know).
        isActive         : _activePerspectiveIds === null || _activePerspectiveIds.has(perspective.id),
      });
    }
  }
  return out;
}

/**
 * v2.74.317 — Evaluate the Ground's Perspectives against the authoring tab and
 * cache the active set (PERSPECTIVE_SPEC § 9 predicate evaluation → active-set).
 * Reuses EVALUATE_GROUND_PREDICATES (already used for precondition
 * capture); its matchingPerspectives[] IS the active set. Re-renders the
 * actions list so dropdowns + the perspective banner reflect the result.
 */
async function _refreshActivePerspectives() {
  if (!_payload?.groundId || _tabId == null) return;
  let res;
  try {
    res = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'EVALUATE_GROUND_PREDICATES',
        payload: { tabId: _tabId, groundId: _payload.groundId },
      }, resolve);
    });
  } catch {
    return;   // leave _activePerspectiveIds as-is (null = all available)
  }
  if (!res?.success || !Array.isArray(res.matchingPerspectives)) return;
  _activePerspectiveIds   = new Set(res.matchingPerspectives.map(l => l.id));
  _activePerspectiveNames = res.matchingPerspectives.map(l => l.name ?? l.id);
  _renderActivePerspectiveBanner();
  _renderActions();
}

/**
 * v2.74.318 — PERSPECTIVE_SPEC § 2/§ 18: derive which Perspective(s) this fragment
 * is authored against, from the landmarks its actions reference. A
 * fragment's perspective is the set of Perspectives owning its referenced
 * landmark UIDs. Walks top-level actions + chain branches + gate sub-
 * actions. Returns an array of perspective IDs (usually one; more when the
 * fragment spans perspectives).
 */
function _fragmentPerspectiveIds() {
  const uids = new Set();
  const collect = (act) => { if (act?.landmarkRef?.uid) uids.add(act.landmarkRef.uid); };
  for (const a of _actions) {
    collect(a);
    if (Array.isArray(a.branches)) for (const b of a.branches) collect(b);
    if (Array.isArray(a.body))     for (const sub of a.body) collect(sub);
  }
  if (uids.size === 0) return [];
  const perspectiveIds = new Set();
  for (const loc of _groundPerspectives) {
    const lms = Array.isArray(loc?.landmarks) ? loc.landmarks : [];
    if (lms.some(lm => lm?.uid && uids.has(lm.uid))) perspectiveIds.add(loc.id);
  }
  return [...perspectiveIds];
}

/**
 * v2.74.317 — Render the active-perspective banner (PERSPECTIVE_SPEC § 8).
 * Hidden until the active set has been evaluated. Three states:
 *   - ≥1 active Perspective → "📍 On this page: <names>" + refresh
 *   - 0 active Perspectives → warning that no Perspective matches (landmarks here
 *     may not resolve) + refresh
 *   - not-yet-evaluated → stays hidden
 */
function _renderActivePerspectiveBanner() {
  if (!activePerspectivesEl) return;
  if (_activePerspectiveIds === null) {
    activePerspectivesEl.classList.add('hidden');
    activePerspectivesEl.innerHTML = '';
    return;
  }
  activePerspectivesEl.classList.remove('hidden');
  const refreshBtn = `<button class="fa-perspectives-refresh" data-fa-action="refresh-perspectives" type="button" title="Re-evaluate which Perspectives match the current page (after navigating or changing page state)">↻</button>`;

  // Active perspectives line (or no-match warning).
  let activeLine;
  let emptyClass = false;
  if (_activePerspectiveNames.length > 0) {
    const names = _activePerspectiveNames.map(n => `<span class="fa-perspective-chip">${escHtml(n)}</span>`).join('');
    activeLine = `<span class="fa-perspectives-label" title="Perspectives whose predicates match the current page. Their landmarks appear under '📍 On this page' in the landmark dropdowns.">📍 On this page:</span>${names}`;
  } else {
    emptyClass = true;
    activeLine = `<span class="fa-perspectives-label fa-perspectives-label-warn" title="No Perspective's predicates match the current page. Landmarks you pick here may not resolve at runtime unless their Perspective becomes active.">⚠ No perspective matches this page</span>`;
  }

  // v2.74.318 — Authored-against line (PERSPECTIVE_SPEC § 2/§ 18). The
  // perspective(s) this fragment's linked landmarks belong to. Flags a
  // mismatch when an authored-against Perspective isn't active on the current
  // page (you can't verify those actions here — wrong page state).
  const authoredIds = _fragmentPerspectiveIds();
  let authoredHtml = '';
  if (authoredIds.length > 0) {
    const nameFor = (id) => _groundPerspectives.find(l => l.id === id)?.name ?? id;
    const chips = authoredIds.map(id => {
      const active = _activePerspectiveIds.has(id);
      return `<span class="fa-perspective-chip ${active ? '' : 'fa-perspective-chip-inactive'}" title="${active ? 'Authored against this perspective — active on the current page.' : 'Authored against this perspective — NOT active on the current page. Verify may fail here; navigate to a matching page.'}">${escHtml(nameFor(id))}${active ? '' : ' ⚠'}</span>`;
    }).join('');
    authoredHtml = `<span class="fa-perspectives-sep">·</span><span class="fa-perspectives-label" title="The perspective(s) this fragment is authored against — derived from the Perspectives that own its linked landmarks (PERSPECTIVE_SPEC § 2).">authored against:</span>${chips}`;
  }

  activePerspectivesEl.classList.toggle('fa-active-perspectives-empty', emptyClass);
  activePerspectivesEl.innerHTML = `${activeLine}${authoredHtml}${refreshBtn}`;

  // Wire the refresh button (re-evaluate on demand).
  const btn = activePerspectivesEl.querySelector('[data-fa-action="refresh-perspectives"]');
  if (btn) btn.addEventListener('click', () => _refreshActivePerspectives());
}

// ─── Tiny escape helpers ─────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const escAttr = escHtml;

function uid() {
  return `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * v2.72.62 — Substitute any {{PARAM_NAME}} token in a string with
 * 'flying turtle' (the placeholder for unbound parameters at Verify
 * time). Used by _verifyAction so parameterized actions can be exercised
 * without binding actual values. The saved rawJson preserves the tokens
 * so runtime substitution works with real bindings.
 *
 * Token shape matches InjectionService: [A-Z0-9_]+ wrapped in {{...}}.
 */
function _substituteParams(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{[A-Z0-9_]+\}\}/g, 'flying turtle');
}

/**
 * v2.74.307 — Phase 3 of ACTION_SPEC compliance. Compute a Fragment's
 * aggregatedEffects from its serialized rawList (ACTION_SPEC § 10).
 *
 * Dedup rules (§ 10):
 *   - opens-new-thread dedupes by `form`
 *   - triggers-modal dedupes by `modalKind`
 *   - triggers-navigation, triggers-download dedupe globally
 *   - `none` is never aggregated (absence in the list === no constituent
 *     action has that effect kind)
 *
 * Walks top-level steps, gate body sub-actions, and chain branches —
 * every place an Action effect can live. Branches/body sub-actions
 * inherit effect from their own `.effect` field (Phase 2 seeds these
 * the same way as top-level actions when a landmark is linked).
 *
 * @param {Array} rawList serialized action steps (from _onSaveClick)
 * @returns {Array} deduped Effect[] objects
 */
/**
 * v2.74.313 — Copy a source object's effect + interactionPattern onto a
 * serialization target, omitting defaults (kind 'none' / pattern 'none')
 * to keep rawJson clean. Shared by top-level steps, chain branches, and
 * gate sub-actions so all three persist effects identically.
 */
function _serializeEffectFields(src, dst) {
  if (src?.effect && src.effect.kind && src.effect.kind !== 'none') {
    dst.effect = { kind: src.effect.kind };
    if (src.effect.kind === 'opens-new-thread' && src.effect.form) dst.effect.form = src.effect.form;
    if (src.effect.kind === 'triggers-modal' && src.effect.modalKind) dst.effect.modalKind = src.effect.modalKind;
  }
  if (src?.interactionPattern && src.interactionPattern !== 'none') {
    dst.interactionPattern = src.interactionPattern;
  }
}

/**
 * v2.74.313 — Inverse of _serializeEffectFields: hydrate effect +
 * interactionPattern from a saved record onto an in-memory row. Absent
 * fields hydrate to defaults ({kind:'none'} / 'none').
 */
function _hydrateEffectFields(src, dst) {
  if (src?.effect && typeof src.effect === 'object' && typeof src.effect.kind === 'string') {
    dst.effect = { kind: src.effect.kind };
    if (src.effect.kind === 'opens-new-thread' && src.effect.form) dst.effect.form = src.effect.form;
    if (src.effect.kind === 'triggers-modal' && src.effect.modalKind) dst.effect.modalKind = src.effect.modalKind;
  } else {
    dst.effect = { kind: 'none' };
  }
  dst.interactionPattern = (typeof src?.interactionPattern === 'string') ? src.interactionPattern : 'none';
}

function _aggregateActionEffects(rawList) {
  const byKey = new Map();   // dedup key → Effect object
  const collect = (eff) => {
    if (!eff || typeof eff !== 'object') return;
    const kind = eff.kind;
    if (!kind || kind === 'none') return;
    let key;
    if (kind === 'opens-new-thread') key = `opens-new-thread:${eff.form ?? 'tab'}`;
    else if (kind === 'triggers-modal') key = `triggers-modal:${eff.modalKind ?? 'confirm'}`;
    else key = kind;   // triggers-navigation / triggers-download dedupe globally
    if (!byKey.has(key)) {
      // Store a clean copy with only the spec-relevant fields.
      const out = { kind };
      if (kind === 'opens-new-thread') out.form = eff.form ?? 'tab';
      if (kind === 'triggers-modal')   out.modalKind = eff.modalKind ?? 'confirm';
      byKey.set(key, out);
    }
  };
  for (const step of (Array.isArray(rawList) ? rawList : [])) {
    if (!step || typeof step !== 'object') continue;
    collect(step.effect);
    if (Array.isArray(step.branches)) {
      for (const b of step.branches) collect(b?.effect);
    }
    if (Array.isArray(step.body)) {
      for (const sub of step.body) collect(sub?.effect);
    }
  }
  return [...byKey.values()];
}

/**
 * v2.72.88 — Auto-compose a Fragment description from its labeled action
 * sequence. Walks the actions, emits a phrase per user-meaningful action
 * (CLICK, TYPE, SELECT, SCROLL_TO if labeled), skips infrastructure
 * (WAIT, WAIT_FOR, BLUR), joins with commas + "then" before the last.
 *
 * Phrase templates:
 *   CLICK with label    → click "L"
 *   CLICK without label → click {selector tail}
 *   TYPE with label, value param   → fill "L" with {{P}}
 *   TYPE with label, value literal → fill "L" with "V" (truncated)
 *   TYPE without label  → type {{P}} into {selector tail}
 *   SELECT with label, value param   → select {{P}} from "L"
 *   SELECT with label, value literal → select "V" from "L"
 *   SELECT without label → select {{P}}
 *   SCROLL_TO with label → scroll to "L"
 *
 * Returns a single sentence, period-terminated. Edge cases:
 *   - Zero meaningful actions: "Empty fragment."
 *   - One meaningful action: "Click \"Save\"."
 *   - Two: "Click \"A\", then click \"B\"."
 *   - Three+: "Click \"A\", click \"B\", then click \"C\"."
 *
 * Determinism: pure function of inputs, no LLM, no async. User can
 * always override by typing into the description field before save.
 */
/**
 * v2.74.9 — The description composer was extracted to
 * Services/FragmentDescription.js so the studio side can compute it at
 * render time too (lets users toggle compact vs verbose without re-saving
 * the fragment). The function below is the legacy entry point retained
 * for save-time use; it returns the compact form, which is what gets
 * stored on disk.
 *
 * Determinism: pure function of inputs, no LLM, no async. User can
 * always override by typing into the description field before save.
 */
function _composeDescriptionFromActions(actions) {
  return composeCompactDescription(actions);
}

// ─── HTML template ────────────────────────────────────────────────────────

function renderHTML() {
  return `
    <div class="dbg-perspective fa-author">
      <header class="dbg-perspective-header">
        <div class="dbg-perspective-title-row">
          <span class="dbg-perspective-badge">Fragment author</span>
          <span data-fa="title" class="dbg-perspective-ground-label">Authoring…</span>
        </div>
        <div class="dbg-perspective-meta">
          <span class="dbg-perspective-meta-label">Tab</span>
          <span data-fa="subtitle" class="dbg-perspective-meta-value mono">—</span>
        </div>
        <div data-fa="warning" class="dbg-perspective-warning hidden"></div>
      </header>

      <!-- v2.74.22 — Antecedent + Run card. Sub-card under the Fragment
           author header. Pick a fragment whose post-state is the right
           starting page state for this new fragment, then click Run to
           execute it on the current tab. Disabled once any action has
           been added to the actions list — changing the antecedent
           retroactively would invalidate already-authored work.

           v2.74.23 — When the picked antecedent declares params, a
           free-text input renders between the dropdown and Run for
           comma-separated values; a label row beneath shows the param
           order. Run navigates the tab to the antecedent's url_matches
           precondition first so re-clicking always starts from a
           known-good state. -->
      <section data-fa="antecedent-card" class="dbg-perspective-meta-card fa-antecedent-card">
        <button class="fa-antecedent-collapse-toggle" data-fa="antecedent-toggle" type="button"
                title="Collapse / expand antecedent card"
                aria-label="Collapse antecedent card" aria-expanded="true">
          <span class="fa-antecedent-collapse-chevron" data-fa="antecedent-toggle-glyph" aria-hidden="true">▾</span>
        </button>
        <div class="fa-antecedent-content">
          <div class="fa-antecedent-header-row">
            <span class="dbg-perspective-field-label fa-antecedent-header-label">Antecedent fragment</span>
            <span data-fa="antecedent-collapsed-name" class="fa-antecedent-collapsed-name">none</span>
          </div>
          <div data-fa="antecedent-body" class="fa-antecedent-body">
            <div class="fa-antecedent-row">
              <label class="fa-antecedent-label">
                <select data-fa="antecedent-select">
                  <option value="">— none —</option>
                </select>
              </label>
            </div>
            <div class="fa-antecedent-row fa-antecedent-row-2">
              <label class="fa-antecedent-params-input hidden" data-fa="antecedent-params-wrap">
                <span class="dbg-perspective-field-label">Param values</span>
                <input type="text" data-fa="antecedent-params" placeholder="comma-separated values" />
              </label>
              <button data-fa="antecedent-run" class="btn-secondary fa-antecedent-run" type="button" disabled>Run</button>
            </div>
            <div data-fa="antecedent-params-order" class="fa-antecedent-params-order hidden"></div>
            <span data-fa="antecedent-status" class="fa-antecedent-status field-hint"></span>
          </div>
        </div>
      </section>

      <!-- v2.72.66 — Session breadcrumb. Renders the saved-fragment chain
           from this authoring session. Hidden when no fragments saved
           yet. The last entry is implicitly the antecedent of the
           Fragment currently being authored. -->
      <section data-fa="breadcrumb" class="fa-breadcrumb hidden"></section>

      <!-- v2.72.67 — Preconditions display.
           Auto-captured from the page state when the mode mounts (or
           inherited from antecedent). Read-only display. Editing happens
           in Studio's edit-fragment review panel.
           v2.74.12 — Moved above the Name card so the user sees the
           captured page state context FIRST (the conditions that must
           hold for this fragment to apply), then names the fragment.
           v2.74.23 — Collapsible card pattern (mirrors the antecedent
           card): chevron in a left column; the head (label + source)
           and the conditions list both sit in the right column. The
           list collapses when the chevron is toggled; the head stays
           visible so the user can see what section they're in and
           the source summary. -->
      <section data-fa="pre-card" class="dbg-perspective-meta-card fa-conditions-card">
        <button class="fa-conditions-collapse-toggle" data-fa="pre-toggle" type="button"
                title="Collapse / expand preconditions"
                aria-label="Collapse preconditions" aria-expanded="true">
          <span class="fa-conditions-collapse-chevron" data-fa="pre-toggle-glyph" aria-hidden="true">▾</span>
        </button>
        <div class="fa-conditions-content">
          <div class="fa-conditions-head">
            <span class="fa-conditions-label">Preconditions</span>
            <span data-fa="pre-source" class="fa-conditions-source">—</span>
          </div>
          <div data-fa="pre-body" class="fa-conditions-body">
            <div data-fa="pre-list" class="fa-conditions-list">
              <div class="fa-conditions-empty">Capturing on mount…</div>
            </div>
            <div class="fa-conditions-footer">
              <button data-fa="add-pre" class="btn-secondary fa-add-condition-btn" type="button">+ Add</button>
            </div>
          </div>
        </div>
      </section>

      <section class="dbg-perspective-instructions">
        <p class="dbg-perspective-help">
          Add each action in order. Pick a selector, then click <strong>Verify</strong> to execute the action on the page. State advances per action — author against what you see.
        </p>
      </section>

      <section data-fa="actions-card" class="dbg-perspective-landmarks">
        <div class="dbg-perspective-landmarks-head">
          <button class="fa-actions-collapse-toggle" data-fa="actions-toggle" type="button"
                  title="Collapse / expand actions"
                  aria-label="Collapse actions" aria-expanded="true">
            <span class="fa-actions-collapse-chevron" data-fa="actions-toggle-glyph" aria-hidden="true">▾</span>
          </button>
          <span class="dbg-perspective-landmarks-label">Actions</span>
          <span data-fa="action-count" class="fa-action-count">—</span>
        </div>
        <!-- v2.74.317 — Active-perspective banner (PERSPECTIVE_SPEC § 8). Shows
             which Perspectives' predicates match the authoring tab, so the
             author knows what the substrate thinks the page is. Populated
             by _renderActivePerspectiveBanner after _refreshActivePerspectives. -->
        <div data-fa="active-perspectives" class="fa-active-perspectives hidden"></div>
        <div data-fa="actions-list" class="dbg-perspective-landmarks-list">
          <div class="dbg-perspective-landmarks-empty">No actions yet — click + Add action below.</div>
        </div>
        <!-- v2.72.90 — + Action moved below the list. The action list
             grows downward as new actions are added; placing the button
             at the bottom puts it where the user's eye is after each
             addition.
             v2.74.3 — Renamed "+ Add action" to "+ Action" to parallel
             "+ Action branch". Both are sibling capture options. -->
        <div class="fa-actions-footer">
          <button data-fa="add-action" class="btn-secondary fa-add-action-btn" type="button">+ Action</button>
          <button data-fa="add-action-chain" class="btn-secondary fa-add-chain-btn" type="button" title="Add a click-then-pick branch (head + per-label sub-actions)">+ Action branch</button>
          <!-- v2.74.156 — Action gate: a header condition + a body of
               sub-actions. Body runs only when the condition holds (or,
               with negate on, when it doesn't). Mirrors the chain card's
               composition shape but with condition-driven dispatch
               instead of label-keyed dispatch. -->
          <button data-fa="add-action-gate" class="btn-secondary fa-add-gate-btn" type="button" title="Add a conditional block — body runs only when the header condition is met (or, with negate on, when it isn't)">+ Action gate</button>
        </div>
      </section>

      <!-- v2.72.67 — Postconditions: re-captured after every successful
           Verify (page state changed) and at Save. Read-only display.
           Stays below the actions list — captures the state AFTER the
           fragment runs, mirroring its position in the action timeline.
           v2.74.23 — Same collapsible card pattern as the preconditions
           card (chevron + always-visible head + collapsible list). -->
      <section data-fa="post-card" class="dbg-perspective-meta-card fa-conditions-card">
        <button class="fa-conditions-collapse-toggle" data-fa="post-toggle" type="button"
                title="Collapse / expand postconditions"
                aria-label="Collapse postconditions" aria-expanded="true">
          <span class="fa-conditions-collapse-chevron" data-fa="post-toggle-glyph" aria-hidden="true">▾</span>
        </button>
        <div class="fa-conditions-content">
          <div class="fa-conditions-head">
            <span class="fa-conditions-label">Postconditions</span>
            <span data-fa="post-source" class="fa-conditions-source">—</span>
          </div>
          <div data-fa="post-body" class="fa-conditions-body">
            <div data-fa="post-list" class="fa-conditions-list">
              <div class="fa-conditions-empty">Captured on Save.</div>
            </div>
            <div class="fa-conditions-footer">
              <button data-fa="add-post" class="btn-secondary fa-add-condition-btn" type="button">+ Add</button>
            </div>
          </div>
        </div>
      </section>

      <!-- v2.74.26 — Name card relocated beneath Postconditions and
           hidden until the author clicks Done. Author flow:
             1. Build actions / conditions; Done is the final affordance.
             2. Clicking Done reveals this card and collapses every
                collapsible card so the eye lands here.
             3. The author types the fragment name and clicks Save — the
                same persistence path the old "Save Fragment" button ran.
           Save button starts disabled; _updateSaveState enables it once
           the validation rules pass (non-empty name + ≥1 verified action). -->
      <section data-fa="name-card" class="dbg-perspective-meta-card fa-name-card hidden">
        <div class="fa-name-row">
          <input type="text" data-fa="name-input" maxlength="80"
                 placeholder="Fragment name (e.g. Open Easy Apply form)" />
          <button data-fa="save" class="btn-primary fa-name-save-btn" type="button" disabled>Save</button>
        </div>
      </section>

      <!-- v2.74.26 — Bottom action row: "Done" reveals the Name card and
           collapses every collapsible card; "Cancel" exits to Studio
           without saving (same behaviour the old "Done" button had). -->
      <section class="dbg-perspective-actions">
        <button data-fa="reveal-done" class="btn-primary" type="button">Done</button>
        <button data-fa="cancel" class="btn-secondary" type="button">Cancel</button>
      </section>

      <div data-fa="pick-banner" class="dbg-perspective-pick-banner hidden">
        <span class="dbg-perspective-pick-text">Click an element on the page to pick a selector. Press Esc to cancel.</span>
        <button data-fa="pick-cancel" class="btn-secondary tiny" type="button">Cancel pick</button>
      </div>
    </div>
  `;
}

// ─── Mount ────────────────────────────────────────────────────────────────

async function mount(payload, mountEl) {
  _mountEl = mountEl;
  _payload = payload ?? {};
  // v2.74.40 — When restoring from a snapshot, the original payload's
  // tabId is still null (it was null at BEGIN_FRAGMENT_AUTHOR time;
  // only the SETUP_RESULT broadcast resolved it into mode state, never
  // back into the stored payload). Prefer the snapshot's tabId, then
  // fall back to payload.existingTabId (always the authoring tab for
  // Ground-sidepanel-launched authoring), then payload.tabId.
  const _restoredState = (_payload?.state && typeof _payload.state === 'object') ? _payload.state : null;
  _tabId = (_restoredState && typeof _restoredState.tabId === 'number')
    ? _restoredState.tabId
    : (_payload.tabId ?? _payload.existingTabId ?? null);

  // v2.74.36 — Restore from prior snapshot (set by the shell when
  // resuming after a tab switch). Overlay the saved authoring state
  // onto module locals so the rest of mount() sees them as if the user
  // had been here all along. We do this BEFORE the prefilledActions
  // path so a fresh re-walk still gets its prefill.
  if (_restoredState) {
    if (Array.isArray(_restoredState.actions))         _actions         = _restoredState.actions;
    if (Array.isArray(_restoredState.preconditions))   _preconditions   = _restoredState.preconditions;
    if (Array.isArray(_restoredState.postconditions))  _postconditions  = _restoredState.postconditions;
    if (Array.isArray(_restoredState.savedChain))      _savedChain      = _restoredState.savedChain;
    if (typeof _restoredState.preSource === 'string')  _preSource       = _restoredState.preSource;
    if (typeof _restoredState.postSource === 'string') _postSource      = _restoredState.postSource;
    if (typeof _restoredState.preUserModified === 'boolean')  _preUserModified  = _restoredState.preUserModified;
    if (typeof _restoredState.postUserModified === 'boolean') _postUserModified = _restoredState.postUserModified;
    if (typeof _restoredState.anteCardCollapsed === 'boolean')     _anteCardCollapsed     = _restoredState.anteCardCollapsed;
    if (typeof _restoredState.preCardCollapsed === 'boolean')      _preCardCollapsed      = _restoredState.preCardCollapsed;
    if (typeof _restoredState.postCardCollapsed === 'boolean')     _postCardCollapsed     = _restoredState.postCardCollapsed;
    if (typeof _restoredState.actionsCardCollapsed === 'boolean')  _actionsCardCollapsed  = _restoredState.actionsCardCollapsed;
    if (typeof _restoredState.anteLastActionCount === 'number')    _anteLastActionCount   = _restoredState.anteLastActionCount;
    if (typeof _restoredState.anteRunMode === 'string')            _anteRunMode           = _restoredState.anteRunMode;
  }

  // v2.72.82 — Pre-populate action list on re-walk. The Studio
  // FragmentForm sends prefilledActions (parsed rawJson) when
  // re-walking. Each gets a fresh row id, verified=null (page state
  // is fresh, user re-verifies on the live page), and the smoothScroll
  // flag preserved if present.
  // v2.74.57 — When restoring from a snapshot the entire prefill +
  // empty-reset block is skipped — _actions was already populated
  // from _restoredState.actions and the previous else branch was
  // clobbering it back to [] for the no-prefill resume case. Both
  // arms of the prefill conditional now sit inside `if (!_restoredState)`.
  if (!_restoredState) {
    if (Array.isArray(_payload.prefilledActions) && _payload.prefilledActions.length > 0) {
      // v2.74.184 — A saved fragment is implicitly verified (the Save
      // gate refuses to write unless every action has verified.success
      // === true). Hydrating with verified=null forced the author to
      // re-verify every action on every edit, even when they only
      // touched one row — annoying for a small selector tweak. We now
      // hydrate with verified={ success:true, source:'hydrated' } so
      // unchanged rows keep their green check; the source tag tells
      // future UX apart from a live-page-check verification.
      //
      // Mutation handlers (selector edit, value edit, action-type
      // change, Pick) already clear `verified` to null when the row
      // changes, so the contract holds: edit invalidates that row;
      // unchanged rows stay verified.
      const hydratedVerified = { success: true, source: 'hydrated' };
      _actions = _payload.prefilledActions.map(a => {
        const row = {
          id: uid(),
          action: a.action,
          selector: a.selector ?? '',
          value: a.value ?? '',
          smoothScroll: a.smoothScroll === true,
          // v2.74.316 — KEY repeat count (absent → 1).
          ...(a.action === 'KEY' && Number.isFinite(parseInt(a.repeat, 10)) ? { repeat: Math.min(Math.max(1, parseInt(a.repeat, 10)), 50) } : {}),
          // v2.72.87 — Preserve picked label across re-walk so the row head
          // still reads "CLICK \"Upload\"" without re-picking. User can re-pick
          // to refresh if the page changed.
          pickedLabel: typeof a.pickedLabel === 'string' ? a.pickedLabel : '',
          verified: { ...hydratedVerified },
          verifying: false,
        };
        // v2.74.183 — Preserve iframe routing on hydration. The save
        // path (v2.74.163) persists `frameUrl` for iframe-picked
        // actions; the runtime resolver (TemplateWalker._resolveFrameId)
        // reads it to dispatch into the right frame. Without this
        // hydration step, opening a fragment via the pencil and
        // re-saving (even without touching the row) silently dropped
        // the frame binding — the next run then routed the action to
        // the top document and the iframe-scoped selector missed
        // with "no element matched" (exactly the bug the user just
        // reported on the gate body's CLICK).
        if (typeof a.frameUrl === 'string' && a.frameUrl.trim()) {
          row.frameUrl = a.frameUrl;
        }
        // v2.74.236 — Wave 3: hydrate landmarkRef so re-opening a
        // fragment for edit shows the ref chip and keeps the runtime
        // re-resolution behavior. selector + frameUrl come from the
        // saved cache; the runtime resolver still re-fetches the
        // landmark's current values at dispatch time.
        // v2.74.275 — Legacy { perspectiveId, role } ref shape removed.
        // Only { uid } refs supported.
        if (a.landmarkRef && typeof a.landmarkRef === 'object'
            && typeof a.landmarkRef.uid === 'string') {
          row.landmarkRef = { uid: a.landmarkRef.uid };
        }
        // v2.74.306 — Phase 2: hydrate effect + interactionPattern from
        // saved rawJson. Absence === default per § 5, so missing fields
        // hydrate to { kind: 'none' } / 'none'. Round-trips cleanly with
        // the save-path serialization that omits defaults.
        if (a.effect && typeof a.effect === 'object' && typeof a.effect.kind === 'string') {
          row.effect = { kind: a.effect.kind };
          if (a.effect.kind === 'opens-new-thread' && a.effect.form) row.effect.form = a.effect.form;
          if (a.effect.kind === 'triggers-modal' && a.effect.modalKind) row.effect.modalKind = a.effect.modalKind;
        } else {
          row.effect = { kind: 'none' };
        }
        row.interactionPattern = (typeof a.interactionPattern === 'string') ? a.interactionPattern : 'none';
        // v2.74.0 — Preserve chain branches across re-walk. Each branch
        // is hydrated with its own verified=null since the page state is
        // fresh; user re-verifies branch by branch.
        // v2.74.3 — bodyValue (chain-wide layer-2 selection) is also
        // preserved. CLICK_BY_LABEL branches don't carry their own value
        // anymore — they read bodyValue at runtime.
        if (Array.isArray(a.branches)) {
          row.branches = a.branches.map(b => {
            const branch = {
              label: typeof b.label === 'string' ? b.label : '',
              action: b.action,
              selector: b.selector ?? '',
              // Only WAIT branches carry a value; CLICK_BY_LABEL/WAIT_FOR get
              // empty (legacy fragments may have a value here — preserve as-is
              // if present, ignored at runtime for non-WAIT branches).
              value: b.value ?? '',
              pickedLabel: typeof b.pickedLabel === 'string' ? b.pickedLabel : '',
              // v2.74.184 — Implicit verification (see top-level hydration).
              verified: { ...hydratedVerified },
              verifying: false,
            };
            // v2.74.183 — Per-branch iframe routing. Picker writes
            // frameUrl on each branch independently of the chain head.
            if (typeof b.frameUrl === 'string' && b.frameUrl.trim()) {
              branch.frameUrl = b.frameUrl;
            }
            // v2.74.313 — Hydrate per-branch effect / interactionPattern.
            _hydrateEffectFields(b, branch);
            return branch;
          });
          row.bodyValue = typeof a.bodyValue === 'string' ? a.bodyValue : '';
        }
        // v2.74.183 — Preserve ACTION_GATE shape (condition + negate +
        // body[]) across re-walk. Previously the generic hydration
        // above only carried `action: 'ACTION_GATE'` and the gate
        // re-opened with an empty body and a default `selector_present`
        // condition — author saw "no actions yet" inside the gate and
        // a fresh blank header, even though the saved rawJson had the
        // full shape. condition.frameUrl is preserved so gate iframe
        // routing survives the round-trip too.
        if (a.action === 'ACTION_GATE') {
          if (a.condition && typeof a.condition === 'object') {
            row.condition = { ...a.condition };
            // Strip any stale transient fields just in case (shouldn't
            // be in saved rawJson per the save-path delete in
            // _onSaveClick, but defensive).
            delete row.condition._verified;
            delete row.condition._verifying;
            delete row.condition._verifyHelper;
          }
          row.negate = a.negate === true;
          // v2.74.201 — Hydrate the optional waitTimeout so the gate's
          // wait-aware behavior survives an edit round-trip.
          if (Number.isFinite(a.waitTimeout) && a.waitTimeout > 0) {
            row.waitTimeout = a.waitTimeout;
          }
          if (Array.isArray(a.body)) {
            row.body = a.body.map(sub => {
              const bodyRow = {
                id: uid(),
                action: sub.action,
                selector: sub.selector ?? '',
                value: sub.value ?? '',
                pickedLabel: typeof sub.pickedLabel === 'string' ? sub.pickedLabel : '',
                // v2.74.184 — Implicit verification (see top-level hydration).
                verified: { ...hydratedVerified },
                verifying: false,
              };
              if (typeof sub.frameUrl === 'string' && sub.frameUrl.trim()) {
                bodyRow.frameUrl = sub.frameUrl;
              }
              // v2.74.313 — Hydrate per-gate-sub effect / interactionPattern.
              _hydrateEffectFields(sub, bodyRow);
              return bodyRow;
            });
          } else {
            row.body = [];
          }
        }
        return row;
      });
    } else {
      _actions = [];
    }
  }

  // v2.74.12 — Read fragment cap setting before render so the count
  // display reflects the user's configured limit (or unlimited mode).
  await _loadFragmentCapSetting();

  mountEl.innerHTML = renderHTML();

  const q = (key) => mountEl.querySelector(`[data-fa="${key}"]`);
  bannerTitleEl    = q('title');
  bannerSubtitleEl = q('subtitle');
  warningEl        = q('warning');
  actionsListEl    = q('actions-list');
  activePerspectivesEl = q('active-perspectives');   // v2.74.317
  addActionBtnEl   = q('add-action');
  // v2.74.0 — Sibling for action-chain card creation.
  addActionChainBtnEl = q('add-action-chain');
  addActionGateBtnEl  = q('add-action-gate');
  actionCountEl    = q('action-count');
  saveBtnEl        = q('save');           // Save button inside the Name card.
  doneRevealBtnEl  = q('reveal-done');    // Bottom "Done" — reveals Name card.
  cancelBtnEl      = q('cancel');         // Bottom "Cancel" — exits to Studio.
  nameCardEl       = q('name-card');
  pickBannerEl     = q('pick-banner');
  pickCancelBtnEl  = q('pick-cancel');
  // v2.72.61 — Mode-owned name. (v2.72.90 — Description removed; saved
  // Fragments get auto-composed descriptions at save time.)
  nameInputEl        = q('name-input');
  // v2.74.22 — Antecedent + Run sub-card refs.
  anteCardEl        = q('antecedent-card');
  anteSelectEl      = q('antecedent-select');
  anteRunBtnEl      = q('antecedent-run');
  anteStatusEl      = q('antecedent-status');
  // v2.74.23 — Param input + order-label row.
  anteParamsWrapEl  = q('antecedent-params-wrap');
  anteParamsInputEl = q('antecedent-params');
  anteParamsOrderEl = q('antecedent-params-order');
  // v2.74.23 — Collapse toggle refs.
  anteToggleBtnEl   = q('antecedent-toggle');
  anteToggleGlyphEl = q('antecedent-toggle-glyph');
  anteBodyEl        = q('antecedent-body');
  anteCollapsedNameEl = q('antecedent-collapsed-name');
  // v2.72.66 — Breadcrumb container.
  breadcrumbEl     = q('breadcrumb');
  // v2.72.67 — Condition display refs.
  preListEl        = q('pre-list');
  preSourceEl      = q('pre-source');
  postListEl       = q('post-list');
  postSourceEl     = q('post-source');
  // v2.74.23 — Pre/post collapse toggle refs.
  preCardEl         = q('pre-card');
  preToggleBtnEl    = q('pre-toggle');
  preToggleGlyphEl  = q('pre-toggle-glyph');
  postCardEl        = q('post-card');
  postToggleBtnEl   = q('post-toggle');
  postToggleGlyphEl = q('post-toggle-glyph');
  // v2.74.24 — + Add buttons for the editable pre/post lists.
  preAddBtnEl       = q('add-pre');
  postAddBtnEl      = q('add-post');
  // v2.74.25 — Actions card collapse refs.
  actionsCardEl       = q('actions-card');
  actionsToggleBtnEl  = q('actions-toggle');
  actionsToggleGlyphEl = q('actions-toggle-glyph');

  // Fresh session — no saved chain yet. Each successful Save appends
  // an entry; Done clears.
  // v2.74.36 — Skip these resets when restoring from a snapshot; the
  // restore block at the top of mount() already populated them with
  // the values the user had before unmount.
  _conditionDisplay = { perspectives: new Map(), assertions: new Map() };
  if (!_restoredState) {
    _savedChain = [];
    // v2.74.185 — Hydrate pre/post from the saved fragment when the
    // pencil-edit flow supplies them. Without this, the editor showed
    // empty pre/post lists even when storage had conditions, and the
    // subsequent _capturePreconditions/Postconditions auto-overwrite
    // could silently replace what was saved (e.g. ditching a manually-
    // authored url_matches in favor of the live page URL). Mark both
    // user-modified so the auto-capture short-circuits don't clobber
    // the loaded list during this edit session.
    const hydratedPre = Array.isArray(_payload?.prefilledPreconditions)
      ? _payload.prefilledPreconditions : null;
    const hydratedPost = Array.isArray(_payload?.prefilledPostconditions)
      ? _payload.prefilledPostconditions : null;
    if (hydratedPre && hydratedPre.length > 0) {
      _preconditions = hydratedPre.map(c => ({ ...c }));
      _preSource = 'loaded from saved fragment';
      _preUserModified = true;
    } else {
      _preconditions = [];
      _preSource = '—';
    }
    if (hydratedPost && hydratedPost.length > 0) {
      _postconditions = hydratedPost.map(c => ({ ...c }));
      _postSource = 'loaded from saved fragment';
      _postUserModified = true;
    } else {
      _postconditions = [];
      _postSource = '—';
    }
  }

  if (!_payload.fragmentId) {
    bannerTitleEl.textContent = 'No active authoring session';
    bannerSubtitleEl.textContent = 'This mode was opened without a fragment context.';
    return;
  }

  // Pre-fill name if the payload carries it (re-walk case from Studio's
  // form). Empty for new T1 fragments. v2.72.90 — Description prefill
  // dropped; mode no longer authors descriptions.
  // v2.74.182 — Re-walks (Sidepanel pencil-icon flow at ground-view.js
  // line 1056) send `name: ''` and stash the saved fragment's name on
  // `rewalkName`, expecting this mode to fall back to it. The mode was
  // ignoring `rewalkName` entirely — so editing a saved fragment showed
  // an empty name input and a "Authoring a new Fragment" banner, making
  // it look like a brand-new fragment even though the existing
  // fragmentId AND prefilledActions were loaded correctly. Save still
  // overwrote the right record, but the UI was a lie. The fall-back
  // resolves to rewalkName when name is empty/whitespace; new-fragment
  // flow (rewalkName absent) is unaffected.
  const effectiveName = (_payload.name && _payload.name.trim())
    ? _payload.name
    : (_payload.rewalkName ?? '');
  if (nameInputEl) nameInputEl.value = effectiveName;

  bannerTitleEl.textContent = effectiveName.trim()
    ? `Authoring: "${effectiveName}"`
    : 'Authoring a new Fragment';
  bannerSubtitleEl.textContent = _payload.groundUrl ?? '';

  // Wire static handlers.
  addActionBtnEl.addEventListener('click', _onAddActionClick);
  addActionChainBtnEl?.addEventListener('click', _onAddActionChainClick);
  addActionGateBtnEl?.addEventListener('click', _onAddActionGateClick);
  // v2.74.26 — Three-button save flow:
  //   Save (in Name card) → persists the fragment via _onSaveClick.
  //   Done (bottom row)   → reveals the Name card + collapses everything
  //                         else, so the eye lands on the name field.
  //   Cancel (bottom row) → exits to Studio without saving (the old
  //                         "Done" button's behaviour).
  saveBtnEl.addEventListener('click', _onSaveClick);
  doneRevealBtnEl?.addEventListener('click', _onRevealNameClick);
  cancelBtnEl?.addEventListener('click', _onDoneClick);
  pickCancelBtnEl.addEventListener('click', () => _cancelPick(true));
  // v2.74.22 — Antecedent + Run handlers. Dropdown change updates
  // payload (so save/preconditions pick up the new antecedent); Run
  // executes the selected fragment on the active tab.
  anteSelectEl?.addEventListener('change', _onAntecedentChange);
  anteRunBtnEl?.addEventListener('click', _onAntecedentRunClick);
  // v2.74.23 — Param input listener. Clear status on edit so a stale
  // "Ran N actions" message doesn't linger after the user changes
  // values for the next run.
  anteParamsInputEl?.addEventListener('input', () => {
    if (anteStatusEl) anteStatusEl.textContent = '';
  });
  // v2.74.23 — Collapse toggles. All three cards mount expanded.
  anteToggleBtnEl?.addEventListener('click', _toggleAntecedentCard);
  preToggleBtnEl?.addEventListener('click', _togglePreCard);
  postToggleBtnEl?.addEventListener('click', _togglePostCard);
  // v2.74.25 — Actions card collapse toggle. Mounts expanded.
  actionsToggleBtnEl?.addEventListener('click', _toggleActionsCard);
  // v2.74.24 — + Add condition handlers. Each click appends a fresh
  // selector_present row and re-renders; the row's type dropdown lets
  // the author switch to any other supported condition type inline.
  preAddBtnEl?.addEventListener('click', () => _onAddCondition('pre'));
  postAddBtnEl?.addEventListener('click', () => _onAddCondition('post'));
  // Populate the dropdown from the Ground's fragments. Fire-and-forget
  // — failure means the dropdown stays empty (only "— none —"); the
  // user can still author actions, just without an antecedent picked.
  _populateAntecedentDropdown();
  _updateAntecedentCardEnabled();
  _renderAntecedentToggle();
  _renderConditionsToggle('pre');
  _renderConditionsToggle('post');
  _renderActionsToggle();
  // v2.74.24 — Fetch the Ground's perspectives + assertions so the condition-
  // type dropdown can offer the Custom / Perspectives optgroups (matching the
  // Studio Edit-Fragment review panel's behaviour). Fire-and-forget — if
  // it fails the dropdown simply shows page-family types only.
  _loadGroundCatalog();
  // v2.72.61 — Live-update banner title and re-validate save when
  // name/description change.
  nameInputEl?.addEventListener('input', () => {
    const v = nameInputEl.value.trim();
    bannerTitleEl.textContent = v ? `Authoring: "${v}"` : 'Authoring a new Fragment';
    _updateSaveState();
  });
  // v2.72.90 — Description input listener removed with the input itself.

  _onKeyDown = (e) => {
    if (e.key === 'Escape' && _pickerSession) {
      e.preventDefault();
      _cancelPick(true);
    }
  };
  document.addEventListener('keydown', _onKeyDown);

  // v2.72.62 — Setup phase banner. While background is opening the tab
  // and replaying any antecedent chain, show a progress message in the
  // subtitle. When FRAGMENT_AUTHOR_SETUP_RESULT arrives, banner returns
  // to the URL.
  //
  // v2.72.63 — Don't gate Add action / Save on setup. The mode UI is
  // editable immediately. Pick and Verify check _tabId themselves and
  // show a warning if the tab isn't ready yet — better than a button
  // that silently does nothing.
  // v2.74.40 — Skip the "Setting up…" banner when resuming from a
  // snapshot. The original payload still carries setupPhase from
  // BEGIN_FRAGMENT_AUTHOR time; on a resume the setup already
  // completed long ago, so the message would be misleading.
  const setupPhase = _restoredState ? null : (_payload.setupPhase ?? null);
  if (setupPhase === 'antecedent') {
    bannerSubtitleEl.textContent = 'Setting up: replaying antecedent chain…';
  } else if (setupPhase === 'opening') {
    bannerSubtitleEl.textContent = 'Setting up: opening tab…';
  }
  _setupReady = true;       // never blocks the UI; informational only

  _renderActions();
  _updateSaveState();
  // v2.74.36 — When restoring from a snapshot, paint the pre/post
  // lists immediately. For a fresh session these get populated by
  // _capturePreconditions / _capturePostconditions which fire after
  // setup completes; for restore there's no setup, so we draw them
  // directly from the restored arrays.
  if (_restoredState) {
    _renderPreconditions();
    _renderPostconditions();
  }
}

// ─── Unmount ──────────────────────────────────────────────────────────────

async function unmount() {
  if (_pickerSession) {
    try { await _cancelPick(true); } catch {}
  }
  if (_onKeyDown) {
    try { document.removeEventListener('keydown', _onKeyDown); } catch {}
    _onKeyDown = null;
  }

  _payload = null;
  _tabId = null;
  _actions = [];
  _pickerSession = null;
  _setupReady = true;
  _savedChain = [];
  _preconditions = [];
  _postconditions = [];
  _conditionDisplay = { perspectives: new Map(), assertions: new Map() };
  _preSource = '—';
  _postSource = '—';

  bannerTitleEl = bannerSubtitleEl = warningEl = null;
  actionsListEl = activePerspectivesEl = addActionBtnEl = addActionChainBtnEl = addActionGateBtnEl = actionCountEl = null;
  saveBtnEl = doneRevealBtnEl = cancelBtnEl = nameCardEl = null;
  pickBannerEl = pickCancelBtnEl = null;
  nameInputEl = null;
  // v2.74.22 — Antecedent + Run sub-card refs.
  anteCardEl = anteSelectEl = anteRunBtnEl = anteStatusEl = null;
  anteParamsInputEl = anteParamsWrapEl = anteParamsOrderEl = null;
  anteToggleBtnEl = anteToggleGlyphEl = anteBodyEl = null;
  anteCollapsedNameEl = null;
  preCardEl = preToggleBtnEl = preToggleGlyphEl = null;
  postCardEl = postToggleBtnEl = postToggleGlyphEl = null;
  preAddBtnEl = postAddBtnEl = null;
  actionsCardEl = actionsToggleBtnEl = actionsToggleGlyphEl = null;
  _actionsCardCollapsed = false;
  _anteFragments = [];
  _anteRunMode = 'run';
  _anteCardCollapsed = false;
  _anteLastActionCount = 0;
  _preCardCollapsed = false;
  _postCardCollapsed = false;
  _preUserModified = false;
  _postUserModified = false;
  _groundPerspectives = [];
  _groundAssertions = [];
  _activePerspectiveIds = null;
  _activePerspectiveNames = [];
  breadcrumbEl = null;
  preListEl = preSourceEl = postListEl = postSourceEl = null;

  if (_mountEl) {
    _mountEl.innerHTML = '';
    _mountEl = null;
  }
}

// ─── Event forwarding (forwarded chrome.runtime messages) ────────────────

function handleEvent(message) {
  if (!message?.type) return;

  // v2.72.62 — Setup result from background. Either unlocks authoring
  // (success → _setupReady = true) or surfaces an error.
  if (message.type === 'FRAGMENT_AUTHOR_SETUP_RESULT') {
    if (!_payload) return;
    if (message.payload?.fragmentId !== _payload.fragmentId) return;
    if (message.payload.success) {
      _tabId = message.payload.tabId;
      _setupReady = true;
      if (addActionBtnEl) addActionBtnEl.disabled = false;
      if (bannerSubtitleEl) bannerSubtitleEl.textContent = _payload.groundUrl ?? '';
      _hideWarning();
      // v2.72.67 — Capture preconditions now that the tab is ready.
      // Inherits from antecedent if present; otherwise auto-captures
      // from the page state.
      _capturePreconditions();
      // v2.74.317 — Evaluate which Perspectives are active on the authoring
      // tab so the landmark dropdown can foreground "on this page"
      // landmarks. Fire-and-forget; re-renders when it resolves.
      _refreshActivePerspectives();
    } else {
      _setupReady = false;
      if (addActionBtnEl) addActionBtnEl.disabled = true;
      _showWarning(`Setup failed: ${message.payload.error ?? 'unknown'}`);
      if (bannerSubtitleEl) bannerSubtitleEl.textContent = 'Setup failed.';
    }
    _updateSaveState();
    return;
  }

  // v2.72.62 — Antecedent replay progress. Surfaces in the banner.
  if (message.type === 'WALK_PROGRESS') {
    if (!_payload) return;
    if (message.payload?.groundId !== _payload.fragmentId) return;
    const phase = message.payload?.phase;
    const text = message.payload?.message;
    if (!_setupReady && phase === 'antecedent' && text && bannerSubtitleEl) {
      bannerSubtitleEl.textContent = text;
    }
    return;
  }

  // PICK_RESULT
  if (message.type === 'PICK_RESULT') {
    if (!_pickerSession) return;
    if (message.sessionId !== _pickerSession.sessionId) return;

    const { actionIdx, branchIdx, gateIdx, condPick } = _pickerSession;
    const completedSessionId = _pickerSession.sessionId;
    _pickerSession = null;
    if (pickBannerEl) pickBannerEl.classList.add('hidden');
    // v2.74.168 — Tear down the OTHER frames' pickers.
    //
    // _startPick broadcasts START_PICK to every frame so the user can
    // pick in any same-origin frame. When PICK_RESULT fires, only the
    // originating frame's picker stopped itself (via its own
    // stopPicker call) — the top frame and any other iframes that
    // armed are still active with mouse listeners + overlay element
    // mounted. Without an explicit cancel here, the top-frame picker
    // overlay sticks around on the main page (the bug the user
    // reported), and the next ESC press, click, or pick session would
    // collide with the orphaned listeners.
    //
    // broadcastCancelPick re-sends CANCEL_PICK to every frame. The
    // originating frame is already torn down — its handler short-
    // circuits on `!__pickerActive`, so the broadcast is idempotent.
    if (_tabId != null) {
      broadcastCancelPick(_tabId, { sessionId: completedSessionId });
    }

    if (message.error) {
      _showWarning(`Pick error: ${message.error}`);
      return;
    }
    const selector = message.selector ?? '';
    if (!selector) {
      _showWarning('Pick returned an empty selector — try again');
      return;
    }
    if (!_actions[actionIdx]) return;
    // v2.74.0 — Route to a chain branch sub-row when branchIdx is set.
    // v2.74.156 — Route to a gate sub-action when gateIdx is set.
    // v2.74.156 — Route to the gate header's condition when condPick is set.
    //   (condition.selector replaces the usual target.selector.)
    let target;
    if (condPick) {
      target = _actions[actionIdx].condition;
      if (!target) return;
      target.selector = selector;
      // v2.74.177 — Same-origin iframe support for gate conditions.
      // When the picker fires from inside an iframe, message.frame.url
      // carries the iframe's URL. Persist it on the condition so verify
      // (sidepanel) AND runtime (TemplateWalker.checkConditions) can
      // route CHECK_CONDITION to the correct frame. Top-frame picks
      // strip the field so legacy stored rawJson stays clean.
      if (message.frame && message.frame.url) {
        target.frameUrl = String(message.frame.url);
      } else {
        delete target.frameUrl;
      }
      // v2.74.172 — Picking a new selector invalidates any prior
      // verify result (the section changed; the text we previously
      // confirmed inside it may no longer be there). Drop the
      // transient fields so the Verify button re-arms.
      delete target._verified;
      delete target._verifying;
      _renderActions();
      _updateSaveState();
      return;
    } else if (gateIdx !== null && gateIdx !== undefined) {
      target = _actions[actionIdx].body?.[gateIdx];
    } else if (branchIdx !== null && branchIdx !== undefined) {
      target = _actions[actionIdx].branches?.[branchIdx];
    } else {
      target = _actions[actionIdx];
    }
    if (!target) return;
    target.selector = selector;
    // v2.72.87 — Capture label alongside selector. Stored on the action
    // object as pickedLabel; displayed in the row header; surfaces in
    // auto-composed Fragment descriptions later. May be empty for
    // unlabeled elements (e.g. icon-only buttons).
    target.pickedLabel = (message.label ?? '').toString();
    // v2.74.163 — Same-origin iframe support. PICK_RESULT carries
    // `frame: { url, isTop:false }` when the pick originated inside
    // an iframe; top-frame picks send `frame: null`. Persist the URL
    // on the target so runtime dispatch can route into the right
    // frame. Top-frame picks strip the field for back-compat (saved
    // rawJson stays clean for the common case).
    if (message.frame && message.frame.url) {
      target.frameUrl = String(message.frame.url);
    } else {
      delete target.frameUrl;
    }
    target.verified = null;
    _renderActions();
    _updateSaveState();
    return;
  }
}

// ─── Add action ──────────────────────────────────────────────────────────

function _onAddActionClick() {
  // v2.72.64 — Hard cap. + Add action also disabled at the cap, but
  // double-check here so a stale UI state can't bypass it.
  // v2.74.12 — Cap is configurable. When unlimited (_fragmentCapUnlimited),
  // the gate doesn't fire; the user receives a soft warning at the count
  // UI when over SOFT_CAP_THRESHOLD instead.
  if (!_fragmentCapUnlimited && _actions.length >= _fragmentCap) {
    toast(`Fragment cap reached (${_fragmentCap}). Split into multiple Fragments, or set unlimited in Settings.`, 'warn');
    return;
  }
  _actions.push({
    id: uid(),
    action: 'CLICK',     // default action
    selector: '',
    value: '',
    verified: null,
  });
  _renderActions();
  _updateSaveState();
  _scrollNewestActionIntoView();
}

/**
 * v2.74.0 — Add an action-chain card. The card is structurally a
 * CLICK_BY_LABEL with a `branches` array — its presence (even when
 * empty) is what the renderer uses to choose the chain card layout
 * over the regular flat-row layout. Branches are CLICK_BY_LABEL /
 * WAIT / WAIT_FOR sub-rows keyed by literal layer-1 label.
 *
 * The card's head fields are captured the same way as a normal
 * CLICK_BY_LABEL row (Pick + Verify); each branch sub-row has its
 * own Pick + Verify. Author drives the page state between branch
 * captures manually — the chain card persists across drives.
 *
 * Counts as 1 toward the fragment cap.
 */
function _onAddActionChainClick() {
  if (!_fragmentCapUnlimited && _actions.length >= _fragmentCap) {
    toast(`Fragment cap reached (${_fragmentCap}). Split into multiple Fragments, or set unlimited in Settings.`, 'warn');
    return;
  }
  _actions.push({
    id: uid(),
    action: 'CLICK_BY_LABEL',
    selector: '',
    value: '',
    pickedLabel: '',
    verified: null,
    // v2.74.0 — Empty branches array marks this row as a chain card.
    // Plain CLICK_BY_LABEL (the action dropdown choice on a regular
    // + Action row) has no `branches` field at all.
    branches: [],
    // v2.74.3 — Chain-level body value: the single layer-2 selection slot
    // shared by every CLICK_BY_LABEL branch in this chain. Visible in the
    // UI only after the first CLICK_BY_LABEL branch is added.
    bodyValue: '',
  });
  _renderActions();
  _updateSaveState();
  _scrollNewestActionIntoView();
}

/**
 * v2.74.156 — Add an Action gate card. Header is a single condition
 * (same vocabulary as pre/postconditions: selector_present, url_matches,
 * text_present, attribute_equals, plus assertion_ref / perspective_ref from
 * the Ground catalog). Body is a list of sub-actions; runtime evaluates
 * the condition before entering the body and runs the body only when
 * `(condition is satisfied) XOR negate` is true.
 *
 * The card counts as 1 toward the fragment cap (matching the chain card
 * convention) so a gate filled with N sub-actions doesn't sneak past the
 * configured cap on the parent row count.
 */
function _onAddActionGateClick() {
  if (!_fragmentCapUnlimited && _actions.length >= _fragmentCap) {
    toast(`Fragment cap reached (${_fragmentCap}). Split into multiple Fragments, or set unlimited in Settings.`, 'warn');
    return;
  }
  _actions.push({
    id: uid(),
    action: 'ACTION_GATE',
    selector: '',                                 // unused for gates; runtime ignores
    value: '',                                    // unused for gates
    verified: null,                               // gates skip the verify lifecycle
    // Condition seed: a default selector_present row. Author edits via
    // the condition-type dropdown like the pre/post UI.
    condition: emptyCondition('selector_present'),
    negate: false,                                // header flag — invert the gate
    body: [],                                     // sub-actions
  });
  _renderActions();
  _updateSaveState();
  _scrollNewestActionIntoView();
}

/**
 * v2.72.64 — Update the "N of 7" counter and disable the + Add action
 * button when we're at the cap. Called from _renderActions; centralizes
 * cap enforcement.
 * v2.74.12 — Cap is configurable. Unlimited mode shows "N of ∞" with a
 * soft warning (orange-tinted via .fa-action-count-soft-warn) once N
 * exceeds SOFT_CAP_THRESHOLD. Add buttons stay enabled in unlimited mode.
 */
function _updateActionCountUI() {
  const n = _actions.length;
  if (actionCountEl) {
    if (_fragmentCapUnlimited) {
      actionCountEl.textContent = `${n} of ∞`;
      actionCountEl.classList.toggle('fa-action-count-full', false);
      actionCountEl.classList.toggle('fa-action-count-soft-warn', n > SOFT_CAP_THRESHOLD);
      actionCountEl.title = n > SOFT_CAP_THRESHOLD
        ? `Long fragments are harder to debug and reuse. Consider splitting at action ${SOFT_CAP_THRESHOLD + 1} or earlier.`
        : '';
    } else {
      actionCountEl.textContent = `${n} of ${_fragmentCap}`;
      actionCountEl.classList.toggle('fa-action-count-full', n >= _fragmentCap);
      actionCountEl.classList.toggle('fa-action-count-soft-warn', false);
      actionCountEl.title = '';
    }
  }
  const atCap = !_fragmentCapUnlimited && n >= _fragmentCap;
  if (addActionBtnEl) {
    addActionBtnEl.disabled = atCap;
  }
  // v2.74.0 — Chain card also counts as 1 action toward the cap.
  if (addActionChainBtnEl) {
    addActionChainBtnEl.disabled = atCap;
  }
  // v2.74.156 — Gate card also counts as 1 action toward the cap.
  if (addActionGateBtnEl) {
    addActionGateBtnEl.disabled = atCap;
  }
}

// v2.74.14 — Auto-scroll the newest action row into view after add. The
// row's `scroll-margin-bottom` (set in CSS) accounts for the fixed save
// bar so the row's contents aren't hidden behind it. Called after every
// + Action / + Action branch click.
//
// Uses requestAnimationFrame to wait for the DOM to settle after the
// re-render before scrolling — calling scrollIntoView on an element
// just inserted via innerHTML works in Chrome but the layout pass that
// determines its final position may not have run yet, leading to scroll
// targets that miss by a few px. rAF defers until after layout.
function _scrollNewestActionIntoView() {
  if (!actionsListEl) return;
  requestAnimationFrame(() => {
    const rows = actionsListEl.querySelectorAll('.dbg-perspective-landmark-row');
    const last = rows[rows.length - 1];
    if (!last) return;
    last.scrollIntoView({ block: 'end', behavior: 'smooth' });
  });
}

// ─── Render actions list ─────────────────────────────────────────────────

function _renderActions() {
  if (!actionsListEl) return;
  // v2.72.64 — Keep the count display + add-button disabled state in sync.
  _updateActionCountUI();
  // v2.74.318 — Refresh the perspective banner's "authored against" line
  // — it tracks the fragment's linked landmarks, which change as the
  // author links/clears them. Active-set itself only changes on
  // _refreshActivePerspectives; this just re-derives the authored-against side.
  _renderActivePerspectiveBanner();
  // v2.74.22 — Antecedent card lock-state tracks the actions list. Empty
  // → enabled (user can pick + Run); non-empty → disabled (changing the
  // antecedent retroactively would invalidate already-authored work).
  _updateAntecedentCardEnabled();
  // v2.74.23 — On the 0 → >0 actions transition we both auto-collapse
  // the antecedent card AND clear the dropdown if a fragment was
  // picked but never successfully run (mode !== 'undo'). The saved
  // record carries antecedentFragmentId; if the user authored against
  // the default page state instead of the antecedent's post-state,
  // saving the picked id would falsely claim a chain. Clearing here
  // keeps the record honest.
  const cur = _actions.length;
  if (_anteLastActionCount === 0 && cur > 0) {
    const orphanSelection = !!anteSelectEl?.value && _anteRunMode !== 'undo';
    if (!_anteCardCollapsed) _anteCardCollapsed = true;
    if (orphanSelection) {
      anteSelectEl.value = '';
      // _onAntecedentChange clears bindings, resets run mode, refreshes
      // the params row, and re-renders the toggle (with the new "none"
      // collapsed-name).
      _onAntecedentChange();
    } else {
      _renderAntecedentToggle();
    }
  }
  _anteLastActionCount = cur;
  if (_actions.length === 0) {
    actionsListEl.innerHTML = `<div class="dbg-perspective-landmarks-empty">No actions yet — click + Add action.</div>`;
    return;
  }
  // v2.72.65 — Interleave rows with insert-wait strips. Strip at index i
  // inserts a new WAIT action at position i (shifts existing actions
  // from i onward down by one). Includes a strip before row 0 (prepend)
  // and after the last row (which would be redundant with + Add action,
  // so we omit that one).
  const atCap = !_fragmentCapUnlimited && _actions.length >= _fragmentCap;
  const parts = [];
  for (let i = 0; i < _actions.length; i++) {
    parts.push(_renderInsertStrip(i, atCap));
    // v2.74.0 — Chain cards (CLICK_BY_LABEL with branches) get a
    // distinct card layout. Plain actions render the regular row.
    // v2.74.156 — ACTION_GATE renders its own card layout (header
    // condition + negate + body). Detected by action type so future
    // gate shapes (different conditions, multi-condition headers) can
    // reuse the same renderer.
    if (_actions[i].action === 'ACTION_GATE') {
      parts.push(_renderActionGateCard(_actions[i], i));
    } else if (Array.isArray(_actions[i].branches)) {
      parts.push(_renderActionChainCard(_actions[i], i));
    } else {
      parts.push(_renderActionRow(_actions[i], i));
    }
  }
  actionsListEl.innerHTML = parts.join('');

  // v2.74.0 — Helper: resolve the edit target. data-branch-idx on an
  // element means the edit is scoped to a chain card's branch sub-row.
  // v2.74.156 — data-gate-idx scopes the edit to a sub-action inside
  // an ACTION_GATE's body[]. Otherwise (no qualifier), the edit lands
  // on _actions[idx] directly.
  const resolveTarget = (el) => {
    const idx = parseInt(el.dataset.idx, 10);
    const gIdx = el.dataset.gateIdx;
    if (gIdx !== undefined) return _actions[idx]?.body?.[parseInt(gIdx, 10)] ?? null;
    const bIdx = el.dataset.branchIdx;
    if (bIdx !== undefined) return _actions[idx]?.branches?.[parseInt(bIdx, 10)] ?? null;
    return _actions[idx] ?? null;
  };

  // Wire per-row events.
  // v2.74.2 — The action-type select only renders on plain rows (not
  // chain branches — those have a static type tag set at add-time and
  // are not editable). resolveTarget is still safe to use here because
  // every action-type select has data-idx but never data-branch-idx.
  actionsListEl.querySelectorAll('select[data-fa-field="action"]').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const target = resolveTarget(e.target);
      if (!target) return;
      target.action = e.target.value;
      target.verified = null;
      target.value = '';   // reset value when type changes
      // v2.74.186 — Clear selector when switching to an action whose
      // selector field is hidden (ENTER, WAIT, BLUR-no-target, etc.).
      // Without this, a leftover selector from the prior type stays in
      // memory + rawJson, invisible in the UI but still consumed by
      // the runtime — handleEnter for instance would route the
      // keypress to that hidden selector instead of the focused
      // element the author actually wants to target.
      const newMeta = ACTION_BY_TYPE[target.action];
      if (newMeta && newMeta.selector === 'hidden') {
        target.selector = '';
        target.pickedLabel = '';
        delete target.frameUrl;
      }
      // v2.74.315 — KEY defaults to "Enter" so the value matches the
      // dropdown's default selection (the row resets value to '' above,
      // which would otherwise read as Enter in the UI but save as empty
      // → schema rejection). Author changes it via the key dropdown.
      if (target.action === 'KEY') {
        target.value = 'Enter';
        delete target.verifyHelper;
      }
      _renderActions();
      _updateSaveState();
    });
  });
  actionsListEl.querySelectorAll('input[data-fa-field="selector"]').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const target = resolveTarget(e.target);
      if (!target) return;
      target.selector = e.target.value;
      target.verified = null;
      // v2.72.87 — pickedLabel is intentionally NOT cleared here. The
      // label is a hint, not a contract. Hand-edits to the selector are
      // usually small adjustments to the same element; the label stays
      // useful. If the user retargets entirely, they should re-pick to
      // refresh the label.
      _updateSaveState();
    });
  });
  actionsListEl.querySelectorAll('input[data-fa-field="value"]').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const target = resolveTarget(e.target);
      if (!target) return;
      target.value = e.target.value;
      target.verified = null;
      _updateSaveState();
    });
  });
  // v2.74.0 — Chain branch label field. Identifies which layer-1 label
  // this branch is keyed by; runtime dispatches on it. Pre-filled from
  // head's last verify (when available) but always editable.
  actionsListEl.querySelectorAll('input[data-fa-field="branch-label"]').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const bIdx = parseInt(e.target.dataset.branchIdx, 10);
      const branch = _actions[idx]?.branches?.[bIdx];
      if (!branch) return;
      branch.label = e.target.value;
      _updateSaveState();
    });
  });
  // v2.74.3 — Chain-level bodyValue. Single layer-2 selection slot for
  // the chain. Edits invalidate every CLICK_BY_LABEL branch's verified
  // state since they all consume this value.
  actionsListEl.querySelectorAll('input[data-fa-field="body-value"]').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const a = _actions[idx];
      if (!a) return;
      a.bodyValue = e.target.value;
      // Invalidate verify state on every CLICK_BY_LABEL branch — they all
      // consume bodyValue, so a change to it invalidates each branch's
      // last verify.
      if (Array.isArray(a.branches)) {
        for (const b of a.branches) {
          if (b?.action === 'CLICK_BY_LABEL') b.verified = null;
        }
      }
      _updateSaveState();
    });
  });
  // v2.74.7 — Chain head verify-helper. Authoring-only literal label
  // used at verify-time when the head's value is parameterized.
  // Editing this field does NOT invalidate the head's verified state —
  // changing the literal target doesn't invalidate "this selector resolves
  // and the engine can click into it"; it just changes WHICH path the
  // next verify drives the page to.
  actionsListEl.querySelectorAll('input[data-fa-field="verify-helper"]').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const a = _actions[idx];
      if (!a) return;
      // v2.74.181 — Route to the gate sub-action when data-gate-idx is
      // present (the SELECT-in-gate-body test-value input carries it).
      // Without this branch, typing into the gate's SELECT helper would
      // write `a.verifyHelper` on the parent ACTION_GATE — a field that
      // has no consumer, so the verify would silently fall back to
      // 'flying turtle'.
      const gIdxRaw = e.target.dataset.gateIdx;
      if (gIdxRaw !== undefined) {
        const gIdx = parseInt(gIdxRaw, 10);
        const sub = a.body?.[gIdx];
        if (!sub) return;
        sub.verifyHelper = e.target.value;
      } else {
        a.verifyHelper = e.target.value;
      }
      // No save-state effect — verifyHelper isn't part of the saved fragment.
    });
  });
  // v2.72.72 — Smooth-scroll toggle on SCROLL_TO rows.
  actionsListEl.querySelectorAll('input[data-fa-field="smoothScroll"]').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      _actions[idx].smoothScroll = !!e.target.checked;
      _actions[idx].verified = null;
      _updateSaveState();
    });
  });
  actionsListEl.querySelectorAll('button[data-fa-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const action = e.currentTarget.dataset.faAction;
      const bIdxRaw = e.currentTarget.dataset.branchIdx;
      const bIdx = bIdxRaw !== undefined ? parseInt(bIdxRaw, 10) : null;
      // v2.74.156 — Gate sub-action index. When present, Pick/Verify
      // route to _actions[idx].body[gIdx] instead of the parent row or
      // a branch sub-row.
      const gIdxRaw = e.currentTarget.dataset.gateIdx;
      const gIdx = gIdxRaw !== undefined ? parseInt(gIdxRaw, 10) : null;
      if (action === 'pick')          _startPick(idx, bIdx, gIdx);
      else if (action === 'verify')   _verifyAction(idx, bIdx, gIdx);
      else if (action === 'remove')   _removeAction(idx);
      else if (action === 'insert')   _insertWaitAt(idx);
      // v2.74.0 — Chain card actions.
      else if (action === 'add-branch-cbl')      _addChainBranch(idx, 'CLICK_BY_LABEL');
      else if (action === 'add-branch-wait')     _addChainBranch(idx, 'WAIT');
      else if (action === 'add-branch-wait-for') _addChainBranch(idx, 'WAIT_FOR');
      else if (action === 'remove-branch')       _removeChainBranch(idx, bIdx);
      // v2.74.156 — Gate card actions.
      else if (action === 'gate-add-sub')        _addGateSubAction(idx);
      else if (action === 'gate-remove-sub')     _removeGateSubAction(idx, gIdx);
      else if (action === 'gate-pick-cond')      _startGateCondPick(idx);
      // v2.74.172 — Verify the gate's text_present condition against
      // the live page. Runs CHECK_CONDITION, stashes result in
      // cond._verified, re-renders to show ✓/✗ + snippet.
      else if (action === 'gate-verify-text')    _verifyGateTextPresent(idx);
      // v2.74.236 — Wave 3: landmark-ref clear (button on the chip).
      // The <select> change is wired below in a separate forEach
      // because it's a 'change' event not 'click'.
      else if (action === 'landmark-clear')      _clearActionLandmarkRef(idx);
      // v2.74.312 — Reconcile a verify-time effect drift: set the
      // action's declared effect to the observed value.
      // v2.74.313 — Route via branch/gate idx so chain branches + gate
      // sub-actions reconcile their own effect.
      else if (action === 'effect-reconcile')    _reconcileActionEffect(idx, bIdx, gIdx, e.currentTarget.dataset.observed);
      // v2.74.313 — Toggle the inline effect editor open/closed.
      else if (action === 'effect-editor-toggle') {
        const key = _effectEditorKey(idx, bIdx, gIdx);
        if (_actionEffectEditorOpen.has(key)) _actionEffectEditorOpen.delete(key);
        else _actionEffectEditorOpen.add(key);
        _renderActions();
      }
    });
  });
  // v2.74.313 — Inline effect-editor selects (change events). Route to
  // the action / branch / gate-sub the data-attrs point at.
  actionsListEl.querySelectorAll('select[data-fa-action="effect-kind"]').forEach(sel => {
    sel.addEventListener('change', (e) => _onEffectKindChange(e.currentTarget));
  });
  actionsListEl.querySelectorAll('select[data-fa-action="effect-form"]').forEach(sel => {
    sel.addEventListener('change', (e) => _onEffectParamChange(e.currentTarget, 'form'));
  });
  actionsListEl.querySelectorAll('select[data-fa-action="effect-modal-kind"]').forEach(sel => {
    sel.addEventListener('change', (e) => _onEffectParamChange(e.currentTarget, 'modalKind'));
  });
  actionsListEl.querySelectorAll('select[data-fa-action="effect-pattern"]').forEach(sel => {
    sel.addEventListener('change', (e) => _onEffectPatternChange(e.currentTarget));
  });
  // v2.74.315 — KEY action value row: key dropdown + {{PARAM}} field.
  actionsListEl.querySelectorAll('select[data-fa-action="key-select"]').forEach(sel => {
    sel.addEventListener('change', (e) => _onKeySelectChange(e.currentTarget));
  });
  actionsListEl.querySelectorAll('input[data-fa-action="key-param"]').forEach(inp => {
    inp.addEventListener('input', (e) => _onKeyParamInput(e.currentTarget));
  });
  // v2.74.316 — KEY repeat count: number input + preset chips.
  actionsListEl.querySelectorAll('input[data-fa-action="key-repeat"]').forEach(inp => {
    inp.addEventListener('input', (e) => _onKeyRepeatChange(e.currentTarget, e.currentTarget.value));
  });
  actionsListEl.querySelectorAll('button[data-fa-action="key-repeat-preset"]').forEach(btn => {
    btn.addEventListener('click', (e) => _onKeyRepeatChange(e.currentTarget, e.currentTarget.dataset.repeat, true));
  });
  // v2.74.236 — Landmark <select> dropdowns. Change event sets the
  // action's landmarkRef + selector + frameUrl from the chosen
  // landmark, clears prior verify state, and re-renders.
  actionsListEl.querySelectorAll('select[data-fa-action="landmark-select"]').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const value = e.currentTarget.value;
      if (!value) return;   // header option
      const colonIdx = value.indexOf('::');
      if (colonIdx < 0) return;
      const perspectiveId = value.slice(0, colonIdx);
      const role     = value.slice(colonIdx + 2);
      _applyActionLandmarkRef(idx, perspectiveId, role);
    });
  });

  // v2.74.156 — Wire gate header: condition-type select, condition
  // value-field inputs, negate toggle. Mirrors the pre/post wiring at
  // _wireConditionRow + _onConditionFieldInput but routes to
  // _actions[idx].condition / _actions[idx].negate instead of
  // _preconditions / _postconditions.
  actionsListEl.querySelectorAll('select.fa-gate-cond-type').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const a = _actions[idx];
      if (!a) return;
      const decoded = _decodeConditionTypeValue(e.target.value);
      const newType = decoded.type;
      const fresh = emptyCondition(newType);
      // Preserve overlapping fields when switching types — e.g. selector
      // survives a flip from selector_present to selector_absent.
      const old = a.condition ?? {};
      const sharedFields = ['selector', 'attribute', 'value', 'text', 'pattern'];
      for (const f of sharedFields) {
        if (old[f] != null && fresh[f] !== undefined) fresh[f] = old[f];
      }
      // v2.74.177 — Preserve the iframe binding across type switches.
      // frameUrl isn't in CONDITION_FIELDS (it's an out-of-band routing
      // hint, not a condition input), so the field-preservation loop
      // above skips it. Without this explicit carry-over, flipping
      // type from text_present to selector_present would drop the
      // iframe context and the new selector would route to top frame.
      if (old.frameUrl) fresh.frameUrl = old.frameUrl;
      if (decoded.assertionId) fresh.assertionId = decoded.assertionId;
      if (decoded.perspectiveId)    fresh.perspectiveId    = decoded.perspectiveId;
      a.condition = fresh;
      _renderActions();
      _updateSaveState();
    });
  });
  actionsListEl.querySelectorAll('input.fa-gate-cond-input').forEach(inp => {
    const handler = (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const field = e.target.dataset.field;
      const a = _actions[idx];
      if (!a || !a.condition || !field) return;
      a.condition[field] = e.target.value;
      // v2.74.177 — Typing in the selector field drops any prior
      // frameUrl. The iframe binding was established by the picker;
      // a manually-typed selector is implicitly top-frame unless the
      // user re-picks from inside an iframe. Without this, an old
      // iframe context would silently route a typo'd top-frame
      // selector into the wrong frame.
      let didReRender = false;
      if (field === 'selector' && a.condition.frameUrl) {
        delete a.condition.frameUrl;
        didReRender = true;
      }
      // v2.74.180 — Boundary-crossing re-render removed. The test-
      // value input is now always rendered inline next to the text
      // input (SELECT pattern), so there's no helper row to show /
      // hide as the param state changes. Plain typing in the text
      // field just updates cond.text without triggering a re-render.
      // v2.74.172 — Invalidate the transient verify result whenever
      // either input changes — a verification on stale text/selector
      // would be misleading.
      if (a.condition._verified !== undefined || a.condition._verifying !== undefined) {
        delete a.condition._verified;
        delete a.condition._verifying;
        didReRender = true;
      }
      if (didReRender) {
        // Preserve focus + caret across the innerHTML rebuild — the
        // input element gets destroyed by _renderActions(), so we
        // re-query the new one by data-idx + data-field and restore.
        const wasFocused = document.activeElement === e.target;
        const caretPos = e.target.selectionStart ?? e.target.value.length;
        _renderActions();
        if (wasFocused) {
          const newInp = actionsListEl.querySelector(
            `input.fa-gate-cond-input[data-idx="${idx}"][data-field="${field}"]`
          );
          if (newInp) {
            newInp.focus();
            try { newInp.setSelectionRange(caretPos, caretPos); } catch { /* ignore */ }
          }
        }
      }
      _updateSaveState();
    };
    inp.addEventListener('input',  handler);
    inp.addEventListener('change', handler);
  });
  // v2.74.178 — Wire the "verify with:" literal-helper input. Mirrors
  // the action verifyHelper pattern at line 1378. Updates the
  // transient cond._verifyHelper field; doesn't re-render (the user
  // is typing into it) and doesn't touch _updateSaveState (helper
  // isn't part of the saved fragment).
  actionsListEl.querySelectorAll('input[data-fa-gate-helper]').forEach(inp => {
    const handler = (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const a = _actions[idx];
      if (!a || !a.condition) return;
      a.condition._verifyHelper = e.target.value;
      // Invalidate any prior verify so the displayed status doesn't
      // disagree with the new helper. Re-render so the Re-verify
      // button reverts to "Verify".
      if (a.condition._verified !== undefined || a.condition._verifying !== undefined) {
        delete a.condition._verified;
        delete a.condition._verifying;
        _renderActions();
      }
    };
    inp.addEventListener('input',  handler);
    inp.addEventListener('change', handler);
  });
  actionsListEl.querySelectorAll('input[data-fa-gate-negate]').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const a = _actions[idx];
      if (!a) return;
      a.negate = !!e.target.checked;
      _renderActions();   // re-render to update the (negated) tag + hint text
      _updateSaveState();
    });
  });
  // v2.74.201 — Wait-timeout input on gate header. Numeric ms value;
  // empty / 0 means one-shot (current behavior). Stored on the action
  // as `waitTimeout`. Runtime (TemplateWalker ACTION_GATE handler)
  // threads it through to checkConditions's timeoutMs so the condition
  // retries until satisfied or timeout elapses.
  // v2.74.202 — Input is now <input type="text" inputmode="numeric">
  // (no spinner). Sanitize on input to strip non-digits so paste +
  // typing both stay numeric.
  actionsListEl.querySelectorAll('input[data-fa-gate-wait]').forEach(inp => {
    const handler = (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const a = _actions[idx];
      if (!a) return;
      // Sanitize: keep digits only.
      const cleaned = (e.target.value ?? '').replace(/\D+/g, '');
      if (cleaned !== e.target.value) e.target.value = cleaned;
      const raw = parseInt(cleaned, 10);
      if (Number.isFinite(raw) && raw > 0) {
        a.waitTimeout = raw;
      } else {
        delete a.waitTimeout;
      }
      _updateSaveState();
    };
    inp.addEventListener('input',  handler);
    inp.addEventListener('change', handler);
  });
  // v2.74.202 — Preset chips. Click sets the gate's waitTimeout to the
  // chip's data-fa-gate-wait-chip ms value (or clears when value=0).
  // Updates the input visually so the author sees the resulting state.
  actionsListEl.querySelectorAll('button[data-fa-gate-wait-chip]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      const ms  = parseInt(e.currentTarget.dataset.faGateWaitChip, 10);
      const a = _actions[idx];
      if (!a) return;
      if (Number.isFinite(ms) && ms > 0) {
        a.waitTimeout = ms;
      } else {
        delete a.waitTimeout;
      }
      // Sync the input's visible value to the chip selection.
      const inp = actionsListEl.querySelector(
        `input[data-fa-gate-wait][data-idx="${idx}"]`
      );
      if (inp) inp.value = ms > 0 ? String(ms) : '';
      _updateSaveState();
    });
  });
  // v2.72.76 — Drag-and-drop reorder. Wire AFTER each render since
  // innerHTML replacement clears all listeners. Mirrors strategy form
  // wireTopLevelDragAndDrop pattern.
  _wireDragAndDrop();
}

/**
 * v2.72.76 — Drag-and-drop reorder for fragment-author action rows.
 * Mirrors studio.js wireTopLevelDragAndDrop. The drag handle (⋮⋮)
 * activates draggable=true on mousedown; the row's dragstart/dragend/
 * dragover/dragleave/drop events handle the visual feedback and the
 * actual splice. Position-aware invalidation runs after the reorder
 * (earlier-than-affected rows keep their verified state).
 */
function _wireDragAndDrop() {
  if (!actionsListEl) return;
  let dragSourceIdx = null;
  actionsListEl.querySelectorAll(':scope > .dbg-perspective-landmark-row').forEach(card => {
    const handle = card.querySelector('.fa-drag-handle');
    if (!handle) return;
    handle.addEventListener('mousedown', () => { card.draggable = true; });
    card.addEventListener('mouseup',    () => { setTimeout(() => { card.draggable = false; }, 0); });
    card.addEventListener('mouseleave', () => { if (!card.classList.contains('dragging')) card.draggable = false; });
    card.addEventListener('dragstart', (e) => {
      if (!card.draggable) { e.preventDefault(); return; }
      dragSourceIdx = parseInt(card.dataset.idx, 10);
      card.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', String(dragSourceIdx)); } catch { /* ignore */ }
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      card.draggable = false;
      dragSourceIdx = null;
      actionsListEl.querySelectorAll('.dbg-perspective-landmark-row').forEach(c =>
        c.classList.remove('drop-before', 'drop-after'));
    });
    card.addEventListener('dragover', (e) => {
      if (dragSourceIdx === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetIdx = parseInt(card.dataset.idx, 10);
      if (targetIdx === dragSourceIdx) return;
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const isAbove = e.clientY < midY;
      card.classList.toggle('drop-before', isAbove);
      card.classList.toggle('drop-after', !isAbove);
    });
    card.addEventListener('dragleave', (e) => {
      if (!card.contains(e.relatedTarget)) {
        card.classList.remove('drop-before', 'drop-after');
      }
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragSourceIdx === null) return;
      const targetIdx = parseInt(card.dataset.idx, 10);
      if (targetIdx === dragSourceIdx) return;
      const dropBefore = card.classList.contains('drop-before');
      let insertAt = dropBefore ? targetIdx : targetIdx + 1;
      if (dragSourceIdx < insertAt) insertAt -= 1;
      const sourceIdx = dragSourceIdx;
      // Splice + position-aware invalidation. Earlier-than-affected
      // rows keep their verified state (downward flow).
      const [moved] = _actions.splice(sourceIdx, 1);
      _actions.splice(insertAt, 0, moved);
      const firstAffected = Math.min(sourceIdx, insertAt);
      for (let i = firstAffected; i < _actions.length; i++) {
        _actions[i].verified = null;
      }
      _renderActions();
      _updateSaveState();
    });
  });
}

/**
 * v2.72.65 — Render an inline "+ Insert wait" strip at position `idx`.
 * Clicking inserts a new WAIT action at that position. Disabled if the
 * fragment is at the action cap.
 */
function _renderInsertStrip(idx, atCap) {
  return `
    <div class="fa-insert-strip">
      <button class="fa-insert-btn" data-fa-action="insert" data-idx="${idx}"
              type="button" ${atCap ? 'disabled title="Fragment cap reached"' : 'title="Insert a WAIT action here"'}>+ wait</button>
    </div>`;
}

function _renderActionRow(a, idx) {
  const meta = ACTION_BY_TYPE[a.action] ?? ACTION_BY_TYPE['CLICK'];
  const showSelector = meta.selector !== 'hidden';
  const valueMeta = (typeof meta.value === 'object') ? meta.value : null;

  // v2.72.75 — Status row text. Verified-success has no text (the row
  // accent says it all). Failed renders error. Unverified renders nothing
  // (v2.72.76: dropped the "unverified" label — Verify button text
  // distinguishes the state).
  const v = a.verified;
  const isVerified = v?.success === true;
  let statusHtml = '';
  if (v && !v.success) {
    statusHtml = `<div class="dbg-perspective-landmark-status status-err">✗ ${escHtml(v.error ?? 'failed')}</div>`;
  }

  const dropdownOptions = ACTIONS.map(opt =>
    `<option value="${opt.type}" ${a.action === opt.type ? 'selected' : ''}>${opt.type}</option>`
  ).join('');

  // v2.72.74 — Accent applies only to verified-success rows. Unverified
  // and failed rows stay neutral. The accent doubles as a state
  // indicator: colored = verified, gray = pending. Mirrors strategy
  // node cards which render with a full outlined border in the type's
  // color.
  // v2.72.80 — Verifying-in-progress state. Row gets the verifying
  // class which renders a muted version of the action's accent (lower
  // opacity than verified-success) so the user sees the action is
  // mid-execution. Verifying state takes precedence over verified —
  // a re-verify of an already-verified row dims to the in-progress
  // tone, then snaps back to full on completion.
  const isVerifying = a.verifying === true;
  let accentClass = '';
  if (isVerifying) {
    accentClass = `fa-action-row fa-action-row-verifying fa-action-row-${a.action.toLowerCase()}`;
  } else if (isVerified) {
    accentClass = `fa-action-row fa-action-row-verified fa-action-row-${a.action.toLowerCase()}`;
  }

  // v2.72.75 — Smooth-scroll toggle moves from inline (in fields row) to
  // bottom-right corner of the card. Renders in a footer alongside the
  // status text. Footer only renders when status text or toggle exist.
  const toggleHtml = meta.smoothToggle ? `
    <label class="toggle-switch fa-action-toggle" title="Smooth-scroll animation">
      <input type="checkbox" data-fa-field="smoothScroll" data-idx="${idx}" ${a.smoothScroll ? 'checked' : ''} />
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
      <span class="fa-toggle-label">smooth</span>
    </label>
  ` : '';
  const showFooter = statusHtml || toggleHtml;
  const footerHtml = showFooter ? `
    <div class="fa-action-footer">
      <div class="fa-action-footer-status">${statusHtml}</div>
      <div class="fa-action-footer-toggle">${toggleHtml}</div>
    </div>` : '';

  // v2.72.77 — Strategy-card-style layout. Three sections:
  //   .fa-action-head    — drag handle + step number + remove ✕ (right)
  //   .fa-action-body    — row 1: action dropdown + Pick, row 2:
  //                        selector + Verify, then value row full-width
  //   .fa-action-footer  — status text + toggle (unchanged)
  // v2.72.78 — Body rows pair the action dropdown with Pick (same row),
  // and the selector with Verify (same row). Visual logic: the field
  // and the button that operates on it are aligned. For action types
  // without a selector, Verify still appears on row 2 (right-aligned),
  // alone — keeps the position consistent.
  // v2.72.80 — Verify button has three states.
  //   verifying: "Verifying…" + disabled
  //   verified-success: "Re-verify"
  //   else: "Verify"
  let verifyText, verifyDisabled = '';
  if (isVerifying) {
    verifyText = 'Verifying…';
    verifyDisabled = 'disabled';
  } else if (isVerified) {
    verifyText = 'Re-verify';
  } else {
    verifyText = 'Verify';
  }

  // Row 1: action dropdown + spacer + (Pick when selector shown).
  // Spacer keeps Pick anchored to the right edge so the dropdown can
  // be capped at 1/3 row width (v2.72.79) without Pick sliding next
  // to it.
  const row1Html = `
    <div class="fa-action-row-1">
      <select class="fa-action-type" data-fa-field="action" data-idx="${idx}">${dropdownOptions}</select>
      <span class="fa-action-row-spacer"></span>
      ${showSelector
        ? `<button class="dbg-perspective-landmark-pick fa-action-pick" data-fa-action="pick" data-idx="${idx}" type="button">Pick</button>`
        : ``}
    </div>`;

  // Row 2: selector input (when shown) + Verify. When no selector,
  // Verify still renders right-aligned with a spacer on the left.
  // v2.74.230 — Ask Claude button alongside Verify, only when the
  // action carries a selector. Mirrors the observation-author body
  // sub treatment; shares the suggestion-bar UI pattern.
  //
  // v2.74.236 — Wave 3 of the landmark SSOT project. When this action
  // requires a selector AND there are usable landmarks for the
  // current ground, render a landmark-picker dropdown next to the
  // selector input. Selecting a landmark sets action.landmarkRef +
  // populates selector + frameUrl from the landmark; the inline
  // selector input becomes read-only and a chip shows the ref so
  // the author can see "this selector comes from landmark X".
  // Clicking the chip's ✕ converts back to inline editing.
  const isRef = !!a.landmarkRef && typeof a.landmarkRef === 'object';
  const requiredOp = ACTION_TO_LANDMARK_OP[a.action] ?? null;
  // v2.74.321 — Split into two lists: ALL usable landmarks for this ground
  // (op-agnostic) and the subset whose capability matches this action's op.
  // The total drives a discoverability hint when the op-filtered subset is
  // empty (a TYPE action with only clickable landmarks captured) so a
  // missing dropdown isn't mistaken for a missing feature.
  const groundLandmarks = (showSelector && requiredOp && !isRef)
    ? _flatLandmarksForGround().filter(lm => lm.score !== 'mismatch')
    : [];
  const availableLandmarks = groundLandmarks.filter(lm =>
    // Allow if landmark explicitly supports this op, OR has no
    // operationsAllowed metadata at all (legacy landmark — let
    // the author take responsibility).
    lm.operationsAllowed.length === 0 ||
    lm.operationsAllowed.includes(requiredOp)
  );
  // v2.74.317 — PERSPECTIVE_SPEC § 8: partition the landmark dropdown by
  // active-Perspective set. Landmarks whose Perspective matches the live page go
  // in an "📍 On this page" group (first); the rest in "Other
  // perspectives" (still pickable — the author may stage a multi-page
  // fragment). When the active set hasn't been evaluated yet
  // (_activePerspectiveIds === null), every landmark reads isActive=true and
  // the partition collapses to a single flat group (prior behavior).
  const _optFor = (lm) => `<option value="${escAttr(lm.perspectiveId)}::${escAttr(lm.alias)}">${escHtml(lm.perspectiveName)} › ${escHtml(lm.alias)}${lm.score === 'caveats' ? ' ⚠' : ''}</option>`;
  let landmarkSelectHtml = '';
  if (availableLandmarks.length > 0) {
    const active   = availableLandmarks.filter(lm => lm.isActive);
    const inactive = availableLandmarks.filter(lm => !lm.isActive);
    const partitioned = _activePerspectiveIds !== null && active.length > 0 && inactive.length > 0;
    let body;
    if (partitioned) {
      body = `
        <optgroup label="📍 On this page">${active.map(_optFor).join('')}</optgroup>
        <optgroup label="Other perspectives">${inactive.map(_optFor).join('')}</optgroup>`;
    } else {
      body = availableLandmarks.map(_optFor).join('');
    }
    landmarkSelectHtml = `<select class="fa-action-landmark-select" data-fa-action="landmark-select" data-idx="${idx}" title="Pick a verified landmark. 'On this page' = its Perspective's predicates match the current tab.">
         <option value="">🔗 Use landmark…</option>
         ${body}
       </select>`;
  } else if (showSelector && requiredOp && !isRef) {
    // v2.74.321 — The action CAN target a landmark, but none qualify. Render
    // a muted, disabled-looking hint instead of nothing — an absent dropdown
    // is otherwise indistinguishable from "feature missing" (the TYPE-action
    // confusion). Differentiate "ground has landmarks but none match this op"
    // from "ground has no landmarks at all"; both still allow manual selector
    // entry via the selector field below.
    const hasLandmarks = groundLandmarks.length > 0;
    const hint = hasLandmarks
      ? `No ${escHtml(requiredOp)}-capable landmark`
      : `No landmarks captured yet`;
    const tip = hasLandmarks
      ? `This ground has ${groundLandmarks.length} landmark(s), but none support the ${requiredOp} operation. A ${a.action} action needs a landmark with that capability — capture one in Perspective mode, or type a selector manually below.`
      : `No landmarks captured for this ground's perspectives yet. Capture one in Perspective mode to reuse it here, or type a selector manually below.`;
    landmarkSelectHtml = `<span class="fa-action-landmark-empty" title="${escAttr(tip)}">🔗 ${hint}</span>`;
  }
  // v2.74.275 — Legacy { perspectiveId, role } ref shape removed. Refs
  // now carry { uid } only. Look up the landmark in the cache to
  // display owning perspective + alias.
  let refPerspectiveName = '';
  let refAlias      = '';
  let refLandmark   = null;   // v2.74.311 — captured for effect-intel surfacing
  if (isRef && a.landmarkRef?.uid) {
    const targetUid = a.landmarkRef.uid;
    let lmHit = null, perspectiveHit = null;
    for (const loc of _groundPerspectives) {
      const cand = (loc.landmarks ?? []).find(lm => lm?.uid === targetUid);
      if (cand) { lmHit = cand; perspectiveHit = loc; break; }
    }
    refPerspectiveName = perspectiveHit?.name ?? '(unlinked)';
    refAlias      = lmHit?.alias ?? lmHit?.accessibleName ?? targetUid.slice(0, 8);
    refLandmark   = lmHit;
  }
  const refChipHtml = isRef
    ? `<div class="fa-action-landmark-chip">
         <span class="fa-action-landmark-chip-icon">🔗</span>
         <span class="fa-action-landmark-chip-text">${escHtml(refPerspectiveName)} › ${escHtml(refAlias)}</span>
         <button class="fa-action-landmark-chip-clear" data-fa-action="landmark-clear" data-idx="${idx}" type="button" title="Stop using this landmark; edit selector inline">✕</button>
       </div>`
    : '';
  // v2.74.324 — When a landmark is linked (isRef), the editable selector
  // field is suppressed: the ref chip + effect-intel strip already identify
  // the target, so the raw CSS string was duplicative clutter. The field
  // still renders for manual (unlinked) selectors. The "Ask Claude" selector
  // helper was also removed here (vestigial — selector stability is solved at
  // landmark-authoring time via the picker ladder + Claude challenge).
  const row2Html = `
    <div class="fa-action-row-2">
      ${showSelector && !isRef
        ? `<input type="text" class="dbg-perspective-landmark-selector fa-action-selector" data-fa-field="selector" data-idx="${idx}"
                  placeholder="CSS selector" value="${escAttr(a.selector)}" />`
        : `<span class="fa-action-row-spacer"></span>`}
      <button class="dbg-perspective-landmark-verify fa-action-verify" data-fa-action="verify" data-idx="${idx}" type="button" ${verifyDisabled}>${verifyText}</button>
      ${landmarkSelectHtml}
    </div>
    ${refChipHtml}`;

  // Optional value row, full-width below both rows.
  // v2.74.60 — SELECT renders the verify-helper ("param test value")
  // inline next to the value input so the author always sees a test-
  // value field — no longer gated on the value already containing
  // {{PARAM}}. When the value IS parameterized and this field is
  // non-empty, the verify-time substitution uses it instead of the
  // default 'flying turtle' (existing verifyHelper plumbing, see
  // _verifyAction). For non-SELECT actions the original below-row
  // helper rendering is preserved (it still only appears when the
  // value contains a {{PARAM}} token).
  const valueRowHtml = valueMeta ? (
    a.action === 'KEY'
      // v2.74.315 — KEY-specific value row: a dropdown of common keys
      // plus a separate {{PARAM}} field. See _renderKeyValueRow.
      ? _renderKeyValueRow(a, idx)
    : a.action === 'SELECT'
      ? `
        <div class="fa-action-value-row fa-action-value-row-select">
          <input type="text" class="fa-action-value" data-fa-field="value" data-idx="${idx}"
                 placeholder="${escAttr(valueMeta.placeholder)}" title="${escAttr(valueMeta.label)}"
                 value="${escAttr(a.value)}" />
          <input type="text" class="fa-action-test-value" data-fa-field="verify-helper" data-idx="${idx}"
                 placeholder="param test value (e.g. Red)"
                 title="Authoring-only. When the value is a parameter, this literal substitutes for the param at verify time (overrides 'flying turtle'). Not saved with the fragment."
                 value="${escAttr(a.verifyHelper ?? '')}" />
        </div>`
      : `
        <div class="fa-action-value-row">
          <input type="text" class="fa-action-value" data-fa-field="value" data-idx="${idx}"
                 placeholder="${escAttr(valueMeta.placeholder)}" title="${escAttr(valueMeta.label)}"
                 value="${escAttr(a.value)}" />
        </div>`
  ) : '';

  // v2.74.12 — Verify-helper field. Same idea as the chain head's helper
  // (v2.74.7): when the action's value is parameterized, the verify-time
  // substitute is "flying turtle" (or __VERIFY_FIRST__ for CLICK_BY_LABEL),
  // which validates structure but not realistic semantic effect. The
  // helper lets the author type a literal value (e.g. their real name for
  // a TYPE action) so verify exercises a realistic page state.
  // Authoring-only: NOT serialized, NOT hydrated on re-walk. Skipped when
  // value is literal (verify already uses the literal). Skipped for
  // actions without a value field (CLICK, SCROLL_TO, BLUR, WAIT_FOR, etc).
  // v2.74.60 — SELECT renders its helper inline (see valueRowHtml above);
  // skip the below-row rendering for it.
  // v2.74.315 — KEY folds its verify-time literal into the key dropdown
  // of its custom value row, so it skips the generic verify-helper row.
  const valueIsParameterized = valueMeta && /\{\{[A-Z0-9_]+\}\}/.test(a.value ?? '');
  const verifyHelperRowHtml = (a.action !== 'SELECT' && a.action !== 'KEY' && valueIsParameterized) ? `
    <div class="fa-verify-helper-row">
      <span class="fa-verify-helper-label" title="Authoring-only. When verifying a parameterized value, the engine substitutes this literal so verify exercises a realistic page state. Not saved with the fragment.">verify with:</span>
      <input type="text" class="fa-verify-helper-input"
             data-fa-field="verify-helper" data-idx="${idx}"
             placeholder="${escAttr(`literal ${valueMeta.label.toLowerCase()} for verify (e.g. ${valueMeta.placeholder})`)}"
             title="Literal value used at verify-time only — overrides 'flying turtle' substitution"
             value="${escAttr(a.verifyHelper ?? '')}" />
    </div>` : '';

  return `
    <div class="dbg-perspective-landmark-row ${accentClass}" data-idx="${idx}">
      <div class="fa-action-head">
        <span class="strategy-step-handle fa-drag-handle" title="Drag to reorder" aria-label="Drag handle">⋮⋮</span>
        <span class="fa-order">${idx + 1}.</span>
        <span class="fa-action-head-spacer"></span>
        <button class="btn-action danger" data-fa-action="remove" data-idx="${idx}" title="Remove" type="button">✕</button>
      </div>
      <div class="fa-action-body">
        ${row1Html}
        ${a.action === 'KEY' ? '' : row2Html}
        ${valueRowHtml}
        ${verifyHelperRowHtml}
        ${_renderActionEffectIntel(a, { idx }, refLandmark)}
      </div>
      ${footerHtml}
    </div>`;
}

// v2.74.315 — Common key names for the KEY action dropdown. Each is a
// KeyboardEvent.key value the content-script handleKey + _KEY_CODE_MAP
// understand. "Space" maps to the literal " " key in handleKey.
const KEY_NAME_OPTIONS = Object.freeze([
  'Enter', 'Escape', 'Tab', 'Space',
  'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight',
  'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
]);

/**
 * v2.74.315 — Custom value row for the KEY action.
 *
 * Two controls:
 *   1. A dropdown of common key names (Enter / Escape / Tab / arrows / …).
 *   2. A separate {{PARAM}} field for runtime-bound keys.
 *
 * Semantics:
 *   - Param field EMPTY  → a.value = the dropdown key (literal). The
 *     dropdown IS the value.
 *   - Param field FILLED → a.value = {{PARAM}}; the dropdown becomes the
 *     verify-time literal (a.verifyHelper) so Verify exercises a real
 *     key. The dropdown label switches to "verify with".
 *
 * This keeps the common case (pick a key) one-click, while supporting
 * parameterized keys without a confusing freeform string that the author
 * could typo into an invalid KeyboardEvent.key.
 */
function _renderKeyValueRow(a, idx) {
  const raw = (a.value ?? '').toString();
  const isParam = /^\{\{[A-Z0-9_]+\}\}$/.test(raw);
  const paramName = isParam ? raw.slice(2, -2) : '';
  // Selected dropdown key: when param-mode, the verify literal; else the value.
  const selectedKey = isParam ? (a.verifyHelper || 'Enter') : (raw || 'Enter');
  // If the selected key isn't one of the common options (a custom/legacy
  // value), surface it as an extra selected option so it's not silently lost.
  const options = KEY_NAME_OPTIONS.includes(selectedKey)
    ? KEY_NAME_OPTIONS
    : [selectedKey, ...KEY_NAME_OPTIONS];
  const optionsHtml = options.map(k =>
    `<option value="${escAttr(k)}" ${k === selectedKey ? 'selected' : ''}>${escHtml(k)}</option>`
  ).join('');
  const dropdownLabel = isParam ? 'verify with:' : 'key:';

  // v2.74.316 — Verify button moves INTO this row (KEY's generic row2 is
  // suppressed). Recompute verify state here since we're outside the
  // main row scope.
  const isVerifying = a.verifying === true;
  const isVerified  = a.verified?.success === true;
  const verifyText  = isVerifying ? 'Verifying…' : (isVerified ? 'Re-verify' : 'Verify');
  const verifyDisabled = isVerifying ? 'disabled' : '';

  // v2.74.316 — Speculative repeat count. Dispatches the key N times
  // (ArrowDown ×5 to move down a list, Tab ×3 to advance focus, etc.).
  // Default 1 (absent). Preset chips mirror the WAIT-value quick-set
  // idea. Stored as a.repeat; serialized only when > 1.
  const repeat = Math.max(1, parseInt(a.repeat, 10) || 1);
  const presetChip = (n) => `<button type="button" class="fa-key-repeat-chip ${repeat === n ? 'fa-key-repeat-chip-active' : ''}" data-fa-action="key-repeat-preset" data-idx="${idx}" data-repeat="${n}" title="Press ${n} time${n === 1 ? '' : 's'}">×${n}</button>`;

  return `
    <div class="fa-action-value-row fa-key-value-row">
      <span class="fa-key-label" title="${escAttr(isParam
        ? 'The key sent at VERIFY time (the saved value is the parameter below).'
        : 'The key sent to the focused element (keydown / keypress / keyup).')}">${dropdownLabel}</span>
      <select class="fa-key-select" data-fa-action="key-select" data-idx="${idx}">
        ${optionsHtml}
      </select>
      <input type="text" class="fa-key-param-input" data-fa-action="key-param" data-idx="${idx}"
             placeholder="or {{PARAM}} for runtime"
             title="Optional. When set, the saved key is a parameter ({{NAME}}) bound at runtime; the dropdown above is the literal used at verify time."
             value="${escAttr(paramName)}" />
      <button class="dbg-perspective-landmark-verify fa-action-verify fa-key-verify" data-fa-action="verify" data-idx="${idx}" type="button" ${verifyDisabled}>${verifyText}</button>
    </div>
    <div class="fa-key-repeat-row">
      <span class="fa-key-repeat-label" title="Number of times to send the key (keydown/keypress/keyup repeated). 1 = single press.">repeat:</span>
      <input type="number" min="1" max="50" class="fa-key-repeat-input" data-fa-action="key-repeat" data-idx="${idx}"
             value="${repeat}" title="Repeat count (1–50)" />
      <span class="fa-key-repeat-x">×</span>
      ${presetChip(1)}${presetChip(2)}${presetChip(5)}
    </div>`;
}

// v2.74.313 — Composite key for the inline effect-editor open state.
function _effectEditorKey(idx, branchIdx, gateIdx) {
  return `${idx}:${branchIdx ?? ''}:${gateIdx ?? ''}`;
}

// v2.74.313 — Resolve the action/branch/gate-sub object a route points
// at. Mirrors _verifyAction's target resolution.
function _resolveActionTarget(idx, branchIdx, gateIdx) {
  const a = _actions[idx];
  if (!a) return null;
  if (gateIdx !== null && gateIdx !== undefined)   return a.body?.[gateIdx] ?? null;
  if (branchIdx !== null && branchIdx !== undefined) return a.branches?.[branchIdx] ?? null;
  return a;
}

/**
 * v2.74.311 — Effect-intel surface for a fragment action row. Closes
 * the gap where landmark substrate intel (declared effect, interaction
 * pattern, pitfalls) was invisible once an action referenced a landmark.
 *
 * Renders a compact intel strip below the value row showing:
 *   - the action's declared substrate effect (ACTION_SPEC § 5) as a chip
 *   - the DOM interaction pattern as a chip (when non-none)
 *   - the linked landmark's pitfalls (the real gotchas — "disabled until
 *     form dirty", "re-renders on keystroke", etc.)
 *   - sanity warnings: a navigation/new-thread effect on a NON-terminal
 *     action (downstream steps may race the new page); a triggers-modal
 *     effect (browser-modal handling not yet implemented — the run will
 *     auto-dismiss or stall)
 *
 * Returns '' (no strip) when there's nothing worth surfacing — keeps
 * the common no-effect CLICK/TYPE row uncluttered.
 *
 * @param {object} a           the action
 * @param {number} idx         action index
 * @param {object|null} lm     the linked landmark record (null when inline)
 */
function _renderActionEffectIntel(target, route, lm) {
  if (!target) return '';
  const idx       = route.idx;
  const branchIdx = route.branchIdx ?? null;
  const gateIdx   = route.gateIdx ?? null;
  // Only selector-bearing landmark-targeting actions get an effect
  // editor (effects are about what an action CAUSES; WAIT/WAIT_FOR
  // don't cause substrate effects). The chips/observed lines still
  // render for any target that carries them.
  const meta = ACTION_BY_TYPE[target.action];
  const editable = !!meta && meta.selector !== 'hidden'
    && !['WAIT', 'WAIT_FOR', 'WAIT_FOR_GONE'].includes(target.action);

  const effect = (target.effect && target.effect.kind) ? target.effect : { kind: 'none' };
  const pattern = target.interactionPattern && target.interactionPattern !== 'none' ? target.interactionPattern : null;
  const pitfalls = Array.isArray(lm?.pitfalls) ? lm.pitfalls.filter(p => p && p.trim()) : [];
  const dataIds = `data-idx="${idx}"${branchIdx !== null ? ` data-branch-idx="${branchIdx}"` : ''}${gateIdx !== null ? ` data-gate-idx="${gateIdx}"` : ''}`;
  const editorKey = _effectEditorKey(idx, branchIdx, gateIdx);
  const editorOpen = _actionEffectEditorOpen.has(editorKey);

  const fmt = (e) => {
    if (!e || !e.kind) return 'none';
    if (e.kind === 'opens-new-thread' && e.form) return `opens-new-thread (${e.form})`;
    if (e.kind === 'triggers-modal' && e.modalKind) return `triggers-modal (${e.modalKind})`;
    return e.kind;
  };

  // ── Chips (collapsed view) + editor toggle ────────────────────────
  const chips = [];
  if (effect.kind && effect.kind !== 'none') {
    chips.push(`<span class="fa-effect-chip fa-effect-chip-substrate" title="Declared substrate-level effect (ACTION_SPEC § 5).">⚡ ${escHtml(fmt(effect))}</span>`);
  }
  if (pattern) {
    chips.push(`<span class="fa-effect-chip fa-effect-chip-pattern" title="DOM-level interaction pattern (authoring intel).">${escHtml(pattern)}</span>`);
  }
  // Edit affordance for editable actions. Label depends on whether an
  // effect is already set.
  let editToggleHtml = '';
  if (editable) {
    const toggleLabel = editorOpen ? 'done' : (effect.kind === 'none' ? '+ effect' : 'edit');
    editToggleHtml = `<button class="fa-effect-edit-toggle" data-fa-action="effect-editor-toggle" ${dataIds} type="button" title="Declare what this action causes at the browser level (ACTION_SPEC § 5). Per-action; overrides the landmark default.">⚙ ${escHtml(toggleLabel)}</button>`;
  }

  // ── Inline editor (expanded) ──────────────────────────────────────
  let editorHtml = '';
  if (editable && editorOpen) {
    const opt = (val, label, sel) => `<option value="${escAttr(val)}" ${sel ? 'selected' : ''}>${escHtml(label)}</option>`;
    const k = effect.kind ?? 'none';
    const kindSel = `
      <select class="fa-effect-kind-select" data-fa-action="effect-kind" ${dataIds} title="Substrate-level effect kind">
        ${opt('none',                'none — no browser-level effect', k === 'none')}
        ${opt('triggers-navigation', 'triggers-navigation',            k === 'triggers-navigation')}
        ${opt('opens-new-thread',    'opens-new-thread',               k === 'opens-new-thread')}
        ${opt('triggers-modal',      'triggers-modal',                 k === 'triggers-modal')}
        ${opt('triggers-download',   'triggers-download',              k === 'triggers-download')}
      </select>`;
    let paramSel = '';
    if (k === 'opens-new-thread') {
      const f = effect.form ?? 'tab';
      paramSel = `<select class="fa-effect-param-select" data-fa-action="effect-form" ${dataIds} title="opens-new-thread.form">
        ${opt('tab','tab',f==='tab')}${opt('window','window',f==='window')}${opt('popup','popup',f==='popup')}${opt('sidebar','sidebar',f==='sidebar')}
      </select>`;
    } else if (k === 'triggers-modal') {
      const mk = effect.modalKind ?? 'confirm';
      paramSel = `<select class="fa-effect-param-select" data-fa-action="effect-modal-kind" ${dataIds} title="triggers-modal.modalKind">
        ${opt('alert','alert',mk==='alert')}${opt('confirm','confirm',mk==='confirm')}${opt('prompt','prompt',mk==='prompt')}
      </select>`;
    }
    const p = target.interactionPattern ?? 'none';
    const patternSel = `
      <select class="fa-effect-pattern-select" data-fa-action="effect-pattern" ${dataIds} title="DOM interaction pattern (authoring intel)">
        ${opt('none','pattern: none',p==='none')}
        ${opt('opens-menu','opens-menu',p==='opens-menu')}
        ${opt('switches-tab','switches-tab',p==='switches-tab')}
        ${opt('toggles-expansion','toggles-expansion',p==='toggles-expansion')}
        ${opt('toggles-state','toggles-state',p==='toggles-state')}
        ${opt('submits-in-place','submits-in-place',p==='submits-in-place')}
        ${opt('mutates-page','mutates-page',p==='mutates-page')}
      </select>`;
    editorHtml = `<div class="fa-effect-editor">${kindSel}${paramSel}${patternSel}</div>`;
  }

  // ── Sanity warnings ───────────────────────────────────────────────
  const warnings = [];
  // "Last action" only meaningful for top-level rows (branchIdx/gateIdx
  // null). Sub-actions inside a gate/chain don't have a simple "next
  // action races" relationship at this level.
  const isTopLevel = branchIdx === null && gateIdx === null;
  const isLast = isTopLevel && idx === _actions.length - 1;
  if (isTopLevel && !isLast && (effect.kind === 'triggers-navigation' || effect.kind === 'opens-new-thread')) {
    warnings.push(`This action ${effect.kind === 'opens-new-thread' ? 'opens a new browser thread' : 'navigates the page'}; the next action may race the transition — consider a WAIT_FOR / WAIT_FOR_GONE after it.`);
  }
  if (effect.kind === 'triggers-modal') {
    warnings.push(`This action triggers a browser ${effect.modalKind ?? ''} modal. Browser-modal handling isn't implemented yet — at runtime the dialog may stall the page or auto-dismiss.`);
  }

  // ── Verify-time observed-vs-declared ──────────────────────────────
  const obs = target.verified?.success === true ? target.verified.effectObservation : null;
  let observedHtml = '';
  if (obs) {
    // v2.74.322 — Surface the observed DOM-shape pattern alongside the
    // spec effect. A click that opens a custom dropdown is correctly
    // effect:none per ACTION_SPEC § 5 (triggers-modal = browser modals
    // only), but the pattern (opens-menu) is the meaningful signal — and
    // without showing it, "observed: none ✓" looked like Verify missed
    // the dropdown entirely.
    const obsPattern = (typeof obs.observedInteractionPattern === 'string'
      && obs.observedInteractionPattern !== 'none') ? obs.observedInteractionPattern : null;
    const patternSuffix = obsPattern
      ? ` <span class="fa-effect-observed-pattern" title="DOM-shape behavior observed during Verify (our interaction-pattern layer — not an ACTION_SPEC effect). e.g. 'opens-menu' = a menu/dropdown/popover/dialog became visible; 'toggles-expansion' = an accordion/disclosure opened.">· pattern: <strong>${escHtml(obsPattern)}</strong></span>`
      : '';
    if (obs.observable === false) {
      observedHtml = `<div class="fa-effect-observed fa-effect-observed-inconclusive" title="This effect kind can't be confirmed by Verify (browser modals / downloads aren't observed at authoring time).">observed: <em>not observable at verify time</em>${patternSuffix}</div>`;
    } else if (obs.severity) {
      const obsJson = escAttr(JSON.stringify(obs.observedEffect ?? { kind: 'none' }));
      observedHtml = `<div class="fa-effect-observed fa-effect-observed-drift" title="Verify observed a different effect than declared (severity: ${escAttr(obs.severity)}).">
        observed: <strong>${escHtml(fmt(obs.observedEffect))}</strong> ≠ declared <strong>${escHtml(fmt(obs.declaredEffect))}</strong>${patternSuffix}
        <button class="btn-secondary tiny fa-effect-reconcile" data-fa-action="effect-reconcile" ${dataIds} data-observed="${obsJson}" type="button" title="Set this action's declared effect to the observed value">Set declared = observed</button>
      </div>`;
    } else {
      observedHtml = `<div class="fa-effect-observed fa-effect-observed-ok" title="Verify observed the declared effect — confirmed.">observed: <strong>${escHtml(fmt(obs.observedEffect))}</strong> ✓ matches declared${patternSuffix}</div>`;
    }
  }

  // Nothing at all → no strip.
  if (chips.length === 0 && !editToggleHtml && !editorHtml && pitfalls.length === 0 && warnings.length === 0 && !observedHtml) return '';

  const headerHtml = (chips.length || editToggleHtml)
    ? `<div class="fa-effect-chips">${chips.join('')}${editToggleHtml}</div>`
    : '';
  const pitfallsHtml = pitfalls.length
    ? `<ul class="fa-effect-pitfalls">${pitfalls.map(p => `<li title="Landmark pitfall — flagged at authoring time.">⚠ ${escHtml(p)}</li>`).join('')}</ul>`
    : '';
  const warningsHtml = warnings.length
    ? `<ul class="fa-effect-warnings">${warnings.map(w => `<li>⚠ ${escHtml(w)}</li>`).join('')}</ul>`
    : '';

  return `
    <div class="fa-action-effect-intel">
      ${headerHtml}
      ${editorHtml}
      ${observedHtml}
      ${warningsHtml}
      ${pitfallsHtml}
    </div>`;
}

// ─── v2.74.0 — Action chain card ──────────────────────────────────────────
//
// A chain card is a CLICK_BY_LABEL with a `branches` array. The card
// has two zones: a head (the layer-1 click) and a body (per-branch
// sub-rows keyed by literal layer-1 label). Each sub-row is a single
// action of type CLICK_BY_LABEL, WAIT, or WAIT_FOR.
//
// The head behaves like a CLICK_BY_LABEL row: container picker,
// {{LAYER1}} parameterizable value. Each branch sub-row has its own
// picker and verify; author manually drives the page state between
// branch captures.

/**
 * Render a chain card.
 * @param {Object} a    - The action object (CLICK_BY_LABEL with branches).
 * @param {number} idx  - Index in _actions.
 */
function _renderActionChainCard(a, idx) {
  const isVerifying = a.verifying === true;
  const isVerified = a.verified?.success === true;
  let accentClass = 'fa-action-row fa-action-chain-card';
  if (isVerifying)      accentClass += ' fa-action-row-verifying fa-action-row-click_by_label';
  else if (isVerified)  accentClass += ' fa-action-row-verified  fa-action-row-click_by_label';

  // Head verify status row (errors only).
  const headStatusHtml = (a.verified && !a.verified.success)
    ? `<div class="dbg-perspective-landmark-status status-err">✗ ${escHtml(a.verified.error ?? 'failed')}</div>`
    : '';

  let headVerifyText = 'Verify';
  let headVerifyDisabled = '';
  if (isVerifying)     { headVerifyText = 'Verifying…'; headVerifyDisabled = 'disabled'; }
  else if (isVerified) { headVerifyText = 'Re-verify'; }

  const headRow1 = `
    <div class="fa-action-row-1">
      <span class="fa-action-chain-tag">CLICK_BY_LABEL (chain head)</span>
      <span class="fa-action-row-spacer"></span>
      <button class="dbg-perspective-landmark-pick fa-action-pick" data-fa-action="pick" data-idx="${idx}" type="button">Pick</button>
    </div>`;
  const headRow2 = `
    <div class="fa-action-row-2">
      <input type="text" class="dbg-perspective-landmark-selector fa-action-selector" data-fa-field="selector" data-idx="${idx}"
             placeholder="layer-1 container CSS selector" value="${escAttr(a.selector)}" />
      <button class="dbg-perspective-landmark-verify fa-action-verify" data-fa-action="verify" data-idx="${idx}" type="button" ${headVerifyDisabled}>${headVerifyText}</button>
    </div>`;
  const headValueRow = `
    <div class="fa-action-value-row">
      <input type="text" class="fa-action-value" data-fa-field="value" data-idx="${idx}"
             placeholder="layer-1 label (e.g. {{LAYER1}}) — or literal text" title="layer-1 label"
             value="${escAttr(a.value)}" />
    </div>`;

  // v2.74.7 — Verify-helper field. When the head's value is parameterized
  // (e.g. {{LAYER1}}), verify-time has no concrete label to click — today
  // it falls back to __VERIFY_FIRST__ (clicks the first option). That works
  // for validating selector + structure, but doesn't open the SPECIFIC
  // layer-1 path the author wants to capture branches for.
  //
  // The verify-helper lets the author type a literal label (e.g. "Pay")
  // for verify-time only. The verify call uses this literal in place of
  // the parameterized value, so the click drives the page to the chosen
  // layer-1 path. After verify, the layer-2 menu for "Pay" is open and
  // the author can click Pick on the matching branch sub-row to capture
  // its layer-2 container selector.
  //
  // Authoring-only: NOT serialized to rawJson, NOT hydrated on re-walk.
  // Pre-filled when a CLICK_BY_LABEL branch is added (from the new
  // branch's seed label) so the typical flow auto-fills the helper.
  const valueIsParameterized = /\{\{[A-Z0-9_]+\}\}/.test(a.value ?? '');
  const verifyHelperRow = valueIsParameterized ? `
    <div class="fa-chain-verify-helper-row">
      <span class="fa-chain-verify-helper-label" title="Authoring-only. When verifying a parameterized head, the engine clicks this literal label so you can drive the page to a specific layer-1 path before capturing its branch's layer-2 selector.">verify with:</span>
      <input type="text" class="fa-chain-verify-helper-input"
             data-fa-field="verify-helper" data-idx="${idx}"
             placeholder="literal layer-1 label (e.g. Pay)"
             title="Literal label used at verify-time only — overrides __VERIFY_FIRST__"
             value="${escAttr(a.verifyHelper ?? '')}" />
    </div>` : '';

  const headFooter = headStatusHtml
    ? `<div class="fa-action-footer"><div class="fa-action-footer-status">${headStatusHtml}</div></div>`
    : '';

  // Body: branches.
  const branchesHtml = (a.branches ?? []).map((b, bIdx) => _renderChainBranch(idx, bIdx, b)).join('');

  // v2.74.3 — Chain-level body value. The single layer-2 selection slot,
  // shared by every CLICK_BY_LABEL branch in the chain. WAIT/WAIT_FOR
  // branches don't consume bodyValue (their value/selector are their own
  // semantics — milliseconds and selector-to-wait-for, not layer-2 picks).
  // Only render the field when at least one CLICK_BY_LABEL branch exists,
  // since otherwise the field has no consumer.
  const hasCblBranch = (a.branches ?? []).some(b => b?.action === 'CLICK_BY_LABEL');
  const bodyValueHtml = hasCblBranch ? `
    <div class="fa-chain-body-value-row">
      <span class="fa-chain-body-value-label" title="Layer-2 selection — the value runtime substitutes for every CLICK_BY_LABEL branch's click target.">layer-2:</span>
      <input type="text" class="fa-action-value fa-chain-body-value-input"
             data-fa-field="body-value" data-idx="${idx}"
             placeholder="layer-2 label (e.g. {{LAYER2}}) — or literal text"
             title="Single value used by every CLICK_BY_LABEL branch in this chain"
             value="${escAttr(a.bodyValue ?? '')}" />
    </div>` : '';

  // Add-branch buttons. Body action types restricted to CLICK_BY_LABEL,
  // WAIT, WAIT_FOR.
  const addBranchButtonsHtml = `
    <div class="fa-chain-add-branch-row">
      <span class="fa-chain-add-branch-label">+ branch:</span>
      <button class="btn-secondary fa-chain-add-branch-btn" data-fa-action="add-branch-cbl"      data-idx="${idx}" type="button">Click by label</button>
      <button class="btn-secondary fa-chain-add-branch-btn" data-fa-action="add-branch-wait"     data-idx="${idx}" type="button">Wait</button>
      <button class="btn-secondary fa-chain-add-branch-btn" data-fa-action="add-branch-wait-for" data-idx="${idx}" type="button">Wait for</button>
    </div>`;

  return `
    <div class="dbg-perspective-landmark-row ${accentClass}" data-idx="${idx}">
      <div class="fa-action-head">
        <span class="strategy-step-handle fa-drag-handle" title="Drag to reorder" aria-label="Drag handle">⋮⋮</span>
        <span class="fa-order">${idx + 1}.</span>
        ${a.pickedLabel ? `<span class="fa-action-head-label">BRANCH <span class="fa-action-head-quote">"${escHtml(a.pickedLabel)}"</span></span>` : `<span class="fa-action-head-label">BRANCH</span>`}
        <span class="fa-action-head-spacer"></span>
        <button class="btn-action danger" data-fa-action="remove" data-idx="${idx}" title="Remove action branch" type="button">✕</button>
      </div>
      <div class="fa-action-body fa-chain-head-body">
        ${headRow1}
        ${headRow2}
        ${headValueRow}
        ${verifyHelperRow}
        ${_renderActionEffectIntel(a, { idx }, null)}
      </div>
      ${headFooter}
      <div class="fa-chain-body">
        <div class="fa-chain-body-label">Branches (${(a.branches ?? []).length}) — keyed by layer-1 label:</div>
        ${bodyValueHtml}
        ${branchesHtml || `<div class="fa-chain-body-empty">No branches yet — drive the page to a layer-1 option, then click "+ branch" below.</div>`}
        ${addBranchButtonsHtml}
      </div>
    </div>`;
}

// v2.74.156 — Action gate card.
//
// Header: a single condition (selector_present / selector_absent /
//   url_matches / text_present / attribute_equals / assertion_ref /
//   perspective_ref — same vocabulary the pre/postcondition rows accept)
//   plus a negate toggle.
// Body: a list of sub-action rows. At runtime the body runs only when
//   `(condition is satisfied) XOR negate` is true.
//
// Sub-actions use a slimmed-down row layout (action dropdown + selector
// + value + Pick + Verify + Remove). They scope to the gate via
// `data-gate-idx`; the resolveTarget lookup at the top of _renderActions
// reads gate-idx before falling back to branch-idx / parent-row.
//
// Body action types supported in v1: CLICK, CLICK_BY_LABEL, TYPE, WAIT,
// WAIT_FOR, BLUR. EXTRACT / ENUMERATE / EMIT inside gates are a follow-
// up — runtime needs to thread scope writes through the gate's
// conditional dispatch. Authors can still place an EXTRACT outside the
// gate to capture a value regardless of branch.
function _renderActionGateCard(a, idx) {
  const negate = !!a.negate;
  const cond = a.condition ?? { type: 'selector_present', selector: '' };

  // Reuse the same condition-type dropdown the pre/post UI uses so the
  // vocabulary stays in lockstep — Ground assertions and perspectives appear
  // as well, since this is just a condition.
  const typeOpts = _buildConditionTypeOptions(cond);

  // Per-condition-type value input(s). Mirrors _renderConditionRow's
  // body but with attrs scoped to the gate (`data-fa-gate-cond` so the
  // wiring handler routes back to _actions[idx].condition).
  const attrs = `data-fa-gate-cond="1" data-idx="${idx}"`;
  let valueHtml;
  const t = cond.type ?? 'selector_present';
  if (t === 'selector_present' || t === 'selector_absent') {
    valueHtml = `
      <input type="text" class="cond-value-input fa-gate-cond-input"
             ${attrs} data-field="selector"
             value="${escAttr(cond.selector ?? '')}"
             placeholder="CSS selector, e.g. .results-loaded" />
      <button class="dbg-perspective-landmark-pick fa-gate-cond-pick"
              data-fa-action="gate-pick-cond" data-idx="${idx}" type="button">Pick</button>`;
  } else if (t === 'url_matches') {
    valueHtml = `<input type="text" class="cond-value-input fa-gate-cond-input"
                        ${attrs} data-field="pattern"
                        value="${escAttr(cond.pattern ?? '')}"
                        placeholder="URL substring or /regex/" />`;
  } else if (t === 'text_present') {
    // v2.74.170 — Selector + Pick + text input + Verify (originally
    // conditionally added a helper row when text had {{PARAM}}).
    // v2.74.180 — Mirrors the SELECT action pattern (line 1727+):
    // ALWAYS render the test-value input alongside the text input,
    // regardless of whether the text contains a {{PARAM}} token.
    // No conditional rendering, no re-render-on-boundary tricks —
    // the field is always there, ready for the author to fill in
    // a verify-time literal whenever the text is parameterized.
    // When the text is a literal, the test-value field has no
    // semantic effect (helper substitution only fires when text
    // contains a {{PARAM}} token); placeholder copy makes that
    // clear.
    const v = cond._verified;
    const isVerifying = cond._verifying === true;
    let verifyText = 'Verify';
    let verifyDisabled = '';
    if (isVerifying)            { verifyText = 'Verifying…'; verifyDisabled = 'disabled'; }
    else if (v?.success === true) { verifyText = 'Re-verify'; }
    valueHtml = `
      <input type="text" class="cond-value-input cond-value-narrow fa-gate-cond-input"
             ${attrs} data-field="selector"
             value="${escAttr(cond.selector ?? '')}"
             placeholder="CSS selector (optional — whole page if blank)" />
      <button class="dbg-perspective-landmark-pick fa-gate-cond-pick"
              data-fa-action="gate-pick-cond" data-idx="${idx}" type="button">Pick</button>
      <input type="text" class="cond-value-input fa-gate-cond-input fa-gate-cond-text-input"
             ${attrs} data-field="text"
             value="${escAttr(cond.text ?? '')}"
             placeholder="Text or {{PARAM_NAME}}" />
      <input type="text" class="cond-value-input fa-gate-cond-test-value"
             data-fa-gate-helper="1" data-idx="${idx}"
             value="${escAttr(cond._verifyHelper ?? '')}"
             placeholder="param test value (used when text is {{PARAM}})"
             title="Authoring-only. When the text field is a {{PARAM}}, this literal substitutes for it at Verify time. Not saved with the fragment — runtime substitutes the actual bound value." />
      <button class="dbg-perspective-landmark-verify fa-gate-cond-verify"
              data-fa-action="gate-verify-text" data-idx="${idx}" type="button" ${verifyDisabled}>${verifyText}</button>`;
  } else if (t === 'attribute_equals') {
    valueHtml = `
      <div class="cond-attr-row">
        <input type="text" class="cond-value-input cond-value-narrow fa-gate-cond-input"
               ${attrs} data-field="selector"
               value="${escAttr(cond.selector ?? '')}" placeholder="CSS selector" />
        <input type="text" class="cond-value-input cond-value-narrow fa-gate-cond-input"
               ${attrs} data-field="attribute"
               value="${escAttr(cond.attribute ?? '')}" placeholder="attribute name" />
        <input type="text" class="cond-value-input fa-gate-cond-input"
               ${attrs} data-field="value"
               value="${escAttr(cond.value ?? '')}" placeholder="expected value" />
      </div>`;
  } else if (t === 'assertion_ref') {
    const meta = _groundAssertions.find(p => p.id === cond.assertionId)
              || _conditionDisplay.assertions.get(cond.assertionId);
    valueHtml = meta
      ? `<span class="cond-pred-hint" title="${escAttr(meta.name ?? meta.id)}">${escHtml(meta.description ?? '')}</span>`
      : (cond.assertionId
          ? `<span class="cond-pred-hint cond-pred-hint-stale">missing assertion: ${escHtml(cond.assertionId)}</span>`
          : `<span class="cond-pred-hint cond-pred-hint-empty">— pick an assertion from the dropdown —</span>`);
  } else if (t === 'perspective_ref') {
    const meta = _groundPerspectives.find(l => l.id === cond.perspectiveId)
              || _conditionDisplay.perspectives.get(cond.perspectiveId);
    valueHtml = meta
      ? `<span class="cond-pred-hint" title="${escAttr(meta.description ?? '')}">${escHtml(`${(meta.landmarks?.length ?? meta.landmarkCount ?? 0)} landmark${(meta.landmarks?.length ?? meta.landmarkCount ?? 0) === 1 ? '' : 's'}`)}</span>`
      : (cond.perspectiveId
          ? `<span class="cond-pred-hint cond-pred-hint-stale">missing perspective: ${escHtml(cond.perspectiveId)}</span>`
          : `<span class="cond-pred-hint cond-pred-hint-empty">— pick a perspective from the dropdown —</span>`);
  } else {
    valueHtml = `<span class="cond-pred-hint cond-pred-hint-empty">unsupported type: ${escHtml(t)}</span>`;
  }

  // v2.74.177 — Iframe badge. When the condition selector was picked
  // inside an iframe, show a small "↳ iframe" indicator so the author
  // sees that runtime AND verify will route into the iframe (not the
  // top document). Otherwise it'd look like a normal selector and the
  // "Element not found in top frame" failures would be mysterious.
  const frameBadgeHtml = (cond.frameUrl)
    ? `<span class="fa-gate-cond-frame-badge" title="${escAttr(cond.frameUrl)}">↳ iframe</span>`
    : '';

  // v2.74.180 — Helper row removed. The test-value input is now
  // rendered inline next to the text input (mirrors SELECT's pattern
  // at line 1727+), always visible regardless of whether text holds
  // a {{PARAM}}. No conditional rendering needed.

  // v2.74.172 — Verify status line for text_present. Sits between the
  // condition row and the negate row, shown only after a verify attempt.
  // Status classes (.status-ok / .status-err) provide green/red styling
  // matching the rest of the codebase.
  // v2.74.173 — Snippet of the picked section's visible text renders
  // on every outcome.
  // v2.74.174 — Phrasing reflects contains() semantics:
  //   ✓ Section text contains "X"
  //   ✗ Section text does not contain "X"
  // The "X" shown is the value actually searched (after {{PARAM}}
  // substitution to 'flying turtle' when the field is parameterized),
  // since that's what the verify call literally tested.
  // v2.74.175 — When the scoped element isn't found, the content
  // script returns the page-wide text as a fallback snippet so the
  // author still has visibility into what's on the page. Labeled
  // "page text (selector didn't match):" so the distinction from
  // a successful section read stays clear.
  let condStatusHtml = '';
  if (t === 'text_present' && cond._verified) {
    const v = cond._verified;
    if (v.error) {
      condStatusHtml = `<div class="fa-gate-cond-status status-err">✗ ${escHtml(v.error)}</div>`;
    } else {
      const searchedDisplay = `"${escHtml(v.searched ?? '')}"`;
      // v2.74.177 — Suffix the headline with the frame context when
      // the verify probed an iframe (or fell back to top because the
      // iframe disappeared). Top-frame picks get no suffix to keep
      // the headline tight for the common case.
      const frameSuffix = v.frameProbed && v.frameProbed !== 'top'
        ? ` <span class="fa-gate-cond-frame-suffix">[${escHtml(v.frameProbed)}]</span>`
        : '';
      const headline = v.success === true
        ? `<div class="fa-gate-cond-status status-ok">✓ Section text contains ${searchedDisplay}${frameSuffix}</div>`
        : (v.elementFound === false
            ? `<div class="fa-gate-cond-status status-err">✗ Element not found (selector: ${escHtml(cond.selector || '—')})${frameSuffix}</div>`
            : `<div class="fa-gate-cond-status status-err">✗ Section text does not contain ${searchedDisplay}${frameSuffix}</div>`);
      // v2.74.176 — Actionable hint when the selector missed: tell the
      // author whether their literal exists in page-wide visible text.
      // Lets them distinguish "fix the selector" from "fix the text."
      const hintHtml = (v.elementFound === false && v.pageContainsSearched === true)
        ? `<div class="fa-gate-cond-status-hint">…but ${searchedDisplay} IS visible elsewhere on the page — try widening the selector.</div>`
        : (v.elementFound === false && v.searched
            ? `<div class="fa-gate-cond-status-hint">${searchedDisplay} is not visible anywhere on the page.</div>`
            : '');
      const snippetLabel = v.snippetSource === 'page' && v.elementFound === false
        ? `page text (selector didn't match):`
        : (v.snippetSource === 'page' ? `page text:` : `section text:`);
      const snippetHtml = v.snippet
        ? `<div class="fa-gate-cond-status-snippet" title="${escAttr(v.snippet)}"><span class="fa-gate-cond-status-snippet-label">${escHtml(snippetLabel)}</span> ${escHtml(v.snippet)}</div>`
        : '';
      condStatusHtml = `${headline}${hintHtml}${snippetHtml}`;
    }
  }

  // Sub-action rows.
  const subActions = Array.isArray(a.body) ? a.body : [];
  const bodyHtml = subActions.length === 0
    ? `<div class="fa-chain-body-empty">No actions yet — click "+ Action" below.</div>`
    : subActions.map((sub, gIdx) => _renderGateSubAction(sub, idx, gIdx)).join('');

  return `
    <div class="dbg-perspective-landmark-row fa-action-row fa-action-gate-card" data-idx="${idx}">
      <div class="fa-action-head">
        <span class="strategy-step-handle fa-drag-handle" title="Drag to reorder" aria-label="Drag handle">⋮⋮</span>
        <span class="fa-order">${idx + 1}.</span>
        <span class="fa-action-head-label">GATE${negate ? ' <span class="fa-gate-negate-tag">(negated)</span>' : ''}</span>
        <span class="fa-action-head-spacer"></span>
        <button class="btn-action danger" data-fa-action="remove" data-idx="${idx}" title="Remove action gate" type="button">✕</button>
      </div>
      <div class="fa-action-body fa-gate-head-body">
        <div class="fa-gate-cond-row">
          <select class="cond-type-select fa-gate-cond-type"
                  data-fa-gate-cond="1" data-idx="${idx}" data-field="type">${typeOpts}</select>
          ${valueHtml}
          ${frameBadgeHtml}
        </div>
        ${condStatusHtml}
        <div class="fa-gate-negate-row">
          <label class="toggle-switch fa-action-toggle" title="When negate is on, the body runs when the condition is NOT met.">
            <input type="checkbox" data-fa-gate-negate="1" data-idx="${idx}" ${negate ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="fa-toggle-label">negate</span>
          </label>
          <span class="fa-gate-hint">${negate
            ? 'Body runs when the condition is NOT met.'
            : 'Body runs when the condition IS met.'}</span>
        </div>
        <!-- v2.74.201 — Wait-aware gate.
             v2.74.202 — Switched from <input type="number"> to text +
             inputmode="numeric" to drop the spinner buttons (visually
             distracting for a value that's almost always set via the
             chips below). Chips give one-click presets for the common
             cases — chat workflows want 30s, animation waits want 1s,
             etc. — without the user computing ms each time. -->
        <div class="fa-gate-wait-row" title="When set > 0, the condition is retried for up to this many milliseconds before deciding. Lets the gate wait for the right page state.">
          <span class="fa-gate-wait-label">wait up to</span>
          <input type="text" inputmode="numeric" pattern="[0-9]*"
                 class="fa-gate-wait-input"
                 data-fa-gate-wait="1" data-idx="${idx}"
                 value="${escAttr(String(a.waitTimeout ?? ''))}"
                 placeholder="0" />
          <span class="fa-gate-wait-suffix">ms (0 = check once)</span>
          <div class="fa-gate-wait-chips" data-idx="${idx}">
            <button class="fa-gate-wait-chip" data-fa-gate-wait-chip="500"   data-idx="${idx}" type="button" title="500ms — quick UI settle">500ms</button>
            <button class="fa-gate-wait-chip" data-fa-gate-wait-chip="1000"  data-idx="${idx}" type="button" title="1s — typical animation">1s</button>
            <button class="fa-gate-wait-chip" data-fa-gate-wait-chip="3000"  data-idx="${idx}" type="button" title="3s — page transitions">3s</button>
            <button class="fa-gate-wait-chip" data-fa-gate-wait-chip="10000" data-idx="${idx}" type="button" title="10s — network calls">10s</button>
            <button class="fa-gate-wait-chip" data-fa-gate-wait-chip="30000" data-idx="${idx}" type="button" title="30s — LLM streaming, long ops">30s</button>
            <button class="fa-gate-wait-chip" data-fa-gate-wait-chip="60000" data-idx="${idx}" type="button" title="60s — extended async ops">1m</button>
            <button class="fa-gate-wait-chip fa-gate-wait-chip-clear" data-fa-gate-wait-chip="0" data-idx="${idx}" type="button" title="Clear — gate becomes one-shot">clear</button>
          </div>
        </div>
      </div>
      <div class="fa-chain-body fa-gate-body">
        <div class="fa-chain-body-label">Actions (${subActions.length}) — run conditionally:</div>
        ${bodyHtml}
        <div class="fa-chain-add-branch-row fa-gate-add-row">
          <button class="btn-secondary fa-chain-add-branch-btn"
                  data-fa-action="gate-add-sub" data-idx="${idx}"
                  type="button">+ Action</button>
        </div>
      </div>
    </div>`;
}

// v2.74.156 — Sub-action row inside an Action gate. Slimmed-down
// version of _renderActionRow — supports the basic action types
// (CLICK, CLICK_BY_LABEL, TYPE, WAIT, WAIT_FOR, BLUR) without value
// helpers, smooth-scroll toggles, or other advanced extras. All
// elements carry `data-idx=parentIdx` AND `data-gate-idx=subIdx` so
// the resolveTarget lookup routes edits correctly.
function _renderGateSubAction(sub, parentIdx, gIdx) {
  // v2.74.181 — SELECT added to the gate body's allowed action types.
  // The runtime already routes any ACTION_TYPES member through
  // #executeStep; the schema validator already accepts SELECT in
  // body[]. The only thing missing was the authoring UI listing it.
  const GATE_ALLOWED_TYPES = ['CLICK', 'CLICK_BY_LABEL', 'TYPE', 'SELECT', 'WAIT', 'WAIT_FOR', 'WAIT_FOR_GONE', 'BLUR'];
  const type = GATE_ALLOWED_TYPES.includes(sub.action) ? sub.action : 'CLICK';
  const meta = ACTION_BY_TYPE[type] ?? ACTION_BY_TYPE['CLICK'];
  const showSelector = meta.selector !== 'hidden';
  const valueMeta = (typeof meta.value === 'object') ? meta.value : null;

  const v = sub.verified;
  const isVerifying = sub.verifying === true;
  const isVerified  = v?.success === true;

  let accentClass = 'fa-gate-sub-row';
  if (isVerifying)      accentClass += ` fa-action-row-verifying fa-action-row-${type.toLowerCase()}`;
  else if (isVerified)  accentClass += ` fa-action-row-verified  fa-action-row-${type.toLowerCase()}`;

  const dropdownOptions = GATE_ALLOWED_TYPES.map(opt =>
    `<option value="${opt}" ${type === opt ? 'selected' : ''}>${opt}</option>`
  ).join('');

  let verifyText = 'Verify';
  let verifyDisabled = '';
  if (isVerifying)     { verifyText = 'Verifying…'; verifyDisabled = 'disabled'; }
  else if (isVerified) { verifyText = 'Re-verify'; }

  const dataIds = `data-idx="${parentIdx}" data-gate-idx="${gIdx}"`;

  // Two-row layout matching the plain action row: dropdown + Pick on
  // row 1, selector + Verify on row 2, optional value full-width below.
  const row1 = `
    <div class="fa-action-row-1">
      <select class="fa-action-type" data-fa-field="action" ${dataIds}>${dropdownOptions}</select>
      <span class="fa-action-row-spacer"></span>
      ${showSelector
        ? `<button class="dbg-perspective-landmark-pick fa-action-pick" data-fa-action="pick" ${dataIds} type="button">Pick</button>`
        : ``}
    </div>`;
  const row2 = `
    <div class="fa-action-row-2">
      ${showSelector
        ? `<input type="text" class="dbg-perspective-landmark-selector fa-action-selector"
                  data-fa-field="selector" ${dataIds}
                  placeholder="CSS selector" value="${escAttr(sub.selector ?? '')}" />`
        : `<span class="fa-action-row-spacer"></span>`}
      <button class="dbg-perspective-landmark-verify fa-action-verify"
              data-fa-action="verify" ${dataIds} type="button" ${verifyDisabled}>${verifyText}</button>
    </div>`;
  // v2.74.181 — SELECT in a gate body renders its value + test-value
  // side-by-side, mirroring the top-level SELECT row (line 1746+).
  // The test-value substitutes for {{PARAM}} at verify time; runtime
  // uses the actual bound value, so it's authoring-only (stripped at
  // save, never persisted on the body sub-action).
  const valueRow = valueMeta ? (
    type === 'SELECT'
      ? `<div class="fa-action-value-row fa-action-value-row-select">
           <input type="text" class="fa-action-value" data-fa-field="value" ${dataIds}
                  placeholder="${escAttr(valueMeta.placeholder ?? 'value')}"
                  value="${escAttr(sub.value ?? '')}" />
           <input type="text" class="fa-action-test-value" data-fa-field="verify-helper" ${dataIds}
                  placeholder="param test value (e.g. Red)"
                  title="Authoring-only. When the value is a {{PARAM}}, this literal substitutes at verify time. Not saved with the fragment."
                  value="${escAttr(sub.verifyHelper ?? '')}" />
         </div>`
      : `<div class="fa-action-value-row">
           <input type="text" class="fa-action-value" data-fa-field="value" ${dataIds}
                  placeholder="${escAttr(valueMeta.placeholder ?? 'value')}"
                  value="${escAttr(sub.value ?? '')}" />
         </div>`
  ) : '';

  const statusHtml = (v && !v.success)
    ? `<div class="dbg-perspective-landmark-status status-err">✗ ${escHtml(v.error ?? 'failed')}</div>`
    : '';
  const footerHtml = statusHtml
    ? `<div class="fa-action-footer"><div class="fa-action-footer-status">${statusHtml}</div></div>`
    : '';

  return `
    <div class="${accentClass}" ${dataIds}>
      <div class="fa-action-head fa-gate-sub-head">
        <span class="fa-order fa-gate-sub-order">${gIdx + 1}.</span>
        <span class="fa-action-head-spacer"></span>
        <button class="btn-action danger" data-fa-action="gate-remove-sub" ${dataIds} title="Remove" type="button">✕</button>
      </div>
      <div class="fa-action-body">
        ${row1}
        ${row2}
        ${valueRow}
        ${_renderActionEffectIntel(sub, { idx: parentIdx, gateIdx: gIdx }, null)}
      </div>
      ${footerHtml}
    </div>`;
}

/**
 * Render a single branch sub-row inside a chain card.
 *
 * @param {number} actionIdx - Parent action index in _actions.
 * @param {number} bIdx      - Branch index in branches[].
 * @param {Object} b         - Branch object {label, action, selector, value, pickedLabel?, verified?}.
 */
function _renderChainBranch(actionIdx, bIdx, b) {
  const meta = ACTION_BY_TYPE[b.action] ?? ACTION_BY_TYPE['CLICK_BY_LABEL'];
  const showSelector = meta.selector !== 'hidden';
  const valueMeta = (typeof meta.value === 'object') ? meta.value : null;

  const isVerifying = b.verifying === true;
  const isVerified  = b.verified?.success === true;
  let rowClass = 'fa-chain-branch-row';
  if (isVerifying)     rowClass += ` fa-chain-branch-verifying fa-action-row-${b.action.toLowerCase()}`;
  else if (isVerified) rowClass += ` fa-chain-branch-verified  fa-action-row-${b.action.toLowerCase()}`;

  let verifyText = 'Verify';
  let verifyDisabled = '';
  if (isVerifying)     { verifyText = 'Verifying…'; verifyDisabled = 'disabled'; }
  else if (isVerified) { verifyText = 'Re-verify'; }

  const errorHtml = (b.verified && !b.verified.success)
    ? `<div class="dbg-perspective-landmark-status status-err">✗ ${escHtml(b.verified.error ?? 'failed')}</div>`
    : '';

  // Branch action-type indicator (read-only — set at add-time, not editable).
  // Authors who realize they picked the wrong type remove + re-add. Keeps
  // the form simple; type changes would invalidate selector + value anyway.
  const typeTagHtml = `<span class="fa-chain-branch-type-tag">${escHtml(b.action)}</span>`;

  // Label field — the layer-1 label this branch is keyed by.
  const labelFieldHtml = `
    <input type="text" class="fa-chain-branch-label-input" data-fa-field="branch-label" data-idx="${actionIdx}" data-branch-idx="${bIdx}"
           placeholder="for layer-1 label (e.g. Reports)" title="The layer-1 label this branch is keyed by"
           value="${escAttr(b.label ?? '')}" />`;

  // Selector + Pick + Verify row, mirroring main action row layout.
  const selectorRowHtml = showSelector ? `
    <div class="fa-chain-branch-row-selector">
      <input type="text" class="dbg-perspective-landmark-selector fa-action-selector" data-fa-field="selector" data-idx="${actionIdx}" data-branch-idx="${bIdx}"
             placeholder="${b.action === 'CLICK_BY_LABEL' ? 'layer-2 container CSS selector' : 'CSS selector'}"
             value="${escAttr(b.selector ?? '')}" />
      <button class="dbg-perspective-landmark-pick fa-action-pick" data-fa-action="pick" data-idx="${actionIdx}" data-branch-idx="${bIdx}" type="button">Pick</button>
    </div>` : '';

  // Value row.
  // v2.74.3 — CLICK_BY_LABEL branches no longer carry their own value; they
  // share the chain-level bodyValue. Only WAIT (ms) and WAIT_FOR (no value)
  // render their own value field. WAIT_FOR's valueMeta is null in
  // ACTION_BY_TYPE, so it naturally renders nothing here.
  const valueRowHtml = (valueMeta && b.action !== 'CLICK_BY_LABEL') ? `
    <div class="fa-chain-branch-row-value">
      <input type="text" class="fa-action-value" data-fa-field="value" data-idx="${actionIdx}" data-branch-idx="${bIdx}"
             placeholder="${escAttr(valueMeta.placeholder)}" title="${escAttr(valueMeta.label)}"
             value="${escAttr(b.value ?? '')}" />
    </div>` : '';

  // Verify row (always present — branches always have a verify button).
  const verifyRowHtml = `
    <div class="fa-chain-branch-row-verify">
      <span class="fa-action-row-spacer"></span>
      <button class="dbg-perspective-landmark-verify fa-action-verify" data-fa-action="verify" data-idx="${actionIdx}" data-branch-idx="${bIdx}" type="button" ${verifyDisabled}>${verifyText}</button>
    </div>`;

  return `
    <div class="${rowClass}" data-idx="${actionIdx}" data-branch-idx="${bIdx}">
      <div class="fa-chain-branch-head">
        ${typeTagHtml}
        ${labelFieldHtml}
        ${b.pickedLabel ? `<span class="fa-action-head-quote" title="picked label">"${escHtml(b.pickedLabel)}"</span>` : ''}
        <span class="fa-action-head-spacer"></span>
        <button class="btn-action danger" data-fa-action="remove-branch" data-idx="${actionIdx}" data-branch-idx="${bIdx}" title="Remove this branch" type="button">✕</button>
      </div>
      ${selectorRowHtml}
      ${valueRowHtml}
      ${verifyRowHtml}
      ${errorHtml}
      ${_renderActionEffectIntel(b, { idx: actionIdx, branchIdx: bIdx }, null)}
    </div>`;
}

/**
 * Add a new branch sub-row to a chain card.
 *
 * v2.74.3 — Per-branch `value` only retained for WAIT (milliseconds).
 *   - CLICK_BY_LABEL branches: layer-2 selection comes from the chain's
 *     bodyValue at runtime; branch carries no value field.
 *   - WAIT_FOR branches: their target is the selector; no value field.
 *   - WAIT branches: value holds the millisecond duration.
 *
 * @param {number} actionIdx
 * @param {'CLICK_BY_LABEL'|'WAIT'|'WAIT_FOR'} branchAction
 */
function _addChainBranch(actionIdx, branchAction) {
  const a = _actions[actionIdx];
  if (!a || !Array.isArray(a.branches)) return;
  // Pre-fill branch label from the head's last verify when available
  // (the literal label the head verified against). User edits if the
  // page-driven label differs from what was verified.
  const prefillLabel = (a.value ?? '').trim();
  const isParam = /^\{\{[A-Z0-9_]+\}\}$/.test(prefillLabel);
  const seed = (isParam || prefillLabel === '') ? '' : prefillLabel;
  const newBranch = {
    label: seed,
    action: branchAction,
    selector: '',
    pickedLabel: '',
    verified: null,
  };
  // Only WAIT branches carry their own value (milliseconds).
  if (branchAction === 'WAIT') {
    newBranch.value = '500';
  }
  a.branches.push(newBranch);
  _renderActions();
  _updateSaveState();
}

/**
 * Remove a branch sub-row from a chain card.
 *
 * @param {number} actionIdx
 * @param {number} bIdx
 */
function _removeChainBranch(actionIdx, bIdx) {
  const a = _actions[actionIdx];
  if (!a || !Array.isArray(a.branches)) return;
  if (bIdx === null || bIdx === undefined) return;
  if (!a.branches[bIdx]) return;
  a.branches.splice(bIdx, 1);
  _renderActions();
  _updateSaveState();
}

// v2.74.156 — Action-gate helpers.
//
// Append a new sub-action to a gate body. Default type is CLICK so the
// row renders with a selector + Pick + Verify on first show; author
// flips to other types via the dropdown. Same verified-clear convention
// as the parent + Action button (new rows arrive unverified).
function _addGateSubAction(actionIdx) {
  const a = _actions[actionIdx];
  if (!a || a.action !== 'ACTION_GATE') return;
  if (!Array.isArray(a.body)) a.body = [];
  a.body.push({
    id: uid(),
    action: 'CLICK',
    selector: '',
    value: '',
    pickedLabel: '',
    verified: null,
  });
  _renderActions();
  _updateSaveState();
}

// Remove a sub-action from a gate body. Mirrors _removeChainBranch.
function _removeGateSubAction(actionIdx, gIdx) {
  const a = _actions[actionIdx];
  if (!a || a.action !== 'ACTION_GATE' || !Array.isArray(a.body)) return;
  if (gIdx === null || gIdx === undefined) return;
  if (!a.body[gIdx]) return;
  a.body.splice(gIdx, 1);
  _renderActions();
  _updateSaveState();
}

// Start a picker session targeting the GATE HEADER condition's selector
// field (not a sub-action's selector). The PICK_RESULT handler reads
// `condPick: true` on the picker session and writes selector to
// _actions[actionIdx].condition.selector.
async function _startGateCondPick(actionIdx) {
  const a = _actions[actionIdx];
  if (!a || a.action !== 'ACTION_GATE') return;
  if (_pickerSession) await _cancelPick(true);
  if (_tabId == null) {
    _showWarning('No active tab. Cancel and start over.');
    return;
  }
  const sessionId = `fa_pick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _pickerSession = { sessionId, actionIdx, branchIdx: null, gateIdx: null, condPick: true };
  // v2.74.166 — Frame-aware broadcast (same as the regular pick path).
  const startRes = await broadcastStartPick(_tabId, {
    sessionId, mode: 'target', containerSelector: '', multiCandidate: false, labelMode: 'single',
  });
  if (!startRes.success) {
    _pickerSession = null;
    _showWarning(`Pick failed: ${startRes.error}`);
    return;
  }
  if (pickBannerEl) pickBannerEl.classList.remove('hidden');
}

/**
 * v2.74.172 — Verify a gate's text_present condition against the live
 * page. Sends CHECK_CONDITION to the content script with the same
 * scoped-text semantics that runtime uses; stashes the result on
 * `condition._verified` so the row's status line can render ✓/✗ +
 * snippet. The `_verified` field is transient (cleared on input edit
 * or re-pick, stripped at save) so a stale verification can't bleed
 * into the persisted fragment.
 *
 * Parameter handling: any `{{PARAM}}` tokens in `text` or `selector`
 * are substituted with the sentinel 'flying turtle' before sending,
 * matching the convention used by `_verifyAction`. Users authoring
 * literal text get an authentic check; parameterized text gets a
 * sentinel-driven sanity check (selector + text-present plumbing
 * works, runtime substitution will swap the real value in).
 */
async function _verifyGateTextPresent(actionIdx) {
  const a = _actions[actionIdx];
  if (!a || a.action !== 'ACTION_GATE') return;
  const cond = a.condition;
  if (!cond || cond.type !== 'text_present') return;
  if (_tabId == null) {
    _showWarning('No active tab. Cancel and start over.');
    return;
  }
  const textRaw = (cond.text ?? '').toString();
  if (!textRaw.trim()) {
    cond._verified = { success: false, error: 'Enter text to look for, then click Verify' };
    _renderActions();
    return;
  }

  // v2.74.178 — Two-stage substitution for the text field:
  //   1. If the text contains {{PARAM}} AND the author provided a
  //      "verify with:" literal helper, substitute the helper for
  //      every {{PARAM}} token. This gives a realistic contains()
  //      check matching what runtime would do once bindings are
  //      supplied.
  //   2. Otherwise (no helper, or no param), fall back to the
  //      'flying turtle' sentinel via _substituteParams — same
  //      behavior as _verifyAction for parameterized values without
  //      a helper. Validates structure; won't match real text.
  // The selector field uses the regular _substituteParams path —
  // selectors with {{PARAM}} are rare, and there's no UI for a
  // per-field helper yet.
  const textHasParamProbe = /\{\{[A-Z0-9_]+\}\}/.test(textRaw);
  const helperLiteral = (cond._verifyHelper ?? '').toString();
  let probeText;
  if (textHasParamProbe && helperLiteral.trim()) {
    probeText = textRaw.replace(/\{\{[A-Z0-9_]+\}\}/g, helperLiteral);
  } else {
    probeText = _substituteParams(textRaw);
  }
  const probeCond = {
    type: 'text_present',
    text: probeText,
    selector: _substituteParams((cond.selector ?? '').toString()),
  };

  cond._verifying = true;
  delete cond._verified;
  _renderActions();

  // v2.74.177 — Resolve the target frameId. When the picker captured
  // an iframe selector, condition.frameUrl carries the iframe's URL;
  // the gate's verify must run inside that same frame or the
  // selector will resolve against the top document (which doesn't
  // contain the iframe's DOM) and the verify reports "element not
  // found" even though the page is structured correctly. Falls back
  // to top frame when no frameUrl is set (legacy / top-frame picks).
  let targetFrameId = 0;
  let frameResolveNote = '';
  if (cond.frameUrl) {
    try {
      const frames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId: _tabId }, (fs) => resolve(fs ?? []));
      });
      const exact = frames.find(f => f && f.url === cond.frameUrl);
      if (exact) {
        targetFrameId = exact.frameId;
      } else {
        // Origin fallback — the iframe may have navigated within the
        // same site (URL changed, origin stable). Mirrors the runtime
        // resolver in TemplateWalker._resolveFrameId.
        let savedOrigin = null;
        try { savedOrigin = new URL(cond.frameUrl).origin; } catch {}
        if (savedOrigin) {
          const om = frames.find(f => {
            if (!f?.url) return false;
            try { return new URL(f.url).origin === savedOrigin; } catch { return false; }
          });
          if (om) {
            targetFrameId = om.frameId;
            frameResolveNote = ' (matched by origin)';
          } else {
            frameResolveNote = ' (iframe gone — checked top frame instead)';
          }
        } else {
          frameResolveNote = ' (iframe gone — checked top frame instead)';
        }
      }
    } catch (e) {
      frameResolveNote = ` (frame lookup failed: ${e?.message ?? e})`;
    }
  }

  let res;
  try {
    res = await chrome.tabs.sendMessage(_tabId, {
      type: 'CHECK_CONDITION',
      payload: { condition: probeCond },
    }, { frameId: targetFrameId });
  } catch (e) {
    cond._verifying = false;
    cond._verified = { success: false, error: `Verify failed: ${e?.message ?? String(e)}${frameResolveNote}` };
    _renderActions();
    return;
  }

  cond._verifying = false;
  // v2.74.174 — Persist the searched-for value (post-substitution) on
  // the verify result so the status line can render the literal
  // contains() check: "Section text contains 'X'" / "...does not
  // contain 'X'". When the user used a {{PARAM}} placeholder, X is
  // the sentinel 'flying turtle' that actually got searched.
  // v2.74.175 — Also persist `snippetSource` ('section' vs 'page') so
  // the snippet label can distinguish "section text" from the page-
  // wide fallback the content script returns when the selector
  // doesn't match anything.
  const searched = probeCond.text;
  const snippetSource = res?.snippetSource ?? null;
  // v2.74.177 — Surface which frame was actually probed so the status
  // line can show "(in iframe)" when relevant, and downgrade to top
  // frame is visible to the author.
  const frameProbed = cond.frameUrl
    ? (targetFrameId === 0 ? 'top (iframe gone)' : `iframe`)
    : 'top';
  if (res?.error) {
    cond._verified = { success: false, error: res.error, searched, frameProbed };
  } else if (res?.matched === true) {
    cond._verified = { success: true, snippet: res.snippet ?? '', searched, snippetSource, frameProbed };
  } else {
    cond._verified = {
      success: false,
      elementFound: res?.elementFound !== false,
      snippet: res?.snippet ?? '',
      searched,
      snippetSource,
      pageContainsSearched: res?.pageContainsSearched === true,
      frameProbed,
    };
  }
  _renderActions();
  _updateSaveState();
}

// ─── Mutate (remove / insert; reorder lives inline in drag-and-drop) ──────

function _removeAction(idx) {
  _actions.splice(idx, 1);
  // v2.72.75 — Position-aware invalidation. Same downward-flow rule:
  // actions BEFORE the removed index stay verified (they ran
  // independently of what followed). Actions AT or AFTER (the rows
  // that just shifted down to fill the gap) are invalidated because
  // the sequence between them and any earlier action changed.
  for (let i = idx; i < _actions.length; i++) {
    _actions[i].verified = null;
  }
  _renderActions();
  _updateSaveState();
}

/**
 * v2.72.65 — Insert a new WAIT action at position `idx`. Existing
 * actions from idx onward shift down by one. Position-aware
 * invalidation: actions BEFORE the insertion point keep their verified
 * state (they ran without the new wait, which doesn't affect them);
 * actions AT and AFTER the insertion point lose verified state because
 * timing changes for them.
 *
 * Refuses to insert if the fragment is at the action cap.
 */
function _insertWaitAt(idx) {
  if (!_fragmentCapUnlimited && _actions.length >= _fragmentCap) {
    toast(`Fragment cap reached (${_fragmentCap}). Remove an action first, or set unlimited in Settings.`, 'warn');
    return;
  }
  const newAction = {
    id: uid(),
    action: 'WAIT',
    selector: '',
    value: '',           // user fills milliseconds
    verified: null,
  };
  _actions.splice(idx, 0, newAction);
  // Position-aware invalidation: only actions AT or AFTER the insertion
  // point are invalidated. The unchanged earlier actions keep their
  // verified state.
  for (let i = idx; i < _actions.length; i++) {
    _actions[i].verified = null;
  }
  _renderActions();
  _updateSaveState();
}

// ─── Pick ─────────────────────────────────────────────────────────────────

/**
 * Begin a picker session against the live tab.
 *
 * @param {number} actionIdx - Index in _actions of the row being picked.
 * @param {number|null} branchIdx - When set, the pick targets a chain
 *     card's body sub-row at _actions[actionIdx].branches[branchIdx]
 *     instead of the row itself. v2.74.0.
 */
async function _startPick(actionIdx, branchIdx = null, gateIdx = null) {
  if (!_actions[actionIdx]) return;
  // v2.74.0 — When picking inside a chain branch, validate the branch
  // index points at a real entry. Defensive — UI shouldn't fire pick
  // for a branch that doesn't exist.
  if (branchIdx !== null) {
    const branches = _actions[actionIdx].branches;
    if (!Array.isArray(branches) || !branches[branchIdx]) return;
  }
  // v2.74.156 — Same defensive check for gate sub-actions.
  if (gateIdx !== null) {
    const body = _actions[actionIdx].body;
    if (!Array.isArray(body) || !body[gateIdx]) return;
  }
  if (_pickerSession) await _cancelPick(true);
  if (_tabId == null) {
    _showWarning('No active tab. Cancel and start over.');
    return;
  }

  const sessionId = `fa_pick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _pickerSession = { sessionId, actionIdx, branchIdx, gateIdx };

  // v2.72.93 — CLICK_BY_LABEL containers get container-mode label
  // extraction: instead of returning the concatenated textContent (e.g.
  // "natureflowersbackground..."), the picker walks the same priority
  // groups as the runtime matcher and returns a comma-separated list of
  // option labels (e.g. "nature, flowers, background, ..."). Other
  // actions use single-element label extraction (the existing behavior).
  // v2.74.0 — Chain card head and CLICK_BY_LABEL branch sub-rows both
  // use container-mode (both ARE containers by the chain's design).
  // WAIT and WAIT_FOR branches use single-mode (selector points at one
  // settle target).
  const action = _actions[actionIdx];
  const branch  = (branchIdx !== null) ? action.branches?.[branchIdx] : null;
  const gateSub = (gateIdx   !== null) ? action.body?.[gateIdx]       : null;
  const targetActionType = gateSub ? gateSub.action
                         : branch  ? branch.action
                         : action.action;
  const labelMode = targetActionType === 'CLICK_BY_LABEL' ? 'container' : 'single';

  // v2.74.166 — Centralized through broadcastStartPick. Top frame's
  // response is the canonical pass/fail; iframe arming happens
  // asynchronously. Same helper used by observation-author and
  // perspective-capture so every picker is frame-aware.
  const startRes = await broadcastStartPick(_tabId, {
    sessionId, mode: 'target', containerSelector: '', multiCandidate: false, labelMode,
  });
  if (!startRes.success) {
    _pickerSession = null;
    _showWarning(`Pick failed: ${startRes.error}`);
    return;
  }
  if (pickBannerEl) pickBannerEl.classList.remove('hidden');
}

async function _cancelPick(notifyContentScript) {
  if (!_pickerSession) return;
  const session = _pickerSession;
  _pickerSession = null;
  if (pickBannerEl) pickBannerEl.classList.add('hidden');
  if (notifyContentScript && _tabId != null) {
    // v2.74.166 — Broadcast to every frame so iframe pickers tear down
    // alongside the top frame. Otherwise a stale iframe click after
    // cancel could pollute the next session.
    await broadcastCancelPick(_tabId, { sessionId: session.sessionId });
  }
}

// ─── v2.74.236 — Landmark ref (fragment actions, Wave 3) ──────────────────
//
// Authors can either type a selector inline (legacy path) or pick a
// landmark from the ground's perspectives (SSOT path). When a landmark is
// chosen, action.landmarkRef carries {perspectiveId, role}; action.selector
// and action.frameUrl are populated from the landmark for verify-time
// + display, and the inline selector input becomes read-only. The
// runtime (TemplateWalker.#executeStep) re-resolves the ref at
// dispatch time so the latest landmark selector is always used.
//
// Clearing the ref switches back to inline editing — landmarkRef is
// dropped, selector remains as-is (the author can edit, repick, or
// run Ask Claude).

function _applyActionLandmarkRef(actionIdx, perspectiveId, alias) {
  // v2.74.275 — Renamed second param `role` → `alias`. landmarkRef
  // now writes { uid } (canonical) instead of legacy { perspectiveId, role }.
  const a = _actions[actionIdx];
  if (!a) return;
  const perspective = _groundPerspectives.find(l => l.id === perspectiveId);
  if (!perspective) {
    _showWarning(`Landmark ref failed: perspective "${perspectiveId}" not in this ground`);
    return;
  }
  const lm = (perspective.landmarks ?? []).find(l => l.alias === alias);
  if (!lm) {
    _showWarning(`Landmark ref failed: alias "${alias}" not in perspective "${perspective.name}"`);
    return;
  }
  if (!lm.uid) {
    _showWarning(`Landmark ref failed: "${alias}" in perspective "${perspective.name}" has no uid (not yet persisted to registry)`);
    return;
  }
  a.landmarkRef = { uid: lm.uid };
  // Populate selector + frameUrl from the landmark for verify-time
  // and display. Runtime re-resolves anyway, but having these set
  // means Verify can run without an extra round-trip and the UI
  // shows the actual selector being used.
  a.selector = lm.selector;
  if (lm.frameUrl) a.frameUrl = lm.frameUrl;
  else delete a.frameUrl;
  // v2.74.306 — Phase 2 of ACTION_SPEC compliance. Seed the action's
  // effect + interactionPattern from the linked landmark. The spec
  // (§ 5) puts effect on the Action record, not the Landmark — the
  // landmark provides a default PROPOSAL that the author can override
  // per-action. This lets two different fragments use the same
  // landmark with different declared effects when the click context
  // genuinely differs (e.g., a "Save" button that triggers-navigation
  // in one fragment vs. submits-in-place in another).
  //
  // Effect is only seeded when the action doesn't already carry one.
  // Re-linking the landmark on an already-customized action preserves
  // the author's override. Clearing the landmark ref (in
  // _clearActionLandmarkRef) leaves action.effect as-is — same model
  // as a.selector after un-link.
  if (lm.effect && !a.effect) {
    a.effect = { ...lm.effect };
  }
  if (lm.interactionPattern && !a.interactionPattern) {
    a.interactionPattern = lm.interactionPattern;
  }
  delete a.verified;
  delete a.verifying;
  _renderActions();
  _updateSaveState();
}

// v2.74.312/313 — Reconcile a verify-time effect drift. Sets the
// target action's (or branch's / gate-sub's) declared effect to the
// value observed during Verify. Per ACTION_SPEC § 5 the effect lives
// on the Action, so this writes target.effect directly (does NOT touch
// the linked landmark's default).
function _reconcileActionEffect(idx, branchIdx, gateIdx, observedJson) {
  const target = _resolveActionTarget(idx, branchIdx, gateIdx);
  if (!target || !observedJson) return;
  let observed;
  try { observed = JSON.parse(observedJson); } catch { return; }
  if (!observed || typeof observed !== 'object' || !observed.kind) return;
  const next = { kind: observed.kind };
  if (observed.kind === 'opens-new-thread') next.form = observed.form ?? 'tab';
  if (observed.kind === 'triggers-modal')   next.modalKind = observed.modalKind ?? 'confirm';
  target.effect = next;
  if (target.verified?.effectObservation) {
    target.verified.effectObservation = {
      ...target.verified.effectObservation,
      declaredEffect: next,
      severity: null,
    };
  }
  _renderActions();
  _updateSaveState();
}

// v2.74.313 — Inline effect-editor change handlers. Each resolves the
// target via data-attrs and mutates target.effect / interactionPattern.
// Changing the declared effect invalidates the verify-time observation
// comparison (the observed value was compared against the OLD declared),
// so we clear the stored observation's severity to avoid a stale "drift"
// flag — re-Verify recomputes it.
function _effectRouteFromEl(el) {
  const idx = parseInt(el.dataset.idx, 10);
  const bRaw = el.dataset.branchIdx;
  const gRaw = el.dataset.gateIdx;
  return {
    idx,
    branchIdx: bRaw !== undefined ? parseInt(bRaw, 10) : null,
    gateIdx:   gRaw !== undefined ? parseInt(gRaw, 10) : null,
  };
}

function _clearEffectObsSeverity(target) {
  if (target.verified?.effectObservation) {
    target.verified.effectObservation = { ...target.verified.effectObservation, severity: null, observable: false };
  }
}

function _onEffectKindChange(el) {
  const { idx, branchIdx, gateIdx } = _effectRouteFromEl(el);
  const target = _resolveActionTarget(idx, branchIdx, gateIdx);
  if (!target) return;
  const kind = el.value;
  if (kind === 'opens-new-thread') {
    target.effect = { kind, form: target.effect?.form ?? 'tab' };
  } else if (kind === 'triggers-modal') {
    target.effect = { kind, modalKind: target.effect?.modalKind ?? 'confirm' };
  } else {
    target.effect = { kind };
  }
  target.effectSource = 'authored';
  _clearEffectObsSeverity(target);
  _renderActions();      // re-render to show/hide the param select
  _updateSaveState();
}

function _onEffectParamChange(el, paramKey) {
  const { idx, branchIdx, gateIdx } = _effectRouteFromEl(el);
  const target = _resolveActionTarget(idx, branchIdx, gateIdx);
  if (!target?.effect) return;
  target.effect = { ...target.effect, [paramKey]: el.value };
  target.effectSource = 'authored';
  _clearEffectObsSeverity(target);
  _updateSaveState();
}

function _onEffectPatternChange(el) {
  const { idx, branchIdx, gateIdx } = _effectRouteFromEl(el);
  const target = _resolveActionTarget(idx, branchIdx, gateIdx);
  if (!target) return;
  target.interactionPattern = el.value;
  target.effectSource = 'authored';
  _updateSaveState();
}

// v2.74.315 — KEY value row handlers. The dropdown is the literal key
// when no param is set, OR the verify-time literal when a param is set.
function _onKeySelectChange(el) {
  const idx = parseInt(el.dataset.idx, 10);
  const a = _actions[idx];
  if (!a) return;
  const key = el.value;
  const hasParam = /^\{\{[A-Z0-9_]+\}\}$/.test((a.value ?? '').toString());
  if (hasParam) {
    // Param-mode: dropdown sets the verify-time literal.
    a.verifyHelper = key;
  } else {
    // Literal-mode: dropdown IS the value.
    a.value = key;
  }
  a.verified = null;   // key changed → re-verify
  _renderActions();
  _updateSaveState();
}

function _onKeyParamInput(el) {
  const idx = parseInt(el.dataset.idx, 10);
  const a = _actions[idx];
  if (!a) return;
  // Normalize to UPPER_SNAKE_CASE — matches the {{PARAM}} token grammar.
  const param = el.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  // The dropdown's current selection — preserved as the verify literal
  // when switching to param-mode. Read it from the rendered select.
  const sel = el.closest('.fa-key-value-row')?.querySelector('select[data-fa-action="key-select"]');
  const dropdownKey = sel?.value || a.verifyHelper || (/^\{\{/.test(a.value ?? '') ? 'Enter' : (a.value || 'Enter'));
  if (param) {
    a.value = `{{${param}}}`;
    a.verifyHelper = dropdownKey;   // verify-time literal
  } else {
    // Param cleared → revert to the literal key from the dropdown.
    a.value = dropdownKey;
    a.verifyHelper = '';
  }
  a.verified = null;
  // Re-render so the dropdown label flips between "key:" and "verify with:".
  // Preserve focus + caret on the param input across the rebuild.
  const caret = el.selectionStart ?? el.value.length;
  _renderActions();
  const next = actionsListEl?.querySelector(`input[data-fa-action="key-param"][data-idx="${idx}"]`);
  if (next) { next.focus(); try { next.setSelectionRange(caret, caret); } catch { /* fine */ } }
  _updateSaveState();
}

// v2.74.316 — KEY repeat-count handler (number input + preset chips).
// Clamps to 1–50. fromPreset re-renders (to update active chip + input);
// the number input re-renders only when crossing the 1↔>1 boundary to
// avoid losing caret on every keystroke.
function _onKeyRepeatChange(el, rawVal, fromPreset = false) {
  const idx = parseInt(el.dataset.idx, 10);
  const a = _actions[idx];
  if (!a) return;
  const prev = Math.max(1, parseInt(a.repeat, 10) || 1);
  let n = parseInt(rawVal, 10);
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > 50) n = 50;
  a.repeat = n;
  a.verified = null;
  // Re-render on preset click (chip active state) or when the >1 status
  // flips (the input itself doesn't need a rebuild for in-place edits).
  if (fromPreset || (prev > 1) !== (n > 1)) {
    _renderActions();
  }
  _updateSaveState();
}

function _clearActionLandmarkRef(actionIdx) {
  const a = _actions[actionIdx];
  if (!a) return;
  delete a.landmarkRef;
  // selector + frameUrl stay — they were the landmark's values, now
  // they're the inline starting point the author can edit. Verify
  // state stays too — the same selector still verifies even though
  // it's no longer ref-backed.
  _renderActions();
  _updateSaveState();
}

// ─── Verify ───────────────────────────────────────────────────────────────

async function _verifyAction(actionIdx, branchIdx = null, gateIdx = null) {
  const a = _actions[actionIdx];
  if (!a) return;
  // v2.74.0 — When verifying a chain branch, work against branch fields
  // instead of the row itself. Author manually drives the page to
  // whatever pre-state the branch needs (the layer-2 menu being open
  // under a specific layer-1 click); verify just runs the branch's
  // single action against that state. Same pattern as today's per-row
  // verify — page-state is the author's responsibility.
  // v2.74.156 — Gate sub-actions: target the body sub-action. The
  // header condition is NOT verified here — runtime evaluates it on
  // the live page (same model as pre/postconditions).
  const isBranch  = (branchIdx !== null && branchIdx !== undefined);
  const isGateSub = (gateIdx   !== null && gateIdx   !== undefined);
  const target = isGateSub ? a.body?.[gateIdx]
              : isBranch   ? a.branches?.[branchIdx]
              : a;
  if (!target) return;
  const meta = ACTION_BY_TYPE[target.action];
  if (!meta) return;
  if (_tabId == null) {
    _showWarning('No active tab. Cancel and start over.');
    return;
  }

  // v2.74.3 — For CLICK_BY_LABEL branches, the value comes from the
  // chain's bodyValue (the chain-wide layer-2 selection slot). Read it
  // here so validation, substitution, and the verify call all use the
  // same source. WAIT branches still use their own value (milliseconds);
  // WAIT_FOR has no value field at all.
  const isCblBranch = isBranch && target.action === 'CLICK_BY_LABEL';
  const valueSource = isCblBranch ? (a.bodyValue ?? '') : (target.value ?? '');

  // Pre-flight validation matching the schema rules.
  if (meta.selector === 'required' && !target.selector?.trim()) {
    target.verified = { success: false, error: 'Selector required' };
    _renderActions();
    _updateSaveState();
    return;
  }
  const valueMeta = (typeof meta.value === 'object') ? meta.value : null;
  if (valueMeta && !valueSource.toString().trim()) {
    const errMsg = isCblBranch
      ? 'Chain layer-2 value required (set the "layer-2:" field above)'
      : `${valueMeta.label} required`;
    target.verified = { success: false, error: errMsg };
    _renderActions();
    _updateSaveState();
    return;
  }

  // Clear warning before verify.
  _hideWarning();

  // v2.72.80 — Mark in-progress and re-render so the row shows the
  // verifying accent + button reads "Verifying…". Cleared at the end
  // (success or fail) when the result is rendered.
  target.verifying = true;
  _renderActions();

  // v2.72.62 — Substitute {{PARAM}} tokens with 'flying turtle' for the
  // verify-time test execution. The saved rawJson preserves the tokens;
  // at runtime, the engine substitutes user-provided bindings. This lets
  // the user verify a parameterized action without binding values.
  const verifySelector = _substituteParams(target.selector ?? '');
  let verifyValue      = _substituteParams(valueSource);

  // v2.72.91 — CLICK_BY_LABEL with parameterized value can't match a
  // real option using "flying turtle". Detect that case (raw value
  // contained a {{PARAM}} token) and replace with sentinel that the
  // content script handles by clicking the first option in the
  // container — validates structure, defers semantic match to runtime.
  // v2.74.7 — When verifying a chain HEAD (not a branch) with a
  // parameterized value AND the author has typed a literal label into
  // the verify-helper field, prefer that literal over __VERIFY_FIRST__.
  // The verify click then drives the page to the SPECIFIC layer-1 path,
  // opening that path's layer-2 menu so the author can capture matching
  // branch selectors. Without this, every verify clicks the first option
  // regardless of which branch the author wants to capture next.
  // v2.74.12 — Generalized to all actions with a parameterized value.
  // TYPE and SELECT also accept a verify-helper now, so the author can
  // provide a realistic value for verify (instead of 'flying turtle' for
  // TYPE or a likely-no-match probe for SELECT). Only CLICK_BY_LABEL
  // additionally falls back to __VERIFY_FIRST__ when no helper is set;
  // TYPE and SELECT have no equivalent sentinel (they just type/select
  // the substituted placeholder, which is fine for selector validation).
  const valueHasParam = /\{\{[A-Z0-9_]+\}\}/.test(valueSource);
  if (valueHasParam) {
    // Verify-helper applies to plain action rows AND chain heads. Branch
    // sub-rows (isBranch=true) don't have their own helper field — they
    // share the chain's bodyValue, which has its own substitution path.
    // v2.74.181 — Gate sub-actions own their own helper field (the test-
    // value input next to SELECT's value). Read from target, not the
    // parent ACTION_GATE — the parent's verifyHelper is unused for gate
    // bodies; the helper belongs to the body sub-action that the
    // verify is exercising.
    const helperEligible = !isBranch;
    const helperSource = isGateSub ? target : a;
    const helperLiteral = helperEligible ? (helperSource.verifyHelper ?? '').trim() : '';
    if (helperLiteral) {
      verifyValue = helperLiteral;
    } else if (target.action === 'CLICK_BY_LABEL') {
      // No helper, CLICK_BY_LABEL: fall back to first-option sentinel.
      verifyValue = '__VERIFY_FIRST__';
    }
    // No helper, TYPE/SELECT: leave verifyValue as the _substituteParams
    // output (a 'flying turtle' style placeholder) — that's the existing
    // behavior, validates structure without realistic semantic effect.
  }

  let res;
  try {
    res = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'EXECUTE_AUTHORING_STEP',
        payload: {
          tabId: _tabId,
          step: {
            action: target.action,
            selector: verifySelector,
            value: verifyValue,
            smoothScroll: target.smoothScroll === true,
            // v2.74.316 — KEY repeat count for verify dispatch.
            repeat: target.repeat,
            // v2.74.312 — Pass the declared effect so background can
            // compare it against what it observes during the Verify
            // dispatch (verify-time drift detection).
            effect: target.effect ?? null,
            // v2.74.163 — Carry the action's frame qualifier through to
            // background. Background's handler resolves the current
            // frameId from this URL (via TemplateWalker._resolveFrameId)
            // and dispatches EXECUTE_STEP / WAIT_FOR_ELEM / etc. into
            // that frame. Top-frame actions have no frameUrl and dispatch
            // to TOP_FRAME_ID as before.
            frameUrl: target.frameUrl ?? null,
          },
        },
      }, resolve);
    });
  } catch (e) {
    target.verifying = false;
    target.verified = { success: false, error: e.message };
    _renderActions();
    _updateSaveState();
    return;
  }

  target.verifying = false;
  if (res?.success) {
    target.verified = {
      success: true,
      info: res.info ?? null,
      verifiedAt: Date.now(),
      // v2.74.312 — Verify-time effect observation result (CLICK/
      // CLICK_BY_LABEL only; other actions don't carry it). Drives the
      // observed-vs-declared display + reconcile button in the intel
      // strip.
      effectObservation: res.effectObservation ?? null,
    };
    // v2.72.72 — Postconditions are save-time-only now. Don't recapture
    // here. The previous live-update behavior made postconditions look
    // like preconditions during authoring (because the page settles fresh
    // each Verify). Capture happens once in _onSaveClick.
  } else {
    target.verified = { success: false, error: res?.error ?? 'unknown error' };
  }
  _renderActions();
  _updateSaveState();
}

// ─── v2.74.22 — Antecedent + Run sub-card ─────────────────────────────────
//
// Mounted under the header. Lets the author pick an antecedent fragment
// from this Ground and run it to drive the page into the right state.
// Disabled once any action has been authored (changing the antecedent
// after the fact would invalidate already-verified actions). The
// selection updates _payload.antecedentFragmentId so:
//   - _capturePreconditions inherits from the newly-chosen antecedent
//   - _onSaveClick persists the chosen link on the saved record

async function _populateAntecedentDropdown() {
  if (!anteSelectEl || !_payload?.groundId) return;
  let res;
  try {
    res = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'LIST_FRAGMENTS_FOR_GROUND',
        payload: { groundId: _payload.groundId, excludeId: _payload.fragmentId },
      }, resolve);
    });
  } catch (e) {
    console.warn('[fragment-author] LIST_FRAGMENTS_FOR_GROUND threw:', e?.message);
    return;
  }
  if (!res?.success) return;
  const fragments = Array.isArray(res.fragments) ? res.fragments : [];
  _anteFragments = fragments;   // cache for param-row resolution
  // Rebuild options. "— none —" first; then each fragment by id.
  anteSelectEl.innerHTML = '<option value="">— none —</option>';
  for (const f of fragments) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name ?? 'Unnamed';
    anteSelectEl.appendChild(opt);
  }
  // Restore the current antecedent if one was passed in via payload
  // (re-walk case, or chain-resume after save).
  const current = _payload.antecedentFragmentId ?? '';
  if (current && fragments.some(f => f.id === current)) {
    anteSelectEl.value = current;
  }
  // Pre-fill the param input from any pre-existing bindings (re-walk).
  _refreshAntecedentParamsRow();
  _renderAntecedentToggle();
  _updateAntecedentCardEnabled();
}

function _onAntecedentChange() {
  if (!_payload || !anteSelectEl) return;
  const next = anteSelectEl.value || null;
  _payload.antecedentFragmentId = next;
  // Clearing antecedent also clears its param bindings (they keyed off
  // the previous fragment's params).
  if (!next) _payload.antecedentParamBindings = null;
  if (anteStatusEl) anteStatusEl.textContent = '';
  // v2.74.23 — Reset the params input on selection change. Each
  // antecedent has its own param shape; carrying over values from the
  // previous selection would silently misbind.
  if (anteParamsInputEl) anteParamsInputEl.value = '';
  // v2.74.23 — Selection change re-arms the button as a fresh Run.
  // (The previous antecedent may have flipped it to undo mode; once
  // the user picks a different antecedent, the undo target no longer
  // matches what's on screen.)
  _setAntecedentRunMode('run');
  _refreshAntecedentParamsRow();
  _renderAntecedentToggle();
  _updateAntecedentCardEnabled();
}

/**
 * v2.74.23 — Show / hide the params input row based on the chosen
 * antecedent's params declaration. The input is free-text comma-
 * separated; the order-label row beneath shows the param names so
 * the user knows which slot maps to which.
 */
function _refreshAntecedentParamsRow() {
  if (!anteParamsWrapEl || !anteParamsOrderEl || !anteSelectEl) return;
  const id = anteSelectEl.value || '';
  const f = _anteFragments.find(x => x.id === id);
  const params = (f && Array.isArray(f.params)) ? f.params : [];
  if (params.length === 0) {
    anteParamsWrapEl.classList.add('hidden');
    anteParamsOrderEl.classList.add('hidden');
    anteParamsOrderEl.textContent = '';
    return;
  }
  anteParamsWrapEl.classList.remove('hidden');
  anteParamsOrderEl.classList.remove('hidden');
  anteParamsOrderEl.textContent = `Order: ${params.join(', ')}`;
}

async function _onAntecedentRunClick() {
  if (!_payload || !anteSelectEl) return;
  if (_anteRunMode === 'undo') {
    return _onAntecedentUndoClick();
  }
  const antecedentFragmentId = anteSelectEl.value || null;
  if (!antecedentFragmentId) {
    if (anteStatusEl) anteStatusEl.textContent = 'Pick an antecedent fragment first.';
    return;
  }
  if (_tabId == null) {
    if (anteStatusEl) anteStatusEl.textContent = 'No active tab — open the page first.';
    return;
  }

  // v2.74.23 — Parse comma-separated param values into a paramBindings
  // object keyed by the antecedent's declared param names. Missing
  // values bind to empty string; extra values are dropped. The
  // background's executeFragment substitutes {{NAME}} tokens at runtime.
  const f = _anteFragments.find(x => x.id === antecedentFragmentId);
  const declaredParams = (f && Array.isArray(f.params)) ? f.params : [];
  const paramBindings = {};
  if (declaredParams.length > 0) {
    const raw = (anteParamsInputEl?.value ?? '').split(',').map(s => s.trim());
    for (let i = 0; i < declaredParams.length; i++) {
      paramBindings[declaredParams[i]] = raw[i] ?? '';
    }
    // Persist on the payload so subsequent precondition inheritance and
    // the eventual save record carry the same bindings.
    _payload.antecedentParamBindings = { ...paramBindings };
  } else {
    _payload.antecedentParamBindings = null;
  }

  if (anteRunBtnEl) {
    anteRunBtnEl.disabled = true;
    anteRunBtnEl.textContent = 'Running…';
  }
  if (anteStatusEl) anteStatusEl.textContent = 'Resetting tab + running antecedent…';

  let res;
  try {
    res = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'RUN_ANTECEDENT_FOR_AUTHORING',
        payload: { tabId: _tabId, antecedentFragmentId, paramBindings },
      }, resolve);
    });
  } catch (e) {
    res = { success: false, error: e.message };
  }

  if (res?.success) {
    const n = (res.actionsRun ?? 0) + (res.antecedentActionsRun ?? 0);
    if (anteStatusEl) {
      anteStatusEl.textContent = `Ran ${n} action${n === 1 ? '' : 's'}. Page is in the antecedent's post-state.`;
    }
    // v2.74.23 — Run succeeded. Flip the button to undo mode so the user
    // can revert the page to the ground's default URL with a single click.
    _setAntecedentRunMode('undo');
    // Re-capture preconditions now that the page reflects the antecedent.
    try { await _capturePreconditions(); } catch {}
  } else {
    if (anteStatusEl) {
      anteStatusEl.textContent = `Run failed: ${res?.error ?? 'unknown error'}`;
    }
    _setAntecedentRunMode('run');
  }
  _updateAntecedentCardEnabled();
}

/**
 * v2.74.23 — Undo handler. Navigates the authoring tab back to the
 * ground's default URL, waits for it to load, then flips the button
 * back to Run mode. Triggered by the same Run button when its mode
 * is 'undo' (after a successful run).
 */
async function _onAntecedentUndoClick() {
  if (!_payload || _tabId == null) return;
  const url = _payload.groundUrl;
  if (!url) {
    if (anteStatusEl) anteStatusEl.textContent = 'No default URL on payload — cannot reset.';
    return;
  }
  if (anteRunBtnEl) {
    anteRunBtnEl.disabled = true;
    anteRunBtnEl.textContent = '…';
    anteRunBtnEl.title = 'Resetting tab…';
  }
  if (anteStatusEl) anteStatusEl.textContent = 'Resetting tab to default URL…';

  let res;
  try {
    res = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'NAVIGATE_TAB',
        payload: { tabId: _tabId, url },
      }, resolve);
    });
  } catch (e) {
    res = { success: false, error: e.message };
  }

  if (res?.success) {
    if (anteStatusEl) anteStatusEl.textContent = 'Tab reset to default URL.';
    _setAntecedentRunMode('run');
    // Re-capture preconditions against the freshly-loaded default URL.
    try { await _capturePreconditions(); } catch {}
  } else {
    if (anteStatusEl) anteStatusEl.textContent = `Reset failed: ${res?.error ?? 'unknown error'}`;
    // Stay in undo mode so the user can retry.
    _setAntecedentRunMode('undo');
  }
  _updateAntecedentCardEnabled();
}

/**
 * v2.74.23 — Toggle the antecedent card body open/closed. Mirrors the
 * Ground-card collapse pattern: a parent class on the card hides the
 * body via CSS; the header (chevron + title) stays visible. Header
 * text reflects the current selection so the user sees which
 * antecedent is picked even when collapsed.
 */
function _toggleAntecedentCard() {
  if (!anteCardEl) return;
  _anteCardCollapsed = anteCardEl.classList.toggle('fa-antecedent-card-collapsed');
  _renderAntecedentToggle();
}

function _renderAntecedentToggle() {
  if (!anteCardEl || !anteToggleGlyphEl) return;
  // Keep state and DOM class aligned in case _anteCardCollapsed was set
  // outside of _toggleAntecedentCard (unmount reset, fresh mount, etc.).
  anteCardEl.classList.toggle('fa-antecedent-card-collapsed', _anteCardCollapsed);
  anteToggleGlyphEl.textContent = _anteCardCollapsed ? '▸' : '▾';
  if (anteToggleBtnEl) {
    anteToggleBtnEl.setAttribute('aria-expanded', _anteCardCollapsed ? 'false' : 'true');
    anteToggleBtnEl.setAttribute('aria-label',
      _anteCardCollapsed ? 'Expand antecedent card' : 'Collapse antecedent card');
  }
  // v2.74.23 — Header companion text reflects the current selection in
  // lowercase. Always written; CSS reveals it only when the card is
  // collapsed, so the JS doesn't need to toggle visibility.
  if (anteCollapsedNameEl) {
    const sel = anteSelectEl?.value || '';
    let name = 'none';
    if (sel) {
      const f = _anteFragments.find(x => x.id === sel);
      if (f?.name) name = f.name.toLowerCase();
    }
    anteCollapsedNameEl.textContent = name;
  }
}

/**
 * v2.74.23 — Pre/postconditions card collapse toggles. Same shape as
 * the antecedent toggle: clicking flips a parent class on the card,
 * which CSS uses to hide the body row. The head (label + source) stays
 * visible regardless of state. `which` is 'pre' or 'post'.
 */
function _togglePreCard() {
  if (!preCardEl) return;
  _preCardCollapsed = preCardEl.classList.toggle('fa-conditions-card-collapsed');
  _renderConditionsToggle('pre');
}
function _togglePostCard() {
  if (!postCardEl) return;
  _postCardCollapsed = postCardEl.classList.toggle('fa-conditions-card-collapsed');
  _renderConditionsToggle('post');
}
function _renderConditionsToggle(which) {
  const isPre = which === 'pre';
  const cardEl    = isPre ? preCardEl    : postCardEl;
  const toggleEl  = isPre ? preToggleBtnEl   : postToggleBtnEl;
  const glyphEl   = isPre ? preToggleGlyphEl : postToggleGlyphEl;
  const collapsed = isPre ? _preCardCollapsed : _postCardCollapsed;
  const label     = isPre ? 'preconditions' : 'postconditions';
  if (!cardEl || !glyphEl) return;
  cardEl.classList.toggle('fa-conditions-card-collapsed', collapsed);
  glyphEl.textContent = collapsed ? '▸' : '▾';
  if (toggleEl) {
    toggleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggleEl.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${label}`);
  }
}

// v2.74.25 — Actions card collapse. Same chevron pattern as the pre/post
// and antecedent toggles, scoped to the Actions section. The chevron
// lives inline in the head row, so collapsing only hides the actions
// list and the + Action/+ Action branch footer; the head (label + count
// chip) stays visible so the user always sees how many actions exist.
function _toggleActionsCard() {
  if (!actionsCardEl) return;
  _actionsCardCollapsed = actionsCardEl.classList.toggle('fa-landmarks-card-collapsed');
  _renderActionsToggle();
}
function _renderActionsToggle() {
  if (!actionsCardEl || !actionsToggleGlyphEl) return;
  actionsCardEl.classList.toggle('fa-landmarks-card-collapsed', _actionsCardCollapsed);
  actionsToggleGlyphEl.textContent = _actionsCardCollapsed ? '▸' : '▾';
  if (actionsToggleBtnEl) {
    actionsToggleBtnEl.setAttribute('aria-expanded', _actionsCardCollapsed ? 'false' : 'true');
    actionsToggleBtnEl.setAttribute('aria-label', `${_actionsCardCollapsed ? 'Expand' : 'Collapse'} actions`);
  }
}

/**
 * v2.74.23 — Switch the Run button between 'run' and 'undo' modes,
 * updating its label and tooltip. Centralized so every state path
 * (success, failure, dropdown change, action add/remove) goes through
 * the same toggle.
 */
function _setAntecedentRunMode(mode) {
  _anteRunMode = (mode === 'undo') ? 'undo' : 'run';
  if (!anteRunBtnEl) return;
  if (_anteRunMode === 'undo') {
    anteRunBtnEl.textContent = '↻';
    anteRunBtnEl.title = 'Reset tab to default URL';
    anteRunBtnEl.classList.add('fa-antecedent-run-undo');
  } else {
    anteRunBtnEl.textContent = 'Run';
    anteRunBtnEl.title = 'Run antecedent fragment';
    anteRunBtnEl.classList.remove('fa-antecedent-run-undo');
  }
}

/**
 * Enable/disable the dropdown + Run button based on actions list state.
 * Empty actions list → enabled. Non-empty → disabled (locked once
 * authoring has begun, mirroring the save-time invariant that the
 * antecedent shouldn't change after the user has authored against a
 * specific page state).
 */
function _updateAntecedentCardEnabled() {
  const hasActions = _actions.length > 0;
  const noChoice = !(anteSelectEl?.value);
  if (anteCardEl) {
    anteCardEl.classList.toggle('fa-antecedent-card-disabled', hasActions);
  }
  if (anteSelectEl)      anteSelectEl.disabled      = hasActions;
  if (anteParamsInputEl) anteParamsInputEl.disabled = hasActions;
  if (anteRunBtnEl) {
    // v2.74.23 — Hide the Run button entirely when no antecedent is
    // selected (the "— none —" option). With no choice there's nothing
    // to run, and a greyed-out button reads as broken UI; hiding is
    // cleaner. Disabled when locked (actions list non-empty).
    anteRunBtnEl.classList.toggle('hidden', noChoice);
    anteRunBtnEl.disabled = hasActions;
  }
}

// ─── Save state ──────────────────────────────────────────────────────────

// v2.74.187 — Compute a list of human-readable reasons the Save gate
// is closed. Returns [] when save is allowed. Reasons are 1-based and
// reference user-visible row numbers so the author can find the
// offending row at a glance. Used by _updateSaveState to drive both
// the disabled state AND the new hint text shown next to the button.
function _computeSaveDisabledReasons() {
  const reasons = [];
  const hasName = (nameInputEl?.value ?? '').trim().length > 0;
  if (!hasName) reasons.push('Enter a Fragment name');
  if (_actions.length === 0) reasons.push('Add at least one action');

  // v2.74.158 — ACTION_GATE structural + body verification rules.
  const describeCondMissing = (cond, rowNum) => {
    if (!cond || typeof cond.type !== 'string' || cond.type === '') {
      return `Action ${rowNum} (gate): pick a condition type`;
    }
    const selectorBearing = (cond.type === 'selector_present' || cond.type === 'selector_absent' || cond.type === 'attribute_equals');
    if (selectorBearing && !((cond.selector ?? '').trim()))   return `Action ${rowNum} (gate): selector required`;
    if (cond.type === 'attribute_equals' && !((cond.attribute ?? '').trim())) return `Action ${rowNum} (gate): attribute name required`;
    if (cond.type === 'url_matches'      && !((cond.pattern ?? '').trim()))   return `Action ${rowNum} (gate): URL pattern required`;
    if (cond.type === 'text_present'     && !((cond.text ?? '').trim()))      return `Action ${rowNum} (gate): text required`;
    if (cond.type === 'assertion_ref'    && !cond.assertionId)                return `Action ${rowNum} (gate): pick an assertion`;
    if (cond.type === 'perspective_ref'       && !cond.perspectiveId)                   return `Action ${rowNum} (gate): pick a perspective`;
    return null;
  };

  _actions.forEach((a, idx) => {
    const rowNum = idx + 1;
    if (a.action === 'ACTION_GATE') {
      const condReason = describeCondMissing(a.condition, rowNum);
      if (condReason) reasons.push(condReason);
      const body = Array.isArray(a.body) ? a.body : [];
      body.forEach((sub, gIdx) => {
        if (!(sub?.verified?.success === true)) {
          reasons.push(`Action ${rowNum}.${gIdx + 1} (${sub?.action ?? '?'}): not verified${sub?.verified?.error ? ` — ${sub.verified.error}` : ''}`);
        }
      });
      return;
    }
    if (!(a.verified?.success === true)) {
      reasons.push(`Action ${rowNum} (${a.action}): not verified${a.verified?.error ? ` — ${a.verified.error}` : ''}`);
      // Don't pile branch failures on top of an unverified head — the
      // head usually has to pass first anyway.
      return;
    }
    if (Array.isArray(a.branches) && a.branches.length > 0) {
      const hasCblBranch = a.branches.some(b => b?.action === 'CLICK_BY_LABEL');
      if (hasCblBranch && !((a.bodyValue ?? '').trim())) {
        reasons.push(`Action ${rowNum} (chain): layer-2 value required (set the field above the branches)`);
      }
      a.branches.forEach((b, bIdx) => {
        if (!(b?.verified?.success === true)) {
          reasons.push(`Action ${rowNum}.b${bIdx + 1} (${b?.action ?? '?'}): branch not verified${b?.verified?.error ? ` — ${b.verified.error}` : ''}`);
        }
      });
    }
  });
  return reasons;
}

function _updateSaveState() {
  if (!saveBtnEl) return;
  // v2.72.90 — Save gate: name + all-verified. Description is no longer
  // authored in the mode; auto-composed at save time and edited later
  // in Studio.
  // v2.74.0 — Chain cards: head AND every branch must be verified.
  // v2.74.3 — Chain with any CLICK_BY_LABEL branch must also have a
  // non-empty bodyValue.
  // v2.74.158 — ACTION_GATE rows have their own structural verification
  // path (see _computeSaveDisabledReasons).
  // v2.74.187 — Reasons computed centrally and surfaced to the user.
  // Previously the only signal was console.debug — silent for anyone
  // not in DevTools. Now the disabled-button title + a hint line
  // beneath the button enumerate exactly which rows are blocking.
  const reasons = _computeSaveDisabledReasons();
  const enabled = reasons.length === 0;
  saveBtnEl.disabled = !enabled;
  saveBtnEl.title = enabled
    ? 'Save Fragment'
    : `Save disabled:\n• ${reasons.join('\n• ')}`;
  // Mirror to a sibling hint element if present in the DOM. The element
  // is created on first call; index 0 reason shows inline, the rest
  // live in the title attribute (avoids wall-of-text under the button).
  // v2.74.194 — Append to the NAME CARD (block-level section), not to
  // .fa-name-row (a flex row). Appending to the row made the hint a
  // sibling flex item alongside the input + Save button, squishing
  // it horizontally into a tiny strip. Appending to the section
  // places it BELOW the row as a block-level div — the intended UX.
  const hintHost = nameCardEl ?? saveBtnEl.parentElement;
  let hintEl = hintHost?.querySelector('[data-fa="save-hint"]');
  if (!hintEl && hintHost) {
    hintEl = document.createElement('div');
    hintEl.setAttribute('data-fa', 'save-hint');
    hintEl.className = 'fa-save-hint';
    hintHost.appendChild(hintEl);
  }
  if (hintEl) {
    if (enabled) {
      hintEl.textContent = '';
      hintEl.classList.add('hidden');
    } else {
      const first = reasons[0];
      const extra = reasons.length > 1 ? ` (+${reasons.length - 1} more — hover Save to see all)` : '';
      hintEl.textContent = first + extra;
      hintEl.classList.remove('hidden');
    }
  }
  // Diagnostic log preserved for DevTools debugging.
  if (!enabled) {
    console.debug('[fragment-author] save disabled', { reasons });
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────

async function _onSaveClick() {
  if (!_payload) return;

  // v2.72.61 — Read name from the mode's input. v2.72.90 — Description
  // is no longer authored in the mode; always auto-composed from the
  // labeled action sequence below. User can edit later in Studio.
  const name = (nameInputEl?.value ?? '').trim();

  if (!name) {
    toast('Enter a Fragment name', 'err');
    nameInputEl?.focus();
    return;
  }
  if (_actions.length === 0) {
    toast('Add at least one action', 'err');
    return;
  }
  // v2.74.0 — Verified check covers chain branches too. A chain card is
  // verified when the head AND every branch are individually verified.
  // v2.74.3 — Also require chain-wide bodyValue when chain has any
  // CLICK_BY_LABEL branch.
  // v2.74.158 — ACTION_GATE: header structural-check + body
  // sub-actions verified. The gate's own verify flag is never set.
  // Mirrors isActionFullyVerified in _updateSaveState.
  const allVerified = _actions.every(a => {
    if (a.action === 'ACTION_GATE') {
      const cond = a.condition;
      if (!cond || typeof cond.type !== 'string' || cond.type === '') return false;
      const selectorBearing = (cond.type === 'selector_present' || cond.type === 'selector_absent' || cond.type === 'attribute_equals');
      if (selectorBearing && !((cond.selector ?? '').trim())) return false;
      if (cond.type === 'attribute_equals' && !((cond.attribute ?? '').trim())) return false;
      if (cond.type === 'url_matches'      && !((cond.pattern ?? '').trim()))   return false;
      if (cond.type === 'text_present'     && !((cond.text ?? '').trim()))      return false;
      if (cond.type === 'assertion_ref'    && !cond.assertionId)                return false;
      if (cond.type === 'perspective_ref'       && !cond.perspectiveId)                   return false;
      const body = Array.isArray(a.body) ? a.body : [];
      return body.every(sub => sub?.verified?.success === true);
    }
    if (!(a.verified?.success === true)) return false;
    if (Array.isArray(a.branches)) {
      if (a.branches.length === 0) {
        return true;
      }
      const hasCblBranch = a.branches.some(b => b?.action === 'CLICK_BY_LABEL');
      if (hasCblBranch && !((a.bodyValue ?? '').trim())) return false;
      return a.branches.every(b => b.verified?.success === true);
    }
    return true;
  });
  if (!allVerified) {
    toast('All actions and branch sub-rows must be verified (and the layer-2 value set when CLICK_BY_LABEL branches present)', 'err');
    return;
  }

  // v2.72.88 — Auto-compose description from labeled action sequence.
  // v2.72.90 — No user-authored override at this stage; description
  // editing happens in Studio Edit Fragment.
  const description = _composeDescriptionFromActions(_actions);

  // Build the rawJson action list. Schema requires {step, action, selector, value}.
  // v2.72.72 — SCROLL_TO actions also carry smoothScroll: true when the
  // user toggled it. Engine + content script honor this for the scroll
  // behavior. Default unset = behavior:'auto' (instant) at runtime.
  // v2.74.0 — CLICK_BY_LABEL with non-empty branches[] serializes the
  // branches into rawJson. Empty branches array is stripped (plain
  // CLICK_BY_LABEL on disk; engine and form treat the two as identical).
  // v2.74.3 — Chain serialization writes:
  //   - step.bodyValue when chain has any CLICK_BY_LABEL branch (the
  //     chain-wide layer-2 selection slot)
  //   - branch.value ONLY for WAIT (milliseconds); WAIT_FOR has no value;
  //     CLICK_BY_LABEL branches don't carry their own value (they read
  //     bodyValue at runtime)
  const rawList = _actions.map((a, idx) => {
    const step = {
      step: idx + 1,
      action: a.action,
      selector: a.selector ?? '',
      value: a.value ?? '',
    };
    // v2.74.163 — Same-origin iframe support. When the picker captured
    // this action inside an iframe, the URL is stored on the in-memory
    // action. Persist it so runtime dispatch (TemplateWalker) can
    // resolve the matching frameId at execute time. Omit for top-frame
    // actions to keep rawJson clean for the common case.
    if (a.frameUrl) {
      step.frameUrl = a.frameUrl;
    }
    // v2.74.236 — Wave 3: persist landmarkRef alongside selector +
    // frameUrl. At runtime TemplateWalker.#executeStep re-resolves the
    // ref before dispatch, so the runtime selector tracks the
    // landmark's latest (post-rediscover etc.) value. Selector +
    // frameUrl are still persisted (they were populated from the
    // landmark at authoring time) — they're a cache + the fallback
    // when the ref can't be resolved (deleted perspective, etc.).
    // v2.74.275 — Only { uid } refs serialized into saved fragment.
    if (a.landmarkRef && typeof a.landmarkRef.uid === 'string') {
      step.landmarkRef = { uid: a.landmarkRef.uid };
    }
    // v2.74.306 — Phase 2 of ACTION_SPEC compliance. Effect annotation
    // lives on the Action record (§ 5). Persist it when it's a non-
    // default value — { kind: 'none' } is the implicit default, so we
    // omit it to keep rawJson clean (absence === none per § 5). Same
    // for interactionPattern === 'none'. Seeded from the landmark at
    // link time (_applyActionLandmarkRef); author can override.
    if (a.effect && a.effect.kind && a.effect.kind !== 'none') {
      step.effect = { kind: a.effect.kind };
      if (a.effect.kind === 'opens-new-thread' && a.effect.form) {
        step.effect.form = a.effect.form;
      }
      if (a.effect.kind === 'triggers-modal' && a.effect.modalKind) {
        step.effect.modalKind = a.effect.modalKind;
      }
    }
    if (a.interactionPattern && a.interactionPattern !== 'none') {
      step.interactionPattern = a.interactionPattern;
    }
    if (a.action === 'SCROLL_TO' && a.smoothScroll === true) {
      step.smoothScroll = true;
    }
    // v2.74.316 — KEY repeat count. Persist only when > 1 (1 is the
    // implicit default, kept out of rawJson for cleanliness).
    if (a.action === 'KEY') {
      const r = parseInt(a.repeat, 10);
      if (Number.isFinite(r) && r > 1) step.repeat = Math.min(r, 50);
    }
    // v2.72.87 — Persist the picked human label (e.g. "Upload photo") on
    // the rawJson step. Engine ignores it; UI uses it for the row header
    // and (next pass) auto-composed Fragment descriptions. Skip empty
    // labels to keep rawJson clean.
    if (a.pickedLabel && a.pickedLabel.trim()) {
      step.pickedLabel = a.pickedLabel.trim();
    }
    // v2.74.0 — Chain branches. Strip empty branches (plain CLICK_BY_LABEL
    // on disk). Strip per-branch authoring-only state (verified, verifying)
    // and pickedLabel-when-empty to keep rawJson clean.
    if (Array.isArray(a.branches) && a.branches.length > 0) {
      step.branches = a.branches.map(b => {
        const br = {
          label: (b.label ?? '').trim(),
          action: b.action,
          selector: b.selector ?? '',
        };
        // v2.74.3 — WAIT branches carry their own value (ms duration).
        // CLICK_BY_LABEL branches read bodyValue at runtime — no value here.
        // WAIT_FOR has no value field.
        if (b.action === 'WAIT') {
          br.value = b.value ?? '';
        }
        if (b.pickedLabel && b.pickedLabel.trim()) {
          br.pickedLabel = b.pickedLabel.trim();
        }
        // v2.74.183 — Preserve per-branch iframe routing on save.
        // TemplateWalker line 1071 reads `branch.frameUrl` to dispatch
        // each branch into its own frame (a chain head can live in
        // the top document while a layer-2 menu branch lives in an
        // iframe, or vice versa). Without persisting, branches picked
        // in iframes silently route to top frame at runtime.
        if (typeof b.frameUrl === 'string' && b.frameUrl.trim()) {
          br.frameUrl = b.frameUrl;
        }
        // v2.74.313 — Per-branch effect / interactionPattern (set via the
        // inline editor or verify-drift reconcile). Defaults omitted.
        _serializeEffectFields(b, br);
        return br;
      });
      // v2.74.3 — bodyValue on chain step. Only persist when there's at
      // least one CLICK_BY_LABEL branch consuming it; otherwise the field
      // has no semantic role and we strip it to keep rawJson clean.
      const hasCblBranch = step.branches.some(b => b.action === 'CLICK_BY_LABEL');
      if (hasCblBranch && (a.bodyValue ?? '').trim() !== '') {
        step.bodyValue = a.bodyValue;
      }
    }
    // v2.74.158 — ACTION_GATE persistence. Header condition + negate
    // flag + body sub-actions. Body entries are stripped of authoring-
    // only state (verified, verifying, _uid, id, pickedLabel-when-empty)
    // matching the chain-branch hygiene above. condition is a shallow
    // clone — its inner fields are primitives (selector / pattern /
    // text / attribute / value / type / assertionId / perspectiveId), so
    // shallow is safe.
    if (a.action === 'ACTION_GATE') {
      step.condition = { ...(a.condition ?? {}) };
      // v2.74.172 — Strip transient authoring-only fields.
      // v2.74.178 — _verifyHelper too.
      delete step.condition._verified;
      delete step.condition._verifying;
      delete step.condition._verifyHelper;
      step.negate    = !!a.negate;
      // v2.74.201 — Persist optional waitTimeout. Only when > 0;
      // skipping zero / unset keeps rawJson clean for the common
      // case where the gate is one-shot.
      if (Number.isFinite(a.waitTimeout) && a.waitTimeout > 0) {
        step.waitTimeout = a.waitTimeout;
      }
      step.body = (Array.isArray(a.body) ? a.body : []).map(sub => {
        const out = {
          action: sub.action,
          selector: sub.selector ?? '',
        };
        // Only include `value` when the sub-action's type actually uses
        // it (TYPE / WAIT / CLICK_BY_LABEL / SELECT). Omit for CLICK /
        // WAIT_FOR / BLUR so rawJson stays clean.
        // v2.74.181 — SELECT added (newly allowed in gate bodies). Its
        // value is the option name / param placeholder runtime selects
        // by; without this it'd silently lose the value at save.
        const valueBearing = (sub.action === 'TYPE' || sub.action === 'WAIT' || sub.action === 'CLICK_BY_LABEL' || sub.action === 'SELECT');
        if (valueBearing) out.value = sub.value ?? '';
        if (sub.pickedLabel && sub.pickedLabel.trim()) {
          out.pickedLabel = sub.pickedLabel.trim();
        }
        // v2.74.181 — Preserve iframe routing on gate body sub-actions.
        // The runtime (TemplateWalker line 987) reads bodyAction.frameUrl
        // to dispatch into the right frame, but save was previously
        // dropping the field — iframe-picked sub-actions silently fell
        // back to top-frame dispatch and failed at runtime.
        if (typeof sub.frameUrl === 'string' && sub.frameUrl.trim()) {
          out.frameUrl = sub.frameUrl;
        }
        // v2.74.313 — Per-gate-sub effect / interactionPattern.
        _serializeEffectFields(sub, out);
        return out;
      });
    }
    return step;
  });

  // Derive params from {{NAME}} tokens in selectors and values.
  // (Mirrors TemplateWalker's #extractFragmentParams helper.)
  // v2.74.3 — Chain param scan: walk step.bodyValue (chain-wide layer-2
  // slot) and branch.selector / branch.value (only WAIT branches carry
  // value; CLICK_BY_LABEL branches have no value of their own).
  const paramSet = new Set();
  const paramRe = /\{\{([A-Z0-9_]+)\}\}/g;
  const scanParams = (str) => {
    if (typeof str !== 'string') return;
    paramRe.lastIndex = 0;
    let m;
    while ((m = paramRe.exec(str)) !== null) paramSet.add(m[1]);
  };
  for (const step of rawList) {
    scanParams(step.selector);
    scanParams(step.value);
    scanParams(step.bodyValue);
    if (Array.isArray(step.branches)) {
      for (const branch of step.branches) {
        scanParams(branch.selector);
        scanParams(branch.value);   // only present on WAIT branches
      }
    }
    // v2.74.158 — Gate fields. The header condition's selector /
    // pattern / text / attribute / value may all carry {{PARAM}}
    // tokens (e.g. selector_present with selector='[data-id={{ID}}]').
    // Body sub-actions carry selector / value tokens like any
    // top-level action. Walking these here means the saved fragment's
    // params[] correctly enumerates everything runtime substitution
    // needs to bind.
    if (step.condition && typeof step.condition === 'object') {
      scanParams(step.condition.selector);
      scanParams(step.condition.pattern);
      scanParams(step.condition.text);
      scanParams(step.condition.attribute);
      scanParams(step.condition.value);
    }
    if (Array.isArray(step.body)) {
      for (const sub of step.body) {
        scanParams(sub.selector);
        scanParams(sub.value);
      }
    }
  }
  const params = [...paramSet].sort();

  // v2.74.307 — Phase 3 of ACTION_SPEC compliance. Fragment carries a
  // deduped union of its constituent Actions' effects (§ 10). Walks
  // rawList (top-level actions AND gate body sub-actions AND chain
  // branches — every place an Action lives), collects each non-none
  // effect, dedupes per the spec's keying rules.
  const aggregatedEffects = _aggregateActionEffects(rawList);

  // v2.74.318 — Perspective anchor (PERSPECTIVE_SPEC § 2/§ 18). The Perspective(s)
  // this fragment is authored against, derived from the landmarks its
  // actions reference. Lets the runtime / Workflow tier know which
  // perspective(s) must be active for the fragment's landmarks to
  // resolve, and lets Studio show "this fragment belongs to the X
  // perspective" without walking landmarkRefs. Empty when the fragment
  // uses only inline selectors (no landmark links).
  const perspectiveIds = _fragmentPerspectiveIds();

  // v2.72.67 — Final postconditions snapshot. Page should be in the
  // post-state from the last Verify; capture once more in case anything
  // shifted (e.g., async settle after the last action).
  await _capturePostconditions();

  const fragment = {
    id            : _payload.fragmentId,
    groundId      : _payload.groundId,
    name          ,
    description   ,
    rawJson       : JSON.stringify(rawList),
    params,
    // v2.74.307 — Phase 3: aggregated effects (ACTION_SPEC § 10).
    // Derived field — recomputed from actions on every save. Workflow
    // invocation directive coverage (onSpawn/onNavigate/onModal/
    // onDownload) validates against this list.
    aggregatedEffects,
    // v2.74.318 — Perspective anchor (PERSPECTIVE_SPEC § 2). Perspective IDs whose
    // landmarks this fragment references. Derived; recomputed each save.
    perspectiveIds,
    // v2.72.67 — Auto-captured pre/post conditions. Inherited from
    // antecedent (preconditions) or auto-captured from page state.
    preconditions : _preconditions.map(c => ({ ...c })),
    postconditions: _postconditions.map(c => ({ ...c })),
    pageClass     : _payload.pageClass ?? null,
    isRewalk      : _payload.isRewalk === true,
    antecedentFragmentId    : _payload.antecedentFragmentId ?? null,
    antecedentParamBindings : _payload.antecedentParamBindings ?? null,
    rationale     : null,
    startUrl      : _payload.groundUrl,
    endUrl        : null,
    healthStatus  : 'ready',
    lastWalkedAt  : Date.now(),
    lastExecutedAt: null,
    // v2.72.60 — Authoring tier marker. T1 = manually authored (this mode).
    authoringTier : 'T1',
  };

  // v2.74.122 — Mount-snapshot guard + Cancel disable during save. Same
  // pattern as the other author modes (assertion v2.74.120, analysis +
  // perspective v2.74.121, observation v2.74.122). Especially important here
  // because the success path forks two ways — exit-to-ground OR
  // chain-author-reset — and pre-fix, a Cancel mid-save would still run
  // EITHER branch, including resetting the form for a new fragment when
  // the user just wanted to leave.
  const mountSnapshot = _mountEl;
  saveBtnEl.disabled = true;
  if (cancelBtnEl) cancelBtnEl.disabled = true;
  saveBtnEl.textContent = 'Saving…';

  try {
    const res = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'SAVE_FRAGMENT', payload: { fragment } }, resolve);
    });
    if (mountSnapshot !== _mountEl) return;
    if (!res?.success) {
      toast(`Save failed: ${res?.error ?? 'unknown'}`, 'err');
      saveBtnEl.disabled = false;
      if (cancelBtnEl) cancelBtnEl.disabled = false;
      saveBtnEl.textContent = 'Save';
      return;
    }
    // v2.74.33 — When launched from the Ground sidepanel, save → return.
    // Skip the chain-authoring reset that would otherwise leave the user
    // in a new in-chain authoring session; the Ground sidepanel is the
    // expected next surface.
    if (_payload?.returnTo === 'ground-view') {
      toast(`Saved fragment "${fragment.name}"`);
      _exitOrReturn();
      return;
    }
    toast(`Saved — ${rawList.length} action${rawList.length === 1 ? '' : 's'}. Continue authoring or click Cancel.`);
    // v2.72.66 — Push the just-saved fragment to the session chain and
    // clear the form for the next one. The next fragment's antecedent
    // becomes the just-saved fragment; the page is already in the
    // post-state of the saved fragment (last Verify left it there) so
    // no re-setup needed.
    _savedChain.push({ id: fragment.id, name: fragment.name });
    _resetForNextFragment();
    if (cancelBtnEl) cancelBtnEl.disabled = false;
    _renderBreadcrumb();
  } catch (e) {
    if (mountSnapshot !== _mountEl) return;
    toast(`Save threw: ${e.message}`, 'err');
    saveBtnEl.disabled = false;
    if (cancelBtnEl) cancelBtnEl.disabled = false;
    saveBtnEl.textContent = 'Save';
  }
}

/**
 * v2.72.66 — Clear the action list, name, description, and reset
 * fragment-id + tabbed antecedent for the next fragment in the chain.
 * Called after a successful Save when the user wants to author another
 * fragment in sequence.
 *
 * What stays: groundId, groundUrl, tabId (same tab, current page state
 * is the post-state of the just-saved fragment).
 * What changes: a fresh fragmentId (new uuid) for the next save;
 * antecedentFragmentId set to the just-saved fragment's id.
 */
function _resetForNextFragment() {
  if (!_payload || _savedChain.length === 0) return;
  const lastSaved = _savedChain[_savedChain.length - 1];

  // New ID for the next fragment.
  _payload.fragmentId = uid().replace(/^act_/, 'frag_');
  _payload.name = '';
  _payload.description = '';
  // Chain antecedent: next fragment runs after the just-saved one.
  _payload.antecedentFragmentId = lastSaved.id;
  _payload.antecedentParamBindings = null;
  // Re-walk flag is meaningless for chained fragments.
  _payload.isRewalk = false;
  // v2.74.182 — Clear the re-walk name carry-over too. Without this,
  // chaining a new fragment after a re-walked one would resolve to the
  // re-walk name via the effectiveName fallback in _mount, and the
  // next fragment in the chain would silently inherit the prior
  // fragment's name in its input.
  _payload.rewalkName = '';

  // Clear form state.
  _actions = [];
  if (nameInputEl) nameInputEl.value = '';
  // v2.72.90 — descriptionInputEl removed; nothing to reset.

  // Update banner.
  bannerTitleEl.textContent = 'Authoring next Fragment in chain';
  bannerSubtitleEl.textContent = `↑ after "${lastSaved.name}" — page is in post-state, ready to continue`;

  // Reset Save button + state.
  saveBtnEl.disabled = true;
  saveBtnEl.textContent = 'Save';
  _renderActions();
  _updateSaveState();
  // v2.74.22 — Refresh the antecedent dropdown so the just-saved fragment
  // appears as a candidate (and gets pre-selected since _payload now
  // points at it). Re-enables the card since _actions was cleared above.
  // v2.74.23 — Clear the params input row too (its values were for the
  // previous antecedent's run; the new antecedent has its own param shape)
  // and reset the Run button to its default mode. Re-arm the auto-collapse
  // tracker so the next fragment in the chain auto-collapses on its
  // first action; expand the card so the user sees the new selection.
  if (anteParamsInputEl) anteParamsInputEl.value = '';
  _setAntecedentRunMode('run');
  _anteLastActionCount = 0;
  _anteCardCollapsed = false;
  _renderAntecedentToggle();
  // v2.74.26 — Re-hide the Name card and re-expand the collapsible
  // cards so the next fragment in the chain starts fresh. The Name card
  // becomes visible again only when the author clicks Done.
  nameCardEl?.classList.add('hidden');
  _preCardCollapsed = false;
  _renderConditionsToggle('pre');
  _postCardCollapsed = false;
  _renderConditionsToggle('post');
  _actionsCardCollapsed = false;
  _renderActionsToggle();
  _populateAntecedentDropdown();
  if (anteStatusEl) anteStatusEl.textContent = '';
  // v2.72.67 — Reset and re-capture conditions for the next fragment.
  // Preconditions inherit from antecedent (the just-saved fragment's
  // postconditions). Postconditions reset to empty until first Verify.
  _preconditions = [];
  _postconditions = [];
  _preSource = 'capturing…';
  _postSource = '—';
  _renderPreconditions();
  _renderPostconditions();
  _capturePreconditions();
  if (nameInputEl) nameInputEl.focus();
}

/**
 * v2.72.66 — Render the breadcrumb of fragments saved in this session.
 * Shows as: ✓ Open form → ✓ Fill name → [authoring next…]
 */
function _renderBreadcrumb() {
  if (!breadcrumbEl) return;
  if (_savedChain.length === 0) {
    breadcrumbEl.classList.add('hidden');
    breadcrumbEl.innerHTML = '';
    return;
  }
  const parts = _savedChain.map(f => `<span class="fa-crumb fa-crumb-saved">✓ ${escHtml(f.name)}</span>`);
  parts.push(`<span class="fa-crumb fa-crumb-current">authoring next…</span>`);
  breadcrumbEl.classList.remove('hidden');
  breadcrumbEl.innerHTML = parts.join('<span class="fa-crumb-sep">→</span>');
}

// ─── Done / Cancel ────────────────────────────────────────────────────────

/**
 * v2.74.26 — Bottom "Done" button. Reveals the Name card (which the
 * panel hides at mount time) and collapses every collapsible card —
 * Antecedent, Preconditions, Actions, Postconditions — so the author's
 * eye lands on the name field. The Save button inside the Name card is
 * the actual save trigger.
 *
 * Idempotent: clicking again just re-collapses everything. Focus the
 * name input so the author can type immediately.
 */
function _onRevealNameClick() {
  nameCardEl?.classList.remove('hidden');
  // Collapse all collapsible cards in one sweep.
  _anteCardCollapsed   = true;
  _renderAntecedentToggle();
  _preCardCollapsed    = true;
  _renderConditionsToggle('pre');
  _postCardCollapsed   = true;
  _renderConditionsToggle('post');
  _actionsCardCollapsed = true;
  _renderActionsToggle();
  nameInputEl?.focus();
}

/**
 * v2.72.66 — Cancel. Exits to Studio (panel closes, focus returns to
 * Studio). Warns the user if they have unsaved actions in the current
 * row buffer.
 * v2.74.26 — Bound to the bottom "Cancel" button (renamed from "Done").
 * Same behaviour as before — only the label changed.
 */
function _onDoneClick() {
  // Detect unsaved work: any non-empty form state means in-progress
  // authoring that would be lost. v2.72.90 — Description input removed;
  // hasDesc no longer part of the dirty check.
  const hasName = (nameInputEl?.value ?? '').trim().length > 0;
  const hasActions = _actions.length > 0;
  if (hasName || hasActions) {
    if (!confirm('You have unsaved authoring in progress. Discard it and exit?')) {
      return;
    }
  }
  _exitOrReturn();
}

// v2.74.33 — Route the exit. When the mode was launched from the Ground
// sidepanel (returnTo='ground-view'), switch the panel back to that mode
// instead of dismissing it and focusing Studio. The Ground sidepanel
// stays open showing the current page's Ground.
// v2.74.36 — On exit we also clear the per-tab sidepanel mode record so
// switching to this tab in the future doesn't auto-resume a finished
// authoring session. Snapshot for this (mode, tab) is similarly stale,
// but the shell's setMode will overwrite it on the next start.
function _exitOrReturn() {
  const tabId = _tabId ?? _payload?.existingTabId ?? null;
  if (typeof tabId === 'number') {
    chrome.runtime.sendMessage({
      type: 'CLEAR_TAB_SIDEPANEL_MODE',
      payload: { tabId },
    }).catch(() => {});
  }
  if (_payload?.returnTo === 'ground-view') {
    requestModeChange('ground-view', {});
  } else {
    exitToStudio();
  }
}

// ─── Warning helpers ─────────────────────────────────────────────────────

function _showWarning(text) {
  if (!warningEl) return;
  warningEl.textContent = text;
  warningEl.classList.remove('hidden');
}

function _hideWarning() {
  if (!warningEl) return;
  warningEl.classList.add('hidden');
  warningEl.textContent = '';
}

// ─── Pre/Postcondition capture (v2.72.67) ─────────────────────────────────

/**
 * Capture preconditions for the current fragment.
 *
 * Two paths:
 *   A. Antecedent inheritance — if the fragment has an antecedent, load
 *      the antecedent fragment's postconditions and use them as
 *      preconditions verbatim. Antecedent is authoritative for the
 *      starting state.
 *   B. Auto-capture — no antecedent, evaluate all perspectives + assertions
 *      on the Ground against the current page, return matching ones.
 *
 * Updates _preconditions and re-renders.
 */
async function _capturePreconditions() {
  if (!_payload) return;
  // v2.74.24 — Once the author has touched the preconditions list,
  // auto-capture stops overwriting it. Otherwise re-capturing after
  // an antecedent Run would silently undo the author's manual edits.
  if (_preUserModified) return;

  // Path A: antecedent inheritance.
  if (_payload.antecedentFragmentId) {
    try {
      const ante = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: 'GET_FRAGMENT',
          payload: { fragmentId: _payload.antecedentFragmentId },
        }, resolve);
      });
      const inherited = ante?.fragment?.postconditions ?? null;
      if (Array.isArray(inherited) && inherited.length > 0) {
        _preconditions = inherited.map(c => ({ ...c }));
        _preSource = `inherited from ${ante.fragment.name ?? 'antecedent'}`;
        // For inherited conditions, we still need display metadata for
        // any perspective_ref / assertion_ref entries. Resolve those via a
        // single EVALUATE call so the renderer has names to show.
        await _refreshConditionDisplay();
        _renderPreconditions();
        return;
      }
      // Antecedent has no postconditions — fall through to auto-capture.
    } catch (e) {
      console.warn('[fragment-author] antecedent inheritance threw:', e?.message);
    }
  }

  // Path B: auto-capture.
  if (_tabId == null || !_payload.groundId) {
    _preconditions = [];
    _preSource = 'tab not ready';
    _renderPreconditions();
    return;
  }
  let res;
  try {
    res = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'EVALUATE_GROUND_PREDICATES',
        payload: { tabId: _tabId, groundId: _payload.groundId },
      }, resolve);
    });
  } catch (e) {
    _preSource = `eval failed: ${e.message}`;
    _renderPreconditions();
    return;
  }
  if (!res?.success) {
    _preSource = `eval failed: ${res?.error ?? 'unknown'}`;
    _renderPreconditions();
    return;
  }

  // Cache display metadata.
  for (const loc of res.matchingPerspectives) {
    _conditionDisplay.perspectives.set(loc.id, loc);
  }
  for (const ast of res.matchingAssertions) {
    _conditionDisplay.assertions.set(ast.id, ast);
  }

  // Build the precondition list. v2.72.68 — Use the LIVE tab URL,
  // not the ground's static pattern. The live URL truthfully reflects
  // where the page is at mount time (or after antecedent setup, if no
  // inheritance happened). User can edit later in Studio's review
  // panel to make it a regex pattern if they want broader matching.
  _preconditions = [];
  const url = res.currentUrl ?? res.urlPattern ?? null;
  if (url) {
    _preconditions.push({ type: 'url_matches', pattern: url });
  }
  for (const loc of res.matchingPerspectives) {
    _preconditions.push({ type: 'perspective_ref', perspectiveId: loc.id });
  }
  for (const ast of res.matchingAssertions) {
    _preconditions.push({ type: 'assertion_ref', assertionId: ast.id });
  }
  _preSource = `auto-captured (${res.matchingPerspectives.length} perspective${res.matchingPerspectives.length === 1 ? '' : 's'}, ${res.matchingAssertions.length} assertion${res.matchingAssertions.length === 1 ? '' : 's'})`;
  _renderPreconditions();
}

/**
 * Capture postconditions = what's true on the page right now. Called
 * after every successful Verify and right before Save commits. Same
 * EVALUATE_GROUND_PREDICATES path as _capturePreconditions's auto path.
 */
async function _capturePostconditions() {
  if (!_payload) return;
  // v2.74.24 — Skip auto-capture once the author has manually edited
  // the postconditions list (mirrors the precondition path).
  if (_postUserModified) return;
  if (_tabId == null || !_payload.groundId) {
    _postconditions = [];
    _postSource = 'tab not ready';
    _renderPostconditions();
    return;
  }
  let res;
  try {
    res = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'EVALUATE_GROUND_PREDICATES',
        payload: { tabId: _tabId, groundId: _payload.groundId },
      }, resolve);
    });
  } catch (e) {
    _postSource = `eval failed: ${e.message}`;
    _renderPostconditions();
    return;
  }
  if (!res?.success) {
    _postSource = `eval failed: ${res?.error ?? 'unknown'}`;
    _renderPostconditions();
    return;
  }

  // Cache display metadata.
  for (const loc of res.matchingPerspectives) {
    _conditionDisplay.perspectives.set(loc.id, loc);
  }
  for (const ast of res.matchingAssertions) {
    _conditionDisplay.assertions.set(ast.id, ast);
  }

  _postconditions = [];
  // v2.72.68 — Use the LIVE tab URL. After a CLICK or any action that
  // navigates, this picks up the new URL — which is the whole point of
  // postconditions reflecting the current state. Falls back to the
  // ground pattern only if tabs.get failed.
  const url = res.currentUrl ?? res.urlPattern ?? null;
  if (url) {
    _postconditions.push({ type: 'url_matches', pattern: url });
  }
  for (const loc of res.matchingPerspectives) {
    _postconditions.push({ type: 'perspective_ref', perspectiveId: loc.id });
  }
  for (const ast of res.matchingAssertions) {
    _postconditions.push({ type: 'assertion_ref', assertionId: ast.id });
  }
  _postSource = `auto-captured (${res.matchingPerspectives.length} perspective${res.matchingPerspectives.length === 1 ? '' : 's'}, ${res.matchingAssertions.length} assertion${res.matchingAssertions.length === 1 ? '' : 's'})`;
  _renderPostconditions();
}

/**
 * Resolve display metadata for the current pre/post conditions by
 * evaluating against the page once. Used for the inherited-antecedent
 * path where we have condition objects but no name labels yet.
 */
async function _refreshConditionDisplay() {
  if (_tabId == null || !_payload?.groundId) return;
  try {
    const res = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'EVALUATE_GROUND_PREDICATES',
        payload: { tabId: _tabId, groundId: _payload.groundId },
      }, resolve);
    });
    if (res?.success) {
      for (const loc of res.matchingPerspectives) _conditionDisplay.perspectives.set(loc.id, loc);
      for (const ast of res.matchingAssertions) _conditionDisplay.assertions.set(ast.id, ast);
    }
  } catch (e) {
    console.warn('[fragment-author] refresh display threw:', e?.message);
  }
}

function _renderPreconditions() {
  if (!preListEl) return;
  if (preSourceEl) preSourceEl.textContent = _preSource;
  preListEl.innerHTML = _renderConditionList(_preconditions, 'pre', 'No preconditions — click + Add to create one');
  _wireConditionListHandlers('pre');
}

function _renderPostconditions() {
  if (!postListEl) return;
  if (postSourceEl) postSourceEl.textContent = _postSource;
  postListEl.innerHTML = _renderConditionList(_postconditions, 'post', 'No postconditions — click + Add to create one');
  _wireConditionListHandlers('post');
}

// v2.74.24 — Editable condition list. Mirrors the Studio Edit-Fragment
// review panel: each row is a [type-dropdown] [type-specific input(s)]
// [✕] triple. Page-family types (selector_present/absent, url_matches,
// text_present, attribute_equals) plus Custom (library assertions) and
// Perspectives optgroups when the ground has them. Reuses .cond-editor,
// .cond-type-select, .cond-value-input, .review-condition-row styles
// from sidepanel.css so the visual matches Studio's review panel.
function _renderConditionList(conditions, side, emptyMsg) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return `<div class="fa-conditions-empty">${escHtml(emptyMsg)}</div>`;
  }
  return conditions.map((c, idx) => _renderConditionRow(c, side, idx)).join('');
}

function _renderConditionRow(c, side, idx) {
  const type = c?.type ?? 'selector_present';
  const attrs = `data-fa-cond="1" data-side="${escAttr(side)}" data-idx="${idx}"`;
  let valueHtml;
  if (type === 'selector_present' || type === 'selector_absent') {
    valueHtml = `<input type="text" class="cond-value-input" ${attrs} data-field="selector"
                        value="${escAttr(c?.selector ?? '')}"
                        placeholder="CSS selector, e.g. .job-detail.loaded" />`;
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
  } else if (type === 'assertion_ref') {
    const meta = _groundAssertions.find(p => p.id === c?.assertionId)
              || _conditionDisplay.assertions.get(c?.assertionId);
    if (meta) {
      const desc = meta.description ?? '';
      valueHtml = desc
        ? `<span class="cond-pred-hint" title="${escAttr(meta.name ?? meta.id)}">${escHtml(desc)}</span>`
        : `<span class="cond-pred-hint cond-pred-hint-empty">no description</span>`;
    } else if (c?.assertionId) {
      valueHtml = `<span class="cond-pred-hint cond-pred-hint-stale">missing assertion: ${escHtml(c.assertionId)}</span>`;
    } else {
      valueHtml = `<span class="cond-pred-hint cond-pred-hint-empty">— pick an assertion from the dropdown —</span>`;
    }
  } else if (type === 'perspective_ref') {
    const meta = _groundPerspectives.find(l => l.id === c?.perspectiveId)
              || _conditionDisplay.perspectives.get(c?.perspectiveId);
    if (meta) {
      const lmCount = Array.isArray(meta.landmarks)
        ? meta.landmarks.length
        : (meta.landmarkCount ?? 0);
      const firstRole = meta.landmarks?.[0]?.alias ?? '';
      const summary = lmCount > 0
        ? `${lmCount} landmark${lmCount === 1 ? '' : 's'}${firstRole ? ` · ${firstRole}${lmCount > 1 ? '…' : ''}` : ''}`
        : 'no landmarks';
      valueHtml = `<span class="cond-pred-hint" title="${escAttr(meta.description ?? '')}">${escHtml(summary)}</span>`;
    } else if (c?.perspectiveId) {
      valueHtml = `<span class="cond-pred-hint cond-pred-hint-stale">missing perspective: ${escHtml(c.perspectiveId)}</span>`;
    } else {
      valueHtml = `<span class="cond-pred-hint cond-pred-hint-empty">— pick a perspective from the dropdown —</span>`;
    }
  } else {
    valueHtml = `<span class="cond-pred-hint cond-pred-hint-empty">unsupported type: ${escHtml(type)}</span>`;
  }
  const typeOpts = _buildConditionTypeOptions(c);
  return `
    <div class="review-condition-row" data-idx="${idx}">
      <div class="cond-editor" ${attrs}>
        <select class="cond-type-select" ${attrs}>${typeOpts}</select>
        ${valueHtml}
      </div>
      <button class="btn-action danger review-cond-remove" ${attrs} type="button" title="Remove">✕</button>
    </div>`;
}

// Build the type dropdown options. Page-family types (visible set matches
// Studio's review panel: selector_present/absent, text_present,
// attribute_equals under Page · DOM; url_matches under Page · Browser),
// plus Custom (library assertions on this ground) and Perspectives optgroups.
// Library assertions / perspectives encode as synthetic `pred_ref:<id>` /
// `loc_ref:<id>` values which _decodeConditionTypeValue unpacks.
function _buildConditionTypeOptions(c) {
  const currentType = c?.type ?? 'selector_present';
  const currentPredId = c?.assertionId ?? '';
  const currentPerspectiveId = c?.perspectiveId ?? '';
  const opt = (value, label, selected) =>
    `<option value="${escAttr(value)}"${selected ? ' selected' : ''}>${escHtml(label)}</option>`;

  const groups = [];

  const PAGE_DOM = [
    ['selector_present', 'selector appears'],
    ['selector_absent',  'selector disappears'],
    ['text_present',     'text appears'],
    ['attribute_equals', 'attribute equals'],
  ];
  groups.push(`<optgroup label="Page · DOM">${
    PAGE_DOM.map(([t, l]) => opt(t, l, t === currentType)).join('')
  }</optgroup>`);

  groups.push(`<optgroup label="Page · Browser">${
    opt('url_matches', 'URL matches', currentType === 'url_matches')
  }</optgroup>`);

  if (_groundAssertions.length > 0) {
    const sorted = [..._groundAssertions].sort((a, b) => {
      const an = (a.name ?? a.id ?? '').toLowerCase();
      const bn = (b.name ?? b.id ?? '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const opts = sorted.map(p =>
      opt(`pred_ref:${p.id}`, p.name ?? p.id, currentType === 'assertion_ref' && currentPredId === p.id)
    ).join('');
    groups.push(`<optgroup label="Custom">${opts}</optgroup>`);
  }
  // Stale assertion_ref → show a 'missing' option so the dropdown can
  // reflect the stored condition; the author can pick a different option
  // to replace it.
  if (currentType === 'assertion_ref' && currentPredId) {
    const inList = _groundAssertions.some(p => p.id === currentPredId);
    if (!inList) {
      groups.push(`<optgroup label="Custom · Stale">${
        opt(`pred_ref:${currentPredId}`, `(missing: ${currentPredId})`, true)
      }</optgroup>`);
    }
  }

  if (_groundPerspectives.length > 0) {
    const sorted = [..._groundPerspectives].sort((a, b) => {
      const an = (a.name ?? a.id ?? '').toLowerCase();
      const bn = (b.name ?? b.id ?? '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const opts = sorted.map(l => {
      const lmCount = Array.isArray(l.landmarks) ? l.landmarks.length : 0;
      const label = `${l.name ?? l.id} (${lmCount} landmark${lmCount === 1 ? '' : 's'})`;
      return opt(`loc_ref:${l.id}`, label, currentType === 'perspective_ref' && currentPerspectiveId === l.id);
    }).join('');
    groups.push(`<optgroup label="Perspectives">${opts}</optgroup>`);
  }
  if (currentType === 'perspective_ref' && currentPerspectiveId) {
    const inList = _groundPerspectives.some(l => l.id === currentPerspectiveId);
    if (!inList) {
      groups.push(`<optgroup label="Perspectives · Stale">${
        opt(`loc_ref:${currentPerspectiveId}`, `(missing: ${currentPerspectiveId})`, true)
      }</optgroup>`);
    }
  }
  return groups.join('');
}

function _decodeConditionTypeValue(value) {
  if (typeof value === 'string' && value.startsWith('pred_ref:')) {
    return { type: 'assertion_ref', assertionId: value.slice('pred_ref:'.length) };
  }
  if (typeof value === 'string' && value.startsWith('loc_ref:')) {
    return { type: 'perspective_ref', perspectiveId: value.slice('loc_ref:'.length) };
  }
  return { type: value };
}

// Wire change/input/click handlers on the editable row controls. Each
// row's data-side / data-idx attributes route mutations to the right
// array entry; first touch flips _pre/_postUserModified so subsequent
// auto-capture sweeps don't clobber the author's edits.
function _wireConditionListHandlers(side) {
  const listEl = side === 'pre' ? preListEl : postListEl;
  if (!listEl) return;
  const arr = side === 'pre' ? _preconditions : _postconditions;

  listEl.querySelectorAll('select.cond-type-select[data-fa-cond="1"]').forEach(sel => {
    if (sel.dataset.side !== side) return;
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.idx, 10);
      const decoded = _decodeConditionTypeValue(sel.value);
      const fresh = emptyCondition(decoded.type);
      if (decoded.assertionId) fresh.assertionId = decoded.assertionId;
      if (decoded.perspectiveId)    fresh.perspectiveId    = decoded.perspectiveId;
      arr[idx] = fresh;
      _markConditionsUserModified(side);
      side === 'pre' ? _renderPreconditions() : _renderPostconditions();
    });
  });

  listEl.querySelectorAll('input.cond-value-input[data-fa-cond="1"]').forEach(inp => {
    if (inp.dataset.side !== side) return;
    const handler = () => {
      const idx = parseInt(inp.dataset.idx, 10);
      const cond = arr[idx];
      if (!cond) return;
      const field = inp.dataset.field;
      const schema = CONDITION_FIELDS[cond.type];
      if (schema && schema.fields.includes(field)) {
        cond[field] = inp.value;
        _markConditionsUserModified(side);
      }
    };
    inp.addEventListener('input', handler);
  });

  listEl.querySelectorAll('button.review-cond-remove[data-fa-cond="1"]').forEach(btn => {
    if (btn.dataset.side !== side) return;
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      arr.splice(idx, 1);
      _markConditionsUserModified(side);
      side === 'pre' ? _renderPreconditions() : _renderPostconditions();
    });
  });
}

function _markConditionsUserModified(side) {
  if (side === 'pre')  _preUserModified  = true;
  if (side === 'post') _postUserModified = true;
  const sourceEl = side === 'pre' ? preSourceEl : postSourceEl;
  if (sourceEl) sourceEl.textContent = 'edited';
}

function _onAddCondition(side) {
  const arr = side === 'pre' ? _preconditions : _postconditions;
  arr.push(emptyCondition('selector_present'));
  _markConditionsUserModified(side);
  side === 'pre' ? _renderPreconditions() : _renderPostconditions();
}

// v2.74.24 — Fetch the active Ground so the type dropdown can offer
// the Custom (library assertions) and Perspectives optgroups. Cached for
// the lifetime of the mode mount; cleared in unmount.
async function _loadGroundCatalog() {
  if (!_payload?.groundId) return;
  try {
    const res = await new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: 'GET_GROUND', payload: { id: _payload.groundId } },
        resolve
      );
    });
    if (res?.success && res.ground) {
      _groundPerspectives    = Array.isArray(res.ground.perspectives)    ? res.ground.perspectives    : [];
      _groundAssertions = Array.isArray(res.ground.assertions) ? res.ground.assertions : [];
      // v2.74.275 — Hydrate perspective.landmarks from registry. Legacy
      // embedded landmarks[] shape removed; perspectives store
      // landmarkRefs[] (uids) only. Fetch the records once on load
      // so the synchronous _flatLandmarksForGround() can build
      // dropdowns without async round-trips per render.
      try {
        const allRefs = new Set();
        for (const l of _groundPerspectives) {
          if (Array.isArray(l.landmarkRefs)) for (const u of l.landmarkRefs) allRefs.add(u);
        }
        if (allRefs.size > 0) {
          const lmRes = await new Promise(r => chrome.runtime.sendMessage({
            type: 'GET_LANDMARKS', payload: { uids: Array.from(allRefs) },
          }, r));
          if (lmRes?.success && lmRes.landmarks) {
            for (const l of _groundPerspectives) {
              if (!Array.isArray(l.landmarkRefs)) { l.landmarks = []; continue; }
              l.landmarks = l.landmarkRefs.map(u => lmRes.landmarks[u]).filter(Boolean);
            }
          }
        }
      } catch (e) {
        console.warn('[fragment-author] landmark hydration failed:', e?.message);
      }
      // Re-render so any currently-displayed conditions pick up the
      // newly-loaded dropdown options (e.g. an assertion_ref that
      // arrived before the ground catalog finished loading).
      _renderPreconditions();
      _renderPostconditions();
      // v2.74.237 — Wave 3 bug: actions with landmarkRef render their
      // chip via _groundPerspectives.find(...).name. On a fresh load
      // _groundPerspectives is empty until GET_GROUND completes, so the
      // chip falls back to perspectiveId. Re-render now that we have
      // names — also surfaces the landmark dropdown on actions that
      // had no usable landmarks before the cache populated.
      _renderActions();
    }
  } catch (e) {
    console.warn('[fragment-author] GET_GROUND threw:', e?.message);
  }
}

// ─── Module export ───────────────────────────────────────────────────────

// v2.74.36 — getState returns a serializable snapshot of authoring
// state. The shell captures this before unmount so that switching
// tabs (or otherwise re-mounting this mode for the same fragment+tab)
// resumes from the same point. Only the fields restored in mount()
// need to appear here.
function getState() {
  if (!_payload) return null;
  return {
    // v2.74.40 — tabId is the single most important field for a resumed
    // session. Without it, Pick / Verify / capture-conditions all fail
    // because they have no tab to dispatch against.
    tabId                 : _tabId,
    actions               : _actions,
    preconditions         : _preconditions,
    postconditions        : _postconditions,
    savedChain            : _savedChain,
    preSource             : _preSource,
    postSource            : _postSource,
    preUserModified       : _preUserModified,
    postUserModified      : _postUserModified,
    anteCardCollapsed     : _anteCardCollapsed,
    preCardCollapsed      : _preCardCollapsed,
    postCardCollapsed     : _postCardCollapsed,
    actionsCardCollapsed  : _actionsCardCollapsed,
    anteLastActionCount   : _anteLastActionCount,
    anteRunMode           : _anteRunMode,
  };
}

export default {
  name: 'fragment-author',
  mount,
  unmount,
  handleEvent,
  getState,
};
