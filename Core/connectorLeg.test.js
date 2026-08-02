// Core/connectorLeg.test.js — CX-1 connector leg projection (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { recipeToLeg, mcpToolToLeg, hintToSafety, pruneSchema, connectorLegKey, missingRequiredParams, identifierClassParam, inventedIdentifierParams } from './connectorLeg.js';   // v1911 — the identifier-provenance gate
import { recipeLegs } from './connectorRecipes.js';   // v2.74.1864 — real projected legs for the leg-shape assertions
import { toOfferedLeg } from './palette.js';
import { CONNECTOR_RECIPES } from './connectorRecipes.js';   // v2.74.1854 — the pre-flight gate proves itself against the REAL catalog

describe('hintToSafety — hints may only RAISE caution (§9)', () => {
  it('destructive → gated (always, even alongside readOnly)', () => {
    assert.equal(hintToSafety({ destructiveHint: true }, true), 'gated');
    assert.equal(hintToSafety({ destructiveHint: true, readOnlyHint: true }, true), 'gated');
  });
  it('trusted read → auto; untrusted read → confirm (a self-claim cannot lower)', () => {
    assert.equal(hintToSafety({ readOnlyHint: true }, true), 'auto');
    assert.equal(hintToSafety({ readOnlyHint: true }, false), 'confirm');
  });
  it('no hints (treated as a write) → confirm floor', () => {
    assert.equal(hintToSafety({}, true), 'confirm');
    assert.equal(hintToSafety(undefined, false), 'confirm');
  });

  // PP-3 (v2.74.1661) — the OUTWARD axis. DESIGN_peritem_pipeline.md §4, narrowed by §9.4's suspicion, which the
  // source confirmed: `destructive` already means `!reversible` (Core/proposals.js renders a non-destructive
  // proposal as the literal word "reversible"), so only `outward` was genuinely missing.
  it('outward → gated: a message a real person receives is human-approved, even when it destroys nothing', () => {
    assert.equal(hintToSafety({ outward: true }, true), 'gated');
    assert.equal(hintToSafety({ outward: true, destructiveHint: false }, true), 'gated');
  });
  it('outward BEATS a readOnlyHint from a trusted source — the axis only ever raises', () => {
    assert.equal(hintToSafety({ outward: true, readOnlyHint: true }, true), 'gated');
  });
  it('REGRESSION GUARD: adding outward must not LOWER anything that is gated today', () => {
    // §4's literal `gate = outward || !reversible` would have un-gated every reversible internal write
    // (shopify_create_customer / create_order / add_tags / create_user) from today's 'confirm' floor, across
    // every existing surface, as a side effect of a per-item pipeline change. The axis is raise-only instead.
    assert.equal(hintToSafety({ outward: false }, true), 'confirm', 'a non-outward write keeps its confirm floor');
    assert.equal(hintToSafety({ outward: false, destructiveHint: true }, true), 'gated');
    assert.equal(hintToSafety({ readOnlyHint: true, outward: false }, true), 'auto', 'a vetted read still drops to auto');
  });
});

describe('pruneSchema — keep type/enum/required, drop verbosity (§12)', () => {
  it('v1317: format survives the prune (the binder must know a field wants ISO 8601)', () => {
    const out = pruneSchema({ type: 'object', properties: { startTime: { type: 'string', format: 'date-time', description: 'dropped' } }, required: [] });
    assert.deepEqual(out.properties.startTime, { type: 'string', format: 'date-time' });
  });
  it('reduces to the binding skeleton', () => {
    const out = pruneSchema({
      type: 'object',
      properties: { q: { type: 'string', description: 'long…' }, n: { type: 'integer' }, ch: { type: 'string', enum: ['a', 'b'] } },
      required: ['q'],
    });
    assert.equal(out.properties.q.type, 'string');
    assert.equal(out.properties.q.description, undefined);   // verbosity dropped
    assert.deepEqual(out.properties.ch.enum, ['a', 'b']);
    assert.deepEqual(out.required, ['q']);
  });
  it('tolerates junk without throwing', () => {
    assert.deepEqual(pruneSchema(null).properties, {});
    assert.deepEqual(pruneSchema(undefined).required, []);
  });
});

