// Core/canvasWiring.test.js — CA-2 (v2.74.1204): the canvas render legs across palette gating + planExec dispatch.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { availableBuiltins, BUILTIN_LEGS } from './palette.js';
import { planExec } from './execPlan.js';

describe('canvas legs — palette gating (CA-2)', () => {
  it('DISPLAY/COMPOSE are offered ONLY when the app defines a canvas (requires:[canvas])', () => {
    const without = availableBuiltins(BUILTIN_LEGS, {}).map((l) => l.key);
    assert.equal(without.includes('DISPLAY'), false);
    assert.equal(without.includes('COMPOSE'), false);
    const withCanvas = availableBuiltins(BUILTIN_LEGS, { canvas: true }).map((l) => l.key);
    assert.ok(withCanvas.includes('DISPLAY') && withCanvas.includes('COMPOSE'));
  });
  it('are self-domain ACT legs, safety auto', () => {
    const d = BUILTIN_LEGS.find((l) => l.key === 'DISPLAY');
    assert.equal(d.domain, 'self');
    assert.equal(d.mode, 'act');
    assert.equal(d.safety, 'auto');
    assert.deepEqual(d.requires, ['canvas']);
  });
});

describe('canvas legs — planExec dispatch (CA-2)', () => {
  const leg = (key) => ({ key, domain: 'self', source: 'builtin', mode: 'act' });
  it('DISPLAY → RENDER_CANVAS, NOT busy-marked (Invariant #2 N/A), carries op+spec+anchor', () => {
    const spec = { title: 'HUD', blocks: [] };
    const plan = planExec(leg('DISPLAY'), { spec }, { appId: 'finance', conversationId: 'c1' });
    assert.equal(plan.ok, true);
    assert.equal(plan.channel, 'RENDER_CANVAS');
    assert.equal(plan.busyMark, false);
    assert.equal(plan.mode, 'act');
    assert.equal(plan.payload.op, 'display');
    assert.equal(plan.payload.spec, spec);
    assert.deepEqual(plan.payload.anchor, { appId: 'finance', conversationId: 'c1' });
  });
  it('COMPOSE → op compose; anchor null-filled when ctx lacks it', () => {
    const plan = planExec(leg('COMPOSE'), { spec: {} }, {});
    assert.equal(plan.payload.op, 'compose');
    assert.deepEqual(plan.payload.anchor, { appId: null, conversationId: null });
  });
  it('a render WITHOUT a spec is not dispatchable (render-needs-spec)', () => {
    const plan = planExec(leg('DISPLAY'), {}, {});
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'render-needs-spec');
  });
});
