// Core/redact.test.js — R-1 (v2.74.1662): the pre-`#call` PII redactor.
//
// The JSON cases are the ones that matter most. ~40 call sites JSON-parse the model's reply, so a restore that
// corrupts a parse does not degrade an answer — it loses the whole response.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  redact, redactDeep, restore, newRedactionMap, residualPii,
  PSEUDONYM_RE, REDACTION_CLASSES,
} from './redact.js';

const roundTrip = (text, opts = {}) => {
  const r = redact(text, opts);
  return { ...r, back: restore(r.text, r.map).text };
};

describe('redact — detection classes', () => {
  it('redacts emails, phones, uuids and long numeric ids', () => {
    const src = 'mail jane.doe@acme.co or call (555) 123-4567 — ref 550e8400-e29b-41d4-a716-446655440000 / 10834758';
    const { text } = redact(src);
    assert.ok(!text.includes('jane.doe@acme.co'));
    assert.ok(!text.includes('555'));
    assert.ok(!text.includes('550e8400'));
    assert.ok(!text.includes('10834758'));
    assert.deepEqual(residualPii(text), []);
  });

  it('is REVERSIBLE — the user sees the real value the model never saw', () => {
    const src = 'Contact jane.doe@acme.co about it.';
    const { back } = roundTrip(src);
    assert.equal(back, src);
  });

  it('the same value gets the SAME pseudonym, so the model can still reason "one person"', () => {
    const { text } = redact('jane@x.co wrote; reply to jane@x.co');
    const hits = text.match(PSEUDONYM_RE);
    assert.equal(hits.length, 2);
    assert.equal(hits[0], hits[1]);
  });

  it('distinct values get distinct pseudonyms', () => {
    const { text } = redact('jane@x.co and bob@y.co');
    const [a, b] = text.match(PSEUDONYM_RE);
    assert.notEqual(a, b);
  });

  it('a shared map keeps pseudonyms stable across separate strings in one payload', () => {
    const map = newRedactionMap();
    const a = redact('from jane@x.co', { map });
    const b = redact('reply to jane@x.co', { map });
    assert.equal(a.text.match(PSEUDONYM_RE)[0], b.text.match(PSEUDONYM_RE)[0]);
  });
});

describe('redact — the anti-false-positive fixes inherited from Logger', () => {
  it('a capability leg-ref is NOT eaten as an email', () => {
    // Logger carries this fix because artifact ids were being scrubbed; a second, subtly different pattern set
    // would have re-introduced the bug here.
    const src = 'ran me.zendesk.get_ticket@deako.zendesk.com';
    const { text, back } = roundTrip(src);
    assert.ok(text.includes('me.zendesk.get_ticket@deako.zendesk.com'), 'leg-ref must survive redaction');
    assert.equal(back, src);
  });

  it('the leg-ref mask is fully unwound — no sentinel leaks into the payload', () => {
    const { text } = redact('me.zendesk.get_ticket@deako.zendesk.com and jane@x.co');
    assert.ok(!text.includes(''), 'the internal mask must never reach the model');
  });

  it('a short id is not mistaken for a phone number', () => {
    const { text } = redact('ticket 1234 and order 567');
    assert.ok(text.includes('1234') && text.includes('567'));
  });
});

describe('redact — the name-set (§5 open question: names cannot be pattern-detected)', () => {
  it('redacts supplied names, case-insensitively, on word boundaries', () => {
    const { text, back } = roundTrip('Jane Doe called about her switch', { names: ['Jane Doe'] });
    assert.ok(!text.includes('Jane Doe'));
    assert.match(text, /⟦person_1⟧/);
    assert.equal(back, 'Jane Doe called about her switch');
  });

  it('LONGEST-FIRST: "Jane Doe" is consumed whole, not split by a bare "Jane"', () => {
    const { text } = redact('Jane Doe and Jane Smith', { names: ['Jane', 'Jane Doe'] });
    assert.ok(!text.includes('Jane Doe'), 'the full name must win over the bare first name');
  });

  it('does not redact a name fragment inside a longer word', () => {
    const { text } = redact('the janeway protocol', { names: ['Jane'] });
    assert.ok(text.includes('janeway'));
  });

  it('WITHOUT a name-set, names are NOT redacted — the doc says so rather than implying coverage', () => {
    const { text } = redact('Jane Doe called');
    assert.ok(text.includes('Jane Doe'), 'a regex cannot detect names; pretending otherwise would be the lie');
  });
});

