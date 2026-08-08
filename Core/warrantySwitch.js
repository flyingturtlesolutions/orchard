// Core/warrantySwitch.js — v2.74.2105: the warranty switch READER, rebuilt as EXTRACTION + CODE ADJUDICATION.
//
// WHY THIS EXISTS (the 11-failure post-mortem — logs/run/findings.md 2026-08-08, prompt-research workflow):
// The previous design asked the model to pick an arm ("replacement needed" / "contact homeowner" / "not deako")
// and expressed the domain as ~2,500 characters of standing rules. It failed eleven times in a row, always the
// same way: the model escalated a clear task and named a NEW reason each time ("without confirming Deako product
// type" → "not Simple Rocker specifically" → "without Deako confirmation" → "indefinite range" → "no specifics on
// type"…). Eleven fixes each deleted one JUSTIFICATION while the escape SLOT stayed reachable at zero cost, so the
// probability mass simply re-emerged under whatever justification was still unbanned. Two structural causes, both
// verified in source before this rewrite:
//   1. The rules never reached the classifier in the form they were written. `goalContextFor` is wired into
//      ROUTE / sweep / ANSWER (sg.js:1995/2069/2198) and NOT into CLASSIFY_BRANCH_ITEMS (sg.js:1621), so the
//      guards only ever arrived as prose inside `arms[].is` — RE-AUTHORED BY A SEPARATE LLM CALL ON EVERY RUN.
//      A guard that is lossily re-compressed per run is not a guard.
//   2. The classifier's own SYSTEM message says "ANSWER 'unknown' WHENEVER YOU CANNOT TELL", and its grammar
//      admits `none` and `unknown` — two residual values with NO entry condition, outranking anything written
//      into the user-message arm criteria.
//
// THE FIX: the model no longer chooses an outcome. It EXTRACTS typed fields, each drawn from a closed set whose
// every value names a mechanical test over the text; a pure function here derives the outcome. "Escalate" stops
// being a value the decoder can reach, so a novel doubt has nowhere to land. The two legitimate CONTACT paths
// become facts CODE computes (`count_route:'NONE'`, or a named non-default product code cannot resolve) rather
// than judgements the model volunteers. Doubt gets a non-routing home (`note`) so it stops competing for the verdict.
//
// PURE — no DOM, no chrome, no network. Wired by chat.js/branchClassify; unit-tested against all 11 historical
// failures and the 13 real queue tasks.

const _s = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** The product classes. A CLASS, not a per-synonym list — the per-synonym list is what produced failures #1/#2/#3. */
export const PRODUCT_ROUTES = Object.freeze(['SIMPLE_ROCKER', 'NAMED_OTHER', 'OTHER_TRADE']);

/** The counting routes. Each value NAMES the mechanical rule the model used, so "no count" is a falsifiable claim
 *  ("none of these four applied") rather than a feeling — the fix for failures #4/#6/#8/#11. */
export const COUNT_ROUTES = Object.freeze(['EXPLICIT', 'RANGE_UPPER', 'SUM_OF_PLACES', 'SINGLE_FAULT', 'NONE']);

/** The outcomes CODE derives. NOT_DEAKO is deliberately absent: the owner ruled outlets → contact ("contact is the
 *  human review path, so moving electrical outlets to contact costs little"), and an arm with no positive entry
 *  test is the next escape hatch — so it is deleted rather than left unconditioned. */
export const WARRANTY_ARMS = Object.freeze(['replacement needed', 'contact homeowner']);

/** Why a task went to a human — for the reviewer, and for measuring WHICH trigger fires (never a model free-text). */
export const CONTACT_CAUSES = Object.freeze(['no-count', 'named-product-unresolved', 'other-trade', 'already-handled']);

/** The DEFAULT product every ordinary switch wording maps to. One product, named once. */
export const DEFAULT_PRODUCT = 'Simple Rocker Switch (Single-Pole & Multiway)';

/**
 * The extraction procedure. Positive, class-scoped, ordered, and terminating in a VALUE at every step — no
 * prohibitions, and none of the doubt vocabulary the old prompt supplied to the model (confirm / unclear / not
 * specified / ambiguous / catalog / indefinite / unknown). The cost asymmetry is stated ONCE as the rationale.
 */
