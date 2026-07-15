// Core/userCatalog.test.js — CV-5 (v2.74.1173): user-authored apps.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { slugifyAppId, userAppDefinition, configuredAppDefinition, addUserDef, removeUserDef, listUserDefs, galleryUserDefs } from './userCatalog.js';

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

describe('DK-6b (v2.74.1503) — galleryUserDefs ("Your desks" = CUSTOM desks only)', () => {
  const PRE = ['warranty-manager', 'call-manager'];
  const promoted = userAppDefinition({ name: 'My triage', seed: 'triage things' });                        // save as desk: — no presetId
  const configuredCustom = configuredAppDefinition({ name: 'Ops desk', seed: 'run ops', presetId: 'inbox',  // custom flow → generic engine
    setup: { target: { label: 'ops.example.com' } } });
  const configuredPre = configuredAppDefinition({ name: 'Warranty desk', seed: 'warranty role', presetId: 'warranty-manager',
    setup: { target: { label: 'vendorsuite.drhorton.com' } } });                                            // AP-4 copy of a PRECONFIGURED desk
  it('drops the configured copy of a preconfigured desk; keeps promoted seeds + configured customs', () => {
    const out = galleryUserDefs([promoted, configuredCustom, configuredPre], PRE);
    assert.deepEqual(out.map((d) => d.name), ['My triage', 'Ops desk']);   // the Warranty copy is gallery-hidden (legacy id list → hide by preset)
  });
  it('v1517 — name-aware pairs: an EXTENDED variant shows; only the same-name copy hides', () => {
    const PAIRS = [{ id: 'warranty-manager', name: 'Warranty' }];
    const extended = configuredAppDefinition({ name: 'Warranty — Las Vegas', seed: 'warranty role\n\nScope: this desk handles ONLY the Las Vegas division.', presetId: 'warranty-manager',
      setup: { target: { label: 'vendorsuite.drhorton.com' } } });
    const copy = configuredAppDefinition({ name: 'Warranty', seed: 'warranty role', presetId: 'warranty-manager',
      setup: { target: { label: 'vendorsuite.drhorton.com' } } });
    const out = galleryUserDefs([extended, copy, promoted], PAIRS);
    assert.deepEqual(out.map((d) => d.name), ['Warranty — Las Vegas', 'My triage']);   // the variant SHOWS; the true duplicate hides
  });
  it('no preconfigured ids / junk-safe → everything user-made still shows', () => {
    assert.equal(galleryUserDefs([promoted, configuredPre], []).length, 2);   // nothing to hide against
    assert.deepEqual(galleryUserDefs(null, PRE), []);
    assert.equal(galleryUserDefs([null, promoted], PRE).length, 1);
  });
});
