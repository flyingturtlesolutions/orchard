// Core/setupFlow.test.js — AS-2a + AS-4 (v2.74.1241 — sequential multi-connection): the pure setup-flow controller.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { setupStep, startSetup, advanceSetup, bindSetupSlot, setupDone } from './setupFlow.js';

const DEF = { id: 'support', name: 'Support agent', archetype: 'operator' };
const GMAIL = { origin: 'https://mail.google.com', label: 'Gmail' };
const ZD = { origin: 'https://deako.zendesk.com', label: 'Deako Zendesk' };

describe('setupFlow — startSetup', () => {
  it('first step prompts the connections slot (stage "first"), carrying candidates; not done', () => {
    const { spec, step } = startSetup(DEF, { connections: [GMAIL] });
    assert.equal(step.done, false);
    assert.equal(step.slot, 'connections');
    assert.equal(step.stage, 'first');
    assert.equal(step.candidates[0].label, 'Gmail');
    assert.deepEqual(step.connected, []);
    assert.equal(setupDone(spec), false);
  });
});

describe('setupFlow — advanceSetup (the sequential verified loop)', () => {
  it('adds the first verified conn → stage "more" (not done), then a "done" signal banks the config', () => {
    let { spec, step } = startSetup(DEF);
    assert.equal(step.stage, 'first');

    ({ spec, step } = advanceSetup(spec, GMAIL));                 // live side verified Gmail, feeds it back
    assert.equal(step.done, false);
    assert.equal(step.stage, 'more');                            // now offers "add another / done"
    assert.deepEqual(step.connected.map((c) => c.origin), [GMAIL.origin]);

    ({ spec, step } = advanceSetup(spec, ZD));                    // add a second site
    assert.equal(step.stage, 'more');
    assert.deepEqual(step.connected.map((c) => c.origin), [GMAIL.origin, ZD.origin]);

    ({ spec, step } = advanceSetup(spec, { done: true }));        // user is done
    assert.equal(step.done, true);
    assert.deepEqual(step.config.connections.map((c) => c.origin), [GMAIL.origin, ZD.origin]);
    assert.deepEqual(step.config.target, GMAIL);                 // primary = first (back-compat)
    assert.deepEqual(step.config.allowedOrigins, [GMAIL.origin, ZD.origin]);
    assert.equal(step.config.shape.mode, 'interactive');
    assert.equal(setupDone(spec), true);
  });

  it('an already-connected site drops out of the "add another" candidates', () => {
    let { spec, step } = startSetup(DEF, { connections: [GMAIL, ZD] });   // both offered up front
    assert.equal(step.candidates.length, 2);
    ({ spec, step } = advanceSetup(spec, GMAIL));                          // connect Gmail
    assert.equal(step.stage, 'more');
    assert.deepEqual(step.candidates.map((c) => c.origin), [ZD.origin]);  // Gmail no longer offered
  });

  it('"done" before any site is ignored — the first-site step repeats', () => {
    let { spec, step } = startSetup(DEF);
    ({ spec, step } = advanceSetup(spec, { done: true }));
    assert.equal(step.done, false);
    assert.equal(step.stage, 'first');
  });

  it('a bad answer (no origin) is rejected — the same step repeats', () => {
    let { spec, step } = startSetup(DEF);
    ({ spec, step } = advanceSetup(spec, { label: 'no origin' }));
    assert.equal(step.done, false);
    assert.equal(step.stage, 'first');
    assert.deepEqual(step.connected, []);
  });

  it('the bare string "done" also finishes; a no-op once complete', () => {
    let { spec, step } = startSetup(DEF);
    ({ spec, step } = advanceSetup(spec, GMAIL));
    ({ spec, step } = advanceSetup(spec, 'done'));
    assert.equal(step.done, true);
    const after = advanceSetup(spec, ZD);                        // ignored once complete
    assert.equal(after.step.done, true);
    assert.deepEqual(after.step.config.connections.map((c) => c.origin), [GMAIL.origin]);
  });
});

describe('setupFlow — bindSetupSlot (shape override, outside the loop)', () => {
  it('overrides the pre-bound shape without affecting the connection requirement', () => {
    let { spec, step } = startSetup(DEF);
    ({ spec, step } = bindSetupSlot(spec, 'shape', { mode: 'run', subAgents: true }));
    assert.equal(step.done, false);
    assert.equal(step.stage, 'first');                          // shape isn't required → still need a site

    ({ spec, step } = advanceSetup(spec, GMAIL));
    ({ spec, step } = advanceSetup(spec, { done: true }));
    assert.equal(step.done, true);
    assert.equal(step.config.shape.mode, 'run');               // the override survived to the banked config
  });
});

describe('setupFlow — setupStep on a complete spec', () => {
  it('returns done + a non-null config with connections', () => {
    let { spec } = startSetup(DEF);
    ({ spec } = advanceSetup(spec, GMAIL));
    ({ spec } = advanceSetup(spec, { done: true }));
    const step = setupStep(spec);
    assert.equal(step.done, true);
    assert.ok(step.config && step.config.connections.length === 1);
  });
});
