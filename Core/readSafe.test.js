// Core/readSafe.test.js — §19 Forage: the read-safe allowlist classifier. node --test. PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isReadSafeUrl, classifyAffordance, isReadSafe } from './readSafe.js';

const BASE = 'https://pixabay.com/';

describe('readSafe — isReadSafeUrl', () => {
  it('allows same-site http(s) GET navigations', () => {
    assert.equal(isReadSafeUrl('/videos/', BASE), true);
    assert.equal(isReadSafeUrl('https://pixabay.com/music/', BASE), true);
    assert.equal(isReadSafeUrl('https://cdn.pixabay.com/api/', BASE), true);   // same registrable domain
  });
  it('refuses javascript:/mailto:/#/data:, non-http, off-site, downloads', () => {
    assert.equal(isReadSafeUrl('javascript:void(0)', BASE), false);
    assert.equal(isReadSafeUrl('mailto:x@y.com', BASE), false);
    assert.equal(isReadSafeUrl('#section', BASE), false);
    assert.equal(isReadSafeUrl('https://google.com/', BASE), false);          // off-site
    assert.equal(isReadSafeUrl('/files/photo.jpg', BASE), false);             // download
    assert.equal(isReadSafeUrl('', BASE), false);
  });
});

describe('readSafe — classifyAffordance (the allowlist + EX-1 veto)', () => {
  it('vetoes destructive + write labels FIRST, even on an anchor', () => {
    assert.deepEqual(classifyAffordance({ label: 'Delete account', href: '/account/delete' }, BASE), { safe: false, class: 'unsafe', reason: 'destructive-label' });
    assert.equal(classifyAffordance({ label: 'Buy now', href: '/checkout' }, BASE).safe, false);
    assert.equal(classifyAffordance({ label: 'Upload', href: '/upload' }, BASE).reason, 'write-label');
    assert.equal(classifyAffordance({ label: 'Subscribe', href: '/sub' }, BASE).safe, false);
  });
  it('vetoes an UNLABELLED destructive/auth GET link by PATH (icon-only /logout, /checkout)', () => {
    assert.equal(classifyAffordance({ href: '/logout' }, BASE).reason, 'destructive-path');          // no label → label vetoes skip; path catches it
    assert.equal(classifyAffordance({ href: '/account/deactivate/' }, BASE).reason, 'destructive-path');
    assert.equal(classifyAffordance({ label: '', href: '/checkout' }, BASE).safe, false);
    assert.equal(classifyAffordance({ href: '/help/how-to-delete-account' }, BASE).class, 'nav');     // "delete" mid-segment → NOT vetoed (a read article)
  });
  it('a search input is read-safe (search class)', () => {
    assert.deepEqual(classifyAffordance({ role: 'searchbox', label: 'Search' }, BASE), { safe: true, class: 'search', reason: 'search-input' });
    assert.equal(classifyAffordance({ tag: 'input', type: 'search' }, BASE).class, 'search');
  });
  it('classifies read-safe nav by hint: nav / filter / paginate / detail', () => {
    assert.equal(classifyAffordance({ label: 'Videos', href: '/videos/' }, BASE).class, 'nav');
    assert.equal(classifyAffordance({ label: 'Nature', href: '/images/search/?category=nature' }, BASE).class, 'filter');
    assert.equal(classifyAffordance({ label: 'Next', href: '/images/search/?page=2' }, BASE).class, 'paginate');
    assert.equal(classifyAffordance({ label: 'A photo', href: '/photos/sunset-1234567/' }, BASE).class, 'detail');
  });
  it('an hrefless button is NOT read-safe (background-nav drives URLs only)', () => {
    assert.equal(classifyAffordance({ label: 'Load more', role: 'button' }, BASE).safe, false);   // XHR poke is a deferred slice
    assert.equal(isReadSafe({ label: 'Photos', href: '/photos/' }, BASE), true);
  });
});
