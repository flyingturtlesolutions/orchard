// Core/observe.test.js — OBS-READ-1 unit tests (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyReadAsk, inferExtractShape, reconcileOutputType, buildObservationCapability } from './observe.js';

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

  it('classifyReadAsk: a bare trailing "?" is a weak read (default scalar)', () => {
    const r = classifyReadAsk('the membership price?');
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
});
