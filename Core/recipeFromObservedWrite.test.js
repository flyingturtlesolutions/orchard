// Core/recipeFromObservedWrite.test.js — CX-8 (v2.74.1296): the demonstrate-once WRITE core. The user's typed
// inputs become `{param}`s; protocol constants stay; the literal values NEVER bank (privacy); method sets safety.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { recipeFromObservedWrite, recipesFromObservedWrites, fillWriteBody } from './recipeFromObservedWrite.js';

describe('recipeFromObservedWrite — JSON body templating', () => {
  const cap = {
    method: 'POST',
    url: 'https://calendar.google.com/calendar/v2/events',
    contentType: 'application/json',
    body: JSON.stringify({ summary: 'test event', start: { dateTime: '2026-06-22T13:00' }, calendarType: 'primary' }),
  };
  const r = recipeFromObservedWrite(cap, { appHost: 'calendar.google.com', demonstratedValues: ['test event', '2026-06-22T13:00'] });

  it('emits a gated POST write-recipe with demonstrated provenance', () => {
    assert.equal(r.method, 'POST');
    assert.equal(r.safetyClass, 'gated');
    assert.equal(r.provenance, 'demonstrated');
    assert.equal(r.reviewState, 'pending');
    assert.equal(r.bodyType, 'json');
    assert.equal(r.origin, 'calendar.google.com');
  });

  it('templates the demonstrated values into {param}s and keeps the constant', () => {
    assert.equal(r.body.summary, '{summary}');
    assert.equal(r.body.start.dateTime, '{datetime}');   // nested leaf templated (param name slugged → lowercase)
    assert.equal(r.body.calendarType, 'primary');        // constant kept literal
    const names = r.params.map((p) => p.name).sort();
    assert.deepEqual(names, ['datetime', 'summary'].sort());
  });

  it('PRIVACY: the typed values never appear anywhere in the banked recipe', () => {
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes('test event'), 'summary value must not bank');
    assert.ok(!serialized.includes('2026-06-22T13:00'), 'date value must not bank');
    for (const p of r.params) assert.ok(!('value' in p) && !('example' in p), 'params carry no literal');
  });
});

describe('recipeFromObservedWrite — other shapes', () => {
  it('form-urlencoded body templates by key', () => {
    const r = recipeFromObservedWrite(
      { method: 'POST', url: 'https://x.test/comments', contentType: 'application/x-www-form-urlencoded', body: 'text=hello+world&parent=42' },
      { demonstratedValues: ['hello world'] });
    assert.equal(r.bodyType, 'form');
    assert.equal(r.body.text, '{text}');
    assert.equal(r.body.parent, '42');   // not demonstrated → constant
    assert.ok(r.params.some((p) => p.name === 'text'));
  });

  it('DELETE → destructive, no body', () => {
    const r = recipeFromObservedWrite({ method: 'DELETE', url: 'https://x.test/events/9912' });
    assert.equal(r.safetyClass, 'destructive');
    assert.equal(r.body, null);
    assert.ok(r.endpoint.includes('{'), 'the id segment is templated');
  });

  it('templates an id in the write URL path', () => {
    const r = recipeFromObservedWrite({ method: 'PUT', url: 'https://x.test/events/64863', contentType: 'application/json', body: '{"title":"X"}' }, { demonstratedValues: ['X'] });
    assert.match(r.endpoint, /\/events\/\{id\}/);
    assert.ok(r.params.some((p) => p.name === 'id'));
    assert.ok(r.params.some((p) => p.name === 'title'));
    assert.equal(r.safetyClass, 'gated');
  });

  it('an opaque/raw body still substring-templates the typed values (no literal leak)', () => {
    const r = recipeFromObservedWrite({ method: 'POST', url: 'https://x.test/rpc', contentType: 'text/plain', body: 'op=create|name=Acme Corp|v=2' }, { demonstratedValues: ['Acme Corp'] });
    assert.equal(r.bodyType, 'raw');
    assert.ok(!JSON.stringify(r).includes('Acme Corp'), 'typed value must not bank even from a raw body');
  });

  it('GET / HEAD are not writes → null', () => {
    assert.equal(recipeFromObservedWrite({ method: 'GET', url: 'https://x.test/events' }), null);
    assert.equal(recipeFromObservedWrite({ method: 'HEAD', url: 'https://x.test/events' }), null);
  });

  it('a re-demo of the same endpoint yields the same id (dedupable)', () => {
    const a = recipeFromObservedWrite({ method: 'POST', url: 'https://x.test/events', body: '{}' });
    const b = recipeFromObservedWrite({ method: 'POST', url: 'https://x.test/events', body: '{}' });
    assert.equal(a.id, b.id);
  });
});

