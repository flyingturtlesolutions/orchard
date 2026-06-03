// Core/orchPlan.js — ORCH-X: the compiler's pure plan IR + the analysis→fragment connection logic.
//
// The compiler turns an ask into a DETERMINISTIC plan over grounded primitives. Three layers:
//   • front-end (LLM, live)   — decompose the ask into clauses, route each to a substrate (binding-as-triage)
//   • THIS spine (pure)       — the plan IR shape, the §6 output-type → control-flow mapping, the validator
//   • back-end (runtime, later) — emit Strategy constructs (FOREACH / ACTION_GATE / paramBindings) from a plan
//
// The compiler's leverage (docs/DESIGN_intent_orchestration.md §6): you DEMONSTRATE one pass; the ANALYSIS
// supplies the quantifier; the compiler FUSES them. The connection an analysis makes to the fragment(s) that
// consume it is decided by the analysis OUTPUT TYPE — list→FOREACH, scalar→a single binding, predicate→a gate,
// count→a loop. This module encodes that mapping + the structural guard that a plan is well-formed before it is
// emitted (references resolve, no forward refs, the connection matches the output type).
//
// PURE: no DOM / chrome / LLM — the plan is data; the LLM produces it, the runtime consumes it.
//
// @module Core/orchPlan
// @version 2.74.670

/** Analysis OUTPUT TYPE → the control-flow construct it compiles to (§6). The fragment that consumes the
 *  analysis is wired accordingly. */
export const OUTPUT_CONNECTION = Object.freeze({
  list: 'foreach',          // run the fragment once PER item (item → its param)
  scalar: 'binding',        // a single chosen value → the fragment's param
  select: 'binding',
  number: 'binding',
  predicate: 'gate',        // run the fragment only if the predicate holds
  bool: 'gate',
  boolean: 'gate',
  count: 'loop',            // repeat + re-observe until the count is reached
});

/** Map an analysis output type to its control-flow connection. PURE. Unknown → 'binding' (the safe default). */
export function connectionForOutputType(outputType) {
  return OUTPUT_CONNECTION[String(outputType || '').toLowerCase()] || 'binding';
}

export const STEP_KINDS = Object.freeze(['fragment', 'observe', 'analyze']);

// A plan step's connection field → the analysis-output connection it requires.
const _CONNECTION_FIELD = Object.freeze({ forEach: 'foreach', gatedBy: 'gate', loopUntil: 'loop' });

/**
 * Validate a plan IR — the structural guard the compiler runs before the runtime emits Strategy constructs.
 * PURE. A plan is `{ goal?, steps: Step[] }`. Step kinds: 'fragment' (a grounded capability invocation, with
 * `bindings` and an optional connection to an analysis), 'observe' (a grounded read), 'analyze' (reasoning over
 * an observation, producing a typed output). Checks:
 *   - every step has a unique id and a known kind
 *   - analyze.over references an EARLIER observe step
 *   - a fragment's connection (forEach / gatedBy / loopUntil) references an EARLIER analyze step whose output
 *     type maps to the matching connection (list↔forEach, predicate↔gatedBy, count↔loopUntil) — a list can't
 *     gate, a predicate can't iterate
 *   - no forward references (a connection must point to an already-produced step)
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validatePlan(plan) {
  const errors = [];
  const steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
  if (!steps.length) return { ok: false, errors: ['plan has no steps'] };

  const idx = new Map();   // id → position
  steps.forEach((s, i) => {
    if (!s || s.id == null || s.id === '') { errors.push(`step ${i}: missing id`); return; }
    if (idx.has(s.id)) errors.push(`duplicate step id "${s.id}"`);
    else idx.set(s.id, i);
    if (!STEP_KINDS.includes(s && s.kind)) errors.push(`step "${s && s.id}": unknown kind "${s && s.kind}"`);
  });

  const earlierRef = (id, fromIdx, label) => {
    if (id == null) return null;
    if (!idx.has(id)) { errors.push(`${label} → unknown step "${id}"`); return null; }
    if (idx.get(id) >= fromIdx) { errors.push(`${label} → "${id}" is not an earlier step (forward reference)`); return null; }
    return steps[idx.get(id)];
  };

  steps.forEach((s, i) => {
    if (!s) return;
    if (s.kind === 'analyze') {
      const over = earlierRef(s.over, i, `analyze "${s.id}".over`);
      if (over && over.kind !== 'observe') errors.push(`analyze "${s.id}".over must reference an observe step (got "${over.kind}")`);
    }
    if (s.kind === 'fragment') {
      for (const field of Object.keys(_CONNECTION_FIELD)) {
        if (s[field] == null) continue;
        const a = earlierRef(s[field], i, `fragment "${s.id}".${field}`);
        if (!a) continue;
        if (a.kind !== 'analyze') { errors.push(`fragment "${s.id}".${field} must reference an analyze step`); continue; }
        const want = _CONNECTION_FIELD[field];
        const got = connectionForOutputType(a.outputType);
        if (got !== want) errors.push(`fragment "${s.id}".${field} needs an analyze whose output connects via "${want}", but "${a.id}" (${a.outputType}) connects via "${got}"`);
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

/** Step constructors — keep the plan IR consistent. PURE. */
export const planStep = {
  fragment: (id, capabilityId, extra = {}) => ({ kind: 'fragment', id, capabilityId, bindings: {}, ...extra }),
  observe: (id, extra = {}) => ({ kind: 'observe', id, ...extra }),
  analyze: (id, over, outputType, extra = {}) => ({ kind: 'analyze', id, over, outputType, ...extra }),
};
