/**
 * Core/fieldRead.js — PM-9 (v2.74.1649): the PER-ITEM FIELD READ.
 *
 * The missing third shape. `map` fans one leg across N rows and joins to ANOTHER system; this reads a field off
 * each row's OWN record. Seven live attempts across five traces failed because the map clause REQUIRES a target
 * system, so "for each result, read the Task instructions" had to masquerade as a cross-system lookup — and the
 * model, forced to name a system, named whatever token looked most like one (once the user's real Zendesk queue).
 * No phrase test fixes that; the invention happens before there is anything to test. The fix is this branch.
 *
 * EXTRACTION IS BY TERM, NOT BY STRUCTURE. The user's field (VendorSuite `Instructions`) has no schema — the
 * DEAKO part is "sometimes a numbered item and sometimes appears in a sentence". A delimiter parser inferred from
 * one captured record is an n=1 overfit that works in the demo and fails in the field. So: find the TERM, return
 * the unit that contains it, and let the text's own shape decide what a unit is. When nothing matches, return the
 * whole field — for a short human-authored note that is never wrong, only less focused.
 */

const _s = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));

// A line that opens a new outline item: "4.", "a.", "iv.", "-", "*", "•" — optionally indented, tab or space.
const _ITEM_RE = /^[ \t]*(?:[0-9]{1,2}[.)]|[a-z][.)]|[ivx]{1,4}[.)]|[-*•])\s/i;
// A TOP-level item (numbered). Sub-items (lettered/roman/bulleted) belong to the numbered item above them.
const _TOP_RE = /^[ \t]*[0-9]{1,2}[.)]\s/;

