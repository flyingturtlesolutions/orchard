// Core/goalMemory.js — AL-1 (v2.74.1187): the apps-layer GOAL memory — typed beliefs + behavior deltas
// (DESIGN_apps_learning.md §2 / §4 / §9). PURE: no chrome / DOM / LLM / storage / clock.
//
// The goal store learns *what the app knows/concludes about its work* (distinct from the tooling/grounding store,
// which learns *how to operate a site* — global/shared). This slice is the schema + the tier ratchet + the
// promotion gate only; the per-app persistence (AL-2), write-back hooks (AL-3), retrieval/assemble policy (AL-4),
// and slow consolidation (AL-6) are later slices.
//
// Two object kinds — "untyped knowledge is not admitted" (§2):
//   • BELIEF — a fact/claim about the WORK, carrying three orthogonal tags: an epistemic type (observed fact vs.
//     inferred claim), a confidence, and a provenance (where it came from). e.g. "Acme is on the enterprise plan"
//     (observed · 0.95 · ticket #6122).
//   • DELTA ("lesson") — NOT a fact but a RULE about future action, born from a prediction↔ground-truth mismatch.
//     e.g. trigger:"refund tickets" → body:"verify payment status before drafting." (the app's standing rules are
//     authored deltas; *learned* deltas from mismatch are the new part.)
//
// The tier ratchet (§4): observation → hypothesis → confirmed → canonical → summary. An item only moves up when its
// signals clear that tier's gate — cheap to hypothesize, deliberate to canonize. Canonization is HITL (§7): a human
// confirms, confidence alone never canonizes. The 'summary' tier is reached only by the slow consolidation pass.

const _str = (x) => (typeof x === 'string' ? x.trim() : '');
const _clamp01 = (n, d) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d);

export const ITEM_KINDS = Object.freeze(['belief', 'delta']);
export const EPISTEMIC  = Object.freeze(['observed', 'inferred']);     // belief epistemic type; unmarked → 'inferred'
// The lifecycle, low→high. ORDER IS THE RATCHET — index = tier rank.
export const TIERS = Object.freeze(['observation', 'hypothesis', 'confirmed', 'canonical', 'summary']);

/** Tier rank (its index in TIERS), or -1 for an unknown tier. PURE. */
export function tierRank(tier) {
  return TIERS.indexOf(tier);
}

/** The tier one step up, or null if `tier` is the top ('summary') or unknown. PURE. */
export function nextTier(tier) {
  const i = TIERS.indexOf(tier);
  return (i >= 0 && i < TIERS.length - 1) ? TIERS[i + 1] : null;
}

/**
 * Normalize a BELIEF. PURE. Requires a `body` (it must assert something) — else null. `epistemic` defaults to the
 * weaker 'inferred' (an unmarked claim is fail-safe, never silently promoted to observed fact); confidence clamps to
 * [0,1] (default 0.5); tier defaults to the floor 'observation'. `id` is passed through (the store assigns it, AL-2).
 */
export function normalizeBelief(raw) {
  const r = (raw && typeof raw === 'object') ? raw : null;
  if (!r) return null;
  const body = _str(r.body);
  if (!body) return null;
  return {
    id: _str(r.id) || null,
    kind: 'belief',
    epistemic: EPISTEMIC.includes(r.epistemic) ? r.epistemic : 'inferred',
    confidence: _clamp01(r.confidence, 0.5),
    provenance: _str(r.provenance) || null,
    tier: TIERS.includes(r.tier) ? r.tier : 'observation',
    body,
    ref: _str(r.ref) || null,      // AL-3b — an optional reference the belief is ABOUT (e.g. a capabilityId for an
                                    // intent→capability association: body = the ask phrasing, ref = the capability).
  };
}

/**
 * Normalize a behavior DELTA. PURE. Requires a `body` (the action rule — the "then") — else null. `trigger` (the
 * "when" / if-X condition) is optional (null = an always-on lesson). `provenance` records the mismatch it was born
 * from. confidence/tier/id as for a belief.
 */
