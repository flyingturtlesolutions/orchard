// Core/workflowTier.test.js — CD-1a: the headless gate (DESIGN_cadence.md §4.5 / §11.3). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stepTier, workflowTier, runsHeadless, explainTier } from './workflowTier.js';

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

describe('workflowTier — phase 2 extraction 1: the banked field read (v1717)', () => {
  const bankedFieldRead = { text: 'read the instructions of each', via: { kind: 'fieldRead' }, clause: { kind: 'fieldRead', field: 'instructions' } };
  const legacyFieldRead = { text: 'read the instructions of each', via: { kind: 'fieldRead' }, clause: { kind: 'fieldRead' } };
  it('a banked fieldRead AFTER a ride is headless; before any ride (or unbanked) it is panel', () => {
    assert.equal(stepTier(bankedFieldRead, { priorRead: true }), 'sw');
    assert.equal(stepTier(bankedFieldRead, { priorRead: false }), 'panel', 'no rows to read — needs the panel');
    assert.equal(stepTier(bankedFieldRead), 'panel', 'ctx-less default stays fail-closed');
    assert.equal(stepTier(legacyFieldRead, { priorRead: true }), 'panel', 'a legacy pin banked no field phrase');
  });
  it('workflowTier orders the check: ride → fieldRead is sw; fieldRead → ride is panel; nav stocks nothing', () => {
    assert.equal(workflowTier({ steps: [pinnedRide, bankedFieldRead] }), 'sw');
    assert.equal(workflowTier({ steps: [nav, pinnedRide, bankedFieldRead] }), 'sw');
    assert.equal(workflowTier({ steps: [bankedFieldRead, pinnedRide] }), 'panel', 'nothing read yet when it runs');
    assert.equal(workflowTier({ steps: [nav, bankedFieldRead] }), 'panel', 'a nav produces no rows');
    assert.equal(workflowTier({ steps: [pinnedRide, legacyFieldRead] }), 'panel');
  });
});

describe('workflowTier — phase 2: banked map + write (v2.74.2036)', () => {
  const bankedMap = {
    text: 'find in Shopify', via: { kind: 'map' },
    clause: { kind: 'map', capabilityId: 'shopify_find_customer', groundId: 'g-s', valueParam: 'query', system: 'shopify' },
  };
  const bankedWrite = {
    text: 'create customers', via: { kind: 'write' },
    clause: { kind: 'write', capabilityId: 'shopify_create_customer', groundId: 'g-s', system: 'shopify' },
  };
  const bareMap = { text: 'find', via: { kind: 'map' }, clause: { kind: 'map' } };
  it('a banked map after a ride is sw; bare map stays panel', () => {
    assert.equal(stepTier(bankedMap, { priorRead: true }), 'sw');
    assert.equal(stepTier(bankedMap, { priorRead: false }), 'panel');
    assert.equal(stepTier(bareMap, { priorRead: true }), 'panel');
  });
  it('ride → map → write is sw when pins are complete', () => {
    assert.equal(workflowTier({ steps: [pinnedRide, bankedMap, bankedWrite] }), 'sw');
    assert.equal(runsHeadless({ steps: [pinnedRide, bankedMap, bankedWrite] }), true);
  });
  it('ride → bare map demotes the workflow', () => {
    assert.equal(workflowTier({ steps: [pinnedRide, bareMap] }), 'panel');
  });
  // v2.74.2044 — a write's prior read must be a MAP: only runMapStep hydrates the state.lastMisses the SW write
  // runner consumes (a bare ride threads lastValue/lastLeg), so ride→write tiered 'sw' fired forever-'partial'
  // headless (write: no-misses) while the panel due-on-open scan skipped it as SW-owned.
  it('ride → write (no map) demotes — a bare ride does not hydrate the misses a SW write consumes', () => {
    assert.equal(stepTier(bankedWrite, { priorRead: true }), 'panel', 'priorRead alone no longer admits a write');
    assert.equal(stepTier(bankedWrite, { priorRead: true, priorMap: true }), 'sw');
    assert.equal(stepTier(bankedWrite, { priorMap: false }), 'panel');
    assert.equal(workflowTier({ steps: [pinnedRide, bankedWrite] }), 'panel');
    assert.equal(runsHeadless({ steps: [pinnedRide, bankedWrite] }), false);
  });
});

