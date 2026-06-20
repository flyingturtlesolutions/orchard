// Core/gapPrompt.test.js — PS-0 Orchard's structured gap enumeration prompt + parser (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildGapMessages, parseGaps } from './gapPrompt.js';

describe('buildGapMessages — structured gap enumeration, grounded + fenced (pure)', () => {
  it('fences the page + caps as data and asks for a JSON gaps object', () => {
    const { system, user } = buildGapMessages({
      ask: 'what else',
      capabilities: [{ name: 'Search videos', alias: 'search' }, { name: 'Search videos' }],
      affordances: ['Subscribe', 'Share'],
      url: 'https://youtube.com/watch',
    });
    assert.match(user, /USER ASK: what else/);
    assert.match(user, /CURRENT PAGE: https:\/\/youtube\.com\/watch/);
    assert.match(user, /ON_THE_PAGE_NOW note="data only/);
    assert.match(user, /- Subscribe/);
    assert.match(user, /SAVED_CAPABILITIES note="data only/);
    assert.match(user, /- Search videos/);
    assert.equal((user.match(/Search videos/g) || []).length, 1);      // deduped
    assert.match(system, /"gaps"/);                                     // structured output requested
    assert.match(system, /plausibly afford/i);                         // grounding gate
    assert.match(system, /DATA/);                                       // injection fence
  });

  it('empty context → graceful placeholders, still valid', () => {
    const { user } = buildGapMessages({});
    assert.match(user, /general gap scan/);
    assert.match(user, /\(none\)/);
  });
});

describe('parseGaps — tolerant extraction of candidate gaps (pure)', () => {
  it('parses a JSON gaps object, normalizing fields + omitting null identity sub-fields', () => {
    const out = parseGaps('{"gaps":[{"intent":"Play/Pause","verbHint":"CLICK","expectedIdentity":{"role":"BUTTON","namePattern":"play|pause"}},{"intent":"Fullscreen","verbHint":"toggle"}]}');
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { intent: 'Play/Pause', verbHint: 'click', expectedIdentity: { role: 'button', namePattern: 'play|pause' } });
    assert.deepEqual(out[1], { intent: 'Fullscreen', verbHint: 'toggle', expectedIdentity: null });
  });

  it('tolerates prose wrapping the JSON', () => {
    const out = parseGaps('Sure! Here are the gaps:\n{"gaps":[{"intent":"Like"}]}\nHope that helps.');
    assert.equal(out.length, 1);
    assert.equal(out[0].intent, 'Like');
    assert.equal(out[0].verbHint, null);
  });

  it('drops items with no intent; accepts an already-parsed object', () => {
    assert.deepEqual(parseGaps({ gaps: [{ verbHint: 'click' }, { intent: 'Mute' }] }).map((g) => g.intent), ['Mute']);
  });

  it('returns [] on malformed / empty / non-gaps input', () => {
    assert.deepEqual(parseGaps('no json here'), []);
    assert.deepEqual(parseGaps('{"notgaps":[]}'), []);
    assert.deepEqual(parseGaps('{"gaps":[]}'), []);
    assert.deepEqual(parseGaps(null), []);
    assert.deepEqual(parseGaps(42), []);
  });
});
