// Core/goalMemory.test.js — AL-1 (v2.74.1187): the apps-layer goal memory (beliefs + deltas + the tier ratchet).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ITEM_KINDS, EPISTEMIC, TIERS, tierRank, nextTier,
  normalizeBelief, normalizeDelta, normalizeMemoryItem, isBelief, isDelta,
  canPromote, promote, standingRuleFromText, capabilityOutcomeItem, looksLikeStandingRule, retireActFailDeltas,
} from './goalMemory.js';

describe('goalMemory — enums + tier helpers', () => {
  it('enums are frozen; TIERS is the low→high ratchet order', () => {
    assert.ok(Object.isFrozen(ITEM_KINDS) && Object.isFrozen(EPISTEMIC) && Object.isFrozen(TIERS));
    assert.deepEqual(TIERS, ['observation', 'hypothesis', 'confirmed', 'canonical', 'summary']);
  });
  it('tierRank is the index; unknown → -1', () => {
    assert.equal(tierRank('observation'), 0);
    assert.equal(tierRank('canonical'), 3);
    assert.equal(tierRank('bogus'), -1);
  });
  it('nextTier steps up; top + unknown → null', () => {
    assert.equal(nextTier('observation'), 'hypothesis');
    assert.equal(nextTier('canonical'), 'summary');
    assert.equal(nextTier('summary'), null);
    assert.equal(nextTier('bogus'), null);
  });
});

describe('goalMemory — normalizeBelief', () => {
  it('requires a body; defaults epistemic→inferred, confidence→0.5, tier→observation', () => {
    assert.equal(normalizeBelief({}), null);
    assert.equal(normalizeBelief({ body: '   ' }), null);
    const b = normalizeBelief({ body: 'Acme is enterprise' });
    assert.equal(b.kind, 'belief');
    assert.equal(b.epistemic, 'inferred');      // unmarked → the weaker claim (fail-safe)
    assert.equal(b.confidence, 0.5);
    assert.equal(b.tier, 'observation');
    assert.equal(b.id, null);
  });
  it('carries observed/inferred, clamps confidence, passes id + provenance', () => {
    const b = normalizeBelief({ id: 'b1', body: 'Acme is enterprise', epistemic: 'observed', confidence: 1.7, provenance: 'ticket #6122', tier: 'confirmed' });
    assert.equal(b.epistemic, 'observed');
    assert.equal(b.confidence, 1);              // clamped to [0,1]
    assert.equal(b.provenance, 'ticket #6122');
    assert.equal(b.tier, 'confirmed');
    assert.equal(b.id, 'b1');
  });
  it('a bad epistemic / tier falls back to the safe defaults', () => {
    const b = normalizeBelief({ body: 'x', epistemic: 'guessed', tier: 'gospel' });
    assert.equal(b.epistemic, 'inferred');
    assert.equal(b.tier, 'observation');
  });
  it('AL-3b — carries an optional ref (what the belief is ABOUT, e.g. a capabilityId); defaults null', () => {
    assert.equal(normalizeBelief({ body: 'x' }).ref, null);
    assert.equal(normalizeBelief({ body: 'get my open emails', ref: 'cap-x' }).ref, 'cap-x');
    assert.equal(normalizeDelta({ body: 'do y', ref: 'cap-z' }).ref, 'cap-z');
  });
});

describe('goalMemory — normalizeDelta', () => {
  it('requires a body (the action rule); trigger is optional', () => {
    assert.equal(normalizeDelta({ trigger: 'refunds' }), null);   // no body → no rule
    const d = normalizeDelta({ body: 'verify payment status before drafting', trigger: 'refund tickets', provenance: 'user rewrote draft #88' });
    assert.equal(d.kind, 'delta');
    assert.equal(d.trigger, 'refund tickets');
    assert.equal(d.body, 'verify payment status before drafting');
    assert.equal(d.provenance, 'user rewrote draft #88');
  });
  it('an always-on lesson has a null trigger', () => {
    assert.equal(normalizeDelta({ body: 'always cite the source' }).trigger, null);
  });
});

describe('goalMemory — normalizeMemoryItem + classifiers', () => {
  it('dispatches by kind; untyped / unknown-kind is not admitted', () => {
    assert.ok(isBelief(normalizeMemoryItem({ kind: 'belief', body: 'x' })));
    assert.ok(isDelta(normalizeMemoryItem({ kind: 'delta', body: 'y' })));
    assert.equal(normalizeMemoryItem({ body: 'no kind' }), null);
    assert.equal(normalizeMemoryItem({ kind: 'rumor', body: 'z' }), null);
    assert.equal(normalizeMemoryItem(null), null);
  });
});

