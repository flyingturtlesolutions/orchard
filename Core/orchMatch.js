// Core/orchMatch.js — ORCH-M0: the pure HIT/MISS matcher core (Intent Orchestration).
//
// The riskiest mechanic in the orchestrator: given the user's ask + the live page + the grounded library,
// decide HIT (run a capability) vs MISS (capture one). It is a PRECISION problem, not recall — a wrong HIT
// fires the wrong thing on a live page; a wrong MISS only costs a demo. So the funnel filters on GROUNDING
// (hard, deterministic) before ranking on MEANING (fuzzy), and the uncertain middle becomes a cheap PROPOSE
// rather than a silent fire.
//
// This module is the PURE skeleton (no DOM / chrome / LLM): the projection, the Ground/Locale scope
// partition, and the three-way gate (auto / propose / miss) with the reversibility veto. The two fuzzy/live
// inputs are INJECTED SEAMS so the funnel stays testable and the smarter pieces plug in later:
//   • `score(ask, candidate) -> {relevance, isExact, effectEligible}` — lexical here; the LLM select+bind
//     call (ORCH-M) replaces it, where `effectEligible` becomes a real effect-qualifier.
//   • `runnableHere(candidate) -> bool` — the live precondition evaluation (TemplateWalker.checkConditions)
//     supplies this; defaults to true.
//
// See docs/DESIGN_intent_orchestration.md §4–§6.
//
// @module Core/orchMatch
// @version 2.74.663

// Irreversibility heuristic (skeleton — the real classifier is PB-4's safety classing). Conservative by
// design: over-flagging just forces a confirm (safe). Reversibility is a HARD VETO on auto-fire.
const _IRREVERSIBLE = /\b(appl(?:y|ies|ied|ying)|submit|send|buy|purchase|checkout|pay|order|book|delete|remove|confirm|post|publish|withdraw|transfer)\b/i;

// Minimal function-word stoplist — keep domain words (jobs, search, filter, pay…) meaningful.
const _STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'on', 'in', 'by', 'with', 'only', 'i', 'me', 'my', 'please', 'want', 'would', 'like', 'show', 'and', 'or', 'that', 'this', 'these', 'those', 'is', 'are']);

const _norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function _tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && t.length > 1 && !_STOP.has(t));
}
function _jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Project a stored capability (+ optional strategy) into a normalized matchable Candidate. PURE.
 * The matchable surface is assembled from wherever it lives (capability / strategy): intent (description),
 * aliases (the use-accreted synonyms), params, effect (postcondition), and reversibility.
 * @returns {object|null} { id, groundId, localeUrl, intent, aliases[], params[], effect, reversible,
 *                          strategyId, health, raw } — or null for a malformed input.
 */
export function toCandidate(capability, strategy = null) {
  if (!capability || typeof capability !== 'object') return null;
  const intent = capability.intent || capability.description || (strategy && strategy.goal) || '';
  const aliasSrc = (strategy && Array.isArray(strategy.aliases) && strategy.aliases.length)
    ? strategy.aliases
    : (Array.isArray(capability.aliases) ? capability.aliases : []);
  const aliases = aliasSrc.filter((x) => typeof x === 'string' && x.trim());
  const params = Array.isArray(capability.params) ? capability.params : [];
  const effect = capability.effect || (strategy && strategy.postconditions) || null;
  const reversible = (typeof capability.reversible === 'boolean')
    ? capability.reversible
    : !_IRREVERSIBLE.test([intent, ...aliases].join(' '));
  return {
    id: capability.id,
    groundId: capability.groundId || (strategy && strategy.groundId) || null,
    localeUrl: capability.localeUrl || '',
    intent, aliases, params, effect, reversible,
    strategyId: capability.strategyId || (strategy && strategy.id) || null,
    health: capability.health || null,    // {successes, failures, lastOkAt} — populated by ORCH-G (OUTCOMES)
    raw: capability,
  };
}

/**
 * Funnel stages 0–1: scope candidates to the current Ground/Locale and partition by executability. PURE.
 * `sameLocale` (URL equality — inject normalizeUrl-based) and `runnableHere` (live precondition check) are
 * injected; defaults make it a pure exact-match + always-runnable. Off-Ground candidates are dropped.
 * @returns {{here:object[], reachable:object[], off:object[]}}  here = runnable now; reachable = same Ground,
 *          another Locale (needs a navigate); off = different Ground (not a candidate).
 */
