// Core/interactionDemand.test.js — C1 interaction demand set (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildInteractionDemand, interactionKindsForRole, DEFAULT_KINDS } from './interactionDemand.js';

const persp = (landmarks) => ({ landmarks });
const lm = (landmarkUid, role) => ({ landmarkUid, role });

describe('interactionKindsForRole — role → watch kinds', () => {
  it('maps Layer-2 semantic roles', () => {
    assert.deepEqual(interactionKindsForRole('search-query'), ['focus', 'type']);
    assert.deepEqual(interactionKindsForRole('search-submit'), ['click', 'submit']);
    assert.deepEqual(interactionKindsForRole('result-link'), ['click']);
  });
  it('maps a11y roles (the registry-available signal)', () => {
    assert.deepEqual(interactionKindsForRole('textbox'), ['focus', 'type']);
    assert.deepEqual(interactionKindsForRole('button'), ['click']);
    assert.deepEqual(interactionKindsForRole('link'), ['click']);
  });
  it('is case/whitespace-insensitive; unknown/empty/null → DEFAULT_KINDS (click)', () => {
    assert.deepEqual(interactionKindsForRole('  BUTTON '), ['click']);
    assert.deepEqual(interactionKindsForRole('weird-role'), ['click']);
    assert.deepEqual(interactionKindsForRole(''), ['click']);
    assert.deepEqual(interactionKindsForRole(null), ['click']);
    assert.deepEqual(interactionKindsForRole(undefined), DEFAULT_KINDS.slice());
  });
  it('returns a COPY — the frozen source is never mutated', () => {
    const a = interactionKindsForRole('button'); a.push('XX');
    assert.deepEqual(interactionKindsForRole('button'), ['click']);
  });
});

describe('buildInteractionDemand — the demand set', () => {
  it('one row per landmark, kinds from role, sorted by landmarkUid', () => {
    const d = buildInteractionDemand([persp([lm('lm_q', 'search-query'), lm('lm_go', 'search-submit')])], { groundId: 'gnd_x' });
    assert.deepEqual(d, [
      { groundId: 'gnd_x', landmarkUid: 'lm_go', interactionKinds: ['click', 'submit'], reason: 'accepted-perspective' },
      { groundId: 'gnd_x', landmarkUid: 'lm_q',  interactionKinds: ['focus', 'type'],   reason: 'accepted-perspective' },
    ]);
  });
  it('dedups a landmark across perspectives — ONE row with UNIONED kinds', () => {
    const d = buildInteractionDemand([persp([lm('lm1', 'search-query')]), persp([lm('lm1', 'search-submit')])], { groundId: 'g' });
    assert.equal(d.length, 1);
    assert.equal(d[0].landmarkUid, 'lm1');
    assert.deepEqual(d[0].interactionKinds, ['click', 'focus', 'submit', 'type']);   // union, sorted
  });
  it('unknown / missing role → click default', () => {
    const d = buildInteractionDemand([persp([lm('lm_a', 'mystery'), lm('lm_b', null)])], { groundId: 'g' });
    assert.deepEqual(d.map((r) => r.interactionKinds), [['click'], ['click']]);
  });
  it('reason defaults to accepted-perspective; valid passthrough; invalid → default', () => {
    assert.equal(buildInteractionDemand([persp([lm('l', 'button')])], { groundId: 'g' })[0].reason, 'accepted-perspective');
    assert.equal(buildInteractionDemand([persp([lm('l', 'button')])], { groundId: 'g', reason: 'debug' })[0].reason, 'debug');
    assert.equal(buildInteractionDemand([persp([lm('l', 'button')])], { groundId: 'g', reason: 'bogus' })[0].reason, 'accepted-perspective');
  });
  it('skips blank/missing landmarkUids', () => {
    const d = buildInteractionDemand([persp([lm('', 'button'), lm('  ', 'link'), { role: 'button' }, lm('ok', 'button')])], { groundId: 'g' });
    assert.deepEqual(d.map((r) => r.landmarkUid), ['ok']);
  });
  it('degrades gracefully: no groundId, empty, malformed → []', () => {
    assert.deepEqual(buildInteractionDemand([persp([lm('l', 'button')])], {}), []);          // no groundId
    assert.deepEqual(buildInteractionDemand([persp([lm('l', 'button')])], { groundId: '' }), []);
    assert.deepEqual(buildInteractionDemand([], { groundId: 'g' }), []);
    assert.deepEqual(buildInteractionDemand(null, { groundId: 'g' }), []);
    assert.deepEqual(buildInteractionDemand([{ }, { landmarks: null }], { groundId: 'g' }), []);
    assert.deepEqual(buildInteractionDemand(), []);
  });
  it('is deterministic — same input → identical output', () => {
    const input = [persp([lm('b', 'button'), lm('a', 'textbox')])];
    assert.deepEqual(buildInteractionDemand(input, { groundId: 'g' }), buildInteractionDemand(input, { groundId: 'g' }));
  });
});
