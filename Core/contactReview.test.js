// Core/contactReview.test.js — v2.74.2124. The review card: one shape, three tails.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewCard, renderReviewCard, justificationLines, contactLines, controlsFor } from './contactReview.js';
import { readContacts } from './contactRoles.js';

const PEOPLE = readContacts({ __contacts: [
  { FullName: 'Dana Reyes', IsPrimary: true, IsBuyer: true, IsDrHorton: false, Email: 'dana@example.com', CellPhone: '336-555-0142', ContactMethod: 'Any' },
  { FullName: 'Marcus Reyes', IsDrHorton: false, CellPhone: '336-555-0188', ContactMethod: '-1' },
  { FullName: 'Priya Shah', IsDrHorton: true, AssignmentType: 'CSR', WorkPhone: '336-555-0100' },
] });

describe('contactReview — the justification names its RULE and quotes its evidence', () => {
  it('translates the count ROUTE into the rule a person can check', () => {
    const lines = justificationLines({ arm: 'replacement needed', count: 5, product: 'Simple Rocker Switch', fields: { count_route: 'RANGE_UPPER', product: 'SIMPLE_ROCKER' } });
    assert.match(lines.join('\n'), /Read as 5 × Simple Rocker Switch/);
    assert.match(lines.join('\n'), /count — a range — upper bound taken/);
  });
  it('names the unmatched product verbatim rather than paraphrasing it', () => {
    const lines = justificationLines({ cause: 'named-product-unresolved', fields: { product: 'NAMED_OTHER', product_name: 'Gen 2 smart switch' } });
    assert.match(lines.join('\n'), /the note names "Gen 2 smart switch"/);
  });
  it('states the cause that put it in front of a person', () => {
    assert.match(justificationLines({ cause: 'no-count', fields: { count_route: 'NONE' } }).join('\n'), /needs a person — no-count/);
  });
  it('an empty outcome derives nothing rather than inventing a reason', () => {
    assert.deepEqual(justificationLines({}), []);
    assert.deepEqual(justificationLines(null), []);
  });
});

describe('contactReview — the homeowner block', () => {
  it('lists BOTH homeowners with every phone label, and never the builder staff', () => {
    const rows = contactLines(PEOPLE);
    assert.deepEqual(rows.map((r) => r.name), ['Dana Reyes', 'Marcus Reyes']);
    assert.match(rows[0].detail, /336-555-0142 \(cell\)/);
    assert.match(rows[0].detail, /prefers: Any/);
    assert.ok(!rows.some((r) => /Priya/.test(r.name)), 'the CSR is not a homeowner');
  });
  it('an unset preference prints nothing rather than "prefers: -1"', () => {
    assert.doesNotMatch(contactLines(PEOPLE)[1].detail, /prefers/);
  });
});

describe('contactReview — one primary control per channel, and the button names the act', () => {
  it('email leads with the RECIPIENT, not the word "approve"', () => {
    const b = controlsFor('email', { email: 'dana@example.com' });
    assert.equal(b[0].id, 'send');
    assert.equal(b[0].label, 'Send to dana@example.com');
    assert.equal(b[0].danger, true, 'it leaves our boundary — it is the dangerous one');
  });
  it('call leads with the NUMBER to ring (MVP: acknowledged by the caller)', () => {
    const b = controlsFor('call', { phone: '336-555-0142' });
    assert.equal(b[0].id, 'called');
    assert.match(b[0].label, /336-555-0142/);
  });
  it('unresolved leads with closing it, since nothing is owed to the homeowner', () => {
    assert.equal(controlsFor('unresolved')[0].id, 'close');
  });

  // v2.74.2149 (DESIGN_audit.md §12.8.2) — the `reference` kind: decides nothing, so it is always safe to click.
  describe('Show task — the reference control', () => {
    it('is offered on EVERY channel (ambiguous instructions resolve to `unresolved`, where it matters most)', () => {
      for (const ch of ['email', 'call', 'unresolved']) {
        const b = controlsFor(ch, { email: 'd@e.com', phone: '336-555-0142' });
        const st = b.find((x) => x.id === 'show-task');
        assert.ok(st, `${ch} must offer Show task`);
        assert.equal(st.kind, 'reference');
        assert.equal(st.label, 'Show task');
      }
    });
    it('is NEVER danger — a reference control mutates nothing, so a mis-click costs nothing', () => {
      for (const ch of ['email', 'call', 'unresolved']) {
        assert.notEqual(controlsFor(ch, {}).find((x) => x.id === 'show-task').danger, true);
      }
    });
    it('never precedes the channel PRIMARY — the decision stays the dominant control', () => {
      for (const ch of ['email', 'call', 'unresolved']) {
        const b = controlsFor(ch, {});
        assert.ok(b.findIndex((x) => x.id === 'show-task') > b.findIndex((x) => x.kind === 'primary'), ch);
      }
    });
    it('is the ONLY non-mutating control — every other kind decides or edits', () => {
      const b = controlsFor('email', { email: 'd@e.com' });
      assert.deepEqual(b.filter((x) => x.kind === 'reference').map((x) => x.id), ['show-task']);
      assert.equal(b.filter((x) => x.kind === 'primary').length, 1, 'still exactly one primary');
    });
  });
  it('EVERY channel offers the other two as overrides — the allow-list errs toward caution', () => {
    for (const ch of ['email', 'call', 'unresolved']) {
      const ids = controlsFor(ch).map((b) => b.id);
      assert.equal(ids.filter((i) => i.startsWith('to-')).length, 2, `${ch} must offer both overrides`);
      assert.equal(ids.filter((_, i) => controlsFor(ch)[i].kind === 'primary').length, 1, `${ch} must have exactly ONE primary`);
    }
  });
  it('an unknown channel still renders the safe (unresolved) controls, never an email button', () => {
    assert.equal(controlsFor('mystery')[0].id, 'close');
    assert.ok(!controlsFor('mystery').some((b) => b.id === 'send'));
  });
});

