// Core/capableSites.js — AS-5 (v2.74.1406): the "sites with defined capabilities" catalog for app setup.
//
// PURE: merges every capability source into ONE deduped, selectable site list — the catalog the user multi-selects
// at setup to define an app's domain (DESIGN_conversations.md §6A, evolved: setup binds an app to the CATALOG of
// capable sites, not to whichever tabs happen to be open). No chrome / DOM / storage: the live side (chat.js
// `_startSetupFlow`) gathers the inputs — Grounds+capability-counts + linkedProviders from the background, the
// curated + broker catalogs + the user's existing app connections panel-side — and passes them here.
//
// Sources merged (the "All capability sources" scope):
//   1. curated connector CLASSES  — distinct `app` in CONNECTOR_RECIPES (Zendesk, Shopify) + a reads/writes summary
//   2. broker CLASSES             — BROKER_CATALOG hosts, gated on a LINKED provider (an unlinked pick reads as dead)
//   3. concrete taught SITES      — explored Grounds with ≥1 active capability (a real origin the user demonstrated on)
//   4. concrete connected SITES   — origins already bound in OTHER apps' connections
// A concrete site that belongs to a curated/broker class (deako.zendesk.com ⊂ zendesk.com) MERGES: it shows once, as
// the concrete origin, tagged with the class's offer — so you never see "Zendesk" AND "deako.zendesk.com" as rivals.
//
// @module Core/capableSites

import { CONNECTOR_RECIPES } from './connectorRecipes.js';
import { BROKER_CATALOG } from './brokerCatalog.js';

