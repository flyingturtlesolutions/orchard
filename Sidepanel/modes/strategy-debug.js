/**
 * @file Sidepanel/modes/strategy-debug.js
 * @description Strategy-debug sidepanel mode. Extracted from debugger.js
 * during Stage 2 of the multi-mode-sidepanel refactor (v2.72.51).
 *
 * Lifecycle:
 *   mount(payload, mountEl)    — render HTML, wire listeners, attach to
 *                                 active invocation
 *   unmount()                   — remove listeners, ChatAPI subscription,
 *                                 timers, clear state
 *   handleEvent(message)        — receives forwarded chrome.runtime
 *                                 messages (LOG_ENTRY) from the shell
 *
 * Payload:
 *   {} — no required payload. The mode auto-attaches to whatever
 *   debug-mode invocation is currently running (or about to start).
 *   Studio's ▶ button sets the mode and fires the invocation; the
 *   mode's mount discovers it via ChatAPI.onEvent or by polling
 *   GET_ACTIVE_DEBUG_INVOCATION.
 *
 * Architecture:
 *   - Pure consumer of CapabilityAPI events via ChatAPI.onEvent
 *     (subscribed on mount; unsubscribe on unmount)
 *   - Pure consumer of LOG_ENTRY runtime messages routed through the
 *     shell's chrome.runtime.onMessage forwarder (handleEvent)
 *   - Sends control actions via ChatAPI.debugResume / debugStep / debugPause
 *   - Sends abort via ChatAPI.cancelInvocation
 *   - Tracks ONE invocation at a time. Older invocations are dismissed if a
 *     new one starts (single-session debugger).
 *
 * @module Sidepanel/modes/strategy-debug
 * @author Agent HUB
 * @version 2.72.51
 */

import { ChatAPI } from '../../Services/ChatAPI.js';
import { toast, exitToStudio } from '../shell-api.js';

// ─── DOM refs (populated on mount) ────────────────────────────────────────

// All DOM refs are scoped to the mountEl provided at mount time.
// They're declared `let` so unmount can null them out.
let _mountEl       = null;

let idleEl        = null;     // Stage-2 note: there's no longer an "idle"
                              // sub-view inside this mode. Strategy-debug
                              // is mounted only when an invocation is active.
                              // The idle behavior moves to the shell's idle
                              // placeholder. Kept as null for transitional
                              // null-safe access in helpers below.
let activeEl     = null;
let stratNameEl  = null;
let statusPill   = null;
let elapsedEl    = null;
let invIdEl      = null;
let btnPause     = null;
let btnStep      = null;
let btnResume    = null;
let btnAbort     = null;
let btnClose     = null;
// v2.61.1 — persistent status strip (always visible while invocation active)
let whereTextEl  = null;
let urlTextEl    = null;
// v2.61.1 — scope rendering surface, now in its own tab panel
let scopeTableEl = null;
let logEl        = null;
let logClearBtn  = null;
let filterDebug  = null;
let filterInfo   = null;
let filterWarn   = null;
let filterError  = null;

// ─── State ────────────────────────────────────────────────────────────────

let activeInvocationId = null;
let activeStartTimeMs  = null;
let elapsedTimer       = null;
let capabilityName     = '';
let isPaused           = false;
let pendingPauseRequest = false;   // user clicked Pause but we haven't paused yet
let isCompleted        = false;    // invocation finished — show Close instead of controls

// Log buffer — kept in memory so filter toggles can re-render quickly without losing entries
const logEntries = [];
const LOG_RING_CAP = 1000;

// ─── v2.61.1 — Tab state ──────────────────────────────────────────────────
//
// Two tabs: 'log' and 'scope'. Auto-switch on state transitions:
//   running → 'log' tab focused
//   paused  → 'scope' tab focused
// User can manually click either tab; the click sticks until the next state
// transition. setActiveTab() handles both auto and manual switches uniformly.

function setActiveTab(tabId) {
  if (!_mountEl) return;
  const allBtns = _mountEl.querySelectorAll('.dbg-tab-btn');
  const allPanels = _mountEl.querySelectorAll('.dbg-tab-panel');
  for (const btn of allBtns) {
    btn.classList.toggle('active', btn.dataset.dbgTab === tabId);
  }
  for (const panel of allPanels) {
    panel.classList.toggle('active', panel.dataset.dbgPanel === tabId);
  }
}

// Tab buttons + idle view links + run controls + log controls all wire
// inside _wireListeners(), called from mount().

// ─── Run controls ─────────────────────────────────────────────────────────

async function _onPauseClick() {
  if (!activeInvocationId) return;
  pendingPauseRequest = true;
  // Visual feedback: disable Pause, show "pausing" pill. Engine pauses at
  // the next yield-point, at which time the paused event arrives and we
  // call showPausedControls to flip to Step/Resume.
  btnPause.disabled = true;
  setStatusPill('pausing');
  try {
    await ChatAPI.debugPause(activeInvocationId);
  } catch (e) {
    console.warn('[strategy-debug] pause failed:', e?.message);
    btnPause.disabled = false;
    setStatusPill('running');
  }
}

async function _onStepClick() {
  if (!activeInvocationId) return;
  // Step releases the pause once. Engine advances one yield-point then
  // pauses again automatically (debugStep re-arms via onPauseStateChange).
  // UI: switch to running visuals; the next paused event flips us back.
  setStatusPill('running');
  showRunningControls();
  try {
    await ChatAPI.debugStep(activeInvocationId);
  } catch (e) {
    console.warn('[strategy-debug] step failed:', e?.message);
  }
}

async function _onResumeClick() {
  if (!activeInvocationId) return;
  // Resume runs to completion (no more auto-pauses unless user clicks Pause).
  // UI: switch to running visuals — Pause+Abort visible, Step+Resume hidden.
  setStatusPill('running');
  showRunningControls();
  try {
    await ChatAPI.debugResume(activeInvocationId);
  } catch (e) {
    console.warn('[strategy-debug] resume failed:', e?.message);
  }
}

async function _onAbortClick() {
  if (!activeInvocationId) return;
  if (!confirm('Abort this invocation?')) return;
  try {
    // ChatAPI's method is named `cancel`, not `cancelInvocation`.
    await ChatAPI.cancel(activeInvocationId);
  } catch (e) {
    console.warn('[strategy-debug] abort failed:', e?.message);
  }
}

async function _onCloseClick() {
  // v2.72.54 — Cancel/close on every mode dismisses the sidepanel and
  // returns focus to Studio. exitToStudio handles mode-clear + close +
  // Studio focus. Strategy invocations run independently of mode
  // mounting (they live in background); closing the panel doesn't
  // cancel the strategy. To abort, the user uses the Abort button.
  exitToStudio();
}

function _onLogClearClick() {
  logEntries.length = 0;
  renderLog();
}

// v2.72.54 — _requestUnmount kept for any non-cancel internal callers
// that want a soft unmount without exiting to Studio. Currently unused
// after _onCloseClick rerouted; left as a no-cost helper.
async function _requestUnmount() {
  try {
    await chrome.runtime.sendMessage({
      type: 'REQUEST_SIDEPANEL_MODE',
      payload: { mode: null },
    });
  } catch (e) {
    console.warn('[strategy-debug] requestUnmount threw:', e?.message);
  }
}

// ─── Event subscriptions ──────────────────────────────────────────────────

// v2.49.0 — Adopt unknown invocations on first event.
//
// Bug: after extension reload, the debugger panel may boot AFTER a strategy's
// `invocation.started` event has already fired and broadcast (no listener
// existed yet). Polling for active invocations only finds running ones — by
// the time a `failed`/`completed` event arrives, status has transitioned and
// polling returns null. The handlers then drop those events because
// `event.invocationId !== activeInvocationId`.
//
// Fix: when an event for an UNKNOWN invocation arrives, query background by
// id (regardless of status) and synthesize a started event so the handlers
// can adopt the invocation, THEN re-dispatch the original event. The
// debugger UI catches up retroactively.
//
// Idempotency: this only runs when activeInvocationId is null. Once an
// invocation is active, subsequent events for OTHER invocationIds continue
// to be filtered out (single-session debugger semantics).
let pendingAdoption = null;  // Promise of an in-flight adoption, for dedupe