describe('recipeToLeg — session-ride recipe → client connector leg (§4)', () => {
  const recipe = {
    id: 'read_ticket', name: 'Read a Zendesk ticket', does: 'fetch one ticket by id',
    app: 'zendesk', origin: 'acme.zendesk.com', endpoint: '/api/v2/tickets/{id}.json',
    params: [{ name: 'id', type: 'integer', required: true }],
  };

  it('projects to a connector leg: impl=session, account-namespaced key, GET default', () => {
    const leg = recipeToLeg(recipe, { account: 'acme', trusted: true });
    assert.equal(leg.domain, 'connector');
    assert.equal(leg.source, 'builtin');
    assert.equal(leg.key, 'acme.zendesk.read_ticket@acme.zendesk.com');   // v1342 — origin suffix when recipe carries origin
    assert.equal(leg.tool.recipeId, 'read_ticket');      // v1340 (review A/§18) — the BARE id rides on the tool so the arm guard can match stored records
    assert.equal(leg.tool.impl, 'session');
    assert.equal(leg.tool.origin, 'acme.zendesk.com');
    assert.equal(leg.tool.endpoint, '/api/v2/tickets/{id}.json');
    assert.equal(leg.tool.method, 'GET');
    assert.equal(leg.mode, 'ask');                       // a read
    assert.equal(leg.safety, 'auto');                    // trusted read
    assert.deepEqual(leg.params, ['id']);
    // FL-1c/1d (v1347/1349) — the ground-truth HUMAN page templates thread recipe → tool (null when absent).
    assert.equal(leg.tool.itemUrl, null);
    assert.equal(leg.tool.listUrl, null);
    const withUrls = recipeToLeg({ ...recipe, itemUrl: '/agent/tickets/{id}', listUrl: '/agent/search/1?q={query}' }, { account: 'acme', trusted: true });
    assert.equal(withUrls.tool.itemUrl, '/agent/tickets/{id}');
    assert.equal(withUrls.tool.listUrl, '/agent/search/1?q={query}');
    assert.equal(leg.paramSchema.properties.id.type, 'integer');
    assert.deepEqual(leg.paramSchema.required, ['id']);
    // CX-9f (v1439) — a param `hint` threads into the schema (capped) so the interpret palette can render slot semantics.
    const withHint = recipeToLeg({ ...recipe, params: [{ name: 'id', type: 'integer', required: true, hint: 'the ticket number, digits only' }] }, { account: 'acme', trusted: true });
    assert.equal(withHint.paramSchema.properties.id.hint, 'the ticket number, digits only');
    assert.equal('hint' in leg.paramSchema.properties.id, false);   // no hint → no key (payload unchanged)
  });

  it('a write recipe → act mode + confirm (floors even when trusted); honors method', () => {
    const leg = recipeToLeg({ ...recipe, id: 'update_ticket', write: true, method: 'put' }, { account: 'acme', trusted: true });
    assert.equal(leg.mode, 'act');
    assert.equal(leg.safety, 'confirm');
    assert.equal(leg.tool.method, 'PUT');
  });

  it('an untrusted read still confirms (no self-lowering)', () => {
    assert.equal(recipeToLeg(recipe, { account: 'acme', trusted: false }).safety, 'confirm');
  });

  it('passes through palette.toOfferedLeg unchanged (already-normalized → identity)', () => {
    const leg = recipeToLeg(recipe, { account: 'acme', trusted: true });
    assert.equal(toOfferedLeg(leg), leg);
  });

  it('an appHost recipe (no origin) → leg with tool.appHost + verifyIdentity + identityProbe (§14)', () => {
    const leg = recipeToLeg({
      id: 'my_open_tickets', app: 'zendesk', name: 'My open tickets', appHost: 'zendesk.com',
      verifyIdentity: true, identityProbe: '/api/v2/users/me.json',
      endpoint: '/api/v2/search.json?query=assignee:{me}', method: 'GET', params: [],
    }, { account: 'me', trusted: true });
    assert.ok(leg);
    assert.equal(leg.tool.impl, 'session');
    assert.equal(leg.tool.appHost, 'zendesk.com');
    assert.equal(leg.tool.origin, null);
    assert.equal(leg.tool.verifyIdentity, true);
    assert.equal(leg.tool.identityProbe, '/api/v2/users/me.json');
  });

  it('rejects an incomplete recipe (no origin AND no appHost, or no endpoint)', () => {
    assert.equal(recipeToLeg({ id: 'x', app: 'zendesk' }, {}), null);                              // no endpoint, no host
    assert.equal(recipeToLeg({ id: 'x', app: 'zendesk', endpoint: '/y' }, {}), null);              // host missing
    assert.equal(recipeToLeg(null, {}), null);
  });
});

