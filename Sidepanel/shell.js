/**
 * @file Sidepanel/shell.js
 * @description Side panel shell. Hosts mutually-exclusive modes. Owns
 * the mount point + current-mode reference + message forwarding.
 *
 * ── Architecture (Stage 1) ────────────────────────────────────────────
 *
 * Mode contract — each mode module exports default { name, mount, unmount, handleEvent? }:
 *   - name:    string identifier matching the registry key
 *   - mount:   async (payload, mountEl) => void
 *              Render HTML into mountEl, attach listeners, set up state
 *   - unmount: async () => void
 *              Tear down listeners, clear timers, leave mountEl empty
 *   - handleEvent: (message) => void  (optional)
 *              Receives forwarded chrome.runtime messages while mounted
 *
 * Lifecycle:
 *   1. Boot: shell asks background for the active mode (rehydration).
 *      If a mode is active, mount it. Otherwise, mount the idle fallback
 *      (chat — Stage 3 will add it; for Stage 1, idle is a placeholder).
 *   2. Mode change: background broadcasts SIDEPANEL_MODE_CHANGED, OR a
 *      mode calls shellApi.requestModeChange. Shell unmounts current,
 *      mounts new.
 *   3. Message forwarding: chrome.runtime.onMessage listener forwards
 *      every message to the active mode's handleEvent if defined.
 *
 * Mode registry: name → import path. Lazy-loaded on first mount.
 *
 * @module Sidepanel/shell
 * @author Agent HUB
 * @version 2.72.50
 */

import { installGlobalErrorHandlers } from '../Core/ErrorCapture.js';
// v2.74.188 — Capture uncaught errors / unhandled promise rejections
// for the sidepanel shell + every mode it lazy-loads. Without this,
// errors in a mode's render or message handler vanish silently — they
// never reach Logger.error and never appear in the Studio Logs tab.
installGlobalErrorHandlers('sidepanel', window);

const MODE_REGISTRY = {
  'locale-capture':     () => import('./modes/locale-capture.js'),
  'strategy-debug':     () => import('./modes/strategy-debug.js'),
  // v2.74.22 — 'fragment-walk' removed. The AI-walked (T3) authoring
  // path was eliminated; T1 cache authoring (fragment-author) is the
  // only fragment-creation path now.
  'fragment-author':    () => import('./modes/fragment-author.js'),
  'observation-author': () => import('./modes/observation-author.js'),
  // v2.74.27 — Read-only Ground browse view. Lists all Grounds and their
  // libraries (Fragments, Assertions, Locales, Observations, Analyses);
  // no Strategies section, no per-row edit/json affordances. + Add
  // buttons still launch sidepanel-authorable flows.
  'ground-view':        () => import('./modes/ground-view.js'),
  // v2.74.53 — Library entry authoring modes launched from the Ground
  // sidepanel's + Assert / + Analyze buttons. Lightweight relative to
  // Studio's full forms — deep editing (operations body, k_of_n, etc.)
  // still lives in Studio.
  'assertion-author':   () => import('./modes/assertion-author.js'),
  'analysis-author':    () => import('./modes/analysis-author.js'),
  // Dedicated debugger for top-level Workflow entities (storage
  // kind=`workflow`). Mirrors the per-Ground strategy-debug mode but
  // consumes WORKFLOW_PROGRESS / WORKFLOW_PAUSE_STATE broadcasts from the
  // Workflow-tier runtime instead of CapabilityAPI events. Launched by
  // Studio's "Debug" button on Workflow entity rows.
  'workflow-debug':     () => import('./modes/workflow-debug.js'),
  // Stage 3 (chat-as-mode) — deferred. Chat keeps using chat.html.
};

// Idle fallback view. Stage 1 placeholder; Stage 3 makes this the chat mode.
const IDLE_HTML = `
  <div class="sidepanel-idle">
    <h3>AHuB</h3>
    <p>Sidepanel is ready. Open Studio or trigger an action that uses the panel.</p>
  </div>
`;

