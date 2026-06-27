// Core/fanoutPersonaPrompt.test.js — Q2: the pure build + parse for the fan-out {task, persona} extractor. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildFanoutSpecMessages, parseFanoutSpecOutput } from './fanoutPersonaPrompt.js';

describe('fanoutPersonaPrompt — buildFanoutSpecMessages', () => {
  it('renders the clause + the task/persona contract', () => {
    const { system, user } = buildFanoutSpecMessages("open each in a sub thread and respond in the customer's voice");
    assert.match(system, /per-child PERSONA/);
    assert.match(user, /FAN-OUT: open each in a sub thread and respond in the customer's voice/);
  });
});

describe('fanoutPersonaPrompt — parseFanoutSpecOutput', () => {
  it('parses {task, persona}', () => {
    assert.deepEqual(parseFanoutSpecOutput('{"task":"respond","persona":"in the customer\'s voice"}'),
      { task: 'respond', persona: "in the customer's voice" });
  });
  it('a null / "null" / empty persona collapses to null', () => {
    assert.deepEqual(parseFanoutSpecOutput('{"task":"research","persona":null}'), { task: 'research', persona: null });
    assert.deepEqual(parseFanoutSpecOutput('{"task":"research","persona":"null"}'), { task: 'research', persona: null });
    assert.deepEqual(parseFanoutSpecOutput('{"task":"x","persona":"   "}'), { task: 'x', persona: null });
  });
  it('unparseable / missing → {task:"", persona:null}', () => {
    assert.deepEqual(parseFanoutSpecOutput('not json'), { task: '', persona: null });
    assert.deepEqual(parseFanoutSpecOutput('{}'), { task: '', persona: null });
    assert.deepEqual(parseFanoutSpecOutput(''), { task: '', persona: null });
  });
});
