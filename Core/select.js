// Core/select.js — SG-2 (Select), pure foundation. DESIGN_substrate_grounded_capabilities §4.2/§SG-2.
//
// Select is the "new proposal": a QUERY over the Locale (retrieval), not generation. This module is the
// deterministic half — given an IntentSpec (SG-1) + a Locale (SG-0.5) it (a) retrieves candidate features
// and (b) computes the COMPLETENESS BOUNDARY for a `complete` intent.
//
// The boundary rule (validated by the live BambooHR comprehension, §SG-2): for an exhaustive `complete`
// intent the completeness set is the PAGE's required features (the SG-0.5 `required` flag) + the success
// action — NOT the spec's subGoals. A page-independent prior can't enumerate every field a form demands
// (the live prior missed location / desired-pay / date-available); subGoals are a semantic SCAFFOLD for
// grouping + data-sourcing (matched by the LLM in SG-2b), while the page is the source of truth for
// "what must be filled." Honeypot decoys and non-submit actions (cancel/reset) are excluded.
//
// PURE: no DOM, no LLM, no storage. SG-2b layers the LLM subGoal→feature match + scope reconciliation on
// top; SG-3 Cover gates on `boundary.requiredFields`. Unit-testable like Core/intentSpec.js.
//
// @module Core/select
// @version 2.74.572

const _features = (locale) =>
  (locale && locale.features && typeof locale.features === 'object') ? Object.values(locale.features) : [];

const _hasSelector = (f) => typeof f.selector === 'string' && !!f.selector;

/** A page-required, fillable input — the unit of the completeness boundary. Decoys (honeypots) excluded. */
function isRequiredField(f) {
  return !!f && f.kind === 'input' && f.required === true && f.decoy !== true && _hasSelector(f);
}

/** The success action: a feature that COMMITS the form (effect:'submit'). Cancel/reset are effect:'none'. */
function isSuccessAction(f) {
  return !!f && f.kind === 'action' && f.interaction && f.interaction.effect === 'submit';
}

/**
 * The completeness boundary for a `complete` intent: every page-required field + the success action(s).
 * This is what Cover (SG-3) must satisfy — independent of the spec's subGoals.
 * @returns {{requiredFields:object[], successActions:object[], successAction:object|null}}
 */
export function coverageBoundary(locale) {
  const feats = _features(locale);
  const requiredFields = feats.filter(isRequiredField);
  const successActions = feats.filter(isSuccessAction);
  return {
    requiredFields,
    successActions,
    // Prefer a single unambiguous success action; if several, leave disambiguation to SG-2b (by label).
    successAction: successActions.length === 1 ? successActions[0] : null,
  };
}

/**
 * Retrieve candidate features relevant to the intent shape — the pure pre-filter the LLM match (SG-2b)
 * ranks over. Narrow by kind so the matcher sees a focused set, not the whole page.
 *  - complete → fillable inputs (non-decoy) + form actions (submit/cancel) — the form surface.
 *  - read     → content regions/collections + inputs (a value to read).
 *  - act / navigate → actions + navigation + disclosures.
 */
export function selectCandidates(locale, spec) {
  const feats = _features(locale);
  const shape = spec && spec.shape;
  if (shape === 'complete') {
    return feats.filter((f) => (f.kind === 'input' && f.decoy !== true) || f.kind === 'action');
  }
  if (shape === 'read') {
    return feats.filter((f) => f.kind === 'collection' || f.kind === 'region' || f.kind === 'input');
  }
  return feats.filter((f) => f.kind === 'action' || f.kind === 'navigation' || f.kind === 'disclosure');
}

// SG-2b retrieval RANK (pure). selectCandidates narrows by KIND; this ORDERS that set by relevance to the
// intent (its `target` + the subGoal phrasing), so the LLM matcher — which only sees a capped slice — gets
// the features that actually serve the intent rather than whatever enumerated first. Without it, a nav-heavy
// page (100+ links) can push the real target past the cap: e.g. a hidden "Continue with Google" poked in
// LATE lands after position 80 and never reaches the matcher → 0 matches → "not runnable" for a page that
// plainly supports it. Lexical token overlap over label + href, with an exact-target-phrase boost. Score 0
// keeps original order (deprioritized, never dropped — the CALLER owns the cap).
const _RANK_STOP = new Set(['the','a','an','to','of','in','on','at','for','and','or','with','your','my','this','that','it','is','be','as','go','page','section','interface','feature','access','locate','open','show','see','view','find','get','use']);
function _rankTokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !_RANK_STOP.has(t));
}
/**
 * @param {object[]} candidates  the kind-narrowed set from selectCandidates
 * @param {object} spec          IntentSpec ({ target, subGoals[] })
 * @returns {object[]}           same features, ordered most-relevant first (stable on ties)
 */
