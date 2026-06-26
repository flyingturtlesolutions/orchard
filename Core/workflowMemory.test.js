// Core/workflowMemory.test.js — WF-1: structured recallable IL workflows (phrase → saved decomposition). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { workflowId, normalizeWorkflow, workflowMatch } from './workflowMemory.js';

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
