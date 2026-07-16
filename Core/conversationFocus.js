// FC-1 (v2.74.1552, DESIGN_conversation_focus.md) — CONVERSATION FOCUS: the persisted working set of grounded
// entity handles a conversation is HOLDING (a case's record, the last read), and the pure referent binder that
// resolves deictic/definite asks ("show this ticket", "open the task") against it. Restores the dual-plane
// invariant the case spawn broke: the record exists as STRUCTURE here (fields + provenance) and as PROSE in the
// seed's CASE_RECORD fence — code reads this, the model reads that. Focus is working state, NOT memory: it dies
// with the conversation and is never promoted. PURE — no chrome.*, no storage, no LLM.

import { contentTokens } from './groundVocabulary.js';

export const FOCUS_CAP = 5;

// Generic reference words: they match a KIND of entry, not a specific noun — recency (pinned-first) picks.
const GENERIC_RECORD = new Set(['ticket', 'task', 'record', 'claim', 'item', 'case', 'one', 'request', 'entry']);
const GENERIC_LIST = new Set(['list', 'results', 'items', 'them', 'rows', 'these', 'those']);

const _str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));

/** Scalars-only projection: strings sliced, empties dropped, key count capped — an entry stays small enough to
 *  persist on the conversation record. PURE. */
export function pruneFields(obj, { maxKeys = 48, maxStr = 400 } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (n >= maxKeys) break;
    if (v == null || v === '') continue;
    if (typeof v === 'string') { out[k] = v.length > maxStr ? v.slice(0, maxStr) : v; n++; }
    else if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; n++; }
  }
  return n ? out : null;
}

/** The record NOUN a leg reads/writes: its name cut at qualifier clauses ("Warranty tasks by status" →
 *  "warranty tasks"). PURE. */
export function nounFromLeg(leg) {
  const name = _str(leg && leg.name).toLowerCase();
  const head = name.split(/\s+by\s+|\s+for\s+|\s+with\s+|\s*\(/)[0].trim();
  return head || 'record';
}

// noun → tokens (+ naive singulars, so "task" matches an entry built from "warranty tasks")
function _nounTokens(noun) {
  const toks = contentTokens(_str(noun));
  const out = new Set();
  for (const t of toks) { out.add(t); if (t.length > 3 && t.endsWith('s')) out.add(t.slice(0, -1)); }
  return [...out];
}

function _provenance(leg, params, labels) {
  const tool = (leg && leg.tool) || {};
  const p = {
    groundId: _str(tool.groundId) || null,
    host: _str(tool.origin || tool.appHost || tool.host).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '') || null,
    recipeId: _str(tool.recipeId) || null,
    itemUrl: _str(tool.itemUrl) || null,
    drill: (tool.drill && tool.drill.via && tool.drill.from) ? { via: _str(tool.drill.via), from: _str(tool.drill.from), param: _str(tool.drill.param) || 'id' } : null,
    params: pruneFields(params, { maxKeys: 8, maxStr: 80 }),
    labels: pruneFields(labels, { maxKeys: 8, maxStr: 80 }),
  };
  return p;
}

/** A RECORD focus entry (a single grounded item: a case's dossier, a drilled read). Returns null without a
 *  label or any content to hold. PURE. */
export function focusRecordEntry({ label, noun, fields, leg = null, params = null, labels = null, pinned = false, at = 0 } = {}) {
  const lbl = _str(label).slice(0, 80);
  const f = pruneFields(fields);
  if (!lbl || !f) return null;
  const n = _str(noun) || nounFromLeg(leg);
  return { kind: 'record', noun: n, nounTokens: _nounTokens(n), label: lbl, fields: f, provenance: _provenance(leg, params, labels), ...(pinned ? { pinned: true } : {}), at: at || 0 };
}

/** A LIST focus entry (a grounded read's row set — held for field/render follow-ups; acting on it is FC-6). PURE. */
export function focusListEntry({ label, noun, rows, leg = null, params = null, labels = null, at = 0 } = {}) {
  const lbl = _str(label).slice(0, 80);
  const rs = (Array.isArray(rows) ? rows : []).slice(0, 6).map((r) => pruneFields(r, { maxKeys: 24, maxStr: 200 })).filter(Boolean);
  if (!lbl || !rs.length) return null;
  const n = _str(noun) || nounFromLeg(leg);
  return { kind: 'list', noun: n, nounTokens: _nounTokens(n), label: lbl, rows: rs, provenance: _provenance(leg, params, labels), at: at || 0 };
}

