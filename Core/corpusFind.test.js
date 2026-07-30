// Core/corpusFind.test.js — the synthetic find leg's pure half (v2.74.1875). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyQuery, matchRow, findInRows, filterRows, scanCells, estimateScan, findVerdict, partitionFields, isReferentialQuery, MEASURED_MS_PER_READ } from './corpusFind.js';

// The real VendorSuite row shape (structure from the drill's own `label` list; values fabricated).
const FIELDS = {
  idFields: ['TicketId', 'TaskNumber', 'TaskId', 'ClaimNumber', 'JobNumber'],
  textFields: ['AddressLine1', 'CityStateZip', 'ProjectName', 'SearchField'],
};
const ROW = { TicketId: '4867009', TaskNumber: '01', TaskId: '10835071', ClaimNumber: 'C-99120', JobNumber: '4412', AddressLine1: '1091 Misty Creek Drive', CityStateZip: 'ABERDEEN, NC 28315', ProjectName: 'Collinswood - Traditions' };
const OTHER = { TicketId: '48670091', TaskNumber: '02', TaskId: '10835072', ClaimNumber: 'C-99121', JobNumber: '4413', AddressLine1: '409 Citron Street', CityStateZip: 'SANFORD, NC 27332', ProjectName: 'Laurel Oaks' };

const DIVS = [{ value: 32, label: 'Raleigh' }, { value: 37, label: 'Charlotte North' }, { value: 83, label: 'Atlanta West' }];
const STATUSES = ['new', 'open', 'fixed', 'closed'];

describe('corpusFind — query classification', () => {
  it('reads a quoted number as an identifier, with or without the hash', () => {
    assert.equal(classifyQuery('4867009').kind, 'identifier');
    assert.equal(classifyQuery('#4867009').kind, 'identifier');
    assert.equal(classifyQuery('#4867009').value, '4867009');
    assert.equal(classifyQuery('TK-4867009').kind, 'identifier');
    assert.equal(classifyQuery('10835071').kind, 'identifier');
  });
  it('reads a word or a phrase as text', () => {
    for (const q of ['Misty Creek', 'misty', 'Collinswood - Traditions', '1091 Misty Creek Drive', 'Aberdeen'])
      assert.equal(classifyQuery(q).kind, 'text', q);
  });
  it('a short digit run is text, not an id — "01" must not be treated as a unique key', () => {
    assert.equal(classifyQuery('01').kind, 'text');
    assert.equal(classifyQuery('999').kind, 'text');
  });
});

describe('corpusFind — row matching', () => {
  it('an identifier matches an ID field EXACTLY and names the field it matched', () => {
    assert.equal(matchRow(ROW, '4867009', FIELDS), 'TicketId');
    assert.equal(matchRow(ROW, '10835071', FIELDS), 'TaskId');
    assert.equal(matchRow(ROW, 'C-99120', FIELDS), 'ClaimNumber');
  });
  it('THE PRECISION CASE: "4867009" must not match a row whose TicketId is 48670091', () => {
    // the pre-existing filterRowsByText joins every field into one haystack and substring-matches, so this row
    // WOULD have matched — a wrong answer for a unique-id lookup, not merely a loose one
    assert.equal(matchRow(OTHER, '4867009', FIELDS), null);
  });
  it('an identifier does NOT match digits sitting inside an address or a project name', () => {
    assert.equal(matchRow(ROW, '1091', FIELDS), null, '1091 is the street number, not an id');
    assert.equal(matchRow(ROW, '28315', FIELDS), null, 'a postcode is not an id field');
  });
  it('text substring-matches, and all tokens must land in ONE field', () => {
    assert.equal(matchRow(ROW, 'Misty Creek', FIELDS), 'AddressLine1');
    assert.equal(matchRow(ROW, 'aberdeen', FIELDS), 'CityStateZip');
    assert.equal(matchRow(ROW, 'Collinswood', FIELDS), 'ProjectName');
    // "misty" is in the address and "laurel" is in nobody's — a cross-field coincidence is not a match
    assert.equal(matchRow(ROW, 'Misty Laurel', FIELDS), null);
  });
  it('empty and junk input matches nothing rather than everything', () => {
    assert.equal(matchRow(ROW, '', FIELDS), null);
    assert.equal(matchRow(ROW, '   ', FIELDS), null);
    assert.equal(matchRow(null, '4867009', FIELDS), null);
  });
  it('findInRows returns every match, tagged with its field', () => {
    const hits = findInRows([ROW, OTHER], 'NC', FIELDS);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].matchedOn, 'CityStateZip');
    assert.equal(findInRows([ROW, OTHER], '4867009', FIELDS).length, 1);
  });
});

