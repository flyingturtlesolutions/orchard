// Core/ilStandin.test.js — IL-3 fold the stand-in through agentLoop@1 (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runIlStandin, candidateToLeg, legToCandidate, pickFromVerdict } from './ilStandin.js';

const offerOf = (candidates, groundId = 'gr1', match = { groundId }) => async () => ({ candidates, groundId, match });

describe('ilStandin — fold the single-shot stand-in through agentLoop@maxSteps=1 (pure)', () => {
  it('candidateToLeg / legToCandidate preserve id, intent, bindings (round-trip)', () => {
    const leg = candidateToLeg({ id: 'c1', intent: 'Search', bindings: { keyword: 'halo' } });
    assert.equal(leg.key, 'c1'); assert.equal(leg.domain, 'page'); assert.equal(leg.mode, 'act'); assert.equal(leg.source, 'learned');
    assert.deepEqual(leg.bindings, { keyword: 'halo' });
    assert.deepEqual(leg.params, ['keyword']);
    assert.deepEqual(legToCandidate(leg), { id: 'c1', intent: 'Search', bindings: { keyword: 'halo' } });
  });
  it('candidateToLeg returns null without an id', () => {
    assert.equal(candidateToLeg({ intent: 'x' }), null);
    assert.equal(candidateToLeg(null), null);
  });

  it('pickFromVerdict: a valid in-set ref wins', () => {
    const legs = [candidateToLeg({ id: 'a', intent: 'A' }), candidateToLeg({ id: 'b', intent: 'B' })];
    assert.equal(pickFromVerdict({ ref: 'b' }, legs).key, 'b');
  });
  it('pickFromVerdict: an explicit null ref rejects even with a single candidate', () => {
    assert.equal(pickFromVerdict({ ref: null }, [candidateToLeg({ id: 'a', intent: 'A' })]), null);
  });
  it('pickFromVerdict: an absent verdict auto-picks ONLY a single candidate', () => {
    assert.equal(pickFromVerdict(null, [candidateToLeg({ id: 'a', intent: 'A' })]).key, 'a');
    assert.equal(pickFromVerdict(null, [candidateToLeg({ id: 'a' }), candidateToLeg({ id: 'b' })]), null);
  });
  it('pickFromVerdict: a hallucinated ref over multiple candidates → no pick', () => {
    const legs = [candidateToLeg({ id: 'a' }), candidateToLeg({ id: 'b' })];
    assert.equal(pickFromVerdict({ ref: 'zzz' }, legs), null);
  });
  it('pickFromVerdict: a hallucinated ref WITH a single candidate auto-picks it (stand-in parity)', () => {
    assert.equal(pickFromVerdict({ ref: 'zzz' }, [candidateToLeg({ id: 'only' })]).key, 'only');
  });

  it('HIT: the substrate offers candidates, judge picks → act decision handed back un-executed', async () => {
    let judged = null;
    const out = await runIlStandin('search halo', {
      offer: offerOf([{ id: 'cap_search', intent: 'Search', bindings: { keyword: 'halo' } }], 'gr_yt'),
      judge: async (g, cands) => { judged = { g, cands }; return { ref: 'cap_search', reason: 'fits' }; },
    });
    assert.equal(out.status, 'act');
    assert.equal(out.decision.kind, 'act');
    assert.equal(out.decision.leg.key, 'cap_search');
    assert.deepEqual(out.decision.params, { keyword: 'halo' });   // substrate bindings ride through, never re-bound
    assert.equal(out.decision.reason, 'fits');
    assert.equal(out.groundId, 'gr_yt');
    assert.equal(out.steps, 1);
    // JUDGE saw the goal + the candidate (with its bindings) — never re-bound them.
    assert.equal(judged.g, 'search halo');
    assert.deepEqual(judged.cands[0], { id: 'cap_search', intent: 'Search', bindings: { keyword: 'halo' } });
  });

  it('MISS: no candidates → needs:answer (the meta ANSWER path), judge not consulted', async () => {
    let judgeCalled = false;
    const out = await runIlStandin('subscribe', {
      offer: offerOf([], null, { groundId: 'gr_yt' }),
      judge: async () => { judgeCalled = true; return { ref: null }; },
    });
    assert.equal(out.status, 'needs');
    assert.equal(out.decision.needs.kind, 'answer');
    assert.equal(judgeCalled, false);                              // a miss never wastes a JUDGE call
    assert.deepEqual(out.match, { groundId: 'gr_yt' });            // raw match rides back for the caller
  });

  it('REJECT: judge returns a null ref over multiple → needs:reject (carries the reason)', async () => {
    const out = await runIlStandin('do x', {
      offer: offerOf([{ id: 'a', intent: 'A' }, { id: 'b', intent: 'B' }]),
      judge: async () => ({ ref: null, reason: 'neither fits' }),
    });
    assert.equal(out.status, 'needs');
    assert.equal(out.decision.needs.kind, 'reject');
    assert.equal(out.decision.needs.reason, 'neither fits');
  });

  it('single candidate + judge unavailable → auto-picks (parity with the stand-in)', async () => {
    const out = await runIlStandin('go', {
      offer: offerOf([{ id: 'only', intent: 'Only' }]),
      judge: async () => { throw new Error('judge down'); },
    });
    assert.equal(out.status, 'act');
    assert.equal(out.decision.leg.key, 'only');
  });

  it('abort short-circuits before any think', async () => {
    let offered = false;
    const out = await runIlStandin('x', {
      offer: async () => { offered = true; return { candidates: [{ id: 'a' }] }; },
      judge: async () => ({ ref: 'a' }),
      isAborted: () => true,
    });
    assert.equal(out.status, 'aborted');
    assert.equal(offered, false);
  });

  it('empty goal → needs:clarify (agentLoop guard), no offer call', async () => {
    let offered = false;
    const out = await runIlStandin('   ', { offer: async () => { offered = true; return { candidates: [] }; }, judge: async () => null });
    assert.equal(out.status, 'needs');
    assert.equal(out.decision.needs.kind, 'clarify');
    assert.equal(offered, false);
  });

  // ── IL-3b: Browser/Self builtin read legs join the palette on a page miss ──────────────────────────────────
  const LIST_TABS_LEG = { key: 'LIST_TABS', name: 'List open tabs', does: 'report the open tabs', domain: 'browser', mode: 'ask', source: 'builtin', params: [] };

  it('B: a builtin read leg offered on a miss + judge picks it → act on the browser/self leg (not page)', async () => {
    const out = await runIlStandin('what tabs are open', {
      offer: async () => ({ candidates: [], builtins: [LIST_TABS_LEG], groundId: 'gr', match: {} }),
      judge: async () => ({ ref: 'LIST_TABS', reason: 'a tabs question' }),
    });
    assert.equal(out.status, 'act');
    assert.equal(out.decision.leg.key, 'LIST_TABS');
    assert.equal(out.decision.leg.domain, 'browser');
  });

  it('B: a builtins-ONLY palette that judge rejects → needs:answer (meta), NOT reject', async () => {
    const out = await runIlStandin('subscribe to this channel', {
      offer: async () => ({ candidates: [], builtins: [LIST_TABS_LEG], match: {} }),
      judge: async () => ({ ref: null, reason: 'not a tabs ask' }),
    });
    assert.equal(out.status, 'needs');
    assert.equal(out.decision.needs.kind, 'answer');     // builtins-only miss → meta answer, never "rephrase"
  });

  it('B: PAGE legs present + judge rejects → still needs:reject (A parity preserved)', async () => {
    const out = await runIlStandin('do x', {
      offer: async () => ({ candidates: [{ id: 'a', intent: 'A' }], builtins: [LIST_TABS_LEG], match: {} }),
      judge: async () => ({ ref: null, reason: 'none fit' }),
    });
    assert.equal(out.status, 'needs');
    assert.equal(out.decision.needs.kind, 'reject');     // a page leg was offered → "didn't fit — rephrase"
  });

  it('B: judge sees a builtin leg by its `does` description (legToCandidate prefers does)', async () => {
    let seen = null;
    await runIlStandin('list my tabs', {
      offer: async () => ({ candidates: [], builtins: [LIST_TABS_LEG], match: {} }),
      judge: async (_g, cands) => { seen = cands; return { ref: 'LIST_TABS' }; },
    });
    assert.equal(seen[0].intent, 'report the open tabs');
  });

  it('C: a self ACT leg (panel action) flows through as an act decision carrying domain:self', async () => {
    const openStudio = { key: 'OPEN_STUDIO', name: 'Open Studio', does: 'open the Studio authoring tab', domain: 'self', mode: 'act', source: 'builtin', params: [] };
    const out = await runIlStandin('open studio', {
      offer: async () => ({ candidates: [], builtins: [openStudio], match: {} }),
      judge: async () => ({ ref: 'OPEN_STUDIO' }),
    });
    assert.equal(out.status, 'act');
    assert.equal(out.decision.leg.key, 'OPEN_STUDIO');
    assert.equal(out.decision.leg.domain, 'self');     // chat.js routes domain:self panel legs to _ilRunPanelAction
  });
});
