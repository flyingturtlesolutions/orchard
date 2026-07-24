// Core/workflowWizard.test.js — WW-1 (v2.74.1610): the ＋ Workflow wizard's pure logic.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyStepOutcome, outcomeWantsTeach, outcomeIsTransient, stepProvenance,
  targetSplitSuggestion, intentSplitSuggestion, buildWorkflowSave, wizardProgress,
  pinnedClause, replayPlan, replayLine, isPrePinned, WORKFLOW_SCHEMA, sanitizeBindings,
  stepBarClass, barWantsTeach,
} from './workflowWizard.js';

describe('workflowWizard — classifyStepOutcome (§3: the empirical outcome ladder)', () => {
  it('a completed run is always "completed" — the HUMAN judges it (never a predicted score)', () => {
    assert.equal(classifyStepOutcome({ ok: true }), 'completed');
    assert.equal(classifyStepOutcome({ ok: true, error: 'ignored when ok' }), 'completed');
  });
  it('a decompose verdict → split-suggested (§10.C intent split, qualify-time)', () => {
    assert.equal(classifyStepOutcome({ ok: false, decomposed: true }), 'split-suggested');
  });
  it('auth / rate / network → transient (retry-after-signin, never teach)', () => {
    assert.equal(classifyStepOutcome({ ok: false, error: 'session-expired' }), 'transient');
    assert.equal(classifyStepOutcome({ ok: false, status: 401 }), 'transient');
    assert.equal(classifyStepOutcome({ ok: false, error: 'http-429 rate limited' }), 'transient');
    assert.equal(classifyStepOutcome({ ok: false, error: 'network timeout' }), 'transient');
    assert.ok(outcomeIsTransient('transient') && !outcomeWantsTeach('transient'));
  });
  it('an honest gap → cant-engage (→ "show me"); a named gapKind wins', () => {
    assert.equal(classifyStepOutcome({ ok: false, error: 'no leg for this' }), 'cant-engage');
    assert.equal(classifyStepOutcome({ ok: false, error: 'op-not-captured' }), 'cant-engage');
    assert.equal(classifyStepOutcome({ ok: false, gapKind: 'no-candidate', error: 'anything' }), 'cant-engage');
    assert.ok(outcomeWantsTeach('cant-engage'));
  });
  it('an unclassified failure → hard-fail', () => {
    assert.equal(classifyStepOutcome({ ok: false, error: 'weird internal boom' }), 'hard-fail');
    assert.equal(classifyStepOutcome({}), 'hard-fail');
  });
});

describe('workflowWizard — stepProvenance (body-blind: method for display, never a value)', () => {
  it('extracts {text, via:{kind,host,name}, bankedAt} — kind + a label, NO captured value', () => {
    const ran = { capabilityId: 'cap-9', kind: 'ride', clause: 'get my open tickets', intent: 'list open tickets', groundId: 'g-1' };
    const p = stepProvenance(ran, 'get my open tickets', 'deako.zendesk.com', 500);
    assert.equal(p.text, 'get my open tickets');
    assert.equal(p.via.kind, 'ride');
    assert.equal(p.via.host, 'deako.zendesk.com');
    assert.equal(p.via.name, 'list open tickets');
    assert.equal(p.bankedAt, 500);
    assert.ok(!('value' in p) && !('capabilityId' in p), 'no captured value, no raw id leaks into the syncable record');
  });
  it('degrades: falls back to the step text; missing via → nulls', () => {
    const p = stepProvenance({}, 'do the thing');
    assert.equal(p.text, 'do the thing');
    assert.deepEqual(p.via, { kind: null, host: null, name: null });
  });
});

describe('workflowWizard — split suggestions (§10.C: target at capture, intent at qualify)', () => {
  it('target split fires only on ≥2 distinct systems, deduped/lowercased', () => {
    assert.deepEqual(targetSplitSuggestion(['VendorSuite', 'Shopify']), { split: true, systems: ['vendorsuite', 'shopify'] });
    assert.deepEqual(targetSplitSuggestion(['zendesk', 'Zendesk']), { split: false, systems: ['zendesk'] });
    assert.deepEqual(targetSplitSuggestion([]), { split: false, systems: [] });
  });
  it('intent split adopts the decompose verdict subAsks (≥2)', () => {
    assert.deepEqual(intentSplitSuggestion(['get tickets', 'summarize each']), { split: true, steps: ['get tickets', 'summarize each'] });
    assert.deepEqual(intentSplitSuggestion(['one thing']), { split: false, steps: ['one thing'] });
  });
});

