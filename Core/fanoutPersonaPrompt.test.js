// Core/fanoutPersonaPrompt.test.js — Q2: the pure build + parse for the fan-out {task, persona} extractor. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildFanoutSpecMessages, parseFanoutSpecOutput, describeFanoutSpec, FANOUT_SLOTS } from './fanoutPersonaPrompt.js';

describe('fanoutPersonaPrompt — buildFanoutSpecMessages', () => {
  it('renders the clause + the task/persona contract', () => {
    const { system, user } = buildFanoutSpecMessages("open each in a sub thread and respond in the customer's voice");
    // FS-6 — the header wording moved from "per-child PERSONA" to "NAMED SLOTS" when the splitter grew past two
    // slots. What this test is FOR is that the persona contract is still taught, so assert that rather than the
    // sentence that happened to carry it.
    assert.match(system, /"persona":/);
    assert.match(system, /PERSONA = HOW the child should sound or behave/);
    assert.match(user, /FAN-OUT: open each in a sub thread and respond in the customer's voice/);
  });
});

// FS-6 (v2.74.1830) — the parse output grew from {task,persona} to eight named slots. These v1263 cases
// pin the task/persona BEHAVIOUR, which is unchanged; they were asserting the whole object only because it had
// two keys at the time. _tp narrows each to the pair it is actually about, so the coverage survives the growth
// instead of being deleted or frozen against a shape that moved.
const _tp = (s) => ({ task: s.task, persona: s.persona });

describe('fanoutPersonaPrompt — parseFanoutSpecOutput', () => {
  it('parses {task, persona}', () => {
    assert.deepEqual(_tp(parseFanoutSpecOutput('{"task":"respond","persona":"in the customer\'s voice"}')), { task: 'respond', persona: "in the customer's voice" });
  });
  it('a null / "null" / empty persona collapses to null', () => {
    assert.deepEqual(_tp(parseFanoutSpecOutput('{"task":"research","persona":null}')), { task: 'research', persona: null });
    assert.deepEqual(_tp(parseFanoutSpecOutput('{"task":"research","persona":"null"}')), { task: 'research', persona: null });
    assert.deepEqual(_tp(parseFanoutSpecOutput('{"task":"x","persona":"   "}')), { task: 'x', persona: null });
  });
  it('unparseable / missing → {task:"", persona:null}', () => {
    assert.deepEqual(_tp(parseFanoutSpecOutput('not json')), { task: '', persona: null });
    assert.deepEqual(_tp(parseFanoutSpecOutput('{}')), { task: '', persona: null });
    assert.deepEqual(_tp(parseFanoutSpecOutput('')), { task: '', persona: null });
  });
});

describe('FS-6 (v2.74.1830) — the six added slots', () => {
  const J = (o) => JSON.stringify(o);

  it('a bare value is a NOTE, never a task (the live drop: "open a case with 1 as the first message")', () => {
    const s = parseFanoutSpecOutput(J({ task: '', note: '1' }));
    assert.equal(s.note, '1');
    assert.equal(s.task, '');
  });

  it('parses all eight slots together', () => {
    const s = parseFanoutSpecOutput(J({
      task: 'research it', persona: 'in the customer voice', note: 'follow up', gate: 'let me review first',
      title: 'named after the homeowner', destination: 'under the warranty desk', order: 'newest first', priority: 'urgent',
    }));
    assert.equal(s.task, 'research it');
    assert.equal(s.persona, 'in the customer voice');
    assert.equal(s.note, 'follow up');
    assert.equal(s.gate, 'let me review first');
    assert.equal(s.title, 'named after the homeowner');
    assert.equal(s.destination, 'under the warranty desk');
    assert.equal(s.order, 'newest first');
    assert.equal(s.priority, 'urgent');
  });

  it('an unmentioned slot is null — never invented, never back-filled from another slot', () => {
    const s = parseFanoutSpecOutput(J({ task: 'research', persona: null }));
    for (const k of ['persona', 'note', 'gate', 'title', 'destination', 'order', 'priority']) assert.equal(s[k], null, `${k} should be null`);
  });

  it('the string "null", empty text, and non-scalars all collapse to null', () => {
    const s = parseFanoutSpecOutput(J({ note: 'null', gate: '   ', title: {}, destination: [], priority: 'urgent' }));
    assert.equal(s.note, null);
    assert.equal(s.gate, null);
    assert.equal(s.title, null);        // must NOT become "[object Object]"
    assert.equal(s.destination, null);
    assert.equal(s.priority, 'urgent');
  });

  it('every slot is clamped to its declared budget', () => {
    const long = 'x'.repeat(900);
    const s = parseFanoutSpecOutput(J({ task: long, persona: long, note: long, gate: long, title: long, destination: long, order: long, priority: long, collection: long }));
    for (const [name, max] of Object.entries(FANOUT_SLOTS)) assert.equal(s[name].length, max, `${name} should clamp to ${max}`);
  });

  it('unparseable output degrades to every slot empty, never throws', () => {
    for (const bad of ['', 'not json', '{oops', null, undefined]) {
      const s = parseFanoutSpecOutput(bad);
      assert.equal(s.task, '');
      assert.equal(s.note, null);
      assert.equal(s.gate, null);
    }
  });

  it('describeFanoutSpec lists only what was declared — the receipt reads this', () => {
    assert.equal(describeFanoutSpec({ task: '', note: '1', gate: null }), 'note="1"');
    assert.match(describeFanoutSpec({ task: 'research', priority: 'urgent' }), /task="research" · priority="urgent"/);
    assert.equal(describeFanoutSpec({ task: '' }), '');
    assert.equal(describeFanoutSpec(null), '');
  });

  it('the prompt teaches the note/task distinction and the do-not-invent rule', () => {
    const { system } = buildFanoutSpecMessages('x');
    assert.match(system, /A bare value, number, or fixed phrase is ALWAYS a note, never a task/);
    assert.match(system, /do NOT invent one/);
    for (const k of ['note', 'gate', 'title', 'destination', 'order', 'priority']) assert.ok(system.includes(`"${k}"`), `system should name ${k}`);
  });
});

describe('collection (v2.74.1832) — retiring the fanoutReadAsk strip', () => {
  it('carries the user OWN nouns, including our own vocabulary words', () => {
    // The live failure: "cases" is the user's domain noun AND our artifact word. The regex deleted it.
    const s = parseFanoutSpecOutput(JSON.stringify({ collection: 'get open warranty cases', task: '', note: '1' }));
    assert.equal(s.collection, 'get open warranty cases');
    assert.equal(s.note, '1');
  });

  it('is null when the ask points at an already-read list', () => {
    assert.equal(parseFanoutSpecOutput(JSON.stringify({ collection: null, task: 'research' })).collection, null);
  });

  it('unparseable output still yields the key (a missing key would read as "no collection declared")', () => {
    assert.equal('collection' in parseFanoutSpecOutput('not json'), true);
    assert.equal(parseFanoutSpecOutput('not json').collection, null);
  });

  it('the prompt teaches it to copy the user vocabulary, not ours', () => {
    assert.match(buildFanoutSpecMessages('x').system, /Copy the user's OWN nouns; do not substitute our vocabulary for theirs/);
  });
});
