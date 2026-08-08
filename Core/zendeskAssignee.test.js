// Core/zendeskAssignee.test.js — v2.74.2121. Who a warranty support request lands on.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assignmentFields, hasAssignment, describeAssignment, parseAssignAsk, CONTACT_TAG } from './zendeskAssignee.js';

describe('zendeskAssignee — normalizing what the user said', () => {
  it('takes an email, lowercased — the only form a person states from memory', () => {
    assert.deepEqual(assignmentFields({ email: '  Jane@Example.COM ' }), { assignee_email: 'jane@example.com' });
  });
  it('takes a numeric agent id or a group id', () => {
    assert.deepEqual(assignmentFields({ assigneeId: 27482910345 }), { assignee_id: 27482910345 });
    assert.deepEqual(assignmentFields({ groupId: 36000123 }), { group_id: 36000123 });
  });
  it('combines them when several are known', () => {
    const f = assignmentFields({ email: 'jane@example.com', groupId: 36000123 });
    assert.deepEqual(f, { assignee_email: 'jane@example.com', group_id: 36000123 });
  });
  it('rejects junk rather than passing it through to a write', () => {
    for (const bad of ['', null, 'not-an-email', 'a@b']) assert.deepEqual(assignmentFields({ email: bad }), {});
    for (const bad of [0, -1, 1.5, 'abc', NaN, null]) assert.deepEqual(assignmentFields({ assigneeId: bad }), {});
  });
});

describe('zendeskAssignee — fail closed', () => {
  it('any one of email / agent / group is enough to land it', () => {
    assert.equal(hasAssignment({ assignee_email: 'jane@example.com' }), true);
    assert.equal(hasAssignment({ assignee_id: 5 }), true);
    assert.equal(hasAssignment({ group_id: 7 }), true, 'a queue has owners — a group counts');
  });
  it('nothing is NOT enough', () => {
    assert.equal(hasAssignment({}), false);
    assert.equal(hasAssignment(null), false);
    assert.equal(hasAssignment({ subject: 'x' }), false);
  });
});

describe('zendeskAssignee — what the reviewer is told', () => {
  it('names the assignee in the form it was given', () => {
    assert.match(describeAssignment({ assignee_email: 'jane@example.com' }), /^Assigned to jane@example\.com\./);
    assert.match(describeAssignment({ assignee_id: 42 }), /^Assigned to agent 42\./);
    assert.match(describeAssignment({ group_id: 7 }), /^Assigned to group 7\./);
  });
  it('unassigned says we will NOT create it, and how to fix that', () => {
    const line = describeAssignment({});
    assert.match(line, /won't open them unassigned/);
    assert.match(line, /assign the support requests to/);
  });
  it('closes the requester question rather than leaving it open', () => {
    // The user's ruling: the requester is not required, so no Orchard account exists. A reader who is not told
    // this will ask; a reader told "no requester" would be misled, since Zendesk always sets one.
    assert.match(describeAssignment({ assignee_email: 'a@b.com' }), /Raised by your signed-in Zendesk account/);
    assert.doesNotMatch(describeAssignment({ assignee_email: 'a@b.com' }), /no requester/i);
  });
  it('never claims Zendesk REQUIRES an assignee — it does not; our workflow does', () => {
    const line = describeAssignment({});
    assert.doesNotMatch(line, /Zendesk requires/i);
    assert.match(line, /these ask a person to make a call/, 'the reason is the work, not the API');
  });
});

describe('zendeskAssignee — parsing the assign ask', () => {
  it('reads an email out of the natural phrasings', () => {
    assert.deepEqual(parseAssignAsk('assign the support requests to jane@example.com'), { email: 'jane@example.com' });
    assert.deepEqual(parseAssignAsk('assign them to Jane@Example.com'), { email: 'jane@example.com' });
    assert.deepEqual(parseAssignAsk('assign these to jane@example.com.'), { email: 'jane@example.com' });
  });
  it('reads a numeric id', () => {
    assert.deepEqual(parseAssignAsk('assign the support requests to 27482910345'), { assigneeId: 27482910345 });
  });
  it('a NAME comes back raw — resolving it here would pick a stranger', () => {
    assert.deepEqual(parseAssignAsk('assign the support requests to Jane Doe'), { raw: 'Jane Doe' });
  });
  it('anything else is not an assign ask', () => {
    for (const q of ['show the support requests', 'process these', 'assign', 'assign the tickets', '', null]) {
      assert.equal(parseAssignAsk(q), null, `${JSON.stringify(q)} should not parse`);
    }
  });
});

describe('zendeskAssignee — the class tag', () => {
  it('is a sibling of the live replacement tag, and stated in one place', () => {
    // The live create carried tags:["ci-warranty-replacements"], so the family is theirs, not invented — but the
    // exact name for the contact arm IS our choice, and it lives here so it can be corrected once.
    assert.equal(CONTACT_TAG, 'ci-warranty-contact');
    assert.match(CONTACT_TAG, /^ci-warranty-/);
  });
});
