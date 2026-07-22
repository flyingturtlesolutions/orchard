// Core/groundFacts.test.js — substrate facts for the decomposer (v2.74.1672).
//
// The fixture is the REAL shape of the recipes involved in the live failure: a warranty-task list with a
// declared drill, three Shopify customer-lookup legs, and a create. If this derivation is right, the missing
// "read the instructions on each one" step becomes forced rather than hoped for.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveGroundFacts, renderGroundFacts, hasGroundFacts } from './groundFacts.js';

const RECIPES = [
  { id: 'vs_warranty_tasks', name: 'Warranty tasks by status', origin: 'vendorsuite.drhorton.com', listUrl: '/#warranty',
    drill: { via: 'vs_warranty_task', param: 'taskId', from: 'TaskId' },
    joinKey: ['AddressLine1', 'CityStateZip'] },
  { id: 'vs_warranty_task', name: 'Warranty task details', origin: 'vendorsuite.drhorton.com', itemUrl: '/#warranty' },
  { id: 'shopify_customer_by_email', name: 'Find a Shopify customer by email', origin: 'admin.shopify.com' },
  { id: 'shopify_customer_by_phone', name: 'Find a Shopify customer by phone', origin: 'admin.shopify.com' },
  { id: 'shopify_customer_search', name: 'Find a Shopify customer by name', origin: 'admin.shopify.com' },
  { id: 'shopify_create_customer', name: 'Create a Shopify customer', origin: 'admin.shopify.com', write: true },
];

describe('groundFacts — derivation from the catalog', () => {
  it('THE FACT THE 4-STEP PLAN WAS MISSING: the task list carries a per-item drill', () => {
    const f = deriveGroundFacts(RECIPES);
    const tasks = f.lists.find((l) => /Warranty tasks/.test(l.what));
    assert.ok(tasks, 'the list leg must be recognized as a list');
    assert.equal(tasks.hasDrill, true, 'this is what forces "read X per item" to be its own step');
  });

  it('groups the three customer lookups into ONE ladder, not three steps', () => {
    const f = deriveGroundFacts(RECIPES);
    const cust = f.lookups.find((l) => /customer/.test(l.noun));
    assert.ok(cust);
    assert.equal(cust.ladder, true);
    assert.deepEqual(cust.keys.sort(), ['email', 'name', 'phone']);
  });

  it('carries the declared join key, so the model does not invent a matching field', () => {
    const f = deriveGroundFacts(RECIPES);
    assert.deepEqual(f.lists.find((l) => /Warranty tasks/.test(l.what)).joinsOn, ['AddressLine1', 'CityStateZip']);
  });

  it('separates writes from reads', () => {
    const f = deriveGroundFacts(RECIPES);
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].what, /Create a Shopify customer/);
    assert.ok(!f.lookups.some((l) => /create/i.test(l.noun)));
  });

  it('skips disabled and rejected recipes', () => {
    const f = deriveGroundFacts([...RECIPES, { id: 'x', name: 'Disabled thing', origin: 'a.com', write: true, enabled: false },
      { id: 'y', name: 'Rejected thing', origin: 'a.com', write: true, reviewState: 'rejected' }]);
    assert.equal(f.writes.length, 1);
  });

  it('degenerate input does not throw', () => {
    for (const bad of [null, undefined, [], [null], [{}], 'nope']) assert.doesNotThrow(() => deriveGroundFacts(bad));
    assert.deepEqual(deriveGroundFacts(null).lists, []);
  });
});