export function rankCandidates(candidates, spec) {
  const list = Array.isArray(candidates) ? candidates : [];
  const q = new Set([
    ..._rankTokens(spec && spec.target),
    ...(((spec && Array.isArray(spec.subGoals)) ? spec.subGoals : []).flatMap((s) => _rankTokens(s && s.label))),
  ]);
  if (!q.size || list.length < 2) return list.slice();   // nothing to rank by → preserve order
  const targetLc = String((spec && spec.target) || '').toLowerCase().trim();
  const scored = list.map((f, i) => {
    let score = 0;
    for (const t of _rankTokens(f && f.label)) if (q.has(t)) score += 2;   // label token hit (strongest)
    for (const t of _rankTokens(f && f.href))  if (q.has(t)) score += 1;   // href path hit (nav targets)
    const labelLc = String((f && f.label) || '').toLowerCase();
    if (targetLc.length > 2 && labelLc.includes(targetLc)) score += 4;     // exact target phrase present
    return { f, i, score };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));               // score desc, stable on ties
  return scored.map((x) => x.f);
}

/**
 * The (pre-LLM) selection bundle: candidates + boundary. `matches` (subGoal→feature) and scope
 * reconciliation are filled by SG-2b (LLM); Cover (SG-3) gates on `boundary.requiredFields`.
 */
export function buildSelection(locale, spec) {
  const shape = spec ? spec.shape : null;
  return {
    shape,
    candidates: selectCandidates(locale, spec),
    boundary: shape === 'complete'
      ? coverageBoundary(locale)
      : { requiredFields: [], successActions: [], successAction: null },
    matches: null,   // SG-2b (LLM subGoal→feature match + scope reconciliation)
  };
}

/**
 * Cover primitive (the seed SG-3 builds on): given the boundary and the set of feature ids that have been
 * BOUND (resolved/filled), report what's missing. Completeness = all required fields bound AND a success
 * action present. PURE.
 * @param {{requiredFields:object[], successAction:object|null}} boundary
 * @param {Set<string>|string[]} boundIds  ids of features already covered
 */
export function coverGaps(boundary, boundIds) {
  const bound = boundIds instanceof Set ? boundIds : new Set(Array.isArray(boundIds) ? boundIds : []);
  const req = (boundary && boundary.requiredFields) || [];
  const missingFields = req.filter((f) => !bound.has(f.id));
  const successBound = !!(boundary && boundary.successAction) && bound.has(boundary.successAction.id);
  return {
    missingFields,
    hasSuccessAction: !!(boundary && boundary.successAction),
    successBound,
    complete: missingFields.length === 0 && successBound,
  };
}

/**
 * SG-2b reconciliation (PURE). Apply the LLM's subGoal→feature mapping over the page's FACTS — the
 * narrowed-LLM contract (§4.2): the LLM proposes the semantic mapping; this code disposes of the facts.
 * It (1) validates the mapping (ids must exist; a feature serves at most one subGoal; no hallucinations),
 * (2) reconciles SCOPE — a subGoal mapping to ≥1 page-`required` feature is effectively required no
 * matter the prior's `optional` (fixes the live screening-questions drift), and (3) surfaces ORPHAN
 * required features: page-required but claimed by no subGoal (the prior under-listed them — location /
 * desired-pay / date-available). Orphans still must be covered; they're flagged for data-sourcing.
 *
 * @param {object} locale
 * @param {object} spec        IntentSpec (subGoals[])
 * @param {object|null} rawMatches  { [subGoalId]: featureId[] } from the LLM (null/garbage tolerated)
 * @returns {{matches:object, featureToSubGoal:object, reconciledSubGoals:object[], orphanRequired:object[], boundary:object}}
 */
export function reconcileMatches(locale, spec, rawMatches) {
  const feats = (locale && locale.features && typeof locale.features === 'object') ? locale.features : {};
  const subGoals = (spec && Array.isArray(spec.subGoals)) ? spec.subGoals : [];
  const sgIds = new Set(subGoals.map((s) => s.id));
  const boundary = coverageBoundary(locale);
  const requiredIds = new Set(boundary.requiredFields.map((f) => f.id));

  // 1. Validate: keep only existing subGoalIds → existing featureIds; a feature serves ONE subGoal.
  const matches = {};
  const featureToSubGoal = {};
  const raw = (rawMatches && typeof rawMatches === 'object' && !Array.isArray(rawMatches)) ? rawMatches : {};
  for (const sgId of Object.keys(raw)) {
    if (!sgIds.has(sgId) || !Array.isArray(raw[sgId])) continue;
    for (const fid of raw[sgId]) {
      if (typeof fid !== 'string' || !feats[fid] || featureToSubGoal[fid]) continue;
      (matches[sgId] = matches[sgId] || []).push(fid);
      featureToSubGoal[fid] = sgId;
    }
  }

  // 2. Reconcile scope — page `required` wins over the prior's `optional`.
  const reconciledSubGoals = subGoals.map((s) => {
    const mapped = matches[s.id] || [];
    const hitsRequired = mapped.some((fid) => requiredIds.has(fid));
    const effectiveScope = (s.scope === 'required' || hitsRequired) ? 'required' : 'optional';
    return { ...s, features: mapped, effectiveScope, scopeChanged: effectiveScope !== s.scope };
  });

  // 3. Orphan required features: page-required, claimed by no subGoal (the prior's coverage gap).
  const orphanRequired = boundary.requiredFields.filter((f) => !featureToSubGoal[f.id]);

  return { matches, featureToSubGoal, reconciledSubGoals, orphanRequired, boundary };
}