describe('workflowWizard — buildWorkflowSave + wizardProgress (§2.4/§10.E)', () => {
  const STEP = (text, approved, prov) => ({ text, approved, provenance: prov });
  it('ask = the UMBRELLA intent, not the name; subAsks = step texts; all-approved → ready+qualifiedAt', () => {
    const w = { ask: 'reconcile the homeowner record', name: 'Reconcile', steps: [STEP('get vendorsuite tasks', true, { text: 'get vendorsuite tasks', via: { kind: 'ride' } }), STEP('check each in shopify', true)] };
    const save = buildWorkflowSave(w, 999);
    assert.equal(save.ask, 'reconcile the homeowner record', 'recall matches the umbrella intent (§10.E)');
    assert.equal(save.name, 'Reconcile');
    assert.deepEqual(save.subAsks, ['get vendorsuite tasks', 'check each in shopify']);
    assert.equal(save.status, 'ready');
    assert.equal(save.qualifiedAt, 999);
    assert.equal(save.steps[0].via.kind, 'ride', 'provenance rides');
  });
  it('any unproven step → draft (status draft, qualifiedAt 0) — never on the launch page', () => {
    const w = { name: 'Half', steps: [STEP('a', true), STEP('b', false)] };
    const save = buildWorkflowSave(w, 999);
    assert.equal(save.status, 'draft');
    assert.equal(save.qualifiedAt, 0);
    assert.equal(save.ask, 'Half', 'no explicit ask → falls back to name');
  });
  it('<2 steps → null (the store rejects it anyway — fail early)', () => {
    assert.equal(buildWorkflowSave({ steps: [STEP('only one', true)] }), null);
  });
  it('CD-6.6 — a cadence arms a trigger, but ONLY on a ready (all-approved) workflow', () => {
    const ready = buildWorkflowSave({ ask: 'x', steps: [STEP('a', true), STEP('b', true)], cadenceMinutes: 240 }, 1000);
    assert.equal(ready.trigger.kind, 'cadence');
    assert.equal(ready.trigger.minutes, 240);
    assert.equal(ready.trigger.enabled, true);
    assert.equal(ready.trigger.nextDue, 1000 + 240 * 60_000);
    const draft = buildWorkflowSave({ ask: 'x', steps: [STEP('a', true), STEP('b', false)], cadenceMinutes: 240 }, 1000);
    assert.equal('trigger' in draft, false, 'a draft is not schedulable');
    const none = buildWorkflowSave({ ask: 'x', steps: [STEP('a', true), STEP('b', true)] }, 1000);
    assert.equal('trigger' in none, false, 'no cadence picked → no trigger');
  });
  it('wizardProgress: ready needs ≥2 steps all approved; draft when any unproven', () => {
    assert.deepEqual(wizardProgress([STEP('a', true), STEP('b', true)]), { total: 2, approved: 2, unproven: 0, canSaveReady: true, canSaveDraft: false });
    assert.deepEqual(wizardProgress([STEP('a', true), STEP('b', false)]), { total: 2, approved: 1, unproven: 1, canSaveReady: false, canSaveDraft: true });
    assert.equal(wizardProgress([STEP('a', true)]).canSaveReady, false, 'one step is not a workflow');
  });
});

