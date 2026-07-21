/**
 * Core/branchClause.js — PP-1 (v2.74.1661): the per-item BRANCH clause, pure half.
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §1.2 (contract) · §3.1 (multi-arm) · §1.3 (who authors the predicate).
 *
 * This file is deliberately buildable BEFORE PP-0 answers the reach question (does `detect` run with a plain
 * record scope, or must the pipeline lower into strategy nodes?). It achieves that by INJECTING the predicate
 * evaluator rather than importing one: `evalBranch(item, verdict, evaluate)` takes the evaluator as an argument,
 * so the same core serves whichever answer PP-0 gives. Nothing here knows about tabs, DOM, connectors or chat.
 *
 * THE THREE OUTCOMES ARE THE POINT. Twice this session a two-outcome design produced a confident wrong answer —
 * the ladder read an unreachable rung as a miss and descended to a weaker key (v1637), and a truthy-but-pathless
 * resolver result rendered a field named "undefined" (v1653). A branch has the same trap: a predicate that THROWS
 * or reads an absent field is UNKNOWN, not FALSE. Routing unknown to `otherwise` silently sends items down the
 * wrong arm on a transport blip. So: `arm` | `none` | `unknown`, and the caller must be able to tell them apart.
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));
const _arr = (v) => (Array.isArray(v) ? v : []);

/** Valid multi-arm modes. §3.1 — 'first' is the DEFAULT because doing less than asked is visible in the tally, */
/** while an unrequested extra write is not. */
export const BRANCH_MODES = Object.freeze(['first', 'all']);

/**
 * Normalize a branch clause. PURE. Returns null when the shape is not a branch — the caller then degrades
 * honestly (clarify / decompose), never half-runs.
 *
 * `arms` is the ONLY required slot. Everything else is optional with an explicit absent-branch, because a
 * required slot the caller cannot always fill does not stay empty — it gets filled with an invention. That
 * failure cost three versions this session (itemField v1636, the bulk-write shape v1638, target.system v1643-48).
 */
export function normalizeBranchVerdict(v) {
  const o = (v && typeof v === 'object') ? v : {};
  const arms = [];
  for (const a of _arr(o.arms)) {
    if (!a || typeof a !== 'object') continue;
    if (!a.when || typeof a.when !== 'object') continue;   // `when` is an ASSERTION, never prose (§1.2)
    arms.push({
      when: a.when,
      label: _str(a.label) || `arm ${arms.length + 1}`,
      then: _arr(a.then),
    });
  }
  if (!arms.length) return null;
  const mode = BRANCH_MODES.includes(o.mode) ? o.mode : 'first';
  return {
    kind: 'branch',
    collection: (o.collection && typeof o.collection === 'object') ? o.collection : 'prior',
    arms,
    otherwise: _arr(o.otherwise).length ? _arr(o.otherwise) : null,
    mode,
  };
}

/**
 * Decide ONE item's arm. PURE given a pure `evaluate`.
 *
 * @param {Object} item      the record
 * @param {Object} verdict   a normalized branch verdict
 * @param {(assertion:Object, item:Object) => (boolean|undefined)} evaluate
 *        TRUE = matched · FALSE = did not match · UNDEFINED/throw = could not evaluate.
 *        Returning undefined is how a caller says "this predicate reads a field this record does not have" —
 *        it is NOT a false, and this function will not treat it as one.
 * @returns {{outcome:'arm'|'none'|'unknown', arms:Array, skipped:Array, why:string}}
 *          `arms` = the arms to run (0, 1, or many under mode:'all'); `skipped` = arms that ALSO matched but were
 *          not run under mode:'first' — recorded rather than dropped, because a silent drop is the failure §3.1
 *          exists to prevent.
 */
export function evalBranch(item, verdict, evaluate) {
  const v = verdict && verdict.kind === 'branch' ? verdict : null;
  if (!v) return { outcome: 'unknown', arms: [], skipped: [], why: 'not a branch verdict' };
  if (typeof evaluate !== 'function') return { outcome: 'unknown', arms: [], skipped: [], why: 'no evaluator' };

  const matched = [];
  const unknowns = [];
  for (const arm of v.arms) {
    let r;
    try { r = evaluate(arm.when, item); } catch (e) { r = undefined; unknowns.push(`${arm.label}: ${(e && e.message) || 'threw'}`); continue; }
    if (r === true) matched.push(arm);
    else if (r !== false) unknowns.push(`${arm.label}: indeterminate`);   // undefined/null/anything non-boolean
  }

  // An arm matched → route, regardless of other arms being indeterminate: a positive match is evidence, an
  // unknown elsewhere is absence of evidence. (Contrast: NO match plus an unknown is genuinely undecided.)
  if (matched.length) {
    const run = v.mode === 'all' ? matched : matched.slice(0, 1);
    const skipped = v.mode === 'all' ? [] : matched.slice(1);
    return { outcome: 'arm', arms: run, skipped, why: '' };
  }
  // Nothing matched, but something could not be judged → UNKNOWN, not `none`. Sending this item to `otherwise`
  // would be the v1637 bug: acting on an unreachable answer as though it were a negative one.
  if (unknowns.length) return { outcome: 'unknown', arms: [], skipped: [], why: unknowns.slice(0, 3).join('; ') };
  return { outcome: 'none', arms: [], skipped: [], why: '' };
}

/**
 * Honest tally for a branch run. PURE. Every outcome class is named INCLUDING the zeroes — a class silently
 * absent reads as "did not happen" when it may mean "not counted" (the §5.5 disposition rule).
 */
export function branchTally(results, { arms = [] } = {}) {
  const list = _arr(results);
  const byArm = new Map(arms.map((a) => [a.label, 0]));
  let none = 0; let unknown = 0; let skippedAny = 0;
  for (const r of list) {
    if (!r) continue;
    if (r.outcome === 'arm') { for (const a of _arr(r.arms)) byArm.set(a.label, (byArm.get(a.label) || 0) + 1); if (_arr(r.skipped).length) skippedAny++; }
    else if (r.outcome === 'none') none++;
    else unknown++;
  }
  const parts = [...byArm.entries()].map(([label, n]) => `${label} ${n}`);
  parts.push(`no arm ${none}`);
  parts.push(`couldn’t tell ${unknown}`);
  if (skippedAny) parts.push(`${skippedAny} matched >1 arm (first only)`);
  return `${list.length} item${list.length === 1 ? '' : 's'} — ${parts.join(' · ')}`;
}
