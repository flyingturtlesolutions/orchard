// Core/zendeskRequester.test.js — v2.74.2119. The desk requester identity, against HAR-verified response shapes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deskUserParams, classifyUserCreate, isDuplicateEmail, deskUserIdFrom, describeRequester, DESK_USER } from './zendeskRequester.js';

// Quoted from deako.zendesk.com HAR, 2026-08-08 (values replaced, shape verbatim).
const CREATED_201 = { user: { id: 27482910345, name: 'Orchard (Warranty Desk)', email: 'desk@example.com', role: 'end-user', verified: false, active: true } };
const DUPLICATE_422 = {
  error: 'RecordInvalid',
  description: 'Record validation errors',
  details: { email: [{ description: 'Email: desk@example.com is already being used by another user', error: 'DuplicateValue' }] },
};

describe('zendeskRequester — the account params', () => {
  it('builds name + email, lowercasing the address that IS the identity', () => {
    assert.deepEqual(deskUserParams('  Desk@Example.COM '), { name: DESK_USER.name, email: 'desk@example.com' });
  });
  it('accepts a caller-chosen display name', () => {
    assert.equal(deskUserParams('desk@example.com', { name: 'Deako Warranty Bot' }).name, 'Deako Warranty Bot');
  });
  it('never invents an address — a bad or missing email yields null', () => {
    for (const bad of ['', null, undefined, 'not-an-email', 'a@b', '  ', 'a b@c.com']) {
      assert.equal(deskUserParams(bad), null, `${JSON.stringify(bad)} should not produce params`);
    }
  });
  it('the role is NOT a parameter — a caller can never ask for an agent or admin', () => {
    assert.deepEqual(Object.keys(deskUserParams('desk@example.com')).sort(), ['email', 'name']);
    assert.equal(DESK_USER.role, 'end-user');
  });
});

describe('zendeskRequester — classifying the create (three states, only one is a failure)', () => {
  it('201 with a user id is CREATED, and carries the id', () => {
    const v = classifyUserCreate({ ok: true, value: CREATED_201 });
    assert.equal(v.state, 'created');
    assert.equal(v.id, 27482910345);
  });
  it('reads the body whether it arrives wrapped in a result or bare', () => {
    assert.equal(classifyUserCreate(CREATED_201).state, 'created');
    assert.equal(classifyUserCreate({ value: CREATED_201 }).state, 'created');
  });

  // The hinge: without this, the desk is un-bootstrappable on every run after the first.
  it('the 422 DuplicateValue is EXISTS, not a failure', () => {
    const v = classifyUserCreate({ ok: false, value: DUPLICATE_422 });
    assert.equal(v.state, 'exists');
    assert.match(v.why, /already belongs to a Zendesk user/);
  });
  it('EXISTS carries NO id — the 422 names the conflict, never the conflicting user', () => {
    // Guessing an id here would attribute every ticket to whoever that number happens to be.
    assert.equal(classifyUserCreate({ value: DUPLICATE_422 }).id, null);
  });
  it('recognises the duplicate by either the error code or its prose', () => {
    assert.equal(isDuplicateEmail(DUPLICATE_422), true);
    assert.equal(isDuplicateEmail({ details: { email: [{ description: 'Email: x is already being used by another user' }] } }), true);
    assert.equal(isDuplicateEmail({ details: { email: [{ error: 'BlankValue', description: 'Email: cannot be blank' }] } }), false);
    assert.equal(isDuplicateEmail({}), false);
  });
  it('any other outcome is FAILED and names itself', () => {
    const blank = classifyUserCreate({ ok: false, value: { error: 'RecordInvalid', description: 'Record validation errors', details: { email: [{ error: 'BlankValue', description: 'Email: cannot be blank' }] } } });
    assert.equal(blank.state, 'failed');
    assert.match(blank.why, /Record validation errors/);
    assert.equal(classifyUserCreate(null).state, 'failed');
    assert.match(classifyUserCreate(null).why, /nothing recognisable/, 'a bare "could not create" sends the reader nowhere');
  });
  it('a user object with no usable id is NOT a create', () => {
    assert.equal(classifyUserCreate({ value: { user: { name: 'x' } } }).state, 'failed');
    assert.equal(classifyUserCreate({ value: { user: { id: 0 } } }).state, 'failed');
  });
});

describe('zendeskRequester — finding the id after an EXISTS', () => {
  const SEARCH = { results: [
    { id: 111, name: 'Someone Else', email: 'other@example.com' },
    { id: 27482910345, name: 'Orchard (Warranty Desk)', email: 'desk@example.com' },
  ] };
  it('matches on the EMAIL, exactly — never on the display name', () => {
    assert.equal(deskUserIdFrom(SEARCH, 'desk@example.com'), 27482910345);
    assert.equal(deskUserIdFrom(SEARCH, 'DESK@EXAMPLE.COM'), 27482910345, 'addresses are case-insensitive');
  });
  it('reads the users / results / single-user shapes alike', () => {
    assert.equal(deskUserIdFrom({ users: SEARCH.results }, 'desk@example.com'), 27482910345);
    assert.equal(deskUserIdFrom(SEARCH.results, 'desk@example.com'), 27482910345);
    assert.equal(deskUserIdFrom({ user: SEARCH.results[1] }, 'desk@example.com'), 27482910345);
  });
  it('returns null rather than the first result when the address is absent', () => {
    assert.equal(deskUserIdFrom(SEARCH, 'nobody@example.com'), null);
    assert.equal(deskUserIdFrom({ results: [] }, 'desk@example.com'), null);
    assert.equal(deskUserIdFrom(null, 'desk@example.com'), null);
    assert.equal(deskUserIdFrom(SEARCH, ''), null);
  });
});

describe('zendeskRequester — what the reviewer is told before any ticket exists', () => {
  it('names the desk account and its user id when set up', () => {
    const line = describeRequester({ id: 27482910345, email: 'desk@example.com' });
    assert.match(line, /Orchard \(Warranty Desk\)/);
    assert.match(line, /Zendesk user 27482910345/);
  });
  it('without a desk id it says the ticket appears to come from YOU — never "no requester"', () => {
    // A Zendesk ticket always has a requester; the only question is who. Saying "none" would be false.
    const line = describeRequester({});
    assert.match(line, /would appear to come from you/);
    assert.doesNotMatch(line, /no requester/i);
  });
  it('a zero or junk id is not a requester', () => {
    for (const bad of [0, -1, null, 'abc', NaN]) assert.match(describeRequester({ id: bad }), /would appear to come from you/);
  });
});
