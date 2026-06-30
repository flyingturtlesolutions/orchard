// Core/recipeFromHarvest.test.js — §17: the crawl-as-generalizer (diff captures → {param} templating). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseUrl, pathKey, templatePath, templateQuery, isIdentityCall, recipesFromHarvest, isNoiseCapture } from './recipeFromHarvest.js';

describe('recipeFromHarvest — isNoiseCapture (v2.74.1300 recipe-worthiness)', () => {
  it('drops static asset GETs (JS bundles, fonts, images) + their cache-bust dups', () => {
    for (const u of ['https://mail.google.com/_/scs/mail-static/_/js/k=gmail.main.en.AbCdEf.js',
                     'https://x.test/assets/app.css', 'https://x.test/fonts/roboto.woff2',
                     'https://x.test/img/logo.png', 'https://x.test/m.js?cb=99']) {
      assert.equal(isNoiseCapture({ method: 'GET', url: u }), true, u);
    }
  });
  it('drops telemetry beacons (any method)', () => {
    assert.equal(isNoiseCapture({ method: 'GET', url: 'https://play.google.com/log/gen_204?v=3' }), true);
    assert.equal(isNoiseCapture({ method: 'POST', url: 'https://mail.google.com/_/jserror?id=1' }), true);
    assert.equal(isNoiseCapture({ method: 'GET', url: 'https://x.test/csi?foo=bar' }), true);
  });
  it('KEEPS real data operations (the signal)', () => {
    assert.equal(isNoiseCapture({ method: 'POST', url: 'https://mail.google.com/sync/u/0/i/send' }), false);
    assert.equal(isNoiseCapture({ method: 'GET', url: 'https://deakoapi.deako.com/v1/profile_list/email/x' }), false);
    assert.equal(isNoiseCapture({ method: 'GET', url: 'https://x.test/api/v2/tickets.json' }), false);   // .json is data, not an asset
  });
  it('recipesFromHarvest filters the noise out before templating', () => {
    const caps = [
      { method: 'GET', url: 'https://x.test/js/main.AbC.js' },     // asset → dropped
      { method: 'POST', url: 'https://x.test/_/jserror' },          // beacon → dropped
      { method: 'GET', url: 'https://x.test/api/items.json' },      // data → kept
    ];
    const { recipes } = recipesFromHarvest(caps, { appHost: 'x.test' });
    assert.equal(recipes.length, 1);
    assert.match(recipes[0].endpoint, /items\.json/);
  });
});

describe('recipeFromHarvest — parseUrl', () => {
  it('splits a relative + absolute url into path + ordered query', () => {
    assert.deepEqual(parseUrl('/api/v2/search.json?query=cats&per_page=25'),
      { path: '/api/v2/search.json', query: { query: 'cats', per_page: '25' } });
    assert.deepEqual(parseUrl('https://deako.zendesk.com/api/v2/tickets/64863.json'),
      { path: '/api/v2/tickets/64863.json', query: {} });
  });
});

describe('recipeFromHarvest — pathKey (grouping)', () => {
  it('id segments collapse to # so instances of one endpoint group together; a version like v2 stays', () => {
    assert.equal(pathKey('GET', '/api/v2/tickets/64863.json'), pathKey('GET', '/api/v2/tickets/64659.json'));
    assert.equal(pathKey('GET', '/api/v2/tickets/64863.json'), 'GET /api/v2/tickets/#');
    assert.notEqual(pathKey('GET', '/api/v2/tickets/64863.json'), pathKey('PUT', '/api/v2/tickets/64863.json'));   // method matters
  });
});

