// Core/legRef.js — v2.74.1342 (review I): ONE stable ref key for any leg-like / palette object. PURE.
//
// Four divergent precedence orders (palette keyOf, route _toolKey, interpret _idSet, interpretPrompt _toolRef)
// made connector legs (key-first) invisible to route() and primitive ops (op-first) bounce to teach when the LLM
// used capabilityId:'OPEN_URL'. Every consumer imports this — never re-roll precedence locally.

const _str = (x) => (typeof x === 'string' ? x.trim() : '');

/**
 * The stable selection/ref key for a saved capability, connector leg, or primitive descriptor. PURE.
 * @param {object|string|null|undefined} x
 * @returns {string|null}
 */
export function legRef(x) {
  if (x == null) return null;
  if (typeof x === 'string') return _str(x) || null;
  if (typeof x !== 'object') return null;
  return _str(x.key) || _str(x.capabilityId) || _str(x.id) || _str(x.op) || _str(x.name) || null;
}
