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
import { describeFanoutSpec } from '../../Core/fanoutPersonaPrompt.js';   // FS-6 (v2.74.1830) — log every declared fan-out slot, not just task/persona
import { selectionToTrialRoles } from '../../Core/bind.js';
import { lowerToTier2, orderForRun, scoreTier2, topoOrder } from '../../Core/tier2Lower.js';
import { evaluatePostcondition } from '../../Core/postcondition.js';
import { coerceRecentTurns as _recentTurnsPayload } from '../../Core/recentTurns.js';   // Q1 — coerce + bound the panel-sent recent-turn window (untrusted; fenced as data downstream)
import { CONNECTOR_RECIPES, fillEndpoint, isReadOnlyGql } from '../../Core/connectorRecipes.js';   // §18 — the curated catalog seeded into a Ground's ride-recipe collection; CX-9o — fillEndpoint derives the section-nav pages; RH-1c — the heal apply re-validates a gql recipe's document is a READ
import { absentTargetLegs } from '../../Core/unconnectedCapability.js';   // UC-1 (v2.74.1957) — the target ground has armed legs this conversation cannot see
import { seedFromCatalog as seedRideFromCatalog, setEnabled as rideSetEnabled, review as rideReview, downgradeSafety as rideDowngradeSafety, editMeta as rideEditMeta, mergeRecipes as rideMergeRecipes, acceptPendingReads as rideAcceptPendingReads, armable as rideArmable, curatedRidesForConnections, mergeRideCatalogForAnswer, catalogArmedEntries, partitionRecipesByOrigin as ridePartitionByOrigin } from '../../Core/rideRecipe.js';   // §18 — the per-Ground ride-recipe transforms (safety enforced here, not the UI); CX-9r — catalog-armed origins from open tabs; v2.74.2052 — the OWN-ORIGIN read door
import { groundVocabIndex } from '../../Core/rideVocab.js';   // CX-9q (v1462) — DOMAIN-MATCH vocab with HOST-level distinctiveness (a dup ground reinforces, never annihilates)
import { DRIVE_ARTIFACTS, seedFromCatalog as seedDriveFromCatalog, mergeArtifacts as driveMergeArtifacts, seededDriveLegs, buildDriveFragment, buildDriveStrategy } from '../../Core/driveArtifacts.js';   // HL-1 (v2.74.1454) — the BUILT-IN DRIVE catalog (heterogeneous legs: ride answers, drive shows) + hydrate-on-first-use builders
import { buildLegOverview } from '../../Core/legOverview.js';   // OV-1 (DESIGN_overview.md) — the cross-Ground leg inventory + work queue for the Overview workbench
import { buildManualRecipe, parseLegSpec } from '../../Core/manualRecipe.js';   // OV-5 — author a ride recipe BY HAND (validate + method-derived safety, lands pending)
import { recipesFromHarvest, healProposalsFromCaptures } from '../../Core/recipeFromHarvest.js';   // §17 — the crawl-as-generalizer: captures → proto ride-recipes (templated, method-classed, pending); RH-1c — fresh captures × drift-suspect records → heal proposals
import { applyHeal as rideApplyHeal, dismissHeal as rideDismissHeal } from '../../Core/routeHeal.js';   // RH-1c (v2.74.1567) — the heal apply/dismiss transitions (reads only; driftSuspect stays until the RH-1d verify)
import { applyPolish } from '../../Core/recipePolishPrompt.js';   // §17 — apply an LLM polish (name/does/param-names) onto a proto — the SAFE relabel (never touches method/safety)
import { recipesFromObservedWrites } from '../../Core/recipeFromObservedWrite.js';   // CX-8 — a demo's captured WRITE requests → proto ride write-recipes (body templated; typed values → params, never banked)
import { focusDecision, FOCUS_SETTING_KEY } from '../../Core/focusGrammar.js';   // FM-1 (v2.74.968) — the pure focus-grab verdict
import { buildAcceptance, landmarkRefActions, buildLandmarkRecords, buildPerspectiveRecord, buildResultsLandmarkRecord, buildOutcomePerspective, findMatchingPerspective, buildPerspectiveGate, buildDestinationPerspective, pickDestinationLandmark, validateConditionRefs } from '../../Core/accept.js';
import { authoringCoverage } from '../../Core/select.js';   // GA-7 — Locale→capability "done" signal
import { mergeGaps, summarizeGaps, matchInteractionToGap, recordFulfillment, setStatus, matchAskToGap } from '../../Core/gapRegistry.js';   // PS-0/1/3/4 — capability-gap registry (enumerate + harvest + promote + ask-match)
import { addObservation } from '../../Core/observedPool.js';   // PS-2 — the long-tail observed pool (catch-net for unmatched touches)
import { buildHarvestCapability } from '../../Core/synthFromGap.js';   // PS-3 — compose an UNVERIFIED capability from a harvested gap (stage/verify-on-first-use)
import * as CapabilitySynth from '../../Core/capabilitySynth.js';
import { synthesizeTrialOp } from '../../Core/trialSynth.js';
import { coalesce } from '../../Core/observedTrace.js';                 // OBS-3 — derive a capability from a demonstration
import { segmentTrace, opToPhases, deriveObservedParams, parameterizeObserved, describeTraceInput, derivePhasePostcondition, reconcileObservedLandmarks } from '../../Core/observedSegment.js';
import { listLocales } from '../../Services/Storage/GroundAssetStore.js';   // OBS (v2.74.764) — reconcile observed landmarks to grounded Locale features
import { loadGoalItems } from '../../Services/Storage/GoalMemoryStore.js';   // AL-4 — read the app's goal memory (beliefs/deltas)
import { goalContextFor } from '../../Core/goalRetrieval.js';
import { capabilityShapeKey } from '../../Core/goalMemory.js';   // v2.74.1870 — the routing shape a verdict judged, so a stale verdict retires at recall   // AL-4 — assemble the relevant standing rules + recall into a context block
import { builtinApp } from '../../Core/appCatalog.js';   // OM — the app's catalog entry (its object model)
import { connectorLegsForConnections, harvestedRecipeLegs } from '../../Core/connectorRecipes.js';   // CX-4c + §20 — connected session-ride recipes (curated + harvested header-replay) as selectable interpret tools
import { brokerLegsForLinked } from '../../Core/brokerCatalog.js';   // CX-5c — broker (OAuth/MCP) legs, gated on LINKED providers
import { legRef } from '../../Core/legRef.js';   // v1342 — unified ref for palette dedup (_seen seeding)
import { prerankLegs } from '../../Core/legPrerank.js';   // CX-9p (v1461) — deterministic pre-rank of the scope-tiered palette (winner leads; zero-overlap globals capped)
import { recordAlias, recallAlias } from '../../Core/connectorAlias.js';   // CX-9p (v1461) — the connector-leg alias store (ask-shape → leg warm path; the teach-once flywheel for connectors)
import { parseSweepReads, parseSweepProposals } from '../../Core/sweepPrompt.js';   // FL-1 (v2.74.1346) — sweep output validated against the OFFERED legs
import { federateResults, issueLines, crossSiteKinds } from '../../Core/federate.js';   // DK-4 (DESIGN_desks.md §6) — federate the sweep's reads into cross-site issues (union by corrKeys)
import { parseSeedDirectives } from '../../Core/fleetSchedule.js';   // FL-6b (v2.74.1356) — the seed's stated cadence, strict-parsed
import { composeOfferedLeg, policyFilter, fleetOfferedLegs, panelOfferedLegs, partitionDeskLegs } from '../../Core/palette.js';   // GD-4b — the app's COMPOSE (draft-on-canvas) leg joins interpret's palette; v1340 (review A) — policyFilter: the 'forbidden' floor now runs on the LIVE interpret palette, not just the dormant ilRun; FL (v1348) — the fleet console legs (NL → sweep/show via IL, never regex); v1354 — CLEAR_CHAT (conversation-management panel legs)
import { neutralizeFalseCompletion } from '../../Core/answerGuard.js';   // honesty belt — the answer path dispatches nothing, so a completion claim on a side-effect COMMAND is a fabrication (the calendar "✅ I created it" bug)
import { describeObjectModel } from '../../Core/appDef.js';   // OM — render the app's object model (noun/states/actions/transitions) as a context block
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
import { resolveTarget, renderTargetDecision } from '../../Core/targetResolve.js';   // TRT-2 — the TR-ladder target resolver (DESIGN_target_routing.md §3)
import { vocabularyFingerprint } from '../../Core/groundVocabulary.js';   // TRT-1 — derived ground vocabulary fingerprints (§4)
import { readConnRegistry } from './connections.js';   // TRT-2 — TR-5 live-session origins (CP-3 registry)
import { attentionOrigins } from '../../Core/connectionPresence.js';   // TRT-2 — exclude stale/signed-out origins from TR-5

// TRT-2 — the resolver's caps/alias context cache (fingerprints + global alias index; 60s TTL — see TARGET_RESOLVE).
let _targetCtxCache = null;
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
import { dropShadowedLegs } from '../../Core/recipeFromHarvest.js';   // v1879 — a frozen harvested instance never outranks the templated curated leg it shadows

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
  'writeSgTrace', 'enrichSgLandmarks', 'readRideRecipes', 'writeRideRecipes',
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

// §17 (DESIGN_connectors.md) — harvest TEE injection assets. The body-blind MAIN-world tee lives in its OWN classic
// script file (ContentScripts/harvestTee.js) so ONE source serves both injection paths: ARM_HARVEST_TEE injects it
// post-load via executeScript({files}); START_HARVEST_SESSION registers it at document_start via registerContentScripts
// (the only way to catch a page's INITIAL data-load fetches). _harvestSessions tracks the live registrations so STOP can
// unregister + bank. _hostMatchPattern scopes a session's injection to the Ground's own origin (host_permissions=<all_urls>).
const _HARVEST_TEE_FILE = 'ContentScripts/harvestTee.js';
const _harvestSessions = new Map();   // groundId → { tabId, host, regId, appHost, origin }
const _harvestRegId = (groundId) => `ahub-harvest-${String(groundId || '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60)}`;
// v2.74.1924 — SCRUB-BEFORE-SLICE (the chat.js twin): the ring scrub is TLD-anchored, so an ask head-sliced mid-
// email ships the fragment verbatim (live 123241: `…for dmonk@deako.` on the cloud wire). User-authored text
// scrubs FIRST — the Core/Logger.js pattern — then cuts; a post-scrub cut at worst truncates "[email]" itself.
// v1924-b (review) — phone + long-digit rules too (same truncation hazard); boundaries verbatim from Logger.
const _scrubHead = (s, n = 60) => String(s ?? '')
  .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[email]')
  .replace(/(?<![\w.@-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w])/g, '[phone]')
  .replace(/\b\d{8,}\b/g, '[id]')
  .slice(0, n);
const _hostMatchPattern = (host) => `*://${String(host || '').replace(/[^a-zA-Z0-9.\-]+/g, '')}/*`;

// The MAIN-world reader DRAIN_HARVEST_TEE + stopHarvestSession run to pull + clear a tab's captures (sessionStorage
// accumulator, superset of the current page's window buffer). Self-contained (page globals only) — serialized by executeScript.
function _drainTeeFunc() {
  var acc = []; try { var s = sessionStorage.getItem('__ahub_harvest'); if (s) acc = JSON.parse(s) || []; } catch (e) {}
  try { sessionStorage.removeItem('__ahub_harvest'); } catch (e) {}
  var cur = Array.isArray(window.__ahub_harvest_buf) ? window.__ahub_harvest_buf : [];
  window.__ahub_harvest_buf = [];
  return acc.length ? acc : cur;   // acc is a superset of cur for this origin (push writes both sinks)
}

/**
 * §17 — BANK captures into a Ground's ride-recipe collection. MODULE-LEVEL + self-contained: it takes the per-Ground
 * store accessors so ANY caller can use it (the SG message handlers pass ctx's; the Discovery CRAWL passes background's).
 * GENERALIZE → POLISH new ids (cheap, capped, best-effort) → mergeRecipes (landing `pending`; user state preserved on a
 * re-harvest). Returns { banked, total, recipes, identityPath }. Fails safe to a zero result on a missing store.
 */
export async function bankHarvested({ readRideRecipes, writeRideRecipes, groundId, captures = [], appHost = '', origin = '', doPolish = true } = {}) {
  if (typeof readRideRecipes !== 'function' || typeof writeRideRecipes !== 'function' || !groundId) return { banked: 0, total: 0, recipes: [], identityPath: null };
  const existing = await readRideRecipes(groundId);
  const ex = Array.isArray(existing) ? existing : [];
  const knownIds = new Set(ex.map((r) => r && r.id));
  const { recipes: protos, identityPath } = recipesFromHarvest(Array.isArray(captures) ? captures : [], { appHost });
  // §20 — PRESERVE the recipe's own captured host (the API origin, possibly CROSS-ORIGIN to appHost). Only fall back to
  // the passed origin/appHost when the capture had no host (a relative URL). Clobbering with appHost was the cross-origin
  // bug — a static SPA's recipe got the PAGE host, so the replay fetched + token-looked-up the wrong origin (v2.74.1291).
  let staged = protos.map((r) => ({ ...r, groundId, origin: r.origin || origin || appHost }));
  if (doPolish && staged.length) {   // only NEW ids; each failure falls back to the placeholder
    let budget = 24;
    staged = await Promise.all(staged.map(async (r) => {
      if (knownIds.has(r.id) || budget <= 0) return r;
      budget--;
      try { const p = await AnthropicService.polishRecipe({ recipe: r }); return p ? applyPolish(r, p) : r; }
      catch { return r; }
    }));
  }
  const merged = rideMergeRecipes(ex, staged);
  // RH-1c (v2.74.1567, DESIGN_route_heal.md §3.4-5) — the HEAL-MATCH pass: every bank funnel (passive forage, the
  // §19 crawl, Explore, Discovery) now also pairs the fresh captures against this Ground's DRIFT-SUSPECT records.
  // An unambiguous match stages a `healProposal` (the five-second diff) ON the record — HITL applies it via
  // EDIT_RIDE_RECIPE op:heal (chat relearn bar / Studio ride card). Best-effort: never breaks banking. The log
  // line is body-blind (field NAMES + counts; the diff itself renders panel-side only).
  let healed = 0;
  try {
    const props = healProposalsFromCaptures(Array.isArray(captures) ? captures : [], merged, { now: Date.now() });
    for (const { recipeId, proposal } of props) {
      const i = merged.findIndex((r) => r && r.id === recipeId);
      if (i < 0) continue;
      merged[i] = { ...merged[i], healProposal: proposal };
      healed++;
      Logger.info('ride', `HEAL ▸ proposed ${recipeId} ← capture ×${proposal.samples} score ${proposal.score} (${(proposal.fields || []).join(',')})`);
    }
  } catch { /* the heal pass must never break banking */ }
  await writeRideRecipes(groundId, merged);
  return { banked: staged.length, total: merged.length, recipes: merged, identityPath, healed };
}

/**
 * §17 (1b) — START a harvest session: register the body-blind tee at DOCUMENT_START (registerContentScripts, MAIN world)
 * scoped to `host` — HOST-scoped not tab-scoped, so it auto-installs on every page the crawl navigates to and catches
 * each page's INITIAL data-load fetches. CONSENT-GATED (C6 Track, default-deny). MODULE-LEVEL so the Discovery crawl can
 * arm it directly. Returns { ok, groundId, host, error? }. A prior session for the Ground is cleared first.
 */
