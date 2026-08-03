// Services/xlsx.test.js — the dependency-free .xlsx reader (v2.74.1976).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { decodeXml, parseSharedStrings, colOf, sheetToGrid, gridToRecords, firstSheetPath, xlsxToRecords } from './xlsx.js';

describe('xlsx — pure parsers', () => {
  it('decodeXml unescapes entities (ampersand last)', () => {
    assert.equal(decodeXml('a &amp;lt; b'), 'a &lt; b');   // &amp; → & only, not double-decoded
    assert.equal(decodeXml('&lt;tag&gt; &quot;q&quot; &#65;&#x42;'), '<tag> "q" AB');
  });

  it('parseSharedStrings reads plain <si><t> and multi-run <si><r><t>', () => {
    const xml = `<sst><si><t>Name</t></si><si><t xml:space="preserve">open </t></si><si><r><t>Hel</t></r><r><t>lo</t></r></si></sst>`;
    assert.deepEqual(parseSharedStrings(xml), ['Name', 'open ', 'Hello']);
  });

  it('colOf maps A1 refs to zero-based columns', () => {
    assert.equal(colOf('A1'), 0);
    assert.equal(colOf('B2'), 1);
    assert.equal(colOf('Z9'), 25);
    assert.equal(colOf('AA1'), 26);
    assert.equal(colOf('bad'), -1);
  });

  it('sheetToGrid handles shared/inline/number/boolean cells and sparse columns', () => {
    const shared = ['Name', 'Status'];
    const xml = `<sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>Alice</t></is></c><c r="C2"><v>42</v></c><c r="D2" t="b"><v>1</v></c></row>
    </sheetData>`;
    const grid = sheetToGrid(xml, shared);
    assert.deepEqual(grid[0], ['Name', 'Status']);
    assert.equal(grid[1][0], 'Alice');        // inline string
    assert.equal(grid[1][1], '');             // B2 absent → hole filled
    assert.equal(grid[1][2], '42');           // number
    assert.equal(grid[1][3], 'TRUE');         // boolean
  });

  it('gridToRecords: first row = headers, blank rows skipped, empty header → colN', () => {
    const grid = [['Name', '', 'Age'], ['Alice', 'x', '30'], ['', '', ''], ['Bob', 'y', '25']];
    const recs = gridToRecords(grid);
    assert.equal(recs.length, 2);   // the all-empty row is dropped
    assert.deepEqual(recs[0], { Name: 'Alice', col2: 'x', Age: '30' });
    assert.deepEqual(recs[1], { Name: 'Bob', col2: 'y', Age: '25' });
  });

  it('firstSheetPath resolves the first sheet via workbook rels (attr order independent)', () => {
    const wb = `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Two" r:id="rId2"/></sheets></workbook>`;
    const rels = `<Relationships><Relationship Id="rId1" Type="…/worksheet" Target="worksheets/sheet1.xml"/><Relationship Target="worksheets/sheet2.xml" Id="rId2"/></Relationships>`;
    assert.equal(firstSheetPath(wb, rels), 'xl/worksheets/sheet1.xml');
  });
});

// ─── a real .xlsx byte buffer (deflate) → end-to-end through unzip + DecompressionStream ───
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function buildZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), raw = Buffer.from(e.data, 'utf8'), comp = zlib.deflateRawSync(raw);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0), u32(comp.length), u32(raw.length), u16(name.length), u16(0), name, comp]);
    locals.push(local);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0), u32(comp.length), u32(raw.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
  const buf = Buffer.concat([...locals, cd, eocd]);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);   // → ArrayBuffer
}

describe('xlsx — xlsxToRecords end-to-end (real zip, real inflate)', () => {
  const XLSX = () => buildZip([
    { name: 'xl/workbook.xml', data: `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: 'xl/sharedStrings.xml', data: `<sst><si><t>Name</t></si><si><t>Status</t></si><si><t>Age</t></si><si><t>Alice</t></si><si><t>open</t></si><si><t>Bob</t></si><si><t>closed</t></si></sst>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
        <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2"><v>30</v></c></row>
        <row r="3"><c r="A3" t="s"><v>5</v></c><c r="B3" t="s"><v>6</v></c><c r="C3"><v>25</v></c></row>
      </sheetData></worksheet>` },
  ]);

  it('parses a deflated .xlsx into row objects (headers + shared strings + numbers)', async () => {
    const recs = await xlsxToRecords(XLSX());
    assert.equal(recs.length, 2);
    assert.deepEqual(recs[0], { Name: 'Alice', Status: 'open', Age: '30' });
    assert.deepEqual(recs[1], { Name: 'Bob', Status: 'closed', Age: '25' });
  });
});
