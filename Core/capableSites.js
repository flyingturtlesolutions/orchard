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
// AS-5b (v2.74.1409) — brand ALIASES for brevity (youtube.com → "YouTube", calendar.google.com → "Google Calendar").
// EXACT-host match only: a business subdomain (deako.zendesk.com) keeps its host — the instance IS the identifier, and
// its class offer ("Zendesk · reads + writes") already names the product. Seeded from the broker catalog's own labels
// + a small consumer/product table.
const _EXTRA_ALIAS = {
  'youtube.com': 'YouTube', 'mail.google.com': 'Gmail', 'gmail.com': 'Gmail', 'drive.google.com': 'Google Drive',
  'sheets.google.com': 'Google Sheets', 'meet.google.com': 'Google Meet', 'admin.shopify.com': 'Shopify',
  'github.com': 'GitHub', 'notion.so': 'Notion', 'www.notion.so': 'Notion', 'linkedin.com': 'LinkedIn',
  'x.com': 'X', 'twitter.com': 'X', 'reddit.com': 'Reddit', 'app.slack.com': 'Slack', 'figma.com': 'Figma',
};
function _aliasMap(broker) {
  const m = { ..._EXTRA_ALIAS };
  for (const b of (Array.isArray(broker) ? broker : [])) for (const h of (Array.isArray(b.hosts) ? b.hosts : [])) { const k = _host(h); if (k && b.label && !m[k]) m[k] = b.label; }
  return m;
}

