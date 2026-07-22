// Core/interpret.js — F-1 (DESIGN_llm_front_door.md §9): the LLM front-door INTERPRET decision core. PURE.
//
// §9.2 — replace the ORCH_MATCH-gatekeeper + JUDGE + greedy-classifier cascade with ONE reasoning call that, given
// the ask + a RETRIEVED candidate set (affordance-aware, FED not gating) + the primitives + the conversation
// context, DECIDES what to do:
//   { intent:'act'|'navigate'|'decompose'|'clarify'|'teach'|'answer', capabilityId?|op?, params?, subAsks?,
//     question?, confidence, why }
// The LLM owns SELECTION + INTENT; the substrate still BINDS + EXECUTES + VERIFIES (the .1118 lesson — only
// interpretation moves to the LLM). This module is the PURE decision layer: normalize the raw output, enforce the
// palette (anti-hallucination — a selected tool MUST be one offered, agentLoop §9), and apply the §9.3 CONFIDENCE
// GATE (the trust mechanism: "ask when unsure" — a low-confidence act/navigate becomes a clarify, NOT a fire; this
// is what stops the "if go to youtube" eager-nav). The live LLM call + prompt + dispatch are F-2.

import { legRef } from './legRef.js';
import { normalizeMapVerdict } from './peritemMap.js';
import { normalizeFieldReadVerdict } from './fieldRead.js';   // PM-9 — the per-item own-record read   // PM-1 (v2.74.1625) — the per-item cross-system MAP verdict
import { normalizeBranchVerdict } from './branchClause.js';   // PP-1 (v2.74.1661) — the per-item BRANCH

export const INTENTS = ['act', 'navigate', 'decompose', 'clarify', 'teach', 'answer', 'map', 'fieldread', 'branch'];   // PM-1 — `map` = the #2 primitive; PM-9 (v1649) — `fieldRead` = the per-item read of the row's OWN record; PP-1 (v1661) — `branch` = the per-item classify-and-route

const _str = (x) => (typeof x === 'string' ? x.trim() : '');
const _clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const _idSet = (list) => new Set((Array.isArray(list) ? list : []).map((c) => _str(legRef(c))).filter(Boolean));
const _opSet = (list) => new Set((Array.isArray(list) ? list : []).map((p) => _str(typeof p === 'string' ? p : legRef(p)).toUpperCase()).filter(Boolean));

/**
 * Normalize a raw interpret decision into the validated §9.2 contract. PURE.
 * @param {object} raw  the LLM's structured output
 * @param {{ retrieved?: Array, primitives?: Array }} [palette]  the offered tools (saved caps + primitives)
 * @returns {{intent:string, capabilityId?:string, op?:string, params:object, subAsks:string[], question:string, confidence:number, why:string}}
 */
export function normalizeInterpretDecision(raw, { retrieved = [], primitives = [] } = {}) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  const intent = INTENTS.includes(d.intent) ? d.intent : 'clarify';
  const params = (d.params && typeof d.params === 'object') ? d.params : {};
  const why = _str(d.why) || _str(d.reason);
  const base = { intent, params, subAsks: [], question: '', confidence: _clamp01(d.confidence), why };

  if (intent === 'act') {
    // The palette = saved capabilities ∪ primitives. A selected tool MUST be one we offered, else the LLM invented
    // (or was steered to invent) it → hand to TEACH, never dispatch (anti-hallucination, §9.2).
    const id = _str(d.capabilityId || d.id);
    const op = _str(d.op).toUpperCase();
    if (id && _idSet(retrieved).has(id)) return { ...base, capabilityId: id };
    if (op && _opSet(primitives).has(op)) return { ...base, op };
    // v1342 (review I) — models often put a primitive op in capabilityId ('OPEN_URL'); honor that too.
    if (id && _opSet(primitives).has(id.toUpperCase())) return { ...base, op: id.toUpperCase() };
    return { ...base, intent: 'teach', why: why || 'tool-not-in-palette' };
  }
  if (intent === 'navigate') {
    const url = _str(params.url);
    if (!/^https?:\/\//i.test(url)) return { ...base, intent: 'clarify', question: 'Which site? Give me a URL or a name.', why: why || 'no-url' };
    return { ...base, op: 'OPEN_URL', params: { ...params, url } };
  }
  if (intent === 'decompose') {
    const subAsks = (Array.isArray(d.subAsks) ? d.subAsks : []).map(_str).filter(Boolean);
    if (subAsks.length < 2) return { ...base, intent: 'clarify', question: 'I can break that into steps — can you say it a bit more concretely?', why: why || 'thin-decompose' };
    return { ...base, subAsks };
  }
  if (intent === 'fieldread') {   // v1650 — LOWERCASE: parseInterpretOutput lowercases every intent, so a camelCase token could never match
    // PM-9 (v2.74.1649) — a per-item read of a field on the row's OWN record. This shape exists BECAUSE `map`
    // requires a target system: seven live attempts at "for each result, read the Task instructions" had to
    // masquerade as cross-system lookups, and the model, forced to name a system, once named the user's real
    // Zendesk queue. No target is required here — that absence IS the shape.
    const fr = normalizeFieldReadVerdict(d.fieldRead || d);
    if (fr) return { ...base, fieldRead: fr };
    return { ...base, intent: 'clarify', question: 'Which field of each item should I read?', why: why || 'fieldRead-underspecified' };
  }
  if (intent === 'map') {
    // PM-1 (DESIGN_peritem_map.md §2) — a per-item cross-system MAP. The LLM extracts {collection, itemField,
    // target} ONCE; normalizeMapVerdict validates the three load-bearing fields. A malformed map DEGRADES to
    // decompose when subAsks were also offered, else to clarify — never a silent half-map.
    const map = normalizeMapVerdict(d.map || d);
    if (map) return { ...base, map };
    const subAsks = (Array.isArray(d.subAsks) ? d.subAsks : []).map(_str).filter(Boolean);
    if (subAsks.length >= 2) return { ...base, intent: 'decompose', subAsks, why: why || 'map-underspecified→decompose' };
    return { ...base, intent: 'clarify', question: 'What field of each item should I look up, and on which system?', why: why || 'map-underspecified' };
  }
  if (intent === 'branch') {
    // PP-1 (v2.74.1661) — a per-item CLASSIFY-AND-ROUTE. `arms` is the only required slot (§1.2): a required
    // `otherwise` would force the model to invent one, which is the failure that cost three versions (itemField
    // v1636, the bulk-write shape v1638, target.system v1643-48). No arms → clarify, never a half-branch.
    const br = normalizeBranchVerdict(d.branch || d);
    if (br) return { ...base, branch: br };
    return { ...base, intent: 'clarify', question: 'What should I sort each item by, and into which groups?', why: why || 'branch-underspecified' };
  }
  if (intent === 'clarify') {
    return { ...base, question: _str(d.question) || 'Can you say that a different way?' };
  }
  // teach | answer — no payload to validate beyond the base.
  return base;
}

