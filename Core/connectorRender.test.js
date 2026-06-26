// Core/connectorRender.test.js — generic session-ride result rendering (CX-4c). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { primaryList, primaryObject, summarizeItem, renderConnectorLines, itemLabels } from './connectorRender.js';

describe('primaryList — find the data array', () => {
  it('prefers known data keys, falls back to any object-array, ignores scalar arrays', () => {
    assert.equal(primaryList({ results: [{ id: 1 }] }).length, 1);
    assert.equal(primaryList({ tickets: [{ id: 1 }, { id: 2 }] }).length, 2);
    assert.equal(primaryList({ comments: [{ id: 9 }] })[0].id, 9);
    assert.equal(primaryList({ things: [{ id: 3 }] }).length, 1);             // unknown key, array-of-objects → still found
    assert.equal(primaryList({ tags: ['a', 'b'], count: 0 }), null);          // a scalar array is not the data list
    assert.deepEqual(primaryList([{ id: 1 }]), [{ id: 1 }]);                  // a bare array
    assert.equal(primaryList(null), null);
  });
});

describe('primaryObject — find the single record', () => {
  it('unwraps {ticket:{…}}/{user:{…}}; takes the value itself when id/name-shaped; else null', () => {
    assert.equal(primaryObject({ ticket: { id: 7 } }).id, 7);
    assert.equal(primaryObject({ user: { id: 4, name: 'Al' } }).name, 'Al');
    assert.equal(primaryObject({ id: 5, subject: 's' }).id, 5);              // bare record
    assert.equal(primaryObject({ meta: 'x', count: 0 }), null);             // no id / name → not a record
  });
});

describe('summarizeItem — salient fields, app-agnostic', () => {
  it('a ticket: id + subject(name) + status; full adds the description body', () => {
    const t = { id: 64775, subject: 'Switches no longer working', status: 'open', description: 'They stopped.' };
    assert.deepEqual(summarizeItem(t), { id: 64775, title: 'Switches no longer working', status: 'open', body: '', url: null });
    assert.equal(summarizeItem(t, { full: true }).body, 'They stopped.');    // distinct name + content → body shown
  });
  it('a content-only item (a comment / message): the text becomes the title (no separate body)', () => {
    const c = { id: 9, body: 'Please call me back', public: false };
    const s = summarizeItem(c, { full: true });
    assert.equal(s.title, 'Please call me back');
    assert.equal(s.body, '');                                                // name absent → content IS the title, not duplicated
  });
  it('drops an /api/ url (not user-facing), keeps a real one', () => {
    assert.equal(summarizeItem({ id: 1, url: 'https://x.zendesk.com/api/v2/tickets/1.json' }).url, null);
    assert.equal(summarizeItem({ id: 1, html_url: 'https://x.com/t/1' }).url, 'https://x.com/t/1');
  });
});

describe('renderConnectorLines — the chat lines', () => {
  it('a ticket list → header (N): + bullets; an empty list → header.', () => {
    const lines = renderConnectorLines({ results: [{ id: 1, subject: 'A', status: 'open' }, { id: 2, subject: 'B', status: 'open' }] }, { name: 'My open Zendesk tickets' });
    assert.equal(lines[0], 'My open Zendesk tickets (2):');
    assert.equal(lines[1], '• #1 A — open');
    assert.deepEqual(renderConnectorLines({ tickets: [] }, { name: 'Tickets' }), ['Tickets (0).']);
  });
  it('a comments list (different shape) renders too — content as the title', () => {
    const lines = renderConnectorLines({ comments: [{ id: 9, body: 'Call me back' }] }, { name: 'Conversation' });
    assert.equal(lines[0], 'Conversation (1):');
    assert.equal(lines[1], '• #9 Call me back');
  });
  it('caps a long list at 25 with a "+ N more" note (no silent truncation)', () => {
    const big = Array.from({ length: 30 }, (_, i) => ({ id: i, subject: `t${i}` }));
    const lines = renderConnectorLines({ results: big }, { name: 'X' });
    assert.equal(lines.length, 1 + 25 + 1);                                  // header + 25 rows + the "+5 more"
    assert.equal(lines[lines.length - 1], '… +5 more');
  });
  it('a single object → id/title/status + body + a user-facing url', () => {
    const lines = renderConnectorLines({ ticket: { id: 7, subject: 'Boom', status: 'open', description: 'It broke', html_url: 'https://x.com/t/7' } }, { name: 'Ticket' });
    assert.equal(lines[0], '#7 Boom — open');
    assert.equal(lines[1], 'It broke');
    assert.equal(lines[2], 'https://x.com/t/7');
  });
  it('nothing displayable → null (caller shows "Done.")', () => {
    assert.equal(renderConnectorLines({ ok: true }, {}), null);
    assert.equal(renderConnectorLines(null, {}), null);
  });
});

describe('itemLabels — fan-out labels from a read (CV-4-full)', () => {
  it('projects a ticket list into "#id title" labels; reports total + uncapped', () => {
    const r = itemLabels({ results: [{ id: 1, subject: 'A' }, { id: 2, subject: 'B' }] });
    assert.deepEqual(r.labels, ['#1 A', '#2 B']);
    assert.equal(r.total, 2);
    assert.equal(r.capped, false);
  });
  it('caps at the limit + flags capped (no silent truncation — the caller says "N of M")', () => {
    const big = Array.from({ length: 25 }, (_, i) => ({ id: i, subject: `t${i}` }));
    const r = itemLabels({ results: big }, 20);
    assert.equal(r.labels.length, 20);
    assert.equal(r.total, 25);
    assert.equal(r.capped, true);
  });
  it('a content-only item (no id) → just the title; a listless/empty/null result → no labels', () => {
    assert.deepEqual(itemLabels({ comments: [{ body: 'Call me back' }] }).labels, ['Call me back']);
    assert.deepEqual(itemLabels({ ticket: { id: 7 } }).labels, [], 'a single object is not a list');
    assert.deepEqual(itemLabels(null).labels, []);
  });
});
