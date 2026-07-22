// Core/workflowTier.test.js — CD-1a: the headless gate (DESIGN_cadence.md §4.5 / §11.3). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stepTier, workflowTier, runsHeadless } from './workflowTier.js';

const nav = { text: 'open the queue', via: { kind: 'navigate' } };
const pinnedRide = { text: 'read tickets', via: { kind: 'connector' }, clause: { kind: 'ride', capabilityId: 'cap-1', groundId: 'g-1' } };
const looseRide = { text: 'read tickets', via: { kind: 'connector' } };                       // no pinned clause
const branch = { text: 'branch on status', via: { kind: 'branch' } };

describe('workflowTier — stepTier (fail closed)', () => {
  it('a navigate step is headless', () => assert.equal(stepTier(nav), 'sw'));
  it('a PINNED ride/connector step is headless', () => {
    assert.equal(stepTier(pinnedRide), 'sw');
    assert.equal(stepTier({ ...pinnedRide, via: { kind: 'ride' } }), 'sw');
  });
  it('an UNPINNED ride demotes to panel (the SW would need the router)', () => {
    assert.equal(stepTier(looseRide), 'panel');
    assert.equal(stepTier({ ...pinnedRide, clause: { kind: 'ride', capabilityId: 'c' } }), 'panel'); // no groundId
  });
  it('any other / unknown kind is panel — never thrown, never switched exhaustively', () => {
    assert.equal(stepTier(branch), 'panel');
    assert.equal(stepTier({ via: { kind: 'someNewCapability' } }), 'panel');
    assert.equal(stepTier({ via: { kind: null } }), 'panel');
    assert.equal(stepTier(null), 'panel');
    assert.equal(stepTier({}), 'panel');
  });
});

describe('workflowTier — the whole workflow', () => {
  it("'sw' only when EVERY step is headless-safe", () => {
    assert.equal(workflowTier({ steps: [nav, pinnedRide] }), 'sw');
    assert.equal(runsHeadless({ steps: [nav, pinnedRide] }), true);
  });
  it('one non-sw step demotes the whole run', () => {
    assert.equal(workflowTier({ steps: [nav, pinnedRide, branch] }), 'panel');
    assert.equal(workflowTier({ steps: [nav, looseRide] }), 'panel');
    assert.equal(runsHeadless({ steps: [nav, branch] }), false);
  });
  it('no steps → panel (no proven provenance, no promise)', () => {
    assert.equal(workflowTier({ steps: [] }), 'panel');
    assert.equal(workflowTier({}), 'panel');
    assert.equal(workflowTier(null), 'panel');
  });
});
