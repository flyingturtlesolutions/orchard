// Core/branchClassify.test.js — PP-5 (v2.74.1662): model classification for free-text branch arms.
//
// The negation case is the reason this file exists. Everything else is scaffolding around it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasClassifyArms, classifyArms, identityValues, buildClassifyRequest, parseClassifyOutput,
  makeClassifyEvaluator, bankedVerdict, unbankedItems, textHash, classifyTally,
  CLASSIFY_TYPE, IDENTITY_FIELD_HINTS,
} from './branchClassify.js';
import { normalizeBranchVerdict, evalBranch } from './branchClause.js';
import { redact, restore, newRedactionMap } from './redact.js';

const ARMS = [
  { label: 'replacements', is: 'instructs sending a replacement to the homeowner' },
  { label: 'outreach', is: 'instructs contacting the homeowner' },
];
const VERDICT = normalizeBranchVerdict({
  arms: ARMS.map((a) => ({ when: { type: CLASSIFY_TYPE, label: a.label, is: a.is }, label: a.label, then: [] })),
});

describe('branchClassify — detecting classify arms', () => {
  it('recognizes a verdict carrying model-classified arms', () => {
    assert.equal(hasClassifyArms(VERDICT), true);
    assert.equal(classifyArms(VERDICT).length, 2);
  });
  it('a purely deterministic verdict needs no classification pass (no call, no egress)', () => {
    const det = normalizeBranchVerdict({ arms: [{ when: { type: 'record_field_non_empty', binding: 'item', fieldName: 'x' }, label: 'a' }] });
    assert.equal(hasClassifyArms(det), false);
  });
  it('degenerate verdicts do not throw', () => {
    for (const bad of [null, undefined, {}, { arms: null }]) assert.equal(hasClassifyArms(bad), false);
  });
});

describe('branchClassify — identity seeding (how an ADDRESS gets redacted at all)', () => {
  it('collects identity-bearing values from the record, by field name', () => {
    const vals = identityValues({ Id: '1', AddressLine1: '12 Elm St', HomeownerName: 'Jane Doe', Status: 'open' });
    assert.ok(vals.includes('12 Elm St'));
    assert.ok(vals.includes('Jane Doe'));
    assert.ok(!vals.includes('open'), 'a non-identity field must not be redacted — it is the content we need');
  });

  it('THE POINT: no regex detects a street address, but the record tells us what it is', () => {
    const item = { AddressLine1: '12 Elm St', Instructions: 'Ship the new switch to 12 Elm St and call first.' };
    const { text } = redact(item.Instructions, { names: identityValues(item) });
    assert.ok(!text.includes('12 Elm St'), 'the join key must not ride into a prompt');
    assert.ok(text.includes('Ship the new switch'), 'the instruction CONTENT is what makes the branch feasible');
  });

  it('the redacted instruction still round-trips for display', () => {
    const item = { CustomerName: 'Jane Doe', Instructions: 'Call Jane Doe about the switch.' };
    const map = newRedactionMap();
    const { text } = redact(item.Instructions, { names: identityValues(item), map });
    assert.equal(restore(text, map).text, 'Call Jane Doe about the switch.');
  });

  it('very short identity values are dropped (a 2-char name would pseudonymize half the prose)', () => {
    assert.deepEqual(identityValues({ Name: 'Al' }), []);
  });

  it('every declared hint is lowercase-matchable', () => {
    for (const h of IDENTITY_FIELD_HINTS) assert.equal(h, h.toLowerCase());
  });
});

describe('branchClassify — the request (batched, once per run)', () => {
  it('carries every item and every arm in ONE request', () => {
    const items = [{ id: 'a', text: 'send a replacement' }, { id: 'b', text: 'give them a call' }];
    const req = buildClassifyRequest({ items, arms: ARMS, field: 'Instructions' });
    assert.equal(req.itemCount, 2);
    assert.deepEqual(req.armLabels, ['replacements', 'outreach']);
    assert.ok(req.user.includes('id="a"') && req.user.includes('id="b"'));
    assert.ok(req.user.includes('replacements') && req.user.includes('outreach'));
  });

  it('the system prompt makes negation and unknown explicit, not implied', () => {
    const req = buildClassifyRequest({ items: [], arms: ARMS });
    assert.match(req.system, /do NOT send a replacement/, 'the negation trap is stated, not left to inference');
    assert.match(req.system, /unknown/i);
    assert.match(req.system, /none/);
  });
});

