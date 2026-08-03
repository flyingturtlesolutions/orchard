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