// ── PP-0c (v2.74.1666) — clause pinning: bank the RESOLUTION alongside the phrasing (§8.3 + §10.4) ────────────
describe('workflowWizard — PP-0c: pinnedClause + replayPlan', () => {
  it('stepProvenance now banks the resolution, not only the phrasing', () => {
    const p = stepProvenance({ kind: 'connector', capabilityId: 'me.zendesk.get_ticket', intent: 'Get a ticket' }, 'get ticket 5', '', 100);
    assert.equal(p.clause.kind, 'connector');
    assert.equal(p.clause.capabilityId, 'me.zendesk.get_ticket');
    assert.equal(p.text, 'get ticket 5', 'the phrasing is still authoritative as the label');
  });

  it('v1730 — a connector pin banks its bound params (sanitized); the replay goes LLM-free on them', () => {
    const p = pinnedClause({ kind: 'connector', capabilityId: 'me.vs.tasks', groundId: 'g1', bindings: { status: 'open', divisionId: 'each' } });
    assert.deepEqual(p.bindings, { status: 'open', divisionId: 'each' });
    assert.equal('bindings' in pinnedClause({ kind: 'fieldRead', field: 'x', bindings: { a: 1 } }), false, 'bindings ride connector/ride pins only');
    assert.equal('bindings' in pinnedClause({ kind: 'connector', capabilityId: 'c', bindings: {} }), false, 'empty banks nothing');
  });
  it('v1730 — sanitizeBindings: primitives only, short, capped; junk → undefined', () => {
    assert.deepEqual(sanitizeBindings({ status: 'open', n: 3, on: true }), { status: 'open', n: 3, on: true });
    assert.equal(sanitizeBindings({ blob: 'x'.repeat(200) }), undefined, 'long values dropped');
    assert.equal(sanitizeBindings({ o: { nested: 1 } }), undefined, 'objects dropped');
    assert.equal(sanitizeBindings(null), undefined);
    assert.equal(Object.keys(sanitizeBindings(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v'])))).length, 8, 'capped at 8');
  });
  it('CD-1a phase 2 (v1717) — a fieldRead ranStep banks its resolved field (+ term) on the pin; names only, never values', () => {
    const p = pinnedClause({ kind: 'fieldRead', capabilityId: null, field: 'Instructions', term: 'DEAKO' });
    assert.equal(p.kind, 'fieldRead');
    assert.equal(p.field, 'Instructions');
    assert.equal(p.term, 'DEAKO');
    assert.equal('field' in pinnedClause({ kind: 'connector', capabilityId: 'c1', field: 'x' }), false, 'field rides fieldRead pins only');
    assert.equal('field' in pinnedClause({ kind: 'fieldRead' }), false, 'no resolved field → nothing banked (legacy shape)');
  });
  it('a step that engaged NOTHING pins no clause — absence is legitimate, not a failure', () => {
    assert.equal(pinnedClause(null), null);
    assert.equal(pinnedClause({}), null);
    assert.equal(stepProvenance(null, 'some step').clause, undefined);
  });

  it('pins VALUES never — the body-blind rule (§11) is unchanged', () => {
    const p = stepProvenance({ kind: 'connector', capabilityId: 'c1', bindings: { email: 'jane@x.co' } }, 's');
    assert.equal(JSON.stringify(p).includes('jane@x.co'), false);
  });

  it('buildWorkflowSave stamps the schema, so "banked before the feature" is not inferred from field presence', () => {
    const saved = buildWorkflowSave({ steps: [{ text: 'a', approved: true }, { text: 'b', approved: true }] }, 1);
    assert.equal(saved.schema, WORKFLOW_SCHEMA);
    assert.equal(isPrePinned(saved), false);
    assert.equal(isPrePinned({ subAsks: ['a', 'b'] }), true, 'an unstamped legacy record is pre-pinned');
  });

  it('replay PREFERS the pinned clause and reports how many were loose', () => {
    const wf = {
      subAsks: ['step one', 'step two'],
      steps: [{ text: 'step one', clause: { kind: 'connector', capabilityId: 'c1' } }, { text: 'step two' }],
    };
    const plan = replayPlan(wf, () => true);
    assert.equal(plan.pinned, 1);
    assert.equal(plan.loose, 1);
    assert.equal(plan.runnable, true);
    assert.equal(plan.clauses.length, 2);
    assert.deepEqual(plan.clauses[0].pinned, { kind: 'connector', capabilityId: 'c1' });
    assert.equal(plan.clauses[1].pinned, undefined, 'a text fallback carries no pin');
  });

  it('THE §10.4 CASE: a clause that no longer resolves STOPS the run — it does NOT fall back to text', () => {
    const wf = {
      subAsks: ['step one', 'step two'],
      steps: [{ text: 'step one', clause: { kind: 'connector', capabilityId: 'gone' } }, { text: 'step two' }],
    };
    const plan = replayPlan(wf, (c) => c.capabilityId !== 'gone');
    assert.equal(plan.runnable, false);
    assert.equal(plan.stale.length, 1);
    assert.equal(plan.stale[0].index, 0);
    assert.equal(plan.clauses.some((c) => c.text === 'step one'), false,
      'falling back here would be the fail-open: the workflow keeps running and quietly does something else');
  });

  it('a record with NO clauses at all replays entirely from text and stays runnable', () => {
    const plan = replayPlan({ subAsks: ['a', 'b'], steps: [{ text: 'a' }, { text: 'b' }] }, () => false);
    assert.equal(plan.runnable, true, 'an ABSENT clause is expected for a legacy record — only a broken PIN stops');
    assert.equal(plan.loose, 2);
    assert.equal(plan.pinned, 0);
  });

  it('with no resolver injected, pins are trusted (the caller opted out of drift checking)', () => {
    const wf = { subAsks: ['a'], steps: [{ text: 'a', clause: { kind: 'connector', capabilityId: 'c1' } }] };
    assert.equal(replayPlan(wf).pinned, 1);
  });

  it('degenerate records do not throw', () => {
    for (const bad of [null, undefined, {}, { subAsks: null }, { subAsks: ['a'], steps: null }]) {
      assert.doesNotThrow(() => replayPlan(bad, () => true));
    }
  });

  it('the replay line states pinned / loose / stale and whether it stopped', () => {
    assert.match(replayLine({ pinned: 2, loose: 1, stale: [], runnable: true }), /2 pinned · 1 from text/);
    assert.match(replayLine({ pinned: 0, loose: 0, stale: [{}], runnable: false }), /STALE.*STOPPED/);
  });
});

// v2.74.1688 — the FOUR-way bar contract. Three of these share `engaged:false` and only one is a failure; the
// page previously read "no ranStep" as proof of one and told the user to teach a step that had worked.
describe('workflowWizard — stepBarClass: an empty result is a CLASS, not the absence of one', () => {
  const at = (o) => stepBarClass({ phase: 'ran', ...o });

  it('THE LIVE BUG: ran, found nothing → nothing-to-do, NOT cant-engage', () => {
    assert.equal(at({ engaged: false, nothingToDo: true }), 'nothing-to-do');
    assert.equal(barWantsTeach(at({ engaged: false, nothingToDo: true })), false,
      'there is nothing to demonstrate — the step worked');
  });

  it('a genuine non-engagement is the ONLY teach door', () => {
    assert.equal(at({ engaged: false }), 'cant-engage');
    assert.equal(barWantsTeach('cant-engage'), true);
    for (const b of ['completed', 'nothing-to-do', 'transient', 'running', 'idle']) assert.equal(barWantsTeach(b), false, b);
  });

  it('transient (signed out) still wins over both — sign-in fixes it, teaching does not', () => {
    assert.equal(at({ engaged: false, transient: true }), 'transient');
    // and it wins even when both flags are somehow set: the session is the blocker either way
    assert.equal(at({ engaged: false, transient: true, nothingToDo: true }), 'transient');
  });

  it('an engaged step is completed — the human judges the result', () => {
    assert.equal(at({ engaged: true }), 'completed');
    assert.equal(at({ engaged: true, nothingToDo: true }), 'completed', 'a ranStep beats the flag');
  });

  it('phases other than "ran" never produce an outcome class', () => {
    assert.equal(stepBarClass({ phase: 'running', engaged: false }), 'running');
    for (const p of ['await-step', 'banked', 'plan', '']) assert.equal(stepBarClass({ phase: p, engaged: false }), 'idle', p);
  });

  it('degenerate input does not throw, and does not accidentally accuse', () => {
    assert.doesNotThrow(() => stepBarClass());
    assert.equal(stepBarClass(), 'idle');
    // `engaged: null` means "not determined" — it must NOT fall through to the failure class
    assert.equal(at({ engaged: null }), 'completed');
  });
});
