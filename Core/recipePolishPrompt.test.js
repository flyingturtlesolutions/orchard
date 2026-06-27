// Core/recipePolishPrompt.test.js — §17: the LLM polish prompt+parse+safe-merge for a harvested ride-recipe. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRecipePolishMessages, parseRecipePolishOutput, applyPolish } from './recipePolishPrompt.js';

describe('recipePolishPrompt — buildRecipePolishMessages (privacy: structure only)', () => {
  it('sends the templated endpoint + method + param types, and NO instance data', () => {
    const { system, user } = buildRecipePolishMessages({
      method: 'get', endpoint: '/api/v2/tickets/{id}.json', params: [{ name: 'id', type: 'integer' }], appHost: 'zendesk.com',
    });
    assert.ok(system.includes('JSON object'));
    assert.ok(user.includes('/api/v2/tickets/{id}.json'));
    assert.ok(user.includes('GET'));            // method upper-cased
    assert.ok(user.includes('zendesk.com'));
    assert.ok(!/\d{4,}/.test(user));            // no real ids leaked — they're already templated to {id}
  });
});

describe('recipePolishPrompt — parseRecipePolishOutput', () => {
  it('parses {name,does,params} even with prose around it', () => {
    const out = parseRecipePolishOutput('Sure!\n{"name":"Read a ticket","does":"Fetch one ticket by id.","params":["ticketId"]}\nDone.');
    assert.deepEqual(out, { name: 'Read a ticket', does: 'Fetch one ticket by id.', params: ['ticketId'] });
  });
  it('returns null on garbage / empty', () => {
    assert.equal(parseRecipePolishOutput('no json here'), null);
    assert.equal(parseRecipePolishOutput('{"name":"","does":"","params":[]}'), null);
  });
  it('caps name + does length', () => {
    const out = parseRecipePolishOutput(JSON.stringify({ name: 'x'.repeat(200), does: 'y'.repeat(500), params: [] }));
    assert.equal(out.name.length, 80);
    assert.equal(out.does.length, 200);
  });
});

describe('recipePolishPrompt — applyPolish (the SAFE relabel)', () => {
  const proto = {
    id: 'harvest_get__tickets__id_', name: 'GET /tickets/{id}.json', does: '', method: 'GET',
    endpoint: '/tickets/{id}.json', params: [{ name: 'id', type: 'integer' }],
    provenance: 'harvested', reviewState: 'pending', safetyClass: 'auto', trust: 0.3, enabled: true,
  };

  it('renames name + does, and renames the param keeping the endpoint placeholder in sync', () => {
    const out = applyPolish(proto, { name: 'Read a ticket', does: 'Fetch one ticket.', params: ['ticketId'] });
    assert.equal(out.name, 'Read a ticket');
    assert.equal(out.does, 'Fetch one ticket.');
    assert.deepEqual(out.params, [{ name: 'ticketId', type: 'integer' }]);
    assert.equal(out.endpoint, '/tickets/{ticketId}.json');           // placeholder followed the rename
  });

  it('NEVER changes method / safetyClass / provenance / reviewState / id (even if the polish carries them)', () => {
    const out = applyPolish(proto, { name: 'X', does: 'Y', params: ['a'], method: 'DELETE', safetyClass: 'auto', provenance: 'curated', reviewState: 'accepted', id: 'evil' });
    assert.equal(out.method, 'GET');
    assert.equal(out.safetyClass, 'auto');
    assert.equal(out.provenance, 'harvested');
    assert.equal(out.reviewState, 'pending');
    assert.equal(out.id, 'harvest_get__tickets__id_');
  });

  it('param count mismatch → params/endpoint untouched, but name + does still applied', () => {
    const out = applyPolish(proto, { name: 'Read a ticket', does: 'Fetch.', params: ['a', 'b'] });
    assert.equal(out.name, 'Read a ticket');
    assert.deepEqual(out.params, [{ name: 'id', type: 'integer' }]);   // unchanged
    assert.equal(out.endpoint, '/tickets/{id}.json');
  });

  it('collision-safe: a new name equal to ANOTHER param old name does not double-apply', () => {
    const two = { ...proto, endpoint: '/orgs/{id}/tickets/{id2}', params: [{ name: 'id', type: 'integer' }, { name: 'id2', type: 'integer' }] };
    const out = applyPolish(two, { params: ['id2', 'foo'] });          // {id}→{id2}, {id2}→{foo}, single-pass
    assert.equal(out.endpoint, '/orgs/{id2}/tickets/{foo}');
    assert.deepEqual(out.params, [{ name: 'id2', type: 'integer' }, { name: 'foo', type: 'integer' }]);
  });

  it('an invalid identifier (no leading letter) → rename skipped, name/does still applied', () => {
    const out = applyPolish(proto, { name: 'Read', does: '', params: ['123bad'] });
    assert.equal(out.name, 'Read');
    assert.deepEqual(out.params, [{ name: 'id', type: 'integer' }]);   // unchanged
    assert.equal(out.endpoint, '/tickets/{id}.json');
  });

  it('null / empty polish → recipe unchanged', () => {
    assert.deepEqual(applyPolish(proto, null), proto);
    assert.deepEqual(applyPolish(proto, {}), proto);
  });
});
