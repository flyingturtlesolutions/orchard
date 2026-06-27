// Core/presetAbstractPrompt.js — §10.2: generalize an instance behavior rule for the SHARED preset. PURE (no chrome
// / LLM / clock). `buildPresetAbstractMessages(rule, presetType) → {system, user}` and
// `parsePresetAbstractOutput(text) → {trigger, body} | null`.
//
// This is the PRIVACY BOUNDARY of distill-up: the abstraction STRIPS instance specifics (company / customer / product
// names, account numbers, exact amounts/dates, KB facts) and keeps only the transferable BEHAVIOR, so what rises to
// the shared preset carries no instance PII. The model may DECLINE (a rule that's only useful with its specifics) →
// null. The user still sees + confirms the abstracted rule before it rises (the §7 HITL gate), so a slip is caught.

const _str = (v) => (typeof v === 'string' ? v.trim() : '');

const _SYSTEM = `You generalize ONE learned behavior rule from a specific app instance into a rule that applies to ANY app of the same TYPE — for a shared template other instances inherit.

Reply with ONLY a JSON object, exactly one of:
  {"ok":true,"trigger":"<when it applies, or null>","body":"<the generalized rule>"}
  {"ok":false}

RULES:
- STRIP every instance-specific detail: company / customer / product names, account numbers, exact amounts, dates, URLs, and any fact about a particular knowledge base. Keep ONLY the transferable BEHAVIOR.
  e.g. "Acme's refund window is 30 days, so check it before refunding" → {"ok":true,"trigger":"before issuing a refund","body":"verify the customer's refund-window eligibility first"}
- If the rule is ONLY useful WITH its specifics (it can't be stated generally without naming them), return {"ok":false}. Never invent a generalization that loses the point, and NEVER carry a specific through.
- Keep it short and imperative — a rule another instance of this type could follow on day one.`;

/** Build the abstraction messages. PURE. The instance rule is the user's OWN learned delta (trusted); presetType frames it. */
export function buildPresetAbstractMessages(rule, presetType) {
  const trigger = _str(rule && rule.trigger);
  const body = _str(rule && rule.body);
  const type = _str(presetType) || 'app';
  const user = `TYPE: ${type}\n\nINSTANCE RULE to generalize:\n${trigger ? `- when: ${trigger}\n` : ''}- rule: ${body}`;
  return { system: _SYSTEM, user };
}

// First balanced top-level {…} object (string/escape-aware), JSON-parsed. PURE. null if none / invalid.
function _firstJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/**
 * Parse {ok, trigger, body}. PURE. Returns the abstracted {trigger, body} ONLY on ok≠false with a non-empty body;
 * otherwise null (the model declined, or unparseable, or no body). A null/'null' trigger collapses to null.
 */
export function parsePresetAbstractOutput(text) {
  const obj = _firstJson(text);
  if (!obj || typeof obj !== 'object' || obj.ok === false) return null;
  const body = _str(obj.body);
  if (!body) return null;
  let trigger = obj.trigger;
  trigger = (trigger == null || String(trigger).trim().toLowerCase() === 'null') ? null : (_str(String(trigger)) || null);
  return { trigger, body };
}
