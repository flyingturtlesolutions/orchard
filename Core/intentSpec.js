// Core/intentSpec.js — SG-1 (Comprehend) contract. The page-INDEPENDENT IntentSpec + its builder.
//
// DESIGN_substrate_grounded_capabilities §4 (the four-stage atom) + §SG-1. Comprehend is the LLM's
// strongest fit: it turns a user's raw intent into a structured spec WITHOUT seeing any page. This module
// is the deterministic half — it defines the canonical spec shape and MERGES an LLM comprehension object
// over a lexical fallback, validating/clamping so the spec is always well-formed (even with no LLM).
//
// Capture-discipline note (§4.6): this is the INTENT side, not capture. The spec records the intent's
// structure (target, constraints, an ORDERED subGoal program, observable successConditions, safety). The
// PAGE-relative judgments (which feature satisfies a sub-goal, is the form fully covered) are NOT here —
// they belong to SG-2 Select, which matches subGoals → Locale features page-aware.
//
// PURE: no DOM, no LLM call, no storage. The LLM producer is AnthropicService.comprehendIntent (SG-1b);
// it feeds its parsed output in as `comprehension`. Unit-testable like Core/intentShape.js.
//
// @module Core/intentSpec

import { classifyIntentShape } from './intentShape.js';

// Leaf-operation primitives. `navigate` (edge traversal — reaching a state) is distinct from `act`
// (acting AT a state) and central to the Band-1 state-graph model. `monitor` is NOT here — it's a
// temporal modifier (deferred `recurrence`), not a shape.
export const SHAPES  = ['read', 'act', 'complete', 'navigate'];
export const SCOPES  = ['required', 'optional'];
export const SAFETY  = ['benign', 'consequential', 'irreversible'];
// Observable kinds a trial can deterministically check ("the trial renders truth").
export const SIGNALS = ['url', 'text', 'element', 'value'];

const _isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const _str = (v, n = 200) => (typeof v === 'string' ? v : '').trim().slice(0, n);
const _id  = (v, n = 40) => _str(v, n).replace(/[^\w-]/g, '');
function _scalar(v) {
  if (typeof v === 'string') return v.trim().slice(0, 200);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  return null;   // drop nested / complex — constraints are flat scalars extracted from the intent text
}

/** Flat scalar map of constraints EXTRACTED FROM the intent text (not fulfillment data). */
function _normConstraints(raw) {
  if (!_isObj(raw)) return {};
  const out = {}; let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= 24) break;
    const key = _str(k, 60); const val = _scalar(v);
    if (!key || val === null) continue;
    out[key] = val; n++;
  }
  return out;
}

/** Values the intent does NOT supply that must be sourced at fulfillment (profile/runtime/ask). */
function _normDataNeeded(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) { const s = _str(x, 80); if (s && !out.includes(s)) out.push(s); if (out.length >= 30) break; }
  return out;
}

