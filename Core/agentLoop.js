// Core/agentLoop.js — the inference-layer loop (DESIGN_inference_layer.md §4). IL-1 (v2.74.1107).
//
// PURE control flow: no chrome / DOM / LLM / storage. `palette` (offer legs), `callIl` (the think seam),
// `runTool` (execute a leg), `verifyDone` (the #2 done-gate) and `isAborted` are INJECTED async deps — so the
// loop is unit-testable with mocks, exactly like Core/route.js. The loop IS `route.js + state`:
//   maxSteps=1  → one think, terminal-after-one, HANDS THE DECISION BACK un-executed → byte-identical to a
//                 route.js Tier-1 decision (the §8 Phase-1 parity claim; the existing dispatcher runs it).
//   maxSteps>1  → think → act (runTool) → observe → re-think, until done / needs / budget / abort.
//
// This module only ORCHESTRATES; it never touches the DOM and never bypasses the downstream trial/verify gate.
// Two safety invariants live HERE, not in the (possibly hallucinating / injected-into) il:
//   • anti-hallucination — a selected `leg` MUST be one `palette` offered, else hand back to demonstrate
//     (route.js's "a selected tool MUST be one we offered", now enforced on every observe→think edge — §9).
//   • done is gate-confirmed, not Orchard's opinion — `verifyDone` can reject a 'done' and force more work (#2).

import { legRef } from './legRef.js';

const keyOf = legRef;

/**
 * @typedef {Object} OfferedLeg   a palette entry Orchard may select (DESIGN §2.2 / §4.3)
 * @property {string} key         stable id (capabilityId | op | name)
 * @property {string} [name]
 * @property {'page'|'browser'|'connector'|'self'} [domain]
 * @property {'act'|'ask'} [mode]
 * @property {'learned'|'builtin'} [source]
 * @property {'auto'|'confirm'|'gated'} [safety]
 * @property {Object} [tool]      the underlying capability/primitive descriptor (for dispatch)
 *
 * @typedef {Object} StepContext  Orchard's input, assembled fresh each step (DESIGN §4.1)
 * @property {string} goal
 * @property {Object} scope       live values from prior reads (HS-2); never narrated into the prompt
 * @property {Array<Object>} ledger   signal-only per-step summaries (#3 compaction)
 * @property {Object|null} observation   the current (full) observation only
 * @property {Array<OfferedLeg>} palette
 * @property {{remaining:number}} budget
 *
 * @typedef {Object} Decision     Orchard's structured output, generalizing RouteDecision (DESIGN §4.1)
 * @property {'act'|'ask'|'done'|'needs'} kind
 * @property {OfferedLeg|null} [leg]   for act/ask — MUST be one of palette[].key
 * @property {Object} [params]
 * @property {*} [answer]              for done
 * @property {{kind:string, [k:string]:*}} [needs]   for needs — demonstrate|clarify|decompose|confirm|handoff
 * @property {string} reason
 * @property {number} confidence
 *
 * @typedef {Object} Observation  execute → next step (DESIGN §4.1)
 * @property {boolean} ok
 * @property {*} [value]
 * @property {Object} [scope]     scope deltas to merge (HS-2)
 * @property {Object} [verdict]
 * @property {Object} [structuredFailure]   the #1 envelope that lets Orchard re-engage
 *
 * @typedef {Object} LoopResult
 * @property {'act'|'ask'|'done'|'needs'|'exhausted'|'aborted'|'error'} status
 * @property {Decision|null} decision   the terminal decision (act/ask handed back; needs handed off; done)
 * @property {*} [answer]
 * @property {number} steps
 * @property {Array<Object>} ledger
 * @property {Object} scope
 * @property {string} [reason]
 */

/** Map a route.js tool ({kind:'capability'|'primitive', …}) → an OfferedLeg. PURE. */
export function legFromTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const source = (tool.kind === 'primitive' || tool.op) ? 'builtin' : 'learned';
  return { key: keyOf(tool), name: tool.name ?? null, domain: 'page', source, tool };
}