export async function startHarvestSession({ tabId = null, groundId = '', host = '', appHost = '', origin = '', reload = false } = {}) {
  groundId = String(groundId || '').trim();
  if (!groundId) return { ok: false, error: 'groundId required' };
  if (!host && typeof tabId === 'number') { try { host = new URL((await chrome.tabs.get(tabId))?.url || '').host; } catch { /* */ } }
  if (!host) return { ok: false, error: 'no-host' };
  let consent = MONITOR_CONSENT_DEFAULT;
  try { consent = (await chrome.storage.local.get('monitor:consent'))?.['monitor:consent'] || MONITOR_CONSENT_DEFAULT; } catch { /* */ }
  if (!canTrack(consent, { host })) return { ok: false, error: 'no-consent', host };
  const regId = _harvestRegId(groundId);
  try { await chrome.scripting.unregisterContentScripts({ ids: [regId] }); } catch { /* none registered — fine */ }
  await chrome.scripting.registerContentScripts([{
    id: regId, matches: [_hostMatchPattern(host)], js: [_HARVEST_TEE_FILE],
    runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: false,
  }]);
  _harvestSessions.set(groundId, { tabId, host, regId, appHost: appHost || host, origin: origin || host });
  if (reload === true && typeof tabId === 'number') {
    try { await chrome.tabs.reload(tabId); } catch { /* */ }
  } else if (typeof tabId === 'number') {
    // document_start only fires on the NEXT navigation — but Explore pokes the page IN PLACE (no reload), so its
    // interaction-triggered reads need the tee armed on the ALREADY-loaded document right now. Idempotent (the tee
    // self-guards); best-effort. (Discovery navigates, so its seed page is also covered by the registration above.)
    try { await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN', files: [_HARVEST_TEE_FILE] }); } catch { /* */ }
  }
  return { ok: true, groundId, host };
}

/**
 * §17 (1b) — STOP a harvest session: unregister the document_start tee, DRAIN the tab's accumulator, and BANK. MODULE-
 * LEVEL (the Discovery crawl calls this in its finally). Robust to a lost in-memory session (unregisters by DERIVED id).
 * The drain needs a live tab; the dedicated-tab crawl case closes its tab, so it only banks when a durable tab is given
 * (e.g. the Ground panel's existingTabId). Returns { ok, banked, total, captures, ... }.
 */
export async function stopHarvestSession({ groundId = '', tabId = null, readRideRecipes, writeRideRecipes, appHost = '', origin = '', doPolish = true } = {}) {
  groundId = String(groundId || '').trim();
  if (!groundId) return { ok: false, error: 'groundId required', banked: 0, total: 0, captures: [] };
  const sess = _harvestSessions.get(groundId) || {};
  const regId = sess.regId || _harvestRegId(groundId);
  try { await chrome.scripting.unregisterContentScripts({ ids: [regId] }); } catch { /* already gone */ }
  _harvestSessions.delete(groundId);
  const drainTab = typeof tabId === 'number' ? tabId : sess.tabId;
  let captures = [];
  if (typeof drainTab === 'number') {
    try {
      const out = await chrome.scripting.executeScript({ target: { tabId: drainTab, frameIds: [0] }, world: 'MAIN', func: _drainTeeFunc });
      captures = Array.isArray(out?.[0]?.result) ? out[0].result : [];
    } catch (e) { /* tab gone — bank nothing */ }
  }
  if (!captures.length) return { ok: true, groundId, captures: [], banked: 0, total: 0 };
  const res = await bankHarvested({
    readRideRecipes, writeRideRecipes, groundId, captures,
    appHost: appHost || sess.appHost || sess.host || '', origin: origin || sess.origin || sess.host || '', doPolish,
  });
  return { ok: true, groundId, captures, ...res };
}

const _rideAuthArmed = new Set();   // host → persistent ride auth-capture registered this SW lifetime (dedup)
const _rideAuthRegId = (host) => `ahub_rideauth_${String(host || '').replace(/[^a-z0-9]/gi, '_')}`;

/**
 * §20 (v2.74.1293) — PERSISTENT ride auth-capture. Keep the §20 tee armed on a connected ride app's tab so the page-local
 * token global (window.__ahub_ride_auth) always tracks the app's FRESHEST Bearer — the SPA self-refreshes via its IdP
 * (Deako = Auth0 silent-auth, ref deako-cs-access.md), and we just keep grabbing the latest header. The credential-free
 * mirror of the production refresh-token loop ([[reference_cs_tools]]): instead of storing + refreshing a token, ride the
 * live tab. Fixes the stale/empty-global replay miss — a forage STOP unregistered the tee, so the token went stale and
 * cleared on reload. This uses a DEDICATED persistent registration (NOT the forage regId) so a forage stop never tears it
 * down. Consent-gated (C6 Track, same as harvest). Idempotent (host-dedup). Best-effort.
 */
export async function armRideAuthCapture({ host = '', tabId = null } = {}) {
  host = String(host || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  if (!host) return { ok: false, error: 'host required' };
  let consent = MONITOR_CONSENT_DEFAULT;
  try { consent = (await chrome.storage.local.get('monitor:consent'))?.['monitor:consent'] || MONITOR_CONSENT_DEFAULT; } catch { /* */ }
  if (!canTrack(consent, { host })) return { ok: false, error: 'no-consent', host };
  // 1) persistent document_start registration → the tee re-injects + captures the freshest token on EVERY load (survives
  //    reloads + SW restarts). Dedicated id so a forage stopHarvestSession (which unregisters _harvestRegId) can't kill it.
  if (!_rideAuthArmed.has(host)) {
    const id = _rideAuthRegId(host);
    try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch { /* none registered */ }
    try {
      await chrome.scripting.registerContentScripts([{
        id, matches: [_hostMatchPattern(host)], js: [_HARVEST_TEE_FILE],
        runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: true,
      }]);
      _rideAuthArmed.add(host);
      Logger.info('ride', `ride auth-capture armed (persistent) on ${host}`);
    } catch (e) { Logger.warn('background', `ride auth-capture register failed: ${e.message}`); }
  }
  // 2) the live tab NOW: set the capAuth flag + inject the tee in-place so the CURRENT (already-loaded) page captures the
  //    next authed request without waiting for a reload. sessionStorage is origin-shared → the MAIN-world tee reads it.
  if (typeof tabId === 'number') {
    try { await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => { try { sessionStorage.setItem('__ahub_cap_auth', '1'); } catch (e) { /* */ } } }); } catch { /* */ }
    try { await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN', files: [_HARVEST_TEE_FILE] }); } catch { /* */ }
  }
  return { ok: true, armed: true };
}

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

  // §17 — the harvest BANK bound to THIS ctx's per-Ground store; delegates to the module-level bankHarvested (the same
  // core the Discovery crawl uses). generalize → polish NEW ids → mergeRecipes, landing `pending`.
  const _bankHarvested = (args) => bankHarvested({ readRideRecipes: ctx.readRideRecipes, writeRideRecipes: ctx.writeRideRecipes, ...args });

  // v2.74.1435 (Invariant #3, the STALE-RECORD fix) — read a Ground's ride recipes MERGED with the curated catalog.
  // EVERY projection path (interpret palette, sweep, GET_RIDE_RECIPES) reads through THIS, so a catalog upgrade
  // (new fields, endpoint fixes, coaching text) reaches already-seeded Grounds the moment it ships — the v1432
  // add-missing concat left existing records frozen at seed-time shape (live: one ask rode a fresh catalog leg,
  // the next the stale stored twin → raw name in the URL → http-400). rideMergeRecipes refreshes MECHANICAL fields;
  // user state (enabled/reviewState/safetyClass/trust) + harvested records survive; curated NAME/DOES refresh too
  // (catalog-owned text — the binder reads `does`, and stale coaching mis-binds). Write-back only on real change
  // (stringify compare), so the steady state is a pure read. Merge failure never blocks the read.
  // v2.74.1446 (CX-9k) — the RIDE-ARMED Ground index: every Ground holding ≥1 armable ride recipe, with its host
  // (taken from the recipes' own stored `origin` — no Ground-shape assumptions). Armed ride capabilities are DURABLE
  // and TAB-INDEPENDENT (SESSION_REPLAY rides the app's own tab wherever it is), so the interpret palette projects
  // them from EVERY such Ground — the ACTIVE tab is context, never a capability filter (live: "on vendorsuite, pull
  // up …" from an unrelated tab found no vendorsuite legs and the model narrated page-dependence it doesn't have).
  // Cached 5 min; busted on ride-recipe edits (arm/disable/delete) so a fresh `verify` shows up immediately.
  const _rideArmedCache = { at: 0, list: [] };
  const _bustRideArmedCache = () => { _rideArmedCache.at = 0; };
  async function _rideArmedGrounds() {
    // CX-9p (v1461) — SHAPE-GUARD the cache: serve it only when it is fresh AND every entry carries the current
    // shape (`texts` array since v1463 — the vocab index is now computed at the CALL SITE, jointly with the
    // catalog-armed virtual origins). A stale shape held across a partial reload mis-routes — rebuild is cheap.
    if (Date.now() - _rideArmedCache.at < 300000
      && _rideArmedCache.list.every((e) => e && Array.isArray(e.texts))) return _rideArmedCache.list;
    const out = [];
    try {
      const grounds = await StorageManager.getAllGrounds();
      for (const g of (Array.isArray(grounds) ? grounds : [])) {
        const gid = g && (g.id || g.groundId); if (!gid) continue;
        let recs = []; try { recs = (await ctx.readRideRecipes(gid)) || []; } catch { recs = []; }
        let armedRecs = recs.filter((r) => r && rideArmable(r) && r.origin);
        if (!armedRecs.length) continue;
        // v2.74.2052 — OWN-ORIGIN rows only, anchored to the GROUND's identity (primaryHost — the
        // TARGET_RESOLVE derivation), never armedRecs[0].origin: a foreign FIRST row mislabeled the ground and
        // its foreign name/does poisoned the DOMAIN-MATCH vocab + the panel's GET_RIDE_ARMED_GROUNDS. The host
        // keeps the own rows' stored form (byte-identical on clean grounds); no primaryHost → pre-2052 shape.
        let anchor = ''; try { anchor = String(primaryHost(g) || '').toLowerCase(); } catch { anchor = ''; }
        if (anchor) {
          armedRecs = _ownRideRecords(armedRecs, anchor, gid);
          if (!armedRecs.length) continue;   // pure pollution — nothing of the ground's own to offer
        }
        // CX-9m (v2.74.1450) — each ground's DOMAIN VOCABULARY: the significant words of its armable recipes'
        // name+does ("warranty", "division", "announcements"…). An ask using a ground's distinctive vocabulary is
        // an IMPLICIT site naming ("pull up the warranty task…" without "on vendorsuite") — the DOMAIN-MATCH tier.
        out.push({ gid, host: String(armedRecs[0].origin), texts: armedRecs.map((r) => `${r.name || ''} ${r.does || ''}`) });
      }
    } catch { /* best-effort — an empty index just means no ride legs offered */ }
    // v1463 — the cache holds {gid, host, texts}: the vocab index (CX-9q host-level distinctiveness,
    // Core/rideVocab.js) is computed at the CALL SITE per ask, jointly with the catalog-armed virtual origins,
    // so a curated app visible only as an open tab still participates in DOMAIN-MATCH distinctiveness.
    _rideArmedCache.at = Date.now(); _rideArmedCache.list = out;
    return out;
  }

  async function _readRideRecipesMerged(groundId, origin) {
    let recipes = [];
    try { recipes = (await ctx.readRideRecipes(groundId)) || []; } catch { recipes = []; }
    const host = String(origin || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    if (!host) return recipes;
    try {
      const curated = seedRideFromCatalog(CONNECTOR_RECIPES, { groundId, origin: host });
      if (!curated.length) return recipes;
      const byId = new Map(curated.map((c) => [c.id, c]));
      let merged = rideMergeRecipes(recipes, curated);
      merged = merged.map((r) => (r && r.provenance === 'curated' && byId.has(r.id)) ? { ...r, name: byId.get(r.id).name, does: byId.get(r.id).does } : r);
      // CX-9p (v1461) — a curated merge added/changed recipes → bust the armed-grounds index so the newly-merged
      // vocabulary (e.g. a curated "warranty" leg) reaches the DOMAIN-MATCH tier on the next interpret, not in ≤5min.
      if (JSON.stringify(merged) !== JSON.stringify(recipes)) { await ctx.writeRideRecipes(groundId, merged); _bustRideArmedCache(); return merged; }
    } catch { /* the merge is an enhancement — never blocks a read */ }
    return recipes;
  }

  // v2.74.2052 — the OWN-ORIGIN read door (the panel's v1937 filter, chat.js _cachedHostRecipes, now mirrored
  // SW-side): curated pollution is born armable (trust 1/enabled/accepted) and merges never delete, so a foreign
  // row stored under a ground steered every raw reader — the live incident elected vendorsuite's vs_state as the
  // Shopify ground's daily canary. Contract: compare the RECORD's own `origin` against the ground's host, BOTH
  // sides bared (partitionRecipesByOrigin — scheme/www/slash stripped; apiHost NEVER enters the compare); the
  // filter lives at the READ, the store keeps the rows (diagnosable — the one throttled log line below names
  // them). NOT filtered on purpose: GET_RIDE_RECIPES (the Studio/Ground-panel MANAGEMENT door — the surface
  // where a user can still see/disable/delete foreign rows) and the id-keyed pin/arm-guard lookups (an existing
  // workflow pin bound to a foreign row would flip to 'recipe-gone' and 3-strike-disarm — a policy change, not
  // a hygiene fix; the panel's own consuming reads already filter their side).
  const _foreignLogAt = new Map();   // gid → last log ms (60s ≈ the panel's cache-fill cadence; palette loops would flood unthrottled)
  function _ownRideRecords(recipes, host, gid) {
    const h = String(host || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    if (!h) return Array.isArray(recipes) ? recipes : [];   // no anchor, no verdict
    const part = ridePartitionByOrigin(recipes, h);
    if (part.foreign.length) {
      const last = _foreignLogAt.get(gid || h) || 0;
      if (Date.now() - last > 60000) {
        _foreignLogAt.set(gid || h, Date.now());
        try { Logger.info('ride', `RIDE_RESOLVE ▸ ${part.foreign.length} foreign recipe(s) stored under ${h} (${part.foreignOrigins.slice(0, 3).join(', ')}) — filtered from every reader`); } catch { /* */ }
      }
    }
    return part.own;
  }
  // The merged read + the own-origin door in one call — what every PROJECTION/vocabulary reader consumes
  // (palette, sweep offer, unconnected detection, answer, target-resolve). The write-back inside
  // _readRideRecipesMerged stays FULL — filter-at-read must never become delete-at-write.
  // v2.74.2053 — the ANCHOR is the ground's OWN identity (primaryHost), never the caller's origin (review
  // defect, confirmed): gid resolution is urlPatterns-AWARE, so the caller's origin may be a merged SIBLING
  // host (an app.notion.com URL on the www.notion.so ground) — anchoring on it partitioned every own row
  // foreign, emptied the reader, and logged false pollution. The caller's origin is only the fallback when the
  // ground yields no primaryHost.
  async function _readRideRecipesOwn(groundId, origin) {
    let anchor = '';
    try { anchor = String(primaryHost(await StorageManager.getGround(groundId)) || ''); } catch { anchor = ''; }
    return _ownRideRecords(await _readRideRecipesMerged(groundId, origin), anchor || origin, groundId);
  }

  // HL-1 (v2.74.1454) — the drive twin of _readRideRecipesMerged: read the Ground's drive-artifact collection,
  // seeding/refreshing it from DRIVE_ARTIFACTS (matched by origin). Same merge semantics as ride (mechanical
  // fields refresh, user state preserved) PLUS the hydration stamps survive a re-seed — an already-hydrated
  // artifact's capabilityId/fragmentId/strategyId must never be dropped by a catalog refresh (Invariant #3's
  // drive analogue: only the seeded path exercises this, so a drop is silent until a live re-invoke).
  async function _readDriveArtifactsMerged(groundId, origin) {
    let artifacts = [];
    try { artifacts = (await ctx.readDriveArtifacts(groundId)) || []; } catch { artifacts = []; }
    const host = String(origin || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    if (!host) return artifacts;
    try {
      const curated = seedDriveFromCatalog(DRIVE_ARTIFACTS, { groundId, origin: host });
      if (!curated.length) return artifacts;
      const byId = new Map(curated.map((c) => [c.id, c]));
      let merged = driveMergeArtifacts(artifacts, curated);
      merged = merged.map((r) => (r && r.provenance === 'curated' && byId.has(r.id)) ? { ...r, name: byId.get(r.id).name, does: byId.get(r.id).does } : r);
      if (JSON.stringify(merged) !== JSON.stringify(artifacts)) { await ctx.writeDriveArtifacts(groundId, merged); return merged; }
    } catch { /* the merge is an enhancement — never blocks a read */ }
    return artifacts;
  }

  // HL-2 — HYDRATE a drive artifact into the library entities (Fragment(s) + Strategy + sgCapability), marked
  // trial.verdict:'observed' (selector-guessed, behaviour-UNVERIFIED — the PS-3 doctrine: the first real run IS
  // the verification). Steps carry INLINE SG-LM-3 landmarks when authored; selector-only steps rely on the HAR
  // id alone (a wrong proto makes recovery worse — v1455). Idempotent when hydratedCatalogVersion matches
  // catalogVersion; a catalogVersion bump invalidates stale hydration (merge drops the stamps) and re-compose runs.
  async function _hydrateDriveArtifact(groundId, list, rec, localeUrl) {
    if (rec.capabilityId && Number(rec.hydratedCatalogVersion || 0) === Number(rec.catalogVersion || 0)) {
      return { list, rec, capabilityId: rec.capabilityId, hydrated: false };
    }
    const now = Date.now(); const newId = () => crypto.randomUUID();
    const stamp = (l, id, patch) => l.map((r) => (r && r.id === id) ? { ...r, ...patch } : r);
    const verStamp = { hydratedAt: now, hydratedCatalogVersion: Number(rec.catalogVersion || 0) };
    if (rec.tier === 2 && Array.isArray(rec.compose)) {
      const composed = [];
      for (const cid of rec.compose) {
        let sub = list.find((r) => r && r.id === cid);
        if (!sub) return null;
        if (!sub.fragmentId || Number(sub.hydratedCatalogVersion || 0) !== Number(sub.catalogVersion || 0)) {
          const h = await _hydrateDriveArtifact(groundId, list, sub, localeUrl);
          if (!h) return null;
          list = h.list; sub = h.rec;
        }
        let frag = null; try { frag = await StorageManager.getFragment(sub.fragmentId); } catch { frag = null; }
        composed.push({ fragmentId: sub.fragmentId, params: (frag && Array.isArray(frag.params)) ? frag.params : [] });
      }
      const built = buildDriveStrategy(rec, composed, { groundId, localeUrl, now, newId });
      if (!built) return null;
      await StorageManager.saveStrategy(built.strategy);
      await ctx.writeSgCapability(groundId, built.capability);
      list = stamp(list, rec.id, { strategyId: built.strategy.id, capabilityId: built.capability.id, ...verStamp });
      await ctx.writeDriveArtifacts(groundId, list);
      Logger.info('drive', `DRIVE_HYDRATE ▸ ${rec.id} (tier 2) → strategy ${built.strategy.id} + capability ${built.capability.id} (observed, ${composed.length} fragment(s)) @ ${groundId}`);
      return { list, rec: list.find((r) => r && r.id === rec.id), capabilityId: built.capability.id, hydrated: true };
    }
    const built = buildDriveFragment(rec, { groundId, localeUrl, now, newId });
    if (!built) return null;
    await StorageManager.saveFragment(built.fragment);
    await ctx.writeSgCapability(groundId, built.capability);
    list = stamp(list, rec.id, { fragmentId: built.fragment.id, capabilityId: built.capability.id, ...verStamp });
    await ctx.writeDriveArtifacts(groundId, list);
    Logger.info('drive', `DRIVE_HYDRATE ▸ ${rec.id} (tier 1) → fragment ${built.fragment.id} + capability ${built.capability.id} (observed) @ ${groundId}`);
    return { list, rec: list.find((r) => r && r.id === rec.id), capabilityId: built.capability.id, hydrated: true };
  }

  // HL-2b (v2.74.1455) — wait for the SPA section to render after SHOW_SOURCES navigates to /#warranty.
  // chrome.tabs 'complete' fires at document load, NOT after the hash route paints — the v1455 live miss ran
  // F1 against `[url=/]` with no #divisionMenu. Poll until the HAR-verified header control is probe-visible.
  async function _settleDriveSection(tabId, sectionPath) {
    if (typeof tabId !== 'number') return { ok: false, reason: 'no-tab' };
    try { await ctx.ensureContentScript(tabId); } catch { /* */ }
    const want = String(sectionPath || '').replace(/^[^#]*#?\/?/, '').toLowerCase();
    // v2.74.1798 — PRESENCE PRE-CHECK. Five diagnostic passes could not separate "signed out" from "wrong page
    // state" because this wait just timed out silently either way (live: 22s of trace silence, twice). The
    // registry ALREADY knows — it is the same signal the Admin desk renders — so ask it BEFORE burning 12s on a
    // page that cannot render. Advisory only: a registry read that throws never blocks the walk.
    let _host0 = '';
    try { _host0 = new URL((await chrome.tabs.get(tabId))?.url || '').host.toLowerCase(); } catch { _host0 = ''; }
    if (_host0) {
      try {
        const _reg = (await readConnRegistry()) || {};
        if (attentionOrigins(_reg, [_host0]).some((a) => a && a.origin === _host0)) {
          Logger.info('drive', `DRIVE ▸ section-wait SKIPPED — ${_host0} presence says signed-out (pre-check; saved the 12s timeout)`);
          return { ok: false, precondition: true, signedOut: true, reason: `you appear to be signed out of ${_host0} — sign in and I’ll retry` };
        }
      } catch { /* presence is advisory — never block a walk on a registry read */ }
    }
    const deadline = Date.now() + 12000;
    const _probe = async (selector) => {
      try {
        const p = await chrome.tabs.sendMessage(tabId, { type: 'WAIT_FOR_PROBE', payload: { selector } });
        return !!(p && p.matched);
      } catch { return false; }
    };
    let _seen = { url: '', menu: false, tabs: false };
    while (Date.now() < deadline) {
      let url = '';
      try { url = (await chrome.tabs.get(tabId))?.url || ''; } catch { break; }
      const urlLc = url.toLowerCase();
      const hashOk = !want || urlLc.includes(`#${want}`) || urlLc.includes(`#/${want}`);
      const menu = await _probe('#divisionMenu');
      const tabs = await _probe('.nav-tabs, [role="tablist"]');
      // v2.74.1800 — PAINTED: does the SPA have ANY rendered content? Selector-free, so it cannot go stale.
      const painted = (menu || tabs) ? true : await _probe('body > *');
      _seen = { url, menu, tabs, painted };   // v2.74.1798 — remembered for the timeout line below
      // FAST PATH (unchanged): the catalog's known controls are present — the strictest, happiest signal.
      if (menu && (hashOk || tabs)) return { ok: true };
      // v2.74.1800 — ROUTE + PAINTED. The old gate demanded `#divisionMenu`, an UNVERIFIED catalog guess, with no
      // recovery — while the doctrine this artifact ships under expects wrong guesses and repairs them during
      // HYDRATION (selector-first, then proto-identity). The gate therefore blocked the only step that could fix
      // it: live 212347 proved the page was authenticated, correctly routed at /#warranty, content-script alive
      // (8/8 landmarks found on that very tab) — and still timed out, because that one selector isn't there. A
      // readiness gate must never be STRICTER than the recovery behind it. It is also REDUNDANT: the walk's own
      // first step is `WAIT_FOR #divisionMenu` (15s), so any real absence is caught there — as a NAMED step
      // failure the user can act on, instead of an opaque pre-gate timeout.
      if (hashOk && painted) return { ok: true, viaRoute: true };
      await new Promise((r) => setTimeout(r, 350));
    }
    // v2.74.1796 — PRECONDITION, not a capability verdict. This wait failing means the PAGE never became ready
    // (signed out, wrong route, slow SPA) — it says nothing about whether the walk's steps work, and the walk
    // never ran a single step. Live (trace 203241): the artifact's FIRST-EVER invoke hit this while the site was
    // signed out, and the resulting act-fail memory then steered every retry to clarify — so it could never earn
    // the positive belief that would retire the lesson. The flag lets the caller skip banking a verdict.
    // v2.74.1798 — SAY WHY. This wait was the only step in the whole drive flow that failed SILENTLY: 22 seconds
    // of nothing between two unrelated trace lines, which is exactly why "signed out" vs "wrong page state"
    // survived five diagnostic passes. The last-seen state makes the next failure readable from a download.
    try { Logger.info('drive', `DRIVE ▸ section-wait TIMEOUT (12s) — want=#${want || '(any)'} url=${String(_seen.url || '?').slice(0, 70)} divisionMenu=${_seen.menu} statusTabs=${_seen.tabs} painted=${_seen.painted}`); } catch { /* */ }
    return { ok: false, precondition: true, reason: 'the page section never became ready — if you are signed out of this site, sign in and I will retry' };
  }

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
        const seed = String(payload?.seed ?? '').trim();   // CV-2b — conversation seed → router context (a seeded ask skips the warm cache)
        // R-6 (v2.74.958) — warm-path cache check (see _routeCache above).
        const cacheKey = _routeCacheKey(ask, groundId, tabUrl ? ctx.normalizeUrl(tabUrl) : '');
        const hit = seed ? null : _routeCache.get(cacheKey);   // CV-2b — a seeded ask is conversation-specific; never serve/pollute the cross-conversation cache
        if (hit && (Date.now() - hit.at) < ROUTE_CACHE_TTL_MS) {
          Logger.info('route', `ROUTE_ASK "${_scrubHead(ask, 60)}" -> ${hit.decision.action} (CACHE HIT, age ${Math.round((Date.now() - hit.at) / 1000)}s)`);
          sendResponse({ success: true, decision: hit.decision, groundId: groundId || null, candidateCount: hit.candidateCount, cached: true });
          return;
        }
        let caps = [];
        if (groundId) { try { caps = ((await ctx.readSgCapabilities(groundId)) || []).filter((c) => c && isActiveCapability(c) && c.kind !== 'composite'); } catch { caps = []; } }
        const candidates = retrieveTools(ask, { capabilities: caps });
        const decision = await route(ask, {
          retrieveTools: async () => candidates,                                       // R-2 candidates (precomputed)
          callRouter:    async ({ ask: a, tools }) => AnthropicService.routeAsk({ ask: a, tools, seed }),   // R-3 LLM (CV-2b — seed → router context)
        });
        // R-6 (v2.74.958) — store only confident, actionable decisions (never the miss class).
        if (!seed && !decision.lowConfidence && (decision.action === 'primitive' || decision.action === 'replay' || decision.action === 'decompose')) {
          _routeCache.set(cacheKey, { decision, candidateCount: candidates.length, at: Date.now() });
          if (_routeCache.size > ROUTE_CACHE_MAX) { _routeCache.delete(_routeCache.keys().next().value); }
        }
        const t = decision.tool;
        Logger.info('route', `ROUTE_ASK "${_scrubHead(ask, 60)}" → ${decision.action}${t ? ` ${t.op || t.capabilityId || ''}` : ''} (conf ${decision.confidence}, ${candidates.length} cand, ground ${groundId || '—'})`);
        sendResponse({ success: true, decision, groundId: groundId || null, candidateCount: candidates.length });
      } catch (err) {
        Logger.error('background', `ROUTE_ASK failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // WF-3 (v2.74.1260) — the LLM fallback for workflow RECALL: chat.js sends the new ask + the compact candidate set
    // (already loaded + suppression-filtered + near-miss-gated client-side); we return the model's {id, confidence}.
    // The caller VALIDATES the id (resolveWorkflowMatch) + shows a CONFIRM. Thin: no ground/tab — just goal+candidates.
    MATCH_WORKFLOW: async (payload, _sender, sendResponse) => {
      try {
        const goal = String(payload?.goal ?? '').trim();
        const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
        if (!goal || !candidates.length) { sendResponse({ success: true, match: { id: null, confidence: 0 } }); return; }
        const match = await AnthropicService.matchWorkflowSemantic({ goal, candidates });
        Logger.info('workflow', `MATCH_WORKFLOW "${_scrubHead(goal, 50)}" (${candidates.length} cand) → ${match.id || 'none'}${match.id ? ` (conf ${match.confidence})` : ''}`);
        sendResponse({ success: true, match });
      } catch (err) {
        Logger.error('background', `MATCH_WORKFLOW failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // §10.2 (v2.74.1261) — distill-up's LLM ABSTRACTION pass: chat.js sends ONE instance rule + the preset type; we
    // return the generalized {trigger, body} (specifics STRIPPED — the privacy boundary) or null (the model declined).
    // The user CONFIRMS before it rises (HITL), so this only PROPOSES; nothing is written here.
    ABSTRACT_RULE: async (payload, _sender, sendResponse) => {
      try {
        const body = String(payload?.body ?? '').trim();
        if (!body) { sendResponse({ success: true, rule: null }); return; }
        const rule = await AnthropicService.abstractRuleForPreset({ trigger: payload?.trigger || null, body, presetType: payload?.presetType || '' });
        Logger.info('preset', `ABSTRACT_RULE "${body.slice(0, 48)}" → ${rule ? 'generalized' : 'declined'}`);
        sendResponse({ success: true, rule });
      } catch (err) {
        Logger.error('background', `ABSTRACT_RULE failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // Q2 (v2.74.1263) — split a fan-out ask into {task, persona}: chat.js sends the fan-out clause (behind its
    // personaHint gate); we return the per-item task + the per-child persona (a voice/role each worker adopts). The
    // caller composes the persona into each child's seed. Thin: just the clause → the LLM extractor.
    FANOUT_SPEC: async (payload, _sender, sendResponse) => {
      try {
        const clause = String(payload?.clause ?? '').trim();
        if (!clause) { sendResponse({ success: true, spec: { task: '', persona: null } }); return; }
        const spec = await AnthropicService.extractFanoutSpec({ clause });
        Logger.info('fanout', `FANOUT_SPEC "${_scrubHead(clause, 50)}" → ${describeFanoutSpec(spec) || 'no slots declared'}`);   // FS-6 — all eight slots, not just task/persona
        sendResponse({ success: true, spec });
      } catch (err) {
        Logger.error('background', `FANOUT_SPEC failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ANSWER-SHAPE (v2.74.1267) — the interrogator's final stage: chat.js sends the user's question + the deterministic,
    // MINIMIZED facts (count + a {id,title,status} sample — no record bodies); we return {answer, showRecords}. The
    // model shapes + phrases; the count is code's. v1948 ADDITIVE: the answer is primary, showRecords ALSO lists the
    // records beneath it. A miss → {answer:null, showRecords:false} → chat.js renders the list as before.
    SHAPE_ANSWER: async (payload, _sender, sendResponse) => {
      try {
        const ask = String(payload?.ask ?? '').trim();
        const facts = (payload && typeof payload.facts === 'object') ? payload.facts : null;
        const scope = String(payload?.scope ?? '').trim();   // CX-9d (v1437) — the params CODE already applied (resolved labels)
        if (!ask || !facts) { sendResponse({ success: true, answer: null, showRecords: false }); return; }
        const shaped = await AnthropicService.shapeAnswer({ ask, facts, scope });
        sendResponse({ success: true, answer: shaped.answer, showRecords: shaped.showRecords });
      } catch (err) {
        Logger.error('background', `SHAPE_ANSWER failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // DK-8h (v2.74.1500) — CASE_BRIEF: a spawned case's opening message in the REQUESTOR's voice (its record
    // dossier → 3-6 sentences of plain prose), replacing the raw field-dump card. Best-effort: null → the panel
    // keeps the raw card. The dossier already rides the case's seed to the LLM — no new egress channel.
    CASE_BRIEF: async (payload, _sender, sendResponse) => {
      try {
        const role = String(payload?.role ?? '').slice(0, 400);
        const label = String(payload?.label ?? '').slice(0, 120);
        const dossier = String(payload?.dossier ?? '').slice(0, 1600);
        if (!dossier.trim()) { sendResponse({ success: true, brief: null }); return; }
        const brief = await AnthropicService.briefCase({ role, label, dossier });
        sendResponse({ success: true, brief });
      } catch (err) {
        Logger.error('background', `CASE_BRIEF failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // AS-5c (v2.74.1409) — SUGGEST_SETUP_EXAMPLE: a dynamic compound EXAMPLE instruction for a just-set-up app,
    // grounded in the sites the user picked (shown as a starter, NEVER executed). Best-effort; null → the panel keeps
    // its static example. Inputs are the app's own config (seed) + the picked site labels — no page/PII data.
    SUGGEST_SETUP_EXAMPLE: async (payload, _sender, sendResponse) => {
      try {
        const appName = String(payload?.appName || '').slice(0, 100);
        const role = String(payload?.role || '').slice(0, 500);
        const sites = Array.isArray(payload?.sites) ? payload.sites.map((s) => String(s || '')).filter(Boolean).slice(0, 8) : [];
        if (!sites.length) { sendResponse({ success: true, example: null }); return; }
        const example = await AnthropicService.suggestSetupExample({ appName, role, sites });
        sendResponse({ success: true, example: example || null });
      } catch (err) {
        Logger.error('background', `SUGGEST_SETUP_EXAMPLE failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // §18 — the per-Ground RIDE-RECIPE collection. GET reads the stored list, SEEDING it from CONNECTOR_RECIPES (matched
    // to the Ground's origin) on first access so a Ground always shows its curated reads; harvested recipes (§17) accrete
    // here later. Returns the full collection (the Studio + Ground-panel surfaces render it via groundToolSurface).
    // CX-9n (v2.74.1452) — the ride-armed Ground index, panel-readable: every Ground holding ≥1 armable ride recipe
    // (gid + host; the cached 5-min index the interpret cascade uses). The section-opener (`view warranty task`)
    // consults it so a section on ANY ride site resolves from ANY tab — `_showSection` scanning only connections ∪
    // the active tab was the FOURTH layer of the tab-precedence assumption (palette v1446 · branch v1447 · outer
    // gate v1449 · section-opener v1452).
    GET_RIDE_ARMED_GROUNDS: async (_payload, _sender, sendResponse) => {
      try {
        const grounds = (await _rideArmedGrounds()).map(({ gid, host }) => ({ gid, host }));
        sendResponse({ success: true, grounds });
      } catch (err) {
        sendResponse({ success: false, error: err.message, grounds: [] });
      }
    },

    // CX-9p (v2.74.1461) — RECORD_CONNECTOR_ALIAS: the panel dispatch (chat.js _ilRunBuiltin) reports a SUCCESSFUL
    // connector invoke here; persist the ask-shape → leg association (Core/connectorAlias, bounded LRU, LOCAL-only)
    // so a future matching ask recalls this leg as a warm path (stamped scope 'alias' at the next projection). The
    // teach-once flywheel extended to connector legs — the durable answer to "does the router LEARN the shape → site?"
    RECORD_CONNECTOR_ALIAS: async (payload, _sender, sendResponse) => {
      try {
        const ask = String(payload?.ask ?? '').trim();
        const ref = String(payload?.legRef ?? '').trim();
        const host = String(payload?.host ?? '').trim();
        if (!ask || !ref) { sendResponse({ success: false, error: 'ask + legRef required' }); return; }
        const prev = (await chrome.storage.local.get('connector:aliases'))['connector:aliases'];
        const next = recordAlias(Array.isArray(prev) ? prev : [], { ask, legRef: ref, host, at: Date.now() });
        await chrome.storage.local.set({ 'connector:aliases': next });
        sendResponse({ success: true, count: next.length });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    },

    GET_RIDE_RECIPES: async (payload, _sender, sendResponse) => {
      try {
        const groundId = String(payload?.groundId ?? '').trim();
        const origin = String(payload?.origin ?? '').trim();
        if (!groundId) { sendResponse({ success: true, recipes: [] }); return; }
        // v2.74.1432 seed-into-forged → v2.74.1435 FULL merge-on-read: _readRideRecipesMerged (defined above) refreshes
        // existing records' mechanical fields from the catalog (the stale-record fix), preserves user state + harvested
        // records, and re-adds a hard-deleted curated id (disable/reject a curated leg you don't want — don't delete it).
        // v2.74.2052 — deliberately NOT own-origin-filtered: this is the MANAGEMENT door (Studio + Ground panel +
        // ground-view render the full collection with enable/reject/delete controls), so foreign rows must stay
        // visible here for the user to act on; the panel's CONSUMING read (chat.js _cachedHostRecipes) filters
        // its own side, and every SW projection reads through _readRideRecipesOwn instead.
        const recipes = await _readRideRecipesMerged(groundId, origin);
        sendResponse({ success: true, recipes });
      } catch (err) {
        Logger.error('background', `GET_RIDE_RECIPES failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // §18 — apply ONE guarded edit to a recipe. The safety transforms live in Core/rideRecipe.js and are enforced HERE
    // (not in the UI): op ∈ enable | meta | review | downgrade | delete. `downgradeSafety` TIGHTENS only (never promotes
    // a write to auto); `review` is accept/reject. Read-modify-write of the per-Ground list (user-driven → sequential).
    EDIT_RIDE_RECIPE: async (payload, _sender, sendResponse) => {
      try {
        const groundId = String(payload?.groundId ?? '').trim();
        const id = String(payload?.id ?? '').trim();
        const op = String(payload?.op ?? '').trim();
        if (!groundId || !id || !op) { sendResponse({ success: false, error: 'groundId, id, op required' }); return; }
        const list = await ctx.readRideRecipes(groundId);
        const idx = list.findIndex((r) => r && r.id === id);
        if (idx < 0) { sendResponse({ success: false, error: 'recipe not found' }); return; }
        let next;
        if (op === 'delete') {
          next = list.filter((r) => r.id !== id);
        } else {
          const r = list[idx];
          // RH-1c (v2.74.1567) — op:heal APPLIES the staged healProposal (reads only — a GET, or a gql record whose
          // OWN document re-validates as read-only right here; a write returns not-healable → full §18 re-review).
          // driftSuspect stays set: the next invoke is the RH-1d trial (tickOk clears on success). op:healDismiss
          // drops the proposal, nothing else.
          if (op === 'heal' || op === 'healDismiss') {
            const done = op === 'heal'
              ? rideApplyHeal(r, Date.now(), { gqlReadOk: !!(r.gql === true && r.body && isReadOnlyGql(String((r.body && r.body.query) || ''))) })
              : (() => { const d = rideDismissHeal(r); return d ? { record: d, fields: [] } : null; })();
            if (!done) { sendResponse({ success: false, error: op === 'heal' ? 'not-healable (no proposal, or a write — a changed write shape needs full re-review)' : 'no proposal to dismiss' }); return; }
            Logger.info('ride', op === 'heal'
              ? `HEAL ▸ applied ${id.slice(0, 40)} (${done.fields.join(',')}) — the next run verifies (ground ${groundId})`
              : `HEAL ▸ dismissed ${id.slice(0, 40)} (ground ${groundId})`);
            next = list.slice(); next[idx] = done.record;
          } else {
          const edited = op === 'enable'    ? rideSetEnabled(r, !!payload.value)
                       : op === 'meta'      ? rideEditMeta(r, (payload.value && typeof payload.value === 'object') ? payload.value : {})
                       : op === 'review'    ? rideReview(r, String(payload.value || ''))
                       : op === 'downgrade' ? rideDowngradeSafety(r, String(payload.value || ''))
                       : r;
          next = list.slice(); next[idx] = edited;
          }
        }
        await ctx.writeRideRecipes(groundId, next);
        _bustRideArmedCache();   // v1446 — arming state changed → the capability-global index refreshes next interpret
        Logger.info('ride', `EDIT_RIDE_RECIPE ${op} ${id.slice(0, 40)} (ground ${groundId})`);
        sendResponse({ success: true, recipes: next });
      } catch (err) {
        Logger.error('background', `EDIT_RIDE_RECIPE failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // §18 — BULK-accept all PENDING READ recipes (safetyClass 'auto' = GET) for a Ground in one click — the "30 harvested
    // GETs, one accept" path. Writes/destructive are NEVER bulk-accepted (the pure rideAcceptPendingReads filters them
    // out — they stay per-recipe HITL, §9). scope is 'reads' for now (the only safe bulk class).
    BULK_REVIEW_RIDE_RECIPES: async (payload, _sender, sendResponse) => {
      try {
        const groundId = String(payload?.groundId ?? '').trim();
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        const scope = String(payload?.scope ?? 'reads');
        if (scope !== 'reads') { sendResponse({ success: false, error: `unsupported scope: ${scope}` }); return; }
        const list = await ctx.readRideRecipes(groundId);
        const { recipes: next, accepted } = rideAcceptPendingReads(list);
        if (accepted) { await ctx.writeRideRecipes(groundId, next); _bustRideArmedCache(); }   // v1446 — newly armed reads join the global index now
        Logger.info('ride', `BULK_REVIEW_RIDE_RECIPES reads: accepted ${accepted} (ground ${groundId})`);
        sendResponse({ success: true, accepted, recipes: next });
      } catch (err) {
        Logger.error('background', `BULK_REVIEW_RIDE_RECIPES failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // HL-1 (v2.74.1454) — the per-Ground DRIVE-ARTIFACT collection (the built-in drive twin of GET_RIDE_RECIPES).
    // Merged read: seeds from DRIVE_ARTIFACTS by origin on first access, refreshes mechanical fields on catalog
    // upgrades, preserves user state + hydration stamps.
    GET_DRIVE_ARTIFACTS: async (payload, _sender, sendResponse) => {
      try {
        const groundId = String(payload?.groundId ?? '').trim();
        const origin = String(payload?.origin ?? '').trim();
        if (!groundId) { sendResponse({ success: true, artifacts: [] }); return; }
        sendResponse({ success: true, artifacts: await _readDriveArtifactsMerged(groundId, origin) });
      } catch (err) {
        Logger.error('background', `GET_DRIVE_ARTIFACTS failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // HL-2/HL-3 (v2.74.1454) — INVOKE a built-in drive artifact on the live page. First use HYDRATES (compose +
    // persist the library entities, verdict 'observed') — then EVERY use executes through the same landmark-backed
    // ExecutionEngine path a taught capability replays through, and a clean FIRST run PROMOTES the capability to
    // trial-pass + healthStatus 'ready' (the visible verify-on-first-use gate; a failed first run stays 'observed'
    // and reports honestly). The §18-style arm guard applies; the driven span is busy-marked (Invariant #2). The
    // caller (chat.js) navigates the tab to the artifact's sectionPath BEFORE invoking (nav-THEN-drive, v1453).
    INVOKE_DRIVE_ARTIFACT: async (payload, _sender, sendResponse) => {
      const _busyTab = (typeof payload?.tabId === 'number') ? payload.tabId : null;
      if (_busyTab != null) markEngineBusy(_busyTab, true);
      try {
        const groundId = String(payload?.groundId ?? '').trim();
        const driveId = String(payload?.driveId ?? '').trim();
        const tabId = (typeof payload?.tabId === 'number') ? payload.tabId : null;
        if (!groundId || !driveId) { sendResponse({ success: false, error: 'groundId + driveId required' }); return; }
        const origin = String(payload?.origin ?? '').trim();
        let list = await _readDriveArtifactsMerged(groundId, origin);
        const rec = list.find((r) => r && r.id === driveId);
        if (!rec) { sendResponse({ success: false, error: 'drive artifact not found' }); return; }
        if (!rideArmable(rec)) { sendResponse({ success: false, error: 'artifact-not-armable', hint: rec.reviewState === 'pending' ? 'accept this artifact first' : 'this artifact is disabled' }); return; }
        let liveUrl = '';
        if (tabId != null) { try { liveUrl = (await chrome.tabs.get(tabId))?.url || ''; } catch { /* */ } }
        const settle = await _settleDriveSection(tabId, rec.sectionPath || '/#warranty');
        if (!settle.ok) {
          // v2.74.1802 — FORWARD the precondition markers. They were being DROPPED here: `_settleDriveSection`
          // returns {precondition, signedOut}, but this response carried only {ok, reason}, so chat.js's
          // `d.precondition` was always undefined — which silently made v1790's no-bank sentinel and v1796's
          // self-heal INERT, and an act-fail verdict was banked on every section-wait timeout after all (live
          // 213605: still clarifying, LEARNED naming this very tool). Both halves were individually correct;
          // the value simply did not survive the hop — the same class as Invariant #3's three-hop threading.
          sendResponse({ success: true, ran: false, ok: false, reason: settle.reason || 'section-not-ready', precondition: !!settle.precondition, signedOut: !!settle.signedOut });
          return;
        }
        const h = await _hydrateDriveArtifact(groundId, list, rec, ctx.normalizeUrl(liveUrl));
        if (!h) { sendResponse({ success: false, error: 'could not compose the drive artifact' }); return; }
        list = h.list; const stamped = h.rec;
        // Bind ONLY the declared params ({{NAME}} slots); an unbound label-click SKIPS (the v2.74.877 contract).
        const strategyParamValues = {};
        for (const p of (Array.isArray(stamped.params) ? stamped.params : [])) {
          if (p && p.name) strategyParamValues[p.name] = '';
        }
        const supplied = (payload?.params && typeof payload.params === 'object') ? payload.params : {};
        for (const [k, v] of Object.entries(supplied)) if (strategyParamValues[k] !== undefined) strategyParamValues[k] = String(v ?? '');
        if (tabId != null) { try { await ctx.ensureContentScript(tabId); } catch { /* */ } }
        let result = null;
        if (stamped.strategyId) {
          try { result = await ExecutionEngine.executeStrategy({ strategyId: stamped.strategyId, strategyParamValues, targetTabId: tabId }); }
          catch (e) { sendResponse({ success: false, error: `drive run failed: ${e.message}` }); return; }
        } else if (stamped.fragmentId) {
          let frag = null; try { frag = await StorageManager.getFragment(stamped.fragmentId); } catch { /* */ }
          if (!frag) { sendResponse({ success: false, error: 'hydrated fragment missing' }); return; }
          const synthetic = CapabilitySynth.wrapFragmentAsStrategy(frag, { strategyId: `fragment:${frag.id}`, now: Date.now() });
          try { result = await ExecutionEngine.executeStrategy({ strategyId: synthetic.id, strategy: synthetic, strategyParamValues, targetTabId: tabId }); }
          catch (e) { sendResponse({ success: false, error: `drive run failed: ${e.message}` }); return; }
        } else { sendResponse({ success: false, error: 'artifact hydrated without a runnable entity' }); return; }
        const ok = !!(result && result.success);
        // v2.74.1556 — SELF-STAMP the recorded start on LEGACY capabilities (accepted before startUrl existed):
        // a successful run proves the pre-run page was a working start — bank it (raw, hash intact) so the next
        // replay can start-establish instead of depending on where the tab happens to sit.
        if (ok && !cap.startUrl && liveUrl && (!cap.localeUrl || _orig(liveUrl) === _orig(cap.localeUrl))) {
          try { await ctx.writeSgCapability(groundId, { ...cap, startUrl: liveUrl }); Logger.info('background', `REPLAY_SG_CAPABILITY — startUrl self-stamped (${_pageHash(liveUrl) || '/'})`); } catch { /* best-effort */ }
        }
        // Verify-on-first-use promotion: a clean run upgrades 'observed' → 'trial-pass' (the run IS the trial —
        // the same doctrine as PS-3's staged caps) + healthStatus 'ready' on the backing records. A failure
        // leaves the verdict honest; nothing is silently promoted.
        let promoted = false;
        if (ok) {
          try {
            const cap = (await ctx.readSgCapabilities(groundId)).find((c) => c && c.id === stamped.capabilityId);
            if (cap && cap.trial && cap.trial.verdict === 'observed') {
              const now = Date.now();
              await ctx.writeSgCapability(groundId, { ...cap, trial: { ...cap.trial, verdict: 'trial-pass' }, lastVerifiedAt: now });
              const health = { healthStatus: 'ready', lastExecutedAt: now, lastVerifiedAt: now };
              try { if (stamped.fragmentId) await StorageManager.updateFragment(stamped.fragmentId, health); } catch { /* */ }
              try { if (stamped.strategyId) await StorageManager.updateStrategy(stamped.strategyId, health); } catch { /* */ }
              promoted = true;
            }
          } catch (e) { Logger.warn('background', `drive first-use promotion failed (non-fatal): ${e.message}`); }
        }
        const pv = Object.entries(strategyParamValues).filter(([, v]) => v !== '').map(([k, v]) => `${k}="${String(v).slice(0, 30)}"`);
        Logger.info('drive', `DRIVE_INVOKE ▸ ${driveId} (tier ${stamped.tier || 1}) → ${ok ? 'ok' : 'failed'}${h.hydrated ? ' [hydrated]' : ''}${promoted ? ' [promoted trial-pass]' : ''}${pv.length ? ` params: ${pv.join(', ')}` : ''} @ ${groundId}`);
        sendResponse({ success: true, ran: true, ok, hydrated: h.hydrated, promoted, capabilityId: stamped.capabilityId, reason: ok ? undefined : ((result && result.error) || 'a step failed') });
      } catch (err) {
        Logger.error('background', `INVOKE_DRIVE_ARTIFACT failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      } finally { if (_busyTab != null) markEngineBusy(_busyTab, false); }
    },

    // §17 (DESIGN_connectors.md) — BANK already-captured network reads into the Ground's ride-recipe collection (the
    // flywheel tail: generalize → polish → mergeRecipes, landing `pending` behind the §18 arm guard). Thin wrapper over
    // the shared _bankHarvested core. Captures are UNTRUSTED app data — only their STRUCTURE (method + templated path) is
    // used; the polish input is structure-only (DESIGN_llm_privacy.md). DRAIN_HARVEST_TEE is the live producer of captures.
    // §20 (v2.74.1293) — keep ride auth-capture armed on a connected ride app's tab so the replay always reads a fresh
    // token (the panel fires this on render of a Ground that has accepted header-replay recipes). Fire-and-forget.
    ARM_RIDE_CAPTURE: (payload, _sender, sendResponse) => {
      sendResponse({ success: true });
      armRideAuthCapture({ host: String(payload?.host ?? ''), tabId: typeof payload?.tabId === 'number' ? payload.tabId : null })
        .catch((e) => { try { Logger.warn('background', `ARM_RIDE_CAPTURE: ${e.message}`); } catch { /* */ } });
    },
    BANK_HARVESTED_RECIPES: async (payload, _sender, sendResponse) => {
      try {
        const groundId = String(payload?.groundId ?? '').trim();
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        const res = await _bankHarvested({
          groundId,
          captures: Array.isArray(payload?.captures) ? payload.captures : [],
          appHost: String(payload?.appHost ?? '').trim(),
          origin: String(payload?.origin ?? '').trim(),
          doPolish: payload?.polish !== false,
        });
        Logger.info('ride', `BANK_HARVESTED_RECIPES +${res.banked} proto(s) → ${res.total} total (ground ${groundId})`);
        sendResponse({ success: true, ...res });
      } catch (err) {
        Logger.error('background', `BANK_HARVESTED_RECIPES failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // §17 — ARM the body-blind MAIN-world network TEE on a tab (_harvestTeeFunc). CONSENT-GATED on the same C6 Track
    // toggle (default-deny): a page-network tee is "observe my session", so it rides the existing per-host grant — no
    // consent, no injection. Idempotent (the tee self-guards). The buffer accretes on the page until DRAIN pulls it.
    // The patch dies with the document, so each navigation needs a re-ARM — the crawl wiring (next slice) does that;
    // here ARM is one-shot per call (a console / manual-test surface, and the per-page hook the crawl will call).
    ARM_HARVEST_TEE: async (payload, _sender, sendResponse) => {
      try {
        const tabId = payload?.tabId;
        if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' }); return; }
        let host = ''; try { host = new URL((await chrome.tabs.get(tabId))?.url || '').host; } catch { /* */ }
        let consent = MONITOR_CONSENT_DEFAULT;
        try { consent = (await chrome.storage.local.get('monitor:consent'))?.['monitor:consent'] || MONITOR_CONSENT_DEFAULT; } catch { /* */ }
        if (!canTrack(consent, { host })) {
          Logger.info('background', `ARM_HARVEST_TEE DENIED — no Track consent for ${host}`);
          sendResponse({ success: false, error: 'no-consent', host }); return;
        }
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN', files: [_HARVEST_TEE_FILE] });
        Logger.info('ride', `ARM_HARVEST_TEE tab ${tabId} (${host})`);
        sendResponse({ success: true, host });
      } catch (err) {
        Logger.error('background', `ARM_HARVEST_TEE failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // §17 — DRAIN the tee: pull + CLEAR window.__ahub_harvest_buf via a MAIN-world read, returning the captured calls. If
    // a groundId is given it ALSO banks them (generalize → polish → mergeRecipes via _bankHarvested) — the live end of the
    // harvest flywheel. appHost/origin default to the tab's own host. Drain-only (no groundId) just returns the captures.
    DRAIN_HARVEST_TEE: async (payload, _sender, sendResponse) => {
      try {
        const tabId = payload?.tabId;
        if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' }); return; }
        let captures = [];
        try {
          const out = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] }, world: 'MAIN',
            func: () => { const b = Array.isArray(window.__ahub_harvest_buf) ? window.__ahub_harvest_buf : []; window.__ahub_harvest_buf = []; return b; },
          });
          captures = Array.isArray(out?.[0]?.result) ? out[0].result : [];
        } catch (e) { sendResponse({ success: false, error: `drain-failed: ${e.message}` }); return; }
        const groundId = String(payload?.groundId ?? '').trim();
        if (!groundId) { sendResponse({ success: true, captures }); return; }   // drain-only (no bank)
        let host = ''; try { host = new URL((await chrome.tabs.get(tabId))?.url || '').host; } catch { /* */ }
        const res = await _bankHarvested({
          groundId, captures,
          appHost: String(payload?.appHost ?? '').trim() || host,
          origin: String(payload?.origin ?? '').trim() || host,
          doPolish: payload?.polish !== false,
        });
        Logger.info('ride', `DRAIN_HARVEST_TEE tab ${tabId}: ${captures.length} capture(s) → banked ${res.banked} (ground ${groundId})`);
        sendResponse({ success: true, captures, ...res });
      } catch (err) {
        Logger.error('background', `DRAIN_HARVEST_TEE failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // §17 (1b, DESIGN_connectors.md) — START a HARVEST SESSION on a tab: register the body-blind tee at DOCUMENT_START
    // (registerContentScripts, MAIN world) scoped to the Ground's host, so it catches the page's INITIAL data-load fetches
    // (post-load executeScript can't) and re-installs automatically on every navigation. CONSENT-GATED (C6 Track,
    // default-deny). Captures accumulate per-origin in sessionStorage across navs; STOP reads + banks them. A prior
    // session for the Ground is cleared first. `reload:true` reloads the tab so the CURRENT page also gets the tee (a
    // crawl navigates anyway → leave false). This is the autonomous-flywheel mechanism the Explore crawl will call.
    START_HARVEST_SESSION: async (payload, _sender, sendResponse) => {
      try {
        const tabId = payload?.tabId;
        if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' }); return; }
        let host = '', url = '';
        try { url = (await chrome.tabs.get(tabId))?.url || ''; host = new URL(url).host; } catch { /* */ }
        let groundId = String(payload?.groundId ?? '').trim();
        if (!groundId && url) { try { groundId = _groundIdForUrl(url, await StorageManager.getAllGrounds()); } catch { /* */ } }
        const r = await startHarvestSession({ tabId, groundId, host, appHost: String(payload?.appHost ?? '').trim(), origin: String(payload?.origin ?? '').trim(), reload: payload?.reload === true });
        if (!r.ok) {
          if (r.error === 'no-consent') Logger.info('background', `START_HARVEST_SESSION DENIED — no Track consent for ${host}`);
          sendResponse({ success: false, error: r.error, host: r.host || host }); return;
        }
        Logger.info('ride', `START_HARVEST_SESSION ${r.groundId} on ${r.host}`);
        sendResponse({ success: true, groundId: r.groundId, host: r.host });
      } catch (err) {
        Logger.error('background', `START_HARVEST_SESSION failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // §17 (1b) — STOP a harvest session: thin delegate to stopHarvestSession (unregister the document_start tee, drain
    // the tab's accumulator, bank). The Discovery crawl calls stopHarvestSession directly in its finally; this is the
    // manual/console message surface. Robust to a lost in-memory session (unregisters by the DERIVED id).
    STOP_HARVEST_SESSION: async (payload, _sender, sendResponse) => {
      try {
        const groundId = String(payload?.groundId ?? '').trim();
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        const r = await stopHarvestSession({
          groundId,
          tabId: typeof payload?.tabId === 'number' ? payload.tabId : null,
          readRideRecipes: ctx.readRideRecipes, writeRideRecipes: ctx.writeRideRecipes,
          appHost: String(payload?.appHost ?? '').trim(), origin: String(payload?.origin ?? '').trim(),
          doPolish: payload?.polish !== false,
        });
        Logger.info('ride', `STOP_HARVEST_SESSION ${groundId}: ${(r.captures || []).length} capture(s) → banked ${r.banked || 0}`);
        sendResponse({ success: true, ...r });
      } catch (err) {
        Logger.error('background', `STOP_HARVEST_SESSION failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // PP-5 (v2.74.1662, DESIGN_peritem_pipeline.md §1.1b) — CLASSIFY_BRANCH_ITEMS: one batched call that sorts N
    // items into named arms by reading a free-text field. The panel redacts each item's text BEFORE sending
    // (identity seeded from the record's own fields — §5 requires the address out, and no regex finds a street
    // address), so this handler only ever sees pseudonymized text and never holds the map.
    //
    // Fails to null rather than to a keyword fallback. A keyword fallback is precisely the confidently-wrong
    // answer PP-5 exists to prevent ("do NOT send a replacement" contains "replacement"), so when the model is
    // unavailable every item becomes UNKNOWN and a human reads them — the honest degradation.
    CLASSIFY_BRANCH_ITEMS: async (payload, _sender, sendResponse) => {
      try {
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const arms = Array.isArray(payload?.arms) ? payload.arms : [];
        const field = String(payload?.field ?? '').trim();
        if (!items.length || !arms.length) { sendResponse({ success: false, error: 'items and arms required' }); return; }
        const out = await AnthropicService.classifyBranch({ items, arms, field });
        if (!out) { sendResponse({ success: false, error: 'classifier unavailable' }); return; }
        // A Map cannot cross the message boundary — send an array and let the panel rebuild it.
        const verdicts = [...out.byId.entries()].map(([id, v]) => ({ id, group: v.group, why: v.why }));
        try { Logger.info('background', `BRANCH ▸ classified ${verdicts.length} item(s) over ${arms.length} arm(s)${out.invalid ? ` — ${out.invalid} invalid verdict(s)` : ''}${out.missing.length ? ` — ${out.missing.length} skipped` : ''}`); } catch { /* */ }
        sendResponse({ success: true, verdicts, invalid: out.invalid, missing: out.missing });
      } catch (e) {
        sendResponse({ success: false, error: String((e && e.message) || e) });
      }
    },

    // F-2 (v2.74.1176, DESIGN_llm_front_door.md §9) — INTERPRET_ASK: the LLM front-door INTERPRET call. Resolves the
    // Ground + retrieves the candidate set (ORCH_MATCH-as-RETRIEVER — the SAME tool-RAG as ROUTE_ASK, FED not gating),
    // then AnthropicService.interpret returns the raw §9.2 decision {intent, capabilityId|op, params, subAsks,
    // question, confidence, why}. The panel (chat.js) normalizes + palette-enforces + confidence-gates (Core/interpret)
    // and dispatches. Reached ONLY by the opt-in `i:` panel command for now (the F-2 test surface); the default
    // cascade is untouched until interpret proves out and is flipped to default.
    INTERPRET_ASK: async (payload, _sender, sendResponse) => {
      try {
        const ask = String(payload?.ask ?? '').trim();
        if (!ask) { sendResponse({ success: false, error: 'ask required' }); return; }
        let { tabId, groundId } = payload ?? {};
        let tabUrl = '';
        if (typeof tabId === 'number') { try { tabUrl = (await chrome.tabs.get(tabId))?.url || ''; } catch { /* */ } }
        if (!groundId && tabUrl) { try { groundId = _groundIdForUrl(tabUrl, await StorageManager.getAllGrounds()); } catch { /* */ } }
        const seed = String(payload?.seed ?? '').trim();
        const appId = String(payload?.appId ?? '').trim();   // AL-4 — the app's TYPE (object-model resolve; off-app → '')
        const memId = String(payload?.memoryId ?? '').trim() || appId;   // AP-0 (v2.74.1213) — the per-INSTANCE goal-memory key (falls back to the type for legacy apps)
        // AS-2c (v2.74.1190) — the app's bound site (TRUSTED config from setup). It seeds interpret's operating
        // context (the SYSTEM "OPERATING SITE" rule), and when the active tab ISN'T the bound site we resolve the
        // bound site's Ground so tool-RAG retrieves ITS capabilities ("get my open emails" finds the Gmail cap even
        // from another tab). Only fills an empty groundId — a real active-tab Ground is left as-is.
        const target = (payload?.target && typeof payload.target === 'object' && payload.target.origin)
          ? { origin: String(payload.target.origin), label: String(payload.target.label || payload.target.origin) } : null;
        if (target && !groundId) { try { groundId = _groundIdForUrl(target.origin, await StorageManager.getAllGrounds()); } catch { /* */ } }
        // AS-4 — the app's full connected SET (TRUSTED config); the interpret prompt's <CONNECTED_SITES> scope fence.
        const connections = Array.isArray(payload?.connections)
          ? payload.connections.filter((c) => c && typeof c === 'object' && c.origin).map((c) => ({ origin: String(c.origin), label: String(c.label || c.origin) }))
          : [];
        // CV-4-reduce — THIS app's OWN sub-task conversations + each one's latest-result peek (panel-sent, bounded to
        // the app's children). UNTRUSTED message text → the prompt fences it as data; coerce to plain strings here.
        const subTasks = Array.isArray(payload?.subTasks)
          ? payload.subTasks.filter((s) => s && typeof s === 'object').map((s) => ({ title: String(s.title || ''), summary: String(s.summary || ''), status: String(s.status || '') })).slice(0, 80)
          : [];
        // Q1 (v2.74.1264) — the panel-sent RECENT-TURN window (the last few turns of THIS conversation) for follow-up
        // continuity. UNTRUSTED (a prior assistant turn can echo page/tool text) → coerce to {role,text}, bound here;
        // the interpret prompt fences it as data (renderRecentTurns), never an instruction channel.
        const history = _recentTurnsPayload(payload?.history);
        let caps = [];
        if (groundId) { try { caps = ((await ctx.readSgCapabilities(groundId)) || []).filter((c) => c && isActiveCapability(c) && c.kind !== 'composite'); } catch { caps = []; } }
        // CX-4c — the app's CONNECTED session-ride recipes (scoped to its `connections`, the AS-4 set) become
        // selectable tools, origin-enriched to the connected instance: a support agent connected to deako.zendesk.com
        // retrieves the Zendesk READS + WRITES, so interpret can pick `my_open_tickets` OR `create_ticket` instead of
        // teaching/navigating. v2.74.1400 — writes now project too (was reads-only while the confirm UI was unbuilt):
        // a write pick routes through chat.js `_ilRunBuiltin`'s CX-6b HITL confirm branch and INVOKE_SESSION
        // fail-closes without confirmed:true (both belts) — gated end-to-end, exactly like the broker writes below. A
        // destructive write (merge/delete/spam, safety 'gated') gets the two-step confirm; the 'forbidden' floor stays
        // unofferable via policyFilter. This is what makes the Shopify write legs (create/edit customer, draft order)
        // reachable from a plain ask — the SH-T5 vehicle, no app required.
        const ragLegs = retrieveTools(ask, { capabilities: caps });
        const connLegs = connectorLegsForConnections(connections);
        // §20 — ALSO offer the connected Grounds' HARVESTED + accepted reads as session-ride tools (header-replay). Per
        // connection, resolve its Ground (by origin) → project its armable reads (the §18 gate) → deduped against the RAG +
        // curated legs. So "show me my schedules" can SELECT a harvested deakoapi recipe; the dispatch rides it via
        // SESSION_REPLAY (page-captured auth headers). Reads only (mode 'ask'); best-effort (never blocks interpret).
        let harvestedLegs = [];
        try {
          // v2.74.1449 (CX-9l fix) — the cascade runs UNCONDITIONALLY (was gated on `connections.length || groundId`,
          // v1428's outer condition): a ground-LESS active tab (any unexplored page) nulled groundId and skipped the
          // WHOLE ride projection — the last hidden active-tab precedence. Live: "on vendorsuite…" from a Deepgram tab
          // → zero connector legs → the router's honest teach ("I don't have a way to do that here yet") despite 19
          // armed vendorsuite legs existing. Ride capabilities must not depend on where the user happens to be.
          if (typeof ctx.readRideRecipes === 'function') {
            const _seen = new Set([...ragLegs, ...connLegs].map((l) => legRef(l)).filter(Boolean));
            if (connections.length) {
              const _allG = await StorageManager.getAllGrounds();
              for (const c of connections) {
                const gid = _groundIdForUrl(c.origin, _allG); if (!gid) continue;
                const recs = await _readRideRecipesOwn(gid, c.origin);   // v1435 — merged read: the palette never projects a stale stored shape; v2052 — own-origin (a foreign row projects a split-identity leg: target = the foreign site, sessionHost = this ground)
                const host = String(c.origin || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
                harvestedLegs.push(...harvestedRecipeLegs(recs, { host, mode: 'ask', seenKeys: _seen, groundId: gid }));   // v1340 (review A/§18) — carry the Ground for the run-time arm guard
                // HL-1 (v2.74.1454) — the Ground's built-in DRIVE legs ride along (heterogeneous legs: the data
                // reads ANSWER, the drive artifacts SHOW/act on the live page). Best-effort, deduped with the rest.
                try { harvestedLegs.push(...seededDriveLegs(await _readDriveArtifactsMerged(gid, c.origin), { host, groundId: gid, seenKeys: _seen })); } catch { /* */ }
              }
            } else {
              // v2.74.1428 (OV-6b) → v2.74.1446 (capability-global) → v2.74.1447 (CX-9l) — the SCOPING CASCADE, the
              // user-specified order of operations:
              //   1) the ask NAMES a site ("on vendorsuite…") → THAT site's legs only         [TARGET-SITE]
              //   2) no target → the ACTIVE TAB's ground legs first                            [ACTIVE-TAB]
              //   3) plus GLOBAL fallback legs from every other ride-armed Ground              [GLOBAL]
              //   4) nothing serves → the router's "teach" intent proposes LEARNING a leg (ride/drive/broker)
              // Target naming is DETERMINISTIC (host-label tokens ≥4 chars matched in the ask), and a named target
              // excludes everything else — the active tab NEVER outranks a named site (the Deepgram-tab live miss).
              // Tiers render as palette markers; the system SCOPING rule tells the router the precedence.
              let activeHost = ''; try { activeHost = new URL(tabUrl).host; } catch { /* */ }
              const armedEntries = await _rideArmedGrounds();
              // CX-9r (v2.74.1463) — CATALOG-ARMED origins: every OPEN TAB whose host matches a curated appHost is
              // routable WITHOUT a Ground (gid:null). The Ground is user-state's home, not a reachability gate — a
              // curated pre-accepted leg needs only a logged-in tab at dispatch (the exact asymmetry live: Aircall's
              // 17 HAR-built legs were unreachable in plain chat because no ground had ever seeded them, while an
              // APP connection would have projected them catalog-direct). Stored records outrank the projection
              // (covered hosts skip); the tab scan runs per-ask, OUTSIDE the 5-min cache, so a freshly opened app
              // tab is routable immediately. The joint vocab index keeps host-level distinctiveness global.
              let virtualEntries = [];
              try {
                const _tabs = await chrome.tabs.query({});
                const _tabHosts = [];
                for (const t of _tabs) { try { const u = new URL(t.url || ''); if (u.protocol === 'https:' || u.protocol === 'http:') _tabHosts.push(u.host); } catch { /* */ } }
                virtualEntries = catalogArmedEntries(_tabHosts, CONNECTOR_RECIPES, armedEntries.map((e) => e.host));
              } catch { /* best-effort — no tabs access, no virtual origins */ }
              const _entriesAll = [...armedEntries, ...virtualEntries];
              const armedGrounds = groundVocabIndex(_entriesAll);   // CX-9q — joint HOST-level distinctiveness
              const askLc = String(ask || '').toLowerCase();
              // v2.74.1471 — RAW ask-relevance per ground (pre-distinctness): the DISTINCTIVE vocab can lose a word to
              // cross-host sharing ("available" stopped being aircall-unique once other grounds' texts carried it), and
              // a CX-9r virtual origin sits LAST in projection order — live: workspace.aircall.io cap-starved on
              // "am I available?" (ride[global:104], aircall in the skipped list). Raw hits break the cap ordering tie
              // below so an ask-relevant ground projects before irrelevant global bulk. Object-identity keyed.
              const _rawHits = new Map();
              {
                const _askWords = [...new Set(askLc.split(/[^a-z]+/).filter((w) => w.length >= 5))];
                _entriesAll.forEach((e, i) => {
                  // v1473 — DENSITY, not binary presence: count (text × word) matches. Binary hits TIED aircall (whose
                  // whole catalog speaks "availab…") with grounds carrying one incidental mention, and ties fall back
                  // to storage order — live 21:45:01: workspace.aircall.io cap-skipped on "am I available?" AGAIN.
                  let h = 0;
                  try { for (const tx of (Array.isArray(e.texts) ? e.texts : [])) { const t = String(tx).toLowerCase(); for (const w of _askWords) if (t.includes(w)) h++; } } catch { /* */ }
                  _rawHits.set(armedGrounds[i], h);
                });
              }
              const _hostTokens = (h) => { const s = String(h).toLowerCase(); return [...new Set(s.split('.').filter((x) => x.length >= 4 && x !== 'www').concat([s]))]; };
              const targets = armedGrounds.filter(({ host }) => _hostTokens(host).some((t) => askLc.includes(t)));
              // CX-9m (v2.74.1450) — DOMAIN-MATCH: no site named, but the ask uses ONE ground's distinctive recipe
              // vocabulary ("warranty task…" → the vendorsuite ground) → promote that ground above GLOBAL. Only an
              // UNAMBIGUOUS best (a single ground, or a strict hit-count winner) promotes — ties stay plain global.
              // (Live: the unnamed re-ask decomposed into page steps because nothing distinguished the right GLOBAL leg.)
              let vocabHost = '';
              if (!targets.length) {
                const scored = armedGrounds
                  .map((g) => ({ g, hits: [...(g.vocab || [])].filter((w) => askLc.includes(w)).length }))
                  .filter((x) => x.hits > 0)
                  .sort((a, b) => b.hits - a.hits);
                if (scored.length === 1 || (scored.length > 1 && scored[0].hits > scored[1].hits)) vocabHost = scored[0].g.host;
              }
              // CX-9q (v2.74.1462) — the DOMAIN-MATCH winner projects FIRST: v1450 promoted it only via the scope
              // STAMP, but the 80-leg cap walked `chosen` in tab-local-then-storage order, so a late-stored vocab
              // winner could be cap-skipped entirely (live: 225 legs across 8 armed grounds, active tab = zendesk →
              // the vendorsuite grounds were among the "3 not projected" and vs_warranty_stats never reached the
              // palette). Order: vocab winner → tab-local → the rest; the cap now starves GLOBAL noise, not the winner.
              const chosen = (targets.length ? targets : armedGrounds.slice())
                .sort((a, b) => (Number(b.host === vocabHost) - Number(a.host === vocabHost))
                  || (Number(b.host === activeHost) - Number(a.host === activeHost))
                  || ((_rawHits.get(b) || 0) - (_rawHits.get(a) || 0)));   // DOMAIN-MATCH winner → tab-local → ask-relevance (v1471: the cap starves irrelevant bulk, never a relevant ground)
              let _capSkipped = 0; const _capSkippedHosts = [];   // v1467 (obs #4) — NAME the starved grounds, not just count them
              for (const { gid, host } of chosen) {
                if (harvestedLegs.length >= 80) { _capSkipped++; _capSkippedHosts.push(host); continue; }   // soft cap — logged below, never silent
                // CX-9r — a virtual (catalog-armed, gid:null) origin projects the curated records directly; a real
                // Ground reads merged storage (v1435) so user edits/harvested legs ride. Same records shape either way.
                const recs = (gid != null)
                  ? await _readRideRecipesOwn(gid, host)   // v1435 — merged read (catalog upgrades reach every projection); v2052 — own-origin
                  : curatedRidesForConnections([{ origin: host }], CONNECTOR_RECIPES);
                const legs = harvestedRecipeLegs(recs, { host, mode: 'ask', seenKeys: _seen, groundId: gid });
                const scope = targets.length ? 'target' : (host === vocabHost ? 'vocab' : (host === activeHost ? 'tab' : 'global'));
                for (const l of legs) l.scope = scope;                  // the tier marker interpretPrompt renders
                harvestedLegs.push(...legs);
                // HL-1 (v2.74.1454) — the Ground's built-in DRIVE legs join at the SAME scope tier (heterogeneous
                // legs: ride ANSWERS a question, drive SHOWS/acts on the live page — "review that task" picks drive).
                try {
                  const dLegs = seededDriveLegs(await _readDriveArtifactsMerged(gid, host), { host, groundId: gid, seenKeys: _seen });
                  for (const l of dLegs) l.scope = scope;
                  harvestedLegs.push(...dLegs);
                } catch { /* best-effort — drive legs never block interpret */ }
                // CX-9o (v2.74.1453) — the SECTION-NAV leg, DATA-derived (the anti-hardcode rule: navigation is a
                // router-selectable TOOL, never a chat regex). This ground's param-free section pages (its recipes'
                // listUrl/itemUrl filled with no params: '/#warranty' → warranty) become ONE leg with a `section`
                // enum + an optional `find` (open a SPECIFIC item on the page — the SPA has no per-item URL, so the
                // dispatch text-clicks its row after navigating). Same scope tier as the ground's other legs.
                const secPaths = {};
                for (const r of recs) {
                  if (!r || !(r.enabled && r.reviewState === 'accepted')) continue;
                  for (const t of [r.listUrl, r.itemUrl]) {
                    if (!t) continue;
                    const p = fillEndpoint(String(t), {});
                    if (!p || p.includes('{')) continue;
                    let lbl = '';
                    try {
                      const u = new URL(`https://${host}${p.startsWith('/') ? p : '/' + p}`);
                      lbl = (u.hash || '').replace(/[^a-z]/gi, '').toLowerCase();
                      if (!lbl) { const segs = u.pathname.split('/').filter((s) => /^[a-z-]+$/i.test(s)); lbl = (segs[segs.length - 1] || '').toLowerCase(); }
                    } catch { /* */ }
                    if (lbl && lbl.length >= 4 && !secPaths[lbl]) secPaths[lbl] = p;
                  }
                }
                const secLabels = Object.keys(secPaths);
                const navKey = `me.site.open_page@${host}`;
                if (secLabels.length && !_seen.has(navKey)) {
                  _seen.add(navKey);
                  harvestedLegs.push({
                    key: navKey, name: `Open ${host}`,
                    does: `NAVIGATE to / focus the live ${host} site — open its ${secLabels.join(' / ')} page, optionally jumping to ONE item on it (find). Use this to SHOW the site; use the data reads to ANSWER questions.`,
                    mode: 'act', domain: 'connector', source: 'builtin', safety: 'auto',
                    params: ['section', 'find'],
                    paramSchema: { type: 'object', properties: {
                      section: { type: 'string', enum: secLabels, hint: 'which page of the site to open' },
                      find: { type: 'string', hint: 'text identifying ONE item to open there — a street address or task/claim number' },
                    }, required: [] },
                    tool: { impl: 'session', sectionNav: { sections: secPaths }, origin: host, groundId: gid },
                    scope,
                  });
                }
              }
              if (_capSkipped) { try { Logger.info('background', `INTERPRET_ASK ▸ ride-leg cap (80) — ${_capSkipped} ride-armed ground(s) not projected: ${_capSkippedHosts.slice(0, 8).join(', ')}${_capSkipped > 8 ? ' …' : ''}`); } catch { /* */ } }
              if (targets.length) { try { Logger.info('background', `INTERPRET_ASK ▸ scope=TARGET ${targets.map((t) => t.host).join(',')}`); } catch { /* */ } }
              else if (vocabHost) { try { Logger.info('background', `INTERPRET_ASK ▸ scope=VOCAB ${vocabHost}`); } catch { /* */ } }
              // §20 — keep the ride auth-capture armed on the ACTIVE tab when it is itself a ride host, so a pick has a
              // FRESH token (fire-and-forget; idempotent). Non-active ride hosts arm at dispatch (SESSION_REPLAY does).
              if (activeHost && typeof tabId === 'number' && chosen.some((x) => x.host === activeHost)) { void armRideAuthCapture({ host: activeHost, tabId }).catch(() => { /* */ }); }
            }
          }
        } catch { /* never block interpret on the harvested-leg projection */ }
        // CX-9p (v2.74.1461) — the routing-review fix, applied once the harvested/ride/drive legs are built:
        //   1) LEARNED-MATCH (warm path): recall a recorded ask-shape→leg SUCCESS (Core/connectorAlias). If that leg
        //      is in the palette, stamp it scope 'alias' (top of the cascade) — a repeat of an ask that once resolved
        //      warms straight back to the same leg, without re-deriving it from vocabulary. Empty store → no-op.
        //   2) PRE-RANK (Core/legPrerank): order the scope-tiered legs so the highest tier + most ask-relevant lead,
        //      and CAP zero-overlap GLOBAL legs when a winner (alias/target/vocab) owns the ask — so a lexically
        //      attractive but out-of-domain global ("Search Zendesk tickets" for the warranty ask) can no longer
        //      out-attract the implied site's leg. Makes the SCOPING precedence DATA, not just a soft rule the LLM
        //      is asked to honor (findings v1450/v1451: the unnamed warranty ask picked search_tickets → no-app-tab).
        try {
          if (harvestedLegs.length) {
            const _al = (await chrome.storage.local.get('connector:aliases'))['connector:aliases'];
            const recalled = recallAlias(Array.isArray(_al) ? _al : [], ask);
            if (recalled && recalled.ref) {
              const hit = harvestedLegs.find((l) => legRef(l) === recalled.ref);
              if (hit) { hit.scope = 'alias'; try { Logger.info('background', `INTERPRET_ASK ▸ scope=ALIAS ${recalled.host || ''}`.trim()); } catch { /* */ } }
            }
          }
          harvestedLegs = prerankLegs(harvestedLegs, ask);
        } catch { /* the recall/pre-rank is an enhancement — never blocks interpret */ }
        // CX-5c — the BROKER (OAuth/MCP) legs for the active page + connected hosts, gated on LINKED providers (the
        // `connector:linkedProviders` cache LINK/UNLINK maintain — an unlinked provider's legs stay out; a
        // selectable-but-dead leg reads as broken). Reads AND writes project: a write pick hits the chat-side HITL
        // confirm and INVOKE_CONNECTOR fail-closes without confirmed:true — gated end-to-end, so surfacing is honest.
        let brokerLegs = [];
        try {
          const _lp = await chrome.storage.local.get(['connector:linkedProviders', 'connector:liveTools']);
          const linked = Array.isArray(_lp['connector:linkedProviders']) ? _lp['connector:linkedProviders'] : [];
          // MP-2c (v2.74.1319) — the live tools/list cache: when present for a server, the palette carries the
          // server's OWN schemas instead of the seed (brokerCatalog liveTools override — schemas can't drift).
          const liveTools = (_lp['connector:liveTools'] && typeof _lp['connector:liveTools'] === 'object') ? _lp['connector:liveTools'] : null;
          if (linked.length) {
            const _seenB = new Set([...ragLegs, ...connLegs, ...harvestedLegs].map((l) => legRef(l)).filter(Boolean));
            const hosts = new Set();
            try { if (tabUrl) hosts.add(new URL(tabUrl).host); } catch { /* */ }
            for (const c of connections) { try { hosts.add(new URL(/^https?:\/\//i.test(c.origin) ? c.origin : `https://${c.origin}`).host); } catch { /* */ } }
            for (const h of hosts) brokerLegs.push(...brokerLegsForLinked(h, linked, { seenKeys: _seenB, liveTools }));
          }
        } catch { /* never block interpret on the broker projection */ }
        // GD-4b (v2.74.1324) — drafting on the fly: when THIS app defines a presentation layer (§8), its COMPOSE
        // leg joins the palette as a STANDALONE act — "draft a reply to James…" selects compose (the ask IS the
        // brief; no ticket/connector context required) instead of clarify-looping. chat.js routes the pick through
        // COMPOSE_CANVAS; with a spec already on the surface the ask becomes a GD-4 revision turn.
        const composeLeg = appId ? composeOfferedLeg(builtinApp(appId)) : null;
        // FL (v1348) — the fleet CONSOLE legs join interpret's palette for a connected app: "review the queue" /
        // "show me both tickets" / "open zendesk" route through the IL like everything else (no static regex).
        const fleetLegs = (appId && connections.length) ? fleetOfferedLegs(builtinApp(appId), true) : [];
        // v2.74.1340 (review A) — the §2.3 policy floor on the LIVE palette: a `forbidden`-safety leg is never
        // offerable to interpret (it previously ran only in the dormant Core/ilRun.js — the floor was unwired here).
        // The rule table stays empty until user routing-rules ship; the unrelaxable floor is what matters now.
        // v2.74.1879 — drop a harvested leg that is a frozen INSTANCE of a curated leg's template before the
        // router ever sees it. Live 194001: `harvest_get_api_vendor_dashboard_statistic_83` (division 83 baked
        // into the id, answerable for exactly one of 121) outranked the parameterised `vs_warranty_stats` and
        // answered "You have 1 job." The general form dominates the instance, so this is a drop, not a demote.
        const retrieved = policyFilter(dropShadowedLegs([...ragLegs, ...connLegs, ...harvestedLegs, ...brokerLegs, ...(composeLeg ? [composeLeg] : []), ...fleetLegs, ...panelOfferedLegs()]), { scope: { ground: groundId || null } });   // v1354 — CLEAR_CHAT joins (a typed "clear chat" used to fall through to the TEACH offer)
        // v1467 (obs #5) — PALETTE ▸: what the router SAW, by source + scope tier (counts + tier keys only — body-blind).
        // The v1462 vocab-annihilation diagnosis took candidate-count arithmetic across two traces; this line is the
        // direct evidence: e.g. `PALETTE ▸ 93 leg(s) — rag:0 conn:0 ride[tab:17 global:45] broker:0 fleet:0 panel:1`.
        try {
          const _byScope = {};
          for (const l of harvestedLegs) { const s = (l && l.scope) || 'conn'; _byScope[s] = (_byScope[s] || 0) + 1; }
          const _scopeStr = Object.entries(_byScope).map(([s, n]) => `${s}:${n}`).join(' ');
          Logger.info('background', `PALETTE ▸ ${retrieved.length} leg(s) — rag:${ragLegs.length} conn:${connLegs.length} ride[${_scopeStr || '—'}] broker:${brokerLegs.length} fleet:${fleetLegs.length} panel:${panelOfferedLegs().length}${composeLeg ? ' compose:1' : ''}`);
        } catch { /* never block interpret on its own observability */ }
        // UC-1 (v2.74.1957) — THE TARGET GROUND HAS ARMED LEGS THAT ARE ABSENT FROM THIS PALETTE.
        // Live 19:11: TARGET resolved www.ups.com (TR-4/tab visitor), the ground had two armed legs, the
        // conversation did not carry the connection, so they never projected and the router answered `navigate`
        // at conf 0.95 — opening the tracking page instead of tracking, with nothing said about why. A wrong ACT
        // gets noticed; this plausible DOWNGRADE does not, and it teaches the user the feature half-works.
        // Cheap-first by construction: the palette membership test is a scan of what we already have, and the
        // storage reads only happen in the rare case where the target ground contributed NOTHING.
        let unconnected = null;
        // v2.74.1958 — DISABLED, and the reason is the bug. Live 19:38 it fired on a turn with `PALETTE ▸ 120 ·
        // conn:50` whose very next line was `→ act leg=me.ups.ups_track` → `ok list[1]`: the legs were present,
        // used, and successful, and the detector called them absent. It fired on EVERY turn.
        // ROOT CAUSE: `groundId` here is the AMBIENT ground (active tab / conversation), not the ask's
        // TARGET-resolved ground. `leg.tool.groundId` is set correctly (connectorRecipes.js:1282); I compared it
        // against the wrong ground, so whenever the active ground differed from the ground owning the palette's
        // ride legs — the normal case with several connections — nothing matched and it reported "absent".
        // A false-positive nag on every turn is strictly worse than the silence it was built to fix: the note
        // would appear next to answers that WORKED, which teaches users to ignore it, and an honest warning
        // people have learned to skip is worse than no warning at all. Inert until it reads the TARGET ground
        // (the value behind `TARGET ▸ tier=…`), which is a different variable than this one.
        // UC-2 (v2.74.1966) — RE-ENABLED, reading the TARGET ground this time.
        // UC-1 (v1957) compared the AMBIENT ground (active tab / conversation) against the palette, so whenever
        // the active ground differed from the ground owning the palette's ride legs — the normal case with
        // several connections — nothing matched and it fired on EVERY turn, including turns whose very next line
        // was a successful invoke. Its own FAIL arm caught it on the first live turn and it was disabled.
        // The right variable was already here: `target` (sg.js:1591) carries the RESOLVED target that the panel
        // computed and logged as `TARGET ▸ tier=…/target=…`. That is the ground the ask actually asked about.
        //
        // Live confirmations this is worth saying out loud, all four with the same shape:
        //   15:46  a UPS tracking number bound a Shopify ORDER leg and returned 200 (SG-1 now refuses it)
        //   19:11  "track 1Z…" → navigate, silently, at conf 0.95
        //   21:26  "track 1Z…" → navigate, then `IL ▸ missing required tracking` — the number was IN the ask
        //   21:27  "use ups to track 1Z…" → clarify "UPS is not among the connected sites"  <- the HONEST one
        // The 21:27 line proves the system CAN say this; it just only says it on one of several paths.
        try {
          // UC-3 (v2.74.1967) — the RESOLVED target arrives as payload.resolvedTarget and carries groundId
          // DIRECTLY. UC-2 read `target` (the conversation's CONFIGURED binding, null on every ordinary turn) and
          // so never ran — live 21:38 `TARGET ▸ TR-1/explicit target=www.ups.com` + `PALETTE ▸ 118` produced a
          // silent navigate with no UNCONNECTED line. Prefer the groundId; fall back to a host lookup only if an
          // older panel sends host alone.
          const _rt = (payload && payload.resolvedTarget) || null;
          const _tOrigin = String((_rt && _rt.host) || (target && target.origin) || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
          if (_tOrigin || (_rt && _rt.groundId)) {
            const _gs = (_rt && _rt.groundId) ? null : await StorageManager.getAllGrounds();
            const _gid = (_rt && _rt.groundId) || _groundIdForUrl(_tOrigin, _gs);
            // Cheap-first: the membership scan uses data already in hand, and the storage read only happens when
            // the TARGET ground contributed nothing at all — the rare case, not every turn (UC-1's fatal flaw).
            if (_gid && !retrieved.some((l) => String((l && (l.groundId || (l.tool && l.tool.groundId))) || '') === _gid)) {
              const _recs = await _readRideRecipesOwn(_gid, _tOrigin);   // v2052 — own-origin: foreign rows must not inflate the "armed legs you cannot see" count
              unconnected = absentTargetLegs({ groundId: _gid, paletteLegs: retrieved, armedRecipes: (_recs || []).filter((r) => r && rideArmable(r)) });
              if (unconnected) {
                unconnected.host = _tOrigin;   // the panel names the SITE — a gnd_ hash means nothing to a reader
                Logger.info('background', `PALETTE ▸ UNCONNECTED — ${_tOrigin} has ${unconnected.count} armed leg(s) absent from this conversation (${unconnected.names.slice(0, 2).join(', ')})`);
              }
            }
          }
        } catch { /* detection is advisory — never fail an interpret over it */ }
        const primitives = ['OPEN_URL', 'CLICK', 'TYPE', 'SCROLL', 'EXTRACT'];
        // F-2 (v2.74.1179) — feed interpret the live page VOCABULARY (the same affordances IL_ANSWER reads from the
        // cached Locale) so its act/teach/clarify decisions are grounded in what the page actually offers, not just
        // the ask + the saved-capability catalog. Fenced as DATA in the prompt; empty (cold page) is harmless.
        let affordances = '';
        if (groundId) {
          try {
            const pm = await ctx.readLocaleCache(groundId, ctx.normalizeUrl(tabUrl || ''));
            const labels = localeAffordanceLabels(pm && pm.model);
            if (Array.isArray(labels) && labels.length) affordances = labels.join(', ');
          } catch { /* */ }
        }
        // AL-4 — the app's LEARNED context: standing rules (deltas) + ask-relevant recall (the capability-association
        // belief banked in AL-3b → so a paraphrase recalls the taught capability). Trusted (the app's own memory),
        // fenced in the prompt. Empty off-app / no-memory.
        // OM — the app's OBJECT MODEL (noun/states/actions/transitions) from its catalog type/preset, resolved once:
        // it gives the LLM the exact state vocabulary (<OBJECTS>, v2.74.1199) AND makes recall operation-aware
        // (recall-by-grid, v2.74.1201). Empty off-app.
        const om = appId ? (builtinApp(appId)?.objectModel || null) : null;
        let learned = '';
        // v2.74.1870 — hand recall the CURRENT shape of every leg in this palette, so an act-fail verdict about
        // routing that has since changed retires before it can steer (live 192848: `read warranty task 4867009`
        // — an ask that now works end to end — clarified at 0.4 citing a lesson banked four routing versions
        // ago, and because it clarified the honest miss never rendered and the cross-division button could not
        // be reached for a FOURTH pass). The palette is already built here; the shape derives from it.
        const _shapes = {};
        try { for (const l of (retrieved || [])) { if (l && l.key) { const s = capabilityShapeKey(l); if (s) _shapes[l.key] = s; } } } catch { /* recall still works without it */ }
        if (memId) { try { learned = goalContextFor(await loadGoalItems(memId), ask, { om, shapes: _shapes }); } catch { /* */ } }
        const objects = describeObjectModel(om);
        const decision = await AnthropicService.interpret({ ask, retrieved, primitives, affordances, seed, target, connections, learned, objects, subTasks, history, focusDigest: (payload && Array.isArray(payload.focusDigest)) ? payload.focusDigest : [] });   // FD-1 (v2.74.1972)
        // v1467 (obs #2) — name the CHOSEN LEG + bound param NAMES (never values) on the decision line. The wrong-leg
        // class ("0 warranty tasks" was Zendesk search_tickets) previously took response-vocabulary forensics to spot;
        // the pick was in `decision` all along and just never printed.
        const _pick = String(decision.tool || decision.capabilityId || decision.op || '') || '—';
        const _pNames = (decision.params && typeof decision.params === 'object') ? Object.keys(decision.params).join(',') : '';
        // v1476 — the chosen leg's SCOPE TIER (alias/target/vocab/tab/global): the alias marker (ask #5) that says
        // whether this pick came from a warm recall vs a fresh vocab match — visible without cross-referencing the palette.
        let _pScope = ''; try { const _pl = retrieved.find((l) => l && legRef(l) === _pick); if (_pl && _pl.scope) _pScope = ` scope:${_pl.scope}`; } catch { /* */ }
        Logger.info('route', `INTERPRET_ASK "${_scrubHead(ask, 60)}" → ${decision.intent} leg=${_pick.slice(0, 60)}${_pNames ? ` params:{${_pNames}}` : ''}${_pScope} (conf ${decision.confidence}, ${retrieved.length} cand, ground ${groundId || '—'})`);
        sendResponse({ success: true, decision, groundId: groundId || null, retrieved, unconnected });   // UC-1 — the panel turns this into an honest sentence instead of a silent substitution
      } catch (err) {
        Logger.error('background', `INTERPRET_ASK failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // FL-1 (v2.74.1346, DESIGN_app_fleet.md) — SWEEP_PROPOSE: the fleet app's propose-only run's two think seams.
    // phase 'reads': offer the app's connector READ legs → the model picks ≤3 reads (validated against the offer).
    // phase 'propose': the panel-executed read RESULTS (fenced DATA) + the ACT legs → validated PROPOSALS — never
    // dispatched here; the panel parks them in the pending queue (ProposalStore) for the user's approve/reject.
    // The palette is CONNECTOR-DOMAIN only (curated for the app's connections + harvested reads + broker legs) —
    // deliberately leaner than INTERPRET_ASK's (no page RAG / compose / affordances): a sweep works the app's
    // connected systems, not the active tab. Zero domain logic — the seed + memory rules steer the model
    // (the DESIGN_app_fleet.md portability test).
    SWEEP_PROPOSE: async (payload, _sender, sendResponse) => {
      try {
        const phase = payload?.phase === 'propose' ? 'propose' : 'reads';
        const connections = Array.isArray(payload?.connections)
          ? payload.connections.filter((c) => c && typeof c === 'object' && c.origin).map((c) => ({ origin: String(c.origin), label: String(c.label || c.origin) }))
          : [];
        if (!connections.length) { sendResponse({ success: false, error: 'no-connections', hint: 'run setup to connect this app’s sites first' }); return; }
        const appId = payload?.appId ? String(payload.appId) : '';
        const memId = payload?.memoryId ? String(payload.memoryId) : appId;
        const seed = String(payload?.seed || '');
        // Curated legs for the connected set — reads AND writes (the writes are what proposals select over).
        const curated = connectorLegsForConnections(connections);
        // Harvested + broker READS join the offer (same projections INTERPRET_ASK makes, deduped).
        let harvested = [];
        try {
          if (typeof ctx.readRideRecipes === 'function') {
            const _allG = await StorageManager.getAllGrounds();
            const _seen = new Set(curated.map((l) => legRef(l)).filter(Boolean));
            for (const c of connections) {
              const gid = _groundIdForUrl(c.origin, _allG); if (!gid) continue;
              const recs = await _readRideRecipesOwn(gid, c.origin);   // v1435 — merged read (the sweep projects fresh catalog shapes too); v2052 — own-origin (no foreign-leg offers to the fleet model)
              const host = String(c.origin || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
              harvested.push(...harvestedRecipeLegs(recs, { host, mode: 'ask', seenKeys: _seen, groundId: gid }));
            }
          }
        } catch { /* never block the sweep on the harvested projection */ }
        let broker = [];
        try {
          const _lp = await chrome.storage.local.get(['connector:linkedProviders', 'connector:liveTools']);
          const linked = Array.isArray(_lp['connector:linkedProviders']) ? _lp['connector:linkedProviders'] : [];
          const liveTools = (_lp['connector:liveTools'] && typeof _lp['connector:liveTools'] === 'object') ? _lp['connector:liveTools'] : null;
          if (linked.length) {
            const _seenB = new Set([...curated, ...harvested].map((l) => legRef(l)).filter(Boolean));
            for (const c of connections) {
              try { const h = new URL(/^https?:\/\//i.test(c.origin) ? c.origin : `https://${c.origin}`).host; broker.push(...brokerLegsForLinked(h, linked, { seenKeys: _seenB, liveTools })); } catch { /* */ }
            }
          }
        } catch { /* never block the sweep on the broker projection */ }
        const legsAll = policyFilter([...curated, ...harvested, ...broker], { scope: {} });   // the 'forbidden' floor holds here too
        // DK-2 (DESIGN_desks.md §5) — presence (my/team availability, set-availability) is operator STATE, not
        // backlog: drop it from the sweep so "review the queue" never offers "my availability" as a queue read nor
        // proposes "set your availability" as a queue action. Presence stays a DIRECT capability on interpret.
        const { queue: queueLegs } = partitionDeskLegs(legsAll);
        const askLegs = queueLegs.filter((l) => l && l.mode === 'ask');
        const actLegs = queueLegs.filter((l) => l && l.mode === 'act');
        const om = appId ? (builtinApp(appId)?.objectModel || null) : null;
        let learned = '';
        if (memId) { try { learned = goalContextFor(await loadGoalItems(memId), `sweep: ${seed.slice(0, 80)}`, { om }); } catch { /* */ } }
        const objects = describeObjectModel(om);
        if (phase === 'reads') {
          const raw = await AnthropicService.sweepReads({ seed, learned, objects, legs: askLegs, maxReads: 3 });
          const reads = parseSweepReads(raw, { legs: askLegs, maxReads: 3 });
          Logger.info('route', `SWEEP ▸ reads → picked [${reads.map((r) => r.key).join(', ') || '—'}] of ${askLegs.length} offered (${connections.length} connection(s))`);
          sendResponse({ success: true, reads, legs: askLegs });
        } else {
          // FL-1b (v1347) — round 1 may return `needs` (targeted evidence reads); round 2 is FINAL (needs ignored).
          const round = payload?.round === 2 ? 2 : 1;
          const results = Array.isArray(payload?.results) ? payload.results.slice(0, 12) : [];   // 3 breadth + 8 evidence (FL-2b) + margin
          // DK-4 (DESIGN_desks.md §6) — FEDERATE the executed reads into cross-site ISSUES: normalize each result to
          // WorkItems (source = the leg's host), union by shared corrKeys (email/phone/order). A call+warranty+ticket+
          // order sharing a key are ONE issue → propose reasons over the issue, not the isolated row. Additive: a
          // single-connection sweep links nothing → `issues` empty → the prompt is byte-identical (zero regression).
          let issueCtx = [];
          try {
            const fed = federateResults(results, { sourceOf: (r) => { const k = String((r && r.key) || ''); const at = k.indexOf('@'); return at >= 0 ? k.slice(at + 1) : k; } });
            Logger.info('route', `SWEEP ▸ federate → ${fed.items.length} item(s) → ${fed.issues.length} issue(s), ${fed.crossSite} cross-site${fed.crossSite ? ` [${crossSiteKinds(fed.issues).join('/')}]` : ''}`);
            if (fed.crossSite) issueCtx = issueLines(fed.issues);
          } catch { /* federation is additive — never block the sweep */ }
          const raw = await AnthropicService.sweepPropose({ seed, learned, objects, legs: actLegs, askLegs: round === 1 ? askLegs : [], results, round, context: String(payload?.context || ''), evidence: String(payload?.evidence || ''), issues: issueCtx });   // FL-10b — drill extracts ride through; DK-4 — + cross-site issues
          const { proposals, needs, summary } = parseSweepProposals(raw, { legs: actLegs, askLegs });
          const outNeeds = round === 1 ? needs : [];
          Logger.info('route', `SWEEP ▸ propose r${round} → ${proposals.length} proposal(s)${outNeeds.length ? ` + ${outNeeds.length} evidence need(s)` : ''} from ${results.length} read(s), ${actLegs.length} action(s) offered${summary ? ` — ${summary.slice(0, 80)}` : ''}`);
          sendResponse({ success: true, proposals, needs: outNeeds, summary });
        }
      } catch (err) {
        Logger.error('background', `SWEEP_PROPOSE failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // FL-6b (v2.74.1356, DESIGN_app_fleet.md §6b) — SEED_DIRECTIVES: the IL reads an app's SEED for a stated
    // recurring cadence ("review the queue every hour" → {"every":"1h"}). Never regex over the seed (v1348);
    // the panel operationalizes only the validated return (parseEvery clamps; instanceId never comes from the
    // model). A no-LLM/failed extraction returns success:false so the caller touches NOTHING.
    SEED_DIRECTIVES: async (payload, _sender, sendResponse) => {
      try {
        const seed = String(payload?.seed || '').trim();
        if (!seed) { sendResponse({ success: true, every: null }); return; }
        const raw = await AnthropicService.seedDirectives({ seed });
        if (raw == null) { sendResponse({ success: false, error: 'no-llm' }); return; }
        const d = parseSeedDirectives(raw);
        Logger.info('route', `SWEEP ▸ seed-directive → ${d.every ? `every ${d.every}` : 'no cadence'}${d.assignQuota != null ? `, quota ${d.assignQuota}/day` : ''}`);
        sendResponse({ success: true, every: d.every, assignQuota: d.assignQuota });
      } catch (err) {
        Logger.error('background', `SEED_DIRECTIVES failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // IL-2 (v2.74.1112) — RETRIEVE_TOOLS: the LEARNED-leg source for the panel-hosted inference-layer loop's
    // assemblePalette (Core/ilRun). Mirrors ROUTE_ASK's ground-resolution + candidate computation, minus
    // the LLM route — returns the retrieved candidates + the resolved groundId so the panel can ctx-bind
    // execPlan. Reached ONLY by the `il:` panel command (verify-only); never touches the default cascade.
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

    // IL-2 (v2.74.1112) — STEP_IL: the inference-layer loop's THINK seam (AnthropicService.stepIl over a
    // StepContext). The panel hosts the loop (Core/ilRun + agentLoop) and round-trips here each cold step;
    // the pure prompt/parse (palette + observation fenced as DATA) lives in Core/stepPrompt.js. Verify-only.
    STEP_IL: async (payload, _sender, sendResponse) => {
      try {
        const decision = await AnthropicService.stepIl(payload?.ctx || {});
        sendResponse({ success: true, decision });
      } catch (err) {
        Logger.error('background', `STEP_IL failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // IL-2 (v2.74.1118) — JUDGE_MATCH: Orchard as the user's stand-in deciding WHICH of matchCapability's
    // candidates to run (or reject), given the ask + the values the substrate already bound. The panel passes the
    // candidates ORCH_MATCH surfaced; this returns {ref, reason}. No re-binding — Orchard picks the capability.
    JUDGE_MATCH: async (payload, _sender, sendResponse) => {
      try {
        const verdict = await AnthropicService.judgeMatch({ ask: payload?.ask, candidates: payload?.candidates });
        sendResponse({ success: true, verdict });
      } catch (err) {
        Logger.error('background', `JUDGE_MATCH failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // CX-8c decouple (v2.74.1302) — bank the demonstration's captured WRITE(s) even when the DOM-action recorder got
    // NOTHING (fragile on iframe/shadow SPAs like Gmail). The write recipe comes from the network capture, not the DOM
    // trace, so it doesn't need one. Without demonstratedValues (no DOM types), BLANKET-template every string leaf →
    // params (privacy: never bank a literal) so the recipe is safe + fillable, if crude (rename in Studio). Pending,
    // behind the §18 arm guard. Called by _orchRecordFlow when a stop has 0 actions but writeCaptures > 0.
    BANK_DEMONSTRATED_WRITES: async (payload, _sender, sendResponse) => {
      try {
        const { groundId = null } = payload ?? {};
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        const writeCaps = (ctx && typeof ctx.getDemoWriteCaptures === 'function') ? (ctx.getDemoWriteCaptures() || []) : [];
        if (!writeCaps.length) { sendResponse({ success: true, banked: 0 }); return; }
        let appHost = ''; try { appHost = new URL(writeCaps[0].url).host; } catch { /* */ }
        const writeRecipes = recipesFromObservedWrites(writeCaps, { appHost, demonstratedValues: [], blanket: true });
        if (!writeRecipes.length) { sendResponse({ success: true, banked: 0 }); return; }
        const named = writeRecipes.map((r) => ({ ...r, groundId }));
        const existingRide = (await ctx.readRideRecipes(groundId)) || [];
        await ctx.writeRideRecipes(groundId, rideMergeRecipes(existingRide, named));
        Logger.info('background', `DEMO_WRITE ▸ banked ${writeRecipes.length} demonstrated write-recipe(s) (pending, no-DOM-trace blanket-template) for ${groundId}: ${named.map((r) => `${r.method} ${r.endpoint}`).join(', ').slice(0, 120)}`);
        sendResponse({ success: true, banked: writeRecipes.length });
      } catch (err) { try { Logger.error('background', `BANK_DEMONSTRATED_WRITES failed: ${err.message}`); } catch { /* */ } sendResponse({ success: false, error: err.message }); }
    },

    // IL-2 (v2.74.1119) — IL_ANSWER: Orchard handles a META / conversational ask ("what can you do?") when
    // nothing matched. Reads the FULL capability set for this Ground (not a lexical top-k — the user wants the
    // whole picture) + answers from it via AnthropicService.answerAsk. Resolves the Ground like ROUTE_ASK.
    IL_ANSWER: async (payload, _sender, sendResponse) => {
      try {
        const ask = String(payload?.ask ?? '').trim();
        let { tabId, groundId } = payload ?? {};
        const seed = String(payload?.seed ?? '').trim();   // CV-2b — conversation seed → the answer's persona preamble
        const connections = Array.isArray(payload?.connections)   // AS-4 — the app's connected sites → the answer's reach
          ? payload.connections.filter((c) => c && typeof c === 'object' && c.origin).map((c) => ({ origin: String(c.origin), label: String(c.label || c.origin) }))
          : [];
        const subTasks = Array.isArray(payload?.subTasks)   // CV-4-reduce — THIS app's own children + their latest results (untrusted; fenced as data)
          ? payload.subTasks.filter((s) => s && typeof s === 'object').map((s) => ({ title: String(s.title || ''), summary: String(s.summary || ''), status: String(s.status || '') })).slice(0, 80)
          : [];
        const history = _recentTurnsPayload(payload?.history);   // Q1 — the recent-turn window (untrusted; coerced + bounded; fenced as data in the answer prompt)
        const appId = String(payload?.appId ?? '').trim();   // AL-4 — the app's TYPE (object-model resolve; off-app → '')
        const memId = String(payload?.memoryId ?? '').trim() || appId;   // AP-0 (v2.74.1213) — the per-INSTANCE goal-memory key (falls back to the type for legacy apps)
        let tabUrl = '';
        if (typeof tabId === 'number') { try { tabUrl = (await chrome.tabs.get(tabId))?.url || ''; } catch { /* */ } }
        if (!groundId && tabUrl) { try { groundId = _groundIdForUrl(tabUrl, await StorageManager.getAllGrounds()); } catch { /* */ } }
        // v2.74.1121 — feed Orchard the context the substrate already computes but it was blind to:
        //   #1 affordances (what's on the page now) · #3 which caps are established (aliased) · #5 coverage (gaps).
        let rawCaps = [];
        if (groundId) { try { rawCaps = ((await ctx.readSgCapabilities(groundId)) || []).filter((c) => c && isActiveCapability(c) && c.kind !== 'composite'); } catch { rawCaps = []; } }
        const caps = rawCaps.map((c) => ({ name: c.intent || c.name, alias: c.alias }));
        let affordances = [], coverage = null;
        if (groundId) {
          try {
            const pm = await ctx.readLocaleCache(groundId, ctx.normalizeUrl(tabUrl || ''));
            const model = pm && pm.model;
            affordances = localeAffordanceLabels(model);                                   // #1 — the live page vocabulary
            const goals = (model && model.goals && typeof model.goals === 'object') ? Object.values(model.goals) : [];
            coverage = authoringCoverage(goals, rawCaps);                                   // #5 — taught vs known gaps
          } catch { /* */ }
        }
        // AL-4 — the app's LEARNED context (standing rules + relevant facts) shapes the prose answer too (e.g. a
        // `remember:` rule like "keep replies terse" applies here). Trusted; fenced in the prompt; empty off-app.
        const om = appId ? (builtinApp(appId)?.objectModel || null) : null;   // OM — the app's object model (resolved once)
        let learned = '';
        if (memId) { try { learned = goalContextFor(await loadGoalItems(memId), ask, { om }); } catch { /* */ } }
        const objects = describeObjectModel(om);
        let ride = [];   // §18 — the RIDE class (harvested/curated ride-recipes) so "what can you do" covers the app's Data/API actions, not only page actions
        try { ride = curatedRidesForConnections(connections, CONNECTOR_RECIPES); } catch { ride = []; }
        const storedRide = [];
        try {
          if (connections.length && typeof ctx.readRideRecipes === 'function') {
            const allG = await StorageManager.getAllGrounds();
            for (const c of connections) {
              const gid = _groundIdForUrl(c.origin, allG); if (!gid) continue;
              storedRide.push(...((await _readRideRecipesOwn(gid, c.origin)) || []));   // v2052 — own-origin ("what can you do" must not claim foreign capabilities)
            }
          } else if (groundId && typeof ctx.readRideRecipes === 'function') {
            // v2052 — own-origin on the raw branch too; anchor = the ground's own identity (primaryHost).
            const _raw = (await ctx.readRideRecipes(groundId)) || [];
            let _gHost = '';
            try { const _g = ((await StorageManager.getAllGrounds()) || []).find((x) => x && (x.id === groundId || x.groundId === groundId)); _gHost = String(primaryHost(_g) || ''); } catch { /* */ }
            storedRide.push(..._ownRideRecords(_raw, _gHost, groundId));
          }
        } catch { /* best-effort — curated connection rides still list */ }
        try { ride = mergeRideCatalogForAnswer(ride, storedRide); } catch { /* */ }
        // v2.74.1577 — VERIFIED example asks (the user's rule: example phrases in answers must be TESTED, never
        // composed). Ground truth = the alias stores: a connector alias records the EXACT ask that ran a leg
        // successfully (the teach-once flywheel); an SG capability's `alias` is its taught, replayed phrase.
        // Newest-first, deduped, capped — the prompt's quote-only rule does the rest.
        let verifiedAsks = [];
        try {
          const al = (await chrome.storage.local.get('connector:aliases'))?.['connector:aliases'];
          verifiedAsks = (Array.isArray(al) ? al : []).slice()
            .sort((a, b) => ((b && b.at) || 0) - ((a && a.at) || 0))
            .map((a) => (a && a.ask) ? { ask: String(a.ask), host: String(a.host || '') } : null)
            .filter(Boolean);
        } catch { /* */ }
        try { for (const c of rawCaps) if (c && c.alias) verifiedAsks.push({ ask: String(c.alias), host: '' }); } catch { /* */ }
        const _seenAsk = new Set();
        verifiedAsks = verifiedAsks.filter((v) => { const k = v.ask.trim().toLowerCase(); if (!k || _seenAsk.has(k)) return false; _seenAsk.add(k); return true; }).slice(0, 12);
        let answer = await AnthropicService.answerAsk({ ask, capabilities: caps, affordances, coverage, url: tabUrl, seed, connections, ride, learned, objects, subTasks, history, verifiedAsks });
        // Honesty belt (v2.74.1295) — the answer path dispatched NOTHING, so a completion claim on a side-effect
        // COMMAND is a fabrication (the calendar "✅ I created it" bug, findings 2026-06-27 21:27). Neutralize +
        // log so a trace SHOWS the override. The answerPrompt BASE rule is primary; this is the deterministic backstop.
        try {
          if (answer) {
            const guarded = neutralizeFalseCompletion(answer, ask);
            if (guarded.neutralized) {
              answer = guarded.answer;
              Logger.info('background', `ANSWER_GUARD ▸ neutralized a false-completion claim — "${_scrubHead(ask, 48)}" routed to answer (no dispatch) but the reply claimed the act was done`);
            }
          }
        } catch { /* never block the answer on the guard */ }
        // PS-0 (v2.74.1123) — persist Orchard's capability-gap enumeration instead of discarding it: the durable,
        // per-Ground DEMAND signal PS-1 arms into the interaction monitor for passive harvest. Non-fatal/best-effort.
        try {
          if (groundId) {
            const candidates = await AnthropicService.enumerateGaps({ ask, capabilities: caps, affordances, url: tabUrl });
            if (Array.isArray(candidates) && candidates.length) {
              const merged = await ctx.mutateGaps(groundId, (g) => mergeGaps(g, candidates, { now: Date.now() }));
              const gs = summarizeGaps(merged);
              try { Logger.info('background', `GAPS ▸ ${gs.total} for ${groundId} (+${candidates.length} enumerated, ${gs.open} open)`); } catch { /* */ }
            }
          }
        } catch (e) { try { Logger.warn('background', `IL_ANSWER gap-persist non-fatal: ${e.message}`); } catch { /* */ } }
        sendResponse({ success: true, answer, groundId: groundId || null });
      } catch (err) {
        Logger.error('background', `IL_ANSWER failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // PS-3 (v2.74.1126) — SYNTHESIZE_FROM_GAP: turn a HARVESTED gap into a durable, UNVERIFIED capability,
    // "stage / verify-on-first-use". Probe the live page to RESOLVE a selector for the captured a11y identity
    // (proves the control still exists — NO click), compose the library entities (Core/synthFromGap, the same
    // shape the OBS demonstration path produces), persist them marked trial.verdict:'observed' (the matcher
    // downranks vs trial-pass'd), and flip the gap to 'promoted'. The FIRST real `il:` invocation is the actual
    // click, gated by the existing read-only-floor / write-confirm — synthesis never executes the action.
    SYNTHESIZE_FROM_GAP: async (payload, _sender, sendResponse) => {
      try {
        let { groundId = null, tabId = null, gapKey = null, ask = null } = payload ?? {};
        let tabUrl = '';
        if (typeof tabId === 'number') { try { tabUrl = (await chrome.tabs.get(tabId))?.url || ''; } catch { /* */ } }
        if (!groundId && tabUrl) { try { groundId = _groundIdForUrl(tabUrl, await StorageManager.getAllGrounds()); } catch { /* */ } }
        if (!groundId) { sendResponse({ success: true, synthesized: false, reason: 'no-ground' }); return; }
        const gaps = await ctx.readGaps(groundId);
        const key = gapKey || (ask ? matchAskToGap(ask, gaps) : null);   // PS-4 — resolve the ask → best HARVESTED gap
        const gap = key ? gaps.find((g) => g && g.key === key) : null;
        if (!gap || gap.status !== 'harvested' || !gap.fulfillment || !gap.fulfillment.accessibleName) {
          sendResponse({ success: true, synthesized: false, reason: 'no-harvested-gap' }); return;
        }
        // Resolve a selector from the captured identity (probe-or-recover; selector:null → straight to heuristic
        // recovery by role+accessibleName). A miss means the control is gone → can't stage; no side effect either way.
        // Native controls capture NO explicit aria role → fall back to the enumerated expectedIdentity.role (the
        // recovery heuristic needs a role; a role-less fallback makes it silently fail, the .1127 live miss).
        const probeRole = gap.fulfillment.role || (gap.expectedIdentity && gap.expectedIdentity.role) || null;
        let selector = null, via = null;
        if (typeof tabId === 'number') {
          try {
            const probe = await chrome.tabs.sendMessage(tabId, { type: 'LANDMARK_PROBE_OR_RECOVER', payload: { selector: null, fallback: { role: probeRole, accessibleName: gap.fulfillment.accessibleName } } });
            if (probe && probe.success && probe.selector) { selector = probe.selector; via = probe.via || probe.matchMethod || null; }
          } catch (e) { Logger.warn('background', `SYNTHESIZE_FROM_GAP probe failed: ${e.message}`); }
        }
        if (!selector) { try { Logger.info('monitor', `SYNTH ▸ "${gap.intent}" → no-synth (selector-unresolved; role=${probeRole || '—'}, name="${gap.fulfillment.accessibleName}") @ ${groundId}`); } catch { /* */ } sendResponse({ success: true, synthesized: false, reason: 'selector-unresolved' }); return; }
        const localeUrl = ctx.normalizeUrl(tabUrl || '');
        const built = buildHarvestCapability({ gap, selector, localeUrl, groundId }, { now: Date.now(), newId: () => crypto.randomUUID() });
        if (!built) { try { Logger.info('monitor', `SYNTH ▸ "${gap.intent}" → no-synth (compose-failed) @ ${groundId}`); } catch { /* */ } sendResponse({ success: true, synthesized: false, reason: 'compose-failed' }); return; }
        for (const lm of built.landmarks) { try { await StorageManager.saveLandmark(lm); } catch (e) { Logger.warn('background', `SYNTHESIZE saveLandmark: ${e.message}`); } }
        try { await StorageManager.savePerspective(built.perspective); } catch (e) { Logger.warn('background', `SYNTHESIZE savePerspective: ${e.message}`); }
        try { await StorageManager.saveFragment(built.fragment); } catch (e) { Logger.warn('background', `SYNTHESIZE saveFragment: ${e.message}`); }
        await ctx.writeSgCapability(groundId, built.capability);
        await ctx.mutateGaps(groundId, (g) => setStatus(g, key, 'promoted', Date.now()));
        try { Logger.info('monitor', `SYNTH ▸ "${gap.intent}" → capability ${built.capability.id} (via ${via || 'probe'}, unverified) @ ${groundId}`); } catch { /* */ }
        sendResponse({ success: true, synthesized: true, accepted: true, capabilityId: built.capability.id, intent: gap.intent, groundId, reason: 'staged' });
      } catch (err) {
        Logger.error('background', `SYNTHESIZE_FROM_GAP failed: ${err.message}`);
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
          if (!spec) { Logger.info('background', `RUN_SG_TRIAL ▸ EXIT — comprehend returned nothing for "${_scrubHead(intent, 60)}"`); sendResponse({ success: false, error: 'comprehend returned nothing' }); return; }   // v2.74.914
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
          Logger.info('background', `RUN_SG_TRIAL[tier2] — intent="${_scrubHead(intent, 60)}" shape=${spec.shape} nodes=${op.nodes.length} [${op.nodes.map((n) => n.type).join(' → ')}]`);
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
            Logger.info('background', `RUN_SG_TRIAL[tier2] ▸ EXIT — no actionable phases for "${_scrubHead(intent, 60)}" (cover=${cover0.complete}; ${cover0.reason})`);
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
        Logger.info('background', `RUN_SG_TRIAL — intent="${_scrubHead(intent, 60)}" shape=${spec.shape} cover=${cover.complete} roles=${roles.length}`);
        if (!roles.length) { Logger.info('background', `RUN_SG_TRIAL ▸ EXIT — no bindable roles from the selection for "${_scrubHead(intent, 60)}"`); sendResponse({ success: true, ran: false, reason: 'no bindable roles from the selection', cover, intentShape: spec.shape }); return; }   // v2.74.925 (CR-T2) — the .914 every-exit-logs invariant missed this one
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
        // v2.74.1530 — diagnostic: did a result-row click content-address (reuse the search value as CLICK_BY_LABEL)?
        // Surfaces in gl so the OBS-4b content-addressing (v1528/1530) is verifiable from a re-teach trace.
        try { const _ca = params.filter((p) => p && p.clickReuse).length; if (_ca) Logger.info('background', `OBS_PARAM ▸ content-addressed ${_ca} result-row click(s) → CLICK_BY_LABEL by search value`); } catch { /* */ }
        // v2.74.1534 — diagnostic: did a #divisionMenu click generalize to a {division} param? Surfaces in gl so the
        // "the walk selects the division" generalization is verifiable from a re-teach trace (else it's invisible).
        try { const _dv = params.find((p) => p && p.kind === 'option' && /divisionmenu/i.test(String(p.containerHint || ''))); if (_dv) Logger.info('background', `OBS_PARAM ▸ division select generalized → {${_dv.key}} CLICK_BY_LABEL in ${_dv.containerHint} (default "${String(_dv.value || '').slice(0, 40)}", vocab ${(_dv.vocabulary || []).length})`); } catch { /* */ }
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
          // v2.74.1556 — the RAW recorded start (hash intact): localeUrl goes through pageKey normalization which
          // STRIPS the hash, so a hash-routed SPA's "#dashboard" start was unrecoverable — replay from "#warranty"
          // (or bare "/", a DIFFERENT page) failed at step 0 (live 175025/180622). REPLAY establishes this page
          // before running (start-establish), and self-stamps it on legacy capabilities at their next success.
          startUrl: (phasesRaw[0] && phasesRaw[0].url) || '',
          ...(isSingleT1 ? { fragmentId: fragmentIds[0] } : { strategyId }), fragmentIds,
          landmarkUids: [...seenUid], params: namedParams, aliases: seedAliases, phases: phases.map((p) => p.label), binding: [], synthesized: true,
          createdAt: Date.now(), trial: { score: null, verdict: 'observed', trialRef: null },
        };
        await ctx.writeSgCapability(groundId, capability);
        // CX-8c (v2.74.1299) — if the demonstration captured the app's OWN write request(s) (body-aware tee, opt-in +
        // page-local; drained at RECORD_STOP), template them into pending ride WRITE-recipes (recipeFromObservedWrite:
        // the user's typed values → params, the body NEVER banked literally) and merge into this Ground's ride store,
        // behind the §18 arm guard — HITL accept before they can run. Best-effort; never blocks the demo accept.
        try {
          const writeCaps = (ctx && typeof ctx.getDemoWriteCaptures === 'function') ? (ctx.getDemoWriteCaptures() || []) : [];
          if (writeCaps.length) {
            const demonstratedValues = coalesce(trace).map((a) => a && a.value).filter((v) => typeof v === 'string' && v.trim());
            let appHost = ''; try { appHost = new URL((phases[0] && phases[0].url) || (trace[0] && trace[0].url) || '').host; } catch { /* */ }
            const writeRecipes = recipesFromObservedWrites(writeCaps, { appHost, demonstratedValues });
            if (writeRecipes.length) {
              const named = writeRecipes.map((r) => ({ ...r, groundId, ...(writeRecipes.length === 1 ? { name: capName || r.name, does: capDescription || r.does } : {}) }));
              const existingRide = (await ctx.readRideRecipes(groundId)) || [];
              await ctx.writeRideRecipes(groundId, rideMergeRecipes(existingRide, named));
              Logger.info('background', `DEMO_WRITE ▸ banked ${writeRecipes.length} demonstrated write-recipe(s) (pending) for ${groundId}: ${named.map((r) => `${r.method} ${r.endpoint}`).join(', ').slice(0, 120)}`);
            }
          }
        } catch (e) { Logger.warn('background', `DEMO_WRITE bank non-fatal: ${e.message}`); }
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
        let ride = [];   // §18 — the RIDE class (harvested/curated ride-recipes); buildIntentMenu shows armable run-now + a pending summary
        try {
          ride = (await ctx.readRideRecipes(gid)) || [];
          // v2.74.2053 — anchor on the GROUND's identity, not the tab host (review defect: gid resolution is
          // sibling-aware, so the tab may be a merged sibling of every own row — a tab-host anchor emptied the
          // menu and logged false pollution). Tab host only as the no-primaryHost fallback.
          try {
            let _anchor = ''; try { _anchor = String(primaryHost(await StorageManager.getGround(gid)) || ''); } catch { _anchor = ''; }
            ride = _ownRideRecords(ride, _anchor || new URL(url).host, gid);
          } catch { /* no anchor → unfiltered */ }
        } catch { /* */ }
        const menu = buildIntentMenu({ caps, goals, siteCatalog, ride, readiness, limit });
        Logger.info('background', `INTENT_MENU ▸ ${menu.entries.length} entr${menu.entries.length === 1 ? 'y' : 'ies'} (${menu.counts.taught} taught, ${menu.counts.teachable} teachable, ${menu.counts.goals} goal(s); readiness=${readiness || '—'}) [${String(gid).slice(-6)}]`);
        sendResponse({ success: true, groundId: gid, menu });
      } catch (err) {
        Logger.error('background', `GET_INTENT_MENU failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // AS-5 (v2.74.1406) — GET_CAPABLE_SITES: the BACKGROUND half of the "sites with defined capabilities" setup
    // catalog. Returns every Ground's origin + its ACTIVE capability count (Grounds that taught something), plus the
    // linked broker providers. The panel adds the curated + broker catalogs + its own apps' connections and runs the
    // pure `capableSitesCatalog` merge. Read-only introspection over the user's OWN Grounds — mints/drives nothing.
    GET_CAPABLE_SITES: async (_payload, _sender, sendResponse) => {
      try {
        let grounds = [];
        try { grounds = (await StorageManager.getAllGrounds()) || []; } catch { grounds = []; }
        const sites = [];
        for (const g of (Array.isArray(grounds) ? grounds : [])) {
          const gid = g && (g.id || g.groundId); if (!gid) continue;
          let caps = 0;
          try { caps = ((await ctx.readSgCapabilities(gid)) || []).filter((c) => isActiveCapability(c)).length; } catch { /* */ }
          if (!(caps > 0)) continue;   // only Grounds with taught capabilities belong in the catalog
          let origin = null; try { origin = g.url ? new URL(g.url).origin : (g.origin || null); } catch { origin = g.origin || null; }
          sites.push({ origin: origin || g.name || null, caps, groundId: gid });
        }
        let linkedProviders = [];
        try { const lp = await chrome.storage.local.get('connector:linkedProviders'); linkedProviders = Array.isArray(lp['connector:linkedProviders']) ? lp['connector:linkedProviders'] : []; } catch { /* */ }
        Logger.info('background', `CAPABLE_SITES ▸ ${sites.length} taught site(s) · ${linkedProviders.length} linked provider(s)`);
        sendResponse({ success: true, sites, linkedProviders });
      } catch (err) {
        try { Logger.error('background', `GET_CAPABLE_SITES failed: ${err.message}`); } catch { /* */ }
        sendResponse({ success: false, error: err.message });
      }
    },

    // OV-2 (v2.74.1417, DESIGN_overview.md §3) — GET_LEG_OVERVIEW: the cross-Ground LEG INVENTORY for the Overview
    // workbench (the developer plane where legs are authored + tested + verified BEFORE an app consumes them). Reads
    // every Ground's RIDE recipes (the authored/harvested/curated tail — the testable + verifiable class) plus a
    // read-only summary of its taught page-capabilities (the DRIVE class, developed in Studio), and runs the pure
    // buildLegOverview rollup (counts + per-Ground breakdown + the work QUEUE = what still needs the developer).
    // Read-only introspection over the user's OWN Grounds — mints/drives nothing.
    GET_LEG_OVERVIEW: async (_payload, _sender, sendResponse) => {
      try {
        let grounds = [];
        try { grounds = (await StorageManager.getAllGrounds()) || []; } catch { grounds = []; }
        const shaped = [];
        for (const g of (Array.isArray(grounds) ? grounds : [])) {
          const gid = g && (g.id || g.groundId); if (!gid) continue;
          let origin = null; try { origin = g.url ? new URL(g.url).origin : (g.origin || null); } catch { origin = g.origin || null; }
          let host = g.name || String(gid); try { if (origin) host = new URL(origin).host; } catch { /* */ }
          let recipes = []; try { recipes = (await ctx.readRideRecipes(gid)) || []; } catch { recipes = []; }
          // v2052 — own-origin: the workbench's per-ground counts/queue must not book foreign legs under this
          // ground (the RIDE_RESOLVE ▸ log keeps the pollution visible; EDIT_RIDE_RECIPE still reads raw, so a
          // foreign row remains deletable by id). Only filter when the ground has a real origin — the g.name
          // fallback label is not a host and must not empty the list (_ownRideRecords bares scheme/www itself).
          try { const _anchor = String(primaryHost(g) || '') || origin; if (_anchor) recipes = _ownRideRecords(recipes, _anchor, gid); } catch { /* keep unfiltered */ }   // v2.74.2053 — ground identity first
          let caps = []; try { caps = ((await ctx.readSgCapabilities(gid)) || []).filter((c) => isActiveCapability(c)); } catch { caps = []; }
          if (!recipes.length && !caps.length) continue;   // skip empty Grounds — the workbench lists only sites with legs
          const driveSections = caps.length
            ? [{ type: 'capabilities', label: 'Page capabilities', count: caps.length, entries: caps.map((c) => ({ id: c.id || c.capabilityId, name: c.name || c.label || c.intent || 'capability' })) }]
            : [];
          shaped.push({ groundId: gid, host, label: g.name || host, origin, recipes, driveSections });
        }
        const overview = buildLegOverview({ grounds: shaped });
        Logger.info('background', `LEG_OVERVIEW ▸ ${overview.counts.total} leg(s) · ${overview.grounds.length} ground(s) · ${overview.counts.verified} verified · ${overview.queue.length} queued`);
        sendResponse({ success: true, overview });
      } catch (err) {
        try { Logger.error('background', `GET_LEG_OVERVIEW failed: ${err.message}`); } catch { /* */ }
        sendResponse({ success: false, error: err.message });
      }
    },

    // OV-5 (v2.74.1417, DESIGN_overview.md §3) — ADD_RIDE_RECIPE: author a leg BY HAND (the no-code replacement for
    // editing CONNECTOR_RECIPES). Accepts either a compact one-line `spec` ("<Name> | <METHOD> <endpoint>") or explicit
    // `fields`; buildManualRecipe validates and DERIVES the safety class from the METHOD (never the untrusted name — §9),
    // landing the recipe `pending` (unverified) so it MUST be tested + accepted before an app can consume it. Merged
    // (id-keyed upsert, keeps prior user edits) into the Ground's collection, then persisted. Authoring only — drives nothing.
    ADD_RIDE_RECIPE: async (payload, _sender, sendResponse) => {
      try {
        const groundId = String(payload?.groundId ?? '').trim();
        const origin = String(payload?.origin ?? '').trim();
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        const specStr = (typeof payload?.spec === 'string') ? payload.spec.trim() : '';
        const spec = specStr ? parseLegSpec(specStr) : null;
        if (specStr && !spec) { sendResponse({ success: false, error: 'spec format: "<Name> | <METHOD> <endpoint>" — e.g. "Read ticket | GET /api/v2/tickets/{id}.json"' }); return; }
        const fields = (payload?.fields && typeof payload.fields === 'object') ? payload.fields : {};
        const input = spec ? { ...spec, ...fields } : fields;
        const { ok, errors, recipe } = buildManualRecipe(input, { groundId, origin });
        if (!ok) { sendResponse({ success: false, error: errors.join('; ') }); return; }
        const existing = (await ctx.readRideRecipes(groundId)) || [];
        const next = rideMergeRecipes(existing, [recipe]);
        await ctx.writeRideRecipes(groundId, next);
        Logger.info('ride', `ADD_RIDE_RECIPE ${recipe.method} ${String(recipe.id).slice(0, 40)} → ${recipe.safetyClass}/pending (ground ${groundId})`);
        sendResponse({ success: true, recipe, recipes: next });
      } catch (err) {
        try { Logger.error('background', `ADD_RIDE_RECIPE failed: ${err.message}`); } catch { /* */ }
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
        // PS-1 (v2.74.1124) — passive gap HARVEST: a USER click (engine already dropped at the top guard) on an
        // UNKNOWN control ('miss') whose a11y identity fulfils a declared OPEN gap flips the gap to 'harvested' +
        // records the WHERE (role/name/tag — NEVER a typed value, §5). Detached + non-fatal (mirrors the C5 flush);
        // the RMW goes through ctx.mutateGaps so a concurrent re-enumeration can't clobber it. Gated on an
        // accessibleName — a nameless control can't match a namePattern, so most misses skip the chain entirely.
        if (resolved.resolutionStatus === 'miss' && groundId && raw.target && raw.target.accessibleName) {
          void (async () => {
            try {
              let hit = null;
              await ctx.mutateGaps(groundId, (gaps) => {
                const k = (Array.isArray(gaps) && gaps.length) ? matchInteractionToGap(raw.target, gaps) : null;
                if (!k) return gaps;
                hit = gaps.find((g) => g.key === k) || null;
                return recordFulfillment(gaps, k, { role: raw.target.role, accessibleName: raw.target.accessibleName, tagName: raw.target.tagName }, raw.ts);
              });
              if (hit) { try { Logger.info('monitor', `HARVEST ▸ "${hit.intent}" ← ${raw.interactionKind} on "${raw.target.accessibleName}" @ ${groundId}`); } catch { /* */ } }
              else {
                // PS-2 — no declared gap matched → retain in the long-tail observed pool (value-free), the
                // catch-net PS-3 reads on an ask-miss for capabilities Orchard never thought to list.
                await ctx.mutateObsPool(groundId, (pool) => addObservation(pool, { role: raw.target.role, accessibleName: raw.target.accessibleName, kind: raw.interactionKind }, { seq, now: raw.ts }));
              }
            } catch (e) { try { Logger.warn('background', `gap-harvest non-fatal: ${e.message}`); } catch { /* */ } }
          })();
        }
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
        const { tabId, groundId = null, ask = '', includeActions = false } = payload ?? {};
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
        // v2.74.1525 — an EXACT-ALIAS capability SURVIVES effect scoping: that alias IS this very ask's taught
        // phrasing, and the user's own naming outranks the verb heuristic. Live ("where's the teach?"): "show
        // ticket … on vendorsuite" classified READ → the twice-demonstrated ACTION strategy was scoped out
        // BEFORE the alias was ever consulted, so the taught capability could never fire on the ask that taught it.
        const _nAsk = normalizeAliasPhrase(ask);
        const _aliasHit = (c) => !!c && Array.isArray(c.aliases) && c.aliases.some((al) => normalizeAliasPhrase(al) === _nAsk);
        // v2.74.1536 — the on-site OPEN intercept (chat `_openRecordOnSite`) sets includeActions: "show ticket X in
        // Raleigh on vendorsuite" is READ-phrased but its MECHANISM is an ACTION walk (navigate + select division +
        // search + click the row to display it ON the page). The READ scope hid that walk whenever the phrasing
        // wasn't the exact demonstrated alias — a DIFFERENT ticket number, or an added "in <division>" — so the
        // whole {division}/{ticketId} generalization was structurally unreachable (live: 0/7 candidates → miss →
        // drill, and the drill's address-click also missed). With includeActions a READ ask keeps the action pool;
        // the intercept still gates replay on binds-ticket, so a mis-pick falls through to the drill as before.
        let pool;
        if (_askIsRead && !includeActions) pool = projected.filter((c) => _isReadCand(c) || _aliasHit(c));
        else if (_askIsRead) pool = projected;   // read-phrased action (on-site open) — don't scope the walk out
        else { const _acts = projected.filter((c) => !_isReadCand(c) || _aliasHit(c)); pool = _acts.length ? _acts : projected; }
        Logger.info('background', `ORCH_MATCH scope ▸ ask=${_askIsRead ? (includeActions ? 'READ+actions' : 'READ') : 'ACTION'} → ${pool.length}/${projected.length} candidate(s) (effect-scoped${_askIsRead ? (includeActions ? ', actions kept for on-site open' : ', observations only') : ', actions only'})`);
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
        Logger.info('background', `ORCH_MATCH ▸ ask="${_scrubHead(ask, 90)}" @ ${localeUrl || '(no url)'} ground=${gid}`);
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
        // v2.74.1525 — same exact-alias scope bypass as ORCH_MATCH (the taught phrasing outranks the verb heuristic).
        const _nAskG = normalizeAliasPhrase(ask);
        const _aliasHitG = (c) => !!c && Array.isArray(c.aliases) && c.aliases.some((al) => normalizeAliasPhrase(al) === _nAskG);
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
          const pool = askIsRead ? projected.filter((c) => _isReadCand(c) || _aliasHitG(c))
            : (projected.filter((c) => !_isReadCand(c) || _aliasHitG(c)).length ? projected.filter((c) => !_isReadCand(c) || _aliasHitG(c)) : projected);
          for (const c of pool) tagged.push({ cand: c, gid, g });
        }
        Logger.info('background', `GROUNDS ▸ ${roster.length} ground(s): ${roster.join(' · ') || '(none)'}`);   // v2.74.818 — the inventory blind-spot: host(id,Ncap) for every Ground
        if (!tagged.length) { Logger.info('background', `ORCH_MATCH_GLOBAL ▸ "${_scrubHead(ask, 60)}" → no candidates across Grounds`); sendResponse({ success: true, hits: [] }); return; }
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
        Logger.info('background', `ORCH_MATCH_GLOBAL ▸ "${_scrubHead(ask, 60)}" → ${hits.length} Ground(s) [${scores ? 'LLM' : 'lexical'} over ${tagged.length} cand]: ${hits.map((h) => `${h.groundName}(${h.relevance.toFixed(2)})`).join(', ') || '(none)'}`);
        sendResponse({ success: true, hits });
      } catch (err) {
        Logger.error('background', `ORCH_MATCH_GLOBAL failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // TRT-2 (v2.74.1546, DESIGN_target_routing.md §3/§9) — TARGET_RESOLVE: the TR-ladder resolver, answering
    // "WHERE does this ask run?" as ONE observable decision (`TARGET ▸` line) instead of a side effect scattered
    // across routing branches. Composes injected data for the PURE resolver: grounds, per-ground vocabulary
    // fingerprints (capabilities + aliases everywhere; ride-leg vocabulary ONLY for the bounded desk/tab grounds —
    // _readRideRecipesMerged touches storage, so it is never swept across all grounds), the global alias index,
    // the tab's ground, and TR-5 live origins (fresh CONN-registry entries + open-tab hosts). The caps/alias part
    // is cached 60s (aliases recorded mid-window surface within a minute — acceptable staleness, documented).
    // The resolver NAMES the target; run authority stays with ORCH-G. Never LLM, never a minted origin.
    TARGET_RESOLVE: async (payload, _sender, sendResponse) => {
      try {
        const { ask = '', tabId = null, deskOrigins = [], focus = [] } = payload ?? {};   // FC-4 (v2.74.1552) — the conversation's focus provenance (TR-2 evidence)
        if (typeof ask !== 'string' || !ask.trim()) { sendResponse({ success: false, error: 'ask required' }); return; }
        const all = (await StorageManager.getAllGrounds()) || [];
        const grounds = all.map((g) => ({ groundId: g.id || g.groundId, host: primaryHost(g) || '', name: _groundLabel(g) || '' })).filter((g) => g.groundId);
        const now = Date.now();
        if (!_targetCtxCache || (now - _targetCtxCache.at) > 60000) {
          const fingerprints = []; const aliasIndex = [];
          for (const g of grounds) {
            let caps = [];
            try { caps = ((await ctx.readSgCapabilities(g.groundId)) || []).filter((c) => c && isActiveCapability(c)); } catch { caps = []; }
            for (const c of caps) for (const al of (Array.isArray(c.aliases) ? c.aliases : [])) aliasIndex.push({ phrase: normalizeAliasPhrase(al), groundId: g.groundId, capabilityId: c.id });
            fingerprints.push({ groundId: g.groundId, fp: vocabularyFingerprint({ capabilities: caps }) });
          }
          _targetCtxCache = { at: now, fingerprints, aliasIndex };
        }
        let tabGroundId = null; let tabHost = '';
        if (typeof tabId === 'number') {
          try { const t = await chrome.tabs.get(tabId); tabGroundId = _groundIdForUrl(t?.url || '', all); try { tabHost = new URL(t?.url || '').host; } catch { /* */ } } catch { /* */ }
        }
        // Enrich the NEAR grounds (desk connections + the tab) with ride-leg vocabulary — bounded to ≤4 reads.
        const nearHosts = new Set([...(Array.isArray(deskOrigins) ? deskOrigins : []), tabHost].filter(Boolean).map((s) => String(s).toLowerCase()));
        const fingerprints = _targetCtxCache.fingerprints.map((f) => ({ ...f }));
        for (const g of grounds) {
          if (!nearHosts.has(String(g.host).toLowerCase())) continue;
          try {
            const recipes = await _readRideRecipesOwn(g.groundId, g.host);   // v2052 — own-origin: foreign vocabulary must not join a near ground's fingerprint
            const legFp = vocabularyFingerprint({ legs: (recipes || []).map((r) => ({ name: r.name, does: r.does, params: r.params })) });
            const mine = fingerprints.find((f) => f.groundId === g.groundId);
            if (mine) { const merged = { ...mine.fp }; for (const [t, n] of Object.entries(legFp)) merged[t] = (merged[t] || 0) + n; mine.fp = merged; }
          } catch { /* legs are enrichment — the caps fingerprint stands */ }
        }
        let liveOrigins = [];
        try { const reg = (await readConnRegistry()) || {}; const bad = new Set(attentionOrigins(reg, Object.keys(reg)).map((a) => a.origin)); liveOrigins = Object.keys(reg).filter((o) => !bad.has(o)); } catch { /* */ }
        try { const tabs = await chrome.tabs.query({}); for (const t of tabs) { try { const h = new URL(t.url || '').host; if (h && /^https?:/.test(t.url || '') && !liveOrigins.includes(h)) liveOrigins.push(h); } catch { /* */ } } } catch { /* */ }
        const decision = resolveTarget(ask, { grounds, fingerprints, aliasIndex: _targetCtxCache.aliasIndex, normalizePhrase: normalizeAliasPhrase, deskOrigins, tabGroundId, liveOrigins, focus });
        Logger.info('background', renderTargetDecision(decision));
        sendResponse({ success: true, decision, tabGroundId });
      } catch (err) {
        Logger.error('background', `TARGET_RESOLVE failed: ${err.message}`);
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
        Logger.info('background', `BUILD_SG_ON_GROUND_WORKFLOW — "${_scrubHead(ask, 50)}" → ${capabilityKind} ${capabilityId} on ${_groundLabel(g)} (params: ${Object.keys(stated).join(',') || 'none'})`);
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
        if (depoisoned) Logger.info('background', `ORCH_RECORD_ALIAS — de-poisoned "${_scrubHead(phrase, 40)}" from ${depoisoned} other capability(ies)`);
        // ORCH-G — record the confirmation so the capability's health accrues (gate promotion). `confirmed:true`
        // distinguishes a match-confirmation from the DERIVE-time 'accept' so creation doesn't inflate health.
        try { await ctx.appendOutcomes(groundId, [Outcomes.makeStageEvent('accept', { groundId, verdict: 'accepted', outcome: 'success', detail: { capabilityId: cap.id, confirmed: true, phrase: String(phrase).slice(0, 120) } })]); } catch { /* */ }
        Logger.info('background', `ORCH_RECORD_ALIAS — "${_scrubHead(phrase, 40)}" → ${cap.id} (${before}→${cap.aliases.length} alias, +1 confirmation)`);
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
        Logger.info('background', `ORCH_FEEDBACK ▸ ${kind} cap=${String(capabilityId).slice(0, 8)} applied=[${applied.join(',')}] ask="${_scrubHead(ask, 50)}"`);
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
        Logger.info('background', `COMPREHEND_CROSS_GROUND ▸ "${_scrubHead(ask, 60)}" → ${resolved.length} sub-intent(s), ${((built.workflow && built.workflow.steps) || []).length} step(s) across ${((built.workflow && built.workflow.groundIds) || []).length} Ground(s), runnable=${built.runnable}, ${repairs.length} repair(s)${saved ? ', saved' : ''}`);
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
        Logger.info('background', `OBSERVE_CAPTURE — "${_scrubHead(ask, 50)}" ${cap.id} → ${cap.outputType} stored via ${via}: ${chosenArch ? `archetype "${chosenArch.selector}"[${chosenArch.index}]` : `selector "${String(chosenSelector).slice(0, 80)}"`} on ${gid}${antecedentCapabilityId ? ` · antecedent=${antecedentCapabilityId}${antecedentParamBindings ? ` (${Object.keys(antecedentParamBindings).join(',')})` : ''}` : ' · no antecedent inferred'}`);
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
        Logger.info('background', `CAPTURE_VISUAL_OBSERVATION — "${_scrubHead(ask, 50)}" ${cap.id} → ${cap.outputType} (verify count=${inp ? inp.count : '?'}) on ${gid}`);
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

    // IL-3b (v2.74.1131) — LIST_TABS: the ASK×Browser read leg for the inference layer ("what tabs are open?").
    // Read-only → auto. Excludes the extension's OWN pages (Studio / side panel) and non-http(s) tabs so the user
    // sees real web tabs. The loop offers this leg on a page miss (palette ∪ builtins); chat renders the list.
    LIST_TABS: async (_payload, _sender, sendResponse) => {
      try {
        const own = chrome.runtime.getURL('');
        const all = await chrome.tabs.query({});
        const tabs = (all || [])
          .filter((t) => t && typeof t.id === 'number' && t.url && !String(t.url).startsWith(own) && /^https?:/i.test(t.url))
          .map((t) => ({ id: t.id, title: (t.title || '').slice(0, 120), url: t.url, active: !!t.active }));
        Logger.info('background', `LIST_TABS ▸ ${tabs.length} web tab(s)`);
        sendResponse({ success: true, tabs });
      } catch (err) {
        Logger.error('background', `LIST_TABS failed: ${err.message}`);
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
        Logger.info('background', `RUN_BEST_OBSERVATION — "${_scrubHead(ask, 50)}" → manual obs "${best.name}" ${best.id} via ${msg.type} (score ${typeof bestScore === 'number' ? bestScore.toFixed(2) : '1.00'}) → "${value.slice(0, 60)}"`);
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
        Logger.info('background', `ORCH_PLAN ▸ ask="${_scrubHead(ask, 70)}" → ${steps.length} step(s): ${steps.map((s) => `"${s.intent}"${Object.keys(s.bindings).length ? `[${JSON.stringify(s.bindings)}]` : ''}`).join(' → ') || '(none)'}${gaps.length ? ` | uncovered: ${JSON.stringify(gaps)}` : ''}`);
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
        Logger.info('background', `ACCEPT_COMPOUND — "${_scrubHead(ask, 50)}" ${cap.id} → T2 ${isCF ? 'control-flow ' : ''}composite of ${cap.steps.length} step(s) [${cap.steps.map((s) => s.kind || 'action').join(' → ')}]${isCF ? ` intent="${cap.intent}" params=[${(cap.params || []).join(', ')}] → ${cap.output ? `${cap.output.name}:${cap.output.type}` : '?'}` : ''} on ${gid}`);
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
        Logger.info('background', `MATCH_COMPOSITE — T2 cache HIT "${_scrubHead(ask, 50)}" → ${hit.controlFlow ? 'control-flow ' : ''}composite ${hit.id} (${steps.length} step(s))${rebind ? ` REBOUND ${JSON.stringify(rebind)}` : ''}`);
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
        // Leaf resolution (the ONLY I/O the pure promoter needs) — injected so the promoter stays mockable/tested.
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
        const { tabId, groundId = null, capabilityId = null, paramValues = null, ask = null } = payload ?? {};
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
        // IL-2 delegation (v2.74.1117, model a) — Orchard PICKS the capability but does NOT bind its params;
        // bind the ask's VALUES to this cap's REAL schema HERE via the existing binder (bindClauseParams — knows
        // the param names + option/category vocabulary), so the value lands in the right field instead of being
        // guessed. Only when no paramValues were supplied (the deterministic callers pre-bind + pass paramValues).
        let effectiveParamValues = paramValues;
        if ((!effectiveParamValues || !Object.keys(effectiveParamValues).length) && typeof ask === 'string' && ask.trim()) {
          const usedParams = (Array.isArray(cap.params) ? cap.params : []).filter((p) => p && p.name && p.used);
          if (usedParams.length) {
            try {
              const bp = await AnthropicService.bindClauseParams({ clause: ask, params: usedParams });
              if (bp && bp.values && typeof bp.values === 'object') { effectiveParamValues = bp.values; Logger.info('background', `REPLAY delegation bound ${Object.keys(bp.values).length} param(s) from ask "${_scrubHead(ask, 50)}"`); }
            } catch (e) { Logger.warn('background', `REPLAY delegation bind failed: ${e.message}`); }
          }
        }
        const ignoredKeys = [];
        if (effectiveParamValues && typeof effectiveParamValues === 'object') {
          for (const [k, v] of Object.entries(effectiveParamValues)) {
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
        // v2.74.1556 — START-ESTABLISH: a walk is only as reliable as its STARTING state, and the RAW recorded
        // start (hash intact — localeUrl is pageKey-normalized and loses it) is on the record as `startUrl`
        // (stamped at accept, self-stamped below for legacy records). Same site + different page → navigate the
        // tab to the recorded start. For hash routes ("#warranty" → "#dashboard") tabs.update is a SAME-DOCUMENT
        // navigation — no reload (v1555's chat-side root-nav forced a FULL reload to bare "/", a DIFFERENT page
        // than "#dashboard", and broke step 0 — live 180622); a full-path nav polls to complete the same way.
        const _pageHash = (u) => { try { const x = new URL(u); return x.pathname.replace(/\/+$/, '') + x.hash; } catch { return ''; } };
        if (typeof tabId === 'number' && cap.startUrl && liveUrl && _orig(liveUrl) === _orig(cap.startUrl) && _pageHash(liveUrl) !== _pageHash(cap.startUrl)) {
          try {
            Logger.info('background', `REPLAY_SG_CAPABILITY — start-establish: ${_pageHash(liveUrl) || '/'} → ${_pageHash(cap.startUrl) || '/'}`);
            await chrome.tabs.update(tabId, { url: cap.startUrl });
            for (let i = 0; i < 25; i++) { try { const t = await chrome.tabs.get(tabId); if (t && t.status === 'complete') break; } catch { break; } await new Promise((r) => setTimeout(r, 200)); }
            await new Promise((r) => setTimeout(r, 700));   // a hash-route view swap has no load event — give the SPA a beat
          } catch { /* establishment is best-effort — probe-or-recover still owns the steps */ }
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

    // v2.74.1540 — RETIRE the capability a re-teach REPLACED ("show me the right way and I'll replace it" — this is
    // the replace half, previously unhonored). Soft-retract via applyRetraction (restorable in Studio;
    // isActiveCapability hides it from every matcher) — NEVER a hard delete. The caller (chat record flow) knows
    // exactly WHICH capability the fresh demonstration supersedes, so there is no signature guessing — this is what
    // stops re-teach duplicates accumulating (live: three identical "Search ticket by division" walks on one Ground
    // collapsed the match margin to 0.01 → propose/ambiguous on every non-alias phrasing).
    RETIRE_CAPABILITY: async (payload, _sender, sendResponse) => {
      try {
        const { groundId = null, capabilityId = null, reason = '' } = payload ?? {};
        if (!groundId || !capabilityId) { sendResponse({ success: false, error: 'groundId + capabilityId required' }); return; }
        const caps = (await ctx.readSgCapabilities(groundId)) || [];
        const cap = caps.find((c) => c && c.id === capabilityId);
        if (!cap) { sendResponse({ success: true, retired: false, reason: 'not-found' }); return; }
        if (cap.retracted === true) { sendResponse({ success: true, retired: false, reason: 'already-retracted' }); return; }
        await ctx.writeSgCapability(groundId, applyRetraction(cap, { now: Date.now() }));
        Logger.info('background', `LEARNED ▸ retired superseded capability ${String(capabilityId).slice(0, 8)} ("${String(cap.intent || cap.name || '').slice(0, 60)}")${reason ? ` [${reason}]` : ''} — restorable in Studio`);
        sendResponse({ success: true, retired: true });
      } catch (err) {
        Logger.error('background', `RETIRE_CAPABILITY failed: ${err.message}`);
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
