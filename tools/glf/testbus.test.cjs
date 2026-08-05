// tools/glf/testbus.test.cjs â€” v2.74.2014 / inbox v2.74.2017. Run: node tools/glf/testbus.test.cjs
//
// Standalone (the npm harness covers Core/ + Services/, not tools/), same shape as tick.test.cjs.

const assert = require('node:assert/strict');
const {
  parseDoc, formatDoc, leaseState, isOrphan, resultFileName,
  ackedSet, inboxRows, ackRow, NEXT_BY_VERDICT, filesFingerprint,
  LEASE_TTL_MIN, ORPHAN_H,
} = require('./testbus.cjs');

let pass = 0;
// Tally on EXIT â€” a fixed print line under-reported twice when tests were appended below it.
process.on('exit', () => console.log(`\n${pass} passed`));
const it = (name, fn) => { try { fn(); pass++; console.log(`ok  - ${name}`); } catch (e) { console.error(`FAIL - ${name}\n  ${e.message}`); process.exitCode = 1; } };

// â”€â”€ parseDoc / formatDoc â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
it('a doc survives a formatâ†’parse round trip â€” the file IS the record, so lossy IO corrupts the ledger', () => {
  const meta = { id: 'v2.74.2013-auto-create-lands', claim: 'a create the gate cleared as auto CREATES', status: 'open', owner: 'lane-a1b2', build: '7e718a1+abcd1234@2.74.2013', files: 'chat.js', created: '2026-08-05T13:00:00.000Z' };
  const body = 'ACTION:\n  - [human] reload\n\nPREDICT:\n  MECH = grep: `WRITE â–¸ start misses=`\n';
  const back = parseDoc(formatDoc(meta, body));
  assert.deepEqual(back.meta, meta);
  assert.equal(back.body.trim(), body.trim());
});

it('a body containing a --- rule does not truncate the doc â€” arms quote findings prose that uses them', () => {
  const back = parseDoc(formatDoc({ id: 't' }, 'above\n---\nbelow'));
  assert.equal(back.meta.id, 't');
  assert.match(back.body, /below/);
});

it('a CRLF file still parses â€” git autocrlf rewrites the working copy at rebase, caught on the first live result', () => {
  const meta = { id: 't1', owner: 'lane-8289', build: 'abc1234+clean@2.74.2014' };
  const crlf = formatDoc(meta, 'PREDICT:\n  MECH = x').replace(/\n/g, '\r\n');
  const back = parseDoc(crlf);
  assert.equal(back.meta.owner, 'lane-8289');
  assert.equal(back.meta.build, 'abc1234+clean@2.74.2014');
});

it('a file with no front matter is all body, not an exception â€” a hand-dropped note must not kill list', () => {
  const back = parseDoc('just some prose');
  assert.deepEqual(back.meta, {});
  assert.equal(back.body, 'just some prose');
});

it('empty meta values are dropped on format rather than serialised as dangling keys', () => {
  const text = formatDoc({ id: 't', note: '', verdict: undefined }, 'x');
  assert.doesNotMatch(text, /note:/);
  assert.doesNotMatch(text, /verdict:/);
});

// â”€â”€ leaseState â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
it('no lease file means free â€” the first grader ever must be able to claim', () => {
  assert.equal(leaseState('2026-08-05T13:00:00Z', null), 'free');
  assert.equal(leaseState('2026-08-05T13:00:00Z', {}), 'free');
});

it('a lease renewed within the TTL is live â€” a second "run glf grader" session must be refused', () => {
  assert.equal(leaseState('2026-08-05T13:05:00Z', { lane: 'lane-a1b2', ts: '2026-08-05T13:00:00Z' }), 'live');
});

it('a lease older than the TTL is expired â€” the overnight-death case must be recoverable without a human', () => {
  const ts = '2026-08-05T13:00:00Z';
  const later = new Date(Date.parse(ts) + (LEASE_TTL_MIN + 1) * 60000).toISOString();
  assert.equal(leaseState(later, { lane: 'lane-a1b2', ts }), 'expired');
});

it('exactly-at-TTL is still live â€” three missed ticks is the boundary, not two point nine', () => {
  const ts = '2026-08-05T13:00:00Z';
  const atTtl = new Date(Date.parse(ts) + LEASE_TTL_MIN * 60000).toISOString();
  assert.equal(leaseState(atTtl, { lane: 'lane-a1b2', ts }), 'live');
});

