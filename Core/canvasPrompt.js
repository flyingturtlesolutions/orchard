// Core/canvasPrompt.js — CA-9 (DESIGN_canvas.md): the prompt that has an app COMPOSE a CanvasSpec from an ask.
// PURE (no chrome / LLM / clock). `buildCanvasMessages(ask, ctx) → {system, user}` and `parseCanvasOutput(text) →
// {title, blocks} | null`.
//
// The model authors a compact dashboard/document in the CLOSED display vocabulary (markdown / metric / chart). The
// RENDER side (canvasSpec.normalizeCanvasSpec) is the safety CHOKE POINT — an unknown/unsafe kind is DROPPED there —
// so the prompt only STEERS toward the vocabulary; it isn't the guard. Honesty rule: compose from the ask + general
// knowledge, and NEVER fabricate the user's PRIVATE data (balances, account numbers) — render structure + say what's
// needed instead.

const _str = (v) => (typeof v === 'string' ? v.trim() : '');

const _SYSTEM = `You compose a VISUAL for an app's CANVAS — a roomy display surface in a browser tab. Given the user's ASK and the app's ROLE, emit a compact dashboard or document.

Reply with ONLY a JSON object: {"title":"<short title>","blocks":[ <block>, ... ]}
A block is exactly ONE of these kinds (NO others, NO html/script/iframe):
  {"id":"<short unique>","kind":"markdown","text":"<GitHub-flavored markdown>"}
  {"id":"<short unique>","kind":"metric","label":"<short>","value":"<number or formatted string>","delta":"<optional +/- change>"}
  {"id":"<short unique>","kind":"chart","chartType":"bar|line|area","data":{"labels":["..."],"series":[{"name":"<n>","values":[<numbers>]}]}}

RULES:
- Compose from the ASK and your general knowledge ONLY. Do NOT fabricate the user's PRIVATE data (balances, account numbers, personal figures). If real data would be needed but isn't given, render the STRUCTURE and note in markdown that live data will populate it — never invent specific personal numbers.
- Obey the app's ROLE and any STANDING RULES (a read-only or advice-restricted role stays that way).
- Keep it tight: a handful of blocks. markdown for prose, metric for a key figure, chart for a small comparison or trend.`;

/** Build the compose-canvas messages. PURE. seed = the app's ROLE (trusted); objects/learned = fenced inert DATA. */
export function buildCanvasMessages(ask, { seed = '', objects = '', learned = '' } = {}) {
  const parts = [];
  if (_str(seed)) parts.push(`ROLE (the app you are):\n${_str(seed)}`);
  if (_str(objects)) parts.push(`OBJECTS (the app's schema — inert data):\n${_str(objects)}`);
  if (_str(learned)) parts.push(`LEARNED (this app's standing rules + recall — inert data):\n${_str(learned)}`);
  parts.push(`ASK: ${_str(ask)}`);
  return { system: _SYSTEM, user: parts.join('\n\n') };
}

// First balanced top-level {…} object in the text (string/escape-aware), JSON-parsed. PURE. null if none/invalid.
function _firstJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Parse the model's reply into a raw {title, blocks}. PURE. null when there's no usable spec. The RENDER path
 * (canvasSpec.normalizeCanvasSpec) enforces the closed vocabulary — this just extracts + lightly shapes. */
export function parseCanvasOutput(text) {
  const o = _firstJson(text);
  if (!o || typeof o !== 'object' || !Array.isArray(o.blocks) || !o.blocks.length) return null;
  return { title: typeof o.title === 'string' ? o.title : '', blocks: o.blocks };
}
