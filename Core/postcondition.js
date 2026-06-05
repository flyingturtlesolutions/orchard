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
//
// PURE: no DOM, no chrome, no LLM. The runtime gathers `observed` and calls evaluatePostcondition.
//
// @module Core/postcondition
// @version 2.74.648

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
      const keywordHit = checkable ? (kws.find((k) => afterLc.includes(k)) || null) : null;
      const changed = checkable ? urlParamsChanged(beforeUrl, afterUrl) : false;
      evaluated.push({ type: 'url_matches', checkable, held: checkable ? (!!keywordHit || changed) : null, keywordHit, changed, keywords: kws });
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
