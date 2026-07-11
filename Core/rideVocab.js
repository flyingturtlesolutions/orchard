// Core/rideVocab.js — CX-9q (v2.74.1462): the DOMAIN-MATCH vocabulary index, extracted PURE.
//
// v1450 built the per-ground domain vocabulary inline in sg.js with GROUND-level distinctiveness: a word carried
// by ≥2 ground records was deleted everywhere. LIVE BUG (findings v1462): a DUPLICATE ground on the SAME host —
// two vendorsuite.drhorton.com grounds, both seeded with the curated catalog — made every VendorSuite word
// "shared by 2 grounds", so the site's ENTIRE vocabulary self-annihilated. DOMAIN-MATCH could never fire for the
// unnamed "warranty…" ask, and the router fell to lexically-attractive foreign legs (Zendesk search_tickets).
// Distinctiveness is about SITES, not ground records → count words per HOST: a same-host duplicate REINFORCES its
// site's vocabulary; only a word used by two DIFFERENT hosts identifies nothing and drops.

/** The ≥5-char content tokens of a recipe name/does string (the v1450 rule). PURE. */
export function vocabTokens(text) {
  const out = new Set();
  for (const w of String(text ?? '').toLowerCase().split(/[^a-z]+/)) if (w.length >= 5) out.add(w);
  return out;
}

/**
 * Build the per-ground DOMAIN vocabulary with HOST-level distinctiveness.
 * @param {Array<{gid:*, host:string, texts:string[]}>} entries — one per ride-armed ground (texts = armable recipes' `name does`)
 * @returns {Array<{gid:*, host:string, vocab:Set<string>}>} same order; vocab = the host-distinctive words
 */
export function groundVocabIndex(entries) {
  const out = (Array.isArray(entries) ? entries : []).map((e) => {
    const vocab = new Set();
    for (const t of (e && Array.isArray(e.texts)) ? e.texts : []) for (const w of vocabTokens(t)) vocab.add(w);
    return { gid: e && e.gid, host: String((e && e.host) || ''), vocab };
  });
  // A word used by ≥2 HOSTS ("riding", "login", "status") identifies nothing — drop it everywhere. Hosts compare
  // case-insensitively; two grounds on the same host count ONCE (the v1462 duplicate-ground fix).
  const hostsByWord = new Map();
  for (const e of out) {
    const h = e.host.toLowerCase();
    for (const w of e.vocab) { if (!hostsByWord.has(w)) hostsByWord.set(w, new Set()); hostsByWord.get(w).add(h); }
  }
  for (const e of out) for (const w of [...e.vocab]) if (hostsByWord.get(w).size > 1) e.vocab.delete(w);
  return out;
}
