// Core/recipeFromHarvest.test.js — §17: the crawl-as-generalizer (diff captures → {param} templating). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseUrl, pathKey, templatePath, templateQuery, isIdentityCall, recipesFromHarvest, isNoiseCapture, sanitizeCaptureHeaders, templateHeaders, pathAligns, scoreCandidateShape, matchCaptureToRecipe, healedShapeFor, recipeHealDiff, healProposalsFromCaptures } from './recipeFromHarvest.js';

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

  it('v1304: forage banks READS only — a harvested write (non-GET) is not banked (body-blind stub)', () => {
    const { recipes } = recipesFromHarvest([
      { method: 'POST', url: 'https://x.test/calendar/hello' },     // write → dropped (body-blind stub)
      { method: 'GET', url: 'https://x.test/api/items.json' },       // read → kept
    ], { appHost: 'x.test' });
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0].method, 'GET');
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

  it('v1304: forage banks READS ONLY — templates + excludes identity; body-blind writes (PUT/DELETE) are not harvested', () => {
    const { recipes, identityPath } = recipesFromHarvest(captures, { appHost: 'zendesk.com' });
    assert.equal(identityPath, '/api/v2/users/me.json');
    assert.equal(recipes.length, 2);                                       // read-ticket + search only (NOT identity, NOT the PUT/DELETE writes)

    const read = recipes.find((r) => r.method === 'GET' && r.endpoint.includes('/tickets/{id}'));
    assert.equal(read.endpoint, '/api/v2/tickets/{id}.json');
    assert.equal(read.safetyClass, 'auto');                                // GET → auto
    assert.equal(read.provenance, 'harvested');
    assert.equal(read.reviewState, 'pending');                             // not armable until reviewed
    assert.deepEqual(read.params, [{ name: 'id', type: 'integer' }]);
    assert.equal(read.samples, 2);                                         // diffed two instances
    assert.equal(read.appHost, 'zendesk.com');

    // forage is body-blind → a harvested PUT/DELETE is a hollow stub; writes come from demonstrate-once (body-aware, HITL).
    assert.ok(recipes.every((r) => r.method === 'GET'), 'no PUT/DELETE write recipes are foraged');
  });

  it('ids are deterministic (re-harvest the same endpoint → same id, so mergeRecipes dedups)', () => {
    const a = recipesFromHarvest(captures).recipes.map((r) => r.id).sort();
    const b = recipesFromHarvest(captures).recipes.map((r) => r.id).sort();
    assert.deepEqual(a, b);
    assert.ok(a.every((id) => id.startsWith('harvest_')));
  });
});

describe('RH-0b (v2.74.1565) — captured header shape banks onto the recipe (capture fidelity, DESIGN_route_heal.md §2)', () => {
  it('sanitizeCaptureHeaders: the CREDENTIAL class + mechanical framing never bank (defense in depth — the tee already stripped)', () => {
    const s = sanitizeCaptureHeaders({
      Cookie: 'sid=1', Authorization: 'Bearer x', 'X-CSRF-Token': 'z', 'x-session-id': 's', 'x-api-key': 'k', 'X-Auth': 'q',
      'Content-Length': '12', Host: 'x.test', 'Content-Type': 'application/json',
      'Apollographql-Client-Name': 'core', 'x-requested-with': 'XMLHttpRequest', Accept: 'application/vnd.api+json',
    });
    assert.deepEqual(s, { 'apollographql-client-name': 'core', 'x-requested-with': 'XMLHttpRequest', accept: 'application/vnd.api+json' });
    assert.equal(sanitizeCaptureHeaders(null), null);
  });
  it('templateHeaders: only a header CONSTANT across every capture banks; varying values + dynamic-name ids drop', () => {
    assert.deepEqual(templateHeaders([
      { 'x-app': 'core', 'x-request-id': 'aaa', 'x-nonce-thing': '1', 'x-flavor': 'blue' },
      { 'x-app': 'core', 'x-request-id': 'bbb', 'x-nonce-thing': '1', 'x-flavor': 'red' },
    ]), { 'x-app': 'core' });   // request-id varies AND is dyn-class; nonce is dyn-class even though static; flavor varies
    assert.deepEqual(templateHeaders([{ 'x-trace-id': 'same' }, { 'x-trace-id': 'same' }]), {}, 'a dynamic-NAME header never banks even when it looks static');
  });
  it('templateHeaders: a capture with NO app-set headers vetoes the group (sometimes-sent ≠ part of the route)', () => {
    assert.deepEqual(templateHeaders([{ 'x-app': 'core' }, undefined]), {});
    assert.deepEqual(templateHeaders([]), {});
  });
  it('recipesFromHarvest: the static shape rides the banked recipe as requestHeaders; header-free groups stay byte-identical (no empty key)', () => {
    const { recipes } = recipesFromHarvest([
      { method: 'GET', url: 'https://api.x.test/v1/things/11', h: { 'x-app-platform': 'web', authorization: 'Bearer leak?' } },
      { method: 'GET', url: 'https://api.x.test/v1/things/22', h: { 'x-app-platform': 'web', authorization: 'Bearer other' } },
      { method: 'GET', url: 'https://api.x.test/v1/plain.json' },
    ], { appHost: 'x.test' });
    const withH = recipes.find((r) => r.endpoint.includes('/things/'));
    assert.deepEqual(withH.requestHeaders, { 'x-app-platform': 'web' }, 'the static app header banks; the credential strips');
    assert.ok(!JSON.stringify(recipes).includes('Bearer'), 'a credential value never reaches a banked record');
    const plain = recipes.find((r) => r.endpoint.includes('plain'));
    assert.ok(!('requestHeaders' in plain), 'no app-set headers → no requestHeaders key');
  });
});

