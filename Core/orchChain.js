// Core/orchChain.js — ORCH-X front-end: decompose a COMPOUND ask into ordered clauses + assemble a sequential
// plan over EXISTING capabilities. PURE (the LLM refines decomposition live; this is the deterministic floor).
//
// The problem this fixes: "search for music AND filter by date" was matched as ONE atomic intent → no single
// capability fits → the chat offered to record a NEW thing. But the two halves ALREADY exist as capabilities.
// The fix is the compiler's front-end: split the ask into clauses, route EACH to a capability (via the matcher),
// and compose them into a plan the runner executes in order. This is the seam where T2 composition — and
// eventually T3 (cross-ground) composition — becomes useful: one ask, many grounded steps.
//
//   decomposeAsk(ask)                 — split a compound ask into ordered {text, connective} clauses
//   assembleSequentialPlan(clauses)   — per-clause matches → an orchPlan IR (fragment steps, run in order)
//
// Decomposition is verb-led: a connective ("and"/"then"/",") is an intent boundary ONLY when the text after it
// begins a new intent (an action verb or a question word). Otherwise the connective joins a VALUE ("cats and
// dogs" stays one clause) and the parts are rejoined with their original text.
//
// @module Core/orchChain

import { planStep, validatePlan } from './orchPlan.js';
import { slugUpper } from './slug.js';   // v2.74.940 (CR-D2)
import { parsePredicate, conditionIsUnless, isConditionalAsk, predicateLabel } from './orchAnalyze.js';   // ORCH-A — predicate → gate

// Verbs / question-words that mark the START of a new intent clause. After a connective, one of these → boundary.
// v2.74.798 — added the read/extract verbs (retrieve|grab|extract|obtain) so a compound ACTION+READ ask like
// "search jazz singer jobs AND retrieve the first title" splits into two clauses. Without "retrieve" here the whole
// thing stayed one clause → never recognized as compound → never routed as a chain (live trace 21:03). Deliberately
// excludes "pull"/"copy" (would false-split "pull-up bars", "copy editor").
const _VERB = /^(?:please\s+|also\s+|then\s+|now\s+)?(search|find|filter|sort|order|open|close|add|remove|delete|clear|select|choose|pick|download|upload|show|list|count|check|get|fetch|retrieve|grab|extract|obtain|go|navigate|visit|play|pause|set|enable|disable|toggle|apply|view|browse|look|read|tell|click|tap|press|book|reserve|subscribe|follow|share|save|edit|update|create|sign|log|register|scroll|what|which|how|is|are|does|do|when|where|who|why|can|could|should)\b/i;

// Connectives that MAY separate intents — kept as split delimiters (one capturing group) so a non-boundary
// connective can be rejoined with its original text. A comma/semicolon is only a boundary when a verb follows.
const _CONN = /(\s+(?:and then|and also|then|and|&|after that|afterwards|followed by|next|plus)\s+|\s*[;,]\s+)/i;

/**
 * Split a compound ask into ordered clauses. PURE. Verb-led: a connective is an intent boundary only when the
 * following text starts a new intent; otherwise the parts rejoin (the connective was inside a value).
 * @param {string} ask
 * @returns {Array<{text:string, connective:(string|null)}>}  the first clause's connective is null
 */
export function decomposeAsk(ask) {
  const s = String(ask || '').trim();
  if (!s) return [];
  const parts = s.split(_CONN);   // [seg0, delim0, seg1, delim1, …]
  const clauses = [];
  let cur = parts[0] || '';
  let curConn = null;
  for (let i = 1; i < parts.length; i += 2) {
    const delim = parts[i] || '';
    const seg = parts[i + 1] || '';
    if (_VERB.test(seg.trim())) {
      if (cur.trim()) clauses.push({ text: cur.trim(), connective: curConn });
      // Strip a leading connective the COMMA/semicolon split left on the segment ("…, then sort" → seg="then
      // sort"), so the clause text sent to the matcher is the bare intent ("sort by date"), not "then sort by date".
      const lead = seg.match(/^\s*((?:and\s+)?(?:then|also|now))\s+/i);
      cur = lead ? seg.slice(lead[0].length) : seg;
      curConn = ((lead && lead[1]) || delim.replace(/[;,]/g, ' ')).trim() || 'and';
    } else {
      cur = cur + delim + seg;   // not a boundary — keep the original text (the connective joins a value)
    }
  }
  if (cur.trim()) clauses.push({ text: cur.trim(), connective: curConn });
  return clauses.filter((c) => c.text);
}

