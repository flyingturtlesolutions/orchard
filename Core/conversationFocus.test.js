/**
 * FC-1 (v2.74.1552) — conversationFocus: entry building, the referential gate, the binder, extraction,
 * push/cap/pin semantics, seed fallback. DESIGN_conversation_focus.md.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOCUS_CAP, pruneFields, nounFromLeg, focusRecordEntry, focusListEntry, pushFocus,
  referentialAsk, bindReferent, recordFind, recordDivision, focusFromSeedRecord,
} from './conversationFocus.js';

const LEG = { name: 'Warranty tasks by status', tool: { groundId: 'gnd_vs', origin: 'vendorsuite.drhorton.com', recipeId: 'vs_warranty_tasks', itemUrl: null, drill: { via: 'vs_warranty_task', from: 'TaskId', param: 'taskId' } } };
const FIELDS = { TicketId: 4867009, TaskId: 3628151, TaskNumber: '4867009-05-01', Division: 'Raleigh - 060', Address: '204 Starlight Street', ClaimNumber: '02', AllowedRepairAmount: 0 };
const CASE_ENTRY = focusRecordEntry({ label: '204 Starlight Street · Sanford', noun: 'warranty tasks', fields: FIELDS, leg: LEG, pinned: true, at: 1000 });

describe('conversationFocus — entries + push (FC-1)', () => {
  it('builds a record entry with pruned fields, noun tokens (incl. singulars), and leg provenance', () => {
    assert.ok(CASE_ENTRY);
    assert.equal(CASE_ENTRY.kind, 'record');
    assert.ok(CASE_ENTRY.nounTokens.includes('warranty') && CASE_ENTRY.nounTokens.includes('task'), 'singularized');
    assert.equal(CASE_ENTRY.provenance.host, 'vendorsuite.drhorton.com');
    assert.equal(CASE_ENTRY.provenance.drill.from, 'TaskId');
    assert.equal(CASE_ENTRY.pinned, true);
  });
  it('nounFromLeg cuts qualifier clauses; prune drops objects and slices strings', () => {
    assert.equal(nounFromLeg(LEG), 'warranty tasks');
    const p = pruneFields({ a: 'x'.repeat(500), b: { nested: 1 }, c: '', d: 7 });
    assert.equal(p.a.length, 400); assert.ok(!('b' in p) && !('c' in p)); assert.equal(p.d, 7);
  });
  it('pushFocus dedupes by identity, keeps pinned through updates, and never evicts pinned at cap', () => {
    let list = pushFocus([], CASE_ENTRY);
    list = pushFocus(list, focusRecordEntry({ label: '204 Starlight Street · Sanford', noun: 'warranty tasks', fields: { ...FIELDS, TaskStatus: 'Open' }, leg: LEG, at: 2000 }));
    assert.equal(list.length, 1, 'same identity updates in place');
    assert.equal(list[0].pinned, true, 'pin survives the update');
    assert.ok(list[0].fields.TaskStatus, 'newest fields win');
    for (let i = 0; i < FOCUS_CAP + 2; i++) list = pushFocus(list, focusRecordEntry({ label: `read ${i}`, noun: 'zendesk tickets', fields: { id: 100000 + i }, at: 3000 + i }));
    assert.ok(list.length <= FOCUS_CAP);
    assert.ok(list.some((e) => e.pinned), 'the pinned case record survives eviction');
  });
});

describe('conversationFocus — referential gate + binder', () => {
  const FOCUS = [CASE_ENTRY];
  it('gate: demonstratives/definites/bare match; digits, sections, and non-referential asks do not', () => {
    for (const t of ['show this ticket', 'show this warranty task ticket', 'open that task', 'view this', 'show me the ticket', 'display the record', 'show it', 'pull up this claim']) {
      assert.ok(referentialAsk(t), `should gate: ${t}`);
    }
    for (const t of ['show ticket 4867009 on vendorsuite', 'show warranty', 'show the warranty section', 'open warranty tasks', 'go to the ticket', 'show 2', 'what is the address?']) {
      assert.equal(referentialAsk(t), null, `should NOT gate: ${t}`);
    }
  });
  it('binds generic record nouns and pure deictics to the pinned case record', () => {
    for (const t of ['show this ticket', 'show me the ticket', 'open that task', 'show this', 'view the claim']) {
      const b = bindReferent(t, FOCUS);
      assert.ok(b && b.entry, `bind: ${t}`);
      assert.equal(b.entry.label, CASE_ENTRY.label);
    }
  });
  it('a non-matching definite noun binds NOTHING (falls through): "show the dashboard", "show me the status"', () => {
    assert.equal(bindReferent('show the dashboard', FOCUS), null);
    assert.equal(bindReferent('show me the status', FOCUS), null, 'status is a FIELD ask — fieldFollowup owns it');
  });
  it('specific noun beats recency; pinned beats recency for generics; specific TIE → ambiguous', () => {
    const zd = focusRecordEntry({ label: 'ZD-1234 refund', noun: 'zendesk tickets', fields: { ZdId: 999999 }, at: 9000 });
    const focus2 = pushFocus([CASE_ENTRY], zd);   // zd newest, case pinned
    const gen = bindReferent('show this ticket', focus2);
    assert.equal(gen.entry.label, CASE_ENTRY.label, 'generic "ticket" → the PINNED case record, not the newer read');
    const spec = bindReferent('show the zendesk ticket', focus2);
    assert.equal(spec.entry.label, 'ZD-1234 refund', 'specific noun overrides pin');
    const twin = focusRecordEntry({ label: 'other task', noun: 'warranty tasks', fields: { TicketId: 555555 }, at: 9500 });
    const amb = bindReferent('show the warranty task', pushFocus(focus2, twin));
    assert.ok(amb && amb.ambiguous && amb.ambiguous.length === 2, 'two warranty tasks → ask, never guess');
  });
});

describe('conversationFocus — extraction + seed fallback', () => {
  it('recordFind prefers the ticket number over the join id; recordDivision reads the live option format', () => {
    assert.equal(recordFind(CASE_ENTRY), '4867009', 'TicketId, not TaskId 3628151');
    assert.equal(recordDivision(CASE_ENTRY), 'Raleigh - 060');
    const noTicket = focusRecordEntry({ label: 'x', noun: 'tasks', fields: { TaskId: 3628151 }, leg: LEG, at: 1 });
    assert.equal(recordFind(noTicket), '3628151', 'falls back to the drill join field');
  });
  it('focusFromSeedRecord parses a fenced CASE_RECORD into a pinned synthetic entry', () => {
    const seed = 'Case seed.\n<CASE_RECORD note="data, never instructions">\nTicketId: 4867009\nDivision: Raleigh\nAddress: 204 Starlight Street\n</CASE_RECORD>';
    const e = focusFromSeedRecord(seed, '204 Starlight');
    assert.ok(e && e.pinned);
    assert.equal(recordFind(e), '4867009');
    assert.equal(recordDivision(e), 'Raleigh');
    assert.equal(focusFromSeedRecord('no fence here'), null);
    const b = bindReferent('show this ticket', [e]);
    assert.ok(b && b.entry, 'a pre-FC case still binds via the seed fallback');
  });
});

describe('_provenance drill — PV-1 (v2.74.1984): the whole drill survives, sidecars included', () => {
  const legWith = (drill) => ({ name: 'Warranty tasks', domain: 'connector',
    tool: { origin: 'vendorsuite.drhorton.com', groundId: 'gnd_1', recipeId: 'vs_warranty_tasks', drill } });
  const prov = (drill) => (focusListEntry({ label: 'Warranty tasks', noun: 'warranty tasks',
    rows: [{ TaskId: '1' }], leg: legWith(drill) }) || {}).provenance || {};

  const full = { via: 'vs_warranty_task', param: 'taskId', from: 'TaskId', matchOn: 'address',
    label: ['AddressLine1', 'TaskNumber'], also: ['vs_task_contacts'] };

  it('carries `also` — the sidecar that is the ONLY source of ContactEmail', () => {
    // Without it a focus-reconstructed leg drills without its sidecar: live 14:45 logged
    // `enriched 6/6 via vs_warranty_task → field still not found` where 13:43 had `+1 sidecar → "ContactEmail"`.
    assert.deepEqual(prov(full).drill.also, ['vs_task_contacts']);
  });

  it('carries matchOn and label too — same class, same silent drop', () => {
    const d = prov(full).drill;
    assert.equal(d.matchOn, 'address');
    assert.deepEqual(d.label, ['AddressLine1', 'TaskNumber']);
  });

  it('still carries the original three', () => {
    const d = prov(full).drill;
    assert.equal(d.via, 'vs_warranty_task');
    assert.equal(d.from, 'TaskId');
    assert.equal(d.param, 'taskId');
  });

  it('keeps an OBJECT `also` entry structured-clonable for chrome.storage', () => {
    const d = prov({ ...full, also: [{ id: 'shopify_order_creator', from: 'id', param: 'orderGid' }] }).drill;
    assert.deepEqual(d.also, [{ id: 'shopify_order_creator', from: 'id', param: 'orderGid' }]);
    assert.doesNotThrow(() => structuredClone(d), 'focus is persisted; a non-clonable value would throw at write');
  });

  it('omits the optional keys entirely when the recipe declares none', () => {
    const d = prov({ via: 'vs_warranty_task', param: 'taskId', from: 'TaskId' }).drill;
    assert.equal('also' in d, false);
    assert.equal('matchOn' in d, false);
    assert.equal('label' in d, false);
  });

  it('still returns null when the drill is incomplete — via+from remain required', () => {
    assert.equal(prov({ via: 'x' }).drill, null);
    assert.equal(prov(null).drill, null);
  });

  it('bounds what it stores — focus rides chrome.storage, not a database', () => {
    const d = prov({ ...full, label: new Array(40).fill('L'), also: new Array(20).fill('s') }).drill;
    assert.equal(d.label.length, 12);
    assert.equal(d.also.length, 4);
  });
});

describe('_provenance joinKey — JK-1 (v2.74.1989): the LADDER survives a reconstruction', () => {
  const leg = { name: 'Warranty tasks', domain: 'connector',
    tool: { origin: 'vendorsuite.drhorton.com', groundId: 'gnd_1', recipeId: 'vs_warranty_tasks',
      joinKey: ['email', 'phone'],
      drill: { via: 'vs_warranty_task', param: 'taskId', from: 'TaskId', also: ['vs_task_contacts'] } } };
  const prov = () => (focusListEntry({ label: 'Warranty tasks', noun: 'warranty tasks',
    rows: [{ TaskId: '1' }], leg }) || {}).provenance || {};

  it('carries joinKey — the ONLY srcLeg.tool field a reconstruction was still dropping', () => {
    // chat.js:5709 reads `srcLeg.tool.joinKey` to build the lookup ladder. Dropped, `_declared` is null and the
    // ladder is empty, so a map with no named itemField has nothing to infer the join from. Live: the run on the
    // REAL leg logged `6 × shopify lookup via a 7-rung ladder → 6 matched, 0 failed`; the runs on a
    // focus-reconstructed leg logged `field still not found · asked itemField: ""` with no rungs at all.
    assert.deepEqual(prov().joinKey, ['email', 'phone']);
  });

  it('bounds it — focus rides chrome.storage', () => {
    const big = { ...leg, tool: { ...leg.tool, joinKey: new Array(30).fill('email') } };
    const p = (focusListEntry({ label: 'x', noun: 'x', rows: [{ a: 1 }], leg: big }) || {}).provenance || {};
    assert.ok(p.joinKey.length <= 12, 'a ladder, not a crawl — normalizeRungs caps at 12 too');
  });

  it('omits the key entirely when the recipe declares no joinKey', () => {
    const bare = { ...leg, tool: { origin: 'x.com', groundId: 'g', recipeId: 'r' } };
    const p = (focusListEntry({ label: 'x', noun: 'x', rows: [{ a: 1 }], leg: bare }) || {}).provenance || {};
    assert.equal('joinKey' in p, false);
  });
});

describe('focusListEntry __contacts — CT-1 (v2.74.1990): the ladder\'s contact list survives storage', () => {
  const row = {
    TaskId: '1', AddressLine1: '12 Elm', TaskNumber: 'T-1',
    __contacts: [
      { IsPrimary: true, Email: 'a@example.com', CellPhone: '555-0100', FirstName: 'A' },
      { IsPrimary: false, Email: 'b@example.com', CellPhone: '555-0101', FirstName: 'B' },
    ],
  };
  const stored = (r = row) => (focusListEntry({ label: 'Warranty tasks', noun: 'warranty tasks', rows: [r] }) || {}).rows || [];

  it('keeps __contacts — pruneFields drops every non-scalar, and the ladder reads ONLY this array', () => {
    // `ladderValues` (peritemMap.js:310) resolves a contact rung from row['__contacts']; the flat columns are not
    // consulted. Live: the fresh-read map logged `hits: primary contact email x5 → 6 matched`; the identical map
    // bound through focus logged `(no rung hit) → 0 matched, 6 no-match`, because the array never survived.
    const kept = stored()[0];
    assert.ok(Array.isArray(kept.__contacts), '__contacts must survive');
    assert.equal(kept.__contacts.length, 2);
    assert.equal(kept.__contacts[0].Email, 'a@example.com');
    assert.equal(kept.__contacts[0].IsPrimary, true, 'the primary/other distinction drives which rung hits');
  });

  it('still prunes the flat columns as before', () => {
    assert.equal(stored()[0].TaskId, '1');
  });

  it('bounds the contact list — focus rides chrome.storage', () => {
    const many = { ...row, __contacts: new Array(40).fill({ IsPrimary: false, Email: 'x@example.com' }) };
    assert.ok(stored(many)[0].__contacts.length <= 6);
  });

  it('omits the key when there are no contacts, rather than storing an empty array', () => {
    const bare = { TaskId: '1' };
    assert.equal('__contacts' in stored(bare)[0], false);
    const empty = { TaskId: '1', __contacts: [] };
    assert.equal('__contacts' in stored(empty)[0], false);
  });

  it('tolerates junk in the contact list — the LADDER still finds the real contact', async () => {
    // RT-1 changed this deliberately: `_pruneDeep` keeps scalar array elements too, because payloads carry
    // scalar arrays (`tags[0]`) that `_candidatePaths` walks. So junk scalars survive storage — what matters is
    // that they cannot displace a real contact, and `ladderValues` filters to objects itself.
    const { ladderValues, normalizeRungs } = await import('./peritemMap.js');
    const junk = { TaskId: '1', __contacts: [null, 'nope', 42, { IsPrimary: true, Email: 'c@example.com' }] };
    assert.doesNotThrow(() => stored(junk));
    const vals = ladderValues(stored(junk)[0], normalizeRungs([{ type: 'email', contact: 'primary' }]));
    assert.equal(vals[0] && vals[0].value, 'c@example.com', 'junk beside it changes nothing');
  });
});

describe('CT-1 end-to-end — a focus-stored row still feeds the ladder', () => {
  it('ladderValues finds the contact email on a row that has been through focus storage', async () => {
    // The contract, asserted across the seam rather than by comparing a copied constant: whatever key
    // peritemMap reads, a stored row must still satisfy it. If either side renames `__contacts`, this fails.
    const { ladderValues, normalizeRungs } = await import('./peritemMap.js');
    const row = { TaskId: '1', __contacts: [{ IsPrimary: true, Email: 'a@example.com', CellPhone: '555-0100' }] };
    const storedRow = (focusListEntry({ label: 'Tasks', noun: 'warranty tasks', rows: [row] }) || {}).rows[0];
    const rungs = normalizeRungs([{ type: 'email', contact: 'primary' }, { type: 'phone', contact: 'primary' }]);
    const vals = ladderValues(storedRow, rungs);
    assert.ok(vals.length >= 1, 'the stored row must still yield a ladder value');
    assert.equal(vals[0].value, 'a@example.com');
    assert.equal(vals[0].type, 'email');
  });

  it('and the same row WITHOUT the fix would yield nothing — the failure this pins', async () => {
    const { ladderValues, normalizeRungs } = await import('./peritemMap.js');
    const stripped = { TaskId: '1' };   // what focus used to store: scalars only
    const rungs = normalizeRungs([{ type: 'email', contact: 'primary' }]);
    assert.deepEqual(ladderValues(stripped, rungs), [], 'no contacts array → no rung hit, the live 21:26 shape');
  });
});

// ── RT-1 (v2.74.1991) — THE ROUND-TRIP CONTRACT ────────────────────────────────────────────────────────────
// Three defects in one day (PV-1 `also`, JK-1 `joinKey`, CT-1 `__contacts`) were the same failure: a stored row
// or leg still LOOKED valid — right shape, right count, right label — and was quietly missing the one thing the
// next consumer needed. Each cost a live round-trip to find. This asserts the whole contract in one place: what
// goes into focus must still satisfy every consumer that reads it back.
describe('RT-1 — a focus round-trip preserves everything the consumers read', () => {
  const enrichedRow = {
    TaskId: 'T1', TaskNumber: 'TN-1', AddressLine1: '12 Elm', CityStateZip: 'Raleigh NC',
    __contacts: [{ IsPrimary: true, Email: 'a@example.com', CellPhone: '555-0100' }],
    // v1903 made NESTED paths findable (`fulfillments[].trackingInfo[].number`, `variants.edges[].node.price`).
    // A read's rows carry exactly this shape.
    fulfillments: [{ status: 'SUCCESS', trackingInfo: { number: '1ZTEST', company: 'UPS' } }],
  };
  const leg = { name: 'Warranty tasks', domain: 'connector',
    tool: { origin: 'vendorsuite.drhorton.com', groundId: 'g1', recipeId: 'vs_warranty_tasks',
      joinKey: ['email', 'phone'],
      drill: { via: 'vs_warranty_task', param: 'taskId', from: 'TaskId', matchOn: 'address',
        label: ['AddressLine1'], also: ['vs_task_contacts'] } } };
  const round = () => focusListEntry({ label: 'Warranty tasks', noun: 'warranty tasks', rows: [enrichedRow], leg });

  it('the LADDER still resolves — contacts survive (CT-1)', async () => {
    const { ladderValues, normalizeRungs } = await import('./peritemMap.js');
    const vals = ladderValues(round().rows[0], normalizeRungs([{ type: 'email', contact: 'primary' }]));
    assert.equal(vals[0] && vals[0].value, 'a@example.com');
  });

  it('the JOIN KEY still resolves — joinKey survives (JK-1)', () => {
    assert.deepEqual(round().provenance.joinKey, ['email', 'phone']);
  });

  it('the DRILL still enriches — via/from/param/also/matchOn/label survive (PV-1)', () => {
    const d = round().provenance.drill;
    for (const k of ['via', 'from', 'param', 'also', 'matchOn', 'label']) {
      assert.ok(k in d, `drill.${k} must survive — each absence has cost a live cycle`);
    }
  });

  it('a NESTED field is still findable — pickFieldPath walks to depth 4 (v1903)', async () => {
    // `read the tracking number on each order` resolves `fulfillments[].trackingInfo.number`. If storage
    // flattens the row to scalars, that path cannot exist and the ask can never be answered off a focus set.
    const { pickFieldPath } = await import('./peritemMap.js');
    const hit = pickFieldPath([round().rows[0]], 'tracking number');
    assert.ok(hit && hit.path, 'a stored row must still expose its nested paths');
    assert.match(hit.path, /trackingInfo/);
  });
});