describe('RH-1c (v2.74.1567) — match captures to drift-suspect recipes, propose the five-second heal (DESIGN_route_heal.md §3.4-5)', () => {
  // The MOTIVATING live class (the Shopify 404): path held, the BFF grew ?operation&type routing + two headers.
  // {handle} is a store SLUG — no digit run, so a capture never templates it: recipe-as-pattern alignment covers it.
  const SH = {
    id: 'shopify_customer_by_email', method: 'POST', gql: true, provenance: 'curated', driftSuspect: true,
    endpoint: '/api/shopify/{handle}',
    body: { operationName: 'Customers', query: 'query Customers($q: String!, $n: Int!) { customers(first: $n, query: $q) { edges { node { id } } } }' },
    params: [{ name: 'email', type: 'string', required: true }],
  };
  const SH_CAPS = [
    { method: 'POST', url: 'https://admin.shopify.com/api/shopify/store-a?operation=Customers&type=query', h: { 'apollographql-client-name': 'core', 'shopify-proxy-api-enable': 'true' } },
    { method: 'POST', url: 'https://admin.shopify.com/api/shopify/store-a?operation=Customers&type=query', h: { 'apollographql-client-name': 'core', 'shopify-proxy-api-enable': 'true' } },
  ];
  it('pathAligns: the recipe template is the PATTERN — a param slot matches a literal store slug; length/static mismatches do not align', () => {
    assert.equal(pathAligns('/api/shopify/{handle}', '/api/shopify/store-a'), true);
    assert.equal(pathAligns('/api/Vendor/Warranty/Tasks/{divisionId}/{status}', '/api/Vendor/Warranty/Tasks/8123/open'), true);
    assert.equal(pathAligns('/api/shopify/{handle}', '/api/shopify/store-a/extra'), false);
    assert.equal(pathAligns('/api/a/{x}', '/api/b/{x}'), false);
  });
  it('the live Shopify class end-to-end: proposal keeps OUR path template, gains the query routing + both headers; diff is readable; the gql read heals despite POST', () => {
    const props = healProposalsFromCaptures(SH_CAPS, [SH], { now: 7 });
    assert.equal(props.length, 1);
    assert.equal(props[0].recipeId, 'shopify_customer_by_email');
    const p = props[0].proposal;
    assert.equal(p.endpoint, '/api/shopify/{handle}?operation=Customers&type=query', 'OUR {handle} survives — the recipe knew its own shape');
    assert.deepEqual(p.requestHeaders, { 'apollographql-client-name': 'core', 'shopify-proxy-api-enable': 'true' });
    assert.ok(!p.addParams, 'no phantom handle param — pre-existing placeholders keep their existing fill (urlParam)');
    assert.ok(p.diff.some((l) => l.startsWith('path: ')) && p.diff.some((l) => l.startsWith('+ header apollographql-client-name')), `diff readable: ${p.diff.join(' | ')}`);
    assert.equal(p.at, 7);
    assert.equal(p.samples, 2);
  });
  it('header-only drift: same endpoint, a new required header → header-only proposal (no endpoint key)', () => {
    const r = { id: 'ac_calls', method: 'GET', provenance: 'curated', driftSuspect: true, endpoint: '/v3/calls?per_page=25', params: [] };
    const caps = [
      { method: 'GET', url: 'https://api.ac.test/v3/calls?per_page=25', h: { 'aircall-platform': 'web' } },
      { method: 'GET', url: 'https://api.ac.test/v3/calls?per_page=25', h: { 'aircall-platform': 'web' } },
    ];
    const props = healProposalsFromCaptures(caps, [r], { now: 1 });
    assert.equal(props.length, 1);
    assert.ok(!props[0].proposal.endpoint, 'endpoint unchanged → not in the proposal');
    assert.deepEqual(props[0].proposal.requestHeaders, { 'aircall-platform': 'web' });
  });
  it('the /v2-prefix class: param counts match → rebase onto the drifted skeleton with OUR param name', () => {
    const r = { id: 'z_ticket', method: 'GET', provenance: 'curated', driftSuspect: true, endpoint: '/api/tickets/{ticketId}.json', params: [{ name: 'ticketId', type: 'integer', required: true, hint: 'curated hint survives' }] };
    const caps = [
      { method: 'GET', url: 'https://z.test/api/v2/tickets/64863.json' },
      { method: 'GET', url: 'https://z.test/api/v2/tickets/64659.json' },
    ];
    const props = healProposalsFromCaptures(caps, [r], { now: 1 });
    assert.equal(props.length, 1);
    assert.equal(props[0].proposal.endpoint, '/api/v2/tickets/{ticketId}.json', 'the drifted skeleton, OUR param name');
    assert.ok(!props[0].proposal.addParams, 'ticketId already spec’d — curated specs never replaced');
  });
  it('hard lines: a WRITE recipe never gets a proposal; a non-suspect recipe never gets one; an unmatched action proposes nothing', () => {
    const w = { id: 'w', method: 'POST', write: true, provenance: 'curated', driftSuspect: true, endpoint: '/api/things', params: [] };
    assert.deepEqual(healProposalsFromCaptures([{ method: 'POST', url: 'https://x.test/api/things' }], [w]), [], 'writes go through full re-review, never a one-click heal');
    const fresh = { ...SH, driftSuspect: false };
    assert.deepEqual(healProposalsFromCaptures(SH_CAPS, [fresh]), [], 'no suspicion → no proposal');
    const far = { id: 'far', method: 'GET', provenance: 'curated', driftSuspect: true, endpoint: '/totally/other/Resource/{id}', params: [] };
    assert.deepEqual(healProposalsFromCaptures([{ method: 'GET', url: 'https://x.test/api/unrelated.json' }], [far]), [], 'a weak match never proposes');
  });
  it('matchCaptureToRecipe (single-capture face) + scoreCandidateShape agree with the batch verdicts', () => {
    assert.ok(matchCaptureToRecipe(SH_CAPS[0], SH) >= 5, 'the live class scores past the floor');
    assert.equal(matchCaptureToRecipe({ method: 'GET', url: 'https://x.test/api/unrelated.json' }, SH), 0, 'method mismatch → 0');
    assert.ok(scoreCandidateShape({ method: 'POST', endpoint: '/api/shopify/{handle}?operation=Customers&type=query' }, SH)
      > scoreCandidateShape({ method: 'POST', endpoint: '/api/other/{x}?operation=Orders&type=query' }, SH), 'the right shape outscores a wrong one');
  });
  it('recipeHealDiff renders template-level lines only', () => {
    const d = recipeHealDiff({ endpoint: '/a/{id}', requestHeaders: { 'x-old': '1' } }, { endpoint: '/b/{id}', requestHeaders: { 'x-new': '2' }, addParams: [{ name: 'q' }] });
    assert.deepEqual(d, ['path: /a/{id} → /b/{id}', '+ header x-new: 2', '− header x-old', '+ param q']);
  });
  it('healedShapeFor: identical shape (nothing drifted) → null (no busywork proposal)', () => {
    assert.equal(healedShapeFor({ method: 'GET', endpoint: '/v3/calls' }, { method: 'GET', endpoint: '/v3/calls', params: [] }), null);
  });
});