/** Is this ask compound (more than one intent clause)? PURE. */
export function isCompoundAsk(ask) {
  return decomposeAsk(ask).length > 1;
}

// Tokens that follow a destination preposition but are NOT site names (pronouns/articles/relative places). Keeps
// "save it to me" / "go to the top" from counting as a site reference.
const _SITE_STOP = new Set(['it', 'me', 'them', 'us', 'you', 'him', 'her', 'the', 'a', 'an', 'my', 'your', 'our',
  'their', 'his', 'this', 'that', 'these', 'those', 'here', 'there', 'home', 'top', 'bottom', 'left', 'right',
  'one', 'each', 'all', 'both', 'page', 'site', 'list', 'side', 'end', 'start']);

/**
 * Does this ask reference TWO OR MORE DISTINCT sites? PURE. A cheap lexical pre-filter for a CROSS-GROUND ask: a
 * destination preposition (on/to/into/onto/at/from) followed by a non-pronoun token is a site reference (e.g.
 * "...on indeed ... on pixabay", "...on linkedin ... to notion"). Two DISTINCT such tokens → likely cross-site.
 * Deliberately conservative — the authoritative test is the background resolving the ask to ≥2 real Grounds; this
 * only gates whether that (LLM) comprehension is worth attempting, so a single site mentioned twice does NOT fire.
 * @param {string} ask
 * @returns {boolean}
 */
