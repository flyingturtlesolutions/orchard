// tools/glf/tick.test.cjs — v2.74.1981. Run: node tools/glf/tick.test.cjs
//
// Standalone (the npm harness covers Core/ + Services/, not tools/), same shape as tools/progress-digest.

const assert = require('node:assert/strict');
const { gapMinutes, fingerprint, contended } = require('./tick.cjs');
const { scrub, residual } = require('./scrub.cjs');

let pass = 0;
const it = (name, fn) => { try { fn(); pass++; console.log(`ok  - ${name}`); } catch (e) { console.error(`FAIL - ${name}\n  ${e.message}`); process.exitCode = 1; } };

// ── gapMinutes ──────────────────────────────────────────────────────────────────────────────────────────────
it('a first-ever tick reports null, NOT a gap of zero', () => {
  // The distinction matters: 0 would claim the loop just ran, which is the one thing an empty ledger cannot know.
  assert.equal(gapMinutes('2026-08-03T12:00:00Z', null), null);
  assert.equal(gapMinutes('2026-08-03T12:00:00Z', undefined), null);
});

it('measures the real gaps from the audited window', () => {
  // The two spans that made 292 ticks look idle when the loop was simply not running.
  assert.equal(gapMinutes('2026-08-03T04:02:00Z', '2026-08-02T22:48:00Z'), 314);
  assert.equal(gapMinutes('2026-08-03T12:13:00Z', '2026-08-03T04:43:00Z'), 450);
});

it('a normal 5-minute cadence is below the gap floor', () => {
  assert.equal(gapMinutes('2026-08-03T12:05:00Z', '2026-08-03T12:00:00Z'), 5);
});

it('never reports a negative gap when clocks disagree', () => {
  assert.equal(gapMinutes('2026-08-03T12:00:00Z', '2026-08-03T12:09:00Z'), 0);
});

it('returns null on an unparseable prior stamp rather than throwing on the hot path', () => {
  assert.equal(gapMinutes('2026-08-03T12:00:00Z', 'not-a-date'), null);
  assert.equal(gapMinutes('garbage', '2026-08-03T12:00:00Z'), null);
});

// ── fingerprint ─────────────────────────────────────────────────────────────────────────────────────────────
it('changes when the working diff changes, even though HEAD and manifest do not', () => {
  // The live failure: manifest said 1978 under the parallel lane while the fix under test was uncommitted.
  const a = fingerprint('f920cca1234', 'diff --git a/chat.js', '2.74.1978');
  const b = fingerprint('f920cca1234', 'diff --git a/chat.js\n+one more line', '2.74.1978');
  assert.notEqual(a, b, 'two different working trees must not share a build identity');
});

it('is stable for the same tree — a re-read must grade identically', () => {
  assert.equal(fingerprint('abc1234', 'x', '2.74.1'), fingerprint('abc1234', 'x', '2.74.1'));
});

it('marks a clean tree explicitly rather than hashing the empty string', () => {
  assert.match(fingerprint('abc1234def', '', '2.74.1980'), /^abc1234\+clean@2\.74\.1980$/);
});

it('distinguishes two builds that share a diff but not a HEAD', () => {
  assert.notEqual(fingerprint('aaaaaaa', 'd', '2.74.1'), fingerprint('bbbbbbb', 'd', '2.74.1'));
});

it('survives missing inputs without throwing', () => {
  assert.match(fingerprint(null, null, null), /^\?\+clean@\?$/);
});

// ── contended ───────────────────────────────────────────────────────────────────────────────────────────────
it('flags a dirty file the open block does not claim — the co-edit hazard', () => {
  // Live near-miss: the parallel lane committed chat.js while an unverified fix sat in it. `git add chat.js`
  // from either side would have landed the other's work.
  assert.deepEqual(contended(['chat.js', 'Core/sheetCase.js'], ['chat.js']), ['Core/sheetCase.js']);
});

it('is silent when every dirty file is claimed', () => {
  assert.deepEqual(contended(['chat.js', 'manifest.json'], ['manifest.json', 'chat.js']), []);
});

it('normalizes path separators so a Windows status does not read as foreign', () => {
  assert.deepEqual(contended(['Core\\peritemMap.js'], ['Core/peritemMap.js']), []);
});

it('treats an empty claim list as "everything is foreign"', () => {
  assert.deepEqual(contended(['a.js', 'b.js'], []), ['a.js', 'b.js']);
  assert.deepEqual(contended(['a.js'], null), ['a.js']);
});

// ── scrub ───────────────────────────────────────────────────────────────────────────────────────────────────
it('removes tracking, order, email and rostered names', () => {
  const src = 'FOCUS pinned "Brian Sweet" order DEAKO#71654 tracking 1Z27691W0311465887 mail a.b@example.com';
  const { text, counts } = scrub(src);
  assert.equal(counts.name, 1); assert.equal(counts.order, 1);
  assert.equal(counts.tracking, 1); assert.equal(counts.email, 1);
  for (const leak of ['Brian Sweet', 'DEAKO#71654', '1Z27691W0311465887', 'a.b@example.com']) {
    assert.ok(!text.includes(leak), `${leak} must not survive`);
  }
});

it('maps one value to one stable token, so "same record" and "5 different customers" still read', () => {
  const { text } = scrub('DEAKO#111 then DEAKO#111 then DEAKO#222');
  const toks = text.match(/\[order:[0-9a-f]{4}\]/g);
  assert.equal(toks.length, 3);
  assert.equal(toks[0], toks[1], 'the same order keeps one identity');
  assert.notEqual(toks[0], toks[2], 'a different order keeps a different one');
});

