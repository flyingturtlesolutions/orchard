// Core/cover.js — SG-3 (Cover). DESIGN_substrate_grounded_capabilities §4.3/§SG-3. PURE, NO LLM.
//
// The completeness GUARANTEE. Given Select's (SG-2) reconciled selection, decide whether the plan covers
// everything the intent REQUIRES — the deterministic floor that bounds the LLM's fuzziness from below.
//
//   complete intent → the floor is the PAGE-REQUIRED fields (the SG-0.5 `required` flag, decoys excluded;
//     boundary.requiredFields). This is independent of the LLM's subGoal matching, so it catches Select's
//     misses: the live BambooHR prior under-listed location / desired-pay / date-available, but those are
//     page-required, so they're in the floor as ORPHANS and still counted. The success action must exist.
//   read / act / navigate → covered when each REQUIRED sub-goal has at least one matched feature.
//
// "operable" is structural: a required field must have a bindable selector AND a value interaction
// (type / select / upload). Whether the RUNTIME op exists (e.g. SET_FILE for upload, SG-#81c) is a Bind
// concern — Cover guarantees the plan is COMPLETE; Bind guarantees each step is EXECUTABLE. Orphans do NOT
// fail Cover (the field is covered; "what value to enter" is a fulfillment/data concern) — they're surfaced.
//
// @module Core/cover
// @version 2.74.578

const VALUE_PATTERNS = new Set(['type', 'select', 'upload']);

/** A required field is structurally operable: a bindable selector + a value-setting interaction. */
function _operable(f) {
  const p = f && f.interaction && f.interaction.pattern;
  return VALUE_PATTERNS.has(p) && typeof f.selector === 'string' && !!f.selector;
}

/**
 * The completeness verdict for an intent over a Select selection. PURE.
 * @param {object} spec       IntentSpec (SG-1) — uses shape + subGoals.
 * @param {object} selection  Select output (SG-2): { boundary:{requiredFields,successAction}, matches,
 *                            featureToSubGoal, orphanRequired, reconciledSubGoals }.
 * @returns {object} verdict { shape, complete, reason, ... }
 */
export function coverComplete(spec, selection) {
  const shape = (spec && spec.shape) || null;
  const sel = selection || {};

  // ── read / act / navigate: each REQUIRED sub-goal needs ≥1 matched feature.
  if (shape !== 'complete') {
    const subGoals = (spec && Array.isArray(spec.subGoals)) ? spec.subGoals : [];
    const matches = sel.matches || {};
    const required = subGoals.filter((s) => (s.scope || 'required') === 'required');
    const unmet = required.filter((s) => !(Array.isArray(matches[s.id]) && matches[s.id].length));
    const complete = required.length === 0 ? true : unmet.length === 0;
    return {
      shape, complete,
      requiredSubGoals: required.map((s) => s.id),
      unmetSubGoals: unmet.map((s) => s.id),
      reason: complete
        ? (required.length ? 'all required sub-goals matched to features' : 'no required sub-goals')
        : `unmatched required sub-goal(s): ${unmet.map((s) => s.id).join(', ')}`,
    };
  }

  // ── complete: the floor is the page-required fields + the success action.
  const boundary = sel.boundary || { requiredFields: [], successAction: null };
  const req = Array.isArray(boundary.requiredFields) ? boundary.requiredFields : [];
  const inoperable = req.filter((f) => !_operable(f));
  const orphanRequired = Array.isArray(sel.orphanRequired) ? sel.orphanRequired.map((f) => f.id) : [];
  const hasSuccessAction = !!boundary.successAction;
  const complete = req.length > 0 && inoperable.length === 0 && hasSuccessAction;

  return {
    shape: 'complete',
    complete,
    completionCount: req.length,
    operableCount: req.length - inoperable.length,
    inoperable: inoperable.map((f) => ({ id: f.id, label: f.label || '' })),
    orphanRequired,            // page-required, no sub-goal claimed them → flag for data sourcing (NOT a failure)
    hasSuccessAction,
    successAction: hasSuccessAction ? { id: boundary.successAction.id, label: boundary.successAction.label || '' } : null,
    reason: complete
      ? `${req.length} required field(s) operable + success action present`
      : !req.length ? 'no required fields found (capture gap?)'
        : !hasSuccessAction ? 'no success action (submit) in the selection'
          : `${inoperable.length} required field(s) not operable (no value op / no selector)`,
  };
}
