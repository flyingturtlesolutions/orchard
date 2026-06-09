// Core/monitorConsent.js — monitoring consent (Track tier). PURE (no chrome/DOM).
//
// The product captures GENERAL intent and resolves it, so monitoring is a SINGLE GLOBAL switch — not a
// per-page opt-in (that's friction). Per-page control is MODERATION: a denylist of hosts to EXCLUDE.
//   canTrack(host) = live monitoring ENABLED  AND  host NOT excluded.
// Default is OFF (nothing captured until the user flips the global toggle). DESIGN_interaction_monitoring §8.

export const CONSENT_SCHEMA = 2;   // v2 — model changed from per-host allowlist to global-enable + exclude denylist

/** Safe default: live monitoring OFF, no exclusions. */
export const MONITOR_CONSENT_DEFAULT = Object.freeze({
  schema: CONSENT_SCHEMA,
  track: Object.freeze({ enabled: false, excludeHosts: Object.freeze([]) }),
});

/** Read the track record defensively (tolerates a missing / legacy-shaped record). */
function _track(consent) {
  return consent && typeof consent === 'object' && consent.track && typeof consent.track === 'object' ? consent.track : null;
}

/**
 * Is interaction capture permitted for `host`? Global ENABLED ∧ host NOT in the exclude denylist.
 * DEFAULT-DENY (disabled → false). PURE.
 */
export function canTrack(consent, { host = '' } = {}) {
  const t = _track(consent);
  if (!t || t.enabled !== true) return false;
  const excl = Array.isArray(t.excludeHosts) ? t.excludeHosts : [];
  return !excl.includes(String(host || ''));
}

/** Is this host explicitly excluded ("Do not monitor this page")? (Independent of the global switch.) */
export function isHostExcluded(consent, host) {
  const t = _track(consent);
  return !!t && Array.isArray(t.excludeHosts) && t.excludeHosts.includes(String(host || ''));
}

/** Is live monitoring globally enabled? */
export function isMonitoringEnabled(consent) {
  const t = _track(consent);
  return !!t && t.enabled === true;
}

/**
 * Pure updater — returns a NEW record (never mutates). The global toggle (`enabled`) and per-page
 * moderation (`excludeHost` to opt a page out, `includeHost` to re-include) flow through here.
 * @param {object} consent
 * @param {{ enabled?:boolean, excludeHost?:string, includeHost?:string }} [patch]
 */
export function withTrack(consent, { enabled, excludeHost, includeHost } = {}) {
  const base = consent && typeof consent === 'object' ? consent : {};
  const cur = _track(base) || MONITOR_CONSENT_DEFAULT.track;
  const next = {
    enabled: cur.enabled === true,
    excludeHosts: Array.isArray(cur.excludeHosts) ? [...cur.excludeHosts] : [],
  };
  if (typeof enabled === 'boolean') next.enabled = enabled;
  if (excludeHost) { const h = String(excludeHost); if (h && !next.excludeHosts.includes(h)) next.excludeHosts.push(h); }
  if (includeHost) { const h = String(includeHost); next.excludeHosts = next.excludeHosts.filter((x) => x !== h); }
  next.excludeHosts.sort();
  return { ...base, schema: CONSENT_SCHEMA, track: next };
}
