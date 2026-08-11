// Core/audit.test.js — AU-0 (DESIGN_audit.md §11). The pure creates-audit core: the success predicate (the
// phantom-row guard, §10.1), the create-only classifier, the GraphQL+REST extractor, the minimal customer label
// (§10.5), the whitelist normalizer, capped append, and the one-line row. All headless/pure.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_KINDS, AUDIT_CAP,
  classifyCreate, createRecordFrom, auditSucceeded, customerLabelFrom,
  auditEntry, appendCreate, truncationNotice, describeCreate,
  parseCreatesAsk, createsScopeWindow, filterCreatesByScope, renderCreatesAnswer,
  recordOpenUrl, incitedOpener, classifyVerb,
} from './audit.js';
import { fillEndpoint } from './connectorRecipes.js';   // AU-2 — the real substituter, injected exactly as chat.js injects it

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
  it('unknown → kind record, never thrown; verb defaults to create (AU-6 kept the safe default)', () => {
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
    // AU-6 (v2.74.2204, §12.1) — the shape grew three LIFECYCLE fields, and this deepEqual is why the change is
    // reviewed rather than absorbed: a create is born WARM, having been confirmed at its own timestamp, with a
    // one-entry timeline. `currentKind`/`currentId` are deliberately ABSENT until a hand-off is observed — that
    // absence is what lets `handOff()` be a fact about the row instead of a comparison that special-cases
    // "same as the create".
    assert.deepEqual(e, {
      at: 1000, system: 'admin.shopify.com', verb: 'create', kind: 'draft', id: '29685', label: '#D29685',
      who: 'human', recipeId: 'shopify_create_order',
      watch: 'warm', lastSeenAt: 1000,
      events: [{ at: 1000, type: 'create', kind: 'draft', id: '29685', label: '#D29685' }],
    });
    assert.equal('junk' in e, false);
    assert.equal('currentKind' in e, false, 'the pointer stays absent until something is observed');
    assert.equal('warmUntil' in e, false, 'the window is set by the writer that knows the leg’s cadence, not here');
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

describe('parseCreatesAsk — the read-surface shortcut (AU-3)', () => {
  it('matches retrospective asks', () => {
    for (const q of ['what have I created', 'what did I create', 'show me what I made', 'list my created records',
                     'what has Orchard created', 'any records I added?', "what have I created this week"]) {
      assert.equal(parseCreatesAsk(q).matched, true, q);
    }
  });
  it('does NOT match a real create COMMAND (no interrogative)', () => {
    assert.equal(parseCreatesAsk('create a draft order for jane@acme.com with 1 Smart Plug').matched, false);
    assert.equal(parseCreatesAsk('add a customer named Bob').matched, false);
  });
  it('does NOT match unrelated reads', () => {
    assert.equal(parseCreatesAsk('show me my draft orders').matched, false);   // no create verb
    assert.equal(parseCreatesAsk('how many tickets are open').matched, false);
  });
  it('extracts the scope window', () => {
    assert.equal(parseCreatesAsk('what have I created today').scope, 'today');
    assert.equal(parseCreatesAsk('what did I create yesterday').scope, 'yesterday');
    assert.equal(parseCreatesAsk('what have I created this week').scope, 'week');
    assert.equal(parseCreatesAsk('what have I created').scope, 'all');
  });
});

describe('createsScopeWindow + filterCreatesByScope — deterministic (now passed in)', () => {
  const NOW = 10 * 86400000;   // day 10
  const rows = [
    { at: NOW - 30 * 60000, verb: 'create', id: 'recent' },       // 30 min ago → today
    { at: NOW - 1.5 * 86400000, verb: 'create', id: 'yday' },     // ~1.5 days ago → yesterday window
    { at: NOW - 5 * 86400000, verb: 'create', id: 'thisweek' },   // 5 days ago → within week, not today
    { at: 0, verb: 'create', id: 'legacy' },                      // unstamped
  ];
  it("today keeps only the last day's rows", () => {
    assert.deepEqual(filterCreatesByScope(rows, 'today', NOW).map((r) => r.id), ['recent']);
  });
  it('week keeps the last 7 days (not the legacy at=0)', () => {
    assert.deepEqual(filterCreatesByScope(rows, 'week', NOW).map((r) => r.id), ['recent', 'yday', 'thisweek']);
  });
  it("all keeps everything incl. legacy at=0", () => {
    assert.equal(filterCreatesByScope(rows, 'all', NOW).length, 4);
  });
  it('window bounds are honest', () => {
    assert.deepEqual(createsScopeWindow('today', NOW), { from: NOW - 86400000, to: NOW });
  });
});

describe('renderCreatesAnswer — the markdown answer (AU-3)', () => {
  const fmtTime = (at) => (at ? `t${at}` : '');
  it('lists creates newest-first with a count header', () => {
    const items = [
      auditEntry({ at: 1, system: 'admin.shopify.com', kind: 'draft', id: '1', label: '#D1', who: 'human' }),
      auditEntry({ at: 2, system: 'deako.zendesk.com', kind: 'ticket', id: '2', label: 'Broken', who: 'gate' }),
    ];
    const out = renderCreatesAnswer({ items, total: 2, notice: '' }, { fmtTime });
    assert.match(out, /You've created 2 records:/);
    const lines = out.split('\n');
    assert.match(lines[1], /ticket · Broken/);   // newest first
    assert.match(lines[2], /draft · #D1/);
  });
  it('empty → honest nothing message (scoped)', () => {
    assert.match(renderCreatesAnswer({ items: [], total: 0 }, { fmtTime, scope: 'today' }), /haven't created anything today/);
  });
  it('surfaces the truncation notice on the all-scope header', () => {
    const items = [auditEntry({ at: 1, system: 's', kind: 'record', id: '1', who: 'gate' })];
    assert.match(renderCreatesAnswer({ items, total: 812, notice: 'showing the last 500 of 812' }, { fmtTime }), /showing the last 500 of 812/);
  });
  it('filters to verb==="create" (v1 stores creates only, but the filter is honest for AU-6)', () => {
    const items = [{ at: 1, verb: 'delete', kind: 'draft', id: 'x' }, auditEntry({ at: 2, system: 's', kind: 'draft', id: '2', label: '#D2', who: 'human' })];
    const out = renderCreatesAnswer({ items, total: 2 }, { fmtTime });
    assert.match(out, /You've created 1 record:/);
    assert.doesNotMatch(out, /delete/);
  });
});

// ── AU-2 (v2.74.2147) — recordOpenUrl: the eye button's destination ─────────────────────────────────────────
// The rule that matters is the LAST one: an unfilled placeholder must yield '' (no button) rather than a URL
// containing a literal "{handle}". A dead link on a record the user is trying to verify is worse than no link.
describe('AU-2 recordOpenUrl', () => {
  const DRAFT_TPL = '/store/{handle}/draft_orders/{id}';
  const draft = (extra = {}) => auditEntry({
    at: 1, system: 'admin.shopify.com', kind: 'draft', id: '1099', label: '#D1099', who: 'gate',
    recipeId: 'shopify_create_order', urlArgs: { handle: 'deako' }, ...extra,
  });

  it('fills the catalog template from urlArgs + id', () => {
    assert.equal(recordOpenUrl(draft(), DRAFT_TPL, fillEndpoint),
      'https://admin.shopify.com/store/deako/draft_orders/1099');
  });
  it('a banked ABSOLUTE itemUrl wins over the template (the writer knew the exact page)', () => {
    assert.equal(recordOpenUrl(draft({ itemUrl: 'https://admin.shopify.com/store/x/draft_orders/7' }), DRAFT_TPL, fillEndpoint),
      'https://admin.shopify.com/store/x/draft_orders/7');
  });
  it('a banked RELATIVE itemUrl is still filled + hosted', () => {
    assert.equal(recordOpenUrl(draft({ itemUrl: '/store/{handle}/draft_orders/{id}' }), '', fillEndpoint),
      'https://admin.shopify.com/store/deako/draft_orders/1099');
  });
  it('UNFILLED placeholder → "" (no button beats a 404)', () => {
    assert.equal(recordOpenUrl(auditEntry({ at: 1, system: 'admin.shopify.com', kind: 'draft', id: '1', who: 'gate' }), DRAFT_TPL, fillEndpoint), '');
  });
  it('no template and no banked url → ""', () => {
    assert.equal(recordOpenUrl(draft(), '', fillEndpoint), '');
  });
  it('no system → "" (nothing to host the path on)', () => {
    assert.equal(recordOpenUrl(auditEntry({ at: 1, system: '', kind: 'draft', id: '9', who: 'gate' }), DRAFT_TPL, fillEndpoint), '');
  });
  it('a zendesk ticket resolves on its own host, same rule', () => {
    const t = auditEntry({ at: 1, system: 'deako.zendesk.com', kind: 'ticket', id: '68482', who: 'human' });
    assert.equal(recordOpenUrl(t, '/agent/tickets/{id}', fillEndpoint), 'https://deako.zendesk.com/agent/tickets/68482');
  });
  it('null/garbage entry → "" rather than throwing', () => {
    assert.equal(recordOpenUrl(null, DRAFT_TPL, fillEndpoint), '');
    assert.equal(recordOpenUrl(undefined, DRAFT_TPL, fillEndpoint), '');
  });
  // v2.74.2149 — a SECTION route is not a record link. `/#warranty` has no placeholder to leave unfilled, so the
  // unfilled-guard above passes it and it opens the warranty LIST while claiming to be task #4899327.
  it('a SECTION route with no {id} → "" (the VendorSuite trap)', () => {
    const task = auditEntry({ at: 1, system: 'vendorsuite.drhorton.com', kind: 'record', id: '4899327', who: 'gate' });
    assert.equal(recordOpenUrl(task, '/#warranty', fillEndpoint), '');
    assert.equal(recordOpenUrl(task, '/#dashboard', fillEndpoint), '');
  });
  it('…and a banked RELATIVE itemUrl gets the same treatment (no {id} ⇒ no link)', () => {
    const task = auditEntry({ at: 1, system: 'vendorsuite.drhorton.com', kind: 'record', id: '4899327', who: 'gate', itemUrl: '/#warranty' });
    assert.equal(recordOpenUrl(task, '', fillEndpoint), '');
  });
  it('a banked ABSOLUTE url is still honoured — it already identifies the record', () => {
    const task = auditEntry({ at: 1, system: 'vendorsuite.drhorton.com', kind: 'record', id: '4899327', who: 'gate', itemUrl: 'https://vendorsuite.drhorton.com/task/4899327' });
    assert.equal(recordOpenUrl(task, '/#warranty', fillEndpoint), 'https://vendorsuite.drhorton.com/task/4899327');
  });
});

// ── §12.8.1 — the INCITING record (v2.74.2195) ────────────────────────────────────────────────────────────────
// The field is shaped like a RECORD, not like VendorSuite. Its first draft carried `division`, a VendorSuite
// noun; a draft order incited by a Zendesk ticket has none. Anything source-specific lives in `args`.
describe('auditEntry — incitedBy is a capped RECORD reference, not a source-specific bag', () => {
  it('keeps system/kind/id/label and puts source-specific extras in args', () => {
    const e = auditEntry({
      system: 'admin.shopify.com', kind: 'draft', id: '29685', who: 'human',
      incitedBy: { system: 'vendorsuite.drhorton.com', kind: 'task', id: '4903279', label: '1565 Fairlie Way', args: { division: 'Columbus' } },
    });
    assert.deepEqual(e.incitedBy, {
      system: 'vendorsuite.drhorton.com', id: '4903279', kind: 'task',
      label: '1565 Fairlie Way', args: { division: 'Columbus' },
    });
  });

  it('a source with NO extras carries none — a Zendesk ticket needs only its id', () => {
    const e = auditEntry({ system: 'admin.shopify.com', kind: 'draft', id: '1', incitedBy: { system: 'deako.zendesk.com', kind: 'ticket', id: '12345' } });
    assert.deepEqual(e.incitedBy, { system: 'deako.zendesk.com', id: '12345', kind: 'ticket' });
    assert.equal('args' in e.incitedBy, false, 'no empty bag — absent means absent');
  });

  // A provenance that cannot be OPENED is the "valid-looking but wrong" shape §12.8.1 exists to prevent: a card
  // offering to show you something it has no way to reach.
  it('DROPS the whole reference without both system and id', () => {
    assert.equal('incitedBy' in auditEntry({ id: '1', incitedBy: { system: 'vendorsuite.drhorton.com' } }), false);
    assert.equal('incitedBy' in auditEntry({ id: '1', incitedBy: { id: '4903279' } }), false);
    assert.equal('incitedBy' in auditEntry({ id: '1', incitedBy: null }), false);
    assert.equal('incitedBy' in auditEntry({ id: '1' }), false);
  });

  it('normalizes the system to a bare host and caps the strings', () => {
    const e = auditEntry({ id: '1', incitedBy: { system: 'https://vendorsuite.drhorton.com/#warranty', id: 'x'.repeat(200), label: 'y'.repeat(200) } });
    assert.equal(e.incitedBy.system, 'vendorsuite.drhorton.com');
    assert.equal(e.incitedBy.id.length, 80);
    assert.equal(e.incitedBy.label.length, 80);
  });

  it('args are string-valued and capped, like urlArgs — no nested objects ride in', () => {
    const e = auditEntry({ id: '1', incitedBy: { system: 's.com', id: '1', args: { division: 'Columbus', nested: { a: 1 }, n: 7 } } });
    assert.deepEqual(e.incitedBy.args, { division: 'Columbus', n: '7' });
  });
});

// The surface asks what the inciting SYSTEM affords — never "is this VendorSuite?". A second walk-only source
// makes `canDrive` true for another host and this function is untouched.
describe('incitedOpener — link | drive | none, decided by the SYSTEM (§12.8.1)', () => {
  const vsd = { incitedBy: { system: 'vendorsuite.drhorton.com', id: '4903279', label: '1565 Fairlie Way', args: { division: 'Columbus' } } };
  const zd = { incitedBy: { system: 'deako.zendesk.com', id: '12345', label: 'Broken switch' } };

  it('a per-record URL wins — the link needs no drive', () => {
    const r = incitedOpener(zd, { template: '/agent/tickets/{id}', canDrive: () => true, fill: fillEndpoint });
    assert.equal(r.how, 'link');
    assert.equal(r.url, 'https://deako.zendesk.com/agent/tickets/12345');
  });

  it('a SECTION route is not a record link — it falls through to the drive (the v2149 trap)', () => {
    const r = incitedOpener(vsd, { template: '/#warranty', canDrive: (s) => s === 'vendorsuite.drhorton.com', fill: fillEndpoint });
    assert.equal(r.how, 'drive', '/#warranty fills cleanly and opens the wrong page — it must never be a link');
    assert.equal(r.url, '');
    assert.equal(r.args.division, 'Columbus', 'the opener carries what the drive needs');
  });

  it('no template and no drive → none; a button that cannot deliver is worse than no button', () => {
    assert.equal(incitedOpener(vsd, { canDrive: () => false, fill: fillEndpoint }).how, 'none');
    assert.equal(incitedOpener(vsd, { template: '/#warranty', fill: fillEndpoint }).how, 'none');
  });

  it('no incitedBy at all → none, and never throws on a legacy row', () => {
    assert.equal(incitedOpener({ system: 'admin.shopify.com', id: '1' }, { template: '/x/{id}', canDrive: () => true, fill: fillEndpoint }).how, 'none');
    assert.equal(incitedOpener(null).how, 'none');
    assert.equal(incitedOpener({ incitedBy: 'nonsense' }, {}).how, 'none');
  });

  it('carries the label so the button can name what it opens', () => {
    assert.equal(incitedOpener(vsd, { canDrive: (s) => s.includes('vendorsuite') }).label, '1565 Fairlie Way');
  });
});

// AU-6 (v2.74.2207) — the VERB generalization §10.3 named. `create` unless the evidence says otherwise: an
// unrecognised write is far more likely a create shape we have not met than a destructive act we failed to spot,
// and mislabelling a create as a delete would put a terminal word on a live record.
describe('classifyVerb — which act was this (AU-6)', () => {
  const gql = (op) => ({ data: { [op]: { userErrors: [] } } });

  it('reads the vendor naming its OWN act, from the reply’s operation key', () => {
    assert.equal(classifyVerb(gql('draftOrderDelete'), 'x'), 'delete');
    assert.equal(classifyVerb(gql('customerUpdate'), 'x'), 'update');
    assert.equal(classifyVerb(gql('draftOrderCreate'), 'x'), 'create');
  });

  it('falls back to the recipe id when the reply does not say', () => {
    assert.equal(classifyVerb({}, 'shopify_delete_order'), 'delete');
    assert.equal(classifyVerb({}, 'shopify_update_customer'), 'update');
    assert.equal(classifyVerb({}, 'shopify_create_order'), 'create');
  });

  it('the REPLY outranks the id — the vendor knows what it did', () => {
    assert.equal(classifyVerb(gql('draftOrderDelete'), 'shopify_create_order'), 'delete');
  });

  it('DEFAULTS TO CREATE on no evidence — the safe direction', () => {
    assert.equal(classifyVerb(null, ''), 'create');
    assert.equal(classifyVerb({ data: {} }, 'something_new'), 'create');
  });

  it('classifyCreate carries the verb through, and the whitelist accepts all three', () => {
    assert.equal(classifyCreate(gql('draftOrderDelete'), 'x').verb, 'delete');
    assert.equal(auditEntry({ verb: 'delete', kind: 'draft' }).verb, 'delete');
    assert.equal(auditEntry({ verb: 'update', kind: 'draft' }).verb, 'update');
    assert.equal(auditEntry({ verb: 'wormhole', kind: 'draft' }).verb, 'create', 'an unknown verb still falls to create');
  });
});