it('a torn lease (unparseable ts) reads free rather than wedging the loop forever', () => {
  assert.equal(leaseState('2026-08-05T13:00:00Z', { lane: 'lane-a1b2', ts: 'garbage' }), 'free');
});

// â”€â”€ isOrphan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const NOW = Date.parse('2026-08-05T13:00:00Z');
const H = 3600000;

it('a live-build test is never an orphan, however old â€” waiting for a human action is not abandonment', () => {
  assert.equal(isOrphan({ status: 'open', build: 'fp1' }, NOW - 100 * H, NOW, 'fp1'), false);
});

it('stale build + owner silence past the window IS an orphan â€” the frozen-blocks failure, detected this time', () => {
  assert.equal(isOrphan({ status: 'open', build: 'old' }, NOW - (ORPHAN_H + 1) * H, NOW, 'fp1'), true);
});

it('stale build but recently touched is NOT an orphan â€” the owner just has not re-armed yet', () => {
  assert.equal(isOrphan({ status: 'open', build: 'old' }, NOW - 1 * H, NOW, 'fp1'), false);
});

it('a retired test is never an orphan â€” retirement already answered it', () => {
  assert.equal(isOrphan({ status: 'retired', build: 'old' }, NOW - 100 * H, NOW, 'fp1'), false);
});

it('files-live counts as gradeable: stale tree + untouched claimed files is WAITING, not an orphan (v2.74.2022)', () => {
  assert.equal(isOrphan({ status: 'open', build: 'old' }, NOW - (ORPHAN_H + 1) * H, NOW, 'fp1', ORPHAN_H, true), false);
  assert.equal(isOrphan({ status: 'open', build: 'old' }, NOW - (ORPHAN_H + 1) * H, NOW, 'fp1', ORPHAN_H, false), true);
});

// â”€â”€ filesFingerprint (v2.74.2022 â€” staleness scoped to the claimed files) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
it('the files fingerprint is order-independent â€” the owner\'s files list is a SET, not a sequence', () => {
  const a = filesFingerprint([{ path: 'a.js', text: 'A' }, { path: 'b.js', text: 'B' }]);
  const b = filesFingerprint([{ path: 'b.js', text: 'B' }, { path: 'a.js', text: 'A' }]);
  assert.equal(a, b);
});

it('changing any claimed file\'s content changes the fingerprint â€” that is what STALE now means', () => {
  const before = filesFingerprint([{ path: 'a.js', text: 'A' }, { path: 'chat.js', text: 'v1' }]);
  const after = filesFingerprint([{ path: 'a.js', text: 'A' }, { path: 'chat.js', text: 'v2' }]);
  assert.notEqual(before, after);
});

it('a MISSING file is its own state â€” distinct from empty, so a typo\'d path or a deletion never reads clean', () => {
  const missing = filesFingerprint([{ path: 'a.js', text: null }]);
  const empty = filesFingerprint([{ path: 'a.js', text: '' }]);
  assert.notEqual(missing, empty);
});

it('the unrelated-lane-edit case: a fingerprint over MY files ignores every file not in the list', () => {
  // the live deadlock this closes: the tree hash moved 2016â†’2020 on the OTHER lane's writeMap work while both
  // of this test's files were byte-identical â€” under files-scoping the same edit leaves the fingerprint fixed.
  const mine = [{ path: 'Core/priorSelect.js', text: 'P' }, { path: 'chat.js', text: 'C' }];
  assert.equal(filesFingerprint(mine), filesFingerprint(mine.map((e) => ({ ...e }))));
});

// â”€â”€ resultFileName â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
it('the filename alone carries test, time and verdict â€” the builder can read the channel from a directory list', () => {
  assert.equal(resultFileName('v2.74.2013-auto-create-lands', '2026-08-05T13:05:22.123Z', 'PASS'),
    'v2.74.2013-auto-create-lands--20260805T1305Z--PASS.md');
});

it('two attempts in different minutes never collide â€” append-only means disagreement is preserved as data', () => {
  const a = resultFileName('t', '2026-08-05T13:05:00Z', 'PASS');
  const b = resultFileName('t', '2026-08-05T13:10:00Z', 'FAIL');
  assert.notEqual(a, b);
});

