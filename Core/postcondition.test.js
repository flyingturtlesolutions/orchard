// Core/postcondition.test.js — SG-T2-9 unit tests (node --test). PURE: synthetic conditions + observed.
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness. These document the contract.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePostcondition, extractKeywords, urlParamsChanged, isFillableInputSelector, dropWeakInputPresence, relaxNavPostFailures, condList } from './postcondition.js';

describe('postcondition — weak input-presence (the re-search skip bug, v2.74.783)', () => {
  it('isFillableInputSelector: true for input/textarea/select targets, false for regions', () => {
    assert.equal(isFillableInputSelector('input[name="q"]'), true);
    assert.equal(isFillableInputSelector('form input[name="q"]'), true, 'descendant — the matched element is the input');
    assert.equal(isFillableInputSelector('textarea#bio'), true);
    assert.equal(isFillableInputSelector('select.country'), true);
    assert.equal(isFillableInputSelector('[name="q"]'), true, 'a bare name attribute selector');
    assert.equal(isFillableInputSelector('#results'), false);
    assert.equal(isFillableInputSelector('.job-card .results-list'), false);
    assert.equal(isFillableInputSelector('div[data-results]'), false, 'a region with an attr is not an input');
    assert.equal(isFillableInputSelector(''), false);
  });
  it('dropWeakInputPresence removes selector_present on an input, keeps strong signals', () => {
    const conds = [
      { type: 'selector_present', selector: 'input[name="q"]' },   // weak — the search box
      { type: 'selector_present', selector: '#results' },          // strong — a results region
      { type: 'url_matches', pattern: '/jobs' },                   // strong
    ];
    assert.deepEqual(dropWeakInputPresence(conds), [
      { type: 'selector_present', selector: '#results' },
      { type: 'url_matches', pattern: '/jobs' },
    ]);
  });
  it('a postcondition that is ONLY a search-box presence check → empty (do not skip)', () => {
    assert.deepEqual(dropWeakInputPresence([{ type: 'selector_present', selector: 'input[name="q"]' }]), []);
    assert.deepEqual(dropWeakInputPresence(null), []);
  });
});

describe('postcondition — keyword extraction & URL change', () => {
  it('extractKeywords keeps domain terms, drops mechanism fillers (incl. "path")', () => {
    assert.deepEqual(extractKeywords('pay or salary parameter in query string'), ['pay', 'salary']);
    assert.deepEqual(extractKeywords('search or jobs path with query parameter'), ['search', 'jobs']);
  });
  it('urlParamsChanged ignores noise (vjk) but catches a real param (fromage)', () => {
    const a = 'https://www.indeed.com/jobs?q=test&l=New+York&vjk=aaa';
    const b = 'https://www.indeed.com/jobs?q=test&l=New+York&vjk=bbb';
    const c = 'https://www.indeed.com/jobs?q=test&l=New+York&vjk=bbb&fromage=7';
    assert.equal(urlParamsChanged(a, b), false);
    assert.equal(urlParamsChanged(a, c), true);
  });
});