describe('redactDeep — the whole payload, system prompt included', () => {
  it('walks nested objects and arrays', () => {
    const body = {
      system: 'You are helping. <RECORD>jane@x.co</RECORD>',
      messages: [{ role: 'user', content: 'find bob@y.co' }],
      max_tokens: 1024,
    };
    const { value, redacted } = redactDeep(body);
    assert.equal(redacted, 2);
    assert.ok(!JSON.stringify(value).includes('jane@x.co'));
    assert.ok(!JSON.stringify(value).includes('bob@y.co'));
    assert.equal(value.max_tokens, 1024, 'non-strings pass through untouched');
  });

  it('THE SYSTEM PROMPT IS THE MAIN EVENT, not an edge case', () => {
    // buildAnswerMessages puts the caller's `seed` in the SYSTEM slot, and <RECORD>/<FINDINGS>/<CASE_RECORD> are
    // baked into that seed before any builder runs. A hook walking only the user message would miss the two
    // highest-sensitivity channels in the egress map while looking like it worked.
    const body = { system: '<FINDINGS>homeowner jane@x.co</FINDINGS>', messages: [{ role: 'user', content: 'summarize' }] };
    const { value } = redactDeep(body);
    assert.ok(!value.system.includes('jane@x.co'));
  });

  it('skipKeys leaves structural fields alone', () => {
    const { value } = redactDeep({ model: 'claude-opus-4-8', system: 'x jane@x.co' }, { skipKeys: ['model'] });
    assert.equal(value.model, 'claude-opus-4-8');
    assert.ok(!value.system.includes('jane@x.co'));
  });

  it('one shared map across the payload, so a value is the same person everywhere', () => {
    const { value } = redactDeep({ system: 'jane@x.co', messages: [{ content: 'jane@x.co' }] });
    assert.equal(value.system, value.messages[0].content);
  });
});

describe('restore — the JSON hazard (the expensive failure)', () => {
  it('a plain value is inserted RAW — byte-identical to a naive restore', () => {
    const map = newRedactionMap();
    const { text } = redact('jane@x.co', { map });
    assert.equal(restore(`answer: ${text}`, map).text, 'answer: jane@x.co');
  });

  it('a value containing a QUOTE is escaped when it lands inside a JSON string literal', () => {
    const map = newRedactionMap();
    const r = redact('Jane "Jack" Doe called', { names: ['Jane "Jack" Doe'], map });
    const pseudo = r.text.match(PSEUDONYM_RE)[0];
    const reply = `{"answer":"spoke to ${pseudo} today"}`;
    const out = restore(reply, map).text;
    assert.doesNotThrow(() => JSON.parse(out), 'an unescaped quote here would lose the ENTIRE response');
    assert.equal(JSON.parse(out).answer, 'spoke to Jane "Jack" Doe today');
  });

  it('a value containing a BACKSLASH is escaped inside JSON too', () => {
    const map = newRedactionMap();
    const r = redact('DOMAIN\\jdoe logged in', { names: ['DOMAIN\\jdoe'], map });
    const pseudo = r.text.match(PSEUDONYM_RE)[0];
    const out = restore(`{"user":"${pseudo}"}`, map).text;
    assert.doesNotThrow(() => JSON.parse(out));
    assert.equal(JSON.parse(out).user, 'DOMAIN\\jdoe');
  });

  it('the SAME quote-bearing value is NOT escaped in prose, where escaping would be user-visible', () => {
    const map = newRedactionMap();
    const r = redact('Jane "Jack" Doe', { names: ['Jane "Jack" Doe'], map });
    const pseudo = r.text.match(PSEUDONYM_RE)[0];
    assert.equal(restore(`I spoke to ${pseudo}.`, map).text, 'I spoke to Jane "Jack" Doe.');
  });

  it('a structured reply carrying a redacted PARAM round-trips, so the leg searches the REAL value', () => {
    // interpret returns {"params":{"query":"⟦email_1⟧"}}; without restore the connector would search for the
    // literal pseudonym and return nothing, which is a silent wrong answer rather than an error.
    const map = newRedactionMap();
    const { text } = redact('search tickets for jane@x.co', { map });
    const pseudo = text.match(PSEUDONYM_RE)[0];
    const parsed = JSON.parse(restore(`{"intent":"act","params":{"query":"${pseudo}"}}`, map).text);
    assert.equal(parsed.params.query, 'jane@x.co');
  });

  it('an INVENTED pseudonym is counted as unresolved, not silently emitted', () => {
    const map = newRedactionMap();
    redact('jane@x.co', { map });
    const out = restore('contact ⟦person_9⟧ instead', map);
    assert.equal(out.unresolved, 1);
    assert.ok(out.text.includes('⟦person_9⟧'), 'left visible — a placeholder in the UI must not look like an answer');
  });

  it('restore is a no-op on text with no pseudonyms', () => {
    const map = newRedactionMap();
    const out = restore('nothing to do here', map);
    assert.equal(out.text, 'nothing to do here');
    assert.equal(out.restored, 0);
  });
});

describe('redact — degenerate inputs never throw', () => {
  it('handles null/undefined/empty/non-string', () => {
    for (const bad of [null, undefined, '', 0, false]) {
      assert.doesNotThrow(() => redact(bad));
      assert.doesNotThrow(() => restore(bad, newRedactionMap()));
    }
  });

  it('handles a map-less restore', () => {
    assert.equal(restore('⟦email_1⟧', null).text, '⟦email_1⟧');
  });

  it('residualPii reports classes that survived, and ignores leg-refs', () => {
    assert.deepEqual(residualPii('all clean here'), []);
    assert.deepEqual(residualPii('me.zendesk.get@deako.zendesk.com'), [], 'a leg-ref is not residual PII');
    assert.ok(residualPii('jane@x.co').includes('email'));
  });

  it('every declared class has a pattern (the list and the table cannot drift)', () => {
    for (const cls of REDACTION_CLASSES) {
      assert.ok(residualPii('x', { classes: [cls] }).length === 0);
      assert.doesNotThrow(() => redact('probe 1234567890', { classes: [cls] }));
    }
  });
});