it('is idempotent — the journal is appended to and rescrubbed forever', () => {
  const once = scrub('customer Divine Monkam ordered DEAKO#71654').text;
  const twice = scrub(once);
  assert.equal(twice.text, once);
  // Keys, not the object: `counts`/`residual` are null-prototype maps and strict deep-equal compares prototypes.
  assert.deepEqual(Object.keys(twice.counts), [], 'a second pass finds nothing left to replace');
  assert.deepEqual(Object.keys(residual(once)), [], 'a scrubbed document has no residual');
});

it('leaves DIVISION and product names alone — they carry the reproducer vocabulary', () => {
  // v1979's lesson: an ask stated outside the ground's own vocabulary tests the wrong path.
  const src = 'for each open task in Raleigh · Atlanta West · Las Vegas · Zendesk Guide';
  assert.equal(scrub(src).text, src);
});

it('does not mangle the markers the loop greps for', () => {
  const src = 'MAP ▸ self-map ("shopify") → ENTITY read · VALIDATE[v2.74.1980] · INCIDENT[stage=route]';
  assert.equal(scrub(src).text, src);
});

// ── dirtyPaths — the porcelain parse (v2.74.1981) ───────────────────────────────────────────────────────────
const { dirtyPaths } = require('./tick.cjs');

it('keeps the first path intact when the leading status space was trimmed away', () => {
  // The live bug this tool found in itself on its first run: git() used .trim(), which strips porcelain's
  // leading space off line ONE only, shifting the columns and reporting `ore/decisionMarkers.js`.
  assert.deepEqual(dirtyPaths(' M Core/decisionMarkers.js\n M chat.js'), ['Core/decisionMarkers.js', 'chat.js']);
});

it('handles every porcelain status column shape', () => {
  assert.deepEqual(
    dirtyPaths('M  staged.js\n M unstaged.js\nMM both.js\n?? new.js\nA  added.js'),
    ['staged.js', 'unstaged.js', 'both.js', 'new.js', 'added.js'],
  );
});

it('takes the DESTINATION of a rename, not the arrow line', () => {
  assert.deepEqual(dirtyPaths('R  old/name.js -> new/name.js'), ['new/name.js']);
});

it('unquotes a path git quoted for spaces', () => {
  assert.deepEqual(dirtyPaths(' M "Core/has space.js"'), ['Core/has space.js']);
});

it('returns nothing for a clean tree', () => {
  assert.deepEqual(dirtyPaths(''), []);
  assert.deepEqual(dirtyPaths(null), []);
});

console.log(`
${pass} passed`);

// ── blocks — the open-assertion ledger (v2.74.1989) ─────────────────────────────────────────────────────────
const { parse: parseBlocks, cmpVer } = require('./blocks.cjs');

const DOC = [
  'VALIDATE[v2.74.1980 — a field ask asks instead of answering]:',
  '  BUILD        = abc1234+deadbeef@2.74.1981',
  '  PASS         = something',
  '',
  '## an entry',
  'VALIDATE[v2.74.1988 — the probe reports the keys]:',
  '  BUILD        = 48bfc2f+179b0d3d@2.74.1988',
  '',
  'RETIRED[v2.74.1988 — PASS — contact-shaped(13) settled it]',
].join('\n');

it('an ungraded block stays OPEN no matter how many newer blocks follow it', () => {
  // The whole defect: STEP 2 grepped for the LAST block, so v1980 became unreachable the moment v1988 was
  // written. Three fixes shipped unverified behind exactly this.
  const { open } = parseBlocks(DOC);
  assert.deepEqual(open.map((b) => b.version), ['2.74.1980']);
});

it('a RETIRED line removes a block from the open set — and only that block', () => {
  const { blocks, retired, open } = parseBlocks(DOC);
  assert.equal(blocks.length, 2);
  assert.equal(retired.get('2.74.1988').verdict, 'PASS');
  assert.ok(!open.some((b) => b.version === '2.74.1988'));
});

it('carries each block\'s BUILD so the tick can tell gradeable from stale', () => {
  assert.equal(parseBlocks(DOC).open[0].build, 'abc1234+deadbeef@2.74.1981');
});

it('a re-armed block keeps its LATEST wording, not its first', () => {
  const doc = 'VALIDATE[v2.74.1980 — first wording]:\n  BUILD = a@1\n\nVALIDATE[v2.74.1980 — re-armed wording]:\n  BUILD = b@2';
  const { open } = parseBlocks(doc);
  assert.equal(open.length, 1);
  assert.match(open[0].claim, /re-armed/);
});

it('orders by version numerically, not lexically — v1988 must not sort before v1980', () => {
  assert.ok(cmpVer('2.74.1980', '2.74.1988') < 0);
  assert.ok(cmpVer('2.74.19', '2.74.1980') < 0, 'lexical compare would call these equal-prefixed');
  assert.equal(cmpVer('2.74.1980', '2.74.1980'), 0);
});

it('does NOT infer retirement from an INCIDENT tag — retirement is an act, not a guess', () => {
  // 84 closures at passes=0 came from exactly this kind of proximity reasoning.
  const doc = 'VALIDATE[v2.74.1980 — a claim]:\n  BUILD = a@1\n\nINCIDENT[stage=route class=x sev=live status=closed vclosed=1980 passes=1]';
  assert.equal(parseBlocks(doc).open.length, 1, 'a closed incident nearby retires nothing');
});

it('tolerates junk and an empty document', () => {
  for (const junk of ['', null, undefined, '## just a heading', 'VALIDATE[malformed']) {
    assert.doesNotThrow(() => parseBlocks(junk));
  }
  assert.deepEqual(parseBlocks('').open, []);
});
