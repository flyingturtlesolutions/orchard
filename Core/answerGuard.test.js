// Core/answerGuard.test.js — the honesty belt: a side-effect COMMAND + a completion CLAIM on the no-dispatch
// answer path is a fabrication (the calendar "✅ I created it" bug, orchard-logs-20260627-212709). v2.74.1295.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { neutralizeFalseCompletion, looksLikeFalseCompletion, HONEST_REPLACEMENT } from './answerGuard.js';

describe('answerGuard — neutralizes a fabricated completion', () => {
  it('catches the exact calendar fabrication', () => {
    const ask = 'create calendar event: "test event" Monday June 22 2026 1pm';
    const ans = "I've just created that calendar event for you! ✅ \"test event\" is now on your Google Calendar.";
    const r = neutralizeFalseCompletion(ans, ask);
    assert.equal(r.neutralized, true);
    assert.equal(r.answer, HONEST_REPLACEMENT);
  });

  it('catches a first-person send claim', () => {
    assert.equal(looksLikeFalseCompletion("Done — I've sent the message to Bob.", 'send a message to Bob'), true);
  });

  it('catches a passive state claim ("is now updated")', () => {
    assert.equal(looksLikeFalseCompletion('Your profile is now updated.', 'update my profile'), true);
  });

  it('catches "I created" (simple past)', () => {
    assert.equal(looksLikeFalseCompletion('I created the ticket for you.', 'create a ticket'), true);
  });

  it('catches "has been scheduled"', () => {
    assert.equal(looksLikeFalseCompletion('The meeting has been scheduled.', 'schedule a meeting'), true);
  });
});

describe('answerGuard — leaves legitimate answers alone', () => {
  it('a QUESTION / how-to is not guarded (it explains, does not claim)', () => {
    const ask = 'how do I create a calendar event?';
    const ans = 'To create an event, click Create, then the event is created when you hit Save.';
    assert.equal(looksLikeFalseCompletion(ans, ask), false);
  });

  it('a read ask whose answer "created a summary" is untouched (not a side-effect command)', () => {
    assert.equal(looksLikeFalseCompletion("I've created a summary of the page below: …", 'summarize this page'), false);
  });

  it('"what can you do" is untouched', () => {
    assert.equal(looksLikeFalseCompletion('I can create events, send messages, and search your tickets.', 'what can you do?'), false);
  });

  it('a future-tense plan is not a completion claim', () => {
    assert.equal(looksLikeFalseCompletion("I'll create the event once you confirm.", 'create an event'), false);
  });

  it('reasoning verbs (reviewed / looked) are not side-effects', () => {
    assert.equal(looksLikeFalseCompletion("I've reviewed the page and here's what I found.", 'create an event'), false);
  });

  it('returns the original answer unchanged when not neutralized', () => {
    const ans = 'Here are your open tickets: …';
    const r = neutralizeFalseCompletion(ans, 'show my open tickets');
    assert.equal(r.neutralized, false);
    assert.equal(r.answer, ans);
  });

  it('empty inputs are safe', () => {
    assert.equal(looksLikeFalseCompletion('', 'create x'), false);
    assert.equal(looksLikeFalseCompletion('I created it', ''), false);
  });
});
