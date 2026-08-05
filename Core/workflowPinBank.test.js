// Core/workflowPinBank.test.js — pin-bank cause diagnostics (v2.74.2038). Characterizes TODAY's assign.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WARRANTY_SUBASKS, pickRanStep, ranPresence, evaluatePinBank, refinePinBankAfterStore,
} from './workflowPinBank.js';
import { pinnedClause } from './workflowWizard.js';
import { normalizeWorkflow } from './workflowMemory.js';
import { workflowTier, stepTier } from './workflowTier.js';

const SUB = WARRANTY_SUBASKS;

const rideOk = {
  kind: 'connector', capabilityId: 'vs_warranty_tasks', groundId: 'g-vs',
  clause: SUB[0], intent: 'List warranty tasks',
};
const mapOk = {
  kind: 'map', capabilityId: 'shopify_find_customer', groundId: 'g-sh', valueParam: 'query',
  clause: SUB[1], intent: SUB[1], system: 'shopify',
};
const writeOk = {
  kind: 'write', capabilityId: 'shopify_create_customer', groundId: 'g-sh',
  clause: SUB[2], intent: SUB[2], system: 'shopify',
};

describe("pickRanStep — today's index-then-find", () => {
  it('index wins when slot i is occupied (even wrong kind)', () => {
    const ran = [mapOk, rideOk, writeOk];
    assert.equal(pickRanStep(ran, SUB[0], 0).kind, 'map', 'index 0 is map, not the ride that matches SUB[0] text');
  });
  it('find by clause text when index slot is empty', () => {
    const ran = [];
    ran[1] = mapOk;
    assert.equal(pickRanStep(ran, SUB[1], 1).kind, 'map');
    assert.equal(pickRanStep(ran, SUB[0], 0), null, 'no index0 and no clause match for SUB[0]');
  });
  it('intent-only leg name does not match subask text', () => {
    const ran = [{ kind: 'connector', capabilityId: 'c', groundId: 'g', clause: '', intent: 'List warranty tasks' }];
    assert.equal(pickRanStep(ran, SUB[0], 0).intent, 'List warranty tasks', 'index still returns it');
    const sparse = [];
    sparse[0] = undefined;
    // when index empty: find compares clause||intent === text — intent alone matching subask would need equality
    sparse[1] = { kind: 'connector', capabilityId: 'c', groundId: 'g', intent: 'List warranty tasks' };
    assert.equal(pickRanStep(sparse, SUB[0], 0), null, 'leg display name ≠ subask → find misses');
  });
});

describe('pinnedClause — empty valueParam footgun (C1)', () => {
  it('omits empty valueParam', () => {
    const p = pinnedClause({ kind: 'map', capabilityId: 'x', groundId: 'g', valueParam: '' });
    assert.equal('valueParam' in p, false);
  });
  it('keeps nonempty map fields', () => {
    const p = pinnedClause({
      kind: 'map', capabilityId: 'shopify_find_customer', groundId: 'g-sh', valueParam: 'query', system: 'shopify',
    });
    assert.equal(p.valueParam, 'query');
    assert.equal(p.groundId, 'g-sh');
    assert.equal(p.capabilityId, 'shopify_find_customer');
  });
});

describe('evaluatePinBank — refuse codes', () => {
  it('B — empty ranSteps → no-ranSteps', () => {
    assert.equal(evaluatePinBank({ subasks: SUB, ranSteps: [] }).refuse, 'no-ranSteps');
    assert.equal(evaluatePinBank({ subasks: SUB, ranSteps: null }).refuse, 'no-ranSteps');
  });
  it('typo signature — empty asks + nonempty ran → no-ranSteps with full ranPresence', () => {
    // Mirrors chat reading wf.subasks (missing) while ranSteps landed: not true-B (empty ran).
    const d = evaluatePinBank({ subasks: [], ranSteps: [rideOk, mapOk, writeOk] });
    assert.equal(d.refuse, 'no-ranSteps');
    assert.match(d.ranPresence, /ride:c:\+g:\+/);
    assert.match(d.ranPresence, /map:c:\+g:\+v:\+/);
  });
  it('happy path → ok-ready + tier sw', () => {
    const d = evaluatePinBank({ subasks: SUB, ranSteps: [rideOk, mapOk, writeOk] });
    assert.equal(d.refuse, 'ok-ready');
    assert.equal(d.tier, 'sw');
    assert.match(d.ranPresence, /ride:c:\+g:\+/);
    assert.match(d.ranPresence, /map:c:\+g:\+v:\+/);
  });
  it('C1 — map missing valueParam → map-fields', () => {
    const map = { ...mapOk, valueParam: '' };
    const d = evaluatePinBank({ subasks: SUB, ranSteps: [rideOk, map, writeOk] });
    assert.equal(d.refuse, 'map-fields');
  });
  it('C1 — map missing groundId → map-fields', () => {
    const map = { kind: 'map', capabilityId: 'shopify_find_customer', valueParam: 'query', clause: SUB[1] };
    assert.equal(evaluatePinBank({ subasks: SUB, ranSteps: [rideOk, map, writeOk] }).refuse, 'map-fields');
  });
  it('C1 — map missing capabilityId → map-fields', () => {
    const map = { kind: 'map', groundId: 'g-sh', valueParam: 'query', clause: SUB[1] };
    assert.equal(evaluatePinBank({ subasks: SUB, ranSteps: [rideOk, map, writeOk] }).refuse, 'map-fields');
  });
  it('D — ride missing groundId → ride-incomplete', () => {
    const ride = { kind: 'connector', capabilityId: 'vs_warranty_tasks', clause: SUB[0] };
    assert.equal(evaluatePinBank({ subasks: SUB, ranSteps: [ride, mapOk, writeOk] }).refuse, 'ride-incomplete');
  });
  it('E — recordExists false / other-only → update-miss', () => {
    const base = { subasks: SUB, ranSteps: [rideOk, mapOk, writeOk] };
    assert.equal(evaluatePinBank({ ...base, recordExists: false }).refuse, 'update-miss');
    assert.equal(evaluatePinBank({ ...base, recordExists: 'other-only' }).refuse, 'update-miss');
  });
  it('C2 signal — index-wrong-kind: map at [0] yields map on step0 / ride gate or map-fields on step1', () => {
    // Characterization: index wins → step0 is map; step1 gets ride by index — map pin may still exist on steps[0]
    const d = evaluatePinBank({ subasks: SUB, ranSteps: [mapOk, rideOk, writeOk] });
    // hasMapPin true (step0), hasRidePin true (step1) → may be ok-ready even though order is wrong for priorRead
    assert.ok(['ok-ready', 'tier-panel', 'map-fields', 'ride-incomplete'].includes(d.refuse), d.refuse);
    assert.equal(d.steps[0].clause.kind, 'map');
    assert.equal(d.steps[1].via.kind, 'connector');
    // tier: map before ride → priorRead false for map → panel
    assert.equal(d.tier, 'panel');
    assert.equal(d.refuse, 'tier-panel');
  });
});