export function normalizeDelta(raw) {
  const r = (raw && typeof raw === 'object') ? raw : null;
  if (!r) return null;
  const body = _str(r.body);
  if (!body) return null;
  return {
    id: _str(r.id) || null,
    kind: 'delta',
    trigger: _str(r.trigger) || null,
    confidence: _clamp01(r.confidence, 0.5),
    provenance: _str(r.provenance) || null,
    tier: TIERS.includes(r.tier) ? r.tier : 'observation',
    body,
    ref: _str(r.ref) || null,      // AL-3b — optional reference (uniform with beliefs; e.g. a delta about a capability)
  };
}

/** Dispatch by kind. PURE. Untyped / unknown-kind input → null ("untyped knowledge is not admitted", §2). */
export function normalizeMemoryItem(raw) {
  const r = (raw && typeof raw === 'object') ? raw : null;
  if (!r) return null;
  if (r.kind === 'delta')  return normalizeDelta(r);
  if (r.kind === 'belief') return normalizeBelief(r);
  return null;
}

export const isBelief = (x) => !!x && x.kind === 'belief';
export const isDelta  = (x) => !!x && x.kind === 'delta';

/**
 * AL-3c — build an AUTHORED standing-rule DELTA from user text ("the app's standing rules are authored deltas", §8).
 * PURE. NON-tool learning: the user states a behavioral rule, not a capability choice. Light `if X, Y` / `if X then
 * Y` parse → trigger (the "when") + body (the "then"); a delimiter is REQUIRED (a comma/`;`/`:`/"then") so a no-
 * delimiter sentence isn't mis-split — it becomes an always-on rule (trigger null). Starts at 'confirmed' with high
 * confidence: the user EXPLICITLY authored it (a deliberate act), so it's confirmed-by-construction — but not auto-
 * canonized (canon is for consolidated knowledge, §4/§6). Returns the delta, or null if there's no rule text.
 */
