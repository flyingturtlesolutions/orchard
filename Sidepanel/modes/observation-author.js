/**
 * @file Sidepanel/modes/observation-author.js
 * @description Sidepanel mode for authoring multi-extract Observations
 * (post-Ship-A schema). Mirrors fragment-author's UI pattern: header,
 * preconditions card, name input, list of extract cards, postconditions
 * card, sticky Save/Done bar.
 *
 * Per Ship B:
 *   - One Observation can have N extracts (default cap 7, configurable
 *     via Settings; mirrors fragment_cap)
 *   - Each extract is shape + target + output binding (+ shape-specific
 *     extras delegated to ObservationAuthor/shapes/<shape>.js)
 *   - Pre/postconditions are page-state assertions at the Observation
 *     level (Observations don't mutate the page; postconditions confirm
 *     state didn't drift during read)
 *   - Verify per-extract dispatches the actual OBSERVE_* message the
 *     runtime uses, giving an exact preview rather than a stand-in
 *
 * Save constraints (mirror fragment-author):
 *   - Name required
 *   - At least one extract
 *   - Every extract has a target, output, and shape-specific required fields
 *   - All extracts verified successfully
 *
 * @module Sidepanel/modes/observation-author
 * @version 2.74.16
 */

import { toast, exitToStudio, requestModeChange } from '../shell-api.js';
import { renderExtractCard, wireExtractCard } from './ObservationAuthor/extractCard.js';
import { getShape, freeExtractShapes } from './ObservationAuthor/shapes/index.js';
// v2.74.168 — Tear down sibling-frame pickers after a PICK_RESULT lands.
// The broadcast started picker sessions in every same-origin frame;
// only the originating frame self-stops on result.
// v2.74.203 — Pull escHtml/escAttr from shared.js. The local copies
// (escHtml + escAttr = escHtml) didn't escape `"` or `'`, so any
// selector containing a literal double-quote — e.g.
// `[aria-label="Stop generating"]` — silently truncated when
// rendered into an HTML attribute value. The shared helpers escape
// the full quote set; importing them eliminates the bug class
// (and divergence from fragment-author, which already imports them).
import { broadcastCancelPick, escHtml as sharedEscHtml, escAttr as sharedEscAttr } from '../../shared.js';
import {
  startPick, cancelPick, matchPickResult,
  startSnap, cancelSnap, matchSnapResult,
} from './ObservationAuthor/picker.js';
import { composeCompactDescription } from '../../Services/ObservationDescription.js';
import { CONDITION_FIELDS, emptyCondition } from '../../Services/Assertion.js';
// v2.74.209 — Logger so verify-time selector failures land in the Logs
// tab (with the full prefix-walk diagnostic) on top of the inline pill.
// The pill is helpful at-a-glance; the Logs entry is what gets copied
// into a bug report.
import { Logger } from '../../Core/Logger.js';