// â”€â”€ ackedSet / inboxRows / ackRow (v2.74.2017 builder inbox) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
it('ackedSet collects only this lane\'s basenames â€” another lane\'s ack must not hide my inbox', () => {
  const ledger = [
    JSON.stringify({ lane: 'lane-a', result: 't1--20260805T1300Z--PASS.md' }),
    JSON.stringify({ lane: 'lane-b', result: 't2--20260805T1300Z--FAIL.md' }),
    JSON.stringify({ lane: 'lane-a', result: 't3--20260805T1305Z--UNMAPPED.md' }),
  ].join('\n') + '\n';
  const set = ackedSet(ledger, 'lane-a');
  assert.equal(set.has('t1--20260805T1300Z--PASS.md'), true);
  assert.equal(set.has('t3--20260805T1305Z--UNMAPPED.md'), true);
  assert.equal(set.has('t2--20260805T1300Z--FAIL.md'), false);
});

it('ackedSet skips a torn line rather than losing the rest of the ledger', () => {
  const ledger = 'not-json\n' + JSON.stringify({ lane: 'lane-a', result: 'ok.md' }) + '\n';
  assert.equal(ackedSet(ledger, 'lane-a').has('ok.md'), true);
});

it('inboxRows returns only unacked results for open tests this lane owns, oldest first', () => {
  const tests = [
    { meta: { id: 'mine-open', owner: 'lane-a', status: 'open' } },
    { meta: { id: 'mine-retired', owner: 'lane-a', status: 'retired' } },
    { meta: { id: 'theirs', owner: 'lane-b', status: 'open' } },
  ];
  const results = [
    { file: 'mine-open--20260805T1310Z--FAIL.md', meta: { test: 'mine-open', verdict: 'FAIL', graded: '2026-08-05T13:10:00Z', grader: 'lane-g' } },
    { file: 'mine-open--20260805T1300Z--UNMAPPED.md', meta: { test: 'mine-open', verdict: 'UNMAPPED', graded: '2026-08-05T13:00:00Z', grader: 'lane-g', note: 'first' } },
    { file: 'mine-retired--20260805T1300Z--PASS.md', meta: { test: 'mine-retired', verdict: 'PASS', graded: '2026-08-05T13:00:00Z', grader: 'lane-g' } },
    { file: 'theirs--20260805T1300Z--FAIL.md', meta: { test: 'theirs', verdict: 'FAIL', graded: '2026-08-05T13:00:00Z', grader: 'lane-g' } },
    { file: 'mine-open--20260805T1250Z--INCONCLUSIVE.md', meta: { test: 'mine-open', verdict: 'INCONCLUSIVE', graded: '2026-08-05T12:50:00Z', grader: 'lane-g' } },
  ];
  const acked = new Set(['mine-open--20260805T1250Z--INCONCLUSIVE.md']);
  const rows = inboxRows(tests, results, acked, 'lane-a');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].verdict, 'UNMAPPED');   // older first
  assert.equal(rows[1].verdict, 'FAIL');
  assert.equal(rows[0].next, NEXT_BY_VERDICT.UNMAPPED);
  assert.equal(rows[1].next, NEXT_BY_VERDICT.FAIL);
});

it('inboxRows is empty when everything is acked or foreign â€” the tick can STOP cleanly', () => {
  assert.deepEqual(inboxRows([], [], new Set(), 'lane-a'), []);
  assert.deepEqual(inboxRows(
    [{ meta: { id: 't', owner: 'lane-a', status: 'open' } }],
    [{ file: 't--x--PASS.md', meta: { test: 't', verdict: 'PASS', graded: '1' } }],
    new Set(['t--x--PASS.md']),
    'lane-a',
  ), []);
});

it('ackRow defaults disposition to seen and preserves the closed vocabulary fields', () => {
  const row = ackRow({
    ts: '2026-08-05T13:35:31.465Z', lane: 'lane-8289',
    result: 'v2.74.2013-auto-create-lands--20260805T1335Z--UNMAPPED.md',
    test: 'v2.74.2013-auto-create-lands', verdict: 'UNMAPPED',
  });
  assert.equal(row.disposition, 'seen');
  assert.equal(row.lane, 'lane-8289');
  assert.equal(row.verdict, 'UNMAPPED');
});
