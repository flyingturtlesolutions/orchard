// Core/writeGate.test.js — CV-6 (v2.74.1172): the per-app write gate.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAction, actAllowed } from './writeGate.js';

describe('writeGate — evaluateAction', () => {
  it('writePolicy:never blocks acts + money, allows reads', () => {
    const never = { writePolicy: 'never' };
    assert.equal(evaluateAction(never, { effect: 'act' }).allowed, false);
    assert.equal(evaluateAction(never, { effect: 'money' }).allowed, false);
    assert.equal(evaluateAction(never, { effect: 'read' }).allowed, true);
  });

  it('writePolicy:gated (the default) allows everything — the per-action gates handle confirm/money', () => {
    const gated = { writePolicy: 'gated' };
    assert.equal(evaluateAction(gated, { effect: 'act' }).allowed, true);
    assert.equal(evaluateAction(gated, { effect: 'money' }).allowed, true);
    assert.equal(evaluateAction(gated, { effect: 'read' }).allowed, true);
  });

  it('missing / garbage config normalizes to gated (never accidentally read-only)', () => {
    assert.equal(actAllowed(undefined), true);
    assert.equal(actAllowed(null), true);
    assert.equal(actAllowed({}), true);
    assert.equal(actAllowed({ writePolicy: 'bogus' }), true);
  });

  it('an unknown / absent effect defaults to the STRICT side (act) — so a read-only app is fail-safe', () => {
    assert.equal(evaluateAction({ writePolicy: 'never' }, {}).allowed, false);
    assert.equal(evaluateAction({ writePolicy: 'never' }, { effect: 'whatever' }).allowed, false);
    assert.equal(actAllowed({ writePolicy: 'never' }), false);
  });
});
