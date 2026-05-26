/**
 * @file Services/SitemapService.js
 * @description Read the authoritative page set for a site from its sitemap.xml
 * (GROUND_SPEC § 9 completeness, slice 2b). Discovers sitemap locations from
 * robots.txt (`Sitemap:` directives) + conventional fallbacks, walks sitemap
 * INDEX files into their children, decompresses `.gz`, and parses `<loc>` page
 * URLs. The caller folds the URL set into the siteMap as `stub` archetypes
 * (SiteMap.siteMapFromSitemap) — the breadth source the bounded crawl can't reach.
 *
 * MV3 note: a service worker has NO `DOMParser`, so XML is parsed by regex —
 * robust for the flat `<loc>` structure sitemaps actually use. Cross-origin
 * fetches are allowed via the extension's `<all_urls>` host permission (same as
 * AnthropicService), so this is NOT subject to page CORS.
 *
 * Safety: read-only GETs; same-origin PAGE filtering; hard caps on child
 * sitemaps, total URLs, and per-fetch time. Best-effort — any failure yields
 * an empty set and the crawl proceeds crawl-only.
 *
 * @module Services/SitemapService
 * @version 2.74.438
 */

import { Logger } from '../Core/Logger.js';

const FETCH_TIMEOUT_MS   = 10000;   // per HTTP GET
const MAX_CHILD_SITEMAPS = 25;      // sitemap docs fetched per run (index fan-out cap)
const MAX_URLS           = 5000;    // page URLs collected per run

/** GET text with a timeout; transparently gunzip a `.gz` sitemap. Returns null on any failure. */
async function _fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', credentials: 'omit' });
    if (!res || !res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    const isGz = /\.gz(\?|$)/i.test(url) || /application\/(x-)?gzip/i.test(ct) || /application\/octet-stream/i.test(ct);
    if (isGz && res.body && typeof DecompressionStream !== 'undefined') {
      try {
        const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
        return await new Response(stream).text();
      } catch {
        return null;   // not actually gzip / corrupt
      }
    }
    return await res.text();
  } catch {
    return null;       // network error, abort, etc.
  } finally {
    clearTimeout(timer);
  }
}

/** Decode the handful of XML entities that appear in <loc> URLs. */
function _decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&apos;/g, "'");
}

/** Extract every <loc> value from a sitemap or sitemap-index document. */
function _extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const u = _decodeEntities(m[1].trim());
    if (u) out.push(u);
  }
  return out;
}

/** A sitemap-index lists child sitemaps (vs a urlset listing pages). */
const _isIndex = (xml) => /<sitemapindex[\s>]/i.test(xml);

/** Discover candidate sitemap locations: robots.txt directives, then conventions. */
async function _discoverSitemapLocations(origin) {
  const locs = [];
  const robots = await _fetchText(origin + '/robots.txt');
  if (robots) {
    const re = /^\s*sitemap:\s*(\S+)/gim;
    let m;
    while ((m = re.exec(robots)) !== null) {
      const u = m[1].trim();
      if (/^https?:\/\//i.test(u)) locs.push(u);
    }
  }
  if (locs.length === 0) locs.push(origin + '/sitemap.xml', origin + '/sitemap_index.xml');
  return [...new Set(locs)];
}

/**
 * Fetch the same-origin page URL set for a site from its sitemap(s).
 * @param {string} origin  e.g. "https://example.com"
 * @returns {Promise<{ urls:string[], count:number, truncated:boolean, sitemaps:number, source:string|null }>}
 */
export async function fetchSitemapUrls(origin) {
  let normOrigin;
  try { normOrigin = new URL(origin).origin; }
  catch { return { urls: [], count: 0, truncated: false, sitemaps: 0, source: null }; }

  const seeds = await _discoverSitemapLocations(normOrigin);
  const pageUrls = new Set();
  const seen = new Set();
  const queue = [...seeds];
  let fetched = 0;
  let truncated = false;

  while (queue.length && pageUrls.size < MAX_URLS && fetched < MAX_CHILD_SITEMAPS) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    fetched++;
    const xml = await _fetchText(sm);
    if (!xml) continue;
    const locs = _extractLocs(xml);
    if (_isIndex(xml)) {
      for (const loc of locs) if (!seen.has(loc)) queue.push(loc);   // child sitemaps
    } else {
      for (const loc of locs) {
        if (pageUrls.size >= MAX_URLS) { truncated = true; break; }
        try { if (new URL(loc).origin === normOrigin) pageUrls.add(loc); } catch { /* skip junk */ }
      }
    }
  }
  if (queue.length) truncated = true;   // hit the child/url cap with sitemaps still pending

  Logger.info('SitemapService', `sitemap[${normOrigin}]: ${pageUrls.size} page URL(s) from ${fetched} sitemap doc(s)${truncated ? ' (truncated)' : ''}`);
  return { urls: [...pageUrls], count: pageUrls.size, truncated, sitemaps: fetched, source: seeds[0] || null };
}
