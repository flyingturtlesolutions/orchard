// Core/fanoutPersonaPrompt.js — Q2 (v2.74.1263) → FS-6 (v2.74.1830): split a FAN-OUT instruction into its NAMED
// SLOTS. PURE (no chrome / LLM / clock). `buildFanoutSpecMessages(clause) → {system, user}` and
// `parseFanoutSpecOutput(text) → {task, persona, note, gate, title, destination, order, priority}`.
//
// Why an LLM: the lexical `innerDirective` mis-parses these asks. It strips "in the customer's voice" as the
// "in a …" fan-out wrapper (the v1263 persona bug), and it returns '' for "open a case with 1 as the first
// message" because there is no verb — so the user's literal marker was dropped with no trace (findings 07-25).
// One structured call replaces a family of regexes; the clause is the user's OWN ask (trusted), never page text.
//
// ⚠ THE RULE THAT GOVERNS THIS FILE (findings 07-25, LESSON[silence-is-not-success]): a slot the model fills and
// nothing reads is WORSE than no slot, because from outside it looks like the feature works. That is exactly the
// bug this session diagnosed — a filter declared, recorded, and quietly ignored. So every slot here is reported
// by the STEP ▸ receipt as applied or DECLARED-NOT-APPLIED. Adding a name is free; adding a name WITHOUT
// accounting is how you manufacture a new silent drop. Do not add a TENTH slot without its receipt line.
// (v2.74.1832 added  — it RETIRES the fanoutReadAsk regex, which deleted the user's own
// collection because it contained OUR word: "get open warranty CASES" → "get and for each". Two live
// runs died on that. Its receipt line is the readAsk-source log at the chain call site.)

const _str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Every slot this splitter names, with its clamp. The receipt iterates this, so a new slot cannot be forgotten. */
export const FANOUT_SLOTS = Object.freeze({
  task: 200, persona: 300, note: 300, gate: 120, title: 120, destination: 80, order: 80, priority: 40, collection: 160,
});

const _SYSTEM = `You split a FAN-OUT instruction (do something across a list of items — one child conversation, or "case", per item) into NAMED SLOTS.

Reply with ONLY a JSON object with these keys, using null for any slot the instruction does not mention:
{"collection":"<the READ that produces the list, or null>","task":"<what each child DOES, imperative — '' if it's just 'open them'>","persona":"<voice/tone/role to ADOPT, or null>","note":"<literal text to WRITE into each case, or null>","gate":"<an approval/hold the user asked for, or null>","title":"<how to NAME each case, or null>","destination":"<where the cases should live, or null>","order":"<the order/sort requested, or null>","priority":"<urgency or status word, or null>"}

RULES — the distinctions that matter:
- COLLECTION = the read that PRODUCES the list to iterate, stated as its own instruction. "get open warranty cases and for each, open a case with 1" → collection "get open warranty cases". Copy the user's OWN nouns; do not substitute our vocabulary for theirs. null when the ask points at a list already read ("for each of those", "sort them").
- TASK = WHAT each child DOES: an action it must carry out ("research it", "draft a reply", "summarize"). STRIP the fan-out wrapper ("open each in a new conversation / sub thread") and the item itself. '' when the ask is only "open/start each".
- NOTE = literal text to RECORD, not work to perform. "open a case with 1 as the first message" → note "1". "open a case with 0" → note "0". If the user is telling you what the case should SAY, that is a note; if they are telling you what to GO AND DO, that is a task. A bare value, number, or fixed phrase is ALWAYS a note, never a task.
- GATE = a hold the user placed on the work: "for my review", "don't send until I approve", "draft only", "check with me first". Capture the user's own words. null unless a hold is actually requested — do NOT invent one.
- PERSONA = HOW the child should sound or behave ("in the customer's voice", "as a senior engineer", "concise and formal"). Not the item, not the task.
- TITLE = a naming rule for the cases ("name each after the homeowner", "call it Warranty follow-up"). Not the item's own label.
- DESTINATION = where the cases should live ("under the Warranty desk", "in the admin desk").
- ORDER = a requested ordering ("newest first", "highest value first", "by priority").
- PRIORITY = an urgency or status word applied to each case ("urgent", "low priority", "blocked").
- A slot that is not mentioned is null. Never guess, and never move text from one slot into another to fill it.

EXAMPLES:
- "open each ticket in a sub thread and respond in the customer's voice" → {"task":"respond","persona":"in the customer's voice","note":null,"gate":null,"title":null,"destination":null,"order":null,"priority":null}
- "research each in a new conversation" → {"task":"research","persona":null,"note":null,"gate":null,"title":null,"destination":null,"order":null,"priority":null}
- "for each task that has a vendor explanation, open a case with 1 as the first message" → {"task":"","persona":null,"note":"1","gate":null,"title":null,"destination":null,"order":null,"priority":null}
- "open a case for each, mark it urgent and let me review before anything is sent" → {"task":"","persona":null,"note":null,"gate":"let me review before anything is sent","title":null,"destination":null,"order":null,"priority":"urgent"}
- "open the newest 5 in cases named after the homeowner, under the warranty desk" → {"task":"","persona":null,"note":null,"gate":null,"title":"named after the homeowner","destination":"under the warranty desk","order":"newest first","priority":null}`;

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

/** A slot value → clamped string, or null. 'null'/''/non-scalar collapse to null. PURE. */
function _slot(v, max) {
  if (v == null) return null;
  if (typeof v === 'object') return null;   // a model returning {} or [] must not become the string "[object Object]"
  const s = _str(String(v));
  if (!s || s.toLowerCase() === 'null') return null;
  return s.slice(0, max);
}

/**
 * Parse the named slots. PURE. Unparseable → every slot at its empty value.
 * `task` stays '' rather than null (it joins the directive string); every other slot is null-or-text.
 */
export function parseFanoutSpecOutput(text) {
  const obj = _firstJson(text);
  const empty = { task: '', persona: null, note: null, gate: null, title: null, destination: null, order: null, priority: null, collection: null };
  if (!obj || typeof obj !== 'object') return empty;
  const out = { ...empty };
  for (const [name, max] of Object.entries(FANOUT_SLOTS)) {
    out[name] = _slot(obj[name], max);
  }
  out.task = out.task || '';   // '' not null — callers concatenate it
  return out;
}

/** The slots this spec actually declared, as `name="value"` pairs for the receipt. PURE. '' when none. */
export function describeFanoutSpec(spec) {
  const s = (spec && typeof spec === 'object') ? spec : {};
  const parts = [];
  for (const name of Object.keys(FANOUT_SLOTS)) {
    const v = name === 'task' ? (s.task || null) : s[name];
    if (v) parts.push(`${name}="${String(v).slice(0, 60)}"`);
  }
  return parts.join(' · ');
}
