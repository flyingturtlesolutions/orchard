// Core/connectorParity.test.js — v2.74.1342 (review K): parity locks for connector contract drift. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BROKER_CATALOG } from './brokerCatalog.js';
import { providerScopes } from './mcpServers.js';
import { legRef } from './legRef.js';
import { route } from './route.js';
import { fillWriteBody } from './recipeFromObservedWrite.js';

describe('connector parity — catalog ↔ scopes ↔ legRef ↔ write bodies', () => {
  it('v1342: google-gmail is absent from the broker catalog (no working channel yet)', () => {
    assert.ok(!BROKER_CATALOG.some((c) => c.server === 'google-gmail'));
    assert.ok(!providerScopes('google').some((s) => s.includes('gmail')));
  });

  it('legRef resolves a connector leg by key (route anti-hallucination contract)', async () => {
    const leg = { key: 'me.google-calendar.list_events', name: 'List events', capabilityId: 'ignored' };
    const out = await route('list my events', {
      retrieveTools: async () => [leg],
      callRouter: async () => ({ tool: 'me.google-calendar.list_events', confidence: 0.9, params: {} }),
    });
    assert.equal(out.action, 'replay');
    assert.equal(legRef(out.tool), legRef(leg));
  });

  it('fillWriteBody honors form bodyType + contentType (header-replay write contract)', () => {
    const r = fillWriteBody({ bodyType: 'form', contentType: 'application/x-www-form-urlencoded', body: { public: '{public}', body: '{body}' } }, { public: 'false', body: 'hi' });
    assert.equal(r.contentType, 'application/x-www-form-urlencoded');
    assert.match(r.body, /public=false/);
    assert.match(r.body, /body=hi/);
  });

  it('broker catalog write tools stay paired with readOnlyHint absence (seed sanity)', () => {
    for (const entry of BROKER_CATALOG) {
      for (const t of (entry.tools || [])) {
        if (t.annotations?.destructiveHint) assert.equal(t.annotations.readOnlyHint, undefined);
      }
    }
  });
});
