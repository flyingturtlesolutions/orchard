/**
 * @file Services/FileParsers.js
 * @module FileParsers
 * @version 2.74.66
 *
 * Parse a file value collected by ParamForm into a Scope-tagged binding
 * ready to seed into a Strategy invocation's scope.
 *
 * ─── Input shape (from ParamForm) ─────────────────────────────────────────
 *
 *   {
 *     filename:  string,
 *     mimeType:  string,
 *     sizeBytes: number,
 *     dataUrl:   string,   // 'data:<mime>;base64,<base64-bytes>'
 *   }
 *
 * ─── Output shape ─────────────────────────────────────────────────────────
 *
 * A tagged value (see Services/Scope.js):
 *   text       → scalar(content)
 *   json       → scalar | list | record, depending on the JSON's shape
 *   csv        → list(records)   — first row = headers
 *   image      → image({ base64, mime, ... })
 *   docx-text  → scalar  (Pass 2 — needs mammoth.js; stubbed for now)
 *   pdf-text   → scalar  (Pass 2 — needs pdf.js;     stubbed for now)
 *   xlsx       → list    (Pass 2 — needs SheetJS;    stubbed for now)
 *
 * ─── Why dispatch on parserId, not MIME ──────────────────────────────────
 *
 * MIME inference is unreliable: '.csv' often arrives as 'text/plain', '.docx'
 * sometimes as 'application/octet-stream' depending on OS. The Strategy
 * declares `parse: '...'` per param so the author pins the parser at
 * authoring time. `'auto'` is a convenience that uses MIME + filename
 * extension heuristics; explicit parser ids take priority and never look at
 * the file's MIME.
 *
 * ─── Why this lives in Services, not the engine ──────────────────────────
 *
 * The engine seeds scope with already-tagged values; param parsing happens
 * before that loop runs. Studio invocation and chat invocation both reach
 * this module through ExecutionEngine.executeStrategy — keeping parsing as
 * a separate pure-function module means the same code path runs whether
 * the file came from a typed-input strategy param, a future "upload file"
 * action, or a test harness.
 */

import { scalar, list, record, image } from './Scope.js';

// ─── dataUrl → ArrayBuffer (binary-safe) ───────────────────────────────────
//
// fetch() handles 'data:' URLs in MV3 service workers and produces a Response
// whose .arrayBuffer() / .text() do the right thing for any MIME. We use it
// rather than manual atob+Uint8Array because atob silently corrupts on
// non-Latin1 byte sequences (rare for text but common for xlsx/docx zips).
async function dataUrlToArrayBuffer(dataUrl) {
  const res = await fetch(dataUrl);
  return res.arrayBuffer();
}

async function dataUrlToText(dataUrl, encoding = 'utf-8') {
  const buf = await dataUrlToArrayBuffer(dataUrl);
  return new TextDecoder(encoding).decode(buf);
}

// ─── parser: text ──────────────────────────────────────────────────────────
async function parseText(fileValue) {
  const text = await dataUrlToText(fileValue.dataUrl);
  return scalar(text);
}

// ─── parser: json ──────────────────────────────────────────────────────────
//
// JSON has three meaningfully-different shapes that map to different scope
// kinds; collapsing them all to scalar(JSON.stringify(parsed)) would force
// every consumer to re-parse, defeating the whole point of typing inputs.
//
//   array of objects  → list(records)   — natural for FOREACH iteration
//   object            → record(fields)  — natural for {{NAME.field}} access
//   primitive / mixed → scalar          — falls back to a string form
function jsonToTaggedValue(parsed) {
  if (Array.isArray(parsed)) {
    // All elements records → list-of-records. Else stringify items as scalars.
    if (parsed.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
      return list(parsed.map(obj => record(obj)));
    }
    return list(parsed.map(v => scalar(typeof v === 'string' ? v : JSON.stringify(v))));
  }
  if (parsed && typeof parsed === 'object') {
    return record(parsed);
  }
  // primitive (string / number / boolean / null) — scalar carries the string form
  return scalar(typeof parsed === 'string' ? parsed : String(parsed));
}

