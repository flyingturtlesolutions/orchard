// Core/setupSpec.test.js — AS-1 (v2.74.1186; revised v2.74.1189 — focus dropped from setup): the per-app setup spec.

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
  it('shape clamps mode to the enum and coerces the flags', () => {
    assert.deepEqual(normalizeSlotValue('shape', { mode: 'watch', subAgents: 1, cadence: 'daily' }),
      { mode: 'watch', subAgents: true, cadence: 'daily' });
    assert.deepEqual(normalizeSlotValue('shape', { mode: 'bogus' }),
      { mode: 'interactive', subAgents: false, cadence: null });
    assert.equal(normalizeSlotValue('shape', null), null);
  });
  it('a dropped/unknown kind (e.g. the old "focus") → null', () => {
    assert.equal(normalizeSlotValue('focus', 'open tickets'), null);
    assert.equal(normalizeSlotValue('mystery', 'x'), null);
  });
});

describe('setupSpec — buildSetupSpec', () => {
  const def = { id: 'support', name: 'Support agent', archetype: 'operator' };

  it('produces just target + shape (focus is not a setup slot)', () => {
    const spec = buildSetupSpec(def);
    assert.deepEqual(spec.slots.map((s) => s.kind), SETUP_KINDS);
    assert.deepEqual(SETUP_KINDS, ['target', 'shape']);
    assert.equal(spec.appId, 'support');
    assert.equal(spec.archetype, 'operator');
  });
  it('target is required + unbound (the only prompt); shape is pre-bound from the archetype, not required', () => {
    const spec = buildSetupSpec(def);
    const byKey = Object.fromEntries(spec.slots.map((s) => [s.key, s]));
    assert.equal(byKey.target.required, true);  assert.equal(byKey.target.value, null);
    assert.equal(byKey.shape.required, false);  assert.equal(byKey.shape.value.mode, 'interactive');
    assert.equal(byKey.focus, undefined);       // no focus slot
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

describe('setupSpec — progressive completion (target is the only required slot)', () => {
  it('nextUnboundSlot is target, then null once it is bound; isSetupComplete tracks it', () => {
    let spec = buildSetupSpec({ id: 'support', archetype: 'operator' });
    assert.equal(nextUnboundSlot(spec).key, 'target');
    assert.equal(isSetupComplete(spec), false);

    spec = bindSlot(spec, 'target', { origin: 'https://mail.google.com' });
    assert.equal(nextUnboundSlot(spec), null);                                     // shape isn't required
    assert.equal(isSetupComplete(spec), true);
  });
});

describe('setupSpec — specToConfig (the banked patch)', () => {
  it('returns null while the target is unbound', () => {
    assert.equal(specToConfig(buildSetupSpec({ id: 'support', archetype: 'operator' })), null);
  });
  it('collapses once the target is bound; allowedOrigins is derived; no focus field', () => {
    let spec = buildSetupSpec({ id: 'support', archetype: 'operator' });
    spec = bindSlot(spec, 'target', { origin: 'https://mail.google.com', label: 'Gmail' });
    const cfg = specToConfig(spec);
    assert.equal(cfg.target.label, 'Gmail');
    assert.deepEqual(cfg.allowedOrigins, ['https://mail.google.com']);
    assert.equal(cfg.shape.mode, 'interactive');                                   // operator template carried through
    assert.equal('focus' in cfg, false);                                           // focus is not banked
  });
});

describe('setupSpec — normalizeSetupSpec (rehydrate)', () => {
  it('drops junk slots and re-normalizes bound values', () => {
    const dirty = {
      appId: 'support', archetype: 'operator',
      slots: [
        { key: 'target', kind: 'target', required: true, value: { origin: 'https://x.com' }, candidates: [{ label: 'junk' }] },
        { key: 'focus', kind: 'focus', value: 'open tickets' },                   // old focus slot → dropped (kind no longer valid)
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