describe('refinePinBankAfterStore', () => {
  const ready = evaluatePinBank({ subasks: SUB, ranSteps: [rideOk, mapOk, writeOk] });
  it('ok-ready + missing stored → update-miss', () => {
    assert.equal(refinePinBankAfterStore(ready, null).refuse, 'update-miss');
  });
  it('ok-ready + stored without clauses → normalize-dropped', () => {
    const stored = normalizeWorkflow({
      ask: 'sync', subAsks: SUB, status: 'ready',
      steps: SUB.map((t) => ({ text: t, via: { kind: null } })),
    });
    assert.equal(refinePinBankAfterStore(ready, stored).refuse, 'normalize-dropped');
  });
  it('ok-ready + stored full pins → ok', () => {
    const stored = normalizeWorkflow({
      ask: 'sync', subAsks: SUB, status: 'ready', schema: 2,
      steps: ready.steps,
    });
    const r = refinePinBankAfterStore(ready, stored);
    assert.equal(r.refuse, 'ok');
    assert.equal(r.tier, 'sw');
    assert.ok(r.storedPinned >= 2);
  });
});

describe('normalize — map pin round-trip (F guard)', () => {
  it('map valueParam/groundId/capabilityId survive normalizeWorkflow', () => {
    const payload = {
      ask: 'sync new warranty homeowners into Shopify customers',
      subAsks: SUB.slice(),
      status: 'ready',
      schema: 2,
      steps: [
        { text: SUB[0], via: { kind: 'connector' }, clause: { kind: 'connector', capabilityId: 'vs_warranty_tasks', groundId: 'g-vs' } },
        { text: SUB[1], via: { kind: 'map' }, clause: { kind: 'map', capabilityId: 'shopify_find_customer', groundId: 'g-sh', valueParam: 'query', system: 'shopify' } },
        { text: SUB[2], via: { kind: 'write' }, clause: { kind: 'write', capabilityId: 'shopify_create_customer', groundId: 'g-sh', system: 'shopify' } },
      ],
    };
    const w = normalizeWorkflow(payload);
    assert.ok(w, `normalizeWorkflow returned null for ask=${JSON.stringify(payload.ask)} subAsks=${payload.subAsks.length}`);
    assert.equal(w.steps[1].clause.valueParam, 'query');
    assert.equal(w.steps[1].clause.groundId, 'g-sh');
    const again = normalizeWorkflow(w);
    assert.equal(again.steps[1].clause.valueParam, 'query');
  });
});

describe('workflowTier — incomplete pins → panel (G guards)', () => {
  const ride = { text: 'r', via: { kind: 'connector' }, clause: { kind: 'connector', capabilityId: 'c', groundId: 'g' } };
  it('map without valueParam is panel even with priorRead', () => {
    const map = { text: 'm', via: { kind: 'map' }, clause: { kind: 'map', capabilityId: 'c', groundId: 'g' } };
    assert.equal(stepTier(map, { priorRead: true }), 'panel');
    assert.equal(workflowTier({ steps: [ride, map] }), 'panel');
  });
  it('ride without groundId is panel', () => {
    const loose = { text: 'r', via: { kind: 'connector' }, clause: { kind: 'connector', capabilityId: 'c' } };
    assert.equal(stepTier(loose), 'panel');
  });
});

describe('ranPresence — body-blind', () => {
  it('marks missing bits with !', () => {
    const s = ranPresence([{ kind: 'map', capabilityId: 'x', groundId: 'g' }]);
    assert.equal(s, 'map:c:+g:+v:!');
  });
});
