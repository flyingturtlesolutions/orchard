// Core/intentContext.test.js — RI-1 intent-composer context pack (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildIntentContext, renderIntentContext, intentContextFingerprint, validateRichIntents, PACK_CAPS } from './intentContext.js';

const FIXTURE = () => ({
  ground: { name: 'Pixabay', url: 'https://pixabay.com' },
  readiness: 'rich',
  caps: [
    { id: 'cap1', intent: 'Search media by category', aliases: ['search pixabay for videos'],
      params: [{ name: 'CATEGORY', vocabulary: ['Videos', 'Photos', 'Vectors'] }, { name: 'SEARCH_FOR_VIDEOS' }] },
    { id: 'cap2', kind: 'composite', intent: 'Search then read titles', aliases: [], params: [] },
    { id: 'obs1', kind: 'observation', intent: 'get the top result title', outputType: 'list' },
  ],
  locales: [{ url: 'https://pixabay.com/', model: {
    features: { f1: { label: 'Media type' }, f2: { label: 'Videos' }, f3: { label: 'Photos' } },
    goals: {
      g1: { id: 'g1', label: 'Search media by category', description: 'Find media via the search bar' },
      g2: { id: 'g2', label: 'Media type filter', description: 'Filter results', achievableVia: ['f1', 'f2', 'f3'] },
    },
  } }],
  siteMap: {
    nodes: {
      'pixabay.com/': { exemplarUrl: 'https://pixabay.com/', instanceCount: 1, status: 'modeled', goals: ['Search media by category'] },
      'pixabay.com/photos/{id}': { exemplarUrl: 'https://pixabay.com/photos/123', instanceCount: 40, status: 'discovered' },
    },
    edges: [{ from: 'pixabay.com/', to: 'pixabay.com/photos/{id}' }],
  },
});

