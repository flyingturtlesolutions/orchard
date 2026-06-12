// Core/postcondition.js — SG-T2-9: evaluate a Tier-2 phase POSTCONDITION against observed page state.
//
// The lowering (tier2Lower) already attaches `node.postcondition = { match, conditions[] }` to each fragment
// (SG-T2-2 structural floor ∪ SG-T2-5 per-subGoal successCondition). It was never CHECKED after the phase
// ran, so a phase verdict meant only "the steps executed without error" — a filter that opened a dropdown
// and deferred the commit (no value applied) still scored trial-pass. This module makes the verdict honest:
// it evaluates the postcondition against the live URL (and optionally selector/text presence) so a phase is
// "held" only when the intended effect is observable.
//
// Condition shapes (from tier2Lower.successToConditions / deriveStructuralPostcondition):
//   { type: 'url_matches',     pattern: <prose|substring> }   — the comprehension's url successCondition
//   { type: 'selector_present', selector: <css> }             — structural result-region floor / explicit el
//   { type: 'text_present',     text: <prose|substring> }     — the comprehension's text successCondition
//
// Two design choices that make this reliable rather than theatrical:
//  1. URL IS THE DISCRIMINATOR. When a phase carries any checkable url_matches condition, the URL gates the
//     verdict; the structural floor (a results region that is ALWAYS present on a SERP) only decides when
//     there is no URL signal. Otherwise `match:'any'` would let the ever-present results region mask a
//     filter that never applied.
//  2. CHANGE-AWARE url match. The comprehension describes the expected param in PROSE ("date or time
//     parameter"), which won't literally appear in a site's real param name (Indeed uses `fromage`). So a
//     url_matches condition holds when EITHER a prose keyword appears in the URL OR the URL's query params
//     actually CHANGED versus just-before-this-phase. The no-op (dropdown opened, commit deferred → URL
//     unchanged, no keyword) fails; a real apply (param added, even an opaquely-named one) holds.
//     v2.74.964 — the keyword leg is CAUSAL: a keyword that ALREADY matched the phase's pre-state URL is
//     no evidence THIS phase did anything (.912 trace: "Submit search" HELD spuriously because phase 1's
//     accidental empty submit had already landed the SERP URL — every later phase inherited the match).
//     With a beforeUrl, only a keyword that turned true ACROSS the phase counts; without one (no pre-state
//     gathered) any hit still counts (fail-open, the pre-.964 behavior).
//
// PURE: no DOM, no chrome, no LLM. The runtime gathers `observed` and calls evaluatePostcondition.
//
// @module Core/postcondition

// Prose fillers to drop so "pay or salary parameter in query string" → ['pay','salary']. Kept deliberately
// small — only words that describe the OBSERVATION mechanism, never domain terms (pay, salary, date, remote…).
const _STOP = new Set([
  'or', 'and', 'the', 'a', 'an', 'in', 'on', 'of', 'to', 'with', 'for', 'is', 'are', 'be', 'as', 'at', 'by',
  'present', 'visible', 'shown', 'show', 'showing', 'display', 'displayed', 'active', 'selected', 'set',
  'updated', 'update', 'parameter', 'parameters', 'param', 'params', 'query', 'string', 'url', 'path', 'page',
  'section', 'results', 'result', 'count', 'value', 'indicator', 'contains', 'containing', 'appears', 'appear',
  'element', 'text', 'field', 'list', 'reflects', 'reflecting', 'applied', 'apply', 'controls', 'control',
]);

// Query params that are pure navigation NOISE — they change on most navigations and never indicate a filter.
const _NOISE_PARAMS = new Set(['vjk', 'g-recaptcha-response', 'gclid', 'utm_source', 'utm_medium', 'utm_campaign', '_ga']);

/**
 * Does a CSS selector target a FILLABLE INPUT control (input/textarea/select/contenteditable)? PURE. A presence
 * check on such a control is PRECONDITION-shaped — the box exists before AND after the action — so it is a useless
 * (always-true) success POSTCONDITION for an effect-bearing action (e.g. a search box is present whether or not the
 * search ran). Used to (a) reject such a postcondition at synthesis and (b) ignore it at the runtime skip gate so a
 * parameterized search is never short-circuited. Conservative: only fires when the selector's target element is
 * clearly an input; a results/region selector (".results", "#out") returns false.
 * @param {string} selector
 * @returns {boolean}
 */
