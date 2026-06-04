// Core/orchTranslate.js — ORCH→Strategy: translate an ORCH control-flow composite IR into a canonical, runnable
// Strategy plan tree (ExecutionEngine #executeNodes vocabulary). This is the convergence: a T2 composite stops
// being a matcher-only artifact and BECOMES a Strategy — Studio-visible, ParamForm-launchable, one runtime.
//
// The node map (see docs / the build spec):
//   fragment {capabilityId,bindings}  → SPLICE the resolved sub-strategy's fragment node(s), binding params
//   observe  {capabilityId,...}        → {type:'observation', observationId}  (materialized record, resolved in)
//   analyze  {over,predicate}          → ELIDED — folded into the gate's DETECT condition (no node emitted)
//   gate     {over,body}               → {type:'detect', branches:[{condition:<orch_predicate>, body}], default:[]}
//   wait     {ms}                      → {type:'wait', mode:'duration', durationMs}
//   foreach/loop                       → first-cut UNSUPPORTED → an error (validate-at-promote refuses; cache fallback)
//
// The gate's predicate is NOT re-implemented: it becomes an `orch_predicate` condition that calls the SAME
// evaluatePredicate at runtime — identical truth. PURE: no DOM / chrome / I/O. The caller resolves each leaf's
// capabilityId → a Strategy ref (the StorageManager reads) and passes `resolved` in, so this stays a pure mapper.
//
// @module Core/orchTranslate
// @version 2.74.745

// A param binding is `strategy_param` (shown in the ParamForm, rebindable) when its name is a declared param of the
// composite; otherwise a frozen `literal`. The launched Strategy thus exposes exactly the rebindable arguments.
function _bindFragmentParams(node, bindings, paramNames, usedParams) {
  if (!node || node.type !== 'fragment') return node;
  const pb = { ...(node.paramBindings || {}) };
  for (const [k, v] of Object.entries((bindings && typeof bindings === 'object') ? bindings : {})) {
    if (paramNames.has(k)) { pb[k] = { kind: 'strategy_param', name: k }; usedParams.add(k); }
    else pb[k] = { kind: 'literal', value: String(v == null ? '' : v) };
  }
  return { ...node, paramBindings: pb };
}

function _err(ctx, msg) { ctx.errors.push(msg); return null; }

function _xWait(s) {
  const ms = Number.isFinite(s.ms) ? Math.max(0, Math.round(s.ms)) : 800;
  return { type: 'wait', mode: 'duration', durationMs: ms };
}

function _xFragment(s, ctx) {
  if (s.clickItem) return _err(ctx, `fragment "${s.id}" is a synthetic clickItem (no fragmentId) — not supported in the first cut`);
  const r = ctx.resolved[s.id];
  if (!r || r.kind !== 'fragment' || !Array.isArray(r.fragmentSteps) || !r.fragmentSteps.length) {
    return _err(ctx, `fragment "${s.id}" (cap ${s.capabilityId || '?'}) did not resolve to a Strategy's fragment steps`);
  }
  // Splice the sub-strategy's fragment node(s) inline (ExecutionEngine has no nested-strategy node), binding the
  // composite's params onto each. Every spliced binding ends as literal or strategy_param — never a leaked strategy_param of the sub-strategy.
  return r.fragmentSteps.map((node) => _bindFragmentParams(node, s.bindings, ctx.paramNames, ctx.usedParams));
}

function _xObserve(s, ctx) {
  const r = ctx.resolved[s.id];
  if (!r || r.kind !== 'observation' || !r.observationId) {
    return _err(ctx, `observe "${s.id}" (cap ${s.capabilityId || '?'}) did not resolve to a materialized Observation (visual / no selector?)`);
  }
  // The materialized Observation's extract.output is the observe step id — the binding a downstream gate reads.
  return { type: 'observation', observationId: r.observationId, paramBindings: {} };
}

