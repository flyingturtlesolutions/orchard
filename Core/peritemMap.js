// Core/peritemMap.js — PM-0 (v2.74.1625, DESIGN_peritem_map.md): the per-item CROSS-SYSTEM MAP, pure core.
//
// "#2": for each row of a list, pull a FIELD, run a read on ANOTHER system keyed on that field, join back. This
// module is the pure, testable half — verdict normalization, field-path resolution, extraction, and the join +
// honest tally. The runtime half (interpret verdict → executor → render) is PM-1..PM-5 in chat.js, generalizing
// the RIDE_EACH executor's value-source (a piped field) and target-ground (a connection). NO I/O here.
//
// The one-line model (§Appendix): RIDE_EACH runs one leg × N values (a PARAM DOMAIN) on one ground; `map` runs one
// leg × N values (a PIPED FIELD) on ANOTHER ground, joined back. Same executor; pluggable value-source + ground.

const _str = (x) => (typeof x === 'string' ? x.trim() : '');
const _norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const _EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const _PHONE_RE = /(?:\+?\d[\s.-]?){7,}/;

// Stopwords stripped from the field phrase — possessives/articles the user says but the FIELD never carries
// ("its homeowner's email" → [homeowner, email]).
const _STOP = new Set(['the', 'a', 'an', 'its', 'it', 'their', 'his', 'her', 'of', 'for', 'each', 'this', 'that', 's', 'to', 'in']);
// TYPE tokens carry a value-shape, so a name miss can fall back to matching the VALUE ("email" → a key whose value
// looks like an email). Extend deliberately (a shape must exist below in _shapeMatches).
const _TYPE = new Set(['email', 'phone', 'name', 'address', 'number', 'id', 'zip']);

function _contentTokens(phrase) {
  return _norm(phrase).split(' ').filter((t) => t && !_STOP.has(t));
}

// PM-0 — VALIDATE/normalize a MapClause from the interpret verdict. PURE. Returns the normalized clause or null
// (a malformed map degrades to a normal decompose upstream — never a silent half-map).
//   { kind:'map', collection:'prior'|{readAsk}, itemField, target:{system, readAsk}, join:'table'|'attach', cap }
export function normalizeMapVerdict(raw) {
  const d = (raw && typeof raw === 'object') ? raw : null;
  if (!d) return null;
  const itemField = _str(d.itemField);
  const t = (d.target && typeof d.target === 'object') ? d.target : {};
  const targetSystem = _str(t.system);
  const targetReadAsk = _str(t.readAsk);
  if (!itemField || !targetSystem || !targetReadAsk) return null;   // the three load-bearing fields; without any, it's not a map
  let collection = 'prior';
  if (d.collection && typeof d.collection === 'object' && _str(d.collection.readAsk)) collection = { readAsk: _str(d.collection.readAsk) };
  else if (_str(d.collection) && _str(d.collection) !== 'prior') collection = { readAsk: _str(d.collection) };   // a bare string collection = a self-contained read ask
  const join = d.join === 'attach' ? 'attach' : 'table';
  const cap = (Number.isFinite(d.cap) && d.cap > 0) ? Math.floor(d.cap) : null;   // null → the executor's RIDE_EACH window
  return { kind: 'map', collection, itemField, target: { system: targetSystem, readAsk: targetReadAsk }, join, ...(cap ? { cap } : {}) };
}

// Enumerate candidate field paths on a SAMPLE row: top-level keys + one hop into object values / the first element
// of array-of-object values (a `Contacts[].Email` shape). Dotted paths; array steps descend to [0] at extract. PURE.
function _candidatePaths(row) {
  const out = [];
  if (!row || typeof row !== 'object') return out;
  const push = (path, val) => { out.push({ path, keyNorm: _norm(path.split('.').pop()), val }); };
  for (const [k, v] of Object.entries(row)) {
    push(k, v);
    const inner = Array.isArray(v) ? (v[0] && typeof v[0] === 'object' ? v[0] : null) : (v && typeof v === 'object' ? v : null);
    if (inner) for (const [k2, v2] of Object.entries(inner)) { if (v2 == null || typeof v2 === 'object') continue; push(`${k}.${k2}`, v2); }
  }
  return out;
}

function _shapeMatches(typeTok, val) {
  const s = String(val == null ? '' : val);
  if (!s) return false;
  if (typeTok === 'email') return _EMAIL_RE.test(s);
  if (typeTok === 'phone') return _PHONE_RE.test(s);
  if (typeTok === 'zip') return /\b\d{5}(?:-\d{4})?\b/.test(s);
  return false;
}

