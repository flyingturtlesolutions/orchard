// Core/connectionScope.test.js — CS-1 (v2.74.1996): the connection SCOPE ladder (desk + preset, inherited).
// The regression this file exists for is the fourth occurrence of
// INCIDENT[class=connection-scoped-per-conversation-silently-drops-legs]: a NON-EMPTY own set that is merely
// missing one bound ground must still inherit it (a create-time "seed only when empty" would not).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCOPE_KEY, MAX_PER_SCOPE, connKey, normalizeConnection, mergeConnections, scopeIdsFor, scopeConnections,
  inheritedConnections, resolveConnections, excludedOrigins, bindScope, bindScopes, setScope, unbindScopes, forgetScope,
} from './connectionScope.js';

const VS = { origin: 'https://vendorsuite.drhorton.com', label: 'VendorSuite' };
const SHOP = { origin: 'https://admin.shopify.com', label: 'Shopify' };
const UPS = { origin: 'https://www.ups.com', label: 'UPS' };
const UPS_ADOPTED = { origin: 'www.ups.com', label: 'www.ups.com' };   // the TRT-5 adopt shape: a bare host, label = origin

const origins = (list) => list.map((c) => c.origin);

describe('connectionScope — connKey (the origin/host duality setup and adopt each bank differently)', () => {
  it('an origin and a bare host are the SAME connection', () => {
    assert.equal(connKey('https://www.ups.com'), 'www.ups.com');
    assert.equal(connKey('www.ups.com'), 'www.ups.com');
    assert.equal(connKey('HTTPS://WWW.UPS.COM/'), 'www.ups.com');
    assert.equal(connKey('http://www.ups.com/us/en/home?x=1'), 'www.ups.com');
  });
  it('junk keys to empty (so it can never bind)', () => {
    assert.equal(connKey(''), '');
    assert.equal(connKey(null), '');
    assert.equal(connKey('   '), '');
  });
  it('www is NOT stripped — www.ups.com is the real host the recipes are stored under', () => {
    assert.notEqual(connKey('https://www.ups.com'), connKey('https://ups.com'));
  });
});

describe('connectionScope — normalizeConnection', () => {
  it('needs an origin; label defaults to it', () => {
    assert.equal(normalizeConnection({ label: 'no origin' }), null);
    assert.equal(normalizeConnection(null), null);
    assert.deepEqual(normalizeConnection({ origin: 'www.ups.com' }), { origin: 'www.ups.com', label: 'www.ups.com' });
  });
});

describe('connectionScope — mergeConnections', () => {
  it('dedups across the origin/host duality — one UPS, not two (else every ride leg projects twice)', () => {
    const merged = mergeConnections([UPS], [UPS_ADOPTED]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0], { origin: 'https://www.ups.com', label: 'UPS' });
  });
  it('a later SCHEMED duplicate upgrades a kept bare host', () => {
    const merged = mergeConnections([UPS_ADOPTED], [UPS]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].origin, 'https://www.ups.com');   // scheme won
    assert.equal(merged[0].label, 'UPS');                    // real label beat the placeholder
  });
  it('a real label never degrades to a placeholder', () => {
    const merged = mergeConnections([UPS], [UPS_ADOPTED]);
    assert.equal(merged[0].label, 'UPS');
  });
  it('order is first-wins and inputs are not mutated', () => {
    const own = [{ ...VS }];
    const merged = mergeConnections(own, [SHOP, VS]);
    assert.deepEqual(origins(merged), [VS.origin, SHOP.origin]);
    assert.deepEqual(own, [VS]);
  });
  it('drops junk entries instead of banking them', () => {
    assert.deepEqual(mergeConnections([null, {}, { origin: '  ' }, 'nope']), []);
  });
});

describe('connectionScope — scopeIdsFor (desk → preset, most specific first)', () => {
  it('a desk carries both tiers', () => {
    assert.deepEqual(scopeIdsFor({ instanceId: 'i1', presetId: 'warranty', appId: 'warranty' }), ['desk:i1', 'preset:warranty']);
  });
  it('a CASE has its own instanceId and no presetId — it reaches its desk through appId', () => {
    assert.deepEqual(scopeIdsFor({ instanceId: 'child', appId: 'warranty', parentId: 'p1' }), ['desk:child', 'preset:warranty']);
  });
  it('the Front desk (no appId / no instanceId) is scope-less — own reach only, by design', () => {
    assert.deepEqual(scopeIdsFor({ id: 'overview', kind: 'agent' }), []);
    assert.deepEqual(scopeIdsFor(null), []);
  });
});