async function tryAdoptInvocation(invocationId) {
  if (!invocationId) return false;
  if (activeInvocationId === invocationId) return true;
  // If an adoption for this id is already in flight, await it and inherit
  // the result. This keeps multiple racing events from each kicking off
  // their own adoption (and from being silently dropped while one is in flight).
  if (pendingAdoption) {
    try { return await pendingAdoption; } catch { return false; }
  }
  pendingAdoption = (async () => {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GET_DEBUG_INVOCATION_BY_ID',
        payload: { invocationId },
      });
      if (!res?.success || !res.invocation) {
        console.warn('[debugger] could not adopt — lookup returned no invocation for id:', invocationId.slice(0, 8), res);
        return false;
      }
      if (!res.invocation.debugMode || res.invocation.debugMode === 'off') {
        // v2.49.1 — was silent. If the strategy was launched without debug
        // mode, this rejects adoption and the debugger sits idle. Log loudly
        // so the user can see WHY the panel isn't populating.
        console.warn(
          `[debugger] not adopting — invocation ${invocationId.slice(0, 8)} has debugMode=${JSON.stringify(res.invocation.debugMode)}.`,
          'This invocation was launched without debug mode (likely from a non-debug studio click).',
          'The debugger only attaches to debug-mode invocations.',
        );
        return false;
      }
      console.log('[debugger] adopting in-progress invocation (post-event):', invocationId.slice(0, 8));
      handleInvocationStarted({
        type: 'invocation.started',
        invocationId  : res.invocation.invocationId,
        capabilityId  : res.invocation.capabilityId,
        capabilityName: res.invocation.capabilityName,
        debugMode     : res.invocation.debugMode,
        totalSteps    : res.invocation.totalSteps,
      });
      if (res.invocation.status === 'failed' || res.invocation.status === 'completed' ||
          res.invocation.status === 'cancelled') {
        isCompleted = true;
      }
      return true;
    } finally {
      pendingAdoption = null;
    }
  })();
  return await pendingAdoption;
}

// CapabilityAPI events — invocation lifecycle. The handler is registered
// in mount() via ChatAPI.onEvent which returns an unsubscribe function.
// Unsubscribe is stashed in _chatApiUnsub for unmount.
async function _onChatApiEvent(event) {
  console.log('[strategy-debug] event:', event.type, event.invocationId?.slice(0,8) ?? '', event.debugMode ?? '');
  // v2.49.0 — adoption path for unknown invocations.
  if (event.type !== 'invocation.started' &&
      event.invocationId &&
      activeInvocationId !== event.invocationId &&
      !activeInvocationId) {
    const adopted = await tryAdoptInvocation(event.invocationId);
    if (!adopted) return;
  }

  switch (event.type) {
    case 'invocation.started':   handleInvocationStarted(event);   break;
    case 'invocation.progress':  handleInvocationProgress(event);  break;
    case 'invocation.completed': handleInvocationCompleted(event); break;
    case 'invocation.failed':    handleInvocationFailed(event);    break;
    case 'invocation.cancelled': handleInvocationCancelled(event); break;
  }
}

let _chatApiUnsub = null;

// LOG_ENTRY buffer — entries arriving before an invocation is adopted are
// buffered up to _PENDING_LOG_CAP, drained on adoption.
const _pendingLogEntries = [];
const _PENDING_LOG_CAP = 200;

// Called by handleEvent (shell forwards chrome.runtime messages here).
function _onLogEntry(entry) {
  if (!activeInvocationId) {
    _pendingLogEntries.push(entry);
    if (_pendingLogEntries.length > _PENDING_LOG_CAP) _pendingLogEntries.shift();
    return;
  }
  appendLogEntry(entry);
}

function drainPendingLogEntries() {
  if (!activeInvocationId || _pendingLogEntries.length === 0) return;
  const drained = _pendingLogEntries.splice(0, _pendingLogEntries.length);
  for (const entry of drained) appendLogEntry(entry);
}

// On mount, ask background for any currently-running debug invocation so we
// can attach to one that started before our subscription wired up.
//
// Poll-with-retry: query immediately, then again at 200/500/1500 ms. The
// retry handles the worst case where the side panel finishes loading
// BEFORE the studio's CAPABILITY_INVOKE message even reaches background.
// Once we find an invocation, we stop polling.
async function attachToActiveInvocation() {
  for (const delayMs of [0, 200, 500, 1500]) {
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    if (activeInvocationId) return;   // already attached via live event
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_DEBUG_INVOCATION' });
      if (res?.success && res.invocation) {
        console.log('[debugger] attaching to in-progress invocation:', res.invocation.invocationId?.slice(0,8), `(after ${delayMs}ms)`);
        handleInvocationStarted({
          type: 'invocation.started',
          invocationId  : res.invocation.invocationId,
          capabilityId  : res.invocation.capabilityId,
          capabilityName: res.invocation.capabilityName,
          debugMode     : res.invocation.debugMode,
          totalSteps    : res.invocation.totalSteps,
        });
        return;
      }
    } catch (e) {
      console.warn('[strategy-debug] could not query active invocation:', e?.message);
    }
  }
}
// (call moved to mount())

// ─── Handlers ─────────────────────────────────────────────────────────────

function handleInvocationStarted(event) {
  // v2.74.123 — Bail if we've been unmounted. attachToActiveInvocation
  // polls async after mount; if the user closes the panel before the
  // poll finds an invocation, the response callback would still fire
  // this handler against nulled DOM refs (stratNameEl etc.), which
  // would TypeError. The outer try/catch around the polling sendMessage
  // catches it but produces noisy logs.
  if (!_mountEl) return;
  // Only attach to debug-mode invocations. Non-debug runs are not our concern.
  if (event.debugMode === 'off' || !event.debugMode) {
    // v2.49.1 — was silent. Log so the user can see why the debugger
    // isn't populating for this invocation.
    console.warn(
      `[debugger] ignoring invocation.started for ${event.invocationId?.slice(0, 8) ?? '?'} — debugMode=${JSON.stringify(event.debugMode)}.`,
      'Strategy was launched without debug mode.',
    );
    return;
  }

  // If an invocation is already active, dismiss it. Single-session debugger.
  if (activeInvocationId && activeInvocationId !== event.invocationId) {
    // Don't lose info — just take over. The previous invocation continues but
    // we no longer track it visually. (User had said don't show multiple.)
    activeInvocationId = null;
  }

  activeInvocationId = event.invocationId;
  activeStartTimeMs  = Date.now();
  capabilityName     = event.capabilityName ?? 'Strategy';
  isPaused           = false;
  pendingPauseRequest = false;
  isCompleted        = false;
  logEntries.length  = 0;

  // v2.72.51 (Stage 2) — In mode-based architecture, this mode IS the
  // visible view. The shell handles mutually-exclusive mode switching;
  // there's no internal idle/locale view to hide here.

  stratNameEl.textContent = capabilityName;
  invIdEl.textContent     = event.invocationId.slice(0, 8) + '…';
  setStatusPill('running');
  setStatusText('▶ Running…');

  // Start elapsed timer
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = setInterval(updateElapsed, 200);
  updateElapsed();

  // Set initial controls — running state
  showRunningControls();
  renderLog();

  // v2.49.0 — flush any LOG_ENTRYs that arrived BEFORE adoption (cold-start
  // race). The buffer is empty for normal runs; non-empty only when the
  // debugger is being adopted retroactively.
  drainPendingLogEntries();
}

function handleInvocationProgress(event) {
  if (!_mountEl) return;     // v2.74.123 — post-unmount guard
  if (event.invocationId !== activeInvocationId) return;

  if (event.phase === 'paused') {
    isPaused = true;
    pendingPauseRequest = false;
    setStatusPill('paused');
    showPausedControls();
    renderPauseDetail(event);
    return;
  }
  if (event.phase === 'resumed') {
    isPaused = false;
    setStatusPill('running');
    showRunningControls();
    return;
  }
  // v2.61.1 — node_complete events carry scope + url + where info while
  // running. Update the persistent status strip and Scope tab so the user
  // sees current state without having to pause.
  if (event.phase === 'node_complete') {
    renderPauseDetail(event);   // same fields, same renderer
    return;
  }
  // Other phases (fragment_start/complete/etc.) flow through Logger and
  // appear in the log section. Nothing else to do here.
}

function handleInvocationCompleted(event) {
  if (!_mountEl) return;     // v2.74.123 — post-unmount guard
  if (event.invocationId !== activeInvocationId) return;
  isCompleted = true;
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  setStatusPill('complete');
  setStatusText(`✓ Complete — ${event.result?.stepResults?.length ?? 0} step(s)`);
  showCompletedControls();
}

function handleInvocationFailed(event) {
  if (!_mountEl) return;     // v2.74.123 — post-unmount guard
  if (event.invocationId !== activeInvocationId) return;
  isCompleted = true;
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  setStatusPill('failed');
  setStatusText(`✗ Failed — ${event.error ?? 'unknown'}`);
  showCompletedControls();
}

