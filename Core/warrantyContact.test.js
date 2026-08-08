// Core/warrantyContact.test.js — v2.74.2110. The CONTACT arm's artifact: a support request to the team.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildContactTicket, buildContactTickets, homeownerFrom, contactsFrom, taskIdentityFrom, CONTACT_ASKS, describeContactTicket } from './warrantyContact.js';

// A warranty row shaped like the real one (HAR-verified keys) + the contacts sidecar the drill merges in.
const ROW = {
  TicketId: 4903279, TaskNumber: '01', TaskStatus: 'Open', Priority: 'Normal',
  AddressLine1: '1565 Fairlie Way', CityStateZip: 'Raleigh, NC 27603',
  ProjectName: 'Fairlie', ProjectDisplayName: 'Fairlie Park',
  Instructions: 'Please send homeowner deako switches',
  // The REAL TaskContacts payload, keys verbatim from the HAR (GET /api/Vendor/Warranty/TaskContacts/{taskId},
  // 2026-08-08, two sampled tasks — same four-row shape both times): the builder's CSR and coordinator ride on every
  // warranty task alongside the buyers, and only the flags tell them apart. Note the co-buyer carries NO IsBuyer /
  // IsPrimary at all — the serializer omits false booleans — which is exactly the case that must not be dropped.
  __contacts: [
    { Email: 'dana@example.com', CellPhone: '919-555-0142', ContactMethod: 'Any', IsPrimary: true, IsDrHorton: false, IsBuyer: true, AssignmentType: null, Id: 1, FirstName: 'Dana', LastName: 'Reyes', FullName: 'Dana Reyes' },
    { Email: 'marcus@example.com', CellPhone: '919-555-0188', ContactMethod: '-1', IsDrHorton: false, AssignmentType: null, Id: 2, FirstName: 'Marcus', LastName: 'Reyes', FullName: 'Marcus Reyes' },
    { Email: 'priya@drhorton.com', CellPhone: '919-555-0100', ContactMethod: 'Any', IsDrHorton: true, AssignmentType: 'CSR', Id: 3, FirstName: 'Priya', LastName: 'Shah', FullName: 'Priya Shah' },
    { Email: 'lee@drhorton.com', WorkPhone: '919-555-0177', ContactMethod: 'Any', IsDrHorton: true, AssignmentType: 'COORDINATOR', Id: 4, FirstName: 'Lee', LastName: 'Ortiz', FullName: 'Lee Ortiz' },
  ],
};

describe('warrantyContact — reading the person and the task off the row', () => {
  it('names the primary buyer as the person to call', () => {
    const who = homeownerFrom(ROW);
    assert.equal(who.name, 'Dana Reyes');
    assert.equal(who.email, 'dana@example.com');
    assert.equal(who.phone, '919-555-0142');
  });
  it('splits homeowners from builder staff by the flags the record carries, homeowners first', () => {
    const all = contactsFrom(ROW);
    assert.deepEqual(all.map((p) => p.name), ['Dana Reyes', 'Marcus Reyes', 'Priya Shah', 'Lee Ortiz']);
    assert.deepEqual(all.map((p) => p.isHomeowner), [true, true, false, false]);
    assert.deepEqual(all.map((p) => p.role),
      ['Primary homeowner', 'Secondary homeowner', 'CSR (D.R. Horton)', 'COORDINATOR (D.R. Horton)']);
  });
  it('the co-buyer survives even though the payload omits IsBuyer/IsPrimary for them', () => {
    // The serializer drops false booleans, so the second homeowner arrives with NO flags at all. Absence of a DRH
    // marker must read as homeowner-side — the other reading silently loses the person the user asked to always list.
    const marcus = contactsFrom(ROW)[1];
    assert.equal(marcus.isHomeowner, true);
    assert.equal(marcus.isPrimary, false);
    assert.equal(marcus.prefers, '', 'ContactMethod "-1" is the unset sentinel, never a method to print');
  });
  it('a CSR or coordinator is NEVER named as the person to call', () => {
    const csr = contactsFrom(ROW).find((p) => /CSR/.test(p.role));
    assert.equal(csr.isHomeowner, false);
    assert.equal(csr.isStaff, true);
    assert.equal(homeownerFrom(ROW).name, 'Dana Reyes');   // the PRIMARY buyer, not whoever sits first in the array
  });
  it('a task carrying only builder staff names no homeowner rather than promoting one', () => {
    const staffOnly = { __contacts: [{ FullName: 'Lee Ortiz', IsDrHorton: true, AssignmentType: 'COORDINATOR', CellPhone: '1' }] };
    assert.equal(homeownerFrom(staffOnly).name, '');
    assert.equal(contactsFrom(staffOnly)[0].isHomeowner, false);
  });
  it('keeps the phone LABEL — a work line and a cell are not interchangeable', () => {
    const all = contactsFrom(ROW);
    assert.equal(all[0].phoneLabel, 'cell');
    assert.equal(all[3].phoneLabel, 'work');
    assert.equal(all[0].prefers, 'Any');
  });
  it('a row with no contacts yields empty fields, never a guess', () => {
    assert.deepEqual(homeownerFrom({ TicketId: 1 }), { name: '', email: '', phone: '', role: '', prefers: '' });
    assert.deepEqual(contactsFrom({ TicketId: 1 }), []);
  });
  it('reads the task identity + location', () => {
    const id = taskIdentityFrom(ROW);
    assert.equal(id.ticketId, '4903279');
    assert.equal(id.address, '1565 Fairlie Way, Raleigh, NC 27603');
    assert.equal(id.project, 'Fairlie Park');
  });
});

