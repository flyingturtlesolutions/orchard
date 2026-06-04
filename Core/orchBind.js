// Core/orchBind.js — ORCH-CB slice 4: the per-slot effect+scope BINDER.
//
// Comprehension yields a PlanShape of unbound slots (orchComprehend); BIND resolves each leaf against the right
// substrate pool — picked by the slot's EFFECT (read → observations, act → fragments) — and fills `capabilityId`,
// or records a GAP. The matcher (rankAndDecide) runs PER SLOT, not once on the whole ask — which is the only place
// effect-scoping is correct (a mixed-effect intent's read condition and act consequent bind against different
// pools). PURE: the caller fetches the pools (effect-partitioned, scope-filtered) and supplies a scorer; this
// module is just the walk + the decision. See docs/DESIGN_comprehension_split.md §1, §5.
//
//   bindShape(shape, pools, opts?) → { steps, gaps, bound }
//     pools = { read: Candidate[], act: Candidate[] }   // already scoped to the slot's tier (locale/ground/global)
//     opts  = { score?(clause, candidate)->0..1, threshold? }
//
// @module Core/orchBind
// @version 2.74.736

import { effectForKind } from './orchPlan.js';

const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const _toks = (s) => new Set(_norm(s).split(' ').filter((w) => w.length > 2));

/** A cheap lexical relevance (token recall of the clause covered by the candidate's intent). PURE. The default
 *  scorer; the live binder injects a `rankAndDecide`-backed one. */
export function lexicalScore(clause, candidate) {
  const a = _toks(clause);
  const b = _toks((candidate && (candidate.intent || candidate.name)) || '');
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / a.size;
}

function _best(clause, pool, score) {
  let best = null;
  for (const c of (Array.isArray(pool) ? pool : [])) {
    const sc = Number(score(clause, c)) || 0;
    if (!best || sc > best.score) best = { candidate: c, score: sc };
  }
  return best;
}

/**
 * Bind a PlanShape against effect-partitioned candidate pools. PURE. Each leaf binds against the pool matching its
 * EFFECT; a leaf that doesn't clear `threshold` becomes a gap (its slot keeps `capabilityId:null`). Control-flow
 * nodes recurse into their body; wait/analyze leaves never bind.
 * @param {{steps:object[]}|object[]} shape  a comprehended PlanShape (or its steps[])
 * @param {{read?:object[], act?:object[]}} pools
 * @param {{score?:Function, threshold?:number}} [opts]
 * @returns {{steps:object[], gaps:Array<{id,clause,effect}>, bound:boolean}}
 */
export function bindShape(shape, pools = {}, opts = {}) {
  const score = typeof opts.score === 'function' ? opts.score : lexicalScore;
  const threshold = opts.threshold == null ? 0.34 : opts.threshold;
  const gaps = [];
  const steps = _bind((shape && shape.steps) || shape || [], pools, score, threshold, gaps);
  return { steps, gaps, bound: gaps.length === 0 };
}

function _bind(steps, pools, score, threshold, gaps) {
  return (Array.isArray(steps) ? steps : []).map((s) => {
    if (!s) return s;
    if (s.kind === 'foreach' || s.kind === 'loop' || s.kind === 'gate') {
      return { ...s, body: _bind(s.body, pools, score, threshold, gaps) };
    }
    if (s.kind === 'wait' || s.kind === 'analyze') return s;   // structural / reasoning — nothing to bind
    const effect = s.effect || effectForKind(s.kind);
    const pool = effect === 'read' ? (pools.read || []) : (pools.act || []);   // EFFECT picks the pool
    const best = _best(s.clause || s.intent || '', pool, score);
    if (best && best.score >= threshold) {
      return { ...s, capabilityId: best.candidate.id, bound: best.candidate.id, bindScore: best.score };
    }
    gaps.push({ id: s.id, clause: s.clause || s.intent || '', effect: effect || 'act' });
    return { ...s, capabilityId: null, bound: null };
  });
}
