// Core/contactRoles.test.js — v2.74.2112. The one contact reader + the "who is the CSR on this?" ask.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readContacts, selectContacts, askContactRole, renderContactAnswer, renderContactRoster, answerContactRole, CONTACT_ROLES } from './contactRoles.js';

// The REAL TaskContacts payload, keys verbatim from the HAR (2026-08-08, two sampled tasks — same four-row shape
// both times). The builder's CSR and coordinator ride on every warranty task alongside the buyers.
const ROW = {
  TicketId: 4903279,
  __contacts: [
    { Email: 'dana@example.com', CellPhone: '919-555-0142', ContactMethod: 'Any', IsPrimary: true, IsDrHorton: false, IsBuyer: true, AssignmentType: null, Id: 1, FirstName: 'Dana', LastName: 'Reyes', FullName: 'Dana Reyes' },
    { Email: 'marcus@example.com', CellPhone: '919-555-0188', ContactMethod: '-1', IsDrHorton: false, AssignmentType: null, Id: 2, FirstName: 'Marcus', LastName: 'Reyes', FullName: 'Marcus Reyes' },
    { Email: 'priya@drhorton.com', WorkPhone: '919-555-0100', ContactMethod: 'Any', IsDrHorton: true, AssignmentType: 'CSR', Id: 3, FirstName: 'Priya', LastName: 'Shah', FullName: 'Priya Shah' },
    { Email: 'lee@drhorton.com', CellPhone: '919-555-0177', ContactMethod: 'Any', IsDrHorton: true, AssignmentType: 'COORDINATOR', Id: 4, FirstName: 'Lee', LastName: 'Ortiz', FullName: 'Lee Ortiz' },
  ],
};

describe('contactRoles — reading the list by the record\'s own flags', () => {
  it('separates the two homeowners from the two builder staff, homeowners first', () => {
    const all = readContacts(ROW);
    assert.deepEqual(all.map((p) => p.name), ['Dana Reyes', 'Marcus Reyes', 'Priya Shah', 'Lee Ortiz']);
    assert.deepEqual(all.map((p) => p.isHomeowner), [true, true, false, false]);
    assert.deepEqual(all.map((p) => p.role),
      ['Primary homeowner', 'Secondary homeowner', 'CSR (D.R. Horton)', 'COORDINATOR (D.R. Horton)']);
  });

  it('the co-buyer survives even though the payload omits IsBuyer/IsPrimary for them', () => {
    // The serializer drops false booleans, so the second homeowner arrives with NO flags at all.
    const marcus = readContacts(ROW)[1];
    assert.equal(marcus.isHomeowner, true);
    assert.equal(marcus.isPrimary, false);
    assert.equal(marcus.prefers, '', 'ContactMethod "-1" is the unset sentinel, never a method to print');
  });

  it('keeps every phone with its label — a work line is not a cell', () => {
    const [dana, , priya] = readContacts(ROW);
    assert.deepEqual(dana.phones, [{ label: 'cell', number: '919-555-0142' }]);
    assert.deepEqual(priya.phones, [{ label: 'work', number: '919-555-0100' }]);
    assert.equal(dana.prefers, 'Any');
  });

  it('a record with no contacts yields nothing, never a guess', () => {
    assert.deepEqual(readContacts({ TicketId: 1 }), []);
    assert.deepEqual(readContacts(null), []);
  });
});

