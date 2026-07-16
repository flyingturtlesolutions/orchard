// Core/orchMatch.test.js — ORCH-M0 unit tests (node --test). PURE.
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness (shim describe/it).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toCandidate, scopeAndPartition, lexicalScore, rankAndDecide, matchAsk, DEFAULT_THRESHOLDS, accreteAlias, removeAlias, normalizeAliasPhrase, scoresToScorer, validateBindings, promotionBonus, tallyCapabilityConfirmations, localeAffordanceLabels, isOrphanCapability, capabilitySignature, findDuplicateCapabilities } from './orchMatch.js';

describe('orchMatch — GA-6 structural-twin capability dedup (detection)', () => {
  const mk = (id, intent, sel, shape = 'act', url = 'https://x.com/p') => ({ id, intent, shape, localeUrl: url, binding: sel.map((s) => ({ selector: s })) });
  it('capabilitySignature is value-independent: same binding + shape + page → same signature regardless of intent/order', () => {
    assert.equal(capabilitySignature(mk('a', 'search for remote jobs', ['#kw', '#loc'])),
                 capabilitySignature(mk('b', 'find jobs near me',      ['#loc', '#kw'])));
  });
  it('different page, shape, or targets → different signature', () => {
    const a = mk('a', 'search', ['#kw']);
    assert.notEqual(capabilitySignature(a), capabilitySignature(mk('b', 'search', ['#kw'], 'read')));        // shape differs
    assert.notEqual(capabilitySignature(a), capabilitySignature(mk('c', 'search', ['#kw'], 'act', '/q')));   // page differs
    assert.notEqual(capabilitySignature(a), capabilitySignature(mk('d', 'search', ['#other'])));             // target differs
  });
  it('a landmark selector wins over the raw selector for the fingerprint', () => {
    const a = { id: 'a', shape: 'act', localeUrl: 'u', binding: [{ selector: 'div:nth-child(3)', landmark: { selector: '#kw' } }] };
    const b = { id: 'b', shape: 'act', localeUrl: 'u', binding: [{ selector: '#kw' }] };
    assert.equal(capabilitySignature(a), capabilitySignature(b));
  });
  it('no fingerprintable binding → empty signature → never twinned', () => {
    assert.equal(capabilitySignature({ id: 'a', shape: 'act', binding: [] }), '');
    assert.equal(capabilitySignature({ id: 'b', shape: 'act' }), '');
  });
  it('findDuplicateCapabilities groups twins (>=2), ignores singletons + unfingerprintable', () => {
    const groups = findDuplicateCapabilities([
      mk('a', 'search for jobs', ['#kw']),
      mk('b', 'find jobs',       ['#kw']),            // twin of a
      mk('c', 'read salary',     ['#sal'], 'read'),   // singleton
      { id: 'd', shape: 'act', binding: [] },         // unfingerprintable
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].capabilities.map((c) => c.id).sort(), ['a', 'b']);
  });
});

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

  it('rankAndDecide: a single bare token with NO vocabulary overlap → MISS (no-intent-signal), even at a confident score', () => {
    // "the search box swallows everything" (v2.74.1018): the live LLM rated junk "gch" 0.85 and bound it as the
    // search query → a confident "want me to run it?" on gibberish. A lone token sharing no vocab with the
    // capability is only being absorbed as a param VALUE, not expressing the intent → demote to MISS.
    const here = [search].map((x) => toCandidate(x));                       // "Search jobs by keyword and location"
    const hot = () => ({ relevance: 0.85, isExact: false, effectEligible: true });   // an over-generous (LLM-like) scorer
    const r = rankAndDecide('gch', here, { score: hot });
    assert.equal(r.decision, 'miss');
    assert.equal(r.reason, 'no-intent-signal');
  });

  it('rankAndDecide: the precision guard is TIGHT — overlapping or multi-token asks still fire', () => {
    const here = [search].map((x) => toCandidate(x));                       // intent tokens: search, jobs, keyword, location
    const hot = () => ({ relevance: 0.85, isExact: false, effectEligible: true });
    assert.equal(rankAndDecide('jobs', here, { score: hot }).decision, 'auto', 'a single token that IS in the intent → real signal, fires');
    assert.equal(rankAndDecide('gch gch', here, { score: hot }).decision, 'auto', 'guard is single-token only — multi-token left to scorer/floor');
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

  it('v1538/1539 — validateBindings: substring snap + VARIANT collapse (the "<Name> - <NNN>" / "… All" pair); real ambiguity stays a gap', () => {
    // The ask names the option the HUMAN way; the captured vocabulary the PAGE way — and VendorSuite lists EVERY
    // division TWICE ("Greensboro - 118" + "Greensboro - 118 All"), so a bare name matches BOTH variants. The
    // shortest-is-a-prefix-of-the-rest rule collapses variants of ONE option (snap to the shortest — the same
    // tie-break CLICK_BY_LABEL applies live); different options sharing a word ("Atlanta") stay a gap.
    const cand = { id: 'c', params: [
      { name: 'DIVISION', kind: 'option', used: true, vocabulary: ['Raleigh - 495', 'Greensboro - 118', 'Greensboro - 118 All', 'Atlanta West - 210', 'Atlanta West - 210 All', 'Atlanta East City - 214', 'Mobile - 223'] },
    ] };
    const snap = validateBindings({ DIVISION: 'greensboro' }, cand);
    assert.equal(snap.bound.DIVISION, 'Greensboro - 118', 'both variants of ONE division collapse to the shortest');
    assert.equal(snap.gaps.length, 0);
    const full = validateBindings({ DIVISION: 'atlanta west' }, cand);
    assert.equal(full.bound.DIVISION, 'Atlanta West - 210', 'a fuller name collapses its own variant pair the same way');
    const ambi = validateBindings({ DIVISION: 'Atlanta' }, cand);
    assert.ok(!('DIVISION' in ambi.bound), 'a value matching DIFFERENT options (West vs East City) is never guessed');
    assert.deepEqual(ambi.gaps, [{ name: 'DIVISION', requested: 'Atlanta', reason: 'ambiguous-in-vocabulary' }]);
    const short = validateBindings({ DIVISION: 'Ra' }, cand);
    assert.ok(!('DIVISION' in short.bound), 'a <3-char value never substring-snaps (spurious-match guard)');
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

  it('ORCH-FB: a rejection nets against confirmations → the auto-fire boost drops', () => {
    const events = [
      { detail: { capabilityId: 'c1', confirmed: true }, ts: 10 },
      { detail: { capabilityId: 'c1', confirmed: true }, ts: 20 },
      { detail: { capabilityId: 'c1', rejected: true }, ts: 30 },   // user flagged a wrong run
    ];
    const h = tallyCapabilityConfirmations(events, 'c1');
    assert.equal(h.successes, 2);
    assert.equal(h.rejections, 1);
    assert.ok(Math.abs(promotionBonus(h) - 0.06) < 1e-9, '2 confirms − 1 reject = 1 net → 0.06 bonus');
    assert.equal(promotionBonus({ successes: 2, rejections: 5 }), 0, 'more rejections than confirms → no boost');
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

describe('orchMatch — T3X crossGround partition (global scope)', () => {
  const G2 = 'ground-notion';
  const save = { id: 'cap-save', groundId: G2, localeUrl: 'https://www.notion.so', intent: 'Save a page', strategyId: 's5', params: [], aliases: ['save to notion'] };

  it('default (within-Ground) DROPS off-Ground candidates to off', () => {
    const cands = [dateF, save].map((x) => toCandidate(x));
    const { here, reachable, off } = scopeAndPartition(cands, { currentGroundId: G, currentLocaleUrl: RESULTS });
    assert.deepEqual(off.map((c) => c.id), ['cap-save'], 'the off-Ground Notion cap is dropped (T1/T2)');
    assert.deepEqual(here.map((c) => c.id), ['cap-date']);
    assert.equal(reachable.length, 0);
  });

  it('crossGround:true KEEPS the off-Ground candidate as reachable (a Ground hop)', () => {
    const cands = [dateF, save].map((x) => toCandidate(x));
    const { here, reachable, off } = scopeAndPartition(cands, { currentGroundId: G, currentLocaleUrl: RESULTS, crossGround: true });
    assert.equal(off.length, 0, 'nothing dropped under global scope');
    assert.ok(reachable.some((c) => c.id === 'cap-save'), 'the Notion cap is reachable via a Ground hop');
    assert.deepEqual(here.map((c) => c.id), ['cap-date'], 'same-Ground same-Locale still runnable here');
  });

  it('no currentGroundId → nothing is off (the cross-Ground catalog ranks everything)', () => {
    const cands = [dateF, save].map((x) => toCandidate(x));
    assert.equal(scopeAndPartition(cands, { crossGround: true }).off.length, 0);
  });
});

describe('orchMatch — isOrphanCapability (backing Tier-1 record deleted)', () => {
  const liveStrategyIds = new Set(['strat-live']);
  const liveFragmentIds = new Set(['frag-live']);
  it('STRATEGY-cap: orphan iff its strategyId is gone', () => {
    assert.equal(isOrphanCapability({ strategyId: 'strat-live' }, { liveStrategyIds, liveFragmentIds }), false, 'live strategy → not orphan');
    assert.equal(isOrphanCapability({ strategyId: 'strat-dead' }, { liveStrategyIds, liveFragmentIds }), true, 'deleted strategy → orphan');
  });
  it('FRAGMENT-cap: orphan iff its fragmentId is gone (THE FIX — was unchecked)', () => {
    assert.equal(isOrphanCapability({ fragmentId: 'frag-live' }, { liveStrategyIds, liveFragmentIds }), false, 'live fragment → not orphan');
    assert.equal(isOrphanCapability({ fragmentId: 'frag-dead' }, { liveStrategyIds, liveFragmentIds }), true, 'deleted fragment → orphan');
  });
  it('strategyId is checked FIRST (a strategy-cap that also names an entry fragment)', () => {
    // live strategy but its fragmentId is NOT in the live set → still NOT an orphan (identity = the Strategy).
    assert.equal(isOrphanCapability({ strategyId: 'strat-live', fragmentId: 'frag-dead' }, { liveStrategyIds, liveFragmentIds }), false);
  });
  it('NULL live-set (failed read) → NOT an orphan (precision-first, never hide a real cap)', () => {
    assert.equal(isOrphanCapability({ strategyId: 'strat-dead' }, { liveStrategyIds: null, liveFragmentIds }), false);
    assert.equal(isOrphanCapability({ fragmentId: 'frag-dead' }, { liveStrategyIds, liveFragmentIds: null }), false);
    assert.equal(isOrphanCapability({ fragmentId: 'frag-dead' }), false, 'no live-sets at all → not orphan');
  });
  it('a cap with NEITHER id (e.g. an Observation) is never an orphan', () => {
    assert.equal(isOrphanCapability({ kind: 'observation', observe: {} }, { liveStrategyIds, liveFragmentIds }), false);
    assert.equal(isOrphanCapability(null, { liveStrategyIds, liveFragmentIds }), false);
  });
});

describe('orchMatch — isOrphanCapability DEEP (live strategy, but a CONSTITUENT fragment was deleted) [v2.74.889]', () => {
  // The "missing a step" surprise: the Strategy RECORD still exists, so the shallow strategyId check passes,
  // but one of the fragments it chains was deleted in Studio / a side panel / a bulk ORCH_ADMIN purge.
  // strategyFragments maps strategyId → its constituent fragmentIds (via collectReferencedPrimitiveIds).
  const liveStrategyIds = new Set(['strat-whole', 'strat-broken']);
  const liveFragmentIds = new Set(['frag-A', 'frag-B']); // frag-C was deleted
  const strategyFragments = new Map([
    ['strat-whole', ['frag-A', 'frag-B']],  // every constituent still live
    ['strat-broken', ['frag-A', 'frag-C']], // frag-C is gone
  ]);
  it('all constituents live → NOT an orphan', () => {
    assert.equal(isOrphanCapability({ strategyId: 'strat-whole' }, { liveStrategyIds, liveFragmentIds, strategyFragments }), false);
  });
  it('a deleted constituent fragment → ORPHAN (THE deletion-gap fix — was silently HIT, then died "missing a step")', () => {
    assert.equal(isOrphanCapability({ strategyId: 'strat-broken' }, { liveStrategyIds, liveFragmentIds, strategyFragments }), true);
  });
  it('a deleted STRATEGY record still wins (shallow check fires before the deep one)', () => {
    assert.equal(isOrphanCapability({ strategyId: 'strat-gone' }, { liveStrategyIds, liveFragmentIds, strategyFragments }), true);
  });
  it('liveFragmentIds null (failed fragment read) → deep check SKIPPED, not an orphan (precision-first)', () => {
    assert.equal(isOrphanCapability({ strategyId: 'strat-broken' }, { liveStrategyIds, liveFragmentIds: null, strategyFragments }), false);
  });
  it('no strategyFragments map (legacy caller) → deep check SKIPPED, falls back to strategyId-only', () => {
    assert.equal(isOrphanCapability({ strategyId: 'strat-broken' }, { liveStrategyIds, liveFragmentIds }), false);
  });
  it('strategy with no constituent entry (undefined in the map) → NOT an orphan (nothing to check)', () => {
    assert.equal(isOrphanCapability({ strategyId: 'strat-whole' }, { liveStrategyIds, liveFragmentIds, strategyFragments: new Map() }), false);
  });
});