describe('goalMemory — standingRuleFromText (AL-3c — non-tool: authored rules → deltas)', () => {
  it('a plain rule → an always-on delta (trigger null), confirmed + user-authored', () => {
    const d = standingRuleFromText('keep replies under 3 sentences');
    assert.equal(d.kind, 'delta');
    assert.equal(d.trigger, null);
    assert.equal(d.body, 'keep replies under 3 sentences');
    assert.equal(d.tier, 'confirmed');
    assert.equal(d.provenance, 'user-rule');
    assert.equal(d.ref, null);                       // a rule isn't tool-bound
  });
  it('"if X, Y" and "if X then Y" split into trigger + body', () => {
    const a = standingRuleFromText('if a ticket is a refund, check payment status first');
    assert.equal(a.trigger, 'a ticket is a refund');
    assert.equal(a.body, 'check payment status first');
    const b = standingRuleFromText('if overdue then escalate');
    assert.equal(b.trigger, 'overdue');
    assert.equal(b.body, 'escalate');
  });
  it('a no-delimiter "if" sentence is NOT mis-split — becomes an always-on rule', () => {
    const d = standingRuleFromText('if uncertain ask the user');
    assert.equal(d.trigger, null);
    assert.equal(d.body, 'if uncertain ask the user');
  });
  it('§12.3 — "when I say X, I mean/run Y" → a PHRASE-scoped rule (trigger=X, body=Y)', () => {
    const a = standingRuleFromText('when I say "get tickets", I mean get my open tickets, open each and summarize');
    assert.equal(a.trigger, 'get tickets');
    assert.equal(a.body, 'get my open tickets, open each and summarize');
    const b = standingRuleFromText('when I say standup run open jira and list my issues');
    assert.equal(b.trigger, 'standup');
    assert.equal(b.body, 'open jira and list my issues');
  });
  it('empty → null', () => {
    assert.equal(standingRuleFromText('   '), null);
    assert.equal(standingRuleFromText(null), null);
  });
});

describe('goalMemory — looksLikeStandingRule (§12.2 — prefix-less rule capture)', () => {
  it('fires on a behavioral preference (the caller also gates on intent:answer)', () => {
    assert.equal(looksLikeStandingRule('keep replies terse'), true);
    assert.equal(looksLikeStandingRule('always confirm before closing a ticket'), true);
    assert.equal(looksLikeStandingRule("don't use jargon"), true);
    assert.equal(looksLikeStandingRule('from now on sign off as Sam'), true);
    assert.equal(looksLikeStandingRule('when I say standup, open jira'), true);
  });
  it('does NOT fire on a question or a plain action ask', () => {
    assert.equal(looksLikeStandingRule('what can you do'), false);
    assert.equal(looksLikeStandingRule('get my open tickets'), false);
    assert.equal(looksLikeStandingRule('when is the next meeting'), false);   // "when is" ≠ "when I say"
    assert.equal(looksLikeStandingRule(''), false);
  });
});

describe('goalMemory — the promotion gate (the ratchet)', () => {
  const at = (tier, conf = 0.5) => ({ kind: 'belief', body: 'claim', tier, confidence: conf });

  it('observation → hypothesis is cheap (confidence ≥ 0.3)', () => {
    assert.equal(canPromote(at('observation', 0.3)), true);
    assert.equal(canPromote(at('observation', 0.2)), false);
  });
  it('hypothesis → confirmed needs corroboration: confidence ≥ 0.7 AND ≥2 evidence', () => {
    assert.equal(canPromote(at('hypothesis', 0.9), { evidenceCount: 2 }), true);
    assert.equal(canPromote(at('hypothesis', 0.9), { evidenceCount: 1 }), false);   // one sighting isn't corroboration
    assert.equal(canPromote(at('hypothesis', 0.6), { evidenceCount: 5 }), false);   // confidence floor not met
  });
  it('confirmed → canonical is HITL: a human must confirm; confidence alone never canonizes (§7)', () => {
    assert.equal(canPromote(at('confirmed', 1.0), { evidenceCount: 99 }), false);   // no human → blocked
    assert.equal(canPromote(at('confirmed', 0.4), { confirmedByHuman: true }), true);
  });
  it('canonical → summary is consolidation-only (the slow path)', () => {
    assert.equal(canPromote(at('canonical', 1.0), { confirmedByHuman: true }), false);
    assert.equal(canPromote(at('canonical', 1.0), { consolidating: true }), true);
  });
  it('summary is the top — nothing promotes past it', () => {
    assert.equal(canPromote(at('summary', 1.0), { consolidating: true }), false);
  });
  it('confidence falls back to the item’s own when not supplied', () => {
    assert.equal(canPromote(at('observation', 0.5)), true);        // 0.5 ≥ 0.3, no signal needed
    assert.equal(canPromote(at('observation', 0.1)), false);
  });
  it('garbage item never promotes', () => {
    assert.equal(canPromote({ body: 'no kind' }, { confirmedByHuman: true }), false);
  });
});

