// Core/goalRetrieval.test.js — AL-4: the assemble/retrieval policy (the load-bearing step).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assembleGoalContext, renderGoalContext, goalContextFor } from './goalRetrieval.js';

// stored-item shape (AL-2): a normalized item + id (+ optional evidence). Helpers:
const belief = (body, over = {}) => ({ id: `b-${body}`, kind: 'belief', tier: 'confirmed', confidence: 0.7, body, ref: null, ...over });
const delta = (body, over = {}) => ({ id: `d-${body}`, kind: 'delta', tier: 'confirmed', confidence: 0.85, body, trigger: null, ...over });

describe('goalRetrieval — assembleGoalContext: RULES', () => {
  it('always-on rules (no trigger) are ALWAYS included, regardless of ask', () => {
    const { rules } = assembleGoalContext([delta('keep replies terse')], { ask: 'anything at all' });
    assert.equal(rules.length, 1);
  });
  it('triggered rules apply only when the trigger overlaps the ask', () => {
    const items = [delta('check payment first', { trigger: 'a refund ticket' })];
    assert.equal(assembleGoalContext(items, { ask: 'draft a reply to this refund' }).rules.length, 1);   // "refund" overlaps
    assert.equal(assembleGoalContext(items, { ask: 'summarize my unread' }).rules.length, 0);             // no overlap
  });
  it('ranks higher-tier rules first and caps the count', () => {
    const items = [delta('r1', { tier: 'observation' }), delta('r2', { tier: 'canonical' })];
    assert.equal(assembleGoalContext(items, { ask: 'x' }).rules[0].body, 'r2');
    assert.equal(assembleGoalContext(items, { ask: 'x', maxRules: 1 }).rules.length, 1);
  });
  // v2.74.2090 (critical-review fix #10) — the PRESET-BASELINE FLOOR: an app's shipped safety/behavior rules seed at
  // confirmed/0.8 while user rules land at 0.85, so a mature desk could silently truncate the baseline away.
  it('preset-baseline rules survive the cap even when out-ranked by learned rules', () => {
    const items = [
      delta('user rule A', { confidence: 0.85 }),
      delta('user rule B', { confidence: 0.85 }),
      delta('SHIPPED SAFETY RULE', { confidence: 0.8, provenance: 'preset-baseline' }),
    ];
    const { rules } = assembleGoalContext(items, { ask: 'x', maxRules: 2 });
    assert.equal(rules.length, 2);
    assert.ok(rules.some((r) => r.body === 'SHIPPED SAFETY RULE'), 'the baseline rule must not be evicted');
    assert.equal(rules[0].body, 'SHIPPED SAFETY RULE', 'baseline rules are taken first');
  });
  it('baseline pinning does not grow the budget (same cap overall)', () => {
    const items = [
      delta('b1', { provenance: 'preset-baseline' }), delta('b2', { provenance: 'preset-baseline' }),
      delta('u1'), delta('u2'),
    ];
    assert.equal(assembleGoalContext(items, { ask: 'x', maxRules: 3 }).rules.length, 3);
  });
});

describe('goalRetrieval — AL-3e conflict resolution (an act-fail lesson vs a positive association, v2.74.1328)', () => {
  const ASK = 'draft a brief, apologetic reply to James about the outage';
  const fail = (over = {}) => delta('a saved capability was tried for this and didn\'t work — re-teach or pick a different approach',
    { trigger: 'draft a brief apologetic reply to James', ref: 'COMPOSE', provenance: 'act-fail', confidence: 0.4, tier: 'hypothesis', ...over });
  const ok = (over = {}) => belief('draft a brief apologetic reply to James about the outage', { ref: 'COMPOSE', provenance: 'act-ok', confidence: 0.7, ...over });
  it('a stronger ask-relevant positive for the SAME ref RETIRES the act-fail rule (the .1327 wedge)', () => {
    const { rules, recalled } = assembleGoalContext([fail(), ok()], { ask: ASK });
    assert.equal(rules.length, 0);                              // the "didn't work — re-teach" rule is suppressed
    assert.equal(recalled[0].ref, 'COMPOSE');                   // the positive association still recalls
  });
  it('with NO positive for that ref, the lesson still warns (a genuinely failing tool keeps its flag)', () => {
    assert.equal(assembleGoalContext([fail()], { ask: ASK }).rules.length, 1);
  });
  it('repeated REAL failures out-accrue the positive and surface again (confidence beats the belief)', () => {
    assert.equal(assembleGoalContext([fail({ confidence: 0.8 }), ok()], { ask: ASK }).rules.length, 1);
  });
  it('a positive for a DIFFERENT ref never suppresses; user rules (no act-fail provenance) never touched', () => {
    assert.equal(assembleGoalContext([fail(), ok({ ref: 'cap-other' })], { ask: ASK }).rules.length, 1);
    const userRule = delta('always draft replies warmly', { ref: 'COMPOSE' });   // remember: rule — no provenance
    assert.equal(assembleGoalContext([userRule, ok()], { ask: 'draft replies to James' }).rules.length, 1);
  });
});