// v2.74.141 — Sticky modes.
//
// A "sticky" mode represents an active, long-running execution surface
// whose visibility shouldn't depend on which tab is currently active.
// The debugger modes (strategy-debug, workflow-debug) are the canonical
// case: while a workflow is running, the execution navigates the active
// tab to the target Ground's site. Without stickiness, the tab
// activation listener at the bottom of this file would see "this new
// tab has no recorded mode" and route to ground-view, kicking the
// debugger off the panel mid-run.
//
// When the active mode is sticky:
//   - tab-activation does NOT trigger a setMode call (debugger stays)
//   - other modes can still preempt explicitly (e.g. a new
//     BEGIN_FRAGMENT_AUTHOR broadcast still wins, because that's a
//     deliberate user action — not background drift)
//
// v2.74.147 — Stickiness is now dynamic. The sticky check first asks
// the mode's `module.isSticky?.()` (defined on debug modes; returns
// false once the run completes). If the module doesn't define one, we
// fall back to STICKY_MODES set membership. This means a finished
// debug session releases stickiness on its own — switching tabs after
// the run completes routes normally back to ground-view, instead of
// trapping the user until they hit Close.
//
// Modes still leave stickiness by:
//   - the user manually closing the sidepanel
//   - the mode unmounting itself (e.g. on invocation complete)
//   - the run reaching success / failed / aborted (isSticky → false)
//   - another explicit BEGIN_* / SET_SIDEPANEL_MODE flow
const STICKY_MODES = new Set(['strategy-debug', 'workflow-debug']);

// Whether the active mode wants to hold the panel against tab-activation
// changes. Prefers a fine-grained `module.isSticky()` callback (lets the
// mode release stickiness when its work finishes); falls back to coarse
// set membership for modes that don't opt in.
function _isCurrentModeSticky() {
  if (!currentMode) return false;
  const fn = currentMode.module?.isSticky;
  if (typeof fn === 'function') {
    try { return !!fn(); }
    catch (e) {
      console.warn('[shell] isSticky threw, falling back to set membership:', e?.message);
    }
  }
  return STICKY_MODES.has(currentMode.name);
}

let currentMode = null;       // { name, module, payload } or null
let mountEl = null;

// v2.74.36 — Per-tab mode + state preservation.
//
// _modeSnapshots holds a snapshot of each mode's serializable state,
// keyed by `${mode}:${tabId}`. The shell asks the active mode for a
// snapshot via mode.getState?.() before unmounting it; on the next
// mount of the same (mode, tab) pair the snapshot is injected into the
// payload as `payload.state` so the mode can restore.
//
// v2.74.55 — _tabModes is the source of truth for which mode each tab
// owns (tabId → { mode, payload }). Was previously a background
// service-worker map, but the SW is killed on idle so the records
// vanished on the next mount. The sidepanel page is alive much longer
// (only torn down when the user closes the panel) so the records
// survive across tab switches, SW restarts, etc.
//
// _panelWindowId is the Chrome window this sidepanel page lives in.
// Tab events fire for every window; we filter on this so a tab change
// in another window's panel doesn't disturb ours.
const _modeSnapshots = new Map();
const _tabModes = new Map();
let _panelWindowId = null;

// v2.74.58 — Snapshot key includes the per-session id so a NEW
// + Fragment / + Observation / + Locale on the same tab doesn't
// inherit the previous session's snapshot. Previously the key was
// just `${mode}:${tabId}`, which meant a stale snapshot from an
// already-cancelled fragmentA would attach to a freshly-launched
// fragmentB (same tab, same mode) — the new session would show
// fragmentA's action list. fragmentId / observationId / sessionId are
// unique per BEGIN_* invocation, so distinct sessions get distinct
// keys and a fresh session always starts clean.
function _snapshotKey(mode, payload) {
  if (!mode) return null;
  const tabId = payload?.existingTabId ?? payload?.tabId ?? null;
  if (typeof tabId !== 'number') return null;
  const sessionId = payload?.fragmentId
                 ?? payload?.observationId
                 ?? payload?.sessionId
                 ?? '';
  return `${mode}:${tabId}:${sessionId}`;
}

// v2.72.52 (P1) — Mount-window buffer.
//
// Modes mount asynchronously (lazy-import + await mod.mount). Messages
// arriving during this window have nowhere to go — currentMode is null
// until the mount call returns. Without buffering, walk events
// (STEP_PENDING, WALK_PROGRESS) that fire in the cold-mount race get
// dropped.
//
// While _mountInProgress is true, incoming messages are queued. After
// the mount completes (success or failure), the buffer flushes to the
// freshly-mounted mode's handleEvent. If mount failed, the buffer is
// discarded.
let _mountInProgress = false;
let _eventBuffer = [];
const _EVENT_BUFFER_CAP = 200;

