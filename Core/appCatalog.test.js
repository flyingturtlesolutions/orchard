// Core/appCatalog.test.js — CV-3a (v2.74.1164); OM refactor v2.74.1198 (abstract types + presets).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { builtinApps, builtinPresets, builtinApp, presetsForType } from './appCatalog.js';
import { appFromDefinition, normalizeAppDefinition, APP_TYPES } from './appDef.js';

describe('appCatalog — the abstract TYPES (what the gallery shows)', () => {
  it('exactly the 3 friendly abstract types, each a valid normalized def with a type + object model', () => {
    const apps = builtinApps();
    assert.deepEqual(apps.map((a) => a.id).sort(), [...APP_TYPES].sort());   // inbox / watcher / concierge
    for (const a of apps) {
      assert.ok(a.id && a.name && a.seed, `type ${a.id} missing a required field`);
      assert.deepEqual(normalizeAppDefinition(a), a);            // already normalized → idempotent
      assert.equal(a.source, 'builtin');
      assert.ok(APP_TYPES.includes(a.type), `type ${a.id} has no app type`);
      assert.ok(a.objectModel && a.objectModel.noun, `type ${a.id} has no object model`);
    }
  });
  it('the friendly names are plain-language (Inbox / Watcher / Concierge)', () => {
    assert.deepEqual(builtinApps().map((a) => a.name).sort(), ['Concierge', 'Inbox', 'Watcher']);
  });
});

describe('appCatalog — the named PRESETS (specializations of a type)', () => {
  it('every preset is valid, carries its type + a BOUND object model (concrete noun)', () => {
    const presets = builtinPresets();
    assert.ok(presets.length >= 6);
    for (const p of presets) {
      assert.ok(p.id && p.name && p.seed);
      assert.ok(APP_TYPES.includes(p.type), `preset ${p.id} missing a type`);
      assert.ok(p.objectModel && p.objectModel.noun, `preset ${p.id} missing a bound object model`);
    }
    assert.equal(builtinApp('support').objectModel.noun, 'ticket');     // inbox preset bound to tickets
    assert.equal(builtinApp('inbox-email').objectModel.noun, 'email');  // inbox preset bound to email
  });

  it('the read-only monitors stay pinned writePolicy:never; operators/executor are gated', () => {
    assert.equal(builtinApp('financial').defaultConfig.writePolicy, 'never');
    assert.equal(builtinApp('research').defaultConfig.writePolicy, 'never');
    assert.equal(builtinApp('support').defaultConfig.writePolicy, 'gated');
    assert.equal(builtinApp('shopper').defaultConfig.writePolicy, 'gated');
  });

  it('transitions are well-formed {verb,to} pairs (the postcondition source)', () => {
    const t = builtinApp('support').objectModel.transitions;
    assert.ok(t.some((x) => x.verb === 'close' && x.to === 'closed'));
  });
});

describe('appCatalog — resolution', () => {
  it('all type + preset ids are unique', () => {
    const ids = [...builtinApps(), ...builtinPresets()].map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('builtinApp resolves a type OR a preset; null on unknown/empty', () => {
    assert.equal(builtinApp('inbox').name, 'Inbox');               // a type
    assert.equal(builtinApp('support').name, 'Support agent');     // a preset
    assert.equal(builtinApp('nope'), null);
    assert.equal(builtinApp(''), null);
    assert.equal(builtinApp(null), null);
  });

  it('presetsForType groups presets under their abstract type', () => {
    assert.deepEqual(presetsForType('inbox').map((p) => p.id).sort(), ['inbox-email', 'support']);
    assert.deepEqual(presetsForType('concierge').map((p) => p.id), ['shopper']);
  });

  it('a builtin instantiates into a kind:app conversation with its seed copied (appFromDefinition)', () => {
    const a = appFromDefinition(builtinApp('financial'));
    assert.equal(a.kind, 'app');
    assert.equal(a.appId, 'financial');
    assert.equal(a.config.writePolicy, 'never');                   // the read-only floor carries onto the app
    assert.ok(a.seed.includes('READ ONLY'));
  });
});
