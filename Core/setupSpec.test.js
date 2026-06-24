// Core/setupSpec.test.js — AS-1 (v2.74.1186): the per-app setup spec.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SETUP_KINDS, SHAPE_MODES, archetypeShape, normalizeSlotValue, buildSetupSpec,
  normalizeSetupSpec, bindSlot, nextUnboundSlot, isSetupComplete, specToConfig,
} from './setupSpec.js';

describe('setupSpec — archetypeShape (the archetype templates the shape)', () => {
  it('each archetype maps to its own run-shape', () => {
    assert.equal(archetypeShape('operator').mode, 'interactive');
    assert.equal(archetypeShape('monitor').mode, 'watch');
    assert.equal(archetypeShape('monitor').cadence, 'on-run');
    assert.equal(archetypeShape('executor').mode, 'run');
    assert.equal(archetypeShape('executor').subAgents, true);
  });
  it('unknown / missing archetype falls back to the interactive default', () => {
    assert.equal(archetypeShape('bogus').mode, 'interactive');
    assert.equal(archetypeShape(null).mode, 'interactive');
    assert.equal(archetypeShape(undefined).subAgents, false);
  });
  it('returns a COPY (callers can mutate without poisoning the template)', () => {
    const a = archetypeShape('operator'); a.mode = 'run';
    assert.equal(archetypeShape('operator').mode, 'interactive');
  });
});

describe('setupSpec — normalizeSlotValue', () => {
  it('target requires an origin; label defaults to the origin', () => {
    assert.deepEqual(normalizeSlotValue('target', { origin: 'https://mail.google.com', label: 'Gmail' }),
      { origin: 'https://mail.google.com', label: 'Gmail' });
    assert.deepEqual(normalizeSlotValue('target', { origin: 'https://x.com' }),
      { origin: 'https://x.com', label: 'https://x.com' });
    assert.equal(normalizeSlotValue('target', { label: 'no origin' }), null);   // no origin → unusable
    assert.equal(normalizeSlotValue('target', null), null);
  });
  it('focus trims, drops blanks, caps at 120', () => {
    assert.equal(normalizeSlotValue('focus', '  open tickets  '), 'open tickets');
    assert.equal(normalizeSlotValue('focus', '   '), null);
    assert.equal(normalizeSlotValue('focus', 'x'.repeat(200)).length, 120);
  });
  it('shape clamps mode to the enum and coerces the flags', () => {
    assert.deepEqual(normalizeSlotValue('shape', { mode: 'watch', subAgents: 1, cadence: 'daily' }),
      { mode: 'watch', subAgents: true, cadence: 'daily' });
    assert.deepEqual(normalizeSlotValue('shape', { mode: 'bogus' }),
      { mode: 'interactive', subAgents: false, cadence: null });
    assert.equal(normalizeSlotValue('shape', null), null);
  });
  it('unknown kind → null', () => {
    assert.equal(normalizeSlotValue('mystery', 'x'), null);
  });
});

describe('setupSpec — buildSetupSpec', () => {
  const def = { id: 'support', name: 'Support agent', archetype: 'operator' };

  it('produces exactly the three ordered slots, all known kinds', () => {
    const spec = buildSetupSpec(def);
    assert.deepEqual(spec.slots.map((s) => s.kind), SETUP_KINDS);
    assert.equal(spec.appId, 'support');
    assert.equal(spec.archetype, 'operator');
  });
  it('target + focus are required and unbound; shape is pre-bound from the archetype', () => {
    const spec = buildSetupSpec(def);
    const byKey = Object.fromEntries(spec.slots.map((s) => [s.key, s]));
    assert.equal(byKey.target.required, true);  assert.equal(byKey.target.value, null);
    assert.equal(byKey.focus.required, true);   assert.equal(byKey.focus.value, null);
    assert.equal(byKey.shape.required, false);  assert.equal(byKey.shape.value.mode, 'interactive');
  });
  it('existing connections become the target slot candidates (reuse-then-teach); junk is dropped', () => {
    const spec = buildSetupSpec(def, { connections: [
      { origin: 'https://mail.google.com', label: 'Gmail' },
      { label: 'no origin — dropped' },
    ] });
    const target = spec.slots.find((s) => s.key === 'target');
    assert.equal(target.candidates.length, 1);
    assert.equal(target.candidates[0].origin, 'https://mail.google.com');
  });
  it('unknown archetype → shape defaults; still builds', () => {
    const spec = buildSetupSpec({ id: 'x', archetype: 'nope' });
    assert.equal(spec.archetype, null);
    assert.equal(spec.slots.find((s) => s.key === 'shape').value.mode, 'interactive');
  });
});

