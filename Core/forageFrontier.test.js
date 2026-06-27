// Core/forageFrontier.test.js — §19 Forage: the read-safe nav frontier. node --test. PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { forageFrontier, normForVisit } from './forageFrontier.js';

const BASE = 'https://pixabay.com/images/search/cats/';

describe('forageFrontier — normForVisit', () => {
  it('drops hash + sorts query so reorderings dedup', () => {
    assert.equal(normForVisit('/x?b=2&a=1#frag', BASE), normForVisit('/x?a=1&b=2', BASE));
  });
});

describe('forageFrontier — expand the read-safe frontier', () => {
  it('chrome nav (sections) ranks first; filters/paginate/detail follow; search + unsafe dropped', () => {
    const chromeNav = [{ label: 'Videos', href: '/videos/' }, { label: 'Music', href: '/music/' }];
    const links = [
      { label: 'Nature', href: '/images/search/?category=nature' },     // filter
      { label: 'Next', href: '/images/search/cats/?page=2' },           // paginate
      { label: 'A cat photo', href: '/photos/cat-1234567/' },           // detail
      { label: 'Search', role: 'searchbox' },                           // search → dropped
      { label: 'Delete', href: '/x/delete' },                           // unsafe → dropped
      { label: 'Buy', href: '/checkout' },                              // unsafe → dropped
    ];
    const f = forageFrontier({ links, chromeNav, baseUrl: BASE, max: 20 });
    assert.equal(f[0].class, 'nav');                                    // sections first
    assert.equal(f[1].class, 'nav');
    assert.deepEqual(f.map((x) => x.class).slice(2), ['filter', 'paginate', 'detail']);
    assert.ok(!f.some((x) => /delete|checkout/.test(x.url)), 'no unsafe urls');
    assert.ok(!f.some((x) => x.class === 'search'));
  });

  it('caps detail at 3 per expansion (never drowns in detail links)', () => {
    const links = Array.from({ length: 12 }, (_, i) => ({ label: `Photo ${i}`, href: `/photos/img-${1000000 + i}/` }));
    const f = forageFrontier({ links, baseUrl: BASE, max: 50 });
    assert.equal(f.filter((x) => x.class === 'detail').length, 3);
  });

  it('skips already-visited urls (dedup vs the crawl set)', () => {
    const visited = new Set([normForVisit('/videos/', BASE)]);
    const f = forageFrontier({ chromeNav: [{ label: 'Videos', href: '/videos/' }, { label: 'Music', href: '/music/' }], baseUrl: BASE, visited });
    assert.equal(f.length, 1);
    assert.ok(/\/music\//.test(f[0].url));
  });

  it('degrades on empty / garbage', () => {
    assert.deepEqual(forageFrontier({}), []);
    assert.deepEqual(forageFrontier({ links: [null, {}], chromeNav: [null] }), []);
  });
});
