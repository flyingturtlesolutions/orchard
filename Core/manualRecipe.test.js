// Core/manualRecipe.test.js — OV-5 (v2.74.1413): the manual ride-recipe validator + the compact spec parser.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildManualRecipe, parseLegSpec } from './manualRecipe.js';

describe('buildManualRecipe — validate + normalize', () => {
  it('a valid GET recipe → pending, manual, auto safety, low trust; params kept', () => {
    const { ok, recipe } = buildManualRecipe(
      { name: 'Read ticket', method: 'get', endpoint: '/api/v2/tickets/{id}.json', does: 'read a ticket', params: [{ name: 'id', required: true }] },
      { groundId: 'g1', origin: 'deako.zendesk.com' });
    assert.equal(ok, true);
    assert.equal(recipe.method, 'GET');
    assert.equal(recipe.safetyClass, 'auto');
    assert.equal(recipe.provenance, 'manual');
    assert.equal(recipe.reviewState, 'pending');    // unverified until tested
    assert.equal(recipe.trust, 0.5);
    assert.equal(recipe.groundId, 'g1');
    assert.equal(recipe.id, 'read_ticket');          // slugged from the name
    assert.deepEqual(recipe.params, [{ name: 'id', type: 'string', required: true }]);
  });

  it('a write derives gated; a destructive one derives destructive + flags it', () => {
    assert.equal(buildManualRecipe({ name: 'Create', method: 'POST', endpoint: '/api/x' }).recipe.safetyClass, 'gated');
    const del = buildManualRecipe({ name: 'Delete', method: 'DELETE', endpoint: '/api/x/{id}', destructive: true }).recipe;
    assert.equal(del.safetyClass, 'destructive');
    assert.equal(del.destructive, true);
  });

  it('rejects a missing name / bad method / a non-path endpoint', () => {
    assert.equal(buildManualRecipe({ method: 'GET', endpoint: '/x' }).ok, false);
    assert.equal(buildManualRecipe({ name: 'X', method: 'FETCH', endpoint: '/x' }).ok, false);
    const bad = buildManualRecipe({ name: 'X', method: 'GET', endpoint: 'api/x' });   // no leading /
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => /endpoint/.test(e)));
    assert.equal(bad.recipe, null);
  });
});

describe('parseLegSpec — the compact one-line spec', () => {
  it('parses "<Name> | <METHOD> <endpoint>" + lifts {placeholders} as required params', () => {
    const p = parseLegSpec('Read ticket | GET /api/v2/tickets/{id}.json');
    assert.equal(p.name, 'Read ticket');
    assert.equal(p.method, 'GET');
    assert.equal(p.endpoint, '/api/v2/tickets/{id}.json');
    assert.deepEqual(p.params, [{ name: 'id', required: true }]);
  });
  it('round-trips through buildManualRecipe', () => {
    const p = parseLegSpec('Order search | GET /api/orders?q={query}');
    const { ok, recipe } = buildManualRecipe(p, { origin: 'shop.example' });
    assert.equal(ok, true);
    assert.equal(recipe.params[0].name, 'query');
  });
  it('null on a malformed spec (no bar / no method)', () => {
    assert.equal(parseLegSpec('just a name'), null);
    assert.equal(parseLegSpec('Name | not a method'), null);
  });
});