describe('branchClassify — parsing is strict in one direction', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  const armLabels = ['replacements', 'outreach'];
  const P = (raw) => parseClassifyOutput(raw, { items, armLabels });

  it('maps valid verdicts onto declared arms', () => {
    const { byId } = P('{"verdicts":[{"id":"a","group":"replacements","why":"asks to ship a new unit"},{"id":"b","group":"outreach","why":"asks to call"}]}');
    assert.equal(byId.get('a').group, 'replacements');
    assert.equal(byId.get('b').group, 'outreach');
  });

  it('an INVENTED group label is downgraded to unknown and COUNTED', () => {
    const { byId, invalid } = P('{"verdicts":[{"id":"a","group":"refunds"},{"id":"b","group":"none"}]}');
    assert.equal(byId.get('a').group, 'unknown', 'a confident answer we cannot map is not an answer');
    assert.equal(invalid, 1);
    assert.equal(byId.get('b').group, 'none');
  });

  it('a SKIPPED item becomes unknown and is reported in `missing`', () => {
    const { byId, missing } = P('{"verdicts":[{"id":"a","group":"outreach"}]}');
    assert.equal(byId.get('b').group, 'unknown');
    assert.deepEqual(missing, ['b']);
  });

  it('unparseable output leaves every item unknown rather than unrouted', () => {
    const { byId } = P('the model wandered off');
    assert.equal(byId.get('a').group, 'unknown');
    assert.equal(byId.get('b').group, 'unknown');
  });

  it('unknown ids and duplicates are rejected, not absorbed', () => {
    const { byId, invalid } = P('{"verdicts":[{"id":"zzz","group":"outreach"},{"id":"a","group":"outreach"},{"id":"a","group":"replacements"}]}');
    assert.equal(byId.get('a').group, 'outreach', 'the first verdict for an id wins; a duplicate cannot overwrite it');
    assert.ok(invalid >= 2);
  });

  it('`none` and `unknown` are DISTINCT outcomes', () => {
    const { byId } = P('{"verdicts":[{"id":"a","group":"none"},{"id":"b","group":"unknown"}]}');
    assert.notEqual(byId.get('a').group, byId.get('b').group);
  });
});

describe('branchClassify — the evaluator, composed with evalBranch', () => {
  const items = [{ Id: 'a' }, { Id: 'b' }, { Id: 'c' }];
  const idOf = (it) => it.Id;
  const build = (raw) => {
    const { byId } = parseClassifyOutput(raw, { items: items.map((i) => ({ id: i.Id })), armLabels: ['replacements', 'outreach'] });
    return makeClassifyEvaluator({ byId, idOf });
  };

  it('routes an item to its classified arm', () => {
    const ev = build('{"verdicts":[{"id":"a","group":"replacements"}]}');
    const r = evalBranch(items[0], VERDICT, (asrt, it) => ev(asrt, it));
    assert.equal(r.outcome, 'arm');
    assert.equal(r.arms[0].label, 'replacements');
  });

  it('THE NEGATION CASE — "do NOT send one" lands anywhere but the replacements arm', () => {
    // A keyword predicate would route this to `replacements` and create a draft order. That is the confidently
    // wrong answer §1.1b exists to prevent, and the whole justification for spending a model call here.
    const ev = build('{"verdicts":[{"id":"a","group":"none","why":"explicitly declines a replacement"}]}');
    const r = evalBranch(items[0], VERDICT, (asrt, it) => ev(asrt, it));
    assert.equal(r.outcome, 'none');
    assert.equal(r.arms.length, 0);
  });

  it('an `unknown` verdict yields UNKNOWN, never a silent fall to `otherwise`', () => {
    const withOtherwise = normalizeBranchVerdict({
      arms: ARMS.map((a) => ({ when: { type: CLASSIFY_TYPE, label: a.label, is: a.is }, label: a.label })),
      otherwise: ['fallback'],
    });
    const ev = build('{"verdicts":[{"id":"a","group":"unknown","why":"contradictory"}]}');
    const r = evalBranch(items[0], withOtherwise, (asrt, it) => ev(asrt, it));
    assert.equal(r.outcome, 'unknown');
  });

  it('an item that was never classified is UNKNOWN, not false', () => {
    const ev = build('{"verdicts":[]}');
    assert.equal(evalBranch(items[2], VERDICT, (a, i) => ev(a, i)).outcome, 'unknown');
  });

  it('MIXED verdicts: a deterministic arm and a classified arm in one branch', () => {
    const mixed = normalizeBranchVerdict({
      arms: [
        { when: { type: 'record_field_non_empty', binding: 'item', fieldName: 'Rush' }, label: 'rush' },
        { when: { type: CLASSIFY_TYPE, label: 'outreach', is: 'asks to contact' }, label: 'outreach' },
      ],
    });
    const { byId } = parseClassifyOutput('{"verdicts":[{"id":"a","group":"outreach"}]}', { items: [{ id: 'a' }], armLabels: ['outreach'] });
    const ev = makeClassifyEvaluator({ byId, idOf, fallback: (asrt, it) => (asrt.fieldName in it ? !!it[asrt.fieldName] : undefined) });
    const r = evalBranch({ Id: 'a', Rush: '' }, mixed, (asrt, it) => ev(asrt, it));
    assert.equal(r.outcome, 'arm');
    assert.equal(r.arms[0].label, 'outreach', 'the deterministic arm said false, the classified arm said yes');
  });
});

