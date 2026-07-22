// Core/writeClause.test.js — PP-2 (v2.74.1681): the per-item WRITE clause.
//
// The load-bearing property is what the model CANNOT say: no target, no fields, no values. On a read an invented
// slot renders a wrong table; on a create it leaves wrong records behind.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeWriteVerdict, writeTally, writePreflight, WRITE_WINDOW } from './writeClause.js';

describe('writeClause — the shape is empty, and that is the design', () => {
  it('an EMPTY object is a valid verdict — nothing here can be underspecified', () => {
    const v = normalizeWriteVerdict({});
    assert.equal(v.kind, 'write');
    assert.equal(v.cap, 0);
  });

  it('null ONLY for a non-object, so a caller can tell "dropped in transit" from "thin answer"', () => {
    for (const bad of [null, undefined, 'create them', 42, []]) assert.equal(normalizeWriteVerdict(bad), null);
    assert.ok(normalizeWriteVerdict({}));
  });

  it('carries NO target, NO fields and NO values, whatever the model puts in', () => {
    // Everything a create needs comes from the DECLARATION. If any of this were honored, a model could name a
    // system it was never given, or a field value it invented, and the pipeline would write it.
    const v = normalizeWriteVerdict({
      target: { system: 'shopify' }, system: 'shopify', leg: 'shopify_create_customer',
      params: { email: 'made@up.com' }, fields: { first_name: 'Invented' }, values: ['x'],
    });
    const keys = Object.keys(v).sort();
    assert.deepEqual(keys, ['cap', 'collection', 'kind', 'why']);
    assert.equal(JSON.stringify(v).includes('made@up.com'), false);
    assert.equal(JSON.stringify(v).includes('shopify'), false);
    assert.equal(JSON.stringify(v).includes('Invented'), false);
  });

  it('cap is the ONE thing a caller may say, and it is bounded', () => {
    assert.equal(normalizeWriteVerdict({ cap: 5 }).cap, 5);
    assert.equal(normalizeWriteVerdict({ cap: 999 }).cap, WRITE_WINDOW);
    assert.equal(normalizeWriteVerdict({ cap: 0 }).cap, 0);
    assert.equal(normalizeWriteVerdict({ cap: -3 }).cap, 0);
    assert.equal(normalizeWriteVerdict({ cap: 'lots' }).cap, 0);
    assert.equal(normalizeWriteVerdict({ cap: 2.7 }).cap, 2);
  });

  it('clamps a free-text why and never lets it grow unbounded', () => {
    assert.equal(normalizeWriteVerdict({ why: 'x'.repeat(400) }).why.length, 160);
  });
});

describe('writeClause — preflight fails EARLY, with a distinguishable reason', () => {
  const leg = (writeMap) => ({ tool: { writeMap } });

  it('no candidates → a clean nothing-to-do, not an error', () => {
    assert.deepEqual(writePreflight({ misses: [], sourceLeg: leg({ x: {} }) }), { ok: false, reason: 'no-candidates' });
  });

  it('no writeMap → a CATALOG gap, distinct from a connection gap', () => {
    const r = writePreflight({ misses: [{ row: {} }], sourceLeg: leg(null) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-declaration');
  });

  it('a declared target passes, and names it', () => {
    const r = writePreflight({ misses: [{ row: {} }, { row: {} }], sourceLeg: leg({ shopify_create_customer: { email: 'X' } }) });
    assert.equal(r.ok, true);
    assert.equal(r.targetId, 'shopify_create_customer');
    assert.deepEqual(r.declared, { email: 'X' });
    assert.equal(r.count, 2);
  });

  it('degenerate input does not throw', () => {
    for (const bad of [undefined, {}, { misses: null, sourceLeg: null }]) assert.doesNotThrow(() => writePreflight(bad));
  });
});

describe('writeClause — the tally names every class including the zeroes', () => {
  it('reports created / queued / blocked / unfillable', () => {
    const t = writeTally({ created: 2, queued: 1, blocked: 0, unfillable: 1 });
    assert.match(t, /2 created/);
    assert.match(t, /1 queued for approval/);
    assert.match(t, /0 not created/);
    assert.match(t, /1 can’t fill/);
  });

  it('UNFILLABLE is its own class, not folded into failures', () => {
    // "I could not fill a required field from this row" is a DECLARATION gap the user can fix; a blocked write
    // is a transient one they cannot. Collapsing them would hide the actionable half.
    const t = writeTally({ created: 0, queued: 0, blocked: 0, unfillable: 3 });
    assert.match(t, /3 can’t fill/);
    assert.match(t, /0 not created/);
  });

  it('states truncation rather than implying coverage', () => {
    assert.match(writeTally({ created: 24, capped: true, total: 40 }), /first 24 of 40/);
    assert.ok(!/first/.test(writeTally({ created: 3, total: 3 })));
  });

  it('an empty run still reads honestly', () => {
    assert.match(writeTally({}), /0 rows? — 0 created/);
  });
});
