// Core/orchMatch.test.js — ORCH-M0 unit tests (node --test). PURE.
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness (shim describe/it).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toCandidate, scopeAndPartition, lexicalScore, rankAndDecide, matchAsk, DEFAULT_THRESHOLDS, accreteAlias, removeAlias, normalizeAliasPhrase, scoresToScorer, validateBindings, promotionBonus, tallyCapabilityConfirmations, localeAffordanceLabels } from './orchMatch.js';

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

  it('lexicalScore: intent-exact → 1 beats alias-exact → 0.95 (the intent is the authority)', () => {
    assert.equal(lexicalScore('filter by date posted', toCandidate(dateF)).relevance, 1, 'intent-exact');
    assert.equal(lexicalScore('posted today', toCandidate(dateF)).relevance, 0.95, 'alias-exact (< intent)');
    assert.equal(lexicalScore('posted today', toCandidate(dateF)).isExact, true);
    assert.ok(lexicalScore('show recent stuff', toCandidate(dateF)).relevance < 0.95, 'fuzzy < exact');
  });

  it('rankAndDecide: an intent-exact capability beats one POISONED with the ask as an alias (the live bug)', () => {
    // "Search for music" wrongly accreted "search for sound effects" as an alias; "Search for sound effects" is real.
    const music = toCandidate({ id: 'music', groundId: G, localeUrl: RESULTS, intent: 'Search for music', aliases: ['search for sound effects'], params: [] });
    const sfx = toCandidate({ id: 'sfx', groundId: G, localeUrl: RESULTS, intent: 'Search for sound effects', aliases: [], params: [] });
    const r = rankAndDecide('search for sound effects', [music, sfx]);
    assert.equal(r.candidate.id, 'sfx', 'the correctly-named capability wins over the poisoned alias');
    assert.equal(r.decision, 'auto');
  });

  it('removeAlias: strips a phrase case-insensitively (de-poison)', () => {
    assert.deepEqual(removeAlias(['search for sound effects', 'find music'], 'Search For Sound Effects'), ['find music']);
    assert.deepEqual(removeAlias(['a'], 'b'), ['a']);
    assert.deepEqual(removeAlias(null, 'x'), []);
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

  it('accreteAlias: confirmed phrasings accrete; dedup, skip-if-in-intent, cap (ORCH-D)', () => {
    const intent = 'Filter by date posted';
    let a = [];
    a = accreteAlias(a, 'posted today', { intent });
    assert.deepEqual(a, ['posted today']);
    a = accreteAlias(a, 'Posted Today', { intent });            // dedup (case-insensitive, normalized)
    assert.deepEqual(a, ['posted today']);
    a = accreteAlias(a, 'filter by date', { intent });          // tokens ⊆ intent → skip (already covered)
    assert.deepEqual(a, ['posted today']);
    a = accreteAlias(a, 'recent postings', { intent });
    assert.deepEqual(a, ['posted today', 'recent postings']);
    a = accreteAlias(a, '', { intent });                        // empty → no-op
    assert.equal(a.length, 2);
    // cap keeps the most-recent `max`
    let big = [];
    for (let i = 0; i < 15; i++) big = accreteAlias(big, `phrase number ${i}`, { intent, max: 5 });
    assert.equal(big.length, 5);
    assert.equal(big[big.length - 1], 'phrase number 14');
    assert.equal(normalizeAliasPhrase('  Posted   TODAY '), 'posted today');
  });

  it('scoresToScorer: LLM ratings drive relevance; unrated → 0; exact alias still pins to 1 (ORCH-M)', () => {
    const scorer = scoresToScorer([{ id: 'cap-date', relevance: 0.8, effectEligible: true }, { id: 'cap-pay', relevance: 0.2, effectEligible: false }]);
    assert.equal(scorer('x', toCandidate(dateF)).relevance, 0.8);
    assert.equal(scorer('x', toCandidate(payF)).effectEligible, false, 'LLM can disqualify on effect');
    assert.equal(scorer('x', toCandidate(search)).relevance, 0, 'an unrated candidate scores 0');
    // an exact alias pins to 1 even if the model under-rated it
    const low = scoresToScorer([{ id: 'cap-date', relevance: 0.1, effectEligible: true }]);
    const r = low('posted today', toCandidate(dateF));   // alias-exact pins to ≥0.95 even if the LLM under-rated
    assert.equal(r.isExact, true);
    assert.equal(r.relevance, 0.95);
    // intent-exact pins to 1 regardless of LLM
    assert.equal(low('filter by date posted', toCandidate(dateF)).relevance, 1);
  });

  it('validateBindings: option must resolve in vocabulary (snap exact); text accepted; misses → gaps (ORCH-M)', () => {
    const cand = { id: 'c', params: [
      { name: 'KEYWORD', kind: 'text', used: true },
      { name: 'DATE', kind: 'option', used: true, vocabulary: ['Today', 'Last 3 days', 'Last 7 days'] },
    ] };
    const ok = validateBindings({ KEYWORD: 'developer', DATE: 'last 3 days' }, cand);
    assert.equal(ok.bound.KEYWORD, 'developer');
    assert.equal(ok.bound.DATE, 'Last 3 days', 'snapped to the exact captured label (case-insensitive match)');
    assert.equal(ok.gaps.length, 0);
    const bad = validateBindings({ DATE: 'last hour' }, cand);
    assert.ok(!('DATE' in bad.bound), 'an out-of-vocabulary option is NOT applied');
    assert.deepEqual(bad.gaps, [{ name: 'DATE', requested: 'last hour', reason: 'not-in-vocabulary' }]);
    const empty = validateBindings({ KEYWORD: '' }, cand);
    assert.equal(Object.keys(empty.bound).length, 0, 'an empty value is left to its default');
  });

  it('promotionBonus + tallyCapabilityConfirmations: confirmations accrue, decay, cap (ORCH-G)', () => {
    assert.equal(promotionBonus({ successes: 0 }), 0);
    assert.ok(Math.abs(promotionBonus({ successes: 1 }) - 0.06) < 1e-9);
    assert.equal(promotionBonus({ successes: 5 }), 0.2, 'capped at max (0.2 — precision-first)');
    assert.equal(promotionBonus({ successes: 50 }), 0.2, 'capped at max');
    const now = 100 * 2592000000;
    assert.ok(Math.abs(promotionBonus({ successes: 5, lastOkAt: now - 2592000000 }, { now }) - 0.1) < 1e-6, 'one half-life → half');
    // tally counts ONLY confirmed:true for the id (the DERIVE-time accept doesn't inflate health)
    const events = [
      { detail: { capabilityId: 'c1', confirmed: true }, ts: 10 },
      { detail: { capabilityId: 'c1' } },
      { detail: { capabilityId: 'c2', confirmed: true }, ts: 5 },
      { detail: { capabilityId: 'c1', confirmed: true }, ts: 30 },
    ];
    const h = tallyCapabilityConfirmations(events, 'c1');
    assert.equal(h.successes, 2);
    assert.equal(h.lastOkAt, 30);
  });

  it('rankAndDecide: confirmations promote a propose → auto; reversibility veto still wins (ORCH-G)', () => {
    const fixed = (rel) => () => ({ relevance: rel, isExact: false, effectEligible: true });
    const fresh = toCandidate(dateF);
    assert.equal(rankAndDecide('x', [fresh], { score: fixed(0.45) }).decision, 'propose', 'fresh @0.45 → propose');
    const seasoned = { ...toCandidate(dateF), health: { successes: 5, lastOkAt: 0 } };
    const r2 = rankAndDecide('x', [seasoned], { score: fixed(0.45) });
    assert.equal(r2.decision, 'auto');
    assert.equal(r2.reason, 'promoted', 'health lowered the auto bar → auto-fire');
    const irr = { ...toCandidate(apply), health: { successes: 9, lastOkAt: 0 } };
    const r3 = rankAndDecide('x', [irr], { score: fixed(0.9) });
    assert.equal(r3.decision, 'propose');
    assert.equal(r3.reason, 'irreversible-confirm', 'an irreversible capability never autos, however confirmed');
  });

  it('localeAffordanceLabels: extracts the Locale catalog labels (ORCH-A)', () => {
    const locale = { features: {
      f1: { label: 'Illustrations', kind: 'navigation', selector: '#ill' },
      f2: { label: 'Vectors', kind: 'navigation', selector: '#vec' },
      f3: { label: 'Search', kind: 'input', selector: '#q' },
      f4: { label: '', selector: '#x' },              // no label → skipped
      f5: { kind: 'content' },                        // no label, no selector → skipped
      f6: { label: 'Illustrations', selector: '#dup' }, // dup label → skipped
    } };
    const labels = localeAffordanceLabels(locale);
    assert.ok(labels.includes('Illustrations') && labels.includes('Vectors') && labels.includes('Search'));
    assert.equal(labels.filter((l) => l === 'Illustrations').length, 1, 'deduped');
    assert.deepEqual(localeAffordanceLabels(null), []);
  });

  it('validateBindings + Locale: an option the captured vocab missed but the PAGE catalogs is accepted (ORCH-A)', () => {
    // capability demonstrated for "Vectors" — its captured vocab never saw "Illustrations"
    const cand = { id: 'c', params: [{ name: 'CATEGORY', kind: 'option', used: true, vocabulary: ['Vectors', 'Videos'] }] };
    // without the Locale → a gap (anti-hallucination holds)
    const noLocale = validateBindings({ CATEGORY: 'Illustrations' }, cand);
    assert.deepEqual(noLocale.gaps, [{ name: 'CATEGORY', requested: 'Illustrations', reason: 'not-in-vocabulary' }]);
    assert.ok(!('CATEGORY' in noLocale.bound));
    // WITH the Locale confirming "Illustrations" is a real affordance → bound (snapped to the Locale's casing)
    const withLocale = validateBindings({ CATEGORY: 'illustrations' }, cand, ['Photos', 'Illustrations', 'Vectors', 'Videos', 'Music']);
    assert.equal(withLocale.bound.CATEGORY, 'Illustrations');
    assert.equal(withLocale.gaps.length, 0);
    // a value the page does NOT have is still a gap
    assert.ok(validateBindings({ CATEGORY: 'Sculptures' }, cand, ['Photos', 'Vectors']).gaps.length === 1);
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