// ─── Lifecycle ────────────────────────────────────────────────────────────

async function boot() {
  mountEl = document.getElementById('sidepanel-mount');
  if (!mountEl) {
    console.error('[shell] #sidepanel-mount element not found');
    return;
  }

  // v2.74.36 — Pin to our window so tab events from other windows
  // (each window owns its own sidepanel) don't disturb us.
  try {
    const win = await chrome.windows.getCurrent();
    _panelWindowId = win?.id ?? null;
  } catch {
    _panelWindowId = null;
  }
  _wireTabActivationListener();
  _wireTabRemovalListener();

  // Cold-boot rehydration: ask background what mode should be active.
  // If background reports an active mode (e.g., a pending locale capture
  // session, an active strategy invocation), mount it. Otherwise idle.
  let initialMode = null;
  let initialPayload = null;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SIDEPANEL_MODE' });
    if (res?.success && res.mode) {
      initialMode = res.mode;
      initialPayload = res.payload ?? {};
    }
  } catch (e) {
    console.warn('[shell] boot: GET_SIDEPANEL_MODE failed', e?.message);
  }

  if (initialMode && MODE_REGISTRY[initialMode]) {
    await setMode(initialMode, initialPayload);
  } else {
    showIdle();
  }
}

// v2.74.126 — Serialize setMode calls behind a chain promise. Pre-fix,
// two concurrent setMode invocations (e.g. burst of SIDEPANEL_MODE_CHANGED
// broadcasts coalescing with a tab-activation) would both clear
// `_eventBuffer` (losing events buffered for the first mount), both
// proceed to lazy-import + mount, and leave whichever mount finished
// last as `currentMode` — abandoning the prior mount's listeners /
// state. Same chain-promise pattern as ConversationStore v2.74.109 and
// StorageManager v2.74.119: queue rather than interleave. The .catch
// keeps one rejected setMode from poisoning the queue for subsequent
// callers.
let _setModeChain = Promise.resolve();
function setMode(name, payload = {}) {
  const next = _setModeChain.then(() => _setModeImpl(name, payload));
  _setModeChain = next.catch(() => {});
  return next;
}

async function _setModeImpl(name, payload = {}) {
  if (!MODE_REGISTRY[name]) {
    console.warn(`[shell] setMode: unknown mode "${name}"`);
    showIdle();
    return;
  }

  // v2.72.52 (P1) — Begin mount window. Events arriving from this point
  // until the mount completes are buffered, not dropped.
  _mountInProgress = true;
  _eventBuffer = [];

  // Unmount existing mode if any.
  if (currentMode) {
    // v2.74.36 — Capture the outgoing mode's state BEFORE unmount so a
    // future setMode for the same (mode, tab) can restore. Modes opt
    // in by exporting getState — modes that don't simply skip.
    try {
      const snapshot = currentMode.module.getState?.();
      const key = _snapshotKey(currentMode.name, currentMode.payload);
      if (snapshot != null && key) {
        _modeSnapshots.set(key, snapshot);
      }
    } catch (e) {
      console.warn(`[shell] getState of "${currentMode.name}" threw:`, e);
    }
    try {
      await currentMode.module.unmount?.();
    } catch (e) {
      console.error(`[shell] unmount of "${currentMode.name}" threw:`, e);
    }
    currentMode = null;
  }

  // v2.74.36 — If a snapshot exists for the incoming (mode, tab) pair,
  // inject it into payload.state so the mode can restore. Modes that
  // honor `payload.state` re-hydrate their authoring view; modes that
  // ignore it mount fresh.
  const incomingKey = _snapshotKey(name, payload);
  if (incomingKey && _modeSnapshots.has(incomingKey)) {
    payload = { ...payload, state: _modeSnapshots.get(incomingKey) };
  }

  // Clear mount element.
  if (mountEl) mountEl.innerHTML = '';

  // Lazy-import the mode module.
  let modulePromise;
  try {
    modulePromise = MODE_REGISTRY[name]();
  } catch (e) {
    console.error(`[shell] failed to start import for mode "${name}":`, e);
    _mountInProgress = false;
    _eventBuffer = [];
    showIdle();
    return;
  }
  let mod;
  try {
    const imported = await modulePromise;
    mod = imported.default ?? imported;
  } catch (e) {
    console.error(`[shell] failed to import mode "${name}":`, e);
    _mountInProgress = false;
    _eventBuffer = [];
    showIdle();
    return;
  }
  if (!mod || typeof mod.mount !== 'function') {
    console.error(`[shell] mode "${name}" module missing mount()`);
    _mountInProgress = false;
    _eventBuffer = [];
    showIdle();
    return;
  }

  // Mount.
  try {
    await mod.mount(payload, mountEl);
    currentMode = { name, module: mod, payload };
    // v2.74.55 — Register the (tab, mode) record so a future tab
    // activation can resume this mode. Skipped for ground-view, the
    // implicit fallback when no record exists.
    _rememberTabMode(name, payload);
    // v2.72.52 (P1) — Flush buffered events to the freshly-mounted mode.
    // Order preserved (events drained in arrival order). The mode handles
    // each one as if it had arrived live.
    _mountInProgress = false;
    const buffered = _eventBuffer;
    _eventBuffer = [];
    if (mod.handleEvent) {
      for (const msg of buffered) {
        try { mod.handleEvent(msg); }
        catch (e) { console.error(`[shell] buffered handleEvent threw:`, e); }
      }
    }
  } catch (e) {
    console.error(`[shell] mount of "${name}" threw:`, e);
    _mountInProgress = false;
    _eventBuffer = [];
    showIdle();
  }
}

