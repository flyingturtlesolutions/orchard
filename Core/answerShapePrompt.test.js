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
  it('CX-7f: a SINGLE record carries `details` so the answer is accurate, not just the coarse status', () => {
    const order = { data: { orders: { edges: [{ node: {
      id: 'gid://shopify/Order/99', name: 'DEAKO#500', displayFinancialStatus: 'PARTIALLY_REFUNDED', displayFulfillmentStatus: 'FULFILLED',
      totalPriceSet: { shopMoney: { amount: '86.40', currencyCode: 'USD' } },
      returns: { edges: [{ node: { status: 'IN_PROGRESS', returnLineItems: { edges: [] } } }] },
      refunds: [{ totalRefundedSet: { shopMoney: { amount: '86.40', currencyCode: 'USD' } } }],
    } }] } } };
    const f = readShapeFacts(order);
    assert.equal(f.kind, 'object');
    assert.equal(f.count, 1);
    assert.equal(f.sample[0].details.Payment, 'PARTIALLY_REFUNDED');   // the shaper can now say "partially refunded"
    assert.equal(f.sample[0].details.Return, '1 (in progress)');
    assert.equal(f.sample[0].details.Refunded, '86.40 USD');
    assert.ok(!('details' in readShapeFacts(TICKETS).sample[0]));       // a MULTI list stays lean (size + privacy)
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
