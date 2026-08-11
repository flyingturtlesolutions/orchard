// Core/armWrite.test.js — v2.74.2200: the PER-ITEM ACT over a branch arm.
//
// The gl of 2026-08-11 proved the composition missing: `process these` sorted three warranty rows into
// `replacement needed`, then `draft the replacements` routed to a single-shot create asking for a customer gid
// by hand. These assert the two things that made it impossible — reading a DERIVED outcome as a param, and
// choosing items by what the declaration can fill rather than by an arm's wording.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { armActParams, resolveArmValue, selectArmItems, armActTally, declarationReadsOutcome, pickArmTarget, OUTCOME_KEY } from './armWrite.js';

const CONTACTS = [{ FirstName: 'Jimmy', LastName: 'Ivey', Email: 'jimmy@example.com', CellPhone: '555-0100', IsPrimary: true, IsBuyer: true }];
const row = (outcome, extra = {}) => ({
  TaskNumber: '4913764-01-01', AddressLine1: '2184 Monk Drive', CityStateZip: 'Raleigh, NC 27610',
  __contacts: CONTACTS, ...(outcome ? { [OUTCOME_KEY]: outcome } : {}), ...extra,
});
const OUT = { arm: 'replacement needed', count: 6, product: 'Simple Rocker Switch (Single-Pole & Multiway)', route: 'EXPLICIT' };

// The real declaration, from CONNECTOR_RECIPES vs_warranty_tasks.writeMap.shopify_create_order.
const DECL = {
  customer_gid: { contact: 'primary', type: 'email' },
  line_items: { each: { variantId: { outcome: 'product' }, quantity: { outcome: 'count' } } },
  applied_discount: { const: { value: 100, valueType: 'PERCENTAGE', title: 'Warranty replacement' } },
  shipping_line: { const: { title: 'Free shipping', price: '0.00' } },
  note: { template: 'Warranty replacement — task {TaskNumber}, {AddressLine1}' },
};
const DEFS = [
  { name: 'customer_gid', required: true }, { name: 'line_items', required: true },
  { name: 'note', required: false }, { name: 'applied_discount', required: false },
  { name: 'shipping_line', required: false }, { name: 'po_number', required: false },
];

describe('armWrite — resolveArmValue', () => {
  it('an OUTCOME rung reads the branch verdict, which is derived and lives on no field', () => {
    assert.equal(resolveArmValue(row(OUT), 'product', { product: { outcome: 'product' } }), OUT.product);
  });

  it('a NUMBER stays a number — quantity is validated as an integer on the wire', () => {
    const v = resolveArmValue(row(OUT), 'quantity', { quantity: { outcome: 'count' } });
    assert.equal(v, 6);
    assert.equal(typeof v, 'number', 'stringifying it would hand the server "6" for a numeric field');
  });

  it('a CONST rung carries structure, not just a string — a discount is an object', () => {
    const v = resolveArmValue(row(OUT), 'applied_discount', DECL);
    assert.deepEqual(v, { value: 100, valueType: 'PERCENTAGE', title: 'Warranty replacement' });
  });

  it('a CONST is COPIED — a built payload can never mutate the catalog declaration', () => {
    const v = resolveArmValue(row(OUT), 'applied_discount', DECL);
    v.value = 0;
    assert.equal(DECL.applied_discount.const.value, 100);
  });

  it('EACH builds one line item per row, resolving its members by the same rules', () => {
    assert.deepEqual(resolveArmValue(row(OUT), 'line_items', DECL), [{ variantId: OUT.product, quantity: 6 }]);
  });

  it('a HALF-filled line item is refused whole — a variant with no quantity is worse than none', () => {
    assert.equal(resolveArmValue(row({ arm: 'replacement needed', product: 'X' }), 'line_items', DECL), undefined);
    assert.equal(resolveArmValue(row({ arm: 'replacement needed', count: 2 }), 'line_items', DECL), undefined);
  });

  it('a TEMPLATE fills from the row; an unresolved placeholder voids the WHOLE string', () => {
    assert.equal(resolveArmValue(row(OUT), 'note', DECL), 'Warranty replacement — task 4913764-01-01, 2184 Monk Drive');
    const noAddr = row(OUT); delete noAddr.AddressLine1;
    assert.equal(resolveArmValue(noAddr, 'note', DECL), undefined, 'never ship a note printing {AddressLine1}');
  });

  it('a CONTACT rung delegates to resolveWriteValue — one vocabulary, one implementation', () => {
    assert.equal(resolveArmValue(row(OUT), 'customer_gid', DECL), 'jimmy@example.com');
  });

  it('DECLARATION-ONLY: an undeclared param resolves to nothing, with no name-match guess', () => {
    // resolveWriteValue ends in a "the row has a key shaped like this param" fallback, which is right for filling
    // a customer record and wrong for firing a write per row. A param nobody declared is one nobody thought about.
    assert.equal(resolveArmValue(row(OUT, { po_number: 'PO-9' }), 'po_number', DECL), undefined);
  });

  it('undefined, not empty string — "absent" must stay distinguishable from "empty"', () => {
    assert.equal(resolveArmValue(row(null), 'line_items', DECL), undefined);
    assert.equal(resolveArmValue(row(OUT), 'nope', DECL), undefined);
  });
});