describe('branchClassify — the correlation id (v2.74.1663 bug pass)', () => {
  // The first wiring keyed items on `summarizeItem(row)`, which returns an OBJECT. `String(obj)` is
  // "[object Object]" for EVERY row, and `obj || fallback` never falls through because an object is truthy.
  // All N items therefore collapsed onto one id, the model returned one verdict for it, and every item read
  // that verdict — 22 records routed to a single arm, confidently, under an honest-looking tally.
  it('COLLIDING ids make one verdict answer for every item — the bug this guards', () => {
    const items = [{ Id: 'a' }, { Id: 'b' }];
    const { byId } = parseClassifyOutput('{"verdicts":[{"id":"[object Object]","group":"replacements"}]}',
      { items: [{ id: '[object Object]' }], armLabels: ['replacements'] });
    const collidingIdOf = () => '[object Object]';
    const ev = makeClassifyEvaluator({ byId, idOf: collidingIdOf });
    const a = evalBranch(items[0], VERDICT, (as, it) => ev(as, it));
    const b = evalBranch(items[1], VERDICT, (as, it) => ev(as, it));
    assert.equal(a.outcome, 'arm');
    assert.equal(b.outcome, 'arm');
    assert.equal(a.arms[0].label, b.arms[0].label,
      'demonstrates the failure: two DIFFERENT records share one verdict when ids collide');
  });

  it('INDEX ids keep every item on its own verdict', () => {
    const items = [{ Id: 'a' }, { Id: 'b' }];
    const { byId } = parseClassifyOutput('{"verdicts":[{"id":"0","group":"replacements"},{"id":"1","group":"outreach"}]}',
      { items: [{ id: '0' }, { id: '1' }], armLabels: ['replacements', 'outreach'] });
    const outcomes = items.map((it, i) => {
      const ev = makeClassifyEvaluator({ byId, idOf: () => String(i) });
      return evalBranch(it, VERDICT, (as, x) => ev(as, x));
    });
    assert.equal(outcomes[0].arms[0].label, 'replacements');
    assert.equal(outcomes[1].arms[0].label, 'outreach', 'each record must read its OWN verdict');
  });

  it('a DIVERGENT when.label is forced to the arm label — otherwise every item lands in `none`', () => {
    // The classifier is told the ARM's label and returns it. If the assertion carried a different one, every
    // classify arm would evaluate false and the whole run would report "no arm matched" with no error at all.
    const v = normalizeBranchVerdict({
      arms: [{ label: 'replacements', when: { type: CLASSIFY_TYPE, label: 'Replacements', is: 'ship a new unit' } }],
    });
    assert.equal(v.arms[0].when.label, 'replacements', 'the arm label is authoritative');

    const { byId } = parseClassifyOutput('{"verdicts":[{"id":"0","group":"replacements"}]}', { items: [{ id: '0' }], armLabels: ['replacements'] });
    const ev = makeClassifyEvaluator({ byId, idOf: () => '0' });
    assert.equal(evalBranch({ Id: 'a' }, v, (as, it) => ev(as, it)).outcome, 'arm');
  });

  it('a deterministic `when` is left untouched by that normalization', () => {
    const cond = { type: 'record_field_non_empty', binding: 'item', fieldName: 'X' };
    const v = normalizeBranchVerdict({ arms: [{ label: 'has-x', when: cond }] });
    assert.deepEqual(v.arms[0].when, cond, 'only classify arms get a forced label');
  });

  it('idOf is called with ONE argument — a two-arg form silently keys on "undefined"', () => {
    // makeClassifyEvaluator calls idOf(item). A `(item, i) => String(i)` form receives undefined for i and
    // keys every lookup on the literal string "undefined", so every item misses its verdict.
    let argCount = -1;
    const ev = makeClassifyEvaluator({ byId: new Map(), idOf: (...args) => { argCount = args.length; return 'x'; } });
    ev({ type: CLASSIFY_TYPE, label: 'replacements' }, { Id: 'a' });
    assert.equal(argCount, 1, 'the index must be CLOSED OVER, not taken as a second parameter');
  });
});