/** Observable predicates the trial checks. Lenient: a bare prose string → one text observable. */
function _normSuccess(raw) {
  let arr = raw;
  if (typeof raw === 'string' && raw.trim()) arr = [{ signal: 'text', match: raw }];
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const o of arr) {
    if (!_isObj(o)) continue;
    const signal = SIGNALS.includes(o.signal) ? o.signal : null;
    const match = _str(o.match, 200);
    if (!signal || !match) continue;
    out.push({ signal, match });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Normalize the subGoal PROGRAM (ordered, with dependencies — not a set). Assigns stable ids to entries
 * that lack one, inherits the top shape, defaults scope to 'required', and resolves `dependsOn` to only
 * ids that exist in this program (dangling/self refs dropped — Select/Bind can't sequence a phantom).
 */
function _normSubGoals(raw, topShape) {
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  const pass = [];
  for (const g of raw) {
    if (!_isObj(g)) continue;
    const label = _str(g.label, 120);
    if (!label) continue;                       // a sub-goal MUST have a label
    let id = _id(g.id);
    if (!id || ids.has(id)) { id = `sg${pass.length + 1}`; while (ids.has(id)) id += '_x'; }
    ids.add(id);
    const shape = SHAPES.includes(g.shape) ? g.shape : (SHAPES.includes(topShape) ? topShape : 'act');
    const scope = SCOPES.includes(g.scope) ? g.scope : 'required';
    // SG-T2-5 — a per-subGoal successCondition (the observable that proves THIS phase done) is the LLM
    // half of decision C; Tier-2 lowering turns it into the phase's fragment postcondition.
    pass.push({ id, label, shape, scope, _dep: Array.isArray(g.dependsOn) ? g.dependsOn : [], _sc: _normSuccess(g.successCondition) });
    if (pass.length >= 40) break;
  }
  return pass.map((g) => {
    const dependsOn = [];
    for (const d of g._dep) { const dep = _id(d); if (dep && dep !== g.id && ids.has(dep) && !dependsOn.includes(dep)) dependsOn.push(dep); }
    const { _dep, _sc, ...rest } = g;
    const out = { ...rest, dependsOn };
    if (Array.isArray(_sc) && _sc.length) out.successCondition = _sc;   // omit when empty — keep specs lean
    return out;
  });
}

/**
 * Build the canonical IntentSpec. PURE.
 *
 * @param {string} intent                 the user's verbatim intent text (the saved artifact).
 * @param {object|null} [comprehension]   the LLM producer's parsed output (SG-1b); null = offline.
 * @param {object} [evidence]             structural evidence for the lexical fallback (intentShape).
 * @returns {{intent,shape,target,constraints,dataNeeded,subGoals,successCondition,safety,confidence,decidedBy}}
 */
export function buildIntentSpec(intent, comprehension = null, evidence = {}) {
  const text = _str(intent, 2000);
  const c = _isObj(comprehension) ? comprehension : null;

  // shape: LLM (semantic) is primary; the lexical classifier is the no-LLM FALLBACK. (`navigate` only
  // comes from the LLM — the lexical set is read/act/complete.)
  let shape, decidedBy;
  if (c && SHAPES.includes(c.shape)) { shape = c.shape; decidedBy = 'llm'; }
  else { const k = classifyIntentShape(text, evidence); shape = SHAPES.includes(k && k.shape) ? k.shape : 'act'; decidedBy = 'lexical'; }

  const subGoals = c ? _normSubGoals(c.subGoals, shape) : [];
  // safety: the LLM's call when given; else conservative — a `complete` intent likely commits something,
  // so default 'consequential' (the trial errs toward caution). Refined again by SG-4's own safety class.
  const safety = (c && SAFETY.includes(c.safety)) ? c.safety : (shape === 'complete' ? 'consequential' : 'benign');
  let confidence = 0.5;
  if (c && typeof c.confidence === 'number' && c.confidence >= 0 && c.confidence <= 1) confidence = c.confidence;
  else if (decidedBy === 'llm') confidence = 0.85;

  return {
    intent: text,                                   // verbatim — capture-discipline keeps the words
    shape,                                          // coarse hint; subGoals are authoritative
    target: c ? _str(c.target, 200) : '',
    constraints: c ? _normConstraints(c.constraints) : {},   // extracted from the intent text only
    dataNeeded: c ? _normDataNeeded(c.dataNeeded) : [],      // sourced elsewhere at fulfillment
    subGoals,                                       // ORDERED program (DAG) — Select's interface
    successCondition: c ? _normSuccess(c.successCondition) : [],   // observable predicates (trial-checkable)
    safety,
    confidence,
    decidedBy,
  };
}

/**
 * Page-INDEPENDENT scope breadth — the most completeness can honestly say without a page. The
 * exhaustive-vs-targeted refinement ("does this cover the WHOLE form, or a subset?") is page-relative and
 * belongs to SG-2 Select, which compares the spec's subGoals against the Locale's required features.
 * @returns {'single'|'multi'}
 */
export function scopeBreadth(spec) {
  const n = Array.isArray(spec && spec.subGoals) ? spec.subGoals.length : 0;
  if (spec && spec.shape !== 'complete') return 'single';
  return n >= 2 ? 'multi' : 'single';
}
