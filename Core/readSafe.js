// Core/readSafe.js — §19 Forage: the READ-SAFE affordance classifier. PURE. Forage navigates the app's OWN nav to
// harvest its read APIs; this is the gate that keeps it READ-ONLY by construction. It is an ALLOWLIST (only
// nav/filter/paginate/detail/search are read-safe), NOT a denylist — anything not provably a same-site GET navigation
// with a non-mutating label is refused. The EX-1 destructive lexicon (mirror of ContentScripts/contentScript.js
// DESTRUCTIVE_LABEL) is a SECOND veto over the allowlist. No chrome / DOM / LLM.

// EX-1 mirror — irreversible/destructive verbs + phrasings (delete/buy/checkout/logout/empty-cart/confirm-order…).
const DESTRUCTIVE_LABEL = /\b(delete|deactivate|destroy|unsubscribe|publish|withdraw|log\s?out|sign\s?out|logout)\b|\b(empty|clear)\s+(cart|basket)\b|\b(cancel|close|delete|deactivate|remove)\s+(account|order|subscription|plan|membership|payment|profile)\b|\b(place|confirm)\s+(order|payment|purchase)\b|\b(buy|checkout|pay|bid)\b/i;
// Mutating/submit verbs beyond destructive — a control labelled with these is NEVER fired by Forage (it might POST/PUT).
const WRITE_LABEL = /\b(submit|save|send|post|reply|comment|upload|create|edit|update|confirm|apply|sign\s?up|register|subscribe|follow|favou?rite|add\s+to|remove|report|flag|share|invite|message)\b/i;
// URL-level backstop: even a same-site GET whose PATH names a destructive/auth/money action is refused — the LABEL vetoes
// above miss UNLABELLED controls (an icon-only `<a href="/logout">`, `/account/deactivate`), and Forage runs UNATTENDED, so
// it must never navigate one. Worst harm here is real: `/logout` would destroy the very session-ride the harvest depends on.
// Segment-bounded (between slashes) + a tight high-signal set, so it never false-vetoes read pages like
// `/help/how-to-delete-account` (there "delete" is mid-segment, not a standalone path segment).
const DESTRUCTIVE_PATH = /(?:^|\/)(logout|log-?out|signout|sign-?out|checkout|deactivate|unsubscribe)(?:\/|$)/i;
// A path segment carrying an id → a detail/read endpoint (one representative is worth visiting → templates {id}). A 4+
// digit run (after /, -, or _, e.g. `/photos/sunset-1234567/`) or a uuid; 4+ avoids false hits like `/v2/` or `page-1`.
const DETAIL_HINT = /(?:^|[/_-])(\d{4,}|[0-9a-f]{8}-[0-9a-f-]{16,})(?=[/?#]|$)/i;
// File-ish endpoints we never navigate to (downloads, not reads).
const FILE_EXT = /\.(zip|gz|tar|pdf|jpe?g|png|gif|webp|svg|mp4|webm|mp3|wav|csv|xlsx?|docx?|pptx?|exe|dmg)$/i;

const _reg = (h) => String(h || '').split('.').slice(-2).join('.');

/**
 * Is `href` a read-safe, same-site GET navigation? PURE. Refuses javascript:/mailto:/#/data:, non-http(s), off-site
 * (different registrable domain), and download-ish file URLs. baseUrl resolves relative hrefs + scopes the site.
 */
export function isReadSafeUrl(href, baseUrl) {
  const h = String(href || '').trim();
  if (!h || /^(javascript:|mailto:|tel:|#|data:|blob:|about:)/i.test(h)) return false;
  let u, b;
  try { b = new URL(baseUrl); u = new URL(h, baseUrl); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.host !== b.host && _reg(u.host) !== _reg(b.host)) return false;   // same registrable site only
  if (FILE_EXT.test(u.pathname)) return false;
  return true;
}

/**
 * Classify an affordance → { safe, class, reason }. PURE. `aff` = { label?, href?, role?, tag?, type? }.
 * class ∈ nav | filter | paginate | detail | search | unsafe. A write/destructive LABEL vetoes first (even on an
 * anchor); then: a search box → search; no/ unsafe href → unsafe (background-nav only drives URLs; the XHR poke that
 * could fire an hrefless button is a deferred §19.6 slice); a read-safe URL → nav/filter/paginate/detail by hint.
 */
export function classifyAffordance(aff, baseUrl) {
  const a = aff || {};
  const label = String(a.label || '').trim();
  if (DESTRUCTIVE_LABEL.test(label)) return { safe: false, class: 'unsafe', reason: 'destructive-label' };
  if (WRITE_LABEL.test(label)) return { safe: false, class: 'unsafe', reason: 'write-label' };
  const role = String(a.role || '').toLowerCase();
  const tag = String(a.tag || '').toLowerCase();
  const type = String(a.type || '').toLowerCase();
  if (role === 'searchbox' || (tag === 'input' && (type === 'search' || /search/i.test(label)))) return { safe: true, class: 'search', reason: 'search-input' };
  const href = a.href || '';
  if (!href || !isReadSafeUrl(href, baseUrl)) return { safe: false, class: 'unsafe', reason: href ? 'not-readsafe-url' : 'no-href' };
  let path = ''; try { path = new URL(href, baseUrl).pathname; } catch { /* */ }
  if (DESTRUCTIVE_PATH.test(path)) return { safe: false, class: 'unsafe', reason: 'destructive-path' };   // unlabelled /logout, /checkout, /account/deactivate…
  const lower = `${label} ${href}`.toLowerCase();
  if (/[?&]page=|\/page\/\d|\bnext\b|\bload\s*more\b|\bshow\s*more\b/i.test(lower)) return { safe: true, class: 'paginate', reason: 'pagination' };
  if (/[?&](order|sort|filter|category|cat|type|colou?r|orientation|size|min_|max_|q)=/i.test(href) || /\b(filter|sort|category|popular|latest|newest|trending|editor)\b/i.test(label)) return { safe: true, class: 'filter', reason: 'filter/sort' };
  if (DETAIL_HINT.test(path)) return { safe: true, class: 'detail', reason: 'detail-id' };
  return { safe: true, class: 'nav', reason: 'section-nav' };
}

/** Convenience: is this affordance read-safe to fire? PURE. */
export function isReadSafe(aff, baseUrl) { return classifyAffordance(aff, baseUrl).safe; }
