// Core/contactChannel.test.js — v2.74.2122. Who gets emailed, who gets called, who is never contacted.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decideChannel, planChannels, describeChannelPlan, contactMethodClass, CUSTOMER_ANSWERABLE, INTERNAL_ONLY } from './contactChannel.js';

const homeowner = (prefers, email = 'dana@example.com') => ({ name: 'Dana Reyes', email, phone: '919-555-0142', prefers, isHomeowner: true, isPrimary: true });

describe('contactChannel — ContactMethod is an ALLOW-LIST (the enum is not fully known)', () => {
  it('classifies the values actually observed in the captures', () => {
    assert.equal(contactMethodClass('Any'), 'any');      // 6 of 8 rows
    assert.equal(contactMethodClass('-1'), 'unset');     // 2 of 8 rows — the unset sentinel
    assert.equal(contactMethodClass(''), 'unset');
    assert.equal(contactMethodClass(null), 'unset');
  });
  it('treats an explicit Email preference as email', () => {
    assert.equal(contactMethodClass('Email'), 'email');
    assert.equal(contactMethodClass('e-mail'), 'email');
  });
  it('ANY unrecognised value is "other" — the enum has values we have never seen', () => {
    for (const v of ['Phone', 'phone', 'Text', 'SMS', 'Mail', 'Do Not Contact', 'zzz']) {
      assert.equal(contactMethodClass(v), 'other', `${v} must not be read as email-permitting`);
    }
  });
});

describe('contactChannel — a stated phone preference is never overridden by a machine', () => {
  it('Phone routes to a CALL, not an email', () => {
    const d = decideChannel({ cause: 'no-count', person: homeowner('Phone') });
    assert.equal(d.channel, 'call');
    assert.match(d.why, /asked to be reached by "Phone"/);
  });
  it('an UNKNOWN method also routes to a call — the conservative direction', () => {
    // Getting this backwards means the first homeowner who asked to be phoned is emailed by a machine.
    assert.equal(decideChannel({ cause: 'no-count', person: homeowner('Carrier Pigeon') }).channel, 'call');
  });
  it('Any and Email are emailed', () => {
    assert.equal(decideChannel({ cause: 'no-count', person: homeowner('Any') }).channel, 'email');
    assert.equal(decideChannel({ cause: 'named-product-unresolved', person: homeowner('Email') }).channel, 'email');
  });
  it('an UNSET preference is emailed, but says so distinctly', () => {
    const d = decideChannel({ cause: 'no-count', person: homeowner('-1') });
    assert.equal(d.channel, 'email');
    assert.match(d.why, /no contact preference recorded/, '"they said Any" and "nobody asked them" are different facts');
  });
  it('no address means a call, whatever the preference says', () => {
    assert.equal(decideChannel({ cause: 'no-count', person: homeowner('Any', '') }).channel, 'call');
    assert.equal(decideChannel({ cause: 'no-count', person: null }).channel, 'call');
  });
});

describe('contactChannel — the customer is never asked OUR questions (the retired "Not Deako" arm)', () => {
  it('other-trade is UNRESOLVED — emailing a homeowner about another trade is useless and insulting', () => {
    const d = decideChannel({ cause: 'other-trade', person: homeowner('Any') });
    assert.equal(d.channel, 'unresolved');
    assert.match(d.why, /another trade/);
  });
  it('other-trade stays internal even for a homeowner who would happily take email', () => {
    for (const m of ['Any', 'Email', '-1']) {
      assert.equal(decideChannel({ cause: 'other-trade', person: homeowner(m) }).channel, 'unresolved');
    }
  });
  it('already-handled is UNRESOLVED — our own records answer it', () => {
    assert.equal(decideChannel({ cause: 'already-handled', person: homeowner('Any') }).channel, 'unresolved');
  });
  it('an UNRECOGNISED cause contacts nobody — a guess is not a licence to email someone', () => {
    const d = decideChannel({ cause: 'mystery', person: homeowner('Any') });
    assert.equal(d.channel, 'unresolved');
    assert.match(d.why, /nobody is contacted on a guess/);
    assert.equal(decideChannel({ person: homeowner('Any') }).channel, 'unresolved');
  });
  it('the two cause sets do not overlap, and cover the four declared causes', () => {
    for (const c of CUSTOMER_ANSWERABLE) assert.ok(!INTERNAL_ONLY.includes(c), `${c} is in both sets`);
    assert.deepEqual([...CUSTOMER_ANSWERABLE, ...INTERNAL_ONLY].sort(),
      ['already-handled', 'named-product-unresolved', 'no-count', 'other-trade']);
  });
});

describe('contactChannel — the plan a reviewer reads', () => {
  const items = [
    { id: 'a', label: '#1', outcome: { cause: 'no-count' }, person: homeowner('Any') },
    { id: 'b', label: '#2', outcome: { cause: 'no-count' }, person: homeowner('Phone') },
    { id: 'c', label: '#3', outcome: { cause: 'other-trade' }, person: homeowner('Any') },
    { id: 'd', label: '#4', outcome: { cause: 'named-product-unresolved' }, person: homeowner('-1') },
  ];
  it('splits into email / call / internal, losing nothing', () => {
    const p = planChannels(items);
    assert.deepEqual(p.email.map((x) => x.id), ['a', 'd']);
    assert.deepEqual(p.call.map((x) => x.id), ['b']);
    assert.deepEqual(p.unresolved.map((x) => x.id), ['c']);
    assert.equal(p.email.length + p.call.length + p.unresolved.length, items.length, 'every item lands somewhere');
  });
  it('each item carries the DECISION, so a preview can say why', () => {
    const p = planChannels(items);
    assert.match(p.call[0].decision.why, /Phone/);
    assert.match(p.email[1].decision.why, /no contact preference recorded/);
  });
  it('the summary names every non-empty bucket', () => {
    const line = describeChannelPlan(planChannels(items));
    assert.match(line, /2 to email the homeowner/);
    assert.match(line, /1 needing a phone call/);
    assert.match(line, /1 for us to settle/);
  });
  it('an empty plan says so rather than rendering an empty sentence', () => {
    assert.match(describeChannelPlan(planChannels([])), /Nothing to send/);
    assert.match(describeChannelPlan(null), /Nothing to send/);
  });
});

describe('contactChannel — the summary never claims something already happened (v2.74.2133)', () => {
  const items = [
    { id: 'a', label: '#1', outcome: { cause: 'no-count' }, person: homeowner('Any') },
    { id: 'b', label: '#2', outcome: { cause: 'no-count' }, person: homeowner('Phone') },
    { id: 'c', label: '#3', outcome: { cause: 'other-trade' }, person: homeowner('Any') },
  ];
  it('leads with the fact that nothing has gone out', () => {
    // "1 emailed to the homeowner" stated, of a preview, that an email had reached a customer. A reviewer who
    // believes the send already happened will not check the draft — the opposite of what a preview is for.
    assert.match(describeChannelPlan(planChannels(items)), /^Nothing has been sent\./);
  });
  it('uses no PAST-TENSE verb for any bucket', () => {
    const line = describeChannelPlan(planChannels(items));
    for (const past of [/emailed/, /sent to/, /called/, /left/, /created/, /opened/]) {
      assert.doesNotMatch(line, past, `the summary must not say ${past}`);
    }
  });
  it('still names every non-empty bucket, as work still to do', () => {
    const line = describeChannelPlan(planChannels(items));
    assert.match(line, /1 to email the homeowner/);
    assert.match(line, /1 needing a phone call/);
    assert.match(line, /1 for us to settle/);
  });
});
