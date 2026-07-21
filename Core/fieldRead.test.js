// Core/fieldRead.test.js — PM-9 (v2.74.1649): per-item field read, term-matched not format-parsed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readFieldSection, splitSentences, normalizeFieldReadVerdict, fieldReadTally } from './fieldRead.js';

// Shaped after the real VendorSuite `Instructions` (HAR-verified): a date header, a numbered item with a
// label ending in a colon, a lettered sub-item. Tabs are real in the source.
const OUTLINE = [
  '1 unit 2 story / 4 bed / 2500 sf / lot 12 THs blk 03 / WEDNESDAY, JULY 22nd 8AM-12PM',
  '4.\tDeako switches:',
  'a.\thomeowner reports two switches not pairing in the main hall.',
  '',
].join('\n');

const PROSE = 'Vendor to inspect drywall crack in garage. Deako rep should verify the switch firmware before the visit. Confirm access with homeowner.';

describe('fieldRead — readFieldSection: the term finds its unit, whatever the shape', () => {
  it('numbered item: returns the item AND its lettered sub-item (the detail lives there)', () => {
    const r = readFieldSection(OUTLINE, 'deako');
    assert.equal(r.found, true);
    assert.equal(r.mode, 'item');
    assert.match(r.text, /Deako switches:/);
    assert.match(r.text, /not pairing in the main hall/);
    assert.equal(r.text.includes('lot 12 THs'), false);   // the unrelated header stays out
  });

  it('mid-sentence: the same term in flowing prose returns just that sentence', () => {
    // The user was explicit: "sometimes a number item and sometimes appears in a sentence". One predicate, both.
    const r = readFieldSection(PROSE, 'deako');
    assert.equal(r.found, true);
    assert.equal(r.mode, 'sentence');
    assert.match(r.text, /verify the switch firmware/);
    assert.equal(r.text.includes('drywall crack'), false);
  });

  it('case-insensitive', () => {
    assert.equal(readFieldSection(OUTLINE, 'DEAKO').found, true);
    assert.equal(readFieldSection(PROSE, 'Deako').found, true);
  });

  it('a MISS returns the whole field and says so — never an empty targeted answer', () => {
    const r = readFieldSection(OUTLINE, 'plumbing');
    assert.equal(r.found, false);
    assert.equal(r.mode, 'whole');
    assert.equal(r.text.includes('Deako switches'), true);   // everything, so the user can still read it
  });

  it('no term at all → the whole field, found', () => {
    const r = readFieldSection(PROSE, '');
    assert.equal(r.mode, 'whole');
    assert.equal(r.found, true);
    assert.equal(r.text, PROSE);
  });

  it('empty/blank field is reported as empty, not as a whole-field answer', () => {
    for (const v of ['', '   ', null, undefined]) {
      const r = readFieldSection(v, 'deako');
      assert.equal(r.mode, 'empty');
      assert.equal(r.found, false);
    }
  });

  it('a numbered item stops at the NEXT numbered item', () => {
    const t = ['1.\tDeako:', 'a.\tfirst detail', '2.\tPaint:', 'b.\tunrelated'].join('\n');
    const r = readFieldSection(t, 'deako');
    assert.match(r.text, /first detail/);
    assert.equal(r.text.includes('Paint'), false);
    assert.equal(r.text.includes('unrelated'), false);
  });

  it('multiple hits all come back, counted', () => {
    const t = ['1.\tDeako switch A', '2.\tOther', '3.\tDeako switch B'].join('\n');
    const r = readFieldSection(t, 'deako');
    assert.equal(r.hits, 2);
    assert.match(r.text, /switch A/);
    assert.match(r.text, /switch B/);
    assert.equal(r.text.includes('Other'), false);
  });

  it('CRLF is normalized (the field arrives from a web API)', () => {
    const r = readFieldSection('1.\tDeako:\r\na.\tdetail here', 'deako');
    assert.match(r.text, /detail here/);
  });

  it('term inside ONE long line with no newlines falls through to sentence mode', () => {
    const r = readFieldSection('Do the thing. The Deako rep needs access. Then leave.', 'deako');
    assert.equal(r.mode, 'sentence');
    assert.match(r.text, /needs access/);
  });
});

describe('fieldRead — splitSentences', () => {
  it('splits on terminal punctuation followed by a capital', () => {
    assert.equal(splitSentences('One thing. Two things! Three?').length, 3);
  });
  it('empty in, empty out', () => {
    assert.deepEqual(splitSentences(''), []);
  });
});

describe('fieldRead — normalizeFieldReadVerdict (the shape that needed no target)', () => {
  it('field is the only required slot; term is optional', () => {
    assert.deepEqual(normalizeFieldReadVerdict({ field: 'Task instructions' }),
      { kind: 'fieldRead', collection: 'prior', field: 'Task instructions', term: '' });
  });
  it('carries a term and a cap', () => {
    const v = normalizeFieldReadVerdict({ field: 'Instructions', term: 'DEAKO', cap: 10 });
    assert.equal(v.term, 'DEAKO');
    assert.equal(v.cap, 10);
  });
  it('a self-contained collection rides', () => {
    const v = normalizeFieldReadVerdict({ collection: { readAsk: 'get open warranty tasks' }, field: 'Instructions' });
    assert.deepEqual(v.collection, { readAsk: 'get open warranty tasks' });
  });
  it('NO field → not this shape (null, so the caller can try another)', () => {
    for (const v of [null, {}, { field: '  ' }, { term: 'DEAKO' }]) assert.equal(normalizeFieldReadVerdict(v), null);
  });
});

describe('fieldRead — fieldReadTally', () => {
  it('names the whole-field fallbacks separately from the real hits', () => {
    const s = fieldReadTally({ rows: 22, found: 18, whole: 3, missing: 1, field: 'Instructions', term: 'DEAKO' });
    assert.match(s, /22 rows/);
    assert.match(s, /18 with a .DEAKO. part/);
    assert.match(s, /3 showing the whole Instructions \(no match\)/);
    assert.match(s, /1 with no Instructions/);
  });
});