describe('contactRoles — selecting by role', () => {
  const all = readContacts(ROW);
  it('each role selects exactly its own people', () => {
    assert.deepEqual(selectContacts(all, 'primary').map((p) => p.name), ['Dana Reyes']);
    assert.deepEqual(selectContacts(all, 'secondary').map((p) => p.name), ['Marcus Reyes']);
    assert.deepEqual(selectContacts(all, 'homeowner').map((p) => p.name), ['Dana Reyes', 'Marcus Reyes']);
    assert.deepEqual(selectContacts(all, 'csr').map((p) => p.name), ['Priya Shah']);
    assert.deepEqual(selectContacts(all, 'coordinator').map((p) => p.name), ['Lee Ortiz']);
    assert.deepEqual(selectContacts(all, 'staff').map((p) => p.name), ['Priya Shah', 'Lee Ortiz']);
  });
  it('the CSR and the coordinator are NEVER selected as a homeowner, and vice versa', () => {
    for (const staffRole of ['csr', 'coordinator', 'staff']) {
      for (const p of selectContacts(all, staffRole)) assert.equal(p.isHomeowner, false, `${staffRole} returned a homeowner`);
    }
    for (const ownerRole of ['primary', 'secondary', 'homeowner']) {
      for (const p of selectContacts(all, ownerRole)) assert.equal(p.isStaff, false, `${ownerRole} returned builder staff`);
    }
  });
  it('an unknown role selects nobody rather than the nearest person', () => {
    assert.deepEqual(selectContacts(all, 'sales rep'), []);
    assert.deepEqual(selectContacts(all, ''), []);
  });
});

describe('contactRoles — parsing the ask', () => {
  it('reads the role and the ticket out of the canonical ask', () => {
    assert.deepEqual(askContactRole('who is the CSR on #4903279'), { role: 'csr', want: 'name', each: false, ticket: '4903279' });
  });
  it('handles each role the user named', () => {
    assert.equal(askContactRole('who is the coordinator').role, 'coordinator');
    assert.equal(askContactRole('who is the primary homeowner').role, 'primary');
    assert.equal(askContactRole('who is the secondary homeowner').role, 'secondary');
    assert.equal(askContactRole("who's the primary contact on 4903279").role, 'primary');
    assert.equal(askContactRole('who is the co-buyer').role, 'secondary');
  });
  it('the specific role wins over the generic one', () => {
    // "primary homeowner" must not be eaten by the bare homeowner pattern, and a CSR is never a homeowner read.
    assert.equal(askContactRole('who is the primary homeowner').role, 'primary');
    assert.equal(askContactRole('who is the customer service representative').role, 'csr');
    assert.equal(askContactRole('who is the homeowner').role, 'homeowner');
  });
  it('a named channel sets what comes back', () => {
    assert.equal(askContactRole("what's the CSR's phone number").want, 'phone');
    assert.equal(askContactRole('email for the coordinator').want, 'email');
    assert.equal(askContactRole('who is the CSR').want, 'name');
  });
  it('a bare role word is NOT a contact ask — this must stay off the branch/route paths', () => {
    assert.equal(askContactRole('process these primary tasks'), null);
    assert.equal(askContactRole('draft the replacements'), null);
    assert.equal(askContactRole('get open warranty tasks'), null);
    assert.equal(askContactRole(''), null);
    assert.equal(askContactRole(null), null);
  });
  it('reports the ticket WITHOUT dereferencing it — a typed number is never the internal TaskId', () => {
    // connectorRecipes.js:915 — feeding a user-typed ticket number to TaskContacts/{taskId} is a bare http-500.
    assert.equal(askContactRole('who is the CSR on #4903279').ticket, '4903279');
    assert.equal(askContactRole('who is the CSR').ticket, '');
  });
});

