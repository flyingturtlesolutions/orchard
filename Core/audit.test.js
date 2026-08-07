// Core/audit.test.js — AU-0 (DESIGN_audit.md §11). The pure creates-audit core: the success predicate (the
// phantom-row guard, §10.1), the create-only classifier, the GraphQL+REST extractor, the minimal customer label
// (§10.5), the whitelist normalizer, capped append, and the one-line row. All headless/pure.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_KINDS, AUDIT_CAP,
  classifyCreate, createRecordFrom, auditSucceeded, customerLabelFrom,
  auditEntry, appendCreate, truncationNotice, describeCreate,
} from './audit.js';

// ── Fixtures: the mutation reply shapes the seam actually hands recordCreate ──
const CUSTOMER_OK = { data: { customerCreate: { customer: { id: 'gid://shopify/Customer/8675309' }, userErrors: [] } } };
const DRAFT_OK = { data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/29685', name: '#D29685' }, userErrors: [] } } };
const TICKET_REST = { ticket: { id: 12345, subject: 'Broken smart switch' } };   // Zendesk — no `.data` envelope
const DRAFT_REJECTED = { data: { draftOrderCreate: { draftOrder: null, userErrors: [{ message: 'Customer not found' }] } } };
const TOP_ERRORS = { errors: [{ message: 'PersistedQueryNotFound' }], data: null };

describe('createRecordFrom — GraphQL then REST', () => {
  it('digs a GraphQL customerCreate → id (gid tail), label falls to id (no name)', () => {
    const r = createRecordFrom(CUSTOMER_OK);
    assert.deepEqual(r, { id: '8675309', label: '8675309' });
  });
  it('prefers the human name on a draftOrderCreate → #D label, numeric id', () => {
    const r = createRecordFrom(DRAFT_OK);
    assert.deepEqual(r, { id: '29685', label: '#D29685' });
  });
  it('digs a non-.data REST reply → id + subject label', () => {
    const r = createRecordFrom(TICKET_REST);
    assert.deepEqual(r, { id: '12345', label: 'Broken smart switch' });
  });
  it('returns null when no id can be extracted (rejected mutation)', () => {
    assert.equal(createRecordFrom(DRAFT_REJECTED), null);
  });
});

describe('auditSucceeded — the phantom-row guard (§10.1)', () => {
  it('true for a real create (GraphQL + REST)', () => {
    assert.equal(auditSucceeded(CUSTOMER_OK), true);
    assert.equal(auditSucceeded(DRAFT_OK), true);
    assert.equal(auditSucceeded(TICKET_REST), true);
  });
  it('FALSE for a 200-with-nested-userErrors — banks NOTHING for a vendor-refused create', () => {
    assert.equal(auditSucceeded(DRAFT_REJECTED), false);
  });
  it('FALSE for a top-level GraphQL errors[] reply', () => {
    assert.equal(auditSucceeded(TOP_ERRORS), false);
  });
  it('FALSE for junk / no-id replies', () => {
    assert.equal(auditSucceeded(null), false);
    assert.equal(auditSucceeded({}), false);
    assert.equal(auditSucceeded({ data: { customerCreate: { userErrors: [] } } }), false);   // no customer node
  });
});

describe('classifyCreate — kind from op key, else recipeId, else record', () => {
  it('op key wins: draftOrderCreate → draft even if recipeId says order', () => {
    assert.deepEqual(classifyCreate(DRAFT_OK, 'shopify_create_order'), { verb: 'create', kind: 'draft' });
  });
  it('customerCreate → customer', () => {
    assert.deepEqual(classifyCreate(CUSTOMER_OK, 'shopify_create_customer'), { verb: 'create', kind: 'customer' });
  });
  it('REST reply → kind from recipeId (create_ticket → ticket)', () => {
    assert.deepEqual(classifyCreate(TICKET_REST, 'create_ticket'), { verb: 'create', kind: 'ticket' });
  });
  it('unknown → kind record, never thrown; verb always create in v1', () => {
    const c = classifyCreate({ foo: 1 }, 'mystery_leg');
    assert.equal(c.verb, 'create');
    assert.equal(c.kind, 'record');
    assert.ok(AUDIT_KINDS.includes(c.kind));
  });
});

describe('customerLabelFrom — minimal human label from the INPUT (§10.5)', () => {
  it('prefers first name', () => assert.equal(customerLabelFrom({ firstName: 'Divine', email: 'x@y.com' }), 'Divine'));
  it('falls to email-local-part', () => assert.equal(customerLabelFrom({ email: 'dmonk@deako.com' }), 'dmonk'));
  it('falls to name', () => assert.equal(customerLabelFrom({ name: 'Acme Co' }), 'Acme Co'));
  it('null when no human handle', () => {
    assert.equal(customerLabelFrom({}), null);
    assert.equal(customerLabelFrom(null), null);
  });
  it('truncates ≤24', () => assert.equal(customerLabelFrom({ firstName: 'x'.repeat(40) }).length, 24));
});

describe('auditEntry — whitelist normalizer, clock passed in', () => {
  it('drops unknown fields, keeps the whitelist, defaults verb/kind/who', () => {
    const e = auditEntry({ at: 1000, system: 'admin.shopify.com', kind: 'draft', id: '29685', label: '#D29685', who: 'human', recipeId: 'shopify_create_order', junk: 'x' });
    assert.deepEqual(e, { at: 1000, system: 'admin.shopify.com', verb: 'create', kind: 'draft', id: '29685', label: '#D29685', who: 'human', recipeId: 'shopify_create_order' });
    assert.equal('junk' in e, false);
  });
  it('unknown kind → record, unknown who → gate, no at → 0', () => {
    const e = auditEntry({ kind: 'wormhole', who: 'martian' });
    assert.equal(e.kind, 'record');
    assert.equal(e.who, 'gate');
    assert.equal(e.at, 0);
  });
  it('system falls back to origin; itemUrl kept when present', () => {
    const e = auditEntry({ origin: 'deako.zendesk.com', itemUrl: 'https://x/1' });
    assert.equal(e.system, 'deako.zendesk.com');
    assert.equal(e.itemUrl, 'https://x/1');
  });
});

describe('appendCreate + truncationNotice — visible global eviction', () => {
  it('appends oldest-first, evicts past cap, preserves order', () => {
    let list = [];
    for (let i = 0; i < 5; i++) list = appendCreate(list, { id: String(i) }, { cap: 3 });
    assert.deepEqual(list.map((x) => x.id), ['2', '3', '4']);
  });
  it('default cap is AUDIT_CAP', () => assert.equal(AUDIT_CAP, 500));
  it('truncationNotice speaks only when dropped', () => {
    assert.equal(truncationNotice(3, 5), 'showing the last 3 of 5');
    assert.equal(truncationNotice(5, 5), '');
  });
});

describe('describeCreate — the one-line audit row', () => {
  it('formats system · kind · label · created <clock> · you/auto', () => {
    const e = auditEntry({ at: 1000, system: 'admin.shopify.com', kind: 'draft', id: '29685', label: '#D29685', who: 'human' });
    assert.equal(describeCreate(e, '16:11'), 'admin.shopify.com · draft · #D29685 · created 16:11 · you');
  });
  it('gate → auto, falls to id when no label', () => {
    const e = auditEntry({ system: 's', kind: 'record', id: '7', who: 'gate' });
    assert.equal(describeCreate(e, ''), 's · record · 7 · auto');
  });
});
