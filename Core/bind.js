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
// @version 2.74.599

import { featureToProtoLandmark } from './landmark.js';

const _roleName = (f) => (f && typeof f.label === 'string' && f.label.trim()) ? f.label.trim() : (f && f.id) || '';

// v2.74.594 — mirror Core/trialSynth._fillOpFor so the bound role carries its own fill-op token. This
// makes the binding SELF-CONTAINED: a saved capability replays correctly even after the page is
// re-Explored (featureIds are content-hash-derived, so they change and `features[featureId]` would miss).
// synthesizeTrialOp is feature-FIRST, role-fallback, so carrying kind + fieldType reproduces the EXACT
// same bucket (fill vs act) and op (TYPE/SELECT/SET_FILE) the live trial used, with no live feature.
const _fillType = (f) => {
  const ft = (f && f.fieldType) || '';
  const pat = (f && f.interaction && f.interaction.pattern) || '';
  if (ft === 'file' || pat === 'upload') return 'file';
  if (ft === 'select' || pat === 'select') return 'select';
  return 'text';
};
// Annotate a role with the substrate-derived kind + fill-op so it is replayable without the live feature,
// AND a proto-landmark (recoverable identity: selector + role + accessibleName) so the trial/replay can
// probe-or-recover instead of hard-failing on a stale selector (SG-LM-2/3).
const _annotate = (role, f) => {
  if (f && typeof f.kind === 'string' && f.kind) role.kind = f.kind;
  const tok = _fillType(f);
  if (tok === 'file' || tok === 'select') role.fieldType = tok;   // text is the _fillOpFor default; omit it
  const lm = featureToProtoLandmark(f, role.fieldType);
  if (lm) role.landmark = lm;
  return role;
};

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
    const role = _annotate({ role: _roleName(f), selector: f.selector, featureId: f.id, multiplicity: 'one' }, f);
    if (f.hidden) {
      // Resolve the trigger feature and include it FIRST, rewriting revealedBy to its role name so the
      // synth's reveal step can find it (it matches revealedBy === a role name).
      const trig = f.revealedBy ? feats[f.revealedBy] : null;
      if (trig && trig.selector && !seen.has(trig.id)) { seen.add(trig.id); roles.push(_annotate({ role: _roleName(trig), selector: trig.selector, featureId: trig.id, multiplicity: 'one' }, trig)); }
      role.hidden = true;
      role.revealedBy = trig ? _roleName(trig) : null;
    }
    seen.add(f.id);
    return role;
  };
  const push = (f) => { const r = roleFor(f); if (r) roles.push(r); };

  if (spec && spec.shape === 'complete') {
    const b = sel.boundary || {};
    // The page-`required` fields are the completeness FLOOR (the job-APPLICATION case — every field is
    // mandatory). But a "minimal" completion — e.g. a job SEARCH — has target fields that AREN'T HTML-
    // `required`, so the floor alone binds nothing and the plan isn't runnable. v2.74.595 — also bind
    // whatever Select MATCHED to the sub-goals, so the fields the user actually wants filled are always in
    // the plan (UNION of required ∪ matched ∪ success action; `seen` dedups). Don't filter by `required`.
    for (const f of (Array.isArray(b.requiredFields) ? b.requiredFields : [])) push(f);
    const matchedIds = new Set();
    for (const arr of Object.values(sel.matches || {})) for (const id of (Array.isArray(arr) ? arr : [])) matchedIds.add(id);
    for (const id of matchedIds) push(feats[id]);
    if (b.successAction) push(b.successAction);     // the commit; safety class defers it if irreversible
  } else {
    // read / act / navigate — the matched features (resolved via the locale).
    const ids = new Set();
    for (const arr of Object.values(sel.matches || {})) for (const id of (Array.isArray(arr) ? arr : [])) ids.add(id);
    for (const id of ids) push(feats[id]);
  }
  return roles;
}
