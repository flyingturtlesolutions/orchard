// Core/conversationPeek.test.js — the drawer "quick peek" derivation (v2.74.1217).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { conversationPeek, peekText } from './conversationPeek.js';

describe('conversationPeek — the recent-direction peek', () => {
  it('returns the most recent substantive user/assistant message, markdown stripped', () => {
    const msgs = [
      { role: 'user', body: 'show my open tickets' },
      { role: 'assistant', body: 'You have **3** open: #1 login, #2 refund, #3 billing.' },
    ];
    // bold markers stripped; inline `#1` ticket refs PRESERVED (heading-strip is line-start only).
    assert.equal(conversationPeek(msgs), 'You have 3 open: #1 login, #2 refund, #3 billing.');
  });

  it('strips headings, links, html, and code without mangling inline content', () => {
    const t = peekText('## Title\n\nSee [the docs](http://x) and `code`.');
    assert.ok(t.includes('Title') && t.includes('the docs') && t.includes('code'));
    assert.ok(!t.includes('http') && !t.includes('#') && !t.includes('`'));
    assert.equal(peekText('<b>bold</b> text'), 'bold text');
  });

  it('skips system / empty trailing messages and walks back to the freshest real line', () => {
    const msgs = [
      { role: 'assistant', body: 'Here is the plan.' },
      { role: 'system', body: 'internal' },
      { role: 'assistant', body: '   ' },
    ];
    assert.equal(conversationPeek(msgs), 'Here is the plan.');
  });

  it('caps length', () => {
    const long = 'word '.repeat(300);
    assert.ok(conversationPeek([{ role: 'assistant', body: long }], { maxChars: 50 }).length <= 50);
  });

  it('no substantive messages → empty string', () => {
    assert.equal(conversationPeek([]), '');
    assert.equal(conversationPeek([{ role: 'system', body: 'x' }]), '');
    assert.equal(conversationPeek(null), '');
  });
});
