// Core/pageKey.test.js — CR-D1 (v2.74.941): the comparison-time page identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pageKey } from './pageKey.js';

describe('pageKey — origin + pathname, slash-insensitive (CR-D1)', () => {
  it('strips query/fragment and trailing slashes', () => {
    assert.equal(pageKey('https://x.com/jobs?q=a#top'), 'https://x.com/jobs');
    assert.equal(pageKey('https://x.com/jobs/'), 'https://x.com/jobs');
    assert.equal(pageKey('https://x.com/jobs'), 'https://x.com/jobs');
  });
  it('root path collapses to the origin', () => {
    assert.equal(pageKey('https://x.com/'), 'https://x.com');
    assert.equal(pageKey('https://x.com'), 'https://x.com');
  });
  it('unparseable input falls back to a query/hash/slash strip', () => {
    assert.equal(pageKey('not a url/?q=1'), 'not a url');
    assert.equal(pageKey(''), '');
    assert.equal(pageKey(null), '');
  });
});
