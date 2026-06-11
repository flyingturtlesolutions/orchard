/**
 * @file Core/GroundMatcher.js
 * @description GROUND_SPEC § 3 / § 8 URL-pattern matching. Pure, storage-free.
 *
 * Spec-strict glob semantics (user decision, v2.74.326): a bare host pattern
 * (`https://site.com`) matches ONLY that exact canonical URL — subpaths
 * require `/*`, subdomains require `*.site.com`. Supports three pattern
 * kinds: `glob` (default), `regex`, `template` (`{param}` path captures).
 * Conflict resolution is most-specific-wins (GROUND_SPEC § 3): more literal
 * characters wins, then fewer wildcards, then alphabetical by Ground id.
 *
 * Consumed by ground-view (current-Ground detection) today; designed to also
 * back the active-Ground-per-thread tracker (GROUND_SPEC § 8) when that lands.
 *
 * @module Core/GroundMatcher
 */

// Session / tracking query params stripped during canonicalization
// (GROUND_SPEC § 3 references the Landmark spec § 4 canonicalization rules).
const SESSION_PARAM_RE =
  /^(utm_[a-z]+|fbclid|gclid|gclsrc|dclid|msclkid|mc_eid|mc_cid|_ga|_gl|igshid|sid|sessionid|s_kwcid|ref|ref_src|spm)$/i;

/**
 * Canonicalize a URL for matching: lowercase scheme + host, drop default
 * ports, strip session/tracking query params, sort remaining params, drop
 * the fragment. Path case is preserved (paths are case-sensitive). Returns
 * the trimmed original if it can't be parsed.
 * @param {string} url
 * @returns {string}
 */
export function canonicalizeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  let u;
  try { u = new URL(url.trim()); } catch { return url.trim(); }
  // scheme + host are already lowercased by URL; default ports already dropped.
  const sp = new URLSearchParams(u.search);
  for (const k of [...sp.keys()]) {
    if (SESSION_PARAM_RE.test(k)) sp.delete(k);
  }
  const sortedKeys = [...new Set([...sp.keys()])].sort();
  const sorted = new URLSearchParams();
  for (const k of sortedKeys) {
    for (const v of sp.getAll(k)) sorted.append(k, v);
  }
  const qs = sorted.toString();
  // u.pathname is at least '/'. Fragment intentionally dropped.
  return `${u.protocol}//${u.host}${u.pathname}${qs ? `?${qs}` : ''}`;
}

// Lowercase only the scheme://host portion of a pattern (host is
// case-insensitive; path is not). Wildcards inside the host (e.g. `*.`) are
// preserved.
function _lowerSchemeHost(pattern) {
  const m = pattern.match(/^([a-zA-Z][\w+.-]*:\/\/[^/?#]*)(.*)$/);
  return m ? m[1].toLowerCase() + m[2] : pattern;
}

// A pattern that is exactly `scheme://host` (no path/query/fragment) gets a
// trailing `/` so it matches the canonical URL, whose path is always `/`.
function _ensureRootPath(pattern) {
  return /^[a-zA-Z][\w+.-]*:\/\/[^/?#]*$/.test(pattern) ? `${pattern}/` : pattern;
}

const NEVER = { test: () => false, params: [], match: () => null };

/**
 * Compile a URL pattern into a matcher against canonicalized URLs.
 * @param {string} pattern
 * @param {('glob'|'regex'|'template')} [kind='glob']
 * @returns {{ test:(url:string)=>boolean, params:string[], match:(url:string)=>(object|null) }}
 */
export function compilePattern(pattern, kind = 'glob') {
  const p = String(pattern ?? '');
  if (!p) return NEVER;

  if (kind === 'regex') {
    let re;
    try { re = new RegExp(p); } catch { return NEVER; }
    return { test: (url) => re.test(url), params: [], match: (url) => (re.test(url) ? {} : null) };
  }

  // glob + template: lowercase scheme/host, ensure a root path, then escape
  // literals and expand wildcards / template tokens.
  const src = _ensureRootPath(_lowerSchemeHost(p));
  const params = [];
  let re = '^';
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (ch === '*') { re += '.*'; i++; }
    else if (ch === '?') { re += '.'; i++; }
    else if (kind === 'template' && ch === '{') {
      const end = src.indexOf('}', i);
      if (end === -1) { re += '\\{'; i++; }
      else {
        params.push(src.slice(i + 1, end));
        re += '([^/?#]+)';      // a single path segment
        i = end + 1;
      }
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  re += '$';

  let rx;
  try { rx = new RegExp(re); } catch { return NEVER; }
  return {
    test : (url) => rx.test(url),
    params,
    match: (url) => {
      const m = rx.exec(url);
      if (!m) return null;
      const out = {};
      params.forEach((name, idx) => { out[name] = m[idx + 1]; });
      return out;
    },
  };
}

/**
 * Specificity of a pattern for most-specific-wins resolution.
 * @returns {{ literal:number, wildcards:number }}
 */
export function patternSpecificity(pattern) {
  const p = String(pattern ?? '');
  const wildcards = (p.match(/[*?]/g) || []).length;
  const literal = p.replace(/[*?]/g, '').replace(/\{[^}]*\}/g, '').length;
  return { literal, wildcards };
}

function _moreSpecific(a, b) {
  if (a.literal !== b.literal) return a.literal > b.literal;       // more literal chars wins
  if (a.wildcards !== b.wildcards) return a.wildcards < b.wildcards; // fewer wildcards wins
  return String(a.id) < String(b.id);                              // alphabetical by id (spec)
}

/**
 * Match a URL against a set of Grounds by their urlPatterns, returning the
 * most-specific match (GROUND_SPEC § 3) or null.
 * @param {string} url
 * @param {Array<{id:string, urlPatterns?:Array<{pattern:string,isPrimary?:boolean,patternKind?:string}>}>} grounds
 * @returns {{ ground:object, pattern:object, params:object }|null}
 */
export function matchGroundForUrl(url, grounds, opts = {}) {
  // v2.74.333 — `activeOnly` excludes `draft` Grounds (GROUND_SPEC § 9:
  // "draft not active for URL matching"). That rule is for the RUNTIME
  // active-Ground tracker (deferred § 8). The current consumer is the
  // AUTHORING entry point (ground-view), which MUST be able to match a
  // brand-new draft Ground to author its first Perspective — excluding draft
  // there deadlocked new-Ground creation (the v2.74.330 regression). So
  // draft is INCLUDED by default; pass { activeOnly: true } for runtime use.
  const activeOnly = opts.activeOnly === true;
  const canon = canonicalizeUrl(url);
  if (!canon) return null;
  let best = null;
  for (const g of grounds || []) {
    if (activeOnly && g?.metadata?.lifecycle === 'draft') continue;
    const patterns = Array.isArray(g?.urlPatterns) ? g.urlPatterns : [];
    for (const up of patterns) {
      if (!up?.pattern) continue;
      const compiled = compilePattern(up.pattern, up.patternKind || 'glob');
      if (!compiled.test(canon)) continue;
      const { literal, wildcards } = patternSpecificity(up.pattern);
      const cand = {
        ground: g, pattern: up, params: compiled.match(canon) || {},
        literal, wildcards, id: g?.id ?? '',
      };
      if (!best || _moreSpecific(cand, best)) best = cand;
    }
  }
  return best ? { ground: best.ground, pattern: best.pattern, params: best.params } : null;
}