export const EXTRACT_STEPS = [
  'You read one free-text instruction per item and extract five fields. Every item in this queue is a Deako warranty task.',
  '',
  'Work through the steps in order.',
  '',
  '1. PRODUCT. Any ordinary switch wording — switch, light switch, wall switch, 3-way, rocker, or any similar phrase —',
  '   is SIMPLE_ROCKER: the Simple Rocker Switch (Single-Pole & Multiway). A switch or light fault described without a',
  '   product name is also SIMPLE_ROCKER. This applies to every such phrase, not only the ones listed here. A named',
  '   dimmer, smart plug, or smart switch is NAMED_OTHER; copy the name into product_name. A device Deako does not',
  '   supply — a receptacle or outlet, a breaker, a light fixture, or non-electrical work — is OTHER_TRADE.',
  '',
  '2. COUNT. Take the first route the text supports and name it in count_route:',
  '   EXPLICIT       a number is written; count is that number.',
  '   RANGE_UPPER    a range is written; count is the upper end.',
  '   SUM_OF_PLACES  two or more rooms or locations are listed; count is how many.',
  '   SINGLE_FAULT   one fault, problem, or symptom is described; count is 1.',
  '   NONE           the text supports none of the four routes; count is null.',
  '',
  '3. ALREADY_HANDLED. If the text says a replacement was declined, was already sent, or that this is a repair',
  '   instead, set already_handled to the exact words from the text that say so. Otherwise null.',
  '',
  '4. NOTE. One short line for the human reviewer, holding anything you read into the text rather than off it.',
  '   Judgement calls go here.',
  '',
  'A person reviews every item before anything ships, so your reading is checked downstream. Write the most',
  'reasonable reading and let the reviewer weigh it.',
].join('\n');

/** The reply grammar. No label, no `unknown`, no `none` — the residuals that absorbed eleven failures are absent. */
export const EXTRACT_SCHEMA_LINE =
  '{"verdicts":[{"id":"<item id>","product":"SIMPLE_ROCKER|NAMED_OTHER|OTHER_TRADE","product_name":"<name|null>",'
  + '"count_route":"EXPLICIT|RANGE_UPPER|SUM_OF_PLACES|SINGLE_FAULT|NONE","count":<integer|null>,'
  + '"already_handled":"<quote|null>","note":"<12 words max>"}]}';

/**
 * Labelled exemplars — demonstrations, not constraints. The evidence is that boundary EXAMPLES beat prose for
 * edge cases, and that a per-synonym prose list does not generalise (which is exactly what failures #1/#2/#3 were).
 * Every historical failure appears here as a worked row. Deliberately skewed toward the acting outcome, with the
 * LAST row an act (recency), and exactly one row per legitimate contact trigger — one keeps the path reachable,
 * more raises the escalation prior.
 */
export const EXTRACT_EXAMPLES = Object.freeze([
  { text: 'Need 4 light switches delivered to the home',
    out: { product: 'SIMPLE_ROCKER', product_name: null, count_route: 'EXPLICIT', count: 4, already_handled: null, note: '' } },
  { text: 'Please deliver one rocker switch for office, one for master bath',
    out: { product: 'SIMPLE_ROCKER', product_name: null, count_route: 'SUM_OF_PLACES', count: 2, already_handled: null, note: '' } },
  { text: 'Multiple deakos sticking around home. Homeowner pointed 4-5 out',
    out: { product: 'SIMPLE_ROCKER', product_name: null, count_route: 'RANGE_UPPER', count: 5, already_handled: null, note: 'range 4-5, took 5' } },
  { text: 'light switch sticking at middle bedroom',
    out: { product: 'SIMPLE_ROCKER', product_name: null, count_route: 'SINGLE_FAULT', count: 1, already_handled: null, note: '' } },
  { text: 'prim bath 1 light flickering - pls ship replacement',
    out: { product: 'SIMPLE_ROCKER', product_name: null, count_route: 'SINGLE_FAULT', count: 1, already_handled: null, note: 'light symptom, read as switch fault' } },
  { text: 'Light switch replacement needed for 3 switches SCHEDULE ASAP',
    out: { product: 'SIMPLE_ROCKER', product_name: null, count_route: 'EXPLICIT', count: 3, already_handled: null, note: '' } },
  { text: 'deliver a Gen 2 smart switch to replace the existing, non functional',
    out: { product: 'NAMED_OTHER', product_name: 'Gen 2 smart switch', count_route: 'SINGLE_FAULT', count: 1, already_handled: null, note: '' } },
  { text: 'Please send homeowner deako switches',
    out: { product: 'SIMPLE_ROCKER', product_name: null, count_route: 'NONE', count: null, already_handled: null, note: '' } },
  { text: 'Electrical outlets are loose throughout the home including the kitchen',
    out: { product: 'OTHER_TRADE', product_name: 'electrical outlets', count_route: 'SINGLE_FAULT', count: 1, already_handled: null, note: '' } },
  { text: 'Homeowner asked about replacements - do NOT send one, repairing under warranty',
    out: { product: 'SIMPLE_ROCKER', product_name: null, count_route: 'NONE', count: null, already_handled: 'do NOT send one, repairing under warranty', note: '' } },
  { text: '6 wall switches are flickering',
    out: { product: 'SIMPLE_ROCKER', product_name: null, count_route: 'EXPLICIT', count: 6, already_handled: null, note: '' } },
]);

/** Render the exemplars as `<example>` blocks (system-slot demonstrations, same altitude as the procedure). */
export function renderExamples(examples = EXTRACT_EXAMPLES) {
  return (Array.isArray(examples) ? examples : []).map((e) =>
    `<example>\n${_s(e && e.text)}\n${JSON.stringify((e && e.out) || {})}\n</example>`).join('\n');
}

