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
 */

import { Logger } from '../Core/Logger.js';

const FETCH_TIMEOUT_MS   = 10000;   // per HTTP GET
const MAX_CHILD_SITEMAPS = 25;      // sitemap docs fetched per run (index fan-out cap)
const MAX_URLS           = 5000;    // page URLs collected per run

// v2.74.452 — XML-leaning Accept so a server that content-negotiates doesn't hand us
// an HTML wrapper for a .xml path. (User-Agent is a forbidden fetch header — Chrome's
// real browser UA is sent automatically, so we don't try to set it.)
const _ACCEPT = 'application/xml,text/xml,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8';

/**
 * v2.74.457 — Decode a (possibly gzipped) sitemap body ROBUSTLY, deciding by the actual
 * bytes rather than the `.gz` extension. A `.gz` sitemap can arrive three ways:
 *   (a) a real gzip FILE (Content-Type: application/gzip, no Content-Encoding) — raw gzip
 *       bytes we must inflate ourselves;
 *   (b) served with `Content-Encoding: gzip` — `fetch()` ALREADY inflated it, so the body is
 *       plaintext and a SECOND manual inflate corrupts it (throws);
 *   (c) a bot-challenge HTML page sitting at the .gz URL (no gzip at all).
 * The old extension-keyed inflate broke (b) and (c) — it threw and returned null text →
 * "unreadable" — which is exactly what stalled pixabay in BOTH the SW and the in-tab fetch
 * (same code, same failure). Now: inflate ONLY when the leading bytes are the gzip magic
 * number (0x1f 0x8b); otherwise decode as-is. Never returns null on a 200, so the caller can
 * always classify the body (XML vs challenge) and log a snippet.
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function _bodyText(res) {
  let buf;
  try { buf = new Uint8Array(await res.arrayBuffer()); } catch { return ''; }
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (isGzip && typeof DecompressionStream !== 'undefined') {
    try {
      const stream = new Response(buf).body.pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    } catch { /* corrupt gzip — fall through to a raw decode */ }
  }
  try { return new TextDecoder('utf-8').decode(buf); } catch { return ''; }
}

/**
 * GET text with a timeout. Returns { text, status }: `text` is the body string (gunzipped
 * iff the bytes are really gzip — see _bodyText), or null on network failure / non-OK status.
 *
 * v2.74.452 — `credentials:'include'` (was 'omit'). The service-worker fetch now rides
 * the user's existing browser session for the target origin, so a sitemap/robots behind a
 * bot-challenge the user ALREADY cleared in-tab (e.g. Cloudflare's `cf_clearance` cookie)
 * is reachable. Anonymous ('omit') fetches are treated as a fresh bot and get a 403
 * "Just a moment…" challenge page — HTML with no <loc> — which silently killed the entire
 * corpus-templating layer (locale + slug folding) on Cloudflare-fronted sites. Sending the
 * cookie only goes back to the cookie's own origin (read-only GET), so there's no leak.
 */