describe('recipesFromObservedWrites — a demo trace', () => {
  it('keeps writes, drops the GETs, dedups by id', () => {
    const captures = [
      { method: 'GET', url: 'https://x.test/events' },                         // read — dropped
      { method: 'POST', url: 'https://x.test/events', body: '{"t":"a"}', contentType: 'application/json' },
      { method: 'POST', url: 'https://x.test/events', body: '{"t":"b"}', contentType: 'application/json' },  // same endpoint — dedup
      { method: 'DELETE', url: 'https://x.test/events/5' },
    ];
    const recipes = recipesFromObservedWrites(captures, {});
    assert.equal(recipes.length, 2);                       // one POST /events + one DELETE /events/{id}
    assert.ok(recipes.every((r) => r.method !== 'GET'));
    assert.ok(recipes.some((r) => r.safetyClass === 'destructive'));
  });
});

describe('fillWriteBody — the invoke-side inverse (round-trip)', () => {
  it('JSON: template then fill rebuilds the body, preserving constants + types', () => {
    const original = { summary: 'Lunch', start: { dateTime: '2026-07-01T12:00' }, type: 'event', guests: 4 };
    const recipe = recipeFromObservedWrite(
      { method: 'POST', url: 'https://x.test/events', contentType: 'application/json', body: JSON.stringify(original) },
      { demonstratedValues: ['Lunch', '2026-07-01T12:00', '4'] });
    const filled = fillWriteBody(recipe, { summary: 'Dinner', datetime: '2026-07-02T19:00', guests: 8 });
    assert.equal(filled.contentType, 'application/json');
    const obj = JSON.parse(filled.body);
    assert.equal(obj.summary, 'Dinner');
    assert.equal(obj.start.dateTime, '2026-07-02T19:00');
    assert.equal(obj.type, 'event');           // constant preserved through the round-trip
    assert.equal(obj.guests, 8);
    assert.equal(typeof obj.guests, 'number');  // whole-value placeholder keeps the typed value
  });

  it('an unbound placeholder is left intact (a missing required param stays visible, not blanked)', () => {
    const recipe = recipeFromObservedWrite(
      { method: 'POST', url: 'https://x.test/m', contentType: 'application/json', body: JSON.stringify({ text: 'hi' }) },
      { demonstratedValues: ['hi'] });
    assert.equal(JSON.parse(fillWriteBody(recipe, {}).body).text, '{text}');
  });

  it('form round-trip url-encodes the filled value', () => {
    const recipe = recipeFromObservedWrite(
      { method: 'POST', url: 'https://x.test/c', contentType: 'application/x-www-form-urlencoded', body: 'text=hello+world&p=1' },
      { demonstratedValues: ['hello world'] });
    const filled = fillWriteBody(recipe, { text: 'bye now' });
    assert.equal(filled.contentType, 'application/x-www-form-urlencoded');
    assert.match(filled.body, /text=bye(\+|%20)now/);
    assert.match(filled.body, /p=1/);          // constant preserved
  });

  it('a null body (e.g. DELETE) fills to null', () => {
    const recipe = recipeFromObservedWrite({ method: 'DELETE', url: 'https://x.test/e/5' });
    assert.equal(fillWriteBody(recipe, {}).body, null);
  });
});