// AS-5b (v2.74.1410) — DERIVE a readable alias for a host with no curated brand match, so business / custom sites read
// as names too: "support.deako.com" → "Deako Support", "deako.zendesk.com" → "Deako Zendesk", and
// "deako-cstool-dev.s3-website-us-east-1.amazonaws.com" → "Deako CSTool". Heuristic — known-SaaS → "<Org> <Service>";
// hosting infra (S3 / Heroku / Netlify / …) → the deployed app label; else the registrable org + a meaningful
// subdomain. Env + infra tokens dropped, a small acronym set upper-cased. Purely COSMETIC — never touches origin/match.
const _SAAS = { 'zendesk.com': 'Zendesk', 'myshopify.com': 'Shopify', 'atlassian.net': 'Jira', 'slack.com': 'Slack', 'hubspot.com': 'HubSpot', 'freshdesk.com': 'Freshdesk', 'intercom.com': 'Intercom', 'salesforce.com': 'Salesforce' };
const _ENV_TOK = new Set(['dev', 'development', 'staging', 'stage', 'stg', 'prod', 'production', 'test', 'qa', 'demo', 'sandbox', 'uat', 'local', 'app', 'admin', 'www']);
const _ACRONYM = new Set(['cs', 'api', 'ui', 'ux', 'crm', 'cms', 'hr', 'seo', 'ai', 'ml']);
function _titleTok(t) {
  if (!t) return '';
  if (_ACRONYM.has(t)) return t.toUpperCase();
  for (const a of _ACRONYM) if (t.length > a.length && t.startsWith(a)) { const r = t.slice(a.length); return a.toUpperCase() + r.charAt(0).toUpperCase() + r.slice(1); }   // "cstool" → "CSTool"
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function _titleWords(s) {
  const seen = new Set(); const out = [];
  for (const t of String(s || '').toLowerCase().split(/[.\-_\s]+/)) { if (!t || _ENV_TOK.has(t) || seen.has(t)) continue; seen.add(t); out.push(_titleTok(t)); }
  return out.join(' ');
}
function _prettyHost(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '').replace(/[/?#].*$/, '');
  if (!h) return '';
  for (const [suf, name] of Object.entries(_SAAS)) if (h === suf || h.endsWith('.' + suf)) {
    const org = h.slice(0, h.length - suf.length).replace(/\.$/, '').split('.').pop();      // the label just before the SaaS domain
    return org ? `${_titleWords(org)} ${name}` : name;
  }
  let core = null;
  const s3 = h.match(/^([^.]+)\.s3[.-]/);                                                    // <app>.s3-website-… / <app>.s3.…
  if (s3) core = s3[1];
  else { const plat = h.match(/^(.+?)\.(herokuapp\.com|netlify\.app|vercel\.app|web\.app|github\.io|pages\.dev|onrender\.com|fly\.dev|amazonaws\.com)$/); if (plat) core = plat[1].split('.').pop(); }
  if (core == null) { const p = h.split('.'); core = (p.length >= 3) ? `${p[p.length - 2]} ${p[0]}` : (p[0] || h); }   // sub.org.tld → "org sub"; org.tld → "org"
  return _titleWords(core) || h;
}

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

  // 4) MERGE: emit each concrete site once, ALIASED for brevity + tagged with any curated/broker class it belongs to.
  const amap = _aliasMap(broker);
  const usedApp = new Set();      // curated app keys represented by a concrete instance
  const usedBroker = new Set();   // broker hosts represented by a concrete instance
  const out = [];
  for (const s of concrete.values()) {
    // brand alias for a well-known host → a real custom connection label → a DERIVED pretty name → the raw host.
    const label = amap[s.host] || (s.label && s.label !== s.host ? s.label : _prettyHost(s.host)) || s.host;
    const offers = [];
    if (s.caps > 0) offers.push(`${s.caps} taught`);
    for (const [app, cc] of connClasses) if (_inClass(s.host, cc.host)) { usedApp.add(app); offers.push(`${cc.label} · ${_offer(cc)}`); }
    for (const bc of brokerClasses) if (_inClass(s.host, bc.host)) { usedBroker.add(bc.host); offers.push(`${bc.label} · ${bc.tools} tools`); }
    // dedup a class-name prefix the label already NAMES ("Deako Zendesk" + "Zendesk · reads + writes" → "reads + writes")
    const cleaned = offers.map((o) => { const m = o.match(/^(.+?) · (.+)$/); return (m && label.toLowerCase().includes(m[1].toLowerCase())) ? m[2] : o; });
    out.push({ key: `site:${s.host}`, origin: s.origin, host: s.host, label, kind: 'site', offers: cleaned, concrete: true, needsInstance: false, groundId: s.groundId, provider: null });
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

/**
 * DK-6 (v2.74.1486, DESIGN_desks.md) — seed the setup catalog with a PRECONFIGURED desk's builtin `sites`
 * ({host,label}) and PRE-PICK every resolvable one, so setup is review-and-Confirm instead of hunt-and-pick. PURE.
 * Per site, in order:
 *   1. a CONCRETE catalog entry covering it (exact host, or an instance of the site's class — deako.zendesk.com
 *      for zendesk.com) → pre-pick that entry;
 *   2. a DEEP host (≥3 labels: vendorsuite.drhorton.com, app.hubspot.com) is itself the bindable origin → synthesize
 *      a concrete card (absorbing any matching class card + its offer tag so the list shows ONE entry) + pre-pick;
 *   3. a bare TENANT class (zendesk.com with no instance anywhere) can't be picked for the user — it stays a guided
 *      card (`unresolved` names it; the existing type-your-address flow adds the instance).
 * @returns {{ catalog: Array, picks: Array<[string, {origin:string,label:string}]>, unresolved: string[] }}
 */
export function seedDeskCatalog(catalog, sites) {
  const list = (Array.isArray(catalog) ? catalog : []).slice();
  const picks = []; const unresolved = [];
  for (const s of (Array.isArray(sites) ? sites : [])) {
    const host = _host(s && s.host); if (!host) continue;
    const label = (s && s.label) ? String(s.label) : host;
    const conc = list.find((e) => e && e.concrete && e.origin && _inClass(e.host, host));
    if (conc) { picks.push([conc.key, { origin: conc.origin, label: conc.label || label }]); continue; }
    if (host.split('.').length >= 3) {
      const clsIdx = list.findIndex((e) => e && !e.concrete && _inClass(host, e.host));
      const cls = clsIdx >= 0 ? list.splice(clsIdx, 1)[0] : null;   // absorb the class card — one entry, not rivals
      const entry = { key: `site:${host}`, origin: _origin(host), host, label, kind: 'site', offers: cls ? cls.offers : [], concrete: true, needsInstance: false, groundId: null, provider: cls ? cls.provider : null };
      list.push(entry); picks.push([entry.key, { origin: entry.origin, label }]);
      continue;
    }
    const cls = list.find((e) => e && !e.concrete && _inClass(host, e.host));
    unresolved.push((cls && cls.label) || label);
  }
  return { catalog: list, picks, unresolved };
}
