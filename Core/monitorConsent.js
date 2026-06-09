// Core/monitorConsent.js — C6: the monitoring CONSENT gate (Track tier).
//
// PURE (no chrome/DOM). The interaction-monitoring pipeline (Track) captures user behavior, so it is
// DEFAULT-DENY: nothing is captured unless the user has explicitly granted Track consent for the host.
// DESIGN_interaction_monitoring.md §8 (Track → Interpret → Act → Share); C2b's capture START calls
// canTrack() before attaching any listener. Interpret/Act are later tiers (not modeled here).

export const CONSENT_SCHEMA = 1;

/** The safe default: Track OFF. Nothing is monitored until the user opts in. */
export const MONITOR_CONSENT_DEFAULT = Object.freeze({
  schema: CONSENT_SCHEMA,
  track: Object.freeze({ enabled: false, scope: 'hosts', hosts: Object.freeze([]) }),
  // scope: 'all' = every permitted host · 'hosts' = only the listed hosts.
});

/**
 * Is interaction capture (Track) permitted for `host`? DEFAULT-DENY — false unless Track is enabled
 * AND the host is in scope. PURE. Any malformed / missing consent → false.
 * @param {object} consent  a stored consent record (or null/undefined)
 * @param {{ host?: string }} [ctx]
 * @returns {boolean}
 */
export function canTrack(consent, { host = '' } = {}) {
  const t = consent && typeof consent === 'object' && consent.track && typeof consent.track === 'object' ? consent.track : null;
  if (!t || t.enabled !== true) return false;
  if (t.scope === 'all') return true;
  if (t.scope === 'hosts') return Array.isArray(t.hosts) && t.hosts.includes(String(host || ''));
  return false;   // unknown scope → deny
}

/**
 * Pure updater for the Track consent record — returns a NEW record (never mutates). Used by the
 * SET_MONITOR_CONSENT handler. Unspecified fields are preserved.
 * @param {object} consent  current record (or null → default)
 * @param {{ enabled?:boolean, scope?:('all'|'hosts'), addHost?:string, removeHost?:string }} [patch]
 * @returns {object} new consent record
 */
export function withTrack(consent, { enabled, scope, addHost, removeHost } = {}) {
  const base = consent && typeof consent === 'object' ? consent : {};
  const cur = base.track && typeof base.track === 'object' ? base.track : MONITOR_CONSENT_DEFAULT.track;
  const next = {
    enabled: cur.enabled === true,
    scope: cur.scope === 'all' ? 'all' : 'hosts',
    hosts: Array.isArray(cur.hosts) ? [...cur.hosts] : [],
  };
  if (typeof enabled === 'boolean') next.enabled = enabled;
  if (scope === 'all' || scope === 'hosts') next.scope = scope;
  if (addHost) { const h = String(addHost); if (h && !next.hosts.includes(h)) next.hosts.push(h); }
  if (removeHost) { const h = String(removeHost); next.hosts = next.hosts.filter((x) => x !== h); }
  next.hosts.sort();
  return { ...base, schema: CONSENT_SCHEMA, track: next };
}