describe('armWrite — armActParams', () => {
  it('builds the whole invoke payload for a classified warranty row', () => {
    const { params, missing } = armActParams(row(OUT), DECL, DEFS);
    assert.deepEqual(missing, []);
    assert.deepEqual(params, {
      customer_gid: 'jimmy@example.com',
      line_items: [{ variantId: OUT.product, quantity: 6 }],
      note: 'Warranty replacement — task 4913764-01-01, 2184 Monk Drive',
      applied_discount: { value: 100, valueType: 'PERCENTAGE', title: 'Warranty replacement' },
      shipping_line: { title: 'Free shipping', price: '0.00' },
    });
    assert.equal('po_number' in params, false, 'an optional param that resolves to nothing is simply absent');
  });

  it('names the REQUIRED params it could not fill — never a partial create', () => {
    const noContacts = row(OUT); noContacts.__contacts = [];
    const { missing } = armActParams(noContacts, DECL, DEFS);
    assert.deepEqual(missing, ['customer_gid']);
  });

  it('a row with NO outcome cannot fill the line items — this is the contact-arm row', () => {
    const { missing } = armActParams(row(null), DECL, DEFS);
    assert.deepEqual(missing, ['line_items']);
  });

  it('no declaration at all fills nothing and reports every required param', () => {
    const { params, missing } = armActParams(row(OUT), null, DEFS);
    assert.deepEqual(params, {});
    assert.deepEqual(missing, ['customer_gid', 'line_items']);
  });
});

describe('armWrite — selectArmItems', () => {
  const items = [
    { arm: 'replacement needed', row: row(OUT) },
    { arm: 'replacement needed', row: row({ ...OUT, count: 2 }) },
    { arm: 'contact homeowner', row: row({ arm: 'contact homeowner', cause: 'no-count' }) },
    { arm: '', row: row(null) },
  ];

  it('WITHOUT a named arm, items are chosen by what the declaration can FILL', () => {
    // Deliberately not by matching the ask against an arm label: labels are authored per run by the classifier
    // ("needs replacement part" one run, "replacement needed" the next), so keying to their wording keys to a
    // string the model invented. Fillability is a property of the row and the declaration.
    const { use, skipped } = selectArmItems(items, { declared: DECL, paramDefs: DEFS });
    assert.equal(use.length, 2);
    assert.equal(skipped.length, 2);
    assert.match(skipped[0].why, /can’t fill line_items/);
    assert.match(skipped[1].why, /no arm matched/);
  });

  it('WITH a named arm, it filters to that arm exactly and says what it dropped', () => {
    const { use, skipped } = selectArmItems(items, { arm: 'contact homeowner', declared: DECL, paramDefs: DEFS });
    assert.equal(use.length, 0, 'a contact row still cannot fill a draft order');
    assert.equal(skipped.filter((s) => /not in "contact homeowner"/.test(s.why)).length, 3);
  });

  it('every dropped item carries a REASON — the batch never shrinks silently', () => {
    const { skipped } = selectArmItems(items, { declared: DECL, paramDefs: DEFS });
    assert.ok(skipped.every((s) => s.why && s.item), 'no-silent-caps applies to selection too');
  });

  it('junk in, nothing out', () => {
    assert.deepEqual(selectArmItems(null, { declared: DECL, paramDefs: DEFS }).use, []);
    assert.deepEqual(selectArmItems([{ arm: 'x' }, null], { declared: DECL, paramDefs: DEFS }).use, []);
  });
});

