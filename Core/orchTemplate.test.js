// Core/orchTemplate.test.js — ORCH-X T2 cross-argument rebind (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCompositeTemplate, matchTemplate, rebindSteps } from './orchTemplate.js';

describe('orchTemplate — cross-argument T2 rebind (ORCH-X)', () => {
  it('buildCompositeTemplate: a bound value IN the ask becomes a {PARAM} hole; a default NOT in the ask stays fixed', () => {
    const { template, slots } = buildCompositeTemplate(
      'search for android jobs and if there are any jobs, sort by date',
      { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'android', EDIT_LOCATION: 'remote' },   // "remote" is NOT in the ask
    );
    assert.equal(template, 'search for {SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY} jobs and if there are any jobs, sort by date');
    assert.deepEqual(slots, ['SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY']);
  });

  it('buildCompositeTemplate: longest value first (a longer value is not partially eaten)', () => {
    const { template } = buildCompositeTemplate('find software engineer roles in remote', { ROLE: 'software engineer', LOC: 'remote' });
    assert.equal(template, 'find {ROLE} roles in {LOC}');
  });

  it('matchTemplate: a new ask fits the template → the hole value is captured as a binding', () => {
    const t = 'search for {SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY} jobs and if there are any jobs, sort by date';
    assert.deepEqual(matchTemplate('search for software jobs and if there are any jobs, sort by date', t), { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'software' });
    assert.deepEqual(matchTemplate('search for registered nurse jobs and if there are any jobs, sort by date', t), { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'registered nurse' });
  });

  it('matchTemplate: a non-fitting ask → null; a template with no holes → null', () => {
    const t = 'search for {KW} jobs and if there are any jobs, sort by date';
    assert.equal(matchTemplate('completely different ask', t), null);
    assert.equal(matchTemplate('search for x jobs', 'search for x jobs'), null, 'no {hole} → not a template');
  });

  it('rebindSteps: overwrites the fragment binding with the new value, descending into control-flow bodies', () => {
    const steps = [
      { kind: 'fragment', id: 's0', capabilityId: 'cap-search', bindings: { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'android', EDIT_LOCATION: 'remote' } },
      { kind: 'wait', id: 'settle_cond', ms: 1800 },
      { kind: 'observe', id: 'cond', capabilityId: 'obs-v', outputType: 'count' },
      { kind: 'analyze', id: 'pred', over: 'cond' },
      { kind: 'gate', id: 'gate', over: 'pred', body: [{ kind: 'fragment', id: 'act0', capabilityId: 'cap-sort', bindings: {} }] },
    ];
    const rebound = rebindSteps(steps, { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'software' });
    assert.equal(rebound[0].bindings.SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY, 'software', 'keyword rebound');
    assert.equal(rebound[0].bindings.EDIT_LOCATION, 'remote', 'the default location is untouched');
    assert.equal(steps[0].bindings.SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY, 'android', 'the input is NOT mutated');
    assert.equal(rebound[4].body[0].capabilityId, 'cap-sort', 'the gate body survives');
  });

  it('round-trip: save "android" → match "software" → rebind = a "software" plan (the T2 cache that generalizes)', () => {
    const ask = 'search for android jobs and if there are any jobs, sort by date';
    const { template } = buildCompositeTemplate(ask, { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'android' });
    const nb = matchTemplate('search for software jobs and if there are any jobs, sort by date', template);
    assert.deepEqual(nb, { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'software' });
    const steps = [{ kind: 'fragment', id: 's0', bindings: { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'android' } }];
    assert.equal(rebindSteps(steps, nb)[0].bindings.SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY, 'software');
  });
});
