// Core/appPersistence.test.js — AP foundation (v2.74.1211): drawer pin-sort (AP-1) + the durable configured-app def (AP-4).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDrawerTree } from './drawerTree.js';
import { configuredAppDefinition } from './userCatalog.js';
import { isConfiguredDef, normalizeAppDefinition } from './appDef.js';

describe('drawerTree — pinned sorts to the top (AP-1)', () => {
  it('a pinned app outranks a more-recently-updated unpinned row', () => {
    const rows = buildDrawerTree([
      { id: 'a', title: 'Pinned app', appId: 'support', pinned: true, updatedAt: 100 },
      { id: 'b', title: 'Fresh chat', updatedAt: 999 },
    ], { activeId: null });
    assert.equal(rows[0].role, 'overview');     // Overview always first
    assert.equal(rows[1].id, 'a');              // then the pinned app, despite older updatedAt
    assert.equal(rows[1].pinned, true);
    assert.equal(rows[2].id, 'b');
  });
  it('among unpinned, recency still wins', () => {
    const rows = buildDrawerTree([{ id: 'x', title: 'older', updatedAt: 1 }, { id: 'y', title: 'newer', updatedAt: 2 }]);
    assert.deepEqual(rows.filter((r) => r.role === 'plain').map((r) => r.id), ['y', 'x']);
  });
});

describe('userCatalog — configuredAppDefinition (AP-4 durable configured app)', () => {
  const setup = { target: { origin: 'https://acme.zendesk.com', label: 'acme.zendesk.com' } };
  it('carries type + setup + presetId + instanceId, with a name+site-unique id', () => {
    const def = configuredAppDefinition({ name: 'Support agent', seed: 'help customers', type: 'inbox', setup, presetId: 'support', instanceId: 'inst-1' });
    assert.ok(def);
    assert.equal(def.type, 'inbox');
    assert.equal(def.presetId, 'support');
    assert.equal(def.instanceId, 'inst-1');
    assert.deepEqual(def.setup, setup);
    assert.match(def.id, /acme/);               // the id folds in the site so two configs of one preset don't collide
    assert.equal(isConfiguredDef(def), true);
  });
  it('a bare preset / seed-only def is NOT configured (so it still routes to setup)', () => {
    assert.equal(isConfiguredDef(normalizeAppDefinition({ id: 'support', name: 'Support', seed: 's', type: 'inbox' })), false);
    assert.equal(configuredAppDefinition({ name: '', seed: 's' }), null);
  });
});
