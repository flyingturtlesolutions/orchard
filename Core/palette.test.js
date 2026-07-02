// Core/palette.test.js — IL-2 the inference-layer leg palette (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assemblePalette, toOfferedLeg, availableBuiltins, policyFilter, attachPrior, composeOfferedLeg, BUILTIN_LEGS } from './palette.js';
import { normalizeInterpretDecision } from './interpret.js';

const cap = (id, extra = {}) => ({ kind: 'capability', capabilityId: id, name: id, ...extra });

describe('toOfferedLeg — uniform normalization (pure)', () => {
  it('learned capability → page/act/learned, write defaults to confirm', () => {
    const l = toOfferedLeg(cap('cap_buy'));
    assert.equal(l.domain, 'page'); assert.equal(l.source, 'learned'); assert.equal(l.mode, 'act'); assert.equal(l.safety, 'confirm');
  });
  it('read-only learned capability → ask + auto (read-only buys autonomy, §2.4)', () => {
    const l = toOfferedLeg(cap('cap_read', { read: true }));
    assert.equal(l.mode, 'ask'); assert.equal(l.safety, 'auto');
  });
  it('explicit safety class on a capability wins (PB-4)', () => {
    assert.equal(toOfferedLeg(cap('cap_x', { safety: 'gated' })).safety, 'gated');
  });
  it('builtin/primitive descriptor → builtin leg, domain preserved', () => {
    const l = toOfferedLeg({ key: 'OPEN_URL', name: 'Open', mode: 'act', domain: 'browser', safety: 'auto' });
    assert.equal(l.source, 'builtin'); assert.equal(l.domain, 'browser'); assert.equal(l.key, 'OPEN_URL');
  });
  it('already-normalized leg passes through unchanged', () => {
    const leg = { key: 'K', domain: 'self', source: 'builtin', mode: 'ask' };
    assert.equal(toOfferedLeg(leg), leg);
  });
  it('null / no-key → null', () => { assert.equal(toOfferedLeg(null), null); assert.equal(toOfferedLeg({}), null); });
});

describe('availableBuiltins — availability gating', () => {
  it('drops legs whose requires flags are absent from env (FOCUS_TAB needs a tab)', () => {
    const keys = availableBuiltins(BUILTIN_LEGS, {}).map((l) => l.key);
    assert.ok(keys.includes('OPEN_URL'));        // requires nothing
    assert.ok(keys.includes('LIST_TABS'));       // requires nothing
    assert.ok(!keys.includes('FOCUS_TAB'));      // requires a tab
    assert.ok(!keys.includes('CLOSE_TABS'));     // requires a tab
  });
  it('env.tab=true admits the tab-requiring legs', () => {
    const keys = availableBuiltins(BUILTIN_LEGS, { tab: true }).map((l) => l.key);
    assert.ok(keys.includes('FOCUS_TAB')); assert.ok(keys.includes('CLOSE_TABS'));
  });
  it('stamps source=builtin', () => {
    assert.ok(availableBuiltins(BUILTIN_LEGS, { tab: true }).every((l) => l.source === 'builtin'));
  });
});

describe('composeOfferedLeg — GD-4b drafting joins interpret’s palette (§8.2)', () => {
  const app = { presentation: { backend: 'gdoc', blocks: [] } };
  it('an app WITH a presentation layer → a param-free COMPOSE act leg (the ask is the brief, not a spec param)', () => {
    const l = composeOfferedLeg(app);
    assert.equal(l.key, 'COMPOSE'); assert.equal(l.domain, 'self'); assert.equal(l.mode, 'act');
    assert.equal(l.source, 'builtin');
    assert.deepEqual(l.params, []);                          // NOT the BUILTIN_LEGS ['spec'] channel shape
    assert.match(l.does, /draft/i);                          // draft-forward — an underspecified ask can select it
    assert.match(l.does, /no ticket or context required/i);  // the standalone-act promise (the clarify-loop fix)
  });
  it('off-app / no presentation → null (the leg never reaches interpret)', () => {
    assert.equal(composeOfferedLeg(null), null);
    assert.equal(composeOfferedLeg({}), null);
    assert.equal(composeOfferedLeg({ presentation: null }), null);
  });
  it('a COMPOSE pick survives normalizeInterpretDecision ONLY when the leg is in retrieved (the GD-4b wiring)', () => {
    const raw = { intent: 'act', capabilityId: 'COMPOSE', confidence: 0.9 };
    const withLeg = normalizeInterpretDecision(raw, { retrieved: [composeOfferedLeg(app)] });
    assert.equal(withLeg.intent, 'act'); assert.equal(withLeg.capabilityId, 'COMPOSE');
    const without = normalizeInterpretDecision(raw, { retrieved: [] });   // pre-GD-4b: the leg was never offered…
    assert.equal(without.intent, 'teach');                                // …so the pick demoted (the clarify/teach loop)
  });
});

