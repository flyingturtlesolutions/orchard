/**
 * @file background.js
 * @description Agent HUB — Manifest V3 service worker.
 *
 * Message types handled:
 *   START_WALK        — Opens a new focused tab, runs TemplateWalker recursive discovery.
 *   RUN_TEST          — Validates, injects, enqueues job.
 *   SET_API_KEY       — Persists Anthropic API key.
 *   GET_API_KEY       — Returns masked key.
 *   CHECK_API_KEY     — Returns boolean hasKey.
 *   GET_GROUNDS       — Returns all Ground records.
 *   GET_RESULTS       — Returns recent JobResult records.
 *   GET_LOGS          — Returns persisted log entries.
 *   CLEAR_LOGS        — Clears log storage.
 *
 * @module background
 * @author Agent HUB
 * @version 2.19.0
 */

import { Logger, LOG_LEVEL }  from './Core/Logger.js';
import { installGlobalErrorHandlers } from './Core/ErrorCapture.js';
import { ExecutionEngine }    from './Services/ExecutionEngine.js';
import { StorageManager }     from './Services/StorageManager.js';
import { executeWorkflow }    from './Services/WorkflowExecutor.js';
import { AnthropicService }   from './Services/AnthropicService.js';
import { CapabilityAPI, EVENT as CAP_EVENT } from './Services/CapabilityAPI.js';
import { TemplateWalker }     from './Services/TemplateWalker.js';
import { DiscoveryService }   from './Services/DiscoveryService.js';
import { PageClassifier }     from './Services/PageClassifier.js';
// v2.71.4 — ConversationStore for background-side terminal-event persistence.
// Lets chat-launched invocations write their result back to the conversation
// even when the chat panel is closed at completion time.
import { ConversationStore }  from './Services/ConversationStore.js';
// v2.74.145 / v2.74.146 — Shared image-capture pipeline (snap / full /
// read). Used by both the OBSERVE_IMAGE_*_BG message handlers
// (sidepanel verify) and ExecutionEngine (runtime). ExecutionEngine
// runs in this same SW, so it imports + calls directly instead of
// self-messaging (which closes the response port immediately in MV3
// module SWs).
import {
  performImageSnap,
  performImageFull,
  performImageRead,
} from './Services/ImageReadCapture.js';
// v2.74.277 — Static imports for substrate modules (Phases 5-10.5).
// Chrome MV3 service workers disallow dynamic `import()` per HTML
// spec; the prior `await import(...)` lazy-load pattern in handlers
// would fail with: "import() is disallowed on
// ServiceWorkerGlobalScope". All substrate modules now eagerly load
// at SW startup, which is fine — these modules are small + the
// startup is already paying for many other imports.
import { listLandmarksForGround, resolveLandmarkRef } from './Services/LandmarkResolver.js';
import { listActiveLocales }                          from './Services/LocalePredicates.js';
import { analyzeLandmarkImpact }                      from './Services/LandmarkImpactAnalysis.js';
import { emit as emitGroundEvent_bg,
         list as listGroundEvents_bg,
         clear as clearGroundEvents_bg }              from './Services/GroundEventBus.js';
import { verifyLandmark,
         verifyStaleSuspectedOnGround }               from './Services/LandmarkVerifier.js';
import { replaceLandmarkReferences }                  from './Services/LandmarkReplacer.js';
import { findReplacementCandidates }                  from './Services/LandmarkReplacementCandidates.js';
// v2.74.312 — Verify-time effect observation. Brackets an authoring
// Verify dispatch with the same observation machinery the runtime
// uses (Phase 6.5), so the author can confirm an action's declared
// effect against what actually happens — before save, not just at run.
import { bracket as observeActionBracket,
         classifyEffectDrift }                        from './Services/ActionEffectObserver.js';
// v2.74.329 — GROUND_SPEC § 5 derived-intent cache validation.
import { derivationInputsHash, DERIVATION_VERSION }   from './Core/groundDerivation.js';

Logger.setLevel(LOG_LEVEL.DEBUG);
Logger.setPersist(true);

// v2.74.188 — Install global error + unhandledrejection handlers on the
// service worker's `self`. Catches anything thrown out of a top-level
// async callback or an un-awaited Promise that would otherwise vanish
// without ever reaching the Logger (and thus never appearing in the
// Studio Logs tab). Runs before any other code so an error in module
// init still has a handler to catch it.
installGlobalErrorHandlers('background', self);

const engine = new ExecutionEngine();
CapabilityAPI.setEngine(engine);

// v2.58.1 — expose PageClassifier on the service worker's global scope so
// its inspection methods (dumpTelemetry, clearTelemetry, rawTelemetry) are
// reachable from the service worker DevTools console. Service workers
// disallow dynamic import() per the HTML spec, so attaching to self is the
// cleanest inspection path. No effect on extension behavior — just adds a
// global reference. Invoke as e.g. `await self.PageClassifier.dumpTelemetry()`.
self.PageClassifier = PageClassifier;

// Run migrations at startup — safe to call on every wake (guarded internally).
// v2.21.0: wipes Path-era data (no backward compat per user decision).
// v2.72.48: renames predicate→assertion in stored records and condition refs.
// Migrations chained: fragment migration first (data shape), then the
// rename (terminology). Both must complete before message handlers read
// stored Fragments / Strategies / Predicates(Assertions).
async function _runMigrations() {
  const fragRes = await StorageManager.migrateToFragmentModel();
  if (fragRes.ran) Logger.info('background', `v2.21.0 migration: wiped ${fragRes.keysRemoved} Path-era keys`);
  const renameRes = await StorageManager.migrateToAssertionRename();
  if (renameRes.ran) {
    Logger.info(
      'background',
      `v2.72.48 migration: renamed ${renameRes.recordsRenamed} predicate→assertion records, updated ${renameRes.refsUpdated} primitives with refs`
    );
  }
}
let _migrationPromise = _runMigrations()
  .catch(err => Logger.error('background', `migration failed: ${err.message}`));
chrome.runtime.onInstalled.addListener(() => {
  _migrationPromise = _runMigrations()
    .catch(err => Logger.error('background', `migration failed: ${err.message}`));
});
chrome.runtime.onStartup?.addListener?.(() => {
  _migrationPromise = _runMigrations()
    .catch(err => Logger.error('background', `migration failed: ${err.message}`));
});

/**
 * v2.27.0 — STORAGE_CHANGED broadcaster.
 *
 * Fired after any CUD operation on a shared record (strategies, fragments,
 * grounds, groundmaps). Both the Studio tab and the chat sidepanel listen
 * and refresh their UIs so edits in one context don't leave the other stale.
 *
 * Uses chrome.runtime.sendMessage, which reaches all extension pages
 * (sidepanel, studio, chat) but not content scripts. Errors are swallowed —
 * if no listener is registered (e.g., only one context is open), sendMessage
 * rejects with "Receiving end does not exist" which is not a real failure.
 *
 * @param {'strategy'|'fragment'|'ground'|'groundmap'} kind
 * @param {string|null} id    - record id, or null for bulk / non-id operations
 * @param {'saved'|'deleted'} action
 */
function broadcastStorageChanged(kind, id, action) {
  chrome.runtime.sendMessage({
    type: 'STORAGE_CHANGED',
    kind, id, action,
    ts: Date.now(),
  }).catch(() => { /* no listeners; fine */ });
}


// v2.74.22 — walkAbortFlags + stepApprovalResolvers removed; only the
// AI-walked path used them and that path is gone.

/**
 * Active Discovery abort flags keyed by groundId (Pass 4).
 * Set to true when ABORT_DISCOVERY is received; checked between page visits
 * in DiscoveryService.
 */
const discoveryAbortFlags = new Map();

/**
 * v2.74.23 — Resolve the URL the antecedent fragment should start from.
 * Preference order:
 *   1. The fragment's `url_matches` precondition pattern, if it looks
 *      like a literal URL (auto-captured from currentUrl at authoring
 *      time, so usually is). A regex-style pattern (slashes around it)
 *      isn't navigable; we fall through.
 *   2. The fragment's `startUrl` field (literal authoring URL).
 *   3. null — caller can decide what to do with no URL.
 */
function _resolveAntecedentStartUrl(fragment) {
  if (!fragment) return null;
  // Pull a literal http(s) URL out of a url_matches condition list,
  // skipping regex-style patterns we can't navigate to.
  const findLiteralUrlMatch = (conds) => {
    if (!Array.isArray(conds)) return null;
    for (const c of conds) {
      if (c?.type !== 'url_matches') continue;
      const pat = String(c.pattern ?? '').trim();
      if (!pat) continue;
      if (pat.length >= 2 && pat.startsWith('/') && pat.endsWith('/')) continue;
      if (/^https?:\/\//i.test(pat)) return pat;
    }
    return null;
  };
  // Preference order:
  //   1. preconditions.url_matches — the captured start state. Most
  //      accurate when the fragment was authored with proper precondition
  //      capture (the common case: _capturePreconditions runs at mount
  //      against the live page URL).
  //   2. postconditions.url_matches — captured end state. v2.74.185:
  //      promoted above startUrl in the fallback chain because for
  //      fragments that DON'T navigate the top frame (e.g. interact
  //      only in same-origin iframes), post-state URL equals the
  //      operating URL — and that's where we need to navigate to
  //      replay the fragment. Putting startUrl second hit the stale-
  //      ground-default trap: startUrl captures the ground's default
  //      (e.g. https://app.hubspot.com/) which is where the tab opened
  //      AT START OF AUTHORING, not where the user navigated TO for
  //      the actual work. For navigating fragments, preconditions is
  //      almost always populated (auto-capture from page URL at mount),
  //      so they hit step 1 and this never matters.
  //   3. startUrl — last-ditch literal. Only used when neither
  //      preconditions nor postconditions has a usable url_matches.
  const pre = findLiteralUrlMatch(fragment.preconditions);
  if (pre) return pre;
  const post = findLiteralUrlMatch(fragment.postconditions);
  if (post) return post;
  if (fragment.startUrl && /^https?:\/\//i.test(fragment.startUrl)) {
    return fragment.startUrl;
  }
  return null;
}

/**
 * v2.74.23 — Resolve when a tab finishes loading after a navigation.
 * Used by RUN_ANTECEDENT_FOR_AUTHORING to ensure the page is in its
 * loaded state before the antecedent's actions execute.
 */
function _waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch {}
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const listener = (changedTabId, info) => {
      if (changedTabId === tabId && info.status === 'complete') finish(null);
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Also check current state; tab may already be 'complete' if the
    // navigation finished before we attached the listener.
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        finish(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab?.status === 'complete') finish(null);
    });
    const timer = setTimeout(() => finish(new Error(`tab ${tabId} did not reach 'complete' within ${timeoutMs}ms`)), timeoutMs);
  });
}

Logger.info('background', 'Agent HUB service worker starting');

chrome.action.onClicked.addListener((tab) => {
  Logger.debug('background', `Action clicked on tab ${tab.id}`);
  chrome.sidePanel.open({ tabId: tab.id });
});

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ CapabilityAPI event bridge                                               ║
// ║ Subscribe to all CapabilityAPI events and broadcast them to the side     ║
// ║ panel via chrome.runtime.sendMessage so the chat UI can receive them.    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
CapabilityAPI.subscribe((event) => {
  chrome.runtime.sendMessage({
    type   : 'CAPABILITY_EVENT',
    payload: event,
  }).catch(() => { /* side panel may not be open */ });
});

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ v2.44.0 — MV3 service-worker keep-alive while invocations are running.   ║
// ║                                                                          ║
// ║ Background service workers in MV3 unload after ~30s of inactivity. The   ║
// ║ in-memory CapabilityAPI invocation registry dies with them. If a cold    ║
// ║ side panel boots after the worker has cycled, GET_ACTIVE_DEBUG_INVOCATION║
// ║ asks a fresh worker that has no registry — returns null — and the        ║
// ║ debugger sits at idle even though a strategy is running.                 ║
// ║                                                                          ║
// ║ Fix: track the set of in-flight invocations and ping a cheap async       ║
// ║ Chrome API every 20s while the set is non-empty. The ping resets the     ║
// ║ worker's idle timer. When the last invocation finishes, the interval     ║
// ║ clears and the worker is free to unload normally.                        ║
// ║                                                                          ║
// ║ Set (not counter) so duplicate events are idempotent.                    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const __activeInvocations = new Set();
let __keepAliveInterval = null;

// v2.74.84 — Per-invocation cancellation set for Strategy runs dispatched
// through INVOKE_WORKFLOW. Studio populates this via CANCEL_WORKFLOW; the
// executor's isAborted closure polls membership between steps and in WAIT
// slices. Cleared on completion (success / failure / abort alike).
const _workflowCancellations = new Set();

// v2.74.91 — Per-invocation debug control map. Tracks both:
//   - paused: boolean, polled by the executor's isPaused closure between
//             steps and during PAUSE-step yields. Studio toggles via
//             PAUSE_WORKFLOW / RESUME_WORKFLOW; the executor flips it
//             true on its own when a PAUSE step executes.
//   - listenerInvocations: kept for symmetry with future fields (e.g.
//             breakpoints) — currently unused.
//
// Cancellation isn't moved into this map (yet) because the historical
// _workflowCancellations Set is referenced elsewhere; this map is purely
// additive for the debugger pass.
const _workflowDebugStates = new Map();

function _getWorkflowDebugState(invId) {
  let s = _workflowDebugStates.get(invId);
  if (!s) {
    // v2.74.94 — stepRequested flag. STEP_WORKFLOW sets it; the executor
    // consumes it after the next step completes and re-pauses. RESUME
    // clears it so a Resume-after-Step semantically means "continue freely
    // from here" rather than "step once".
    // v2.74.95 — breakpoints: Set<number> of top-level step indices to
    // halt before. SET/CLEAR_BREAKPOINT_WORKFLOW mutate. Executor checks
    // isBreakpoint(stepIndex) before each top-level step runs.
    // v2.74.101 — stepOverPrefix: when set, consumeStepRequest only fires
    // in an executeSteps loop whose pathPrefix matches. Enables Step Over
    // semantics — Step Into has no prefix constraint and consumes at the
    // first step boundary at any depth (which for control-flow steps
    // descends into the body).
    s = { paused: false, stepRequested: false, stepOverPrefix: null, breakpoints: new Set() };
    _workflowDebugStates.set(invId, s);
  }
  return s;
}

function _broadcastWorkflowPauseState(invId, paused) {
  try {
    chrome.runtime.sendMessage({
      type: 'WORKFLOW_PAUSE_STATE',
      payload: { invocationId: invId, paused: !!paused },
    }, () => { void chrome.runtime.lastError; /* ignore "no receiver" */ });
  } catch (_) { /* ignore */ }
}

function _broadcastWorkflowBreakpoints(invId, set, workflowId) {
  try {
    chrome.runtime.sendMessage({
      type: 'WORKFLOW_BREAKPOINTS',
      // v2.74.99 — Carry BOTH ids so the sidepanel can filter on either.
      // Pre-invocation toggles broadcast with invocationId=null, only
      // workflowId set. Post-invocation toggles set both.
      payload: { invocationId: invId ?? null, workflowId: workflowId ?? null, breakpoints: [...set] },
    }, () => { void chrome.runtime.lastError; /* ignore */ });
  } catch (_) { /* ignore */ }
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ v2.72.41 (Pass 17g) — Pending locale capture session.                    ║
// ║                                                                          ║
// ║ When studio's Locale form clicks "Open in debugger to capture", studio   ║
// ║ hands off the locale draft (name + description + urlPattern + landmark   ║
// ║ roles) to background, which opens the URL tab + debugger sidepanel,     ║
// ║ stores the draft here, and the debugger queries it on boot to enter     ║
// ║ locale-capture mode.                                                     ║
// ║                                                                          ║
// ║ At most one session at a time (single sidepanel can't host two flows).  ║
// ║ Cleared on COMMIT (after debugger saves) or CANCEL (user dismisses).    ║
// ║ Survives service-worker restarts only as long as background stays warm; ║
// ║ a long pause that puts background to sleep loses the session, which is  ║
// ║ acceptable for v1 (user starts over from studio).                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
let __pendingLocaleCapture = null;  // { draft, tabId, sessionId, startedAt }

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ v2.72.50 (Stage 1) — Sidepanel mode registry.                            ║
// ║                                                                          ║
// ║ Single source of truth for "what mode is the sidepanel showing right     ║
// ║ now." Modes are mutually exclusive. Setting a new mode unmounts the      ║
// ║ previous one (the sidepanel shell handles the unmount; background just   ║
// ║ tracks the state and broadcasts changes).                                ║
// ║                                                                          ║
// ║ Messages:                                                                ║
// ║   GET_SIDEPANEL_MODE        — shell asks on cold boot                    ║
// ║   REQUEST_SIDEPANEL_MODE    — caller asks to switch                      ║
// ║   SIDEPANEL_MODE_CHANGED    — broadcast after change (for the shell)     ║
// ║                                                                          ║
// ║ Mode and runtime are separate concerns: an active strategy invocation    ║
// ║ runs in background regardless of whether the sidepanel is in            ║
// ║ strategy-debug mode. The mode is just the visual surface.                ║
// ╚══════════════════════════════════════════════════════════════════════════╝
let __sidepanelMode = null;          // null | 'chat' | 'strategy-debug' | 'locale-capture' | ...
let __sidepanelModePayload = null;   // mode-specific payload (e.g. {groundId} for locale-capture)

function __setSidepanelMode(mode, payload = null) {
  __sidepanelMode = mode;
  __sidepanelModePayload = payload;
  Logger.info('background', `Sidepanel mode set: ${mode ?? '(idle)'}`);

  // Broadcast — the shell listens and updates the UI.
  chrome.runtime.sendMessage({
    type: 'SIDEPANEL_MODE_CHANGED',
    payload: { mode, payload },
  }).catch(() => { /* no listeners is fine */ });
}

// v2.74.128 — Dead-code removal.
//
// Per-tab sidepanel mode tracking previously lived here in background as
// `__tabSidepanelModes`. The v2.74.55 shell.js refactor moved the
// authoritative map into the sidepanel page itself (`_tabModes` in
// shell.js), since the SW dies on idle and would lose its records,
// while the sidepanel page outlives the SW. The background map kept
// being written to (by __setSidepanelMode and by the
// BEGIN_FRAGMENT_AUTHOR / BEGIN_OBSERVATION_AUTHOR setup-result paths)
// but never read by anyone — GET_TAB_SIDEPANEL_MODE had zero external
// callers (verified via codebase grep at v2.74.127).
//
// Removed:
//   - `__tabSidepanelModes` map declaration + onRemoved cleanup
//   - The if/else in __setSidepanelMode that wrote to it
//   - The BEGIN_FRAGMENT_AUTHOR / BEGIN_OBSERVATION_AUTHOR setup-result
//     writes that tried to update the resolved tabId post-hoc
//   - The GET_TAB_SIDEPANEL_MODE handler (no callers)
//   - The CLEAR_TAB_SIDEPANEL_MODE handler in background (the shell's
//     handler in Sidepanel/shell.js does the actual work)
//
// The shell's `_tabModes` + its `chrome.tabs.onRemoved` cleanup
// (added in v2.74.127) is now the single source of truth.

function __startKeepAlive() {
  if (__keepAliveInterval) return;
  // 20s — comfortably under Chrome's 30s idle threshold.
  __keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => { /* return value unused — call alone resets idle */ });
  }, 20_000);
  Logger.debug('background', 'keep-alive started');
}

