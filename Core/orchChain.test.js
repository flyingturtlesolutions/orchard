// Core/orchChain.test.js — ORCH-X front-end unit tests (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decomposeAsk, isCompoundAsk, assembleSequentialPlan, looksComplex, buildCompositeCapability, liftControlFlow, deriveCompositeSignature, deriveCompositeIntent, liftConditional, namesMultipleSites, namesAnySite, isForeachAsk, isFanoutAsk, innerDirective, fanoutLifecycle, isEphemeralFanout, isReduceAsk, personaHint } from './orchChain.js';
import { validatePlan } from './orchPlan.js';
import { walkPlan } from './orchRun.js';   // ORCH-L — the pure interpreter, to RUN the lifted open-each loop end-to-end

describe('orchChain — isFanoutAsk (CV-4-full: foreach over a read → conversations)', () => {
  it('fires on a foreach that targets conversations / sub-tasks / threads', () => {
    assert.equal(isFanoutAsk('open each in a new conversation'), true);
    assert.equal(isFanoutAsk('for each ticket open a conversation'), true);
    assert.equal(isFanoutAsk('open every order in its own subtask'), true);
    assert.equal(isFanoutAsk('open each one in a new sub-task'), true);
  });
  it('does NOT fire on a foreach over page links (no conversation noun), nor on a non-foreach', () => {
    assert.equal(isFanoutAsk('open each result'), false, 'DOM open-each-link foreach, not a conversation fan-out');
    assert.equal(isFanoutAsk('click each job and read the title'), false);
    assert.equal(isFanoutAsk('open each thread'), false, '"thread" is a page noun (forum/email), not an Orchard fan-out');
    assert.equal(isFanoutAsk('get my open tickets'), false, 'no quantifier → not a foreach at all');
    assert.equal(isFanoutAsk('start a new conversation'), false, 'a conversation noun without "each" is not a fan-out');
    assert.equal(isForeachAsk('open each in a new conversation'), true, 'still a foreach (the broader gate)');
  });
  it('v2.74.1262 — ALSO fires on an analysis-verb foreach (no conversation noun) + a QUALIFIED "sub thread"', () => {
    assert.equal(isFanoutAsk('research each ticket'), true, 'analysis per item → worker fan-out, no conv noun needed');
    assert.equal(isFanoutAsk('summarize each order'), true);
    assert.equal(isFanoutAsk('open each ticket in a sub thread and research it'), true, 'the live trace: a sub-thread IS a conversation now');
    assert.equal(isFanoutAsk('investigate every alert in its own thread'), true);
    assert.equal(isFanoutAsk('open each thread'), false, 'bare "thread" (a page noun) still does NOT fan out');
  });
});

describe('orchChain — fanoutLifecycle (v2.74.1262: persistent by default, ephemeral on a reduce)', () => {
  it('PERSISTENT by default — per-item work kept as durable sub-tasks', () => {
    assert.equal(fanoutLifecycle('research each in a new conversation'), 'persistent');
    assert.equal(fanoutLifecycle('open each ticket in a sub thread and research it'), 'persistent');
    assert.equal(isEphemeralFanout('draft a reply to each'), false);
  });
  it('EPHEMERAL on a reduce over the set (no keep signal) — workers feed the aggregate, then close', () => {
    assert.equal(fanoutLifecycle('get my tickets and summarize'), 'ephemeral');
    assert.equal(fanoutLifecycle('compare my open tickets'), 'ephemeral');
    assert.equal(isEphemeralFanout('summarise each ticket and give a digest'), true);
  });
  it('a KEEP signal OVERRIDES ephemeral — a reduce alongside "in a new conversation" stays persistent', () => {
    assert.equal(fanoutLifecycle('research each in a new conversation and summarize'), 'persistent');
    assert.equal(fanoutLifecycle('open each in its own chat and compare them'), 'persistent');
  });
  it('isReduceAsk flags an aggregate; personaHint gates the persona extractor (v2.74.1263)', () => {
    assert.equal(isReduceAsk('get my tickets and summarize'), true);
    assert.equal(isReduceAsk('research each ticket'), false);
    assert.equal(personaHint("each should respond in the customer's voice"), true);   // "voice"
    assert.equal(personaHint('reply to each as a senior engineer'), true);            // "as a "
    assert.equal(personaHint('summarize each one, keep it concise'), true);           // "concise"
    assert.equal(personaHint('research each in a new conversation'), false);          // plain task → no LLM
    assert.equal(personaHint('get my tickets and summarize'), false);
  });
});

