// Core/siteMap.test.js — EX-7 pagesForAsk unit tests (node --test). PURE: synthetic siteMaps.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pagesForAsk, siteMapFromLocale } from './siteMap.js';

// Minimal archetype node (only the fields pagesForAsk reads).
const node = (o) => ({
  id: o.id, urlPattern: o.urlPattern, name: o.name ?? o.urlPattern,
  goals: o.goals ?? [], status: o.status ?? 'discovered', pageType: o.pageType ?? null,
  exemplarUrl: o.exemplarUrl ?? null, instances: o.instances ?? [],
});

const SM = () => ({
  nodes: {
    search: node({ id: 'a_search', urlPattern: 'https://acme.com/jobs/search', name: 'Job search', status: 'modeled', goals: ['Search jobs by keyword', 'Filter by salary'] }),
    detail: node({ id: 'a_job', urlPattern: 'https://acme.com/jobs/{id}', name: 'Job posting', status: 'discovered', exemplarUrl: 'https://acme.com/jobs/12345' }),
    blog:   node({ id: 'a_blog', urlPattern: 'https://acme.com/blog/{slug}', name: 'Blog', status: 'discovered' }),
    about:  node({ id: 'a_about', urlPattern: 'https://acme.com/about', name: 'About us', status: 'stub' }),
  },
});

describe('pagesForAsk — EX-7 ask → page selection', () => {
  it('ranks a goal-bearing modeled node above a url-only node (goal weight 3 > url weight 2)', () => {
    const hits = pagesForAsk(SM(), 'search for engineering jobs');
    assert.equal(hits[0].id, 'a_search');                 // goal "Search jobs…" → 3+3
    assert.ok(hits[0].score > hits[1].score);
    assert.equal(hits[1].id, 'a_job');                    // url segment "jobs" → 2
    assert.deepEqual(hits[0].matched, ['jobs', 'search']);
  });

  it('selects an UNEXPLORED node by url/name alone (the auto-explore use case)', () => {
    // 'blog' node has NO goals — only matchable via its name/url; matchSiteCapabilities can't see it.
    const hits = pagesForAsk(SM(), 'read a blog post', { status: 'discovered' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 'a_blog');
    assert.equal(hits[0].status, 'discovered');
    assert.deepEqual(hits[0].matched, ['blog']);
  });

  it('status filter restricts the pool (discovered-only excludes the modeled node)', () => {
    const hits = pagesForAsk(SM(), 'jobs', { status: 'discovered' });
    assert.deepEqual(hits.map((h) => h.id), ['a_job']);   // a_search is modeled → excluded
  });

  it('carries exemplarUrl (concrete page to navigate to) through', () => {
    const hits = pagesForAsk(SM(), 'jobs', { status: 'discovered' });
    assert.equal(hits[0].exemplarUrl, 'https://acme.com/jobs/12345');
  });

  it('intentCover = matched / ask-token count', () => {
    const hits = pagesForAsk(SM(), 'search jobs');         // both tokens hit a_search
    const s = hits.find((h) => h.id === 'a_search');
    assert.equal(s.intentCover, 1);
    const d = hits.find((h) => h.id === 'a_job');          // only "jobs" hits a_job (1/2)
    assert.equal(d.intentCover, 0.5);
  });

  it('minScore drops weak matches; limit caps the list', () => {
    const strong = pagesForAsk(SM(), 'jobs', { minScore: 3 });
    assert.deepEqual(strong.map((h) => h.id), ['a_search']);  // a_job scores 2 (<3) → dropped
    assert.equal(pagesForAsk(SM(), 'jobs search blog', { limit: 1 }).length, 1);
  });

  it('ignores stopwords and stripped url {placeholders}', () => {
    assert.deepEqual(pagesForAsk(SM(), 'the a of'), []);   // all stopwords → no tokens
    assert.deepEqual(pagesForAsk(SM(), 'id'), []);         // "{id}"/"{slug}" are stripped → no url token "id"
  });

  it('is deterministic on score ties (→ intentCover → status → urlPattern)', () => {
    const sm = { nodes: {
      z: node({ id: 'z', urlPattern: 'https://x.com/zeta/jobs', status: 'discovered' }),
      a: node({ id: 'a', urlPattern: 'https://x.com/alpha/jobs', status: 'discovered' }),
    } };
    const hits = pagesForAsk(sm, 'jobs');
    assert.deepEqual(hits.map((h) => h.urlPattern), ['https://x.com/alpha/jobs', 'https://x.com/zeta/jobs']);
  });

  it('degrades gracefully on empty / malformed input', () => {
    assert.deepEqual(pagesForAsk(null, 'jobs'), []);
    assert.deepEqual(pagesForAsk({}, 'jobs'), []);
    assert.deepEqual(pagesForAsk({ nodes: {} }, 'jobs'), []);
    assert.deepEqual(pagesForAsk(SM(), ''), []);
  });

  // Integration: run over a REAL siteMapFromLocale output (guards builder↔selector field drift).
  it('works on a siteMap built from a Locale (modeled self + discovered nav target)', () => {
    const locale = {
      url: 'https://acme.com/jobs/search', title: 'Job search',
      goals: { g1: { label: 'Search jobs by keyword' } },
      features: { nav1: { id: 'nav1', kind: 'navigation', href: 'https://acme.com/jobs/12345', label: 'View job' } },
    };
    const sm = siteMapFromLocale(locale, { localeKey: 'k' });
    const hits = pagesForAsk(sm, 'search jobs');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].status, 'modeled');
    assert.match(hits[0].urlPattern, /\/jobs\/search$/);
  });
});

