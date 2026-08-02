// Core/synthEntity.test.js — the entity layer the synthetic legs generate from (v2.74.1877). node --test.
// Asserted against the REAL catalog, not fixtures: the whole claim is that the entity graph already exists in it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { entitiesFrom, entityFor, coverageOf, findReadiness, findLegDescriptor, COVERAGE, DOES_BUDGET } from './synthEntity.js';
import { CONNECTOR_RECIPES } from './connectorRecipes.js';

const ENTITIES = entitiesFrom(CONNECTOR_RECIPES);

describe('synthEntity — the entity graph is already in the catalog', () => {
  it('groups by drill.via, so the live catalog yields a handful of entities from 60 recipes', () => {
    assert.ok(ENTITIES.length >= 2 && ENTITIES.length <= 8, `got ${ENTITIES.length}`);
    assert.ok(ENTITIES.some((e) => e.key === 'vs_warranty_task'));
  });
  it('ENTITY ≠ RECIPE: Zendesk’s several ticket views collapse to ONE entity', () => {
    // my_open_tickets / my_pending_tickets / all_open_tickets / unassigned_tickets / tickets_last_day all carry
    // drill:{via:'ticket_comments'} — five ACCESS PATHS, not five entities. Keying a generator on recipes would
    // emit five near-identical find legs and hand the router the job of telling them apart.
    const zd = ENTITIES.find((e) => e.key === 'ticket_comments');
    assert.ok(zd, 'the ticket entity exists');
    assert.ok(zd.paths.length >= 3, `expected several access paths, got ${zd.paths.length}`);
  });
  it('a richly-declared access path is not diluted by a bare sibling', () => {
    const vs = entityFor('vs_warranty_tasks', CONNECTOR_RECIPES);
    assert.equal(vs.matchOn, 'address');
    assert.equal(vs.joinFrom, 'TaskId');
    assert.equal(vs.joinParam, 'taskId');
    assert.ok(vs.labels.includes('TicketId') && vs.labels.includes('AddressLine1'));
    assert.ok(vs.children.includes('vs_task_contacts'), 'drill.also → children');
  });
  it('the scan axes come off resolve(each) + a param enum', () => {
    const vs = entityFor('vs_warranty_tasks', CONNECTOR_RECIPES);
    const names = vs.path.axes.map((a) => a.name);
    assert.ok(names.includes('divisionId'), names.join(','));
    assert.ok(names.includes('status'), names.join(','));
  });
  it('an id outside the graph resolves to nothing rather than guessing', () => {
    assert.equal(entityFor('vs_state', CONNECTOR_RECIPES), null);
    assert.equal(entityFor('', CONNECTOR_RECIPES), null);
  });
});

describe('synthEntity — coverage, the declaration that keeps the family honest', () => {
  it('VendorSuite’s (division × status) is declared a PARTITION — every task in exactly one cell', () => {
    assert.equal(coverageOf('vs_warranty_tasks', CONNECTOR_RECIPES), COVERAGE.PARTITION);
  });
  it('Shopify’s "open unfulfilled orders" is a SELECTION — a scan of it settles nothing about the rest', () => {
    assert.equal(coverageOf('shopify_orders_queue', CONNECTOR_RECIPES), COVERAGE.SELECTION);
  });
  it('FAIL-SAFE: undeclared, unknown and harvested all resolve to selection', () => {
    assert.equal(coverageOf('my_open_tickets', CONNECTOR_RECIPES), COVERAGE.SELECTION);
    assert.equal(coverageOf('not_a_recipe_at_all', CONNECTOR_RECIPES), COVERAGE.SELECTION);
    assert.equal(coverageOf('', CONNECTOR_RECIPES), COVERAGE.SELECTION);
  });
  it('only the exact literal counts as a partition — a typo cannot promote a selection', () => {
    const fake = [{ id: 'x', drill: { via: 'y', matchOn: 'q', from: 'Id', label: ['a'] }, coverage: 'Partition' }];
    assert.equal(coverageOf('x', fake), COVERAGE.SELECTION);
  });
});

