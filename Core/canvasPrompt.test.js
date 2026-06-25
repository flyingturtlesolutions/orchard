// Core/canvasPrompt.test.js — CA-9 (v2.74.1206): the compose-canvas prompt + reply parse (pure).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCanvasMessages, parseCanvasOutput } from './canvasPrompt.js';

describe('canvasPrompt — buildCanvasMessages', () => {
  it('includes the ask + role, and steers to the closed vocabulary + honesty rule', () => {
    const { system, user } = buildCanvasMessages('how is my month going', { seed: 'You are a finance watcher.' });
    assert.match(user, /how is my month going/);
    assert.match(user, /finance watcher/);
    assert.match(system, /markdown/); assert.match(system, /metric/); assert.match(system, /chart/);
    assert.match(system, /never invent specific personal numbers/i);
    assert.match(system, /NO html\/script/i);
  });
  it('omits empty optional sections', () => {
    const { user } = buildCanvasMessages('x');
    assert.doesNotMatch(user, /ROLE|OBJECTS|LEARNED/);
    assert.match(user, /ASK: x/);
  });
});

describe('canvasPrompt — parseCanvasOutput', () => {
  it('extracts a spec from a fenced JSON reply with prose around it', () => {
    const out = parseCanvasOutput('Sure!\n```json\n{"title":"T","blocks":[{"id":"a","kind":"metric","label":"x","value":"1"}]}\n```\nDone.');
    assert.equal(out.title, 'T');
    assert.equal(out.blocks.length, 1);
  });
  it('extracts from raw JSON with NESTED braces (chart data)', () => {
    const out = parseCanvasOutput('{"title":"D","blocks":[{"id":"c","kind":"chart","data":{"labels":["a","b"],"series":[{"name":"s","values":[1,2]}]}}]}');
    assert.equal(out.blocks[0].kind, 'chart');
    assert.deepEqual(out.blocks[0].data.series[0].values, [1, 2]);
  });
  it('null on no blocks / no json / empty / non-object', () => {
    assert.equal(parseCanvasOutput('{"title":"T","blocks":[]}'), null);
    assert.equal(parseCanvasOutput('no json at all'), null);
    assert.equal(parseCanvasOutput(''), null);
    assert.equal(parseCanvasOutput('[1,2,3]'), null);
  });
});
