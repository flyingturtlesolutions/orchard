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

export const INTENTS = ['act', 'navigate', 'decompose', 'clarify', 'teach', 'answer'];

const _str = (x) => (typeof x === 'string' ? x.trim() : '');
const _clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const _idSet = (list) => new Set((Array.isArray(list) ? list : []).map((c) => _str(c && (c.id || c.capabilityId || c.key))).filter(Boolean));
const _opSet = (list) => new Set((Array.isArray(list) ? list : []).map((p) => _str(typeof p === 'string' ? p : (p && (p.op || p.key))).toUpperCase()).filter(Boolean));

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
  if ((d.intent === 'act' || d.intent === 'navigate') && d.confidence < minConfidence) {
    return { ...d, intent: 'clarify',
      question: d.question || (d.intent === 'navigate' ? 'Did you mean to navigate there? I wasn’t sure.' : 'Did you want me to run that? I wasn’t sure.'),
      why: `low-confidence ${d.confidence} < ${minConfidence}` };
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
