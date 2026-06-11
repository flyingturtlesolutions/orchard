// Core/formCoverage.test.js — CR-H3 (v2.74.955): the live-path form-coverage module had no tests.
// selectNecessaryFields + slugMatch feed AnthropicService prompts (the wired half); assessIntentCoverage
// is the PB-10 intent-coverage gate (task #80, in progress — its completion-shape behavior is pinned
// here so the wiring lands against a tested contract). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toSlug, stripAsterisk, selectorForField, isNecessaryField, selectNecessaryFields, slugMatch, matchRolesToFields, assessIntentCoverage } from './formCoverage.js';

describe('formCoverage — slugs, selectors, necessity (CR-H3)', () => {
  it('toSlug: kebab-normalizes labels, camelCase, asterisks, and noise', () => {
    assert.equal(toSlug('First Name *'), 'first-name');
    assert.equal(toSlug('emailAddress'), 'email-address');
    assert.equal(toSlug('  Phone__number  '), 'phone-number');
    assert.equal(toSlug(''), '');
  });

  it('stripAsterisk: trailing required-markers and double spaces go; inner text intact', () => {
    assert.equal(stripAsterisk('Email *'), 'Email');
    assert.equal(stripAsterisk('Last  Name'), 'Last Name');
    assert.equal(stripAsterisk(null), '');
  });

  it('selectorForField: stable id > name > aria-label > placeholder; volatile framework ids rejected', () => {
    assert.equal(selectorForField({ id: 'email' }), '#email');
    assert.equal(selectorForField({ id: ':r3:', name: 'q' }), '[name="q"]', 'React useId is volatile');
    assert.equal(selectorForField({ id: 'FabricTextField-324', ariaLabel: 'Search', tag: 'INPUT' }), 'input[aria-label="Search"]');
    assert.equal(selectorForField({ placeholder: 'City', tag: 'input' }), 'input[placeholder="City"]');
    assert.equal(selectorForField({}), null);
  });

  it('isNecessaryField + selectNecessaryFields: submit and required inputs only, de-duped by slot', () => {
    const fields = [
      { label: 'Email *', required: true, kind: 'text' },
      { label: 'Email',   required: true, kind: 'text' },          // duplicate slot — first wins
      { label: 'Nickname', required: false, kind: 'text' },        // optional — never necessary
      { label: 'Apply',   isSubmit: true },
    ];
    assert.equal(isNecessaryField(fields[2]), false);
    const sel = selectNecessaryFields(fields);
    assert.deepEqual(sel.map((f) => f.slot), ['email', 'submit']);
    assert.equal(sel[0].label, 'Email', 'asterisk stripped in the emitted label');
  });

  it('slugMatch: exact / containment / token-overlap >= 0.5; stopwords ignored', () => {
    assert.equal(slugMatch('Email address', 'email'), true);          // containment
    assert.equal(slugMatch('Enter your email', 'email'), true);       // stopwords drop out
    assert.equal(slugMatch('phone', 'email'), false);
    assert.equal(slugMatch('', 'email'), false);
  });

  it('matchRolesToFields: matched / missing / extraRoles partition', () => {
    const res = matchRolesToFields(
      ['Email address', { role: 'Search button' }, 'Country'],
      [{ slot: 'email' }, { slot: 'submit' }],
    );
    assert.deepEqual(res.matched, [{ field: 'email', role: 'Email address' }]);
    assert.deepEqual(res.missing, ['submit']);
    assert.deepEqual(res.extraRoles, ['Search button', 'Country']);
  });

  it('assessIntentCoverage: non-complete shapes are not applicable (sufficient by default)', () => {
    const r = assessIntentCoverage({ shape: 'read', fields: [{ label: 'X', required: true }], roles: [] });
    assert.equal(r.applicable, false);
    assert.equal(r.sufficient, true);
  });

  it('assessIntentCoverage: completion shape counts necessary slots and reports the gap', () => {
    const fields = [
      { label: 'Email *', required: true, kind: 'text' },
      { label: 'Resume', required: true, kind: 'file' },
      { label: 'Apply', isSubmit: true },
    ];
    const r = assessIntentCoverage({ shape: 'complete', fields, roles: ['email field', 'submit button'] });
    assert.equal(r.applicable, true);
    assert.equal(r.total, 3);
    assert.equal(r.covered, 2);
    assert.deepEqual(r.missing, ['resume']);
    assert.equal(r.sufficient, false);
  });
});
