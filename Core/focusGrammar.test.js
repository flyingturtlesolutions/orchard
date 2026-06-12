// Core/focusGrammar.test.js — FM-1: the pure focus-grab decision (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { focusDecision, FOCUS_SETTING_KEY, FOCUS_SETTING_VALUES } from './focusGrammar.js';

describe('focusGrammar — focusDecision (FM-1)', () => {
  it('already-active wins over everything (required AND courtesy): never re-grab a focused tab', () => {
    assert.equal(focusDecision('auto', { alreadyActive: true }), 'skip-active');
    assert.equal(focusDecision('never', { alreadyActive: true, required: true }), 'skip-active');
  });

  it('REQUIRED grabs land regardless of the setting (a teach step drives the ACTIVE tab)', () => {
    assert.equal(focusDecision('never', { required: true }), 'focus');
    assert.equal(focusDecision('ask', { required: true }), 'focus');
    assert.equal(focusDecision('auto', { required: true }), 'focus');
  });

  it('COURTESY grabs obey the setting: auto → focus, never → suppressed, ask → deferred (FM-2 invite)', () => {
    assert.equal(focusDecision('auto', {}), 'focus');
    assert.equal(focusDecision('never', {}), 'suppressed-setting');
    assert.equal(focusDecision('ask', {}), 'deferred-ask');
  });

  it('unknown / missing setting falls back to auto (a half-written setting must not silently kill summons)', () => {
    assert.equal(focusDecision(undefined, {}), 'focus');
    assert.equal(focusDecision('banana', {}), 'focus');
    assert.equal(focusDecision('', {}), 'focus');
  });

  it('contract constants are stable (the handler + settings UI key on these)', () => {
    assert.equal(FOCUS_SETTING_KEY, 'autoFocus');
    assert.deepEqual(FOCUS_SETTING_VALUES, ['auto', 'ask', 'never']);
  });
});