/**
 * Map a route.js RouteDecision → a loop Decision. This is the parity bridge (the §8 Phase-1 contract:
 * loop@1 ≡ route). PURE — replay/primitive→act, demonstrate/clarify/decompose→needs; done/ask are loop-native.
 * @param {import('./route.js').RouteDecision} rd
 * @returns {Decision}
 */
export function routeDecisionToDecision(rd) {
  if (!rd || typeof rd !== 'object') return { kind: 'needs', needs: { kind: 'clarify' }, params: {}, confidence: 0, reason: 'empty-route' };
  const params = (rd.params && typeof rd.params === 'object') ? rd.params : {};
  const confidence = Number.isFinite(rd.confidence) ? rd.confidence : 0;
  const base = { params, confidence, reason: rd.reason || rd.action || 'route' };
  switch (rd.action) {
    case 'replay':
    case 'primitive':
      return { kind: 'act', leg: legFromTool(rd.tool), ...base, lowConfidence: !!rd.lowConfidence };
    case 'decompose':
      return { kind: 'needs', needs: { kind: 'decompose', subAsks: Array.isArray(rd.subAsks) ? rd.subAsks.slice() : [] }, ...base, lowConfidence: !!rd.lowConfidence };
    case 'demonstrate':
      return { kind: 'needs', needs: { kind: 'demonstrate' }, ...base };
    case 'clarify':
    default:
      return { kind: 'needs', needs: { kind: 'clarify', candidates: Array.isArray(rd.candidates) ? rd.candidates : [] }, ...base };
  }
}

// Anti-hallucination (§4.3 / §9): an act/ask decision's leg MUST be one the palette offered. Else Orchard
// invented (or was steered to invent) a tool we never exposed → hand back to demonstrate, never dispatch it.
function enforcePalette(decision, legs) {
  if (decision.kind !== 'act' && decision.kind !== 'ask') return decision;
  const k = keyOf(decision.leg);
  const offered = new Set((Array.isArray(legs) ? legs : []).map(keyOf).filter(Boolean));
  if (k && offered.has(k)) return decision;
  return { kind: 'needs', needs: { kind: 'demonstrate' }, params: decision.params || {}, confidence: decision.confidence ?? 0, reason: 'tool-not-in-palette' };
}

// A signal-only ledger entry (#3 compaction — never the raw observation, just its shape). v2.74.1113 — carry
// the PARAMS too: the .1112 live run repeated OPEN_URL 3× because the ledger showed only "act OPEN_URL → ok"
// with no url, so Orchard couldn't tell it had already navigated and kept re-picking it. The params are the
// "what I did" Orchard needs to recognize the goal is already met (→ done) instead of looping.
function summarizeStep(decision, obs) {
  const e = { kind: decision.kind, leg: keyOf(decision.leg) || decision.kind, ok: !!(obs && obs.ok), reason: (obs && obs.reason) || decision.reason || '' };
  // v2.74.1115 — carry the human NAME + Orchard's pick RATIONALE so the choice is visible (the .1114 miss
  // showed a uuid + "ran this capability", hiding which capability Orchard disambiguated to, and why).
  if (decision.leg && decision.leg.name) e.legName = decision.leg.name;
  if (decision.reason) e.pick = decision.reason;
  if (decision.params && typeof decision.params === 'object' && Object.keys(decision.params).length) e.params = decision.params;
  return e;
}

// Default StepContext assembler (§4.1). Override via deps.assemble to shape the prompt; the loop only needs
// the shape. budget is collapsed to its remaining count (Orchard reasons over headroom, not the object).
function defaultAssemble(goal, scope, ledger, observation, palette, budget) {
  return { goal, scope, ledger, observation, palette, budget: { remaining: budget.remaining() } };
}

/**
 * Run the inference-layer loop. PURE — all I/O via injected async deps (any may be absent).
 * @param {string} goal
 * @param {{
 *   palette?:    (goal:string, scope:Object)=>Promise<Array<OfferedLeg>>,
 *   callIl?:  (ctx:StepContext)=>Promise<Decision>,
 *   runTool?:    (leg:OfferedLeg, params:Object)=>Promise<Observation>,
 *   verifyDone?: (decision:Decision, state:{scope:Object,ledger:Array})=>Promise<boolean>|boolean,
 *   isAborted?:  ()=>boolean,
 *   assemble?:   typeof defaultAssemble,
 * }} [deps]
 * @param {{ maxSteps?:number, budget?:{remaining:()=>number}, scope?:Object }} [opts]
 * @returns {Promise<LoopResult>}
 */
