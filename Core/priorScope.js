/**
 * Core/priorScope.js — PP-4 (v2.74.1686): the EMPTY-PRIOR STOP. Pure.
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §0 (the shape) · §5.5 (name every class, including the zeroes).
 *
 * ── THE LIVE FAILURE ────────────────────────────────────────────────────────────────────────────────────────
 * gl 2026-07-22 (trace 070307). A four-step workflow narrowed to nothing and kept going:
 *
 *     BRANCH ▸ narrowed prior → 0 of 1 (single arm "replacement requested")
 *     … next step: "create a new case listing the number and type of replacement"
 *     INTERPRET_ASK → act leg=me.zendesk.create_ticket@deako.zendesk.com   ← dispatched. Twice.
 *
 * The narrowing code already anticipated this. Its comment reads: *"An empty prior makes the next clause report
 * 'nothing to work with', which is the honest outcome."* That is true of a per-item CLAUSE — `map`, `fieldRead`,
 * `branch` and `write` all consult the prior and stop on their own. It is NOT true of an `act`, which resolves a
 * leg from the ask alone and never looks at the working set. So the honest outcome was real, and one dispatch
 * path walked straight past it into an outward write on a system the workflow never named.
 *
 * ── WHY THE GUARD IS NARROW ─────────────────────────────────────────────────────────────────────────────────
 * "Empty prior → stop everything" would be wrong. A step is allowed not to depend on the previous one ("now open
 * shopify.com", "check the vitals"), and halting those would turn a helpful guard into an obstacle.
 *
 * So BOTH conditions must hold:
 *   1. a prior step actually PRODUCED a collection, and it is now empty — an empty array, not a missing value.
 *      `[]` and `null` are the load-bearing distinction: `[]` means "we looked and found none", `null` means
 *      "nothing has run yet", and only the first is evidence about the next step.
 *   2. the step's own language POINTS AT that collection — "each", "those", "them", "the ones".
 *
 * Both together mean the user's sentence refers to a set we know to be empty. That is not an error and not a
 * failure: it is a complete, correct answer, and it is the one thing the run can say with certainty.
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/**
 * Does this step's language refer to a set a previous step produced? PURE.
 *
 * Deliberately conservative — it matches back-reference words, not topic overlap. A step that happens to mention
 * the same nouns ("create a warranty summary") is NOT a back-reference and must not be stopped; only an explicit
 * pointer counts. False negatives here cost a wasted step; false positives block work the user asked for.
 */
export function refersToPrior(text) {
  const t = _str(text).toLowerCase();
  if (!t) return false;
  return /\b(each|those|them|these|they|the ones|the rest|all of it|that list|the list|the results?)\b/.test(t)
    || /\bfor\s+(each|every|all)\b/.test(t);
}

/**
 * Did a prior step produce a collection that came back EMPTY? PURE.
 *
 * `[]` → true (we looked, there were none). `null`/`undefined` → false (nothing has run). A non-empty array or a
 * non-array value → false. The wrapper shape `{results: []}` counts too, since that is what a read returns before
 * anything narrows it.
 */
export function priorIsEmptySet(priorValue) {
  if (Array.isArray(priorValue)) return priorValue.length === 0;
  if (priorValue && typeof priorValue === 'object' && Array.isArray(priorValue.results)) return priorValue.results.length === 0;
  return false;
}

/**
 * Should this step stop before it runs? PURE.
 *
 * @returns {{stop:boolean, why:string, message:string}}  `message` is user-facing and says what is true rather
 *          than what failed — a run that correctly found nothing has not gone wrong, and must not read as if it
 *          had. Reporting it as an error is how a person learns to ignore the report.
 */
export function emptyPriorStop(spec) {
  // A destructuring default covers `undefined` only — `emptyPriorStop(null)` would throw, and this is called on
  // the path whose entire job is to stop a write. It fails OPEN (no stop) rather than throwing into the caller's
  // catch, where an exception would read as "the guard ran and declined to stop".
  const { text = '', priorValue = null, narrowedFrom = 0 } = (spec && typeof spec === 'object') ? spec : {};
  if (!priorIsEmptySet(priorValue)) return { stop: false, why: '', message: '' };
  if (!refersToPrior(text)) return { stop: false, why: 'no-back-reference', message: '' };
  const from = Number(narrowedFrom) > 0 ? Number(narrowedFrom) : 0;
  return {
    stop: true,
    why: 'empty-prior',
    message: from
      ? `Nothing to do here — the last step matched **0 of ${from}**, so there is nothing for this step to act on. Nothing was created or sent.`
      : 'Nothing to do here — the last step came back empty, so there is nothing for this step to act on. Nothing was created or sent.',
  };
}
