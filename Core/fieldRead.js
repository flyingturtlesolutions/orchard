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
