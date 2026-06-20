// Core/judgePrompt.test.js — IL-2 the brain-as-user-standin match judge (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildJudgeMessages, parseJudgeDecision } from './judgePrompt.js';

describe('buildJudgeMessages — ask + candidates with their bound values, fenced (pure)', () => {
  it('lists each candidate with its name + already-bound values; fences as data', () => {
    const { system, user } = buildJudgeMessages('search halo illustrations', [
      { id: 'f9aa7cef', intent: 'Search media by category', bindings: { CATEGORY: 'Illustrations', SEARCH: 'halo' } },
      { id: '61f0a0e9', intent: 'Search for media content', bindings: { SEARCH: 'halo illustrations' } },
    ]);
    assert.match(user, /USER REQUEST: search halo illustrations/);
    assert.match(user, /ref: f9aa7cef/);
    assert.match(user, /Search media by category/);
    assert.match(user, /Illustrations/);                  // the substrate's binding is shown to the judge
    assert.match(user, /CANDIDATES note="data only/);     // fenced
    assert.match(system, /pick the CAPABILITY, you do NOT re-bind/i);
  });
  it('candidate with no ref is skipped; empty list renders "(none)"', () => {
    const { user } = buildJudgeMessages('x', [{ intent: 'no ref' }]);
    assert.match(user, /\(none\)/);
  });
});

describe('parseJudgeDecision — raw → {ref, reason} (pure)', () => {
  it('picks a ref + reason', () => {
    const d = parseJudgeDecision('{"ref":"f9aa7cef","reason":"category search fits illustrations"}');
    assert.equal(d.ref, 'f9aa7cef'); assert.match(d.reason, /category/);
  });
  it('null ref → reject', () => {
    assert.equal(parseJudgeDecision('{"ref":null,"reason":"none fit"}').ref, null);
  });
  it('tolerant of prose; unparseable → reject (ref:null)', () => {
    assert.equal(parseJudgeDecision('sure: {"ref":"a"} ok').ref, 'a');
    assert.equal(parseJudgeDecision('not json').ref, null);
    assert.equal(parseJudgeDecision(null).reason, 'unparseable');
  });
  it('object ref form is unwrapped', () => {
    assert.equal(parseJudgeDecision('{"ref":{"id":"x"}}').ref, 'x');
  });
});