describe('connectorLegKey — host suffix (v1342)', () => {
  it('suffixes @host when set; bare key when not', () => {
    assert.equal(connectorLegKey({ account: 'me', app: 'zendesk', id: 'read_ticket' }), 'me.zendesk.read_ticket');
    assert.equal(connectorLegKey({ account: 'me', app: 'zendesk', id: 'read_ticket', host: 'a.zendesk.com' }), 'me.zendesk.read_ticket@a.zendesk.com');
  });
});

describe('mcpToolToLeg — MCP tool → cloud-broker connector leg (§5)', () => {
  const tool = {
    name: 'get_ticket', description: 'Get a ticket by id',
    inputSchema: { type: 'object', properties: { ticket_id: { type: 'integer', description: 'the id' } }, required: ['ticket_id'] },
    annotations: { readOnlyHint: true },
  };

  it('projects to impl=oauth, server-namespaced key, schema carried + pruned', () => {
    const leg = mcpToolToLeg(tool, { account: 'acme', server: 'zendesk', trusted: true });
    assert.equal(leg.domain, 'connector');
    assert.equal(leg.key, 'acme.zendesk.get_ticket');
    assert.equal(leg.tool.impl, 'oauth');
    assert.equal(leg.tool.server, 'zendesk');
    assert.equal(leg.mode, 'ask');
    assert.equal(leg.safety, 'auto');                    // trusted + readOnly
    assert.deepEqual(leg.params, ['ticket_id']);
    assert.equal(leg.paramSchema.properties.ticket_id.type, 'integer');
    assert.equal(leg.paramSchema.properties.ticket_id.description, undefined);
  });

  it('a tool with no readOnly hint defaults to act/confirm (safe)', () => {
    const leg = mcpToolToLeg({ name: 'post_comment', inputSchema: { properties: { body: { type: 'string' } } } }, { server: 'zendesk', trusted: true });
    assert.equal(leg.mode, 'act');
    assert.equal(leg.safety, 'confirm');
  });

  it('a destructive tool → gated even if trusted', () => {
    const leg = mcpToolToLeg({ name: 'delete_ticket', annotations: { destructiveHint: true } }, { server: 'zendesk', trusted: true });
    assert.equal(leg.safety, 'gated');
  });

  it('rejects without a server or a name', () => {
    assert.equal(mcpToolToLeg(tool, { trusted: true }), null);              // no server
    assert.equal(mcpToolToLeg({ description: 'x' }, { server: 'z' }), null); // no name
  });
});

describe('CX-9k (v2.74.1617) — displayId threads recipe → leg.tool (Invariant #3 hop 3)', () => {
  const BASE = { id: 'r1', app: 'vs', origin: 'vendorsuite.drhorton.com', endpoint: '/api/x', name: 'X' };
  it('array form filtered + capped at 4; string form wraps; all-empty / absent → null', () => {
    assert.deepEqual(recipeToLeg({ ...BASE, displayId: ['TicketId', '', 'TaskNumber'] }).tool.displayId, ['TicketId', 'TaskNumber']);
    assert.deepEqual(recipeToLeg({ ...BASE, displayId: 'TicketId' }).tool.displayId, ['TicketId']);
    assert.deepEqual(recipeToLeg({ ...BASE, displayId: ['a', 'b', 'c', 'd', 'e'] }).tool.displayId, ['a', 'b', 'c', 'd']);
    assert.equal(recipeToLeg({ ...BASE, displayId: [''] }).tool.displayId, null);
    assert.equal(recipeToLeg({ ...BASE }).tool.displayId, null);
  });
});

