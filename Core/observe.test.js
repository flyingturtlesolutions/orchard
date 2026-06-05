// Core/observe.test.js — OBS-READ-1 unit tests (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyReadAsk, inferExtractShape, reconcileOutputType, buildObservationCapability, scoreObservationMatch, observationSearchText } from './observe.js';

describe('observe — the pure floor for observations (OBS-READ-1)', () => {
  it('classifyReadAsk: a count question → outputType count', () => {
    const r = classifyReadAsk('how many gifs match turtle');
    assert.equal(r.isRead, true);
    assert.equal(r.outputType, 'count');
  });

  it('classifyReadAsk: an existence question → predicate', () => {
    assert.equal(classifyReadAsk('is there a free tier?').outputType, 'predicate');
    assert.equal(classifyReadAsk('are the vectors available?').outputType, 'predicate');
  });

  it('classifyReadAsk: a list question → list', () => {
    assert.equal(classifyReadAsk('list the categories').outputType, 'list');
    assert.equal(classifyReadAsk('what are the top results').outputType, 'list');
  });

  it('classifyReadAsk: a value question → scalar', () => {
    assert.equal(classifyReadAsk("what's the price of the first result").outputType, 'scalar');
    assert.equal(classifyReadAsk('how much does it cost?').outputType, 'scalar');
  });

  it('classifyReadAsk: a COMMAND is not a read (routes to the fragment path)', () => {
    assert.equal(classifyReadAsk('search for music').isRead, false);
    assert.equal(classifyReadAsk('download the cheapest gif').isRead, false);
  });

  it('classifyReadAsk: a bare noun phrase ("the salary") is a scalar read', () => {
    assert.equal(classifyReadAsk('the salary').isRead, true);
    assert.equal(classifyReadAsk('the salary').outputType, 'scalar');
    assert.equal(classifyReadAsk('the job title').outputType, 'scalar');
    assert.equal(classifyReadAsk('nurse jobs').isRead, false, 'no determiner → not mistaken for a read (it\'s a search term)');
  });

  it('classifyReadAsk: a read VERB ("show / extract the salary") is a read; list markers → list', () => {
    assert.equal(classifyReadAsk('show the job salary').outputType, 'scalar');
    assert.equal(classifyReadAsk('extract the job salary').outputType, 'scalar');
    assert.equal(classifyReadAsk('read the rating').outputType, 'scalar');
    assert.equal(classifyReadAsk('show all the salaries').outputType, 'list');
  });

  it('classifyReadAsk: a bare trailing "?" is a weak read (default scalar)', () => {
    const r = classifyReadAsk('any luck?');   // a "?" that matches NO read pattern → weak read
    assert.equal(r.isRead, true);
    assert.equal(r.outputType, 'scalar');
    assert.ok(r.confidence < 0.75, 'a pattern-less "?" is low confidence');
  });

  it('inferExtractShape: repeated siblings → list; sub-fields → record; single → text', () => {
    assert.equal(inferExtractShape({ siblingCount: 5 }), 'list');
    assert.equal(inferExtractShape({ repeated: true }), 'list');
    assert.equal(inferExtractShape({ kind: 'collection' }), 'list');
    assert.equal(inferExtractShape({ kind: 'composite' }), 'record');
    assert.equal(inferExtractShape({ fieldCount: 3 }), 'record');
    assert.equal(inferExtractShape({ kind: 'region' }), 'text');
    assert.equal(inferExtractShape({}), 'text');
  });

  it('reconcileOutputType: the ask wins when explicit; otherwise the shape decides', () => {
    assert.equal(reconcileOutputType('count', 'list'), 'count', 'count a list');
    assert.equal(reconcileOutputType('scalar', 'list'), 'scalar', 'read the first of a list');
    assert.equal(reconcileOutputType(null, 'list'), 'list', 'no ask → list shape stays list');
    assert.equal(reconcileOutputType(null, 'text'), 'scalar', 'no ask → text is a single value');
    assert.equal(reconcileOutputType(null, 'record'), 'scalar', 'no ask → a record is a single value');
  });

  it('buildObservationCapability: a MATCHER-COMPATIBLE record that rides the same rails as a fragment', () => {
    const cap = buildObservationCapability({
      id: 'obs1', ask: 'how many gifs match turtle', goal: 'Count matching GIFs',
      groundId: 'gnd_x', aliases: ['how many results'],
      landmark: { role: 'status', accessibleName: 'results count', selector: '.results-count' },
    });
    // matcher normalizes a candidate to {id, intent, aliases, effect, groundId, reversible, params} — all present
    assert.equal(cap.id, 'obs1');
    assert.equal(typeof cap.intent, 'string');
    assert.ok(Array.isArray(cap.aliases) && cap.aliases.includes('how many results'));
    assert.equal(cap.groundId, 'gnd_x');
    assert.equal(cap.reversible, true, 'a read has no side effect → no confirm gate');
    assert.ok(Array.isArray(cap.params));
    // observation-specific: effect read, the EXTRACT body, and the compiler outputType
    assert.equal(cap.kind, 'observation');
    assert.equal(cap.effect, 'read');
    assert.equal(cap.outputType, 'count', 'a count ask → count outputType (loop/repeat connection)');
    assert.equal(cap.observe.extracts.length, 1);
    assert.equal(cap.observe.extracts[0].selector, '.results-count');
    assert.ok(cap.observe.extracts[0].landmark, 'the picked landmark is carried for self-healing replay');
  });

  it('buildObservationCapability: no explicit ask → the picked shape drives the outputType', () => {
    const cap = buildObservationCapability({
      ask: 'the result titles', goal: 'Result titles', groundId: 'g',
      landmark: { selector: 'ul.results', siblingCount: 8 },
    });
    assert.equal(cap.observe.extracts[0].shape, 'list', 'a repeated region is a list extract');
    assert.equal(cap.outputType, 'list');
  });

  it('buildObservationCapability: a well-formed archetype rides the extract (positional list read)', () => {
    const cap = buildObservationCapability({
      id: 'o', ask: "what's the title of the first job?", groundId: 'g',
      landmark: { role: 'link', accessibleName: 'ITOM Developer', selector: 'div.result a.jobTitle' },
      extract: { selector: 'div.result a.jobTitle', archetype: { selector: 'a.jobTitle', index: 0 } },
    });
    const ex = cap.observe.extracts[0];
    assert.deepEqual(ex.archetype, { selector: 'a.jobTitle', index: 0 }, 'archetype {selector,index} is stored');
    assert.equal(ex.selector, 'div.result a.jobTitle', 'the unique selector is kept as the fallback');
    assert.ok(ex.landmark, 'the landmark is kept for description-layer recovery');
  });

  it('buildObservationCapability: a malformed archetype is dropped (selector required; index defaults to 0)', () => {
    const noSel = buildObservationCapability({ ask: 'x?', groundId: 'g', extract: { selector: '.s', archetype: { index: 2 } } });
    assert.equal(noSel.observe.extracts[0].archetype, undefined, 'no archetype.selector → not stored');
    const noIdx = buildObservationCapability({ ask: 'x?', groundId: 'g', extract: { selector: '.s', archetype: { selector: '.a' } } });
    assert.deepEqual(noIdx.observe.extracts[0].archetype, { selector: '.a', index: 0 }, 'missing index defaults to 0');
  });

  // T3X-DF (v2.74.790) — capture-time antecedent: the prerequisite ACTION (the search) the cross-Ground dispatch
  // replays before this read. An Observation carries its OWN antecedent (logical linkage independent of strategy
  // membership). Only stamped when actually known; absent ⇒ the read runs on the base URL.
  it('buildObservationCapability: a known antecedent + its param bindings ride onto the record', () => {
    const cap = buildObservationCapability({
      id: 'o', ask: 'the top job title', groundId: 'g',
      landmark: { selector: 'a.jobTitle' }, extract: { selector: 'a.jobTitle' },
      antecedentFragmentId: 'frag_search', antecedentParamBindings: { SEARCH: 'react' },
    });
    assert.equal(cap.antecedentFragmentId, 'frag_search', 'the prerequisite search Fragment is carried');
    assert.deepEqual(cap.antecedentParamBindings, { SEARCH: 'react' }, 'the values that search ran with are carried');
  });

  it('buildObservationCapability: no antecedent / empty bindings → fields omitted (clean record)', () => {
    const none = buildObservationCapability({ id: 'o', ask: 'x?', groundId: 'g', extract: { selector: '.s' } });
    assert.equal(none.antecedentFragmentId, undefined, 'no antecedent → field absent (not null)');
    assert.equal(none.antecedentParamBindings, undefined, 'no bindings → field absent');
    const emptyBinds = buildObservationCapability({ id: 'o', ask: 'x?', groundId: 'g', extract: { selector: '.s' }, antecedentFragmentId: 'f', antecedentParamBindings: {} });
    assert.equal(emptyBinds.antecedentFragmentId, 'f', 'antecedent fragment still rides without bindings (a search with no params)');
    assert.equal(emptyBinds.antecedentParamBindings, undefined, 'an EMPTY bindings object is omitted, not stored as {}');
  });

  it('observationSearchText: name + description + extract output names form the searchable text', () => {
    const obs = { name: 'First job title', description: 'reads the top result', implementations: [{ tier: 'cache', extracts: [{ shape: 'text', target: '.x', output: 'FIRSTJOB' }] }] };
    const t = observationSearchText(obs).toLowerCase();
    assert.ok(t.includes('first job title') && t.includes('top result') && t.includes('firstjob'));
  });

  it('scoreObservationMatch: a read-ask matches a well-named manual observation', () => {
    const named = { name: 'First job title', implementations: [{ tier: 'cache', extracts: [{ shape: 'text', target: '.x', output: 'TITLE' }] }] };
    assert.ok(scoreObservationMatch("what's the title of the first job?", named) >= 0.99, 'all content tokens covered');
  });

  it('scoreObservationMatch: substring credit lets a glued output name ("FIRSTJOB") still match', () => {
    const glued = { name: 'FIRSTJOB', implementations: [{ tier: 'cache', extracts: [{ shape: 'text', target: '.x', output: 'FIRSTJOB' }] }] };
    // ask tokens: [title, first, job] — "firstjob" covers first + job (substring), title not present → 2/3
    assert.ok(scoreObservationMatch("what's the title of the first job?", glued) >= 0.66);
  });

  it('scoreObservationMatch: an unrelated observation scores below the run threshold', () => {
    const other = { name: 'Salary range filter', implementations: [{ tier: 'cache', extracts: [{ shape: 'text', target: '.x', output: 'SALARY' }] }] };
    assert.ok(scoreObservationMatch("what's the title of the first job?", other) < 0.5);
  });
});
