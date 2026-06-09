// Core/interactionCapture.test.js — C2a pure capture core (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeRawInteraction, domEventToKind, isSensitiveTarget, toCaptureTargets } from './interactionCapture.js';

describe('domEventToKind — DOM type → bounded interactionKind', () => {
  it('maps the captured DOM events', () => {
    assert.equal(domEventToKind('click'), 'click');
    assert.equal(domEventToKind('auxclick'), 'click');
    assert.equal(domEventToKind('dblclick'), 'dblclick');
    assert.equal(domEventToKind('input'), 'type');
    assert.equal(domEventToKind('submit'), 'submit');
    assert.equal(domEventToKind('focusin'), 'focus');
    assert.equal(domEventToKind('focusout'), 'blur');
  });
  it('drops high-frequency / unknown events → null', () => {
    assert.equal(domEventToKind('mousemove'), null);
    assert.equal(domEventToKind('scroll'), null);
    assert.equal(domEventToKind(''), null);
    assert.equal(domEventToKind(undefined), null);
  });
});

describe('isSensitiveTarget', () => {
  it('flags password / sensitive-autocomplete / password-role; passes plain fields', () => {
    assert.equal(isSensitiveTarget({ type: 'password' }), true);
    assert.equal(isSensitiveTarget({ inputType: 'password' }), true);
    assert.equal(isSensitiveTarget({ autocomplete: 'one-time-code' }), true);
    assert.equal(isSensitiveTarget({ autocomplete: 'current-password' }), true);
    assert.equal(isSensitiveTarget({ role: 'password-input' }), true);
    assert.equal(isSensitiveTarget({ type: 'text' }), false);
    assert.equal(isSensitiveTarget({}), false);
  });
});

describe('makeRawInteraction — shaping + PRIVACY invariant', () => {
  it('shapes a click with target + click sub-record + schema/id/ts', () => {
    const r = makeRawInteraction({
      interactionKind: 'click', ts: 100, tabId: 7, frameId: 0, url: 'https://x.com/a',
      target: { tagName: 'BUTTON', id: 'go', role: 'button', accessibleName: 'Search' },
      click: { button: 0, clientX: 5, clientY: 6, modifiers: ['shift'] },
    });
    assert.equal(r.interactionKind, 'click');
    assert.equal(r.target.tagName, 'button');         // lowercased
    assert.deepEqual(r.click, { button: 0, clientX: 5, clientY: 6, modifiers: ['shift'] });
    assert.equal(r.schema, 1);
    assert.ok(typeof r.id === 'string' && r.id.length);
  });
  it('rejects an unknown interactionKind → null', () => {
    assert.equal(makeRawInteraction({ interactionKind: 'teleport', ts: 1, tabId: 1 }), null);
    assert.equal(makeRawInteraction({}), null);
  });
  it('NEVER carries a typed value — only inputType + lengthDelta (privacy invariant)', () => {
    const r = makeRawInteraction({
      interactionKind: 'type', ts: 1, tabId: 1,
      target: { tagName: 'input', type: 'text' },
      type: { inputType: 'insertText', lengthDelta: 3, value: 'TOPSECRET' },
    });
    assert.deepEqual(r.type, { inputType: 'insertText', lengthDelta: 3 });
    assert.equal(r.type.value, undefined);
    assert.ok(!JSON.stringify(r).includes('TOPSECRET'));   // the value leaked nowhere
  });
  it('strips even lengthDelta for a sensitive (password) field', () => {
    const r = makeRawInteraction({
      interactionKind: 'type', ts: 1, tabId: 1,
      target: { tagName: 'input', type: 'password' },
      type: { inputType: 'insertText', lengthDelta: 9 },
    });
    assert.equal(r.type.inputType, 'insertText');
    assert.equal(r.type.lengthDelta, undefined);          // length withheld for sensitive fields
  });
  it('caps classList (8) + truncates accessibleName (120) + id (64)', () => {
    const r = makeRawInteraction({
      interactionKind: 'click', ts: 1, tabId: 1,
      target: { tagName: 'div', id: 'x'.repeat(200), classList: Array.from({ length: 20 }, (_, i) => `c${i}`), accessibleName: 'n'.repeat(300) },
    });
    assert.equal(r.target.classList.length, 8);
    assert.equal(r.target.accessibleName.length, 120);
    assert.equal(r.target.id.length, 64);
  });
  it('mints a fresh evt_ id; an explicit id passes through unchanged', () => {
    const r = makeRawInteraction({ interactionKind: 'submit', ts: 5, tabId: 2, frameId: 1, target: { tagName: 'form' } });
    assert.match(r.id, /^evt_/);                          // a unique event id (mintEventId — not reproducible by design)
    assert.equal(makeRawInteraction({ interactionKind: 'click', ts: 1, tabId: 1, id: 'evt_fixed' }).id, 'evt_fixed');
  });
  it('navigate carries to/from/transition (browser-tier, no landmark)', () => {
    const r = makeRawInteraction({ interactionKind: 'navigate', ts: 1, tabId: 1, navigate: { fromUrl: 'https://a', toUrl: 'https://b', transitionType: 'link' } });
    assert.deepEqual(r.navigate, { toUrl: 'https://b', fromUrl: 'https://a', transitionType: 'link' });
  });
});

describe('toCaptureTargets — enrich C1 demand with selectors for the live hit-test', () => {
  const demand = [
    { landmarkUid: 'lm_q', interactionKinds: ['focus', 'type'] },
    { landmarkUid: 'lm_go', interactionKinds: ['click'] },
    { landmarkUid: 'lm_orphan', interactionKinds: ['click'] },   // no selector → dropped
  ];
  it('joins selectors (Map or object); drops landmarks with no selector', () => {
    const out = toCaptureTargets(demand, { lm_q: '#q', lm_go: 'button.go' });
    assert.deepEqual(out, [
      { landmarkUid: 'lm_q', selector: '#q', interactionKinds: ['focus', 'type'] },
      { landmarkUid: 'lm_go', selector: 'button.go', interactionKinds: ['click'] },
    ]);
  });
  it('accepts a Map and tolerates empty/malformed', () => {
    assert.equal(toCaptureTargets(demand, new Map([['lm_go', 'b']])).length, 1);
    assert.deepEqual(toCaptureTargets(null, {}), []);
    assert.deepEqual(toCaptureTargets(demand, null), []);
  });
});
