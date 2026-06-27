// Core/answerShapePrompt.test.js — the interrogator answer-shaper's pure pieces (readShapeFacts + build + parse). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readShapeFacts, buildAnswerShapeMessages, parseAnswerShapeOutput } from './answerShapePrompt.js';

const TICKETS = { results: [
  { id: 64863, subject: 'Conversation with Carolina', status: 'open', description: 'a long private ticket body that must NOT leave' },
  { id: 64659, subject: 'Upgrade smart switch', status: 'open', description: 'another body' },
  { id: 63824, subject: 'Multiway switches', status: 'pending' },
] };

describe('answerShapePrompt — readShapeFacts (deterministic count + MINIMIZED sample)', () => {
  it('a list → exact count + a {id,title,status} sample with NO bodies (the minimization lever)', () => {
    const f = readShapeFacts(TICKETS);
    assert.equal(f.kind, 'list');
    assert.equal(f.count, 3);                       // count is exact (deterministic — the LLM never recounts)
    assert.equal(f.sampleN, 3);
    assert.deepEqual(f.sample[0], { id: 64863, title: 'Conversation with Carolina', status: 'open' });
    assert.deepEqual(Object.keys(f.sample[0]).sort(), ['id', 'status', 'title']);   // NO description/body/url leaves
    assert.ok(!('description' in f.sample[0]) && !('body' in f.sample[0]));
  });
  it('count is the FULL length even when the sample is capped', () => {
    const big = { results: Array.from({ length: 25 }, (_, i) => ({ id: i, subject: `t${i}`, status: 'open' })) };
    const f = readShapeFacts(big, { sampleN: 5 });
    assert.equal(f.count, 25);                       // exact total
    assert.equal(f.sampleN, 5);                      // sample truncated → the prompt says "of the ones shown"
  });
  it('a single object → count 1; empty/null → kind empty, count 0', () => {
    assert.equal(readShapeFacts({ ticket: { id: 7, subject: 'x', status: 'open' } }).kind, 'object');
    assert.equal(readShapeFacts({ ticket: { id: 7 } }).count, 1);
    assert.deepEqual(readShapeFacts(null), { kind: 'empty', count: 0, sampleN: 0, sample: [] });
    assert.equal(readShapeFacts({}).kind, 'empty');
  });
});

describe('answerShapePrompt — buildAnswerShapeMessages', () => {
  it('renders the question + the minimized facts; the contract names count + showList', () => {
    const { system, user } = buildAnswerShapeMessages({ ask: 'how many tickets do I have?', facts: readShapeFacts(TICKETS) });
    assert.match(system, /showList/);
    assert.match(system, /use the provided "count" VERBATIM/i);
    assert.match(user, /QUESTION: how many tickets do I have\?/);
    assert.match(user, /"count":3/);
    assert.ok(!/private ticket body/.test(user));    // the body never reaches the payload
  });
});

describe('answerShapePrompt — parseAnswerShapeOutput', () => {
  it('a shaped answer', () => {
    assert.deepEqual(parseAnswerShapeOutput('{"answer":"You have 3 open tickets."}'), { answer: 'You have 3 open tickets.', showList: false });
  });
  it('showList sentinel → defer to the deterministic render', () => {
    assert.deepEqual(parseAnswerShapeOutput('{"showList":true}'), { answer: null, showList: true });
  });
  it('unparseable / empty → fall back to the render', () => {
    assert.deepEqual(parseAnswerShapeOutput('not json'), { answer: null, showList: false });
    assert.deepEqual(parseAnswerShapeOutput('{}'), { answer: null, showList: false });
    assert.deepEqual(parseAnswerShapeOutput('{"answer":""}'), { answer: null, showList: false });
  });
});
