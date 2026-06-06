// Core/orchPlan.js — ORCH-X: the compiler's pure plan IR + the analysis→fragment connection logic.
//
// The compiler turns an ask into a DETERMINISTIC plan over grounded primitives. Three layers:
//   • front-end (LLM, live)   — decompose the ask into clauses, route each to a substrate (binding-as-triage)
//   • THIS spine (pure)       — the plan IR shape, the §6 output-type → control-flow mapping, the validator
//   • back-end (runtime, later) — emit Strategy constructs (FOREACH / ACTION_GATE / paramBindings) from a plan
//
// The compiler's leverage (specs/DESIGN_intent_orchestration.md §6): you DEMONSTRATE one pass; the ANALYSIS
// supplies the quantifier; the compiler FUSES them. The connection an analysis makes to the fragment(s) that
// consume it is decided by the analysis OUTPUT TYPE — list→FOREACH, scalar→a single binding, predicate→a gate,
// count→a loop. This module encodes that mapping + the structural guard that a plan is well-formed before it is
// emitted (references resolve, no forward refs, the connection matches the output type).
//
// PURE: no DOM / chrome / LLM — the plan is data; the LLM produces it, the runtime consumes it.
//
// @module Core/orchPlan
// @version 2.74.734

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

export const STEP_KINDS = Object.freeze(['fragment', 'observe', 'analyze', 'foreach', 'loop', 'gate', 'wait']);

// ORCH-CB (comprehension/binding split) — descriptive tags a COMPREHENDER sets on a leaf SLOT and a BINDER reads.
// They don't change control flow; they say what KIND of work a slot is and how WIDE to bind it (docs/
// DESIGN_comprehension_split.md). PURE metadata — optional, validated only when present.
//   • effect — the irreducible work-kind: read (Observation), act (Fragment), reason (Analysis). Total over leaves.
//   • scope  — how wide to bind: locale (T1, this page) / ground (T2, this site) / global (T3, cross-ground).
//   • role   — the slot's structural role in its shape (for rendering / debugging); permissive (any non-empty string).
export const STEP_EFFECTS = Object.freeze(['read', 'act', 'reason']);
export const STEP_SCOPES = Object.freeze(['locale', 'ground', 'global']);
export const STEP_ROLES = Object.freeze(['step', 'head', 'driver', 'condition', 'consequent', 'body']);   // reference set

const _EFFECT_BY_KIND = Object.freeze({ observe: 'read', fragment: 'act', analyze: 'reason' });

/** The default work-kind for a leaf step kind (a control-flow node has none). PURE. Comprehension may set `effect`
 *  explicitly on a slot; this is the fallback derivation when it doesn't. */
export function effectForKind(kind) {
  return _EFFECT_BY_KIND[String(kind || '')] || null;
}

// A fragment's legacy connection FIELD (single-fragment form) → the analysis-output connection it requires.
const _CONNECTION_FIELD = Object.freeze({ forEach: 'foreach', gatedBy: 'gate', loopUntil: 'loop' });

// A CONTROL-FLOW NODE kind → the connection its driving `over` step's output type must map to. This is the
// body-carrying form: a sub-plan run per-item (foreach), repeatedly (loop), or conditionally (gate). The body is
// what makes "check each job → read its salary → collect" expressible (a single connection field can't hold a
// sub-pipeline). The connection is still DERIVED from the producer's output type, never authored.
const _NODE_CONNECTION = Object.freeze({ foreach: 'foreach', loop: 'loop', gate: 'gate' });

/** Collect every step id in the plan TREE (pre-order, descending into bodies). PURE — used for global id
 *  uniqueness AND to tell an UNKNOWN ref from a FORWARD / out-of-scope one. */
function _collectIds(steps, out) {
  for (const s of (Array.isArray(steps) ? steps : [])) {
    if (s && s.id != null && s.id !== '') out.push(s.id);
    if (s && Array.isArray(s.body)) _collectIds(s.body, out);
  }
}