function handleInvocationCancelled(event) {
  if (!_mountEl) return;     // v2.74.123 — post-unmount guard
  if (event.invocationId !== activeInvocationId) return;
  isCompleted = true;
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  setStatusPill('aborted');
  setStatusText('✕ Aborted');
  showCompletedControls();
}

// ─── Status helpers ───────────────────────────────────────────────────────

function setStatusPill(kind, also) {
  // kind: 'running' | 'paused' | 'complete' | 'failed' | 'aborted' | 'pausing'
  statusPill.className = 'dbg-status-pill dbg-status-' + kind;
  statusPill.textContent = kind;
  if (also) statusPill.classList.add('dbg-status-' + also);
}

function setStatusText(text) {
  // Repurposes the strategy-name slot for live status when paused/complete
  // (alongside name). Keeps the name visible and adds context.
  // Simpler implementation: just leave the strategy name; pill carries state.
  // text param kept for future inline status messaging; currently a no-op
  // beyond the pill update.
  void text;
}

function updateElapsed() {
  if (!activeStartTimeMs) return;
  const elapsedMs = Date.now() - activeStartTimeMs;
  if (elapsedMs < 1000) {
    elapsedEl.textContent = `+${elapsedMs}ms`;
  } else if (elapsedMs < 60000) {
    elapsedEl.textContent = `+${(elapsedMs / 1000).toFixed(1)}s`;
  } else {
    const m = Math.floor(elapsedMs / 60000);
    const s = Math.floor((elapsedMs % 60000) / 1000);
    elapsedEl.textContent = `+${m}m${s.toString().padStart(2, '0')}s`;
  }
}

// ─── Control visibility per state ─────────────────────────────────────────

function showRunningControls() {
  btnPause.classList.remove('hidden');
  btnPause.disabled = false;   // reset from any prior "pausing" state
  btnStep.classList.add('hidden');
  btnResume.classList.add('hidden');
  btnAbort.classList.remove('hidden');
  btnClose.classList.add('hidden');
  // v2.61.1 — auto-focus Log tab on resume/start. User can override by
  // clicking Scope; the override sticks until the next state transition.
  setActiveTab('log');
}

function showPausedControls() {
  btnPause.classList.add('hidden');
  btnStep.classList.remove('hidden');
  btnResume.classList.remove('hidden');
  btnAbort.classList.remove('hidden');
  btnClose.classList.add('hidden');
  // v2.61.1 — auto-focus Scope tab on pause for review.
  setActiveTab('scope');
}

function showCompletedControls() {
  btnPause.classList.add('hidden');
  btnStep.classList.add('hidden');
  btnResume.classList.add('hidden');
  btnAbort.classList.add('hidden');
  btnClose.classList.remove('hidden');
}

// ─── Pause detail rendering ───────────────────────────────────────────────

function renderPauseDetail(event) {
  // Where: "Step N/M: Label" with optional iteration label
  const where = [];
  if (typeof event.nodeIdx === 'number' && typeof event.totalNodes === 'number') {
    where.push(`Step ${event.nodeIdx + 1}/${event.totalNodes}`);
  }
  if (event.nodeLabel) where.push(event.nodeLabel);
  whereTextEl.textContent = where.join(': ') || '—';
  if (event.iterationLabel) {
    whereTextEl.textContent += ' · ' + event.iterationLabel;
  }

  // URL
  urlTextEl.textContent = event.url ?? '—';

  // Scope
  renderScope(event.scopeSnapshot ?? {});
}

// ─── v2.61.3 — Rich Scope-tab rendering ──────────────────────────────────
//
// Each binding renders as:
//   1. A header row: name + kind + one-line preview.
//   2. A body block when the binding has expandable detail:
//      - list-of-records → inline table (cols = field names, rows = records)
//      - list-of-scalars → bulleted list
//      - element with .record → selector + field rows
//      - record → field rows
//      Lists cap at SCOPE_LIST_PREVIEW_CAP rows visible by default with a
//      "show all" affordance for longer lists.
//   3. Scalars and bare elements get header only — there's no expandable
//      detail beyond the value already shown.

const SCOPE_LIST_PREVIEW_CAP = 10;
const SCOPE_CELL_TRUNCATE   = 60;

function renderScope(scope) {
  const names = Object.keys(scope ?? {});
  if (names.length === 0) {
    scopeTableEl.innerHTML = '<div class="dbg-scope-empty">No bindings yet</div>';
    return;
  }
  scopeTableEl.innerHTML = '';
  for (const name of names) {
    const v = scope[name];
    const card = renderScopeBinding(name, v);
    scopeTableEl.appendChild(card);
  }
}

/**
 * Build one binding card: header (name + kind + summary) plus an optional
 * body with expanded detail.
 */
function renderScopeBinding(name, v) {
  const card = document.createElement('div');
  card.className = 'dbg-scope-binding';

  // Header — always present
  const header = document.createElement('div');
  header.className = 'dbg-scope-row';
  const nameEl = document.createElement('span');
  nameEl.className = 'dbg-scope-name';
  nameEl.textContent = name;
  const typeEl = document.createElement('span');
  typeEl.className = 'dbg-scope-type';
  typeEl.textContent = describeKind(v);
  const valEl = document.createElement('span');
  valEl.className = 'dbg-scope-value';
  valEl.textContent = formatValue(v);
  header.appendChild(nameEl);
  header.appendChild(typeEl);
  header.appendChild(valEl);
  card.appendChild(header);

  // Body — only for bindings that have expandable detail
  const body = renderScopeBindingBody(v);
  if (body) card.appendChild(body);

  return card;
}

/**
 * Returns a DOM element with expanded detail for the binding, or null when
 * the header is sufficient (scalars, elements with no record).
 */
function renderScopeBindingBody(v) {
  if (v == null) return null;

  // v2.72.13 (Pass 10a) — Single image: thumbnail + metadata + open-full.
  if (v.kind === 'image') {
    return renderImageBinding(v);
  }

  // v2.72.14 (Pass 6) — Section: markdown preview + image/link references.
  if (v.kind === 'section') {
    return renderSectionBinding(v);
  }

  // v2.72.19 (Pass 7b iter 3) — Document: composed markdown artifact.
  // Markdown preview, source binding provenance, char count, download.
  if (v.kind === 'document') {
    return renderDocumentBinding(v);
  }

  // Element with record — show selector + field rows
  if (v.kind === 'element' && v.record && typeof v.record === 'object' && Object.keys(v.record).length > 0) {
    return renderRecordFields(v.record);
  }

  // Record — show field rows
  if (v.kind === 'record' && v.fields && Object.keys(v.fields).length > 0) {
    return renderRecordFields(v.fields);
  }

  // List
  if (v.kind === 'list') {
    const items = Array.isArray(v.items) ? v.items : [];
    if (items.length === 0) return null;

    // v2.72.13 (Pass 10a) — Image list (image_list shape from frontier
    // Observation): render as a thumbnail grid. Check this branch BEFORE
    // the record-list branches since image-kind items don't have .record
    // or .fields and would otherwise fall through to renderItemsList.
    if (items.every(it => it?.kind === 'image')) {
      return renderImageGrid(items);
    }

    // List of records (ENUMERATE shape: items have .record)
    if (items.every(it => it?.record && typeof it.record === 'object')) {
      return renderRecordsTable(items.map(it => it.record));
    }
    // List of pure records
    if (items.every(it => it?.kind === 'record' && it?.fields)) {
      return renderRecordsTable(items.map(it => it.fields));
    }
    // List of scalars / elements without records — bulleted list
    return renderItemsList(items);
  }

  return null;
}

/**
 * Render a list-of-records as a compact inline table.
 *
 * Columns are the union of field names from the first record's keys, in
 * insertion order (ENUMERATE captures fields in declaration order, so this
 * preserves author intent — don't sort alphabetically).
 *
 * Caps at SCOPE_LIST_PREVIEW_CAP visible rows; longer lists get a "show all"
 * affordance.
 */
