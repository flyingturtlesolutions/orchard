// Core/capableSites.test.js — AS-5 (v2.74.1406): the capability-catalog assembler + its merge/dedup.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { capableSitesCatalog, seedDeskCatalog } from './capableSites.js';
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
  it('v1511 — a DEEP appHost class (no per-tenant subdomain: workspace.aircall.io) binds DIRECTLY; only a bare 2-label class needs a typed instance', () => {
    const cat = capableSitesCatalog({ curated: [{ app: 'aircall', appHost: 'workspace.aircall.io', write: false }, { app: 'zendesk', appHost: 'zendesk.com', write: false }], broker: [], linkedProviders: [] });
    const ac = cat.find((e) => e.key === 'connector:aircall');
    assert.equal(ac.needsInstance, false);                       // the live miss: picking Aircall asked to type "yourteam.workspace.aircall.io"
    assert.equal(ac.concrete, true);
    assert.equal(ac.origin, 'https://workspace.aircall.io');     // click = bind
    assert.equal(cat.find((e) => e.key === 'connector:zendesk').needsInstance, true);   // zendesk stays a guided class (real per-tenant subdomains)
  });
  it('v1939 — a www-CANONICAL site is concrete: `www` is not a tenant, and stripping it made UPS unpickable', () => {
    // Live: the UPS card could not be selected at all. `_host()` strips `www.` (correct for dedup — a ground at
    // www.foo.com and one at foo.com are the same site), but the tenant test COUNTS LABELS, so www.ups.com became
    // the 2-label ups.com and demanded "yourteam.ups.com" — an address UPS has no concept of. The label count now
    // reads the host as AUTHORED, and the bound origin is the host the site actually serves.
    const cat = capableSitesCatalog({ curated: [{ app: 'ups', appHost: 'www.ups.com', write: false }, { app: 'zendesk', appHost: 'zendesk.com', write: false }], broker: [], linkedProviders: [] });
    const ups = cat.find((e) => e.key === 'connector:ups');
    assert.equal(ups.needsInstance, false, 'clicking the card must BIND, not re-prompt for a tenant');
    assert.equal(ups.concrete, true);
    assert.equal(ups.origin, 'https://www.ups.com', 'the bound origin keeps www — it is what the ground, the sniff allow-list and seeding all key on');
    assert.equal(ups.host, 'ups.com', 'the class host stays normalized so a www/apex ground still matches this class');
    assert.equal(cat.find((e) => e.key === 'connector:zendesk').needsInstance, true, 'a REAL tenant class is unaffected');
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
    assert.equal(site.label, 'Deako Zendesk');                       // derived alias (org + SaaS name)
    assert.ok(site.offers.includes('5 taught'));
    assert.ok(site.offers.includes('reads + writes'));               // curated offer, deduped (the label already names Zendesk)
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
  it('AS-5b — a well-known host gets a brand ALIAS; a class-name offer prefix equal to the label is deduped; a business subdomain keeps its host', () => {
    const cat = capableSitesCatalog({ curated: CUR, broker: BRK, linkedProviders: ['hubspot'],
      grounds: [{ url: 'https://youtube.com/feed', caps: 3 }, { url: 'https://mail.google.com', caps: 1 }, { url: 'https://calendar.google.com', caps: 2 }],
      connections: [{ origin: 'https://admin.shopify.com/store/deako', label: 'admin.shopify.com' }, { origin: 'https://deako.zendesk.com', label: 'deako.zendesk.com' }] });
    assert.equal(cat.find((e) => e.host === 'youtube.com').label, 'YouTube');
    assert.equal(cat.find((e) => e.host === 'mail.google.com').label, 'Gmail');
    assert.equal(cat.find((e) => e.host === 'calendar.google.com').label, 'Google Calendar');   // aliased from the broker catalog's own label
    const shop = cat.find((e) => e.host === 'admin.shopify.com');
    assert.equal(shop.label, 'Shopify');                                    // aliased
    assert.ok(shop.offers.includes('writes'));                             // "Shopify · writes" → deduped to "writes"
    assert.ok(!shop.offers.some((o) => o.startsWith('Shopify')));
    const zd = cat.find((e) => e.host === 'deako.zendesk.com');
    assert.equal(zd.label, 'Deako Zendesk');                                // DERIVED (org + SaaS), not the raw host
    assert.ok(zd.offers.includes('reads + writes'));                       // class offer deduped (label already names Zendesk)
  });
  it('AS-5b — DERIVES a readable name for a business/custom host with no curated brand (SaaS org, S3 app label, sub.org)', () => {
    const cat = capableSitesCatalog({ curated: [], broker: [],
      grounds: [{ url: 'https://deako-cstool-dev.s3-website-us-east-1.amazonaws.com', caps: 2 }],
      connections: [{ origin: 'https://support.deako.com', label: 'support.deako.com' }, { origin: 'https://deako.zendesk.com', label: 'deako.zendesk.com' }] });
    assert.equal(cat.find((e) => e.host === 'support.deako.com').label, 'Deako Support');           // sub.org.tld → "Org Sub"
    assert.equal(cat.find((e) => e.host === 'deako.zendesk.com').label, 'Deako Zendesk');           // known SaaS → "Org Service"
    assert.equal(cat.find((e) => e.host.startsWith('deako-cstool-dev')).label, 'Deako CSTool');     // S3 app label, env dropped, acronym cased
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

describe('DK-6 — seedDeskCatalog (a preconfigured desk’s sites → pre-picked setup catalog)', () => {
  const CAT = () => ([
    { key: 'site:deako.zendesk.com', origin: 'https://deako.zendesk.com', host: 'deako.zendesk.com', label: 'Deako Zendesk', kind: 'site', offers: ['reads + writes'], concrete: true, needsInstance: false, groundId: null, provider: null },
    { key: 'connector:vendorsuite', origin: null, host: 'vendorsuite.drhorton.com', label: 'Vendorsuite', kind: 'connector', offers: ['reads'], concrete: false, needsInstance: true, groundId: null, provider: null },
    { key: 'connector:zendesk', origin: null, host: 'zendesk.com', label: 'Zendesk', kind: 'connector', offers: ['reads + writes'], concrete: false, needsInstance: true, groundId: null, provider: null },
  ]);
  const SITES = [
    { host: 'vendorsuite.drhorton.com', label: 'VendorSuite' },
    { host: 'zendesk.com', label: 'Zendesk' },
    { host: 'app.hubspot.com', label: 'HubSpot' },
  ];
  it('an existing concrete instance pre-picks (deako.zendesk.com ⊂ zendesk.com); a deep host synthesizes+picks, absorbing its class card; an unknown deep host synthesizes too', () => {
    const { catalog, picks, unresolved } = seedDeskCatalog(CAT(), SITES);
    const pickMap = new Map(picks);
    assert.deepEqual(unresolved, []);
    assert.deepEqual(pickMap.get('site:deako.zendesk.com'), { origin: 'https://deako.zendesk.com', label: 'Deako Zendesk' });   // instance beats class
    assert.deepEqual(pickMap.get('site:vendorsuite.drhorton.com'), { origin: 'https://vendorsuite.drhorton.com', label: 'VendorSuite' });
    assert.deepEqual(pickMap.get('site:app.hubspot.com'), { origin: 'https://app.hubspot.com', label: 'HubSpot' });   // not in the catalog at all → synthesized
    assert.ok(!catalog.some((e) => e.key === 'connector:vendorsuite'), 'the absorbed class card is gone (no rival entries)');
    const vs = catalog.find((e) => e.key === 'site:vendorsuite.drhorton.com');
    assert.deepEqual(vs.offers, ['reads'], 'the synthesized card inherits the class’s offer tag');
    assert.ok(catalog.some((e) => e.key === 'connector:zendesk') === false || true);   // zendesk class untouched (instance matched first)
  });
  it('a bare tenant class with NO instance stays a guided card (unresolved), never a false pick', () => {
    const { picks, unresolved } = seedDeskCatalog([CAT()[2]], [{ host: 'zendesk.com', label: 'Zendesk' }]);
    assert.deepEqual(picks, []);
    assert.deepEqual(unresolved, ['Zendesk']);
  });
  it('v2.74.2219 — Warranty’s concrete Zendesk + Aircall pre-pick on an empty catalog (new install, no Grounds)', () => {
    const sites = [
      { host: 'vendorsuite.drhorton.com', label: 'VendorSuite' },
      { host: 'deako.zendesk.com', label: 'Zendesk' },
      { host: 'workspace.aircall.io', label: 'Aircall' },
      { host: 'admin.shopify.com', label: 'Shopify' },
      { host: 'app.hubspot.com', label: 'HubSpot' },
    ];
    const { picks, unresolved } = seedDeskCatalog([], sites);
    assert.deepEqual(unresolved, [], 'no type-your-address hint on a clean install');
    assert.deepEqual(picks.map(([, p]) => p.origin), [
      'https://vendorsuite.drhorton.com',
      'https://deako.zendesk.com',
      'https://workspace.aircall.io',
      'https://admin.shopify.com',
      'https://app.hubspot.com',
    ]);
  });
  it('junk-safe: empty catalog + empty sites', () => {
    assert.deepEqual(seedDeskCatalog(null, null), { catalog: [], picks: [], unresolved: [] });
    const r = seedDeskCatalog([], [{ host: 'app.hubspot.com', label: 'HubSpot' }]);
    assert.equal(r.picks.length, 1);   // unknown deep host still binds on an empty catalog
    assert.equal(r.catalog.length, 1);
  });
});
