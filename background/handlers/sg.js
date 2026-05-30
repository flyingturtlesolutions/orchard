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
import { lowerToTier2 } from '../../Core/tier2Lower.js';
import { buildAcceptance, landmarkRefActions } from '../../Core/accept.js';
import * as CapabilitySynth from '../../Core/capabilitySynth.js';
import { AnthropicService } from '../../Services/AnthropicService.js';
import { StorageManager } from '../../Services/StorageManager.js';
import { ExecutionEngine } from '../../Services/ExecutionEngine.js';

/**
 * @param {object} ctx  background-local helpers (kept in background.js — shared with non-SG code, or
 *   chrome.storage-backed SG stores):
 *   { runTrialBundle, readLocaleCache, normalizeUrl, appendOutcomes, broadcastStorageChanged,
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
        const spec = await AnthropicService.comprehendIntent({ userIntent: intent });
        if (!spec) { sendResponse({ success: false, error: 'comprehend returned nothing' }); return; }
        const selection = await AnthropicService.matchSubGoals({ spec, locale: localeModel });
        // SG-T2-6 — OPT-IN Tier-2 lowering. When the caller passes tier2:true, lower the subGoal program
        // into a multi-phase Tier-2 operation (fragment/observation/analysis/navigate/wait nodes) and
        // return it for inspection. The default (flat single-fragment) trial path below is untouched; the
        // multi-fragment EXECUTION + accept/replay wiring lands in a follow-up (verified live).
        if (payload && payload.tier2 === true) {
          const op = lowerToTier2(spec, selection, localeModel);
          Logger.info('background', `RUN_SG_TRIAL[tier2] — intent="${intent.slice(0, 60)}" shape=${spec.shape} nodes=${op.nodes.length} [${op.nodes.map((n) => n.type).join(' → ')}]`);
          sendResponse({ success: true, ran: false, tier2: op, intentShape: spec.shape, reason: `tier-2 plan: ${op.nodes.length} phase node(s) — multi-phase execution wiring pending` });
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

    // SG-5 / PB-7 — REPLAY an accepted capability. NO LLM. Prefer the promoted landmark-backed Strategy
    // (registry recovery via applyLandmarkRefToStep → LANDMARK_PROBE_OR_RECOVER); fall back to the binding.
    REPLAY_SG_CAPABILITY: async (payload, _sender, sendResponse) => {
      try {
        const { tabId, groundId = null, capabilityId = null } = payload ?? {};
        if (!groundId || !capabilityId) { sendResponse({ success: false, error: 'groundId + capabilityId required' }); return; }
        const cap = (await ctx.readSgCapabilities(groundId)).find((c) => c.id === capabilityId);
        if (!cap) { sendResponse({ success: false, error: 'capability not found' }); return; }
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
          try { result = await ExecutionEngine.executeStrategy({ strategyId: cap.strategyId, targetTabId: (typeof tabId === 'number' ? tabId : null) }); }
          catch (e) { sendResponse({ success: false, error: `replay strategy failed: ${e.message}` }); return; }
          const ok = !!(result && result.success);
          Logger.info('background', `REPLAY_SG_CAPABILITY — ${cap.id} via saved strategy ${cap.strategyId} → ${ok ? 'ok' : 'failed'} (NO LLM, landmark recovery)`);
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