describe('warrantyContact — the ticket is a SUPPORT REQUEST, not a customer email', () => {
  const t = buildContactTicket({ row: ROW, outcome: { arm: 'contact homeowner', cause: 'no-count' } });
  it('asks the TEAM to make the contact, and names the ask up front', () => {
    assert.match(t.comment, /^Please confirm the quantity on a Deako warranty task/);
    assert.match(t.comment, /WHAT WE NEED: How many switches does the homeowner need\?/);
  });
  // v2.74.2110 corrected (user: "every ticket has a requestor — orchard can be the requestor here"). The earlier
  // assertion here said "never sets a requester", which encoded a misreading: a Zendesk ticket always HAS one, so
  // the only real question was WHO. It is Orchard — never the homeowner, who is the person to be CALLED.
  it('names Orchard as the requester in the body, always', () => {
    assert.match(t.comment, /RAISED BY: Orchard \(warranty desk\)/);
  });
  it('carries requester_id when Orchard\'s Zendesk user id is known', () => {
    const withId = buildContactTicket({ row: ROW, outcome: { cause: 'no-count' }, requesterId: 4242 });
    assert.equal(withId.requester_id, 4242);
  });
  it('omits requester_id when unknown (Zendesk attributes it to the session) — and never uses the homeowner', () => {
    assert.equal('requester_id' in t, false);
    for (const bad of [null, 0, -1, 'abc', NaN]) {
      assert.equal('requester_id' in buildContactTicket({ row: ROW, outcome: { cause: 'no-count' }, requesterId: bad }), false);
    }
  });
  it('carries who to reach, where, and the task ids', () => {
    assert.match(t.comment, /HOMEOWNERS — call these/);
    assert.match(t.comment, /Dana Reyes\s+— Primary homeowner/);
    assert.match(t.comment, /Marcus Reyes\s+— Secondary homeowner/);
    assert.match(t.comment, /Phone: 919-555-0142 \(cell\)/);
    assert.match(t.comment, /ALSO ON THE TASK \(not the customer\)/);
    assert.match(t.comment, /Priya Shah\s+— CSR \(D\.R\. Horton\)/);
    // the staff block sits BELOW the homeowners — the agent calls from the top
    assert.ok(t.comment.indexOf('Dana Reyes') < t.comment.indexOf('Priya Shah'));
    assert.match(t.comment, /Address:\s+1565 Fairlie Way, Raleigh, NC 27603/);
    assert.match(t.comment, /Ticket:\s+#4903279/);
  });
  it('quotes the note verbatim as the evidence', () => {
    assert.match(t.comment, /THE NOTE SAYS\n\s+Please send homeowner deako switches/);
  });
  it('says WHY a machine could not settle it', () => {
    assert.match(t.comment, /WHY THIS NEEDS A PERSON: The note asks for switches but gives no quantity/);
  });
  it('the subject names the job, the person and the place', () => {
    assert.match(t.subject, /^Warranty #4903279 — confirm the quantity with Dana Reyes \(1565 Fairlie Way, Raleigh, NC 27603\)$/);
  });
  it('missing contact details degrade honestly, they do not vanish', () => {
    const bare = buildContactTicket({ row: { TicketId: 9, Instructions: 'send switches' }, outcome: { cause: 'no-count' } });
    assert.match(bare.comment, /HOMEOWNER — call this person/);
    assert.match(bare.comment, /no contacts on the task — look them up in VendorSuite/);
  });
});

describe('warrantyContact — the ask is CAUSE-SPECIFIC (one template would ask the wrong question)', () => {
  const forCause = (cause, outcome = {}) => buildContactTicket({ row: ROW, outcome: { cause, ...outcome } });
  it('no-count asks how many', () => assert.match(forCause('no-count').comment, /How many switches/));
  it('named-product-unresolved asks WHICH product, and quotes the name we could not match', () => {
    const t = forCause('named-product-unresolved', { fields: { product_name: 'Gen 9 hyperswitch' } });
    assert.match(t.comment, /Which Deako product is this\?/);
    assert.match(t.comment, /The note names: "Gen 9 hyperswitch"/);
    assert.match(t.subject, /confirm the product/);
  });
  it('other-trade asks for ROUTING, not a homeowner call', () => {
    const t = forCause('other-trade');
    assert.match(t.comment, /Who owns this\? It reads as another trade/);
    assert.match(t.subject, /route to the right trade/);
    assert.doesNotMatch(t.comment, /How many switches/);
  });
  it('already-handled asks to verify first, and is the one low-priority case', () => {
    const t = forCause('already-handled');
    assert.match(t.comment, /Has this already been handled\?/);
    assert.equal(t.priority, 'low');
  });
  it('every declared cause has an ask, a why and a verb', () => {
    for (const [cause, spec] of Object.entries(CONTACT_ASKS)) {
      assert.ok(spec.ask && spec.why && spec.verb, `${cause} is missing part of its ask`);
      assert.ok(buildContactTicket({ row: ROW, outcome: { cause } }), `${cause} builds no ticket`);
    }
  });
  it('an UNKNOWN cause writes nothing — a vague ticket is worse than none', () => {
    assert.equal(buildContactTicket({ row: ROW, outcome: { cause: 'mystery' } }), null);
    assert.equal(buildContactTicket({ row: ROW, outcome: {} }), null);
  });
});

describe('warrantyContact — one ticket per task', () => {
  it('builds 1:1 and reports what it skipped', () => {
    const { tickets, skipped } = buildContactTickets([
      { id: 'a', row: ROW, outcome: { cause: 'no-count' } },
      { id: 'b', row: { TicketId: 4888221, AddressLine1: '7356 Axel Creek St', Instructions: 'Electrical outlets loose' }, outcome: { cause: 'other-trade' } },
      { id: 'c', row: ROW, outcome: { cause: 'not-a-cause' } },
    ]);
    assert.equal(tickets.length, 2);
    assert.deepEqual(tickets.map((t) => t.id), ['a', 'b']);
    assert.deepEqual(skipped, [{ id: 'c', cause: 'not-a-cause' }]);
    assert.notEqual(tickets[0].subject, tickets[1].subject);   // each is independently actionable
  });
  it('the preview line names the cause and the subject', () => {
    const t = buildContactTicket({ row: ROW, outcome: { cause: 'no-count' } });
    assert.match(describeContactTicket({ ...t }), /^no-count — Warranty #4903279/);
  });
});

describe('warrantyContact — the homeowner projection carries the CONTACT METHOD (v2.74.2123)', () => {
  it('prefers rides along, because the channel decision is made from it', () => {
    // Dropping it made every homeowner read as "no preference recorded", so a contact who asked to be PHONED
    // would have been emailed by a machine — the one failure ContactMethod exists to prevent.
    const row = { __contacts: [{ FullName: 'Dana Reyes', IsPrimary: true, IsBuyer: true, IsDrHorton: false, Email: 'd@x.com', CellPhone: '1', ContactMethod: 'Phone' }] };
    assert.equal(homeownerFrom(row).prefers, 'Phone');
  });
  it('an unset preference projects as empty, not as absent', () => {
    const row = { __contacts: [{ FullName: 'Dana', IsPrimary: true, IsBuyer: true, IsDrHorton: false, Email: 'd@x.com', ContactMethod: '-1' }] };
    assert.equal(homeownerFrom(row).prefers, '');
  });
});
