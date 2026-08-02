/**
 * @file ContentScripts/contentScript.js
 * @description Persistent content script injected into every page at document_start,
 * before the page's CSP header is applied. Handles all DOM actions via
 * chrome.runtime.onMessage so the service worker never needs to inject inline
 * functions (which are blocked by strict CSPs like HubSpot's).
 *
 * Message types handled:
 *   EXECUTE_STEP   — CLICK | TYPE | EXTRACT | FIND_AI
 *   WAIT_FOR_ELEM  — polls until selector appears, resolves with found/timeout
 *   OBSERVE_START  — installs a MutationObserver, stores result in window flag
 *   OBSERVE_READ   — reads and clears the mutation flag, disconnects observer
 *   DOM_SNAPSHOT   — returns compact interactive-element summary
 *   PAGE_IDLE      — returns true when readyState=complete + network quiet
 *
 * @module ContentScripts/contentScript
 * @author Agent HUB
 */

'use strict';

// v2.72.44 — Idempotency guard. Background may re-inject this script
// (via chrome.scripting.executeScript) after chrome.tabs.create to defeat
// the document_start race where the page reaches load completion before
// the manifest-declared injection finishes registering listeners. If
// we're already loaded, bail at top so re-registration is a no-op
// (double-registered onMessage listeners would cause double responses).
//
// We use a global flag on `window` so the second injection sees it. A classic script can't
// `return` at top level, so the abort is still a THROW %s but v2.74.955 (CR-H5) registers a one-shot
// window error handler first that preventDefault()s exactly this error, so the redundant injection
// no longer prints an uncaught-error line in every frame's console. chrome.scripting.executeScript
// catches the throw either way; the existing instance keeps running.
if (window.__agentHubContentScriptLoaded === true) {
  const _swallowReinject = (e) => {
    if (e && e.error && e.error.__ahubReinjectAbort === true) {
      e.preventDefault();
      window.removeEventListener('error', _swallowReinject);
      return true;
    }
  };
  window.addEventListener('error', _swallowReinject);
  const _abort = new Error('agent-hub content script already loaded; skipping re-injection');
  _abort.__ahubReinjectAbort = true;
  throw _abort;
}
window.__agentHubContentScriptLoaded = true;

// CX-7d (v2.74.1391) — wire the sniffed-CSRF/op RECEIVER at document_start on Shopify admin, so tokens the MAIN-
// world tee (shopifyCsrfSniffer.js) captures from the SPA's own PAGE-LOAD traffic are stored before Orchard's
// first ask — the token is then already primed, and the "click around the admin once" hint (which only fired
// because the on-demand receiver wired too late) is virtually never seen. GET_SNIFFED_CSRF below is idempotent
// against this (shares window.__ahubSniffCsrfWired) and still works on tabs where this eager path didn't run.
(function () {
  try {
    if (!/(?:^|\.)shopify\.com$/i.test(location.host) || window.__ahubSniffCsrfWired) return;
    window.__ahubSniffCsrfWired = true;
    window.__ahubSniffCsrfTok = null;
    window.__ahubSniffOps = {};
    window.addEventListener('message', (ev) => {
      try {
        if (ev.source !== window || ev.origin !== location.origin) return;
        const d = ev.data && ev.data.__ahub_sniffed_csrf;
        if (d && d.token && d.host === location.host) {
          window.__ahubSniffCsrfTok = { token: String(d.token).slice(0, 400), at: Date.now() };
          // v2.74.1853 — PUSH each NEW token to the SW bank (throttle: value-change only). Pull-only left
          // between-ask captures solely in this world, where an extension reload strands them; an orphaned
          // context's push throws 'context invalidated' and dies in the catch — the fresh script re-pushes.
          if (window.__ahubCsrfPushedTok !== window.__ahubSniffCsrfTok.token) {
            window.__ahubCsrfPushedTok = window.__ahubSniffCsrfTok.token;
            try { chrome.runtime.sendMessage({ type: 'CSRF_TOKEN_SEEN', payload: { host: location.host, token: window.__ahubSniffCsrfTok.token } }, () => { void chrome.runtime.lastError; }); } catch { /* */ }
          }
        }
        const o = ev.data && ev.data.__ahub_sniffed_op;
        if (o && o.sha && o.name && o.host === location.host && /^[a-f0-9]{16,64}$/i.test(String(o.sha)) && /^\w{1,60}$/.test(String(o.name))) {
          window.__ahubSniffOps[String(o.name)] = { sha: String(o.sha), handle: o.handle ? String(o.handle).slice(0, 80) : null, at: Date.now() };
          // v2.74.1935 — PUSH each NEW op to the SW bank, exactly as the token does above (throttle: value-change
          // only). Pull-only left an op alive ONLY in this world's buffer — and a ride's own content-script heal
          // re-runs this IIFE, zeroing that buffer while restoring the pipe (the 21:50 wedge: heal + a 404 emptied
          // both copies of the sha in one second, with no way back short of a document load). An orphaned
          // context's push throws 'context invalidated' and dies in the catch; the fresh script re-pushes.
          if (!window.__ahubPushedOps) window.__ahubPushedOps = {};
          if (window.__ahubPushedOps[String(o.name)] !== String(o.sha)) {
            window.__ahubPushedOps[String(o.name)] = String(o.sha);
            try { chrome.runtime.sendMessage({ type: 'SNIFFED_OP_SEEN', payload: { host: location.host, name: String(o.name), sha: String(o.sha), handle: o.handle ? String(o.handle).slice(0, 80) : null } }, () => { void chrome.runtime.lastError; }); } catch { /* */ }
          }
        }
      } catch { /* */ }
    });
  } catch { /* */ }
})();

// ─── Shadow DOM utilities ─────────────────────────────────────────────────────

/**
 * Recursively collects all elements matching `selector` from the document
 * and every shadow root reachable from it. Standard querySelector only
 * searches the light DOM — this pierces shadow boundaries so panels
 * rendered inside Web Components (common in HubSpot, Salesforce etc.) are found.
 *
 * @param {string}           selector
 * @param {Document|Element} [root=document]
 * @returns {Element[]}
 */
function queryAllDeep(selector, root = document) {
  const results = [];

  function search(node) {
    // Query this context
    try {
      node.querySelectorAll(selector).forEach(el => results.push(el));
    } catch (_) {}

    // Recurse into shadow roots of every element in this context
    try {
      node.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) search(el.shadowRoot);
      });
    } catch (_) {}
  }

  search(root);
  return results;
}

/**
 * v2.29.9 — Heuristically detect auto-generated CSS-in-JS class names that
 * change across rerenders/deploys, so selectors don't include them.
 *
 * These are the classes produced by Emotion/styled-components/etc. that
 * look semantically meaningless and whose hashes drift:
 *   - Emotion   : `css-<hash>`, `e<hash>` (cache-key prefix is typically
 *                 a short identifier like `eu4oa1w0`)
 *   - styled-components : `sc-<hash>`
 *   - CSS Modules       : `<name>__<hash>` (kept — often stable enough
 *                         AND contains semantic component name)
 *   - MUI/Chakra        : `MuiButton-root-<hash>` → the base class has
 *                         meaning but the hash suffix drifts. Keeping
 *                         whole class for now; could refine later.
 *
 * Conservative: only reject classes that are _purely_ an opaque hash. We
 * keep `hasSection-default`, `vjs-highlight`, `dd-privacy-allow`, etc. because
 * they carry meaning. NOTE (v2.74.706): per-INSTANCE key classes like Indeed's
 * `job_070d04fc4355bc03` (a `name_<hex>` row key) ARE now rejected — they tag
 * one item and regenerate per row, so they poison a positional list selector.
 *
 * Pattern details:
 *   /^css-[a-z0-9]{5,}$/      : Emotion css-<hash>
 *   /^e[a-z0-9]{6,}$/         : Emotion cache-key + component short-id
 *                               (e.g. `eu4oa1w0`, `e37uo190`)
 *   /^sc-[a-z0-9]{4,}$/       : styled-components
 *   /^ecydgvn[0-9]+$/         : Emotion sub-hashes sometimes appear as
 *                               base+digit (e.g. `ecydgvn0`, `ecydgvn1`)
 *
 * @param {string} className
 * @returns {boolean} true if the class is likely auto-generated and unsafe
 *   to include in a stable selector
 */
// CANONICAL SOURCE: Core/selectorStability.js (isAutoGeneratedClass). VERBATIM MIRROR — a classic
// content script can't import ESM, so this is kept in sync by hand. Any rule change lands in BOTH. (SG-LM-1)
function isAutoGeneratedClass(className) {
  if (!className) return false;
  if (/^css-[a-z0-9]{5,}$/i.test(className)) return true;   // emotion css-<hash>
  if (/^e[a-z0-9]{6,}$/i.test(className)) return true;      // emotion e<hash>
  if (/^sc-[a-z0-9]{4,}$/i.test(className)) return true;    // styled-components sc-<hash>
  if (/^ecydgvn[0-9]+$/i.test(className)) return true;      // observed generated prefix
  // v2.74.598 — CSS-modules `name--hash` (Pixabay `button--af32y`); matches isStableIdent's --hash rule so
  // the structural builder (computeUniqueSelector) stops emitting hashed classes in the reveal pass too.
  const seg = /--([A-Za-z0-9]{4,8})$/.exec(className);
  if (seg) {
    const h = seg[1];
    const mixedCase = /[a-z]/.test(h) && /[A-Z]/.test(h);
    const alnum = /\d/.test(h) && /[A-Za-z]/.test(h);
    const vowelPoor = ((h.match(/[aeiouAEIOU]/g) || []).length / h.length) < 0.25;
    if (mixedCase || alnum || vowelPoor) return true;
  }
  // v2.74.706 — Per-instance KEY class `name_<hash>`: long-hex (Indeed `job_070d04fc4355bc03`) or
  // letter+digit hash after the last underscore. Tags ONE instance and regenerates per item — fatal to a
  // POSITIONAL read ("the first job"). Short BEM/state suffixes (`col_2`, `is_active`) are left alone.
  const useg = /_([A-Za-z0-9]{8,})$/.exec(className);
  if (useg) {
    const h = useg[1];
    const hexKey   = /^[0-9a-f]+$/i.test(h);                    // pure hex ≥8 (070d04fc4355bc03)
    const alnumKey = /[A-Za-z]/.test(h) && /\d/.test(h);        // mixed letter+digit hash ≥8
    if (hexKey || alnumKey) return true;
  }
  return false;
}

// v2.74.1008 — VERBATIM MIRROR of Core/selectorStability.selectorRelaxations (a classic content
// script can't import Core). Replay-time relaxation: a demonstrated read pinned to ONE list item
// (Indeed's job_<hash> + per-render state classes) matches 0 elements on a fresh result set; the
// OBSERVE_RAW_TEXT handler retries these progressively-relaxed variants (most-specific first) so the
// read survives. Any rule change lands in Core/selectorStability.js FIRST. (Core test is canonical.)
function selectorRelaxations(selector, { max = 20 } = {}) {
  if (!selector || typeof selector !== 'string') return [];
  const trimmed = selector.trim();
  if (!trimmed) return [];
  const cut = Math.max(
    trimmed.lastIndexOf(' '),
    trimmed.lastIndexOf('>'),
    trimmed.lastIndexOf('+'),
    trimmed.lastIndexOf('~'),
  );
  const prefix   = cut >= 0 ? trimmed.slice(0, cut + 1) : '';
  const finalSeg = cut >= 0 ? trimmed.slice(cut + 1)    : trimmed;
  const m = /^([a-zA-Z][\w-]*)?((?:\.-?[A-Za-z_][\w-]*)+)$/.exec(finalSeg);
  if (!m) return [];
  const tag     = m[1] ?? '';
  const classes = m[2].slice(1).split('.');
  if (classes.length < 2) return [];
  const build = (cls) => prefix + tag + '.' + cls.join('.');
  const out = [];
  const seen = new Set([trimmed]);
  const push = (cls) => {
    if (!cls.length) return;
    const sel = build(cls);
    if (!seen.has(sel)) { seen.add(sel); out.push(sel); }
  };
  push(classes.filter(c => !isAutoGeneratedClass(c)));        // (0) drop auto-generated only
  for (let k = classes.length - 1; k >= 1; k--) push(classes.slice(0, k));   // (1..) trailing truncation
  return out.slice(0, max);
}

// v2.74.1009 — Lead-text narrowing for a `list` read that falls through onto
// a CONTAINER. A list-observation whose archetype isn't per-item (e.g. the
// demonstrated selector is the whole Indeed job CARD, not the title node)
// reads the container's full textContent — title+company+location+salary
// concatenated ("IT Support Technician - (REMOTE)eXp World HoldingsRemote401…")
// — and that blob is what gets handed to a downstream search step. Given such
// a container, prefer its most title-like node: the first heading (h1–h6),
// else the first link. Returns { value, tag }; tag is null when the element
// is a leaf with no heading/link inside (price span, status text, …) so the
// caller falls back to full textContent and SCALAR reads stay byte-identical.
// querySelector searches DESCENDANTS only, so an element that IS the title
// finds nothing → falls back → unchanged.
function _leadTextOf(el) {
  if (!el) return { value: '', tag: null };
  const lead = el.querySelector('h1,h2,h3,h4,h5,h6') || el.querySelector('a[href]') || el.querySelector('a');
  const t = lead ? (lead.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
  if (t) return { value: t, tag: lead.tagName.toLowerCase() };
  return { value: (el.textContent ?? '').trim(), tag: null };
}

/**
 * v2.29.7 (Pass F2) — Compute a CSS selector that uniquely identifies a
 * specific element within the current document.
 *
 * Used by ENUMERATE at Fragment execution time: given N elements matching
 * a user-provided base selector, produce N distinct selectors — one per
 * element — that each resolve to exactly that element. The alternative
 * approach (earlier: `${base}:nth-of-type(k)`) was broken whenever
 * matched siblings lived under different parents (each was :nth-of-type(1)
 * of its own parent, so the index-based synthesis failed to disambiguate).
 *
 * Algorithm: walk up the parent chain from the target, building a segment
 * for each ancestor. After each added segment, test whether the partial
 * selector already uniquely identifies the target; stop as soon as it
 * does. This keeps selectors short — often a single segment suffices if
 * the target has a distinguishing class (e.g. Indeed's per-card
 * `job_<jobkey>` class).
 *
 * v2.29.9 — Filters auto-generated CSS-in-JS classes (Emotion `css-<hash>`,
 * `e<hash>`, styled-components `sc-<hash>`) since those change between
 * page renders and break selectors captured at ENUMERATE time when used
 * later at CLICK time.
 *
 * Each segment combines: tag name + stable classes + :nth-of-type among
 * same-tag siblings (only added if tag+class alone isn't unique under the
 * parent). Segments join with `>` (direct child) for stability.
 *
 * @param {Element} el - the element to identify
 * @returns {string} a CSS selector resolving to exactly this element
 */
// v2.74.839 (GA-2) — VERBATIM MIRROR of Core/selectorStability.{classifySelectorTier,selectMostDurableUnique}
// (a classic content script can't import Core). Lower tier = more durable: 1 #id · 2 test-id · 3 aria/name/role ·
// 4 one stable class · 5 multi-class · 6 tag/structural. Core/selectorStability.test.js is the canonical spec.
function classifySelectorTier(selector) {
  if (!selector || typeof selector !== 'string') return 99;
  const s = selector.trim();
  if (!s) return 99;
  const idMatch = s.match(/#([\w-]+)/);
  if (idMatch && isStableIdent(idMatch[1])) return 1;
  if (/\[\s*(data-test-id|data-testid|data-test|data-qa|data-cy)\b/i.test(s)) return 2;
  if (/\[\s*(aria-label|aria-labelledby|name|role)\b/i.test(s)) return 3;
  const classMatches = s.match(/\.[A-Za-z_][\w-]*/g) || [];
  const stableClasses = classMatches.filter(c => isStableIdent(c.slice(1)));
  if (stableClasses.length === 1) return 4;
  if (stableClasses.length >= 2) return 5;
  return 6;
}
function _mostDurableUnique(candidates) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((s) => typeof s === 'string' && s.trim());
  if (!list.length) return '';
  let best = list[0];
  let bestTier = classifySelectorTier(best);
  for (let i = 1; i < list.length; i++) {
    const t = classifySelectorTier(list[i]);
    if (t < bestTier || (t === bestTier && list[i].length < best.length)) { best = list[i]; bestTier = t; }
  }
  return best;
}

function computeUniqueSelector(el) {
  if (!el || !(el instanceof Element)) return '';

  // Fast path: if the element has a STABLE id that's unique in the document,
  // just use it. Common case for many forms / dialogs. v2.74.429 — gate on
  // isStableIdent so framework auto-ids (React useId `:r2s:`, emotion hashes,
  // long digit runs) are NOT used: they resolve uniquely at capture but
  // regenerate on the next render, so the selector is dead on reload (seen on
  // Notion, where modal items had `#:r2s:` ids).
  if (el.id && isStableIdent(el.id)) {
    try {
      const escaped = CSS.escape(el.id);
      if (document.querySelectorAll(`#${escaped}`).length === 1) {
        return `#${escaped}`;
      }
    } catch { /* fall through to segment-based */ }
  }

  // Build a segment for a given element. Includes tag, all STABLE classes
  // (auto-generated CSS-in-JS hashes are filtered), and (if needed after
  // an initial uniqueness test against the parent) a :nth-of-type among
  // same-tag siblings.
  const stableClasses = (node) => [...node.classList].filter(c => !isAutoGeneratedClass(c));

  const buildSegment = (node) => {
    const tag = node.tagName.toLowerCase();
    const classes = stableClasses(node)
      .map(c => {
        try { return `.${CSS.escape(c)}`; } catch { return ''; }
      })
      .filter(Boolean)
      .join('');
    const base = `${tag}${classes}`;

    // Check whether tag+classes alone is unique among the node's siblings
    // under its parent. If not, add :nth-of-type to disambiguate.
    const parent = node.parentElement;
    if (!parent) return base;
    let nthOfType = 1;
    let needsNth = false;
    let priorSameTagCount = 0;
    for (const sibling of parent.children) {
      if (sibling === node) break;
      if (sibling.tagName === node.tagName) priorSameTagCount++;
    }
    nthOfType = priorSameTagCount + 1;
    // If ANY sibling of the same tag matches tag+classes besides us, we
    // need :nth-of-type for disambiguation.
    let sameTagClassSiblingCount = 0;
    try {
      for (const sibling of parent.children) {
        if (sibling.tagName === node.tagName) {
          // Compare stable classes only (same filter)
          const siblingBase = `${sibling.tagName.toLowerCase()}${
            stableClasses(sibling)
              .map(c => { try { return `.${CSS.escape(c)}`; } catch { return ''; } })
              .filter(Boolean).join('')
          }`;
          if (base === siblingBase) {
            sameTagClassSiblingCount++;
          }
        }
        if (sameTagClassSiblingCount > 1) break;
      }
    } catch { /* fall through — add nth-of-type defensively */ }
    needsNth = sameTagClassSiblingCount > 1;
    return needsNth ? `${base}:nth-of-type(${nthOfType})` : base;
  };

  // Walk up, building the path until it's document-unique. v2.74.839 (GA-2) — return the first unique that is
  // DURABLE (tier <6: a stable id/class/attr appears somewhere). ONLY when the shortest unique is purely
  // structural (tier 6 — a bare `div > div:nth-of-type(3)`) keep ascending up to +2 levels to find a prefix that
  // gains a stable anchor, then take the most durable. Among same-tier candidates _mostDurableUnique keeps the
  // SHORTEST, so a page with no anchor returns exactly the old first-unique — strictly non-regressive.
  const segments = [];
  let current = el;
  const MAX_DEPTH = 20;  // safety — real DOM paths rarely exceed this
  const brittleUniques = [];
  let brittleSince = -1;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (!current || current.nodeType !== 1) break;
    segments.unshift(buildSegment(current));
    const path = segments.join(' > ');
    let matches;
    try { matches = document.querySelectorAll(path); } catch { matches = null; }
    if (matches && matches.length === 1 && matches[0] === el) {
      if (classifySelectorTier(path) < 6) return path;   // durable enough — original shortest-stable behavior
      brittleUniques.push(path);                          // purely structural — remember; try one level up
      if (brittleSince < 0) brittleSince = i;
      if (i >= brittleSince + 2) break;                   // looked far enough; take the best brittle prefix
    }
    current = current.parentElement;
    if (!current || current === document.body || current === document.documentElement) {
      // Root reached — prepend body/html as final anchor if we haven't
      // resolved. One more try with the anchor.
      if (current === document.body) {
        segments.unshift('body');
        const finalPath = segments.join(' > ');
        try {
          const final = document.querySelectorAll(finalPath);
          if (final.length === 1 && final[0] === el) { if (classifySelectorTier(finalPath) < 6) return finalPath; brittleUniques.push(finalPath); }
        } catch { /* give up */ }
      }
      break;
    }
  }

  // A purely-structural unique was the best available → pick the most durable prefix (ties keep the shortest = the
  // original first-unique). Else the longest path we could build, even if not provably unique. Caller code will at
  // worst click a nearby element — better than failing the iteration outright.
  if (brittleUniques.length) return _mostDurableUnique(brittleUniques);
  return segments.join(' > ');
}

/**
 * v2.74.707 — POSITIONAL / ARCHETYPE selector for OBSERVATIONS. Where computeUniqueSelector identifies ONE
 * specific element (instance identity — built for re-CLICK), this identifies the element's REPEATING
 * ARCHETYPE: a value-independent selector that matches the analogous element in EVERY sibling of a list,
 * plus the picked element's INDEX among them. "The first job title" then reads `matches[0]` and survives the
 * list reordering / re-skinning — because the selector is derived EMPIRICALLY from what the live list
 * actually shares, NOT from guessing which class names look auto-generated. That's what makes it
 * site-agnostic: it measures the page in front of it instead of pattern-matching a naming convention.
 *
 * Method: build the leaf's value-independent segment (tag + STABLE classes, NO :nth-of-type), then ascend,
 * prepending direct-parent context one level at a time, until the match set reads like a LIST — 2..MAX
 * visible elements spread across ≥2 distinct rows OR columns, with the picked element among them. Returns
 * null when the element isn't part of a repeat (the caller keeps the unique selector).
 *
 * @param {Element} leaf
 * @returns {{selector:string, index:number, count:number}|null}
 */
function computeArchetypeSelector(leaf) {
  if (!leaf || !(leaf instanceof Element)) return null;
  const MAX_LIST  = 200;   // a visible list rarely exceeds this; more matches ⇒ too-generic selector
  const MAX_DEPTH = 8;     // how far up to gather archetype context before giving up

  // Value-independent segment: tag + stable classes (same hash filter the unique builder uses), no nth.
  const seg = (node) => {
    const tag = node.tagName.toLowerCase();
    const classes = [...node.classList]
      .filter(c => !isAutoGeneratedClass(c))
      .map(c => { try { return `.${CSS.escape(c)}`; } catch { return ''; } })
      .filter(Boolean)
      .join('');
    return `${tag}${classes}`;
  };

  // Measure a candidate path → visible matches (document order, shadow-piercing like the runtime EXTRACT),
  // the picked leaf's index among them, and whether they read as a list (spread across rows or columns).
  const measure = (path) => {
    let all;
    try { all = queryAllDeep(path); } catch { return null; }
    const visible = all.filter(el => {
      try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; }
    });
    const index = visible.indexOf(leaf);
    if (index < 0) return null;   // path must still capture the picked element
    const tops  = new Set();
    const lefts = new Set();
    for (const el of visible) {
      try { const r = el.getBoundingClientRect(); tops.add(Math.round(r.top)); lefts.add(Math.round(r.left)); } catch { /* */ }
    }
    const listLike = visible.length >= 2 && (tops.size >= 2 || lefts.size >= 2);
    return { count: visible.length, index, listLike };
  };

  // Ascend from the leaf (shortest path first). Prepend the DIRECT parent each step (so `>` is accurate).
  // Prepending only narrows the set (monotonic), so take the SHALLOWEST list-like path in the sane band.
  let path = '';
  let node = leaf;
  for (let depth = 0; depth < MAX_DEPTH && node && node.nodeType === 1; depth++) {
    path = path ? `${seg(node)} > ${path}` : seg(node);
    const m = measure(path);
    if (m) {
      if (m.listLike && m.count <= MAX_LIST) return { selector: path, index: m.index, count: m.count };
      if (m.count === 1) return null;   // narrowed to a single instance ⇒ no clean archetype, use unique sel
    }
    node = node.parentElement;
    if (!node || node === document.body || node === document.documentElement) break;
  }
  return null;
}

// ─── v2.46.0 (Pass O1) — record-field capture for ENUMERATE ───────────────
//
// Given an item element and a field declaration { name, source, type },
// returns the captured value. Defensive — failures return null rather
// than throw, so one bad selector doesn't ruin the whole record.
//
// Field types:
//   - 'string'     → element.textContent.trim()
//   - 'presence'   → boolean: does the source selector match?
//   - 'number'     → parseFloat(textContent), null if NaN
//   - 'attribute:NAME' → element.getAttribute(NAME)
//
// Source selector is RELATIVE to the item element. Empty source (or
// no leading whitespace selector) means "this item element itself" —
// useful for capturing presence of a marker class on the item itself.
//
// @param {Element} itemEl
// @param {{name: string, source: string, type: string}} fieldDecl
// @returns {string|number|boolean|null}
function captureFieldValue(itemEl, fieldDecl) {
  if (!itemEl || !fieldDecl) return null;
  const source = String(fieldDecl.source ?? '').trim();
  const type = String(fieldDecl.type ?? '');

  // Locate the target element (or use the item itself if source is empty).
  let target;
  try {
    target = source === '' ? itemEl : itemEl.querySelector(source);
  } catch {
    return null;
  }

  if (type === 'presence') {
    // Presence is the only type that's meaningful even when target is missing.
    return !!target;
  }

  if (!target) return null;

  if (type === 'string') {
    try { return (target.textContent ?? '').trim(); } catch { return null; }
  }
  if (type === 'number') {
    try {
      const raw = (target.textContent ?? '').trim();
      // Strip non-numeric chars except - . , — handles "$22.50" → 22.50,
      // "$1,234" → 1234, "Negotiable" → NaN → null.
      const cleaned = raw.replace(/[^0-9.\-]/g, '');
      const n = parseFloat(cleaned);
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  }
  if (type.startsWith('attribute:')) {
    const attrName = type.slice('attribute:'.length);
    if (!attrName) return null;
    try {
      const v = target.getAttribute(attrName);
      return v == null ? null : String(v);
    } catch { return null; }
  }
  // Unknown type — return null defensively
  return null;
}

/**
 * v2.29.11 (Pass F3) — Sentinel for live-indexed element lookup.
 *
 * ENUMERATE produces items tagged `{baseSelector:"div.job_seen_beacon",
 * index:k}`. The binding layer stringifies these as
 * `div.job_seen_beacon:agent-hub-index(k)`. When CLICK etc. reach the
 * content script, `resolveElement` splits the sentinel out, runs
 * `querySelectorAll(base)` LIVE at the moment of action (not at enumerate
 * time), picks match k, then resolves any descendant suffix within.
 *
 * This avoids the "stringified selector goes stale" problem on sites
 * where CSS classes / tracking IDs rotate between ENUMERATE and CLICK.
 *
 * Accepts composed selectors like `div.job_seen_beacon:agent-hub-index(0) a.jcs-JobTitle`:
 *   - base = "div.job_seen_beacon"
 *   - index = 0
 *   - suffix = " a.jcs-JobTitle"
 *
 * Returns {base, index, suffix} when sentinel present, or null if not.
 * @private
 */
function parseIndexSentinel(selector) {
  // Match :agent-hub-index(N) where N is a non-negative integer.
  // Capture everything before (base + any prior parts), the index, and
  // everything after (suffix — descendant selector).
  const m = selector.match(/^(.*?):agent-hub-index\((\d+)\)(.*)$/);
  if (!m) return null;
  return { base: m[1], index: parseInt(m[2], 10), suffix: m[3] };
}

/**
 * Finds the first element matching selector, piercing shadow DOM boundaries.
 * Falls back to light-DOM only for XPath expressions.
 *
 * @param {string} selector
 * @returns {Element|null}
 */
function resolveElement(selector) {
  if (!selector || !selector.trim()) return null;

  // v2.29.11 (F3) — Handle :agent-hub-index(k) sentinel. The sentinel
  // marks a selector produced by ENUMERATE: base + index into its match
  // set. We resolve the base LIVE (not a stale stringified path) and pick
  // match k, then scope any descendant suffix within.
  const sentinel = parseIndexSentinel(selector);
  if (sentinel) {
    const { base, index, suffix } = sentinel;
    let matches;
    try {
      matches = document.querySelectorAll(base);
    } catch {
      return null;
    }
    if (index >= matches.length) return null;
    const root = matches[index];
    const trimmedSuffix = suffix.trim();
    if (!trimmedSuffix) return root;
    // Descendant lookup within root. Strip leading combinator if present.
    try {
      return root.querySelector(trimmedSuffix);
    } catch {
      return null;
    }
  }

  // XPath — light DOM only (shadow DOM XPath not supported)
  // v2.74.929 (CR-E3) — guarded: document.evaluate throws SyntaxError synchronously on malformed XPath
  // (LLM-authored selectors starting with "/" are a real input class). Unguarded, the throw escaped into
  // WAIT_FOR_ELEM's setTimeout poll (killing the loop with sendResponse never called — the caller hung to
  // its full timeout) and killed the sync FOCUS_CHECK/CHECK_ELEM listeners with a bare port-closed error.
  if (selector.startsWith('/') || selector.startsWith('./')) {
    try {
      const r = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue;
    } catch { return null; }
  }

  const candidates = selector.split(/,(?![^\[]*\])/).map(s => s.trim()).filter(Boolean);
  for (const c of candidates) {
    // Skip any selector using :has() — not supported in all querySelector contexts
    // and causes silent failures. Also skip :has-text() (Playwright-only).
    if (c.includes(':has(') || c.includes(':has-text(')) continue;
    try {
      // Try light DOM first (fast path)
      const el = document.querySelector(c);
      if (el) return el;
    } catch (_) {}
    try {
      // Pierce shadow roots
      const deep = queryAllDeep(c);
      if (deep.length > 0) return deep[0];
    } catch (_) {}
  }
  return null;
}

// ─── Action handlers ──────────────────────────────────────────────────────────

/**
 * v2.61.4 — SCROLL_TO action.
 * v2.72.62 — When called with no selector (window-level scroll), the
 * `value` argument carries a position spec:
 *   'top'      → scroll to top
 *   'bottom'   → scroll to bottom
 *   'NN%'      → scroll to NN% of document height (e.g. '50%')
 *   'NNNpx'    → scroll to NNN px from top (e.g. '500px')
 * With a selector, retains original element-scroll behavior (scrollIntoView).
 * v2.72.72 — Optional smoothScroll bool. When true, the scroll uses
 * behavior:'smooth' (animated). Default false (instant). Authored via
 * the per-action toggle in fragment-author mode.
 *
 * @param {string} selector  - CSS selector, or empty/null for window scroll
 * @param {string} value     - Position spec for window scroll
 * @param {boolean} [smoothScroll=false] - Animated scroll when true
 * @returns {{ success: boolean, info?: string, error?: string }}
 */
function handleScrollTo(selector, value, smoothScroll = false) {
  const behavior = smoothScroll ? 'smooth' : 'auto';
  // Window-level scroll when no selector.
  if (!selector || !selector.trim()) {
    const spec = String(value ?? '').trim().toLowerCase();
    const docHeight = Math.max(
      document.documentElement.scrollHeight - window.innerHeight,
      0,
    );
    let targetY;
    if (spec === 'top' || spec === '') {
      targetY = 0;
    } else if (spec === 'bottom') {
      targetY = docHeight;
    } else if (/^\d+(\.\d+)?%$/.test(spec)) {
      const pct = parseFloat(spec) / 100;
      targetY = Math.round(docHeight * Math.max(0, Math.min(1, pct)));
    } else if (/^\d+(\.\d+)?px$/.test(spec)) {
      targetY = Math.round(parseFloat(spec));
    } else if (/^-?\d+(\.\d+)?$/.test(spec)) {
      // Bare number — interpret as px
      targetY = Math.round(parseFloat(spec));
    } else {
      return { success: false, error: `SCROLL_TO: invalid window position "${spec}" (expected top, bottom, NN%, or NNNpx)` };
    }
    try {
      window.scrollTo({ top: targetY, behavior });
      return { success: true, info: `window scrolled to ${targetY}px${smoothScroll ? ' (smooth)' : ''}` };
    } catch (e) {
      return { success: false, error: `SCROLL_TO window: ${e.message}` };
    }
  }
  // Element-level scroll (legacy path).
  const el = resolveElement(selector);
  if (!el) {
    return { success: false, error: `SCROLL_TO: no element matched "${(selector || '').slice(0, 120)}"` };
  }
  try {
    el.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
    return { success: true, info: smoothScroll ? 'scrolled (smooth)' : null };
  } catch (e) {
    return { success: false, error: `SCROLL_TO: ${e.message}` };
  }
}

/**
 * v2.71.0 — Smooth scroll the window by N viewports (signed).
 *
 * Computes target distance in pixels (viewports * window.innerHeight),
 * issues window.scrollBy with smooth behavior. Waits for the scrollend
 * event so the engine can sequence subsequent steps after the scroll
 * actually completes — instant scrollBy would race with the engine's
 * next action.
 *
 * Fallback timeout (2s) covers two cases: (a) scrollend not fired in
 * older browsers, (b) page is already at the boundary (top/bottom) and
 * scrollBy is a no-op so no scroll event ever fires. Either way, after
 * 2s the resolve is unconditional.
 *
 * Returns {success: true} when the scroll completes (or fallback timeout).
 *
 * @param {number} viewports - signed viewport count
 * @returns {Promise<{success: true} | {success: false, error: string}>}
 */
function handleSmoothScroll(viewports) {
  return new Promise((resolve) => {
    if (typeof viewports !== 'number' || !Number.isFinite(viewports)) {
      resolve({ success: false, error: `SCROLL: invalid viewports value "${viewports}"` });
      return;
    }
    try {
      const vh = window.innerHeight || document.documentElement.clientHeight || 800;
      const pixels = Math.round(viewports * vh);

      // Set up scrollend listener BEFORE issuing the scroll so we don't
      // miss events. Both the listener and the timeout race; whichever
      // fires first resolves and the other is cleaned up.
      const FALLBACK_MS = 2000;
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        window.removeEventListener('scrollend', onEnd);
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ success: true });
      };

      window.addEventListener('scrollend', onEnd, { once: true });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ success: true });   // benign timeout — page may have been at boundary
      }, FALLBACK_MS);

      window.scrollBy({ top: pixels, left: 0, behavior: 'smooth' });
    } catch (e) {
      resolve({ success: false, error: e.message ?? String(e) });
    }
  });
}

/**
 * v2.74.209 — Build a human-readable diagnostic for a selector that
 * didn't match. Walks the selector left-to-right by ' > ' combinators
 * (the dominant combinator in picker-generated selectors) and reports
 * the deepest prefix that DID match plus what the failing tail tried
 * to find. When the last-matching prefix is non-empty, we also dump
 * the immediate-children tag breakdown of its first matching element
 * so the author can see why the tail didn't match (e.g. parent has
 * no <div> children at all, or its last child is a <button> not a
 * <div>).
 *
 * Format examples:
 *   ' — matched "div[data-test-id="x"]" 1× but tail "> div:last-of-type"
 *      matched 0 within (children of first match: 3 [2×<section>, 1×<button>])'
 *   ' — leftmost segment ".foo" matched 0 elements (page may not have
 *      loaded the expected scaffold)'
 *
 * Best-effort: ignores descendant (' '), sibling ('+', '~'), and comma-
 * grouped selectors. Those are rare in author-picked selectors and the
 * fallback (whole-selector count) is still useful.
 *
 * @param {string} selector
 * @returns {string} leading-space-prefixed string, or '' if input was empty
 */
function _diagnoseSelectorFailure(selector) {
  const sel = String(selector ?? '').trim();
  if (!sel) return '';
  // v2.74.210 — Prepend the frame this diagnostic ran in. Iframe vs top
  // frame is the #1 cause of "no element matched" surprises: a picker-
  // generated selector carries frameUrl metadata, but if the author
  // re-types the selector by hand the metadata is dropped and verify
  // routes to the top frame, where chat/embedded UIs don't exist.
  // Surfacing the frame tag in the error lets the author see this at a
  // glance instead of guessing.
  let frameTag = '';
  try {
    const isTop = window.top === window.self;
    frameTag = isTop
      ? ` [frame: top — ${window.location.href}]`
      : ` [frame: iframe — ${window.location.href}]`;
  } catch { frameTag = ''; }
  try {
    const segments = sel.split(' > ');
    if (segments.length < 2) {
      // No child combinator to walk; fall back to a whole-selector
      // count + first-segment hint.
      try {
        const n = document.querySelectorAll(sel).length;
        if (n === 0) {
          return ` — "${sel}" matched 0 elements${frameTag} (try a less specific selector or check the page loaded the expected DOM)`;
        }
        return ` — "${sel}" matched ${n} elements${frameTag} (none accepted by this shape)`;
      } catch (e) {
        return ` — selector parse error: ${e.message}${frameTag}`;
      }
    }

    // Walk prefixes left-to-right, tracking the deepest one that matched.
    let lastOkPrefix = '';
    let lastOkCount = 0;
    let lastOkSample = null;
    let firstFailIdx = -1;
    for (let i = 1; i <= segments.length; i++) {
      const partial = segments.slice(0, i).join(' > ');
      try {
        const els = document.querySelectorAll(partial);
        if (els.length === 0) {
          firstFailIdx = i - 1;
          break;
        }
        lastOkPrefix = partial;
        lastOkCount = els.length;
        lastOkSample = els[0];
      } catch {
        firstFailIdx = i - 1;
        break;
      }
    }

    if (firstFailIdx === 0) {
      // Even the leftmost segment didn't match.
      return ` — leftmost segment "${segments[0]}" matched 0 elements${frameTag} (wrong frame? expected DOM not loaded?)`;
    }

    const failSeg = firstFailIdx >= 0 ? segments[firstFailIdx] : '';

    // Characterize the children of the first matching element to give
    // the author a concrete picture of what's "inside" the prefix that
    // worked.
    let childInfo = '';
    if (lastOkSample) {
      try {
        const tags = {};
        for (const c of lastOkSample.children) {
          const t = (c.tagName || '').toLowerCase();
          tags[t] = (tags[t] || 0) + 1;
        }
        const tagList = Object.entries(tags)
          .map(([t, n]) => `${n}×<${t}>`)
          .join(', ');
        childInfo = ` (children of first match: ${lastOkSample.children.length} [${tagList || 'none'}])`;
      } catch { /* ignore */ }
    }

    if (!failSeg) {
      // The whole selector matched at least one element but somehow
      // returned null upstream (e.g. shape-specific filter rejected it).
      return ` — "${lastOkPrefix}" matched ${lastOkCount}× but no element was accepted by this shape${childInfo}${frameTag}`;
    }
    return ` — matched "${lastOkPrefix}" ${lastOkCount}× but tail "> ${failSeg}" matched 0 within${childInfo}${frameTag}`;
  } catch (err) {
    return ` — (diagnostic failed: ${err.message})${frameTag}`;
  }
}

/**
 * v2.74.213 — Build a rich diagnostic report for a matched element.
 * Surfaces what the author actually picked, so problems like "selector
 * landed on a scroll anchor with no text" or "wrapper has only image
 * descendants" are obvious. Output is structured JSON; the side panel
 * pretty-prints it into the Logs tab.
 *
 * Truncation:
 *   - outerHTML: 2KB (most real chat bubbles fit)
 *   - text/innerText previews: 1KB each
 *   - childPreview: first 5 children only
 *   - attribute values: 200 chars each
 *
 * @param {Element} el
 * @param {string}  selector — for echo back into the report
 * @returns {object}
 */
// ─── v2.74.239 — Landmark identity derivation (Phase 1 of the substrate
//     spec). Compute role + accessible name + hierarchical context +
//     canonical URL + canonical UID from the live DOM. These are the
//     description-layer observations that the resolver uses to find an
//     element when stored selectors go stale, and the inputs to the
//     UID hash that gives landmarks shared identity across users.
//
//     All helpers are pure DOM inspection — no DOM mutation, no I/O,
//     no LLM calls. The UID computation uses Web Crypto (async).
//     ─────────────────────────────────────────────────────────────────────

/**
 * Compute the accessibility-tree role for an element. Subset of W3C
 * accessibility role-determination per HTML AAM. Returns empty string
 * when no role applies; callers can use `tag:<tag>` fallback.
 */
function _computeA11yRole(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
  // Explicit role attribute wins (first valid token).
  const explicit = el.getAttribute && el.getAttribute('role');
  if (explicit) {
    const token = explicit.trim().split(/\s+/)[0].toLowerCase();
    if (token) return token;
  }
  // Implicit role via HTML AAM mapping.
  const tag = (el.tagName || '').toLowerCase();
  switch (tag) {
    case 'button':   return 'button';
    case 'a':        return el.hasAttribute('href') ? 'link' : '';
    case 'input': {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      switch (t) {
        case 'button': case 'submit': case 'reset': case 'image': return 'button';
        case 'checkbox': return 'checkbox';
        case 'radio':    return 'radio';
        case 'range':    return 'slider';
        case 'search':   return 'searchbox';
        case 'number':   return 'spinbutton';
        case 'file':     return 'button';
        case 'hidden':   return '';
        default:         return 'textbox';   // text, email, tel, url, password
      }
    }
    case 'textarea': return 'textbox';
    case 'select':
      return el.hasAttribute('multiple') || parseInt(el.getAttribute('size'), 10) > 1
        ? 'listbox' : 'combobox';
    case 'option':   return 'option';
    case 'img':
      // alt="" → presentation role (decorative)
      return el.getAttribute('alt') === '' ? 'presentation' : 'img';
    case 'nav':      return 'navigation';
    case 'main':     return 'main';
    case 'header':   return 'banner';
    case 'footer':   return 'contentinfo';
    case 'aside':    return 'complementary';
    case 'section':
      // Section only has 'region' role when named (per HTML AAM).
      return (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) ? 'region' : '';
    case 'article':  return 'article';
    case 'form':     return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'form' : '';
    case 'ul': case 'ol': return 'list';
    case 'li':       return 'listitem';
    case 'table':    return 'table';
    case 'tr':       return 'row';
    case 'td':       return 'cell';
    case 'th':       return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
    case 'dialog':   return 'dialog';
    case 'summary':  return 'button';
    case 'progress': return 'progressbar';
    case 'meter':    return 'meter';
    case 'hr':       return 'separator';
    case 'output':   return 'status';
    case 'datalist': return 'listbox';
    default:         return '';
  }
}

/**
 * Compute the accessible name for an element via a subset of the W3C
 * AccName algorithm. Walks the labelledby/label/text-content/alt/title
 * chain in priority order. Empty string when no name is computable.
 */
function _computeAccessibleName(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = (el.tagName || '').toLowerCase();
  // 1. aria-labelledby — resolve referenced IDs and concat their text.
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/).filter(Boolean);
    const refs = ids.map(id => document.getElementById(id)).filter(Boolean);
    if (refs.length > 0) {
      const text = refs.map(r => (r.textContent ?? '').trim()).join(' ').trim();
      if (text) return _normalizeWhitespace(text);
    }
  }
  // 2. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return _normalizeWhitespace(ariaLabel.trim());
  // 3. <label> for labelable form controls.
  if (['input', 'textarea', 'select', 'meter', 'progress', 'output'].includes(tag)) {
    if (el.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl?.textContent?.trim()) return _normalizeWhitespace(lbl.textContent.trim());
      } catch { /* invalid id selector */ }
    }
    // Ancestor <label> (wrapping pattern).
    let cur = el.parentElement;
    while (cur) {
      if ((cur.tagName || '').toLowerCase() === 'label') {
        const text = cur.textContent ?? '';
        if (text.trim()) return _normalizeWhitespace(text.trim());
        break;
      }
      cur = cur.parentElement;
    }
  }
  // 4. img alt or title.
  if (tag === 'img') {
    const alt = el.getAttribute('alt');
    if (alt !== null) return _normalizeWhitespace(alt.trim());
    const title = el.getAttribute('title');
    if (title) return _normalizeWhitespace(title.trim());
  }
  // 5. svg <title> child.
  if (tag === 'svg') {
    const titleEl = el.querySelector('title');
    if (titleEl?.textContent?.trim()) return _normalizeWhitespace(titleEl.textContent.trim());
  }
  // 6. Name-from-content roles (button, link, heading, etc.) — visible text.
  const nameFromContent = ['button', 'a', 'summary', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  if (nameFromContent.includes(tag)) {
    const text = (el.innerText ?? el.textContent ?? '').trim();
    if (text) return _normalizeWhitespace(text);
  }
  // 7. placeholder (lower priority but valid fallback for inputs).
  if (['input', 'textarea'].includes(tag)) {
    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) return _normalizeWhitespace(placeholder.trim());
  }
  // 8. title attribute (universal last-resort).
  const title = el.getAttribute('title');
  if (title?.trim()) return _normalizeWhitespace(title.trim());
  return '';
}

function _normalizeWhitespace(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Compute the hierarchical context signature — `{ ancestorRole,
 * ancestorName, siblingPosition }`. Walks up to the nearest ancestor
 * with a distinguishing role (landmark roles + named region/form),
 * and counts siblings sharing the element's own role within that
 * ancestor. Falls back to body when no distinguishing ancestor found.
 */
function _computeHierarchicalContext(el, opts = {}) {
  const DISTINGUISHING_ROLES = new Set([
    'banner', 'navigation', 'main', 'complementary', 'contentinfo',
    'region', 'form', 'search', 'article', 'dialog',
  ]);
  const myRole = _computeA11yRole(el);
  let cur = el.parentElement;
  let depth = 0;
  while (cur && depth < 50) {
    const ancestorRole = _computeA11yRole(cur);
    if (DISTINGUISHING_ROLES.has(ancestorRole)) {
      const ancestorName = _computeAccessibleName(cur);
      // Sibling position: among all elements descended from cur that
      // share `el`'s role, which index is `el`. Stable across cosmetic
      // changes because it counts by role, not by tag.
      let siblingPosition = 0;
      // v2.74.838 — siblingPosition needs an O(descendants) querySelectorAll('*') scan per element. Callers that only
      // need ancestorRole+ancestorName (e.g. enumeratePage building 100s of features) pass {siblingPosition:false} to
      // skip it; recovery (_findLandmarkCandidatesByDescription) compares ancestorRole/Name only, so 0 is safe there.
      if (myRole && opts.siblingPosition !== false) {
        try {
          const all = cur.querySelectorAll('*');
          let idx = 0;
          for (const candidate of all) {
            if (_computeA11yRole(candidate) === myRole) {
              idx++;
              if (candidate === el) { siblingPosition = idx; break; }
            }
          }
        } catch { /* ignore */ }
      }
      return { ancestorRole, ancestorName, siblingPosition };
    }
    cur = cur.parentElement;
    depth++;
  }
  // No distinguishing ancestor found.
  return { ancestorRole: 'body', ancestorName: '', siblingPosition: 0 };
}

/**
 * Canonicalize a URL per the landmark spec:
 *   - lowercase scheme + host
 *   - strip default ports (:80, :443)
 *   - strip known session query params (utm_*, sid, _, ref)
 *   - sort remaining query params alphabetically
 *   - drop fragment
 *   - drop trailing slash unless root
 *
 * Path-template collapse (`/products/123` → `/products/:id`) is
 * deferred to Phase 2 when ground-specific patterns are wired in.
 */
function _canonicalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.protocol = u.protocol.toLowerCase();
    // Note: URL.host setter is idempotent and already lowercases.
    if ((u.protocol === 'http:'  && u.port === '80') ||
        (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    // Strip session params. Pattern list is intentionally narrow for v1.
    const SESSION_PATTERNS = [/^utm_/i, /^sid$/i, /^_$/, /^ref$/i, /^fbclid$/i, /^gclid$/i, /^msclkid$/i];
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (!SESSION_PATTERNS.some(p => p.test(k))) kept.push([k, v]);
    }
    kept.sort((a, b) => a[0].localeCompare(b[0]));
    // Rebuild search.
    const params = new URLSearchParams();
    for (const [k, v] of kept) params.append(k, v);
    u.search = params.toString();
    u.hash = '';
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    u.pathname = path;
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Canonical JSON serialization — sorted object keys, no whitespace,
 * stable number/string encoding. Required to make the UID hash byte-
 * stable across implementations: same inputs → same JSON → same hash.
 */
function _canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON: non-finite number');
    // Use the spec-default JS toString — sufficient for integer
    // sibling positions; landmark inputs avoid floats.
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(_canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + _canonicalJson(value[k])).join(',') + '}';
  }
  throw new Error('canonical JSON: unsupported type: ' + typeof value);
}

/**
 * Derive the canonical landmark UID from observable inputs. SHA-256
 * of canonical-JSON-serialized inputs, first 12 hex chars, prefixed
 * with `lmk_`.
 */
async function _deriveCanonicalLandmarkUid(canonicalInputs) {
  const json = _canonicalJson(canonicalInputs);
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(json));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return 'lmk_' + hex.slice(0, 12);
}

function _localLandmarkUid() {
  // Per spec: `lmk_local_<UUID>` for landmarks without sufficient
  // canonical inputs.
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx').replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
  return 'lmk_local_' + uuid;
}

/**
 * Compose the full accessibility profile for an element. Returns the
 * UID, isCanonical flag, normalized inputs, and the derivationInputs
 * preserved for re-verification / migration. Async (Web Crypto).
 *
 * Sufficiency rule for canonical: must have BOTH a non-empty a11y
 * role AND a non-empty accessible name. Roles fall back to `tag:<tag>`
 * but that demotes to local-uid path.
 */
/**
 * v2.74.305 — Phase 1 of ACTION_SPEC compliance pass. Splits the
 * v2.74.303 single-string vocabulary into TWO orthogonal signals:
 *
 *   effect — spec-aligned substrate-level browser effects (ACTION_SPEC § 5).
 *            Bounded to 5 kinds, two with structured parameters:
 *              { kind: 'none' }
 *              { kind: 'opens-new-thread', form: 'tab'|'window'|'popup'|'sidebar' }
 *              { kind: 'triggers-navigation' }
 *              { kind: 'triggers-modal', modalKind: 'alert'|'confirm'|'prompt' }
 *              { kind: 'triggers-download' }
 *            These are signals for Tier 2 (Workflow) directive coverage
 *            (onSpawn / onNavigate / onModal / onDownload).
 *
 *   interactionPattern — DOM-level interaction shape (our addition; useful
 *            for authoring-time intelligence but NOT a substrate effect).
 *            Open vocabulary: opens-menu, switches-tab, toggles-expansion,
 *            toggles-state, submits-in-place, mutates-page, none.
 *
 * Heuristic returns BOTH from a single DOM inspection. Author / Claude
 * can refine either independently.
 *
 * Note: the previous _proposeActionEffect returned a string mixing
 * both concepts (the v2.74.303 mistake — conflating substrate effects
 * with DOM interaction shapes). This function is the corrected primitive;
 * call sites that read `proposedEffect` need to consume {effect,
 * interactionPattern} now.
 */
function _proposeActionEffect(el) {
  const UNKNOWN = { effect: { kind: 'none' }, interactionPattern: 'none' };
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return UNKNOWN;
  const tag = (el.tagName || '').toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  const inputType = (tag === 'input' ? (el.getAttribute('type') || '').toLowerCase() : '');

  // ── Anchors ───────────────────────────────────────────────────────
  if (tag === 'a') {
    if (el.hasAttribute('download')) {
      return { effect: { kind: 'triggers-download' }, interactionPattern: 'none' };
    }
    const target = (el.getAttribute('target') || '').toLowerCase();
    if (target === '_blank') {
      // spec § 5: opens-new-thread.form must be 'tab' | 'window' | 'popup' | 'sidebar'.
      // target=_blank is the most common form: a new tab (browser may
      // open as window depending on user settings, but `tab` is the
      // declarative intent).
      return { effect: { kind: 'opens-new-thread', form: 'tab' }, interactionPattern: 'none' };
    }
    const href = el.getAttribute('href') || '';
    if (/\.(pdf|zip|tar|gz|7z|rar|exe|dmg|pkg|iso|csv|tsv|xlsx?|docx?|pptx?|odt|ods|odp|mp3|mp4|mov|avi|json)(\?|$)/i.test(href)) {
      return { effect: { kind: 'triggers-download' }, interactionPattern: 'none' };
    }
    if (href && href.trim() && href !== '#' && !href.startsWith('javascript:')) {
      return { effect: { kind: 'triggers-navigation' }, interactionPattern: 'none' };
    }
  }

  // ── ARIA popup signals ────────────────────────────────────────────
  // aria-haspopup="dialog" → spec-aligned triggers-modal.
  // aria-haspopup="menu/listbox/tree/grid/true" → opens-menu (interaction
  // pattern only; not a substrate effect — the menu lives in-DOM).
  const ariaHaspopup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
  if (ariaHaspopup === 'dialog') {
    // modalKind is structural — aria-haspopup="dialog" implies a custom
    // DOM dialog, not a browser-level alert/confirm/prompt. ACTION_SPEC
    // § 5 reserves triggers-modal.modalKind for the BROWSER modal layer
    // (window.alert/confirm/prompt). A custom <dialog> or [role=dialog]
    // is NOT one of those — it's a DOM modal, not a browser modal.
    // So we surface it as interactionPattern: 'opens-menu' (best-fit
    // pattern) with effect: none. The pattern signals to downstream
    // authoring "click reveals an overlay"; the effect signals to
    // Workflow "no browser-modal directive needed."
    return { effect: { kind: 'none' }, interactionPattern: 'opens-menu' };
  }
  if (ariaHaspopup === 'menu' || ariaHaspopup === 'listbox' ||
      ariaHaspopup === 'tree' || ariaHaspopup === 'grid' ||
      ariaHaspopup === 'true') {
    return { effect: { kind: 'none' }, interactionPattern: 'opens-menu' };
  }

  // ── aria-controls → resolve to target type ────────────────────────
  const ariaControls = el.getAttribute('aria-controls');
  if (ariaControls) {
    try {
      const firstId = String(ariaControls).split(/\s+/).filter(Boolean)[0];
      const ref = firstId ? document.getElementById(firstId) : null;
      if (ref) {
        const refRole = (ref.getAttribute('role') || '').toLowerCase();
        const refTag = ref.tagName.toLowerCase();
        if (refRole === 'dialog' || refTag === 'dialog') {
          // Same reasoning as aria-haspopup="dialog" — DOM dialog, not
          // browser modal. effect stays none.
          return { effect: { kind: 'none' }, interactionPattern: 'opens-menu' };
        }
        if (refRole === 'menu' || refRole === 'listbox' ||
            refRole === 'tree' || refRole === 'grid') {
          return { effect: { kind: 'none' }, interactionPattern: 'opens-menu' };
        }
        if (refRole === 'tabpanel') {
          return { effect: { kind: 'none' }, interactionPattern: 'switches-tab' };
        }
        if (refRole === 'region' || refRole === 'group') {
          return { effect: { kind: 'none' }, interactionPattern: 'toggles-expansion' };
        }
      }
    } catch { /* invalid id selector */ }
  }

  // ── Role-based ────────────────────────────────────────────────────
  if (role === 'tab') {
    return { effect: { kind: 'none' }, interactionPattern: 'switches-tab' };
  }
  if (role === 'switch' || role === 'checkbox' ||
      role === 'radio'  || role === 'menuitemcheckbox' || role === 'menuitemradio') {
    return { effect: { kind: 'none' }, interactionPattern: 'toggles-state' };
  }

  // ── <input> form controls ─────────────────────────────────────────
  if (tag === 'input') {
    if (inputType === 'checkbox' || inputType === 'radio') {
      return { effect: { kind: 'none' }, interactionPattern: 'toggles-state' };
    }
    if (inputType === 'submit' || inputType === 'image') {
      const form = el.closest('form');
      if (form?.getAttribute('action')) {
        return { effect: { kind: 'triggers-navigation' }, interactionPattern: 'none' };
      }
      if (form) {
        return { effect: { kind: 'none' }, interactionPattern: 'submits-in-place' };
      }
    }
    if (inputType === 'reset') {
      return { effect: { kind: 'none' }, interactionPattern: 'none' };
    }
  }

  // ── <button> ──────────────────────────────────────────────────────
  if (tag === 'button') {
    if (el.hasAttribute('aria-expanded')) {
      return { effect: { kind: 'none' }, interactionPattern: 'toggles-expansion' };
    }
    const type = (el.getAttribute('type') || 'submit').toLowerCase();
    if (type === 'submit') {
      const form = el.closest('form');
      if (form?.getAttribute('action')) {
        return { effect: { kind: 'triggers-navigation' }, interactionPattern: 'none' };
      }
      if (form) {
        return { effect: { kind: 'none' }, interactionPattern: 'submits-in-place' };
      }
    }
    if (type === 'reset') {
      return { effect: { kind: 'none' }, interactionPattern: 'none' };
    }
  }

  // ── Generic interactive elements with aria-expanded ───────────────
  if (el.hasAttribute('aria-expanded')) {
    return { effect: { kind: 'none' }, interactionPattern: 'toggles-expansion' };
  }

  // ── Native <select> ───────────────────────────────────────────────
  if (tag === 'select') {
    return { effect: { kind: 'none' }, interactionPattern: 'opens-menu' };
  }

  return UNKNOWN;
}

/**
 * v2.74.250 — Phase 6.5 substrate spec: action effect observation.
 *
 * Cheap before/after snapshot of structural page state. Designed for
 * sub-millisecond capture so bracketing an action with two of these
 * adds negligible overhead beyond the settle wait itself.
 *
 * Fields chosen for signal-to-noise:
 *   url        — strongest navigation signal (free)
 *   title      — secondary navigation signal; SPA route changes
 *   topLevelCount — body.children.length delta = modal/portal mount
 *   openDialogs — direct count of role=dialog / dialog[open]
 *   h1         — visible page heading text; changes on most nav/route
 *   readyState — captures interactive→complete transitions
 *
 * NOT captured (intentionally):
 *   - Full DOM hash (too expensive, dominated by ad/analytics noise)
 *   - Attribute states (class toggles fire constantly on idle pages)
 *   - Network requests (would need webRequest permission we lack)
 */
function _captureObservationSnapshot() {
  let url = '', title = '', readyState = '';
  try { url = window.location.href || ''; } catch { /* ignore */ }
  try { title = document.title || ''; } catch { /* ignore */ }
  try { readyState = document.readyState || ''; } catch { /* ignore */ }
  let topLevelCount = 0;
  try { topLevelCount = document.body?.children?.length ?? 0; } catch { /* ignore */ }
  let openDialogs = 0;
  try {
    openDialogs = document.querySelectorAll(
      '[role="dialog"]:not([aria-hidden="true"]), dialog[open]'
    ).length;
  } catch { /* ignore */ }
  // v2.74.322 — Broaden overlay detection beyond [role=dialog]. A typical
  // custom dropdown / filter menu is a role=menu/listbox, a [popover], or a
  // tooltip — none are role=dialog, so the old openDialogs counter missed
  // them and the diff fell through to mutates-page/none. Count VISIBLE
  // overlay-role nodes (display:none → visible is the common toggle, so a
  // pre-rendered-but-hidden menu becoming visible registers as a delta).
  // aria-expanded + <details open> tallies capture in-place expansions
  // (accordions, disclosure widgets) distinctly from overlay reveals.
  const isVisible = (n) => {
    try {
      if (typeof n.checkVisibility === 'function') return n.checkVisibility();
      return n.offsetParent !== null || n.getClientRects().length > 0;
    } catch { return false; }
  };
  let overlayCount = 0;
  try {
    const nodes = document.querySelectorAll(
      '[role="menu"],[role="listbox"],[role="dialog"],[role="tooltip"],dialog[open],[popover]'
    );
    for (const n of nodes) {
      if (n.getAttribute('aria-hidden') === 'true') continue;
      if (isVisible(n)) overlayCount++;
    }
  } catch { /* ignore */ }
  // v2.74.323 — Class-name fallback for menus with NO ARIA role. Many
  // sites (e.g. Pixabay's <div class="dropdown--V2kST">) build dropdowns as
  // plain styled <div>s — no role=menu/listbox, no aria-expanded, no
  // [popover]. The role-based counter above misses them entirely and the
  // diff falls through to mutates-page. Match a case-insensitive substring
  // of common overlay-container tokens. Delta-based (see diff), so a
  // persistent nav menu — visible before AND after — contributes no delta;
  // only a menu that mounts or becomes visible on the click registers.
  let menuLikeCount = 0;
  try {
    const nodes = document.querySelectorAll(
      '[class*="dropdown" i],[class*="popover" i],[class*="flyout" i],[class*="popup" i]'
    );
    for (const n of nodes) {
      if (n.getAttribute('aria-hidden') === 'true') continue;
      if (isVisible(n)) menuLikeCount++;
    }
  } catch { /* ignore */ }
  let expandedCount = 0;
  try { expandedCount = document.querySelectorAll('[aria-expanded="true"]').length; } catch { /* ignore */ }
  let detailsOpenCount = 0;
  try { detailsOpenCount = document.querySelectorAll('details[open]').length; } catch { /* ignore */ }
  let h1 = '';
  try {
    const first = document.querySelector('h1');
    h1 = (first?.textContent ?? '').trim().slice(0, 200);
  } catch { /* ignore */ }
  return { url, title, readyState, topLevelCount, openDialogs, overlayCount, menuLikeCount, expandedCount, detailsOpenCount, h1 };
}

/**
 * Diff two observation snapshots + mutation tally into a structured
 * report with both an `observedEffect` (spec-aligned Effect object per
 * ACTION_SPEC § 8) AND an `observedInteractionPattern` (our DOM-pattern
 * signal). v2.74.305 split — pre-fix this function returned a single
 * string mixing the two concepts.
 *
 *   observedEffect (spec § 5 vocabulary):
 *     { kind: 'triggers-navigation' }  — URL or title changed
 *     { kind: 'none' }                  — no spec-level effect; check pattern
 *
 *   observedInteractionPattern (our pattern vocabulary):
 *     'mutates-page'           — structural delta without navigation
 *     'opens-menu'             — a visible menu/listbox/dialog/popover/
 *                                tooltip appeared (DOM overlay, NOT a
 *                                browser modal — browser modals require
 *                                alert/confirm/prompt hooks). v2.74.322
 *                                broadened this beyond [role=dialog].
 *     'toggles-expansion'      — an aria-expanded control opened or a
 *                                <details> disclosure opened, with no
 *                                distinct overlay node (accordion/show-more)
 *     'none'                   — quiet (≤ a few mutations, no signals)
 *
 * Drift detection lives in the engine — this function is pure diff.
 * Engine compares observedEffect to action.effect; emits action-effect-
 * mismatch event when they disagree (per spec § 8).
 *
 * Note on triggers-modal: ACTION_SPEC reserves triggers-modal for
 * BROWSER modals (alert/confirm/prompt). A DOM <dialog> appearing
 * doesn't constitute a browser modal; it's an interactionPattern
 * 'opens-menu'. Browser-modal observation requires the content-script
 * hooks landing in Phase 5.
 *
 * opens-new-thread / triggers-download: observed at the BACKGROUND
 * level (chrome.tabs.onCreated, chrome.downloads.onCreated) — NOT
 * observable from inside the content script. They get folded in by
 * ActionEffectObserver upstream when it correlates the diff with
 * background-side signals.
 */
function _diffObservationSnapshots(before, after, mutations, firstMutationTs, startTs) {
  const urlChanged   = before.url   !== after.url;
  const titleChanged = before.title !== after.title;
  const topLevelDelta = (after.topLevelCount ?? 0) - (before.topLevelCount ?? 0);
  const dialogDelta   = (after.openDialogs ?? 0)   - (before.openDialogs ?? 0);
  // v2.74.322 — Broadened overlay / expansion signals (see snapshot).
  const overlayDelta  = (after.overlayCount ?? 0)     - (before.overlayCount ?? 0);
  // v2.74.323 — Class-name menu fallback (role-less dropdowns).
  const menuLikeDelta = (after.menuLikeCount ?? 0)    - (before.menuLikeCount ?? 0);
  const expandedDelta = (after.expandedCount ?? 0)    - (before.expandedCount ?? 0);
  const detailsDelta  = (after.detailsOpenCount ?? 0) - (before.detailsOpenCount ?? 0);
  const h1Changed     = before.h1 !== after.h1;
  const readyStateChanged = before.readyState !== after.readyState;

  let observedEffect;
  let observedInteractionPattern;
  if (urlChanged) {
    observedEffect = { kind: 'triggers-navigation' };
    observedInteractionPattern = 'none';
  } else if (dialogDelta > 0 || overlayDelta > 0 || menuLikeDelta > 0) {
    // v2.74.322 — A dialog, menu, listbox, popover, or tooltip became
    // visible. Per ACTION_SPEC § 5 this is NOT a substrate effect
    // (triggers-modal is reserved for browser alert/confirm/prompt), so
    // observedEffect stays 'none'; the DOM-shape signal is opens-menu.
    // Catches custom dropdowns the old [role=dialog]-only check missed.
    // v2.74.323 — menuLikeDelta also catches role-less, class-named
    // dropdowns (e.g. Pixabay's <div class="dropdown--…">).
    observedEffect = { kind: 'none' };
    observedInteractionPattern = 'opens-menu';
  } else if (expandedDelta > 0 || detailsDelta > 0) {
    // v2.74.322 — An aria-expanded control flipped open, or a <details>
    // disclosure opened, with no distinct overlay node — in-place
    // expansion (accordion / disclosure / "show more").
    observedEffect = { kind: 'none' };
    observedInteractionPattern = 'toggles-expansion';
  } else if (titleChanged || h1Changed || topLevelDelta !== 0 || readyStateChanged) {
    observedEffect = { kind: 'none' };
    observedInteractionPattern = 'mutates-page';
  } else if (mutations > 5) {
    observedEffect = { kind: 'none' };
    observedInteractionPattern = 'mutates-page';
  } else {
    observedEffect = { kind: 'none' };
    observedInteractionPattern = 'none';
  }

  return {
    urlBefore             : before.url,
    urlAfter              : after.url,
    titleBefore           : before.title,
    titleAfter            : after.title,
    urlChanged,
    titleChanged,
    topLevelDelta,
    dialogDelta,
    overlayDelta,
    menuLikeDelta,
    expandedDelta,
    detailsDelta,
    h1Changed,
    readyStateChanged,
    mutations,
    firstMutationLatencyMs: firstMutationTs ? firstMutationTs - startTs : null,
    observedEffect,
    observedInteractionPattern,
  };
}

// Module-scope state for in-flight observation. Single observation per
// content-script context — engine is single-threaded per step.
var __ahubActionObservation = null;

async function _computeAccessibilityProfile(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
  const a11yRole = _computeA11yRole(el);
  const tag = (el.tagName || '').toLowerCase();
  const role = a11yRole || (tag ? `tag:${tag}` : '');
  const accessibleName = _computeAccessibleName(el);
  const hierarchicalContext = _computeHierarchicalContext(el);
  const canonicalUrl = _canonicalizeUrl(window.location.href);
  // Canonical requires real a11y role + accessible name. tag: fallback
  // and empty names both demote to local-uid path.
  const isCanonical = !!a11yRole && !!accessibleName;
  let uid, derivationInputs;
  if (isCanonical) {
    derivationInputs = {
      canonicalUrl,
      role         : role.toLowerCase(),
      name         : accessibleName.toLowerCase(),
      contextSignature: hierarchicalContext,
    };
    try {
      uid = await _deriveCanonicalLandmarkUid({
        url    : derivationInputs.canonicalUrl,
        role   : derivationInputs.role,
        name   : derivationInputs.name,
        context: derivationInputs.contextSignature,
      });
    } catch (e) {
      // Crypto failure — fall through to local UID rather than no UID.
      uid = _localLandmarkUid();
      derivationInputs = null;
    }
  } else {
    uid = _localLandmarkUid();
    derivationInputs = null;
  }
  // v2.74.244 — Phase 6: heuristic action effect proposal. Inspected
  // at the same time as the rest of the accessibility profile.
  // v2.74.305 — Now returns { effect, interactionPattern } object per
  // ACTION_SPEC § 5 — the substrate-level effect is split from the
  // DOM-level interaction pattern. `proposedEffect` field name is
  // retained for backwards compat with serialized records that
  // referenced it; the shape behind the name changed.
  const proposedEffect = _proposeActionEffect(el);
  return {
    uid,
    isCanonical,
    role,
    accessibleName,
    hierarchicalContext,
    canonicalUrl,
    derivationInputs,
    proposedEffect,
  };
}

/**
 * v2.74.241 — Phase 3: candidate-finder for heuristic recovery.
 *
 * Given the landmark's description-layer fields, find DOM elements
 * that match. Three-stage filter:
 *   1. Role match (via accessibility-tree role)
 *   2. Accessible name match (case-insensitive equality)
 *   3. Hierarchical context match (same ancestor role + name when
 *      both context entries are present)
 *
 * Returns an array of candidate elements. Caller decides:
 *   - length 1 → use it (heuristic recovery succeeded)
 *   - length 0 → not_found (landmark meaning gone)
 *   - length >1 → ambiguous (selectors are needed to disambiguate)
 */
// v2.74.270 — Levenshtein distance for fuzzy accessibleName recovery.
// Iterative O(n·m) time, O(min(n,m)) space. Cheap for accessibleName
// values (typically < 50 chars). Bare reimplementation here because
// content scripts can't import from Services — the same algorithm
// lives in Services/LandmarkReplacementCandidates.js (Phase 10.5).
function _levenshteinForRecovery(a, b) {
  if (a === b) return 0;
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  if (a.length > b.length) { const tmp = a; a = b; b = tmp; }
  const prev = new Array(a.length + 1);
  const curr = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost);
    }
    for (let i = 0; i <= a.length; i++) prev[i] = curr[i];
  }
  return prev[a.length];
}

function _nameSimilarityForRecovery(authored, current) {
  if (authored === current) return 1.00;
  if (!authored || !current) return 0;
  const a = String(authored).toLowerCase();
  const c = String(current).toLowerCase();
  if (a === c) return 0.95;
  if (a.includes(c) || c.includes(a)) return 0.80;
  const dist = _levenshteinForRecovery(a, c);
  const maxLen = Math.max(a.length, c.length);
  return maxLen === 0 ? 0 : Math.max(0, 1 - dist / maxLen);
}

// Threshold above which Levenshtein similarity is considered a
// plausible fuzzy match. Conservative: corresponds to the 'low'
// confidence band of Phase 10.5 candidate scoring. Below this we
// reject the fuzzy match (likely too different to be the same
// landmark). Tunable; could become a parameter if drift patterns
// warrant per-Ground tuning.
var _FUZZY_NAME_THRESHOLD = 0.65;

/**
 * v2.74.270 — Returns structured recovery candidates with the
 * match-method that produced them, so the engine can surface drift
 * to authors when fuzzy or substring matching was needed instead of
 * exact name match.
 *
 * Match-method tiers (most → least exact):
 *   'exact'      — case-insensitive exact name match
 *   'substring'  — authored name contains current OR vice versa
 *   'fuzzy'      — Levenshtein similarity ≥ _FUZZY_NAME_THRESHOLD
 *   'role-only'  — no accessibleName provided; role + context only
 *
 * Returns: { candidates, matchMethod, nameSimilarity, authoredName,
 *            matchedName }
 */
function _findLandmarkCandidatesByDescription({ role, accessibleName, hierarchicalContext }) {
  if (!role) return { candidates: [], matchMethod: null, nameSimilarity: 0 };
  // (1) Role match. Same algorithm as before — explicit role attribute
  // first, then walk for implicit roles via HTML AAM.
  let roleCandidates = [];
  try {
    const explicitMatches = Array.from(document.querySelectorAll(`[role="${role}"]`));
    for (const el of explicitMatches) roleCandidates.push(el);
  } catch { /* invalid role string for selector */ }
  try {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (_computeA11yRole(el) === role) {
        if (!roleCandidates.includes(el)) roleCandidates.push(el);
      }
    }
  } catch { /* defensive */ }
  if (roleCandidates.length === 0) {
    return { candidates: [], matchMethod: null, nameSimilarity: 0 };
  }
  // (2) Accessible name match. Tiered: exact → substring → fuzzy.
  let candidates = roleCandidates;
  let matchMethod = 'role-only';
  let nameSimilarity = 0;
  let matchedName = null;
  let nameFailed = false;   // v2.74.1532 — name-recovery exhausted; a structural recovery may still re-identify it
  if (accessibleName) {
    const authoredLc = String(accessibleName).toLowerCase();
    // Compute current names once; reuse across tiers.
    const elNames = roleCandidates.map(el => {
      const n = _computeAccessibleName(el);
      return { el, name: n, nameLc: n ? n.toLowerCase() : '' };
    });
    // Tier A: exact case-insensitive
    const exact = elNames.filter(en => en.nameLc === authoredLc && en.name);
    if (exact.length > 0) {
      candidates = exact.map(en => en.el);
      matchMethod = 'exact';
      nameSimilarity = exact[0].name === accessibleName ? 1.00 : 0.95;
      matchedName = exact[0].name;
    } else {
      // Tier B: substring (either direction)
      const substring = elNames.filter(en =>
        en.nameLc && (en.nameLc.includes(authoredLc) || authoredLc.includes(en.nameLc))
      );
      if (substring.length === 1) {
        // Substring is reliable ONLY when unambiguous. Multiple
        // substring matches usually means too-generic name (e.g.,
        // "Save" matching "Save", "Save as", "Save and continue"
        // simultaneously). Reject ambiguous substring matches.
        candidates = [substring[0].el];
        matchMethod = 'substring';
        nameSimilarity = 0.80;
        matchedName = substring[0].name;
      } else {
        // Tier C: fuzzy Levenshtein-based. Score every role candidate,
        // pick the top one if it clears threshold AND beats the next
        // by a meaningful margin (avoids picking arbitrarily between
        // two equally-similar names).
        const scored = elNames
          .filter(en => en.name)
          .map(en => ({
            el: en.el,
            name: en.name,
            score: _nameSimilarityForRecovery(authoredLc, en.nameLc),
          }))
          .sort((x, y) => y.score - x.score);
        const top = scored[0];
        const second = scored[1];
        const cleanWin = top && top.score >= _FUZZY_NAME_THRESHOLD
                       && (!second || top.score - second.score >= 0.15);
        if (cleanWin) {
          candidates = [top.el];
          matchMethod = 'fuzzy';
          nameSimilarity = top.score;
          matchedName = top.name;
        } else {
          // v2.74.1532 — all NAME tiers failed. Don't hard-fail yet: a CURRENT-VALUE-LABELED element (a division
          // selector, a status pill — a disclosure trigger whose visible text IS the value it displays) keeps its
          // ROLE + structural POSITION when its label drifts. Defer to the hierarchical-context recovery below;
          // recover ONLY when that uniquely re-identifies it (no ambiguity → no wrong click). Fixes the live
          // "Atlanta West" division-trigger unresolvable (SCROLL_TO found the h5 — it's right there — but its
          // heading now shows the CURRENT division, so name recovery rejected the correct element).
          nameFailed = true;
          candidates = roleCandidates;
          matchMethod = 'role-only';
        }
      }
    }
  }
  // (3) Hierarchical context. Same logic as before: match ancestor
  // role + name when both present; partial match acceptable; fall
  // back to pre-context list if context filtering empties.
  let contextNarrowed = false;   // v2.74.1532 — did the structural context actually FILTER the candidate set?
  if (hierarchicalContext && hierarchicalContext.ancestorRole) {
    const wantRole = hierarchicalContext.ancestorRole;
    const wantName = hierarchicalContext.ancestorName;
    const matching = candidates.filter(el => {
      const ctx = _computeHierarchicalContext(el);
      if (ctx?.ancestorRole !== wantRole) return false;
      if (wantName && ctx.ancestorName && ctx.ancestorName !== wantName) return false;
      return true;
    });
    if (matching.length > 0) { contextNarrowed = matching.length < candidates.length; candidates = matching; }
  }
  // v2.74.1532 — STRUCTURAL recovery (the "same element, drifted label" case): a name-FAILED landmark is trusted
  // ONLY when the hierarchical context NARROWED the role candidates to exactly ONE (a unique structural match → no
  // wrong click). Otherwise fail as before — a name miss with no unique structure must NOT guess by role alone.
  if (nameFailed) {
    if (contextNarrowed && candidates.length === 1) { matchMethod = 'structural'; nameSimilarity = 0; }
    else return { candidates: [], matchMethod: null, nameSimilarity: 0, authoredName: accessibleName ?? null };
  }
  return {
    candidates, matchMethod, nameSimilarity,
    authoredName: accessibleName ?? null,
    matchedName,
  };
}

/**
 * v2.74.241 — Synthesize a CSS selector that uniquely identifies an
 * element. Priority order matches the spec:
 *   1. data-test-id / data-testid / data-qa
 *   2. id (when not auto-generated-looking)
 *   3. tag + aria-label
 *   4. structural path with nth-of-type fallback
 *
 * Single-shot replacement for the failed stored selector; not
 * persisted to the landmark record (that requires explicit re-Pick).
 */
function _synthesizeSelectorForElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
  // (1) Stable test-id attributes.
  const TEST_ID_ATTRS = ['data-test-id', 'data-testid', 'data-qa', 'data-cy', 'data-selenium-test', 'data-testing-id'];
  for (const attr of TEST_ID_ATTRS) {
    const val = el.getAttribute(attr);
    if (val && val.trim()) {
      const safe = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `[${attr}="${safe}"]`;
    }
  }
  // (2) id when it's STABLE (human-readable; not a hash/numeric/framework auto-id).
  // v2.74.429 — use isStableIdent (rejects React useId `:r2s:`, emotion, long
  // digit runs) instead of the narrower hash/numeric-only test.
  if (el.id && isStableIdent(el.id)) {
    try { return `#${CSS.escape(el.id)}`; } catch { /* fall through */ }
  }
  // (3) tag + aria-label (semantic + descriptive, usually unique).
  const tag = (el.tagName || '').toLowerCase();
  const ariaLabel = el.getAttribute?.('aria-label');
  if (ariaLabel && ariaLabel.trim()) {
    const safe = ariaLabel.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const candidate = `${tag}[aria-label="${safe}"]`;
    try {
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    } catch { /* defensive */ }
  }
  // (4) Structural path with nth-of-type to make it unique.
  let path = tag;
  let cur = el;
  let depth = 0;
  while (cur.parentElement && cur !== document.body && depth < 6) {
    const parent = cur.parentElement;
    const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
    let segment;
    if (sameTag.length > 1) {
      const idx = sameTag.indexOf(cur) + 1;
      segment = `${cur.tagName.toLowerCase()}:nth-of-type(${idx})`;
    } else {
      segment = cur.tagName.toLowerCase();
    }
    path = (cur === el) ? segment : `${segment} > ${path}`;
    cur = parent;
    depth++;
  }
  return path;
}

function _buildElementInspectionReport(el, selector) {
  const HTML_LIMIT = 2000;
  const TEXT_LIMIT = 1000;
  const ATTR_LIMIT = 200;

  const tag = (el.tagName || '').toLowerCase();
  const id = el.id || null;
  const classes = (typeof el.className === 'string' && el.className)
    ? el.className.split(/\s+/).filter(Boolean)
    : [];

  // All attributes — useful for spotting data-* / aria-* mirrors of
  // the message content the author might extract from directly.
  const attrs = {};
  try {
    for (const a of el.attributes) {
      const v = a.value ?? '';
      attrs[a.name] = v.length > ATTR_LIMIT ? v.slice(0, ATTR_LIMIT) + '…' : v;
    }
  } catch { /* ignore */ }

  const textContent = (el.textContent ?? '').trim();
  let innerText = '';
  try { innerText = (el.innerText ?? '').trim(); } catch { innerText = ''; }

  // Immediate-children breakdown — tag counts plus a preview of the
  // first 5 so the author can see "ah, last-child is a div with empty
  // text, the real content is in nth-child(2)."
  const childTags = {};
  const childPreview = [];
  try {
    for (let i = 0; i < el.children.length; i++) {
      const c = el.children[i];
      const t = (c.tagName || '').toLowerCase();
      childTags[t] = (childTags[t] || 0) + 1;
      if (i < 5) {
        const cText = (c.textContent ?? '').trim();
        childPreview.push({
          index: i,
          tag: t,
          id: c.id || null,
          classes: (typeof c.className === 'string' && c.className)
            ? c.className.split(/\s+/).filter(Boolean).slice(0, 4)
            : [],
          dataTestId: c.getAttribute('data-test-id') || null,
          dataMessageId: c.getAttribute('data-message-id') || null,
          textLen: cText.length,
          textPreview: cText.slice(0, 120),
        });
      }
    }
  } catch { /* ignore */ }

  let rect = null;
  try {
    const r = el.getBoundingClientRect();
    rect = {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
      visible: r.width > 0 && r.height > 0,
    };
  } catch { /* ignore */ }

  let frame = 'top';
  try {
    frame = (window.top === window.self)
      ? `top — ${window.location.href}`
      : `iframe — ${window.location.href}`;
  } catch { /* ignore */ }

  // v2.74.218 — Parent + sibling context. When the matched element is
  // empty / zero-sized / hidden (a real case in HubSpot Breeze: the
  // StyledMarkdown div is empty when the AI's reply is a CSV/table —
  // the content lives in a SIBLING component, not inside the matched
  // markdown div). Surfacing the immediate-parent's siblings lets the
  // author see "ah, my selector hit the markdown container but the
  // content is in the sibling .CsvViewerSection-* div" — without
  // re-running Inspect on a different selector.
  let parent = null;
  try {
    const p = el.parentElement;
    if (p) {
      const pSiblingTags = {};
      let prevSibling = null;
      let nextSibling = null;
      // Find index of `el` among parent's children so we know which
      // siblings come before vs after.
      let myIdx = -1;
      for (let i = 0; i < p.children.length; i++) {
        const s = p.children[i];
        const t = (s.tagName || '').toLowerCase();
        pSiblingTags[t] = (pSiblingTags[t] || 0) + 1;
        if (s === el) {
          myIdx = i;
        }
      }
      // Build short previews of the immediately-adjacent siblings —
      // most likely place the "real" content lives when the matched
      // element is empty.
      const summarizeSibling = (sib) => {
        if (!sib) return null;
        const sText = (sib.textContent ?? '').trim();
        const cls = (typeof sib.className === 'string' && sib.className)
          ? sib.className.split(/\s+/).filter(Boolean).slice(0, 4)
          : [];
        return {
          tag: (sib.tagName || '').toLowerCase(),
          id: sib.id || null,
          classes: cls,
          dataTestId: sib.getAttribute?.('data-test-id') || null,
          dataMessageId: sib.getAttribute?.('data-message-id') || null,
          textLen: sText.length,
          textPreview: sText.slice(0, 160),
          outerHTMLPreview: (sib.outerHTML ?? '').slice(0, 400),
        };
      };
      if (myIdx > 0) prevSibling = summarizeSibling(p.children[myIdx - 1]);
      if (myIdx >= 0 && myIdx + 1 < p.children.length) {
        nextSibling = summarizeSibling(p.children[myIdx + 1]);
      }
      const pCls = (typeof p.className === 'string' && p.className)
        ? p.className.split(/\s+/).filter(Boolean)
        : [];
      const pText = (p.textContent ?? '').trim();
      parent = {
        tag: (p.tagName || '').toLowerCase(),
        id: p.id || null,
        classes: pCls,
        dataTestId: p.getAttribute?.('data-test-id') || null,
        childCount: p.children.length,
        siblingTags: pSiblingTags,
        // Index of the matched element among its parent's children.
        matchedChildIndex: myIdx,
        // Parent textContent often reveals the real content when the
        // matched element is empty.
        textLen: pText.length,
        textPreview: pText.slice(0, 600),
        outerHTMLPreview: (p.outerHTML ?? '').slice(0, 1200),
        prevSibling,
        nextSibling,
      };
    }
  } catch { /* ignore */ }

  // v2.74.218 — Heuristic warning when the matched element is empty
  // AND its parent has content. Strong signal that the author is on
  // the wrong selector and should look at parent/siblings.
  let warning = null;
  if (textContent.length === 0 && innerText.length === 0 && (el.children?.length ?? 0) === 0) {
    if (parent && parent.textLen > 0) {
      warning = `matched element is empty but its parent has ${parent.textLen} chars of content — check parent.outerHTMLPreview / nextSibling for the real content`;
    } else {
      warning = 'matched element is empty (no text, no children) — selector may be hitting a placeholder/wrapper';
    }
  }

  // v2.74.234 — Capability fingerprint for landmark-authoring Wave 1.
  // Captures the deterministic, rule-based signals downstream consumers
  // need to know: what kind of element this is, which operations it
  // supports, whether it's currently usable. Pure DOM inspection — no
  // LLM, no heuristics that could surprise the author. The LandmarkProfile
  // service consumes this fingerprint to derive `capabilities` and
  // `operations.allowed`, and to compute the verification score.
  const inputType        = (tag === 'input' && typeof el.type === 'string') ? el.type.toLowerCase() : null;
  const ariaRole         = el.getAttribute?.('role') ?? null;
  const ariaLabel        = el.getAttribute?.('aria-label') ?? null;
  const ariaDisabled     = el.getAttribute?.('aria-disabled') === 'true';
  const ariaHidden       = el.getAttribute?.('aria-hidden')   === 'true';
  const isDisabled       = el.disabled === true || ariaDisabled;
  const isReadOnly       = el.readOnly === true || el.getAttribute?.('readonly') !== null;
  const isContentEditable = el.isContentEditable === true ||
                            ['true', 'plaintext-only'].includes(String(el.getAttribute?.('contenteditable') ?? '').toLowerCase());
  const hasOnclickAttr   = typeof el.getAttribute?.('onclick') === 'string';
  // Computed style — visibility + pointer-event surface. Safe in iframes;
  // returns the empty CSSStyleDeclaration for detached nodes.
  let cs = null;
  try { cs = window.getComputedStyle(el); } catch { /* ignore */ }
  const computedStyle = cs ? {
    display       : cs.display,
    visibility    : cs.visibility,
    pointerEvents : cs.pointerEvents,
    cursor        : cs.cursor,
  } : null;
  const isCssHidden = !cs ||
                      cs.display === 'none' ||
                      cs.visibility === 'hidden' ||
                      cs.opacity === '0';
  // Visibility: non-zero box AND not CSS-hidden AND not aria-hidden.
  const isVisible   = !!rect && rect.visible === true && !isCssHidden && !ariaHidden;
  // Interactability: visible AND not disabled AND pointer-events isn't
  // forced to 'none' (which would block clicks entirely).
  const isInteractable = isVisible && !isDisabled && cs?.pointerEvents !== 'none';
  // Sibling pattern — does this element look like one of N similar
  // items in a feed/list? Counts siblings sharing the same tag.
  let siblingsSameTag = 0;
  let selfIndexAmongSameTag = -1;
  try {
    if (el.parentElement) {
      const sameTag = Array.from(el.parentElement.children).filter(c => c.tagName === el.tagName);
      siblingsSameTag = sameTag.length;
      selfIndexAmongSameTag = sameTag.indexOf(el);
    }
  } catch { /* ignore */ }

  // v2.74.285 — Clickable-descendants probe. Counts elements within
  // this landmark that are themselves clickable (anchors, buttons,
  // role=button/link/menuitem/tab/option, contenteditable). Powers the
  // "container with clickable children" capability used by
  // deriveAllowedOperations to open CLICK_BY_LABEL on container
  // landmarks — closes the gap where a tag list / nav region / card
  // grid that's a <div> at the top wouldn't expose CLICK_BY_LABEL
  // despite obviously supporting it.
  //
  // Selector matches the same patterns _classifyElementShapes uses
  // for "button" / "link" so the capability stays consistent with the
  // direct-element rules.
  let clickableDescendantCount = 0;
  let clickableDescendantSampleLabels = [];
  try {
    const clickableSelector = [
      'a[href]',
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      'input[type="reset"]',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[role="option"]',
      '[role="switch"]',
      '[onclick]',
    ].join(',');
    const matches = el.querySelectorAll(clickableSelector);
    clickableDescendantCount = matches.length;
    // Capture up to 8 visible labels so downstream consumers (and
    // Claude when refining) have CLICK_BY_LABEL anchors to reason
    // about. Cheap walk; bounded.
    for (let i = 0; i < matches.length && clickableDescendantSampleLabels.length < 8; i++) {
      const child = matches[i];
      let label = '';
      try {
        label = (child.getAttribute('aria-label')
              || child.textContent
              || child.getAttribute('title')
              || child.getAttribute('value')
              || '').trim().slice(0, 60);
      } catch { /* ignore */ }
      if (label) clickableDescendantSampleLabels.push(label);
    }
  } catch { /* defensive — invalid querySelectorAll input shouldn't happen */ }

  return {
    selector,
    tag,
    id,
    classes,
    attrs,
    childCount: el.children?.length ?? 0,
    childTags,
    childPreview,
    textLength: textContent.length,
    innerTextLength: innerText.length,
    textPreview: textContent.slice(0, TEXT_LIMIT),
    innerTextPreview: innerText.slice(0, TEXT_LIMIT),
    outerHTMLPreview: (el.outerHTML ?? '').slice(0, HTML_LIMIT),
    hasShadowRoot: !!el.shadowRoot,
    rect,
    frame,
    // v2.74.294 — Viewport metadata for the sidepanel's screenshot
    // cropper. Pre-fix, the sidepanel guessed DPR by dividing the
    // captured image width by its OWN window.innerWidth — but the
    // sidepanel window is ~400px, completely unrelated to the
    // captured tab's viewport. That produced wildly wrong scale
    // factors (e.g. 1200/400 = 3×) and the crop landed in the
    // wrong region with bloated dimensions. Now the page's actual
    // devicePixelRatio rides on the inspection report, so the
    // cropper doesn't have to guess.
    viewportInfo: {
      dpr           : (typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0) ? window.devicePixelRatio : 1,
      viewportWidth : window.innerWidth ?? 0,
      viewportHeight: window.innerHeight ?? 0,
      scrollX       : window.scrollX ?? 0,
      scrollY       : window.scrollY ?? 0,
    },
    // v2.74.218 — Parent + sibling context for diagnosing empty matches.
    parent,
    warning,
    // v2.74.234 — Capability fingerprint (rule-based, deterministic).
    inputType,
    ariaRole,
    ariaLabel,
    isDisabled,
    isReadOnly,
    isContentEditable,
    hasOnclickAttr,
    computedStyle,
    isVisible,
    isInteractable,
    siblingsSameTag,
    selfIndexAmongSameTag,
    // v2.74.285 — Container-scope clickability probe.
    clickableDescendantCount,
    clickableDescendantSampleLabels,
  };
}

/**
 * @param {string} selector
 * @param {string} _value unused
 * @returns {{ success: boolean, error?: string }}
 */
function handleClick(selector, _value) {
  const el = resolveElement(selector);
  if (!el) {
    // v2.29.10 — Diagnostic: selector didn't match. Capture URL + how many
    // elements match each prefix of the selector to localize WHERE the
    // selector went stale. Essential when per-item selectors captured at
    // ENUMERATE time fail at CLICK time — tells us whether the page
    // changed, whether the first segment is still valid, etc.
    let diag = '';
    try {
      // Count matches for incrementally shorter selectors to find where
      // the match count drops to 0.
      const segments = selector.split(' > ');
      const stepCounts = [];
      for (let i = 1; i <= segments.length; i++) {
        const partial = segments.slice(0, i).join(' > ');
        try {
          const n = document.querySelectorAll(partial).length;
          stepCounts.push(`seg${i}:${n}`);
          if (n === 0) break;  // stop once we hit a zero-match prefix
        } catch (e) {
          stepCounts.push(`seg${i}:ERR`);
          break;
        }
      }
      diag = ` [url=${location.pathname}, matches per prefix: ${stepCounts.join(' ')}]`;
    } catch { /* best-effort diagnostic */ }
    return { success: false, error: `CLICK: no element matched "${selector.slice(0, 120)}"${diag}` };
  }
  try {
    // v2.29.13 — Capture what we're about to click, for diagnostic return.
    // Helps confirm per-iteration clicks land on DIFFERENT elements when
    // the FOREACH behaves strangely (postconditions trivially pass from
    // prior iteration's state, etc.).
    const clickedInfo = {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      text: (el.textContent || '').trim().slice(0, 60),
      href: el.getAttribute?.('href') ?? null,
      ariaPressedBefore: el.getAttribute?.('aria-pressed') ?? null,
    };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    try { el.focus?.(); } catch { /* not every target is focusable (e.g. <svg>) — don't let it abort the click */ }
    if (typeof el.click === 'function') {
      el.click();
    } else {
      // v2.74.814 — SVG and other non-HTMLElement targets have no .click() method, so a captured icon glyph
      // (e.g. Notion's "+" <svg.plusSmall>) threw "el.click is not a function". Dispatch a bubbling synthetic
      // MouseEvent instead: it reaches the page's listener on an ancestor (React onClick / event delegation).
      clickedInfo.via = 'synthetic';
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
    return { success: true, clicked: clickedInfo };
  } catch (e) {
    return { success: false, error: `CLICK: ${e.message}` };
  }
}

/**
 * Selects an option in a native <select> element by value or visible text.
 * Sets element.value directly and dispatches input + change events so
 * framework listeners (React, Vue, Angular) pick up the change.
 *
 * @param {string} selector - CSS selector targeting the <select> element.
 * @param {string} value    - Option value attribute OR visible option text to select.
 * @returns {{ success: boolean, error?: string }}
 */
function handleSelect(selector, value) {
  const el = resolveElement(selector);
  if (!el) return { success: false, error: `SELECT: no element matched "${selector.slice(0, 120)}"` };
  if (!(el instanceof HTMLSelectElement)) return { success: false, error: `SELECT: element is not a <select> ("${selector.slice(0, 80)}")` };

  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();

    // Try matching by value attribute first, then by visible text
    let matched = false;
    // v2.74.580 — trial sentinel (mirrors Core/trialSynth.TRIAL_SELECT_FIRST): pick the first SELECTABLE
    // option, skipping a leading placeholder (empty value / disabled). Lets a trial exercise a dropdown
    // without knowing valid option values.
    if (value === '__ahub_trial_first_option__') {
      const opt = Array.from(el.options).find((o) => o.value !== '' && !o.disabled) || el.options[0] || null;
      if (opt) { el.value = opt.value; matched = true; }
    }
    if (!matched) for (const opt of el.options) {
      if (opt.value === value || opt.text.trim() === value) {
        el.value = opt.value;
        matched = true;
        break;
      }
    }

    // If no match found and value looks like an index, select by position
    if (!matched && /^\d+$/.test(value)) {
      const idx = parseInt(value, 10);
      if (idx >= 0 && idx < el.options.length) {
        el.selectedIndex = idx;
        matched = true;
      }
    }

    if (!matched) return { success: false, error: `SELECT: no option matched "${value}" in "${selector.slice(0, 80)}"` };

    // Use native setter to trigger React synthetic events
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, el.value);

    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  } catch (e) {
    return { success: false, error: `SELECT: ${e.message}` };
  }
}

/**
 * SET_FILE (SG-#81c) — set a file <input>'s files WITHOUT CDP. `input.files` rejects a direct value but
 * accepts a FileList built from a DataTransfer. For a TRIAL we attach a tiny SYNTHETIC file (no real
 * document is read from disk) so the page's onChange/validation fires — proving the control accepts an
 * upload. `value` may carry a filename hint (its extension picks the MIME). Visibility-agnostic: the
 * native input is usually hidden behind a styled "Choose File" button.
 */
function handleSetFile(selector, value) {
  const el = resolveElement(selector);
  if (!el) return { success: false, error: `SET_FILE: no element matched "${String(selector).slice(0, 120)}"` };
  if (!(el instanceof HTMLInputElement) || (el.getAttribute('type') || '').toLowerCase() !== 'file') {
    return { success: false, error: `SET_FILE: element is not <input type=file> ("${String(selector).slice(0, 80)}")` };
  }
  try {
    const hint = (typeof value === 'string' && /\.[a-z0-9]{2,5}$/i.test(value.trim())) ? value.trim() : 'trial-upload.pdf';
    const isPdf = hint.toLowerCase().endsWith('.pdf');
    const file = new File([isPdf ? '%PDF-1.4\n% trial upload\n' : 'trial upload'], hint, { type: isPdf ? 'application/pdf' : 'text/plain' });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, fileName: hint, fileCount: el.files.length };
  } catch (e) {
    return { success: false, error: `SET_FILE: ${e.message}` };
  }
}

/**
 * v2.72.91 — CLICK_BY_LABEL: click an option inside a container by its
 * visible label.
 *
 * Use case: custom dropdowns / menus / autocomplete suggestions where
 * the menu items are <div>s or <li>s rather than native <option>s.
 * Authors pair this with a preceding CLICK that opens the menu; this
 * action then picks the option by its label.
 *
 * Selector: the menu CONTAINER (must be open / visible at execute time).
 * Value:    the option label to click. Either a literal string ("USA")
 *           or a parameter reference that the engine substitutes at
 *           runtime via InjectionService.injectParams.
 *
 * Match priority (within container):
 *   1. Descendants with role="option" (case-insensitive exact text match)
 *   2. Descendants with role="menuitem"
 *   3. Interactive descendants — a, button, [role=button], [role=link],
 *      [tabindex] (v2.72.92: anchor-based tag scrollers and button menus
 *      were silently broken before this; click would land on a non-
 *      clickable wrapper instead of the actual link/button)
 *   4. Direct children of the container (wrapper-div pattern)
 *   5. All descendants (last resort)
 *
 * Match rule: case-insensitive, trimmed, whitespace-collapsed exact
 * match against the candidate's textContent; when no exact match, a
 * contains fallback (shortest containing label wins — rollup rows like
 * "Atlanta West - 210 All" before vendor-specific duplicates). First
 * match wins; multiple matches log a warning in info but click the first.
 *
 * Verify-time sentinel: when value is "__VERIFY_FIRST__" (set by
 * fragment-author when the user's saved value is parameterized),
 * click the first candidate found in the priority order — validates
 * the container and that options exist + are clickable, without
 * caring about label resolution.
 *
 * @param {string} selector - CSS selector for the menu container.
 * @param {string} value    - Option label or "__VERIFY_FIRST__" sentinel.
 * @returns {{ success: boolean, error?: string, clicked?: object, info?: string }}
 */
async function handleClickByLabel(selector, value) {
  // v2.74.1535 — POLL for the container. A menu opened by the PRECEDING click (e.g. the division dropdown
  // #divisionMenu, opened by the trigger click) renders ASYNC — it's usually not in the DOM the instant this step
  // runs, because the demo had human delay between opening the menu and picking an option and the replay has none
  // (live: the re-taught "Search ticket by division" walk clicked the division trigger, then CLICK_BY_LABEL
  // #divisionMenu hard-failed "no container matched" on that race). Wait up to ~2.5s (mirrors WAIT_FOR) before
  // giving up, instead of failing on the first tick.
  let container = resolveElement(selector);
  for (let i = 0; i < 10 && !container; i++) {
    await new Promise((r) => setTimeout(r, 250));
    container = resolveElement(selector);
  }
  if (!container) {
    return {
      success: false,
      error: `CLICK_BY_LABEL: no container matched "${selector.slice(0, 120)}"`,
    };
  }

  // Verify-time sentinel: click first option, regardless of label.
  // Used during T1 authoring when the saved value is a parameter
  // reference like {{LABEL}}.
  if (value === '__VERIFY_FIRST__') {
    const first = _findFirstOptionCandidate(container);
    if (!first) {
      return {
        success: false,
        error: 'CLICK_BY_LABEL: container has no clickable options (verify mode)',
      };
    }
    try {
      first.scrollIntoView({ block: 'center', behavior: 'instant' });
      first.click();
      return {
        success: true,
        clicked: {
          tag: first.tagName.toLowerCase(),
          text: (first.textContent || '').trim().slice(0, 60),
          verifyMode: true,
        },
      };
    } catch (e) {
      return { success: false, error: `CLICK_BY_LABEL (verify): ${e.message}` };
    }
  }

  // Normalized target label for matching.
  const target = _normalizeLabelForMatch(value);
  if (!target) {
    // v2.74.877 — an UNRESOLVED / empty label (an optional filter the ask didn't specify, or an unfilled
    // {{PARAM}}) is a NO-OP, not a failure: there is nothing to click, so SKIP the step instead of aborting
    // the whole run. Generalizes the .809 placeholder fix (unset TYPE → blank) to label-bound clicks — e.g.
    // "search pixabay for videos about fable" with no CATEGORY no longer dies on the category-select click.
    return { success: true, skipped: true, info: 'CLICK_BY_LABEL: empty label — skipped (no option to select)' };
  }

  // Find candidates in priority order, return first match.
  const matches = _findLabelMatches(container, target);
  if (matches.length === 0) {
    // Build a helpful error listing available labels — speeds up author
    // debugging when the menu's label text doesn't match expectations.
    const available = _listAvailableLabels(container);
    const sample = available.slice(0, 8).map(s => `"${s}"`).join(', ');
    const more = available.length > 8 ? ` (and ${available.length - 8} more)` : '';
    return {
      success: false,
      error: `CLICK_BY_LABEL: no option matched "${value}" in container "${selector.slice(0, 80)}". Available: ${sample || '(none found)'}${more}`,
    };
  }

  const target_el = matches[0];
  const multipleNote = matches.length > 1
    ? ` (${matches.length} options matched; clicked first)`
    : '';

  try {
    target_el.scrollIntoView({ block: 'center', behavior: 'instant' });
    target_el.click();
    return {
      success: true,
      clicked: {
        tag: target_el.tagName.toLowerCase(),
        text: (target_el.textContent || '').trim().slice(0, 60),
        matchedLabel: value,
      },
      info: multipleNote || undefined,
    };
  } catch (e) {
    return { success: false, error: `CLICK_BY_LABEL: ${e.message}` };
  }
}

/**
 * v2.72.92 — Selector for "interactive descendants" — elements that are
 * actually clickable in the DOM sense (anchors, buttons, role=button/link,
 * focusable via tabindex). Used as a priority level between role-based
 * queries and the direct-children fallback.
 *
 * Why it matters: anchor-based menus like tag scrollers wrap each option
 * as <div><a>label</a></div>. The wrapper <div>'s textContent matches the
 * label, but click() on the wrapper does nothing — only the <a> navigates.
 * This selector captures the actually-clickable element so CLICK_BY_LABEL
 * lands on the thing that DOES something.
 */
var _CLICKABLE_DESCENDANTS_SEL = 'a, button, [role="button"], [role="link"], [tabindex]';

/** Find the first clickable option inside a container, in priority order. */
function _findFirstOptionCandidate(container) {
  // Priority: role=option > role=menuitem > interactive descendants >
  //           direct children > any descendant
  const byRoleOption = container.querySelector('[role="option"]');
  if (byRoleOption) return byRoleOption;
  const byRoleMenuitem = container.querySelector('[role="menuitem"]');
  if (byRoleMenuitem) return byRoleMenuitem;
  // v2.72.92 — Prefer actually-clickable descendants (anchors, buttons).
  const byInteractive = container.querySelector(_CLICKABLE_DESCENDANTS_SEL);
  if (byInteractive) return byInteractive;
  // Direct children with text content
  for (const child of container.children) {
    if ((child.textContent || '').trim()) return child;
  }
  // Any descendant with text — last resort, probably wrong but surfaces
  // an error in the author's verify result rather than silently doing nothing.
  return container.querySelector('*');
}

/**
 * Find all elements matching the target label within the container,
 * in priority order. Returns array; caller picks first.
 *
 * v2.72.92 — Added "interactive descendants" priority level (anchors,
 * buttons, role=button/link, [tabindex]) between role-based queries and
 * direct-children fallback. Without this, <div><a>label</a></div>-shaped
 * menus would match the wrapper <div>, and click() on the wrapper does
 * nothing.
 */
function _findLabelMatches(container, normalizedTarget) {
  const matchIn = (els, mode) => {
    const out = [...els].filter((el) => {
      const text = _normalizeLabelForMatch(el.textContent || '');
      if (mode === 'exact') return text === normalizedTarget;
      return text.includes(normalizedTarget);
    });
    if (mode === 'contains' && out.length > 1) {
      // Shortest containing label wins — e.g. "Atlanta West" → "Atlanta West - 210 All" before vendor-specific duplicates.
      out.sort((a, b) => _normalizeLabelForMatch(a.textContent || '').length - _normalizeLabelForMatch(b.textContent || '').length);
    }
    return out;
  };
  const tryGroup = (selector, mode) => matchIn(container.querySelectorAll(selector), mode);

  const groups = ['[role="option"]', '[role="menuitem"]', _CLICKABLE_DESCENDANTS_SEL];
  for (const mode of ['exact', 'contains']) {
    for (const sel of groups) {
      const g = tryGroup(sel, mode);
      if (g.length > 0) return g;
    }
    // v2.74.1537 — direct-children are a valid match ONLY in EXACT mode (a wrapper whose OWN text IS the label).
    // In CONTAINS mode a direct child can be a big CONTAINER that merely CONTAINS the label — the <ul> inside
    // #divisionMenu holds EVERY division, so it "contains Raleigh" and was clicked instead of the Raleigh row
    // (live 201523: CLICK_BY_LABEL "Raleigh" landed on <ul>, the division never switched). Skip straight to the
    // all-descendants scan, which returns the SHORTEST containing element (the division-name span); the click
    // bubbles up to its clickable row.
    if (mode === 'exact') {
      const direct = matchIn(container.children, mode);
      if (direct.length > 0) return direct;
    }
    const any = tryGroup('*', mode);
    if (any.length > 0) return any;
  }
  return [];
}

/**
 * Get list of visible labels in the container, for error messages.
 * v2.72.92 — Walks the same priority groups as _findLabelMatches so the
 * "available labels" listed in errors reflect what the matcher would
 * actually consider. Without this, an anchor-menu's error would list
 * concatenated wrapper-div text instead of individual link labels.
 */
function _listAvailableLabels(container) {
  const seen = new Set();
  const out = [];
  // Same priority order as _findLabelMatches
  const groups = [
    container.querySelectorAll('[role="option"]'),
    container.querySelectorAll('[role="menuitem"]'),
    container.querySelectorAll(_CLICKABLE_DESCENDANTS_SEL),
    container.children,
  ];
  for (const group of groups) {
    for (const el of group) {
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (text && text.length < 80 && !seen.has(text)) {
        seen.add(text);
        out.push(text);
        if (out.length >= 16) return out;
      }
    }
    if (out.length > 0) return out;   // first non-empty priority level wins
  }
  return out;
}

/** Normalize label for matching: trim, collapse whitespace, lowercase. */
function _normalizeLabelForMatch(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Types text into an element. Handles four element types in priority order:
 *
 *   1. Native input / textarea — paced character-by-character via the
 *      React-compatible native value setter, dispatching per-character
 *      keydown/keypress/input/keyup with realistic timing.
 *   2. Directly contenteditable element — selectAll then per-character
 *      insertText with same per-character event sequence.
 *   3. Container with a contenteditable child (ProseMirror pattern) — the
 *      outer div is matched by selector but the actual editable region is a
 *      child div[contenteditable="true"]. Find and target that child instead.
 *   4. Fallback — focus and dispatch keyboard events.
 *
 * Always clears existing content before typing so stale text from prior
 * walk runs does not prefix the new value.
 *
 * v2.40.0 (Tier 1) — paced typing. Previous implementation set the entire
 * value in one shot and dispatched one input + one change event. Bot
 * detectors flag this distinctively — a real keyboard cannot produce a
 * value transition from "" to "Banker" in zero ms with no surrounding
 * keydown sequence. Now we type character by character with ~50-150ms
 * jitter between keys, matching the cadence of a moderately fast typist
 * (~80 wpm). Total typing time scales with value length, which is the
 * point — we are intentionally slower than bursts in order to look like
 * a person at a keyboard.
 *
 * Trade-off: a 20-character value now takes ~1.5-3 seconds to type. The
 * fragment's 200ms inter-action delay still applies on top of that.
 *
 * @param {string} selector
 * @param {string} value
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function handleType(selector, value) {
  const el = resolveElement(selector);
  if (!el) return { success: false, error: `TYPE: no element matched "${selector.slice(0, 120)}"` };

  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });

    // ── 1. Native input / textarea ───────────────────────────────────────
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const setValue = (v) => {
        if (setter) setter.call(el, v);
        else        el.value = v;
      };

      // Clear existing content first
      setValue('');
      el.dispatchEvent(new Event('input', { bubbles: true }));

      // Type each character with realistic per-key timing + events
      await typeStringPaced(el, value, setValue);

      // Final change event mimics blur-or-commit semantics
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true };
    }

    // ── 2. Directly contenteditable ──────────────────────────────────────
    if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await typeContentEditablePaced(el, value);
      return { success: true };
    }

    // ── 3. ProseMirror / rich-text container pattern ─────────────────────
    // The selector matched an outer container div (e.g. data-test-id=
    // "prose-mirror-chat-input") but the actual editable region is a
    // contenteditable child. Search within the matched element and within
    // its shadow root for the first contenteditable descendant.
    const editableChild = (function findEditable(root) {
      // Direct querySelector within this root
      const direct = root.querySelector('[contenteditable="true"]');
      if (direct) return direct;
      // Search shadow roots of children
      const all = root.querySelectorAll('*');
      for (const child of all) {
        if (child.shadowRoot) {
          const inShadow = child.shadowRoot.querySelector('[contenteditable="true"]');
          if (inShadow) return inShadow;
        }
      }
      return null;
    }(el));

    if (editableChild) {
      editableChild.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await typeContentEditablePaced(editableChild, value);
      // Surface input event on the container too so framework listeners at
      // either level pick up the change.
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { success: true };
    }

    // ── 4. Fallback ───────────────────────────────────────────────────────
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    el.textContent = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { success: true };

  } catch (e) {
    return { success: false, error: `TYPE: ${e.message}` };
  }
}

// ─── Paced typing helpers ─────────────────────────────────────────────────

/**
 * Returns a randomized delay between keystrokes in ms. Centered around
 * ~85ms (≈ 80 wpm) with jitter — most keys 50-150ms, occasional outliers
 * up to ~300ms simulating brief pauses. Real human typing has bursts and
 * pauses; pure uniform jitter looks too regular.
 * @returns {number}
 */
function nextKeystrokeDelayMs() {
  // 85% of keystrokes: 40-180ms (normal flow)
  // 15% of keystrokes: 180-350ms (occasional thinking pause)
  const r = Math.random();
  if (r < 0.85) return 40 + Math.random() * 140;
  return 180 + Math.random() * 170;
}

/**
 * Type a string into a native input/textarea one character at a time.
 * For each character: dispatch keydown → update value → dispatch input
 * → dispatch keypress → dispatch keyup, with a randomized delay between
 * characters. This produces the event sequence a real keyboard would
 * emit and the per-key timing real typing has.
 *
 * @param {HTMLInputElement|HTMLTextAreaElement} el
 * @param {string} value
 * @param {(v:string)=>void} setValue - React-compatible value setter
 * @returns {Promise<void>}
 */
async function typeStringPaced(el, value, setValue) {
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const keyInit = keyInitFromChar(ch);

    // keydown — fire BEFORE the value updates (matches real keyboards)
    el.dispatchEvent(new KeyboardEvent('keydown', { ...keyInit, bubbles: true, cancelable: true }));

    // Update value by appending this character
    current += ch;
    setValue(current);

    // input event reflects the value change
    el.dispatchEvent(new Event('input', { bubbles: true }));

    // keypress — only for printable characters (matches browser behavior).
    // Note: keypress is deprecated but still emitted by real keyboards
    // for printable chars in major browsers, so detectors look for it.
    if (isPrintable(ch)) {
      el.dispatchEvent(new KeyboardEvent('keypress', { ...keyInit, bubbles: true, cancelable: true }));
    }

    // keyup
    el.dispatchEvent(new KeyboardEvent('keyup', { ...keyInit, bubbles: true, cancelable: true }));

    // Per-character delay
    if (i < value.length - 1) {
      await new Promise(r => setTimeout(r, nextKeystrokeDelayMs()));
    }
  }
}

/**
 * Type a string into a contenteditable element one character at a time.
 * Uses execCommand('insertText') for the actual character insertion (which
 * triggers the right native input events on contenteditable) but adds the
 * surrounding keydown/keyup events and per-character delay.
 *
 * @param {Element} el - the contenteditable element to type into (focused)
 * @param {string} value
 * @returns {Promise<void>}
 */
async function typeContentEditablePaced(el, value) {
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const keyInit = keyInitFromChar(ch);

    el.dispatchEvent(new KeyboardEvent('keydown', { ...keyInit, bubbles: true, cancelable: true }));

    // insertText fires its own native input event with the right
    // inputType/data fields — preferred over manual textContent munging
    // because it works correctly with framework editors (ProseMirror,
    // Slate, Lexical, etc).
    document.execCommand('insertText', false, ch);

    if (isPrintable(ch)) {
      el.dispatchEvent(new KeyboardEvent('keypress', { ...keyInit, bubbles: true, cancelable: true }));
    }
    el.dispatchEvent(new KeyboardEvent('keyup', { ...keyInit, bubbles: true, cancelable: true }));

    if (i < value.length - 1) {
      await new Promise(r => setTimeout(r, nextKeystrokeDelayMs()));
    }
  }
}

/**
 * Build a KeyboardEventInit-like object from a character. Sets `key` to
 * the character and `code` to a best-guess physical key code so detectors
 * that cross-reference key vs code don't see obvious mismatches.
 *
 * @param {string} ch
 * @returns {{ key: string, code: string }}
 */
function keyInitFromChar(ch) {
  // Common cases — set code field to match the physical key. Detectors
  // that look at event.code expect e.g. 'KeyA' for 'a', 'Digit1' for '1'.
  if (/^[a-zA-Z]$/.test(ch)) return { key: ch, code: 'Key' + ch.toUpperCase() };
  if (/^[0-9]$/.test(ch))    return { key: ch, code: 'Digit' + ch };
  if (ch === ' ')            return { key: ' ', code: 'Space' };
  if (ch === '\n')           return { key: 'Enter', code: 'Enter' };
  if (ch === '\t')           return { key: 'Tab', code: 'Tab' };
  // Punctuation / symbols — code field is harder to map exactly without
  // a full keyboard layout table, so use a reasonable default. Most
  // detectors accept this as long as `key` is correct.
  return { key: ch, code: 'Unidentified' };
}

/**
 * @param {string} ch
 * @returns {boolean} true if the character would produce a keypress event
 *   from a real keyboard (printable ASCII, basically).
 */
function isPrintable(ch) {
  return ch.length === 1 && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127;
}

/**
 * Extracts the AI response text from the DOM.
 *
 * Shape-aware extraction:
 *
 * 1. If fromIndex > 0 AND the selector matches multiple elements (repeating
 *    message list), collect all elements from fromIndex onward and join.
 *    This handles multi-block responses (Breeze: thinking + answer).
 *
 * 2. If the selector matches a single container element (e.g. #panel),
 *    extract the innerText of its last visible child — the most recently
 *    added message. Ignores fromIndex in this case.
 *
 * 3. If fromIndex is 0 or not provided, extract innerText of the last
 *    visible element matching the selector (single-element fallback).
 *
 * @param {string} selector
 * @param {number} [fromIndex=0]
 * @returns {{ success: boolean, extractedValue?: string, error?: string }}
 */
function handleExtract(selector, fromIndex = 0, positional = false) {
  if (!selector || !selector.trim()) {
    return { success: true, extractedValue: document.body?.innerText?.trim() ?? '' };
  }

  try {
    const all     = queryAllDeep(selector);
    const visible = all.filter(el => {
      try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
      catch { return false; }
    });

    // ── DIAGNOSTIC ──────────────────────────────────────────────────────────
    const diagElements = visible.map((el, i) => ({
      i,
      tag      : el.tagName.toLowerCase(),
      testId   : el.getAttribute('data-test-id') ?? el.getAttribute('data-testid') ?? '',
      textSnip : (el.innerText ?? el.textContent ?? '').trim().slice(0, 80),
      textLen  : (el.innerText ?? el.textContent ?? '').trim().length,
      children : el.children.length,
      shadow   : !!el.shadowRoot,
    }));
    console.log(`[AgentHUB EXTRACT] selector="${selector}" fromIndex=${fromIndex} visible=${visible.length} isSingleContainer=${visible.length === 1 && visible[0]?.children.length > 1}`, JSON.stringify(diagElements));
    // ────────────────────────────────────────────────────────────────────────

    if (!visible.length) {
      return { success: false, error: `EXTRACT: no element matched "${selector.slice(0, 120)}"` };
    }

    // POSITIONAL read (OBSERVATION archetype path): return EXACTLY the element at `fromIndex` in document
    // order — bypassing the single-container / longest-block heuristics below, which are for "extract the
    // main content blob" not "read the Nth list item". This is how a value-independent "the first/Nth job"
    // resolves: the archetype selector matches one element per card, fromIndex picks which. Index is clamped
    // so a shrunk list still returns a value rather than failing.
    if (positional) {
      const idx = Math.min(Math.max(fromIndex | 0, 0), visible.length - 1);
      const el  = visible[idx];
      const text = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        ? el.value
        : (el.innerText ?? el.textContent ?? '').trim();
      console.log(`[AgentHUB EXTRACT] path=positional idx=${idx}/${visible.length} result="${String(text).slice(0, 80)}"`);
      if (!text) return { success: false, error: `EXTRACT: positional element ${idx} of "${selector.slice(0, 80)}" has no text` };
      return { success: true, extractedValue: text };
    }

    // Shape detection: single container vs repeating list
    const isSingleContainer = visible.length === 1 && visible[0].children.length > 1;

    if (isSingleContainer) {
      console.log(`[AgentHUB EXTRACT] path=isSingleContainer children=${visible[0].children.length}`);
      const container = visible[0];
      const children  = Array.from(container.children).filter(el => {
        try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
        catch { return false; }
      });
      const nonInput = children.filter(el =>
        el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT' &&
        !el.querySelector('textarea, input[type="text"]')
      );
      const target = nonInput.length > 0 ? nonInput[nonInput.length - 1] : children[children.length - 1];
      if (!target) return { success: false, error: `EXTRACT: container "${selector}" has no extractable children` };
      const text = target.innerText?.trim() ?? target.textContent?.trim() ?? '';
      console.log(`[AgentHUB EXTRACT] isSingleContainer result="${text.slice(0,80)}" len=${text.length}`);
      if (!text) return { success: false, error: `EXTRACT: last child of "${selector}" has no text content` };
      return { success: true, extractedValue: text };
    }

    if (visible.length > 1) {
      const candidates = (fromIndex > 0 && visible.length > fromIndex)
        ? visible.slice(fromIndex)
        : visible;
      console.log(`[AgentHUB EXTRACT] path=longestBlock candidates=${candidates.length}`);

      let bestBlock = null;
      let bestLen   = 0;
      for (const el of candidates) {
        const t = (el.innerText ?? el.textContent ?? '').trim();
        if (t.length > bestLen) { bestLen = t.length; bestBlock = el; }
      }

      if (!bestBlock) return { success: false, error: `EXTRACT: no elements with text content for "${selector}"` };
      const text = (bestBlock.innerText ?? bestBlock.textContent ?? '').trim();
      console.log(`[AgentHUB EXTRACT] longestBlock result="${text.slice(0,80)}" len=${text.length}`);
      if (!text) return { success: false, error: `EXTRACT: best element has no text content` };
      return { success: true, extractedValue: text };
    }

    // Fallback: last matching element
    console.log(`[AgentHUB EXTRACT] path=lastElement visible=${visible.length}`);
    const last = visible[visible.length - 1];
    const text = (last instanceof HTMLInputElement || last instanceof HTMLTextAreaElement)
      ? last.value
      : last.innerText?.trim() ?? last.textContent?.trim() ?? '';
    if (!text) return { success: false, error: `EXTRACT: last element "${selector}" has no text content` };
    return { success: true, extractedValue: text };

  } catch (e) {
    return { success: false, error: `EXTRACT: ${e.message}` };
  }
}

/**
 * Executes a FIND_AI step using the selector Claude identified from the DOM.
 * This is now a thin wrapper around handleClick — the semantic work of
 * identifying the AI entry point is done by Claude in Phase 1, not by a
 * hardcoded scoring heuristic here.
 *
 * Falls back to a minimal alias-based scan only if no selector was provided
 * (e.g. legacy templates generated before v1.6).
 *
 * @param {string}   selector - Claude-provided CSS selector for the entry point.
 * @param {string[]} [aliases=[]] - Alias hints for fallback scan only.
 * @returns {{ success: boolean, extractedValue?: string, error?: string }}
 */
function handleFindAI(selector = '', aliases = []) {
  // Primary path: Claude provided a selector — just click it
  if (selector && selector.trim()) {
    return handleClick(selector);
  }

  // Fallback: no selector provided — minimal alias scan (legacy support only)
  const normAliases = aliases.map(a => a.trim().toLowerCase()).filter(Boolean);
  if (!normAliases.length) {
    return { success: false, error: 'FIND_AI: no selector provided and no aliases for fallback scan' };
  }

  function labelOf(el) {
    return [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-test-id'),
    ].filter(Boolean).join(' ').toLowerCase();
  }

  const candidates = Array.from(document.querySelectorAll(
    'button, [role="button"], [aria-label], [data-testid], [data-test-id]'
  )).filter(el => {
    const l = labelOf(el);
    const r = el.getBoundingClientRect();
    return normAliases.some(a => l.includes(a)) && r.width > 0 && r.height > 0;
  });

  if (!candidates.length) {
    return { success: false, error: `FIND_AI: no element matched aliases [${aliases.join(', ')}]` };
  }

  try {
    const best = candidates[0];
    best.scrollIntoView({ block: 'center', behavior: 'instant' });
    best.focus();
    best.click();
    return { success: true, extractedValue: labelOf(best).slice(0, 80) };
  } catch (e) {
    return { success: false, error: `FIND_AI click failed: ${e.message}` };
  }
}

// ─── WAIT_FOR ─────────────────────────────────────────────────────────────────

/**
 * Polls until the target resolves or timeout. Responds asynchronously.
 *
 * SG-RES-2b (v2.74.645) — a revealed element can be satisfied by EITHER its positional `selector` OR a
 * description `{role, accessibleName}`. A filter popover often renders in a body PORTAL, so the option's
 * captured (subtree-relative) selector never matches; the description match returns the instant the option
 * MOUNTS by identity, so the wait no longer burns its full timeout (which let the dropdown dismiss). The
 * description path runs only when provided, and tries the cheap explicit-role query before any full walk.
 *
 * @param {string}   selector
 * @param {number}   timeoutMs
 * @param {Function} sendResponse
 * @param {{role:string, accessibleName:string}|null} [description]
 */
// BA-1 (v2.74.1003) — ONE synchronous probe, shared by the content-script poll (handleWaitFor) AND the
// service-worker-side poll (the WAIT_FOR_PROBE message, driven by TemplateWalker.#swWaitFor). Identical
// checks — selector via resolveElement, else the portal-friendly role+accessibleName identity — so moving
// the LOOP to the SW is a STRICT SUPERSET of the old content-script loop: same result on a focused tab,
// but the SW timer isn't throttled when the tab is hidden/active:false (§4-B / §5). Returns { matched, via }.
function _waitForProbe(selector, description) {
  const desc = (description && description.role && description.accessibleName) ? description : null;
  try { if (selector && resolveElement(selector)) return { matched: true, via: 'selector' }; }
  catch { /* invalid selector — treat as absent */ }
  // Cheap identity probe: explicit [role] elements whose accessible name contains the authored name.
  // Avoids the full document walk on every tick; the precise match happens in LANDMARK_PROBE_OR_RECOVER.
  if (desc) {
    try {
      const wantLc = String(desc.accessibleName).toLowerCase();
      const nodes = document.querySelectorAll(`[role="${desc.role}"]`);
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (!(r && r.width > 0 && r.height > 0)) continue;     // must be visibly rendered (popover open)
        const n = _computeAccessibleName(el);
        if (n && n.toLowerCase().includes(wantLc)) return { matched: true, via: 'description' };
      }
    } catch { /* invalid role string for a selector — treat as absent */ }
  }
  return { matched: false, via: null };
}

// The human-readable target label for a WAIT_FOR timeout — selector, else role/name (≤100 chars).
function _waitForLabel(selector, description) {
  const desc = (description && description.role && description.accessibleName) ? description : null;
  return (selector || (desc && `${desc.role}/${desc.accessibleName}`) || '').slice(0, 100);
}

function handleWaitFor(selector, timeoutMs, sendResponse, description = null) {
  const start = Date.now();
  function attempt() {
    // v2.74.929 (CR-E3) — a throw inside this setTimeout poll used to kill the loop with sendResponse
    // never called: the caller's open channel hung to ITS timeout. Any throw now answers structurally.
    try {
      const probe   = _waitForProbe(selector, description);
      const elapsed = Date.now() - start;
      if (probe.matched) return sendResponse({ success: true, elapsed, via: probe.via });
      if (elapsed >= timeoutMs) return sendResponse({ success: false, elapsed, error: `WAIT_FOR timeout after ${timeoutMs}ms: "${_waitForLabel(selector, description)}"` });
      setTimeout(attempt, 200);
    } catch (e) {
      try { sendResponse({ success: false, elapsed: Date.now() - start, error: `WAIT_FOR probe threw: ${(e && e.message) || e}` }); } catch { /* channel already gone */ }
    }
  }

  attempt();
}

// ─── BLUR ─────────────────────────────────────────────────────────────────────

/**
 * Blurs the specified element (or document.activeElement if no selector given).
 * Fires blur + focusout events so Angular/React/Vue form models commit the value.
 * @param {string} [selector]
 * @returns {{ success: boolean, error?: string }}
 */
function handleBlur(selector) {
  const el = selector ? resolveElement(selector) : document.activeElement;
  if (!el || el === document.body) {
    // No focused element — dispatch blur on body as a fallback
    document.body.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    return { success: true };
  }
  el.blur();
  el.dispatchEvent(new FocusEvent('blur',     { bubbles: true }));
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  return { success: true };
}

// v2.74.49 — Simulate the Enter key. Used by ENTER actions to submit
// search bars, single-line forms, and any element with a JS keydown
// listener for "Enter". The handler:
//
//   1. Resolves the target — explicit selector when provided, otherwise
//      the currently-focused element (falls back to document.body).
//   2. Focuses the target so the events have a sensible currentTarget.
//   3. Dispatches keydown, keypress, keyup with key='Enter', code='Enter',
//      keyCode=13, which=13 — covers both modern (key) and legacy
//      (keyCode) listeners.
//   4. If nothing called preventDefault on keydown and the target sits
//      inside a <form>, calls form.requestSubmit() — this mirrors the
//      browser's implicit-submit behavior triggered by a real Enter on
//      a single-line input.
function handleEnter(selector) {
  let target = null;
  if (selector && typeof selector === 'string' && selector.trim()) {
    try { target = resolveElement(selector); }
    catch (e) { return { success: false, error: `Invalid selector for ENTER: ${e.message}` }; }
    if (!target) return { success: false, error: `Selector did not match any element: ${selector}` };
  } else {
    target = (document.activeElement && document.activeElement !== document.body)
      ? document.activeElement
      : document.body;
  }
  try { if (typeof target.focus === 'function') target.focus(); } catch { /* fine */ }

  const evtInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };

  let preventedByKeydown = false;
  try {
    const kd = new KeyboardEvent('keydown', evtInit);
    target.dispatchEvent(kd);
    if (kd.defaultPrevented) preventedByKeydown = true;
    target.dispatchEvent(new KeyboardEvent('keypress', evtInit));
    target.dispatchEvent(new KeyboardEvent('keyup',    evtInit));
  } catch (e) {
    return { success: false, error: `ENTER dispatch failed: ${e.message}` };
  }

  // Implicit-submit fallback. Skips when the page already handled
  // Enter via JS (preventDefault on keydown) — replicating browser
  // behavior — or when the target isn't form-associated.
  if (!preventedByKeydown && target.form && typeof target.form.requestSubmit === 'function') {
    try { target.form.requestSubmit(); } catch (e) {
      // Some forms can't be submitted (e.g. no submit button + custom
      // requestSubmit constraints). Silent — the key events already
      // fired and may suffice.
    }
  }
  return { success: true };
}

// v2.74.308 — ACTION_SPEC § 3 / § 6: generalized KEY action. Sends a
// named keyboard key (keydown → keypress → keyup) to the resolved
// element. Focuses the element first (§ 6: "Focus element if not
// focused"). For "Enter" specifically, delegates to handleEnter so the
// implicit-form-submit fallback is preserved. Other keys dispatch the
// raw event sequence — the page's own keydown handlers do the work
// (arrow-key navigation in listboxes, Escape to close popovers, Tab,
// etc.).
//
// keyName is a KeyboardEvent.key value: "Enter", "Escape", "Tab",
// "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Backspace",
// "Delete", "Home", "End", "PageUp", "PageDown", " " (space), or a
// single printable character.
var _KEY_CODE_MAP = Object.freeze({
  'Enter'     : { code: 'Enter',      keyCode: 13 },
  'Escape'    : { code: 'Escape',     keyCode: 27 },
  'Esc'       : { code: 'Escape',     keyCode: 27, key: 'Escape' },
  'Tab'       : { code: 'Tab',        keyCode: 9  },
  'Backspace' : { code: 'Backspace',  keyCode: 8  },
  'Delete'    : { code: 'Delete',     keyCode: 46 },
  'ArrowDown' : { code: 'ArrowDown',  keyCode: 40 },
  'ArrowUp'   : { code: 'ArrowUp',    keyCode: 38 },
  'ArrowLeft' : { code: 'ArrowLeft',  keyCode: 37 },
  'ArrowRight': { code: 'ArrowRight', keyCode: 39 },
  'Home'      : { code: 'Home',       keyCode: 36 },
  'End'       : { code: 'End',        keyCode: 35 },
  'PageUp'    : { code: 'PageUp',     keyCode: 33 },
  'PageDown'  : { code: 'PageDown',   keyCode: 34 },
  ' '         : { code: 'Space',      keyCode: 32 },
  'Spacebar'  : { code: 'Space',      keyCode: 32, key: ' ' },
  'Space'     : { code: 'Space',      keyCode: 32, key: ' ' },
});

function handleKey(selector, keyName, repeat) {
  const rawKey = (keyName ?? '').toString();
  if (!rawKey) return { success: false, error: 'KEY action requires a key name (value)' };

  // v2.74.316 — Repeat count. Clamp to 1–50. Each iteration dispatches a
  // full keydown/keypress/keyup sequence (Enter delegates to handleEnter
  // per-iteration so its implicit-submit fallback fires each time).
  const times = Math.min(50, Math.max(1, parseInt(repeat, 10) || 1));

  // Enter keeps the implicit-submit semantics of handleEnter.
  const mapped = _KEY_CODE_MAP[rawKey];
  const effectiveKey = mapped?.key ?? rawKey;
  if (effectiveKey === 'Enter') {
    for (let i = 0; i < times; i++) {
      const r = handleEnter(selector);
      if (!r.success) return r;
    }
    return { success: true, info: times > 1 ? `Enter ×${times}` : undefined };
  }

  // Resolve target: explicit selector, else active element.
  let target = null;
  if (selector && typeof selector === 'string' && selector.trim()) {
    try { target = resolveElement(selector); }
    catch (e) { return { success: false, error: `Invalid selector for KEY: ${e.message}` }; }
    if (!target) return { success: false, error: `Selector did not match any element: ${selector}` };
  } else {
    target = (document.activeElement && document.activeElement !== document.body)
      ? document.activeElement
      : document.body;
  }
  try { if (typeof target.focus === 'function') target.focus(); } catch { /* fine */ }

  // For a single printable character, key === the char and code is a
  // best-effort (KeyA etc.) — but most consumers only read .key, so we
  // pass the char as key and leave code derived for letters/digits.
  let code = mapped?.code;
  let keyCode = mapped?.keyCode ?? 0;
  if (!code) {
    if (/^[a-zA-Z]$/.test(effectiveKey)) {
      code = `Key${effectiveKey.toUpperCase()}`;
      keyCode = effectiveKey.toUpperCase().charCodeAt(0);
    } else if (/^[0-9]$/.test(effectiveKey)) {
      code = `Digit${effectiveKey}`;
      keyCode = effectiveKey.charCodeAt(0);
    } else {
      code = '';
      keyCode = 0;
    }
  }

  const evtInit = {
    key: effectiveKey,
    code,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
  };
  try {
    for (let i = 0; i < times; i++) {
      target.dispatchEvent(new KeyboardEvent('keydown',  evtInit));
      target.dispatchEvent(new KeyboardEvent('keypress', evtInit));
      target.dispatchEvent(new KeyboardEvent('keyup',    evtInit));
    }
  } catch (e) {
    return { success: false, error: `KEY dispatch failed: ${e.message}` };
  }
  return { success: true, info: times > 1 ? `${effectiveKey} ×${times}` : undefined };
}

// ─── MutationObserver ─────────────────────────────────────────────────────────

/**
 * Installs a MutationObserver that sets window.__agentHubMutated on any change.
 */
function handleObserveStart() {
  // v2.74.929 (CR-E3) — two guards: (a) document.body is null at document_start / in XML docs, making
  // observe(null) a sync TypeError that killed the listener before sendResponse; (b) a run that aborts
  // between START and READ used to leave a whole-body attributes+subtree observer attached for the page's
  // lifetime — a 60s auto-disconnect backstops it (READ/next START clears the timer first in normal flow).
  if (!document.body) return { success: false, error: 'no document.body to observe (pre-parse or non-HTML document)' };
  window.__agentHubMutated = false;
  if (window.__agentHubObserver) window.__agentHubObserver.disconnect();
  if (window.__agentHubObserverTtl) { clearTimeout(window.__agentHubObserverTtl); delete window.__agentHubObserverTtl; }
  window.__agentHubObserver = new MutationObserver(() => {
    window.__agentHubMutated = true;
  });
  window.__agentHubObserver.observe(document.body, {
    childList: true, subtree: true, attributes: true, characterData: false,
  });
  window.__agentHubObserverTtl = setTimeout(() => {
    try { window.__agentHubObserver?.disconnect(); } catch { /* */ }
    delete window.__agentHubObserver;
    delete window.__agentHubObserverTtl;
  }, 60000);
  return { success: true };
}

/**
 * Reads and clears the mutation flag, disconnects the observer.
 * @returns {{ success: boolean, mutated: boolean }}
 */
function handleObserveRead() {
  const mutated = window.__agentHubMutated ?? false;
  window.__agentHubObserver?.disconnect();
  if (window.__agentHubObserverTtl) { clearTimeout(window.__agentHubObserverTtl); delete window.__agentHubObserverTtl; }   // v2.74.929 (CR-E3)
  delete window.__agentHubObserver;
  delete window.__agentHubMutated;
  return { success: true, mutated };
}

// ─── DOM snapshot ─────────────────────────────────────────────────────────────

/**
 * Returns a compact summary of interactive elements for LLM consumption.
 * Pierces shadow DOM boundaries so elements inside Web Components are included.
 * @returns {{ success: boolean, snapshot: string }}
 */
function handleDomSnapshot() {
  const ATTRS = ['id','role','aria-label','aria-expanded','aria-haspopup',
                 'data-testid','data-test-id','data-key','placeholder',
                 'type','name','title'];

  /**
   * Serialises an element to a compact attribute-only summary.
   * Text content is intentionally excluded — aria-label captures visible
   * labels for accessible elements, and text content may contain PII
   * (contact names, emails, phone numbers) from CRM data in the page.
   */
  function summarise(el) {
    const parts = [el.tagName.toLowerCase()];
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) parts.push(`${a}="${v.slice(0, 80)}"`);
    }
    return `<${parts.join(' ')} />`;
  }

  const SEL = [
    'button','input','textarea','select',
    '[role="button"]','[role="textbox"]','[role="combobox"]',
    '[role="menuitem"]','[role="tab"]','[role="dialog"]',
    '[aria-label]','[data-testid]','[data-test-id]','[data-key]',
  ].join(',');

  // queryAllDeep pierces shadow roots — catches panels rendered as Web Components
  const seen    = new Set();
  const visible = queryAllDeep(SEL).filter(el => {
    if (seen.has(el)) return false;
    seen.add(el);
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (_) { return false; }
  });

  return { success: true, snapshot: visible.slice(0, 200).map(summarise).join('\n') };
}

/**
 * Returns a richer DOM snapshot for anchor discovery — includes non-interactive
 * elements (divs, sections, articles, paragraphs) so Claude can identify
 * response containers and generation indicators that carry no interactive role.
 * Text content is still excluded for PII safety; structure and attributes only.
 * @returns {{ success: boolean, snapshot: string }}
 */
function handleDomSnapshotFull() {
  const ATTRS = ['id','class','role','aria-label','aria-live','aria-busy',
                 'aria-expanded','aria-disabled','aria-hidden',
                 'data-testid','data-test-id','data-key',
                 'placeholder','type','name','title'];

  function summarise(el) {
    const parts = [el.tagName.toLowerCase()];
    for (const a of ATTRS) {
      let v = el.getAttribute(a);
      if (!v) continue;
      // Truncate long class strings — keep first 2 class tokens only
      if (a === 'class') v = v.split(/\s+/).slice(0, 3).join(' ');
      parts.push(`${a}="${v.slice(0, 60)}"`);
    }
    // Include child count as structural hint — helps Claude identify containers
    const childCount = el.children.length;
    if (childCount > 0) parts.push(`children="${childCount}"`);
    return `<${parts.join(' ')} />`;
  }

  // Two-pass collection: indicators first, then structural elements
  // This ensures generation indicators (deep in the DOM) aren't truncated
  // by the slice cap when there are many prior message elements.

  const INDICATOR_SEL = [
    '[data-test-id*="stop"]','[data-test-id*="loading"]','[data-test-id*="spinner"]',
    '[data-test-id*="generating"]','[data-test-id*="reasoning"]','[data-test-id*="thinking"]',
    '[data-test-id*="animation"]','[data-test-id*="busy"]',
    '[aria-busy="true"]','[aria-live]',
    'button[data-test-id*="send"]','button[data-test-id*="stop"]',
  ].join(',');

  const STRUCTURAL_SEL = [
    'button','input','textarea','select',
    '[role]','[aria-label]',
    '[data-testid]','[data-test-id]',
    'div[id]','section[id]','article','main','aside',
    'div[class]','p[class]','span[class]',
  ].join(',');

  const seen = new Set();
  const isVisible = (el) => {
    try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    catch { return false; }
  };

  // Pass 1: priority elements (generation indicators) — always included
  const priority = queryAllDeep(INDICATOR_SEL).filter(el => {
    if (seen.has(el)) return false;
    seen.add(el);
    return isVisible(el);
  });

  // Pass 2: remaining structural elements up to cap
  const structural = queryAllDeep(STRUCTURAL_SEL).filter(el => {
    if (seen.has(el)) return false;
    seen.add(el);
    return isVisible(el);
  });

  const combined = [...priority, ...structural].slice(0, 500);
  return { success: true, snapshot: combined.map(summarise).join('\n') };
}

/**
 * Post-send DOM snapshot for EXTRACT step generation.
 * Augments the standard snapshot with three additional attributes on each element:
 *
 *   new="true"          — element was NOT present at baseline (appeared after send)
 *   text-preview="..."  — first 80 chars of innerText (AI output, not PII)
 *   text-length="N"     — total innerText length
 *   shadow="true"       — element has a shadow root (innerText may be empty)
 *
 * Only elements with non-empty innerText get text-preview — feedback buttons,
 * icons, and empty containers are omitted from the preview.
 *
 * @param {string[]} baselineSelectors - Array of element outerHTML signatures
 *   captured before the question was sent. Used to identify new elements.
 * @returns {{ success: boolean, snapshot: string }}
 */
function handleDomSnapshotPostSend(baselineSelectors = [], typedQuestion = '') {
  const baselineSet  = new Set(baselineSelectors);
  const questionNorm = typedQuestion.trim().toLowerCase().slice(0, 100);

  const ATTRS = ['id','role','aria-label','aria-live','aria-busy',
                 'aria-expanded','aria-disabled',
                 'data-testid','data-test-id','data-key',
                 'placeholder','type','name','title'];

  function sig(el) {
    // Stable signature for baseline comparison — tag + key attributes
    const parts = [el.tagName];
    for (const a of ['data-test-id','data-testid','id','role','aria-label']) {
      const v = el.getAttribute(a);
      if (v) { parts.push(`${a}=${v}`); break; }
    }
    return parts.join('|');
  }

  function summarise(el, isNew) {
    const parts = [el.tagName.toLowerCase()];
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) parts.push(`${a}="${v.slice(0, 60)}"`);
    }
    const childCount = el.children.length;
    if (childCount > 0) parts.push(`children="${childCount}"`);
    if (el.shadowRoot) parts.push(`shadow="true"`);
    if (isNew) parts.push(`new="true"`);

    // Include text preview for new elements with content
    if (isNew) {
      const text = el.innerText?.trim() ?? el.textContent?.trim() ?? '';
      if (text.length > 0) {
        parts.push(`text-length="${text.length}"`);
        const preview = text.slice(0, 80).replace(/"/g, "'").replace(/\n/g, ' ');
        parts.push(`text-preview="${preview}"`);
        // Mark elements that contain the user's typed question — skip these for EXTRACT
        if (questionNorm && text.toLowerCase().includes(questionNorm)) {
          parts.push(`user-message="true"`);
        }
      }
    }

    return `<${parts.join(' ')} />`;
  }

  const SEL = [
    'button','input','textarea','select',
    '[role]','[aria-label]','[aria-live]',
    '[data-testid]','[data-test-id]',
    'div[id]','div[class]','section','article','main','p[class]',
  ].join(',');

  const seen    = new Set();
  const visible = queryAllDeep(SEL).filter(el => {
    if (seen.has(el)) return false;
    seen.add(el);
    try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    catch { return false; }
  });

  const lines = visible.slice(0, 400).map(el => summarise(el, !baselineSet.has(sig(el))));
  return { success: true, snapshot: lines.join('\n') };
}

/**
 * Rich DOM snapshot for Phase 2 turns — gives Claude text content, interactability
 * state, and change delta so it can determine extract strategy autonomously.
 *
 * Enrichments over DOM_SNAPSHOT:
 *   text="..."        — up to 120 chars of innerText for elements with data-testid or role
 *                       (product UI elements, not user data fields)
 *   disabled="true"   — element is disabled or aria-disabled
 *   new="true"        — element was not in prevSigs (appeared this turn)
 *   changed="true"    — element's text changed since prevSigs
 *
 * @param {string[]} prevSigs  — signatures from previous turn for delta detection
 * @returns {{ success: boolean, snapshot: string, sigs: string[] }}
 */
// v2.74.395 — Repeating content-block detector. The DOM_SNAPSHOT_RICH walker
// (SEL) is CONTROL-centric: cards/tiles/rows/sections that carry no role /
// aria-label / data-testid are invisible to it, and full class attributes are
// stripped elsewhere as "hashed noise". But those repeating content blocks are
// exactly what "many"-multiplicity CONTENT roles (collection-card, result-item,
// gallery-tile) need to resolve — and on CSS-module / styled-component sites
// (e.g. Pixabay's `div.layout--JZpqG…`) the element's own class signature is the
// ONLY stable handle it has. This finds elements whose tag+class signature
// recurs ≥3× and emits the SHARED class signature as a ready-to-use, querySelector
// -verified selector + a content sample. Opt-in (resolve only) so the agent
// walker's per-turn snapshots aren't bloated.
function detectRepeatingContentBlocks() {
  let nodes;
  try { nodes = document.body ? document.body.getElementsByTagName('*') : []; }
  catch { return []; }
  const groups = new Map();              // sigKey -> { tag, classes, els:[] }
  const MAX_SCAN = 6000;                 // bound cost on huge pages
  const n = Math.min(nodes.length, MAX_SCAN);
  for (let i = 0; i < n; i++) {
    const el = nodes[i];
    const raw = (typeof el.className === 'string') ? el.className : ((el.getAttribute && el.getAttribute('class')) || '');
    if (!raw) continue;
    const classes = raw.trim().split(/\s+/).filter(Boolean);
    if (classes.length === 0) continue;
    const sigKey = el.tagName + '|' + classes.slice().sort().join('.');
    let g = groups.get(sigKey);
    if (!g) { g = { tag: el.tagName, classes, els: [] }; groups.set(sigKey, g); }
    g.els.push(el);
  }
  const cssEscape = (c) => {
    try { return (window.CSS && CSS.escape) ? CSS.escape(c) : c.replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
    catch { return c; }
  };
  const blocks = [];
  let groupsChecked = 0;
  for (const g of groups.values()) {
    if (g.els.length < 3) continue;                 // must repeat
    if (++groupsChecked > 400) break;               // hard cap on expensive checks
    // Content-like filter: a fair share carry text or an image, and the element
    // is block-sized (not an inline chip/icon that merely repeats).
    let contentful = 0, withImg = 0, sized = 0;
    const sample = g.els.slice(0, 12);
    for (const el of sample) {
      try {
        const r = el.getBoundingClientRect();
        if (r.width >= 60 && r.height >= 40) sized++;
        const txt = (el.innerText || el.textContent || '').trim();
        if (txt.length >= 2) contentful++;
        if (el.querySelector && el.querySelector('img,svg,picture,video,[style*="background-image"]')) withImg++;
      } catch { /* */ }
    }
    if (sized < 2) continue;                          // skip inline/tiny repeats
    if (contentful < 2 && withImg < 2) continue;      // skip empty repeats
    const sel = g.tag.toLowerCase() + g.classes.map(c => '.' + cssEscape(c)).join('');
    let matchCount = 0;
    try { matchCount = document.querySelectorAll(sel).length; } catch { matchCount = 0; }
    if (matchCount < 3) continue;                     // selector must actually repeat
    // v2.74.430 — Reject HIGH-COUNT repeats that carry NO content/semantic class
    // token. innerText on a layout wrapper bubbles up its children's text, so the
    // contentful check above can't tell a real card from a generic flex/grid
    // wrapper. A design-system utility class (e.g. Expedia `uitk-layout-flex-item`
    // ×170, `uitk-layout-position-relative` ×73) recurs far past any real content
    // grid but carries only layout classes; a real collection either has a content
    // token (card/tile/photo/…) or stays under the ceiling. Count-gated so an
    // all-layout-class but genuine grid (e.g. Pixabay's photo grid ×30) survives.
    const sigStr = g.classes.join(' ').toLowerCase();
    const hasContentToken = /card|tile|product|listing|result|article|thumbnail|teaser|gallery|photo|image|media|review|story|\bpost\b|hit|\bentry\b/.test(sigStr);
    if (!hasContentToken && matchCount > 60) continue;
    let sampleText = '';
    try { sampleText = (g.els[0].innerText || g.els[0].textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60); } catch { /* */ }
    blocks.push({ tag: g.tag.toLowerCase(), selector: sel, count: matchCount, hasImage: withImg >= 2, sampleText });
  }
  blocks.sort((a, b) => b.count - a.count);
  return blocks.slice(0, 12);
}

// v2.74.397 — L0 page enumeration (read-only). Builds the raw Feature list for a
// Locale (PAGEMODEL_SPEC § 8, tier L0): scroll the page in viewport bands and
// enumerate every interactive control, content collection, and region — each with
// a selector, absolute location (+ scrollToY), kind, and interaction — WITHOUT any
// clicking. Self-contained: unlike the poke sweep, enumeration is read-only, so it
// can scroll the whole page in one call and restore, with no background banding/
// navigation-recovery orchestration. Returns { success, features, meta }.
// PB-10 (DESIGN_phaseB_pipeline §5) — deterministic form-field oracle. Reads the page's OWN necessity
// markers (required / aria-required / .Mui-required label / trailing asterisk) so the proposal can be
// told exactly which fields a completion intent ("apply for this job") must cover. Mirrors
// Core/formCoverage.enumerateFormFields — kept here inlined because classic content scripts can't
// ES-import Core. Runs in the top frame (the message is sent with frameId:0). No visibility filter:
// required controls are often visually hidden (e.g. a framework's native <select required> at opacity:0)
// yet still mandatory, so dropping hidden elements would under-count.
// SG-0.5 — shared form-control descriptor logic, hoisted to module scope so BOTH the oracle
// (enumerateFormFields) AND the Locale enumerator (enumeratePage) emit completion-grade data: real
// label[for], required-ness, clean #id/[name] selector. No visibility filter — required controls are
// often visually hidden (a framework's native <select required> at opacity:0) yet still mandatory.
// v2.74.563 — includes ALL `button`s (not just [type=submit]): a bare <button> inside a <form> is a
// default-submit per HTML, and BambooHR-style forms use one. _describeFormControl returns null for
// non-submit buttons, so nav/toggle buttons stay with the band scan — only the real submit is kept.
var FORM_CONTROL_SEL = 'input:not([type=hidden]):not([type=button]):not([type=reset]), select, textarea, button';
function _ffStrip(s) { return String(s || '').replace(/\s*\*\s*$/, '').replace(/\s{2,}/g, ' ').trim(); }
// Concrete selector for the REAL control (not a wrapper). Preference order, most→least durable:
//   1. [name="…"] — the FORM-CANONICAL identifier. It's author-controlled and submitted to the server,
//      so component libraries (Fluent/Fabric, MUI, …) preserve it across renders while regenerating the
//      element's #id every mount. Used when it resolves uniquely (bare, then tag-qualified). This makes
//      capture robust to ANY framework's volatile-id scheme without enumerating prefixes — a named field
//      binds by name regardless. (Radio groups share a name → non-unique → fall through to #id.)
//   2. a STABLE author #id (isStableIdent rejects framework render-time ids like FabricTextField-324 /
//      fab-select356), for nameless controls that carry a real author id.
//   3. a stable accessible attribute — aria-label / placeholder — set even when the id is volatile.
//   4. last resort: name (non-unique, e.g. radios), then the escaped #id — a fragile selector beats none.
// v2.74.588 — takes the element (was id+name) so it can reach aria-label/placeholder.
// v2.74.589 — name-FIRST (was id-first): generalizes past per-framework volatile-id whack-a-mole.
function _ffSelector(el) {
  try {
    const id = (el.id || '').trim();
    const name = ((el.getAttribute && el.getAttribute('name')) || '').trim();
    const tag = (el.tagName || '').toLowerCase();
    const q = /^[a-z][a-z0-9]*$/.test(tag) ? tag : '';
    const esc = (v) => String(v).replace(/(["\\])/g, '\\$1');
    const uniq = (sel) => { try { return queryAllDeep(sel).length === 1; } catch { return false; } };
    if (name) {
      const bare = `[name="${esc(name)}"]`;
      if (uniq(bare)) return bare;
      const tq = `${q}[name="${esc(name)}"]`;
      if (q && uniq(tq)) return tq;
    }
    if (id && isStableIdent(id) && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.trim()) { const sel = `${q}[aria-label="${esc(aria.trim())}"]`; if (uniq(sel)) return sel; }
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph && ph.trim()) { const sel = `${q}[placeholder="${esc(ph.trim())}"]`; if (uniq(sel)) return sel; }
    if (name) return `[name="${esc(name)}"]`;
    if (id) return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `#${id.replace(/([^\w-])/g, '\\$1')}`;
  } catch { /* */ }
  return null;
}
function _ffLabelInfo(el) {
  try {
    const id = el.id;
    if (id) { const sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id; const f = document.querySelector(`label[for="${sel}"]`); if (f) return { text: f.textContent || '', el: f }; }
    const c = el.closest && el.closest('label'); if (c) return { text: c.textContent || '', el: c };
    const al = el.getAttribute('aria-label'); if (al) return { text: al, el: null };
    const lb = el.getAttribute('aria-labelledby'); if (lb) { const r = document.getElementById(lb); if (r) return { text: r.textContent || '', el: r }; }
  } catch { /* */ }
  return { text: '', el: null };
}
function _ffRequired(el, li) {
  try {
    if (el.required === true) return true;
    if (el.getAttribute('aria-required') === 'true') return true;
    if (el.hasAttribute('required')) return true;
    const lbl = li && li.el;
    if (lbl) {
      if (/required/i.test(String(lbl.className || ''))) return true;          // .Mui-required / .required
      if (/\*\s*$/.test((lbl.textContent || '').trim())) return true;          // trailing asterisk
      if (lbl.querySelector && lbl.querySelector('[class*="asterisk"],[class*="required"]')) return true;
    }
  } catch { /* */ }
  return false;
}
/** Per-control descriptor: { tag, type, name, id, label, required, isSubmit, kind, selector } | null. */
function _describeFormControl(el) {
  try {
    const tag = (el.tagName || '').toLowerCase();
    const rawType = el.getAttribute('type') || '';
    const type = (rawType || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text')).toLowerCase();
    const isButton = tag === 'button';
    const btnType = isButton ? (el.getAttribute('type') || '') : '';
    const inForm = !!(el.closest && el.closest('form'));
    // A button that PARTICIPATES in the form: an explicit submit/reset, an image
    // submit, or a bare <button> (no type → HTML default-submit) inside a <form>.
    // A type=button is inert (nav/toggle/"View Job Description") → leave it to the
    // band scan so we don't pollute the form features.
    // v2.74.605 — a CLASSIC `<input type="submit">` (Shopify/Rails-style) is a form button, not a
    // fillable. Without this it fell through to kind:'input' and the trial TYPE'd a trial value into it —
    // and typing into an input[type=submit] overwrites its `value`, i.e. its visible label ("Post comment"
    // → "test"). It also meant the REAL submit was never detected/deferred. type=image already handled.
    const isFormButton = (tag === 'input' && (type === 'submit' || type === 'image'))
      || (isButton && (btnType === 'submit' || btnType === 'reset' || (!btnType && inForm)));
    if (isButton && !isFormButton) return null;
    const li = _ffLabelInfo(el);
    // v2.74.565 — a button's label is its OWN text (button content / input value /
    // image alt), not a <label for>. Without this it comes through blank, so the
    // submit can't be told from the cancel and Bind can't pick the right one.
    let labelText = li.text;
    if (!_ffStrip(labelText)) {
      if (isButton) labelText = el.textContent || '';
      else if (tag === 'input' && type === 'image') labelText = el.getAttribute('alt') || el.getAttribute('value') || '';
      else if (tag === 'input' && type === 'submit') labelText = el.getAttribute('value') || '';
    }
    const labelStr = _ffStrip(labelText);
    // SG-2/PROVISIONAL (DESIGN_substrate_grounded_capabilities §4.6) — "which form
    // button is the SUBMIT vs. an abandon (reset/cancel/clear/back)" is a SEMANTIC
    // verdict; the authority is Select (LLM), which picks the goal's success action
    // from the captured {type,label,effect} facts in any language. This lexical
    // denylist is the no-LLM DEFAULT only — it keeps a cancel (even a type=submit one)
    // from defaulting to the success action. Capture stays honest; do NOT extend
    // per-site. Select subsumes this.
    const negative = btnType === 'reset' || /^(cancel|reset|clear|close|back|dismiss|skip|previous|prev|discard)\b/i.test(labelStr);
    const isSubmit = isFormButton && !negative;
    return {
      tag, type,
      name: el.getAttribute('name') || '',
      id: el.id || '',
      label: labelStr,
      required: isFormButton ? false : _ffRequired(el, li),
      isSubmit,
      isAction: isFormButton,                  // any form button → a feature of kind 'action'
      kind: isFormButton ? (isSubmit ? 'submit' : 'button') : (type === 'file' ? 'file' : tag === 'select' ? 'select' : 'input'),
      selector: _ffSelector(el),
    };
  } catch { return null; }
}

// PB-10 — deterministic form-field oracle (ENUMERATE_FORM_FIELDS). Same descriptors the Locale build uses.
function enumerateFormFields() {
  let nodes = [];
  try { nodes = queryAllDeep(FORM_CONTROL_SEL); } catch { return []; }   // v2.74.563 — pierce shadow DOM (upload widgets)
  const out = [];
  for (const el of nodes) { const d = _describeFormControl(el); if (d) out.push(d); }
  return out;
}

async function enumeratePage() {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const vw = window.innerWidth, vh = window.innerHeight;
  const origScrollY = window.scrollY || 0;
  const docH = (() => { try { return Math.max(document.documentElement.scrollHeight, (document.body && document.body.scrollHeight) || 0, vh); } catch { return vh; } })();
  const bandStep = Math.max(1, Math.round(vh * 0.9));
  const bandCount = Math.min(24, Math.max(1, Math.ceil(docH / bandStep)));
  const FEATURE_CAP = 500;

  const djb2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  const vis = (el) => { try { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; } catch { return false; } };
  const accName = (el) => {
    try {
      const al = el.getAttribute('aria-label'); if (al && al.trim()) return al.trim();
      const lb = el.getAttribute('aria-labelledby'); if (lb) { const t = lb.split(/\s+/).map(id => document.getElementById(id) && document.getElementById(id).textContent ? document.getElementById(id).textContent.trim() : '').filter(Boolean).join(' '); if (t) return t; }
      const ph = el.getAttribute('placeholder'); if (ph && ph.trim()) return ph.trim();
      const ti = el.getAttribute('title'); if (ti && ti.trim()) return ti.trim();
      const alt = el.getAttribute('alt'); if (alt && alt.trim()) return alt.trim();
      const tx = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '); if (tx) return tx;
      const v = el.value; if (typeof v === 'string' && v.trim()) return v.trim();
    } catch { /* */ }
    return '';
  };
  const absRect = (el) => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return { x: 0, y: 0, w: 0, h: 0 }; } };
  // v2.74.838 (Win 3) — hierarchical context (ancestorRole + ancestorName) per feature so a DRIFTED selector can be
  // recovered by ancestor disambiguation (_findLandmarkCandidatesByDescription distinguishes two same-named controls
  // by their landmark ancestor). featureToProtoLandmark (Core/landmark.js:53) reads feature.hierarchicalContext — it
  // was always null on the auto-build path, leaving that recovery branch dead. siblingPosition skipped (unused by
  // recovery; avoids an O(descendants) scan ×N features). null is harmless (same as before).
  const hctxOf = (el) => { try { return _computeHierarchicalContext(el, { siblingPosition: false }); } catch { return null; } };
  const tierOf = (sel) => {
    if (!sel) return 'positional';
    if (/(^|\s|>)#[A-Za-z]/.test(sel)) return 'id';
    if (/\[data-/.test(sel)) return 'data';
    if (/\[aria-|\[role=/.test(sel)) return 'aria';
    if (/:nth-|:first-|:last-|>\s|\+\s|~\s/.test(sel)) return 'positional';
    if (/\./.test(sel)) return 'class';
    return 'semantic';
  };
  const INTERACTIVE_SEL = 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="textbox"],[role="combobox"],[role="searchbox"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],summary,[contenteditable="true"]';
  const REGION_SEL = 'header,nav,main,footer,aside,[role="banner"],[role="navigation"],[role="main"],[role="contentinfo"],[role="search"],[role="complementary"]';

  const classifyKind = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (tag === 'input') { const t = (el.getAttribute('type') || 'text').toLowerCase(); if (['button', 'submit', 'reset', 'image', 'checkbox', 'radio'].includes(t)) return 'action'; return 'input'; }
    if (tag === 'textarea' || tag === 'select' || el.isContentEditable || role === 'textbox' || role === 'combobox' || role === 'searchbox') return 'input';
    // v2.74.401 — disclosure detection beyond ARIA: many sites (e.g. Pixabay's
    // "Explore" / "All images") build dropdowns as class-based menus with no
    // aria-haspopup/expanded. Catch dropdown/flyout/triggerWrapper containers too.
    const cls = el.getAttribute('class') || '';
    if (el.getAttribute('aria-haspopup') || el.hasAttribute('aria-expanded') || tag === 'summary'
        || /(dropdown|flyout|menutrigger|hasmenu)/i.test(cls)
        || (tag !== 'a' && el.closest && el.closest('[class*="dropdown" i],[class*="flyout" i],[class*="triggerWrapper" i]'))) return 'disclosure';
    if (tag === 'a' && el.getAttribute('href')) return 'navigation';
    return 'action';
  };
  const interactionOf = (kind, el) => {
    if (kind === 'input') { const isSel = el.tagName.toLowerCase() === 'select'; return { pattern: isSel ? 'select' : 'type', effect: isSel ? 'select' : 'none' }; }
    if (kind === 'navigation') return { pattern: 'click', effect: 'navigate' };
    if (kind === 'disclosure') return { pattern: 'click', effect: 'reveal' };
    const t = (el.getAttribute('type') || '').toLowerCase();
    const nm = accName(el).toLowerCase();
    return { pattern: 'click', effect: (t === 'submit' || /search|submit|go|apply|sign in|log in|find/.test(nm)) ? 'submit' : 'none' };
  };

  const feats = new Map();
  const add = (f) => { if (f && f.id && !feats.has(f.id) && feats.size < FEATURE_CAP) feats.set(f.id, f); };

  // ── 1. Content collections FIRST (read at the top), so per-item controls can
  // be SUPPRESSED below. v2.74.401 — validated: a 20-card image grid otherwise
  // emits 100+ brittle positional features for its per-card edit/creator/like
  // controls. The card IS the feature; its inner controls are a template.
  try { window.scrollTo(0, 0); } catch { /* */ }
  await sleep(80);
  let blocks = [];
  try { blocks = detectRepeatingContentBlocks(); } catch { blocks = []; }
  const blockInfo = blocks.map((b) => {
    let els = [];
    try { els = Array.from(document.querySelectorAll(b.selector)); } catch { els = []; }
    const areas = els.map((e) => { try { const r = e.getBoundingClientRect(); return r.width * r.height; } catch { return 0; } }).filter((a) => a > 0).sort((x, y) => x - y);
    const medArea = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
    return { ...b, els, medArea };
  });
  // Content cards = repeating items that each contain a CLUSTER of controls
  // (≥3 interactive descendants: edit + creator + like + link…). Their inner
  // controls are suppressed (the card is the feature). A nav tile / thumbnail
  // has ~1 link (<3), so its link SURVIVES as an individual navigation feature —
  // size/has-image alone would wrongly hide media-type & collection nav links.
  const countInteractive = (el) => { try { return el.querySelectorAll(INTERACTIVE_SEL).length; } catch { return 0; } };
  const suppressSet = new Set();
  for (const b of blockInfo) {
    const counts = b.els.slice(0, 6).map(countInteractive).sort((x, y) => x - y);
    b.medInteractive = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    if (b.medInteractive >= 3) for (const e of b.els) suppressSet.add(e);
  }
  const insideSuppressed = (el) => { let n = el, d = 0; while (n && d < 14) { if (suppressSet.has(n)) return true; n = n.parentElement; d++; } return false; };
  // Collapse NESTED collections for emission: keep the outermost (largest-area)
  // card, drop the rest of the same grid. v2.74.402 — sampled BI-DIRECTIONAL
  // containment over up to 8 items (≥50% overlap) handles non-1:1 nesting (12
  // cells vs 10 inner contentContainers vs 25 overlay images) that a first-element
  // check missed.
  const keptBlocks = [];
  for (const b of [...blockInfo].sort((a, c) => c.medArea - a.medArea)) {
    const sample = b.els.slice(0, 8);
    const overlapsKept = keptBlocks.some((k) => {
      let hit = 0;
      for (const be of sample) {
        if (k.els.some((ke) => ke === be || (ke.contains && ke.contains(be)) || (be.contains && be.contains(ke)))) hit++;
      }
      return sample.length && hit / sample.length >= 0.5;
    });
    if (!overlapsKept) keptBlocks.push(b);
  }
  for (const blk of keptBlocks) {
    if (feats.size >= FEATURE_CAP) break;
    let absY = 0;
    try { if (blk.els[0]) absY = Math.round(blk.els[0].getBoundingClientRect().top + window.scrollY); } catch { /* */ }
    const label = (blk.sampleText || `${blk.count} items`).slice(0, 80);
    const id = djb2(`collection|list|${label}|${blk.selector}`);
    add({
      id, kind: 'collection', label, a11yRole: 'list',
      selector: blk.selector, selectorKind: 'class', selectorVerified: true,
      members: { itemSelector: blk.selector, count: blk.count, sampleLabels: blk.sampleText ? [blk.sampleText] : [], medInteractive: blk.medInteractive ?? null },   // EX-3 — median per-item interactive count (already computed; was dropped)
      location: { band: Math.floor(absY / bandStep), absRect: { x: 0, y: absY, w: vw, h: 0 }, visibleAtRest: absY >= origScrollY && absY < origScrollY + vh, scrollToY: Math.max(0, absY - Math.round(vh * 0.3)) },
      interaction: { pattern: 'none', effect: 'none' },
      confidence: 0.7,
      evidence: { method: 'enumeration', observedAt: Date.now() },
    });
  }

  // ── 1.5 Form controls (SG-0.5): completion-grade features — real label[for], `required`, and a clean
  // #id/[name] selector — INCLUDING functional-but-hidden controls (a custom widget's opacity:0 native
  // <select>, the file input) the visibility-gated band scan below would drop. Captured once here (no
  // viewport gate); their elements are recorded so the band scan SKIPS them — no duplicate,
  // weaker-selector feature for the same control.
  const formEls = new Set();
  try {
    // v2.74.563 — queryAllDeep pierces shadow roots: framework upload widgets (and
    // other Fabric/web-component controls) hide the real <input type=file> inside a
    // shadow tree that plain querySelectorAll can't see — that's why the resume
    // field went missing. Deep query catches it.
    for (const el of queryAllDeep(FORM_CONTROL_SEL)) {
      if (feats.size >= FEATURE_CAP) break;
      const d = _describeFormControl(el);
      if (!d) continue;
      // Prefer the oracle's clean #id/[name]; fall back to synthesis for controls
      // with neither (submit buttons frequently have no id or name).
      let fsel = d.selector;
      if (!fsel) { try { fsel = synthesizeSelector(el, document); } catch { /* */ } }
      if (!fsel) { try { fsel = _synthesizeSelectorForElement(el); } catch { /* */ } }
      if (!fsel) continue;                              // no bindable selector at all
      // v2.74.576 — TAG-QUALIFY a bare attribute selector so it targets the actual CONTROL, not a
      // same-attr wrapper: a file widget's real <input aria-label="file-input"> vs a styled
      // <div aria-label="file-input"> shell both match `[aria-label="file-input"]`, and querySelector
      // returns the div. `input[aria-label="file-input"]` resolves to the input. Only adopt the tagged
      // form when it uniquely resolves to THIS element (a no-op for shadow-DOM controls, which need
      // shadow-aware resolution — flagged separately).
      if (fsel[0] === '[') {
        try { const tagged = (el.tagName || '').toLowerCase() + fsel; if (document.querySelector(tagged) === el) fsel = tagged; } catch { /* */ } }
      d.selector = fsel;
      formEls.add(el);
      const fkind = d.isAction ? 'action' : 'input';
      const ar = absRect(el);
      // v2.74.562 — Capture is INTENT-BLIND: every control is emitted regardless of
      // `required` (a future intent may target an optional field — "fill in my
      // nickname"). `required` is a downstream annotation Cover uses ONLY for a
      // completion intent; it is NOT a capture filter. Decoy/honeypot avoidance is a
      // SEPARATE, honest signal — a control positioned off-canvas (the classic
      // left:-9999px spam trap) or labelled "leave blank" — so a completion intent
      // skips it AND a targeted intent that names it can be WARNED, without ever
      // dropping it from the substrate. The decision stays with the query, not capture.
      const offscreen = ar.x <= -1500 || ar.y <= -1500;   // structural FACT (e.g. left:-9999px) — always emitted
      // SG-2/PROVISIONAL (DESIGN §4.6) — "is this field a spam-trap the user must not
      // fill" is a SEMANTIC verdict; Select (LLM) decides it from the `offscreen` +
      // label facts. This regex is the no-LLM DEFAULT only; do NOT extend per-site.
      const decoy = offscreen || /leave\s+(this|the)?\s*\w*\s*blank|do\s*not\s+(fill|complete)|don'?t\s+fill|honeypot/i.test(d.label || '');
      const interaction = d.isSubmit ? { pattern: 'click', effect: 'submit' }
        : d.isAction         ? { pattern: 'click', effect: 'none' }   // cancel/reset/other form button — NOT the success action
        : d.kind === 'select' ? { pattern: 'select', effect: 'select' }
        : d.kind === 'file'   ? { pattern: 'upload', effect: 'none' }
        :                       { pattern: 'type',   effect: 'none' };
      add({
        id: djb2(`${fkind}|${d.label}|${d.selector}`),
        kind: fkind,
        label: (d.label || d.name || d.id || '').slice(0, 80),
        a11yRole: el.getAttribute('role') || null,
        hierarchicalContext: hctxOf(el),   // v2.74.838 — ancestor disambiguator for selector recovery
        selector: d.selector, selectorKind: tierOf(d.selector),
        // Verified only if a simple #id that ACTUALLY resolves from document — a
        // shadow-DOM control's #id matches the regex but won't resolve top-level,
        // so this stays honest (false) and flags that it needs shadow-aware binding.
        selectorVerified: /^#[A-Za-z][\w-]*$/.test(d.selector) && (() => { try { return document.querySelector(d.selector) === el; } catch { return false; } })(),
        required: d.required,        // SG-0.5 — the necessity marker Select/Cover need (annotation, not a filter)
        fieldType: d.type,           // input type → drives the value-op at Bind (TYPE / SELECT / SET_VALUE / upload)
        ...(offscreen ? { offscreen: true } : {}),   // factual: positioned off the human canvas
        ...(decoy ? { decoy: true } : {}),           // inferred spam-trap → don't fill unless the intent names it (then warn)
        location: { band: Math.floor((ar.y || 0) / bandStep), absRect: ar, visibleAtRest: (ar.y + ar.h) > origScrollY && ar.y < origScrollY + vh, scrollToY: Math.max(0, ar.y - Math.round(vh * 0.3)) },
        interaction,
        confidence: 0.85,
        evidence: { method: 'form-enum', observedAt: Date.now() },
      });
    }
  } catch { /* */ }

  // ── 2. Interactive controls, band by band (whole page) — skipping anything
  // inside a content card (the collection represents it).
  for (let b = 0; b < bandCount && feats.size < FEATURE_CAP; b++) {
    try { window.scrollTo(0, b * bandStep); } catch { /* */ }
    await sleep(110);   // settle lazy content / scroll-reactive chrome
    let els;
    try { els = document.querySelectorAll(INTERACTIVE_SEL); } catch { els = []; }
    for (const el of els) {
      if (feats.size >= FEATURE_CAP) break;
      if (formEls.has(el)) continue;        // SG-0.5 — already captured as a completion-grade form feature
      if (!vis(el)) continue;
      if (suppressSet.has(el) || insideSuppressed(el)) continue;   // inside a content card → template, not a landmark
      const r = el.getBoundingClientRect();
      if (r.bottom < -40 || r.top > vh + 40) continue;   // band-local only
      let selector = null;
      try { selector = synthesizeSelector(el, document); } catch { /* */ }
      if (!selector) { try { selector = _synthesizeSelectorForElement(el); } catch { /* */ } }
      if (!selector) continue;
      const kind = classifyKind(el);
      const label = accName(el).slice(0, 80);
      const ar = absRect(el);
      // v2.74.431 — capture the absolute destination href on navigation features so
      // the Ground siteMap (GROUND_SPEC § 7) can build edges. The element itself, or
      // an anchor it wraps / is wrapped by (cards often wrap a single link).
      let href = null;
      if (kind === 'navigation') {
        try {
          const a = (el.tagName === 'A' && el.getAttribute('href')) ? el
            : (el.querySelector && el.querySelector('a[href]')) || (el.closest && el.closest('a[href]'));
          if (a && a.href && /^https?:/i.test(a.href)) href = a.href;
        } catch { /* */ }
      }
      const id = djb2(`${kind}|${el.getAttribute('role') || el.tagName.toLowerCase()}|${label}|${selector}`);
      add({
        id, kind, label, a11yRole: el.getAttribute('role') || null,
        selector, selectorKind: tierOf(selector), selectorVerified: false,
        ...(href ? { href } : {}),
        hierarchicalContext: hctxOf(el),   // v2.74.838 — ancestor disambiguator for selector recovery
        location: { band: b, absRect: ar, visibleAtRest: (ar.y + ar.h) > origScrollY && ar.y < origScrollY + vh, scrollToY: Math.max(0, ar.y - Math.round(vh * 0.3)) },
        interaction: interactionOf(kind, el),
        confidence: 0.6,
        evidence: { method: 'enumeration', observedAt: Date.now() },
      });
    }
  }

  // ── 3. Regions (landmarks). Measure at the TOP: a sticky/fixed header's rect
  // is scroll-relative, so measuring it after the band loop (left at page bottom)
  // mis-reports its absolute Y. Scroll to rest first. (v2.74.402)
  try { window.scrollTo(0, 0); } catch { /* */ }
  await sleep(60);
  try {
    for (const el of document.querySelectorAll(REGION_SEL)) {
      if (feats.size >= FEATURE_CAP) break;
      if (!vis(el)) continue;
      let selector = null;
      try { selector = synthesizeSelector(el, document); } catch { /* */ }
      if (!selector) continue;
      const label = (el.getAttribute('aria-label') || el.getAttribute('role') || el.tagName.toLowerCase()).slice(0, 60);
      const ar = absRect(el);
      const id = djb2(`region|${el.getAttribute('role') || el.tagName.toLowerCase()}|${label}|${selector}`);
      add({
        id, kind: 'region', label, a11yRole: el.getAttribute('role') || el.tagName.toLowerCase(),
        hierarchicalContext: hctxOf(el),   // v2.74.838 — ancestor disambiguator for selector recovery
        selector, selectorKind: tierOf(selector), selectorVerified: false,
        location: { band: Math.floor(ar.y / bandStep), absRect: ar, visibleAtRest: (ar.y + ar.h) > origScrollY && ar.y < origScrollY + vh, scrollToY: Math.max(0, ar.y - Math.round(vh * 0.3)) },
        interaction: { pattern: 'none', effect: 'none' },
        confidence: 0.6,
        evidence: { method: 'enumeration', observedAt: Date.now() },
      });
    }
  } catch { /* */ }

  try { window.scrollTo(0, origScrollY); } catch { /* */ }
  return {
    success: true,
    features: [...feats.values()],
    // EX-3 (v2.74.847) — HONEST truncation signal: enumeratePage stops adding at FEATURE_CAP (500), so a dense page is
    // silently incomplete. `capped` (the map filled to the cap) lets buildLocale stamp coverage.capped — the data the
    // "good-enough-to-build-on" gate (EX-6) reads to decide retry-with-higher-cap vs proceed. Pure observability.
    meta: { url: location.href, title: document.title || '', viewport: { w: vw, h: vh }, scrollHeight: docH, bands: bandCount, capped: feats.size >= FEATURE_CAP, enumeratedAt: Date.now() },
  };
}

// v2.74.433 — Deterministic outgoing-link extraction for the Ground discovery
// crawl. Link extraction is a DOM task, not a judgment task: walk every
// <a href> (shadow-DOM aware), resolve to an absolute http(s) URL, dedupe, and
// return {href,text}. This replaces the LLM classifier's unreliable+over-
// restrictive `outgoingLinks` (which excluded nav/footer and capped at 8 —
// discarding exactly the category/nav links a homepage is built from, yielding
// the impoverished 1-node/0-edge siteMap). DiscoveryService feeds this into
// both the BFS enqueue and siteMapFromCrawl edges.
function extractPageLinks() {
  const LINK_CAP = 250;          // pathological pages (mega-menus) can have 1000s
  const seen = new Set();
  const links = [];
  let anchors = [];
  try { anchors = queryAllDeep('a[href]'); } catch { anchors = []; }
  for (const a of anchors) {
    if (links.length >= LINK_CAP) break;
    let abs = '';
    try { abs = a.href; } catch { continue; }          // .href resolves relative→absolute
    if (!abs || !/^https?:/i.test(abs)) continue;       // skip javascript:/mailto:/tel:/#
    // Normalize: drop hash so /x and /x#sec collapse to one edge target.
    let key = abs;
    try { const u = new URL(abs); u.hash = ''; key = u.toString(); } catch { /* */ }
    if (seen.has(key)) continue;
    seen.add(key);
    let text = '';
    try {
      text = (a.getAttribute('aria-label') || a.getAttribute('title') || a.innerText || a.textContent || '')
        .trim().replace(/\s+/g, ' ').slice(0, 120);
    } catch { /* */ }
    links.push({ href: key, text });
  }
  return { success: true, links, url: location.href, title: document.title || '' };
}

/**
 * v2.74.455 — Fetch a (typically same-origin) URL's text from THIS PAGE's context.
 * Used by background.js to read a sitemap behind a Cloudflare/WAF bot-challenge: a
 * service-worker fetch reliably 403s such a sitemap (no real navigation fingerprint, and
 * the challenge JS can't run in a worker), but a fetch issued from a tab the browser has
 * ALREADY loaded the site in is a genuine first-party request — it carries the user's
 * cf_clearance cookie, the real UA/TLS fingerprint, and the Sec-Fetch-* headers, so
 * Cloudflare serves it. Transparently gunzips a `.gz` sitemap (DecompressionStream exists
 * in the page realm). Returns { ok, status, text } — the shape background.js adapts to
 * SitemapService's injectable { text, status } fetcher.
 *
 * Same-origin only in practice: an MV3 content-script fetch is subject to the PAGE's CORS,
 * so a cross-origin child sitemap would fail — acceptable (sitemaps keep children
 * same-origin); the SW transport remains the fallback for those.
 */
async function fetchUrlText(url) {
  const ACCEPT = 'application/xml,text/xml,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', credentials: 'include', headers: { Accept: ACCEPT } });
    const status = res ? res.status : 0;
    if (!res || !res.ok) return { ok: false, status, text: null };
    // v2.74.457 — decide gzip by the actual leading bytes (magic 0x1f 0x8b), not the .gz
    // extension. fetch() already inflates a `Content-Encoding: gzip` body, so a second manual
    // inflate would corrupt it; and a challenge HTML page at the .gz URL isn't gzip at all.
    // Inflate only true gzip; otherwise decode as-is. Mirrors SitemapService._bodyText.
    const buf = new Uint8Array(await res.arrayBuffer());
    const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    if (isGzip && typeof DecompressionStream !== 'undefined') {
      try {
        const stream = new Response(buf).body.pipeThrough(new DecompressionStream('gzip'));
        return { ok: true, status, text: await new Response(stream).text() };
      } catch { /* corrupt gzip — fall through to raw decode */ }
    }
    let text = '';
    try { text = new TextDecoder('utf-8').decode(buf); } catch { text = ''; }
    return { ok: true, status, text };
  } catch (e) {
    return { ok: false, status: 0, text: null, error: e && e.message };
  } finally {
    clearTimeout(timer);
  }
}

// v2.74.395 — opts.includeContentBlocks → prepend a REPEATING CONTENT BLOCKS
// section (for Resolve). Default off (agent walker path stays control-only).
function handleDomSnapshotRich(prevSigs = [], opts = {}) {
  const prevSet = new Set(prevSigs);

  // Attributes captured per element. Expanded in v2.24.0 to cover selection
  // state (aria-pressed/checked/selected/current), composite-widget relations
  // (aria-controls/owns/activedescendant), and data-state-style hooks used by
  // Radix/shadcn/Material/etc. Without these, a chip's "selected" state is
  // invisible post-click and the walker loops retrying the same action.
  const ATTRS = [
    'id', 'role',
    'aria-label', 'aria-expanded', 'aria-haspopup', 'aria-busy',
    'aria-disabled', 'aria-live', 'aria-invalid',
    'aria-pressed', 'aria-checked', 'aria-selected', 'aria-current',
    'aria-controls', 'aria-owns', 'aria-activedescendant',
    'data-testid', 'data-test-id', 'data-key',
    'data-state', 'data-selected', 'data-active', 'data-checked', 'data-open',
    'placeholder', 'type', 'name', 'title', 'alt',
    'checked', 'selected',
  ];

  // Class-name selection-state sniffer. Component libraries encode selected
  // state in class names that don't correspond to any ARIA attribute —
  // `Mui-selected`, `is-active`, `chip--selected`, `active`, etc. Rather than
  // dump the full class attribute (mostly hashed noise like `css-1a2b3c`),
  // we scan for classes matching a small set of state-indicator substrings
  // and emit just those.
  const STATE_CLASS_PATTERNS = /(^|[\s_\-])(selected|active|checked|open|current|disabled|expanded|pressed|applied)([\s_\-]|$)/i;
  const extractStateClasses = (el) => {
    const raw = el.getAttribute('class');
    if (!raw) return '';
    const matches = raw.split(/\s+/).filter(c => STATE_CLASS_PATTERNS.test(c));
    return matches.join(' ');
  };

  // Elements whose text content is safe to include — product UI, not user data.
  // data-testid / data-test-id signals the element is a product component.
  // role signals semantic meaning, also typically product UI.
  // Pass B hardening — also include ephemeral signals (toasts, alerts) and
  // validation errors: their TEXT is the signal, and they usually lack testids.
  const isProductUI = (el) =>
    el.hasAttribute('data-testid') ||
    el.hasAttribute('data-test-id') ||
    el.hasAttribute('data-key') ||
    (el.getAttribute('role') && el.getAttribute('role') !== 'presentation') ||
    isEphemeralSignal(el) ||
    isValidationError(el);

  function sig(el) {
    const tag  = el.tagName;
    const tid  = el.getAttribute('data-test-id') ?? el.getAttribute('data-testid') ?? '';
    const id   = el.getAttribute('id') ?? '';
    const role = el.getAttribute('role') ?? '';
    // Include selection-state signals in the sig so post-selection state
    // changes produce a different signature (marks the element as "changed").
    const pressed  = el.getAttribute('aria-pressed')  ?? '';
    const checked  = el.getAttribute('aria-checked')  ?? (el.checked ? 'true' : '');
    const selected = el.getAttribute('aria-selected') ?? (el.selected ? 'true' : '');
    const dataState = el.getAttribute('data-state') ?? '';
    const stateClasses = extractStateClasses(el);
    // Pass B hardening — include aria-invalid in sig so transitions into/out
    // of invalid state register as "changed" (common pattern: user tries to
    // submit → fields go aria-invalid="true" → sig diffs → Claude sees the
    // validation state has appeared).
    const invalid = el.getAttribute('aria-invalid') === 'true' ? '1' : '';
    const text = isProductUI(el) ? (el.innerText ?? el.textContent ?? '').trim().slice(0, 40) : '';
    return `${tag}|${tid}|${id}|${role}|${pressed}|${checked}|${selected}|${dataState}|${stateClasses}|${invalid}|${text}`;
  }

  function summarise(el, prevSig) {
    const parts = [el.tagName.toLowerCase()];
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v != null && v !== '') parts.push(`${a}="${String(v).slice(0, 80)}"`);
    }

    // Native reflected properties that don't always mirror attributes
    if (el instanceof HTMLInputElement) {
      if (el.checked && !el.hasAttribute('checked'))   parts.push(`checked="true"`);
      if (el.indeterminate) parts.push(`indeterminate="true"`);
    }
    if (el instanceof HTMLOptionElement) {
      if (el.selected && !el.hasAttribute('selected')) parts.push(`selected="true"`);
    }

    // Disabled state
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      parts.push(`disabled="true"`);
    }

    // Selection-state classes — only emit matching substrings, not the full
    // attribute (which is mostly hashed noise on React apps).
    const stateCls = extractStateClasses(el);
    if (stateCls) parts.push(`state-class="${stateCls.slice(0, 80)}"`);

    // Pass B hardening — Ephemeral signal tag. Labels toasts/alerts/banners
    // explicitly so Claude recognizes them as transient feedback rather than
    // persistent UI. The signal-type is a condensed label, not the class/role.
    if (isEphemeralSignal(el)) {
      const role = el.getAttribute('role') ?? '';
      let type = 'notification';
      if (role === 'alert' || role === 'alertdialog') type = 'alert';
      else if (role === 'status')                     type = 'status';
      else if (role === 'progressbar')                type = 'progress';
      else {
        const cls = el.getAttribute('class') ?? '';
        if      (/toast/i.test(cls))        type = 'toast';
        else if (/snackbar/i.test(cls))     type = 'snackbar';
        else if (/alert/i.test(cls))        type = 'alert';
        else if (/banner/i.test(cls))       type = 'banner';
      }
      parts.push(`signal-type="${type}"`);
    }

    // Pass B hardening — Validation-error tag. Elements matching the
    // validation-error class heuristic are explicitly labeled so Claude can
    // distinguish "this text is a validation message" from "this is body copy."
    if (isValidationError(el)) {
      parts.push(`signal-type="validation-error"`);
    }

    // Pass B hardening — For aria-invalid="true" inputs, resolve the
    // aria-describedby chain to surface the specific error message. This is
    // the semantic path screen readers use; if the app is accessible, this
    // gets us the exact error text without guesswork.
    if (el.getAttribute('aria-invalid') === 'true') {
      const describedText = resolveDescribedBy(el);
      if (describedText) {
        parts.push(`validation-text="${describedText.slice(0, 150).replace(/"/g, "'")}"`);
      }
    }

    // Text content for product UI elements (widened in Pass B to cover
    // ephemeral signals and validation errors — their text IS the value).
    if (isProductUI(el)) {
      const raw  = (el.innerText ?? el.textContent ?? '').trim();
      const text = raw.slice(0, 120).replace(/"/g, "'").replace(/\n+/g, ' ');
      if (text) parts.push(`text="${text}"`);
    }

    // For input/textarea — emit current value so Claude can verify field is filled.
    // Only emit when non-empty to keep snapshot concise.
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value) {
      const val = el.value.slice(0, 80).replace(/"/g, "'");
      parts.push(`value="${val}"`);
    }

    // For radio/checkbox inputs — emit associated label text so Claude can
    // identify which option is which. The label is the primary semantic content
    // for these elements and is not captured by any other mechanism.
    if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
      let labelText = '';
      // Check for explicit label via for="id"
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) {
          // Use innerText but strip screen-reader-only spans (aria-hidden siblings)
          const visibleSpan = label.querySelector('[aria-hidden="true"]');
          labelText = visibleSpan
            ? visibleSpan.textContent.trim()
            : label.innerText.trim();
        }
      }
      // Fallback: wrapping label
      if (!labelText) {
        const wrappingLabel = el.closest('label');
        if (wrappingLabel) labelText = wrappingLabel.innerText.trim();
      }
      if (labelText) parts.push(`label-text="${labelText.slice(0, 60).replace(/"/g, "'")}"`);
      // Also emit checked state so Claude knows current selection
      if (el.checked) parts.push(`checked="true"`);
    }

    // For native <select> elements — list available options so Claude
    // knows to use SELECT action and can identify the correct option value
    if (el instanceof HTMLSelectElement) {
      const opts = Array.from(el.options)
        .map(o => o.text.trim())
        .filter(Boolean)
        .slice(0, 10)
        .join('|');
      if (opts) parts.push(`options="${opts}"`);
      parts.push(`tag-hint="select"`);
    }

    // For navigation items include child anchor href AND a ready-to-use selector.
    // use-selector is the correct CSS selector Claude should use — no construction needed.
    const role = el.getAttribute('role');
    if (role === 'menuitem' || role === 'option') {
      const anchor = el.querySelector('a[href]') ?? (el.tagName === 'A' ? el : null);
      if (anchor) {
        const href = anchor.getAttribute('href');
        if (href) {
          parts.push(`child-href="${href.slice(0, 120)}"`);
          // Provide the ready-to-use selector directly — avoids Claude constructing wrong selectors
          const safeHref = href.replace(/"/g, "'");
          parts.push(`use-selector="a[href='${safeHref.slice(0, 100)}']"`);
        }
      }
    }

    // Change delta
    const currentSig = sig(el);
    if (!prevSet.has(currentSig)) {
      // Check if it's truly new (tag+testid not seen before) or just changed
      const baseKey = `${el.tagName}|${el.getAttribute('data-test-id') ?? el.getAttribute('data-testid') ?? ''}`;
      const wasPresent = [...prevSet].some(s => s.startsWith(baseKey));
      parts.push(wasPresent ? `changed="true"` : `new="true"`);
    }

    return `<${parts.join(' ')} />`;
  }

  const SEL = [
    'button','input','textarea','select',
    '[role="button"]','[role="textbox"]','[role="combobox"]',
    '[role="menuitem"]','[role="tab"]','[role="dialog"]','[role="status"]',
    '[role="option"]','[role="listbox"]',
    // Pass B hardening — ephemeral signals: toasts, alerts, progress indicators.
    // These are often the ONLY indication that a submit succeeded or failed.
    '[role="alert"]','[role="progressbar"]',
    '[aria-invalid="true"]','[aria-busy="true"]','[aria-describedby]',
    '.toast','.notification','.snackbar','.banner','.alert',
    '[class*="toast"]','[class*="notification"]','[class*="snackbar"]',
    '.spinner','.loader','[class*="spinner"]','[class*="loading"]',
    '[data-notification]','[data-toast]','[data-loading="true"]',
    '[aria-label]','[aria-busy]','[aria-live]',
    '[data-testid]','[data-test-id]','[data-key]',
    // Pass B hardening — images/icons that carry meaning via accessibility labels.
    // Pure decorative <svg aria-hidden="true"> correctly excluded; state icons
    // with alt/aria-label/title come through.
    'img[alt]','img[aria-label]','svg[aria-label]','svg[role="img"]','[title]',
  ].join(',');

  // Roles that should be included regardless of bounding rect —
  // these live inside drawers/flyouts that animate in and may have
  // zero dimensions during the CSS transition but are semantically present.
  const ALWAYS_INCLUDE_ROLES = new Set(['menuitem','option','listitem','menuitemradio','menuitemcheckbox','alert','status','progressbar']);

  // Pass B hardening — Ephemeral signals: text content is the value. A toast
  // that says "Saved!" IS the signal that the save worked. We force-emit text
  // for these even when they lack a testid (most toasts are generic <div>s).
  const EPHEMERAL_ROLE_SET = new Set(['alert','status','progressbar','alertdialog']);
  const isEphemeralSignal = (el) => {
    const role = el.getAttribute('role');
    if (role && EPHEMERAL_ROLE_SET.has(role)) return true;
    // Class-based detection — matches .toast, .notification, .snackbar etc.
    const raw = el.getAttribute('class');
    if (!raw) return false;
    return /(^|[\s_\-])(toast|notification|snackbar|banner|alert)([\s_\-]|$)/i.test(raw);
  };

  // Pass B hardening — Validation error detection. Find text elements near
  // invalid inputs and surface them. Primary mechanism: aria-describedby
  // referencing an id pointing to the error message. Secondary: class-based
  // (`.error`, `.field-error`, `.invalid-feedback`, etc.) inside a form.
  const isValidationError = (el) => {
    const raw = el.getAttribute('class');
    if (!raw) return false;
    return /(^|[\s_\-])(error|invalid|field-error|invalid-feedback|has-error|validation-error)([\s_\-]|$)/i.test(raw);
  };

  // Resolve aria-describedby to associated text. Used on aria-invalid inputs
  // to surface the specific validation message without guessing.
  const resolveDescribedBy = (el) => {
    const ids = (el.getAttribute('aria-describedby') ?? '').trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return '';
    const texts = [];
    for (const id of ids) {
      const target = document.getElementById(id);
      if (target) {
        const txt = (target.innerText ?? target.textContent ?? '').trim();
        if (txt) texts.push(txt.slice(0, 100));
      }
    }
    return texts.join(' | ');
  };

  const seen    = new Set();
  const visible = queryAllDeep(SEL).filter(el => {
    if (seen.has(el)) return false;
    seen.add(el);
    // Always include semantic nav/menu/signal elements
    if (ALWAYS_INCLUDE_ROLES.has(el.getAttribute('role'))) return true;
    // Always include ephemeral signals (toasts etc.) — they may be animating in
    if (isEphemeralSignal(el)) return true;
    // Always include elements inside a container with aria-hidden="false"
    // (open drawers/flyouts declare this on their root element)
    const flyout = el.closest('[aria-hidden="false"]');
    if (flyout && flyout !== document.documentElement && flyout !== document.body) return true;
    // Skip explicitly decorative icons
    if (el.getAttribute('aria-hidden') === 'true') return false;
    try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    catch { return false; }
  });

  // Serialise <body> attributes — captures drawer/modal open state signals like
  // data-scroll="disabled" that don't appear on any child element.
  // Pass B fix — also emit the current URL (pathname + search) so Claude can
  // detect state changes that manifest only as URL mutations, which is common
  // on filter UIs: e.g. Indeed's date-posted chip writes `?fromage=1` when the
  // "Last 24 hours" option is applied, with no DOM-attribute change on the chip
  // itself. Without URL in the snapshot, consecutive snapshots look identical
  // to Claude even though the filter is now applied.
  const BODY_ATTRS = ['class','data-scroll','data-nav-template','data-sidebar','data-modal',
                      'data-drawer','aria-hidden','aria-busy','data-state','data-open'];
  const bodyParts  = ['body'];
  for (const a of BODY_ATTRS) {
    const v = document.body?.getAttribute(a);
    if (v) bodyParts.push(`${a}="${v.slice(0, 80)}"`);
  }
  // Append URL components. Keep pathname + search; drop origin (noise) and hash
  // (rarely carries filter state but can be added later if needed).
  try {
    const loc = window.location;
    const pathAndQuery = (loc.pathname ?? '') + (loc.search ?? '');
    if (pathAndQuery) bodyParts.push(`url="${pathAndQuery.slice(0, 200).replace(/"/g, "'")}"`);
  } catch { /* ignore */ }

  // Pass B hardening — Page-wide busy state. If any progressbar/spinner is
  // visible or any element has aria-busy="true", the page is processing.
  // Claude should WAIT rather than click again. We check at the body level so
  // Claude gets one clear signal regardless of which element is busy.
  try {
    const busyEl = document.querySelector(
      '[aria-busy="true"], [role="progressbar"], .spinner, [class*="spinner"], [class*="loading"], [data-loading="true"]'
    );
    if (busyEl) {
      try {
        const r = busyEl.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) bodyParts.push('page-busy="true"');
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  // Pass B hardening — Currently-focused element. Many flows depend on focus
  // (autocomplete filtering, date picker opening on focus). Emit the focused
  // element's signature so Claude can distinguish "nothing has focus" from
  // "the input is focused and ready for typing". document.activeElement is
  // <body> when nothing meaningful has focus.
  try {
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae !== document.documentElement) {
      const tag  = ae.tagName?.toLowerCase() ?? '';
      const aid  = ae.id ?? '';
      const tid  = ae.getAttribute?.('data-testid') ?? ae.getAttribute?.('data-test-id') ?? '';
      const alb  = ae.getAttribute?.('aria-label') ?? '';
      const focusHint = tid ? `${tag}[data-testid='${tid}']`
                     : aid ? `${tag}#${aid}`
                     : alb ? `${tag}[aria-label='${alb.slice(0,40)}']`
                     : tag;
      bodyParts.push(`focused="${focusHint.slice(0, 100).replace(/"/g, "'")}"`);
    }
  } catch { /* ignore */ }
  const bodySig     = bodyParts.join('|');
  const bodyChanged = prevSet.size > 0 && ![...prevSet].some(s => s === bodySig);
  if (bodyChanged) bodyParts.push(`changed="true"`);
  const bodyLine = `<${bodyParts.join(' ')} />`;

  const currentSigs = [bodySig, ...visible.map(sig)];

  // Pass B fix — When a Fragment walk has 400+ interactive elements on the
  // page (common on search results, dashboards, product lists), the 300-cap
  // can exclude elements that are new/changed (e.g. a filter dropdown that
  // opens at the top of the toolbar with 10 new options). That's exactly
  // the signal Claude needs. Re-order so changed/new elements come first,
  // THEN unchanged ones, so the cap never loses the signal.
  //
  // Only apply this when prev signatures are available (i.e. not the very
  // first snapshot). On first snapshot, all elements are "new" by definition
  // and the original DOM order is the most useful.
  let orderedElements;
  if (prevSet.size === 0) {
    orderedElements = visible;
  } else {
    const changed = [];
    const unchanged = [];
    for (let i = 0; i < visible.length; i++) {
      if (prevSet.has(currentSigs[i + 1])) unchanged.push(visible[i]);
      else                                 changed.push(visible[i]);
    }
    orderedElements = [...changed, ...unchanged];
  }

  // Build a diff summary for the snapshot header so Claude sees "how many
  // things changed since last turn" at a glance. Strong signal for "did my
  // last action do anything".
  let diffHeader = '';
  if (prevSet.size > 0) {
    const changedCount = currentSigs.slice(1).filter(s => !prevSet.has(s)).length;
    diffHeader = `<!-- diff: ${changedCount} element${changedCount === 1 ? '' : 's'} changed since previous snapshot -->\n`;
  }

  const elementLines = orderedElements.slice(0, 300).map(el => {
    const idx = visible.indexOf(el);
    return summarise(el, currentSigs[idx + 1]);
  });

  // v2.74.395 — Opt-in repeating-content-block section (Resolve). Placed at the
  // TOP of the snapshot so the resolver's 12k-char slice never truncates it —
  // these are the only handles content/structural roles have.
  let contentHeader = '';
  if (opts && opts.includeContentBlocks) {
    try {
      const blocks = detectRepeatingContentBlocks();
      if (blocks.length) {
        contentHeader = `<!-- REPEATING CONTENT BLOCKS (structural items with no semantic hook; each selector is querySelector-verified to match N elements — use these for "many" content roles) -->\n` +
          blocks.map(b => `<repeating-block tag="${b.tag}" count="${b.count}"${b.hasImage ? ' has-image="true"' : ''} selector="${b.selector.replace(/"/g, "'")}"${b.sampleText ? ` sample-text="${b.sampleText.replace(/"/g, "'")}"` : ''} />`).join('\n') +
          '\n';
      }
    } catch { /* best-effort */ }
  }

  const snapshot = diffHeader + contentHeader + [bodyLine, ...elementLines].join('\n');
  return {
    success : true,
    snapshot,
    sigs    : currentSigs,
    title   : document.title ?? '',
    url     : window.location.href,
  };
}

// ─── Page idle check ──────────────────────────────────────────────────────────

/**
 * Returns true if page is complete and network has been quiet for idleMs.
 * @param {number} idleMs
 * @returns {boolean}
 */
function handlePageIdle(idleMs) {
  if (document.readyState !== 'complete') return false;
  const entries = performance.getEntriesByType('resource');
  if (entries.length === 0) return true;
  const last = entries[entries.length - 1];
  return (performance.now() - last.responseEnd) > idleMs;
}

// ─── v2.72.14 (Pass 6) — DOM-scrape helpers for section/image_refs ──────────
//
// htmlToMarkdown walks an element subtree producing markdown text.
// Hand-rolled minimal converter — handles the structural elements
// authors actually want preserved when capturing prose:
//   - Paragraphs: separated by double newlines
//   - Headings: # / ## / ### / etc per h1-h6 level
//   - Bold/italic: ** / * (also handles <strong> / <em>)
//   - Inline code: `code`
//   - Links: [text](href)
//   - Lists: - item / 1. item (ul / ol)
//   - Line breaks: <br> → newline
//
// Degrades gracefully for unsupported structures:
//   - Tables: cells joined with " | ", rows separated by newlines
//     (not markdown table syntax — that's hard to get right with merged
//     cells and complex headers; fallback to readable plain text)
//   - Blockquotes: content prefixed with "> " on each line
//   - Code blocks: wrapped in triple-backtick fences with no language
//     (existing pre/code structure preserved as best-effort)
//
// Skips entirely:
//   - script, style, noscript: no useful prose content
//   - hidden elements: respects display:none and visibility:hidden
//
// Real-world HTML is messy; this walker aims for "good enough" prose
// fidelity, not perfect round-tripping. If output quality matters in
// real use, swap to turndown or similar in a future pass.

function htmlToMarkdown(rootEl) {
  if (!rootEl) return '';
  const out = walkBlock(rootEl).trim();
  // Collapse 3+ consecutive newlines to 2 (standard markdown paragraph
  // separation). Real-world HTML produces a lot of blank-paragraph noise.
  return out.replace(/\n{3,}/g, '\n\n');
}

// v2.72.15 (review fix) — Single source of truth for "skip this element."
// Used by both walkBlock and walkInline. Encodes two skip rules:
//   1. Non-content tags (script/style/noscript/template) — never emit.
//   2. CSS-hidden elements (display:none, visibility:hidden) — content is
//      not semantically present in the rendered page.
//
// getComputedStyle can throw on detached nodes; treat throws as "don't skip"
// since the element is at least structurally present. This matches the
// pre-extraction behavior of the original walker.
function shouldSkipElement(el, tag) {
  if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') {
    return true;
  }
  try {
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
  } catch (_) { /* getComputedStyle throws on detached nodes — proceed */ }
  return false;
}

// Walk an element as a block context. Returns markdown string.
function walkBlock(el) {
  if (!el) return '';
  if (el.nodeType === 3) {  // text node
    return collapseWhitespace(el.nodeValue ?? '');
  }
  if (el.nodeType !== 1) return '';   // skip comments, etc.

  const tag = el.tagName?.toLowerCase();
  if (shouldSkipElement(el, tag)) return '';

  // Headings.
  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
    const level = Number(tag[1]);
    const inner = walkInline(el).trim();
    return inner ? `\n\n${'#'.repeat(level)} ${inner}\n\n` : '';
  }

  // Paragraphs.
  if (tag === 'p') {
    const inner = walkInline(el).trim();
    return inner ? `\n\n${inner}\n\n` : '';
  }

  // Lists.
  if (tag === 'ul' || tag === 'ol') {
    const ordered = tag === 'ol';
    const items = [...el.children].filter(c => c.tagName?.toLowerCase() === 'li');
    if (items.length === 0) return '';
    const lines = items.map((li, i) => {
      const marker = ordered ? `${i + 1}. ` : '- ';
      // List items can contain block-level children (nested lists).
      // walkBlock recursively handles them. For inline content we want
      // a flat single-line rendering with subsequent block content
      // indented under the marker.
      const inner = walkBlockChildren(li).trim();
      // Indent continuation lines under the bullet.
      const indented = inner.replace(/\n/g, '\n  ');
      return `${marker}${indented}`;
    });
    return `\n\n${lines.join('\n')}\n\n`;
  }

  // Blockquotes — prefix each line with "> ".
  if (tag === 'blockquote') {
    const inner = walkBlockChildren(el).trim();
    if (!inner) return '';
    const quoted = inner.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
    return `\n\n${quoted}\n\n`;
  }

  // Code blocks: <pre> with optional <code> child.
  if (tag === 'pre') {
    const codeEl = el.querySelector(':scope > code') ?? el;
    const text = codeEl.textContent ?? '';
    return `\n\n\`\`\`\n${text.replace(/\n+$/, '')}\n\`\`\`\n\n`;
  }

  // Tables — degrade to pipe-separated rows. Not markdown table syntax
  // (which requires header alignment markers and breaks easily on real
  // HTML). Readable plaintext is more useful than broken markdown.
  if (tag === 'table') {
    const rows = [...el.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr')];
    if (rows.length === 0) return '';
    const lines = rows.map(tr => {
      const cells = [...tr.children]
        .filter(c => c.tagName?.toLowerCase() === 'td' || c.tagName?.toLowerCase() === 'th')
        .map(c => walkInline(c).trim().replace(/\|/g, '\\|'));
      return cells.join(' | ');
    });
    return `\n\n${lines.join('\n')}\n\n`;
  }

  // <br> standalone — line break.
  if (tag === 'br') return '\n';

  // <hr> — horizontal rule.
  if (tag === 'hr') return '\n\n---\n\n';

  // <div>, <section>, <article>, <main>, <header>, <footer>, <aside>,
  // <nav>, <figure>, <figcaption>, <details>, <summary>, etc. — generic
  // block containers. Walk children, separating block-level outputs with
  // the natural paragraph spacing they bring themselves.
  if (isGenericBlock(tag)) {
    return walkBlockChildren(el);
  }

  // Inline elements at block-walk level: gather their text inline, no
  // wrapping. This is the case for things like <span>, <strong>, <em>
  // appearing as direct children of the section root with no <p> wrapper.
  return walkInline(el);
}

// Walk children of an element as block context, joining them. Used for
// containers that have multiple block-level children (lists, blockquotes,
// generic divs, etc.).
function walkBlockChildren(el) {
  let out = '';
  for (const child of el.childNodes) {
    out += walkBlock(child);
  }
  return out;
}

// Walk an element treating it as inline content. Returns a single-line
// markdown string with no paragraph breaks. Used for headings, paragraphs,
// list items, and table cells.
function walkInline(el) {
  if (!el) return '';
  if (el.nodeType === 3) return collapseWhitespace(el.nodeValue ?? '');
  if (el.nodeType !== 1) return '';

  const tag = el.tagName?.toLowerCase();
  // v2.72.15 (review fix) — inline walker now respects visibility, mirroring
  // walkBlock. Without this, hidden inline content (e.g. <span style="display:none">
  // inside a paragraph) leaked into the captured markdown.
  if (shouldSkipElement(el, tag)) return '';

  // Bold.
  if (tag === 'strong' || tag === 'b') {
    const inner = walkInlineChildren(el);
    return inner ? `**${inner}**` : '';
  }
  // Italic.
  if (tag === 'em' || tag === 'i') {
    const inner = walkInlineChildren(el);
    return inner ? `*${inner}*` : '';
  }
  // Inline code.
  if (tag === 'code' && el.parentElement?.tagName?.toLowerCase() !== 'pre') {
    const inner = el.textContent ?? '';
    return inner ? `\`${inner}\`` : '';
  }
  // Links.
  if (tag === 'a') {
    const inner = walkInlineChildren(el).trim();
    const href  = el.getAttribute('href') ?? '';
    if (!inner) return '';
    if (!href) return inner;
    return `[${inner}](${href})`;
  }
  // Images embedded inline — render as ![alt](src). The image is also
  // captured separately in the section's images list, but inline
  // representation makes the markdown self-contained.
  if (tag === 'img') {
    const src = el.getAttribute('src') ?? '';
    const alt = el.getAttribute('alt') ?? '';
    return src ? `![${alt}](${src})` : '';
  }
  // Line break inline.
  if (tag === 'br') return '\n';

  // Default: walk children as inline.
  return walkInlineChildren(el);
}

function walkInlineChildren(el) {
  let out = '';
  for (const child of el.childNodes) {
    out += walkInline(child);
  }
  return out;
}

// Generic block-level tags. List is intentionally inclusive — when in
// doubt, treat as block. Inline-by-default tags (span, a, em, strong, etc.)
// are handled by walkInline; everything else falls into walkBlock's
// generic-block handling.
function isGenericBlock(tag) {
  return tag === 'div' || tag === 'section' || tag === 'article' ||
         tag === 'main' || tag === 'header' || tag === 'footer' ||
         tag === 'aside' || tag === 'nav' || tag === 'figure' ||
         tag === 'figcaption' || tag === 'details' || tag === 'summary' ||
         tag === 'address' || tag === 'fieldset' || tag === 'form' ||
         tag === 'dl' || tag === 'dt' || tag === 'dd' ||
         tag === 'body' || tag === 'html';
}

// Collapse whitespace runs to single spaces — HTML treats runs of
// whitespace (including newlines from source code formatting) as a
// single space when rendering. Markdown should do the same; explicit
// line breaks come from <br> handling.
function collapseWhitespace(s) {
  return String(s).replace(/\s+/g, ' ');
}

// Extract <img> descendants of an element as records. Captures URL +
// dimensions + alt text + responsive-image variants (currentSrc, srcset).
//
// Returns: array of { src, alt, width, height, currentSrc, srcset }.
//
// Notes:
//   - <picture> > <source> srcsets are not unwrapped here; the <img>
//     fallback inside <picture> is captured. Browsers populate
//     img.currentSrc with the actually-displayed URL which gives the
//     responsive-resolved URL.
//   - CSS background-image URLs are NOT captured. Pass 6 ships <img>
//     only; CSS background extraction is a future expansion if needed.
//   - Lazy-loaded images: currentSrc reflects whatever the browser has
//     decided to load. If the image hasn't loaded yet, src may be a
//     placeholder. Capture both for downstream visibility.
function extractImageRefs(rootEl) {
  if (!rootEl) return [];
  // v2.74.286 — Include the root itself when it IS an <img>. Previously
  // querySelectorAll('img') skipped the root, so a landmark on a direct
  // <img> element returned an empty image_refs list (real bug surfaced
  // during capability-model audit). Now: root.tag === IMG → [root, ...
  // any nested imgs]. For a non-img root, behavior unchanged.
  const imgs = [];
  if (rootEl.tagName === 'IMG') imgs.push(rootEl);
  for (const child of rootEl.querySelectorAll('img')) imgs.push(child);
  return imgs.map(img => ({
    src        : img.getAttribute('src') ?? '',
    alt        : img.getAttribute('alt') ?? '',
    width      : Number(img.naturalWidth) || Number(img.width) || 0,
    height     : Number(img.naturalHeight) || Number(img.height) || 0,
    currentSrc : img.currentSrc ?? '',
    srcset     : img.getAttribute('srcset') ?? '',
  }));
}

// Extract <a href> descendants of an element as records. Captures URL +
// link text + title attribute.
//
// Returns: array of { href, text, title }.
//
// Filter: only anchors with an href attribute are captured — name-only
// anchors (e.g. <a name="...">) and javascript: URLs are skipped to keep
// the list useful for document composition. Mailto and other schemes
// are kept as-is; downstream consumers can filter further.
function extractLinkRefs(rootEl) {
  if (!rootEl) return [];
  const anchors = [...rootEl.querySelectorAll('a[href]')];
  return anchors
    .filter(a => {
      const href = a.getAttribute('href') ?? '';
      return href && !href.startsWith('javascript:');
    })
    .map(a => ({
      href : a.getAttribute('href') ?? '',
      text : (a.textContent ?? '').trim(),
      title: a.getAttribute('title') ?? '',
    }));
}

// ─── Resolve-roles complexity metric (v2.74.353) ───────────────────────────────
// Deterministic DOM scan that scores how hard this page is for "Resolve roles"
// (role → selector). Two channels: SYNTHESIS (can a durable selector be written
// — DOM hooks) and MATCHING (can Claude tell which element it is — the
// screenshot only shows the viewport). Pure vanilla; no LLM. See
// DESIGN_resolve_roles.md § 7.
function computePageComplexity() {
  const W = window, D = document;
  const vh = W.innerHeight || 1;
  const scrollY = W.scrollY || W.pageYOffset || 0;

  // class tokens that look machine-generated (CSS-modules / styled-components /
  // hashed utility classes) — class-based selectors are useless on these.
  const HASH = [/^css-[a-z0-9]{4,}$/i, /^sc-[A-Za-z0-9]{5,}$/, /^[a-z]+-[a-z0-9]{6,}$/i, /^_[A-Za-z0-9]{5,}$/, /^[A-Za-z]{1,4}_[A-Za-z0-9]{5,}$/];
  const isHashed = (t) => HASH.some(re => re.test(t));

  const INTERACTIVE_SEL = 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="combobox"],[contenteditable="true"],summary';
  const hasHook = (el) => {
    const id = el.id;
    if (id && id.length <= 40 && !isHashed(id) && !/\s/.test(id)) return true;
    for (const a of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'name']) {
      if (el.getAttribute(a)) return true;
    }
    if (el.getAttribute('aria-label')) return true;
    if (el.getAttribute('role')) return true;
    return false;
  };
  const accName = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || '').trim();

  let total = 0, maxDepth = 0, generic = 0, shadowRoots = 0, customEls = 0;
  let classTokens = 0, hashedTokens = 0;
  let candTotal = 0, candHooked = 0, candOffscreen = 0, candOpaque = 0;
  let sameOriginIframes = 0, crossOriginIframes = 0;

  function visit(el, depth) {
    if (!el || !el.tagName) return;
    total++;
    if (depth > maxDepth) maxDepth = depth;
    const tag = el.tagName.toLowerCase();
    if (tag === 'div' || tag === 'span') generic++;
    if (tag.indexOf('-') > 0) customEls++;             // custom element
    const cls = (typeof el.className === 'string') ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    if (cls) for (const t of cls.split(/\s+/)) { if (!t) continue; classTokens++; if (isHashed(t)) hashedTokens++; }
    if (tag === 'iframe') {
      try {
        const u = new URL(el.getAttribute('src') || '', location.href);
        if (u.origin === location.origin) sameOriginIframes++; else crossOriginIframes++;
      } catch { crossOriginIframes++; }
    }
    let isCand = false;
    try { isCand = el.matches(INTERACTIVE_SEL); } catch { /* invalid in some contexts */ }
    if (isCand) {
      let r = null; try { r = el.getBoundingClientRect(); } catch { /* detached */ }
      if (r && r.width > 0 && r.height > 0) {                 // only rendered candidates
        candTotal++;
        if (hasHook(el)) candHooked++;
        if ((r.top + scrollY) > vh) candOffscreen++;          // below the first fold (screenshot can't show)
        if (!(el.textContent || '').trim() && !accName(el)) candOpaque++;  // no visible/acc label
      }
    }
    if (el.shadowRoot) { shadowRoots++; for (const c of el.shadowRoot.children) visit(c, depth + 1); }
    for (const c of el.children) visit(c, depth + 1);
  }
  try { visit(D.body || D.documentElement, 0); } catch { /* ignore */ }

  const c01 = (x) => Math.max(0, Math.min(1, x));
  // factor values (0..1, higher = harder)
  const f = {
    hookScarcity: candTotal > 0 ? c01(1 - candHooked / candTotal) : 0.5,
    obfuscation:  classTokens > 0 ? c01(hashedTokens / classTokens) : 0,
    genericRatio: total > 0 ? c01(generic / total) : 0,
    shadow:       c01(shadowRoots / 3),
    scale:        c01(0.6 * ((Math.log10(Math.max(total, 1)) - 2.3) / 1.5) + 0.4 * ((maxDepth - 12) / 18)),
    offscreen:    candTotal > 0 ? c01(candOffscreen / candTotal) : 0,
    opaque:       candTotal > 0 ? c01(candOpaque / candTotal) : 0,
    iframe:       c01(crossOriginIframes * 0.5 + sameOriginIframes * 0.15),
  };
  // weights sum to 100. synthesis channel (DOM) = 60; matching (visual) = 30; blockers = 10.
  const wSyn = { hookScarcity: 25, obfuscation: 15, genericRatio: 8, shadow: 7, scale: 5 };
  const wMatch = { offscreen: 18, opaque: 12 };
  const wBlock = { iframe: 10 };
  const synRaw = wSyn.hookScarcity * f.hookScarcity + wSyn.obfuscation * f.obfuscation + wSyn.genericRatio * f.genericRatio + wSyn.shadow * f.shadow + wSyn.scale * f.scale;
  const matchRaw = wMatch.offscreen * f.offscreen + wMatch.opaque * f.opaque;
  const blockRaw = wBlock.iframe * f.iframe;
  const score = Math.round(synRaw + matchRaw + blockRaw);
  const synthScore = Math.round((synRaw / 60) * 100);
  const matchScore = Math.round((matchRaw / 30) * 100);
  const tier = score < 25 ? 'simple' : score < 50 ? 'moderate' : score < 75 ? 'complex' : 'severe';

  return {
    success: true,
    report: {
      score, tier, synthScore, matchScore,
      factors: f,
      counts: {
        total, maxDepth, candTotal, candHooked, candOffscreen, candOpaque,
        shadowRoots, customEls, sameOriginIframes, crossOriginIframes,
        classTokens, hashedTokens,
      },
    },
  };
}

// ─── Structure verification (v2.74.362) ────────────────────────────────────
// Auto-verify a Perspective's structured composition against the live page.
//  A) STATIC (deterministic): resolution, multiplicity (match count),
//     containment (DOM ancestry vs declared parent).
//  C) POKE-AND-OBSERVE: for nodes with `triggers`, snapshot the targets'
//     visibility, fire ONE synthetic click on the (safe-to-click) source, wait,
//     re-check — did the claimed targets get revealed?
// Returns a per-ref verdict map; the sidepanel turns it into auto-judgments.
// `selectors` maps ref(landmark uid) → CSS selector (top-frame only; iframe-
// bound nodes are omitted and come back unverifiable). Synthetic clicks mutate
// the page (menus left open etc.) — acceptable for an explicit verify action.
async function verifyStructure(payload) {
  const tree = Array.isArray(payload?.tree) ? payload.tree : [];
  const selectors = (payload && typeof payload.selectors === 'object' && payload.selectors) ? payload.selectors : {};
  const results = {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const q1 = (ref) => { const s = selectors[ref]; if (!s) return null; try { return document.querySelector(s); } catch { return null; } };
  const qn = (ref) => { const s = selectors[ref]; if (!s) return []; try { return Array.from(document.querySelectorAll(s)); } catch { return []; } };
  const visible = (el) => { if (!el) return false; try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
  const isSafeToClick = (el) => {
    if (!el) return false;
    try {
      // Never poke things that navigate or submit — they'd wreck the page.
      if (el.matches('a[href], [type="submit"], input[type="submit"], button[type="submit"]')) return false;
      if (el.closest('form') && el.matches('button:not([type]), input[type="image"]')) return false;   // default-submit
      if (el.matches('button:not([type="submit"]), [role="button"], summary, [aria-haspopup], [aria-expanded], [role="combobox"]')) return true;
      return getComputedStyle(el).cursor === 'pointer';
    } catch { return false; }
  };
  // v2.74.363 — `contains` is LOGICAL containment (PERSPECTIVE_SPEC § 3), not strict
  // DOM ancestry. Portaled dropdowns/menus/modals render at <body> level, so
  // they are NOT DOM descendants of their trigger — yet logically belong inside
  // it. Recognize that link via ARIA (aria-controls/owns/labelledby) or the
  // popup pattern (parent opens a popup, child is a popup-ish role/class).
  const isLogicallyContained = (parent, child) => {
    try {
      const cid = child.id;
      const owns = `${parent.getAttribute('aria-controls') || ''} ${parent.getAttribute('aria-owns') || ''}`.trim();
      if (cid && owns.split(/\s+/).includes(cid)) return true;
      if (cid && child.closest(`[aria-controls~="${cid}"], [aria-owns~="${cid}"]`)) return true;
      const pid = parent.id;
      if (pid && (child.getAttribute('aria-labelledby') || child.getAttribute('aria-describedby') || '').split(/\s+/).includes(pid)) return true;
      const popupParent = parent.matches('[aria-haspopup], [aria-expanded], [role="combobox"]');
      const popupChild  = child.matches('[role="menu"], [role="listbox"], [role="dialog"], [role="tree"], [role="grid"], [role="combobox"], [role="option"], [role="menuitem"]')
        || /\b(menu|dropdown|popover|popup|modal|dialog|portal|overlay|listbox)\b/i.test(child.className || '');
      return popupParent && popupChild;
    } catch { return false; }
  };

  // Static check of one node against the CURRENT DOM (run post-poke so revealed
  // subtrees exist). `parentRef` is the declared containment parent.
  const checkNode = (n, parentRef) => {
    if (n?.virtual) return;   // v2.74.365 — virtual containers have no element; verified via their contents
    const ref = n?.ref; if (typeof ref !== 'string') return;
    const r = results[ref] = results[ref] || {};
    if (!selectors[ref]) { r.resolved = null; r.note = 'no selector (iframe-bound or not picked)'; }
    else {
      const els = qn(ref); const el = els[0] || null;
      r.resolved = !!el; r.count = els.length;
      if (el) {
        try { const bb = el.getBoundingClientRect(); r.rect = { x: Math.round(bb.x), y: Math.round(bb.y), w: Math.round(bb.width), h: Math.round(bb.height) }; } catch { /* */ }
        r.text = ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder'))) || el.textContent || '').trim().slice(0, 60);
      }
      const m = n.multiplicity || 'one';
      if (el) {
        if (m === 'one')        r.multiplicity = els.length === 1 ? 'ok' : 'mismatch';
        else if (m === 'many')  r.multiplicity = els.length > 1 ? 'ok' : 'too-few';
        else if (m === 'optional') r.multiplicity = els.length <= 1 ? 'ok' : 'too-many';
        else                    r.multiplicity = 'skip';   // conditional
        if (parentRef) {
          const pel = q1(parentRef);
          r.containment = !pel ? 'parent-missing'
            : pel.contains(el) ? 'ok'
            : isLogicallyContained(pel, el) ? 'ok-portaled'
            : 'detached';   // resolves but no DOM/ARIA link — likely portaled; SOFT, never a hard fail
        }
      }
    }
  };
  const walk = (nodes, parentRef) => {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      checkNode(n, parentRef);
      if (Array.isArray(n.contains)) walk(n.contains, n.ref);
    }
  };

  // 1) Snapshot trigger targets' visibility BEFORE poking (for the reveal diff).
  const sources = [];
  const collect = (nodes) => { for (const n of Array.isArray(nodes) ? nodes : []) { if (Array.isArray(n?.triggers) && n.triggers.length) sources.push(n); if (Array.isArray(n?.contains)) collect(n.contains); } };
  collect(tree);
  const before = {};
  for (const n of sources) { before[n.ref] = {}; for (const t of n.triggers) before[n.ref][t] = visible(q1(t)); }

  // 2) Poke each safe trigger source, then diff its targets.
  for (const n of sources) {
    const r = results[n.ref] = results[n.ref] || {};
    r.triggers = {};
    const src = q1(n.ref);
    if (!src)                { for (const t of n.triggers) r.triggers[t] = 'no-source'; continue; }
    if (!isSafeToClick(src)) { for (const t of n.triggers) r.triggers[t] = 'unsafe-to-poke'; continue; }
    try { src.click(); } catch { /* ignore */ }
    await sleep(450);
    for (const t of n.triggers) {
      const after = visible(q1(t));
      if (!before[n.ref][t] && after)      r.triggers[t] = 'verified';        // hidden → shown
      else if (before[n.ref][t] && after)  r.triggers[t] = 'already-present';  // can't demonstrate reveal
      else                                 r.triggers[t] = 'no-change';        // claimed reveal didn't happen
    }
  }

  // 3) Static check AFTER poking — conditional menus/options now exist in the
  //    DOM (or portaled into it), so resolution/multiplicity/containment see
  //    the revealed structure rather than the closed state.
  walk(tree, null);
  return { success: true, results };
}

// ─── Page structure exploration (v2.74.367) ────────────────────────────────
// Depth discovery for a fresh page. The propose-perspectives author only ever
// sees ONE static snapshot, so anything that exists only AFTER an interaction
// (a dropdown's menu, a modal's sections, a tab panel) is invisible to it. This
// sweep enumerates disclosure controls (things that reveal hidden content when
// activated), SAFELY pokes each, observes what becomes visible, then RESTORES
// the page so the next poke starts clean. The result is a `pageStructure`
// artifact: a depth-1 map of the page that downstream propose can use to author
// depth-aware roles/landmarks for post-interaction content.
//
// SAFETY: only pokes controls that don't navigate/submit (mirrors the verify
// poke guard) and aborts the whole sweep if a click navigates. NOTE: NO
// screenshots here — the background captures fresh at propose-time; this
// returns text + geometry only. `payload.plan` (Phase 3) may pre-select which
// candidate selectors to poke; absent → poke all candidates up to `maxPokes`.
async function explorePageStructure(payload) {
  const opts = (payload && typeof payload === 'object') ? payload : {};
  // v2.74.377 — NO BUDGET by default: poke every candidate. A positive maxPokes
  // caps it (clamped to 1000 as a runaway guard); null/0/absent = unlimited.
  const maxPokes = (Number.isFinite(opts.maxPokes) && opts.maxPokes > 0) ? Math.min(1000, opts.maxPokes) : Infinity;
  const settleMs = Number.isFinite(opts.settleMs) ? Math.max(120, Math.min(1200, opts.settleMs)) : 420;
  // Phase 3 hook: an ARRAY (even empty) means "poke only these selectors" — an
  // empty plan = the planner judged nothing worth poking, so poke nothing.
  // Absent/null means "poke all candidates" (the unplanned/fallback path).
  const planSet  = Array.isArray(opts.plan) ? new Set(opts.plan) : null;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const INTERACTIVE_SEL = 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="combobox"],[role="switch"],[contenteditable="true"],summary';
  // v2.74.374 — BROAD NET. Candidacy is recall, not affordance-recognition:
  // gate on "safe + plausibly interactive", let the vision planner do precision
  // and poke→observe decide truth. Recognizing chevrons by class/icon/size was
  // brittle (and dead on obfuscated/hashed-class sites — exactly the hard ones),
  // so those signals are now PLANNER HINTS only, never a pass/fail gate.
  const CANDIDATE_SEL = INTERACTIVE_SEL +
    ',[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="treeitem"]' +
    ',[aria-expanded],[aria-haspopup],[aria-controls]' +
    ',[data-toggle],[data-bs-toggle],[data-state],[data-dropdown],[data-headlessui-state],[data-radix-collection-item]' +
    ',[tabindex]:not([tabindex="-1"])' +
    ',[class*="dropdown" i],[class*="chevron" i],[class*="caret" i],[class*="accordion" i],[class*="expand" i],[class*="disclosure" i],[class*="toggle" i],[class*="trigger" i],[class*="popover" i],[class*="flyout" i]';
  // v2.74.369 — what counts as a "reveal": interactive elements PLUS overlay /
  // panel containers (a menu/dialog/tabpanel of non-interactive content reveals
  // structure even with no buttons inside).
  const REVEAL_SEL = INTERACTIVE_SEL + ',[role="menu"],[role="menubar"],[role="listbox"],[role="dialog"],[role="tooltip"],[role="tabpanel"],[role="region"],[role="grid"],[role="tree"],[role="group"]';
  const ICON_HINT = /(chevron|caret|arrow|angle|triangle|expand|collapse|disclos|dropdown|kebab|ellipsis|hamburger|\bmore\b|\bmenu\b)/i;
  const ARROW_GLYPH = /[▲▼▴▾◀▶∨⌄⌃˅˄ˇ﹀]/;   // ▲▼▴▾◀▶ ∨ ⌄⌃ ˅˄ ˇ ﹀

  const visible = (el) => { if (!el) return false; try { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; } catch { return false; } };
  const accName = (el) => { try { return (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80); } catch { return ''; } };
  const roleOf  = (el) => { try { return el.getAttribute('role') || el.tagName.toLowerCase(); } catch { return '?'; } };
  const rectOf  = (el) => { try { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; } catch { return null; } };
  // Nearby text helps the planner identify an icon-only control ("the chevron
  // next to 'Sort by'") and is shown in the artifact for diagnostics.
  const nearbyText = (el) => {
    try {
      const a = accName(el); if (a) return a;
      const lbl = el.closest('[aria-label]'); if (lbl && lbl !== el) return (lbl.getAttribute('aria-label') || '').trim().slice(0, 60);
      const par = el.parentElement; if (par) { const pt = (par.textContent || '').trim().replace(/\s+/g, ' '); if (pt && pt.length <= 60) return pt; }
      return '';
    } catch { return ''; }
  };

  // Never poke things that navigate or submit (mirror verifyStructure guard).
  // v2.74.370 — also refuse anything that is, or lives inside, a real link:
  // poking nav links is what was transitioning the page mid-sweep.
  // v2.74.604 — auth/account/menu triggers are very often <a href="/login"> that open a MODAL via JS
  // (preventDefault), NOT a real navigation — yet the categorical link exclusion below skipped them, so
  // a login modal's email/password fields were never poked/revealed/captured and "sign in" couldn't be
  // grounded. Allow a LINK to be a poke candidate when it carries a disclosure signal (aria-haspopup/
  // expanded/controls, role=button, data-toggle) OR an auth/account label. If it DOES navigate, the
  // explore nav-guard + ensureOnPage recovery handle it — same as any accidental navigation.
  // EX-1 (v2.74.845) — DESTRUCTIVE label lexicon (a mirror + extension of Services/DiscoveryService.DANGEROUS_LINK_TEXT;
  // a classic content script can't import it). The poke sweep must NEVER ACTIVATE a control that mutates server/session
  // state — delete a resource, log the user out, empty a cart, fire an irreversible commit or a purchase — while running
  // UNATTENDED in a live session. Verb-led + word-boundaried so safe controls survive (a bare "Cancel" dismiss or a
  // "Remove filter" chip is NOT vetoed — only the irreversible verbs + the destructive phrasings).
  const DESTRUCTIVE_LABEL = /\b(delete|deactivate|destroy|unsubscribe|publish|withdraw|log\s?out|sign\s?out|logout)\b|\b(empty|clear)\s+(cart|basket)\b|\b(cancel|close|delete|deactivate|remove)\s+(account|order|subscription|plan|membership|payment|profile)\b|\b(place|confirm)\s+(order|payment|purchase)\b|\b(buy|checkout|pay)\b/i;
  const AUTH_TRIGGER = /\b(sign[\s-]?in|log[\s-]?in|log[\s-]?on|sign[\s-]?up|signup|login|register|join|create[\s-]?account|my[\s-]?account|account)\b/i;
  const isDisclosureLink = (el) => {
    try {
      return el.matches('[aria-haspopup], [aria-expanded], [aria-controls], [role="button"], [data-toggle], [data-bs-toggle], [data-state], [data-headlessui-state]')
          || AUTH_TRIGGER.test(accName(el) || '');
    } catch { return false; }
  };
  const isSafeToClick = (el) => {
    if (!el) return false;
    try {
      // EX-1 — SEMANTIC destructive veto, FIRST. A "Log out" / "Delete account" / "Empty cart" / "Buy" control must
      // never be activated by the unattended sweep, however it's marked up (a destructive BUTTON otherwise reaches the
      // generic button allowance below and gets poked). Runs BEFORE the disclosure/auth allowances so a destructive
      // label can't benefit from the auth/disclosure opt-in (closes the AUTH_TRIGGER hole for "log out"/"close account").
      if (DESTRUCTIVE_LABEL.test(accName(el) || '')) return false;
      if (el.matches('[type="submit"], input[type="submit"], button[type="submit"]')) return false;   // commits a form
      const linkish = el.matches('a[href], [role="link"], [target="_blank"]');
      const discLink = linkish && isDisclosureLink(el);
      if (linkish && !discLink) return false;                                                      // plain nav link → skip
      if (!discLink && el.closest('a[href], [role="link"]')) return false;                         // chevron inside a nav link → skip
      if (el.closest('form') && el.matches('button:not([type]), input[type="image"]')) return false;   // default-submit
      if (discLink) return true;                                                                    // auth/disclosure link → poke (modal opener)
      if (el.matches('button:not([type="submit"]), [role="button"], summary, [aria-haspopup], [aria-expanded], [aria-controls], [role="combobox"], [role="tab"], [role="menuitem"], [data-toggle], [data-bs-toggle], [data-state]')) return true;
      return getComputedStyle(el).cursor === 'pointer';
    } catch { return false; }
  };
  // v2.74.374 — Pure CLASSIFICATION, not gating. Describes WHY an element looks
  // interactive so the planner (which also sees the screenshot) can prioritize.
  // Never returns null: an element that passed the safe+interactive gate but
  // matches no specific affordance is still a candidate — hint 'clickable'.
  const candidateHint = (el) => {
    try {
      if (el.getAttribute('aria-expanded') != null) return 'aria-expanded';
      if (el.getAttribute('aria-haspopup'))          return 'haspopup';
      if (el.getAttribute('aria-controls'))          return 'aria-controls';
      if (el.matches('summary'))                     return 'details';
      if (el.matches('[role="tab"]'))                return 'tab';
      if (el.matches('[role="combobox"]'))           return 'combobox';
      if (el.matches('[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]')) return 'menuitem';
      if (el.matches('[data-toggle],[data-bs-toggle],[data-state],[data-dropdown],[data-headlessui-state]')) return 'data-toggle';
      const txt = (el.textContent || '').trim();
      if (txt.length <= 4 && ARROW_GLYPH.test(txt)) return 'arrow-glyph';
      const icon = el.querySelector('svg, use, i[class], [class*="icon" i]');
      if (icon) {
        let sc = '';
        try { sc = `${icon.getAttribute('class') || ''} ${icon.getAttribute('href') || icon.getAttribute('xlink:href') || ''} ${(icon.querySelector && icon.querySelector('use')?.getAttribute('href')) || ''}`; } catch { /* */ }
        if (ICON_HINT.test(sc)) return 'icon';
        if (txt.length <= 2) return 'icon-only';
        if (txt.length <= 24 && el.matches('button, [role="button"], summary, [role="tab"]')) return 'labeled-icon';
      }
      if (ICON_HINT.test(`${el.className || ''} ${accName(el)} ${el.id || ''}`)) return 'keyword';
      return 'clickable';
    } catch { return 'clickable'; }
  };
  // The ONE structural exclusion that survives: a large element that WRAPS a
  // link or image is CONTENT (a result/product card), not a control. Poking it
  // is wasted budget (and navigation is independently blocked anyway).
  const looksLikeContentTile = (el) => {
    try { const r = el.getBoundingClientRect(); if (r.height > 120 && (el.querySelector('a[href]') || el.querySelector('img'))) return true; } catch { /* */ }
    return false;
  };
  // Candidacy = recall: safe to click, plausibly interactive, not a content
  // tile. Precision is the planner's job; truth is poke→observe's.
  const isDisclosureCandidate = (el) => isSafeToClick(el) && !looksLikeContentTile(el);

  // v2.74.369/374 — open a control with a full pointer+mouse+click sequence
  // (many dropdown/menu libraries fire on pointerdown/mousedown, not click),
  // PRECEDED by hover events (mega-menus / nav dropdowns open on mouseover, not
  // click — without this they'd never reveal).
  const PE = (typeof PointerEvent === 'function') ? PointerEvent : MouseEvent;
  const fire = (el, Ctor, type, init) => { try { el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, button: 0, ...init })); } catch { /* */ } };
  const pokeOpen = (el) => {
    try { el.scrollIntoView?.({ block: 'center', inline: 'nearest' }); } catch { /* */ }
    fire(el, PE, 'pointerover', { pointerId: 1, isPrimary: true });
    fire(el, MouseEvent, 'mouseover', {});
    fire(el, PE, 'pointerenter', { pointerId: 1, isPrimary: true });
    fire(el, MouseEvent, 'mouseenter', {});
    try { el.focus?.({ preventScroll: true }); } catch { /* */ }
    fire(el, PE, 'pointerdown', { pointerId: 1, isPrimary: true });
    fire(el, MouseEvent, 'mousedown', {});
    fire(el, PE, 'pointerup', { pointerId: 1, isPrimary: true });
    fire(el, MouseEvent, 'mouseup', {});
    try { el.click(); } catch { /* */ }
  };

  // v2.74.375/376 — close machinery. A poke that opens a MODAL (login, etc.) is
  // a valid reveal, but re-clicking the opener doesn't dismiss a modal and a
  // document-level Escape is often ignored by a focus-trapped dialog. So we
  // close deliberately: click the close affordance (× / "Close") found among the
  // revealed nodes or in the overlay host, else Escape on the FOCUSED element
  // (modal-bound listeners) + host + document, else click the backdrop.
  const isCloseControl = (el) => {
    try {
      if (el.matches('[aria-label*="close" i],[aria-label*="dismiss" i],[title*="close" i],[data-dismiss],[data-close],[class*="modal-close" i],[class*="dialog-close" i],button[class*="close" i]')) return true;
      const t = (el.textContent || '').trim();
      return (t === '×' || t === '✕' || t === '✖' || t === '⨯' || /^(close|dismiss)$/i.test(t)) && el.matches('button, [role="button"], a');
    } catch { return false; }
  };
  const findCloseControl = (scope) => {
    try {
      const root = scope || document;
      const found = [];
      try { for (const b of root.querySelectorAll('button, [role="button"], a, [aria-label], [data-dismiss], [data-close]')) { if (isCloseControl(b)) found.push(b); } } catch { /* */ }
      return found.find(b => { try { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } }) || null;
    } catch { return null; }
  };
  // v2.74.376 — is a revealed thing an OVERLAY (modal/dropdown that covers
  // content and must be CLOSED) vs an IN-PLACE reveal (carousel advance, tab
  // panel, accordion — leave it, that's the depth we wanted)? Overlay = a
  // dialog/menu role, or a positioned (fixed/absolute) ancestor stack.
  const isOverlayEl = (el) => {
    try {
      if (el.matches('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],[role="listbox"],[role="tooltip"]')) return true;
      // A true covering overlay is position:fixed (modals) or absolute with a
      // high stacking order (dropdowns/portals). Carousels use absolute with a
      // LOW z-index within a relative track — exclude them (the z>10 gate), so
      // advancing a carousel isn't mistaken for an overlay that needs closing.
      let n = el, hops = 0;
      while (n && n !== document.body && hops < 6) {
        const cs = getComputedStyle(n);
        if (cs.position === 'fixed') return true;
        if (cs.position === 'absolute' && (parseInt(cs.zIndex, 10) || 0) > 10) return true;
        n = n.parentElement; hops++;
      }
    } catch { /* */ }
    return false;
  };
  const isOverlayReveal = (novel) => novel.some(isOverlayEl);
  const overlayHostOf = (novel) => {
    for (const el of novel) { try { const h = el.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],[role="listbox"],[class*="modal" i],[class*="dialog" i],[class*="popup" i],[class*="overlay" i]'); if (h) return h; } catch { /* */ } }
    return novel.length ? (novel[0].parentElement || null) : null;
  };

  // v2.74.370 — extensive, structured logging. Each line is pushed to `log`
  // (returned in the artifact + mirrored to the background SW console) AND
  // console.debug'd into the page console with a clear prefix.
  const log = [];
  const dbg = (msg, extra) => {
    const line = (extra !== undefined) ? `${msg} ${typeof extra === 'object' ? JSON.stringify(extra) : extra}` : msg;
    if (log.length < 400) log.push(line);
    try { console.debug('[AHuB explore]', line); } catch { /* */ }
  };

  // v2.74.370 — Navigation guard. Poking a misclassified nav control must NOT
  // leave / re-route the page mid-sweep. We (a) preventDefault anchor clicks in
  // capture phase (the JS handler still runs, so a menu still opens — only the
  // browser navigation is cancelled), and (b) no-op history.pushState/
  // replaceState so SPA routers can't change the route. Both undone in finally.
  let navAttempts = 0;
  const onCaptureClick = (e) => { try { if (e.target?.closest?.('a[href]')) { e.preventDefault(); navAttempts++; dbg('nav-guard: blocked anchor click'); } } catch { /* */ } };
  const onBeforeUnload = () => { navAttempts++; dbg('nav-guard: beforeunload fired (real navigation in progress)'); };
  const _origPush = history.pushState, _origReplace = history.replaceState;
  const _origOpen = window.open, _origAssign = window.location.assign, _origReplaceLoc = window.location.replace;
  const installGuard = () => {
    try { document.addEventListener('click', onCaptureClick, true); } catch { /* */ }
    try { window.addEventListener('beforeunload', onBeforeUnload, true); } catch { /* */ }
    try { history.pushState = function () { navAttempts++; dbg('nav-guard: blocked history.pushState'); return undefined; }; } catch { /* */ }
    try { history.replaceState = function () { navAttempts++; dbg('nav-guard: blocked history.replaceState'); return undefined; }; } catch { /* */ }
    try { window.open = function () { navAttempts++; dbg('nav-guard: blocked window.open'); return null; }; } catch { /* */ }
    try { window.location.assign = function () { navAttempts++; dbg('nav-guard: blocked location.assign'); }; } catch { /* */ }
    try { window.location.replace = function () { navAttempts++; dbg('nav-guard: blocked location.replace'); }; } catch { /* */ }
  };
  const removeGuard = () => {
    try { document.removeEventListener('click', onCaptureClick, true); } catch { /* */ }
    try { window.removeEventListener('beforeunload', onBeforeUnload, true); } catch { /* */ }
    try { history.pushState = _origPush; } catch { /* */ }
    try { history.replaceState = _origReplace; } catch { /* */ }
    try { window.open = _origOpen; } catch { /* */ }
    try { window.location.assign = _origAssign; } catch { /* */ }
    try { window.location.replace = _origReplaceLoc; } catch { /* */ }
  };

  // v2.74.378 — BANDED WALK. The sweep is split into phases the BACKGROUND
  // orchestrates (it alone can screenshot between steps): metrics → for each
  // viewport band bottom-to-top { band(enumerate visible) → [bg: screenshot +
  // LLM plan] → poke(planned) } → cleanup. Per-band planning (piecemeal, with a
  // screenshot that matches what's in view) replaces the brittle one-shot plan,
  // and the planner only poking what it chose is what keeps the sweep from
  // navigating.
  const findOpenOverlays = () => {
    const out = [];
    try {
      for (const el of document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="popup" i],[class*="lightbox" i]')) {
        if (!visible(el)) continue;
        try { const r = el.getBoundingClientRect(); if (r.width * r.height < 50000) continue; } catch { continue; }
        out.push(el);
      }
    } catch { /* */ }
    return out;
  };
  const closeOverlays = async (passes) => {
    for (let p = 0; p < passes; p++) {
      const open = findOpenOverlays();
      if (!open.length) break;
      dbg('cleanup: closing overlay(s)', { count: open.length });
      for (const d of open) { const c = findCloseControl(d); if (c) { try { c.click(); } catch { /* */ } } }
      for (const t of [document.activeElement, document].filter(Boolean)) { try { t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch { /* */ } }
      let bd = null; try { bd = document.querySelector('[class*="backdrop" i], [class*="overlay" i], [class*="scrim" i], [data-backdrop]'); } catch { /* */ }
      if (bd && visible(bd)) { try { bd.click(); } catch { /* */ } }
      await sleep(170);
    }
  };

  const phase = opts.phase || 'metrics';
  dbg(`phase ${phase}`, { url: location.href, top: (window.top === window.self), scrollY: window.scrollY });

  // PHASE metrics — scroll to the bottom (triggering lazy content) and report
  // the page height so the background can compute the band stops.
  if (phase === 'metrics') {
    // v2.74.567 — remember the entry scroll BEFORE scrolling, so cleanup can return
    // the page to where the user left it. Capture BOTH the window AND inner scroll
    // containers: BambooHR (and many SPA forms) scroll an overflow:auto DIV, not the
    // window — window.scrollTo is then a no-op, so the poke phase's scrollIntoView
    // moves an inner container that only a container-level reset can restore.
    try {
      const containers = [];
      for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0 || el.scrollLeft > 0) containers.push({ el, top: el.scrollTop, left: el.scrollLeft }); }
      window.__ahubEntryScroll = { x: window.scrollX || 0, y: window.scrollY || 0, containers };
    } catch { /* */ }
    const vh = window.innerHeight || 800; let lastH = -1, steps = 0;
    for (let i = 1; i <= 16; i++) {
      try { window.scrollTo(0, i * Math.round(vh * 0.9)); } catch { /* */ }
      await sleep(220); steps++;
      const docH = (() => { try { return document.documentElement.scrollHeight; } catch { return 0; } })();
      if ((window.scrollY + vh) >= docH - 4) break;
      if (docH === lastH && i >= 3) break;
      lastH = docH;
    }
    const scrollHeight = (() => { try { return document.documentElement.scrollHeight; } catch { return vh; } })();
    dbg('metrics', { scrollHeight, vh, steps });
    return { success: true, phase, scrollHeight, viewportH: vh, viewportW: window.innerWidth, scrollY: window.scrollY, url: location.href, title: document.title || '', log };
  }

  // PHASE band — scroll to scrollY and enumerate the candidates + surface that
  // are VISIBLE in this viewport band (no poking). The background screenshots
  // this band and asks the planner which to poke.
  if (phase === 'band') {
    const y = Number.isFinite(opts.scrollY) ? opts.scrollY : window.scrollY;
    try { window.scrollTo(0, y); } catch { /* */ }
    await sleep(Number.isFinite(opts.settleScroll) ? opts.settleScroll : 280);
    // v2.74.380 — TRUE viewport gate. visible() passes for off-screen-but-
    // rendered elements (their rect still has size), so without this every band
    // enumerated the whole page (85 candidates each) and the screenshot didn't
    // match the list. inViewport limits to what's actually on screen in THIS band.
    const vpH = window.innerHeight || 800, vpW = window.innerWidth || 1200;
    const sx = window.scrollX || 0, sy = window.scrollY || 0;
    const inViewport = (el) => { try { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < vpH && r.right > 0 && r.left < vpW; } catch { return false; } };
    const absRect = (el) => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } };
    const candidates = []; const seen = new Set(); const selSeen = new Set();
    try {
      for (const el of document.querySelectorAll(CANDIDATE_SEL)) {
        if (seen.has(el)) continue; seen.add(el);
        if (!visible(el) || !inViewport(el) || !isDisclosureCandidate(el)) continue;
        const selector = computeUniqueSelector(el);
        if (!selector || selSeen.has(selector)) continue;   // drop non-unique / duplicate selectors (e.g. stateful .active)
        selSeen.add(selector);
        candidates.push({ selector, role: roleOf(el), label: accName(el), context: nearbyText(el), hint: candidateHint(el), rect: rectOf(el), expanded: el.getAttribute('aria-expanded'), haspopup: el.getAttribute('aria-haspopup'), safe: isSafeToClick(el) });
      }
    } catch { /* */ }
    const surface = [];
    try { for (const el of document.querySelectorAll(INTERACTIVE_SEL)) { if (visible(el) && inViewport(el) && surface.length < 200) surface.push({ role: roleOf(el), label: accName(el), rect: absRect(el) }); } } catch { /* */ }
    dbg('band', { scrollY: window.scrollY, candidates: candidates.length, surface: surface.length });
    return { success: true, phase, scrollY: window.scrollY, viewportH: window.innerHeight, url: location.href, title: document.title || '', candidates, surface, log };
  }

  // PHASE cleanup — close any leftover overlay, return scroll to the ENTRY position.
  if (phase === 'cleanup') {
    installGuard();
    try { await closeOverlays(3); } finally { removeGuard(); }
    // v2.74.567 — restore the entry scroll. The poke phase's scrollIntoView scrolls
    // whatever the real scroller is — often an inner overflow DIV, not the window
    // (which is why a plain window.scrollTo "never happened" visibly). So: reset
    // every element scrolled during the sweep back to the top, then re-apply the
    // window + any container scroll recorded at entry. Two passes (read all, then
    // write) to avoid per-element layout thrash. Falls back to top if entry was
    // never recorded (e.g. content script re-injected after a navigation recovery).
    try {
      const s = window.__ahubEntryScroll || {};
      const scrolled = [];
      try { for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0 || el.scrollLeft > 0) scrolled.push(el); } } catch { /* */ }
      for (const el of scrolled) { try { el.scrollTop = 0; el.scrollLeft = 0; } catch { /* */ } }
      try { window.scrollTo(s.x || 0, s.y || 0); } catch { /* */ }
      for (const c of (s.containers || [])) { try { if (c.el && c.el.isConnected) { c.el.scrollTop = c.top; c.el.scrollLeft = c.left; } } catch { /* */ } }
    } catch { /* */ }
    await sleep(80);
    return { success: true, phase, navAttempts, log };
  }

  // PHASE poke — poke the planned selectors for this band (resolve each, scroll
  // into view), observe the reveal, restore overlays. The page is mutated here,
  // so the nav guard is installed for the duration.
  const selectors = Array.isArray(opts.selectors) ? opts.selectors : [];
  const controls = [];
  let controlsTried = 0, controlsRevealing = 0, totalRevealed = 0, cidN = Number.isFinite(opts.cidStart) ? opts.cidStart : 0, aborted = null;
  installGuard();
  try {
  for (const _selector of selectors) {
    let src = null; try { src = document.querySelector(_selector); } catch { /* */ }
    if (!src) { dbg('poke skip (no match)', { selector: String(_selector).slice(0, 80) }); continue; }
    try { src.scrollIntoView?.({ block: 'center', inline: 'nearest' }); } catch { /* */ }
    await sleep(60);
    if (controlsTried >= maxPokes) break;
    if (!visible(src)) continue;                                   // a prior poke may have hidden it
    const selector = computeUniqueSelector(src);
    if (planSet && !planSet.has(selector)) continue;               // Phase 3: only poke planned controls
    const safe = isSafeToClick(src);
    const ctl = {
      cid: `c${cidN++}`, selector, role: roleOf(src), label: accName(src), hint: candidateHint(src), rect: rectOf(src),
      expanded: src.getAttribute('aria-expanded'), haspopup: src.getAttribute('aria-haspopup'),
      revealed: [], revealCount: 0, observation: safe ? null : 'unsafe', restored: null,
    };
    if (!safe) { dbg('skip (unsafe)', { cid: ctl.cid, hint: ctl.hint, label: ctl.label.slice(0, 40) }); controls.push(ctl); continue; }
    controlsTried++;
    dbg('poke', { cid: ctl.cid, hint: ctl.hint, role: ctl.role, label: ctl.label.slice(0, 40), selector: selector.slice(0, 80) });

    // Per-control baseline over the WIDER reveal selector (interactive +
    // menu/dialog/panel containers), so a revealed panel of non-interactive
    // content still registers.
    const beforeSet = new Set();
    try { for (const el of document.querySelectorAll(REVEAL_SEL)) if (visible(el)) beforeSet.add(el); } catch { /* */ }
    const expandedBefore = src.getAttribute('aria-expanded');
    const naBefore = navAttempts;
    const urlBefore = location.href;
    pokeOpen(src);                                                 // full pointer+mouse+click sequence
    await sleep(settleMs);
    // A real navigation slipped past the guard (e.g. window.location =) — the
    // page is leaving; stop the whole sweep. A BLOCKED nav (guard caught it) is
    // not a hard stop: the menu may still have opened, so keep going.
    if (location.href !== urlBefore) {
      ctl.observation = 'navigation'; aborted = 'navigation';
      dbg('ABORT — real navigation', { cid: ctl.cid, from: urlBefore.slice(0, 80), to: location.href.slice(0, 80) });
      controls.push(ctl); break;
    }
    const navBlocked = navAttempts > naBefore;

    let afterEls = [];
    try { afterEls = Array.from(document.querySelectorAll(REVEAL_SEL)); } catch { afterEls = []; }
    const novel = [];
    for (const el of afterEls) { if (beforeSet.has(el)) continue; if (!visible(el)) continue; novel.push(el); }
    const expandedAfter = src.getAttribute('aria-expanded');
    const ariaOpened = expandedBefore === 'false' && expandedAfter === 'true';
    // v2.74.561 — DESTRUCTIVE-SWAP guard (Part 2). A benign reveal only ADDS
    // content; a full-view swap (an SPA toggle between "Application form" and "Job
    // description", a tab that replaces the page body) also REMOVES the content
    // the user was on — and it's INVISIBLE to the URL/submit nav guard because
    // nothing actually navigates. Measure how much of the pre-poke visible
    // interactive surface VANISHED: a large drop means the poke threw away the
    // entry state. That's NOT depth to fold in (it belongs to a different view),
    // so discard it, mark the control, and try to reverse the swap.
    let vanished = 0;
    for (const el of beforeSet) { if (!visible(el)) vanished++; }
    // STRUCTURAL signal (not semantic) — "did most of the visible interactive surface
    // disappear" is measured, not judged, so it stays in capture (DESIGN §4.6). The
    // threshold is a tuning constant, not a per-site rule.
    const swapAway = beforeSet.size >= 6 && (vanished / beforeSet.size) >= 0.6;
    ctl.vanished = vanished;
    if (swapAway) {
      ctl.revealed = []; ctl.revealCount = 0;   // swapped-in nodes belong to another view — not depth
      ctl.observation = 'destructive-swap';
      // Reverse the swap so Explore RETURNS THE PAGE TO WHERE IT STARTED. The view
      // toggle RE-RENDERS (unmounts the form, mounts the description, and vice
      // versa), so the entry elements are REPLACED by fresh nodes. Two consequences
      // we must respect: (a) verify restoration by the COUNT of rendered
      // interactive elements, NOT by old-element identity (the old refs stay
      // detached, which previously false-negatived AND triggered an extra click
      // that toggled the view right back); (b) re-query the toggle FRESH each time
      // — its reference (and even its class selector) changes across the swap.
      const entryCount = beforeSet.size;
      const visCount = () => { let n = 0; try { for (const el of document.querySelectorAll(REVEAL_SEL)) if (visible(el)) n++; } catch { /* */ } return n; };
      const restored = () => visCount() >= 0.8 * entryCount;
      const reFindToggle = () => {
        // The same control we already poked (vetted safe). Prefer selector identity;
        // fall back to the position it occupied (toggles are page chrome — the
        // content below them swaps, so they stay put).
        for (const s of [_selector, selector]) { let t = null; try { t = s && document.querySelector(s); } catch { /* */ } if (t && visible(t)) return t; }
        try {
          const cx = ctl.rect && (ctl.rect.x + ctl.rect.w / 2), cy = ctl.rect && (ctl.rect.y + ctl.rect.h / 2);
          if (Number.isFinite(cx) && Number.isFinite(cy)) {
            const at = document.elementFromPoint(cx, cy);
            const btn = at && at.closest && at.closest('button,[role="button"],summary');
            if (btn && visible(btn) && isSafeToClick(btn)) return btn;
          }
        } catch { /* */ }
        return null;
      };
      let back = false;
      try {
        // (1) Re-click the SAME toggle (a 2-state view toggle flips back). Count
        //     check → if the entry view returned, we're DONE (don't touch anything
        //     else — that's what previously toggled it back off).
        const t = reFindToggle();
        if (t) { try { t.click(); } catch { /* */ } await sleep(settleMs); }
        back = restored();
        // (2) Segmented toggle (separate "back" control, e.g. an "Apply" that
        //     re-shows the form): click a safe sibling, re-check by COUNT after
        //     each, stop the instant the entry view returns. isSafeToClick excludes
        //     submits, so this never submits the form.
        if (!back) {
          let container = null;
          try { const anchor = reFindToggle() || src; container = anchor && (anchor.closest('[class*="actions" i],[role="group"],[role="tablist"],[role="toolbar"]') || anchor.parentElement); } catch { /* */ }
          let sibs = []; try { sibs = container ? Array.from(container.querySelectorAll('button,[role="button"],summary')).slice(0, 6) : []; } catch { /* */ }
          for (const sib of sibs) {
            if (!visible(sib) || !isSafeToClick(sib)) continue;
            try { sib.click(); } catch { /* */ } await sleep(settleMs);
            if (restored()) { back = true; break; }
          }
        }
      } catch { /* */ }
      ctl.restored = back;
      dbg(back ? 'destructive-swap reversed (entry view restored)' : 'destructive-swap NOT reversed (relying on enumerate-first)', { cid: ctl.cid, vanished, entryCount, nowCount: visCount() });
      controls.push(ctl);
      continue;   // skip the additive-reveal restore path below
    }
    for (const el of novel.slice(0, 40)) ctl.revealed.push({ selector: computeUniqueSelector(el), role: roleOf(el), label: accName(el), rect: rectOf(el) });
    ctl.revealCount = novel.length;
    // aria-expanded flipping true is itself evidence the control disclosed,
    // even when the revealed nodes are off-DOM-diff (e.g. CSS-only expansion).
    ctl.observation = (novel.length > 0 || ariaOpened) ? 'reveal' : (navBlocked ? 'navigation-blocked' : 'no-change');
    if (ctl.navBlocked = navBlocked) { /* recorded */ }
    if (ctl.observation === 'reveal') { controlsRevealing++; totalRevealed += novel.length; }
    dbg('observe', { cid: ctl.cid, observation: ctl.observation, revealCount: novel.length, ariaOpened, navBlocked });

    // Restore — ONLY for OVERLAY reveals (modals, dropdowns that cover the
    // page). An IN-PLACE reveal — carousel advance, tab-panel switch, accordion
    // expand — is the depth we wanted; leave it (re-clicking a tab/arrow won't
    // "undo" it anyway), so it doesn't count as a restore failure.
    const overlay = ctl.observation === 'reveal' && isOverlayReveal(novel);
    ctl.overlay = overlay;
    if (!overlay) {
      ctl.restored = true;   // nothing to restore for in-place reveals
    } else try {
      const stillOpen = () => novel.some(el => visible(el));
      // 1) genuine TOGGLE → re-click to close (dropdowns, accordions, summary).
      if (stillOpen() && visible(src) && isSafeToClick(src)
          && (expandedAfter === 'true' || src.matches('[aria-haspopup], summary, [role="tab"], [data-state]'))) {
        try { src.click(); } catch { /* */ } await sleep(140);
      }
      // 2) Click a CLOSE affordance — first among the revealed nodes themselves
      //    (the × is usually a revealed button), then within the overlay host.
      if (stillOpen()) {
        let close = novel.find(el => { try { return visible(el) && isCloseControl(el); } catch { return false; } }) || null;
        if (!close) { const host = overlayHostOf(novel); if (host) close = findCloseControl(host); }
        if (close) { try { close.click(); } catch { /* */ } await sleep(160); }
      }
      // 3) Escape — on the FOCUSED element (modal-bound listener) + host + document.
      if (stillOpen()) {
        for (const t of [document.activeElement, overlayHostOf(novel), document].filter(Boolean)) {
          try { t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch { /* */ }
        }
        fire(src, MouseEvent, 'mouseout', {}); fire(src, MouseEvent, 'mouseleave', {});   // close hover menus
        await sleep(150);
      }
      // 4) Backdrop/overlay click — last resort for backdrop-dismiss modals.
      if (stillOpen()) {
        let bd = null; try { bd = document.querySelector('[class*="backdrop" i], [class*="overlay" i], [class*="scrim" i], [data-backdrop]'); } catch { /* */ }
        if (bd && visible(bd)) { try { bd.click(); } catch { /* */ } await sleep(130); }
      }
      ctl.restored = !stillOpen();
    } catch { ctl.restored = false; }
    if (overlay && !ctl.restored) dbg('restore failed (overlay left open)', { cid: ctl.cid });

    controls.push(ctl);
    if (aborted === 'navigation') break;   // page is leaving — stop this band
  }
  await closeOverlays(2);   // close any overlay opened in this band before returning
  } finally { removeGuard(); }
  dbg('poke band done', { poked: controls.length, controlsRevealing, totalRevealed, aborted, navAttempts });
  return { success: true, phase, controls, controlsRevealing, totalRevealed, aborted, navAttempts, viewport: { w: window.innerWidth, h: window.innerHeight }, log };
}

// v2.74.381 — Reveal-aware resolve helpers (standalone; the explore phases'
// close machinery is function-local, so these duplicate the minimal logic).

// Poke a trigger (modal/menu opener) and return a rich DOM snapshot of the
// REVEALED state, leaving it OPEN so the caller can resolve + verify against it.
async function pokeAndSnapshot(payload) {
  const sel = payload && payload.selector;
  if (!sel) return { success: false, error: 'selector required' };
  let el = null; try { el = document.querySelector(sel); } catch { /* */ }
  if (!el) return { success: false, error: 'trigger not found on page' };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const REVEAL_SEL = 'a[href],button,input,select,textarea,[role="button"],[role="menuitem"],[role="option"],[role="tab"],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[aria-modal="true"]';
  const vis = (x) => { try { const r = x.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(x); return cs.visibility !== 'hidden' && cs.display !== 'none'; } catch { return false; } };
  const before = new Set(); try { for (const x of document.querySelectorAll(REVEAL_SEL)) if (vis(x)) before.add(x); } catch { /* */ }
  const urlBefore = location.href;
  const PE = (typeof PointerEvent === 'function') ? PointerEvent : MouseEvent;
  const fire = (t, Ctor, type, init) => { try { t.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, button: 0, ...init })); } catch { /* */ } };
  try { el.scrollIntoView?.({ block: 'center', inline: 'nearest' }); } catch { /* */ }
  fire(el, PE, 'pointerover', { pointerId: 1, isPrimary: true }); fire(el, MouseEvent, 'mouseover', {});
  fire(el, PE, 'pointerenter', { pointerId: 1, isPrimary: true }); fire(el, MouseEvent, 'mouseenter', {});
  try { el.focus?.({ preventScroll: true }); } catch { /* */ }
  fire(el, PE, 'pointerdown', { pointerId: 1, isPrimary: true }); fire(el, MouseEvent, 'mousedown', {});
  fire(el, PE, 'pointerup', { pointerId: 1, isPrimary: true }); fire(el, MouseEvent, 'mouseup', {});
  try { el.click(); } catch { /* */ }
  // v2.74.388 — Poll until the reveal STABILIZES, not just appears. A modal
  // renders its container/backdrop first (1 element) then fills in the form/
  // buttons over a few frames; capturing on first-appearance grabs a half-built
  // modal and the child roles fail. So wait until the count of newly-visible
  // elements stops growing for 2 consecutive polls, then a final settle, before
  // snapshotting. Up to ~3.4s; minimum a couple polls so we don't capture early.
  const countNovel = () => { let n = 0; try { for (const x of document.querySelectorAll(REVEAL_SEL)) { if (!before.has(x) && vis(x)) n++; } } catch { /* */ } return n; };
  let opened = 0, lastN = -1, stable = 0;
  for (let i = 0; i < 17; i++) {
    await sleep(200);
    if (location.href !== urlBefore) return { success: true, navigated: true, opened: 0, url: location.href, title: document.title || '', snapshot: '' };
    const n = countNovel();
    opened = n;
    if (n > 0 && n === lastN) { stable++; if (stable >= 2) break; }   // count held steady → fully rendered
    else stable = 0;
    lastN = n;
  }
  await sleep(300);   // final settle (late images/icons in the revealed layer)
  opened = countNovel();
  let s = {};
  // v2.74.395 — includeContentBlocks: revealed layers (mega-menus, modals) can
  // also hold repeating content blocks the hidden content roles need.
  try { s = handleDomSnapshotRich([], { includeContentBlocks: true }) || {}; } catch (e) { return { success: false, error: `snapshot failed: ${e.message}` }; }
  return { success: true, opened, url: s.url ?? location.href, title: s.title ?? document.title ?? '', snapshot: s.snapshot ?? '' };
}

// v2.74.396 — Resolve Tier-2 VISUAL pick. Given a NORMALIZED box (screenshot /
// viewport space, top-left origin) proposed by the vision model, find the on-page
// element whose REAL rect best matches it (max IoU), then synthesize a selector +
// a11y profile + rect — a picker-shaped result the sidepanel feeds into the
// Pick→Claude refine. Mirrors a human pick, but the "where" comes from an LLM
// region instead of a click. Robust to pixel slop: we score real element rects by
// IoU rather than trusting a single elementFromPoint hit, and we let a card's
// container out-score its inner image/label.
async function locatePick(payload) {
  const box = payload && payload.box;
  if (!box || !['x1', 'y1', 'x2', 'y2'].every(k => typeof box[k] === 'number')) return { success: false, error: 'box required' };
  const vw = window.innerWidth, vh = window.innerHeight;
  const B = { x: box.x1 * vw, y: box.y1 * vh, w: Math.max(1, (box.x2 - box.x1) * vw), h: Math.max(1, (box.y2 - box.y1) * vh) };
  const boxArea = B.w * B.h;
  const iou = (r) => {
    const ix1 = Math.max(B.x, r.left), iy1 = Math.max(B.y, r.top);
    const ix2 = Math.min(B.x + B.w, r.right), iy2 = Math.min(B.y + B.h, r.bottom);
    const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    if (inter <= 0) return 0;
    const uni = boxArea + (r.width * r.height) - inter;
    return uni > 0 ? inter / uni : 0;
  };
  // Candidate set: elements under a grid of sample points in the box, plus their
  // ancestors a few levels up (so the card container competes with the inner hit).
  const cand = new Set();
  const addWithAncestors = (el) => {
    let n = el, depth = 0;
    while (n && n.nodeType === 1 && depth < 5 && n !== document.body && n !== document.documentElement) { cand.add(n); n = n.parentElement; depth++; }
  };
  const GX = 3, GY = 3;
  for (let i = 0; i <= GX; i++) {
    for (let j = 0; j <= GY; j++) {
      const px = B.x + (B.w * i / GX), py = B.y + (B.h * j / GY);
      if (px < 0 || py < 0 || px > vw || py > vh) continue;
      let stack = [];
      try { stack = document.elementsFromPoint(px, py) || []; } catch { stack = []; }
      for (const el of stack.slice(0, 4)) addWithAncestors(el);
    }
  }
  let best = null, bestIoU = 0;
  for (const el of cand) {
    let r; try { r = el.getBoundingClientRect(); } catch { continue; }
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.width * r.height > boxArea * 2.5) continue;   // skip giant wrappers that engulf the box
    const score = iou(r);
    if (score > bestIoU) { bestIoU = score; best = el; }
  }
  if (!best || bestIoU < 0.2) return { success: false, error: `no element matched the located region (best IoU ${bestIoU.toFixed(2)})` };
  let selector = null;
  try { selector = synthesizeSelector(best, document); } catch { selector = null; }
  if (!selector) { try { selector = _synthesizeSelectorForElement(best); } catch { /* */ } }
  if (!selector) return { success: false, error: 'could not synthesize a selector for the located element' };
  let accessibilityProfile = null;
  try { accessibilityProfile = await _computeAccessibilityProfile(best); } catch { /* */ }
  let matchedCount = 1;
  try { matchedCount = document.querySelectorAll(selector).length; } catch { /* */ }
  const rect = best.getBoundingClientRect();
  return {
    success: true, selector, iou: bestIoU, matchedCount,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    accessibilityProfile,
    viewportInfo: { dpr: window.devicePixelRatio || 1, innerWidth: vw, innerHeight: vh },
    frame: (typeof __pickerFrameInfo === 'function' ? __pickerFrameInfo() : null),
  };
}

// Close any visible, sizable overlay (modal/dialog): close-control → Escape →
// backdrop, up to 3 passes.
async function closeOpenOverlays() {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const vis = (el) => { try { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; } catch { return false; } };
  const isClose = (el) => { try { if (el.matches('[aria-label*="close" i],[aria-label*="dismiss" i],[title*="close" i],[data-dismiss],[data-close],[class*="modal-close" i],[class*="dialog-close" i],button[class*="close" i]')) return true; const t = (el.textContent || '').trim(); return (t === '×' || t === '✕' || t === '✖' || t === '⨯' || /^(close|dismiss)$/i.test(t)) && el.matches('button,[role="button"],a'); } catch { return false; } };
  const findClose = (root) => { try { for (const b of (root || document).querySelectorAll('button,[role="button"],a,[aria-label],[data-dismiss],[data-close]')) { if (isClose(b) && vis(b)) return b; } } catch { /* */ } return null; };
  const openOverlays = () => { const out = []; try { for (const el of document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="popup" i],[class*="lightbox" i]')) { if (!vis(el)) continue; try { const r = el.getBoundingClientRect(); if (r.width * r.height < 50000) continue; } catch { continue; } out.push(el); } } catch { /* */ } return out; };
  let closed = 0;
  for (let p = 0; p < 3; p++) {
    const open = openOverlays();
    if (!open.length) break;
    for (const d of open) { const c = findClose(d); if (c) { try { c.click(); closed++; } catch { /* */ } } }
    for (const t of [document.activeElement, document].filter(Boolean)) { try { t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch { /* */ } }
    let bd = null; try { bd = document.querySelector('[class*="backdrop" i],[class*="overlay" i],[class*="scrim" i],[data-backdrop]'); } catch { /* */ }
    if (bd && vis(bd)) { try { bd.click(); } catch { /* */ } }
    await sleep(160);
  }
  return { success: true, closed, remaining: openOverlays().length };
}

// ─── OBS-1: demonstration recorder ──────────────────────────────────────────
// Open-capture mode for Path 3 (observed perspectives). While a record session is active, capture-phase
// listeners observe the user's REAL interactions and post each (with the acted element's identity) to the
// background, which buffers the trace. Reuses the existing identity helpers (computeUniqueSelector /
// _computeA11yRole / _computeAccessibleName / _computeHierarchicalContext). Sensitive values NEVER leave the
// page — a local gate redacts password/payment fields before sending. Pure scrub/classify lives in
// Core/observedTrace.js (the background applies it); this side only extracts DOM identity.
var _obsRec = { active: false };
var _OBS_SENSITIVE = /pass(word|code)|(^|[^a-z])pin([^a-z]|$)|\bssn\b|social.?security|credit.?card|card.?number|(^|[^a-z])cc-?(num|number|csc|cvv|cvc)|security.?code|\bcvv\b|\bcvc\b|account.?number|routing.?number/i;

// OBS-3b — the element IS live when the user acts, so capture a rich identity HERE (the demonstration can't
// be re-profiled later — it spans pages). rect/text/attributes populate the durable Landmark record so it
// isn't a bare selector (the NL path fills these via post-accept live profiling; the observed path can't).
function _obsExtract(el) {
  const out = { tagName: el.tagName || null, role: null, accessibleName: null, selector: null, hierarchicalContext: null,
    name: null, type: null, autocomplete: null, inputType: null, rect: null, text: null, attrs: null };
  try { out.selector = computeUniqueSelector(el); } catch { /* */ }
  try { out.role = _computeA11yRole(el); } catch { /* */ }
  try { out.accessibleName = _computeAccessibleName(el); } catch { /* */ }
  try { out.hierarchicalContext = _computeHierarchicalContext(el); } catch { /* */ }
  try { out.name = el.getAttribute('name') || null; } catch { /* */ }
  try { out.type = el.getAttribute('type') || null; out.inputType = el.type || null; } catch { /* */ }
  try { out.autocomplete = el.getAttribute('autocomplete') || null; } catch { /* */ }
  try { const r = el.getBoundingClientRect(); if (r && (r.width || r.height)) out.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch { /* */ }
  try { const tx = (el.textContent || '').replace(/\s+/g, ' ').trim(); if (tx) out.text = tx.slice(0, 140); } catch { /* */ }
  try { const a = {}; for (const k of ['type', 'placeholder', 'href', 'data-testid', 'data-test-id', 'title', 'aria-label', 'value']) { const v = el.getAttribute && el.getAttribute(k); if (v) a[k] = String(v).slice(0, 140); } if (Object.keys(a).length) out.attrs = a; } catch { /* */ }
  return out;
}
function _obsResolveClickTarget(el) {
  if (!el || el === document || el === document.documentElement || el === document.body) return null;
  try { return el.closest('a[href],button,[role="button"],[role="option"],[role="menuitem"],[role="menuitemradio"],[role="tab"],[role="radio"],[role="checkbox"],[role="switch"],input,select,textarea,summary,[role]') || el; }
  catch { return el; }
}
// ORCH-V — when an OPTION is chosen, capture the dropdown's whole VOCABULARY (the labels the user could have
// picked), not just the one clicked. This closed set makes re-choosing safe: the binder classifies an ask
// against real labels (no hallucinated value) and replay's CLICK_BY_LABEL is guaranteed to find one. Native
// <select> → its <option>s; a custom listbox/menu → the option-like descendants of the tightest container.
function _obsOptionVocabulary(domKind, el, target) {
  try {
    if ((domKind === 'change' || domKind === 'input') && el.tagName === 'SELECT') {
      const opts = Array.from(el.options || []).map((o) => (o.label || o.textContent || o.value || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      return opts.length ? Array.from(new Set(opts)).slice(0, 60).map((s) => s.slice(0, 80)) : null;
    }
    if (domKind === 'click') {
      const _lbl = (n) => { let t = ''; try { t = _computeAccessibleName(n) || n.textContent || ''; } catch { t = n.textContent || ''; } return String(t).replace(/\s+/g, ' ').trim(); };
      const OPT = '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="radio"]';
      let role = ''; try { role = String(_computeA11yRole(el) || '').toLowerCase(); } catch { /* */ }
      const isOpt = /^(option|menuitem|menuitemradio|menuitemcheckbox|radio)$/.test(role) || (el.matches && el.matches(OPT));
      // B-DIAG — attach a small diagnostic so the background log shows WHY a category click did/didn't become a
      // re-bindable CATEGORY group (role, classification, the container climb). Lets us fix the heuristic precisely.
      const diag = { role, tag: el.tagName, href: !!(el.getAttribute && el.getAttribute('href')), isOpt, isNav: false, levels: [], captured: 0 };
      if (target) target.navDiag = diag;
      if (isOpt) {
        // Climb to the SMALLEST ancestor holding ≥2 option-like descendants (the dropdown container).
        let container = el.parentElement, found = null;
        for (let i = 0; i < 6 && container; i++) {
          const sibs = container.querySelectorAll(OPT);
          if (sibs.length >= 2) { found = sibs; break; }
          container = container.parentElement;
        }
        if (!found) { diag.reason = 'option: no ≥2 group'; return null; }
        const labels = Array.from(found).map(_lbl).filter(Boolean);
        const out = labels.length ? Array.from(new Set(labels)).slice(0, 60).map((s) => s.slice(0, 80)) : null;
        diag.via = 'option'; diag.captured = out ? out.length : 0;
        return out;
      }
      // B — a category/tab NAV item (a link or tab that switches a view). Capture its PEER GROUP — the small set
      // of sibling links/tabs in the tightest enclosing nav — so the demo's category click becomes a re-bindable
      // CATEGORY option (one "search by category" instead of one capability per category). Conservative: only
      // links/tabs, peers must be short labels (≤30 chars), and the group must be 3–18 (a category set, not a
      // result list). The clicked item's own label is in the set (it matches the selector), so it stays bindable.
      const isNavItem = role === 'tab' || role === 'link' || (el.tagName === 'A' && el.getAttribute && el.getAttribute('href'));
      diag.isNav = isNavItem;
      if (isNavItem) {
        const NAV = 'a[href],[role="tab"],[role="link"],button,[role="button"]';
        let c = el.parentElement;
        for (let i = 0; i < 6 && c; i++) {
          const uniq = Array.from(new Set(Array.from(c.querySelectorAll(NAV)).map(_lbl).filter((t) => t && t.length <= 30)));
          diag.levels.push({ tag: c.tagName + (c.id ? `#${c.id}` : ''), n: uniq.length });
          if (uniq.length >= 3 && uniq.length <= 18) {
            try { if (target && c) target.optionContainer = computeUniqueSelector(c); } catch { /* */ }   // B — the nav container, so CLICK_BY_LABEL re-binds across the whole set
            diag.via = 'nav'; diag.captured = uniq.length; diag.sample = uniq.slice(0, 10);
            return uniq.slice(0, 18).map((s) => s.slice(0, 80));
          }
          c = c.parentElement;
        }
        diag.reason = 'nav: no 3–18 group in 6 levels';
      } else {
        diag.reason = `not a nav item (role=${role || '∅'})`;
      }
      return null;
    }
  } catch { /* */ }
  return null;
}
// OBS pre-nav buffer — a click/Enter that NAVIGATES loses its in-flight INTERACTION_RECORD when the page unloads
// (the worker stays alive via the keepalive, but the unloading page still drops the message — this is why the
// category click vanished from the trace). Persist navigating actions to sessionStorage SYNCHRONOUSLY (it
// survives a same-origin navigation); the next page flushes them on re-arm. The background dedups by `uid`, so a
// live-delivered action and its buffered copy never double-count.
var _obsClientSeq = 0;
var _obsFrameSalt = Math.random().toString(36).slice(2, 8);   // v2.74.955 (CR-H5) — two frames share seq ranges AND can stamp the same Date.now(); the salt keeps cross-frame uids collision-free
var _OBS_BUF_KEY = '__ahub_obs_navbuf';
function _obsBufferAction(payload) {
  try { const buf = JSON.parse(sessionStorage.getItem(_OBS_BUF_KEY) || '[]'); buf.push(payload); sessionStorage.setItem(_OBS_BUF_KEY, JSON.stringify(buf.slice(-50))); } catch { /* */ }
}
function _obsFlushBuffer() {
  try {
    const raw = sessionStorage.getItem(_OBS_BUF_KEY);
    if (!raw) return;
    sessionStorage.removeItem(_OBS_BUF_KEY);
    for (const p of (JSON.parse(raw) || [])) { try { chrome.runtime.sendMessage({ type: 'INTERACTION_RECORD', payload: p }); } catch { /* */ } }
  } catch { /* */ }
}
// v2.74.1528/1530 — the RESULTS-LIST container + ROW text for a search-result click. Climbs from the clicked
// element to the nearest REPEATING ROW ancestor — a list-item tag/role (li / tr / [role=row|option]) with ≥3
// same-tag siblings, OR (v1530) any element whose full CLASS signature repeats across ≥3 siblings (VendorSuite's
// `div.pointer-select` rows). Bigger than the 3–18 option group _obsOptionVocabulary captures, which EXCLUDES
// result lists. Returns the list container's selector + the row's text, so the OBS param path can content-address
// the row (CLICK_BY_LABEL {searchValue}) instead of its fragile position. null → no capture, no change. The
// class-signature (not bare tag) requirement keeps a generic <div> grid from over-capturing.
function _obsResultListContainer(el) {
  try {
    let row = el;
    for (let i = 0; i < 6 && row && row !== document.body && row !== document.documentElement; i++) {
      const p = row.parentElement;
      if (!p) break;
      const tag = row.tagName;
      let role = ''; try { role = String((row.getAttribute && row.getAttribute('role')) || '').toLowerCase(); } catch { /* */ }
      const cls = (typeof row.className === 'string') ? row.className.trim() : '';
      // A REPEATING row: a list-item TAG/ROLE (li/tr/row/option) with ≥3 same-tag siblings, OR — the VendorSuite
      // case (v2.74.1530) — a DIV/other whose full CLASS signature repeats across ≥3 siblings (result rows are
      // `div.flex.align-center.justify-between.pointer-select`, NOT <li>; v1528's li-only gate skipped them, so the
      // result-row click stayed positional `:nth-of-type(72)`). Class-signature match keeps a generic <div> grid safe.
      const isListItem = tag === 'LI' || tag === 'TR' || role === 'row' || role === 'option';
      const repeating = isListItem
        ? Array.from(p.children).filter((c) => c.tagName === tag).length >= 3
        : (!!cls && Array.from(p.children).filter((c) => c.tagName === tag && typeof c.className === 'string' && c.className.trim() === cls).length >= 3);
      if (repeating) {
        let rowText = ''; try { rowText = (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200); } catch { /* */ }
        let container = null; try { container = computeUniqueSelector(p); } catch { /* */ }
        if (container) return { container, rowText };
      }
      row = p;
    }
  } catch { /* */ }
  return null;
}
// v2.74.1534 — a VendorSuite DIVISION-menu selection. The demo click lands on whatever span the user happens to hit
// inside the row — usually the VENDOR span "DEAKO INC (ALL DIVISIONS)", the SAME text in every row — at a fragile
// position (li:nth-of-type(72) > span:nth-of-type(2)), so the taught walk only ever re-selected the demonstrated
// division. Instead capture the DIVISION NAME (the row's `span.medium`, e.g. "Raleigh - 495") + the menu container,
// so the OBS param path lifts it into a CLICK_BY_LABEL {division} scoped to #divisionMenu — parameterized by the
// case/ask division at replay, not the demonstrated row. `#divisionMenu` is a stable id; the names are the vocabulary
// (needed only to trip the ≥3-option generalization — replay matches the LIVE menu, so a 60-cap can't break it).
function _obsDivisionSelect(el) {
  try {
    const menu = el.closest && el.closest('#divisionMenu');
    if (!menu) return null;
    const row = (el.closest && (el.closest('li[data-value]') || el.closest('li'))) || null;
    if (!row) return null;
    const nameEl = row.querySelector('span.medium') || row.querySelector('span');
    const name = ((nameEl && nameEl.textContent) || '').replace(/\s+/g, ' ').trim();
    if (!name) return null;
    const container = menu.id ? `#${menu.id}` : '#divisionMenu';
    const vocab = Array.from(new Set(
      Array.from(menu.querySelectorAll('li span.medium'))
        .map((s) => (s.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    )).slice(0, 200);
    return { container, name, vocab: vocab.length >= 3 ? vocab : [name, name, name] };
  } catch { return null; }
}
function _obsSend(domKind, el, rawValue) {
  if (!_obsRec.active || !el) return;
  const target = _obsExtract(el);
  const sensitive = String(target.inputType || target.type || '').toLowerCase() === 'password'
    || _OBS_SENSITIVE.test([target.name, target.id, target.accessibleName, target.autocomplete].filter(Boolean).join(' '));
  let value = null;
  if (domKind === 'input' || domKind === 'change') value = sensitive ? null : (rawValue != null ? String(rawValue).slice(0, 300) : null);
  else if (domKind === 'click') value = sensitive ? null : (target.accessibleName || null);   // used only if it classifies as a select
  else if (domKind === 'keypress') value = rawValue || 'Enter';                                 // the key (Enter)
  // v2.74.1534 — DIVISION-menu select wins over the generic option/result capture: override the value with the row's
  // division NAME and mark the menu container, so it generalizes to CLICK_BY_LABEL {division} (not a positional click).
  const _divSel = (!sensitive && domKind === 'click') ? _obsDivisionSelect(el) : null;
  if (_divSel) { value = _divSel.name; target.optionContainer = _divSel.container; target.options = _divSel.vocab; }
  else if (!sensitive) { const vocab = _obsOptionVocabulary(domKind, el, target); if (vocab && vocab.length > 1) target.options = vocab; }   // ORCH-V — dropdown vocabulary (+B nav container)
  // v2.74.1528 — a search-RESULT row click (a row in a repeating list, NOT a 3–18 option group) → capture the LIST
  // container + ROW text so the OBS param path content-addresses the row instead of its position (li:nth-of-type(72)).
  if (!sensitive && domKind === 'click' && !(target.options && target.options.length > 1)) {
    try { const rc = _obsResultListContainer(el); if (rc && rc.container) { target.resultContainer = rc.container; if (rc.rowText) target.rowText = rc.rowText; } } catch { /* */ }
  }
  const payload = { domKind, target, value, sensitive, ts: Date.now(), url: location.href, uid: `${_obsFrameSalt}-${_obsClientSeq++}-${Date.now()}` };
  if (domKind === 'click' || domKind === 'keypress') _obsBufferAction(payload);   // navigating-prone → survive a page unload
  try { chrome.runtime.sendMessage({ type: 'INTERACTION_RECORD', payload }); } catch { /* */ }
  // OBS — after an unambiguous commit (Enter, native submit, or a commit-named button) that may swap results in
  // place, watch for the SPA boundary so an XHR filter/search is segmented and gets an in-place postcondition.
  if (domKind === 'keypress' || domKind === 'submit' || (domKind === 'click' && _obsIsCommitClick(el, target))) _obsArmSwapWatch();
}
var _obsOnClick  = (e) => { try { const el = _obsResolveClickTarget(e.target); if (el) _obsSend('click', el, null); } catch { /* */ } };
var _obsOnInput  = (e) => { try { const el = e.target; const tag = el && el.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') _obsSend(tag === 'SELECT' ? 'change' : 'input', el, el.value); } catch { /* */ } };
var _obsOnSubmit = (e) => { try { if (e.target) _obsSend('submit', e.target, null); } catch { /* */ } };
// OBS — capture ENTER in a field (submit-via-keyboard). Many sites handle Enter with a key listener and
// never fire a native `submit`, so the search would otherwise go unrecorded. Only Enter on a text field /
// contenteditable (typing is captured via input; buttons get a click); it replays as a KEY action.
var _obsOnKey = (e) => {
  try {
    if (e.key !== 'Enter' || e.isComposing) return;
    const el = e.target; const tag = el && el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) _obsSend('keypress', el, 'Enter');
  } catch { /* */ }
};
// OBS-4 — debounced SCROLL capture (not every pixel): record where the viewport settled, so a demonstration
// that scrolls (to read or reach content) is visible in the trace. Replay reaches elements via SCROLL_TO
// normalizers, so this is for trace fidelity, not pixel-replay.
var _obsScrollT = null;
var _obsOnScroll = () => {
  if (!_obsRec.active) return;
  if (_obsScrollT) clearTimeout(_obsScrollT);
  _obsScrollT = setTimeout(() => {
    try { chrome.runtime.sendMessage({ type: 'INTERACTION_RECORD', payload: { domKind: 'scroll', target: { scrollY: Math.round(window.scrollY || 0) }, ts: Date.now(), url: location.href } }); } catch { /* */ }
  }, 450);
};
// OBS (v2.74.763) — IN-PLACE (SPA) boundary detector. A search/filter that commits via XHR (no navigation) still
// changes the page state — that IS the logical Fragment boundary (the SPA half of the page-state-change rule).
// After a commit-prone action that does NOT navigate, watch the DOM settle and emit ONE `state_change` marker
// carrying the swapped-in container's selector, so the segmenter splits here and the persisted Fragment gets a
// `selector_present` postcondition (the in-place analog of url_matches). Conservative: armed only for unambiguous
// commits (Enter / native submit / a commit-named button), fires only on a SIGNIFICANT swap, and bails if a
// navigation happened first (the nav boundary already split there).
var _obsSwapObs = null, _obsSwapSettleT = null, _obsSwapCapT = null, _obsSwapUrl = '', _obsSwapAdds = null;
var _OBS_SWAP_MIN_NODES = 5;   // a results swap adds many nodes; a spinner / class-toggle / focus ring does not
function _obsArmSwapWatch() {
  if (!_obsRec.active || typeof MutationObserver !== 'function' || !document.body) return;
  _obsDisarmSwapWatch();
  _obsSwapUrl = location.href;
  _obsSwapAdds = new Map();   // candidate container element → count of added descendant elements
  try {
    _obsSwapObs = new MutationObserver((records) => {
      for (const r of records) {
        if (!r.addedNodes) continue;
        for (const n of r.addedNodes) {
          if (!n || n.nodeType !== 1) continue;
          const host = (r.target && r.target.nodeType === 1) ? r.target : (n.parentElement || null);
          if (!host || host === document.documentElement || host === document.body) continue;
          const cnt = 1 + (n.querySelectorAll ? n.querySelectorAll('*').length : 0);
          _obsSwapAdds.set(host, (_obsSwapAdds.get(host) || 0) + cnt);
        }
      }
      if (_obsSwapSettleT) clearTimeout(_obsSwapSettleT);
      _obsSwapSettleT = setTimeout(_obsFireSwap, 500);   // settle: mutations stopped for 500ms
    });
    _obsSwapObs.observe(document.body, { childList: true, subtree: true });
    _obsSwapCapT = setTimeout(_obsFireSwap, 3000);       // hard cap: fire with whatever accumulated
  } catch { _obsDisarmSwapWatch(); }
}
function _obsFireSwap() {
  const adds = _obsSwapAdds, armedUrl = _obsSwapUrl;
  _obsDisarmSwapWatch();
  if (!_obsRec.active || !adds) return;
  if (location.href !== armedUrl) return;   // a navigation already split here → not an in-place boundary
  let best = null, bestCnt = 0;
  for (const [el, cnt] of adds) { if (cnt > bestCnt && el && el.isConnected) { best = el; bestCnt = cnt; } }
  if (!best || bestCnt < _OBS_SWAP_MIN_NODES) return;   // trivial mutation, not a content swap
  // b5b (v2.74.767) — capture the swapped-in region's full IDENTITY (role + accessibleName + text + selector via
  // _obsExtract), not just its selector, so the accept can mint a RECOVERABLE outcome landmark (probe-or-recover
  // by role+name) instead of a selector-only one. Falls back to selector-only when the container has no a11y role/
  // name (a bare results <div>), which is still better than nothing.
  let target = null; try { target = _obsExtract(best); } catch { /* */ }
  if (!target || !target.selector) return;
  try { chrome.runtime.sendMessage({ type: 'INTERACTION_RECORD', payload: { domKind: 'state_change', target, ts: Date.now(), url: location.href } }); } catch { /* */ }
}
function _obsDisarmSwapWatch() {
  if (_obsSwapSettleT) { clearTimeout(_obsSwapSettleT); _obsSwapSettleT = null; }
  if (_obsSwapCapT) { clearTimeout(_obsSwapCapT); _obsSwapCapT = null; }
  if (_obsSwapObs) { try { _obsSwapObs.disconnect(); } catch { /* */ } _obsSwapObs = null; }
  _obsSwapAdds = null; _obsSwapUrl = '';
}
// A click is a COMMIT (worth watching for an in-place swap) when it's a submit-typed control or a button whose
// label reads like "search / apply / update / filter / show results …". This keeps dropdown-open and option
// clicks (which add option nodes and would otherwise look like a swap) from minting spurious boundaries.
function _obsIsCommitClick(el, target) {
  try {
    const type = String((target && target.type) || '').toLowerCase();
    if (type === 'submit') return true;
    const role = String((target && target.role) || '').toLowerCase();
    const tag = String((el && el.tagName) || '');
    const isButton = role === 'button' || tag === 'BUTTON' || (tag === 'INPUT' && /^(submit|button)$/.test(type))
      || !!(el && el.closest && el.closest('button,[role="button"],[type="submit"]'));
    if (!isButton) return false;
    const name = String((target && (target.accessibleName || target.text)) || '').toLowerCase();
    return /\b(search|appl(y|ied)|update|filter|go|done|save|submit|results|find|refine)\b/.test(name);
  } catch { return false; }
}
function _obsStart() {
  if (_obsRec.active) return;
  _obsRec = { active: true };
  _obsFlushBuffer();   // deliver any navigating actions buffered on the PREVIOUS page before it navigated here
  document.addEventListener('click', _obsOnClick, true);
  document.addEventListener('input', _obsOnInput, true);
  document.addEventListener('change', _obsOnInput, true);
  document.addEventListener('submit', _obsOnSubmit, true);
  document.addEventListener('keydown', _obsOnKey, true);
  window.addEventListener('scroll', _obsOnScroll, { capture: true, passive: true });
}
function _obsStop() {
  _obsRec.active = false;
  try { sessionStorage.removeItem(_OBS_BUF_KEY); } catch { /* */ }   // don't leak a buffer into a later session
  if (_obsScrollT) { clearTimeout(_obsScrollT); _obsScrollT = null; }
  _obsDisarmSwapWatch();   // tear down any pending in-place swap watcher
  document.removeEventListener('click', _obsOnClick, true);
  document.removeEventListener('input', _obsOnInput, true);
  document.removeEventListener('change', _obsOnInput, true);
  document.removeEventListener('submit', _obsOnSubmit, true);
  document.removeEventListener('keydown', _obsOnKey, true);
  window.removeEventListener('scroll', _obsOnScroll, { capture: true });
}

// ─── Message router ───────────────────────────────────────────────────────────

// ── C2b (v2.74.859): interaction-monitoring capture (Track phase) ────────────────
// Demand-scoped, VALUE-FREE DOM capture. INERT until START_INTERACTION_CAPTURE — and the
// background gates THAT message on canTrack consent (C6). Mirrors Core/interactionCapture's
// DOM_EVENT_KIND + sensitivity (a classic content script can't import Core) — EXCEPT focusout/blur,
// which is DELIBERATELY uncaptured client-side (volume without usage signal; Core keeps the kind for
// other adapters). Core/mirrorSync.test.js pins exactly this contract (CR-I2, v2.74.926). NEVER reads
// a field's .value; a `type` carries inputType + a length DELTA only, withheld entirely for sensitive
// fields. Listeners are attached capture-phase + wrapped so a bug can never break the host page.
var _IM_EVENT_KIND = { click: 'click', auxclick: 'click', dblclick: 'dblclick', input: 'type', submit: 'submit', focusin: 'focus' };
var _imOn = false;
var _imTargets = [];
var _imAttached = false;
// v2.74.955 (CR-H5) — per-ELEMENT type-debounce timers. One shared timer meant fast field-to-field
// typing (<400ms) cancelled the first field's pending event entirely. WeakMap keys the timer by element;
// the companion Set tracks pending elements so detach can clear them (a WeakMap is not iterable).
var _imTypeTimers = new WeakMap();
var _imTypePending = new Set();
var _imLen = new WeakMap();
var _imListeners = {};

function _imSensitive(el) {
  try {
    if ((el.getAttribute('type') || '').toLowerCase() === 'password') return true;
    if (/\b(one-time-code|current-password|new-password|cc-number|cc-csc|cc-exp)\b/.test((el.getAttribute('autocomplete') || '').toLowerCase())) return true;
    if ((el.getAttribute('role') || '').toLowerCase() === 'password-input') return true;   // v2.74.926 (CR-I2) — Core's third rule, was missing client-side (the drift the sync test now pins)
  } catch { /* */ }
  return false;
}
function _imName(el) {
  try { return (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || (el.textContent || '')).trim().replace(/\s+/g, ' ').slice(0, 120); } catch { return ''; }
}
function _imDescriptor(el) {
  const d = { tagName: (el.tagName || '').toLowerCase() };
  try { if (el.id) d.id = String(el.id).slice(0, 64); } catch { /* */ }
  try { const cl = el.classList ? Array.from(el.classList).slice(0, 8) : []; if (cl.length) d.classList = cl; } catch { /* */ }
  try { const r = el.getAttribute('role'); if (r) d.role = String(r).slice(0, 40); } catch { /* */ }
  try { const ty = el.getAttribute('type'); if (ty) d.type = String(ty).toLowerCase(); } catch { /* */ }
  const n = _imName(el); if (n) d.accessibleName = n;
  return d;
}
// C3 — return ALL matching demand targets (a target may sit under >1 landmark → 'ambiguous').
// Each target carries the perspectiveId + role the START handler stamped, so the background L1
// resolver needs no per-event registry lookup.
// v2.74.865 — "capture all, then resolve": match by ELEMENT IDENTITY (the interacted element is
// within the landmark's selector), NOT by interaction kind. The demand's per-role interactionKinds
// are an expectation/annotation, not a resolution filter — gating on them made a click on a search
// box (textbox → expects focus/type) or a focus on a link (→ expects click) resolve to 'miss' even
// though the element IS a known landmark. raw.interactionKind still rides the event for the verb.
function _imMatchAll(target) {
  const out = [];
  for (const t of _imTargets) {
    if (!t || !t.selector) continue;
    let hit = null; try { hit = target.closest(t.selector); } catch { hit = null; }
    if (hit) out.push({ el: hit, t });
  }
  if (out.length <= 1) return out;
  // v2.74.871 — prefer the INNERMOST landmark. Every matched el is an ancestor-or-self of `target`,
  // so the matches lie on ONE containment chain; an outer match (its el contains another match's el)
  // is the less-specific CONTAINER. Drop containers so a nested pair (e.g. form-field inside a form
  // landmark) resolves to a single HIT instead of 'ambiguous'. Two landmarks on the SAME element
  // (genuine overlap — same el, different selectors) are kept → still 'ambiguous', which is correct.
  const innermost = out.filter((m) => !out.some((o) => o !== m && o.el !== m.el && m.el.contains(o.el)));
  return innermost.length ? innermost : out;
}
function _imMatchesPayload(hits) {
  return hits.map((h) => ({ landmarkUid: h.t.landmarkUid, perspectiveId: h.t.perspectiveId ?? null, role: h.t.role ?? null, selectorUsed: h.t.selector }));
}
function _imPost(payload) { try { chrome.runtime.sendMessage({ type: 'INTERACTION_RAW', payload }, () => void chrome.runtime.lastError); } catch { /* */ } }
function _imHandle(domType, evt) {
  if (!_imOn) return;
  const kind = _IM_EVENT_KIND[domType]; if (!kind) return;
  const el = evt.target; if (!el || el.nodeType !== 1 || typeof el.closest !== 'function') return;
  // GENERAL capture: EVERY interaction is captured (general intent); the demand match (if any) just
  // ANNOTATES which landmark(s) it hit — an empty match resolves to a 'miss', not a drop. The descriptor
  // describes the actual interacted element.
  const matches = _imMatchesPayload(_imMatchAll(el));
  if (kind === 'type') {
    const inputType = evt.inputType || '';   // capture primitives now; the event is recycled before the debounce fires
    const sensitive = _imSensitive(el);
    clearTimeout(_imTypeTimers.get(el));
    const _t = setTimeout(() => {
      _imTypeTimers.delete(el); _imTypePending.delete(el);
      const t = {}; if (inputType) t.inputType = inputType;
      if (!sensitive) { let len = 0; try { len = (el.value || '').length; } catch { len = 0; } const prev = _imLen.get(el) || 0; t.lengthDelta = len - prev; _imLen.set(el, len); }
      _imPost({ interactionKind: 'type', url: location.href, target: _imDescriptor(el), type: t, matches, sensitive });
    }, 400);
    _imTypeTimers.set(el, _t); _imTypePending.add(el);
    return;
  }
  const payload = { interactionKind: kind, url: location.href, target: _imDescriptor(el), matches };
  if (kind === 'click' || kind === 'dblclick') {
    const m = []; if (evt.shiftKey) m.push('shift'); if (evt.ctrlKey) m.push('ctrl'); if (evt.altKey) m.push('alt'); if (evt.metaKey) m.push('meta');
    payload.click = { button: evt.button || 0, clientX: Math.round(evt.clientX || 0), clientY: Math.round(evt.clientY || 0), modifiers: m };
  }
  _imPost(payload);
}
// v2.74.955 (CR-H5) — DELIBERATE top-frame-only scope: INTERACTION_MONITOR_START is delivered to
// frameId 0 (background sends without allFrames), so iframe interactions are not monitored. That is the
// intended privacy/noise posture — the substrate models the top document; embedded third-party frames
// (ads, widgets) would flood the demand matcher with foreign-origin landmarks.
function _imAttach() {
  if (_imAttached) return;
  for (const dt of ['click', 'auxclick', 'dblclick', 'input', 'submit', 'focusin']) {
    const fn = (e) => { try { _imHandle(dt, e); } catch { /* never break the page */ } };
    _imListeners[dt] = fn;
    try { document.addEventListener(dt, fn, true); } catch { /* */ }
  }
  _imAttached = true;
}
function _imDetach() {
  for (const dt of Object.keys(_imListeners)) { try { document.removeEventListener(dt, _imListeners[dt], true); } catch { /* */ } }
  _imAttached = false; for (const el of _imTypePending) clearTimeout(_imTypeTimers.get(el)); _imTypePending.clear();   // v2.74.955 (CR-H5)
}

// v2.74.954 (CR-X4a) — THE message router. The onMessage surface was ONE anonymous listener
// wrapping a ~2,066-line switch over ~65 message types (the file header named 6 of them). Each
// type is now a key in MESSAGE_HANDLERS — findable by name — and the listener is a six-line
// dispatcher. Handler bodies are BYTE-IDENTICAL to the old case bodies: each opens with the same
// `const { type, payload }` destructure the listener performed, block-style cases keep their own
// braces (block scoping preserved), and the return value keeps the sendResponse channel open
// exactly as the case's `return true` did. Unknown types return false (the old default).
var MESSAGE_HANDLERS = {

  'RECORD_START': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    _obsStart(); sendResponse({ success: true, active: true }); return false;
  },

  'RECORD_STOP': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    _obsStop();  sendResponse({ success: true, active: false }); return false;
  },


    // C2b — interaction-monitoring capture session (demand-scoped; background already consent-gated this START).
  'START_INTERACTION_CAPTURE': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        _imTargets = Array.isArray(payload?.targets) ? payload.targets : [];
        _imOn = true;                    // GENERAL capture: on regardless of demand-target count (targets are match hints)
        _imAttach();
        sendResponse({ success: true, on: _imOn, targets: _imTargets.length });
      } catch (e) { sendResponse({ success: false, error: e.message }); }
      return false;
    }
  },

  'STOP_INTERACTION_CAPTURE': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      _imOn = false; _imTargets = []; _imDetach();
      sendResponse({ success: true, on: false });
      return false;
    }
  },



    // v2.72.43 (Pass 17g iter) — readiness probe. Used by debugger's perspective
    // capture flow to verify the content script is reachable before sending
    // START_PICK / DOM_SNAPSHOT_FULL. Cheap; no side effects. Returns sync.
  'PING': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      sendResponse({ success: true, ready: true });
      return false;
    }
  },

  // GD-7e (v2.74.1330, DESIGN_canvas.md §8.7.1) — READ-ONLY page→source extraction for the source bank: the page's
  // title + main text (bounded) + its media inventory (https imgs above icon size; <video> srcs + youtube/vimeo
  // embeds as video links). No clicks, no mutation, no field values — the SW normalizes via Core/sourceBank
  // (https-only re-checked there; refs minted there). Sync; top frame only (like the monitor).
  'EXTRACT_SOURCE': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    try {
      const title = (document.title || '').slice(0, 200);
      let text = '';
      try {
        const main = document.querySelector('main, article, [role="main"]') || document.body;
        text = (main && main.innerText ? main.innerText : '').replace(/[ \t]+\n/g, '\n').slice(0, 8000);
      } catch { text = ''; }
      const images = [];
      try {
        for (const img of document.querySelectorAll('img')) {
          if (images.length >= 16) break;
          const src = img.currentSrc || img.src || '';
          if (!/^https:\/\//i.test(src)) continue;
          const w = img.naturalWidth || img.width || 0, h = img.naturalHeight || img.height || 0;
          if (w && h && (w < 80 || h < 80)) continue;                      // skip icons/trackers; unknown sizes pass
          images.push({ src: src.slice(0, 600), alt: (img.alt || '').slice(0, 120) });
        }
      } catch { /* */ }
      const videos = [];
      try {
        for (const v of document.querySelectorAll('video')) {
          if (videos.length >= 6) break;
          const s = v.currentSrc || v.src || (v.querySelector('source') && v.querySelector('source').src) || '';
          if (/^https:\/\//i.test(s)) videos.push({ src: s.slice(0, 600), label: (v.title || v.getAttribute('aria-label') || 'video').slice(0, 120) });
        }
        for (const f of document.querySelectorAll('iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"], iframe[src*="player.vimeo.com"]')) {
          if (videos.length >= 6) break;
          const s = f.src || '';
          if (/^https:\/\//i.test(s)) videos.push({ src: s.slice(0, 600), label: (f.title || 'video').slice(0, 120) });
        }
      } catch { /* */ }
      sendResponse({ success: true, page: { title, url: String(location.href).slice(0, 600), text, images, videos } });
    } catch (e) { sendResponse({ success: false, error: e.message }); }
    return false;
  },

  // CX-3 (session-ride) — perform a SAME-ORIGIN credentialed fetch from the page's own origin so the user's existing
  // login cookies ride (a background cross-site fetch would drop SameSite cookies). The URL is built background-side
  // from a vetted recipe (background/handlers/connector.js); read-only. Async → return true.
  'SESSION_FETCH': (message, _sender, sendResponse) => {
    const { payload } = message;
    (async () => {
      try {
        const url = (payload && typeof payload.url === 'string') ? payload.url : '';
        const method = String((payload && payload.method) || 'GET').toUpperCase();
        if (!url) { sendResponse({ success: false, error: 'session-fetch-no-url' }); return; }
        // CX-7 — the inline twin of Core/connectorRecipes.isReadOnlyGql (keep in lockstep): a GraphQL READ POST may
        // run unconfirmed ONLY when its FINAL body re-validates as a read-only document HERE (belt #2 never trusts
        // the background's flag alone — a mutation document always needs the write gate).
        const _readOnlyGql = (q) => { const s = String(q || '').trim(); if (!s || !/^(query\b|\{)/.test(s)) return false; const ns = s.replace(/"(?:[^"\\]|\\.)*"/g, ''); return !(/\bmutation\b/i.test(ns) || /\bsubscription\b/i.test(ns)); };
        let gqlReadOk = false;
        if (payload && payload.gqlRead === true && method === 'POST') {
          try { const b = (typeof payload.body === 'string') ? JSON.parse(payload.body) : payload.body; gqlReadOk = _readOnlyGql(b && b.query); } catch { gqlReadOk = false; }
        }
        // v2.74.1340 (review A) — SECOND write belt AT THE EXECUTION BOUNDARY: this handler used to run any non-GET
        // handed to it (the confirm belt lived only in INVOKE_SESSION). Now a write must carry the confirmed:true the
        // HITL gate stamped — a future/rogue background path that skips the first belt is refused HERE too.
        // v2.74.1941 — a DECLARED read may be a non-GET (UPS's reads are plain-JSON POSTs). Belt #2 cannot verify
        // that claim the way it verifies `gqlRead` — a GraphQL body describes itself, a JSON body does not — so be
        // explicit about what this costs: for a non-gql read the belt degrades from INDEPENDENT verification to
        // "belt #1 classified this, and said so in a field it had to set on purpose". That is still real
        // defence-in-depth against the case this belt was written for (a future background path that forgets the
        // gate entirely is refused, because it would set neither flag), and it is NOT protection against a path
        // that sets `readOnly` wrongly — which is the same exposure `confirmed` already has.
        // The alternative was worse: either every non-GET read stays unusable, or the background launders reads as
        // `confirmed:true`, which would destroy the word that means A HUMAN APPROVED THIS. Keeping the claims
        // distinct means the trace can still tell a human-approved write from a declared read.
        const declaredRead = !!(payload && payload.readOnly === true);
        if (method !== 'GET' && method !== 'HEAD' && !(payload && payload.confirmed === true) && !gqlReadOk && !declaredRead) {
          sendResponse({ success: false, error: 'write-needs-confirm' }); return;
        }
        const headers = Object.assign({ Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, (payload && payload.headers) || {});
        // v2.74.1955 — SOURCE THE CSRF TOKEN FROM THE COOKIE when the recipe declares one. Proven live
        // 2026-08-02 18:41 on www.ups.com/track: `X-XSRF-TOKEN-ST` is readable here, a POST carrying it returns
        // 200, and the identical POST with no token returns 401 — so 401 was "wrong/absent token", not headers
        // and not cookies. This runs ON the page, which is the only context that can read document.cookie.
        // It WINS over the sniffed header value deliberately: the sniffed one is a retained echo that may be
        // stale, or may belong to a different app on the same host (webapis.ups.com fronts /track and /ship under
        // separate key rings), whereas the cookie is current and named per-app. Falls through silently when the
        // cookie is absent (HttpOnly/path-scoped) so the sniffed token remains the fallback, not a hard failure.
        if (payload && payload.csrfCookie) {
          try {
            const _want = String(payload.csrfCookie);
            const _hit = document.cookie.split('; ').find((c) => c.slice(0, c.indexOf('=')) === _want);
            const _val = _hit ? _hit.slice(_hit.indexOf('=') + 1) : '';
            if (_val) headers[String(payload.csrfHeader || 'x-csrf-token').toLowerCase()] = _val;
          } catch { /* cookie access can throw in exotic contexts — the sniffed token still rides */ }
        }
        let fetchBody;
        if (method !== 'GET' && method !== 'HEAD') {
          // CX-6 (write) — read the CSRF token straight off the live page's DOM (the content script is ON the page —
          // no headless load, the CS Tools blueprint). A missing token means the page is logged out / not the app. Belt #2.
          // CX-7 — a background-SUPPLIED token (the sniffed x-csrf-token) satisfies this; a gql READ with no token at
          // all may still try cookie-only (the 403 surfaces honestly) — a WRITE without any token never runs.
          // v2.74.1953 — ELEVENTH SITE of the hardcoded-header-name class, and the one that VALIDATES what the
          // other ten produce. v1936 taught both tees every known spelling and taught the sender to attach the
          // per-site name (UPS uses `x-xsrf-token`), but this check still asked for `x-csrf-token` alone — so a
          // correctly-acquired, correctly-attached UPS token was invisible here, the DOM meta fallback found
          // nothing on ups.com, and the belt hard-rejected `no-csrf` in 19ms while the SW held a valid token.
          // The belt's INTENT is "a write without a token never runs"; that is preserved exactly — it still
          // requires a token, it just no longer requires one particular NAME. Case-insensitive across all
          // spellings, so a header set as X-XSRF-Token counts too.
          const _CSRF_NAMES = ['x-csrf-token', 'x-xsrf-token', 'x-xsrf-header'];
          let supplied = null;
          for (const _k of Object.keys(headers)) {
            if (_CSRF_NAMES.indexOf(String(_k).toLowerCase()) >= 0 && headers[_k]) { supplied = headers[_k]; break; }
          }
          if (!supplied) {
            const metaTok = document.querySelector('meta[name="csrf-token"]');
            const csrf = metaTok && metaTok.getAttribute('content');
            if (csrf) headers['X-CSRF-Token'] = csrf;
            else if (!gqlReadOk) { sendResponse({ success: false, error: 'no-csrf', hint: 'open the app signed in so it can authorize the write' }); return; }
          }
          if (payload && payload.body != null) {
            const ct = String(payload.contentType || 'application/json');
            headers['Content-Type'] = ct;
            fetchBody = (typeof payload.body === 'string') ? payload.body : (ct.includes('json') ? JSON.stringify(payload.body) : String(payload.body));
          }
        }
        const res = await fetch(url, { method, credentials: 'include', headers, body: fetchBody });
        const ct = res.headers.get('content-type') || '';
        const text = await res.text();
        let value = null, isJson = false;
        try { value = JSON.parse(text); isJson = true; } catch { /* non-JSON body */ }
        // v2.74.1954 — KEEP WHAT THE SERVER SAID. `text` and `res.headers` are already in hand and were thrown
        // away here, so in four hours of diagnosing a 401 we never once saw UPS's own explanation of it — the
        // single most informative artifact available, discarded one line after being read. `www-authenticate`
        // names the challenging layer (edge vs app), which is exactly the distinction the 401 turns on.
        // Bounded to 300 chars and only on FAILURE, so this cannot become a body-logging channel.
        if (!res.ok) {
          sendResponse({
            success: false, error: `http-${res.status}`, json: isJson,
            serverSaid: typeof text === 'string' ? text.slice(0, 300) : null,
            wwwAuth: res.headers.get('www-authenticate') || null,
            contentType: ct.slice(0, 60),
          });
          return;
        }
        // A 2xx that isn't JSON on a JSON endpoint is a login / Cloudflare-challenge HTML page (CS Tools lesson) —
        // not a real result. Don't pass it back as a misleading success (it would parse-error or read as junk).
        if (!isJson) { sendResponse({ success: false, error: 'non-json', status: res.status, contentType: ct.slice(0, 60), hint: 'login or challenge page?' }); return; }
        const capped = typeof text === 'string' && text.length > 100000;   // §12 — informational; offload later
        sendResponse({ success: true, value, capped });
      } catch (e) {
        sendResponse({ success: false, error: (e && e.message) || 'session-fetch-failed' });
      }
    })();
    return true;
  },

  // CX-7 (v2.74.1386) — the sniffed-CSRF cache half: the MAIN-world tee (injected by the background,
  // _csrfSnifferFunc) posts the token it captures off the SPA's own requests; the FIRST call here wires the
  // listener (the background always asks BEFORE injecting, so no capture can post into the void), later calls
  // return the newest token. Top frame only; same-origin messages only.
  // CX-7b (v2.74.1387) — the same tee also posts PERSISTED-OP URLs it sees (/api/operations/<sha>/<Name>/…); we
  // cache the newest sha per op name and hand the batch back so the background can bank it for replay.
  'GET_SNIFFED_CSRF': (_message, _sender, sendResponse) => {
    try {
      if (!window.__ahubSniffCsrfWired) {
        window.__ahubSniffCsrfWired = true;
        window.__ahubSniffCsrfTok = null;
        window.__ahubSniffOps = {};
        window.addEventListener('message', (ev) => {
          try {
            if (ev.source !== window || ev.origin !== location.origin) return;
            const d = ev.data && ev.data.__ahub_sniffed_csrf;
            if (d && d.token && d.host === location.host) {
              window.__ahubSniffCsrfTok = { token: String(d.token).slice(0, 400), at: Date.now() };
              // v2.74.1853 — same push as the eager document_start wiring (only one of the two ever wires,
              // guarded by __ahubSniffCsrfWired — keep the bodies identical).
              if (window.__ahubCsrfPushedTok !== window.__ahubSniffCsrfTok.token) {
                window.__ahubCsrfPushedTok = window.__ahubSniffCsrfTok.token;
                try { chrome.runtime.sendMessage({ type: 'CSRF_TOKEN_SEEN', payload: { host: location.host, token: window.__ahubSniffCsrfTok.token } }, () => { void chrome.runtime.lastError; }); } catch { /* */ }
              }
            }
            const o = ev.data && ev.data.__ahub_sniffed_op;
            if (o && o.sha && o.name && o.host === location.host && /^[a-f0-9]{16,64}$/i.test(String(o.sha)) && /^\w{1,60}$/.test(String(o.name))) {
              window.__ahubSniffOps[String(o.name)] = { sha: String(o.sha), handle: o.handle ? String(o.handle).slice(0, 80) : null, at: Date.now() };
          // v2.74.1935 — PUSH each NEW op to the SW bank, exactly as the token does above (throttle: value-change
          // only). Pull-only left an op alive ONLY in this world's buffer — and a ride's own content-script heal
          // re-runs this IIFE, zeroing that buffer while restoring the pipe (the 21:50 wedge: heal + a 404 emptied
          // both copies of the sha in one second, with no way back short of a document load). An orphaned
          // context's push throws 'context invalidated' and dies in the catch; the fresh script re-pushes.
          if (!window.__ahubPushedOps) window.__ahubPushedOps = {};
          if (window.__ahubPushedOps[String(o.name)] !== String(o.sha)) {
            window.__ahubPushedOps[String(o.name)] = String(o.sha);
            try { chrome.runtime.sendMessage({ type: 'SNIFFED_OP_SEEN', payload: { host: location.host, name: String(o.name), sha: String(o.sha), handle: o.handle ? String(o.handle).slice(0, 80) : null } }, () => { void chrome.runtime.lastError; }); } catch { /* */ }
          }
            }
          } catch { /* */ }
        });
      }
    } catch { /* */ }
    const t = window.__ahubSniffCsrfTok || null;
    sendResponse({ success: true, token: (t && t.token) || null, at: (t && t.at) || 0, ops: window.__ahubSniffOps || {} });
    return false;
  },


    // v2.74.46 — Perspective-capture verification overlays.
  'SHOW_PERSPECTIVE_OVERLAYS': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try { showPerspectiveOverlays(payload?.landmarks); } catch (e) {
        sendResponse({ success: false, error: e.message });
        return false;
      }
      sendResponse({ success: true, count: __perspectiveOverlays.length });
      return false;
    }
  },

  'CLEAR_PERSPECTIVE_OVERLAYS': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try { clearPerspectiveOverlays(); } catch (e) {
        sendResponse({ success: false, error: e.message });
        return false;
      }
      sendResponse({ success: true });
      return false;
    }
  },


  'agent_hub_scroll': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      // v2.71.0 — Smooth scroll the window by N viewports (signed).
      // Waits for scrollend (or 2s fallback timeout). Returns success when
      // the scroll completes. Engine has its own 4s safety timeout above
      // this — content-script side only needs to handle the scroll itself.
      handleSmoothScroll(message.viewports)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: `SCROLL: ${err.message}` }));
      return true;   // keep channel open for async response
    }
  },


  'EXECUTE_STEP': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      const { action, selector, value, aliases: stepAliases, smoothScroll } = payload ?? {};
      // v2.40.0 — TYPE is async (paced character-by-character). All other
      // actions remain synchronous. We special-case TYPE to keep the
      // sendResponse channel open and respond when the typing finishes.
      if (action === 'TYPE') {
        handleType(selector, value)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: `TYPE: ${err.message}` }));
        return true;   // keep channel open for async response
      }
      // v2.74.1535 — CLICK_BY_LABEL is now async: it POLLS for its container, which a preceding click may open
      // async (the division dropdown). Same channel-keep pattern as TYPE.
      if (action === 'CLICK_BY_LABEL') {
        handleClickByLabel(selector, value)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: `CLICK_BY_LABEL: ${err.message}` }));
        return true;   // keep channel open for async response
      }
      let result;
      switch (action) {
        case 'CLICK':     result = handleClick(selector, value);              break;
        case 'SELECT':    result = handleSelect(selector, value);             break;
        case 'SET_FILE':  result = handleSetFile(selector, value);            break;
        case 'EXTRACT':   result = handleExtract(selector, payload?.fromIndex ?? 0, payload?.positional === true); break;
        case 'FIND_AI':   result = handleFindAI(selector, stepAliases ?? []);           break;
        case 'BLUR':      result = handleBlur(selector);                      break;
        // v2.72.72 — SCROLL_TO carries optional smoothScroll bool from
        // fragment-author authoring. Default false (instant scroll).
        case 'SCROLL_TO': result = handleScrollTo(selector, value, smoothScroll === true); break;
        // v2.74.49 — ENTER simulates the Enter key. Selector is optional.
        case 'ENTER':     result = handleEnter(selector);                     break;
        // v2.74.308 — ACTION_SPEC § 3: KEY sends a named key (value =
        // key name) to the resolved element. Enter delegates to
        // handleEnter for the implicit-submit fallback.
        // v2.74.316 — repeat count (payload.repeat) sends the key N times.
        case 'KEY':       result = handleKey(selector, value, payload?.repeat); break;
        default:          result = { success: false, error: `Unknown action: "${action}"` };
      }
      sendResponse(result);
      return false;
    }
  },


  'FOCUS_CHECK': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      // Checks whether the matched element can receive focus — used as the
      // Phase 1 termination condition. An element that accepts focus is
      // interactive and ready for input.
      const { selector: fcSel } = payload ?? {};
      const el = resolveElement(fcSel);
      if (!el) {
        sendResponse({ focusable: false, error: `No element matched "${(fcSel||'').slice(0,80)}"` });
        return false;
      }
      try {
        el.focus();
        const active   = document.activeElement;
        const focusable = active === el || el.contains(active);
        sendResponse({
          focusable,
          tagName    : el.tagName.toLowerCase(),
          isContentEditable: el.isContentEditable,
          dataTestId : el.getAttribute('data-test-id') ?? '',
        });
      } catch (e) {
        sendResponse({ focusable: false, error: e.message });
      }
      return false;
    }
  },


  'WAIT_FOR_ELEM': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      const { selector, timeoutMs, description } = payload ?? {};
      handleWaitFor(selector, timeoutMs ?? 10000, sendResponse, description);
      return true; // async
    }
  },


  // BA-1 (v2.74.1003) — one-shot WAIT_FOR probe (selector OR portal description), no setTimeout: the LOOP
  // lives in the service worker (TemplateWalker.#swWaitFor), whose timer isn't throttled in a hidden tab.
  // Synchronous like CHECK_ELEM — returns { matched, via } and closes the channel immediately.
  'WAIT_FOR_PROBE': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      const { selector, description } = payload ?? {};
      try { sendResponse(_waitForProbe(selector, description)); }
      catch (e) { sendResponse({ matched: false, via: null, error: `WAIT_FOR_PROBE threw: ${(e && e.message) || e}` }); }
      return false;
    }
  },


  'CHECK_ELEM': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      // Lightweight single-check — returns immediately with found:true/false.
      // Used by ExecutionEngine's WAIT_FOR polling loop to avoid holding the
      // message channel open for long timeouts.
      const found = !!resolveElement(payload?.selector ?? '');
      sendResponse({ found });
      return false;
    }
  },


  'CHECK_OUTCOME': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      // Layer 3 outcome verification. Checks whether the final page state
      // matches a success signal (CSS selector OR "text:..." pattern).
      // Returns { found, matchedElement?, snippet? } so ExecutionEngine can
      // distinguish silent failures from genuine completion.
      const signal = String(payload?.signal ?? '').trim();
      if (!signal) { sendResponse({ found: false, error: 'empty signal' }); return false; }

      let found = false;
      let snippet = null;
      try {
        if (signal.startsWith('text:')) {
          // Text pattern — case-insensitive substring match against body text
          const needle = signal.slice(5).trim().toLowerCase();
          const haystack = (document.body?.innerText ?? '').toLowerCase();
          found = haystack.includes(needle);
          if (found) {
            const idx = haystack.indexOf(needle);
            snippet = (document.body?.innerText ?? '').slice(Math.max(0, idx - 40), idx + needle.length + 40);
          }
        } else {
          // CSS selector — presence check
          const el = resolveElement(signal);
          found = !!el;
          if (found) snippet = (el.innerText ?? el.textContent ?? '').trim().slice(0, 120);
        }
      } catch (e) {
        sendResponse({ found: false, error: e.message });
        return false;
      }
      sendResponse({ found, snippet });
      return false;
    }
  },


    // Used by DETECT branches to evaluate whether a given condition holds
    // against current page state. Five condition types:
    //   selector_present  — a DOM match exists
    //   selector_absent   — no DOM match
    //   url_matches       — current window.location matches a regex
    //   text_present      — substring appears in body text (case-insensitive)
    //   attribute_equals  — element's attribute has a specific value
  'CHECK_CONDITION': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      const cond = payload?.condition ?? {};
      let matched = false;
      // v2.74.172 — Diagnostic metadata returned alongside `matched` for
      // text_present so the gate's Verify button can show the author
      // WHY it matched / didn't (element missing vs text absent), and
      // a snippet of what's actually present in the scoped section.
      // Other condition types continue to return just { matched }.
      let textPresentDiag = null;
      try {
        switch (cond.type) {
          case 'selector_present': {
            matched = !!document.querySelector(cond.selector);
            break;
          }
          case 'selector_absent': {
            matched = !document.querySelector(cond.selector);
            break;
          }
          case 'url_matches': {
            // v2.74.888 — regex test, then an ADDITIVE slug-tolerant fallback: decode + slug-normalize BOTH sides
            // and contains-check. A postcondition parameterized as "/{{CATEGORY}}/" substitutes to the RAW bound
            // value ("/Vectors/"), which the regex misses on case ("/vectors/") AND on %20-encoded multi-word values
            // ("/halo%203/"). The regex runs FIRST, so existing url_matches behaviour is unchanged — this only ADDS.
            try { matched = new RegExp(cond.pattern).test(window.location.href); } catch (e) { matched = false; }
            if (!matched) {
              const _slugU = (s) => { let d = String(s || ''); try { d = decodeURIComponent(d); } catch (e2) { /* malformed % */ } return d.toLowerCase().replace(/[^a-z0-9/]+/g, '-'); };
              matched = _slugU(window.location.href).includes(_slugU(cond.pattern));
            }
            break;
          }
          case 'text_present': {
            // v2.74.193 — Detailed runtime logging. The user reported
            // "body always runs regardless of values" — meaning either
            // (a) wrong frame, (b) selector misses, (c) text not in
            // section. This log line records every step of the
            // evaluation in the content-script's own context so the
            // page-side DevTools console (and downstream Logger via
            // the console patch from v2.74.189) capture exactly what
            // happened. Tag includes the frame's URL so iframe vs top
            // frame is visible at a glance.
            const __ah_frameTag = (() => {
              try {
                return window.top === window.self
                  ? 'top'
                  : `iframe:${window.location.href}`;
              } catch { return 'iframe:?'; }
            })();
            console.info('[ContentScript:CHECK_CONDITION] text_present probe', {
              frame    : __ah_frameTag,
              selector : cond.selector ?? null,
              text     : cond.text ?? null,
              docHref  : window.location.href,
              hasBody  : !!document.body,
            });
            // v2.74.170 — Optional `selector` scopes the search. When
            // present, query the element and use its innerText as the
            // haystack; when the selector matches nothing, the condition
            // can't hold (no element to contain the text). When absent,
            // fall back to body.innerText (legacy whole-page behavior).
            // v2.74.173 — Diagnostic metadata for the gate Verify button.
            // v2.74.175 — Page-text fallback snippet when selector misses.
            // v2.74.176 — "What the user sees" is captured via
            // Element.innerText (NOT textContent / innerHTML / attribute
            // values). The HTML spec defines innerText as the text "as
            // a human would read it" — display:none and visibility:hidden
            // subtrees are excluded, <script>/<style> are excluded,
            // whitespace collapses per CSS. This is the standard
            // browser-native answer to "what's visible" without needing
            // a vision model. Limitation: input.value, placeholders,
            // alt text, and aria-label are NOT in innerText — they're
            // separately-visible signals that text_present doesn't
            // currently inspect (consider attribute_equals for those).
            //
            // When the scoped element isn't found, we also probe page-
            // wide innerText for the searched substring so the sidepanel
            // can tell the author "your text DOES appear on the page,
            // somewhere your selector didn't reach." That's the most
            // actionable hint for fixing a stale selector.
            const buildSnippet = (raw) => {
              const collapsed = String(raw ?? '').replace(/\s+/g, ' ').trim();
              return collapsed.length > 400 ? collapsed.slice(0, 400) + '…' : collapsed;
            };
            const searchLc = String(cond.text ?? '').toLowerCase();
            let visibleText = '';
            let elementFound = true;
            const scoped = cond.selector && String(cond.selector).trim();
            if (scoped) {
              const scopeEl = document.querySelector(cond.selector);
              if (!scopeEl) {
                matched = false;
                elementFound = false;
                const pageText = (document.body?.innerText ?? '').trim();
                const pageContainsSearched = !!searchLc && pageText.toLowerCase().includes(searchLc);
                // v2.74.193 — Detail the miss so the Logs tab shows
                // WHY the element wasn't found (selector + frame).
                console.warn('[ContentScript:CHECK_CONDITION] text_present element NOT FOUND', {
                  frame   : __ah_frameTag,
                  selector: cond.selector,
                  pageContainsSearched,
                  pageSnippetPreview: buildSnippet(pageText).slice(0, 120),
                });
                textPresentDiag = {
                  elementFound: false,
                  snippet: buildSnippet(pageText),
                  snippetSource: 'page',
                  scoped: true,
                  pageContainsSearched,
                };
                break;
              }
              visibleText = (scopeEl.innerText ?? scopeEl.textContent ?? '').trim();
            } else {
              visibleText = (document.body?.innerText ?? '').trim();
            }
            const haystack = visibleText.toLowerCase();
            matched = !!searchLc && haystack.includes(searchLc);
            // v2.74.193 — Final-result log so the Logs tab tells the
            // author whether the text was found AND a snippet of what
            // was actually examined. Critical for diagnosing
            // "body always runs" — we now see the exact section text
            // that didn't contain the searched literal.
            console.info('[ContentScript:CHECK_CONDITION] text_present probe result', {
              frame         : __ah_frameTag,
              matched,
              searched      : cond.text,
              selector      : cond.selector ?? '(whole page)',
              visibleTextLen: visibleText.length,
              snippet       : buildSnippet(visibleText),
            });
            textPresentDiag = {
              elementFound,
              snippet: buildSnippet(visibleText),
              snippetSource: scoped ? 'section' : 'page',
              scoped: !!scoped,
            };
            break;
          }
          case 'attribute_equals': {
            const el = document.querySelector(cond.selector);
            matched = !!el && el.getAttribute(cond.attribute) === cond.value;
            break;
          }
          // v2.57.0 — infrastructure-level signals. Observable browser/page
          // state outside the visible DOM tree, used by tier-1 page
          // classification recognizers.
          case 'resource_loaded': {
            // Performance API resource timing: every resource the page has
            // fetched so far. Survives shadow DOM and DOM rewrites because
            // it reflects what was actually loaded, not what's currently
            // queryable. Caveat: timing-sensitive — resources still in flight
            // when this runs won't appear. For challenge pages this is fine
            // because challenge resources load synchronously in the head.
            const re = new RegExp(cond.pattern);
            const entries = performance.getEntriesByType('resource');
            matched = entries.some(e => re.test(e.name));
            break;
          }
          case 'cookie_present': {
            // document.cookie returns "name=value; name=value; ..." for
            // non-HttpOnly cookies on the current document's origin. Cookies
            // marked HttpOnly (common for session/security cookies, including
            // Cloudflare's __cf_bm) are NOT visible here — this is a fallback
            // signal. Cookie names are case-sensitive per RFC.
            const target = String(cond.name);
            const pairs = (document.cookie || '').split(';');
            matched = pairs.some(p => {
              const eq = p.indexOf('=');
              const name = (eq >= 0 ? p.slice(0, eq) : p).trim();
              return name === target;
            });
            break;
          }
          case 'meta_equals': {
            // Match a <meta> tag by `name` OR `httpEquiv` (one required).
            // If `value` is given, exact-match the content attribute.
            // If `valuePattern` is given, regex-match against content.
            // If neither is given, fire whenever a matching tag exists.
            let selector = null;
            if (cond.httpEquiv) selector = `meta[http-equiv="${cond.httpEquiv}" i]`;
            else if (cond.name) selector = `meta[name="${cond.name}" i]`;
            if (!selector) {
              matched = false;
              break;
            }
            const el = document.querySelector(selector);
            if (!el) {
              matched = false;
              break;
            }
            const content = el.getAttribute('content') ?? '';
            if (cond.value) {
              matched = content === cond.value;
            } else if (cond.valuePattern) {
              try { matched = new RegExp(cond.valuePattern).test(content); }
              catch { matched = false; }
            } else {
              matched = true; // tag present, no content constraint
            }
            break;
          }
          default:
            sendResponse({ matched: false, error: `unknown condition type: ${cond.type}` });
            return false;
        }
      } catch (e) {
        sendResponse({ matched: false, error: e.message });
        return false;
      }
      // v2.74.172 — Append text_present diagnostics when present.
      if (textPresentDiag) {
        sendResponse({ matched, ...textPresentDiag });
      } else {
        sendResponse({ matched });
      }
      return false;
    }
  },


    // ── Pass E1 (v2.26.0) ──────────────────────────────────────────────────
    // EXTRACT_VALUE — read a value from the live page and return it as a
    // string. Backs the EXTRACT action verb in Fragments. The value gets
    // written into the calling Strategy's scope by the engine.
    //
    // Payload: { selector, attribute }
    //   selector  — required CSS selector for the source element
    //   attribute — what to read:
    //                 'text' (default)    → element.textContent.trim()
    //                 'innerText'         → element.innerText.trim()
    //                 'href' / 'src' / etc → element.getAttribute(attribute)
    //                 'value'              → element.value (form fields)
    //
    // Returns: { success, value, error? }
    //   success=true if element matched and read produced a non-error result
    //   value="" is a valid result (empty input field, empty text node)
    //
    // Truncates to 5000 chars to bound payload size; selectors that grab the
    // whole page body (mistakenly) won't blow up message-passing limits.
  'EXTRACT_VALUE': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      const sel  = payload?.selector;
      const attr = payload?.attribute || 'text';
      if (!sel) {
        sendResponse({ success: false, value: '', error: 'EXTRACT_VALUE requires a selector' });
        return false;
      }
      try {
        const el = document.querySelector(sel);
        if (!el) {
          sendResponse({ success: false, value: '', error: `EXTRACT_VALUE: no element matched "${sel.slice(0, 80)}"${_diagnoseSelectorFailure(sel)}` });
          return false;
        }
        let raw;
        if (attr === 'text') {
          raw = el.textContent ?? '';
        } else if (attr === 'innerText') {
          raw = el.innerText ?? '';
        } else if (attr === 'html') {
          // v2.72.95 — outerHTML extraction for Observation raw_html shape.
          raw = el.outerHTML ?? '';
        } else if (attr === 'value') {
          // For input/textarea/select form fields
          raw = (typeof el.value === 'string') ? el.value : (el.getAttribute('value') ?? '');
        } else {
          // Treat anything else as an attribute name
          raw = el.getAttribute(attr) ?? '';
        }
        const value = String(raw).trim().slice(0, 5000);
        sendResponse({ success: true, value });
      } catch (e) {
        sendResponse({ success: false, value: '', error: e.message });
      }
      return false;
    }
  },


    // v2.29.1 (Pass E2-2) — COUNT_ELEMENTS: returns the number of elements
    // matching a CSS selector on the live page. Used by the ENUMERATE action
    // at Fragment execution time to decide how many iteration items to
    // produce for the list binding.
    //
    // v2.29.7 (Pass F2) — When `withSelectors: true` is passed in the
    // payload, also returns a per-match `selectors` array where each entry
    // is a unique selector identifying that specific element in the
    // document. This replaces the earlier engine-side synthesis of
    // `${base}:nth-of-type(k)` which didn't work when matches were siblings
    // of different parents (each one was `:nth-of-type(1)` of its own
    // parent, so `base:nth-of-type(1)` matched ALL of them and
    // `:nth-of-type(2)+` matched none).
    //
    // Does NOT return element handles — we deliberately don't materialize
    // references that could go stale across FOREACH iterations. The content
    // script computes stable document-unique selectors once, and each
    // FOREACH iteration resolves the k-th item's selector freshly at CLICK
    // or EXTRACT time.
  'COUNT_ELEMENTS': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      const sel = payload?.selector;
      const max = Number.isFinite(payload?.max) ? Math.max(0, Math.floor(payload.max)) : null;
      const withSelectors = payload?.withSelectors === true;
      // v2.74.836 (ORCH-L) — per-item LINK capture for an "open each <item>" loop: the absolute href of each match's
      // own anchor (or its nearest ancestor / descendant a[href]). The foreach body opens each in a new tab.
      const withHrefs = payload?.withHrefs === true;
      // v2.46.0 (Pass O1) — optional per-item field capture. Each entry is
      // { name, source, type } where source is a CSS selector RELATIVE to
      // each matched item, and type is one of: string | presence | number |
      // attribute:NAME. When present, the response includes `records[]`
      // matching `count` length, where each record is { selector?, ...fields }.
      // The selector field is the unique-document selector if withSelectors
      // is also set; otherwise the record contains only captured fields.
      const fieldDecls = Array.isArray(payload?.fields) ? payload.fields : null;
      if (!sel) {
        sendResponse({ success: false, count: 0, error: 'COUNT_ELEMENTS requires a selector' });
        return false;
      }
      try {
        const elements = document.querySelectorAll(sel);
        const totalCount = elements.length;
        const effectiveCount = max !== null && totalCount > max ? max : totalCount;

        const response = { success: true, count: effectiveCount, total: totalCount };
        if (withSelectors) {
          const selectors = [];
          for (let i = 0; i < effectiveCount; i++) {
            selectors.push(computeUniqueSelector(elements[i]));
          }
          response.selectors = selectors;
        }
        if (withHrefs) {
          // v2.74.837 (ORCH-L) — pick each row's CONTENT link: gather the element's own / ancestor / descendant
          // anchors and prefer a NON-ad-redirect href (skip …/pagead/clk, …/aclk, ?ad=… wrappers) when one exists,
          // so "open each" opens the job page itself rather than the ad-click redirect. Falls back to the first
          // usable anchor (a sponsored card whose only link IS the redirect still opens — it just redirects).
          const _isAdLink = (h) => /\/(?:pagead\/clk|aclk)\b|[?&]ad=/i.test(h);
          const hrefs = [];
          for (let i = 0; i < effectiveCount; i++) {
            const el = elements[i];
            let href = null;
            try {
              const cands = [];
              if (el.matches && el.matches('a[href]')) cands.push(el);
              const anc = el.closest && el.closest('a[href]'); if (anc) cands.push(anc);
              if (el.querySelectorAll) for (const d of el.querySelectorAll('a[href]')) cands.push(d);
              // `.href` resolves to an absolute URL; keep only real http(s) links (drop javascript:/#/mailto:).
              const abs = cands.map((x) => x && x.href).filter((h) => typeof h === 'string' && /^https?:\/\//i.test(h));
              href = abs.find((h) => !_isAdLink(h)) || abs[0] || null;
            } catch { href = null; }
            hrefs.push(href);
          }
          response.hrefs = hrefs;
        }

        // v2.46.0 — per-item field capture. Runs after the count to keep
        // the simple-COUNT path unchanged. Captures defensively — failure
        // for one field on one item produces null for that field, never
        // throws.
        if (fieldDecls) {
          const records = [];
          for (let i = 0; i < effectiveCount; i++) {
            const itemEl = elements[i];
            const record = {};
            for (const fd of fieldDecls) {
              if (!fd?.name || !fd?.type) continue;
              record[fd.name] = captureFieldValue(itemEl, fd);
            }
            records.push(record);
          }
          response.records = records;
        }

        sendResponse(response);
      } catch (e) {
        sendResponse({ success: false, count: 0, error: e.message });
      }
      return false;
    }
  },


  'OBSERVE_START': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      sendResponse(handleObserveStart());
      return false;
  },


  'OBSERVE_READ': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      sendResponse(handleObserveRead());
      return false;
  },


    // v2.72.29 (Pass 17) — PROBE_SELECTOR returns count + sample HTML for
    // perspective landmark verification. Mirrors COUNT_ELEMENTS in spirit but
    // includes the first match's outerHTML truncated to a budget. Used by
    // Services/PageProbe.js → probeSelector.
  'PROBE_SELECTOR': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      const sel = payload?.selector;
      const sampleMax = Number.isFinite(payload?.sampleHtmlMax)
        ? Math.max(0, Math.floor(payload.sampleHtmlMax)) : 400;
      if (!sel) {
        sendResponse({ success: false, matchedCount: 0, sampleHtml: '', error: 'PROBE_SELECTOR requires a selector' });
        return false;
      }
      try {
        const elements = document.querySelectorAll(sel);
        const matchedCount = elements.length;
        let sampleHtml = '';
        if (matchedCount > 0) {
          const first = elements[0];
          // outerHTML can be very large; truncate.
          const raw = first.outerHTML ?? '';
          sampleHtml = raw.length > sampleMax ? raw.slice(0, sampleMax) + '…' : raw;
        }
        sendResponse({ success: true, matchedCount, sampleHtml });
      } catch (e) {
        sendResponse({ success: false, matchedCount: 0, sampleHtml: '', error: e.message });
      }
      return false;
    }
  },


  'DOM_SNAPSHOT': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      sendResponse(handleDomSnapshot());
      return false;
  },


  'DOM_SNAPSHOT_RICH': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      sendResponse(handleDomSnapshotRich(message.payload?.prevSigs ?? [], { includeContentBlocks: !!message.payload?.includeContentBlocks }));
      return false;
  },


    // v2.74.433 — Deterministic outgoing-link extraction for Ground discovery.
  'EXTRACT_LINKS': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      try { sendResponse(extractPageLinks()); }
      catch (e) { sendResponse({ success: false, links: [], error: e.message }); }
      return false;
  },


    // v2.74.455 — in-tab first-party fetch (sitemap behind a Cloudflare/WAF challenge).
  'FETCH_URL_TEXT': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      fetchUrlText(payload?.url).then(sendResponse).catch(e => sendResponse({ ok: false, status: 0, text: null, error: e.message }));
      return true;   // async sendResponse
  },


    // v2.74.396 — Resolve Tier-2 visual pick: normalized box → best-IoU element.
  'LOCATE_PICK': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      locatePick(payload).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;   // async sendResponse
  },


    // v2.74.397 — L0 page enumeration (read-only) → raw Feature list for a Locale.
  'ENUMERATE_PAGE': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      enumeratePage().then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;   // async sendResponse
  },


    // PB-10 — deterministic form-field oracle (required-field markers) for intent-driven proposal.
  'ENUMERATE_FORM_FIELDS': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      try { sendResponse({ success: true, fields: enumerateFormFields() }); }
      catch (e) { sendResponse({ success: false, error: e.message }); }
      return false;
  },


    // v2.74.353 — Resolve-roles complexity metric (deterministic DOM scan).
  'PAGE_COMPLEXITY': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      try { sendResponse(computePageComplexity()); }
      catch (e) { sendResponse({ success: false, error: e.message }); }
      return false;
  },


    // v2.74.362 — Auto-verify a Perspective's structured composition (async: poke).
  'VERIFY_STRUCTURE': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      verifyStructure(payload).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;   // async sendResponse
  },


    // v2.74.367 — pageStructure depth sweep (async: poke→observe→restore).
  'EXPLORE_PAGE_STRUCTURE': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      explorePageStructure(payload).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;   // async sendResponse
  },


    // v2.74.381 — Reveal-aware resolve: open a trigger (modal/menu) and return a
    // rich DOM snapshot of the REVEALED state, leaving it open so the caller can
    // resolve + verify hidden-layer roles against it. Pair with CLOSE_OVERLAYS.
  'POKE_AND_SNAPSHOT': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      pokeAndSnapshot(payload).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;   // async sendResponse
  },


    // v2.74.381 — Close any open overlay (modal/dialog) — used after a
    // reveal-aware resolve to restore the page.
  'CLOSE_OVERLAYS': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      closeOpenOverlays().then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;   // async sendResponse
  },


  'DOM_SNAPSHOT_FULL': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      sendResponse(handleDomSnapshotFull());
      return false;
  },


  'GET_BASELINE_SIGS': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      // Capture a set of element signatures from the current DOM state.
      // Called before TYPE so we can identify which elements appeared after send.
      const SEL = ['[data-test-id]','[data-testid]','div[id]','[role]','[aria-label]'].join(',');
      const sigs = Array.from(queryAllDeep(SEL))
        .filter(el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } })
        .map(el => {
          const parts = [el.tagName];
          for (const a of ['data-test-id','data-testid','id','role','aria-label']) {
            const v = el.getAttribute(a);
            if (v) { parts.push(`${a}=${v}`); break; }
          }
          return parts.join('|');
        });
      sendResponse({ sigs });
      return false;
    }
  },


  'DOM_SNAPSHOT_POST_SEND': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      sendResponse(handleDomSnapshotPostSend(message.payload?.baselineSigs ?? [], message.payload?.typedQuestion ?? ''));
      return false;
  },


  'CHECK_ELEMENT': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      // Returns attributes of the matched element useful for verdict decisions.
      // Used by TemplateWalker to determine whether a CLICK target is a
      // contenteditable/editor that won't produce a DOM mutation on focus.
      const { selector } = payload ?? {};
      const el = resolveElement(selector);
      if (!el) {
        sendResponse({ found: false });
        return false;
      }
      sendResponse({
        found            : true,
        isContentEditable: el.isContentEditable,
        role             : el.getAttribute('role') ?? '',
        tagName          : el.tagName.toLowerCase(),
        dataTestId       : el.getAttribute('data-test-id') ?? '',
      });
      return false;
    }
  },


  'GET_LAST_ELEMENT_TEXT': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      const { selector: ltSel } = payload ?? {};
      if (!ltSel) { sendResponse({ text: '', found: false }); return false; }
      try {
        const all     = queryAllDeep(ltSel);
        const visible = all.filter(el => {
          try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
          catch { return false; }
        });
        if (!visible.length) { sendResponse({ text: '', found: false }); return false; }
        const last = visible[visible.length - 1];
        const text = last.innerText?.trim() ?? last.textContent?.trim() ?? '';
        sendResponse({ text, found: true, count: visible.length });
      } catch (e) {
        sendResponse({ text: '', found: false, error: e.message });
      }
      return false;
    }
  },


  'GET_ELEMENTS_TEXT_FROM': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      // Collects innerText from all visible elements matching selector,
      // starting from fromIndex (0-based). Used to extract all new AI
      // response blocks added since baseline — handles multi-block responses
      // (thinking + context + answer) by concatenating all new blocks.
      const { selector: gtSel, fromIndex = 0 } = payload ?? {};
      if (!gtSel) { sendResponse({ text: '', count: 0 }); return false; }
      try {
        const all     = queryAllDeep(gtSel);
        const visible = all.filter(el => {
          try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
          catch { return false; }
        });
        const newBlocks = visible.slice(fromIndex);
        const text = newBlocks
          .map(el => (el.innerText?.trim() ?? el.textContent?.trim() ?? ''))
          .filter(Boolean)
          .join('\n\n');
        sendResponse({ text, count: newBlocks.length, total: visible.length });
      } catch (e) {
        sendResponse({ text: '', count: 0, error: e.message });
      }
      return false;
    }
  },


  'PAGE_IDLE': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
      sendResponse({ idle: handlePageIdle(payload?.idleMs ?? 600) });
      return false;
  },


    // v2.72.3 (Pass 4) — Observation extraction. One handler per shape.
    // All handlers are synchronous: querySelector/All + DOM reads have no
    // promise dependencies, so we respond immediately. Returns
    //   scalar:          { success: true, value: string }
    //   list_of_records: { success: true, items: [{ record: { ... } }, ...] }
    //   raw_text:        { success: true, value: string }
    //   raw_html:        { success: true, value: string }
    // v2.72.12 (Pass 9) — GET_ELEMENT_RECT. Returns the target element's
    // bounding rect in CSS pixels (relative to the viewport) plus the
    // current devicePixelRatio. The service worker uses this to crop a
    // captureVisibleTab output (which is at device-pixel resolution) to
    // just the target's visible portion, scoping the screenshot before
    // sending to the vision LLM.
    //
    // Returns:
    //   { success: true, rect: {x, y, width, height},
    //     devicePixelRatio, viewportWidth, viewportHeight }
    //   { success: false, error: string }
  'GET_ELEMENT_RECT': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { target } = payload ?? {};
        if (!target || typeof target !== 'string') {
          sendResponse({ success: false, error: 'GET_ELEMENT_RECT: target selector is required' });
          return false;
        }
        const el = document.querySelector(target);
        if (!el) {
          sendResponse({ success: false, error: `GET_ELEMENT_RECT: no element matched "${target}"${_diagnoseSelectorFailure(target)}` });
          return false;
        }
        // getBoundingClientRect returns viewport-relative CSS pixel
        // coordinates. Element may be partially or wholly off-screen;
        // we don't clamp here — the caller decides how to handle.
        const r = el.getBoundingClientRect();
        sendResponse({
          success: true,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          devicePixelRatio: window.devicePixelRatio || 1,
          viewportWidth : window.innerWidth,
          viewportHeight: window.innerHeight,
        });
      } catch (err) {
        sendResponse({ success: false, error: err?.message ?? String(err) });
      }
      return false;
    }
  },


  'OBSERVE_SCALAR': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { target, extract } = payload ?? {};
        const el = document.querySelector(target);
        if (!el) {
          sendResponse({ success: false, error: `OBSERVE_SCALAR: no element matched "${target}"${_diagnoseSelectorFailure(target)}` });
          return false;
        }
        let value;
        if (extract?.kind === 'attribute') {
          const attr = String(extract.name ?? '').trim();
          if (!attr) {
            sendResponse({ success: false, error: 'OBSERVE_SCALAR: attribute name is empty' });
            return false;
          }
          value = el.getAttribute(attr) ?? '';
        } else {
          // Default: text content
          value = (el.textContent ?? '').trim();
        }
        sendResponse({ success: true, value });
      } catch (err) {
        sendResponse({ success: false, error: `OBSERVE_SCALAR: ${err.message}` });
      }
      return false;
    }
  },


  'OBSERVE_LIST': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { target, fields } = payload ?? {};
        if (!Array.isArray(fields) || fields.length === 0) {
          sendResponse({ success: false, error: 'OBSERVE_LIST: fields array is empty' });
          return false;
        }
        const containers = document.querySelectorAll(target);
        const items = [];
        for (const container of containers) {
          const recordObj = {};
          for (const f of fields) {
            const fname = String(f.name ?? '').trim();
            const fsel = String(f.selector ?? '').trim();
            if (!fname || !fsel) continue;
            // Field selector is scoped to the matched container's subtree.
            const fieldEl = container.querySelector(fsel);
            if (!fieldEl) {
              recordObj[fname] = '';
              continue;
            }
            if (f.extract?.kind === 'attribute') {
              const attr = String(f.extract.name ?? '').trim();
              recordObj[fname] = attr ? (fieldEl.getAttribute(attr) ?? '') : '';
            } else {
              recordObj[fname] = (fieldEl.textContent ?? '').trim();
            }
          }
          items.push({ record: recordObj });
        }
        sendResponse({ success: true, items });
      } catch (err) {
        sendResponse({ success: false, error: `OBSERVE_LIST: ${err.message}` });
      }
      return false;
    }
  },


    // v2.74.213 — INSPECT_ELEMENT: authoring-time diagnostic. Resolves
    // the selector and returns a structured report of WHAT was matched
    // so the author can see whether their selector lands on the real
    // content, a wrapper, a scroll anchor, etc. — without changing the
    // extract's shape or running OBSERVE_*.
    //
    // The report is intentionally rich:
    //   - tag / id / classes / all attrs
    //   - child-tag breakdown (immediate children)
    //   - childPreview: up to 5 immediate children with their tag + text preview
    //   - textLength / innerTextLength + previews (so empty-text matches
    //     are obvious — that's the bug the chat-reply use case hit)
    //   - outerHTML truncated to ~2KB
    //   - shadow-root flag
    //   - bounding rect (visible? offscreen?)
    //   - frame tag (top vs iframe)
    //
    // Side panel logs the full report to the Logs tab so the side panel
    // UI stays uncluttered.
    // v2.74.241 — Phase 3 of substrate spec: heuristic recovery.
    //
    // Called by TemplateWalker before dispatching any action whose step
    // resolves through a landmark ref. Tries the stored selector first;
    // if it doesn't match a unique visible element, runs description-
    // layer recovery (role + accessibleName + hierarchicalContext) to
    // find a candidate. Returns:
    //   { success: true,  via: 'selector',  selector }     — happy path
    //   { success: true,  via: 'heuristic', selector }     — recovered
    //   { success: false, via: 'fail',      reason }       — unresolvable
    //
    // The recovered selector is synthesized from the candidate element's
    // stable attributes (data-test-id / id / role+aria-label / structural
    // path). It's a one-shot replacement for THIS dispatch — the
    // registry copy stays as-is; the lifecycle flag tells the author
    // to re-Pick.
    // v2.74.245 — Phase 7a of substrate spec: iframe element
    // identification for iframe-context auto-proposal.
    //
    // Called from the sidepanel (in the TOP frame, frameId: 0) after
    // PICK_RESULT arrives from an iframe-frame content script. We
    // walk the top document's iframe elements, find the one whose
    // src matches the picked frame's URL, and propose:
    //   - contextName  (auto-derived from name attr / id / src host)
    //   - predicate    (most stable: name → selector → srcPattern → positional)
    //   - sameOrigin   (verified by attempting contentDocument access)
    //
    // Per spec § 4 (Predicate kind selection guidance): name > selector
    // > srcPattern > positional, in stability order.
    // v2.74.246 — Phase 7b of substrate spec: runtime iframe predicate
    // evaluator. Used by TemplateWalker to resolve iframe-scoped
    // landmarks at dispatch time. Given a predicate from a Perspective's
    // iframeContexts[], finds the matching <iframe> element in the
    // top document and returns:
    //   - its current src (for frameId correlation via webNavigation)
    //   - same-origin status (determined by contentDocument access)
    //   - loaded state (readyState for same-origin; assumed for x-origin)
    //
    // The spec's predicate kinds (§ 4): iframeName / iframeSelector /
    // iframeSrcPattern (with mode contains|regex|exact) / iframePositional.
    // First-match in document order per spec § 8.
    // v2.74.248 — Phase 7d substrate spec: Perspective predicate leaf
    // evaluators that need DOM inspection. `visible` checks bounding
    // rect + CSS visibility; `hasText` checks innerText contains. Both
    // are called from the Perspective predicate evaluator (PerspectivePredicates.js)
    // when determining whether a perspective is active for the current page
    // state.
  'EVALUATE_PREDICATE_VISIBLE': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { selector } = payload ?? {};
        if (!selector || typeof selector !== 'string') {
          sendResponse({ success: false, error: 'selector required' });
          return false;
        }
        let el;
        try { el = document.querySelector(selector); }
        catch (e) {
          sendResponse({ success: false, error: `selector syntax error: ${e.message}` });
          return false;
        }
        if (!el) {
          sendResponse({ success: true, visible: false, reason: 'not_found' });
          return false;
        }
        let rect;
        try { rect = el.getBoundingClientRect(); } catch { rect = null; }
        if (!rect || rect.width === 0 || rect.height === 0) {
          sendResponse({ success: true, visible: false, reason: 'zero_box' });
          return false;
        }
        let cs;
        try { cs = window.getComputedStyle(el); } catch { cs = null; }
        if (!cs) {
          // Detached or unusual case — treat zero-box as the signal
          sendResponse({ success: true, visible: true });
          return false;
        }
        const cssHidden = cs.display === 'none'
          || cs.visibility === 'hidden'
          || cs.visibility === 'collapse'
          || cs.opacity === '0';
        const ariaHidden = el.getAttribute('aria-hidden') === 'true';
        const visible = !cssHidden && !ariaHidden;
        sendResponse({
          success: true,
          visible,
          reason : visible ? null
                 : cssHidden ? 'css_hidden'
                 : ariaHidden ? 'aria_hidden' : 'unknown',
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },


  'EVALUATE_PREDICATE_HAS_TEXT': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { selector, value, caseSensitive } = payload ?? {};
        if (!selector || typeof selector !== 'string') {
          sendResponse({ success: false, error: 'selector required' });
          return false;
        }
        if (typeof value !== 'string') {
          sendResponse({ success: false, error: 'value (string) required' });
          return false;
        }
        let el;
        try { el = document.querySelector(selector); }
        catch (e) {
          sendResponse({ success: false, error: `selector syntax error: ${e.message}` });
          return false;
        }
        if (!el) {
          sendResponse({ success: true, hasText: false, reason: 'not_found' });
          return false;
        }
        // innerText reflects visible text (CSS-aware); textContent
        // catches hidden text. Predicate semantics target visible
        // text by default — match the user's stated intent.
        let text;
        try { text = (el.innerText ?? el.textContent ?? '').trim(); }
        catch { text = ''; }
        const needle = caseSensitive === true ? value : value.toLowerCase();
        const haystack = caseSensitive === true ? text : text.toLowerCase();
        sendResponse({ success: true, hasText: haystack.includes(needle), textLength: text.length });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },


    // v2.74.331 — PERSPECTIVE_SPEC § 4 attributeEquals predicate. Element's
    // attribute === expected value (string compare; absent attr never matches).
  'EVALUATE_PREDICATE_ATTRIBUTE_EQUALS': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { selector, attribute, value } = payload ?? {};
        if (!selector || typeof selector !== 'string') {
          sendResponse({ success: false, error: 'selector required' });
          return false;
        }
        if (!attribute || typeof attribute !== 'string') {
          sendResponse({ success: false, error: 'attribute required' });
          return false;
        }
        let el;
        try { el = document.querySelector(selector); }
        catch (e) {
          sendResponse({ success: false, error: `selector syntax error: ${e.message}` });
          return false;
        }
        if (!el) {
          sendResponse({ success: true, matches: false, reason: 'not_found' });
          return false;
        }
        const actual = el.getAttribute(attribute);
        // Absent attribute (null) never matches an expected string value.
        const matches = actual !== null && actual === String(value ?? '');
        sendResponse({ success: true, matches, actual });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },


    // v2.74.331 — PERSPECTIVE_SPEC § 4 landmarkExists predicate. The selector
    // resolves to an element in the DOM (present; visibility not required).
  'EVALUATE_PREDICATE_EXISTS': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { selector } = payload ?? {};
        if (!selector || typeof selector !== 'string') {
          sendResponse({ success: false, error: 'selector required' });
          return false;
        }
        let el;
        try { el = document.querySelector(selector); }
        catch (e) {
          sendResponse({ success: false, error: `selector syntax error: ${e.message}` });
          return false;
        }
        sendResponse({ success: true, exists: el !== null });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },


  'RESOLVE_IFRAME_BY_PREDICATE': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { predicate } = payload ?? {};
        if (!predicate || typeof predicate !== 'object' || !predicate.kind) {
          sendResponse({ success: false, error: 'valid predicate required' });
          return false;
        }
        const iframes = Array.from(document.querySelectorAll('iframe'));
        let match = null;
        let matchIdx = -1;
        switch (predicate.kind) {
          case 'iframeName':
            for (let i = 0; i < iframes.length; i++) {
              if (iframes[i].getAttribute('name') === predicate.value) {
                match = iframes[i]; matchIdx = i; break;
              }
            }
            break;
          case 'iframeSelector':
            try {
              const el = document.querySelector(predicate.selector);
              if (el && el.tagName === 'IFRAME') {
                match = el; matchIdx = iframes.indexOf(el);
              }
            } catch { /* invalid selector */ }
            break;
          case 'iframeSrcPattern': {
            const mode = predicate.mode ?? 'contains';
            for (let i = 0; i < iframes.length; i++) {
              let src;
              try { src = iframes[i].src || iframes[i].getAttribute('src') || ''; }
              catch { src = iframes[i].getAttribute('src') || ''; }
              let matches = false;
              if (mode === 'exact') {
                matches = src === predicate.pattern;
              } else if (mode === 'regex') {
                try { matches = new RegExp(predicate.pattern).test(src); }
                catch { matches = false; }
              } else {   // contains (default)
                matches = src.includes(predicate.pattern);
              }
              if (matches) { match = iframes[i]; matchIdx = i; break; }
            }
            break;
          }
          case 'iframePositional':
            if (typeof predicate.index === 'number' && predicate.index >= 0 && predicate.index < iframes.length) {
              match = iframes[predicate.index];
              matchIdx = predicate.index;
            }
            break;
          default:
            sendResponse({ success: false, error: `unknown predicate kind: ${predicate.kind}` });
            return false;
        }
        if (!match) {
          sendResponse({ success: false, reason: 'iframe-absent', error: `iframe predicate ${predicate.kind} matched no elements` });
          return false;
        }
        // Same-origin verification: attempt contentDocument access.
        // Throws SecurityError or returns null for cross-origin.
        let sameOrigin = false;
        try { sameOrigin = !!match.contentDocument; } catch { sameOrigin = false; }
        // Loaded state — readyState for same-origin; for cross-origin
        // we assume loaded if the element is present (we can't see
        // its internal state). Spec § 8 commits to load-event canonical.
        let loaded;
        if (sameOrigin) {
          try {
            const rs = match.contentDocument?.readyState;
            loaded = rs === 'complete' || rs === 'interactive';
          } catch { loaded = false; }
        } else {
          loaded = true;
        }
        let resolvedSrc;
        try { resolvedSrc = match.src || match.getAttribute('src') || ''; }
        catch { resolvedSrc = match.getAttribute('src') || ''; }
        sendResponse({
          success    : true,
          src        : resolvedSrc,
          name       : match.getAttribute('name') || null,
          id         : match.id || null,
          positional : matchIdx,
          sameOrigin,
          loaded,
        });
      } catch (err) {
        sendResponse({ success: false, error: `RESOLVE_IFRAME_BY_PREDICATE: ${err.message}` });
      }
      return false;
    }
  },


    // v2.74.250 — Phase 6.5 substrate spec: runtime action effect
    // observation. Deviation from spec: we do NOT observe every action
    // unconditionally (spec proposed a 1-3s window per action). Instead
    // we expose Begin/End primitives that the engine brackets around
    // SPECIFIC actions where observation is genuinely better than the
    // current "downstream pre-conditions validate" model — namely:
    //   (a) terminal steps (no downstream validator)
    //   (b) navigation-likely clicks (downstream step risks doc race)
    //   (c) authoring/learning loops (AI needs grounded feedback)
    //   (d) self-correction: observed vs proposed effect mismatch
    //       surfaces a landmark-effect-drift event for human review.
    //
    // Single in-flight observation per content script (one tab/frame
    // executes one step at a time). Module-scope state is fine.
  'OBSERVE_ACTION_BEGIN': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        // If a prior observation never got END'd (engine threw mid-step),
        // discard it so we don't leak the MutationObserver.
        if (__ahubActionObservation) {
          try { __ahubActionObservation.mo?.disconnect(); } catch { /* ignore */ }
          __ahubActionObservation = null;
        }
        const before = _captureObservationSnapshot();
        let mutations = 0;
        let firstMutationTs = null;
        let mo = null;
        try {
          mo = new MutationObserver(records => {
            mutations += records.length;
            if (firstMutationTs === null) firstMutationTs = Date.now();
          });
          // childList + subtree captures structural change; characterData
          // captures text rewrites. attributes excluded — noisy (class
          // toggles, aria-busy flips fire constantly for unrelated work).
          mo.observe(document.documentElement, {
            childList    : true,
            subtree      : true,
            characterData: true,
            attributes   : false,
          });
        } catch (e) {
          // MutationObserver unavailable / errored. We still complete the
          // before-snapshot; END will compute diff without mutation count.
          mo = null;
        }
        __ahubActionObservation = {
          before,
          mo,
          startTs            : Date.now(),
          getMutations       : () => mutations,
          getFirstMutationTs : () => firstMutationTs,
        };
        sendResponse({ success: true, startTs: __ahubActionObservation.startTs });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },


  'OBSERVE_ACTION_END': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const obs = __ahubActionObservation;
        if (!obs) {
          sendResponse({ success: false, error: 'no observation in progress' });
          return false;
        }
        __ahubActionObservation = null;
        try { obs.mo?.disconnect(); } catch { /* ignore */ }
        const after = _captureObservationSnapshot();
        const report = _diffObservationSnapshots(
          obs.before, after,
          obs.getMutations(), obs.getFirstMutationTs(), obs.startTs,
        );
        sendResponse({ success: true, report });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },


  'IDENTIFY_IFRAME_ELEMENT': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { frameUrl } = payload ?? {};
        if (!frameUrl || typeof frameUrl !== 'string') {
          sendResponse({ success: false, error: 'frameUrl required' });
          return false;
        }
        const iframes = Array.from(document.querySelectorAll('iframe'));
        // Match by resolved src first (most reliable — handles relative
        // URLs and protocol/host normalization), then by the raw src
        // attribute as a fallback.
        let matchIdx = -1;
        for (let i = 0; i < iframes.length; i++) {
          try {
            if (iframes[i].src === frameUrl) { matchIdx = i; break; }
          } catch { /* cross-origin iframes can throw on .src in rare cases */ }
        }
        if (matchIdx < 0) {
          // Fallback: match by attribute (raw) — some pages don't
          // resolve .src correctly when it's set programmatically.
          for (let i = 0; i < iframes.length; i++) {
            const raw = iframes[i].getAttribute('src') || '';
            if (raw === frameUrl) { matchIdx = i; break; }
          }
        }
        if (matchIdx < 0) {
          sendResponse({ success: false, error: `no iframe element in top document matches url: ${frameUrl}` });
          return false;
        }
        const el = iframes[matchIdx];
        const name = el.getAttribute('name') || null;
        const id   = el.id || null;
        const src  = el.getAttribute('src') || null;
        const resolvedSrc = (() => { try { return el.src || null; } catch { return null; } })();

        // Same-origin check: attempt contentDocument access. Browser
        // throws SecurityError for cross-origin OR returns null for
        // sandboxed iframes; both count as "not same-origin" for our
        // purposes.
        let sameOrigin = false;
        try { sameOrigin = !!el.contentDocument; } catch { sameOrigin = false; }

        // Predicate proposal per spec § 4. Walk preferences in stability
        // order; first applicable wins.
        let predicate = null;
        let contextNameSeed = '';
        if (name && name.trim()) {
          predicate = { kind: 'iframeName', value: name };
          contextNameSeed = name;
        } else if (id && id.trim() && !/^[0-9]+$/.test(id) && !/^[a-f0-9]{20,}$/i.test(id)) {
          // Skip auto-generated-looking IDs (numeric / long hex)
          predicate = { kind: 'iframeSelector', selector: `iframe#${CSS.escape(id)}` };
          contextNameSeed = id;
        } else if (resolvedSrc) {
          // Use the last-2-labels of the host as a stable substring.
          let host = '';
          try {
            const u = new URL(resolvedSrc);
            const parts = u.host.split('.').filter(Boolean);
            host = parts.slice(-2).join('.');
          } catch { host = ''; }
          if (host) {
            predicate = { kind: 'iframeSrcPattern', pattern: host, mode: 'contains' };
            contextNameSeed = host.replace(/\./g, '-');
          } else {
            // src present but not parseable — fallback to positional.
            predicate = { kind: 'iframePositional', index: matchIdx };
            contextNameSeed = `pos-${matchIdx}`;
          }
        } else {
          // No name, no id, no src — positional only.
          predicate = { kind: 'iframePositional', index: matchIdx };
          contextNameSeed = `pos-${matchIdx}`;
        }
        // Compose a stable, kebab-case context name. Prefix with
        // 'iframe-' for visual clarity in Studio.
        const contextName = 'iframe-' + String(contextNameSeed)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40);

        sendResponse({
          success         : true,
          iframeInfo      : { name, id, src: src ?? resolvedSrc, positional: matchIdx },
          sameOrigin,
          proposedPredicate: predicate,
          proposedContextName: contextName,
        });
      } catch (err) {
        sendResponse({ success: false, error: `IDENTIFY_IFRAME_ELEMENT: ${err.message}` });
      }
      return false;
    }
  },


  'LANDMARK_PROBE_OR_RECOVER': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { selector, fallback } = payload ?? {};
        // (1) Probe the stored selector. Multiple matches → ambiguous
        // (skip to heuristic). Zero matches → also heuristic.
        if (selector && typeof selector === 'string' && selector.trim()) {
          let visible;
          try {
            const all = document.querySelectorAll(selector);
            visible = Array.from(all).filter(el => {
              try {
                const r = el.getBoundingClientRect();
                return r && r.width > 0 && r.height > 0;
              } catch { return false; }
            });
          } catch (_) {
            visible = [];   // invalid selector syntax — treat as zero match
          }
          if (visible.length === 1) {
            sendResponse({ success: true, via: 'selector', selector });
            return false;
          }
          // Visible-but-ambiguous OR not-visible-but-DOM-exists cases
          // both fall through to heuristic recovery — the description
          // layer disambiguates.
        }
        // (2) Heuristic recovery from description layer.
        if (!fallback || typeof fallback !== 'object') {
          sendResponse({ success: false, via: 'fail', reason: 'no_fallback', error: 'selector failed; no description-layer fallback provided' });
          return false;
        }
        const { role, accessibleName, hierarchicalContext } = fallback;
        const recovery = _findLandmarkCandidatesByDescription({ role, accessibleName, hierarchicalContext });
        const { candidates, matchMethod, nameSimilarity, matchedName } = recovery;
        if (candidates.length === 1) {
          const recoveredSelector = _synthesizeSelectorForElement(candidates[0]);
          // v2.74.270 — Include match method + name similarity so the
          // engine can surface drift to authors when fuzzy/substring
          // matching was required. Exact match → no drift surface;
          // fuzzy match → strong "name drifted" signal worth showing.
          sendResponse({
            success    : true,
            via        : 'heuristic',
            selector   : recoveredSelector,
            matchMethod,                                // 'exact' | 'substring' | 'fuzzy' | 'role-only'
            nameSimilarity,
            authoredName : accessibleName ?? null,
            matchedName  : matchedName ?? null,
          });
          return false;
        }
        if (candidates.length === 0) {
          sendResponse({ success: false, via: 'fail', reason: 'not_found', error: `no candidates matched role="${role}" name="${accessibleName ?? ''}" (even with substring + fuzzy fallback)` });
          return false;
        }
        sendResponse({
          success: false,
          via: 'fail',
          reason: 'ambiguous',
          error: `${candidates.length} candidates matched the description — hierarchical context didn't disambiguate`,
          candidateCount: candidates.length,
          matchMethod,
        });
        return false;
      } catch (err) {
        sendResponse({ success: false, via: 'fail', reason: 'error', error: err.message });
        return false;
      }
    }
  },


  'INSPECT_ELEMENT': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      // v2.74.239 — Async handler so we can await the accessibility
      // profile computation (Web Crypto for the UID hash). Returns
      // true and resolves sendResponse from inside the async IIFE.
      (async () => {
        try {
          const { target, pickLast } = payload ?? {};
          const els = document.querySelectorAll(target);
          const matchCount = els.length;
          let el = null;
          if (matchCount > 0) {
            el = (pickLast === true) ? els[matchCount - 1] : els[0];
          }
          if (!el) {
            sendResponse({ success: false, error: `INSPECT_ELEMENT: no element matched "${target}"${_diagnoseSelectorFailure(target)}` });
            return;
          }
          const report = _buildElementInspectionReport(el, target);
          report.matchCount   = matchCount;
          report.pickLastUsed = pickLast === true;
          report.matchIndex   = pickLast === true ? (matchCount - 1) : 0;
          // v2.74.239 — Landmark identity derivation (Phase 1). Compute
          // role + accessibleName + hierarchicalContext + canonicalUrl
          // + UID via the same content-script helpers the picker will
          // use at capture time. Defensive try/catch — derivation
          // failure shouldn't break Inspect.
          try {
            report.accessibilityProfile = await _computeAccessibilityProfile(el);
          } catch (e) {
            report.accessibilityProfile = null;
            report.accessibilityProfileError = e?.message ?? String(e);
          }
          sendResponse({ success: true, report });
        } catch (err) {
          sendResponse({ success: false, error: `INSPECT_ELEMENT: ${err.message}` });
        }
      })();
      return true;
    }
  },


    // v2.74.219 — OBSERVE_CLICK_COPY: format-agnostic chat reply
    // extraction. Clicks a copy-to-clipboard button (HubSpot/ChatGPT/
    // Slack-style per-message Copy control), waits for the page's
    // onclick handler to write to navigator.clipboard, then reads the
    // clipboard. Returns whatever canonical-form text the page chose
    // to serialize — plain text for text replies, CSV for CSV, code
    // for code blocks. No DOM walking, no per-format selector chasing.
    //
    // Requires "clipboardRead" permission in manifest (added v2.74.219).
    // Async: returns `true` from the listener so the message port
    // stays open while we wait + read.
  'OBSERVE_CLICK_COPY': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      (async () => {
        try {
          const { target, waitAfterClick, pickLast } = payload ?? {};
          if (!target || typeof target !== 'string') {
            sendResponse({ success: false, error: `OBSERVE_CLICK_COPY: target selector required` });
            return;
          }
          // v2.74.222 — pickLast:true → click the LAST querySelectorAll
          // match instead of the first. Built for chat tails where N
          // copy buttons exist (one per AI message) and we want the
          // most recent message's button.
          let btn;
          let matchCount = 0;
          if (pickLast === true) {
            const els = document.querySelectorAll(target);
            matchCount = els.length;
            btn = els.length > 0 ? els[els.length - 1] : null;
          } else {
            btn = document.querySelector(target);
            matchCount = btn ? 1 : 0;
          }
          if (!btn) {
            sendResponse({ success: false, error: `OBSERVE_CLICK_COPY: no element matched "${target}"${_diagnoseSelectorFailure(target)}` });
            return;
          }
          // v2.74.224 — Intercept the page's clipboard write at the source
          // instead of reading the system clipboard. The previous design
          // (click button → page writes to clipboard → we read it) fails
          // silently during sidepanel-initiated verify: the iframe
          // document lacks OS focus, so the page's
          // navigator.clipboard.writeText() call is rejected by Chrome
          // and the system clipboard stays stale. Our offscreen read
          // then returns the prior contents, looking like success but
          // actually returning whatever the user copied last.
          //
          // The fix has three capture layers, in order of preference:
          //   1. Main-world patch on navigator.clipboard.writeText.
          //      We inject a <script> into the page's main world that
          //      wraps writeText. When HubSpot's onClick calls it, the
          //      wrapper captures the argument and dispatches a custom
          //      event back to this isolated-world content script.
          //      Bypasses focus entirely — we get the text the page
          //      INTENDED to write, regardless of whether the system
          //      clipboard write succeeded.
          //   2. document 'copy' event listener. Catches the legacy
          //      execCommand('copy') path which fires a copy event
          //      with clipboardData. Some apps still use this.
          //   3. Offscreen system clipboard read. Last resort for the
          //      rare case where the page uses some other mechanism
          //      (programmatic Selection-based copy that does land in
          //      the system clipboard).
          //
          // The patch is idempotent: a flag on `window` prevents
          // double-patching across repeated click_copy invocations.

          // Layer 1: install main-world writeText patch via background's
          // chrome.scripting.executeScript({world:'MAIN'}). Inline
          // <script> injection from a content script is blocked by
          // CSP on pages like HubSpot — extensions need to use the
          // scripting API to bypass page CSP. The patch intercepts
          // navigator.clipboard.writeText AND navigator.clipboard.write
          // (ClipboardItem-based) and dispatches a custom event we
          // listen for here.
          let capturedFromPatch = '';
          const patchEventName = '__ahub_clipboard_capture';
          const patchListener = (e) => {
            if (typeof e?.detail === 'string') capturedFromPatch = e.detail;
          };
          window.addEventListener(patchEventName, patchListener);
          let patchInstalled = false;
          try {
            const patchRes = await chrome.runtime.sendMessage({ type: 'INJECT_CLIPBOARD_PATCH_BG' });
            patchInstalled = !!patchRes?.success;
          } catch (_) { /* injection dispatch failed; fall through to lower layers */ }

          // Layer 2: document 'copy' event listener. Fires when the
          // page uses document.execCommand('copy') — a deprecated but
          // still-functional path some apps retain.
          let capturedFromCopyEvent = '';
          const copyHandler = (e) => {
            try {
              const text = e?.clipboardData?.getData?.('text/plain');
              if (typeof text === 'string' && text.length > 0) {
                capturedFromCopyEvent = text;
              }
            } catch (_) { /* ignore */ }
          };
          document.addEventListener('copy', copyHandler, { capture: true });

          // v2.74.225 — Read clipboard BEFORE the click so we can
          // definitively detect "nothing changed" after. The plain
          // btn.click() in earlier versions failed silently against
          // pointer-event-bound React buttons; we'd get the user's
          // prior clipboard contents back and incorrectly report
          // success. Now: capture pre-state, click, compare.
          let clipboardBefore = '';
          try {
            const pre = await chrome.runtime.sendMessage({ type: 'CLIPBOARD_READ_BG' });
            if (pre?.success) clipboardBefore = pre.text ?? '';
          } catch (_) { /* best-effort baseline */ }

          // v2.74.226 — Pre-click hover activation. Hover-revealed
          // action icons (HubSpot's "InteractionIconButton" pattern,
          // Slack message hover actions, ChatGPT per-turn buttons,
          // Discord message reactions) all share a React pattern: the
          // button exists in the DOM at all times, but its `onClick`
          // prop is only attached when the parent message wrapper has
          // hover state. A synthetic click against a no-onClick button
          // fires the click event but no handler runs — exactly the
          // "click had no observable effect" we've been seeing for
          // HubSpot's Copy button (vs Duplicate which is always-on
          // inside a code block and works without hover).
          //
          // Walk up to the closest plausible "hover region" ancestor
          // and dispatch mouseover+mouseenter+pointerover+pointerenter
          // on it. Give React a beat to render the now-active onClick
          // before we click.
          const hoverAncestors = [];
          // 1. Immediate parent of the button (e.g. the
          //    InteractionIconButton wrapper).
          if (btn.parentElement) hoverAncestors.push(btn.parentElement);
          // 2. The closest message wrapper — biggest scope React
          //    might be tracking hover on.
          const msgWrapper = btn.closest('[data-test-id="chat-message"]')
                          ?? btn.closest('[data-message-id]')
                          ?? btn.closest('[role="listitem"]')
                          ?? btn.closest('article');
          if (msgWrapper && !hoverAncestors.includes(msgWrapper)) {
            hoverAncestors.push(msgWrapper);
          }
          // Dispatch hover events on each candidate ancestor.
          for (const ancestor of hoverAncestors) {
            try {
              ancestor.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true,  cancelable: true, view: window }));
              ancestor.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true, view: window }));
              if (typeof PointerEvent !== 'undefined') {
                ancestor.dispatchEvent(new PointerEvent('pointerover',  { bubbles: true,  cancelable: true, pointerType: 'mouse' }));
                ancestor.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, cancelable: true, pointerType: 'mouse' }));
              }
            } catch (_) { /* ignore per-ancestor failures */ }
          }
          // Give React one frame + a small margin to re-render with
          // the hover-active onClick attached. 60ms is enough for the
          // 16ms RAF + buffer.
          await new Promise((r) => setTimeout(r, 60));

          // v2.74.225 — Dispatch a FULL pointer + mouse + click event
          // sequence rather than just btn.click(). Many React UI
          // libraries (HubSpot's UI Library, MUI, Chakra) bind onClick
          // via PointerEvent.pointerdown/pointerup rather than the
          // legacy click event. A synthetic .click() fires only the
          // click event, missing the pointer handlers — the visible
          // symptom is exactly what we just saw: click() returns,
          // nothing happens downstream, clipboard stays stale.
          //
          // Full sequence mirrors what @testing-library/user-event
          // produces, which works against every major React UI lib.
          const dispatchOne = (eventCtor, type, extra = {}) => {
            try {
              btn.dispatchEvent(new eventCtor(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                button: 0,
                buttons: type.includes('down') ? 1 : 0,
                ...extra,
              }));
            } catch (_) { /* event ctor unavailable; skip */ }
          };
          try {
            // Pointer events first — modern React + Touchable
            // components hook these.
            if (typeof PointerEvent !== 'undefined') {
              dispatchOne(PointerEvent, 'pointerover',  { pointerType: 'mouse' });
              dispatchOne(PointerEvent, 'pointerenter', { pointerType: 'mouse' });
              dispatchOne(PointerEvent, 'pointerdown',  { pointerType: 'mouse' });
            }
            // Mouse events alongside — legacy handlers still listen here.
            dispatchOne(MouseEvent, 'mousedown');
            if (typeof PointerEvent !== 'undefined') {
              dispatchOne(PointerEvent, 'pointerup', { pointerType: 'mouse' });
            }
            dispatchOne(MouseEvent, 'mouseup');
            // Native click — covers handlers attached via onClick prop.
            dispatchOne(MouseEvent, 'click');
            // Also call .click() as belt-and-suspenders. Some apps
            // listen for HTMLElement.click() specifically.
            try { btn.click(); } catch (_) {}
          } catch (e) {
            window.removeEventListener(patchEventName, patchListener);
            document.removeEventListener('copy', copyHandler, { capture: true });
            sendResponse({ success: false, error: `OBSERVE_CLICK_COPY: event dispatch failed: ${e.message}` });
            return;
          }

          // Wait for the page's async copy work to settle.
          const waitMs = Math.max(0, Math.min(5000, Number(waitAfterClick) || 150));
          await new Promise((r) => setTimeout(r, waitMs));

          // Tear down listeners.
          window.removeEventListener(patchEventName, patchListener);
          document.removeEventListener('copy', copyHandler, { capture: true });

          // Pick the captured value, with layer-1 winning over layer-2.
          let value = capturedFromPatch || capturedFromCopyEvent || '';
          let via = capturedFromPatch
            ? 'main-world-patch'
            : (capturedFromCopyEvent ? 'copy-event' : '');

          // Layer 3: offscreen clipboard read with change detection.
          // Only fires when neither intercept caught anything. Compares
          // post-click clipboard against the pre-click baseline so we
          // can distinguish "the click really copied new text" from
          // "the click did nothing and we're reading stale data."
          if (!value) {
            let bgRes;
            try {
              bgRes = await chrome.runtime.sendMessage({ type: 'CLIPBOARD_READ_BG' });
            } catch (e) {
              sendResponse({
                success: false,
                error: `OBSERVE_CLICK_COPY: nothing captured via writeText/copy intercept, and offscreen dispatch failed: ${e.message}`,
              });
              return;
            }
            if (bgRes?.success) {
              const clipboardAfter = bgRes.text ?? '';
              // v2.74.225 — Stale-clipboard detection. If the
              // clipboard contents are byte-identical to what was
              // there before the click, the click clearly didn't
              // update the clipboard. Reporting "success" with the
              // stale value would silently give the workflow whatever
              // the user had last copied — a far worse failure mode
              // than a clear error. Tell the author the click
              // produced no observable copy.
              if (clipboardAfter === clipboardBefore) {
                sendResponse({
                  success: false,
                  error: `OBSERVE_CLICK_COPY: click had no observable effect — ` +
                         `the page didn't call writeText, didn't fire a copy event, and the system clipboard is unchanged ` +
                         `(${clipboardBefore.length} chars before, ${clipboardAfter.length} after). ` +
                         `Diagnostics: main-world patch ${patchInstalled ? 'installed' : 'NOT installed (CSP block or scripting API failure)'}. ` +
                         `Likely causes: matched element isn't the actual click target, the button requires hover/focus state to activate, ` +
                         `or the page's onClick handler rejects untrusted events (isTrusted=false).`,
                  matchCount,
                  pickLastUsed: pickLast === true,
                  patchInstalled,
                });
                return;
              }
              value = clipboardAfter.trim();
              via = 'clipboard';
            } else {
              sendResponse({
                success: false,
                error: `OBSERVE_CLICK_COPY: nothing captured (writeText patch, copy event, and offscreen all empty). Likely causes: ` +
                       `the matched element isn't actually a copy button, or its handler uses a non-standard clipboard path.`,
              });
              return;
            }
          }

          const trimmed = value.trim();
          sendResponse({
            success: true,
            value: trimmed,
            via,
            valueLength: trimmed.length,
            matchCount,
            pickLastUsed: pickLast === true,
          });
        } catch (err) {
          sendResponse({ success: false, error: `OBSERVE_CLICK_COPY: ${err.message}` });
        }
      })();
      return true;   // keep the message port open for async response
    }
  },


  'OBSERVE_RAW_TEXT': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { target, pickLast, preferLeadText } = payload ?? {};
        // v2.74.214 — pickLast:true → read the LAST querySelectorAll
        // match instead of the first. Built for chat reply / log tail
        // extraction where the relevant element is the most recently
        // rendered match (text_last shape).
        const queryOne = (sel) => {
          if (pickLast === true) {
            const els = document.querySelectorAll(sel);
            return { el: els.length > 0 ? els[els.length - 1] : null, count: els.length };
          }
          const e = document.querySelector(sel);
          return { el: e, count: e ? 1 : 0 };
        };
        let { el, count: matchCount } = queryOne(target);
        // v2.74.1008 — Relaxation fallback. A read demonstrated over a dynamic
        // list captures the FULL class-chain of one specific item (Indeed's
        // per-posting `job_<hash>` + per-render state/layout classes), so the
        // exact selector matches 0 on a FRESH result set and the read
        // hard-fails — the cross-Ground data-handoff break (findings
        // 2026-06-13 21:54). On a miss, retry progressively-relaxed selectors
        // (most-specific first) and take the first that resolves; the read
        // then lands on the same archetype (the top result card).
        let healedSelector = null;
        if (!el) {
          for (const relaxed of selectorRelaxations(target)) {
            const r = queryOne(relaxed);
            if (r.el) { el = r.el; matchCount = r.count; healedSelector = relaxed; break; }
          }
        }
        if (!el) {
          sendResponse({ success: false, error: `OBSERVE_RAW_TEXT: no element matched "${target}"${_diagnoseSelectorFailure(target)}` });
          return false;
        }
        // v2.74.216 — text_last uses innerText (visible-text semantics)
        // instead of textContent (every-text-node-in-DOM). innerText
        // respects CSS display:none / visibility:hidden, so it
        // automatically strips out hidden accessibility-helper spans
        // (e.g. HubSpot's `HiddenMeasure__InnerMeasure-*` and other
        // off-screen measurement nodes) that would otherwise duplicate
        // content ("Adam MillerAdam Miller"). textContent is preserved
        // for the legacy text shape so back-compat is intact.
        //
        // innerText is slightly more expensive (forces layout) but
        // chat-reply extraction runs after a wait gate — latency
        // overhead is negligible compared to network round-trips.
        // v2.74.1009 — preferLeadText narrows a CONTAINER read (list
        // fall-through, see RUN_OBSERVATION) to its title-like lead node so a
        // job CARD returns "IT Support Technician", not the whole concatenated
        // card. No-op for leaf selectors (scalar reads keep full textContent).
        let value, leadTag = null;
        if (pickLast === true) {
          value = (el.innerText ?? el.textContent ?? '').trim();
        } else if (preferLeadText === true) {
          const lead = _leadTextOf(el);
          value = lead.value; leadTag = lead.tag;
        } else {
          value = (el.textContent ?? '').trim();
        }
        sendResponse({
          success: true,
          value,
          // v2.74.1009 — tag name of the lead node when the container read was
          // narrowed (h1–h6 / a), else null; let the executor log the narrowing.
          leadTag,
          // v2.74.214 — Surface match count for text_last so verify's
          // status pill can say "captured last of N matches" — useful
          // confirmation that pickLast is doing the right thing.
          matchCount,
          pickLastUsed: pickLast === true,
          // v2.74.216 — Tell the side panel which read mode was used so
          // the verify summary can mention it ("via innerText").
          textMode: pickLast === true ? 'innerText' : 'textContent',
          // v2.74.1008 — Non-null when the exact selector missed and a
          // relaxed variant resolved the read; surfaced so the executor can
          // log the heal in the trace (the read recovered from a brittle
          // capture-time selector).
          healedSelector,
        });
      } catch (err) {
        sendResponse({ success: false, error: `OBSERVE_RAW_TEXT: ${err.message}` });
      }
      return false;
    }
  },


  'OBSERVE_RAW_HTML': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { target } = payload ?? {};
        const el = document.querySelector(target);
        if (!el) {
          sendResponse({ success: false, error: `OBSERVE_RAW_HTML: no element matched "${target}"${_diagnoseSelectorFailure(target)}` });
          return false;
        }
        sendResponse({ success: true, value: el.outerHTML ?? '' });
      } catch (err) {
        sendResponse({ success: false, error: `OBSERVE_RAW_HTML: ${err.message}` });
      }
      return false;
    }
  },


    // v2.72.14 (Pass 6) — OBSERVE_SECTION: capture a region as a structured
    // section value. Walks the target's DOM subtree producing:
    //   - markdown: prose with structure preserved (paragraphs, headings,
    //     emphasis, links, lists). Hand-rolled minimal walker; tables,
    //     blockquotes, and code blocks degrade to plain text.
    //   - text: plain text, no structure markers.
    //   - images: array of {src, alt, width, height, currentSrc, srcset}
    //     for each <img> in the subtree.
    //   - links: array of {href, text, title} for each <a href> in the
    //     subtree.
    //
    // Returns:
    //   { success: true, section: { markdown, text, images, links } }
    //
    // Source URL and timestamp are added engine-side, not here — the
    // content script doesn't know the canonical tab URL (window.location
    // works but the engine has chrome.tabs.get for canonical answers).
  'OBSERVE_SECTION': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { target } = payload ?? {};
        const el = document.querySelector(target);
        if (!el) {
          sendResponse({ success: false, error: `OBSERVE_SECTION: no element matched "${target}"${_diagnoseSelectorFailure(target)}` });
          return false;
        }
        const markdown = htmlToMarkdown(el);
        const text     = (el.textContent ?? '').trim();
        const images   = extractImageRefs(el);
        const links    = extractLinkRefs(el);
        sendResponse({
          success: true,
          section: { markdown, text, images, links },
        });
      } catch (err) {
        sendResponse({ success: false, error: `OBSERVE_SECTION: ${err.message}` });
      }
      return false;
    }
  },


    // v2.72.14 (Pass 6) — OBSERVE_IMAGE_REFS: capture all <img> descendants
    // of the target as a list of records. Each record carries the URL
    // attributes and natural/rendered dimensions.
    //
    // No vision-LLM cost (T1 only). For T3 image capture (pixel bytes via
    // Opus), use shape='image' or 'image_list' instead.
    //
    // Returns:
    //   { success: true, images: [{ src, alt, width, height, currentSrc, srcset }, ...] }
  'OBSERVE_IMAGE_REFS': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { target } = payload ?? {};
        const el = document.querySelector(target);
        if (!el) {
          sendResponse({ success: false, error: `OBSERVE_IMAGE_REFS: no element matched "${target}"${_diagnoseSelectorFailure(target)}` });
          return false;
        }
        sendResponse({ success: true, images: extractImageRefs(el) });
      } catch (err) {
        sendResponse({ success: false, error: `OBSERVE_IMAGE_REFS: ${err.message}` });
      }
      return false;
    }
  },


    // v2.74.15 (Ship A) — T1 image capture: target must resolve to an
    // <img> element. Returns its src/alt/width/height for binding as a
    // tagged image scope value (see Services/Scope.js image()). Distinct
    // from OBSERVE_SCALAR with extract.kind='attribute' (which returns
    // a plain string) and from OBSERVE_IMAGE_REFS (which returns a list
    // of <img> records under a container).
  'OBSERVE_IMAGE_T1': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { target } = payload ?? {};
        const el = document.querySelector(target);
        if (!el) {
          sendResponse({ success: false, error: `OBSERVE_IMAGE_T1: no element matched "${target}"${_diagnoseSelectorFailure(target)}` });
          return false;
        }
        if (el.tagName !== 'IMG') {
          sendResponse({ success: false, error: `OBSERVE_IMAGE_T1: target "${target}" resolved to <${el.tagName.toLowerCase()}>, expected <img>` });
          return false;
        }
        sendResponse({
          success: true,
          image: {
            src    : el.getAttribute('src') ?? '',
            alt    : el.getAttribute('alt') ?? '',
            width  : Number(el.naturalWidth) || Number(el.width) || 0,
            height : Number(el.naturalHeight) || Number(el.height) || 0,
          },
        });
      } catch (err) {
        sendResponse({ success: false, error: `OBSERVE_IMAGE_T1: ${err.message}` });
      }
      return false;
    }
  },


    // v2.74.15 (Ship A) — T1 image_list capture: target resolves to a
    // container; engine queries `target.querySelectorAll('img')` and
    // returns a list. Each item has src/alt/width/height. The engine
    // wraps each as a tagged image scope value, then a tagged list of
    // those. Distinct from OBSERVE_IMAGE_REFS (which produces a list of
    // RECORDS — list-of-records-shape — not a list of image-tagged values).
  'OBSERVE_IMAGE_LIST_T1': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        const { target } = payload ?? {};
        const el = document.querySelector(target);
        if (!el) {
          sendResponse({ success: false, error: `OBSERVE_IMAGE_LIST_T1: no element matched "${target}"${_diagnoseSelectorFailure(target)}` });
          return false;
        }
        sendResponse({ success: true, images: extractImageRefs(el) });
      } catch (err) {
        sendResponse({ success: false, error: `OBSERVE_IMAGE_LIST_T1: ${err.message}` });
      }
      return false;
    }
  },


    // v2.72.2 (Pass 3c.0) — Live-page selector picker.
    // START_PICK: activate hover-highlight + click-capture mode.
    //   payload: { sessionId, mode? }
    //     sessionId: opaque token used to correlate the eventual capture
    //                back to the originator (so a stale capture from a
    //                previous session can be ignored).
    //     mode: 'target' (default) — picks an element on the page.
    //           Future modes ('field-scoped') would constrain selection;
    //           3c.0 only ships 'target'.
    //   Sends an PICK_RESULT message back via runtime.sendMessage when
    //   the user clicks (or PICK_CANCELLED on ESC).
    // CANCEL_PICK: tear down picker without capture.
  'START_PICK': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        // v2.74.163 — Same-origin frame gate.
        // v2.74.164 — Diagnostic logging so the picker's activation
        // path is recoverable from the iframe's DevTools console
        // (one log per frame on every START_PICK). Helps distinguish
        // "frame never received the message" from "frame received
        // but refused same-origin" from "frame activated but the
        // overlay never appeared."
        const isTop = window.top === window.self;
        let sameOrigin = true;
        let probeError = null;
        if (!isTop) {
          try {
            sameOrigin = window.top.location.origin === window.location.origin;
          } catch (e) {
            sameOrigin = false;
            probeError = e?.message ?? String(e);
          }
        }
        const ctx = {
          isTop,
          sameOrigin,
          probeError,
          ownOrigin: window.location.origin,
          ownHref: window.location.href,
          bodyReady: !!document.body,
          readyState: document.readyState,
        };
        console.info('[Agent HUB picker] START_PICK received', ctx);
        if (!sameOrigin) {
          sendResponse({ success: false, error: 'cross-origin frame — skipped', ctx });
          return false;
        }
        if (!document.body) {
          // Defensive: startPicker appends to document.body. Refuse
          // cleanly if the body isn't parsed yet (very early
          // document_start race). This shouldn't happen in normal
          // flow — the user clicks Pick well after the page loaded —
          // but logging it makes the cause obvious if it does.
          sendResponse({ success: false, error: 'document.body not ready', ctx });
          return false;
        }
        startPicker(payload?.sessionId ?? '', {
          mode: payload?.mode,
          containerSelector: payload?.containerSelector,
          multiCandidate: payload?.multiCandidate,
          labelMode: payload?.labelMode,
        });
        console.info('[Agent HUB picker] activated', { isTop, ownHref: window.location.href });
        sendResponse({ success: true, ctx });
      } catch (err) {
        console.warn('[Agent HUB picker] START_PICK threw', err);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },

  'CANCEL_PICK': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        console.info('[Agent HUB picker] CANCEL_PICK received', {
          isTop: window.top === window.self,
          active: __pickerActive,
          href: window.location.href,
        });
        stopPicker(/* notify */ false);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },


    // v2.74.19 — Snap (free-extract): click-and-drag rectangle on the
    // page. mousedown begins the rect, drag updates it, mouseup commits
    // and posts SNAP_RESULT to the runtime. ESC cancels.
  'START_SNAP': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        startSnap(payload?.sessionId ?? '');
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },

  'CANCEL_SNAP': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        stopSnap(/* notify */ false);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },


    // v2.74.20 — Brief visual flash on the page after a snap-verify
    // capture, so the author sees the capture occurred. The capture
    // itself is invisible (chrome.tabs.captureVisibleTab is a no-op
    // from the page's perspective); without this, "verify" feels like
    // it does nothing. Sent by background after capture completes.
  'SHOW_CAPTURE_FLASH': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        showCaptureFlash(payload?.rect ?? null);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },


    // v2.74.151 — Debug-mode observation overlay. ExecutionEngine sends
    // these around each OBSERVATION step so the watcher sees what's
    // being captured. Cheap fire-and-forget — never blocks runtime.
  'SHOW_OBSERVATION_OVERLAY': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        showObservationOverlay(payload ?? {});
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },

  'HIDE_OBSERVATION_OVERLAY': (message, _sender, sendResponse) => {
    const { type, payload } = message; void type; void payload;
    {
      try {
        hideObservationOverlay();
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
  },

};

// The six-line dispatcher (CR-X4a). To add a message type: add a key above — nothing else.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = MESSAGE_HANDLERS[message?.type];
  if (!handler) return false;   // unknown type — the legacy switch's default
  return handler(message, _sender, sendResponse);
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.72.2 (Pass 3c.0) — Live-page selector picker
// ═══════════════════════════════════════════════════════════════════════════
//
// When activated via START_PICK message, the picker:
//   1. Adds a fixed-position overlay div (translucent purple outline) that
//      tracks the element under the cursor.
//   2. Captures the next click anywhere on the page, generates a selector
//      for the clicked element, and posts PICK_RESULT back via
//      runtime.sendMessage. Deactivates after the click.
//   3. ESC key cancels (sends PICK_CANCELLED).
//   4. Outline + handlers torn down on any exit.
//
// Selector synthesis priority:
//   (a) #id — only if id looks stable (no hash-like suffix).
//   (b) [data-testid=...] / [data-test=...] / [data-cy=...]
//   (c) [aria-label=...]
//   (d) tagName.className — only when class doesn't look generated.
//   (e) Structural fallback — tagName + nth-of-type chain (≤4 levels).

var __pickerActive       = false;
var __pickerSessionId    = '';
var __pickerOverlay      = null;
var __pickerLastTarget   = null;
var __pickerOnMouseMove  = null;
var __pickerOnClick      = null;
var __pickerOnKeyDown    = null;
var __pickerOnContextMenu = null;
// v2.72.61 — Block pre-click events too. Frameworks (React, Vue, etc.)
// often bind to pointerdown/mousedown/touchstart and run their handlers
// before the browser fires `click`. Even with preventDefault on click,
// the framework's handler has already executed. To stop this we
// intercept the early events at capture phase and block them.
var __pickerOnPointerDown = null;
var __pickerOnMouseDown   = null;
var __pickerOnPointerUp   = null;
var __pickerOnMouseUp     = null;
var __pickerOnTouchStart  = null;
var __pickerOnTouchEnd    = null;
// v2.72.5 (Pass 3c.1) — mode + container for field-scoped picking.
var __pickerMode             = 'target';
var __pickerContainerSelector = '';
// v2.72.6 (Pass 3c.2) — return all candidates instead of just one.
var __pickerMultiCandidate   = false;
// v2.72.93 — Label-extraction mode. 'single' (default) returns a single
// element's label via extractElementLabel; 'container' enumerates option
// children and returns a comma-list. Used for CLICK_BY_LABEL container
// picks so the saved pickedLabel reads as a list of options instead of
// a wall of concatenated textContent.
var __pickerLabelMode        = 'single';

// v2.74.163 — Frame info attached to every PICK_RESULT so the sidepanel
// can route per-frame at save time. Top-frame picks return null (the
// sidepanel treats null as "top frame" and skips the frameUrl field on
// the saved action — keeps rawJson clean for the back-compat case).
// Same-origin iframes return their own URL; cross-origin iframes never
// reach this code because the START_PICK handler refuses to activate
// them.
function __pickerFrameInfo() {
  if (window.top === window.self) return null;
  return {
    url  : window.location.href,
    isTop: false,
  };
}

function startPicker(sessionId, opts = {}) {
  // If a previous session is active, tear it down silently first.
  if (__pickerActive) stopPicker(false);

  __pickerActive    = true;
  __pickerSessionId = String(sessionId || '');
  __pickerMode             = opts.mode === 'field' ? 'field' : 'target';
  __pickerContainerSelector = String(opts.containerSelector || '');
  __pickerMultiCandidate   = opts.multiCandidate === true;
  __pickerLabelMode        = opts.labelMode === 'container' ? 'container' : 'single';

  // Build the overlay element. Fixed position so it floats above page
  // content; pointer-events: none so it doesn't intercept the click that
  // captures the underlying element.
  __pickerOverlay = document.createElement('div');
  __pickerOverlay.setAttribute('data-agent-hub-picker-overlay', '1');
  __pickerOverlay.style.cssText = [
    'position: fixed',
    'pointer-events: none',
    'z-index: 2147483646',  // one below max — overlay panels don't usually exceed this
    'border: 2px solid #a78bfa',
    'background: rgba(167, 139, 250, 0.15)',
    'border-radius: 2px',
    'transition: top 0.04s linear, left 0.04s linear, width 0.04s linear, height 0.04s linear',
    'top: 0',
    'left: 0',
    'width: 0',
    'height: 0',
    'box-sizing: border-box',
    'display: none',
  ].join(';');
  document.body.appendChild(__pickerOverlay);

  // v2.74.164 — Armed badge for iframe pickers. The top-frame picker
  // has the Studio's "Cancel (Esc)" banner as visual confirmation that
  // the picker is alive; iframes have nothing equivalent. When the
  // user moves into an iframe and sees no overlay, they can't tell
  // whether the iframe picker didn't activate OR is active but waiting
  // for mousemove. This small fixed-position chip in the iframe's
  // bottom-right corner gives a clear signal. Top frame skips this
  // (the Studio banner already serves the same purpose at the top).
  if (window.top !== window.self) {
    const armed = document.createElement('div');
    armed.setAttribute('data-agent-hub-picker-armed', '1');
    armed.style.cssText = [
      'position: fixed',
      'right: 12px', 'bottom: 12px',
      'z-index: 2147483647',
      'padding: 6px 10px',
      'background: rgba(20, 18, 36, 0.92)',
      'color: #c7c0ff',
      'border: 1px solid rgba(167, 139, 250, 0.55)',
      'border-radius: 4px',
      'font: 600 11px ui-monospace, SFMono-Regular, monospace',
      'pointer-events: none',
      'box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35)',
    ].join(';');
    armed.textContent = '◉ picker armed (iframe)';
    document.body.appendChild(armed);
  }

  __pickerOnMouseMove = (e) => {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === __pickerOverlay) return;
    // v2.74.163 — Frame-aware hover. When the cursor is over an
    // <iframe> element, the top-frame picker shouldn't outline the
    // iframe — the iframe's own picker is already tracking elements
    // inside its document. Showing two overlays at once is confusing,
    // and the top-frame outline of the iframe is rarely what the
    // author wants. Suppress and let the inner picker take over.
    if (target.tagName === 'IFRAME') {
      __pickerOverlay.style.display = 'none';
      __pickerLastTarget = target;   // remember so we don't re-process every mousemove
      return;
    }
    if (target === __pickerLastTarget) return;
    __pickerLastTarget = target;
    const rect = target.getBoundingClientRect();
    __pickerOverlay.style.display = 'block';
    __pickerOverlay.style.top    = `${rect.top}px`;
    __pickerOverlay.style.left   = `${rect.left}px`;
    __pickerOverlay.style.width  = `${rect.width}px`;
    __pickerOverlay.style.height = `${rect.height}px`;
  };

  __pickerOnClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target) {
      // No element under cursor — just cancel.
      stopPicker(true, /* cancelled */ true);
      return;
    }

    // v2.72.5 (Pass 3c.1) — Field mode requires the click to be inside a
    // container that document.querySelectorAll(containerSelector) returns.
    // Synthesis is then relative to that container's subtree.
    let scopeRoot = document;
    if (__pickerMode === 'field') {
      if (!__pickerContainerSelector) {
        chrome.runtime.sendMessage({
          type: 'PICK_CANCELLED',
          sessionId: __pickerSessionId,
          reason: 'no_container_selector',
        }).catch(() => {});
        stopPicker(false);
        return;
      }
      let containers;
      try {
        containers = document.querySelectorAll(__pickerContainerSelector);
      } catch (err) {
        chrome.runtime.sendMessage({
          type: 'PICK_CANCELLED',
          sessionId: __pickerSessionId,
          reason: `bad_container_selector: ${err.message}`,
        }).catch(() => {});
        stopPicker(false);
        return;
      }
      if (containers.length === 0) {
        chrome.runtime.sendMessage({
          type: 'PICK_CANCELLED',
          sessionId: __pickerSessionId,
          reason: 'container_no_match',
        }).catch(() => {});
        stopPicker(false);
        return;
      }
      // Find the container that contains the clicked target.
      let owningContainer = null;
      for (const c of containers) {
        if (c.contains(target)) { owningContainer = c; break; }
      }
      if (!owningContainer) {
        // Target is not inside any container match. Send a "miss" result so
        // the studio can update the banner; don't tear down the picker —
        // user can try again. Note: stopping is the simpler v1 contract;
        // doing fault-tolerant retry is 3c.3 territory.
        chrome.runtime.sendMessage({
          type: 'PICK_RESULT',
          sessionId: __pickerSessionId,
          error: 'click_outside_container',
          tagName: target.tagName.toLowerCase(),
          frame: __pickerFrameInfo(),
        }).catch(() => {});
        stopPicker(false);
        return;
      }
      if (owningContainer === target) {
        // User clicked the container itself. That's a valid pick but
        // gives a useless empty selector for inside-container query —
        // surface as click-outside since field selectors must point at
        // descendants of the container.
        chrome.runtime.sendMessage({
          type: 'PICK_RESULT',
          sessionId: __pickerSessionId,
          error: 'click_container_itself',
          tagName: target.tagName.toLowerCase(),
          frame: __pickerFrameInfo(),
        }).catch(() => {});
        stopPicker(false);
        return;
      }
      scopeRoot = owningContainer;
    }

    // v2.74.196 — Container-aware pick. When labelMode is 'container'
    // (CLICK_BY_LABEL actions), walk up from the clicked option to
    // the enclosing list/menu container and use THAT for selector
    // synthesis. Without this, picking "Jeremiah" in a contacts list
    // captured the selector for the `<li>Jeremiah</li>` row — not
    // the list itself, which is what CLICK_BY_LABEL needs for its
    // `selector` field. The clicked element's tagName + label are
    // still preserved for diagnostics; only the synthesisTarget
    // changes.
    let synthesisTarget = target;
    if (__pickerLabelMode === 'container') {
      const container = _resolveContainerAncestor(target);
      if (container && container !== target) {
        synthesisTarget = container;
      }
    }

    // v2.72.6 (Pass 3c.2) — When multiCandidate is set, return ranked
    // candidates and let the studio show a chooser. Otherwise emit one
    // best-effort selector (3c.0 contract).
    if (__pickerMultiCandidate) {
      let candidates;
      try {
        candidates = synthesizeCandidates(synthesisTarget, scopeRoot);
      } catch (_) {
        candidates = [];
      }
      if (!candidates || candidates.length === 0) {
        chrome.runtime.sendMessage({
          type: 'PICK_RESULT',
          sessionId: __pickerSessionId,
          error: 'no_candidate',
          tagName: synthesisTarget.tagName.toLowerCase(),
          frame: __pickerFrameInfo(),
        }).catch(() => {});
        stopPicker(false);
        return;
      }
      chrome.runtime.sendMessage({
        type: 'PICK_RESULT',
        sessionId: __pickerSessionId,
        candidates,
        tagName: synthesisTarget.tagName.toLowerCase(),
        // v2.72.87 — Same label extraction as single-candidate path.
        // v2.72.93 — Container-mode label is a comma-list of option
        // labels (used by CLICK_BY_LABEL); single-mode is the existing
        // priority chain (aria-label, textContent, etc.).
        // v2.74.196 — When the picker walked up to a container,
        // extractContainerLabel runs on the container (returns the
        // comma-list of all option labels), not the original target.
        label: __pickerLabelMode === 'container'
          ? extractContainerLabel(synthesisTarget)
          : extractElementLabel(target),
        hint: pickerHint(synthesisTarget),
        frame: __pickerFrameInfo(),
      }).catch(() => {});
      stopPicker(false);
      return;
    }

    // Single best-effort candidate (3c.0 / 3c.1 default).
    let selector;
    try {
      selector = synthesizeSelector(synthesisTarget, scopeRoot);
    } catch (err) {
      selector = null;
    }
    if (!selector) {
      stopPicker(true, true);
      return;
    }
    // v2.74.296 — Authoritative rect of the literally-clicked element.
    // Downstream (screenshot capture, identity hashing, overlays) was
    // previously deriving the rect by re-resolving the synthesized
    // selector via INSPECT_ELEMENT — but when the structural selector
    // is ambiguous (same-tag/same-class siblings beyond maxDepth) that
    // re-resolution can return a DIFFERENT element than the one clicked.
    // The picker's elementFromPoint result here is the source of truth,
    // independent of selector quality.
    const _clickedRect = target.getBoundingClientRect();
    const _synthRect   = synthesisTarget.getBoundingClientRect();
    const pickedRect = {
      x: _synthRect.x, y: _synthRect.y, width: _synthRect.width, height: _synthRect.height,
    };
    // v2.74.301 — REVERTED v2.74.299's async profile computation.
    // The async IIFE wrapping chrome.runtime.sendMessage caused
    // PICK_RESULT to never reach the sidepanel under some conditions
    // (Web Crypto stall, profile-derivation exception during a tear-down
    // race) — leaving the banner up forever with no landmark added.
    // The picker now sends PICK_RESULT synchronously again with the
    // authoritative pickedRect + viewportInfo. The substrate's geometric
    // verification uses IoU against pickedRect alone — UID match was
    // always a redundant signal and (as v2.74.299's log showed) could be
    // wrong anyway when sourced from INSPECT on an ambiguous selector.
    // OBS-READ — a VALUE-INDEPENDENT structural selector (tag + STABLE class + :nth-of-type, never the
    // aria-label/text that synthesizeSelector may fall back to on obfuscated markup). An OBSERVATION of "the first
    // job title" wants the POSITION, not this instance's title text — so the read survives the list changing.
    let structuralSelector = null;
    try { structuralSelector = computeUniqueSelector(synthesisTarget) || null; } catch { /* */ }
    // OBS-READ landmark recovery — the SYNCHRONOUS description layer (role + accessibleName +
    // hierarchicalContext) so an observation can self-heal via LANDMARK_PROBE_OR_RECOVER when its stored
    // selector breaks (page re-skin / framework swap). These three are pure sync DOM reads — NOT the async
    // accessibility profile (whose Web-Crypto UID derivation was reverted out of the picker hot path in
    // v2.74.301 because it could stall PICK_RESULT). role drives recovery's first gate, so capturing a real
    // a11y role here (e.g. 'link'/'heading') instead of the OBSERVE_CAPTURE default 'region' is what makes
    // recovery actually fire for typical read targets.
    let landmark = null;
    try {
      landmark = {
        selector: structuralSelector || selector,
        role: _computeA11yRole(synthesisTarget) || null,
        accessibleName: _computeAccessibleName(synthesisTarget) || null,
        hierarchicalContext: _computeHierarchicalContext(synthesisTarget) || null,
      };
    } catch { /* description layer is best-effort; the selector still works without it */ }
    // OBS-READ positional/archetype selector — when the picked element is one item in a REPEATING list,
    // this is a value-independent selector matching the analogous element in EVERY item + the picked index.
    // It's the robust path for "the first/Nth job" reads (survives the list changing); null when the element
    // isn't part of a repeat (the read falls back to the structural/unique selector).
    let archetype = null;
    try { archetype = computeArchetypeSelector(synthesisTarget); } catch { /* best-effort */ }
    chrome.runtime.sendMessage({
      type: 'PICK_RESULT',
      sessionId: __pickerSessionId,
      selector,
      structuralSelector,
      archetype,
      landmark,
      tagName: synthesisTarget.tagName.toLowerCase(),
      // v2.72.87 — Human-readable label extracted from the picked element.
      // v2.72.93 — Container-mode label is a comma-list of option labels.
      // v2.74.196 — Container-mode runs against the resolved container.
      label: __pickerLabelMode === 'container'
        ? extractContainerLabel(synthesisTarget)
        : extractElementLabel(target),
      hint: pickerHint(synthesisTarget),
      frame: __pickerFrameInfo(),
      // v2.74.296 — Authoritative rects + DPR for the screenshot helper.
      pickedRect,
      clickedRect: { x: _clickedRect.x, y: _clickedRect.y, width: _clickedRect.width, height: _clickedRect.height },
      viewportInfo: {
        dpr           : (typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0) ? window.devicePixelRatio : 1,
        viewportWidth : window.innerWidth ?? 0,
        viewportHeight: window.innerHeight ?? 0,
      },
    }).catch(() => { /* studio tab may have closed; fine */ });
    stopPicker(false);  // already notified
  };

  __pickerOnKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stopPicker(true, true);
    }
  };

  // Right-click cancel — common UX expectation. Suppresses context menu.
  __pickerOnContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopPicker(true, true);
  };

  // v2.72.61 — Pre-click blockers. Many frameworks (React, Vue, Svelte,
  // jQuery in capture mode, native delegated handlers) attach to
  // pointerdown / mousedown / touchstart and fire their handlers BEFORE
  // the browser dispatches `click`. preventDefault on click is too late
  // — the framework handler has already run. To make Pick selector-only
  // (no native side effects), we intercept all the pre-click events at
  // capture phase and block them with stopImmediatePropagation +
  // preventDefault. The actual selector capture still happens on `click`.
  const blockEvent = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  __pickerOnPointerDown = blockEvent;
  __pickerOnMouseDown   = blockEvent;
  __pickerOnPointerUp   = blockEvent;
  __pickerOnMouseUp     = blockEvent;
  __pickerOnTouchStart  = blockEvent;
  __pickerOnTouchEnd    = blockEvent;

  // Capture phase + true so we beat page-level handlers.
  document.addEventListener('mousemove', __pickerOnMouseMove, true);
  document.addEventListener('click', __pickerOnClick, true);
  document.addEventListener('keydown', __pickerOnKeyDown, true);
  document.addEventListener('contextmenu', __pickerOnContextMenu, true);
  // v2.72.61 — Pre-click blockers.
  document.addEventListener('pointerdown', __pickerOnPointerDown, true);
  document.addEventListener('mousedown',   __pickerOnMouseDown,   true);
  document.addEventListener('pointerup',   __pickerOnPointerUp,   true);
  document.addEventListener('mouseup',     __pickerOnMouseUp,     true);
  document.addEventListener('touchstart',  __pickerOnTouchStart,  { capture: true, passive: false });
  document.addEventListener('touchend',    __pickerOnTouchEnd,    { capture: true, passive: false });
}

function stopPicker(notify, cancelled) {
  // v2.74.169 — Defensively clean up ANY picker overlay elements,
  // even when __pickerActive is false. The previous early-return on
  // !__pickerActive could leave orphans if state ever desynced (e.g.
  // a CANCEL_PICK arrives twice, an unhandled exception left
  // __pickerActive=false but the overlay still mounted, or the
  // armed-badge wasn't cleared on a prior session's edge case).
  // Removing by the data-* selector catches every overlay in the
  // document, not just the one cached in __pickerOverlay.
  console.info('[Agent HUB picker] stopPicker', { active: __pickerActive, notify, cancelled, isTop: window.top === window.self });
  try {
    document.querySelectorAll('[data-agent-hub-picker-overlay]').forEach(el => {
      el.parentNode?.removeChild(el);
    });
  } catch { /* ignore */ }
  if (!__pickerActive) {
    // Still clean up the armed badge below before returning.
    try {
      document.querySelectorAll('[data-agent-hub-picker-armed]').forEach(el => {
        el.parentNode?.removeChild(el);
      });
    } catch { /* ignore */ }
    return;
  }
  __pickerActive = false;
  __pickerOverlay = null;
  __pickerLastTarget = null;
  // v2.74.164 — Tear down the iframe-only "armed" badge added by
  // startPicker. The selector matches both armed and (future) other
  // badges; cheap to clean up all of them so a re-pick session doesn't
  // leave orphans.
  try {
    document.querySelectorAll('[data-agent-hub-picker-armed]').forEach(el => {
      el.parentNode?.removeChild(el);
    });
  } catch { /* ignore */ }
  document.removeEventListener('mousemove', __pickerOnMouseMove, true);
  document.removeEventListener('click', __pickerOnClick, true);
  document.removeEventListener('keydown', __pickerOnKeyDown, true);
  document.removeEventListener('contextmenu', __pickerOnContextMenu, true);
  // v2.72.61 — Pre-click blockers.
  document.removeEventListener('pointerdown', __pickerOnPointerDown, true);
  document.removeEventListener('mousedown',   __pickerOnMouseDown,   true);
  document.removeEventListener('pointerup',   __pickerOnPointerUp,   true);
  document.removeEventListener('mouseup',     __pickerOnMouseUp,     true);
  document.removeEventListener('touchstart',  __pickerOnTouchStart,  { capture: true });
  document.removeEventListener('touchend',    __pickerOnTouchEnd,    { capture: true });
  __pickerOnMouseMove = null;
  __pickerOnClick = null;
  __pickerOnKeyDown = null;
  __pickerOnContextMenu = null;
  __pickerOnPointerDown = null;
  __pickerOnMouseDown = null;
  __pickerOnPointerUp = null;
  __pickerOnMouseUp = null;
  __pickerOnTouchStart = null;
  __pickerOnTouchEnd = null;
  if (notify) {
    chrome.runtime.sendMessage({
      type: 'PICK_CANCELLED',
      sessionId: __pickerSessionId,
      reason: cancelled ? 'user_cancel' : 'no_target',
    }).catch(() => {});
  }
  __pickerSessionId = '';
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.74.46 — Perspective-capture verification overlays
// ═══════════════════════════════════════════════════════════════════════════
//
// Persistent, multi-element overlays drawn around verified perspective
// landmarks (one per landmark, with the role displayed as a small
// label). The perspective-capture sidepanel mode sends:
//
//   SHOW_PERSPECTIVE_OVERLAYS  payload: { landmarks: [{alias, selector}, …] }
//   CLEAR_PERSPECTIVE_OVERLAYS payload: (none)
//
// These are separate from the picker overlay system (different DOM
// marker, separate state). Position is absolute in document coords so
// the overlays scroll naturally with the page.

var __perspectiveOverlays = [];

function showPerspectiveOverlays(landmarks) {
  clearPerspectiveOverlays();
  if (!Array.isArray(landmarks)) return;
  for (const lm of landmarks) {
    if (!lm || typeof lm.selector !== 'string' || !lm.selector.trim()) continue;
    let el;
    try { el = document.querySelector(lm.selector); } catch { continue; }
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    // Skip elements that are display:none / removed (zero box).
    if (rect.width === 0 && rect.height === 0) continue;
    const overlay = document.createElement('div');
    overlay.setAttribute('data-agent-hub-perspective-overlay', '1');
    // v2.74.233 — Green accent (was violet). Green signals "I am
    // actively highlighting this landmark" — set by the per-landmark
    // Show toggle in the sidepanel. Violet was retired here because
    // violet is now reserved for Claude-assisted affordances (Ask
    // Claude, rediscover button) elsewhere in the UI.
    overlay.style.cssText = [
      'position: absolute',
      'pointer-events: none',
      'z-index: 2147483645',
      'border: 2px solid #4ade80',
      'background: rgba(74, 222, 128, 0.12)',
      'border-radius: 2px',
      `top: ${rect.top + window.scrollY}px`,
      `left: ${rect.left + window.scrollX}px`,
      `width: ${rect.width}px`,
      `height: ${rect.height}px`,
      'box-sizing: border-box',
    ].join(';');
    // Alias label in the top-left corner so the user can tell which
    // landmark is which when multiple overlays are visible.
    if (lm.alias && typeof lm.alias === 'string') {
      const label = document.createElement('div');
      label.style.cssText = [
        'position: absolute',
        'top: -16px',
        'left: -2px',
        'background: #4ade80',
        'color: #064e3b',
        'font: 600 10px/1 system-ui, sans-serif',
        'padding: 2px 6px',
        'border-radius: 2px',
        'white-space: nowrap',
        'letter-spacing: 0.02em',
      ].join(';');
      label.textContent = lm.alias;
      overlay.appendChild(label);
    }
    document.body.appendChild(overlay);
    __perspectiveOverlays.push(overlay);
  }
}

function clearPerspectiveOverlays() {
  for (const o of __perspectiveOverlays) {
    try { o.remove(); } catch { /* fine */ }
  }
  __perspectiveOverlays = [];
}

// ── Selector synthesis ───────────────────────────────────────────────────

// v2.74.129 — Centralized list of attribute names treated as "test
// markers" — stable identifiers commonly added by app authors to enable
// automated testing and rarely change between builds. Previously this
// list was hardcoded inline in synthesizeSelector and synthesizeCandidates
// as `['data-testid', 'data-test', 'data-cy', 'data-qa']`, which missed
// real-world variants used by enterprise UIs:
//   - `data-test-id` (with dash) — HubSpot, several other React shops
//   - `data-selenium-test` — Selenium tradition
//   - `data-testing-id` — some legacy frameworks
//   - `data-pendo-id` — Pendo product-analytics IDs (stable per element)
// The HubSpot bug report (Mickelle Jones contact chicklet) hit this
// because the target span had `data-test-id` + `data-selenium-test` but
// not `data-testid`. The picker fell through tiers (a–d) all the way
// to the structural fallback, which then produced `span > span > span > span`
// because the immediate ancestors had no class or id either.
//
// Order matters slightly — the picker tries them in sequence and returns
// the first match that's uniqueMatch'd. We put the most common /
// most-conventional first.
var TEST_MARKER_ATTRS = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-cy',
  'data-qa',
  'data-selenium-test',
  'data-testing-id',
  'data-pendo-id',
];

/**
 * Generate a CSS selector that uniquely matches `el` within `scopeRoot`.
 * Priority: id → testid → aria-label → tag.class → structural.
 *
 * scopeRoot defaults to `document` (3c.0 contract). Pass an Element to
 * scope synthesis to that subtree (3c.1 field-mode).
 *
 * The synthesis MUST yield a single match within scopeRoot. Falls through
 * to the next strategy on collision.
 */
function synthesizeSelector(el, scopeRoot = document) {
  if (!el || el.nodeType !== 1) return null;

  // (a) id, if it looks stable. ID is global to the document, so the
  // verifying query goes through scopeRoot.querySelectorAll regardless —
  // an id that's globally unique still satisfies a scope query.
  if (el.id && isStableIdent(el.id)) {
    const sel = `#${cssEscape(el.id)}`;
    if (uniqueMatch(sel, el, scopeRoot)) return sel;
  }

  // (b) test markers — see TEST_MARKER_ATTRS comment above.
  for (const attr of TEST_MARKER_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) {
      const sel = `[${attr}="${cssEscape(v)}"]`;
      if (uniqueMatch(sel, el, scopeRoot)) return sel;
    }
  }

  // (c) aria-label
  const aria = el.getAttribute('aria-label');
  if (aria && aria.length < 80) {
    const sel = `[aria-label="${cssEscape(aria)}"]`;
    if (uniqueMatch(sel, el, scopeRoot)) return sel;
  }

  // (d) tag.class
  const stableClasses = [...el.classList].filter(isStableIdent);
  if (stableClasses.length > 0) {
    const tag = el.tagName.toLowerCase();
    const allCls = stableClasses.map(c => `.${cssEscape(c)}`).join('');
    let sel = `${tag}${allCls}`;
    if (uniqueMatch(sel, el, scopeRoot)) return sel;
    for (const c of stableClasses) {
      sel = `${tag}.${cssEscape(c)}`;
      if (uniqueMatch(sel, el, scopeRoot)) return sel;
    }
  }

  // (e) structural fallback
  return structuralSelector(el, 4, scopeRoot);
}

/**
 * v2.72.6 (Pass 3c.2) — Generate ALL viable candidate selectors that
 * uniquely match `el` within `scopeRoot`, ranked by durability tier.
 *
 * Returns: array of { selector, tier, label } sorted by tier ascending,
 * then by length ascending. Capped at 5. Each tier label is a short
 * human-readable durability hint.
 *
 * Tiers:
 *   1: #id
 *   2: [data-testid] / [data-test] / [data-cy] / [data-qa]
 *   3: [aria-label] / [name=...]
 *   4: tag.class (single class)
 *   5: tag.class.class.. (multi class)
 *   6: structural (nth-of-type chain)
 */
function synthesizeCandidates(el, scopeRoot = document) {
  if (!el || el.nodeType !== 1) return [];
  const out = [];
  const push = (selector, tier, label) => {
    if (!selector) return;
    if (out.some(c => c.selector === selector)) return;  // dedupe
    if (!uniqueMatch(selector, el, scopeRoot)) return;
    out.push({ selector, tier, label });
  };

  // Tier 1 — id
  if (el.id && isStableIdent(el.id)) {
    push(`#${cssEscape(el.id)}`, 1, 'id (very stable)');
  }

  // Tier 2 — test markers (see TEST_MARKER_ATTRS comment for the list rationale).
  for (const attr of TEST_MARKER_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) push(`[${attr}="${cssEscape(v)}"]`, 2, `${attr} (test marker)`);
  }

  // Tier 3 — aria-label and name
  const aria = el.getAttribute('aria-label');
  if (aria && aria.length < 80) {
    push(`[aria-label="${cssEscape(aria)}"]`, 3, 'aria-label (semantic)');
  }
  const name = el.getAttribute('name');
  if (name && isStableIdent(name)) {
    const tagPart = el.tagName.toLowerCase();
    push(`${tagPart}[name="${cssEscape(name)}"]`, 3, 'name attr (form-stable)');
  }

  // Tier 4/5 — tag.class
  const stableClasses = [...el.classList].filter(isStableIdent);
  const tag = el.tagName.toLowerCase();
  if (stableClasses.length > 0) {
    // Single-class candidates first (more durable than multi).
    for (const c of stableClasses) {
      push(`${tag}.${cssEscape(c)}`, 4, `class ${c}`);
    }
    if (stableClasses.length > 1) {
      const allCls = stableClasses.map(c => `.${cssEscape(c)}`).join('');
      push(`${tag}${allCls}`, 5, `${stableClasses.length} classes`);
    }
  }

  // Tier 6 — structural fallback (always include if nothing else captured
  // OR as a final option even when we have semantic ones — sometimes
  // structural is what the author wants).
  const structural = structuralSelector(el, 4, scopeRoot);
  if (structural) push(structural, 6, 'structural (position-based)');

  // Sort: tier asc, then length asc.
  out.sort((a, b) => a.tier - b.tier || a.selector.length - b.selector.length);

  // Cap at 5 — paralysis-of-choice mitigation.
  return out.slice(0, 5);
}

/**
 * Build a structural selector that uniquely identifies `el` within
 * `scopeRoot`. Climbs up to maxDepth ancestors but stops at scopeRoot
 * (the path is relative to scopeRoot's children).
 *
 * v2.74.297 — Hard uniqueness guarantee. Pre-fix, after `maxDepth`
 * ancestors with no unique match, the function returned the longest
 * path it had built REGARDLESS of whether it actually uniquely
 * identified the target. That produced selectors like
 *   div.dropdown--hYsUf > button.button--af32y.ghost--zbjYe…
 * which match every filter button in pixabay's filter row — the picker
 * overlay went to one element but downstream `document.querySelectorAll`
 * picked the first match in document order. Now:
 *
 *   1. Walk up with a doubled depth budget (4 → 8) looking for unique.
 *   2. If still ambiguous, force a `:nth-of-type(N)` disambiguator on
 *      the leaf segment based on the element's index among same-tag
 *      siblings.
 *   3. If even that doesn't uniquely identify, keep walking up beyond
 *      8 until body or unique.
 *   4. Last resort: walk to body and emit the full body-rooted path
 *      with leaf nth-of-type — guaranteed unique within scopeRoot or
 *      we'd be looking at a DOM where this element doesn't exist.
 *
 * Brevity is sacrificed for correctness when those conflict; an extra
 * 30 characters in a selector is cheap, "wrong element" is not.
 */
function structuralSelector(el, maxDepth, scopeRoot = document) {
  // The boundary at which we stop climbing. For document-scoped, this is
  // body (legacy 3c.0 behavior — paths can be quite long but rooted under
  // body). For element-scoped, this is the scopeRoot itself.
  const stopAt = scopeRoot === document ? document.body : scopeRoot;

  // Step 1: walk up looking for uniqueness, with the original (now
  // doubled) budget. Most picks are unique within 1-4 ancestors; the
  // remaining cases need more.
  const path = [];
  let cur = el;
  const PRIMARY_DEPTH = Math.max(maxDepth, 8);
  for (let depth = 0; depth < PRIMARY_DEPTH && cur && cur !== stopAt && cur.parentNode; depth++) {
    path.unshift(_richSegmentFor(cur));
    const candidate = path.join(' > ');
    if (uniqueMatch(candidate, el, scopeRoot)) return candidate;
    cur = cur.parentNode;
  }

  // Step 2: still not unique. Force :nth-of-type on the leaf even if
  // it has stable classes — the issue is that the class chain is
  // shared with siblings. _richSegmentFor only adds :nth-of-type when
  // the element has no class, so we do it manually here.
  if (path.length > 0) {
    const parent = el.parentNode;
    const siblings = parent ? [...parent.children].filter(c => c.tagName === el.tagName) : [];
    const idx = siblings.indexOf(el);
    if (idx >= 0 && siblings.length > 1) {
      const leafTag = el.tagName.toLowerCase();
      const stable  = [...el.classList].filter(isStableIdent);
      const classChain = stable.length > 0 ? stable.map(c => `.${cssEscape(c)}`).join('') : '';
      // Mutate the leaf segment (path[length-1]) to include :nth-of-type.
      path[path.length - 1] = `${leafTag}${classChain}:nth-of-type(${idx + 1})`;
      const disambiguated = path.join(' > ');
      if (uniqueMatch(disambiguated, el, scopeRoot)) return disambiguated;
    }
  }

  // Step 3: leaf disambiguation wasn't enough. Keep walking up beyond
  // the primary depth budget until we find uniqueness or hit body.
  while (cur && cur !== stopAt && cur.parentNode) {
    path.unshift(_richSegmentFor(cur));
    const candidate = path.join(' > ');
    if (uniqueMatch(candidate, el, scopeRoot)) return candidate;
    cur = cur.parentNode;
  }

  // Step 4: truly couldn't disambiguate even from body. This is rare
  // and signals a pathological DOM (e.g. a Web Component shadow root
  // we can't pierce, or the element was removed mid-walk). Return the
  // best path we built; downstream verifier will flag matchCount > 1.
  return path.join(' > ') || el.tagName.toLowerCase();
}

// v2.74.129 — Per-segment builder for structural selectors. Pre-fix,
// segments were always `tag` (or `tag:nth-of-type(K)` when same-tag
// siblings forced disambiguation) — meaning even when an ancestor had
// a stable class or a test marker, the structural fallback ignored it
// and emitted just `span > span > span > span`. That selector matches
// thousands of elements in any non-trivial page.
//
// The richer segment prefers test markers > stable classes > tag, with
// :nth-of-type as a last-resort disambiguator when the element has no
// usable identifier of its own AND has same-tag siblings under its
// parent. The synthesis still walks up looking for a uniqueMatch, so a
// good segment near the target keeps the resulting selector short.
function _richSegmentFor(el) {
  if (!el || el.nodeType !== 1) return '';
  const tag = el.tagName.toLowerCase();

  // Test markers take precedence — they're chosen by app authors
  // specifically for stable identification.
  for (const attr of TEST_MARKER_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return `${tag}[${attr}="${cssEscape(v)}"]`;
  }

  // Stable classes — pass through isStableIdent so styled-components
  // hashes and CSS-modules suffixes are filtered out.
  const stable = [...el.classList].filter(isStableIdent);
  const base = stable.length > 0
    ? `${tag}${stable.map(c => `.${cssEscape(c)}`).join('')}`
    : tag;

  // v2.74.299 — Sibling-uniqueness for every segment. Pre-fix, the
  // function returned `tag.class.chain` even when the same tag+class
  // chain matched multiple SIBLING elements under the same parent
  // (e.g. pixabay's filter row has 6 sibling `div.dropdown--hYsUf`
  // containers — _richSegmentFor returned `div.dropdown--hYsUf` for
  // any of them and structuralSelector then walked up hoping an
  // ancestor would disambiguate; if ancestors also had repeating
  // structure the final selector matched all 6 buttons). Now: if
  // there are multiple siblings with the same tag+class chain, we
  // append :nth-of-type(N) to force per-segment uniqueness. The walk-
  // up path then quickly stabilizes because each segment is unique
  // within its parent.
  const parent = el.parentNode;
  if (!parent) return base;
  const sameTagSiblings = [...parent.children].filter(c => c.tagName === el.tagName);
  if (sameTagSiblings.length <= 1) return base;
  // Check whether the tag+class signature is shared with any same-tag sibling.
  const ourClasses = stable.join('|');   // deterministic order (we joined in this order above)
  const sharedSignature = sameTagSiblings.some(c => {
    if (c === el) return false;
    const cStable = [...c.classList].filter(isStableIdent).join('|');
    return cStable === ourClasses;
  });
  if (!sharedSignature) return base;     // tag.class chain is unique within parent — base is enough
  const nthIdx = sameTagSiblings.indexOf(el) + 1;
  return `${base}:nth-of-type(${nthIdx})`;
}

/**
 * Verify that `selector` matches exactly one element AND that element is
 * `el`, when run within `scopeRoot`.
 */
function uniqueMatch(selector, el, scopeRoot = document) {
  try {
    const matches = scopeRoot.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === el;
  } catch {
    return false;
  }
}

/**
 * Return true if `s` looks like a hand-authored identifier rather than a
 * compiler-generated hash. Heuristics:
 *   - contains 4+ digits or a hex-like run → likely generated
 *   - ends with `__\w+` (CSS modules pattern) → generated
 *   - starts with `_r`, `_o` followed by digits (React/Emotion) → generated
 *   - all-numeric or extremely short → not useful
 */
// CANONICAL SOURCE: Core/selectorStability.js (isStableIdent). VERBATIM MIRROR — a classic content
// script can't import ESM, so this is kept in sync by hand. Any rule change lands in BOTH. (SG-LM-1)
function isStableIdent(s) {
  if (!s || typeof s !== 'string') return false;
  if (s.length < 2) return false;
  if (/^\d+$/.test(s)) return false;                      // all numeric
  if (/__[A-Za-z0-9_-]{3,}$/.test(s)) return false;       // CSS-modules `foo__a1B2` suffix
  if (/^:r[0-9a-z]+:$/.test(s)) return false;             // React 18 useId: :r0:, :rb:, :rcd:
  if (/^_r\d/.test(s)) return false;                      // older React/Emotion underscore prefix
  if (/^css-[a-z0-9]{6,}$/.test(s)) return false;         // emotion-style hashes
  if (/[0-9]{4,}/.test(s)) return false;                  // long digit run
  if (/^[a-f0-9]{8,}$/i.test(s)) return false;            // hex-only run
  // Component-library auto ids with a SHORT counter the `[0-9]{4,}` rule misses (Fluent/Fabric
  // "FabricTextField-324", Radix, Headless UI, Chakra, …); plus a generic ComponentName-NNN counter.
  if (/^(fab|fluent|radix|headlessui|chakra|mantine|downshift|tippy|popper|floatingui|reach|reakit|react-?select|react-?aria)[a-z0-9_-]*\d/i.test(s)) return false;
  if (/[a-z][A-Z][A-Za-z]*-?\d{2,3}$/.test(s)) return false;   // ComponentName-324, fieldName12
  // Styled-components bare hash class: pure-alpha 5-10, mixed case, vowel density < 25%
  // (protects camelCase identifiers like `navItem`/`editBtn` which are ≥28% vowels).
  if (/^[a-zA-Z]{5,10}$/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)) {
    const vowels = (s.match(/[aeiouAEIOU]/g) ?? []).length;
    if (vowels / s.length < 0.25) return false;
  }
  // CSS-modules `name--hash` segment whose hash regenerates per build (Pixabay `button--af32y`).
  // Distinguished from a BEM modifier (`block--primary`, a word): a hash mixes letter+digit, mixes
  // upper+lower case, or is vowel-poor. Length 4-8 so short modifiers (`--lg`, `--xl`) are left alone.
  const seg = /--([A-Za-z0-9]{4,8})$/.exec(s);
  if (seg) {
    const h = seg[1];
    const mixedCase = /[a-z]/.test(h) && /[A-Z]/.test(h);
    const alnum = /\d/.test(h) && /[A-Za-z]/.test(h);
    const vowelPoor = ((h.match(/[aeiouAEIOU]/g) || []).length / h.length) < 0.25;
    if (mixedCase || alnum || vowelPoor) return false;
  }
  return true;
}

function cssEscape(s) {
  // CSS.escape is a real function in modern browsers; we use it when
  // available, fall back to a minimal manual escape otherwise.
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/(["\\\][\(\)#\.\:\>\+\~\=\s])/g, '\\$1');
}

function pickerHint(el) {
  // Non-canonical metadata to help the user understand the synthesis.
  return {
    id: el.id || null,
    classes: [...el.classList],
    tag: el.tagName.toLowerCase(),
  };
}

/**
 * v2.72.87 — Extract a human-readable label from an element for use in
 * the action-row card header ("Step 3. CLICK \"Upload photo\"") and as
 * source data for auto-composed Fragment descriptions.
 *
 * Priority order mirrors what accessibility tools use:
 *   1. aria-label
 *   2. aria-labelledby → resolve to referenced element's text
 *   3. textContent (the element's own text — for buttons, links, spans)
 *   4. <label for=ID> association (for inputs)
 *   5. placeholder (for inputs/textarea)
 *   6. title (tooltip)
 *   7. alt (for images)
 *   8. value (for type=submit/button)
 *
 * Returns trimmed, normalized whitespace, truncated at 100 chars. Empty
 * string when no label found — caller decides whether to display.
 */
function extractElementLabel(el) {
  if (!el) return '';

  // 1. aria-label — explicit override, wins everything.
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return normalizeLabel(ariaLabel);

  // 2. aria-labelledby — resolve referenced element(s).
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/).filter(Boolean);
    const texts = ids.map(id => {
      const lblEl = document.getElementById(id);
      return lblEl ? lblEl.textContent : '';
    }).filter(Boolean);
    if (texts.length > 0) return normalizeLabel(texts.join(' '));
  }

  // 3. textContent — for buttons, links, spans, divs with visible text.
  // Skip very large textContent (unlikely a "label", more likely a
  // container's children). Trust short text.
  const text = (el.textContent || '').trim();
  if (text && text.length <= 200) {
    return normalizeLabel(text);
  }

  // 4. <label for="ID"> — for input/select/textarea.
  if (el.id) {
    const label = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
    if (label?.textContent?.trim()) {
      return normalizeLabel(label.textContent);
    }
  }
  // Or wrapping <label> ancestor
  const wrappingLabel = el.closest && el.closest('label');
  if (wrappingLabel && wrappingLabel !== el) {
    const wrapText = wrappingLabel.textContent?.trim();
    if (wrapText) return normalizeLabel(wrapText);
  }

  // 5. placeholder
  const placeholder = el.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return normalizeLabel(placeholder);

  // 6. title attribute (tooltip)
  const title = el.getAttribute('title');
  if (title && title.trim()) return normalizeLabel(title);

  // 7. alt — for images
  const alt = el.getAttribute('alt');
  if (alt && alt.trim()) return normalizeLabel(alt);

  // 8. value attribute — for buttons of type submit/button (legacy form pattern)
  const tag = el.tagName?.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
    const v = el.getAttribute('value');
    if (v && v.trim()) return normalizeLabel(v);
  }

  return '';
}

/** Normalize whitespace, trim, truncate to 100 chars. */
function normalizeLabel(s) {
  const normalized = String(s).replace(/\s+/g, ' ').trim();
  if (normalized.length <= 100) return normalized;
  return normalized.slice(0, 97) + '…';
}

/**
 * v2.72.93 — Extract a comma-separated list of option labels from a
 * CONTAINER element. Used by the picker when the user is picking a
 * CLICK_BY_LABEL container, so the saved pickedLabel reads as
 * "nature, flowers, background, …" instead of the wall-of-text
 * concatenated textContent of the entire subtree.
 *
 * Walks the SAME priority order as the runtime matcher
 * (_findLabelMatches): role=option > role=menuitem > interactive
 * descendants > direct children. The first non-empty group wins; we
 * dedupe and cap at MAX labels with an ellipsis if more exist.
 *
 * If no priority group yields any labels, falls back to
 * extractElementLabel (single-element label extraction). This keeps
 * behavior reasonable when the user accidentally picks something that
 * isn't a real container.
 *
 * @param {Element} container
 * @returns {string} comma-list (e.g. "nature, flowers, …") or fallback
 */
/**
 * v2.74.196 — Walk up from a picked option element to find the
 * enclosing list/menu container. Used by the picker when labelMode
 * is 'container' (CLICK_BY_LABEL actions) so authors can pick the
 * VISIBLE option ("Jeremiah" in a long list) and the picker returns
 * a selector for the LIST that contains it — which is what
 * CLICK_BY_LABEL's `selector` field needs.
 *
 * Detection heuristic, walking up at most MAX_DEPTH levels:
 *   (A) Semantic ARIA roles — role="list" | "listbox" | "menu" |
 *       "menubar" | "tablist" | "radiogroup" | "grid" | "tree" |
 *       "group". These are unambiguous container markers.
 *   (B) HTML semantic tags — <ul>, <ol>, <menu>, <select>,
 *       <datalist>, <tbody>. Same unambiguous signal.
 *   (C) Multi-sibling rule — if the parent has 3+ children with the
 *       SAME tag name as the current node, the parent is acting as
 *       a list container even without explicit semantics (common for
 *       div-based lists in modern frameworks). 3 is enough to
 *       disambiguate "happens to share a tag with one other sibling"
 *       from "this is a list."
 *
 * Returns null when no container is found within MAX_DEPTH levels;
 * caller falls back to the clicked element (the legacy behavior).
 *
 * @param {Element} target
 * @returns {Element|null}
 */
function _resolveContainerAncestor(target) {
  if (!target) return null;
  const LIST_ROLES = new Set([
    'list', 'listbox', 'menu', 'menubar',
    'tablist', 'radiogroup', 'grid', 'tree', 'group',
  ]);
  const LIST_TAGS = new Set(['UL', 'OL', 'MENU', 'SELECT', 'DATALIST', 'TBODY']);
  const MAX_DEPTH = 8;
  let el = target;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const parent = el?.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    // (A) ARIA role
    const role = parent.getAttribute && parent.getAttribute('role');
    if (role && LIST_ROLES.has(role.toLowerCase())) return parent;
    // (B) HTML tag
    if (LIST_TAGS.has(parent.tagName)) return parent;
    // (C) 3+ same-tag siblings
    let sameTagCount = 0;
    for (const child of parent.children) {
      if (child.tagName === el.tagName) {
        sameTagCount++;
        if (sameTagCount >= 3) break;
      }
    }
    if (sameTagCount >= 3) return parent;
    el = parent;
  }
  return null;
}

function extractContainerLabel(container) {
  if (!container) return '';
  const MAX = 8;     // soft cap — keeps the description readable
  const HARD = 100;  // overall character cap (matches normalizeLabel)

  // Use the same selector + priority groups as _findLabelMatches so
  // what the user sees in the description matches what the runtime
  // matcher will consider.
  const groups = [
    container.querySelectorAll('[role="option"]'),
    container.querySelectorAll('[role="menuitem"]'),
    container.querySelectorAll(_CLICKABLE_DESCENDANTS_SEL),
    container.children,
  ];

  for (const group of groups) {
    const labels = [];
    const seen = new Set();
    for (const el of group) {
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      // Skip empty (icon-only buttons) and very long (likely a wrapper
      // whose textContent concatenates many descendants). 60-char per-
      // option cap is generous for human-meaningful menu labels.
      if (!text || text.length > 60) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      labels.push(text);
      if (labels.length >= MAX + 1) break;   // collect 1 extra to detect "more"
    }
    if (labels.length === 0) continue;       // try next priority level

    // Build display string with truncation.
    const visible = labels.slice(0, MAX);
    const more = labels.length > MAX;
    let out = visible.join(', ');
    if (more) out += ', …';
    if (out.length > HARD) out = out.slice(0, HARD - 1) + '…';
    return out;
  }

  // No priority group yielded labels — fall back to single-element
  // extraction. Better than empty string; gives the author SOMETHING.
  return extractElementLabel(container);
}


// ═══════════════════════════════════════════════════════════════════════════
// v2.74.19 — Snap session (free-extract: click-and-drag rectangle)
// ═══════════════════════════════════════════════════════════════════════════
//
// Activation: START_SNAP message from sidepanel (observation-author mode,
// image_snap shape). Author then clicks-and-drags directly on the page
// to define a rectangle. mouseup posts SNAP_RESULT with the rect (in
// viewport CSS pixels) plus scrollY at capture time and viewport metadata.
//
// Difference from picker:
//   - No upfront cursor change or overlay arming. Snap session listens
//     for mousedown directly; the rectangle div appears on the first
//     mousedown event, follows the drag, finalizes on mouseup.
//   - Document-level listeners with capture:true preventDefault +
//     stopPropagation so page click handlers (links, modals) don't fire
//     during the snap.
//   - Esc cancels.
//
// State:
//   _snapState = null when inactive
//   _snapState = { sessionId, dragging, startX, startY, rectEl,
//                  onMouseDown, onMouseMove, onMouseUp, onKeyDown }
var _snapState = null;

function startSnap(sessionId) {
  if (_snapState) stopSnap(false);

  const onMouseDown = (e) => {
    // Only respond to primary button.
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    _snapState.startX = e.clientX;
    _snapState.startY = e.clientY;
    _snapState.dragging = true;
    // Create the rectangle div (lazily, only when actually dragging).
    const r = document.createElement('div');
    r.style.cssText = `
      position: fixed; pointer-events: none; z-index: 2147483646;
      border: 2px solid #7c6fef; background: rgba(124, 111, 239, 0.10);
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.25);
      left: ${e.clientX}px; top: ${e.clientY}px; width: 0; height: 0;
    `;
    document.documentElement.appendChild(r);
    _snapState.rectEl = r;
  };

  const onMouseMove = (e) => {
    if (!_snapState?.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, _snapState.startX);
    const y = Math.min(e.clientY, _snapState.startY);
    const w = Math.abs(e.clientX - _snapState.startX);
    const h = Math.abs(e.clientY - _snapState.startY);
    if (_snapState.rectEl) {
      _snapState.rectEl.style.left   = `${x}px`;
      _snapState.rectEl.style.top    = `${y}px`;
      _snapState.rectEl.style.width  = `${w}px`;
      _snapState.rectEl.style.height = `${h}px`;
    }
  };

  const onMouseUp = (e) => {
    if (!_snapState?.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, _snapState.startX);
    const y = Math.min(e.clientY, _snapState.startY);
    const w = Math.abs(e.clientX - _snapState.startX);
    const h = Math.abs(e.clientY - _snapState.startY);
    const rect = { x, y, width: w, height: h };
    const scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    const viewport = {
      width: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
    const sid = _snapState.sessionId;
    stopSnap(false);
    chrome.runtime.sendMessage({
      type: 'SNAP_RESULT',
      sessionId: sid,
      rect,
      scrollY,
      viewport,
    }).catch(() => {});
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const sid = _snapState?.sessionId;
      stopSnap(false);
      chrome.runtime.sendMessage({
        type: 'SNAP_RESULT',
        sessionId: sid,
        error: 'cancelled by user',
      }).catch(() => {});
    }
  };

  _snapState = {
    sessionId,
    dragging: false,
    startX: 0,
    startY: 0,
    rectEl: null,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onKeyDown,
  };

  document.addEventListener('mousedown', onMouseDown, /* capture */ true);
  document.addEventListener('mousemove', onMouseMove, /* capture */ true);
  document.addEventListener('mouseup',   onMouseUp,   /* capture */ true);
  document.addEventListener('keydown',   onKeyDown,   /* capture */ true);
}

function stopSnap(/* notify */ notifyContent) {
  if (!_snapState) return;
  document.removeEventListener('mousedown', _snapState.onMouseDown, true);
  document.removeEventListener('mousemove', _snapState.onMouseMove, true);
  document.removeEventListener('mouseup',   _snapState.onMouseUp,   true);
  document.removeEventListener('keydown',   _snapState.onKeyDown,   true);
  if (_snapState.rectEl?.parentNode) {
    _snapState.rectEl.parentNode.removeChild(_snapState.rectEl);
  }
  _snapState = null;
}

/**
 * v2.74.20 — Visual flash for snap-verify confirmation. Renders a
 * positioned rectangle that briefly pulses bright then fades out, so the
 * author sees the capture happened. The element is removed automatically
 * after the animation completes (~700ms total).
 *
 * Note: this fires AFTER captureVisibleTab has run, so the flash element
 * is NOT in the captured screenshot. The visual is purely for the user.
 */
function showCaptureFlash(rect) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
  const flash = document.createElement('div');
  flash.style.cssText = `
    position: fixed;
    left: ${rect.x}px; top: ${rect.y}px;
    width: ${rect.width}px; height: ${rect.height}px;
    pointer-events: none;
    z-index: 2147483646;
    background: rgba(255, 255, 255, 0.85);
    border: 2px solid #7c6fef;
    box-shadow: 0 0 20px rgba(124, 111, 239, 0.7), inset 0 0 20px rgba(255, 255, 255, 0.8);
    transition: opacity 600ms ease-out;
    opacity: 1;
  `;
  document.documentElement.appendChild(flash);
  // Force a reflow so the initial opacity:1 is committed before the
  // transition starts (otherwise the browser may collapse the change
  // and skip the animation entirely).
  // eslint-disable-next-line no-unused-expressions
  flash.offsetHeight;
  // Kick off fade.
  requestAnimationFrame(() => {
    flash.style.opacity = '0';
  });
  // Remove after fade completes.
  setTimeout(() => {
    if (flash.parentNode) flash.parentNode.removeChild(flash);
  }, 700);
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.74.151 / v2.74.152 — Observation debug overlay
// ═══════════════════════════════════════════════════════════════════════════
//
// When a workflow runs in debug mode, ExecutionEngine sends
// SHOW_OBSERVATION_OVERLAY before each OBSERVATION step starts and
// HIDE_OBSERVATION_OVERLAY when it completes. The overlay marks the
// section of the page being observed using the same violet picker-box
// styling the live-picker uses, so the watcher sees exactly which
// region is about to be read.
//
// Design constraints:
//   • Non-interactive (pointer-events: none) so it doesn't block any
//     actions the workflow is performing.
//   • One overlay per extract. Picker-target shapes (text / attribute /
//     list_of_records / section / etc.) outline the FIRST element
//     matched by the substituted CSS selector. Free-extract shapes
//     (image_snap / image_full / image_read) outline the viewport-
//     relative rect directly.
//   • A small label tag at the top-left of each box shows the output
//     binding name. The first box also gets the observation name.
//   • Re-issuing SHOW replaces any prior overlay in place (FOREACH
//     bodies that re-fire the same observation just update the box).
//   • HIDE is idempotent and safe to call without an active overlay.
//   • Tab navigation re-injects the content script, so leftover
//     overlays from a prior page are naturally garbage-collected.

var _obsOverlayState = null;   // { rootEl } or null

function showObservationOverlay(payload) {
  if (!payload) return;
  // v2.74.159 — `replacing: true` so the prior overlay is removed
  // synchronously instead of fading over 200ms. Without this, rapid
  // FOREACH iterations layer multiple containers in the DOM during
  // each transition window.
  hideObservationOverlay({ replacing: true });

  const root = document.createElement('div');
  root.setAttribute('data-agent-hub-obs-overlay', '1');
  // Container has no visual itself — it's just a non-blocking
  // viewport-sized layer that hosts the per-extract picker-style boxes.
  root.style.cssText = [
    'position:fixed', 'inset:0',
    'pointer-events:none',
    'z-index:2147483645',     // just under the live-picker overlay
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
  ].join(';');

  const obsName = payload.name ?? 'observation';
  const extracts = Array.isArray(payload.extracts) ? payload.extracts : [];
  let boxesDrawn = 0;

  // v2.74.159 — Shapes that read multiple elements (list_of_records,
  // image_refs, image_list) outline EVERY match of their selector so
  // the watcher sees the full set of regions being read. Single-match
  // shapes (text/attribute/scalar/raw_text/raw_html/section/image)
  // still outline just the first match — those expect one element by
  // design. The cap (MULTI_MATCH_CAP) protects against runaway DOM
  // cost when an author's selector accidentally matches half the page.
  const MULTI_MATCH_SHAPES = new Set(['list_of_records', 'image_refs', 'image_list']);
  const MULTI_MATCH_CAP    = 50;

  // Helper: build one picker-style box at a given viewport-CSS rect.
  // `isLeader` controls whether the tag label is attached (only the
  // first box for each extract carries one — multi-match shapes get
  // many identical boxes sharing one tag).
  const makeBox = (r, isLeader, ex) => {
    const box = document.createElement('div');
    // Match the live-picker overlay style (assets/sidepanel.css: violet
    // #a78bfa border, translucent violet fill, 2px radius) so the
    // watcher recognizes this as "the system is reading this region."
    box.style.cssText = [
      'position:absolute',
      `left:${r.x}px`, `top:${r.y}px`,
      `width:${r.width}px`, `height:${r.height}px`,
      'border:2px solid #a78bfa',
      'background:rgba(167, 139, 250, 0.15)',
      'border-radius:2px',
      'box-sizing:border-box',
      'pointer-events:none',
      'opacity:0',
      'transition:opacity 160ms ease-out',
    ].join(';');
    if (!isLeader) return box;
    // Label tag at the top-left. First extract OVERALL carries the
    // observation name; subsequent extracts show their output binding
    // name to avoid repetition.
    const tag = document.createElement('div');
    const tagText = boxesDrawn === 0
      ? `${obsName}${ex.output ? ` → ${ex.output}` : ''}`
      : (ex.output ?? '');
    if (tagText) {
      tag.style.cssText = [
        'position:absolute', 'left:-2px', 'top:-22px',
        'padding:2px 7px',
        'background:#a78bfa',
        'color:#1a1a2e',
        'font-size:11px',
        'font-weight:600',
        'font-family:ui-monospace,SFMono-Regular,monospace',
        'border-radius:3px 3px 0 0',
        'white-space:nowrap',
        'pointer-events:none',
      ].join(';');
      tag.textContent = tagText;
      box.appendChild(tag);
    }
    return box;
  };

  // Build picker-style boxes per extract. Skip extracts that have
  // neither a rect nor a resolvable target — those would draw an empty
  // box in some arbitrary spot.
  for (let i = 0; i < extracts.length; i++) {
    const ex = extracts[i];

    if (ex.rect && ex.rect.width > 0 && ex.rect.height > 0) {
      // Free-extract shape — rect is already viewport-CSS pixels.
      const r = { x: ex.rect.x, y: ex.rect.y, width: ex.rect.width, height: ex.rect.height };
      root.appendChild(makeBox(r, /* isLeader */ true, ex));
      boxesDrawn++;
      continue;
    }

    if (typeof ex.target !== 'string' || !ex.target) continue;

    // Picker shape — resolve matches. Multi-match shapes use
    // querySelectorAll (capped); single-match shapes still use
    // querySelector for parity with their semantics.
    let elements = [];
    try {
      if (MULTI_MATCH_SHAPES.has(ex.shape)) {
        elements = Array.from(document.querySelectorAll(ex.target)).slice(0, MULTI_MATCH_CAP);
      } else {
        const el = document.querySelector(ex.target);
        if (el) elements = [el];
      }
    } catch { /* invalid selector — silently skip */ }

    let leaderDrawn = false;
    for (const el of elements) {
      const br = el.getBoundingClientRect();
      if (!(br.width > 0) || !(br.height > 0)) continue;   // off-screen / collapsed
      const r = { x: br.left, y: br.top, width: br.width, height: br.height };
      root.appendChild(makeBox(r, /* isLeader */ !leaderDrawn, ex));
      if (!leaderDrawn) {
        leaderDrawn = true;
        boxesDrawn++;   // count this extract as "drew at least one box" — gates the tag-text branch
      }
    }
  }

  // Nothing to highlight (e.g. observation with only abstract conditions
  // and no extracts) — don't paint an invisible container.
  if (boxesDrawn === 0) return;

  document.documentElement.appendChild(root);
  // Fade in on next frame so the transition actually runs.
  // eslint-disable-next-line no-unused-expressions
  root.offsetHeight;
  requestAnimationFrame(() => {
    for (const child of root.children) {
      if (child.style) child.style.opacity = '1';
    }
  });

  _obsOverlayState = { rootEl: root };
}

// v2.74.159 — `replacing` flag suppresses the fade-out when the caller
// is about to show a new overlay (rapid FOREACH iterations). The
// previous unconditional fade left the old container in the DOM for
// 200ms while a fresh one was appended, layering boxes during tight
// loops. When replaced, we remove instantly.
function hideObservationOverlay({ replacing = false } = {}) {
  if (!_obsOverlayState) return;
  const { rootEl } = _obsOverlayState;
  _obsOverlayState = null;
  if (!rootEl || !rootEl.parentNode) return;
  if (replacing) {
    // Synchronous tear-down — the new SHOW is about to append. No fade.
    rootEl.parentNode.removeChild(rootEl);
    return;
  }
  // Fade-out: drop opacity on all per-extract boxes, then remove the
  // container once the transition lands. The container itself has no
  // opacity transition — only the boxes do.
  for (const child of rootEl.children) {
    if (child.style) child.style.opacity = '0';
  }
  setTimeout(() => {
    if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
  }, 200);
}
