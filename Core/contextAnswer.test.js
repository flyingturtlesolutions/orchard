// Core/contextAnswer.test.js — "which X am I in right now" answered from the resolver (v2.74.1872). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nounForParam, contextSpecsFor, contextAskFor, contextAnswerLine } from './contextAnswer.js';
import { resolveRideParam } from './rideParamResolve.js';

// The real catalog shape: ONE shared spec, declared on the CONSUMER legs, keyed to the state read by `via`.
// `vs_state` itself declares no resolve — which is exactly why the link has to be found by endpoint.
const VS_DIVISION = { via: '/api/VendorSuite/State', defaultPath: 'access.DefaultDivision.Id', lists: ['access.Hubs[].Divisions'], match: ['Code', 'Name'], id: 'Id', label: 'Name', each: true };
const CATALOG = [
  { id: 'vs_state', endpoint: '/api/VendorSuite/State', params: [] },
  { id: 'vs_warranty_tasks', endpoint: '/api/Warranty/Tasks', resolve: { divisionId: VS_DIVISION } },
  { id: 'vs_announcements', endpoint: '/api/Announcements', resolve: { divisionId: VS_DIVISION } },
  { id: 'shopify_order', endpoint: '/admin/orders.json' },
];
const STATE = {
  access: {
    DefaultDivision: { Id: 32, Name: 'Raleigh', Code: '495' },
    Hubs: [{ Divisions: [{ Id: 32, Code: '495', Name: 'Raleigh' }, { Id: 37, Code: '210', Name: 'Charlotte North' }, { Id: 83, Code: '211', Name: 'Atlanta West' }] }],
  },
};
const SPECS = contextSpecsFor('/api/VendorSuite/State', CATALOG);

describe('contextAnswer — nouns off param names', () => {
  it('strips the id suffix and spaces the camel', () => {
    assert.equal(nounForParam('divisionId'), 'division');
    assert.equal(nounForParam('accountId'), 'account');
    assert.equal(nounForParam('work_order_id'), 'work order');
  });
});

describe('contextAnswer — the state-source link', () => {
  it('finds the spec vs_state is the via-read for, deduped across the legs that declare it', () => {
    assert.equal(SPECS.length, 1);
    assert.equal(SPECS[0].param, 'divisionId');
    assert.equal(SPECS[0].noun, 'division');
  });
  it('an unrelated endpoint links to nothing', () => {
    assert.equal(contextSpecsFor('/admin/orders.json', CATALOG).length, 0);
    assert.equal(contextSpecsFor('', CATALOG).length, 0);
  });
  it('a spec with no defaultPath declares no current context, so there is nothing to answer', () => {
    assert.equal(contextSpecsFor('/x', [{ id: 'a', resolve: { q: { via: '/x', id: 'Id' } } }]).length, 0);
  });
});

describe('contextAnswer — what the ask claims', () => {
  // the first entry is the live 6-pass phrasing (gl 202123 and four passes before it)
  for (const q of [
    'which division am I in right now',
    'which division am I in',
    'what division am I in?',
    "what's my current division",
    'what is the current division',
    'which division are we in right now',
    'show me my current division',
    'my current division',
    'current division?',
  ]) it(`claims: "${q}"`, () => assert.ok(contextAskFor(q, SPECS)));
});

describe('contextAnswer — what it must NOT claim', () => {
  // The SCOPE uses are the dangerous ones: they contain the noun, "my" and "current", and they are ACTS.
  // A false claim here would swallow a read, which is strictly worse than the bug this module fixes.
  for (const q of [
    'get open warranty tasks in my current division',
    'get open warranty tasks in Charlotte North',
    'which division has the most open tasks',
    'what divisions can I access',
    'list every division',
    'for each division, get open warranty tasks',
    'which division is task 4867009 in',
    'read warranty task 4867009',
  ]) it(`declines: "${q}"`, () => assert.equal(contextAskFor(q, SPECS), null));
});

describe('contextAnswer — the answer', () => {
  it('resolves through the binder’s own call (blank raw → defaultPath)', () => {
    const r = resolveRideParam(SPECS[0].spec, '', STATE);
    assert.equal(r.value, 32);
    assert.equal(r.label, 'Raleigh');
    assert.equal(r.defaulted, true);
  });
  it('names the division, its id, and how many others exist', () => {
    const line = contextAnswerLine({ noun: 'division', resolved: resolveRideParam(SPECS[0].spec, '', STATE), total: 121 });
    assert.match(line, /You're in \*\*Raleigh\*\* \(division 32\) — 1 of 121 you can access\./);
  });
  it('states the CONVERSATION’s division too, but only when it disagrees', () => {
    // live 202123: the site was Raleigh while the thread had stuck on Charlotte North — either alone is half-true
    const resolved = resolveRideParam(SPECS[0].spec, '', STATE);
    const both = contextAnswerLine({ noun: 'division', resolved, total: 121, conversation: 'Charlotte North' });
    assert.match(both, /Charlotte North/);
    assert.match(both, /has been reading/);
    assert.doesNotMatch(contextAnswerLine({ noun: 'division', resolved, total: 121, conversation: 'Raleigh' }), /has been reading/);
    assert.doesNotMatch(contextAnswerLine({ noun: 'division', resolved, total: 121, conversation: '  raleigh ' }), /has been reading/);
  });
  it('answers NOTHING rather than guessing when the context is unresolvable', () => {
    assert.equal(contextAnswerLine({ noun: 'division', resolved: null }), null);
    assert.equal(resolveRideParam(SPECS[0].spec, '', { access: {} }), null);
  });
  it('drops the parenthetical when the id IS the label', () => {
    assert.doesNotMatch(contextAnswerLine({ noun: 'region', resolved: { value: 'EMEA', label: 'EMEA' }, total: 1 }), /\(/);
  });
});