describe('corpusFind — field partition derived from the row, not declared', () => {
  // the drill's own `label` list, verbatim from the catalog — a mixed bag we must sort without a new recipe field
  const LABELS = ['AddressLine1', 'CityStateZip', 'TaskNumber', 'ClaimNumber', 'ProjectName', 'TicketId', 'TaskId', 'JobNumber', 'SearchField'];
  const { idFields, textFields } = partitionFields(ROW, LABELS);
  it('sorts the identifier-shaped values into idFields', () => {
    for (const f of ['ClaimNumber', 'TicketId', 'TaskId', 'JobNumber']) assert.ok(idFields.includes(f), f);
  });
  it('sorts the lettered values into textFields', () => {
    for (const f of ['AddressLine1', 'CityStateZip', 'ProjectName']) assert.ok(textFields.includes(f), f);
  });
  it('drops a short bare number from BOTH — too weak to key on, too numeric to substring-search', () => {
    assert.ok(!idFields.includes('TaskNumber'));
    assert.ok(!textFields.includes('TaskNumber'), 'TaskNumber "01" in textFields would match inside anything');
  });
  it('skips fields the row does not carry', () => {
    assert.ok(!idFields.includes('SearchField') && !textFields.includes('SearchField'));
  });
  it('the derived partition drives a correct end-to-end match', () => {
    assert.equal(matchRow(ROW, '4867009', { idFields, textFields }), 'TicketId');
    assert.equal(matchRow(OTHER, '4867009', { idFields, textFields }), null);
    assert.equal(matchRow(ROW, 'Misty Creek', { idFields, textFields }), 'AddressLine1');
  });
});

describe('corpusFind — the scan plan', () => {
  it('is DIVISION-OUTER: all of a division’s statuses before the next division', () => {
    const plan = scanCells({ divisions: DIVS, statuses: STATUSES });
    assert.equal(plan.length, 12);
    assert.deepEqual(plan.slice(0, 4).map((p) => p.status), STATUSES);
    assert.equal(plan[0].division.label, 'Raleigh');
    assert.equal(plan[4].division.label, 'Charlotte North');
  });
  it('an explicit division or status pins that axis — this is what keeps a named ask cheap', () => {
    assert.equal(scanCells({ divisions: DIVS, statuses: STATUSES, division: 37 }).length, 4);
    assert.equal(scanCells({ divisions: DIVS, statuses: STATUSES, division: 'Charlotte North' }).length, 4);
    assert.equal(scanCells({ divisions: DIVS, statuses: STATUSES, status: 'open' }).length, 3);
    assert.equal(scanCells({ divisions: DIVS, statuses: STATUSES, division: 37, status: 'open' }).length, 1);
  });
  it('an already-searched division goes LAST, not first — it is where we know it isn’t', () => {
    const plan = scanCells({ divisions: DIVS, statuses: ['new'], deprioritize: 83 });
    assert.deepEqual(plan.map((p) => p.division.value), [32, 37, 83]);
  });
  it('an unknown division pins to nothing rather than silently scanning everything', () => {
    assert.equal(scanCells({ divisions: DIVS, statuses: STATUSES, division: 'Narnia' }).length, 0);
  });
});

describe('corpusFind — cost, answerable before spending', () => {
  it('reports reads and wall-clock for the full plan', () => {
    const e = estimateScan(scanCells({ divisions: Array.from({ length: 121 }, (_, i) => ({ value: i, label: `d${i}` })), statuses: STATUSES }), { kind: 'identifier' });
    assert.equal(e.reads, 484);
    // v1878 — the constant is MEASURED (183ms, two sessions); the test reads it rather than restating it, so a
    // future recalibration cannot leave the assertion silently pinned to a stale number.
    assert.equal(e.worstMs, Math.round((484 * MEASURED_MS_PER_READ) / 8));   // ~11.1s at the measured rate
    assert.equal(e.expectedMs, Math.round(e.worstMs / 2));
  });
  it('a text scan has no expected-case shortcut, because it cannot stop early', () => {
    assert.equal(estimateScan(scanCells({ divisions: DIVS, statuses: STATUSES }), { kind: 'text' }).expectedMs, null);
  });
  it('an empty plan costs nothing', () => {
    assert.deepEqual(estimateScan([]), { reads: 0, worstMs: 0, expectedMs: null });
  });
});

describe('corpusFind — the verdict cannot outrun the search', () => {
  it('one match / many matches', () => {
    assert.equal(findVerdict({ matches: [1], planned: 4, scanned: 4 }).outcome, 'one');
    assert.equal(findVerdict({ matches: [1, 2], planned: 4, scanned: 4 }).outcome, 'many');
  });
  it('a COMPLETE clean scan with no match earns a definite negative', () => {
    // v1877 — `coverage` made explicit what this case always assumed: a definite negative needs the scanned axes
    // to PARTITION the corpus. Written before the distinction existed; the assertion is unchanged, its
    // precondition is now stated.
    const v = findVerdict({ matches: [], planned: 484, scanned: 484, failed: 0, coverage: 'partition' });
    assert.equal(v.outcome, 'none');
    assert.equal(v.complete, true);
  });
  it('ANY failed read downgrades the negative — the v1874 defect, now a type', () => {
    assert.equal(findVerdict({ matches: [], planned: 484, scanned: 484, failed: 1, coverage: 'partition' }).outcome, 'inconclusive');
  });
  it('an unfinished plan (aborted, capped) is inconclusive, never "not there"', () => {
    assert.equal(findVerdict({ matches: [], planned: 484, scanned: 200, failed: 0, coverage: 'partition' }).outcome, 'inconclusive');
  });
  it('a match still stands even if part of the scan failed — finding it is positive evidence', () => {
    assert.equal(findVerdict({ matches: [1], planned: 484, scanned: 300, failed: 12 }).outcome, 'one');
  });
});

