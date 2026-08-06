// tools/glf/dashboard.test.cjs — v2.74.2046 (glf F6). Run: node tools/glf/dashboard.test.cjs
//
// Standalone (the npm harness covers Core/ + Services/, not tools/), same shape as tick.test.cjs.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { esc, fmtAge, ageOf, fileUrl, chipClass, ageClass, compressChain, chipLabel, sparklinePath, renderMd, renderHtml, model, AGE_SCRIPT } = require('./dashboard.cjs');

let pass = 0;
// Tally on EXIT — a fixed print line under-reported twice when tests were appended below it.
process.on('exit', () => console.log(`\n${pass} passed`));
const it = (name, fn) => { try { fn(); pass++; console.log(`ok  - ${name}`); } catch (e) { console.error(`FAIL - ${name}\n  ${e.message}`); process.exitCode = 1; } };

const M = (over = {}) => model({
  nowIso: '2026-08-06T15:00:00.000Z', host: 'TESTHOST', build: 'abc1234+deadbeef@2.74.2046',
  lease: { lane: 'lane-cron', ts: '2026-08-06T14:58:00.000Z' }, leaseSt: 'live',
  duty: { fired: 100, expected: 289, dutyPct: 34.6, gaps: [{ ts: 'x', gapMin: 50 }], lostMin: 50, maxGapMin: 50, windowMin: 1440 },
  board: {
    rows: [
      { id: 't-open', status: 'open', owner: 'lane-1', chain: ['UNMAPPED', 'PASS'], firstGradeH: 0.7, lastVerdict: 'PASS', lastGraded: '2026-08-06T14:00:00Z' },
      { id: 't-retired', status: 'retired', owner: 'lane-1', chain: ['PASS'], firstGradeH: 1, lastVerdict: 'PASS', lastGraded: '2026-08-05T14:00:00Z' },
    ],
    totals: { PASS: 2, UNMAPPED: 1 }, ungraded: [],
  },
  census: [{ id: 't-open', owner: 'lane-1', since: '2026-08-06T10:00:00Z', actions: ['reload the extension'] }],
  busDirtyN: 0,
  recent: [{ test: 't-open', verdict: 'PASS', graded: '2026-08-06T14:00:00Z', grader: 'lane-cron', selfGraded: false, note: 'ok' }],
  tickIntervals: [5, 5, 50, 5],
  ...over,
});

// ── escaping — the injection boundary of a rendered page ────────────────────────────────────────────────────
it('esc neutralizes html metacharacters', () => {
  assert.equal(esc('<img src=x onerror=a>&"b"'), '&lt;img src=x onerror=a&gt;&amp;&quot;b&quot;');
});

it('renderHtml escapes bus-derived text everywhere it lands (claim/note/id are untrusted-ish strings)', () => {
  const m = M({ recent: [{ test: '<script>x</script>', verdict: 'PASS', graded: 'g', grader: '<b>', selfGraded: false, note: '<svg onload=1>' }] });
  const html = renderHtml(m);
  assert.ok(!html.includes('<script>x</script>'), 'raw test id must not reach the page');
  assert.ok(!html.includes('<svg onload=1>'), 'raw note must not reach the page');
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'), 'escaped form present');
});

// ── fmtAge / chips / sparkline ──────────────────────────────────────────────────────────────────────────────
it('fmtAge: minutes, hours+minutes, days+hours; garbage → ?', () => {
  assert.equal(fmtAge(2 * 60000), '2m');
  assert.equal(fmtAge(3 * 3600000 + 5 * 60000), '3h5m');
  assert.equal(fmtAge(28 * 3600000), '1d4h');
  assert.equal(fmtAge(NaN), '?');
  assert.equal(fmtAge(-5), '?');
});

it('chipClass maps the closed verdict vocabulary and defaults unknown to other', () => {
  for (const v of ['PASS', 'FAIL', 'INCONCLUSIVE', 'UNMAPPED', 'ORPHANED']) assert.equal(chipClass(v), v.toLowerCase());
  assert.equal(chipClass('WEIRD'), 'other');
  assert.equal(chipClass(null), 'other');
});

it('sparklinePath: caps monster gaps so the normal cadence stays visible; empty → empty', () => {
  const p = sparklinePath([5, 500], 220, 36, 60);
  assert.match(p, /^M0\.0,33\.0 L220\.0,0\.0$/, '500 caps to 60 (top of viewbox), 5 sits near the bottom');
  assert.equal(sparklinePath([]), '');
});