// v2.72.41 (Pass 17g) — Locale-capture tab-finder. Mirrors PageProbe's
// findOrOpenTab but lives in background so we don't have to import a
// service module from the message dispatcher. Same pattern semantics:
// substring/regex match against existing tabs first, then open https://
// for domain-shaped patterns.
async function __findOrOpenTabForLocale(urlPattern) {
  if (!urlPattern || typeof urlPattern !== 'string') {
    return { ok: false, error: 'urlPattern required' };
  }
  const matcher = __compilePattern(urlPattern);
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return { ok: false, error: `chrome.tabs.query failed: ${e.message}` };
  }
  const existing = tabs.find(t => t?.url && matcher(t.url));
  if (existing) {
    try { await chrome.tabs.update(existing.id, { active: true }); } catch { /* best-effort */ }
    if (Number.isFinite(existing.windowId)) {
      try { await chrome.windows.update(existing.windowId, { focused: true }); } catch { /* best-effort */ }
    }
    return { ok: true, tabId: existing.id, url: existing.url };
  }
  // Open new tab. Auto-prefix domain-shaped patterns to https://.
  let candidateUrl = /^https?:\/\//i.test(urlPattern) ? urlPattern : null;
  if (!candidateUrl && __looksLikeDomain(urlPattern)) {
    candidateUrl = `https://${urlPattern}`;
  }
  if (!candidateUrl) {
    return {
      ok: false,
      error: `No tab matches "${urlPattern}", and the pattern isn't openable as a URL. Open a matching tab first, or use a full URL like "https://example.com".`,
    };
  }
  let newTab;
  try {
    newTab = await chrome.tabs.create({ url: candidateUrl, active: true });
  } catch (e) {
    return { ok: false, error: `chrome.tabs.create failed: ${e.message}` };
  }
  return { ok: true, tabId: newTab.id, url: candidateUrl };
}
function __compilePattern(pattern) {
  const looksLikeRegex = pattern.length > 2
    && pattern.startsWith('/') && pattern.endsWith('/')
    && !/\s/.test(pattern.slice(1, -1));
  if (looksLikeRegex) {
    try {
      const re = new RegExp(pattern.slice(1, -1));
      return (url) => re.test(url);
    } catch { /* fall through to substring */ }
  }
  return (url) => url.includes(pattern);
}
function __looksLikeDomain(s) {
  if (typeof s !== 'string' || !s) return false;
  if (s.startsWith('/')) return false;
  if (/\s/.test(s)) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/.*)?$/i.test(s);
}

/**
 * v2.72.44 — Wait for a tab to reach status='complete'. Resolves on
 * complete, on error, or on timeout (resolves regardless — caller treats
 * timeout as "best effort" and proceeds). Used after chrome.tabs.create
 * to gate content-script re-injection until the page is past document_start.
 */
async function __waitForTabComplete(tabId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const timer = setTimeout(finish, timeoutMs);

    // If the tab is already complete, resolve immediately.
    chrome.tabs.get(tabId).then(t => {
      if (t?.status === 'complete') { clearTimeout(timer); finish(); }
    }).catch(() => { clearTimeout(timer); finish(); });

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId) return;
      if (info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/**
 * v2.72.72 — Execute a CLICK action with navigation/new-tab observation.
 *
 * A CLICK can produce three outcomes:
 *   1. Pure DOM click — content script returns success normally.
 *   2. Same-tab navigation — page unloads mid-execute. The content
 *      script's response may not arrive (the message channel dies with
 *      the page) and we'd otherwise score the action as failed even
 *      though the click clearly worked.
 *   3. New-tab open — click opens a new tab via target=_blank or
 *      window.open. The content script returns success but the user
 *      may want the action verified based on tab observation, not just
 *      the DOM click landing.
 *
 * To handle (2) and (3) correctly, we register chrome.webNavigation +
 * chrome.tabs.onCreated listeners scoped to this tabId BEFORE
 * dispatching the EXECUTE_STEP. We then race the EXECUTE_STEP response
 * against either listener firing within an observation window. If either
 * fires, we treat the click as successful — the click DID something
 * observable, even if the content-script response was lost.
 *
 * Listeners are always cleaned up (success path or error path).
 *
 * @param {number} tabId
 * @param {Object} step  - {action: 'CLICK', selector, value, ...}
 * @returns {Promise<{success: boolean, error?: string, info?: string}>}
 */
async function __executeClickWithNavObservation(tabId, step, frameId = 0) {
  const OBSERVATION_WINDOW_MS = 3000;
  let navObserved = null;       // 'same-tab' | 'new-tab' | null
  let newTabId = null;
  let newTabUrl = null;

  // Same-tab navigation listener. transitionType='link' or 'manual_subframe'
  // is the typical click-induced transition. We accept any committed
  // navigation on this tabId during the observation window.
  //
  // v2.74.163 — Frame-aware. When the click is dispatched into an
  // iframe (frameId !== 0), navigation events fire on EITHER the
  // iframe (same-tab subframe nav) OR the top frame (the iframe's
  // click opened a top-level link via target=_top etc.). Accept both —
  // the click "succeeded" in either case.
  const onCommitted = (details) => {
    if (details.tabId !== tabId) return;
    if (details.frameId !== 0 && details.frameId !== frameId) return;
    if (navObserved) return;             // first wins
    navObserved = 'same-tab';
    newTabUrl = details.url;
  };
  chrome.webNavigation.onCommitted.addListener(onCommitted);

  // New-tab listener. We filter to tabs whose openerTabId matches our tab,
  // which covers target=_blank link clicks and window.open() spawns.
  const onTabCreated = (tab) => {
    if (tab.openerTabId !== tabId) return;
    if (navObserved) return;
    navObserved = 'new-tab';
    newTabId = tab.id;
    newTabUrl = tab.pendingUrl ?? tab.url ?? null;
  };
  chrome.tabs.onCreated.addListener(onTabCreated);

  const cleanup = () => {
    try { chrome.webNavigation.onCommitted.removeListener(onCommitted); } catch {}
    try { chrome.tabs.onCreated.removeListener(onTabCreated); } catch {}
  };

  // Dispatch the actual click. Content script returns success/failure
  // synchronously after the click event fires. If the page unloads
  // mid-click, this rejects with "channel disconnected" or similar.
  // v2.72.91 — Use step.action (CLICK or CLICK_BY_LABEL) so the content
  // script dispatches to the right handler. CLICK_BY_LABEL's value
  // carries the option label; same nav-observation rescue applies if
  // the option click navigates.
  let stepResult = null;
  let stepError = null;
  try {
    stepResult = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, {
        type: 'EXECUTE_STEP',
        payload: {
          action: step.action,
          selector: step.selector,
          value: step.value,
          smoothScroll: false,
        },
      }, { frameId }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  } catch (e) {
    stepError = e.message;
  }

  // Wait the remainder of the observation window for navigation to settle.
  // (Some clicks dispatch the event but the framework doesn't commit
  // navigation until microtasks finish.) If a nav was already observed,
  // shorten the wait — we have what we need.
  const waitMs = navObserved ? 200 : OBSERVATION_WINDOW_MS;
  await new Promise(r => setTimeout(r, waitMs));
  cleanup();

  // Decide success.
  if (stepResult?.success) {
    // Content script confirmed click. Append nav info if observed.
    const info = navObserved
      ? (navObserved === 'new-tab'
          ? `clicked, opened new tab${newTabUrl ? ` → ${newTabUrl}` : ''}`
          : `clicked, navigated${newTabUrl ? ` → ${newTabUrl}` : ''}`)
      : (stepResult.info ?? null);
    return { success: true, info };
  }
  if (navObserved) {
    // Content script response was lost (page unloaded), but a navigation
    // happened — the click did something observable. Treat as success.
    Logger.info('background',
      `CLICK content-script response missing but ${navObserved} observed${newTabUrl ? ` → ${newTabUrl}` : ''} — treating as success`);
    const info = navObserved === 'new-tab'
      ? `clicked, opened new tab${newTabUrl ? ` → ${newTabUrl}` : ''}`
      : `clicked, navigated${newTabUrl ? ` → ${newTabUrl}` : ''}`;
    return { success: true, info };
  }
  // Neither response success nor navigation observed — the click failed.
  const errMsg = stepResult?.error
    ?? stepError
    ?? 'CLICK returned no response and no navigation observed';
  return { success: false, error: errMsg };
}

function __stopKeepAlive() {
  if (!__keepAliveInterval) return;
  clearInterval(__keepAliveInterval);
  __keepAliveInterval = null;
  Logger.debug('background', 'keep-alive stopped');
}

CapabilityAPI.subscribe((event) => {
  const id = event?.invocationId;
  if (!id) return;
  // Lifecycle events that mean "an invocation is in flight" → add to set
  if (event.type === CAP_EVENT.INVOCATION_STARTED ||
      event.type === CAP_EVENT.INVOCATION_QUEUED) {
    __activeInvocations.add(id);
    if (__activeInvocations.size === 1) __startKeepAlive();
    return;
  }
  // Lifecycle events that mean "this invocation is done" → remove from set
  if (event.type === CAP_EVENT.INVOCATION_COMPLETED ||
      event.type === CAP_EVENT.INVOCATION_FAILED ||
      event.type === CAP_EVENT.INVOCATION_CANCELLED) {
    __activeInvocations.delete(id);
    if (__activeInvocations.size === 0) __stopKeepAlive();
    return;
  }
});

// v2.71.4 — Toolbar badge + conversation persistence subscriber.
// v2.71.6 — Animated icon pulse replaces static badge for "live" indication.
//
// Two responsibilities, both kicked off by CapabilityAPI lifecycle events:
//
// 1. Toolbar pulse: when invocations are running, render a pulsing red ring
//    around the base icon glyph via OffscreenCanvas + chrome.action.setIcon.
//    Frame rate 10fps, 1000ms sine-wave cycle. Reads as alive without
//    Chrome's flicker concerns at higher frame rates. Badge text still
//    shows count when >1 invocation is running.
//
// 2. ConversationStore updates: when a terminal event fires for an
//    invocation that has a conversationId (set by chat at invoke time),
//    write a result message to ConversationStore. This lets a chat panel
//    that was closed during execution see the completion when reopened.
//    Plain-text body — chat foreground does rich rendering when live, but
//    a plain-text fallback is enough to mark the message as done and
//    preserve the conversation history.

// ── v2.71.6 — Pulse animation state ────────────────────────────────────────
let __pulseInterval = null;
let __pulseStartedAt = 0;
const PULSE_CYCLE_MS = 2000;          // one full sine cycle — slow, calm heartbeat
const PULSE_FRAME_INTERVAL_MS = 200;  // 5fps — half the cycle rate, lower IPC load
const ICON_SIZE = 32;                 // render at 32px and let Chrome scale
                                      // (16px directly looks chunky; 32px scaled
                                      //  down anti-aliases nicely on most displays)
// Pulse color — matches the SCROLL strategy node accent (purple #a78bfa) for
// consistent visual language across the surface.
const PULSE_R = 167, PULSE_G = 139, PULSE_B = 250;

/**
 * Render one frame of the pulse animation as ImageData.
 * @param {number} t - milliseconds elapsed since pulse start
 * @returns {ImageData}
 */
function __renderPulseFrame(t) {
  const canvas = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
  const ctx = canvas.getContext('2d');
  const cx = ICON_SIZE / 2;
  const cy = ICON_SIZE / 2;

  // Sine wave 0 → 1 → 0 with 1000ms period. Opacity of the pulse ring
  // oscillates between 0.25 (faint) and 1.0 (full).
  const phase = (t % PULSE_CYCLE_MS) / PULSE_CYCLE_MS;   // 0..1
  const wave = (Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2;  // 0..1
  const ringOpacity = 0.25 + 0.75 * wave;
  const ringRadius = 12 + wave * 2;   // subtle radius pulse too: 12..14

  // Background — transparent
  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);

  // Outer pulse ring — purple accent, glowing
  ctx.strokeStyle = `rgba(${PULSE_R}, ${PULSE_G}, ${PULSE_B}, ${ringOpacity})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
  ctx.stroke();

  // Inner solid ring (constant) for definition
  ctx.strokeStyle = `rgba(${PULSE_R}, ${PULSE_G}, ${PULSE_B}, 0.9)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.stroke();

  // Center glyph — diamond (◈) suggesting "active node"
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx + 5, cy);
  ctx.lineTo(cx, cy + 5);
  ctx.lineTo(cx - 5, cy);
  ctx.closePath();
  ctx.fill();

  // Hollow center dot for the "diamond eye" detail
  ctx.fillStyle = `rgba(${PULSE_R}, ${PULSE_G}, ${PULSE_B}, 0.9)`;
  ctx.beginPath();
  ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
  ctx.fill();

  return ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
}

function __startPulse() {
  if (__pulseInterval) return;
  __pulseStartedAt = Date.now();
  // Render first frame immediately so the pulse appears instantly.
  __tickPulse();
  __pulseInterval = setInterval(__tickPulse, PULSE_FRAME_INTERVAL_MS);
  Logger.debug('background', 'icon pulse started');
}

function __tickPulse() {
  try {
    const t = Date.now() - __pulseStartedAt;
    const imageData = __renderPulseFrame(t);
    chrome.action.setIcon({ imageData });
  } catch (err) {
    Logger.warn('background', `pulse frame render failed: ${err.message}`);
    __stopPulse();
  }
}

function __stopPulse() {
  if (__pulseInterval) {
    clearInterval(__pulseInterval);
    __pulseInterval = null;
  }
  // Restore the static manifest icon. Chrome accepts a path-dictionary
  // here. Falls back to manifest icons if this call fails for any reason.
  try {
    chrome.action.setIcon({
      path: {
        '16': 'assets/icon16.png',
        '48': 'assets/icon48.png',
        '128': 'assets/icon128.png',
      },
    });
  } catch (err) {
    Logger.warn('background', `restore static icon failed: ${err.message}`);
  }
  Logger.debug('background', 'icon pulse stopped');
}