describe('PM (v2.74.1633) — joinKey threads recipe → leg.tool (Invariant #3 hop 3)', () => {
  const BASE = { id: 'r1', app: 'vs', origin: 'vendorsuite.drhorton.com', endpoint: '/api/x', name: 'X' };
  it('array filtered/capped; string wraps; absent → null', () => {
    assert.deepEqual(recipeToLeg({ ...BASE, joinKey: ['AddressLine1', '', 'ContactEmail'] }).tool.joinKey, ['AddressLine1', 'ContactEmail']);
    assert.deepEqual(recipeToLeg({ ...BASE, joinKey: 'AddressLine1' }).tool.joinKey, ['AddressLine1']);
    assert.equal(recipeToLeg({ ...BASE }).tool.joinKey, null);
  });
});

describe('v2.74.1854 — missingRequiredParams: the pre-flight gate reads the A-0a contract', () => {
  const TOOL = { params: [
    { name: 'query', required: true },
    { name: 'divisionId', required: false },
    { name: 'handle', required: true },
  ], urlParam: { name: 'handle' } };
  it('blank / whitespace / missing required → named; optional blanks stay legal (divisionId:"" = current)', () => {
    assert.deepEqual(missingRequiredParams(TOOL, { query: '', divisionId: '' }), ['query']);
    assert.deepEqual(missingRequiredParams(TOOL, { query: '   ' }), ['query']);
    assert.deepEqual(missingRequiredParams(TOOL, {}), ['query']);
    assert.deepEqual(missingRequiredParams(TOOL, { query: 'smart switch' }), []);
  });
  it('the urlParam slot is the EXECUTOR’s to fill from the ride tab — never reported missing', () => {
    assert.deepEqual(missingRequiredParams(TOOL, { query: 'x' }), []);   // `handle` absent yet not reported
  });
  it('strict `required === true` only: builtin string-array params and truthy non-boolean never fire', () => {
    assert.deepEqual(missingRequiredParams({ params: ['section', 'find'] }, {}), []);
    assert.deepEqual(missingRequiredParams({ params: [{ name: 'q', required: 'yes' }] }, {}), []);
  });
  it('0 and false are VALUES, not blanks; junk shapes → []', () => {
    assert.deepEqual(missingRequiredParams({ params: [{ name: 'n', required: true }] }, { n: 0 }), []);
    assert.deepEqual(missingRequiredParams({ params: [{ name: 'b', required: true }] }, { b: false }), []);
    assert.deepEqual(missingRequiredParams(null, null), []);
    assert.deepEqual(missingRequiredParams({}, undefined), []);
  });
  it('the live 205935 case against the REAL catalog: shopify_search_products query:"" → [query]', () => {
    const rec = CONNECTOR_RECIPES.find((r) => r && r.id === 'shopify_search_products');
    assert.ok(rec, 'recipe exists');
    assert.deepEqual(missingRequiredParams(rec, { query: '' }), ['query']);
    assert.deepEqual(missingRequiredParams(rec, { query: 'smart switch' }), []);
  });
});

// v2.74.1864 — the reader shipped at v1854 read only `tool.params`, which exists on a RECIPE and nowhere on a
// projected LEG — so both live callers (which pass a leg) got "nothing missing" for every connector leg it was
// meant to guard. Inert for ten versions; found only when the v1863 redirect's status seed silently did nothing.
describe('missingRequiredParams — reads a LEG as well as a recipe (v2.74.1864)', () => {
  const legOf = (id) => recipeLegs({ trusted: true }).find((l) => l && l.tool && l.tool.recipeId === id);
  it('THE INERT CASE: the v1854 shopify gate fires on a LEG now, exactly as it always did on a recipe', () => {
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_search_products');
    assert.deepEqual(missingRequiredParams(rec, { query: '' }), ['query'], 'recipe shape — worked all along');
    assert.deepEqual(missingRequiredParams(legOf('shopify_search_products'), { query: '' }), ['query'], 'leg shape — returned [] before this fix');
  });
  it('a resolver-backed param is never "missing" when blank — blank IS its declared value', () => {
    // divisionId is required:true AND carries a `resolve` spec whose defaultPath means "your current division".
    // Without this exemption, un-inerting the reader would have blocked the flagship ask with its own gate.
    assert.deepEqual(missingRequiredParams(legOf('vs_warranty_tasks'), { divisionId: '', status: 'open' }), []);
    assert.deepEqual(missingRequiredParams(legOf('vs_warranty_tasks'), { status: 'open' }), []);
  });
  it('a genuinely missing required param is still reported (the guard still guards)', () => {
    assert.deepEqual(missingRequiredParams(legOf('vs_warranty_tasks'), { address: '4886921' }), ['status']);
  });
  it('the urlParam slot stays excluded on a leg (the executor fills it from the ride tab)', () => {
    assert.deepEqual(missingRequiredParams(legOf('shopify_order'), { order: '69872' }), []);
  });
  it('junk in → [] out, from either shape', () => {
    for (const x of [null, undefined, 0, 'x', {}]) assert.deepEqual(missingRequiredParams(x, {}), []);
    assert.deepEqual(missingRequiredParams({ paramSchema: { required: ['a'] } }, { a: 'v' }), []);
    assert.deepEqual(missingRequiredParams({ paramSchema: { required: ['a'] } }, {}), ['a']);
  });
});