// ── renderers — the load-bearing content is present in both surfaces ────────────────────────────────────────
it('renderMd carries the liveness-signal framing, lease, census checklist, and the scoreboard', () => {
  const md = renderMd(M());
  assert.match(md, /as of 2026-08-06T15:00:00\.000Z/);
  assert.match(md, /age is the liveness signal/);
  assert.match(md, /live — lane-cron/);
  assert.match(md, /- \[ \] reload the extension/, 'census renders as a checklist');
  assert.match(md, /\| \*\*\[t-open\]\(\.\.\/tests\/t-open\.md\)\*\* \| lane-1 \| UNMAPPED → PASS \|/, 'open tests bolded AND linked (GitHub-relative) in the table');
  assert.match(md, /waiting \*\*5h\*\*/, 'ages, not raw ISO, lead the census (5h from the fixture nowIso)');
  assert.match(md, /34\.6%/);
});

it('renderMd says so plainly when nothing waits on a human and flags an undelivered bus', () => {
  const md = renderMd(M({ census: [], busDirtyN: 3 }));
  assert.match(md, /owes you no steps/);
  assert.match(md, /3 UNDELIVERED/);
});

it('renderHtml escapes the scoreboard STATUS attribute — the front-matter field the first verify pass missed', () => {
  // status: comes verbatim from a bus test file's front matter; unescaped it broke out of the class attribute.
  const m = M({ board: { rows: [{ id: 't', status: 'open"><img src=x onerror=alert(1)>', owner: '<b>o</b>', chain: [], firstGradeH: null, lastVerdict: null, lastGraded: null }], totals: {}, ungraded: ['t'] } });
  const html = renderHtml(m);
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'raw status must not reach the page');
  assert.ok(!html.includes('<b>o</b>'), 'raw owner must not reach the page');
  assert.ok(html.includes('open&quot;&gt;'), 'escaped status present in the attribute');
});

it('renderHtml: open rows before retired, chips per verdict, lease going non-live turns the pill bad', () => {
  const html = renderHtml(M({ leaseSt: 'expired' }));
  assert.ok(html.indexOf('t-open') < html.indexOf('t-retired'), 'open sorts first');
  assert.match(html, /class="chip unmapped"/);
  assert.match(html, /class="pill bad">LEASE expired/);
  assert.match(html, /http-equiv="refresh"/, 'the tab keeps itself current');
});

it('a >100% duty renders its multiple-sessions caveat AND suppresses the sparkline (an interleaved-lane series is a healthy-looking lie)', () => {
  const html = renderHtml(M({ duty: { fired: 300, expected: 289, dutyPct: 103.8, gaps: [], lostMin: 0, maxGapMin: 0, windowMin: 1440 } }));
  assert.match(html, /multiple ticking sessions/);
  assert.ok(!html.includes('<svg'), 'sparkline suppressed under multi-session duty');
  assert.match(html, /sparkline suppressed/);
});

// ── the death signal + CSP (review fixes #1 and #6) ─────────────────────────────────────────────────────────
it('the page can announce its own death: data-asof + the age script + the stale style are all present', () => {
  const html = renderHtml(M());
  assert.match(html, /<body data-asof="2026-08-06T15:00:00\.000Z">/);
  assert.ok(html.includes(`<script>${AGE_SCRIPT}</script>`), 'the static age script is embedded verbatim');
  assert.match(html, /\.strip\.stale/, 'the stale style exists for the script to toggle');
});

it('the CSP pins exactly the embedded script by hash — an injected script cannot match it', () => {
  const html = renderHtml(M());
  const meta = /script-src 'sha256-([^']+)'/.exec(html);
  assert.ok(meta, 'CSP meta present with a script hash');
  assert.equal(meta[1], crypto.createHash('sha256').update(AGE_SCRIPT).digest('base64'), 'hash matches the embedded script');
  assert.match(html, /default-src 'none'/);
});

it('ages replace raw ISO in the html (lease pill age, census waiting age); ISO+owner survive as title hover', () => {
  const html = renderHtml(M());
  assert.match(html, /class="pill ok">LEASE live · lane-cron · 2m</);
  assert.match(html, /waiting <b class="age-fresh" title="2026-08-06T10:00:00Z · owner lane-1">5h<\/b>/);
  assert.ok(!/\(lane-1\)/.test(html.split('Scoreboard')[0]), 'owner lane demoted out of the visible census');
});

