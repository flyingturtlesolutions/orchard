// Core/setupSpec.test.js — AS-1 + AS-4 (v2.74.1241 — sequential multi-connection): the per-app setup spec.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SETUP_KINDS, SHAPE_MODES, archetypeShape, normalizeSlotValue, buildSetupSpec, normalizeSetupSpec,
  bindSlot, nextUnboundSlot, isSetupComplete, specToConfig, addConnection, removeConnection, markSetupDone, connectionsOf,
  originFromText,
} from './setupSpec.js';

const DEF = { id: 'support', name: 'Support agent', archetype: 'operator' };
const GMAIL = { origin: 'https://mail.google.com', label: 'Gmail' };
const ZD = { origin: 'https://deako.zendesk.com', label: 'Deako Zendesk' };

describe('setupSpec — originFromText (review P1-6: the host-shape floor)', () => {
  it('a bare word (no TLD) is REJECTED — the "gmail" trap that banked https://gmail', () => {
    assert.equal(originFromText('gmail'), null);
    assert.equal(originFromText('help'), null);
    assert.equal(originFromText('done!'), null);
    assert.equal(originFromText('https://gmail'), null);          // even an explicit dotless https origin
    assert.equal(originFromText('http://intranet'), null);
  });
  it('a whole sentence is rejected (a space is not a valid host char)', () => {
    assert.equal(originFromText('please connect my gmail'), null);
  });
  it('a real dotted host passes (with/without scheme, www stripped for the label)', () => {
    assert.deepEqual(originFromText('mail.google.com'), { origin: 'https://mail.google.com', label: 'mail.google.com' });
    assert.deepEqual(originFromText('https://support.deako.com'), { origin: 'https://support.deako.com', label: 'support.deako.com' });
    assert.deepEqual(originFromText('www.example.com'), { origin: 'https://www.example.com', label: 'example.com' });
  });
  it('localhost[:port] is the one dotless exception (dev)', () => {
    assert.deepEqual(originFromText('localhost'), { origin: 'https://localhost', label: 'localhost' });
    assert.deepEqual(originFromText('localhost:3000'), { origin: 'https://localhost:3000', label: 'localhost' });
  });
  it('empty / non-string → null', () => {
    assert.equal(originFromText(''), null);
    assert.equal(originFromText('   '), null);
    assert.equal(originFromText(null), null);
  });
});

describe('setupSpec — archetypeShape (the archetype templates the shape)', () => {
  it('each archetype maps to its own run-shape; unknown → interactive default; returns a copy', () => {
    assert.equal(archetypeShape('operator').mode, 'interactive');
    assert.equal(archetypeShape('monitor').cadence, 'on-run');
    assert.equal(archetypeShape('executor').subAgents, true);
    assert.equal(archetypeShape('bogus').mode, 'interactive');
    const a = archetypeShape('operator'); a.mode = 'run';
    assert.equal(archetypeShape('operator').mode, 'interactive');
  });
});

describe('setupSpec — normalizeSlotValue', () => {
  it('connections → a deduped {origin,label} array; a single conn is wrapped; empty/junk → null', () => {
    assert.deepEqual(normalizeSlotValue('connections', [GMAIL, { origin: 'https://x.com' }]),
      [GMAIL, { origin: 'https://x.com', label: 'https://x.com' }]);          // label defaults to origin
    assert.deepEqual(normalizeSlotValue('connections', GMAIL), [GMAIL]);      // single → wrapped
    assert.deepEqual(normalizeSlotValue('connections', [GMAIL, GMAIL]), [GMAIL]);  // dedup by origin
    assert.equal(normalizeSlotValue('connections', [{ label: 'no origin' }]), null);
    assert.equal(normalizeSlotValue('connections', []), null);               // empty = unbound
  });
  it('shape clamps the mode and coerces flags; junk → null', () => {
    assert.deepEqual(normalizeSlotValue('shape', { mode: 'watch', subAgents: 1, cadence: 'daily' }),
      { mode: 'watch', subAgents: true, cadence: 'daily' });
    assert.deepEqual(normalizeSlotValue('shape', { mode: 'bogus' }), { mode: 'interactive', subAgents: false, cadence: null });
    assert.equal(normalizeSlotValue('focus', 'x'), null);                    // a dropped/unknown kind
  });
});

describe('setupSpec — buildSetupSpec', () => {
  it('produces connections + shape; connections is required + unbound (the only prompt); shape pre-bound', () => {
    const spec = buildSetupSpec(DEF);
    assert.deepEqual(spec.slots.map((s) => s.kind), SETUP_KINDS);
    assert.deepEqual(SETUP_KINDS, ['connections', 'shape']);
    assert.equal(spec.done, false);
    const byKey = Object.fromEntries(spec.slots.map((s) => [s.key, s]));
    assert.equal(byKey.connections.required, true);  assert.equal(byKey.connections.value, null);
    assert.equal(byKey.shape.required, false);       assert.equal(byKey.shape.value.mode, 'interactive');
  });
  it('existing connections become reuse candidates (junk dropped)', () => {
    const spec = buildSetupSpec(DEF, { connections: [GMAIL, { label: 'no origin' }] });
    const slot = spec.slots.find((s) => s.key === 'connections');
    assert.equal(slot.candidates.length, 1);
    assert.equal(slot.candidates[0].origin, GMAIL.origin);
  });
});

