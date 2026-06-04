// Core/orchShadow.test.js — ORCH-CB shadow comparison (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planShapeLabel, shadowCompare } from './orchShadow.js';

describe('orchShadow — LLM plan vs comprehend→bind comparison (ORCH-CB)', () => {
  it('planShapeLabel: foreach / conditional / sequence / single / empty', () => {
    assert.equal(planShapeLabel([{ kind: 'observe' }, { kind: 'foreach', body: [] }]), 'foreach');
    assert.equal(planShapeLabel([{ kind: 'observe' }, { kind: 'analyze' }, { kind: 'gate', body: [] }]), 'conditional');
    assert.equal(planShapeLabel([{ kind: 'fragment' }, { kind: 'fragment' }]), 'sequence');
    assert.equal(planShapeLabel([{ kind: 'fragment' }]), 'single');
    assert.equal(planShapeLabel([]), 'empty');
  });

  it('shadowCompare: identical bound plans → shapeMatch, full agreement', () => {
    const llm = [{ kind: 'fragment', capabilityId: 'a' }, { kind: 'fragment', capabilityId: 'b' }];
    const cb = [{ kind: 'fragment', capabilityId: 'a' }, { kind: 'fragment', capabilityId: 'b' }];
    const r = shadowCompare(llm, cb);
    assert.equal(r.shapeMatch, true);
    assert.equal(r.agreement, 1);
    assert.equal(r.agreeCount, 2);
    assert.equal(r.llmBound, 2);
    assert.equal(r.cbBound, 2);
  });

  it('shadowCompare: divergent SHAPE is flagged (sequence vs conditional)', () => {
    const llm = [{ kind: 'fragment', capabilityId: 'a' }, { kind: 'fragment', capabilityId: 'b' }];
    const cb = [{ kind: 'observe', capabilityId: 'a' }, { kind: 'analyze' }, { kind: 'gate', body: [{ kind: 'fragment', capabilityId: 'b' }] }];
    const r = shadowCompare(llm, cb);
    assert.equal(r.shapeMatch, false);
    assert.equal(r.llmShape, 'sequence');
    assert.equal(r.cbShape, 'conditional');
    assert.equal(r.agreeCount, 2, 'bindings inside a gate body still count');
  });

  it('shadowCompare: PARTIAL binding overlap → a fractional agreement (the floor missed some)', () => {
    const llm = [{ kind: 'fragment', capabilityId: 'a' }, { kind: 'fragment', capabilityId: 'b' }, { kind: 'fragment', capabilityId: 'c' }];
    const cb = [{ kind: 'fragment', capabilityId: 'a' }, { kind: 'fragment', capabilityId: null }, { kind: 'fragment', capabilityId: 'c' }];
    const r = shadowCompare(llm, cb);
    assert.equal(r.agreeCount, 2);
    assert.equal(r.llmBound, 3);
    assert.equal(r.cbBound, 2);
    assert.ok(Math.abs(r.agreement - 2 / 3) < 1e-9);
  });

  it('shadowCompare: when the LLM bound nothing, agreement is 1 iff the floor also bound nothing', () => {
    assert.equal(shadowCompare([], []).agreement, 1);
    assert.equal(shadowCompare([{ kind: 'fragment' }], [{ kind: 'fragment', capabilityId: 'x' }]).agreement, 0, 'floor bound where the LLM did not');
  });
});
