// Core/readLeg.test.js — CX-9 slice 1 (v2.74.1158): the read-leg abstraction + per-step selector.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  READ_LEG_KINDS, legRank,
  domScrapeLeg, sessionFetchLeg, networkHarvestLeg,
  normalizeLeg, normalizeExtract, legFeasible, selectReadLeg,
} from './readLeg.js';

describe('readLeg — constructors', () => {
  it('domScrapeLeg keeps the selector; null without one (no shape on legs)', () => {
    assert.deepEqual(domScrapeLeg('.rows li'), { kind: 'dom-scrape', selector: '.rows li' });
    assert.equal(domScrapeLeg(''), null);
    assert.equal(domScrapeLeg(null), null);
  });

  it('sessionFetchLeg carries a session `tool` descriptor; null without endpoint+(origin|appHost)', () => {
    const leg = sessionFetchLeg({ appHost: 'zendesk.com', endpoint: '/api/v2/search.json?query={q}', method: 'get', app: 'zendesk', result: 'results', verifyIdentity: true, identityProbe: '/me.json', args: { q: 'open' } });
    assert.equal(leg.kind, 'session-fetch');
    assert.equal(leg.tool.impl, 'session');
    assert.equal(leg.tool.appHost, 'zendesk.com');
    assert.equal(leg.tool.method, 'GET');                          // upper-cased
    assert.equal(leg.tool.verifyIdentity, true);
    assert.equal(leg.tool.identityProbe, '/me.json');
    assert.equal(leg.result, 'results');
    assert.deepEqual(leg.args, { q: 'open' });
    assert.equal(sessionFetchLeg({ endpoint: '/x' }), null);       // no origin/appHost
    assert.equal(sessionFetchLeg({ appHost: 'x.com' }), null);     // no endpoint
    assert.equal(sessionFetchLeg(), null);
  });

  it('networkHarvestLeg keeps the match pattern + result path; null without a match', () => {
    const leg = networkHarvestLeg({ match: '/api/search', method: 'post', result: 'hits' });
    assert.deepEqual(leg, { kind: 'network-harvest', match: '/api/search', method: 'POST', result: 'hits' });
    assert.equal(networkHarvestLeg({ result: 'x' }), null);
    assert.equal(networkHarvestLeg(), null);
  });
});

describe('readLeg — preference order (§15)', () => {
  it('session-fetch < network-harvest < dom-scrape; unknown sorts last', () => {
    assert.ok(legRank('session-fetch') < legRank('network-harvest'));
    assert.ok(legRank('network-harvest') < legRank('dom-scrape'));
    assert.ok(legRank('dom-scrape') < legRank('mystery'));
    assert.deepEqual(READ_LEG_KINDS, ['session-fetch', 'network-harvest', 'dom-scrape']);
  });
});

describe('readLeg — normalizeExtract (backward-compat + multi-leg)', () => {
  it('a legacy {selector,output,shape} extract → one dom-scrape leg; shape lives on the extract', () => {
    const n = normalizeExtract({ selector: '.list', output: 'ROWS', shape: 'list' });
    assert.equal(n.output, 'ROWS');
    assert.equal(n.shape, 'list');                                 // shape is extract-level
    assert.equal(n.legs.length, 1);
    assert.deepEqual(n.legs[0], { kind: 'dom-scrape', selector: '.list' });
  });

  it('clamps an unknown extract shape to text', () => {
    assert.equal(normalizeExtract({ selector: '.x', shape: 'weird' }).shape, 'text');
    assert.equal(normalizeExtract({ selector: '.x' }).shape, 'text');
  });

  it('orders legs by preference and appends the selector as a dom-scrape fallback', () => {
    const n = normalizeExtract({
      output: 'ROWS', shape: 'list', selector: '.list',
      legs: [ networkHarvestLeg({ match: '/api/s', result: 'hits' }), sessionFetchLeg({ appHost: 'x.com', endpoint: '/api/s' }) ],
    });
    assert.deepEqual(n.legs.map((l) => l.kind), ['session-fetch', 'network-harvest', 'dom-scrape']);
    assert.equal(n.legs[2].selector, '.list');                     // selector fallback present + last
  });

  it('does not duplicate a dom-scrape leg already present', () => {
    const n = normalizeExtract({ output: 'R', selector: '.list', legs: [ domScrapeLeg('.list') ] });
    assert.equal(n.legs.filter((l) => l.kind === 'dom-scrape').length, 1);
  });

  it('null when nothing is readable; tolerates junk', () => {
    assert.equal(normalizeExtract({ output: 'X' }), null);         // no legs, no selector
    assert.equal(normalizeExtract(null), null);
    assert.equal(normalizeExtract({ legs: [{}, null] }), null);
  });

  it('normalizeLeg re-normalizes an already-normalized session leg (tool nested)', () => {
    const leg = sessionFetchLeg({ appHost: 'x.com', endpoint: '/api/s', result: 'r' });
    const again = normalizeLeg(leg);
    assert.equal(again.kind, 'session-fetch');
    assert.equal(again.tool.endpoint, '/api/s');
    assert.equal(again.tool.appHost, 'x.com');
    assert.equal(again.result, 'r');
  });
});