describe('branchClassify — banking (determinism without avoiding the model)', () => {
  it('a banked verdict records the arm, the reason and the provenance', () => {
    const b = bankedVerdict({ id: '10834758', group: 'replacements', why: 'ship a new switch', at: 1, model: 'model' });
    assert.equal(b.arm, 'replacements');
    assert.equal(b.reviewed, false, 'banked is not the same as reviewed');
    assert.ok(b.why);
  });

  it('re-runs classify only what is NOT banked', () => {
    const items = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }];
    const banked = [{ id: 'a', arm: 'outreach', textHash: textHash('x') }];
    assert.deepEqual(unbankedItems(items, banked).map((i) => i.id), ['b']);
  });

  it('a CHANGED text re-classifies — a banked verdict describes the text it was made about', () => {
    const items = [{ id: 'a', text: 'now says something else' }];
    const banked = [{ id: 'a', arm: 'outreach', textHash: textHash('the original text') }];
    assert.deepEqual(unbankedItems(items, banked).map((i) => i.id), ['a']);
  });

  it('textHash is stable and discriminating', () => {
    assert.equal(textHash('abc'), textHash('abc'));
    assert.notEqual(textHash('abc'), textHash('abd'));
  });

  it('the tally names every class including the zeroes', () => {
    const { byId } = parseClassifyOutput('{"verdicts":[{"id":"a","group":"replacements"}]}', { items: [{ id: 'a' }], armLabels: ['replacements', 'outreach'] });
    const t = classifyTally(byId, ['replacements', 'outreach']);
    assert.match(t, /replacements 1/);
    assert.match(t, /outreach 0/);
    assert.match(t, /couldn’t tell 0/);
  });
});

// ── v2.74.1684 — generalization: the DECLARATION seeds identity, not a word list ──────────────────────────────
describe('branchClassify — identity comes from the ground\'s own joinKey declaration', () => {
  it('a declared joinKey identifies fields the generic hints would MISS', () => {
    // A ground with its own vocabulary — no "address", no "customer", nothing the English hints know.
    const row = { CaseRef: 'C-99', SubscriberMSISDN: '447700900123', PolicyHolderSurname: 'Okonkwo', Notes: 'x' };
    const joinKey = ['SubscriberMSISDN', { contact: 'primary', type: 'PolicyHolderSurname' }];
    const vals = identityValues(row, { joinKey });
    assert.ok(vals.includes('447700900123'), 'the declared key must be treated as identity');
    assert.ok(vals.includes('Okonkwo'));
    assert.ok(!vals.includes('x'), 'a non-identity field is still left alone — it is the content we need');
  });

  it('with NO declaration it still falls back to the generic hints', () => {
    assert.ok(identityValues({ AddressLine1: '12 Elm St', Status: 'open' }).includes('12 Elm St'));
  });

  it('carries no vertical-specific vocabulary in the Core default', () => {
    // `homeowner` sat here and helped exactly one industry. The declaration works for any ground.
    for (const w of ['homeowner', 'warranty', 'ticket', 'patient', 'tenant']) {
      assert.ok(!IDENTITY_FIELD_HINTS.includes(w), `${w} is vertical vocabulary, not a general identity hint`);
    }
  });

  it('dedupes across both sources and does not throw on a malformed joinKey', () => {
    const row = { Email: 'a@b.co' };
    assert.deepEqual(identityValues(row, { joinKey: ['Email'] }), ['a@b.co']);
    for (const bad of [null, 'nope', [null], [{}], [42]]) assert.doesNotThrow(() => identityValues(row, { joinKey: bad }));
  });
});
