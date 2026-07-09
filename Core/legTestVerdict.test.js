// Core/legTestVerdict.test.js — OV-4 (v2.74.1413): the structural leg-test verdict.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assessLegTest } from './legTestVerdict.js';

describe('assessLegTest — structural pass/fail', () => {
  it('a successful read → pass, with a record count', () => {
    const v = assessLegTest({ success: true, value: { tickets: [{ id: 1 }, { id: 2 }] } });
    assert.equal(v.pass, true);
    assert.equal(v.verdict, 'ok');
    assert.equal(v.count, 2);
  });

  it('a GraphQL {data:{customers:{edges:[...]}}} envelope counts the edges', () => {
    const v = assessLegTest({ success: true, value: { data: { customers: { edges: [{ node: { id: 'x' } }] } } } });
    assert.equal(v.pass, true);
    assert.equal(v.count, 1);
  });

  it('a failure envelope fails with the error CODE as the verdict + carries the detail', () => {
    const v = assessLegTest({ success: false, error: 'graphql-error', detail: 'Phone is invalid' });
    assert.equal(v.pass, false);
    assert.equal(v.verdict, 'graphql-error');
    assert.equal(v.detail, 'Phone is invalid');
    // the belt-level errors surface as their own verdicts
    assert.equal(assessLegTest({ success: false, error: 'no-csrf', hint: 'click the tab' }).verdict, 'no-csrf');
    assert.equal(assessLegTest({ success: false, error: 'not-logged-in' }).verdict, 'not-logged-in');
  });

  it('expectFields: a success MISSING a declared field is a structural FAIL (names the missing field)', () => {
    const reply = { success: true, value: { data: { customerCreate: { customer: { id: 'gid://…/9' } } } } };
    assert.equal(assessLegTest(reply, { expectFields: ['customer'] }).pass, true);          // present (nested) → pass
    const miss = assessLegTest(reply, { expectFields: ['order'] });
    assert.equal(miss.pass, false);
    assert.equal(miss.verdict, 'missing-fields');
    assert.deepEqual(miss.missing, ['order']);
  });

  it('an empty-but-successful list still PASSES (a valid empty result is not a leg failure)', () => {
    const v = assessLegTest({ success: true, value: { data: { customers: { edges: [] } } } });
    assert.equal(v.pass, true);
    assert.equal(v.count, 0);
  });

  it('no reply / non-object → no-reply fail', () => {
    assert.equal(assessLegTest(null).verdict, 'no-reply');
    assert.equal(assessLegTest(undefined).pass, false);
  });
});
