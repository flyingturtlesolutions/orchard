// Core/stepReceipt.js — the per-step OUTCOME RECEIPT (v2.74.1829). PURE: no chrome / DOM / LLM / clock.
//
// WHY THIS EXISTS (findings 2026-07-25 15:36): a 4-step workflow dropped a filter, threw a whole step's work
// away, dropped a per-child directive and skipped a render stage — and `grep -inE "ERROR|WARN|failed|stopped"`
// over the entire trace returned NOTHING but the two errorCapture install lines. Five failures, zero error
// lines. The executor has no notion of "I did LESS than I was told", so doing the job and doing a quarter of
// it look identical from outside.
//
// WHO DECIDES WHAT (v1829, after the v1828 own-goal — read this before adding anything here):
//   • Whether a clause DECLARES a filter is SEMANTIC → the MODEL decides it. `interpret` already returns a
//     `branch` verdict (Core/branchClause.js normalizes it); the caller passes that in as `declared`.
//   • Whether the filter was APPLIED, and to how many rows, is MECHANICAL → this file records it.
// v1828 conflated the two: `declaredPredicate` was a REGEX guessing a semantic question, and it failed on its
// first live run because its noun list was hardcoded ("for each TASK that has…" — `task` wasn't in it). The
// lexical check survives only as `mayDeclareFilter`, a COST GATE + DISAGREEMENT BACKSTOP — the codebase's
// teach-and-guarantee pattern (cf. `personaHint`): it decides whether to spend a model call and it LOGS when
// it disagrees with the model, but it never decides the answer.

/**
 * Cheap lexical hint that a clause MAY declare a filter. NOT a decider — see the header.
 * Two legitimate uses: (a) gate whether to spend an interpret call, (b) flag disagreement when the model
 * returned no branch but this fires. A miss costs a filter we don't apply (status quo, and the receipt says
 * so); a false positive costs one interpret call that comes back empty. Both are cheaper than a wrong answer.
 *
 * The noun between the quantifier and the predicate is the USER'S DOMAIN word — task, ticket, order, customer.
 * A bounded lazy filler accepts any of them instead of a list I happened to think of (the v1828 bug).
 */
export function mayDeclareFilter(clause) {
  const s = String(clause || '');
  const m = s.match(
    /\b(?:for\s+each|foreach|each)\s+(?:\w+\s+){0,3}?((?:with(?:out)?|missing|lacking|having|where|whose|that\s+(?:has|have|lacks?|is|are|isn't|aren't|does\s*n[o']?t|do\s*n[o']?t))\b[^,.;]*)/i,
  );
  if (!m) return null;
  const p = String(m[1] || '').trim().replace(/\s+/g, ' ');
  return p || null;
}

const _n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const _s = (v) => (v == null ? '' : String(v).trim());

/**
 * Build a step receipt. PURE — nothing is inferred about work not done.
 *
 * `declared` is the MODEL's verdict (a branch label/predicate, or ''). `filterApplied` is opt-in: we never
 * infer application from `rowsOut < rowsIn`, because a cap would then masquerade as a filter and a predicate
 * matching every row would read as dropped. Both lies are worse than asking the caller.
 *
 * @param {{ index?: number, total?: number, kind?: string, clause?: string,
 *           declared?: string, filterApplied?: boolean, unknownRows?: number,
 *           rowsIn?: number, rowsOut?: number,
 *           created?: number, updated?: number, skipped?: number,
 *           stopped?: boolean, note?: string }} o
 */
export function buildStepReceipt(o = {}) {
  const clause = _s(o.clause);
  const declared = _s(o.declared);            // authoritative: what the MODEL said
  const hint = mayDeclareFilter(clause);      // backstop only
  const rowsIn = _n(o.rowsIn);
  const rowsOut = _n(o.rowsOut);
  const created = _n(o.created);
  const updated = _n(o.updated);
  const skipped = _n(o.skipped);
  const unknownRows = _n(o.unknownRows);
  const hasArtifacts = created != null || updated != null || skipped != null;
  const touched = (created || 0) + (updated || 0);

  // filterState: what actually happened to the predicate, in one word.
  let filterState = 'none';
  if (declared) filterState = o.filterApplied === true ? 'applied' : 'declared-not-applied';

  // Teach-and-guarantee: the backstop fires ONLY to report a disagreement it is not allowed to resolve.
  const disagreement = (!declared && hint) ? hint : '';

  let outcome;
  if (o.stopped) outcome = 'stopped';
  else if (rowsIn === 0) outcome = 'empty-in';
  else if (hasArtifacts && touched === 0) outcome = 'no-op';
  else outcome = 'ok';

  return {
    index: _n(o.index),
    total: _n(o.total),
    kind: _s(o.kind) || 'step',
    clause,
    declared,
    hint,
    disagreement,
    filterState,
    filterApplied: declared ? o.filterApplied === true : null,
    unknownRows,
    rowsIn,
    rowsOut,
    created,
    updated,
    skipped,
    hasArtifacts,
    outcome,
    note: _s(o.note),
  };
}

/** Render a receipt as the one-line `STEP ▸` trace marker. PURE. (Registered in studio.js `_DECISION_RE`.) */
export function renderStepReceipt(r) {
  if (!r || typeof r !== 'object') return '';
  const parts = [];
  // v1829 — only claim a position when there IS one. Every workflow step runs as its own single-clause chain,
  // so the loop's i/total said "1/1" for what were steps 3 and 4 of 4. False precision in a diagnostic line is
  // worse than none: it invites you to trust a number that is measuring something else.
  const pos = (r.index != null && r.total != null && r.total > 1) ? `${r.index}/${r.total} ` : '';
  parts.push(`${pos}${r.kind}`);

  if (r.rowsIn != null || r.rowsOut != null) {
    parts.push(`rows ${r.rowsIn == null ? '' : r.rowsIn}→${r.rowsOut == null ? '?' : r.rowsOut}`);
  }
  if (r.filterState === 'applied') {
    parts.push(`filter "${r.declared}" applied${r.unknownRows ? ` (${r.unknownRows} couldn't be judged — excluded)` : ''}`);
  } else if (r.filterState === 'declared-not-applied') {
    // The load-bearing segment: the over-action this file exists to expose.
    parts.push(`filter "${r.declared}" DECLARED-NOT-APPLIED`);
  }
  if (r.disagreement) {
    // The model said "no filter here" and the lexical backstop disagrees. We do NOT act on this — we report it,
    // because one of the two is wrong and the trace is where that gets noticed.
    parts.push(`⚠ no branch from interpret, but the clause reads like a filter ("${r.disagreement}")`);
  }
  if (r.hasArtifacts) {
    parts.push(`cases ${r.created || 0} new/${r.updated || 0} updated/${r.skipped || 0} skipped`);
  }

  let tail = r.outcome;
  if (r.outcome === 'no-op') tail = `NO-OP (nothing created or updated${r.skipped ? `; ${r.skipped} already existed` : ''})`;
  else if (r.outcome === 'empty-in') tail = 'EMPTY-IN (no rows reached this step)';
  parts.push(tail);
  if (r.note) parts.push(r.note);

  return `STEP ▸ ${parts.join(' · ')}`;
}

/** Convenience: build + render in one call. PURE. */
export function stepReceiptLine(o) {
  return renderStepReceipt(buildStepReceipt(o));
}
