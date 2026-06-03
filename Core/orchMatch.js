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
// @version 2.74.669

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

// Base bands. ORCH-G graduates the AUTO bar down per-capability as confirmations accrue (promotionBonus).
export const DEFAULT_THRESHOLDS = Object.freeze({ auto: 0.6, propose: 0.2, margin: 0.12 });

// ── ORCH-G — confidence promotion from outcome health ────────────────────────────────────────────────────
// Confirmations train the auto-fire threshold: a capability the user keeps confirming graduates from PROPOSE
// to AUTO. Per-capability for v1 (alias accretion already captures ask-pattern granularity — a confirmed ask
// becomes an alias → exact hit). The reversibility veto and the propose floor still bound it. See §4.

/** Tally a capability's CONFIRMATIONS from an OUTCOMES event stream. PURE. Counts only events explicitly tagged
 *  `detail.confirmed === true` for this capability (so the DERIVE-time 'accept' event doesn't inflate health).
 *  @returns {{successes:number, lastOkAt:number}} */
export function tallyCapabilityConfirmations(events, capabilityId) {
  let successes = 0, lastOkAt = 0;
  const id = String(capabilityId == null ? '' : capabilityId);
  if (!id) return { successes, lastOkAt };
  for (const e of (Array.isArray(events) ? events : [])) {
    if (!e || !e.detail || e.detail.confirmed !== true) continue;
    if (String(e.detail.capabilityId || '') !== id) continue;
    successes++;
    const ts = Number(e.ts || e.timestamp || 0);
    if (ts > lastOkAt) lastOkAt = ts;
  }
  return { successes, lastOkAt };
}

/** Auto-fire bonus from a capability's health: more confirmations → lower the AUTO bar. PURE. Precision-first:
 *  `max` is small (0.2) so a fully-confirmed capability still needs a MODERATE match to auto-fire (auto 0.6 −
 *  0.2 = 0.4 floor), never a weak one; capped so it can't breach the reversibility veto or the propose floor.
 *  Ramps to `max` by ~4 confirmations. Pass `now` (ms) to decay the bonus by recency (half-life ~30d); `now=0`
 *  (the default, e.g. inside the pure gate) skips recency and uses the count alone. */
export function promotionBonus(health, { max = 0.2, now = 0, halfLifeMs = 2592000000 } = {}) {
  const successes = Math.max(0, Number(health && health.successes) || 0);
  if (!successes) return 0;
  let bonus = Math.min(max, 0.06 * Math.min(successes, 5));
  if (now && health && health.lastOkAt) bonus *= Math.pow(0.5, Math.max(0, now - health.lastOkAt) / halfLifeMs);
  return bonus;
}

/**
 * Funnel stage 2 + the three-way gate. Effect-qualify → rank → decide auto / propose / miss, with the
 * reversibility hard veto. PURE. `score` defaults to lexicalScore; inject the LLM scorer to upgrade.
 * The `reason` strings double as the assistant's explanation copy (the funnel order IS the UX copy).
 * @returns {{decision:'auto'|'propose'|'miss', candidate:(object|null), reason:string, score?:number,
 *            isExact?:boolean, margin?:number, runnerUp?:(object|null), alternatives:object[]}}
 */