// bare host (lowercased, no scheme / www. / path). Accepts an origin, a url, or an appHost suffix.
const _host = (h) => String(h || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/\/+$/, '');
// the https origin for a host/origin/url (best-effort; keeps a path-bearing store url's ORIGIN only).
const _origin = (o) => { try { return new URL(/^https?:\/\//i.test(o) ? o : `https://${o}`).origin; } catch { return o ? `https://${_host(o)}` : null; } };
// does a concrete host belong to a class host — exact, or a proper subdomain suffix (deako.zendesk.com ⊂ zendesk.com)?
const _inClass = (host, classHost) => { const h = _host(host), c = _host(classHost); return !!h && !!c && (h === c || h.endsWith('.' + c)); };
// Title-case an app key for a human label ("zendesk" → "Zendesk", "vendor-suite" → "Vendor Suite").
const _title = (app) => String(app || '').split(/[-_ ]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Site';
// A curated class's offer summary: "reads + writes" / "reads" / "writes".
const _offer = (cc) => (cc.reads && cc.writes) ? 'reads + writes' : cc.writes ? 'writes' : 'reads';
// A concrete Ground's display label — its host, or its stored name if that's not a raw uuid-ish token.
const _groundLabel = (g) => { const host = _host(g && (g.origin || g.url)); if (host) return host; const n = String((g && g.name) || '').trim(); return (n && !/^[0-9a-f]{6,}$/i.test(n)) ? n : (host || 'site'); };

/**
 * Assemble the capability catalog. PURE.
 * @param {object} [inp]
 *   @param {ReadonlyArray} [inp.curated]          default CONNECTOR_RECIPES — entries with {app, appHost, write?}
 *   @param {ReadonlyArray} [inp.broker]           default BROKER_CATALOG — entries with {provider, label, hosts[], tools[]}
 *   @param {string[]}      [inp.linkedProviders]  linked broker providers (an unlinked broker class is omitted)
 *   @param {Array}         [inp.grounds]          [{origin?|url?|name?, caps, groundId?|id?}] — caps = active capability count
 *   @param {Array}         [inp.connections]      [{origin, label?}] — origins already connected in OTHER apps
 * @returns {Array<{ key:string, origin:(string|null), host:string, label:string,
 *                   kind:('site'|'connector'|'broker'), offers:string[], concrete:boolean,
 *                   needsInstance:boolean, groundId:(string|null), provider:(string|null) }>}
 *   `site` = a concrete origin (multi-selectable directly); `connector`/`broker` = a class with no bound instance yet
 *   (needsInstance: a connector class needs a typed instance; a broker binds its provider host directly).
 */
export function capableSitesCatalog({ curated = CONNECTOR_RECIPES, broker = BROKER_CATALOG, linkedProviders = [], grounds = [], connections = [] } = {}) {
  // 1) curated connector CLASSES (distinct by app) + reads/writes tally.
  const connClasses = new Map();   // app → { app, host, label, reads, writes }
  for (const r of (Array.isArray(curated) ? curated : [])) {
    if (!r || !r.app || !r.appHost) continue;
    const c = connClasses.get(r.app) || { app: r.app, host: _host(r.appHost), label: _title(r.app), reads: 0, writes: 0 };
    if (r.write) c.writes += 1; else c.reads += 1;
    connClasses.set(r.app, c);
  }
  // 2) broker CLASSES, gated on a LINKED provider.
  const linked = new Set((Array.isArray(linkedProviders) ? linkedProviders : []).map((p) => String(p || '').toLowerCase()));
  const brokerClasses = [];       // { host, label, provider, tools }
  for (const b of (Array.isArray(broker) ? broker : [])) {
    if (!b || !b.provider || !linked.has(String(b.provider).toLowerCase())) continue;
    for (const h of (Array.isArray(b.hosts) ? b.hosts : [])) brokerClasses.push({ host: _host(h), label: b.label || _host(h), provider: String(b.provider).toLowerCase(), tools: (Array.isArray(b.tools) ? b.tools : []).length });
  }
  // 3) concrete SITES (taught Grounds with caps + origins connected elsewhere), deduped by host.
  const concrete = new Map();     // host → { origin, host, label, caps, groundId }
  const addConcrete = (raw, label, caps, groundId) => {
    const host = _host(raw); if (!host) return;
    const cur = concrete.get(host);
    if (cur) {
      if (caps != null) cur.caps = Math.max(cur.caps || 0, caps);
      if (!cur.groundId && groundId) cur.groundId = groundId;
      if (label && (cur.label === cur.host)) cur.label = label;
      return;
    }
    concrete.set(host, { origin: _origin(raw), host, label: label || host, caps: caps || 0, groundId: groundId || null });
  };
  for (const g of (Array.isArray(grounds) ? grounds : [])) {
    if (!g) continue; const caps = Number(g.caps || 0); if (!(caps > 0)) continue;   // only Grounds that actually taught something
    addConcrete(g.origin || g.url || g.name, _groundLabel(g), caps, g.groundId || g.id || null);
  }
  for (const c of (Array.isArray(connections) ? connections : [])) { if (c && c.origin) addConcrete(c.origin, c.label && String(c.label), 0, null); }

  // 4) MERGE: emit each concrete site once, tagged with any curated/broker class it belongs to.
  const usedApp = new Set();      // curated app keys represented by a concrete instance
  const usedBroker = new Set();   // broker hosts represented by a concrete instance
  const out = [];
  for (const s of concrete.values()) {
    const offers = [];
    if (s.caps > 0) offers.push(`${s.caps} taught`);
    for (const [app, cc] of connClasses) if (_inClass(s.host, cc.host)) { usedApp.add(app); offers.push(`${cc.label} · ${_offer(cc)}`); }
    for (const bc of brokerClasses) if (_inClass(s.host, bc.host)) { usedBroker.add(bc.host); offers.push(`${bc.label} · ${bc.tools} tools`); }
    out.push({ key: `site:${s.host}`, origin: s.origin, host: s.host, label: s.label, kind: 'site', offers, concrete: true, needsInstance: false, groundId: s.groundId, provider: null });
  }
  // 5) curated classes with NO concrete instance → an abstract entry (needs a typed instance on select).
  for (const [app, cc] of connClasses) {
    if (usedApp.has(app)) continue;
    out.push({ key: `connector:${app}`, origin: null, host: cc.host, label: cc.label, kind: 'connector', offers: [_offer(cc)], concrete: false, needsInstance: true, groundId: null, provider: null });
  }
  // 6) broker classes with no concrete instance → bind the provider host directly (no instance to type).
  for (const bc of brokerClasses) {
    if (usedBroker.has(bc.host)) continue;
    out.push({ key: `broker:${bc.host}`, origin: _origin(bc.host), host: bc.host, label: bc.label, kind: 'broker', offers: [`${bc.tools} tools`], concrete: false, needsInstance: false, groundId: null, provider: bc.provider });
  }

  // stable sort: concrete taught sites first (most capabilities first), then connected sites, then connector classes, then broker.
  const rank = (e) => e.kind === 'site' ? (e.groundId ? 0 : 1) : e.kind === 'connector' ? 2 : 3;
  return out.sort((a, b) => rank(a) - rank(b) || ((b.offers.length) - (a.offers.length)) || String(a.label).localeCompare(String(b.label)));
}
