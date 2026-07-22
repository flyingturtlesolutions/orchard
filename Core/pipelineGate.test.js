// Core/pipelineGate.test.js — the pipeline's own gate (v2.74.1665).
//
// The load-bearing case is the fail-closed default: an action that declares NEITHER axis must be QUEUED, because
// that failure is silent — an unreviewed write simply happens.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { gateAction, gateComposite, gateItem, gateLine, gateTally, NEVER_UNATTENDED, GATE_DECISIONS } from './pipelineGate.js';

const A = (over = {}) => ({ what: 'draft order', reversible: true, outward: false, ...over });

describe('pipelineGate — the user\'s stated policy falls out with no special-casing (§4)', () => {
  it('create customer — internal + reversible → auto', () => {
    assert.equal(gateAction({ what: 'create customer', reversible: true, outward: false }).decision, 'auto');
  });
  it('draft order — internal + reversible → auto', () => {
    assert.equal(gateAction(A()).decision, 'auto');
  });
  it('CONFIRM order — outward + irreversible → queued', () => {
    assert.equal(gateAction({ what: 'confirm order', reversible: false, outward: true }).decision, 'queued');
  });
  it('SEND email — outward → queued even though a sent email is "reversible" by apology', () => {
    const r = gateAction({ what: 'send email', reversible: true, outward: true });
    assert.equal(r.decision, 'queued');
    assert.match(r.why, /leaves our boundary/);
  });
  it('irreversible but internal → queued', () => {
    assert.equal(gateAction({ what: 'delete record', reversible: false, outward: false }).decision, 'queued');
  });
});

describe('pipelineGate — DEFAULTS FAIL CLOSED (the one that must)', () => {
  it('declaring NEITHER axis is queued, not auto', () => {
    const r = gateAction({ what: 'mystery write' });
    assert.equal(r.decision, 'queued');
    assert.match(r.why, /undeclared write is an unreviewed write/);
  });
  it('declaring only ONE axis is still queued — a half-declaration is not a declaration', () => {
    assert.equal(gateAction({ what: 'x', reversible: true }).decision, 'queued');
    assert.equal(gateAction({ what: 'x', outward: false }).decision, 'queued');
  });
  it('UNDECLARED is not the same as false — only an explicit boolean can relax the gate', () => {
    assert.equal(gateAction({ what: 'x', reversible: undefined, outward: undefined }).decision, 'queued');
    assert.equal(gateAction({ what: 'x', reversible: null, outward: null }).decision, 'queued');
    assert.equal(gateAction({ what: 'x', reversible: 'yes', outward: 'no' }).decision, 'queued', 'a truthy string is not a declaration');
  });
  it('an empty action object is queued', () => {
    assert.equal(gateAction({}).decision, 'queued');
    assert.equal(gateAction().decision, 'queued');
  });
});

describe('pipelineGate — classes that stay human-click-only', () => {
  it('money and inventory are REFUSED regardless of friendly-looking axes', () => {
    for (const klass of NEVER_UNATTENDED) {
      const r = gateAction({ what: 'x', klass, reversible: true, outward: false });
      assert.equal(r.decision, 'refused', `${klass} must not be reachable by declaring booleans`);
    }
  });
  it('refused outranks the axes entirely', () => {
    assert.equal(gateAction({ what: 'charge card', klass: 'money', reversible: true, outward: false }).decision, 'refused');
  });
});

describe('pipelineGate — composites derive from members, never independently (§4)', () => {
  it('an UPSERT containing a gated create is gated', () => {
    const r = gateComposite([
      { what: 'lookup', reversible: true, outward: false },
      { what: 'create customer', reversible: true, outward: false },
      { what: 'send confirmation', reversible: true, outward: true },
    ], { what: 'upsert+notify' });
    assert.equal(r.decision, 'queued');
    assert.match(r.why, /leaves our boundary/);
  });
  it('all-internal members → auto', () => {
    const r = gateComposite([A(), { what: 'create customer', reversible: true, outward: false }]);
    assert.equal(r.decision, 'auto');
  });
  it('a refused member refuses the whole composite', () => {
    assert.equal(gateComposite([A(), { what: 'charge', klass: 'money' }]).decision, 'refused');
  });
  it('an UNDECLARED member gates the composite — a member cannot opt out by staying silent', () => {
    assert.equal(gateComposite([A(), { what: 'mystery' }]).decision, 'queued');
  });
  it('no members → queued, never auto', () => {
    assert.equal(gateComposite([]).decision, 'queued');
  });
});

describe('pipelineGate — per item', () => {
  it('one queued action makes the whole item attended', () => {
    const g = gateItem([A(), { what: 'send email', reversible: true, outward: true }]);
    assert.equal(g.unattended, false);
    assert.equal(g.queued, 1);
  });
  it('all-auto items may run unattended', () => {
    const g = gateItem([A(), { what: 'create customer', reversible: true, outward: false }]);
    assert.equal(g.unattended, true);
    assert.equal(g.queued, 0);
  });
  it('an item with NO actions is trivially unattended', () => {
    assert.equal(gateItem([]).unattended, true);
  });
  it('every decision it returns is in the declared set', () => {
    const g = gateItem([A(), { what: 'x' }, { what: 'y', klass: 'money' }]);
    for (const a of g.actions) assert.ok(GATE_DECISIONS.includes(a.decision));
  });
});

describe('pipelineGate — reporting (§5.5)', () => {
  it('the line reports EVERY decision, autos included', () => {
    assert.match(gateLine('Task A', A(), gateAction(A())), /GATE   ▸ item=Task A draft order → auto$/);
    assert.match(gateLine('Task A', { what: 'send email' }, gateAction({ what: 'send email' })), /→ queued\(/);
  });
  it('the tally names every class including the zeroes', () => {
    const t = gateTally([{ decision: 'auto' }, { decision: 'queued' }]);
    assert.match(t, /1 auto/); assert.match(t, /1 queued/); assert.match(t, /0 refused/);
  });
});
