// tools/glf/report.test.cjs — v2.74.2044 (glf F4). Run: node tools/glf/report.test.cjs
//
// Standalone (the npm harness covers Core/ + Services/, not tools/), same shape as tick.test.cjs.

const assert = require('node:assert/strict');
const { parseTicks, dutyCycle, scoreboard, humanActions, waitingHuman } = require('./report.cjs');

let pass = 0;
// Tally on EXIT — a fixed print line under-reported twice when tests were appended below it.
process.on('exit', () => console.log(`\n${pass} passed`));
const it = (name, fn) => { try { fn(); pass++; console.log(`ok  - ${name}`); } catch (e) { console.error(`FAIL - ${name}\n  ${e.message}`); process.exitCode = 1; } };

// ── parseTicks ───────────────────────────────────────────────────────────────────────────────────────────────
it('parses rows and skips torn lines rather than losing the ledger', () => {
  const rows = parseTicks('{"ts":"2026-08-06T10:00:00Z","gapMin":null}\n{TORN\n{"ts":"2026-08-06T10:05:00Z","gapMin":5}\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].gapMin, 5);
});

// ── dutyCycle — the headline metric becomes computed, not commented ─────────────────────────────────────────
it('computes fired/expected/duty over the window and the >GAP_MIN gap census', () => {
  // 60 minutes, 5-min cadence → 13 expected boundaries; 4 fired, one recorded 45-min gap.
  const rows = [
    { ts: '2026-08-06T10:00:00Z', gapMin: null },
    { ts: '2026-08-06T10:05:00Z', gapMin: 5 },
    { ts: '2026-08-06T10:50:00Z', gapMin: 45 },
    { ts: '2026-08-06T10:55:00Z', gapMin: 5 },
  ];
  const d = dutyCycle(rows, '2026-08-06T11:00:00Z');
  assert.equal(d.fired, 4);
  assert.equal(d.expected, 13, '60min / 5min + 1 boundary');
  assert.equal(d.dutyPct, 30.8);
  assert.equal(d.gaps.length, 1, 'only the 45-min gap exceeds GAP_MIN=15; 5-min jitter is not news');
  assert.equal(d.lostMin, 45);
  assert.equal(d.maxGapMin, 45);
});

it('audited-shape regression: sparse firing reads as a low duty cycle, never as quiet health', () => {
  // The 2026-08-03 audit class: expected≈3x fired. 2h window, 8 fired ⇒ 25-ish%.
  const rows = Array.from({ length: 8 }, (_, i) => ({ ts: `2026-08-06T1${Math.floor(i / 4)}:${String((i % 4) * 15).padStart(2, '0')}:00Z`, gapMin: i ? 15 : null }));
  const d = dutyCycle(rows, '2026-08-06T12:00:00Z');
  assert.ok(d.expected > d.fired * 2, `expected ${d.expected} should dwarf fired ${d.fired}`);
  assert.ok(d.dutyPct < 40, `duty ${d.dutyPct}% must read as a problem`);
});

it('empty ledger → duty null, zero gaps — a first tick cannot fabricate a history', () => {
  const d = dutyCycle([], '2026-08-06T11:00:00Z');
  assert.equal(d.fired, 0);
  assert.equal(d.dutyPct, null);
  assert.deepEqual(d.gaps, []);
});

it('--since filters the window: old gaps do not haunt the current cycle', () => {
  const rows = [
    { ts: '2026-08-05T10:00:00Z', gapMin: 450 },   // yesterday's monster gap
    { ts: '2026-08-06T10:00:00Z', gapMin: 5 },
    { ts: '2026-08-06T10:05:00Z', gapMin: 5 },
  ];
  const d = dutyCycle(rows, '2026-08-06T10:10:00Z', { sinceIso: '2026-08-06T00:00:00Z' });
  assert.equal(d.fired, 2);
  assert.equal(d.gaps.length, 0, 'the 450-min gap is outside the window');
});

// ── scoreboard ──────────────────────────────────────────────────────────────────────────────────────────────
const T = (id, status, owner, created) => ({ meta: { id, status, owner, created }, body: '' });
const R = (test, verdict, graded) => ({ meta: { test, verdict, graded }, body: '' });

it('chains verdicts in graded order per test and totals across all results', () => {
  const tests = [T('a', 'open', 'lane-1', '2026-08-05T12:00:00Z'), T('b', 'retired', 'lane-2', '2026-08-05T12:00:00Z')];
  const results = [R('a', 'PASS', '2026-08-06T02:00:00Z'), R('a', 'UNMAPPED', '2026-08-05T13:00:00Z'), R('b', 'PASS', '2026-08-05T14:00:00Z')];
  const s = scoreboard(tests, results);
  assert.deepEqual(s.rows[0].chain, ['UNMAPPED', 'PASS'], 'sorted by graded, not input order');
  assert.equal(s.rows[0].firstGradeH, 1, 'created 12:00 → first grade 13:00');
  assert.deepEqual(s.totals, { PASS: 2, UNMAPPED: 1 });
  assert.deepEqual(s.ungraded, [], 'both tests have grades');
});

it('a missing created: yields firstGradeH null — never a fake "0h after write"', () => {
  const s = scoreboard([{ meta: { id: 'nocreated', status: 'open', owner: 'l' }, body: '' }], [R('nocreated', 'PASS', '2026-08-06T13:00:00Z')]);
  assert.equal(s.rows[0].firstGradeH, null, 'no created timestamp → no time-to-grade claim');
});

it('an open test with no grades lands in ungraded — the rot the queue-footnote prose used to track', () => {
  const s = scoreboard([T('lonely', 'open', 'lane-1', '2026-08-05T12:00:00Z')], []);
  assert.deepEqual(s.ungraded, ['lonely']);
  assert.equal(s.rows[0].lastVerdict, null);
});

// ── humanActions / waitingHuman — the census that turns QUIET ticks into a to-do list ───────────────────────
it('extracts [human] steps only, case-insensitive, - or * bullets', () => {
  const body = 'ACTION:\n  - [auto] exercise the ask\n  - [human] reload the extension\n  * [HUMAN] make a field ask on the case\nPREDICT:\n  MECH = grep: `X`\n';
  assert.deepEqual(humanActions(body), ['reload the extension', 'make a field ask on the case']);
});

it('a step wrapped across lines keeps its continuation — the census served half-instructions live', () => {
  const body = 'ACTION:\n  - [human] Open its Run history. Expect outcomes (matched / no-match /\n    failed) named on the newest row.\n  - [human] second step\nPREDICT:\n  MECH = grep: `X`\n';
  assert.deepEqual(humanActions(body), [
    'Open its Run history. Expect outcomes (matched / no-match / failed) named on the newest row.',
    'second step',
  ]);
});

it('continuation stops at a blank line, a new bullet, or a dedented section head', () => {
  const body = '  - [human] step one\n    still step one\n\n    orphaned indent after blank\n  - [auto] not ours\nPREDICT:\n';
  assert.deepEqual(humanActions(body), ['step one still step one']);
});

it('census = open tests whose LATEST grade is INCONCLUSIVE and marked waiting-human', () => {
  const tests = [
    { meta: { id: 'wh', status: 'open', owner: 'lane-1' }, body: 'ACTION:\n  - [human] send the ask\n' },
    { meta: { id: 'inc-only', status: 'open', owner: 'lane-1' }, body: '' },
    { meta: { id: 'closed', status: 'retired', owner: 'lane-1' }, body: '- [human] x\n' },
    { meta: { id: 'recovered', status: 'open', owner: 'lane-1' }, body: '- [human] y\n' },
  ];
  const results = [
    { meta: { test: 'wh', verdict: 'INCONCLUSIVE', graded: '2026-08-06T10:00:00Z' }, body: 'disposition: waiting-human — no qualifying ask yet' },
    { meta: { test: 'inc-only', verdict: 'INCONCLUSIVE', graded: '2026-08-06T10:00:00Z' }, body: 'confounder: build was stale' },   // INCONCLUSIVE but NOT waiting-human
    { meta: { test: 'closed', verdict: 'INCONCLUSIVE', graded: '2026-08-06T10:00:00Z' }, body: 'waiting-human' },                    // retired → excluded
    { meta: { test: 'recovered', verdict: 'INCONCLUSIVE', graded: '2026-08-06T09:00:00Z' }, body: 'waiting-human' },
    { meta: { test: 'recovered', verdict: 'PASS', graded: '2026-08-06T11:00:00Z' }, body: '' },                                      // LATEST is PASS → excluded
  ];
  const rows = waitingHuman(tests, results);
  assert.deepEqual(rows.map((r) => r.id), ['wh'], 'only the genuinely-waiting test');
  assert.deepEqual(rows[0].actions, ['send the ask']);
});

it('census rows sort oldest-first — the longest-starved ask leads', () => {
  const tests = [
    { meta: { id: 'old', status: 'open', owner: 'l' }, body: '- [human] a\n' },
    { meta: { id: 'new', status: 'open', owner: 'l' }, body: '- [human] b\n' },
  ];
  const results = [
    { meta: { test: 'new', verdict: 'INCONCLUSIVE', graded: '2026-08-06T11:00:00Z' }, body: 'waiting-human' },
    { meta: { test: 'old', verdict: 'INCONCLUSIVE', graded: '2026-08-05T09:00:00Z' }, body: 'waiting-human' },
  ];
  assert.deepEqual(waitingHuman(tests, results).map((r) => r.id), ['old', 'new']);
});