/** Push an entry onto a focus set: newest first, dedupe by kind+label+host (update-in-place moves to front),
 *  cap FOCUS_CAP with PINNED entries exempt from eviction. Returns a NEW array. PURE. */
export function pushFocus(list, entry, cap = FOCUS_CAP) {
  const cur = (Array.isArray(list) ? list : []).filter(Boolean);
  if (!entry) return cur;
  const key = (e) => `${e.kind}·${_str(e.label).toLowerCase()}·${(e.provenance && e.provenance.host) || ''}`;
  const k = key(entry);
  const rest = cur.filter((e) => key(e) !== k);
  const merged = cur.find((e) => key(e) === k);
  const next = [{ ...entry, ...(merged && merged.pinned ? { pinned: true } : {}) }, ...rest];
  if (next.length <= cap) return next;
  // evict from the tail, skipping pinned
  for (let i = next.length - 1; i >= 0 && next.length > cap; i--) { if (!next[i].pinned) next.splice(i, 1); }
  return next.slice(0, Math.max(cap, next.filter((e) => e.pinned).length));
}

// ── The referential gate: lexical SHAPE only — binding requires entry evidence. ──
const _VERB = '(?:show|open|view|display|pull\\s+up|bring\\s+up)';

/** Is this ask a REFERENCE to something at hand? Returns { verb, noun, deictic } or null. An explicit ≥3-digit
 *  run is never a reference (the record-number intercepts own it). PURE. */
export function referentialAsk(text) {
  const t = _str(text).trim();
  if (!t || /\d{3,}/.test(t)) return null;
  let m = t.match(new RegExp(`^${_VERB}\\s+(?:me\\s+)?(?:this|that)\\b\\s*([\\w][\\w\\s'-]*?)?\\s*$`, 'i'));
  if (m) { const n = m[1] === undefined ? null : _cleanNoun(m[1]); if (n !== undefined) return { verb: t.match(/^\w+/)[0].toLowerCase(), noun: n, deictic: 'demonstrative' }; return null; }
  m = t.match(new RegExp(`^${_VERB}\\s+(?:me\\s+)?the\\s+([\\w][\\w\\s'-]*?)\\s*$`, 'i'));
  if (m) { const n = _cleanNoun(m[1]); if (n !== undefined && n !== null) return { verb: t.match(/^\w+/)[0].toLowerCase(), noun: n, deictic: 'definite' }; return null; }
  m = t.match(new RegExp(`^${_VERB}(?:\\s+me)?(?:\\s+it)?\\s*$`, 'i'));
  if (m) return { verb: t.match(/^\w+/)[0].toLowerCase(), noun: null, deictic: 'bare' };
  return null;
}

// VENUE words name a PLACE, not a record — "show the warranty section" is the section-opener's ask, never a
// referent. "page" is the exception: a record's page IS its venue ("show this ticket page" ≡ "show this
// ticket"), so it strips instead of rejecting.
const _VENUE_RE = /\b(?:section|dashboard|queue|board|screen|site|website|home|homepage|menu|panel|settings?)\b/i;

