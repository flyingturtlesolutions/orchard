// Core/userCatalog.test.js — CV-5 (v2.74.1173): user-authored apps.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { slugifyAppId, userAppDefinition, addUserDef, removeUserDef, listUserDefs } from './userCatalog.js';

describe('userCatalog — slugifyAppId', () => {
  it('namespaces + slugifies a name; empty when nothing usable', () => {
    assert.equal(slugifyAppId('Invoice Watcher!'), 'user-invoice-watcher');
    assert.equal(slugifyAppId('  Café №1  '), 'user-caf-1');
    assert.equal(slugifyAppId('***'), '');
    assert.equal(slugifyAppId(''), '');
  });
});

describe('userCatalog — userAppDefinition', () => {
  it('assembles a normalized source:user def from a name + seed', () => {
    const def = userAppDefinition({ name: 'Invoice Watcher', seed: 'Watch my invoices and flag overdue ones.', config: { writePolicy: 'never' } });
    assert.equal(def.id, 'user-invoice-watcher');
    assert.equal(def.name, 'Invoice Watcher');
    assert.equal(def.source, 'user');
    assert.equal(def.defaultConfig.writePolicy, 'never');
  });

  it('returns null without a name or a seed', () => {
    assert.equal(userAppDefinition({ name: '', seed: 'x' }), null);
    assert.equal(userAppDefinition({ name: 'X', seed: '   ' }), null);
    assert.equal(userAppDefinition({ name: '***', seed: 'x' }), null);   // no usable id
  });
});

describe('userCatalog — list ops', () => {
  const a = userAppDefinition({ name: 'A', seed: 'do a' });
  const b = userAppDefinition({ name: 'B', seed: 'do b' });

  it('addUserDef appends, and REPLACES a same-id entry (an edit)', () => {
    const one = addUserDef([], a);
    assert.deepEqual(one.map((d) => d.id), ['user-a']);
    const two = addUserDef(one, b);
    assert.deepEqual(two.map((d) => d.id), ['user-a', 'user-b']);
    const edited = addUserDef(two, userAppDefinition({ name: 'A', seed: 'do a BETTER' }));
    assert.equal(edited.length, 2);
    assert.equal(edited.find((d) => d.id === 'user-a').seed, 'do a BETTER');
  });

  it('removeUserDef drops by id; listUserDefs normalizes + filters junk', () => {
    assert.deepEqual(removeUserDef([a, b], 'user-a').map((d) => d.id), ['user-b']);
    assert.deepEqual(listUserDefs([a, null, { id: 'x' /* no name/seed */ }, b]).map((d) => d.id), ['user-a', 'user-b']);
  });
});
