// background/handlers/sg.js
//
// SG (substrate-grounded capability) message handlers, extracted from background.js's monolithic switch
// behind a registry (code_review_2.74.605 §5 R1 seed). All five capability-lifecycle handlers live here:
// RUN_SG_TRIAL, ACCEPT_SG_TRIAL, REPLAY_SG_CAPABILITY, GET_SG_CAPABILITIES, REJECT_SG_TRIAL.
//
// Contract: each handler is `async (payload, sender, sendResponse) => void` and calls sendResponse itself
// (verbatim with the original switch bodies, so behaviour is unchanged). The registry dispatch keeps the
// async `return true` and provides a `.catch` safety net. Stable Core/Services modules are imported here;
// background-LOCAL helpers (used by non-SG code too, or holding the SG storage keys) arrive via `ctx`.

import * as Outcomes from '../../Core/outcomes.js';
import { Logger } from '../../Core/Logger.js';
import { coverComplete } from '../../Core/cover.js';
import { selectionToTrialRoles } from '../../Core/bind.js';
import { lowerToTier2, orderForRun, scoreTier2, topoOrder } from '../../Core/tier2Lower.js';
import { evaluatePostcondition } from '../../Core/postcondition.js';
import { focusDecision, FOCUS_SETTING_KEY } from '../../Core/focusGrammar.js';   // FM-1 (v2.74.968) — the pure focus-grab verdict
import { buildAcceptance, landmarkRefActions, buildLandmarkRecords, buildPerspectiveRecord, buildResultsLandmarkRecord, buildOutcomePerspective, findMatchingPerspective, buildPerspectiveGate, buildDestinationPerspective, pickDestinationLandmark, validateConditionRefs } from '../../Core/accept.js';
import { authoringCoverage } from '../../Core/select.js';   // GA-7 — Locale→capability "done" signal
import * as CapabilitySynth from '../../Core/capabilitySynth.js';
import { synthesizeTrialOp } from '../../Core/trialSynth.js';
import { coalesce } from '../../Core/observedTrace.js';                 // OBS-3 — derive a capability from a demonstration
import { segmentTrace, opToPhases, deriveObservedParams, parameterizeObserved, describeTraceInput, derivePhasePostcondition, reconcileObservedLandmarks } from '../../Core/observedSegment.js';
import { listLocales } from '../../Services/Storage/GroundAssetStore.js';   // OBS (v2.74.764) — reconcile observed landmarks to grounded Locale features
import { toCandidate, scopeAndPartition, rankAndDecide, scoresToScorer, validateBindings, normalizeAliasPhrase, accreteAlias, removeAlias, tallyCapabilityConfirmations, localeAffordanceLabels, isOrphanCapability, findDuplicateCapabilities } from '../../Core/orchMatch.js';   // ORCH-M0/D/M/G/A; GA-6 dedup
import { findDuplicateGroundGroups, planGroundMerge, primaryHost, siteIdentity, planEnsureGround } from '../../Core/groundDedup.js';   // v2.74.816/.817 — duplicate-Ground detect + merge; .835 — registrable brand for site-name matching; G1 — dedup-before-mint plan
import { GroundManager } from '../../Core/GroundManager.js';   // G1 — auto-ground mint (dedup-before-mint entrypoint)
import { groundReadiness } from '../../Core/groundReadiness.js';   // G1-3 — Ground readiness (empty|preparing|capable|rich)
import { buildIntentMenu } from '../../Core/intentMenu.js';   // IM-1 — "what can I do here?" menu (taught + teachable + cold)
import { buildIntentContext, renderIntentContext, intentContextFingerprint, validateRichIntents } from '../../Core/intentContext.js';   // RI-1/2 — composer context pack + cite-or-reject gate
import { siteMapCapabilities } from '../../Core/siteMap.js';   // IM-2 — site-wide goal catalog (prevalence) for the menu
import { buildInteractionDemand } from '../../Core/interactionDemand.js';   // C1 — monitoring demand set (which landmarks/kinds to watch)
import { makeRawInteraction, toCaptureTargets } from '../../Core/interactionCapture.js';   // C2 — shape/validate raw interaction; enrich demand w/ selectors
import { withTrack, MONITOR_CONSENT_DEFAULT, canTrack } from '../../Core/monitorConsent.js';   // C6 — Track consent gate (default-deny)
import { resolveInteraction } from '../../Core/interactionResolve.js';   // C3 — assemble the ResolvedInteraction (L1)
import { classifyResolved } from '../../Core/interactionClassification.js';   // C0 — classify the ResolvedInteraction (L2)
import * as InteractionTrace from '../../Core/interactionTrace.js';   // C4 — L3 recorder (session ring of ClassifiedInteractions)
import { listActivePerspectives } from '../../Services/PerspectivePredicates.js';   // C3 — active-perspective context for resolution
import { listLandmarksForGround } from '../../Services/LandmarkResolver.js';   // C1 — accepted-Perspective landmarks (+ a11yRole)
import { matchGroundForUrl } from '../../Core/GroundMatcher.js';   // v2.74.823 — canonical URL→Ground matcher (honors urlPatterns, incl. the sibling hosts a dedup merge unions)
import { planCorrection, applyRetraction, isActiveCapability } from '../../Core/orchFeedback.js';   // ORCH-FB — corrective actions
import { feedbackExamples } from '../../Core/feedbackLearn.js';   // ORCH-FB-2 — relevance shaping from feedback history
import { buildObservationCapability, scoreObservationMatch, classifyReadAsk } from '../../Core/observe.js';   // OBS-READ — observation records + manual-obs match + read/action effect scoping
import { buildCompositeCapability, liftControlFlow, liftConditional } from '../../Core/orchChain.js';   // ORCH-X T2 — composite promotion + ORCH-L control-flow lift + ORCH-A conditional lift
import { route } from '../../Core/route.js';   // R-1 — front-door router cascade (alias → retrieve → LLM → trial)
import { retrieveTools } from '../../Core/toolRetrieval.js';   // R-2 — tool-RAG candidate palette (+ sanitize/provenance)
import { bindShape, lexicalScore } from '../../Core/orchBind.js';   // ORCH-CB — per-slot effect-scoped binder (lexical floor)
import { comprehend } from '../../Core/orchComprehend.js';   // ORCH-CB — substrate-free shape comprehension (shadow)
import { shadowCompare } from '../../Core/orchShadow.js';   // ORCH-CB — LLM-plan vs comprehend→bind divergence log
import { performImageFull } from '../../Services/ImageReadCapture.js';   // ORCH-CB — visual observation (screenshot)
import { buildVisualObservation, isVisualObservation, visualToInput, describeForCondition, withCriteria } from '../../Core/orchVisual.js';   // ORCH-CB — visual observation floor
import { buildCompositeTemplate, matchTemplate, rebindSteps } from '../../Core/orchTemplate.js';   // ORCH-X T2 — cross-argument composite rebind
import { validatePlan } from '../../Core/orchPlan.js';   // ORCH-L — structural guard for a lifted (foreach/gate) plan
import { promoteComposite, buildConvergeObservationRecord } from '../../Core/orchPromote.js';   // CONVERGE — T2 composite IR → canonical runnable Strategy (Studio-visible)
import { buildGroundCatalog, resolveGround, pickValidGround } from '../../Core/groundCatalog.js';   // T3X-1 — the global Ground catalog + ground resolution (intent → which site); pickValidGround validates the LLM escalation (Q2)
import { buildWorkflowRecord, wireCrossGroundData, buildGapRepairs } from '../../Core/tier3.js';   // T3X-2 — cross-Ground lowering + the data-flow floor (literals/scopeReads); buildGapRepairs turns unbound sub-intents into repair hints (Q3)
import { AnthropicService } from '../../Services/AnthropicService.js';
import { StorageManager } from '../../Services/StorageManager.js';
import { ExecutionEngine } from '../../Services/ExecutionEngine.js';
import { isHybridSyncActive, forceResyncRecord, enqueueGroundTreeDelete, scheduleSyncRun } from '../../Services/Sync/SyncEngine.js';   // v2.74.822 — merge↔cloud-sync reconciliation (force-push canonical, tombstone absorbed)

// T3X-2 — bind a cross-Ground sub-intent to a STRATEGY on its resolved Ground. Reuses the within-Ground matcher
// (toCandidate → rankAndDecide) over that Ground's matcher-store capabilities, scoped to Strategies (a `workflow`
// step dispatches a Strategy by id). Returns { capabilityId, capabilityName, params } or null (a gap). Async I/O
// glue over the tested pure cores (groundCatalog/tier3); not unit-tested (LLM/storage path — verify live).
// A friendly site label for the chat card: the Ground's stored name UNLESS it is generic/empty ("Ground"), in which
// case derive it from the host ("indeed.com" → "Indeed"). The cross-Ground card was unreadable ("· on Ground" for
// every step) when grounding never named the site. PURE.
// C2b/C3 — active interaction-monitor sessions: tabId → { groundId }. Set by INTERACTION_MONITOR_START,
// read by INTERACTION_RAW (to resolve the captured event's Ground without a per-event getAllGrounds),
// cleared by STOP. Module-scope so it survives across handler invocations.
const _interactionSessions = new Map();

// C4 (v2.74.892) — the session interaction TRACE (L3): every classified event appends here (ring, cap 500).
// THE stream the monitoring phase exists to produce — Interpret subscribes to this, never the DOM. Read via
// GET_INTERACTION_TRACE. In-memory by design (v1): cleared on an MV3 SW restart; durable persistence is the
// C5 outcomes adapter's job. Value-free end-to-end (the C2a privacy invariant holds through C0).
const _interactionTrace = InteractionTrace.makeTrace();

// C5 (v2.74.893) — durable OUTCOMES flush. Substrate-tier usage flows to the per-Ground outcomes stream as
// AGGREGATED `op:'user-interaction'` events (eventsFromEntries) — batched every FLUSH_EVERY interactions so
// chrome.storage isn't written per keystroke, force-flushed on INTERACTION_MONITOR_STOP. The high-water mark
// is the trace seq (monotonic across ring trims). A SW restart loses at most one unflushed batch (v1).
const TRACE_FLUSH_EVERY = 25;
let _traceFlushedSeq = 0;
let _traceFlushing = false;

// RI-2 (v2.74.897) — composed rich-intent cache, keyed by the PACK FINGERPRINT (hash of the rendered
// prompt context). The key only changes when the PROMPT-VISIBLE substrate changes (new capability/goal/
// vocab/coverage), so the LLM composes once per substrate state — the menu stays warm-path cheap. Bounded
// FIFO; in-memory (a SW restart re-composes once).
const RICH_INTENT_CACHE_CAP = 24;
const _richIntentCache = new Map();   // fingerprint → { intents, rejected, at }

// v2.74.908 — tabs with an ENGINE RUN in flight. The Track monitor must not record the bot's OWN synthetic
// clicks as user interactions: the 22:58 trace logged 46+ INTERACTION events from a 13× replay loop — ring
// flood (evicted every decision line) and, worse, the C5 flush would credit BOT actions to landmark "usage".
// REPLAY marks its tab busy for the run's duration; INTERACTION_RAW drops busy-tab events. (Sequential
// loops re-add/delete the same id — a plain Set suffices; overlapping runs on one tab don't happen today.)
// v2.74.922 (CR-M1) — REFCOUNTED (was a plain Set): the chat stays interactive during a minutes-long
// EXPLORE, so an alias-hit REPLAY on the same tab could finish first and its unmark re-enabled monitor
// capture for the REST of the sweep — the .908/.911/.912 self-capture bug re-opened by overlap. Map
// tabId → depth; the tab is engine-busy while depth > 0; increments/decrements are symmetric so nested
// marking (e.g. RUN_SG_TRIAL wrapping _runTrialBundle, both marked) is correct by construction.
const _engineBusyTabs = new Map();

// v2.74.911 — shared with background.js: the EXPLORE poke sweep is engine activity too (the 23:29 trace
// captured the sweep's own pokes as user interactions #1-#4 on the freshly minted Indeed ground).
// R-6 (v2.74.958) — the ROUTE_ASK warm-path decision cache (DESIGN_llm_front_door §3.4): key =
// normalized ask + groundId + the FUZZY page key (origin+path via ctx.normalizeUrl — deliberately NOT an
// exact DOM hash). Only CONFIDENT actionable decisions (primitive/replay/decompose) are stored;
// demonstrate/clarify are NEVER cached, so a just-taught capability is never masked by a stale miss. A
// cached selection gone wrong fails loudly downstream — §3.5: don't force the cache; the trial gate owns
// wrongness. SW-lifetime (a worker restart clears it — acceptable), short TTL, bounded size.
const _routeCache = new Map();
const ROUTE_CACHE_TTL_MS = 5 * 60 * 1000;   // the C3 spec-cache precedent: page-state-specific, minutes not hours
const ROUTE_CACHE_MAX = 200;
const _routeCacheKey = (ask, groundId, pageKey) =>
  `${String(ask).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300)}::${groundId || ''}::${pageKey || ''}`;

export function markEngineBusy(tabId, busy) {
  if (typeof tabId !== 'number') return;
  const depth = (_engineBusyTabs.get(tabId) || 0) + (busy ? 1 : -1);
  if (depth > 0) _engineBusyTabs.set(tabId, depth); else _engineBusyTabs.delete(tabId);
}

// FM-1 (v2.74.968) — the ONE focus-grab implementation: policy (Core/focusGrammar.focusDecision) +
// mechanics + the `FOCUS ▸` trace line, so gl can audit yanking like everything else. Tab focus is
// gesture-free (unlike sidePanel.open), so the discipline lives entirely here: REQUIRED grabs (a walk
// teach step — pickers/demos/replays drive the ACTIVE tab) always land; COURTESY grabs (run done/failed
// on a background tab) obey the 'autoFocus' setting (auto | ask | never; 'ask' defers until FM-2's
// soft-invite ships). Already-active (tab active AND its window focused) is always a quiet no-op.
// Exported for in-SW callers (workflowDebug's run-terminal wiring); chat reaches it via FOCUS_TAB.
export async function focusTabPolicy({ tabId, reason = 'unspecified', required = false } = {}) {
  if (typeof tabId !== 'number') return { success: false, error: 'tabId required' };
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* gone */ }
  if (!tab) { Logger.debug('background', `FOCUS ▸ tab ${tabId} (${reason}) → gone`); return { success: false, error: 'tab gone' }; }
  let winFocused = false;
  try { const w = await chrome.windows.get(tab.windowId); winFocused = !!(w && w.focused); } catch { /* */ }
  let setting = 'auto';
  try {
    const data = await chrome.storage.local.get(`settings:${FOCUS_SETTING_KEY}`);
    if (typeof data[`settings:${FOCUS_SETTING_KEY}`] === 'string') setting = data[`settings:${FOCUS_SETTING_KEY}`];
  } catch { /* default auto */ }
  const verdict = focusDecision(setting, { required, alreadyActive: !!tab.active && winFocused });
  if (verdict === 'focus') {
    try {
      await chrome.tabs.update(tabId, { active: true });
      // Cross-window: focus the tab's window too. If Chrome itself isn't the OS-foreground app the OS
      // may downgrade this to a taskbar flash — that's the OS protecting the user; accept it.
      if (typeof tab.windowId === 'number') { try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* */ } }
      Logger.info('background', `FOCUS ▸ tab ${tabId} (${reason}) → focused${required ? ' [required]' : ''}`);
      return { success: true, focused: true, verdict };
    } catch (e) {
      Logger.warn('background', `FOCUS ▸ tab ${tabId} (${reason}) → FAILED: ${e.message}`);
      return { success: false, error: e.message, verdict };
    }
  }
  if (verdict === 'skip-active') {
    Logger.debug('background', `FOCUS ▸ tab ${tabId} (${reason}) → already-active`);
    return { success: true, focused: false, verdict };
  }
  Logger.info('background', `FOCUS ▸ tab ${tabId} (${reason}) → ${verdict === 'deferred-ask' ? 'deferred (setting=ask; FM-2 invite pending)' : 'suppressed (setting=never)'}`);
  return { success: true, focused: false, verdict };
}

// v2.74.933 (CR-M3) — a closed tab never leaves stale entries (Chrome recycles tab ids, so a stale
// session could mis-ground a NEW tab's events, and a stale busy depth could mute a new tab's monitor).
try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    _interactionSessions.delete(tabId); _engineBusyTabs.delete(tabId);
    // v2.74.1008 — evict any ground→tab reuse entry pointing at the closed tab (best-effort; find-time
    // validation also catches a gone tab, so this is just storage hygiene).
    try { chrome.storage?.session?.get(null, (all) => { void chrome.runtime.lastError; const rm = Object.keys(all || {}).filter((k) => k.startsWith('groundTab:') && all[k] === tabId); if (rm.length) chrome.storage.session.remove(rm); }); } catch { /* */ }
  });
} catch { /* non-extension context (unit tests import this module's siblings only) */ }

// ── Ground→tab reuse (v2.74.1008) — "a YouTube intent opens a NEW tab instead of reusing the existing
// one." There was NO ground→tab mapping anywhere: every replay/workflow step opened a fresh tab on the
// ground URL. POLICY (user-chosen): reuse ONLY tabs ORCHARD itself created for a ground — never a tab the
// user opened by hand. A session-backed `groundTab:<id>` → tabId map records orchard's own ground tabs;
// chrome.storage.session is the right lifetime (survives an MV3 SW restart, auto-clears on browser close —
// a tab id is meaningless across browser restarts). The tab analog of ensureGroundForUrl (reuse-before-open).
const _GROUND_TAB_KEY = (gid) => `groundTab:${gid}`;
// v2.74.1012 — DURABLE provenance marker (chrome.storage.local, survives a browser restart): the last URL
// orchard's tab for this ground was known to be at. It serves TWO purposes across a restart, which clears
// the session map AND reassigns every tab id (so the stored tabId is a dead number — persisting IT would
// be useless): (1) its mere EXISTENCE = "orchard has owned a tab for this ground before", which is what
// gates cold-start ADOPTION (so a hand-opened tab for a ground orchard never touched is still never
// adopted); (2) its VALUE lets adoption prefer the tab whose url EXACTLY matches — almost certainly
// orchard's own RESTORED tab, not a coincidental user tab. Tab ids can't survive a restart; a ground's
// last URL can, and reconciling it against LIVE tabs is the only thing that actually recovers reuse.
const _GROUND_URL_KEY = (gid) => `groundLastUrl:${gid}`;
const _slug6 = (gid) => String(gid).slice(-6);

async function _recordGroundTab(groundId, tabId, url) {
  if (!groundId || typeof tabId !== 'number') return;
  try { await chrome.storage?.session?.set({ [_GROUND_TAB_KEY(groundId)]: tabId }); } catch { /* */ }
  if (url) { try { await chrome.storage?.local?.set({ [_GROUND_URL_KEY(groundId)]: String(url) }); } catch { /* */ } }
}
async function _getGroundLastUrl(groundId) {
  if (!groundId || !chrome.storage?.local) return '';
  try { const v = (await chrome.storage.local.get(_GROUND_URL_KEY(groundId)))[_GROUND_URL_KEY(groundId)]; return typeof v === 'string' ? v : ''; } catch { return ''; }
}

// A REUSABLE orchard-created tab for the ground (within-session, strict), or null. Validates: the tab still
// EXISTS, its CURRENT url still maps to THIS ground (the user may have navigated it away — then it's no
// longer ours), and it isn't engine-busy (no collision). Refreshes the durable last-URL marker on a hit so
// it tracks the tab's drift. Evicts a genuinely-stale session entry.
async function _findReusableGroundTab(groundId) {
  if (!groundId || !chrome.storage?.session) return null;
  let tabId = null;
  try { tabId = (await chrome.storage.session.get(_GROUND_TAB_KEY(groundId)))[_GROUND_TAB_KEY(groundId)]; } catch { return null; }
  if (typeof tabId !== 'number') return null;
  if (_engineBusyTabs.has(tabId)) return null;   // busy — don't collide (still ours; don't evict)
  const evict = async () => { try { await chrome.storage.session.remove(_GROUND_TAB_KEY(groundId)); } catch { /* */ } };
  let url = '';
  try { url = (await chrome.tabs.get(tabId))?.url || ''; } catch { await evict(); return null; }   // tab gone
  try {
    const grounds = await StorageManager.getAllGrounds();
    if (_groundIdForUrl(url, grounds) !== groundId) { await evict(); return null; }   // navigated away — no longer ours
  } catch { return null; }
  if (url) { try { await chrome.storage?.local?.set({ [_GROUND_URL_KEY(groundId)]: url }); } catch { /* */ } }   // keep the marker fresh
  return tabId;
}

// COLD-START ADOPTION (v2.74.1012) — recover reuse across a browser restart, where the session map is gone
// and tab ids are reassigned. Fires ONLY when the durable marker exists (orchard has owned a tab for this
// ground before — so a never-touched ground's user tab is still not adopted). Scans LIVE tabs for one on
// the ground, preferring an EXACT url match to lastUrl (orchard's restored tab) over a same-ground tab in a
// drifted state; skips engine-busy tabs. Returns { tabId, exact } or null. This is the relaxation the user
// accepted for the post-restart moment — it may, in the no-exact-match case, adopt a hand-opened tab once.
async function _adoptGroundTab(groundId, lastUrl) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return null; }
  let grounds = [];
  try { grounds = await StorageManager.getAllGrounds(); } catch { return null; }
  const matches = tabs.filter((t) => t && typeof t.id === 'number' && t.url
    && !_engineBusyTabs.has(t.id) && _groundIdForUrl(t.url, grounds) === groundId);
  if (!matches.length) return null;
  const exact = lastUrl ? matches.find((t) => t.url === lastUrl) : null;
  if (exact) return { tabId: exact.id, exact: true };
  const recent = matches.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  return { tabId: recent.id, exact: false };
}

/**
 * Resolve THE tab for a ground replay: (1) reuse orchard's own ground tab if the session record is still
 * valid; (2) on a cold start (session map cleared by a browser restart) ADOPT a live tab on the ground when
 * the durable marker says orchard has owned one before; (3) else open a fresh tab and record it. Only
 * orchard-owned grounds enter the adoption path, so a hand-opened tab for a never-touched ground is never
 * hijacked. Returns the tabId, or null when there's nothing to open.
 * @param {string} groundId
 * @param {string} groundUrl
 * @param {{active?:boolean}} [opts]
 * @returns {Promise<number|null>}
 */
export async function ensureTabForGround(groundId, groundUrl, { active = false } = {}) {
  // 1. strict within-session reuse
  const reuse = await _findReusableGroundTab(groundId);
  if (reuse != null) { Logger.info('background', `TAB ▸ reuse ${reuse} for ground ${_slug6(groundId)} (orchard-owned)`); return reuse; }
  // 2. cold-start adoption — only if orchard has owned a tab for this ground before (durable marker)
  const lastUrl = await _getGroundLastUrl(groundId);
  if (lastUrl) {
    const adopted = await _adoptGroundTab(groundId, lastUrl);
    if (adopted) {
      await _recordGroundTab(groundId, adopted.tabId, lastUrl);
      Logger.info('background', `TAB ▸ adopt ${adopted.tabId} for ground ${_slug6(groundId)} (cold-start recovery, ${adopted.exact ? 'exact url' : 'origin'})`);
      return adopted.tabId;
    }
  }
  // 3. open fresh
  if (!groundUrl || !/^https?:\/\//i.test(String(groundUrl))) return null;
  const tab = await new Promise((r) => { try { chrome.tabs.create({ url: String(groundUrl), active: !!active }, (t) => { void chrome.runtime.lastError; r(t || null); }); } catch { r(null); } });
  const tabId = (tab && typeof tab.id === 'number') ? tab.id : null;
  if (tabId != null) { await _recordGroundTab(groundId, tabId, groundUrl); Logger.info('background', `TAB ▸ opened ${tabId} for ground ${_slug6(groundId)} (recorded)`); }
  return tabId;
}
async function _flushInteractionOutcomes(ctx, { force = false } = {}) {
  if (_traceFlushing) return;
  const pending = _interactionTrace.seq - _traceFlushedSeq;
  if (pending <= 0 || (!force && pending < TRACE_FLUSH_EVERY)) return;
  _traceFlushing = true;
  try {
    const entries = InteractionTrace.snapshot(_interactionTrace, { sinceSeq: _traceFlushedSeq });
    _traceFlushedSeq = _interactionTrace.seq;   // claim the range up-front so a concurrent call can't double-emit
    const events = InteractionTrace.eventsFromEntries(entries);
    if (events.length) {
      const byGround = new Map();
      for (const ev of events) { if (!byGround.has(ev.groundId)) byGround.set(ev.groundId, []); byGround.get(ev.groundId).push(ev); }
      for (const [gid, evs] of byGround) { try { await ctx.appendOutcomes(gid, evs); } catch { /* per-ground append failure → drop, ring still holds them */ } }
      Logger.info('monitor', `INTERACTION_OUTCOMES ▸ flushed ${events.length} usage event(s) from ${entries.length} interaction(s)`);
    }
  } catch (e) {
    Logger.warn('background', `interaction outcomes flush failed: ${e.message}`);
  } finally { _traceFlushing = false; }
}

function _groundLabel(g) {
  if (!g) return null;
  const name = String(g.name || g.site || '').trim();
  if (name && !/^ground$/i.test(name)) return name;
  const url = g.url || (Array.isArray(g.urlPatterns) ? g.urlPatterns[0] : '') || '';
  try { const core = siteIdentity(url).brand || new URL(url).hostname.replace(/^www\./, '').split('.')[0]; if (core) return core.charAt(0).toUpperCase() + core.slice(1); } catch { /* */ }   // v2.74.835 — brand (bamboohr), not the subdomain (malbek)
  return name || g.id || g.groundId || null;
}

// v2.74.801 — Does the ask NAME a different known Ground than the one we're on? ("search pixabay for X" while on
// Indeed.) Used to route a GROUNDED miss to the named site instead of offering to teach it on the wrong one. PURE.
// Matches a Ground by its distinctive tokens — the host SLD ("pixabay.com" → "pixabay") and a non-generic stored
// name — as whole words in the ask. A small stoplist drops generic SLDs ("jobs", "app") that aren't real site names,
// so the signal stays precise; it only fires on a miss and is confirm-first downstream, so a stray match is harmless.
const _GROUND_TOKEN_STOP = new Set(['www', 'app', 'web', 'home', 'jobs', 'job', 'search', 'mail', 'login', 'account', 'site', 'page', 'shop', 'store', 'my', 'go', 'get']);
// The distinctive whole-word tokens that identify a Ground in an ask — the host SLD ("pixabay.com" → "pixabay"),
// the registrable BRAND (v2.74.835 — malbek.bamboohr.com → "bamboohr"), and a non-generic stored name. The
// _GROUND_TOKEN_STOP set drops generic SLDs ("jobs", "app") so the signal stays precise. Shared by
// _askNamesOtherGround (first hit) and _countNamedGrounds (distinct count) so the two can't drift.
function _groundMatchTokens(g) {
  const toks = [];
  const url = (g && (g.url || (Array.isArray(g.urlPatterns) ? g.urlPatterns[0] : ''))) || '';
  try { const sld = new URL(url).hostname.replace(/^www\./, '').split('.')[0]; if (sld && sld.length >= 4 && !_GROUND_TOKEN_STOP.has(sld.toLowerCase())) toks.push(sld); } catch { /* */ }
  try { const brand = siteIdentity(url).brand; if (brand && brand.length >= 4 && !_GROUND_TOKEN_STOP.has(brand.toLowerCase())) toks.push(brand); } catch { /* */ }
  const nm = String((g && (g.name || g.site)) || '').trim();
  if (nm && nm.length >= 4 && !/^ground$/i.test(nm) && !_GROUND_TOKEN_STOP.has(nm.toLowerCase())) toks.push(nm);
  return toks;
}
function _askMatchesGround(text, g) {
  for (const t of _groundMatchTokens(g)) {
    try { if (new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text)) return true; } catch { /* */ }
  }
  return false;
}
// v2.74.801 — Does the ask NAME a different known Ground than the one we're on? ("search pixabay for X" while on
// Indeed.) Used to route a GROUNDED miss to the named site instead of offering to teach it on the wrong one. PURE.
// Matches by the distinctive tokens above, as whole words; it only fires on a miss and is confirm-first downstream,
// so a stray match is harmless. Returns the FIRST other Ground named (host-derived label + url for the hop).
function _askNamesOtherGround(ask, grounds, currentGid) {
  const text = String(ask || '');
  if (!text.trim()) return null;
  for (const g of (Array.isArray(grounds) ? grounds : [])) {
    if (!g || g.id === currentGid) continue;
    if (_askMatchesGround(text, g)) {
      const url = (g.url || (Array.isArray(g.urlPatterns) ? g.urlPatterns[0] : '')) || '';
      return { groundId: g.id, groundName: _groundLabel(g), groundUrl: url || null };
    }
  }
  return null;
}
// v2.74.1005 (2c) — how many DISTINCT known Grounds does this ask name? The Ground-AWARE sibling of orchChain's
// namesMultipleSites: it matches VERB-OBJECT site names ("search youtube for X and pixabay for Y") that the
// preposition-only _siteRefs misses, using the SAME token logic as _askNamesOtherGround. Gates the COMPOUND
// cross-site trigger (chat.js) so an "A and B"-joined two-site ask reaches COMPREHEND_CROSS_GROUND instead of
// collapsing to ONE Ground via the global path — the 2026-06-12 20:34 silent-half-success bug. PURE.
function _countNamedGrounds(ask, grounds) {
  const text = String(ask || '');
  if (!text.trim()) return 0;
  const seen = new Set();
  for (const g of (Array.isArray(grounds) ? grounds : [])) {
    const gid = g && (g.id || g.groundId);
    if (!gid || seen.has(gid)) continue;
    if (_askMatchesGround(text, g)) seen.add(gid);
  }
  return seen.size;
}

// v2.74.808 — A PRONOUN / back-reference value ("it", "that", "the title", "the first result") is a DATA HAND-OFF
// reference to an UPSTREAM step's result, NOT a literal to type. Used to drop it from a dependsOn-consumer's stated
// values so wireCrossGroundData binds the param to the upstream output (scope_binding) instead of typing "it". PURE.
const _PRONOUN_REF = /^(it|its|that|this|them|they|those|these|one|the (one|title|price|link|url|result|name|value|item|first|top|job|post|page))$/i;
function _isPronounRef(v) { return _PRONOUN_REF.test(String(v == null ? '' : v).trim()); }

// v2.74.823 — resolve the active TAB's Ground the SAME way the RUNTIME does: match the tab URL against each Ground's
// urlPatterns (Core/GroundMatcher — the matcher that honors the patterns a dedup MERGE unions, e.g. app.notion.com +
// www.notion.so → ONE Ground), with a `.url`-origin FALLBACK for legacy Grounds that carry no urlPatterns. The admin
// resolvers (ORCH_ADMIN count/delete, ORCH_LIST, RENAME_GROUND) used bare origin equality against the single `.url`
// field, so a SIBLING host of a merged Ground (an app.notion.com tab on the notion.so Ground) resolved to NOTHING —
// the surprising "no capabilities on this site" / grounds=0 the user hit AFTER a successful dedup. Returns id|null.
async function _groundIdForTab(tabId, grounds) {
  if (typeof tabId !== 'number') return null;
  let url = '';
  try { url = (await chrome.tabs.get(tabId))?.url || ''; } catch { return null; }
  if (!url) return null;
  return _groundIdForUrl(url, grounds);
}

// v2.74.824 — the URL→Ground half of _groundIdForTab, for the MATCH and RUN/REPLAY paths that ALREADY hold a URL
// string (so they skip the chrome.tabs.get). Strictly MORE PERMISSIVE than the bare-`.url`-origin equality those
// paths used to do: it finds the merged SIBLING host (an app.notion.com URL on the www.notion.so Ground) where
// origin-only found nothing, and is IDENTICAL for unmerged Grounds (the origin fallback). Pure (no chrome.*), so it
// works wherever a url is in hand. Returns id|null.
function _groundIdForUrl(url, grounds) {
  if (typeof url !== 'string' || !url) return null;
  const list = Array.isArray(grounds) ? grounds : [];
  // 1) urlPatterns match (the runtime's matcher) — resolves merged/multi-host Grounds, most-specific wins.
  try { const m = matchGroundForUrl(url, list); if (m && m.ground) return m.ground.id || m.ground.groundId || null; } catch { /* */ }
  // 2) fallback: legacy single-`.url` origin equality (a Ground saved with no urlPatterns).
  try { const origin = new URL(url).origin; const g = list.find((x) => { try { return x && x.url && new URL(x.url).origin === origin; } catch { return false; } }); if (g) return g.id || g.groundId || null; } catch { /* */ }
  return null;
}

// v2.74.827 — load a Ground's live backing-record ids (Strategies + Fragments) for the orphan filter, shared by every
// matcher site (so the strategyId/fragmentId check can't drift between them — that drift WAS the bug: only strategyId
// was checked, so a Fragment-cap whose Fragment was deleted still matched, then REPLAY-failed "not found"). A FAILED
// read for a kind → null (NOT empty) → isOrphanCapability won't flag that kind (precision-first).
async function _liveBackingIds(groundId) {
  let liveStrategyIds = null, liveFragmentIds = null, strategyFragments = null;
  try {
    const strategies = (await StorageManager.listStrategies(groundId)) || [];
    liveStrategyIds = new Set(strategies.map((x) => x && x.id).filter(Boolean));
    // v2.74.889 — strategy → its constituent fragmentIds (incl. detect/foreach bodies, via the canonical
    // collectReferencedPrimitiveIds), so the orphan check catches a LIVE strategy whose fragment was DELETED
    // (the "missing a step" orphan that survives a Studio/panel/bulk fragment-delete).
    strategyFragments = new Map();
    for (const s of strategies) {
      if (!s || !s.id) continue;
      const { fragmentIds } = CapabilitySynth.collectReferencedPrimitiveIds([s]);
      if (fragmentIds && fragmentIds.size) strategyFragments.set(s.id, [...fragmentIds]);
    }
  } catch { liveStrategyIds = null; strategyFragments = null; }
  try { liveFragmentIds = new Set((await StorageManager.listFragments(groundId)).map((x) => x && x.id).filter(Boolean)); } catch { liveFragmentIds = null; }
  return { liveStrategyIds, liveFragmentIds, strategyFragments };
}