/**
 * Validate a plan IR — the structural guard the compiler runs before the runtime emits Strategy constructs. PURE.
 * A plan is `{ goal?, steps: Step[] }`. Step kinds:
 *   - 'fragment' — a grounded capability invocation (`bindings`, optional legacy connection field).
 *   - 'observe'  — a grounded read (carries an `outputType`).
 *   - 'analyze'  — reasoning over an observe, producing a typed output.
 *   - 'foreach' / 'loop' / 'gate' — CONTROL-FLOW NODES: a `body` (sub-plan) run per-item / repeatedly /
 *     conditionally, driven by an `over` ref to an EARLIER observe/analyze whose outputType maps to the node's
 *     connection (list↔foreach, count↔loop, predicate↔gate). Optional `collect` names the list the body's
 *     per-iteration reads accumulate into.
 * Checks: unique ids (whole tree); known kinds; analyze.over → an earlier observe; a fragment's legacy connection
 * field → an earlier analyze whose output type matches; a control-flow node's `over` → an earlier observe/analyze
 * whose output type matches the node; a non-empty body; no forward / out-of-scope refs. Scope is LEXICAL: a ref in
 * a body sees its enclosing-earlier steps + its own earlier steps — never later steps, nor a sibling body's steps.
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validatePlan(plan) {
  const errors = [];
  const steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
  if (!steps.length) return { ok: false, errors: ['plan has no steps'] };
  const allIds = [];
  _collectIds(steps, allIds);
  const seen = new Set();
  for (const id of allIds) { if (seen.has(id)) errors.push(`duplicate step id "${id}"`); seen.add(id); }
  _validateScope(steps, new Map(), new Set(allIds), errors);
  return { ok: errors.length === 0, errors };
}

// Validate one scope. `enclosing` (Map id→step) = steps visible from enclosing scopes (lexically before this
// node). `allSet` = every id in the tree (to distinguish an unknown ref from a forward/out-of-scope one). PURE
// apart from pushing into `errors`. Body steps are validated in their own child scope and are NOT promoted out.
function _validateScope(steps, enclosing, allSet, errors) {
  const visible = new Map(enclosing);
  for (const s of steps) {
    if (!s || s.id == null || s.id === '') { errors.push('step: missing id'); continue; }
    if (!STEP_KINDS.includes(s.kind)) errors.push(`step "${s.id}": unknown kind "${s.kind}"`);
    // ORCH-CB slot tags — optional comprehension metadata; a FALSY value (absent / '') is ignored, a truthy one is
    // validated. A plan without them is still well-formed (additive; the runtime ignores unknowns).
    if (s.effect && !STEP_EFFECTS.includes(s.effect)) errors.push(`step "${s.id}": effect must be one of ${STEP_EFFECTS.join('/')} (got "${s.effect}")`);
    if (s.scope && !STEP_SCOPES.includes(s.scope)) errors.push(`step "${s.id}": scope must be one of ${STEP_SCOPES.join('/')} (got "${s.scope}")`);
    if (s.role && (typeof s.role !== 'string' || !s.role.trim())) errors.push(`step "${s.id}": role must be a non-empty string`);
    if (s.ground && (typeof s.ground !== 'string' || !s.ground.trim())) errors.push(`step "${s.id}": ground must be a non-empty string`);
    const ref = (refId, label) => {
      if (refId == null) return null;
      if (visible.has(refId)) return visible.get(refId);
      if (allSet.has(refId)) errors.push(`${label} → "${refId}" is not an earlier step (forward reference)`);
      else errors.push(`${label} → unknown step "${refId}"`);
      return null;
    };
    if (s.kind === 'analyze') {
      const over = ref(s.over, `analyze "${s.id}".over`);
      if (over && over.kind !== 'observe') errors.push(`analyze "${s.id}".over must reference an observe step (got "${over.kind}")`);
    } else if (s.kind === 'fragment') {
      for (const field of Object.keys(_CONNECTION_FIELD)) {
        if (s[field] == null) continue;
        const a = ref(s[field], `fragment "${s.id}".${field}`);
        if (!a) continue;
        if (a.kind !== 'analyze') { errors.push(`fragment "${s.id}".${field} must reference an analyze step`); continue; }
        const want = _CONNECTION_FIELD[field];
        const got = connectionForOutputType(a.outputType);
        if (got !== want) errors.push(`fragment "${s.id}".${field} needs an analyze whose output connects via "${want}", but "${a.id}" (${a.outputType}) connects via "${got}"`);
      }
    } else if (_NODE_CONNECTION[s.kind]) {
      const over = ref(s.over, `${s.kind} "${s.id}".over`);
      if (over) {
        if (over.kind !== 'observe' && over.kind !== 'analyze') {
          errors.push(`${s.kind} "${s.id}".over must reference an observe or analyze step (got "${over.kind}")`);
        } else {
          const want = _NODE_CONNECTION[s.kind];
          const got = connectionForOutputType(over.outputType);
          if (got !== want) errors.push(`${s.kind} "${s.id}".over needs an output connecting via "${want}", but "${over.id}" (${over.outputType}) connects via "${got}"`);
        }
      }
      if (s.collect != null && (typeof s.collect !== 'string' || !s.collect.trim())) errors.push(`${s.kind} "${s.id}".collect must be a non-empty output name`);
      if (!Array.isArray(s.body) || s.body.length === 0) {
        errors.push(`${s.kind} "${s.id}".body required (non-empty array of steps)`);
      } else {
        const inner = new Map(visible); inner.set(s.id, s);   // the body sees enclosing-earlier steps + this node
        _validateScope(s.body, inner, allSet, errors);
      }
    } else if (s.kind === 'wait') {
      // A PACING LEAF — a settle between an action and the read that observes its effect (live pages load the
      // detail pane / inline content async after a click). No `over`, no body: it produces nothing, it just lets
      // the page quiesce. `ms` = a fixed settle floor; `forSelector` = an optional poll-until-present signal.
      if (s.ms != null && (!Number.isFinite(s.ms) || s.ms < 0)) errors.push(`wait "${s.id}".ms must be a non-negative number`);
      if (s.forSelector != null && (typeof s.forSelector !== 'string' || !s.forSelector.trim())) errors.push(`wait "${s.id}".forSelector must be a non-empty selector`);
    }
    visible.set(s.id, s);   // visible to LATER steps in THIS scope (body steps are NOT promoted to the outer scope)
  }
}

/** Step constructors — keep the plan IR consistent. PURE. */
export const planStep = {
  fragment: (id, capabilityId, extra = {}) => ({ kind: 'fragment', id, capabilityId, bindings: {}, ...extra }),
  observe: (id, extra = {}) => ({ kind: 'observe', id, ...extra }),
  analyze: (id, over, outputType, extra = {}) => ({ kind: 'analyze', id, over, outputType, ...extra }),
  // CONTROL-FLOW NODES — a `body` (sub-plan) driven by an earlier observe/analyze (`over`). `extra` may carry
  // `collect` (the output list the body's per-iteration reads accumulate into), `itemVar` (foreach; default
  // 'item' — how a body step names the current element in its bindings), and `until` (a loop-bound override).
  foreach: (id, over, body = [], extra = {}) => ({ kind: 'foreach', id, over, itemVar: 'item', body, ...extra }),
  loop: (id, over, body = [], extra = {}) => ({ kind: 'loop', id, over, body, ...extra }),
  gate: (id, over, body = [], extra = {}) => ({ kind: 'gate', id, over, body, ...extra }),
  // PACING LEAF — a settle node. `ms` is a fixed floor (live pages need time after a click); `forSelector` (in
  // `extra`) optionally polls until a signal appears, so the wait is adaptive rather than a blind delay.
  wait: (id, extra = {}) => ({ kind: 'wait', id, ms: 800, ...extra }),
};