function renderRecordsTable(records) {
  const wrap = document.createElement('div');
  wrap.className = 'dbg-scope-body dbg-scope-records-wrap';

  // Column union — insertion order from each record, deduped
  const cols = [];
  const seen = new Set();
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  if (cols.length === 0) {
    // Records exist but have no fields — show as count only
    wrap.textContent = `(${records.length} record${records.length === 1 ? '' : 's'} with no fields)`;
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'dbg-scope-records-table';

  // Header row
  const thead = document.createElement('thead');
  const headTr = document.createElement('tr');
  // Index column
  const idxTh = document.createElement('th');
  idxTh.className = 'dbg-scope-idx-col';
  idxTh.textContent = '#';
  headTr.appendChild(idxTh);
  for (const col of cols) {
    const th = document.createElement('th');
    th.textContent = col;
    headTr.appendChild(th);
  }
  thead.appendChild(headTr);
  table.appendChild(thead);

  // Body rows
  const tbody = document.createElement('tbody');
  const visibleCount = Math.min(records.length, SCOPE_LIST_PREVIEW_CAP);
  for (let i = 0; i < visibleCount; i++) {
    const tr = renderRecordRow(records[i], cols, i);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  // "Show all" affordance for longer lists
  if (records.length > SCOPE_LIST_PREVIEW_CAP) {
    const more = document.createElement('button');
    more.className = 'dbg-scope-show-all';
    more.type = 'button';
    more.textContent = `Showing ${visibleCount} of ${records.length} · show all`;
    more.addEventListener('click', () => {
      // Append remaining rows; remove the button.
      for (let i = visibleCount; i < records.length; i++) {
        tbody.appendChild(renderRecordRow(records[i], cols, i));
      }
      more.remove();
    });
    wrap.appendChild(more);
  }
  return wrap;
}

function renderRecordRow(record, cols, idx) {
  const tr = document.createElement('tr');
  const idxTd = document.createElement('td');
  idxTd.className = 'dbg-scope-idx-cell';
  idxTd.textContent = String(idx);
  tr.appendChild(idxTd);
  for (const col of cols) {
    const td = document.createElement('td');
    const raw = record?.[col];
    const display = raw == null ? '' : String(raw);
    td.textContent = truncate(display, SCOPE_CELL_TRUNCATE);
    if (display.length > SCOPE_CELL_TRUNCATE) {
      td.title = display;       // hover shows full text
    }
    tr.appendChild(td);
  }
  return tr;
}

/**
 * Render a list of scalars / elements / non-record items as a bulleted list.
 */
function renderItemsList(items) {
  const wrap = document.createElement('div');
  wrap.className = 'dbg-scope-body dbg-scope-items-wrap';
  const ul = document.createElement('ul');
  ul.className = 'dbg-scope-items';
  const visibleCount = Math.min(items.length, SCOPE_LIST_PREVIEW_CAP);
  for (let i = 0; i < visibleCount; i++) {
    ul.appendChild(renderItemLi(items[i], i));
  }
  wrap.appendChild(ul);
  if (items.length > SCOPE_LIST_PREVIEW_CAP) {
    const more = document.createElement('button');
    more.className = 'dbg-scope-show-all';
    more.type = 'button';
    more.textContent = `Showing ${visibleCount} of ${items.length} · show all`;
    more.addEventListener('click', () => {
      for (let i = visibleCount; i < items.length; i++) {
        ul.appendChild(renderItemLi(items[i], i));
      }
      more.remove();
    });
    wrap.appendChild(more);
  }
  return wrap;
}

function renderItemLi(item, idx) {
  const li = document.createElement('li');
  const idxSpan = document.createElement('span');
  idxSpan.className = 'dbg-scope-idx-cell';
  idxSpan.textContent = String(idx);
  const valSpan = document.createElement('span');
  valSpan.className = 'dbg-scope-item-value';
  // Item shape varies — could be scalar, element, image, or raw string.
  let display;
  if (typeof item === 'string') display = item;
  else if (item?.kind === 'scalar') display = String(item.value ?? '');
  else if (item?.kind === 'element') display = item.selector ?? '(unnamed element)';
  // v2.72.13 (Pass 10a) — Defensive fallback for image-kind items in a
  // mixed list. Pure image_list lists are caught by renderImageGrid in
  // renderScopeBindingBody; this branch handles the rare mixed case
  // (e.g. an Analysis that produces a list with some images and some
  // scalars) so the user sees label + dimensions instead of
  // "[object Object]".
  else if (item?.kind === 'image') {
    const dims = `${item.width || '?'}×${item.height || '?'}`;
    display = item.label ? `${dims} · ${item.label}` : `${dims} (image)`;
  }
  // v2.72.19 (Pass 7b iter 3) — Defensive fallback for document-kind
  // items in a mixed list. Avoid JSON.stringify which would inline the
  // full content (potentially many KB).
  else if (item?.kind === 'document') {
    const len = (item.content ?? '').length;
    const fmt = item.format ?? 'markdown';
    display = `${len} chars · ${fmt} (document)`;
  }
  else display = JSON.stringify(item);
  valSpan.textContent = truncate(display, SCOPE_CELL_TRUNCATE * 2);
  if (display.length > SCOPE_CELL_TRUNCATE * 2) {
    valSpan.title = display;
  }
  li.appendChild(idxSpan);
  li.appendChild(valSpan);
  return li;
}

/**
 * v2.72.13 (Pass 10a) — Render a single image binding. Frontier-tier
 * Observations (shape='image') produce {kind:'image', base64, mime,
 * width, height, label, sourceUrl, capturedAt}.
 *
 * The card shows:
 *   - Thumbnail (max 200×150, browser preserves aspect ratio)
 *   - Dimensions and label
 *   - Source URL (truncated) and capture timestamp
 *   - Open full size button (new tab via data: URL)
 *
 * Defensive: if base64 is missing or empty, render a metadata-only card
 * with a "(no image data)" placeholder rather than crashing.
 */
function renderImageBinding(v) {
  const wrap = document.createElement('div');
  wrap.className = 'dbg-scope-body dbg-scope-image-wrap';

  const card = document.createElement('div');
  card.className = 'dbg-scope-image-card';

  // Thumbnail — or placeholder if no bytes.
  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'dbg-scope-image-thumb';
  if (v.base64) {
    const img = document.createElement('img');
    img.src = `data:${v.mime || 'image/png'};base64,${v.base64}`;
    img.alt = v.label || '';
    img.className = 'dbg-scope-image-thumb-img';
    // Click image to open full size in a new tab. Use chrome.tabs.create
    // when available (debugger runs in extension context); fallback to
    // window.open for any context where chrome.tabs isn't available.
    img.addEventListener('click', () => openImageFullSize(v));
    img.title = 'Click to open full size in new tab';
    thumbWrap.appendChild(img);
  } else {
    thumbWrap.classList.add('dbg-scope-image-thumb-empty');
    thumbWrap.textContent = '(no image data)';
  }
  card.appendChild(thumbWrap);

  // Metadata column — dimensions, label, source URL, capture time.
  const meta = document.createElement('div');
  meta.className = 'dbg-scope-image-meta';

  const dims = document.createElement('div');
  dims.className = 'dbg-scope-image-meta-row';
  dims.innerHTML = `<span class="dbg-scope-image-meta-label">size:</span> <span class="dbg-scope-image-meta-value">${v.width || '?'} × ${v.height || '?'}</span>`;
  meta.appendChild(dims);

  if (v.label) {
    const lab = document.createElement('div');
    lab.className = 'dbg-scope-image-meta-row';
    lab.innerHTML = `<span class="dbg-scope-image-meta-label">label:</span> <span class="dbg-scope-image-meta-value">${escapeHtml(v.label)}</span>`;
    meta.appendChild(lab);
  }

  if (v.sourceUrl) {
    const src = document.createElement('div');
    src.className = 'dbg-scope-image-meta-row';
    const truncated = truncate(v.sourceUrl, 60);
    src.innerHTML = `<span class="dbg-scope-image-meta-label">from:</span> <span class="dbg-scope-image-meta-value" title="${escapeHtml(v.sourceUrl)}">${escapeHtml(truncated)}</span>`;
    meta.appendChild(src);
  }

  if (v.capturedAt) {
    const ts = document.createElement('div');
    ts.className = 'dbg-scope-image-meta-row';
    const when = new Date(v.capturedAt).toLocaleString();
    ts.innerHTML = `<span class="dbg-scope-image-meta-label">when:</span> <span class="dbg-scope-image-meta-value">${escapeHtml(when)}</span>`;
    meta.appendChild(ts);
  }

  if (v.base64) {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'dbg-scope-image-open';
    openBtn.textContent = '↗ Open full size';
    openBtn.addEventListener('click', () => openImageFullSize(v));
    meta.appendChild(openBtn);
  }

  card.appendChild(meta);
  wrap.appendChild(card);
  return wrap;
}

/**
 * v2.72.13 (Pass 10a) — Render a list of images as a thumbnail grid
 * (image_list shape from frontier-tier Observation). Each thumbnail
 * shows index + label and links to full-size view in a new tab.
 *
 * Caps visible thumbnails at SCOPE_LIST_PREVIEW_CAP (same convention
 * as record lists); over-cap shows a "show all" button.
 */
function renderImageGrid(items) {
  const wrap = document.createElement('div');
  wrap.className = 'dbg-scope-body dbg-scope-image-grid-wrap';

  const grid = document.createElement('div');
  grid.className = 'dbg-scope-image-grid';

  const visibleCount = Math.min(items.length, SCOPE_LIST_PREVIEW_CAP);
  for (let i = 0; i < visibleCount; i++) {
    grid.appendChild(renderImageGridItem(items[i], i));
  }
  wrap.appendChild(grid);

  if (items.length > SCOPE_LIST_PREVIEW_CAP) {
    const more = document.createElement('button');
    more.className = 'dbg-scope-show-all';
    more.type = 'button';
    more.textContent = `Showing ${visibleCount} of ${items.length} · show all`;
    more.addEventListener('click', () => {
      for (let i = visibleCount; i < items.length; i++) {
        grid.appendChild(renderImageGridItem(items[i], i));
      }
      more.remove();
    });
    wrap.appendChild(more);
  }

  return wrap;
}

function renderImageGridItem(item, idx) {
  const tile = document.createElement('div');
  tile.className = 'dbg-scope-image-grid-item';

  // Index badge — overlays the thumbnail's top-left corner.
  const idxBadge = document.createElement('span');
  idxBadge.className = 'dbg-scope-image-grid-idx';
  idxBadge.textContent = String(idx);
  tile.appendChild(idxBadge);

  if (item?.base64) {
    const img = document.createElement('img');
    img.src = `data:${item.mime || 'image/png'};base64,${item.base64}`;
    img.alt = item.label || '';
    img.className = 'dbg-scope-image-grid-img';
    img.title = item.label
      ? `${item.label} (${item.width || '?'}×${item.height || '?'}) — click to open full size`
      : `Click to open full size`;
    img.addEventListener('click', () => openImageFullSize(item));
    tile.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'dbg-scope-image-grid-placeholder';
    placeholder.textContent = '(no data)';
    tile.appendChild(placeholder);
  }

  if (item?.label) {
    const cap = document.createElement('div');
    cap.className = 'dbg-scope-image-grid-caption';
    cap.textContent = truncate(item.label, 30);
    cap.title = item.label;
    tile.appendChild(cap);
  }

  return tile;
}

/**
 * v2.72.13 (Pass 10a) — Open an image binding in a new tab. Uses
 * chrome.tabs.create when available (debugger runs in extension context);
 * falls back to window.open for any context without chrome.tabs.
 *
 * Note: chrome.tabs.create with a data: URL works in MV3 extension pages
 * — service workers and extension pages have the privilege; content
 * scripts do not. The debugger runs in an extension page.
 */
function openImageFullSize(v) {
  if (!v?.base64) return;
  const url = `data:${v.mime || 'image/png'};base64,${v.base64}`;
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, '_blank');
    }
  } catch (_) {
    // Last-resort fallback if chrome.tabs.create rejects (e.g. URL
    // length limits on some Chrome versions). window.open should still
    // work for reasonable sizes.
    try { window.open(url, '_blank'); } catch (_) { /* nothing more we can do */ }
  }
}