describe('corpusFind — filterRows: the ONE matcher, and the live defect it closes', () => {
  const LABELS = ['AddressLine1', 'CityStateZip', 'TaskNumber', 'ClaimNumber', 'ProjectName', 'TicketId', 'TaskId', 'JobNumber'];
  it('THE v1875 LIVE DEFECT: "1091" (a street number) no longer opens the Misty Creek task', () => {
    // 17:46:52 — `RIDE_DRILL ▸ vs_warranty_tasks → vs_warranty_task (taskId=…) match "1091"`. The strict rule
    // existed in matchRow already; it never ran, because the drill filtered with filterRowsByText.
    assert.equal(filterRows([ROW, OTHER], '1091', LABELS).length, 0);
  });
  it('a real ticket number still resolves, and to exactly one row', () => {
    const hits = filterRows([ROW, OTHER], '4867009', LABELS);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].matchedOn, 'TicketId');
    assert.equal(hits[0].row.TaskId, '10835071');
  });
  it('single-field address recall is preserved and names its field', () => {
    const hits = filterRows([ROW, OTHER], 'Misty Creek', LABELS);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].matchedOn, 'AddressLine1');
  });
  it('CROSS-FIELD recall is preserved via the fallback tier — the "123 main st cumming" case', () => {
    // rideParamResolve.test.js pins this shape for the old matcher; dropping it would have traded one regression
    // for another. Tier 2 matches across fields and says so with '*'.
    const hits = filterRows([ROW, OTHER], 'Misty Creek Aberdeen', LABELS);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].matchedOn, '*');
  });
  it('the fallback never rescues an IDENTIFIER — that is the whole point', () => {
    assert.equal(filterRows([ROW], '28315', LABELS).length, 0, 'a postcode is not a task id');
    assert.equal(filterRows([ROW], '4412', LABELS)[0].matchedOn, 'JobNumber', 'but a real JobNumber is');
  });
  it('junk and empties yield nothing rather than everything', () => {
    assert.deepEqual(filterRows([ROW, OTHER], '  ', LABELS), []);
    assert.deepEqual(filterRows([], 'x', LABELS), []);
    assert.deepEqual(filterRows([ROW], 'zzz nowhere', LABELS), []);
  });
});

describe('corpusFind — coverage: the second way a verdict can outrun its search', () => {
  const full = { matches: [], planned: 484, scanned: 484, failed: 0 };
  it('a complete read over a PARTITION earns the definite negative', () => {
    assert.equal(findVerdict({ ...full, coverage: 'partition' }).outcome, 'none');
  });
  it('a complete read over a SELECTION does not — it read everything it planned and still knows nothing else', () => {
    const v = findVerdict({ ...full, coverage: 'selection' });
    assert.equal(v.outcome, 'inconclusive');
    assert.equal(v.reason, 'coverage');
  });
  it('DEFAULTS to selection, so forgetting to declare costs a weaker sentence and never a false one', () => {
    assert.equal(findVerdict(full).outcome, 'inconclusive');
    assert.equal(findVerdict(full).reason, 'coverage');
  });
  it('an incomplete read outranks coverage — "unread" is the more specific limit', () => {
    assert.equal(findVerdict({ ...full, failed: 1, coverage: 'partition' }).reason, 'unread');
    assert.equal(findVerdict({ ...full, scanned: 200, coverage: 'selection' }).reason, 'unread');
  });
  it('a MATCH is unaffected by coverage — finding it is positive evidence either way', () => {
    assert.equal(findVerdict({ matches: [1], planned: 484, scanned: 12, coverage: 'selection' }).outcome, 'one');
  });
});

describe('corpusFind — referential queries never become searches (v2.74.1879)', () => {
  it('catches the live one: the model bound taskId:"prior" and it cost 484 reads', () => {
    assert.equal(isReferentialQuery('prior'), true);
  });
  it('catches the rest of the family', () => {
    for (const q of ['this', 'that', 'it', 'the', 'this one', 'that one', 'previous', 'last', 'latest', 'current', 'same', 'the task', 'record', 'job', ' THAT '])
      assert.equal(isReferentialQuery(q), true, q);
  });
  it('does NOT catch a real identifier or a real place — the guard must not eat valid queries', () => {
    for (const q of ['4867009', '10835071', 'C-99120', 'Misty Creek', 'Aberdeen', 'Collinswood', '1091 Misty Creek Drive', 'Laurel Oaks', 'job 4867009', 'that street'])
      assert.equal(isReferentialQuery(q), false, q);
  });
  it('empty is referential — there is nothing to search for either way', () => {
    assert.equal(isReferentialQuery(''), true);
    assert.equal(isReferentialQuery(null), true);
  });
});