function _siteRefs(ask) {
  const re = /\b(?:on|onto|to|into|at|from)\s+([a-z][a-z0-9.&'-]{1,})/ig;
  const seen = new Set();
  let m;
  while ((m = re.exec(String(ask || ''))) !== null) {
    const tok = m[1].toLowerCase();
    if (!_SITE_STOP.has(tok)) seen.add(tok);
  }
  return seen;
}

export function namesMultipleSites(ask) { return _siteRefs(ask).size >= 2; }

/**
 * Does this ask name AT LEAST ONE destination site ("…on indeed", "…to gmail")? PURE. The ≥1 sibling of
 * namesMultipleSites. Gates the SINGLE-Ground fallback (T3X live-fix v2.74.793): a "search jobs on indeed" typed
 * while the side panel is on ANOTHER site should still resolve to Indeed and run there — not dead-end because the
 * current tab's Ground (or no Ground) has no such capability. Conservative — the authoritative test is the
 * background resolving the ask to a real runnable Ground; this only gates whether that (LLM) attempt is worth it.
 * @param {string} ask
 * @returns {boolean}
 */
export function namesAnySite(ask) { return _siteRefs(ask).size >= 1; }

/**
 * A cheap gate for "this single sentence may span MULTIPLE capabilities" — worth an LLM PLAN (semantic
 * decomposition) rather than a single match. PURE. Lexical decompose only catches explicit connectives; a
 * sentence like "search SWE jobs in minneapolis posted last 7 days" has none, yet needs search THEN filter. We
 * flag it when it's long enough AND carries a constraint/qualifier signal (a second intent often hides there).
 * @param {string} ask
 * @returns {boolean}
 */
export function looksComplex(ask) {
  const s = String(ask || '').trim();
  if (!s) return false;
  // STRONG markers — a salary/range/work-type/sort/date constraint almost always implies a SECOND capability
  // (a filter/sort) beyond the core verb, even in a SHORT ask ("remote software jobs $90000+" = search + 2 filters).
  if (/\$\s?\d|\b\d+\s?k\b|\bremote\b|\bon-?site\b|\bhybrid\b|\bsort(?:ed)?\b|\bnewest\b|\boldest\b|\bcheapest\b|\bhighest\b|\blowest\b|\bposted\b|\bunder\b|\bover\b|\bbetween\b|\bwithin\b|\bpast\b|\blast\b|\bfilter(?:ed)?\b/i.test(s)) return true;
  // Otherwise a LONG sentence with a constraint preposition may still span capabilities.
  const words = s.split(/\s+/).filter(Boolean).length;
  if (words < 7) return false;
  return /\b(in|near|with|by|for|from|priced|rated|then|also)\b/i.test(s);
}

/**
 * Assemble a SEQUENTIAL plan (orchPlan IR) from per-clause matches. PURE. Each matched clause becomes a fragment
 * step run in order; clauses that did not match are reported as GAPS (the chat offers to record just those, not
 * the whole ask). No analysis connections yet — a straight chain; READ-6 adds observe→analyze→fragment fusion.
 * @param {Array<{text?:string, capabilityId?:(string|null), bindings?:object}>} clauseMatches
 * @param {{goal?:string}} [opts]
 * @returns {{plan:{goal:string,steps:object[]}, valid:boolean, errors:string[], gaps:Array<{index:number,text:string}>}}
 */
export function assembleSequentialPlan(clauseMatches, opts = {}) {
  const list = Array.isArray(clauseMatches) ? clauseMatches : [];
  const steps = [];
  const gaps = [];
  list.forEach((c, i) => {
    if (c && c.capabilityId) {
      steps.push(planStep.fragment(`s${i + 1}`, c.capabilityId, { bindings: (c && c.bindings) || {}, clause: (c && c.text) || null }));
    } else {
      gaps.push({ index: i, text: (c && c.text) || '' });
    }
  });
  const plan = { goal: String(opts.goal || ''), steps };
  const v = validatePlan(plan);
  return { plan, valid: v.ok, errors: v.errors, gaps };
}

/**
 * Build a durable COMPOSITE capability (a Tier-2 artifact) from a VERIFIED compound run. PURE (the caller stamps
 * id/time). The record rides the SAME matcher rails as a T1 capability (the matcher normalizes any candidate to
 * {id, intent, aliases, effect, groundId, reversible, params}); a composite adds `kind:'composite'` + `steps[]`.
 * This is the tiering made literal: a DISCRETE intent durably becomes a T1 capability; a COMPOUND intent durably
 * becomes a T2 composite, matched ATOMICALLY next time (a T2 cache hit) instead of re-decomposed.
 *
 * TWO shapes:
 *   • FLAT (legacy) — `steps[{capabilityId, bindings, kind, clause, intent}]`, run in order. intent = the ask.
 *   • CONTROL-FLOW — pass `plan` (a lifted IR with foreach/loop/gate/wait nodes). The IR is stored INTACT as
 *     `steps` (so replay runs it through the interpreter), and the record gains a DERIVED, param-ABSTRACTED
 *     identity: `signature` ({params:[{name,sample}], output:{name,type}}), `params` (the matcher's param-name
 *     list), `output`, `controlFlow:true`, and a derived `intent` that generalizes over its arguments (the
 *     bindings are NOT in the phrase) — so the same shape with new args (software/seattle) still matches.
 *   - effect:'composite' + reversible:false → a composite may contain irreversible actions → confirm-first.
 * @returns {object} composite capability record
 */
export function buildCompositeCapability(input) {
  const i = input || {};
  const rawSteps = (i.plan && Array.isArray(i.plan.steps)) ? i.plan.steps : (Array.isArray(i.steps) ? i.steps : []);
  const isControlFlow = rawSteps.some((s) => s && (s.kind === 'foreach' || s.kind === 'loop' || s.kind === 'gate'));

  let steps, params, output, signature, controlFlow;
  if (isControlFlow) {
    steps = rawSteps.map(_irStep).filter(Boolean);     // the IR, sanitized + intact (bodies recurse)
    signature = deriveCompositeSignature(steps);        // {params:[{name,sample}], output:{name,type}}
    params = signature.params.map((p) => p.name);       // matcher param-name list
    output = signature.output;
    controlFlow = true;
  } else {
    steps = rawSteps
      .filter((s) => s && s.capabilityId)
      .map((s) => ({
        capabilityId: String(s.capabilityId),
        bindings: (s.bindings && typeof s.bindings === 'object') ? s.bindings : {},
        kind: s.kind || null,
        clause: String(s.clause || '').slice(0, 200),
        intent: String(s.intent || s.clause || '').slice(0, 200),
      }));
    params = [];
    output = null;
    signature = { params: [], output: null };
    controlFlow = false;
  }
  // INTENT — an explicit override (an LLM polish may supply one) wins; else the param-abstracted derivation (the
  // deterministic floor, control-flow only); else the raw ask.
  const intent = String(i.intent || (isControlFlow ? deriveCompositeIntent(steps, i.ask) : '') || i.ask || '').slice(0, 200);
  return {
    id: i.id || null,
    kind: 'composite',
    effect: 'composite',
    reversible: false,
    controlFlow,
    intent,
    goal: String(i.goal || intent).slice(0, 200),
    name: String(i.name || intent).slice(0, 120),
    aliases: Array.isArray(i.aliases) ? i.aliases.filter(Boolean).slice(0, 12) : [],
    groundId: i.groundId || null,
    steps,
    params,
    ...(output ? { output } : {}),
    signature,
    synthesized: true,
  };
}

// A QUANTIFIER over a collection — "the salaries of EACH job", "open EVERY result", "per row". The signal that a
// compound's tail should run PER ITEM (a foreach), not once.
const _QUANTIFIER = /\b(each|every|for each|of each|all of (?:the|them)|per (?:item|result|job|row|one))\b/i;
// A per-item ACTION ("click each", "open every result", "save each") — the body clicks the item BEFORE reading.
const _CLICK_EACH = /\b(click|open|select|tap|press|expand|save|apply|view)(\s+(?:on|into))?\s+(each|every|all)\b|\b(each|every|all)\b[^.]*\b(click|open|select|expand|view)\b/i;
// The COLLECTION NOUN in an "…each/every/all <noun>" phrase ("open each JOB" → "job"). Stops at structural words so
// "open each job on a NEW PAGE" reads the job, not the page.
const _EACH_NOUN = /\b(?:each|every|all)\s+(?:of\s+)?(?:the\s+)?([a-z][a-z-]{1,30})\b/i;
const _NOUN_STOP = new Set(['new', 'same', 'one', 'other', 'these', 'those', 'page', 'tab', 'window', 'time', 'item', 'them', 'it']);
const _slugUp = (s) => slugUpper(s, { maxWords: 3 });   // v2.74.940 (CR-D2) — shared builder
const _bindOf = (s) => (s && s.bindings && typeof s.bindings === 'object') ? s.bindings : {};

/**
 * ORCH-L (open-each) — lift "…AND open/visit/view EACH <noun>" when the plan carries NO explicit list READ to drive
 * the loop (the collection is IMPLICIT — the results the head action produced). PURE. Synthesizes:
 *   [ head…(the search) , driver: observe(list, TAUGHT on demand) , foreach{ openItem } ]
 * The driver's `capabilityId` is null — the runtime teaches it once (point at one item → a list observation) and
 * fills it, then runs the SAME foreach IR the explicit-list path uses. The body OPENS each row's link in a new tab
 * (a per-item navigation that mustn't lose the result list — so a new tab, not an in-place click). `teachList`
 * flags the driver as the one to teach; `teachNoun` labels the prompt. Returns null when the ask isn't open-each.
 * @param {Array<object>} flat  flat ORCH_PLAN steps
 * @param {string} ask
 * @returns {({steps:object[], lifted:boolean, collect:null, openEach:true, teachNoun:string}|null)}
 */
function _liftOpenEach(flat, ask) {
  const a = String(ask || '');
  if (!_CLICK_EACH.test(a)) return null;
  // The per-item action = the LAST step whose clause/intent carries the quantifier; else the tail action.
  let actIdx = -1;
  for (let i = flat.length - 1; i >= 0; i--) {
    const t = `${(flat[i] && flat[i].clause) || ''} ${(flat[i] && flat[i].intent) || ''}`;
    if (_QUANTIFIER.test(t)) { actIdx = i; break; }
  }
  if (actIdx < 0) actIdx = flat.length - 1;
  if (actIdx < 1) return null;                       // need a HEAD (the list-producing action) before the loop
  const act = flat[actIdx] || {};
  const aid = act.id || `s${actIdx}`;
  const m = `${act.clause || ''} ${act.intent || ''} ${a}`.match(_EACH_NOUN);
  let noun = (m && m[1] && !_NOUN_STOP.has(m[1].toLowerCase())) ? m[1].toLowerCase() : 'result';
  noun = noun.replace(/s$/, '') || noun;             // singularize a plural noun for the prompt ("jobs" → "job")
  const head = flat.slice(0, actIdx).map((s, i) => (s && s.kind === 'observation')
    ? { kind: 'observe', outputType: (s && s.outputType) || 'scalar', id: (s && s.id) || `h${i}`, capabilityId: (s && s.capabilityId) || null, bindings: _bindOf(s), intent: (s && s.intent) || '', clause: (s && s.clause) || '' }
    : { kind: 'fragment', id: (s && s.id) || `h${i}`, capabilityId: (s && s.capabilityId) || null, bindings: _bindOf(s), intent: (s && s.intent) || '', clause: (s && s.clause) || '' });
  const driverId = `src_${aid}`;
  const driver = { kind: 'observe', outputType: 'list', id: driverId, capabilityId: null, bindings: {}, teachList: true, teachNoun: noun, intent: `the ${noun} links`, clause: `each ${noun}` };
  const body = [{ kind: 'fragment', id: `open_${aid}`, openItem: true, capabilityId: null, bindings: {}, intent: act.intent || `open each ${noun}`, clause: act.clause || `open each ${noun}` }];
  const node = { kind: 'foreach', id: `each_${aid}`, over: driverId, itemVar: 'item', body };
  return { steps: [...head, driver, node], lifted: true, collect: null, openEach: true, teachNoun: noun };
}

/** Does the ask QUANTIFY over a collection ("…of each", "every…")? PURE. The chat routes a foreach ask through the
 *  LLM planner (so liftControlFlow can lift it), not the flat lexical chain. */
export function isForeachAsk(ask) { return _QUANTIFIER.test(String(ask || '')); }

/** A FAN-OUT ask: a foreach whose target is Orchard CONVERSATIONS / sub-tasks ("open each in a new conversation"),
 *  not page links. PURE. CV-4-full routes these to the conversation fan-out OVER THE PRIOR STEP'S read (enumerate →
 *  one child conversation per item), distinct from the DOM "open each result link" foreach (liftControlFlow). The
 *  nouns are deliberately the unambiguous Orchard ones — "thread" is excluded (a forum/email page has threads). */
export function isFanoutAsk(ask) {
  const s = String(ask || '');
  return isForeachAsk(s) && /\b(conversations?|sub-?tasks?)\b/i.test(s);
}

/**
 * Lift a FLAT compound plan into a CONTROL-FLOW plan when the ask quantifies over a collection. PURE — the
 * comprehension floor (the LLM may refine; this is the deterministic lift). The collection = the FIRST
 * list-output observation step; everything AFTER it becomes a `foreach` BODY run per item, collecting the body's
 * last read into a named list. Two body shapes:
 *   • read-collection ("the salary of EACH", no click) — the per-item read is POSITIONAL (the Nth list row).
 *   • click-in-place ("click EACH job and read the salary") — the body CLICKS the item, then a WAIT node lets the
 *     LIVE page settle (the detail pane loads async), then a FIXED re-read reads the updated pane (the single
 *     selector, NOT the captured archetype index, which is frozen at one row).
 * Returned unchanged (flat) when there's no quantifier, no list step, or nothing after it. Steps are remapped to
 * the INTERPRETER kinds (observation→observe, anything else→fragment) so orchRun.walkPlan can drive them; the
 * result is meant to pass validatePlan.
 * @param {Array<{capabilityId?,intent?,bindings?,clause?,kind?,outputType?,id?}>} steps  flat ORCH_PLAN steps
 * @param {string} ask
 * @returns {{steps:object[], lifted:boolean, collect:(string|null), clickEach?:boolean}}
 */
export function liftControlFlow(steps, ask) {
  const flat = Array.isArray(steps) ? steps : [];
  if (flat.length < 2 || !_QUANTIFIER.test(String(ask || ''))) return { steps: flat, lifted: false, collect: null };
  // The DRIVER is the first list-producing observation; the steps after it iterate per item.
  const dIdx = flat.findIndex((s) => s && s.kind === 'observation' && String(s.outputType || '').toLowerCase() === 'list');
  // No explicit list READ to iterate? An OPEN/CLICK-each over an IMPLICIT collection ("search jobs AND open each
  // job") still lifts — synthesize a taught list-observation driver + an open-each-in-new-tab body (ORCH-L).
  if (dIdx < 0) { const oe = _liftOpenEach(flat, ask); if (oe) return oe; }
  if (dIdx < 0 || dIdx >= flat.length - 1) return { steps: flat, lifted: false, collect: null };
  // CLICK-each ("click/open each result") → the body CLICKS the item, then re-reads a FIXED panel that updated
  // (not a positional list read). Read-collection ("the salary of each", no click) → the body read is POSITIONAL.
  const clickEach = _CLICK_EACH.test(String(ask || ''));
  const ir = (s, i) => {
    const base = { id: s.id || `s${i}`, capabilityId: s.capabilityId || null, bindings: (s.bindings && typeof s.bindings === 'object') ? s.bindings : {}, intent: s.intent || '', clause: s.clause || '' };
    // CLICK-each body read = a FIXED re-read of the detail pane the click just updated (`fixed:true` → the runtime
    // reads the observation's single selector, NOT the captured archetype index, which is frozen at one list row).
    // Read-collection body read = POSITIONAL (the Nth list item, no click).
    return (s.kind === 'observation')
      ? { kind: 'observe', outputType: s.outputType || 'scalar', ...base, ...(clickEach ? { fixed: true } : { positional: true }) }
      : { kind: 'fragment', ...base };
  };
  const head = flat.slice(0, dIdx).map(ir);
  const d = flat[dIdx];
  const driver = { kind: 'observe', outputType: 'list', id: d.id || `s${dIdx}`, capabilityId: d.capabilityId || null, bindings: {}, intent: d.intent || '', clause: d.clause || '' };
  const trailing = flat.slice(dIdx + 1).map((s, j) => ir(s, dIdx + 1 + j));
  // The per-item CLICK is a synthetic fragment (no capability) — the runtime clicks the item's own selector
  // (scope.item.selector). A WAIT node follows it: these are LIVE pages — the detail pane / inline content loads
  // async after the click, so the read must let the page SETTLE first (pacing as a first-class node, not a buried
  // sleep). Read-collection (no click) needs no settle — the list is already present.
  const clickStep = clickEach ? [{ kind: 'fragment', id: `click_${driver.id}`, clickItem: true, capabilityId: null, bindings: {}, intent: 'click the item', clause: 'click each item' }] : [];
  const settleStep = clickEach ? [{ kind: 'wait', id: `settle_${driver.id}`, ms: 900, reason: 'settle after click (live page)' }] : [];
  const body = [...clickStep, ...settleStep, ...trailing];
  const lastRead = [...body].reverse().find((s) => s.kind === 'observe');
  const collect = lastRead ? (_slugUp(lastRead.intent || lastRead.clause) || 'RESULTS') : null;
  const node = { kind: 'foreach', id: `each_${driver.id}`, over: driver.id, itemVar: 'item', body, ...(collect ? { collect } : {}) };
  return { steps: [...head, driver, node], lifted: true, collect, clickEach };
}

/**
 * Lift a flat plan into a CONDITIONAL plan when the ask is "if/when/unless <condition>, <action>". PURE — the
 * predicate → gate comprehension floor (ORCH-A §6: a predicate output connects via a gate). The CONDITION subject
 * is the (first) observation; the predicate (exists / threshold / contains) is parsed from the ask. Only steps
 * AFTER the condition are the gated consequent; steps BEFORE it run UNCONDITIONALLY as a head — a GUARDED SEQUENCE
 * ("search for jobs AND if there are any, sort by date" keeps the search out of the gate):
 *     head…(ungated) → observe(condition) → analyze(predicate) → gate{ consequent… }
 * When NOTHING follows the condition, the action(s) before it ARE the consequent ("apply UNLESS it is taken" →
 * [apply, observe]) → the observation is hoisted ahead and the action gated. "unless" negates the predicate.
 * Returned unchanged (flat) when there's no conditional, no observation to test, or no action to gate. Meant to
 * pass validatePlan (predicate → gate connection).
 * @param {Array<{capabilityId?,intent?,bindings?,clause?,kind?,outputType?}>} steps  flat ORCH_PLAN steps
 * @param {string} ask
 * @returns {{steps:object[], lifted:boolean, predicate?:object}}
 */
export function liftConditional(steps, ask) {
  const flat = Array.isArray(steps) ? steps : [];
  const a = String(ask || '');
  if (flat.length < 2 || !isConditionalAsk(a)) return { steps: flat, lifted: false };
  const condIdx = flat.findIndex((s) => s && s.kind === 'observation');
  if (condIdx < 0) return { steps: flat, lifted: false };
  const cond = flat[condIdx];
  const _bind = (s) => (s.bindings && typeof s.bindings === 'object') ? s.bindings : {};
  // GUARDED SEQUENCE — steps AFTER the condition are the gated consequent; steps BEFORE it run unconditionally as
  // a head (an explicit "search for jobs" the ask requested). When nothing follows, the action(s) before the
  // condition ARE the consequent ("apply unless taken" → [apply, observe]) → hoist the observation ahead.
  const after = flat.slice(condIdx + 1);
  const before = flat.slice(0, condIdx);
  const headSteps = after.length ? before : [];
  const gatedSteps = after.length ? after : before;
  if (!gatedSteps.length) return { steps: flat, lifted: false };
  const spec = parsePredicate(a);
  if (conditionIsUnless(a)) spec.negate = !spec.negate;
  const head = headSteps.map((s, j) => (s.kind === 'observation')
    ? { kind: 'observe', id: `head${j}`, outputType: s.outputType || 'scalar', capabilityId: s.capabilityId || null, bindings: _bind(s), intent: s.intent || '', clause: s.clause || '' }
    : { kind: 'fragment', id: `head${j}`, capabilityId: s.capabilityId || null, bindings: _bind(s), intent: s.intent || '', clause: s.clause || '' });
  // The condition observation reads what the predicate needs: a VALUE threshold ("under $40k") reads the captured
  // scalar; existence / a COUNT threshold ("more than 10 results") reads the list/count. Fixed ids (no collision
  // among head / observe / gated body steps).
  const valueThreshold = ['gt', 'gte', 'lt', 'lte', 'eq'].includes(spec.op) && spec.target === 'value';
  // `optional` — a gate CONDITION read is FAIL-SAFE: if it can't read (no element on the page, e.g. a zero-results
  // search), the runtime treats it as "nothing found" (predicate false → the gate stays CLOSED) instead of aborting
  // the plan or letting the gated action run. A condition you can't observe is NOT a met condition.
  const observe = { kind: 'observe', id: 'cond', optional: true, outputType: valueThreshold ? (cond.outputType || 'scalar') : (cond.outputType === 'list' ? 'list' : 'count'), capabilityId: cond.capabilityId || null, bindings: _bind(cond), intent: cond.intent || '', clause: cond.clause || '' };
  const analyze = { kind: 'analyze', id: 'pred', over: 'cond', outputType: 'predicate', predicate: spec, intent: predicateLabel(spec), clause: spec.raw };
  const body = gatedSteps.map((s, j) => ({ kind: 'fragment', id: `act${j}`, capabilityId: s.capabilityId || null, bindings: _bind(s), intent: s.intent || '', clause: s.clause || '' }));
  const gate = { kind: 'gate', id: 'gate', over: 'pred', body };
  // SETTLE — when a HEAD action precedes the condition (a guarded sequence: "search … and if there are any …"),
  // that action usually NAVIGATES; the condition must read the SETTLED results, not the pre-navigation page. Without
  // this, the read (DOM or visual) fires ~250ms after the search CLICK — before the new results render — and a
  // populated search reads as empty (a false negative). No head ⇒ the condition reads the current page ⇒ no wait.
  const settle = head.length ? [{ kind: 'wait', id: 'settle_cond', ms: 1800, reason: 'settle after the leading action before reading the condition' }] : [];
  return { steps: [...head, ...settle, observe, analyze, gate], lifted: true, predicate: spec };
}

// ── T2 INTENT DERIVATION — what a control-flow composite IS, derived from its plan IR ─────────────────────────────
// A T1 intent names one grounded act ("the salary"). A T2 intent is a QUANTIFIED COMPOSITION — the head action(s)
// + the per-item read under a collection quantifier, with bindings lifted out to PARAMS. It is, in effect, a typed
// function signature: (params) → collected list. These pure derivations are the deterministic FLOOR (an LLM may
// polish the surface phrase); they read ONLY the plan IR + the ask, never the DOM.

const _str = (s) => String(s == null ? '' : s).slice(0, 200);
const _obj = (o) => (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};

/** Normalize plan|steps → a steps[]. PURE. */
function _planSteps(plan) {
  if (Array.isArray(plan)) return plan;
  return (plan && Array.isArray(plan.steps)) ? plan.steps : [];
}

/** Visit every step in a plan TREE (pre-order, descending into bodies). PURE. */
function _eachStep(steps, fn) {
  for (const s of (Array.isArray(steps) ? steps : [])) {
    if (!s) continue;
    fn(s);
    if (Array.isArray(s.body)) _eachStep(s.body, fn);
  }
}

/** The first foreach/loop node carrying a `collect` — the node that produces the composite's list output. PURE. */
function _findCollector(steps) {
  let found = null;
  _eachStep(steps, (s) => { if (!found && (s.kind === 'foreach' || s.kind === 'loop') && s.collect) found = s; });
  return found;
}

/** Sanitize ONE IR step (whitelist the fields the interpreter/renderer need; recurse into bodies). PURE. Returns
 *  null for an unknown/garbage node so a stored composite carries only valid steps. */
function _irStep(s) {
  if (!s || typeof s !== 'object' || !s.kind) return null;
  const base = { id: String(s.id || ''), kind: s.kind };
  switch (s.kind) {
    case 'fragment': return { ...base, capabilityId: s.capabilityId || null, bindings: _obj(s.bindings), intent: _str(s.intent), clause: _str(s.clause), ...(s.clickItem ? { clickItem: true } : {}), ...(s.openItem ? { openItem: true } : {}) };
    case 'observe': return { ...base, capabilityId: s.capabilityId || null, outputType: s.outputType || 'scalar', intent: _str(s.intent), clause: _str(s.clause), ...(s.positional ? { positional: true } : {}), ...(s.fixed ? { fixed: true } : {}), ...(s.teachList ? { teachList: true, teachNoun: _str(s.teachNoun) } : {}) };
    case 'analyze': return { ...base, over: s.over || null, outputType: s.outputType || 'scalar', intent: _str(s.intent), clause: _str(s.clause) };
    case 'wait': return { ...base, ms: Number.isFinite(s.ms) ? s.ms : 800, ...(s.forSelector ? { forSelector: String(s.forSelector) } : {}), ...(s.reason ? { reason: _str(s.reason) } : {}) };
    case 'foreach': case 'loop': case 'gate': return { ...base, over: s.over || null, ...(s.itemVar ? { itemVar: s.itemVar } : {}), ...(s.collect ? { collect: s.collect } : {}), body: (Array.isArray(s.body) ? s.body : []).map(_irStep).filter(Boolean) };
    default: return null;
  }
}

/**
 * Derive the SIGNATURE of a composite from its plan IR: the PARAMS it takes (the union of its fragment bindings —
 * the user-supplied arguments, first-seen order, with a sample value) and the OUTPUT it produces (a collected
 * list named by the foreach/loop `collect`, else the last read's typed value). PURE.
 * @returns {{params:Array<{name:string,sample:string}>, output:({name:string,type:string}|null)}}
 */
export function deriveCompositeSignature(plan) {
  const steps = _planSteps(plan);
  const params = [];
  const seen = new Set();
  _eachStep(steps, (s) => {
    if (s.kind !== 'fragment' || !s.bindings) return;
    for (const [name, value] of Object.entries(s.bindings)) {
      if (seen.has(name)) continue;
      seen.add(name);
      params.push({ name, sample: value == null ? '' : String(value) });
    }
  });
  const collector = _findCollector(steps);
  let output = null;
  if (collector) {
    output = { name: String(collector.collect), type: 'list' };
  } else {
    let last = null;
    _eachStep(steps, (s) => { if (s.kind === 'observe') last = s; });   // pre-order last read
    if (last) output = { name: _slugUp(last.intent || last.clause) || 'RESULT', type: last.outputType || 'scalar' };
  }
  return { params, output };
}

/**
 * Derive the param-ABSTRACTED intent of a composite from its plan IR. PURE — the deterministic floor. Composes the
 * head action intent(s) with the per-item read under the collection quantifier; bindings are NOT injected (the
 * sub-intents are already general), so the intent generalizes across arguments. Falls back to the flat "A then B"
 * join when there's no collection node, then to the raw ask.
 * @param {object|Array} plan  plan IR (or steps[])
 * @param {string} ask
 * @returns {string}
 */
export function deriveCompositeIntent(plan, ask = '') {
  const steps = _planSteps(plan);
  const actions = [];
  for (const s of steps) {   // head actions = TOP-LEVEL real-capability fragments (skip synthetic clickItem nodes)
    if (s && s.kind === 'fragment' && s.capabilityId && !s.clickItem) {
      const t = _str(s.intent || s.clause).trim();
      if (t) actions.push(t);
    }
  }
  const collector = _findCollector(steps);
  if (collector) {
    let read = null;
    _eachStep(collector.body, (s) => { if (s.kind === 'observe') read = s; });   // the per-item read
    const readNoun = _str((read && (read.intent || read.clause)) || 'the value').trim();
    const action = actions.length ? actions.join(' and ') : 'over the results';
    return `${action}, and collect ${readNoun} for each result`.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  if (actions.length) return actions.join(' then ').slice(0, 200);
  return String(ask || '').slice(0, 200);
}
