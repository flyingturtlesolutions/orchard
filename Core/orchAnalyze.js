// Core/orchAnalyze.js — ORCH-A: the PURE analysis floor — reason over an OBSERVATION to a TYPED output.
//
// An ANALYSIS reads an upstream observation (a list / count / scalar) and produces a typed value whose OUTPUT TYPE
// decides the §6 connection (orchPlan: predicate→gate, list→foreach, count→loop, scalar→binding). This module is
// the first shape: PREDICATE → GATE. It answers a yes/no CONDITION over an observation so a `gate` node can run its
// body iff the condition holds ("if there are any remote jobs, save the search"; "if the top result is under
// $40k, skip it").
//
// Two layers, same evaluate() seam:
//   • DETERMINISTIC (here) — the canonical conditionals need no LLM: existence ("any" / "no"), a numeric threshold
//     ("under $40k", "at least 3"), a term match ("says remote"). Parsed from the condition phrase, evaluated over
//     the observation's value/items.
//   • SEMANTIC (later) — a judgement predicate ("is it a good deal?") is the LLM-Analysis polish; it plugs into the
//     SAME exec.analyze seam (reuse the Tier-2 Analysis machinery), so the runtime doesn't care which produced the
//     boolean.
//
// PURE: no DOM / chrome / LLM. Deterministic.
//
// @module Core/orchAnalyze
// @version 2.74.739

/** The predicate operations over an observation's {value, items, count}. */
export const PREDICATE_OPS = Object.freeze(['exists', 'none', 'gt', 'gte', 'lt', 'lte', 'eq', 'contains', 'not_contains']);