function _cleanNoun(s) {
  if (_VENUE_RE.test(_str(s))) return undefined;   // venue ask — the caller rejects the whole match
  const n = _str(s).toLowerCase().replace(/\b(?:page|please|now|again)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return n || null;
}

/**
 * Bind a referential ask to a focus entry. Deterministic:
 *  - specific noun (∩ entry.nounTokens) outranks generic ("ticket/task/record…"); a specific TIE between two
 *    distinct entries → { ambiguous } (never guess between real alternatives);
 *  - generic / pure-deictic → PINNED first (a case's own record IS "this ticket"), then newest;
 *  - a definite ask ("the X") with NO entry evidence binds nothing — falls through to normal routing.
 * Returns { entry, verb } | { ambiguous: entries, verb } | null. PURE.
 */
export function bindReferent(text, focus) {
  const list = (Array.isArray(focus) ? focus : []).filter((e) => e && e.kind);
  if (!list.length) return null;
  const ref = referentialAsk(text);
  if (!ref) return null;
  const toks = ref.noun ? _nounTokens(ref.noun) : [];
  const scored = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    let specific = 0; let generic = false;
    for (const t of toks) {
      // A generic word ("ticket", "task") is NEVER specific evidence on its own, even when an entry's own
      // vocabulary happens to contain it — otherwise "this ticket" in a warranty case would bind a newer
      // zendesk read over the case's pinned record. "zendesk ticket" is specific via "zendesk".
      if (GENERIC_RECORD.has(t)) { if (e.kind === 'record') generic = true; continue; }
      if (GENERIC_LIST.has(t)) { if (e.kind === 'list') generic = true; continue; }
      if ((e.nounTokens || []).includes(t)) specific++;
    }
    if (!toks.length) { scored.push({ e, score: 1, i }); continue; }   // pure deictic — every entry a candidate; order picks
    const score = specific * 10 + (generic ? 1 : 0);
    if (score > 0) scored.push({ e, score, i });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => (b.score - a.score) || ((b.e.pinned ? 1 : 0) - (a.e.pinned ? 1 : 0)) || (a.i - b.i));
  const top = scored[0];
  if (top.score >= 10) {
    const rival = scored.find((s) => s !== top && s.score === top.score && s.e.label !== top.e.label);
    if (rival) return { ambiguous: [top.e, rival.e], verb: ref.verb };
  }
  return { entry: top.e, verb: ref.verb };
}

// ── Field extraction for the on-site open (the walk's FIND value + the division). ──
const _digits = (v) => { const m = _str(v).match(/\d{5,}/); return m ? m[0] : null; };

/** The record's find/search value: /ticket/ keys → /task number/ → the drill join field → any id-ish ≥6-digit
 *  value → digits in the label. Returns a digit string or null. PURE. */
export function recordFind(entry) {
  const f = (entry && entry.fields) || {};
  const norm = (k) => _str(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  const byKey = (re) => { for (const [k, v] of Object.entries(f)) { if (re.test(norm(k))) { const d = _digits(v); if (d) return d; } } return null; };
  const fromKey = entry && entry.provenance && entry.provenance.drill && entry.provenance.drill.from;
  return byKey(/ticket/) || byKey(/task\s*(?:number|no\b)/) || (fromKey && _digits(f[fromKey])) || byKey(/\b(?:number|id)\b/) || (() => { const m = _str(entry && entry.label).match(/\d{6,}/); return m ? m[0] : null; })();
}

/** The record's division (the walk's DIVISION option label): a /division/ field, else provenance.labels. PURE. */
export function recordDivision(entry) {
  const f = (entry && entry.fields) || {};
  for (const [k, v] of Object.entries(f)) {
    if (/division/i.test(_str(k)) && typeof v === 'string' && /[a-z]/i.test(v)) return v.trim().slice(0, 40);
  }
  const lbl = entry && entry.provenance && entry.provenance.labels;
  if (lbl) { for (const [k, v] of Object.entries(lbl)) { if (/division/i.test(_str(k)) && typeof v === 'string' && /[a-z]/i.test(v)) return v.trim().slice(0, 40); } }
  return null;
}

/** Back-compat: a pre-FC case (no conv.focus) parses its seed's fenced CASE_RECORD ONCE into a synthetic
 *  record entry — same binder, same opener. Fields from its `Key: value` lines; no provenance. PURE. */
export function focusFromSeedRecord(seed, label = 'case record') {
  const rec = (_str(seed).match(/<CASE_RECORD[^>]*>([\s\S]*?)<\/CASE_RECORD>/i) || [])[1] || '';
  if (!rec.trim()) return null;
  const fields = {};
  for (const line of rec.split('\n')) {
    const m = line.match(/^\s*-?\s*\**([\w][\w ()/-]{0,40}?)\**\s*:\s*(.+?)\s*$/);
    if (m) fields[m[1].trim()] = m[2].trim().slice(0, 400);
  }
  return focusRecordEntry({ label, noun: 'record', fields, pinned: true, at: 0 });
}