describe('recipeFromHarvest — templatePath (THE crawl-as-generalizer)', () => {
  it('diffs two instances → the id collapses to {id}, keeping the .json suffix', () => {
    assert.deepEqual(templatePath(['/api/v2/tickets/64863.json', '/api/v2/tickets/64659.json']),
      { endpoint: '/api/v2/tickets/{id}.json', params: [{ name: 'id', type: 'integer' }] });
  });
  it('a SINGLE capture still templates an id-like segment (heuristic)', () => {
    assert.deepEqual(templatePath(['/api/v2/tickets/64863.json']),
      { endpoint: '/api/v2/tickets/{id}.json', params: [{ name: 'id', type: 'integer' }] });
  });
  it('a single capture with NO id stays literal (no false param)', () => {
    assert.deepEqual(templatePath(['/api/v2/search.json']), { endpoint: '/api/v2/search.json', params: [] });
  });
  it('two ids in one path get distinct names', () => {
    assert.deepEqual(templatePath(['/orgs/12/tickets/34', '/orgs/56/tickets/78']),
      { endpoint: '/orgs/{id}/tickets/{id2}', params: [{ name: 'id', type: 'integer' }, { name: 'id2', type: 'integer' }] });
  });
  it('a varying NON-id segment (a slug) → a string param named by its collection', () => {
    assert.deepEqual(templatePath(['/blog/hello-world', '/blog/foo-bar']),
      { endpoint: '/blog/{blog}', params: [{ name: 'blog', type: 'string' }] });
  });
  it('mismatched segment counts → fall back to the literal (no unsafe diff)', () => {
    assert.deepEqual(templatePath(['/a/b/c', '/a/b']), { endpoint: '/a/b/c', params: [] });
  });
});

describe('recipeFromHarvest — templateQuery', () => {
  it('a varying value → a {param}; a constant value stays literal; keys keep first-seen order', () => {
    assert.deepEqual(templateQuery([{ query: 'cats', per_page: '25' }, { query: 'dogs', per_page: '25' }]),
      { query: 'query={query}&per_page=25', params: [{ name: 'query', type: 'string' }] });
  });
  it('all-numeric varying value → integer param', () => {
    assert.deepEqual(templateQuery([{ page: '1' }, { page: '2' }]),
      { query: 'page={page}', params: [{ name: 'page', type: 'integer' }] });
  });
});

describe('recipeFromHarvest — isIdentityCall', () => {
  it('the /me probe is identity; a ticket read is not; a non-GET /me is not', () => {
    assert.equal(isIdentityCall({ method: 'GET', url: '/api/v2/users/me.json' }), true);
    assert.equal(isIdentityCall({ method: 'GET', url: '/api/v2/account' }), true);
    assert.equal(isIdentityCall({ method: 'GET', url: '/api/v2/tickets/64863.json' }), false);
    assert.equal(isIdentityCall({ method: 'POST', url: '/api/v2/me' }), false);
  });
});

describe('recipeFromHarvest — recipesFromHarvest (end to end)', () => {
  const captures = [
    { method: 'GET', url: '/api/v2/users/me.json' },                       // identity → excluded
    { method: 'GET', url: '/api/v2/tickets/64863.json' },
    { method: 'GET', url: '/api/v2/tickets/64659.json' },
    { method: 'GET', url: '/api/v2/search.json?query=cats&type=ticket' },
    { method: 'PUT', url: '/api/v2/tickets/64863.json' },
    { method: 'DELETE', url: '/api/v2/tickets/64863.json' },
  ];

  it('groups + templates + classifies safety by method; excludes identity', () => {
    const { recipes, identityPath } = recipesFromHarvest(captures, { appHost: 'zendesk.com' });
    assert.equal(identityPath, '/api/v2/users/me.json');
    assert.equal(recipes.length, 4);                                       // read-ticket, search, write, delete (NOT identity)

    const read = recipes.find((r) => r.method === 'GET' && r.endpoint.includes('/tickets/{id}'));
    assert.equal(read.endpoint, '/api/v2/tickets/{id}.json');
    assert.equal(read.safetyClass, 'auto');                                // GET → auto
    assert.equal(read.provenance, 'harvested');
    assert.equal(read.reviewState, 'pending');                             // not armable until reviewed
    assert.deepEqual(read.params, [{ name: 'id', type: 'integer' }]);
    assert.equal(read.samples, 2);                                         // diffed two instances
    assert.equal(read.appHost, 'zendesk.com');

    assert.equal(recipes.find((r) => r.method === 'PUT').safetyClass, 'gated');         // write
    assert.equal(recipes.find((r) => r.method === 'DELETE').safetyClass, 'destructive'); // DELETE
  });

  it('ids are deterministic (re-harvest the same endpoint → same id, so mergeRecipes dedups)', () => {
    const a = recipesFromHarvest(captures).recipes.map((r) => r.id).sort();
    const b = recipesFromHarvest(captures).recipes.map((r) => r.id).sort();
    assert.deepEqual(a, b);
    assert.ok(a.every((id) => id.startsWith('harvest_')));
  });
});
