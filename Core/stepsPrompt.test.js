// Core/stepsPrompt.test.js — intent → workflow steps (v2.74.1669).
//
// The compound cases are taken verbatim from the live output the user rejected: two "steps" that were each
// several operations. They are the specification.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStepsMessages, parseStepsOutput, looksCompound, compoundSteps, MAX_STEPS,
  deriveStepSpec, buildStepsDirective, sanitizeSteps, assessStepCoverage, stepRejectionContext, buildResplitMessages,
  restoreQuantifier,
} from './stepsPrompt.js';
import { isFanoutAsk, isFieldDisplayAsk } from './orchChain.js';   // v2.74.1714 — the repair exists FOR routing; assert the tie

describe('stepsPrompt — the prompt states the rule the wizard already promises', () => {
  it('names the one-step rule and the operation kinds, not just "split it up"', () => {
    const { system } = buildStepsMessages('do a thing');
    assert.match(system, /one step = one action = one result/i);
    assert.match(system, /READ A LIST/);
    assert.match(system, /LOOK UP EACH ELSEWHERE/);
    assert.match(system, /ONE WRITE/);
  });

  it('calls out the exact shapes that were under-split live', () => {
    const { system } = buildStepsMessages('x');
    assert.match(system, /find X where Y/, 'read+filter was shipped as one step');
    assert.match(system, /create it if/, 'find-or-create was shipped as one step');
    assert.match(system, /if <test> then <action>/);
    assert.match(system, /full stop in/);
  });

  it('v2.74.1708 — a case is a PRESENTATION target, and "show X in a case" is not split from its case', () => {
    // Live: "display each homeowner's contact IN A NEW CASE" decomposed into a bare "display …" step + a dangling
    // "open a case" step. The case is WHERE the contact is shown — the presentation and its target are one action.
    const { system } = buildStepsMessages('x');
    assert.match(system, /PRESENT IN A CASE/);
    assert.match(system, /BUT THESE ARE ONE STEP/i, 'the over-split counter is a first-class section, not a lone case exception');
    assert.match(system, /over-splitting is just as wrong/i);
    assert.match(system, /a PRESENTATION and its target/i);
    assert.match(system, /open a case showing X/);
    assert.match(system, /dangling/i);
    assert.match(system, /a LOOK-UP and its key/i, 'the principle generalizes beyond the case');
  });

  it('THE ROLE SEPARATION: names steps, never picks legs or writes parameters', () => {
    // Transposed from proposePerspectives: "You do NOT pick elements or write selectors; you name the roles."
    //   perspective:  name ROLES → resolveRoles picks SELECTORS → code verifies against the DOM
    //   workflow:     name STEPS → the wizard RUNS it           → PP-0c banks what it resolved to
    // Naming and resolving are separate calls on purpose. A model asked to do both invents the half it cannot
    // check, and resolveRoles' own rule applies here with more force: a wrong selector is worse than a gap,
    // and a wrong LEG is worse still, because a leg runs.
    const { system } = buildStepsMessages('x');
    assert.match(system, /do NOT pick legs or write parameters/i);
    assert.match(system, /Never name a connector, endpoint, leg id, or parameter value/i);
    assert.match(system, /user's own words/i);
  });

  it('disambiguates THEIR naming from OURS — the examples must not read as license to name legs', () => {
    // The step examples say "look each homeowner up in Shopify" while the rule says never name a connector.
    // Those are consistent ("Shopify" is their word, `shopify_create_customer` is a leg id) but the model
    // should not have to infer it. Same device as the perspective prompt's "DEPTH IS NOT DOWNSTREAM".
    const { system } = buildStepsMessages('x');
    assert.match(system, /THEIR WORDS ARE NOT A LEG/);
    assert.match(system, /shopify_create_customer/, 'names the machinery it must not write, concretely');
  });

  it('forbids guessing unstated details and forbids padding', () => {
    const { system } = buildStepsMessages('x');
    assert.match(system, /Never guess a filter, field name, id,\s*\n?status or date the user did not say/i);
    assert.match(system, /leave the step in their words and let the run\s*\n?surface the gap/i);
    assert.match(system, /do not pad/i);
  });

  it('carries the intent and the host', () => {
    const { user } = buildStepsMessages('find open warranty tasks', { host: 'vendorsuite.drhorton.com' });
    assert.match(user, /find open warranty tasks/);
    assert.match(user, /vendorsuite\.drhorton\.com/);
  });
});

describe('stepsPrompt — parsing is strict in the safe direction', () => {
  it('reads a well-formed reply', () => {
    const s = parseStepsOutput('{"steps":["get the open warranty tasks","which of those ask for a replacement?"]}');
    assert.equal(s.length, 2);
    assert.equal(s[0], 'get the open warranty tasks');
  });

  it('DROPS a non-string step — that is the v1666 "[object Object]" shape', () => {
    const s = parseStepsOutput('{"steps":["get the tasks",{"text":"x"},null,42]}');
    assert.deepEqual(s, ['get the tasks']);
  });

  it('drops the literal "[object Object]" if a model ever echoes one back', () => {
    assert.deepEqual(parseStepsOutput('{"steps":["[object Object]","get the tasks"]}'), ['get the tasks']);
  });

  it('strips a numbering prefix the model added anyway', () => {
    assert.deepEqual(parseStepsOutput('{"steps":["1. get the tasks","2) sort them"]}'), ['get the tasks', 'sort them']);
  });

  it('dedupes case-insensitively and caps the count', () => {
    assert.deepEqual(parseStepsOutput('{"steps":["Get the tasks","get the tasks"]}'), ['Get the tasks']);
    const many = parseStepsOutput(JSON.stringify({ steps: Array.from({ length: 30 }, (_, i) => `step number ${i}`) }));
    assert.equal(many.length, MAX_STEPS);
  });

  it('unparseable output yields nothing rather than a guess', () => {
    for (const bad of ['the model wandered off', '', null, undefined, '{}', '{"steps":"not an array"}']) {
      assert.deepEqual(parseStepsOutput(bad), []);
    }
  });
});

describe('stepsPrompt — looksCompound flags the under-split shapes', () => {
  it('THE TWO STEPS THE USER REJECTED are both flagged', () => {
    // Verbatim from the live generation. These are the specification for "not a discrete step".
    assert.equal(looksCompound('search shopify for a matching profile. If none is found create a shopify profile.'), true);
    assert.equal(looksCompound('look each one up, and create it if missing'), true);
  });

  it('flags a full stop mid-step, a conditional, and a trailing write', () => {
    assert.equal(looksCompound('do the first thing. then the second'), true);
    assert.equal(looksCompound('check the status, unless it is closed'), true);
    assert.equal(looksCompound('find the customer, and create a draft order'), true);
    assert.equal(looksCompound('get the tasks and then sort them'), true);
  });

  it('does NOT flag a genuine single step', () => {
    for (const s of [
      'get the open warranty tasks',
      'read the instructions on each one',
      'which of those ask for a replacement?',
      'look each homeowner up in Shopify',
      'create a Shopify profile for them',
    ]) assert.equal(looksCompound(s), false, s);
  });

  it('a trailing period alone is not compound', () => {
    assert.equal(looksCompound('get the open warranty tasks.'), false);
  });

  it('compoundSteps returns only the offenders, and never throws', () => {
    const out = compoundSteps(['get the tasks', 'look it up. create it if missing']);
    assert.equal(out.length, 1);
    assert.deepEqual(compoundSteps(null), []);
    assert.equal(looksCompound(null), false);
  });
});

// ── v2.74.1669 stages 2-11 — code computes the params, model interprets, code guarantees ──────────────────────
describe('stepsPrompt — deriveStepSpec (the parameters CODE owns)', () => {
  const S = (s) => deriveStepSpec(s);

  it('THE REJECTED INTENT (verbatim, typo and all) still floors above the 2 steps that shipped', () => {
    // Verbatim from the live session — the user typed "were" for "where", which is exactly why this is asserted
    // against the raw text rather than a cleaned-up version.
    const spec = S('find open warranty tasks were replacements are requested, then search shopify for a matching profile for each and create one if none is found');
    assert.equal(spec.collection, true);
    assert.equal(spec.findCreate, true);
    assert.equal(spec.write, true);
    assert.ok(spec.scale.min >= 3, `floor was ${spec.scale.min}; the live generation returned 2`);
  });

  it('THE DETECTOR IS A HINT, NOT A GATE — a typo lowers the floor and changes nothing else', () => {
    // "were" vs "where" costs the read+filter signal. That is acceptable BY DESIGN: the floor tells the model
    // how far it is under-splitting, it does not perform the split. A missed signal means a weaker hint, never
    // a wrong answer — the general rules and the operation vocabulary are unconditional. Trying to make this
    // regex typo-proof would be rebuilding natural-language understanding in a pattern, which is the exact
    // mistake `decomposeAsk` embodies and the reason this module asks a model at all.
    const typo = S('find open warranty tasks were replacements are requested');
    const clean = S('find open warranty tasks where replacements are requested');
    assert.equal(clean.readFilter, true);
    assert.equal(typo.readFilter, false, 'documents the limit rather than pretending it is covered');
    assert.ok(clean.scale.min > typo.scale.min);
    // Both still carry the full unconditional rule set.
    for (const s of [typo, clean]) assert.match(buildStepsMessages('x', { spec: s }).system, /one step = one action/i);
  });

  it('detects each shape on its own', () => {
    assert.equal(S('find the tasks where replacements are requested').readFilter, true);
    assert.equal(S('read the instructions on each one').collection, true);
    assert.equal(S('look them up and create one if none is found').findCreate, true);
    assert.equal(S('if it is overdue, close it').conditional, true);
    assert.equal(S('draft an order').write, true);
  });

  it('a genuinely simple ask keeps a floor of 1 — the floor never inflates', () => {
    const spec = S('get the open warranty tasks');
    assert.equal(spec.scale.min, 1);
    assert.deepEqual(spec.signals.filter((x) => x !== 'write'), []);
  });

  it('v2.74.1709 — the floor no longer inflates on lexical FALSE POSITIVES (the critical-review fixes)', () => {
    // bare "all" is a bulk read, not a per-item pass; write-verbs that are also nouns must not fire.
    assert.equal(S('get all open tasks').collection, false, '"all" alone is not a per-item collection');
    assert.equal(S('get tasks by order number').write, false, '"order" the noun (by order …) is not a write');
    assert.equal(S('show the result set').write, false, '"result set" is not a write');
    assert.equal(S('in order to send the update').write, true, 'a real write after "in order to" still fires (order excluded, send fires)');
    // and the genuine signals survive the tightening:
    assert.equal(S('read the note on each one').collection, true);
    assert.equal(S('draft an order').write, true, 'draft is the verb; "an order" the noun is excluded but draft still fires');
    assert.equal(S('send a reminder').write, true);
  });

  it('the floor is capped and reports how it was decided', () => {
    const spec = S('find each task where x, then if none create one and send an update');
    assert.ok(spec.scale.min <= MAX_STEPS);
    assert.equal(spec.decidedBy, 'lexical');
    assert.equal(S('get the tasks').decidedBy, 'default');
  });

  it('degenerate input does not throw', () => {
    for (const bad of [null, undefined, '', 42]) assert.doesNotThrow(() => deriveStepSpec(bad));
  });
});

describe('stepsPrompt — buildStepsDirective (the params become RULES, not a constant)', () => {
  it('names the split each detected shape implies', () => {
    const d = buildStepsDirective(deriveStepSpec('find tasks where x, look each up and create one if missing, then send it'));
    assert.match(d, /AT LEAST \d+ separate actions/);
    assert.match(d, /SEPARATE steps/);
    assert.match(d, /COLLECTION/);
    assert.match(d, /FIND-OR-CREATE/);
    assert.match(d, /WRITE/);
  });
  it('a simple ask gets permission to stay one step', () => {
    assert.match(buildStepsDirective(deriveStepSpec('get the open warranty tasks')), /may genuinely be one action/);
  });
  it('the directive reaches the prompt, marked as being about THIS request', () => {
    const { system } = buildStepsMessages('find tasks where x and create one if missing');
    assert.match(system, /ABOUT THIS PARTICULAR REQUEST/);
    assert.match(system, /FIND-OR-CREATE/);
  });
});

describe('stepsPrompt — sanitizeSteps (the code-side guarantee bracket)', () => {
  it('drops machinery leaking into a step the user must read', () => {
    const r = sanitizeSteps(['get the tasks', 'call shopify_create_customer', 'POST /api/v2/tickets.json', 'send {"status":"open"}']);
    assert.deepEqual(r.steps, ['get the tasks']);
    assert.equal(r.dropped.length, 3);
    assert.ok(r.dropped.every((d) => /machinery/.test(d.why)));
  });
  it('strips numbering and bullets, clamps length, dedupes', () => {
    const r = sanitizeSteps(['1. get the tasks', '• Get The Tasks', `- ${'x'.repeat(400)}`]);
    assert.equal(r.steps[0], 'get the tasks');
    assert.equal(r.steps.length, 2);
    assert.ok(r.steps[1].length <= 200);
  });
  it('drops non-strings and placeholders rather than rendering them', () => {
    const r = sanitizeSteps([{ text: 'x' }, null, '[object Object]', 'get the tasks']);
    assert.deepEqual(r.steps, ['get the tasks']);
  });
  it('NEVER rewrites meaning — the text is what the user approves', () => {
    const r = sanitizeSteps(['look each homeowner up in Shopify']);
    assert.deepEqual(r.steps, ['look each homeowner up in Shopify']);
  });
});

describe('stepsPrompt — assessStepCoverage (reports, never repairs)', () => {
  it('flags an under-split against the intent\'s own floor', () => {
    const spec = deriveStepSpec('find tasks where x, look each up and create one if missing');
    const a = assessStepCoverage(['find tasks where x', 'look each up and create one if missing'], spec);
    assert.equal(a.underSplit, true);
    assert.equal(a.compound.length, 1);
    assert.equal(a.complete, false);
  });
  it('a properly split proposal is complete', () => {
    const spec = deriveStepSpec('find the open tasks then draft an order');
    const a = assessStepCoverage(['find the open tasks', 'draft an order'], spec);
    assert.equal(a.underSplit, false);
    assert.equal(a.complete, true);
  });
  it('degenerate input does not throw', () => {
    assert.doesNotThrow(() => assessStepCoverage(null, {}));
  });
});

describe('stepsPrompt — rejections stick, edits teach', () => {
  it('feeds rejected and rewritten steps into the next proposal', () => {
    const c = stepRejectionContext(['search shopify and create a profile'], [{ from: 'do the thing', to: 'get the open warranty tasks' }]);
    assert.match(c, /REJECTED/);
    assert.match(c, /search shopify and create a profile/);
    assert.match(c, /REWROTE/);
    assert.match(c, /get the open warranty tasks/);
  });
  it('empty when there is nothing to carry', () => {
    assert.equal(stepRejectionContext([], []), '');
    assert.equal(stepRejectionContext(null, null), '');
  });
  it('reaches the user message', () => {
    const { user } = buildStepsMessages('x', { rejectionContext: stepRejectionContext(['bad step'], []) });
    assert.match(user, /bad step/);
  });
});

describe('stepsPrompt — buildResplitMessages (repair is a narrower ASK, not a code split)', () => {
  it('asks for one instruction\'s separate actions, keeping their words', () => {
    const { system, user } = buildResplitMessages('search shopify for a matching profile. If none is found create a shopify profile.');
    assert.match(system, /split ONE instruction/i);
    assert.match(system, /look-up and the create/);
    assert.match(system, /Keep their words/);
    assert.match(user, /search shopify for a matching profile/);
  });
  it('permits "it really is one action"', () => {
    assert.match(buildResplitMessages('x').system, /genuinely is ONE action, return it unchanged/);
  });
});

describe('stepsPrompt — restoreQuantifier (v2.74.1714: the quantifier-fidelity backstop)', () => {
  // The live 172653 shape, verbatim: the model kept every word except "for each", and that one dropped token
  // re-routed the step off the fan-out (per-item drill + case per item) onto the single-bulk-case engine.
  const LIVE_ASK = "get open warranty tasks and for each, show primary homeowner's contact information in new case";
  const LIVE_STEPS = ['get open warranty tasks', "show primary homeowner's contact information in new case"];

  it('restores the dropped "for each" onto the step that owns the quantified clause (the live bug)', () => {
    const { steps, restored } = restoreQuantifier(LIVE_ASK, LIVE_STEPS);
    assert.deepEqual(restored, { quantifier: 'for each', stepIndex: 1 });
    assert.equal(steps[0], 'get open warranty tasks', 'the read step is untouched');
    assert.equal(steps[1], "for each, show primary homeowner's contact information in new case");
  });

  it('the repaired step actually ROUTES: fan-out fires, field-display keeps the raw card (the point of the repair)', () => {
    const { steps } = restoreQuantifier(LIVE_ASK, LIVE_STEPS);
    assert.equal(isFanoutAsk(steps[1]), true, 'quantifier + case target → the fan-out (which drills per-item detail)');
    assert.equal(isFieldDisplayAsk(steps[1]), true, 'display verb, no analysis verb → the v1712 raw field card');
    assert.equal(isFanoutAsk(LIVE_STEPS[1]), false, 'and WITHOUT the repair it misses the fan-out — the live misroute');
  });

  it('no-op when the model kept a quantifier anywhere (never double-quantify)', () => {
    const kept = ['get open warranty tasks', "show each homeowner's contact information in a new case"];
    const { steps, restored } = restoreQuantifier(LIVE_ASK, kept);
    assert.equal(restored, null);
    assert.deepEqual(steps, kept);
  });

  it('no-op when the ask never quantified (never invent a signal the user did not say)', () => {
    const { restored } = restoreQuantifier('get open warranty tasks and show the summary', ['get open warranty tasks', 'show the summary']);
    assert.equal(restored, null);
  });

  it('no-op when no step confidently owns the quantified clause (a wrong owner is worse than the gap)', () => {
    const { restored } = restoreQuantifier('for each, review it', ['get the tickets', 'send the report']);
    assert.equal(restored, null);
  });

  it('no-op on a TIE — two steps equally claim the clause, so neither confidently owns it', () => {
    const { restored, steps } = restoreQuantifier(
      'for each, show the ticket status note',
      ['file the ticket status note', 'mail the ticket status note']);   // 4-word overlap each — dead heat
    assert.equal(restored, null);
    assert.equal(steps[0].startsWith('for each'), false);
    assert.equal(steps[1].startsWith('for each'), false);
  });

  it('handles the mid-clause quantifier form too ("email each vendor" dropped to "email the vendors")', () => {
    const { steps, restored } = restoreQuantifier(
      'get the overdue invoices and email each vendor about the balance',
      ['get the overdue invoices', 'email the vendors about the balance']);
    assert.equal(restored && restored.quantifier, 'each');
    assert.equal(steps[1], 'for each, email the vendors about the balance');
  });

  it('the prompt now states the rule (the teach half of the same fix)', () => {
    const { system } = buildStepsMessages('x');
    assert.match(system, /KEEP THE QUANTIFIER/);
    assert.match(system, /keeps its quantifier IN the one step/);
  });
});
