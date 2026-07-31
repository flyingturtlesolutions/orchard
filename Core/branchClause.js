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

/**
 * v2.74.1898 — A PRESENCE QUESTION IS AN ASSERTION, NOT A JUDGEMENT. PURE.
 *
 * Live (gl 18:36): `sort the open tasks in Raleigh into: has a vendor explanation, or blank` → the model wrote BOTH
 * arms as `classify`, and the classifier — which judges prose — answered "indeterminate" eight times about a question
 * `extractValue` settles for free. The prompt's own ⚠ ("PICK BY THE FIELD'S NATURE") did not carry, and the v1690
 * warning has a mirror: a literal form on free text is confidently WRONG; a classify form on a structured question is
 * confidently USELESS.
 *
 * So the recognizable presence shapes are rewritten to `record_field_non_empty` (± negate) at normalization — the
 * same repair-over-instruction precedent as the v1896 arm lift, one block up. ANCHORED on purpose: "has a/an <field>",
 * "<field> is blank/empty/missing", "no <field>", "blank"/"empty" alone (which inherit the field from a sibling arm —
 * the live ask's second arm was the bare word "blank"). "is the note hasty?" matches nothing here.
 * Returns { fieldPhrase, negate } | null. The CALLER decides whether fieldPhrase resolves against real rows — this
 * module has no rows, and an unresolvable phrase must stay a classify arm rather than become a wrong assertion.
 */
export function presenceShape(is, label = '') {
  const t = _str(is).toLowerCase() || _str(label).toLowerCase();
  if (!t) return null;
  // The article is consumed WITH its trailing space or not at all — `(?:a|an|the)?\s*` bit "an appointment" into
  // "n appointment" (alternation took "a", `\s*` matched nothing). Caught by this function's own test.
  let m = t.match(/^has\s+(?:(?:a|an|the)\s+)?(.+)$/);       // "has a vendor explanation"
  if (m) return { fieldPhrase: m[1].trim(), negate: false };
  m = t.match(/^(?:no|missing|without)\s+(.+)$/);           // "no vendor explanation"
  if (m) return { fieldPhrase: m[1].trim(), negate: true };
  m = t.match(/^(.+?)\s+is\s+(?:blank|empty|missing|absent|not\s+set)$/);   // "<field> is blank"
  if (m) return { fieldPhrase: m[1].trim(), negate: true };
  if (/^(?:blank|empty|missing|absent|none|not\s+set)$/.test(t)) return { fieldPhrase: '', negate: true };   // bare — field from a sibling
  return null;
}

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
  let _lifted = 0; let _dropped = 0;
  for (const a0 of _arr(o.arms)) {
    if (!a0 || typeof a0 !== 'object') { _dropped++; continue; }
    // v2.74.1896 — LIFT A FLATTENED ASSERTION. Live (gl 18:06) every arm arrived as
    //     {"label":"needs a replacement","type":"classify","is":"needs a replacement","field":"Instructions"}
    // — the assertion inline on the arm instead of nested under `when` — so all three were dropped, the verdict
    // normalized to null, and the turn asked the user for the groups they had just named. The MEANING was right
    // twice in a row; only the envelope was missing.
    //
    // The lift is unambiguous: an arm is {label, when, then}, so a top-level `type` can only be an assertion that
    // lost its wrapper. Repairing it here rather than in the prompt is the difference between a guarantee and a
    // request — and for a CLASSIFY arm the wrapper carries nothing anyway (`when.label` is forced to the arm's
    // label eleven lines down), which is why this is the shape a model reaches for.
    const a = (!a0.when && a0.type)
      ? { label: a0.label, then: a0.then, when: { type: a0.type, label: a0.label, ...(a0.is !== undefined ? { is: a0.is } : {}), ...(a0.field !== undefined ? { field: a0.field } : {}), ...(a0.fieldName !== undefined ? { fieldName: a0.fieldName } : {}), ...(a0.binding !== undefined ? { binding: a0.binding } : {}), ...(a0.value !== undefined ? { value: a0.value } : {}), ...(a0.values !== undefined ? { values: a0.values } : {}), ...(a0.specJson !== undefined ? { specJson: a0.specJson } : {}), ...(a0.negate !== undefined ? { negate: a0.negate } : {}) } }
      : a0;
    if (!a.when || typeof a.when !== 'object') { _dropped++; continue; }   // `when` is an ASSERTION, never prose (§1.2)
    if (a !== a0) _lifted++;
    const label = _str(a.label) || `arm ${arms.length + 1}`;
    // v2.74.1663 (bug pass) — THE ARM'S LABEL IS AUTHORITATIVE, and a model-classified `when` is forced to it.
    //
    // A classify arm is decided by matching the label the classifier RETURNS against the one on the assertion.
    // The label sent to the classifier is the ARM's, so if `when.label` were absent or merely different — a
    // model writing {"label":"Replacements"} against an arm called "replacements", say — every classify arm
    // would evaluate FALSE and every item would land in `none`. A whole run reporting "no arm matched", with a
    // correct-looking tally and no error anywhere. Forcing the two to agree removes the failure mode instead of
    // documenting it.
    const when = (a.when.type === 'classify') ? { ...a.when, label } : a.when;
    arms.push({ when, label, then: _arr(a.then) });
  }
  // v2.74.1896 — a DROP SAYS SO. The regression above was invisible for an hour because a null verdict downgrades to
  // a clarify whose `why` still describes a correct plan: the decisions view showed a model that had understood and a
  // system asking what it had just been told. `reason` travels with the null so the caller can log what was wrong,
  // the same rule as v1857's "every early exit names itself".
  if (!arms.length) {
    normalizeBranchVerdict.reason = _dropped ? `${_dropped} arm(s) carried no usable "when" assertion` : 'no arms';
    return null;
  }
  normalizeBranchVerdict.reason = '';
  const mode = BRANCH_MODES.includes(o.mode) ? o.mode : 'first';
  return {
    kind: 'branch',
    collection: (o.collection && typeof o.collection === 'object') ? o.collection : 'prior',
    arms,
    ...(_lifted ? { lifted: _lifted } : {}),   // the caller reports a repaired shape rather than hiding it
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