async function parseJson(fileValue) {
  const text = await dataUrlToText(fileValue.dataUrl);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${fileValue.filename}: ${err.message}`);
  }
  return jsonToTaggedValue(parsed);
}

// ─── parser: csv ───────────────────────────────────────────────────────────
//
// Minimal RFC-4180-ish CSV reader. Handles:
//   - Comma delimiter (configurable would be next step)
//   - Double-quote escaping with "" → " inside quoted fields
//   - CR / LF / CRLF row separators (CR-only is rare but doesn't cost anything)
//   - Trailing newline tolerated
//
// Does NOT handle:
//   - Custom delimiters (tabs / semicolons) — future work, keyed off file
//     extension or an explicit parser option
//   - Header-less files — first row is always treated as headers
//   - Type inference — every cell is a string in the resulting record
//
// For complex spreadsheets, authors should pin parser='xlsx' (when available)
// or convert to JSON upstream.
function splitCsvRows(input) {
  const rows = [];
  let field = '';
  let row = [];
  let i = 0;
  let inQuotes = false;
  const n = input.length;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow   = () => { rows.push(row); row = []; };

  while (i < n) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    // not in quotes
    if (ch === '"' && field.length === 0) { inQuotes = true; i++; continue; }
    if (ch === ',')  { pushField(); i++; continue; }
    if (ch === '\r') { pushField(); pushRow(); if (input[i + 1] === '\n') i++; i++; continue; }
    if (ch === '\n') { pushField(); pushRow(); i++; continue; }
    field += ch; i++;
  }
  // Trailing field/row (no terminating newline)
  if (field.length > 0 || row.length > 0) { pushField(); pushRow(); }
  // Strip a single trailing empty row caused by a final newline
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }
  return rows;
}

async function parseCsv(fileValue) {
  const text = await dataUrlToText(fileValue.dataUrl);
  const rows = splitCsvRows(text);
  if (rows.length === 0) return list([]);

  const headers = rows[0].map(h => h.trim() || '_');   // empty header → '_'
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const fields = {};
    for (let c = 0; c < headers.length; c++) {
      fields[headers[c]] = cells[c] ?? '';
    }
    records.push(record(fields));
  }
  return list(records);
}

// ─── parser: image ─────────────────────────────────────────────────────────
//
// ParamForm hands us the file as a dataUrl already encoded with the source
// MIME — no fetch round-trip needed; just split it apart for the image() tag.
async function parseImage(fileValue) {
  const dataUrl = fileValue.dataUrl || '';
  // 'data:image/png;base64,iVBORw0KGgo...'
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error(`File ${fileValue.filename} is not a base64 dataUrl`);
  return image({
    base64: m[2],
    mime:   m[1] || fileValue.mimeType || 'image/png',
    label:  fileValue.filename,
  });
}

// ─── parser: auto — infer from MIME / extension ────────────────────────────
//
// Hierarchy of evidence (most → least specific):
//   1. explicit MIME (when not the generic catch-alls)
//   2. filename extension
//   3. fall back to text and hope for the best
const EXT_TO_PARSER = {
  json: 'json',
  csv:  'csv',
  txt:  'text',
  md:   'text',
  log:  'text',
  png:  'image',
  jpg:  'image',
  jpeg: 'image',
  gif:  'image',
  webp: 'image',
  svg:  'image',
  bmp:  'image',
  docx: 'docx-text',
  pdf:  'pdf-text',
  xlsx: 'xlsx',
};

const MIME_TO_PARSER = {
  'application/json':       'json',
  'text/csv':               'csv',
  'text/plain':             'text',
  'text/markdown':          'text',
  'application/pdf':        'pdf-text',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx-text',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':       'xlsx',
};

function inferParser(fileValue) {
  // 1. MIME (skip the generics)
  const mime = (fileValue.mimeType || '').toLowerCase();
  if (mime && MIME_TO_PARSER[mime]) return MIME_TO_PARSER[mime];
  if (mime.startsWith('image/'))   return 'image';
  if (mime.startsWith('text/'))    return 'text';

  // 2. Extension (last dot — '.tar.gz' → 'gz' is fine, we don't handle archives)
  const m = /\.([^.]+)$/.exec(fileValue.filename || '');
  if (m && EXT_TO_PARSER[m[1].toLowerCase()]) return EXT_TO_PARSER[m[1].toLowerCase()];

  // 3. Fallback — treat as text. If it's actually binary the user gets a noisy
  // scalar; better than throwing, since at least the strategy gets to run and
  // any downstream text-shaped assertion will fail loudly.
  return 'text';
}

// ─── Stubs for parsers needing third-party libs ────────────────────────────
//
// Shipped as polite errors rather than silent fallbacks so authors get a clear
// signal that the parser isn't wired yet (vs. their file being malformed).
// When mammoth.js / pdf.js / SheetJS land they replace these in-place; the
// dispatcher signature stays identical.
async function parseDocxStub() {
  throw new Error("Parser 'docx-text' isn't shipped yet. Author the strategy with parse: 'text' for plaintext, or wait for the docx parser pass.");
}
async function parsePdfStub() {
  throw new Error("Parser 'pdf-text' isn't shipped yet. Use parse: 'image' to bind the file as an image, or wait for the pdf parser pass.");
}
async function parseXlsxStub() {
  throw new Error("Parser 'xlsx' isn't shipped yet. Export the sheet as CSV and use parse: 'csv', or wait for the xlsx parser pass.");
}

// ─── Public dispatcher ────────────────────────────────────────────────────
const PARSERS = {
  'text':       parseText,
  'json':       parseJson,
  'csv':        parseCsv,
  'image':      parseImage,
  'docx-text':  parseDocxStub,
  'pdf-text':   parsePdfStub,
  'xlsx':       parseXlsxStub,
};

/**
 * Parse a ParamForm file value into a Scope tagged binding.
 *
 * @param {Object} fileValue - { filename, mimeType, sizeBytes, dataUrl }
 * @param {string} [parserId='auto']
 * @returns {Promise<Object>} a Scope tagged value (scalar / list / record / image)
 */
export async function parseFileValue(fileValue, parserId = 'auto') {
  if (!fileValue || typeof fileValue !== 'object' || !fileValue.dataUrl) {
    throw new Error('parseFileValue: missing file value or dataUrl');
  }
  const resolved = (parserId === 'auto' || !PARSERS[parserId])
    ? inferParser(fileValue)
    : parserId;
  const fn = PARSERS[resolved];
  if (!fn) throw new Error(`Unknown file parser: ${resolved}`);
  return fn(fileValue);
}

/** Detect ParamForm's file-value shape — used by the engine to gate parsing. */
export function isFileValue(v) {
  return !!v
    && typeof v === 'object'
    && typeof v.dataUrl === 'string'
    && typeof v.filename === 'string';
}

// Exposed for tests / dispatchers that want to inspect choices.
export const _internals = { inferParser, splitCsvRows, jsonToTaggedValue };
