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
import { buildAcceptance, landmarkRefActions, buildLandmarkRecords, buildPerspectiveRecord, buildResultsLandmarkRecord, buildOutcomePerspective, findMatchingPerspective, buildPerspectiveGate, buildDestinationPerspective, pickDestinationLandmark } from '../../Core/accept.js';
import * as CapabilitySynth from '../../Core/capabilitySynth.js';
import { synthesizeTrialOp } from '../../Core/trialSynth.js';
import { coalesce } from '../../Core/observedTrace.js';                 // OBS-3 — derive a capability from a demonstration
import { segmentTrace, opToPhases, deriveObservedParams, parameterizeObserved, describeTraceInput, derivePhasePostcondition, reconcileObservedLandmarks } from '../../Core/observedSegment.js';
import { listLocales } from '../../Services/Storage/GroundAssetStore.js';   // OBS (v2.74.764) — reconcile observed landmarks to grounded Locale features
import { toCandidate, scopeAndPartition, rankAndDecide, scoresToScorer, validateBindings, normalizeAliasPhrase, accreteAlias, removeAlias, tallyCapabilityConfirmations, localeAffordanceLabels } from '../../Core/orchMatch.js';   // ORCH-M0/D/M/G/A
import { planCorrection, applyRetraction, isActiveCapability } from '../../Core/orchFeedback.js';   // ORCH-FB — corrective actions
import { feedbackExamples } from '../../Core/feedbackLearn.js';   // ORCH-FB-2 — relevance shaping from feedback history
import { buildObservationCapability, scoreObservationMatch, classifyReadAsk } from '../../Core/observe.js';   // OBS-READ — observation records + manual-obs match + read/action effect scoping
import { buildCompositeCapability, liftControlFlow, liftConditional } from '../../Core/orchChain.js';   // ORCH-X T2 — composite promotion + ORCH-L control-flow lift + ORCH-A conditional lift
import { bindShape, lexicalScore } from '../../Core/orchBind.js';   // ORCH-CB — per-slot effect-scoped binder (lexical floor)
import { comprehend } from '../../Core/orchComprehend.js';   // ORCH-CB — substrate-free shape comprehension (shadow)
import { shadowCompare } from '../../Core/orchShadow.js';   // ORCH-CB — LLM-plan vs comprehend→bind divergence log
import { performImageFull } from '../../Services/ImageReadCapture.js';   // ORCH-CB — visual observation (screenshot)
import { buildVisualObservation, isVisualObservation, visualToInput, describeForCondition, withCriteria } from '../../Core/orchVisual.js';   // ORCH-CB — visual observation floor
import { buildCompositeTemplate, matchTemplate, rebindSteps } from '../../Core/orchTemplate.js';   // ORCH-X T2 — cross-argument composite rebind
import { validatePlan } from '../../Core/orchPlan.js';   // ORCH-L — structural guard for a lifted (foreach/gate) plan
import { promoteComposite, buildConvergeObservationRecord } from '../../Core/orchPromote.js';   // CONVERGE — T2 composite IR → canonical runnable Strategy (Studio-visible)
import { buildGroundCatalog, resolveGround } from '../../Core/groundCatalog.js';   // T3X-1 — the global Ground catalog + ground resolution (intent → which site)
import { buildWorkflowRecord, wireCrossGroundData } from '../../Core/tier3.js';   // T3X-2 — cross-Ground lowering + the data-flow floor (literals/scopeReads)
import { AnthropicService } from '../../Services/AnthropicService.js';
import { StorageManager } from '../../Services/StorageManager.js';
import { ExecutionEngine } from '../../Services/ExecutionEngine.js';