// ── number parsing (money / threshold) ───────────────────────────────────────────────────────────────────────
// First number in a string, money-aware: "$46.32 - $74.81 an hour" → 46.32, "$125,000 a year" → 125000,
// "$40k" → 40000, "up to $1.2M" → 1200000. Returns null when there's no number.
function _firstNumber(s) {
  const str = String(s == null ? '' : s);
  const m = str.match(/(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const suf = (m[2] || '').toLowerCase();
  if (suf === 'k') n *= 1e3;
  else if (suf === 'm') n *= 1e6;
  return n;
}

// ── condition phrase → predicate spec ────────────────────────────────────────────────────────────────────────
const _NONE = /\b(no|none|zero|not any|aren'?t any|isn'?t any|nothing|empty)\b/i;
const _LTE = /\b(at most|no more than|up to|or less|or fewer|<=)\b/i;
const _GTE = /\b(at least|no less than|or more|or higher|or above|>=)\b/i;
const _LT = /\b(under|below|less than|fewer than|cheaper than|lower than|<)\b/i;
const _GT = /\b(over|above|more than|greater than|higher than|>)\b/i;
const _EQ = /\b(exactly|equals?|equal to)\b/i;
const _CONTAINS = /\b(?:says?|contains?|mentions?|includes?|labell?ed|marked|tagged)\s+["']?([a-z0-9][\w-]*)["']?/i;
const _NUM_CONTEXT = /\$|\bpay|salary|price|cost|results?|jobs?|than|least|most|under|over|below|above|up to|exactly|\bk\b/i;
// A numeric threshold targets either the COUNT of items ("more than 10 RESULTS") or the observed VALUE ("under
// $40k"). Currency / per-unit signals → value; a bare collection noun → count.
const _CURRENCY = /\$|\bdollars?\b|\busd\b|\/\s*(?:hr|hour|yr|year|mo|month|wk|week|day)\b|\ban?\s+(?:hour|year|month|week|day)\b/i;
const _COLLECTION_NOUN = /\b(results?|jobs?|items?|rows?|listings?|matches?|posts?|entries|entry|records?|hits?|candidates?|people|reviews?)\b/i;

/**
 * Parse a CONDITION phrase into a predicate spec. PURE — the deterministic floor. Recognizes existence
 * ("any"/"no"), a numeric threshold ("under $40k", "at least 3"), and a term match ("says remote"); defaults to
 * EXISTENCE (the most common conditional subject: "if there ARE jobs…"). `negate` is set by the caller for
 * "unless". The `raw` text is kept for rendering / an LLM-semantic fallback.
 * @param {string} text
 * @returns {{op:string, value?:number, term?:string, negate?:boolean, raw:string}}
 */
export function parsePredicate(text) {
  const s = String(text || '').trim();
  const raw = s;
  if (_NONE.test(s)) return { op: 'none', raw };
  const cm = s.match(_CONTAINS);
  if (cm) return { op: 'contains', term: cm[1].toLowerCase(), raw };
  const num = _firstNumber(s);
  if (num != null && _NUM_CONTEXT.test(s)) {
    // COUNT threshold ("more than 10 results") vs VALUE threshold ("under $40k") — currency wins, else a bare
    // collection noun means the count, else default to the observed value.
    const target = _CURRENCY.test(s) ? 'value' : (_COLLECTION_NOUN.test(s) ? 'count' : 'value');
    const op = _LTE.test(s) ? 'lte' : _GTE.test(s) ? 'gte' : _LT.test(s) ? 'lt' : _GT.test(s) ? 'gt' : _EQ.test(s) ? 'eq' : 'gte';
    return { op, value: num, target, raw };
  }
  return { op: 'exists', raw };
}

/** Is this ask a CONDITIONAL ("if/when/unless … , do …")? PURE — the chat routes these to the planner so the
 *  conditional lift can wrap the consequent in a gate. */
const _COND = /\b(if|when|whenever|once|in case)\b/i;
const _UNLESS = /\bunless\b/i;
export function isConditionalAsk(ask) {
  const s = String(ask || '');
  return _COND.test(s) || _UNLESS.test(s);
}
export function conditionIsUnless(ask) { return _UNLESS.test(String(ask || '')); }

// ── evaluate a predicate over an observation result ──────────────────────────────────────────────────────────
function _countFromValue(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (Array.isArray(value)) return value.length;
  const s = String(value).trim();
  if (!s) return 0;
  const lines = s.split('\n').map((x) => x.trim()).filter(Boolean);
  if (lines.length > 1) return lines.length;                 // a multiline blob → row count (a joined list)
  // A single line that STARTS with a number IS the count — "0 jobs" → 0, "31 results" → 31, "1,234 matches" → 1234.
  // CRITICAL: a zero-results page reads "0 jobs" / "No results", which MUST count as 0 so an existence gate STAYS
  // CLOSED (the bug: "0 jobs" was counted as 1 → exists → the gated action ran on an empty page).
  const m = s.match(/^-?\d[\d,]*/);
  if (m) return parseInt(m[0].replace(/,/g, ''), 10);
  if (/^(no|none|zero|nothing|n\/?a)\b/i.test(s)) return 0;  // "No results", "none found", "no matching jobs" → 0
  return 1;                                                  // any other single non-empty value → present (1)
}
function _count(input) {
  if (!input) return 0;
  if (Number.isInteger(input.count)) return input.count;
  if (Array.isArray(input.items)) return input.items.length;
  return _countFromValue(input.value);
}
function _scalar(input) {
  if (!input) return '';
  if (Array.isArray(input.items) && input.items.length) return String(input.items[0]);
  if (Array.isArray(input.value)) return input.value.length ? String(input.value[0]) : '';
  if (input.value != null) return String(input.value).split('\n')[0];
  return '';
}
function _hay(input) {
  if (!input) return '';
  const parts = [];
  if (input.value != null && !Array.isArray(input.value)) parts.push(String(input.value));
  if (Array.isArray(input.value)) parts.push(input.value.join(' '));
  if (Array.isArray(input.items)) parts.push(input.items.join(' '));
  return parts.join(' ');
}

/**
 * Evaluate a predicate spec over an observation result. PURE. `input` = { value, items?, count? } (the produced
 * observe result the §6 connection drives the gate from). Returns a boolean. Unknown op → false (a closed gate is
 * a safe default — never run a conditional action we couldn't evaluate). `spec.negate` flips the result last.
 * @param {{op:string, value?:number, term?:string, negate?:boolean}} spec
 * @param {{value?:any, items?:any[], count?:number}} input
 * @returns {boolean}
 */
export function evaluatePredicate(spec, input) {
  const op = spec && spec.op;
  let r;
  switch (op) {
    case 'exists': r = _count(input) > 0; break;
    case 'none': r = _count(input) === 0; break;
    case 'contains': { const t = String(spec.term || '').toLowerCase(); r = !!t && _hay(input).toLowerCase().includes(t); break; }
    case 'not_contains': { const t = String(spec.term || '').toLowerCase(); r = !t || !_hay(input).toLowerCase().includes(t); break; }
    case 'gt': case 'gte': case 'lt': case 'lte': case 'eq': {
      // COUNT threshold compares the number of items; VALUE threshold parses the observed scalar (money-aware).
      const n = spec.target === 'count' ? _count(input) : _firstNumber(_scalar(input));
      if (n == null || spec.value == null) { r = false; break; }
      r = op === 'gt' ? n > spec.value
        : op === 'gte' ? n >= spec.value
        : op === 'lt' ? n < spec.value
        : op === 'lte' ? n <= spec.value
        : n === spec.value;
      break;
    }
    default: r = false;
  }
  return spec && spec.negate ? !r : r;
}

/** A short human rendering of a predicate, for the gate confirm ("if it applies: …"). PURE. */
export function predicateLabel(spec) {
  if (!spec || !spec.op) return 'the condition holds';
  const v = (n) => (n >= 1000 ? n.toLocaleString('en-US') : String(n));
  const base = spec.op === 'exists' ? 'there are any'
    : spec.op === 'none' ? 'there are none'
    : spec.op === 'contains' ? `it mentions "${spec.term}"`
    : spec.op === 'not_contains' ? `it doesn't mention "${spec.term}"`
    : spec.op === 'lt' ? `it's under ${v(spec.value)}`
    : spec.op === 'lte' ? `it's at most ${v(spec.value)}`
    : spec.op === 'gt' ? `it's over ${v(spec.value)}`
    : spec.op === 'gte' ? `it's at least ${v(spec.value)}`
    : spec.op === 'eq' ? `it equals ${v(spec.value)}`
    : 'the condition holds';
  return spec.negate ? `NOT (${base})` : base;
}
