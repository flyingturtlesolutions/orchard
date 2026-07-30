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
t('mustNotIntent: an act-ask drawing a forbidden intent is a VIOLATION, not a miss (v1753, the answer-class)', () => {
  const e = { expect: { legId: 'aw_my_line' }, mustNotIntent: ['answer'] };
  const s = scoreEntry(e, { intent: 'answer', confidence: 0.95 });
  assert.equal(s.status, 'violation'); assert.match(s.why, /forbidden intent "answer"/);
  assert.equal(scoreEntry(e, { intent: 'clarify', question: 'which line?' }).status, 'redirect', 'clarify stays a legal redirect');
  assert.equal(scoreEntry(e, ACT('me.aw.aw_my_line@x')).status, 'hit', 'the act path is untouched');
});
t('accept: an alternative leg scores as hit; anything else still misses (v1751, the drill-via-list correction)', () => {
  const e = { expect: { legId: 'vs_warranty_task' }, accept: ['vs_warranty_tasks'] };
  assert.equal(scoreEntry(e, ACT('me.vendorsuite.vs_warranty_tasks@x')).status, 'hit');
  assert.match(scoreEntry(e, ACT('me.vendorsuite.vs_warranty_tasks@x')).why, /accepted alternative/);
  assert.equal(scoreEntry(e, ACT('me.vendorsuite.vs_state@x')).status, 'miss', 'accept is a list, not a wildcard');
  assert.equal(scoreEntry({ ...e, mustNotResolve: ['vs_warranty_tasks'] }, ACT('me.vendorsuite.vs_warranty_tasks@x')).status, 'violation',
    'a negative still outranks an accept');
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


// ── v2.74.1876: PARAM ASSERTIONS ─────────────────────────
// The corpus asserted `expect.legId` and nothing else, so the live text-find failure ("warranty tasks on Misty
// Creek" → bound divisionId instead of address) scored a clean HIT while dying live. Right leg, wrong slot.
const _ENTRY = { ask: 'warranty tasks on Misty Creek', expect: { legId: 'vs_warranty_tasks' }, expectParams: { address: 'Misty Creek' }, mustNotBindParams: ['divisionId'] };
const _dec = (params) => ({ intent: 'act', capabilityId: 'me.vendorsuite.vs_warranty_tasks@h', params });

t('params: the right slot is a hit', () => {
  assert.equal(scoreEntry(_ENTRY, _dec({ address: 'Misty Creek', status: 'open' })).status, 'hit');
});
t('params: right leg + WRONG SLOT is a miss, and the why names the slot', () => {
  const w = scoreEntry(_ENTRY, _dec({ divisionId: 'Misty Creek', status: 'open' }));
  assert.equal(w.status, 'miss');
  assert.match(w.why, /divisionId/);
});
t('params: a leg-only entry is unaffected — this is exactly the old blind spot, pinned', () => {
  assert.equal(scoreEntry({ ask: 'x', expect: { legId: 'vs_warranty_tasks' } }, _dec({ divisionId: 'Misty Creek' })).status, 'hit');
});
t('params: whitespace is not a binding', () => {
  assert.equal(scoreEntry(_ENTRY, _dec({ address: '   ' })).status, 'miss');
});
t('params: router normalisation must not false-flag (case + superset value)', () => {
  assert.equal(scoreEntry(_ENTRY, _dec({ address: '1091 MISTY CREEK DRIVE' })).status, 'hit');
});
t('params: a different value IS caught', () => {
  assert.match(scoreEntry(_ENTRY, _dec({ address: 'Laurel Oaks' })).why, /does not carry/);
});
t('params: expectParams:true means any non-empty value', () => {
  const any = { ask: 'x', expect: { legId: 'vs_warranty_tasks' }, expectParams: { address: true } };
  assert.equal(scoreEntry(any, _dec({ address: 'anything' })).status, 'hit');
  assert.equal(scoreEntry(any, _dec({ status: 'open' })).status, 'miss');
});
t('params: a breached NEGATIVE still outranks the param check', () => {
  const fenced = { ..._ENTRY, mustNotResolve: ['vs_warranty_tasks'] };
  assert.equal(scoreEntry(fenced, _dec({ divisionId: 'Misty Creek' })).status, 'violation');
});
t('params: no param assertion → unchanged behaviour', () => {
  assert.equal(scoreEntry({ ask: 'x', expect: { legId: 'vs_warranty_tasks' } }, _dec({})).status, 'hit');
});


// ── v2.74.1878: the enumeration sentinel ────────────────
// Live 190346, the gate's first meeting with a real decision: the router resolved `warranty tasks on Misty Creek`
// to `{divisionId:"each", address:"Misty Creek"}` — the row filter right AND every division asked for, the best
// available resolve — and `mustNotBindParams:['divisionId']` would have called it a MISS.
t('sentinel: divisionId:"each" does NOT breach mustNotBindParams — it widens, it does not narrow', () => {
  assert.equal(scoreEntry(_ENTRY, _dec({ divisionId: 'each', address: 'Misty Creek' })).status, 'hit');
  for (const v of ['every', 'ALL', ' each ']) {
    assert.equal(scoreEntry(_ENTRY, _dec({ divisionId: v, address: 'Misty Creek' })).status, 'hit', v);
  }
});
t('sentinel: a real place-name in that slot is still a miss — the fix must not blunt the check', () => {
  const w = scoreEntry(_ENTRY, _dec({ divisionId: 'Collinswood', address: 'Misty Creek' }));
  assert.equal(w.status, 'miss');
  assert.match(w.why, /must not narrow/);
});
t('sentinel: a POSITIVE expectParams is a different question — "each" answers it', () => {
  assert.equal(scoreEntry({ ask: 'x', expect: { legId: 'vs_warranty_tasks' }, expectParams: { divisionId: true } }, _dec({ divisionId: 'each' })).status, 'hit');
});

console.log(`score.test ▸ ${n} checks passed`);
