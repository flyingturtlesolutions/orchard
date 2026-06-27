// Core/workflowMatchPrompt.test.js — WF-3: the pure build + parse for the LLM workflow matcher. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkflowMatchMessages, parseWorkflowMatchOutput } from './workflowMatchPrompt.js';

describe('workflowMatchPrompt — buildWorkflowMatchMessages', () => {
  const cands = [
    { id: 'wf-aaa', name: 'standup', ask: 'open jira and post standup to slack' },
    { id: 'wf-bbb', name: null, ask: 'get my open tickets and research each' },
  ];
  it('renders the ask + every candidate id/name/ask into the user message', () => {
    const { system, user } = buildWorkflowMatchMessages('pull my tickets and dig in', cands);
    assert.match(system, /ONLY a JSON object/);
    assert.match(user, /ASK: pull my tickets and dig in/);
    assert.match(user, /wf-aaa/);
    assert.match(user, /name: standup/);
    assert.match(user, /wf-bbb/);
    assert.match(user, /get my open tickets and research each/);
  });
  it('drops malformed candidates and shows (none) when empty', () => {
    assert.match(buildWorkflowMatchMessages('x', []).user, /\(none\)/);
    assert.match(buildWorkflowMatchMessages('x', [{ id: '', ask: 'no id' }, null]).user, /\(none\)/);
  });
});

describe('workflowMatchPrompt — parseWorkflowMatchOutput', () => {
  it('parses a valid {id, confidence}, clamping confidence', () => {
    assert.deepEqual(parseWorkflowMatchOutput('{"id":"wf-aaa","confidence":0.9}'), { id: 'wf-aaa', confidence: 0.9 });
    assert.deepEqual(parseWorkflowMatchOutput('noise {"id":"wf-x","confidence":5} trailing'), { id: 'wf-x', confidence: 1 });
  });
  it('a null / "null" / empty id collapses to {id:null, confidence:0}', () => {
    assert.deepEqual(parseWorkflowMatchOutput('{"id":null,"confidence":0}'), { id: null, confidence: 0 });
    assert.deepEqual(parseWorkflowMatchOutput('{"id":"null","confidence":0.8}'), { id: null, confidence: 0 });
    assert.deepEqual(parseWorkflowMatchOutput('{"id":"  ","confidence":0.8}'), { id: null, confidence: 0 });
  });
  it('an id present but no numeric confidence defaults to 0.6', () => {
    assert.deepEqual(parseWorkflowMatchOutput('{"id":"wf-aaa"}'), { id: 'wf-aaa', confidence: 0.6 });
  });
  it('unparseable / non-object → {id:null, confidence:0}', () => {
    assert.deepEqual(parseWorkflowMatchOutput('not json'), { id: null, confidence: 0 });
    assert.deepEqual(parseWorkflowMatchOutput(''), { id: null, confidence: 0 });
    assert.deepEqual(parseWorkflowMatchOutput('[1,2,3]'), { id: null, confidence: 0 });
  });
});
