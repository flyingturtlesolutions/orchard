// Core/legPrerank.test.js — CX-9p (v2.74.1461) deterministic palette pre-rank (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prerankLegs, tierRank, legAskOverlap, askTokens } from './legPrerank.js';

// The projected-leg shapes the interpret cascade builds (Core/connectorLeg.recipeToLeg + the scope stamp).
const mk = (key, scope, name, does, params = {}) => ({
  key, name, does, domain: 'connector', scope,
  paramSchema: { type: 'object', properties: params, required: [] },
});

describe('askTokens — content-word tokenizer (shared lexicon with toolRetrieval)', () => {
  it('drops glue + short tokens, lowercases', () => {
    assert.deepEqual(askTokens('Pull up the Warranty task'), ['pull', 'up', 'warranty', 'task']);
  });
  it('non-string / empty → []', () => {
    assert.deepEqual(askTokens(null), []);
    assert.deepEqual(askTokens(''), []);
  });
});

describe('tierRank — scope precedence; unscoped is neutral, never below GLOBAL', () => {
  it('alias > target > vocab > tab > global', () => {
    assert.ok(tierRank({ scope: 'alias' }) > tierRank({ scope: 'target' }));
    assert.ok(tierRank({ scope: 'target' }) > tierRank({ scope: 'vocab' }));
    assert.ok(tierRank({ scope: 'vocab' }) > tierRank({ scope: 'tab' }));
    assert.ok(tierRank({ scope: 'tab' }) > tierRank({ scope: 'global' }));
  });
  it('unscoped ranks above global, below the winner tiers (never demoted, never dropped)', () => {
    const n = tierRank({});
    assert.ok(n > tierRank({ scope: 'global' }));
    assert.ok(n < tierRank({ scope: 'vocab' }));
  });
});

describe('legAskOverlap — distinct shared content words incl. params/enums/hints', () => {
  it('counts name + does', () => {
    const leg = mk('k', 'global', 'Search Zendesk tickets', 'Search your Zendesk tickets by query');
    assert.equal(legAskOverlap(leg, new Set(askTokens('search my zendesk tickets'))), 3);   // search, zendesk, tickets
  });
  it('counts enum values + hints', () => {
    const leg = mk('k', 'global', 'Read task', 'a task', { status: { type: 'string', enum: ['fixed', 'open'], hint: 'warranty state' } });
    assert.ok(legAskOverlap(leg, new Set(askTokens('the fixed warranty'))) >= 2);   // fixed (enum) + warranty (hint)
  });
  it('empty ask set → 0', () => {
    assert.equal(legAskOverlap(mk('k', 'global', 'x', 'y'), new Set()), 0);
  });
});

describe('prerankLegs — the v1451 regression: the unnamed warranty ask', () => {
  const ask = 'pull up the warranty task at 3955 Gallery Chase in Atlanta West, fixed and show details';
  // The vendorsuite ground is the DOMAIN-MATCH winner (scope 'vocab'); the Zendesk search leg is a GLOBAL fallback.
  const vendor = mk('me.vendorsuite.warranty@vendorsuite.drhorton.com', 'vocab', 'Warranty tasks by status', 'list warranty tasks; open one to show details');
  const zendeskSearch = mk('me.zendesk.search_tickets@deako.zendesk.com', 'global', 'Search Zendesk tickets', 'Search your Zendesk tickets by query and status');

  it('DROPS the zero-overlap GLOBAL search leg once a VOCAB winner owns the ask', () => {
    const out = prerankLegs([zendeskSearch, vendor], ask);
    const keys = out.map((l) => l.key);
    assert.ok(!keys.includes(zendeskSearch.key), 'search_tickets must be capped out (zero overlap + a winner present)');
    assert.equal(out[0].key, vendor.key, 'the vocab-matched vendorsuite leg leads the palette');
  });

  it('KEEPS a global leg that DOES share a word with the ask (cap is vocabulary-relevant, not blanket)', () => {
    const zendeskWarranty = mk('me.zendesk.warranty_search@deako.zendesk.com', 'global', 'Warranty ticket search', 'search warranty tickets');
    const out = prerankLegs([zendeskWarranty, vendor], ask);
    assert.equal(out.length, 2, 'a global sharing "warranty" is relevant → kept');
    assert.equal(out[0].key, vendor.key, 'the winner still leads');
  });
});

describe('prerankLegs — safety: no winner, no drop; unscoped never dropped', () => {
  it('all GLOBAL, no winner → nothing dropped, ordered by ask overlap', () => {
    const a = mk('a', 'global', 'Warranty tasks', 'warranty');   // overlaps "warranty"
    const b = mk('b', 'global', 'Search tickets', 'tickets');     // zero overlap
    const out = prerankLegs([b, a], 'show the warranty');
    assert.equal(out.length, 2, 'full GLOBAL reach preserved when nothing is named/implied');
    assert.equal(out[0].key, 'a', 'the more ask-relevant global still leads');
  });
  it('an unscoped (RAG/panel) leg with zero overlap is never dropped, even with a winner', () => {
    const winner = mk('w', 'vocab', 'Warranty', 'warranty');
    const rag = { key: 'rag.compose', name: 'Draft a reply', does: 'compose', domain: 'self' };   // no scope
    const noise = mk('g', 'global', 'Unrelated', 'nothing');   // global + zero overlap → dropped
    const out = prerankLegs([rag, noise, winner], 'the warranty');
    const keys = out.map((l) => l.key);
    assert.ok(keys.includes('rag.compose'), 'unscoped legs survive the cap');
    assert.ok(!keys.includes('g'), 'the zero-overlap global is capped');
  });
  it('is pure + tolerant: new array, <2 passthrough, junk filtered', () => {
    const legs = [mk('a', 'vocab', 'x', 'y'), mk('b', 'global', 'p', 'q')];
    const out = prerankLegs(legs, 'z');
    assert.notEqual(out, legs);
    assert.deepEqual(prerankLegs([], 'x'), []);
    assert.equal(prerankLegs([mk('solo', 'global', 'x', 'y')], 'x').length, 1);
    assert.deepEqual(prerankLegs(null, 'x'), []);
  });
});
