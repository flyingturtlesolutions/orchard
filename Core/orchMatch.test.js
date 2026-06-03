// Core/orchMatch.test.js — ORCH-M0 unit tests (node --test). PURE.
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness (shim describe/it).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toCandidate, scopeAndPartition, lexicalScore, rankAndDecide, matchAsk, DEFAULT_THRESHOLDS } from './orchMatch.js';

// A realistic mini-library for indeed.com results page.
const G = 'ground-indeed';
const RESULTS = 'https://www.indeed.com/jobs';
const search = { id: 'cap-search', groundId: G, localeUrl: 'https://www.indeed.com', intent: 'Search jobs by keyword and location', strategyId: 's1', params: [], aliases: ['search for jobs'] };
const dateF = { id: 'cap-date', groundId: G, localeUrl: RESULTS, intent: 'Filter by date posted', strategyId: 's2', params: [{ name: 'DATE', kind: 'option', used: true, value: 'Last 3 days' }], aliases: ['posted today', 'recent postings'] };
const payF  = { id: 'cap-pay', groundId: G, localeUrl: RESULTS, intent: 'Filter by pay', strategyId: 's3', params: [], aliases: [] };
const apply = { id: 'cap-apply', groundId: G, localeUrl: RESULTS, intent: 'Apply to the job', strategyId: 's4', params: [], aliases: [] };

describe('orchMatch — ORCH-M0 HIT/MISS matcher core', () => {
  it('toCandidate projects the matchable surface + infers reversibility', () => {
    const c = toCandidate(dateF);
    assert.equal(c.id, 'cap-date');
    assert.equal(c.intent, 'Filter by date posted');
    assert.deepEqual(c.aliases, ['posted today', 'recent postings']);
    assert.equal(c.reversible, true, 'a filter is reversible');
    assert.equal(toCandidate(apply).reversible, false, '"Apply to the job" → irreversible (safety veto applies)');
    assert.equal(toCandidate(null), null);
  });

  it('toCandidate prefers strategy aliases when present', () => {
    const c = toCandidate({ id: 'x', intent: 'Filter by date posted' }, { id: 's', aliases: ['today', 'this week'], groundId: G });
    assert.deepEqual(c.aliases, ['today', 'this week']);
    assert.equal(c.groundId, G, 'groundId falls back to the strategy');
  });

  it('scopeAndPartition splits by Ground/Locale: here / reachable / off', () => {
    const cands = [search, dateF, payF].map((x) => toCandidate(x));
    const { here, reachable, off } = scopeAndPartition(cands, { currentGroundId: G, currentLocaleUrl: RESULTS });
    assert.deepEqual(here.map((c) => c.id).sort(), ['cap-date', 'cap-pay'], 'results-page filters are runnable here');
    assert.deepEqual(reachable.map((c) => c.id), ['cap-search'], 'the homepage search is reachable (other Locale)');
    assert.equal(off.length, 0);
    // a different Ground is dropped
    const other = scopeAndPartition([toCandidate({ id: 'z', groundId: 'ground-linkedin', localeUrl: 'x', intent: 'Search' })], { currentGroundId: G, currentLocaleUrl: RESULTS });
    assert.equal(other.off.length, 1);
    assert.equal(other.here.length + other.reachable.length, 0);
  });

  it('scopeAndPartition honors the injected runnableHere (live precondition seam)', () => {
    const cands = [dateF, payF].map((x) => toCandidate(x));
    const { here, reachable } = scopeAndPartition(cands, { currentGroundId: G, currentLocaleUrl: RESULTS, runnableHere: (c) => c.id === 'cap-date' });
    assert.deepEqual(here.map((c) => c.id), ['cap-date']);
    assert.deepEqual(reachable.map((c) => c.id), ['cap-pay'], 'precondition-failing candidate is not runnable here');
  });

  it('lexicalScore: exact alias → 1; else token overlap', () => {
    assert.equal(lexicalScore('posted today', toCandidate(dateF)).isExact, true);
    assert.equal(lexicalScore('posted today', toCandidate(dateF)).relevance, 1);
    assert.ok(lexicalScore('filter by pay', toCandidate(payF)).relevance > 0.4);
  });

  it('rankAndDecide: an exact alias on a reversible capability → AUTO (alias-exact)', () => {
    const here = [dateF, payF].map((x) => toCandidate(x));
    const r = rankAndDecide('posted today', here);
    assert.equal(r.decision, 'auto');
    assert.equal(r.reason, 'alias-exact');
    assert.equal(r.candidate.id, 'cap-date');
  });

  it('rankAndDecide: an irreversible capability NEVER auto-fires, even on a strong match', () => {
    const here = [apply].map((x) => toCandidate(x));
    const r = rankAndDecide('apply to the job', here);
    assert.equal(r.candidate.id, 'cap-apply');
    assert.equal(r.decision, 'propose');
    assert.equal(r.reason, 'irreversible-confirm', 'safety veto → confirm, not silent fire');
  });

  it('rankAndDecide: no candidates → MISS (no-capability)', () => {
    const r = rankAndDecide('search jobs', []);
    assert.equal(r.decision, 'miss');
    assert.equal(r.reason, 'no-capability');
  });

  it('rankAndDecide: an unrelated ask → MISS (below-floor)', () => {
    const here = [dateF, payF].map((x) => toCandidate(x));
    const r = rankAndDecide('upload my resume pdf', here);
    assert.equal(r.decision, 'miss');
    assert.equal(r.reason, 'below-floor');
  });

  it('rankAndDecide: two close contenders → PROPOSE (ambiguous / disambiguate)', () => {
    // "filter results" overlaps date + pay similarly → small margin → ask which.
    const here = [dateF, payF].map((x) => toCandidate(x));
    const r = rankAndDecide('filter results', here, { thresholds: { ...DEFAULT_THRESHOLDS, margin: 0.5 } });
    assert.equal(r.decision, 'propose');
    assert.equal(r.reason, 'ambiguous');
    assert.ok(r.runnerUp, 'carries the runner-up for the disambiguation copy');
  });

  it('matchAsk: end-to-end funnel scopes to here then decides, with scoped counts', () => {
    const lib = [search, dateF, payF, apply];
    const r = matchAsk('posted today', lib, { currentGroundId: G, currentLocaleUrl: RESULTS });
    assert.equal(r.decision, 'auto');
    assert.equal(r.candidate.id, 'cap-date');
    assert.equal(r.scoped.here, 3, 'date + pay + apply runnable here');
    assert.equal(r.scoped.reachable, 1, 'search is on the homepage Locale');
    // the same ask on the homepage Locale → the filter is not runnable here → MISS distinguishes "needs nav"
    const r2 = matchAsk('posted today', lib, { currentGroundId: G, currentLocaleUrl: 'https://www.indeed.com' });
    assert.equal(r2.decision, 'miss');
    assert.ok(r2.scoped.reachable >= 1, 'the date filter is reachable from another Locale, not a true no-capability');
  });
});
