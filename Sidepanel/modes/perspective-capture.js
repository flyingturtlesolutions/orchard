/**
 * @file Sidepanel/modes/perspective-capture.js
 * @description Perspective-capture sidepanel mode. Extracted from debugger.js
 * during Stage 1 of the multi-mode-sidepanel refactor (v2.72.50).
 *
 * Lifecycle:
 *   mount(payload, mountEl)    — render HTML, wire listeners, fetch session
 *   unmount()                   — remove listeners, clear state
 *   handleEvent(message)        — receive forwarded chrome.runtime messages
 *
 * Payload contract:
 *   { groundId, tabId?, sessionId? }
 *   - groundId is required (which Ground we're authoring perspectives for)
 *   - tabId/sessionId are populated from background's pending capture
 *     session if present; otherwise the mode falls back to active-tab
 *     tracking
 *
 * The mode is self-contained: it does NOT import from shell.js, debugger.js,
 * or other mode modules. All cross-mode interaction goes through:
 *   - shell-api.js (toast, getActiveTab, pingContentScript, requestModeChange)
 *   - chrome.runtime.sendMessage (background coordination)
 *
 * @module Sidepanel/modes/perspective-capture
 * @author Agent HUB
 * @version 2.72.50
 */

import { toast, getActiveTab, pingContentScript, exitToStudio, requestModeChange } from '../shell-api.js';
// v2.74.166 — Frame-aware picker broadcast — same path fragment-author
// and observation-author use, so perspective landmarks can target same-origin
// iframes too.
import { broadcastStartPick, broadcastCancelPick } from '../../shared.js';
// v2.74.231 — Auto-generate description from landmarks on save when
// the author left it blank (mirrors the fragment-author / observation-
// author pattern). Pure function, no DOM, no I/O.
import { composeCompactDescription } from '../../Services/PerspectiveDescription.js';
import { subscribe as subscribeGroundEvents } from '../../Services/GroundEventBus.js';
import { isPerspectiveActive } from '../../Services/PerspectivePredicates.js';
// v2.74.232 — Logger so "Ask Claude" suggestion outcomes land in the
// Logs tab alongside the equivalents in fragment-author / observation-
// author.
import { Logger } from '../../Core/Logger.js';
// v2.74.336 — Phase C-lite: flatten LandmarkNode trees for save-time coverage.
import { flattenLandmarkNodes } from '../../Core/perspectiveComposition.js';
// v2.74.234 — Wave 1 of the landmark SSOT project. Pure helpers that
// derive capabilities, allowed operations, and a verification score
// from the INSPECT_ELEMENT fingerprint. Persisted on the landmark
// record so downstream consumers (fragment actions, observation
// extracts) can filter their dropdowns without re-running checks.
import {
  deriveCapabilities,
  deriveAllowedOperations,
  computeVerificationScore,
  // v2.74.288 — Tier classifier for selector authority comparison.
  // Picker's rule-based selector is the floor; Claude's Wave-2
  // proposal is adopted only when it scores a STRICTLY lower tier
  // (= more stable discriminator).
  classifySelectorTier,
} from '../../Services/LandmarkProfile.js';

// ─── Module-local state ───────────────────────────────────────────────────
//
// All state is module-scoped — there's only ever one perspective-capture mode
// active at a time. unmount() clears everything.

let _perspectiveDraft = null;             // working copy of the perspective being authored
let _perspectiveGroundId = null;          // session-scoped: which Ground
let _perspectiveTabId = null;             // currently-tracked tab (the active tab)
// v2.74.33 — Where Save / Cancel should send the user. 'ground-view' =
// switch back to the Ground sidepanel mode; otherwise exitToStudio.
let _perspectiveReturnTo = null;
// v2.74.47 — Edit mode flag. Set when prefilledPerspective carries an `id`
// (Ground sidepanel's ✎ edit-perspective path). When true, refreshPerspective
// ActiveTab skips overwriting the URL-pattern input with the active
// tab's URL — the saved pattern is preserved.
let _perspectiveIsEdit = false;
let _perspectivePickerSession = null;     // {sessionId, landmarkIdx, roleSlot?} when picking
let _mountEl = null;              // root element we rendered into
// v2.74.348/350/366 — PERSPECTIVE_SPEC § 13 description-first proposal flow state.
// v2.74.366 collapsed the baseline/enhanced A/B to a single canonical
// (always-enhanced) run.
// _perspectiveRun: { options:[...], elapsedMs, meta } or null — the latest
//   proposal (screenshot + sibling-Perspective/registry context).
// _chosenPerspective: the option object the user picked; its roles drive the
//   role-fill checklist. _chosenPerspectiveIdx is its index in _perspectiveRun.
// _perspectiveInFlight: true while a proposal round-trips.
let _perspectiveRun = null;
let _chosenPerspective = null;
let _chosenPerspectiveIdx = null;
let _perspectiveInFlight = false;
// v2.74.352 — "Resolve roles" in flight key: "<idx>" or "retry:<idx>" of the
// option being auto-resolved, or null. Disables the propose/use/resolve buttons.
let _resolveInFlightKey = null;
// v2.74.353 — Latest page-complexity report (resolve-difficulty metric) for the
// current tab, or null. Surfaced as the header badge + logged with each Resolve
// run so success rate can be plotted against difficulty.
let _pageComplexity = null;
// v2.74.355 — Per-role notes from the last Resolve run: role -> { status, reason }
// for roles that failed verification or were abstained. Rendered inline under
// the unfilled role in the checklist; cleared when the role is filled manually.
let _roleResolveNotes = {};
// v2.74.368 — pageStructure depth-exploration state. The "+ Perspective" flow can
// run a poke→observe→restore sweep over the page so propose-perspectives sees
// post-interaction content (modal sections, dropdown menus). The artifact is
// cached in the background per (ground, url); this just tracks the UI status.
//   _pageStructureStatus: 'none' | 'fresh' | 'building' | 'built' | 'skipped' | 'failed'
//   _pageStructureInfo:   { controls, revealing, totalRevealed, capturedAt } | null (summary for the chip)
//   _exploreToken:        bumped to soft-cancel an in-flight sweep (ignore its landing result)
let _pageStructureStatus = 'none';
let _pageStructureInfo = null;
let _exploreToken = 0;
// v2.74.393 — Grounded-intent state. The user's raw Intent can be refined
// against the page's affordances (cached from Explore) into a "grounded intent"
// they accept/edit before it seeds propose.
//   _groundIntentResult: { groundedIntent, achievable:'yes'|'partial'|'no'|'unknown', note, forIntent } | null
//   _groundInFlight: true while the grounding call round-trips.
let _groundIntentResult = null;
let _groundInFlight = false;
// v2.74.233 — Per-landmark "refining with Claude" status text. Set on
// the landmark idx when the picker just captured and Claude is being
// invoked to refine; cleared when Claude responds (success or fail).
// Surface text is shown inline below the landmark row so the author
// knows pick is still in flight.
let _landmarkRefining = new Map();
// v2.74.235 — Per-landmark profile drawer expansion state. Ephemeral
// (not saved). Drawer is collapsed by default — author clicks to
// expand. Auto-expands after a fresh Pick→Claude completes so the
// author sees the generated profile immediately and can review/edit.
let _landmarkProfileExpanded = new Set();
// v2.74.257 — Phase 10/10.5 surface: in-row replacement picker state.
//   _landmarkReplaceOpen[idx]: 'loading' | 'ready' | 'error' | absent
//   _landmarkReplaceCandidates[idx]: candidate array from Phase 10.5
// Both are ephemeral (not persisted). Opening the picker triggers a
// FIND_REPLACEMENT_CANDIDATES call; clicking a candidate triggers a
// REPLACE_LANDMARK_REFERENCES dry-run preview then commit-on-confirm.
let _landmarkReplaceOpen       = new Map();
let _landmarkReplaceCandidates = new Map();
let _landmarkReplaceError      = new Map();
// v2.74.258 — Phase 9 surface: per-row Verify state.
//   _landmarkVerifyInFlight[idx]: true while VERIFY_LANDMARK runs
//   _landmarkVerifyOutcome[idx]: last outcome { via, error?, ts }
// Outcome banner clears on next Pick / lifecycle-changing edit;
// in-flight state blocks repeated clicks during the round-trip.
let _landmarkVerifyInFlight = new Set();
let _landmarkVerifyOutcome  = new Map();
// v2.74.259 — Phase 8 surface: substrate events panel state.
//   _eventsExpanded: open/closed
//   _eventsCache: last fetched events array
//   _eventsLandmarkNames: uid → accessibleName lookup populated lazily
//   _eventsLoading: in-flight flag to avoid duplicate fetches
let _eventsExpanded       = false;
let _eventsCache          = null;
let _eventsLandmarkNames  = new Map();
let _eventsLoading        = false;
// DOM refs for events panel (resolved in mount).
let perspectiveEventsToggleBtn   = null;
let perspectiveEventsBody        = null;
let perspectiveEventsList        = null;
let perspectiveEventsCount       = null;
let perspectiveEventsClearBtn    = null;
// v2.74.262 — Bulk verify affordance refs + in-flight flag.
let perspectiveEventsStaleBadge   = null;
let perspectiveEventsVerifyAllBtn = null;
let perspectiveEventsBulkOutcome  = null;
let _eventsBulkVerifyInFlight = false;
// v2.74.272 — Health summary banner state. Re-rendered on initial
// fetch, after bulk-verify, and (cheaply) on each new live event.
// Stores the last-fetched landmark snapshot so live event additions
// can recompute without an extra LIST_LANDMARKS_FOR_GROUND round-trip.
let perspectiveEventsHealth     = null;
let _eventsLandmarksCache = [];
// v2.74.263 — Live event streaming. While the events panel is open,
// chrome.storage.onChanged fires for new GroundEventBus writes;
// subscribe() wraps that and invokes the callback with diffed-new
// events. Unsubscribe handle is tracked so close/unmount tears down.
let _eventsUnsubscribe = null;
// v2.74.266 — Phase 6.5 closure: drift-confirmation UX. Tracks which
// landmark-effect-drift events have been applied this session
// (proposedEffect → observedEffect) so the row shows "✓ Applied"
// instead of the Apply button. Ephemeral (session-scoped); the
// substrate-level effect of the update is permanent via
// updateLandmark, which would suppress future drift events for the
// same effect mismatch automatically.
let _eventsAppliedDrift = new Set();
let _eventsApplyInFlight = new Set();
// v2.74.260 — Phase 7d surface: predicate authoring DOM refs.
let perspectivePredicatesList   = null;
let perspectivePredicatesAddBtn = null;
// v2.74.271 — Top-level operator selector. The draft's predicates may
// be stored as either a plain array (implicit AND) or a tree object
// { operator, children }. _predicatesOperator tracks the authored
// top-level operator separately so we can serialize back to either
// shape on save.
let perspectivePredicatesOpSelect = null;
let perspectivePredicatesHint     = null;
let _predicatesOperator   = 'and';
// v2.74.267 — iframe contexts editor DOM refs + ephemeral test state.
//   _iframeTestOutcome[idx] = { kind: 'ok'|'absent'|'error', message, sameOrigin? }
let perspectiveIframeContextsList = null;
let perspectiveIframeContextsAdd  = null;
let _iframeTestOutcome    = new Map();
let _iframeTestInFlight   = new Set();
// v2.74.265 — Active-state preview refs + state. Last evaluation is
// cached so the section shows something meaningful while a fresh
// evaluation runs in the background (avoids "blank" flicker).
let perspectiveActiveStateRefreshBtn = null;
let perspectiveActiveStateResult     = null;
let _activeStateEvaluating   = false;
let _activeStateDebounce     = null;

// Listeners we registered, captured so unmount can remove them.
let _onTabActivated = null;
let _onTabUpdated = null;
let _onKeyDown = null;
// v2.74.46 — Focus / blur handlers on the sidepanel window. While the
// panel is focused, verified-landmark overlays are drawn on the
// authoring tab; when the user clicks away to interact with the page,
// the overlays clear so they don't obstruct interaction. Coming back
// to the panel redraws them.
let _onPanelFocus = null;
let _onPanelBlur = null;

// DOM refs populated on mount. All are scoped to _mountEl.
let perspectiveGroundLabelEl = null;
let perspectiveTabUrlEl = null;
let perspectiveWarningEl = null;
let perspectiveNameInput = null;
let perspectiveDescriptionInput = null;
let perspectiveBody = null;   // v2.74.348 — § 13 proposal-flow container
let perspectiveComplexityBadge = null;   // v2.74.353 — resolve-difficulty header badge
// v2.74.275 — perspectivePatternInput removed.
let perspectiveLandmarksList = null;
let perspectiveAddLandmarkBtn = null;
let perspectiveSaveBtn = null;
let perspectiveCancelBtn = null;
// v2.74.282 — Reason hint shown when Save Perspective is disabled.
let perspectiveSaveReasonEl = null;
let perspectivePickBanner = null;
let perspectivePickCancelBtn = null;

// ─── HTML template ────────────────────────────────────────────────────────

function renderHTML() {
  return `
    <div class="dbg-perspective">
      <header class="dbg-perspective-header">
        <div class="dbg-perspective-title-row">
          <span class="dbg-perspective-badge">Perspective capture</span>
          <span data-perspective="ground-label" class="dbg-perspective-ground-label">on Ground: —</span>
        </div>
        <div class="dbg-perspective-meta">
          <span class="dbg-perspective-meta-label">Active tab</span>
          <span data-perspective="tab-url" class="dbg-perspective-meta-value mono">—</span>
        </div>
        <div class="dbg-perspective-meta">
          <span class="dbg-perspective-meta-label">Resolve difficulty</span>
          <span data-perspective="complexity-badge" class="dbg-perspective-complexity" title="How hard this page is for ⚡ Resolve roles (selector resolution).">—</span>
        </div>
        <div data-perspective="warning" class="dbg-perspective-warning hidden"></div>
      </header>

      <section class="dbg-perspective-meta-card dbg-perspective-card" data-card-id="meta">
        <button type="button" class="dbg-perspective-card-head" data-card-toggle aria-expanded="true">
          <span class="dbg-perspective-card-chevron">▾</span>
          <span class="dbg-perspective-card-label">Perspective</span>
        </button>
        <div class="dbg-perspective-card-body">
          <label class="dbg-perspective-field">
            <span class="dbg-perspective-field-label">Name</span>
            <input type="text" data-perspective="name-input" maxlength="80"
                   placeholder="e.g. search-results-page" />
          </label>
          <label class="dbg-perspective-field">
            <span class="dbg-perspective-field-label">Intent</span>
            <textarea data-perspective="description-input" rows="2" maxlength="280"
                      placeholder="What do you want to accomplish on this kind of page?"></textarea>
          </label>
        </div>
        <!-- v2.74.275 — Legacy urlPattern field REMOVED. URL gating
             now expressed exclusively via a urlMatches predicate in
             the Additional predicates section. New perspectives auto-seed
             a urlMatches predicate from the current tab URL on first
             Pick (see refreshPerspectiveActiveTab). -->
      </section>

      <!-- v2.74.348 — PERSPECTIVE_SPEC § 13 description-first proposal flow.
           The intent (Description above) seeds an LLM call that proposes
           2-3 perspective OPTIONS, each a named set of landmark ROLES to
           fill. The user picks an option, then fills each role via the
           picker. Body is rendered dynamically by _renderPerspectivePanel. -->
      <section class="dbg-perspective-perspective dbg-perspective-card" data-card-id="perspective">
        <div class="dbg-perspective-card-head-row">
          <button type="button" class="dbg-perspective-card-head" data-card-toggle aria-expanded="true">
            <span class="dbg-perspective-card-chevron">▾</span>
            <span class="dbg-perspective-card-label">Perspective (LLM-assisted)</span>
            <span class="dbg-perspective-card-optional">(optional)</span>
          </button>
        </div>
        <div class="dbg-perspective-card-body">
          <div data-perspective="perspective-body" class="dbg-perspective-perspective-body"></div>
        </div>
      </section>

      <!-- v2.74.283 — Outdated instructions block removed. The empty-
           state hint in the Landmarks card now carries the same info
           ("No landmarks yet — click + Pick landmark to add one.")
           and the + Pick landmark button enters pick mode directly,
           so the "click Pick to enter pick-mode" guidance is obsolete. -->

      <!-- v2.74.267 — iframe contexts editor. Phase 7a/7b authoring
           was previously a side-effect of Pick→Claude when an iframe
           landmark was picked; this section makes the contexts
           authorable directly. Authors can rename contexts (cascades
           to referencing landmarks), edit predicates per kind, test
           predicates against the live page, and remove contexts
           (with warning if landmarks reference them). -->
      <section class="dbg-perspective-iframe-contexts dbg-perspective-card" data-card-id="iframe-contexts">
        <div class="dbg-perspective-card-head-row">
          <button type="button" class="dbg-perspective-card-head" data-card-toggle aria-expanded="true">
            <span class="dbg-perspective-card-chevron">▾</span>
            <span class="dbg-perspective-card-label">iframe contexts</span>
            <span class="dbg-perspective-card-optional">(optional)</span>
          </button>
          <button data-perspective="iframe-contexts-add" class="btn-secondary tiny" type="button">+ Add iframe context</button>
        </div>
        <div class="dbg-perspective-card-body">
          <div data-perspective="iframe-contexts-list" class="dbg-perspective-iframe-contexts-list">
            <div class="dbg-perspective-iframe-contexts-empty">No iframe contexts. Landmarks picked from iframes auto-populate this list.</div>
          </div>
          <p class="dbg-perspective-iframe-contexts-hint">
            Each context names an iframe by a predicate (name, selector, src pattern, or position). Landmarks bind to a context by name, so the engine can route to the right iframe even when its src changes between runs.
          </p>
        </div>
      </section>

      <!-- v2.74.260 — Phase 7d surface: additional predicates. The
           URL pattern above remains the primary URL gate (legacy
           shape). Additional predicates AND with it at runtime via
           PerspectivePredicates.isPerspectiveActive, gating which Perspective is
           active for the current page state. Tree-form operators
           (OR / NOT) are not authorable in this MVP — single-level
           AND covers the common case. Edit raw perspective.predicates in
           storage for OR/NOT until a tree editor lands. -->
      <section class="dbg-perspective-predicates dbg-perspective-card" data-card-id="predicates">
        <div class="dbg-perspective-card-head-row">
          <button type="button" class="dbg-perspective-card-head" data-card-toggle aria-expanded="true">
            <span class="dbg-perspective-card-chevron">▾</span>
            <span class="dbg-perspective-card-label">Additional predicates</span>
            <span class="dbg-perspective-card-optional">(optional)</span>
          </button>
          <label class="dbg-perspective-predicates-op-label">
            <span>combine with</span>
            <select data-perspective="predicates-operator" class="dbg-perspective-predicates-operator">
              <option value="and">AND (all must pass)</option>
              <option value="or">OR (any must pass)</option>
              <option value="not">NOT (single predicate, negated)</option>
            </select>
          </label>
          <button data-perspective="predicates-add" class="btn-secondary tiny" type="button">+ Add predicate</button>
        </div>
        <div class="dbg-perspective-card-body">
          <div data-perspective="predicates-list" class="dbg-perspective-predicates-list">
            <div class="dbg-perspective-predicates-empty">No additional predicates. Perspective activates on URL pattern match alone.</div>
          </div>
          <p class="dbg-perspective-predicates-hint" data-perspective="predicates-hint">
            Perspective is active when URL pattern matches AND every predicate below evaluates true. Unverifiable predicates (e.g., landmark not on page) fail closed.
          </p>
        </div>
      </section>

      <section class="dbg-perspective-landmarks dbg-perspective-card" data-card-id="landmarks">
        <div class="dbg-perspective-card-head-row">
          <button type="button" class="dbg-perspective-card-head" data-card-toggle aria-expanded="true">
            <span class="dbg-perspective-card-chevron">▾</span>
            <span class="dbg-perspective-card-label">Landmarks</span>
          </button>
        </div>
        <div class="dbg-perspective-card-body">
          <div data-perspective="landmarks-list" class="dbg-perspective-landmarks-list">
            <div class="dbg-perspective-landmarks-empty">No landmarks yet.</div>
          </div>
          <div class="dbg-perspective-landmarks-footer">
            <button data-perspective="add-landmark" class="btn-secondary tiny" type="button" title="Click, then pick an element on the page. The landmark card appears after the pick is complete and Claude refines the selector.">+ Pick landmark</button>
          </div>
        </div>
      </section>

      <!-- v2.74.259 — Phase 8 surface: ground event log. Collapsed by
           default so it doesn't crowd the row when the author isn't
           investigating. Click the header to expand; fetch fires
           per-open. Count badge previews how many events are in the
           ring buffer when the panel is closed. -->
      <!-- v2.74.265 — Perspective active-state preview. Substrate's
           isPerspectiveActive evaluator (Phase 7d) is invoked against the
           current tab + draft state on mount and on demand via the
           refresh button. Surfaces ✓/✗/⚠ with per-leaf reasons so
           authors can see WHY a predicate fails (e.g., "landmark not
           visible on page" vs "URL pattern doesn't match"). -->
      <section class="dbg-perspective-active-state dbg-perspective-card" data-card-id="active-state">
        <div class="dbg-perspective-card-head-row">
          <button type="button" class="dbg-perspective-card-head" data-card-toggle aria-expanded="true">
            <span class="dbg-perspective-card-chevron">▾</span>
            <span class="dbg-perspective-card-label">Active state preview</span>
          </button>
          <button data-perspective="active-state-refresh" class="btn-secondary tiny" type="button" title="Re-evaluate predicates against the current tab">Refresh</button>
        </div>
        <div class="dbg-perspective-card-body">
          <div data-perspective="active-state-result" class="dbg-perspective-active-state-result">
            <span class="dbg-perspective-active-state-loading">⌛ Evaluating…</span>
          </div>
        </div>
      </section>

      <section class="dbg-perspective-events" data-perspective="events-section">
        <button class="dbg-perspective-events-header" data-perspective="events-toggle" type="button" aria-expanded="false">
          <span class="dbg-perspective-events-chevron">▸</span>
          <span class="dbg-perspective-events-label">Substrate events</span>
          <span class="dbg-perspective-events-count" data-perspective="events-count"></span>
          <span class="dbg-perspective-events-stale-badge hidden" data-perspective="events-stale-badge" title="Landmarks on this Ground currently marked stale-suspected"></span>
        </button>
        <div class="dbg-perspective-events-body hidden" data-perspective="events-body">
          <!-- v2.74.272 — Health summary banner. Aggregates from the
               already-fetched landmarks (lifecycle counts) and events
               (recent activity by kind). Single-glance overview of
               Ground-wide substrate state. -->
          <div class="dbg-perspective-events-health" data-perspective="events-health"></div>
          <div class="dbg-perspective-events-list" data-perspective="events-list"></div>
          <div class="dbg-perspective-events-bulk-outcome hidden" data-perspective="events-bulk-outcome"></div>
          <div class="dbg-perspective-events-footer">
            <span class="dbg-perspective-events-hint">Per-Ground ring buffer (max 200 events). Includes runtime recovery, verifier outcomes, and action-effect observations.</span>
            <button class="btn-secondary tiny" data-perspective="events-verify-all" type="button" title="Re-probe every landmark currently in stale-suspected. Cached selector works → verified. Heuristic recovery → verified + selector updated. Both fail → stale-confirmed.">Verify all stale</button>
            <button class="btn-secondary tiny" data-perspective="events-clear" type="button" title="Clear the event log for this Ground">Clear log</button>
          </div>
        </div>
      </section>

      <section class="dbg-perspective-actions">
        <!-- v2.74.282 — Reason hint surfaces the first blocking
             condition when the Save button is disabled, so authors
             don't have to guess what's missing. Hidden when save is
             enabled. Title attribute on the button mirrors the
             text for hover discoverability. -->
        <div data-perspective="save-reason" class="dbg-perspective-save-reason hidden"></div>
        <div class="dbg-perspective-actions-buttons">
          <button data-perspective="save" class="btn-primary" type="button" disabled>Save Perspective</button>
          <button data-perspective="cancel" class="btn-secondary" type="button">Cancel</button>
        </div>
      </section>

      <div data-perspective="pick-banner" class="dbg-perspective-pick-banner hidden">
        <span class="dbg-perspective-pick-text">Click an element on the page to pick a selector. Press Esc to cancel.</span>
        <button data-perspective="pick-cancel" class="btn-secondary tiny" type="button">Cancel pick</button>
      </div>
    </div>
  `;
}

// ─── Mount ────────────────────────────────────────────────────────────────

async function mount(payload, mountEl) {
  _mountEl = mountEl;
  mountEl.innerHTML = renderHTML();

  // Resolve DOM refs (scoped to mountEl).
  const q = (sel) => mountEl.querySelector(`[data-perspective="${sel}"]`);
  perspectiveGroundLabelEl   = q('ground-label');
  perspectiveTabUrlEl        = q('tab-url');
  perspectiveWarningEl       = q('warning');
  perspectiveNameInput       = q('name-input');
  perspectiveDescriptionInput= q('description-input');
  perspectiveBody = q('perspective-body');
  perspectiveComplexityBadge = q('complexity-badge');
  // v2.74.275 — perspectivePatternInput removed.
  perspectiveLandmarksList   = q('landmarks-list');
  perspectiveAddLandmarkBtn  = q('add-landmark');
  perspectiveSaveBtn         = q('save');
  perspectiveSaveReasonEl    = q('save-reason');
  perspectiveCancelBtn       = q('cancel');
  perspectivePickBanner      = q('pick-banner');
  perspectivePickCancelBtn   = q('pick-cancel');
  perspectiveEventsToggleBtn   = q('events-toggle');
  perspectiveEventsBody        = q('events-body');
  perspectiveEventsList        = q('events-list');
  perspectiveEventsCount       = q('events-count');
  perspectiveEventsClearBtn    = q('events-clear');
  perspectiveEventsStaleBadge  = q('events-stale-badge');
  perspectiveEventsVerifyAllBtn= q('events-verify-all');
  perspectiveEventsBulkOutcome = q('events-bulk-outcome');
  perspectiveEventsHealth      = q('events-health');
  if (perspectiveEventsToggleBtn)    perspectiveEventsToggleBtn.addEventListener('click', _toggleEventsPanel);
  if (perspectiveEventsClearBtn)     perspectiveEventsClearBtn.addEventListener('click', _clearEventsPanel);
  if (perspectiveEventsVerifyAllBtn) perspectiveEventsVerifyAllBtn.addEventListener('click', _verifyAllStaleOnGround);
  // v2.74.260 — Predicates DOM refs + add handler.
  perspectivePredicatesList   = q('predicates-list');
  perspectivePredicatesAddBtn = q('predicates-add');
  if (perspectivePredicatesAddBtn) perspectivePredicatesAddBtn.addEventListener('click', _addPredicate);
  // v2.74.271 — Top-level operator selector.
  perspectivePredicatesOpSelect = q('predicates-operator');
  perspectivePredicatesHint     = q('predicates-hint');
  if (perspectivePredicatesOpSelect) perspectivePredicatesOpSelect.addEventListener('change', _onPredicatesOperatorChange);
  // v2.74.267 — iframe contexts editor refs + add handler.
  perspectiveIframeContextsList = q('iframe-contexts-list');
  perspectiveIframeContextsAdd  = q('iframe-contexts-add');
  if (perspectiveIframeContextsAdd) perspectiveIframeContextsAdd.addEventListener('click', _addIframeContext);
  // v2.74.265 — Active-state preview refs + handler.
  perspectiveActiveStateRefreshBtn = q('active-state-refresh');
  perspectiveActiveStateResult     = q('active-state-result');
  if (perspectiveActiveStateRefreshBtn) {
    perspectiveActiveStateRefreshBtn.addEventListener('click', () => _evaluateActiveState({ immediate: true }));
  }

  // Initialize state from payload, or fetch from background if not provided.
  // The shell may pass payload directly OR rely on background's pending
  // session (set by BEGIN_PERSPECTIVE_CAPTURE).
  let groundId = payload?.groundId ?? null;
  let tabId    = payload?.tabId ?? null;

  if (!groundId) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_PENDING_PERSPECTIVE_CAPTURE' });
      if (res?.success && res.session) {
        groundId = res.session.groundId;
        tabId    = res.session.tabId;
      }
    } catch (e) {
      console.warn('[perspective-capture] GET_PENDING_PERSPECTIVE_CAPTURE failed', e?.message);
    }
  }

  if (!groundId) {
    // No session — show idle-style message.
    perspectiveGroundLabelEl.textContent = 'No active capture session';
    return;
  }

  _perspectiveGroundId = groundId;
  _perspectiveTabId = tabId;
  _perspectiveReturnTo = payload?.returnTo ?? null;
  _perspectiveDraft = newEmptyPerspectiveDraft(groundId);

  // v2.74.43 — Seed the draft from a prefilled perspective. Two callers:
  //   • + Auto in the Ground sidepanel (no id) — Claude-suggested
  //     name/description/landmarks. Landmarks come in unverified;
  //     authoredBy flips to 'model' for the ⚡ badge.
  //   • ✎ Edit in the Ground sidepanel (has id) — existing record.
  //     Preserve id + urlPattern + authoredBy + per-landmark verified
  //     state so the user lands in the saved record exactly as it was.
  //     v2.74.47 — _perspectiveIsEdit flag gates refreshPerspectiveActiveTab so the
  //     URL-pattern input isn't overwritten by the current tab URL.
  const prefilled = payload?.prefilledPerspective;
  if (prefilled && typeof prefilled === 'object') {
    _perspectiveIsEdit = typeof prefilled.id === 'string' && prefilled.id.length > 0;
    if (_perspectiveIsEdit)                                _perspectiveDraft.id          = prefilled.id;
    // v2.74.245 — Phase 7a: perspective-scoped iframe context declarations.
    // Carry through from the saved record so subsequent picks can
    // dedup against existing contexts and the drawer can surface
    // the iframe binding for hydrated landmarks.
    if (Array.isArray(prefilled.iframeContexts)) {
      _perspectiveDraft.iframeContexts = prefilled.iframeContexts
        .filter(c => c && typeof c.contextName === 'string' && c.predicate)
        .map(c => ({
          contextName: c.contextName,
          predicate  : c.predicate,
          sameOrigin : c.sameOrigin === true,
        }));
    }
    // v2.74.48 — Normalize prefilled name (auto-suggested OR existing
    // record) so the visible input matches the lowercase-hyphenated
    // rule the user types under.
    if (typeof prefilled.name === 'string')        _perspectiveDraft.name        = _normalizePerspectiveName(prefilled.name);
    if (typeof prefilled.description === 'string') _perspectiveDraft.description = prefilled.description;
    // v2.74.275 — Legacy `urlPattern` hydration REMOVED. URL gating
    // expressed via predicates only.
    // v2.74.275 — Phase 7d hydration, cleaned. Accepted shapes:
    //   - Array (implicit AND): operator='and', children=array
    //   - Tree with top-level operator (and/or/not) + leaf children
    // Nested operator trees REMOVED (no legacy data; the sentinel
    // _predicatesOriginalTree no longer exists).
    _predicatesOperator = 'and';
    if (Array.isArray(prefilled.predicates)) {
      _perspectiveDraft.predicates = prefilled.predicates
        .filter(p => p && typeof p === 'object' && typeof p.kind === 'string')
        .map(p => ({ ...p }));
    } else if (prefilled.predicates && typeof prefilled.predicates === 'object') {
      const tree = prefilled.predicates;
      if (tree.operator && Array.isArray(tree.children)
          && (tree.operator === 'and' || tree.operator === 'or' || tree.operator === 'not')
          && tree.children.every(c => c && typeof c.kind === 'string' && !c.operator)) {
        _predicatesOperator = tree.operator;
        _perspectiveDraft.predicates = tree.children.map(c => ({ ...c }));
        if (tree.operator === 'not' && tree.children.length > 1) {
          _perspectiveDraft.predicates = _perspectiveDraft.predicates.slice(0, 1);
        }
      } else if (tree.kind) {
        _perspectiveDraft.predicates = [{ ...tree }];
      }
    }
    // v2.74.275 — Phase 2 hydration: registry-only path. Embedded
    // landmarks[] support REMOVED. Perspectives must store landmarkRefs[].
    if (Array.isArray(prefilled.landmarkRefs) && prefilled.landmarkRefs.length > 0) {
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'GET_LANDMARKS',
          payload: { uids: prefilled.landmarkRefs },
        });
        if (res?.success && res.landmarks) {
          const hydrated = [];
          for (const uid of prefilled.landmarkRefs) {
            const rec = res.landmarks[uid];
            if (!rec) {
              console.warn('[perspective-capture] landmark ref unresolved on hydrate:', uid);
              continue;
            }
            // Map the registry record back to the in-memory editing
            // shape. Every field flows through; the save path will
            // round-trip it cleanly.
            hydrated.push(_hydrateLandmarkEffectShape({
              uid                 : rec.uid,
              isCanonical         : rec.isCanonical,
              alias               : rec.alias ?? '',
              a11yRole            : rec.a11yRole ?? null,
              accessibleName      : rec.accessibleName ?? null,
              hierarchicalContext : rec.hierarchicalContext ?? null,
              canonicalUrl        : rec.canonicalUrl ?? null,
              derivationInputs    : rec.derivationInputs ?? null,
              description         : rec.description ?? '',
              aliases             : Array.isArray(rec.aliases) ? rec.aliases.slice() : [],
              operationsCommon    : Array.isArray(rec.operationsCommon) ? rec.operationsCommon.slice() : [],
              pitfalls            : Array.isArray(rec.pitfalls) ? rec.pitfalls.slice() : [],
              expectedContent     : rec.expectedContent ?? null,
              profileConfidence   : rec.profileConfidence ?? null,
              selector            : rec.selector ?? '',
              frameUrl            : rec.frameUrl ?? null,
              verified            : rec.verified ?? null,
              lifecycle           : rec.lifecycle ?? null,
              // v2.74.305 — Effect taxonomy split per ACTION_SPEC § 5.
              // Read all three field names; the hydrator picks the
              // canonical shape and clears the legacy one.
              effect              : rec.effect ?? null,
              interactionPattern  : rec.interactionPattern ?? null,
              effectSource        : rec.effectSource ?? null,
              actionEffect        : rec.actionEffect ?? null,
              iframeContext       : rec.iframeContext ?? null,
            }));
          }
          _perspectiveDraft.landmarks = hydrated;
        }
      } catch (e) {
        console.warn('[perspective-capture] hydration from registry failed:', e?.message);
      }
    }
    // v2.74.392 — legacy "+ Auto" fresh-suggestion hydration (prefilled.landmarks
    // as {alias,selector} draft entries) removed; landmarks come from the
    // registry (landmarkRefs) on edit, or from propose→resolve when authoring.
    // v2.74.349 — Rehydrate the saved structured composition on edit so the
    // structure review, judgment-aware Re-structure (§ 5), and role authoring
    // (§ 13) round-trip instead of resetting every time the Perspective reopens.
    // Guarded two ways: (1) ref-shaped nodes only (Auto-suggestions carry
    // alias/selector, no ref); (2) NON-TRIVIAL only — StorageManager
    // normalizes every Perspective's `landmarks` to at least flat {ref} nodes, so
    // we load it as structure only when a node carries role/multiplicity/
    // contains/alternatives or overlays exist. Otherwise the trivial mirror
    // would make every edited Perspective falsely show as "structured".
    const _pl = prefilled.landmarks;
    const _refShaped = Array.isArray(_pl) && _pl.length > 0 && _pl.every(n => n && typeof n.ref === 'string' && n.ref);
    const _nodeIsStructured = (n) => n && (
      (typeof n.role === 'string' && n.role) || n.multiplicity ||
      (Array.isArray(n.contains) && n.contains.length) ||
      (Array.isArray(n.alternatives) && n.alternatives.length) ||
      (Array.isArray(n.triggers) && n.triggers.length) ||           // v2.74.361 — B-full
      (typeof n.presenceCondition === 'string' && n.presenceCondition));
    const _hasOverlays = (Array.isArray(prefilled.groupings) && prefilled.groupings.length)
      || (Array.isArray(prefilled.sequences) && prefilled.sequences.length);
    if (_refShaped && (_pl.some(_nodeIsStructured) || _hasOverlays)) {
      _perspectiveDraft.structuredLandmarks = _pl;
      if (Array.isArray(prefilled.groupings)) _perspectiveDraft.groupings = prefilled.groupings;
      if (Array.isArray(prefilled.sequences)) _perspectiveDraft.sequences = prefilled.sequences;
      // Reconstruct roleFill (root + contains) so the role→structure synthesis
      // still applies if the user later edits the landmark set (which
      // invalidates the explicit structure).
      const _applyRoles = (nodes) => {
        for (const n of Array.isArray(nodes) ? nodes : []) {
          if (n && typeof n.ref === 'string' && typeof n.role === 'string' && n.role) {
            const lm = _perspectiveDraft.landmarks.find(l => l.uid === n.ref);
            if (lm) { lm.roleFill = n.role; if (n.multiplicity) lm.roleMult = n.multiplicity; }
          }
          if (Array.isArray(n?.contains)) _applyRoles(n.contains);
        }
      };
      _applyRoles(_pl);
    }
    _perspectiveDraft.authoredBy = typeof prefilled.authoredBy === 'string'
      ? prefilled.authoredBy
      : 'model';
  }

  // Resolve ground name for the label.
  try {
    const groundRes = await chrome.runtime.sendMessage({ type: 'GET_GROUND', payload: { id: groundId } });
    const ground = groundRes?.ground;
    perspectiveGroundLabelEl.textContent = ground
      ? `on Ground: ${ground.aiName ?? ground.url ?? groundId}`
      : `on Ground: (unknown)`;
  } catch (_) {
    perspectiveGroundLabelEl.textContent = `on Ground: ${groundId}`;
  }

  // Wire static listeners (input fields + buttons + tab tracking + keydown).
  // v2.74.284 — Delegated card-collapse handler. Single listener on
  // the mount root handles all [data-card-toggle] clicks.
  if (_mountEl) _mountEl.addEventListener('click', _onCardToggle);

  perspectiveNameInput.addEventListener('input', onNameInput);
  perspectiveDescriptionInput.addEventListener('input', onDescriptionInput);
  // v2.74.275 — perspectivePatternInput element removed; no listener.
  perspectiveAddLandmarkBtn.addEventListener('click', onAddLandmark);
  perspectiveSaveBtn.addEventListener('click', savePerspective);
  perspectiveCancelBtn.addEventListener('click', cancelPerspectiveCapture);
  perspectivePickCancelBtn.addEventListener('click', () => cancelPerspectivePick(true));

  _onTabActivated = () => {
    if (!_perspectiveDraft) return;
    refreshPerspectiveActiveTab();
  };
  _onTabUpdated = (updatedTabId, changeInfo) => {
    if (!_perspectiveDraft) return;
    if (updatedTabId !== _perspectiveTabId) return;
    if (changeInfo.url || changeInfo.status === 'complete') refreshPerspectiveActiveTab();
  };
  chrome.tabs?.onActivated?.addListener?.(_onTabActivated);
  chrome.tabs?.onUpdated?.addListener?.(_onTabUpdated);

  _onKeyDown = (e) => {
    if (e.key === 'Escape' && _perspectivePickerSession) {
      e.preventDefault();
      cancelPerspectivePick(true);
    }
  };
  document.addEventListener('keydown', _onKeyDown);

  // v2.74.43 — Reflect any prefilled fields in the inputs so the user
  // sees them on mount. refreshPerspectiveActiveTab will set the URL
  // pattern from the active tab UNLESS this is an edit (gated by
  // _perspectiveIsEdit below).
  // v2.74.47 — Also seed the URL pattern input so an edit shows the
  // saved pattern immediately, before refreshPerspectiveActiveTab has a
  // chance to (be skipped and) leave the field as empty default.
  if (perspectiveNameInput)        perspectiveNameInput.value        = _perspectiveDraft.name        ?? '';
  if (perspectiveDescriptionInput) perspectiveDescriptionInput.value = _perspectiveDraft.description ?? '';

  // v2.74.46 — Wire panel focus/blur so verified-landmark overlays
  // hide while the user works with the page and reappear when they
  // come back to the sidepanel. Initial draw covers the case where
  // the panel mounts already-focused (common path).
  // v2.74.233 — Per-landmark "Show" toggle replaces the previous
  // focus-driven overlay behavior. Toggled-on landmarks stay visible
  // when the user interacts with the page (intentional — the toggle
  // is the source of truth). On focus we redraw defensively in case
  // the page reloaded; on blur we leave overlays alone so the author
  // can see them while clicking around the page.
  _onPanelFocus = () => { _refreshPerspectiveOverlays(); };
  _onPanelBlur  = () => { /* no-op — toggle controls visibility */ };
  window.addEventListener('focus', _onPanelFocus);
  window.addEventListener('blur',  _onPanelBlur);
  _refreshPerspectiveOverlays();

  // Initial tab fill.
  await refreshPerspectiveActiveTab();
  renderPerspectiveLandmarks();
  _renderPerspectivePanel();   // v2.74.348 — § 13 description-first proposal
  // v2.74.368 — Check for a cached pageStructure artifact for this page. If a
  // fresh one exists we reuse it silently; otherwise the panel offers to
  // explore. Fire-and-forget (the panel shows "none" until this resolves).
  _refreshPageStructureStatus();
  _renderPredicates();
  _renderIframeContexts();   // v2.74.267
  updatePerspectiveSaveButtonState();
  // v2.74.265 — Initial active-state evaluation. Fires after tab fill
  // so tabUrl is populated. Fire-and-forget; the section shows
  // "Evaluating…" until done.
  _evaluateActiveState({ immediate: true });
}

// ─── Unmount ──────────────────────────────────────────────────────────────

async function unmount() {
  // Cancel any picker session in progress (notify content script).
  if (_perspectivePickerSession) {
    try { await cancelPerspectivePick(true); } catch {}
  }
  // v2.74.46 — Tear down panel focus/blur listeners and clear any
  // overlays still on the authoring tab. Done BEFORE _perspectiveTabId is
  // nulled below so the CLEAR_PERSPECTIVE_OVERLAYS message has a tab to
  // send to.
  if (_onPanelFocus) try { window.removeEventListener('focus', _onPanelFocus); } catch {}
  if (_onPanelBlur)  try { window.removeEventListener('blur',  _onPanelBlur);  } catch {}
  _onPanelFocus = null;
  _onPanelBlur  = null;
  await _clearPerspectiveOverlays();

  // Remove tab listeners.
  if (_onTabActivated) {
    try { chrome.tabs?.onActivated?.removeListener?.(_onTabActivated); } catch {}
  }
  if (_onTabUpdated) {
    try { chrome.tabs?.onUpdated?.removeListener?.(_onTabUpdated); } catch {}
  }
  if (_onKeyDown) {
    try { document.removeEventListener('keydown', _onKeyDown); } catch {}
  }

  _onTabActivated = null;
  _onTabUpdated = null;
  _onKeyDown = null;

  // Clear state.
  _perspectiveDraft = null;
  _perspectiveGroundId = null;
  _perspectiveTabId = null;
  _perspectivePickerSession = null;
  _perspectiveReturnTo = null;
  _perspectiveIsEdit = false;
  // v2.74.348/350/352/353/366/368 — Reset § 13 proposal-flow + complexity +
  // pageStructure-exploration state.
  _perspectiveRun = null;
  _chosenPerspective = null;
  _chosenPerspectiveIdx = null;
  _perspectiveInFlight = false;
  _resolveInFlightKey = null;
  _pageComplexity = null;
  _roleResolveNotes = {};
  _pageStructureStatus = 'none';
  _pageStructureInfo = null;
  _exploreToken++;   // invalidate any in-flight sweep landing after unmount
  _groundIntentResult = null;
  _groundInFlight = false;

  // Clear DOM refs (no leak — but clarity).
  perspectiveGroundLabelEl = perspectiveTabUrlEl = perspectiveWarningEl = null;
  // v2.74.275 — perspectivePatternInput removed.
  perspectiveNameInput = perspectiveDescriptionInput = null;
  perspectiveBody = null;
  perspectiveComplexityBadge = null;
  perspectiveLandmarksList = perspectiveAddLandmarkBtn = perspectiveSaveBtn = perspectiveCancelBtn = null;
  perspectiveSaveReasonEl = null;
  perspectivePickBanner = perspectivePickCancelBtn = null;
  // v2.74.259 — Events panel refs + ephemeral state.
  // v2.74.263 — Detach live-events subscription BEFORE clearing the
  // ground id; the unsubscribe closes over chrome.storage.onChanged
  // and stays safe to call regardless of state, but order matters
  // for clarity.
  _detachEventsLiveSubscription();
  perspectiveEventsToggleBtn = perspectiveEventsBody = perspectiveEventsList = perspectiveEventsCount = perspectiveEventsClearBtn = null;
  perspectiveEventsStaleBadge = perspectiveEventsVerifyAllBtn = perspectiveEventsBulkOutcome = null;
  perspectiveEventsHealth = null;
  _eventsLandmarksCache = [];
  _eventsExpanded = false;
  _eventsCache = null;
  _eventsLandmarkNames.clear();
  _eventsLoading = false;
  _eventsBulkVerifyInFlight = false;
  // v2.74.266 — Drift-applied state cleanup.
  _eventsAppliedDrift.clear();
  _eventsApplyInFlight.clear();
  // v2.74.260 — Predicates DOM refs.
  perspectivePredicatesList = perspectivePredicatesAddBtn = null;
  perspectivePredicatesOpSelect = perspectivePredicatesHint = null;
  _predicatesOperator = 'and';
  // v2.74.265 — Active-state preview cleanup.
  perspectiveActiveStateRefreshBtn = perspectiveActiveStateResult = null;
  _activeStateEvaluating = false;
  if (_activeStateDebounce) {
    clearTimeout(_activeStateDebounce);
    _activeStateDebounce = null;
  }
  // v2.74.267 — iframe contexts editor cleanup.
  perspectiveIframeContextsList = perspectiveIframeContextsAdd = null;
  _iframeTestOutcome.clear();
  _iframeTestInFlight.clear();
  // v2.74.261 — BUG FIX: clear all row-keyed state Maps/Sets on
  // unmount. Without this, remounting the mode (open perspective A, close,
  // open perspective B) leaks stale state where indices that match rows in
  // the new perspective show artifacts (refining badge, expanded drawer,
  // open replace picker, verify outcome) from the prior perspective. Both
  // predate my work (refining/profileExpanded since v2.74.233/235) and
  // are extensions of my work (verify/replace since v2.74.257/258).
  _landmarkRefining.clear();
  _landmarkProfileExpanded.clear();
  _landmarkReplaceOpen.clear();
  _landmarkReplaceCandidates.clear();
  _landmarkReplaceError.clear();
  _landmarkVerifyInFlight.clear();
  _landmarkVerifyOutcome.clear();

  if (_mountEl) {
    // v2.74.284 — Remove delegated card-collapse listener before
    // clearing the mount.
    try { _mountEl.removeEventListener('click', _onCardToggle); } catch {}
    _mountEl.innerHTML = '';
    _mountEl = null;
  }
}

// ─── Event forwarding (PICK_RESULT) ───────────────────────────────────────

function handleEvent(message) {
  if (!_perspectivePickerSession) return;
  if (message?.sessionId !== _perspectivePickerSession.sessionId) return;
  // v2.74.301 — Handle PICK_CANCELLED so the banner clears even when
  // PICK_RESULT never arrives (e.g. picker aborted because synthesize-
  // Selector returned null, content script torn down mid-flow, or the
  // user pressed Esc / right-clicked). Pre-fix, PICK_CANCELLED was
  // silently dropped — the sidepanel banner stayed up and the user
  // had to refresh.
  if (message.type === 'PICK_CANCELLED') {
    const sessionId = _perspectivePickerSession.sessionId;
    _perspectivePickerSession = null;
    if (perspectivePickBanner) perspectivePickBanner.classList.add('hidden');
    if (_perspectiveTabId != null) {
      broadcastCancelPick(_perspectiveTabId, { sessionId });
    }
    Logger.info('perspective-capture', `pick cancelled (${message.reason ?? 'unknown'})`);
    return;
  }
  if (message.type !== 'PICK_RESULT') return;

  const { landmarkIdx, roleSlot } = _perspectivePickerSession;
  const completedSessionId = _perspectivePickerSession.sessionId;
  _perspectivePickerSession = null;
  if (perspectivePickBanner) perspectivePickBanner.classList.add('hidden');
  // v2.74.168 — Tear down pickers in sibling frames. The originating
  // frame's picker already self-stopped on result; the top frame and
  // any other same-origin iframes that armed via the broadcast are
  // still active. Without this their overlays linger.
  if (_perspectiveTabId != null) {
    broadcastCancelPick(_perspectiveTabId, { sessionId: completedSessionId });
  }

  if (message.error) {
    showPerspectiveWarning(`Pick error: ${message.error}`);
    return;
  }
  const selector = message.selector ?? '';
  if (!selector) {
    showPerspectiveWarning('Pick returned an empty selector — try again');
    return;
  }
  if (!_perspectiveDraft) return;
  // v2.74.280 — Create-mode: PICK_RESULT arrived for a "+ Pick landmark"
  // session (no row existed yet). Push a fresh landmark and adopt its
  // index for the rest of the handler.
  let effectiveIdx = landmarkIdx;
  if (effectiveIdx === null) {
    _perspectiveDraft.landmarks.push({ alias: '', selector: '', verified: null });
    effectiveIdx = _perspectiveDraft.landmarks.length - 1;
  }
  if (!_perspectiveDraft.landmarks[effectiveIdx]) return;
  _perspectiveDraft.landmarks[effectiveIdx].selector = selector;
  // v2.74.198 — Persist iframe origin on the landmark. Symmetric to
  // the fragment-action and observation-extract iframe fixes — when
  // the user picks inside an iframe, PICK_RESULT carries the iframe
  // URL on message.frame.url. Without persisting, runtime perspective
  // evaluation (perspective_ref condition) routes to the top frame and
  // the landmark's selector resolves there instead of the iframe.
  if (message.frame && message.frame.url) {
    _perspectiveDraft.landmarks[effectiveIdx].frameUrl = String(message.frame.url);
  } else {
    delete _perspectiveDraft.landmarks[effectiveIdx].frameUrl;
  }
  _perspectiveDraft.landmarks[effectiveIdx].verified = null;
  // v2.74.348 — § 13 role binding. When this pick fills a proposed role, tag
  // the landmark with roleFill (+ multiplicity) and seed its alias from the
  // role (only if blank) so Claude's profile gets the role as context and the
  // role-fill checklist marks it done. roleFill also drives the save-time
  // structured-composition synthesis (role → LandmarkNode.role).
  if (roleSlot?.role) {
    _perspectiveDraft.landmarks[effectiveIdx].roleFill = roleSlot.role;
    _perspectiveDraft.landmarks[effectiveIdx].roleMult = roleSlot.multiplicity ?? 'one';
    if (!(_perspectiveDraft.landmarks[effectiveIdx].alias ?? '').trim()) {
      _perspectiveDraft.landmarks[effectiveIdx].alias = roleSlot.role;
    }
    // v2.74.418 — OUTCOMES gold label (OUTCOMES_SPEC § 3): if resolve had
    // PROPOSED or FAILED on this role, the manual pick is an explicit correction
    // ("proposed X, truth was Y") — the strongest training signal. Capture the
    // stale note BEFORE deleting it and emit a `corrected` event: the proposed
    // selector debits its catalog feature (active decay), the human's selector is
    // banked as the truth. Fire-and-forget — never let it affect the pick.
    const priorNote = _roleResolveNotes[roleSlot.role];
    delete _roleResolveNotes[roleSlot.role];   // v2.74.355 — manual pick clears the stale "why failed" note
    if (priorNote && _perspectiveGroundId && selector) {
      try {
        chrome.runtime.sendMessage({
          type: 'EMIT_RESOLVE_OUTCOMES',
          payload: {
            groundId: _perspectiveGroundId,
            run: { ts: Date.now(), url: perspectiveTabUrlEl?.textContent ?? '', mode: 'manual-correction',
                   details: [{ role: roleSlot.role, status: priorNote.status ?? 'failed',
                               selector: priorNote.selector ?? null, reason: priorNote.reason,
                               humanFinal: { selector } }] },
            ctx: { localeId: perspectiveTabUrlEl?.textContent ?? null, perspectiveId: _perspectiveDraft?.id ?? null },
          },
        }, () => void chrome.runtime.lastError);
      } catch (e) { Logger?.warn?.('perspective-capture', `corrected-outcome emit failed: ${e.message}`); }
    }
  }
  _invalidateStructure();   // v2.74.336 — landmark set changed; drop stale structure
  renderPerspectiveLandmarks();
  _renderPerspectivePanel();   // v2.74.348 — reflect the newly-filled role
  // v2.74.245 — Phase 7a of substrate spec: iframe context detection.
  // When the picked element lives inside an iframe (frame.isTop is
  // false), ask the TOP frame's content script to identify the
  // <iframe> element matching this frame URL and propose an iframe
  // context (contextName + predicate + sameOrigin). Register the
  // context on the perspective; bind the landmark to it.
  //
  // Fire-and-forget — failures fall back to legacy frameUrl-only
  // behavior. The Pick→Claude refinement runs in parallel; the
  // iframe context registration is a side concern.
  if (message.frame && message.frame.isTop === false) {
    _registerIframeContextForLandmark(effectiveIdx, message.frame.url).catch(err => {
      Logger.warn('perspective-capture', `iframe context registration failed: ${err.message} (keeping frameUrl fallback)`);
    });
  }
  // v2.74.233 — Pick now triggers Claude refinement automatically.
  // Picker captures the raw selector → Claude refines it with role +
  // DOM context + screenshot → final selector is what we verify.
  // Fire-and-forget; refinement function handles its own UI updates
  // and falls back to verify-on-picker-selector when Claude fails.
  // v2.74.296 — Pass the picker's authoritative rect + DPR through so
  // the screenshot helper doesn't have to re-resolve the (possibly
  // ambiguous) selector to figure out where to crop.
  // v2.74.299 — Also pass pickedAccessibilityProfile so the geometric
  // verification step has a reliable UID for the actually-clicked
  // element (not the wrong-element UID that came back from
  // INSPECT_ELEMENT on an ambiguous selector pre-fix).
  _refineLandmarkSelectorWithClaude(effectiveIdx, {
    pickedRect                : message.pickedRect                 ?? null,
    viewportInfo              : message.viewportInfo               ?? null,
    pickedAccessibilityProfile: message.pickedAccessibilityProfile ?? null,
  });
}

/**
 * v2.74.245 — Phase 7a: query the top frame for iframe-element
 * details, propose an iframe context, ensure the Perspective's
 * `iframeContexts[]` includes it, and bind the landmark to it via
 * `landmark.iframeContext`.
 *
 * Context dedup: if the perspective already has a context with the same
 * predicate (e.g., the same iframe was picked into earlier in this
 * session), reuse it rather than creating a duplicate.
 */
async function _registerIframeContextForLandmark(landmarkIdx, frameUrl) {
  if (!_perspectiveDraft || !_perspectiveDraft.landmarks[landmarkIdx]) return;
  if (_perspectiveTabId == null) return;
  const res = await chrome.tabs.sendMessage(
    _perspectiveTabId,
    { type: 'IDENTIFY_IFRAME_ELEMENT', payload: { frameUrl } },
    { frameId: 0 },
  );
  if (!res?.success) {
    Logger.info('perspective-capture', `Pick→iframe context: no iframe element found in top doc for url "${frameUrl}" — landmark stays bound by legacy frameUrl only`);
    return;
  }
  const { proposedContextName, proposedPredicate, sameOrigin, iframeInfo } = res;
  if (!_perspectiveDraft.iframeContexts) _perspectiveDraft.iframeContexts = [];
  // Dedup: same predicate (kind + value/selector/pattern/index) →
  // reuse the existing context name. Authors don't get N variants
  // of the same iframe.
  const predKey = JSON.stringify(proposedPredicate);
  let existing = _perspectiveDraft.iframeContexts.find(c => JSON.stringify(c.predicate) === predKey);
  if (!existing) {
    // Ensure the proposed contextName doesn't collide with another
    // context's name (different predicate, same name — unlikely but
    // defensive). Append a numeric suffix if needed.
    let name = proposedContextName;
    let n = 2;
    while (_perspectiveDraft.iframeContexts.some(c => c.contextName === name)) {
      name = `${proposedContextName}-${n++}`;
    }
    existing = {
      contextName: name,
      predicate  : proposedPredicate,
      sameOrigin : sameOrigin === true,
    };
    _perspectiveDraft.iframeContexts.push(existing);
  }
  _perspectiveDraft.landmarks[landmarkIdx].iframeContext = existing.contextName;
  Logger.info('perspective-capture', `Pick→iframe context bound [landmarkIdx=${landmarkIdx}]`, {
    contextName : existing.contextName,
    predicate   : existing.predicate,
    sameOrigin  : existing.sameOrigin,
    iframeInfo,
  });
  // Re-render so the drawer can surface the iframe binding.
  renderPerspectiveLandmarks();
}

// ─── Input handlers ──────────────────────────────────────────────────────

// v2.74.48 — Perspective names are normalized as the user types: lowercase
// and whitespace runs → single hyphen. Preserves cursor position
// because both transforms are length-preserving for the typical case
// (single space → single hyphen). When the user types two consecutive
// spaces, the regex collapses them into one hyphen which DOES shorten
// the value; we re-anchor the caret to keep input feeling natural.
function _normalizePerspectiveName(raw) {
  return String(raw ?? '').toLowerCase().replace(/\s+/g, '-');
}

function onNameInput() {
  if (!_perspectiveDraft) return;
  const raw  = perspectiveNameInput.value;
  const norm = _normalizePerspectiveName(raw);
  if (raw !== norm) {
    const caret = perspectiveNameInput.selectionStart ?? norm.length;
    perspectiveNameInput.value = norm;
    const newCaret = Math.min(caret, norm.length);
    try { perspectiveNameInput.setSelectionRange(newCaret, newCaret); } catch {}
  }
  _perspectiveDraft.name = norm;
  updatePerspectiveSaveButtonState();
}
function onDescriptionInput() {
  if (!_perspectiveDraft) return;
  _perspectiveDraft.description = perspectiveDescriptionInput.value;
  // v2.74.348 — A manual edit marks the description source 'direct' (unless a
  // proposal seeded it and the user hasn't changed it). Keep it simple: any
  // typing here is direct authorship.
  _perspectiveDraft.authoringMetadata = _perspectiveDraft.authoringMetadata ?? {};
  _perspectiveDraft.authoringMetadata.description = {
    ...(_perspectiveDraft.authoringMetadata.description ?? {}),
    source: 'direct',
    lastAuthoredAt: Date.now(),
    authoredBy: 'user',
  };
  // The propose + ground-intent buttons enable once the intent is non-empty.
  // Toggle them directly (rather than a full panel re-render) so editing the
  // intent with options/roles already shown doesn't flicker the cards.
  // v2.74.394 — also toggle ground-intent (it was left permanently disabled
  // when typed in after an empty initial render → "does nothing").
  if (perspectiveBody && !_perspectiveInFlight) {
    const empty = (_perspectiveDraft.description ?? '').trim().length === 0;
    perspectiveBody.querySelectorAll('[data-perspective-action="propose-perspectives"], [data-perspective-action="ground-intent"]')
      .forEach(btn => {
        btn.disabled = empty;
        if (btn.dataset.perspectiveAction === 'ground-intent') {
          btn.title = empty ? 'Write an Intent first.' : 'Refine your Intent against what this page can actually do (uses the explored page affordances).';
        }
      });
  }
  updatePerspectiveSaveButtonState();
}
// v2.74.275 — onPatternInput removed (URL pattern field gone).
// v2.74.392 — onRediscoverLandmarks removed with the legacy auto-suggest path.

// v2.74.280 — Authoring flow change: "+ Pick landmark" enters the
// picker directly. The landmark card is no longer created up front
// with empty fields — instead it's created AFTER the picker returns,
// fully populated by Pick→Claude. Eliminates the empty-card stage
// that previously preceded every pick.
//
// Cancel (Esc) is naturally a no-op for the draft: no landmark was
// pushed yet. Errors and empty-selector returns also produce no
// landmark — the create path only commits on successful PICK_RESULT.
async function onAddLandmark() {
  if (!_perspectiveDraft) return;
  await startPerspectivePick(null);
}

// ─── Active tab tracking ─────────────────────────────────────────────────

async function refreshPerspectiveActiveTab() {
  if (!_perspectiveDraft) return;
  const tab = await getActiveTab();
  if (!tab) {
    perspectiveTabUrlEl.textContent = '(no active tab)';
    _pageComplexity = null; _renderComplexityBadge();
    return;
  }
  if (/^(chrome|chrome-extension|about|edge):/i.test(tab.url ?? '')) {
    perspectiveTabUrlEl.textContent = `${tab.url} (extension page — picker won't work here)`;
    _pageComplexity = null; _renderComplexityBadge();
    return;
  }
  _perspectiveTabId = tab.id;
  perspectiveTabUrlEl.textContent = tab.url ?? '(unknown)';
  // v2.74.275 — On new perspectives, auto-seed a urlMatches predicate from
  // the current tab URL so authors don't have to type one. On edits,
  // existing predicates are preserved.
  if (!_perspectiveIsEdit && _perspectiveDraft && tab.url
      && (!Array.isArray(_perspectiveDraft.predicates) || _perspectiveDraft.predicates.length === 0)) {
    _perspectiveDraft.predicates = [{ kind: 'urlMatches', pattern: tab.url, mode: 'contains' }];
    _predicatesOperator = 'and';
    if (typeof _renderPredicates === 'function') _renderPredicates();
  }

  if (perspectiveWarningEl) {
    perspectiveWarningEl.textContent = '';
    perspectiveWarningEl.classList.add('hidden');
    perspectiveWarningEl.classList.remove('status-ok');
  }
  // v2.74.265 — Tab changed; re-evaluate active state. Skip if section
  // isn't mounted yet (initial mount calls _evaluateActiveState directly
  // after this returns, so the first eval isn't lost).
  if (perspectiveActiveStateResult) {
    _evaluateActiveState({ debounce: true });
  }
  // v2.74.353 — (Re)compute the resolve-difficulty badge. Always, because
  // same-tab navigation re-fires this with an unchanged tab id but fresh page
  // content; _refreshComplexity is idempotent and token-guards stale writes.
  _refreshComplexity();
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function newEmptyPerspectiveDraft(groundId) {
  return {
    id          : `loc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    groundId    : groundId,
    name        : '',
    description : '',
    // v2.74.275 — `urlPattern` field REMOVED. URL gating expressed via
    // `predicates` (urlMatches kind). New drafts seed an empty
    // urlMatches predicate on first tab load (see refreshPerspectiveActiveTab).
    landmarks   : [],
    predicates  : [],
    authoredBy  : 'human',
  };
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const escAttr = escHtml;

// v2.74.304 — Tiered display-name deriver for the landmark row header.
// Returns HTML (not a plain string) so each tier can carry its own
// visual treatment + tooltip explaining where the displayed text came
// from. Priority order:
//
//   Tier 1: lm.accessibleName            — canonical, normal text
//   Tier 2: lm.alias (humanized)         — italic, "derived from alias"
//   Tier 3: lm.description (truncated)   — italic, "from Claude description"
//   Tier 4: <role/tag> placeholder       — muted, "no name available"
//   Tier 5: "No element picked yet"      — muted, only when no selector
//
// Each tier below Tier 1 conveys "this isn't the W3C-computed name" via
// italics + a tooltip. The Identity drawer section continues to show
// the raw accessibleName field as ground truth — accessibility-poor
// picks are still discoverable, just not used as the primary card label.
function _humanizeAlias(s) {
  if (!s || typeof s !== 'string') return '';
  const flat = s.replace(/[-_]+/g, ' ').trim();
  if (!flat) return '';
  return flat.charAt(0).toUpperCase() + flat.slice(1);
}

function _deriveLandmarkDisplayName(lm) {
  // Tier 1 — canonical accessibleName.
  if (lm?.accessibleName && String(lm.accessibleName).trim()) {
    return `<span title="Accessible name — W3C AccName computed from ARIA + label chain at Pick time. This is the canonical identity input.">${escHtml(lm.accessibleName)}</span>`;
  }

  // Tier 5 — truly nothing picked yet. Distinguish from "picked but
  // accessibility-poor" by checking for a selector. Without one, no
  // pick has occurred.
  if (!lm?.selector || !String(lm.selector).trim()) {
    return `<span class="lm-name-empty">No element picked yet</span>`;
  }

  // Tier 2 — humanized primary alias. Author-blessed name (auto-filled
  // from Claude in v2.74.302) — strongest proxy for AccName when the
  // element doesn't supply one. Italicized to telegraph "derived."
  if (lm.alias && String(lm.alias).trim()) {
    const human = _humanizeAlias(lm.alias);
    return `<span class="lm-name-derived" title="Element has no accessible name — displaying the author/Claude alias instead. Identity hash uses local-UID rather than canonical.">${escHtml(human)}</span>`;
  }

  // Tier 3 — Claude's description, truncated. Falls through here when
  // alias is also blank (rare — usually means Pick failed mid-flow).
  if (lm.description && String(lm.description).trim()) {
    const trimmed = _truncate(String(lm.description).trim(), 50);
    return `<span class="lm-name-derived" title="Element has no accessible name and no alias — displaying Claude's description (truncated). Author should add an alias for a stable label.">${escHtml(trimmed)}</span>`;
  }

  // Tier 4 — last-resort role/tag placeholder. The landmark is
  // genuinely identity-bare; surface the structural shape so the
  // author can at least tell the rows apart.
  const tagOrRole = lm.a11yRole && String(lm.a11yRole).trim()
    ? String(lm.a11yRole).trim().toLowerCase()
    : 'element';
  return `<span class="lm-name-placeholder" title="Element has no accessible name, no alias, and no description — only structural role available. Add an alias to label this landmark.">&lt;${escHtml(tagOrRole)}&gt; (unnamed)</span>`;
}

// v2.74.279 — Compute a single status indicator from the landmark's
// verified.score + lifecycle. Returns { icon, cls, tooltip }. Used by
// the identity zone to replace the v2.74.234 multi-chip status block
// — one glance, one icon, full detail in tooltip.
function _computeLandmarkStatusIcon(lm) {
  const lifecycle = lm?.lifecycle ?? null;
  const v = lm?.verified ?? null;
  const score = v?.score ?? null;
  const legacyOk = !score && typeof v?.matchedCount === 'number' && v.matchedCount > 0;

  // Lifecycle warning states override score display since they
  // indicate runtime health drift the author needs to know about.
  if (lifecycle === 'deprecated') {
    return { icon: '⊘', cls: 'lm-status-deprecated', tooltip: 'Deprecated — new authoring won\'t surface this landmark. Existing refs still work.' };
  }
  if (lifecycle === 'stale-confirmed') {
    return { icon: '⛔', cls: 'lm-status-fail', tooltip: 'Runtime: cached selector failed AND heuristic recovery couldn\'t find a unique candidate. Re-Pick or deprecate.' };
  }
  if (lifecycle === 'stale-suspected') {
    return { icon: '⚠', cls: 'lm-status-stale', tooltip: 'Runtime: stored selector failed but description-layer recovery worked. Verify (✓) or re-Pick to refresh.' };
  }
  // Authoring-time score signals.
  if (score === 'ready' || legacyOk) {
    const ops = Array.isArray(v?.operationsAllowed) && v.operationsAllowed.length > 0
      ? ` · supports: ${v.operationsAllowed.join(', ')}`
      : '';
    const mc = typeof v?.matchedCount === 'number' ? ` · ${v.matchedCount} match${v.matchedCount === 1 ? '' : 'es'}` : '';
    return { icon: '✓', cls: 'lm-status-ready', tooltip: `Ready${mc}${ops}${legacyOk ? ' · legacy verification' : ''}` };
  }
  if (score === 'caveats') {
    const issues = Array.isArray(v?.issues) && v.issues.length > 0 ? ` · ${v.issues.join('; ')}` : '';
    return { icon: '⚠', cls: 'lm-status-caveats', tooltip: `Verified with caveats${issues}` };
  }
  if (score === 'mismatch') {
    const issues = Array.isArray(v?.issues) && v.issues.length > 0 ? `: ${v.issues.join('; ')}` : '';
    return { icon: '✗', cls: 'lm-status-fail', tooltip: `Mismatch${issues}` };
  }
  return { icon: '○', cls: 'lm-status-unverified', tooltip: 'Unverified — Pick an element to verify' };
}

// v2.74.274 — Slugify accessibleName into a kebab-case alias for
// auto-fill on Pick. Trims to 48 chars (room for uniqueness suffixes
// if the author needs to disambiguate manually).
function _slugifyForAlias(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// v2.74.284 — Unified card-collapse handler. Delegated to the form
// root so every section with `[data-card-toggle]` in its head gets
// uniform collapse behavior. Toggles `data-collapsed` on the section;
// CSS hides .dbg-perspective-card-body when collapsed and rotates the
// chevron via the attribute selector.
function _onCardToggle(e) {
  const btn = e.target.closest('[data-card-toggle]');
  if (!btn) return;
  const section = btn.closest('[data-card-id]');
  if (!section) return;
  const isCollapsed = section.getAttribute('data-collapsed') === 'true';
  const next = !isCollapsed;
  section.setAttribute('data-collapsed', next ? 'true' : 'false');
  btn.setAttribute('aria-expanded', next ? 'false' : 'true');
  const chevron = btn.querySelector('.dbg-perspective-card-chevron');
  if (chevron) chevron.textContent = next ? '▸' : '▾';
}

function showPerspectiveWarning(text) {
  if (!perspectiveWarningEl) return;
  perspectiveWarningEl.textContent = text;
  perspectiveWarningEl.classList.remove('hidden');
  perspectiveWarningEl.classList.remove('status-ok');
}

// ─── Layer 2 structure (Phase C-lite, PERSPECTIVE_SPEC § 3/§ 13) ───────────────
// The LLM proposes a structured composition (LandmarkNode tree + groupings/
// sequences) over the already-picked landmarks; the author reviews it. The
// proposal is invalidated whenever the landmark SET changes (pick/remove) so
// stored structure never references a missing/stale landmark.

function _invalidateStructure() {
  if (!_perspectiveDraft) return;
  _perspectiveDraft.structuredLandmarks = null;
  _perspectiveDraft.groupings = undefined;
  _perspectiveDraft.sequences = undefined;
}

function _structAliasOf(uid) {
  const lm = (_perspectiveDraft?.landmarks ?? []).find(l => l?.uid === uid);
  return lm?.alias ?? lm?.accessibleName ?? (typeof uid === 'string' ? uid.slice(0, 8) : '?');
}

// v2.74.344 — Phase B-lite: per-node review. Find a node by id in the
// structuredLandmarks tree (walks `contains`). `id` is a landmark `ref` or a
// virtual node's `vid` (v2.74.365).
function _findStructNode(ref, nodes) {
  const list = nodes ?? _perspectiveDraft?.structuredLandmarks;
  for (const n of Array.isArray(list) ? list : []) {
    if (n?.ref === ref || n?.vid === ref) return n;
    if (Array.isArray(n?.contains)) {
      const hit = _findStructNode(ref, n.contains);
      if (hit) return hit;
    }
  }
  return null;
}

// v2.74.344 — Record the author's review judgment on a node (PERSPECTIVE_SPEC § 5
// LandmarkNodeAuthoringMetadata.userJudgment — the training signal). Values:
// 'accepted' | 'edited' | 'rejected-but-kept'.
function _markStructJudgment(node, judgment) {
  if (!node) return;
  if (!node.authoringMetadata || typeof node.authoringMetadata !== 'object') {
    node.authoringMetadata = { capturedBy: 'llm-proposed', capturedAt: Date.now() };
  }
  node.authoringMetadata.userJudgment = judgment;
  node.authoringMetadata.reviewedAt = Date.now();
}

// v2.74.346 — Phase B-mid (overlays): groupings/sequences are the
// cross-cutting overlays Claude proposes alongside the containment tree
// (PERSPECTIVE_SPEC § 3). The author reviews them with the same vocabulary as
// nodes — accept / edit (rename) / reject-but-kept — plus an explicit delete
// for an overlay the author wants gone entirely. `_markStructJudgment` is
// reused since it just stamps `.authoringMetadata`.
function _overlayArr(kind) {
  if (!_perspectiveDraft) return null;
  if (kind === 'grouping') return Array.isArray(_perspectiveDraft.groupings) ? _perspectiveDraft.groupings : null;
  if (kind === 'sequence') return Array.isArray(_perspectiveDraft.sequences) ? _perspectiveDraft.sequences : null;
  return null;
}
function _findOverlay(kind, idx) {
  const arr = _overlayArr(kind);
  return (arr && idx >= 0 && idx < arr.length) ? arr[idx] : null;
}
function _deleteOverlay(kind, idx) {
  const arr = _overlayArr(kind);
  if (arr && idx >= 0 && idx < arr.length) arr.splice(idx, 1);
}

// v2.74.345 — Phase B-mid: locate a node + its position for re-nesting.
// Returns { node, siblings (the array holding it), index, parentNode|null }.
function _locateStructNode(ref, siblings, parentNode) {
  const arr = Array.isArray(siblings) ? siblings : _perspectiveDraft?.structuredLandmarks;
  if (!Array.isArray(arr)) return null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]?.ref === ref || arr[i]?.vid === ref) return { node: arr[i], siblings: arr, index: i, parentNode: parentNode ?? null };
    if (Array.isArray(arr[i]?.contains)) {
      const hit = _locateStructNode(ref, arr[i].contains, arr[i]);
      if (hit) return hit;
    }
  }
  return null;
}

// v2.74.345 — Indent: nest the node under its preceding sibling. Outline-
// editor semantics; cycle-free (only moves relative to existing siblings).
function _indentStructNode(ref) {
  const loc = _locateStructNode(ref);
  if (!loc || loc.index === 0) return;          // need a preceding sibling
  const prev = loc.siblings[loc.index - 1];
  if (!prev) return;
  loc.siblings.splice(loc.index, 1);
  if (!Array.isArray(prev.contains)) prev.contains = [];
  prev.contains.push(loc.node);
  _markStructJudgment(loc.node, 'edited');
}

// v2.74.345 — Outdent: promote the node one level — out of its parent's
// `contains` to sit right after the parent in the grandparent (or root).
function _outdentStructNode(ref) {
  const loc = _locateStructNode(ref);
  if (!loc || !loc.parentNode) return;          // already at root
  const parentLoc = _locateStructNode(loc.parentNode.ref);
  if (!parentLoc) return;
  loc.siblings.splice(loc.index, 1);            // detach from parent.contains
  if (Array.isArray(loc.parentNode.contains) && loc.parentNode.contains.length === 0) {
    delete loc.parentNode.contains;             // tidy: drop empty contains
  }
  parentLoc.siblings.splice(parentLoc.index + 1, 0, loc.node);  // insert after parent
  _markStructJudgment(loc.node, 'edited');
}

const _STRUCT_MULT_OPTS = ['one', 'many', 'optional', 'conditional'];

function _renderStructNodeRow(n, depth, index) {
  if (!n || typeof n.ref !== 'string') return '';
  const judgment = n.authoringMetadata?.userJudgment ?? null;
  const judgedClass = judgment === 'accepted' ? ' perspective-struct-judged-ok'
    : judgment === 'rejected-but-kept' ? ' perspective-struct-judged-rej'
    : judgment === 'edited' ? ' perspective-struct-judged-edit' : '';
  const mult = _STRUCT_MULT_OPTS.includes(n.multiplicity) ? n.multiplicity : 'one';
  const multOpts = _STRUCT_MULT_OPTS.map(m => `<option value="${m}"${m === mult ? ' selected' : ''}>${m}</option>`).join('');
  // v2.74.365 — node identity is a landmark ref OR a virtual container's vid.
  const nodeId = n.ref ?? n.vid ?? '';
  const alias = n.virtual ? '▢ container' : _structAliasOf(n.ref);
  // v2.74.345 — B-mid: outline re-nesting. ➡ nests this node under its
  // preceding sibling (needs index>0); ⬅ promotes it to its grandparent
  // (needs depth>0). Both are structurally cycle-proof — you can only ever
  // move a node relative to its existing position in the tree.
  const canIndent  = (index ?? 0) > 0;
  const canOutdent = depth > 0;
  // v2.74.362 — auto-verification verdict badge (set by onVerifyStructure).
  const aj = n.autoJudgment ?? null;
  const vis = n.autoVisual ? ' 👁' : '';   // v2.74.364 — verdict came from the visual critic
  const autoBadge = aj === 'verified'    ? `<span class="perspective-struct-auto cx-verified" title="${escAttr(n.autoVisual ? 'Confirmed visually (screenshot critic)' : 'Auto-verified against the live page')}">✓ ${n.autoVisual ? 'visual' : 'auto'}</span>`
    : aj === 'failed'       ? `<span class="perspective-struct-auto cx-failed" title="${escAttr(n.autoNote ?? 'failed verification')}">✗${vis} ${escHtml(n.autoNote ?? 'failed')}</span>`
    : aj === 'unverifiable' ? `<span class="perspective-struct-auto cx-unver" title="${escAttr(n.autoNote ?? 'could not verify')}">?${vis} ${escHtml(n.autoNote ?? 'unverifiable')}</span>`
    : '';
  let html = `
    <div class="perspective-struct-node${judgedClass}${n.virtual ? ' perspective-struct-vnode' : ''}" style="padding-left:${depth * 14}px" data-struct-ref="${escAttr(nodeId)}">
      <button class="perspective-struct-move-btn" data-struct-action="outdent" data-ref="${escAttr(nodeId)}" type="button" ${canOutdent ? '' : 'disabled'} title="Promote: move out one level (to its grandparent)">⬅</button>
      <button class="perspective-struct-move-btn" data-struct-action="indent" data-ref="${escAttr(nodeId)}" type="button" ${canIndent ? '' : 'disabled'} title="Nest: move inside the node above it">➡</button>
      <span class="perspective-struct-alias${n.virtual ? ' perspective-struct-vlabel' : ''}" title="${escAttr(n.virtual ? 'Virtual container — holds landmarks but isn\'t itself a captured landmark' : alias)}">${escHtml(alias)}</span>
      <input type="text" class="perspective-struct-role-input" data-struct-action="role" data-ref="${escAttr(nodeId)}"
             value="${escAttr(n.role ?? '')}" placeholder="role" maxlength="40"
             title="${escAttr(n.virtual ? 'Container role (e.g. dropdown-menu, modal)' : 'Semantic role within the parent (LLM-proposed — edit to correct)')}" />
      <select class="perspective-struct-mult-select" data-struct-action="mult" data-ref="${escAttr(nodeId)}" title="How many at runtime">${multOpts}</select>
      ${autoBadge}
      <button class="perspective-struct-judge-btn${judgment === 'accepted' ? ' active' : ''}" data-struct-action="judge" data-ref="${escAttr(nodeId)}" data-judgment="accepted" type="button" title="Accept Claude's proposal for this node as-is">✓</button>
      <button class="perspective-struct-judge-btn perspective-struct-judge-rej${judgment === 'rejected-but-kept' ? ' active' : ''}" data-struct-action="judge" data-ref="${escAttr(nodeId)}" data-judgment="rejected-but-kept" type="button" title="Reject the structuring (members stay in the perspective; flags the proposal as wrong)">✗</button>
    </div>`;
  // v2.74.361 — B-full (partial): per-node dynamics detail.
  //  • presenceCondition — shown when the node isn't always present
  //    (multiplicity conditional/optional): "when present" editable note.
  //  • triggers — landmarks this node's interaction reveals/changes
  //    (dropdown → its menu). Rendered as removable chips (reviewer prunes
  //    Claude's proposal). Both sit indented under the node row.
  const detailPad = `padding-left:${(depth + 1) * 14}px`;
  if (mult === 'conditional' || mult === 'optional') {
    html += `
      <div class="perspective-struct-detail" style="${detailPad}">
        <span class="perspective-struct-detail-label" title="When is this landmark present at runtime?">when present</span>
        <input type="text" class="perspective-struct-presence-input" data-struct-action="presence" data-ref="${escAttr(nodeId)}"
               value="${escAttr(n.presenceCondition ?? '')}" placeholder="e.g. after the control is opened" maxlength="120" />
      </div>`;
  }
  if (Array.isArray(n.triggers) && n.triggers.length) {
    const chips = n.triggers.map(t =>
      `<span class="perspective-struct-trigger-chip">${escHtml(_structAliasOf(t))}<button class="perspective-struct-trigger-x" data-struct-action="untrigger" data-ref="${escAttr(nodeId)}" data-trigger="${escAttr(t)}" type="button" title="Remove this trigger">✕</button></span>`
    ).join('');
    html += `
      <div class="perspective-struct-detail perspective-struct-triggers" style="${detailPad}">
        <span class="perspective-struct-detail-label" title="Interacting with this landmark reveals or changes these">⚡ triggers</span>${chips}
      </div>`;
  }
  if (Array.isArray(n.contains)) n.contains.forEach((c, i) => { html += _renderStructNodeRow(c, depth + 1, i); });
  return html;
}

// v2.74.346 — One reviewable overlay row (grouping ▣ or sequence →). Mirrors
// the node row's review affordances: editable name, ✓ accept / ✗ reject-kept,
// plus 🗑 delete (overlays, unlike landmarks, are pure annotations — removing
// one drops nothing from the Perspective's landmark set).
function _renderOverlayRow(kind, ov, idx) {
  if (!ov || typeof ov !== 'object') return '';
  const glyph = kind === 'grouping' ? '▣' : '→';
  const members = kind === 'grouping' ? (ov.members ?? []) : (ov.steps ?? []);
  const joiner  = kind === 'grouping' ? ', ' : ' → ';
  const body    = members.map(_structAliasOf).map(escHtml).join(joiner);
  const judgment = ov.authoringMetadata?.userJudgment ?? null;
  const judgedClass = judgment === 'accepted' ? ' perspective-struct-judged-ok'
    : judgment === 'rejected-but-kept' ? ' perspective-struct-judged-rej'
    : judgment === 'edited' ? ' perspective-struct-judged-edit' : '';
  const title = kind === 'grouping' ? 'grouping (cuts across containment)' : 'sequence (ordered flow)';
  return `
    <div class="perspective-struct-overlay perspective-struct-overlay-row${judgedClass}" data-overlay-kind="${kind}" data-overlay-idx="${idx}" title="${escAttr(title)}">
      <span class="perspective-struct-overlay-glyph">${glyph}</span>
      <input type="text" class="perspective-struct-overlay-name" data-overlay-action="name" data-overlay-kind="${kind}" data-overlay-idx="${idx}"
             value="${escAttr(ov.name ?? '')}" placeholder="name" maxlength="40" title="Overlay name (LLM-proposed — edit to correct)" />
      <span class="perspective-struct-overlay-body">${body}</span>
      <button class="perspective-struct-judge-btn${judgment === 'accepted' ? ' active' : ''}" data-overlay-action="judge" data-overlay-kind="${kind}" data-overlay-idx="${idx}" data-judgment="accepted" type="button" title="Accept this overlay as proposed">✓</button>
      <button class="perspective-struct-judge-btn perspective-struct-judge-rej${judgment === 'rejected-but-kept' ? ' active' : ''}" data-overlay-action="judge" data-overlay-kind="${kind}" data-overlay-idx="${idx}" data-judgment="rejected-but-kept" type="button" title="Reject (kept, flagged wrong)">✗</button>
      <button class="perspective-struct-move-btn" data-overlay-action="delete" data-overlay-kind="${kind}" data-overlay-idx="${idx}" type="button" title="Delete this overlay (does not remove any landmark)">🗑</button>
    </div>`;
}

function _renderStructurePreview(nodes, groupings, sequences) {
  const tree = (Array.isArray(nodes) ? nodes : []).map((n, i) => _renderStructNodeRow(n, 0, i)).join('');
  const grp = (Array.isArray(groupings) ? groupings : []).map((g, i) => _renderOverlayRow('grouping', g, i)).join('');
  const seq = (Array.isArray(sequences) ? sequences : []).map((s, i) => _renderOverlayRow('sequence', s, i)).join('');
  return `<div class="perspective-structure-preview">${tree}${grp}${seq}</div>`;
}

function _renderStructureBar() {
  // v2.74.337 — Enable on ≥2 landmarks (any). The UID requirement is checked
  // on click with a clear message, rather than silently disabling the button
  // (UIDs are only assigned after a landmark's Pick→Claude profile completes,
  // so an early-authoring landmark may not have one yet).
  const lmCount = (_perspectiveDraft?.landmarks ?? []).length;
  const canStructure = lmCount >= 2;
  const struct = Array.isArray(_perspectiveDraft?.structuredLandmarks) && _perspectiveDraft.structuredLandmarks.length
    ? _perspectiveDraft.structuredLandmarks : null;
  const btnLabel = struct ? '🧬 Re-structure' : '🧬 Structure with Claude';
  const btnTitle = canStructure
    ? 'Ask Claude to organize these landmarks into a structured perspective (containment, roles, groupings/sequences). You review the result; it saves with the Perspective.'
    : 'Pick at least 2 landmarks to propose structure.';
  return `
    <div class="perspective-structure-bar">
      <button class="btn-secondary tiny" data-perspective-action="propose-structure" type="button" ${canStructure ? '' : 'disabled'} title="${escAttr(btnTitle)}">${btnLabel}</button>
      ${struct ? `<button class="btn-secondary tiny" data-perspective-action="verify-structure" type="button" title="Auto-verify the structure against the live page: resolution + multiplicity + containment (deterministic), and poke-and-observe for triggers. Synthetic clicks interact with the page.">✓ Verify</button>` : ''}
      ${struct ? `<span class="perspective-structure-tag" title="Structure proposed by Claude — review below. Saved with the Perspective.">structured</span>` : ''}
    </div>
    ${struct ? _renderStructurePreview(struct, _perspectiveDraft.groupings, _perspectiveDraft.sequences) : ''}`;
}

async function onProposeStructure() {
  if (!_perspectiveDraft) return;
  const total = (_perspectiveDraft.landmarks ?? []).length;
  // v2.74.389 — map a roleFill name → its landmark uid, so a hidden role's
  // `revealedBy` (a role NAME from propose) becomes a `revealedByRef` (the
  // trigger landmark's uid) that the structure step can turn into a `trigger`.
  const roleToUid = new Map();
  for (const lm of (_perspectiveDraft.landmarks ?? [])) { if (lm?.roleFill && lm?.uid && !roleToUid.has(lm.roleFill)) roleToUid.set(lm.roleFill, lm.uid); }
  const lms = (_perspectiveDraft.landmarks ?? [])
    .filter(lm => lm?.uid)
    .map(lm => ({
      uid: lm.uid,
      alias: lm.alias ?? lm.accessibleName ?? '',
      description: lm.description ?? '',
      // Resolve's verified signal, fed to the structure step as priors:
      role: lm.roleFill || undefined,
      multiplicity: lm.roleMult || undefined,
      hidden: lm.hidden === true || undefined,
      revealedByRef: (lm.revealedBy && roleToUid.get(lm.revealedBy)) || undefined,
    }));
  if (lms.length < 2) {
    // v2.74.337 — Clear feedback instead of a silent no-op. UIDs are assigned
    // when a landmark finishes its Pick→Claude profile (or at save).
    showPerspectiveWarning(`Structure needs at least 2 landmarks with a verified UID — ${lms.length} of ${total} have one. Finish picking/profiling them (each Pick→Claude assigns a UID), or save the Perspective once to assign UIDs, then try again.`);
    return;
  }
  const btn = perspectiveLandmarksList?.querySelector('[data-perspective-action="propose-structure"]');
  if (btn) { btn.disabled = true; btn.textContent = '🧬 Structuring…'; }
  // v2.74.347 — On a re-structure, send the structure the user already
  // reviewed (nodes + overlays, carrying authoringMetadata.userJudgment) so
  // Claude refines it — preserving accepted/edited arrangements and re-thinking
  // only the rejected ones — instead of proposing from scratch. This is the
  // downstream consumer that makes the structured tree + the review judgments
  // actually do something.
  const priorStructure = (Array.isArray(_perspectiveDraft.structuredLandmarks) && _perspectiveDraft.structuredLandmarks.length)
    ? { nodes: _perspectiveDraft.structuredLandmarks, groupings: _perspectiveDraft.groupings, sequences: _perspectiveDraft.sequences }
    : undefined;
  // v2.74.349 — Capture the draft identity so a result that lands after the
  // panel unmounted (or remounted onto a different perspective) is discarded rather
  // than written to a null / wrong draft.
  const draftToken = _perspectiveDraft.id;
  let res;
  try {
    res = await new Promise(r => chrome.runtime.sendMessage({
      type: 'PROPOSE_PERSPECTIVE_STRUCTURE',
      payload: { name: _perspectiveDraft.name, description: _perspectiveDraft.description, landmarks: lms, priorStructure },
    }, r));
  } catch (e) { res = { success: false, error: e?.message ?? 'unknown' }; }
  if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return;   // unmounted / switched mid-flight
  if (!res?.success || !res.structure) {
    showPerspectiveWarning(`Structure failed: ${res?.error ?? 'no structure returned'}`);
    renderPerspectiveLandmarks();
    return;
  }
  // Stamp per-node authoring provenance (PERSPECTIVE_SPEC § 5 LandmarkNodeAuthoringMetadata).
  const now = Date.now();
  // v2.74.347 — Carry the prior judgment forward onto any node/overlay the
  // refine left UNCHANGED, so a re-structure that preserved accepted/edited
  // arrangements doesn't force a re-review and doesn't discard the § 5 training
  // signal. Matching is strict: a node carries forward only when its ref, role,
  // multiplicity AND parent are identical; an overlay only when its name + exact
  // members/steps match. Anything the LLM altered (or anything new) resets to
  // llm-proposed for review.
  const priorNodeJudg = new Map();   // ref -> { judgment, reviewedAt, role, mult, parentRef }
  (function indexPrior(nodes, parentRef) {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (n && typeof n.ref === 'string') {
        const jv = n.authoringMetadata?.userJudgment;
        if (jv) priorNodeJudg.set(n.ref, {
          judgment: jv, reviewedAt: n.authoringMetadata?.reviewedAt,
          role: (n.role ?? '').trim(), mult: n.multiplicity ?? '', parentRef: parentRef ?? null,
        });
        if (Array.isArray(n.contains)) indexPrior(n.contains, n.ref);
      }
    }
  })(priorStructure?.nodes, null);
  const carryMeta = (judgment, reviewedAt) => judgment
    ? { capturedBy: 'llm-proposed', capturedAt: now, userJudgment: judgment, reviewedAt: reviewedAt ?? now }
    : { capturedBy: 'llm-proposed', capturedAt: now };
  const stamp = (nodes, parentRef) => (Array.isArray(nodes) ? nodes : []).map(n => {
    const prior = priorNodeJudg.get(n.ref);
    const unchanged = prior
      && prior.role === (n.role ?? '').trim()
      && prior.mult === (n.multiplicity ?? '')
      && prior.parentRef === (parentRef ?? null);
    return {
      ...n,
      authoringMetadata: carryMeta(unchanged ? prior.judgment : null, unchanged ? prior.reviewedAt : null),
      ...(Array.isArray(n.contains) ? { contains: stamp(n.contains, n.ref) } : {}),
    };
  });
  // v2.74.346 — Stamp overlays with the same llm-proposed provenance as nodes
  // so the author's accept/edit/reject judgments have somewhere to land.
  const indexOverlay = (arr, key) => {
    const m = new Map();
    for (const o of Array.isArray(arr) ? arr : []) {
      if (o && typeof o.name === 'string' && o.authoringMetadata?.userJudgment) {
        m.set(`${o.name}|${(Array.isArray(o[key]) ? o[key] : []).join(',')}`,
          { judgment: o.authoringMetadata.userJudgment, reviewedAt: o.authoringMetadata.reviewedAt });
      }
    }
    return m;
  };
  const priorGrp = indexOverlay(priorStructure?.groupings, 'members');
  const priorSeq = indexOverlay(priorStructure?.sequences, 'steps');
  const stampOverlay = (arr, key, priorMap) => (Array.isArray(arr) ? arr : []).map(o => {
    const found = priorMap.get(`${o.name}|${(Array.isArray(o[key]) ? o[key] : []).join(',')}`);
    return { ...o, authoringMetadata: carryMeta(found?.judgment ?? null, found?.reviewedAt ?? null) };
  });
  _perspectiveDraft.structuredLandmarks = stamp(res.structure.nodes, null);
  _perspectiveDraft.groupings = stampOverlay(res.structure.groupings, 'members', priorGrp);
  _perspectiveDraft.sequences = stampOverlay(res.structure.sequences, 'steps', priorSeq);
  renderPerspectiveLandmarks();
  updatePerspectiveSaveButtonState();
  toast?.(`Structured ${lms.length} landmark(s)`);
}

// v2.74.362 — Auto-verify the structure against the live page (replaces manual
// confirm with machine verdicts; human reviews only the exceptions). Sends the
// node tree + a ref→selector map to the content script, which runs static
// checks (resolution/multiplicity/containment) + poke-and-observe (triggers),
// then turns the per-ref results into a per-node autoJudgment.
async function onVerifyStructure() {
  if (!_perspectiveDraft || !Array.isArray(_perspectiveDraft.structuredLandmarks) || !_perspectiveDraft.structuredLandmarks.length) return;
  if (_perspectiveTabId == null) { showPerspectiveWarning('No active tab to verify against.'); return; }
  // ref(uid) → selector, top-frame landmarks only (iframe-bound → unverifiable).
  const selectors = {};
  for (const lm of _perspectiveDraft.landmarks ?? []) {
    if (lm?.uid && lm.selector && !lm.frameUrl) selectors[lm.uid] = lm.selector;
  }
  const btn = perspectiveLandmarksList?.querySelector('[data-perspective-action="verify-structure"]');
  if (btn) { btn.disabled = true; btn.textContent = '✓ Verifying…'; }
  const draftToken = _perspectiveDraft.id;
  let res;
  try {
    res = await chrome.tabs.sendMessage(_perspectiveTabId,
      { type: 'VERIFY_STRUCTURE', payload: { tree: _perspectiveDraft.structuredLandmarks, selectors } },
      { frameId: 0 });
  } catch (e) { res = { success: false, error: e?.message ?? 'unknown' }; }
  if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return;
  if (!res?.success) {
    showPerspectiveWarning(`Structure verify failed: ${res?.error ?? 'unknown'}`);
    renderPerspectiveLandmarks();
    return;
  }
  const results = res.results || {};
  // Targets a trigger demonstrably revealed (or that were already present) — a
  // conditional node in this set has its presence verified.
  const revealed = new Set();
  for (const r of Object.values(results)) {
    if (r && r.triggers) for (const [t, v] of Object.entries(r.triggers)) {
      if (v === 'verified' || v === 'already-present') revealed.add(t);
    }
  }

  // v2.74.364 — Escalate the residual deterministic checks couldn't settle to a
  // visual critic (one post-poke screenshot + one classify call). Only two
  // kinds escalate: `detached` containment (portaled popups DOM ancestry can't
  // prove) and `no-change` triggers (DOM visibility is unreliable for some
  // widgets). Determinism stays authoritative for everything else.
  const aliasText = (ref) => { const a = _structAliasOf(ref); const t = results[ref]?.text; return t ? `"${a}" (visible text: "${t}")` : `"${a}"`; };
  const claims = [];
  const buildClaims = (nodes, parentRef) => {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      const r = results[n.ref] || {};
      if (r.containment === 'detached' && parentRef) {
        claims.push({ id: `c:${n.ref}`, kind: 'containment', text: `${aliasText(n.ref)} belongs inside / is the popup of ${aliasText(parentRef)}.` });
      }
      if (r.triggers) for (const [t, v] of Object.entries(r.triggers)) {
        if (v === 'no-change') claims.push({ id: `t:${n.ref}:${t}`, kind: 'trigger', text: `Activating ${aliasText(n.ref)} reveals ${aliasText(t)} — is ${aliasText(t)} now visible?` });
      }
      if (Array.isArray(n.contains)) buildClaims(n.contains, n.ref);
    }
  };
  buildClaims(_perspectiveDraft.structuredLandmarks, null);

  if (claims.length && _perspectiveTabId != null) {
    if (btn) btn.textContent = '✓ Adjudicating…';
    let vres;
    try {
      vres = await new Promise(r => chrome.runtime.sendMessage({ type: 'ADJUDICATE_STRUCTURE', payload: { tabId: _perspectiveTabId, claims } }, r));
    } catch (e) { vres = { success: false, error: e?.message ?? 'unknown' }; }
    if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return;
    if (vres?.success && Array.isArray(vres.verdicts)) {
      for (const v of vres.verdicts) {
        if (typeof v?.id !== 'string') continue;
        if (v.id.startsWith('c:')) {
          const ref = v.id.slice(2); (results[ref] = results[ref] || {}).containmentVisual = v.hold;
        } else if (v.id.startsWith('t:')) {
          const [, src, tgt] = v.id.split(':');
          const rr = results[src] = results[src] || {}; rr.triggerVisual = rr.triggerVisual || {}; rr.triggerVisual[tgt] = v.hold;
        }
      }
    }
  }

  let verified = 0, failed = 0, unverifiable = 0, viaVisual = 0;
  const apply = (nodes) => {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (n.virtual) {
        // v2.74.365 — virtual containers have no element; no own verdict (their
        // correctness is their members' verdicts + the shared trigger/presence).
        n.autoJudgment = null; n.autoNote = null; n.autoVisual = false;
      } else {
        const v = _structVerdict(n, results[n.ref] || {}, revealed);
        n.autoJudgment = v.judgment; n.autoNote = v.note; n.autoVisual = !!v.visual;
        if (v.judgment === 'verified') verified++; else if (v.judgment === 'failed') failed++; else unverifiable++;
        if (v.visual) viaVisual++;
      }
      if (Array.isArray(n.contains)) apply(n.contains);
    }
  };
  apply(_perspectiveDraft.structuredLandmarks);
  renderPerspectiveLandmarks();
  toast?.(`Structure verified — ${verified} ok, ${failed} failed, ${unverifiable} unverifiable${viaVisual ? ` (${viaVisual} via screenshot)` : ''}`);
}

// Turn one node's raw verdict map into a verified / failed / unverifiable
// judgment. Conditional/optional nodes treat absent-at-rest as expected (not a
// failure) and are verified when a trigger revealed them.
function _structVerdict(n, r, revealed) {
  const ok  = (note = '', visual = false) => ({ judgment: 'verified', note, visual });
  const bad = (note, visual = false) => ({ judgment: 'failed', note, visual });
  const meh = (note, visual = false) => ({ judgment: 'unverifiable', note, visual });
  const m = n.multiplicity || 'one';
  const conditional = (m === 'conditional' || m === 'optional');
  if (r.resolved === null || r.resolved === undefined) return meh(r.note || 'no selector to test');
  if (r.resolved === false) {
    if (conditional) return revealed.has(n.ref) ? ok('revealed by a trigger') : meh('conditional — absent at rest, no trigger demonstrated it');
    return bad('selector matched 0 elements');
  }
  if (m === 'one'  && r.multiplicity === 'mismatch') return bad(`expected one, matched ${r.count}`);
  if (m === 'many' && r.multiplicity === 'too-few')  return bad(`expected many, matched ${r.count}`);
  if (m === 'optional' && r.multiplicity === 'too-many') return bad(`expected optional, matched ${r.count}`);
  // v2.74.363/364 — containment is LOGICAL (portaled dropdowns/modals live at
  // body level): 'ok' (DOM descendant) and 'ok-portaled' (ARIA/popup link) pass.
  // 'detached' escalates to the visual critic (v2.74.364): yes → verified-visual,
  // no → failed-visual, else a soft review note.
  if (r.containment === 'detached') {
    if (r.containmentVisual === 'yes') return ok('contained (confirmed visually)', true);
    if (r.containmentVisual === 'no')  return bad('child is not visually inside its parent', true);
    return meh('outside parent\'s DOM, no ARIA/popup link — likely portaled; review');
  }
  if (r.containment === 'parent-missing') return meh('parent did not resolve');
  if (r.triggers) {
    const noChange = Object.entries(r.triggers).filter(([, v]) => v === 'no-change').map(([t]) => t);
    if (noChange.length) {
      const tv = r.triggerVisual || {};
      const anyVisual = noChange.some(t => tv[t]);
      if (noChange.some(t => tv[t] === 'no'))  return bad('trigger fired but its target did not appear', anyVisual);
      if (noChange.every(t => tv[t] === 'yes')) return ok('trigger reveal confirmed visually', true);
      return meh('trigger reveal not confirmed', anyVisual);
    }
    const vals = Object.values(r.triggers);
    if (vals.length && vals.every(v => v === 'unsafe-to-poke' || v === 'no-source')) return meh('trigger not safely testable (would navigate/submit)');
  }
  return ok();
}

// ─── Perspective proposal (PERSPECTIVE_SPEC § 13 description-first flow) ────────

// A role is "filled" when some draft landmark carries roleFill === role.
function _perspectiveRoleFilled(role) {
  return (_perspectiveDraft?.landmarks ?? []).some(lm => lm?.roleFill === role);
}

// v2.74.348/350/366 — Render the description-first proposal panel: one
// "Propose perspectives" button (always enhanced — screenshot + sibling-Perspective/
// registry context), the proposed options, then the role-fill checklist for the
// adopted option. Re-rendered on propose, choice, role-fill.
function _renderPerspectivePanel() {
  if (!perspectiveBody) return;
  const intent = (_perspectiveDraft?.description ?? '').trim();
  const exploring = _pageStructureStatus === 'building';
  const canPropose = intent.length > 0 && !_perspectiveInFlight && !exploring;
  const emptyTitle = 'Write an intent description above first — it seeds the proposal.';
  const label = _perspectiveInFlight ? '⏳ Proposing…' : (_perspectiveRun ? '↻ Re-propose perspectives' : '✨ Propose perspectives');

  let html = `
    <p class="dbg-perspective-perspective-intro">Write your <b>Intent</b> above, then propose. Claude suggests named <b>roles</b> (using a page screenshot + this Ground's existing perspectives & landmarks); you pick the real element for each.</p>
    ${_renderExploreRow()}
    ${_renderGroundIntentRow(intent)}
    <div class="dbg-perspective-perspective-buttons">
      <button class="btn-secondary tiny" data-perspective-action="propose-perspectives" type="button" ${canPropose ? '' : 'disabled'} title="${escAttr(intent.length === 0 ? emptyTitle : "Propose perspective options for this intent, using a page screenshot + this Ground's perspectives & landmarks.")}">${label}</button>
    </div>`;

  const run = _perspectiveRun;
  if (run) {
    html += `<div class="dbg-perspective-perspective-run">
      <div class="dbg-perspective-perspective-run-head">${escHtml(_perspectiveRunSummary(run))}</div>`;
    run.options.forEach((opt, i) => {
      const chosen = _chosenPerspective === opt;   // identity
      const rolesPreview = opt.roles.map(r => escHtml(r.role)).join(', ');
      // v2.74.351 — Downstream perspectives (onPage:false) belong to a page
      // reached only after acting; their roles can't be picked in this
      // single-page session, so they're flagged + not directly choosable.
      const downstream = opt.onPage === false;
      const resolving = _resolveInFlightKey === String(i);
      const busy = _perspectiveInFlight || !!_resolveInFlightKey;
      const headRight = downstream
        ? `<span class="dbg-perspective-perspective-downstream-badge" title="This perspective's elements aren't on the current page. Navigate to it, then author it as its own Perspective.">⤳ downstream</span>`
        : `<span class="dbg-perspective-perspective-option-actions">
            <button class="btn-secondary tiny" data-perspective-action="choose-perspective" data-idx="${i}" type="button" ${busy ? 'disabled' : ''}>${chosen ? '✓ Using' : 'Use this'}</button>
            <button class="btn-secondary tiny" data-perspective-action="resolve-roles" data-idx="${i}" type="button" ${busy ? 'disabled' : ''} title="Ask Claude to auto-pick a selector for every role in this perspective, then verify each against the page. Roles Claude can't resolve stay for manual picking.">${resolving ? '⏳ Resolving…' : '⚡ Resolve roles'}</button>
          </span>`;
      html += `
        <div class="dbg-perspective-perspective-option${chosen ? ' chosen' : ''}${downstream ? ' downstream' : ''}">
          <div class="dbg-perspective-perspective-option-head">
            <span class="dbg-perspective-perspective-option-name">${escHtml(opt.name)}</span>
            ${headRight}
          </div>
          ${opt.rationale ? `<div class="dbg-perspective-perspective-option-rationale">${escHtml(opt.rationale)}</div>` : ''}
          ${downstream && opt.reachedVia ? `<div class="dbg-perspective-perspective-reached">↪ reached ${escHtml(opt.reachedVia)} — navigate there, then author it as its own Perspective</div>` : ''}
          <div class="dbg-perspective-perspective-option-roles">${opt.roles.length} role(s): ${rolesPreview}</div>
        </div>`;
    });
    html += `</div>`;
  }

  if (_chosenPerspective && Array.isArray(_chosenPerspective.roles)) {
    html += `<div class="dbg-perspective-perspective-roles"><div class="dbg-perspective-perspective-roles-title">Fill each role by picking its element:</div>`;
    for (const r of _chosenPerspective.roles) {
      const filled = _perspectiveRoleFilled(r.role);
      const multBadge = (r.multiplicity && r.multiplicity !== 'one')
        ? `<span class="dbg-perspective-perspective-mult">${escHtml(r.multiplicity)}</span>` : '';
      // v2.74.381 — hidden roles live in a layer revealed by a trigger; Resolve
      // opens that trigger to find them.
      const hiddenBadge = (r.hidden || r.revealedBy)
        ? `<span class="dbg-perspective-perspective-hidden" title="In a hidden layer — Resolve opens the trigger to find it.">⤿ ${r.revealedBy ? `via ${escHtml(r.revealedBy)}` : 'hidden'}</span>` : '';
      html += `
        <div class="dbg-perspective-perspective-role${filled ? ' filled' : ''}">
          <span class="dbg-perspective-perspective-role-status">${filled ? '✓' : '○'}</span>
          <span class="dbg-perspective-perspective-role-name">${escHtml(r.role)}</span>
          ${multBadge}${hiddenBadge}
          ${r.description ? `<span class="dbg-perspective-perspective-role-desc">${escHtml(r.description)}</span>` : ''}
          <button class="btn-secondary tiny" data-perspective-action="pick-role" data-role="${escAttr(r.role)}" type="button" ${(_perspectivePickerSession || _resolveInFlightKey) ? 'disabled' : ''}>${filled ? 'Re-pick' : 'Pick'}</button>
        </div>`;
      // v2.74.355 — Why ⚡ Resolve couldn't fill this role (last run). Cleared
      // when filled manually.
      const note = !filled ? _roleResolveNotes[r.role] : null;
      if (note) {
        html += `<div class="dbg-perspective-perspective-role-note ${note.status === 'abstained' ? 'abstained' : 'failed'}">${note.status === 'abstained' ? '∅' : '⚠'} ${escHtml(note.reason)}</div>`;
      }
    }
    // v2.74.356 — Opt-in repair round: retry the failed/abstained roles with
    // the verification feedback. One LLM round-trip per click (latency is the
    // user's call — see DESIGN_resolve_roles.md § 8).
    const retryable = _chosenPerspective.roles.filter(r => !_perspectiveRoleFilled(r.role) && _roleResolveNotes[r.role]).length;
    if (retryable > 0 && _chosenPerspectiveIdx != null) {
      const busy = _perspectiveInFlight || !!_resolveInFlightKey;
      const retrying = _resolveInFlightKey === `retry:${_chosenPerspectiveIdx}`;
      html += `<div class="dbg-perspective-perspective-retry">
        <button class="btn-secondary tiny" data-perspective-action="retry-roles" type="button" ${busy ? 'disabled' : ''} title="Send the ${retryable} unresolved role(s) back to Claude with their verification-failure reasons + the selectors that worked, for a corrected attempt. Costs one more LLM round-trip.">${retrying ? '⏳ Retrying…' : `↻ Retry ${retryable} with feedback`}</button>
      </div>`;
    }
    html += `</div>`;
  }

  perspectiveBody.innerHTML = html;
  perspectiveBody.querySelector('[data-perspective-action="propose-perspectives"]')
    ?.addEventListener('click', () => onProposePerspectives());
  perspectiveBody.querySelectorAll('[data-perspective-action="choose-perspective"]').forEach(btn =>
    btn.addEventListener('click', () => onChoosePerspective(parseInt(btn.dataset.idx, 10))));
  perspectiveBody.querySelectorAll('[data-perspective-action="resolve-roles"]').forEach(btn =>
    btn.addEventListener('click', () => onResolveRoles(parseInt(btn.dataset.idx, 10))));
  perspectiveBody.querySelector('[data-perspective-action="retry-roles"]')
    ?.addEventListener('click', () => onRetryFailedRoles(_chosenPerspectiveIdx));
  perspectiveBody.querySelectorAll('[data-perspective-action="pick-role"]').forEach(btn =>
    btn.addEventListener('click', () => onPickForRole(btn.dataset.role)));
  // v2.74.368 — pageStructure exploration controls.
  perspectiveBody.querySelector('[data-perspective-action="explore"]')
    ?.addEventListener('click', () => onExplorePageStructure(false));
  perspectiveBody.querySelector('[data-perspective-action="reexplore"]')
    ?.addEventListener('click', () => onExplorePageStructure(true));
  perspectiveBody.querySelector('[data-perspective-action="skip-explore"]')
    ?.addEventListener('click', () => onSkipExplore());
  perspectiveBody.querySelector('[data-perspective-action="cancel-explore"]')
    ?.addEventListener('click', () => onCancelExplore());
  // v2.74.393 — grounded-intent controls.
  perspectiveBody.querySelector('[data-perspective-action="ground-intent"]')
    ?.addEventListener('click', () => onGroundIntent());
  perspectiveBody.querySelector('[data-perspective-action="use-grounded-intent"]')
    ?.addEventListener('click', () => onUseGroundedIntent());
  perspectiveBody.querySelector('[data-perspective-action="dismiss-grounded-intent"]')
    ?.addEventListener('click', () => { _groundIntentResult = null; _renderPerspectivePanel(); });
}

// v2.74.393 — Grounded-intent row: a "✨ Ground intent" action that refines the
// user's raw Intent against the page's affordances (cached from Explore), shown
// as an editable proposal (Use it / Dismiss) before it seeds propose.
function _renderGroundIntentRow(intent) {
  if (_groundInFlight) {
    return `<div class="dbg-perspective-ground building"><span>⏳ Grounding intent in this page…</span></div>`;
  }
  const r = _groundIntentResult;
  if (r && r.forIntent === intent) {
    const ach = r.achievable || 'unknown';
    const achLabel = ach === 'yes' ? '✓ fully supported' : ach === 'partial' ? '◐ partially supported' : ach === 'no' ? '✗ not supported here' : '? not explored';
    return `<div class="dbg-perspective-ground result ${escAttr(ach)}">
        <div class="dbg-perspective-ground-head"><span class="dbg-perspective-ground-title">Grounded intent</span><span class="dbg-perspective-ground-ach ${escAttr(ach)}">${achLabel}</span></div>
        <div class="dbg-perspective-ground-text">${escHtml(r.groundedIntent)}</div>
        ${r.matchedGoal ? `<div class="dbg-perspective-ground-note">↳ matches page goal: <b>${escHtml(r.matchedGoal)}</b></div>` : ''}
        ${r.note ? `<div class="dbg-perspective-ground-note">${escHtml(r.note)}</div>` : ''}
        <div class="dbg-perspective-ground-actions">
          <button class="btn-secondary tiny" data-perspective-action="use-grounded-intent" type="button" title="Replace your Intent with this grounded version; it then seeds Propose.">Use it</button>
          <button class="btn-secondary tiny" data-perspective-action="dismiss-grounded-intent" type="button">Dismiss</button>
        </div>
      </div>`;
  }
  // Offer button (disabled until an intent is typed).
  const disabled = intent.length === 0;
  return `<div class="dbg-perspective-ground offer">
      <button class="btn-secondary tiny" data-perspective-action="ground-intent" type="button" ${disabled ? 'disabled' : ''} title="${escAttr(disabled ? 'Write an Intent first.' : 'Refine your Intent against what this page can actually do (uses the explored page affordances).')}">✨ Ground intent in this page</button>
    </div>`;
}

// v2.74.368 — Render the depth-exploration row based on _pageStructureStatus.
// The artifact is the channel to propose-perspectives (read from cache at
// propose-time); this row just lets the author trigger/skip/re-run the sweep.
function _renderExploreRow() {
  const info = _pageStructureInfo;
  const reveals = info && Number.isFinite(info.revealing) ? info.revealing : null;
  switch (_pageStructureStatus) {
    case 'building':
      return `<div class="dbg-perspective-explore building"><span>⏳ Exploring page depth… (poking disclosure controls)</span>
        <button class="btn-secondary tiny" data-perspective-action="cancel-explore" type="button">Cancel</button></div>`;
    case 'fresh':
    case 'built': {
      const detail = reveals != null ? `${reveals} control(s) revealed hidden content` : 'no hidden content found';
      // Diagnostics so a "0" is explainable: how many candidates were found,
      // how many were poked, and whether the page was scrolled for depth.
      const diag = info
        ? ` (${info.candidates ?? '?'} candidate(s), ${info.poked ?? '?'} poked${info.scrollSteps ? `, scrolled ${info.scrollSteps}×` : ''})`
        : '';
      return `<div class="dbg-perspective-explore done" title="Proposals on this page now include post-interaction landmarks the static snapshot can't show.">
        <span>✓ Page depth explored — ${escHtml(detail)}${escHtml(diag)}.</span>
        <button class="btn-secondary tiny" data-perspective-action="reexplore" type="button" title="Re-run the sweep (the page may have changed).">↻ Re-explore</button></div>`;
    }
    case 'skipped':
      return `<div class="dbg-perspective-explore skipped"><span>Depth exploration skipped — proposals use the static snapshot only.</span>
        <button class="btn-secondary tiny" data-perspective-action="explore" type="button">🔍 Explore now</button></div>`;
    case 'failed':
      return `<div class="dbg-perspective-explore failed"><span>⚠ Depth exploration failed.</span>
        <button class="btn-secondary tiny" data-perspective-action="explore" type="button">↻ Retry</button></div>`;
    case 'none':
    default:
      return `<div class="dbg-perspective-explore offer">
        <span>🔍 <b>Explore page depth?</b> Safely pokes dropdowns / menus / modals so proposals can include landmarks revealed only after an interaction.</span>
        <span class="dbg-perspective-explore-actions">
          <button class="btn-secondary tiny" data-perspective-action="explore" type="button">Explore</button>
          <button class="btn-secondary tiny" data-perspective-action="skip-explore" type="button">Skip</button>
        </span></div>`;
  }
}

// Human-readable "what this run used + how long" for the run header.
function _perspectiveRunSummary(run) {
  const secs = run?.elapsedMs != null ? `${(run.elapsedMs / 1000).toFixed(1)}s` : '?';
  const m = run?.meta ?? {};
  const parts = [m.screenshot ? 'screenshot' : 'no-screenshot'];
  if (m.siblingPerspectives)    parts.push(`${m.siblingPerspectives} perspective(s)`);
  if (m.registryLandmarks) parts.push(`${m.registryLandmarks} landmark(s)`);
  if (m.pageStructure)     parts.push(`depth(${m.revealingControls || 0} reveal)`);
  return `${parts.join(' + ')} · ${secs}`;
}

async function onProposePerspectives() {
  if (!_perspectiveDraft) return;
  const intent = (_perspectiveDraft.description ?? '').trim();
  if (!intent) { showPerspectiveWarning('Write an intent description first — it seeds the proposal.'); return; }
  if (_perspectiveTabId == null) { showPerspectiveWarning('No active tab to analyze.'); return; }
  if (_perspectiveInFlight || _resolveInFlightKey) return;
  // v2.74.349 — Capture the draft identity; discard a result that lands after
  // the panel unmounted or remounted onto a different perspective (else we'd write
  // to a null / wrong draft and crash).
  const draftToken = _perspectiveDraft.id;
  _perspectiveInFlight = true;
  _renderPerspectivePanel();
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let res;
  try {
    res = await new Promise(r => chrome.runtime.sendMessage({
      type: 'PROPOSE_PERSPECTIVES',
      payload: { tabId: _perspectiveTabId, groundId: _perspectiveGroundId, intent },
    }, r));
  } catch (e) { res = { success: false, error: e?.message ?? 'unknown' }; }
  if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return;   // unmounted / switched mid-flight
  _perspectiveInFlight = false;
  if (!res?.success || !Array.isArray(res.options) || !res.options.length) {
    showPerspectiveWarning(`Perspective proposal failed: ${res?.error ?? 'no options returned'}`);
    _renderPerspectivePanel();
    return;
  }
  const elapsedMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
  // Fresh options supersede any prior choice.
  if (_perspectiveRun?.options?.includes(_chosenPerspective)) { _chosenPerspective = null; _chosenPerspectiveIdx = null; }
  _perspectiveRun = { options: res.options, elapsedMs, meta: res.meta ?? null };
  // Record that the description acted as a proposal seed (PERSPECTIVE_SPEC § 6).
  _perspectiveDraft.authoringMetadata = _perspectiveDraft.authoringMetadata ?? {};
  _perspectiveDraft.authoringMetadata.description = {
    ...(_perspectiveDraft.authoringMetadata.description ?? {}),
    source: 'proposal',
    proposalContext: { seedText: intent, proposedAt: Date.now() },
  };
  _renderPerspectivePanel();
  toast?.(`Proposed ${res.options.length} option(s) in ${(elapsedMs / 1000).toFixed(1)}s`);
}

// ─── v2.74.368 — depth exploration (the Explore sweep) ─────────────────────
// Summarize the IN-MEMORY sweep result (post-Explore) into the chip info — keeps
// the rich diagnostics (candidates/poked/scrolled) the sweep produced this run.
function _summarizePageStructure(structure) {
  if (!structure) return null;
  const controls = Array.isArray(structure.controls) ? structure.controls : [];
  const revealing = controls.filter(c => c?.observation === 'reveal').length;
  const totalRevealed = controls.reduce((n, c) => n + (Number(c?.revealCount) || 0), 0);
  const st = structure.stats ?? {};
  return {
    controls: controls.length, revealing, totalRevealed, capturedAt: structure.capturedAt ?? null,
    candidates: Number(st.candidates) || controls.length, poked: Number(st.controlsTried) || controls.length,
    scrollSteps: Number(st.scrollSteps) || 0,
  };
}

// v2.74.427 — #2 P4: summarize DEPTH from the cached Locale (on-mount freshness).
// The sweep is folded into the Locale's layers; per-run sweep diagnostics
// (candidates/poked/scrolled) aren't persisted, so the chip shows just the depth.
function _summarizeLocaleDepth(model) {
  if (!model) return null;
  const layers = Object.values(model.layers || {}).filter((l) => l && l.kind !== 'surface');
  const totalRevealed = layers.reduce((n, l) => n + (Array.isArray(l.features) ? l.features.length : 0), 0);
  const feats = model.features ? Object.values(model.features) : [];
  return {
    controls: feats.filter((f) => f?.kind === 'disclosure').length,
    revealing: layers.length, totalRevealed, capturedAt: model.coverage?.lastExploredAt ?? null,
  };
}

// On mount: ask the background whether a FRESH Locale already exists for this page
// (v2.74.427 #2 P4 — was GET_PAGE_STRUCTURE). Fresh → reuse silently ('fresh');
// otherwise leave the offer ('none').
async function _refreshPageStructureStatus() {
  if (!_perspectiveDraft) return;
  const draftToken = _perspectiveDraft.id;
  const url = perspectiveTabUrlEl?.textContent ?? '';
  if (!/^https?:/i.test(url)) return;   // not an explorable page
  let res;
  try {
    res = await new Promise(r => chrome.runtime.sendMessage({
      type: 'GET_LOCALE', payload: { groundId: _perspectiveGroundId, url },
    }, r));
  } catch { return; }
  if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return;   // unmounted / switched
  if (_pageStructureStatus === 'building') return;          // a sweep started meanwhile — don't clobber
  if (res?.success && res.model && res.fresh) {
    _pageStructureStatus = 'fresh';
    _pageStructureInfo = _summarizeLocaleDepth(res.model);
    _renderPerspectivePanel();
  }
  // stale or absent → leave 'none' (the offer); no re-render needed.
}

// Run the depth sweep (LLM-planned in the background). `force` re-runs even if
// a fresh artifact exists. Soft-cancellable via _exploreToken.
async function onExplorePageStructure(force = false) {
  if (!_perspectiveDraft) return;
  if (_perspectiveTabId == null) { showPerspectiveWarning('No active tab to explore.'); return; }
  if (_pageStructureStatus === 'building') return;
  const draftToken = _perspectiveDraft.id;
  const myToken = ++_exploreToken;
  _pageStructureStatus = 'building';
  _renderPerspectivePanel();
  let res;
  try {
    res = await new Promise(r => chrome.runtime.sendMessage({
      type: 'EXPLORE_PAGE_STRUCTURE',
      // v2.74.378 — banded walk: background orchestrates metrics → per-band
      // (enumerate → screenshot → LLM plan → poke) bottom-to-top → cleanup.
      payload: { tabId: _perspectiveTabId, groundId: _perspectiveGroundId },
    }, r));
  } catch (e) { res = { success: false, error: e?.message ?? 'unknown' }; }
  // Drop the result if cancelled, unmounted, or superseded by a newer run.
  if (myToken !== _exploreToken || !_perspectiveDraft || _perspectiveDraft.id !== draftToken) return;
  if (!res?.success || !res.structure) {
    _pageStructureStatus = 'failed';
    _renderPerspectivePanel();
    showPerspectiveWarning(`Page depth exploration failed: ${res?.error ?? 'no structure returned'}`);
    return;
  }
  _pageStructureStatus = 'built';
  _pageStructureInfo = _summarizePageStructure(res.structure);
  _renderPerspectivePanel();
  const rv = _pageStructureInfo?.revealing ?? 0;
  toast?.(rv > 0 ? `Explored — ${rv} control(s) reveal hidden content` : 'Explored — no hidden content found');
}

function onSkipExplore() {
  if (_pageStructureStatus === 'building') return;
  _pageStructureStatus = 'skipped';
  _renderPerspectivePanel();
}

// Soft-cancel: we can't abort the content-script sweep mid-flight, but we can
// invalidate its landing result and restore the offer.
function onCancelExplore() {
  if (_pageStructureStatus !== 'building') return;
  _exploreToken++;
  _pageStructureStatus = _pageStructureInfo ? 'built' : 'none';
  _renderPerspectivePanel();
}

// v2.74.393 — Ground the user's raw Intent against the page's affordances.
async function onGroundIntent() {
  if (!_perspectiveDraft) return;
  const intent = (_perspectiveDraft.description ?? '').trim();
  if (!intent) { showPerspectiveWarning('Write an Intent first.'); return; }
  if (_groundInFlight) return;
  const draftToken = _perspectiveDraft.id;
  _groundInFlight = true; _renderPerspectivePanel();
  let res;
  try {
    res = await new Promise(r => chrome.runtime.sendMessage({
      type: 'GROUND_INTENT', payload: { tabId: _perspectiveTabId, groundId: _perspectiveGroundId, intent },
    }, r));
  } catch (e) { res = { success: false, error: e?.message ?? 'unknown' }; }
  if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return;
  _groundInFlight = false;
  if (!res?.success || !res.groundedIntent) {
    showPerspectiveWarning(`Ground intent failed: ${res?.error ?? 'no result'}`);
    _renderPerspectivePanel();
    return;
  }
  _groundIntentResult = { groundedIntent: res.groundedIntent, achievable: res.achievable || 'unknown', note: res.note || '', matchedGoal: res.matchedGoal || null, forIntent: intent };
  _renderPerspectivePanel();
  if (res.hadAffordance === false) toast?.('Run Explore to ground the intent in this page');
}

// Accept the grounded intent → it becomes the Intent field + seeds propose.
function onUseGroundedIntent() {
  if (!_perspectiveDraft || !_groundIntentResult?.groundedIntent) return;
  const original = (_perspectiveDraft.description ?? '').trim();
  _perspectiveDraft.description = _groundIntentResult.groundedIntent;
  if (perspectiveDescriptionInput) perspectiveDescriptionInput.value = _perspectiveDraft.description;
  // Record provenance (PERSPECTIVE_SPEC § 6): grounded from the user's original.
  _perspectiveDraft.authoringMetadata = _perspectiveDraft.authoringMetadata ?? {};
  _perspectiveDraft.authoringMetadata.description = {
    ...(_perspectiveDraft.authoringMetadata.description ?? {}),
    source: 'grounded', authoredBy: 'llm', lastAuthoredAt: Date.now(),
    originalIntent: original, achievable: _groundIntentResult.achievable,
  };
  _groundIntentResult = null;
  _renderPerspectivePanel();
  updatePerspectiveSaveButtonState();
  toast?.('Intent grounded — now Propose perspectives');
}


function onChoosePerspective(idx) {
  if (!_perspectiveDraft) return;
  const opt = _perspectiveRun?.options?.[idx];
  if (!opt) return;
  _chosenPerspective = opt;
  _chosenPerspectiveIdx = idx;
  // Name → perspective name, but never clobber a name the user already typed.
  if (!(_perspectiveDraft.name ?? '').trim()) {
    _perspectiveDraft.name = _normalizePerspectiveName(opt.name);
    if (perspectiveNameInput) perspectiveNameInput.value = _perspectiveDraft.name;
  }
  // Seed URL predicates from the option. The option's urlMatches REPLACE any
  // existing urlMatches (typically just the over-specific full-URL predicate
  // auto-seeded on mount) — appending instead would AND the broad option
  // pattern with the exact-URL seed and the Perspective would never match sibling
  // pages. Non-URL predicates (visible/hasText/…) are preserved. If the option
  // proposes no predicates, leave the existing ones untouched.
  if (Array.isArray(opt.predicates) && opt.predicates.length) {
    if (!Array.isArray(_perspectiveDraft.predicates)) _perspectiveDraft.predicates = [];
    // Seed only the FIRST urlMatches. Multiple urlMatches under the default
    // AND operator would require a single URL to satisfy several substring
    // patterns at once (almost never true). One pattern is the sane default;
    // the author can add more in the Additional predicates section.
    const p = opt.predicates.find(x => x?.kind === 'urlMatches' && typeof x.pattern === 'string' && x.pattern.trim());
    if (p) {
      _perspectiveDraft.predicates = _perspectiveDraft.predicates.filter(x => x?.kind !== 'urlMatches');
      _perspectiveDraft.predicates.push({ kind: 'urlMatches', pattern: p.pattern, mode: p.mode });
      if (typeof _renderPredicates === 'function') _renderPredicates();
    }
  }
  _renderPerspectivePanel();
  updatePerspectiveSaveButtonState();
}

// v2.74.352 — "Resolve roles": adopt the perspective, then ask Claude to
// auto-pick a selector for every role in ONE call. Each returned selector is
// created as a draft landmark and run through the existing verifier
// (verifyPerspectiveLandmark → INSPECT_ELEMENT → uid + score, no extra LLM call).
// Selectors that don't resolve are dropped so their role stays unfilled (○)
// for manual picking. See DESIGN_resolve_roles.md.
async function onResolveRoles(idx) {
  if (!_perspectiveDraft) return;
  const opt = _perspectiveRun?.options?.[idx];
  if (!opt || opt.onPage === false) return;
  if (_perspectiveTabId == null) { showPerspectiveWarning('No active tab to analyze.'); return; }
  if (_perspectiveInFlight || _resolveInFlightKey) return;   // one op at a time
  // Adopt it first (sets chosen + name + predicates + the role checklist).
  onChoosePerspective(idx);
  const roles = (opt.roles ?? [])
    .filter(r => r && typeof r.role === 'string')
    // PB-2 (R4): forward the proposal's featureId so the handler can resolve grounded roles by
    // reuse (the feature's verified selector) instead of asking the LLM to regenerate one.
    .map(r => ({ role: r.role, description: r.description ?? '', multiplicity: r.multiplicity ?? 'one', featureId: r.featureId ?? null }));
  if (!roles.length) return;
  _roleResolveNotes = {};   // fresh run — clear prior notes
  await _runResolve({ opt, roles, priorAttempt: null, mode: 'initial', inFlightKey: String(idx) });
}

// v2.74.356 — Opt-in repair round (DESIGN_resolve_roles.md § 8). Re-resolves
// ONLY the still-unfilled roles, feeding Claude back its prior selector + the
// verification failure reason for each, plus the confirmed successes as
// site-convention context. One LLM round-trip per click; the user is the cap.
async function onRetryFailedRoles(idx) {
  if (!_perspectiveDraft) return;
  const opt = _perspectiveRun?.options?.[idx];
  if (!opt) return;
  if (_perspectiveTabId == null) { showPerspectiveWarning('No active tab to analyze.'); return; }
  if (_perspectiveInFlight || _resolveInFlightKey) return;
  // Roles still unfilled that we have a note for (failed / abstained).
  const retry = (opt.roles ?? []).filter(r => r && typeof r.role === 'string'
    && !_perspectiveRoleFilled(r.role) && _roleResolveNotes[r.role]);
  if (!retry.length) { toast?.('Nothing to retry'); return; }
  const roles = retry.map(r => ({ role: r.role, description: r.description ?? '', multiplicity: r.multiplicity ?? 'one' }));
  // Confirmed successes (working selectors on this site) + prior failed attempts.
  const confirmed = (_perspectiveDraft.landmarks ?? [])
    .filter(lm => lm?.roleFill && lm?.selector && (opt.roles ?? []).some(x => x.role === lm.roleFill))
    .map(lm => ({ role: lm.roleFill, selector: lm.selector }));
  const attempts = retry.map(r => ({ role: r.role, selector: _roleResolveNotes[r.role]?.selector ?? null, reason: _roleResolveNotes[r.role]?.reason ?? 'failed' }));
  await _runResolve({ opt, roles, priorAttempt: { confirmed, attempts }, mode: 'repair', inFlightKey: `retry:${idx}` });
}

// Shared driver for both the initial resolve and the repair round: send the
// request, then create+verify a landmark per returned selector (drop failures),
// record per-role notes/details, log, toast. `_roleResolveNotes` is cleared by
// the caller for an initial run; a repair run updates only the retried roles.
async function _runResolve({ opt, roles, priorAttempt, mode, inFlightKey }) {
  const draftToken = _perspectiveDraft.id;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  _resolveInFlightKey = inFlightKey;
  _renderPerspectivePanel();
  let res;
  try {
    res = await new Promise(r => chrome.runtime.sendMessage({
      type: 'RESOLVE_PERSPECTIVE_ROLES',
      payload: { tabId: _perspectiveTabId, groundId: _perspectiveGroundId, roles, priorAttempt },
    }, r));
  } catch (e) { res = { success: false, error: e?.message ?? 'unknown' }; }
  if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return;   // unmounted / switched mid-flight
  _resolveInFlightKey = null;
  if (!res?.success || !Array.isArray(res.resolutions)) {
    showPerspectiveWarning(`Resolve roles${mode === 'repair' ? ' (retry)' : ''} failed: ${res?.error ?? 'no resolutions returned'}`);
    _renderPerspectivePanel();
    return;
  }
  const multOf = (role) => (opt.roles.find(x => x.role === role)?.multiplicity) ?? 'one';
  let filled = 0, failed = 0, abstained = 0;
  const details = [];
  const profileRefs = [];   // v2.74.390 — visible landmarks to auto-profile after the loop
  for (const r of res.resolutions) {
    if (!r || typeof r.role !== 'string') continue;
    if (!r.selector) {                                   // Claude abstained
      abstained++;
      const reason = (r.justification && r.justification.trim()) || 'Claude found no matching element on this page';
      details.push({ role: r.role, status: 'abstained', reason, confidence: r.confidence });
      _roleResolveNotes[r.role] = { status: 'abstained', reason, selector: null };
      Logger.info('perspective-capture', `resolveRoles[${r.role}]${mode === 'repair' ? '(retry)' : ''} abstained — ${reason}`);
      continue;
    }
    if (_perspectiveRoleFilled(r.role)) {                // already filled — don't duplicate
      details.push({ role: r.role, status: 'skipped', reason: 'role already filled' });
      continue;
    }
    // PB-2/PB-6: carry the grounding through — a reused resolution names the featureId it bound to,
    // so the landmark records its provenance (used by the trial's kind classification + acceptance).
    const lmRef = { alias: r.role, selector: r.selector, roleFill: r.role, roleMult: multOf(r.role), verified: null, featureId: r.featureId ?? null };
    _perspectiveDraft.landmarks.push(lmRef);
    const newIdx = _perspectiveDraft.landmarks.indexOf(lmRef);
    _invalidateStructure();
    try { await verifyPerspectiveLandmark(newIdx); }
    catch (e) { lmRef.verified = { score: 'mismatch', matchedCount: 0, issues: [`verify threw: ${e.message}`] }; }
    if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return;   // bail if torn down mid-verify
    const v = lmRef.verified;
    const ok = v && v.score !== 'mismatch' && (v.score === 'ready' || v.score === 'caveats' || v.matchedCount > 0);
    if (ok) {
      filled++;
      delete _roleResolveNotes[r.role];   // repaired — clear the note
      profileRefs.push(lmRef);            // queue for Claude profiling (visible landmark)
      details.push({ role: r.role, status: 'resolved', selector: r.selector, score: v.score, matchedCount: v.matchedCount, confidence: r.confidence });
      Logger.info('perspective-capture', `resolveRoles[${r.role}]${mode === 'repair' ? '(retry)' : ''} resolved — "${r.selector}" (score=${v.score}, matched=${v.matchedCount})`);
    } else {
      const reason = _verifyFailReason(v);
      const ci = _perspectiveDraft.landmarks.indexOf(lmRef);
      if (ci >= 0) _perspectiveDraft.landmarks.splice(ci, 1);   // drop → role stays for manual pick
      failed++;
      details.push({ role: r.role, status: 'failed', selector: r.selector, reason, matchedCount: v?.matchedCount ?? 0, confidence: r.confidence });
      _roleResolveNotes[r.role] = { status: 'failed', reason, selector: r.selector };
      Logger.warn('perspective-capture', `resolveRoles[${r.role}]${mode === 'repair' ? '(retry)' : ''} verify FAILED — selector="${r.selector}" — ${reason}`);
    }
  }

  // v2.74.381 — Reveal-aware pass. Roles in a hidden layer (modal/menu) can't
  // resolve/verify against the static DOM. Group still-unfilled HIDDEN roles by
  // their trigger, open it, and resolve + verify them WHILE OPEN (done in the
  // background), then fill them as hidden landmarks carrying their trigger.
  const hiddenUnfilled = (opt.roles ?? []).filter(r => r?.role && !_perspectiveRoleFilled(r.role) && (r.hidden === true || r.revealedBy));
  if (hiddenUnfilled.length && _perspectiveTabId != null) {
    const groups = new Map();
    for (const r of hiddenUnfilled) { const k = r.revealedBy || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    for (const [triggerRole, groupRoles] of groups) {
      let triggerSelector = null;
      if (triggerRole) { const lm = (_perspectiveDraft.landmarks ?? []).find(l => l?.roleFill === triggerRole && l?.selector); triggerSelector = lm?.selector ?? null; }
      const reqRoles = groupRoles.map(r => ({ role: r.role, description: r.description ?? '', multiplicity: r.multiplicity ?? 'one' }));
      _resolveInFlightKey = inFlightKey; _renderPerspectivePanel();   // keep the "⏳ Resolving…" state while revealing
      let rr;
      try {
        rr = await new Promise(res => chrome.runtime.sendMessage({
          type: 'RESOLVE_REVEALED_ROLES',
          payload: { tabId: _perspectiveTabId, groundId: _perspectiveGroundId, triggerSelector, triggerLabel: triggerRole, roles: reqRoles },
        }, res));
      } catch (e) { rr = { success: false, error: e?.message ?? 'unknown' }; }
      if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return;
      _resolveInFlightKey = null;
      if (!rr?.success || !Array.isArray(rr.resolutions)) {
        for (const r of groupRoles) { if (!_roleResolveNotes[r.role]) _roleResolveNotes[r.role] = { status: 'failed', reason: `couldn't reveal hidden layer: ${rr?.error ?? 'no result'}`, selector: null }; }
        Logger.warn('perspective-capture', `reveal-resolve [${triggerRole || 'artifact'}] failed — ${rr?.error ?? 'no result'}`);
        continue;
      }
      for (const r of rr.resolutions) {
        if (!r?.role || _perspectiveRoleFilled(r.role)) continue;
        const matched = Number(r.matchedCount) || 0;
        if (!r.selector || matched <= 0) {
          const reason = !r.selector ? ((r.justification && r.justification.trim()) || 'not found in the revealed layer') : 'selector matched nothing in the revealed layer';
          _roleResolveNotes[r.role] = { status: !r.selector ? 'abstained' : 'failed', reason, selector: r.selector || null };
          if (!r.selector) abstained++; else failed++;
          details.push({ role: r.role, status: !r.selector ? 'abstained' : 'failed', selector: r.selector || null, reason, revealed: true });
          continue;
        }
        const lmRef = {
          // v2.74.389 — local uid up front so hidden landmarks are structurable
          // (their element only exists with the modal open, so they can't get a
          // profile uid via static INSPECT; save back-fills the same way).
          uid: 'lmk_local_' + (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
          isCanonical: false,
          alias: r.role, selector: r.selector, roleFill: r.role, roleMult: multOf(r.role),
          hidden: true, revealedBy: triggerRole || null,
          ...(rr.trigger ? { triggerSelector: rr.trigger } : {}),
          verified: { score: matched === 1 ? 'ready' : 'caveats', matchedCount: matched, revealState: true, verifiedAt: Date.now(), note: `verified in revealed state${triggerRole ? ` (via ${triggerRole})` : ''}` },
        };
        _perspectiveDraft.landmarks.push(lmRef);
        _invalidateStructure();
        // v2.74.390 — profile the hidden landmark from the INSPECT report the
        // background captured WHILE the modal was open (the element is gone now,
        // so a fresh static INSPECT can't see it; the profile call itself is
        // text-based and doesn't need the live element).
        if (r.inspect) { try { await _profileResolvedLandmark(_perspectiveDraft.landmarks.indexOf(lmRef), null, r.inspect); } catch { /* */ } }
        delete _roleResolveNotes[r.role];
        filled++;
        details.push({ role: r.role, status: 'resolved', selector: r.selector, score: lmRef.verified.score, matchedCount: matched, revealed: true });
        Logger.info('perspective-capture', `resolveRoles[${r.role}] resolved in REVEALED layer — "${r.selector}" (matched=${matched}, via ${triggerRole || 'artifact'})`);
      }
    }
    renderPerspectiveLandmarks(); _renderPerspectivePanel(); updatePerspectiveSaveButtonState(); _refreshPerspectiveOverlays();
  }

  // v2.74.396 — Resolve Tier-2: VISUAL fallback ("Path C"). For VISIBLE roles the
  // DOM-text pass couldn't resolve (abstained or failed verification), look at the
  // page screenshot and locate the element by region (vision → IoU hit-test), then
  // run the same Pick→Claude refine + verify a manual pick gets. Hidden roles are
  // handled by the reveal pass above (they aren't visible to locate). Bounded so
  // the per-role vision cost lands only on the hard cases.
  const visualCandidates = (opt.roles ?? []).filter(r =>
    r?.role && !_perspectiveRoleFilled(r.role) && !(r.hidden === true || r.revealedBy) && _roleResolveNotes[r.role]);
  if (visualCandidates.length && _perspectiveTabId != null) {
    _resolveInFlightKey = inFlightKey; _renderPerspectivePanel();
    let visualFilled = 0;
    for (const r of visualCandidates.slice(0, 8)) {
      if (_perspectiveRoleFilled(r.role)) continue;
      const prior = _roleResolveNotes[r.role]?.status;
      const okv = await _visualResolveRole(r, multOf(r.role), draftToken);
      if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return;
      if (okv) {
        visualFilled++; filled++;
        if (prior === 'abstained') abstained = Math.max(0, abstained - 1);
        else if (prior)            failed    = Math.max(0, failed - 1);
        details.push({ role: r.role, status: 'resolved', via: 'visual' });
      } else {
        details.push({ role: r.role, status: _roleResolveNotes[r.role]?.status ?? 'failed', via: 'visual', reason: _roleResolveNotes[r.role]?.reason });
      }
    }
    _resolveInFlightKey = null;
    if (visualFilled) {
      Logger.info('perspective-capture', `resolveRoles: visual tier filled ${visualFilled}/${visualCandidates.length} role(s)`);
      renderPerspectiveLandmarks(); _renderPerspectivePanel(); updatePerspectiveSaveButtonState(); _refreshPerspectiveOverlays();
    }
  }

  // v2.74.390 — Auto-profile the VISIBLE resolved landmarks (Claude description /
  // aliases / operationsCommon / pitfalls / expectedContent), mirroring
  // Pick→Claude. Run in PARALLEL so N landmarks ≈ one call's latency. Hidden
  // landmarks were already profiled in the reveal pass (modal open).
  if (profileRefs.length) {
    _resolveInFlightKey = inFlightKey; _renderPerspectivePanel();   // show "⏳ Resolving…" while profiling
    await Promise.all(profileRefs.map(async (ref) => {
      const idx = _perspectiveDraft.landmarks.indexOf(ref);
      if (idx < 0) return;
      try { await _profileResolvedLandmark(idx); } catch { /* */ }
    }));
    if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return;
    _resolveInFlightKey = null;
    Logger.info('perspective-capture', `resolveRoles: profiled ${profileRefs.length} visible landmark(s)`);
  }

  if (perspectiveWarningEl && filled > 0) { perspectiveWarningEl.textContent = ''; perspectiveWarningEl.classList.add('hidden'); }
  renderPerspectiveLandmarks();
  _renderPerspectivePanel();
  updatePerspectiveSaveButtonState();
  _refreshPerspectiveOverlays();
  const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
  _logResolveRun({
    ts: Date.now(),
    url: perspectiveTabUrlEl?.textContent ?? '',
    mode,
    rolesTotal: roles.length,
    resolved: filled, failed, abstained,
    ms,
    score:      _pageComplexity?.score ?? null,
    synthScore: _pageComplexity?.synthScore ?? null,
    matchScore: _pageComplexity?.matchScore ?? null,
    tier:       _pageComplexity?.tier ?? null,
    details,
  });
  Logger.info('perspective-capture', `resolveRoles done [${mode}] — resolved ${filled}/${roles.length}, failed ${failed}, abstained ${abstained}, ${ms}ms, difficulty ${_pageComplexity?.score ?? '?'}`);
  const bits = [`resolved ${filled}`];
  if (failed) bits.push(`${failed} didn't match`);
  if (abstained) bits.push(`${abstained} skipped`);
  const cx = _pageComplexity ? ` · difficulty ${_pageComplexity.score}` : '';
  toast?.(`${mode === 'repair' ? 'Retry' : 'Resolve roles'} — ${bits.join(', ')}${(failed || abstained) ? ' · pick the rest manually' : ''}${cx}`);

  // v2.74.391 — Auto-structure after Resolve: mirror "Structure with Claude"
  // automatically (seeded with the role + verified-trigger priors), so
  // propose→resolve ends with the rich LandmarkNode tree, no extra click. Runs
  // only when this resolve actually filled roles and there are ≥2 uid'd
  // landmarks; on a re-run it refines the prior tree (existing refine path).
  const uidCount = (_perspectiveDraft?.landmarks ?? []).filter(l => l?.uid).length;
  if (filled > 0 && uidCount >= 2) {
    try { await onProposeStructure(); }
    catch (e) { Logger.warn('perspective-capture', `auto-structure after resolve failed: ${e.message}`); }
  }
}

// v2.74.396 — Resolve ONE role visually (Tier-2 / "Path C"). Asks the background
// to locate the role's region on the page screenshot and hit-test it to a real
// element, then runs the SAME Pick→Claude refine + verify a manual pick gets —
// anchored on the REAL resolved rect + a11y profile, so the refine's geometric
// selector challenge compares against a real DOM element, not the LLM-proposed
// box. Returns true iff a verified landmark was created; updates the role's note
// on a miss so the checklist explains why (and leaves it for manual pick).
async function _visualResolveRole(roleDef, mult, draftToken) {
  const role = roleDef.role;
  let res;
  try {
    res = await new Promise(r => chrome.runtime.sendMessage({
      type: 'RESOLVE_ROLE_VISUAL',
      payload: {
        tabId: _perspectiveTabId, groundId: _perspectiveGroundId,
        role: { role, description: roleDef.description ?? '', multiplicity: mult },
        intent: (_perspectiveDraft?.description ?? '').trim(),
      },
    }, r));
  } catch (e) { res = { success: false, error: e?.message ?? 'unknown' }; }
  if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return false;
  if (!res?.success) {
    _roleResolveNotes[role] = { status: 'failed', reason: `visual locate failed: ${res?.error ?? 'unknown'}`, selector: null };
    return false;
  }
  if (!res.found || !res.pick?.selector) {
    _roleResolveNotes[role] = { status: 'abstained', reason: res.note ? `not found visually — ${res.note}` : 'not visible on screen — scroll to it, then pick', selector: null };
    Logger.info('perspective-capture', `resolveRoles[${role}] visual: not found — ${res.note ?? ''}`);
    return false;
  }
  const pick = res.pick;
  const lmRef = { alias: role, selector: pick.selector, roleFill: role, roleMult: mult, verified: null };
  if (pick.frame && pick.frame.url && pick.frame.isTop === false) lmRef.frameUrl = String(pick.frame.url);
  _perspectiveDraft.landmarks.push(lmRef);
  _invalidateStructure();
  const idx = _perspectiveDraft.landmarks.indexOf(lmRef);
  // Path A step 4 — Pick→Claude refine (INSPECT + screenshots + full profile +
  // the geometric selector challenge), fed the REAL resolved rect + a11y profile.
  try {
    await _refineLandmarkSelectorWithClaude(idx, {
      pickedRect                : pick.rect ?? null,
      viewportInfo              : pick.viewportInfo ?? null,
      pickedAccessibilityProfile: pick.accessibilityProfile ?? null,
    });
  } catch (e) { Logger.warn('perspective-capture', `visual refine threw for ${role}: ${e.message}`); }
  if (!_perspectiveDraft || _perspectiveDraft.id !== draftToken) return false;
  const curIdx = _perspectiveDraft.landmarks.indexOf(lmRef);
  if (curIdx < 0) return false;
  try { await verifyPerspectiveLandmark(curIdx); } catch { /* */ }
  const v = lmRef.verified;
  const ok = v && v.score !== 'mismatch' && (v.score === 'ready' || v.score === 'caveats' || v.matchedCount > 0);
  if (ok) {
    delete _roleResolveNotes[role];
    Logger.info('perspective-capture', `resolveRoles[${role}] resolved VISUALLY — "${lmRef.selector}" (IoU ${typeof pick.iou === 'number' ? pick.iou.toFixed(2) : '?'}, score=${v.score}, matched=${v.matchedCount})`);
    return true;
  }
  const ci = _perspectiveDraft.landmarks.indexOf(lmRef);
  if (ci >= 0) _perspectiveDraft.landmarks.splice(ci, 1);
  _roleResolveNotes[role] = { status: 'failed', reason: `visual pick didn't verify: ${_verifyFailReason(v)}`, selector: lmRef.selector };
  return false;
}

// Pick (or re-pick) the element that fills a role. A fresh role → CREATE-mode
// pick (new landmark, alias + roleFill seeded from the role on PICK_RESULT);
// an already-filled role → RE-PICK that landmark.
function onPickForRole(role) {
  if (!role) return;
  const roleDef = (_chosenPerspective?.roles ?? []).find(r => r.role === role);
  const slot = { role, multiplicity: roleDef?.multiplicity ?? 'one', description: roleDef?.description ?? '' };
  const existingIdx = (_perspectiveDraft?.landmarks ?? []).findIndex(lm => lm?.roleFill === role);
  startPerspectivePick(existingIdx >= 0 ? existingIdx : null, slot);
}

// ─── Resolve-difficulty complexity badge (v2.74.353) ──────────────────────

// Fetch the deterministic complexity report for the current tab + render the
// header badge. Fire-and-forget from mount / tab change. See § 7 of
// DESIGN_resolve_roles.md.
async function _refreshComplexity() {
  if (!perspectiveComplexityBadge) return;
  if (_perspectiveTabId == null) { _pageComplexity = null; _renderComplexityBadge(); return; }
  const token = _perspectiveTabId;
  perspectiveComplexityBadge.textContent = '…';
  perspectiveComplexityBadge.className = 'dbg-perspective-complexity';
  let res;
  try {
    res = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_PAGE_COMPLEXITY', payload: { tabId: token } }, r));
  } catch (e) { res = { success: false, error: e?.message }; }
  if (_perspectiveTabId !== token) return;   // tab changed mid-fetch
  _pageComplexity = (res?.success && res.report) ? res.report : null;
  _renderComplexityBadge();
}

function _renderComplexityBadge() {
  if (!perspectiveComplexityBadge) return;
  const r = _pageComplexity;
  if (!r) {
    perspectiveComplexityBadge.textContent = '—';
    perspectiveComplexityBadge.className = 'dbg-perspective-complexity';
    perspectiveComplexityBadge.setAttribute('title', 'How hard this page is for ⚡ Resolve roles (selector resolution).');
    return;
  }
  const tierLabel = r.tier.charAt(0).toUpperCase() + r.tier.slice(1);
  perspectiveComplexityBadge.textContent = `🧩 ${tierLabel} · ${r.score}`;
  perspectiveComplexityBadge.className = `dbg-perspective-complexity cx-${r.tier}`;
  const c = r.counts ?? {}, f = r.factors ?? {};
  const pct = (x) => Math.round((x ?? 0) * 100);
  perspectiveComplexityBadge.setAttribute('title',
    `Resolve difficulty ${r.score}/100 (${tierLabel})\n` +
    `Synthesis (write a durable selector): ${r.synthScore}/100\n` +
    `  hooks missing ${pct(f.hookScarcity)}% · obfuscated classes ${pct(f.obfuscation)}% · div-soup ${pct(f.genericRatio)}% · shadow roots ${c.shadowRoots ?? 0} · ${c.total ?? 0} els, depth ${c.maxDepth ?? 0}\n` +
    `Matching (which element is it): ${r.matchScore}/100\n` +
    `  off-screen candidates ${pct(f.offscreen)}% · opaque controls ${pct(f.opaque)}%\n` +
    `Candidates: ${c.candHooked ?? 0}/${c.candTotal ?? 0} hooked · iframes ${(c.sameOriginIframes ?? 0) + (c.crossOriginIframes ?? 0)} (${c.crossOriginIframes ?? 0} cross-origin)`);
}

// v2.74.355 — Human-readable "why verification failed" from the verified
// verdict (the issues/checks the verifier already computes).
function _verifyFailReason(v) {
  if (!v) return 'no verification result (selector threw or returned nothing)';
  if ((v.matchedCount ?? 0) === 0) return (v.issues && v.issues[0]) || 'selector matched 0 elements on the page';
  if (Array.isArray(v.issues) && v.issues.length) return v.issues[0];
  if (v.score === 'mismatch') {
    const c = v.checks || {};
    if (c.visible === false) return 'matched element is not visible';
    if (c.interactable === false) return 'matched element is not interactable';
    if (c.typeMatchesRole === false) return 'matched element type does not match the role';
    if (c.uniqueMatch === false) return `selector matched ${v.matchedCount} elements (expected one)`;
    return 'verification mismatch';
  }
  return `unverified (score=${v.score ?? 'unknown'})`;
}

// Persist one Resolve-roles run outcome against the page's complexity so
// success-rate-vs-difficulty can be plotted over iterations. Capped ring.
async function _logResolveRun(entry) {
  try {
    const KEY = 'resolveRoles:perf';
    const got = await new Promise(r => chrome.storage.local.get(KEY, r));
    const list = Array.isArray(got?.[KEY]) ? got[KEY] : [];
    list.push(entry);
    while (list.length > 200) list.shift();
    await new Promise(r => chrome.storage.local.set({ [KEY]: list }, r));
  } catch (e) {
    Logger?.warn?.('perspective-capture', `resolve perf-log failed: ${e.message}`);
  }
  // v2.74.414 — OUTCOMES slice 3: also emit the run into the append-only stream
  // (background transforms each detail → authoring `resolve` OutcomeEvent). The
  // perf log is unchanged; this is the corpus/usage signal. Fire-and-forget —
  // never let an emit failure affect resolve. (Perspective = the draft being
  // authored; the new-terminology Perspective is the page archetype, keyed by URL.)
  try {
    if (_perspectiveGroundId && Array.isArray(entry?.details) && entry.details.length) {
      chrome.runtime.sendMessage({
        type: 'EMIT_RESOLVE_OUTCOMES',
        payload: { groundId: _perspectiveGroundId, run: entry, ctx: { localeId: entry.url ?? null, perspectiveId: _perspectiveDraft?.id ?? null } },
      }, () => void chrome.runtime.lastError);
    }
  } catch (e) {
    Logger?.warn?.('perspective-capture', `resolve outcomes emit failed: ${e.message}`);
  }
}

// ─── Landmark rendering ──────────────────────────────────────────────────

function renderPerspectiveLandmarks() {
  if (!_perspectiveDraft || !perspectiveLandmarksList) return;
  if (_perspectiveDraft.landmarks.length === 0) {
    perspectiveLandmarksList.innerHTML = `<div class="dbg-perspective-landmarks-empty">No landmarks yet — click + Pick landmark to add one.</div>`;
    return;
  }
  perspectiveLandmarksList.innerHTML = _renderStructureBar() + _perspectiveDraft.landmarks.map((lm, idx) => {
    // v2.74.279 — Status computation moved to _computeLandmarkStatusIcon
    // (used in identity zone). Verification detail (issues, ops, sample
    // HTML) rendered in the drawer's Verification subsection by
    // _renderLandmarkVerificationSection. No inline statusHtml block
    // needed at the row level anymore.
    // v2.74.233 — Claude is now built into the picker flow itself
    // (Pick → picker captures element → DOM context + role + screenshot
    // ship to Claude → Claude's selector becomes the landmark's
    // selector). The standalone "Ask Claude" button is gone.
    //
    // Per-landmark "Show" toggle (eye icon) toggles the on-page
    // overlay for THIS landmark independent of others. Green accent
    // when active so the author can see at a glance which landmarks
    // are currently highlighted on the live page.
    const showActive = lm.showOverlay === true;
    const showBtnLabel = showActive ? '👁' : '◌';
    const showBtnTitle = showActive
      ? 'Hide this landmark overlay on the page'
      : 'Show this landmark overlay on the page (green outline)';
    // v2.74.233 — Claude-refining state: when the picker just fired
    // and we're awaiting Claude's refined selector, show a small
    // inline indicator instead of the regular status.
    const refining = _landmarkRefining.get(idx);
    let extraStatusHtml = '';
    if (refining) {
      extraStatusHtml = `<div class="dbg-perspective-landmark-refining">⌛ ${escHtml(refining)}</div>`;
    }
    // v2.74.238 — Row chrome reduced to semantic identity + action
    // affordances. Selector input + Verify button moved to the
    // profile drawer (selector display, Verify is automatic after
    // Pick→Claude). Perspectives are now the SSOT for selectors; the
    // selector is an implementation detail the author can inspect
    // in the drawer rather than always-on UI clutter.
    // v2.74.257 — Replace button visible only when the landmark has a
    // UID (i.e., persisted to the registry). For fresh in-memory
    // landmarks there's nothing to replace yet — the next Pick assigns
    // the realization. Sits between 👁 (toggle-show) and ✕ (remove)
    // so the destructive action stays at the end of the row.
    const replaceBtnHtml = lm.uid
      ? `<button class="dbg-perspective-landmark-replace" data-action="replace-open" data-idx="${idx}" type="button" title="Swap downstream references to a different landmark">↻</button>`
      : '';
    // v2.74.258 — Verify button (Phase 9 surface). Same uid gate as
    // Replace — needs a registry record to probe. In-flight is shown
    // via spinner glyph; click is suppressed during round-trip.
    const verifyInFlight = _landmarkVerifyInFlight.has(idx);
    const verifyBtnHtml = lm.uid
      ? `<button class="dbg-perspective-landmark-verify" data-action="verify" data-idx="${idx}" type="button" ${verifyInFlight ? 'disabled' : ''} title="Probe this landmark against the live page. Cached selector works → lifecycle promotes to verified. Heuristic recovery → selector updated. Both fail → lifecycle marks stale-confirmed.">${verifyInFlight ? '⌛' : '✓'}</button>`
      : '';
    // v2.74.281 — Tight single-row header. Status icon sits as a
    // left-edge column. Main column has accessibleName on top, and a
    // single inline controls row below it carrying: alias input,
    // action buttons, drawer toggle. No empty space — alias and
    // buttons share the same horizontal flow.
    const statusIcon = _computeLandmarkStatusIcon(lm);
    // v2.74.304 — Tiered display-name derivation. Replaces the
    // binary "accessibleName or No element picked yet" rendering.
    // The previous code lied in State B (selector picked, element
    // has no W3C-computed accessible name) by claiming nothing
    // was picked. The deriver now distinguishes:
    //   - State A (no pick yet)             → "No element picked yet"
    //   - State B (no accessibleName)       → derived label, italicized
    //   - Canonical (accessibleName present) → normal text
    // The Identity drawer section still shows the raw accessibleName
    // field as ground truth — author can spot accessibility-poor
    // picks there. This change is cosmetic-only: lm.accessibleName,
    // lm.uid, lm.isCanonical all stay untouched.
    const displayName = _deriveLandmarkDisplayName(lm);
    const isExpanded = _landmarkProfileExpanded.has(idx);
    const caret = isExpanded ? '▾' : '▸';
    return `
      <div class="dbg-perspective-landmark-row" data-idx="${idx}">
        <div class="lm-header">
          <span class="lm-status-icon ${statusIcon.cls}" title="${escAttr(statusIcon.tooltip)}">${statusIcon.icon}</span>
          <div class="lm-header-main">
            <div class="lm-name">${displayName}</div>
            <div class="lm-controls">
              <input type="text" class="dbg-perspective-landmark-role lm-alias-input" data-field="aliases" data-idx="${idx}"
                     placeholder="aliases (comma-separated)"
                     title="Comma-separated identifiers for this landmark. First entry is the primary alias; the rest are alternative names. Auto-populated from Claude's suggestions on Pick."
                     value="${escAttr([lm.alias, ...(Array.isArray(lm.aliases) ? lm.aliases : [])].filter(s => s && String(s).trim()).join(', '))}" />
              <button class="dbg-perspective-landmark-pick" data-action="pick" data-idx="${idx}" type="button" title="Re-pick this landmark on the page">Pick</button>
              <button class="dbg-perspective-landmark-show ${showActive ? 'dbg-perspective-landmark-show-active' : ''}" data-action="toggle-show" data-idx="${idx}" type="button" title="${escAttr(showBtnTitle)}">${showBtnLabel}</button>
              ${verifyBtnHtml}
              ${replaceBtnHtml}
              <button class="dbg-perspective-landmark-remove" data-action="remove" data-idx="${idx}" title="Remove" type="button">✕</button>
              <button class="lm-details-toggle" data-action="profile-toggle" data-idx="${idx}" type="button" title="${isExpanded ? 'Collapse details' : 'Expand details — identity, realization, description, verification, profile, lifecycle'}" aria-expanded="${isExpanded ? 'true' : 'false'}">${caret}</button>
            </div>
          </div>
        </div>
        ${extraStatusHtml}
        ${_renderLandmarkVerifyOutcome(idx)}
        ${_renderLandmarkReplacePicker(idx)}
        ${isExpanded ? _renderLandmarkProfileDrawer(idx) : ''}
      </div>`;
  }).join('');

  // v2.74.238 — Only the role input has data-field after the selector
  // field was removed from the row.
  // v2.74.302 — Field renamed alias → aliases (comma-separated). The
  // visible row-header input now carries the full alias list: primary
  // alias in slot 0, secondaries in slots 1..N. On edit we parse the
  // comma-list, normalize each entry (lowercase + hyphen-spaces), then
  // split: first → lm.alias, rest → lm.aliases. This is the single
  // source of truth for alias authoring — the drawer's separate
  // "Secondary aliases" field was removed (it was redundant once the
  // header field went plural).
  // v2.74.336 — Phase C-lite: wire the "Structure with Claude" button.
  const _structBtn = perspectiveLandmarksList.querySelector('[data-perspective-action="propose-structure"]');
  if (_structBtn) _structBtn.addEventListener('click', onProposeStructure);
  const _verifyBtn = perspectiveLandmarksList.querySelector('[data-perspective-action="verify-structure"]');
  if (_verifyBtn) _verifyBtn.addEventListener('click', onVerifyStructure);

  // v2.74.344 — Phase B-lite: per-node structure review. role/multiplicity
  // edits update the node in place (no re-render → preserve input focus) and
  // flag it 'edited'; the ✓/✗ judgment buttons set userJudgment + re-render
  // to reflect the state.
  perspectiveLandmarksList.querySelectorAll('[data-struct-action]').forEach(el => {
    const action = el.dataset.structAction;
    const ref    = el.dataset.ref;
    if (action === 'role') {
      el.addEventListener('input', () => {
        const node = _findStructNode(ref);
        if (!node) return;
        node.role = el.value.trim();
        _markStructJudgment(node, 'edited');
      });
    } else if (action === 'mult') {
      el.addEventListener('change', () => {
        const node = _findStructNode(ref);
        if (!node) return;
        node.multiplicity = el.value;
        _markStructJudgment(node, 'edited');
        // v2.74.361 — re-render so the "when present" input shows/hides as the
        // node becomes conditional/optional (or no longer is).
        renderPerspectiveLandmarks();
      });
    } else if (action === 'presence') {
      // v2.74.361 — edit in place (no re-render → preserve focus).
      el.addEventListener('input', () => {
        const node = _findStructNode(ref);
        if (!node) return;
        node.presenceCondition = el.value.trim();
        _markStructJudgment(node, 'edited');
      });
    } else if (action === 'untrigger') {
      // v2.74.361 — prune a Claude-proposed trigger ref.
      el.addEventListener('click', () => {
        const node = _findStructNode(ref);
        if (!node || !Array.isArray(node.triggers)) return;
        node.triggers = node.triggers.filter(t => t !== el.dataset.trigger);
        if (!node.triggers.length) delete node.triggers;
        _markStructJudgment(node, 'edited');
        renderPerspectiveLandmarks();
      });
    } else if (action === 'judge') {
      el.addEventListener('click', () => {
        const node = _findStructNode(ref);
        if (!node) return;
        _markStructJudgment(node, el.dataset.judgment);
        renderPerspectiveLandmarks();
      });
    } else if (action === 'indent') {
      // v2.74.345 — B-mid: nest under preceding sibling, then re-render so
      // the new depth/indentation and updated gating reflect immediately.
      el.addEventListener('click', () => { _indentStructNode(ref); renderPerspectiveLandmarks(); });
    } else if (action === 'outdent') {
      el.addEventListener('click', () => { _outdentStructNode(ref); renderPerspectiveLandmarks(); });
    }
  });

  // v2.74.346 — Phase B-mid (overlays): review groupings/sequences. name edit
  // updates in place + flags 'edited' (no re-render → preserve focus); judge
  // sets userJudgment + re-renders; delete removes the overlay + re-renders.
  perspectiveLandmarksList.querySelectorAll('[data-overlay-action]').forEach(el => {
    const action = el.dataset.overlayAction;
    const kind   = el.dataset.overlayKind;
    const idx    = parseInt(el.dataset.overlayIdx, 10);
    if (action === 'name') {
      el.addEventListener('input', () => {
        const ov = _findOverlay(kind, idx);
        if (!ov) return;
        ov.name = el.value.trim();
        _markStructJudgment(ov, 'edited');
      });
    } else if (action === 'judge') {
      el.addEventListener('click', () => {
        const ov = _findOverlay(kind, idx);
        if (!ov) return;
        _markStructJudgment(ov, el.dataset.judgment);
        renderPerspectiveLandmarks();
      });
    } else if (action === 'delete') {
      el.addEventListener('click', () => { _deleteOverlay(kind, idx); renderPerspectiveLandmarks(); });
    }
  });

  perspectiveLandmarksList.querySelectorAll('input[data-field]').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = parseInt(inp.dataset.idx, 10);
      const f = inp.dataset.field;
      if (!_perspectiveDraft.landmarks[idx]) return;
      if (f === 'aliases') {
        // Parse comma-separated list. Empty entries dropped. Each
        // normalized to lowercase + dash-joined (matches the same
        // shape Claude's aliases use, so author and Claude entries
        // are interchangeable).
        const parts = String(inp.value || '')
          .split(',')
          .map(s => s.trim().toLowerCase().replace(/\s+/g, '-'))
          .filter(Boolean)
          .slice(0, 6);   // hard cap — same as Claude's max
        _perspectiveDraft.landmarks[idx].alias   = parts[0] ?? '';
        _perspectiveDraft.landmarks[idx].aliases = parts.slice(1);
      } else {
        _perspectiveDraft.landmarks[idx][f] = inp.value;
      }
      if (_perspectiveDraft.landmarks[idx].verified) {
        _perspectiveDraft.landmarks[idx].verified = null;
        renderPerspectiveLandmarks();
        const next = perspectiveLandmarksList.querySelector(`input[data-field="${f}"][data-idx="${idx}"]`);
        if (next) {
          next.focus();
          next.setSelectionRange(next.value.length, next.value.length);
        }
      }
      updatePerspectiveSaveButtonState();
    });
  });
  perspectiveLandmarksList.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const action = btn.dataset.action;
      if (action === 'remove') {
        // v2.74.243 — Phase 5: reference integrity. Before removing,
        // run blast-radius analysis against the registry for any
        // landmark that has a UID. If it's referenced by other
        // perspectives / fragments / observations, surface the impact
        // and require explicit confirmation. Landmarks without a
        // UID (legacy, never saved to registry) skip the check.
        _removeLandmarkWithImpactCheck(idx);
      } else if (action === 'pick') {
        startPerspectivePick(idx);
      } else if (action === 'toggle-show') {
        // v2.74.233 — Per-landmark overlay visibility toggle. State
        // is ephemeral (not persisted to the saved record). Triggers
        // an overlay refresh so the change is visible immediately.
        const lm = _perspectiveDraft.landmarks[idx];
        if (!lm) return;
        lm.showOverlay = lm.showOverlay !== true;
        renderPerspectiveLandmarks();
        _refreshPerspectiveOverlays();
      } else if (action === 'profile-toggle') {
        // v2.74.235 — Expand/collapse the profile drawer for this
        // landmark. State is ephemeral.
        if (_landmarkProfileExpanded.has(idx)) _landmarkProfileExpanded.delete(idx);
        else _landmarkProfileExpanded.add(idx);
        renderPerspectiveLandmarks();
      } else if (action === 'verify') {
        // v2.74.258 — Phase 9 surface. Probe the landmark against the
        // live page; lifecycle + selector update server-side. The row
        // re-renders with the outcome and the new lifecycle chip.
        _verifyLandmarkInRow(idx);
      } else if (action === 'replace-open') {
        // v2.74.257 — Phase 10.5 surface. Toggle the replacement
        // candidate picker. First open kicks off a candidate fetch;
        // re-open without close re-uses cached candidates.
        _toggleReplacePicker(idx);
      } else if (action === 'replace-cancel') {
        _closeReplacePicker(idx);
        renderPerspectiveLandmarks();
      } else if (action === 'replace-commit') {
        const newUid = btn.dataset.newUid;
        if (newUid) _commitLandmarkReplace(idx, newUid);
      } else if (action === 'lifecycle-deprecate') {
        _setLandmarkLifecycle(idx, 'deprecated');
      } else if (action === 'lifecycle-restore') {
        _setLandmarkLifecycle(idx, 'fresh');
      } else if (action === 'open-screenshot') {
        // v2.74.293 — Open the captured screenshot in a new tab. Data
        // URL goes through a blob conversion because MV3 silently drops
        // chrome.tabs.create({url:'data:...'}) calls.
        // v2.74.300 — Prefer the wider context shot (with red highlight
        // box) over the tight thumbnail when available. The author
        // wants to SEE WHAT CLAUDE SAW when reviewing landmark quality —
        // the context shot is exactly that. Fall back to the tight
        // thumb when context capture failed (iframe element, etc.).
        const lm = _perspectiveDraft?.landmarks?.[idx];
        const opened = lm?.captureContextScreenshot || lm?.captureScreenshot;
        if (opened) _openScreenshotInNewTab(opened);
      }
    });
  });
  // v2.74.235 — Profile-field edit handlers. Description + aliases
  // are author-editable; Claude's output is just a starting point.
  // The author's edit wins on save.
  perspectiveLandmarksList.querySelectorAll('[data-action="profile-desc-edit"]').forEach(el => {
    el.addEventListener('input', () => {
      const i = parseInt(el.dataset.idx, 10);
      if (!_perspectiveDraft.landmarks[i]) return;
      _perspectiveDraft.landmarks[i].description = el.value;
    });
  });
  // v2.74.302 — `profile-aliases-edit` handler removed. The drawer no
  // longer has a separate "Secondary aliases" input; the row-header
  // "aliases" input (data-field="aliases") covers primary + secondaries.
  // v2.74.305 — Replaced v2.74.244's single profile-effect-edit
  // handler. Effect is now structured (kind + parameter) AND
  // interaction pattern is separate. Three handlers below.
  perspectiveLandmarksList.querySelectorAll('[data-action="profile-effect-kind-edit"]').forEach(el => {
    el.addEventListener('change', () => {
      const i = parseInt(el.dataset.idx, 10);
      const lm = _perspectiveDraft?.landmarks?.[i];
      if (!lm) return;
      const newKind = el.value;
      // Reset to default-parameter shape per kind. If the new kind
      // takes no parameter, store just { kind }.
      if (newKind === 'opens-new-thread') {
        const prevForm = lm.effect?.form;
        lm.effect = { kind: newKind, form: prevForm || 'tab' };
      } else if (newKind === 'triggers-modal') {
        const prevModalKind = lm.effect?.modalKind;
        lm.effect = { kind: newKind, modalKind: prevModalKind || 'confirm' };
      } else {
        lm.effect = { kind: newKind };
      }
      lm.effectSource = 'authored';   // v2.74.309 — author set this
      renderPerspectiveLandmarks();   // re-render to show/hide param picker
    });
  });
  perspectiveLandmarksList.querySelectorAll('[data-action="profile-effect-form-edit"]').forEach(el => {
    el.addEventListener('change', () => {
      const i = parseInt(el.dataset.idx, 10);
      const lm = _perspectiveDraft?.landmarks?.[i];
      if (!lm?.effect) return;
      if (lm.effect.kind !== 'opens-new-thread') return;
      lm.effect = { ...lm.effect, form: el.value };
      lm.effectSource = 'authored';
    });
  });
  perspectiveLandmarksList.querySelectorAll('[data-action="profile-effect-modal-kind-edit"]').forEach(el => {
    el.addEventListener('change', () => {
      const i = parseInt(el.dataset.idx, 10);
      const lm = _perspectiveDraft?.landmarks?.[i];
      if (!lm?.effect) return;
      if (lm.effect.kind !== 'triggers-modal') return;
      lm.effect = { ...lm.effect, modalKind: el.value };
      lm.effectSource = 'authored';
    });
  });
  perspectiveLandmarksList.querySelectorAll('[data-action="profile-pattern-edit"]').forEach(el => {
    el.addEventListener('change', () => {
      const i = parseInt(el.dataset.idx, 10);
      const lm = _perspectiveDraft?.landmarks?.[i];
      if (!lm) return;
      lm.interactionPattern = el.value;
      lm.effectSource = 'authored';
    });
  });
}

/**
 * v2.74.305 — Phase 1 migration. Existing landmark records carry a
 * legacy `lm.actionEffect` string from the v2.74.303 vocabulary. This
 * helper splits the string into the spec-aligned `effect` object +
 * `interactionPattern` field. Idempotent — safe to call on already-
 * migrated records (no-op when `effect` is already an object).
 *
 * Called from the landmark hydration paths so the in-memory shape is
 * always the new one regardless of what's in storage. Save path also
 * cleans up legacy fields.
 *
 * Mapping:
 *   'unknown'           → effect: none,              pattern: none
 *   'none'              → effect: none,              pattern: none
 *   'triggers-navigation' → effect: triggers-navigation, pattern: none
 *   'opens-new-thread'  → effect: opens-new-thread.tab, pattern: none
 *   'triggers-download' → effect: triggers-download, pattern: none
 *   'triggers-modal'    → effect: triggers-modal.confirm, pattern: none
 *                          (best guess on modalKind — author can refine)
 *   'opens-menu'        → effect: none, pattern: opens-menu
 *   'switches-tab'      → effect: none, pattern: switches-tab
 *   'toggles-expansion' → effect: none, pattern: toggles-expansion
 *   'toggles-state'     → effect: none, pattern: toggles-state
 *   'submits-in-place'  → effect: none, pattern: submits-in-place
 *   'mutates-page'      → effect: none, pattern: mutates-page
 */
function _hydrateLandmarkEffectShape(lm) {
  if (!lm || typeof lm !== 'object') return lm;
  if (lm.effect && typeof lm.effect === 'object') return lm;   // already migrated
  const legacy = typeof lm.actionEffect === 'string' ? lm.actionEffect : '';
  const MAP = {
    'unknown'            : { effect: { kind: 'none' },                                 interactionPattern: 'none' },
    'none'               : { effect: { kind: 'none' },                                 interactionPattern: 'none' },
    'triggers-navigation': { effect: { kind: 'triggers-navigation' },                  interactionPattern: 'none' },
    'opens-new-thread'   : { effect: { kind: 'opens-new-thread', form: 'tab' },        interactionPattern: 'none' },
    'triggers-download'  : { effect: { kind: 'triggers-download' },                    interactionPattern: 'none' },
    'triggers-modal'     : { effect: { kind: 'triggers-modal', modalKind: 'confirm' }, interactionPattern: 'none' },
    'opens-menu'         : { effect: { kind: 'none' },                                 interactionPattern: 'opens-menu' },
    'switches-tab'       : { effect: { kind: 'none' },                                 interactionPattern: 'switches-tab' },
    'toggles-expansion'  : { effect: { kind: 'none' },                                 interactionPattern: 'toggles-expansion' },
    'toggles-state'      : { effect: { kind: 'none' },                                 interactionPattern: 'toggles-state' },
    'submits-in-place'   : { effect: { kind: 'none' },                                 interactionPattern: 'submits-in-place' },
    'mutates-page'       : { effect: { kind: 'none' },                                 interactionPattern: 'mutates-page' },
  };
  const migrated = MAP[legacy] || { effect: { kind: 'none' }, interactionPattern: 'none' };
  lm.effect = migrated.effect;
  lm.interactionPattern = migrated.interactionPattern;
  // Keep legacy field around for one version cycle so any external
  // consumers that read it don't break instantly. It'll be removed
  // in a follow-up. Mark with leading underscore to indicate deprecated.
  if (lm.actionEffect != null) {
    lm._legacyActionEffect = lm.actionEffect;
    delete lm.actionEffect;
  }
  return lm;
}

function updatePerspectiveSaveButtonState() {
  if (!_perspectiveDraft || !perspectiveSaveBtn) { if (perspectiveSaveBtn) perspectiveSaveBtn.disabled = true; return; }
  // v2.74.282 — Compute the first blocking reason in priority order:
  //   1. Name
  //   2. URL predicate
  //   3. At least one landmark
  //   4. Per-landmark validity (alias, selector, verified, score)
  // Surfaced via title attribute (hover) AND inline hint element so
  // authors don't have to guess why Save is disabled.
  let reason = null;
  const name = (perspectiveNameInput?.value ?? '').trim();
  if (!name) {
    reason = 'Perspective needs a name (top of the form)';
  }
  // v2.74.348 — PERSPECTIVE_SPEC § 6 / § 15 EmptyDescriptionError: the description
  // is the intent-capture entry point and is mandatory in presence at save.
  if (!reason) {
    const desc = (perspectiveDescriptionInput?.value ?? _perspectiveDraft.description ?? '').trim();
    if (!desc) {
      reason = 'Perspective needs a description (it captures the intent — top of the form)';
    }
  }
  if (!reason) {
    const hasUrlPredicate = Array.isArray(_perspectiveDraft.predicates)
      && _perspectiveDraft.predicates.some(p =>
        p?.kind === 'urlMatches' && typeof p.pattern === 'string' && p.pattern.trim().length > 0
      );
    if (!hasUrlPredicate) {
      reason = 'Add a URL-matches predicate in the Additional predicates section (otherwise the perspective matches every page on this Ground)';
    }
  }
  if (!reason) {
    if (!Array.isArray(_perspectiveDraft.landmarks) || _perspectiveDraft.landmarks.length === 0) {
      reason = 'Add at least one landmark (click + Pick landmark)';
    }
  }
  if (!reason) {
    for (let i = 0; i < _perspectiveDraft.landmarks.length; i++) {
      const lm = _perspectiveDraft.landmarks[i];
      const tag = lm.accessibleName ?? lm.alias ?? `#${i + 1}`;
      if (!lm.alias || !lm.alias.trim()) {
        reason = `Landmark "${tag}" needs an alias`;
        break;
      }
      if (!lm.selector || !lm.selector.trim()) {
        reason = `Landmark "${tag}" hasn't been picked yet — click Pick on its row`;
        break;
      }
      if (!lm.verified) {
        reason = `Landmark "${tag}" not yet verified — click ✓ to verify against the live page`;
        break;
      }
      // v2.74.234 — Save gate uses the multi-axis verification score:
      // 'mismatch' blocks; 'ready'/'caveats'/legacy matchedCount pass.
      if (lm.verified.score === 'mismatch') {
        const issues = Array.isArray(lm.verified.issues) && lm.verified.issues.length > 0
          ? ` (${lm.verified.issues[0]})` : '';
        reason = `Landmark "${tag}" failed verification${issues} — re-Pick or fix the selector`;
        break;
      }
      if (!lm.verified.score && !(lm.verified.matchedCount > 0)) {
        reason = `Landmark "${tag}" matched 0 elements on the page — re-Pick or fix the selector`;
        break;
      }
    }
  }
  const isDisabled = reason !== null;
  perspectiveSaveBtn.disabled = isDisabled;
  if (isDisabled) {
    perspectiveSaveBtn.setAttribute('title', reason);
    if (perspectiveSaveReasonEl) {
      perspectiveSaveReasonEl.textContent = reason;
      perspectiveSaveReasonEl.classList.remove('hidden');
    }
  } else {
    perspectiveSaveBtn.removeAttribute('title');
    if (perspectiveSaveReasonEl) {
      perspectiveSaveReasonEl.textContent = '';
      perspectiveSaveReasonEl.classList.add('hidden');
    }
  }
}

// ─── Picker integration ──────────────────────────────────────────────────

async function startPerspectivePick(landmarkIdx, roleSlot) {
  if (!_perspectiveDraft) return;
  // v2.74.280 — Two modes:
  //   landmarkIdx === null : CREATE mode (entered via "+ Pick landmark").
  //     No row exists yet. On PICK_RESULT, a new landmark is pushed +
  //     populated by Pick→Claude. Cancel/error: no landmark is created.
  //   landmarkIdx === number : RE-PICK mode (entered via row's Pick
  //     button). Existing row's element is being changed; selector and
  //     identity get refreshed.
  const isCreate = landmarkIdx === null;
  if (!isCreate && !_perspectiveDraft.landmarks[landmarkIdx]) return;
  // v2.74.274 — Gate softened. Author-typed alias is no longer
  // required before Pick. Rationale (see SPEC_DEV entry [2026-05-21]
  // — alias field cleanup): the alias is a per-perspective identifier
  // and Claude hint, not part of substrate canonical identity. The
  // natural flow is "Pick first, label later"; the post-Pick path
  // auto-fills the alias from the computed accessibleName when
  // blank, so the common case needs zero typing.
  //
  // Claude refinement still gets a role hint — falls back to
  // 'landmark' (matched downstream in GENERATE_LANDMARK_PROFILE_BG).
  // The author can override the alias at any time.
  if (_perspectivePickerSession) await cancelPerspectivePick(true);
  if (_perspectiveTabId == null) {
    showPerspectiveWarning('No capture tab. Cancel and start over.');
    return;
  }

  const ready = await pingContentScript(_perspectiveTabId);
  if (!ready.ok) {
    showPerspectiveWarning(`Pick failed: ${ready.error}. ${ready.hint ?? ''}`);
    return;
  }

  const sessionId = `perspective_pick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // v2.74.348 — roleSlot ({role, multiplicity}) is carried through so the
  // PICK_RESULT handler can bind the resulting landmark to a § 13 role.
  _perspectivePickerSession = { sessionId, landmarkIdx, roleSlot: roleSlot ?? null };

  // v2.74.166 — Frame-aware broadcast (same helper fragment-author and
  // observation-author use). Perspective landmarks can now point at
  // elements inside same-origin iframes.
  const startRes = await broadcastStartPick(_perspectiveTabId, {
    sessionId, mode: 'target', containerSelector: '', multiCandidate: false,
  });
  if (!startRes.success) {
    _perspectivePickerSession = null;
    showPerspectiveWarning(`Pick failed: ${startRes.error}`);
    return;
  }
  if (perspectivePickBanner) perspectivePickBanner.classList.remove('hidden');
}

async function cancelPerspectivePick(notifyContentScript) {
  if (!_perspectivePickerSession) return;
  const session = _perspectivePickerSession;
  _perspectivePickerSession = null;
  if (perspectivePickBanner) perspectivePickBanner.classList.add('hidden');
  if (notifyContentScript && _perspectiveTabId != null) {
    // v2.74.166 — Broadcast cancel so iframe pickers tear down too.
    await broadcastCancelPick(_perspectiveTabId, { sessionId: session.sessionId });
  }
}

// ─── Verify landmark ─────────────────────────────────────────────────────

// ─── v2.74.243 — Phase 5: landmark removal with impact analysis ─────────
//
// Removing a landmark from a perspective is a reference-integrity event:
//   - The perspective loses one entry from its `landmarkRefs[]` on next save
//   - The registry record stays (other perspectives / fragments may use it)
//   - But IF this perspective was the only consumer, the record becomes orphaned
//   - AND IF fragments/observations referenced the landmark, they break
//
// We don't auto-delete the registry record on perspective-level removal
// (per spec § Reference integrity: "leave orphans for user cleanup").
// We DO warn the author about downstream consumers so they know what
// they're breaking.

async function _removeLandmarkWithImpactCheck(idx) {
  if (!_perspectiveDraft?.landmarks?.[idx]) return;
  const lm = _perspectiveDraft.landmarks[idx];
  // Helper that does the actual removal — extracted so both branches
  // (no-impact and confirmed-impact) share the same cleanup path.
  const doRemove = () => {
    _perspectiveDraft.landmarks.splice(idx, 1);
    _invalidateStructure();   // v2.74.336 — landmark set changed; drop stale structure
    _landmarkRefining.delete(idx);
    const reKeyed = new Map();
    for (const [k, v] of _landmarkRefining) {
      if (k > idx) reKeyed.set(k - 1, v);
      else if (k < idx) reKeyed.set(k, v);
    }
    _landmarkRefining = reKeyed;
    const expandedReKeyed = new Set();
    for (const k of _landmarkProfileExpanded) {
      if (k > idx) expandedReKeyed.add(k - 1);
      else if (k < idx) expandedReKeyed.add(k);
    }
    _landmarkProfileExpanded = expandedReKeyed;
    renderPerspectiveLandmarks();
    _renderPerspectivePanel();   // v2.74.348 — a role may now be unfilled
    updatePerspectiveSaveButtonState();
    _refreshPerspectiveOverlays();
  };

  // No UID means the landmark hasn't been saved to the registry yet
  // (fresh in-memory only). Skip analysis; just remove.
  if (!lm.uid || !_perspectiveGroundId) {
    doRemove();
    return;
  }

  let impact;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'ANALYZE_LANDMARK_IMPACT',
      payload: { uid: lm.uid, groundId: _perspectiveGroundId },
    });
    impact = res?.impact ?? null;
  } catch (e) {
    // Analysis dispatch failed — proceed with removal but log it.
    Logger.warn('perspective-capture', `impact analysis failed (proceeding with remove): ${e.message}`);
    doRemove();
    return;
  }
  if (!impact) { doRemove(); return; }

  // Filter out THIS perspective from the impact.perspectives list — we know
  // we're removing from here. What matters is what OTHER consumers
  // remain.
  const otherPerspectives = (impact.perspectives ?? []).filter(l => l.id !== _perspectiveDraft?.id);
  const fragments = impact.fragments ?? [];
  const observations = impact.observations ?? [];
  const downstreamCount = fragments.length + observations.length;
  const otherPerspectiveCount = otherPerspectives.length;

  if (downstreamCount === 0 && otherPerspectiveCount === 0) {
    // No downstream consumers, no other perspectives. Safe to remove —
    // the registry record will be orphaned (left for user cleanup
    // per spec § Reference integrity § Perspective deletion).
    doRemove();
    return;
  }

  // v2.74.256 — Phase 10.5 surface: fetch replacement candidates so
  // the confirm dialog can surface "you could use X instead" before
  // the user commits to a breaking removal. Only fired when there's
  // downstream impact (no point suggesting replacements for landmarks
  // nothing depends on). Failure is silent — the dialog falls back to
  // the original "remove only" prompt.
  let candidates = [];
  if (downstreamCount > 0) {
    try {
      const candRes = await chrome.runtime.sendMessage({
        type: 'FIND_REPLACEMENT_CANDIDATES',
        payload: { uid: lm.uid, groundId: _perspectiveGroundId, limit: 3, minConfidence: 'low' },
      });
      if (candRes?.success && Array.isArray(candRes.candidates)) {
        candidates = candRes.candidates;
      }
    } catch (e) {
      Logger.debug('perspective-capture', `candidate fetch failed (proceeding without): ${e.message}`);
    }
  }

  // Build the confirmation message.
  const lines = [];
  lines.push(`Remove landmark "${lm.accessibleName ?? lm.alias ?? lm.uid}" from this perspective?`);
  lines.push('');
  if (downstreamCount > 0) {
    lines.push('⚠ This landmark is referenced by:');
    if (fragments.length > 0) {
      lines.push(`  • ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}: ${fragments.slice(0, 3).map(f => `"${f.name}"`).join(', ')}${fragments.length > 3 ? `, +${fragments.length - 3} more` : ''}`);
    }
    if (observations.length > 0) {
      lines.push(`  • ${observations.length} observation${observations.length === 1 ? '' : 's'}: ${observations.slice(0, 3).map(o => `"${o.name}"`).join(', ')}${observations.length > 3 ? `, +${observations.length - 3} more` : ''}`);
    }
    lines.push('');
    lines.push('Removing it from this perspective will leave those references broken at runtime.');
  }
  if (otherPerspectiveCount > 0) {
    lines.push(`This landmark is also referenced by ${otherPerspectiveCount} other perspective${otherPerspectiveCount === 1 ? '' : 's'} (${otherPerspectives.slice(0, 3).map(l => `"${l.name}"`).join(', ')}${otherPerspectiveCount > 3 ? `, …` : ''}). The registry record stays available there.`);
  } else if (downstreamCount > 0) {
    lines.push('This perspective is the last reference holder; the registry record will be orphaned.');
  }
  // v2.74.256 — Surface replacement candidates from Phase 10.5
  // ranking. Confidence emoji: 🟢 high, 🟡 medium, ⚪ low. Author
  // sees a concrete alternative path before committing to breakage.
  if (candidates.length > 0) {
    lines.push('');
    lines.push('💡 Replacement candidates on this Ground:');
    for (const c of candidates) {
      const emoji = c.confidence === 'high' ? '🟢'
                  : c.confidence === 'medium' ? '🟡' : '⚪';
      const name = c.landmark?.accessibleName ?? c.landmark?.alias ?? c.uid;
      const lc   = c.landmark?.lifecycle ?? 'fresh';
      lines.push(`  ${emoji} ${name} — ${c.confidence} (${(c.score * 100).toFixed(0)}% match, ${lc})`);
    }
    lines.push('');
    lines.push('To swap downstream references to one of these instead of breaking them, cancel and click the ↻ button on this landmark row.');
  }
  lines.push('');
  lines.push('Continue with removal?');

  if (confirm(lines.join('\n'))) {
    Logger.info('perspective-capture', `Landmark removed despite ${downstreamCount} downstream consumer(s)`, {
      uid: lm.uid, alias: lm.alias, accessibleName: lm.accessibleName,
      fragments: fragments.map(f => ({ id: f.id, name: f.name, refCount: f.refCount })),
      observations: observations.map(o => ({ id: o.id, name: o.name, refCount: o.refCount })),
      otherPerspectives: otherPerspectives.map(l => ({ id: l.id, name: l.name })),
    });
    doRemove();
  }
  // else: user cancelled, no change.
}

// ─── v2.74.235 — Profile drawer (Wave 2) ─────────────────────────────────
//
// Each landmark row has a collapsible drawer below it showing the
// Claude-generated profile: description, aliases, common operations,
// pitfalls, expected content kind, confidence. Fields are editable
// inline — the author's edits override Claude's suggestion on save.

// ─── v2.74.257 — Phase 10.5 surface: in-row replacement picker ──────────
//
// Author clicks ↻ on a landmark row → picker opens below the row
// showing top candidates from Phase 10.5 ranking. Click a candidate
// → dryRun preview (count of fragments/observations/perspectives touched)
// → confirm → commit via Phase 10 backend.
//
// Stays inline in the row (no modal). Multiple pickers can be open
// simultaneously; state is keyed by row index.

function _renderLandmarkReplacePicker(idx) {
  const state = _landmarkReplaceOpen.get(idx);
  if (!state) return '';
  if (state === 'loading') {
    return `
      <div class="dbg-perspective-landmark-replace-picker">
        <div class="dbg-perspective-landmark-replace-loading">⌛ Finding replacement candidates…</div>
      </div>`;
  }
  if (state === 'error') {
    const err = _landmarkReplaceError.get(idx) ?? 'unknown error';
    return `
      <div class="dbg-perspective-landmark-replace-picker">
        <div class="dbg-perspective-landmark-replace-error">⛔ ${escHtml(err)}</div>
        <div class="dbg-perspective-landmark-replace-actions">
          <button class="btn-secondary tiny" data-action="replace-cancel" data-idx="${idx}" type="button">Close</button>
        </div>
      </div>`;
  }
  // state === 'ready'
  const candidates = _landmarkReplaceCandidates.get(idx) ?? [];
  if (candidates.length === 0) {
    return `
      <div class="dbg-perspective-landmark-replace-picker">
        <div class="dbg-perspective-landmark-replace-empty">
          No replacement candidates found on this Ground. Replacements must share the same a11y role.
        </div>
        <div class="dbg-perspective-landmark-replace-actions">
          <button class="btn-secondary tiny" data-action="replace-cancel" data-idx="${idx}" type="button">Close</button>
        </div>
      </div>`;
  }
  const rows = candidates.map(c => {
    const name = c.landmark?.accessibleName ?? c.landmark?.alias ?? c.uid;
    const lc   = c.landmark?.lifecycle ?? 'fresh';
    const emoji = c.confidence === 'high' ? '🟢'
                : c.confidence === 'medium' ? '🟡' : '⚪';
    const pct = (c.score * 100).toFixed(0);
    const breakdown = c.breakdown
      ? `<span class="dbg-perspective-landmark-replace-breakdown" title="name:${(c.breakdown.name*100).toFixed(0)}% ctx:${(c.breakdown.context*100).toFixed(0)}% url:${(c.breakdown.url*100).toFixed(0)}% lifecycle:${(c.breakdown.lifecycle*100).toFixed(0)}%">${pct}%</span>`
      : '';
    return `
      <button class="dbg-perspective-landmark-replace-candidate" data-action="replace-commit" data-idx="${idx}" data-new-uid="${escAttr(c.uid)}" type="button">
        <span class="dbg-perspective-landmark-replace-conf">${emoji} ${c.confidence}</span>
        ${breakdown}
        <span class="dbg-perspective-landmark-replace-name">${escHtml(name)}</span>
        <span class="dbg-perspective-landmark-replace-lifecycle">${escHtml(lc)}</span>
      </button>`;
  }).join('');
  return `
    <div class="dbg-perspective-landmark-replace-picker">
      <div class="dbg-perspective-landmark-replace-header">Replace with…</div>
      <div class="dbg-perspective-landmark-replace-list">${rows}</div>
      <div class="dbg-perspective-landmark-replace-actions">
        <button class="btn-secondary tiny" data-action="replace-cancel" data-idx="${idx}" type="button">Cancel</button>
      </div>
    </div>`;
}

async function _toggleReplacePicker(idx) {
  const lm = _perspectiveDraft?.landmarks?.[idx];
  if (!lm || !lm.uid || !_perspectiveGroundId) return;
  // Already open: close it.
  if (_landmarkReplaceOpen.has(idx)) {
    _closeReplacePicker(idx);
    renderPerspectiveLandmarks();
    return;
  }
  // Open in loading state, fetch candidates, re-render.
  _landmarkReplaceOpen.set(idx, 'loading');
  renderPerspectiveLandmarks();
  try {
    const res = await chrome.runtime.sendMessage({
      type   : 'FIND_REPLACEMENT_CANDIDATES',
      payload: { uid: lm.uid, groundId: _perspectiveGroundId, limit: 5, minConfidence: 'low' },
    });
    if (res?.success) {
      _landmarkReplaceCandidates.set(idx, Array.isArray(res.candidates) ? res.candidates : []);
      _landmarkReplaceOpen.set(idx, 'ready');
    } else {
      _landmarkReplaceError.set(idx, res?.error ?? 'candidate fetch failed');
      _landmarkReplaceOpen.set(idx, 'error');
    }
  } catch (e) {
    _landmarkReplaceError.set(idx, e.message);
    _landmarkReplaceOpen.set(idx, 'error');
  }
  renderPerspectiveLandmarks();
}

function _closeReplacePicker(idx) {
  _landmarkReplaceOpen.delete(idx);
  _landmarkReplaceCandidates.delete(idx);
  _landmarkReplaceError.delete(idx);
}

async function _commitLandmarkReplace(idx, newUid) {
  const lm = _perspectiveDraft?.landmarks?.[idx];
  if (!lm || !lm.uid || !_perspectiveGroundId) return;
  const oldUid = lm.uid;
  if (oldUid === newUid) {
    showPerspectiveWarning('Cannot replace a landmark with itself');
    return;
  }
  // (1) Dry-run preview to count what would change.
  let preview;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'REPLACE_LANDMARK_REFERENCES',
      payload: { oldUid, newUid, groundId: _perspectiveGroundId, dryRun: true },
    });
    if (!res?.success) {
      showPerspectiveWarning(`Replace preview failed: ${res?.error ?? 'unknown error'}`);
      return;
    }
    preview = res;
  } catch (e) {
    showPerspectiveWarning(`Replace preview failed: ${e.message}`);
    return;
  }
  // (2) Build confirm message with the preview totals.
  const t = preview.totals ?? {};
  const newName = preview.changes?.perspectives?.[0]?.name
    ?? _landmarkReplaceCandidates.get(idx)?.find(c => c.uid === newUid)?.landmark?.accessibleName
    ?? newUid;
  const lines = [];
  lines.push(`Replace "${lm.accessibleName ?? lm.alias ?? oldUid}" with "${newName}"?`);
  lines.push('');
  lines.push('This rewrite will touch:');
  lines.push(`  • ${t.perspectivesRewritten ?? 0} perspective ref list${(t.perspectivesRewritten ?? 0) === 1 ? '' : 's'}`);
  lines.push(`  • ${t.fragmentsRewritten ?? 0} fragment${(t.fragmentsRewritten ?? 0) === 1 ? '' : 's'}`);
  lines.push(`  • ${t.observationsRewritten ?? 0} observation${(t.observationsRewritten ?? 0) === 1 ? '' : 's'}`);
  lines.push(`  • ${t.totalRefsRewritten ?? 0} ref${(t.totalRefsRewritten ?? 0) === 1 ? '' : 's'} total`);
  if ((t.skippedLegacyRefs ?? 0) > 0) {
    lines.push('');
    lines.push(`⚠ ${t.skippedLegacyRefs} legacy { perspectiveId, role } ref(s) preserved (unsafe to auto-rewrite)`);
  }
  if (preview.rolePresentMismatch) {
    lines.push('');
    lines.push(`⚠ Role mismatch: "${preview.roleOld ?? '?'}" → "${preview.roleNew ?? '?'}". The replacement landmark has a different role descriptor.`);
  }
  lines.push('');
  lines.push('Continue with replacement?');
  if (!confirm(lines.join('\n'))) return;

  // (3) Commit (dryRun: false).
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: 'REPLACE_LANDMARK_REFERENCES',
      payload: { oldUid, newUid, groundId: _perspectiveGroundId, dryRun: false },
    });
  } catch (e) {
    showPerspectiveWarning(`Replace failed: ${e.message}`);
    return;
  }
  if (!result?.success) {
    showPerspectiveWarning(`Replace failed: ${result?.error ?? 'unknown error'}`);
    return;
  }
  // (4) Update the in-memory perspective draft so the row reflects the new
  // landmark. Persisted state was rewritten by the backend; the draft
  // tracks the visible identity here.
  let newLandmark = null;
  try {
    const getRes = await chrome.runtime.sendMessage({ type: 'GET_LANDMARK', payload: { uid: newUid } });
    if (getRes?.success) newLandmark = getRes.landmark;
  } catch { /* fall back to candidate data */ }
  if (!newLandmark) {
    const candEntry = _landmarkReplaceCandidates.get(idx)?.find(c => c.uid === newUid);
    newLandmark = candEntry?.landmark ?? null;
  }
  if (newLandmark) {
    const existing = _perspectiveDraft.landmarks[idx];
    _perspectiveDraft.landmarks[idx] = {
      ...existing,
      uid               : newLandmark.uid,
      alias             : newLandmark.alias ?? existing.alias,
      a11yRole          : newLandmark.a11yRole ?? null,
      accessibleName    : newLandmark.accessibleName ?? null,
      hierarchicalContext: newLandmark.hierarchicalContext ?? null,
      selector          : newLandmark.selector ?? existing.selector,
      frameUrl          : newLandmark.frameUrl ?? existing.frameUrl,
      lifecycle         : newLandmark.lifecycle ?? 'verified',
      // Author-customized fields on the OLD landmark (description,
      // aliases, expectedShape) don't carry over — they were
      // semantics for the prior identity. Discard.
      description       : newLandmark.description ?? '',
      aliases           : Array.isArray(newLandmark.aliases) ? newLandmark.aliases : [],
    };
  }
  _closeReplacePicker(idx);
  renderPerspectiveLandmarks();
  updatePerspectiveSaveButtonState();
  _refreshPerspectiveOverlays();
  Logger.info('perspective-capture',
    `Replaced ${oldUid} → ${newUid} on ground ${_perspectiveGroundId}: ` +
    `${result.totals?.totalRefsRewritten ?? 0} ref(s) across ` +
    `${result.totals?.perspectivesRewritten ?? 0} perspective(s), ` +
    `${result.totals?.fragmentsRewritten ?? 0} fragment(s), ` +
    `${result.totals?.observationsRewritten ?? 0} observation(s)`);
}

// ─── v2.74.258 — Phase 9 surface: per-row verify ────────────────────────
//
// Author clicks ✓ on a landmark row → VERIFY_LANDMARK round-trips to
// the content script. Three outcomes:
//   via:'selector'  — cached works, lifecycle promotes to verified.
//   via:'heuristic' — recovery found the same identity at a new
//                     selector. Landmark record auto-updates (Phase
//                     9 policy). Outcome banner shows the swap.
//   via:'fail'      — both paths failed. Lifecycle = stale-confirmed.
//
// Row's lifecycle chip updates from the refreshed landmark record on
// next render. The outcome banner below the row carries the narrative
// (what changed, why) until the next interaction clears it.

function _renderLandmarkVerifyOutcome(idx) {
  const outcome = _landmarkVerifyOutcome.get(idx);
  if (!outcome) return '';
  const { via, error, lifecycleBefore, lifecycleAfter, selectorChanged, skipped, reason, _localOnly } = outcome;
  if (skipped) {
    return `
      <div class="dbg-perspective-landmark-verify-outcome dbg-perspective-landmark-verify-skipped">
        Verify skipped: ${escHtml(reason ?? 'unknown')}
      </div>`;
  }
  if (via === 'selector') {
    // v2.74.278 — Local-only verify (landmark not yet in registry).
    // Skip the lifecycle transition narrative — there's no canonical
    // lifecycle to report on.
    if (_localOnly) {
      return `
        <div class="dbg-perspective-landmark-verify-outcome dbg-perspective-landmark-verify-ok">
          ✓ Selector matched on the live page (save perspective to persist + enable lifecycle tracking)
        </div>`;
    }
    return `
      <div class="dbg-perspective-landmark-verify-outcome dbg-perspective-landmark-verify-ok">
        ✓ Verified via cached selector — lifecycle ${escHtml(lifecycleBefore ?? '?')} → ${escHtml(lifecycleAfter ?? 'verified')}
      </div>`;
  }
  if (via === 'heuristic') {
    return `
      <div class="dbg-perspective-landmark-verify-outcome dbg-perspective-landmark-verify-recovered">
        ↻ Heuristic recovery — selector ${selectorChanged ? 'updated to new element' : 'unchanged'}; lifecycle ${escHtml(lifecycleBefore ?? '?')} → ${escHtml(lifecycleAfter ?? 'verified')}
      </div>`;
  }
  if (via === 'fail') {
    // v2.74.278 — Local-only verify failure doesn't touch lifecycle
    // (no registry record yet).
    if (_localOnly) {
      return `
        <div class="dbg-perspective-landmark-verify-outcome dbg-perspective-landmark-verify-failed">
          ⛔ Selector didn't match on the live page: ${escHtml(error ?? 'unknown')}
        </div>`;
    }
    return `
      <div class="dbg-perspective-landmark-verify-outcome dbg-perspective-landmark-verify-failed">
        ⛔ Verify failed: ${escHtml(error ?? 'unknown')} — lifecycle ${escHtml(lifecycleBefore ?? '?')} → stale-confirmed
      </div>`;
  }
  if (error) {
    return `
      <div class="dbg-perspective-landmark-verify-outcome dbg-perspective-landmark-verify-failed">
        ⛔ ${escHtml(error)}
      </div>`;
  }
  return '';
}

async function _verifyLandmarkInRow(idx) {
  const lm = _perspectiveDraft?.landmarks?.[idx];
  if (!lm || !lm.uid) return;
  if (_perspectiveTabId == null) {
    _landmarkVerifyOutcome.set(idx, { error: 'No active tab — switch to your target tab and try again.' });
    renderPerspectiveLandmarks();
    return;
  }
  if (_landmarkVerifyInFlight.has(idx)) return;
  _landmarkVerifyInFlight.add(idx);
  _landmarkVerifyOutcome.delete(idx);
  renderPerspectiveLandmarks();

  // v2.74.278 — Branch: Phase 9 verifier only works on registry-
  // persisted landmarks. Fresh draft landmarks (just picked, not yet
  // Save Perspective'd) have a UID but no registry record. For those, fall
  // back to the local verifyPerspectiveLandmark path (which probes the
  // selector via INSPECT_ELEMENT against the live page — same logic
  // Pick→Claude auto-runs).
  //
  // Detection: GET_LANDMARK returns null when not in registry.
  let inRegistry = false;
  try {
    const getRes = await chrome.runtime.sendMessage({
      type: 'GET_LANDMARK', payload: { uid: lm.uid },
    });
    inRegistry = !!(getRes?.success && getRes.landmark);
  } catch { /* treat as not-in-registry */ }

  if (!inRegistry) {
    // Local-only verify path. Reuses verifyPerspectiveLandmark (the same
    // verifier that auto-runs after Pick→Claude). Pose its outcome
    // in the same shape so the row banner renders consistently.
    _landmarkVerifyInFlight.delete(idx);
    try {
      await verifyPerspectiveLandmark(idx);
      // After local verify, _perspectiveDraft.landmarks[idx].verified is set.
      const v = _perspectiveDraft.landmarks[idx]?.verified;
      if (v?.score === 'ready' || v?.score === 'caveats') {
        _landmarkVerifyOutcome.set(idx, {
          via             : 'selector',
          lifecycleBefore : 'fresh',
          lifecycleAfter  : 'fresh',
          selectorChanged : false,
          skipped         : false,
          _localOnly      : true,
        });
      } else {
        _landmarkVerifyOutcome.set(idx, {
          via             : 'fail',
          error           : v?.issues?.[0] ?? 'selector did not match on this page',
          lifecycleBefore : 'fresh',
          lifecycleAfter  : 'fresh',
          _localOnly      : true,
        });
      }
    } catch (e) {
      _landmarkVerifyOutcome.set(idx, { error: `Local verify failed: ${e.message}` });
    }
    renderPerspectiveLandmarks();
    return;
  }

  // Registry-backed: use Phase 9 verifier (heuristic recovery,
  // lifecycle promotion, event emission).
  let outcome;
  try {
    outcome = await chrome.runtime.sendMessage({
      type: 'VERIFY_LANDMARK',
      payload: { uid: lm.uid, tabId: _perspectiveTabId },
    });
  } catch (e) {
    outcome = { success: false, error: e.message };
  }
  _landmarkVerifyInFlight.delete(idx);
  if (!outcome || outcome.success === false) {
    _landmarkVerifyOutcome.set(idx, { error: outcome?.error ?? 'verify failed' });
    renderPerspectiveLandmarks();
    return;
  }
  _landmarkVerifyOutcome.set(idx, outcome);
  // After server-side mutation, pull the fresh landmark record so the
  // in-memory perspective draft reflects the new lifecycle + (possibly)
  // updated selector.
  try {
    const getRes = await chrome.runtime.sendMessage({
      type: 'GET_LANDMARK', payload: { uid: lm.uid },
    });
    if (getRes?.success && getRes.landmark) {
      const fresh = getRes.landmark;
      _perspectiveDraft.landmarks[idx] = {
        ...lm,
        selector  : fresh.selector ?? lm.selector,
        lifecycle : fresh.lifecycle ?? lm.lifecycle,
        a11yRole  : fresh.a11yRole ?? lm.a11yRole,
      };
    }
  } catch (e) {
    Logger.debug('perspective-capture', `GET_LANDMARK refresh after verify failed: ${e.message}`);
  }
  renderPerspectiveLandmarks();
  _refreshPerspectiveOverlays();
  Logger.info('perspective-capture',
    `Verify ${lm.uid}: via=${outcome.via ?? '?'} ${outcome.lifecycleBefore ?? '?'} → ${outcome.lifecycleAfter ?? '?'}` +
    (outcome.selectorChanged ? ' (selector swapped)' : ''));
}

// ─── v2.74.259 — Phase 8 surface: substrate events panel ────────────────
//
// Collapsible panel below the landmark list showing recent
// GroundEventBus events for the current Ground. Fetch is on-demand
// (when the panel opens) rather than eager, since most authoring
// sessions don't need to inspect the event log. Refetch on each
// open ensures fresh data without setting up a storage.onChanged
// subscription.
//
// Event rendering is uniform: timestamp (relative) + kind icon +
// brief detail line + affected landmark name (when uid present).
// Per-uid name lookup pulls from the current perspective draft first
// (zero round-trip), then falls back to a batched GET_LANDMARKS
// for unknowns.

const _EVENT_KIND_META = Object.freeze({
  'landmark-resolution-ok'        : { icon: '✓', label: 'Verified',  cssCls: 'evt-ok' },
  'landmark-resolution-degraded'  : { icon: '↻', label: 'Recovered', cssCls: 'evt-recovered' },
  'landmark-resolution-failed'    : { icon: '⛔', label: 'Failed',    cssCls: 'evt-failed' },
  'landmark-lifecycle-changed'    : { icon: '⇄', label: 'Lifecycle', cssCls: 'evt-lifecycle' },
  'landmark-effect-observed'      : { icon: '👁', label: 'Observed',  cssCls: 'evt-observed' },
  'landmark-effect-drift'         : { icon: '⚠', label: 'Drift',     cssCls: 'evt-drift' },
});

function _formatRelativeTime(ts) {
  if (typeof ts !== 'number') return '?';
  const delta = Date.now() - ts;
  if (delta < 0) return 'now';
  if (delta < 60_000)        return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000)     return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000)    return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

// v2.74.310 — Phase 8: format a spec-aligned Effect object (or legacy
// string) for display. Effects are now {kind, form?, modalKind?} per
// ACTION_SPEC § 5; older events carried a bare string. Handles both.
function _formatEffectForDisplay(eff) {
  if (eff == null) return '?';
  if (typeof eff === 'string') return eff;   // legacy string effect
  if (typeof eff === 'object' && eff.kind) {
    if (eff.kind === 'opens-new-thread' && eff.form) return `opens-new-thread (${eff.form})`;
    if (eff.kind === 'triggers-modal' && eff.modalKind) return `triggers-modal (${eff.modalKind})`;
    return eff.kind;
  }
  return '?';
}

function _renderEventDetailLine(event) {
  const d = event.details ?? {};
  switch (event.kind) {
    case 'landmark-resolution-ok':
      return d.via === 'heuristic' && d.selectorChanged
        ? `selector swapped (heuristic); ${escHtml(d.lifecycleBefore ?? '?')} → ${escHtml(d.lifecycleAfter ?? '?')}`
        : `cached selector OK; ${escHtml(d.lifecycleBefore ?? '?')} → ${escHtml(d.lifecycleAfter ?? '?')}`;
    case 'landmark-resolution-degraded': {
      // v2.74.270 — Match-method awareness. Fuzzy/substring match
      // indicates name drift, which is the most informative signal
      // for an author. Surface it concretely.
      const m = d.matchMethod;
      if (m === 'fuzzy' && d.authoredName && d.matchedName) {
        return `name drift: "${escHtml(d.authoredName)}" → "${escHtml(d.matchedName)}" (${((d.nameSimilarity ?? 0) * 100).toFixed(0)}% match)`;
      }
      if (m === 'substring' && d.authoredName && d.matchedName) {
        return `name partial: "${escHtml(d.authoredName)}" → "${escHtml(d.matchedName)}"`;
      }
      const methodNote = m && m !== 'exact' ? ` (${escHtml(m)})` : '';
      return `cached failed; recovered via heuristic${methodNote}${d.trigger ? ` — ${escHtml(d.trigger)}` : ''}`;
    }
    case 'landmark-resolution-failed': {
      // v2.74.273 — Specialize iframe-related failure reasons so the
      // author sees a concrete explanation, not just "failed."
      if (d.reason === 'cross-origin-iframe') {
        return `cross-origin iframe "${escHtml(d.iframeContext ?? '?')}" — browser security blocks content-script access`;
      }
      if (d.reason === 'iframe-absent') {
        return `iframe context "${escHtml(d.iframeContext ?? '?')}" not present on this page`;
      }
      return `${escHtml(d.reason ?? 'cached + heuristic both failed')}`;
    }
    case 'landmark-effect-observed': {
      // v2.74.310 — declaredEffect/observedEffect are now Effect objects
      // (ACTION_SPEC § 5). Fall back to legacy proposedEffect string.
      const declared = d.declaredEffect ?? d.proposedEffect;
      const observed = d.observedEffect;
      const patternNote = d.observedInteractionPattern && d.observedInteractionPattern !== 'none'
        ? ` [pattern: ${escHtml(d.observedInteractionPattern)}]` : '';
      return `${escHtml(d.action ?? 'action')}: declared=${escHtml(_formatEffectForDisplay(declared))} observed=${escHtml(_formatEffectForDisplay(observed))}${patternNote}`;
    }
    case 'landmark-effect-drift': {
      const declared = d.declaredEffect ?? d.proposedEffect;
      const sevNote = d.severity ? ` (${escHtml(d.severity)})` : '';
      return `declared "${escHtml(_formatEffectForDisplay(declared))}" but observed "${escHtml(_formatEffectForDisplay(d.observedEffect))}"${sevNote}`;
    }
    case 'landmark-lifecycle-changed':
      return `${escHtml(d.lifecycleBefore ?? '?')} → ${escHtml(d.lifecycleAfter ?? '?')}`;
    default:
      return '';
  }
}

async function _toggleEventsPanel() {
  if (!perspectiveEventsToggleBtn || !perspectiveEventsBody) return;
  _eventsExpanded = !_eventsExpanded;
  perspectiveEventsToggleBtn.setAttribute('aria-expanded', _eventsExpanded ? 'true' : 'false');
  const chevron = perspectiveEventsToggleBtn.querySelector('.dbg-perspective-events-chevron');
  if (chevron) chevron.textContent = _eventsExpanded ? '▾' : '▸';
  if (_eventsExpanded) {
    perspectiveEventsBody.classList.remove('hidden');
    await _refreshEventsPanel();
    // v2.74.263 — Subscribe to live events while panel is open. The
    // subscribe() implementation uses chrome.storage.onChanged + an
    // id-diffing pass so the callback only fires for genuinely new
    // events (not for ring-buffer evictions of old ones).
    _attachEventsLiveSubscription();
  } else {
    perspectiveEventsBody.classList.add('hidden');
    _detachEventsLiveSubscription();
  }
}

function _attachEventsLiveSubscription() {
  if (_eventsUnsubscribe || !_perspectiveGroundId) return;
  try {
    _eventsUnsubscribe = subscribeGroundEvents(_perspectiveGroundId, _onLiveEventsAdded);
  } catch (e) {
    Logger.debug('perspective-capture', `subscribe failed: ${e.message}`);
    _eventsUnsubscribe = null;
  }
}

function _detachEventsLiveSubscription() {
  if (_eventsUnsubscribe) {
    try { _eventsUnsubscribe(); } catch { /* ignore */ }
    _eventsUnsubscribe = null;
  }
}

async function _onLiveEventsAdded(newEvents) {
  // Guard: panel may have closed between commit and callback dispatch.
  if (!_eventsExpanded || !perspectiveEventsList) return;
  if (!Array.isArray(newEvents) || newEvents.length === 0) return;
  // Merge new events into the cache (newest-first ordering preserved).
  const existingIds = new Set((_eventsCache ?? []).map(e => e?.id));
  const additions = newEvents.filter(e => e?.id && !existingIds.has(e.id));
  if (additions.length === 0) return;
  _eventsCache = [...additions, ...(_eventsCache ?? [])].slice(0, 30);
  // Update count badge.
  if (perspectiveEventsCount) {
    perspectiveEventsCount.textContent = _eventsCache.length === 0 ? '' : `(${_eventsCache.length})`;
  }
  // Fetch landmark names for any new uids not already cached.
  await _populateEventLandmarkNames(additions);
  _renderEventsList();
  // Refresh stale badge — new events may have changed lifecycle
  // state of landmarks on this ground (e.g., a verifier OK event
  // means one fewer stale-suspected). Also refresh the health
  // summary so the "Last 24h" counts pick up the new event.
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'LIST_LANDMARKS_FOR_GROUND', payload: { groundId: _perspectiveGroundId },
    });
    if (res?.success) {
      _eventsLandmarksCache = res.landmarks ?? [];
      _refreshStaleBadge(_eventsLandmarksCache);
      _renderHealthSummary(_eventsLandmarksCache, _eventsCache);
    }
  } catch { /* non-fatal */ }
}

async function _refreshEventsPanel() {
  if (!perspectiveEventsList || !_perspectiveGroundId) return;
  if (_eventsLoading) return;
  _eventsLoading = true;
  perspectiveEventsList.innerHTML = `<div class="dbg-perspective-events-loading">⌛ Loading events…</div>`;
  try {
    const [eventsRes, landmarksRes] = await Promise.all([
      chrome.runtime.sendMessage({
        type   : 'LIST_GROUND_EVENTS',
        payload: { groundId: _perspectiveGroundId, opts: { limit: 30 } },
      }),
      // v2.74.262 — Also fetch all landmarks on the ground so we can
      // compute the stale-suspected count for the header badge. Single
      // round-trip per panel-open; fine for typical ground sizes.
      chrome.runtime.sendMessage({
        type   : 'LIST_LANDMARKS_FOR_GROUND',
        payload: { groundId: _perspectiveGroundId },
      }).catch(() => null),
    ]);
    if (!eventsRes?.success) {
      perspectiveEventsList.innerHTML = `<div class="dbg-perspective-events-error">⛔ ${escHtml(eventsRes?.error ?? 'fetch failed')}</div>`;
      return;
    }
    _eventsCache = Array.isArray(eventsRes.events) ? eventsRes.events : [];
    if (perspectiveEventsCount) {
      perspectiveEventsCount.textContent = _eventsCache.length === 0 ? ''
        : `(${_eventsCache.length})`;
    }
    // v2.74.262 — Stale-suspected count + enabled state for Verify all.
    const landmarks = landmarksRes?.landmarks ?? [];
    _eventsLandmarksCache = landmarks;
    _refreshStaleBadge(landmarks);
    // v2.74.272 — Health summary banner.
    _renderHealthSummary(landmarks, _eventsCache);
    await _populateEventLandmarkNames(_eventsCache);
    _renderEventsList();
  } catch (e) {
    perspectiveEventsList.innerHTML = `<div class="dbg-perspective-events-error">⛔ ${escHtml(e.message)}</div>`;
  } finally {
    _eventsLoading = false;
  }
}

// v2.74.272 — Substrate health summary banner. Renders aggregate
// counts at the top of the events panel body. Computed from already-
// fetched data (landmarks + events) — no additional round-trips.
//
// Layout:
//   Landmarks: N total · N verified · N stale · N deprecated
//   Last 24h:  N recoveries (M fuzzy) · K drift · J failures
//
// Empty states collapse cleanly (e.g., "No substrate activity in the
// last 24h." when events older than that or absent).
function _renderHealthSummary(landmarks, events) {
  if (!perspectiveEventsHealth) return;
  const lms = Array.isArray(landmarks) ? landmarks : [];
  const evs = Array.isArray(events) ? events : [];
  // Landmark lifecycle aggregation.
  const lcCounts = { 'verified': 0, 'fresh': 0, 'stale-suspected': 0, 'stale-confirmed': 0, 'deprecated': 0 };
  for (const lm of lms) {
    const lc = lm?.lifecycle ?? 'fresh';
    if (lcCounts[lc] !== undefined) lcCounts[lc]++;
  }
  const total = lms.length;
  // Recent-24h event aggregation.
  const cutoff = Date.now() - 24 * 3_600_000;
  const recent = evs.filter(e => e?.ts && e.ts >= cutoff);
  let recoveries = 0, fuzzyRecoveries = 0, drifts = 0, failures = 0, observed = 0;
  for (const ev of recent) {
    if (ev.kind === 'landmark-resolution-degraded') {
      recoveries++;
      if (ev.details?.matchMethod === 'fuzzy' || ev.details?.matchMethod === 'substring') fuzzyRecoveries++;
    } else if (ev.kind === 'landmark-effect-drift') {
      drifts++;
    } else if (ev.kind === 'landmark-resolution-failed') {
      failures++;
    } else if (ev.kind === 'landmark-effect-observed') {
      observed++;
    }
  }
  // Render. Skip the whole banner if there's nothing meaningful.
  if (total === 0 && recent.length === 0) {
    perspectiveEventsHealth.innerHTML = '';
    return;
  }
  const lmParts = [];
  if (total > 0) lmParts.push(`<span class="dbg-perspective-events-health-total">${total} total</span>`);
  if (lcCounts.verified > 0)         lmParts.push(`<span class="dbg-perspective-events-health-tag tag-verified">✓ ${lcCounts.verified} verified</span>`);
  if (lcCounts['stale-suspected'] > 0) lmParts.push(`<span class="dbg-perspective-events-health-tag tag-suspected">⚠ ${lcCounts['stale-suspected']} stale</span>`);
  if (lcCounts['stale-confirmed'] > 0) lmParts.push(`<span class="dbg-perspective-events-health-tag tag-confirmed">⛔ ${lcCounts['stale-confirmed']} broken</span>`);
  if (lcCounts.deprecated > 0)       lmParts.push(`<span class="dbg-perspective-events-health-tag tag-deprecated">deprecated ${lcCounts.deprecated}</span>`);
  if (lcCounts.fresh > 0 && lcCounts.fresh < total) lmParts.push(`<span class="dbg-perspective-events-health-tag tag-fresh">${lcCounts.fresh} fresh</span>`);
  const lmLine = lmParts.length > 0
    ? `<div class="dbg-perspective-events-health-line"><span class="dbg-perspective-events-health-label">Landmarks:</span> ${lmParts.join(' · ')}</div>`
    : '';

  const recentParts = [];
  if (recoveries > 0) {
    const fuzzyNote = fuzzyRecoveries > 0 ? ` <span class="dbg-perspective-events-health-subtle">(${fuzzyRecoveries} fuzzy)</span>` : '';
    recentParts.push(`<span class="dbg-perspective-events-health-tag tag-recovered">↻ ${recoveries} recoveries${fuzzyNote}</span>`);
  }
  if (drifts > 0)    recentParts.push(`<span class="dbg-perspective-events-health-tag tag-drift">⚠ ${drifts} drift</span>`);
  if (failures > 0)  recentParts.push(`<span class="dbg-perspective-events-health-tag tag-failed">⛔ ${failures} failures</span>`);
  if (observed > 0)  recentParts.push(`<span class="dbg-perspective-events-health-tag tag-observed">👁 ${observed} observed</span>`);
  const recentLine = recentParts.length > 0
    ? `<div class="dbg-perspective-events-health-line"><span class="dbg-perspective-events-health-label">Last 24h:</span> ${recentParts.join(' · ')}</div>`
    : (total > 0
        ? `<div class="dbg-perspective-events-health-line dbg-perspective-events-health-quiet"><span class="dbg-perspective-events-health-label">Last 24h:</span> No substrate activity.</div>`
        : '');
  perspectiveEventsHealth.innerHTML = lmLine + recentLine;
}

function _refreshStaleBadge(landmarks) {
  if (!perspectiveEventsStaleBadge || !perspectiveEventsVerifyAllBtn) return;
  const list = Array.isArray(landmarks) ? landmarks : [];
  const staleCount = list.filter(lm => lm?.lifecycle === 'stale-suspected').length;
  if (staleCount === 0) {
    perspectiveEventsStaleBadge.classList.add('hidden');
    perspectiveEventsStaleBadge.textContent = '';
    perspectiveEventsVerifyAllBtn.disabled = true;
    perspectiveEventsVerifyAllBtn.title = 'No stale-suspected landmarks on this Ground';
  } else {
    perspectiveEventsStaleBadge.classList.remove('hidden');
    perspectiveEventsStaleBadge.textContent = `${staleCount} stale`;
    perspectiveEventsVerifyAllBtn.disabled = _eventsBulkVerifyInFlight;
    perspectiveEventsVerifyAllBtn.title = `Re-probe ${staleCount} stale-suspected landmark${staleCount === 1 ? '' : 's'} against the current tab`;
  }
}

async function _verifyAllStaleOnGround() {
  if (!_perspectiveGroundId) return;
  if (_perspectiveTabId == null) {
    _showBulkOutcome('error', 'No active tab — switch to your target tab and try again.');
    return;
  }
  if (_eventsBulkVerifyInFlight) return;
  _eventsBulkVerifyInFlight = true;
  if (perspectiveEventsVerifyAllBtn) {
    perspectiveEventsVerifyAllBtn.disabled = true;
    perspectiveEventsVerifyAllBtn.textContent = '⌛ Verifying…';
  }
  _showBulkOutcome('loading', 'Probing stale-suspected landmarks…');
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type   : 'VERIFY_STALE_SUSPECTED_ON_GROUND',
      payload: { groundId: _perspectiveGroundId, tabId: _perspectiveTabId },
    });
  } catch (e) {
    result = { success: false, error: e.message };
  }
  _eventsBulkVerifyInFlight = false;
  if (perspectiveEventsVerifyAllBtn) {
    perspectiveEventsVerifyAllBtn.textContent = 'Verify all stale';
  }
  if (!result?.success) {
    _showBulkOutcome('error', `Bulk verify failed: ${result?.error ?? 'unknown'}`);
    return;
  }
  const { scanned, promoted, degraded, failed, skipped } = result;
  if (scanned === 0) {
    _showBulkOutcome('info', 'No stale-suspected landmarks to verify.');
  } else {
    const parts = [];
    if (promoted > 0) parts.push(`${promoted} promoted`);
    if (degraded > 0) parts.push(`${degraded} selector swapped`);
    if (failed > 0)   parts.push(`${failed} confirmed broken`);
    if (skipped > 0)  parts.push(`${skipped} skipped`);
    _showBulkOutcome(
      failed > 0 ? 'mixed' : 'success',
      `Verified ${scanned} stale-suspected landmark${scanned === 1 ? '' : 's'}: ${parts.join(', ')}`,
    );
  }
  // Refresh events panel to show the newly-emitted verifier events,
  // and re-fetch landmarks so the stale-count badge reflects the new
  // lifecycle state.
  await _refreshEventsPanel();
  // Refresh landmark row lifecycle chips in the perspective view if any
  // of the verified landmarks belong to the current perspective.
  if (Array.isArray(_perspectiveDraft?.landmarks)) {
    const draftUids = _perspectiveDraft.landmarks.map(lm => lm?.uid).filter(Boolean);
    const touchedUids = new Set((result.outcomes ?? []).map(o => o.uid));
    const overlap = draftUids.filter(u => touchedUids.has(u));
    if (overlap.length > 0) {
      try {
        const getRes = await chrome.runtime.sendMessage({
          type: 'GET_LANDMARKS', payload: { uids: overlap },
        });
        if (getRes?.success && getRes.landmarks) {
          for (let i = 0; i < _perspectiveDraft.landmarks.length; i++) {
            const lm = _perspectiveDraft.landmarks[i];
            const fresh = lm?.uid ? getRes.landmarks[lm.uid] : null;
            if (fresh) {
              _perspectiveDraft.landmarks[i] = {
                ...lm,
                selector : fresh.selector ?? lm.selector,
                lifecycle: fresh.lifecycle ?? lm.lifecycle,
              };
            }
          }
          renderPerspectiveLandmarks();
        }
      } catch (e) {
        Logger.debug('perspective-capture', `bulk-verify landmark refresh failed: ${e.message}`);
      }
    }
  }
}

function _showBulkOutcome(level, message) {
  if (!perspectiveEventsBulkOutcome) return;
  perspectiveEventsBulkOutcome.classList.remove('hidden');
  perspectiveEventsBulkOutcome.className = `dbg-perspective-events-bulk-outcome dbg-perspective-events-bulk-${level}`;
  perspectiveEventsBulkOutcome.textContent = message;
}

async function _populateEventLandmarkNames(events) {
  // First pass: seed names from the current perspective draft (free).
  if (Array.isArray(_perspectiveDraft?.landmarks)) {
    for (const lm of _perspectiveDraft.landmarks) {
      if (lm?.uid && lm.accessibleName) _eventsLandmarkNames.set(lm.uid, lm.accessibleName);
    }
  }
  // Second pass: any event uid not in the cache → batch fetch.
  const missing = [];
  const seen = new Set();
  for (const ev of events) {
    if (!ev?.uid) continue;
    if (seen.has(ev.uid)) continue;
    seen.add(ev.uid);
    if (!_eventsLandmarkNames.has(ev.uid)) missing.push(ev.uid);
  }
  if (missing.length === 0) return;
  try {
    // v2.74.261 — Single bulk GET_LANDMARKS call instead of N sequential
    // GET_LANDMARK round-trips. For an event list with 30 distinct uids,
    // this is 1 round-trip instead of 30 — meaningfully faster for
    // event-heavy grounds. Returns a { uid → landmark|null } map.
    const res = await chrome.runtime.sendMessage({ type: 'GET_LANDMARKS', payload: { uids: missing } });
    if (res?.success && res.landmarks) {
      for (const uid of missing) {
        const lm = res.landmarks[uid];
        if (lm?.accessibleName) _eventsLandmarkNames.set(uid, lm.accessibleName);
      }
    }
  } catch (e) {
    Logger.debug('perspective-capture', `event landmark name fetch failed: ${e.message}`);
  }
}

function _renderEventsList() {
  if (!perspectiveEventsList) return;
  const events = _eventsCache ?? [];
  if (events.length === 0) {
    perspectiveEventsList.innerHTML = `<div class="dbg-perspective-events-empty">No substrate events yet. Run a fragment or trigger verifier/replace to see activity here.</div>`;
    return;
  }
  // Events come newest-first from LIST_GROUND_EVENTS (desc by default).
  const rows = events.map(ev => {
    const meta = _EVENT_KIND_META[ev.kind] ?? { icon: '·', label: ev.kind ?? '?', cssCls: 'evt-unknown' };
    const name = ev.uid ? (_eventsLandmarkNames.get(ev.uid) ?? ev.uid) : '—';
    const detail = _renderEventDetailLine(ev);
    // v2.74.266 — Drift-confirmation action. For landmark-effect-drift
    // events, show an Apply button that writes the observed effect
    // back to the landmark's proposedEffect. Visual states: pristine →
    // Apply button; in-flight → ⌛ disabled; applied this session →
    // ✓ Applied marker.
    let actionHtml = '';
    if (ev.kind === 'landmark-effect-drift' && ev.uid && ev.details?.observedEffect) {
      if (_eventsAppliedDrift.has(ev.id)) {
        actionHtml = `<span class="dbg-perspective-events-action-applied" title="Landmark's effect updated to the observed value">✓ Applied</span>`;
      } else if (_eventsApplyInFlight.has(ev.id)) {
        actionHtml = `<button class="dbg-perspective-events-apply-btn" disabled type="button">⌛</button>`;
      } else {
        // v2.74.310 — observedEffect is now an Effect object (§ 5).
        // Serialize as JSON in the data attr; _applyDriftEffect parses it.
        const obsLabel = _formatEffectForDisplay(ev.details.observedEffect);
        const obsJson  = JSON.stringify(ev.details.observedEffect);
        actionHtml = `<button class="dbg-perspective-events-apply-btn" data-action="apply-drift" data-event-id="${escAttr(ev.id)}" data-uid="${escAttr(ev.uid)}" data-effect="${escAttr(obsJson)}" type="button" title="Accept the observed effect (${escAttr(obsLabel)}) as this landmark's effect">Apply</button>`;
      }
    }
    return `
      <div class="dbg-perspective-events-row ${meta.cssCls}">
        <span class="dbg-perspective-events-icon" title="${escAttr(ev.kind)}">${meta.icon}</span>
        <span class="dbg-perspective-events-kind">${escHtml(meta.label)}</span>
        <span class="dbg-perspective-events-landmark" title="${escAttr(ev.uid ?? '')}">${escHtml(name)}</span>
        <span class="dbg-perspective-events-detail">${detail}</span>
        <span class="dbg-perspective-events-time" title="${escAttr(new Date(ev.ts).toISOString())}">${escHtml(_formatRelativeTime(ev.ts))}</span>
        <span class="dbg-perspective-events-action">${actionHtml}</span>
      </div>`;
  }).join('');
  perspectiveEventsList.innerHTML = rows;
  // v2.74.266 — Wire apply-drift handlers (delegated).
  perspectiveEventsList.querySelectorAll('[data-action="apply-drift"]').forEach(btn => {
    btn.addEventListener('click', () => _applyDriftEffect(btn.dataset.eventId, btn.dataset.uid, btn.dataset.effect));
  });
}

async function _applyDriftEffect(eventId, uid, newEffectRaw) {
  if (!eventId || !uid || !newEffectRaw) return;
  if (_eventsApplyInFlight.has(eventId)) return;
  _eventsApplyInFlight.add(eventId);
  _renderEventsList();
  try {
    // v2.74.310 — newEffectRaw arrives as a JSON string from the
    // button's data-effect attribute (the observed Effect object was
    // JSON-serialized at render time). Parse + normalize to the
    // spec-aligned object. Legacy bare-string effects (pre-v2.74.305
    // events) are also handled.
    const _normalizeEffect = (raw) => {
      let v = raw;
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('{')) {
          try { v = JSON.parse(trimmed); } catch { v = { kind: trimmed }; }
        } else {
          v = { kind: trimmed };   // legacy bare string
        }
      }
      if (!v || typeof v !== 'object' || !v.kind) return { kind: 'none' };
      const out = { kind: v.kind };
      if (v.kind === 'opens-new-thread') out.form = v.form ?? 'tab';
      if (v.kind === 'triggers-modal')   out.modalKind = v.modalKind ?? 'confirm';
      return out;
    };
    const effectPatch = _normalizeEffect(newEffectRaw);
    const res = await chrome.runtime.sendMessage({
      type   : 'UPDATE_LANDMARK',
      // v2.74.310 — Applying observed drift sets effectSource='observed'
      // (ACTION_SPEC § 5 source attribution — the value is now confirmed
      // by a real run, the highest-trust source).
      payload: { uid, patch: { effect: effectPatch, effectSource: 'observed' } },
    });
    if (!res?.success) {
      showPerspectiveWarning(`Drift apply failed: ${res?.error ?? 'unknown'}`);
      return;
    }
    _eventsAppliedDrift.add(eventId);
    Logger.info('perspective-capture', `Applied drift: ${uid} effect → ${JSON.stringify(effectPatch)} (source=observed)`);
    // Refresh the in-memory landmark copy if it's in the current draft.
    if (Array.isArray(_perspectiveDraft?.landmarks)) {
      for (let i = 0; i < _perspectiveDraft.landmarks.length; i++) {
        if (_perspectiveDraft.landmarks[i]?.uid === uid) {
          _perspectiveDraft.landmarks[i] = {
            ..._perspectiveDraft.landmarks[i],
            effect: effectPatch,
            effectSource: 'observed',
          };
        }
      }
    }
  } catch (e) {
    showPerspectiveWarning(`Drift apply failed: ${e.message}`);
  } finally {
    _eventsApplyInFlight.delete(eventId);
    _renderEventsList();
  }
}

async function _clearEventsPanel() {
  if (!_perspectiveGroundId) return;
  if (!confirm('Clear all substrate events for this Ground? This is informational telemetry — clearing does not affect landmark state.')) return;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'CLEAR_GROUND_EVENTS', payload: { groundId: _perspectiveGroundId },
    });
    if (res?.success) {
      _eventsCache = [];
      if (perspectiveEventsCount) perspectiveEventsCount.textContent = '';
      _renderEventsList();
    } else {
      showPerspectiveWarning(`Clear failed: ${res?.error ?? 'unknown'}`);
    }
  } catch (e) {
    showPerspectiveWarning(`Clear failed: ${e.message}`);
  }
}

// ─── v2.74.260 — Phase 7d surface: predicate authoring ──────────────────
//
// Single-level AND-of-leaves authoring. Supported leaf kinds:
//   visible       { target: uid }            — landmark visible on page
//   hasText       { target: uid, value }     — landmark text contains value
//   iframeLoaded  { contextName }            — named iframe context loaded
//
// urlMatches lives in the dedicated URL pattern field above (legacy
// shape). The two are AND'd at runtime by PerspectivePredicates.
//
// Tree-form (AND/OR/NOT operators) is NOT authorable here. If the
// hydrating perspective carries a tree, it's preserved via
// _perspectiveDraft._predicatesOriginalTree and the editor stays empty
// (author sees a warning at load time). Future tree editor lands as
// a Studio surface.

const _PRED_KIND_CHOICES = [
  { value: 'urlMatches',      label: 'URL matches' },
  { value: 'visible',         label: 'Landmark visible' },
  { value: 'hasText',         label: 'Landmark has text' },
  // v2.74.331 — PERSPECTIVE_SPEC § 4: complete the predicate vocabulary.
  { value: 'attributeEquals', label: 'Landmark attribute equals' },
  { value: 'landmarkExists',  label: 'Landmark exists' },
  { value: 'iframeLoaded',    label: 'iframe context loaded' },
];

function _landmarkUidOptionsForPredicates(selectedUid) {
  // Build <option>s from current draft landmarks (free) — they're
  // the most likely target for visible/hasText. Empty option first
  // so author actively picks.
  const opts = ['<option value="">— pick landmark —</option>'];
  for (const lm of (_perspectiveDraft?.landmarks ?? [])) {
    if (!lm?.uid) continue;   // un-persisted landmarks can't be referenced
    const label = lm.accessibleName ?? lm.alias ?? lm.uid;
    const sel = lm.uid === selectedUid ? ' selected' : '';
    opts.push(`<option value="${escAttr(lm.uid)}"${sel}>${escHtml(label)}</option>`);
  }
  return opts.join('');
}

function _renderPredicateRow(predicate, idx) {
  const kind = predicate.kind ?? 'visible';
  const kindOpts = _PRED_KIND_CHOICES.map(c =>
    `<option value="${escAttr(c.value)}"${c.value === kind ? ' selected' : ''}>${escHtml(c.label)}</option>`
  ).join('');
  let bodyHtml = '';
  if (kind === 'urlMatches') {
    const mode = predicate.mode ?? 'contains';
    const modeOpts = ['contains', 'regex', 'exact'].map(m =>
      `<option value="${m}"${m === mode ? ' selected' : ''}>${m}</option>`
    ).join('');
    bodyHtml = `
      <label class="dbg-perspective-predicate-field">
        <span class="dbg-perspective-predicate-field-label">URL pattern</span>
        <input type="text" class="dbg-perspective-predicate-value" data-action="predicate-pattern" data-idx="${idx}" maxlength="400" value="${escAttr(predicate.pattern ?? '')}" placeholder="e.g. github.com/repos, or full URL" />
      </label>
      <label class="dbg-perspective-predicate-field">
        <span class="dbg-perspective-predicate-field-label">Match mode</span>
        <select data-action="predicate-mode" data-idx="${idx}">${modeOpts}</select>
      </label>`;
  } else if (kind === 'visible') {
    bodyHtml = `
      <label class="dbg-perspective-predicate-field">
        <span class="dbg-perspective-predicate-field-label">Target landmark</span>
        <select class="dbg-perspective-predicate-target" data-action="predicate-target" data-idx="${idx}">
          ${_landmarkUidOptionsForPredicates(predicate.target)}
        </select>
      </label>`;
  } else if (kind === 'hasText') {
    const csChecked = predicate.caseSensitive === true ? ' checked' : '';
    bodyHtml = `
      <label class="dbg-perspective-predicate-field">
        <span class="dbg-perspective-predicate-field-label">Target landmark</span>
        <select class="dbg-perspective-predicate-target" data-action="predicate-target" data-idx="${idx}">
          ${_landmarkUidOptionsForPredicates(predicate.target)}
        </select>
      </label>
      <label class="dbg-perspective-predicate-field">
        <span class="dbg-perspective-predicate-field-label">Text contains</span>
        <input type="text" class="dbg-perspective-predicate-value" data-action="predicate-value" data-idx="${idx}" maxlength="280" value="${escAttr(predicate.value ?? '')}" placeholder="substring to match" />
      </label>
      <label class="dbg-perspective-predicate-checkbox-label">
        <input type="checkbox" data-action="predicate-case" data-idx="${idx}"${csChecked} />
        <span>case-sensitive</span>
      </label>`;
  } else if (kind === 'attributeEquals') {
    // v2.74.331 — target landmark + attribute name + expected value.
    bodyHtml = `
      <label class="dbg-perspective-predicate-field">
        <span class="dbg-perspective-predicate-field-label">Target landmark</span>
        <select class="dbg-perspective-predicate-target" data-action="predicate-target" data-idx="${idx}">
          ${_landmarkUidOptionsForPredicates(predicate.target)}
        </select>
      </label>
      <label class="dbg-perspective-predicate-field">
        <span class="dbg-perspective-predicate-field-label">Attribute</span>
        <input type="text" class="dbg-perspective-predicate-attr" data-action="predicate-attribute" data-idx="${idx}" maxlength="80" value="${escAttr(predicate.attribute ?? '')}" placeholder="e.g. aria-expanded, data-state, role" />
      </label>
      <label class="dbg-perspective-predicate-field">
        <span class="dbg-perspective-predicate-field-label">Equals value</span>
        <input type="text" class="dbg-perspective-predicate-value" data-action="predicate-value" data-idx="${idx}" maxlength="280" value="${escAttr(predicate.value ?? '')}" placeholder="exact attribute value" />
      </label>`;
  } else if (kind === 'landmarkExists') {
    // v2.74.331 — target landmark only (selector resolves in DOM).
    bodyHtml = `
      <label class="dbg-perspective-predicate-field">
        <span class="dbg-perspective-predicate-field-label">Target landmark</span>
        <select class="dbg-perspective-predicate-target" data-action="predicate-target" data-idx="${idx}">
          ${_landmarkUidOptionsForPredicates(predicate.target)}
        </select>
      </label>`;
  } else if (kind === 'iframeLoaded') {
    bodyHtml = `
      <label class="dbg-perspective-predicate-field">
        <span class="dbg-perspective-predicate-field-label">Context name</span>
        <input type="text" class="dbg-perspective-predicate-ctxname" data-action="predicate-ctxname" data-idx="${idx}" maxlength="80" value="${escAttr(predicate.contextName ?? '')}" placeholder="declared in this perspective's iframeContexts[]" />
      </label>`;
  }
  return `
    <div class="dbg-perspective-predicate-row" data-idx="${idx}">
      <div class="dbg-perspective-predicate-head">
        <select class="dbg-perspective-predicate-kind" data-action="predicate-kind" data-idx="${idx}">${kindOpts}</select>
        <button class="dbg-perspective-predicate-remove" data-action="predicate-remove" data-idx="${idx}" title="Remove this predicate" type="button">✕</button>
      </div>
      <div class="dbg-perspective-predicate-body">${bodyHtml}</div>
    </div>`;
}

function _renderPredicates() {
  if (!perspectivePredicatesList || !_perspectiveDraft) return;
  // v2.74.271 — Reflect operator selector state.
  if (perspectivePredicatesOpSelect && perspectivePredicatesOpSelect.value !== _predicatesOperator) {
    perspectivePredicatesOpSelect.value = _predicatesOperator;
  }
  _updatePredicatesHint();
  // v2.74.271 — Add button visibility honors NOT-single-child constraint.
  if (perspectivePredicatesAddBtn) {
    const atNotCap = _predicatesOperator === 'not' && (_perspectiveDraft.predicates?.length ?? 0) >= 1;
    perspectivePredicatesAddBtn.disabled = atNotCap;
    perspectivePredicatesAddBtn.title = atNotCap
      ? 'NOT takes a single predicate — remove the current one or switch operator first'
      : '';
  }
  const preds = Array.isArray(_perspectiveDraft.predicates) ? _perspectiveDraft.predicates : [];
  if (preds.length === 0) {
    perspectivePredicatesList.innerHTML = `<div class="dbg-perspective-predicates-empty">No additional predicates. Perspective activates on URL pattern match alone.</div>`;
    return;
  }
  perspectivePredicatesList.innerHTML = preds.map((p, i) => _renderPredicateRow(p, i)).join('');
  // Wire row-level handlers (delegated via data-action).
  perspectivePredicatesList.querySelectorAll('[data-action]').forEach(el => {
    const evtName = (el.tagName === 'SELECT' || el.tagName === 'INPUT') ? 'change' : 'click';
    el.addEventListener(evtName, () => _handlePredicateAction(el));
    if (el.tagName === 'INPUT' && el.type === 'text') {
      // Live edit on text inputs (so the draft stays in sync even
      // without blur).
      el.addEventListener('input', () => _handlePredicateAction(el));
    }
  });
}

function _handlePredicateAction(el) {
  const idx = parseInt(el.dataset.idx, 10);
  const action = el.dataset.action;
  if (!_perspectiveDraft || !Array.isArray(_perspectiveDraft.predicates)) return;
  const pred = _perspectiveDraft.predicates[idx];
  if (!pred && action !== 'predicate-remove') return;
  switch (action) {
    case 'predicate-kind': {
      // Changing kind discards kind-specific fields.
      const newKind = el.value;
      _perspectiveDraft.predicates[idx] = { kind: newKind };
      _renderPredicates();
      _evaluateActiveState({ debounce: true });   // v2.74.265
      return;
    }
    case 'predicate-target':
      pred.target = el.value || undefined;
      _evaluateActiveState({ debounce: true });   // v2.74.265
      return;
    case 'predicate-value':
      pred.value = el.value;
      _evaluateActiveState({ debounce: true });   // v2.74.265
      return;
    case 'predicate-attribute':
      // v2.74.331 — attributeEquals.attribute editor.
      pred.attribute = el.value;
      _evaluateActiveState({ debounce: true });
      return;
    case 'predicate-case':
      pred.caseSensitive = el.checked === true;
      _evaluateActiveState({ debounce: true });   // v2.74.265
      return;
    case 'predicate-ctxname':
      pred.contextName = el.value.trim();
      _evaluateActiveState({ debounce: true });   // v2.74.265
      return;
    case 'predicate-pattern':
      // v2.74.275 — urlMatches.pattern editor.
      pred.pattern = el.value;
      _evaluateActiveState({ debounce: true });
      return;
    case 'predicate-mode':
      // v2.74.275 — urlMatches.mode editor (contains | regex | exact).
      pred.mode = el.value;
      _evaluateActiveState({ debounce: true });
      return;
    case 'predicate-remove':
      _perspectiveDraft.predicates.splice(idx, 1);
      _renderPredicates();
      _evaluateActiveState({ debounce: true });   // v2.74.265
      return;
  }
}

function _addPredicate() {
  if (!_perspectiveDraft) return;
  if (!Array.isArray(_perspectiveDraft.predicates)) _perspectiveDraft.predicates = [];
  // v2.74.271 — NOT is a single-child operator. Block second predicate
  // under NOT; surface an inline hint.
  if (_predicatesOperator === 'not' && _perspectiveDraft.predicates.length >= 1) {
    showPerspectiveWarning('NOT operator takes a single predicate. Switch to AND/OR to add more, or remove the existing one first.');
    return;
  }
  // Default kind = visible (most useful for typical use cases). Target
  // unset; author must pick.
  _perspectiveDraft.predicates.push({ kind: 'visible' });
  _renderPredicates();
  // v2.74.265 — Predicate set changed; re-evaluate active state.
  _evaluateActiveState({ debounce: true });
}

// v2.74.271 — Top-level operator change handler. AND ↔ OR is a
// straight swap. Switching to NOT truncates to a single predicate
// after author confirmation (since NOT takes one child).
function _onPredicatesOperatorChange() {
  if (!perspectivePredicatesOpSelect) return;
  const newOp = perspectivePredicatesOpSelect.value;
  if (newOp === 'not' && (_perspectiveDraft?.predicates?.length ?? 0) > 1) {
    if (!confirm(`NOT operator takes a single predicate. Switching will keep only the first predicate (${_perspectiveDraft.predicates[0]?.kind ?? '?'}) and discard the others. Continue?`)) {
      // Revert dropdown.
      perspectivePredicatesOpSelect.value = _predicatesOperator;
      return;
    }
    _perspectiveDraft.predicates = _perspectiveDraft.predicates.slice(0, 1);
  }
  _predicatesOperator = newOp;
  _renderPredicates();
  _updatePredicatesHint();
  _evaluateActiveState({ debounce: true });
}

function _updatePredicatesHint() {
  if (!perspectivePredicatesHint) return;
  const hint = _predicatesOperator === 'and'
    ? 'Perspective is active when URL pattern matches AND every predicate below evaluates true. Unverifiable predicates (e.g., landmark not on page) fail closed.'
    : _predicatesOperator === 'or'
    ? 'Perspective is active when URL pattern matches AND at least one predicate below evaluates true. Unverifiable predicates count as failed.'
    : 'Perspective is active when URL pattern matches AND the predicate below evaluates FALSE. Unverifiable predicates fail closed (so NOT-unverifiable = active).';
  perspectivePredicatesHint.textContent = hint;
}

// ─── v2.74.267 — iframe contexts editor ─────────────────────────────────
//
// Authors a list of named iframe predicates stored on the perspective as
// perspective.iframeContexts[]. Each entry has { contextName, predicate,
// sameOrigin? } where predicate is one of:
//   { kind: 'iframeName',      value: '<name>' }
//   { kind: 'iframeSelector',  selector: '<css>' }
//   { kind: 'iframeSrcPattern', pattern: '<...>', mode: 'contains'|'regex'|'exact' }
//   { kind: 'iframePositional', index: <num> }
//
// Landmarks bind to a context by name (landmark.iframeContext). Phase
// 7b routing uses this binding to resolve the right frameId at
// dispatch time without selector-frameUrl-equality fragility.
//
// Operations:
//   Rename context: cascades to landmarks referencing it (same-perspective).
//   Remove context: warns if landmarks reference it; on confirm,
//     clears their landmark.iframeContext binding.
//   Test predicate: sends RESOLVE_IFRAME_BY_PREDICATE to live page;
//     shows found/not-found + same-origin/loaded state.

const _IFRAME_PRED_KINDS = [
  { value: 'iframeName',       label: 'By name attribute' },
  { value: 'iframeSelector',   label: 'By CSS selector' },
  { value: 'iframeSrcPattern', label: 'By src pattern' },
  { value: 'iframePositional', label: 'By position' },
];

function _renderIframeContexts() {
  if (!perspectiveIframeContextsList || !_perspectiveDraft) return;
  const ctxs = Array.isArray(_perspectiveDraft.iframeContexts) ? _perspectiveDraft.iframeContexts : [];
  if (ctxs.length === 0) {
    perspectiveIframeContextsList.innerHTML = `<div class="dbg-perspective-iframe-contexts-empty">No iframe contexts. Landmarks picked from iframes auto-populate this list.</div>`;
    return;
  }
  perspectiveIframeContextsList.innerHTML = ctxs.map((c, i) => _renderIframeContextRow(c, i)).join('');
  // Wire delegated handlers (change for selects/inputs, click for buttons).
  perspectiveIframeContextsList.querySelectorAll('[data-iframe-action]').forEach(el => {
    const evt = (el.tagName === 'SELECT' || el.tagName === 'INPUT') ? 'change' : 'click';
    el.addEventListener(evt, () => _handleIframeContextAction(el));
    if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number')) {
      el.addEventListener('input', () => _handleIframeContextAction(el));
    }
  });
}

function _renderIframeContextRow(ctx, idx) {
  const kind = ctx.predicate?.kind ?? 'iframeName';
  const kindOpts = _IFRAME_PRED_KINDS.map(k =>
    `<option value="${escAttr(k.value)}"${k.value === kind ? ' selected' : ''}>${escHtml(k.label)}</option>`
  ).join('');
  let bodyHtml = '';
  if (kind === 'iframeName') {
    bodyHtml = `
      <label class="dbg-perspective-iframe-context-field">
        <span class="dbg-perspective-iframe-context-field-label">Name attribute</span>
        <input type="text" data-iframe-action="pred-value" data-idx="${idx}" maxlength="200" value="${escAttr(ctx.predicate?.value ?? '')}" placeholder="iframe[name=&quot;...&quot;]" />
      </label>`;
  } else if (kind === 'iframeSelector') {
    bodyHtml = `
      <label class="dbg-perspective-iframe-context-field">
        <span class="dbg-perspective-iframe-context-field-label">CSS selector</span>
        <input type="text" data-iframe-action="pred-selector" data-idx="${idx}" maxlength="400" value="${escAttr(ctx.predicate?.selector ?? '')}" placeholder="iframe#main-frame, .embed > iframe" />
      </label>`;
  } else if (kind === 'iframeSrcPattern') {
    const mode = ctx.predicate?.mode ?? 'contains';
    const modeOpts = ['contains', 'regex', 'exact'].map(m =>
      `<option value="${m}"${m === mode ? ' selected' : ''}>${m}</option>`
    ).join('');
    bodyHtml = `
      <label class="dbg-perspective-iframe-context-field">
        <span class="dbg-perspective-iframe-context-field-label">src pattern</span>
        <input type="text" data-iframe-action="pred-pattern" data-idx="${idx}" maxlength="400" value="${escAttr(ctx.predicate?.pattern ?? '')}" placeholder="hubapi.com/widget" />
      </label>
      <label class="dbg-perspective-iframe-context-field">
        <span class="dbg-perspective-iframe-context-field-label">match mode</span>
        <select data-iframe-action="pred-mode" data-idx="${idx}">${modeOpts}</select>
      </label>`;
  } else if (kind === 'iframePositional') {
    bodyHtml = `
      <label class="dbg-perspective-iframe-context-field">
        <span class="dbg-perspective-iframe-context-field-label">index (0-based)</span>
        <input type="number" data-iframe-action="pred-index" data-idx="${idx}" min="0" max="50" value="${escAttr(ctx.predicate?.index ?? 0)}" />
      </label>`;
  }
  // Find landmarks referencing this context (in this perspective).
  const refs = (_perspectiveDraft.landmarks ?? []).filter(lm => lm?.iframeContext === ctx.contextName);
  const refsBadge = refs.length > 0
    ? `<span class="dbg-perspective-iframe-context-refs" title="Landmarks in this perspective bound to this context">${refs.length} landmark${refs.length === 1 ? '' : 's'}</span>`
    : '';
  // sameOrigin display (captured at create time or from test).
  let originBadge = '';
  if (ctx.sameOrigin === true) {
    originBadge = `<span class="dbg-perspective-iframe-context-origin dbg-perspective-iframe-context-same-origin">same-origin</span>`;
  } else if (ctx.sameOrigin === false) {
    originBadge = `<span class="dbg-perspective-iframe-context-origin dbg-perspective-iframe-context-cross-origin">cross-origin</span>`;
  }
  // Test outcome banner.
  let testHtml = '';
  if (_iframeTestInFlight.has(idx)) {
    testHtml = `<div class="dbg-perspective-iframe-context-test test-loading">⌛ Testing predicate against live page…</div>`;
  } else {
    const out = _iframeTestOutcome.get(idx);
    if (out) {
      testHtml = `<div class="dbg-perspective-iframe-context-test test-${escAttr(out.kind)}">${escHtml(out.message)}</div>`;
    }
  }
  return `
    <div class="dbg-perspective-iframe-context-row" data-idx="${idx}">
      <div class="dbg-perspective-iframe-context-head">
        <label class="dbg-perspective-iframe-context-name-label">
          <span>Name</span>
          <input type="text" data-iframe-action="rename" data-idx="${idx}" maxlength="80" value="${escAttr(ctx.contextName ?? '')}" placeholder="e.g. chatspot-widget" />
        </label>
        ${refsBadge}
        ${originBadge}
        <button class="btn-secondary tiny" data-iframe-action="test" data-idx="${idx}" type="button" title="Evaluate predicate against the current page">Test</button>
        <button class="dbg-perspective-iframe-context-remove" data-iframe-action="remove" data-idx="${idx}" type="button" title="Remove this iframe context">✕</button>
      </div>
      <div class="dbg-perspective-iframe-context-body">
        <label class="dbg-perspective-iframe-context-field">
          <span class="dbg-perspective-iframe-context-field-label">Match by</span>
          <select data-iframe-action="kind" data-idx="${idx}">${kindOpts}</select>
        </label>
        ${bodyHtml}
      </div>
      ${testHtml}
    </div>`;
}

async function _handleIframeContextAction(el) {
  const idx = parseInt(el.dataset.idx, 10);
  const action = el.dataset.iframeAction;
  if (!_perspectiveDraft) return;
  if (!Array.isArray(_perspectiveDraft.iframeContexts)) _perspectiveDraft.iframeContexts = [];
  const ctx = _perspectiveDraft.iframeContexts[idx];
  if (!ctx && action !== 'remove') return;
  switch (action) {
    case 'rename': {
      const oldName = ctx.contextName;
      const newName = el.value.trim();
      if (!newName || newName === oldName) {
        if (!newName) ctx.contextName = oldName;   // restore non-empty
        return;
      }
      // Cascade to landmarks referencing the old name (same perspective).
      let cascaded = 0;
      for (const lm of (_perspectiveDraft.landmarks ?? [])) {
        if (lm?.iframeContext === oldName) {
          lm.iframeContext = newName;
          cascaded++;
        }
      }
      ctx.contextName = newName;
      Logger.info('perspective-capture', `iframe context renamed "${oldName}" → "${newName}"; cascaded to ${cascaded} landmark(s)`);
      _renderIframeContexts();
      return;
    }
    case 'kind': {
      // Changing kind starts a fresh predicate of that kind.
      const newKind = el.value;
      ctx.predicate = { kind: newKind };
      // Sensible default for positional.
      if (newKind === 'iframePositional') ctx.predicate.index = 0;
      if (newKind === 'iframeSrcPattern') ctx.predicate.mode  = 'contains';
      _iframeTestOutcome.delete(idx);   // stale test outcome
      _renderIframeContexts();
      return;
    }
    case 'pred-value':
      ctx.predicate.value = el.value;
      _iframeTestOutcome.delete(idx);
      return;
    case 'pred-selector':
      ctx.predicate.selector = el.value;
      _iframeTestOutcome.delete(idx);
      return;
    case 'pred-pattern':
      ctx.predicate.pattern = el.value;
      _iframeTestOutcome.delete(idx);
      return;
    case 'pred-mode':
      ctx.predicate.mode = el.value;
      _iframeTestOutcome.delete(idx);
      return;
    case 'pred-index':
      ctx.predicate.index = Math.max(0, parseInt(el.value, 10) || 0);
      _iframeTestOutcome.delete(idx);
      return;
    case 'test':
      await _testIframeContext(idx);
      return;
    case 'remove': {
      const refs = (_perspectiveDraft.landmarks ?? []).filter(lm => lm?.iframeContext === ctx?.contextName);
      if (refs.length > 0) {
        const names = refs.slice(0, 3).map(lm => `"${lm.accessibleName ?? lm.alias}"`).join(', ');
        const more = refs.length > 3 ? `, +${refs.length - 3} more` : '';
        if (!confirm(`Remove iframe context "${ctx.contextName}"?\n\n${refs.length} landmark${refs.length === 1 ? '' : 's'} reference it: ${names}${more}\n\nTheir iframe binding will be cleared (they fall back to the legacy frameUrl path).\n\nContinue?`)) {
          return;
        }
        for (const lm of refs) lm.iframeContext = null;
      }
      _perspectiveDraft.iframeContexts.splice(idx, 1);
      _iframeTestOutcome.delete(idx);
      _iframeTestInFlight.delete(idx);
      _renderIframeContexts();
      return;
    }
  }
}

async function _testIframeContext(idx) {
  const ctx = _perspectiveDraft?.iframeContexts?.[idx];
  if (!ctx) return;
  if (_perspectiveTabId == null) {
    _iframeTestOutcome.set(idx, { kind: 'error', message: '⚠ No active tab. Switch to your target tab and retry.' });
    _renderIframeContexts();
    return;
  }
  if (_iframeTestInFlight.has(idx)) return;
  _iframeTestInFlight.add(idx);
  _renderIframeContexts();
  try {
    const res = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(_perspectiveTabId, {
        type   : 'RESOLVE_IFRAME_BY_PREDICATE',
        payload: { predicate: ctx.predicate },
      }, { frameId: 0 }, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
    if (!res) {
      _iframeTestOutcome.set(idx, { kind: 'error', message: '⛔ No response from content script.' });
    } else if (res.success === false) {
      if (res.reason === 'iframe-absent') {
        _iframeTestOutcome.set(idx, { kind: 'absent', message: '✗ No iframe matched the predicate on the current page.' });
      } else {
        _iframeTestOutcome.set(idx, { kind: 'error', message: `⛔ ${res.error ?? 'unknown error'}` });
      }
    } else {
      // Update sameOrigin from the live observation.
      ctx.sameOrigin = res.sameOrigin === true;
      const originText = ctx.sameOrigin ? 'same-origin' : 'cross-origin';
      const loadedText = res.loaded === true ? 'loaded' : 'not loaded';
      _iframeTestOutcome.set(idx, {
        kind   : 'ok',
        message: `✓ Matched iframe (${originText}, ${loadedText})${res.src ? `: ${String(res.src).slice(0, 80)}` : ''}`,
      });
    }
  } catch (e) {
    _iframeTestOutcome.set(idx, { kind: 'error', message: `⛔ ${e.message}` });
  } finally {
    _iframeTestInFlight.delete(idx);
    _renderIframeContexts();
  }
}

function _addIframeContext() {
  if (!_perspectiveDraft) return;
  if (!Array.isArray(_perspectiveDraft.iframeContexts)) _perspectiveDraft.iframeContexts = [];
  // Generate a unique default name.
  let base = 'iframe-context';
  let name = base;
  let n = 2;
  while (_perspectiveDraft.iframeContexts.some(c => c.contextName === name)) {
    name = `${base}-${n++}`;
  }
  _perspectiveDraft.iframeContexts.push({
    contextName: name,
    predicate  : { kind: 'iframeName', value: '' },
  });
  _renderIframeContexts();
}

// ─── v2.74.265 — Phase 7d surface: perspective active-state preview ──────────
//
// Author authors predicates → wants to know whether the perspective would
// activate on the current tab right now. isPerspectiveActive does the
// evaluation; we wrap it with a small per-leaf diagnostic so authors
// see WHY a predicate fails (target landmark not visible, URL doesn't
// match, etc.) instead of just a binary ✓/✗.
//
// Evaluation triggers:
//   - On mount (initial draft state)
//   - On Refresh button click (immediate)
//   - On any predicate edit (300ms debounce to avoid keystroke noise)
//   - On urlPattern edit (debounced)
//   - On tab change (handled by existing refreshPerspectiveActiveTab hook)
//
// Cost: 1 round-trip per visible/hasText/iframeLoaded leaf. URL match
// is free (synchronous). For a typical 1-3 leaf perspective, sub-100ms.

async function _evaluateActiveState({ debounce = false, immediate = false } = {}) {
  if (!perspectiveActiveStateResult) return;
  if (debounce && !immediate) {
    if (_activeStateDebounce) clearTimeout(_activeStateDebounce);
    _activeStateDebounce = setTimeout(() => _evaluateActiveState({ immediate: true }), 300);
    return;
  }
  if (_activeStateEvaluating) return;
  _activeStateEvaluating = true;
  if (perspectiveActiveStateRefreshBtn) perspectiveActiveStateRefreshBtn.disabled = true;
  try {
    perspectiveActiveStateResult.innerHTML = `<span class="dbg-perspective-active-state-loading">⌛ Evaluating…</span>`;
    // Build the draft as a pseudo-perspective for the evaluator. Pull the
    // current URL pattern from the input (not _perspectiveDraft.urlPattern,
    // which is only synced on save) so live edits show.
    // v2.74.271 — Wrap predicates per the top-level operator so the
    // evaluator sees the operator semantics. AND ships as flat array
    // (legacy shape, equivalent to implicit AND). OR/NOT ship as
    // tree object the evaluator handles natively.
    const rawPreds = Array.isArray(_perspectiveDraft?.predicates) ? _perspectiveDraft.predicates : [];
    let predsForEval = rawPreds;
    if ((_predicatesOperator === 'or' || _predicatesOperator === 'not') && rawPreds.length > 0) {
      predsForEval = {
        operator: _predicatesOperator,
        children: _predicatesOperator === 'not' ? rawPreds.slice(0, 1) : rawPreds.slice(),
      };
    }
    const draftPerspective = {
      id           : _perspectiveDraft?.id,
      name         : _perspectiveDraft?.name ?? '',
      // v2.74.275 — urlPattern field gone; predicates carry URL gating.
      predicates   : predsForEval,
      iframeContexts: _perspectiveDraft?.iframeContexts ?? [],
      landmarkRefs : (_perspectiveDraft?.landmarks ?? []).map(lm => lm?.uid).filter(Boolean),
    };
    const context = {
      tabId : _perspectiveTabId ?? undefined,
      tabUrl: perspectiveTabUrlEl?.textContent && perspectiveTabUrlEl.textContent !== '—' && perspectiveTabUrlEl.textContent !== '(no active tab)'
        ? perspectiveTabUrlEl.textContent
        : null,
    };
    if (!context.tabUrl) {
      // No tab info — surface a clear unverifiable state.
      _renderActiveStateResult({ kind: 'no-tab' });
      return;
    }
    // Run the top-level evaluation. We ALSO walk the leaves manually
    // to build a per-predicate diagnostic — isPerspectiveActive collapses
    // to a single bool so it can't tell us which leaf failed.
    const overall = await isPerspectiveActive(draftPerspective, context);
    const leafDiagnostics = await _diagnoseLeaves(draftPerspective, context);
    _renderActiveStateResult({
      kind: overall === true ? 'active' : 'inactive',
      overall,
      leafDiagnostics,
      predicateCount: Array.isArray(draftPerspective.predicates) ? draftPerspective.predicates.length : (draftPerspective.predicates?.children?.length ?? 0),
    });
  } catch (e) {
    _renderActiveStateResult({ kind: 'error', error: e.message });
  } finally {
    _activeStateEvaluating = false;
    if (perspectiveActiveStateRefreshBtn) perspectiveActiveStateRefreshBtn.disabled = false;
  }
}

// Walk the predicates and evaluate each leaf in isolation. Returns
// an array of { label, result, reason }. v2.74.271 — When predicates
// is a tree (operator + children), walks the children. v2.74.275 —
// Legacy urlPattern leaf removed; URL gating now flows through
// predicates as a urlMatches leaf, evaluated like any other.
async function _diagnoseLeaves(draftPerspective, context) {
  const diagnostics = [];
  // Extract leaves from either flat-array or operator-tree shape.
  let leaves = [];
  if (Array.isArray(draftPerspective.predicates)) {
    leaves = draftPerspective.predicates;
  } else if (draftPerspective.predicates?.children && Array.isArray(draftPerspective.predicates.children)) {
    leaves = draftPerspective.predicates.children;
  }
  for (let i = 0; i < leaves.length; i++) {
    const p = leaves[i];
    if (!p || typeof p !== 'object' || !p.kind) {
      diagnostics.push({ label: `Predicate #${i + 1}: missing kind`, result: null, reason: 'invalid' });
      continue;
    }
    // Evaluate this leaf alone by wrapping it in a minimal pseudo-
    // perspective containing only this predicate. Cheap, reuses the same
    // evaluator path.
    const singletonPerspective = {
      ...draftPerspective,
      predicates: [p],
    };
    const result = await isPerspectiveActive(singletonPerspective, context);
    const label = _predicateLabel(p);
    let reason = null;
    if (result === false) {
      reason = _predicateFailureReason(p);
    } else if (result === null || result === undefined) {
      reason = 'unverifiable (likely missing target or unreachable element)';
    }
    diagnostics.push({ label, result, reason });
  }
  return diagnostics;
}

function _predicateLabel(p) {
  if (!p?.kind) return '(invalid)';
  const targetName = (uid) => {
    if (!uid) return '?';
    const lm = (_perspectiveDraft?.landmarks ?? []).find(l => l?.uid === uid);
    return lm?.accessibleName ?? lm?.alias ?? uid.slice(0, 12);
  };
  switch (p.kind) {
    case 'visible':      return `Landmark visible: ${targetName(p.target)}`;
    case 'hasText':      return `${targetName(p.target)} contains "${p.value ?? ''}"`;
    case 'iframeLoaded': return `iframe context loaded: ${p.contextName ?? '?'}`;
    case 'urlMatches':   return `URL ${p.mode ?? 'contains'} "${p.pattern ?? ''}"`;
    default:             return `${p.kind} (unknown)`;
  }
}

function _predicateFailureReason(p) {
  switch (p?.kind) {
    case 'visible':      return 'Target landmark not visible on the current page';
    case 'hasText':      return 'Target landmark text does not contain the value';
    case 'iframeLoaded': return 'Named iframe context not declared or not loaded';
    case 'urlMatches':   return 'URL pattern does not match';
    default:             return 'Failed';
  }
}

function _renderActiveStateResult(state) {
  if (!perspectiveActiveStateResult) return;
  if (state.kind === 'no-tab') {
    perspectiveActiveStateResult.innerHTML = `
      <div class="dbg-perspective-active-state-no-tab">
        ⚠ No active tab — switch to your target tab and press Refresh to evaluate.
      </div>`;
    return;
  }
  if (state.kind === 'error') {
    perspectiveActiveStateResult.innerHTML = `
      <div class="dbg-perspective-active-state-error">
        ⛔ Evaluation failed: ${escHtml(state.error ?? 'unknown')}
      </div>`;
    return;
  }
  // active or inactive
  const verdict = state.kind === 'active'
    ? `<div class="dbg-perspective-active-state-verdict dbg-perspective-active-state-verdict-active">✓ Perspective would activate on the current tab</div>`
    : `<div class="dbg-perspective-active-state-verdict dbg-perspective-active-state-verdict-inactive">✗ Perspective would NOT activate</div>`;
  let leafRows = '';
  if (!state.hasUrlPattern && state.predicateCount === 0) {
    leafRows = `<div class="dbg-perspective-active-state-leaf-empty">No predicates authored — any URL matches by default.</div>`;
  } else {
    leafRows = (state.leafDiagnostics ?? []).map(d => {
      const icon = d.result === true ? '✓' : d.result === false ? '✗' : '⚠';
      const cls  = d.result === true ? 'leaf-pass' : d.result === false ? 'leaf-fail' : 'leaf-null';
      return `
        <div class="dbg-perspective-active-state-leaf ${cls}">
          <span class="dbg-perspective-active-state-leaf-icon">${icon}</span>
          <span class="dbg-perspective-active-state-leaf-label">${escHtml(d.label)}</span>
          ${d.reason ? `<span class="dbg-perspective-active-state-leaf-reason">${escHtml(d.reason)}</span>` : ''}
        </div>`;
    }).join('');
  }
  perspectiveActiveStateResult.innerHTML = verdict + leafRows;
}

function _renderLandmarkProfileDrawer(idx) {
  if (!_perspectiveDraft?.landmarks?.[idx]) return '';
  const lm = _perspectiveDraft.landmarks[idx];
  // v2.74.281 — Drawer now body-only. Toggle button lives in the
  // row's controls (v2.74.281 header refactor). This function returns
  // empty when collapsed (caller already guards `isExpanded ? ... : ''`).
  // Confidence chip moved into the body's Profile subsection.
  const confChip = (typeof lm.profileConfidence === 'number')
    ? `<span class="dbg-perspective-landmark-profile-conf" title="Claude's self-reported confidence">conf: ${Math.round(lm.profileConfidence * 100)}%</span>`
    : '';

  // Expanded body — Selector (read-only) + Description (editable) +
  // Aliases (editable) + Operations / Pitfalls / Expected (read-only).
  // Selector lives here exclusively now (v2.74.238) — it was promoted
  // off the always-visible row. Pick is the only authoring path to
  // change it; if a one-off hand-edit is genuinely needed, that's
  // worth an explicit "Edit selector" affordance to add later.
  // v2.74.302 — `aliasesValue` was used by the now-removed "Secondary
  // aliases" drawer input. Aliases live in the row-header field.
  const selectorDisplay = lm.selector
    ? `<code class="dbg-perspective-landmark-profile-selector">${escHtml(lm.selector)}</code>`
    : `<span class="dbg-perspective-landmark-profile-empty">no selector yet — click Pick on the page</span>`;
  // v2.74.245 — Phase 7a: iframe context display. When the landmark
  // is bound to a named iframe context (new), show the context name
  // + its predicate from the perspective's iframeContexts. When only the
  // legacy frameUrl is set (pre-Phase-7), show that. Both paths
  // honest about which iframe binding mechanism is in effect.
  let frameDisplay = '';
  if (lm.iframeContext) {
    const ctx = (_perspectiveDraft.iframeContexts ?? []).find(c => c.contextName === lm.iframeContext);
    if (ctx) {
      const predDesc = ctx.predicate.kind === 'iframeName' ? `name="${ctx.predicate.value}"`
                     : ctx.predicate.kind === 'iframeSelector' ? `selector="${ctx.predicate.selector}"`
                     : ctx.predicate.kind === 'iframeSrcPattern' ? `src ${ctx.predicate.mode}: "${ctx.predicate.pattern}"`
                     : ctx.predicate.kind === 'iframePositional' ? `position [${ctx.predicate.index}]`
                     : 'unknown predicate';
      const originBadge = ctx.sameOrigin
        ? `<span class="dbg-perspective-landmark-iframe-origin dbg-perspective-landmark-iframe-same-origin">same-origin</span>`
        : `<span class="dbg-perspective-landmark-iframe-origin dbg-perspective-landmark-iframe-cross-origin">cross-origin</span>`;
      frameDisplay = `<div class="dbg-perspective-landmark-profile-frame">
        in iframe context: <code>${escHtml(lm.iframeContext)}</code>
        ${originBadge}
        <div class="dbg-perspective-landmark-iframe-predicate">predicate: ${escHtml(predDesc)}</div>
      </div>`;
    } else {
      // Bound to a context name that isn't declared in this perspective.
      // Possible during cross-perspective references in Phase 8+ but for
      // now surface as an integrity warning.
      frameDisplay = `<div class="dbg-perspective-landmark-profile-frame dbg-perspective-landmark-iframe-orphan">
        ⚠ bound to iframe context "<code>${escHtml(lm.iframeContext)}</code>" not declared in this perspective
      </div>`;
    }
  } else if (lm.frameUrl) {
    frameDisplay = `<div class="dbg-perspective-landmark-profile-frame" title="${escAttr(lm.frameUrl)}">
      in iframe (legacy): <code>${escHtml(_truncate(lm.frameUrl, 60))}</code>
      <span class="dbg-perspective-landmark-iframe-legacy-hint">re-Pick to migrate to a named iframe context</span>
    </div>`;
  }
  const opsChips = Array.isArray(lm.operationsCommon) && lm.operationsCommon.length > 0
    ? lm.operationsCommon.map(o => `<code class="dbg-perspective-landmark-profile-chip">${escHtml(o)}</code>`).join(' ')
    : '<span class="dbg-perspective-landmark-profile-empty">none suggested</span>';
  const pitfallsList = Array.isArray(lm.pitfalls) && lm.pitfalls.length > 0
    ? `<ul class="dbg-perspective-landmark-profile-pitfalls">${lm.pitfalls.map(p => `<li>${escHtml(p)}</li>`).join('')}</ul>`
    : '<span class="dbg-perspective-landmark-profile-empty">none</span>';
  let expectedHtml;
  if (lm.expectedContent && lm.expectedContent.kind) {
    const ec = lm.expectedContent;
    const parts = [escHtml(ec.kind)];
    if (ec.format)  parts.push(`format: <code>${escHtml(ec.format)}</code>`);
    if (ec.example) parts.push(`example: "${escHtml(ec.example)}"`);
    expectedHtml = parts.join(', ');
  } else {
    expectedHtml = '<span class="dbg-perspective-landmark-profile-empty">n/a (action landmark)</span>';
  }

  // v2.74.239 — Identity layer surfaced when the landmark has been
  // captured with Phase 1 derivation. UID + canonical/local indicator
  // + a11y role + accessible name + hierarchical context. Read-only
  // — derived from the DOM at Pick / Verify time.
  let identityHtml = '';
  if (lm.uid) {
    const canonicalChip = lm.isCanonical
      ? `<span class="dbg-perspective-landmark-identity-chip dbg-perspective-landmark-identity-canonical" title="Derived from accessibility-tree-anchored observable properties; same meaning → same UID across users">canonical</span>`
      : `<span class="dbg-perspective-landmark-identity-chip dbg-perspective-landmark-identity-local" title="Insufficient canonical inputs (no role or no accessible name); per-user identity only">local</span>`;
    const ctxParts = [];
    const ctx = lm.hierarchicalContext;
    if (ctx) {
      if (ctx.ancestorRole) ctxParts.push(escHtml(ctx.ancestorRole));
      if (ctx.ancestorName) ctxParts.push(`"${escHtml(ctx.ancestorName)}"`);
      if (ctx.siblingPosition > 0) ctxParts.push(`#${ctx.siblingPosition}`);
    }
    const ctxText = ctxParts.length > 0 ? ctxParts.join(' / ') : '<span class="dbg-perspective-landmark-profile-empty">none</span>';
    identityHtml = `
      <div class="dbg-perspective-landmark-identity">
        <div class="dbg-perspective-landmark-identity-grid">
          <div class="dbg-perspective-landmark-identity-key">UID</div>
          <div class="dbg-perspective-landmark-identity-val"><code>${escHtml(lm.uid)}</code> ${canonicalChip}</div>
          <div class="dbg-perspective-landmark-identity-key">A11y role</div>
          <div class="dbg-perspective-landmark-identity-val"><code>${escHtml(lm.a11yRole ?? '(none)')}</code></div>
          <div class="dbg-perspective-landmark-identity-key">Accessible name</div>
          <div class="dbg-perspective-landmark-identity-val">${lm.accessibleName
            ? `<code>${escHtml(lm.accessibleName)}</code>`
            : '<span class="dbg-perspective-landmark-profile-empty" title="The picked element does not satisfy the W3C accessible-name calculation (no aria-label, no labelled-by, no text content, no alt). The card uses the alias as a derived display name; identity hashes as local-UID rather than canonical.">(none — element has no accessible name; using alias for display)</span>'}</div>
          <div class="dbg-perspective-landmark-identity-key">Hierarchical context</div>
          <div class="dbg-perspective-landmark-identity-val">${ctxText}</div>
          ${lm.canonicalUrl ? `
          <div class="dbg-perspective-landmark-identity-key">Canonical URL</div>
          <div class="dbg-perspective-landmark-identity-val"><code class="dbg-perspective-landmark-identity-url" title="${escAttr(lm.canonicalUrl)}">${escHtml(_truncate(lm.canonicalUrl, 80))}</code></div>` : ''}
        </div>
      </div>`;
  }
  // v2.74.279 — Drawer body restructured into labeled SUBSECTIONS so
  // inputs and read-only displays group with their domain rather than
  // appearing as a flat list of un-grouped rows. Five subsections:
  //   1. IDENTITY (read-only) — UID, a11y role, ctx, canonical URL
  //   2. REALIZATION (read-only) — selector code, iframe binding
  //   3. DESCRIPTION (editable) — description, secondary aliases
  //   4. VERIFICATION (read-only) — matched count, ops, issues, sample
  //   5. PROFILE (read-only) — operations Claude suggests, pitfalls,
  //      expected content, action effect
  //   6. LIFECYCLE — chip + Deprecate/Restore
  // v2.74.293 — Captured screenshot thumbnail. Stored as a JPEG-compressed
  // copy of what was sent to Claude during the Pick→profile call.
  // v2.74.300 — Two-image story: drawer shows the tight thumbnail
  // (matches the picker overlay 1:1, for identification), but clicking
  // it opens the WIDER CONTEXT SHOT (with red highlight box on the
  // picked element) — that's the image Claude actually used for
  // visual disambiguation, surfaced so the author can review what
  // Claude saw. Falls back to opening the tight thumb when no
  // context shot exists (iframe captures, etc.).
  let screenshotHtml = '';
  if (lm.captureScreenshot && typeof lm.captureScreenshot === 'string') {
    const hasContext = !!lm.captureContextScreenshot;
    const hint = hasContext
      ? 'thumbnail matches the picker overlay; click to open the wider context shot Claude saw (with the highlight box around the picked element)'
      : 'click to open the full image in a new tab';
    screenshotHtml = `
      <div class="lm-drawer-section">
        <div class="lm-drawer-section-label">Captured screenshot <span class="lm-drawer-hint">(${escHtml(hint)})</span></div>
        <div class="lm-screenshot-thumb-wrap">
          <img class="lm-screenshot-thumb" data-action="open-screenshot" data-idx="${idx}" src="${escAttr(lm.captureScreenshot)}" alt="Cropped screenshot of the picked element" title="${escAttr(hasContext ? 'Click to open the wider context screenshot Claude saw (with the picked element highlighted in red)' : 'Click to open full image in a new tab')}" />
        </div>
      </div>`;
  }

  // v2.74.281 — Body-only render. Toggle button lives in row controls.
  return `
    <div class="dbg-perspective-landmark-profile dbg-perspective-landmark-profile-open">
      <div class="dbg-perspective-landmark-profile-body">
        ${identityHtml ? `<div class="lm-drawer-section"><div class="lm-drawer-section-label">Identity <span class="lm-drawer-hint">(computed — never edited)</span>${confChip}</div>${identityHtml}</div>` : ''}

        ${screenshotHtml}

        <div class="lm-drawer-section">
          <div class="lm-drawer-section-label">Realization <span class="lm-drawer-hint">(re-Pick to change)</span></div>
          ${selectorDisplay}
          ${frameDisplay}
        </div>

        <div class="lm-drawer-section">
          <div class="lm-drawer-section-label">Description <span class="lm-drawer-hint">(editable)</span></div>
          <div class="dbg-perspective-landmark-profile-row">
            <label class="lm-field-label">Description</label>
            <textarea class="dbg-perspective-landmark-profile-desc" data-action="profile-desc-edit" data-idx="${idx}" rows="2" maxlength="400" placeholder="What is this and what does it do?">${escHtml(lm.description ?? '')}</textarea>
          </div>
          <!-- v2.74.302 — "Secondary aliases" field removed. The row-header
               "aliases" input is now the single source of truth (it carries
               primary + all secondaries as a comma-separated list). -->
        </div>

        ${_renderLandmarkVerificationSection(lm)}

        <div class="lm-drawer-section">
          <div class="lm-drawer-section-label">Profile <span class="lm-drawer-hint">(Claude-generated)</span></div>
          <div class="dbg-perspective-landmark-profile-row">
            <label class="lm-field-label">Typical operations</label>
            <div>${opsChips}</div>
          </div>
          <div class="dbg-perspective-landmark-profile-row">
            <label class="lm-field-label">Pitfalls</label>
            ${pitfallsList}
          </div>
          <div class="dbg-perspective-landmark-profile-row">
            <label class="lm-field-label">Expected content</label>
            <div>${expectedHtml}</div>
          </div>
          ${_renderActionEffectRow(idx, lm)}
        </div>

        <div class="lm-drawer-section">
          <div class="lm-drawer-section-label">Lifecycle</div>
          ${_renderLifecycleRow(idx, lm)}
        </div>
      </div>
    </div>`;
}

// v2.74.279 — Verification subsection. Renders matched count, ops
// allowed (substrate-derived from real capabilities), issues, sample
// HTML. Read-only display sourced from lm.verified. Empty section
// (returns nothing) when the landmark hasn't been verified yet.
function _renderLandmarkVerificationSection(lm) {
  const v = lm?.verified;
  if (!v) {
    return `<div class="lm-drawer-section">
      <div class="lm-drawer-section-label">Verification <span class="lm-drawer-hint">(read-only)</span></div>
      <div class="dbg-perspective-landmark-profile-empty">Not verified yet — click Pick or ✓ to verify against the live page.</div>
    </div>`;
  }
  const legacyOk = !v.score && typeof v.matchedCount === 'number' && v.matchedCount > 0;
  const effectiveScore = v.score ?? (legacyOk ? 'legacy' : null);
  const scoreLabel =
    effectiveScore === 'ready'    ? 'ready' :
    effectiveScore === 'caveats'  ? 'caveats' :
    effectiveScore === 'mismatch' ? 'mismatch' :
    effectiveScore === 'legacy'   ? 'verified (legacy)' : 'unverified';
  const matchLine = typeof v.matchedCount === 'number'
    ? `${v.matchedCount} element${v.matchedCount === 1 ? '' : 's'}`
    : '—';
  const verifiedTime = typeof v.verifiedAt === 'number'
    ? new Date(v.verifiedAt).toLocaleString()
    : '—';
  const opsAllowed = Array.isArray(v.operationsAllowed) && v.operationsAllowed.length > 0
    ? `<div class="lm-verif-ops">${v.operationsAllowed.map(o => `<code class="dbg-perspective-landmark-profile-chip">${escHtml(o)}</code>`).join(' ')}</div>`
    : '<span class="dbg-perspective-landmark-profile-empty">none</span>';
  const issuesList = Array.isArray(v.issues) && v.issues.length > 0
    ? `<ul class="dbg-perspective-landmark-issues">${v.issues.map(i => `<li>${escHtml(i)}</li>`).join('')}</ul>`
    : '<span class="dbg-perspective-landmark-profile-empty">none</span>';
  const sample = v.sampleHtml
    ? `<code class="dbg-perspective-landmark-sample">${escHtml(v.sampleHtml.slice(0, 200))}${v.sampleHtml.length > 200 ? '…' : ''}</code>`
    : '<span class="dbg-perspective-landmark-profile-empty">no sample captured</span>';
  return `
    <div class="lm-drawer-section">
      <div class="lm-drawer-section-label">Verification <span class="lm-drawer-hint">(read-only — re-run via ✓)</span></div>
      <div class="lm-verif-grid">
        <div class="lm-verif-key">Score</div>     <div class="lm-verif-val">${escHtml(scoreLabel)}</div>
        <div class="lm-verif-key">Matched</div>   <div class="lm-verif-val">${escHtml(matchLine)}</div>
        <div class="lm-verif-key">Verified at</div><div class="lm-verif-val">${escHtml(verifiedTime)}</div>
        <div class="lm-verif-key">Supports</div>  <div class="lm-verif-val">${opsAllowed}</div>
        <div class="lm-verif-key">Issues</div>    <div class="lm-verif-val">${issuesList}</div>
        <div class="lm-verif-key">Sample HTML</div><div class="lm-verif-val">${sample}</div>
      </div>
    </div>`;
}

// v2.74.268 — Lifecycle row in profile drawer. Shows current state +
// deprecate/restore action. Deprecation marks the landmark as
// obsolete; Phase 10.5 candidates already exclude deprecated
// landmarks from replacement options, so this acts as a "soft
// retire" — references continue to work but new authoring won't
// surface this landmark.
//
// Restore sets lifecycle back to 'fresh' (unverified) — the author
// can then click ✓ Verify to confirm and promote to 'verified'.
// Storing pre-deprecation state would tie us to extra storage; the
// re-verify path is simpler and more honest about the substrate's
// uncertainty after a restore.
function _renderLifecycleRow(idx, lm) {
  if (!lm?.uid) return '';   // un-persisted landmarks have no lifecycle yet
  const cur = lm.lifecycle ?? 'fresh';
  const stateLabel = {
    'fresh'           : 'fresh',
    'verified'        : 'verified',
    'stale-suspected' : 'stale-suspected',
    'stale-confirmed' : 'stale-confirmed',
    'deprecated'      : 'deprecated',
  }[cur] ?? cur;
  const stateClass = {
    'fresh'           : 'lifecycle-fresh',
    'verified'        : 'lifecycle-verified',
    'stale-suspected' : 'lifecycle-suspected',
    'stale-confirmed' : 'lifecycle-confirmed',
    'deprecated'      : 'lifecycle-deprecated',
  }[cur] ?? '';
  const actionBtn = cur === 'deprecated'
    ? `<button class="dbg-perspective-landmark-lifecycle-action dbg-perspective-landmark-lifecycle-restore" data-action="lifecycle-restore" data-idx="${idx}" type="button" title="Mark this landmark as fresh; click Verify to confirm it still works">Restore</button>`
    : `<button class="dbg-perspective-landmark-lifecycle-action dbg-perspective-landmark-lifecycle-deprecate" data-action="lifecycle-deprecate" data-idx="${idx}" type="button" title="Mark this landmark as obsolete. Existing references continue to work; new authoring won't surface it.">Deprecate</button>`;
  return `
    <div class="dbg-perspective-landmark-profile-row dbg-perspective-landmark-lifecycle-row">
      <label>Lifecycle <span class="dbg-perspective-landmark-profile-hint">(runtime health state)</span></label>
      <div class="dbg-perspective-landmark-lifecycle-row-body">
        <span class="dbg-perspective-landmark-lifecycle-chip-large ${stateClass}">${escHtml(stateLabel)}</span>
        ${actionBtn}
      </div>
    </div>`;
}

async function _setLandmarkLifecycle(idx, newLifecycle) {
  const lm = _perspectiveDraft?.landmarks?.[idx];
  if (!lm?.uid) return;
  if (newLifecycle === 'deprecated') {
    // Soft confirm — deprecation is reversible but warrants a moment
    // of friction so authors don't deprecate by accident.
    let impactSummary = '';
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ANALYZE_LANDMARK_IMPACT',
        payload: { uid: lm.uid, groundId: _perspectiveGroundId },
      });
      const impact = res?.impact;
      if (impact) {
        const consumers = (impact.fragments?.length ?? 0) + (impact.observations?.length ?? 0);
        if (consumers > 0) {
          impactSummary = `\n\n${consumers} downstream consumer${consumers === 1 ? '' : 's'} (${impact.fragments?.length ?? 0} fragment${(impact.fragments?.length ?? 0) === 1 ? '' : 's'}, ${impact.observations?.length ?? 0} observation${(impact.observations?.length ?? 0) === 1 ? '' : 's'}) currently reference this landmark. They will continue to work, but you should plan to migrate them.`;
        }
      }
    } catch { /* impact lookup is informational; proceed without */ }
    if (!confirm(`Deprecate landmark "${lm.accessibleName ?? lm.alias ?? lm.uid}"?\n\nDeprecation is a soft retire — existing references keep working, but the landmark won't surface in new authoring suggestions (Phase 10.5 candidates exclude deprecated landmarks).${impactSummary}\n\nReversible via the Restore button on the lifecycle row.`)) {
      return;
    }
  }
  const lifecycleBefore = lm.lifecycle ?? 'fresh';
  try {
    const res = await chrome.runtime.sendMessage({
      type   : 'UPDATE_LANDMARK',
      payload: { uid: lm.uid, patch: { lifecycle: newLifecycle } },
    });
    if (!res?.success) {
      showPerspectiveWarning(`Lifecycle update failed: ${res?.error ?? 'unknown'}`);
      return;
    }
    // Reflect in draft so the chip and lifecycle row update without a
    // full reload.
    _perspectiveDraft.landmarks[idx] = { ...lm, lifecycle: newLifecycle };
    renderPerspectiveLandmarks();
    Logger.info('perspective-capture', `Lifecycle ${lm.uid}: ${lifecycleBefore} → ${newLifecycle}`);
    // v2.74.269 — Emit landmark-lifecycle-changed for the substrate
    // event bus. Phase 8 declared this EVENT_KIND but until now
    // nothing emitted it — the verifier and runtime-recovery paths
    // emit specific resolution events instead. Deprecate/restore are
    // author-driven lifecycle transitions not covered by those, so
    // the dedicated event makes them visible in the events panel
    // and to future drift-history consumers.
    if (_perspectiveGroundId && lifecycleBefore !== newLifecycle) {
      chrome.runtime.sendMessage({
        type   : 'EMIT_GROUND_EVENT',
        payload: {
          groundId: _perspectiveGroundId,
          event   : {
            kind   : 'landmark-lifecycle-changed',
            uid    : lm.uid,
            details: {
              lifecycleBefore,
              lifecycleAfter: newLifecycle,
              trigger       : newLifecycle === 'deprecated' ? 'deprecate'
                            : lifecycleBefore === 'deprecated' ? 'restore'
                            : 'author-override',
            },
          },
        },
      }).catch(err => Logger.debug('perspective-capture', `lifecycle event emit failed: ${err.message}`));
    }
  } catch (e) {
    showPerspectiveWarning(`Lifecycle update failed: ${e.message}`);
  }
}

/**
 * v2.74.244 — Phase 6: action effect annotation row in the drawer.
 * Editable dropdown showing what the runtime should expect when an
 * Action targets this landmark. Heuristic-proposed at Pick time;
 * author can refine. Stored on landmark.actionEffect; surfaced by
 * the resolver (Phase 6.5) to detect drift via `action-effect-mismatch`.
 */
function _renderActionEffectRow(idx, lm) {
  // v2.74.305 — Phase 1 of ACTION_SPEC compliance. The previous single
  // dropdown that mixed substrate effects with DOM interaction patterns
  // is split into TWO controls per spec § 5:
  //   1. Effect (substrate-level, bounded 5-kind vocabulary, with
  //      structured parameters for opens-new-thread.form and
  //      triggers-modal.modalKind)
  //   2. Interaction pattern (our DOM-level pattern intel — separate
  //      from substrate effects)
  // Storage shape changed: lm.actionEffect (string) → lm.effect
  // (object) + lm.interactionPattern (string). Migration runs at
  // hydration in _hydrateLandmarkEffectShape.
  const effect = lm.effect ?? { kind: 'none' };
  const pattern = lm.interactionPattern ?? 'none';
  const opt = (val, label, selected) => `<option value="${escAttr(val)}" ${selected ? 'selected' : ''}>${escHtml(label)}</option>`;

  // Effect kind picker.
  const effectKind = effect.kind ?? 'none';
  const effectKindControl = `
    <select class="dbg-perspective-landmark-profile-effect" data-action="profile-effect-kind-edit" data-idx="${idx}">
      ${opt('none',                'none — no substrate-level effect (default)',          effectKind === 'none')}
      ${opt('triggers-navigation', 'triggers-navigation — clicking changes the URL',      effectKind === 'triggers-navigation')}
      ${opt('opens-new-thread',    'opens-new-thread — new tab / window / popup',         effectKind === 'opens-new-thread')}
      ${opt('triggers-modal',      'triggers-modal — BROWSER alert/confirm/prompt',       effectKind === 'triggers-modal')}
      ${opt('triggers-download',   'triggers-download — file download initiates',         effectKind === 'triggers-download')}
    </select>`;

  // Conditional parameter pickers — only rendered for the kinds that
  // need them. form for opens-new-thread, modalKind for triggers-modal.
  let effectParamControl = '';
  if (effectKind === 'opens-new-thread') {
    const form = effect.form ?? 'tab';
    effectParamControl = `
      <select class="dbg-perspective-landmark-profile-effect-param" data-action="profile-effect-form-edit" data-idx="${idx}" title="opens-new-thread.form (ACTION_SPEC § 5)">
        ${opt('tab',     'tab — new browser tab',     form === 'tab')}
        ${opt('window',  'window — new browser window', form === 'window')}
        ${opt('popup',   'popup — window.open popup',   form === 'popup')}
        ${opt('sidebar', 'sidebar — side panel',        form === 'sidebar')}
      </select>`;
  } else if (effectKind === 'triggers-modal') {
    const modalKind = effect.modalKind ?? 'confirm';
    effectParamControl = `
      <select class="dbg-perspective-landmark-profile-effect-param" data-action="profile-effect-modal-kind-edit" data-idx="${idx}" title="triggers-modal.modalKind (ACTION_SPEC § 5)">
        ${opt('alert',   'alert — window.alert() dialog',     modalKind === 'alert')}
        ${opt('confirm', 'confirm — window.confirm() dialog', modalKind === 'confirm')}
        ${opt('prompt',  'prompt — window.prompt() dialog',   modalKind === 'prompt')}
      </select>`;
  }

  // Interaction pattern picker (separate, our addition).
  const patternControl = `
    <select class="dbg-perspective-landmark-profile-pattern" data-action="profile-pattern-edit" data-idx="${idx}">
      ${opt('none',              'none — no recognized pattern',                          pattern === 'none')}
      ${opt('opens-menu',        'opens-menu — dropdown / listbox / popup / DOM dialog',  pattern === 'opens-menu')}
      ${opt('switches-tab',      'switches-tab — tab strip selection changes content',    pattern === 'switches-tab')}
      ${opt('toggles-expansion', 'toggles-expansion — accordion / disclosure widget',     pattern === 'toggles-expansion')}
      ${opt('toggles-state',     'toggles-state — checkbox / radio / switch',             pattern === 'toggles-state')}
      ${opt('submits-in-place',  'submits-in-place — form submit without navigation',     pattern === 'submits-in-place')}
      ${opt('mutates-page',      'mutates-page — in-page update (catch-all)',             pattern === 'mutates-page')}
    </select>`;

  // v2.74.309 — Phase 6: effect source badge. Shows where the current
  // effect value came from so the author can judge how much to trust
  // it (heuristic = rule-based guess; claude = LLM proposal; authored
  // = you set it; observed = confirmed by a real run).
  const source = lm.effectSource ?? null;
  const SOURCE_META = {
    heuristic: { label: 'heuristic', title: 'Rule-based proposal from the element’s ARIA / tag signals. A guess — confirm by running the action.' },
    claude   : { label: 'Claude',    title: 'Proposed by Claude from the DOM + screenshot. A guess — confirm by running the action.' },
    authored : { label: 'you set this', title: 'You chose this value manually. Takes precedence over heuristic / Claude proposals on re-Pick.' },
    observed : { label: 'observed',  title: 'Confirmed by runtime observation of an actual run.' },
  };
  const sourceBadge = source && SOURCE_META[source]
    ? ` <span class="lm-effect-source lm-effect-source-${escAttr(source)}" title="${escAttr(SOURCE_META[source].title)}">${escHtml(SOURCE_META[source].label)}</span>`
    : '';

  return `
    <div class="dbg-perspective-landmark-profile-row">
      <label>Effect <span class="dbg-perspective-landmark-profile-hint">(substrate-level browser effect — ACTION_SPEC § 5)</span>${sourceBadge}</label>
      ${effectKindControl}
      ${effectParamControl}
    </div>
    <div class="dbg-perspective-landmark-profile-row">
      <label>Interaction pattern <span class="dbg-perspective-landmark-profile-hint">(DOM-level interaction shape — authoring intel only)</span></label>
      ${patternControl}
    </div>`;
}

// v2.74.238 — Helpers used by the drawer.
function _selectorTail(sel) {
  const parts = String(sel ?? '').split(/[\s>+~]/).filter(Boolean);
  return parts[parts.length - 1] ?? sel;
}
function _truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ─── v2.74.233 — Claude-integrated picker for perspective landmarks ────────────
//
// New picker flow (replaces the standalone "Ask Claude" button):
//   1. Author types a role in the landmark row.
//   2. Click Pick → role required check.
//   3. Picker arms on the page; user clicks an element.
//   4. PICK_RESULT arrives with the picker's selector + frameUrl.
//   5. Sidepanel sets the landmark as "refining" so the UI shows
//      progress, then:
//      a. Runs INSPECT_ELEMENT against the picker's selector to get
//         rich DOM context (outerHTML + parent + sibling tags + rect).
//      b. Captures a screenshot of the element region via
//         chrome.tabs.captureVisibleTab + canvas crop (top-frame
//         elements only — iframe element rects don't map to the
//         viewport coordinates captureVisibleTab returns).
//      c. Forwards role (intent) + DOM context + screenshot to Claude
//         via ASK_CLAUDE_FOR_SELECTOR_BG.
//   6. Claude returns a refined selector — store it as the landmark's
//      selector. If Claude fails, keep the picker's selector as a
//      fallback so the author can still verify / hand-edit.
//   7. Auto-verify and refresh on-page overlays.
//
// Authors get one click → a stable selector, with visual confirmation
// baked into the model's reasoning.

/**
 * Capture a cropped screenshot of the picked element's region. Best-
 * effort: returns null on any failure. Top-frame elements only —
 * iframe rects don't translate to viewport coordinates without
 * knowing the iframe's offset (could be added later but skipped for
 * v1).
 *
 * @param {number} tabId
 * @param {object} rect    { x, y, width, height } from getBoundingClientRect
 * @param {string} frame   'top' | 'iframe — <url>' as reported by Inspect
 * @returns {Promise<string|null>}  base64 data URL or null
 */
/**
 * v2.74.293 — Re-encode a PNG data URL to JPEG at a moderate quality
 * setting for compact persistence. The Claude API call uses the
 * original PNG (sharper, no compression artifacts); only the persisted
 * copy goes through this so the in-flight quality isn't degraded.
 *
 * Returns the compressed data URL, or the original on any error
 * (caller can always store SOMETHING rather than nothing).
 */
async function _compressScreenshotForStorage(pngDataUrl) {
  try {
    if (!pngDataUrl || typeof pngDataUrl !== 'string') return pngDataUrl;
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('decode failed'));
      img.src = pngDataUrl;
    });
    // Cap the long edge at 1200 px. Original captures can be 2400+ px
    // wide on hi-DPI displays; that's overkill for a review thumbnail
    // and bloats storage. Maintain aspect ratio.
    const MAX_EDGE = 1200;
    const longEdge = Math.max(img.width, img.height);
    const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (e) {
    Logger.warn('perspective-capture', `_compressScreenshotForStorage failed: ${e.message} — storing original PNG`);
    return pngDataUrl;
  }
}

/**
 * v2.74.293 — Open a data URL in a new browser tab. Chrome MV3 blocks
 * `chrome.tabs.create({url: 'data:...'})` directly — the navigation is
 * silently dropped. The workaround: convert the data URL to a blob,
 * mint a blob: URL with URL.createObjectURL, and open THAT. Blob URLs
 * are first-class navigation targets even in MV3.
 *
 * Best-effort; logs and stays silent on failure (the screenshot can
 * always be re-Pick'd if the open fails).
 */
async function _openScreenshotInNewTab(dataUrl) {
  if (!dataUrl) return;
  try {
    // Convert data URL → blob via fetch (browser-built-in; no manual
    // base64 decoding needed). This works in sidepanel context.
    const res  = await fetch(dataUrl);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    await chrome.tabs.create({ url: blobUrl, active: true });
    // We don't revoke the blob URL — Chrome handles the lifetime once
    // the tab owns it; revoking too early breaks the new tab's image.
    // Memory cost is small (the blob is GC'd when the tab closes).
  } catch (e) {
    Logger.warn('perspective-capture', `_openScreenshotInNewTab failed: ${e.message}`);
  }
}

/**
 * v2.74.298 — Capture BOTH the tight thumbnail (drawer-displayed,
 * matches the picker overlay 1:1) AND a wider context shot for Claude
 * with the picked element highlighted by a red box. One captureVisibleTab
 * call, two crops on the same source image.
 *
 * Returns { thumb, contextShot, contextRect } where:
 *   - thumb        — tight crop matching the picker overlay (1:1).
 *                    Drawer thumbnail / what the user sees.
 *   - contextShot  — wider crop showing the picked element plus
 *                    surrounding chrome (target ±300px CSS each side,
 *                    viewport-clamped), with a red rectangle drawn on
 *                    top of the picked element's region. Used by
 *                    Claude for visual reasoning about siblings,
 *                    labels, and disambiguators. Never shown to the
 *                    user — internal Claude payload only.
 *   - contextRect  — the CSS-pixel rect of the contextShot region
 *                    relative to the viewport. Useful for logs and
 *                    future expansion.
 * Either value is null when capture / crop fails; the caller proceeds
 * with whatever is available.
 */
async function _captureLandmarkScreenshots(tabId, rect, frame, viewportInfo = null) {
  const inputSummary = {
    tabId,
    rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
    frame: frame ?? null,
    viewportInfo,
  };
  const FAIL = { thumb: null, contextShot: null, contextRect: null };
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    Logger.info('perspective-capture', `screenshot: SKIP (no rect or zero-sized)`, inputSummary);
    return FAIL;
  }
  if (typeof frame === 'string' && frame.startsWith('iframe')) {
    Logger.info('perspective-capture', `screenshot: SKIP (iframe element — cross-frame coord translation not yet implemented)`, inputSummary);
    return FAIL;
  }
  try {
    const tabInfo = await chrome.tabs.get(tabId);
    const windowId = tabInfo?.windowId;
    if (typeof windowId !== 'number') {
      Logger.info('perspective-capture', `screenshot: SKIP (no windowId for tab)`, inputSummary);
      return FAIL;
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    if (!dataUrl) {
      Logger.info('perspective-capture', `screenshot: SKIP (captureVisibleTab returned empty)`, inputSummary);
      return FAIL;
    }
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = dataUrl;
    });
    const dpr = (typeof viewportInfo?.dpr === 'number' && viewportInfo.dpr > 0) ? viewportInfo.dpr : 1;
    const vw  = (typeof viewportInfo?.viewportWidth  === 'number' && viewportInfo.viewportWidth  > 0) ? viewportInfo.viewportWidth  : Math.round(img.width  / dpr);
    const vh  = (typeof viewportInfo?.viewportHeight === 'number' && viewportInfo.viewportHeight > 0) ? viewportInfo.viewportHeight : Math.round(img.height / dpr);

    // ── Crop 1: tight thumbnail (matches overlay 1:1) ─────────────
    const tightX = Math.max(0, Math.round(rect.x * dpr));
    const tightY = Math.max(0, Math.round(rect.y * dpr));
    const tightW = Math.min(img.width  - tightX, Math.round(rect.width  * dpr));
    const tightH = Math.min(img.height - tightY, Math.round(rect.height * dpr));
    let thumb = null;
    if (tightW > 0 && tightH > 0) {
      const tc = document.createElement('canvas');
      tc.width = tightW;
      tc.height = tightH;
      tc.getContext('2d').drawImage(img, tightX, tightY, tightW, tightH, 0, 0, tightW, tightH);
      thumb = tc.toDataURL('image/png');
    } else {
      Logger.info('perspective-capture', `screenshot: tight crop yielded non-positive dimensions`, { ...inputSummary, tightX, tightY, tightW, tightH });
    }

    // ── Crop 2: context shot for Claude (with highlight box) ──────
    // CSS-pixel context rect: pickedRect ± 300px each side, clamped
    // to the viewport. Asymmetric? No — sibling labels can sit on
    // any side. 300px is enough to capture group titles, sibling
    // chips, sticky-bar boundaries. Bounded by viewport so we don't
    // wander outside captured pixels.
    const CTX_PAD = 300;
    const ctxXcss = Math.max(0,  rect.x - CTX_PAD);
    const ctxYcss = Math.max(0,  rect.y - CTX_PAD);
    const ctxRcss = Math.min(vw, rect.x + rect.width  + CTX_PAD);
    const ctxBcss = Math.min(vh, rect.y + rect.height + CTX_PAD);
    const ctxWcss = ctxRcss - ctxXcss;
    const ctxHcss = ctxBcss - ctxYcss;
    const ctxX = Math.round(ctxXcss * dpr);
    const ctxY = Math.round(ctxYcss * dpr);
    const ctxW = Math.min(img.width  - ctxX, Math.round(ctxWcss * dpr));
    const ctxH = Math.min(img.height - ctxY, Math.round(ctxHcss * dpr));
    let contextShot = null;
    let contextRect = null;
    if (ctxW > 0 && ctxH > 0) {
      const cc = document.createElement('canvas');
      cc.width = ctxW;
      cc.height = ctxH;
      const cctx = cc.getContext('2d');
      cctx.drawImage(img, ctxX, ctxY, ctxW, ctxH, 0, 0, ctxW, ctxH);
      // Highlight box: pickedRect in crop-local image coordinates.
      // Picked rect in image px: (rect.x*dpr, rect.y*dpr, rect.w*dpr, rect.h*dpr).
      // Subtract the context crop's image origin (ctxX, ctxY).
      const hlX = Math.round(rect.x * dpr) - ctxX;
      const hlY = Math.round(rect.y * dpr) - ctxY;
      const hlW = Math.round(rect.width  * dpr);
      const hlH = Math.round(rect.height * dpr);
      // Bright red, semi-transparent fill + solid border. Stroke width
      // scales with DPR so hi-DPI captures don't get hairline borders.
      cctx.lineWidth   = Math.max(2, Math.round(2 * dpr));
      cctx.strokeStyle = 'rgba(239, 68, 68, 1.0)';     // red-500
      cctx.fillStyle   = 'rgba(239, 68, 68, 0.18)';
      cctx.fillRect(hlX, hlY, hlW, hlH);
      cctx.strokeRect(hlX + 0.5, hlY + 0.5, hlW - 1, hlH - 1);
      // JPEG at quality 0.85 for compact transmission to Claude.
      contextShot = cc.toDataURL('image/jpeg', 0.85);
      contextRect = { x: ctxXcss, y: ctxYcss, width: ctxWcss, height: ctxHcss };
    } else {
      Logger.info('perspective-capture', `screenshot: context crop yielded non-positive dimensions`, { ...inputSummary, ctxX, ctxY, ctxW, ctxH });
    }

    Logger.info('perspective-capture', `screenshot: OK (thumb ${tightW}×${tightH}, context ${ctxW}×${ctxH} px, dpr=${dpr}, thumb b64=${thumb?.length ?? 0}, context b64=${contextShot?.length ?? 0})`, {
      ...inputSummary,
      contextRect,
    });
    return { thumb, contextShot, contextRect };
  } catch (e) {
    Logger.warn('perspective-capture', `screenshot: THROW — ${e.message}`, inputSummary);
    return FAIL;
  }
}

/**
 * v2.74.298 — Rectangle Intersection-over-Union for two CSS-pixel rects.
 * Used to verify Claude-proposed selectors land on the picker's
 * actually-clicked element (rect overlap ≥80% means same element).
 */
function _computeIoU(a, b) {
  if (!a || !b) return 0;
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(ax2, bx2);
  const y2 = Math.min(ay2, by2);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

// v2.74.298 — Legacy alias retained so any pre-refactor call sites still
// resolve. Returns just the tight thumb (the original contract). New
// callers should use _captureLandmarkScreenshots which returns both.
async function _capturePickedElementScreenshot(tabId, rect, frame, selector = '', viewportInfo = null) {
  // v2.74.291 — Diagnostic logging at every drop path. Every return-null
  // emits a Logger.info with a reason code and the inputs that triggered
  // it. Search for "screenshot:" in Logs to follow the path.
  // v2.74.296 — Rect is now the picker's authoritative rect (passed
  // directly from PICK_RESULT, not re-resolved via selector). The
  // pre-supplied viewportInfo carries the page's DPR. scrollIntoView
  // and re-Inspect were removed: the picker just clicked this element,
  // it's in the viewport, and the rect is unambiguous.
  const inputSummary = {
    tabId,
    rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
    frame: frame ?? null,
    selector: (selector || '').slice(0, 120),
    viewportInfo,
  };

  if (!rect || rect.width <= 0 || rect.height <= 0) {
    Logger.info('perspective-capture', `screenshot: SKIP (no rect or zero-sized)`, inputSummary);
    return null;
  }
  // Iframe rects are local to the iframe document; without translating
  // to the top-frame viewport we'd crop the wrong area. Skip for v1.
  if (typeof frame === 'string' && frame.startsWith('iframe')) {
    Logger.info('perspective-capture', `screenshot: SKIP (iframe element — cross-frame coord translation not yet implemented)`, inputSummary);
    return null;
  }
  try {
    const tabInfo = await chrome.tabs.get(tabId);
    const windowId = tabInfo?.windowId;
    if (typeof windowId !== 'number') {
      Logger.info('perspective-capture', `screenshot: SKIP (no windowId for tab)`, inputSummary);
      return null;
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    if (!dataUrl) {
      Logger.info('perspective-capture', `screenshot: SKIP (captureVisibleTab returned empty)`, inputSummary);
      return null;
    }
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = dataUrl;
    });

    // v2.74.296 — Use the rect directly. No scroll, no re-Inspect.
    // The picker just clicked this element; its rect is the source
    // of truth. If by some race the element scrolled off between
    // PICK_RESULT and capture, the crop math will return non-positive
    // dimensions and we log + return null cleanly.
    const liveRect = rect;
    const liveViewportInfo = viewportInfo;
    const reportDpr = (typeof liveViewportInfo?.dpr === 'number' && liveViewportInfo.dpr > 0)
      ? liveViewportInfo.dpr
      : 1;
    const scale = reportDpr;
    const x = Math.max(0, Math.round(liveRect.x      * scale));
    const y = Math.max(0, Math.round(liveRect.y      * scale));
    const w = Math.min(img.width  - x, Math.round(liveRect.width  * scale));
    const h = Math.min(img.height - y, Math.round(liveRect.height * scale));
    if (w <= 0 || h <= 0) {
      Logger.info('perspective-capture', `screenshot: SKIP (crop math yielded non-positive dimensions — element off-viewport?)`, {
        ...inputSummary,
        liveRect,
        img: { w: img.width, h: img.height },
        scale, x, y, w, h,
      });
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
    const out = canvas.toDataURL('image/png');
    // v2.74.295 — Log CSS and image-pixel dims plus DPR. Crop now equals
    // the element rect 1:1 (no padding), so the CSS dims should match
    // the rect exactly — easy to verify against what the picker overlay
    // showed.
    const cssW = Math.round(w / scale);
    const cssH = Math.round(h / scale);
    Logger.info('perspective-capture', `screenshot: OK CSS=${cssW}×${cssH} px (matches overlay) / image=${w}×${h} px (dpr=${scale}, base64 length=${out.length})`, {
      ...inputSummary,
      liveRect,
      liveViewportInfo,
      scale,
    });
    return out;
  } catch (e) {
    Logger.warn('perspective-capture', `screenshot: THROW — ${e.message}`, inputSummary);
    return null;
  }
}

/**
 * v2.74.233 — Refine the picker's raw selector via Claude (DOM
 * context + role + cropped screenshot). On success, replaces the
 * landmark's selector with Claude's; on failure, keeps the picker's
 * selector. Auto-verifies either way.
 */
async function _refineLandmarkSelectorWithClaude(landmarkIdx, pickContext = {}) {
  if (!_perspectiveDraft?.landmarks?.[landmarkIdx]) return;
  const lm = _perspectiveDraft.landmarks[landmarkIdx];
  const pickerSelector = (lm.selector ?? '').toString().trim();
  // v2.74.296 — pickContext carries the picker's authoritative rect
  // (from elementFromPoint at click time) + page DPR + (v2.74.299)
  // a11y profile of the clicked element. Used by the screenshot
  // helper to crop exactly the overlay region regardless of whether
  // the selector resolves uniquely, and by the geometric verification
  // gate to compare Claude-proposed selectors against the authoritative
  // clicked-element UID (not the wrong-element UID that came back from
  // INSPECT_ELEMENT on the ambiguous picker selector).
  const pickedRectFromPicker = pickContext?.pickedRect ?? null;
  const pickViewportInfo     = pickContext?.viewportInfo ?? null;
  const pickedAprofFromPicker = pickContext?.pickedAccessibilityProfile ?? null;
  if (!pickerSelector) {
    _landmarkRefining.delete(landmarkIdx);
    renderPerspectiveLandmarks();
    return;
  }

  // Resolve iframe frameId for Inspect dispatch.
  let frameId = 0;
  if (lm.frameUrl) {
    try {
      const frames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId: _perspectiveTabId }, (fs) => resolve(fs ?? []));
      });
      const exact = frames.find(f => f && f.url === lm.frameUrl);
      if (exact) frameId = exact.frameId;
    } catch { /* fall through to top frame */ }
  }

  _landmarkRefining.set(landmarkIdx, 'Inspecting picked element…');
  renderPerspectiveLandmarks();

  let inspectRes;
  try {
    inspectRes = await chrome.tabs.sendMessage(
      _perspectiveTabId,
      { type: 'INSPECT_ELEMENT', payload: { target: pickerSelector, pickLast: false } },
      { frameId },
    );
  } catch (e) {
    // Fall back to picker's selector + auto-verify; user can hand-edit.
    _landmarkRefining.delete(landmarkIdx);
    Logger.warn('perspective-capture', `Pick→Claude refinement inspect dispatch failed: ${e.message} (keeping picker selector)`);
    renderPerspectiveLandmarks();
    verifyPerspectiveLandmark(landmarkIdx);
    return;
  }
  if (!inspectRes?.success) {
    _landmarkRefining.delete(landmarkIdx);
    Logger.warn('perspective-capture', `Pick→Claude refinement inspect failed: ${inspectRes?.error} (keeping picker selector)`);
    renderPerspectiveLandmarks();
    verifyPerspectiveLandmark(landmarkIdx);
    return;
  }
  const report = inspectRes.report ?? {};

  _landmarkRefining.set(landmarkIdx, 'Capturing screenshot…');
  renderPerspectiveLandmarks();
  // v2.74.298 — Two-screenshot capture: tight thumb for the drawer
  // (WYSIWYG with overlay) + wider context shot with highlight box for
  // Claude (visual disambiguation). Uses the picker's authoritative
  // rect (from elementFromPoint at click time), so capture is unambiguous
  // even when the structural selector resolves to multiple elements.
  const cropRect = pickedRectFromPicker || report.rect;
  const { thumb: thumbScreenshot, contextShot, contextRect } =
    await _captureLandmarkScreenshots(_perspectiveTabId, cropRect, report.frame, pickViewportInfo);

  // v2.74.298 — Ambiguity detection. Re-Inspect the picker selector
  // with no pickLast to learn how many elements it matches on the live
  // DOM. If >1, we tell Claude the selector is ambiguous and ask for
  // disambiguation using the highlighted region in the context shot.
  // v2.74.299 — pickerClickedUid now comes from the PICKER (the a11y
  // profile of the literally-clicked element), NOT from INSPECT on the
  // selector. The INSPECT-derived UID would be wrong when the selector
  // is ambiguous (returns the first match, possibly not the picked one).
  // The picker's profile is the authoritative identity.
  let pickerMatchCount = report.matchCount ?? 1;
  const pickerClickedUid = pickedAprofFromPicker?.uid
    ?? report.accessibilityProfile?.uid
    ?? null;
  try {
    const ambigueProbe = await chrome.tabs.sendMessage(
      _perspectiveTabId,
      { type: 'INSPECT_ELEMENT', payload: { target: pickerSelector, pickLast: false } },
      { frameId },
    );
    if (ambigueProbe?.success && ambigueProbe.report) {
      pickerMatchCount = ambigueProbe.report.matchCount ?? pickerMatchCount;
    }
  } catch { /* fall back to original report.matchCount */ }

  Logger.info('perspective-capture', `Pick→Claude screenshot result`, {
    landmarkIdx,
    pickerSelector,
    pickerMatchCount,
    pickerAmbiguous: pickerMatchCount > 1,
    pickerClickedUid,
    rectSource: pickedRectFromPicker ? 'picker (authoritative)' : 'inspect-fallback',
    cropRect,
    contextRect,
    frame: report.frame,
    dpr: pickViewportInfo?.dpr ?? null,
    thumbScreenshot: thumbScreenshot ? `data URL (${thumbScreenshot.length} chars)` : 'null',
    contextShot    : contextShot     ? `data URL (${contextShot.length} chars)`     : 'null',
  });
  // For backwards compat with the existing identifier `screenshot` used
  // by the persistence path below. The wider context shot goes to Claude
  // separately via the GENERATE_LANDMARK_PROFILE_BG payload.
  const screenshot = thumbScreenshot;

  // v2.74.242 — Phase 4 of substrate spec: existing-landmark match.
  // After INSPECT computes the accessibility profile (Phase 1) and
  // the canonical UID, check the per-Ground registry to see if a
  // landmark with this UID already exists. If found AND its
  // lifecycle is fresh/verified, reuse it — skip the Claude call,
  // hydrate the in-memory landmark from the registry record, toast
  // the author. This is the SSOT win: pick the "same" element on
  // the same page, get the same landmark every time, automatically.
  //
  // When the existing record is stale-suspected/stale-confirmed/
  // deprecated, we proceed with Claude refinement — the cached
  // record may carry a broken selector that the new pick can
  // refresh (registry overwrites by UID on save).
  const aprofForMatch = report.accessibilityProfile;
  if (aprofForMatch?.uid && aprofForMatch.isCanonical) {
    try {
      const existingRes = await chrome.runtime.sendMessage({
        type: 'GET_LANDMARK',
        payload: { uid: aprofForMatch.uid },
      });
      const existing = existingRes?.success ? existingRes.landmark : null;
      // v2.74.340 — Only reuse a registry landmark that belongs to the
      // CURRENT ground. GET_LANDMARK is a global by-UID lookup, so it can
      // return a landmark orphaned from a deleted/other ground (same element
      // → same canonical UID). Reusing that cross-ground record would (a) hit
      // the alias-restore gap and (b) throw at SAVE_LANDMARK's groundId guard
      // ("cannot reassign to ground"). Falling through to Claude refinement
      // instead mints a fresh per-ground record. (Re-homing orphaned
      // landmarks into a new ground — GROUND_SPEC § 11's reuse case — is a
      // separate future affordance.)
      const reusable = existing
        && existing.groundId === _perspectiveGroundId
        && (existing.lifecycle === 'fresh' || existing.lifecycle === 'verified');
      if (existing && reusable) {
        Logger.info('perspective-capture', `Existing landmark matched on UID — reusing [landmarkIdx=${landmarkIdx}]`, {
          uid          : existing.uid,
          alias        : existing.alias,
          accessibleName: existing.accessibleName,
          lifecycle    : existing.lifecycle,
        });
        // Hydrate the in-memory landmark from the registry. The
        // author's typed `role` field stays (their semantic intent
        // may differ from what the registry stored); everything
        // else comes from the registry record so re-saves don't
        // create divergence.
        lm.uid                 = existing.uid;
        lm.isCanonical         = existing.isCanonical === true;
        lm.a11yRole            = existing.a11yRole;
        lm.accessibleName      = existing.accessibleName;
        lm.hierarchicalContext = existing.hierarchicalContext;
        lm.canonicalUrl        = existing.canonicalUrl;
        lm.derivationInputs    = existing.derivationInputs;
        lm.selector            = existing.selector;
        if (existing.frameUrl) lm.frameUrl = existing.frameUrl;
        if (!lm.description)      lm.description       = existing.description ?? '';
        // v2.74.340 — Restore the PRIMARY alias from the registry record.
        // This reuse path historically restored only `aliases` (secondaries)
        // — a leftover from the role→alias rename (v2.74.275) — leaving a
        // reused landmark with an empty primary `alias`, which failed save
        // validation ("needs an alias") even though the alias field showed
        // the secondaries. (Triggers when a pick matches an orphaned registry
        // landmark preserved across a ground delete, per GROUND_SPEC § 11.)
        if (!lm.alias?.trim()) {
          if (existing.alias && existing.alias.trim()) {
            lm.alias = existing.alias;
          } else if (Array.isArray(existing.aliases) && existing.aliases.length) {
            // Edge: stored primary empty but secondaries present → promote first.
            lm.alias   = existing.aliases[0];
            lm.aliases = existing.aliases.slice(1);
          }
        }
        if (!lm.aliases?.length)  lm.aliases           = Array.isArray(existing.aliases) ? existing.aliases.slice() : [];
        if (!lm.operationsCommon?.length) lm.operationsCommon = Array.isArray(existing.operationsCommon) ? existing.operationsCommon.slice() : [];
        if (!lm.pitfalls?.length)         lm.pitfalls         = Array.isArray(existing.pitfalls) ? existing.pitfalls.slice() : [];
        if (!lm.expectedContent)          lm.expectedContent  = existing.expectedContent ?? null;
        if (typeof lm.profileConfidence !== 'number') lm.profileConfidence = existing.profileConfidence ?? null;
        lm.lifecycle = existing.lifecycle;
        lm.verified  = existing.verified ?? null;
        _landmarkRefining.delete(landmarkIdx);
        _landmarkProfileExpanded.add(landmarkIdx);   // auto-expand to show what was reused
        toast?.(`Reused existing landmark "${existing.accessibleName ?? existing.alias ?? existing.uid}" from registry`);
        renderPerspectiveLandmarks();
        updatePerspectiveSaveButtonState();
        _refreshPerspectiveOverlays();
        return;   // skip Claude — we already have the full record
      }
      if (existing && !reusable) {
        Logger.info('perspective-capture', `Existing landmark matched but lifecycle="${existing.lifecycle}" — refreshing via Claude [uid=${existing.uid}]`);
      }
    } catch (e) {
      Logger.warn('perspective-capture', `existing-landmark match check failed (proceeding with Claude): ${e.message}`);
    }
  }

  _landmarkRefining.set(landmarkIdx, 'Asking Claude to generate landmark profile…');
  renderPerspectiveLandmarks();

  // v2.74.235 — Wave 2: one Claude call returns the FULL profile, not
  // just the refined selector. Description, aliases, common ops,
  // pitfalls, expected content all come back together. Rule-derived
  // capabilities + operationsAllowed are sent in so Claude can ground
  // operationsCommon in the actual allowlist (no hallucinating ops
  // the element can't actually support).
  const capsForPrompt = deriveCapabilities(report);
  const opsForPrompt  = deriveAllowedOperations(capsForPrompt);

  let claudeRes;
  try {
    claudeRes = await chrome.runtime.sendMessage({
      type: 'GENERATE_LANDMARK_PROFILE_BG',
      payload: {
        role                  : (lm.alias ?? '').toString().trim() || 'landmark',
        currentSelector       : pickerSelector,
        fingerprint           : {
          tag          : report.tag,
          inputType    : report.inputType,
          ariaRole     : report.ariaRole,
          ariaLabel    : report.ariaLabel,
          capabilities : capsForPrompt,
        },
        outerHTMLPreview      : report.outerHTMLPreview ?? '',
        parentOuterHTMLPreview: report.parent?.outerHTMLPreview ?? '',
        frame                 : report.frame ?? 'top',
        matchedCount          : pickerMatchCount,
        // v2.74.298 — Send the WIDER context shot to Claude (with red
        // highlight rectangle drawn on the picked element). Falls back
        // to the tight thumb if context capture failed. Claude can do
        // visual selector reasoning from the context shot; thumb-only
        // means "what you see is the whole thing."
        screenshotDataUrl     : contextShot || screenshot,
        operationsAllowed     : opsForPrompt,
      },
    });
  } catch (e) {
    _landmarkRefining.delete(landmarkIdx);
    Logger.warn('perspective-capture', `Pick→Claude profile dispatch failed: ${e.message} (keeping picker selector)`);
    renderPerspectiveLandmarks();
    verifyPerspectiveLandmark(landmarkIdx);
    return;
  }

  _landmarkRefining.delete(landmarkIdx);

  if (claudeRes?.success && claudeRes.profile?.selector) {
    const p = claudeRes.profile;
    // v2.74.239 — Phase 1 of the landmark substrate spec. The
    // Inspect report's accessibilityProfile carries the canonical
    // identity inputs (a11y role, accessible name, hierarchical
    // context, canonical URL) AND the derived UID. Persist them on
    // the landmark so Phase 2 (per-Ground registry) can migrate
    // existing records without re-deriving from the live page.
    //
    // These fields sit alongside the existing free-form `role` /
    // `description` for Phase 1 — the migration to a11y-role-as-
    // role + accessibleName-as-display-label is a Phase 3 UI change.
    // v2.74.299 — Prefer the picker's authoritative profile (computed
    // at click time from the actually-clicked element) over the
    // INSPECT-derived one (which uses the picker's selector and can
    // return the wrong element when the selector is ambiguous). Falls
    // back to the INSPECT profile if the picker didn't ship one
    // (older content script during upgrade, or computeAccessibilityProfile
    // threw on exotic DOM).
    const aprof = pickedAprofFromPicker ?? report?.accessibilityProfile ?? null;
    // v2.74.288 — Picker-wins-Claude-can-challenge selector authority.
    // Previously Claude's selector unconditionally replaced the picker's;
    // that's how `button:has(span.label--MoICp:text-is('All images'))`
    // ended up overwriting a perfectly stable structural selector.
    //
    // Decision rule:
    //   1. If Claude's selector EQUALS picker's (string match) → no-op,
    //      record as not-challenged for the log.
    //   2. Else classify both via classifySelectorTier. If Claude's
    //      tier is NOT strictly lower (= NOT strictly more stable) than
    //      picker's, reject Claude's selector and keep picker's.
    //   3. If Claude's tier IS strictly lower, re-Inspect with Claude's
    //      selector to verify it (a) resolves uniquely and (b) lands on
    //      the SAME element (UID match). Only adopt on full verification.
    //
    // Rationale: the picker already ran the rule-based ladder and
    // produced a verified, valid CSS selector. Claude's value-add in
    // Wave 2 is the narrative profile (description / aliases /
    // pitfalls / ops / expectedContent), not the selector. If Claude
    // CAN spot a stronger discriminator the picker missed, great —
    // but the burden of proof is on the challenger.
    // v2.74.298 — Geometric verification replaces tier comparison.
    //
    // Pre-fix the substrate accepted Claude's selector only when its
    // discriminator-tier was STRICTLY better than the picker's
    // (classifySelectorTier comparison). That gate was selector-text-
    // shaped and couldn't reward Claude for visual reasoning — if
    // Claude looked at the highlight box and proposed something with
    // a `:nth-of-type` (tier 6) when the picker had a `tag.class`
    // chain (tier 5), the proposal got rejected as "not strictly
    // stronger" even though it was the only one that actually
    // uniquely identified the right element.
    //
    // New gate: accept Claude's selector IFF
    //   (a) it resolves to exactly one element on the live DOM
    //   (b) that element's bounding rect overlaps the picker's
    //       pickedRect with IoU ≥ 0.8, OR its a11y UID matches the
    //       picker's clicked-element UID.
    // Tier is preserved as an informational field in the log but no
    // longer gates the decision.
    const pickerTier            = classifySelectorTier(pickerSelector);
    const claudeTier            = classifySelectorTier(p.selector);
    const selectorEqualsPicker  = p.selector === pickerSelector;

    let adoptClaudeSelector = false;
    let challengeOutcome    = 'kept-picker';
    let claudeRect          = null;
    let claudeMatchCount    = null;
    let claudeUid           = null;
    let iou                 = 0;
    let uidMatches          = false;

    if (selectorEqualsPicker) {
      challengeOutcome = 'no-challenge (Claude echoed picker)';
    } else {
      try {
        const reInspect = await chrome.tabs.sendMessage(
          _perspectiveTabId,
          { type: 'INSPECT_ELEMENT', payload: { target: p.selector, pickLast: false } },
          { frameId },
        );
        if (reInspect?.success && reInspect.report) {
          claudeMatchCount = reInspect.report.matchCount ?? 0;
          claudeRect       = reInspect.report.rect       ?? null;
          claudeUid        = reInspect.report.accessibilityProfile?.uid ?? null;
          iou        = _computeIoU(claudeRect, pickedRectFromPicker || cropRect);
          uidMatches = !!claudeUid && !!pickerClickedUid && claudeUid === pickerClickedUid;
          const uniqueAndCorrect = claudeMatchCount === 1 && (iou >= 0.8 || uidMatches);
          if (uniqueAndCorrect) {
            adoptClaudeSelector = true;
            challengeOutcome = `accepted (matchCount=1, IoU=${iou.toFixed(2)}, UID match=${uidMatches}, picker T${pickerTier} → claude T${claudeTier})`;
          } else if (claudeMatchCount !== 1) {
            challengeOutcome = `rejected (claude selector matches ${claudeMatchCount} elements, not 1)`;
          } else {
            challengeOutcome = `rejected (claude selector resolves to wrong element — IoU=${iou.toFixed(2)}, UID match=${uidMatches})`;
          }
        } else {
          challengeOutcome = `rejected (claude selector failed INSPECT: ${reInspect?.error ?? 'unknown'})`;
        }
      } catch (e) {
        challengeOutcome = `rejected-verify-throw (${e.message})`;
      }
    }

    Logger.info('perspective-capture', `Pick→Claude landmark profile [landmarkIdx=${landmarkIdx}]`, {
      alias            : lm.alias,
      pickerSelector,
      pickerMatchCount,
      pickerClickedUid,
      claudeSelector   : p.selector,
      claudeMatchCount,
      claudeRect,
      claudeUid,
      iou              : Math.round(iou * 100) / 100,
      uidMatches,
      pickerTier,
      claudeTier,
      challenge        : challengeOutcome,
      adoptedSelector  : adoptClaudeSelector ? p.selector : pickerSelector,
      description      : p.description,
      aliases          : p.aliases,
      operationsCommon : p.operationsCommon,
      pitfallCount     : p.pitfalls?.length ?? 0,
      expectedContent  : p.expectedContent,
      // v2.74.305 — Surface heuristic and Claude proposals (both
      // structured as { effect, interactionPattern } per spec split).
      heuristicEffect  : aprof?.proposedEffect?.effect ?? null,
      heuristicPattern : aprof?.proposedEffect?.interactionPattern ?? null,
      claudeEffect     : p.effect ?? null,
      claudePattern    : p.interactionPattern ?? null,
      confidence       : p.confidence,
      rationale        : p.rationale,
      screenshotIncluded: !!screenshot,
      // v2.74.239 — Identity layer.
      uid              : aprof?.uid ?? null,
      isCanonical      : aprof?.isCanonical ?? null,
      a11yRole         : aprof?.role ?? null,
      accessibleName   : aprof?.accessibleName ?? null,
      hierarchicalContext: aprof?.hierarchicalContext ?? null,
      canonicalUrl     : aprof?.canonicalUrl ?? null,
      usage            : claudeRes.usage ?? null,
    });
    lm.selector         = adoptClaudeSelector ? p.selector : pickerSelector;
    // v2.74.239 — Persist identity layer on the landmark record.
    // Top-level fields (for fast access by future resolver) plus
    // `derivationInputs` (preserved for UID re-derivation when the
    // hash function evolves).
    if (aprof) {
      lm.uid                 = aprof.uid;
      lm.isCanonical         = aprof.isCanonical;
      lm.a11yRole            = aprof.role;
      lm.accessibleName      = aprof.accessibleName;
      lm.hierarchicalContext = aprof.hierarchicalContext;
      lm.canonicalUrl        = aprof.canonicalUrl;
      lm.derivationInputs    = aprof.derivationInputs;
      // v2.74.305 — Two-stage seeding per ACTION_SPEC § 5. Heuristic
      // first (aprof.proposedEffect now returns { effect, interaction-
      // Pattern } object); Claude's proposal upgrades when heuristic
      // is empty/default. Author overrides win over both — if lm.effect
      // or lm.interactionPattern is already set to a non-default value,
      // neither touches it.
      const heuristicEffect = aprof.proposedEffect?.effect ?? null;
      const heuristicPattern = aprof.proposedEffect?.interactionPattern ?? null;
      const lmEffectIsDefault =
        !lm.effect || lm.effect.kind === 'none' || lm.effect.kind === undefined;
      const lmPatternIsDefault =
        !lm.interactionPattern || lm.interactionPattern === 'none';
      // v2.74.309 — Phase 6: effect source metadata (ACTION_SPEC § 5
      // 'source' + § 9 authoring metadata, extended with our extra
      // proposal stages). Track WHERE the effect value came from:
      //   'authored'  — author edited the drawer control (set there)
      //   'claude'    — Claude's LLM proposal won
      //   'heuristic' — rule-based proposer won
      //   'observed'  — runtime observation (future; we don't auto-
      //                 write landmark effects from observation yet)
      // Seeding never overrides an author-set value (effectSource ===
      // 'authored' implies the author already chose).
      const authorSetEffect = lm.effectSource === 'authored';
      // Stage 1: heuristic seeds defaults.
      if (!authorSetEffect && lmEffectIsDefault && heuristicEffect && heuristicEffect.kind !== 'none') {
        lm.effect = heuristicEffect;
        lm.effectSource = 'heuristic';
      } else if (!lm.effect) {
        lm.effect = { kind: 'none' };   // ensure shape is set
        if (!lm.effectSource) lm.effectSource = 'heuristic';
      }
      if (!authorSetEffect && lmPatternIsDefault && heuristicPattern && heuristicPattern !== 'none') {
        lm.interactionPattern = heuristicPattern;
      } else if (!lm.interactionPattern) {
        lm.interactionPattern = 'none';
      }
      // Stage 2: Claude upgrades when heuristic was default.
      if (!authorSetEffect && p?.effect && p.effect.kind !== 'none' &&
          (lm.effect.kind === 'none' || !lm.effect.kind)) {
        lm.effect = p.effect;
        lm.effectSource = 'claude';
      }
      if (!authorSetEffect && typeof p?.interactionPattern === 'string' && p.interactionPattern !== 'none' &&
          (lm.interactionPattern === 'none' || !lm.interactionPattern)) {
        lm.interactionPattern = p.interactionPattern;
      }
      // v2.74.302 — Alias auto-fill moved BELOW the lm.aliases assign-
      // ment so it can prefer Claude's purpose-named suggestions over
      // the accessibleName slug. See the lm.alias / lm.aliases block
      // just after this if/aprof guard.
    }
    // v2.74.235 — Persist the full profile alongside the existing
    // verified.* block. Each field is independently editable in the
    // profile drawer UI; the author's edits win over Claude's
    // suggestion if they tweak before save.
    // v2.74.302 — Alias auto-fill rewritten. Claude's aliases are
    // purpose-named (per the v2.74.292 prompt — e.g.
    // "content-type-filter") rather than value-named (e.g.
    // "all-images" from the AccName-derived slug). When the author
    // hasn't typed a primary alias yet, take Claude's FIRST suggestion
    // as the primary and keep the rest as secondaries. Falls back to
    // the accessibleName slug only when Claude returned no aliases.
    // When the author HAS typed an alias, preserve it and use all
    // of Claude's suggestions as secondaries.
    lm.description      = p.description;
    const claudeAliases = Array.isArray(p.aliases) ? p.aliases.filter(s => s && s.trim()) : [];
    if (!lm.alias || !lm.alias.trim()) {
      if (claudeAliases.length > 0) {
        lm.alias   = claudeAliases[0];
        lm.aliases = claudeAliases.slice(1);
      } else if (aprof?.accessibleName) {
        lm.alias   = _slugifyForAlias(aprof.accessibleName);
        lm.aliases = [];
      } else {
        lm.aliases = [];
      }
    } else {
      // Author already typed a primary — dedup it out of Claude's
      // suggestions and use the remainder as secondaries.
      lm.aliases = claudeAliases.filter(a => a !== lm.alias);
    }
    lm.operationsCommon = p.operationsCommon;
    lm.pitfalls         = p.pitfalls;
    lm.expectedContent  = p.expectedContent;
    lm.profileConfidence= p.confidence;
    lm.verified         = null;   // selector changed; force re-verify below

    // v2.74.293 — Persist the cropped screenshot so the author can
    // review what Claude actually saw when generating the profile.
    // The drawer renders a thumbnail; click opens the full image in a
    // new tab.
    //
    // v2.74.300 — TWO persisted images now:
    //   captureScreenshot         — tight thumbnail (WYSIWYG with picker
    //                               overlay). Shown in the drawer.
    //   captureContextScreenshot  — wider context shot with red
    //                               highlight box around the picked
    //                               element. THIS is what Claude saw
    //                               for visual disambiguation reasoning.
    //                               Opened in a new tab when the author
    //                               clicks the thumbnail.
    // Tight thumbnail stays the in-drawer identifier (matches overlay
    // pixel-for-pixel). Clicking it gives the author "show me what
    // Claude saw" — closing the loop on the visual reasoning the
    // substrate is now leveraging.
    if (screenshot) {
      lm.captureScreenshot = await _compressScreenshotForStorage(screenshot);
    } else {
      delete lm.captureScreenshot;
    }
    if (contextShot) {
      // Already JPEG-encoded at 0.85 quality inside the helper, no need
      // to re-compress. Store as-is.
      lm.captureContextScreenshot = contextShot;
    } else {
      delete lm.captureContextScreenshot;
    }
    // Auto-expand the profile drawer so the author sees the generated
    // content immediately and can review/edit.
    _landmarkProfileExpanded.add(landmarkIdx);
  } else {
    Logger.warn('perspective-capture', `Pick→Claude profile returned nothing usable (keeping picker selector): ${claudeRes?.error ?? 'unknown'}`);
  }

  renderPerspectiveLandmarks();
  verifyPerspectiveLandmark(landmarkIdx);
}

// v2.74.390 — Fill a RESOLVED landmark's Claude-authored profile (description,
// aliases, operationsCommon, pitfalls, expectedContent, effect, interaction-
// pattern, confidence) — the same generateLandmarkProfile the Pick→Claude path
// runs, which Resolve previously skipped (leaving those fields empty). KEEPS the
// resolved selector + verified + role (only fills the metadata). `report` may be
// passed in (e.g. from a while-modal-open inspect) to skip a fresh INSPECT.
async function _profileResolvedLandmark(landmarkIdx, presetProfile, presetReport) {
  const lm = _perspectiveDraft?.landmarks?.[landmarkIdx];
  if (!lm || !lm.selector) return false;
  let p = presetProfile || null;
  if (!p) {
    // Get the INSPECT report — from a preset (e.g. captured while a modal was
    // open, since the element is gone now) or by inspecting the live element.
    let report = presetReport || null;
    if (!report) {
      if (_perspectiveTabId == null) return false;
      // Resolve frameId from the landmark's frame (same chain as verify).
      let frameId = 0;
      if (lm.frameUrl) {
        try {
          const frames = await new Promise((r) => chrome.webNavigation.getAllFrames({ tabId: _perspectiveTabId }, (fs) => r(fs ?? [])));
          const ex = frames.find(f => f && f.url === lm.frameUrl);
          if (ex) frameId = ex.frameId;
        } catch { /* top frame */ }
      }
      let inspectRes;
      try { inspectRes = await chrome.tabs.sendMessage(_perspectiveTabId, { type: 'INSPECT_ELEMENT', payload: { target: lm.selector, pickLast: false } }, { frameId }); }
      catch { return false; }
      if (!inspectRes?.success) return false;
      report = inspectRes.report ?? {};
    }
    const caps = deriveCapabilities(report);
    const ops  = deriveAllowedOperations(caps);
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'GENERATE_LANDMARK_PROFILE_BG',
        payload: {
          role                  : (lm.roleFill || lm.alias || 'landmark').toString().trim(),
          currentSelector       : lm.selector,
          fingerprint           : { tag: report.tag, inputType: report.inputType, ariaRole: report.ariaRole, ariaLabel: report.ariaLabel, capabilities: caps },
          outerHTMLPreview      : report.outerHTMLPreview ?? '',
          parentOuterHTMLPreview: report.parent?.outerHTMLPreview ?? '',
          frame                 : report.frame ?? 'top',
          matchedCount          : report.matchCount ?? 1,
          screenshotDataUrl     : null,
          operationsAllowed     : ops,
        },
      });
    } catch { return false; }
    if (!res?.success || !res.profile) return false;
    p = res.profile;
  }
  // Apply ONLY the authored metadata — never touch selector / verified / role.
  if (typeof p.description === 'string' && p.description.trim()) lm.description = p.description;
  const aliases = Array.isArray(p.aliases) ? p.aliases.filter(s => s && s.trim() && s !== lm.alias) : [];
  if (aliases.length) lm.aliases = aliases;
  if (Array.isArray(p.operationsCommon) && p.operationsCommon.length) lm.operationsCommon = p.operationsCommon;
  if (Array.isArray(p.pitfalls)) lm.pitfalls = p.pitfalls;
  if (p.expectedContent !== undefined) lm.expectedContent = p.expectedContent;
  if (p.effect && (!lm.effect || lm.effect.kind === 'none')) lm.effect = p.effect;
  if (p.interactionPattern && (!lm.interactionPattern || lm.interactionPattern === 'none')) lm.interactionPattern = p.interactionPattern;
  if (typeof p.confidence === 'number') lm.profileConfidence = p.confidence;
  return true;
}

async function verifyPerspectiveLandmark(landmarkIdx) {
  if (!_perspectiveDraft || !_perspectiveDraft.landmarks[landmarkIdx]) return;
  const lm = _perspectiveDraft.landmarks[landmarkIdx];
  if (!lm.selector || !lm.selector.trim()) {
    showPerspectiveWarning('Add a selector first');
    return;
  }
  if (_perspectiveTabId == null) {
    showPerspectiveWarning('No capture tab. Cancel and start over.');
    return;
  }
  let tabUrl = '';
  try {
    const t = await chrome.tabs.get(_perspectiveTabId);
    tabUrl = t?.url ?? '';
  } catch {
    showPerspectiveWarning('The active tab has been closed.');
    return;
  }

  // v2.74.234 — Verify now goes through INSPECT_ELEMENT instead of
  // PageProbe.probeSelector. INSPECT returns the rich fingerprint
  // (tag, attrs, inputType, computedStyle, visibility, interactability,
  // sibling pattern, etc.) which we feed into LandmarkProfile to
  // derive capabilities + allowed operations + a multi-axis score.
  // Persisting this on the landmark lets downstream consumers (Wave 3)
  // filter their dropdowns without re-running anything.
  //
  // Resolve frameId from the landmark's frameUrl (set by the picker
  // when capturing inside an iframe). Same chain Pick→Claude uses.
  let frameId = 0;
  if (lm.frameUrl) {
    try {
      const frames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId: _perspectiveTabId }, (fs) => resolve(fs ?? []));
      });
      const exact = frames.find(f => f && f.url === lm.frameUrl);
      if (exact) frameId = exact.frameId;
    } catch { /* fall through to top frame */ }
  }

  let inspectRes;
  try {
    inspectRes = await chrome.tabs.sendMessage(
      _perspectiveTabId,
      { type: 'INSPECT_ELEMENT', payload: { target: lm.selector, pickLast: false } },
      { frameId },
    );
  } catch (e) {
    lm.verified = null;
    showPerspectiveWarning(`Verify threw: ${e.message}`);
    renderPerspectiveLandmarks();
    updatePerspectiveSaveButtonState();
    _refreshPerspectiveOverlays();
    return;
  }
  if (!inspectRes?.success) {
    // Selector didn't match — record a mismatch verdict with the
    // diagnostic Inspect produces.
    lm.verified = {
      score: 'mismatch',
      verifiedAt: Date.now(),
      verifiedAgainstUrl: tabUrl,
      matchedCount: 0,
      sampleHtml: '',
      capabilities: null,
      operationsAllowed: [],
      checks: { elementExists: false, visible: false, interactable: false, typeMatchesRole: true, uniqueMatch: false },
      issues: [inspectRes?.error ?? 'inspect failed'],
    };
    showPerspectiveWarning(`Verify failed: ${inspectRes?.error ?? 'unknown'}`);
    renderPerspectiveLandmarks();
    updatePerspectiveSaveButtonState();
    _refreshPerspectiveOverlays();
    return;
  }

  const report = inspectRes.report ?? {};
  const matchedCount = report.matchCount ?? (inspectRes?.success ? 1 : 0);
  const capabilities = deriveCapabilities(report);
  const operationsAllowed = deriveAllowedOperations(capabilities);
  const { score, checks, issues } = computeVerificationScore({
    fp: report,
    capabilities,
    role: lm.alias,
    matchedCount,
  });

  lm.verified = {
    score,
    verifiedAt: Date.now(),
    verifiedAgainstUrl: tabUrl,
    matchedCount,
    sampleHtml: (report.outerHTMLPreview ?? '').slice(0, 240),
    capabilities,
    operationsAllowed,
    checks,
    issues,
    // Lightweight fingerprint snapshot — only the bits downstream
    // consumers might want to see (tag, attrs that matter for
    // semantic intent). Full report stays in-memory only.
    fingerprint: {
      tag           : report.tag ?? null,
      inputType     : report.inputType ?? null,
      ariaRole      : report.ariaRole ?? null,
      ariaLabel     : report.ariaLabel ?? null,
      childCount    : report.childCount ?? 0,
      siblingsSameTag: report.siblingsSameTag ?? 0,
      rect          : report.rect ?? null,
    },
  };

  // v2.74.239 — Landmark identity (Phase 1 of substrate spec). Verify
  // also captures the accessibility profile so legacy landmarks
  // (saved pre-Phase-1) gain a UID + a11y role + accessibleName +
  // hierarchicalContext on re-verify. Only ADD or update on this
  // path — never overwrite a stronger value with weaker (e.g. don't
  // replace a non-empty accessibleName with empty). Pick→Claude is
  // the primary capture site; this is the secondary refresh site.
  const aprof = report.accessibilityProfile ?? null;
  if (aprof) {
    if (!lm.uid)                                        lm.uid                 = aprof.uid;
    if (typeof lm.isCanonical !== 'boolean')            lm.isCanonical         = aprof.isCanonical;
    if (!lm.a11yRole && aprof.role)                     lm.a11yRole            = aprof.role;
    if (!lm.accessibleName && aprof.accessibleName)     lm.accessibleName      = aprof.accessibleName;
    if (!lm.hierarchicalContext && aprof.hierarchicalContext) {
      lm.hierarchicalContext = aprof.hierarchicalContext;
    }
    if (!lm.canonicalUrl && aprof.canonicalUrl)         lm.canonicalUrl        = aprof.canonicalUrl;
    if (!lm.derivationInputs && aprof.derivationInputs) lm.derivationInputs    = aprof.derivationInputs;
    // v2.74.305 — Seed effect + interactionPattern from heuristic
    // proposal when absent. Default-only seeding (kind === 'none' or
    // pattern === 'none' counts as "default") so author overrides
    // are preserved. aprof.proposedEffect is now { effect, interaction-
    // Pattern } per ACTION_SPEC § 5 split.
    const hEffect = aprof.proposedEffect?.effect ?? null;
    const hPattern = aprof.proposedEffect?.interactionPattern ?? null;
    const effDefault = !lm.effect || lm.effect.kind === 'none';
    const patDefault = !lm.interactionPattern || lm.interactionPattern === 'none';
    if (effDefault && hEffect && hEffect.kind !== 'none') lm.effect            = hEffect;
    if (!lm.effect)                                       lm.effect            = { kind: 'none' };
    if (patDefault && hPattern && hPattern !== 'none')    lm.interactionPattern = hPattern;
    if (!lm.interactionPattern)                           lm.interactionPattern = 'none';
  }

  Logger.info('perspective-capture', `Landmark verified [landmarkIdx=${landmarkIdx}] score=${score}`, {
    alias        : lm.alias,
    selector     : lm.selector,
    matchedCount,
    capabilities,
    operationsAllowed,
    issues,
  });

  // v2.74.234 — Auto-enable Show overlay on ready verifications so the
  // author gets an immediate visual confirmation of what was matched.
  // Doesn't override an explicit toggle-off — if the author had it
  // toggled off, we leave their preference alone. (Caveats / mismatch
  // verdicts do NOT auto-show — those need attention, not affirmation.)
  if (score === 'ready' && lm.showOverlay !== false) {
    lm.showOverlay = true;
  }

  renderPerspectiveLandmarks();
  updatePerspectiveSaveButtonState();
  _refreshPerspectiveOverlays();
}

// v2.74.46 — Send the current verified landmarks to the content script
// so it can draw a translucent overlay around each one. Only verified
// landmarks with non-empty selectors are drawn — un-verified rows are
// hidden until the user runs Verify on them. Best-effort; failure
// (tab closed, content script unreachable) is silently swallowed.
async function _refreshPerspectiveOverlays() {
  if (_perspectiveTabId == null || !_perspectiveDraft) return;
  // v2.74.233 — Per-landmark "Show" toggle. Only landmarks the author
  // has explicitly toggled on are drawn; the rest are hidden even
  // when verified. Lets the author isolate landmarks visually without
  // having to remove them. Replaces the previous all-verified-when-
  // focused behavior (which painted every verified landmark whenever
  // the sidepanel had focus — noisy on perspectives with many landmarks).
  const landmarks = _perspectiveDraft.landmarks
    .filter(lm => lm && lm.showOverlay === true && lm.selector && lm.selector.trim())
    .map(lm => ({ alias: lm.alias ?? '', selector: lm.selector, frameUrl: lm.frameUrl ?? null }));
  try {
    await chrome.tabs.sendMessage(_perspectiveTabId, {
      type: 'SHOW_PERSPECTIVE_OVERLAYS',
      payload: { landmarks },
    });
  } catch { /* tab gone or content script not loaded */ }
}

async function _clearPerspectiveOverlays() {
  if (_perspectiveTabId == null) return;
  try {
    await chrome.tabs.sendMessage(_perspectiveTabId, { type: 'CLEAR_PERSPECTIVE_OVERLAYS' });
  } catch { /* fine */ }
}

// ─── Save / Cancel ───────────────────────────────────────────────────────

async function savePerspective() {
  if (!_perspectiveDraft) return;
  // v2.74.48 — Re-normalize at save in case the input slipped through
  // (e.g. paste with newlines, programmatic value set). Strip leading
  // and trailing hyphens for tidy storage.
  _perspectiveDraft.name = _normalizePerspectiveName(perspectiveNameInput.value).replace(/^-+|-+$/g, '');
  _perspectiveDraft.description = perspectiveDescriptionInput.value.trim();
  // v2.74.275 — urlPattern field gone; URL gating expressed via the
  // urlMatches predicate authored in the predicates section.

  // v2.74.231 — Auto-generate description from landmarks when blank.
  // Mirrors fragment-author's composeCompactDescription on save. The
  // author can override by typing anything in the field; we only
  // backfill empty descriptions so authored text is preserved.
  // Reflect the generated text back into the input so the user sees
  // what got saved.
  if (!_perspectiveDraft.description && _perspectiveDraft.landmarks.length > 0) {
    _perspectiveDraft.description = composeCompactDescription(_perspectiveDraft.landmarks);
    if (perspectiveDescriptionInput) perspectiveDescriptionInput.value = _perspectiveDraft.description;
  }
  // Reflect the normalized name in the input so the user sees what was
  // actually saved.
  if (perspectiveNameInput.value !== _perspectiveDraft.name) perspectiveNameInput.value = _perspectiveDraft.name;

  if (!_perspectiveDraft.name)        { showPerspectiveWarning('Perspective name is required'); return; }
  // v2.74.275 — Require a urlMatches predicate (replaces the
  // urlPattern field check). Auto-seeded from tab URL on first
  // tab load for new perspectives; author can edit or remove.
  const hasUrlPredicate = Array.isArray(_perspectiveDraft.predicates)
    && _perspectiveDraft.predicates.some(p =>
      p?.kind === 'urlMatches' && typeof p.pattern === 'string' && p.pattern.trim().length > 0
    );
  if (!hasUrlPredicate) {
    showPerspectiveWarning('Perspective needs a URL gate — add a urlMatches predicate in the Additional predicates section (or it would match every page on this Ground).');
    return;
  }
  if (_perspectiveDraft.landmarks.length === 0) {
    showPerspectiveWarning('Add at least one landmark');
    return;
  }
  const seen = new Set();
  for (const lm of _perspectiveDraft.landmarks) {
    // v2.74.275 — Storage field is now `lm.alias` (legacy `role`
    // shape removed). Legacy { perspectiveId, role } refs no longer
    // supported.
    if (!lm.alias?.trim())     { showPerspectiveWarning('All landmarks need an alias (auto-fills from accessibleName on Pick — type one manually if you skipped Pick)'); return; }
    if (!lm.selector?.trim()) { showPerspectiveWarning('All landmarks need a selector — click Pick to choose an element'); return; }
    if (seen.has(lm.alias))    { showPerspectiveWarning(`Duplicate alias "${lm.alias}" — aliases must be unique within a perspective`); return; }
    seen.add(lm.alias);
  }

  // v2.74.260 — Validate + normalize additional predicates. Each leaf
  // needs the kind-specific required fields populated. Incomplete
  // predicates would fail-closed at runtime (per Phase 7d semantics),
  // so flag them at save time instead of silently shipping a perspective
  // that never activates.
  if (Array.isArray(_perspectiveDraft.predicates) && _perspectiveDraft.predicates.length > 0) {
    for (let i = 0; i < _perspectiveDraft.predicates.length; i++) {
      const p = _perspectiveDraft.predicates[i];
      if (!p || typeof p !== 'object' || !p.kind) {
        showPerspectiveWarning(`Predicate #${i + 1}: missing kind`);
        return;
      }
      if (p.kind === 'visible' || p.kind === 'hasText') {
        if (!p.target || typeof p.target !== 'string') {
          showPerspectiveWarning(`Predicate #${i + 1} (${p.kind}): pick a target landmark`);
          return;
        }
        // v2.74.261 — BUG FIX: validate target uid still references a
        // landmark in the current perspective. Predicates created against a
        // landmark that's since been removed would silently fail-closed
        // at runtime (getLandmark returns null → predicate returns null
        // → perspective never activates). Catch at save time instead.
        const targetExists = (_perspectiveDraft.landmarks ?? []).some(lm => lm?.uid === p.target);
        if (!targetExists) {
          showPerspectiveWarning(`Predicate #${i + 1} (${p.kind}): target landmark no longer exists in this perspective. Pick a different landmark or remove the predicate.`);
          return;
        }
        if (p.kind === 'hasText' && (typeof p.value !== 'string' || !p.value)) {
          showPerspectiveWarning(`Predicate #${i + 1} (hasText): text value is required`);
          return;
        }
      } else if (p.kind === 'iframeLoaded') {
        if (!p.contextName || typeof p.contextName !== 'string' || !p.contextName.trim()) {
          showPerspectiveWarning(`Predicate #${i + 1} (iframeLoaded): context name is required`);
          return;
        }
      } else if (p.kind === 'urlMatches') {
        // v2.74.275 — urlMatches authoring validation.
        if (typeof p.pattern !== 'string' || !p.pattern.trim()) {
          showPerspectiveWarning(`Predicate #${i + 1} (URL matches): pattern is required`);
          return;
        }
        if (p.mode && !['contains', 'regex', 'exact'].includes(p.mode)) {
          showPerspectiveWarning(`Predicate #${i + 1} (URL matches): invalid mode "${p.mode}"`);
          return;
        }
      } else {
        showPerspectiveWarning(`Predicate #${i + 1}: unknown kind "${p.kind}"`);
        return;
      }
    }
  }
  // v2.74.267 — Validate iframe contexts. Each must have a non-empty
  // unique contextName + a valid predicate per its kind. Authoring
  // path may produce empty fields (e.g., just clicked + Add); flag
  // so the author doesn't save a structurally-invalid perspective.
  if (Array.isArray(_perspectiveDraft.iframeContexts) && _perspectiveDraft.iframeContexts.length > 0) {
    const namesSeen = new Set();
    for (let i = 0; i < _perspectiveDraft.iframeContexts.length; i++) {
      const c = _perspectiveDraft.iframeContexts[i];
      if (!c?.contextName || !c.contextName.trim()) {
        showPerspectiveWarning(`iframe context #${i + 1}: name is required`);
        return;
      }
      const nm = c.contextName.trim();
      if (namesSeen.has(nm)) {
        showPerspectiveWarning(`Duplicate iframe context name "${nm}" — must be unique within the perspective`);
        return;
      }
      namesSeen.add(nm);
      const p = c.predicate;
      if (!p || !p.kind) {
        showPerspectiveWarning(`iframe context "${nm}": predicate kind missing`);
        return;
      }
      if (p.kind === 'iframeName' && (!p.value || !String(p.value).trim())) {
        showPerspectiveWarning(`iframe context "${nm}" (by name): name value required`);
        return;
      }
      if (p.kind === 'iframeSelector' && (!p.selector || !String(p.selector).trim())) {
        showPerspectiveWarning(`iframe context "${nm}" (by selector): CSS selector required`);
        return;
      }
      if (p.kind === 'iframeSrcPattern' && (!p.pattern || !String(p.pattern).trim())) {
        showPerspectiveWarning(`iframe context "${nm}" (by src pattern): pattern required`);
        return;
      }
      if (p.kind === 'iframePositional' && (typeof p.index !== 'number' || p.index < 0)) {
        showPerspectiveWarning(`iframe context "${nm}" (by position): non-negative index required`);
        return;
      }
    }
    // Cross-reference: every landmark.iframeContext should match an
    // existing context name. Catches typos (rare since UI never lets
    // you type one) and orphans from rename gaps.
    for (let li = 0; li < (_perspectiveDraft.landmarks ?? []).length; li++) {
      const lm = _perspectiveDraft.landmarks[li];
      if (lm?.iframeContext && !namesSeen.has(lm.iframeContext)) {
        showPerspectiveWarning(`Landmark "${lm.accessibleName ?? lm.alias ?? li}" references iframe context "${lm.iframeContext}" which doesn't exist in this perspective.`);
        return;
      }
    }
  }
  // v2.74.275 — Save serialization, cleaned. Nested-tree sentinel
  // removed. Two cases:
  //   1. AND of leaves → flat array (implicit AND)
  //   2. OR/NOT of leaves → tree { operator, children }
  if (Array.isArray(_perspectiveDraft.predicates) && _perspectiveDraft.predicates.length > 0) {
    if (_predicatesOperator === 'or' || _predicatesOperator === 'not') {
      const children = _predicatesOperator === 'not'
        ? _perspectiveDraft.predicates.slice(0, 1)
        : _perspectiveDraft.predicates.slice();
      _perspectiveDraft.predicates = { operator: _predicatesOperator, children };
    }
    // AND case: leave as flat array.
  }

  // v2.74.48 — Uniqueness check against existing perspectives on this
  // Ground. Edit mode (same id) skips itself so the user can save
  // unchanged. Names are compared case-insensitive even though input
  // normalization forces lowercase — defensive.
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'LIST_PERSPECTIVES',
      payload: { groundId: _perspectiveGroundId },
    });
    if (res?.success && Array.isArray(res.perspectives)) {
      const lower = _perspectiveDraft.name.toLowerCase();
      const clash = res.perspectives.find(l =>
        l.id !== _perspectiveDraft.id && String(l.name ?? '').toLowerCase() === lower
      );
      if (clash) {
        showPerspectiveWarning(`A perspective named "${_perspectiveDraft.name}" already exists on this Ground. Pick a different name.`);
        return;
      }
    }
  } catch (e) {
    // LIST_PERSPECTIVES failures are non-fatal — log and let save proceed.
    // The user can retry if they hit a real duplicate; the storage
    // layer will at worst overwrite a same-named record.
    console.warn('[perspective-capture] uniqueness check failed (continuing):', e?.message);
  }
  const unverified = _perspectiveDraft.landmarks.filter(lm => !lm.verified || lm.verified.matchedCount === 0);
  if (unverified.length > 0) {
    if (!confirm(`${unverified.length} landmark(s) are unverified or match 0 elements. Save anyway?`)) return;
  }

  // v2.74.121 — Mount-snapshot guard + Cancel disable during save.
  // Same shape as assertion-author.js v2.74.120 / analysis-author.js
  // v2.74.121. The reset-for-next-capture branch below makes this
  // especially important: pre-fix, a Cancel-during-save would still
  // complete the save, then proceed to reset the form for "another
  // capture" — but the user has already left.
  const mountSnapshot = _mountEl;
  perspectiveSaveBtn.disabled = true;
  if (perspectiveCancelBtn) perspectiveCancelBtn.disabled = true;
  perspectiveSaveBtn.textContent = 'Saving…';
  try {
    // v2.74.240 — Phase 2 of substrate spec: write each landmark to
    // the per-Ground registry, write the perspective with landmarkRefs
    // (no more embedded landmarks[]). Backward compat: perspectives that
    // still carry embedded landmarks on load get migrated here
    // (lazy migration on first save after upgrade).
    //
    // Save order:
    //   1. Each landmark → registry (idempotent; same UID overwrites)
    //   2. Perspective → with landmarkRefs[] + landmarks[] removed
    //
    // Failure modes:
    //   - A landmark write fails → abort the whole save (don't leave
    //     half-migrated state).
    //   - Last write wins for landmarks with shared UIDs across perspectives
    //     (per spec: same UID = same landmark, intentionally one record).
    const landmarkRefs = [];
    for (const lm of _perspectiveDraft.landmarks) {
      // Ensure a UID exists. Phase 1 derives at Pick time; legacy
      // landmarks (saved pre-Phase 1) get a local UUID here.
      if (!lm.uid) {
        const localUid = 'lmk_local_' + (crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        lm.uid = localUid;
        lm.isCanonical = false;
      }
      // Compose the registry record. Field set is the union of
      // identity layer (Phase 1) + description (Wave 2) + realization
      // (selector + verified). groundId comes from the perspective.
      const record = {
        uid                 : lm.uid,
        groundId            : _perspectiveGroundId,
        isCanonical         : lm.isCanonical === true,
        // v2.74.275 — Storage field renamed: role → alias.
        alias               : lm.alias ?? '',
        a11yRole            : lm.a11yRole ?? null,
        accessibleName      : lm.accessibleName ?? null,
        hierarchicalContext : lm.hierarchicalContext ?? null,
        canonicalUrl        : lm.canonicalUrl ?? null,
        derivationInputs    : lm.derivationInputs ?? null,
        // Wave 2 author metadata
        description         : lm.description ?? '',
        aliases             : Array.isArray(lm.aliases) ? lm.aliases : [],
        operationsCommon    : Array.isArray(lm.operationsCommon) ? lm.operationsCommon : [],
        pitfalls            : Array.isArray(lm.pitfalls) ? lm.pitfalls : [],
        expectedContent     : lm.expectedContent ?? null,
        profileConfidence   : lm.profileConfidence ?? null,
        // v2.74.305 — Phase 1 of ACTION_SPEC compliance. effect is
        // the spec-aligned substrate-level annotation (object shape
        // per § 5); interactionPattern is our DOM-level intel.
        // Legacy actionEffect string no longer written — hydration
        // migrates old records on load.
        effect              : lm.effect ?? { kind: 'none' },
        interactionPattern  : lm.interactionPattern ?? 'none',
        // v2.74.309 — Phase 6: effect source metadata.
        effectSource        : lm.effectSource ?? null,
        // Realization
        selector            : lm.selector ?? '',
        frameUrl            : lm.frameUrl ?? null,
        // v2.74.245 — Phase 7a: iframe binding via named context. The
        // landmark references a context declared on its containing
        // Perspective (or any active Perspective at resolution time). frameUrl
        // is kept as a legacy fallback during the transition;
        // future phase drops it once all consumers migrate.
        iframeContext       : lm.iframeContext ?? null,
        // Verified state (Wave 1) — carries score, capabilities, ops
        verified            : lm.verified ?? null,
        lifecycle           : lm.verified?.score === 'ready' ? 'verified' : 'fresh',
      };
      const saveRes = await chrome.runtime.sendMessage({
        type: 'SAVE_LANDMARK',
        payload: { landmark: record },
      });
      if (!saveRes?.success) {
        throw new Error(`Failed to save landmark "${lm.alias || lm.accessibleName || lm.uid}": ${saveRes?.error ?? 'unknown'}`);
      }
      landmarkRefs.push(lm.uid);
    }
    // v2.74.336 — Phase C-lite: persist the LLM-proposed Layer 2 structure
    // as `landmarks: LandmarkNode[]` when present AND it still covers exactly
    // the picked landmarks (coverage safety net on top of pick/remove
    // invalidation). Otherwise drop it → StorageManager derives flat nodes
    // from landmarkRefs.
    let structuredNodes = null;
    if (Array.isArray(_perspectiveDraft.structuredLandmarks) && _perspectiveDraft.structuredLandmarks.length) {
      const flat = new Set(flattenLandmarkNodes(_perspectiveDraft.structuredLandmarks));
      if (flat.size === landmarkRefs.length && landmarkRefs.every(u => flat.has(u))) {
        structuredNodes = _perspectiveDraft.structuredLandmarks;
      }
    }
    // v2.74.348/349 — § 13 role flow: if the author filled any landmark INTO a
    // proposed role (roleFill) but never ran "Structure", emit a flat
    // composition so the roles aren't discarded — they become
    // LandmarkNode.role. Trigger when ANY landmark is roled; map every saved
    // landmark to a node (roled → role + multiplicity + 'accepted'; free-picked
    // → bare {ref}). This covers exactly the landmark set, so mixed authoring
    // (some roles + some + Pick landmark) keeps its role signal instead of
    // dropping all of it. No roleFill anywhere → leave null (StorageManager
    // derives flat nodes from landmarkRefs as before).
    if (!structuredNodes) {
      const withUid = _perspectiveDraft.landmarks.filter(lm => lm.uid);
      const anyRoled = withUid.some(lm => lm.roleFill);
      if (anyRoled && withUid.length === landmarkRefs.length) {
        const now = Date.now();
        structuredNodes = withUid.map(lm => lm.roleFill
          ? { ref: lm.uid, role: lm.roleFill, multiplicity: lm.roleMult ?? 'one',
              authoringMetadata: { capturedBy: 'llm-proposed', capturedAt: now, userJudgment: 'accepted', reviewedAt: now } }
          : { ref: lm.uid });
      }
    }
    // v2.74.362 — strip transient auto-verification state (autoJudgment/
    // autoNote) so it isn't persisted into the composition (it's a point-in-
    // time verdict, re-derived by ✓ Verify; clones, doesn't mutate the draft).
    if (Array.isArray(structuredNodes)) {
      const stripAuto = (nodes) => nodes.map(({ autoJudgment, autoNote, autoVisual, ...rest }) =>
        (Array.isArray(rest.contains) ? { ...rest, contains: stripAuto(rest.contains) } : rest));
      structuredNodes = stripAuto(structuredNodes);
    }
    // Build the perspective payload — refs + (optional) structured nodes. Drop the
    // hydrated landmarks[] / draft-only fields so reads don't pick up copies.
    const perspectiveForSave = {
      ..._perspectiveDraft,
      landmarkRefs,
      landmarks: structuredNodes ?? undefined,
    };
    if (!perspectiveForSave.landmarks) delete perspectiveForSave.landmarks;
    delete perspectiveForSave.structuredLandmarks;   // draft-only
    if (!structuredNodes) {
      // No (valid) structure → don't persist stale overlays either.
      delete perspectiveForSave.groupings;
      delete perspectiveForSave.sequences;
    }

    const res = await chrome.runtime.sendMessage({
      type: 'SAVE_PERSPECTIVE',
      payload: { perspective: perspectiveForSave },
    });
    if (mountSnapshot !== _mountEl) return;
    if (!res?.success) {
      showPerspectiveWarning(`Save failed: ${res?.error ?? 'unknown'}`);
      perspectiveSaveBtn.disabled = false;
      if (perspectiveCancelBtn) perspectiveCancelBtn.disabled = false;
      perspectiveSaveBtn.textContent = 'Save Perspective';
      return;
    }
    const savedName = _perspectiveDraft.name;
    toast(`✓ Perspective "${savedName}" saved`, 'ok');
    // v2.74.33 — When launched from the Ground sidepanel, save → return
    // rather than resetting to capture another perspective.
    // v2.74.34 — Capture the routing decision BEFORE sending
    // CANCEL_PERSPECTIVE_CAPTURE: that handler clears the sidepanel mode,
    // which unmounts this module and zeroes _perspectiveReturnTo.
    if (_perspectiveReturnTo === 'ground-view') {
      const returnTo = _perspectiveReturnTo;
      // Clean up the pending capture session in the background before
      // switching mode so we don't leave a half-finished capture entry.
      try { await chrome.runtime.sendMessage({ type: 'CANCEL_PERSPECTIVE_CAPTURE' }); } catch {}
      _routeExit(returnTo);
      return;
    }
    _perspectiveDraft = newEmptyPerspectiveDraft(_perspectiveGroundId);
    perspectiveNameInput.value = '';
    perspectiveDescriptionInput.value = '';
    refreshPerspectiveActiveTab();
    renderPerspectiveLandmarks();
    updatePerspectiveSaveButtonState();
    perspectiveSaveBtn.textContent = 'Save Perspective';
    perspectiveSaveBtn.disabled = true;
  } catch (e) {
    // v2.74.121 — Same guard on the throw path.
    if (mountSnapshot !== _mountEl) return;
    showPerspectiveWarning(`Save threw: ${e.message}`);
    perspectiveSaveBtn.disabled = false;
    if (perspectiveCancelBtn) perspectiveCancelBtn.disabled = false;
    perspectiveSaveBtn.textContent = 'Save Perspective';
  }
}

async function cancelPerspectiveCapture() {
  // v2.74.34 — Capture the routing decision BEFORE the cleanup. The
  // CANCEL_PERSPECTIVE_CAPTURE handler in background calls
  // __setSidepanelMode(null) which triggers the shell to unmount this
  // mode — which clears _perspectiveReturnTo to null. Reading the field after
  // that point would always fall through to exitToStudio.
  const returnTo = _perspectiveReturnTo;
  if (_perspectivePickerSession) await cancelPerspectivePick(true);
  // Server-side cleanup: clear the pending capture session in background.
  // This also clears the sidepanel mode (CANCEL_PERSPECTIVE_CAPTURE handler
  // calls __setSidepanelMode(null) when the active mode is perspective-capture),
  // but we follow up with the appropriate exit (Studio or Ground sidepanel)
  // anyway per the unified cancel UX (v2.72.54).
  try {
    await chrome.runtime.sendMessage({ type: 'CANCEL_PERSPECTIVE_CAPTURE' });
  } catch { /* fine */ }
  _routeExit(returnTo);
}

// v2.74.33 — Route the exit. When launched from the Ground sidepanel
// (returnTo='ground-view'), switch the panel back to that mode instead
// of dismissing it and focusing Studio. v2.74.34 — Takes returnTo as an
// argument so callers capture it before any cleanup that may unmount
// this mode (and reset the module-level _perspectiveReturnTo to null).
// v2.74.36 — Clear the per-tab sidepanel mode record on exit so a
// future visit to this tab doesn't auto-resume the finished session.
function _routeExit(returnTo) {
  if (typeof _perspectiveTabId === 'number') {
    chrome.runtime.sendMessage({
      type: 'CLEAR_TAB_SIDEPANEL_MODE',
      payload: { tabId: _perspectiveTabId },
    }).catch(() => {});
  }
  if (returnTo === 'ground-view') {
    requestModeChange('ground-view', {});
  } else {
    exitToStudio();
  }
}

// ─── Module export ───────────────────────────────────────────────────────

export default {
  name: 'perspective-capture',
  mount,
  unmount,
  handleEvent,
};
