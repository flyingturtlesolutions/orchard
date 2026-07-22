// Core/upsert.test.js — PP-2 (v2.74.1661): find-or-create-then-act, three outcomes.
//
// The central case is `unreachable must never create`. It is not a nicety: `try`'s recover arm fires on ANY
// non-abort failure (Services/ExecutionEngine.js:1515-1531), which is why UPSERT does not use it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runUpsert, normalizeFindResult, upsertOnce, upsertTally, FIND_OUTCOMES } from './upsert.js';

const ITEM = { Id: '10834758', Address: '12 Elm St' };
const REC = { id: 'cust_1' };

// A recording harness: every effect is injected, so a test can assert an effect NEVER happened.
const harness = (over = {}) => {
  const calls = { find: 0, recheck: 0, create: 0, act: 0 };
  const io = {
    find: async () => { calls.find++; return { outcome: 'miss' }; },
    create: async () => { calls.create++; return REC; },
    act: async () => { calls.act++; },
    ...over,
  };
  if (over.recheck) { const r = over.recheck; io.recheck = async (...a) => { calls.recheck++; return r(...a); }; }
  return { io, calls };
};

describe('upsert — normalizeFindResult (strict, and asymmetric on purpose)', () => {
  it('passes through the three documented outcomes', () => {
    for (const outcome of FIND_OUTCOMES) {
      assert.equal(normalizeFindResult({ outcome }).outcome, outcome);
    }
  });

  it('an UNRECOGNIZED shape is unreachable, NOT miss — the asymmetric-cost rule', () => {
    // miss-read-as-unreachable stops and asks a human; unreachable-read-as-miss creates a duplicate record.
    for (const bad of [null, undefined, {}, 'ok', 0, { outcome: 'found' }, true]) {
      assert.equal(normalizeFindResult(bad).outcome, 'unreachable', JSON.stringify(bad));
    }
  });
});

describe('upsert — the invariant: unreachable NEVER creates', () => {
  it('an unreachable find blocks, and create is never called', async () => {
    const { io, calls } = harness({ find: async () => ({ outcome: 'unreachable', why: 'connection lost' }) });
    const r = await runUpsert(ITEM, io);
    assert.equal(r.outcome, 'blocked');
    assert.equal(r.acted, false);
    assert.match(r.why, /connection lost/);
    assert.equal(calls.create, 0, 'a transport blip must not write a record');
  });

  it('a find that THROWS blocks, and create is never called', async () => {
    const { io, calls } = harness({ find: async () => { throw new Error('socket closed'); } });
    const r = await runUpsert(ITEM, io);
    assert.equal(r.outcome, 'blocked');
    assert.equal(calls.create, 0);
  });

  it('a find returning null blocks — nothing is a shape we cannot interpret', async () => {
    const { io, calls } = harness({ find: async () => null });
    assert.equal((await runUpsert(ITEM, io)).outcome, 'blocked');
    assert.equal(calls.create, 0);
  });
});

describe('upsert — hit / created / act', () => {
  it('a hit acts on the found record and does not create', async () => {
    const { io, calls } = harness({ find: async () => ({ outcome: 'hit', record: REC }) });
    const r = await runUpsert(ITEM, io);
    assert.equal(r.outcome, 'hit');
    assert.equal(r.record, REC);
    assert.equal(r.acted, true);
    assert.equal(calls.create, 0);
    assert.equal(calls.act, 1);
  });

  it('a miss creates then acts', async () => {
    const { io, calls } = harness();
    const r = await runUpsert(ITEM, io);
    assert.equal(r.outcome, 'created');
    assert.equal(r.acted, true);
    assert.equal(calls.create, 1);
    assert.equal(calls.act, 1);
  });

  it('omitting `act` is legal — upsert reports without acting', async () => {
    const r = await runUpsert(ITEM, { find: async () => ({ outcome: 'miss' }), create: async () => REC });
    assert.equal(r.outcome, 'created');
    assert.equal(r.acted, false);
  });

  it('a create that throws is `failed`, and act is skipped', async () => {
    const { io, calls } = harness({ create: async () => { throw new Error('422 unprocessable'); } });
    const r = await runUpsert(ITEM, io);
    assert.equal(r.outcome, 'failed');
    assert.match(r.why, /422/);
    assert.equal(calls.act, 0);
  });

  it('a create returning NOTHING is failed and says a record may exist uncaptured (§10.1 tagging)', async () => {
    const r = await runUpsert(ITEM, { find: async () => ({ outcome: 'miss' }), create: async () => null });
    assert.equal(r.outcome, 'failed');
    assert.match(r.why, /may exist without a captured id/);
  });

  it('an act that throws after a successful create keeps outcome `created` — the record IS there', async () => {
    const r = await runUpsert(ITEM, {
      find: async () => ({ outcome: 'miss' }), create: async () => REC,
      act: async () => { throw new Error('draft failed'); },
    });
    assert.equal(r.outcome, 'created', 'reporting this as failed would hide a real record from cleanup');
    assert.equal(r.acted, false);
    assert.match(r.why, /draft failed/);
  });

  it('the trial tag reaches create (§10.1 — residue findable without a captured id)', async () => {
    let seen = null;
    await runUpsert(ITEM, {
      find: async () => ({ outcome: 'miss' }),
      create: async (_i, ctx) => { seen = ctx.trialTag; return REC; },
      trialTag: 'orchard-trial-run_abc',
    });
    assert.equal(seen, 'orchard-trial-run_abc');
  });
});