describe('policyFilter — floor + tighten-only rules (§2.3)', () => {
  const legs = [
    { key: 'READ', domain: 'page', safety: 'auto' },
    { key: 'WIRE_MONEY', domain: 'page', safety: 'forbidden' },
    { key: 'CLOSE_TABS', domain: 'browser', safety: 'confirm' },
  ];
  it('FLOOR: a forbidden-safety leg is always dropped, no rule needed', () => {
    const keys = policyFilter(legs, {}).map((l) => l.key);
    assert.ok(!keys.includes('WIRE_MONEY'));
    assert.ok(keys.includes('READ')); assert.ok(keys.includes('CLOSE_TABS'));
  });
  it('a rule forbidding a key drops it (tighten-only)', () => {
    const keys = policyFilter(legs, { rules: [{ forbidKeys: ['CLOSE_TABS'] }] }).map((l) => l.key);
    assert.ok(!keys.includes('CLOSE_TABS')); assert.ok(keys.includes('READ'));
  });
  it('a rule forbidding a domain drops all legs of that domain', () => {
    const keys = policyFilter(legs, { rules: [{ forbidDomains: ['browser'] }] }).map((l) => l.key);
    assert.ok(!keys.includes('CLOSE_TABS'));
  });
  it('a scoped rule only applies in its scope (most-specific scope wins)', () => {
    const rules = [{ when: { ground: 'shopify' }, forbidKeys: ['READ'] }];
    assert.ok(policyFilter(legs, { rules, scope: { ground: 'other' } }).map((l) => l.key).includes('READ'));   // off-scope: kept
    assert.ok(!policyFilter(legs, { rules, scope: { ground: 'shopify' } }).map((l) => l.key).includes('READ')); // in-scope: dropped
  });
});

describe('attachPrior — OUTCOMES bias + read/write hint', () => {
  it('attaches success/n from the outcomes lookup', () => {
    const l = attachPrior({ key: 'K', mode: 'act' }, (k) => (k === 'K' ? { success: 0.9, n: 12 } : null));
    assert.equal(l.prior.success, 0.9); assert.equal(l.prior.n, 12); assert.equal(l.prior.readWrite, 'write');
  });
  it('ask mode → read hint; no outcomes → success null, n 0', () => {
    const l = attachPrior({ key: 'K', mode: 'ask' }, null);
    assert.equal(l.prior.readWrite, 'read'); assert.equal(l.prior.success, null); assert.equal(l.prior.n, 0);
  });
});

describe('assemblePalette — the §4.3 pipeline (pure, injected deps)', () => {
  it('unions learned ∪ builtins; learned wins a key tie; dedupes', async () => {
    const retrieve = async () => [cap('cap_a'), cap('OPEN_URL')];   // a learned cap collides with the OPEN_URL builtin
    const legs = await assemblePalette('do a thing', {}, { retrieve, env: { tab: true } });
    const open = legs.filter((l) => l.key === 'OPEN_URL');
    assert.equal(open.length, 1);                 // deduped
    assert.equal(open[0].source, 'learned');      // learned wins the tie
    assert.ok(legs.some((l) => l.key === 'cap_a'));
    assert.ok(legs.some((l) => l.key === 'FOCUS_TAB'));   // builtin admitted by env.tab
  });

  it('empty goal → no retrieve call, builtins only', async () => {
    let called = false;
    const legs = await assemblePalette('   ', {}, { retrieve: async () => { called = true; return []; } });
    assert.equal(called, false);
    assert.ok(legs.every((l) => l.source === 'builtin'));
  });

  it('retrieve throwing → still returns the builtin legs (never throws)', async () => {
    const legs = await assemblePalette('x', {}, { retrieve: async () => { throw new Error('boom'); } });
    assert.ok(legs.some((l) => l.key === 'OPEN_URL'));
  });

  it('policy rules drop legs from the assembled set', async () => {
    const legs = await assemblePalette('x', {}, { retrieve: async () => [cap('cap_a')], rules: [{ forbidKeys: ['cap_a'] }] });
    assert.ok(!legs.some((l) => l.key === 'cap_a'));
  });

  it('every returned leg carries an attached prior', async () => {
    const legs = await assemblePalette('x', {}, { retrieve: async () => [cap('cap_a')], outcomes: () => ({ success: 0.5, n: 3 }) });
    assert.ok(legs.every((l) => l.prior && l.prior.readWrite));
  });

  it('passes k through to retrieve', async () => {
    let seenK = null;
    await assemblePalette('x', {}, { retrieve: async (_g, k) => { seenK = k; return []; } }, { k: 5 });
    assert.equal(seenK, 5);
  });
});
