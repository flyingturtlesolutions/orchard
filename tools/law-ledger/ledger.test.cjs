// tools/law-ledger/ledger.test.cjs — standalone self-test (plain assert, DELIBERATELY outside the npm glob —
// the ledger is toolchain, not gate; the scoreboard precedent). Run: node tools/law-ledger/ledger.test.cjs
'use strict';
const assert = require('assert');
const { parseIncidentTags, parseBaselineCsv, episodesFrom, poissonCdf, stageSummary } = require('./ledger.cjs');

// tag parsing
const tags = parseIncidentTags([
  'prose INCIDENT[stage=receipts class=silent-exit sev=live status=open vfirst=1853] more prose',
  'INCIDENT[class=silent-exit status=closed vclosed=1855 passes=+3]',
  'INCIDENT[stage=clerks class=claiming sev=live status=closed vfirst=1851 vclosed=1852]',
].join('\n'));
assert.strictEqual(tags.length, 3);
assert.strictEqual(tags[0].stage, 'receipts');
assert.strictEqual(tags[1].passes, 3, 'the +N form parses to a number');
assert.strictEqual(tags[2].vclosed, 1852);

// episode grouping: open+closed rows collapse to ONE closed episode with the explicit passes
const eps = episodesFrom(tags);
const se = eps.find((e) => e.class === 'silent-exit');
assert.strictEqual(eps.length, 2);
assert.strictEqual(se.status, 'closed');
assert.strictEqual(se.lifetime, 3, 'explicit passes wins over row count');
assert.strictEqual(eps.find((e) => e.class === 'claiming').lifetime, 1, 'row count when no explicit passes');

// csv parsing (header + comment rows + numeric coercion)
const rows = parseBaselineCsv([
  '# comment',
  'class,stage,sev,status,vfirst,vclosed,passes,anchor,label_confidence',
  'claiming,clerks,live,closed,1520,1561,1,anchor text,med',
].join('\n'));
assert.strictEqual(rows.length, 1);
assert.strictEqual(rows[0].vfirst, 1520);
assert.strictEqual(rows[0].stage, 'clerks');

// stage summary math: 2 episodes over a 100-version window → 2.0/100v
const sum = stageSummary(episodesFrom([
  { class: 'a', stage: 's1', sev: 'live', status: 'closed', vfirst: 100, vclosed: 101, passes: 2 },
  { class: 'b', stage: 's1', sev: 'live', status: 'closed', vfirst: 150, vclosed: 151, passes: 4 },
]), { fromV: 100, toV: 200 });
assert.strictEqual(sum[0].incidents, 2);
assert.strictEqual(sum[0].per100v, 2);
assert.strictEqual(sum[0].medianPasses, 2, 'lower median of [2,4]');

// Poisson sanity — the pre-registered numbers: P(X ≤ 1 | λ=6.6) ≈ 0.0103; P(X=0 | λ=4.7) ≈ 0.0091
assert.ok(Math.abs(poissonCdf(1, 6.6) - 0.0103) < 0.002, `got ${poissonCdf(1, 6.6)}`);
assert.ok(Math.abs(poissonCdf(0, 4.7) - 0.0091) < 0.002, `got ${poissonCdf(0, 4.7)}`);
assert.ok(Math.abs(poissonCdf(10, 2) - 1) < 1e-4, 'cdf tends to 1');   // P(X≤10|λ=2) ≈ 0.999992 — 1e-6 was tighter than the true tail

console.log('ledger.test.cjs — all assertions passed');