// v2.74.203 — Delegated to shared.js (was buggy local copy that
// didn't escape `"` — see PICK_RESULT round-trip selector truncation
// bug fixed in v2.74.203). Local aliases keep all existing call
// sites working.
const escHtml = sharedEscHtml;
const escAttr = sharedEscAttr;
function uid() { return `oa_ex_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

const SOFT_CAP_THRESHOLD = 7;
let _extractCap = 7;
let _extractCapUnlimited = false;

async function _loadExtractCapSetting() {
  try {
    const capRes = await new Promise(r =>
      chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'observation_extract_cap', defaultValue: 7 } }, r)
    );
    const unlimRes = await new Promise(r =>
      chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'observation_extract_cap_unlimited', defaultValue: false } }, r)
    );
    const cap = Number(capRes?.value);
    _extractCap = (Number.isFinite(cap) && cap > 0) ? cap : 7;
    _extractCapUnlimited = unlimRes?.value === true;
  } catch (_) {
    _extractCap = 7;
    _extractCapUnlimited = false;
  }
}

let _mountEl = null;
let _payload = null;
let _tabId   = null;
let _setupReady = false;
let _draft = null;
let _verifying = new Set();
let _verified  = new Map();
let _pickerSession = null;
let _snapSession   = null;       // { sessionId, extractIdx } | null
// v2.74.229 — Ask-Claude suggestion state. Composite-key map mirroring
// _verified: numeric exIdx for top-level extracts, "${exIdx}.${gIdx}"
// for body subs. Each entry: { status: 'asking'|'ready'|'error',
// suggestion?: string, error?: string }. Cleared on accept/dismiss
// and on extract removal.
let _askClaudeState = new Map();

// Pre/post condition rendering — mirrors fragment-author.js so the visual
// treatment matches across modes. _conditionDisplay caches Perspective and
// Assertion metadata (name, landmarkCount) so the rendered rows can show
// human-readable labels instead of bare ids. _preSource/_postSource carry
// the per-side source label ("auto-captured (N perspectives, …)") shown in the
// section header.
let _conditionDisplay = { perspectives: new Map(), assertions: new Map() };
let _preSource = '—';
let _postSource = '—';

let bannerTitleEl, bannerSubtitleEl, warningEl;
let nameInputEl, extractsListEl, extractCountEl, addExtractBtnEl, addFreeExtractBtnEl, addExtractGateBtnEl;
let preListEl, postListEl, preSourceEl, postSourceEl;
// v2.74.26 — Three-button save flow mirroring fragment-author:
//   saveBtnEl       → Save button INSIDE the Name card (data-oa="save").
//   doneRevealBtnEl → Bottom "Done" — reveals the Name card + collapses
//                     every collapsible card. Does NOT save.
//   cancelBtnEl     → Bottom "Cancel" — exits to Studio without saving.
// nameCardEl is the section hosting the name input + Save button. Hidden
// (display:none) until the author clicks Done.
let saveBtnEl, doneRevealBtnEl, cancelBtnEl, nameCardEl;
let pickBannerEl, pickCancelBtnEl;
// v2.74.26 — + Add buttons for the editable pre/post lists. Same wiring
// pattern as fragment-author: clicking pushes a fresh selector_present
// row and re-renders; first touch flips _pre/_postUserModified so
// subsequent auto-capture sweeps don't clobber manual edits.
let preAddBtnEl, postAddBtnEl;
let _preUserModified = false;
let _postUserModified = false;
// Ground catalog cached at mount for the condition-type dropdown's
// Custom (library assertions) and Perspectives optgroups.
let _groundPerspectives = [];
let _groundAssertions = [];
// v2.74.26 — Extracts card collapse refs + state. Chevron lives inline in
// the head row (before the "Extracts" label); toggling adds
// .fa-landmarks-card-collapsed to the section which hides the list +
// footer while keeping the head visible.
let extractsCardEl, extractsToggleBtnEl, extractsToggleGlyphEl;
let _extractsCardCollapsed = false;

// v2.74.23 — Antecedent fragment card. Same UX as fragment-author's
// card; NOT persisted on the saved Observation record. Used only to
// drive the authoring tab into the right state. State + DOM refs
// mirror fragment-author one-for-one (scoped to data-oa attributes).
let anteCardEl, anteSelectEl, anteRunBtnEl, anteStatusEl;
let anteParamsInputEl, anteParamsWrapEl, anteParamsOrderEl;
let anteToggleBtnEl, anteToggleGlyphEl, anteBodyEl;
let anteCollapsedNameEl;
let _anteFragments = [];
let _anteRunMode = 'run';
let _anteCardCollapsed = false;
// Auto-collapse-on-first-extract tracker. Mirrors fragment-author's
// _anteLastActionCount; tracks _draft.extracts.length so we collapse
// on the 0 → >0 transition exactly once.
let _anteLastExtractCount = 0;
// Pre/post collapse state.
let preCardEl, preToggleBtnEl, preToggleGlyphEl;
let postCardEl, postToggleBtnEl, postToggleGlyphEl;
let _preCardCollapsed = false;
let _postCardCollapsed = false;

function renderHTML() {
  return `
    <div class="dbg-perspective fa-author">
      <header class="dbg-perspective-header">
        <div class="dbg-perspective-title-row">
          <span class="dbg-perspective-badge">Observation author</span>
          <span data-oa="title" class="dbg-perspective-ground-label">Authoring…</span>
        </div>
        <div class="dbg-perspective-meta">
          <span class="dbg-perspective-meta-label">Tab</span>
          <span data-oa="subtitle" class="dbg-perspective-meta-value mono">—</span>
        </div>
        <div data-oa="warning" class="dbg-perspective-warning hidden"></div>
      </header>

      <!-- v2.74.23 — Antecedent fragment card. Same UX as the fragment
           author mode's card: pick a fragment, optionally fill its
           param values, click Run to navigate the tab to its URL
           precondition and execute. Run flips to a refresh icon for
           one-click undo back to the ground's default URL. Disables
           once the extracts list is non-empty.

           Distinct from fragment-author: NOT saved on the observation
           record — Observations don't carry antecedent metadata. This
           card only drives tab state for authoring; once the user is
           done, the chosen antecedent is forgotten. -->
      <section data-oa="antecedent-card" class="dbg-perspective-meta-card fa-antecedent-card">
        <button class="fa-antecedent-collapse-toggle" data-oa="antecedent-toggle" type="button"
                title="Collapse / expand antecedent card"
                aria-label="Collapse antecedent card" aria-expanded="true">
          <span class="fa-antecedent-collapse-chevron" data-oa="antecedent-toggle-glyph" aria-hidden="true">▾</span>
        </button>
        <div class="fa-antecedent-content">
          <div class="fa-antecedent-header-row">
            <span class="dbg-perspective-field-label fa-antecedent-header-label">Antecedent fragment</span>
            <span data-oa="antecedent-collapsed-name" class="fa-antecedent-collapsed-name">none</span>
          </div>
          <div data-oa="antecedent-body" class="fa-antecedent-body">
            <div class="fa-antecedent-row">
              <label class="fa-antecedent-label">
                <select data-oa="antecedent-select">
                  <option value="">— none —</option>
                </select>
              </label>
            </div>
            <div class="fa-antecedent-row fa-antecedent-row-2">
              <label class="fa-antecedent-params-input hidden" data-oa="antecedent-params-wrap">
                <span class="dbg-perspective-field-label">Param values</span>
                <input type="text" data-oa="antecedent-params" placeholder="comma-separated values" />
              </label>
              <button data-oa="antecedent-run" class="btn-secondary fa-antecedent-run" type="button" disabled>Run</button>
            </div>
            <div data-oa="antecedent-params-order" class="fa-antecedent-params-order hidden"></div>
            <span data-oa="antecedent-status" class="fa-antecedent-status field-hint"></span>
          </div>
        </div>
      </section>

      <!-- v2.74.23 — Preconditions card with the same collapsible
           pattern as fragment-author: chevron + always-visible head +
           collapsible list body.
           v2.74.26 — Adopt .dbg-perspective-meta-card chrome so the card
           visual matches the other authoring cards; rows are editable
           (type dropdown + value input + ✕) with a right-aligned + Add
           footer mirroring the Studio review panel. -->
      <section data-oa="pre-card" class="dbg-perspective-meta-card fa-conditions-card">
        <button class="fa-conditions-collapse-toggle" data-oa="pre-toggle" type="button"
                title="Collapse / expand preconditions"
                aria-label="Collapse preconditions" aria-expanded="true">
          <span class="fa-conditions-collapse-chevron" data-oa="pre-toggle-glyph" aria-hidden="true">▾</span>
        </button>
        <div class="fa-conditions-content">
          <div class="fa-conditions-head">
            <span class="fa-conditions-label">Preconditions</span>
            <span data-oa="pre-source" class="fa-conditions-source">—</span>
          </div>
          <div data-oa="pre-body" class="fa-conditions-body">
            <div data-oa="pre-list" class="fa-conditions-list">
              <div class="fa-conditions-empty">Capturing on mount…</div>
            </div>
            <div class="fa-conditions-footer">
              <button data-oa="add-pre" class="btn-secondary fa-add-condition-btn" type="button">+ Add</button>
            </div>
          </div>
        </div>
      </section>

      <section class="dbg-perspective-instructions">
        <p class="dbg-perspective-help">
          Add each extract in turn. Pick a target, then click <strong>Verify</strong> to read the value from the page. Each extract binds its own output name into scope.
        </p>
      </section>

      <!-- v2.74.26 — Extracts card. Chevron in the head row toggles
           .fa-landmarks-card-collapsed which hides the list + footer
           while keeping the label + count chip visible. -->
      <section data-oa="extracts-card" class="dbg-perspective-landmarks">
        <div class="dbg-perspective-landmarks-head">
          <button class="fa-actions-collapse-toggle" data-oa="extracts-toggle" type="button"
                  title="Collapse / expand extracts"
                  aria-label="Collapse extracts" aria-expanded="true">
            <span class="fa-actions-collapse-chevron" data-oa="extracts-toggle-glyph" aria-hidden="true">▾</span>
          </button>
          <span class="dbg-perspective-landmarks-label">Extracts</span>
          <span data-oa="extract-count" class="fa-action-count">—</span>
        </div>
        <div data-oa="extracts-list" class="dbg-perspective-landmarks-list oa-extracts-list">
          <div class="dbg-perspective-landmarks-empty">No extracts yet — click + Extract below.</div>
        </div>
        <div class="fa-actions-footer">
          <button data-oa="add-extract" class="btn-secondary fa-add-action-btn" type="button">+ Extract</button>
          <button data-oa="add-free-extract" class="btn-secondary fa-add-chain-btn" type="button" title="Add a screenshot-based extract: click-and-drag a region instead of picking a DOM element">+ Free Extract</button>
          <!-- v2.74.195 — Extract gate: mirrors fragment-author's ACTION_GATE
               pattern. A header condition + negate flag + body[] of regular
               extracts. Body runs only when (condition satisfied) XOR negate.
               Same amber accent (.fa-add-gate-btn) as the fragment side so
               the gate concept reads consistently across both panels. -->
          <button data-oa="add-extract-gate" class="btn-secondary fa-add-gate-btn" type="button" title="Add a conditional block — body extracts only execute when the header condition is met (or, with negate on, when it isn't)">+ Extract gate</button>
        </div>
      </section>

      <!-- v2.74.23 — Postconditions card with the same collapsible
           pattern as preconditions.
           v2.74.26 — Same chrome + editable rows + + Add footer as the
           preconditions card. -->
      <section data-oa="post-card" class="dbg-perspective-meta-card fa-conditions-card">
        <button class="fa-conditions-collapse-toggle" data-oa="post-toggle" type="button"
                title="Collapse / expand postconditions"
                aria-label="Collapse postconditions" aria-expanded="true">
          <span class="fa-conditions-collapse-chevron" data-oa="post-toggle-glyph" aria-hidden="true">▾</span>
        </button>
        <div class="fa-conditions-content">
          <div class="fa-conditions-head">
            <span class="fa-conditions-label">Postconditions</span>
            <span data-oa="post-source" class="fa-conditions-source">—</span>
          </div>
          <div data-oa="post-body" class="fa-conditions-body">
            <div data-oa="post-list" class="fa-conditions-list">
              <div class="fa-conditions-empty">Captured on Save.</div>
            </div>
            <div class="fa-conditions-footer">
              <button data-oa="add-post" class="btn-secondary fa-add-condition-btn" type="button">+ Add</button>
            </div>
          </div>
        </div>
      </section>

      <!-- v2.74.26 — Name card relocated beneath Postconditions and
           hidden until the author clicks Done. Save button lives inline
           on the same row as the name input; clicking it persists the
           observation (the old "Save Observation" path). -->
      <section data-oa="name-card" class="dbg-perspective-meta-card fa-name-card hidden">
        <div class="fa-name-row">
          <input type="text" data-oa="name-input" maxlength="80"
                 placeholder="Observation name (e.g. Product card data)" />
          <button data-oa="save" class="btn-primary fa-name-save-btn" type="button" disabled>Save</button>
        </div>
      </section>

      <!-- v2.74.26 — Bottom action row: "Done" reveals the Name card and
           collapses every collapsible card; "Cancel" exits to Studio
           without saving (same behaviour the old "Done" button had). -->
      <section class="dbg-perspective-actions">
        <button data-oa="reveal-done" class="btn-primary" type="button">Done</button>
        <button data-oa="cancel" class="btn-secondary" type="button">Cancel</button>
      </section>

      <div data-oa="pick-banner" class="dbg-perspective-pick-banner hidden">
        <span class="dbg-perspective-pick-text">Click an element on the page to pick a selector. Press Esc to cancel.</span>
        <button data-oa="pick-cancel" class="btn-secondary tiny" type="button">Cancel pick</button>
      </div>
    </div>
  `;
}

async function mount(payload, mountEl) {
  _mountEl = mountEl;
  _payload = payload ?? {};
  // v2.74.56 — When mounted via the shell's tab-switch resume path,
  // the payload's tabId may still be null (it was null at BEGIN time;
  // OBSERVATION_AUTHOR_SETUP_RESULT later resolves it but never writes
  // back to the stored payload). Fall back to existingTabId — for
  // Ground-sidepanel-launched authoring that's always the authoring
  // tab.
  _tabId   = _payload.tabId ?? _payload.existingTabId ?? null;
  _verifying = new Set();
  _verified  = new Map();
  _pickerSession = null;
  _snapSession   = null;

  // Seed the draft from the payload. Three callers shape the payload
  // differently:
  //   1. + Observation (new)     — only name/description in payload;
  //                                draft starts with no extracts.
  //   2. Walk Observation (Studio) — name + description seed; existing
  //                                  extracts re-authored from scratch
  //                                  (v2.74.17 design).
  //   3. ✎ Edit Observation (Ground sidepanel, v2.74.149) — full record
  //      seed via `prefilledExtracts` / `prefilledPreconditions` /
  //      `prefilledPostconditions` so the user lands in the saved
  //      state and can tweak in place.
  //
  // Legacy single-extract seed (pre-v2.74.149): a top-level
  // shape/target/output triple from the old BEGIN_OBSERVATION_AUTHOR
  // payload, used by a few early callers. Still honored as a fallback
  // when no prefilledExtracts is provided. A bare `shape` is NOT a
  // seed — background fills it with a 'scalar' default for any caller
  // that omits one, so gating only on `seedShape` would seed an empty
  // starter extract on every new Observation. Require `target` or
  // `output` to count as a single-extract seed.
  const initialExtracts = [];
  if (Array.isArray(_payload.prefilledExtracts) && _payload.prefilledExtracts.length > 0) {
    // Full-record seed (Edit flow). Storage-shape extracts already
    // carry shape/target/output/etc.; we add a per-row _uid for
    // React-like keying without mutating the saved record itself.
    for (const savedEx of _payload.prefilledExtracts) {
      if (!savedEx || typeof savedEx !== 'object') continue;
      // Defensive clone — avoid mutating the storage record (it may
      // still be referenced elsewhere in the caller's memory).
      initialExtracts.push({ ...savedEx, _uid: uid() });
    }
  } else {
    // Legacy single-extract seed path.
    const seedShape  = _payload.shape  || null;
    const seedTarget = _payload.target || '';
    const seedOutput = _payload.output || '';
    const seedExtract = _payload.extract || null;
    if (seedTarget || seedOutput) {
      const shape = getShape(seedShape) ?? getShape('scalar');
      const ex = shape.defaults();
      if (seedTarget) ex.target = seedTarget;
      if (seedOutput) ex.output = seedOutput;
      if (seedShape === 'scalar' && seedExtract) ex.extract = seedExtract;
      ex._uid = uid();
      initialExtracts.push(ex);
    }
  }

  _draft = {
    name: _payload.name ?? '',
    description: _payload.description ?? '',
    extracts: initialExtracts,
    // v2.74.149 — Seed pre/postconditions from the saved record when
    // present (Edit flow). New / Walk flows pass nothing here, so the
    // arrays default to empty.
    preconditions : Array.isArray(_payload.prefilledPreconditions)  ? [..._payload.prefilledPreconditions]  : [],
    postconditions: Array.isArray(_payload.prefilledPostconditions) ? [..._payload.prefilledPostconditions] : [],
  };

  await _loadExtractCapSetting();

  mountEl.innerHTML = renderHTML();

  const q = (key) => mountEl.querySelector(`[data-oa="${key}"]`);
  bannerTitleEl    = q('title');
  bannerSubtitleEl = q('subtitle');
  warningEl        = q('warning');
  nameInputEl      = q('name-input');
  extractsListEl   = q('extracts-list');
  extractCountEl   = q('extract-count');
  addExtractBtnEl  = q('add-extract');
  addFreeExtractBtnEl = q('add-free-extract');
  addExtractGateBtnEl = q('add-extract-gate');
  preListEl        = q('pre-list');
  postListEl       = q('post-list');
  preSourceEl      = q('pre-source');
  postSourceEl     = q('post-source');
  saveBtnEl        = q('save');           // Save button inside the Name card.
  doneRevealBtnEl  = q('reveal-done');    // Bottom "Done" — reveals Name card.
  cancelBtnEl      = q('cancel');         // Bottom "Cancel" — exits to Studio.
  nameCardEl       = q('name-card');
  preAddBtnEl      = q('add-pre');
  postAddBtnEl     = q('add-post');
  // v2.74.26 — Extracts card collapse refs.
  extractsCardEl       = q('extracts-card');
  extractsToggleBtnEl  = q('extracts-toggle');
  extractsToggleGlyphEl = q('extracts-toggle-glyph');
  pickBannerEl     = q('pick-banner');
  pickCancelBtnEl  = q('pick-cancel');
  // v2.74.23 — Antecedent card refs.
  anteCardEl        = q('antecedent-card');
  anteSelectEl      = q('antecedent-select');
  anteRunBtnEl      = q('antecedent-run');
  anteStatusEl      = q('antecedent-status');
  anteParamsWrapEl  = q('antecedent-params-wrap');
  anteParamsInputEl = q('antecedent-params');
  anteParamsOrderEl = q('antecedent-params-order');
  anteToggleBtnEl   = q('antecedent-toggle');
  anteToggleGlyphEl = q('antecedent-toggle-glyph');
  anteBodyEl        = q('antecedent-body');
  anteCollapsedNameEl = q('antecedent-collapsed-name');
  // Pre/post collapse refs.
  preCardEl         = q('pre-card');
  preToggleBtnEl    = q('pre-toggle');
  preToggleGlyphEl  = q('pre-toggle-glyph');
  postCardEl        = q('post-card');
  postToggleBtnEl   = q('post-toggle');
  postToggleGlyphEl = q('post-toggle-glyph');

  if (bannerTitleEl) bannerTitleEl.textContent = _payload?.groundUrl ?? 'Authoring…';
  if (_payload.setupPhase === 'opening' && bannerSubtitleEl) {
    bannerSubtitleEl.textContent = 'Opening tab…';
  }

  if (nameInputEl) {
    nameInputEl.value = _draft.name;
    nameInputEl.addEventListener('input', () => {
      _draft.name = nameInputEl.value;
      _updateSaveState();
    });
  }
  addExtractBtnEl?.addEventListener('click', _onAddExtractClick);
  addFreeExtractBtnEl?.addEventListener('click', _onAddFreeExtractClick);
  addExtractGateBtnEl?.addEventListener('click', _onAddExtractGateClick);
  // v2.74.26 — Save (in Name card) persists; Done reveals Name card +
  // collapses; Cancel exits to Studio without saving.
  saveBtnEl?.addEventListener('click', _onSaveClick);
  doneRevealBtnEl?.addEventListener('click', _onRevealNameClick);
  cancelBtnEl?.addEventListener('click', _onDoneClick);
  // v2.74.26 — + Add condition handlers, mirroring fragment-author.
  preAddBtnEl?.addEventListener('click', () => _onAddCondition('pre'));
  postAddBtnEl?.addEventListener('click', () => _onAddCondition('post'));
  // v2.74.26 — Extracts card collapse toggle. Mounts expanded.
  extractsToggleBtnEl?.addEventListener('click', _toggleExtractsCard);
  pickCancelBtnEl?.addEventListener('click', () => {
    if (_pickerSession) _cancelPick(true);
    if (_snapSession)   _cancelSnap(true);
  });
  // v2.74.23 — Antecedent + collapse handlers.
  anteSelectEl?.addEventListener('change', _onAntecedentChange);
  anteRunBtnEl?.addEventListener('click', _onAntecedentRunClick);
  anteParamsInputEl?.addEventListener('input', () => {
    if (anteStatusEl) anteStatusEl.textContent = '';
  });
  anteToggleBtnEl?.addEventListener('click', _toggleAntecedentCard);
  preToggleBtnEl?.addEventListener('click', _togglePreCard);
  postToggleBtnEl?.addEventListener('click', _togglePostCard);
  // Populate antecedent dropdown from this Ground's fragments.
  _populateAntecedentDropdown();
  _updateAntecedentCardEnabled();
  _renderAntecedentToggle();
  _renderConditionsToggle('pre');
  _renderConditionsToggle('post');
  _renderExtractsToggle();
  // v2.74.26 — Fetch the Ground's perspectives + assertions so the condition-
  // type dropdown can offer Custom + Perspectives optgroups.
  _loadGroundCatalog();

  _renderExtracts();
  _updateSaveState();
}

async function unmount() {
  if (_pickerSession && _tabId != null) {
    try { await cancelPick(_tabId, _pickerSession); } catch {}
  }
  if (_snapSession && _tabId != null) {
    try { await cancelSnap(_tabId, _snapSession); } catch {}
  }
  _pickerSession = null;
  _snapSession   = null;
  _verifying = new Set();
  _verified  = new Map();
  _draft = null;
  _payload = null;
  _tabId = null;
  _setupReady = false;
  _conditionDisplay = { perspectives: new Map(), assertions: new Map() };
  _preSource = '—';
  _postSource = '—';
  // v2.74.23 — Reset antecedent + collapse state. The DOM refs go null
  // automatically once the mount element is cleared.
  anteCardEl = anteSelectEl = anteRunBtnEl = anteStatusEl = null;
  anteParamsInputEl = anteParamsWrapEl = anteParamsOrderEl = null;
  anteToggleBtnEl = anteToggleGlyphEl = anteBodyEl = null;
  anteCollapsedNameEl = null;
  preCardEl = preToggleBtnEl = preToggleGlyphEl = null;
  postCardEl = postToggleBtnEl = postToggleGlyphEl = null;
  // v2.74.26 — Save / Done / Cancel / Name card refs.
  saveBtnEl = doneRevealBtnEl = cancelBtnEl = nameCardEl = null;
  preAddBtnEl = postAddBtnEl = null;
  extractsCardEl = extractsToggleBtnEl = extractsToggleGlyphEl = null;
  _anteFragments = [];
  _anteRunMode = 'run';
  _anteCardCollapsed = false;
  _anteLastExtractCount = 0;
  _preCardCollapsed = false;
  _postCardCollapsed = false;
  _extractsCardCollapsed = false;
  _preUserModified = false;
  _postUserModified = false;
  _groundPerspectives = [];
  _groundAssertions = [];
  if (_mountEl) _mountEl.innerHTML = '';
  _mountEl = null;
}

function handleEvent(message /*, sendResponse */) {
  if (!message) return;

  if (message.type === 'OBSERVATION_AUTHOR_SETUP_RESULT') {
    if (_payload?.observationId && message.payload?.observationId !== _payload.observationId) return;
    if (message.payload?.success) {
      _tabId = message.payload.tabId;
      _setupReady = true;
      if (bannerSubtitleEl) bannerSubtitleEl.textContent = `tab ${_tabId}`;
      _capturePreconditions();
    } else {
      _showWarning(`Setup failed: ${message.payload?.error ?? 'unknown'}`);
    }
    return;
  }

  if (message.type === 'PICK_RESULT') {
    const exIdx = matchPickResult(message, _pickerSession);
    if (exIdx == null) return;
    // v2.74.207 — Capture the gateIdx (if present) BEFORE clearing
    // the session, so we know whether to route to a top-level extract
    // or a body sub of an extract_gate.
    // v2.74.212 — Also capture `condition` flag — when set, route to
    // ex.condition (so the gate's loading-indicator pick lands on
    // ex.condition.selector + ex.condition.frameUrl).
    const sessionGateIdx     = _pickerSession?.gateIdx;
    const sessionIsCondition = _pickerSession?.condition === true;
    const completedSessionId = _pickerSession?.sessionId;
    _pickerSession = null;
    if (pickBannerEl) pickBannerEl.classList.add('hidden');
    // v2.74.168 — Cancel pickers in sibling frames. Without this, the
    // top-frame (and any other arming iframes) keep their overlay +
    // mouse listeners alive after the user picks inside an iframe.
    if (_tabId != null && completedSessionId) {
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
    const ex = _draft.extracts[exIdx];
    if (!ex) return;
    // v2.74.212 — Route to the gate condition when the session was
    // flagged with `condition:true`. Writes selector + frameUrl onto
    // ex.condition. The frameUrl is the critical part: body subs in
    // this gate inherit it via _verifyExtractGateBodySub's fallback,
    // so hand-typed body sub selectors automatically get iframe
    // routing once the condition has been Picked.
    if (sessionIsCondition && ex.shape === 'extract_gate') {
      if (!ex.condition) ex.condition = {};
      ex.condition.selector = selector;
      if (message.frame && message.frame.url) {
        ex.condition.frameUrl = String(message.frame.url);
      } else {
        delete ex.condition.frameUrl;
      }
      // Invalidate the condition's transient verify state — selector
      // changed, prior ✓/✗ is stale.
      delete ex.condition._verified;
      delete ex.condition._verifying;
      _renderExtracts();
      _updateSaveState();
      return;
    }

    // v2.74.207 — Route to a body sub when gateIdx was set on the
    // picker session (i.e., the user clicked Pick on a body sub row
    // inside an extract_gate). Body sub gets its own selector +
    // frameUrl, independent of the gate's condition frame routing.
    // Falls through to the top-level path otherwise.
    if (typeof sessionGateIdx === 'number' && ex.shape === 'extract_gate') {
      const body = Array.isArray(ex.body) ? ex.body : [];
      const sub = body[sessionGateIdx];
      if (!sub) return;
      sub.target = selector;
      if (message.frame && message.frame.url) {
        sub.frameUrl = String(message.frame.url);
      } else {
        delete sub.frameUrl;
      }
      // Invalidate verify state for this body sub.
      _verified.delete(`${exIdx}.${sessionGateIdx}`);
      _verifying.delete(`${exIdx}.${sessionGateIdx}`);
      _renderExtracts();
      _updateSaveState();
      return;
    }
    ex.target = selector;
    // v2.74.198 — Persist iframe origin on the extract. Picker
    // broadcasts to every same-origin frame; when the user clicked
    // inside an iframe, PICK_RESULT carries `frame: { url, isTop:false }`.
    // Without persisting, runtime dispatch (ExecutionEngine OBSERVE
    // messages) broadcasts to all frames and races — usually the top
    // frame responds "not found" first and the iframe's real result
    // is lost. Top-frame picks strip the field for back-compat with
    // legacy records. Symmetric to the fragment-action fix in
    // v2.74.163; should have been applied here at the same time.
    if (message.frame && message.frame.url) {
      ex.frameUrl = String(message.frame.url);
    } else {
      delete ex.frameUrl;
    }
    _verified.delete(exIdx);
    _renderExtracts();
    _updateSaveState();
    return;
  }

  // v2.74.19 — Snap result for free-extract cards. Carries rect (viewport
  // CSS pixels), scrollY at capture time, viewport metadata. Ends the
  // snap session and updates the targeted extract.
  if (message.type === 'SNAP_RESULT') {
    const exIdx = matchSnapResult(message, _snapSession);
    if (exIdx == null) return;
    _snapSession = null;
    if (pickBannerEl) pickBannerEl.classList.add('hidden');
    if (message.error) {
      _showWarning(`Snap error: ${message.error}`);
      return;
    }
    const rect = message.rect ?? null;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
      _showWarning('Snap returned an empty rectangle — drag a region and release');
      return;
    }
    const ex = _draft.extracts[exIdx];
    if (!ex) return;
    ex.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    ex.scrollY  = message.scrollY  ?? 0;
    ex.viewport = message.viewport ?? { width: 0, devicePixelRatio: 1 };
    _verified.delete(exIdx);
    _renderExtracts();
    _updateSaveState();
    return;
  }
}

function _onAddExtractClick() {
  if (!_extractCapUnlimited && _draft.extracts.length >= _extractCap) {
    toast(`Extract cap reached (${_extractCap}). Split into multiple Observations, or set unlimited in Settings.`, 'warn');
    return;
  }
  const ex = getShape('scalar').defaults();
  ex._uid = uid();
  _draft.extracts.push(ex);
  _renderExtracts();
  _updateSaveState();
  _scrollNewestExtractIntoView();
}

// v2.74.19 — + Free Extract. Adds an image_snap card (coordinate-based
// capture). Same cap rules as + Extract; the family of free-extract
// shapes currently has only image_snap, but is structured (via
// freeExtractShapes()) to allow video_snap and other coordinate-based
// shapes to slot in.
function _onAddFreeExtractClick() {
  if (!_extractCapUnlimited && _draft.extracts.length >= _extractCap) {
    toast(`Extract cap reached (${_extractCap}). Split into multiple Observations, or set unlimited in Settings.`, 'warn');
    return;
  }
  const freeShapes = freeExtractShapes();
  const firstFreeShape = freeShapes[0];
  if (!firstFreeShape) {
    toast('No free-extract shapes registered', 'err');
    return;
  }
  const ex = firstFreeShape.defaults();
  ex._uid = uid();
  _draft.extracts.push(ex);
  _renderExtracts();
  _updateSaveState();
  _scrollNewestExtractIntoView();
}

// v2.74.195 — + Extract gate. Adds an extract_gate entry with a header
// condition + negate flag + body[] of regular extracts. Mirrors
// fragment-author's ACTION_GATE shape (line 1265+); the runtime
// evaluates the condition before iterating body (in ExecutionEngine's
// extract loop) so body extracts only execute when the condition is
// met (XOR negate).
function _onAddExtractGateClick() {
  if (!_extractCapUnlimited && _draft.extracts.length >= _extractCap) {
    toast(`Extract cap reached (${_extractCap}). Split into multiple Observations, or set unlimited in Settings.`, 'warn');
    return;
  }
  _draft.extracts.push({
    _uid: uid(),
    shape: 'extract_gate',
    // Condition seed: a default selector_present row. Author edits via
    // the condition-type dropdown — same vocabulary the fragment-author
    // gate accepts (selector_present, selector_absent, url_matches,
    // text_present, attribute_equals, assertion_ref, perspective_ref).
    condition: emptyCondition('selector_present'),
    negate: false,
    body: [],
  });
  _renderExtracts();
  _updateSaveState();
  _scrollNewestExtractIntoView();
}

function _onRemoveExtract(exIdx) {
  _draft.extracts.splice(exIdx, 1);
  // v2.74.205 — Re-key both numeric (top-level extract) and composite
  // ("${gateIdx}.${bodyIdx}") entries. Removing a top-level extract
  // shifts every subsequent extract down by one — whether numeric
  // (top-level entries) or composite (gate body subs whose top-level
  // index just changed). Without this, body-sub verify state
  // orphans / aliases when gates are removed/reordered.
  const newVerified = new Map();
  const newVerifying = new Set();
  const remap = (k) => {
    if (typeof k === 'number') {
      if (k < exIdx)      return k;
      if (k > exIdx)      return k - 1;
      return null; // drop the removed extract's own entry
    }
    if (typeof k === 'string') {
      const dot = k.indexOf('.');
      if (dot < 0) return k;
      const topIdx = parseInt(k.slice(0, dot), 10);
      const rest = k.slice(dot);
      if (!Number.isFinite(topIdx)) return k;
      if (topIdx < exIdx) return k;
      if (topIdx > exIdx) return `${topIdx - 1}${rest}`;
      return null; // drop body subs of the removed gate
    }
    return k;
  };
  _verified.forEach((v, k) => {
    const next = remap(k);
    if (next !== null) newVerified.set(next, v);
  });
  _verifying.forEach(k => {
    const next = remap(k);
    if (next !== null) newVerifying.add(next);
  });
  _verified  = newVerified;
  _verifying = newVerifying;
  _renderExtracts();
  _updateSaveState();
}

// v2.74.195 — Extract gate card rendering. Mirrors fragment-author's
// _renderActionGateCard layout (line 1916+) with extract-specific body.
//
// Body sub-extracts in v1 are rendered as simplified rows: shape
// dropdown + output input + target input. No Pick or per-sub Verify
// buttons (those require composite-key plumbing through the existing
// wireExtractCard system; deferred to a follow-up). The author can
// hand-type a selector or copy-paste from a verified top-level extract.
// Runtime evaluates the gate condition and iterates body sub-extracts
// as if each were a top-level extract.
function _renderExtractGateCard(ex, exIdx, _state) {
  const negate = !!ex.negate;
  const cond = ex.condition ?? { type: 'selector_present', selector: '' };
  const t = cond.type ?? 'selector_present';

  // Condition type options — same family ACTION_GATE accepts. v1
  // doesn't surface assertion_ref / perspective_ref to keep the picker
  // simple; can be added when the broader option-group builder gets
  // shared between fragment-author and observation-author.
  const typeOptions = [
    ['selector_present', 'selector appears'],
    ['selector_absent',  'selector disappears'],
    ['text_present',     'text appears'],
    ['attribute_equals', 'attribute equals'],
    ['url_matches',      'URL matches'],
  ].map(([v, label]) => `<option value="${v}" ${t === v ? 'selected' : ''}>${label}</option>`).join('');

  // Per-type value inputs.
  let valueHtml;
  const attrs = `data-oa-gate-cond="1" data-idx="${exIdx}"`;
  // v2.74.212 — Pick button for the condition's selector field. Added
  // because hand-typing the condition selector (the only path that
  // existed before this) never captured the iframe `frameUrl`, which
  // broke the body-sub fallback chain — every body sub ended up
  // routing verify to the top frame regardless of the gate's true
  // frame context. With a Pick button, the author picks the loading-
  // indicator (or any condition element) in the live iframe, the
  // picker writes `condition.frameUrl`, and every body sub
  // automatically inherits it via _verifyExtractGateBodySub's
  // fallback. Only rendered for condition types that have a selector
  // field — url_matches has none, so no Pick.
  const condPickBtn = `<button class="btn-secondary tiny oa-gate-cond-pick"
                              data-oa-gate-cond-pick="1" data-idx="${exIdx}"
                              type="button" title="Pick the element on the live page">Pick</button>`;
  if (t === 'selector_present' || t === 'selector_absent') {
    valueHtml = `<input type="text" class="cond-value-input"
                        ${attrs} data-field="selector"
                        value="${escAttr(cond.selector ?? '')}"
                        placeholder="CSS selector" />
                 ${condPickBtn}`;
  } else if (t === 'url_matches') {
    valueHtml = `<input type="text" class="cond-value-input"
                        ${attrs} data-field="pattern"
                        value="${escAttr(cond.pattern ?? '')}"
                        placeholder="URL substring or /regex/" />`;
  } else if (t === 'text_present') {
    valueHtml = `
      <input type="text" class="cond-value-input cond-value-narrow"
             ${attrs} data-field="selector"
             value="${escAttr(cond.selector ?? '')}"
             placeholder="CSS selector (optional)" />
      ${condPickBtn}
      <input type="text" class="cond-value-input"
             ${attrs} data-field="text"
             value="${escAttr(cond.text ?? '')}"
             placeholder="Text or {{PARAM}}" />`;
  } else if (t === 'attribute_equals') {
    valueHtml = `
      <input type="text" class="cond-value-input cond-value-narrow"
             ${attrs} data-field="selector"
             value="${escAttr(cond.selector ?? '')}" placeholder="CSS selector" />
      ${condPickBtn}
      <input type="text" class="cond-value-input cond-value-narrow"
             ${attrs} data-field="attribute"
             value="${escAttr(cond.attribute ?? '')}" placeholder="attribute" />
      <input type="text" class="cond-value-input"
             ${attrs} data-field="value"
             value="${escAttr(cond.value ?? '')}" placeholder="expected value" />`;
  } else {
    valueHtml = `<span class="cond-pred-hint cond-pred-hint-empty">unsupported type: ${escHtml(t)}</span>`;
  }

  // Body sub-extracts. Each row: shape select + output input + target input + remove.
  // v2.74.197 — Dropdown restricted to `text` in v1. Other shapes
  // (attribute, scalar, list_of_records, image_*) require additional
  // fields (attribute name, extract.kind, fields[], rect, etc.) that
  // the simplified inline form doesn't author — selecting them would
  // produce a record that fails save validation or runtime dispatch.
  // For richer body shapes, author at top level and arrange ordering
  // so the conditional ones can be grouped manually. If a legacy
  // record loads with a non-`text` body sub, the dropdown surfaces
  // its current shape so the author can see it (and explicitly switch
  // to `text` if they want to fix it).
  const body = Array.isArray(ex.body) ? ex.body : [];
  // v2.74.205 — Per-body-sub verify. The body sub's verify state lives
  // in the shared _verified Map under a composite key
  // `${exIdx}.${gateIdx}` so we can mix top-level (numeric) and
  // body-sub (string) entries without colliding. Status pill renders
  // below the sub row when verified; matches the visual idiom of
  // the gate's condition verify (v2.74.204) and the top-level
  // extract card's status.
  const subRowsHtml = body.length === 0
    ? `<div class="oa-gate-body-empty">No body extracts yet — click "+ Extract" below.</div>`
    : body.map((sub, gIdx) => {
        const subShape = sub?.shape ?? 'text';
        const subOutput = sub?.output ?? '';
        const subTarget = sub?.target ?? '';
        // v2.74.214 — Legacy option shows only when the saved shape is
        // NOT one we expose in the body sub dropdown. Lets the author
        // see a record with an unusual shape without losing the value,
        // then explicitly switch to a supported one.
        // v2.74.219 — click_copy added to supported set.
        const SUPPORTED_BODY_SHAPES = new Set(['text', 'text_last', 'click_copy', 'click_copy_last']);
        const legacyOption = !SUPPORTED_BODY_SHAPES.has(subShape)
          ? `<option value="${escAttr(subShape)}" selected disabled>${escHtml(subShape)} (legacy — switch to text to edit)</option>`
          : '';
        const subKey = `${exIdx}.${gIdx}`;
        const subV = _verified.get(subKey);
        const isSubVerifying = _verifying.has(subKey);
        let subVerifyLabel = 'Verify';
        let subVerifyDisabled = '';
        if (isSubVerifying)             { subVerifyLabel = 'Verifying…'; subVerifyDisabled = 'disabled'; }
        else if (subV?.success === true) { subVerifyLabel = 'Re-verify'; }
        let subStatusHtml = '';
        if (subV) {
          if (subV.success === true) {
            const summary = subV.summary ? escHtml(subV.summary) : 'verified';
            subStatusHtml = `<div class="fa-gate-cond-status status-ok oa-gate-sub-status">✓ ${summary}</div>`;
          } else {
            subStatusHtml = `<div class="fa-gate-cond-status status-err oa-gate-sub-status">✗ ${escHtml(subV.error ?? 'verify failed')}</div>`;
          }
        }
        // v2.74.208 — Body sub rendered as a stacked card mirroring
        // the top-level extract card layout:
        //   Row 1 (head):    [order #] [shape ▾] [OUTPUT ▢]      [✕]
        //   Row 2 (capture): [target ▢]               [Pick] [Verify]
        //   Row 3 (status):  ✓/✗ pill (when verified)
        // Previously every field crammed onto a single 6-control row
        // which made the target input ~80px wide and the controls
        // visually undifferentiated. The new layout matches
        // .oa-extract-card chrome so the body sub reads as a
        // first-class extract — same mental model, indented to show
        // it's nested under the gate.
        return `
          <div class="oa-gate-sub-card" data-idx="${exIdx}" data-gate-idx="${gIdx}">
            <div class="oa-gate-sub-head">
              <span class="oa-extract-order">${gIdx + 1}.</span>
              <select class="oa-gate-sub-shape" data-oa-gate-sub="1" data-idx="${exIdx}" data-gate-idx="${gIdx}" data-field="shape">
                <option value="text"             ${subShape === 'text'             ? 'selected' : ''}>text</option>
                <option value="text_last"        ${subShape === 'text_last'        ? 'selected' : ''}>text (latest)</option>
                <option value="click_copy"       ${subShape === 'click_copy'       ? 'selected' : ''}>click copy → clipboard</option>
                <option value="click_copy_last"  ${subShape === 'click_copy_last'  ? 'selected' : ''}>click copy (latest) → clipboard</option>
                ${legacyOption}
              </select>
              <input type="text" class="oa-gate-sub-output"
                     data-oa-gate-sub="1" data-idx="${exIdx}" data-gate-idx="${gIdx}" data-field="output"
                     value="${escAttr(subOutput)}" placeholder="OUTPUT_NAME" />
              <button class="btn-action danger" data-oa-gate-sub-remove="1" data-idx="${exIdx}" data-gate-idx="${gIdx}" type="button" title="Remove this extract">✕</button>
            </div>
            <div class="oa-gate-sub-capture">
              <input type="text" class="oa-gate-sub-target"
                     data-oa-gate-sub="1" data-idx="${exIdx}" data-gate-idx="${gIdx}" data-field="target"
                     value="${escAttr(subTarget)}" placeholder="${(subShape === 'click_copy' || subShape === 'click_copy_last') ? 'CSS selector (copy button)' : 'CSS selector (target element)'}" />
              <button class="btn-secondary tiny oa-gate-sub-pick"
                      data-oa-gate-sub-pick="1" data-idx="${exIdx}" data-gate-idx="${gIdx}"
                      type="button" title="Pick the element on the live page">Pick</button>
              <button class="btn-secondary tiny oa-gate-sub-verify"
                      data-oa-gate-sub-verify="1" data-idx="${exIdx}" data-gate-idx="${gIdx}"
                      type="button" ${subVerifyDisabled}>${subVerifyLabel}</button>
              <button class="btn-secondary tiny oa-gate-sub-inspect"
                      data-oa-gate-sub-inspect="1" data-idx="${exIdx}" data-gate-idx="${gIdx}"
                      type="button" title="Dump matched element details to Logs (no extraction)">Inspect</button>
              <button class="btn-secondary tiny oa-gate-sub-ask-claude"
                      data-oa-gate-sub-ask-claude="1" data-idx="${exIdx}" data-gate-idx="${gIdx}"
                      type="button" title="Ask Claude to suggest a more stable selector for this element">Ask Claude</button>
            </div>
            ${_renderAskClaudeSuggestion(exIdx, gIdx)}
            ${subStatusHtml}
          </div>`;
      }).join('');

  return `
    <div class="dbg-perspective-landmark-row fa-action-row fa-action-gate-card oa-extract-gate-card" data-idx="${exIdx}">
      <div class="fa-action-head">
        <span class="fa-order">${exIdx + 1}.</span>
        <span class="fa-action-head-label">GATE${negate ? ' <span class="fa-gate-negate-tag">(negated)</span>' : ''}</span>
        <span class="fa-action-head-spacer"></span>
        <button class="btn-action danger" data-oa-gate-action="remove-gate" data-idx="${exIdx}" title="Remove extract gate" type="button">✕</button>
      </div>
      <div class="fa-action-body fa-gate-head-body">
        <div class="fa-gate-cond-row">
          <select class="cond-type-select" data-oa-gate-cond="1" data-idx="${exIdx}" data-field="type">${typeOptions}</select>
          ${valueHtml}
          ${(() => {
            // v2.74.204 — Verify button on the extract gate condition.
            // Mirrors fragment-author's gate text_present verify (v2.74.172)
            // but generalized: works for every condition type the gate
            // accepts (selector_present, selector_absent, text_present,
            // attribute_equals, url_matches). Click → sends CHECK_CONDITION
            // to the iframe (frame-aware via condition.frameUrl) → renders
            // ✓/✗ + snippet inline below. Verify is one-shot at authoring
            // time (ignores waitTimeout — that's a runtime behavior).
            const v = cond._verified;
            const isVerifying = cond._verifying === true;
            let verifyLabel = 'Verify';
            let verifyDisabled = '';
            if (isVerifying)            { verifyLabel = 'Verifying…'; verifyDisabled = 'disabled'; }
            else if (v?.success === true) { verifyLabel = 'Re-verify'; }
            return `<button class="dbg-perspective-landmark-verify fa-gate-cond-verify"
                            data-oa-gate-action="verify-cond" data-idx="${exIdx}"
                            type="button" ${verifyDisabled}>${verifyLabel}</button>`;
          })()}
        </div>
        ${(() => {
          // v2.74.204 — Condition verify status row. Same visual idiom as
          // fragment-author's gate condition status (.fa-gate-cond-status
          // pills + snippet). Renders only after a verify attempt; cleared
          // on any condition-field edit so a stale verification doesn't
          // mislead the author.
          if (!cond._verified) return '';
          const v = cond._verified;
          if (v.error) {
            return `<div class="fa-gate-cond-status status-err">✗ ${escHtml(v.error)}</div>`;
          }
          const typeLabel = (() => {
            switch (cond.type) {
              case 'selector_present':  return `Selector "${cond.selector ?? ''}" appears`;
              case 'selector_absent':   return `Selector "${cond.selector ?? ''}" is absent`;
              case 'text_present':      return `Text "${cond.text ?? ''}" appears in section`;
              case 'attribute_equals':  return `${cond.selector ?? ''}[${cond.attribute ?? ''}] = "${cond.value ?? ''}"`;
              case 'url_matches':       return `URL matches /${cond.pattern ?? ''}/`;
              default:                  return cond.type ?? '?';
            }
          })();
          const headline = v.success === true
            ? `<div class="fa-gate-cond-status status-ok">✓ ${escHtml(typeLabel)}</div>`
            : `<div class="fa-gate-cond-status status-err">✗ ${escHtml(typeLabel)} — not met</div>`;
          const snippetHtml = (v.snippet && v.elementFound !== false)
            ? `<div class="fa-gate-cond-status-snippet" title="${escAttr(v.snippet)}"><span class="fa-gate-cond-status-snippet-label">section text:</span> ${escHtml(v.snippet)}</div>`
            : '';
          return `${headline}${snippetHtml}`;
        })()}
        <div class="fa-gate-negate-row">
          <label class="toggle-switch fa-action-toggle" title="When negate is on, the body runs when the condition is NOT met.">
            <input type="checkbox" data-oa-gate-negate="1" data-idx="${exIdx}" ${negate ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="fa-toggle-label">negate</span>
          </label>
          <span class="fa-gate-hint">${negate
            ? 'Body extracts run when the condition is NOT met.'
            : 'Body extracts run when the condition IS met.'}</span>
        </div>
        <!-- v2.74.201 — Wait-aware extract gate.
             v2.74.202 — Text input + chips (same layout as fragment-
             author ACTION_GATE). Chips give one-click presets for the
             common cases — chat-extract typically wants 30s; quick
             settles want 1s. -->
        <div class="fa-gate-wait-row" title="When set > 0, the condition is retried for up to this many milliseconds before deciding. Lets the gate wait for the right page state before extracting.">
          <span class="fa-gate-wait-label">wait up to</span>
          <input type="text" inputmode="numeric" pattern="[0-9]*"
                 class="fa-gate-wait-input"
                 data-oa-gate-wait="1" data-idx="${exIdx}"
                 value="${escAttr(String(ex.waitTimeout ?? ''))}"
                 placeholder="0" />
          <span class="fa-gate-wait-suffix">ms (0 = check once)</span>
          <div class="fa-gate-wait-chips" data-idx="${exIdx}">
            <button class="fa-gate-wait-chip" data-oa-gate-wait-chip="500"   data-idx="${exIdx}" type="button" title="500ms — quick UI settle">500ms</button>
            <button class="fa-gate-wait-chip" data-oa-gate-wait-chip="1000"  data-idx="${exIdx}" type="button" title="1s — typical animation">1s</button>
            <button class="fa-gate-wait-chip" data-oa-gate-wait-chip="3000"  data-idx="${exIdx}" type="button" title="3s — page transitions">3s</button>
            <button class="fa-gate-wait-chip" data-oa-gate-wait-chip="10000" data-idx="${exIdx}" type="button" title="10s — network calls">10s</button>
            <button class="fa-gate-wait-chip" data-oa-gate-wait-chip="30000" data-idx="${exIdx}" type="button" title="30s — LLM streaming, long ops">30s</button>
            <button class="fa-gate-wait-chip" data-oa-gate-wait-chip="60000" data-idx="${exIdx}" type="button" title="60s — extended async ops">1m</button>
            <button class="fa-gate-wait-chip fa-gate-wait-chip-clear" data-oa-gate-wait-chip="0" data-idx="${exIdx}" type="button" title="Clear — gate becomes one-shot">clear</button>
          </div>
        </div>
      </div>
      <div class="fa-chain-body fa-gate-body">
        <div class="fa-chain-body-label">Extracts (${body.length}) — run conditionally:</div>
        ${subRowsHtml}
        <div class="fa-chain-add-branch-row fa-gate-add-row">
          <button class="btn-secondary fa-chain-add-branch-btn"
                  data-oa-gate-action="add-sub" data-idx="${exIdx}"
                  type="button">+ Extract</button>
        </div>
      </div>
    </div>`;
}

function _wireExtractGateCard(listEl, _ex, exIdx) {
  const cardEl = listEl.querySelector(`.oa-extract-gate-card[data-idx="${exIdx}"]`);
  if (!cardEl) return;

  // Condition type select.
  cardEl.querySelector(`select.cond-type-select[data-oa-gate-cond]`)?.addEventListener('change', (e) => {
    const a = _draft.extracts[exIdx];
    if (!a) return;
    const newType = e.target.value;
    const fresh = emptyCondition(newType);
    // Preserve overlapping fields across the type swap (same pattern as
    // fragment-author's gate type-change handler).
    const old = a.condition ?? {};
    for (const f of ['selector', 'attribute', 'value', 'text', 'pattern']) {
      if (old[f] != null && fresh[f] !== undefined) fresh[f] = old[f];
    }
    if (old.frameUrl) fresh.frameUrl = old.frameUrl;
    a.condition = fresh;
    _renderExtracts();
    _updateSaveState();
  });

  // Condition value inputs.
  cardEl.querySelectorAll(`input.cond-value-input[data-oa-gate-cond]`).forEach(inp => {
    const handler = (e) => {
      const a = _draft.extracts[exIdx];
      const field = e.target.dataset.field;
      if (!a || !a.condition || !field) return;
      a.condition[field] = e.target.value;
      // v2.74.204 — Invalidate the transient verify result whenever the
      // condition changes — a stale ✓/✗ status pointing at the prior
      // selector/text/etc. would be misleading. Re-render only when
      // the verify state was actually showing.
      if (a.condition._verified !== undefined || a.condition._verifying !== undefined) {
        delete a.condition._verified;
        delete a.condition._verifying;
        _renderExtracts();
      }
      _updateSaveState();
    };
    inp.addEventListener('input',  handler);
    inp.addEventListener('change', handler);
  });

  // Negate toggle.
  cardEl.querySelector(`input[data-oa-gate-negate]`)?.addEventListener('change', (e) => {
    const a = _draft.extracts[exIdx];
    if (!a) return;
    a.negate = !!e.target.checked;
    _renderExtracts();
    _updateSaveState();
  });

  // v2.74.201 — Wait-timeout input. Empty / 0 → one-shot condition
  // check (current behavior). > 0 → retry the condition for that
  // many ms before deciding. Persisted on the gate's `waitTimeout`
  // field; runtime threads it through to checkConditions's timeoutMs.
  // v2.74.202 — Text input + digit-only sanitization + preset chips.
  cardEl.querySelector(`input[data-oa-gate-wait]`)?.addEventListener('input', (e) => {
    const a = _draft.extracts[exIdx];
    if (!a) return;
    const cleaned = (e.target.value ?? '').replace(/\D+/g, '');
    if (cleaned !== e.target.value) e.target.value = cleaned;
    const raw = parseInt(cleaned, 10);
    if (Number.isFinite(raw) && raw > 0) {
      a.waitTimeout = raw;
    } else {
      delete a.waitTimeout;
    }
    _updateSaveState();
  });
  cardEl.querySelectorAll(`button[data-oa-gate-wait-chip]`).forEach(btn => {
    btn.addEventListener('click', (e) => {
      const a = _draft.extracts[exIdx];
      if (!a) return;
      const ms = parseInt(e.currentTarget.dataset.oaGateWaitChip, 10);
      if (Number.isFinite(ms) && ms > 0) {
        a.waitTimeout = ms;
      } else {
        delete a.waitTimeout;
      }
      const inp = cardEl.querySelector(`input[data-oa-gate-wait]`);
      if (inp) inp.value = ms > 0 ? String(ms) : '';
      _updateSaveState();
    });
  });

  // Body sub-extract field inputs (shape select, output, target).
  cardEl.querySelectorAll(`[data-oa-gate-sub]`).forEach(el => {
    const handler = (e) => {
      const a = _draft.extracts[exIdx];
      const gIdx = parseInt(e.target.dataset.gateIdx, 10);
      const field = e.target.dataset.field;
      if (!a || !Array.isArray(a.body) || !a.body[gIdx] || !field) return;
      // v2.74.205 — Any body-sub edit invalidates its verify state.
      // Drop the entry so a stale ✓ doesn't point at the prior values.
      const subKey = `${exIdx}.${gIdx}`;
      const hadVerify = _verified.has(subKey) || _verifying.has(subKey);
      if (hadVerify) {
        _verified.delete(subKey);
        _verifying.delete(subKey);
      }
      if (field === 'output') {
        // Same normalization the regular extract row applies: uppercase,
        // strip whitespace. Keeps gate-body and top-level outputs
        // consistent so cache reads behave the same way.
        const norm = e.target.value.replace(/\s/g, '').toUpperCase();
        a.body[gIdx][field] = norm;
        e.target.value = norm;
        if (hadVerify) _renderExtracts();
        _updateSaveState();
        return;
      }
      if (field === 'shape') {
        // v2.74.197 — Shape switch: rebuild the body sub with the new
        // shape's defaults, carrying output + target across. Without
        // this, switching scalar → attribute kept the stale
        // `ex.extract` field from scalar and didn't add the required
        // `ex.attribute` field — save validation then rejected the
        // record. Mirrors the regular extract card's shape-switch
        // logic (extractCard.js line 219+).
        const newShapeId = e.target.value;
        const newShape = getShape(newShapeId);
        if (!newShape) return;
        const old = a.body[gIdx];
        const carriedOutput = old.output ?? '';
        const carriedTarget = old.target ?? '';
        Object.keys(old).forEach(k => delete old[k]);
        Object.assign(old, newShape.defaults());
        old.output = carriedOutput;
        old.target = carriedTarget;
        old._uid = uid();
        _renderExtracts();   // full re-render so the row reflects the new defaults
        _updateSaveState();
        return;
      }
      a.body[gIdx][field] = e.target.value;
      // v2.74.211 — KEEP frameUrl on hand-typing (was: dropped). The
      // iframe binding established by the picker should survive
      // selector edits. Dropping it silently rerouted verify to the
      // top frame, where iframe-scoped chat selectors match 0
      // elements. Re-Pick to switch frames; until then, the existing
      // frameUrl stays attached. Mirrors the extractCard.js change.
      if (hadVerify) _renderExtracts();
      _updateSaveState();
    };
    el.addEventListener('input',  handler);
    el.addEventListener('change', handler);
  });

  // Action buttons (remove gate, add sub, remove sub).
  cardEl.querySelectorAll(`[data-oa-gate-action]`).forEach(btn => {
    btn.addEventListener('click', (e) => {
      const action = e.currentTarget.dataset.oaGateAction;
      if (action === 'remove-gate') {
        _onRemoveExtract(exIdx);
      } else if (action === 'add-sub') {
        const a = _draft.extracts[exIdx];
        if (!a) return;
        if (!Array.isArray(a.body)) a.body = [];
        // v2.74.197 — Default body sub to `text` shape (just target +
        // output) to match the simplified inline form. Avoids the
        // scalar-defaults-leak-extract-field issue and keeps the body
        // sub's shape consistent with what the dropdown can author.
        const sub = getShape('text').defaults();
        sub._uid = uid();
        a.body.push(sub);
        _renderExtracts();
        _updateSaveState();
      } else if (action === 'verify-cond') {
        // v2.74.204 — Live-page condition verify. Async; renders
        // "Verifying…" while in flight, then ✓/✗ status when done.
        _verifyExtractGateCondition(exIdx);
      }
    });
  });
  // v2.74.205 — Per-body-sub verify buttons.
  cardEl.querySelectorAll(`[data-oa-gate-sub-verify]`).forEach(btn => {
    btn.addEventListener('click', (e) => {
      const gIdx = parseInt(e.currentTarget.dataset.gateIdx, 10);
      _verifyExtractGateBodySub(exIdx, gIdx);
    });
  });
  // v2.74.207 — Per-body-sub Pick buttons. Starts a picker session
  // tagged with both extractIdx (top-level gate) and gateIdx (body
  // sub index) so the PICK_RESULT handler can route the captured
  // selector to the right body sub.
  cardEl.querySelectorAll(`[data-oa-gate-sub-pick]`).forEach(btn => {
    btn.addEventListener('click', (e) => {
      const gIdx = parseInt(e.currentTarget.dataset.gateIdx, 10);
      _onPickBodySubClick(exIdx, gIdx);
    });
  });
  // v2.74.212 — Gate condition Pick button. Picker session is flagged
  // with `condition:true` so PICK_RESULT routes the captured selector
  // to `ex.condition.selector` and `ex.condition.frameUrl` instead of
  // the top-level extract or a body sub. The frameUrl is the whole
  // point — once set, every body sub in this gate inherits it via
  // the v2.74.206/.210 fallback chain.
  cardEl.querySelectorAll(`[data-oa-gate-cond-pick]`).forEach(btn => {
    btn.addEventListener('click', () => {
      _onPickGateConditionClick(exIdx);
    });
  });
  // v2.74.213 — Per-body-sub Inspect button. Dispatches INSPECT_ELEMENT
  // (no extraction) and logs the structured report to the Logs tab.
  // Designed for diagnosing "selector matched but returned empty" —
  // e.g. selector landed on a scroll anchor div with no text
  // descendants. Same frame-routing fallback as verify.
  cardEl.querySelectorAll(`[data-oa-gate-sub-inspect]`).forEach(btn => {
    btn.addEventListener('click', (e) => {
      const gIdx = parseInt(e.currentTarget.dataset.gateIdx, 10);
      _inspectExtractGateBodySub(exIdx, gIdx);
    });
  });
  // v2.74.229 — Per-body-sub "Ask Claude" button. Runs Inspect against
  // the current target to capture DOM context, ships it to Claude with
  // the author's intent (shape), and renders the returned candidate
  // selector inline with accept / dismiss controls.
  cardEl.querySelectorAll(`[data-oa-gate-sub-ask-claude]`).forEach(btn => {
    btn.addEventListener('click', (e) => {
      const gIdx = parseInt(e.currentTarget.dataset.gateIdx, 10);
      _askClaudeForBodySubSelector(exIdx, gIdx);
    });
  });
  // v2.74.229 — Accept / dismiss buttons inside the suggestion bar.
  cardEl.querySelectorAll(`[data-oa-gate-sub-claude-accept]`).forEach(btn => {
    btn.addEventListener('click', (e) => {
      const gIdx = parseInt(e.currentTarget.dataset.gateIdx, 10);
      _acceptClaudeSuggestion(exIdx, gIdx);
    });
  });
  cardEl.querySelectorAll(`[data-oa-gate-sub-claude-dismiss]`).forEach(btn => {
    btn.addEventListener('click', (e) => {
      const gIdx = parseInt(e.currentTarget.dataset.gateIdx, 10);
      _dismissClaudeSuggestion(exIdx, gIdx);
    });
  });
  cardEl.querySelectorAll(`[data-oa-gate-sub-remove]`).forEach(btn => {
    btn.addEventListener('click', (e) => {
      const a = _draft.extracts[exIdx];
      const gIdx = parseInt(e.currentTarget.dataset.gateIdx, 10);
      if (!a || !Array.isArray(a.body)) return;
      a.body.splice(gIdx, 1);
      // v2.74.205 — Clean up the body sub's verify entry. Following
      // body subs' composite keys also shift, so we re-map them down
      // by one. Without this, a remove leaves stale verify state
      // pointing at the wrong sub.
      const removedKey = `${exIdx}.${gIdx}`;
      _verified.delete(removedKey);
      _verifying.delete(removedKey);
      // Shift composite keys for higher gate indices down by one.
      const prefix = `${exIdx}.`;
      const toShift = [];
      _verified.forEach((v, k) => {
        if (typeof k === 'string' && k.startsWith(prefix)) {
          const oldGIdx = parseInt(k.slice(prefix.length), 10);
          if (oldGIdx > gIdx) toShift.push({ from: k, to: `${exIdx}.${oldGIdx - 1}`, value: v });
        }
      });
      for (const { from, to, value } of toShift) {
        _verified.delete(from);
        _verified.set(to, value);
      }
      _renderExtracts();
      _updateSaveState();
    });
  });
}

/**
 * v2.74.204 — Verify an extract gate's condition against the live
 * page. Sends CHECK_CONDITION through the existing content-script
 * evaluator with the gate's frameUrl for iframe routing. Result lands
 * on `cond._verified` so the gate card's status row renders ✓/✗ +
 * snippet (same visual idiom as fragment-author's text_present
 * verify). One-shot at authoring time — ignores `waitTimeout` (which
 * is a runtime-only behavior; tying up the authoring session for 30s
 * isn't useful).
 *
 * Substitution: `{{PARAM}}` tokens in condition fields get replaced
 * with the sentinel 'flying turtle' for the verify probe — matches
 * fragment-author's verifyHelper convention. The author can confirm
 * the condition structure works without binding real parameters.
 */
async function _verifyExtractGateCondition(exIdx) {
  const ex = _draft.extracts[exIdx];
  if (!ex || ex.shape !== 'extract_gate') return;
  const cond = ex.condition;
  if (!cond || typeof cond.type !== 'string' || !cond.type) {
    if (cond) {
      cond._verified = { success: false, error: 'Pick a condition type first' };
      _renderExtracts();
    }
    return;
  }
  if (_tabId == null) {
    cond._verified = { success: false, error: 'No active tab — cancel and start over' };
    _renderExtracts();
    return;
  }

  const sub = (s) => typeof s === 'string'
    ? s.replace(/\{\{[A-Z0-9_]+\}\}/g, 'flying turtle')
    : s;
  const probedCond = {
    type     : cond.type,
    selector : sub(cond.selector ?? ''),
    text     : sub(cond.text ?? ''),
    value    : sub(cond.value ?? ''),
    attribute: cond.attribute,        // attribute NAME, not a substitution target
    pattern  : cond.pattern,          // regex literal — untouched
  };

  // Resolve frame from cond.frameUrl (gate condition can be iframe-
  // bound — see v2.74.177). Use chrome.webNavigation.getAllFrames
  // since this module doesn't import TemplateWalker. Falls back to
  // top frame on miss.
  let targetFrameId = 0;
  if (cond.frameUrl && typeof cond.frameUrl === 'string' && cond.frameUrl.trim()) {
    try {
      const frames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId: _tabId }, (fs) => resolve(fs ?? []));
      });
      const exact = frames.find(f => f && f.url === cond.frameUrl);
      if (exact) {
        targetFrameId = exact.frameId;
      } else {
        let savedOrigin = null;
        try { savedOrigin = new URL(cond.frameUrl).origin; } catch {}
        if (savedOrigin) {
          const om = frames.find(f => {
            if (!f?.url) return false;
            try { return new URL(f.url).origin === savedOrigin; } catch { return false; }
          });
          if (om) targetFrameId = om.frameId;
        }
      }
    } catch { /* fall through with frameId=0 */ }
  }

  cond._verifying = true;
  delete cond._verified;
  _renderExtracts();

  let res;
  try {
    res = await chrome.tabs.sendMessage(_tabId, {
      type: 'CHECK_CONDITION',
      payload: { condition: probedCond },
    }, { frameId: targetFrameId });
  } catch (e) {
    cond._verifying = false;
    cond._verified = { success: false, error: `Verify failed: ${e?.message ?? String(e)}` };
    _renderExtracts();
    return;
  }

  cond._verifying = false;
  if (res?.error) {
    cond._verified = { success: false, error: res.error };
  } else if (res?.matched === true) {
    cond._verified = {
      success: true,
      snippet: res.snippet ?? '',
      elementFound: res?.elementFound !== false,
    };
  } else {
    cond._verified = {
      success: false,
      elementFound: res?.elementFound !== false,
      snippet: res?.snippet ?? '',
    };
  }
  _renderExtracts();
  _updateSaveState();
}

/**
 * v2.74.205 — Verify a single body sub-extract inside an extract gate.
 * Reuses the existing top-level extract verify dispatcher
 * (_dispatchObserveForVerify), which is already iframe-aware
 * (v2.74.199 fix) — so a body sub picked inside an iframe routes
 * its OBSERVE_* probe to that frame. State lives in the shared
 * _verified Map under a composite string key `${exIdx}.${gateIdx}`
 * so it can coexist with the numeric keys for top-level extracts.
 */
async function _verifyExtractGateBodySub(exIdx, gateIdx) {
  const gate = _draft?.extracts?.[exIdx];
  if (!gate || gate.shape !== 'extract_gate') return;
  const sub = Array.isArray(gate.body) ? gate.body[gateIdx] : null;
  if (!sub) return;
  if (_tabId == null) {
    _showWarning('No active tab. Cancel and start over.');
    return;
  }
  const key = `${exIdx}.${gateIdx}`;

  // Pre-flight: same checks the top-level verify does.
  if (!(sub.output ?? '').toString().trim()) {
    _verified.set(key, { success: false, error: 'Output binding name required' });
    _renderExtracts();
    return;
  }
  if (!(sub.target ?? '').toString().trim()) {
    _verified.set(key, { success: false, error: 'Target selector required' });
    _renderExtracts();
    return;
  }
  const shape = getShape(sub.shape);
  if (!shape) {
    _verified.set(key, { success: false, error: `Unknown shape "${sub.shape}"` });
    _renderExtracts();
    return;
  }
  const validationErr = shape.validate?.(sub);
  if (validationErr) {
    _verified.set(key, { success: false, error: validationErr });
    _renderExtracts();
    return;
  }

  _verifying.add(key);
  _renderExtracts();

  // v2.74.206 — Body sub inherits the gate condition's frameUrl when
  // the sub doesn't have its own. Body sub authoring has a Pick
  // button (added in v2.74.207) but authors often type the selector
  // by hand — that drops the frameUrl per extractCard's input
  // handler. The body almost always lives in the same frame as the
  // gate condition (you're picking the loading-indicator condition
  // AND the reply-text extract inside the same iframe). Without
  // this inheritance, verify routes to the top frame and the
  // iframe-scoped selector fails with "no element matched."
  //
  // v2.74.210 — Two-step fallback. (1) prefer the body sub's own
  // frameUrl; (2) inherit from the gate condition; (3) inherit from
  // a sibling body sub that has frameUrl set (covers the case where
  // the condition was typed by hand but another body sub was Pick-
  // set in the iframe). The probe extract is a fresh object —
  // doesn't mutate the saved sub. Matches the runtime fix in
  // ExecutionEngine.
  let inheritedFrameUrl = null;
  if (!sub.frameUrl) {
    if (gate.condition?.frameUrl) {
      inheritedFrameUrl = gate.condition.frameUrl;
    } else if (Array.isArray(gate.body)) {
      const sibling = gate.body.find((b, i) => i !== gateIdx && b?.frameUrl);
      if (sibling) inheritedFrameUrl = sibling.frameUrl;
    }
  }
  const probeSub = inheritedFrameUrl
    ? { ...sub, frameUrl: inheritedFrameUrl }
    : sub;

  let result;
  try {
    result = await _dispatchObserveForVerify(probeSub);
  } catch (e) {
    _verifying.delete(key);
    _verified.set(key, { success: false, error: e?.message ?? String(e) });
    _renderExtracts();
    _updateSaveState();
    return;
  }

  _verifying.delete(key);
  if (!result?.success) {
    const errMsg = result?.error ?? 'verify failed';
    _verified.set(key, { success: false, error: errMsg });
    // v2.74.209 — Mirror to Logs so the full diagnostic (which can
    // be long once the prefix-walker appends matched-prefix +
    // child-tag breakdown) is copy-pasteable from the Logs tab.
    Logger.warn('observation-author', `Extract gate body sub verify failed [exIdx=${exIdx} gateIdx=${gateIdx}]`, {
      output: sub.output,
      target: sub.target,
      shape: sub.shape,
      frameUrl: probeSub.frameUrl ?? null,
      error: errMsg,
    });
  } else {
    // Build a compact summary similar to _summarizeResult but inline
    // here — body subs only support `text` shape in v1, so the
    // summary is the captured innerText (truncated). Future shapes
    // (attribute, scalar) would extend this branch.
    let summary = `${sub.output} captured`;
    if (typeof result.value === 'string') {
      const t = result.value.replace(/\s+/g, ' ').trim();
      summary = `${sub.output}: "${t.length > 60 ? t.slice(0, 60) + '…' : t}"`;
    } else if (result.value != null) {
      summary = `${sub.output}: ${String(result.value).slice(0, 60)}`;
    }
    // v2.74.214 — When text_last was used, append "(last of N)" so the
    // author sees how many matches existed. Validates that pickLast
    // is doing useful work — N=1 means text and text_last behave
    // identically; N>1 confirms feed-tail semantics.
    // v2.74.216 — Also mention textMode (innerText vs textContent) so
    // the author understands why text_last and text may return slightly
    // different lengths for the same selector.
    if (result.pickLastUsed && typeof result.matchCount === 'number') {
      summary += ` (last of ${result.matchCount}${result.textMode ? `, via ${result.textMode}` : ''})`;
    }
    // v2.74.219 — click_copy captures via the clipboard rather than a
    // DOM walk. Mention it in the summary so the author sees the
    // capture path at a glance — "via clipboard, NNN chars."
    // v2.74.222 — When click_copy_last is in play (pickLast on a copy
    // button), also surface "(last of N buttons)" so the author can
    // confirm the latest-message semantic is doing real work.
    // v2.74.224 — Three capture paths now (main-world-patch, copy-event,
    // clipboard). Surface which one fired — main-world-patch indicates
    // the focus-bypass path worked; clipboard means the older offscreen
    // read was needed.
    if (result.via) {
      const tag = result.via === 'main-world-patch' ? 'via writeText patch'
                : result.via === 'copy-event'       ? 'via copy event'
                : result.via === 'clipboard'        ? 'via system clipboard'
                : `via ${result.via}`;
      if (result.pickLastUsed && typeof result.matchCount === 'number' && result.matchCount > 1) {
        summary += ` (${tag}, ${result.valueLength ?? 0} chars, last of ${result.matchCount} buttons)`;
      } else {
        summary += ` (${tag}, ${result.valueLength ?? 0} chars)`;
      }
    }
    _verified.set(key, { success: true, summary, value: result.value });
    // v2.74.217 — Log the FULL captured value to the Logs tab. The
    // verify status pill only fits ~60 chars of preview; for chat
    // replies and other rich extractions, the author wants the
    // complete text (including any tables/lists the AI rendered)
    // to confirm the extraction is right. Mirrors the Inspect tool
    // pattern — pill is at-a-glance, Logs is the full record.
    Logger.info('observation-author', `Body sub verify captured [exIdx=${exIdx} gateIdx=${gateIdx}]`, {
      output       : sub.output,
      shape        : sub.shape,
      target       : sub.target,
      frameUrl     : probeSub.frameUrl ?? null,
      matchCount   : result.matchCount ?? null,
      pickLastUsed : result.pickLastUsed ?? null,
      textMode     : result.textMode ?? null,
      // v2.74.225 — `via` distinguishes which click_copy capture path
      // fired: 'main-world-patch' = writeText intercept (best — works
      // without focus); 'copy-event' = execCommand path; 'clipboard'
      // = offscreen system read (focus-sensitive). Critical for
      // diagnosing "the click did nothing" — if via is undefined,
      // ALL paths failed.
      via          : result.via ?? null,
      valueType    : typeof result.value,
      valueLength  : typeof result.value === 'string' ? result.value.length : null,
      value        : result.value,
    });
  }
  _renderExtracts();
  _updateSaveState();
}

/**
 * v2.74.213 — Inspect a body sub's matched element. Dispatches
 * INSPECT_ELEMENT (no extraction side-effects) and logs the structured
 * report to the Logs tab. Solves the "✓ REPLY: \"\"" puzzle: the
 * selector matched, but what did it match? The report shows the
 * element's tag, attrs, children, text length, outerHTML preview, etc.
 *
 * Uses the same frame-routing fallback chain as verify (sub.frameUrl →
 * gate.condition.frameUrl → sibling sub's frameUrl) so the inspection
 * runs in the same frame extraction would.
 *
 * Toast on completion so the author knows to check Logs.
 */
/**
 * v2.74.229 — Inline renderer for the Ask-Claude suggestion bar that
 * sits beneath a body sub's capture row. Pulls state from
 * `_askClaudeState` (keyed `${exIdx}.${gIdx}`) and renders one of:
 *   - asking: "Asking Claude…" spinner row
 *   - ready:  candidate selector + Accept / Dismiss buttons
 *   - error:  short error message + Dismiss
 *   - none:   empty string (renders nothing)
 */
function _renderAskClaudeSuggestion(exIdx, gateIdx) {
  const key = `${exIdx}.${gateIdx}`;
  const entry = _askClaudeState.get(key);
  if (!entry) return '';
  if (entry.status === 'asking') {
    return `<div class="oa-gate-sub-claude oa-gate-sub-claude-asking">⌛ Asking Claude for a more stable selector…</div>`;
  }
  if (entry.status === 'error') {
    return `<div class="oa-gate-sub-claude oa-gate-sub-claude-error">
              <span class="oa-gate-sub-claude-label">Ask Claude failed:</span>
              <span class="oa-gate-sub-claude-msg">${escHtml(entry.error ?? 'unknown error')}</span>
              <button class="btn-secondary tiny" data-oa-gate-sub-claude-dismiss="1" data-idx="${exIdx}" data-gate-idx="${gateIdx}" type="button">Dismiss</button>
            </div>`;
  }
  if (entry.status === 'ready' && entry.suggestion) {
    return `<div class="oa-gate-sub-claude oa-gate-sub-claude-ready">
              <span class="oa-gate-sub-claude-label">Claude suggests:</span>
              <code class="oa-gate-sub-claude-selector">${escHtml(entry.suggestion)}</code>
              <button class="btn-secondary tiny oa-gate-sub-claude-accept-btn" data-oa-gate-sub-claude-accept="1" data-idx="${exIdx}" data-gate-idx="${gateIdx}" type="button" title="Replace the target field with this selector">Accept</button>
              <button class="btn-secondary tiny" data-oa-gate-sub-claude-dismiss="1" data-idx="${exIdx}" data-gate-idx="${gateIdx}" type="button">Dismiss</button>
            </div>`;
  }
  return '';
}

/**
 * v2.74.229 — Ask Claude for a refined selector for a body sub. Flow:
 *   1. Validate target + tab.
 *   2. Resolve frame routing (same as verify/inspect).
 *   3. Dispatch INSPECT_ELEMENT to capture rich DOM context.
 *   4. Forward report + shape + current selector to background, which
 *      calls AnthropicService.suggestSelector.
 *   5. Render suggestion inline; user accepts (replaces target) or
 *      dismisses.
 *
 * Renders 'asking' state immediately so the spinner shows even while
 * the Inspect dispatch is in flight. If anything fails along the way,
 * the suggestion bar flips to 'error' so the author sees what went
 * wrong without opening Logs.
 */
async function _askClaudeForBodySubSelector(exIdx, gateIdx) {
  const gate = _draft?.extracts?.[exIdx];
  if (!gate || gate.shape !== 'extract_gate') return;
  const sub = Array.isArray(gate.body) ? gate.body[gateIdx] : null;
  if (!sub) return;
  if (_tabId == null) {
    _showWarning('No active tab. Cancel and start over.');
    return;
  }
  const target = (sub.target ?? '').toString().trim();
  if (!target) {
    toast?.('Target selector required before asking Claude');
    return;
  }

  const stateKey = `${exIdx}.${gateIdx}`;
  _askClaudeState.set(stateKey, { status: 'asking' });
  _renderExtracts();

  // Frame routing — same chain verify/inspect use.
  let inheritedFrameUrl = null;
  if (!sub.frameUrl) {
    if (gate.condition?.frameUrl) {
      inheritedFrameUrl = gate.condition.frameUrl;
    } else if (Array.isArray(gate.body)) {
      const sibling = gate.body.find((b, i) => i !== gateIdx && b?.frameUrl);
      if (sibling) inheritedFrameUrl = sibling.frameUrl;
    }
  }
  const effectiveFrameUrl = sub.frameUrl ?? inheritedFrameUrl;
  let frameId = 0;
  if (effectiveFrameUrl) {
    try {
      const frames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId: _tabId }, (fs) => resolve(fs ?? []));
      });
      const exact = frames.find(f => f && f.url === effectiveFrameUrl);
      if (exact) frameId = exact.frameId;
    } catch { /* fall back to top frame */ }
  }

  // For *_last shapes, mirror the runtime pickLast so Inspect sees
  // the SAME element Claude needs to refine — otherwise we'd send
  // Claude the first match's DOM while the runtime targets the last.
  const pickLast = sub.shape === 'text_last' || sub.shape === 'click_copy_last';

  let inspectRes;
  try {
    inspectRes = await chrome.tabs.sendMessage(
      _tabId,
      { type: 'INSPECT_ELEMENT', payload: { target, pickLast } },
      { frameId },
    );
  } catch (e) {
    _askClaudeState.set(stateKey, { status: 'error', error: `inspect dispatch failed: ${e?.message ?? String(e)}` });
    _renderExtracts();
    return;
  }
  if (!inspectRes?.success) {
    _askClaudeState.set(stateKey, { status: 'error', error: inspectRes?.error ?? 'inspect failed' });
    _renderExtracts();
    return;
  }
  const report = inspectRes.report ?? {};

  // Ship to background → AnthropicService.suggestSelector.
  let claudeRes;
  try {
    claudeRes = await chrome.runtime.sendMessage({
      type: 'ASK_CLAUDE_FOR_SELECTOR_BG',
      payload: {
        shape                 : sub.shape,
        currentSelector       : target,
        matchCount            : report.matchCount ?? null,
        matchIndex            : report.matchIndex ?? null,
        pickLastUsed          : report.pickLastUsed === true,
        outerHTMLPreview      : report.outerHTMLPreview ?? '',
        parentOuterHTMLPreview: report.parent?.outerHTMLPreview ?? '',
        frame                 : report.frame ?? 'top',
      },
    });
  } catch (e) {
    _askClaudeState.set(stateKey, { status: 'error', error: `Claude dispatch failed: ${e?.message ?? String(e)}` });
    _renderExtracts();
    return;
  }
  if (!claudeRes?.success || !claudeRes.selector) {
    _askClaudeState.set(stateKey, { status: 'error', error: claudeRes?.error ?? 'no suggestion returned' });
    _renderExtracts();
    return;
  }

  Logger.info('observation-author', `Claude selector suggestion [exIdx=${exIdx} gateIdx=${gateIdx}]`, {
    shape          : sub.shape,
    currentSelector: target,
    suggestion     : claudeRes.selector,
    usage          : claudeRes.usage ?? null,
  });

  _askClaudeState.set(stateKey, { status: 'ready', suggestion: claudeRes.selector });
  _renderExtracts();
}

/**
 * v2.74.229 — Replace the body sub's target with Claude's suggestion
 * and clear the suggestion state. Drops any prior verify result for
 * this sub since the selector changed.
 */
function _acceptClaudeSuggestion(exIdx, gateIdx) {
  const gate = _draft?.extracts?.[exIdx];
  if (!gate || !Array.isArray(gate.body)) return;
  const sub = gate.body[gateIdx];
  if (!sub) return;
  const stateKey = `${exIdx}.${gateIdx}`;
  const entry = _askClaudeState.get(stateKey);
  if (!entry || entry.status !== 'ready' || !entry.suggestion) return;
  sub.target = entry.suggestion;
  // Selector changed — invalidate any prior verify state.
  _verified.delete(stateKey);
  _verifying.delete(stateKey);
  _askClaudeState.delete(stateKey);
  _renderExtracts();
  _updateSaveState();
}

function _dismissClaudeSuggestion(exIdx, gateIdx) {
  _askClaudeState.delete(`${exIdx}.${gateIdx}`);
  _renderExtracts();
}

async function _inspectExtractGateBodySub(exIdx, gateIdx) {
  const gate = _draft?.extracts?.[exIdx];
  if (!gate || gate.shape !== 'extract_gate') return;
  const sub = Array.isArray(gate.body) ? gate.body[gateIdx] : null;
  if (!sub) return;
  if (_tabId == null) {
    _showWarning('No active tab. Cancel and start over.');
    return;
  }
  const target = (sub.target ?? '').toString().trim();
  if (!target) {
    toast?.('Target selector required to inspect');
    return;
  }

  // Same frame fallback as _verifyExtractGateBodySub.
  let inheritedFrameUrl = null;
  if (!sub.frameUrl) {
    if (gate.condition?.frameUrl) {
      inheritedFrameUrl = gate.condition.frameUrl;
    } else if (Array.isArray(gate.body)) {
      const sibling = gate.body.find((b, i) => i !== gateIdx && b?.frameUrl);
      if (sibling) inheritedFrameUrl = sibling.frameUrl;
    }
  }
  const effectiveFrameUrl = sub.frameUrl ?? inheritedFrameUrl;

  // Resolve frameId from frameUrl.
  let frameId = 0;
  if (effectiveFrameUrl) {
    try {
      const frames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId: _tabId }, (fs) => resolve(fs ?? []));
      });
      const exact = frames.find(f => f && f.url === effectiveFrameUrl);
      if (exact) {
        frameId = exact.frameId;
      } else {
        let savedOrigin = null;
        try { savedOrigin = new URL(effectiveFrameUrl).origin; } catch {}
        if (savedOrigin) {
          const om = frames.find(f => {
            if (!f?.url) return false;
            try { return new URL(f.url).origin === savedOrigin; } catch { return false; }
          });
          if (om) frameId = om.frameId;
        }
      }
    } catch { /* fall through with frameId=0 */ }
  }

  // v2.74.215 — Mirror the body sub's shape in the inspect payload so
  // the diagnostic reflects what extraction would see. For text_last
  // shape this means querySelectorAll().last — same element runtime
  // would read.
  // v2.74.223 — Also honor click_copy_last (added v2.74.222). Without
  // this, Inspect on a click_copy_last extract showed the FIRST match
  // while extraction clicked the LAST — author saw the wrong button
  // in the diagnostic and chased ghost selector issues.
  const pickLast = (sub.shape === 'text_last' || sub.shape === 'click_copy_last');

  let res;
  try {
    res = await chrome.tabs.sendMessage(
      _tabId,
      { type: 'INSPECT_ELEMENT', payload: { target, pickLast } },
      { frameId },
    );
  } catch (e) {
    const msg = `Inspect dispatch failed: ${e?.message ?? String(e)}`;
    Logger.warn('observation-author', msg, { exIdx, gateIdx, target, frameUrl: effectiveFrameUrl });
    toast?.(msg);
    return;
  }

  if (!res?.success) {
    Logger.warn('observation-author', `Inspect failed: ${res?.error ?? 'unknown error'}`, {
      exIdx, gateIdx, target, frameUrl: effectiveFrameUrl,
    });
    toast?.(`Inspect failed — see Logs`);
    return;
  }

  // Pretty-print the report into Logger.info as a single structured
  // entry. The Logs viewer renders the JSON inline; users can copy.
  // v2.74.215 — Include matchCount + pickLastUsed + matchIndex so the
  // author sees "this is element [N-1] of N total matches" — proves
  // text_last is doing what's intended.
  Logger.info('observation-author', `Element inspection [exIdx=${exIdx} gateIdx=${gateIdx}]`, {
    selector       : res.report.selector,
    shape          : sub.shape,
    matchCount     : res.report.matchCount,
    matchIndex     : res.report.matchIndex,
    pickLastUsed   : res.report.pickLastUsed,
    // v2.74.218 — Warning surfaces "empty match — look at parent" up
    // top so it's the first thing visible in the log entry.
    warning        : res.report.warning,
    tag            : res.report.tag,
    id             : res.report.id,
    classes        : res.report.classes,
    attrs          : res.report.attrs,
    childCount     : res.report.childCount,
    childTags      : res.report.childTags,
    childPreview   : res.report.childPreview,
    textLength     : res.report.textLength,
    innerTextLength: res.report.innerTextLength,
    textPreview    : res.report.textPreview,
    innerTextPreview: res.report.innerTextPreview,
    outerHTMLPreview: res.report.outerHTMLPreview,
    hasShadowRoot  : res.report.hasShadowRoot,
    rect           : res.report.rect,
    frame          : res.report.frame,
    // v2.74.218 — Parent + sibling context. Critical when the matched
    // element is empty (selector hit a placeholder/wrapper).
    parent         : res.report.parent,
  });
  // v2.74.215 — Toast surfaces match position so the author sees at a
  // glance whether they got first / last / only match.
  const posLabel = res.report.matchCount > 1
    ? ` (${res.report.matchIndex + 1}/${res.report.matchCount}${res.report.pickLastUsed ? ', last' : ', first'})`
    : '';
  toast?.(`Inspected ${res.report.tag}${res.report.id ? '#' + res.report.id : ''}${posLabel} — see Logs tab`);
}

function _renderExtracts() {
  if (!extractsListEl) return;
  _updateExtractCountUI();
  // v2.74.23 — Antecedent card locks once extracts exist (mirrors
  // fragment-author's "non-empty actions list" rule). Refresh here
  // since add/remove paths all funnel through _renderExtracts.
  _updateAntecedentCardEnabled?.();
  // Auto-collapse the antecedent card on the first extract added, and
  // clear an orphan selection (selected but not successfully run, i.e.
  // mode is not 'undo') so we don't carry a stale antecedent reference.
  const cur = _draft.extracts.length;
  if (_anteLastExtractCount === 0 && cur > 0) {
    const orphanSelection = !!anteSelectEl?.value && _anteRunMode !== 'undo';
    if (!_anteCardCollapsed) _anteCardCollapsed = true;
    if (orphanSelection) {
      anteSelectEl.value = '';
      _onAntecedentChange();
    } else {
      _renderAntecedentToggle?.();
    }
  }
  _anteLastExtractCount = cur;
  if (_draft.extracts.length === 0) {
    extractsListEl.innerHTML = `<div class="dbg-perspective-landmarks-empty">No extracts yet — click + Extract below.</div>`;
    return;
  }
  const state = { tier: 'cache', verifying: _verifying, verified: _verified };
  // v2.74.195 — Dispatch by shape: extract_gate renders a header
  // condition card with body sub-extracts inline; everything else
  // uses the standard extract-card renderer.
  extractsListEl.innerHTML = _draft.extracts.map((ex, i) => {
    if (ex?.shape === 'extract_gate') {
      return _renderExtractGateCard(ex, i, state);
    }
    return renderExtractCard(ex, i, state);
  }).join('');

  const ctx = {
    onChange : () => _updateSaveState(),
    renderAll: () => { _renderExtracts(); _updateSaveState(); },
    onRemove : (exIdx) => _onRemoveExtract(exIdx),
    onPick   : (exIdx) => _onPickClick(exIdx),
    onSnap   : (exIdx) => _onSnapClick(exIdx),
    onVerify : (exIdx) => _onVerifyClick(exIdx),
  };
  _draft.extracts.forEach((ex, i) => {
    // Gate cards have their own wiring (see _wireExtractGateCard);
    // skip the extract-card wireup which expects a regular shape.
    if (ex?.shape === 'extract_gate') {
      _wireExtractGateCard(extractsListEl, ex, i);
      return;
    }
    wireExtractCard(extractsListEl, ex, i, ctx);
  });
}

function _updateExtractCountUI() {
  const n = _draft.extracts.length;
  if (extractCountEl) {
    if (_extractCapUnlimited) {
      extractCountEl.textContent = `${n} of ∞`;
      extractCountEl.classList.toggle('fa-action-count-full', false);
      extractCountEl.classList.toggle('fa-action-count-soft-warn', n > SOFT_CAP_THRESHOLD);
      extractCountEl.title = n > SOFT_CAP_THRESHOLD
        ? `Long Observations are harder to debug and reuse. Consider splitting at extract ${SOFT_CAP_THRESHOLD + 1} or earlier.`
        : '';
    } else {
      extractCountEl.textContent = `${n} of ${_extractCap}`;
      extractCountEl.classList.toggle('fa-action-count-full', n >= _extractCap);
      extractCountEl.classList.toggle('fa-action-count-soft-warn', false);
      extractCountEl.title = '';
    }
  }
  const atCap = !_extractCapUnlimited && n >= _extractCap;
  if (addExtractBtnEl) addExtractBtnEl.disabled = atCap;
}

function _scrollNewestExtractIntoView() {
  if (!extractsListEl) return;
  requestAnimationFrame(() => {
    const cards = extractsListEl.querySelectorAll('[data-oa-ex-card]');
    const last = cards[cards.length - 1];
    last?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  });
}

async function _onPickClick(exIdx) {
  if (_pickerSession) await _cancelPick(true);
  if (_tabId == null) {
    _showWarning('No active tab. Cancel and start over.');
    return;
  }
  const res = await startPick(_tabId, exIdx);
  if (!res.ok) { _showWarning(`Pick failed: ${res.error}`); return; }
  _pickerSession = res.session;
  if (pickBannerEl) pickBannerEl.classList.remove('hidden');
}

/**
 * v2.74.207 — Pick a selector for a body sub-extract inside an
 * extract_gate. Same infrastructure as the top-level _onPickClick:
 * broadcasts START_PICK to every same-origin frame, then PICK_RESULT
 * carries selector + frame.url back. The picker session now also
 * carries `gateIdx` so the result handler can route the write to
 * `_draft.extracts[exIdx].body[gateIdx]` instead of the top-level
 * extract. Uses single-label mode (no container walk-up) — a body
 * sub's target is the exact element to read from, not a container.
 */
async function _onPickBodySubClick(exIdx, gateIdx) {
  if (_pickerSession) await _cancelPick(true);
  if (_tabId == null) {
    _showWarning('No active tab. Cancel and start over.');
    return;
  }
  const res = await startPick(_tabId, exIdx);
  if (!res.ok) { _showWarning(`Pick failed: ${res.error}`); return; }
  // Augment the session with the body-sub index so the PICK_RESULT
  // handler routes to the right slot.
  _pickerSession = { ...res.session, gateIdx };
  if (pickBannerEl) pickBannerEl.classList.remove('hidden');
}

/**
 * v2.74.212 — Pick a selector for a gate's condition. Same picker
 * infrastructure as the top-level extract pick, but the session
 * carries `condition:true` so PICK_RESULT writes to
 * `ex.condition.selector` + `ex.condition.frameUrl` instead of the
 * extract's own target. Capturing `frameUrl` here is the critical
 * piece — it unlocks the body-sub fallback chain so hand-typed body
 * sub selectors automatically inherit the gate's frame routing.
 */
async function _onPickGateConditionClick(exIdx) {
  if (_pickerSession) await _cancelPick(true);
  if (_tabId == null) {
    _showWarning('No active tab. Cancel and start over.');
    return;
  }
  const res = await startPick(_tabId, exIdx);
  if (!res.ok) { _showWarning(`Pick failed: ${res.error}`); return; }
  _pickerSession = { ...res.session, condition: true };
  if (pickBannerEl) pickBannerEl.classList.remove('hidden');
}

async function _cancelPick(notifyContent) {
  if (!_pickerSession) return;
  if (notifyContent && _tabId != null) await cancelPick(_tabId, _pickerSession);
  _pickerSession = null;
  if (pickBannerEl) pickBannerEl.classList.add('hidden');
}

// v2.74.19 — Snap session: click-and-drag rectangle on the page. Same
// session shape as pick (sessionId + extractIdx), different content-script
// behavior (mousedown/move/up listeners draw a rectangle, returning rect +
// scrollY + viewport on mouseup).
async function _onSnapClick(exIdx) {
  if (_pickerSession) await _cancelPick(true);
  if (_snapSession) await _cancelSnap(true);
  if (_tabId == null) {
    _showWarning('No active tab. Cancel and start over.');
    return;
  }
  const res = await startSnap(_tabId, exIdx);
  if (!res.ok) { _showWarning(`Snap failed: ${res.error}`); return; }
  _snapSession = res.session;
  if (pickBannerEl) pickBannerEl.classList.remove('hidden');
}

async function _cancelSnap(notifyContent) {
  if (!_snapSession) return;
  if (notifyContent && _tabId != null) await cancelSnap(_tabId, _snapSession);
  _snapSession = null;
  if (pickBannerEl) pickBannerEl.classList.add('hidden');
}

async function _onVerifyClick(exIdx) {
  const ex = _draft.extracts[exIdx];
  if (!ex) return;
  // Pre-flight validation, mirroring fragment-author.js's pattern: any
  // missing required field sets the failed state with an inline error and
  // re-renders, which surfaces the message in the existing failed-card
  // status row. The shape's own validate() runs after these — it covers
  // shape-specific extras (e.g. attribute name on scalar attribute,
  // fields on list_of_records) and should never see a blank output or
  // missing capture target.
  const shape = getShape(ex.shape);

  // Output binding name is required for every shape — it's the scope
  // key the captured value lands under, so a blank output makes the
  // verify result unattributable.
  if (!(ex.output ?? '').trim()) {
    _verified.set(exIdx, { success: false, error: 'Output binding name required' });
    _renderExtracts();
    _updateSaveState();
    return;
  }

  // Capture target: rect for free-extract shapes that require a region,
  // target selector for picker shapes. The button's disabled state
  // usually prevents this firing, but defend against direct invocation
  // paths.
  // v2.74.52 — image_full (instantCapture) has no rect and no target —
  // verify just captures the visible viewport directly. Skip the
  // pre-verify guards entirely for those shapes.
  if (shape?.customCaptureUI && !shape?.instantCapture) {
    if (!ex.rect) {
      _verified.set(exIdx, { success: false, error: 'Snap a region first' });
      _renderExtracts();
      _updateSaveState();
      return;
    }
  } else if (!shape?.customCaptureUI) {
    if (!ex.target) {
      _verified.set(exIdx, { success: false, error: 'Target selector required' });
      _renderExtracts();
      _updateSaveState();
      return;
    }
  }
  if (_tabId == null) { _showWarning('No active tab. Cancel and start over.'); return; }

  const validationErr = shape?.validate?.(ex);
  if (validationErr) {
    _verified.set(exIdx, { success: false, error: validationErr });
    _renderExtracts();
    _updateSaveState();
    return;
  }

  _verifying.add(exIdx);
  _renderExtracts();

  try {
    const result = await _dispatchObserveForVerify(ex);
    if (!result?.success) {
      const errMsg = result?.error ?? 'verify failed';
      _verified.set(exIdx, { success: false, error: errMsg });
      // v2.74.209 — Mirror to Logs (full prefix-walk diagnostic).
      Logger.warn('observation-author', `Extract verify failed [exIdx=${exIdx}]`, {
        output: ex.output,
        target: ex.target,
        shape: ex.shape,
        frameUrl: ex.frameUrl ?? null,
        error: errMsg,
      });
    } else {
      // v2.74.19 — Capture thumbnail for image-bearing shapes so the card
      // status row can show a visual confirmation. Only image_snap
      // returns a dataUrl directly; the picker-based image / image_list
      // shapes already produce DOM-readable src URLs we could embed,
      // but those are external (cross-origin caveats), so we only show
      // thumbnails for the snap result for now.
      const thumb = result.dataUrl ?? null;
      // Pull captured pixel dimensions from the shape-appropriate source
      // so the status row can render them next to the thumbnail.
      let thumbWidth = null;
      let thumbHeight = null;
      if (ex.shape === 'image_snap' && ex.rect) {
        thumbWidth  = ex.rect.width;
        thumbHeight = ex.rect.height;
      }
      // v2.74.51 — image_full has no rect; the background helper
      // returns the captured-pixel dimensions directly on the result.
      if (ex.shape === 'image_full') {
        thumbWidth  = Number.isFinite(result.width)  ? result.width  : null;
        thumbHeight = Number.isFinite(result.height) ? result.height : null;
      }
      // v2.74.62 — image_read: thumbnail dimensions are the captured-
      // pixel size returned by background. The rect's CSS-px size is
      // also fine if available.
      if (ex.shape === 'image_read') {
        thumbWidth  = Number.isFinite(result.width)  ? result.width
                    : (ex.rect?.width ?? null);
        thumbHeight = Number.isFinite(result.height) ? result.height
                    : (ex.rect?.height ?? null);
      }
      // v2.74.61 / v2.74.62 — section + image_read both return a
      // Claude-distilled `items` array. extractCard renders them as
      // rows below the summary / thumbnail.
      let items = null;
      let itemsMode = null;
      if (ex.shape === 'section' && Array.isArray(result.items)) {
        items = result.items;
        itemsMode = ex.extract === 'url' ? 'url' : 'text';
      } else if (ex.shape === 'image_read' && Array.isArray(result.items)) {
        items = result.items;
        itemsMode = 'text';
      }
      _verified.set(exIdx, {
        success    : true,
        summary    : _summarizeResult(ex, result),
        thumbnail  : thumb,
        width      : thumbWidth,
        height     : thumbHeight,
        items,
        itemsMode,
        verifiedAt : Date.now(),
      });
      // v2.74.217 — Log the FULL captured value to the Logs tab. The
      // verify status pill / extract card only show a short summary;
      // for rich extractions (chat replies, section markdown, list
      // records) the author wants the complete output to confirm
      // correctness. Image dataURLs are omitted to keep log entries
      // small — the thumbnail is already rendered in the card.
      Logger.info('observation-author', `Extract verify captured [exIdx=${exIdx}]`, {
        output       : ex.output,
        shape        : ex.shape,
        target       : ex.target ?? null,
        frameUrl     : ex.frameUrl ?? null,
        matchCount   : result.matchCount ?? null,
        pickLastUsed : result.pickLastUsed ?? null,
        textMode     : result.textMode ?? null,
        valueType    : typeof result.value,
        valueLength  : typeof result.value === 'string' ? result.value.length : null,
        value        : (ex.shape === 'image_snap' || ex.shape === 'image_full' || ex.shape === 'image_read')
                          ? '[image dataURL omitted]'
                          : result.value ?? null,
        // v2.74.217 — section + image_read return an items[] array;
        // surface it so the author sees the distilled records.
        items        : items ?? null,
        itemsMode    : itemsMode ?? null,
        // section-shape captures markdown/text/images/links separately.
        section      : ex.shape === 'section' ? result.section ?? null : undefined,
      });
    }
  } catch (e) {
    _verified.set(exIdx, { success: false, error: e.message ?? String(e) });
  } finally {
    _verifying.delete(exIdx);
    _renderExtracts();
    _updateSaveState();
  }
}

async function _dispatchObserveForVerify(ex) {
  // v2.74.199 — Resolve the iframe frame for this extract's verify
  // probe. Picker writes ex.frameUrl when the selector was picked
  // inside an iframe (v2.74.198); the runtime ExecutionEngine path
  // routes to that frame, but THIS verify dispatcher was still
  // hardcoded to frameId:0 — so authoring-time verify ALWAYS failed
  // for iframe-bound selectors even after the picker captured the
  // right frame. Symmetric to the runtime fix; user reported the
  // gap with "OBSERVE_SECTION: no element matched ..." even though
  // the selector was correct (just in the wrong frame at verify
  // time).
  let frameId = 0;
  if (ex.frameUrl && typeof ex.frameUrl === 'string' && ex.frameUrl.trim()) {
    try {
      const { TemplateWalker } = await import('../../Services/TemplateWalker.js');
      frameId = await TemplateWalker._resolveFrameId(_tabId, ex.frameUrl);
    } catch { /* fall through with frameId=0 */ }
  }
  const sendToTab = (msg) => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(_tabId, msg, { frameId }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });

  let msg;
  switch (ex.shape) {
    // v2.74.131 — Canonical shapes. `text` and `attribute` route to the
    // same content-script handlers as their legacy predecessors (the
    // capture mechanism is identical; only the authoring storage shape
    // is new) so no content-script changes were needed.
    case 'text':            msg = { type: 'OBSERVE_RAW_TEXT',      payload: { target: ex.target } }; break;
    // v2.74.214 — text_last: pickLast flag tells contentScript to read
    // the LAST querySelectorAll match instead of first. Same handler.
    case 'text_last':       msg = { type: 'OBSERVE_RAW_TEXT',      payload: { target: ex.target, pickLast: true } }; break;
    // v2.74.219 — click_copy: click target, wait, read clipboard.
    case 'click_copy':      msg = { type: 'OBSERVE_CLICK_COPY',    payload: { target: ex.target, waitAfterClick: ex.waitAfterClick ?? 150 } }; break;
    // v2.74.222 — click_copy_last: pickLast → click the LAST match.
    case 'click_copy_last': msg = { type: 'OBSERVE_CLICK_COPY',    payload: { target: ex.target, waitAfterClick: ex.waitAfterClick ?? 150, pickLast: true } }; break;
    case 'attribute':       msg = { type: 'OBSERVE_SCALAR',        payload: { target: ex.target, extract: { kind: 'attribute', name: ex.attribute } } }; break;
    // Legacy shapes — kept for records that haven't been migrated yet.
    case 'scalar':          msg = { type: 'OBSERVE_SCALAR',        payload: { target: ex.target, extract: ex.extract ?? { kind: 'text' } } }; break;
    case 'raw_text':        msg = { type: 'OBSERVE_RAW_TEXT',      payload: { target: ex.target } }; break;
    case 'raw_html':        msg = { type: 'OBSERVE_RAW_HTML',      payload: { target: ex.target } }; break;
    case 'list_of_records': msg = { type: 'OBSERVE_LIST',          payload: { target: ex.target, fields: Array.isArray(ex.fields) ? ex.fields : [] } }; break;
    // v2.74.61 — section verify routes through background's
    // OBSERVE_SECTION_LIST_BG: capture the DOM section, send to Claude
    // with the Text/URL mode, return a curated list.
    case 'section':
      return await _captureSectionListForVerify(ex);
    case 'image_refs':      msg = { type: 'OBSERVE_IMAGE_REFS',    payload: { target: ex.target } }; break;
    case 'image':           msg = { type: 'OBSERVE_IMAGE_T1',      payload: { target: ex.target } }; break;
    case 'image_list':      msg = { type: 'OBSERVE_IMAGE_LIST_T1', payload: { target: ex.target } }; break;
    // v2.74.19 — image_snap doesn't go through the content script for
    // capture (the content script can't take screenshots); the request
    // routes to background which calls chrome.tabs.captureVisibleTab.
    case 'image_snap':
      return await _captureSnapForVerify(ex);
    // v2.74.51 — image_full is similar but captures the full visible
    // viewport (no crop). Routes through a separate background helper.
    case 'image_full':
      return await _captureFullForVerify(ex);
    // v2.74.62 — image_read crops a region (like image_snap) and then
    // asks Claude to read it according to the author's description.
    case 'image_read':
      return await _captureReadForVerify(ex);
    default: return { success: false, error: `Unknown shape: ${ex.shape}` };
  }
  return await sendToTab(msg);
}

/**
 * v2.74.19 — Capture an image_snap extract for verify-time preview.
 * Sends OBSERVE_IMAGE_SNAP_BG to background which:
 *   1. Scrolls the tab to ex.scrollY (if it's not already there)
 *   2. chrome.tabs.captureVisibleTab → full-viewport PNG
 *   3. Crops to ex.rect (scaled by devicePixelRatio if needed)
 *   4. Returns { success, dataUrl } where dataUrl is the cropped image.
 *
 * The runtime ExecutionEngine path uses the same background helper at
 * execute time, ensuring authoring preview matches runtime output.
 */
async function _captureSnapForVerify(ex) {
  if (!ex.rect) return { success: false, error: 'rect not captured' };
  return await new Promise(resolve => {
    chrome.runtime.sendMessage({
      type: 'OBSERVE_IMAGE_SNAP_BG',
      payload: {
        tabId   : _tabId,
        rect    : ex.rect,
        scrollY : ex.scrollY ?? 0,
        viewport: ex.viewport ?? null,
      },
    }, resolve);
  });
}

// v2.74.61 — Section → Claude → list. Background's
// OBSERVE_SECTION_LIST_BG handler captures the section via the
// content script, then calls AnthropicService.extractSectionItems to
// distill it into either a text-values list or a URL list based on
// ex.extract.
async function _captureSectionListForVerify(ex) {
  if (_tabId == null) return { success: false, error: 'no active tab' };
  if (!ex.target)     return { success: false, error: 'target required' };
  return await new Promise(resolve => {
    chrome.runtime.sendMessage({
      type: 'OBSERVE_SECTION_LIST_BG',
      payload: {
        tabId   : _tabId,
        target  : ex.target,
        mode    : ex.extract === 'url' ? 'url' : 'text',
        // v2.74.199 — Pass the iframe URL so the BG handler can
        // resolve the right frameId for the OBSERVE_SECTION probe.
        // Without this, the section capture lands in the top frame
        // and the iframe-bound selector returns "no element matched"
        // even though the selector + frame combination is correct.
        frameUrl: ex.frameUrl ?? null,
      },
    }, resolve);
  });
}

// v2.74.62 — image_read verify: snapshot the rect + send to Claude
// vision with the author's description. Background's
// OBSERVE_IMAGE_READ_BG inlines the crop logic from OBSERVE_IMAGE_
// SNAP_BG plus a Claude vision call; returns
// { items, dataUrl, width, height }.
async function _captureReadForVerify(ex) {
  if (_tabId == null) return { success: false, error: 'no active tab' };
  if (!ex.rect)       return { success: false, error: 'rect not captured' };
  if (!ex.description || !ex.description.trim()) {
    return { success: false, error: 'description required (what to read from the image)' };
  }
  return await new Promise(resolve => {
    chrome.runtime.sendMessage({
      type: 'OBSERVE_IMAGE_READ_BG',
      payload: {
        tabId       : _tabId,
        rect        : ex.rect,
        scrollY     : ex.scrollY ?? 0,
        viewport    : ex.viewport ?? null,
        description : ex.description,
      },
    }, resolve);
  });
}

// v2.74.51 — Full-tab screenshot capture (image_full shape).
// Background's OBSERVE_IMAGE_FULL_BG handler calls chrome.tabs.
// captureVisibleTab — no scroll, no crop. Returns the entire visible
// viewport as a PNG data URL plus its captured-pixel dimensions.
async function _captureFullForVerify(_ex) {
  if (_tabId == null) return { success: false, error: 'no active tab' };
  return await new Promise(resolve => {
    chrome.runtime.sendMessage({
      type: 'OBSERVE_IMAGE_FULL_BG',
      payload: { tabId: _tabId },
    }, resolve);
  });
}

function _summarizeResult(ex, result) {
  switch (ex.shape) {
    // v2.74.131 — `text` + `attribute` join the single-string cluster.
    case 'text':
    case 'attribute':
    case 'scalar':
    case 'raw_text':
    case 'raw_html':
      return _truncate(`${ex.output}: "${String(result.value ?? '').replace(/\s+/g, ' ')}"`, 140);
    case 'list_of_records': {
      const n = Array.isArray(result.items) ? result.items.length : 0;
      return `${ex.output}: ${n} record(s)`;
    }
    case 'section': {
      // v2.74.61 — Result now includes Claude-distilled items list.
      // Surface that in the summary; keep the raw counts as a
      // secondary detail for context.
      const sec = result.section ?? {};
      const n   = Array.isArray(result.items) ? result.items.length : 0;
      const len = (sec.text ?? '').length;
      const links = Array.isArray(sec.links) ? sec.links.length : 0;
      const kind = ex.extract === 'url' ? 'URL' : 'text';
      return `${ex.output}: ${n} ${kind}${n === 1 ? '' : 's'} from ${len} chars / ${links} link(s)`;
    }
    case 'image_refs': {
      const n = Array.isArray(result.images) ? result.images.length : 0;
      return `${ex.output}: ${n} image ref(s)`;
    }
    case 'image': {
      const im = result.image ?? {};
      return `${ex.output}: <img src=${_truncate(im.src ?? '', 50)}>`;
    }
    case 'image_list': {
      const n = Array.isArray(result.images) ? result.images.length : 0;
      return `${ex.output}: ${n} image(s)`;
    }
    case 'image_snap': {
      const r = ex.rect ?? {};
      return `${ex.output}: ${r.width}×${r.height} captured`;
    }
    // v2.74.51 — Result carries captured dimensions; no rect on the
    // extract itself.
    case 'image_full': {
      const w = result?.width  ?? '?';
      const h = result?.height ?? '?';
      return `${ex.output}: full viewport ${w}×${h} captured`;
    }
    // v2.74.62 — image_read pairs the rect summary with the Claude-
    // distilled item count.
    // v2.74.158 — Cardinality-aware to match the runtime wrap (0/1/N
    // cases in ExecutionEngine produce scalar('') / scalar(value) /
    // list(N) — see ExecutionEngine.js image_read branch). Previously
    // the verify summary always read "N value(s)" which was visually
    // inconsistent with the runtime Logs tab and confusing for the
    // single-value case (showed "1 value" rather than the actual value).
    case 'image_read': {
      const r = ex.rect ?? {};
      const items = Array.isArray(result?.items) ? result.items : [];
      const n = items.length;
      const dims = `${r.width}×${r.height}`;
      if (n === 0)  return `${ex.output}: ${dims} → 0 values`;
      if (n === 1)  return `${ex.output}: ${dims} → "${String(items[0]).slice(0, 40)}"`;
      return `${ex.output}: ${dims} → ${n} values`;
    }
    default: return `${ex.output}: ok`;
  }
}

function _truncate(s, max) {
  s = String(s ?? '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function _updateSaveState() {
  if (!saveBtnEl) return;
  const hasName = (_draft?.name ?? '').trim().length > 0;
  const extracts = _draft?.extracts ?? [];
  const hasExtracts = extracts.length > 0;
  // v2.74.195 — extract_gate is structurally valid when its condition
  // has the required fields populated AND every body sub-extract has
  // a non-empty shape + output + target. Body sub-extracts are NOT
  // run through getShape().validate() because v1 renders them with a
  // simplified inline form (no per-shape extras), so the shape's
  // strict validator would reject most. They get a soft check.
  const validateExtractGate = (ex) => {
    const cond = ex.condition ?? {};
    if (typeof cond.type !== 'string' || !cond.type) return false;
    if (cond.type === 'selector_present' || cond.type === 'selector_absent') {
      if (!(cond.selector ?? '').trim()) return false;
    } else if (cond.type === 'text_present') {
      if (!(cond.text ?? '').toString().trim()) return false;
    } else if (cond.type === 'url_matches') {
      if (!(cond.pattern ?? '').trim()) return false;
    } else if (cond.type === 'attribute_equals') {
      if (!(cond.selector ?? '').trim()) return false;
      if (!(cond.attribute ?? '').trim()) return false;
    }
    const body = Array.isArray(ex.body) ? ex.body : [];
    return body.every(sub => sub?.shape && (sub.output ?? '').trim() && (sub.target ?? '').trim());
  };
  const allFieldsValid = extracts.every(ex => {
    if (ex?.shape === 'extract_gate') return validateExtractGate(ex);
    const shape = getShape(ex.shape);
    if (!shape) return false;
    if (!ex.output) return false;
    // v2.74.19 — Picker-based shapes need a target; free-extract shapes
    // (customCaptureUI flag) need other capture state which their
    // shape.validate() checks (e.g. image_snap requires rect).
    if (!shape.customCaptureUI && !ex.target) return false;
    return shape.validate(ex) === null;
  });
  // v2.74.195 — Gates don't carry their own verify state (no live-page
  // probe at authoring time); they pass when their structural check
  // above does. Body sub-extracts are also exempt from per-sub verify
  // in v1 (deferred to follow-up).
  const allVerified = extracts.every((ex, i) => {
    if (ex?.shape === 'extract_gate') return true;
    return _verified.get(i)?.success === true;
  });
  saveBtnEl.disabled = !(hasName && hasExtracts && allFieldsValid && allVerified);
}

async function _onSaveClick() {
  if (!_payload) return;
  const name = (_draft.name ?? '').trim();
  if (!name) { toast('Enter a name', 'err'); nameInputEl?.focus(); return; }
  if (_draft.extracts.length === 0) { toast('Add at least one extract', 'err'); return; }
  for (let i = 0; i < _draft.extracts.length; i++) {
    const ex = _draft.extracts[i];
    // v2.74.195 — Skip the shape-based validator for extract_gate;
    // gates aren't registered shapes (they're a control-flow wrapper).
    // Their structural validation runs in _updateSaveState's
    // validateExtractGate helper, which the save button's enabled
    // state already gates on — so reaching this code means the gate
    // is structurally valid.
    if (ex?.shape === 'extract_gate') continue;
    const shape = getShape(ex.shape);
    const err = shape?.validate(ex);
    if (err) { toast(`Extract ${i + 1}: ${err}`, 'err'); return; }
    if (!_verified.get(i)?.success) { toast(`Extract ${i + 1} not verified`, 'err'); return; }
  }
  await _capturePostconditions();

  // v2.74.195 — Body sub-extract cleaner. Used by both top-level
  // path and the gate-body path so the persisted shape on each is
  // identical. Strips authoring-only fields (_uid, etc.).
  const cleanRegularExtract = (ex) => {
    const out = { shape: ex.shape, output: ex.output };
    if (ex.shape !== 'image_snap' && ex.shape !== 'image_full' && ex.shape !== 'image_read') {
      out.target = ex.target;
    }
    if (ex.shape === 'attribute')       out.attribute = ex.attribute;
    if (ex.shape === 'scalar')          out.extract = ex.extract;
    if (ex.shape === 'list_of_records') out.fields  = ex.fields;
    if (ex.shape === 'image_snap') {
      out.rect     = ex.rect;
      out.scrollY  = ex.scrollY ?? 0;
      out.viewport = ex.viewport ?? { width: 0, devicePixelRatio: 1 };
    }
    if (ex.shape === 'image_full') {
      out.viewport = ex.viewport ?? { width: 0, devicePixelRatio: 1 };
    }
    if (ex.shape === 'image_read') {
      out.rect        = ex.rect;
      out.scrollY     = ex.scrollY ?? 0;
      out.viewport    = ex.viewport ?? { width: 0, devicePixelRatio: 1 };
      out.description = (ex.description ?? '').trim();
    }
    // v2.74.198 — Preserve iframe origin. Symmetric to the fragment-
    // action save fix (line 3503 in fragment-author). Skipped for
    // image_full (captures whole viewport, no DOM target) and
    // image_snap / image_read (coordinate-based capture, no frame
    // routing needed). Other shapes route through DOM-querying
    // OBSERVE messages that need frameId at runtime.
    if (ex.shape !== 'image_snap' && ex.shape !== 'image_full' && ex.shape !== 'image_read'
        && typeof ex.frameUrl === 'string' && ex.frameUrl.trim()) {
      out.frameUrl = ex.frameUrl;
    }
    return out;
  };

  const cleanedExtracts = _draft.extracts.map(ex => {
    // v2.74.195 — Extract gate: persist shape + condition + negate + body.
    // condition is a shallow clone (its inner fields are primitives —
    // selector/text/pattern/attribute/value/type — so shallow is safe).
    // body is cleaned via the same cleanRegularExtract used for top-level.
    // v2.74.201 — Optional waitTimeout for wait-aware gates. Persisted
    // when > 0 only; absent/0 stays one-shot.
    if (ex?.shape === 'extract_gate') {
      const out = {
        shape    : 'extract_gate',
        condition: { ...(ex.condition ?? {}) },
        negate   : !!ex.negate,
        body     : (Array.isArray(ex.body) ? ex.body : []).map(cleanRegularExtract),
      };
      // v2.74.204 — Strip transient authoring-only fields from the
      // condition. _verified / _verifying live on cond at authoring
      // time to drive the verify-status row rendering; they MUST NOT
      // be persisted (rawJson stays clean; loaded gates don't carry
      // stale verify state across edit sessions).
      delete out.condition._verified;
      delete out.condition._verifying;
      if (Number.isFinite(ex.waitTimeout) && ex.waitTimeout > 0) {
        out.waitTimeout = ex.waitTimeout;
      }
      return out;
    }
    // v2.74.197 — Top-level extracts use the same cleaner as gate body
    // subs. Previously this branch inlined the per-shape cleanup; the
    // duplication was fragile (adding a new shape required updating
    // two places). Single source of truth now.
    return cleanRegularExtract(ex);
  });
  const description = composeCompactDescription(cleanedExtracts);
  const params = _collectParams(cleanedExtracts);

  const observation = {
    id           : _payload.observationId,
    groundId     : _payload.groundId,
    name,
    description,
    authoringTier: 'T1',
    startUrl     : _payload.groundUrl ?? null,
    endUrl       : null,
    preconditions : _draft.preconditions,
    postconditions: _draft.postconditions,
    params,
    implementations: [{ tier: 'cache', extracts: cleanedExtracts }],
    rationale: null,
  };

  // v2.74.122 — Mount-snapshot guard + Cancel disable. Same pattern as
  // assertion-author v2.74.120 / analysis-author + perspective-capture
  // v2.74.121. The Cancel button here is bound to _onDoneClick (which
  // calls _exitOrReturn), so disabling it during save prevents the user
  // from leaving mid-round-trip and seeing a "Saved" toast for what they
  // intended to abandon.
  const mountSnapshot = _mountEl;
  saveBtnEl.disabled = true;
  if (cancelBtnEl) cancelBtnEl.disabled = true;
  saveBtnEl.textContent = 'Saving…';
  try {
    const res = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'SAVE_OBSERVATION', payload: { observation } }, resolve);
    });
    if (mountSnapshot !== _mountEl) return;
    if (!res?.success) {
      toast(`Save failed: ${res?.error ?? 'unknown'}`, 'err');
      saveBtnEl.disabled = false;
      if (cancelBtnEl) cancelBtnEl.disabled = false;
      saveBtnEl.textContent = 'Save';
      return;
    }
    toast(`Saved "${name}" — ${cleanedExtracts.length} extract(s).`);
    saveBtnEl.disabled = false;
    if (cancelBtnEl) cancelBtnEl.disabled = false;
    saveBtnEl.textContent = 'Save';
    // v2.74.33 — When launched from the Ground sidepanel, save → return.
    if (_payload?.returnTo === 'ground-view') {
      _exitOrReturn();
      return;
    }
  } catch (e) {
    if (mountSnapshot !== _mountEl) return;
    toast(`Save error: ${e.message}`, 'err');
    saveBtnEl.disabled = false;
    if (cancelBtnEl) cancelBtnEl.disabled = false;
    saveBtnEl.textContent = 'Save';
  }
}

function _onDoneClick() { _exitOrReturn(); }

// v2.74.33 — Route the exit. When the mode was launched from the Ground
// sidepanel (returnTo='ground-view'), switch the panel back to that mode
// instead of dismissing it and focusing Studio.
// v2.74.36 — Clear the per-tab sidepanel mode record so the user isn't
// auto-resumed into a finished observation on their next visit to the
// authoring tab.
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

function _collectParams(extracts) {
  const re = /\{\{([A-Z0-9_]+)\}\}/g;
  const set = new Set();
  const visit = (s) => {
    if (typeof s !== 'string') return;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) set.add(m[1]);
  };
  const visitExtract = (ex) => {
    visit(ex.target);
    if (ex.extract?.attr) visit(ex.extract.attr);
    if (Array.isArray(ex.fields)) {
      for (const f of ex.fields) {
        visit(f.selector);
        if (f.attr) visit(f.attr);
      }
    }
  };
  for (const ex of extracts) {
    // v2.74.195 — Walk extract_gate's condition fields and body[] so
    // {{PARAM}} tokens declared inside gates show up in the observation's
    // params[] list. Without this, a gate condition like
    // `text_present: "{{FILTER}}"` would silently not be declared as a
    // param and the engine's InjectionService wouldn't know to substitute.
    if (ex.shape === 'extract_gate') {
      const cond = ex.condition ?? {};
      visit(cond.selector);
      visit(cond.text);
      visit(cond.value);
      // cond.pattern is a regex literal, not a substitution target.
      // cond.attribute is an attribute NAME, not a substitution target.
      const body = Array.isArray(ex.body) ? ex.body : [];
      for (const sub of body) visitExtract(sub);
      continue;
    }
    visitExtract(ex);
  }
  return [...set].sort();
}

async function _captureConditions(which) {
  if (!_draft) return;
  const isPre = which === 'pre';
  // v2.74.26 — Once the author has touched the conditions list, auto-
  // capture stops overwriting it. Otherwise re-capturing after an
  // antecedent Run or at Save would silently undo manual edits.
  if (isPre && _preUserModified)  return;
  if (!isPre && _postUserModified) return;
  if (isPre) _preSource  = 'capturing…';
  else       _postSource = 'capturing…';
  if (isPre) _renderPreconditions();
  else       _renderPostconditions();

  if (_tabId == null || !_payload?.groundId) {
    if (isPre) {
      _draft.preconditions = [];
      _preSource = 'tab not ready';
      _renderPreconditions();
    } else {
      _draft.postconditions = [];
      _postSource = 'tab not ready';
      _renderPostconditions();
    }
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
    if (isPre) { _preSource  = `eval failed: ${e.message}`; _renderPreconditions(); }
    else       { _postSource = `eval failed: ${e.message}`; _renderPostconditions(); }
    return;
  }
  if (!res?.success) {
    const msg = `eval failed: ${res?.error ?? 'unknown'}`;
    if (isPre) { _preSource  = msg; _renderPreconditions(); }
    else       { _postSource = msg; _renderPostconditions(); }
    return;
  }

  // Cache perspective/assertion metadata so renders show names, not bare ids.
  for (const loc of res.matchingPerspectives ?? [])    _conditionDisplay.perspectives.set(loc.id, loc);
  for (const ast of res.matchingAssertions ?? []) _conditionDisplay.assertions.set(ast.id, ast);

  const conds = [];
  const url = res.currentUrl ?? res.urlPattern ?? null;
  if (url) conds.push({ type: 'url_matches', pattern: url });
  for (const loc of res.matchingPerspectives ?? [])    conds.push({ type: 'perspective_ref', perspectiveId: loc.id });
  for (const ast of res.matchingAssertions ?? []) conds.push({ type: 'assertion_ref', assertionId: ast.id });

  const nLoc = (res.matchingPerspectives    ?? []).length;
  const nAst = (res.matchingAssertions ?? []).length;
  const sourceLabel = `auto-captured (${nLoc} perspective${nLoc === 1 ? '' : 's'}, ${nAst} assertion${nAst === 1 ? '' : 's'})`;

  if (isPre) {
    _draft.preconditions = conds;
    _preSource = sourceLabel;
    _renderPreconditions();
  } else {
    _draft.postconditions = conds;
    _postSource = sourceLabel;
    _renderPostconditions();
  }
}

const _capturePreconditions  = () => _captureConditions('pre');
const _capturePostconditions = () => _captureConditions('post');

function _renderPreconditions() {
  if (preSourceEl) preSourceEl.textContent = _preSource;
  if (preListEl) {
    preListEl.innerHTML = _renderConditionList(_draft?.preconditions, 'pre', 'No preconditions — click + Add to create one');
    _wireConditionListHandlers('pre');
  }
}

function _renderPostconditions() {
  if (postSourceEl) postSourceEl.textContent = _postSource;
  if (postListEl) {
    postListEl.innerHTML = _renderConditionList(_draft?.postconditions, 'post', 'No postconditions — click + Add to create one');
    _wireConditionListHandlers('post');
  }
}

// v2.74.26 — Editable condition list mirroring fragment-author. Each row
// is [type-dropdown] [type-specific input(s)] [✕]. Reuses .cond-editor,
// .cond-type-select, .cond-value-input, .review-condition-row styles
// from sidepanel.css so visuals match the Studio review panel.
function _renderConditionList(conditions, side, emptyMsg) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return `<div class="fa-conditions-empty">${escHtml(emptyMsg)}</div>`;
  }
  return conditions.map((c, idx) => _renderConditionRow(c, side, idx)).join('');
}

function _renderConditionRow(c, side, idx) {
  const type = c?.type ?? 'selector_present';
  const attrs = `data-oa-cond="1" data-side="${escAttr(side)}" data-idx="${idx}"`;
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
      // v2.74.343 — Count via the flat landmarkRefs mirror (landmarks is a
      // LandmarkNode[] tree now; .length is the root count, undercounting
      // structured perspectives). Node role label, falling back to legacy alias.
      const lmCount = Array.isArray(meta.landmarkRefs)
        ? meta.landmarkRefs.length
        : (Array.isArray(meta.landmarks) ? meta.landmarks.length : (meta.landmarkCount ?? 0));
      const firstRole = meta.landmarks?.[0]?.role ?? meta.landmarks?.[0]?.alias ?? '';
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

function _wireConditionListHandlers(side) {
  const listEl = side === 'pre' ? preListEl : postListEl;
  if (!listEl) return;
  const arr = side === 'pre' ? _draft?.preconditions : _draft?.postconditions;
  if (!Array.isArray(arr)) return;

  listEl.querySelectorAll('select.cond-type-select[data-oa-cond="1"]').forEach(sel => {
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

  listEl.querySelectorAll('input.cond-value-input[data-oa-cond="1"]').forEach(inp => {
    if (inp.dataset.side !== side) return;
    inp.addEventListener('input', () => {
      const idx = parseInt(inp.dataset.idx, 10);
      const cond = arr[idx];
      if (!cond) return;
      const field = inp.dataset.field;
      const schema = CONDITION_FIELDS[cond.type];
      if (schema && schema.fields.includes(field)) {
        cond[field] = inp.value;
        _markConditionsUserModified(side);
      }
    });
  });

  listEl.querySelectorAll('button.review-cond-remove[data-oa-cond="1"]').forEach(btn => {
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
  if (!_draft) return;
  const arr = side === 'pre' ? _draft.preconditions : _draft.postconditions;
  if (!Array.isArray(arr)) return;
  arr.push(emptyCondition('selector_present'));
  _markConditionsUserModified(side);
  side === 'pre' ? _renderPreconditions() : _renderPostconditions();
}

// v2.74.26 — Fetch the active Ground so the type dropdown can offer
// the Custom (library assertions) and Perspectives optgroups. Re-renders
// once loaded so any displayed conditions pick up the new dropdown
// options.
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
      _renderPreconditions();
      _renderPostconditions();
    }
  } catch (e) {
    console.warn('[observation-author] GET_GROUND threw:', e?.message);
  }
}

// v2.74.26 — Extracts card collapse. Same chevron pattern as the
// pre/post/antecedent cards, scoped to the Extracts section.
function _toggleExtractsCard() {
  if (!extractsCardEl) return;
  _extractsCardCollapsed = extractsCardEl.classList.toggle('fa-landmarks-card-collapsed');
  _renderExtractsToggle();
}
function _renderExtractsToggle() {
  if (!extractsCardEl || !extractsToggleGlyphEl) return;
  extractsCardEl.classList.toggle('fa-landmarks-card-collapsed', _extractsCardCollapsed);
  extractsToggleGlyphEl.textContent = _extractsCardCollapsed ? '▸' : '▾';
  if (extractsToggleBtnEl) {
    extractsToggleBtnEl.setAttribute('aria-expanded', _extractsCardCollapsed ? 'false' : 'true');
    extractsToggleBtnEl.setAttribute('aria-label', `${_extractsCardCollapsed ? 'Expand' : 'Collapse'} extracts`);
  }
}

/**
 * v2.74.26 — Bottom "Done" button. Reveals the Name card (which the
 * panel hides at mount time) and collapses every collapsible card so
 * the author's eye lands on the name field. The Save button inside the
 * Name card is the actual save trigger.
 */
function _onRevealNameClick() {
  nameCardEl?.classList.remove('hidden');
  _anteCardCollapsed     = true;
  _renderAntecedentToggle?.();
  _preCardCollapsed      = true;
  _renderConditionsToggle('pre');
  _postCardCollapsed     = true;
  _renderConditionsToggle('post');
  _extractsCardCollapsed = true;
  _renderExtractsToggle();
  nameInputEl?.focus();
}

function _showWarning(text) {
  if (!warningEl) return;
  warningEl.textContent = text;
  warningEl.classList.remove('hidden');
}

// ─── v2.74.23 — Antecedent + Run sub-card ─────────────────────────────────
//
// Mirror of fragment-author's antecedent card. Picks a fragment, runs
// it on the active tab to drive the page state, optionally with param
// values from a comma-separated input. Run flips to a refresh icon
// after success for one-click undo back to the ground's default URL.
// NOT persisted on the saved Observation record — Observations don't
// carry antecedent metadata. The chosen antecedent is forgotten on
// save/unmount.

async function _populateAntecedentDropdown() {
  if (!anteSelectEl || !_payload?.groundId) return;
  let res;
  try {
    res = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'LIST_FRAGMENTS_FOR_GROUND',
        payload: { groundId: _payload.groundId },
      }, resolve);
    });
  } catch (e) {
    console.warn('[observation-author] LIST_FRAGMENTS_FOR_GROUND threw:', e?.message);
    return;
  }
  if (!res?.success) return;
  const fragments = Array.isArray(res.fragments) ? res.fragments : [];
  _anteFragments = fragments;
  anteSelectEl.innerHTML = '<option value="">— none —</option>';
  for (const f of fragments) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name ?? 'Unnamed';
    anteSelectEl.appendChild(opt);
  }
  _refreshAntecedentParamsRow();
  _updateAntecedentCardEnabled();
}

function _onAntecedentChange() {
  if (!anteSelectEl) return;
  if (anteStatusEl) anteStatusEl.textContent = '';
  if (anteParamsInputEl) anteParamsInputEl.value = '';
  _setAntecedentRunMode('run');
  _refreshAntecedentParamsRow();
  _updateAntecedentCardEnabled();
}

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
  if (!anteSelectEl) return;
  if (_anteRunMode === 'undo') return _onAntecedentUndoClick();
  const antecedentFragmentId = anteSelectEl.value || null;
  if (!antecedentFragmentId) {
    if (anteStatusEl) anteStatusEl.textContent = 'Pick an antecedent fragment first.';
    return;
  }
  if (_tabId == null) {
    if (anteStatusEl) anteStatusEl.textContent = 'No active tab — open the page first.';
    return;
  }
  // Parse comma-separated values into a paramBindings object keyed by
  // the fragment's declared param names.
  const f = _anteFragments.find(x => x.id === antecedentFragmentId);
  const declaredParams = (f && Array.isArray(f.params)) ? f.params : [];
  const paramBindings = {};
  if (declaredParams.length > 0) {
    const raw = (anteParamsInputEl?.value ?? '').split(',').map(s => s.trim());
    for (let i = 0; i < declaredParams.length; i++) {
      paramBindings[declaredParams[i]] = raw[i] ?? '';
    }
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
    _setAntecedentRunMode('undo');
    // Re-capture preconditions against the new page state.
    try { await _capturePreconditions(); } catch {}
  } else {
    if (anteStatusEl) anteStatusEl.textContent = `Run failed: ${res?.error ?? 'unknown error'}`;
    _setAntecedentRunMode('run');
  }
  _updateAntecedentCardEnabled();
}

async function _onAntecedentUndoClick() {
  if (_tabId == null) return;
  const url = _payload?.groundUrl;
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
    try { await _capturePreconditions(); } catch {}
  } else {
    if (anteStatusEl) anteStatusEl.textContent = `Reset failed: ${res?.error ?? 'unknown error'}`;
    _setAntecedentRunMode('undo');
  }
  _updateAntecedentCardEnabled();
}

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

function _updateAntecedentCardEnabled() {
  // Lock the antecedent card once any extract is on the list (changing
  // tab state retroactively would invalidate already-verified extracts).
  const hasExtracts = (_draft?.extracts?.length ?? 0) > 0;
  const noChoice = !(anteSelectEl?.value);
  if (anteCardEl) {
    anteCardEl.classList.toggle('fa-antecedent-card-disabled', hasExtracts);
  }
  if (anteSelectEl)      anteSelectEl.disabled      = hasExtracts;
  if (anteParamsInputEl) anteParamsInputEl.disabled = hasExtracts;
  if (anteRunBtnEl) {
    anteRunBtnEl.classList.toggle('hidden', noChoice);
    anteRunBtnEl.disabled = hasExtracts;
  }
}

function _toggleAntecedentCard() {
  if (!anteCardEl) return;
  _anteCardCollapsed = anteCardEl.classList.toggle('fa-antecedent-card-collapsed');
  _renderAntecedentToggle();
}
function _renderAntecedentToggle() {
  if (!anteCardEl || !anteToggleGlyphEl) return;
  anteCardEl.classList.toggle('fa-antecedent-card-collapsed', _anteCardCollapsed);
  anteToggleGlyphEl.textContent = _anteCardCollapsed ? '▸' : '▾';
  if (anteToggleBtnEl) {
    anteToggleBtnEl.setAttribute('aria-expanded', _anteCardCollapsed ? 'false' : 'true');
    anteToggleBtnEl.setAttribute('aria-label',
      _anteCardCollapsed ? 'Expand antecedent card' : 'Collapse antecedent card');
  }
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

// Pre/postconditions card collapse — same shape as fragment-author.
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

export default { mount, unmount, handleEvent };