// ── F6b — the polish pass ───────────────────────────────────────────────────────────────────────────────────
it('ageClass ramps: fresh <6h · ok <24h · warn <72h · late beyond; garbage → ok', () => {
  const H = 3600000;
  assert.equal(ageClass(2 * H), 'age-fresh');
  assert.equal(ageClass(12 * H), 'age-ok');
  assert.equal(ageClass(48 * H), 'age-warn');
  assert.equal(ageClass(100 * H), 'age-late');
  assert.equal(ageClass(NaN), 'age-ok');
});

it('compressChain run-length encodes; chipLabel abbreviates the long verdicts only', () => {
  assert.deepEqual(compressChain(['INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE', 'PASS']), [{ v: 'INCONCLUSIVE', n: 3 }, { v: 'PASS', n: 1 }]);
  assert.deepEqual(compressChain([]), []);
  assert.equal(chipLabel('INCONCLUSIVE'), 'INC');
  assert.equal(chipLabel('UNMAPPED'), 'UNM');
  assert.equal(chipLabel('PASS'), 'PASS');
});

it('a repeated-verdict chain renders ONE chip with ×n; the full verdict survives in the title', () => {
  const m = M({ board: { rows: [{ id: 't', status: 'open', owner: 'l', chain: ['INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE'], firstGradeH: 1, lastVerdict: 'INCONCLUSIVE', lastGraded: '2026-08-06T14:00:00Z' }], totals: {}, ungraded: [] } });
  const html = renderHtml(m);
  assert.match(html, /title="INCONCLUSIVE ×3">INC ×3</);
  assert.equal((html.match(/chip inconclusive/g) || []).length, 1, 'one chip, not three');
});

it('retired rows collapse behind <details>; open rows stay in the main table', () => {
  const html = renderHtml(M());
  assert.match(html, /<details><summary class="dim">1 retired<\/summary>/);
  assert.ok(html.indexOf('t-retired') > html.indexOf('<details>'), 'retired row lives inside the details block');
  assert.ok(html.indexOf('t-open') < html.indexOf('<details>'), 'open row precedes the details block');
});

it('census checklist carries the todo affordance; links are visibly links (dotted underline rule present)', () => {
  const html = renderHtml(M());
  assert.match(html, /<ul class="todo">/);
  assert.match(html, /ul\.todo li::before\{content:"☐ "/);
  assert.match(html, /text-decoration:underline dotted/);
});

it('a BLOCKED census row shows the stale pill + note and suppresses its unactionable checklist', () => {
  const html = renderHtml(M({ census: [{ id: 't-open', owner: 'lane-1', since: '2026-08-06T10:00:00Z', actions: ['do the thing'], note: 'open history for VALUE', state: 'STALE', onYou: false }] }));
  assert.match(html, /class="pill warn">⏸ blocked: STALE — owner lane-1 must rearm; not on you/);
  assert.match(html, /last grade: open history for VALUE/);
  assert.ok(!html.includes('do the thing'), 'a checklist nothing can advance is not re-nagged');
});

it('an ON-YOU census row keeps its checklist and carries the latest grade note', () => {
  const html = renderHtml(M({ census: [{ id: 't-open', owner: 'lane-1', since: '2026-08-06T10:00:00Z', actions: ['do the thing'], note: 'seed landed; run still owed', state: 'LIVE*', onYou: true }] }));
  assert.match(html, /class="pill ok">on you/);
  assert.match(html, /last grade: seed landed; run still owed/);
  assert.match(html, /do the thing/);
});

it('an empty census checklist gets the see-the-test-file fallback, never a bare empty list', () => {
  const html = renderHtml(M({ census: [{ id: 't-open', owner: 'lane-1', since: '2026-08-06T10:00:00Z', actions: [] }] }));
  assert.match(html, /no \[human\] lines parsed/);
  assert.ok(!html.includes('<ul></ul>'), 'no empty checklist');
});

it('fileUrl builds an escaped file:// link only when a bus root is known', () => {
  assert.equal(fileUrl(null, 'tests/x.md'), null);
  const u = fileUrl('C:\\Users\\x\\orchard-logs', 'tests/a b.md');
  assert.match(u, /^file:\/\/\/C:\/Users\/x\/orchard-logs\/tests\/a%20b\.md$/);
  const html = renderHtml(M({ busRootPath: 'C:\\bus' }));
  assert.match(html, /<a href="file:\/\/\/C:\/bus\/tests\/t-open\.md">t-open<\/a>/, 'test ids link for drill-down');
});
