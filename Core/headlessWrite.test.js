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
      readRecipes: async () => [CREATE],
      invoke: async () => { invokes++; return { success: true, value: { id: 1 } }; },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.state.lastWriteCounts.created, 1);
    assert.equal(invokes, 1);
  });
});
