// Core/toolRetrieval.js — R-2: tool-RAG retrieval for the LLM front door
// (DESIGN_llm_front_door.md §3.3, DESIGN_injection_boundary.md §3-4).
//
// PURE: given the Ground's saved capabilities + the fixed primitive set + the ask, return a SMALL ranked
// candidate palette for the router LLM — NEVER the whole library (dumping all tools measurably degrades
// selection; RAG-MCP). Lexical relevance v1 (no embedding infra needed); the exact-alias short-circuit +
// trial gate are the safety net for retriever misses (Gorilla: retriever quality is the bottleneck).
//
// INJECTION BOUNDARY: every candidate string that may be page-derived (capability/landmark names) is
// SANITIZED + PROVENANCE-TAGGED here, so the router prompt (R-3) can fence them as inert data and prefer the
// user-authored `alias` as the match label. The real defense is fencing + provenance + the HITL gate; this
// sanitize is defense-in-depth, not the whole story.

// Small stop-list so lexical overlap keys on content words ("pixabay", "videos") not glue ("go", "to").
const STOP = new Set('a an the to of for on in at is be do go i my me we us this that these those with and or your you it as by'.split(' '));

function _tokens(s) {
  return String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t));
}

/**
 * Defense-in-depth sanitize for any string that may be page-derived. Strips control / C1-format chars (by
 * code point, so no raw control bytes live in this source), prompt-delimiter fences, and role tags/prefixes,
 * then caps length. NOT a substitute for fencing the catalog as data in the router prompt.
 */
export function sanitizeToolString(s, cap = 120) {
  let t = '';
  for (const ch of String(s ?? '')) {
    const code = ch.codePointAt(0);
    t += (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) ? ' ' : ch;
  }
  t = t.replace(/`{3,}|<\|[^>]*\|>|<\/?(?:system|assistant|user|tool)[^>]*>/gi, ' ');  // ``` fences, <|im_start|>, <system>
  t = t.replace(/^\s*(?:system|assistant|user|tool)\s*:/i, ' ');                       // leading "System:" prefix
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

// The fixed primitive palette — hardcoded + TRUSTED, ALWAYS offered so the router can navigate/act even on a
// cold Ground with no saved capabilities ("go to pixabay home" → OPEN_URL).
export const PRIMITIVES = [
  { kind: 'primitive', op: 'OPEN_URL', name: 'Open a URL / navigate to a site or page', provenance: 'system' },
  { kind: 'primitive', op: 'CLICK',    name: 'Click an element on the page',            provenance: 'system' },
  { kind: 'primitive', op: 'TYPE',     name: 'Type text into a field',                  provenance: 'system' },
  { kind: 'primitive', op: 'SCROLL',   name: 'Scroll the page',                         provenance: 'system' },
  { kind: 'primitive', op: 'EXTRACT',  name: 'Read / extract data from the page',       provenance: 'system' },
];

/**
 * Rank the Ground's capabilities against the ask (lexical v1), keep the top-k, then ALWAYS append the fixed
 * primitive palette. PURE. Each candidate carries sanitized strings + a provenance tag.
 * @param {string} ask
 * @param {{ capabilities?: Array<object>, primitives?: Array<object> }} [pools]
 * @param {{ k?: number }} [opts]
 * @returns {Array<{kind:string, capabilityId?:string, op?:string, name:string, alias?:string|null, provenance:string, score:number}>}
 */
export function retrieveTools(ask, pools = {}, opts = {}) {
  const k = Number.isFinite(opts.k) ? opts.k : 8;
  const askSet = new Set(_tokens(ask));
  const caps = Array.isArray(pools.capabilities) ? pools.capabilities : [];

  const scored = [];
  for (const c of caps) {
    if (!c) continue;
    const id = c.capabilityId || c.id || c.fragmentId || null;
    if (!id) continue;
    const alias   = sanitizeToolString(c.alias || '', 80);                                      // TRUSTED user phrase
    const display = sanitizeToolString(c.name || c.intent || c.description || alias || id, 120); // may be page-derived
    let score = 0;
    for (const t of new Set(_tokens(alias)))   if (askSet.has(t)) score += 2;   // alias matches weighted higher
    for (const t of new Set(_tokens(display))) if (askSet.has(t)) score += 1;
    scored.push({
      kind: 'capability', capabilityId: id,
      name: display, alias: alias || null,
      provenance: alias ? 'user' : 'untrusted',   // a bare page/LLM-derived name with no user alias is untrusted
      score,
    });
  }
  scored.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
  // Keep relevant capabilities (score>0) up to k; if NOTHING scores, still offer the top few so the LLM can judge.
  let top = scored.filter((c) => c.score > 0).slice(0, k);
  if (!top.length) top = scored.slice(0, Math.min(3, scored.length));

  const prims = (Array.isArray(pools.primitives) && pools.primitives.length) ? pools.primitives : PRIMITIVES;
  return [...top, ...prims.map((p) => ({ ...p, score: 0 }))];
}
