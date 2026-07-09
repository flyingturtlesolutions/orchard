// Core/capableSites.test.js — AS-5 (v2.74.1406): the capability-catalog assembler + its merge/dedup.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { capableSitesCatalog } from './capableSites.js';
import { CONNECTOR_RECIPES } from './connectorRecipes.js';
import { BROKER_CATALOG } from './brokerCatalog.js';

// small deterministic stand-ins so the merge logic is tested independent of the real catalogs' churn
const CUR = [
  { app: 'zendesk', appHost: 'zendesk.com' },
  { app: 'zendesk', appHost: 'zendesk.com', write: true },
  { app: 'shopify', appHost: 'admin.shopify.com', write: true },
];
const BRK = [
  { provider: 'hubspot', label: 'HubSpot', hosts: ['app.hubspot.com'], tools: [1, 2, 3] },
  { provider: 'google', label: 'Google Calendar', hosts: ['calendar.google.com'], tools: [1, 2] },
];

describe('capableSitesCatalog — curated + broker classes', () => {
  it('curated apps project as connector classes with a reads/writes offer', () => {
    const cat = capableSitesCatalog({ curated: CUR, broker: [], linkedProviders: [] });
    const zd = cat.find((e) => e.key === 'connector:zendesk');
    assert.ok(zd && zd.kind === 'connector' && zd.needsInstance === true);   // a class with no instance needs a typed instance
    assert.equal(zd.label, 'Zendesk');
    assert.deepEqual(zd.offers, ['reads + writes']);
    assert.equal(cat.find((e) => e.key === 'connector:shopify').offers[0], 'writes');   // shopify stand-in is write-only
  });
  it('a broker class shows ONLY when its provider is linked (an unlinked pick reads as dead)', () => {
    assert.equal(capableSitesCatalog({ curated: [], broker: BRK, linkedProviders: [] }).length, 0);
    const linked = capableSitesCatalog({ curated: [], broker: BRK, linkedProviders: ['hubspot'] });
    assert.equal(linked.length, 1);
    assert.equal(linked[0].key, 'broker:app.hubspot.com');
    assert.equal(linked[0].kind, 'broker');
    assert.equal(linked[0].needsInstance, false);        // broker binds its provider host directly — no instance to type
    assert.equal(linked[0].provider, 'hubspot');
  });
});

describe('capableSitesCatalog — concrete sites + the class MERGE', () => {
  it('a taught Ground that belongs to a curated class MERGES: one entry, concrete origin, tagged with the class offer', () => {
    const cat = capableSitesCatalog({ curated: CUR, broker: [], grounds: [{ url: 'https://deako.zendesk.com/agent', caps: 5, groundId: 'g1' }] });
    // NOT two rivals — the connector:zendesk class is absorbed by the concrete instance
    assert.equal(cat.filter((e) => e.host.endsWith('zendesk.com')).length, 1);
    const site = cat.find((e) => e.host === 'deako.zendesk.com');
    assert.ok(site && site.kind === 'site' && site.concrete === true);
    assert.equal(site.origin, 'https://deako.zendesk.com');
    assert.equal(site.groundId, 'g1');
    assert.ok(site.offers.includes('5 taught'));
    assert.ok(site.offers.some((o) => o.startsWith('Zendesk')));     // tagged with the curated offer
    // shopify has no instance → stays a connector class
    assert.ok(cat.some((e) => e.key === 'connector:shopify'));
  });
  it('a Ground with ZERO capabilities is excluded; caps dedupe by host (max wins)', () => {
    const cat = capableSitesCatalog({ curated: [], broker: [], grounds: [
      { url: 'https://empty.example.com', caps: 0 },
      { url: 'https://x.example.com', caps: 2, groundId: 'a' },
      { url: 'https://x.example.com/other', caps: 7, groundId: 'a' },   // same host → one entry, higher cap count
    ] });
    assert.equal(cat.filter((e) => e.host === 'empty.example.com').length, 0);
    const x = cat.find((e) => e.host === 'x.example.com');
    assert.ok(x && x.offers.includes('7 taught'));
  });
  it('an origin connected in another app becomes a concrete site even with no taught caps', () => {
    const cat = capableSitesCatalog({ curated: [], broker: [], connections: [{ origin: 'https://help.acme.io', label: 'Acme' }] });
    const s = cat.find((e) => e.host === 'help.acme.io');
    assert.ok(s && s.kind === 'site' && s.concrete === true);
    assert.equal(s.label, 'Acme');
  });
  it('concrete taught sites sort before connector classes before broker', () => {
    const cat = capableSitesCatalog({ curated: CUR, broker: BRK, linkedProviders: ['hubspot'],
      grounds: [{ url: 'https://deako.zendesk.com', caps: 3, groundId: 'g' }] });
    const kinds = cat.map((e) => e.kind);
    assert.ok(kinds.indexOf('site') < kinds.indexOf('connector'));
    assert.ok(kinds.indexOf('connector') < kinds.indexOf('broker'));
  });
});

describe('capableSitesCatalog — smoke over the REAL catalogs', () => {
  it('the shipped curated + broker catalogs assemble without throwing; every entry is well-formed', () => {
    const cat = capableSitesCatalog({ curated: CONNECTOR_RECIPES, broker: BROKER_CATALOG, linkedProviders: ['google', 'hubspot'] });
    assert.ok(Array.isArray(cat) && cat.length >= 1);
    for (const e of cat) {
      assert.ok(e.key && e.host && e.label && ['site', 'connector', 'broker'].includes(e.kind));
      assert.ok(Array.isArray(e.offers));
      assert.equal(typeof e.concrete, 'boolean');
    }
    assert.ok(cat.some((e) => e.key === 'connector:zendesk'), 'Zendesk is a selectable connector class');
    assert.ok(cat.some((e) => e.key === 'connector:shopify'), 'Shopify is a selectable connector class');
  });
});
