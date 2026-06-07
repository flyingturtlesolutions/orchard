/**
 * @file Core/groundDedup.js
 * @description Detect + plan merges of duplicate Grounds. Pure, storage-free.
 *
 * The problem (v2.74.816): the same logical site can spawn MULTIPLE Grounds —
 * subdomain variants (app.x.com / www.x.com) and, worse, cross-TLD brands that
 * serve one app under two registrable domains (Notion: app.notion.com AND
 * www.notion.so). Capabilities then split across Grounds, and per-Ground
 * delete/count (active-tab-scoped) can't clear a capability that lives on the
 * sibling Ground while the GLOBAL matcher still finds + runs it.
 *
 * Dedup key is TWO-TIER, by confidence:
 *   - 'host'  — same registrable domain (eTLD+1). Safe to merge automatically
 *               (app.notion.com + www.notion.com → notion.com).
 *   - 'brand' — same brand label, DIFFERENT registrable domain (notion.com +
 *               notion.so). Real but heuristic (apple.com ≠ apple.org could be
 *               different entities), so the caller must CONFIRM before merging.
 *
 * Merge is non-destructive at the capability level: a Ground carries an array
 * of urlPatterns (GroundMatcher § 3), so the merged Ground simply unions the
 * patterns; the handler moves sgCapabilities/perspectives to the canonical and
 * removes the now-empty absorbed Ground shell.
 *
 * @module Core/groundDedup
 * @version 2.74.816
 */

// Compact list of two-label public suffixes (eTLD with a ccTLD SLD). NOT the
// full Public Suffix List — Chrome doesn't expose the PSL to extensions — but
// it covers the common ccTLD registration SLDs so brand/registrable extraction
// is correct for e.g. example.co.uk (brand=example, not co). Anything not here
// is treated as a single-label suffix (the overwhelmingly common case: .com).
const MULTI_SUFFIX = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'or.jp', 'ne.jp', 'go.jp', 'ac.jp',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.in', 'net.in', 'org.in', 'gov.in', 'firm.in',
  'co.za', 'org.za', 'net.za', 'gov.za',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.mx', 'com.sg', 'com.hk', 'com.tw', 'co.kr', 'co.id', 'com.tr', 'co.il', 'com.ar', 'com.co',
]);

/**
 * Extract the bare host from a URL, a bare host, or a urlPattern (handles a
 * leading scheme, a path/query/fragment, a port, and a `*.` / `*` wildcard).
 * @param {string} s
 * @returns {string} lowercased host, or ''
 */
