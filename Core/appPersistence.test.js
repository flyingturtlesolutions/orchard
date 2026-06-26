// Core/appPersistence.test.js — AP foundation (v2.74.1211): rail pin-sort (AP-1) + the durable configured-app def (AP-4).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRailTree } from './railTree.js';
import { configuredAppDefinition } from './userCatalog.js';
import { isConfiguredDef, normalizeAppDefinition, OVERVIEW_ID } from './appDef.js';
import { builtinApp } from './appCatalog.js';
import { seedInstanceFromPreset } from './presetMemory.js';

describe('railTree — pinned sorts to the top (AP-1)', () => {
  it('a pinned app outranks a more-recently-updated unpinned row', () => {
    const rows = buildRailTree([
      { id: 'a', title: 'Pinned app', appId: 'support', pinned: true, updatedAt: 100 },
      { id: 'b', title: 'Fresh chat', updatedAt: 999 },
    ], { activeId: null });
    assert.equal(rows[0].role, 'overview');     // Overview always first
    assert.equal(rows[1].id, 'a');              // then the pinned app, despite older updatedAt
    assert.equal(rows[1].pinned, true);
    assert.equal(rows[2].id, 'b');
  });
  it('among unpinned, recency still wins', () => {
    const rows = buildRailTree([{ id: 'x', title: 'older', updatedAt: 1 }, { id: 'y', title: 'newer', updatedAt: 2 }]);
    assert.deepEqual(rows.filter((r) => r.role === 'plain').map((r) => r.id), ['y', 'x']);
  });
});

describe('railTree — Overview peek = last active conversation (v2.74.1219)', () => {
  it('the overview peek = the Overview conversation\'s OWN summary, and it is NOT duplicated as a plain row (v2.74.1234)', () => {
    const rows = buildRailTree([
      { id: OVERVIEW_ID, title: 'Overview', updatedAt: 500, summary: 'my last general reply' },
      { id: 'b', title: 'Recent chat', updatedAt: 900, summary: 'the latest direction' },
    ], { activeId: null });
    assert.equal(rows.find((r) => r.role === 'overview').summary, 'my last general reply');   // its OWN last message
    assert.deepEqual(rows.filter((r) => r.role === 'plain').map((r) => r.id), ['b']);          // the Overview conversation is excluded from the plain rows (pin only)
  });
  it('no Overview conversation yet → overview peek null', () => {
    assert.equal(buildRailTree([], {}).find((r) => r.role === 'overview').summary, null);
    assert.equal(buildRailTree([{ id: 'a', title: 'an app chat', updatedAt: 5, summary: 's' }], {}).find((r) => r.role === 'overview').summary, null);
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

describe('§10.1 seed-down — a preset baseline seeds a new instance', () => {
  it('normalizeAppDefinition carries a baseline list, defaulting to []', () => {
    const withBase = normalizeAppDefinition({ id: 'x', name: 'X', seed: 's', baseline: [{ kind: 'delta', body: 'do the thing' }] });
    assert.equal(withBase.baseline.length, 1);
    assert.deepEqual(normalizeAppDefinition({ id: 'y', name: 'Y', seed: 's' }).baseline, []);
  });
  it('the support preset ships baseline rules that seed confirmed/preset-baseline deltas', () => {
    const baseline = builtinApp('support').baseline;
    assert.ok(baseline.length >= 1);                       // the preset authored starting "how to be a good agent" rules
    const seeded = seedInstanceFromPreset([], { baseline });
    assert.equal(seeded.length, baseline.length);
    for (const d of seeded) {
      assert.equal(d.kind, 'delta');
      assert.equal(d.tier, 'confirmed');                   // trusted (from the vetted preset), not yet the instance's own canonical
      assert.equal(d.provenance, 'preset-baseline');
    }
  });
  it('only deltas seed — a belief placed in a baseline is dropped (facts never seed down)', () => {
    const seeded = seedInstanceFromPreset([], { baseline: [{ kind: 'belief', body: 'Acme is enterprise' }, { kind: 'delta', body: 'confirm before closing' }] });
    assert.deepEqual(seeded.map((d) => d.body), ['confirm before closing']);
  });
});