describe('contactRoles — the answer is role-honest', () => {
  it('names the person and the role the RECORD states', () => {
    const a = answerContactRole(ROW, 'who is the CSR on #4903279', { recordLabel: '#4903279' });
    assert.match(a.text, /^The CSR on #4903279 is Priya Shah — CSR \(D\.R\. Horton\)/);
    assert.match(a.text, /919-555-0100 \(work\)/);
  });
  it('a missing role says so and lists who IS there — never the nearest person', () => {
    const noStaff = { __contacts: [ROW.__contacts[0]] };
    const text = renderContactAnswer({ people: readContacts(noStaff), role: 'csr', recordLabel: '#4903279' });
    assert.match(text, /No CSR is listed on #4903279/);
    assert.match(text, /Dana Reyes — Primary homeowner/);
    assert.doesNotMatch(text, /The CSR .* is Dana/);
  });
  it('"no contacts loaded" is a different answer from "no such person"', () => {
    const text = renderContactAnswer({ people: [], role: 'csr', recordLabel: '#4903279' });
    assert.match(text, /don't have the contacts on #4903279 loaded/);
    assert.doesNotMatch(text, /No CSR is listed/);
  });
  it('two people in one role are both listed, never silently reduced to one', () => {
    const text = renderContactAnswer({ people: readContacts(ROW), role: 'homeowner', recordLabel: '#4903279' });
    assert.match(text, /2 people hold that role/);
    // markdown list items, not indented lines: the caller renders through renderMarkdown, where a 4-space indent
    // becomes a code block and a bare newline collapses the list into one paragraph
    assert.match(text, /^- Dana Reyes — Primary homeowner/m);
    assert.match(text, /^- Marcus Reyes — Secondary homeowner/m);
  });
  it('a person with no number for the channel asked says so rather than going quiet', () => {
    const noPhone = { __contacts: [{ FullName: 'Ada Vale', Email: 'ada@example.com', IsDrHorton: true, AssignmentType: 'CSR' }] };
    const text = renderContactAnswer({ people: readContacts(noPhone), role: 'csr', want: 'phone' });
    assert.match(text, /no phone on the record/);
  });
  it('a non-contact ask returns null so every other path is untouched', () => {
    assert.equal(answerContactRole(ROW, 'draft the replacements'), null);
  });
  it('every declared role is answerable and never throws', () => {
    for (const role of CONTACT_ROLES) {
      assert.ok(renderContactAnswer({ people: readContacts(ROW), role }).length > 0, `${role} rendered nothing`);
    }
  });
});

describe('contactRoles — the DISTRIBUTIVE ask (v2.74.2116)', () => {
  // Live 2026-08-08: after listing 3 warranty tasks, "who is the CSR for each?" fell through to the field-read
  // path — "I couldn't find a CSR field on these records" — which is true of the flat columns and useless.
  it('reads "for each" as a map over the rows, not a question about one record', () => {
    assert.equal(askContactRole('who is the CSR for each?').each, true);
    assert.equal(askContactRole('who is the coordinator on every task').each, true);
    assert.equal(askContactRole('who are the CSRs').each, true, 'the plural IS the distributive phrasing');
    assert.equal(askContactRole('who are the homeowners').each, true);
  });
  it('a plural role name still parses to its role (a word-boundary csr pattern misses "CSRs")', () => {
    assert.equal(askContactRole('who are the CSRs').role, 'csr');
    assert.equal(askContactRole('who are the coordinators').role, 'coordinator');
  });
  it('a single-record ask is NOT distributive', () => {
    assert.equal(askContactRole('who is the CSR on #4903279').each, false);
    assert.equal(askContactRole('who is the CSR').each, false);
  });

  const roster = (spec) => spec.map(([label, staff]) => ({
    label,
    people: readContacts({ __contacts: [
      { FullName: 'Dana ' + label, IsPrimary: true, IsBuyer: true, IsDrHorton: false, CellPhone: '919-555-0100' },
      ...(staff ? [{ FullName: 'Priya ' + label, IsDrHorton: true, AssignmentType: 'CSR', WorkPhone: '919-555-0111' }] : []),
    ] }),
  }));

  it('names EVERY row, including the ones with nobody in the role', () => {
    const text = renderContactRoster({ items: roster([['#1', true], ['#2', true], ['#3', false]]), role: 'csr' });
    assert.match(text, /^2 of 3 have a CSR listed:/m);
    assert.match(text, /^- \*\*#3\*\* — no CSR listed \(1 contact\(s\) on it\)/m);
    assert.equal(text.split(String.fromCharCode(10)).length, 4, 'a silently shortened list reads as a complete one');
  });
  it('says so plainly when every row has one', () => {
    assert.match(renderContactRoster({ items: roster([['#1', true], ['#2', true]]), role: 'csr' }), /^The CSR on each:/);
  });
  it('states each person’s role verbatim, so builder staff are visible as such', () => {
    const text = renderContactRoster({ items: roster([['#1', true]]), role: 'csr' });
    assert.match(text, /Priya #1 — CSR \(D\.R\. Horton\)/);
  });
  it('never invents a roster from nothing', () => {
    assert.match(renderContactRoster({ items: [], role: 'csr' }), /don't have any records in hand/);
  });
});