describe('armWrite — armActTally', () => {
  it('states every non-zero class against the FULL total, not the acted subset', () => {
    assert.equal(armActTally({ created: 2, skipped: 2, total: 4 }), '**2** created · **2** skipped — of 4 items.');
  });
  it('a run that did nothing says so rather than printing an empty line', () => {
    assert.equal(armActTally({ total: 3 }), 'nothing to do — of 3 items.');
  });
  it('singular reads correctly', () => {
    assert.equal(armActTally({ created: 1, total: 1 }), '**1** created — of 1 item.');
  });
});

// v2.74.2200 — the rule that keeps two declared write targets on one source from becoming a coin flip. It is a
// fact about the DATA: a declaration reading an `outcome` can only be filled by an item a branch classified.
describe('armWrite — declarationReadsOutcome / pickArmTarget', () => {
  const CUSTOMER = { first_name: { contact: 'primary', type: 'first' }, address1: 'AddressLine1', country: { literal: 'US' } };

  it('a declaration with an outcome rung is branch-arm-only', () => {
    assert.equal(declarationReadsOutcome(DECL), true);
    assert.equal(declarationReadsOutcome({ q: { outcome: 'count' } }), true);
  });

  it('an outcome nested inside an EACH element counts too — that is where line_items hides it', () => {
    assert.equal(declarationReadsOutcome({ line_items: { each: { variantId: { outcome: 'product' } } } }), true);
  });

  it('a row/contact/literal declaration does NOT — a lookup miss can fill it', () => {
    assert.equal(declarationReadsOutcome(CUSTOMER), false);
    assert.equal(declarationReadsOutcome({}), false);
    assert.equal(declarationReadsOutcome(null), false);
  });

  it('picks the outcome-bearing target out of a writeMap that declares both', () => {
    const got = pickArmTarget({ shopify_create_customer: CUSTOMER, shopify_create_order: DECL });
    assert.equal(got.ok, true);
    assert.equal(got.targetId, 'shopify_create_order');
    assert.equal(got.declared, DECL, 'the per-target rung map, not the whole writeMap');
  });

  it('NO outcome-bearing target reports no-declaration and names what IS declared', () => {
    const got = pickArmTarget({ shopify_create_customer: CUSTOMER });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'no-declaration');
    assert.deepEqual(got.targets, ['shopify_create_customer'], 'so the reply can say what these rows CAN fill');
  });

  it('TWO per-item acts on one source is ambiguous — it asks, it never picks the first', () => {
    const got = pickArmTarget({ a: DECL, b: { x: { outcome: 'count' } } });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'ambiguous');
    assert.deepEqual(got.targets, ['a', 'b']);
  });

  it('an empty or junk writeMap declares nothing', () => {
    for (const junk of [null, undefined, {}, 'x', []]) assert.equal(pickArmTarget(junk).ok, false);
  });
});

