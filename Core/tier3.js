// Core/tier3.js — T3X-2: cross-Ground comprehension → a runnable WORKFLOW record. PURE.
//
// The recursion, one tier up ("intents all the way down"). A Strategy decomposes an intent into sub-goals that
// bind to Fragments and LOWERS them into a Strategy tree (capabilitySynth.buildTier2CapabilityRecords). A WORKFLOW
// decomposes a cross-Ground intent into sub-intents that bind to STRATEGIES (one per Ground) and lowers them into
// a Workflow `steps` tree. This module is the T3 analog of buildTier2CapabilityRecords: given RESOLVED sub-intents
// (each already bound to a Strategy on a Ground — ground resolution = T3X-1, binding = the matcher), it emits the
// runnable Workflow record.
//
// Each step carries its Ground (id + entry url) so the executor can HOP Grounds before running the Strategy
// (T3X-3). Data flows step→step by NAME via `scope_binding` over the executor's `workflowScope` — the walking-
// skeleton handoff; typed cross-schema mapping is T3X-4. PURE — no DOM / chrome / storage / LLM.
//
// @module Core/tier3
// @version 2.74.779

// The executor's Strategy-invocation step kind. NB: WorkflowExecutor names it 'workflow' for legacy storage
// reasons, but it DISPATCHES a Tier-2 Strategy (see docs/TIER_MODEL.md — the inner 'workflow' step = a Strategy).
const STRATEGY_STEP = 'workflow';

/**
 * Build the paramBindings for one resolved sub-intent's Strategy step. PURE.
 *   literal (a constraint stated in the intent) → {kind:'literal', value}
 *   scopeRead (consume an upstream step's output by name)  → {kind:'scope_binding', name}
 *   else → the param is surfaced as a WORKFLOW input → {kind:'strategy_param', name}
 * @returns {{ bindings:object, workflowParams:string[] }}
 */
function _stepParamBindings(si) {
  const bindings = {};
  const workflowParams = [];
  const params = Array.isArray(si.params) ? si.params : [];
  const literals = (si.literals && typeof si.literals === 'object') ? si.literals : {};
  const scopeReads = (si.scopeReads && typeof si.scopeReads === 'object') ? si.scopeReads : {};
  for (const p of params) {
    const name = typeof p === 'string' ? p : (p && p.name);
    if (!name) continue;
    if (Object.prototype.hasOwnProperty.call(literals, name)) {
      bindings[name] = { kind: 'literal', value: literals[name] };
    } else if (scopeReads[name]) {
      bindings[name] = { kind: 'scope_binding', name: scopeReads[name] };
    } else {
      bindings[name] = { kind: 'strategy_param', name };
      workflowParams.push(name);
    }
  }
  return { bindings, workflowParams };
}

/**
 * @typedef {object} ResolvedSubIntent
 * @property {string} id            sub-intent id (s0, s1, …)
 * @property {string} clause        the NL the sub-intent covers
 * @property {string} groundId      the resolved Ground (T3X-1)
 * @property {string} [groundUrl]   the Ground's entry url (for the cross-Ground hop)
 * @property {string} capabilityId  the bound Strategy id (null/absent ⇒ a gap)
 * @property {string} [capabilityName]
 * @property {Array}  [params]      the Strategy's params (names or {name})
 * @property {object} [literals]    { paramName: value } — constraints stated in the intent
 * @property {object} [scopeReads]  { paramName: upstreamScopeName } — cross-step data flow
 */

/**
 * Lower resolved sub-intents into a runnable cross-Ground Workflow record. PURE. The T3 analog of
 * capabilitySynth.buildTier2CapabilityRecords. Mirrors its shape: a `steps` array (Strategy invocations) +
 * a `params` union (the Workflow's own typed inputs) — exactly as the T2 builder emits `fragmentSteps` + `params`.
 *
 * @param {{ id:string, intent?:string, name?:string, resolved?:ResolvedSubIntent[] }} opts
 * @returns {{ workflow:(object|null), gaps:object[], runnable:boolean }}
 */
export function buildWorkflowRecord({ id, intent = '', name = null, resolved = [] } = {}) {
  const subs = Array.isArray(resolved) ? resolved : [];
  if (!id || !subs.length) return { workflow: null, gaps: [], runnable: false };

  const steps = [];
  const gaps = [];
  const wfParamNames = new Set();
  const wfParams = [];

  for (const si of subs) {
    if (!si) continue;
    if (!si.capabilityId) { gaps.push({ id: si.id || null, clause: si.clause || '', groundId: si.groundId || null }); continue; }
    const { bindings, workflowParams } = _stepParamBindings(si);
    for (const pn of workflowParams) {
      if (wfParamNames.has(pn)) continue;
      wfParamNames.add(pn);
      wfParams.push({ name: pn, type: 'string', kind: 'scalar', required: true });
    }
    steps.push({
      type: STRATEGY_STEP,
      workflowId: si.capabilityId,        // a Strategy id (the executor's `workflow` step dispatches a Strategy)
      groundId: si.groundId || null,
      groundUrl: si.groundUrl || null,    // entry url for the cross-Ground hop (consumed by the executor, T3X-3)
      label: si.clause || si.capabilityName || '',
      paramBindings: bindings,
    });
  }

  const runnable = steps.length > 0 && steps.length === subs.length;   // every sub-intent bound = no gaps
  const grounds = Array.from(new Set(steps.map((s) => s.groundId).filter(Boolean)));
  const base = ((name && String(name).trim()) || (intent && String(intent).trim()) || 'Cross-Ground Workflow').slice(0, 80);

  const workflow = {
    id,
    name: base,
    description: (intent && String(intent).trim()) || base,
    steps,
    params: wfParams,
    crossGround: grounds.length > 1,     // the T3 marker — composes Strategies across >1 Ground
    groundIds: grounds,
    synthesized: true,
  };
  return { workflow, gaps, runnable };
}