describe('v2.74.1925 — the machine-bind declaration survives HOP 3 (invariant #3\'s field-reader)', () => {
  // The v1922 first draft declared machineOnly/fromField on the catalog entry and read them off `leg.tool.params`
  // — which exists on NO projected leg, so the fill was inert end-to-end (the v1854/v1864 class). The declaration
  // now rides paramSchema, and this pins it against the REAL catalog entry, not a fixture.
  it('recipeToLeg carries machineOnly + fromField into paramSchema.properties', () => {
    const entry = CONNECTOR_RECIPES.find((e) => e && e.id === 'shopify_order_events');
    assert.ok(entry, 'the timeline entry is in the catalog');
    const leg = recipeToLeg(entry, { host: 'admin.shopify.com', groundId: 'g1' });
    const slot = leg.paramSchema && leg.paramSchema.properties && leg.paramSchema.properties.orderGid;
    assert.ok(slot, 'orderGid has a schema slot');
    assert.equal(slot.machineOnly, true, 'machineOnly survives projection');
    assert.equal(slot.fromField, 'id', 'fromField survives projection — this is what the fill reads');
  });
  it('v1926 — the creator leg reads the LAST page (the creation event is the OLDEST)', () => {
    const entry = CONNECTOR_RECIPES.find((e) => e && e.id === 'shopify_order_creator');
    assert.ok(entry, 'the creator leg is in the catalog');
    const vars = JSON.parse(decodeURIComponent(entry.endpoint.split('variables=')[1]).replace('{orderGid}', 'gid://shopify/Order/9'));
    assert.equal(vars.last, 3, 'a small TAIL — same-second ties and preamble events, selected by label not position');
    assert.equal(vars.first, null, 'a Relay connection takes one direction at a time');
    assert.equal(vars.id, 'gid://shopify/Order/9', 'the gid lands inside the JSON string');
    const events = CONNECTOR_RECIPES.find((e) => e && e.id === 'shopify_order_events');
    assert.equal(entry.persistedOp, events.persistedOp, 'same persisted op — the sha pins the DOCUMENT, not the variables');
    assert.doesNotMatch(events.does, /who creat/i, 'the recent-events leg must not promise the creator it can truncate away');
    assert.match(entry.does, /who creat/i);
  });
  it('v1928 — a STRUCTURED drill.also entry survives hop 3 (the silent-drop the review caught)', () => {
    // The previous projector did `.filter((x) => _str(x))`, which stringifies an object to '' — so a re-keying
    // sidecar worked on the CURATED path (hop 1 copies `drill` whole) and vanished on the SEEDED one. That is
    // invariant #3's "works curated, dies seeded" class, and this test is the reason it cannot come back.
    const entry = CONNECTOR_RECIPES.find((e) => e && e.id === 'shopify_orders_search');
    assert.ok(entry, 'the orders breadth leg is in the catalog');
    const leg = recipeToLeg(entry, { host: 'admin.shopify.com', groundId: 'g1' });
    const also = leg.tool.drill.also;
    assert.equal(also.length, 1);
    assert.equal(also[0].id, 'shopify_order_creator');
    assert.equal(also[0].from, 'id', 'the sidecar re-keys off the row gid, NOT the primary drill join (an order number 404s the timeline)');
    assert.equal(also[0].param, 'orderGid');
    assert.deepEqual(also[0].pick, { field: 'eventLabel', equals: 'order_placed' });
    assert.equal(also[0].extract[0].as, 'createdBy');
    assert.match(also[0].extract[0].pattern, /created this order/);
  });
  it('v1928 — a BARE-STRING also entry still projects (the shape that shipped for two months)', () => {
    const leg = recipeToLeg({ id: 'x', app: 'x', appHost: 'h.com', endpoint: '/a', params: [], drill: { via: 'v', param: 'p', from: 'f', also: ['sidecar_one', 'sidecar_two'] } }, { host: 'h.com', groundId: 'g' });
    assert.deepEqual(leg.tool.drill.also, [{ id: 'sidecar_one' }, { id: 'sidecar_two' }]);
  });
  it('v1928 — junk also entries drop, and the cap holds', () => {
    const leg = recipeToLeg({ id: 'x', app: 'x', appHost: 'h.com', endpoint: '/a', params: [], drill: { via: 'v', param: 'p', from: 'f', also: [null, {}, { from: 'a' }, 'ok', 'b', 'c', 'd', 'e'] } }, { host: 'h.com', groundId: 'g' });
    assert.ok(leg.tool.drill.also.every((a) => a && a.id), 'no id, no entry');
    assert.ok(leg.tool.drill.also.length <= 4);
  });
  it('v1928 — the orders breadth leg carries a free query slot and the row-gid join key', () => {
    const entry = CONNECTOR_RECIPES.find((e) => e && e.id === 'shopify_orders_search');
    const vars = JSON.parse(decodeURIComponent(entry.endpoint.split('variables=')[1]).replace('{query}', 'status:open'));
    assert.equal(vars.query, 'status:open', 'the filter lands inside the JSON string');
    assert.equal(vars.ordersFirst, 50);
    assert.equal(vars.sortKey, 'PROCESSED_AT');
    assert.equal(vars.reverse, true, 'newest first');
    assert.equal(vars.after, null, 'v1 does not paginate — the 50 is a bound the answer must name');
    const q = (entry.params || []).find((p) => p.name === 'query');
    assert.equal(q.required, false, 'blank is legal: the newest orders, unfiltered');
    // v2.74.1929 — REACHABILITY is the contract now, not just honesty. The v1928 wording ("there is NO filter
    // for who created an order") was true of the SITE and taught the router to refuse an ask the machinery could
    // already answer (live clarify, 21:41). The does must DECLARE the derived field so the capability is
    // nameable, AND keep the caveat as a cost rather than a refusal.
    assert.match(entry.does, /createdBy/, 'the derived field must be nameable — an unnameable capability is unbuilt');
    assert.match(entry.does, /no creator filter/i, 'the site limitation stays stated (it is why this is per-order)');
    assert.doesNotMatch(entry.does, /staff_member/i, 'and it must never suggest the invalid search field');
  });
  it('a plain param gains neither key (additive, no empty slots)', () => {
    const entry = CONNECTOR_RECIPES.find((e) => e && e.id === 'shopify_order');
    const leg = recipeToLeg(entry, { host: 'admin.shopify.com', groundId: 'g1' });
    const slot = leg.paramSchema.properties.order;
    assert.ok(slot && !('machineOnly' in slot) && !('fromField' in slot));
  });
});

