// Core/fanoutPersonaPrompt.js — Q2 (v2.74.1263): split a FAN-OUT instruction into the per-item TASK and an optional
// per-child PERSONA (a system-prompt voice/tone/role each child adopts). PURE (no chrome / LLM / clock).
// `buildFanoutSpecMessages(clause) → {system, user}` and `parseFanoutSpecOutput(text) → {task, persona}`.
//
// Why an LLM: the lexical `innerDirective` mis-parses persona-bearing asks — "open each in a sub thread and respond in
// the customer's voice" strips "in the customer's voice" as the "in a …" fan-out wrapper, losing the persona entirely.
// The persona, when present, is composed into each child's SEED (composeSeed) so every worker adopts it. Only called
// behind the `personaHint` cost gate. The clause is the user's own ask (trusted); nothing here is page-derived.

const _str = (v) => (typeof v === 'string' ? v.trim() : '');

const _SYSTEM = `You split a FAN-OUT instruction (do something across a list of items — one child conversation per item) into the per-item TASK and an optional per-child PERSONA.

Reply with ONLY a JSON object: {"task":"<what each child DOES, imperative — or empty if it's just 'open them'>","persona":"<the voice / tone / role each child should ADOPT, or null>"}

RULES:
- PERSONA = HOW the child should sound or behave — a voice, tone, style, or role ("in the customer's voice", "as a senior engineer", "concise and formal"). It is NOT the item and NOT the task. null if there's no distinct persona.
- TASK = WHAT each child does ("research it", "draft a reply", "summarize"). STRIP the fan-out wrapper ("open each in a new conversation / sub thread") and the item itself. Empty string if the ask is only "open/start each" with no action.
- e.g. "open each ticket in a sub thread and respond in the customer's voice" → {"task":"respond","persona":"in the customer's voice"}
- e.g. "research each in a new conversation" → {"task":"research","persona":null}`;

/** Build the fan-out-spec messages. PURE. `clause` is the user's own fan-out ask (trusted). */
export function buildFanoutSpecMessages(clause) {
  return { system: _SYSTEM, user: `FAN-OUT: ${_str(clause)}` };
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
 * Parse {task, persona}. PURE. Unparseable → {task:'', persona:null}. A null/'null'/empty persona collapses to null.
 * task defaults to '' (a bare open-each). Both are capped (a persona joins a seed; a task joins the directive).
 */
export function parseFanoutSpecOutput(text) {
  const obj = _firstJson(text);
  if (!obj || typeof obj !== 'object') return { task: '', persona: null };
  const task = _str(obj.task).slice(0, 200);
  let persona = obj.persona;
  persona = (persona == null || String(persona).trim().toLowerCase() === 'null') ? null : (_str(String(persona)).slice(0, 300) || null);
  return { task, persona };
}