export function rankAndDecide(ask, scoped, { score = lexicalScore, thresholds = DEFAULT_THRESHOLDS, now = 0 } = {}) {
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
  // ORCH-G — confirmations lower the AUTO bar for this capability (never below the propose floor). `now` (the
  // caller's clock — pure tests pass 0) enables recency decay of stale confirmations.
  const bonus = promotionBonus(top.candidate && top.candidate.health, { now });
  const autoT = Math.max(t.propose, t.auto - bonus);
  const base = {
    candidate: top.candidate, score: top.relevance, isExact: !!top.isExact, margin, bonus,
    runnerUp: runnerUp ? runnerUp.candidate : null,
    alternatives: scored.slice(0, 3).map((s) => ({ id: s.candidate.id, intent: s.candidate.intent, relevance: s.relevance })),
  };

  if (top.relevance < t.propose) return { ...base, decision: 'miss', reason: 'below-floor' };
  // Two close, non-exact contenders → disambiguate rather than guess.
  if (runnerUp && margin < t.margin && !top.isExact) return { ...base, decision: 'propose', reason: 'ambiguous' };
  const strong = top.isExact || top.relevance >= autoT;
  // Strong + clear + reversible → auto-fire; irreversible NEVER autos (safety veto) → confirm.
  if (strong && !irreversible) {
    const reason = top.isExact ? 'alias-exact' : (top.relevance < t.auto ? 'promoted' : 'confident');
    return { ...base, decision: 'auto', reason };
  }
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

// ── ORCH-D — aliases: the use-accreted synonym set ───────────────────────────────────────────────────────
// A capability's description is a one-shot guess; its aliases grow from the asks that successfully match it.
// Each confirmed phrasing becomes an alias → next time it's an exact hit (and alias coverage helps promote
// propose → auto-fire). See docs/DESIGN_intent_orchestration.md §5.

export function normalizeAliasPhrase(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Accrete a confirmed ask phrasing into a capability's aliases. PURE — returns a NEW array.
 * Rules: normalize; drop empties / too-short; dedup (case-insensitive); SKIP a phrase already covered by the
 * intent (its tokens ⊆ the intent's — the description already says it); cap to the most-recent `max`.
 * @param {string[]} aliases  existing aliases
 * @param {string} phrase     the ask that matched
 * @param {{intent?:string, max?:number}} [opts]
 */
export function accreteAlias(aliases, phrase, { intent = '', max = 12 } = {}) {
  const list = (Array.isArray(aliases) ? aliases : []).filter((a) => typeof a === 'string' && a.trim()).map(normalizeAliasPhrase);
  const norm = normalizeAliasPhrase(phrase);
  if (!norm || norm.length < 2) return list.slice();
  if (list.includes(norm)) return list.slice();
  const pTok = _tokens(norm), iTok = new Set(_tokens(intent));
  if (pTok.length && pTok.every((t) => iTok.has(t))) return list.slice();   // intent already covers it
  return [...list, norm].slice(-Math.max(1, max));
}

// ── ORCH-M — LLM select+bind adapters ────────────────────────────────────────────────────────────────────
// The smart matcher does ONE call over the scoped set (AnthropicService.matchCapability) returning per-candidate
// {relevance, effectEligible} + param bindings for its top pick. These PURE adapters turn that into the injected
// `score` the deterministic gate consumes (so the gate — margin, reversibility veto, bands — stays unchanged),
// and VALIDATE option bindings against the captured vocabulary — the anti-hallucination check.

/** Build a `score(ask, candidate)` from the LLM's per-candidate ratings. PURE. A candidate the LLM didn't rate
 *  scores 0 / not-eligible. `isExact` stays DETERMINISTIC (alias match) so an exact alias still short-circuits
 *  even if the model under-rates it; relevance is clamped to [0,1]. */
export function scoresToScorer(scores) {
  const byId = new Map((Array.isArray(scores) ? scores : []).filter((s) => s && s.id != null).map((s) => [String(s.id), s]));
  return (ask, candidate) => {
    const isExact = !!(candidate && (candidate.aliases || []).some((al) => normalizeAliasPhrase(al) === normalizeAliasPhrase(ask)));
    const s = byId.get(String(candidate && candidate.id));
    if (!s) return { relevance: isExact ? 1 : 0, isExact, effectEligible: isExact };
    let rel = Number(s.relevance);
    rel = Number.isFinite(rel) ? Math.max(0, Math.min(1, rel)) : 0;
    return { relevance: isExact ? Math.max(rel, 1) : rel, isExact, effectEligible: s.effectEligible !== false };
  };
}

/**
 * Validate the LLM's param bindings against a candidate's param schema. PURE — the structured anti-hallucination
 * gate. Text params accept any value; OPTION params must resolve to a member of the captured vocabulary
 * (case-insensitive) and are SNAPPED to the exact captured label. A value with no vocabulary match becomes a
 * GAP (surfaced, never applied). An unsupplied param is left to its demonstrated default.
 * @returns {{bound:Object, gaps:Array<{name,requested,reason}>}}
 */
export function validateBindings(bindings, candidate) {
  const out = { bound: {}, gaps: [] };
  const params = (candidate && Array.isArray(candidate.params)) ? candidate.params : [];
  const supplied = (bindings && typeof bindings === 'object') ? bindings : {};
  for (const p of params) {
    if (!p || !p.name) continue;
    const v = supplied[p.name];
    if (v == null || v === '') continue;   // unbound → demonstrated default
    if (p.kind === 'option' && Array.isArray(p.vocabulary) && p.vocabulary.length) {
      const hit = p.vocabulary.find((o) => normalizeAliasPhrase(o) === normalizeAliasPhrase(v));
      if (hit) out.bound[p.name] = hit;
      else out.gaps.push({ name: p.name, requested: String(v), reason: 'not-in-vocabulary' });
    } else {
      out.bound[p.name] = String(v);
    }
  }
  return out;
}
