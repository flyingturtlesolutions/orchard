/**
 * Core/redact.js — R-1 (v2.74.1662): the pre-`#call` PII redactor, pure half.
 *
 * Spec: docs/DESIGN_llm_privacy.md §4(b) + §5. This is the structural fix that doc calls "the highest-leverage
 * item": one pass at payload assembly that pseudonymizes PII, so identity stops crossing the device boundary.
 *
 * ── THE INVARIANT THIS EXISTS TO ENFORCE: fencing ≠ redaction ────────────────────────────────────────────────
 * `<RECORD>` / `<RECENT_TURNS>` / `<SUB_TASKS>` / `<FINDINGS>` are INJECTION fences — "data, not instructions".
 * They do not remove PII, they wrap it. A fenced block is injection-safe and privacy-exposed at the same time.
 * Until this file, there was no redaction layer before `#call` at all: every one of those blocks reached the
 * model as raw content, including customer names, emails and ticket bodies.
 *
 * ── REVERSIBLE, AND LOCAL ────────────────────────────────────────────────────────────────────────────────────
 * Pseudonyms are STABLE within one call (the same value always maps to the same token, so the model can still
 * reason "this person") and the map is in-memory only — never persisted, never sent. `restore` runs on the
 * model's reply so the USER sees the real name and the MODEL never did.
 *
 * ── THE JSON HAZARD, WHICH DRIVES THE RESTORE DESIGN ─────────────────────────────────────────────────────────
 * ~40 call sites JSON-parse the model's reply, and six of them PREFILL an assistant fragment and string-concat
 * it back on before parsing (`'{"step":' + raw.text`). So restore runs on text that is often unparsed JSON.
 * Substituting a real value containing `"` or `\` into a JSON string literal corrupts the parse and loses the
 * whole response.
 *
 * The fix is narrow on purpose: the pseudonym form `⟦email_1⟧` is JSON-safe by construction, and a restored
 * value is inserted RAW when it needs no escaping (emails, phones and the overwhelming majority of names — the
 * common case, byte-identical to a naive restore). Only when the value actually contains `"`, `\` or a control
 * character do we look at whether the occurrence sits inside a JSON string literal, and escape it if so.
 * Over-escaping in prose would be user-visible; under-escaping in JSON destroys the response. So the check is
 * per-occurrence rather than global.
 */

/** Pseudonym delimiters — U+27E6/U+27E7. JSON-safe, vanishingly rare in real content, visually unmistakable. */
const L = '⟦';
const R = '⟧';

/** Matches any pseudonym this module emits. Used by `restore` and by the leak check. */
export const PSEUDONYM_RE = new RegExp(`${L}(person|email|phone|id)_(\\d+)${R}`, 'g');

/** The classes detected, in APPLICATION ORDER. Order is load-bearing: an email contains digits that the phone */
/** and long-id patterns would otherwise eat, leaving a half-redacted address behind. */
export const REDACTION_CLASSES = Object.freeze(['email', 'phone', 'uuid', 'longnum']);

/**
 * Detection patterns. Deliberately reused from `Core/Logger.js`'s log scrub rather than re-derived — that scrub
 * carries two anti-false-positive fixes earned in production, and a second, subtly-different pattern set is
 * exactly the "one vocabulary, two implementations" drift this codebase keeps getting bitten by:
 *   · the `me.`/`team.` leg-ref mask, so a capability ref like `me.zendesk.get_ticket@host` is not read as an email
 *   · the phone boundary guards, so artifact ids stop being eaten as phone numbers
 * Note what is reused is the DETECTION half only. Logger replaces one-way (`[email]`); this is reversible.
 */
const _LEGREF = /\b(?:me|team)\.[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}/g;
const _MASK = '\u0001';   // the same sentinel Logger uses. Written as an ESCAPE, not the raw character: a literal control byte in source makes grep report the file as binary and does not survive every editor round-trip.
const _PATTERNS = Object.freeze({
  email: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  phone: /(?<![\w.@-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w])/g,
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  longnum: /\b\d{8,}\b/g,
});
const _CLASS_TOKEN = { email: 'email', phone: 'phone', uuid: 'id', longnum: 'id' };

/** A fresh, empty redaction map. In-memory only — never persist this, never include it in a payload. */
export function newRedactionMap() {
  return { toPseudo: new Map(), toReal: new Map(), counts: Object.create(null) };
}

const _esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mint (or reuse) the pseudonym for one real value. Stable within a map — the model sees one identity per person. */
function _pseudoFor(map, realValue, token) {
  const real = String(realValue);
  const hit = map.toPseudo.get(real);
  if (hit) return hit;
  const n = (map.counts[token] = (map.counts[token] || 0) + 1);
  const pseudo = `${L}${token}_${n}${R}`;
  map.toPseudo.set(real, pseudo);
  map.toReal.set(pseudo, real);
  return pseudo;
}

/**
 * Redact PII from one string. PURE except for the deliberate accumulation into `map`.
 *
 * @param {string} text
 * @param {Object}   [opts]
 * @param {Object}   [opts.map]      an existing map, so pseudonyms stay stable across a whole payload
 * @param {string[]} [opts.names]    explicit name-set — the read's own `name`/`requester` fields are the cheap
 *                                   seed (§5's open question). Names cannot be pattern-detected; without this
 *                                   they are NOT redacted, and the doc says so rather than implying coverage.
 * @param {string[]} [opts.classes]  which pattern classes to apply (default: all)
 * @returns {{text:string, map:Object, redacted:number}}
 */
