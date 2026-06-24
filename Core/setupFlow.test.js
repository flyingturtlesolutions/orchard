// Core/setupFlow.test.js — AS-2a (v2.74.1188): the pure setup-flow controller.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { setupStep, startSetup, advanceSetup, bindSetupSlot, setupDone } from './setupFlow.js';

const DEF = { id: 'support', name: 'Support agent', archetype: 'operator' };

describe('setupFlow — startSetup', () => {
  it('first step prompts the target slot (shape is pre-bound), not done, carrying candidates', () => {
    const { spec, step } = startSetup(DEF, { connections: [{ origin: 'https://mail.google.com', label: 'Gmail' }] });
    assert.equal(step.done, false);
    assert.equal(step.slot, 'target');
    assert.equal(step.kind, 'target');
    assert.equal(step.candidates.length, 1);
    assert.equal(step.candidates[0].label, 'Gmail');
    assert.equal(setupDone(spec), false);
  });
});

describe('setupFlow — advanceSetup (the progressive walk)', () => {
  it('walks target → focus → done, banking the config at the end', () => {
    let { spec, step } = startSetup(DEF);
    assert.equal(step.slot, 'target');

    ({ spec, step } = advanceSetup(spec, { origin: 'https://mail.google.com', label: 'Gmail' }));
    assert.equal(step.done, false);
    assert.equal(step.slot, 'focus');                       // advanced to the next required slot

    ({ spec, step } = advanceSetup(spec, 'open tickets'));
    assert.equal(step.done, true);
    assert.equal(step.config.target.label, 'Gmail');
    assert.deepEqual(step.config.allowedOrigins, ['https://mail.google.com']);
    assert.equal(step.config.focus, 'open tickets');
    assert.equal(step.config.shape.mode, 'interactive');    // operator template carried through
    assert.equal(setupDone(spec), true);
  });

  it('a bad answer is rejected — the same step repeats (slot stays unbound)', () => {
    let { spec, step } = startSetup(DEF);
    ({ spec, step } = advanceSetup(spec, { label: 'no origin' }));   // target needs an origin
    assert.equal(step.done, false);
    assert.equal(step.slot, 'target');                      // still on target
  });

  it('is a no-op once complete', () => {
    let { spec, step } = startSetup(DEF);
    ({ spec } = advanceSetup(spec, { origin: 'https://x.com' }));
    ({ spec } = advanceSetup(spec, 'focus'));
    const after = advanceSetup(spec, 'ignored');
    assert.equal(after.step.done, true);
    assert.equal(after.step.config.focus, 'focus');         // unchanged
  });
});

describe('setupFlow — bindSetupSlot (explicit / out-of-walk bind)', () => {
  it('overrides the pre-bound shape without affecting required-slot completion', () => {
    let { spec, step } = startSetup(DEF);
    ({ spec, step } = bindSetupSlot(spec, 'shape', { mode: 'run', subAgents: true }));
    assert.equal(step.done, false);                         // shape isn't required → still need target+focus
    assert.equal(step.slot, 'target');

    ({ spec } = advanceSetup(spec, { origin: 'https://x.com' }));
    ({ spec, step } = advanceSetup(spec, 'queue'));
    assert.equal(step.done, true);
    assert.equal(step.config.shape.mode, 'run');            // the override survived to the banked config
  });
});

describe('setupFlow — setupStep on a complete spec', () => {
  it('returns done + a non-null config', () => {
    let { spec } = startSetup(DEF);
    ({ spec } = advanceSetup(spec, { origin: 'https://x.com' }));
    ({ spec } = advanceSetup(spec, 'queue'));
    const step = setupStep(spec);
    assert.equal(step.done, true);
    assert.ok(step.config && step.config.target);
  });
});