export function isFillableInputSelector(selector) {
  const s = String(selector || '').trim();
  if (!s) return false;
  // the LAST simple selector (after the final combinator) is the matched element — test its tag/attrs
  const last = s.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() || s;
  if (/^(?:input|textarea|select)\b/i.test(last)) return true;          // input[name="q"], textarea#bio, select.x
  if (/\[(?:type|name|placeholder|value)\s*[~|^$*]?=/i.test(last) && /^(?:\*|\[)/.test(last)) return true;  // [name="q"], [placeholder=…]
  if (/\bcontenteditable\b/i.test(last)) return true;
  return false;
}

/**
 * Drop WEAK presence-on-input conditions from a condition list (the precondition-shaped checks above). PURE. The
 * runtime "skip-when-postconditions-already-hold" optimization must not treat such a condition as a satisfied goal,
 * or a parameterized search whose box is always present can never re-run. Returns only the STRONG conditions; an
 * empty result means "no real success signal → do not skip".
 * @param {object[]} conditions
 * @returns {object[]}
 */
export function dropWeakInputPresence(conditions) {
  return (Array.isArray(conditions) ? conditions : [])
    .filter((c) => !(c && c.type === 'selector_present' && isFillableInputSelector(c.selector)));
}

/** Pull domain keywords (≥3 chars, non-filler) from a prose/substring match. PURE. */
export function extractKeywords(prose, { min = 3 } = {}) {
  const toks = String(prose || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  const out = [];
  const seen = new Set();
  for (const t of toks) {
    if (t.length < min || _STOP.has(t) || seen.has(t)) continue;
    seen.add(t); out.push(t);
  }
  return out;
}

/** Normalize a URL to pathname + sorted non-noise query for stable comparison. PURE. */
function _normUrl(u) {
  try {
    const x = new URL(String(u));
    const pairs = [...x.searchParams.entries()].filter(([k]) => !_NOISE_PARAMS.has(k.toLowerCase()));
    pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return x.pathname + '?' + pairs.map(([k, v]) => `${k}=${v}`).join('&');
  } catch {
    return String(u || '');
  }
}

/** Did the URL's meaningful (non-noise) path/query change between two snapshots? PURE. */
export function urlParamsChanged(beforeUrl, afterUrl) {
  if (!beforeUrl || !afterUrl) return false;
  return _normUrl(beforeUrl) !== _normUrl(afterUrl);
}

/**
 * Evaluate a phase postcondition against observed page state. PURE.
 * @param {{match?:string, conditions?:object[]}|null} postcondition  node.postcondition from tier2Lower
 * @param {{beforeUrl?:string, afterUrl?:string, selectorsPresent?:Object<string,boolean>, pageText?:string}} observed
 * @returns {{checked:boolean, held:boolean|null, basis:string|null, match:string, evaluated:object[], reason?:string}}
 */
export function evaluatePostcondition(postcondition, observed = {}) {
  const pc = (postcondition && Array.isArray(postcondition.conditions)) ? postcondition : null;
  if (!pc || !pc.conditions.length) return { checked: false, held: null, basis: null, match: 'any', evaluated: [], reason: 'no postcondition' };

  const match = pc.match === 'all' ? 'all' : 'any';
  const afterUrl = observed.afterUrl || observed.url || '';
  const beforeUrl = observed.beforeUrl || '';
  const afterLc = String(afterUrl).toLowerCase();
  const selPresent = observed.selectorsPresent || {};
  const pageText = typeof observed.pageText === 'string' ? observed.pageText.toLowerCase() : null;

  const evaluated = [];
  for (const c of pc.conditions) {
    if (!c || !c.type) continue;
    if (c.type === 'url_matches') {
      const kws = extractKeywords(c.pattern);
      const checkable = !!afterUrl;
      const beforeLc = String(beforeUrl).toLowerCase();
      const anyHit = checkable ? (kws.find((k) => afterLc.includes(k)) || null) : null;
      // v2.74.964 — CAUSAL keyword evidence (header §2): with a pre-state to compare, only a keyword that
      // turned true ACROSS the phase counts; a hit the phase merely inherited is vacuous. No pre-state →
      // fail-open to any hit.
      const newHit = (checkable && beforeUrl) ? (kws.find((k) => afterLc.includes(k) && !beforeLc.includes(k)) || null) : null;
      const keywordHit = beforeUrl ? newHit : anyHit;
      const vacuousHit = !!(anyHit && beforeUrl && !newHit);
      const changed = checkable ? urlParamsChanged(beforeUrl, afterUrl) : false;
      evaluated.push({ type: 'url_matches', checkable, held: checkable ? (!!keywordHit || changed) : null, keywordHit, vacuousHit, changed, keywords: kws });
    } else if (c.type === 'selector_present') {
      const has = Object.prototype.hasOwnProperty.call(selPresent, c.selector);
      evaluated.push({ type: 'selector_present', selector: c.selector, checkable: has, held: has ? !!selPresent[c.selector] : null });
    } else if (c.type === 'text_present') {
      if (pageText == null) { evaluated.push({ type: 'text_present', checkable: false, held: null }); continue; }
      const kws = extractKeywords(c.text);
      const hit = kws.find((k) => pageText.includes(k)) || null;
      evaluated.push({ type: 'text_present', checkable: kws.length > 0, held: kws.length ? !!hit : null, keywordHit: hit });
    }
  }

  const urlConds = evaluated.filter((e) => e.type === 'url_matches' && e.checkable);
  const otherConds = evaluated.filter((e) => e.type !== 'url_matches' && e.checkable);
  const combine = (arr) => (match === 'all' ? arr.every((e) => e.held === true) : arr.some((e) => e.held === true));

  if (urlConds.length) return { checked: true, held: combine(urlConds), basis: 'url', match, evaluated };   // URL gates when present
  if (otherConds.length) return { checked: true, held: combine(otherConds), basis: 'element', match, evaluated };
  return { checked: false, held: null, basis: null, match, evaluated, reason: 'no checkable condition' };
}

/**
 * CR-E1 (v2.74.927) — nav-aware postcondition relaxation, extracted PURE from ExecutionEngine so the
 * envelope contract is testable. The .815 in-engine filter read `f.type`/`f.pattern`, but
 * TemplateWalker.checkConditions emits failures as `{ condition, reason }` envelopes — `f.type` was
 * always undefined, the early-return kept every failure, and the relax branch (plus its .818 explainer
 * log) was UNREACHABLE since it shipped: a fragment whose own terminal CLICK navigates was still scored
 * failed by its auto-derived url_matches asserting the page it LEFT.
 *
 * Rule (unchanged from .815): a url_matches failure is RELAXED iff its pattern matched the pre-nav URL
 * and stopped matching on the click's own navigation (the assertion held until the action did its job);
 * a pattern matching NEITHER side (a third page) stays a real failure. Tolerates both the envelope shape
 * ({condition:{type,pattern}, reason}) and a legacy bare condition, mirroring the engine's formatter.
 *
 * @param {Array<object>} failures  checkConditions failures (envelopes or bare conditions)
 * @param {{from?:string, to?:string}|null} nav  executeFragment's `navigated` record
 * @returns {{kept: Array<object>, relaxed: Array<object>}}
 */
export function relaxNavPostFailures(failures, nav) {
  const list = Array.isArray(failures) ? failures : [];
  if (!nav || !nav.from) return { kept: list, relaxed: [] };
  const hit = (pat, url) => { try { return new RegExp(pat).test(String(url || '')); } catch { return false; } };
  const kept = [], relaxed = [];
  for (const f of list) {
    const c = (f && typeof f === 'object' && f.condition && typeof f.condition === 'object') ? f.condition : (f || {});
    if (!(c.type === 'url_matches' && c.pattern)) { kept.push(f); continue; }
    const relax = hit(c.pattern, nav.from) && !hit(c.pattern, nav.to);
    (relax ? relaxed : kept).push(f);
  }
  return { kept, relaxed };
}

/**
 * v2.74.758 (moved here in v2.74.949 / CR-X2) — Normalize a Fragment/Observation conditions field to a
 * flat ARRAY, tolerating BOTH a plain array AND a {match, conditions} envelope (mirrors the Analysis
 * path). Conditions were read with a bare `Array.isArray(...)`, which SILENTLY SKIPPED an envelope-shaped
 * value — a synthesized artifact whose conditions were stored as `{match:'all', conditions:[...]}` never
 * enforced them. Tolerant of either shape for every artifact, so a condition is never dropped on a shape
 * mismatch. Shared by ExecutionEngine + the extracted ObservationExecutor. PURE.
 */
export function condList(x) {
  if (x && Array.isArray(x.conditions)) return x.conditions;
  return Array.isArray(x) ? x : [];
}