export function redact(text, { map = null, names = [], classes = REDACTION_CLASSES } = {}) {
  const m = map || newRedactionMap();
  if (typeof text !== 'string' || !text) return { text: text == null ? '' : String(text), map: m, redacted: 0 };

  let out = text;
  let n = 0;

  // Pre-pass: hide capability leg-refs from the email pattern (Logger's fix, same reason).
  const legrefs = [];
  out = out.replace(_LEGREF, (hit) => { legrefs.push(hit); return `${_MASK}${legrefs.length - 1}${_MASK}`; });

  // Names first: a name-set entry may sit adjacent to an email and we want the longer, explicit match to win.
  // Longest-first so "Jane Doe" is consumed before a bare "Jane" can split it.
  const nameList = (Array.isArray(names) ? names : [])
    .map((x) => String(x ?? '').trim())
    .filter((x) => x.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const name of nameList) {
    const re = new RegExp(`(?<![\\w])${_esc(name)}(?![\\w])`, 'gi');
    out = out.replace(re, () => { n++; return _pseudoFor(m, name, 'person'); });
  }

  for (const cls of classes) {
    const re = _PATTERNS[cls];
    if (!re) continue;
    out = out.replace(re, (hit) => { n++; return _pseudoFor(m, hit, _CLASS_TOKEN[cls]); });
  }

  out = out.replace(new RegExp(`${_MASK}(\\d+)${_MASK}`, 'g'), (_, i) => legrefs[Number(i)] ?? '');
  return { text: out, map: m, redacted: n };
}

/**
 * Walk a value and redact every string in it. Used at the payload choke point, where the whole request body —
 * system prompt INCLUDED — must be covered.
 *
 * The system prompt is not an edge case here, it is the main event: `buildAnswerMessages` puts the caller's
 * `seed` into the SYSTEM slot, and `<RECORD>` / `<FINDINGS>` / `<CASE_RECORD>` are baked into that seed by the
 * panel before any builder runs. A hook that walked only the user message would miss the two highest-sensitivity
 * channels in the egress map while appearing to work.
 */
export function redactDeep(value, { map = null, names = [], classes = REDACTION_CLASSES, skipKeys = [] } = {}) {
  const m = map || newRedactionMap();
  const skip = new Set(skipKeys);
  let redacted = 0;

  const walk = (v) => {
    if (typeof v === 'string') { const r = redact(v, { map: m, names, classes }); redacted += r.redacted; return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = skip.has(k) ? val : walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(value), map: m, redacted };
}

/**
 * True when inserting `s` raw into a JSON string literal would break the parse.
 * Only `"`, `\` and control characters can — everything else (including apostrophes, accents, CJK) is safe.
 */
const _needsJsonEscape = (s) => /["\\\u0000-\u001F]/.test(String(s));

/** JSON-escape a value for insertion inside an existing string literal. */
const _jsonEscape = (s) => JSON.stringify(String(s)).slice(1, -1);

/**
 * Is offset `i` inside a JSON string literal? Scans from the start tracking quote state and backslash escapes.
 *
 * Best-effort by nature: six call sites prefill an assistant fragment (`'{"step":'`) that is prepended AFTER the
 * response comes back, so the reply alone starts mid-structure and the quote state here can be inverted. That is
 * accepted deliberately — it only affects values that ALSO contain `"` or `\`, and the failure it guards is the
 * expensive one (a corrupted parse loses the entire response, while a stray backslash in prose is cosmetic).
 */
function _insideJsonString(text, i) {
  let inStr = false;
  for (let k = 0; k < i; k++) {
    const c = text[k];
    if (c === '\\') { k++; continue; }
    if (c === '"') inStr = !inStr;
  }
  return inStr;
}

/**
 * Restore real values in the model's reply. Local-only de-pseudonymization: the user sees the real name, the
 * model never did.
 *
 * @returns {{text:string, restored:number, unresolved:number}}
 *          `unresolved` counts pseudonyms with no map entry — a model that INVENTS `⟦person_9⟧` would otherwise
 *          leak a placeholder into the UI silently. Callers log it rather than discarding it.
 */
export function restore(text, map) {
  if (typeof text !== 'string' || !text) return { text: text == null ? '' : String(text), restored: 0, unresolved: 0 };
  const m = map && map.toReal ? map.toReal : new Map();
  let restored = 0; let unresolved = 0;

  const out = text.replace(PSEUDONYM_RE, (hit, _cls, _n, offset) => {
    const real = m.get(hit);
    if (real === undefined) { unresolved++; return hit; }
    restored++;
    if (!_needsJsonEscape(real)) return real;                       // the common case — emails, phones, most names
    return _insideJsonString(text, offset) ? _jsonEscape(real) : real;
  });
  return { text: out, restored, unresolved };
}

/**
 * Restore through an already-PARSED structure (objects/arrays/strings).
 *
 * Strictly safer than the text-level `restore`, and where it applies it should be preferred: once the JSON has
 * been parsed there is no string literal to corrupt, so no escaping question arises at all. Used for the
 * tool-forced path, whose reply comes back as a parsed `tool_use.input` rather than as text.
 */
export function restoreDeep(value, map) {
  let restored = 0; let unresolved = 0;
  const walk = (v) => {
    if (typeof v === 'string') { const r = restore(v, map); restored += r.restored; unresolved += r.unresolved; return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(value), restored, unresolved };
}

/**
 * Did anything PII-shaped survive a redaction pass? A cheap self-check for the honest indicator (R-4) and for
 * tests — it answers "did the redactor actually fire", never "is this text safe", which no regex can.
 */
export function residualPii(text, { classes = REDACTION_CLASSES } = {}) {
  if (typeof text !== 'string' || !text) return [];
  const found = [];
  const masked = String(text).replace(_LEGREF, '');
  for (const cls of classes) {
    const re = _PATTERNS[cls];
    if (re && new RegExp(re.source, re.flags.replace('g', '')).test(masked)) found.push(cls);
  }
  return found;
}