describe('synthEntity — readiness: generation makes it visible, it cannot create it', () => {
  it('VendorSuite’s warranty task is ready', () => {
    const r = findReadiness(entityFor('vs_warranty_tasks', CONNECTOR_RECIPES));
    assert.deepEqual(r.missing, []);
    assert.equal(r.ready, true);
  });
  it('Zendesk’s ticket entity is NOT — its drill carries only `via`', () => {
    const r = findReadiness(ENTITIES.find((e) => e.key === 'ticket_comments'));
    assert.equal(r.ready, false);
    assert.ok(r.missing.some((m) => m.includes('matchOn')));
    assert.ok(r.missing.some((m) => m.includes('label')));
    assert.ok(r.missing.some((m) => m.includes('coverage')));
  });
  it('Shopify’s order has a full drill but no axis to scan — a different shape, not a worse one', () => {
    const r = findReadiness(ENTITIES.find((e) => e.key === 'shopify_order'));
    assert.equal(r.ready, false);
    assert.ok(r.missing.some((m) => m.includes('axis')), r.missing.join(' | '));
    assert.ok(!r.missing.some((m) => m.includes('matchOn')), 'its matchOn IS declared');
  });
});

describe('synthEntity — the generated descriptor', () => {
  const d = findLegDescriptor(entityFor('vs_warranty_tasks', CONNECTOR_RECIPES), { noun: 'warranty task' });
  it('describes the leg the executor consumes', () => {
    assert.equal(d.id, 'vs_warranty_tasks__find');
    assert.equal(d.synthetic, 'find');
    assert.equal(d.over, 'vs_warranty_tasks');
    assert.equal(d.detailId, 'vs_warranty_task');
    assert.equal(d.coverage, COVERAGE.PARTITION);
  });
  it('DECLARES ITS PARAMS — reachability comes from the schema (the v1876 lesson)', () => {
    const names = d.params.map((p) => p.name);
    assert.equal(names[0], 'q', 'the query slot must exist, or the router has nothing to bind to');
    assert.ok(names.includes('divisionId') && names.includes('status'), 'each axis is optionally pinnable');
    assert.ok(d.params[0].required, 'q is required — a find with no query is not a find');
  });
  it('FITS THE DOES BUDGET — the v1861 defect was a clause the router never saw', () => {
    assert.ok(d.does.length <= DOES_BUDGET, `${d.does.length} > ${DOES_BUDGET}: "${d.does}"`);
    assert.ok(d.does.length > 20, 'and it must actually say something');
  });
  it('returns null for an unready entity rather than a leg that cannot work', () => {
    assert.equal(findLegDescriptor(ENTITIES.find((e) => e.key === 'ticket_comments')), null);
    assert.equal(findLegDescriptor(ENTITIES.find((e) => e.key === 'shopify_order')), null);
    assert.equal(findLegDescriptor(null), null);
  });
});

describe('v2.74.1930 — `children` is a list of RECIPE IDS whichever form the catalog declares', () => {
  // v1928 made a `drill.also` entry either a bare id or a re-keying object ({id, from, param, pick, extract}).
  // entitiesFrom pushed the raw entry, so an object landed in `children` where consumers expect a string AND
  // `includes` could never dedupe it (object identity). Found by auditing the new Shopify sidecar against the
  // VendorSuite synthetic-leg contract rather than by a failure — the regression was latent.
  it('an OBJECT also-entry contributes its id, not the object', () => {
    const [e] = entitiesFrom([{ id: 'list', drill: { via: 'detail', param: 'p', from: 'f', also: [{ id: 'sidecar', from: 'id', param: 'gid' }] } }]);
    assert.deepEqual(e.children, ['sidecar']);
  });
  it('bare strings still work, and the two forms dedupe against each other', () => {
    const [e] = entitiesFrom([
      { id: 'a', drill: { via: 'detail', param: 'p', from: 'f', also: ['sidecar'] } },
      { id: 'b', drill: { via: 'detail', param: 'p', from: 'f', also: [{ id: 'sidecar' }, 'other'] } },
    ]);
    assert.deepEqual(e.children, ['sidecar', 'other'], 'one entity, one child list, no duplicate from the other form');
  });
  it('junk entries contribute nothing', () => {
    const [e] = entitiesFrom([{ id: 'a', drill: { via: 'detail', param: 'p', from: 'f', also: [null, {}, { from: 'x' }, ''] } }]);
    assert.deepEqual(e.children, []);
  });
});
