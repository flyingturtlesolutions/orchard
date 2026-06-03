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
import { lowerToTier2, orderForRun, scoreTier2 } from '../../Core/tier2Lower.js';
import { evaluatePostcondition } from '../../Core/postcondition.js';
import { buildAcceptance, landmarkRefActions, buildLandmarkRecords, buildPerspectiveRecord } from '../../Core/accept.js';
import * as CapabilitySynth from '../../Core/capabilitySynth.js';
import { synthesizeTrialOp } from '../../Core/trialSynth.js';
import { coalesce } from '../../Core/observedTrace.js';                 // OBS-3 — derive a capability from a demonstration
import { segmentTrace, opToPhases, deriveObservedParams, parameterizeObserved } from '../../Core/observedSegment.js';
import { matchAsk } from '../../Core/orchMatch.js';                      // ORCH-M0 — HIT/MISS matcher core
import { AnthropicService } from '../../Services/AnthropicService.js';
import { StorageManager } from '../../Services/StorageManager.js';
import { ExecutionEngine } from '../../Services/ExecutionEngine.js';

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
            if (synth && Array.isArray(synth.actions) && synth.actions.length) phases.push({ label: node.label, actions: synth.actions });
          }
          if (!phases.length) { sendResponse({ success: true, accepted: false, reason: 'no runnable phases to promote' }); return; }
          const strategyId = crypto.randomUUID();
          const fragmentIds = phases.map(() => crypto.randomUUID());
          const recs = CapabilitySynth.buildTier2CapabilityRecords(phases, { groundId, strategyId, fragmentIds, name: draft.intent, goal: draft.intent });
          if (!recs) { sendResponse({ success: true, accepted: false, reason: 'could not assemble tier-2 capability records' }); return; }
          for (const f of recs.fragments) { try { await StorageManager.saveFragment(f); } catch (e) { Logger.warn('background', `ACCEPT_SG_TRIAL[tier2] saveFragment failed: ${e.message}`); } }
          try { await StorageManager.saveStrategy(recs.strategy); }
          catch (e) { Logger.error('background', `ACCEPT_SG_TRIAL[tier2] saveStrategy failed: ${e.message}`); sendResponse({ success: false, error: `strategy save failed: ${e.message}` }); return; }
          const capability = {
            id: crypto.randomUUID(), groundId, intent: draft.intent, shape: 'tier2',
            localeUrl: draft.localeUrl || '', strategyId, fragmentIds, phases: phases.map((p) => p.label),
            binding: [], synthesized: true, createdAt: Date.now(),
            trial: { score: draft.tier2Score?.score ?? null, verdict: draft.tier2Score?.verdict ?? null, trialRef: null },
          };
          await ctx.writeSgCapability(groundId, capability);
          try { await ctx.appendOutcomes(groundId, [Outcomes.makeStageEvent('accept', { groundId, verdict: 'accepted', input: { roleOrIntent: String(draft.intent).slice(0, 120) }, detail: { capabilityId: capability.id, strategyId, fragments: recs.fragments.length, shape: 'tier2', score: capability.trial.score } })]); } catch { /* */ }
          await ctx.clearSgDraft(groundId);
          Logger.info('background', `ACCEPT_SG_TRIAL[tier2] — promoted ${capability.id} → strategy ${strategyId} chaining ${recs.fragments.length} fragment(s) [${capability.phases.join(' → ')}]`);
          sendResponse({ success: true, accepted: true, capability, fragmentCount: recs.fragments.length, tier2: true });
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
            const recs = CapabilitySynth.buildCapabilityRecords({ ...dr, actions: steps, name: built.perspective.name }, { groundId, fragmentId, strategyId });
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
        const params = deriveObservedParams(op);   // OBS-4 — reusable param schema (typed fields + option choices)
        // OBS-3b — DERIVE DURABLE LANDMARKS from the demonstrated elements (your step 3): each step carries an
        // inline landmark (role + accessibleName + hierarchicalContext + selector); mint a per-Ground Landmark
        // record per unique identity and convert every step to a `landmarkRef` so the capability is
        // landmark-backed (registry recovery), NOT raw selectors — same shape the NL-path ACCEPT produces.
        // Per-page UIDs (mintLandmarkUid uses the phase's url), since a demonstration spans pages.
        const landmarkRecords = []; const seenUid = new Set();
        const phases = phasesRaw.map((p) => {
          const rolesLike = p.actions.filter((a) => a.landmark).map((a) => ({ role: a.landmark.accessibleName, landmark: a.landmark }));
          const profBySel = new Map();   // selector → the record-time profile captured by the recorder
          for (const a of p.actions) if (a.landmark && a.landmark.selector) profBySel.set(a.landmark.selector, a.landmark);
          for (const { uid, record } of buildLandmarkRecords({ roles: rolesLike, groundId, localeUrl: p.url })) {
            if (seenUid.has(uid)) continue;
            seenUid.add(uid);
            // OBS-3b/#3 — populate the record from the record-time identity (the demo can't be re-profiled).
            const lm = profBySel.get(record.selector);
            if (lm) { record.boundingBox = lm.rect || null; record.textContent = lm.text || null; record.attributes = lm.attrs || null; }
            // OBS-#2 — the DEMONSTRATION is the verification: the user used this exact element successfully.
            record.lifecycle = 'verified'; record.verifiedBy = 'demonstration'; record.verifiedAt = Date.now(); record.source = 'observed';
            landmarkRecords.push(record);
          }
          return { label: p.label, actions: landmarkRefActions(p.actions, groundId, p.url) };
        });
        for (const rec of landmarkRecords) { try { await StorageManager.saveLandmark(rec); } catch (e) { Logger.warn('background', `DERIVE_OBSERVED saveLandmark failed: ${e.message}`); } }
        // OBS-4 — LLM name/intent (inverse of comprehend), heuristic fallback so it never blocks on the LLM.
        let described = null;
        if (!(name && name.trim())) {
          const summary = op.nodes.filter((n) => n && n.type === 'fragment').map((n, i) => `Phase ${i + 1} (${n.label}): ` + (Array.isArray(n.steps) ? n.steps : []).map((s) => `${s.kind} ${(s.target && (s.target.accessibleName || s.target.selector)) || ''}${s.value ? `="${String(s.value).slice(0, 40)}"` : ''}`).join('; ')).join('\n');
          try { described = await AnthropicService.describeTrace({ summary }); } catch { /* */ }
        }
        const capName = ((name && name.trim()) || (described && described.name) || `Recorded: ${phases.map((p) => p.label).join(' → ')}`).slice(0, 80);
        const capDescription = (described && described.intent) || capName;
        const localeUrl = (trace.find((a) => a && a.url) || {}).url || '';
        // OBS-3c — compose the derived landmarks into a PERSPECTIVE (your step 4 — the intent-scoped grouping
        // the library shows), authoredBy:'model', exactly like the NL-path ACCEPT. The capability links it.
        const perspective = buildPerspectiveRecord({ intent: capName, spec: { shape: 'observed', target: capName }, groundId, localeUrl, landmarkUids: [...seenUid] });
        try { await StorageManager.savePerspective(perspective); } catch (e) { Logger.warn('background', `DERIVE_OBSERVED savePerspective failed: ${e.message}`); }
        // OBS-4b — PARAMETERIZE: rewrite each demonstrated text input to a `{{NAME}}` placeholder so the
        // capability re-runs with NEW values. The demonstrated value rides along as the param's default, so a
        // no-override replay reproduces the demo. (Option choices stay literal in v1 — find-by-label = OBS-4c.)
        const paramz = parameterizeObserved(phases, params);
        const runPhases = paramz.phases;
        const namedParams = paramz.params;
        const strategyId = crypto.randomUUID();
        const fragmentIds = runPhases.map(() => crypto.randomUUID());
        const recs = CapabilitySynth.buildTier2CapabilityRecords(runPhases, { groundId, strategyId, fragmentIds, name: capName, goal: capName, params: namedParams });
        if (!recs) { sendResponse({ success: false, error: 'could not assemble capability records' }); return; }
        for (const f of recs.fragments) { try { await StorageManager.saveFragment(f); } catch (e) { Logger.warn('background', `DERIVE_OBSERVED saveFragment failed: ${e.message}`); } }
        try { await StorageManager.saveStrategy(recs.strategy); }
        catch (e) { Logger.error('background', `DERIVE_OBSERVED saveStrategy failed: ${e.message}`); sendResponse({ success: false, error: `strategy save failed: ${e.message}` }); return; }
        const capability = {
          id: crypto.randomUUID(), groundId, intent: capName, description: capDescription, shape: 'observed', source: 'observed',
          localeUrl, perspectiveId: perspective.id, strategyId, fragmentIds, landmarkUids: [...seenUid], params: namedParams, phases: phases.map((p) => p.label), binding: [], synthesized: true,
          createdAt: Date.now(), trial: { score: null, verdict: 'observed', trialRef: null },
        };
        await ctx.writeSgCapability(groundId, capability);
        try { await ctx.appendOutcomes(groundId, [Outcomes.makeStageEvent('accept', { groundId, verdict: 'accepted', input: { roleOrIntent: capName.slice(0, 120) }, detail: { capabilityId: capability.id, perspectiveId: perspective.id, strategyId, fragments: recs.fragments.length, landmarks: landmarkRecords.length, shape: 'observed' } })]); } catch { /* */ }
        try { await ctx.broadcastStorageChanged('perspective', perspective.id, 'saved'); } catch { /* */ }
        const tmplCount = namedParams.filter((p) => p.used).length;
        Logger.info('background', `DERIVE_OBSERVED_CAPABILITY — "${capName}" ${capability.id} → perspective ${perspective.id} + strategy ${strategyId} chaining ${recs.fragments.length} fragment(s) + ${landmarkRecords.length} landmark(s) + ${namedParams.length} param(s) (${tmplCount} templated for re-run) [${capability.phases.join(' → ')}]`);
        sendResponse({ success: true, capability, perspectiveId: perspective.id, fragmentCount: recs.fragments.length, landmarkCount: landmarkRecords.length, paramCount: namedParams.length });
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
        if (!groundId || typeof ask !== 'string' || !ask.trim()) { sendResponse({ success: false, error: 'groundId + ask required' }); return; }
        let url = '';
        if (typeof tabId === 'number') { try { const t = await chrome.tabs.get(tabId); url = t?.url ?? ''; } catch { /* */ } }
        const localeUrl = ctx.normalizeUrl(url);
        const caps = await ctx.readSgCapabilities(groundId);
        const result = matchAsk(ask, Array.isArray(caps) ? caps : [], {
          currentGroundId: groundId,
          currentLocaleUrl: localeUrl,
          sameLocale: (a, b) => ctx.normalizeUrl(a) === ctx.normalizeUrl(b),
        });
        const lean = (c) => (c ? { id: c.id, intent: c.intent, strategyId: c.strategyId, reversible: c.reversible, params: c.params } : null);
        Logger.info('background', `ORCH_MATCH — "${String(ask).slice(0, 60)}" @ ${localeUrl || '(no url)'} → ${result.decision}/${result.reason}${result.candidate ? ` (${result.candidate.id})` : ''} [here ${result.scoped.here}, reachable ${result.scoped.reachable}, off ${result.scoped.off}]`);
        sendResponse({
          success: true,
          decision: result.decision,            // 'auto' | 'propose' | 'miss'
          reason: result.reason,                // doubles as the assistant's explanation copy
          candidate: lean(result.candidate),
          capabilityId: result.candidate ? result.candidate.id : null,
          alternatives: (result.alternatives || []).map((a) => ({ id: a.id, intent: a.intent })),
          scoped: result.scoped,
          localeUrl,
        });
      } catch (err) {
        Logger.error('background', `ORCH_MATCH failed: ${err.message}`);
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
        // Page-drift guard — replay binds the capability's page; refuse to run on whatever else loaded.
        if (cap.localeUrl && liveUrl && ctx.normalizeUrl(liveUrl) !== ctx.normalizeUrl(cap.localeUrl)) {
          sendResponse({ success: true, ran: false, reason: `the page is now "${String(liveUrl).slice(0, 80)}" but this capability targets "${String(cap.localeUrl).slice(0, 80)}" — navigate there and re-run` });
          return;
        }
        // Preferred: run the saved, landmark-backed Strategy (the promoted library entity).
        if (cap.strategyId) {
          let result = null;
          try { result = await ExecutionEngine.executeStrategy({ strategyId: cap.strategyId, strategyParamValues, targetTabId: (typeof tabId === 'number' ? tabId : null) }); }
          catch (e) { sendResponse({ success: false, error: `replay strategy failed: ${e.message}` }); return; }
          const ok = !!(result && result.success);
          const pv = Object.keys(strategyParamValues);
          Logger.info('background', `REPLAY_SG_CAPABILITY — ${cap.id} via saved strategy ${cap.strategyId} → ${ok ? 'ok' : 'failed'} (NO LLM, landmark recovery${pv.length ? `, params: ${pv.join(', ')}` : ''})`);
          sendResponse({ success: true, ran: true, replayed: true, via: 'strategy', capabilityId: cap.id, ok, reason: ok ? undefined : (result?.error || 'a step failed') });
          return;
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