function showIdle() {
  if (!mountEl) return;
  currentMode = null;
  mountEl.innerHTML = IDLE_HTML;
}

// v2.74.55 — Per-tab mode tracking + tab-activation listener.
//
// Each tab owns its sidepanel state. When the user switches to a
// different tab in this window, we look up the new tab's record:
//   - record present  → switch to that mode (snapshot injected into
//                       payload.state so the mode can restore)
//   - record absent   → default to ground-view, which then handles
//                       its own per-tab refresh internally (showing
//                       the matching Ground for that tab's domain or
//                       the new-Ground form if no match)
//
// The map (_tabModes) is shell-local on purpose — the sidepanel page
// outlives the service worker, so records survive SW restarts that
// would otherwise erase a background-side map.
// v2.74.127 — Tab close cleanup. Without this, `_tabModes` and the
// corresponding `_modeSnapshots` entries accumulate forever as the user
// opens and closes tabs. Chrome doesn't recycle tab IDs within a
// session, so leaked entries are inert memory bloat — but over a
// long-lived sidepanel session this map grows unboundedly. Background
// has a parallel `chrome.tabs.onRemoved` cleanup for its (mostly dead)
// __tabSidepanelModes map; the authoritative shell-side map needs the
// same hygiene. Uses _clearTabMode which also evicts the matching
// snapshot, mirroring the cleanup done by CLEAR_TAB_SIDEPANEL_MODE.
function _wireTabRemovalListener() {
  chrome.tabs?.onRemoved?.addListener?.((tabId) => {
    _clearTabMode(tabId);
  });
}

function _wireTabActivationListener() {
  chrome.tabs?.onActivated?.addListener?.(({ tabId, windowId }) => {
    // v2.74.126 — Invert the null filter. Previously the check was
    // `if (_panelWindowId != null && windowId !== _panelWindowId) return`,
    // which let events from OTHER windows pass through when our
    // `_panelWindowId` was null (e.g. boot-time `chrome.windows.getCurrent`
    // failure). The intent (per the comment at lines 90–93) was the
    // opposite — only react to OUR window's events. Fail closed: if we
    // don't know our window, ignore the event entirely.
    if (_panelWindowId == null) return;
    if (windowId !== _panelWindowId) return;
    // v2.74.141 / v2.74.147 — Sticky modes win over tab activation
    // while their underlying work is in-flight. _isCurrentModeSticky
    // checks the mode's isSticky() callback first (debug modes return
    // false once their run finishes), then falls back to set membership.
    // See the STICKY_MODES declaration above for the full rationale.
    if (_isCurrentModeSticky()) return;
    const record = _tabModes.get(tabId);
    const targetMode = record?.mode ?? 'ground-view';
    const targetPayload = record?.payload ?? {};
    // Stay put when the target is already the current mode AND that
    // mode is ground-view (which handles its own tab refresh
    // internally). For other matched-mode cases, setMode is still
    // worth calling because remount applies the latest snapshot.
    if (currentMode?.name === targetMode && targetMode === 'ground-view') return;
    setMode(targetMode, targetPayload);
  });
}

