// Services/xlsx.js — minimal, dependency-free .xlsx → rows reader (v2.74.1976).
//
// An .xlsx is a ZIP of OOXML XML. This reads the FIRST worksheet into a grid, first row = headers, → row objects —
// the SAME `list(records)` shape Services/FileParsers.js's csv parser yields, so an uploaded sheet feeds the whole
// read-answer / aggregate / fan-out engine exactly like a connector read.
//
// Option C (DESIGN_ui_stream.md sibling / the file-input proposal): NO vendored library. The ZIP is walked by hand
// (central directory) and inflated with the platform `DecompressionStream` (`deflate-raw`); the sheet + shared-strings
// XML are parsed with focused regex. The PURE parsers (parseSharedStrings / sheetToGrid / gridToRecords / …) are
// exported for test; `xlsxToRecords` is the impure orchestrator (unzip + inflate).
//
// KNOWN LIMITS (the long tail SheetJS would cover — punted deliberately, swappable behind FileParsers' `parse:'xlsx'`):
//   • dates come through as their SERIAL NUMBER (date detection needs styles.xml numFmt); a sheet storing dates as
//     text is unaffected. • first worksheet only. • no formulas (VALUES only — cached results; a formula string is
//     read, a formula is never executed → no formula-injection). • no merged-cell fan-out. Rows are capped (safety).
//
// UNTRUSTED INPUT: cell text is page-class data. This module only EXTRACTS values into strings; the caller fences them
// as data (FileParsers → a Scope value, never instructions) and renders escape-first.

const MAX_ROWS = 10000;   // safety cap on an untrusted sheet — never unbounded

// ─── XML entity decode (values only) ────────────────────────────────────────
export function decodeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } })
    .replace(/&amp;/g, '&');   // ampersand LAST so it doesn't double-decode
}

// ─── sharedStrings.xml → string[] ───────────────────────────────────────────
// Each <si> is one string; it may hold a direct <t> or several <r><t> runs — concatenate every <t> inside it.
export function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let s = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(m[1]))) s += decodeXml(tm[1]);
    out.push(s);
  }
  return out;
}

// ─── A1 cell ref → zero-based column index ──────────────────────────────────
export function colOf(ref) {
  const m = /^([A-Z]+)\d+$/.exec(String(ref || ''));
  if (!m) return -1;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}

// ─── worksheet XML → grid (string[][]) ──────────────────────────────────────
// Cell types: t="s" shared-string index · t="inlineStr" <is><t> · t="str" formula-string · t="b" boolean · else number.
export function sheetToGrid(xml, sharedStrings = [], { maxRows = MAX_ROWS } = {}) {
  const grid = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) && grid.length < maxRows) {
    const cells = [];
    const cRe = /<c\b\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm, autoCol = 0;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1], inner = cm[2] || '';
      const type = (/t="([^"]+)"/.exec(attrs) || [, 'n'])[1];
      let value = '';
      if (type === 'inlineStr') {
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g; let im; while ((im = tRe.exec(inner))) value += decodeXml(im[1]);
      } else {
        const raw = decodeXml((/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner) || [, ''])[1]);
        if (type === 's') value = sharedStrings[parseInt(raw, 10)] ?? '';
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else value = raw;   // number, or a formula's cached string (t="str")
      }
      const rMatch = /r="([A-Z]+\d+)"/.exec(attrs);
      const col = rMatch ? colOf(rMatch[1]) : autoCol;
      if (col >= 0) cells[col] = value;
      autoCol = (col >= 0 ? col : autoCol) + 1;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    grid.push(cells);
  }
  return grid;
}

// ─── grid → row objects (first row = headers) ───────────────────────────────
export function gridToRecords(grid) {
  if (!grid || !grid.length) return [];
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const headers = [];
  for (let c = 0; c < width; c++) headers.push((String(grid[0][c] ?? '').trim()) || `col${c + 1}`);
  const records = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    if (row.every((c) => c === '' || c == null)) continue;   // skip blank rows
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = row[c] ?? '';
    records.push(obj);
  }
  return records;
}

// ─── first worksheet path from workbook.xml + its rels ──────────────────────
export function firstSheetPath(workbookXml, relsXml) {
  const s = /<sheet\b[^>]*\sr:id="([^"]+)"/.exec(workbookXml || '');
  if (!s) return null;
  const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${s[1]}"[^>]*\\bTarget="([^"]+)"`).exec(relsXml || '')
           || new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${s[1]}"`).exec(relsXml || '');
  if (!rel) return null;
  let target = rel[1].replace(/^\.\//, '');
  if (target.startsWith('/')) return target.slice(1);                 // absolute in-zip path
  return target.startsWith('xl/') ? target : 'xl/' + target.replace(/^\.\.\//, '');   // rels are relative to xl/
}

// ─── ZIP (impure: DecompressionStream) ──────────────────────────────────────
const _u16 = (dv, o) => dv.getUint16(o, true);
const _u32 = (dv, o) => dv.getUint32(o, true);

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(bytes).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Walk the central directory; inflate (or copy) each wanted entry. Minimal: methods 0 (stored) + 8 (deflate), no zip64.
export async function unzip(arrayBuffer, wanted = null) {
  const dv = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const dec = new TextDecoder();
  let eocd = -1;
  for (let i = dv.byteLength - 22; i >= 0; i--) { if (_u32(dv, i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory)');
  const count = _u16(dv, eocd + 10);
  let p = _u32(dv, eocd + 16);
  const out = new Map();
  for (let e = 0; e < count && p + 46 <= dv.byteLength; e++) {
    if (_u32(dv, p) !== 0x02014b50) break;
    const method = _u16(dv, p + 10);
    const compSize = _u32(dv, p + 20);
    const nameLen = _u16(dv, p + 28), extraLen = _u16(dv, p + 30), commentLen = _u16(dv, p + 32);
    const localOff = _u32(dv, p + 42);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (wanted && !wanted.has(name)) continue;
    if (_u32(dv, localOff) !== 0x04034b50) continue;
    const dataStart = localOff + 30 + _u16(dv, localOff + 26) + _u16(dv, localOff + 28);
    const comp = bytes.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? comp : await inflateRaw(comp));
  }
  return out;
}

/** .xlsx ArrayBuffer → array of plain row objects (first sheet, first row = headers). IMPURE (unzip). */
export async function xlsxToRecords(arrayBuffer) {
  const files = await unzip(arrayBuffer);
  const dec = new TextDecoder();
  const text = (name) => { const b = files.get(name); return b ? dec.decode(b) : ''; };
  const shared = files.has('xl/sharedStrings.xml') ? parseSharedStrings(text('xl/sharedStrings.xml')) : [];
  const path = firstSheetPath(text('xl/workbook.xml'), text('xl/_rels/workbook.xml.rels')) || 'xl/worksheets/sheet1.xml';
  const sheetXml = text(path) || text('xl/worksheets/sheet1.xml');
  if (!sheetXml) throw new Error('no worksheet found in the .xlsx');
  return gridToRecords(sheetToGrid(sheetXml, shared));
}
