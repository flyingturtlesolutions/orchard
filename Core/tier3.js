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
// @version 2.74.792

// The executor's Strategy-invocation step kind. NB: WorkflowExecutor names it 'workflow' for legacy storage
// reasons, but it DISPATCHES a Tier-2 Strategy (see specs/TIER_MODEL.md — the inner 'workflow' step = a Strategy).
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
 * The scope key a READ step's value lands under (so a downstream step's scope_binding can consume it). The
 * observation's first declared output name; falls back to 'value'. PURE.
 */
function _outputName(si) {
  const outs = Array.isArray(si.outputs) ? si.outputs : [];
  for (const o of outs) { const n = typeof o === 'string' ? o : (o && o.name); if (n) return n; }
  return 'value';
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
 * @property {string[]} [dependsOn] ids of sub-intents this one depends on (drives topo order + data flow)
 * @property {Array}  [outputs]     the bound Strategy's declared outputs (names or {name}) — feed downstream scopeReads
 * @property {object} [stated]      { paramHint: value } — values the intent STATED for this sub-intent → literals
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
    const isObservation = (si.capabilityKind || 'strategy') === 'observation';
    steps.push({
      type: STRATEGY_STEP,
      workflowId: si.capabilityId,        // dispatch id: a Strategy id, a Fragment id, or an Observation id by kind
      capabilityKind: si.capabilityKind || 'strategy',   // 'strategy' | 'fragment' | 'observation' — how the executor runs it
      groundId: si.groundId || null,
      groundUrl: si.groundUrl || null,    // entry url for the cross-Ground hop (consumed by the executor, T3X-3)
      label: si.clause || si.capabilityName || '',
      paramBindings: bindings,
      // DF — a READ step (observation-native dispatch): the executor HOPS to the Ground, REPLAYS the antecedent
      // capability (the prerequisite ACTION, e.g. the search — a Strategy or Fragment, via REPLAY_SG_CAPABILITY),
      // runs the Observation (RUN_OBSERVATION), and emits the value under `outputName` so a downstream scope_binding
      // can consume it. The antecedent is logical linkage independent of strategy membership; the read itself is NOT
      // wrapped as a Strategy (that conflated act+read).
      ...(isObservation ? {
        outputName: _outputName(si),
        ...(si.antecedentCapabilityId ? { antecedentCapabilityId: si.antecedentCapabilityId } : {}),
        ...(si.antecedentParamBindings && typeof si.antecedentParamBindings === 'object' ? { antecedentParamBindings: si.antecedentParamBindings } : {}),
      } : {}),
      ...(si.compensateWith ? { compensateWith: si.compensateWith } : {}),  // Q5 — a Strategy that UNDOES this step
      // Reversibility floor on the durable record — only stamped when IRREVERSIBLE (apply/submit/post/buy), so a saved
      // workflow re-run (which skips the live comprehend card) and the executor can still gate the 🔒 step. Default
      // (absent) = reversible; reads/searches never set it.
      ...(si.reversible === false ? { reversible: false } : {}),
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

// Reference-type param/output families — a param named like one of these is a candidate for cross-step data flow
// (it consumes an identifier/locator produced upstream), e.g. URL / job_url / email / user_id.
const _REF = /(?:url|uri|link|href|email|address|phone|handle|username|account|number|\bid\b)/i;
const _normName = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const _nameTokens = (s) => _normName(s).split(' ').filter(Boolean);
function _shareToken(a, b) { const A = new Set(_nameTokens(a)); return _nameTokens(b).some((t) => A.has(t)); }

/**
 * Wire the cross-Ground DATA FLOW across TOPO-ORDERED sub-intents (deterministic floor; LLM mapping = the Δc
 * upgrade seam). PURE. Walks `resolved` in order (so earlier sub-intents' outputs are available to later ones) and
 * fills each entry's `literals` + `scopeReads`, which buildWorkflowRecord then lowers to `literal` / `scope_binding`
 * step bindings (anything left unbound stays a Workflow input). Per param, in priority order:
 *   1. LITERAL  — the sub-intent STATED a value for it (`si.stated`, keyed by a param-ish name).
 *   2. SCOPE_BINDING — it's a reference-type param (url/id/email/…) fed by an UPSTREAM declared output: prefer a
 *      shared-token match (URL ← job_url), else the single unambiguous reference output upstream.
 *   3. else — left unbound (→ a Workflow input).
 * Mutates + returns the same array. Input MUST be topo-ordered by dependsOn (the caller does that via topoOrder).
 * @param {ResolvedSubIntent[]} resolved
 * @returns {ResolvedSubIntent[]}
 */
export function wireCrossGroundData(resolved) {
  const list = Array.isArray(resolved) ? resolved : [];
  const upstream = [];   // {name, fromId} declared outputs available from EARLIER sub-intents, in order
  for (const si of list) {
    if (!si) continue;
    const params = (Array.isArray(si.params) ? si.params : []).map((p) => (typeof p === 'string' ? p : (p && p.name))).filter(Boolean);
    const stated = (si.stated && typeof si.stated === 'object') ? si.stated : {};
    const literals = { ...(si.literals || {}) };
    const scopeReads = { ...(si.scopeReads || {}) };
    const dependsOn = Array.isArray(si.dependsOn) ? si.dependsOn : [];
    // Outputs from the EARLIER sub-intents THIS one explicitly consumes (dependsOn) — the asked data hand-off.
    const depOutputs = upstream.filter((o) => dependsOn.includes(o.fromId));

    // Pass 1 — assign STATED literals (matched by name / shared token); collect the params still OPEN.
    const open = [];
    for (const p of params) {
      if (Object.prototype.hasOwnProperty.call(literals, p) || scopeReads[p]) continue;   // already decided
      const statedKey = Object.keys(stated).find((k) => _normName(k) === _normName(p) || _shareToken(k, p));
      if (statedKey != null) { literals[p] = stated[statedKey]; continue; }
      open.push(p);
    }
    // Pass 2 — bind the OPEN params from upstream outputs (else they surface as Workflow inputs). Two routes:
    const usedDep = new Set();   // an upstream output binds at most one param
    for (const p of open) {
      let match = null;
      // (a) DATA HAND-OFF (v2.74.803) — a producer THIS sub-intent dependsOn. Works for ANY param type, not only
      //     url/email/id refs: "search Pixabay for the TITLE you read" → the plain search box ← the read's output.
      //     Prefer a shared-token producer; else the SOLE dep output ↔ the SOLE open slot (unambiguous hand-off).
      if (depOutputs.length) {
        for (const o of depOutputs) if (!usedDep.has(o.name) && _shareToken(o.name, p)) { match = o; break; }
        if (!match) { const free = depOutputs.filter((o) => !usedDep.has(o.name)); if (free.length === 1 && open.length === 1) match = free[0]; }
      }
      // (b) REFERENCE hand-off — a _REF-typed param (url/email/id/…) fed by ANY upstream ref output, even with no
      //     explicit dependsOn: specific shared-token first, then a SINGLE unambiguous reference output.
      if (!match && _REF.test(_normName(p)) && upstream.length) {
        for (const o of upstream) if (_shareToken(o.name, p)) match = o;
        if (!match) { const refs = upstream.filter((o) => _REF.test(_normName(o.name))); if (refs.length === 1) match = refs[0]; }
      }
      if (match) { scopeReads[p] = match.name; usedDep.add(match.name); }
    }
    si.literals = literals;
    si.scopeReads = scopeReads;
    for (const o of (Array.isArray(si.outputs) ? si.outputs : [])) {
      const name = typeof o === 'string' ? o : (o && o.name);
      if (name) upstream.push({ name, fromId: si.id });
    }
  }
  return list;
}

/**
 * Q3 — turn the UNBOUND sub-intents (gaps: no Strategy matched on their Ground) into actionable REPAIR hints. PURE.
 * The cross-Ground gap→capture seam: a gap is not a dead end — it tells the chat exactly what to author and where.
 * Two kinds: `author-strategy` (a Ground resolved but has no Strategy for this sub-intent → record one there) and
 * `resolve-ground` (no site could be determined at all). The chat/UI offers "teach me this on <site>".
 * @param {ResolvedSubIntent[]} resolved
 * @param {Map|object} groundsById   groundId → ground record (for the display name)
 * @returns {{subIntentId,clause,groundId,groundName,kind,message}[]}
 */
export function buildGapRepairs(resolved, groundsById) {
  const byId = groundsById instanceof Map ? groundsById : new Map(Object.entries(groundsById || {}));
  const repairs = [];
  for (const si of (Array.isArray(resolved) ? resolved : [])) {
    if (!si || si.capabilityId) continue;   // bound → not a gap
    const g = si.groundId ? byId.get(si.groundId) : null;
    const groundName = (g && (g.name || g.site)) || si.groundId || null;
    const hasGround = !!si.groundId;
    repairs.push({
      subIntentId: si.id || null,
      clause: si.clause || '',
      groundId: si.groundId || null,
      groundName,
      kind: hasGround ? 'author-strategy' : 'resolve-ground',
      message: hasGround
        ? `No saved capability for "${si.clause}" on ${groundName} — record one there, then re-run.`
        : `Couldn't determine which site handles "${si.clause}".`,
    });
  }
  return repairs;
}

/**
 * Q5 — plan COMPENSATION for a cross-Ground Workflow that failed mid-journey. PURE. Given the Workflow steps and
 * the indices of steps that COMMITTED before the failure, returns the undo plan: each completed step that declares
 * a `compensateWith` Strategy, in REVERSE order (undo the most recent commit first — saga semantics). Steps with no
 * declared compensation are left as-is (their effect stands; the failure report surfaces them). The executor runs
 * this plan on abort. A Workflow whose steps declare no `compensateWith` yields an empty plan (no-op — back-compat).
 * @param {object[]} steps             the Workflow's steps
 * @param {number[]} committedIndices  indices of steps that succeeded before the failure
 * @returns {{stepIndex:number, workflowId:string, undoes:(string|null), groundId:(string|null)}[]}
 */
export function planCompensation(steps, committedIndices) {
  const list = Array.isArray(steps) ? steps : [];
  const done = new Set((Array.isArray(committedIndices) ? committedIndices : []).map(Number));
  const plan = [];
  for (let i = list.length - 1; i >= 0; i--) {   // reverse — undo most-recent commit first
    const s = list[i];
    if (!s || !done.has(i) || !s.compensateWith) continue;
    plan.push({ stepIndex: i, workflowId: s.compensateWith, undoes: s.workflowId || null, groundId: s.groundId || null });
  }
  return plan;
}
