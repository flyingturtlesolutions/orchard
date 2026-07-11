// Core/answerPrompt.test.js — IL-2 Orchard's meta/conversational answer prompt (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAnswerMessages } from './answerPrompt.js';

describe('buildAnswerMessages — answer a meta ask, grounded in real page context (pure)', () => {
  it('lists capabilities (deduped), marks established (aliased) ones, names built-in tab/nav abilities, fences', () => {
    const { system, user } = buildAnswerMessages({
      ask: 'what can you do',
      capabilities: [{ name: 'Search for media content', alias: 'search media' }, { name: 'Filter by category' }, { name: 'Search for media content' }],
    });
    assert.match(user, /USER: what can you do/);
    assert.match(user, /- Search for media content {2}\(you've used this\)/);   // #3 — established marker
    assert.match(user, /- Filter by category/);
    assert.equal((user.match(/Filter by category/g) || []).length, 1);          // deduped
    assert.match(user, /CAPABILITIES note="data only/);
    assert.match(system, /navigate|tabs/i);                                     // built-ins named
  });

  it('#1 — surfaces the live page affordances + URL', () => {
    const { user } = buildAnswerMessages({ ask: 'what can you do', affordances: ['Illustrations', 'Vectors', 'Search box'], url: 'https://pixabay.com/' });
    assert.match(user, /CURRENT PAGE: https:\/\/pixabay\.com\//);
    assert.match(user, /ON_THE_PAGE_NOW note="data only/);
    assert.match(user, /- Illustrations/);
  });

  it('AS-4 — lists the connected sites (its reach) + the SYSTEM names them', () => {
    const { system, user } = buildAnswerMessages({
      ask: 'get my open emails',
      connections: [{ origin: 'https://deako.zendesk.com', label: 'deako.zendesk.com' }, { origin: 'https://deako.com', label: 'deako.com' }],
    });
    assert.match(user, /<CONNECTED_SITES/);
    assert.match(user, /deako\.zendesk\.com/);
    assert.match(user, /deako\.com/);
    assert.match(system, /CONNECTED_SITES/);          // the "your reach" rule in BASE
    assert.match(system, /not connected/i);
  });

  it('#5 — surfaces the authoring coverage (taught vs gaps)', () => {
    const { user } = buildAnswerMessages({ ask: 'how can you do better', coverage: { authoredCount: 3, total: 10, coveragePct: 30 } });
    assert.match(user, /COVERAGE: 3\/10 .* \(30% taught\)/);
  });

  it('CV-4-reduce — lists THIS app\'s own sub-tasks + their results, with the BASE rule to reason FROM them', () => {
    const { system, user } = buildAnswerMessages({
      ask: 'how many of my sub-tasks are billing?',
      subTasks: [{ title: '#64775 Switches', status: 'done', summary: 'Billing dispute — refund issued.' }, { title: '#64776 Crash', status: 'needs-you' }],
    });
    assert.match(user, /<SUB_TASKS/);
    assert.match(user, /#64775 Switches \[done\] — Billing dispute/);
    assert.match(user, /#64776 Crash \[needs-you\]/);
    assert.match(system, /SUB_TASKS/);                                   // the reason-from-your-children rule lives in BASE
    assert.doesNotMatch(buildAnswerMessages({ ask: 'x' }).user, /<SUB_TASKS/);   // none → block omitted
  });

  it('empty context → graceful placeholders', () => {
    const { user } = buildAnswerMessages({ ask: 'help' });
    assert.match(user, /none saved on this page yet/);
    assert.match(user, /not captured/);
  });
});

describe('buildAnswerMessages — CV-2 seed persona preamble', () => {
  it('no seed → SYSTEM is the base assistant identity, unchanged', () => {
    assert.ok(buildAnswerMessages({ ask: 'what can you do' }).system.startsWith('You are an intelligent browser-automation assistant'));
  });
  it('seed → the persona is the DOMINANT role; the generic browser-tool identity is NOT the frame (.1182 fix)', () => {
    const seed = 'You are a pirate; always mention parrots.';
    const { system } = buildAnswerMessages({ ask: 'what can you do', seed });
    assert.ok(system.startsWith(seed));                                       // persona leads AND is the identity
    assert.match(system, /WHO YOU ARE|secondary to your role/);               // role dominates; capabilities are the means
    assert.match(system, /navigate|tabs/i);                                   // BASE operating rules retained
    assert.doesNotMatch(system, /You are an intelligent browser-automation assistant/);  // the overriding generic identity is gone
  });
  it('ignores an empty / whitespace-only seed', () => {
    const base = buildAnswerMessages({ ask: 'x' }).system;
    assert.equal(buildAnswerMessages({ ask: 'x', seed: '   ' }).system, base);
  });
});

describe('buildAnswerMessages — AL-4 learned context (standing rules apply to prose)', () => {
  it('a learned block adds <LEARNED> to the user + a follow-the-rules line to SYSTEM; absent when empty', () => {
    const learned = 'STANDING RULES — follow these:\n- keep replies under 3 sentences';
    const { system, user } = buildAnswerMessages({ ask: 'summarize my unread', learned });
    assert.match(user, /<LEARNED/);
    assert.match(user, /under 3 sentences/);
    assert.match(system, /STANDING RULES/);
    assert.doesNotMatch(buildAnswerMessages({ ask: 'x' }).user, /<LEARNED/);
  });
});

describe('buildAnswerMessages — OM object model', () => {
  it('an objects block adds <OBJECTS> to the user; absent when empty', () => {
    const { user } = buildAnswerMessages({ ask: 'what can you do', objects: 'Objects: emails (each one a "email").' });
    assert.match(user, /<OBJECTS/);
    assert.match(user, /Objects: emails/);
    assert.doesNotMatch(buildAnswerMessages({ ask: 'x' }).user, /<OBJECTS/);
  });
});

describe('buildAnswerMessages — RIDE class (session API actions)', () => {
  it('lists armable curated rides so "what can you do" covers connected API legs', () => {
    const { user } = buildAnswerMessages({
      ask: 'what can you do on aircall workspace',
      connections: [{ origin: 'https://workspace.aircall.io', label: 'Aircall Workspace' }],
      ride: [
        { id: 'aw_team_availability', name: 'Team availability (all agents)', does: 'list EVERY teammate live availability', reviewState: 'accepted', enabled: true },
        { id: 'aw_contact_by_phone', name: 'Find contact by phone', does: 'look up a contact by phone number', reviewState: 'accepted', enabled: true },
      ],
    });
    assert.match(user, /<RIDE/);
    assert.match(user, /Team availability \(all agents\)/);
    assert.match(user, /Find contact by phone/);
  });
});
