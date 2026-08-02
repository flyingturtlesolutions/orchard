// Core/unconnectedCapability.js — UC-1 (v2.74.1957): THE CAPABILITY EXISTS, JUST NOT HERE — SAY SO.
//
// Live 2026-08-02 19:11, on a real tracking number:
//   TARGET ▸ tier=TR-4/tab target=www.ups.com why=focused tab visitor
//   PALETTE ▸ 118 leg(s) — conn:48        (eleven minutes earlier, connected: 120 · conn:50 → ok list[1])
//   INTERPRET_ASK "track 1Z27691W0311465887" → navigate leg=— (conf 0.95)
// The ask resolved to the RIGHT ground, that ground has armed legs that answer it, and the conversation simply
// did not carry the connection — so the legs never entered the palette and the router substituted `navigate`,
// opening the tracking page instead of tracking. At conf 0.95, with nothing said about why.
//
// This is the "unreachable clause → the router substitutes a wrong act" ruling in its QUIET form, and the quiet
// form is worse. A wrong act gets noticed (15:46: a UPS number bound to a Shopify order slot — loud, fixed by
// SG-1). A plausible downgrade does not: the user sees a page open and concludes the feature half-works, rather
// than that it is unconnected in this conversation. Reachability is a safety property; silence about
// unreachability is the failure mode that teaches users the wrong model of the system.
//
// SCOPE — detection only, deliberately. This module answers "does the target ground have armed legs that are
// absent from this palette?" It does NOT connect anything, and it must NOT: adopting a ground's connections into
// a visitor conversation would widen the §5 membrane, which exists for good reasons. The honest fix is to TELL
// the user, and the smallest honest thing is a sentence.

/** The groundId a projected leg belongs to, wherever it is carried. PURE. */
function _legGround(leg) {
  if (!leg || typeof leg !== 'object') return '';
  const t = (leg.tool && typeof leg.tool === 'object') ? leg.tool : {};
  return String(leg.groundId || t.groundId || '');
}

/**
 * Armed legs of the TARGET ground that this palette does not contain.
 *
 * Returns null when there is nothing to say — no target, no armed legs, or the ground is already represented.
 * Null means "stay quiet", which is the common case and must stay cheap.
 *
 * @param {{groundId?: string|null, paletteLegs?: Array, armedRecipes?: Array}} o
 * @returns {{groundId: string, count: number, names: string[]}|null}
 */
export function absentTargetLegs({ groundId = null, paletteLegs = [], armedRecipes = [] } = {}) {
  const gid = String(groundId || '');
  if (!gid) return null;                                    // no resolved target — nothing to be absent FROM
  const armed = Array.isArray(armedRecipes) ? armedRecipes.filter(Boolean) : [];
  if (!armed.length) return null;                           // the ground has no capability to miss
  const legs = Array.isArray(paletteLegs) ? paletteLegs : [];
  // Present = ANY leg from this ground made it in. One is enough: a partial palette is a different problem, and
  // firing on it would nag during normal use, which is how an honest warning becomes noise people learn to skip.
  for (const l of legs) if (_legGround(l) === gid) return null;
  return {
    groundId: gid,
    count: armed.length,
    names: armed.slice(0, 3).map((r) => String((r && (r.name || r.id)) || '').trim()).filter(Boolean),
  };
}

/**
 * The sentence offered INSTEAD of a silent substitution. Names the site, what it could have done, and the one
 * action that fixes it — never claims to have done anything. PURE.
 */
export function unconnectedNote(absent, host) {
  if (!absent || !absent.count) return null;
  const where = String(host || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./, '') || 'that site';
  const what = absent.names.length ? ` (${absent.names.slice(0, 2).join(', ')}${absent.count > 2 ? ', …' : ''})` : '';
  return `${where} has ${absent.count} capabilit${absent.count === 1 ? 'y' : 'ies'} set up${what}, but they aren't connected in this conversation — so I can't use them here. Connect ${where} to this conversation and ask again, or ask in the conversation where it's already connected.`;
}