export function scopeAndPartition(candidates, { currentGroundId = null, currentLocaleUrl = '', sameLocale = (a, b) => a === b, runnableHere = () => true } = {}) {
  const here = [], reachable = [], off = [];
  for (const c of (Array.isArray(candidates) ? candidates : [])) {
    if (!c) continue;
    if (currentGroundId && c.groundId && c.groundId !== currentGroundId) { off.push(c); continue; }
    if (c.localeUrl && currentLocaleUrl && sameLocale(c.localeUrl, currentLocaleUrl) && runnableHere(c)) here.push(c);
    else reachable.push(c);
  }
  return { here, reachable, off };
}

/** Default lexical scorer — the SKELETON stand-in for the LLM select+bind call. Exact alias → relevance 1;
 *  else token Jaccard over intent+aliases. `effectEligible` is true here (lexical can't reason about effect);
 *  the LLM scorer makes it a real qualifier. PURE. */
export function lexicalScore(ask, candidate) {
  const isExact = (candidate.aliases || []).some((al) => _norm(al) === _norm(ask));
  const relevance = isExact ? 1 : _jaccard(_tokens(ask), _tokens([candidate.intent, ...(candidate.aliases || [])].join(' ')));
  return { relevance, isExact, effectEligible: true };
}

// Skeleton bands. The real gate (ORCH-G) makes these per-(fragment, ask-pattern), graduated by OUTCOMES.
export const DEFAULT_THRESHOLDS = Object.freeze({ auto: 0.6, propose: 0.2, margin: 0.12 });

/**
 * Funnel stage 2 + the three-way gate. Effect-qualify → rank → decide auto / propose / miss, with the
 * reversibility hard veto. PURE. `score` defaults to lexicalScore; inject the LLM scorer to upgrade.
 * The `reason` strings double as the assistant's explanation copy (the funnel order IS the UX copy).
 * @returns {{decision:'auto'|'propose'|'miss', candidate:(object|null), reason:string, score?:number,
 *            isExact?:boolean, margin?:number, runnerUp?:(object|null), alternatives:object[]}}
 */
export function rankAndDecide(ask, scoped, { score = lexicalScore, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const here = Array.isArray(scoped) ? scoped : [];
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const scored = here.map((c) => ({ candidate: c, ...score(ask, c) })).filter((s) => s.effectEligible);
  scored.sort((a, b) => (b.relevance - a.relevance) || ((b.isExact ? 1 : 0) - (a.isExact ? 1 : 0)));

  if (!scored.length) {
    return { decision: 'miss', candidate: null, reason: here.length ? 'no-eligible-effect' : 'no-capability', alternatives: [] };
  }
  const top = scored[0];
  const runnerUp = scored[1] || null;
  const margin = top.relevance - (runnerUp ? runnerUp.relevance : 0);
  const irreversible = top.candidate.reversible === false;
  const base = {
    candidate: top.candidate, score: top.relevance, isExact: !!top.isExact, margin,
    runnerUp: runnerUp ? runnerUp.candidate : null,
    alternatives: scored.slice(0, 3).map((s) => ({ id: s.candidate.id, intent: s.candidate.intent, relevance: s.relevance })),
  };

  if (top.relevance < t.propose) return { ...base, decision: 'miss', reason: 'below-floor' };
  // Two close, non-exact contenders → disambiguate rather than guess.
  if (runnerUp && margin < t.margin && !top.isExact) return { ...base, decision: 'propose', reason: 'ambiguous' };
  const strong = top.isExact || top.relevance >= t.auto;
  // Strong + clear + reversible → auto-fire; irreversible NEVER autos (safety veto) → confirm.
  if (strong && !irreversible) return { ...base, decision: 'auto', reason: top.isExact ? 'alias-exact' : 'confident' };
  if (strong && irreversible) return { ...base, decision: 'propose', reason: 'irreversible-confirm' };
  return { ...base, decision: 'propose', reason: 'low-confidence' };
}

/**
 * End-to-end convenience: project (if needed) → scope/partition → rank/decide. PURE. Accepts raw capabilities
 * or already-projected Candidates. `ctx` carries {currentGroundId, currentLocaleUrl, sameLocale, runnableHere,
 * score, thresholds}.
 * @returns the rankAndDecide result plus `scoped:{here,reachable,off}` counts (so a MISS can distinguish
 *          "nothing on this site" from "the thing exists but isn't runnable here / needs a navigate").
 */
export function matchAsk(ask, candidates, ctx = {}) {
  const projected = (Array.isArray(candidates) ? candidates : [])
    .map((c) => (c && typeof c.reversible === 'boolean' && c.intent !== undefined) ? c : toCandidate(c))
    .filter(Boolean);
  const parts = scopeAndPartition(projected, ctx);
  const decision = rankAndDecide(ask, parts.here, ctx);
  return { ...decision, scoped: { here: parts.here.length, reachable: parts.reachable.length, off: parts.off.length } };
}