// v2.74.2201 — THE LIVE FAILURE, pinned as a contract. gl 07:32: the branch reported `enriched 3/3 row(s) via
// vs_warranty_task +1 sidecar(s)` and the act then reported `items=0/3 · skipped can't fill customer_gid` three
// times. The contacts had been READ and thrown away: the sidecar merge projected them into scalars
// (ContactEmail, ContactRoles, ContactsAll) and dropped the structured list every selector resolves against.
//
// `_sidecarFields` lives in chat.js, which is OUTSIDE the test glob, so these assert the CONTRACT it has to
// satisfy rather than the function itself — what a row must carry for a per-item act to fill a contact rung.
describe('armWrite — the contact rung needs the STRUCTURED list, not the flattened scalars', () => {
  const flattenedOnly = {
    TaskNumber: '4913764-01-01', AddressLine1: '2184 Monk Drive',
    // Exactly what the sidecar merge produced before v2201 — readable, renderable, and unselectable.
    ContactEmail: 'jimmy@example.com', ContactRoles: 'Primary, Buyer',
    ContactsAll: 'Jimmy Ivey (Primary, Buyer) jimmy@example.com 555-0100',
    [OUTCOME_KEY]: OUT,
  };

  it('reproduces the live miss: flattened scalars alone cannot fill customer_gid', () => {
    const { params, missing } = armActParams(flattenedOnly, DECL, DEFS);
    assert.deepEqual(missing, ['customer_gid'], 'this is the `items=0/3` line from the trace');
    assert.deepEqual(params.line_items, [{ variantId: OUT.product, quantity: 6 }],
      'and it localises the fault: __outcome DID reach the row, so the bank was never the problem');
  });

  it('with __contacts present the same row fills completely — one key is the whole difference', () => {
    const { params, missing } = armActParams({ ...flattenedOnly, __contacts: CONTACTS }, DECL, DEFS);
    assert.deepEqual(missing, []);
    assert.equal(params.customer_gid, 'jimmy@example.com');
  });

  it('a contact rung picks the declared ROLE, which is why a first-wins scalar cannot stand in for it', () => {
    const staffFirst = [
      { FirstName: 'Kat', LastName: 'Owens', Email: 'kat@builder.example', IsDrHorton: true, AssignmentType: 'CSR' },
      ...CONTACTS,
    ];
    const { params } = armActParams({ ...flattenedOnly, __contacts: staffFirst }, DECL, DEFS);
    assert.equal(params.customer_gid, 'jimmy@example.com', 'the HOMEOWNER, not the builder’s CSR who happens to be first');
  });
});

// v2.74.2203 — asserted against the REAL catalog, not a fixture copy. A declaration is data, and a fixture that
// drifts from it tests nothing: the point of these two is that the shipped warranty rows fill the shipped leg.
describe('armWrite — the shipped warranty declaration fills the shipped create leg', () => {
  it('every required param of shopify_create_order resolves from a classified warranty row', async () => {
    const { CONNECTOR_RECIPES } = await import('./connectorRecipes.js');
    const wm = CONNECTOR_RECIPES.find((r) => r.id === 'vs_warranty_tasks').writeMap.shopify_create_order;
    const defs = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_create_order').params;
    const { params, missing } = armActParams(row(OUT), wm, defs);
    assert.deepEqual(missing, [], 'a warranty row must be able to fill a draft order end to end');
    assert.equal(params.customer_gid, 'jimmy@example.com', 'the human value; the lookup seam resolves it to a gid');
    assert.deepEqual(params.line_items, [{ variantId: OUT.product, quantity: 6 }]);
  });

  it('a warranty draft is ALWAYS tagged, with all four (user direction 2026-08-11)', async () => {
    const { CONNECTOR_RECIPES } = await import('./connectorRecipes.js');
    const wm = CONNECTOR_RECIPES.find((r) => r.id === 'vs_warranty_tasks').writeMap.shopify_create_order;
    const defs = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_create_order').params;
    const { params } = armActParams(row(OUT), wm, defs);
    assert.deepEqual(params.tags, ['replacement', 'support', 'foc', 'warranty']);
    // Nobody is billed for a warranty part, and the tags say so alongside the discount that enforces it.
    assert.equal(params.applied_discount.value, 100);
    assert.equal(params.shipping_line.price, '0.00');
  });

  it('BOTH warranty legs declare it — the list and the detail, or a drilled row silently loses the target', async () => {
    const { CONNECTOR_RECIPES } = await import('./connectorRecipes.js');
    for (const id of ['vs_warranty_tasks', 'vs_warranty_task']) {
      const wm = CONNECTOR_RECIPES.find((r) => r.id === id).writeMap;
      assert.ok(wm && wm.shopify_create_order, `${id} declares the draft-order write`);
      assert.deepEqual(wm.shopify_create_order.tags.const, ['replacement', 'support', 'foc', 'warranty']);
    }
  });
});

// v2.74.2205 (bug pass) — found by fuzzing the module's exports, not by a call site: a parameter default fires
// only on `undefined`, so an explicit `null` threw here while every peer tolerated it.
describe('armWrite — armActTally survives junk', () => {
  it('null / undefined / a non-object read as an empty tally', () => {
    for (const junk of [null, undefined, 0, '', [], 'x']) {
      assert.equal(armActTally(junk), 'nothing to do — of 0 items.');
    }
  });
  it('non-numeric counts read as zero rather than printing NaN', () => {
    assert.equal(armActTally({ created: 'two', total: null }), 'nothing to do — of 0 items.');
  });
});