describe('groundFacts — the rendered block', () => {
  const block = renderGroundFacts(deriveGroundFacts(RECIPES));

  it('states the drill as a SPLITTING CONSEQUENCE, not as a catalog dump', () => {
    assert.match(block, /one item at a time/);
    assert.match(block, /ALWAYS its own step/);
    assert.match(block, /A filter cannot read\s*\n?\s*a field the list step never fetched/,
      'this sentence is what makes the missing step forced');
  });

  it('tells the model a cross-system lookup is ONE step, not one per key', () => {
    assert.match(block, /several keys in turn \(that is one step, not one per key\)/);
    assert.match(block, /by email, then phone, then name|by .*email.*phone.*name/);
  });

  it('names the join key so a matching field is never invented', () => {
    assert.match(block, /AddressLine1/);
    assert.match(block, /do not invent a/);
  });

  it('marks writes as their own final step', () => {
    assert.match(block, /never bundled with the lookup/);
    assert.match(block, /Create a Shopify customer/);
  });

  it('NEVER LEAKS LEG IDS — the prompt forbids the model naming them', () => {
    // The role separation is "you do NOT pick legs or write parameters". Handing over recipeIds would invite
    // exactly the naming it forbids, so the block is human terms only.
    for (const id of ['vs_warranty_tasks', 'vs_warranty_task', 'shopify_customer_by_email', 'shopify_create_customer', 'taskId']) {
      assert.ok(!block.includes(id), `leaked a leg id: ${id}`);
    }
    assert.ok(!/\/#warranty|itemUrl|listUrl/.test(block), 'leaked an endpoint template');
  });

  it('an empty ground renders nothing rather than an empty heading', () => {
    assert.equal(renderGroundFacts(deriveGroundFacts([])), '');
    assert.equal(hasGroundFacts(deriveGroundFacts([])), false);
    assert.equal(hasGroundFacts(deriveGroundFacts(RECIPES)), true);
  });

  it('a list WITHOUT a drill contributes no drill rule', () => {
    const f = deriveGroundFacts([{ id: 'flat', name: 'Flat list', origin: 'a.com', listUrl: '/x' }]);
    assert.ok(!/one item at a time/.test(renderGroundFacts(f)));
  });
});

// ── v2.74.1672 — the mixed-shape and plural bugs, found by running the derivation on the REAL catalog ─────────
describe('groundFacts — shapes the real catalog actually uses', () => {
  it('joinKey is a MIXED array (strings AND {contact,type} rungs) — never coerce it', () => {
    // Live output before the fix: "matches on AddressLine1 or [object Object] or [object Object]".
    // Third instance of this class in one session (summarizeItem v1663, decomposeAsk v1667, joinKey here), so
    // the shape is pinned rather than trusted to a lesson.
    const f = deriveGroundFacts([{
      id: 'x', name: 'Warranty tasks by status', origin: 'a.com', listUrl: '/x', drill: { via: 'y' },
      joinKey: ['AddressLine1', { contact: 'primary', type: 'email' }, { contact: 'other', type: 'phone' }],
    }]);
    const on = f.lists[0].joinsOn;
    assert.ok(!on.some((x) => x === '[object Object]'), `coerced an object: ${JSON.stringify(on)}`);
    assert.deepEqual(on, ['AddressLine1', 'email', 'other phone']);
    assert.ok(!renderGroundFacts(f).includes('[object Object]'));
  });

  it('a ladder groups across SINGULAR and PLURAL names', () => {
    // "Find a Shopify customer by email" and "Search Shopify customers by name" are the same ladder; before the
    // fix they split into two buckets and the third rung vanished.
    const f = deriveGroundFacts([
      { id: 'a', name: 'Find a Shopify customer by email', origin: 'admin.shopify.com' },
      { id: 'b', name: 'Find a Shopify customer by phone', origin: 'admin.shopify.com' },
      { id: 'c', name: 'Search Shopify customers by name', origin: 'admin.shopify.com' },
    ]);
    assert.equal(f.lookups.length, 1, `split into ${f.lookups.length} buckets`);
    assert.deepEqual(f.lookups[0].keys.sort(), ['email', 'name', 'phone']);
  });

  it('an unrenderable joinKey entry is DROPPED, not rendered as a placeholder', () => {
    const f = deriveGroundFacts([{ id: 'x', name: 'L', origin: 'a.com', listUrl: '/x', joinKey: ['Addr', {}, null, 42] }]);
    assert.deepEqual(f.lists[0].joinsOn, ['Addr']);
  });
});