describe('orchChain — innerDirective (CV-4-map: the per-child task inside a fan-out)', () => {
  it('extracts the action verb-phrase before the fan-out wrapper', () => {
    assert.equal(innerDirective('research each in a new conversation'), 'research');
    assert.equal(innerDirective('summarize each ticket in its own conversation'), 'summarize');
    assert.equal(innerDirective('get the latest comment on each ticket in a new conversation'), 'get the latest comment on');
  });
  it('a bare open/start/create fan-out has no task → "" (just open the children)', () => {
    assert.equal(innerDirective('open each in a new conversation'), '');
    assert.equal(innerDirective('start each one in its own subtask'), '');
    assert.equal(innerDirective('create a conversation for each'), '');
    assert.equal(innerDirective(''), '');
  });
});

describe('orchChain — namesMultipleSites (cross-site pre-filter, T3X)', () => {
  it('fires on two DISTINCT site references (the bug ask + the data-handoff ask)', () => {
    assert.equal(namesMultipleSites('search for jobs on indeed then search for flying turtles on pixabay'), true);
    assert.equal(namesMultipleSites('find a job on linkedin and save it to notion'), true);
    assert.equal(namesMultipleSites('post it to twitter and also to mastodon'), true);
  });
  it('does NOT fire on a within-site compound (no second site)', () => {
    assert.equal(namesMultipleSites('search jobs and filter by date'), false);
    assert.equal(namesMultipleSites('search remote react jobs and sort by newest'), false);
    assert.equal(namesMultipleSites('search SWE jobs in minneapolis posted last 7 days'), false, 'a single location ref is not two sites');
  });
  it('does NOT fire on one site mentioned twice, or on pronoun/article destinations', () => {
    assert.equal(namesMultipleSites('search indeed then open indeed again'), false, 'same site twice = one distinct token');
    assert.equal(namesMultipleSites('save it to me and send it to the top'), false, 'pronoun/article tokens are dropped');
  });
});

describe('orchChain — namesAnySite (single-Ground fallback gate, T3X live-fix)', () => {
  it('fires when the ask names ANY destination site (the off-Indeed bug)', () => {
    assert.equal(namesAnySite('search react jobs on indeed'), true);
    assert.equal(namesAnySite('log in to gmail'), true);
    assert.equal(namesAnySite('search for jobs on indeed then search on pixabay'), true, 'also true when ≥2 sites');
  });
  it('does NOT fire when no site is named (so a plain miss does not pay an LLM round-trip)', () => {
    assert.equal(namesAnySite('filter by remote'), false, 'no destination preposition + site');
    assert.equal(namesAnySite('search jobs and sort by newest'), false);
    assert.equal(namesAnySite('click on the top result'), false, 'pronoun/article destinations are dropped');
    assert.equal(namesAnySite(''), false);
  });
});

