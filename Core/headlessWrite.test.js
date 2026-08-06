// Core/headlessWrite.test.js — headless write + pipelineGate (v2.74.2036).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWriteStep } from './headlessWrite.js';

const CREATE = {
  id: 'shopify_create_customer', name: 'Create', app: 'shopify', method: 'POST',
  endpoint: '/customers.json', origin: 'admin.shopify.com',
  enabled: true, reviewState: 'accepted', write: true,
  reversible: true, outward: false,
  params: [
    { name: 'firstName', type: 'string', required: true },
    { name: 'email', type: 'string' },
  ],
};

const OUTWARD = {
  ...CREATE, id: 'aw_send_sms', name: 'SMS', reversible: false, outward: true, destructive: true,
};

describe('runWriteStep — gate + pin', () => {
  it('no-ops when map ran and every row matched', async () => {
    const r = await runWriteStep({ pinned: { kind: 'write', capabilityId: 'shopify_create_customer' } }, {
      state: { lastMisses: [], lastMapRan: true },
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.noop, true);
    assert.equal(r.state.lastWriteCounts.created, 0);
  });

  it('parks outward / undeclared writes (queued)', async () => {
    const r = await runWriteStep({
      pinned: { kind: 'write', capabilityId: 'aw_send_sms', groundId: 'g1' },
      text: 'send sms',
    }, {
      state: {
        lastMisses: [{ row: { email: 'a@b.co' }, label: 'A' }],
        lastMapLookup: { groundId: 'g1' },
        lastMapLeg: { tool: { writeMap: { aw_send_sms: { email: 'email' } } } },
      },
      readRecipes: async () => [OUTWARD],
      invoke: async () => ({ success: true, value: {} }),
    });
    // destructive → refused, or outward undeclared path → park; never auto-create
    assert.ok(r.park === true || (r.ok === false && /refused/.test(r.error || '')), JSON.stringify(r));
  });

  // v2.74.2043 — `provenance: 'curated'` is NEW and load-bearing here. This test previously passed a recipe with no
  // provenance at all, which now PARKS: unattended write authority is curated-only (see the auto-authority suite
  // below for why). The recipe under test is the shipped catalog entry, so declaring it is the accurate fixture,
  // not a workaround — but note that the assertion changed meaning, from "internal+reversible auto-creates" to
  // "a CURATED internal+reversible write auto-creates".
  it('auto-creates when internal+reversible and params resolve', async () => {
    let invokes = 0;
    const r = await runWriteStep({
      pinned: { kind: 'write', capabilityId: 'shopify_create_customer', groundId: 'g1', system: 'shopify' },
      text: 'create a Shopify customer',
    }, {
      state: {
        lastMisses: [{ row: { firstName: 'Pat', email: 'pat@ex.co' }, label: 'Pat' }],
        lastMapLookup: { groundId: 'g1' },
        lastMapLeg: {
          tool: {
            writeMap: {
              shopify_create_customer: { firstName: 'firstName', email: 'email' },
            },
          },
        },
      },
      readRecipes: async () => [{ ...CREATE, provenance: 'curated' }],
      invoke: async () => { invokes++; return { success: true, value: { id: 1 } }; },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.state.lastWriteCounts.created, 1);
    assert.equal(invokes, 1);
  });
});

// ── v2.74.2043 — the gate seam: shape, honored return, and the fail-safe ──────────────────────────────────────────
//
// The actual gate table THROUGH A LEG (probed, v2.74.2043 — it is stricter than DESIGN_cadence.md §8's wording
// "outward/undeclared → park" suggests, and the difference matters when picking a fixture):
//   reversible:true  outward:false  → safety 'confirm' → auto
//   UNDECLARED (no axes)            → safety 'confirm' → queued   ← the park class
//   reversible:false outward:false  → safety 'confirm' → queued   ← the park class
//   outward:true                    → safety 'gated'   → REFUSED  (recipeToLeg gates it before the axes are read)
//   destructive:true                → safety 'gated'   → REFUSED
// So an outward write can never reach the park/approve path at all — it is refused, which is safer than the doc
// says. `UNDECLARED` below is the fail-closed default that DOES park: "an undeclared write is an unreviewed write."
const QUEUED = { ...CREATE, id: 'zd_add_note', name: 'Add note', reversible: undefined, outward: undefined };

const queuedIO = (reporter, onInvoke) => ({
  state: {
    lastMisses: [{ row: { firstName: 'Pat', email: 'pat@ex.co' }, label: 'Pat' }],
    lastMapLookup: { groundId: 'g1' },
    lastMapLeg: { tool: { writeMap: { zd_add_note: { firstName: 'firstName', email: 'email' } } } },
  },
  readRecipes: async () => [QUEUED],
  invoke: async () => { if (onInvoke) onInvoke(); return { success: true, value: { id: 1 } }; },
  reporter,
  runId: 'run-1',
});
const queuedClause = { pinned: { kind: 'write', capabilityId: 'zd_add_note', groundId: 'g1' }, text: 'add a note' };

describe('runWriteStep — the gate seam (v2.74.2043)', () => {
  it('reports its gate decision on every path so the host can trace it', async () => {
    const parked = await runWriteStep(queuedClause, queuedIO(null));
    assert.equal(parked.gate.decision, 'queued');
    assert.match(parked.gate.why, /boundary|undo|declare/);
    assert.equal(parked.gate.targetId, 'zd_add_note');
  });

  it('passes the preview DIRECTLY, not wrapped — the panel park card reads these keys', async () => {
    let seen = null;
    await runWriteStep(queuedClause, queuedIO({ gate: (p) => { seen = p; return 'park'; } }));
    assert.ok(seen, 'the gate was called');
    assert.equal(seen.preview, undefined, 'must NOT be wrapped in {preview:…}');
    assert.equal(seen.targetId, 'zd_add_note');
    assert.equal(seen.count, 1, 'the human must see how many rows they are approving');
    assert.ok(seen.recipe, 'and what it is called');
  });

  it('HONORS an approving gate — the resume path executes exactly this write', async () => {
    let invokes = 0;
    const r = await runWriteStep(queuedClause, queuedIO({ gate: () => true }, () => { invokes++; }));
    assert.equal(r.park, undefined, 'an approved write must not re-park (the ✓ Approve dead-loop)');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(invokes, 1);
  });

  it('parks on every non-true verdict — the fail-safe is structural', async () => {
    for (const verdict of ['park', false, null, undefined, 'yes', 1]) {
      let invokes = 0;
      const r = await runWriteStep(queuedClause, queuedIO({ gate: () => verdict }, () => { invokes++; }));
      assert.equal(r.park, true, `verdict ${JSON.stringify(verdict)} must park`);
      assert.equal(invokes, 0, 'nothing may be written without an explicit true');
    }
  });

  it('parks when there is no reporter, and when the reporter throws (nobody is watching)', async () => {
    let invokes = 0;
    const none = await runWriteStep(queuedClause, queuedIO(null, () => { invokes++; }));
    assert.equal(none.park, true);
    const boom = await runWriteStep(queuedClause, queuedIO({ gate: () => { throw new Error('x'); } }, () => { invokes++; }));
    assert.equal(boom.park, true);
    assert.equal(invokes, 0);
  });

  it('an approved write reaches the executor as a HUMAN act, not a machine-cleared one', async () => {
    let seen = null;
    await runWriteStep(queuedClause, {
      ...queuedIO({ gate: () => true }),
      invoke: async (payload) => { seen = payload; return { success: true, value: { id: 1 } }; },
    });
    assert.ok(seen, 'the executor was reached');
    assert.equal(seen.confirmed, true, 'a person cleared this write');
    assert.equal(seen.gateCleared, undefined);
  });

  it('a REFUSED write is never reachable by approval', async () => {
    let invokes = 0;
    const r = await runWriteStep(
      { pinned: { kind: 'write', capabilityId: 'aw_send_sms', groundId: 'g1' }, text: 'sms' },
      { ...queuedIO({ gate: () => true }, () => { invokes++; }), readRecipes: async () => [OUTWARD] },
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /write-refused/);
    assert.equal(invokes, 0, 'a destructive leg cannot be approved through this path at all');
  });
});

// ── v2.74.2043 — the AUTO path finally reaches the executor, and only for curated recipes ─────────────────────────
const CURATED = { ...CREATE, provenance: 'curated' };

const autoIO = (recipes, onPayload) => ({
  state: {
    lastMisses: [{ row: { firstName: 'Pat', email: 'pat@ex.co' }, label: 'Pat' }],
    lastMapLookup: { groundId: 'g1' },
    lastMapLeg: { tool: { writeMap: { shopify_create_customer: { firstName: 'firstName', email: 'email' } } } },
  },
  readRecipes: async () => recipes,
  invoke: async (payload) => { if (onPayload) onPayload(payload); return { success: true, value: { id: 1 } }; },
  reporter: null,          // NOBODY is watching — this is the unattended path by construction
  runId: 'run-auto',
});
const autoClause = { pinned: { kind: 'write', capabilityId: 'shopify_create_customer', groundId: 'g1', system: 'shopify' }, text: 'create customers' };

describe('runWriteStep — unattended AUTO authority (v2.74.2043)', () => {
  it('a CURATED internal+reversible write clears the gate and reaches the executor stamped gateCleared', async () => {
    let seen = null;
    const r = await runWriteStep(autoClause, autoIO([CURATED], (p) => { seen = p; }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.gate.decision, 'auto');
    assert.equal(r.state.lastWriteCounts.created, 1);
    assert.ok(seen, 'the executor was reached with no human present');
    assert.equal(seen.gateCleared, true, 'the belt needs this or it answers write-needs-confirm');
    assert.equal(seen.confirmed, undefined, 'no person clicked — it must not claim one did');
  });

  it('a HARVESTED recipe with identical axes PARKS instead — unattended authority is curated-only', async () => {
    let invokes = 0;
    const r = await runWriteStep(autoClause, autoIO([{ ...CREATE, provenance: 'harvested' }], () => { invokes++; }));
    assert.equal(r.park, true, 'it parks for a human rather than firing');
    assert.equal(r.gate.decision, 'queued');
    assert.match(r.gate.why, /curated/);
    assert.equal(invokes, 0, 'nothing was written');
  });

  it('a recipe with NO provenance parks too (fail closed — legacy records are not curated by default)', async () => {
    const r = await runWriteStep(autoClause, autoIO([CREATE]));
    assert.equal(r.park, true);
    assert.match(r.gate.why, /provenance/);
  });

  it('a demonstrated recipe cannot talk its way past provenance with friendly axes', async () => {
    const r = await runWriteStep(autoClause, autoIO([{ ...CREATE, provenance: 'demonstrated', reversible: true, outward: false }]));
    assert.equal(r.park, true);
  });

  it('the curated auto path still respects the destructive refusal', async () => {
    let invokes = 0;
    const r = await runWriteStep(
      { pinned: { kind: 'write', capabilityId: 'aw_send_sms', groundId: 'g1' }, text: 'sms' },
      { ...autoIO([{ ...OUTWARD, provenance: 'curated' }], () => { invokes++; }) },
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /write-refused/);
    assert.equal(invokes, 0, 'curated provenance is a necessary condition, never a sufficient one');
  });
});
