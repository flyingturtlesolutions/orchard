// Core/gapRegistry.test.js — PS-0 the capability-gap registry (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  gapKey, normalizeGap, mergeGaps, setStatus, summarizeGaps, serializeGaps, deserializeGaps,
  matchInteractionToGap, recordFulfillment,
} from './gapRegistry.js';

describe('gapRegistry — derive/dedup/age a per-Ground capability-gap registry (pure)', () => {
  it('gapKey is case/punctuation/whitespace-insensitive', () => {
    assert.equal(gapKey('Play/Pause the Video!'), 'play pause the video');
    assert.equal(gapKey('  PLAY   pause  the video  '), 'play pause the video');
    assert.equal(gapKey('play pause the video'), 'play pause the video');
    assert.equal(gapKey(''), '');
    assert.equal(gapKey(null), '');
  });

  it('normalizeGap mints a fresh open gap; drops items with no intent; clamps + parses identity', () => {
    const g = normalizeGap({ intent: 'Play/Pause the video', verbHint: 'CLICK', expectedIdentity: { role: 'BUTTON', namePattern: 'play|pause' } }, 100);
    assert.equal(g.intent, 'Play/Pause the video');
    assert.equal(g.key, 'play pause the video');
    assert.equal(g.verbHint, 'click');                 // lowercased
    assert.deepEqual(g.expectedIdentity, { role: 'button', namePattern: 'play|pause' });
    assert.equal(g.status, 'open');
    assert.equal(g.seenCount, 1);
    assert.equal(g.createdAt, 100);
    assert.equal(g.updatedAt, 100);

    assert.equal(normalizeGap({ intent: '   ' }, 1), null);
    assert.equal(normalizeGap({ verbHint: 'click' }, 1), null);
    assert.equal(normalizeGap({ intent: 'x', expectedIdentity: {} }, 1).expectedIdentity, null);
  });

  it('mergeGaps appends new gaps as open and dedups by normalized key', () => {
    const r1 = mergeGaps([], [{ intent: 'Subscribe to the channel', verbHint: 'click' }], { now: 1 });
    assert.equal(r1.length, 1);
    const r2 = mergeGaps(r1, [{ intent: 'subscribe to the CHANNEL!' }, { intent: 'Toggle fullscreen' }], { now: 2 });
    assert.equal(r2.length, 2);                          // the subscribe re-seen, fullscreen new
    const sub = r2.find((g) => g.key === 'subscribe to the channel');
    assert.equal(sub.seenCount, 2);                      // bumped
    assert.equal(sub.updatedAt, 2);
    assert.equal(sub.verbHint, 'click');                 // kept from the first sighting
  });

  it('mergeGaps NEVER regresses an earned status on re-enumeration', () => {
    let gaps = mergeGaps([], [{ intent: 'Like the video' }], { now: 1 });
    gaps = setStatus(gaps, 'like the video', 'promoted', 5);
    gaps = mergeGaps(gaps, [{ intent: 'Like the video' }], { now: 9 });   // Orchard re-lists it
    const g = gaps.find((x) => x.key === 'like the video');
    assert.equal(g.status, 'promoted');                  // stayed promoted, did NOT reset to open
    assert.equal(g.seenCount, 2);
  });

  it('mergeGaps backfills missing hints from a later sighting', () => {
    let gaps = mergeGaps([], [{ intent: 'Mute' }], { now: 1 });                 // no verbHint
    gaps = mergeGaps(gaps, [{ intent: 'Mute', verbHint: 'click', expectedIdentity: { role: 'button' } }], { now: 2 });
    const g = gaps[0];
    assert.equal(g.verbHint, 'click');
    assert.deepEqual(g.expectedIdentity, { role: 'button' });
  });

  it('mergeGaps caps the registry, evicting open before earned gaps', () => {
    let gaps = [];
    for (let i = 0; i < 5; i++) gaps = mergeGaps(gaps, [{ intent: `open gap ${i}` }], { now: i });
    gaps = setStatus(gaps, 'open gap 0', 'promoted', 10);   // one earned gap, low seenCount/recency
    const capped = mergeGaps(gaps, [{ intent: 'a brand new open gap' }], { now: 20, max: 3 });
    assert.equal(capped.length, 3);
    assert.ok(capped.some((g) => g.status === 'promoted'), 'the promoted gap survives the cap');
  });

  it('setStatus transitions one gap; unknown status is a no-op', () => {
    const gaps = mergeGaps([], [{ intent: 'a' }, { intent: 'b' }], { now: 1 });
    const upd = setStatus(gaps, 'a', 'armed', 7);
    assert.equal(upd.find((g) => g.key === 'a').status, 'armed');
    assert.equal(upd.find((g) => g.key === 'a').updatedAt, 7);
    assert.equal(upd.find((g) => g.key === 'b').status, 'open');
    assert.equal(setStatus(gaps, 'a', 'bogus', 7).find((g) => g.key === 'a').status, 'open');
  });

  it('summarizeGaps tallies by status', () => {
    let gaps = mergeGaps([], [{ intent: 'a' }, { intent: 'b' }, { intent: 'c' }], { now: 1 });
    gaps = setStatus(gaps, 'a', 'promoted', 2);
    gaps = setStatus(gaps, 'b', 'armed', 2);
    assert.deepEqual(summarizeGaps(gaps), { total: 3, open: 1, armed: 1, harvested: 0, promoted: 1, dismissed: 0 });
  });

  it('serialize/deserialize round-trips and drops malformed records', () => {
    const gaps = mergeGaps([], [{ intent: 'Play' }], { now: 1 });
    const round = deserializeGaps(serializeGaps(gaps));
    assert.deepEqual(round, gaps);
    assert.deepEqual(deserializeGaps(null), []);
    assert.deepEqual(deserializeGaps({ gaps: [{ intent: 'no key' }, { key: 'k', intent: 'i', status: 'bogus' }] }), []);
  });
});

