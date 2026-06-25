// Core/goalStore.test.js — AL-2 (v2.74.1191): the per-app goal-memory store (pure list-ops).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  goalItemKey, goalItemId, addItem, promoteItemInList, removeItem, queryItems, rollupGoalMemory, capItems, consolidateGoalMemory,
} from './goalStore.js';

const belief = (body, over = {}) => ({ kind: 'belief', body, ...over });
const delta = (body, over = {}) => ({ kind: 'delta', body, ...over });

describe('goalStore — content ids', () => {
  it('id/key are content-addressed: same kind+trigger+body → same id; different → different', () => {
    assert.equal(goalItemId(belief('Acme is enterprise')), goalItemId(belief('acme IS enterprise', { confidence: 0.9 })));
    assert.notEqual(goalItemId(belief('Acme is enterprise')), goalItemId(belief('Acme is SMB')));
    assert.notEqual(goalItemId(delta('verify payment')), goalItemId(belief('verify payment')));   // kind matters
  });
  it('unusable item → empty id/key', () => {
    assert.equal(goalItemId({ kind: 'belief' }), '');   // no body
    assert.equal(goalItemKey(null), '');
  });
});

describe('goalStore — addItem (dedup = corroboration)', () => {
  it('a new item gets an id + evidence:1; the original list is untouched', () => {
    const a = addItem([], belief('Acme is enterprise', { confidence: 0.6 }));
    assert.equal(a.length, 1);
    assert.ok(a[0].id);
    assert.equal(a[0].evidence, 1);
  });
  it('re-adding the same content MERGES: evidence bumps, confidence maxes, higher tier wins', () => {
    let list = addItem([], belief('Acme is enterprise', { confidence: 0.6, tier: 'observation' }));
    list = addItem(list, belief('ACME is enterprise', { confidence: 0.9, tier: 'hypothesis' }));
    assert.equal(list.length, 1);                       // merged, not duplicated
    assert.equal(list[0].evidence, 2);
    assert.equal(list[0].confidence, 0.9);
    assert.equal(list[0].tier, 'hypothesis');
  });
  it('an unusable raw item is ignored', () => {
    assert.equal(addItem([], { kind: 'belief' }).length, 0);
    assert.equal(addItem([], null).length, 0);
  });
  it('AL-3b — same phrasing → DIFFERENT capability stays distinct; same capability merges (corroboration)', () => {
    let l = addItem([], { kind: 'belief', body: 'open emails', ref: 'cap-a' });
    l = addItem(l, { kind: 'belief', body: 'open emails', ref: 'cap-b' });   // different ref → a second association
    assert.equal(l.length, 2);
    l = addItem(l, { kind: 'belief', body: 'OPEN emails', ref: 'cap-a' });   // same ref + phrasing → merge
    assert.equal(l.length, 2);
    assert.equal(l.find((x) => x.ref === 'cap-a').evidence, 2);
  });
});

describe('goalStore — promoteItemInList (evidence drives the ratchet)', () => {
  it('two corroborations + confidence ≥ 0.7 lets a hypothesis confirm without an explicit evidenceCount', () => {
    let list = addItem([], belief('Acme is churning', { confidence: 0.8, tier: 'hypothesis' }));
    list = addItem(list, belief('Acme is churning', { confidence: 0.8 }));   // evidence → 2
    const id = list[0].id;
    list = promoteItemInList(list, id);                                      // uses item.evidence (2)
    assert.equal(list[0].tier, 'confirmed');
    assert.equal(list[0].id, id);                                           // id preserved
    assert.equal(list[0].evidence, 2);
  });
  it('a single sighting does NOT confirm (gate needs ≥2 evidence)', () => {
    let list = addItem([], belief('x', { confidence: 0.9, tier: 'hypothesis' }));
    list = promoteItemInList(list, list[0].id);
    assert.equal(list[0].tier, 'hypothesis');           // unchanged
  });
  it('canonization requires the human signal (HITL)', () => {
    let list = addItem([], belief('x', { confidence: 1, tier: 'confirmed' }));
    assert.equal(promoteItemInList(list, list[0].id, { evidenceCount: 9 })[0].tier, 'confirmed');   // no human → blocked
    assert.equal(promoteItemInList(list, list[0].id, { confirmedByHuman: true })[0].tier, 'canonical');
  });
  it('missing id → no-op', () => {
    const list = addItem([], belief('x'));
    assert.deepEqual(promoteItemInList(list, 'nope'), list);
  });
});