/**
 * v2.72.14 (Pass 6) — Render a section binding (cache-tier Observation
 * shape='section'). Shows:
 *   - Provenance: source URL (truncated), capture timestamp.
 *   - Markdown preview: first ~600 chars, with a "show all" expander
 *     for longer content. Pre-formatted text — preserves the markdown
 *     formatting in monospace.
 *   - Image refs: small thumbnail grid loading via the captured src URL.
 *     Click thumbnail to open the full image in a new tab. Empty image
 *     list shows "(no images)".
 *   - Link refs: numbered list of href + text. First N shown with
 *     show-all expander. Each href is clickable.
 *
 * Section content is information-rich; the goal is to show the operator
 * "what's in here" at a glance and let them drill in if needed.
 */
function renderSectionBinding(v) {
  const wrap = document.createElement('div');
  wrap.className = 'dbg-scope-body dbg-scope-section-wrap';

  // Provenance.
  if (v.sourceUrl || v.capturedAt) {
    const prov = document.createElement('div');
    prov.className = 'dbg-scope-section-provenance';
    if (v.sourceUrl) {
      const link = document.createElement('a');
      link.href = v.sourceUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = truncate(v.sourceUrl, 70);
      link.title = v.sourceUrl;
      link.className = 'dbg-scope-section-source';
      prov.appendChild(link);
    }
    if (v.capturedAt) {
      const ts = document.createElement('span');
      ts.className = 'dbg-scope-section-ts';
      ts.textContent = new Date(v.capturedAt).toLocaleString();
      prov.appendChild(ts);
    }
    wrap.appendChild(prov);
  }

  // Markdown preview.
  const mdSection = document.createElement('div');
  mdSection.className = 'dbg-scope-section-block';
  const mdLabel = document.createElement('div');
  mdLabel.className = 'dbg-scope-section-block-label';
  mdLabel.textContent = `Markdown (${(v.markdown ?? '').length} chars)`;
  mdSection.appendChild(mdLabel);

  const MD_PREVIEW_CHARS = 600;
  const mdPre = document.createElement('pre');
  mdPre.className = 'dbg-scope-section-markdown';
  const md = v.markdown ?? '';
  if (md.length > MD_PREVIEW_CHARS) {
    mdPre.textContent = md.slice(0, MD_PREVIEW_CHARS) + '…';
    const showAll = document.createElement('button');
    showAll.type = 'button';
    showAll.className = 'dbg-scope-show-all';
    showAll.textContent = `Showing ${MD_PREVIEW_CHARS} of ${md.length} chars · show all`;
    showAll.addEventListener('click', () => {
      mdPre.textContent = md;
      showAll.remove();
    });
    mdSection.appendChild(mdPre);
    mdSection.appendChild(showAll);
  } else if (md.length === 0) {
    mdPre.textContent = '(empty)';
    mdPre.classList.add('dbg-scope-section-empty');
    mdSection.appendChild(mdPre);
  } else {
    mdPre.textContent = md;
    mdSection.appendChild(mdPre);
  }
  wrap.appendChild(mdSection);

  // Image refs.
  const images = v.images?.items ?? [];
  const imgSection = document.createElement('div');
  imgSection.className = 'dbg-scope-section-block';
  const imgLabel = document.createElement('div');
  imgLabel.className = 'dbg-scope-section-block-label';
  imgLabel.textContent = `Images (${images.length})`;
  imgSection.appendChild(imgLabel);
  if (images.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dbg-scope-section-empty';
    empty.textContent = '(no images)';
    imgSection.appendChild(empty);
  } else {
    imgSection.appendChild(renderSectionImageRefGrid(images));
  }
  wrap.appendChild(imgSection);

  // Link refs.
  const links = v.links?.items ?? [];
  const linkSection = document.createElement('div');
  linkSection.className = 'dbg-scope-section-block';
  const linkLabel = document.createElement('div');
  linkLabel.className = 'dbg-scope-section-block-label';
  linkLabel.textContent = `Links (${links.length})`;
  linkSection.appendChild(linkLabel);
  if (links.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'dbg-scope-section-empty';
    empty.textContent = '(no links)';
    linkSection.appendChild(empty);
  } else {
    linkSection.appendChild(renderSectionLinkRefList(links));
  }
  wrap.appendChild(linkSection);

  return wrap;
}

/**
 * v2.72.19 (Pass 7b iter 3) — Render a document tagged value (output of
 * a template-kind Analysis). Composed markdown artifact with provenance.
 *
 * Layout:
 *   - Provenance row: "composed from: ARTICLE, GALLERY, COVER" + timestamp
 *   - Content block: markdown preview (first 600 chars) with show-all
 *   - Footer: char count, byte size, format badge, download button
 *
 * Rendering uses pre-formatted text (same as section markdown) — no
 * markdown-to-HTML conversion in the debugger; that's chat's job. The
 * goal here is operator inspection: see what was composed, verify
 * structure, copy or download as needed.
 */