async function _fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow', credentials: 'include',
      headers: { Accept: _ACCEPT },
    });
    const status = res ? res.status : 0;
    if (!res || !res.ok) return { text: null, status };
    return { text: await _bodyText(res), status };
  } catch {
    return { text: null, status: 0 };    // network error, abort, etc.
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

/** Has the shape of a real sitemap (urlset / sitemapindex / a <loc>). */
const _looksLikeSitemapXml = (text) => /<(urlset|sitemapindex|loc)[\s>]/i.test(text || '');

/**
 * v2.74.455 — A bot-challenge / WAF interstitial served at the sitemap path. Cloudflare's
 * managed challenge frequently returns HTTP **200** with an HTML "Just a moment…" body (not
 * a 403), so a status-only block check misses it — the old detector then silently degraded
 * to crawl-only. Match the well-known challenge markers AND the generic "we asked for XML
 * and got an HTML document" case.
 */
function _looksLikeChallenge(text) {
  if (!text) return false;
  const t = String(text).slice(0, 4000);
  if (/just a moment|cf-browser-verification|challenge-platform|cdn-cgi\/challenge|enable javascript and cookies|attention required|are you a robot|access denied/i.test(t)) return true;
  return /<html[\s>]/i.test(t) && !_looksLikeSitemapXml(t);   // HTML where a sitemap was expected
}

/** Discover candidate sitemap locations: robots.txt directives, then conventions. */
async function _discoverSitemapLocations(origin, fetchText) {
  const locs = [];
  const { text: robots } = await fetchText(origin + '/robots.txt');   // v2.74.452 — { text, status }
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
 *
 * v2.74.455 — the HTTP transport is INJECTABLE. By default it uses the module's own
 * service-worker fetch (`_fetchText`), but a Cloudflare-fronted sitemap reliably 403s an
 * SW fetch even when credentialed (the request lacks a real navigation's fingerprint and
 * the challenge JS can't run in a worker). The caller can pass a `fetchText` backed by an
 * in-TAB content-script fetch — a real first-party browser context that auto-solves the
 * challenge — to reach those sitemaps. Same orchestration (index walk, caps, origin
 * filtering, block detection) over either transport.
 *
 * @param {string} origin  e.g. "https://example.com"
 * @param {{ fetchText?: (url:string)=>Promise<{text:string|null,status:number}> }} [opts]
 * @returns {Promise<{ urls:string[], count:number, truncated:boolean, sitemaps:number, source:string|null, blocked:boolean, status:number, reason:string|null }>}
 */
export async function fetchSitemapUrls(origin, { fetchText = _fetchText } = {}) {
  let normOrigin;
  try { normOrigin = new URL(origin).origin; }
  catch { return { urls: [], count: 0, truncated: false, sitemaps: 0, source: null, blocked: false, status: 0, reason: null }; }

  const seeds = await _discoverSitemapLocations(normOrigin, fetchText);
  const pageUrls = new Set();
  const seen = new Set();
  const queue = [...seeds];
  let fetched = 0;
  let truncated = false;
  let blockStatus = 0;   // v2.74.452 — a non-OK status (403/503/…) on a sitemap doc → likely a bot-challenge
  let softBlock = false; // v2.74.455 — an OK (200) response that's a challenge/HTML page, not XML
  let sawValidXml = false; // v2.74.456 — did ANY fetched doc actually look like a sitemap?
  let sampleSnippet = '';  // v2.74.457 — first non-XML body seen, for the diagnostic log

  while (queue.length && pageUrls.size < MAX_URLS && fetched < MAX_CHILD_SITEMAPS) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    fetched++;
    const { text: xml, status } = await fetchText(sm);
    if (!xml) { if (status >= 400) blockStatus = status; continue; }
    if (_looksLikeSitemapXml(xml)) sawValidXml = true;
    else if (!sampleSnippet) sampleSnippet = String(xml).replace(/\s+/g, ' ').trim().slice(0, 140);
    const locs = _extractLocs(xml);
    if (_isIndex(xml)) {
      for (const loc of locs) if (!seen.has(loc)) queue.push(loc);   // child sitemaps
    } else if (locs.length) {
      for (const loc of locs) {
        if (pageUrls.size >= MAX_URLS) { truncated = true; break; }
        try { if (new URL(loc).origin === normOrigin) pageUrls.add(loc); } catch { /* skip junk */ }
      }
    } else if (_looksLikeChallenge(xml)) {
      softBlock = true;   // v2.74.455 — 200 OK but a bot-challenge / HTML interstitial (no <loc>)
    }
  }
  if (queue.length) truncated = true;   // hit the child/url cap with sitemaps still pending

  // v2.74.452/455/456 — explicit "blocked" signal: zero URLs reached AND a sitemap doc was
  // fetched but unusable. Three flavors:
  //   • blockStatus >= 400  — a 403/503 etc. (anonymous bot-challenge)
  //   • softBlock           — an OK 200 whose BODY is a challenge/HTML interstitial (has text)
  //   • unreadable          — fetched ≥1 doc, 0 URLs, and NEVER saw valid sitemap XML. This is
  //     the case that bit pixabay: the credentialed SW fetch of sitemap.xml.gz returns a 200
  //     bot-challenge whose body ISN'T gzip, so _fetchText's DecompressionStream throws and
  //     returns { text:null, status:200 } — null text with status < 400, which the first two
  //     checks both miss. (Also covers network errors / empty 200s.) Without this the in-tab
  //     retry never fired. Lets the caller surface WHY templating is dark AND retry in-tab.
  const unreadable = fetched > 0 && pageUrls.size === 0 && !sawValidXml;
  const blocked = pageUrls.size === 0 && (blockStatus >= 400 || softBlock || unreadable);
  const reason = !blocked ? null
    : blockStatus >= 400 ? `HTTP ${blockStatus}`
    : softBlock ? 'challenge/HTML (200)'
    : 'unreadable (no valid XML; gz/challenge?)';
  Logger.info('SitemapService', `sitemap[${normOrigin}]: ${pageUrls.size} page URL(s) from ${fetched} sitemap doc(s)${truncated ? ' (truncated)' : ''}${blocked ? ` — BLOCKED (${reason}; bot-challenge?)${sampleSnippet ? ` | body: "${sampleSnippet}"` : ''}` : ''}`);
  return { urls: [...pageUrls], count: pageUrls.size, truncated, sitemaps: fetched, source: seeds[0] || null, blocked, status: blockStatus, reason };
}