// v2.74.55 — Record / forget the mode that owns a given tab. Called
// from setMode after a successful mount; modes call _clearTabMode via
// the CLEAR_TAB_SIDEPANEL_MODE message on Save/Cancel so the next
// visit to that tab falls back to ground-view.
function _rememberTabMode(name, payload) {
  if (!name || name === 'ground-view') return;
  const tabId = payload?.existingTabId ?? payload?.tabId ?? null;
  if (typeof tabId !== 'number') return;
  // v2.74.58 — When replacing a record on the same tab (e.g. user
  // cancelled fragmentA and immediately started fragmentB), evict the
  // previous record's snapshot so it can't attach to anything.
  const prev = _tabModes.get(tabId);
  if (prev) {
    const prevKey = _snapshotKey(prev.mode, prev.payload);
    if (prevKey) _modeSnapshots.delete(prevKey);
  }
  _tabModes.set(tabId, { mode: name, payload });
}
function _clearTabMode(tabId) {
  if (typeof tabId !== 'number') return;
  // v2.74.58 — Clear the snapshot for the cleared tab too, so a
  // future BEGIN_* on the same tab can't pull stale state.
  const prev = _tabModes.get(tabId);
  if (prev) {
    const prevKey = _snapshotKey(prev.mode, prev.payload);
    if (prevKey) _modeSnapshots.delete(prevKey);
  }
  _tabModes.delete(tabId);
}

// ─── Message routing ──────────────────────────────────────────────────────
//
// The shell is the single onMessage listener. Forwarding to mode-specific
// handlers happens here — modes don't register their own runtime listeners
// (that would create the same race / leak issues we've been fighting).
//
// Two special messages:
//   - SIDEPANEL_MODE_CHANGED — broadcast from background when the active
//     mode changes. Shell switches accordingly.
//   - SET_SIDEPANEL_MODE     — direct command to set mode (used when a
//     caller doesn't want to go through background's registry).

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Mode-routing messages handled here.
  if (message?.type === 'SIDEPANEL_MODE_CHANGED') {
    const { mode, payload } = message.payload ?? {};
    if (mode === null || mode === 'idle') {
      // Tear down current mode and show idle.
      (async () => {
        if (currentMode) {
          try { await currentMode.module.unmount?.(); }
          catch (e) { console.error(`[shell] unmount threw:`, e); }
          currentMode = null;
        }
        showIdle();
      })();
    } else {
      setMode(mode, payload ?? {});
    }
    return false;
  }
  // v2.74.55 — Authoring modes broadcast this on Save/Cancel so a
  // future visit to the authoring tab doesn't auto-resume a finished
  // session. Background still has its own no-op handler for the
  // sender's chrome.runtime.lastError contract; the actual state
  // lives here in the shell now.
  if (message?.type === 'CLEAR_TAB_SIDEPANEL_MODE') {
    _clearTabMode(message.payload?.tabId);
    return false;
  }

  // v2.72.52 (P1) — Buffer events arriving during a mount in progress.
  // Flushed to the freshly-mounted mode in setMode after mount completes.
  if (_mountInProgress) {
    if (_eventBuffer.length < _EVENT_BUFFER_CAP) {
      _eventBuffer.push(message);
    }
    return false;
  }

  // Forward everything else to the active mode.
  if (currentMode?.module?.handleEvent) {
    try {
      // v2.72.52 (P2) — Forward sendResponse so modes can ack synchronous-
      // response messages (STEP_PENDING). If the mode returns true, we
      // signal async response back to chrome.runtime — same contract as a
      // top-level onMessage listener.
      const result = currentMode.module.handleEvent(message, sendResponse);
      if (result === true) return true;
    } catch (e) {
      console.error(`[shell] handleEvent in "${currentMode.name}" threw:`, e);
    }
  }
  return false;
});

// ─── Boot ────────────────────────────────────────────────────────────────

boot();
