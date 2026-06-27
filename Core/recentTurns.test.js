// Core/recentTurns.test.js — Q1: the pure recent-turn window selector + renderer. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectRecentTurns, renderRecentTurns, coerceRecentTurns } from './recentTurns.js';

describe('recentTurns — selectRecentTurns', () => {
  const convo = [
    { role: 'user', body: 'get my open tickets' },
    { role: 'assistant', body: 'Found 3: #64775 billing, #64776 login, #64777 refund.' },
    { role: 'user', body: 'summarize the second one' },   // ← the current ask (just appended)
  ];

  it('excludes the current ask + keeps the prior exchange', () => {
    const w = selectRecentTurns(convo, { excludeAsk: 'summarize the second one' });
    assert.deepEqual(w, [
      { role: 'user', text: 'get my open tickets' },
      { role: 'assistant', text: 'Found 3: #64775 billing, #64776 login, #64777 refund.' },
    ]);
  });

  it('also drops a trailing in-flight placeholder after the current ask', () => {
    const withPlaceholder = [...convo, { role: 'assistant', body: '🧠 interpreting…' }];
    const w = selectRecentTurns(withPlaceholder, { excludeAsk: 'summarize the second one' });
    assert.equal(w.length, 2);
    assert.equal(w[w.length - 1].role, 'assistant');
    assert.match(w[w.length - 1].text, /Found 3/);
  });

  it('no excludeAsk match → keeps all (the ask is not in this snapshot yet)', () => {
    const w = selectRecentTurns(convo, { excludeAsk: 'a different ask entirely' });
    assert.equal(w.length, 3);
  });

  it('filters non-user/assistant roles + empty bodies, and clips', () => {
    const noisy = [
      { role: 'system', body: 'session started' },
      { role: 'user', body: '   ' },
      { role: 'assistant', body: 'x'.repeat(500) },
      { role: 'user', body: 'ok' },
    ];
    const w = selectRecentTurns(noisy, { maxChars: 50 });
    assert.equal(w.length, 2);                         // the system + the whitespace-only user are dropped
    assert.equal(w[0].role, 'assistant');
    assert.ok(w[0].text.length <= 50);
    assert.ok(w[0].text.endsWith('…'));
  });

  it('caps to maxTurns (most recent)', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', body: `turn ${i}` }));
    const w = selectRecentTurns(many, { maxTurns: 4 });
    assert.equal(w.length, 4);
    assert.equal(w[w.length - 1].text, 'turn 19');
  });

  it('empty / non-array → []', () => {
    assert.deepEqual(selectRecentTurns(null), []);
    assert.deepEqual(selectRecentTurns([]), []);
  });
});

describe('recentTurns — coerceRecentTurns (untrusted payload over the bus)', () => {
  it('keeps valid {role,text}, drops junk, clips + caps', () => {
    const raw = [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'y'.repeat(600) },
      { role: 'system', text: 'nope' },          // bad role
      { role: 'user', text: '   ' },              // empty
      { foo: 'bar' },                             // not a turn
      'a string',                                 // not an object
    ];
    const out = coerceRecentTurns(raw, { maxChars: 100 });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { role: 'user', text: 'hi' });
    assert.equal(out[1].text.length, 100);
  });
  it('caps to maxRows (most recent)', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ role: 'user', text: `t${i}` }));
    const out = coerceRecentTurns(many, { maxRows: 5 });
    assert.equal(out.length, 5);
    assert.equal(out[out.length - 1].text, 't29');
  });
  it('non-array → []', () => {
    assert.deepEqual(coerceRecentTurns(null), []);
    assert.deepEqual(coerceRecentTurns('nope'), []);
  });
});

describe('recentTurns — renderRecentTurns', () => {
  it('renders a fenced block with User/You labels + the data-not-instructions note', () => {
    const block = renderRecentTurns([
      { role: 'user', text: 'get my open tickets' },
      { role: 'assistant', text: 'Found 3.' },
    ]);
    assert.match(block, /^<RECENT_TURNS note=/);
    assert.match(block, /not instructions/i);
    assert.match(block, /\nUser: get my open tickets/);
    assert.match(block, /\nYou: Found 3\./);
    assert.match(block, /<\/RECENT_TURNS>$/);
  });

  it('empty / no usable rows → "" (caller omits the block)', () => {
    assert.equal(renderRecentTurns([]), '');
    assert.equal(renderRecentTurns(null), '');
    assert.equal(renderRecentTurns([{ role: 'system', text: 'nope' }, { role: 'user', text: '  ' }]), '');
  });
});