describe('contactReview — the card', () => {
  const card = (channel, why, draft = null) => buildReviewCard({
    label: '#4899327 · 2935 Burgess Drive',
    instructions: 'Homeowner states light switches sticking, please send replacements',
    outcome: { arm: 'contact homeowner', cause: 'no-count', fields: { count_route: 'NONE', product: 'SIMPLE_ROCKER' } },
    people: PEOPLE, decision: { channel, why }, draft,
  });

  it('all three tails share the SAME core sections, in the same order', () => {
    const titles = (ch) => card(ch, 'x').sections.map((s) => s.title);
    assert.deepEqual(titles('email').slice(0, 3), ['WHAT THE TASK SAYS', 'WHAT I READ', 'HOMEOWNERS']);
    assert.deepEqual(titles('call').slice(0, 3), titles('email').slice(0, 3));
    assert.deepEqual(titles('unresolved').slice(0, 3), titles('email').slice(0, 3));
  });
  it('the instructions are quoted VERBATIM and come first — every claim below is a reading of them', () => {
    assert.equal(card('email', 'x').sections[0].title, 'WHAT THE TASK SAYS');
    assert.match(card('email', 'x').sections[0].lines[0], /^"Homeowner states light switches sticking/);
  });
  it('the DECISION section always states its reason — that is what you are agreeing with', () => {
    const d = card('call', 'they asked to be reached by "Phone" — not email').sections.find((s) => s.title === 'DECISION');
    assert.match(d.lines[0], /^CALL — they asked to be reached by "Phone"/);
  });
  it('an unresolved card STILL carries the homeowner block (user ruling 2026-08-08)', () => {
    const s = card('unresolved', 'reads as another trade').sections.find((x) => x.title === 'HOMEOWNERS');
    assert.match(s.lines.join('\n'), /Dana Reyes/);
    assert.match(s.lines.join('\n'), /Marcus Reyes/);
  });
  it('only the EMAIL card carries a draft, even when one is passed in', () => {
    const d = { to: 'dana@example.com', subject: 'S', body: 'B' };
    assert.ok(card('email', 'x', d).draft);
    assert.equal(card('call', 'x', d).draft, null, 'a draft on a call card would invite sending it');
    assert.equal(card('unresolved', 'x', d).draft, null);
  });
  it('renders the draft in a fence, and the controls last', () => {
    const text = renderReviewCard(card('email', 'contact method "Any"', { to: 'dana@example.com', subject: 'About your request', body: 'Hi Dana,' }));
    assert.match(text, /\*\*DRAFT EMAIL\*\* → dana@example\.com/);
    assert.match(text, /Subject: About your request/);
    assert.match(text, /```/);
    assert.match(text.trim().split('\n').pop(), /\[ Send to dana@example\.com \]/);
  });
  it('a missing homeowner says so rather than rendering an empty block', () => {
    const bare = buildReviewCard({ label: '#1', instructions: 'x', outcome: { cause: 'no-count' }, people: [], decision: { channel: 'call', why: 'no email' } });
    assert.match(bare.sections.find((s) => s.title === 'HOMEOWNER').lines[0], /look them up in VendorSuite/);
  });
  it('a null card renders nothing rather than throwing', () => {
    assert.equal(renderReviewCard(null), '');
  });
});
