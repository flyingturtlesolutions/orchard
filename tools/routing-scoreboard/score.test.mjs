// tools/routing-scoreboard/score.test.mjs — standalone self-test for the pure scoring layer (v2.74.1729).
// Run: node tools/routing-scoreboard/score.test.mjs   (plain asserts, exit 1 on failure — the digest.test idiom;
// deliberately OUTSIDE the npm-test glob: the tool is local toolchain, not the shipped gate).

import assert from 'node:assert/strict';
import { legIdFromKey, resolvedLegId, isRedirect, scoreEntry, tally, calibrationBins, summaryLines } from './score.mjs';

let n = 0;
const t = (name, fn) => { n++; try { fn(); } catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exit(1); } };

// ── key parsing ──────────────────────────────────────────────────────────────────────────────────────────────
t('legIdFromKey: composed ride key → recipe id', () => {
  assert.equal(legIdFromKey('me.vendorsuite.vs_warranty_tasks@vendorsuite.drhorton.com'), 'vs_warranty_tasks');
  assert.equal(legIdFromKey('me.zendesk.delete_ticket@deako.zendesk.com'), 'delete_ticket');
  assert.equal(legIdFromKey('me.shopify.shopify_create_customer'), 'shopify_create_customer', 'hostless form');
});
t('legIdFromKey: builtin key passes through; junk → null', () => {
  assert.equal(legIdFromKey('OPEN_CASE'), 'OPEN_CASE');
  assert.equal(legIdFromKey(''), null);
  assert.equal(legIdFromKey(null), null);
});

// ── decision reading ─────────────────────────────────────────────────────────────────────────────────────────
const ACT = (key, conf = 0.9) => ({ intent: 'act', capabilityId: key, confidence: conf });
t('resolvedLegId: only an act resolves; clauses carry no leg', () => {
  assert.equal(resolvedLegId(ACT('me.vendorsuite.vs_warranty_tasks@x')), 'vs_warranty_tasks');
  assert.equal(resolvedLegId({ intent: 'case', case: {} }), null);
});
t('isRedirect: clarify / teach / lowConfidence', () => {
  assert.ok(isRedirect({ intent: 'clarify' }) && isRedirect({ intent: 'teach' }) && isRedirect({ intent: 'decompose', lowConfidence: true }));
  assert.ok(!isRedirect({ intent: 'act' }));
});

// ── scoring precedence ───────────────────────────────────────────────────────────────────────────────────────
t('hit: leg matched', () => assert.equal(scoreEntry({ expect: { legId: 'vs_warranty_tasks' } }, ACT('me.vendorsuite.vs_warranty_tasks@x')).status, 'hit'));
t('miss: clean resolve to the WRONG leg', () => {
  const s = scoreEntry({ expect: { legId: 'vs_warranty_tasks' } }, ACT('me.zendesk.my_open_tickets@x'));
  assert.equal(s.status, 'miss'); assert.match(s.why, /wanted vs_warranty_tasks/);
});
t('redirect: the guard rail absorbed it (counted apart from miss — C.2)', () => {
  assert.equal(scoreEntry({ expect: { legId: 'x' } }, { intent: 'clarify', question: 'which?' }).status, 'redirect');
  assert.equal(scoreEntry({ expect: { intent: 'case' } }, { intent: 'teach' }).status, 'redirect');
});
t('intent expectation: hit on match, miss on a different clean intent', () => {
  assert.equal(scoreEntry({ expect: { intent: 'case' } }, { intent: 'case', case: {} }).status, 'hit');
  assert.equal(scoreEntry({ expect: { intent: 'branch' } }, { intent: 'map', map: {} }).status, 'miss');
});
t('violation outranks everything: mustNotResolve breached', () => {
  const s = scoreEntry({ expect: { legId: 'OPEN_CASE' }, mustNotResolve: ['create_ticket'] }, ACT('me.zendesk.create_ticket@x'));
  assert.equal(s.status, 'violation'); assert.match(s.why, /forbidden leg create_ticket/);
});
t('violation: mustNotWrite hit a write-class leg', () => {
  const s = scoreEntry({ mustNotWrite: true }, ACT('me.shopify.shopify_create_order@x'), { writeIds: new Set(['shopify_create_order']) });
  assert.equal(s.status, 'violation');
});
t('pure negative satisfied → hit (the fence held)', () => {
  assert.equal(scoreEntry({ mustNotWrite: true }, ACT('me.vendorsuite.vs_warranty_stats@x'), { writeIds: new Set(['shopify_create_order']) }).status, 'hit');
});

// ── tallies + calibration ────────────────────────────────────────────────────────────────────────────────────
t('tally: rates exclude errors; per-site splits', () => {
  const { overall, perSite } = tally([
    { site: 'a', status: 'hit' }, { site: 'a', status: 'miss' },
    { site: 'b', status: 'redirect' }, { site: 'b', status: 'violation' }, { site: 'b', status: 'error' },
  ]);
  assert.equal(overall.n, 5); assert.equal(overall.errors, 1);
  assert.equal(overall.rate, +(1 / 4).toFixed(3));
  assert.equal(perSite.a.hits, 1); assert.equal(perSite.b.violations, 1);
});
t('calibrationBins: confidence bins × correctness; errors and no-confidence rows excluded', () => {
  const bins = calibrationBins([
    { status: 'hit', confidence: 0.95 }, { status: 'miss', confidence: 0.92 },
    { status: 'hit', confidence: 0.35 }, { status: 'error', confidence: 0.99 }, { status: 'hit', confidence: null },
  ]);
  const top = bins[9]; assert.equal(top.n, 2); assert.equal(top.accuracy, 0.5);
  assert.equal(bins[3].n, 1); assert.equal(bins[3].accuracy, 1);
});
t('summaryLines renders without throwing and names violations', () => {
  const results = [{ ask: 'open a case', site: 'x', expected: 'OPEN_CASE', status: 'violation', got: 'create_ticket', why: 'forbidden', confidence: 0.9 }];
  const lines = summaryLines({ tallies: tally(results), calibration: calibrationBins(results), results, attribution: { manifestVersion: 'v2.74.1729', model: 'm', promptSha: 'abcdef1234567890' } });
  assert.ok(lines.some((l) => /VIOLATION/.test(l)) && lines.some((l) => /forbidden/.test(l)));
});

console.log(`score.test ▸ ${n} checks passed`);
