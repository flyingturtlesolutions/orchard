// Core/appCatalog.test.js — CV-3a (v2.74.1164): the builtin AppDefinition catalog.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { builtinApps, builtinApp } from './appCatalog.js';
import { appFromDefinition, normalizeAppDefinition } from './appDef.js';

describe('appCatalog — builtin apps', () => {
  it('every builtin is a valid, normalized AppDefinition (id + name + seed)', () => {
    const apps = builtinApps();
    assert.ok(apps.length >= 6);
    for (const a of apps) {
      assert.ok(a.id && a.name && a.seed, `app ${a.id} missing a required field`);
      assert.deepEqual(normalizeAppDefinition(a), a);            // already normalized → idempotent
      assert.equal(a.source, 'builtin');
    }
  });

  it('ids are unique', () => {
    const ids = builtinApps().map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('the read-only monitors are pinned writePolicy:never; operators/executor are gated', () => {
    assert.equal(builtinApp('financial').defaultConfig.writePolicy, 'never');
    assert.equal(builtinApp('research').defaultConfig.writePolicy, 'never');
    assert.equal(builtinApp('support').defaultConfig.writePolicy, 'gated');
    assert.equal(builtinApp('shopper').defaultConfig.writePolicy, 'gated');
  });

  it('builtinApp resolves by id; null on unknown/empty', () => {
    assert.equal(builtinApp('support').name, 'Support agent');
    assert.equal(builtinApp('nope'), null);
    assert.equal(builtinApp(''), null);
    assert.equal(builtinApp(null), null);
  });

  it('a builtin instantiates into a kind:app conversation with its seed copied (appFromDefinition)', () => {
    const a = appFromDefinition(builtinApp('financial'));
    assert.equal(a.kind, 'app');
    assert.equal(a.appId, 'financial');
    assert.equal(a.config.writePolicy, 'never');                 // the read-only floor carries onto the app
    assert.ok(a.seed.includes('READ ONLY'));
  });
});