export function extractHost(s) {
  let str = String(s == null ? '' : s).trim();
  if (!str) return '';
  str = str.replace(/^[a-z][\w+.-]*:\/\//i, '');   // strip scheme://
  str = str.split(/[/?#]/)[0];                      // strip path/query/fragment
  str = str.split(':')[0];                          // strip :port
  str = str.replace(/^\*\./, '').replace(/\*/g, ''); // strip wildcard subdomain
  return str.toLowerCase().replace(/^\.+|\.+$/g, '');
}

/**
 * Site identity for a URL/host/pattern: its registrable domain (eTLD+1) and
 * brand label (the registration SLD). IP addresses + single-label hosts are
 * their own identity.
 * @param {string} urlOrHost
 * @returns {{ host:string, registrable:string, brand:string, suffix:string }}
 */
export function siteIdentity(urlOrHost) {
  const host = extractHost(urlOrHost);
  if (!host) return { host: '', registrable: '', brand: '', suffix: '' };
  const labels = host.split('.').filter(Boolean);
  // single label, or an IPv4 literal → identity is the host itself
  if (labels.length <= 1 || /^\d+$/.test(labels[labels.length - 1])) {
    return { host, registrable: host, brand: host, suffix: '' };
  }
  const last2 = labels.slice(-2).join('.');
  let suffix, brandIdx;
  if (labels.length >= 3 && MULTI_SUFFIX.has(last2)) { suffix = last2; brandIdx = labels.length - 3; }
  else { suffix = labels[labels.length - 1]; brandIdx = labels.length - 2; }
  const brand = labels[brandIdx] || '';
  const registrable = labels.slice(brandIdx).join('.');
  return { host, registrable, brand, suffix };
}

/** Every host a Ground claims — from its url + its urlPatterns. */
export function groundHosts(ground) {
  const hosts = new Set();
  if (ground && ground.url) { const h = extractHost(ground.url); if (h) hosts.add(h); }
  for (const up of (ground && Array.isArray(ground.urlPatterns) ? ground.urlPatterns : [])) {
    if (up && up.pattern) { const h = extractHost(up.pattern); if (h) hosts.add(h); }
  }
  return [...hosts];
}

/** The Ground's PRIMARY host: the isPrimary pattern's host, else url's, else first pattern's. */
export function primaryHost(ground) {
  const pats = (ground && Array.isArray(ground.urlPatterns)) ? ground.urlPatterns : [];
  const prim = pats.find((p) => p && p.isPrimary && p.pattern);
  if (prim) return extractHost(prim.pattern);
  if (ground && ground.url) { const h = extractHost(ground.url); if (h) return h; }
  const first = pats.find((p) => p && p.pattern);
  return first ? extractHost(first.pattern) : '';
}

/**
 * Group Grounds that look like the SAME site.
 * @param {Array<object>} grounds  Ground records (need id; use url/urlPatterns for identity)
 * @returns {Array<{ key:string, confidence:('host'|'brand'), registrables:string[], grounds:object[] }>}
 *   one entry per duplicate cluster (≥2 Grounds). 'host' = same registrable
 *   (safe auto-merge); 'brand' = same brand across registrable domains (confirm).
 */
export function findDuplicateGroundGroups(grounds) {
  const list = (Array.isArray(grounds) ? grounds : []).filter((g) => g && g.id != null);
  const ident = new Map();              // id → siteIdentity(primaryHost)
  for (const g of list) ident.set(g.id, siteIdentity(primaryHost(g) || groundHosts(g)[0] || ''));

  const byReg = new Map();              // registrable → [ground]
  const byBrand = new Map();            // brand → [ground]
  const push = (map, k, g) => { if (!map.has(k)) map.set(k, []); map.get(k).push(g); };
  for (const g of list) {
    const id = ident.get(g.id);
    if (!id) continue;
    if (id.registrable) push(byReg, id.registrable, g);
    if (id.brand) push(byBrand, id.brand, g);
  }

  const groups = [];
  const claimed = new Set();
  // HOST confidence — same registrable domain, ≥2 Grounds.
  for (const [reg, gs] of byReg) {
    if (gs.length < 2) continue;
    groups.push({ key: reg, confidence: 'host', registrables: [reg], grounds: gs.slice() });
    gs.forEach((g) => claimed.add(g.id));
  }
  // BRAND confidence — same brand, ≥2 registrable domains, not already host-claimed.
  for (const [brand, gs] of byBrand) {
    const fresh = gs.filter((g) => !claimed.has(g.id));
    if (fresh.length < 2) continue;
    const regs = [...new Set(fresh.map((g) => ident.get(g.id).registrable))];
    if (regs.length < 2) continue;      // all one registrable → already a host group (or single)
    groups.push({ key: brand, confidence: 'brand', registrables: regs, grounds: fresh.slice() });
    fresh.forEach((g) => claimed.add(g.id));
  }
  return groups;
}

/**
 * Plan a merge of ≥2 Grounds into one. Pure: returns the canonical id, the
 * absorbed ids, and the unioned urlPatterns/name. The CALLER performs the
 * storage moves (sgCapabilities/perspectives → canonical) and deletes the
 * absorbed shells.
 *
 * Canonical = the Ground with the most capabilities (caller may stamp
 * `capabilityCount`), tie → most urlPatterns, tie → lexicographically smallest
 * id (stable). Exactly one urlPattern stays `isPrimary`.
 *
 * @param {Array<object>} grounds
 * @returns {{ canonicalId:string, absorbedIds:string[], urlPatterns:object[], name:string }|null}
 */
export function planGroundMerge(grounds) {
  const list = (Array.isArray(grounds) ? grounds : []).filter((g) => g && g.id != null);
  if (list.length < 2) return null;
  const caps = (g) => Number(g.capabilityCount) || (Array.isArray(g.sgCapabilities) ? g.sgCapabilities.length : 0) || 0;
  const npat = (g) => (Array.isArray(g.urlPatterns) ? g.urlPatterns.length : 0);
  const canonical = list.slice().sort((a, b) =>
    (caps(b) - caps(a)) || (npat(b) - npat(a)) || (String(a.id) < String(b.id) ? -1 : 1))[0];
  const absorbed = list.filter((g) => g.id !== canonical.id);

  const seen = new Set();
  const urlPatterns = [];
  for (const g of [canonical, ...absorbed]) {
    for (const up of (Array.isArray(g.urlPatterns) ? g.urlPatterns : [])) {
      if (!up || !up.pattern) continue;
      const key = String(up.pattern);
      if (seen.has(key)) continue;
      seen.add(key);
      // Only the canonical's own primary stays primary; absorbed patterns join as non-primary.
      urlPatterns.push({ ...up, isPrimary: !!up.isPrimary && g.id === canonical.id });
    }
  }
  if (urlPatterns.length && !urlPatterns.some((p) => p.isPrimary)) urlPatterns[0].isPrimary = true;

  return {
    canonicalId: canonical.id,
    absorbedIds: absorbed.map((g) => g.id),
    urlPatterns,
    name: canonical.name || (absorbed.find((g) => g.name) || {}).name || '',
  };
}