describe('orchChain — decompose a compound ask + assemble a sequential plan (ORCH-X)', () => {
  it('decomposeAsk: a single intent stays one clause', () => {
    const c = decomposeAsk('search for music');
    assert.equal(c.length, 1);
    assert.equal(c[0].text, 'search for music');
    assert.equal(c[0].connective, null);
  });

  it('decomposeAsk: "search for x and filter by y" → two clauses (the bug)', () => {
    const c = decomposeAsk('search for music and filter by date');
    assert.deepEqual(c.map((x) => x.text), ['search for music', 'filter by date']);
    assert.equal(c[1].connective, 'and');
  });

  it('decomposeAsk: a value-joining "and" does NOT split ("cats and dogs")', () => {
    assert.deepEqual(decomposeAsk('search for cats and dogs').map((x) => x.text), ['search for cats and dogs']);
    assert.deepEqual(decomposeAsk('add milk and eggs to the cart').map((x) => x.text), ['add milk and eggs to the cart']);
  });

  it('decomposeAsk: "then" and commas are boundaries when a verb follows', () => {
    assert.deepEqual(decomposeAsk('open settings then enable dark mode').map((x) => x.text), ['open settings', 'enable dark mode']);
    assert.deepEqual(
      decomposeAsk('search for music, filter by date and sort by price').map((x) => x.text),
      ['search for music', 'filter by date', 'sort by price'],
    );
  });

  it('decomposeAsk: a connective left by a comma split is stripped from the clause text', () => {
    // "…, then sort" — the comma is the delimiter, so "then" leads the segment; the clause text must be bare.
    assert.deepEqual(decomposeAsk('find music, then sort by date').map((x) => x.text), ['find music', 'sort by date']);
  });

  it('decomposeAsk: a read clause can be chained after a do clause (observations live in chains)', () => {
    const c = decomposeAsk('search for gifs and how many results are there');
    assert.deepEqual(c.map((x) => x.text), ['search for gifs', 'how many results are there']);
  });

  it('decomposeAsk: read/extract verbs split a compound (v2.74.798 — the "and retrieve" live-trace bug)', () => {
    assert.deepEqual(
      decomposeAsk('search for jazz singer jobs in new york and retrieve the first title').map((x) => x.text),
      ['search for jazz singer jobs in new york', 'retrieve the first title'],
    );
    assert.deepEqual(decomposeAsk('search react jobs then grab the top result').map((x) => x.text), ['search react jobs', 'grab the top result']);
    assert.deepEqual(decomposeAsk('find a flight and extract the price').map((x) => x.text), ['find a flight', 'extract the price']);
    // excluded verbs ("pull"/"copy") do NOT split — guards against false splits on "pull-up", "copy editor"
    assert.deepEqual(decomposeAsk('search bars and pull up the routine').map((x) => x.text), ['search bars and pull up the routine']);
  });

  it('isCompoundAsk: reflects clause count', () => {
    assert.equal(isCompoundAsk('search for music'), false);
    assert.equal(isCompoundAsk('search for music and filter by date'), true);
  });

  it('looksComplex: a long single sentence with a constraint signal → worth an LLM plan; short asks aren’t', () => {
    assert.equal(looksComplex('search for jobs'), false, 'short → single match');
    assert.equal(looksComplex('search for software engineers'), false, 'short → single match');
    assert.equal(looksComplex('search for software engineering jobs in minneapolis posted in the last 7 days'), true);
    assert.equal(looksComplex('find remote python developer roles sorted by newest'), true);
    assert.equal(looksComplex('search for remote software jobs $90000+'), true, 'short but a salary + work-type constraint');
    assert.equal(looksComplex('show me cheap flights under $200'), true, 'short but a price constraint');
  });

  it('assembleSequentialPlan: matched clauses → ordered fragment steps, validated', () => {
    const { plan, valid, gaps } = assembleSequentialPlan([
      { text: 'search for music', capabilityId: 'cap_search', bindings: { CATEGORY: 'Music' } },
      { text: 'filter by date', capabilityId: 'cap_filter', bindings: { WHEN: 'Last 3 days' } },
    ], { goal: 'search + filter' });
    assert.equal(valid, true, plan && JSON.stringify(plan));
    assert.equal(plan.steps.length, 2);
    assert.deepEqual(plan.steps.map((s) => s.kind), ['fragment', 'fragment']);
    assert.equal(plan.steps[0].capabilityId, 'cap_search');
    assert.deepEqual(plan.steps[1].bindings, { WHEN: 'Last 3 days' });
    assert.equal(gaps.length, 0);
  });

  it('assembleSequentialPlan: an unmatched clause becomes a GAP (record just that one), not a failure', () => {
    const { plan, gaps } = assembleSequentialPlan([
      { text: 'search for music', capabilityId: 'cap_search' },
      { text: 'filter by date', capabilityId: null },
    ]);
    assert.equal(plan.steps.length, 1, 'only the matched clause is a step');
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].text, 'filter by date');
    assert.equal(gaps[0].index, 1);
  });

  it('buildCompositeCapability: a verified compound → a durable T2 artifact riding the matcher rails', () => {
    const cap = buildCompositeCapability({
      id: 'cmp1', ask: 'search support jobs in minneapolis and tell me the first title', groundId: 'gnd_x',
      steps: [
        { capabilityId: 'cap_search', bindings: { KEYWORD: 'support', LOCATION: 'minneapolis' }, kind: null, clause: 'search support jobs in minneapolis', intent: 'Search jobs' },
        { capabilityId: 'obs_title', bindings: {}, kind: 'observation', clause: 'tell me the first title', intent: "what's the first title" },
      ],
    });
    assert.equal(cap.kind, 'composite');
    assert.equal(cap.effect, 'composite');
    assert.equal(cap.reversible, false, 'may contain an irreversible action → confirm-first');
    assert.equal(cap.groundId, 'gnd_x');
    assert.equal(cap.steps.length, 2);
    assert.equal(cap.steps[0].capabilityId, 'cap_search');
    assert.deepEqual(cap.steps[0].bindings, { KEYWORD: 'support', LOCATION: 'minneapolis' });
    assert.equal(cap.steps[1].kind, 'observation', 'the read step keeps its kind for the runner');
  });

  it('buildCompositeCapability: steps without a capabilityId are dropped', () => {
    const cap = buildCompositeCapability({ ask: 'x and y', groundId: 'g', steps: [{ capabilityId: 'a' }, { clause: 'gap' }, { capabilityId: 'b' }] });
    assert.deepEqual(cap.steps.map((s) => s.capabilityId), ['a', 'b']);
  });

  // ── T2 intent derivation (a control-flow composite's identity) ───────────────────────────────────────────────
  const _cfFlat = () => [
    { capabilityId: 'cap-search', intent: 'Search jobs by title and location', bindings: { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'nurse', EDIT_LOCATION: 'minneapolis' }, clause: 'search nurse jobs' },
    { capabilityId: 'obs-jobs', intent: 'the list of jobs', kind: 'observation', outputType: 'list', clause: 'each job' },
    { capabilityId: 'obs-salary', intent: 'the salary', kind: 'observation', outputType: 'scalar', clause: 'read the salary' },
  ];
  const _cfAsk = 'search nurse jobs, click each job and read the salary';

  it('deriveCompositeSignature: params = union of fragment bindings (with a sample); output = the collected list', () => {
    const { steps } = liftControlFlow(_cfFlat(), _cfAsk);
    const sig = deriveCompositeSignature(steps);
    assert.deepEqual(sig.params.map((p) => p.name), ['SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY', 'EDIT_LOCATION']);
    assert.equal(sig.params[0].sample, 'nurse', 'a sample argument rides along (it is NOT the identity)');
    assert.deepEqual(sig.output, { name: 'THE_SALARY', type: 'list' }, 'the foreach collect names the list output');
  });

  it('deriveCompositeIntent: a param-ABSTRACTED phrase (composition under the quantifier, no arguments baked in)', () => {
    const { steps } = liftControlFlow(_cfFlat(), _cfAsk);
    const intent = deriveCompositeIntent(steps, _cfAsk);
    assert.match(intent, /Search jobs by title and location/, 'the head action intent');
    assert.match(intent, /the salary/, 'the per-item read');
    assert.match(intent, /for each result/, 'the collection quantifier');
    assert.ok(!/nurse|minneapolis/i.test(intent), 'arguments are NOT in the intent — it generalizes across them');
  });

  it('buildCompositeCapability: a CONTROL-FLOW plan → a quantified T2 artifact (IR intact + derived signature/intent)', () => {
    const { steps } = liftControlFlow(_cfFlat(), _cfAsk);
    const cap = buildCompositeCapability({ id: 'cf1', ask: _cfAsk, groundId: 'g', plan: { steps } });
    assert.equal(cap.kind, 'composite');
    assert.equal(cap.controlFlow, true);
    // the IR survives the round-trip so replay runs through the interpreter
    const fe = cap.steps.find((s) => s.kind === 'foreach');
    assert.ok(fe, 'the foreach node is preserved in the stored steps');
    assert.ok(fe.body.some((b) => b.kind === 'wait'), 'the settle node survives');
    assert.ok(fe.body.some((b) => b.kind === 'observe' && b.fixed), 'the fixed re-read survives');
    // the derived, generalized identity
    assert.deepEqual(cap.params, ['SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY', 'EDIT_LOCATION']);
    assert.deepEqual(cap.output, { name: 'THE_SALARY', type: 'list' });
    assert.match(cap.intent, /for each result/);
    assert.ok(!/nurse/i.test(cap.intent), 'the intent is param-abstracted, not the raw ask');
    assert.deepEqual(validatePlan({ steps: cap.steps }).errors, [], 'the stored IR re-validates as a runnable plan');
  });

  it('buildCompositeCapability: the FLAT (legacy) path is unchanged — intent = ask, flat refs, controlFlow false', () => {
    const cap = buildCompositeCapability({ id: 'f1', ask: 'search x and the first title', groundId: 'g', steps: [
      { capabilityId: 'a', bindings: { K: 'x' }, kind: null, clause: 'search x', intent: 'Search' },
      { capabilityId: 'b', bindings: {}, kind: 'observation', clause: 'the first title', intent: 'the first title' },
    ] });
    assert.equal(cap.controlFlow, false);
    assert.equal(cap.intent, 'search x and the first title', 'a flat composite intent is the ask (legacy behavior)');
    assert.equal(cap.steps.length, 2);
    assert.deepEqual(cap.params, []);
  });

  it('liftControlFlow: "the salaries of EACH job" → a foreach over the list, body = the trailing read; it validates', () => {
    const flat = [
      { capabilityId: 'cap-search', intent: 'search jobs', kind: null, clause: 'search recent jobs in japan' },
      { capabilityId: 'obs-jobs', intent: 'the job list', kind: 'observation', outputType: 'list', clause: 'each job' },
      { capabilityId: 'obs-salary', intent: 'the salary', kind: 'observation', outputType: 'scalar', clause: 'the salaries of each' },
    ];
    const { steps, lifted, collect } = liftControlFlow(flat, 'search recent jobs in japan, the salaries of each job');
    assert.equal(lifted, true);
    assert.equal(steps.length, 3);                                  // search(fragment) · jobs(observe list) · foreach
    assert.equal(steps[0].kind, 'fragment');
    assert.equal(steps[1].kind, 'observe');
    assert.equal(steps[2].kind, 'foreach');
    assert.equal(steps[2].over, steps[1].id, 'the foreach iterates the list observe');
    assert.equal(steps[2].body.length, 1);
    assert.equal(steps[2].body[0].kind, 'observe', 'the per-item salary read is the body');
    assert.equal(collect, 'THE_SALARY');
    assert.deepEqual(validatePlan({ steps }).errors, [], 'the lifted plan is well-formed');
  });

  it('liftControlFlow: "click EACH job and read the salary" → foreach { clickItem, WAIT settle, observe(fixed) }', () => {
    const flat = [
      { capabilityId: 'cap-search', intent: 'search jobs', kind: null, clause: 'search nurse jobs' },
      { capabilityId: 'obs-jobs', intent: 'the job list', kind: 'observation', outputType: 'list', clause: 'each job' },
      { capabilityId: 'obs-salary', intent: 'the salary', kind: 'observation', outputType: 'scalar', clause: 'read the salary' },
    ];
    const { steps, lifted, clickEach } = liftControlFlow(flat, 'search nurse jobs, click each job and read the salary');
    assert.equal(lifted, true);
    assert.equal(clickEach, true);
    const fe = steps[2];
    assert.equal(fe.kind, 'foreach');
    assert.equal(fe.body.length, 3, 'click → SETTLE → read');
    assert.equal(fe.body[0].clickItem, true, 'the per-item click comes first');
    assert.equal(fe.body[1].kind, 'wait', 'a settle node paces the live page between the click and the read');
    assert.ok(fe.body[1].ms > 0, 'the settle has a non-zero floor');
    assert.equal(fe.body[2].kind, 'observe');
    assert.equal(fe.body[2].fixed, true, 'the click-then-read is a FIXED panel re-read (single selector, not the frozen archetype index)');
    assert.notEqual(fe.body[2].positional, true, 'a fixed re-read is NOT positional');
    assert.deepEqual(validatePlan({ steps }).errors, [], 'the click-each plan (with the wait node) is well-formed');
  });

  it('liftControlFlow: read-collection (no click) marks the body read POSITIONAL', () => {
    const flat = [
      { capabilityId: 'obs-jobs', kind: 'observation', outputType: 'list', clause: 'each job' },
      { capabilityId: 'obs-title', kind: 'observation', outputType: 'scalar', clause: 'the title of each' },
    ];
    const { steps } = liftControlFlow(flat, 'the title of each job');
    assert.equal(steps[1].body[0].positional, true, 'no click → the per-item read is positional (Nth item)');
  });

  it('liftControlFlow: no quantifier, or no list step → returned FLAT (unchanged)', () => {
    const flat = [
      { capabilityId: 'a', kind: null, clause: 'search' },
      { capabilityId: 'b', kind: 'observation', outputType: 'list', clause: 'the jobs' },
      { capabilityId: 'c', kind: 'observation', outputType: 'scalar', clause: 'the first salary' },
    ];
    assert.equal(liftControlFlow(flat, 'search jobs and the first salary').lifted, false, 'no quantifier → flat');
    const noList = [
      { capabilityId: 'a', kind: null, clause: 'search' },
      { capabilityId: 'b', kind: 'observation', outputType: 'scalar', clause: 'the title of each' },
    ];
    assert.equal(liftControlFlow(noList, 'search and the title of each').lifted, false, 'no list-output step → flat');
  });

  // ── ORCH-L: open-each lift (implicit collection — no explicit list READ in the plan) ─────────────────────────────
  it('liftControlFlow (open-each): "search jobs AND open each job" with NO list step → [search, driver(teach list), foreach{openItem}]', () => {
    const flat = [
      { capabilityId: 'cap-search', intent: 'search jobs', kind: 'fragment', clause: 'search for remote support jobs' },
      { capabilityId: 'cap-openjob', intent: 'open each job', kind: 'fragment', clause: 'open each job on a new page' },
    ];
    const { steps, lifted, openEach, teachNoun } = liftControlFlow(flat, 'search for remote support jobs and open each job on a new page');
    assert.equal(lifted, true);
    assert.equal(openEach, true);
    assert.equal(teachNoun, 'job', 'the collection noun is "job" — not "new"/"page" (a structural stop-word)');
    assert.equal(steps.length, 3);                                  // search(fragment) · driver(observe list) · foreach
    assert.equal(steps[0].kind, 'fragment');
    assert.equal(steps[1].kind, 'observe');
    assert.equal(steps[1].outputType, 'list');
    assert.equal(steps[1].teachList, true, 'the driver is a list observation taught at run time');
    assert.equal(steps[1].capabilityId, null, 'no capability bound yet — taught by pointing at one item');
    assert.equal(steps[2].kind, 'foreach');
    assert.equal(steps[2].over, steps[1].id, 'the foreach iterates the taught list driver');
    assert.equal(steps[2].body.length, 1);
    assert.equal(steps[2].body[0].openItem, true, 'the per-item action OPENS each item (new tab)');
    assert.deepEqual(validatePlan({ steps }).errors, [], 'the open-each plan validates (untaught driver + openItem body are well-formed)');
  });

  it('liftControlFlow (open-each): a READ-each with no list step does NOT open-each lift (stays flat)', () => {
    const flat = [
      { capabilityId: 'a', kind: 'fragment', clause: 'search' },
      { capabilityId: 'b', kind: 'observation', outputType: 'scalar', clause: 'the title of each' },
    ];
    // "the title of each job" reads each (no open/click verb) — it is NOT an open-each, so no driver is synthesized.
    assert.equal(liftControlFlow(flat, 'search and the title of each job').lifted, false);
  });

  it('liftControlFlow (open-each): "open every result" → singularized teachNoun "result"; openItem body validates', () => {
    const flat = [
      { capabilityId: 'cap-search', kind: 'fragment', clause: 'search listings' },
      { capabilityId: 'cap-open', kind: 'fragment', clause: 'open every result' },
    ];
    const { steps, lifted, openEach, teachNoun } = liftControlFlow(flat, 'search listings and open every result');
    assert.equal(lifted, true);
    assert.equal(openEach, true);
    assert.equal(teachNoun, 'result');
    assert.deepEqual(validatePlan({ steps }).errors, []);
  });

  it('buildCompositeCapability: an open-each loop round-trips through the IR sanitizer (openItem + teachList survive)', () => {
    const flat = [
      { capabilityId: 'cap-search', kind: 'fragment', clause: 'search jobs' },
      { capabilityId: 'cap-open', kind: 'fragment', clause: 'open each job' },
    ];
    const { steps } = liftControlFlow(flat, 'search jobs and open each job');
    steps[1].capabilityId = 'obs-taught';                            // simulate the driver having been taught at run time
    const comp = buildCompositeCapability({ plan: { steps }, ask: 'search jobs and open each job', groundId: 'g1' });
    const fe = comp.steps.find((s) => s.kind === 'foreach');
    assert.ok(fe, 'the foreach survives');
    assert.equal(fe.body[0].openItem, true, 'the openItem flag survives the sanitizer (so a saved loop still opens each item)');
    assert.equal(comp.controlFlow, true);
  });

  // The END-TO-END proof: the lifted open-each IR, run through the REAL interpreter (walkPlan) with a mock exec that
  // mirrors the chat runtime (openItem opens scope.item.href), actually LOOPS — opening every row that has a link,
  // in order, and leniently SKIPPING a link-less row instead of aborting. This is what "open each job" should do.
  it('open-each RUNS end-to-end: lift → walkPlan opens each row’s href, in order, skipping a link-less row', async () => {
    const flat = [
      { capabilityId: 'cap-search', kind: 'fragment', clause: 'search remote support jobs', bindings: { Q: 'remote support' } },
      { capabilityId: 'cap-open', kind: 'fragment', clause: 'open each job on a new page' },
    ];
    const { steps } = liftControlFlow(flat, 'search remote support jobs and open each job on a new page');
    const driver = steps.find((s) => s.teachList);
    driver.capabilityId = 'obs-jobs';                         // simulate the list driver having been taught at run time

    const ran = [];                                           // head (action) steps that executed
    const opened = [];                                        // hrefs the open-each body opened (one "tab" each)
    const exec = {
      // Mirrors chat.js _orchRunPlanIR.exec.fragment: openItem opens the current item's captured href, or fails
      // (→ the foreach skips it) when the row carries no link.
      fragment: async (step, scope) => {
        if (step.openItem) {
          const href = scope && scope.item && scope.item.href;
          if (!href) return { ok: false, error: 'no link captured for this item' };
          opened.push(href);
          return { ok: true };
        }
        ran.push(step.id);
        return { ok: true };
      },
      // The driver observe returns the enumerated rows (selector + href per row), like RUN_OBSERVATION_LIST. The
      // third row has no link → it must be skipped, not abort the loop.
      observe: async (step) => step.teachList
        ? { ok: true, items: [
            { index: 0, selector: 'a.r1', href: 'https://indeed.test/job/1' },
            { index: 1, selector: 'a.r2', href: 'https://indeed.test/job/2' },
            { index: 2, selector: 'a.r3', href: null },
          ] }
        : { ok: true, value: '' },
    };

    const env = await walkPlan({ goal: 'search remote support jobs and open each job on a new page', steps }, exec);
    assert.equal(env.ok, true, 'the loop completes (a link-less row is lenient, not fatal)');
    assert.equal(ran.length, 1, 'the search head ran exactly once (before the loop)');
    assert.deepEqual(opened, ['https://indeed.test/job/1', 'https://indeed.test/job/2'], 'opened every row that HAS a link, in order');
    const trace = env.trace.find((t) => t.kind === 'foreach');
    assert.equal(trace.items, 3, 'the driver produced 3 rows');
    assert.equal(trace.done, 2, 'two rows opened');
    assert.equal(trace.skipped, 1, 'the link-less row was skipped (drives the "1 had no link to open" message)');
  });

  // ── ORCH-A: conditional lift (predicate → gate) ──────────────────────────────────────────────────────────────
  it('liftConditional: "if there are any remote jobs, save the search" → observe → analyze(exists) → gate{action}', () => {
    const flat = [
      { capabilityId: 'obs-remote', intent: 'remote jobs', kind: 'observation', outputType: 'list', clause: 'any remote jobs' },
      { capabilityId: 'cap-save', intent: 'save the search', kind: null, clause: 'save the search' },
    ];
    const { steps, lifted, predicate } = liftConditional(flat, 'if there are any remote jobs, save the search');
    assert.equal(lifted, true);
    assert.equal(predicate.op, 'exists');
    assert.equal(steps.length, 3);
    assert.equal(steps[0].kind, 'observe');
    assert.equal(steps[1].kind, 'analyze');
    assert.equal(steps[1].over, steps[0].id, 'the analysis reads the condition observation');
    assert.equal(steps[1].outputType, 'predicate');
    assert.deepEqual(steps[1].predicate, predicate);
    assert.equal(steps[2].kind, 'gate');
    assert.equal(steps[2].over, steps[1].id, 'the gate is driven by the predicate analysis');
    assert.equal(steps[2].body[0].intent, 'save the search', 'the consequent action is the gated body');
    assert.deepEqual(validatePlan({ steps }).errors, [], 'the conditional plan is well-formed (predicate → gate)');
  });

  it('liftConditional: "unless" negates the predicate; the observation is hoisted ahead of the action', () => {
    const flat = [
      { capabilityId: 'cap-apply', intent: 'apply to the job', kind: null, clause: 'apply' },
      { capabilityId: 'obs-taken', intent: 'taken label', kind: 'observation', outputType: 'count', clause: 'it is taken' },
    ];
    const { steps, lifted, predicate } = liftConditional(flat, 'apply unless it is taken');
    assert.equal(lifted, true);
    assert.equal(predicate.negate, true, 'unless negates the predicate');
    assert.equal(steps[0].kind, 'observe', 'the condition observe is hoisted to the front');
    assert.equal(steps[2].kind, 'gate');
    assert.equal(steps[2].body[0].intent, 'apply to the job');
    assert.deepEqual(validatePlan({ steps }).errors, []);
  });

  it('liftConditional: a threshold condition keeps the observation scalar (parses the value at runtime)', () => {
    const flat = [
      { capabilityId: 'obs-top', intent: 'the top salary', kind: 'observation', outputType: 'scalar', clause: 'the top result' },
      { capabilityId: 'cap-skip', intent: 'skip it', kind: null, clause: 'skip' },
    ];
    const { steps, predicate } = liftConditional(flat, 'if the top result is under $40k, skip it');
    assert.equal(predicate.op, 'lt');
    assert.equal(predicate.value, 40000);
    assert.equal(steps[0].outputType, 'scalar', 'a threshold reads the scalar value, not a count');
  });

  it('liftConditional: a GUARDED SEQUENCE runs the leading action UNGATED, then gates only what follows the condition', () => {
    const flat = [
      { capabilityId: 'cap-search', intent: 'Search jobs by title and location', kind: null, clause: 'search for jobs' },
      { capabilityId: 'obs-jobs', intent: 'the list of jobs', kind: 'observation', outputType: 'list', clause: 'if there are any jobs' },
      { capabilityId: 'cap-sort', intent: 'Sort by date', kind: null, clause: 'sort by date' },
    ];
    const { steps, lifted } = liftConditional(flat, 'search for jobs and if there are any jobs, sort by date');
    assert.equal(lifted, true);
    assert.equal(steps.length, 5, 'search(head) · SETTLE · observe · analyze · gate');
    assert.equal(steps[0].kind, 'fragment');
    assert.equal(steps[0].capabilityId, 'cap-search', 'the leading search runs UNCONDITIONALLY (not gated)');
    assert.equal(steps[1].kind, 'wait', 'a settle between the navigating search and the condition read');
    assert.ok(steps[1].ms > 0, 'the settle has a non-zero floor');
    assert.equal(steps[2].kind, 'observe');
    assert.equal(steps[3].kind, 'analyze');
    assert.equal(steps[4].kind, 'gate');
    assert.equal(steps[4].body.length, 1, 'ONLY the sort is gated');
    assert.equal(steps[4].body[0].capabilityId, 'cap-sort');
    assert.deepEqual(validatePlan({ steps }).errors, [], 'the guarded-sequence plan is well-formed');
  });

  it('liftConditional: no conditional keyword, or no observation/action → returned FLAT', () => {
    const noKw = [
      { capabilityId: 'a', kind: null, clause: 'search' },
      { capabilityId: 'b', kind: 'observation', outputType: 'list', clause: 'the jobs' },
    ];
    assert.equal(liftConditional(noKw, 'search jobs and list them').lifted, false, 'no if/when/unless → flat');
    const noObs = [
      { capabilityId: 'a', kind: null, clause: 'save' },
      { capabilityId: 'b', kind: null, clause: 'apply' },
    ];
    assert.equal(liftConditional(noObs, 'if it works, save and apply').lifted, false, 'no observation to test → flat');
  });
});
