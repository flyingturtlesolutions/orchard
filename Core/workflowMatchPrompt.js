// Core/workflowMatchPrompt.js — WF-3: the LLM fallback for workflow RECALL when the lexical matcher misses.
// PURE (no chrome / LLM / clock). `buildWorkflowMatchMessages(goal, candidates) → {system, user}` and
// `parseWorkflowMatchOutput(text) → {id, confidence}`.
//
// The model picks the ONE saved workflow the new ask wants to RUN — by INTENT/paraphrase, not shared words — or
// null. Precision over recall (a wrong suggestion is more annoying than a miss). SAFETY: the candidates are the
// user's OWN saved asks/aliases (trusted config, fenced as data); the caller VALIDATES the returned id against the
// real set (Core/workflowMemory.resolveWorkflowMatch) and shows a CONFIRM — this only PROPOSES, never replays.

const _str = (v) => (typeof v === 'string' ? v.trim() : '');

const _SYSTEM = `You match a user's new ASK to one of their SAVED WORKFLOWS (multi-step routines they taught once). Decide whether the ASK wants to RUN one of them — judged by INTENT and paraphrase, NOT by shared keywords.

Reply with ONLY a JSON object: {"id":"<the matching workflow id, or null>","confidence":<number 0..1>}

RULES:
- Match MEANING, not words: "pull my tickets and dig into each" SHOULD match "get my open tickets, research each".
- Choose at most ONE — the single best fit. If none clearly fits, return {"id":null,"confidence":0}. A wrong match is worse than a miss; be conservative.
- The id MUST be copied EXACTLY from a candidate below. Never invent an id.
- A pure question, a one-off task, or an unrelated ask → null.`;

/**
 * Build the workflow-match messages. PURE. `goal` = the user's new ask (trusted); `candidates` = their OWN saved
 * {id,name,ask} records (Core/workflowMemory.workflowCandidates), fenced as inert data the model selects from.
 */
export function buildWorkflowMatchMessages(goal, candidates) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((c) => (c && _str(c.id) && _str(c.ask))
      ? `- id: ${_str(c.id)}${_str(c.name) ? `   name: ${_str(c.name)}` : ''}\n  ask: ${_str(c.ask)}`
      : '')
    .filter(Boolean).join('\n');
  const user = `ASK: ${_str(goal)}\n\nSAVED WORKFLOWS (candidates — match by intent; copy an id EXACTLY, or return null):\n${list || '(none)'}`;
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
 * Parse the model's {id, confidence}. PURE. Unparseable / wrong shape → {id:null, confidence:0}. A null/'null'/empty
 * id collapses to null; confidence is coerced to [0,1] (defaults 0.6 when an id is present but no number was given).
 */
export function parseWorkflowMatchOutput(text) {
  const obj = _firstJson(text);
  if (!obj || typeof obj !== 'object') return { id: null, confidence: 0 };
  let id = obj.id;
  id = (id == null || id === false || String(id).trim().toLowerCase() === 'null') ? null : _str(String(id));
  if (!id) return { id: null, confidence: 0 };
  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.6;
  confidence = Math.max(0, Math.min(1, confidence));
  return { id, confidence };
}
