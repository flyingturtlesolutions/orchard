// Core/orchTurn.test.js — ORCH-C turn-brain unit tests (node --test). PURE.
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness (shim describe/it).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planAssistantTurn } from './orchTurn.js';
import { toCandidate, matchAsk } from './orchMatch.js';

const cap = (over) => ({ id: 'c1', intent: 'Filter by date posted', params: [{ name: 'DATE', kind: 'option', used: true, value: 'Last 3 days' }], reversible: true, ...over });

describe('orchTurn — ORCH-C assistant turn-brain', () => {
  it('auto → run, carrying capabilityId + params for the REPLAY', () => {
    const p = planAssistantTurn({ decision: 'auto', reason: 'alias-exact', candidate: cap(), capabilityId: 'c1' });
    assert.equal(p.action, 'run');
    assert.equal(p.capabilityId, 'c1');
    assert.equal(p.params.length, 1, 'params flow to the re-run form');
    assert.match(p.say, /running/i);
  });

  it('propose/low-confidence → confirm ("try it?")', () => {
    const p = planAssistantTurn({ decision: 'propose', reason: 'low-confidence', candidate: cap(), capabilityId: 'c1' });
    assert.equal(p.action, 'confirm');
    assert.ok(!p.irreversible);
    assert.match(p.say, /try it/i);
  });

  it('propose/irreversible-confirm → confirm flagged irreversible ("can\'t be undone")', () => {
    const p = planAssistantTurn({ decision: 'propose', reason: 'irreversible-confirm', candidate: cap({ intent: 'Apply to the job', reversible: false }), capabilityId: 'c1' });
    assert.equal(p.action, 'confirm');
    assert.equal(p.irreversible, true);
    assert.match(p.say, /undone/i);
  });

  it('propose/ambiguous → disambiguate with options', () => {
    const p = planAssistantTurn({ decision: 'propose', reason: 'ambiguous', candidate: cap(), alternatives: [{ id: 'a', intent: 'Filter by date posted' }, { id: 'b', intent: 'Filter by pay' }] });
    assert.equal(p.action, 'disambiguate');
    assert.equal(p.options.length, 2);
    assert.match(p.say, /did you mean/i);
  });

  it('miss/no-capability → record ("for this site yet")', () => {
    const p = planAssistantTurn({ decision: 'miss', reason: 'no-capability', scoped: { here: 0, reachable: 0, off: 0 } });
    assert.equal(p.action, 'record');
    assert.match(p.say, /this site yet/i);
  });

  it('miss/below-floor → record ("show me?")', () => {
    const p = planAssistantTurn({ decision: 'miss', reason: 'below-floor', scoped: { here: 3, reachable: 0, off: 0 } });
    assert.equal(p.action, 'record');
    assert.match(p.say, /show me/i);
  });

  it('miss but reachable elsewhere → navigate hint', () => {
    const p = planAssistantTurn({ decision: 'miss', reason: 'below-floor', scoped: { here: 0, reachable: 2, off: 0 } });
    assert.equal(p.action, 'navigate');
    assert.match(p.say, /another part of the site/i);
  });

  it('integrates with matchAsk: an exact alias on a results page → run', () => {
    const G = 'g', RESULTS = 'https://x/jobs';
    const lib = [{ id: 'c-date', groundId: G, localeUrl: RESULTS, intent: 'Filter by date posted', aliases: ['posted today'], params: [] }];
    const m = matchAsk('posted today', lib, { currentGroundId: G, currentLocaleUrl: RESULTS });
    const p = planAssistantTurn(m);
    assert.equal(p.action, 'run');
    assert.equal(p.capabilityId, 'c-date');
  });
});