describe('setupSpec — bindSlot (copy-on-write)', () => {
  it('binds a good value and leaves the original spec untouched', () => {
    const spec = buildSetupSpec({ id: 'support', archetype: 'operator' });
    const next = bindSlot(spec, 'target', { origin: 'https://mail.google.com', label: 'Gmail' });
    assert.equal(next.slots.find((s) => s.key === 'target').value.origin, 'https://mail.google.com');
    assert.equal(spec.slots.find((s) => s.key === 'target').value, null);          // original unchanged
  });
  it('rejects a value that is bad for the kind (slot stays unbound)', () => {
    const spec = buildSetupSpec({ id: 'support', archetype: 'operator' });
    const next = bindSlot(spec, 'target', { label: 'no origin' });
    assert.equal(next.slots.find((s) => s.key === 'target').value, null);
  });
  it('an unknown key leaves the spec effectively unchanged', () => {
    const spec = buildSetupSpec({ id: 'support', archetype: 'operator' });
    const next = bindSlot(spec, 'mystery', 'x');
    assert.deepEqual(next.slots.map((s) => s.value), spec.slots.map((s) => s.value));
  });
});

describe('setupSpec — progressive completion', () => {
  it('nextUnboundSlot walks required slots in order, then null; isSetupComplete tracks it', () => {
    let spec = buildSetupSpec({ id: 'support', archetype: 'operator' });
    assert.equal(nextUnboundSlot(spec).key, 'target');                              // target first
    assert.equal(isSetupComplete(spec), false);

    spec = bindSlot(spec, 'target', { origin: 'https://mail.google.com' });
    assert.equal(nextUnboundSlot(spec).key, 'focus');                              // then focus
    assert.equal(isSetupComplete(spec), false);

    spec = bindSlot(spec, 'focus', 'open tickets');
    assert.equal(nextUnboundSlot(spec), null);                                     // shape isn't required
    assert.equal(isSetupComplete(spec), true);
  });
});

describe('setupSpec — specToConfig (the banked patch)', () => {
  it('returns null while any required slot is unbound', () => {
    const spec = buildSetupSpec({ id: 'support', archetype: 'operator' });
    assert.equal(specToConfig(spec), null);
    assert.equal(specToConfig(bindSlot(spec, 'target', { origin: 'https://x.com' })), null);  // focus still missing
  });
  it('collapses a completed spec; allowedOrigins is derived from the target', () => {
    let spec = buildSetupSpec({ id: 'support', archetype: 'operator' });
    spec = bindSlot(spec, 'target', { origin: 'https://mail.google.com', label: 'Gmail' });
    spec = bindSlot(spec, 'focus', 'open tickets');
    const cfg = specToConfig(spec);
    assert.equal(cfg.target.label, 'Gmail');
    assert.deepEqual(cfg.allowedOrigins, ['https://mail.google.com']);
    assert.equal(cfg.focus, 'open tickets');
    assert.equal(cfg.shape.mode, 'interactive');                                   // operator template carried through
  });
});

describe('setupSpec — normalizeSetupSpec (rehydrate)', () => {
  it('drops junk slots and re-normalizes bound values', () => {
    const dirty = {
      appId: 'support', archetype: 'operator',
      slots: [
        { key: 'target', kind: 'target', required: true, value: { origin: 'https://x.com' }, candidates: [{ label: 'junk' }] },
        { key: 'bad', kind: 'mystery', value: 'x' },                              // unknown kind → dropped
      ],
    };
    const clean = normalizeSetupSpec(dirty);
    assert.equal(clean.slots.length, 1);
    assert.equal(clean.slots[0].value.label, 'https://x.com');                    // label defaulted
    assert.equal(clean.slots[0].candidates.length, 0);                            // junk candidate dropped
  });
  it('garbage input → an empty, well-formed spec', () => {
    assert.deepEqual(normalizeSetupSpec(null), { appId: '', archetype: null, slots: [] });
    assert.deepEqual(normalizeSetupSpec('nope'), { appId: '', archetype: null, slots: [] });
  });
});

describe('setupSpec — exported enums', () => {
  it('SHAPE_MODES + SETUP_KINDS are frozen', () => {
    assert.ok(Object.isFrozen(SHAPE_MODES));
    assert.ok(Object.isFrozen(SETUP_KINDS));
  });
});
