// Core/interactionTrace.test.js — C4 L3 recorder (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeTrace, appendEntry, snapshot, traceStats, eventsFromEntries, TRACE_CAP } from './interactionTrace.js';
import { makeRawInteraction } from './interactionCapture.js';
import { resolveInteraction } from './interactionResolve.js';
import { classifyResolved } from './interactionClassification.js';

const cls = (over = {}) => ({ tier: 'substrate', primary: { semanticVerb: 'click-primary', landmarkUid: 'a' }, ...over });

describe('interactionTrace — C4 session ring of ClassifiedInteractions', () => {
  it('makeTrace defaults: cap 500, empty, seq 0; bad cap → default', () => {
    const t = makeTrace();
    assert.equal(t.cap, TRACE_CAP);
    assert.equal(t.seq, 0);
    assert.deepEqual(t.entries, []);
    assert.equal(makeTrace({ cap: -3 }).cap, TRACE_CAP);
  });

  it('append lifts seq/ts/tabId/groundId/tier/verb beside the verbatim classified', () => {
    const t = makeTrace();
    const e = appendEntry(t, cls(), { ts: 123, tabId: 7, groundId: 'g1' });
    assert.equal(e.seq, 1);
    assert.equal(e.ts, 123);
    assert.equal(e.tabId, 7);
    assert.equal(e.groundId, 'g1');
    assert.equal(e.tier, 'substrate');
    assert.equal(e.verb, 'click-primary');
    assert.equal(e.classified.primary.landmarkUid, 'a');   // payload verbatim
    assert.equal(t.entries.length, 1);
  });

  it('verb falls back primary → candidates[0] → null; tier defaults to unresolved', () => {
    const t = makeTrace();
    assert.equal(appendEntry(t, { candidates: [{ semanticVerb: 'type-query' }] }).verb, 'type-query');
    assert.equal(appendEntry(t, {}).verb, null);
    assert.equal(appendEntry(t, {}).tier, 'unresolved');
  });

  it('invalid appends → null, trace unchanged', () => {
    const t = makeTrace();
    assert.equal(appendEntry(t, null), null);
    assert.equal(appendEntry(null, cls()), null);
    assert.equal(t.entries.length, 0);
    assert.equal(t.seq, 0);
  });

  it('ring trims OLDEST at cap; seq stays monotonic across trims (sinceSeq pulls survive)', () => {
    const t = makeTrace({ cap: 3 });
    for (let i = 0; i < 5; i++) appendEntry(t, cls(), { ts: i });
    assert.equal(t.entries.length, 3);
    assert.deepEqual(t.entries.map((e) => e.seq), [3, 4, 5]);   // 1-2 dropped, numbering NOT reset
  });

  it('snapshot: no filter → all (copy), oldest→newest; tabId/groundId/sinceSeq/limit compose', () => {
    const t = makeTrace();
    appendEntry(t, cls(), { ts: 1, tabId: 1, groundId: 'g1' });
    appendEntry(t, cls(), { ts: 2, tabId: 2, groundId: 'g1' });
    appendEntry(t, cls(), { ts: 3, tabId: 1, groundId: 'g2' });
    appendEntry(t, cls(), { ts: 4, tabId: 1, groundId: 'g1' });
    const all = snapshot(t);
    assert.equal(all.length, 4);
    assert.notEqual(all, t.entries);                            // defensive copy when unfiltered
    assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4]);
    assert.deepEqual(snapshot(t, { tabId: 1 }).map((e) => e.seq), [1, 3, 4]);
    assert.deepEqual(snapshot(t, { groundId: 'g1' }).map((e) => e.seq), [1, 2, 4]);
    assert.deepEqual(snapshot(t, { tabId: 1, groundId: 'g1' }).map((e) => e.seq), [1, 4]);
    assert.deepEqual(snapshot(t, { sinceSeq: 2 }).map((e) => e.seq), [3, 4]);
    assert.deepEqual(snapshot(t, { limit: 2 }).map((e) => e.seq), [3, 4]);   // most-recent tail
    assert.deepEqual(snapshot(null), []);
  });

  it('traceStats: size/cap/seq bounds/byTier tallies', () => {
    const t = makeTrace({ cap: 10 });
    appendEntry(t, cls());
    appendEntry(t, cls({ tier: 'browser' }));
    appendEntry(t, cls());
    const s = traceStats(t);
    assert.equal(s.size, 3);
    assert.equal(s.cap, 10);
    assert.equal(s.firstSeq, 1);
    assert.equal(s.lastSeq, 3);
    assert.deepEqual(s.byTier, { substrate: 2, browser: 1 });
    assert.deepEqual(traceStats(null), { size: 0, cap: 0, firstSeq: null, lastSeq: null, byTier: {} });
  });

  // C5 — the OUTCOMES adapter: trace entries → aggregated durable usage events.
  it('eventsFromEntries AGGREGATES substrate entries per (ground, landmark, verb)', () => {
    const t = makeTrace();
    const sub = (uid, verb, ts, ground = 'g1') =>
      appendEntry(t, { tier: 'substrate', primary: { semanticVerb: verb, landmarkUid: uid, perspectiveId: 'p1' } }, { ts, tabId: 1, groundId: ground });
    sub('lm1', 'click-primary', 10);
    sub('lm1', 'click-primary', 30);
    sub('lm1', 'click-primary', 20);
    sub('lm1', 'type-query', 40);      // same landmark, different verb → own group
    sub('lm2', 'click-primary', 50);   // different landmark → own group
    const evs = eventsFromEntries(snapshot(t));
    assert.equal(evs.length, 3);
    const clicks = evs.find((e) => e.detail.landmarkUid === 'lm1' && e.detail.verb === 'click-primary');
    assert.equal(clicks.op, 'user-interaction');
    assert.equal(clicks.phase, 'runtime');
    assert.equal(clicks.corpusRef, undefined, 'runtime events are not training pairs');
    assert.equal(clicks.groundId, 'g1');
    assert.equal(clicks.perspectiveId, 'p1');
    assert.equal(clicks.detail.count, 3);
    assert.equal(clicks.detail.firstTs, 10);
    assert.equal(clicks.detail.lastTs, 30);
    assert.equal(clicks.ts, 30, 'event ts = the group\'s last interaction');
  });
  it('eventsFromEntries drops non-substrate tiers, ground-less and landmark-less entries', () => {
    const t = makeTrace();
    appendEntry(t, { tier: 'browser', primary: { semanticVerb: 'navigate', landmarkUid: 'lm1' } }, { ts: 1, groundId: 'g1' });
    appendEntry(t, { tier: 'unresolved' }, { ts: 2, groundId: 'g1' });
    appendEntry(t, { tier: 'substrate', primary: { semanticVerb: 'click-primary', landmarkUid: 'lm1' } }, { ts: 3 });          // no groundId
    appendEntry(t, { tier: 'substrate', primary: { semanticVerb: 'click-primary' } }, { ts: 4, groundId: 'g1' });              // no landmarkUid
    assert.deepEqual(eventsFromEntries(snapshot(t)), []);
    assert.deepEqual(eventsFromEntries(null), []);
    assert.deepEqual(eventsFromEntries([]), []);
  });

  // Integration — the FULL pipeline contract: a captured raw event resolves (C3), classifies (C0),
  // and RECORDS (C4); the snapshot returns the classified substrate hit. This is the L0→L3 chain.
  it('raw → resolve → classify → append → snapshot returns the substrate hit (L0→L3)', () => {
    const raw = makeRawInteraction({ interactionKind: 'click', ts: 1, tabId: 1, url: 'https://x.com', target: { tagName: 'button', role: 'button' } });
    const resolved = resolveInteraction(raw, { matches: [{ landmarkUid: 'a', perspectiveId: 'p_a', role: 'button', selector: '#a' }], groundId: 'g', activePerspectiveIds: ['p_a'] });
    const classified = classifyResolved(resolved, { groundId: 'g', activePerspectiveIds: ['p_a'] });
    const t = makeTrace();
    const e = appendEntry(t, classified, { ts: raw.ts, tabId: raw.tabId, groundId: 'g' });
    assert.equal(e.tier, 'substrate');
    const got = snapshot(t, { groundId: 'g' });
    assert.equal(got.length, 1);
    assert.equal(got[0].classified.primary.landmarkUid, 'a');
  });
});
