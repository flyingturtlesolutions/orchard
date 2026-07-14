// Core/connectorAlias.js — CX-9p (v2.74.1461): the connector-leg ALIAS store — the teach-once flywheel extended
// from page capabilities (Core/orchMatch accreteAlias) to CONNECTOR legs, per findings.md v1450 DIGEST_NEXT.
//
// THE LOOP. On every SUCCESSFUL connector invoke the front door records (ask-shape signature → leg ref + host). A
// later ask whose shape matches recalls that leg as a WARM PATH: the interpret projection stamps it scope 'alias'
// (the top of the SCOPING cascade, above DOMAIN-MATCH), so an UNNAMED ask that once resolved to a site's tool
// resolves there again — without re-deriving it from vocabulary each time. Static vocabulary (DOMAIN-MATCH, v1450)
// covers the cold case; this covers the warm case and any vocabulary blind spot (a leg whose corpus lacks the
// ask's distinctive word).
//
// PURE: the store is a plain array the SW persists (chrome.storage.local 'connector:aliases'); this module owns
// only the shape + the record/recall transforms (the caller reads, transforms, and writes back). Scripts have no
// clock, so `at` is passed IN by the caller.
//
// PRIVACY. LOCAL-ONLY. The store never reaches #call: recall only re-ranks an already-projected leg (it adds no
// prompt text, invents no leg). So the signature may keep content words (an address, a status) without crossing
// the egress boundary — DESIGN_llm_privacy.md's boundary is what reaches the LLM, not on-device recall state, of
// which _lastGroundedRead (the retained record VALUE) is a far larger example. Pure-digit tokens are still dropped
// (a one-off claim/ticket number never recurs — keeping it would only depress cross-record recall).

const STOP = new Set('a an the to of for on in at is be do go i my me we us this that these those with and or your you it as by'.split(' '));

/**
 * The ask's STABLE shape: sorted-unique content words (≥3 chars, non-glue), pure-digit tokens dropped. Sorting
 * makes it order-independent (recall is set-similarity, not sequence). PURE.
 * @param {string} ask @returns {string[]}
 */
export function aliasSignature(ask) {
  const toks = String(ask ?? '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
  return [...new Set(toks)].sort();
}

const MAX = 200;   // bounded LRU — the store is a re-rank HINT, not a database

const _key = (sig, ref) => `${(Array.isArray(sig) ? sig : []).join(' ')}|${ref}`;

/**
 * Record a successful ask→leg association. PURE — returns a NEW store array (caller persists). Dedups on
 * (signature, legRef): a repeat bumps count + recency and moves the entry to the end rather than growing the
 * store. Bounded to MAX (oldest dropped). A blank ask/ref, or an ask with no content words, is a no-op.
 * @param {Array<object>} store
 * @param {{ ask?:string, legRef?:string, host?:string, at?:number }} entry — `at` = the caller's Date.now()
 */
// DK-7b (v2.74.1489) — CONTINUATION/ACK words never key an alias. Live poisoning: a windowed each fan-out's
// follow-up "continue" re-ran the leg successfully → the flywheel RECORDED "continue" → that leg, so every later
// bare "continue" warm-pathed to it. A sig made ONLY of these tokens is refused, and already-poisoned entries
// scrub on the next write (self-heal — no migration needed).
const _CONT = new Set(['continue', 'next', 'more', 'again', 'repeat', 'okay', 'yes', 'keep', 'going', 'sure']);
const _contaminated = (sig) => Array.isArray(sig) && sig.length > 0 && sig.every((t) => _CONT.has(t));

export function recordAlias(store, { ask = '', legRef = '', host = '', at = 0 } = {}) {
  const list = (Array.isArray(store) ? store.slice() : []).filter((e) => !(e && _contaminated(e.sig)));   // DK-7b — scrub prior poison on every write
  const sig = aliasSignature(ask);
  const ref = String(legRef || '').trim();
  if (!sig.length || !ref || _contaminated(sig)) return list;   // DK-7b — a continuation word is FLOW control, never an ask shape
  const now = Number(at) || 0;
  const k = _key(sig, ref);
  const idx = list.findIndex((e) => e && _key(e.sig, e.ref) === k);
  if (idx >= 0) {
    const hit = { ...list[idx], count: (list[idx].count || 1) + 1, at: now, host: host || list[idx].host || '' };
    list.splice(idx, 1); list.push(hit);   // move-to-end = most-recently-used
    return list;
  }
  list.push({ sig, ref, host: String(host || ''), count: 1, at: now });
  return list.length > MAX ? list.slice(list.length - MAX) : list;
}

/**
 * Recall the best-matching aliased leg ref for an ask. PURE. Similarity = Jaccard over content-word signatures,
 * gated by BOTH an absolute shared-token floor (`minShared`) AND a relative Jaccard floor (`minJaccard`) — so a
 * long ask can't match a short stored shape on one incidental word, and a repeat resolves confidently. Conservative
 * by design: a false recall would let the pre-rank drop a legit global, so the bar to promote is deliberately high
 * (DOMAIN-MATCH vocabulary, not this store, is the GENERALIZER across differing record values). Ties: count, then
 * recency.
 * @returns {{ ref:string, host:string, score:number } | null}
 */
export function recallAlias(store, ask, { minShared = 3, minJaccard = 0.34 } = {}) {
  const list = Array.isArray(store) ? store : [];
  const sig = new Set(aliasSignature(ask));
  if (sig.size < minShared) return null;
  let best = null;
  for (const e of list) {
    const es = Array.isArray(e && e.sig) ? e.sig : [];
    if (!es.length) continue;
    let shared = 0; for (const t of es) if (sig.has(t)) shared++;
    if (shared < minShared) continue;
    const union = new Set([...es, ...sig]).size;
    const jac = union ? shared / union : 0;
    if (jac < minJaccard) continue;
    const score = jac + (e.count || 1) * 0.001;   // Jaccard dominates; count/recency only break near-ties
    if (!best || score > best.score || (score === best.score && (e.at || 0) > (best._at || 0))) {
      best = { ref: String(e.ref || ''), host: String(e.host || ''), score, _at: e.at || 0 };
    }
  }
  return best && best.ref ? { ref: best.ref, host: best.host, score: best.score } : null;
}
