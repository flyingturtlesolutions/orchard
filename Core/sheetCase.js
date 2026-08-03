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
export function isSheetDataAsk(text) {
  const q = String(text || '').toLowerCase().trim();
  if (!q) return false;
  if (/^(open|go to|navigate|switch to|close|delete|show me the)\b/.test(q)) return false;   // navigation/action → route
  return /\b(column|header|field|row|record|entr(?:y|ies)|cell|how many|how much|count|number of|which|filter|where|sum|total|average|avg|min|max|list|show|each|value|status|top|most|least|group|sort|distinct|unique)s?\b/.test(q)
    || /\bthis (sheet|file|data|table|spreadsheet)\b/.test(q);
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