describe('upsert — the inline re-check (§3.1)', () => {
  it('a re-check that HITS treats the item as found and does not create', async () => {
    const { io, calls } = harness({ recheck: async () => ({ outcome: 'hit', record: REC }) });
    const r = await runUpsert(ITEM, io);
    assert.equal(r.outcome, 'hit');
    assert.match(r.why, /recheck/);
    assert.equal(calls.create, 0, 'a concurrent create must not become a duplicate');
    assert.equal(calls.act, 1);
  });

  it('a re-check that goes UNREACHABLE blocks rather than creating on a stale miss', async () => {
    const { io, calls } = harness({ recheck: async () => ({ outcome: 'unreachable', why: 'timeout' }) });
    const r = await runUpsert(ITEM, io);
    assert.equal(r.outcome, 'blocked');
    assert.match(r.why, /could not confirm absence/);
    assert.equal(calls.create, 0);
  });

  it('a re-check that confirms the miss proceeds to create', async () => {
    const { io, calls } = harness({ recheck: async () => ({ outcome: 'miss' }) });
    assert.equal((await runUpsert(ITEM, io)).outcome, 'created');
    assert.equal(calls.create, 1);
  });

  it('a re-check that throws blocks', async () => {
    const { io, calls } = harness({ recheck: async () => { throw new Error('boom'); } });
    assert.equal((await runUpsert(ITEM, io)).outcome, 'blocked');
    assert.equal(calls.create, 0);
  });
});

describe('upsert — dispositions and multi-arm safety', () => {
  it('every branch reports a disposition, including the refusals (§5.5)', async () => {
    const lines = [];
    await runUpsert(ITEM, {
      find: async () => ({ outcome: 'unreachable', why: 'dns' }),
      onDisposition: (l) => lines.push(l),
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^unreachable\(/);
  });

  it('a throwing disposition sink cannot change the outcome', async () => {
    const r = await runUpsert(ITEM, {
      find: async () => ({ outcome: 'miss' }), create: async () => REC,
      onDisposition: () => { throw new Error('log broke'); },
    });
    assert.equal(r.outcome, 'created');
  });

  it('upsertOnce resolves a shared target ONCE per item — mode:"all" must not create twice (§3.1)', async () => {
    let creates = 0;
    const once = upsertOnce((it) => it.Address);
    const run = async (it) => runUpsert(it, { find: async () => ({ outcome: 'miss' }), create: async () => { creates++; return { id: it.Address }; } });
    const [a, b] = await Promise.all([once(ITEM, run), once(ITEM, run)]);
    assert.equal(creates, 1, 'two arms sharing an upsert target must resolve it once');
    assert.equal(a.record.id, b.record.id);
  });

  it('distinct targets are not collapsed by the memo', async () => {
    let creates = 0;
    const once = upsertOnce((it) => it.Address);
    const run = async (it) => runUpsert(it, { find: async () => ({ outcome: 'miss' }), create: async () => { creates++; return { id: it.Address }; } });
    await Promise.all([once(ITEM, run), once({ ...ITEM, Address: '9 Oak' }, run)]);
    assert.equal(creates, 2);
  });

  it('the tally names every class including the zeroes', () => {
    const t = upsertTally([{ outcome: 'hit' }, { outcome: 'created' }, { outcome: 'blocked' }]);
    assert.match(t, /1 found/); assert.match(t, /1 created/);
    assert.match(t, /1 blocked/); assert.match(t, /0 failed/);
  });
});
