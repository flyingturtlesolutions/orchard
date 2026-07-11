// Core/legPrerank.js — CX-9p (v2.74.1461): DETERMINISTIC pre-rank of the interpret palette's scope-tiered connector
// legs, BEFORE the LLM sees them. The routing-review fix (findings.md v1450/v1451, the parked "unnamed ask" miss).
//
// THE PROBLEM. The SCOPING precedence (LEARNED-MATCH > TARGET > DOMAIN-MATCH > ACTIVE-TAB > GLOBAL) is a SOFT
// system rule the router LLM is asked to apply. When the palette ALSO holds a lexically-attractive but
// out-of-domain GLOBAL leg — e.g. "Search Zendesk tickets" (search_tickets) for "pull up the warranty task…" —
// the LLM's lexical pull can beat the soft precedence: the unnamed warranty ask picked search_tickets over the
// vendorsuite legs and dead-ended on "no-app-tab", even though the vendorsuite ground was the DOMAIN-MATCH winner.
//
// THE FIX. Make the precedence DATA at projection (the v1447 design note: "steps are DATA; the router only applies
// a stated precedence — it never invents scoping"). This module:
//   • ORDERS legs by (scope tier, ask-vocabulary overlap) so the highest tier + most ask-relevant legs LEAD the
//     palette (LLMs weight earlier candidates), and
//   • when a higher tier CLEARLY owns the ask (an alias / target / vocab WINNER is present), DROPS the zero-overlap
//     GLOBAL legs — the finding's "cap GLOBAL legs to vocabulary-relevant ones". A global leg that shares NO
//     content word with the ask is pure noise once the site is (implicitly) named; removing it makes the mis-pick
//     structurally impossible rather than merely discouraged.
//
// PURE. No drop when there is NO winner (full GLOBAL reach is preserved when the ask names/implies nothing). Only
// legs explicitly scoped 'global' are ever cap-eligible — RAG / panel / compose / active-tab legs are untouched.

// The SAME content-word tokenizer + stop-list as Core/toolRetrieval.js — one lexicon across the front door, so the
// pre-rank's notion of "shares a word with the ask" matches the retriever's.
const STOP = new Set('a an the to of for on in at is be do go i my me we us this that these those with and or your you it as by'.split(' '));

/** Ask/leg text → content-word tokens (≥2 chars, non-glue). PURE. */
export function askTokens(s) {
  return String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t));
}

// Scope-tier precedence, highest first. `alias` (a LEARNED ask-shape → leg association, CX-9p connectorAlias) tops
// the cascade: a previously-successful match for THIS ask-shape is the strongest possible signal for where to route.
const TIER = { alias: 5, target: 4, vocab: 3, tab: 2, global: 1 };
// An UNSCOPED leg (a RAG / panel / compose leg, or a connections-branch ride leg that carries no tier) sits at a
// NEUTRAL rank — above GLOBAL, below the winner tiers — and is NEVER cap-eligible. Only explicit GLOBAL legs drop.
const NEUTRAL = 2.5;

/** A leg's scope-tier rank (higher = earlier). Unscoped/unknown → NEUTRAL. PURE. */
export function tierRank(leg) {
  const s = leg && leg.scope;
  return Object.prototype.hasOwnProperty.call(TIER, s) ? TIER[s] : NEUTRAL;
}

// The searchable text of a leg: name + does + param names / enum values / hints — everything the LLM keys on.
function legText(leg) {
  if (!leg || typeof leg !== 'object') return '';
  const parts = [leg.name, leg.does];
  const ps = leg.paramSchema && leg.paramSchema.properties;
  if (ps && typeof ps === 'object') {
    for (const [k, v] of Object.entries(ps)) {
      parts.push(k);
      if (v && Array.isArray(v.enum)) parts.push(v.enum.join(' '));
      if (v && v.hint) parts.push(v.hint);
    }
  } else if (Array.isArray(leg.params)) {
    parts.push(leg.params.map((p) => (p && p.name) || p).join(' '));
  }
  return parts.filter(Boolean).join(' ');
}

/** Count of DISTINCT content words a leg shares with the ask token set. PURE. */
export function legAskOverlap(leg, askSet) {
  if (!(askSet instanceof Set) || !askSet.size) return 0;
  let n = 0;
  for (const t of new Set(askTokens(legText(leg)))) if (askSet.has(t)) n++;
  return n;
}

// The tiers that count as a WINNER — a higher tier that clearly owns the ask, licensing the GLOBAL cap.
const WINNER = new Set(['alias', 'target', 'vocab']);

/**
 * Deterministically ORDER (and, when a winner tier is present, CAP) the scope-tiered leg palette. PURE — returns a
 * NEW array; never mutates the input legs.
 * @param {Array<object>} legs — the projected connector/ride legs (each may carry `.scope`)
 * @param {string} ask
 * @param {{ dropZeroOverlapGlobals?: boolean }} [opts] — set false to order only (no cap), e.g. for a debug view
 * @returns {Array<object>} reordered, with zero-overlap GLOBAL legs removed IFF a winner tier is present
 */
export function prerankLegs(legs, ask, { dropZeroOverlapGlobals = true } = {}) {
  const arr = Array.isArray(legs) ? legs.filter((l) => l && typeof l === 'object') : [];
  if (arr.length < 2) return arr.slice();
  const askSet = new Set(askTokens(ask));
  const scored = arr.map((leg, i) => ({ leg, i, tier: tierRank(leg), ov: legAskOverlap(leg, askSet) }));
  const hasWinner = scored.some((s) => WINNER.has(s.leg.scope));
  let kept = scored;
  if (hasWinner && dropZeroOverlapGlobals) {
    // Cap GLOBAL to vocabulary-relevant: a global leg sharing NO content word with the ask is noise now that a
    // higher tier owns it. Winner tiers, active-tab, and unscoped legs are all kept — only zero-overlap globals go.
    kept = scored.filter((s) => !(s.leg.scope === 'global' && s.ov === 0));
  }
  kept.sort((a, b) => (b.tier - a.tier) || (b.ov - a.ov) || (a.i - b.i));   // tier, then relevance, then stable order
  return kept.map((s) => s.leg);
}
