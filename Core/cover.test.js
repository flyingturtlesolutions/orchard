// Core/cover.test.js — SG-3 unit tests (node --test). PURE: synthetic selections, no page, no LLM.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { coverComplete } from './cover.js';

const field = (id, pattern = 'type', selector = `#${id}`) =>
  ({ id, label: id, kind: 'input', required: true, selector, interaction: { pattern, effect: 'none' } });
const submit = { id: 'submit', label: 'Submit Application', kind: 'action', selector: 'button.s', interaction: { pattern: 'click', effect: 'submit' } };

function selection({ requiredFields, successAction = submit, orphanRequired = [], matches = {} }) {
  return { boundary: { requiredFields, successAction }, orphanRequired, matches, featureToSubGoal: {}, reconciledSubGoals: [] };
}

describe('coverComplete — complete intent', () => {
  it('is complete when every required field is operable and the success action is present', () => {
    const sel = selection({ requiredFields: [field('firstName'), field('country', 'select'), field('resume', 'upload')] });
    const v = coverComplete({ shape: 'complete' }, sel);
    assert.equal(v.complete, true);
    assert.equal(v.completionCount, 3);
    assert.equal(v.operableCount, 3);
    assert.equal(v.hasSuccessAction, true);
  });

  it('fails when the success action is missing', () => {
    const sel = selection({ requiredFields: [field('firstName')], successAction: null });
    const v = coverComplete({ shape: 'complete' }, sel);
    assert.equal(v.complete, false);
    assert.match(v.reason, /no success action/);
  });

  it('fails when a required field is not operable (no value op / no selector)', () => {
    const bad = { id: 'x', label: 'x', kind: 'input', required: true, selector: '#x', interaction: { pattern: 'none' } };
    const v = coverComplete({ shape: 'complete' }, selection({ requiredFields: [field('firstName'), bad] }));
    assert.equal(v.complete, false);
    assert.equal(v.inoperable.length, 1);
    assert.equal(v.inoperable[0].id, 'x');
  });

  it('orphan required fields are surfaced but do NOT fail completeness', () => {
    const city = field('city');
    const sel = selection({ requiredFields: [field('firstName'), city], orphanRequired: [city] });
    const v = coverComplete({ shape: 'complete' }, sel);
    assert.equal(v.complete, true);             // city is operable + in the floor → covered
    assert.deepEqual(v.orphanRequired, ['city']); // but flagged: no sub-goal claimed it (needs data sourcing)
  });

  it('fails when no required fields were found (capture gap)', () => {
    const v = coverComplete({ shape: 'complete' }, selection({ requiredFields: [] }));
    assert.equal(v.complete, false);
    assert.match(v.reason, /no required fields/);
  });
});

describe('coverComplete — read/act/navigate intents', () => {
  it('is complete when every required sub-goal has a matched feature', () => {
    const spec = { shape: 'read', subGoals: [{ id: 'find', scope: 'required' }, { id: 'extra', scope: 'optional' }] };
    const v = coverComplete(spec, { matches: { find: ['f1'] } });
    assert.equal(v.complete, true);
  });

  it('fails when a required sub-goal is unmatched', () => {
    const spec = { shape: 'navigate', subGoals: [{ id: 'goto', scope: 'required' }] };
    const v = coverComplete(spec, { matches: {} });
    assert.equal(v.complete, false);
    assert.deepEqual(v.unmetSubGoals, ['goto']);
  });

  it('a single-action intent with no sub-goals is trivially complete', () => {
    const v = coverComplete({ shape: 'act', subGoals: [] }, { matches: {} });
    assert.equal(v.complete, true);
  });
});
