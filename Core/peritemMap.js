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
// Camel/underscore-aware word split: `TaskId` → ['task','id'], `Lot_Block_Phase` → ['lot','block','phase'].
const _camelWords = (k) => String(k == null ? '' : k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ').toLowerCase().trim().split(' ').filter(Boolean);
const _EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// v2.74.1882 — A PHONE GRAMMAR, not a digit run. The old `/(?:\+?\d[\s.-]?){7,}/` had no upper bound, no delimiter
// grammar and no sanity check, so it matched a 9-digit id sitting inside VendorSuite's concatenated `SearchField`
// index — and the value-shape fallback below then returned that whole pipe-joined blob as "the homeowner phone"
// (live 210342, 21:02:07). A phone is 10-11 digits after punctuation is stripped, and nothing that carries a repeated
// field delimiter or reads as an ISO timestamp is a phone number.
const _DIGITS = (s) => String(s).replace(/[\s.()+-]/g, '');
const _ISO_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
// v2.74.1885 — REPAIRED. This line was written by a script whose \t and \1 were interpreted as escapes, so
// v2.74.1885 — A DELIMITER GUARD WAS HERE, WAS CORRUPT, AND IS NOW DELETED RATHER THAN REPAIRED. It read
// `/([|;\t])[^|;\t]*\1/` — "the same delimiter twice means a joined index" — except a script escape wrote a literal
// TAB and a raw 0x01 in place of the class and the backreference, so it required a 0x01 in the value and had been
// INERT since v1882. Repairing it revealed it can never decide anything: `_DIGITS` strips only `[\s.()+-]`, so any
// pipe/semicolon/tab-joined value still carries those characters and fails the `^\d{10,11}$` anchor on its own. A
// guard that cannot fire is the class this log keeps finding, so it goes rather than staying for reassurance.
// The ISO check is kept as an explicit, readable rejection: the anchor happens to reject a timestamp too (the T and
// the colons survive `_DIGITS`), so this is documentation-by-code rather than a load-bearing branch — stated plainly
// instead of implied, which is the difference between a redundant check and a dead one.
function _looksPhone(s) {
  if (_ISO_RE.test(s)) return false;
  const d = _DIGITS(s);
  return /^\d{10,11}$/.test(d);
}

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
  // v2.74.1636 — `itemField` is OPTIONAL: an unspecified ask ("find their Shopify profile") is exactly the case
  // the recipe's declared LADDER exists for. Only the TARGET is load-bearing. An absent itemField is the signal
  // "no field was named" — the executor then runs the ladder instead of treating an invented field as explicit.
  if (!targetSystem || !targetReadAsk) return null;
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
  // v2.74.1885 — `keyWords` is the CAMEL-SPLIT word list, carried alongside `keyNorm` and used only by `_carried`.
  // `_norm` squashes non-alphanumerics but does not split camelCase, so `TaskId` becomes "taskid" — one word. That is
  // fine for the scorer (which substring-matches) and fatal for a word-level test: with only a substring path, a
  // 4-char floor made every SHORT REAL token orphaned ("id number" reported "nothing matches id" on a record full of
  // ids). The floor needs word-splitting to be correct, not just a length rule.
  //
  // v2.74.1903 — DEPTH, from the Shopify pass (gl 08:06): the one-hop scan made `variants.edges[].node.price` and
  // `fulfillments[].trackingInfo[].number` invisible — "price" reported absent on five product rows that all carry
  // it. The walk now descends OBJECTS and ARRAY [0]-elements to depth 4, with GraphQL plumbing segments (edges/node)
  // EXCLUDED from the key text a phrase matches against (a person says "tracking number", never "edges node") while
  // the PATH keeps them — `extractValue` needs the real segments and already walks them. VendorSuite's flat rows see
  // byte-identical candidates: depth only ADDS what the shallow scan could not reach.
  const GQL_SEG = new Set(['edges', 'node', 'nodes']);
  const push = (path, val) => {
    const words = path.split('.').filter((seg) => !GQL_SEG.has(seg));
    const kText = (words.length ? words : path.split('.')).join(' ');
    out.push({ path, keyNorm: _norm(kText), keyWords: kText.split(' ').flatMap((w) => _camelWords(w)), val });
  };
  const walk = (v, path, depth) => {
    if (out.length >= 120) return;
    if (v == null || typeof v !== 'object') { if (path) push(path, v); return; }
    if (Array.isArray(v)) { if (v[0] && typeof v[0] === 'object' && depth < 4) walk(v[0], path, depth); return; }   // [0] — the element extractValue reads
    if (depth >= 4) return;
    for (const [k, vv] of Object.entries(v)) walk(vv, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(row, '', 0);
  return out;
}

function _shapeMatches(typeTok, val) {
  const s = String(val == null ? '' : val);
  if (!s) return false;
  if (typeTok === 'email') return _EMAIL_RE.test(s);
  if (typeTok === 'phone') return _looksPhone(s);
  if (typeTok === 'zip') return /\b\d{5}(?:-\d{4})?\b/.test(s);
  return false;
}

// PM-0 — resolve the field PHRASE → a dotted PATH over the row shape. PURE. Deterministic name-match first; a TYPE
// token (email/phone/…) falls back to matching the VALUE shape.
// Returns { path, matchedBy } | { ambiguous:true, candidates:[{path}] } | null.
// v2.74.1626 — AMBIGUITY IS HONEST (the resolveRideParam discipline: "never silently pick; the caller asks"): when
// two fields tie at the top score ("homeowner" over HomeownerEmail + HomeownerPhone), the caller ASKS which — a
// silent tie-break picked whichever key the API happened to list first, so the same ask could look up phones
// tomorrow. Candidates that never yielded a SCALAR in the sample (a container like `Contacts`, an always-null
// field) are excluded — they can't be a lookup key, and picking one dead-ends every row at "no value".
// v2.74.1882 — `askPhrase` is the ORIGINAL ask; `fieldPhrase` may be a rung of `fieldPhraseCandidates`' ladder, which
// drops leading words. Without it this function cannot tell "PO number" from a bare "number": the ladder hands it
// "number", every token matches, and a tie between TaskNumber and ClaimNumber looks earned while the one token that
// carried the ask's meaning ("po") is gone. Defaults to `fieldPhrase` so every existing caller is unchanged.
export function pickFieldPath(rows, fieldPhrase, askPhrase = fieldPhrase) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object');
  if (!list.length) return null;
  const ptoks = _contentTokens(fieldPhrase);
  if (!ptoks.length) return null;
  const asked = _contentTokens(askPhrase);
  const typeTok = ptoks.find((t) => _TYPE.has(t)) || null;
  // Sample the first few rows so a null-in-row-0 field still gets seen.
  const sample = list.slice(0, 5);
  const cands = new Map();   // path → {path, keyNorm, vals:[]}
  for (const row of sample) {
    for (const c of _candidatePaths(row)) {
      const e = cands.get(c.path) || { path: c.path, keyNorm: c.keyNorm, keyWords: c.keyWords || [], vals: [] };
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
  const scored = [];
  for (const c of cands.values()) {
    if (!c.vals.length) continue;   // v1626 — never yielded a scalar (a container / always-null field) → not a lookup key
    const sc = score(c);
    if (sc > 0) scored.push({ c, sc });
  }
  scored.sort((a, b) => b.sc - a.sc);
  // Which of the ORIGINAL ask's tokens does a candidate actually carry? An ORPHAN is a token the user said that no
  // tied candidate has. It does not change the outcome — the caller still asks — but it changes what may be CLAIMED:
  // "PO number" ties TaskNumber|ClaimNumber on the generic token "number" while "po" is absent from the record, and
  // saying *"'PO number' matches more than one field"* asserts a PO field exists and merely needs disambiguating.
  // Reporting the orphan lets the caller offer the same candidates without the false schema claim.
  // v2.74.1885 — A SHORT TOKEN MUST MATCH A WHOLE WORD. Substring matching on a 2-character token means almost any
  // key "carries" it: live 074157 the same ask got two different answers on two records because "po" is inside
  // ap-**po**intments, so `Appointments` being present decided whether the orphan fired. Record-dependent
  // non-determinism, and worse than the consistent overclaim it replaced. The floor is not a new idea —
  // `fieldPhraseCandidates` (Core/fieldRead.js:126) already refuses to emit a single-word rung under 4 chars for
  // exactly this reason. When v1883 widened the orphan's SCOPE from the tied pair to all candidates it should have
  // brought that floor with it.
  const _MIN_SUBSTR = 4;
  const _carried = (c) => asked.filter((t) => (c.keyWords || []).includes(t) || c.keyNorm.split(' ').includes(t) || (t.length >= _MIN_SUBSTR && c.keyNorm.includes(t)));
  const top = scored[0];
  if (top && top.sc >= 40) {
    const tied = scored.filter((x) => x.sc === top.sc);
    // FR-1 (v2.74.1980) — A LONE WINNER ON THE TYPE TOKEN ALONE IS NOT A NAME MATCH. The orphan test below is the
    // right question ("does the record hold this token anywhere") but it was gated on a TIE, so a single candidate
    // that matched only the generic word skipped it entirely. Live 13:45:33Z: "read the tracking number on each
    // order" scored `Job Number` at 45 (typeTok "number") + 5 − 1 = 49, cleared the 40 floor unopposed, and
    // returned matchedBy:'name' — then FIELD_READ reported `24 × "Job Number" → 24 found, 0 empty`. Twenty-four
    // clean hits on a field the user never asked for, with "tracking" carried by nothing on the record. Same
    // silent class as MR-1: every counter says success.
    // The floor stays where it is; what changes is the CLAIM. Carrying only type tokens while a content token of
    // the ask is absent everywhere is exactly the ambiguous case — so ask, per the v1626 discipline ("never
    // silently pick; the caller asks"). A clean allTokens hit scores >= 100 and is untouched.
    const orphanAll = asked.filter((t) => ![...cands.values()].some((c) => _carried(c).includes(t)));
    if (tied.length === 1 && orphanAll.length) {
      const carriedTop = _carried(top.c);
      if (carriedTop.length && carriedTop.every((t) => _TYPE.has(t))) {
        return { ambiguous: true, orphan: orphanAll, candidates: [{ path: top.c.path }] };
      }
    }
    if (tied.length > 1) {
      // v2.74.1882-b — ORPHAN OVER **ALL** CANDIDATES, not just the tied pair. Computed over the pair alone it said
      // "nothing matches project" for "any project number on this?" while ProjectId, ProjectCode and ProjectName were
      // all on the record — trading an overclaim for a FALSE DENIAL, which is the same fabricated-schema class the
      // change exists to remove. The honest question is "does the record hold this token anywhere", and the function
      // already answers it twelve lines down.
      const orphan = asked.filter((t) => ![...cands.values()].some((c) => _carried(c).includes(t)));
      return { ambiguous: true, orphan, candidates: tied.slice(0, 4).map((x) => ({ path: x.c.path })) };   // v1626 — ask, never guess
    }
    return { path: top.c.path, matchedBy: 'name' };
  }
  // Value-shape fallback: no confident name match, but a TYPE token → the key whose sampled values match the shape.
  // v2.74.1882-b — A QUALIFIER GATE WAS TRIED HERE AND REVERTED. The idea was: if the ask carried a non-type token no
  // candidate key has ("homeowner" in "homeowner phone"), skip the fallback. Adversarial review killed it on two
  // counts. (1) It contributes NOTHING to the live defect — `_looksPhone`'s anchoring alone returns null for the
  // SearchField blob, so the gate only ever changes the outcome where a genuine shape match EXISTS, i.e. where it
  // deletes correct answers: `{TicketId, Cell:'9195550134'}` + "homeowner phone" → null, a false absence after
  // burning a per-row drill enrichment. And a qualifier is the NORM, not the exception — every fieldread ask in the
  // live trace carried one. (2) It was a GLOBAL existence test, not a per-candidate constraint, so adding any
  // qualifier-bearing key reopened the hole: `{…, HomeownerName, ProjectCode:'4451622-01-01'}` + "homeowner phone"
  // returned the composite id. The correct constraint is per-candidate and belongs in the scan below, not as a
  // precondition on it — left undone deliberately rather than shipped wrong.
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

// PM-0 (v2.74.1633) — the JOIN-KEY LADDER: which field should key the cross-system lookup? PURE.
//   1. the ask NAMED a field and it resolves cleanly → that (an explicit request always wins),
//   2. else the RECIPE DECLARED a joinKey and one is present on the rows → that. Domain knowledge the data can't
//      show: a homeowner's email/phone/NAME may differ on the other system (a spouse ordered, a work account),
//      but the warranty SHIPPING ADDRESS is where the parts went — it's the stable key. The v1617 displayId
//      lesson generalized: a declaration is consumed BEFORE the heuristic, never replaced by a smarter one.
//   3. else the named phrase was AMBIGUOUS (and nothing declared) → ambiguous, ask (v1626),
//   4. else null → the honest "which field?".
// Returns { path, matchedBy:'named'|'declared' } | { ambiguous, candidates } | null.
export function resolveJoinField(rows, fieldPhrase, declaredKeys) {
  const named = _str(fieldPhrase) ? pickFieldPath(rows, fieldPhrase) : null;
  if (named && named.path) return { path: named.path, matchedBy: 'named' };
  const sample = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object').slice(0, 5);
  for (const k of (Array.isArray(declaredKeys) ? declaredKeys : [])) {
    if (!_str(k)) continue;
    if (sample.some((r) => extractValue(r, k) != null)) return { path: k, matchedBy: 'declared' };
  }
  if (named && named.ambiguous) return named;   // nothing declared to break the tie → ask
  return null;
}

// ── PM-7 (v2.74.1634) — the LOOKUP LADDER ─────────────────────────────────────────────────────────────────────
// One key often isn't enough: a warranty task should be matched on the ADDRESS first (stable), then the PRIMARY
// HOMEOWNER's email → phone → name, then the OTHER homeowner contact's email → phone → name. Each rung is a
// (value, type) attempt against the type's own target read; the first HIT wins and the rest are skipped.
//
// A rung is either a plain FIELD NAME (a row key/path) or a CONTACT SELECTOR:
//   { contact: 'primary' | 'other', type: 'email' | 'phone' | 'name' }
// Contact selectors resolve against the row's preserved contact LIST (`__contacts`, kept by the enrich pass) by
// ROLE TOKEN + VALUE SHAPE — never by invented field names, because the payload's exact keys/flags vary by app.
// 'primary' = a contact whose role flags/labels contain "primary"; 'other' = the first that does NOT (the user's
// "primary homeowner" vs "homeowner" — two distinct contacts on the same task).
const _CONTACTS_KEY = '__contacts';

const _roleWords = (c) => {
  const out = [];
  for (const [k, v] of Object.entries((c && typeof c === 'object') ? c : {})) {
    if (v === true && /^[Ii]s(?=[_A-Z])/.test(k)) out.push(_norm(k.replace(/^is[_-]?/i, '')));
    else if (typeof v === 'string' && /(role|type|relation|contacttype)/i.test(k)) out.push(_norm(v));
  }
  return out.join(' ');
};
const _isPrimary = (c) => /\bprimary\b/.test(_roleWords(c));
// v2.74.2112 — the ladder's 'other' rung means "the OTHER HOMEOWNER" (the user's "primary homeowner" vs
// "homeowner"), and it was implemented as "the first contact that is not primary". On the real warranty payload the
// builder's own CSR and COORDINATOR ride on every task (HAR 2026-08-08, Core/contactRoles.js), and neither is
// primary — so 'other' resolving them is one array order away, and the value it feeds is the Shopify CUSTOMER
// lookup. That would match, or create, a customer record for a D.R. Horton employee. Staff are excluded by the
// record's own flags: never by name, never by position.
const _isStaff = (c) => /\bdrhorton\b/.test(_roleWords(c)) || /\b(csr|coordinator|customer service)\b/.test(_roleWords(c));

// The best value of `type` on one contact: prefer a key that NAMES the type, else a value whose SHAPE matches. PURE.
function _contactValue(contact, type) {
  if (!contact || typeof contact !== 'object') return null;
  const ents = Object.entries(contact).filter(([, v]) => v != null && v !== '' && typeof v !== 'object');
  const named = ents.find(([k]) => _norm(k).includes(type));
  if (named) return String(named[1]);
  if (type === 'name') {
    const n = ents.find(([k]) => /(fullname|name)$/i.test(k.replace(/[^a-z]/gi, '')));
    return n ? String(n[1]) : null;
  }
  const shaped = ents.find(([, v]) => _shapeMatches(type, v));
  return shaped ? String(shaped[1]) : null;
}

/** Normalize a declared ladder: strings stay field names, objects become {contact,type} rungs. PURE. */
export function normalizeRungs(declared) {
  const out = [];
  for (const r of (Array.isArray(declared) ? declared : [])) {
    if (_str(r)) { out.push({ field: _str(r) }); continue; }
    if (r && typeof r === 'object') {
      const type = _norm(r.type);
      const contact = _norm(r.contact) || 'primary';
      if (type) out.push({ contact: contact === 'other' ? 'other' : 'primary', type });
    }
    if (out.length >= 12) break;   // a ladder, not a crawl
  }
  return out;
}

/**
 * PM-7 — the concrete ATTEMPTS for one row, in ladder order, skipping rungs with no value. PURE.
 * @returns {Array<{value:string, type:string, label:string}>}  type drives which target read the caller uses.
 */
export function ladderValues(row, rungs) {
  const out = [];
  const seen = new Set();
  const contacts = (row && Array.isArray(row[_CONTACTS_KEY])) ? row[_CONTACTS_KEY].filter((c) => c && typeof c === 'object') : [];
  for (const rung of (Array.isArray(rungs) ? rungs : [])) {
    let value = null; let type = _str(rung.type); let label = '';
    if (rung.field) {
      value = extractValue(row, rung.field);
      label = rung.field;
      if (!type) type = _shapeMatches('email', value) ? 'email' : (_shapeMatches('phone', value) ? 'phone' : 'text');
    } else if (rung.type) {
      const owners = contacts.filter((c) => !_isStaff(c));   // a contact rung addresses the CUSTOMER, never the builder's staff
      const pick = rung.contact === 'other' ? owners.find((c) => !_isPrimary(c)) : (owners.find(_isPrimary) || owners[0]);
      value = pick ? _contactValue(pick, rung.type) : null;
      label = `${rung.contact === 'other' ? 'other contact' : 'primary contact'} ${rung.type}`;
    }
    if (value == null || value === '') continue;
    const k = `${type}|${String(value).toLowerCase()}`;
    if (seen.has(k)) continue;   // the same value under two rungs is one attempt, not two
    seen.add(k);
    out.push({ value: String(value), type: type || 'text', label });
  }
  return out;
}

// PM-0 (v2.74.1626) — does the piped VALUE SHAPE contradict what the TARGET read expects? PURE. The Shopify legs
// are TYPED (by_email / by_phone / search-by-name), so feeding phones to the by-email lookup is 24 guaranteed
// misses. `hint` = the target's value-param name + leg name/id; values = a sample of the extracted field.
// Returns a code ('phone-for-email' | 'email-for-phone' | 'not-email' | 'not-phone') or null when consistent
// (including when the target names no shape at all — a free-text search accepts anything).
export function valueShapeMismatch(values, hint) {
  const h = _norm(hint);
  const vals = (Array.isArray(values) ? values : []).filter((v) => v != null && v !== '').slice(0, 5).map(String);
  if (!vals.length) return null;
  const wantsEmail = h.includes('email');
  const wantsPhone = h.includes('phone');
  if (!wantsEmail && !wantsPhone) return null;                                  // an untyped search — nothing to contradict
  const half = Math.ceil(vals.length / 2);
  const looksEmail = vals.filter((v) => _EMAIL_RE.test(v)).length >= half;
  // v2.74.1882 — the same phone grammar as the shape fallback. `_PHONE_RE`'s unbounded digit-run said "looks like a
  // phone" about a column of ids, which is exactly the mismatch this function exists to catch — so tightening it
  // makes the detector STRICTER in the honest direction rather than changing its contract.
  const looksPhone = vals.filter((v) => _looksPhone(v)).length >= half;
  if (wantsEmail && !looksEmail) return looksPhone ? 'phone-for-email' : 'not-email';
  if (wantsPhone && !looksPhone) return looksEmail ? 'email-for-phone' : 'not-phone';
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

// v2.74.1757 — a table-join envelope from buildJoinRows({join:'table'}). Follow-up maps must NOT resolve
// join fields against the envelope top-level (source / match / via) — that is the gl 133556 seam:
// map→map over lastValue died with `MAP ▸ no field — ""` because VS joinKey paths live under source.row.
export function isMapJoinEnvelope(row) {
  return !!(row && typeof row === 'object' && !Array.isArray(row)
    && row.source && typeof row.source === 'object'
    && ('matched' in row || 'match' in row || (row.via && typeof row.via === 'object')));
}

/**
 * v2.74.1757 — unwrap a prior map's table-join output for a FOLLOW-UP map. PURE.
 * - same target system + no named itemField → prefer matched records (the identity the prior map proved)
 * - otherwise → source.row (re-ladder / cross-system / named field on the origin row)
 * Plain lists pass through unchanged ({ mode:'plain' }).
 */
export function unwrapMapPrior(prior, { targetSystem = '', itemField = '' } = {}) {
  const list = (Array.isArray(prior) ? prior : []).filter((r) => r && typeof r === 'object');
  if (!list.length || !isMapJoinEnvelope(list[0])) {
    return { rows: list, mode: 'plain', priorSystem: '' };
  }
  const priorSystem = _str(list[0].via && list[0].via.system);
  const same = !!(priorSystem && targetSystem && _norm(priorSystem) === _norm(targetSystem));
  if (same && !_str(itemField)) {
    const matches = list
      .filter((e) => e && e.matched && e.match && typeof e.match === 'object' && !Array.isArray(e.match))
      .map((e) => e.match);
    if (matches.length) return { rows: matches, mode: 'match', priorSystem };
  }
  const sources = list
    .map((e) => (e && e.source && e.source.row && typeof e.source.row === 'object') ? e.source.row : null)
    .filter(Boolean);
  return { rows: sources.length ? sources : list, mode: 'source', priorSystem };
}

/** v2.74.1757 — identity field on matched-record rows when itemField was omitted (email → phone → id-shaped). */
export function resolveIdentityField(rows) {
  for (const phrase of ['email', 'phone', 'id']) {
    const hit = pickFieldPath(rows, phrase);
    if (hit && hit.path) return { path: hit.path, matchedBy: 'identity' };
  }
  return null;
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

/**
 * JK-2 (v2.74.1994) — the rung the TARGET owns, found by VALUE not by name.
 *
 * The ladder's rungs come from `srcLeg.tool.joinKey`, which describes the relationship the SOURCE rows were read
 * through. For a third-system hop that key is the wrong identifier entirely: live 23:25 and 00:26, `use UPS to
 * track each order` steered the per-item ask with `(match the email …)` because the order rows declare
 * `joinKey: ['customer.email']`, so nothing could key on a tracking number and `ups_track` was never invoked —
 * while the row carried `fulfillments.trackingInfo.number` and the fieldRead even named it as "nearest".
 *
 * So: scan the rows for a value whose SHAPE the target system owns, and offer that path as the first rung.
 * Shape-matched, never name-matched — `trackingInfo.number` and `TrackingNo` and `awb` are all the same thing to
 * a regex over `1Z…` and none of them to a keyword list. Returns null when the rows carry nothing the target
 * owns, so the contact ladder behind it is untouched. PURE — shapes are injected.
 *
 * @param {Array<Object>} rows
 * @param {Array<{re:RegExp, id?:string}>} shapes  identifierShapes.shapesForOwner(targetSystem)
 * @returns {{field:string, ownedBy?:string}|null}
 */
export function targetKeyRung(rows, shapes) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object').slice(0, 5);
  const shp = (Array.isArray(shapes) ? shapes : []).filter((s) => s && s.re instanceof RegExp);
  if (!list.length || !shp.length) return null;
  for (const row of list) {
    for (const c of _candidatePaths(row)) {
      if (c.val == null || typeof c.val === 'object') continue;
      const v = String(c.val).trim();
      if (!v) continue;
      const hit = shp.find((s) => s.re.test(v));
      if (hit) return { field: c.path, ownedBy: hit.id || '' };
    }
  }
  return null;
}

/**
 * PS-2 (v2.74.1995) — a probe value that keeps the TARGET's identifier shape while staying findable.
 *
 * `_mapResolveTarget` asks the router a probe with the row value swapped for a sentinel, then finds which param
 * took it by scanning for that sentinel. A shapeless sentinel satisfies the second need and destroys the first:
 * the router sees `track UPS package MAPQ7VALUEZ`, nothing resembles a tracking number, and it answers NAVIGATE.
 * Eleven successful UPS routes on record all carried a literal `1Z…` — shape is what routes an identifier ask.
 *
 * So: if the target owns a shape that declares a `probeTemplate`, build the sentinel INTO a value of that shape.
 * Returns null when no shape declares one, and the caller falls back to the plain sentinel — every ask that
 * routes today is unaffected. PURE.
 *
 * @param {Array<{re:RegExp, probeTemplate?:string}>} shapes  identifierShapes.shapesForOwner(targetSystem)
 * @param {string} sentinel                                   the findable token the caller scans for
 * @returns {string|null}
 */
export function probeValue(shapes, sentinel) {
  const s = _str(sentinel);
  if (!s) return null;
  for (const sh of (Array.isArray(shapes) ? shapes : [])) {
    const t = sh && typeof sh.probeTemplate === 'string' ? sh.probeTemplate : '';
    if (!t || !t.includes('{s}')) continue;
    const v = t.replace('{s}', s);
    // Both invariants, checked at USE — a template that stops satisfying its own shape must not silently ship a
    // value the router cannot read.
    if (sh.re instanceof RegExp && sh.re.test(v) && v.includes(s)) return v;
  }
  return null;
}
