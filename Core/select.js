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
// @version 2.74.623

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
 * @param {{conventions?:{selectorTierHistogram?:Object<string,number>}}} [opts]  GA-5 — per-Ground selector-tier convention histogram (tie-break only)
 * @returns {object[]}           same features, ordered most-relevant first (stable on ties)
 */
export function rankCandidates(candidates, spec, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const q = new Set([
    ..._rankTokens(spec && spec.target),
    ...(((spec && Array.isArray(spec.subGoals)) ? spec.subGoals : []).flatMap((s) => _rankTokens(s && s.label))),
  ]);
  if (!q.size || list.length < 2) return list.slice();   // nothing to rank by → preserve order
  const targetLc = String((spec && spec.target) || '').toLowerCase().trim();
  // v2.74.841 (GA-5) — a per-Ground selector-tier convention histogram ({tier: weight}) breaks TIES among equal-score
  // candidates toward the tier this Ground's accepted/corrected selectors have favored, so the durable ones survive
  // the downstream top-100 cap. Additive: a candidate's own match score always dominates; conventions only order
  // equals. No-op when the histogram is absent/empty (every weight 0 → falls back to the stable original index).
  const _convHist = (opts && opts.conventions && opts.conventions.selectorTierHistogram) ? opts.conventions.selectorTierHistogram : null;
  const _convPref = (f) => (_convHist && f && f.selectorKind && typeof _convHist[f.selectorKind] === 'number') ? _convHist[f.selectorKind] : 0;
  const scored = list.map((f, i) => {
    let score = 0;
    for (const t of _rankTokens(f && f.label)) if (q.has(t)) score += 2;   // label token hit (strongest)
    for (const t of _rankTokens(f && f.href))  if (q.has(t)) score += 1;   // href path hit (nav targets)
    const labelLc = String((f && f.label) || '').toLowerCase();
    if (targetLc.length > 2 && labelLc.includes(targetLc)) score += 4;     // exact target phrase present
    return { f, i, score };
  });
  scored.sort((a, b) => (b.score - a.score) || (_convPref(b.f) - _convPref(a.f)) || (a.i - b.i));   // score desc · Ground's favored selector tier (GA-5) · stable on ties
  return scored.map((x) => x.f);
}

/**
 * SG-RES-7b (slice 2) — resolve an intent to Locale GOAL id(s) by LABEL match. PURE, no LLM. The matcher
 * ANCHOR is the primary grounding signal (bind.js SG-RES-7 walks the goal a matched feature belongs to);
 * this is the ZERO-ANCHOR fallback — when the LLM matched no feature at all, we can still bind the goal the
 * user NAMED by matching the intent's `target` + subGoal phrasing against the goal labels. Same token-
 * overlap scoring as rankCandidates, with an exact-phrase boost (either direction). Deliberately
 * conservative: a wrong fuzzy match would fill the WRONG form, so we (a) require a real signal (>= `min`)
 * and (b) ABSTAIN when the top goal is not a clear winner (tie at the top → []), preferring an unrunnable
 * plan over a confidently-wrong one. A human still accepts/rejects the resulting trial. Returns goalIds
 * best-first capped at `top`; [] when nothing clears the bar or the top is ambiguous.
 * @param {object} locale  Locale with a `goals` map ({ [id]: { id, label, achievableVia } }).
 * @param {object} spec    IntentSpec ({ target, subGoals[] }).
 * @param {{min?:number, top?:number}} [opts]
 * @returns {string[]}     resolved goal ids, best-first
 */
export function resolveIntentGoals(locale, spec, opts = {}) {
  const min = Number.isFinite(opts.min) ? opts.min : 2;
  const top = Number.isFinite(opts.top) ? Math.max(1, opts.top) : 1;
  const goals = (locale && locale.goals && typeof locale.goals === 'object') ? Object.values(locale.goals) : [];
  if (!goals.length) return [];
  const q = new Set([
    ..._rankTokens(spec && spec.target),
    ...(((spec && Array.isArray(spec.subGoals)) ? spec.subGoals : []).flatMap((s) => _rankTokens(s && s.label))),
  ]);
  if (!q.size) return [];
  const targetLc = String((spec && spec.target) || '').toLowerCase().trim();
  const scored = goals.map((g) => {
    let score = 0;
    for (const t of _rankTokens(g && g.label)) if (q.has(t)) score += 2;       // label token hit
    const labelLc = String((g && g.label) || '').toLowerCase().trim();
    if (targetLc.length > 2 && labelLc.length > 2 && (labelLc.includes(targetLc) || targetLc.includes(labelLc))) score += 4;   // phrase containment, either way
    return { id: g && g.id, score };
  }).filter((x) => x.id && x.score >= min);
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  if (top === 1 && scored.length > 1 && scored[1].score === scored[0].score) return [];   // ambiguous top → abstain
  return scored.slice(0, top).map((x) => x.id);
}

/**
 * GA-7 — AUTHORING COVERAGE: which of a Locale's goals already have an authored capability, and which don't. PURE.
 * This is the STOPPING CONDITION for an unattended author — without it the build loop has no notion of "done", can't
 * prioritize the unauthored goals, and re-grinds goals it already covers. A goal is COVERED when some capability's
 * intent token-overlaps the goal label by >= `min` (approximate — a canonical intent signature would sharpen it).
 * Read-only; never mutates.
 * @param {Array<{id:string,label?:string}>} goals  the Locale's goals (Object.values(locale.goals))
 * @param {Array<{id?:string,capabilityId?:string,intent?:string,name?:string}>} capabilities  the Ground's capabilities
 * @param {{min?:number}} [opts]
 * @returns {{authored:Array<{goalId:string,label:string,capabilityId:(string|null),score:number}>, unauthored:Array<{goalId:string,label:string}>, total:number, authoredCount:number, coveragePct:number}}
 */
export function authoringCoverage(goals, capabilities, opts = {}) {
  const min = Number.isFinite(opts.min) ? opts.min : 2;
  const caps = (Array.isArray(capabilities) ? capabilities : [])
    .map((c) => ({ id: (c && (c.id || c.capabilityId)) || null, toks: new Set(_rankTokens((c && (c.intent || c.name)) || '')) }))
    .filter((c) => c.toks.size);
  const authored = [];
  const unauthored = [];
  for (const g of (Array.isArray(goals) ? goals : [])) {
    if (!g || g.id == null) continue;
    const gtoks = _rankTokens(g.label || '');
    let best = null, bestScore = 0;
    if (gtoks.length) for (const c of caps) {
      let s = 0; for (const t of gtoks) if (c.toks.has(t)) s++;
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (best && bestScore >= min) authored.push({ goalId: g.id, label: g.label || '', capabilityId: best.id, score: bestScore });
    else unauthored.push({ goalId: g.id, label: g.label || '' });
  }
  const total = authored.length + unauthored.length;
  return { authored, unauthored, total, authoredCount: authored.length, coveragePct: total ? Math.round((authored.length / total) * 100) : 0 };
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
