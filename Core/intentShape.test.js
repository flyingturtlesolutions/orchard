// Core/intentShape.test.js — CR-D3 (v2.74.939): first tests for the canonical shape classifier + the
// now-single READ_VERB lexicon (trialSynth's same-tier fork had drifted before this pinned it).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyIntentShape, READ_VERB } from './intentShape.js';

describe('READ_VERB — the single read lexicon (CR-D3)', () => {
  it('includes the verbs the trialSynth fork was missing', () => {
    for (const v of ['count the results', 'discover new tools', 'fetch the price', 'locate the office', 'capture the table']) {
      assert.ok(READ_VERB.test(v), `"${v}" should be readish`);
    }
  });
  it('deliberately excludes "check" (ambiguous: "check a box" is an act)', () => {
    assert.ok(!READ_VERB.test('check the second box'), '"check" must not be a read verb');
  });
});

describe('classifyIntentShape — lexical primary, structural tie-breaker', () => {
  it('read verbs → read', () => {
    assert.equal(classifyIntentShape('count the search results').shape, 'read');
    assert.equal(classifyIntentShape('list the job titles').shape, 'read');
  });
  it('act verbs → act', () => {
    assert.equal(classifyIntentShape('click the first result').shape, 'act');
  });
  it('completion verbs + form noun → complete', () => {
    assert.equal(classifyIntentShape('fill out the application form').shape, 'complete');
  });
  it('structural evidence only decides when the verb is silent', () => {
    const r = classifyIntentShape('the contact page', { requiredFieldCount: 5, hasSubmit: true });
    assert.equal(r.shape, 'complete');
    const r2 = classifyIntentShape('list the openings', { requiredFieldCount: 5, hasSubmit: true });
    assert.equal(r2.shape, 'read', 'structural form-evidence never overrides a confident lexical read');
  });
});