describe('buildIntentContext — curate the Ground into a bounded composer pack', () => {
  it('splits taught (actions+composites) from reads (observations); coverage flags goals (GA-7)', () => {
    const pack = buildIntentContext(FIXTURE());
    assert.equal(pack.site.name, 'Pixabay');
    assert.equal(pack.site.host, 'pixabay.com');
    assert.equal(pack.taught.length, 2, 'observation excluded from taught');
    assert.equal(pack.taught.find((t) => t.id === 'cap2').kind, 'composite');
    assert.deepEqual(pack.reads, [{ id: 'obs1', intent: 'get the top result title', outputType: 'list' }]);
    const g1 = pack.goals.find((g) => g.label === 'Search media by category');
    const g2 = pack.goals.find((g) => g.label === 'Media type filter');
    assert.equal(g1.covered, true, 'taught cap covers it');
    assert.equal(g2.covered, false);
    assert.equal(g1.prevalence, 1, 'prevalence = archetype count offering the goal (1 siteMap node)');
    assert.equal(g2.prevalence, 1, 'not in the siteMap → default 1');
    assert.equal(pack.counts.goalsCovered, 1);
  });

  it('vocab: demo-verified capability vocabulary + disclosure-unit page options (trigger excluded)', () => {
    const pack = buildIntentContext(FIXTURE());
    const cat = pack.vocab.find((v) => v.param === 'CATEGORY');
    assert.deepEqual(cat.options, ['Videos', 'Photos', 'Vectors']);
    assert.equal(cat.from, 'Search media by category');
    const disc = pack.vocab.find((v) => v.param === 'Media type filter');
    assert.deepEqual(disc.options, ['Videos', 'Photos'], 'achievableVia[0] (the trigger) excluded');
    assert.equal(disc.from, 'page options');
    assert.ok(!pack.vocab.find((v) => v.param === 'SEARCH_FOR_VIDEOS'), 'option-less param is not vocabulary');
  });

  it('pages: modeled-first ordering; edges mapped from/to', () => {
    const pack = buildIntentContext(FIXTURE());
    assert.equal(pack.pages[0].pattern, 'pixabay.com/');
    assert.equal(pack.pages[0].modeled, true);
    assert.equal(pack.pages[1].instances, 40);
    assert.deepEqual(pack.edges, [{ from: 'pixabay.com/', to: 'pixabay.com/photos/{id}' }]);
  });

  it('bounds hold under load', () => {
    const goals = {};
    for (let i = 0; i < 40; i++) goals[`g${i}`] = { id: `g${i}`, label: `Do distinct site thing ${i}` };
    const caps = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, intent: `Taught capability number ${i}`, aliases: [] }));
    const pack = buildIntentContext({ caps, locales: [{ model: { goals } }] });
    assert.ok(pack.taught.length <= PACK_CAPS.taught);
    assert.ok(pack.goals.length <= PACK_CAPS.goals);
  });

  it('render cites exact tokens; deterministic; fingerprint tracks the substrate', () => {
    const a = buildIntentContext(FIXTURE());
    const b = buildIntentContext(FIXTURE());
    const text = renderIntentContext(a);
    assert.ok(text.includes('CATEGORY∈{Videos|Photos|Vectors}'), 'vocab rendered inline on the capability');
    assert.ok(text.includes('✓ Search media by category'), 'covered goal badged');
    assert.ok(text.includes('get the top result title → list'));
    assert.ok(text.includes('[explored]'));
    assert.ok(text.includes('COMPOSITION PRIMITIVES'));
    assert.equal(text, renderIntentContext(b), 'deterministic');
    assert.equal(intentContextFingerprint(a), intentContextFingerprint(b));
    // The fingerprint hashes the RENDER — only PROMPT-visible substrate changes bust the cache (an alias
    // push reorders nothing here and isn't rendered, so it correctly keeps the same key).
    const mutated = FIXTURE(); mutated.caps[0].params[0].vocabulary.push('Music');
    assert.notEqual(intentContextFingerprint(buildIntentContext(mutated)), intentContextFingerprint(a), 'prompt-visible change → new fingerprint');
    const aliasOnly = FIXTURE(); aliasOnly.caps[0].aliases.push('another alias');
    assert.equal(intentContextFingerprint(buildIntentContext(aliasOnly)), intentContextFingerprint(a), 'render-invisible change → same key (cache stays warm)');
  });

  it('validateRichIntents — cite-or-reject: grounded steps accepted, badge from goal coverage', () => {
    const pack = buildIntentContext(FIXTURE());
    const good = {
      title: 'Find the newest vector illustrations of {topic} and open the top 5',
      ask: 'find the newest {topic} vectors and open the top 5',
      steps: [
        { kind: 'capability', ref: 'Search media by category', params: { CATEGORY: 'Vectors', SEARCH_FOR_VIDEOS: '{topic}' } },
        { kind: 'read', ref: 'get the top result title' },
        { kind: 'foreach', ref: 'open each of the top 5 results' },
      ],
      params: [{ name: 'topic', example: 'sunset' }],
    };
    const teachy = {
      title: 'Filter results by media type then collect titles',
      steps: [
        { kind: 'goal', ref: 'Media type filter', params: { 'Media type filter': 'Videos' } },
        { kind: 'read', ref: 'get the top result title' },
      ],
    };
    const { intents, rejected } = validateRichIntents([good, teachy], pack);
    assert.equal(rejected.length, 0, JSON.stringify(rejected));
    assert.equal(intents[0].badge, 'ready', 'all-taught steps → ready');
    assert.equal(intents[1].badge, 'teachable', 'uncovered goal step → teachable');
    assert.equal(intents[0].params[0].name, 'topic');
    // v2.74.906 — executable refs ride the validated steps (the chat-side WALK runs bound steps directly)
    assert.equal(intents[0].steps[0].capabilityId, 'cap1', 'capability step carries its id');
    assert.equal(intents[0].steps[1].capabilityId, 'obs1', 'cited read carries its observation-capability id');
    assert.equal(intents[0].steps[1].capabilityKind, 'observation');
  });

  it('validateRichIntents — rejects only what cannot ground; REPAIRS vocab; tolerates the full library', () => {
    const pack = buildIntentContext(FIXTURE());
    const cases = [
      { title: 'Hallucinated capability', steps: [{ kind: 'capability', ref: 'Bulk download everything' }, { kind: 'read', ref: 'get the top result title' }] },
      { title: 'Pure orchestration', steps: [{ kind: 'foreach', ref: 'loop things' }, { kind: 'open', ref: 'open them' }] },
      { title: 'One step only', steps: [{ kind: 'capability', ref: 'Search media by category' }] },
    ];
    const { intents, rejected } = validateRichIntents(cases, pack);
    assert.equal(intents.length, 0);
    assert.equal(rejected.length, 3);
    assert.ok(rejected[0].reason.includes('cites nothing in the pack'));
    assert.ok(rejected[1].reason.includes('orchestration alone'));
    assert.ok(rejected[2].reason.includes('2-8 steps'));
    // v2.74.900 — a vocab violation REPAIRS to a {placeholder} slot (+ a real example) instead of rejecting
    const rep = validateRichIntents([{ title: 'Vocab repair', steps: [
      { kind: 'capability', ref: 'Search media by category', params: { CATEGORY: 'Music' } },
      { kind: 'read', ref: 'get the top result title' },
    ] }], pack);
    assert.equal(rep.intents.length, 1, JSON.stringify(rep.rejected));
    assert.equal(rep.intents[0].steps[0].params.CATEGORY, '{category}');
    assert.deepEqual(rep.intents[0].params, [{ name: 'category', example: 'Videos' }]);
    // v2.74.900 — an unknown kind drops THE STEP, not the intent; the full executor library passes through
    const tol = validateRichIntents([{ title: 'Full library', steps: [
      { kind: 'capability', ref: 'Search media by category' },
      { kind: 'extractify', ref: 'made-up kind' },
      { kind: 'sieve', ref: 'keep items with >1k downloads' },
      { kind: 'detect', ref: 'branch on empty results' },
      { kind: 'loop', ref: 'next page until exhausted' },
    ] }], pack);
    assert.equal(tol.intents.length, 1, JSON.stringify(tol.rejected));
    assert.deepEqual(tol.intents[0].steps.map((s) => s.kind), ['capability', 'sieve', 'detect', 'loop']);
    // REGRESSION (the first live run, 21:23): a GOAL label filed under kind 'read' is a mis-FILED
    // citation, not a hallucination — accept it and RE-KIND to where it grounds ('goal' → teachable).
    const misfiled = validateRichIntents([{ title: 'Browse galleries then search', steps: [
      { kind: 'read', ref: 'Media type filter' },
      { kind: 'capability', ref: 'Search media by category', params: { CATEGORY: 'Photos' } },
    ] }], pack);
    assert.equal(misfiled.intents.length, 1, JSON.stringify(misfiled.rejected));
    assert.equal(misfiled.intents[0].steps[0].kind, 'goal', 're-kinded to the grounding section');
    assert.equal(misfiled.intents[0].badge, 'teachable', 'uncovered goal drives the badge even when mis-filed');
    // placeholder values pass the vocab check; case-insensitive vocab match passes
    const ok = validateRichIntents([{ title: 'Placeholders pass', steps: [
      { kind: 'capability', ref: 'search media by category', params: { CATEGORY: 'vectors', SEARCH_FOR_VIDEOS: '{q}' } },
      { kind: 'read', ref: 'GET THE TOP RESULT TITLE' },
    ] }], pack);
    assert.equal(ok.intents.length, 1, JSON.stringify(ok.rejected));
    // REGRESSION (22:06 live run, 8/8 rejected): an UNMATCHED read ref is a TEACHABLE READ — the model
    // describes the data ("result titles and links") and the teach path learns it on first run. It does
    // NOT count as grounding: an intent with only described reads + orchestration still rejects.
    const teachRead = validateRichIntents([{ title: 'Discover trending keywords and open the top result for each', steps: [
      { kind: 'read', ref: 'list of trending search term buttons' },
      { kind: 'capability', ref: 'Search media by category', params: { CATEGORY: 'Photos' } },
      { kind: 'foreach', ref: 'open the top result per term' },
    ] }], pack);
    assert.equal(teachRead.intents.length, 1, JSON.stringify(teachRead.rejected));
    assert.equal(teachRead.intents[0].steps[0].kind, 'read', 'described read kept as a read step');
    assert.equal(teachRead.intents[0].badge, 'teachable');
    const readOnly = validateRichIntents([{ title: 'Reads alone', steps: [
      { kind: 'read', ref: 'some described data' },
      { kind: 'foreach', ref: 'loop it' },
    ] }], pack);
    assert.equal(readOnly.intents.length, 0, 'described reads do not satisfy the grounded floor');
    // dedup + degrade
    const dup = validateRichIntents([cases[0], cases[0]], pack);
    assert.equal(dup.rejected.length, 2);
    assert.deepEqual(validateRichIntents(null, pack).intents, []);
    assert.deepEqual(validateRichIntents([cases[0]], null).intents, []);
  });

  it('degrades on empty input: minimal pack, render no-throw', () => {
    const pack = buildIntentContext({});
    assert.equal(pack.taught.length, 0);
    assert.equal(pack.goals.length, 0);
    const text = renderIntentContext(pack);
    assert.ok(text.startsWith('SITE:'));
    assert.ok(typeof intentContextFingerprint(pack) === 'string' && intentContextFingerprint(pack).length);
    assert.equal(renderIntentContext(null), '');
  });
});

describe('vocab repair — placeholder shape tightened (CR-D8, v2.74.942)', () => {
  it('a spaced brace token is NOT a placeholder: it repairs into a real fillable slot', () => {
    const pack = buildIntentContext(FIXTURE());
    // Old /\{[^}]*\}/ accepted "{any value}" as already-a-placeholder and skipped the repair — the token
    // then reached execution literally (the chat's extractor only fills {[a-zA-Z0-9_]+} slots).
    const rep = validateRichIntents([{ title: 'Spaced token', steps: [
      { kind: 'capability', ref: 'Search media by category', params: { CATEGORY: '{any value}' } },
      { kind: 'read', ref: 'get the top result title' },
    ] }], pack);
    assert.equal(rep.intents.length, 1, JSON.stringify(rep.rejected));
    assert.equal(rep.intents[0].steps[0].params.CATEGORY, '{category}', 'repaired to the narrow fillable shape');
  });
});