// PM-0 — resolve the field PHRASE → a dotted PATH over the row shape. PURE. Deterministic name-match first; a TYPE
// token (email/phone/…) falls back to matching the VALUE shape. Returns { path, matchedBy } or null (→ the caller's
// one LLM assist, or an honest "which field?"). Operates on a SAMPLE of the rows (first object rows).
export function pickFieldPath(rows, fieldPhrase) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object');
  if (!list.length) return null;
  const ptoks = _contentTokens(fieldPhrase);
  if (!ptoks.length) return null;
  const typeTok = ptoks.find((t) => _TYPE.has(t)) || null;
  // Sample the first few rows so a null-in-row-0 field still gets seen.
  const sample = list.slice(0, 5);
  const cands = new Map();   // path → {path, keyNorm, vals:[]}
  for (const row of sample) {
    for (const c of _candidatePaths(row)) {
      const e = cands.get(c.path) || { path: c.path, keyNorm: c.keyNorm, vals: [] };
      if (c.val != null && c.val !== '' && typeof c.val !== 'object') e.vals.push(c.val);
      cands.set(c.path, e);
    }
  }
  const score = (c) => {
    const kt = c.keyNorm.split(' ').filter(Boolean);
    const ktSet = new Set(kt);
    const allTokens = ptoks.every((t) => ktSet.has(t) || c.keyNorm.includes(t));
    let s = 0;
    if (allTokens) s += 100;                                                    // every phrase token is in the key — the clean hit
    else if (typeTok && (ktSet.has(typeTok) || c.keyNorm.includes(typeTok))) s += 45;   // the type token names the key
    s += ptoks.filter((t) => ktSet.has(t) || c.keyNorm.includes(t)).length * 5;   // partial credit + tie-break
    s -= c.path.split('.').length;                                              // prefer shallower (top-level) paths
    s -= Math.max(0, kt.length - ptoks.length);                                 // prefer keys that aren't much longer than the phrase
    return s;
  };
  let best = null, bestScore = 0;
  for (const c of cands.values()) { const sc = score(c); if (sc > bestScore) { best = c; bestScore = sc; } }
  if (best && bestScore >= 40) return { path: best.path, matchedBy: 'name' };
  // Value-shape fallback: no confident name match, but a TYPE token → the key whose sampled values match the shape.
  if (typeTok) {
    let vb = null, vn = 0;
    for (const c of cands.values()) {
      const hits = c.vals.filter((v) => _shapeMatches(typeTok, v)).length;
      if (hits > vn) { vn = hits; vb = c; }
    }
    if (vb) return { path: vb.path, matchedBy: 'shape' };
  }
  return null;
}

// PM-0 — pull the value at a dotted path, descending arrays to their first usable element. PURE. Returns a scalar
// string, or null (the row has no value → the "no field" bucket, never a guess).
export function extractValue(row, path) {
  let cur = row;
  for (const seg of String(path || '').split('.').filter(Boolean)) {
    if (Array.isArray(cur)) cur = cur[0];
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[seg];
  }
  if (Array.isArray(cur)) cur = cur.find((v) => v != null && v !== '' && typeof v !== 'object');
  if (cur == null || cur === '' || typeof cur === 'object') return null;
  return String(cur);
}

// PM-0 — build the JOIN output rows from the source rows + their per-row match results. PURE.
//   results[i] = { value, match, ok, error } | null   (aligned to sourceRows by index; null = the row was skipped)
//   'table'  → [{ source:{id,label,row}, value, match, matched, via }]  (one row per source item)
//   'attach' → [{ ...sourceRow, [attachKey]: match }]                   (fold the match into each source row)
// `identify` (injected) maps a source row → {id,label} (chat passes summarizeItem-with-displayId); `attachKey` names
// the folded field (default '_match'). UNTRUSTED page text — the caller escapes on render.
export function buildJoinRows(sourceRows, results, { join = 'table', identify = null, attachKey = '_match', system = '' } = {}) {
  const src = Array.isArray(sourceRows) ? sourceRows : [];
  const res = Array.isArray(results) ? results : [];
  const _id = (typeof identify === 'function') ? identify : (r) => ({ id: null, label: '' });
  if (join === 'attach') {
    return src.map((row, i) => ({ ...row, [attachKey]: (res[i] && res[i].ok) ? (res[i].match ?? null) : null }));
  }
  return src.map((row, i) => {
    const r = res[i] || null;
    const ident = _id(row) || {};
    return {
      source: { id: ident.id ?? null, label: _str(ident.label), row },
      value: r ? (r.value ?? null) : null,
      match: (r && r.ok) ? (r.match ?? null) : null,
      matched: !!(r && r.ok && r.match != null),
      via: { system: _str(system), ...(r && r.error ? { error: _str(r.error) } : {}) },
    };
  });
}

// PM-0 — the honest tally line (§7). PURE. Counts, never silence: matched / no-field / no-match / failed, capped.
//   { total, matched, noField, noMatch, failed, capped }
export function mapTally({ total = 0, matched = 0, noField = 0, noMatch = 0, failed = 0, capped = false } = {}, { system = 'the other system' } = {}) {
  const n = Math.max(0, total | 0);
  const parts = [`${matched} matched`];
  if (noMatch) parts.push(`${noMatch} with no ${system} match`);
  if (noField) parts.push(`${noField} with no value to look up`);
  if (failed) parts.push(`${failed} failed`);
  const head = `${n} row${n === 1 ? '' : 's'}${capped ? ' (capped)' : ''}: ${parts.join(', ')}.`;
  return head;
}

// PM-0 — the counts from a results array (aligned to source rows). PURE. `failedIsError` distinguishes a read that
// ERRORED (auth/rate) from one that ran and found NOTHING (a legitimate no-match, not a failure).
export function tallyResults(results) {
  const res = Array.isArray(results) ? results : [];
  let matched = 0, noField = 0, noMatch = 0, failed = 0;
  for (const r of res) {
    if (!r || r.value == null || r.value === '') { noField++; continue; }
    if (!r.ok) { failed++; continue; }
    if (r.match == null) { noMatch++; continue; }
    matched++;
  }
  return { total: res.length, matched, noField, noMatch, failed };
}