function __updateToolbarBadge() {
  const count = __activeInvocations.size;
  try {
    if (count === 0) {
      chrome.action.setBadgeText({ text: '' });
      __stopPulse();
    } else {
      // Show count badge only when >1 invocation. Single invocation gets
      // just the pulsing icon — cleaner read.
      chrome.action.setBadgeText({ text: count === 1 ? '' : String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#a78bfa' });    // purple, matches pulse
      if (chrome.action.setBadgeTextColor) {
        chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch?.(() => {});
      }
      __startPulse();
    }
  } catch (err) {
    // Badge/icon updates are best-effort; never let them break invocation flow.
    Logger.warn('background', `setBadgeText/Icon failed: ${err.message}`);
  }
}

async function __persistTerminalEventToConversation(event) {
  const invocationId = event?.invocationId;
  if (!invocationId) return;

  // Look up the invocation to get conversationId. Snapshot may have been
  // cleaned up if this fires very late; tolerate that.
  const snap = CapabilityAPI.getInvocation(invocationId);
  const conversationId = snap?.conversationId ?? null;
  if (!conversationId) return;   // not a chat invocation; nothing to persist

  // Race-avoidance: if chat is open, its handleInvocationCompleted (and
  // siblings) already persisted a rich-HTML message synchronously. Don't
  // clobber that with our plain-text fallback. Detect by reading the
  // current conversation: if a message with this invocationId exists AND
  // its role isn't 'thinking' (i.e. a chat handler already finalized it),
  // skip our write.
  let conv;
  try {
    conv = await ConversationStore.load(conversationId);
  } catch (err) {
    Logger.warn('background', `ConversationStore.load failed for ${conversationId}: ${err.message}`);
    return;
  }
  if (!conv) return;

  const messageId = `msg-${invocationId}`;
  const existing = (conv.messages ?? []).find(m => m.id === messageId);
  // v2.71.10 (Bug J cleanup) — If a message exists in the persisted store
  // with this invocationId, chat foreground already finalized it with rich
  // rendering. Don't clobber. ConversationStore never persists 'thinking'
  // role messages (chat skips them per persistence rules in appendMessage),
  // so any message we find here is a finalized assistant/system message.
  if (existing) {
    return;
  }

  // v2.71.10 (Bug L cleanup) — Clean up declaration. role is constant;
  // body and outcome are assigned in every branch.
  const role = 'assistant';
  let body, outcome;
  if (event.type === CAP_EVENT.INVOCATION_COMPLETED) {
    const stepResults = Array.isArray(event.result?.stepResults) ? event.result.stepResults : [];
    const ran = stepResults.filter(r => r.success && !r.skipped).length;
    const skipped = stepResults.filter(r => r.skipped).length;
    const failed = stepResults.filter(r => !r.success).length;
    if (stepResults.length === 0) {
      body = `${snap.capabilityName ?? 'Task'} completed.`;
      outcome = { kind: 'success', label: 'Completed', detail: '' };
    } else if (failed === 0) {
      const skipNote = skipped > 0 ? ` (${skipped} skipped)` : '';
      body = `${snap.capabilityName ?? 'Task'} completed — ${ran + skipped}/${stepResults.length} step${stepResults.length === 1 ? '' : 's'}${skipNote}.`;
      outcome = { kind: 'success', label: 'Completed', detail: '' };
    } else {
      body = `${snap.capabilityName ?? 'Task'} — ${ran + skipped}/${stepResults.length} step${stepResults.length === 1 ? '' : 's'} succeeded.`;
      outcome = { kind: 'partial', label: 'Partial', detail: `${failed} failed` };
    }
  } else if (event.type === CAP_EVENT.INVOCATION_FAILED) {
    body = `${snap.capabilityName ?? 'Task'} failed.`;
    outcome = { kind: 'error', label: 'Failed', detail: event.error ?? 'unknown error' };
  } else if (event.type === CAP_EVENT.INVOCATION_CANCELLED) {
    body = `${snap.capabilityName ?? 'Task'} was cancelled.`;
    outcome = { kind: 'cancelled', label: 'Cancelled', detail: '' };
  } else {
    return;
  }

  try {
    await ConversationStore.updateMessage(conversationId, messageId, {
      id: messageId,
      role,
      body,
      ts: Date.now(),
      invocationId,
      attribution: snap.capabilityName ?? '',
      outcome,
    });
  } catch (err) {
    // Conversation may not exist (deleted before completion); not fatal.
    Logger.warn('background', `ConversationStore update failed for ${invocationId}: ${err.message}`);
  }
}

CapabilityAPI.subscribe((event) => {
  // Update badge on every lifecycle event (the activeInvocations set was
  // updated by the earlier subscriber).
  if (event.type === CAP_EVENT.INVOCATION_STARTED ||
      event.type === CAP_EVENT.INVOCATION_QUEUED ||
      event.type === CAP_EVENT.INVOCATION_COMPLETED ||
      event.type === CAP_EVENT.INVOCATION_FAILED ||
      event.type === CAP_EVENT.INVOCATION_CANCELLED) {
    __updateToolbarBadge();
  }

  // v2.71.10 (Bug K+M fix) — Persist terminal events synchronously rather
  // than via setTimeout. Pre-v2.71.10 a 500ms delay was added under the
  // theory that chat foreground's rich-HTML write should win the race when
  // the panel is open. But the existing-message check inside
  // __persistTerminalEventToConversation is the authoritative race guard;
  // the delay was paranoia. Worse, the delay created a ghost-failure
  // scenario: if the user reopened the panel within 500ms of a terminal
  // event, the resume logic's listInvocations({status:'running'}) returned
  // empty (the invocation was already terminal in CapabilityAPI), and our
  // delayed setTimeout hadn't fired yet, so no bubble was synthesized AND
  // no terminal message was persisted in time for rehydration. The user
  // saw nothing — the strategy result was effectively lost until reload.
  // Fire-and-forget the async write directly.
  if (event.type === CAP_EVENT.INVOCATION_COMPLETED ||
      event.type === CAP_EVENT.INVOCATION_FAILED ||
      event.type === CAP_EVENT.INVOCATION_CANCELLED) {
    __persistTerminalEventToConversation(event).catch(err => {
      Logger.warn('background', `terminal-event persistence failed: ${err.message}`);
    });
  }
});

// v2.74.231 — Locale auto-discovery cache helpers. Used by the
// AUTO_DISCOVER_LOCALE handler to memoize Claude's suggestions per
// (groundId, normalized page URL) so the "+ Locale" button doesn't
// re-call Claude on every click. Rediscover button in locale-capture
// passes force:true to bypass and rewrite cache.
//
// Storage shape:
//   key: 'localeAutoDiscoveryCache'
//   value: { [groundId]: { [normalizedUrl]: { suggestion, url, capturedAt } } }
const LOCALE_DISCOVERY_CACHE_KEY = 'localeAutoDiscoveryCache';

function _normalizeUrlForLocaleCache(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    // origin + pathname — strip query + fragment. Same kind of page
    // (different query params for filters, sort, etc.) collides into
    // the same cache entry intentionally.
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

async function _readLocaleDiscoveryCache(groundId, cacheKey) {
  if (!groundId || !cacheKey) return null;
  try {
    const got = await chrome.storage.local.get(LOCALE_DISCOVERY_CACHE_KEY);
    const map = got?.[LOCALE_DISCOVERY_CACHE_KEY] ?? {};
    return map[groundId]?.[cacheKey] ?? null;
  } catch (e) {
    Logger.warn('background', `localeAutoDiscoveryCache read failed: ${e.message}`);
    return null;
  }
}

async function _writeLocaleDiscoveryCache(groundId, cacheKey, entry) {
  if (!groundId || !cacheKey) return;
  const got = await chrome.storage.local.get(LOCALE_DISCOVERY_CACHE_KEY);
  const map = got?.[LOCALE_DISCOVERY_CACHE_KEY] ?? {};
  if (!map[groundId]) map[groundId] = {};
  map[groundId][cacheKey] = entry;
  await chrome.storage.local.set({ [LOCALE_DISCOVERY_CACHE_KEY]: map });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;
  Logger.debug('background', `Message: ${type}`);

  switch (type) {

    // ── CapabilityAPI surface ────────────────────────────────────────────────
    case 'CAPABILITY_LIST': {
      (async () => {
        try {
          const list = await CapabilityAPI.listCapabilities(payload ?? {});
          sendResponse({ success: true, capabilities: list });
        } catch (err) {
          Logger.error('background', `CAPABILITY_LIST failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'CAPABILITY_GET': {
      (async () => {
        try {
          // v2.74.114 — Validate up front so a missing payload yields an
          // actionable error message rather than the opaque "Cannot read
          // properties of null (reading 'capabilityId')" that the bare
          // `payload.capabilityId` access used to produce.
          const { capabilityId } = payload ?? {};
          if (!capabilityId) {
            sendResponse({ success: false, error: 'capabilityId required' });
            return;
          }
          const cap = await CapabilityAPI.getCapability(capabilityId);
          sendResponse({ success: true, capability: cap });
        } catch (err) {
          Logger.error('background', `CAPABILITY_GET failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'CAPABILITY_MATCH': {
      (async () => {
        try {
          // v2.74.114 — Validate query up front.
          const { query, options } = payload ?? {};
          if (typeof query !== 'string' || !query.trim()) {
            sendResponse({ success: false, error: 'query required' });
            return;
          }
          const matches = await CapabilityAPI.match(query, options ?? {});
          sendResponse({ success: true, matches });
        } catch (err) {
          Logger.error('background', `CAPABILITY_MATCH failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── Generate a short conversation title from the first user message.
    // Thin wrapper around AnthropicService kept behind the ChatAPI contract
    // so the chat UI never reaches into Lab internals directly.
    case 'CHAT_GENERATE_TITLE': {
      (async () => {
        try {
          const { firstMessage } = payload ?? {};
          if (!firstMessage) {
            sendResponse({ success: false, error: 'firstMessage required' });
            return;
          }
          const title = await AnthropicService.generateConversationTitle(firstMessage);
          // Fall back to a truncated version of the message if title gen failed
          const finalTitle = title
            ?? firstMessage.slice(0, 40).replace(/\s+/g, ' ').trim();
          sendResponse({ success: true, title: finalTitle });
        } catch (err) {
          Logger.error('background', `CHAT_GENERATE_TITLE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ╔══════════════════════════════════════════════════════════════════════╗
    // ║ Pass B — FRAGMENT AUTHORING                                          ║
    // ╚══════════════════════════════════════════════════════════════════════╝

    // v2.74.22 — START_FRAGMENT_WALK handler removed. AI-walked path is gone.

    // v2.72.60 — T1 (cache) Fragment authoring.
    //
    // Mirror of START_FRAGMENT_WALK for the manual-authoring path. No
    // LLM, no turn-by-turn approval. Background opens the walk tab,
    // re-injects the content script, and sets the sidepanel mode to
    // 'fragment-author' with the metadata. The user authors actions
    // directly in the sidepanel and clicks Verify per row to execute
    // each step on the live page (via EXECUTE_AUTHORING_STEP).
    case 'BEGIN_FRAGMENT_AUTHOR': {
      (async () => {
        try {
          const {
            fragmentId, groundId, groundUrl, name, description,
            pageClass = null, isRewalk = false,
            antecedentFragmentId = null, antecedentParamBindings = null,
            // v2.72.82 — Re-walk pre-fill: parsed rawJson + saved metadata.
            prefilledActions = null,
            rewalkName = null, rewalkDescription = null,
            // v2.74.31 — Reuse the user's current tab when launched from
            // the Ground sidepanel (instead of opening a fresh tab).
            existingTabId = null,
            // v2.74.33 — Where Cancel / Save should return the user.
            // 'ground-view' = back to the Ground sidepanel; otherwise
            // exitToStudio is used (the original behavior).
            returnTo = null,
          } = payload ?? {};
          // v2.72.62 — T1 authors name+description IN the sidepanel mode,
          // so the form sends empty strings. Don't validate them here.
          if (!fragmentId || !groundId || !groundUrl) {
            sendResponse({ success: false, error: 'Missing required fields (fragmentId, groundId, groundUrl)' });
            return;
          }
          Logger.info('background', `BEGIN_FRAGMENT_AUTHOR — fragmentId=${fragmentId}${antecedentFragmentId ? ` antecedent=${antecedentFragmentId}` : ''}${prefilledActions ? ` prefill=${prefilledActions.length}` : ''}`);

          // v2.72.62 — Set the sidepanel mode FIRST with a "preparing"
          // status, so the mode mounts and shows progress while the tab
          // setup runs. The mode displays "Setting up: replaying
          // antecedent…" if antecedent is set; otherwise mounts straight
          // into authoring. The actual tab open + antecedent replay
          // happens via TemplateWalker.prepareTabForAuthoring below.
          __setSidepanelMode('fragment-author', {
            fragmentId, groundId, groundUrl,
            // v2.72.82 — On re-walk, prefer the saved name/description
            // from the existing fragment record.
            name: rewalkName ?? name,
            description: rewalkDescription ?? description,
            pageClass, isRewalk,
            antecedentFragmentId, antecedentParamBindings,
            prefilledActions,
            tabId: null,            // not yet opened
            // v2.74.56 — Forward existingTabId so the shell's
            // _rememberTabMode / _snapshotKey logic can key by the
            // authoring tab. Previously this field was destructured
            // from the incoming payload but never passed through, so
            // shell saw no tabId and the per-tab record was never
            // created — resume-on-return-to-tab was a no-op.
            existingTabId,
            setupPhase: antecedentFragmentId ? 'antecedent' : 'opening',
            returnTo,
          });

          // v2.72.62 — Use TemplateWalker.prepareTabForAuthoring. This
          // opens the tab, waits for the content script + page idle,
          // and replays the antecedent chain (if any) before returning.
          // Antecedent progress broadcasts via WALK_PROGRESS keyed by
          // fragmentId (the mode listens for this and updates its banner).
          let setup;
          try {
            setup = await TemplateWalker.prepareTabForAuthoring({
              groundUrl, fragmentId,
              antecedentFragmentId, antecedentParamBindings,
              isAborted: () => false,
              existingTabId,
            });
          } catch (e) {
            Logger.error('background', `BEGIN_FRAGMENT_AUTHOR setup threw: ${e.message}`);
            // Tell the mode setup failed so it can show an error.
            chrome.runtime.sendMessage({
              type: 'FRAGMENT_AUTHOR_SETUP_RESULT',
              payload: { fragmentId, success: false, error: e.message, tabId: null },
            }).catch(() => {});
            sendResponse({ success: false, error: e.message });
            return;
          }
          if (!setup.success) {
            chrome.runtime.sendMessage({
              type: 'FRAGMENT_AUTHOR_SETUP_RESULT',
              payload: { fragmentId, success: false, error: setup.error, tabId: setup.tabId },
            }).catch(() => {});
            sendResponse({ success: false, error: setup.error });
            return;
          }

          // Setup complete — broadcast the resolved tabId so the mode
          // can use it for Pick / Verify dispatches.
          chrome.runtime.sendMessage({
            type: 'FRAGMENT_AUTHOR_SETUP_RESULT',
            payload: { fragmentId, success: true, tabId: setup.tabId, error: null },
          }).catch(() => {});

          // v2.74.128 — The v2.74.40 post-resolution write to the
          // background-side __tabSidepanelModes map was removed
          // alongside the map itself. The shell maintains its own
          // _tabModes record; the FRAGMENT_AUTHOR_SETUP_RESULT broadcast
          // (above) is the channel the live fragment-author mode reads
          // for the resolved tabId.

          sendResponse({ success: true, tabId: setup.tabId });
        } catch (err) {
          Logger.error('background', `BEGIN_FRAGMENT_AUTHOR failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.22 — List fragments on a Ground. Used by the fragment-author
    // sidepanel mode's antecedent dropdown (and potentially other future
    // surfaces that need a per-ground fragment listing without going
    // through StorageManager directly). Optional excludeId filters out
    // the fragment currently being authored to prevent self-references.
    case 'LIST_FRAGMENTS_FOR_GROUND': {
      (async () => {
        try {
          const { groundId, excludeId } = payload ?? {};
          if (!groundId) {
            sendResponse({ success: false, error: 'groundId required' });
            return;
          }
          const all = await StorageManager.listFragments(groundId);
          const fragments = excludeId
            ? all.filter(f => f.id !== excludeId)
            : all;
          // Project to a compact shape. v2.74.23 — params is included so
          // the antecedent card can render its param-input row + label
          // line without a follow-up GET_FRAGMENT round-trip.
          sendResponse({
            success: true,
            fragments: fragments.map(f => ({
              id    : f.id,
              name  : f.name ?? 'Unnamed',
              params: Array.isArray(f.params) ? [...f.params] : [],
            })),
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.23 — Navigate a tab to a URL and wait for it to load.
    // Used by the antecedent card's "undo" path: after a successful Run,
    // the button flips to a refresh icon; clicking it sends NAVIGATE_TAB
    // with the ground's default URL to reset the page state.
    case 'NAVIGATE_TAB': {
      (async () => {
        try {
          const { tabId, url } = payload ?? {};
          if (!tabId || !url) {
            sendResponse({ success: false, error: 'tabId and url required' });
            return;
          }
          await chrome.tabs.update(tabId, { url });
          await _waitForTabLoad(tabId);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.22 — Run an antecedent fragment on the active authoring tab,
    // driving the page into the post-state of that fragment so the user
    // can begin authoring against the right page. Triggered by the
    // fragment-author mode's antecedent + Run card.
    //
    // v2.74.23 — Always navigates the tab to the antecedent's URL
    // precondition (or its startUrl as fallback) before running, then
    // waits for the page to load. Re-clicking Run on the same antecedent
    // resets the tab to a known-good starting state so the run is
    // deterministic regardless of where the page ended up after the
    // previous run. Param bindings come from the card's input row and
    // are forwarded to executeFragment for {{NAME}} substitution.
    case 'RUN_ANTECEDENT_FOR_AUTHORING': {
      (async () => {
        try {
          const { tabId, antecedentFragmentId, paramBindings } = payload ?? {};
          if (!tabId || !antecedentFragmentId) {
            sendResponse({ success: false, error: 'tabId and antecedentFragmentId required' });
            return;
          }

          // Look up the antecedent record so we know where to navigate.
          // The url_matches precondition is preferred — it's the captured
          // page state. Fall back to startUrl, then to ground.url, then
          // give up (executeFragment will fail loudly if the page state
          // is wrong).
          const ante = await StorageManager.getFragment(antecedentFragmentId);
          if (!ante) {
            sendResponse({ success: false, error: `Antecedent fragment ${antecedentFragmentId} not found` });
            return;
          }
          const navigateUrl = _resolveAntecedentStartUrl(ante);
          if (navigateUrl) {
            try {
              await chrome.tabs.update(tabId, { url: navigateUrl });
              await _waitForTabLoad(tabId);
            } catch (e) {
              sendResponse({ success: false, error: `Navigation to "${navigateUrl}" failed: ${e.message}` });
              return;
            }
          }

          const result = await TemplateWalker.executeFragment({
            tabId,
            fragmentId   : antecedentFragmentId,
            paramBindings: (paramBindings && typeof paramBindings === 'object') ? paramBindings : {},
            broadcastKey : `antecedent-run-${antecedentFragmentId}`,
            isAborted    : () => false,
          });
          if (!result.success) {
            sendResponse({
              success: false,
              error  : result.error ?? 'antecedent run failed',
              actionsRun           : result.actionsRun ?? 0,
              antecedentActionsRun : result.antecedentActionsRun ?? 0,
            });
            return;
          }
          sendResponse({
            success              : true,
            actionsRun           : result.actionsRun,
            antecedentActionsRun : result.antecedentActionsRun ?? 0,
          });
        } catch (err) {
          Logger.error('background', `RUN_ANTECEDENT_FOR_AUTHORING failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.95 (Phase 1) — Begin authoring an Observation in T1 (cache)
    // mode. Mirrors BEGIN_FRAGMENT_AUTHOR: opens the target tab, mounts
    // the observation-author sidepanel mode, broadcasts the resolved
    // tabId. Observations don't have antecedent chains so we skip
    // antecedent replay entirely — the tab opens at groundUrl as-is.
    case 'BEGIN_OBSERVATION_AUTHOR': {
      (async () => {
        try {
          const {
            observationId, groundId, groundUrl, name, description, shape, output, target, extract,
            // v2.74.31 — Reuse the user's current tab when launched from
            // the Ground sidepanel (instead of opening a fresh tab).
            existingTabId = null,
            // v2.74.33 — Where Cancel / Save should return the user.
            returnTo = null,
            // v2.74.149 — Full-record seed for the Edit (✎) flow on the
            // Ground sidepanel. New-Observation and Walk-Observation
            // callers omit these; observation-author treats them as
            // optional and falls back to the legacy single-extract seed
            // when absent.
            prefilledExtracts       = null,
            prefilledPreconditions  = null,
            prefilledPostconditions = null,
            tier                    = null,
          } = payload ?? {};
          if (!observationId || !groundId || !groundUrl) {
            sendResponse({ success: false, error: 'Missing required fields (observationId, groundId, groundUrl)' });
            return;
          }
          Logger.info('background', `BEGIN_OBSERVATION_AUTHOR — observationId=${observationId} ground=${groundId}`);

          // Mount the sidepanel mode FIRST with a placeholder tabId so
          // the user sees the form immediately while the tab opens. The
          // mode will receive OBSERVATION_AUTHOR_SETUP_RESULT once the
          // tab is ready and use it for Pick/Verify dispatches.
          __setSidepanelMode('observation-author', {
            observationId, groundId, groundUrl,
            name: name ?? '',
            description: description ?? '',
            shape: shape ?? 'scalar',
            output: output ?? '',
            target: target ?? '',
            extract: extract ?? { kind: 'text' },
            tabId: null,
            // v2.74.56 — Forward existingTabId (same fix as
            // BEGIN_FRAGMENT_AUTHOR — shell needs this for per-tab
            // mode tracking).
            existingTabId,
            setupPhase: 'opening',
            returnTo,
            // v2.74.149 — Forward full-record seed for in-place edit.
            prefilledExtracts,
            prefilledPreconditions,
            prefilledPostconditions,
            tier,
          });

          // Reuse prepareTabForAuthoring (no antecedent for Observations).
          let setup;
          try {
            setup = await TemplateWalker.prepareTabForAuthoring({
              groundUrl, fragmentId: observationId,    // broadcast key only
              antecedentFragmentId: null, antecedentParamBindings: null,
              isAborted: () => false,
              existingTabId,
            });
          } catch (e) {
            Logger.error('background', `BEGIN_OBSERVATION_AUTHOR setup threw: ${e.message}`);
            chrome.runtime.sendMessage({
              type: 'OBSERVATION_AUTHOR_SETUP_RESULT',
              payload: { observationId, success: false, error: e.message, tabId: null },
            }).catch(() => {});
            sendResponse({ success: false, error: e.message });
            return;
          }
          if (!setup.success) {
            chrome.runtime.sendMessage({
              type: 'OBSERVATION_AUTHOR_SETUP_RESULT',
              payload: { observationId, success: false, error: setup.error, tabId: setup.tabId },
            }).catch(() => {});
            sendResponse({ success: false, error: setup.error });
            return;
          }

          chrome.runtime.sendMessage({
            type: 'OBSERVATION_AUTHOR_SETUP_RESULT',
            payload: { observationId, success: true, tabId: setup.tabId, error: null },
          }).catch(() => {});
          // v2.74.128 — Background-side per-tab map removed; see the
          // parallel cleanup in BEGIN_FRAGMENT_AUTHOR above.
          sendResponse({ success: true, tabId: setup.tabId });
        } catch (err) {
          Logger.error('background', `BEGIN_OBSERVATION_AUTHOR failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.95 (Phase 1) — Preview the value an Observation would
    // extract. Used by observation-author mode's Verify button. Does
    // NOT mutate the page — pure read.
    //
    // Modes:
    //   mode='value' attribute='text'      → element.textContent
    //   mode='value' attribute='html'      → element.outerHTML
    //   mode='value' attribute='<other>'   → element.getAttribute(other)
    //
    // Returns { success, value?, error? }
    case 'EXECUTE_OBSERVATION_PREVIEW': {
      (async () => {
        try {
          const { tabId, selector, mode = 'value', attribute = 'text' } = payload ?? {};
          if (!tabId || !selector) {
            sendResponse({ success: false, error: 'tabId + selector required' });
            return;
          }
          if (mode !== 'value') {
            sendResponse({ success: false, error: `Unsupported preview mode: "${mode}"` });
            return;
          }
          // Forward to content script's EXTRACT_VALUE. v2.72.95 adds
          // 'html' as a recognized attribute string (returns outerHTML).
          const res = await new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tabId, {
              type: 'EXTRACT_VALUE',
              payload: { selector, attribute },
            }, { frameId: 0 }, (response) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(response);
            });
          });
          sendResponse(res ?? { success: false, error: 'EXTRACT_VALUE returned null' });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    // v2.72.95 (Phase 1) — Note: SAVE_OBSERVATION is handled by the
    // pre-existing case below (added in v2.72.0 Pass 3a). It uses
    // broadcastStorageChanged() with the canonical {type, kind, id,
    // action} top-level shape that all STORAGE_CHANGED listeners expect.
    // observation-author mode dispatches the same SAVE_OBSERVATION
    // message; no separate handler needed.

    // v2.74.19 (Ship E) — Image snap capture (free-extract). Used by
    // observation-author mode's Verify button on image_snap cards AND
    // by the runtime ExecutionEngine at execute time.
    //
    // Flow:
    //   1. Scroll the tab to payload.scrollY (if not already)
    //   2. Wait a frame for layout to settle
    //   3. chrome.tabs.captureVisibleTab → full-viewport PNG dataUrl
    //   4. Decode + crop to payload.rect (scaled by DPR if needed)
    //   5. Return { success, dataUrl } where dataUrl is the cropped image
    //
    // The captureVisibleTab API requires the activeTab permission OR
    // <all_urls> in host_permissions. Either is already granted by our
    // manifest.
    // v2.74.62 — Image (read) → Claude vision → list. The Observation
    // image_read shape's verify path:
    //   1. Crop the screenshot at ex.rect (reuses OBSERVE_IMAGE_SNAP_BG
    //      via direct chrome.tabs.captureVisibleTab + canvas crop).
    //   2. Send the cropped image + author's description to Claude's
    //      vision API (AnthropicService.readImage).
    //   3. Return { items[], dataUrl, width, height } so verify can
    //      show the thumbnail AND the Claude-distilled list.
    case 'OBSERVE_IMAGE_READ_BG': {
      // v2.74.145 — Delegates to Services/ImageReadCapture.performImageRead
      // so the same pipeline serves both this sidepanel-verify message
      // path and the runtime ExecutionEngine path (which now imports the
      // helper directly, avoiding the SW-self-messaging port-closed bug).
      (async () => {
        try {
          const result = await performImageRead(payload ?? {});
          sendResponse(result);
        } catch (err) {
          Logger.error('background', `OBSERVE_IMAGE_READ_BG failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.61 — Section → Claude → list. The Observation Section
    // extract shape's verify path: capture the section via the
    // content script, then ask Claude to distill it into a curated
    // list of text values (mode='text') or URLs (mode='url').
    // Returns { success, items, section } so the verify caller can
    // display the items AND keep the raw section data for record.
    case 'OBSERVE_SECTION_LIST_BG': {
      (async () => {
        try {
          const { tabId, target, mode, frameUrl } = payload ?? {};
          if (typeof tabId !== 'number' || !target) {
            sendResponse({ success: false, error: 'tabId + target required' });
            return;
          }
          // v2.74.199 — Resolve iframe routing. Picker captures frameUrl
          // (v2.74.198); verify dispatchers pass it through; this handler
          // resolves to a frameId via TemplateWalker._resolveFrameId
          // (falls back to top frame when frameUrl is empty or the
          // iframe is gone). Without this, every section-list verify on
          // an iframe-picked selector failed with "OBSERVE_SECTION: no
          // element matched ..." because the message hit the top frame's
          // document instead of the iframe's.
          const sectionFrameId = await TemplateWalker._resolveFrameId(tabId, frameUrl);
          // Step 1: capture the section via the content script.
          let sectionRes;
          try {
            sectionRes = await chrome.tabs.sendMessage(tabId, {
              type: 'OBSERVE_SECTION',
              payload: { target },
            }, { frameId: sectionFrameId });
          } catch (e) {
            sendResponse({ success: false, error: `Section capture failed: ${e.message}` });
            return;
          }
          if (!sectionRes?.success) {
            sendResponse({ success: false, error: sectionRes?.error ?? 'OBSERVE_SECTION returned no payload' });
            return;
          }
          const section = sectionRes.section ?? {};
          // Step 2: tab URL for relative-URL resolution.
          let sourceUrl = '';
          try {
            const tab = await chrome.tabs.get(tabId);
            sourceUrl = tab?.url ?? '';
          } catch { /* fine — Claude handles missing URLs */ }
          // Step 3: ask Claude.
          const llmRes = await AnthropicService.extractSectionItems({
            mode      : mode === 'url' ? 'url' : 'text',
            section,
            sourceUrl,
          });
          if (!llmRes) {
            sendResponse({ success: false, error: 'Claude returned no usable list' });
            return;
          }
          sendResponse({
            success: true,
            items  : llmRes.items,
            section,
          });
        } catch (err) {
          Logger.error('background', `OBSERVE_SECTION_LIST_BG failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.220 — Clipboard read via an offscreen document. Content
    // scripts can't reliably call navigator.clipboard.readText() during
    // sidepanel-initiated verify because their document lacks OS focus
    // (the side panel has focus). Offscreen documents created with
    // reasons:['CLIPBOARD'] bypass the focus requirement — they're the
    // canonical MV3 escape hatch.
    //
    // Lifecycle: create the offscreen doc on first request, reuse on
    // subsequent ones, never explicitly close (the SW going idle tears
    // it down). chrome.runtime.getContexts confirms whether one exists.
    // v2.74.227 — Install the clipboard writeText patch in the page's
    // main world. Required because pages like HubSpot's chat iframe
    // have CSP rules that block inline <script> injection from content
    // scripts. Extensions bypass page CSP via chrome.scripting.
    // executeScript({world:'MAIN'}), so we route the patch install
    // through background here.
    //
    // The patch intercepts navigator.clipboard.writeText AND
    // navigator.clipboard.write (the ClipboardItem-based API some apps
    // use for rich-format copies) and dispatches a custom event with
    // the captured text. Content script listens for the event after
    // clicking the copy button — bypasses the focus requirement on
    // the actual system clipboard write, which Chrome rejects when
    // the page document doesn't have OS focus.
    //
    // Idempotent: flag on `window` prevents double-patching across
    // repeated click_copy invocations.
    case 'INJECT_CLIPBOARD_PATCH_BG': {
      (async () => {
        try {
          const tabId = sender?.tab?.id;
          const frameId = sender?.frameId;
          if (typeof tabId !== 'number') {
            sendResponse({ success: false, error: 'INJECT_CLIPBOARD_PATCH_BG: sender.tab.id missing' });
            return;
          }
          await chrome.scripting.executeScript({
            target: {
              tabId,
              frameIds: typeof frameId === 'number' ? [frameId] : undefined,
            },
            world: 'MAIN',
            func: (eventName) => {
              if (window.__ahub_clipboard_patched === true) return;
              window.__ahub_clipboard_patched = true;
              try {
                const origWT = navigator.clipboard.writeText.bind(navigator.clipboard);
                navigator.clipboard.writeText = function(text) {
                  try {
                    window.dispatchEvent(new CustomEvent(eventName, { detail: String(text ?? '') }));
                  } catch (_) { /* dispatch failure: silent */ }
                  // Still call original so normal app behavior is
                  // preserved when focus is present.
                  try { return origWT(text); } catch (_) { return Promise.resolve(); }
                };
                // Also patch the ClipboardItem-based API. Some apps use
                // navigator.clipboard.write([new ClipboardItem({...})])
                // to copy multiple formats (text/plain + text/html).
                if (typeof navigator.clipboard.write === 'function') {
                  const origW = navigator.clipboard.write.bind(navigator.clipboard);
                  navigator.clipboard.write = async function(items) {
                    try {
                      for (const item of items || []) {
                        if (item.types && item.types.includes && item.types.includes('text/plain')) {
                          const blob = await item.getType('text/plain');
                          const t = await blob.text();
                          window.dispatchEvent(new CustomEvent(eventName, { detail: t }));
                          break;
                        }
                      }
                    } catch (_) { /* iteration failure: silent */ }
                    try { return origW(items); } catch (_) { return Promise.resolve(); }
                  };
                }
              } catch (_) { /* patching failed; don't break the page */ }
            },
            args: ['__ahub_clipboard_capture'],
          });
          sendResponse({ success: true });
        } catch (err) {
          Logger.warn?.('background', `INJECT_CLIPBOARD_PATCH_BG failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.229 — Selector refinement via Claude. The picker often
    // produces fragile selectors (positional, hashed classes); the
    // author's manual workflow has been: pick → verify → copy DOM →
    // ask Claude → paste back. This handler closes that loop in one
    // click. Payload includes the inspect report + shape; we call
    // AnthropicService.suggestSelector and return the candidate.
    // v2.74.235 — Wave 2 of the landmark SSOT project. Locale-capture's
    // Pick flow forwards the full DOM context + screenshot + role +
    // rule-derived capabilities/operations to this handler, which calls
    // Claude once and returns the complete landmark profile (refined
    // selector + description + aliases + operationsCommon + pitfalls +
    // expectedContent + confidence). Persisted on the landmark record;
    // downstream consumers in Wave 3 read it without re-running Claude.
    // v2.74.236 — Wave 3 of the landmark SSOT project. Authoring UIs
    // (fragment-author, observation-author) call this to populate
    // landmark-picker dropdowns filtered by the action / shape's
    // required operation. Returns a flat list of landmark entries
    // ready for direct rendering.
    case 'LIST_LANDMARKS_FOR_GROUND': {
      (async () => {
        try {
          const { groundId, filterOp, includeMismatch } = payload ?? {};
          if (typeof groundId !== 'string' || !groundId) {
            sendResponse({ success: false, landmarks: [], error: 'groundId required' });
            return;
          }
          // v2.74.277 — listLandmarksForGround now statically imported.
          const landmarks = await listLandmarksForGround(groundId, { filterOp, includeMismatch });
          sendResponse({ success: true, landmarks });
        } catch (err) {
          Logger.warn('background', `LIST_LANDMARKS_FOR_GROUND failed: ${err.message}`);
          sendResponse({ success: false, landmarks: [], error: err.message });
        }
      })();
      return true;
    }

    // v2.74.240 — Phase 2 substrate registry CRUD. Sidepanel writes
    // each landmark to the registry directly during locale save; reads
    // hydrate refs into full records at edit time. Same handler pattern
    // as locale CRUD for symmetry.
    case 'SAVE_LANDMARK': {
      (async () => {
        try {
          const { landmark } = payload ?? {};
          if (!landmark?.uid) {
            sendResponse({ success: false, error: 'landmark.uid required' });
            return;
          }
          const saved = await StorageManager.saveLandmark(landmark);
          sendResponse({ success: true, landmark: saved });
        } catch (err) {
          Logger.warn('background', `SAVE_LANDMARK failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.266 — Partial landmark update. Used by drift-confirmation
    // UX (Phase 6.5 closure) to update proposedEffect when the author
    // accepts the observed value. Also usable by future surfaces for
    // lifecycle overrides, profile edits, etc.
    case 'UPDATE_LANDMARK': {
      (async () => {
        try {
          const { uid, patch } = payload ?? {};
          if (!uid)   { sendResponse({ success: false, error: 'uid required' });   return; }
          if (!patch || typeof patch !== 'object') {
            sendResponse({ success: false, error: 'patch object required' });
            return;
          }
          const updated = await StorageManager.updateLandmark(uid, patch);
          sendResponse({ success: true, landmark: updated });
        } catch (err) {
          Logger.warn('background', `UPDATE_LANDMARK failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'GET_LANDMARK': {
      (async () => {
        try {
          const { uid } = payload ?? {};
          if (!uid) { sendResponse({ success: false, error: 'uid required' }); return; }
          const landmark = await StorageManager.getLandmark(uid);
          sendResponse({ success: true, landmark });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'GET_LANDMARKS': {
      (async () => {
        try {
          const { uids } = payload ?? {};
          if (!Array.isArray(uids)) { sendResponse({ success: false, error: 'uids array required' }); return; }
          const landmarks = await StorageManager.getLandmarks(uids);
          sendResponse({ success: true, landmarks });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_LANDMARK': {
      (async () => {
        try {
          const { uid } = payload ?? {};
          if (!uid) { sendResponse({ success: false, error: 'uid required' }); return; }
          await StorageManager.deleteLandmark(uid);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.243 — Phase 5 substrate spec: blast-radius computation.
    // Authoring UIs call this BEFORE removing / deprecating a
    // landmark to warn the author about dependent locales / fragments
    // / observations. Returns the consumer list + summary counts.
    // v2.74.247 — Phase 7c substrate spec: locale activation
    // evaluator. Sidepanel callers (Studio surfaces, drift detection)
    // ask "which locales are active given this page state?" The
    // runtime equivalent lives inside TemplateWalker; this handler
    // makes the same evaluator reachable from authoring UIs.
    case 'LIST_ACTIVE_LOCALES': {
      (async () => {
        try {
          const { groundId, tabUrl, tabId } = payload ?? {};
          if (!groundId) {
            sendResponse({ success: false, error: 'groundId required' });
            return;
          }
          let url = tabUrl;
          if (!url && typeof tabId === 'number') {
            try { url = (await chrome.tabs.get(tabId))?.url ?? ''; }
            catch { url = ''; }
          }
          // v2.74.277 — listActiveLocales now statically imported.
          const locales = await listActiveLocales(groundId, { tabUrl: url ?? '', tabId });
          sendResponse({
            success: true,
            tabUrl : url ?? null,
            // v2.74.275 — Legacy urlPattern field removed; URL gating
            // expressed via predicates (urlMatches kind).
            locales: locales.map(l => ({
              id: l.id, name: l.name,
              landmarkCount: Array.isArray(l.landmarkRefs) ? l.landmarkRefs.length : 0,
              iframeContextCount: Array.isArray(l.iframeContexts) ? l.iframeContexts.length : 0,
            })),
          });
        } catch (err) {
          Logger.warn('background', `LIST_ACTIVE_LOCALES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'ANALYZE_LANDMARK_IMPACT': {
      (async () => {
        try {
          const { uid, groundId } = payload ?? {};
          if (!uid || !groundId) {
            sendResponse({ success: false, error: 'uid + groundId required' });
            return;
          }
          // v2.74.277 — analyzeLandmarkImpact now statically imported.
          const impact = await analyzeLandmarkImpact(uid, groundId);
          sendResponse({ success: true, impact });
        } catch (err) {
          Logger.warn('background', `ANALYZE_LANDMARK_IMPACT failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.249 — Phase 8: Ground event bus. Studio (and any other
    // surface) can read/clear the per-ground event log via these
    // handlers. Emit is primarily called engine-side (TemplateWalker)
    // but exposed here so UI surfaces can synthesize events (e.g.,
    // manual lifecycle overrides recorded as audit trail).
    case 'EMIT_GROUND_EVENT': {
      (async () => {
        try {
          const { groundId, event } = payload ?? {};
          if (!groundId || !event) {
            sendResponse({ success: false, error: 'groundId + event required' });
            return;
          }
          // v2.74.277 — emit statically imported as emitGroundEvent_bg.
          const entry = await emitGroundEvent_bg(groundId, event);
          sendResponse({ success: true, event: entry });
        } catch (err) {
          Logger.warn('background', `EMIT_GROUND_EVENT failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'LIST_GROUND_EVENTS': {
      (async () => {
        try {
          const { groundId, opts } = payload ?? {};
          if (!groundId) {
            sendResponse({ success: false, error: 'groundId required' });
            return;
          }
          // v2.74.277 — list statically imported as listGroundEvents_bg.
          const events = await listGroundEvents_bg(groundId, opts ?? {});
          sendResponse({ success: true, events });
        } catch (err) {
          Logger.warn('background', `LIST_GROUND_EVENTS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'CLEAR_GROUND_EVENTS': {
      (async () => {
        try {
          const { groundId } = payload ?? {};
          if (!groundId) {
            sendResponse({ success: false, error: 'groundId required' });
            return;
          }
          // v2.74.277 — clear statically imported as clearGroundEvents_bg.
          await clearGroundEvents_bg(groundId);
          sendResponse({ success: true });
        } catch (err) {
          Logger.warn('background', `CLEAR_GROUND_EVENTS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.252 — Phase 9: Landmark re-verification primitives.
    // Substrate primitive only; no automatic trigger (per spec dev
    // decision 2026-05-21). UI surfaces invoke explicitly.
    case 'VERIFY_LANDMARK': {
      (async () => {
        try {
          const { uid, tabId } = payload ?? {};
          if (!uid)                    { sendResponse({ success: false, error: 'uid required' });    return; }
          if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' });  return; }
          // v2.74.277 — verifyLandmark now statically imported.
          const result = await verifyLandmark(uid, tabId);
          sendResponse(result);
        } catch (err) {
          Logger.warn('background', `VERIFY_LANDMARK failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'VERIFY_STALE_SUSPECTED_ON_GROUND': {
      (async () => {
        try {
          const { groundId, tabId, scope } = payload ?? {};
          if (!groundId)               { sendResponse({ success: false, error: 'groundId required' }); return; }
          if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' });    return; }
          // v2.74.277 — verifyStaleSuspectedOnGround now statically imported.
          const result = await verifyStaleSuspectedOnGround(groundId, tabId, { scope });
          sendResponse(result);
        } catch (err) {
          Logger.warn('background', `VERIFY_STALE_SUSPECTED_ON_GROUND failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.254 — Phase 10: Landmark reference replacement. Symmetric
    // to ANALYZE_LANDMARK_IMPACT (Phase 5). Supports dryRun preview
    // so Studio can show "this would rewrite N fragments / M
    // observations / K locale refs" before commit.
    case 'REPLACE_LANDMARK_REFERENCES': {
      (async () => {
        try {
          const { oldUid, newUid, groundId, dryRun } = payload ?? {};
          if (!oldUid || !newUid || !groundId) {
            sendResponse({ success: false, error: 'oldUid + newUid + groundId required' });
            return;
          }
          // v2.74.277 — replaceLandmarkReferences now statically imported.
          const result = await replaceLandmarkReferences(oldUid, newUid, groundId, { dryRun: dryRun === true });
          sendResponse(result);
        } catch (err) {
          Logger.warn('background', `REPLACE_LANDMARK_REFERENCES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.255 — Phase 10.5: replacement candidate finder. Ranked
    // suggestions for which landmark to swap in when removing or
    // recovering from drift. Composes with REPLACE_LANDMARK_REFERENCES
    // (Phase 10) and ANALYZE_LANDMARK_IMPACT (Phase 5).
    case 'FIND_REPLACEMENT_CANDIDATES': {
      (async () => {
        try {
          const { uid, groundId, limit, includeWeak, minConfidence } = payload ?? {};
          if (!uid || !groundId) {
            sendResponse({ success: false, error: 'uid + groundId required' });
            return;
          }
          // v2.74.277 — findReplacementCandidates now statically imported.
          const result = await findReplacementCandidates(uid, groundId, { limit, includeWeak, minConfidence });
          sendResponse(result);
        } catch (err) {
          Logger.warn('background', `FIND_REPLACEMENT_CANDIDATES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.236 — Authoring-time resolver. The sidepanel uses this
    // when an author selects a landmark from the dropdown — we resolve
    // the ref immediately so the UI can populate the selector preview
    // and verify it. Runtime resolution happens engine-side via
    // applyLandmarkRefToStep (not this handler).
    case 'RESOLVE_LANDMARK_REF': {
      (async () => {
        try {
          const { ref } = payload ?? {};
          // v2.74.277 — resolveLandmarkRef now statically imported.
          const resolved = await resolveLandmarkRef(ref);
          sendResponse({
            success : true,
            selector: resolved.selector,
            frameUrl: resolved.frameUrl,
            landmark: resolved.landmark,
            locale  : { id: resolved.locale.id, name: resolved.locale.name },
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'GENERATE_LANDMARK_PROFILE_BG': {
      (async () => {
        try {
          const {
            role, currentSelector,
            fingerprint, outerHTMLPreview, parentOuterHTMLPreview,
            frame, matchedCount, screenshotDataUrl, operationsAllowed,
          } = payload ?? {};
          // v2.74.291 — Diagnostic at the message-passing boundary.
          // chrome.runtime.sendMessage JSON-serializes payloads; multi-MB
          // base64 strings have failed silently in the past. Log the
          // arriving size so we can detect drop here vs. at the call site.
          Logger.info('background', `GENERATE_LANDMARK_PROFILE_BG — screenshotDataUrl arrived: ${screenshotDataUrl ? `string (${screenshotDataUrl.length} chars)` : 'null/absent'}, matchedCount=${matchedCount}`);
          const res = await AnthropicService.generateLandmarkProfile({
            role, currentSelector,
            fingerprint, outerHTMLPreview, parentOuterHTMLPreview,
            frame, matchedCount, screenshotDataUrl, operationsAllowed,
          });
          sendResponse(res);
        } catch (err) {
          Logger.warn('background', `GENERATE_LANDMARK_PROFILE_BG failed: ${err.message}`);
          sendResponse({ success: false, profile: null, error: err.message });
        }
      })();
      return true;
    }

    case 'ASK_CLAUDE_FOR_SELECTOR_BG': {
      (async () => {
        try {
          const {
            shape, currentSelector,
            matchCount, matchIndex, pickLastUsed,
            outerHTMLPreview, parentOuterHTMLPreview,
            frame,
            // v2.74.233 — Optional cropped screenshot of the picked
            // element region (locale-landmark Pick flow uses this).
            screenshotDataUrl,
          } = payload ?? {};
          const res = await AnthropicService.suggestSelector({
            shape, currentSelector,
            matchCount, matchIndex, pickLastUsed,
            outerHTMLPreview, parentOuterHTMLPreview,
            frame,
            screenshotDataUrl,
          });
          sendResponse(res);
        } catch (err) {
          Logger.warn('background', `ASK_CLAUDE_FOR_SELECTOR_BG failed: ${err.message}`);
          sendResponse({ success: false, selector: '', error: err.message });
        }
      })();
      return true;
    }

    case 'CLIPBOARD_READ_BG': {
      (async () => {
        try {
          // Ensure offscreen document exists.
          const existing = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
          });
          if (!existing || existing.length === 0) {
            await chrome.offscreen.createDocument({
              url: 'offscreen.html',
              reasons: ['CLIPBOARD'],
              justification: 'Reading clipboard for click_copy extract shape',
            });
          }
          // Ask the offscreen doc to read the clipboard. chrome.runtime.
          // sendMessage broadcasts to every extension context that
          // registered onMessage; only the offscreen handler responds
          // (it filters by type), and the background's own onMessage
          // handler doesn't have an OFFSCREEN_READ_CLIPBOARD case so
          // it ignores the broadcast.
          const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_READ_CLIPBOARD' });
          if (!res) {
            sendResponse({ success: false, error: 'offscreen did not respond to clipboard read' });
            return;
          }
          sendResponse(res);
        } catch (err) {
          Logger.error('background', `CLIPBOARD_READ_BG failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.51 — Full-tab screenshot (image_full shape). Same idea as
    // OBSERVE_IMAGE_SNAP_BG but no scroll, no crop — just
    // chrome.tabs.captureVisibleTab on the active viewport and return
    // the data URL.
    case 'OBSERVE_IMAGE_FULL_BG': {
      // v2.74.146 — Delegates to Services/ImageReadCapture.performImageFull
      // so the same pipeline serves both this sidepanel-verify message
      // path and the runtime ExecutionEngine path (which now imports the
      // helper directly, avoiding SW-self-messaging).
      (async () => {
        try {
          const result = await performImageFull(payload ?? {});
          sendResponse(result);
        } catch (err) {
          Logger.error('background', `OBSERVE_IMAGE_FULL_BG failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    case 'OBSERVE_IMAGE_SNAP_BG': {
      // v2.74.146 — Delegates to Services/ImageReadCapture.performImageSnap
      // for the same reason as the FULL handler above.
      (async () => {
        try {
          const result = await performImageSnap(payload ?? {});
          sendResponse(result);
        } catch (err) {
          Logger.warn?.('background', `OBSERVE_IMAGE_SNAP_BG failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }



    //
    // Used by fragment-author mode's per-row Verify button. Dispatches
    // to the same content-script EXECUTE_STEP / WAIT_FOR_ELEM paths
    // TemplateWalker uses during T3 walks. For NAVIGATE we use
    // chrome.tabs.update; for WAIT we sleep server-side; for everything
    // else we forward to the content script.
    //
    // Returns { success, error?, info? }.
    case 'EXECUTE_AUTHORING_STEP': {
      (async () => {
        try {
          const { tabId, step } = payload ?? {};
          if (!tabId || !step?.action) {
            sendResponse({ success: false, error: 'tabId and step.action required' });
            return;
          }
          // v2.74.163 — Same-origin iframe support for verify. When the
          // step was picked inside an iframe, the picker captured the
          // iframe's URL into step.frameUrl. Re-resolve to the current
          // frameId (frame ids aren't stable across reloads) and route
          // EXECUTE_STEP / WAIT_FOR_ELEM into that frame. Top-frame
          // actions resolve to TOP_FRAME_ID (= 0) and behave as before.
          const verifyFrameId = await TemplateWalker._resolveFrameId(tabId, step.frameUrl);

          // NAVIGATE: chrome.tabs.update. Wait for tab complete before resolving.
          if (step.action === 'NAVIGATE') {
            try {
              await new Promise((resolve, reject) => {
                chrome.tabs.update(tabId, { url: step.value }, () => {
                  if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                  else resolve();
                });
              });
              await __waitForTabComplete(tabId, 8000);
              // Re-inject content script after navigation (the new page lost it).
              // v2.74.166 — allFrames: true so iframes in the new page
              // also get the content script. The manifest's auto-inject
              // covers iframes that load AFTER, but iframes that arrive
              // synchronously with the top page need this re-inject too
              // for the picker to reach them on subsequent operations.
              try {
                await chrome.scripting.executeScript({
                  target: { tabId, allFrames: true },
                  files: ['ContentScripts/contentScript.js'],
                });
              } catch { /* fine */ }
              sendResponse({ success: true, info: `navigated to ${step.value}` });
            } catch (e) {
              sendResponse({ success: false, error: `NAVIGATE failed: ${e.message}` });
            }
            return;
          }

          // WAIT: server-side sleep.
          if (step.action === 'WAIT') {
            const ms = Number(step.value) || 0;
            await new Promise(r => setTimeout(r, ms));
            sendResponse({ success: true, info: `waited ${ms}ms` });
            return;
          }

          // WAIT_FOR: forward to content script's WAIT_FOR_ELEM.
          if (step.action === 'WAIT_FOR') {
            try {
              const res = await new Promise((resolve, reject) => {
                chrome.tabs.sendMessage(tabId, {
                  type: 'WAIT_FOR_ELEM',
                  payload: { selector: step.selector, timeoutMs: 10000 },
                }, { frameId: verifyFrameId }, (response) => {
                  if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                  else resolve(response);
                });
              });
              sendResponse(res ?? { success: false, error: 'WAIT_FOR returned null' });
            } catch (e) {
              sendResponse({ success: false, error: `WAIT_FOR failed: ${e.message}` });
            }
            return;
          }

          // v2.74.200 — WAIT_FOR_GONE: poll until selector disappears.
          // Inline polling loop using CHECK_ELEMENT (mirrors
          // TemplateWalker.#waitForElementGone). timeoutMs from
          // step.value, default 30000. Frame-aware via verifyFrameId.
          // Verify uses a shorter default (15000) so the authoring
          // session doesn't block for half a minute on a typo'd
          // selector that never disappears.
          if (step.action === 'WAIT_FOR_GONE') {
            const requested = parseInt(step.value, 10);
            const timeoutMs = Number.isFinite(requested) && requested > 0
              ? Math.min(requested, 60000)   // cap verify-time waits at 60s
              : 15000;                       // verify default
            const start = Date.now();
            const POLL_MS = 400;
            let cleared = false;
            let lastError = null;
            try {
              while (Date.now() - start < timeoutMs) {
                let resp;
                try {
                  resp = await new Promise((resolve, reject) => {
                    chrome.tabs.sendMessage(tabId, {
                      type: 'CHECK_ELEMENT',
                      payload: { selector: step.selector },
                    }, { frameId: verifyFrameId }, (response) => {
                      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                      else resolve(response);
                    });
                  });
                } catch (e) {
                  // Frame gone counts as cleared.
                  lastError = e?.message;
                  cleared = true;
                  break;
                }
                if (!resp?.found) {
                  cleared = true;
                  break;
                }
                await new Promise(r => setTimeout(r, POLL_MS));
              }
              if (cleared) {
                const elapsed = Date.now() - start;
                sendResponse({ success: true, info: `gone after ${elapsed}ms${lastError ? ` (frame error: ${lastError})` : ''}` });
              } else {
                sendResponse({
                  success: false,
                  error  : `WAIT_FOR_GONE: "${(step.selector ?? '').slice(0, 120)}" still present after ${timeoutMs}ms`,
                });
              }
            } catch (e) {
              sendResponse({ success: false, error: `WAIT_FOR_GONE failed: ${e.message}` });
            }
            return;
          }

          // CLICK / CLICK_BY_LABEL / TYPE / SELECT / BLUR / SCROLL_TO —
          // forward to EXECUTE_STEP.
          // v2.72.72 — SCROLL_TO carries an optional smoothScroll bool.
          // Forwarded as part of payload; content script's handleScrollTo
          // picks up the behavior flag.
          //
          // CLICK / CLICK_BY_LABEL special-case: a click can trigger a
          // navigation (same tab) or open a new tab. In either case the
          // content script may not get a chance to send its response
          // before being unloaded (same-tab nav) or the action's "result"
          // is on a different tab (new tab). To handle this, we set up
          // chrome.webNavigation + chrome.tabs.onCreated listeners scoped
          // to this tabId BEFORE dispatching, and treat either firing
          // within 3s as a success signal even if EXECUTE_STEP returns
          // an error.
          // v2.72.91 — CLICK_BY_LABEL fires a click on an option which
          // may navigate (e.g. clicking a link inside a menu). Same
          // rescue applies — treat both as clicking actions.
          if (step.action === 'CLICK' || step.action === 'CLICK_BY_LABEL') {
            try {
              // v2.74.163 — Pass verifyFrameId through to the click
              // helper. The helper dispatches CLICK / CLICK_BY_LABEL
              // into the resolved frame and watches for navigation
              // events on the tab (frame-agnostic) so click semantics
              // work the same in iframes as in the top frame.
              // v2.74.322 — Wrap the click in the observation bracket so we
              // ALSO capture the DOM-shape signal (observedInteractionPattern)
              // — e.g. a custom dropdown opening — alongside the nav/new-tab
              // detection below. The bracket (observeActionBracket) was built
              // for exactly this but was never wired into Verify, so a click
              // that opened a menu reported only "effect: none" with no hint
              // the menu was noticed. settleMs is small because
              // __executeClickWithNavObservation already waits out its 3s nav
              // window, so any menu is long open by the time END snapshots.
              const { actionResult: res, observation } = await observeActionBracket(
                tabId, verifyFrameId,
                () => __executeClickWithNavObservation(tabId, step, verifyFrameId),
                { settleMs: 150 },
              );
              // v2.74.312 — Verify-time effect observation. The click
              // helper already detects navigation + new-tab and encodes
              // it in res.info (and that detection survives page
              // teardown, which a fresh MutationObserver bracket would
              // not). Derive the observed substrate effect from those
              // signals and compare against the action's declared
              // effect so the author sees drift BEFORE save.
              //
              // Coverage: triggers-navigation + opens-new-thread are
              // observable here. triggers-modal (Phase 5 deferred) and
              // triggers-download (not tracked at verify) are not — for
              // those declared kinds we report observedEffect=null
              // ('not observable at verify time') rather than a false
              // 'none', so we don't flag spurious drift.
              const info = (res?.info ?? '').toLowerCase();
              let observedEffect;
              if (info.includes('opened new tab')) {
                observedEffect = { kind: 'opens-new-thread', form: 'tab' };
              } else if (info.includes('navigated')) {
                observedEffect = { kind: 'triggers-navigation' };
              } else {
                observedEffect = { kind: 'none' };
              }
              const declaredEffect = (step.effect && step.effect.kind) ? step.effect : { kind: 'none' };
              // Don't claim drift for effects we can't observe at verify
              // time (modal/download). Mark them inconclusive instead.
              const unobservableKinds = new Set(['triggers-modal', 'triggers-download']);
              let severity = null;
              let observable = true;
              if (unobservableKinds.has(declaredEffect.kind) && observedEffect.kind === 'none') {
                observable = false;   // can't confirm; not a mismatch
              } else {
                severity = classifyEffectDrift(declaredEffect, observedEffect);
              }
              res.effectObservation = {
                declaredEffect,
                observedEffect: observable ? observedEffect : null,
                severity,
                observable,
                // v2.74.322 — DOM-shape pattern from the bracket (our intel
                // layer, distinct from the spec effect). null when the page
                // navigated away before END could snapshot.
                observedInteractionPattern: observation?.observedInteractionPattern ?? null,
              };
              sendResponse(res);
            } catch (e) {
              sendResponse({ success: false, error: `${step.action} failed: ${e.message}` });
            }
            return;
          }
          try {
            const res = await new Promise((resolve, reject) => {
              chrome.tabs.sendMessage(tabId, {
                type: 'EXECUTE_STEP',
                payload: {
                  action: step.action,
                  selector: step.selector,
                  value: step.value,
                  smoothScroll: step.smoothScroll === true,
                  // v2.74.316 — KEY repeat count for verify-time dispatch.
                  repeat: step.repeat,
                },
              }, { frameId: verifyFrameId }, (response) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(response);
              });
            });
            sendResponse(res ?? { success: false, error: 'EXECUTE_STEP returned null' });
          } catch (e) {
            sendResponse({ success: false, error: `${step.action} failed: ${e.message}` });
          }
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.67 — Evaluate all of a Ground's named predicates (locales +
    // assertions) against the current page state of a tab. Returns the
    // ones that hold (match the page right now). Used by fragment-author
    // mode for auto-capturing preconditions at mount and postconditions
    // at save / per-Verify.
    //
    // Method: each locale becomes a {locale_ref} assertion; each
    // assertion is itself an assertion. Each is evaluated via
    // TemplateWalker.checkConditions against the live tab. Matching
    // ones are returned by id+name.
    //
    // Returns:
    //   {
    //     success: true,
    //     matchingLocales:    [{ id, name, urlPattern, landmarkCount }, ...],
    //     matchingAssertions: [{ id, name }, ...],
    //     urlPattern: string|null,   // ground.urlPattern as a precondition baseline
    //     evaluatedCount: { locales: N, assertions: N },
    //   }
    case 'EVALUATE_GROUND_PREDICATES': {
      (async () => {
        try {
          const { tabId, groundId } = payload ?? {};
          if (!tabId || !groundId) {
            sendResponse({ success: false, error: 'tabId and groundId required' });
            return;
          }

          const ground = await StorageManager.getGround(groundId);
          if (!ground) {
            sendResponse({ success: false, error: `Ground ${groundId} not found` });
            return;
          }

          const allLocales    = await StorageManager.listLocales(groundId);
          const allAssertions = await StorageManager.listAssertions(groundId);

          // Evaluate each locale via locale_ref. Matches if URL pattern
          // matches AND every landmark's selector resolves on the page.
          const matchingLocales = [];
          for (const loc of allLocales) {
            // v2.74.335 — LOCALE_SPEC § 12: deprecated Locales are not active
            // (retired perspectives don't contribute to the active set).
            if (loc?.lifecycle === 'deprecated') continue;
            try {
              const probe = await TemplateWalker.checkConditions({
                tabId,
                conditions: { match: 'all', conditions: [{ type: 'locale_ref', localeId: loc.id }] },
                timeoutMs: 0,
              });
              if (probe.ok) {
                // v2.74.275 — urlPattern removed; landmarkRefs[] is canonical.
                matchingLocales.push({
                  id: loc.id,
                  name: loc.name,
                  landmarkCount: (loc.landmarkRefs ?? []).length,
                });
              }
            } catch (e) {
              Logger.warn('background', `EVALUATE_GROUND_PREDICATES: locale ${loc.id} eval threw: ${e.message}`);
            }
          }

          // Evaluate each assertion via assertion_ref. Note the assertion
          // object IS the conditions arg directly; checkConditions accepts
          // an assertion or a conditions array.
          const matchingAssertions = [];
          for (const ast of allAssertions) {
            try {
              const probe = await TemplateWalker.checkConditions({
                tabId,
                conditions: { match: 'all', conditions: [{ type: 'assertion_ref', assertionId: ast.id }] },
                timeoutMs: 0,
              });
              if (probe.ok) {
                matchingAssertions.push({ id: ast.id, name: ast.name });
              }
            } catch (e) {
              Logger.warn('background', `EVALUATE_GROUND_PREDICATES: assertion ${ast.id} eval threw: ${e.message}`);
            }
          }

          // v2.72.68 — Get the live tab URL so callers can capture
          // URL-aware conditions. The Ground's static urlPattern is
          // returned separately as a baseline reference; the caller
          // (fragment-author mode) uses the live URL for postconditions
          // (which need to reflect actual navigation) and either the
          // live URL or the ground pattern for preconditions depending
          // on context.
          let currentUrl = null;
          try {
            const tab = await new Promise((resolve, reject) => {
              chrome.tabs.get(tabId, (t) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(t);
              });
            });
            currentUrl = tab?.url ?? null;
          } catch (e) {
            Logger.warn('background', `EVALUATE_GROUND_PREDICATES: tabs.get threw: ${e.message}`);
          }

          sendResponse({
            success: true,
            matchingLocales,
            matchingAssertions,
            currentUrl,
            urlPattern: ground.urlPattern ?? ground.url ?? null,
            evaluatedCount: { locales: allLocales.length, assertions: allAssertions.length },
          });
        } catch (err) {
          Logger.error('background', `EVALUATE_GROUND_PREDICATES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.22 — ABORT_FRAGMENT_WALK handler removed. AI-walked path is gone.

    case 'SAVE_FRAGMENT': {
      (async () => {
        try {
          const { fragment } = payload;
          if (!fragment?.id || !fragment?.groundId) {
            sendResponse({ success: false, error: 'Fragment requires { id, groundId }' });
            return;
          }
          await StorageManager.saveFragment(fragment);
          broadcastStorageChanged('fragment', fragment.id, 'saved');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_FRAGMENT failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.67 — Load a single Fragment by id. Used by fragment-author
    // mode for antecedent inheritance (preconditions ← antecedent's
    // postconditions).
    case 'GET_FRAGMENT': {
      (async () => {
        try {
          const { fragmentId } = payload ?? {};
          if (!fragmentId) {
            sendResponse({ success: false, error: 'fragmentId required' });
            return;
          }
          const fragment = await StorageManager.getFragment(fragmentId);
          if (!fragment) {
            sendResponse({ success: false, error: `Fragment ${fragmentId} not found` });
            return;
          }
          sendResponse({ success: true, fragment });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_FRAGMENT': {
      (async () => {
        try {
          const { fragmentId } = payload;
          await StorageManager.deleteFragment(fragmentId);
          broadcastStorageChanged('fragment', fragmentId, 'deleted');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_FRAGMENT failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'UPDATE_FRAGMENT': {
      (async () => {
        try {
          const { fragmentId, patch } = payload;
          const updated = await StorageManager.updateFragment(fragmentId, patch);
          broadcastStorageChanged('fragment', fragmentId, 'saved');
          sendResponse({ success: true, fragment: updated });
        } catch (err) {
          Logger.error('background', `UPDATE_FRAGMENT failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ╔══════════════════════════════════════════════════════════════════════╗
    // ║ Pass M2 — ASSERTION LIBRARY                                          ║
    // ╚══════════════════════════════════════════════════════════════════════╝

    // v2.74.53 — Begin handlers for the Ground sidepanel's + Assert /
    // + Analyze buttons. Mirror BEGIN_LOCALE_CAPTURE's minimal shape:
    // set the sidepanel mode with payload; the mode itself mounts and
    // owns its lifecycle.
    case 'BEGIN_ASSERTION_AUTHOR': {
      const { groundId, existingTabId = null, returnTo = null, prefilledAssertion = null } = payload ?? {};
      if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return false; }
      __setSidepanelMode('assertion-author', {
        groundId,
        tabId: existingTabId,
        existingTabId,
        returnTo,
        prefilledAssertion,
      });
      sendResponse({ success: true });
      return false;
    }
    case 'BEGIN_ANALYSIS_AUTHOR': {
      const { groundId, existingTabId = null, returnTo = null, prefilledAnalysis = null } = payload ?? {};
      if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return false; }
      __setSidepanelMode('analysis-author', {
        groundId,
        tabId: existingTabId,
        existingTabId,
        returnTo,
        prefilledAnalysis,
      });
      sendResponse({ success: true });
      return false;
    }
    // v2.74.53 — Analysis save handler. Previously only Studio's
    // AnalysisForm called StorageManager.saveAnalysis directly; the
    // sidepanel mode needs a message-routed equivalent.
    case 'SAVE_ANALYSIS': {
      (async () => {
        try {
          const { analysis } = payload;
          if (!analysis?.id || !analysis?.groundId) {
            sendResponse({ success: false, error: 'Analysis requires { id, groundId }' });
            return;
          }
          await StorageManager.saveAnalysis(analysis);
          broadcastStorageChanged('analysis', analysis.id, 'saved');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_ANALYSIS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'SAVE_ASSERTION': {
      (async () => {
        try {
          const { assertion } = payload;
          if (!assertion?.id || !assertion?.groundId) {
            sendResponse({ success: false, error: 'Assertion requires { id, groundId }' });
            return;
          }
          await StorageManager.saveAssertion(assertion);
          broadcastStorageChanged('assertion', assertion.id, 'saved');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_ASSERTION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.0 (Pass 3a) — Observation save/delete handlers. Mirrors the
    // SAVE_ASSERTION pattern. Broadcast is fire-and-forget so future
    // runtime/consumer code can listen for changes.
    case 'SAVE_OBSERVATION': {
      (async () => {
        try {
          const { observation } = payload;
          if (!observation?.id || !observation?.groundId) {
            sendResponse({ success: false, error: 'Observation requires { id, groundId }' });
            return;
          }
          await StorageManager.saveObservation(observation);
          broadcastStorageChanged('observation', observation.id, 'saved');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_OBSERVATION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_OBSERVATION': {
      (async () => {
        try {
          const { observationId } = payload;
          await StorageManager.deleteObservation(observationId);
          broadcastStorageChanged('observation', observationId, 'deleted');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_OBSERVATION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'LIST_ASSERTIONS': {
      (async () => {
        try {
          const { groundId } = payload;
          const assertions = await StorageManager.listAssertions(groundId);
          sendResponse({ success: true, assertions });
        } catch (err) {
          Logger.error('background', `LIST_ASSERTIONS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'GET_ASSERTION': {
      (async () => {
        try {
          const { assertionId } = payload;
          const assertion = await StorageManager.getAssertion(assertionId);
          sendResponse({ success: true, assertion });
        } catch (err) {
          Logger.error('background', `GET_ASSERTION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'UPDATE_ASSERTION': {
      (async () => {
        try {
          const { assertionId, patch } = payload;
          const updated = await StorageManager.updateAssertion(assertionId, patch);
          broadcastStorageChanged('assertion', assertionId, 'saved');
          sendResponse({ success: true, assertion: updated });
        } catch (err) {
          Logger.error('background', `UPDATE_ASSERTION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_ASSERTION': {
      (async () => {
        try {
          const { assertionId } = payload;
          await StorageManager.deleteAssertion(assertionId);
          broadcastStorageChanged('assertion', assertionId, 'deleted');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_ASSERTION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── v2.72.29 (Pass 17) — Locale CRUD ──────────────────────────────
    case 'SAVE_LOCALE': {
      (async () => {
        try {
          const { locale } = payload;
          await StorageManager.saveLocale(locale);
          broadcastStorageChanged('locale', locale.id, 'saved');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_LOCALE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    case 'LIST_LOCALES': {
      (async () => {
        try {
          const { groundId } = payload;
          const locales = await StorageManager.listLocales(groundId);
          sendResponse({ success: true, locales });
        } catch (err) {
          Logger.error('background', `LIST_LOCALES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    // v2.72.45 (Pass 17g iter) — GET_GROUND for the debugger's locale-capture
    // header label. Mirrors GET_LOCALE.
    case 'GET_GROUND': {
      (async () => {
        try {
          const { id } = payload ?? {};
          const ground = await StorageManager.getGround(id);
          // v2.74.319 — Attach the Ground's locales + assertions to the
          // response. getGround() returns only the raw Ground record;
          // locales/assertions are stored separately per-Ground. Several
          // consumers (fragment-author's _loadGroundCatalog, which powers
          // the landmark dropdown + condition-type Locales/Custom
          // optgroups) read `res.ground.locales` / `.assertions` — without
          // this assembly those were always undefined, so the landmark
          // dropdown never populated. Mirrors GET_GROUND_LIBRARY's
          // per-Ground assembly. Additive: callers that ignore the arrays
          // are unaffected.
          if (ground) {
            try {
              const [locales, assertions] = await Promise.all([
                StorageManager.listLocales(id),
                StorageManager.listAssertions(id),
              ]);
              ground.locales    = Array.isArray(locales)    ? locales    : [];
              ground.assertions = Array.isArray(assertions) ? assertions : [];
            } catch (e) {
              Logger.warn('background', `GET_GROUND: locale/assertion assembly failed: ${e.message}`);
              if (!Array.isArray(ground.locales))    ground.locales    = [];
              if (!Array.isArray(ground.assertions)) ground.assertions = [];
            }
          }
          sendResponse({ success: true, ground });
        } catch (err) {
          Logger.error('background', `GET_GROUND failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    // v2.74.27 — Bulk fetch for the Ground sidepanel's read-only browse
    // view. Returns every Ground with its Fragment / Assertion / Locale /
    // Observation / Analysis lists in one round trip. Strategies are
    // intentionally omitted — the Ground sidepanel doesn't surface them.
    case 'GET_GROUND_LIBRARY': {
      (async () => {
        try {
          const grounds = await StorageManager.getAllGrounds();
          const out = [];
          for (const g of grounds) {
            // v2.74.37 — Include groundMap so the sidepanel header can
            // mirror Studio's: name + url + 🗺 N pages badge.
            const [fragments, assertions, locales, observations, analyses, groundMap] =
              await Promise.all([
                StorageManager.listFragments(g.id),
                StorageManager.listAssertions(g.id),
                StorageManager.listLocales(g.id),
                StorageManager.listObservations(g.id),
                StorageManager.listAnalyses(g.id),
                StorageManager.getGroundMap(g.id),
              ]);
            out.push({ ground: g, fragments, assertions, locales, observations, analyses, groundMap });
          }
          sendResponse({ success: true, grounds: out });
        } catch (err) {
          Logger.error('background', `GET_GROUND_LIBRARY failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    case 'GET_LOCALE': {
      (async () => {
        try {
          const { localeId } = payload;
          const locale = await StorageManager.getLocale(localeId);
          sendResponse({ success: true, locale });
        } catch (err) {
          Logger.error('background', `GET_LOCALE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    case 'DELETE_LOCALE': {
      (async () => {
        try {
          const { localeId } = payload;
          await StorageManager.deleteLocale(localeId);
          broadcastStorageChanged('locale', localeId, 'deleted');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_LOCALE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.35 — Background handler for analysis deletion. Previously
    // Studio's deleteAnalysis() helper called StorageManager directly;
    // the Ground sidepanel needs a message-routed equivalent so it can
    // ✕-delete entries the same way other sections do.
    case 'DELETE_ANALYSIS': {
      (async () => {
        try {
          const { analysisId } = payload;
          await StorageManager.deleteAnalysis(analysisId);
          broadcastStorageChanged('analysis', analysisId, 'deleted');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_ANALYSIS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ╔══════════════════════════════════════════════════════════════════════╗
    // ║ Pass C — STRATEGY AUTHORING                                          ║
    // ╚══════════════════════════════════════════════════════════════════════╝

    case 'SAVE_STRATEGY': {
      (async () => {
        try {
          const { strategy } = payload;
          if (!strategy?.id || !strategy?.groundId) {
            sendResponse({ success: false, error: 'Strategy requires { id, groundId }' });
            return;
          }
          await StorageManager.saveStrategy(strategy);
          broadcastStorageChanged('strategy', strategy.id, 'saved');
          // v2.27.0 — notify chat's capability registry so suggestion cards
          // refresh. Previously this was a latent bug: Strategy saves didn't
          // trigger a chat capability refresh, so invoking the changed
          // Strategy showed stale data.
          CapabilityAPI.notifyRegistryChange('updated', strategy.id);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_STRATEGY failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_STRATEGY': {
      (async () => {
        try {
          const { strategyId } = payload;
          await StorageManager.deleteStrategy(strategyId);
          broadcastStorageChanged('strategy', strategyId, 'deleted');
          CapabilityAPI.notifyRegistryChange('removed', strategyId);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_STRATEGY failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ╔══════════════════════════════════════════════════════════════════════╗
    // ║ v2.74.70 — WORKFLOW AUTHORING                                        ║
    // ╚══════════════════════════════════════════════════════════════════════╝
    //
    // Workflows are a new top-level entity (no parent Ground). Same broadcast
    // pattern as Strategies — saves emit STORAGE_CHANGED so any Studio tab
    // currently rendering a workflow list re-renders. CapabilityAPI is NOT
    // notified yet: Workflows aren't capability-eligible until the
    // composition layer lands (a Workflow's invocation surface is undefined
    // until steps[] is populated, which the form doesn't yet do).

    case 'SAVE_WORKFLOW': {
      (async () => {
        try {
          const { workflow } = payload;
          if (!workflow?.id) {
            sendResponse({ success: false, error: 'Workflow requires { id }' });
            return;
          }
          const saved = await StorageManager.saveWorkflow(workflow);
          broadcastStorageChanged('workflow', saved.id, 'saved');
          // v2.74.82 — Strategy entities are capabilities now; notify the
          // CapabilityAPI registry so chat suggestion cards refresh. Match
          // the pattern SAVE_STRATEGY uses for Workflow entities.
          CapabilityAPI.notifyRegistryChange('updated', saved.id);
          sendResponse({ success: true, workflow: saved });
        } catch (err) {
          Logger.error('background', `SAVE_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_WORKFLOW': {
      (async () => {
        try {
          const { workflowId } = payload;
          await StorageManager.deleteWorkflow(workflowId);
          broadcastStorageChanged('workflow', workflowId, 'deleted');
          CapabilityAPI.notifyRegistryChange('removed', workflowId);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.76 — Top-level Strategy invocation. Loads the Strategy record,
    // resolves typed-input file params, walks its `steps` array through
    // the WorkflowExecutor. Progress events stream back through a per-tab
    // runtime message channel keyed by invocationId so the calling Studio
    // tab can render toasts as steps complete. The handler acks once with
    // the final summary; intermediate events are fire-and-forget broadcasts.
    //
    // v2.74.84 — Mid-run cancellation: each invocation's id is tracked in
    // a module-level Set when cancelled; the executor's isAborted closure
    // polls membership. Cleared on completion regardless of outcome.
    case 'INVOKE_WORKFLOW': {
      (async () => {
        try {
          // v2.74.158 — `debug` payload flag distinguishes Studio's
          // Debug (◐) invocation from the plain Run (▶) / chat-routed
          // invocation. The constructed envelope below sets `pauseMode`
          // accordingly so downstream runtime gates (the OBSERVATION
          // overlay in ExecutionEngine, the PAUSE-node guard, etc.)
          // can tell whether they're in a debug session. Defaults to
          // false (non-debug) to preserve old callers' behavior.
          const { workflowId, paramValues, invocationId, debug: debugRun = false } = payload;
          if (!workflowId) {
            sendResponse({ success: false, error: 'INVOKE_WORKFLOW requires workflowId' });
            return;
          }
          const workflow = await StorageManager.getWorkflow(workflowId);
          if (!workflow) {
            sendResponse({ success: false, error: `Workflow not found: ${workflowId}` });
            return;
          }
          const invId = invocationId
            ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `winv-${Date.now()}`);

          // Stream progress via broadcast — the Studio listener filters by
          // invocationId. We don't await each send; it's a fire-and-forget
          // channel that the receiver is free to ignore.
          const onProgress = (event) => {
            try {
              chrome.runtime.sendMessage({
                type: 'WORKFLOW_PROGRESS',
                payload: { invocationId: invId, event },
              }, () => { void chrome.runtime.lastError; /* ignore "no receiver" */ });
            } catch (_) { /* ignore */ }
          };

          // v2.74.91 — Debug envelope. `paused` lives in
          // _workflowDebugStates; PAUSE_WORKFLOW / RESUME_WORKFLOW
          // toggle it; the executor polls isPaused() between every step.
          // requestPause is invoked by PAUSE step nodes to halt the run
          // without external action — flips paused true AND broadcasts so
          // Studio's UI reacts immediately.
          const debugState = _getWorkflowDebugState(invId);
          // v2.74.98 — Remember the Strategy id so SET/CLEAR/TOGGLE
          // breakpoint handlers can persist their changes against the
          // Strategy record (not the per-invocation throwaway state).
          debugState.workflowId = workflowId;

          // v2.74.98 — Load persisted breakpoints into the live set
          // BEFORE executor starts. Broadcast once after load so the
          // workflow-debug sidepanel (which mounts before this point)
          // sees the gutter dots immediately.
          try {
            const saved = await StorageManager.getStrategyBreakpoints(workflowId);
            for (const idx of saved) debugState.breakpoints.add(idx);
            if (saved.length > 0) _broadcastWorkflowBreakpoints(invId, debugState.breakpoints, workflowId);
          } catch (e) {
            Logger.warn('background', `breakpoint load failed: ${e.message}`);
          }

          const debug = {
            // v2.74.158 — pauseMode signal. `'off'` for non-debug runs
            // (plain Studio ▶ / chat invocations) so downstream gates
            // — notably the OBSERVATION overlay in ExecutionEngine —
            // can suppress debug-only side effects. `'after-node'`
            // when the caller marked the run as a debug session.
            pauseMode: debugRun ? 'after-node' : 'off',
            isPaused: () => debugState.paused,
            requestPause: () => {
              debugState.paused = true;
              _broadcastWorkflowPauseState(invId, true);
            },
            onPauseStateChange: (state) => {
              _broadcastWorkflowPauseState(invId, !!state.paused);
            },
            // v2.74.94 — Step-through. The executor calls this after every
            // step completes; if true, the executor immediately re-pauses
            // (via requestPause above) so the next step waits for another
            // Step / Resume click. Single-shot consumption — STEP_*_WORKFLOW
            // re-arms the flag each time the user clicks.
            //
            // v2.74.101 — Depth-aware. The executor passes its current
            // pathPrefix; if stepOverPrefix is set, consume only when
            // they match (Step Over semantics — runs control-flow steps
            // as a single unit). If stepOverPrefix is null, consume at
            // any depth (Step Into — first step boundary wins).
            consumeStepRequest: (pathPrefix) => {
              if (!debugState.stepRequested) return false;
              if (debugState.stepOverPrefix != null && debugState.stepOverPrefix !== (pathPrefix ?? '')) {
                return false;
              }
              debugState.stepRequested = false;
              debugState.stepOverPrefix = null;
              return true;
            },
            // v2.74.95 — Breakpoints. Executor calls before each step;
            // if true, the step pauses before running.
            // v2.74.100 — Path-keyed: argument is a dot-notation step
            // path (e.g. "2", "2.body.1", "3.branches.0.body.0"). Numeric
            // top-level indices coerce to strings naturally so legacy
            // top-level breakpoints work unchanged.
            isBreakpoint: (stepPath) => debugState.breakpoints.has(String(stepPath)),
          };

          try {
            const result = await executeWorkflow(workflow, paramValues ?? {}, {
              onProgress,
              invocationId: invId,
              isAborted: () => _workflowCancellations.has(invId),
              debug,
            });
            sendResponse({ success: !!result.success, invocationId: invId, ...result });
          } finally {
            // Always cleanup — leaving stale ids in either map would
            // silently poison the next invocation that recycles the id.
            _workflowCancellations.delete(invId);
            _workflowDebugStates.delete(invId);
          }
        } catch (err) {
          Logger.error('background', `INVOKE_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.84 — Cancel an in-flight Strategy invocation. The id is added
    // to _workflowCancellations; the executor's next isAborted poll picks
    // it up (between steps and in WAIT slices). The original INVOKE_WORKFLOW
    // handler resolves with `{error: 'Aborted'}` shortly after and cleans
    // the set in its finally block.
    //
    // No-op (and success-true response) if the id isn't an active invocation:
    // it's possible the run completed before the cancel reached us, which
    // is fine — caller doesn't need to know the difference.
    case 'CANCEL_WORKFLOW': {
      (async () => {
        try {
          const { invocationId } = payload;
          if (!invocationId) {
            sendResponse({ success: false, error: 'CANCEL_WORKFLOW requires invocationId' });
            return;
          }
          _workflowCancellations.add(invocationId);
          // v2.74.91 — Cancel-while-paused: also flip the pause flag off
          // so the executor's _yieldIfPaused loop wakes up immediately and
          // sees the abort, instead of waiting for the next 100ms poll
          // tick. (The yield loop checks isAborted on every iteration so
          // this is belt-and-suspenders.)
          const state = _workflowDebugStates.get(invocationId);
          if (state) {
            // v2.74.101 — Clear pending step requests so a cancel can't
            // accidentally re-pause the executor on its way out.
            state.stepRequested = false;
            state.stepOverPrefix = null;
            if (state.paused) {
              state.paused = false;
              _broadcastWorkflowPauseState(invocationId, false);
            }
          }
          Logger.info('background', `CANCEL_WORKFLOW queued for invocation ${invocationId}`);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `CANCEL_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.91 — Pause / resume control for in-flight Strategy invocations.
    // The executor's debug.isPaused() closure polls _workflowDebugStates;
    // these two handlers flip the flag and broadcast WORKFLOW_PAUSE_STATE
    // so Studio's UI swaps its ▶ / ■ / ⏸ buttons in real time.
    case 'PAUSE_WORKFLOW': {
      (async () => {
        try {
          const { invocationId } = payload;
          if (!invocationId) {
            sendResponse({ success: false, error: 'PAUSE_WORKFLOW requires invocationId' });
            return;
          }
          const state = _getWorkflowDebugState(invocationId);
          state.paused = true;
          _broadcastWorkflowPauseState(invocationId, true);
          Logger.info('background', `PAUSE_WORKFLOW for invocation ${invocationId}`);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `PAUSE_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    case 'RESUME_WORKFLOW': {
      (async () => {
        try {
          const { invocationId } = payload;
          if (!invocationId) {
            sendResponse({ success: false, error: 'RESUME_WORKFLOW requires invocationId' });
            return;
          }
          const state = _getWorkflowDebugState(invocationId);
          state.paused = false;
          // v2.74.94 — Resume-after-Step semantically means "continue
          // freely from here". Clearing the flag prevents an immediate
          // re-pause after the next step completes.
          // v2.74.101 — Also clear Step Over's depth pin.
          state.stepRequested = false;
          state.stepOverPrefix = null;
          _broadcastWorkflowPauseState(invocationId, false);
          Logger.info('background', `RESUME_WORKFLOW for invocation ${invocationId}`);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `RESUME_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.94 — Step (advance one step, then re-pause). Sets the flag the
    // executor consumes after every step completes, unpauses so the
    // current yield loop exits, and broadcasts so the sidepanel UI flips
    // out of paused state until the next step boundary.
    case 'STEP_WORKFLOW': {
      (async () => {
        try {
          const { invocationId } = payload;
          if (!invocationId) {
            sendResponse({ success: false, error: 'STEP_WORKFLOW requires invocationId' });
            return;
          }
          const state = _getWorkflowDebugState(invocationId);
          state.stepRequested = true;
          // v2.74.101 — Step Into: no prefix constraint, so the first
          // step-boundary at any depth consumes the request.
          state.stepOverPrefix = null;
          state.paused = false;
          _broadcastWorkflowPauseState(invocationId, false);
          Logger.info('background', `STEP_WORKFLOW (into) for invocation ${invocationId}`);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `STEP_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.101 — Step Over: run the current step as a single unit
    // (including all body iterations of a control-flow step) and pause
    // at the next sibling step at the same depth. Implementation pins
    // consumeStepRequest's matching pathPrefix to the parent of the
    // currently-paused step's path.
    case 'STEP_OVER_WORKFLOW': {
      (async () => {
        try {
          const { invocationId, stepPath } = payload;
          if (!invocationId) {
            sendResponse({ success: false, error: 'STEP_OVER_WORKFLOW requires invocationId' });
            return;
          }
          const state = _getWorkflowDebugState(invocationId);
          state.stepRequested = true;
          // Derive parent prefix from the paused step's path. For "2",
          // parent prefix is "" (top-level loop). For "2.body.1", parent
          // prefix is "2.body".
          const lastDot = typeof stepPath === 'string' ? stepPath.lastIndexOf('.') : -1;
          state.stepOverPrefix = lastDot >= 0 ? stepPath.slice(0, lastDot) : '';
          state.paused = false;
          _broadcastWorkflowPauseState(invocationId, false);
          Logger.info('background', `STEP_OVER_WORKFLOW for invocation ${invocationId} (prefix="${state.stepOverPrefix}")`);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `STEP_OVER_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.95 — Breakpoint management. SET adds; CLEAR removes; TOGGLE
    // flips. Top-level step indices only in this pass (path-based
    // breakpoints for nested steps come later). All three broadcast
    // WORKFLOW_BREAKPOINTS so the sidepanel UI re-renders its indicators.
    case 'SET_BREAKPOINT_WORKFLOW':
    case 'CLEAR_BREAKPOINT_WORKFLOW':
    case 'TOGGLE_BREAKPOINT_WORKFLOW': {
      (async () => {
        try {
          // v2.74.100 — Path-based addressing. Accept `stepPath` (the
          // canonical form) or `stepIndex` (legacy top-level). Both
          // coerce to a string path that matches the executor's
          // isBreakpoint argument.
          const { invocationId, workflowId } = payload;
          let stepPath = payload?.stepPath;
          if (!stepPath && Number.isFinite(payload?.stepIndex)) {
            stepPath = String(payload.stepIndex);
          }
          if (typeof stepPath !== 'string' || !stepPath) {
            sendResponse({ success: false, error: 'breakpoint message requires stepPath' });
            return;
          }

          // v2.74.99 — Two paths:
          //   1. invocationId present → mutate the live debug state for
          //      the in-flight run; persist on the side so the next run
          //      starts with the same breakpoints.
          //   2. workflowId only → pre-invocation toggle. Mutates the
          //      persisted set directly without an active debug state.
          //
          // Both paths broadcast WORKFLOW_BREAKPOINTS so any open
          // workflow-debug sidepanel re-renders.

          if (invocationId) {
            const state = _getWorkflowDebugState(invocationId);
            if (msg.type === 'SET_BREAKPOINT_WORKFLOW')   state.breakpoints.add(stepPath);
            if (msg.type === 'CLEAR_BREAKPOINT_WORKFLOW') state.breakpoints.delete(stepPath);
            if (msg.type === 'TOGGLE_BREAKPOINT_WORKFLOW') {
              if (state.breakpoints.has(stepPath)) state.breakpoints.delete(stepPath);
              else                                 state.breakpoints.add(stepPath);
            }
            _broadcastWorkflowBreakpoints(invocationId, state.breakpoints, state.workflowId);
            if (state.workflowId) {
              try { await StorageManager.saveStrategyBreakpoints(state.workflowId, [...state.breakpoints]); }
              catch (e) { Logger.warn('background', `breakpoint persist failed: ${e.message}`); }
            }
            sendResponse({ success: true, breakpoints: [...state.breakpoints] });
            return;
          }

          if (workflowId) {
            // Pre-invocation path — load → mutate → save.
            const current = await StorageManager.getStrategyBreakpoints(workflowId);
            const set = new Set(current);
            if (msg.type === 'SET_BREAKPOINT_WORKFLOW')   set.add(stepPath);
            if (msg.type === 'CLEAR_BREAKPOINT_WORKFLOW') set.delete(stepPath);
            if (msg.type === 'TOGGLE_BREAKPOINT_WORKFLOW') {
              if (set.has(stepPath)) set.delete(stepPath);
              else                   set.add(stepPath);
            }
            await StorageManager.saveStrategyBreakpoints(workflowId, [...set]);
            _broadcastWorkflowBreakpoints(null, set, workflowId);
            sendResponse({ success: true, breakpoints: [...set] });
            return;
          }

          sendResponse({ success: false, error: 'breakpoint message requires { invocationId } OR { workflowId }' });
        } catch (err) {
          Logger.error('background', `${msg.type} failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.99 — Fetch persisted breakpoints for a Strategy. The
    // workflow-debug sidepanel calls this on mount so gutter dots paint
    // the saved breakpoints before any invocation runs.
    case 'GET_WORKFLOW_BREAKPOINTS': {
      (async () => {
        try {
          const { workflowId } = payload;
          if (!workflowId) {
            sendResponse({ success: false, error: 'GET_WORKFLOW_BREAKPOINTS requires workflowId' });
            return;
          }
          const list = await StorageManager.getStrategyBreakpoints(workflowId);
          sendResponse({ success: true, breakpoints: list });
        } catch (err) {
          Logger.error('background', `GET_WORKFLOW_BREAKPOINTS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.27.0 — Ground CUD through background.js. Previously sidepanel.js
    // saved Grounds directly via StorageManager; Studio uses the same pattern.
    // Routing through background centralizes the STORAGE_CHANGED broadcast
    // and the CapabilityAPI registry notification. UI layers still broadcast
    // from their side too (belt-and-suspenders; the message is idempotent).
    case 'SAVE_GROUND': {
      (async () => {
        try {
          const { ground } = payload;
          if (!ground?.id) {
            sendResponse({ success: false, error: 'Ground requires { id }' });
            return;
          }
          await StorageManager.saveGround(ground);
          broadcastStorageChanged('ground', ground.id, 'saved');
          CapabilityAPI.notifyRegistryChange('updated', null);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_GROUND failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_GROUND': {
      (async () => {
        try {
          const { groundId } = payload;
          await StorageManager.deleteGround(groundId);
          broadcastStorageChanged('ground', groundId, 'deleted');
          CapabilityAPI.notifyRegistryChange('removed', null);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_GROUND failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.329 — GROUND_SPEC § 5 derived intent. Synthesize a Ground's
    // description from its constituent Locales (lazy/manual: only on explicit
    // request). Cache-validated by inputs hash + prompt version; returns the
    // cached value untouched when nothing changed (unless force=true).
    case 'DERIVE_GROUND_DESCRIPTION': {
      (async () => {
        try {
          const { groundId, force = false } = payload ?? {};
          if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
          const ground = await StorageManager.getGround(groundId);
          if (!ground) { sendResponse({ success: false, error: `Ground ${groundId} not found` }); return; }
          const locales = await StorageManager.listLocales(groundId);
          if (!Array.isArray(locales) || locales.length === 0) {
            sendResponse({ success: false, error: 'Ground has no Locales to derive from' });
            return;
          }
          const hash = derivationInputsHash(locales);
          if (!force && ground.derivedDescription
              && ground.derivationInputsHash === hash
              && (ground.derivationVersion || 0) === DERIVATION_VERSION) {
            sendResponse({ success: true, cached: true, derivedDescription: ground.derivedDescription, derivedAt: ground.derivedAt });
            return;
          }
          const text = await AnthropicService.deriveGroundDescription({
            name      : ground.name,
            urlPrimary: ground.urlPatterns?.find(p => p?.isPrimary)?.pattern ?? ground.urlPatterns?.[0]?.pattern ?? ground.url,
            locales   : locales.map(l => ({ name: l.name, description: l.description })),
          });
          if (!text) {
            sendResponse({ success: false, error: 'Derivation returned nothing (LLM unavailable or empty response)' });
            return;
          }
          const derivedAt = Date.now();
          await StorageManager.updateGround(groundId, {
            derivedDescription   : text,
            derivedAt,
            derivationVersion    : DERIVATION_VERSION,
            derivationInputsHash : hash,
          });
          broadcastStorageChanged('ground', groundId, 'saved');
          sendResponse({ success: true, cached: false, derivedDescription: text, derivedAt });
        } catch (err) {
          Logger.error('background', `DERIVE_GROUND_DESCRIPTION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.329 — Set or clear a Ground's description override (GROUND_SPEC
    // § 5). override null/empty → clear (fall back to derived).
    case 'SET_GROUND_DESCRIPTION_OVERRIDE': {
      (async () => {
        try {
          const { groundId, override } = payload ?? {};
          if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
          const value = (typeof override === 'string' && override.trim()) ? override.trim() : null;
          const updated = await StorageManager.updateGround(groundId, { descriptionOverride: value });
          if (!updated) { sendResponse({ success: false, error: `Ground ${groundId} not found` }); return; }
          broadcastStorageChanged('ground', groundId, 'saved');
          sendResponse({ success: true, descriptionOverride: value });
        } catch (err) {
          Logger.error('background', `SET_GROUND_DESCRIPTION_OVERRIDE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.330 — GROUND_SPEC § 9 lifecycle. Deprecate (soft-delete) /
    // reactivate. 'deprecated' is persisted; 'active' clears the flag so
    // getGround re-derives active/draft from Locale presence. (Cascade-
    // deprecation to Locales/Workflows is deferred — those entities have no
    // lifecycle field yet; see SPEC_DEV.)
    case 'SET_GROUND_LIFECYCLE': {
      (async () => {
        try {
          const { groundId, lifecycle } = payload ?? {};
          if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
          if (lifecycle !== 'deprecated' && lifecycle !== 'active') {
            sendResponse({ success: false, error: `lifecycle must be 'deprecated' or 'active' (got ${lifecycle})` });
            return;
          }
          // 'active' clears the persisted flag (null) → effective state is
          // re-derived on read; 'deprecated' persists.
          const persisted = lifecycle === 'deprecated' ? 'deprecated' : null;
          const updated = await StorageManager.updateGround(groundId, { metadata: { lifecycle: persisted } });
          if (!updated) { sendResponse({ success: false, error: `Ground ${groundId} not found` }); return; }
          // v2.74.335 — GROUND_SPEC § 11 cascade: deprecating a Ground
          // deprecates its constituent Locales. Reactivation does NOT auto-
          // reactivate Locales (spec: opt-in, user reviews each).
          let cascaded = 0;
          if (lifecycle === 'deprecated') {
            try {
              const locales = await StorageManager.listLocales(groundId);
              for (const loc of locales) {
                if (loc?.lifecycle !== 'deprecated') {
                  await StorageManager.updateLocale(loc.id, { lifecycle: 'deprecated' });
                  cascaded++;
                }
              }
            } catch (e) {
              Logger.warn('background', `SET_GROUND_LIFECYCLE locale cascade failed: ${e.message}`);
            }
          }
          broadcastStorageChanged('ground', groundId, 'saved');
          sendResponse({ success: true, lifecycle: updated.metadata?.lifecycle, cascadedLocales: cascaded });
        } catch (err) {
          Logger.error('background', `SET_GROUND_LIFECYCLE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.335 — LOCALE_SPEC § 12 lifecycle. Deprecate (soft-delete) /
    // reactivate a single Locale. 'deprecated' excludes it from the active
    // set + authoring; 'active' restores it.
    case 'SET_LOCALE_LIFECYCLE': {
      (async () => {
        try {
          const { localeId, lifecycle } = payload ?? {};
          if (!localeId) { sendResponse({ success: false, error: 'localeId required' }); return; }
          if (lifecycle !== 'deprecated' && lifecycle !== 'active') {
            sendResponse({ success: false, error: `lifecycle must be 'deprecated' or 'active' (got ${lifecycle})` });
            return;
          }
          const updated = await StorageManager.updateLocale(localeId, { lifecycle });
          if (!updated) { sendResponse({ success: false, error: `Locale ${localeId} not found` }); return; }
          broadcastStorageChanged('locale', localeId, 'saved');
          sendResponse({ success: true, lifecycle: updated.lifecycle });
        } catch (err) {
          Logger.error('background', `SET_LOCALE_LIFECYCLE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.336 — LOCALE_SPEC § 3/§ 13: LLM proposes a structured composition
    // (LandmarkNode[] + groupings/sequences) over the locale's already-picked
    // landmarks. The author reviews/keeps it. Stateless — takes the landmarks
    // in the payload (they live in the unsaved draft).
    case 'PROPOSE_LOCALE_STRUCTURE': {
      (async () => {
        try {
          // v2.74.347 — `priorStructure` (the reviewed structure + judgments)
          // turns this into a refine call; absent on a first proposal.
          const { name, description, landmarks, priorStructure } = payload ?? {};
          const structure = await AnthropicService.proposeLocaleStructure({ name, description, landmarks, priorStructure });
          if (!structure) {
            sendResponse({ success: false, error: 'No structure returned (LLM unavailable, or no landmarks with UIDs to structure)' });
            return;
          }
          sendResponse({ success: true, structure });
        } catch (err) {
          Logger.error('background', `PROPOSE_LOCALE_STRUCTURE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'EXTRACT_STRATEGY_PARAMS': {
      (async () => {
        try {
          // v2.74.114 — Validate up front so a missing payload doesn't
          // produce an opaque destructure-failure error.
          const { capabilityId, question } = payload ?? {};
          if (!capabilityId) {
            sendResponse({ success: false, error: 'capabilityId required' });
            return;
          }
          if (typeof question !== 'string') {
            sendResponse({ success: false, error: 'question required' });
            return;
          }
          const strategy = await StorageManager.getStrategy(capabilityId);
          if (!strategy) {
            sendResponse({ success: false, error: 'Strategy not found' });
            return;
          }
          const paramNames = Array.isArray(strategy.params) ? strategy.params : [];
          const result = await AnthropicService.extractStrategyParams({
            question,
            strategyName : strategy.name ?? '',
            strategyGoal : strategy.goal ?? '',
            paramNames,
          });
          sendResponse({ success: true, params: result.params, missing: result.missing });
        } catch (err) {
          Logger.error('background', `EXTRACT_STRATEGY_PARAMS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.25.3 — Probe a set of conditions against the current active tab.
    // Used by the Fragment edit panel's "Test on current tab" button so the
    // user can see which of their postconditions currently hold.
    case 'PROBE_CONDITIONS': {
      (async () => {
        try {
          const conditions = Array.isArray(payload?.conditions) ? payload.conditions : [];
          if (conditions.length === 0) {
            sendResponse({ success: true, results: [] });
            return;
          }
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) {
            sendResponse({ success: false, error: 'No active tab' });
            return;
          }
          // Probe each condition individually so we can report per-condition result
          const results = [];
          for (const cond of conditions) {
            const probe = await new Promise(r => {
              chrome.tabs.sendMessage(tab.id, { type: 'CHECK_CONDITION', payload: { condition: cond } }, (res) => {
                if (chrome.runtime.lastError) {
                  r({ matched: false, error: chrome.runtime.lastError.message });
                } else {
                  r(res ?? { matched: false, error: 'no response from content script' });
                }
              });
            });
            results.push({
              condition: cond,
              matched: probe?.matched === true,
              reason: probe?.matched === true ? null : (probe?.error ?? 'condition not met'),
            });
          }
          sendResponse({ success: true, results });
        } catch (err) {
          Logger.error('background', `PROBE_CONDITIONS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'CAPABILITY_INVOKE': {
      (async () => {
        try {
          // v2.74.114 — Validate capabilityId up front.
          const { capabilityId, input, invocationId, debug, conversationId } = payload ?? {};
          if (!capabilityId) {
            sendResponse({ success: false, error: 'capabilityId required' });
            return;
          }
          // v2.38.0 (Pass K1) — pass debug option through to CapabilityAPI.
          // v2.71.4 — pass conversationId so terminal events can route back
          // to ConversationStore even when chat panel is closed.
          const result = await CapabilityAPI.invoke(capabilityId, input ?? {}, { invocationId, debug, conversationId });
          sendResponse({ success: true, ...result });
        } catch (err) {
          Logger.error('background', `CAPABILITY_INVOKE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'CAPABILITY_CANCEL': {
      (async () => {
        try {
          // v2.74.114 — Validate + log on failure for consistency with the
          // rest of the file's catch blocks.
          const { invocationId } = payload ?? {};
          if (!invocationId) {
            sendResponse({ success: false, error: 'invocationId required' });
            return;
          }
          const cancelled = await CapabilityAPI.cancel(invocationId);
          sendResponse({ success: true, cancelled });
        } catch (err) {
          Logger.error('background', `CAPABILITY_CANCEL failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.51 (Stage 2) — OPEN_DEBUGGER_PANEL now opens the unified
    // sidepanel.html and sets strategy-debug mode. Kept under the old
    // message name for callers that haven't migrated yet (e.g.,
    // chat.js's "open debugger" link).
    case 'OPEN_DEBUGGER_PANEL': {
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = payload?.tabId ?? tab?.id;
          if (tabId == null) { sendResponse({ success: false, error: 'no tab' }); return; }
          await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
          await chrome.sidePanel.open({ tabId });
          __setSidepanelMode('strategy-debug', null);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'OPEN_CHAT_PANEL': {
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = payload?.tabId ?? tab?.id;
          if (tabId == null) { sendResponse({ success: false, error: 'no tab' }); return; }
          await chrome.sidePanel.setOptions({ tabId, path: 'chat.html', enabled: true });
          await chrome.sidePanel.open({ tabId });
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.39.3 — On debugger boot, look up any currently-running debug
    // invocation so the panel can attach to it even if it missed the
    // INVOCATION_STARTED broadcast (race when studio ▶ opens the panel
    // and fires the invocation in quick succession).
    case 'GET_ACTIVE_DEBUG_INVOCATION': {
      (async () => {
        try {
          const list = await CapabilityAPI.listInvocations();
          // Find a running or queued debug-mode invocation, most recent first
          const candidates = (list ?? [])
            .filter(r => r.debugMode && r.debugMode !== 'off')
            .filter(r => r.status === 'running' || r.status === 'queued')
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
          const top = candidates[0];
          if (!top) { sendResponse({ success: true, invocation: null }); return; }
          sendResponse({
            success: true,
            invocation: {
              invocationId   : top.invocationId,
              capabilityId   : top.capabilityId,
              capabilityName : top.capabilityName,
              debugMode      : top.debugMode,
              totalSteps     : top.progress?.total ?? 0,
            },
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.45 (Pass 17g iter) — Locale capture session, simplified.
    //
    // The session model changed: studio no longer hands off a metadata
    // draft. The user clicks "+ Locale" on a Ground card; studio sends
    // BEGIN_LOCALE_CAPTURE with just the groundId. Background:
    //   1. Refuses if any debug invocation is active OR a session is pending
    //   2. Looks up the Ground, opens its URL as the starting tab (or
    //      focuses an existing tab matching it) — user navigates from there
    //   3. Stores the session {groundId, tabId, sessionId, startedAt}
    //   4. Re-injects the content script so PING/START_PICK reach the
    //      tab without a manual reload
    //   5. Broadcasts LOCALE_CAPTURE_BEGIN_BROADCAST so the debugger
    //      sidepanel (already opened by studio in its gesture-fresh
    //      click handler) enters capture mode
    //
    // The debugger then handles authoring: name + description + URL pattern
    // (auto-synced to the active tab) + landmarks + save. After save the
    // debugger STAYS in capture mode (only name/description/landmarks
    // clear), letting the user author multiple locales for the same Ground
    // without leaving the sidepanel.
    // v2.72.50 (Stage 1) — Sidepanel mode registry handlers.
    //
    // The sidepanel shell asks on cold boot what mode to mount, and any
    // caller (studio, in-mode UI, etc.) can request a mode change here.
    // Background owns the registry; switching modes broadcasts
    // SIDEPANEL_MODE_CHANGED which the shell listens for.
    case 'GET_SIDEPANEL_MODE': {
      sendResponse({
        success: true,
        mode: __sidepanelMode,
        payload: __sidepanelModePayload,
      });
      return false;
    }
    case 'REQUEST_SIDEPANEL_MODE': {
      const { mode, payload: modePayload } = payload ?? {};
      // Allow null/undefined to mean "go idle".
      __setSidepanelMode(mode ?? null, modePayload ?? null);
      sendResponse({ success: true });
      return false;
    }
    // v2.74.36 — Shell queries this on tab activation in its window to
    // figure out what mode (if any) was previously associated with the
    // newly-active tab. Returns null when no record exists; the shell
    // falls back to ground-view for that tab.
    // v2.74.43 — Ground sidepanel's + Auto locale flow. Capture the
    // active tab's DOM, send it to Claude with a locale-identification
    // prompt, return the suggestion. The caller (ground-view) then
    // dispatches BEGIN_LOCALE_CAPTURE with the suggestion as
    // `prefilledLocale` so the user lands in a pre-filled form.
    //
    // v2.74.231 — Caching. Discovery results cache per (groundId, page
    // pathname) in chrome.storage.local under
    // `localeAutoDiscoveryCache`. The "+ Locale" button now hits cache
    // by default, only calling Claude once per (ground, sub-page);
    // the rediscover button in locale-capture passes `force: true` to
    // bypass cache and rewrite it.
    case 'AUTO_DISCOVER_LOCALE': {
      (async () => {
        try {
          const { tabId, groundId, force } = payload ?? {};
          if (typeof tabId !== 'number') {
            sendResponse({ success: false, error: 'tabId required' });
            return;
          }
          // v2.74.44 — Refuse non-http(s) tabs early — content scripts
          // can't run on chrome://, chrome-extension://, the web store,
          // etc. Surface a clearer error than the "Receiving end does
          // not exist" message chrome.tabs.sendMessage would otherwise
          // raise.
          let tabInfo;
          try {
            tabInfo = await chrome.tabs.get(tabId);
          } catch (e) {
            sendResponse({ success: false, error: `Tab not found: ${e.message}` });
            return;
          }
          const url = tabInfo?.url ?? '';
          if (!/^https?:/i.test(url)) {
            sendResponse({
              success: false,
              error: 'This page does not allow content scripts (chrome://, extension page, or restricted URL). Open a regular https:// page first.',
            });
            return;
          }
          // v2.74.231 — Cache lookup. Key normalizes URL to origin +
          // pathname (drop query + fragment) so re-visits of the
          // "same kind of page" hit cache. The user can broaden the
          // cache by passing force:true via the rediscover button.
          const cacheKey = _normalizeUrlForLocaleCache(url);
          if (!force && groundId && cacheKey) {
            const cached = await _readLocaleDiscoveryCache(groundId, cacheKey);
            if (cached?.suggestion) {
              Logger.info('background', `AUTO_DISCOVER_LOCALE cache hit (groundId=${groundId}, key=${cacheKey})`);
              sendResponse({ success: true, suggestion: cached.suggestion, fromCache: true });
              return;
            }
          }
          // v2.74.44 — Re-inject the content script before messaging.
          // The manifest's document_start auto-injection only runs on
          // fresh page loads — a tab loaded before this extension
          // session has no live listener, so chrome.tabs.sendMessage
          // throws "Receiving end does not exist". Best-effort
          // injection (mirrors BEGIN_LOCALE_CAPTURE / prepareTabFor
          // Authoring); failure is non-fatal because the existing
          // script (if any) still answers the next sendMessage.
          try {
            // v2.74.166 — allFrames: true so subsequent picker /
            // locale-capture activity reaches iframes too.
            await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              files: ['ContentScripts/contentScript.js'],
            });
          } catch (e) {
            Logger.warn('background', `AUTO_DISCOVER_LOCALE: content-script inject failed (continuing): ${e.message}`);
          }
          // Pull the rich DOM snapshot from the content script. Same
          // shape DiscoveryService uses — a sanitized representation
          // with text-bearing landmarks + interactive controls
          // (id / name / aria attrs preserved).
          let snap;
          try {
            snap = await chrome.tabs.sendMessage(tabId, { type: 'DOM_SNAPSHOT_RICH' });
          } catch (e) {
            sendResponse({ success: false, error: `DOM snapshot failed: ${e.message}` });
            return;
          }
          if (!snap?.success) {
            sendResponse({ success: false, error: snap?.error ?? 'DOM snapshot returned no payload' });
            return;
          }
          const suggestion = await AnthropicService.suggestLocale({
            url         : snap.url   ?? url,
            title       : snap.title ?? '',
            domSnapshot : snap.snapshot ?? '',
          });
          if (!suggestion) {
            sendResponse({ success: false, error: 'Claude returned no usable suggestion' });
            return;
          }
          // v2.74.231 — Persist the Claude suggestion to cache so
          // subsequent "+ Locale" clicks on the same sub-page reuse
          // it instead of re-calling Claude.
          if (groundId && cacheKey) {
            try {
              await _writeLocaleDiscoveryCache(groundId, cacheKey, { suggestion, url, capturedAt: Date.now() });
            } catch (e) {
              Logger.warn('background', `localeAutoDiscoveryCache write failed: ${e.message}`);
            }
          }
          sendResponse({ success: true, suggestion, fromCache: false });
        } catch (err) {
          Logger.error('background', `AUTO_DISCOVER_LOCALE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.348 — LOCALE_SPEC § 13 description-first proposal flow. Given the
    // user's intent (the Locale description) + the current page, Claude
    // proposes 2-3 perspective options (named roles to fill + URL predicates).
    // Mirrors AUTO_DISCOVER_LOCALE's content-script inject + DOM_SNAPSHOT_RICH,
    // but is intent-seeded and role-scaffolded, and is NOT cached (the
    // proposal depends on the free-text intent, not just the URL).
    case 'PROPOSE_LOCALE_PERSPECTIVES': {
      (async () => {
        try {
          const { tabId, intent } = payload ?? {};
          if (typeof tabId !== 'number') {
            sendResponse({ success: false, error: 'tabId required' });
            return;
          }
          if (typeof intent !== 'string' || !intent.trim()) {
            sendResponse({ success: false, error: 'Write an intent description first — it is the proposal seed.' });
            return;
          }
          let tabInfo;
          try {
            tabInfo = await chrome.tabs.get(tabId);
          } catch (e) {
            sendResponse({ success: false, error: `Tab not found: ${e.message}` });
            return;
          }
          const url = tabInfo?.url ?? '';
          if (!/^https?:/i.test(url)) {
            sendResponse({ success: false, error: 'This page does not allow content scripts (chrome://, extension page, or restricted URL). Open a regular https:// page first.' });
            return;
          }
          try {
            await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              files: ['ContentScripts/contentScript.js'],
            });
          } catch (e) {
            Logger.warn('background', `PROPOSE_LOCALE_PERSPECTIVES: content-script inject failed (continuing): ${e.message}`);
          }
          let snap;
          try {
            snap = await chrome.tabs.sendMessage(tabId, { type: 'DOM_SNAPSHOT_RICH' });
          } catch (e) {
            sendResponse({ success: false, error: `DOM snapshot failed: ${e.message}` });
            return;
          }
          if (!snap?.success) {
            sendResponse({ success: false, error: snap?.error ?? 'DOM snapshot returned no payload' });
            return;
          }
          const proposal = await AnthropicService.proposePerspectives({
            intent,
            url        : snap.url   ?? url,
            title      : snap.title ?? '',
            domSnapshot: snap.snapshot ?? '',
          });
          if (!proposal || !Array.isArray(proposal.options) || proposal.options.length === 0) {
            sendResponse({ success: false, error: 'Claude returned no usable perspectives — try a more specific intent.' });
            return;
          }
          sendResponse({ success: true, options: proposal.options });
        } catch (err) {
          Logger.error('background', `PROPOSE_LOCALE_PERSPECTIVES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.128 — GET_TAB_SIDEPANEL_MODE and the background-side
    // CLEAR_TAB_SIDEPANEL_MODE handler removed alongside the dead
    // __tabSidepanelModes map. The shell registers its own
    // CLEAR_TAB_SIDEPANEL_MODE handler in Sidepanel/shell.js that
    // updates the authoritative `_tabModes` map; callers' messages
    // still reach that handler unchanged.

    // v2.72.52 (Stage 3 / fragment-walk) — Exit to Studio.
    //
    // The intended UX commitment (v2.72.54): the cancel/close button in
    // ANY mode dismisses the sidepanel and returns focus to Studio.
    // Steps:
    //   1. Clear the active sidepanel mode (broadcast unmounts the mode)
    //   2. Disable the sidepanel on the current tab so it physically
    //      closes (Chrome has no close() API; setOptions({enabled:false})
    //      is the official mechanism)
    //   3. Find or open Studio in a tab and focus it
    //
    // The sidepanel re-enables itself the next time a launcher (Studio's
    // ▶, + Locale, Walk button) calls setOptions({enabled:true}) before
    // sidePanel.open. That setOptions call effectively re-arms the panel
    // for the relevant tab.
    case 'EXIT_TO_STUDIO': {
      (async () => {
        try {
          // v2.72.59 — Sidepanel is opened with windowId scope by all
          // launchers. Close with windowId scope to match. Mixing tabId
          // close attempts hits a different (non-existent) panel instance
          // and silently no-ops while reporting success.
          let panelWindowId = payload?.windowId ?? null;
          if (panelWindowId == null) {
            try {
              const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
              panelWindowId = activeTab?.windowId ?? null;
            } catch (_) { /* fine */ }
          }
          Logger.info('background', `EXIT_TO_STUDIO target wid:${String(panelWindowId)} payloadHas:${!!payload?.windowId}`);

          // Step 1: Clear mode (broadcasts SIDEPANEL_MODE_CHANGED → shell unmounts)
          __setSidepanelMode(null, null);

          // Step 2: Close the global sidepanel for this window.
          if (typeof chrome.sidePanel?.close === 'function' && panelWindowId != null) {
            try {
              await chrome.sidePanel.close({ windowId: panelWindowId });
              Logger.info('background', `EXIT_TO_STUDIO close-call(win) OK wid:${String(panelWindowId)}`);
            } catch (e) {
              Logger.warn('background', `EXIT_TO_STUDIO close-call(win) threw: ${e.message}`);
            }
          } else {
            Logger.warn('background', `EXIT_TO_STUDIO close-fn unavailable typeof:${typeof chrome.sidePanel?.close} wid:${String(panelWindowId)}`);
          }

          // Step 3: Focus Studio (find existing tab or open one)
          const studioUrl = chrome.runtime.getURL('studio.html');
          const tabs = await chrome.tabs.query({ url: studioUrl });
          if (tabs.length > 0) {
            const tab = tabs[0];
            await chrome.tabs.update(tab.id, { active: true });
            if (tab.windowId != null) {
              await chrome.windows.update(tab.windowId, { focused: true });
            }
          } else {
            await chrome.tabs.create({ url: studioUrl, active: true });
          }
          sendResponse({ success: true });
        } catch (err) {
          Logger.warn('background', `EXIT_TO_STUDIO failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.41 (Pass 17g) — Locale capture handoff to debugger.
    case 'BEGIN_LOCALE_CAPTURE': {
      (async () => {
        try {
          // v2.74.31 — Optional existingTabId reuses the user's current
          // tab (sidepanel-launched capture) instead of open/find-by-URL.
          // v2.74.33 — Optional returnTo decides where Save / Cancel goes.
          // v2.74.43 — Optional prefilledLocale seeds name + description
          // + landmarks (Claude-suggested via AUTO_DISCOVER_LOCALE).
          const { groundId, existingTabId = null, returnTo = null, prefilledLocale = null } = payload ?? {};
          if (!groundId) {
            sendResponse({ success: false, error: 'groundId required' });
            return;
          }
          // Refuse if a debug invocation is active.
          if (__activeInvocations.size > 0) {
            sendResponse({
              success: false,
              error: 'A strategy is currently running under the debugger. Cancel or finish it before capturing a locale.',
            });
            return;
          }
          if (__pendingLocaleCapture) {
            sendResponse({
              success: false,
              error: 'Another locale capture is already in progress. Cancel it from the debugger first.',
            });
            return;
          }

          // Look up the Ground for its URL.
          const ground = await StorageManager.getGround(groundId);
          if (!ground) {
            sendResponse({ success: false, error: `Ground ${groundId} not found` });
            return;
          }
          if (!ground.url && existingTabId == null) {
            sendResponse({ success: false, error: 'Ground has no URL — cannot open a starting tab' });
            return;
          }

          // v2.74.31 — Reuse the caller-provided tab when given; otherwise
          // find or open one matching the Ground's stored URL.
          let tabRes;
          if (existingTabId != null) {
            try { await chrome.tabs.update(existingTabId, { active: true }); } catch (e) {
              Logger.warn('background', `BEGIN_LOCALE_CAPTURE: focus tab ${existingTabId} failed: ${e.message}`);
            }
            tabRes = { ok: true, tabId: existingTabId };
          } else {
            tabRes = await __findOrOpenTabForLocale(ground.url);
          }
          if (!tabRes.ok) {
            sendResponse({ success: false, error: tabRes.error });
            return;
          }

          // Stash session.
          __pendingLocaleCapture = {
            groundId,
            tabId: tabRes.tabId,
            sessionId: `loc_cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            startedAt: Date.now(),
          };

          try {
            await chrome.sidePanel.setOptions({
              tabId: tabRes.tabId,
              // v2.72.50 (Stage 1) — use the new shell HTML. Shell will
              // route to the locale-capture mode based on the mode set
              // below. Old per-tab debugger.html assignment retired.
              path: 'sidepanel.html',
              enabled: true,
            });
          } catch (e) {
            Logger.warn('background', `BEGIN_LOCALE_CAPTURE: setOptions failed (non-fatal): ${e.message}`);
          }

          // v2.72.44 — Wait for tab complete + re-inject content script.
          // v2.74.166 — allFrames: true so locale-capture's frame-aware
          // picker broadcast actually reaches iframes (the picker now
          // routes through shared.js broadcastStartPick).
          await __waitForTabComplete(tabRes.tabId, 8000);
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tabRes.tabId, allFrames: true },
              files: ['ContentScripts/contentScript.js'],
            });
            Logger.info('background', `BEGIN_LOCALE_CAPTURE: re-injected content script into tab ${tabRes.tabId} (all frames)`);
          } catch (e) {
            Logger.warn('background', `BEGIN_LOCALE_CAPTURE: executeScript failed (continuing): ${e.message}`);
          }

          // v2.72.50 (Stage 1) — Set the sidepanel mode. The shell
          // listens for SIDEPANEL_MODE_CHANGED (broadcast by
          // __setSidepanelMode) and mounts locale-capture.js. The
          // legacy LOCALE_CAPTURE_BEGIN_BROADCAST is preserved for
          // backward compatibility with the not-yet-extracted
          // debugger.html flows in the interim.
          __setSidepanelMode('locale-capture', {
            groundId,
            tabId: tabRes.tabId,
            sessionId: __pendingLocaleCapture.sessionId,
            returnTo,
            prefilledLocale,
          });
          chrome.runtime.sendMessage({
            type: 'LOCALE_CAPTURE_BEGIN_BROADCAST',
            payload: {
              session: __pendingLocaleCapture,
            },
          }).catch(() => { /* no listeners is fine */ });

          sendResponse({
            success: true,
            tabId: tabRes.tabId,
            sessionId: __pendingLocaleCapture.sessionId,
          });
        } catch (err) {
          Logger.error('background', `BEGIN_LOCALE_CAPTURE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'GET_PENDING_LOCALE_CAPTURE': {
      // Synchronous reply — debugger polls this on boot. No async work.
      sendResponse({
        success: true,
        session: __pendingLocaleCapture ? { ...__pendingLocaleCapture } : null,
      });
      return false;
    }

    case 'CANCEL_LOCALE_CAPTURE': {
      // Clear pending session. Used when:
      //  - debugger commits a save (followup after SAVE_LOCALE success)
      //  - user explicitly cancels in the debugger
      //  - studio cancels its handoff
      const cleared = __pendingLocaleCapture;
      __pendingLocaleCapture = null;
      Logger.info('background', `CANCEL_LOCALE_CAPTURE: cleared session`, {
        hadSession: !!cleared,
        sessionId: cleared?.sessionId,
      });
      // v2.72.50 (Stage 1) — also clear the sidepanel mode if the
      // current mode is locale-capture. The shell unmounts and shows
      // idle. (If the user already switched to a different mode, leave
      // that mode alone.)
      if (__sidepanelMode === 'locale-capture') {
        __setSidepanelMode(null, null);
      }
      sendResponse({ success: true, hadSession: !!cleared });
      return false;
    }

    // v2.49.0 — Look up a specific invocation by id, regardless of status.
    // Used by the debugger to adopt invocations whose `started` event was
    // missed (cold-start race after extension reload). Returns the same
    // metadata shape as GET_ACTIVE_DEBUG_INVOCATION but doesn't filter by
    // status, so a failed/completed invocation can still be adopted for
    // display purposes.
    case 'GET_DEBUG_INVOCATION_BY_ID': {
      const invocationId = message.payload?.invocationId;
      if (!invocationId) {
        sendResponse({ success: false, error: 'invocationId required' });
        return false;
      }
      (async () => {
        try {
          const list = await CapabilityAPI.listInvocations();
          const found = (list ?? []).find(r => r.invocationId === invocationId);
          if (!found) { sendResponse({ success: true, invocation: null }); return; }
          sendResponse({
            success: true,
            invocation: {
              invocationId   : found.invocationId,
              capabilityId   : found.capabilityId,
              capabilityName : found.capabilityName,
              debugMode      : found.debugMode,
              totalSteps     : found.progress?.total ?? 0,
              status         : found.status,
            },
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.38.0 (Pass K1) — debug control message handlers. Synchronous
    // setters on the invocation record; the running engine polls and
    // responds at its next yield-point.
    // v2.74.114 — All six sync handlers now wrap their body in try/catch.
    // Pre-fix, any throw inside the call (including the trivial case of
    // `payload` being null/undefined) skipped sendResponse entirely; the
    // channel closed with no response and the caller's ChatAPI promise
    // had to wait out the 60s timeout introduced in v2.74.112 to recover.
    // Now: a real error response is sent immediately on failure.
    case 'CAPABILITY_DEBUG_RESUME': {
      try {
        const ok = CapabilityAPI.debugResume(payload?.invocationId);
        sendResponse({ success: ok });
      } catch (err) {
        Logger.error('background', `CAPABILITY_DEBUG_RESUME failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
    case 'CAPABILITY_DEBUG_STEP': {
      try {
        const ok = CapabilityAPI.debugStep(payload?.invocationId);
        sendResponse({ success: ok });
      } catch (err) {
        Logger.error('background', `CAPABILITY_DEBUG_STEP failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
    case 'CAPABILITY_DEBUG_PAUSE': {
      try {
        const ok = CapabilityAPI.debugPause(payload?.invocationId);
        sendResponse({ success: ok });
      } catch (err) {
        Logger.error('background', `CAPABILITY_DEBUG_PAUSE failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    case 'CAPABILITY_GET_INVOCATION': {
      try {
        const snapshot = CapabilityAPI.getInvocation(payload?.invocationId);
        sendResponse({ success: true, invocation: snapshot });
      } catch (err) {
        Logger.error('background', `CAPABILITY_GET_INVOCATION failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    case 'CAPABILITY_LIST_INVOCATIONS': {
      try {
        const list = CapabilityAPI.listInvocations(payload ?? {});
        sendResponse({ success: true, invocations: list });
      } catch (err) {
        Logger.error('background', `CAPABILITY_LIST_INVOCATIONS failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    case 'CAPABILITY_CAPACITY': {
      try {
        const cap = CapabilityAPI.getCapacityStatus();
        sendResponse({ success: true, capacity: cap });
      } catch (err) {
        Logger.error('background', `CAPABILITY_CAPACITY failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    // v2.74.22 — APPROVE_STEP handler removed. AI-walked path is gone.

    // ── Template JSON edit (paste-and-save from UI) ───────────────────────────


    case 'START_DISCOVERY': {
      (async () => {
        // v2.74.41 — existingTabId lets the Ground sidepanel run
        // discovery against the user's current tab instead of opening
        // a dedicated background tab.
        const { groundId, existingTabId = null } = payload;
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        if (discoveryAbortFlags.has(groundId)) {
          sendResponse({ success: false, error: 'Discovery already running for this ground' });
          return;
        }
        discoveryAbortFlags.set(groundId, false);
        Logger.info('background', `START_DISCOVERY — ground ${groundId}${existingTabId != null ? ` (reuse tab ${existingTabId})` : ''}`);

        // Fire-and-forget: broadcast progress and final result; return immediately
        sendResponse({ success: true, started: true });
        (async () => {
          try {
            const { groundMap, error, aborted } = await DiscoveryService.discover({
              groundId,
              existingTabId,
              onProgress: (progress) => {
                chrome.runtime.sendMessage({
                  type: 'DISCOVERY_PROGRESS',
                  payload: { groundId, ...progress },
                }).catch(() => {});
              },
              isAborted: () => discoveryAbortFlags.get(groundId) === true,
            });
            if (error) {
              chrome.runtime.sendMessage({
                type: 'DISCOVERY_FAILED',
                payload: { groundId, error },
              }).catch(() => {});
            } else {
              chrome.runtime.sendMessage({
                type: 'DISCOVERY_COMPLETE',
                payload: { groundId, pageCount: groundMap.pages.length, groundMap, aborted: !!aborted },
              }).catch(() => {});
            }
          } catch (err) {
            Logger.error('background', `Discovery unhandled: ${err.message}`);
            chrome.runtime.sendMessage({
              type: 'DISCOVERY_FAILED',
              payload: { groundId, error: err.message },
            }).catch(() => {});
          } finally {
            discoveryAbortFlags.delete(groundId);
          }
        })();
      })();
      return true;
    }

    case 'ABORT_DISCOVERY': {
      const { groundId: abortId } = payload;
      if (discoveryAbortFlags.has(abortId)) {
        discoveryAbortFlags.set(abortId, true);
        Logger.info('background', `Discovery abort requested for ground ${abortId}`);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No active discovery for this ground' });
      }
      return false;
    }

    case 'GET_SETTING': {
      const { key, defaultValue } = payload;
      chrome.storage.local.get(`settings:${key}`, (data) => {
        const val = data[`settings:${key}`];
        sendResponse({ value: val !== undefined ? val : defaultValue });
      });
      return true;
    }

    case 'SET_SETTING': {
      const { key, value } = payload;
      chrome.storage.local.set({ [`settings:${key}`]: value }, () => {
        Logger.info('background', `Setting saved: ${key} = ${JSON.stringify(value)}`);
        sendResponse({ success: true });
      });
      return true;
    }

    // ── Side panel mode switch ─────────────────────────────────────────────────
    // v2.27.0 — SET_PANEL_MODE removed. sidepanel.html no longer exists;
    // chat.html is the sole side-panel target. If something tries to send this
    // message it falls through to the default handler (unknown type warning).

    // ── API key ───────────────────────────────────────────────────────────────
    case 'SET_API_KEY':
      AnthropicService.saveApiKey(payload.key)
        .then(() => { Logger.info('background', 'API key updated'); sendResponse({ success: true }); })
        .catch(e => { Logger.error('background', `SET_API_KEY: ${e.message}`); sendResponse({ success: false, error: e.message }); });
      return true;

    case 'GET_API_KEY':
      AnthropicService.getApiKey()
        .then(key => sendResponse({ key: key ? '••••' + key.slice(-4) : null }))
        .catch(() => sendResponse({ key: null }));
      return true;

    case 'CHECK_API_KEY':
      AnthropicService.getApiKey()
        .then(key => sendResponse({ hasKey: !!key }))
        .catch(() => sendResponse({ hasKey: false }));
      return true;

    // ── Data ──────────────────────────────────────────────────────────────────


    case 'GET_LOGS':
      Logger.getPersistedLogs().then(entries => sendResponse({ entries })).catch(() => sendResponse({ entries: [] }));
      return true;

    case 'CLEAR_LOGS':
      Logger.clearLogs().then(() => { Logger.info('background', 'Logs cleared'); sendResponse({ success: true }); }).catch(() => sendResponse({ success: false }));
      return true;


    case 'GET_ALL_PROFILES':
      StorageManager.getAllProfiles().then(profiles => sendResponse({ profiles })).catch(() => sendResponse({ profiles: [] }));
      return true;

    case 'GET_PROMPTS':
      sendResponse({ prompts: AnthropicService.getPromptTexts() });
      return false;


    case 'LOG_ENTRY':
    case 'WALK_PROGRESS':
      return false;

    default:
      Logger.debug('background', `Unhandled: ${type}`);
      return false;
  }
});

// ── Profiling pass ────────────────────────────────────────────────────────────

/**
 * Runs the capability profiling pass on an already-open walk tab.
 * Executes N questions sequentially through the confirmed path, capturing
 * each response and building a structured capability profile progressively.
 *
 * Fires lazily after walk completion — background.js calls this without awaiting
 * so the user receives the "template ready" response immediately.
 *
 * @param {Object} options
 * @param {string} options.groundId
 * @param {string} options.groundUrl
 * @param {string} options.aiName
 * @param {number} options.tabId       - The open tab from the walk.
 * @param {Object} options.template    - The saved template with meta + anchors.
 */

Logger.info('background', 'Agent HUB service worker ready');