describe('readLeg — legFeasible', () => {
  const session = sessionFetchLeg({ app: 'zendesk', appHost: 'zendesk.com', endpoint: '/api/s' });
  const harvest = networkHarvestLeg({ match: '/api/s' });
  const scrape = domScrapeLeg('.list');

  it('dom-scrape is always feasible', () => {
    assert.equal(legFeasible(scrape, {}), true);
  });

  it('network-harvest needs env.canHarvest', () => {
    assert.equal(legFeasible(harvest, {}), false);
    assert.equal(legFeasible(harvest, { canHarvest: true }), true);
  });

  it('session-fetch needs the app rideable (Set or predicate, matches app|host|origin)', () => {
    assert.equal(legFeasible(session, {}), false);
    assert.equal(legFeasible(session, { sessionRideable: new Set(['zendesk.com']) }), true);
    assert.equal(legFeasible(session, { sessionRideable: new Set(['zendesk']) }), true);   // by app
    assert.equal(legFeasible(session, { sessionRideable: (k) => k === 'zendesk.com' }), true);
    assert.equal(legFeasible(session, { sessionRideable: new Set(['other.com']) }), false);
  });

  it('env.healthy can veto any leg (two-leg health, §15)', () => {
    assert.equal(legFeasible(scrape, { healthy: () => false }), false);
    assert.equal(legFeasible(session, { sessionRideable: new Set(['zendesk.com']), healthy: () => false }), false);
  });
});

describe('readLeg — selectReadLeg (the per-step arbitration §8/§15)', () => {
  const extract = {
    output: 'ROWS', shape: 'list', selector: '.list',
    legs: [
      sessionFetchLeg({ app: 'zendesk', appHost: 'zendesk.com', endpoint: '/api/s', result: 'results' }),
      networkHarvestLeg({ match: '/api/s', result: 'results' }),
    ],
  };

  it('prefers session-fetch when the app is rideable', () => {
    const r = selectReadLeg(extract, { sessionRideable: new Set(['zendesk.com']), canHarvest: true });
    assert.equal(r.leg.kind, 'session-fetch');
    assert.deepEqual(r.considered, ['session-fetch', 'network-harvest', 'dom-scrape']);
  });

  it('falls to network-harvest when not rideable but harvest is available', () => {
    const r = selectReadLeg(extract, { canHarvest: true });
    assert.equal(r.leg.kind, 'network-harvest');
  });

  it('falls to dom-scrape when neither API leg is feasible', () => {
    const r = selectReadLeg(extract, {});
    assert.equal(r.leg.kind, 'dom-scrape');
    assert.equal(r.reason, 'chose dom-scrape');
  });

  it('respects a health veto and skips the unhealthy preferred leg', () => {
    const r = selectReadLeg(extract, {
      sessionRideable: new Set(['zendesk.com']), canHarvest: true,
      healthy: (l) => l.kind !== 'session-fetch',                  // session leg currently unhealthy
    });
    assert.equal(r.leg.kind, 'network-harvest');
  });

  it('returns leg:null with a reason when nothing is feasible', () => {
    const apiOnly = { output: 'R', legs: [ networkHarvestLeg({ match: '/api/s' }) ] };   // no scrape fallback, no canHarvest
    const r = selectReadLeg(apiOnly, {});
    assert.equal(r.leg, null);
    assert.equal(r.reason, 'none-feasible');
  });

  it('accepts a bare legs[] and an empty input', () => {
    const r = selectReadLeg([ domScrapeLeg('.x') ], {});
    assert.equal(r.leg.kind, 'dom-scrape');
    assert.deepEqual(selectReadLeg([], {}), { leg: null, reason: 'no-legs', considered: [] });
  });
});
