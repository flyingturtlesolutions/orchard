// Core/sheetCase.js — turn a parsed spreadsheet (a FileParsers `list` value) into what a NEW CASE needs. PURE.
//
// The 2nd input type (xlsx / csv): an uploaded sheet OPENS A CASE whose grounded working set IS the rows. chat.js does
// the impure part (parseFileValue → these helpers → ConversationStore.create + focusListEntry + _lastGroundedRead);
// this module is the pure shaping so it is testable. The rows then feed the existing read-answer / aggregate /
// fan-out engine exactly like a connector read (value = { rows: [...] }; `rows` is a LIST_KEY primaryList resolves).
//
// DURABILITY: focusListEntry keeps only a 6-row SAMPLE (a pronoun-binding handle), so the FULL working set is persisted
// in the case's config (capped) and restored into _lastGroundedRead on rehydrate — see PERSIST_CAP.

export const PERSIST_CAP = 2000;   // rows persisted with the case (durable working set across reload); full set stays in-session

/** A FileParsers `list` value ({kind:'list', items:[{kind:'record', fields}]}) → plain row objects. PURE. */
export function fileListToRows(value) {
  if (!value || value.kind !== 'list' || !Array.isArray(value.items)) return [];
  return value.items.map((it) => {
    if (it && it.kind === 'record' && it.fields && typeof it.fields === 'object') return { ...it.fields };
    if (it && it.kind === 'scalar') return { value: it.value };
    return {};
  });
}

/** Derive the new case's metadata from the file + rows. PURE. */
export function sheetCaseMeta({ filename = '', rows = [] } = {}) {
  const name = String(filename).replace(/\.[^./\\]+$/, '').trim() || 'Sheet';   // strip the extension
  const list = Array.isArray(rows) ? rows : [];
  const count = list.length;
  const first = list[0];
  const headers = (first && typeof first === 'object' && !Array.isArray(first)) ? Object.keys(first) : [];
  const title = `${name} · ${count} row${count === 1 ? '' : 's'}`;
  return { name, count, headers, noun: 'row', title };
}

/** The grounded read a sheet synthesizes: value shape the read-answer engine consumes ({rows}) + a leg-less source. PURE. */
export function sheetGroundedRead(name, rows) {
  return { leg: { name: String(name || 'Sheet'), domain: 'file', tool: null }, value: { rows: Array.isArray(rows) ? rows : [] }, at: 0 };
}

