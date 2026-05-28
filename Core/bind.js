// Core/bind.js — SG-4 (Bind), the adapter half. DESIGN §4.4/§SG-4. PURE, NO LLM.
//
// The prove ENGINE already exists (Core/trialSynth.synthesizeTrialOp + the RUN_PERSPECTIVE_TRIAL runner +
// safety classing + scoring). SG-4 doesn't rebuild it — it feeds the Comprehend→Select→Cover output into
// it. This module turns a Select selection (SG-2) into the `roles` bundle synthesizeTrialOp consumes:
//   roles: [{ role, selector, featureId, multiplicity, hidden?, revealedBy? }]
//
// Contract notes that shape this adapter:
//   - synthesizeTrialOp classifies each role by feature.kind (looked up via the locale by featureId), so
//     we always carry featureId — kind comes from the SUBSTRATE, not a guessed name.
//   - reveal sequencing matches a hidden role's `revealedBy` to a TRIGGER's ROLE NAME (not a feature id).
//     The Locale stores revealedBy as a feature id, so we resolve the trigger feature, include it as a
//     role, and rewrite revealedBy to the trigger's role name.
//   - complete intent → roles = the page-required fields (the Cover floor) + the success action.
//     read/act/navigate → roles = the matched features (synth picks reads for EXTRACT, actions for CLICK).
//
// PURE: no DOM/LLM/storage. Unit-testable like the other SG stages.
// @module Core/bind
// @version 2.74.579

const _roleName = (f) => (f && typeof f.label === 'string' && f.label.trim()) ? f.label.trim() : (f && f.id) || '';

/**
 * Build the trial `roles` bundle from a Select selection. PURE.
 * @param {object} spec       IntentSpec (SG-1) — uses shape.
 * @param {object} selection  Select output (SG-2): { boundary:{requiredFields,successAction}, matches }.
 * @param {object} [locale]   Locale — to resolve matched featureIds (non-complete) + reveal triggers.
 * @returns {Array<{role:string,selector:string,featureId:string,multiplicity:string,hidden?:boolean,revealedBy?:string}>}
 */
export function selectionToTrialRoles(spec, selection, locale = null) {
  const sel = selection || {};
  const feats = (locale && locale.features && typeof locale.features === 'object') ? locale.features : {};
  const roles = [];
  const seen = new Set();

  const roleFor = (f) => {
    if (!f || !f.selector || seen.has(f.id)) return null;
    const role = { role: _roleName(f), selector: f.selector, featureId: f.id, multiplicity: 'one' };
    if (f.hidden) {
      // Resolve the trigger feature and include it FIRST, rewriting revealedBy to its role name so the
      // synth's reveal step can find it (it matches revealedBy === a role name).
      const trig = f.revealedBy ? feats[f.revealedBy] : null;
      if (trig && trig.selector && !seen.has(trig.id)) { seen.add(trig.id); roles.push({ role: _roleName(trig), selector: trig.selector, featureId: trig.id, multiplicity: 'one' }); }
      role.hidden = true;
      role.revealedBy = trig ? _roleName(trig) : null;
    }
    seen.add(f.id);
    return role;
  };
  const push = (f) => { const r = roleFor(f); if (r) roles.push(r); };

  if (spec && spec.shape === 'complete') {
    const b = sel.boundary || {};
    for (const f of (Array.isArray(b.requiredFields) ? b.requiredFields : [])) push(f);
    if (b.successAction) push(b.successAction);     // the commit; safety class defers it if irreversible
  } else {
    // read / act / navigate — the matched features (resolved via the locale).
    const ids = new Set();
    for (const arr of Object.values(sel.matches || {})) for (const id of (Array.isArray(arr) ? arr : [])) ids.add(id);
    for (const id of ids) push(feats[id]);
  }
  return roles;
}