function renderDocumentBinding(v) {
  const wrap = document.createElement('div');
  wrap.className = 'dbg-scope-body dbg-scope-document-wrap';

  // ── Provenance row ───────────────────────────────────────────────
  const sources = Array.isArray(v.sourceBindings) ? v.sourceBindings : [];
  const hasProv = sources.length > 0 || v.composedAt;
  if (hasProv) {
    const prov = document.createElement('div');
    prov.className = 'dbg-scope-document-provenance';
    if (sources.length > 0) {
      const src = document.createElement('span');
      src.className = 'dbg-scope-document-sources';
      src.textContent = `composed from: ${sources.join(', ')}`;
      prov.appendChild(src);
    }
    if (v.composedAt) {
      const ts = document.createElement('span');
      ts.className = 'dbg-scope-document-ts';
      ts.textContent = new Date(v.composedAt).toLocaleString();
      prov.appendChild(ts);
    }
    wrap.appendChild(prov);
  }

  // ── Content block ────────────────────────────────────────────────
  const contentSection = document.createElement('div');
  contentSection.className = 'dbg-scope-section-block';
  const contentLabel = document.createElement('div');
  contentLabel.className = 'dbg-scope-section-block-label';
  const content = v.content ?? '';
  const byteSize = (typeof v.byteSize === 'number' && v.byteSize > 0) ? v.byteSize : content.length;
  contentLabel.textContent = `Content (${content.length} chars · ${formatByteSize(byteSize)})`;
  contentSection.appendChild(contentLabel);

  const PREVIEW_CHARS = 600;
  const pre = document.createElement('pre');
  pre.className = 'dbg-scope-section-markdown';
  if (content.length > PREVIEW_CHARS) {
    pre.textContent = content.slice(0, PREVIEW_CHARS) + '…';
    const showAll = document.createElement('button');
    showAll.type = 'button';
    showAll.className = 'dbg-scope-show-all';
    showAll.textContent = `Showing ${PREVIEW_CHARS} of ${content.length} chars · show all`;
    showAll.addEventListener('click', () => {
      pre.textContent = content;
      showAll.remove();
    });
    contentSection.appendChild(pre);
    contentSection.appendChild(showAll);
  } else if (content.length === 0) {
    pre.textContent = '(empty)';
    pre.classList.add('dbg-scope-section-empty');
    contentSection.appendChild(pre);
  } else {
    pre.textContent = content;
    contentSection.appendChild(pre);
  }
  wrap.appendChild(contentSection);

  // ── Footer: format badge + download button ───────────────────────
  const footer = document.createElement('div');
  footer.className = 'dbg-scope-document-footer';

  const formatBadge = document.createElement('span');
  formatBadge.className = 'dbg-scope-document-format';
  formatBadge.textContent = v.format ?? 'markdown';
  footer.appendChild(formatBadge);

  if (content.length > 0) {
    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'dbg-scope-document-download';
    dlBtn.textContent = '↓ Download';
    dlBtn.title = `Download as .${formatToExt(v.format ?? 'markdown')} file`;
    dlBtn.addEventListener('click', () => downloadDocument(v));
    footer.appendChild(dlBtn);
  }

  wrap.appendChild(footer);

  return wrap;
}

/**
 * Render a byte size as a short human-readable string.
 * Used by the document footer.
 */
function formatByteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Map a document format to its file extension. Defaults to .txt for
 * unknown formats.
 */
function formatToExt(format) {
  if (format === 'markdown') return 'md';
  if (format === 'html')     return 'html';
  if (format === 'json')     return 'json';
  return 'txt';
}

/**
 * Trigger a download of the document's content. Uses a blob URL + anchor
 * click. Filename derived from "document-<timestamp>.<ext>".
 */
function downloadDocument(v) {
  const ext = formatToExt(v.format ?? 'markdown');
  const mime = (v.format === 'markdown') ? 'text/markdown'
             : (v.format === 'html')     ? 'text/html'
             : (v.format === 'json')     ? 'application/json'
             : 'text/plain';
  const ts = v.composedAt ? new Date(v.composedAt) : new Date();
  // Format timestamp for filename: YYYYMMDD-HHMMSS
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  const filename = `document-${stamp}.${ext}`;
  const blob = new Blob([v.content ?? ''], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke shortly after; immediate revoke can race with browser dispatch.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * v2.72.14 (Pass 6) — Render section.images as a small thumbnail grid.
 * Items are record-tagged values with {src, alt, width, height, ...}.
 * Each thumbnail loads the image directly from the captured src URL
 * (the page's actual image URL — possibly cross-origin, possibly
 * unavailable if the page set Cookie or Referrer constraints; if load
 * fails we show alt text fallback).
 */
function renderSectionImageRefGrid(items) {
  const grid = document.createElement('div');
  grid.className = 'dbg-scope-section-images';
  const visibleCount = Math.min(items.length, SCOPE_LIST_PREVIEW_CAP);
  for (let i = 0; i < visibleCount; i++) {
    grid.appendChild(renderSectionImageRefTile(items[i], i));
  }
  if (items.length > SCOPE_LIST_PREVIEW_CAP) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'dbg-scope-show-all';
    more.textContent = `Showing ${visibleCount} of ${items.length} · show all`;
    more.addEventListener('click', () => {
      // Insert remaining tiles before the button, then remove the button.
      for (let i = visibleCount; i < items.length; i++) {
        grid.insertBefore(renderSectionImageRefTile(items[i], i), more);
      }
      more.remove();
    });
    grid.appendChild(more);
  }
  return grid;
}

function renderSectionImageRefTile(item, idx) {
  // record-kind items have .fields with the captured attributes.
  const fields = item?.fields ?? item ?? {};
  const src = fields.src || fields.currentSrc || '';
  const alt = fields.alt || '';

  const tile = document.createElement('div');
  tile.className = 'dbg-scope-section-image-tile';

  const idxBadge = document.createElement('span');
  idxBadge.className = 'dbg-scope-section-image-idx';
  idxBadge.textContent = String(idx);
  tile.appendChild(idxBadge);

  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    img.className = 'dbg-scope-section-image-img';
    img.title = alt
      ? `${alt} — click to open in new tab`
      : `Click to open in new tab`;
    img.addEventListener('click', () => {
      try {
        if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
          chrome.tabs.create({ url: src });
        } else {
          window.open(src, '_blank');
        }
      } catch (_) { /* swallow */ }
    });
    // If the image fails to load (CORS, dead URL), replace with a
    // text fallback showing alt + URL.
    img.addEventListener('error', () => {
      const fallback = document.createElement('div');
      fallback.className = 'dbg-scope-section-image-fallback';
      fallback.textContent = alt || truncate(src, 30);
      fallback.title = `Image failed to load: ${src}`;
      tile.replaceChild(fallback, img);
    });
    tile.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'dbg-scope-section-image-fallback';
    placeholder.textContent = '(no src)';
    tile.appendChild(placeholder);
  }

  if (alt) {
    const cap = document.createElement('div');
    cap.className = 'dbg-scope-section-image-caption';
    cap.textContent = truncate(alt, 30);
    cap.title = alt;
    tile.appendChild(cap);
  }

  return tile;
}

/**
 * v2.72.14 (Pass 6) — Render section.links as a numbered list. Each
 * link is clickable (target=_blank). First N shown; over-cap gets a
 * show-all expander.
 */
function renderSectionLinkRefList(items) {
  const wrap = document.createElement('div');
  wrap.className = 'dbg-scope-section-links';
  const ul = document.createElement('ul');
  ul.className = 'dbg-scope-section-link-list';

  const visibleCount = Math.min(items.length, SCOPE_LIST_PREVIEW_CAP);
  for (let i = 0; i < visibleCount; i++) {
    ul.appendChild(renderSectionLinkRefRow(items[i], i));
  }
  wrap.appendChild(ul);

  if (items.length > SCOPE_LIST_PREVIEW_CAP) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'dbg-scope-show-all';
    more.textContent = `Showing ${visibleCount} of ${items.length} · show all`;
    more.addEventListener('click', () => {
      for (let i = visibleCount; i < items.length; i++) {
        ul.appendChild(renderSectionLinkRefRow(items[i], i));
      }
      more.remove();
    });
    wrap.appendChild(more);
  }
  return wrap;
}

function renderSectionLinkRefRow(item, idx) {
  const fields = item?.fields ?? item ?? {};
  const href = fields.href || '';
  const text = fields.text || '';

  const li = document.createElement('li');
  li.className = 'dbg-scope-section-link-row';

  const idxSpan = document.createElement('span');
  idxSpan.className = 'dbg-scope-section-link-idx';
  idxSpan.textContent = String(idx);
  li.appendChild(idxSpan);

  if (text) {
    const textSpan = document.createElement('span');
    textSpan.className = 'dbg-scope-section-link-text';
    textSpan.textContent = truncate(text, 60);
    if (text.length > 60) textSpan.title = text;
    li.appendChild(textSpan);
  }

  if (href) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'dbg-scope-section-link-href';
    a.textContent = truncate(href, 70);
    a.title = href;
    li.appendChild(a);
  }

  return li;
}

