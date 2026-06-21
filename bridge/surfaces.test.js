// bridge/surfaces.test.js — unit tests for the surface registry (docs/DESIGN_surfaces.md §2.2/§8, the keystone).
// ESM (the harness force-loads .js as ESM); default-imports the CJS module. PURE — no host, no spawn.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import sf from './surfaces.cjs';
const { SURFACES, DEFAULT_SURFACE, listSurfaces, surfaceById, isSurfaceId, resolveSurface } = sf;

describe('surfaces — the registry shape', () => {
  it('declares low + high, each with the required config fields, id matching its key', () => {
    for (const key of ['low', 'high']) {
      const s = SURFACES[key];
      assert.ok(s, `${key} surface exists`);
      assert.equal(s.id, key, 'id matches the registry key');
      for (const f of ['label', 'altitude', 'promptKind', 'settingsTier', 'blurb']) {
        assert.equal(typeof s[f], 'string', `${key}.${f} is a string`);
        assert.ok(s[f].length, `${key}.${f} is non-empty`);
      }
    }
  });
  it('both surfaces share the git-free scoped trust posture (settingsTier)', () => {
    assert.equal(SURFACES.low.settingsTier, 'scoped');
    assert.equal(SURFACES.high.settingsTier, 'scoped');   // high is NOT "the terminal with full tools" — same scoped allowlist
  });
  it('DEFAULT_SURFACE is a real surface id (preserves today’s dev-default behavior)', () => {
    assert.ok(isSurfaceId(DEFAULT_SURFACE));
    assert.equal(DEFAULT_SURFACE, 'low');
  });
});

describe('surfaces — lookups', () => {
  it('listSurfaces returns every surface (for the picker)', () => {
    const ids = listSurfaces().map((s) => s.id).sort();
    assert.deepEqual(ids, ['high', 'low']);
  });
  it('surfaceById / isSurfaceId resolve known ids, reject unknown', () => {
    assert.equal(surfaceById('high').id, 'high');
    assert.equal(surfaceById('low').id, 'low');
    assert.equal(surfaceById('bogus'), null);
    assert.equal(surfaceById(null), null);
    assert.equal(isSurfaceId('high'), true);
    assert.equal(isSurfaceId('bogus'), false);
    assert.equal(isSurfaceId(undefined), false);
  });
  it('resolveSurface never throws — unknown / missing degrades to the dev default', () => {
    assert.equal(resolveSurface('high').id, 'high');
    assert.equal(resolveSurface('bogus').id, DEFAULT_SURFACE);
    assert.equal(resolveSurface(null).id, DEFAULT_SURFACE);
    assert.equal(resolveSurface(undefined).id, DEFAULT_SURFACE);
  });
});