export async function agentLoop(goal, deps = {}, opts = {}) {
  const { palette, callIl, runTool, verifyDone, isAborted, assemble = defaultAssemble } = deps || {};
  const maxSteps = (Number.isFinite(opts.maxSteps) && opts.maxSteps > 0) ? Math.floor(opts.maxSteps) : 1;
  const budget = (opts.budget && typeof opts.budget.remaining === 'function') ? opts.budget : { remaining: () => Infinity };

  const g = String(goal ?? '').trim();
  const scope = (opts.scope && typeof opts.scope === 'object') ? { ...opts.scope } : {};
  const ledger = [];

  if (!g) return { status: 'needs', decision: { kind: 'needs', needs: { kind: 'clarify' }, params: {}, confidence: 0, reason: 'empty-goal' }, steps: 0, ledger, scope };
  if (typeof callIl !== 'function') return { status: 'error', decision: null, steps: 0, ledger, scope, reason: 'no-il' };

  let lastObs = null;
  let steps = 0;

  while (steps < maxSteps) {
    if (typeof isAborted === 'function' && isAborted()) return { status: 'aborted', decision: null, steps, ledger, scope, reason: 'aborted' };
    if (!(budget.remaining() > 0)) return { status: 'exhausted', decision: null, steps, ledger, scope, reason: 'budget' };
    steps += 1;
    const isLast = steps >= maxSteps;

    let legs = [];
    if (typeof palette === 'function') {
      try { const p = await palette(g, scope); if (Array.isArray(p)) legs = p; } catch { legs = []; }
    }
    const ctx = assemble(g, scope, ledger, lastObs, legs, budget);

    let decision = null;
    try { decision = await callIl(ctx); } catch { decision = null; }
    if (!decision || typeof decision !== 'object') {
      return { status: 'needs', decision: { kind: 'needs', needs: { kind: 'clarify' }, params: {}, confidence: 0, reason: 'il-failed' }, steps, ledger, scope };
    }
    decision = enforcePalette(decision, legs);

    if (decision.kind === 'done') {
      let ok = true;
      if (typeof verifyDone === 'function') { try { ok = !!(await verifyDone(decision, { scope, ledger })); } catch { ok = false; } }
      if (ok) return { status: 'done', decision, answer: decision.answer ?? null, steps, ledger, scope };
      // The gate overrides Orchard's "done" — record it and keep going (#2: done is a gate, not an opinion).
      const obs = { ok: false, reason: 'done-rejected' };
      ledger.push(summarizeStep(decision, obs));
      lastObs = obs;
      continue;
    }

    if (decision.kind === 'needs') return { status: 'needs', decision, steps, ledger, scope };

    // act | ask. On the LAST allowed step, hand the decision BACK un-executed (route.js parity at maxSteps=1 —
    // the caller dispatches it). Earlier, EXECUTE it to gather the observation that feeds the next think.
    if (isLast) return { status: decision.kind, decision, steps, ledger, scope };

    let obs = { ok: false, reason: 'no-runtool' };
    if (typeof runTool === 'function') {
      try { obs = await runTool(decision.leg, decision.params || {}); } catch (e) { obs = { ok: false, reason: 'runtool-threw', error: e && e.message }; }
    }
    if (!obs || typeof obs !== 'object') obs = { ok: false, reason: 'bad-observation' };
    ledger.push(summarizeStep(decision, obs));
    // HS-2 scope update: explicit deltas win; else key the read value under the leg that produced it.
    if (obs.scope && typeof obs.scope === 'object') Object.assign(scope, obs.scope);
    else if (decision.leg && keyOf(decision.leg) && obs.value !== undefined) scope[keyOf(decision.leg)] = obs.value;
    lastObs = obs;
  }

  return { status: 'exhausted', decision: null, steps, ledger, scope, reason: 'max-steps' };
}