/**
 * v2.72.13 (Pass 10a) — Minimal HTML escape for inline string interpolation
 * into innerHTML. The renderer mostly uses textContent (safe), but
 * metadata rows compose inner HTML for label/value pairs and need escaped
 * user-controlled strings (sourceUrl, label).
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a single record's fields as label-value rows.
 */
function renderRecordFields(record) {
  const wrap = document.createElement('div');
  wrap.className = 'dbg-scope-body dbg-scope-fields-wrap';
  for (const k of Object.keys(record)) {
    const row = document.createElement('div');
    row.className = 'dbg-scope-field-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'dbg-scope-field-label';
    labelEl.textContent = k;
    const valSpan = document.createElement('span');
    valSpan.className = 'dbg-scope-field-value';
    const raw = record[k];
    const display = raw == null ? '' : String(raw);
    valSpan.textContent = truncate(display, SCOPE_CELL_TRUNCATE * 2);
    if (display.length > SCOPE_CELL_TRUNCATE * 2) {
      valSpan.title = display;
    }
    row.appendChild(labelEl);
    row.appendChild(valSpan);
    wrap.appendChild(row);
  }
  return wrap;
}

function describeKind(v) {
  if (v == null) return '?';
  if (typeof v === 'string') return 'string';
  if (v.kind === 'scalar') return 'scalar';
  if (v.kind === 'list') return `list(${v.items?.length ?? 0})`;
  if (v.kind === 'element') return 'element';
  if (v.kind === 'record') return 'record';
  // v2.72.13 (Pass 10a) — image-kind binding (frontier-tier Observation
  // output, shape='image'). image_list shape produces a list of images
  // and is described by the list(N) branch above.
  if (v.kind === 'image') return 'image';
  // v2.72.14 (Pass 6) — section-kind binding (cache-tier Observation
  // output, shape='section'). Carries markdown + plain text + image
  // refs + link refs.
  if (v.kind === 'section') return 'section';
  // v2.72.19 (Pass 7b iter 3) — document-kind binding (cache-tier
  // template-body Analysis output). Composed markdown artifact.
  if (v.kind === 'document') return 'document';
  return typeof v;
}

function formatValue(v) {
  if (v == null) return '';
  if (typeof v === 'string') return truncate(v, 80);
  if (v.kind === 'scalar') return truncate(String(v.value ?? ''), 80);
  if (v.kind === 'list') {
    const n = v.items?.length ?? 0;
    if (n === 0) return '[]';
    // v2.72.13 (Pass 10a) — image_list summary. When all items are
    // image-kind, surface that distinction in the header so the operator
    // sees "[3 images]" rather than the generic "[3 items]".
    if (v.items.every(it => it?.kind === 'image')) {
      return `[${n} image${n === 1 ? '' : 's'}]`;
    }
    // v2.61.2 — preview record fields when items carry them. ENUMERATE
    // produces items shaped {kind:'element', record:{...}}; pure records
    // (rare) are {kind:'record', fields:{...}}. Both expose human-readable
    // field names — check `it?.record` (ENUMERATE shape) first since
    // that's the common path; fall back to `it?.fields` for raw records.
    if (v.items.every(it => it?.record)) {
      const first = v.items[0].record ?? {};
      const keys = Object.keys(first).slice(0, 3).join(', ');
      const more = Object.keys(first).length > 3 ? '…' : '';
      return `[${n} record${n === 1 ? '' : 's'} · ${keys}${more}]`;
    }
    if (v.items.every(it => it?.kind === 'record')) {
      const first = v.items[0].fields ?? {};
      const keys = Object.keys(first).slice(0, 3).join(', ');
      const more = Object.keys(first).length > 3 ? '…' : '';
      return `[${n} record${n === 1 ? '' : 's'} · ${keys}${more}]`;
    }
    // v2.74.148 — Preview scalar items inline so single-scalar lists
    // (and the first value of a longer list) are readable without
    // expanding the row. Mirrors workflow-debug's _formatTaggedValue
    // behavior; the previous "[N items]" fallback hid the actual
    // content. Especially load-bearing for image_read results, which
    // before v2.74.148's wrap-step fix always produced a 1-item list.
    if (v.items.every(it => it?.kind === 'scalar')) {
      const first = String(v.items[0].value ?? '');
      const headPreview = first.length > 40 ? first.slice(0, 37) + '…' : first;
      return n === 1 ? headPreview : `${headPreview} · +${n - 1} more`;
    }
    return `[${n} item${n === 1 ? '' : 's'}]`;
  }
  if (v.kind === 'element') return truncate(v.selector ?? '', 80);
  if (v.kind === 'record') {
    return truncate(JSON.stringify(v.fields ?? {}), 80);
  }
  // v2.72.13 (Pass 10a) — image header summary. Show dimensions plus
  // label when present. The thumbnail itself renders in the body via
  // renderImageBinding.
  if (v.kind === 'image') {
    const dims = `${v.width || '?'}×${v.height || '?'}`;
    return v.label ? `${dims} · ${truncate(v.label, 50)}` : dims;
  }
  // v2.72.14 (Pass 6) — section header summary. Char count of markdown
  // plus image and link counts. Body shows the actual content.
  if (v.kind === 'section') {
    const md = (v.markdown ?? '').length;
    const ni = v.images?.items?.length ?? 0;
    const nl = v.links?.items?.length ?? 0;
    return `${md} chars · ${ni} image${ni === 1 ? '' : 's'} · ${nl} link${nl === 1 ? '' : 's'}`;
  }
  // v2.72.19 (Pass 7b iter 3) — document header summary. Char count +
  // format. Source binding provenance shown in the body.
  if (v.kind === 'document') {
    const len = (v.content ?? '').length;
    const fmt = v.format ?? 'markdown';
    return `${len} chars · ${fmt}`;
  }
  return truncate(JSON.stringify(v), 80);
}