describe('siteMapFromLocale — self-derived locale collapse (multi-language fix, v2.74.855)', () => {
  const nav = (id, href, label) => ({ id, kind: 'navigation', href, label });

  it('collapses language variants into ONE /{locale}/… archetype from the page nav, with NO external rules', () => {
    // An /en/jobs page whose language switcher links /de/jobs + /fr/jobs (and en/de about).
    const locale = {
      url: 'https://acme.com/en/jobs', title: 'Jobs', goals: {},
      features: {
        n1: nav('n1', 'https://acme.com/de/jobs', 'Deutsch'),
        n2: nav('n2', 'https://acme.com/fr/jobs', 'Français'),
        n3: nav('n3', 'https://acme.com/en/about', 'About'),
        n4: nav('n4', 'https://acme.com/de/about', 'Über'),
      },
    };
    const sm = siteMapFromLocale(locale, { localeKey: 'k' });
    // the modeled self node collapsed to /{locale}/jobs (NOT /en/jobs)
    const self = Object.values(sm.nodes).find((n) => n.status === 'modeled');
    assert.match(self.urlPattern, /\/\{locale\}\/jobs$/);
    // /de/jobs + /fr/jobs did NOT become separate archetypes — exactly ONE …/jobs node
    assert.equal(Object.values(sm.nodes).filter((n) => /\/jobs$/.test(n.urlPattern)).length, 1);
    // the derived {locale} rule is returned so the merge can persist it (accumulation)
    assert.ok(sm.templateRules.some((r) => /\{locale\}/.test(r)));
  });

  it('preserves passed-in rules (accumulation) and tolerates a nav-less page', () => {
    const sm = siteMapFromLocale({ url: 'https://x.com/a', features: {} }, { rules: ['https://x.com/{locale}/foo'] });
    assert.ok(sm.templateRules.includes('https://x.com/{locale}/foo'));   // authoritative rule kept
    assert.equal(Object.values(sm.nodes).length, 1);                       // the page itself, no crash
  });

  it('does NOT over-collapse a single-language page (no false {locale})', () => {
    const locale = {
      url: 'https://acme.com/en/jobs', title: 'Jobs', goals: {},
      features: { n1: nav('n1', 'https://acme.com/en/about', 'About'), n2: nav('n2', 'https://acme.com/en/teams', 'Teams') },
    };
    const sm = siteMapFromLocale(locale, { localeKey: 'k' });
    // only one locale present → no mirroring → 'en' stays literal, no {locale} rule
    const self = Object.values(sm.nodes).find((n) => n.status === 'modeled');
    assert.match(self.urlPattern, /\/en\/jobs$/);
    assert.ok(!sm.templateRules.some((r) => /\{locale\}/.test(r)));
  });
});
