// Core/orchShadow.js — ORCH-CB: SHADOW comparison of the LLM plan vs the comprehend→bind path. PURE.
//
// Observational only: run BOTH paths and LOG how they diverge, to build confidence BEFORE the warm-path swap
// (route→comprehend→bind replacing ORCH_PLAN's monolith). It answers the one question the swap hinges on: how much
// of the WARM case does the deterministic floor already cover? High agreement → the floor suffices and the swap is
// safe; low → the swap needs LLM-backed binding for the slots the floor misses. No DOM / chrome / LLM.
//
// @module Core/orchShadow
// @version 2.74.738

/** A coarse shape label for a plan's steps (bound or not). PURE. */
export function planShapeLabel(steps) {
  const flat = Array.isArray(steps) ? steps : [];
  if (flat.some((s) => s && (s.kind === 'foreach' || s.kind === 'loop'))) return 'foreach';
  if (flat.some((s) => s && s.kind === 'gate')) return 'conditional';
  if (flat.length > 1) return 'sequence';
  if (flat.length === 1) return 'single';
  return 'empty';
}

/** Collect every bound capabilityId in a plan tree (descending into control-flow bodies). PURE. */
function _boundIds(steps, out) {
  for (const s of (Array.isArray(steps) ? steps : [])) {
    if (!s) continue;
    if (s.capabilityId) out.push(s.capabilityId);
    if (Array.isArray(s.body)) _boundIds(s.body, out);
  }
  return out;
}

/**
 * Compare the LLM plan against the comprehend→bind result. PURE. Shape agreement + binding overlap (how many of
 * the LLM's bindings the deterministic floor independently reached).
 * @param {object[]} llmSteps  the live ORCH_PLAN output (post-lift)
 * @param {object[]} cbSteps   the comprehend→bind output
 * @returns {{shapeMatch:boolean, llmShape:string, cbShape:string, llmBound:number, cbBound:number,
 *            agreeCount:number, agreement:number}}
 */
export function shadowCompare(llmSteps, cbSteps) {
  const llmShape = planShapeLabel(llmSteps);
  const cbShape = planShapeLabel(cbSteps);
  const llmIds = _boundIds(llmSteps, []);
  const cbSet = new Set(_boundIds(cbSteps, []));
  const agree = llmIds.filter((id) => cbSet.has(id)).length;
  return {
    shapeMatch: llmShape === cbShape,
    llmShape,
    cbShape,
    llmBound: llmIds.length,
    cbBound: cbSet.size,
    agreeCount: agree,
    agreement: llmIds.length ? agree / llmIds.length : (cbSet.size ? 0 : 1),
  };
}