describe('v2.74.1911 — inventedIdentifierParams: an identifier the conversation never contained is a fabrication', () => {
  const LEG = { domain: 'connector', tool: { recipeId: 'x', params: [{ name: 'sku', required: true }] } };
  it('the LIVE case: sku "DK-SW-02" absent from ask+turns → flagged', () => {
    const inv = inventedIdentifierParams(LEG, { sku: 'DK-SW-02' }, 'what is the sku of the smart switch gen 2?');
    assert.deepEqual(inv, [{ name: 'sku', value: 'DK-SW-02' }]);
  });
  it('a sku the ask names passes — case-insensitive', () => {
    assert.deepEqual(inventedIdentifierParams(LEG, { sku: 'DK-SW-02' }, 'find the product with sku dk-sw-02'), []);
  });
  it('alphanumeric-collapse: "DK SW 02" in the turns legitimizes "DK-SW-02"', () => {
    assert.deepEqual(inventedIdentifierParams(LEG, { sku: 'DK-SW-02' }, 'earlier reply: the code is DK SW 02'), []);
  });
  it('an order number quoted in a prior turn passes (the "get that order" case)', () => {
    const leg = { tool: { params: [{ name: 'order', required: false }] } };
    assert.deepEqual(inventedIdentifierParams(leg, { order: '71644' }, 'The most recent order (DEAKO#71644) is less than 1 hour old'), []);
    assert.deepEqual(inventedIdentifierParams(leg, { order: '99999' }, 'The most recent order (DEAKO#71644)'), [{ name: 'order', value: '99999' }]);
  });
  it('free-word params are NEVER gated — query is a legitimate paraphrase target', () => {
    const leg = { tool: { params: [{ name: 'query', required: true }] } };
    assert.deepEqual(inventedIdentifierParams(leg, { query: 'dimmer' }, 'do we sell any dimmers?'), []);
  });
  it('resolve-marked params are skipped (their fill layers are provenance-clean)', () => {
    const leg = { tool: { params: [{ name: 'divisionId', required: true }], resolve: { divisionId: { via: '/api/x' } } } };
    assert.deepEqual(inventedIdentifierParams(leg, { divisionId: '83' }, 'get open warranty tasks'), []);
  });
  it('the urlParam slot is skipped (executor-filled)', () => {
    const leg = { tool: { urlParam: { name: 'handle' }, params: [{ name: 'handle' }] } };
    assert.deepEqual(inventedIdentifierParams(leg, { handle: 'deako' }, 'search products'), []);
  });
  it('identifierClassParam draws the line by name shape', () => {
    for (const yes of ['sku', 'orderId', 'order_number', 'email', 'trackingNo', 'ticket']) assert.equal(identifierClassParam(yes), true, yes);
    for (const no of ['query', 'status', 'jobType', 'searchTerm', 'divisionName', 'section', 'notes']) assert.equal(identifierClassParam(no), false, no);
  });
  it('junk in → [] out', () => {
    for (const x of [null, undefined, 0, 'x']) assert.deepEqual(inventedIdentifierParams(x, { sku: 'A1' }, ''), []);
    assert.deepEqual(inventedIdentifierParams(LEG, null, 'x'), []);
    assert.deepEqual(inventedIdentifierParams(LEG, { sku: '' }, 'x'), [], 'blank is the required-gate’s case, not this one');
  });
  it('v1911-b: array-valued identifier params are judged per ELEMENT (the merge source_ids case)', () => {
    const leg = { tool: { params: [{ name: 'source_ids', required: true }] } };
    assert.deepEqual(inventedIdentifierParams(leg, { source_ids: [64776, 64777] }, 'merge tickets 64776 and 64777 into 64775'), []);
    assert.deepEqual(inventedIdentifierParams(leg, { source_ids: [64776, 99999] }, 'merge tickets 64776 and 64777'), [{ name: 'source_ids', value: '99999' }]);
  });
  it('v1911-b: E.164 normalization passes when the 10-digit national tail is in the hay', () => {
    const leg = { tool: { params: [{ name: 'phone', required: true }] } };
    assert.deepEqual(inventedIdentifierParams(leg, { phone: '+15551234567' }, 'find the customer at (555) 123-4567'), []);
    assert.deepEqual(inventedIdentifierParams(leg, { phone: '+15559999999' }, 'find the customer at (555) 123-4567'), [{ name: 'phone', value: '+15559999999' }]);
  });
  it('v1911-b: gid-suffixed params are identifier-class (customer_gid was ungated)', () => {
    assert.equal(identifierClassParam('customer_gid'), true);
    const leg = { tool: { params: [{ name: 'customer_gid', required: true }] } };
    assert.deepEqual(inventedIdentifierParams(leg, { customer_gid: 'gid://shopify/Customer/999' }, 'add a vip note to the customer'), [{ name: 'customer_gid', value: 'gid://shopify/Customer/999' }]);
    assert.deepEqual(inventedIdentifierParams(leg, { customer_gid: 'gid://shopify/Customer/999' }, 'update gid://shopify/Customer/999'), []);
  });
});