describe('goalRetrieval — assembleGoalContext: RECALL (the capability-association)', () => {
  it('recalls a belief whose phrasing overlaps a differently-worded ask', () => {
    const items = [belief('get my open emails', { ref: 'cap-emails' })];
    const { recalled } = assembleGoalContext(items, { ask: 'how many open emails do I have' });   // "open emails" overlaps
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].ref, 'cap-emails');
  });
  it('does NOT recall an unrelated belief', () => {
    const items = [belief('get my open emails', { ref: 'cap-emails' })];
    assert.equal(assembleGoalContext(items, { ask: 'what is the weather' }).recalled.length, 0);
  });
  it('ranks by overlap, then tier/confidence; caps the count', () => {
    const items = [
      belief('open emails inbox', { ref: 'cap-a', tier: 'hypothesis' }),
      belief('open emails unread count', { ref: 'cap-b', tier: 'confirmed' }),
    ];
    const { recalled } = assembleGoalContext(items, { ask: 'open emails count', maxRecall: 1 });
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].ref, 'cap-b');   // higher overlap ("count") + higher tier
  });
  it('summary-tier beliefs are always loaded (the distilled summary, §6)', () => {
    const items = [belief('Acme is the top account', { tier: 'summary' })];
    assert.equal(assembleGoalContext(items, { ask: 'totally unrelated' }).recalled.length, 1);
  });
});

describe('goalRetrieval — recall-by-grid (OM #3a, operation-aware)', () => {
  const OM = { noun: 'ticket', plural: 'tickets', states: ['open', 'closed'], actions: ['reply'], transitions: [{ verb: 'close', to: 'closed' }] };
  it('a close-op ask ranks the close-capability above a view one (op-match boost)', () => {
    const items = [
      belief('show all tickets', { ref: 'cap-view' }),
      belief('close ticket #5', { ref: 'cap-close' }),
    ];
    const { recalled } = assembleGoalContext(items, { ask: 'close the urgent ticket', om: OM, maxRecall: 1 });
    assert.equal(recalled[0].ref, 'cap-close');
  });
  it('a same-operation belief is recalled even with low word overlap; om is additive (no om still works via tokens)', () => {
    const om2 = { noun: 'email', plural: 'emails', states: ['unread'], actions: ['reply'], transitions: [{ verb: 'archive', to: 'archived' }] };
    const items = [belief('archive the promo email', { ref: 'cap-arch' })];
    assert.equal(assembleGoalContext(items, { ask: 'archive the newsletter', om: om2 }).recalled.length, 1);   // grid op (archive) matches
    assert.equal(assembleGoalContext(items, { ask: 'archive the newsletter' }).recalled.length, 1);            // and without om, the shared "archive" token
  });
});

describe('goalRetrieval — renderGoalContext', () => {
  it('renders rules + recall as a labeled block; ref becomes a capability hint', () => {
    const block = renderGoalContext({
      rules: [delta('keep it terse'), delta('verify payment', { trigger: 'a refund' })],
      recalled: [belief('open emails', { ref: 'cap-emails' })],
    });
    assert.match(block, /STANDING RULES/);
    assert.match(block, /keep it terse/);
    assert.match(block, /when a refund, verify payment/);
    assert.match(block, /LEARNED here/);
    assert.match(block, /capability "cap-emails"/);
  });
  it('empty context → empty string (so the caller fences only when there is something)', () => {
    assert.equal(renderGoalContext({ rules: [], recalled: [] }), '');
    assert.equal(renderGoalContext(null), '');
  });
});

describe('goalRetrieval — goalContextFor (assemble + render)', () => {
  it('end-to-end: a paraphrase surfaces the learned capability + the standing rule', () => {
    const items = [
      belief('get my open emails', { ref: 'cap-emails' }),
      delta('keep replies under 3 sentences'),
    ];
    const block = goalContextFor(items, 'how many open emails do I have');
    assert.match(block, /cap-emails/);
    assert.match(block, /under 3 sentences/);
  });
  it('no memory → empty string', () => {
    assert.equal(goalContextFor([], 'anything'), '');
  });
});
