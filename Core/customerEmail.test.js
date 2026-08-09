// Core/customerEmail.test.js — v2.74.2129. What the homeowner receives, and what must never be in it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCustomerEmail, findInternals, assertNoInternals, CUSTOMER_CAUSES } from './customerEmail.js';
import { buildContactTicket } from './warrantyContact.js';
import { CUSTOMER_ANSWERABLE } from './contactChannel.js';

const DANA = { name: 'Dana Reyes', email: 'dana@example.com', phone: '336-555-0142', prefers: 'Any', isHomeowner: true, isPrimary: true };
const NOTE = 'Homeowner states light switches sticking, please send replacements';

describe('customerEmail — the message PERFORMS the ask (v2.74.2131)', () => {
  const m = buildCustomerEmail({ person: DANA, outcome: { cause: 'no-count' }, instructions: NOTE });
  it('asks the two things we actually need: WHICH switches and HOW MANY', () => {
    assert.match(m.body, /Which switches are giving you trouble, and how many need replacing\?/);
  });
  it('does NOT quote the task instructions back at them', () => {
    // Those instructions are the BUILDER's work order to Deako, not the customer's words. Quoting them attributes
    // to the homeowner a demand addressed to someone else, and invites them to answer our paperwork.
    assert.doesNotMatch(m.body, /Please send homeowner deako switches/);
    assert.doesNotMatch(m.body, /It says:/);
    assert.doesNotMatch(m.body, /warranty request for your home[\s\S]*"/, 'no quoted record of any kind');
  });
  it('offers the easiest way to answer rather than demanding precision', () => {
    assert.match(m.body, /Rooms are enough/);
  });
  it('TITLE-CASES the greeting name — records store whatever casing they like', () => {
    const lower = buildCustomerEmail({ person: { name: 'harminder singh', email: 'h@x.com' }, outcome: { cause: 'no-count' } });
    assert.match(lower.body, /^Hi Harminder,/);
    const upper = buildCustomerEmail({ person: { name: 'DANA REYES', email: 'd@x.com' }, outcome: { cause: 'no-count' } });
    assert.match(upper.body, /^Hi Dana,/);
  });
  it('falls back to a plain greeting when no name is known', () => {
    const anon = buildCustomerEmail({ person: { email: 'x@y.com' }, outcome: { cause: 'no-count' } });
    assert.match(anon.body, /^Hello,/);
  });
  it('tells them how to answer, in the channel they were reached on', () => {
    assert.match(m.body, /reply to this email/);
  });
  it('the subject is about THEIR switches, not about our process', () => {
    assert.equal(m.subject, 'Your Deako replacement switches');
    assert.doesNotMatch(m.subject, /warranty task|request|#\d+/i);
  });
  it('the photo hint appears only where a photo would help', () => {
    const named = buildCustomerEmail({ person: DANA, outcome: { cause: 'named-product-unresolved' } });
    assert.match(named.body, /a photo of one of them/);
    assert.doesNotMatch(m.body, /photo/);
  });
  it('goes to their address', () => assert.equal(m.to, 'dana@example.com'));
});

describe('customerEmail — nothing internal leaves', () => {
  const m = buildCustomerEmail({ person: DANA, outcome: { cause: 'no-count' }, instructions: NOTE });
  it('carries NO phone number, staff, builder name, task id or internal header', () => {
    assert.deepEqual(findInternals(m.body), []);
    assert.equal(assertNoInternals(m.body), true);
  });
  it('does not name the OTHER contacts on the task', () => {
    assert.deepEqual(findInternals(m.body, { extraNames: ['Marcus Reyes', 'Priya Shah', 'Lee Ortiz'] }), []);
  });

  // The failure this module exists to prevent, pinned as a test: the INTERNAL artifact must be caught by the guard.
  it('the internal support-request body would be REJECTED by the guard', () => {
    const row = {
      TicketId: 4899327, TaskNumber: '01', AddressLine1: '2935 Burgess Drive', Instructions: NOTE,
      __contacts: [
        { FullName: 'Dana Reyes', IsPrimary: true, IsBuyer: true, IsDrHorton: false, Email: 'dana@example.com', CellPhone: '336-555-0142' },
        { FullName: 'Priya Shah', IsDrHorton: true, AssignmentType: 'CSR', WorkPhone: '336-555-0100' },
      ],
    };
    const internal = buildContactTicket({ row, outcome: { cause: 'no-count' } });
    const hits = findInternals(internal.comment, { extraNames: ['Priya Shah'] });
    assert.ok(hits.length >= 3, `the internal body should trip several guards, got: ${hits.join(', ')}`);
    assert.ok(hits.includes('phone number'), 'it lists the homeowner phone numbers');
    assert.ok(hits.includes('builder staff role'), 'it names the builder CSR');
    assert.throws(() => assertNoInternals(internal.comment), /internal detail/);
  });
});

describe('customerEmail — only causes a customer can answer produce a message', () => {
  it('the two answerable causes each have one', () => {
    for (const c of ['no-count', 'named-product-unresolved']) {
      assert.ok(buildCustomerEmail({ person: DANA, outcome: { cause: c }, instructions: NOTE }), `${c} produced nothing`);
    }
  });
  it('an INTERNAL cause produces NOTHING — a second guard on top of the channel routing', () => {
    for (const c of ['other-trade', 'already-handled', 'mystery', '']) {
      assert.equal(buildCustomerEmail({ person: DANA, outcome: { cause: c }, instructions: NOTE }), null, `${c} must not produce a customer email`);
    }
  });
  it('its cause list matches the channel layer exactly — one place cannot widen without the other', () => {
    assert.deepEqual([...CUSTOMER_CAUSES].sort(), [...CUSTOMER_ANSWERABLE].sort());
  });
  it('no address means no draft — an unsendable message is not a draft', () => {
    assert.equal(buildCustomerEmail({ person: { ...DANA, email: '' }, outcome: { cause: 'no-count' } }), null);
    assert.equal(buildCustomerEmail({ outcome: { cause: 'no-count' } }), null);
  });
  it('the note is IRRELEVANT to the body — same message with or without it', () => {
    const withNote = buildCustomerEmail({ person: DANA, outcome: { cause: 'no-count' }, instructions: NOTE });
    const without = buildCustomerEmail({ person: DANA, outcome: { cause: 'no-count' }, instructions: '' });
    assert.equal(withNote.body, without.body, "the work order must not shape the customer message");
  });
});
