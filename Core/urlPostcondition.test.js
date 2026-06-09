// Core/urlPostcondition.test.js — v2.74.885 unit tests (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { urlMatchesWithParams, urlSlug } from './urlPostcondition.js';

describe('urlMatchesWithParams — param-aware url_matches relaxation (v2.74.885)', () => {
  it('relaxes a demo-category postcondition to the BOUND category (the live "cool vectors" gap)', () => {
    // postcondition baked as /videos/ (demo CATEGORY=Videos); run bound CATEGORY=Vectors → page is /vectors/
    assert.equal(urlMatchesWithParams('/videos/', 'https://pixabay.com/vectors/', ['Vectors', 'cool']), true);
  });
  it('slug-normalizes a multi-word category ("Sound Effects" → /sound-effects/)', () => {
    assert.equal(urlMatchesWithParams('/videos/', 'https://pixabay.com/sound-effects/', ['Sound Effects']), true);
  });
  it('passes a pattern that already matches as-is', () => {
    assert.equal(urlMatchesWithParams('/videos/', 'https://pixabay.com/videos/search/fable/', ['fable']), true);
  });
  it('relaxes ALL params at once — category + search (v2.74.886)', () => {
    // "/videos/search/fable/" (demo CATEGORY=Videos, SEARCH=fable) → "/vectors/search/cool/" (bound Vectors, cool)
    assert.equal(urlMatchesWithParams('/videos/search/fable/', 'https://pixabay.com/vectors/search/cool/', ['Vectors', 'cool']), true);
  });
  it('requires the pattern segments CONTIGUOUS in the url (structure must hold)', () => {
    // adjacent "videos/fable" must NOT match a url where /search/ separates them
    assert.equal(urlMatchesWithParams('/videos/fable/', 'https://pixabay.com/vectors/search/cool/', ['Vectors', 'cool']), false);
  });
  it('does NOT relax when no bound value explains the path (a real failure stays failed)', () => {
    assert.equal(urlMatchesWithParams('/videos/', 'https://pixabay.com/jobs/', ['Vectors', 'cool']), false);
    assert.equal(urlMatchesWithParams('/videos/', 'https://example.com/', []), false);
  });
  it('a swap must satisfy a WHOLE path segment (no loose substring match)', () => {
    // bound value "cat" must NOT relax /videos/ to match /category/ — "cat" is not a whole segment there
    assert.equal(urlMatchesWithParams('/videos/', 'https://pixabay.com/category/', ['cat']), false);
  });
  it('ignores tiny bound values (< 3 chars)', () => {
    assert.equal(urlMatchesWithParams('/videos/', 'https://pixabay.com/hi/', ['hi']), false);
  });
  it('urlSlug normalizes case + spaces', () => {
    assert.equal(urlSlug('Sound Effects'), 'sound-effects');
    assert.equal(urlSlug('Vectors'), 'vectors');
  });
});
