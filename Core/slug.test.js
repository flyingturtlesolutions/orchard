// Core/slug.test.js — CR-D2 (v2.74.940): the single UPPER_SNAKE builder + the HS-2 coupling pin.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { slugUpper } from './slug.js';

describe('slugUpper — the one label→UPPER_SNAKE builder (CR-D2)', () => {
  it('basic slugging + strip + fallback', () => {
    assert.equal(slugUpper('Job title, keywords, or company'), 'JOB_TITLE_KEYWORDS_OR_COMPANY');
    assert.equal(slugUpper('  --weird--  '), 'WEIRD');
    assert.equal(slugUpper('', { fallback: 'RESULT' }), 'RESULT');
    assert.equal(slugUpper('!!!', { fallback: 'INPUT' }), 'INPUT');
  });
  it('maxWords keeps the first N words', () => {
    assert.equal(slugUpper('open each job listing row', { maxWords: 3 }), 'OPEN_EACH_JOB');
  });
  it('maxLen truncates and re-strips a trailing underscore', () => {
    assert.equal(slugUpper('a'.repeat(50), { maxLen: 40 }).length, 40);
    assert.ok(!slugUpper('ab '.repeat(20), { maxLen: 40 }).endsWith('_'));
  });

  it('HS-2 ROUND-TRIP PIN: the observation-output options equal the param-name options', () => {
    // tier2Lower._scopeName and capabilitySynth._paramName both use { maxLen: 40 }. HS-2 wires
    // output → param by STRING EQUALITY, so the same long label must round identically through both.
    const OUTPUT_OPTS = { maxLen: 40, fallback: 'RESULT' };
    const PARAM_OPTS  = { maxLen: 40, fallback: 'INPUT' };
    const labels = [
      'job listing titles, companies, and apply buttons',
      'search results list with metadata (title, date, dimensions)',
      'a'.repeat(80),
      'Top 5 matching jobs on this results page!!',
    ];
    for (const l of labels) {
      assert.equal(slugUpper(l, OUTPUT_OPTS), slugUpper(l, PARAM_OPTS), `"${l.slice(0, 40)}…" must wire`);
    }
  });
});