// G1-3 — a Ground's readiness from its LIVE substrate counts: Locales modeled
// (listLocales), ACTIVE capabilities authored (readSgCapabilities + isActiveCapability),
// and siteMap nodes discovered (ctx.readSiteMap). Best-effort — a failed read for any
// signal counts as 0, never throws. Classification is pure (Core/groundReadiness).
async function _readinessForGround(ctx, groundId) {
  let localeCount = 0, capabilityCount = 0, siteMapNodeCount = 0;
  try { localeCount = (await listLocales(groundId) || []).length; } catch { /* */ }
  try { const caps = await ctx.readSgCapabilities(groundId); capabilityCount = (Array.isArray(caps) ? caps : []).filter((c) => c && isActiveCapability(c)).length; } catch { /* */ }
  try { const sm = ctx.readSiteMap ? await ctx.readSiteMap(groundId) : null; siteMapNodeCount = sm && sm.nodes ? Object.keys(sm.nodes).length : 0; } catch { /* */ }
  return { ...groundReadiness({ localeCount, capabilityCount, siteMapNodeCount }), counts: { localeCount, capabilityCount, siteMapNodeCount } };
}

async function _bindStrategyOnGround(ctx, clause, groundId, effect = 'action') {
  let caps = [];
  try { caps = await ctx.readSgCapabilities(groundId); } catch { return null; }
  // v2.74.821 — PARITY with ORCH_MATCH_GLOBAL: bind only ACTIVE, non-ORPHAN caps. This path used to include
  // retracted/disabled caps AND strategy-caps whose Strategy was deleted (an orphan) — so a cross-Ground step could
  // bind a PAUSED or DANGLING capability that then dies at REPLAY ("strategy not found"). The global matcher already
  // filters both (isActiveCapability + !orphan); mirror it. Orphan = a strategy-cap whose strategyId isn't among the
  // Ground's live Strategies — OR a bare Fragment-cap whose Fragment is gone (v2.74.827, via the shared predicate); a
  // FAILED read → null → DON'T orphan-filter that kind (precision-first: never wrongly orphan a real cap on a transient error).
  const { liveStrategyIds, liveFragmentIds, strategyFragments } = await _liveBackingIds(groundId);
  const _orphan = (c) => isOrphanCapability(c, { liveStrategyIds, liveFragmentIds, strategyFragments });
  // DF-1 — EFFECT-scoped pool (mirrors the within-Ground matcher, sg.js ORCH_MATCH): a READ sub-intent binds an
  // OBSERVATION (the only capability that PRODUCES a value for a downstream Ground); an ACTION binds a T2 Strategy
  // or a bare T1 Fragment.
  const isRead = effect === 'read';
  const candidates = (Array.isArray(caps) ? caps : [])
    .filter((c) => c && isActiveCapability(c) && !_orphan(c) && (isRead ? c.kind === 'observation' : (c.kind !== 'observation' && (c.strategyId || c.fragmentId))))
    .map((c) => toCandidate(c));
  const _bindTag = `"${String(clause).slice(0, 36)}" @${String(groundId).slice(-6)}`;
  Logger.debug('background', `_bind ▸ ${_bindTag}: ${candidates.length} ${effect} cand`);   // v2.74.807 — cross-Ground bind-pool size (DEBUG audit)
  if (!candidates.length) { Logger.info('background', `_bind ▸ ${_bindTag} → MISS [pool=0 ${effect} — no active ${effect} capability on this Ground]`); return null; }   // v2.74.818/.821
  // Lexical floor first (cheap). Escalate to the LLM matcher whenever the floor isn't a CONFIDENT hit — not only on a
  // hard miss (v2.74.821). ORCH_MATCH_GLOBAL ALWAYS consults the LLM and HIT a vague cross-Ground clause ("save it to
  // Notion" / "search for IT on Pixabay" — the content is a data placeholder with no lexical signal) that this
  // lexical-first path MISSED; a weak/ambiguous lexical 'propose' on such a clause is exactly where the LLM's stronger
  // signal must arbitrate (the same matchCapability that bound "search pixabay for cats" within-Ground). On an LLM
  // result the LLM verdict WINS — a vague clause the LLM rejects is an honest GAP on the named Ground, not a guess.
  let decision = rankAndDecide(clause, candidates, { now: Date.now() });
  let llmState = 'skip';   // v2.74.818 — did the LLM escalation run? distinguishes a lexical-only miss from an LLM miss
  if (!decision || decision.decision !== 'auto') {
    try {
      const llm = await AnthropicService.matchCapability({ ask: clause, candidates });
      llmState = 'ran';
      if (llm && Array.isArray(llm.scores)) decision = rankAndDecide(clause, candidates, { score: scoresToScorer(llm.scores), now: Date.now() });
    } catch { llmState = 'err'; /* LLM unavailable → keep the lexical decision */ }
  }
  const cand = decision && decision.candidate;
  if (!cand || decision.decision === 'miss') {
    // v2.74.818 — log WHY the bind missed: pool size + the top (almost-matched) candidate + its score + LLM state.
    const _top = (decision && decision.candidate) ? `"${String(decision.candidate.intent || decision.candidate.name || '').slice(0, 30)}" ${Number(decision.score || 0).toFixed(2)}` : 'none';
    Logger.info('background', `_bind ▸ ${_bindTag} → MISS [pool=${candidates.length} ${effect}, top=${_top}, llm=${llmState}]`);
    return null;
  }
  const cap = (cand.raw && typeof cand.raw === 'object') ? cand.raw : {};
  if (isRead) {
    // an OBSERVATION read: it READS cap.observe.extracts[*].output → workflowScope → a downstream write consumes
    // it via scope_binding (the cross-Ground DATA FLOW). The executor runs the read via the OBSERVATION-NATIVE
    // dispatch (RUN_OBSERVATION) — NOT by wrapping it as a Strategy — so we surface the capability id plus its
    // ANTECEDENT capability (the prerequisite ACTION, e.g. the search, REPLAYED before the read) rather than the
    // embedded `observe`. This keeps the load-bearing act/read split: actions ACT, Observations READ. The antecedent
    // is logical linkage independent of strategy membership — an observation carries its own (a Strategy or Fragment).
    const extracts = (cap.observe && Array.isArray(cap.observe.extracts)) ? cap.observe.extracts : [];
    const outputs = extracts.map((e) => e && e.output).filter(Boolean);
    if (!outputs.length) return null;   // a read producing no named output can't feed data flow
    return {
      capabilityId: cap.id,
      capabilityKind: 'observation',
      capabilityName: cand.intent || cap.intent || cap.name || '',
      params: [],
      outputs,
      ...(cap.antecedentCapabilityId ? { antecedentCapabilityId: cap.antecedentCapabilityId } : {}),
      ...(cap.antecedentParamBindings && typeof cap.antecedentParamBindings === 'object' ? { antecedentParamBindings: cap.antecedentParamBindings } : {}),
    };
  }
  const isStrategy = !!cap.strategyId;
  // the DISPATCH id the Workflow step runs: a Strategy id (executeStrategy by id) OR a Fragment id (wrapped at run
  // time — capabilityKind tells the executor to wrap it). Only a T2 Strategy declares outputs (cross-Ground data
  // flow via wireCrossGroundData); a bare T1 Fragment has none.
  const dispatchId = cap.strategyId || cap.fragmentId || cand.id;
  let outputs = [];
  if (isStrategy) { try { const strat = await StorageManager.getStrategy(cap.strategyId); outputs = (Array.isArray(strat && strat.outputs) ? strat.outputs : []).map((o) => (typeof o === 'string' ? o : (o && o.name))).filter(Boolean); } catch { /* */ } }
  return {
    capabilityId: dispatchId,
    capabilityKind: isStrategy ? 'strategy' : 'fragment',
    capabilityName: cand.intent || cap.name || '',
    params: (cand.params || []).map((p) => (typeof p === 'string' ? p : (p && p.name))).filter(Boolean),
    outputs,
    // Carry the consumer's reversibility (toCandidate derives it from intent/aliases via _IRREVERSIBLE). A cross-Ground
    // WRITE consumer (apply/submit/post/buy) must be surfaced + confirmed in the workflow card — the single card-confirm
    // can't silently authorize an irreversible step the way an explicit "Yes, go ahead" does on the single-ask path.
    reversible: cand.reversible !== false,
  };
}

// OBS-READ bridge — map a manual Observation extract to the EXACT OBSERVE_* message Studio's "Verify" button
// dispatches (Sidepanel/modes/observation-author.js `_observeMsgFor`). We reuse the proven runtime path verbatim
// instead of reimplementing it, so a chat read behaves identically to the author's Verify. Returns null for
// shapes that need extra context (images/sections/gates) — the bridge skips those for now.
function _observeMessageForExtract(ex) {
  if (!ex || !ex.target) return null;
  switch (ex.shape) {
    case 'text':      return { type: 'OBSERVE_RAW_TEXT', payload: { target: ex.target } };
    case 'text_last': return { type: 'OBSERVE_RAW_TEXT', payload: { target: ex.target, pickLast: true } };
    case 'raw_text':  return { type: 'OBSERVE_RAW_TEXT', payload: { target: ex.target } };
    case 'raw_html':  return { type: 'OBSERVE_RAW_HTML', payload: { target: ex.target } };
    case 'attribute': return { type: 'OBSERVE_SCALAR',   payload: { target: ex.target, extract: { kind: 'attribute', name: ex.attribute } } };
    case 'scalar':    return { type: 'OBSERVE_SCALAR',   payload: { target: ex.target, extract: ex.extract ?? { kind: 'text' } } };
    default:          return null;
  }
}

// T1-as-first-class (v2.74.762) — the SINGLE persist path for an accepted op, shared by BOTH the SG-trial accept
// (ACCEPT_SG_TRIAL[tier2]) and the demonstration accept (DERIVE_OBSERVED_CAPABILITY), so the taxonomy guard
// (a single page-state-bounded phase → a bare Fragment; ≥2 → a Strategy) and the save logic can't drift between
// them. Mints the ids, shapes the records via the pure prepareTier1or2Records, saves the fragment(s) + (only for
// ≥2 phases) the strategy. Returns the ids the caller needs to build the sgCapability (fragmentId vs strategyId).
async function persistTier1or2(phases, { groundId, name, goal, params = null, aliases = null, fragmentName = null, fragmentDescription = null, entryGate = null } = {}) {
  const strategyId = crypto.randomUUID();
  const fragmentIds = (Array.isArray(phases) ? phases : []).map(() => crypto.randomUUID());
  const prep = CapabilitySynth.prepareTier1or2Records(phases, {
    groundId, strategyId, fragmentIds, name, goal,
    ...(params ? { params } : {}), ...(aliases ? { aliases } : {}),
    ...(fragmentName ? { fragmentName } : {}), ...(fragmentDescription ? { fragmentDescription } : {}),
    ...(entryGate ? { entryGate } : {}),   // b6a — non-fatal perspective gate on the entry fragment
  });
  if (!prep.ok) return { ok: false, reason: prep.error };
  for (const f of prep.fragments) { try { await StorageManager.saveFragment(f); } catch (e) { Logger.warn('background', `persistTier1or2 saveFragment failed: ${e.message}`); } }
  if (!prep.isSingleT1) {
    try { await StorageManager.saveStrategy(prep.strategy); }
    catch (e) { return { ok: false, reason: `strategy save failed: ${e.message}`, fatal: true }; }
  }
  return { ok: true, isSingleT1: prep.isSingleT1, fragmentIds, strategyId: prep.isSingleT1 ? null : strategyId, fragmentCount: prep.fragments.length };
}

// HS-1 (v2.74.898) — heterogeneous persist: ACCEPT hands HETERO nodes (action/observation/navigate) and the
// strategy keeps them as ORDERED steps the engine's walker already executes. Saves Fragments + the lowered
// Observation records + the Strategy. Pure-action input behaves exactly like persistTier1or2 (incl. the
// bare-T1 guard) via the builder's fall-through.
async function persistHeteroTier2(nodes, { groundId, name, goal, params = null, aliases = null, entryGate = null } = {}) {
  const strategyId = crypto.randomUUID();
  const list = Array.isArray(nodes) ? nodes : [];
  const fragmentIds = list.filter((n) => n && n.kind === 'action').map(() => crypto.randomUUID());
  const observationIds = list.filter((n) => n && n.kind === 'observation').map(() => crypto.randomUUID());
  const prep = CapabilitySynth.prepareHeteroTier2Records(list, {
    groundId, strategyId, fragmentIds, observationIds, name, goal,
    ...(params ? { params } : {}), ...(aliases ? { aliases } : {}),
    ...(entryGate ? { entryGate } : {}),
  });
  if (!prep.ok) return { ok: false, reason: prep.error };
  for (const f of prep.fragments) { try { await StorageManager.saveFragment(f); } catch (e) { Logger.warn('background', `persistHeteroTier2 saveFragment failed: ${e.message}`); } }
  for (const o of (prep.observations || [])) { try { await StorageManager.saveObservation(o); } catch (e) { Logger.warn('background', `persistHeteroTier2 saveObservation failed: ${e.message}`); } }
  if (!prep.isSingleT1) {
    try { await StorageManager.saveStrategy(prep.strategy); }
    catch (e) { return { ok: false, reason: `strategy save failed: ${e.message}`, fatal: true }; }
  }
  return {
    ok: true, isSingleT1: prep.isSingleT1, fragmentIds,
    observationIds: (prep.observations || []).map((o) => o.id),
    strategyId: prep.isSingleT1 ? null : strategyId,
    fragmentCount: prep.fragments.length, observationCount: (prep.observations || []).length,
  };
}

// v2.74.950 (CR-X3a) — THE ctx seam contract. background.js builds this object; a missing key used to
// surface as a TypeError deep inside whichever handler first touched it (and the JSDoc had drifted to 13
// of the 18 actual keys — the review's smell). Listed ONCE here, asserted at wiring time.
const REQUIRED_CTX_KEYS = Object.freeze([
  'runTrialBundle', 'readLocaleCache', 'readSgSpec', 'normalizeUrl', 'appendOutcomes', 'readOutcomes',
  'outcomeRollups', 'broadcastStorageChanged', 'readSgCapabilities', 'readSiteMap', 'readSgDraft',
  'writeSgDraft', 'clearSgDraft', 'writeSgCapability', 'removeSgCapabilities', 'ensureContentScript',
  'writeSgTrace', 'enrichSgLandmarks',
]);

/** Throw (at SW startup) if the seam object is missing any contract key — names every gap at once. */
export function assertCtx(ctx) {
  const missing = REQUIRED_CTX_KEYS.filter((k) => typeof ctx?.[k] !== 'function');
  if (missing.length) throw new Error(`createSgMessageHandlers: ctx is missing [${missing.join(', ')}] — the background wiring and the sg.js contract have drifted`);
  return ctx;
}

/**
 * @param {object} ctx  background-local helpers (kept in background.js — shared with non-SG code, or
 *   chrome.storage-backed SG stores). The full 18-key contract lives in REQUIRED_CTX_KEYS above and is
 *   asserted at wiring time:
 *   { runTrialBundle, readLocaleCache, readSgSpec, normalizeUrl, appendOutcomes, readOutcomes,
 *     outcomeRollups, broadcastStorageChanged, readSgCapabilities, readSiteMap, readSgDraft, writeSgDraft,
 *     clearSgDraft, writeSgCapability, removeSgCapabilities, ensureContentScript, writeSgTrace,
 *     enrichSgLandmarks }
 * @returns {Record<string, (payload:object, sender:object, sendResponse:Function) => Promise<void>>}
 */
