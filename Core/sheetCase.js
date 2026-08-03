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