// T3X-2 — bind a cross-Ground sub-intent to a STRATEGY on its resolved Ground. Reuses the within-Ground matcher
// (toCandidate → rankAndDecide) over that Ground's matcher-store capabilities, scoped to Strategies (a `workflow`
// step dispatches a Strategy by id). Returns { capabilityId, capabilityName, params } or null (a gap). Async I/O
// glue over the tested pure cores (groundCatalog/tier3); not unit-tested (LLM/storage path — verify live).
async function _bindStrategyOnGround(ctx, clause, groundId) {
  let caps = [];
  try { caps = await ctx.readSgCapabilities(groundId); } catch { return null; }
  const candidates = (Array.isArray(caps) ? caps : [])
    .filter((c) => c && c.kind !== 'observation' && c.strategyId)   // a Strategy on this Ground (has a strategyId)
    .map((c) => toCandidate(c));
  if (!candidates.length) return null;
  const decision = rankAndDecide(clause, candidates, { now: Date.now() });
  const cand = decision && decision.candidate;
  if (!cand || decision.decision === 'miss') return null;
  const strategyId = cand.strategyId || cand.id;
  // the Strategy's DECLARED outputs feed downstream scopeReads (the cross-Ground data flow — wireCrossGroundData)
  let outputs = [];
  try { const strat = await StorageManager.getStrategy(strategyId); outputs = (Array.isArray(strat && strat.outputs) ? strat.outputs : []).map((o) => (typeof o === 'string' ? o : (o && o.name))).filter(Boolean); } catch { /* */ }
  return {
    capabilityId: strategyId,
    capabilityName: cand.intent || '',
    params: (cand.params || []).map((p) => (typeof p === 'string' ? p : (p && p.name))).filter(Boolean),
    outputs,
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

/**
 * @param {object} ctx  background-local helpers (kept in background.js — shared with non-SG code, or
 *   chrome.storage-backed SG stores):
 *   { runTrialBundle, readLocaleCache, readSgSpec, normalizeUrl, appendOutcomes, broadcastStorageChanged,
 *     readSgCapabilities, readSgDraft, writeSgDraft, clearSgDraft, writeSgCapability, writeSgTrace,
 *     enrichSgLandmarks }
 * @returns {Record<string, (payload:object, sender:object, sendResponse:Function) => Promise<void>>}
 */
export function createSgMessageHandlers(ctx) {
  return {
    // SG-4b — run the substrate-grounded plan on the live page (Comprehend→Select→Cover→Bind→execute) and
    // stash a session draft so the result can be accepted without re-running.
    RUN_SG_TRIAL: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, intent } = payload ?? {};
        if (!groundId || typeof intent !== 'string' || !intent.trim()) { sendResponse({ success: false, error: 'groundId + intent required' }); return; }
        let url = '';
        if (typeof tabId === 'number') { try { const t = await chrome.tabs.get(tabId); url = t?.url ?? ''; } catch { /* */ } }
        let localeModel = null;
        let localeCapturedUrl = '';
        try { const pm = await ctx.readLocaleCache(groundId, ctx.normalizeUrl(url)); localeModel = pm?.model || null; localeCapturedUrl = pm?.url || pm?.model?.url || ''; } catch { /* */ }
        if (!localeModel || !localeModel.features) { sendResponse({ success: false, error: 'no Locale for this page — run Explore first' }); return; }
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
          if (!spec) { sendResponse({ success: false, error: 'comprehend returned nothing' }); return; }
          selection = await AnthropicService.matchSubGoals({ spec, locale: localeModel });
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
            // TESTING (v2.74.647) — unconditional 4s pause BETWEEN fragments, to isolate settle/hydration
            // timing from a structural cause (e.g. a reCAPTCHA interstitial). If a hard gap makes the filter
            // phases pass, the issue was settle timing; if they still fail, it is NOT timing. Remove once the
            // inter-phase settle is validated.
            if (i > 0) {
              Logger.info('background', `  [tier2:run] testing pause 4000ms before "${node.label}"`);
              await new Promise((r) => setTimeout(r, 4000));
            }
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
        if (!roles.length) { sendResponse({ success: true, ran: false, reason: 'no bindable roles from the selection', cover, intentShape: spec.shape }); return; }
        // Precondition: Comprehend+Select take several seconds of LLM calls, during which the page can
        // navigate away (e.g. an auth redirect to /login). Re-read the live URL and bail with a CLEAR
        // "wrong page" rather than typing the form's selectors into whatever loaded.
        let liveUrl = url;
        if (typeof tabId === 'number') { try { const t2 = await chrome.tabs.get(tabId); liveUrl = t2?.url ?? url; } catch { /* */ } }
        const localeUrl = localeCapturedUrl || '';
        if (localeUrl && ctx.normalizeUrl(liveUrl) !== ctx.normalizeUrl(localeUrl)) {
          Logger.warn('background', `RUN_SG_TRIAL — page drifted to "${liveUrl}" (capability targets "${localeUrl}") — not running`);
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
          const phases = [];
          for (const node of phaseNodes) {
            const synth = synthesizeTrialOp({ groundedIntent: node.label, roles: node.roles, locale: localeModel });
            // Carry the node's postcondition (SG-T2-2 structural ∪ SG-T2-5 LLM) onto the phase so the persisted
            // Fragment keeps its success predicate(s) — previously dropped, leaving every synthesized fragment
            // with empty postconditions.
            if (synth && Array.isArray(synth.actions) && synth.actions.length) phases.push({ label: node.label, actions: synth.actions, postcondition: node.postcondition || null });
          }
          if (!phases.length) { sendResponse({ success: true, accepted: false, reason: 'no runnable phases to promote' }); return; }
          // T1-as-first-class — the shared persist path applies the taxonomy guard (single page-state-bounded phase
          // → a bare Fragment, no Strategy wrapper; ≥2 → a Strategy). Replay runs a bare fragment via the run-time
          // wrapper; listCapabilities surfaces it standalone.
          const persisted = await persistTier1or2(phases, { groundId, name: draft.intent, goal: draft.intent });
          if (!persisted.ok) { sendResponse(persisted.fatal ? { success: false, error: persisted.reason } : { success: true, accepted: false, reason: persisted.reason }); return; }
          const { isSingleT1, strategyId, fragmentIds, fragmentCount } = persisted;
          const capability = {
            id: crypto.randomUUID(), groundId, intent: draft.intent, shape: isSingleT1 ? 'tier1' : 'tier2',
            localeUrl: draft.localeUrl || '',
            ...(isSingleT1 ? { fragmentId: fragmentIds[0] } : { strategyId }), fragmentIds,
            phases: phases.map((p) => p.label),
            binding: [], synthesized: true, createdAt: Date.now(),
            trial: { score: draft.tier2Score?.score ?? null, verdict: draft.tier2Score?.verdict ?? null, trialRef: null },
          };
          await ctx.writeSgCapability(groundId, capability);
          try { await ctx.appendOutcomes(groundId, [Outcomes.makeStageEvent('accept', { groundId, verdict: 'accepted', input: { roleOrIntent: String(draft.intent).slice(0, 120) }, detail: { capabilityId: capability.id, ...(isSingleT1 ? { fragmentId: fragmentIds[0] } : { strategyId }), fragments: fragmentCount, shape: capability.shape, score: capability.trial.score } })]); } catch { /* */ }
          await ctx.clearSgDraft(groundId);
          Logger.info('background', `ACCEPT_SG_TRIAL[${isSingleT1 ? 'tier1' : 'tier2'}] — promoted ${capability.id} → ${isSingleT1 ? `bare Fragment ${fragmentIds[0]} (no Strategy wrapper)` : `strategy ${strategyId} chaining ${fragmentCount} fragment(s)`} [${capability.phases.join(' → ')}]`);
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
        sendResponse({ success: true, accepted: true, capability: built.capability, perspectiveId: built.perspective.id, landmarkCount: savedLm });
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

    // ORCH-M0 — the HIT/MISS bridge: given the user's ask + the live page, decide whether the grounded
    // library already covers it (HIT → the caller REPLAYs that capability) or not (MISS → the caller asks for
    // a demonstration). DECISION-ONLY: it never executes — execution reuses REPLAY_SG_CAPABILITY. The funnel
    // (scope by Ground/Locale → rank → three-way gate w/ reversibility veto) is pure (Core/orchMatch.js); this
    // handler just supplies the live page context + the library. Lexical scorer for now (the LLM select+bind
    // call is ORCH-M); live precondition eval (the runnableHere seam, funnel stage 1) lands with ORCH-M too —
    // here the Locale scope is the executability proxy. See docs/DESIGN_intent_orchestration.md §4.
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
        if (!gid && url) {
          try {
            const origin = new URL(url).origin;
            const grounds = await StorageManager.getAllGrounds();
            const g = (Array.isArray(grounds) ? grounds : []).find((x) => { try { return x && x.url && new URL(x.url).origin === origin; } catch { return false; } });
            gid = g ? g.id : null;
          } catch { /* */ }
        }
        if (!gid) { sendResponse({ success: true, decision: 'miss', reason: 'no-ground', candidate: null, capabilityId: null, bindings: {}, gaps: [], alternatives: [], scoped: { here: 0, reachable: 0, off: 0 }, localeUrl }); return; }
        const caps = await ctx.readSgCapabilities(gid);
        // ORCH — a capability whose backing Strategy was deleted is an ORPHAN: it must be INVISIBLE to the
        // conversation (deletion is an implementation detail — the ask is just a fresh request). Build the set of
        // live Strategy ids once and exclude any capability that points at a missing one. Non-destructive (the
        // admin delete + REPLAY self-heal handle storage cleanup); only skipped when the read fails (liveIds=null
        // → no filtering, never a false mass-hide). An observation capability has no strategyId → always kept.
        let liveStrategyIds = null;
        try { liveStrategyIds = new Set((await StorageManager.listStrategies(gid)).map((s) => s && s.id).filter(Boolean)); } catch { /* read failed → don't filter */ }
        const _orphan = (c) => !!(c && c.strategyId && liveStrategyIds && !liveStrategyIds.has(c.strategyId));
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
        const aliasHit = candidates.some((c) => (c.aliases || []).some((al) => normalizeAliasPhrase(al) === normalizeAliasPhrase(ask)));
        if (candidates.length && !aliasHit) {
          try { llm = await AnthropicService.matchCapability({ ask, candidates, affordances, examples: feedback }); } catch { /* */ }
          if (llm) scorer = scoresToScorer(llm.scores);
        }
        const decision = rankAndDecide(ask, candidates, { ...(scorer ? { score: scorer } : {}), now: Date.now(), feedback });
        // ORCH-M/A — validate the LLM's option bindings against the candidate's captured vocabulary OR a label
        // the LIVE PAGE catalogs (affordances): in-set values snap + return as `bindings`; misses → `gaps`.
        let bindings = {}; let gaps = [];
        if (decision.candidate && llm && llm.bindings) { const v = validateBindings(llm.bindings, decision.candidate, affordances); bindings = v.bound; gaps = v.gaps; }
        const lean = (c) => (c ? { id: c.id, intent: c.intent, strategyId: c.strategyId, reversible: c.reversible, params: c.params, kind: c.kind } : null);
        // reachable folded into here → the chat never says "go to another page" (planAssistantTurn keys navigate off reachable>0).
        const scoped = { here: candidates.length, reachable: 0, off: parts.off.length };
        const via = llm ? 'llm' : (aliasHit ? 'alias' : 'lexical');
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
          alternatives: (decision.alternatives || []).map((a) => ({ id: a.id, intent: a.intent })),
          scoped, localeUrl,
        });
      } catch (err) {
        Logger.error('background', `ORCH_MATCH failed: ${err.message}`);
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
        const cap = (await ctx.readSgCapabilities(groundId)).find((c) => c.id === capabilityId);
        if (!cap) { sendResponse({ success: false, error: 'capability not found' }); return; }
        const all = await ctx.readSgCapabilities(groundId);
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
        const want = (Array.isArray(kinds) ? kinds : []).filter((k) => CAP_PRED[k] || TIER1[k]);
        if (!want.length) { sendResponse({ success: false, error: 'no valid kinds' }); return; }
        // Resolve target Ground(s): all grounds, or the one for the active tab's origin.
        const allGrounds = (await StorageManager.getAllGrounds()) || [];
        let grounds = [];
        if (scope === 'all') grounds = allGrounds.map((g) => g.id).filter(Boolean);
        else {
          let gid = groundId;
          if (!gid && typeof tabId === 'number') {
            try { const t = await chrome.tabs.get(tabId); const origin = new URL(t.url).origin; const g = allGrounds.find((x) => { try { return x && x.url && new URL(x.url).origin === origin; } catch { return false; } }); gid = g ? g.id : null; } catch { /* */ }
          }
          if (gid) grounds = [gid];
        }
        if (!grounds.length) { sendResponse({ success: true, op, counts: {}, total: 0, grounds: 0, scope }); return; }
        const counts = {}; let total = 0;
        for (const k of want) {
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
                for (const c of mine) {
                  try {
                    if (k === 'observations') {
                      await StorageManager.deleteObservation(c.strategyId || c.id);
                    } else {
                      // strategy OR bare-fragment cap: delete its backing Strategy (if any) + SWEEP its Fragment(s)
                      // so none orphan into a phantom standalone capability (listCapabilities would surface it).
                      if (c.strategyId) { try { await StorageManager.deleteStrategy(c.strategyId); } catch { /* */ } }
                      const fids = new Set([c.fragmentId, ...(Array.isArray(c.fragmentIds) ? c.fragmentIds : [])].filter(Boolean));
                      for (const fid of fids) { try { await StorageManager.deleteFragment(fid); } catch { /* */ } }
                    }
                  } catch (e) { Logger.warn('background', `ORCH_ADMIN delete (${k}) failed: ${e.message}`); }
                }
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
        Logger.info('background', `ORCH_ADMIN ▸ ${op} kinds=[${want.join(',')}] scope=${scope} grounds=${grounds.length} counts=${JSON.stringify(counts)}`);
        sendResponse({ success: true, op, counts, total, grounds: grounds.length, scope });
      } catch (err) {
        Logger.error('background', `ORCH_ADMIN failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // T3X — CROSS-GROUND COMPREHENSION. The recursion one tier up (docs/DESIGN_t3_cross_ground.md): decompose a
    // cross-Ground ask into sub-intents (the SAME page-independent comprehendIntent — "intents all the way down"),
    // resolve which Ground each runs on (T3X-1 ground catalog), bind a Strategy on it (the existing matcher), and
    // lower the result into a runnable WORKFLOW that composes those Strategies (T3X-2). The Workflow runs on the
    // existing runtime — executeStrategy opens each step's Ground tab, data flows via workflowScope. Read-only
    // unless save:true (the chat reviews first). Integration glue over the unit-tested pure cores — verify live.
    COMPREHEND_CROSS_GROUND: async (payload, _sender, sendResponse) => {
      try {
        const { ask = '', save = false } = payload ?? {};
        if (!String(ask).trim()) { sendResponse({ success: false, error: 'empty ask' }); return; }

        // 1. The global Ground catalog — every Ground + its Strategies' goal labels (the T3X-1 substrate).
        const grounds = (await StorageManager.getAllGrounds()) || [];
        if (!grounds.length) { sendResponse({ success: false, error: 'no Grounds to compose across' }); return; }
        const capLabelsByGround = {};
        for (const g of grounds) {
          const gid = g && (g.id || g.groundId); if (!gid) continue;
          try { const strs = await StorageManager.listStrategies(gid); capLabelsByGround[gid] = (Array.isArray(strs) ? strs : []).map((s) => (s && (s.name || s.goal)) || '').filter(Boolean); } catch { /* */ }
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

        // 3. Per sub-intent (IN ORDER): resolve its Ground (T3X-1) + bind a Strategy (with its declared outputs).
        const resolved = [];
        const ambiguities = [];
        for (let i = 0; i < ordered.length; i++) {
          const si = ordered[i] || {};
          const clause = si.clause || si.label || ask;
          const gr = resolveGround(clause, catalog);
          if (gr.decision === 'ambiguous') ambiguities.push({ subIntentId: si.id || `s${i}`, clause, candidates: gr.candidates });
          const groundId = gr.groundId || null;
          const g = groundId ? byId.get(groundId) : null;
          const bound = groundId ? await _bindStrategyOnGround(ctx, clause, groundId) : null;
          resolved.push({
            id: si.id || `s${i}`, clause, groundId,
            groundUrl: g ? (g.url || (Array.isArray(g.urlPatterns) ? g.urlPatterns[0] : null)) : null,
            capabilityId: bound ? bound.capabilityId : null,
            capabilityName: bound ? bound.capabilityName : '',
            params: bound ? bound.params : [],
            outputs: bound ? bound.outputs : [],
            dependsOn: Array.isArray(si.dependsOn) ? si.dependsOn : [],
            stated: (si.stated && typeof si.stated === 'object') ? si.stated : {},
          });
        }

        // 4. Wire the cross-Ground DATA FLOW (literals ← stated; scopeReads ← upstream outputs), then lower (T3X-2).
        wireCrossGroundData(resolved);
        const wfId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const built = buildWorkflowRecord({ id: wfId, intent: ask, name: String(ask).slice(0, 60), resolved });

        // 5. Save only when asked AND fully runnable (the chat freezes a reviewed Workflow).
        let saved = false;
        if (save && built.workflow && built.runnable) {
          try { await StorageManager.saveWorkflow(built.workflow); saved = true; } catch (e) { Logger.warn('background', `COMPREHEND_CROSS_GROUND save failed: ${e.message}`); }
        }
        Logger.info('background', `COMPREHEND_CROSS_GROUND ▸ "${String(ask).slice(0, 60)}" → ${resolved.length} sub-intent(s), ${((built.workflow && built.workflow.steps) || []).length} step(s) across ${((built.workflow && built.workflow.groundIds) || []).length} Ground(s), runnable=${built.runnable}${saved ? ', saved' : ''}`);
        sendResponse({ success: true, workflow: built.workflow, runnable: built.runnable, gaps: built.gaps, resolved, ambiguities, saved });
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
        if (typeof tabId === 'number') { try { const t = await chrome.tabs.get(tabId); localeUrl = t?.url || ''; if (!gid && localeUrl) { const origin = new URL(localeUrl).origin; const gs = await StorageManager.getAllGrounds(); const g = (Array.isArray(gs) ? gs : []).find((x) => { try { return x && x.url && new URL(x.url).origin === origin; } catch { return false; } }); gid = g ? g.id : null; } } catch { /* */ } }
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
        const cap = buildObservationCapability({
          id: crypto.randomUUID(), ask, intent: ask, goal: ask, groundId: gid, outputType,
          landmark: lmk,
          extract: { selector: chosenSelector, ...(shape ? { shape } : {}), ...(chosenArch ? { archetype: chosenArch } : {}) },
        });
        cap.localeUrl = localeUrl; cap.createdAt = Date.now();
        cap.aliases = accreteAlias(cap.aliases, ask, { intent: cap.intent });
        await ctx.writeSgCapability(gid, cap);
        try { await ctx.appendOutcomes(gid, [Outcomes.makeStageEvent('accept', { groundId: gid, verdict: 'accepted', input: { roleOrIntent: ask.slice(0, 120) }, detail: { capabilityId: cap.id, shape: 'observation', outputType: cap.outputType, selector: chosenSelector } })]); } catch { /* */ }
        Logger.info('background', `OBSERVE_CAPTURE — "${ask.slice(0, 50)}" ${cap.id} → ${cap.outputType} stored via ${via}: ${chosenArch ? `archetype "${chosenArch.selector}"[${chosenArch.index}]` : `selector "${String(chosenSelector).slice(0, 80)}"`} on ${gid}`);
        sendResponse({ success: true, capability: { id: cap.id, intent: cap.intent, outputType: cap.outputType, kind: 'observation' }, sawText: String(label || ''), verifiedValue, via });
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
            : { type: 'OBSERVE_RAW_TEXT', payload: { target: selector } };
          try { chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (x) => { void chrome.runtime.lastError; r(x); }); }
          catch (e) { r({ success: false, error: e.message }); }
        }).then((x) => (x && x.success !== false)
          ? { success: true, extractedValue: (x.extractedValue != null ? x.extractedValue : x.value) }
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
        if (!res || res.success === false) res = await _read(ex.selector);
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
        try { const t = await chrome.tabs.get(tabId); localeUrl = t?.url || ''; if (!gid && localeUrl) { const origin = new URL(localeUrl).origin; const gs = await StorageManager.getAllGrounds(); const g = (Array.isArray(gs) ? gs : []).find((x) => { try { return x && x.url && new URL(x.url).origin === origin; } catch { return false; } }); gid = g ? g.id : null; } } catch { /* */ }
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
        const res = await new Promise((r) => { try { chrome.tabs.sendMessage(tabId, { type: 'COUNT_ELEMENTS', payload: { selector, max, withSelectors: true } }, { frameId: 0 }, (x) => { void chrome.runtime.lastError; r(x); }); } catch (e) { r({ success: false, error: e.message }); } });
        const count = (res && res.success !== false && Number.isFinite(res.count)) ? Math.min(res.count, max) : 0;
        const sels = (res && Array.isArray(res.selectors)) ? res.selectors : [];
        const items = Array.from({ length: count }, (_, i) => ({ index: i, selector: sels[i] || null }));
        Logger.info('background', `RUN_OBSERVATION_LIST — ${cap.id} "${selector}" → ${count} item(s)${sels.length ? ' (+selectors)' : ''}`);
        sendResponse({ success: true, ok: count > 0, count, items, intent: cap.intent });
      } catch (err) {
        Logger.error('background', `RUN_OBSERVATION_LIST failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
    },

    // ORCH-L — CLICK a specific selector: the per-item action of a click-in-place FOREACH (click item[i] → a
    // detail panel updates → the body re-reads it). Reuses the content-script CLICK; settle is the caller's job.
    CLICK_SELECTOR: async (payload, _sender, sendResponse) => {
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
        if (!gid && url) { try { const origin = new URL(url).origin; const gs = await StorageManager.getAllGrounds(); const g = (Array.isArray(gs) ? gs : []).find((x) => { try { return x && x.url && new URL(x.url).origin === origin; } catch { return false; } }); gid = g ? g.id : null; } catch { /* */ } }
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
        if (!gid && url) { try { const origin = new URL(url).origin; const grounds = await StorageManager.getAllGrounds(); const g = (Array.isArray(grounds) ? grounds : []).find((x) => { try { return x && x.url && new URL(x.url).origin === origin; } catch { return false; } }); gid = g ? g.id : null; } catch { /* */ } }
        if (!gid) { sendResponse({ success: true, groundId: null, steps: [] }); return; }
        const localeUrl = ctx.normalizeUrl(url);
        let liveStrategyIds = null;
        try { liveStrategyIds = new Set((await StorageManager.listStrategies(gid)).map((s) => s && s.id).filter(Boolean)); } catch { /* */ }
        const _orphan = (c) => !!(c && c.strategyId && liveStrategyIds && !liveStrategyIds.has(c.strategyId));
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
            if (v.ok) { outSteps = lift.steps; Logger.info('background', `ORCH_PLAN ▸ lifted to control-flow: foreach over the list${lift.collect ? ` → collect ${lift.collect}` : ''}`); }
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
        if (!gid && url) { try { const origin = new URL(url).origin; const gs = await StorageManager.getAllGrounds(); const g = (Array.isArray(gs) ? gs : []).find((x) => { try { return x && x.url && new URL(x.url).origin === origin; } catch { return false; } }); gid = g ? g.id : null; } catch { /* */ } }
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
        if (typeof tabId === 'number') { try { const t = await chrome.tabs.get(tabId); localeUrl = t?.url || ''; if (!gid && localeUrl) { const origin = new URL(localeUrl).origin; const gs = await StorageManager.getAllGrounds(); const g = (Array.isArray(gs) ? gs : []).find((x) => { try { return x && x.url && new URL(x.url).origin === origin; } catch { return false; } }); gid = g ? g.id : null; } } catch { /* */ } }
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
        if (!gid && url) { try { const origin = new URL(url).origin; const gs = await StorageManager.getAllGrounds(); const g = (Array.isArray(gs) ? gs : []).find((x) => { try { return x && x.url && new URL(x.url).origin === origin; } catch { return false; } }); gid = g ? g.id : null; } catch { /* */ } }
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
        if (!gid && url) { try { const origin = new URL(url).origin; const gs = await StorageManager.getAllGrounds(); const g = (Array.isArray(gs) ? gs : []).find((x) => { try { return x && x.url && new URL(x.url).origin === origin; } catch { return false; } }); gid = g ? g.id : null; } catch { /* */ } }
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
      try {
        const { tabId, groundId = null, capabilityId = null, paramValues = null } = payload ?? {};
        if (!groundId || !capabilityId) { sendResponse({ success: false, error: 'groundId + capabilityId required' }); return; }
        const cap = (await ctx.readSgCapabilities(groundId)).find((c) => c.id === capabilityId);
        if (!cap) { sendResponse({ success: false, error: 'capability not found' }); return; }
        // OBS-4b — an observed capability is parameterized: seed EVERY templated param with its demonstrated
        // default, then overlay user-supplied NEW values. Always seeding defaults is REQUIRED — executeStrategy
        // does NOT auto-apply param defaults, so an unseeded `{{NAME}}` would type/route the literal placeholder.
        const strategyParamValues = {};
        for (const p of (Array.isArray(cap.params) ? cap.params : [])) {
          if (p && p.name && p.used) strategyParamValues[p.name] = p.value != null ? String(p.value) : '';
        }
        if (paramValues && typeof paramValues === 'object') {
          for (const [k, v] of Object.entries(paramValues)) if (k && strategyParamValues[k] !== undefined) strategyParamValues[k] = String(v ?? '');
        }
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
          Logger.info('background', `REPLAY_SG_CAPABILITY — ${cap.id} via saved strategy ${cap.strategyId} → ${ok ? 'ok' : 'failed'} (NO LLM, landmark recovery${pv.length ? `, params: ${pv.join(', ')}` : ''})`);
          sendResponse({ success: true, ran: true, replayed: true, via: 'strategy', capabilityId: cap.id, ok, reason: ok ? undefined : (result?.error || 'a step failed') });
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
            Logger.info('background', `REPLAY_SG_CAPABILITY — ${cap.id} via bare FRAGMENT ${cap.fragmentId} (T1, wrapped at run time, NO LLM)`);
            sendResponse({ success: true, ran: true, replayed: true, via: 'fragment', capabilityId: cap.id, ok, reason: ok ? undefined : (result?.error || 'a step failed') });
            return;
          }
        }
        // Fallback (pre-LM-5 capability): re-synth from the lean binding (still landmark-backed via LM-3).
        const roles = Array.isArray(cap.binding) ? cap.binding : [];
        if (!roles.length) { sendResponse({ success: true, ran: false, reason: 'capability has no saved strategy or binding' }); return; }
        let localeModel = null;
        try { const pm = await ctx.readLocaleCache(groundId, ctx.normalizeUrl(cap.localeUrl || liveUrl)); localeModel = pm?.model || null; } catch { /* */ }
        Logger.info('background', `REPLAY_SG_CAPABILITY — ${cap.id} via binding fallback (${roles.length} role(s), NO LLM)`);
        const out = await ctx.runTrialBundle({ groundId, intent: cap.intent, roles, localeModel, navigateUrl: null, proposedRoleCount: roles.length, targetTabId: (typeof tabId === 'number' ? tabId : null) });
        sendResponse({ ...out, replayed: true, via: 'binding', capabilityId: cap.id });
      } catch (err) {
        Logger.error('background', `REPLAY_SG_CAPABILITY failed: ${err.message}`);
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
