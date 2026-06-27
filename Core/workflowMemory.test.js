// Core/workflowMemory.test.js — WF-1: structured recallable IL workflows (phrase → saved decomposition). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { workflowId, normalizeWorkflow, workflowMatch, workflowCandidates, resolveWorkflowMatch, workflowSharesVocab } from './workflowMemory.js';

const WF = (ask, subAsks, over = {}) => ({ ask, subAsks, ...over });

describe('workflowMemory — normalizeWorkflow', () => {
  it('requires an ask + ≥2 sub-asks; mints a content id; defaults runs/createdAt', () => {
    const w = normalizeWorkflow(WF('get my open tickets and research each', ['get my open tickets', 'research each in a new conversation']));
    assert.equal(w.ask, 'get my open tickets and research each');
    assert.equal(w.subAsks.length, 2);
    assert.match(w.id, /^wf-/);
    assert.equal(w.runs, 0);
  });
  it('rejects a single-step "workflow" and a missing ask', () => {
    assert.equal(normalizeWorkflow(WF('do one thing', ['just one'])), null);   // <2 steps
    assert.equal(normalizeWorkflow(WF('', ['a', 'b'])), null);
    assert.equal(normalizeWorkflow(null), null);
  });
  it('the content id is stable + dedups same ask+steps, distinct for different steps', () => {
    assert.equal(workflowId('x', ['a', 'b']), workflowId('X', ['A', 'B']));   // case-insensitive
    assert.notEqual(workflowId('x', ['a', 'b']), workflowId('x', ['a', 'c']));
  });
});

describe('workflowMatch — recall by overlap-coefficient', () => {
  const saved = [normalizeWorkflow(WF('get my open tickets and research each in a new conversation',
    ['get my open tickets', 'research each in a new conversation', 'summarize what each found']))];

  it('a SHORT re-ask ("get tickets") matches a LONG saved workflow', () => {
    const m = workflowMatch('get tickets', saved);
    assert.ok(m);
    assert.equal(m.subAsks.length, 3);
  });
  it('the exact ask matches', () => {
    assert.ok(workflowMatch('get my open tickets and research each in a new conversation', saved));
  });
  it('an unrelated ask does NOT match (precision over recall)', () => {
    assert.equal(workflowMatch('open youtube', saved), null);
    assert.equal(workflowMatch('get my profile', saved), null);   // only "get" shared (<2 meaningful tokens)
  });
  it('breaks ties by run-count (the more-used workflow wins)', () => {
    const a = normalizeWorkflow(WF('export the report', ['open reports', 'export it'], { runs: 1 }));
    const b = normalizeWorkflow(WF('export the report now', ['open reports', 'export it', 'email it'], { runs: 9 }));
    assert.equal(workflowMatch('export report', [a, b]).runs, 9);
  });
  it('empty / too-short query → null', () => {
    assert.equal(workflowMatch('', saved), null);
    assert.equal(workflowMatch('tickets', saved), null);   // 1 token < minShared
  });
});

describe('workflowMatch — WF-2 (name alias + dismissal suppression)', () => {
  it('a NAME match wins outright (the user typed the alias), case/space-insensitive', () => {
    const wfs = [normalizeWorkflow(WF('open jira and list my issues then post to slack', ['open jira', 'list my issues', 'post to slack'], { name: 'standup' }))];
    assert.ok(workflowMatch('standup', wfs));
    assert.ok(workflowMatch('  Standup ', wfs));            // normalized
    assert.equal(workflowMatch('weather', wfs), null);      // not the name, no token overlap
  });
  it('a never-run, twice-dismissed workflow stops suggesting (suppression)', () => {
    const live = normalizeWorkflow(WF('get my open tickets and triage each', ['get my open tickets', 'triage each'], { dismissed: 2, runs: 0 }));
    assert.equal(workflowMatch('get tickets', [live]), null);                 // suppressed
    const used = normalizeWorkflow(WF('get my open tickets and triage each', ['get my open tickets', 'triage each'], { dismissed: 5, runs: 1 }));
    assert.ok(workflowMatch('get tickets', [used]));                          // ran once → keeps suggesting
  });
});

describe('workflowMemory — semantic-match support (candidates + resolve)', () => {
  const a = normalizeWorkflow(WF('get my open tickets and research each', ['get my open tickets', 'research each'], { runs: 3 }));
  const b = normalizeWorkflow(WF('open jira and post standup to slack', ['open jira', 'post to slack'], { name: 'standup', runs: 7 }));
  const suppressed = normalizeWorkflow(WF('export the weekly report and email it', ['export report', 'email it'], { dismissed: 2, runs: 0 }));
  const all = [a, b, suppressed];

  it('workflowCandidates → a compact {id,name,ask} set, suppression-filtered, most-used first', () => {
    const c = workflowCandidates(all);
    assert.deepEqual(c.map((x) => x.id), [b.id, a.id]);                       // suppressed dropped; b (7 runs) before a (3)
    assert.deepEqual(Object.keys(c[0]).sort(), ['ask', 'id', 'name']);       // no subAsks / appId leak into the prompt
    assert.equal(c[0].name, 'standup');
  });
  it('workflowCandidates caps the set', () => {
    assert.equal(workflowCandidates(all, { cap: 1 }).length, 1);
    assert.equal(workflowCandidates(all, { cap: 0 }).length, 0);
  });
  it('resolveWorkflowMatch accepts a real candidate id → the FULL record', () => {
    const r = resolveWorkflowMatch(all, a.id);
    assert.ok(r); assert.equal(r.subAsks.length, 2); assert.equal(r.ask, 'get my open tickets and research each');
  });
  it('resolveWorkflowMatch rejects a hallucinated / suppressed / empty id (the trust gate)', () => {
    assert.equal(resolveWorkflowMatch(all, 'wf-nope'), null);                 // hallucinated
    assert.equal(resolveWorkflowMatch(all, suppressed.id), null);            // suppressed never resolves
    assert.equal(resolveWorkflowMatch(all, ''), null);
    assert.equal(resolveWorkflowMatch(all, null), null);
  });
  it('workflowSharesVocab gates the LLM: a paraphrase sharing vocab → true; an unrelated ask → false', () => {
    const cand = workflowCandidates([a, b]);                                  // {tickets/research}, {jira/standup/slack}
    assert.equal(workflowSharesVocab('pull my tickets and dig into each', cand), true);   // "tickets" shared → escalate
    assert.equal(workflowSharesVocab('what is the standup about', cand), true);           // "standup" (name) shared
    assert.equal(workflowSharesVocab('book me a flight to tokyo', cand), false);          // zero overlap → skip the call
    assert.equal(workflowSharesVocab('', cand), false);
  });
});