export function standingRuleFromText(text) {
  const s = _str(text);
  if (!s) return null;
  let trigger = null;
  let body = s;
  // `if X, Y` / `if X then Y` → trigger = X (the "when"), body = Y (the "then").
  let m = s.match(/^if\s+(.+?)\s*(?:,|;|:|\bthen\b)\s+(.+)$/i);
  // §12.3 — `when I say X, I mean|run|do Y` → a PHRASE-scoped rule (trigger = the phrase X, body = the expansion Y),
  // NOT an always-on one. Lets `remember: when I say "get tickets" I mean …` key the rule to the phrase, so recall
  // fires it only when the ask overlaps X (instead of loading it into every prompt).
  if (!m) m = s.match(/^when\s+(?:i\s+say\s+)?["“']?(.+?)["”']?\s*(?:,|:|—)?\s*(?:i\s+(?:mean|want|need)|run|do|then)\s+(.+)$/i);
  if (m && m[1].trim() && m[2].trim()) { trigger = m[1].trim(); body = m[2].trim(); }
  return normalizeDelta({ body, trigger, confidence: 0.85, tier: 'confirmed', provenance: 'user-rule' });
}

/**
 * §12.2 — does a plain chat ask LOOK like a standing behavioral rule (a preference about HOW the assistant should
 * behave) rather than an action? PURE. Precision-biased: the caller gates on the IL already classifying the ask as
 * `answer`, so an action imperative ("use the search box") is filtered by intent and never reaches here. Used to
 * OFFER "remember this rule?" when the user states a preference WITHOUT the `remember:` prefix.
 */
const _RULE_RE = /^(?:please\s+)?(keep|always|never|don'?t|do not|avoid|prefer|make sure|ensure|use|respond|reply|answer|write|format|limit|from now on|going forward|when i say)\b/i;
export function looksLikeStandingRule(ask) {
  return _RULE_RE.test(_str(ask));
}

/**
 * AL-3e (the OUTCOME hook) — the goal-memory item recording an interpret-ACT's RESULT. PURE. This is the missing
 * "learn what WORKED" write-back (§3): the app learned *what was asked* (AL-3b banks the association at dispatch) but
 * not *what succeeded*. Here:
 *   • SUCCESS → an OBSERVED belief (the intent→capability association, witnessed to work). confidence 0.7 so a SECOND
 *     success crosses the hypothesis→confirmed gate (≥0.7 ∧ evidence ≥2) and the association graduates — corroboration
 *     by OUTCOME, not by mere re-asking.
 *   • FAILURE → a low-confidence "lesson" DELTA (a prediction↔ground-truth mismatch, §2), keyed SEPARATELY from the
 *     belief (kind 'delta' ≠ 'belief' → distinct content id) so it can never corroborate the positive — the store has
 *     no un-corroborate. Confidence is deliberately weak (0.4): one transient failure must not bury a good tool; only
 *     REPEATED failure of the same ask→capability accrues. Recall surfaces it as "this didn't work here — reconsider".
 * `goal` = the ask phrasing (the recall key, truncated). `capabilityId` = the tool. Returns null on missing args.
 */
export function capabilityOutcomeItem(goal, capabilityId, ok) {
  const g = _str(goal);
  const ref = _str(capabilityId);
  if (!g || !ref) return null;
  return ok
    ? { kind: 'belief', epistemic: 'observed', confidence: 0.7, body: g.slice(0, 160), ref, provenance: 'act-ok' }
    : { kind: 'delta', confidence: 0.4, trigger: g.slice(0, 120), body: 'a saved capability was tried for this and didn\'t work — re-teach or pick a different approach', ref, provenance: 'act-fail' };
}

// The per-target-tier promotion gate (the ratchet, §4). `s` = normalized signals. Cheap to hypothesize; corroborated
// to confirm; HITL to canonize (§7 — confidence alone never canonizes); consolidation-only to summarize (§5).
function _gateFor(target, s) {
  switch (target) {
    case 'hypothesis': return s.confidence >= 0.3;
    case 'confirmed':  return s.confidence >= 0.7 && s.evidenceCount >= 2;
    case 'canonical':  return s.confirmedByHuman === true;
    case 'summary':    return s.consolidating === true;
    default:           return false;
  }
}

// Normalize the promotion signals. `confidence` falls back to the item's current confidence when not supplied, so
// `canPromote(item, { evidenceCount: 2 })` re-uses what the item already carries.
function _normSignals(signals, item) {
  const s = (signals && typeof signals === 'object') ? signals : {};
  return {
    confidence: _clamp01(s.confidence, item ? item.confidence : 0),
    evidenceCount: Number.isFinite(s.evidenceCount) ? s.evidenceCount : 0,
    confirmedByHuman: s.confirmedByHuman === true,
    consolidating: s.consolidating === true,
  };
}

/**
 * Does `item` clear the gate to its NEXT tier under these signals? PURE.
 * @param {object} item     a belief/delta (normalized internally)
 * @param {{confidence?:number, evidenceCount?:number, confirmedByHuman?:boolean, consolidating?:boolean}} [signals]
 * @returns {boolean} false if the item is unusable or already at the top tier.
 */
export function canPromote(item, signals) {
  const it = normalizeMemoryItem(item);
  if (!it) return false;
  const nt = nextTier(it.tier);
  if (!nt) return false;
  return _gateFor(nt, _normSignals(signals, it));
}

/**
 * Promote one tier if the gate clears — copy-on-write. PURE. Returns a NEW item at the next tier (confidence raised
 * to the max of current vs. the evidence's), the SAME item unchanged if the gate doesn't clear, or null on garbage.
 */
export function promote(item, signals) {
  const it = normalizeMemoryItem(item);
  if (!it) return null;
  if (!canPromote(it, signals)) return it;
  const s = _normSignals(signals, it);
  return { ...it, tier: nextTier(it.tier), confidence: Math.max(it.confidence, s.confidence) };
}
