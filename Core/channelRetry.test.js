// Core/channelRetry.test.js — CR-E2 (v2.74.928): the retry split that prevents double-executing a step
// whose response channel closed (executed-then-torn-down) while keeping the never-delivered retries.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isRetryableChannelError, isAmbiguousChannelClosed, IDEMPOTENT_MESSAGE_TYPES } from './channelRetry.js';

const NEVER = 'Could not establish connection. Receiving end does not exist.';
const CLOSED = 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';

describe('channelRetry — delivery-semantics split (CR-E2)', () => {
  it('never-delivered errors retry for ANY type — including the mutating EXECUTE_STEP', () => {
    assert.equal(isRetryableChannelError(NEVER, 'EXECUTE_STEP'), true);
    assert.equal(isRetryableChannelError('Receiving end does not exist', 'CHECK_CONDITION'), true);
    assert.equal(isRetryableChannelError('back/forward cache', 'EXECUTE_STEP'), true);
  });

  it('channel-closed retries ONLY for idempotent read/probe types', () => {
    assert.equal(isRetryableChannelError(CLOSED, 'CHECK_CONDITION'), true);
    assert.equal(isRetryableChannelError(CLOSED, 'WAIT_FOR_ELEM'), true);
    assert.equal(isRetryableChannelError(CLOSED, 'DOM_SNAPSHOT'), true);
    assert.equal(isRetryableChannelError(CLOSED, 'EXECUTE_STEP'), false, 'the double-submit hazard');
  });

  it('an unknown/new message type defaults to NOT retrying the ambiguous error (safe default)', () => {
    assert.equal(isRetryableChannelError(CLOSED, 'SOME_FUTURE_TYPE'), false);
    assert.equal(isRetryableChannelError(CLOSED, undefined), false);
  });

  it('non-channel errors never retry', () => {
    assert.equal(isRetryableChannelError('Landmark unresolvable', 'CHECK_CONDITION'), false);
    assert.equal(isRetryableChannelError('', 'EXECUTE_STEP'), false);
  });

  it('isAmbiguousChannelClosed distinguishes the executed-maybe case', () => {
    assert.equal(isAmbiguousChannelClosed(CLOSED), true);
    assert.equal(isAmbiguousChannelClosed(NEVER), false);
    assert.equal(isAmbiguousChannelClosed('other'), false);
  });

  it('EXECUTE_STEP is deliberately absent from the idempotent set', () => {
    assert.equal(IDEMPOTENT_MESSAGE_TYPES.has('EXECUTE_STEP'), false);
  });
});