/**
 * The §9.3 TRUST GATE: a low-confidence ACT or NAVIGATE becomes a CLARIFY (ask-when-unsure) instead of firing. PURE.
 * This is the property the shipped classifier path lacks — a reasoner can represent its own uncertainty, so a
 * malformed "if go to youtube" gets asked-about, not pattern-extracted and dispatched.
 */
export function applyConfidenceGate(decision, { minConfidence = 0.6 } = {}) {
  const d = (decision && typeof decision === 'object') ? decision
    : { intent: 'clarify', params: {}, subAsks: [], question: '', confidence: 0, why: 'no-decision' };
  // v1342 (review I) — decompose carries lowConfidence (route.js R-6 lesson): chat's dispatch guard reads it.
  if (d.intent === 'decompose' && d.confidence < minConfidence) {
    return { ...d, lowConfidence: true, why: d.why || `low-confidence ${d.confidence} < ${minConfidence}` };
  }
  if ((d.intent === 'act' || d.intent === 'navigate') && d.confidence < minConfidence) {
    return { ...d, intent: 'clarify',
      question: d.question || (d.intent === 'navigate' ? 'Did you mean to navigate there? I wasn’t sure.' : 'Did you want me to run that? I wasn’t sure.'),
      why: `low-confidence ${d.confidence} < ${minConfidence}` };
  }
  // PM-1 — a MAP fans N cross-system reads off one interpretation, so a shaky one asks first (worse to mis-fire N
  // than one). Below the gate → clarify with the map's own question.
  if (d.intent === 'map' && d.confidence < minConfidence) {
    return { ...d, intent: 'clarify', question: d.question || 'I can look each one up on another system — which field, and where?', why: `low-confidence ${d.confidence} < ${minConfidence}` };
  }
  // PP-1 (v2.74.1661) — a BRANCH earns the gate more than a map, not less. A map fans N READS off one shaky
  // interpretation; a branch fans N ROUTING decisions, and each arm can carry a write. Mis-sorting 22 items into
  // the replacements arm is a worse first move than asking one question.
  if (d.intent === 'branch' && d.confidence < minConfidence) {
    return { ...d, intent: 'clarify', question: d.question || 'I can sort them into groups — what should I sort on, and which groups?', why: `low-confidence ${d.confidence} < ${minConfidence}` };
  }
  return d;
}

/**
 * Run the interpret step: call the injected LLM `think`, normalize, gate. PURE over the injected dep (mirrors
 * Core/ilStandin.js's offer/judge). `ctx` carries { retrieved, primitives, affordances, conversationContext }.
 * @returns {Promise<object>} the gated §9.2 decision
 */
export async function interpret(ask, ctx = {}, deps = {}) {
  const { think, minConfidence } = deps || {};
  const goal = _str(ask);
  if (!goal) return { intent: 'clarify', params: {}, subAsks: [], question: 'What would you like me to do?', confidence: 0, why: 'empty-ask' };
  let raw = null;
  try { raw = (typeof think === 'function') ? await think(goal, ctx) : null; } catch { raw = null; }
  const decision = normalizeInterpretDecision(raw, { retrieved: ctx.retrieved, primitives: ctx.primitives });
  return applyConfidenceGate(decision, { minConfidence: Number.isFinite(minConfidence) ? minConfidence : 0.6 });
}