describe('connectionScope — bindScope / bindScopes', () => {
  it('binds into a tier, copy-on-write', () => {
    const book = {};
    const next = bindScope(book, 'desk:i1', [UPS], 1000);
    assert.deepEqual(book, {});
    assert.deepEqual(origins(scopeConnections(next, 'desk:i1')), [UPS.origin]);
    assert.equal(next['desk:i1'].updatedAt, 1000);
  });
  it('re-binding the SAME set returns the same book (no pointless storage write)', () => {
    const one = bindScope({}, 'desk:i1', [UPS], 1000);
    assert.equal(bindScope(one, 'desk:i1', [UPS], 2000), one);
    assert.equal(bindScope(one, 'desk:i1', [UPS_ADOPTED], 2000), one);   // the host form is the same connection
  });
  it('a bind with nothing usable is a no-op', () => {
    const book = { 'desk:i1': { connections: [UPS], updatedAt: 1 } };
    assert.equal(bindScope(book, 'desk:i1', [], 2), book);
    assert.equal(bindScope(book, '', [SHOP], 2), book);
  });
  it('bindScopes writes DESK and PRESET together — that is what a later thread inherits', () => {
    const book = bindScopes({}, ['desk:i1', 'preset:warranty'], [VS, SHOP], 5);
    assert.deepEqual(origins(scopeConnections(book, 'desk:i1')), [VS.origin, SHOP.origin]);
    assert.deepEqual(origins(scopeConnections(book, 'preset:warranty')), [VS.origin, SHOP.origin]);
  });
  it('a tier is capped so a runaway adopt loop cannot grow the book without bound', () => {
    const many = Array.from({ length: MAX_PER_SCOPE + 10 }, (_, i) => ({ origin: `https://h${i}.example.com`, label: `h${i}` }));
    assert.equal(scopeConnections(bindScope({}, 'desk:i1', many, 1), 'desk:i1').length, MAX_PER_SCOPE);
  });
});

describe('connectionScope — resolveConnections (THE regression: union, not fallback)', () => {
  const book = bindScopes({}, ['desk:i1', 'preset:warranty'], [UPS], 1);
  const ids = scopeIdsFor({ instanceId: 'i1', presetId: 'warranty' });

  it('a NON-EMPTY own set still inherits the missing ground — the live 11:45 failure', () => {
    // own = VendorSuite + Shopify (the 73 ride legs that DID project); UPS was bound elsewhere and dropped.
    const effective = resolveConnections([VS, SHOP], book, ids);
    assert.deepEqual(origins(effective), [VS.origin, SHOP.origin, UPS.origin]);
  });
  it('a brand-new thread with NO own connections starts with the desk/preset reach', () => {
    assert.deepEqual(origins(resolveConnections([], book, ids)), [UPS.origin]);
    assert.deepEqual(origins(resolveConnections(null, book, ids)), [UPS.origin]);
  });
  it('own leads and keeps its curated label — inheritance never overwrites an explicit bind', () => {
    const withHostForm = bindScopes({}, ['preset:warranty'], [UPS_ADOPTED], 1);
    const effective = resolveConnections([UPS], withHostForm, ['preset:warranty']);
    assert.equal(effective.length, 1);
    assert.deepEqual(effective[0], { origin: 'https://www.ups.com', label: 'UPS' });
  });
  it('a scope-less surface inherits nothing — the TRT-5 membrane is not dissolved', () => {
    assert.deepEqual(resolveConnections([], book, []), []);
    assert.deepEqual(origins(resolveConnections([VS], book, scopeIdsFor({}))), [VS.origin]);
  });
  it('another preset does NOT inherit — the scope is desk + preset, never global', () => {
    assert.deepEqual(resolveConnections([], book, scopeIdsFor({ instanceId: 'other', presetId: 'callmgr' })), []);
  });
  it('the DESK tier alone carries a sibling-free binding across new threads', () => {
    const deskOnly = bindScope({}, 'desk:i1', [SHOP], 1);
    assert.deepEqual(origins(resolveConnections([], deskOnly, ['desk:i1', 'preset:warranty'])), [SHOP.origin]);
  });
  it('desk-tier entries lead preset-tier entries (most specific first)', () => {
    let b = bindScope({}, 'preset:warranty', [SHOP], 1);
    b = bindScope(b, 'desk:i1', [VS], 1);
    assert.deepEqual(origins(inheritedConnections(b, ['desk:i1', 'preset:warranty'])), [VS.origin, SHOP.origin]);
  });
});

describe('connectionScope — setScope (setup Confirm is authoritative for the DESK tier)', () => {
  it('REPLACES the tier rather than accreting — a de-selected site really leaves it', () => {
    const book = bindScope({}, 'desk:i1', [VS, SHOP, UPS], 1);
    const next = setScope(book, 'desk:i1', [VS, SHOP], 2);
    assert.deepEqual(origins(scopeConnections(next, 'desk:i1')), [VS.origin, SHOP.origin]);
  });
  it('an empty selection drops the tier entirely', () => {
    assert.deepEqual(setScope(bindScope({}, 'desk:i1', [UPS], 1), 'desk:i1', [], 2), {});
  });
  it('an unchanged selection returns the same book (no pointless storage write)', () => {
    const book = bindScope({}, 'desk:i1', [VS], 1);
    assert.equal(setScope(book, 'desk:i1', [VS], 2), book);
  });
  it('the PRESET tier is left to bindScope — a shared pool one desk must not strip', () => {
    let book = bindScopes({}, ['desk:i1', 'preset:warranty'], [VS, UPS], 1);
    book = setScope(book, 'desk:i1', [VS], 2);
    assert.deepEqual(origins(scopeConnections(book, 'desk:i1')), [VS.origin]);
    assert.deepEqual(origins(scopeConnections(book, 'preset:warranty')), [VS.origin, UPS.origin]);
  });
});

