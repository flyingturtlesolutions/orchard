// Core/connectAttention.test.js — v2.74.2043
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connectScopeOrigins, connectPanelModel } from './connectAttention.js';

describe('connectScopeOrigins', () => {
  it('unions every desk/preset tier with own connections', () => {
    const book = {
      'desk:a': { connections: [{ origin: 'https://vendorsuite.drhorton.com', label: 'VendorSuite' }] },
      'preset:p': { connections: [{ origin: 'deako.myshopify.com', label: 'Shopify' }] },
    };
    const own = [{ origin: 'https://www.ups.com', label: 'UPS' }];
    const got = connectScopeOrigins(book, own);
    assert.deepEqual(got.map((c) => c.label).sort(), ['Shopify', 'UPS', 'VendorSuite']);
  });
  it('empty book + empty own → empty (registry noise stays off Connect)', () => {
    assert.deepEqual(connectScopeOrigins({}, null), []);
  });
});

describe('connectPanelModel', () => {
  const REG = {
    'vendorsuite.drhorton.com': { origin: 'vendorsuite.drhorton.com', status: 'signed-out', lastVerifiedAt: 1000 },
    'noise.example.com': { origin: 'noise.example.com', status: 'signed-out', lastVerifiedAt: 1000 },
    'deako.myshopify.com': { origin: 'deako.myshopify.com', status: 'wrong-account', lastVerifiedAt: 2000 },
  };
  const scope = [
    { origin: 'vendorsuite.drhorton.com', label: 'VendorSuite' },
    { origin: 'deako.myshopify.com', label: 'Shopify' },
  ];

  it('scopes signed-out to desk+preset — registry noise omitted', () => {
    const m = connectPanelModel({ registry: REG, scopeOrigins: scope, incidents: [] });
    assert.equal(m.signInCount, 2);
    assert.ok(!m.cards.some((c) => c.origin.includes('noise')));
    assert.ok(m.cards.some((c) => c.kind === 'signedout' && c.label === 'VendorSuite'));
    assert.ok(m.cards.some((c) => c.kind === 'wrongaccount' && c.label === 'Shopify'));
  });

  it('badge total = sign-in cards + non-presence reconnect incidents', () => {
    const incidents = [
      { id: '1', status: 'open', cls: 'presence', subject: 'vendorsuite.drhorton.com' },
      { id: '2', status: 'open', cls: 'drift', subject: 'shopify_search', openedAt: 9 },
    ];
    const m = connectPanelModel({ registry: REG, scopeOrigins: scope, incidents });
    assert.equal(m.reconnectCount, 1);
    assert.equal(m.total, m.signInCount + m.reconnectCount);
  });

  it('checkingOrigin marks that card', () => {
    const m = connectPanelModel({
      registry: REG, scopeOrigins: scope, incidents: [],
      checkingOrigin: 'https://vendorsuite.drhorton.com',
    });
    const vs = m.cards.find((c) => c.label === 'VendorSuite');
    assert.equal(vs.checking, true);
  });

  it('empty scope → total 0 even when registry is red (no false Connect noise)', () => {
    const m = connectPanelModel({ registry: REG, scopeOrigins: [], incidents: [] });
    assert.equal(m.total, 0);
  });
});