describe('postcondition — evaluate (SG-T2-9)', () => {
  it('pay NO-OP (dropdown opened, commit deferred → URL unchanged) → NOT held; url gates over the results floor', () => {
    const pc = { match: 'any', conditions: [
      { type: 'selector_present', selector: '.results' },                          // ever-present on a SERP
      { type: 'url_matches', pattern: 'pay or salary parameter in query string' },
    ] };
    const url = 'https://www.indeed.com/jobs?q=with+criteria&l=New+York&vjk=d913';
    const res = evaluatePostcondition(pc, { beforeUrl: url, afterUrl: url, selectorsPresent: { '.results': true } });
    assert.equal(res.checked, true);
    assert.equal(res.basis, 'url');
    assert.equal(res.held, false);
  });

  it('pay APPLIED (salaryType param added) → held', () => {
    const pc = { match: 'any', conditions: [{ type: 'url_matches', pattern: 'pay or salary parameter in query string' }] };
    const before = 'https://www.indeed.com/jobs?q=test&l=NY&vjk=a';
    const after  = 'https://www.indeed.com/jobs?q=test&l=NY&vjk=b&salaryType=%2420%2C000';
    assert.equal(evaluatePostcondition(pc, { beforeUrl: before, afterUrl: after }).held, true);
  });

  it('date filter (param named fromage, not "date") → held via URL CHANGE', () => {
    const pc = { match: 'any', conditions: [{ type: 'url_matches', pattern: 'date or time parameter in query string' }] };
    const before = 'https://www.indeed.com/jobs?q=test&l=NY&vjk=a';
    const after  = 'https://www.indeed.com/jobs?q=test&l=NY&vjk=b&fromage=7';
    assert.equal(evaluatePostcondition(pc, { beforeUrl: before, afterUrl: after }).held, true);
  });

  it('no url condition → falls back to the selector floor when present', () => {
    const pc = { match: 'any', conditions: [{ type: 'selector_present', selector: '#results' }] };
    const res = evaluatePostcondition(pc, { beforeUrl: 'x', afterUrl: 'y', selectorsPresent: { '#results': true } });
    assert.equal(res.basis, 'element');
    assert.equal(res.held, true);
  });

  it('no checkable condition (selector not gathered, no url cond) → checked:false (falls back to trial verdict)', () => {
    const pc = { match: 'any', conditions: [{ type: 'selector_present', selector: '#x' }] };
    assert.equal(evaluatePostcondition(pc, { beforeUrl: 'a', afterUrl: 'a', selectorsPresent: {} }).checked, false);
  });

  it('null / empty postcondition → not checked', () => {
    assert.equal(evaluatePostcondition(null, {}).checked, false);
    assert.equal(evaluatePostcondition({ conditions: [] }, {}).checked, false);
  });
});

describe('relaxNavPostFailures — nav-aware relax reads the REAL failure envelope (CR-E1, v2.74.927)', () => {
  // checkConditions emits failures as {condition, reason}. The in-engine .815 filter read f.type directly,
  // so it NEVER fired — these tests pin the envelope contract the engine consumes now.
  const nav = { from: 'https://x.com/jobs?q=a', to: 'https://x.com/viewjob?id=1' };
  const env = (type, pattern) => ({ condition: { type, pattern }, reason: 'condition not met' });

  it('relaxes a url_matches that held pre-nav and broke on the click own nav (envelope shape)', () => {
    const { kept, relaxed } = relaxNavPostFailures([env('url_matches', '/jobs')], nav);
    assert.equal(relaxed.length, 1);
    assert.equal(kept.length, 0);
  });

  it('keeps a third-page pattern (matched neither side)', () => {
    const { kept, relaxed } = relaxNavPostFailures([env('url_matches', '/login')], nav);
    assert.equal(relaxed.length, 0);
    assert.equal(kept.length, 1);
  });

  it('keeps non-url failures untouched and tolerates the legacy bare-condition shape', () => {
    const bare = { type: 'url_matches', pattern: '/jobs' };   // legacy shape — still relaxes
    const other = { condition: { type: 'selector_present', selector: '#r' }, reason: 'missing' };
    const { kept, relaxed } = relaxNavPostFailures([bare, other], nav);
    assert.equal(relaxed.length, 1, 'bare legacy shape relaxes too');
    assert.deepEqual(kept, [other]);
  });

  it('no nav (or no from) → everything kept', () => {
    const fs = [env('url_matches', '/jobs')];
    assert.deepEqual(relaxNavPostFailures(fs, null), { kept: fs, relaxed: [] });
    assert.deepEqual(relaxNavPostFailures(fs, { to: 'x' }), { kept: fs, relaxed: [] });
  });

  it('an invalid regex pattern is kept (never throws)', () => {
    const { kept, relaxed } = relaxNavPostFailures([env('url_matches', '([')], nav);
    assert.equal(relaxed.length, 0);
    assert.equal(kept.length, 1);
  });
});

describe('condList — the conditions shape-normalizer (CR-X2 move)', () => {
  it('tolerates both the plain array and the {match, conditions} envelope', () => {
    const arr = [{ type: 'selector_present', selector: '#a' }];
    assert.deepEqual(condList(arr), arr);
    assert.deepEqual(condList({ match: 'all', conditions: arr }), arr);
  });
  it('null / undefined / scalar / empty envelope degrade to []', () => {
    assert.deepEqual(condList(null), []);
    assert.deepEqual(condList(undefined), []);
    assert.deepEqual(condList('x'), []);
    assert.deepEqual(condList({ match: 'all' }), []);
  });
});