describe('goalMemory — promote (copy-on-write)', () => {
  it('advances one tier and raises confidence to the max, leaving the original untouched', () => {
    const h = normalizeBelief({ body: 'Acme is churning', tier: 'hypothesis', confidence: 0.7 });
    const c = promote(h, { confidence: 0.9, evidenceCount: 3 });
    assert.equal(c.tier, 'confirmed');
    assert.equal(c.confidence, 0.9);
    assert.equal(h.tier, 'hypothesis');         // original unchanged
    assert.equal(h.confidence, 0.7);
  });
  it('returns the SAME-valued item (unchanged tier) when the gate does not clear', () => {
    const h = normalizeBelief({ body: 'x', tier: 'hypothesis', confidence: 0.9 });
    assert.equal(promote(h, { evidenceCount: 1 }).tier, 'hypothesis');   // one sighting → no promotion
  });
  it('HITL canonization keeps confidence when the human signal carries none', () => {
    const c = promote(normalizeBelief({ body: 'x', tier: 'confirmed', confidence: 0.8 }), { confirmedByHuman: true });
    assert.equal(c.tier, 'canonical');
    assert.equal(c.confidence, 0.8);            // max(0.8, fallback 0.8)
  });
  it('garbage → null', () => {
    assert.equal(promote({ body: 'no kind' }, { confirmedByHuman: true }), null);
  });
});

describe('goalMemory — capabilityOutcomeItem (AL-3e, the outcome hook)', () => {
  it('SUCCESS → an OBSERVED belief (0.7) keyed by ask→capability (so a 2nd success ratchets it)', () => {
    const it = capabilityOutcomeItem('show my open tickets', 'cap-123', true);
    assert.equal(it.kind, 'belief');
    assert.equal(it.epistemic, 'observed');
    assert.equal(it.confidence, 0.7);
    assert.equal(it.ref, 'cap-123');
    assert.equal(it.body, 'show my open tickets');
    assert.equal(it.provenance, 'act-ok');
  });
  it('FAILURE → a low-confidence mismatch DELTA (distinct kind → never corroborates the positive belief)', () => {
    const it = capabilityOutcomeItem('show my open tickets', 'cap-123', false);
    assert.equal(it.kind, 'delta');
    assert.equal(it.confidence, 0.4);
    assert.equal(it.trigger, 'show my open tickets');
    assert.equal(it.ref, 'cap-123');
    assert.equal(it.provenance, 'act-fail');
  });
  it('missing goal or capabilityId → null (no-op)', () => {
    assert.equal(capabilityOutcomeItem('', 'cap-1', true), null);
    assert.equal(capabilityOutcomeItem('x', '', true), null);
  });
});

describe('goalMemory — retireActFailDeltas (v2.74.1523, the re-teach consumes the "re-teach" lesson)', () => {
  const ASK = 'show ticket 4867009 on vendorsuite';
  const failFor = (goal, over = {}) => ({ ...capabilityOutcomeItem(goal, 'cap-old-drive', false), id: 'd1', ...over });
  it('removes the act-fail delta whose trigger matches the re-taught ask (case/whitespace-insensitive)', () => {
    const items = [failFor(ASK), capabilityOutcomeItem(ASK, 'cap-new', true)];
    const { items: next, removed } = retireActFailDeltas(items, '  Show  Ticket 4867009 ON vendorsuite ');
    assert.equal(removed, 1);
    assert.equal(next.length, 1);
    assert.equal(next[0].kind, 'belief');                       // the positive association survives
  });
  it('a DIFFERENT phrasing\'s lesson stays (only the re-taught ask is consumed)', () => {
    const other = failFor('open warranty task details for Raleigh');
    const { items: next, removed } = retireActFailDeltas([failFor(ASK), other], ASK);
    assert.equal(removed, 1);
    assert.deepEqual(next.map((x) => x.trigger), ['open warranty task details for Raleigh']);
  });
  it('matches the producer\'s 120-char trigger truncation on a long ask', () => {
    const LONG = `please ${'x'.repeat(130)} on vendorsuite`;
    const { removed } = retireActFailDeltas([failFor(LONG)], LONG);   // trigger was sliced to 120 at mint
    assert.equal(removed, 1);
  });
  it('never touches beliefs, user rules (no act-fail provenance), or unrelated deltas; garbage-safe', () => {
    const userRule = { kind: 'delta', trigger: ASK, body: 'always confirm first', provenance: 'user-rule', id: 'r1' };
    const { items: next, removed } = retireActFailDeltas([userRule, capabilityOutcomeItem(ASK, 'cap-new', true)], ASK);
    assert.equal(removed, 0);
    assert.equal(next.length, 2);
    assert.deepEqual(retireActFailDeltas(null, ASK), { items: [], removed: 0 });
    assert.deepEqual(retireActFailDeltas([failFor(ASK)], '').removed, 0);
  });
});