describe('setupSpec — addConnection (the sequential accumulator)', () => {
  it('appends verified connections, dedups by origin, ignores a bad conn', () => {
    let spec = buildSetupSpec(DEF);
    spec = addConnection(spec, GMAIL);
    assert.deepEqual(connectionsOf(spec).map((c) => c.origin), [GMAIL.origin]);
    spec = addConnection(spec, ZD);
    assert.deepEqual(connectionsOf(spec).map((c) => c.origin), [GMAIL.origin, ZD.origin]);
    spec = addConnection(spec, GMAIL);                                       // dup origin → no change
    spec = addConnection(spec, { label: 'no origin' });                     // bad → ignored
    assert.equal(connectionsOf(spec).length, 2);
  });
  it('removeConnection drops by origin', () => {
    let spec = addConnection(addConnection(buildSetupSpec(DEF), GMAIL), ZD);
    spec = removeConnection(spec, GMAIL.origin);
    assert.deepEqual(connectionsOf(spec).map((c) => c.origin), [ZD.origin]);
  });
});

describe('setupSpec — completion requires ≥1 connection AND done', () => {
  it('nextUnboundSlot is connections until the first; isSetupComplete needs the done signal too', () => {
    let spec = buildSetupSpec(DEF);
    assert.equal(nextUnboundSlot(spec).key, 'connections');
    assert.equal(isSetupComplete(spec), false);

    spec = addConnection(spec, GMAIL);
    assert.equal(nextUnboundSlot(spec), null);                              // first site bound — no more *required* prompts
    assert.equal(isSetupComplete(spec), false);                            // …but not complete until "done"

    spec = markSetupDone(spec);
    assert.equal(isSetupComplete(spec), true);
  });
  it('markSetupDone with zero connections does NOT complete (the ≥1 floor)', () => {
    assert.equal(isSetupComplete(markSetupDone(buildSetupSpec(DEF))), false);
  });
});

describe('setupSpec — specToConfig (the banked patch)', () => {
  it('returns null until ≥1 connection AND done', () => {
    let spec = buildSetupSpec(DEF);
    assert.equal(specToConfig(spec), null);
    spec = addConnection(spec, GMAIL);
    assert.equal(specToConfig(spec), null);                                // not done yet
  });
  it('emits connections[] + back-compat target/allowedOrigins over ALL origins; no focus', () => {
    let spec = markSetupDone(addConnection(addConnection(buildSetupSpec(DEF), GMAIL), ZD));
    const cfg = specToConfig(spec);
    assert.deepEqual(cfg.connections.map((c) => c.origin), [GMAIL.origin, ZD.origin]);
    assert.deepEqual(cfg.target, GMAIL);                                   // primary = the first connection (back-compat)
    assert.deepEqual(cfg.allowedOrigins, [GMAIL.origin, ZD.origin]);       // fence over the whole set
    assert.equal(cfg.shape.mode, 'interactive');                          // operator template carried through
    assert.equal('focus' in cfg, false);
  });
});

describe('setupSpec — normalizeSetupSpec (rehydrate + legacy migration)', () => {
  it('migrates a legacy single "target" slot → the connections accumulator', () => {
    const legacy = { appId: 'support', archetype: 'operator',
      slots: [{ key: 'target', kind: 'target', required: true, value: { origin: 'https://x.com' }, candidates: [GMAIL] }] };
    const clean = normalizeSetupSpec(legacy);
    const slot = clean.slots.find((s) => s.kind === 'connections');
    assert.ok(slot);
    assert.equal(slot.key, 'connections');
    assert.deepEqual(slot.value.map((c) => c.origin), ['https://x.com']);   // single value → one-entry list
    assert.equal(slot.candidates[0].origin, GMAIL.origin);
  });
  it('drops junk slots, preserves the done flag; garbage → an empty well-formed spec', () => {
    const clean = normalizeSetupSpec({ appId: 's', done: true,
      slots: [{ key: 'focus', kind: 'focus', value: 'open tickets' }, { key: 'shape', kind: 'shape', value: { mode: 'run' } }] });
    assert.deepEqual(clean.slots.map((s) => s.kind), ['shape']);            // focus dropped
    assert.equal(clean.done, true);
    assert.deepEqual(normalizeSetupSpec(null), { appId: '', archetype: null, done: false, slots: [] });
  });
});

describe('setupSpec — exported enums', () => {
  it('SHAPE_MODES + SETUP_KINDS are frozen', () => {
    assert.ok(Object.isFrozen(SHAPE_MODES) && Object.isFrozen(SETUP_KINDS));
  });
  it('bindSlot still overrides shape, leaving the original untouched', () => {
    const spec = buildSetupSpec(DEF);
    const next = bindSlot(spec, 'shape', { mode: 'run', subAgents: true });
    assert.equal(next.slots.find((s) => s.key === 'shape').value.mode, 'run');
    assert.equal(spec.slots.find((s) => s.key === 'shape').value.mode, 'interactive');
  });
});
