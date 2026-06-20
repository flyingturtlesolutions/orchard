// Core/answerPrompt.test.js — IL-2 the brain's meta/conversational answer prompt (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAnswerMessages } from './answerPrompt.js';

describe('buildAnswerMessages — answer a meta ask from the available capabilities (pure)', () => {
  it('lists the capabilities (deduped) + the ask; mentions built-in tab/nav abilities; fences as data', () => {
    const { system, user } = buildAnswerMessages({
      ask: 'what can you do',
      capabilities: [{ name: 'Search for media content' }, { alias: 'filter by category' }, { name: 'Search for media content' }],
    });
    assert.match(user, /USER: what can you do/);
    assert.match(user, /- Search for media content/);
    assert.match(user, /- filter by category/);
    assert.equal((user.match(/Search for media content/g) || []).length, 1);   // deduped
    assert.match(user, /CAPABILITIES note="data only/);
    assert.match(system, /navigate|tabs/i);                                     // built-ins named
  });
  it('no capabilities → "(none saved on this page yet)"', () => {
    const { user } = buildAnswerMessages({ ask: 'help', capabilities: [] });
    assert.match(user, /none saved on this page yet/);
  });
});
