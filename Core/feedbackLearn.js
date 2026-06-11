// Core/feedbackLearn.js — ORCH-FB-2: turn confirm/reject HISTORY into a deterministic relevance signal. PURE.
//
// Today a correction only touches the EXACT ask (de-alias) and the auto-fire gate (health). The *content* of the
// correction — the phrase the user confirmed or rejected for a capability — is recorded in the OUTCOMES stream
// (`detail.phrase` + `confirmed`/`rejected`) but never read back. This module reads it back and lets a NEAR ask
// inherit the lesson: an ask lexically close to a CONFIRMED phrase gets a small boost; close to a REJECTED phrase,
// a (larger) penalty. So "sound effects" rejected on "Search for music" suppresses *sound-effects-like* asks, not
// just that one string — generalization, computed locally with NO LLM and NO model training. (Option 1 layers the
// same examples into the LLM matcher's prompt; this is the deterministic floor.)
//
// Precision-first: the penalty outweighs the boost (a "no" should matter more than a "yes"), and both are bounded
// so they shape ranking without overriding the reversibility veto or a strong exact match.
//
// @module Core/feedbackLearn

const _STOP = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'on', 'in', 'my', 'me', 'i', 'please', 'and', 'with', 'this', 'that', 'it', 'is', 'are', 'show', 'find']);
function _tok(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter((w) => w && !_STOP.has(w));
}
function _jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Extract per-capability confirmed / rejected ASK phrases from an OUTCOMES event stream. PURE. Keeps the most
 * recent `maxPer` distinct phrases per capability per polarity (the stream is append-ordered).
 * @param {object[]} events
 * @returns {{confirmed:Object<string,string[]>, rejected:Object<string,string[]>}}
 */
export function feedbackExamples(events, { maxPer = 8 } = {}) {
  const confirmed = {}, rejected = {};
  for (const e of (Array.isArray(events) ? events : [])) {
    const d = e && e.detail;
    if (!d || d.capabilityId == null || !d.phrase) continue;
    const id = String(d.capabilityId);
    const bucket = d.confirmed === true ? confirmed : (d.rejected === true ? rejected : null);
    if (!bucket) continue;
    const arr = (bucket[id] = bucket[id] || []);
    const p = String(d.phrase);
    const at = arr.indexOf(p); if (at !== -1) arr.splice(at, 1);   // move-to-most-recent (dedupe)
    arr.push(p);
  }
  for (const m of [confirmed, rejected]) for (const id of Object.keys(m)) m[id] = m[id].slice(-maxPer);
  return { confirmed, rejected };
}

/**
 * Relevance ADJUSTMENT for (ask, capabilityId) from feedback history. PURE. Boost ∝ similarity to the nearest
 * CONFIRMED phrase; penalty ∝ similarity to the nearest REJECTED phrase (weighted heavier). Returns a delta the
 * matcher adds to the base relevance (then clamps to [0,1]). 0 when there's no relevant history.
 * @param {string} ask
 * @param {string} capabilityId
 * @param {{confirmed:Object,rejected:Object}} examples  from feedbackExamples
 * @returns {number}  delta in [-maxPenalty, +maxBoost]
 */
export function feedbackAdjustment(ask, capabilityId, examples, { maxBoost = 0.15, maxPenalty = 0.3 } = {}) {
  if (!examples || capabilityId == null) return 0;
  const id = String(capabilityId);
  const conf = (examples.confirmed && examples.confirmed[id]) || [];
  const rej = (examples.rejected && examples.rejected[id]) || [];
  if (!conf.length && !rej.length) return 0;
  const at = _tok(ask);
  if (!at.length) return 0;
  const nearest = (phrases) => phrases.reduce((m, p) => Math.max(m, _jaccard(at, _tok(p))), 0);
  return (maxBoost * nearest(conf)) - (maxPenalty * nearest(rej));
}