function truncate(s, n) {
  if (typeof s !== 'string') s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ─── Log handling ─────────────────────────────────────────────────────────

function appendLogEntry(entry) {
  if (!entry) return;
  // Only log while we have an active invocation. Idle logs are noise.
  if (!activeInvocationId) return;

  logEntries.push({
    ...entry,
    relMs: activeStartTimeMs ? (Date.now() - activeStartTimeMs) : 0,
  });
  if (logEntries.length > LOG_RING_CAP) logEntries.shift();

  // Append a single row instead of full re-render for performance
  if (passesFilter(entry)) {
    const row = renderLogRow(logEntries[logEntries.length - 1]);
    if (logEl.querySelector('.dbg-log-empty')) {
      logEl.innerHTML = '';
    }
    logEl.appendChild(row);
    // v2.61.2 — independent DOM cap. Filter mismatches mean DOM and
    // logEntries can drift apart, so cap each separately. Without this
    // the DOM grows unbounded over long sessions.
    while (logEl.children.length > LOG_RING_CAP) {
      const first = logEl.firstElementChild;
      if (!first || first.classList.contains('dbg-log-empty')) break;
      first.remove();
    }
    // Auto-scroll if user is near the bottom
    if (isNearBottom(logEl)) {
      logEl.scrollTop = logEl.scrollHeight;
    }
  }
}

function renderLog() {
  logEl.innerHTML = '';
  const filtered = logEntries.filter(passesFilter);
  if (filtered.length === 0) {
    logEl.innerHTML = '<div class="dbg-log-empty">No log entries match current filters.</div>';
    return;
  }
  for (const entry of filtered) {
    logEl.appendChild(renderLogRow(entry));
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function passesFilter(entry) {
  const lvl = entry.level;
  if (lvl === 'DEBUG') return filterDebug.checked;
  if (lvl === 'INFO')  return filterInfo.checked;
  if (lvl === 'WARN')  return filterWarn.checked;
  if (lvl === 'ERROR') return filterError.checked;
  return true;
}

function renderLogRow(entry) {
  const row = document.createElement('div');
  row.className = `dbg-log-row dbg-log-${(entry.level || 'INFO').toLowerCase()}`;
  // Timestamp (relative)
  const ts = document.createElement('span');
  ts.className = 'dbg-log-ts';
  ts.textContent = formatRelMs(entry.relMs ?? 0);
  // Level pill
  const lvl = document.createElement('span');
  lvl.className = `dbg-log-level dbg-log-level-${(entry.level || 'info').toLowerCase()}`;
  lvl.textContent = entry.level ?? 'INFO';
  // Source
  const src = document.createElement('span');
  src.className = 'dbg-log-source';
  src.textContent = entry.source ?? '';
  // Message
  const msg = document.createElement('span');
  msg.className = 'dbg-log-message';
  msg.textContent = entry.message ?? '';

  row.appendChild(ts);
  row.appendChild(lvl);
  row.appendChild(src);
  row.appendChild(msg);
  return row;
}

function formatRelMs(ms) {
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60000) return `+${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `+${m}m${s.toString().padStart(2, '0')}s`;
}

function isNearBottom(el) {
  return (el.scrollHeight - el.scrollTop - el.clientHeight) < 50;
}

// ─── Reset (mode-architecture) ────────────────────────────────────────────

// v2.72.51 (Stage 2) — `resetToIdle` from the old debugger.js becomes
// "ask the shell to unmount us." The shell shows its idle placeholder
// (or chat in Stage 3). Internal state is cleared in unmount() too;
// callers that want a clean teardown without unmounting can call
// _clearState directly — though there's no current caller for that.
function _clearState() {
  activeInvocationId = null;
  activeStartTimeMs = null;
  capabilityName = '';
  isPaused = false;
  isCompleted = false;
  pendingPauseRequest = false;
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  logEntries.length = 0;
  _pendingLogEntries.length = 0;
  pendingAdoption = null;
}

// ─── HTML template ────────────────────────────────────────────────────────

function renderHTML() {
  return `
    <div class="dbg-active">
      <header class="dbg-header">
        <div class="dbg-header-row">
          <span data-dbg="strategy-name" class="dbg-strategy-name">—</span>
          <span data-dbg="status-pill" class="dbg-status-pill dbg-status-running">running</span>
        </div>
        <div class="dbg-header-meta">
          <span data-dbg="elapsed">+0.0s</span>
          <span class="dbg-meta-sep">·</span>
          <span data-dbg="invocation-id" title="Invocation ID">—</span>
        </div>
      </header>

      <section class="dbg-controls">
        <button data-dbg="btn-pause"  class="dbg-btn dbg-btn-pause">⏸ Pause</button>
        <button data-dbg="btn-step"   class="dbg-btn dbg-btn-step hidden">⏭ Step</button>
        <button data-dbg="btn-resume" class="dbg-btn dbg-btn-resume hidden">▶ Resume</button>
        <button data-dbg="btn-abort"  class="dbg-btn dbg-btn-abort">✕ Abort</button>
        <button data-dbg="btn-close"  class="dbg-btn dbg-btn-close hidden">Close</button>
      </section>

      <section class="dbg-status-strip">
        <div class="dbg-strip-row">
          <span class="dbg-strip-label">where</span>
          <span data-dbg="where-text" class="dbg-strip-value">—</span>
        </div>
        <div class="dbg-strip-row">
          <span class="dbg-strip-label">tab url</span>
          <span data-dbg="url-text" class="dbg-strip-value mono">—</span>
        </div>
      </section>

      <nav class="dbg-tab-nav">
        <button class="dbg-tab-btn active" data-dbg-tab="log">Log</button>
        <button class="dbg-tab-btn" data-dbg-tab="scope">Scope</button>
      </nav>

      <section class="dbg-tab-panel active" data-dbg-panel="log">
        <div class="dbg-log-toolbar">
          <div class="dbg-log-filter">
            <label>
              <input type="checkbox" data-dbg="filter-debug" />
              <span>debug</span>
            </label>
            <label>
              <input type="checkbox" data-dbg="filter-info" checked />
              <span>info</span>
            </label>
            <label>
              <input type="checkbox" data-dbg="filter-warn" checked />
              <span>warn</span>
            </label>
            <label>
              <input type="checkbox" data-dbg="filter-error" checked />
              <span>error</span>
            </label>
          </div>
          <button data-dbg="log-clear" class="dbg-log-clear" title="Clear log">clear</button>
        </div>
        <div data-dbg="log" class="dbg-log">
          <div class="dbg-log-empty">No log entries yet.</div>
        </div>
      </section>

      <section class="dbg-tab-panel" data-dbg-panel="scope">
        <div data-dbg="scope-table" class="dbg-scope-table">
          <div class="dbg-scope-empty">No bindings yet</div>
        </div>
      </section>
    </div>
  `;
}

// ─── Mount / Unmount / handleEvent ────────────────────────────────────────

async function mount(payload, mountEl) {
  _mountEl = mountEl;
  mountEl.innerHTML = renderHTML();

  // Resolve scoped DOM refs.
  const q = (key) => mountEl.querySelector(`[data-dbg="${key}"]`);
  activeEl     = mountEl.querySelector('.dbg-active');
  stratNameEl  = q('strategy-name');
  statusPill   = q('status-pill');
  elapsedEl    = q('elapsed');
  invIdEl      = q('invocation-id');
  btnPause     = q('btn-pause');
  btnStep      = q('btn-step');
  btnResume    = q('btn-resume');
  btnAbort     = q('btn-abort');
  btnClose     = q('btn-close');
  whereTextEl  = q('where-text');
  urlTextEl    = q('url-text');
  scopeTableEl = q('scope-table');
  logEl        = q('log');
  logClearBtn  = q('log-clear');
  filterDebug  = q('filter-debug');
  filterInfo   = q('filter-info');
  filterWarn   = q('filter-warn');
  filterError  = q('filter-error');

  // Wire button handlers.
  btnPause.addEventListener('click', _onPauseClick);
  btnStep.addEventListener('click', _onStepClick);
  btnResume.addEventListener('click', _onResumeClick);
  btnAbort.addEventListener('click', _onAbortClick);
  btnClose.addEventListener('click', _onCloseClick);
  logClearBtn.addEventListener('click', _onLogClearClick);

  // Wire filter checkboxes — re-render log when toggled.
  for (const cb of [filterDebug, filterInfo, filterWarn, filterError]) {
    cb.addEventListener('change', renderLog);
  }

  // Wire tab buttons (manual user clicks).
  mountEl.querySelectorAll('.dbg-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.dbgTab));
  });

  // v2.74.123 — Defensive: if mount() is called twice without unmount,
  // the prior subscription's unsubscribe function would be overwritten
  // and the prior subscriber would remain in ChatAPI's set. Every event
  // would then fire the handler twice — duplicate log entries, flickering
  // status pills. Shell currently enforces pairing, but cheap to guard.
  if (_chatApiUnsub) { try { _chatApiUnsub(); } catch {} _chatApiUnsub = null; }

  // Subscribe to ChatAPI events. Returns an unsubscribe function.
  _chatApiUnsub = ChatAPI.onEvent(_onChatApiEvent);

  // Attach to in-progress invocation (poll-with-retry).
  attachToActiveInvocation();
}

async function unmount() {
  // Unsubscribe from ChatAPI events.
  if (_chatApiUnsub) {
    try { _chatApiUnsub(); } catch {}
    _chatApiUnsub = null;
  }
  // Clear state (timer, log buffers, invocation refs).
  _clearState();
  // Drop DOM refs.
  activeEl = stratNameEl = statusPill = elapsedEl = invIdEl = null;
  btnPause = btnStep = btnResume = btnAbort = btnClose = null;
  whereTextEl = urlTextEl = scopeTableEl = logEl = logClearBtn = null;
  filterDebug = filterInfo = filterWarn = filterError = null;
  if (_mountEl) {
    _mountEl.innerHTML = '';
    _mountEl = null;
  }
}

// Shell forwards every chrome.runtime.onMessage to handleEvent. We filter
// for LOG_ENTRY here. Other modes' messages (e.g., PICK_RESULT for locale-
// capture) are not relevant.
function handleEvent(message) {
  if (message?.type === 'LOG_ENTRY') {
    _onLogEntry(message.payload);
  }
}

// v2.74.147 — Sticky-mode release hook. Shell.js checks isSticky?.()
// before STICKY_MODES set membership.
//
// v2.74.158 — Sticky only when there's an active invocation; stayed
// sticky until completion. Auto-released on completion so a tab
// switch could route back to ground-view.
//
// v2.74.191 — Stay sticky AFTER completion too. The user explicitly
// requested manual-close-only behavior: the debugger panel should
// remain mounted on success / fail / abort until they click Close
// (which calls exitToStudio). The previous auto-release on
// `isCompleted` was treating completion as a cue to dismiss the
// panel, but the post-run state (final log lines, result summary,
// step outcomes) is often exactly what the user wants to inspect.
// We still release stickiness when the mode is idle (never adopted
// an invocation) so it can't trap the panel in that edge case.
function isSticky() {
  if (activeInvocationId == null) return false;
  return true;
}

export default {
  name: 'strategy-debug',
  mount,
  unmount,
  handleEvent,
  isSticky,
};