/** Split prose into sentences without swallowing decimals/abbreviations wholesale. PURE. */
export function splitSentences(text) {
  const t = _s(text).trim();
  if (!t) return [];
  return t.split(/(?<=[.!?])\s+(?=[A-Z(“"'])/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Read the part of `text` that concerns `term`. PURE.
 * @returns {{found:boolean, text:string, mode:'item'|'line'|'sentence'|'whole'|'empty', hits:number}}
 *
 * `mode` is part of the contract, not decoration — the caller must be able to say "this is the whole field, I
 * couldn't find that term" rather than presenting a fallback as a targeted answer.
 */
export function readFieldSection(text, term) {
  const body = _s(text).replace(/\r\n/g, '\n').trim();
  if (!body) return { found: false, text: '', mode: 'empty', hits: 0 };
  const needle = _s(term).trim().toLowerCase();
  if (!needle) return { found: true, text: body, mode: 'whole', hits: 0 };

  const has = (x) => x.toLowerCase().includes(needle);

  if (body.includes('\n')) {
    const lines = body.split('\n');
    const out = [];
    let hits = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!has(lines[i])) continue;
      hits++;
      const isItem = _ITEM_RE.test(lines[i]);
      out.push(lines[i].trim());
      // A numbered item owns the sub-items beneath it — the detail usually lives there, not in the label.
      if (isItem && _TOP_RE.test(lines[i])) {
        for (let j = i + 1; j < lines.length; j++) {
          const nxt = lines[j];
          if (!nxt.trim()) continue;
          if (_TOP_RE.test(nxt)) break;                       // next numbered item → this one ended
          if (!_ITEM_RE.test(nxt) && !/^[ \t]+/.test(nxt)) break;   // unindented non-item → back to body text
          out.push(nxt.trim());
          i = j;                                              // don't re-emit as its own hit
        }
      }
    }
    if (out.length) return { found: true, text: out.join('\n'), mode: hits && _ITEM_RE.test(out[0]) ? 'item' : 'line', hits };
    // The term isn't on any line — it may still be inside a long single line; fall through to sentences.
  }

  const sents = splitSentences(body).filter(has);
  if (sents.length) return { found: true, text: sents.join(' '), mode: 'sentence', hits: sents.length };

  return { found: false, text: body, mode: 'whole', hits: 0 };
}

/**
 * Normalize a per-item field-read clause. PURE. Returns null when the shape isn't one.
 * Deliberately mirrors normalizeMapVerdict MINUS the target: that absence IS the distinction, and making it
 * expressible is the entire point (a required slot the caller can't fill generates confident garbage — the
 * lesson from itemField at v1636 and target.system at v1643-1648).
 */
export function normalizeFieldReadVerdict(v) {
  const o = (v && typeof v === 'object') ? v : {};
  const field = _s(o.field).trim();
  if (!field) return null;
  const cap = Number.isFinite(o.cap) ? Math.max(1, Math.floor(o.cap)) : 0;
  return {
    kind: 'fieldRead',
    collection: (o.collection && typeof o.collection === 'object') ? o.collection : 'prior',
    field,
    term: _s(o.term).trim(),          // optional: the part of the field wanted ("DEAKO"); empty = the whole field
    ...(cap ? { cap } : {}),
  };
}

/** One honest line for the run. PURE. */
export function fieldReadTally({ rows = 0, found = 0, whole = 0, missing = 0, field = 'the field', term = '' } = {}) {
  const bits = [`${rows} row${rows === 1 ? '' : 's'}`];
  if (term) bits.push(`${found} with a “${term}” part`);
  if (whole) bits.push(`${whole} showing the whole ${field}${term ? ' (no match)' : ''}`);
  if (missing) bits.push(`${missing} with no ${field}`);
  return bits.join(' · ');
}

/**
 * PM-9b (v2.74.1652) — ordered field-name candidates for one spoken phrase. PURE.
 *
 * Live 112524: the model returned field "tasks instructions" for a key actually named `Instructions`, and the
 * whole run died at the last step — the phrase is a SUPERSET of the key, and exact-name matching only handles the
 * subset direction. People name fields loosely ("the tasks instructions", "task instructions"); the record does
 * not. So try the full phrase first (most specific, and the only one that can disambiguate two similar fields),
 * then progressively drop LEADING words, then individual tokens longest-first.
 *
 * Tokens shorter than 4 chars are dropped: "the", "of", "id" would match half a record by substring, and a wrong
 * field read confidently is worse than an honest "I couldn't find that field".
 */
export function fieldPhraseCandidates(phrase) {
  const t = _s(phrase).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!t) return [];
  const words = t.split(' ').filter(Boolean);
  const out = [];
  const push = (x) => { if (x && !out.includes(x)) out.push(x); };
  push(words.join(' '));
  for (let i = 1; i < words.length; i++) push(words.slice(i).join(' '));   // drop leading words: "tasks instructions" → "instructions"
  [...words].sort((a, b) => b.length - a.length).forEach((w) => { if (w.length >= 4) push(w); });
  return out;
}

/**
 * Resolve a human field PHRASE to the record's actual KEY. PURE. v2.74.1690.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────────────────
 * Live (gl 2026-07-22, trace 081727), one run held both halves of the same disagreement four seconds apart:
 *
 *     FIELD_READ ▸ 22 × "VendorExplanation" → 16 found, 0 whole-field, 6 empty
 *     BRANCH ▸ unknown reasons: record has no field "Vendor Explanation" | … ×22
 *
 * `fieldRead` resolved the user's phrase to the record's key and read it successfully on 16 of 22 rows. The
 * BRANCH then declared the same field absent on all 22, because it matched with `hasOwnProperty` against the
 * phrase verbatim. The data was there the whole time; two components simply disagreed about what a field name is.
 *
 * Every clause that accepts a field name from a person needs the SAME answer, so the matching lives here — beside
 * `fieldPhraseCandidates`, which supplies the ladder — rather than being re-derived per clause.
 *
 * ── AMBIGUITY IS A VERDICT, NOT A MISS ──────────────────────────────────────────────────────────────────────
 * "vendor" against a record carrying both `VendorExplanation` and `VendorName` must NOT silently pick one: the
 * §1626 rule is ask, never guess, and a confidently-wrong field read is the failure this whole area keeps
 * producing. Two matches return `{ambiguous:true, candidates}` with NO key, so the caller can name the tie.
 *
 * `pickFieldPath` was the obvious thing to reuse and is the WRONG tool here: it drops any field that never
 * yielded a value, and "which of those have NO vendor explanation" is precisely a question about the empty ones.
 *
 * @param {string[]|object} keysOrRecord  the record's keys (array), or any object whose OWN keys are the space
 * @param {string} phrase                 what a person called the field
 * @returns {{key:string, ambiguous:boolean, candidates:string[]}}
 */
export function resolveFieldKey(keysOrRecord, phrase) {
  const miss = { key: '', ambiguous: false, candidates: [] };
  const keys = Array.isArray(keysOrRecord)
    ? keysOrRecord.filter((k) => typeof k === 'string' && k)
    : (keysOrRecord && typeof keysOrRecord === 'object' ? Object.keys(keysOrRecord) : []);
  if (!keys.length) return miss;

  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const want = norm(phrase);
  if (!want) return miss;

  // An exact key match short-circuits the whole ladder — a record that literally carries the phrase never needs
  // to be guessed at, and this keeps the common case free of any tie risk.
  const verbatim = keys.find((k) => k === phrase);
  if (verbatim) return { key: verbatim, ambiguous: false, candidates: [] };

  for (const cand of fieldPhraseCandidates(phrase)) {
    const c = norm(cand);
    if (!c) continue;
    // Normalized EQUALITY first — "Vendor Explanation" ≡ `VendorExplanation` ≡ `vendor_explanation`. This is the
    // live case, and it is exact enough that a tie here means genuinely duplicate keys.
    const exact = keys.filter((k) => norm(k) === c);
    if (exact.length === 1) return { key: exact[0], ambiguous: false, candidates: [] };
    if (exact.length > 1) return { key: '', ambiguous: true, candidates: exact };
    // Then CONTAINMENT, which is where ties actually happen and where refusing to guess earns its keep.
    const subs = keys.filter((k) => norm(k).includes(c));
    if (subs.length === 1) return { key: subs[0], ambiguous: false, candidates: [] };
    if (subs.length > 1) return { key: '', ambiguous: true, candidates: subs };
  }
  return miss;
}