/** The full system message for the extraction call. PURE. */
export function buildWarrantyExtractSystem() {
  return [EXTRACT_STEPS, '', 'Reply with JSON only:', EXTRACT_SCHEMA_LINE,
    'Return exactly one verdict per item, using the ids given.', '', renderExamples()].join('\n');
}

/**
 * COERCE one extracted verdict into a self-consistent shape. Each rule closes a silent escape rather than trusting
 * the model to be consistent — an inconsistency must resolve to the ACTING reading wherever the text supports one.
 * PURE. @returns {{product,product_name,count_route,count,already_handled,note}}
 */
export function coerceVerdict(raw, itemText = '') {
  const v = (raw && typeof raw === 'object') ? raw : {};
  const text = _s(itemText);
  let product = PRODUCT_ROUTES.includes(v.product) ? v.product : 'SIMPLE_ROCKER';   // unknown/absent → the default class
  const product_name = _s(v.product_name) || null;
  let count_route = COUNT_ROUTES.includes(v.count_route) ? v.count_route : 'NONE';
  let count = Number.isFinite(v.count) ? Math.max(0, Math.trunc(v.count)) : null;
  // A count without a route is still a count (the model got the number, mislabelled the rule) → act on it.
  if (count_route === 'NONE' && count != null && count > 0) count_route = 'EXPLICIT';
  // A route without a count cannot be acted on → it is the honest no-count case.
  if (count_route !== 'NONE' && (count == null || count <= 0)) { count_route = 'NONE'; count = null; }
  if (count_route === 'NONE') count = null;
  // A NAMED_OTHER with no name is not a named product at all → it is an ordinary switch.
  if (product === 'NAMED_OTHER' && !product_name) product = 'SIMPLE_ROCKER';
  // An already-handled claim must QUOTE the text. An invented quote is dropped, not honoured — the one place the
  // model can stop work, so it must point at a span that exists (case-insensitive; whitespace-normalized).
  let already_handled = _s(v.already_handled) || null;
  if (already_handled) {
    const norm = (x) => x.toLowerCase().replace(/\s+/g, ' ');
    if (!text || !norm(text).includes(norm(already_handled))) already_handled = null;
  }
  return { product, product_name, count_route, count, already_handled, note: _s(v.note).slice(0, 120) };
}

/**
 * DERIVE the outcome from the extracted fields. THE MODEL NEVER PICKS THIS. First match wins; the final branch has
 * no condition — that is the point: acting is the default, and every path to a human requires a positive, checkable
 * fact. PURE.
 *
 * @param {object} verdict   a COERCED verdict (run coerceVerdict first)
 * @param {{inCatalog?:(name:string)=>boolean}} [opts]  catalog membership — a CODE test, never the model's opinion
 * @returns {{arm:string, cause:string|null, count:number|null, product:string}}
 */
export function deriveWarrantyOutcome(verdict, { inCatalog = null } = {}) {
  const v = (verdict && typeof verdict === 'object') ? verdict : {};
  const contact = (cause) => ({ arm: 'contact homeowner', cause, count: null, product: null });
  if (v.already_handled) return contact('already-handled');                       // quote verified in coerceVerdict
  if (v.product === 'OTHER_TRADE') return contact('other-trade');                 // owner ruling: outlets → human review
  if (v.count_route === 'NONE' || v.count == null) return contact('no-count');    // the falsifiable no-count claim
  if (v.product === 'NAMED_OTHER') {
    const ok = typeof inCatalog === 'function' ? !!inCatalog(v.product_name) : true;
    if (!ok) return contact('named-product-unresolved');
    return { arm: 'replacement needed', cause: null, count: v.count, product: v.product_name };
  }
  return { arm: 'replacement needed', cause: null, count: v.count, product: DEFAULT_PRODUCT };
}

/** Coerce + derive in one call, for a raw model verdict. PURE. */
export function readWarrantyItem(raw, itemText = '', opts = {}) {
  const fields = coerceVerdict(raw, itemText);
  return { fields, ...deriveWarrantyOutcome(fields, opts) };
}

/** Tally outcomes for the run line — counts by arm and by contact cause (never free-text reasons). PURE. */
export function tallyOutcomes(outcomes) {
  const arr = Array.isArray(outcomes) ? outcomes.filter(Boolean) : [];
  const byArm = Object.create(null);
  for (const a of WARRANTY_ARMS) byArm[a] = 0;
  const byCause = Object.create(null);
  for (const c of CONTACT_CAUSES) byCause[c] = 0;
  const byRoute = Object.create(null);
  for (const r of COUNT_ROUTES) byRoute[r] = 0;
  for (const o of arr) {
    if (o.arm && byArm[o.arm] != null) byArm[o.arm]++;
    if (o.cause && byCause[o.cause] != null) byCause[o.cause]++;
    const rt = o.fields && o.fields.count_route;
    if (rt && byRoute[rt] != null) byRoute[rt]++;
  }
  return { total: arr.length, byArm, byCause, byRoute };
}
