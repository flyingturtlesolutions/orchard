// Core/bind.test.js — SG-4a unit tests (node --test). PURE: synthetic selections, no page, no LLM.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectionToTrialRoles } from './bind.js';

const field = (id, label, selector = `#${id}`, extra = {}) =>
  ({ id, label, kind: 'input', required: true, selector, interaction: { pattern: 'type', effect: 'none' }, ...extra });
const submit = { id: 'submit', label: 'Submit Application', kind: 'action', selector: 'button.s', interaction: { pattern: 'click', effect: 'submit' } };

describe('selectionToTrialRoles — complete intent', () => {
  it('maps required fields + the success action to roles, carrying featureId', () => {
    const sel = { boundary: { requiredFields: [field('firstName', 'First Name'), field('email', 'Email')], successAction: submit } };
    const roles = selectionToTrialRoles({ shape: 'complete' }, sel);
    assert.equal(roles.length, 3);
    // v2.74.594 — roles now carry the substrate-derived `kind` (self-contained for replay). A `type`
    // input has no fieldType (text is the _fillOpFor default → omitted).
    assert.deepEqual(roles[0], { role: 'First Name', selector: '#firstName', featureId: 'firstName', multiplicity: 'one', kind: 'input' });
    const last = roles[roles.length - 1];
    assert.equal(last.role, 'Submit Application');
    assert.equal(last.featureId, 'submit');
    assert.equal(last.kind, 'action');
    roles.forEach((r) => assert.ok(r.featureId, 'every role carries featureId for kind lookup'));
  });

  it('carries kind + fieldType so a select/file role replays without the live feature (self-contained)', () => {
    const sel = { boundary: { requiredFields: [
      { id: 'country', label: 'Country', kind: 'input', required: true, selector: 'select[name="c"]', interaction: { pattern: 'select', effect: 'none' } },
      { id: 'resume', label: 'Resume', kind: 'input', required: true, selector: 'input[name="r"]', interaction: { pattern: 'upload', effect: 'none' } },
    ], successAction: submit } };
    const roles = selectionToTrialRoles({ shape: 'complete' }, sel);
    const byId = Object.fromEntries(roles.map((r) => [r.featureId, r]));
    assert.equal(byId.country.kind, 'input');
    assert.equal(byId.country.fieldType, 'select');
    assert.equal(byId.resume.fieldType, 'file');
  });

  it('drops a required field with no selector', () => {
    const sel = { boundary: { requiredFields: [field('firstName', 'First Name'), { id: 'x', label: 'X', kind: 'input', selector: null }], successAction: submit } };
    const roles = selectionToTrialRoles({ shape: 'complete' }, sel);
    assert.deepEqual(roles.map((r) => r.featureId), ['firstName', 'submit']);
  });

  it('falls back to the feature id when the label is empty', () => {
    const sel = { boundary: { requiredFields: [field('FabricTextField-5', '')], successAction: null } };
    const roles = selectionToTrialRoles({ shape: 'complete' }, sel);
    assert.equal(roles[0].role, 'FabricTextField-5');
  });
});

describe('selectionToTrialRoles — hidden field reveal sequencing', () => {
  it('includes the trigger first and rewrites revealedBy to the trigger ROLE NAME', () => {
    const locale = { features: {
      trigBtn: { id: 'trigBtn', label: 'Show more', kind: 'disclosure', selector: '#more', interaction: { pattern: 'click', effect: 'reveal' } },
      hidden1: { id: 'hidden1', label: 'Promo code', kind: 'input', required: true, selector: '#promo', hidden: true, revealedBy: 'trigBtn', interaction: { pattern: 'type', effect: 'none' } },
    } };
    const sel = { boundary: { requiredFields: [locale.features.hidden1], successAction: submit } };
    const roles = selectionToTrialRoles({ shape: 'complete' }, sel, locale);
    // trigger injected before the hidden field
    assert.deepEqual(roles.map((r) => r.featureId), ['trigBtn', 'hidden1', 'submit']);
    const hidden = roles.find((r) => r.featureId === 'hidden1');
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.revealedBy, 'Show more');   // trigger's role NAME, not its id
  });
});

describe('selectionToTrialRoles — read/act intents resolve matched features via the locale', () => {
  it('maps matched featureIds to roles using the locale', () => {
    const locale = { features: {
      box: { id: 'box', label: 'Search', kind: 'input', selector: '#q', interaction: { pattern: 'type', effect: 'none' } },
      go: { id: 'go', label: 'Search', kind: 'action', selector: '#go', interaction: { pattern: 'click', effect: 'submit' } },
      list: { id: 'list', label: 'Results', kind: 'collection', selector: '.results', interaction: { pattern: 'none', effect: 'none' } },
    } };
    const sel = { matches: { 'enter-query': ['box'], 'submit-search': ['go'], 'read-results': ['list'] } };
    const roles = selectionToTrialRoles({ shape: 'read' }, sel, locale);
    assert.deepEqual(roles.map((r) => r.featureId).sort(), ['box', 'go', 'list']);
    assert.ok(roles.every((r) => r.selector));
  });
});