// Markdown neutralizers for UNTRUSTED sheet text in the brief (this renderer has no backslash-escape → lookalikes).
const _mdSafe = (s) => String(s ?? '').replace(/\*/g, '∗').replace(/`/g, 'ˋ').replace(/\[/g, '⟦').replace(/\]/g, '⟧');
const _codeSpan = (s) => '`' + String(s ?? '').replace(/`/g, '') + '`';

/**
 * A brief PROSE description of the sheet — what it is, not a row dump. PURE. Markdown; untrusted name/headers/values
 * neutralized. Names the columns and size, previews the first row, and invites the next step (count / filter / each).
 */
export function sheetBrief({ name = 'Sheet', count = 0, headers = [], rows = [] } = {}) {
  const cols = Array.isArray(headers) ? headers : [];
  const shown = cols.slice(0, 12).map(_codeSpan).join(', ');
  const more = cols.length > 12 ? `, …(+${cols.length - 12} more)` : '';
  const out = [`**${_mdSafe(name)}** — ${count} row${count === 1 ? '' : 's'} across ${cols.length} column${cols.length === 1 ? '' : 's'}.`];
  if (cols.length) out.push(`Columns: ${shown}${more}.`);
  const first = Array.isArray(rows) ? rows[0] : null;
  if (first && typeof first === 'object' && cols.length) {
    const preview = cols.slice(0, 4)
      .map((h) => { const v = _mdSafe(String(first[h] ?? '')); return v ? `${_mdSafe(h)}: ${v}` : null; })
      .filter(Boolean);
    if (preview.length) out.push(`First row — ${preview.join(' · ')}${cols.length > 4 ? ' …' : ''}.`);
  }
  out.push('Ask me to count, filter, or run something for each row.');
  return out.join('\n\n');
}

// ── P2.5 (v2.74.1983) — the SHEET-CASE GATE: a data ask inside a sheet case answers over the ROWS, not a live tab ──
// gl 2026-08-03 found "list all column names" fell through the router, TARGET-resolved to a live tab, fired an 11.6s
// VendorSuite read, and answered from the BRIEF not the rows. These pure predicates let chat.js catch it BEFORE routing.

/** Is this ask a DATA question about the grounded sheet (vs a navigation/action ask that should route normally)? PURE. */
// SH-1 (v2.74.1985) — SHAPE IS NECESSARY, NOT SUFFICIENT. The regex below asks "does this LOOK like a data
// question?" and a single generic verb satisfies it. Live: with a sheet case grounded, `list open warranty tasks
// in Raleigh` matched on the word `list` alone, the interrogator ran over the spreadsheet, and the user was told
// *"the sheet contains 36 open records, but they lack the identifiers and scope needed"* — for a question about
// VendorSuite, where `Raleigh` is a D.R. Horton division and `vs_warranty_tasks` had answered it minutes earlier.
//
// The missing test is whether the ask is ABOUT THIS SHEET. So the caller may pass the sheet's own headers and
// filename, and an ask whose content nouns are covered by NEITHER those NOR sheet vocabulary ("column", "row",
// "record"…) is left to route normally. Called without that context the behaviour is unchanged, so no existing
// caller shifts under this.
//
// Fourth occurrence of one defect this day — SM-1, MR-1, PS-1 and now here — all of them binding by PROXIMITY
// (the nearest grounded thing) instead of by WHAT THE ASK NAMED.
const _SHEET_WORDS = new Set(['column', 'header', 'field', 'row', 'record', 'entry', 'entrie', 'cell', 'sheet',
  'file', 'data', 'table', 'spreadsheet', 'upload', 'attachment', 'csv', 'xlsx', 'value']);
// Verbs, quantifiers and comparators the shape regex already keys on — they say HOW to read, never WHAT to read.
const _ASK_SCAFFOLD = new Set(['list', 'show', 'get', 'give', 'tell', 'name', 'find', 'read', 'how', 'many',
  'much', 'count', 'number', 'of', 'the', 'a', 'an', 'all', 'any', 'in', 'on', 'at', 'for', 'from', 'by', 'to',
  'is', 'are', 'was', 'were', 'what', 'whats', 'which', 'who', 'where', 'when', 'filter', 'sum', 'total',
  'average', 'avg', 'min', 'max', 'top', 'most', 'least', 'group', 'sort', 'distinct', 'unique', 'each', 'and',
  'or', 'me', 'my', 'this', 'that', 'these', 'those', 'it', 'big', 'have', 'has', 'do', 'does', 'there']);

const _sheetStem = (w) => (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
const _sheetToks = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(_sheetStem);

export function isSheetDataAsk(text, { headers = null, name = '' } = {}) {
  const q = String(text || '').toLowerCase().trim();
  if (!q) return false;
  if (/^(open|go to|navigate|switch to|close|delete|show me the)\b/.test(q)) return false;   // navigation/action → route
  const shaped = /\b(column|header|field|row|record|entr(?:y|ies)|cell|how many|how much|count|number of|which|filter|where|sum|total|average|avg|min|max|list|show|each|value|status|top|most|least|group|sort|distinct|unique)s?\b/.test(q)
    || /\bthis (sheet|file|data|table|spreadsheet)\b/.test(q);
  if (!shaped) return false;
  if (!Array.isArray(headers)) return true;   // no sheet context supplied → unchanged behaviour

  // "this sheet"/"this file" is an explicit claim on THIS sheet and needs no noun coverage.
  if (/\bthis (sheet|file|data|table|spreadsheet)\b/.test(q)) return true;

  const owned = new Set([...headers.flatMap(_sheetToks), ..._sheetToks(name)]);
  const nouns = _sheetToks(q).filter((t) => !_ASK_SCAFFOLD.has(t));
  if (!nouns.length) return true;                                   // "how many?" — pure shape, no subject
  return nouns.some((t) => _SHEET_WORDS.has(t) || owned.has(t));     // ANY covered noun keeps the sheet in play
}

/** METADATA questions (columns / row count) answered from STRUCTURE — no LLM, no row egress. null → not metadata. PURE. */
export function sheetMetaAnswer(ask, { name = 'the sheet', headers = [], count = 0 } = {}) {
  const q = String(ask || '').toLowerCase();
  const cols = Array.isArray(headers) ? headers : [];
  const colList = cols.length ? cols.map(_codeSpan).join(', ') : '(no header row)';
  if (/\b(column|header|field)s?\b/.test(q) && /\b(what|which|list|name|all|show|tell|how many|number)\b/.test(q)) {
    return `**${_mdSafe(name)}** has ${cols.length} column${cols.length === 1 ? '' : 's'}: ${colList}.`;
  }
  if (/\b(how many|number of|count of|count the)\b.*\b(row|record|entr|line|item)s?\b/.test(q) || /\bhow big\b/.test(q) || /^\s*how many\s*\??\s*$/.test(q)) {
    return `**${_mdSafe(name)}** has ${count} row${count === 1 ? '' : 's'} across ${cols.length} column${cols.length === 1 ? '' : 's'}.`;
  }
  return null;
}