// ── v2.74.2047 — the v2046 'each' demotion is FLIPPED: Core/rideEach.runEachSweep gives the SW the RIDE_EACH
// fan-out, so an each-swept ride pin runs headless again. The residue (an 'each' token on a param whose recipe
// declares no resolve+each spec) fails closed at RUN time in runRideStep (`each-not-sweepable`) — the tier sees
// only the pin, never the recipe, so it cannot make that call here.
describe('workflowTier — an each-swept ride runs headless (v2047 re-promotion)', () => {
  const eachRide = { ...pinnedRide, clause: { kind: 'ride', capabilityId: 'cap-1', groundId: 'g-1', bindings: { divisionId: 'each', status: 'open' } } };
  const literalRide = { ...pinnedRide, clause: { kind: 'ride', capabilityId: 'cap-1', groundId: 'g-1', bindings: { status: 'open' } } };
  it("a ride pin with an 'each' binding is sw (the SW sweeps now); literal bindings unchanged", () => {
    assert.equal(stepTier(eachRide), 'sw');
    assert.equal(stepTier(literalRide), 'sw');
  });
  it('an each-swept workflow fires headless, and explainTier reports no demoting step', () => {
    assert.equal(workflowTier({ steps: [eachRide] }), 'sw');
    assert.equal(runsHeadless({ steps: [eachRide] }), true);
    const e = explainTier({ steps: [eachRide] });
    assert.equal(e.tier, 'sw');
    assert.equal(e.stepIndex, -1);
  });
  it('the sweep stocks prior rows: each-ride → banked fieldRead is sw (the {rows} aggregate is the collection)', () => {
    const bankedFieldRead = { text: 'read the instructions', via: { kind: 'fieldRead' }, clause: { kind: 'fieldRead', field: 'instructions' } };
    assert.equal(workflowTier({ steps: [eachRide, bankedFieldRead] }), 'sw');
  });
  it('an unpinned each-ride still demotes — the flip removed the sweep arm, not the pin requirement', () => {
    const unpinned = { ...pinnedRide, clause: { kind: 'ride', bindings: { divisionId: 'each' } } };
    assert.equal(stepTier(unpinned), 'panel');
    assert.match(explainTier({ steps: [unpinned] }).why, /groundId/);
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

// ── v2.74.2043 — explainTier: the demotion must NAME itself ───────────────────────────────────────────────────────
describe('explainTier — why, not just what', () => {
  const bankedMap = {
    text: 'find in Shopify', via: { kind: 'map' },
    clause: { kind: 'map', capabilityId: 'shopify_find_customer', groundId: 'g-s', valueParam: 'query', system: 'shopify' },
  };
  const bankedWrite = {
    text: 'create customers', via: { kind: 'write' },
    clause: { kind: 'write', capabilityId: 'shopify_create_customer', groundId: 'g-s', system: 'shopify' },
  };
  const bareMap = { text: 'find', via: { kind: 'map' }, clause: { kind: 'map' } };

  it('agrees with workflowTier on every shape it is given', () => {
    const cases = [
      { steps: [nav, pinnedRide] }, { steps: [nav, pinnedRide, branch] }, { steps: [nav, looseRide] },
      { steps: [pinnedRide, bankedMap, bankedWrite] }, { steps: [pinnedRide, bareMap] },
      { steps: [pinnedRide, bankedWrite] },   // v2.74.2044 — ride→write demotes in BOTH views
      { steps: [] }, {}, null,
    ];
    for (const wf of cases) assert.equal(explainTier(wf).tier, workflowTier(wf), JSON.stringify(wf));
  });

  it("a tier-'sw' workflow reports no demoting step", () => {
    const e = explainTier({ steps: [nav, pinnedRide] });
    assert.equal(e.tier, 'sw');
    assert.equal(e.stepIndex, -1);
  });

  it('names the FIRST demoting step, its kind, and the failed predicate', () => {
    const e = explainTier({ steps: [nav, pinnedRide, branch] });
    assert.equal(e.tier, 'panel');
    assert.equal(e.stepIndex, 2, 'the branch is step index 2');
    assert.equal(e.kind, 'branch');
    assert.match(e.why, /no headless runner/);
  });

  it('an unpinned ride says the pin is missing, not that the kind is unknown', () => {
    const e = explainTier({ steps: [looseRide] });
    assert.equal(e.kind, 'connector');
    assert.match(e.why, /no pinned clause/);
  });

  it('a ride pin that lost its groundId names groundId (the v2037 incident class)', () => {
    const e = explainTier({ steps: [{ ...pinnedRide, clause: { kind: 'ride', capabilityId: 'c' } }] });
    assert.match(e.why, /groundId/);
  });

  it('an ordering demotion blames the ordering, not the pin', () => {
    const e = explainTier({ steps: [bankedWrite] });   // write with nothing before it
    assert.equal(e.stepIndex, 0);
    assert.match(e.why, /no prior map/);   // v2.74.2044 — the why names the map, the only misses source
  });

  it('ride → write blames the missing map, not the pin (v2.74.2044)', () => {
    const e = explainTier({ steps: [pinnedRide, bankedWrite] });
    assert.equal(e.tier, 'panel');
    assert.equal(e.stepIndex, 1);
    assert.equal(e.kind, 'write');
    assert.match(e.why, /no prior map/);
  });

  it('an empty workflow explains itself rather than reporting a step', () => {
    const e = explainTier({ steps: [] });
    assert.equal(e.stepIndex, -1);
    assert.match(e.why, /no banked steps/);
  });
});
