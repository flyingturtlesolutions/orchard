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
// @version 2.74.722

import { planStep, validatePlan } from './orchPlan.js';

// Verbs / question-words that mark the START of a new intent clause. After a connective, one of these → boundary.
const _VERB = /^(?:please\s+|also\s+|then\s+|now\s+)?(search|find|filter|sort|order|open|close|add|remove|delete|clear|select|choose|pick|download|upload|show|list|count|check|get|fetch|go|navigate|visit|play|pause|set|enable|disable|toggle|apply|view|browse|look|read|tell|click|tap|press|book|reserve|subscribe|follow|share|save|edit|update|create|sign|log|register|scroll|what|which|how|is|are|does|do|when|where|who|why|can|could|should)\b/i;

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
 * Build a durable COMPOSITE capability (a Tier-2 artifact) from a VERIFIED compound run: an ordered list of
 * T1-capability references + their bindings. PURE (the caller stamps id/time). The record rides the SAME matcher
 * rails as a T1 capability (the matcher normalizes any candidate to {id, intent, aliases, effect, groundId,
 * reversible, params}); a composite adds `kind:'composite'` + `steps[]`. This is the tiering made literal: a
 * DISCRETE intent durably becomes a T1 capability; a COMPOUND intent durably becomes a T2 composite, matched
 * ATOMICALLY next time (a T2 cache hit) instead of re-decomposed. Running it = run each step in order, reusing the
 * existing per-step runner (REPLAY for action steps, the observation read for read steps).
 *   - effect:'composite' + reversible:false → a composite may contain irreversible actions → confirm-first.
 *   - steps[{capabilityId, bindings, kind, clause, intent}] → references to the T1 artifacts it composes.
 * @returns {object} composite capability record
 */
export function buildCompositeCapability(input) {
  const i = input || {};
  const intent = String(i.intent || i.ask || '').slice(0, 200);
  const steps = (Array.isArray(i.steps) ? i.steps : [])
    .filter((s) => s && s.capabilityId)
    .map((s) => ({
      capabilityId: String(s.capabilityId),
      bindings: (s.bindings && typeof s.bindings === 'object') ? s.bindings : {},
      kind: s.kind || null,
      clause: String(s.clause || '').slice(0, 200),
      intent: String(s.intent || s.clause || '').slice(0, 200),
    }));
  return {
    id: i.id || null,
    kind: 'composite',
    effect: 'composite',
    reversible: false,
    intent,
    goal: String(i.goal || intent).slice(0, 200),
    name: String(i.name || intent).slice(0, 120),
    aliases: Array.isArray(i.aliases) ? i.aliases.filter(Boolean).slice(0, 12) : [],
    groundId: i.groundId || null,
    steps,
    params: [],
    synthesized: true,
  };
}

// A QUANTIFIER over a collection — "the salaries of EACH job", "open EVERY result", "per row". The signal that a
// compound's tail should run PER ITEM (a foreach), not once.
const _QUANTIFIER = /\b(each|every|for each|of each|all of (?:the|them)|per (?:item|result|job|row|one))\b/i;
const _slugUp = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').split('_').filter(Boolean).slice(0, 3).join('_');

/**
 * Lift a FLAT compound plan into a CONTROL-FLOW plan when the ask quantifies over a collection. PURE — the
 * comprehension floor (the LLM may refine; this is the deterministic lift). The collection = the FIRST
 * list-output observation step; everything AFTER it becomes a `foreach` BODY run per item, collecting the body's
 * last read into a named list. Returned unchanged (flat) when there's no quantifier, no list step, or nothing
 * after it. Steps are remapped to the INTERPRETER kinds (observation→observe, anything else→fragment) so
 * orchRun.walkPlan can drive them; the result is meant to pass validatePlan.
 * @param {Array<{capabilityId?,intent?,bindings?,clause?,kind?,outputType?,id?}>} steps  flat ORCH_PLAN steps
 * @param {string} ask
 * @returns {{steps:object[], lifted:boolean, collect:(string|null)}}
 */
export function liftControlFlow(steps, ask) {
  const flat = Array.isArray(steps) ? steps : [];
  if (flat.length < 2 || !_QUANTIFIER.test(String(ask || ''))) return { steps: flat, lifted: false, collect: null };
  // The DRIVER is the first list-producing observation; the steps after it iterate per item.
  const dIdx = flat.findIndex((s) => s && s.kind === 'observation' && String(s.outputType || '').toLowerCase() === 'list');
  if (dIdx < 0 || dIdx >= flat.length - 1) return { steps: flat, lifted: false, collect: null };
  const ir = (s, i) => {
    const base = { id: s.id || `s${i}`, capabilityId: s.capabilityId || null, bindings: (s.bindings && typeof s.bindings === 'object') ? s.bindings : {}, intent: s.intent || '', clause: s.clause || '' };
    return (s.kind === 'observation') ? { kind: 'observe', outputType: s.outputType || 'scalar', ...base } : { kind: 'fragment', ...base };
  };
  const head = flat.slice(0, dIdx).map(ir);
  const d = flat[dIdx];
  const driver = { kind: 'observe', outputType: 'list', id: d.id || `s${dIdx}`, capabilityId: d.capabilityId || null, bindings: {}, intent: d.intent || '', clause: d.clause || '' };
  const body = flat.slice(dIdx + 1).map((s, j) => ir(s, dIdx + 1 + j));
  const lastRead = [...body].reverse().find((s) => s.kind === 'observe');
  const collect = lastRead ? (_slugUp(lastRead.intent || lastRead.clause) || 'RESULTS') : null;
  const node = { kind: 'foreach', id: `each_${driver.id}`, over: driver.id, itemVar: 'item', body, ...(collect ? { collect } : {}) };
  return { steps: [...head, driver, node], lifted: true, collect };
}