export function createSgMessageHandlers(ctx) {
  assertCtx(ctx);   // v2.74.950 (CR-X3a) — fail at WIRING time, not deep inside the first handler to touch a gap
  // T3X-DF (v2.74.790/792) — CAPTURE-TIME ANTECEDENT INFERENCE. The LAST action capability the chat REPLAYED on a
  // Ground this SW-lifetime, keyed by groundId: { capabilityId, bindings }. REPLAY_SG_CAPABILITY is the single
  // chokepoint for every chat-run action (standalone ask / compound chain / matcher), so recording here captures
  // "the search that drove this Ground's state". OBSERVE_CAPTURE stamps it as a freshly-captured READ's antecedent —
  // the prerequisite the cross-Ground dispatch (_runObservationStep) REPLAYS (as this same capability) before
  // reading. The antecedent is a CAPABILITY ref, replayed via REPLAY_SG_CAPABILITY, so a multi-fragment Strategy
  // search works as the prerequisite — not only a single Fragment. In-memory only — re-derived as the user works;
  // never persisted (a stale entry just means a base-URL read, which fails cleanly).
  const _lastGroundAction = new Map();

  return {
    // R-3/R-4a — the LLM front-door ROUTER (DESIGN_llm_front_door.md). ISOLATED + console-testable: resolve the
    // Ground, retrieve a small candidate palette (R-2), let the router LLM (R-3) select+parameterize ONE tool,
    // and return the RouteDecision via the pure cascade (R-1). Does NOT yet replace the chat entry (that is R-4b);
    // call it directly to verify e.g. "go to pixabay home page" -> { action:'primitive', tool: OPEN_URL, params:{url} }.
    ROUTE_ASK: async (payload, _sender, sendResponse) => {
      try {
        const ask = String(payload?.ask ?? '').trim();
        if (!ask) { sendResponse({ success: false, error: 'ask required' }); return; }
        let { tabId, groundId } = payload ?? {};
        let tabUrl = '';
        if (typeof tabId === 'number') { try { tabUrl = (await chrome.tabs.get(tabId))?.url || ''; } catch { /* */ } }
        if (!groundId && tabUrl) { try { groundId = _groundIdForUrl(tabUrl, await StorageManager.getAllGrounds()); } catch { /* */ } }
        // R-6 (v2.74.958) — warm-path cache check (see _routeCache above).
        const cacheKey = _routeCacheKey(ask, groundId, tabUrl ? ctx.normalizeUrl(tabUrl) : '');
        const hit = _routeCache.get(cacheKey);
        if (hit && (Date.now() - hit.at) < ROUTE_CACHE_TTL_MS) {
          Logger.info('route', `ROUTE_ASK "${ask.slice(0, 60)}" -> ${hit.decision.action} (CACHE HIT, age ${Math.round((Date.now() - hit.at) / 1000)}s)`);
          sendResponse({ success: true, decision: hit.decision, groundId: groundId || null, candidateCount: hit.candidateCount, cached: true });
          return;
        }
        let caps = [];
        if (groundId) { try { caps = ((await ctx.readSgCapabilities(groundId)) || []).filter((c) => c && isActiveCapability(c) && c.kind !== 'composite'); } catch { caps = []; } }
        const candidates = retrieveTools(ask, { capabilities: caps });
        const decision = await route(ask, {
          retrieveTools: async () => candidates,                                       // R-2 candidates (precomputed)
          callRouter:    async ({ ask: a, tools }) => AnthropicService.routeAsk({ ask: a, tools }),   // R-3 LLM
        });
        // R-6 (v2.74.958) — store only confident, actionable decisions (never the miss class).
        if (!decision.lowConfidence && (decision.action === 'primitive' || decision.action === 'replay' || decision.action === 'decompose')) {
          _routeCache.set(cacheKey, { decision, candidateCount: candidates.length, at: Date.now() });
          if (_routeCache.size > ROUTE_CACHE_MAX) { _routeCache.delete(_routeCache.keys().next().value); }
        }
        const t = decision.tool;
        Logger.info('route', `ROUTE_ASK "${ask.slice(0, 60)}" → ${decision.action}${t ? ` ${t.op || t.capabilityId || ''}` : ''} (conf ${decision.confidence}, ${candidates.length} cand, ground ${groundId || '—'})`);
        sendResponse({ success: true, decision, groundId: groundId || null, candidateCount: candidates.length });
      } catch (err) {
        Logger.error('background', `ROUTE_ASK failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // IL-2 (v2.74.1112) — RETRIEVE_TOOLS: the LEARNED-leg source for the panel-hosted brain loop's
    // assemblePalette (Core/brainRun). Mirrors ROUTE_ASK's ground-resolution + candidate computation, minus
    // the LLM route — returns the retrieved candidates + the resolved groundId so the panel can ctx-bind
    // execPlan. Reached ONLY by the `brain:` panel command (verify-only); never touches the default cascade.
    RETRIEVE_TOOLS: async (payload, _sender, sendResponse) => {
      try {
        const ask = String(payload?.ask ?? '').trim();
        if (!ask) { sendResponse({ success: false, error: 'ask required' }); return; }
        let { tabId, groundId } = payload ?? {};
        let tabUrl = '';
        if (typeof tabId === 'number') { try { tabUrl = (await chrome.tabs.get(tabId))?.url || ''; } catch { /* */ } }
        if (!groundId && tabUrl) { try { groundId = _groundIdForUrl(tabUrl, await StorageManager.getAllGrounds()); } catch { /* */ } }
        let caps = [];
        if (groundId) { try { caps = ((await ctx.readSgCapabilities(groundId)) || []).filter((c) => c && isActiveCapability(c) && c.kind !== 'composite'); } catch { caps = []; } }
        const candidates = retrieveTools(ask, { capabilities: caps });
        sendResponse({ success: true, candidates, groundId: groundId || null });
      } catch (err) {
        Logger.error('background', `RETRIEVE_TOOLS failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // IL-2 (v2.74.1112) — STEP_BRAIN: the brain loop's THINK seam (AnthropicService.stepBrain over a
    // StepContext). The panel hosts the loop (Core/brainRun + agentLoop) and round-trips here each cold step;
    // the pure prompt/parse (palette + observation fenced as DATA) lives in Core/stepPrompt.js. Verify-only.
    STEP_BRAIN: async (payload, _sender, sendResponse) => {
      try {
        const decision = await AnthropicService.stepBrain(payload?.ctx || {});
        sendResponse({ success: true, decision });
      } catch (err) {
        Logger.error('background', `STEP_BRAIN failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // PB-4 (R8) — run a TRIAL of an already-RESOLVED bundle (Studio's resolve flow) as the intent-truth
    // proof. v2.74.950 (CR-X3) — migrated from the legacy background switch: this was the un-migrated
    // TWIN of RUN_SG_TRIAL that silently missed the .912 handler-level fix; it now lives beside its twin
    // and shares ctx.runTrialBundle (whose internal busy-marking covers both entries).
    RUN_PERSPECTIVE_TRIAL: async (payload, _sender, sendResponse) => {
      try {
        const { groundId = null, intent = '', roles, navigateUrl = null, proposedRoleCount = 0 } = payload ?? {};
        if (!groundId || !Array.isArray(roles) || !roles.length) { sendResponse({ success: false, error: 'groundId + roles required' }); return; }
        let localeModel = null;
        try { const pm = await ctx.readLocaleCache(groundId, ctx.normalizeUrl(navigateUrl || '')); localeModel = pm?.model || null; } catch { /* */ }
        sendResponse(await ctx.runTrialBundle({ groundId, intent, roles, localeModel, navigateUrl, proposedRoleCount }));
      } catch (err) {
        Logger.error('background', `RUN_PERSPECTIVE_TRIAL failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // SG-4b — run the substrate-grounded plan on the live page (Comprehend→Select→Cover→Bind→execute) and
    // stash a session draft so the result can be accepted without re-running.
    RUN_SG_TRIAL: async (payload, _sender, sendResponse) => {
      const _busyTab = (typeof payload?.tabId === 'number') ? payload.tabId : null;   // v2.74.912 — trial clicks are engine activity (the 23:32 trace logged them as user-interaction misses)
      if (_busyTab != null) markEngineBusy(_busyTab, true);
      try {
        const { tabId, groundId = null, intent } = payload ?? {};
        if (!groundId || typeof intent !== 'string' || !intent.trim()) { Logger.info('background', 'RUN_SG_TRIAL ▸ EXIT — groundId + intent required'); sendResponse({ success: false, error: 'groundId + intent required' }); return; }   // v2.74.914 — every exit logs a verdict (the live "iterate top 5" dead-ended silently)
        let url = '';
        if (typeof tabId === 'number') { try { const t = await chrome.tabs.get(tabId); url = t?.url ?? ''; } catch { /* */ } }
        let localeModel = null;
        let localeCapturedUrl = '';
        try { const pm = await ctx.readLocaleCache(groundId, ctx.normalizeUrl(url)); localeModel = pm?.model || null; localeCapturedUrl = pm?.url || pm?.model?.url || ''; } catch { /* */ }
        if (!localeModel || !localeModel.features) { Logger.info('background', `RUN_SG_TRIAL ▸ EXIT — no Locale for ${ctx.normalizeUrl(url) || url || 'this page'} (ground ${groundId}) — run Explore first`); sendResponse({ success: false, error: 'no Locale for this page — run Explore first' }); return; }   // v2.74.914
        // C3 (v2.74.641) — REUSE the propose-time spec+selection (cached by GROUND_INTENT on this page) when
        // present. Re-comprehending here re-rolled the shape (act→read) and re-matched, which on a multi-
        // filter intent matched filters to inputs and broke the run; the cache makes the trial deterministic,
        // reuses the GOOD matches, and saves 2 LLM calls. A miss (page navigated / TTL lapsed / never
        // proposed) falls back to a fresh comprehend+match.
        let spec, selection;
        const cachedSpec = (typeof ctx.readSgSpec === 'function') ? ctx.readSgSpec(groundId, url, intent) : null;
        if (cachedSpec && cachedSpec.spec && cachedSpec.selection) {
          spec = cachedSpec.spec; selection = cachedSpec.selection;
          Logger.info('background', `RUN_SG_TRIAL — reusing cached propose spec (shape=${spec.shape}, ${(spec.subGoals || []).length} subGoal(s)) — no re-comprehend`);
        } else {
          spec = await AnthropicService.comprehendIntent({ userIntent: intent });
          if (!spec) { Logger.info('background', `RUN_SG_TRIAL ▸ EXIT — comprehend returned nothing for "${intent.slice(0, 60)}"`); sendResponse({ success: false, error: 'comprehend returned nothing' }); return; }   // v2.74.914
          // GA-5 — bias Select's tie-break toward this Ground's historically-durable selector tiers (only with signal).
          let _conv = null;
          try { const r = await ctx.outcomeRollups(groundId); if (r && r.conventions && r.conventions.total >= 5) _conv = r.conventions; } catch { /* */ }
          selection = await AnthropicService.matchSubGoals({ spec, locale: localeModel, conventions: _conv });
        }
        // SG-T2-6 — OPT-IN Tier-2 lowering. When the caller passes tier2:true, lower the subGoal program
        // into a multi-phase Tier-2 operation (fragment/observation/analysis/navigate/wait nodes) and
        // return it for inspection. The default (flat single-fragment) trial path below is untouched; the
        // multi-fragment EXECUTION + accept/replay wiring lands in a follow-up (verified live).
        if (payload && payload.tier2 === true) {
          const op = lowerToTier2(spec, selection, localeModel);
          Logger.info('background', `RUN_SG_TRIAL[tier2] — intent="${intent.slice(0, 60)}" shape=${spec.shape} nodes=${op.nodes.length} [${op.nodes.map((n) => n.type).join(' → ')}]`);
          // v2.74.634 — per-fragment role diagnostic (why a filter node is over-bound): featureId:kind:effect,
          // plus whether the fragment's goal(s) carry a submit (which makes SG-RES-7d treat it as a form).
          const _feats = (localeModel && localeModel.features) || {};
          for (const n of op.nodes) {
            if (n.type !== 'fragment') continue;
            const goals = new Set();
            const detail = (n.roles || []).map((r) => { const f = _feats[r.featureId]; if (f && Array.isArray(f.goals)) for (const g of f.goals) goals.add(g); return `${r.featureId}:${f?.kind || '?'}:${(f?.interaction && f.interaction.effect) || '?'}${f?.fieldType ? `/${f.fieldType}` : ''}${f?.hidden ? ` hidden←${f.revealedBy || '?'}` : ''}`; }).join(', ');
            const hasSubmit = Object.values(_feats).some((f) => f && f.kind === 'action' && f.interaction && f.interaction.effect === 'submit' && Array.isArray(f.goals) && f.goals.some((g) => goals.has(g)));
            Logger.info('background', `  [tier2] "${n.label}" (${(n.roles || []).length} roles, goalHasSubmit=${hasSubmit}): ${detail}`);
          }
          // SG-T2-7 — EXECUTE the Tier-2 op: run each fragment phase in order on the SAME live tab (the
          // result-establishing search first, then the filters), so the search submits → results page and
          // the filter phases run against it. Each phase reuses the proven flat runner (runTrialBundle:
          // synth → safety class → execute → score), and we aggregate per-phase via scoreTier2. (Observation/
          // navigate/wait nodes are skipped this slice — the live filter intents are all fragments.)
          const liveTab = (typeof tabId === 'number') ? tabId : null;
          const phases = orderForRun(op.nodes, localeModel);
          // PB-9 (R2, v2.74.961) — the tier2 ACHIEVABILITY floor, mirroring the flat path's
          // no-bindable-roles exit (.925): a lowered op with no role-carrying fragment phase cannot
          // prove anything live — exit with the cover verdict instead of "running" zero phases and
          // aggregating an empty outcome set into a hollow verdict.
          const _actionable = phases.filter((n) => n && n.type === 'fragment' && Array.isArray(n.roles) && n.roles.length);
          if (!_actionable.length) {
            const cover0 = coverComplete(spec, selection);
            Logger.info('background', `RUN_SG_TRIAL[tier2] ▸ EXIT — no actionable phases for "${intent.slice(0, 60)}" (cover=${cover0.complete}; ${cover0.reason})`);
            sendResponse({ success: true, ran: false, reason: 'no actionable phases from the selection', cover: cover0, intentShape: spec.shape, tier2: true });
            return;
          }
          const outcomes = [];
          // SG-T2-8 (v2.74.646) — SETTLE between phases when a phase NAVIGATED. The runner skips the plan's
          // wait nodes (above), so a filter phase used to fire the instant the search phase returned — before
          // the results page and its (portal'd) filter bar had loaded/hydrated, so the dropdown trigger opened
          // nothing and the option never mounted (the live pay failure). After a phase that changes the URL,
          // poll tab.status to 'complete' then add a short hydration grace so the next phase acts on a settled
          // SERP. No navigation → no wait (non-navigating phases run back-to-back as before).
          const _settleAfterNav = async (tab, prevUrl) => {
            if (typeof tab !== 'number') return prevUrl;
            let curUrl = prevUrl;
            try { const t = await chrome.tabs.get(tab); curUrl = t?.url || prevUrl; } catch { /* */ }
            if (curUrl === prevUrl) return prevUrl;                          // no navigation — the fragment's own gates sufficed
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
              let status = 'complete';
              try { const t = await chrome.tabs.get(tab); status = t?.status || 'complete'; } catch { /* */ }
              if (status === 'complete') break;
              await new Promise((r) => setTimeout(r, 200));
            }
            await new Promise((r) => setTimeout(r, 1800));                   // hydration grace for the SPA filter bar
            Logger.info('background', `  [tier2:run] settled after navigation → ${String(curUrl).slice(0, 80)}`);
            return curUrl;
          };
          for (let i = 0; i < phases.length; i++) {
            const node = phases[i];
            // v2.74.925 (CR-T2) — removed the "TESTING (v2.74.647)" unconditional 4s inter-phase pause: it
            // was a timing-isolation experiment that shipped ~280 patches and taxed every multi-phase trial
            // 4s×(phases−1); the navigation-aware `_settleAfterNav` below (SG-T2-8) is the real settle.
            let beforeUrl = null;
            try { if (liveTab !== null) { const t = await chrome.tabs.get(liveTab); beforeUrl = t?.url || null; } } catch { /* */ }
            const out = await ctx.runTrialBundle({ groundId, intent: node.label, roles: node.roles, localeModel, navigateUrl: null, proposedRoleCount: node.roles.length, targetTabId: liveTab });
            const trialPassed = !!(out?.ran && out.trial?.verdict === 'trial-pass');
            // SG-T2-9 — POSTCONDITION verification: a phase only PASSES when its intended effect is observable
            // (the comprehension's url/text successCondition, or the structural result floor), not merely "the
            // steps ran". Catches the no-op filter — dropdown opened, commit deferred for safety → URL
            // unchanged → a hollow trial-pass. URL is the discriminator (gathered here); selector/text floors
            // evaluate only when their presence is passed in (fast-follow). No checkable condition → the phase
            // falls back to the trial verdict (we never make an honest pass worse).
            let afterUrl = beforeUrl;
            try { if (liveTab !== null) { const t = await chrome.tabs.get(liveTab); afterUrl = t?.url || beforeUrl; } } catch { /* */ }
            const post = evaluatePostcondition(node.postcondition, { beforeUrl, afterUrl, selectorsPresent: {} });
            // SG-T2 (v2.74.759) — a NAVIGATING phase has a reliable success signal the structural floor CAN'T see
            // on the pre-nav locale (the result region lives on the destination page): the destination PATH itself.
            // Derive a `url_matches` postcondition from it and attach to the op node (which is stashed → carried to
            // the persisted Fragment), so a search that "reaches its /jobs results page" actually asserts that on
            // replay instead of having no postcondition at all. Attached AFTER the trial check above, so the trial
            // verdict stays honest (it isn't graded against a predicate derived from its own result).
            if (afterUrl && beforeUrl && afterUrl !== beforeUrl) {
              try {
                const navPath = new URL(afterUrl).pathname;
                if (navPath && navPath !== '/') {
                  const existing = (node.postcondition && Array.isArray(node.postcondition.conditions)) ? node.postcondition.conditions : [];
                  if (!existing.some((c) => c && c.type === 'url_matches')) {
                    node.postcondition = { match: 'all', conditions: [...existing, { type: 'url_matches', pattern: navPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }], source: `${(node.postcondition && node.postcondition.source) ? node.postcondition.source + '+' : ''}url-nav` };
                  }
                }
              } catch { /* */ }
            }
            const passed = trialPassed && (post.checked ? post.held === true : true);
            outcomes.push({ type: 'fragment', label: node.label, passed, ran: !!out?.ran, trialPassed, verdict: out?.trial?.verdict || null, postcondition: post.checked ? { held: post.held, basis: post.basis } : null, score: (out?.trial && typeof out.trial.score === 'number') ? out.trial.score : null, reason: out?.reason || out?.result?.error || null });
            const status = passed ? 'PASS' : (out?.ran ? (trialPassed ? 'INCOMPLETE (steps ran, effect not observed)' : 'fail') : 'not-run');
            const postTag = post.checked ? ` · postcondition ${post.held ? 'HELD' : 'NOT-HELD'} (${post.basis})` : '';
            Logger.info('background', `  [tier2:run] "${node.label}" → ${status}${out?.trial?.verdict ? ` (${out.trial.verdict})` : ''}${postTag}${out?.reason ? ` — ${String(out.reason).slice(0, 80)}` : ''}`);
            await _settleAfterNav(liveTab, beforeUrl);                       // settle if THIS phase navigated, before the next phase runs
          }
          const tier2Score = scoreTier2(outcomes.map((o) => ({ type: 'fragment', passed: o.passed })));
          // SG-T2-10 — INTENT-COVERAGE gate for completion intents (PB-10 on the tier2 path). A `complete`-
          // shape op (a form/application) must COVER the page-required fields AND carry a submit; otherwise
          // binding ONE incidental field (the SERP's job-alert email matched to "provide contact") reports a
          // HOLLOW 1/1 pass for an application that never happened — and the form isn't even on this page.
          // coverComplete is ground truth → downgrade the verdict and BLOCK accept so the run is honest about
          // what it could not do. (act/navigate ops are governed by their per-phase postconditions above.)
          const cover = coverComplete(spec, selection);
          const covered = spec.shape !== 'complete' || cover.complete;
          const aggVerdict = covered ? tier2Score.verdict : 'tier2-incomplete';
          Logger.info('background', `RUN_SG_TRIAL[tier2:run] — ${aggVerdict} (${tier2Score.requiredPassed}/${tier2Score.requiredTotal} phases passed) score=${tier2Score.score}${covered ? '' : ` · intent NOT covered — ${cover.reason}`}`);
          // SG-T2-ACC — stash the op so ACCEPT can promote it into a durable, replayable MULTI-fragment
          // capability. Re-synthesized at accept time WITHOUT the trial's commit-deferral, so a REPLAY APPLIES
          // the filters for real (the trial only proved reachability). Best-effort; never blocks the response.
          if (typeof ctx.writeSgDraft === 'function') {
            try { await ctx.writeSgDraft(groundId, { tier2: true, op, intent, spec, selection, localeUrl: localeCapturedUrl || '', tier2Score: { ...tier2Score, verdict: aggVerdict }, cover, outcomes, groundId, capturedAt: Date.now() }); } catch (e) { Logger.warn('background', `tier2 draft write failed (continuing): ${e.message}`); }
          }
          sendResponse({ success: true, ran: outcomes.length > 0, tier2: op, outcomes, tier2Score: { ...tier2Score, verdict: aggVerdict }, cover, intentShape: spec.shape, acceptEligible: covered && outcomes.some((o) => o.passed) });
          return;
        }
        const cover = coverComplete(spec, selection);
        const roles = selectionToTrialRoles(spec, selection, localeModel);
        Logger.info('background', `RUN_SG_TRIAL — intent="${intent.slice(0, 60)}" shape=${spec.shape} cover=${cover.complete} roles=${roles.length}`);
        if (!roles.length) { Logger.info('background', `RUN_SG_TRIAL ▸ EXIT — no bindable roles from the selection for "${intent.slice(0, 60)}"`); sendResponse({ success: true, ran: false, reason: 'no bindable roles from the selection', cover, intentShape: spec.shape }); return; }   // v2.74.925 (CR-T2) — the .914 every-exit-logs invariant missed this one
        // Precondition: Comprehend+Select take several seconds of LLM calls, during which the page can
        // navigate away (e.g. an auth redirect to /login). Re-read the live URL and bail with a CLEAR
        // "wrong page" rather than typing the form's selectors into whatever loaded.
        let liveUrl = url;
        if (typeof tabId === 'number') { try { const t2 = await chrome.tabs.get(tabId); liveUrl = t2?.url ?? url; } catch { /* */ } }
        const localeUrl = localeCapturedUrl || '';
        if (localeUrl && ctx.normalizeUrl(liveUrl) !== ctx.normalizeUrl(localeUrl)) {
          Logger.warn('background', `RUN_SG_TRIAL ▸ EXIT — page drifted to "${liveUrl}" (capability targets "${localeUrl}") — not running`);   // v2.74.925 (CR-T2) — marker so the decisions story shows the exit
          sendResponse({ success: true, ran: false, reason: `the page is now "${String(liveUrl).slice(0, 80)}" but this capability targets "${String(localeUrl).slice(0, 80)}" — navigate there and re-run`, cover, intentShape: spec.shape });
          return;
        }
        const out = await ctx.runTrialBundle({ groundId, intent, roles, localeModel, navigateUrl: null, proposedRoleCount: roles.length, targetTabId: (typeof tabId === 'number' ? tabId : null) });
        // PB-7 copy-on-accept: stash a SESSION DRAFT (incl. the synthesized op, each action carrying its
        // inline landmark) so ACCEPT can materialize a durable, landmark-backed capability without re-running.
        if (out?.ran) {
          await ctx.writeSgDraft(groundId, { intent, spec, selection, cover, roles, trial: out.trial || null, result: out.result || null, draft: out.draft || null, deferred: Array.isArray(out.deferred) ? out.deferred : [], safetyClass: out.safetyClass || null, groundId, localeUrl, capturedAt: Date.now() });
        }
        const acceptEligible = !!(out?.ran && out.trial?.verdict === 'trial-pass' && (spec.shape !== 'complete' || cover.complete === true));
        sendResponse({ ...out, cover, intentShape: spec.shape, acceptEligible });
      } catch (err) {
        Logger.error('background', `RUN_SG_TRIAL failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      } finally {
        if (_busyTab != null) markEngineBusy(_busyTab, false);   // v2.74.912
      }
    },

    // SG-5 / PB-7 — ACCEPT a passing trial: materialize the session draft into a durable capability +
    // promote proto-landmarks → saved Landmarks + a model Perspective + a landmark-backed Fragment/Strategy.
    ACCEPT_SG_TRIAL: async (payload, _sender, sendResponse) => {
      try {
        const { groundId = null, tabId = null } = payload ?? {};
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        const draft = await ctx.readSgDraft(groundId);
        if (!draft) { sendResponse({ success: true, accepted: false, reason: 'no trial to accept — run the trial first' }); return; }
        // SG-T2-ACC — promote a TIER-2 op into a durable, replayable MULTI-fragment capability: one Fragment
        // per phase (re-synthesized WITHOUT the trial's commit-deferral, so the steps include the real commit
        // CLICK) + one Strategy that chains them via fragmentSteps. Replay runs executeStrategy(strategyId)
        // for REAL (commits included) — so the filters actually apply, the thesis payoff. Steps keep inline
        // landmarks (SG-LM-3), so replay self-heals via probe-or-recover without a registry round-trip.
        if (draft.tier2 && draft.op && Array.isArray(draft.op.nodes)) {
          // SG-T2-10 — refuse to promote an uncovered completion op (the job-alert-email false pass): the
          // acceptEligible flag already hides the button, but guard here too so a stale draft can't be promoted.
          if (draft.spec && draft.spec.shape === 'complete' && draft.cover && draft.cover.complete === false) {
            sendResponse({ success: true, accepted: false, reason: `intent not covered — ${draft.cover.reason || 'required fields/submit missing'}` }); return;
          }
          let localeModel = null;
          try { const pm = await ctx.readLocaleCache(groundId, ctx.normalizeUrl(draft.localeUrl || '')); localeModel = pm?.model || null; } catch { /* */ }
          const phaseNodes = orderForRun(draft.op.nodes, localeModel);
          // HS-1 (v2.74.898) — keep the IR's HETEROGENEITY through accept. Observation nodes (the trial
          // already executed their extracts) and url-mode navigate nodes persist as STRATEGY STEPS the
          // engine's walker natively runs; only action nodes go through action synthesis. Pre-HS, EVERY
          // node was forced through synthesizeTrialOp and non-action nodes were silently dropped — a
          // taught "act → read → act" flow lost its read. (Analysis + click-mode navigate nodes are still
          // not lowered — HS-2+; the click usually lives in the adjacent fragment's actions anyway.)
          const nodes = [];
          for (const node of phaseNodes) {
            if (node.type === 'observation' && Array.isArray(node.extracts) && node.extracts.length) {
              nodes.push({ kind: 'observation', label: node.label, extracts: node.extracts });
              continue;
            }
            if (node.type === 'navigate' && node.mode === 'url' && node.url) {
              nodes.push({ kind: 'navigate', label: node.label, mode: 'url', url: node.url });
              continue;
            }
            const synth = synthesizeTrialOp({ groundedIntent: node.label, roles: node.roles, locale: localeModel });
            // Carry the node's postcondition (SG-T2-2 structural ∪ SG-T2-5 LLM) onto the phase so the persisted
            // Fragment keeps its success predicate(s) — previously dropped, leaving every synthesized fragment
            // with empty postconditions.
            if (synth && Array.isArray(synth.actions) && synth.actions.length) nodes.push({ kind: 'action', label: node.label, actions: synth.actions, postcondition: node.postcondition || null });
          }
          if (!nodes.some((n) => n.kind === 'action')) { sendResponse({ success: true, accepted: false, reason: 'no runnable phases to promote' }); return; }
          // T1-as-first-class — the persist path applies the taxonomy guard (a single pure-action phase →
          // a bare Fragment, no Strategy wrapper); any observation/navigate step forces a Strategy.
          const persisted = await persistHeteroTier2(nodes, { groundId, name: draft.intent, goal: draft.intent });
          if (!persisted.ok) { sendResponse(persisted.fatal ? { success: false, error: persisted.reason } : { success: true, accepted: false, reason: persisted.reason }); return; }
          const { isSingleT1, strategyId, fragmentIds, fragmentCount, observationIds = [], observationCount = 0 } = persisted;
          const capability = {
            id: crypto.randomUUID(), groundId, intent: draft.intent, shape: isSingleT1 ? 'tier1' : 'tier2',
            localeUrl: draft.localeUrl || '',
            ...(isSingleT1 ? { fragmentId: fragmentIds[0] } : { strategyId }), fragmentIds,
            ...(observationIds.length ? { observationIds } : {}),
            phases: nodes.map((n) => n.label),
            binding: [], synthesized: true, createdAt: Date.now(),
            trial: { score: draft.tier2Score?.score ?? null, verdict: draft.tier2Score?.verdict ?? null, trialRef: null },
          };
          await ctx.writeSgCapability(groundId, capability);
          try { await ctx.appendOutcomes(groundId, [Outcomes.makeStageEvent('accept', { groundId, verdict: 'accepted', input: { roleOrIntent: String(draft.intent).slice(0, 120) }, detail: { capabilityId: capability.id, ...(isSingleT1 ? { fragmentId: fragmentIds[0] } : { strategyId }), fragments: fragmentCount, ...(observationCount ? { observations: observationCount } : {}), shape: capability.shape, score: capability.trial.score } })]); } catch { /* */ }
          await ctx.clearSgDraft(groundId);
          Logger.info('background', `ACCEPT_SG_TRIAL[${isSingleT1 ? 'tier1' : 'tier2'}] — promoted ${capability.id} → ${isSingleT1 ? `bare Fragment ${fragmentIds[0]} (no Strategy wrapper)` : `strategy ${strategyId} chaining ${fragmentCount} fragment(s)${observationCount ? ` + ${observationCount} observation step(s)` : ''}`} [${capability.phases.join(' → ')}]`);
          sendResponse({ success: true, accepted: true, capability, fragmentCount, tier2: !isSingleT1 });
          return;
        }
        const built = buildAcceptance({
          intent: draft.intent, spec: draft.spec, cover: draft.cover, roles: draft.roles,
          trial: draft.trial, result: draft.result, selection: draft.selection,
          deferred: Array.isArray(draft.deferred) ? draft.deferred : [], safetyClass: draft.safetyClass || null,   // SG-INV-1 — terminal capture
          groundId, localeUrl: draft.localeUrl || '', acceptedAt: Date.now(),
        });
        if (!built.ok) { sendResponse({ success: true, accepted: false, reason: built.reason }); return; }
        // PROMOTE the proto-landmarks → saved registry Landmarks + a model-authored Perspective.
        let savedLm = 0;
        for (const { record } of built.landmarks) {
          try { await StorageManager.saveLandmark(record); savedLm++; }
          catch (e) { Logger.warn('background', `ACCEPT_SG_TRIAL saveLandmark(${record.uid}) failed: ${e.message}`); }
        }
        try { await StorageManager.savePerspective(built.perspective); }
        catch (e) { Logger.error('background', `ACCEPT_SG_TRIAL savePerspective failed: ${e.message}`); sendResponse({ success: false, error: `perspective save failed: ${e.message}` }); return; }
        // Promote the proven procedure → a persisted, landmark-backed Fragment + Strategy (replay runs THIS).
        let _refMissing = [];   // GA-8 — fail-soft ref-integrity diagnostic (filled below; never blocks accept)
        try {
          const dr = draft.draft;
          if (dr && Array.isArray(dr.actions) && dr.actions.length) {
            const fragmentId = crypto.randomUUID();
            const strategyId = crypto.randomUUID();
            const steps = landmarkRefActions(dr.actions, groundId, draft.localeUrl || '');
            // b6a — gate the fragment on its promoted perspective (non-fatal advisory perspective_ref), uniform with the demonstration path.
            const recs = CapabilitySynth.buildCapabilityRecords({ ...dr, actions: steps, name: built.perspective.name }, { groundId, fragmentId, strategyId, entryGate: buildPerspectiveGate(built.perspective.id) });
            if (recs) {
              await StorageManager.saveFragment(recs.fragment);
              await StorageManager.saveStrategy(recs.strategy);
              built.capability.fragmentId = fragmentId;
              built.capability.strategyId = strategyId;
              // GA-8 — every landmarkExists / perspective_ref we just persisted must resolve to a saved landmark/
              // perspective (or one already in storage). Surface a dangling ref instead of letting it silently fail
              // every re-trial. Confirm against storage before reporting (no false positive on a pre-existing ref).
              try {
                const _v = validateConditionRefs([built.perspective.predicates, recs.fragment.preconditions, recs.fragment.postconditions], { landmarkUids: built.landmarks.map((l) => l.uid), perspectiveIds: [built.perspective.id] });
                for (const m of _v.missing) {
                  let _exists = false;
                  try { _exists = (m.kind === 'perspective') ? !!(await StorageManager.getPerspective(m.id)) : !!(await StorageManager.getLandmark(m.id)); } catch { /* */ }
                  if (!_exists) _refMissing.push(m);
                }
                if (_refMissing.length) Logger.warn('background', `ACCEPT_SG_TRIAL ref-integrity — ${_refMissing.length} dangling ref(s): ${_refMissing.map((m) => `${m.kind}:${String(m.id).slice(0, 8)}`).join(', ')}`);
              } catch { /* diagnostic only — never blocks accept */ }
            }
          }
        } catch (e) { Logger.warn('background', `ACCEPT_SG_TRIAL fragment/strategy persist failed (continuing): ${e.message}`); }
        await ctx.writeSgCapability(groundId, built.capability);
        await ctx.writeSgTrace(built.trace);
        await ctx.appendOutcomes(groundId, [Outcomes.makeStageEvent('accept', {
          groundId, verdict: 'accepted', input: { roleOrIntent: String(draft.intent).slice(0, 120) },
          detail: { capabilityId: built.capability.id, perspectiveId: built.perspective.id, landmarks: savedLm, trialRef: built.capability.trial.trialRef, shape: built.capability.shape, score: built.capability.trial.score },
        })]);
        try { await ctx.broadcastStorageChanged('perspective', built.perspective.id, 'saved'); } catch { /* */ }
        await ctx.clearSgDraft(groundId);
        Logger.info('background', `ACCEPT_SG_TRIAL — promoted ${built.capability.id} → perspective ${built.perspective.id} + ${savedLm} landmark(s) (trialRef=${built.capability.trial.trialRef})`);
        sendResponse({ success: true, accepted: true, capability: built.capability, perspectiveId: built.perspective.id, landmarkCount: savedLm, refValidation: { ok: _refMissing.length === 0, missing: _refMissing } });
        // SG-LM-4b — deepen the saved (already recoverable) landmarks asynchronously: hierarchicalContext
        // + the rich profile. Fire-and-forget so accept stays instant; the tab is still on the page. Best-effort.
        if (typeof tabId === 'number') ctx.enrichSgLandmarks(tabId, built.landmarks).catch((e) => Logger.warn('background', `ACCEPT_SG_TRIAL enrichment failed (continuing): ${e.message}`));
      } catch (err) {
        Logger.error('background', `ACCEPT_SG_TRIAL failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // OBS-3 — DERIVE a durable, replayable capability from a recorded DEMONSTRATION (Path 3). NO LLM, no
    // Comprehend/Select: the user already did the task, so the steps are ground truth. Segment the trace into
    // Fragments (OBS-2), map each step → an executable action carrying its inline landmark (SG-LM-3), and
    // assemble N fragments + a chaining Strategy via buildTier2CapabilityRecords (the same records ACCEPT
    // produces). Replay runs executeStrategy for REAL — the demonstration repeats, commits included.
    DERIVE_OBSERVED_CAPABILITY: async (payload, _sender, sendResponse) => {
      try {
        const { groundId = null, trace = null, name = null } = payload ?? {};
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        if (!Array.isArray(trace) || !trace.length) { sendResponse({ success: false, error: 'no demonstration trace — record one first' }); return; }
        const op = segmentTrace(coalesce(trace));
        const phasesRaw = opToPhases(op).filter((p) => Array.isArray(p.actions) && p.actions.length);
        if (!phasesRaw.length) { sendResponse({ success: false, error: 'no runnable steps in the demonstration' }); return; }
        // OBS (v2.74.764) — RECONCILE-BEFORE-MINT: the observed path is the only authoring path that sources
        // landmark identity from the RAW demo (not the grounded Locale), so a selector that differs from the one
        // Explore catalogued mints a DUPLICATE landmark for the same element. Adopt the matching Locale feature's
        // canonical identity first (resolve-by-reuse, PB-2, applied to the demonstration path) so downstream uid
        // minting collides with the catalog instead of forking. Best-effort: no Locale → unchanged (no regression).
        let reconLocales = [];
        try { reconLocales = (await listLocales(groundId)).map((e) => ({ url: e.url, features: e.model && e.model.features })); }
        catch (e) { Logger.warn('background', `DERIVE_OBSERVED listLocales failed: ${e.message}`); }
        const recon = reconcileObservedLandmarks(phasesRaw, reconLocales);
        if (recon.total) Logger.info('background', `DERIVE_OBSERVED — reconciled ${recon.reconciled}/${recon.total} demonstrated landmark(s) to grounded Locale features`);
        const phasesGrounded = recon.phases;
        const params = deriveObservedParams(op);   // OBS-4 — reusable param schema (typed fields + option choices)
        // OBS-3b — DERIVE DURABLE LANDMARKS from the demonstrated elements (your step 3): each step carries an
        // inline landmark (role + accessibleName + hierarchicalContext + selector); mint a per-Ground Landmark
        // record per unique identity and convert every step to a `landmarkRef` so the capability is
        // landmark-backed (registry recovery), NOT raw selectors — same shape the NL-path ACCEPT produces.
        // Per-page UIDs (mintLandmarkUid uses the phase's url), since a demonstration spans pages.
        const landmarkRecords = []; const seenUid = new Set();
        const phases = phasesGrounded.map((p) => {
          // OBS (v2.74.764) — mint uids against the grounded Locale url when this phase reconciled to one (no query
          // noise → stable, catalog-aligned uids); fall back to the raw phase url otherwise.
          const mintUrl = p.localeUrl || p.url;
          const rolesLike = p.actions.filter((a) => a.landmark).map((a) => ({ role: a.landmark.accessibleName, landmark: a.landmark }));
          const profBySel = new Map();   // selector → the record-time profile captured by the recorder
          for (const a of p.actions) if (a.landmark && a.landmark.selector) profBySel.set(a.landmark.selector, a.landmark);
          for (const { uid, record } of buildLandmarkRecords({ roles: rolesLike, groundId, localeUrl: mintUrl })) {
            if (seenUid.has(uid)) continue;
            seenUid.add(uid);
            // OBS-3b/#3 — populate the record from the record-time identity (the demo can't be re-profiled).
            const lm = profBySel.get(record.selector);
            if (lm) { record.boundingBox = lm.rect || null; record.textContent = lm.text || null; record.attributes = lm.attrs || null; }
            // OBS-#2 — the DEMONSTRATION is the verification: the user used this exact element successfully.
            record.lifecycle = 'verified'; record.verifiedBy = 'demonstration'; record.verifiedAt = Date.now(); record.source = 'observed';
            landmarkRecords.push(record);
          }
          // b5 (v2.74.766) — promote an in-place (SPA) success region to a verified Perspective Landmark so the
          // success state is tracked substrate (monitor-visible, self-healing-eligible), not a free-floating
          // selector. seenUid → buildPerspectiveRecord, so it joins the perspective's activation predicate (b3).
          let outcomeUid = null;
          if (p.settleSelector) {
            const sl = p.settleLandmark || {};
            const outcome = buildResultsLandmarkRecord({ settleSelector: p.settleSelector, role: sl.role, accessibleName: sl.accessibleName, text: sl.text, groundId, localeUrl: mintUrl });
            if (outcome) { outcomeUid = outcome.uid; if (!seenUid.has(outcome.uid)) { seenUid.add(outcome.uid); landmarkRecords.push(outcome); } }
          }
          return { label: p.label, url: p.url, to: p.to, settleSelector: p.settleSelector || '', localeUrl: mintUrl, outcomeUid, actions: landmarkRefActions(p.actions, groundId, mintUrl) };
        });
        for (const rec of landmarkRecords) { try { await StorageManager.saveLandmark(rec); } catch (e) { Logger.warn('background', `DERIVE_OBSERVED saveLandmark failed: ${e.message}`); } }
        // OBS-4b — PARAMETERIZE first (so the description + records read the TEMPLATED structure): rewrite each
        // demonstrated input to a `{{NAME}}` placeholder (text → value, option → CLICK_BY_LABEL/SELECT); the
        // demonstrated value rides along as the param default, so a no-override replay reproduces the demo.
        const paramz = parameterizeObserved(phases, params);
        const runPhases = paramz.phases;
        // SG-T2 (v2.74.761) / OBS (v2.74.763) — derive each phase's success postcondition from its page-state
        // boundary (the signal the structural floor often can't see): a NAVIGATION → `url_matches` on the
        // destination path; an IN-PLACE SPA swap → `selector_present` on the swapped-in container. One pure rule
        // (derivePhasePostcondition) so nav and in-place can't drift. buildTier2CapabilityRecords carries
        // phase.postcondition → fragment.postconditions (array shape).
        for (const rp of runPhases) { const pc = derivePhasePostcondition(rp); if (pc) rp.postcondition = pc; }
        const namedParams = paramz.params;
        // ORCH-D — describe FROM the structure (phases of step-kinds + params with example values + vocab), not
        // a loose transcript: a faithful projection + seed aliases. Heuristic fallback so it never blocks on LLM.
        let described = null;
        if (!(name && name.trim())) {
          try { described = await AnthropicService.describeTrace({ structure: describeTraceInput(runPhases, namedParams) }); } catch { /* */ }
        }
        const capName = ((name && name.trim()) || (described && described.name) || `Recorded: ${phases.map((p) => p.label).join(' → ')}`).slice(0, 80);
        const capDescription = (described && described.intent) || capName;
        // ORCH-D — seed the capability's aliases from the model's suggestions; the flywheel later accretes
        // confirmed asks (ORCH_RECORD_ALIAS). accreteAlias dedups + drops phrasings the intent already covers.
        let seedAliases = [];
        for (const a of (described && Array.isArray(described.aliases) ? described.aliases : [])) seedAliases = accreteAlias(seedAliases, a, { intent: capName });
        const localeUrl = (trace.find((a) => a && a.url) || {}).url || '';
        const protoLandmarkUids = [...seenUid];
        // OBS-3c / dedup (v2.74.772) — compose the derived landmarks into a PERSPECTIVE (the intent-scoped grouping
        // the library shows). QUALIFY against existing perspectives ON THIS LOCALE first: a Perspective IS the
        // landmark SELECTION (GROUND_SPEC §3), so an existing one on the same page with the SAME landmark set IS
        // this perspective — reuse it instead of forking on the (volatile, LLM-phrased) intent ("by title" vs "by
        // keyword"). The intent is a LABEL; the substrate is the identity.
        let existingPersps = [];
        try { existingPersps = await StorageManager.listPerspectives(groundId); } catch (e) { Logger.warn('background', `DERIVE_OBSERVED listPerspectives failed: ${e.message}`); }
        const matchedPersp = findMatchingPerspective(existingPersps, { localeUrl, landmarkUids: protoLandmarkUids });
        let perspectiveId;
        if (matchedPersp) {
          perspectiveId = matchedPersp.id;
          Logger.info('background', `DERIVE_OBSERVED — reusing perspective ${matchedPersp.id} ("${matchedPersp.name}") — same ${protoLandmarkUids.length}-landmark selection on this page; "${capName}" is a re-phrasing of its intent`);
        } else {
          const perspective = buildPerspectiveRecord({ intent: capName, spec: { shape: 'observed', target: capName }, groundId, localeUrl, landmarkUids: protoLandmarkUids });
          try { await StorageManager.savePerspective(perspective); } catch (e) { Logger.warn('background', `DERIVE_OBSERVED savePerspective failed: ${e.message}`); }
          perspectiveId = perspective.id;
        }
        // b5c (v2.74.768) — give each IN-PLACE (SPA) phase a distinct OUTCOME Perspective (its results region) and
        // point the fragment's postcondition at perspective_ref(it): the success check expressed as substrate, not a
        // raw selector. perspective_ref over a single results landmark expands to selector_present on that selector,
        // so behaviour is unchanged; the gain is a monitor-visible outcome perspective + a self-healing reference.
        // Nav phases keep their url_matches (derivePhasePostcondition); only in-place phases (with an outcomeUid) switch.
        for (let i = 0; i < runPhases.length; i++) {
          const rp = runPhases[i];
          if (!rp || !rp.outcomeUid) continue;
          // v2.74.783 — never build an OUTCOME perspective (→ perspective_ref postcondition) from an OPERATIVE
          // control. If the "outcome" landmark is one of the demonstrated input/button uids it is precondition-
          // shaped (present before AND after the action), so a perspective_ref to it is an always-true success
          // check — the perspective_ref analog of the search-box bug. Leave the honest derived postcondition.
          if (protoLandmarkUids.includes(rp.outcomeUid)) continue;
          const out = buildOutcomePerspective({ intent: capName, groundId, localeUrl: rp.localeUrl || rp.url, resultsUid: rp.outcomeUid, discriminator: String(i) });
          if (!out) continue;
          try { await StorageManager.savePerspective(out.perspective); rp.postcondition = out.postcondition; }
          catch (e) { Logger.warn('background', `DERIVE_OBSERVED outcome perspective save failed: ${e.message}`); }
        }
        // b6b (v2.74.775) — a NAVIGATING phase's success is reaching a new page (a NODE); derivePhasePostcondition
        // expressed that as url_matches on the destination path — an EDGE fact mis-applied as a node postcondition.
        // When the DESTINATION page is already GROUNDED (an existing perspective there carries a landmark), express
        // the success as SUBSTRATE instead: a perspective_ref to a destination perspective (monitor-visible, self-
        // healing). Ungrounded destination → keep url_matches (the bootstrap rung) until the page is grounded or the
        // recorder captures a landing landmark (b6c). SPA phases (outcomeUid) already switched above — skip them.
        for (let i = 0; i < runPhases.length; i++) {
          const rp = runPhases[i];
          if (!rp || rp.outcomeUid) continue;
          if (!rp.to || !rp.postcondition || rp.postcondition.source !== 'url-nav') continue;
          // v2.74.776 — guarded: CROSS-PAGE only (a same-canonical-page query change is not a new node) and never
          // anchored on this capability's own operative controls (protoLandmarkUids). Both guards stop b6b minting
          // a destination perspective that just echoes the operative one (the "odd duplicate" on a re-search).
          const destUid = pickDestinationLandmark(existingPersps, rp.to, { sourceUrl: rp.localeUrl || rp.url || '', excludeUids: protoLandmarkUids });
          if (!destUid) continue;   // same-page change / ungrounded / only operative controls → keep url_matches
          // dedup — reuse an existing destination perspective with the SAME arrival landmark on this page (don't fork)
          const existingDest = findMatchingPerspective(existingPersps, { localeUrl: rp.to, landmarkUids: [destUid] });
          if (existingDest) {
            rp.postcondition = { match: 'all', conditions: [{ type: 'perspective_ref', perspectiveId: existingDest.id }], source: 'destination-perspective' };
            Logger.info('background', `DERIVE_OBSERVED — nav phase ${i} postcondition → reused destination perspective ${existingDest.id}`);
            continue;
          }
          const dest = buildDestinationPerspective({ intent: capName, groundId, destLocaleUrl: rp.to, destLandmarkUid: destUid, discriminator: String(i) });
          if (!dest) continue;
          try {
            await StorageManager.savePerspective(dest.perspective);
            rp.postcondition = dest.postcondition;
            Logger.info('background', `DERIVE_OBSERVED — nav phase ${i} postcondition → destination perspective ${dest.perspective.id} (was url_matches on ${rp.to})`);
          } catch (e) { Logger.warn('background', `DERIVE_OBSERVED destination perspective save failed: ${e.message}`); }
        }
        // T1-as-first-class taxonomy fix — a demonstration that segments to a SINGLE page-state-bounded phase is
        // one Fragment, NOT a Strategy (same rule as the SG-trial accept). ≥2 phases still chain into a Strategy.
        // The lone Fragment IS the capability — give it the LLM-polished name/description (not "<label> — steps").
        // The sgCapability carries the aliases either way, so the chat matcher is unaffected. Shared persist path
        // (persistTier1or2) applies the same taxonomy guard + record shaping as the SG-trial accept.
        // b6a — bind the operative perspective onto the ENTRY fragment as a NON-FATAL substrate gate (advisory
        // perspective_ref, evaluated via isPerspectiveActive). The fragment is no longer disconnected from the
        // perspective we built: it's the fragment's visible, monitorable precondition.
        const entryGate = buildPerspectiveGate(perspectiveId);
        const persisted = await persistTier1or2(runPhases, { groundId, name: capName, goal: capName, params: namedParams, aliases: seedAliases, fragmentName: capName, fragmentDescription: capDescription, entryGate });
        if (!persisted.ok) { sendResponse({ success: false, error: persisted.reason }); return; }
        const { isSingleT1, strategyId, fragmentIds, fragmentCount } = persisted;
        const capability = {
          id: crypto.randomUUID(), groundId, intent: capName, description: capDescription, shape: 'observed', source: 'observed',
          localeUrl, perspectiveId,
          ...(isSingleT1 ? { fragmentId: fragmentIds[0] } : { strategyId }), fragmentIds,
          landmarkUids: [...seenUid], params: namedParams, aliases: seedAliases, phases: phases.map((p) => p.label), binding: [], synthesized: true,
          createdAt: Date.now(), trial: { score: null, verdict: 'observed', trialRef: null },
        };
        await ctx.writeSgCapability(groundId, capability);
        try { await ctx.appendOutcomes(groundId, [Outcomes.makeStageEvent('accept', { groundId, verdict: 'accepted', input: { roleOrIntent: capName.slice(0, 120) }, detail: { capabilityId: capability.id, perspectiveId, strategyId, fragments: fragmentCount, landmarks: landmarkRecords.length, shape: 'observed' } })]); } catch { /* */ }
        try { await ctx.broadcastStorageChanged('perspective', perspectiveId, 'saved'); } catch { /* */ }
        const tmplCount = namedParams.filter((p) => p.used).length;
        Logger.info('background', `DERIVE_OBSERVED_CAPABILITY — "${capName}" ${capability.id} → perspective ${perspectiveId} + ${isSingleT1 ? `bare Fragment ${fragmentIds[0]} (no Strategy wrapper)` : `strategy ${strategyId} chaining ${fragmentCount} fragment(s)`} + ${landmarkRecords.length} landmark(s) + ${namedParams.length} param(s) (${tmplCount} templated for re-run) [${capability.phases.join(' → ')}]`);
        sendResponse({ success: true, capability, perspectiveId, fragmentCount, landmarkCount: landmarkRecords.length, paramCount: namedParams.length });
      } catch (err) {
        Logger.error('background', `DERIVE_OBSERVED_CAPABILITY failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // G1-1 (v2.74.851) — the AUTO-GROUND entrypoint. Today an ask on a site with no Ground
    // dead-ends (ORCH_MATCH → 'no-ground' miss); the auto-explore orchestrator (EX-6) needs to
    // be able to MINT a Ground on demand. ensureGroundForUrl is IDENTITY-AT-CREATION
    // (dedup-BEFORE-mint): resolve an existing Ground via the canonical urlPatterns matcher
    // FIRST (so a sibling/merged host REUSES, never creating a duplicate), and mint only when
    // there is genuinely no match. The reuse-vs-mint decision + the site-name derivation are
    // pure (Core/groundDedup.planEnsureGround, reusing siteIdentity().brand); this handler
    // supplies the live ground list + performs the create. READ-ONLY when a Ground exists.
    ENSURE_GROUND_FOR_URL: async (payload, _sender, sendResponse) => {
      try {
        const { url = '' } = payload ?? {};
        if (typeof url !== 'string' || !url.trim()) { sendResponse({ success: false, error: 'url required' }); return; }
        let grounds = [];
        try { grounds = await StorageManager.getAllGrounds(); } catch { grounds = []; }
        const existingId = _groundIdForUrl(url, grounds);
        const plan = planEnsureGround({ url, existingGroundId: existingId });
        if (plan.action === 'reuse') {
          let ground = null; try { ground = await StorageManager.getGround(existingId); } catch { /* */ }
          const r = await _readinessForGround(ctx, existingId);   // G1-3 — the orchestrator wants the Ground's state up front
          Logger.info('background', `ensureGroundForUrl: reuse Ground ${existingId} for ${url} (dedup-before-mint hit; readiness ${r.state})`);
          sendResponse({ success: true, groundId: existingId, created: false, ground, readiness: r.state, counts: r.counts });
          return;
        }
        if (plan.action === 'invalid') { sendResponse({ success: false, error: `cannot derive a Ground from url: ${url}` }); return; }
        const ground = await GroundManager.create({ name: plan.name, url: plan.url });
        const r = await _readinessForGround(ctx, ground?.id);   // a freshly-minted Ground reads back 'empty'
        Logger.info('background', `ensureGroundForUrl: MINTED Ground ${ground?.id} "${plan.name}" for ${url} (no existing match; readiness ${r.state})`);
        sendResponse({ success: true, groundId: ground?.id ?? null, created: true, ground, readiness: r.state, counts: r.counts });
      } catch (err) {
        Logger.error('background', `ENSURE_GROUND_FOR_URL failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // G1-3 (v2.74.853) — a Ground's READINESS for unattended use: empty | preparing | capable | rich,
    // from live substrate counts (Locales modeled, active capabilities, siteMap nodes). The auto-explore
    // orchestrator gates on this (an empty Ground must be explored first; a capable one can replay an
    // existing capability). Pure classifier (Core/groundReadiness); this handler just supplies the counts.
    GET_GROUND_READINESS: async (payload, _sender, sendResponse) => {
      try {
        const { groundId } = payload ?? {};
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        const r = await _readinessForGround(ctx, groundId);
        sendResponse({ success: true, groundId, readiness: r.state, rank: r.rank, counts: r.counts });
      } catch (err) {
        Logger.error('background', `GET_GROUND_READINESS failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // IM-2 (v2.74.895) — the INTENT MENU: "what can I do here?" answered from the substrate. ZERO LLM —
    // taught capabilities (active + non-orphan, the .889 deep filter), the Ground's Locale GOALS (union
    // across explored pages), the siteMap goal catalog (prevalence), and G1-3 readiness, composed by the
    // pure buildIntentMenu into ranked run-now / teachable / explore-first entries. A clicked entry's `ask`
    // re-enters the NORMAL chat route — run-now hits the alias warm path, teachable lands in teach/trial.
    GET_INTENT_MENU: async (payload, _sender, sendResponse) => {
      try {
        const { tabId = null, url: urlIn = null, limit = 5 } = payload ?? {};
        let url = (typeof urlIn === 'string' && urlIn) ? urlIn : null;
        if (!url && typeof tabId === 'number') { try { url = (await chrome.tabs.get(tabId))?.url || null; } catch { /* */ } }
        let gid = null;
        try { const grounds = await StorageManager.getAllGrounds(); gid = url ? _groundIdForUrl(url, grounds) : null; } catch { /* */ }
        if (!gid) { sendResponse({ success: true, groundId: null, menu: buildIntentMenu({ readiness: 'empty', limit }) }); return; }
        const { liveStrategyIds, liveFragmentIds, strategyFragments } = await _liveBackingIds(gid);
        const _orphan = (c) => isOrphanCapability(c, { liveStrategyIds, liveFragmentIds, strategyFragments });
        let caps = [];
        try { caps = ((await ctx.readSgCapabilities(gid)) || []).filter((c) => isActiveCapability(c) && !_orphan(c)); } catch { /* */ }
        let goals = [];
        try {
          const locs = (await listLocales(gid)) || [];
          for (const e of locs.slice(0, 8)) for (const g of Object.values(e?.model?.goals || {})) if (g && g.label) goals.push({ id: g.id || g.label, label: g.label });
        } catch { /* */ }
        let siteCatalog = null;
        try { const sm = ctx.readSiteMap ? await ctx.readSiteMap(gid) : null; if (sm) siteCatalog = siteMapCapabilities(sm); } catch { /* */ }
        let readiness = null;
        try { readiness = (await _readinessForGround(ctx, gid)).state; } catch { /* */ }
        const menu = buildIntentMenu({ caps, goals, siteCatalog, readiness, limit });
        Logger.info('background', `INTENT_MENU ▸ ${menu.entries.length} entr${menu.entries.length === 1 ? 'y' : 'ies'} (${menu.counts.taught} taught, ${menu.counts.teachable} teachable, ${menu.counts.goals} goal(s); readiness=${readiness || '—'}) [${String(gid).slice(-6)}]`);
        sendResponse({ success: true, groundId: gid, menu });
      } catch (err) {
        Logger.error('background', `GET_INTENT_MENU failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // RI-2 (v2.74.897) — COMPOSE rich, multi-step intents from the whole Ground: the substrate is curated
    // into a bounded context pack (RI-1 buildIntentContext — taught caps + verified vocab, observations,
    // goals + coverage, the archetype graph, the runtime's composition primitives), ONE LLM call composes
    // user-language intents over it, and the PURE cite-or-reject gate drops any intent whose step doesn't
    // ground in the pack (no hallucinated capabilities/options — substrate-constrains-generation). Cached
    // by pack fingerprint: the LLM runs once per substrate STATE, not per ask.
    PROPOSE_RICH_INTENTS: async (payload, _sender, sendResponse) => {
      try {
        const { tabId = null, url: urlIn = null, count = 8, force = false, cachedOnly = false } = payload ?? {};
        let url = (typeof urlIn === 'string' && urlIn) ? urlIn : null;
        if (!url && typeof tabId === 'number') { try { url = (await chrome.tabs.get(tabId))?.url || null; } catch { /* */ } }
        let gid = null, ground = null;
        try {
          const grounds = await StorageManager.getAllGrounds();
          gid = url ? _groundIdForUrl(url, grounds) : null;
          ground = gid ? (grounds.find((g) => g && (g.id === gid || g.groundId === gid)) || null) : null;
        } catch { /* */ }
        if (!gid) { sendResponse({ success: true, groundId: null, intents: [], reason: 'no ground for this page' }); return; }
        const { liveStrategyIds, liveFragmentIds, strategyFragments } = await _liveBackingIds(gid);
        const _orphan = (c) => isOrphanCapability(c, { liveStrategyIds, liveFragmentIds, strategyFragments });
        let caps = [];
        try { caps = ((await ctx.readSgCapabilities(gid)) || []).filter((c) => isActiveCapability(c) && !_orphan(c)); } catch { /* */ }
        let locales = [];
        try { locales = (await listLocales(gid)) || []; } catch { /* */ }
        let siteMap = null;
        try { siteMap = ctx.readSiteMap ? await ctx.readSiteMap(gid) : null; } catch { /* */ }
        let readiness = null;
        try { readiness = (await _readinessForGround(ctx, gid)).state; } catch { /* */ }
        const pack = buildIntentContext({ ground, locales, siteMap, caps, readiness });
        const fp = intentContextFingerprint(pack);
        const hit = !force && _richIntentCache.get(fp);
        if (hit) { sendResponse({ success: true, groundId: gid, fingerprint: fp, cached: true, intents: hit.intents, rejectedCount: hit.rejected.length }); return; }
        // v2.74.900 — cachedOnly: a cheap probe for surfaces that must stay instant (the chat empty state).
        // Never triggers a compose; the meta-ask path does the first (and usually only) LLM call.
        if (cachedOnly) { sendResponse({ success: true, groundId: gid, fingerprint: fp, cached: false, intents: [], reason: 'not composed yet' }); return; }
        const raw = await AnthropicService.proposeRichIntents({ packText: renderIntentContext(pack), count });
        if (!raw || !Array.isArray(raw.intents)) {
          Logger.warn('background', `RICH_INTENTS ▸ composer returned nothing parseable [${String(gid).slice(-6)} fp=${fp}] — see AnthropicService warns`);   // v2.74.901 — the 21:53 silent-vanish
          sendResponse({ success: true, groundId: gid, fingerprint: fp, intents: [], reason: 'composer unavailable' }); return;
        }
        const { intents, rejected } = validateRichIntents(raw.intents, pack);
        // v2.74.899 — never cache an EMPTY compose: the 21:23 live run cached "0 accepted" under the
        // fingerprint, so a re-ask kept serving nothing until an SW restart even after the gate was fixed.
        // An empty result is a failure state to retry, not a substrate fact to memoize.
        if (intents.length) {
          _richIntentCache.set(fp, { intents, rejected, at: Date.now() });
          while (_richIntentCache.size > RICH_INTENT_CACHE_CAP) _richIntentCache.delete(_richIntentCache.keys().next().value);
        }
        for (const r of rejected) Logger.info('background', `RICH_INTENTS ▸ rejected "${r.title.slice(0, 50)}" — ${r.reason}`);
        Logger.info('background', `RICH_INTENTS ▸ ${intents.length} accepted, ${rejected.length} rejected (cite-or-reject) [${String(gid).slice(-6)} fp=${fp}]`);
        sendResponse({ success: true, groundId: gid, fingerprint: fp, cached: false, intents, rejectedCount: rejected.length });
      } catch (err) {
        Logger.error('background', `PROPOSE_RICH_INTENTS failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // C1 (v2.74.856) — the MONITORING demand set (Track phase). Given a Ground, return which
    // landmarks to watch and for which interaction kinds, derived from the landmarks referenced by
    // the Ground's ACCEPTED Perspectives (listLandmarksForGround joins perspectives × registry — a
    // set perspectiveId means linked/accepted). The role→kinds policy is pure
    // (Core/interactionDemand.buildInteractionDemand); this handler just supplies the landmarks +
    // their a11yRole. Demand-driven capture (C2) will attach listeners ONLY to this set, scoping
    // cost to |demand set| per tab, not |all DOM|. READ-ONLY — captures nothing.
    GET_INTERACTION_DEMAND: async (payload, _sender, sendResponse) => {
      try {
        const { groundId } = payload ?? {};
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        let landmarks = [];
        try { landmarks = await listLandmarksForGround(groundId); } catch { landmarks = []; }
        // v2.74.865 — "capture all, then resolve": the demand set is a MATCHING HINT, not a filter.
        // Watch EVERY known registry landmark for this Ground (selector present) — NOT only those a
        // saved Perspective references. perspectiveId rides along as annotation (null = registry
        // landmark not yet linked to a Perspective). The old `l.perspectiveId` filter made a
        // freshly-explored Ground resolve every interaction to 'miss' (empty demand). a11yRole is the
        // watch-kind signal; buildInteractionDemand dedups by uid (mismatched landmarks excluded upstream).
        const watch = (Array.isArray(landmarks) ? landmarks : []).filter((l) => l && l.uid && l.selector);
        const demand = buildInteractionDemand([{ landmarks: watch.map((l) => ({ landmarkUid: l.uid, role: l.a11yRole })) }], { groundId });
        Logger.info('background', `GET_INTERACTION_DEMAND: ${demand.length} landmark(s) in the demand set for ${groundId} (from ${watch.length}/${(landmarks || []).length} registry landmark(s) with a selector)`);
        sendResponse({ success: true, demand });
      } catch (err) {
        Logger.error('background', `GET_INTERACTION_DEMAND failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // C2 (v2.74.857) — L0 capture SINK. A content-script listener (C2b, demand-scoped) posts a raw DOM
    // interaction; this shapes/validates it via the PURE makeRawInteraction (which enforces the privacy
    // invariant — a RawInteraction NEVER carries a typed value) and stamps the canonical url + a stable
    // id (from the SENDER, not the page's claim). C2 stops at capture: L1 resolve (C3) + classify/trace
    // (C4) consume the RawInteraction next. Dormant until C2b's listeners exist + a session is started.
    INTERACTION_RAW: async (payload, sender, sendResponse) => {
      try {
        const tabId = sender?.tab?.id ?? (payload && payload.tabId) ?? -1;
        // v2.74.908 — the bot's own actions are NOT user interactions: drop events from a tab with an
        // engine run in flight (see _engineBusyTabs). Keeps the trace ring, the C4 stream, and the C5
        // outcomes flush USER-only.
        if (typeof tabId === 'number' && _engineBusyTabs.has(tabId)) { sendResponse({ success: true, dropped: 'engine-run' }); return; }
        const raw = makeRawInteraction({
          ...(payload || {}),
          tabId,
          frameId: sender?.frameId ?? 0,
          url: ctx.normalizeUrl((sender && sender.url) || (payload && payload.url) || ''),
          ts: Date.now(),
        });
        if (!raw) { sendResponse({ success: false, error: 'unknown interactionKind' }); return; }
        // C3 (L1) — assemble the ResolvedInteraction. Ground from the per-tab session map (no per-event
        // getAllGrounds); active perspectives read live for the classifier's context (C4 next).
        let groundId = _interactionSessions.get(tabId)?.groundId ?? null;
        // v2.74.933 (CR-M3) — an MV3 idle restart wipes the session map while the tab's content-script
        // listeners keep posting: events resolved groundId:null and their C5 usage outcomes were silently
        // dropped at the null-ground guard until the next tab event re-ran _autoMonitorTab. On a miss,
        // fall back to URL→ground (one getAllGrounds — restart-rare) and RE-SEED the map.
        if (!groundId && raw.url) {
          try {
            groundId = _groundIdForUrl(raw.url, await StorageManager.getAllGrounds()) || null;
            if (groundId) {
              let host = ''; try { host = new URL(raw.url).host; } catch { /* */ }
              _interactionSessions.set(tabId, { groundId, host });
              Logger.info('background', `INTERACTION_RAW ▸ session re-seeded after SW restart (tab ${tabId} → ${groundId})`);
            }
          } catch { /* */ }
        }
        let activePerspectiveIds = [];
        try {
          if (groundId) {
            const aps = await listActivePerspectives(groundId, { tabUrl: raw.url, tabId });
            activePerspectiveIds = (Array.isArray(aps) ? aps : []).map((p) => p && (p.id || p.perspectiveId)).filter(Boolean);
          }
        } catch { /* */ }
        const resolved = resolveInteraction(raw, {
          matches: Array.isArray(payload?.matches) ? payload.matches : [],
          activePerspectiveIds, groundId, sensitive: !!payload?.sensitive,
        });
        // C4 (v2.74.892) — classify (C0) then RECORD: append the full ClassifiedInteraction to the session
        // ring (_interactionTrace) — completes the L0→L3 pipeline; the feed broadcast below stays a UI
        // side-channel, the trace is the system of record (GET_INTERACTION_TRACE). Classify/record failures
        // never block the capture ack.
        let verb = raw.interactionKind, tier = 'unresolved', seq = null;
        try {
          const cls = classifyResolved(resolved, { groundId, activePerspectiveIds });
          tier = cls?.tier || 'unresolved';
          verb = cls?.primary?.semanticVerb || cls?.candidates?.[0]?.semanticVerb || raw.interactionKind;
          const entry = InteractionTrace.appendEntry(_interactionTrace, cls, { ts: raw.ts, tabId, groundId });
          seq = entry ? entry.seq : null;
        } catch { /* */ }
        Logger.info('monitor', `INTERACTION ${resolved.resolutionStatus} ${raw.interactionKind} (${verb}) → [${resolved.matches.map((m) => m.landmarkUid).join(',') || '—'}] (${activePerspectiveIds.length} active) #${seq ?? '—'} @ ${raw.url}`);
        try {
          chrome.runtime.sendMessage({ type: 'INTERACTION_FEED', payload: {
            groundId, ts: raw.ts, kind: raw.interactionKind, status: resolved.resolutionStatus, tier, verb,
            landmarks: resolved.matches.map((m) => m.landmarkUid), name: raw.target?.accessibleName || '', tag: raw.target?.tagName || '', url: raw.url,
          } }, () => void chrome.runtime.lastError);
        } catch { /* no listener (panel closed) */ }
        sendResponse({ success: true, id: raw.id, status: resolved.resolutionStatus });
        void _flushInteractionOutcomes(ctx);   // C5 — threshold-batched durable flush; never delays the ack
      } catch (err) {
        Logger.error('background', `INTERACTION_RAW failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // C4 (v2.74.892) — read the recorded session trace (the L3 classified stream Interpret consumes).
    // Filters compose: tabId / groundId exact-match, sinceSeq for incremental pulls (pass the last seq you
    // saw — seq is monotonic across ring trims), limit = the most-recent tail. Entries are value-free by
    // construction. Empty until a monitor session has captured interactions (or after a SW restart — v1).
    GET_INTERACTION_TRACE: async (payload, _sender, sendResponse) => {
      try {
        const { tabId = null, groundId = null, sinceSeq = null, limit = null } = payload || {};
        const entries = InteractionTrace.snapshot(_interactionTrace, { tabId, groundId, sinceSeq, limit });
        sendResponse({ success: true, entries, stats: InteractionTrace.traceStats(_interactionTrace) });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    },

    // C6 (v2.74.858) — monitoring CONSENT gate (Track tier). DEFAULT-DENY: capture (C2b) must check
    // canTrack(host) and never attaches a listener without an explicit grant. The decision is pure
    // (Core/monitorConsent.canTrack); these handlers read/write the persisted record. The Studio/popup
    // toggle (C6-UI) drives SET; Interpret/Act are later consent tiers.
    GET_MONITOR_CONSENT: async (_payload, _sender, sendResponse) => {
      try {
        const got = await chrome.storage.local.get('monitor:consent');
        const consent = got?.['monitor:consent'] || MONITOR_CONSENT_DEFAULT;
        sendResponse({ success: true, consent, trackEnabled: consent?.track?.enabled === true });
      } catch (err) {
        Logger.error('background', `GET_MONITOR_CONSENT failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },
    SET_MONITOR_CONSENT: async (payload, _sender, sendResponse) => {
      try {
        const got = await chrome.storage.local.get('monitor:consent');
        const current = got?.['monitor:consent'] || MONITOR_CONSENT_DEFAULT;
        const next = withTrack(current, payload || {});
        await chrome.storage.local.set({ 'monitor:consent': next });
        Logger.info('background', `SET_MONITOR_CONSENT: Track ${next.track.enabled ? 'ENABLED' : 'disabled'} (${(next.track.excludeHosts || []).length} excluded host(s))`);
        sendResponse({ success: true, consent: next });
      } catch (err) {
        Logger.error('background', `SET_MONITOR_CONSENT failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // C2b (v2.74.859) — start/stop a demand-scoped interaction-capture session on a tab. START is the
    // CONSENT CHOKEPOINT: it computes the C1 demand (accepted-Perspective landmarks), enriches it with
    // selectors (toCaptureTargets), and sends START_INTERACTION_CAPTURE to the tab's content script —
    // but ONLY after canTrack() passes for the tab's host. No consent → no listeners attach (default-deny).
    INTERACTION_MONITOR_START: async (payload, _sender, sendResponse) => {
      try {
        let { tabId, groundId } = payload ?? {};
        if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' }); return; }
        let host = '', url = '';
        try { url = (await chrome.tabs.get(tabId))?.url || ''; host = new URL(url).host; } catch { /* */ }
        if (!groundId && url) { try { groundId = _groundIdForUrl(url, await StorageManager.getAllGrounds()); } catch { /* */ } }   // resolve from the tab so the UI only needs a tabId
        if (!groundId) { sendResponse({ success: false, error: 'no-ground', host }); return; }
        let consent = MONITOR_CONSENT_DEFAULT;
        try { consent = (await chrome.storage.local.get('monitor:consent'))?.['monitor:consent'] || MONITOR_CONSENT_DEFAULT; } catch { /* */ }
        if (!canTrack(consent, { host })) {
          Logger.info('background', `INTERACTION_MONITOR_START DENIED — no Track consent for ${host}`);
          sendResponse({ success: false, error: 'no-consent', host }); return;
        }
        let landmarks = []; try { landmarks = await listLandmarksForGround(groundId); } catch { landmarks = []; }
        // v2.74.865 — "capture all, then resolve": watch EVERY registry landmark with a selector, not
        // only Perspective-linked ones. The old `l.perspectiveId` filter emptied the demand on any Ground
        // whose registry landmarks weren't referenced by a saved Perspective → every interaction missed.
        // perspectiveId is now annotation only (null = unlinked registry landmark).
        const watch = (Array.isArray(landmarks) ? landmarks : []).filter((l) => l && l.uid && l.selector);
        const demand = buildInteractionDemand([{ landmarks: watch.map((l) => ({ landmarkUid: l.uid, role: l.a11yRole })) }], { groundId });
        const selectorByUid = {}; const metaByUid = {};
        for (const l of watch) { selectorByUid[l.uid] = l.selector; metaByUid[l.uid] = { perspectiveId: l.perspectiveId ?? null, role: l.a11yRole ?? null }; }
        // C3 — stamp perspectiveId + role on each capture target so the matched event needs NO per-event registry lookup.
        const targets = toCaptureTargets(demand, selectorByUid).map((t) => ({ ...t, ...(metaByUid[t.landmarkUid] || {}) }));
        _interactionSessions.set(tabId, { groundId, host });   // C3 — resolve a captured event's Ground by its tab
        const _sendStart = async () => { try { const r = await chrome.tabs.sendMessage(tabId, { type: 'START_INTERACTION_CAPTURE', payload: { targets } }, { frameId: 0 }); return !!r?.success; } catch { return null; } };
        let started = await _sendStart();
        if (started === null) {   // no content-script receiver (e.g. a tab open before the extension reloaded) — inject ONCE, then retry
          try { await chrome.scripting.executeScript({ target: { tabId }, files: ['ContentScripts/contentScript.js'] }); } catch { /* restricted page / already injecting */ }
          started = await _sendStart();
        }
        Logger.info('background', `INTERACTION_MONITOR_START: ${targets.length} target(s) on ${host} (from ${watch.length}/${(landmarks || []).length} registry landmark(s); consent ok, started=${started === true})`);
        sendResponse({ success: true, host, targets: targets.length, started });
      } catch (err) {
        Logger.error('background', `INTERACTION_MONITOR_START failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },
    INTERACTION_MONITOR_STOP: async (payload, _sender, sendResponse) => {
      try {
        const { tabId } = payload ?? {};
        if (typeof tabId === 'number') { _interactionSessions.delete(tabId); try { await chrome.tabs.sendMessage(tabId, { type: 'STOP_INTERACTION_CAPTURE' }, { frameId: 0 }); } catch { /* */ } }
        try { await _flushInteractionOutcomes(ctx, { force: true }); } catch { /* */ }   // C5 — session end = drain the tail below the batch threshold
        sendResponse({ success: true });
      } catch (err) {
        Logger.error('background', `INTERACTION_MONITOR_STOP failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ORCH-M0 — the HIT/MISS bridge: given the user's ask + the live page, decide whether the grounded
    // library already covers it (HIT → the caller REPLAYs that capability) or not (MISS → the caller asks for
    // a demonstration). DECISION-ONLY: it never executes — execution reuses REPLAY_SG_CAPABILITY. The funnel
    // (scope by Ground/Locale → rank → three-way gate w/ reversibility veto) is pure (Core/orchMatch.js); this
    // handler just supplies the live page context + the library. Lexical scorer for now (the LLM select+bind
    // call is ORCH-M); live precondition eval (the runnableHere seam, funnel stage 1) lands with ORCH-M too —
    // here the Locale scope is the executability proxy. See specs/DESIGN_intent_orchestration.md §4.
    ORCH_MATCH: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, ask = '' } = payload ?? {};
        if (typeof ask !== 'string' || !ask.trim()) { sendResponse({ success: false, error: 'ask required' }); return; }
        let url = '';
        if (typeof tabId === 'number') { try { const t = await chrome.tabs.get(tabId); url = t?.url ?? ''; } catch { /* */ } }
        const localeUrl = ctx.normalizeUrl(url);
        // ORCH-C — resolve the Ground from the live page when the caller (chat) only knows the tab. Match by
        // origin against the saved Grounds. No matching Ground → a clean "no-ground" miss (the chat falls back).
        let gid = groundId;
        let allGrounds = null;   // v2.74.801 — kept for the otherGround hint below (avoids a 2nd getAllGrounds when resolved here)
        if (!gid && url) {
          try {
            allGrounds = await StorageManager.getAllGrounds();
            gid = _groundIdForUrl(url, allGrounds);   // v2.74.824 — urlPatterns-aware (a merged sibling host resolves), origin fallback inside
          } catch { /* */ }
        }
        if (!gid) { sendResponse({ success: true, decision: 'miss', reason: 'no-ground', candidate: null, capabilityId: null, bindings: {}, gaps: [], alternatives: [], scoped: { here: 0, reachable: 0, off: 0 }, localeUrl }); return; }
        const caps = await ctx.readSgCapabilities(gid);
        // ORCH — a capability whose backing Strategy was deleted is an ORPHAN: it must be INVISIBLE to the
        // conversation (deletion is an implementation detail — the ask is just a fresh request). Build the set of
        // live Strategy ids once and exclude any capability that points at a missing one. Non-destructive (the
        // admin delete + REPLAY self-heal handle storage cleanup); only skipped when the read fails (liveIds=null
        // → no filtering, never a false mass-hide). An observation capability has no strategyId → always kept.
        const { liveStrategyIds, liveFragmentIds, strategyFragments } = await _liveBackingIds(gid);   // v2.74.827 — Strategy AND Fragment liveness
        const _orphan = (c) => isOrphanCapability(c, { liveStrategyIds, liveFragmentIds, strategyFragments });
        // ORCH — scope "here" by SITE (origin), not the demo's exact path. Many capabilities (a global search
        // bar, site nav) work from ANY page of the Ground, so pinning them to the demo URL wrongly hides them
        // ("search vectors" lived on another page than "search music", though both are search options
        // everywhere). Landmark recovery + confirm-first + graceful failure handle a capability that genuinely
        // needs a different page. Off-Ground was already filtered, so same-origin ≈ same Ground.
        const _origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
        const sameLocale = (a, b) => { const oa = _origin(a), ob = _origin(b); return (oa && ob) ? oa === ob : ctx.normalizeUrl(a) === ctx.normalizeUrl(b); };
        // ORCH-G — read the confirmation stream once; per-candidate health graduates the auto-fire bar.
        let outcomeStream = [];
        try { if (typeof ctx.readOutcomes === 'function') outcomeStream = (await ctx.readOutcomes(gid)) || []; } catch { /* */ }
        const projected = (Array.isArray(caps) ? caps : []).filter((c) => isActiveCapability(c) && !_orphan(c) && c.kind !== 'composite').map((c) => {   // ORCH-FB retracted + orphan invisible; composites (T2) run atomically via MATCH_COMPOSITE, not as per-clause candidates
          const cand = toCandidate(c);
          if (cand) cand.health = tallyCapabilityConfirmations(outcomeStream, cand.id);
          return cand;
        }).filter(Boolean);
        // ORCH — EFFECT SCOPING: a QUESTION ("what's the title?") wants a READ; an ACTION ("search jobs") wants a
        // fragment. The pool is otherwise effect-agnostic, so a read got ranked against irreversible actions —
        // noise, wasted LLM tokens, and a tail risk of a read landing on an action. classifyReadAsk is the SAME
        // read/action oracle the chat already uses to choose picker-vs-record. Read → observations only (none →
        // a clean miss, and the chat offers to capture one). Action → non-observations, falling back to the full
        // pool only when there are NO actions (guards an ask the read-classifier under-called as not-a-read).
        const _isReadCand = (c) => !!c && (c.kind === 'observation' || c.effect === 'read');
        const _askIsRead = classifyReadAsk(ask).isRead;
        let pool;
        if (_askIsRead) pool = projected.filter(_isReadCand);
        else { const _acts = projected.filter((c) => !_isReadCand(c)); pool = _acts.length ? _acts : projected; }
        Logger.info('background', `ORCH_MATCH scope ▸ ask=${_askIsRead ? 'READ' : 'ACTION'} → ${pool.length}/${projected.length} candidate(s) (effect-scoped${_askIsRead ? ', observations only' : ', actions only'})`);
        const parts = scopeAndPartition(pool, { currentGroundId: gid, currentLocaleUrl: localeUrl, sameLocale });
        // ORCH — rank over ALL same-Ground capabilities (here + reachable). The exact-locale "here vs reachable"
        // split produced "go to another page" dead-ends for site-wide affordances (search, login, join) and
        // hid real matches; relevance ranking + confirm-first + the origin-relaxed REPLAY drift guard + landmark
        // recovery decide whether it runs. Off-Ground stays excluded.
        const candidates = [...parts.here, ...parts.reachable];
        // ORCH-A — the Explore-built Locale catalogs the page's affordance labels (category tabs, filters,
        // buttons). Surfaced to the binder, an option can resolve to a page-known label the recorder never
        // captured (demonstrate "Vectors" → re-bind "Illustrations" because the page confirms it exists).
        let affordances = [];
        try { const pm = await ctx.readLocaleCache(gid, localeUrl); affordances = localeAffordanceLabels(pm && pm.model); } catch { /* */ }
        // ORCH-FB-2 — this Ground's confirm/reject history. Used BOTH ways: (1) as few-shot examples in the LLM
        // matcher (generalize corrections), and (2) as a deterministic relevance shaper in rankAndDecide below.
        const feedback = feedbackExamples(outcomeStream);
        let scorer; let llm = null;
        // An exact ALIAS hit identifies WHICH capability without the LLM (the warm, cost-saving path). But an alias
        // is the ask PHRASING, not its PARAM VALUES — "search jazz singer jobs in new york" and "search police
        // officer jobs in minneapolis" hit the SAME alias yet need DIFFERENT bindings. So a PARAMETERIZED alias-hit
        // candidate STILL needs the LLM bind pass to extract THIS ask's values; without it the executor replays the
        // Strategy's stale demonstrated defaults (v2.74.800 — the "ran a police-officer search for a jazz-singer
        // ask" bug). Parameterless alias hits stay fully LLM-free.
        const _aliasOf = (c) => (c.aliases || []).some((al) => normalizeAliasPhrase(al) === normalizeAliasPhrase(ask));
        const aliasHit = candidates.some(_aliasOf);
        const aliasHitNeedsBind = candidates.some((c) => _aliasOf(c) && (c.params || []).some((p) => p && p.used));
        if (candidates.length && (!aliasHit || aliasHitNeedsBind)) {
          try { llm = await AnthropicService.matchCapability({ ask, candidates, affordances, examples: feedback }); } catch { /* */ }
          // On a NON-alias match the LLM also SCORES (it selects). On an alias-hit we already KNOW the capability —
          // the LLM ran ONLY to extract param values, so DON'T let it re-score: keep the deterministic alias-exact
          // decision that always fires (its bindings are still consumed below). Decouples binding from selection.
          if (llm && !aliasHit) scorer = scoresToScorer(llm.scores);
        }
        const decision = rankAndDecide(ask, candidates, { ...(scorer ? { score: scorer } : {}), now: Date.now(), feedback });
        // ORCH-M/A — validate the LLM's option bindings against the candidate's captured vocabulary OR a label
        // the LIVE PAGE catalogs (affordances): in-set values snap + return as `bindings`; misses → `gaps`.
        let bindings = {}; let gaps = [];
        if (decision.candidate && llm && llm.bindings) { const v = validateBindings(llm.bindings, decision.candidate, affordances); bindings = v.bound; gaps = v.gaps; }
        // v2.74.801 — on a MISS, flag whether the ask references ANOTHER known Ground ("search pixabay for X" while on
        // Indeed). The chat uses this to offer running it THERE instead of teaching it on the wrong (current) site.
        // Computed only on a miss (a hit already belongs here), and only the named other Ground — a generic miss is null.
        let otherGround = null;
        if (decision.decision === 'miss') {
          try { if (!allGrounds) allGrounds = await StorageManager.getAllGrounds(); otherGround = _askNamesOtherGround(ask, allGrounds, gid); } catch { /* */ }
        }
        const lean = (c) => (c ? { id: c.id, intent: c.intent, strategyId: c.strategyId, reversible: c.reversible, params: c.params, kind: c.kind } : null);
        // reachable folded into here → the chat never says "go to another page" (planAssistantTurn keys navigate off reachable>0).
        const scoped = { here: candidates.length, reachable: 0, off: parts.off.length };
        const via = scorer ? 'llm' : (aliasHit ? 'alias' : 'lexical');   // alias-hit may bind via LLM but is alias-DECIDED
        // ── ORCH_MATCH diagnostics — full visibility into a match decision ──
        const _capLine = (c) => { const u = (c.params || []).filter((p) => p && p.used); return `${String(c.id).slice(0, 8)}:"${c.intent}"${u.length ? `[${u.map((p) => `${p.name}/${p.kind}${Array.isArray(p.vocabulary) ? `(${p.vocabulary.length}:${p.vocabulary.slice(0, 6).join('|')})` : ''}`).join(', ')}]` : ''}`; };
        Logger.info('background', `ORCH_MATCH ▸ ask="${String(ask).slice(0, 90)}" @ ${localeUrl || '(no url)'} ground=${gid}`);
        Logger.info('background', `  affordances(${affordances.length}): ${JSON.stringify(affordances.slice(0, 40))}`);
        Logger.info('background', `  candidates(${candidates.length}): ${candidates.map(_capLine).join('  |  ') || '(none)'}`);
        if (llm) Logger.info('background', `  llm: top=${llm.topId} bindings=${JSON.stringify(llm.bindings)} rationale="${llm.rationale}" scores=${JSON.stringify(llm.scores)}`);
        else Logger.info('background', `  llm: ${aliasHit ? 'skipped (alias-exact)' : candidates.length ? 'unavailable/failed → lexical scorer' : 'no candidates'}`);
        Logger.info('background', `  → ${decision.decision}/${decision.reason}${decision.candidate ? ` "${decision.candidate.intent}" score=${(decision.score || 0).toFixed(2)} margin=${(decision.margin || 0).toFixed(2)}` : ''} bindings=${JSON.stringify(bindings)}${gaps.length ? ` gaps=${JSON.stringify(gaps)}` : ''} [via=${via}; here=${parts.here.length} reach=${parts.reachable.length} off=${parts.off.length}]`);
        if (decision.alternatives && decision.alternatives.length > 1) Logger.info('background', `  alternatives: ${decision.alternatives.map((a) => `"${a.intent}"=${(a.relevance || 0).toFixed(2)}`).join(', ')}`);
        sendResponse({
          success: true,
          decision: decision.decision,          // 'auto' | 'propose' | 'miss'
          reason: decision.reason,              // doubles as the assistant's explanation copy
          candidate: lean(decision.candidate),
          capabilityId: decision.candidate ? decision.candidate.id : null,
          bindings, gaps,                        // ORCH-M — validated param values + out-of-vocab gaps
          rationale: llm ? llm.rationale : '',
          via, groundId: gid,                    // ORCH-C — the resolved Ground (chat passes it back to REPLAY / RECORD_ALIAS)
          otherGround,                            // v2.74.801 — {groundId,groundName,groundUrl} when a MISS's ask names a DIFFERENT Ground
          alternatives: (decision.alternatives || []).map((a) => ({ id: a.id, intent: a.intent })),
          scoped, localeUrl,
        });
      } catch (err) {
        Logger.error('background', `ORCH_MATCH failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // T3X-IND (v2.74.795) — MATCH ACROSS ALL GROUNDS. The chat panel is INDEPENDENT of the current tab: a GENERAL
    // request ("search jazz singer jobs") that misses on the current page is matched against EVERY Ground's
    // capabilities (LEXICAL floor — no per-Ground LLM, so it's cheap across N Grounds), returning the Grounds whose
    // best candidate is a HIT. The chat then ACTS on a single hit (run it there) or SAYS SO on several (the user
    // picks — we don't guess which site). `excludeGroundId` skips the current Ground (ORCH_MATCH already tried it).
    // A smarter disambiguation than "list them" is the follow-up; this is the independence floor.
    ORCH_MATCH_GLOBAL: async (payload, _sender, sendResponse) => {
      try {
        const { ask = '', excludeGroundId = null } = payload ?? {};
        if (typeof ask !== 'string' || !ask.trim()) { sendResponse({ success: false, error: 'ask required' }); return; }
        const askIsRead = classifyReadAsk(ask).isRead;
        const _isReadCand = (c) => !!c && (c.kind === 'observation' || c.effect === 'read');
        const grounds = (await StorageManager.getAllGrounds()) || [];
        // Collect every effect-scoped, ACTIVE, non-orphan candidate across ALL Grounds, tagged with its Ground.
        const tagged = [];   // { cand, gid, g }
        const roster = [];   // v2.74.818 — FULL Ground inventory (incl. EMPTY grounds + the excluded active-tab one) — makes duplicate/sibling Grounds (e.g. app.notion.com + notion.so) obvious at a glance
        for (const g of grounds) {
          const gid = g && (g.id || g.groundId);
          if (!gid) continue;
          let caps = [];
          try { caps = await ctx.readSgCapabilities(gid); } catch { caps = []; }
          roster.push(`${_groundLabel(g)}(${String(gid).slice(-6)},${Array.isArray(caps) ? caps.length : 0}c)`);
          if (gid === excludeGroundId) continue;
          if (!Array.isArray(caps) || !caps.length) continue;
          const { liveStrategyIds, liveFragmentIds, strategyFragments } = await _liveBackingIds(gid);   // v2.74.827 — Strategy AND Fragment liveness (per-Ground in the global sweep)
          const _orphan = (c) => isOrphanCapability(c, { liveStrategyIds, liveFragmentIds, strategyFragments });
          const projected = caps.filter((c) => isActiveCapability(c) && !_orphan(c) && c.kind !== 'composite').map((c) => toCandidate(c)).filter(Boolean);
          const pool = askIsRead ? projected.filter(_isReadCand)
            : (projected.filter((c) => !_isReadCand(c)).length ? projected.filter((c) => !_isReadCand(c)) : projected);
          for (const c of pool) tagged.push({ cand: c, gid, g });
        }
        Logger.info('background', `GROUNDS ▸ ${roster.length} ground(s): ${roster.join(' · ') || '(none)'}`);   // v2.74.818 — the inventory blind-spot: host(id,Ncap) for every Ground
        if (!tagged.length) { Logger.info('background', `ORCH_MATCH_GLOBAL ▸ "${String(ask).slice(0, 60)}" → no candidates across Grounds`); sendResponse({ success: true, hits: [] }); return; }
        // ONE LLM matchCapability pass over the COMBINED pool — the lexical floor is too weak for cross-Ground intent
        // (live trace: "search jazz singer jobs" missed lexically but the LLM scored "Search jobs by title and
        // location" 0.95). Scores are per-candidate, so we keep every Ground whose best candidate clears the floor →
        // 1 = run it there, ≥2 = the user picks. matchCapability handles a multi-Ground candidate list (it scores
        // intent relevance, Ground-agnostic). On API failure: degrade to the lexical floor (better than nothing).
        let scores = null;
        try {
          const llm = await AnthropicService.matchCapability({ ask, candidates: tagged.map((t) => t.cand) });
          if (llm && Array.isArray(llm.scores)) scores = new Map(llm.scores.map((s) => [s.id, s]));
        } catch (e) { Logger.warn('background', `ORCH_MATCH_GLOBAL matchCapability unavailable → lexical fallback: ${e.message}`); }
        const THRESH = 0.6;   // confident-match floor (the on-page hit scored 0.95; a weaker but real match still clears 0.6)
        const bestByGround = new Map();   // gid → { relevance, hit }
        for (const t of tagged) {
          let rel = 0, eligible = true;
          if (scores) { const s = scores.get(t.cand.id); if (s) { rel = Number(s.relevance) || 0; eligible = s.effectEligible !== false; } }
          else { const d = rankAndDecide(ask, [t.cand], { now: Date.now() }); rel = (d && d.candidate && d.decision !== 'miss') ? (d.score || 0.5) : 0; }
          if (!eligible || rel < THRESH) continue;
          const prev = bestByGround.get(t.gid);
          if (prev && prev.relevance >= rel) continue;
          const c = t.cand; const raw = (c.raw && typeof c.raw === 'object') ? c.raw : c;
          bestByGround.set(t.gid, { relevance: rel, hit: {
            groundId: t.gid,
            groundName: _groundLabel(t.g),
            groundUrl: t.g.url || (Array.isArray(t.g.urlPatterns) ? t.g.urlPatterns[0] : null) || null,
            capabilityId: c.id,
            capabilityName: c.intent || raw.name || '',
            capabilityKind: raw.strategyId ? 'strategy' : (raw.fragmentId ? 'fragment' : 'strategy'),
            effect: _isReadCand(c) ? 'read' : 'action',
            relevance: rel,
          } });
        }
        const hits = [...bestByGround.values()].sort((a, b) => b.relevance - a.relevance).map((x) => x.hit);
        Logger.info('background', `ORCH_MATCH_GLOBAL ▸ "${String(ask).slice(0, 60)}" → ${hits.length} Ground(s) [${scores ? 'LLM' : 'lexical'} over ${tagged.length} cand]: ${hits.map((h) => `${h.groundName}(${h.relevance.toFixed(2)})`).join(', ') || '(none)'}`);
        sendResponse({ success: true, hits });
      } catch (err) {
        Logger.error('background', `ORCH_MATCH_GLOBAL failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // v2.74.816 — DEDUP (read-only): surface clusters of Grounds that look like the SAME site. One logical site
    // spawns multiple Grounds — subdomain variants (app.x.com + www.x.com) or a brand under two TLDs (notion.com +
    // notion.so) — splitting capabilities; the GLOBAL matcher reads them all, but active-tab-scoped delete can't
    // clear the sibling. This DETECTS the clusters (stamping each Ground's capability count, so the user sees where
    // caps live + a merge can pick the richest canonical). MERGE_GROUNDS (separate, confirmed) consolidates them.
    DETECT_DUPLICATE_GROUNDS: async (_payload, _sender, sendResponse) => {
      try {
        const grounds = (await StorageManager.getAllGrounds()) || [];
        const withCounts = [];
        for (const g of (Array.isArray(grounds) ? grounds : [])) {
          const gid = g && (g.id || g.groundId);
          if (!gid) continue;
          let n = 0;
          try { n = ((await ctx.readSgCapabilities(gid)) || []).length; } catch { /* */ }
          withCounts.push({ ...g, capabilityCount: n });
        }
        const clusters = findDuplicateGroundGroups(withCounts).map((cl) => ({
          key: cl.key,
          confidence: cl.confidence,
          registrables: cl.registrables,
          grounds: cl.grounds.map((g) => ({ id: g.id, name: _groundLabel(g), host: primaryHost(g), capabilityCount: g.capabilityCount || 0 })),
        }));
        Logger.info('background', `DETECT_DUPLICATE_GROUNDS ▸ ${withCounts.length} ground(s) → ${clusters.length} cluster(s): ${clusters.map((c) => `${c.key}[${c.confidence}]×${c.grounds.length}`).join(', ') || '(none)'}`);
        sendResponse({ success: true, clusters, groundCount: withCounts.length });
      } catch (err) {
        Logger.error('background', `DETECT_DUPLICATE_GROUNDS failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // v2.74.817 — DEDUP merge (mutation; the chat confirms before calling). Consolidate a cluster of duplicate
    // Grounds onto ONE canonical: move sgCapabilities (here) + the per-Ground artifacts (StorageManager.mergeGround),
    // union the urlPatterns, delete the empty siblings. The canonical is DERIVED server-side (planGroundMerge picks
    // the richest by live capability count) — the client sends only the cluster's Ground ids, so it can't mis-target.
    MERGE_GROUNDS: async (payload, _sender, sendResponse) => {
      try {
        const groundIds = Array.isArray(payload && payload.groundIds) ? payload.groundIds.filter(Boolean) : [];
        if (groundIds.length < 2) { sendResponse({ success: false, error: 'need ≥2 ground ids to merge' }); return; }
        const all = (await StorageManager.getAllGrounds()) || [];
        const byId = new Map((Array.isArray(all) ? all : []).map((g) => [g.id || g.groundId, g]));
        const cluster = [];
        for (const id of groundIds) {
          const g = byId.get(id); if (!g) continue;
          let n = 0; try { n = ((await ctx.readSgCapabilities(id)) || []).length; } catch { /* */ }
          cluster.push({ ...g, capabilityCount: n });
        }
        if (cluster.length < 2) { sendResponse({ success: false, error: 'fewer than 2 of those grounds exist' }); return; }
        const plan = planGroundMerge(cluster);
        if (!plan) { sendResponse({ success: false, error: 'could not plan a merge' }); return; }
        const { canonicalId, absorbedIds, urlPatterns, name } = plan;
        let movedCaps = 0;
        for (const fromId of absorbedIds) {
          // 1. move sgCapabilities source→canonical (re-key groundId; writeSgCapability upserts by id → dedups),
          //    then drop the source store (deleteGround does NOT cascade sgCapabilities, so prune it explicitly).
          try {
            const caps = (await ctx.readSgCapabilities(fromId)) || [];
            for (const c of caps) { if (c && c.id) { await ctx.writeSgCapability(canonicalId, { ...c, groundId: canonicalId }); movedCaps++; } }
            await ctx.removeSgCapabilities(fromId, () => true);
          } catch (e) { Logger.warn('background', `MERGE_GROUNDS sgCapabilities move (${fromId}→${canonicalId}) failed: ${e.message}`); }
          // 2. move the per-Ground artifacts + delete the now-empty source (StorageManager owns the flat-key re-key).
          await StorageManager.mergeGround(fromId, canonicalId, { urlPatterns, name });
        }
        // v2.74.822 — CLOUD-SYNC RECONCILIATION (the merge↔sync 409 from the 17:46 trace). mergeGround mutates LOCAL
        // storage only: updateGround(canonical,{urlPatterns}) DIVERGES the canonical's ground.json from its cloud copy
        // (the periodic reconcile then re-pushes it with a STALE etag → 409), and deleteGround(absorbed) drops each
        // sibling LOCALLY but leaves its CLOUD copy (which pullChanges re-syncs back → resurrection). So drive the
        // cloud explicitly here:
        //   • FORCE-push the canonical ground — merge is AUTHORITATIVE, so forceResyncRecord clears the stale cache →
        //     enqueues with expectedEtag '*' → overwrites the cloud copy, no 409 (the re-keyed CHILDREN reconcile on
        //     their own via runSync's bootstrap dirty-scan, since they now sit at fresh paths under the canonical).
        //   • TOMBSTONE each absorbed Ground's whole tree — cloud-side delete + a local tombstone that blocks bootstrap
        //     from resurrecting it on the next pull.
        // Every SyncEngine call no-ops when hybrid sync is off (isHybridSyncActive gate), so a local-only user is
        // unaffected; a cloud failure is non-fatal (the merge is already LOCAL-complete and reconciles on a later run).
        let synced = false;
        try {
          if (await isHybridSyncActive()) {
            const canonical = (await StorageManager.getGround(canonicalId)) || byId.get(canonicalId);
            if (canonical) await forceResyncRecord('ground', { ...canonical, id: canonicalId });
            for (const fromId of absorbedIds) await enqueueGroundTreeDelete(fromId);
            scheduleSyncRun();
            synced = true;
          }
        } catch (e) { Logger.warn('background', `MERGE_GROUNDS cloud reconciliation failed (merge is local-complete): ${e.message}`); }
        // name the canonical + absorbed Ground ids + whether the cloud was reconciled, so a later SyncEngine line on
        // one of these ground.json paths is traceable back to THIS merge (the merge↔sync conflict from the 17:46 trace).
        Logger.info('background', `MERGE_GROUNDS ▸ ${absorbedIds.length} ground(s) → canonical ${String(canonicalId).slice(-6)} (${_groundLabel(byId.get(canonicalId) || {})}); moved ${movedCaps} capabilit${movedCaps === 1 ? 'y' : 'ies'}; absorbed [${absorbedIds.map((x) => String(x).slice(-6)).join(', ')}] deleted${synced ? ' → cloud: canonical force-pushed + absorbed trees tombstoned' : ' (local-only; sync off)'}`);
        sendResponse({ success: true, canonicalId, canonicalHost: primaryHost(byId.get(canonicalId) || {}), absorbed: absorbedIds.length, movedCapabilities: movedCaps, synced });
      } catch (err) {
        Logger.error('background', `MERGE_GROUNDS failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // v2.74.818 — ORCH_LOG: a thin pass-through so the SIDEPANEL (chat.js) can write a decision line (e.g. the ROUTE
    // a turn took + its cues) into the SAME persisted ring buffer the background uses — the sidepanel's own console
    // isn't ring-buffered, so a chat-side decision was previously invisible in the downloaded trace.
    ORCH_LOG: async (payload, _sender, sendResponse) => {
      try { const line = payload && payload.line; if (typeof line === 'string' && line) Logger.info('background', line.slice(0, 300)); } catch { /* never let a log break the turn */ }
      sendResponse({ success: true });
    },

    // v2.74.819 — ORCH_LIST: the READ complement to ORCH_ADMIN's delete. Returns the library's contents so the chat
    // can SHOW what you have — grounds (host + cap count), capabilities (intent + kind, active-tab Ground or all), or
    // saved cross-Ground workflows. Read-only.
    ORCH_LIST: async (payload, _sender, sendResponse) => {
      try {
        const { target = 'capabilities', scope = 'ground', tabId = null } = payload ?? {};
        const all = (await StorageManager.getAllGrounds()) || [];
        if (target === 'grounds') {
          const items = [];
          for (const g of (Array.isArray(all) ? all : [])) {
            const gid = g && (g.id || g.groundId); if (!gid) continue;
            let n = 0; try { n = ((await ctx.readSgCapabilities(gid)) || []).length; } catch { /* */ }
            items.push({ id: gid, name: _groundLabel(g), host: primaryHost(g), capabilityCount: n });
          }
          Logger.info('background', `ORCH_LIST ▸ grounds → ${items.length} ground(s)`);
          sendResponse({ success: true, target, items }); return;
        }
        if (target === 'workflows') {
          let wfs = []; try { wfs = (await StorageManager.listWorkflows()) || []; } catch { /* */ }
          const items = (Array.isArray(wfs) ? wfs : []).map((w) => ({ id: w.id, name: w.name || w.intent || w.id, steps: (Array.isArray(w.steps) ? w.steps.length : 0), grounds: (Array.isArray(w.groundIds) ? w.groundIds.length : 0) }));
          Logger.info('background', `ORCH_LIST ▸ workflows → ${items.length} workflow(s)`);
          sendResponse({ success: true, target, items }); return;
        }
        // capabilities — the active-tab Ground (default) or every Ground (scope=all)
        let gids = [];
        if (scope === 'all') gids = all.map((g) => g.id || g.groundId).filter(Boolean);
        else {
          const gid = await _groundIdForTab(tabId, all);   // v2.74.823 — urlPatterns-aware tab→Ground (merged sibling hosts resolve)
          if (gid) gids = [gid];
        }
        const items = [];
        for (const gid of gids) {
          const g = all.find((x) => (x.id || x.groundId) === gid) || {};
          let caps = []; try { caps = (await ctx.readSgCapabilities(gid)) || []; } catch { /* */ }
          for (const c of caps) {
            if (!c || c.id == null || c.retracted === true) continue;   // v2.74.820 — show active + DISABLED (the toggle target); hide retracted (feedback-removed, Studio-restorable)
            items.push({ id: c.id, groundId: gid, intent: c.intent || c.name || '(unnamed)', kind: c.kind === 'observation' ? 'read' : (c.strategyId ? 'strategy' : 'fragment'), host: primaryHost(g), disabled: c.disabled === true });
          }
        }
        Logger.info('background', `ORCH_LIST ▸ capabilities scope=${scope} → ${items.length} cap(s) across ${gids.length} ground(s)`);
        sendResponse({ success: true, target, items, scope, grounds: gids.length });
      } catch (err) {
        Logger.error('background', `ORCH_LIST failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // v2.74.819 — RENAME_GROUND: give the active-tab Ground a readable name (Grounds often carry a generic "Ground").
    RENAME_GROUND: async (payload, _sender, sendResponse) => {
      try {
        const { name = '', groundId = null, tabId = null } = payload ?? {};
        const nm = String(name || '').trim();
        if (!nm) { sendResponse({ success: false, error: 'a name is required' }); return; }
        let gid = groundId;
        if (!gid && typeof tabId === 'number') {
          const gs = (await StorageManager.getAllGrounds()) || [];
          gid = await _groundIdForTab(tabId, gs);   // v2.74.823 — urlPatterns-aware tab→Ground (merged sibling hosts resolve)
        }
        if (!gid) { sendResponse({ success: false, error: 'no Ground for this tab (this page isn’t in the library)' }); return; }
        await StorageManager.updateGround(gid, { name: nm.slice(0, 80) });
        Logger.info('background', `RENAME_GROUND ▸ ${String(gid).slice(-6)} → "${nm.slice(0, 60)}"`);
        sendResponse({ success: true, groundId: gid, name: nm.slice(0, 80) });
      } catch (err) { Logger.error('background', `RENAME_GROUND failed: ${err.message}`); sendResponse({ success: false, error: err.message }); }
    },

    // v2.74.819 — PRUNE_ORPHANS: remove matcher capabilities whose backing Strategy/Fragment is GONE (they still
    // MATCH, then REPLAY-fail "not found"). Closes the orphan-cap gap. Reads are skipped (no backing artifact).
    PRUNE_ORPHANS: async (payload, _sender, sendResponse) => {
      try {
        const { scope = 'all', tabId = null } = payload ?? {};
        const all = (await StorageManager.getAllGrounds()) || [];
        let gids = (scope === 'all') ? all.map((g) => g.id || g.groundId).filter(Boolean) : [];
        if (scope !== 'all') {
          const gid = await _groundIdForTab(tabId, all);   // v2.74.823 — urlPatterns-aware tab→Ground (merged sibling hosts resolve)
          if (gid) gids = [gid];
        }
        let removed = 0;
        for (const gid of gids) {
          // SAFETY: a FAILED list read → null (NOT an empty Set), so we DON'T prune that kind — otherwise a transient
          // storage error would flag every cap as orphaned and wipe the library. An empty-but-SUCCESSFUL read is a
          // real signal (the backing artifacts are genuinely gone → those caps ARE orphans).
          let liveStrat = null; let liveFrag = null;
          try { liveStrat = new Set((await StorageManager.listStrategies(gid)).map((x) => x && x.id).filter(Boolean)); } catch { liveStrat = null; }
          try { liveFrag = new Set((await StorageManager.listFragments(gid)).map((x) => x && x.id).filter(Boolean)); } catch { liveFrag = null; }
          const isOrphan = (c) => {
            if (!c || c.kind === 'observation') return false;
            if (c.strategyId) return liveStrat ? !liveStrat.has(c.strategyId) : false;   // read failed → leave it alone
            if (c.fragmentId) return liveFrag ? !liveFrag.has(c.fragmentId) : false;
            return false;
          };
          try { removed += (await ctx.removeSgCapabilities(gid, isOrphan)) || 0; } catch { /* */ }
        }
        Logger.info('background', `PRUNE_ORPHANS ▸ scope=${scope} → removed ${removed} orphan(s) across ${gids.length} ground(s)`);
        sendResponse({ success: true, removed, grounds: gids.length });
      } catch (err) { Logger.error('background', `PRUNE_ORPHANS failed: ${err.message}`); sendResponse({ success: false, error: err.message }); }
    },

    // v2.74.819 — STATS: a one-glance library overview (grounds · capabilities · orphans · workflows).
    STATS: async (_payload, _sender, sendResponse) => {
      try {
        const all = (await StorageManager.getAllGrounds()) || [];
        let capabilities = 0; let orphans = 0;
        for (const g of (Array.isArray(all) ? all : [])) {
          const gid = g && (g.id || g.groundId); if (!gid) continue;
          let caps = []; try { caps = (await ctx.readSgCapabilities(gid)) || []; } catch { /* */ }
          capabilities += caps.length;
          const { liveStrategyIds, liveFragmentIds, strategyFragments } = await _liveBackingIds(gid);   // v2.74.827 — count BOTH Strategy- and Fragment-orphans
          orphans += caps.filter((c) => isOrphanCapability(c, { liveStrategyIds, liveFragmentIds, strategyFragments })).length;   // null live-set → not counted (precision-first)
        }
        let workflows = 0; try { workflows = ((await StorageManager.listWorkflows()) || []).length; } catch { /* */ }
        Logger.info('background', `STATS ▸ ${all.length} ground(s), ${capabilities} capabilit${capabilities === 1 ? 'y' : 'ies'} (${orphans} orphan), ${workflows} workflow(s)`);
        sendResponse({ success: true, grounds: all.length, capabilities, orphans, workflows });
      } catch (err) { Logger.error('background', `STATS failed: ${err.message}`); sendResponse({ success: false, error: err.message }); }
    },

    // v2.74.820 — SET_CAPABILITY_ACTIVE: enable/disable a capability WITHOUT deleting it. The matcher excludes a
    // `disabled` cap via isActiveCapability, so a flaky one can be PAUSED (and re-enabled) — distinct from `retracted`
    // (the broken-it feedback verdict). Toggled from the per-capability buttons in `list capabilities`.
    SET_CAPABILITY_ACTIVE: async (payload, _sender, sendResponse) => {
      try {
        const { groundId = null, capabilityId = null, active = true } = payload ?? {};
        if (!groundId || !capabilityId) { sendResponse({ success: false, error: 'groundId + capabilityId required' }); return; }
        const cap = ((await ctx.readSgCapabilities(groundId)) || []).find((c) => c && c.id === capabilityId);
        if (!cap) { sendResponse({ success: false, error: 'capability not found on this Ground' }); return; }
        await ctx.writeSgCapability(groundId, { ...cap, disabled: active === false });
        Logger.info('background', `SET_CAPABILITY_ACTIVE ▸ "${cap.intent || cap.name || capabilityId}" → ${active === false ? 'DISABLED' : 'enabled'}`);
        sendResponse({ success: true, capabilityId, disabled: active === false });
      } catch (err) { Logger.error('background', `SET_CAPABILITY_ACTIVE failed: ${err.message}`); sendResponse({ success: false, error: err.message }); }
    },

    // T3X-IND (v2.74.795) — BUILD a runnable 1-step Workflow that runs ONE capability on ANOTHER Ground (the chosen
    // global-match hit). Binds the ask's values to the capability's params (the SAME LLM binder ORCH_MATCH uses), then
    // lowers a single resolved sub-intent via the tested tier3 + WorkflowExecutor path — so the run reuses ALL the
    // cross-Ground hop/run wiring (executeStrategy opens the Ground tab) with NO new runtime. Returns the record; the
    // chat SAVES + INVOKEs it (the existing _orchRunWorkflow path), so "run it on another site" is just a tiny Workflow.
    BUILD_SG_ON_GROUND_WORKFLOW: async (payload, _sender, sendResponse) => {
      try {
        const { ask = '', groundId = null, capabilityId = null } = payload ?? {};
        if (typeof ask !== 'string' || !ask.trim() || !groundId || !capabilityId) { sendResponse({ success: false, error: 'ask + groundId + capabilityId required' }); return; }
        const g = ((await StorageManager.getAllGrounds()) || []).find((x) => (x && (x.id || x.groundId)) === groundId);
        if (!g) { sendResponse({ success: false, error: 'ground not found' }); return; }
        const cap = (await ctx.readSgCapabilities(groundId)).find((c) => c.id === capabilityId);
        if (!cap) { sendResponse({ success: false, error: 'capability not found' }); return; }
        const richParams = Array.isArray(cap.params) ? cap.params : [];
        const params = richParams.map((p) => (typeof p === 'string' ? p : (p && p.name))).filter(Boolean);
        let stated = {};
        if (params.length) {
          // v2.74.881 — pass the RICH params (incl. option vocabulary), not bare names, so an OPTION param like
          // CATEGORY binds to its catalog value off-page (no live affordances cross-Ground) instead of dropping to
          // UNRESOLVED → skipped → an unscoped search (the "search pixabay for videos…" → wrong page gap).
          try { const bp = await AnthropicService.bindClauseParams({ clause: ask, params: richParams }); if (bp && bp.values && typeof bp.values === 'object') stated = bp.values; }
          catch (e) { Logger.warn('background', `BUILD_SG_ON_GROUND_WORKFLOW bindClauseParams unavailable: ${e.message}`); }
        }
        const groundUrl = g.url || (Array.isArray(g.urlPatterns) ? g.urlPatterns[0] : null) || null;
        // The DISPATCH id the Workflow step runs is the backing Strategy/Fragment id — NOT the sgCapability matcher id
        // (executeStrategy loads by strategyId; a bare Fragment is wrapped by id). Same precedence the cross-Ground
        // binder uses (_bindStrategyOnGround). `capabilityId` (the param) is the matcher id we looked the cap up by.
        const dispatchId = cap.strategyId || cap.fragmentId || cap.id;
        const capabilityKind = cap.strategyId ? 'strategy' : (cap.fragmentId ? 'fragment' : 'strategy');
        // v2.74.813 — stamp reversibility (toCandidate derives it from intent/aliases) so an irreversible single-Ground
        // capability run via the workflow path carries the same 🔒 floor the cross-Ground steps do (executor/saved re-run gate).
        const reversible = toCandidate(cap).reversible !== false;
        const resolved = [{ id: 's0', clause: ask, groundId, groundName: _groundLabel(g), groundUrl, capabilityId: dispatchId, capabilityKind, capabilityName: cap.intent || cap.name || '', params, stated, reversible }];
        wireCrossGroundData(resolved);   // STATED → step literals (so the search runs with the asked value, not empty)
        const wfId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const built = buildWorkflowRecord({ id: wfId, intent: ask, name: String(ask).slice(0, 60), resolved });
        if (!built || !built.workflow || !Array.isArray(built.workflow.steps) || !built.workflow.steps.length) { sendResponse({ success: false, error: 'could not build a runnable step for that capability' }); return; }
        Logger.info('background', `BUILD_SG_ON_GROUND_WORKFLOW — "${String(ask).slice(0, 50)}" → ${capabilityKind} ${capabilityId} on ${_groundLabel(g)} (params: ${Object.keys(stated).join(',') || 'none'})`);
        sendResponse({ success: true, workflow: built.workflow, runnable: built.runnable });
      } catch (err) {
        Logger.error('background', `BUILD_SG_ON_GROUND_WORKFLOW failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ORCH-D — the aliases flywheel (write side). When a match is CONFIRMED (the user accepts a propose, or a
    // run succeeds), the chat records the ask phrasing here; it accretes onto the capability's aliases so next
    // time it's an exact hit (and richer alias coverage promotes propose → auto-fire). The matcher reads
    // capability.aliases (toCandidate), so updating it closes the loop. PURE accreteAlias does the dedup/cap.
    ORCH_RECORD_ALIAS: async (payload, _sender, sendResponse) => {
      try {
        const { groundId = null, capabilityId = null, phrase = '' } = payload ?? {};
        if (!groundId || !capabilityId || typeof phrase !== 'string' || !phrase.trim()) { sendResponse({ success: false, error: 'groundId + capabilityId + phrase required' }); return; }
        // v2.74.905 — a TEMPLATE phrase ({placeholder}) is never an alias: the 22:38 run accreted
        // "Search for {query} across all media types" with a confirmation. Aliases are real user phrasings.
        // v2.74.932 (CR-ST2) — broadened: the old class missed SPACED placeholders ("{job title}"), the
        // exact poisoning vector half-closed by .905. Any braced token ≤40 chars is a template marker.
        if (/\{[^}]{1,40}\}/.test(phrase)) { sendResponse({ success: true, skipped: 'template phrase — not accreted' }); return; }
        const all = await ctx.readSgCapabilities(groundId);   // v2.74.932 (CR-ST2) — one read serves both lookups (was two back-to-back)
        const cap = (Array.isArray(all) ? all : []).find((c) => c.id === capabilityId);
        if (!cap) { sendResponse({ success: false, error: 'capability not found' }); return; }
        const before = Array.isArray(cap.aliases) ? cap.aliases.length : 0;
        cap.aliases = accreteAlias(cap.aliases, phrase, { intent: cap.intent || '' });
        await ctx.writeSgCapability(groundId, cap);
        // DE-POISON — this ask now belongs to `cap`; strip it from any OTHER capability that accreted it from a
        // prior WRONG confirmation (the cause of "search for sound effects" sticking to "Search for music").
        let depoisoned = 0;
        for (const other of (Array.isArray(all) ? all : [])) {
          if (!other || other.id === cap.id || !Array.isArray(other.aliases) || !other.aliases.length) continue;
          const pruned = removeAlias(other.aliases, phrase);
          if (pruned.length !== other.aliases.length) { other.aliases = pruned; try { await ctx.writeSgCapability(groundId, other); depoisoned++; } catch { /* */ } }
        }
        if (depoisoned) Logger.info('background', `ORCH_RECORD_ALIAS — de-poisoned "${String(phrase).slice(0, 40)}" from ${depoisoned} other capability(ies)`);
        // ORCH-G — record the confirmation so the capability's health accrues (gate promotion). `confirmed:true`
        // distinguishes a match-confirmation from the DERIVE-time 'accept' so creation doesn't inflate health.
        try { await ctx.appendOutcomes(groundId, [Outcomes.makeStageEvent('accept', { groundId, verdict: 'accepted', outcome: 'success', detail: { capabilityId: cap.id, confirmed: true, phrase: String(phrase).slice(0, 120) } })]); } catch { /* */ }
        Logger.info('background', `ORCH_RECORD_ALIAS — "${String(phrase).slice(0, 40)}" → ${cap.id} (${before}→${cap.aliases.length} alias, +1 confirmation)`);
        sendResponse({ success: true, aliases: cap.aliases, added: cap.aliases.length > before });
      } catch (err) {
        Logger.error('background', `ORCH_RECORD_ALIAS failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ORCH-FB — the corrective-feedback handler. The chat sends a corrective KIND (from a 👎 button or
    // classifyFeedback/interpretFeedback over free text) + the last action's context; planCorrection turns it
    // into persistent ops applied HERE, so a wrong match/run/capability is corrected WITHOUT a Studio trip:
    //   de_alias → removeAlias (strip the wrong ask) · demote → a rejected OUTCOME (nets down health) ·
    //   retract → applyRetraction (soft-delete; isActiveCapability hides it) · confirm_alias → accrete + confirm.
    // Returns the `say` + `followup` so the chat can render the result and offer the next step (record / rerun).
    ORCH_FEEDBACK: async (payload, _sender, sendResponse) => {
      try {
        const { groundId = null, capabilityId = null, ask = '', text = '', context = null } = payload ?? {};
        let { kind = '', correction = null } = payload ?? {};
        // LLM WRAPPER — refine free-text feedback into a precise corrective kind (+ a wrong_value correction).
        // A button-click passes a fixed `kind` and no `text`, so no LLM call is made there.
        if (text) {
          try {
            const r = await AnthropicService.interpretFeedback({ text, context: context || { intent: '', ask } });
            if (r && r.kind && r.kind !== 'none') { kind = r.kind; if (r.correction) correction = r.correction; }
          } catch { /* fall back to the lexical kind */ }
        }
        if (!kind) { sendResponse({ success: false, error: 'kind required' }); return; }
        const plan = planCorrection(kind, { capabilityId, groundId, ask, correction });
        const applied = [];
        const now = Date.now();
        for (const op of (Array.isArray(plan.ops) ? plan.ops : [])) {
          try {
            if (!op || !op.capabilityId || !groundId) continue;
            const cap = (await ctx.readSgCapabilities(groundId)).find((c) => c.id === op.capabilityId);
            if (op.op === 'retract') {
              if (cap) { await ctx.writeSgCapability(groundId, applyRetraction(cap, { now })); applied.push('retract'); }
            } else if (op.op === 'de_alias' && op.phrase) {
              if (cap && Array.isArray(cap.aliases)) {
                const pruned = removeAlias(cap.aliases, op.phrase);
                if (pruned.length !== cap.aliases.length) { cap.aliases = pruned; await ctx.writeSgCapability(groundId, cap); }
                applied.push('de_alias');
              }
            } else if (op.op === 'demote') {
              await ctx.appendOutcomes(groundId, [Outcomes.makeStageEvent('accept', { groundId, verdict: 'rejected', outcome: 'failure', detail: { capabilityId: op.capabilityId, rejected: true, reason: op.reason || kind, phrase: String(ask).slice(0, 120) } })]);
              applied.push('demote');
            } else if (op.op === 'confirm_alias' && op.phrase) {
              if (cap) {
                cap.aliases = accreteAlias(cap.aliases, op.phrase, { intent: cap.intent || '' });
                await ctx.writeSgCapability(groundId, cap);
                await ctx.appendOutcomes(groundId, [Outcomes.makeStageEvent('accept', { groundId, verdict: 'accepted', outcome: 'success', detail: { capabilityId: cap.id, confirmed: true, phrase: String(op.phrase).slice(0, 120) } })]);
                applied.push('confirm_alias');
              }
            }
          } catch (e) { Logger.warn('background', `ORCH_FEEDBACK op ${op && op.op} failed: ${e.message}`); }
        }
        Logger.info('background', `ORCH_FEEDBACK ▸ ${kind} cap=${String(capabilityId).slice(0, 8)} applied=[${applied.join(',')}] ask="${String(ask).slice(0, 50)}"`);
        sendResponse({ success: true, kind, correction, say: plan.say, followup: plan.followup, applied });
      } catch (err) {
        Logger.error('background', `ORCH_FEEDBACK failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ORCH-ADMIN — bulk library management from chat: COUNT or hard-DELETE artifacts, scoped to the current
    // Ground (resolved from the tab) or ALL grounds. Uses the SAME StorageManager list/delete primitives Studio
    // uses (partition-safe, cascading) — no invention. op:'count' powers the chat's confirmation; op:'delete'
    // executes it (the chat ALWAYS counts + confirms first, since this is a hard delete).
    ORCH_ADMIN: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, op = 'count', kinds = [], scope = 'ground' } = payload ?? {};
        // Chat thinks in CAPABILITIES — all three live in the sgCapabilities matcher store, distinguished by shape:
        //   strategy   = a multi-step capability (has a strategyId)
        //   fragment   = a single-step / bare-T1 capability (NO strategyId — T1-as-first-class)
        //   observation = a read capability (kind:'observation')
        // Deleting one CASCADES to its backing Tier-1 record(s) — the Strategy + its Fragments, or the bare Fragment —
        // and prunes the matcher record so it doesn't orphan (still match, then REPLAY-fail "not found"). Previously
        // 'strategies' matched ALL non-observation caps, so a bare Fragment cap was mis-counted as a strategy AND its
        // delete swept the Fragment — so a follow-up "delete fragments" found nothing. 'perspectives' is Tier-1-only.
        const _isObs = (c) => !!c && c.kind === 'observation';
        const CAP_PRED = {
          observations: (c) => _isObs(c),
          strategies:   (c) => !_isObs(c) && !!c.strategyId,
          fragments:    (c) => !_isObs(c) && !c.strategyId,
        };
        const TIER1 = { perspectives: ['listPerspectives', 'deletePerspective'] };
        // v2.74.811 — 'workflows' is GLOBAL (cross-Ground; listWorkflows() has no Ground arg), handled separately below.
        const want = (Array.isArray(kinds) ? kinds : []).filter((k) => CAP_PRED[k] || TIER1[k] || k === 'workflows');
        if (!want.length) { sendResponse({ success: false, error: 'no valid kinds' }); return; }
        const counts = {}; let total = 0;

        // WORKFLOWS — GLOBAL: count/delete ONCE, independent of Ground scope (so "delete all workflows" works from any
        // tab). A saved Workflow spans Grounds, so it isn't a per-Ground artifact like a capability/perspective.
        if (want.includes('workflows')) {
          let wfs = [];
          try { wfs = (await StorageManager.listWorkflows()) || []; } catch (e) { Logger.warn('background', `ORCH_ADMIN listWorkflows failed: ${e.message}`); }
          const ids = (Array.isArray(wfs) ? wfs : []).map((w) => w && w.id).filter(Boolean);
          if (op === 'delete') for (const id of ids) { try { await StorageManager.deleteWorkflow(id); } catch (e) { Logger.warn('background', `ORCH_ADMIN deleteWorkflow(${id}) failed: ${e.message}`); } }
          counts.workflows = ids.length; total += ids.length;
        }

        // PER-GROUND kinds (capabilities / perspectives). Resolve target Ground(s): all, or the active tab's origin.
        const groundKinds = want.filter((k) => k !== 'workflows');
        let groundCount = 0;
        if (groundKinds.length) {
        const allGrounds = (await StorageManager.getAllGrounds()) || [];
        let grounds = [];
        if (scope === 'all') grounds = allGrounds.map((g) => g.id).filter(Boolean);
        else {
          let gid = groundId;
          if (!gid) gid = await _groundIdForTab(tabId, allGrounds);   // v2.74.823 — urlPatterns-aware tab→Ground (a merged sibling host resolves), origin fallback inside
          if (gid) grounds = [gid];
        }
        groundCount = grounds.length;
        for (const k of groundKinds) {
          let n = 0;
          for (const gid of grounds) {
            const pred = CAP_PRED[k];
            if (pred) {
              // The sgCapabilities matcher store is the source of truth for what the chat sees. Match by the kind's
              // predicate; on delete, cascade to the backing Tier-1 record(s), then prune the matched caps.
              const caps = await ctx.readSgCapabilities(gid);
              const mine = (Array.isArray(caps) ? caps : []).filter(pred);
              n += mine.length;
              if (op === 'delete') {
                // v2.74.891 — SHIELD shared fragments from the sweep. A cap's backing Fragment can ALSO be a
                // constituent of a SURVIVING strategy (dedup/promotion share them); sweeping it left that strategy
                // with a dangling ref — the "missing a step" orphan (184507) the deep check (.889) detects. Keep any
                // fragment a non-deleted strategy still references; the cap ROW is still pruned below (the user asked
                // for the capability gone, not the surviving strategy's leg). A failed read → empty shield → legacy sweep.
                let _shield = new Set();
                if (k !== 'observations') {
                  try {
                    const deletingStrategyIds = new Set(mine.map((c) => c && c.strategyId).filter(Boolean));
                    const allFids = [...new Set(mine.flatMap((c) => [c.fragmentId, ...(Array.isArray(c.fragmentIds) ? c.fragmentIds : [])]).filter(Boolean))];
                    if (allFids.length) _shield = CapabilitySynth.shieldedFragmentIds(allFids, (await StorageManager.listStrategies(gid)) || [], deletingStrategyIds);
                  } catch { _shield = new Set(); }
                }
                for (const c of mine) {
                  try {
                    if (k === 'observations') {
                      await StorageManager.deleteObservation(c.strategyId || c.id);
                    } else {
                      // strategy OR bare-fragment cap: delete its backing Strategy (if any) + SWEEP its Fragment(s)
                      // so none orphan into a phantom standalone capability (listCapabilities would surface it).
                      if (c.strategyId) { try { await StorageManager.deleteStrategy(c.strategyId); } catch { /* */ } }
                      const fids = new Set([c.fragmentId, ...(Array.isArray(c.fragmentIds) ? c.fragmentIds : [])].filter(Boolean));
                      for (const fid of fids) { if (_shield.has(fid)) continue; try { await StorageManager.deleteFragment(fid); } catch { /* */ } }
                    }
                  } catch (e) { Logger.warn('background', `ORCH_ADMIN delete (${k}) failed: ${e.message}`); }
                }
                if (_shield.size) Logger.info('background', `ORCH_ADMIN ▸ shield: kept ${_shield.size} fragment(s) still referenced by a surviving strategy`);
                try { await ctx.removeSgCapabilities(gid, pred); } catch (e) { Logger.warn('background', `ORCH_ADMIN prune sgCapabilities (${k}) failed: ${e.message}`); }
              }
            } else {
              const [listFn, delFn] = TIER1[k];
              let recs = [];
              try { recs = await StorageManager[listFn](gid); } catch (e) { Logger.warn('background', `ORCH_ADMIN ${listFn}(${gid}) failed: ${e.message}`); }
              const ids = (Array.isArray(recs) ? recs : []).map((r) => r && r.id).filter(Boolean);
              n += ids.length;
              if (op === 'delete') for (const id of ids) { try { await StorageManager[delFn](id); } catch (e) { Logger.warn('background', `ORCH_ADMIN ${delFn}(${id}) failed: ${e.message}`); } }
            }
          }
          counts[k] = n; total += n;
        }
        }   // end if (groundKinds.length)

        Logger.info('background', `ORCH_ADMIN ▸ ${op} kinds=[${want.join(',')}] scope=${scope} grounds=${groundCount} counts=${JSON.stringify(counts)}`);
        sendResponse({ success: true, op, counts, total, grounds: groundCount, scope });
      } catch (err) {
        Logger.error('background', `ORCH_ADMIN failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // v2.74.1005 (2c) — Ground-AWARE cross-site precision gate for chat's COMPOUND trigger. Returns how many DISTINCT
    // known Grounds the ask names (verb-object included — "search youtube for X and pixabay for Y"), which the
    // chat-side lexical cues (preposition-only namesMultipleSites; transfer-verb _CROSS_SITE_CUE) both miss. Cheap:
    // a storage read + whole-word regex, NO LLM — chat calls it only for a compound ask the lexical cues missed.
    COUNT_NAMED_GROUNDS: async (payload, _sender, sendResponse) => {
      try {
        const ask = String(payload?.ask ?? '').trim();
        if (!ask) { sendResponse({ success: true, count: 0 }); return; }
        const grounds = (await StorageManager.getAllGrounds()) || [];
        sendResponse({ success: true, count: _countNamedGrounds(ask, grounds) });
      } catch (err) { sendResponse({ success: false, error: err.message, count: 0 }); }
    },

    // T3X — CROSS-GROUND COMPREHENSION. The recursion one tier up (specs/DESIGN_t3_cross_ground.md): decompose a
    // cross-Ground ask into sub-intents (the SAME page-independent comprehendIntent — "intents all the way down"),
    // resolve which Ground each runs on (T3X-1 ground catalog), bind a Strategy on it (the existing matcher), and
    // lower the result into a runnable WORKFLOW that composes those Strategies (T3X-2). The Workflow runs on the
    // existing runtime — executeStrategy opens each step's Ground tab, data flows via workflowScope. Read-only
    // unless save:true (the chat reviews first). Integration glue over the unit-tested pure cores — verify live.
    COMPREHEND_CROSS_GROUND: async (payload, _sender, sendResponse) => {
      try {
        const { ask = '', save = false } = payload ?? {};
        if (!String(ask).trim()) { sendResponse({ success: false, error: 'empty ask' }); return; }

        // 1. The global Ground catalog — every Ground + the goal labels of ALL its capabilities (T2 Strategies AND
        //    bare T1 Fragments) so ground-resolution works on a Fragment-only Ground (the T3X-1 substrate).
        const grounds = (await StorageManager.getAllGrounds()) || [];
        if (!grounds.length) { sendResponse({ success: false, error: 'no Grounds to compose across' }); return; }
        const capLabelsByGround = {};
        for (const g of grounds) {
          const gid = g && (g.id || g.groundId); if (!gid) continue;
          try { const caps = await ctx.readSgCapabilities(gid); capLabelsByGround[gid] = (Array.isArray(caps) ? caps : []).filter((c) => c && c.kind !== 'observation').map((c) => (c.intent || c.name || '')).filter(Boolean); } catch { /* */ }
        }
        const catalog = buildGroundCatalog(grounds, capLabelsByGround);
        const byId = new Map(grounds.map((g) => [g && (g.id || g.groundId), g]).filter(([k]) => k));

        // 2. Decompose into sub-intents. Prefer the T3-framed comprehender (fed the Ground catalog → cross-SITE
        //    sub-intents + per-sub-intent STATED values that become literals); fall back to the page-independent
        //    comprehendIntent (no stated values → those params become Workflow inputs).
        let subIntents = [];
        try {
          const x = await AnthropicService.comprehendCrossGround({ ask, grounds: catalog.map((e) => ({ groundId: e.groundId, name: e.name })) });
          if (x && Array.isArray(x.subIntents) && x.subIntents.length) {
            subIntents = x.subIntents.map((s, i) => ({ id: s.id || `s${i}`, clause: s.clause || s.label || ask, dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [], stated: (s.stated && typeof s.stated === 'object') ? s.stated : {} }));
          }
        } catch (e) { Logger.warn('background', `comprehendCrossGround unavailable, falling back: ${e.message}`); }
        if (!subIntents.length) {
          const spec = await AnthropicService.comprehendIntent({ userIntent: ask });
          const subGoals = (spec && Array.isArray(spec.subGoals) && spec.subGoals.length) ? spec.subGoals : [{ id: 's0', label: ask }];
          subIntents = subGoals.map((sg, i) => ({ id: sg.id || `s${i}`, clause: sg.label || sg.clause || ask, dependsOn: Array.isArray(sg.dependsOn) ? sg.dependsOn : [], stated: {} }));
        }
        // ORDER by dependsOn so "search → save" precedes its consumer (and the data flow is well-founded). topoOrder
        // is the same dependency sort the within-Ground (T2) lowering uses — reused one tier up.
        const ordered = topoOrder(subIntents);

        // 3. Per sub-intent: resolve its Ground (T3X-1, IN ORDER for inherit) → then bind a Strategy IN PARALLEL.
        const prepared = [];   // v2.74.829 — Phase A fills this (resolved Ground per sub-intent); Phase B binds in parallel
        const ambiguities = [];
        // v2.74.824 — track each sub-intent's resolved Ground (id → groundId) so a DEPENDENT clause can INHERIT its
        // producer's Ground (below). topoOrder guarantees a producer resolves before its consumer, so the map is
        // populated by the time a consumer reads it.
        const groundBySubIntent = new Map();
        // The site list the LLM ground resolver (Q2) picks from — name + purpose, closed set.
        const llmGrounds = catalog.map((e) => {
          const g = byId.get(e.groundId);
          const d = g && (g.derivedDescription || (g.description && (g.description.identity || g.description.category)) || (typeof g.description === 'string' ? g.description : ''));
          // v2.74.804 (2c) — the HOST-derived label (pixabay.com → "Pixabay") so a clause that NAMES a site
          // ("…on Pixabay") can match even when the stored name is generic/blank — else matchGround never sees "Pixabay".
          return { groundId: e.groundId, name: _groundLabel(g) || e.name, description: typeof d === 'string' ? d : '' };
        });
        for (let i = 0; i < ordered.length; i++) {
          const si = ordered[i] || {};
          const clause = si.clause || si.label || ask;
          const gr = resolveGround(clause, catalog);

          // v2.74.805 (2c) — DOMAIN match is AUTHORITATIVE and runs FIRST. A clause that NAMES a Ground by its host
          // ("…on Pixabay" → pixabay.com) wins over BOTH the lexical floor and the LLM. (.804 placed it after the
          // lexical 'resolved' check — but resolveGround can RESOLVE a named site to the WRONG Ground, e.g. a
          // "…on Pixabay" clause carrying a job title lexically resolved to a flower shop, which skipped the domain
          // check.) Reuses the .801 URL-host detector (currentGid=null → consider ANY named Ground). No LLM, no tie.
          let groundId = null; let _via = 'none';
          const named = _askNamesOtherGround(clause, grounds, null);
          if (named && named.groundId) { groundId = named.groundId; _via = 'domain'; }
          // Q2 — else the lexical floor; a confident 'resolved' is kept (no LLM round-trip).
          if (!groundId && gr.decision === 'resolved') { groundId = gr.groundId; _via = 'lexical'; }
          // v2.74.824 — INHERIT the producer's Ground for a DEPENDENT clause that NAMES NO SITE. A read that consumes
          // an upstream step ("note its name and price" after "find a bouquet on thepetal") reads on the SAME Ground
          // its producer ran on — but with no site-name + a weak lexical signal it otherwise fell to the LLM
          // matchGround, which mis-pulled "note…" → Notion (the VERB, not the site). When every dependency resolved to
          // ONE Ground, use it — BEFORE the LLM guess. (domain-named + confident-lexical still win; this only pre-empts
          // the LLM, and DEFERS when deps span multiple Grounds — a NAMED write like "add to Notion" resolves by domain.)
          if (!groundId && Array.isArray(si.dependsOn) && si.dependsOn.length) {
            const depGrounds = [...new Set(si.dependsOn.map((d) => groundBySubIntent.get(d)).filter(Boolean))];
            if (depGrounds.length === 1) { groundId = depGrounds[0]; _via = 'inherit'; }
          }
          // Fallback when the comprehender DIDN'T emit a dependsOn link: a BACK-REFERENCE clause ("note ITS name",
          // "read THAT") with no site refers to the most-recent producer → inherit the immediately-preceding
          // sub-intent's Ground. Fires only after domain + lexical + dependsOn all came up empty (where the LLM would
          // otherwise guess), so worst case it's no worse than that guess — and for a true back-ref, far better.
          if (!groundId && i > 0 && /\b(it|its|that|this|them|they|those|these)\b/i.test(String(clause))) {
            const prev = ordered[i - 1];
            const prevGround = prev && groundBySubIntent.get(prev.id);
            if (prevGround) { groundId = prevGround; _via = 'inherit-ref'; }
          }
          // Else escalate to the LLM ground resolver (closed-set selection by PURPOSE), re-validated vs the catalog.
          if (!groundId) {
            let picked = null;
            try {
              const m = await AnthropicService.matchGround({ clause, grounds: llmGrounds });
              picked = m ? pickValidGround(m.groundId, catalog) : null;
            } catch (e) { Logger.warn('background', `matchGround unavailable: ${e.message}`); }
            // v2.74.962 (gl 174308) — an AMBIGUOUS lexical tie does NOT override the LLM's null. matchGround
            // correctly rejected both known sites for "search for fable on youtube" (YouTube isn't a Ground),
            // but this fallback force-assigned the 0.33/0.33 coin-flip winner → a YouTube search bound on
            // Pixabay, runnable with 0 repairs. LLM-null + ambiguous now resolves to NULL → the sub-intent
            // becomes a GAP (the card's teach/skip affordances; null skips the bind AND the gap→alternate
            // hop below). A non-ambiguous lexical top still backstops an LLM miss/outage.
            const _lexAmbiguous = gr.decision === 'ambiguous';
            groundId = picked || (_lexAmbiguous ? null : gr.groundId) || null;
            _via = picked ? 'llm' : (groundId ? 'lexical-fallback' : (_lexAmbiguous ? 'gap-ambiguous' : 'none'));
            if (gr.decision === 'ambiguous' && !picked) ambiguities.push({ subIntentId: si.id || `s${i}`, clause, candidates: gr.candidates });
          }
          // v2.74.805 — diagnostic: HOW each sub-intent resolved + the chosen Ground's host (reveals a mis-resolution
          // OR a data issue, e.g. a Ground named "Pixabay" whose URL is a different site). DEBUG cross-Ground audit.
          try {
            const _g = byId.get(groundId); let _host = '';
            try { _host = (_g && _g.url) ? new URL(_g.url).hostname.replace(/^www\./, '') : ''; } catch { /* */ }
            const _cands = (gr.candidates || []).slice(0, 3).map((c) => `${String(c.groundId).slice(-6)}:${(Number(c.score) || 0).toFixed(2)}${c.hostHit ? '*' : ''}`).join(', ');
            Logger.debug('background', `T3X resolve ▸ "${String(clause).slice(0, 50)}" → ${groundId ? String(groundId).slice(-6) : 'none'} (${_host || '?'}) [via=${_via}; lexical=${gr.decision || 'n/a'} {${_cands}}]`);
          } catch { /* */ }
          groundBySubIntent.set(si.id, groundId);   // v2.74.824 — record so any downstream consumer can INHERIT this Ground

          // DF-2 — read-vs-action effect (same oracle the chat uses to choose picker-vs-record): a READ clause
          // ("get the top job's link") binds an Observation that PRODUCES a value; an ACTION binds a strategy/fragment.
          const effect = classifyReadAsk(clause).isRead ? 'read' : 'action';
          prepared.push({ si, i, clause, gr, groundId, _via, effect });
        }

        // 3b. v2.74.829 — BIND each resolved sub-intent IN PARALLEL. The bind (matchCapability) + alternate-hop +
        // clause-param bind are INDEPENDENT once the Ground is resolved, so 10 serial LLM round-trips (~50s for a
        // 10-step ask) become concurrent (~the slowest single bind). Resolution (Phase A above) stays ORDERED because
        // INHERIT reads each producer's resolved Ground. Promise.all preserves order → `resolved` is still topo-sorted.
        const resolved = await Promise.all(prepared.map(async ({ si, i, clause, gr, groundId, _via, effect }) => {
          // Bind on the chosen Ground. Q3 — on a bind MISS, try the resolver's RUNNER-UP Grounds before giving up:
          // a different site may hold a capability for this sub-intent (the gap→alternate fallback).
          let chosenGroundId = groundId;
          let bound = chosenGroundId ? await _bindStrategyOnGround(ctx, clause, chosenGroundId, effect) : null;
          // v2.74.806 — a DOMAIN-named Ground is AUTHORITATIVE: do NOT hop to an alternate site on a bind miss. The
          // gap→alternate fallback ran the flower shop's "search for orchids" for a "…on Pixabay" clause, undoing the
          // named-site decision. When the user named the site, a bind miss stays a GAP on THAT Ground (the card offers
          // to teach it there) — never a silent run on a different site. Non-named (lexical/LLM) Grounds still hop.
          // v2.74.825 — an INHERITED Ground (via=inherit / inherit-ref) is authoritative for the SAME reason: a
          // dependent read reads where its PRODUCER ran (the data lives there) — hopping to a runner-up would read the
          // wrong site. So suppress the hop for inherit too; only a lexical/LLM GUESS still hops.
          if (chosenGroundId && (!bound || !bound.capabilityId) && _via !== 'domain' && _via !== 'inherit' && _via !== 'inherit-ref') {
            const alternates = (Array.isArray(gr.candidates) ? gr.candidates : []).map((c) => c.groundId).filter((gid) => gid && gid !== chosenGroundId);
            for (const altId of alternates) {
              const altBound = await _bindStrategyOnGround(ctx, clause, altId, effect);
              if (altBound && altBound.capabilityId) { chosenGroundId = altId; bound = altBound; break; }
            }
          }
          // v2.74.806 — diagnostic: did the bind land a capability on the chosen Ground, or is it a gap? (DEBUG audit)
          try {
            const _bg = byId.get(chosenGroundId); let _bh = '';
            try { _bh = (_bg && _bg.url) ? new URL(_bg.url).hostname.replace(/^www\./, '') : ''; } catch { /* */ }
            Logger.debug('background', `T3X bind ▸ "${String(clause).slice(0, 40)}" on ${chosenGroundId ? String(chosenGroundId).slice(-6) : 'none'}(${_bh || '?'}) → ${bound && bound.capabilityId ? `"${bound.capabilityName || bound.capabilityId}" [${bound.capabilityKind}]` : 'MISS → gap'}`);
          } catch { /* */ }

          // BIND the clause's explicit input VALUES to the bound capability's REAL params (an LLM maps "search for
          // game developer jobs on Indeed" → {SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY:"game developer jobs"}). Without
          // it the binder only PICKS the capability and the search box runs EMPTY. Keyed by EXACT param names so
          // wireCrossGroundData lowers them to step LITERALS; the comprehender's `stated` is the fallback.
          let boundStated = (si.stated && typeof si.stated === 'object') ? { ...si.stated } : {};
          if (bound && bound.capabilityId && Array.isArray(bound.params) && bound.params.length) {
            try {
              const bp = await AnthropicService.bindClauseParams({ clause, params: bound.params });
              if (bp && bp.values && typeof bp.values === 'object') boundStated = { ...boundStated, ...bp.values };
            } catch (e) { Logger.warn('background', `bindClauseParams unavailable: ${e.message}`); }
          }
          // v2.74.808 — a sub-intent that dependsOn an upstream producer consumes its RESULT: a PRONOUN value ("search
          // for IT on Pixabay") is the hand-off reference, NOT a literal. Drop it so wireCrossGroundData binds the param
          // to the upstream output (scope_binding) — else the literal "it" wins and the Pixabay search types "it"
          // instead of the read's title. Deterministic floor; bindClauseParams' prompt also omits these.
          if (Array.isArray(si.dependsOn) && si.dependsOn.length) {
            for (const k of Object.keys(boundStated)) if (_isPronounRef(boundStated[k])) { delete boundStated[k]; }
          }

          const g = chosenGroundId ? byId.get(chosenGroundId) : null;
          return {
            id: si.id || `s${i}`, clause, groundId: chosenGroundId,
            groundName: _groundLabel(g),   // host-derived when the stored name is generic ("Ground") — readable card
            groundUrl: g ? (g.url || (Array.isArray(g.urlPatterns) ? g.urlPatterns[0] : null)) : null,
            capabilityId: bound ? bound.capabilityId : null,
            capabilityKind: bound ? bound.capabilityKind : null,   // 'strategy' | 'fragment' | 'observation' — how the Workflow step dispatches it
            capabilityName: bound ? bound.capabilityName : '',
            params: bound ? bound.params : [],
            outputs: bound ? bound.outputs : [],
            // Reversibility floor: a bound observation has none (reads are always reversible → undefined→true); a bound
            // action carries its derived flag; an unbound gap stays reversible (nothing runs until it's taught). Only a
            // bound IRREVERSIBLE action (reversible===false) makes the card warn + require an explicit run-anyway.
            reversible: bound ? (bound.reversible !== false) : true,
            // DF — a READ step's prerequisite ACTION: the antecedent CAPABILITY (e.g. the search) the executor
            // REPLAYS (via REPLAY_SG_CAPABILITY — a Strategy or Fragment) before the observation read. NOT the
            // embedded `observe` (that wrap-as-Strategy route was removed in v2.74.789) — the read runs
            // observation-native via RUN_OBSERVATION.
            ...(bound && bound.antecedentCapabilityId ? { antecedentCapabilityId: bound.antecedentCapabilityId } : {}),
            ...(bound && bound.antecedentParamBindings ? { antecedentParamBindings: bound.antecedentParamBindings } : {}),
            dependsOn: Array.isArray(si.dependsOn) ? si.dependsOn : [],
            stated: boundStated,   // comprehender's stated ∪ the LLM-bound clause values (exact param names → literals)
          };
        }));

        // 4. Wire the cross-Ground DATA FLOW (literals ← stated; scopeReads ← upstream outputs), then lower (T3X-2).
        wireCrossGroundData(resolved);
        const wfId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const built = buildWorkflowRecord({ id: wfId, intent: ask, name: String(ask).slice(0, 60), resolved });

        // Q3 — the UNBOUND sub-intents become actionable REPAIR hints (author a Strategy on site X / pick a site),
        // so a non-runnable Workflow tells the chat exactly what to teach next instead of dead-ending.
        const repairs = buildGapRepairs(resolved, byId);

        // 5. Save only when asked AND fully runnable (the chat freezes a reviewed Workflow).
        let saved = false;
        if (save && built.workflow && built.runnable) {
          try { await StorageManager.saveWorkflow(built.workflow); saved = true; } catch (e) { Logger.warn('background', `COMPREHEND_CROSS_GROUND save failed: ${e.message}`); }
        }
        Logger.info('background', `COMPREHEND_CROSS_GROUND ▸ "${String(ask).slice(0, 60)}" → ${resolved.length} sub-intent(s), ${((built.workflow && built.workflow.steps) || []).length} step(s) across ${((built.workflow && built.workflow.groundIds) || []).length} Ground(s), runnable=${built.runnable}, ${repairs.length} repair(s)${saved ? ', saved' : ''}`);
        sendResponse({ success: true, workflow: built.workflow, runnable: built.runnable, gaps: built.gaps, repairs, resolved, ambiguities, saved });
      } catch (err) {
        Logger.error('background', `COMPREHEND_CROSS_GROUND failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // OBS-READ — capture an OBSERVATION. The chat runs the picker (START_PICK → PICK_RESULT) and sends the picked
    // selector + the read-ask here; we build a matcher-compatible observation capability (no side effect) and
    // persist it to the SAME sgCapabilities store the chat matches against, seeding the ask as an alias.
    OBSERVE_CAPTURE: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, ask = '', selector = null, structuralSelector = null, label = '', role = '', landmark = null, archetype = null, outputType = null, shape = null } = payload ?? {};
        if (!ask || !selector) { sendResponse({ success: false, error: 'ask + selector required' }); return; }
        let gid = groundId, localeUrl = '';
        if (typeof tabId === 'number') { try { const t = await chrome.tabs.get(tabId); localeUrl = t?.url || ''; if (!gid && localeUrl) { const gs = await StorageManager.getAllGrounds(); gid = _groundIdForUrl(localeUrl, gs); } } catch { /* */ } }   // v2.74.824 — urlPatterns-aware (a merged sibling host resolves)
        if (!gid) { sendResponse({ success: false, error: 'no ground for this page' }); return; }
        const arch0 = (archetype && typeof archetype === 'object' && archetype.selector)
          ? { selector: String(archetype.selector), index: Number.isInteger(archetype.index) ? archetype.index : 0 }
          : null;
        // SELF-CORRECTING CAPTURE — the picker offers up to 3 ways to re-find the value: the positional ARCHETYPE,
        // the synthesized SELECTOR (often a stable [aria-label=…], what Studio stores), and the STRUCTURAL
        // class-chain (brittle — Indeed mutates those classes, so it can fail even on an IMMEDIATE re-read). We
        // VERIFY each on the live page NOW and STORE the first that actually reproduces a value — never persist a
        // selector that can't even re-read at capture time. This is the prior bug's root cause: the chat stored the
        // structural chain and discarded the stable synthesized one.
        Logger.info('background', `OBSERVE_CAPTURE pick ▸ tag="${payload?.tagName || '?'}" label="${String(label).slice(0, 100)}" a11yName="${String((landmark && landmark.accessibleName) || '').slice(0, 100)}" | synth="${selector}" structural="${structuralSelector || '(none)'}" archetype=${arch0 ? `"${arch0.selector}"[${arch0.index}]` : 'none'}`);
        let chosenSelector = selector, chosenArch = arch0, verifiedValue = '', via = 'unverified';
        try {
          await ctx.ensureContentScript(tabId);
          // Same read path as RUN_OBSERVATION / Studio Verify: single selector → OBSERVE_RAW_TEXT (no visibility
          // filter); positional → EXTRACT; both on frameId:0. Normalized to {success, value}.
          const _vx = (sel, opts = {}) => new Promise((r) => {
            const msg = opts.positional
              ? { type: 'EXECUTE_STEP', payload: { action: 'EXTRACT', selector: sel, positional: true, fromIndex: opts.fromIndex || 0 } }
              : { type: 'OBSERVE_RAW_TEXT', payload: { target: sel } };
            try { chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (x) => { void chrome.runtime.lastError; r(x); }); } catch (e) { r({ success: false, error: e.message }); }
          }).then((x) => (x && x.success !== false) ? { success: true, value: (x.value != null ? x.value : x.extractedValue) } : { success: false, error: x && x.error });
          const cands = [];
          if (arch0) cands.push({ kind: 'archetype', sel: arch0.selector, opts: { positional: true, fromIndex: arch0.index } });
          if (selector) cands.push({ kind: 'synth', sel: selector });
          if (structuralSelector && structuralSelector !== selector) cands.push({ kind: 'structural', sel: structuralSelector });
          let won = null;
          for (const c of cands) {
            const v = await _vx(c.sel, c.opts || {});
            const val = (v && v.success !== false && v.value != null) ? String(v.value) : '';
            Logger.info('background', `OBSERVE_CAPTURE verify[${c.kind}] "${String(c.sel).slice(0, 80)}"${c.opts ? `[idx ${c.opts.fromIndex}]` : ''} → ${val.trim() ? `"${val.slice(0, 80)}" ✓` : `MISS (${(v && v.error) || 'empty'})`}`);
            if (val.trim()) { won = c; verifiedValue = val; break; }
          }
          if (won) {
            via = won.kind;
            if (won.kind === 'archetype') { chosenArch = arch0; chosenSelector = selector || structuralSelector; }
            else { chosenSelector = won.sel; chosenArch = null; }   // a single-element selector verified → drop the (failed) archetype
          } else { chosenSelector = selector || structuralSelector; chosenArch = arch0; }   // nothing verified — keep best guess
          Logger.info('background', `OBSERVE_CAPTURE verify RESULT — picker SAW "${String(label).slice(0, 80)}"; STORING via ${via} → ${verifiedValue ? `"${verifiedValue.slice(0, 80)}" ✓` : "NOTHING ✗ (no candidate selector re-reads on this page)"}`);
        } catch (e) { Logger.warn('background', `OBSERVE_CAPTURE verify-at-capture failed: ${e.message}`); }
        const lmk = (landmark && typeof landmark === 'object')
          ? { selector: chosenSelector, role: landmark.role || role || 'region', accessibleName: landmark.accessibleName || label || ask, ...(landmark.hierarchicalContext ? { hierarchicalContext: landmark.hierarchicalContext } : {}) }
          : { selector: chosenSelector, role: role || 'region', accessibleName: label || ask };
        // T3X-DF — CAPTURE-TIME ANTECEDENT: the last action the chat ran on THIS Ground (the search that set up this
        // page) becomes this read's prerequisite, REPLAYED (as that same capability) by the cross-Ground dispatch
        // before reading. A capability ref — a Strategy or a Fragment, run uniformly via REPLAY_SG_CAPABILITY — so no
        // single-fragment resolution / decline is needed. Best-effort; absent ⇒ the read runs on the base URL.
        let antecedentCapabilityId = null, antecedentParamBindings = null, antecedentLabel = '';
        try {
          const last = _lastGroundAction.get(gid);
          if (last && last.capabilityId) {
            antecedentCapabilityId = last.capabilityId;
            const lastCap = (await ctx.readSgCapabilities(gid)).find((c) => c.id === last.capabilityId);
            antecedentLabel = String((lastCap && (lastCap.intent || lastCap.name)) || '').slice(0, 60);
            if (last.bindings && typeof last.bindings === 'object' && Object.keys(last.bindings).length) {
              antecedentParamBindings = last.bindings;
            }
          }
        } catch (e) { Logger.warn('background', `OBSERVE_CAPTURE antecedent inference failed (continuing): ${e.message}`); }
        const cap = buildObservationCapability({
          id: crypto.randomUUID(), ask, intent: ask, goal: ask, groundId: gid, outputType,
          landmark: lmk,
          extract: { selector: chosenSelector, ...(shape ? { shape } : {}), ...(chosenArch ? { archetype: chosenArch } : {}) },
          ...(antecedentCapabilityId ? { antecedentCapabilityId } : {}),
          ...(antecedentParamBindings ? { antecedentParamBindings } : {}),
        });
        cap.localeUrl = localeUrl; cap.createdAt = Date.now();
        cap.aliases = accreteAlias(cap.aliases, ask, { intent: cap.intent });
        await ctx.writeSgCapability(gid, cap);
        try { await ctx.appendOutcomes(gid, [Outcomes.makeStageEvent('accept', { groundId: gid, verdict: 'accepted', input: { roleOrIntent: ask.slice(0, 120) }, detail: { capabilityId: cap.id, shape: 'observation', outputType: cap.outputType, selector: chosenSelector } })]); } catch { /* */ }
        Logger.info('background', `OBSERVE_CAPTURE — "${ask.slice(0, 50)}" ${cap.id} → ${cap.outputType} stored via ${via}: ${chosenArch ? `archetype "${chosenArch.selector}"[${chosenArch.index}]` : `selector "${String(chosenSelector).slice(0, 80)}"`} on ${gid}${antecedentCapabilityId ? ` · antecedent=${antecedentCapabilityId}${antecedentParamBindings ? ` (${Object.keys(antecedentParamBindings).join(',')})` : ''}` : ' · no antecedent inferred'}`);
        sendResponse({ success: true, capability: { id: cap.id, intent: cap.intent, outputType: cap.outputType, kind: 'observation', antecedent: antecedentCapabilityId ? { capabilityId: antecedentCapabilityId, label: antecedentLabel } : null }, sawText: String(label || ''), verifiedValue, via });
      } catch (err) {
        Logger.error('background', `OBSERVE_CAPTURE failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // OBS-READ — RUN an observation: EXTRACT its region from the live page and return the value. NO LLM, NO side
    // effect (a read is always safe to auto-run). The chat shows the value inline; the compiler outputType rides along.
    RUN_OBSERVATION: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, capabilityId = null, fromIndex = null, fixed = false, criteria = '' } = payload ?? {};   // fromIndex: per-item FOREACH override; fixed: re-read the single selector (ORCH-L); criteria: search params for a VISUAL read's prompt (ORCH-CB)
        if (typeof tabId !== 'number' || !groundId || !capabilityId) { sendResponse({ success: false, error: 'tabId + groundId + capabilityId required' }); return; }
        const cap = (await ctx.readSgCapabilities(groundId)).find((c) => c.id === capabilityId);
        if (!cap || cap.kind !== 'observation') { sendResponse({ success: false, error: 'observation not found' }); return; }
        // VISUAL observation (ORCH-CB) — read by SEEING, not a selector: screenshot the page → Claude vision with
        // the stored description. The right instrument for a SEMANTIC condition a selector can't answer (e.g. "are
        // there ACTUAL results, or just suggestions / a 'no matches' banner?"). Returns a typed count/value.
        if (isVisualObservation(cap)) {
          try { await ctx.ensureContentScript(tabId); } catch { /* */ }
          const shot = await performImageFull({ tabId });
          if (!shot || shot.success === false || !shot.dataUrl) { sendResponse({ success: true, ran: true, ok: false, reason: 'I couldn’t capture the page to look at it.' }); return; }
          // Inject the run-time CRITERIA (the upstream search params) so the model judges MATCH, not mere presence.
          const vdesc = withCriteria(cap.observe.visual.description, criteria);
          const llm = await AnthropicService.readImage({ description: vdesc, imageDataUrl: shot.dataUrl });
          if (!llm) { sendResponse({ success: true, ran: true, ok: false, reason: 'I couldn’t read that from the page.' }); return; }
          const inp = visualToInput(llm, cap.outputType);
          Logger.info('background', `RUN_OBSERVATION — ${cap.id} (visual/${cap.outputType || 'count'}) → count=${inp.count} items=${inp.items.length} conf=${llm.confidence ?? '?'}`);
          sendResponse({ success: true, ran: true, ok: true, outputType: cap.outputType || 'count', value: inp.value, items: inp.items, count: inp.count, readVia: 'visual', confidence: llm.confidence ?? null });
          return;
        }
        const ex = (cap.observe && Array.isArray(cap.observe.extracts) && cap.observe.extracts[0]) || null;
        if (!ex || !ex.selector) { sendResponse({ success: false, error: 'observation has no extract selector' }); return; }
        try { await ctx.ensureContentScript(tabId); } catch { /* */ }   // heal a stale-tab port before the read
        // LIST read ("list the title of EACH job") — a `list` observation reads ALL its archetype items in ONE
        // pass and returns the list, NOT a single positional value. (A per-item foreach read passes fromIndex and
        // skips this — it wants the Nth.) COUNT_ELEMENTS with a text field captures every match's text at once.
        if (cap.outputType === 'list' && !fixed && !Number.isInteger(fromIndex) && ex.archetype && ex.archetype.selector) {
          const lr = await new Promise((r) => { try { chrome.tabs.sendMessage(tabId, { type: 'COUNT_ELEMENTS', payload: { selector: ex.archetype.selector, fields: [{ name: 'text', source: '', type: 'string' }], max: 200 } }, { frameId: 0 }, (x) => { void chrome.runtime.lastError; r(x); }); } catch (e) { r({ success: false, error: e.message }); } });
          const recs = (lr && lr.success !== false && Array.isArray(lr.records)) ? lr.records : [];
          const items = recs.map((rec) => String((rec && rec.text) || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
          if (items.length > 1) {
            Logger.info('background', `RUN_OBSERVATION — ${cap.id} (list) → ${items.length} item(s) via archetype "${ex.archetype.selector}"`);
            sendResponse({ success: true, ran: true, ok: true, outputType: 'list', value: items.join('\n'), items, intent: cap.intent, readVia: 'list' });
            return;
          }
          // ≤1 item (the archetype isn't per-item — e.g. it points at the container) → fall through to the single read.
          Logger.info('background', `RUN_OBSERVATION — ${cap.id} (list) archetype "${ex.archetype.selector}" matched ${items.length} — not a per-item selector; falling back to single read`);
        }
        // READ via the SAME path Studio's Verify uses: a single selector → OBSERVE_RAW_TEXT (plain querySelector +
        // textContent, NO visibility filter), on the TOP frame. The archetype's Nth-item read needs EXTRACT's
        // positional mode. BOTH pin frameId:0 — broadcasting to all frames let an Indeed ad/recaptcha iframe answer
        // "no match" first, and a visually-HIDDEN a11y link ("full details of …") is READ by OBSERVE_RAW_TEXT but
        // DROPPED by EXTRACT's visible-only filter — that was the chat-vs-Verify divergence. Normalized return.
        const _read = (selector, opts = {}) => new Promise((r) => {
          const msg = opts.positional
            ? { type: 'EXECUTE_STEP', payload: { action: 'EXTRACT', selector, positional: true, fromIndex: opts.fromIndex || 0 } }
            // v2.74.1009 — preferLeadText narrows a list-fall-through container read to its title node (see below).
            : { type: 'OBSERVE_RAW_TEXT', payload: { target: selector, ...(opts.preferLeadText ? { preferLeadText: true } : {}) } };
          try { chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (x) => { void chrome.runtime.lastError; r(x); }); }
          catch (e) { r({ success: false, error: e.message }); }
        }).then((x) => (x && x.success !== false)
          ? { success: true, extractedValue: (x.extractedValue != null ? x.extractedValue : x.value), leadTag: (x && x.leadTag) || null }
          : { success: false, error: x && x.error });
        // (1) PREFERRED — the positional/archetype read: a value-independent selector matching one element per
        //     list item + the captured index ("the first/Nth"). Survives the list reordering / re-skinning.
        let res = null;
        let via = 'selector';
        const arch = ex.archetype;
        // A FOREACH body read overrides the captured index with the iteration's index (read the Nth item).
        const readIdx = Number.isInteger(fromIndex) ? fromIndex : (arch && Number.isInteger(arch.index) ? arch.index : 0);
        // FIXED re-read (click-in-place foreach): the per-item click updated a detail pane IN PLACE, so the value
        // is at the observation's single selector — NOT the archetype index, which is frozen at one list row (that
        // froze every read to the same "Slightly"). Skip the positional path entirely; read the single selector.
        if (fixed) {
          Logger.info('background', `RUN_OBSERVATION — ${cap.id} fixed re-read: single selector (skipping archetype${arch && arch.selector ? `[idx ${readIdx}]` : ''})`);
        } else if (arch && arch.selector) {
          const ar = await _read(arch.selector, { positional: true, fromIndex: readIdx });
          if (ar && ar.success !== false) { res = ar; via = 'archetype'; }
          else Logger.info('background', `RUN_OBSERVATION — archetype "${arch.selector}"[idx ${readIdx}] miss: ${(ar && ar.error) || 'no value'} — falling back to the single selector (OBSERVE_RAW_TEXT)`);
        } else if (Number.isInteger(fromIndex)) {
          // A per-item (FOREACH) read on an observation with NO archetype can't target the Nth element — the
          // single selector reads the same one every iteration. Surface it rather than returning silent dupes.
          Logger.warn('background', `RUN_OBSERVATION — per-item fromIndex=${fromIndex} requested but ${cap.id} has no archetype selector; the single selector reads the SAME element each iteration (re-capture with a positional pick for per-item reads)`);
        }
        // (2) Single selector — the fallback, and the path for non-list reads. Read via OBSERVE_RAW_TEXT (Verify path).
        //     v2.74.1009 — For a `list` read this fall-through means the archetype isn't per-item (it matched the
        //     CONTAINER, e.g. the whole Indeed job CARD). preferLeadText narrows that container to its title-like
        //     lead node (first heading/link) so the value is "IT Support Technician", not the card blob that then
        //     feeds a downstream search. A no-op for leaf selectors, so scalar reads are unchanged.
        if (!res || res.success === false) res = await _read(ex.selector, { preferLeadText: cap.outputType === 'list' });
        let recovered = null;
        // (3) Both selectors MISSED → self-heal via the captured landmark's description layer, the SAME
        //     LANDMARK_PROBE_OR_RECOVER path fragments use. The structural selector survives the list
        //     changing, but a page re-skin / framework swap can still break it; role + accessibleName +
        //     hierarchicalContext recover the element by meaning. Best-effort: no landmark → no recovery.
        if ((!res || res.success === false) && ex.landmark && typeof ex.landmark === 'object') {
          const lmk = ex.landmark;
          const probe = await new Promise((r) => {
            try {
              chrome.tabs.sendMessage(tabId, {
                type: 'LANDMARK_PROBE_OR_RECOVER',
                payload: { selector: ex.selector, fallback: { role: lmk.role || lmk.a11yRole || null, accessibleName: lmk.accessibleName || null, hierarchicalContext: lmk.hierarchicalContext || null } },
              }, { frameId: 0 }, (x) => { void chrome.runtime.lastError; r(x); });
            } catch (e) { r({ success: false, error: e.message }); }
          });
          if (probe && probe.success && probe.selector) {
            // Recovered a (possibly identical) selector — retry the read against it. via:'selector' means the
            // stored selector actually resolves to one element (the first miss was transient).
            const retry = await _read(probe.selector);
            if (retry && retry.success !== false) {
              res = retry;
              if (probe.via === 'heuristic' && probe.selector !== ex.selector) {
                recovered = { selector: probe.selector, via: probe.via, matchMethod: probe.matchMethod || null };
              }
            }
          }
        }
        // NEVER surface the raw selector / engine error to chat — an observation's job is to return the VALUE,
        // not leak a CSS path. Log the technical detail server-side; give the user a clean, human reason.
        if (!res || res.success === false) {
          Logger.info('background', `RUN_OBSERVATION — ${cap.id} miss: ${(res && res.error) || 'no response from page'}`);
          sendResponse({ success: true, ran: true, ok: false, reason: 'I couldn’t find that value on the page — it may have moved or this isn’t the right page. Point me at it again to refresh what I read.' });
          return;
        }
        const value = res.extractedValue != null ? String(res.extractedValue) : '';
        // v2.74.1009 — Surface the container→title narrowing in the trace (leadTag is set only when a list
        // fall-through read landed on a container and we took its <heading>/<a> lead instead of the full blob).
        if (res.leadTag) Logger.info('background', `RUN_OBSERVATION — ${cap.id} (list) container read narrowed to <${res.leadTag}> lead text → "${value.slice(0, 60)}"`);
        // (4) HEAL the saved selector ONLY on EXACT-name heuristic recovery: the original selector drifted but
        //     we re-found exactly the same element by accessible name → pin the observation to the recovered
        //     structural selector so the next run is direct (no probe round-trip). Substring / fuzzy / role-only
        //     recoveries are deliberately NOT persisted — they may have landed on a near-match we shouldn't make
        //     permanent; they still serve THIS run's value, just without rewriting the capability.
        if (recovered && recovered.matchMethod === 'exact' && recovered.selector) {
          try { ex.selector = recovered.selector; await ctx.writeSgCapability(groundId, cap); Logger.info('background', `RUN_OBSERVATION — healed ${cap.id} selector → "${recovered.selector}" (landmark exact-name recovery)`); }
          catch (e) { Logger.warn('background', `RUN_OBSERVATION heal failed (continuing): ${e.message}`); }
        }
        Logger.info('background', `RUN_OBSERVATION — ${cap.id} (${cap.outputType}) via ${via}${arch && via === 'archetype' ? `[idx ${Number.isInteger(arch.index) ? arch.index : 0}]` : ''} → "${value.slice(0, 60)}"${recovered ? ` [recovered via ${recovered.via}/${recovered.matchMethod || '?'}]` : ''}`);
        sendResponse({ success: true, ran: true, ok: true, outputType: cap.outputType || 'scalar', value, intent: cap.intent, readVia: via, recovered: recovered ? { via: recovered.via, matchMethod: recovered.matchMethod } : null });
      } catch (err) {
        Logger.error('background', `RUN_OBSERVATION failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ORCH-CB — CAPTURE a VISUAL observation: screenshot the page + a vision description (what to count/read), so a
    // SEMANTIC condition is grounded in what Claude SEES, not a selector. Verifies once at capture (reads it) so we
    // store a working read. The condition phrase auto-derives a "count the REAL items, decoys = zero" description.
    CAPTURE_VISUAL_OBSERVATION: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, ask = '', description = '', outputType = 'count' } = payload ?? {};
        if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' }); return; }
        let gid = groundId, localeUrl = '';
        try { const t = await chrome.tabs.get(tabId); localeUrl = t?.url || ''; if (!gid && localeUrl) { const gs = await StorageManager.getAllGrounds(); gid = _groundIdForUrl(localeUrl, gs); } } catch { /* */ }   // v2.74.824 — urlPatterns-aware (a merged sibling host resolves)
        if (!gid) { sendResponse({ success: false, error: 'no ground for this page' }); return; }
        const desc = String(description || '').trim() || describeForCondition(ask);
        const shot = await performImageFull({ tabId });   // verify the capture works + read once
        if (!shot || shot.success === false || !shot.dataUrl) { sendResponse({ success: false, error: 'couldn’t capture the page' }); return; }
        const llm = await AnthropicService.readImage({ description: desc, imageDataUrl: shot.dataUrl });
        const inp = llm ? visualToInput(llm, outputType) : null;
        const cap = buildVisualObservation({ id: crypto.randomUUID(), ask, intent: ask, groundId: gid, description: desc, outputType });
        cap.localeUrl = localeUrl; cap.createdAt = Date.now();
        cap.aliases = accreteAlias(cap.aliases, ask, { intent: cap.intent });
        await ctx.writeSgCapability(gid, cap);
        Logger.info('background', `CAPTURE_VISUAL_OBSERVATION — "${String(ask).slice(0, 50)}" ${cap.id} → ${cap.outputType} (verify count=${inp ? inp.count : '?'}) on ${gid}`);
        sendResponse({ success: true, capability: { id: cap.id, intent: cap.intent, kind: 'observation', via: 'visual', outputType: cap.outputType }, verify: inp ? { count: inp.count, value: inp.value } : null });
      } catch (err) {
        Logger.error('background', `CAPTURE_VISUAL_OBSERVATION failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ORCH-L — COUNT a list observation's items: the FOREACH DRIVER. A list observation's archetype selector
    // matches one element per item, so COUNT_ELEMENTS over it gives N; the interpreter then runs the body per
    // index, and each body read uses RUN_OBSERVATION {fromIndex} to read the Nth. Returns items:[{index}]. NO LLM.
    RUN_OBSERVATION_LIST: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, capabilityId = null, max = 200 } = payload ?? {};
        if (typeof tabId !== 'number' || !groundId || !capabilityId) { sendResponse({ success: false, error: 'tabId + groundId + capabilityId required' }); return; }
        const cap = (await ctx.readSgCapabilities(groundId)).find((c) => c.id === capabilityId);
        if (!cap || cap.kind !== 'observation') { sendResponse({ success: false, error: 'observation not found' }); return; }
        const ex = (cap.observe && Array.isArray(cap.observe.extracts) && cap.observe.extracts[0]) || null;
        const selector = (ex && ex.archetype && ex.archetype.selector) || (ex && ex.selector) || null;
        if (!selector) { sendResponse({ success: false, error: 'observation has no list/archetype selector' }); return; }
        try { await ctx.ensureContentScript(tabId); } catch { /* */ }
        // withSelectors → a UNIQUE per-item selector for each match, so a FOREACH body can CLICK the Nth item.
        // withHrefs → each match's own link (ORCH-L "open each <item>" opens the row's href in a new tab).
        const res = await new Promise((r) => { try { chrome.tabs.sendMessage(tabId, { type: 'COUNT_ELEMENTS', payload: { selector, max, withSelectors: true, withHrefs: true } }, { frameId: 0 }, (x) => { void chrome.runtime.lastError; r(x); }); } catch (e) { r({ success: false, error: e.message }); } });
        const count = (res && res.success !== false && Number.isFinite(res.count)) ? Math.min(res.count, max) : 0;
        const sels = (res && Array.isArray(res.selectors)) ? res.selectors : [];
        const hrefs = (res && Array.isArray(res.hrefs)) ? res.hrefs : [];
        const rawItems = Array.from({ length: count }, (_, i) => ({ index: i, selector: sels[i] || null, href: hrefs[i] || null }));
        // v2.74.837 (ORCH-L) — DEDUP by href so "open each <item>" opens each unique link ONCE (sites repeat rows —
        // Indeed lists some sponsored jobs twice). Rows with NO href are kept as-is (a click-each body wants each row;
        // a same-link pair is never worth opening/clicking twice).
        const _seen = new Set();
        const items = rawItems.filter((it) => { if (!it.href) return true; if (_seen.has(it.href)) return false; _seen.add(it.href); return true; });
        const uniq = items.length;
        Logger.info('background', `RUN_OBSERVATION_LIST — ${cap.id} "${selector}" → ${count} item(s)${count !== uniq ? ` → ${uniq} unique by link` : ''}${sels.length ? ' (+selectors)' : ''}${hrefs.filter(Boolean).length ? ` (+${hrefs.filter(Boolean).length} hrefs)` : ''}`);
        sendResponse({ success: true, ok: uniq > 0, count: uniq, items, intent: cap.intent });
      } catch (err) {
        Logger.error('background', `RUN_OBSERVATION_LIST failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ORCH-L — CLICK a specific selector: the per-item action of a click-in-place FOREACH (click item[i] → a
    // detail panel updates → the body re-reads it). Reuses the content-script CLICK; settle is the caller's job.
    CLICK_SELECTOR: async (payload, _sender, sendResponse) => {
      const _busyTab = (typeof payload?.tabId === 'number') ? payload.tabId : null;   // v2.74.923 (CR-M2) — the per-item click of a click-in-place foreach is engine activity (N synthetic clicks per loop)
      if (_busyTab != null) markEngineBusy(_busyTab, true);
      try {
        const { tabId, selector = null } = payload ?? {};
        if (typeof tabId !== 'number' || !selector) { sendResponse({ success: false, error: 'tabId + selector required' }); return; }
        try { await ctx.ensureContentScript(tabId); } catch { /* */ }
        const res = await new Promise((r) => { try { chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_STEP', payload: { action: 'CLICK', selector } }, { frameId: 0 }, (x) => { void chrome.runtime.lastError; r(x); }); } catch (e) { r({ success: false, error: e.message }); } });
        const ok = !!(res && res.success !== false);
        if (!ok) Logger.info('background', `CLICK_SELECTOR — "${String(selector).slice(0, 80)}" miss: ${(res && res.error) || 'no response'}`);
        sendResponse({ success: true, ok, error: res && res.error });
      } catch (err) {
        Logger.error('background', `CLICK_SELECTOR failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      } finally {
        if (_busyTab != null) markEngineBusy(_busyTab, false);   // v2.74.923 (CR-M2)
      }
    },

    // ORCH-L (open-each) — open a URL in a NEW BACKGROUND tab: the per-item action of an "open each <item>" loop.
    // A new tab (not an in-place click) so the result list the loop iterates over stays put for the next item, and
    // `active:false` so the loop doesn't yank focus away from the side panel on every iteration. http(s) only.
    // FM-1 (v2.74.968) — focus a tab by EVENT or COMMAND, through the one policy (focusTabPolicy above).
    // Chat-side callers: the walk's step activation (required) and terminal recaps (courtesy).
    FOCUS_TAB: async (payload, _sender, sendResponse) => {
      try { sendResponse(await focusTabPolicy(payload ?? {})); }
      catch (err) { sendResponse({ success: false, error: err.message }); }
    },

    OPEN_URL_NEW_TAB: async (payload, _sender, sendResponse) => {
      try {
        const { url = null, active = false } = payload ?? {};
        if (!url || !/^https?:\/\//i.test(String(url))) { sendResponse({ success: false, error: 'a http(s) url is required' }); return; }
        // v2.74.909 — `active` opt-in: a NAV ask ("go to pixabay") should TRANSFER FOCUS, not just open the
        // page; bulk openers (the foreach open-each) keep the background default so the result list stays put.
        const tab = await new Promise((r) => { try { chrome.tabs.create({ url: String(url), active: !!active }, (t) => { void chrome.runtime.lastError; r(t || null); }); } catch (e) { r(null); } });
        const ok = !!(tab && typeof tab.id === 'number');
        if (ok && active && typeof tab.windowId === 'number') { try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* */ } }
        if (ok) Logger.info('background', `OPEN_URL_NEW_TAB — "${String(url).slice(0, 80)}" → tab ${tab.id} (${active ? 'focused' : 'background'})`);
        else Logger.info('background', `OPEN_URL_NEW_TAB — "${String(url).slice(0, 80)}" failed to open`);
        sendResponse({ success: ok, ok, tabId: ok ? tab.id : null, error: ok ? null : 'tab did not open' });   // v2.74.925 (CR-T2) — a failed open is success:false (the nav verb rendered "Opened host." on failures)
      } catch (err) {
        Logger.error('background', `OPEN_URL_NEW_TAB failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // OBS-READ bridge — run the user's MANUAL (Studio-authored) Observation for a read-ask. These live in a
    // DIFFERENT store (StorageManager.listObservations) than the captured observations the ORCH matcher sees, so
    // without this a hand-authored read is invisible to chat. SELECTION is deliberately simple: a SINGLE authored
    // observation is used as-is (don't gate the user's one working read behind a fuzzy score); with several, the
    // best-named lexical match above a LOW floor. EXECUTION reuses the EXACT OBSERVE_* message Studio's "Verify"
    // button dispatches (_observeMessageForExtract) — NOT a reimplementation. A read is reversible → safe to
    // auto-run. {matched:false} → the chat falls through to its own observation/capture flow unchanged.
    RUN_BEST_OBSERVATION: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, ask = '' } = payload ?? {};
        if (typeof tabId !== 'number' || typeof ask !== 'string' || !ask.trim()) { sendResponse({ success: true, matched: false }); return; }
        let gid = groundId, url = '';
        try { url = (await chrome.tabs.get(tabId))?.url || ''; } catch { /* */ }
        if (!gid && url) { try { const gs = await StorageManager.getAllGrounds(); gid = _groundIdForUrl(url, gs); } catch { /* */ } }   // v2.74.824 — urlPatterns-aware (a merged sibling host resolves)
        if (!gid) { Logger.info('background', `RUN_BEST_OBSERVATION — no ground for ${url}`); sendResponse({ success: true, matched: false }); return; }
        let observations = [];
        try { observations = (await StorageManager.listObservations(gid)) || []; } catch (e) { Logger.warn('background', `RUN_BEST_OBSERVATION listObservations failed: ${e.message}`); }
        if (!Array.isArray(observations) || !observations.length) {
          // DIAGNOSTIC — distinguish "never Saved" from "Saved under a DIFFERENT ground" (e.g. indeed.com vs
          // www.indeed.com → different origin → different ground). Count observations on every OTHER ground.
          let elsewhere = [];
          try { for (const g of ((await StorageManager.getAllGrounds()) || [])) { if (!g || g.id === gid) continue; const obs = await StorageManager.listObservations(g.id); if (Array.isArray(obs) && obs.length) elsewhere.push(`${g.id}@${g.url || '?'}(${obs.length})`); } } catch { /* */ }
          Logger.info('background', `RUN_BEST_OBSERVATION — 0 manual observations on ${gid}${elsewhere.length ? ` — BUT found on other ground(s): ${elsewhere.join(', ')} → origin/ground MISMATCH (author + ask are on different origins)` : ' — and NONE on any other ground either → the observation was never Saved (Verify ≠ Save)'}`);
          sendResponse({ success: true, matched: false }); return;
        }
        // SELECTION — a SINGLE authored observation is used as-is (nothing to disambiguate; don't gate the user's
        // one working read behind a fuzzy score). With several, pick the best-named lexical match above a LOW floor.
        let best = null, bestScore = 1;
        if (observations.length === 1) { best = observations[0]; }
        else {
          bestScore = 0;
          for (const o of observations) { const s = scoreObservationMatch(ask, o); if (s > bestScore) { best = o; bestScore = s; } }
          if (!best || bestScore < 0.25) { Logger.info('background', `RUN_BEST_OBSERVATION — ${observations.length} obs, best "${best && best.name}" score ${bestScore.toFixed(2)} < 0.25 → no match`); sendResponse({ success: true, matched: false }); return; }
        }
        // Pick the primary runnable (text/attribute/scalar) extract.
        const impl = Array.isArray(best.implementations) ? best.implementations[0] : null;
        const extracts = (impl && Array.isArray(impl.extracts)) ? impl.extracts : [];
        const ex = extracts.find((e) => _observeMessageForExtract(e)) || null;
        if (!ex) { Logger.info('background', `RUN_BEST_OBSERVATION — "${best.name}" has no text/attribute extract runnable from chat (shapes: ${extracts.map((e) => e && e.shape).join(', ')})`); sendResponse({ success: true, matched: true, ok: false, name: best.name, observationId: best.id, reason: 'no_runnable_extract' }); return; }
        try { await ctx.ensureContentScript(tabId); } catch { /* */ }
        // RUN via the EXACT OBSERVE_* message Studio's Verify uses (top frame, the author's default) — no reimpl.
        const msg = _observeMessageForExtract(ex);
        const res = await new Promise((r) => { try { chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (x) => { void chrome.runtime.lastError; r(x); }); } catch (e) { r({ success: false, error: e.message }); } });
        const value = (res && res.success !== false && res.value != null) ? String(res.value) : '';
        if (!res || res.success === false || !value.trim()) {
          Logger.info('background', `RUN_BEST_OBSERVATION — "${best.name}" extract "${ex.output}" (${ex.shape} via ${msg.type}) miss: ${(res && res.error) || 'no value'}`);
          sendResponse({ success: true, matched: true, ok: false, name: best.name, observationId: best.id, output: ex.output });
          return;
        }
        Logger.info('background', `RUN_BEST_OBSERVATION — "${ask.slice(0, 50)}" → manual obs "${best.name}" ${best.id} via ${msg.type} (score ${typeof bestScore === 'number' ? bestScore.toFixed(2) : '1.00'}) → "${value.slice(0, 60)}"`);
        sendResponse({ success: true, matched: true, ok: true, value, name: best.name, observationId: best.id, output: ex.output });
      } catch (err) {
        Logger.error('background', `RUN_BEST_OBSERVATION failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ORCH-X compiler front-end — SEMANTICALLY decompose a complex ask into an ORDERED plan over the user's
    // recorded capabilities, with per-step param bindings (the NL path's job, applied to capabilities-as-substrate).
    // The lexical decomposeAsk only catches "and/then" boundaries; this catches "search X in Y posted last week"
    // = search THEN filter-by-date. Returns the ordered steps; the chat confirms + chains them. >1 step is the win;
    // 0–1 steps → the chat falls back to the single matcher.
    ORCH_PLAN: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, ask = '' } = payload ?? {};
        if (typeof ask !== 'string' || !ask.trim()) { sendResponse({ success: false, error: 'ask required' }); return; }
        let url = ''; if (typeof tabId === 'number') { try { url = (await chrome.tabs.get(tabId))?.url || ''; } catch { /* */ } }
        let gid = groundId;
        if (!gid && url) { try { const grounds = await StorageManager.getAllGrounds(); gid = _groundIdForUrl(url, grounds); } catch { /* */ } }   // v2.74.824 — urlPatterns-aware (a merged sibling host resolves)
        if (!gid) { sendResponse({ success: true, groundId: null, steps: [] }); return; }
        const localeUrl = ctx.normalizeUrl(url);
        const { liveStrategyIds, liveFragmentIds, strategyFragments } = await _liveBackingIds(gid);   // v2.74.827 — Strategy AND Fragment liveness
        const _orphan = (c) => isOrphanCapability(c, { liveStrategyIds, liveFragmentIds, strategyFragments });
        const caps = (await ctx.readSgCapabilities(gid)).filter((c) => isActiveCapability(c) && !_orphan(c) && c.kind !== 'composite');   // composites (T2) aren't plan STEPS — don't nest
        const candidates = (Array.isArray(caps) ? caps : []).map((c) => toCandidate(c)).filter(Boolean);
        if (candidates.length < 2) { sendResponse({ success: true, groundId: gid, steps: [] }); return; }   // <2 caps → nothing to compose
        let affordances = [];
        try { const pm = await ctx.readLocaleCache(gid, localeUrl); affordances = localeAffordanceLabels(pm && pm.model); } catch { /* */ }
        let plan = null;
        try { plan = await AnthropicService.planAskOverCapabilities({ ask, candidates, affordances }); } catch { /* */ }
        if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) { sendResponse({ success: true, groundId: gid, steps: [] }); return; }
        const byId = new Map(candidates.map((c) => [String(c.id), c]));
        const steps = [];
        for (const s of plan.steps) {
          const cand = byId.get(String(s && s.id)); if (!cand) continue;
          let bindings = {};
          if (s.bindings && Object.keys(s.bindings).length) { try { bindings = validateBindings(s.bindings, cand, affordances).bound; } catch { /* */ } }
          steps.push({ capabilityId: cand.id, intent: cand.intent, bindings, clause: s.clause || '', kind: cand.kind || null, outputType: (cand.raw && cand.raw.outputType) || null });
        }
        const gaps = Array.isArray(plan.uncovered) ? plan.uncovered : [];
        // ORCH-L — when the ask QUANTIFIES over a collection ("the salaries of EACH job"), lift the flat plan into
        // a control-flow plan (a foreach over the list observe). Keep it only if it's structurally well-formed;
        // otherwise fall back to the flat sequence (honest degradation, never a broken plan).
        let outSteps = steps;
        try {
          const lift = liftControlFlow(steps, ask);
          if (lift.lifted) {
            const v = validatePlan({ steps: lift.steps });
            if (v.ok) { outSteps = lift.steps; Logger.info('background', `ORCH_PLAN ▸ lifted to control-flow: foreach over the list${lift.collect ? ` → collect ${lift.collect}` : ''}${lift.openEach ? ` (open-each "${lift.teachNoun}" — teach the list on run)` : ''}`); }
            else Logger.warn('background', `ORCH_PLAN ▸ lift rejected (kept flat): ${v.errors.join('; ')}`);
          }
        } catch (e) { Logger.warn('background', `ORCH_PLAN lift failed (kept flat): ${e.message}`); }
        // ORCH-A — a CONDITIONAL ask ("if there are any remote jobs, save the search") lifts to a predicate → gate:
        // the consequent action runs only when the analysis of the condition observation holds. Tried only when the
        // foreach lift didn't fire (the two shapes are distinct). Kept only if structurally well-formed.
        if (outSteps === steps) {
          try {
            const cl = liftConditional(steps, ask);
            if (cl.lifted) {
              const v = validatePlan({ steps: cl.steps });
              if (v.ok) { outSteps = cl.steps; Logger.info('background', `ORCH_PLAN ▸ lifted to conditional: gate on predicate (${cl.predicate && cl.predicate.op}${cl.predicate && cl.predicate.value != null ? ` ${cl.predicate.value}` : ''}${cl.predicate && cl.predicate.negate ? ', negated' : ''})`); }
              else Logger.warn('background', `ORCH_PLAN ▸ conditional lift rejected (kept flat): ${v.errors.join('; ')}`);
            }
          } catch (e) { Logger.warn('background', `ORCH_PLAN conditional lift failed (kept flat): ${e.message}`); }
        }
        Logger.info('background', `ORCH_PLAN ▸ ask="${String(ask).slice(0, 70)}" → ${steps.length} step(s): ${steps.map((s) => `"${s.intent}"${Object.keys(s.bindings).length ? `[${JSON.stringify(s.bindings)}]` : ''}`).join(' → ') || '(none)'}${gaps.length ? ` | uncovered: ${JSON.stringify(gaps)}` : ''}`);
        // ORCH-CB SHADOW — comprehend→bind alongside the LLM plan; LOG the divergence (observational, NO response
        // change, no LLM). Measures how much of the WARM case the deterministic floor already covers → informs the
        // warm-path swap. Best-effort: never affects the result.
        try {
          const comp = comprehend(ask);
          const _lean = (c) => ({ id: c.id, intent: c.intent || '', name: c.name || '', aliases: Array.isArray(c.aliases) ? c.aliases : [] });
          const sPools = { read: caps.filter((c) => c.kind === 'observation').map(_lean), act: caps.filter((c) => c.kind !== 'observation').map(_lean) };
          const cb = bindShape(comp, sPools, { score: lexicalScore, threshold: 0.5 });
          const cmp = shadowCompare(outSteps, cb.steps);
          Logger.info('background', `ORCH_PLAN shadow ▸ llm=${cmp.llmShape}(${cmp.llmBound}b) cb=${cmp.cbShape}(${cmp.cbBound}b) shapeMatch=${cmp.shapeMatch} agree=${cmp.agreeCount}/${cmp.llmBound}${comp.escalate ? ' esc' : ''}`);
        } catch (e) { Logger.warn('background', `ORCH_PLAN shadow failed (ignored): ${e.message}`); }
        sendResponse({ success: true, groundId: gid, steps: outSteps, gaps, rationale: plan.rationale || '' });
      } catch (err) {
        Logger.error('background', `ORCH_PLAN failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ORCH-CB — BIND a comprehended PlanShape against THIS ground's substrates, PER SLOT, scoped by EFFECT (a read
    // slot only sees observations; an act slot only non-observations). Lexical floor only — NO LLM: it binds the
    // WARM/cached slots (intent/alias-exact, token recall) and leaves novel slots as GAPS. The chat comprehends the
    // shape (substrate-free), then asks this to fill it; a fully-bound shape can run, a partial one shows gaps.
    ORCH_BIND: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, shape = null } = payload ?? {};
        const steps = (shape && Array.isArray(shape.steps)) ? shape.steps : (Array.isArray(shape) ? shape : []);
        if (!steps.length) { sendResponse({ success: true, groundId: groundId || null, steps: [], gaps: [] }); return; }
        let gid = groundId, url = '';
        if (typeof tabId === 'number') { try { url = (await chrome.tabs.get(tabId))?.url || ''; } catch { /* */ } }
        if (!gid && url) { try { const gs = await StorageManager.getAllGrounds(); gid = _groundIdForUrl(url, gs); } catch { /* */ } }   // v2.74.824 — urlPatterns-aware (a merged sibling host resolves)
        let caps = [];
        if (gid) { try { caps = (await ctx.readSgCapabilities(gid)).filter((c) => isActiveCapability(c) && c.kind !== 'composite'); } catch { /* */ } }
        const lean = (c) => ({ id: c.id, intent: c.intent || '', name: c.name || '', aliases: Array.isArray(c.aliases) ? c.aliases : [] });
        const pools = {
          read: caps.filter((c) => c.kind === 'observation').map(lean),   // EFFECT partition: reads ← observations
          act: caps.filter((c) => c.kind !== 'observation').map(lean),    //                  acts  ← everything else
        };
        const r = bindShape({ steps }, pools, { score: lexicalScore, threshold: 0.5 });
        Logger.info('background', `ORCH_BIND — ${steps.length} slot(s) over ${caps.length} cap(s) → ${r.gaps.length} gap(s)${r.bound ? ' (fully bound)' : ''} on ${gid || '(no ground)'}`);
        sendResponse({ success: true, groundId: gid, steps: r.steps, gaps: r.gaps, bound: r.bound });
      } catch (err) {
        Logger.error('background', `ORCH_BIND failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ORCH-X T2 — PROMOTE a verified compound run into a durable COMPOSITE capability. A discrete intent durably
    // becomes a T1 capability; a compound intent durably becomes a T2 composite, so the next time the SAME ask is a
    // cache hit (matched atomically) instead of re-decomposed. Rides the same sgCapabilities matcher store; reuses
    // accreteAlias + writeSgCapability — no new composition engine. The steps are references to the T1 artifacts.
    ACCEPT_COMPOUND: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, ask = '', steps = [], plan = null, name = '' } = payload ?? {};
        // CONTROL-FLOW composite (a quantified T2 artifact) — the plan carries foreach/loop/gate nodes; its IR is
        // stored intact + a param-abstracted intent is DERIVED. A FLAT composite needs ≥2 capability-backed steps.
        const _hasCF = (arr) => Array.isArray(arr) && arr.some((s) => s && (s.kind === 'foreach' || s.kind === 'loop' || s.kind === 'gate'));
        const isCF = _hasCF(plan && plan.steps) || _hasCF(steps);
        const usable = (Array.isArray(steps) ? steps : []).filter((s) => s && s.capabilityId);
        if (!ask || (!isCF && usable.length < 2)) { sendResponse({ success: false, error: 'ask + ≥2 steps with capabilityId required' }); return; }
        let gid = groundId, localeUrl = '';
        if (typeof tabId === 'number') { try { const t = await chrome.tabs.get(tabId); localeUrl = t?.url || ''; if (!gid && localeUrl) { const gs = await StorageManager.getAllGrounds(); gid = _groundIdForUrl(localeUrl, gs); } } catch { /* */ } }   // v2.74.824 — urlPatterns-aware (a merged sibling host resolves)
        if (!gid) { sendResponse({ success: false, error: 'no ground for this page' }); return; }
        const cap = buildCompositeCapability(isCF
          ? { id: crypto.randomUUID(), ask, groundId: gid, plan: (plan && Array.isArray(plan.steps)) ? plan : { steps }, name }   // intent DERIVED (param-abstracted)
          : { id: crypto.randomUUID(), ask, intent: ask, goal: ask, groundId: gid, steps: usable, name });
        cap.localeUrl = localeUrl; cap.createdAt = Date.now();
        // The raw ASK accretes as an alias so the SAME ask is a lexical T2 cache hit next time. The TEMPLATE
        // generalizes it across arguments: each bound value that appears in the ask becomes a {PARAM} hole, so
        // "search for software jobs and if any, sort" rebinds this "android" composite instead of saving its own.
        cap.aliases = accreteAlias(cap.aliases, ask, { intent: cap.intent });
        try {
          const _allBindings = {};
          const _cbind = (steps) => { for (const s of (steps || [])) { if (s && s.kind === 'fragment' && s.bindings) Object.assign(_allBindings, s.bindings); if (s && Array.isArray(s.body)) _cbind(s.body); } };
          _cbind(cap.steps);
          const tmpl = buildCompositeTemplate(ask, _allBindings);
          if (tmpl.slots.length) { cap.template = tmpl.template; cap.templateSlots = tmpl.slots; }
        } catch { /* template is best-effort; the exact-alias hit still works */ }
        await ctx.writeSgCapability(gid, cap);
        try { await ctx.appendOutcomes(gid, [Outcomes.makeStageEvent('accept', { groundId: gid, verdict: 'accepted', input: { roleOrIntent: ask.slice(0, 120) }, detail: { capabilityId: cap.id, shape: isCF ? 'composite-cf' : 'composite', steps: cap.steps.length } })]); } catch { /* */ }
        Logger.info('background', `ACCEPT_COMPOUND — "${ask.slice(0, 50)}" ${cap.id} → T2 ${isCF ? 'control-flow ' : ''}composite of ${cap.steps.length} step(s) [${cap.steps.map((s) => s.kind || 'action').join(' → ')}]${isCF ? ` intent="${cap.intent}" params=[${(cap.params || []).join(', ')}] → ${cap.output ? `${cap.output.name}:${cap.output.type}` : '?'}` : ''} on ${gid}`);
        sendResponse({ success: true, capability: { id: cap.id, intent: cap.intent, kind: 'composite', controlFlow: cap.controlFlow, steps: cap.steps.length, params: cap.params, output: cap.output || null } });
      } catch (err) {
        Logger.error('background', `ACCEPT_COMPOUND failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ORCH-X T2 — the cheap (NO LLM) cache lookup: does a SAVED composite cover this exact compound ask? Lexical
    // alias/intent match over composite capabilities on the page's Ground. Hit → return its steps so the chat runs
    // them via the existing plan runner; miss → the chat decomposes fresh (and can re-promote). Called only for
    // compound-ish asks, so simple asks pay nothing.
    MATCH_COMPOSITE: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, ask = '' } = payload ?? {};
        if (typeof ask !== 'string' || !ask.trim()) { sendResponse({ success: true, matched: false }); return; }
        let gid = groundId, url = '';
        try { url = (await chrome.tabs.get(tabId))?.url || ''; } catch { /* */ }
        if (!gid && url) { try { const gs = await StorageManager.getAllGrounds(); gid = _groundIdForUrl(url, gs); } catch { /* */ } }   // v2.74.824 — urlPatterns-aware (a merged sibling host resolves)
        if (!gid) { sendResponse({ success: true, matched: false }); return; }
        const want = normalizeAliasPhrase(ask);
        const caps = (await ctx.readSgCapabilities(gid)).filter((c) => c && c.kind === 'composite' && isActiveCapability(c) && Array.isArray(c.steps) && c.steps.length);
        // (1) EXACT — the same ask (or a learned alias) → run the stored steps as-is.
        let hit = caps.find((c) => normalizeAliasPhrase(c.intent || '') === want || (Array.isArray(c.aliases) && c.aliases.some((a) => normalizeAliasPhrase(a) === want)));
        let steps = hit ? hit.steps : null;
        let rebind = null;
        // (2) TEMPLATE — a DIFFERENT argument, same shape: fit the ask to a composite's template, capture the new
        // value(s), and REBIND the IR. "search for software jobs and if any, sort" → the "android" composite.
        if (!hit) {
          for (const c of caps) {
            if (!c.template) continue;
            const nb = matchTemplate(ask, c.template);
            if (nb) { hit = c; rebind = nb; steps = rebindSteps(c.steps, nb); break; }
          }
        }
        if (!hit) { sendResponse({ success: true, matched: false }); return; }
        Logger.info('background', `MATCH_COMPOSITE — T2 cache HIT "${ask.slice(0, 50)}" → ${hit.controlFlow ? 'control-flow ' : ''}composite ${hit.id} (${steps.length} step(s))${rebind ? ` REBOUND ${JSON.stringify(rebind)}` : ''}`);
        sendResponse({ success: true, matched: true, groundId: gid, capabilityId: hit.id, intent: hit.intent, steps, controlFlow: !!hit.controlFlow, rebound: rebind || null });
      } catch (err) {
        Logger.error('background', `MATCH_COMPOSITE failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // CONVERGE (v2.74.745) — PROMOTE a control-flow T2 composite into a CANONICAL, runnable Strategy: Studio-
    // visible, ParamForm-launchable, executed by the ONE ExecutionEngine runtime. The composite's matcher cap is
    // "a Strategy wearing a matcher costume" — this unwraps it. The leaf capabilityIds are RESOLVED to library
    // refs (a T1 fragment cap → its saved Strategy's fragmentSteps; an observation cap → a materialized count-safe
    // Observation), then translatePlan maps the ORCH IR → a Strategy plan tree whose gate is an `orch_predicate`
    // DETECT (identical truth, same evaluatePredicate). ADDITIVE + FENCED: every failure path (visual condition,
    // unresolved leaf, validation miss) → promoted:false, the composite is UNCHANGED and still runs via walkPlan
    // (R7). The chat run path is never touched — this only ADDS a reviewable `synthesized` Strategy artifact.
    PROMOTE_COMPOSITE_STRATEGY: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, capabilityId = null } = payload ?? {};
        let gid = groundId, url = '';
        try { url = (await chrome.tabs.get(tabId))?.url || ''; } catch { /* */ }
        if (!gid && url) { try { const gs = await StorageManager.getAllGrounds(); gid = _groundIdForUrl(url, gs); } catch { /* */ } }   // v2.74.824 — urlPatterns-aware (a merged sibling host resolves)
        if (!gid || !capabilityId) { sendResponse({ success: false, error: 'groundId + capabilityId required' }); return; }

        const caps = await ctx.readSgCapabilities(gid);
        const cap = caps.find((c) => c.id === capabilityId);
        if (!cap || cap.kind !== 'composite' || !cap.controlFlow) { sendResponse({ success: true, promoted: false, reason: 'not a control-flow composite (only quantified/conditional composites converge)' }); return; }
        if (cap.strategyId) { sendResponse({ success: true, promoted: true, alreadyPromoted: true, strategyId: cap.strategyId }); return; }

        const now = Date.now();
        // Leaf resolution (the ONLY I/O the pure promoter needs) — injected so the brain stays mockable/tested.
        const resolveFragmentCap = async (cid) => {
          const c = caps.find((x) => x.id === cid);
          if (!c) return null;
          if (c.strategyId) {
            const strat = await StorageManager.getStrategy(c.strategyId);
            const fs = (strat && Array.isArray(strat.fragmentSteps)) ? strat.fragmentSteps : null;
            return (fs && fs.length) ? { fragmentSteps: fs } : null;
          }
          // T1-as-first-class — a bare-Fragment leaf cap (no Strategy wrapper): its single fragment node IS the splice.
          if (c.fragmentId) return { fragmentSteps: [{ type: 'fragment', fragmentId: c.fragmentId, paramBindings: {} }] };
          return null;
        };
        // STAGE observation records — don't persist until the WHOLE promote succeeds, so a later unresolved leaf or
        // a validation miss never leaves orphaned Observation records (phantoms in the Studio library).
        const stagedObs = [];
        const resolveObserveCap = async (cid, step) => {
          const c = caps.find((x) => x.id === cid);
          const obsId = crypto.randomUUID();
          const rec = buildConvergeObservationRecord(c, step.id, { observationId: obsId, now });
          if (!rec) return null;                          // visual / no selector → unresolvable → fail closed (R7)
          stagedObs.push(rec);
          return { observationId: obsId };
        };

        const strategyId = crypto.randomUUID();
        const r = await promoteComposite(cap, { resolveFragmentCap, resolveObserveCap, strategyId, now });
        if (!r.ok) {
          Logger.info('background', `PROMOTE_COMPOSITE_STRATEGY — ${capabilityId} NOT promoted (stays matcher-only via walkPlan, R7): ${r.errors.join('; ')}`);
          sendResponse({ success: true, promoted: false, errors: r.errors });
          return;   // stagedObs discarded unsaved — no orphans
        }
        for (const rec of stagedObs) await StorageManager.saveObservation(rec);   // commit reads only on success
        await StorageManager.saveStrategy(r.strategy);
        cap.strategyId = strategyId; cap.promotedAt = now;   // back-reference: the composite now points at its canonical Strategy
        await ctx.writeSgCapability(gid, cap);
        try { await ctx.appendOutcomes(gid, [Outcomes.makeStageEvent('accept', { groundId: gid, verdict: 'accepted', input: { roleOrIntent: (cap.intent || '').slice(0, 120) }, detail: { capabilityId, strategyId, shape: 'converged-strategy', nodes: r.strategy.fragmentSteps.length } })]); } catch { /* */ }
        Logger.info('background', `PROMOTE_COMPOSITE_STRATEGY — ${capabilityId} → Strategy ${strategyId} "${r.strategy.name}" (${r.strategy.fragmentSteps.length} node(s), params=[${r.strategy.params.map((p) => p.name).join(', ')}]) — now Studio-visible / ParamForm-launchable`);
        sendResponse({ success: true, promoted: true, groundId: gid, strategyId, name: r.strategy.name, params: r.strategy.params, nodes: r.strategy.fragmentSteps.length });
      } catch (err) {
        Logger.error('background', `PROMOTE_COMPOSITE_STRATEGY failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // SG-5 / PB-7 — REPLAY an accepted capability. NO LLM. Prefer the promoted landmark-backed Strategy
    // (registry recovery via applyLandmarkRefToStep → LANDMARK_PROBE_OR_RECOVER); fall back to the binding.
    REPLAY_SG_CAPABILITY: async (payload, _sender, sendResponse) => {
      const _busyTab = (typeof payload?.tabId === 'number') ? payload.tabId : null;   // v2.74.908 — monitor self-capture suppression
      if (_busyTab != null) markEngineBusy(_busyTab, true);   // v2.74.922 (CR-M1) — via the refcount
      try {
        const { tabId, groundId = null, capabilityId = null, paramValues = null } = payload ?? {};
        if (!groundId || !capabilityId) { sendResponse({ success: false, error: 'groundId + capabilityId required' }); return; }
        // v2.74.833 — accept the cap's OWN id OR its DISPATCH id (strategyId/fragmentId). The cross-Ground bind
        // (_bindStrategyOnGround) returns the DISPATCH id for an action step, so the in-order walk passed THAT to
        // REPLAY and the by-`id`-only lookup missed → "capability not found" (success=false → the "indeed opens, nothing").
        const cap = (await ctx.readSgCapabilities(groundId)).find((c) => c && (c.id === capabilityId || c.strategyId === capabilityId || c.fragmentId === capabilityId));
        if (!cap) { sendResponse({ success: false, error: 'capability not found' }); return; }
        // OBS-4b — an observed capability is parameterized: seed EVERY templated param with its demonstrated
        // default, then overlay user-supplied NEW values. Always seeding defaults is REQUIRED — executeStrategy
        // does NOT auto-apply param defaults, so an unseeded `{{NAME}}` would type/route the literal placeholder.
        const strategyParamValues = {};
        for (const p of (Array.isArray(cap.params) ? cap.params : [])) {
          if (p && p.name && p.used) strategyParamValues[p.name] = p.value != null ? String(p.value) : '';
        }
        // v2.74.1028 — collect supplied keys that match NO templated param: a resolved binding with nowhere to land
        // (e.g. the user disambiguated to a capability whose param schema differs from the top pick the LLM bound).
        // Reported back as `ignoredKeys` so the chat can avoid banking a confirmation on a run that silently fell
        // back to a demonstrated sample value the user never asked for.
        const ignoredKeys = [];
        if (paramValues && typeof paramValues === 'object') {
          for (const [k, v] of Object.entries(paramValues)) {
            if (k && strategyParamValues[k] !== undefined) strategyParamValues[k] = String(v ?? '');
            else if (k) ignoredKeys.push(k);
          }
        }
        if (ignoredKeys.length) Logger.warn('background', `REPLAY_SG_CAPABILITY — ${ignoredKeys.length} supplied binding(s) had no matching param [${ignoredKeys.join(', ')}] → ran on demonstrated default (not banking a confirmation)`);
        let liveUrl = '';
        if (typeof tabId === 'number') { try { const t = await chrome.tabs.get(tabId); liveUrl = t?.url ?? ''; } catch { /* */ } }
        // Page-drift guard — refuse only on a different SITE (origin), not a different path. A demonstrated
        // capability often works site-wide (a global search bar, nav); landmark recovery finds the controls
        // wherever they are, and a step that genuinely needs another page fails gracefully. Cross-origin is the
        // real "wrong place" — that we still refuse.
        const _orig = (u) => { try { return new URL(u).origin; } catch { return ''; } };
        if (cap.localeUrl && liveUrl && _orig(liveUrl) && _orig(cap.localeUrl) && _orig(liveUrl) !== _orig(cap.localeUrl)) {
          sendResponse({ success: true, ran: false, reason: `this capability is for ${_orig(cap.localeUrl)} but you're on ${_orig(liveUrl)} — go there and re-run` });
          return;
        }
        // Preferred: run the saved, landmark-backed Strategy (the promoted library entity).
        if (cap.strategyId) {
          let result = null;
          // Heal a stale-tab content-script port (tab open since an extension reload) BEFORE running, so the
          // strategy doesn't fail every step with "Receiving end does not exist".
          if (typeof tabId === 'number') { try { await ctx.ensureContentScript(tabId); } catch { /* */ } }
          try { result = await ExecutionEngine.executeStrategy({ strategyId: cap.strategyId, strategyParamValues, targetTabId: (typeof tabId === 'number' ? tabId : null) }); }
          catch (e) { sendResponse({ success: false, error: `replay strategy failed: ${e.message}` }); return; }
          const ok = !!(result && result.success);
          const err = String(result?.error || '');
          // SELF-HEAL — only when the Strategy RECORD is genuinely gone (the sgCapability outlived its Strategy).
          // The error string is NOT trustworthy — a CONTENT-SCRIPT failure "Receiving end does not exist" contains
          // "does not exist" and was wrongly pruning healthy capabilities. So require a strategy-missing-shaped
          // error AND VERIFY the record is actually absent before deleting anything.
          const looksMissing = /\bstrateg(?:y|ies)\b[^\n]*\bnot found\b|\bno such strategy\b|\bmissing strategy\b/i.test(err);
          let trulyMissing = false;
          if (!ok && looksMissing) { try { trulyMissing = !(await StorageManager.getStrategy(cap.strategyId)); } catch { trulyMissing = false; } }
          if (!ok && looksMissing && trulyMissing) {
            try { const pruned = await ctx.removeSgCapabilities(groundId, (c) => c.id === cap.id); if (pruned) Logger.info('background', `REPLAY_SG_CAPABILITY — pruned orphaned capability ${cap.id} (strategy ${cap.strategyId} confirmed missing)`); } catch { /* */ }
            // Deletion is invisible to the conversation: signal a clean MISS so the chat treats this as a NEW
            // request (offer to record), NOT an announcement that something was removed.
            sendResponse({ success: true, ran: false, pruned: true });
            return;
          }
          const pv = Object.keys(strategyParamValues);
          // T3X-DF — a clean run drove this Ground's state → remember it as a candidate ANTECEDENT for a later READ
          // capture here (the search-before-the-read). Only on ok (a failed run left the page in an uncertain state).
          if (ok) { try { _lastGroundAction.set(groundId, { capabilityId: cap.id, bindings: { ...strategyParamValues } }); } catch { /* */ } }
          Logger.info('background', `REPLAY_SG_CAPABILITY — "${cap.intent || cap.name || '?'}" ${cap.id} via saved strategy ${cap.strategyId} → ${ok ? 'ok' : 'failed'} (NO LLM, landmark recovery${pv.length ? `, params: ${pv.join(', ')}` : ''})`);
          sendResponse({ success: true, ran: true, replayed: true, via: 'strategy', capabilityId: cap.id, ok, ignoredKeys, reason: ok ? undefined : (result?.error || 'a step failed') });
          return;
        }
        // T1-as-first-class (v2.74.752) — a bare T1 capability saved as a FRAGMENT (no Strategy wrapper, the
        // ≥2-T1 taxonomy fix): run it by wrapping the Fragment in a SYNTHETIC one-step strategy AT RUN TIME and
        // executing that inline (never persisted, so it stays a Fragment in the library). Same ExecutionEngine
        // path as a saved strategy — only the wrapper is synthetic. Today no cap is fragment-only (all carry a
        // strategyId, handled above), so this is inert until the accept guard starts saving bare T1s.
        if (cap.fragmentId) {
          if (typeof tabId === 'number') { try { await ctx.ensureContentScript(tabId); } catch { /* */ } }
          let frag = null; try { frag = await StorageManager.getFragment(cap.fragmentId); } catch { /* */ }
          if (frag) {
            const synthetic = CapabilitySynth.wrapFragmentAsStrategy(frag, { strategyId: `fragment:${frag.id}`, now: Date.now() });
            let result = null;
            try { result = await ExecutionEngine.executeStrategy({ strategyId: synthetic.id, strategy: synthetic, strategyParamValues, targetTabId: (typeof tabId === 'number' ? tabId : null) }); }
            catch (e) { sendResponse({ success: false, error: `replay fragment failed: ${e.message}` }); return; }
            const ok = !!(result && result.success);
            if (ok) { try { _lastGroundAction.set(groundId, { capabilityId: cap.id, bindings: { ...strategyParamValues } }); } catch { /* */ } }   // T3X-DF — candidate antecedent for a later READ capture on this Ground
            Logger.info('background', `REPLAY_SG_CAPABILITY — "${cap.intent || cap.name || '?'}" ${cap.id} via bare FRAGMENT ${cap.fragmentId} (T1, wrapped at run time, NO LLM)`);
            sendResponse({ success: true, ran: true, replayed: true, via: 'fragment', capabilityId: cap.id, ok, ignoredKeys, reason: ok ? undefined : (result?.error || 'a step failed') });
            return;
          }
        }
        // Fallback (pre-LM-5 capability): re-synth from the lean binding (still landmark-backed via LM-3).
        const roles = Array.isArray(cap.binding) ? cap.binding : [];
        if (!roles.length) { sendResponse({ success: true, ran: false, reason: 'capability has no saved strategy or binding' }); return; }
        let localeModel = null;
        try { const pm = await ctx.readLocaleCache(groundId, ctx.normalizeUrl(cap.localeUrl || liveUrl)); localeModel = pm?.model || null; } catch { /* */ }
        Logger.info('background', `REPLAY_SG_CAPABILITY — "${cap.intent || cap.name || '?'}" ${cap.id} via binding fallback (${roles.length} role(s), NO LLM)`);
        const out = await ctx.runTrialBundle({ groundId, intent: cap.intent, roles, localeModel, navigateUrl: null, proposedRoleCount: roles.length, targetTabId: (typeof tabId === 'number' ? tabId : null) });
        sendResponse({ ...out, replayed: true, via: 'binding', capabilityId: cap.id });
      } catch (err) {
        Logger.error('background', `REPLAY_SG_CAPABILITY failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      } finally { if (_busyTab != null) markEngineBusy(_busyTab, false); }   // v2.74.908; via the refcount since v2.74.922 (CR-M1)
    },

    // GA-3 (Win 1) — RE-VERIFY a saved capability: re-run its trial from the saved binding on the LIVE page and write
    // a FRESH health verdict back. A capability is born `healthStatus:'untested'` and never re-proven (the trial runs
    // once, at accept); unattended, trust silently decays as the site drifts. This re-runs the SAME scored machinery
    // the REPLAY binding-fallback uses (ctx.runTrialBundle) — irreversible terminals stay DEFERRED by
    // classifyTrialSafety, so re-verify never fires a submit/apply, it only re-proves reachability. Lazy /
    // Studio-triggered (no scheduler): trial-pass → healthStatus 'ready'; trial-fail → 'broken'. The verdict vector
    // becomes the capability's live trust score (consumed by GA-4's pending-review / arm gate).
    REVERIFY_SG_CAPABILITY: async (payload, _sender, sendResponse) => {
      try {
        const { tabId = null, groundId = null, capabilityId = null } = payload ?? {};
        if (!groundId || !capabilityId) { sendResponse({ success: false, error: 'groundId + capabilityId required' }); return; }
        const cap = (await ctx.readSgCapabilities(groundId)).find((c) => c && (c.id === capabilityId || c.strategyId === capabilityId || c.fragmentId === capabilityId));
        if (!cap) { sendResponse({ success: false, error: 'capability not found' }); return; }
        const roles = Array.isArray(cap.binding) ? cap.binding : [];
        if (!roles.length) { sendResponse({ success: true, reverified: false, reason: 'capability has no saved binding to re-trial' }); return; }
        // DRIFT GUARD — never trial the wrong page (mirrors RUN_SG_TRIAL): the live tab must match the capability's
        // Locale URL, or the trial would type this capability's selectors into whatever else loaded.
        let liveUrl = '';
        if (typeof tabId === 'number') { try { const t = await chrome.tabs.get(tabId); liveUrl = t?.url || ''; } catch { /* */ } }
        const targetUrl = cap.localeUrl || '';
        if (targetUrl && liveUrl && ctx.normalizeUrl(liveUrl) !== ctx.normalizeUrl(targetUrl)) {
          sendResponse({ success: true, reverified: false, reason: `the page is "${String(liveUrl).slice(0, 80)}" but this capability targets "${String(targetUrl).slice(0, 80)}" — navigate there and re-verify` });
          return;
        }
        let localeModel = null;
        try { const pm = await ctx.readLocaleCache(groundId, ctx.normalizeUrl(targetUrl || liveUrl)); localeModel = pm?.model || null; } catch { /* */ }
        const out = await ctx.runTrialBundle({ groundId, intent: cap.intent, roles, localeModel, navigateUrl: null, proposedRoleCount: roles.length, targetTabId: (typeof tabId === 'number' ? tabId : null) });
        if (!out || !out.ran) { sendResponse({ success: true, reverified: false, reason: (out && out.reason) || 'trial did not run' }); return; }
        const prev = (cap.trial && cap.trial.verdict) || 'unknown';
        const verdict = (out.trial && out.trial.verdict) || 'unknown';
        const score = (out.trial && out.trial.score != null) ? out.trial.score : null;
        const vector = (out.trial && out.trial.vector) || null;
        const now = Date.now();
        // WRITE health back to the backing Fragment / Strategy (the records minted `untested`, never advanced). A
        // partial patch (StorageManager spreads existing → safe). healthStatus enum: 'ready'|'stale'|'broken'|'untested'.
        const health = { healthStatus: verdict === 'trial-pass' ? 'ready' : 'broken', lastExecutedAt: now, lastVerifiedAt: now };
        try { if (cap.fragmentId) await StorageManager.updateFragment(cap.fragmentId, health); } catch (e) { Logger.warn('background', `REVERIFY fragment ${cap.fragmentId} patch failed: ${e.message}`); }
        try { if (cap.strategyId) await StorageManager.updateStrategy(cap.strategyId, health); } catch (e) { Logger.warn('background', `REVERIFY strategy ${cap.strategyId} patch failed: ${e.message}`); }
        // Refresh the capability's own trust stamp (its trial verdict + a re-verify timestamp).
        try { await ctx.writeSgCapability(groundId, { ...cap, trial: { verdict, score, vector, trialRef: (cap.trial && cap.trial.trialRef) || null }, lastVerifiedAt: now }); } catch { /* */ }
        try { await ctx.appendOutcomes(groundId, [Outcomes.makeStageEvent('reverify', { groundId, verdict, input: { roleOrIntent: String(cap.intent || '').slice(0, 120) }, detail: { capabilityId: cap.id, previousVerdict: prev, newVerdict: verdict, score, healthStatus: health.healthStatus } })]); } catch { /* */ }
        Logger.info('background', `REVERIFY_SG_CAPABILITY — "${String(cap.intent || cap.name || '?').slice(0, 50)}" ${cap.id} → ${verdict} (score=${score}) health=${health.healthStatus} [was ${prev}]`);
        sendResponse({ success: true, reverified: true, capabilityId: cap.id, previousVerdict: prev, verdict, score, vector, healthStatus: health.healthStatus });
      } catch (err) {
        Logger.error('background', `REVERIFY_SG_CAPABILITY failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // SG-5 / PB-7 — list a ground's accepted substrate-grounded capabilities (UI library).
    GET_SG_CAPABILITIES: async (payload, _sender, sendResponse) => {
      try {
        const { groundId = null } = payload ?? {};
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        sendResponse({ success: true, capabilities: await ctx.readSgCapabilities(groundId) });
      } catch (err) {
        Logger.error('background', `GET_SG_CAPABILITIES failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // GA-7 — AUTHORING COVERAGE: which of the current page's Locale goals already have an authored capability on this
    // Ground, and which don't. The "done" signal for an unattended author (prioritize the unauthored, know when a
    // Ground is fully authored). READ-ONLY; approximate (intent↔goal token-overlap) until a canonical intent lands.
    GROUND_AUTHORING_COVERAGE: async (payload, _sender, sendResponse) => {
      try {
        const { tabId = null, groundId = null } = payload ?? {};
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        let url = '';
        if (typeof tabId === 'number') { try { const t = await chrome.tabs.get(tabId); url = t?.url || ''; } catch { /* */ } }
        let goals = [];
        try { const pm = await ctx.readLocaleCache(groundId, ctx.normalizeUrl(url)); const m = pm && pm.model; if (m && m.goals && typeof m.goals === 'object') goals = Object.values(m.goals); } catch { /* */ }
        const caps = (await ctx.readSgCapabilities(groundId)) || [];
        const coverage = authoringCoverage(goals, caps);
        Logger.info('background', `GROUND_AUTHORING_COVERAGE — ${String(groundId).slice(-6)}: ${coverage.authoredCount}/${coverage.total} goal(s) authored (${coverage.coveragePct}%)`);
        sendResponse({ success: true, coverage });
      } catch (err) {
        Logger.error('background', `GROUND_AUTHORING_COVERAGE failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // GA-6 — DETECT duplicate (structural-twin) capabilities on a Ground: caps that bind the SAME elements with the
    // same shape on the same page, differing only in intent phrasing (a reworded ask re-authored the same procedure —
    // library bloat once auto-explore templates archetypes). READ-ONLY detection, mirroring DETECT_DUPLICATE_GROUNDS;
    // the caller surfaces clusters for confirm-then-merge. Auto-merge / upsert-at-mint is a deliberate follow-up.
    DETECT_DUPLICATE_CAPABILITIES: async (payload, _sender, sendResponse) => {
      try {
        const { groundId = null } = payload ?? {};
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        const caps = (await ctx.readSgCapabilities(groundId)) || [];
        const groups = findDuplicateCapabilities(caps).map((g) => ({
          signature: g.signature,
          capabilities: g.capabilities.map((c) => ({ id: c.id, intent: c.intent || c.name || '', shape: c.shape || null })),
        }));
        const dupes = groups.reduce((n, g) => n + (g.capabilities.length - 1), 0);
        Logger.info('background', `DETECT_DUPLICATE_CAPABILITIES — ${String(groundId).slice(-6)}: ${groups.length} twin cluster(s), ${dupes} redundant cap(s)`);
        sendResponse({ success: true, groups, duplicateCount: dupes });
      } catch (err) {
        Logger.error('background', `DETECT_DUPLICATE_CAPABILITIES failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // SG-5 / PB-7 — reject the pending trial: drop the session draft + record the decision. Nothing persists.
    REJECT_SG_TRIAL: async (payload, _sender, sendResponse) => {
      try {
        const { groundId = null } = payload ?? {};
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        const draft = await ctx.readSgDraft(groundId);
        await ctx.appendOutcomes(groundId, [Outcomes.makeStageEvent('reject', {
          groundId, verdict: 'rejected', input: { roleOrIntent: String(draft?.intent || '').slice(0, 120) },
          detail: { shape: draft?.spec?.shape || null, trialVerdict: draft?.trial?.verdict || null },
        })]);
        await ctx.clearSgDraft(groundId);
        sendResponse({ success: true, rejected: true });
      } catch (err) {
        Logger.error('background', `REJECT_SG_TRIAL failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },
  };
}