describe('gapRegistry PS-1 — passive harvest match + record (pure)', () => {
  const armedGap = (extra = {}) => mergeGaps([], [{ intent: 'Play/Pause the video', verbHint: 'click', expectedIdentity: { role: 'button', namePattern: 'play|pause' }, ...extra }], { now: 1 });

  it('matchInteractionToGap matches an open gap by namePattern (regex), role agreeing or absent', () => {
    const gaps = armedGap();
    assert.equal(matchInteractionToGap({ role: 'button', accessibleName: 'Play (k)' }, gaps), 'play pause the video');
    assert.equal(matchInteractionToGap({ accessibleName: 'Pause (k)' }, gaps), 'play pause the video');   // target role absent → OK
  });

  it('no match: role disagreement, missing name, no expectedIdentity, or non-open status', () => {
    const gaps = armedGap();
    assert.equal(matchInteractionToGap({ role: 'link', accessibleName: 'Play' }, gaps), null);   // role disagrees
    assert.equal(matchInteractionToGap({ accessibleName: 'Share' }, gaps), null);                // name doesn't match the pattern
    assert.equal(matchInteractionToGap({ role: 'button' }, gaps), null);                         // no accessibleName
    assert.equal(matchInteractionToGap({ accessibleName: 'Play' }, mergeGaps([], [{ intent: 'Bare' }], { now: 1 })), null);  // gap has no expectedIdentity
    assert.equal(matchInteractionToGap({ accessibleName: 'Play' }, setStatus(gaps, 'play pause the video', 'harvested', 2)), null);  // only OPEN gaps
  });

  it('falls back to substring (not a crash) when the namePattern is not a valid regex', () => {
    const gaps = mergeGaps([], [{ intent: 'Show more', expectedIdentity: { namePattern: 'more (' } }], { now: 1 });  // unbalanced ( → invalid regex
    assert.equal(matchInteractionToGap({ accessibleName: 'More (5)' }, gaps), 'show more');                          // literal substring still matches
    assert.equal(matchInteractionToGap({ accessibleName: 'More' }, gaps), null);                                    // and degrades safely to no-match
  });

  it('recordFulfillment flips the matched gap to harvested + attaches a VALUE-FREE identity', () => {
    const gaps = recordFulfillment(armedGap(), 'play pause the video', { role: 'BUTTON', accessibleName: 'Play (k)', tagName: 'BUTTON' }, 7);
    const g = gaps.find((x) => x.key === 'play pause the video');
    assert.equal(g.status, 'harvested');
    assert.equal(g.updatedAt, 7);
    assert.deepEqual(g.fulfillment, { role: 'button', accessibleName: 'Play (k)', tagName: 'button', seenAt: 7 });
    assert.equal('value' in g.fulfillment, false);                                   // only the WHERE, never WHAT was typed
  });

  it('recordFulfillment leaves other gaps untouched; a non-matching key is a no-op', () => {
    let gaps = mergeGaps([], [{ intent: 'A' }, { intent: 'B' }], { now: 1 });
    gaps = recordFulfillment(gaps, 'a', { accessibleName: 'A' }, 5);
    assert.equal(gaps.find((g) => g.key === 'a').status, 'harvested');
    assert.equal(gaps.find((g) => g.key === 'b').status, 'open');
    assert.deepEqual(recordFulfillment(gaps, 'zzz', {}, 9), gaps);                    // no-op
  });

  it('a harvested gap survives the serialize round-trip with its fulfillment', () => {
    const gaps = recordFulfillment(armedGap(), 'play pause the video', { role: 'button', accessibleName: 'Play' }, 3);
    assert.deepEqual(deserializeGaps(serializeGaps(gaps)), gaps);
  });
});