describe('goalStore — queryItems (the retrieval primitive)', () => {
  const build = () => {
    let l = [];
    l = addItem(l, belief('canon fact', { tier: 'canonical', confidence: 0.95 }));
    l = addItem(l, belief('a guess', { tier: 'hypothesis', confidence: 0.4 }));
    l = addItem(l, delta('a rule', { tier: 'confirmed', confidence: 0.8 }));
    return l;
  };
  it('filters by kind', () => {
    assert.equal(queryItems(build(), { kind: 'delta' }).length, 1);
    assert.equal(queryItems(build(), { kind: 'belief' }).length, 2);
  });
  it('filters by tier floor + min confidence', () => {
    assert.equal(queryItems(build(), { minTier: 'confirmed' }).length, 2);   // canonical + confirmed
    assert.equal(queryItems(build(), { minConfidence: 0.9 }).length, 1);
  });
  it('ranks canonical/most-confident first', () => {
    const ranked = queryItems(build());
    assert.equal(ranked[0].tier, 'canonical');
  });
});

describe('goalStore — rollupGoalMemory', () => {
  it('counts total, by kind, by tier', () => {
    let l = [];
    l = addItem(l, belief('a', { tier: 'observation' }));
    l = addItem(l, delta('b', { tier: 'confirmed' }));
    const r = rollupGoalMemory(l);
    assert.equal(r.total, 2);
    assert.deepEqual(r.byKind, { belief: 1, delta: 1 });
    assert.equal(r.byTier.observation, 1);
    assert.equal(r.byTier.confirmed, 1);
  });
});

describe('goalStore — capItems (bounded growth, canon protected)', () => {
  it('keeps everything under the cap', () => {
    let l = []; for (let i = 0; i < 5; i++) l = addItem(l, belief(`b${i}`));
    assert.equal(capItems(l, 10).length, 5);
  });
  it('prunes the weakest lower-tier items but NEVER canonical/summary', () => {
    let l = [];
    l = addItem(l, belief('canon', { tier: 'canonical', confidence: 0.5 }));
    l = addItem(l, belief('sum', { tier: 'summary', confidence: 0.5 }));
    for (let i = 0; i < 8; i++) l = addItem(l, belief(`obs${i}`, { tier: 'observation', confidence: 0.1 + i / 100 }));
    const capped = capItems(l, 4);
    assert.equal(capped.length, 4);
    assert.ok(capped.some((x) => x.tier === 'canonical'));
    assert.ok(capped.some((x) => x.tier === 'summary'));
    // the 2 protected + the 2 strongest observations
    assert.equal(capped.filter((x) => x.tier === 'observation').length, 2);
  });
});

describe('goalStore — consolidateGoalMemory (AL-6, the slow pass)', () => {
  const one = (over) => consolidateGoalMemory([addItem([], belief('a claim', over))[0]])[0];
  it('settles an observation up the evidence gates as far as it qualifies', () => {
    assert.equal(one({ tier: 'observation', confidence: 0.5 }).tier, 'hypothesis');   // 0.5 ≥ 0.3 (cheap), but < 0.7 → stops at hypothesis
  });
  it('promotes a corroborated hypothesis to confirmed', () => {
    let l = addItem([], belief('churning', { tier: 'hypothesis', confidence: 0.8 }));
    l = addItem(l, belief('churning', { confidence: 0.8 }));        // evidence → 2
    assert.equal(consolidateGoalMemory(l)[0].tier, 'confirmed');    // 0.8 ≥ 0.7 AND evidence 2 → confirmed
  });
  it('NEVER auto-canonizes — confirmed stays confirmed (canonization is HITL)', () => {
    assert.equal(one({ tier: 'confirmed', confidence: 1, evidence: 9 }).tier, 'confirmed');
  });
  it('rolls a canonical item into the summary tier (the distilled, always-loaded summary)', () => {
    assert.equal(one({ tier: 'canonical', confidence: 0.9 }).tier, 'summary');
  });
  it('compacts: caps growth, protecting canonical/summary', () => {
    let l = addItem([], belief('canon', { tier: 'canonical' }));
    for (let i = 0; i < 6; i++) l = addItem(l, belief(`o${i}`, { tier: 'observation', confidence: 0.1 }));
    const out = consolidateGoalMemory(l, { cap: 3 });
    assert.equal(out.length, 3);
    assert.ok(out.some((x) => x.tier === 'summary'));              // the canonical was rolled to summary + survived the cap (protected)
  });
});
