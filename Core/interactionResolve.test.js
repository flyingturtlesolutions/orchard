// Core/interactionResolve.test.js — C3 L1 resolver (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveInteraction } from './interactionResolve.js';
import { makeRawInteraction } from './interactionCapture.js';
import { classifyResolved } from './interactionClassification.js';

const raw = (kind = 'click') => ({ id: 'evt_1', ts: 1, tabId: 1, frameId: 0, url: 'https://x.com/a', interactionKind: kind, target: { tagName: 'button' } });
const match = (uid, over = {}) => ({ landmarkUid: uid, perspectiveId: 'p_' + uid, role: 'button', selector: '#' + uid, ...over });

describe('resolveInteraction — assemble the ResolvedInteraction', () => {
  it('exactly one match → hit, enriched (perspectiveId, role, selectorUsed, confidence=1)', () => {
    const r = resolveInteraction(raw(), { matches: [match('a')], groundId: 'g', activePerspectiveIds: ['p_a'] });
    assert.equal(r.resolutionStatus, 'hit');
    assert.equal(r.groundId, 'g');
    assert.deepEqual(r.matches, [{ landmarkUid: 'a', perspectiveId: 'p_a', selectorUsed: '#a', confidence: 1, role: 'button' }]);
    assert.deepEqual(r.activePerspectiveIds, ['p_a']);
    assert.equal(r.raw.interactionKind, 'click');
  });
  it('multiple matches → ambiguous', () => {
    assert.equal(resolveInteraction(raw(), { matches: [match('a'), match('b')] }).resolutionStatus, 'ambiguous');
  });
  it('no matches → miss (empty matches array)', () => {
    const r = resolveInteraction(raw(), { matches: [] });
    assert.equal(r.resolutionStatus, 'miss');
    assert.deepEqual(r.matches, []);
  });
  it('sensitive → suppressed (surfaces NO landmark detail)', () => {
    const r = resolveInteraction(raw('type'), { matches: [match('pw')], sensitive: true });
    assert.equal(r.resolutionStatus, 'suppressed');
    assert.deepEqual(r.matches, []);
  });
  it('dedups a landmark matched via >1 selector → one hit', () => {
    const r = resolveInteraction(raw(), { matches: [match('a', { selector: '#a1' }), match('a', { selector: '#a2' })] });
    assert.equal(r.resolutionStatus, 'hit');
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].selectorUsed, '#a1');           // first wins
  });
  it('selectorUsed accepts selector|selectorUsed; confidence default 1 / explicit passthrough', () => {
    const r = resolveInteraction(raw(), { matches: [{ landmarkUid: 'a', selectorUsed: '.x', confidence: 0.7 }] });
    assert.equal(r.matches[0].selectorUsed, '.x');
    assert.equal(r.matches[0].confidence, 0.7);
    assert.equal(r.matches[0].perspectiveId, null);           // missing → null
  });
  it('filters malformed matches + non-string active ids', () => {
    const r = resolveInteraction(raw(), { matches: [match('a'), { role: 'x' }, null], activePerspectiveIds: ['p_a', 42, null] });
    assert.deepEqual(r.matches.map((m) => m.landmarkUid), ['a']);
    assert.deepEqual(r.activePerspectiveIds, ['p_a']);
  });
  it('degrades on null/empty', () => {
    const r = resolveInteraction(raw(), {});
    assert.equal(r.resolutionStatus, 'miss');
    assert.equal(r.groundId, null);
  });

  // Integration: the resolver's output is a valid C0 input — this is the "feeds C0" contract.
  it('a resolved HIT classifies as substrate via classifyResolved (FEEDS C0)', () => {
    const r = makeRawInteraction({ interactionKind: 'click', ts: 1, tabId: 1, url: 'https://x.com', target: { tagName: 'button', role: 'button' } });
    const resolved = resolveInteraction(r, { matches: [match('a')], groundId: 'g', activePerspectiveIds: ['p_a'] });
    const cls = classifyResolved(resolved, { groundId: 'g', activePerspectiveIds: ['p_a'] });
    assert.equal(cls.tier, 'substrate');
    assert.equal(cls.primary.landmarkUid, 'a');
  });
});