describe('connectionScope — excludedOrigins + exclusion (a de-selection is not handed straight back)', () => {
  const ids = ['desk:i1', 'preset:warranty'];

  it('names the tiers-would-grant sites the user did not pick', () => {
    const book = bindScopes({}, ids, [VS, SHOP, UPS], 1);
    assert.deepEqual(excludedOrigins(inheritedConnections(book, ids), [VS, SHOP]), ['www.ups.com']);
  });
  it('is empty when the selection covers everything inherited', () => {
    const book = bindScopes({}, ids, [VS], 1);
    assert.deepEqual(excludedOrigins(inheritedConnections(book, ids), [VS, SHOP]), []);
    assert.deepEqual(excludedOrigins([], [VS]), []);
  });
  it('the preset tier cannot resurrect a de-selected ground', () => {
    // desk i1 de-selects UPS; a sibling desk of the same preset keeps it bound in the shared tier.
    let book = bindScopes({}, ids, [VS, UPS], 1);
    book = setScope(book, 'desk:i1', [VS], 2);
    const excluded = excludedOrigins(inheritedConnections(book, ids), [VS]);
    assert.deepEqual(excluded, ['www.ups.com']);
    assert.deepEqual(origins(resolveConnections([VS], book, ids, excluded)), [VS.origin]);
  });
  it('a sibling desk of the same preset still inherits it (the exclusion is per-desk)', () => {
    const book = bindScopes({}, ids, [VS, UPS], 1);
    assert.deepEqual(origins(resolveConnections([], book, ['desk:i2', 'preset:warranty'])), [VS.origin, UPS.origin]);
  });
  it('an OWN entry beats a stale exclusion — an explicit bind is never swallowed', () => {
    const book = bindScopes({}, ids, [UPS], 1);
    assert.deepEqual(origins(resolveConnections([UPS], book, ids, ['www.ups.com'])), [UPS.origin]);
  });
  it('exclusion matches either origin form', () => {
    const book = bindScopes({}, ids, [UPS_ADOPTED], 1);
    assert.deepEqual(resolveConnections([], book, ids, ['https://www.ups.com/']), []);
  });
  it('a junk/empty exclusion list changes nothing', () => {
    const book = bindScopes({}, ids, [UPS], 1);
    assert.deepEqual(origins(resolveConnections([], book, ids, null)), [UPS.origin]);
    assert.deepEqual(origins(resolveConnections([], book, ids, ['', '   '])), [UPS.origin]);
  });
});

describe('connectionScope — unbindScopes / forgetScope (inheritance is a default, not a lock)', () => {
  it('removes an origin from every tier, in either origin form', () => {
    const book = bindScopes({}, ['desk:i1', 'preset:warranty'], [VS, UPS], 1);
    const next = unbindScopes(book, ['desk:i1', 'preset:warranty'], 'www.ups.com');
    assert.deepEqual(origins(scopeConnections(next, 'desk:i1')), [VS.origin]);
    assert.deepEqual(origins(scopeConnections(next, 'preset:warranty')), [VS.origin]);
  });
  it('emptying a tier drops the tier rather than leaving a husk', () => {
    const book = bindScope({}, 'desk:i1', [UPS], 1);
    assert.deepEqual(unbindScopes(book, ['desk:i1'], UPS.origin), {});
  });
  it('unbinding something absent is a no-op on the same book', () => {
    const book = bindScope({}, 'desk:i1', [UPS], 1);
    assert.equal(unbindScopes(book, ['desk:i1'], 'nowhere.example.com'), book);
    assert.equal(unbindScopes(book, ['desk:i1'], ''), book);
  });
  it('forgetScope drops a whole tier (a deleted desk leaves no reach behind)', () => {
    const book = bindScopes({}, ['desk:i1', 'preset:warranty'], [UPS], 1);
    const next = forgetScope(book, 'desk:i1');
    assert.deepEqual(Object.keys(next), ['preset:warranty']);
    assert.equal(forgetScope(next, 'desk:i1'), next);
  });
});

describe('connectionScope — the store key is stable (chrome.storage.local, survives a browser restart)', () => {
  it('SCOPE_KEY', () => { assert.equal(SCOPE_KEY, 'conn:scope'); });
});