function _xGate(s, ctx) {
  const analyze = ctx.byId.get(s.over);
  if (!analyze || analyze.kind !== 'analyze') return _err(ctx, `gate "${s.id}".over → not an analyze step`);
  const observe = ctx.byId.get(analyze.over);
  if (!observe || observe.kind !== 'observe') return _err(ctx, `gate "${s.id}" analyze.over → not an observe step`);
  // The gate's predicate evaluates over the observe's bound value — reproduced EXACTLY by an `orch_predicate`
  // condition that calls evaluatePredicate at runtime. `binding` = the observe step id (= its extract.output). The
  // predicate rides as a JSON STRING: the canonical condition normalizer String()-ifies every field, so an object
  // would become "[object Object]" — specJson survives.
  const condition = { match: 'all', conditions: [{ type: 'orch_predicate', binding: observe.id, specJson: JSON.stringify(analyze.predicate || { op: 'exists' }) }] };
  const body = _xBody(s.body, ctx);
  return { type: 'detect', branches: [{ condition, body }], default: [] };   // closed gate = empty default = SKIP
}

function _xBody(steps, ctx) {
  const out = [];
  for (const b of (Array.isArray(steps) ? steps : [])) {
    const t = _xStep(b, ctx);
    if (Array.isArray(t)) out.push(...t);
    else if (t) out.push(t);
  }
  return out;
}

function _xStep(s, ctx) {
  if (!s || !s.kind) return null;
  switch (s.kind) {
    case 'fragment': return _xFragment(s, ctx);
    case 'wait': return _xWait(s);
    case 'observe': return _xObserve(s, ctx);
    case 'analyze': return ctx.consumed.has(s.id) ? null : _err(ctx, `analyze "${s.id}" is not consumed by a gate (orphan)`);
    case 'gate': return _xGate(s, ctx);
    case 'foreach': case 'loop': return _err(ctx, `${s.kind} "${s.id}" — control-flow over a collection is not in the first cut (keep cache fallback)`);
    default: return _err(ctx, `unknown step kind "${s.kind}"`);
  }
}

/**
 * Translate an ORCH composite IR into a Strategy plan tree. PURE.
 * @param {{steps:object[]}} plan  the ORCH IR
 * @param {Object<string,{kind:'fragment',fragmentSteps:object[]}|{kind:'observation',observationId:string}>} resolved
 *        capabilityId-resolution per STEP ID (the caller did the StorageManager reads)
 * @param {{params?:string[], paramDefaults?:object}} [opts]  param names (→ strategy_param bindings) + sample defaults
 * @returns {{ok:boolean, fragmentSteps:object[], params:object[], errors:string[]}}
 */
export function translatePlan(plan, resolved, opts = {}) {
  const steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
  const errors = [];
  if (!steps.length) return { ok: false, fragmentSteps: [], params: [], errors: ['plan has no steps'] };
  const byId = new Map();
  const _index = (arr) => { for (const s of (arr || [])) { if (s && s.id != null) byId.set(s.id, s); if (s && Array.isArray(s.body)) _index(s.body); } };
  _index(steps);
  const consumed = new Set();   // analyze steps folded into a gate condition (not emitted as nodes)
  const _scanGates = (arr) => { for (const s of (arr || [])) { if (s && s.kind === 'gate' && s.over) consumed.add(s.over); if (s && Array.isArray(s.body)) _scanGates(s.body); } };
  _scanGates(steps);
  const usedParams = new Set();
  const ctx = { byId, resolved: (resolved && typeof resolved === 'object') ? resolved : {}, errors, consumed, paramNames: new Set((Array.isArray(opts.params) ? opts.params : []).filter(Boolean)), usedParams };
  const fragmentSteps = _xBody(steps, ctx);
  const defaults = (opts.paramDefaults && typeof opts.paramDefaults === 'object') ? opts.paramDefaults : {};
  const params = [...usedParams].map((name) => ({ name, kind: 'scalar', type: 'string', required: false, label: name, default: defaults[name] != null ? String(defaults[name]) : '' }));
  return { ok: errors.length === 0, fragmentSteps, params, errors };
}
