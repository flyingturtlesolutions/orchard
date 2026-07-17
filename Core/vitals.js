// Core/vitals.js — VT-0 (DESIGN_vitals.md §2-4): the PURE half of Ground Vitals — the transport-general leg-outcome
// classifier (the one partition contract presence/drift share), canary selection, staleness windows, and the
// incident-list transforms. PURE: no chrome / DOM / LLM / clock (`now` is injected).
//
// The belief kinds are fixed (can-act · shape-current · artifact-freshness); transports supply bindings. v1 binds
// the RIDE classifiers; `transport:'drive'|'broker'` events pass through classified as no-evidence until VT-6/7
// add their bindings — the funnel's signature is transport-general from day one so a new transport never touches
// the spine.

import { rideOutcomeSignal } from './connectionPresence.js';
import { isRouteMiss } from './routeHeal.js';
import { armable } from './rideRecipe.js';

/**
 * Classify ONE leg outcome into per-belief evidence. PURE. The partition contract (spec §3.3): auth and drift
 * verdicts are mutually exclusive readings of the same failure — a signed-out outcome is auth evidence and
 * explicitly NOT drift evidence (spec §3.1 ordering: presence gates shape; the 404-on-anonymous class).
 * @returns {{ auth: 'fresh'|'signed-out'|null, drift: 'ok'|'miss'|null }}
 */
export function classifyLegOutcome({ transport = 'ride', ok = false, status = null, error = '', jsonBody = false, csrfInvolved = false } = {}) {
  if (transport !== 'ride') return { auth: null, drift: null };   // VT-6/7 add the drive/broker bindings
  const auth = rideOutcomeSignal({ ok, httpStatus: status, errorCode: error, csrfInvolved });
  if (ok) return { auth: 'fresh', drift: 'ok' };
  if (auth === 'signed-out' || auth === 'wrong-account') return { auth, drift: null };   // auth evidence, never route evidence
  return { auth, drift: isRouteMiss({ status, error, jsonBody }) ? 'miss' : null };
}

const _PLACEHOLDER_RE = /\{[^}]+\}/;

/**
 * Pick a ground's CANARY read (spec §6 discipline, hard-line order): armable, non-write GET/HEAD, ZERO endpoint
 * placeholders, no required params, PROVEN (curated or ever-succeeded). Preference: `pulse`-marked (the digest
 * legs are exactly canary-shaped) > curated > freshest lastOkAt. Null when the ground has no safe canary — the
 * sweep says so honestly rather than improvising params.
 */
export function pickCanary(recipes) {
  const cands = (Array.isArray(recipes) ? recipes : []).filter((r) => r
    && armable(r)
    && r.write !== true
    && ['GET', 'HEAD'].includes(String(r.method || 'GET').toUpperCase())
    && !_PLACEHOLDER_RE.test(String(r.endpoint || ''))
    && !(Array.isArray(r.params) && r.params.some((p) => p && p.required))
    && (r.provenance === 'curated' || r.lastOkAt));
  if (!cands.length) return null;
  const score = (r) => (r.pulse != null ? 4 : 0) + (r.provenance === 'curated' ? 2 : 0) + (r.lastOkAt ? 1 : 0);
  return cands.sort((a, b) => (score(b) - score(a)) || ((b.lastOkAt || 0) - (a.lastOkAt || 0)))[0];
}

/** Is this ground DUE a daily visit — no organic (or probed) success within the window? PURE. */
export function dueForDaily(recipes, now, windowMs) {
  const last = Math.max(0, ...(Array.isArray(recipes) ? recipes : []).map((r) => Number((r && r.lastOkAt) || 0)));
  return (Number(now) - last) >= Number(windowMs);
}

// ── Incidents (spec §8) — one OPEN incident per (class, subject); evidence appends; verify closes. ──────────────────
export const INCIDENT_CAP = 100;      // total incidents kept (closed ones age out first)
export const EVIDENCE_CAP = 12;       // per-incident timeline entries (newest kept)

const _key = (i) => `${i.cls}|${i.subject}`;

/**
 * Open-or-append: if an OPEN incident exists for (cls, subject), append the evidence line (a flapping belief is
 * ONE case with a growing timeline, never case-spam); else create. PURE.
 * @returns {{ list: Array, opened: boolean }} opened = a NEW incident was created (the surface may announce it)
 */
export function upsertIncident(list, { cls, subject, origin = null, groundId = null, recipeId = null, name = null, title = '', line = '', now = 0 } = {}) {
  const l = Array.isArray(list) ? list.slice() : [];
  if (!cls || !subject) return { list: l, opened: false };
  const i = l.findIndex((x) => x && x.status === 'open' && _key(x) === `${cls}|${subject}`);
  if (i >= 0) {
    const inc = { ...l[i] };
    if (line) inc.evidence = [...(inc.evidence || []), { at: Number(now), line: String(line).slice(0, 160) }].slice(-EVIDENCE_CAP);
    l[i] = inc;
    return { list: l, opened: false };
  }
  const inc = {
    id: `vt_${cls}_${String(subject).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48)}_${Number(now)}`,
    cls, subject, origin, groundId, recipeId, name,
    title: String(title || subject).slice(0, 120),
    status: 'open', openedAt: Number(now), closedAt: null,
    evidence: line ? [{ at: Number(now), line: String(line).slice(0, 160) }] : [],
  };
  l.push(inc);
  // cap: age out CLOSED first (they are history; the Rail/store keeps only the newest CAP), never an open one.
  while (l.length > INCIDENT_CAP) {
    const j = l.findIndex((x) => x && x.status === 'closed');
    if (j < 0) break;
    l.splice(j, 1);
  }
  return { list: l, opened: true };
}

/**
 * Close the OPEN incident for (cls, subject) — the verify (spec: auto-close, one quiet closing line). PURE.
 * @returns {{ list: Array, closed: boolean }}
 */
export function resolveIncident(list, { cls, subject, line = '', now = 0 } = {}) {
  const l = Array.isArray(list) ? list.slice() : [];
  const i = l.findIndex((x) => x && x.status === 'open' && _key(x) === `${cls}|${subject}`);
  if (i < 0) return { list: l, closed: false };
  const inc = { ...l[i], status: 'closed', closedAt: Number(now) };
  if (line) inc.evidence = [...(inc.evidence || []), { at: Number(now), line: String(line).slice(0, 160) }].slice(-EVIDENCE_CAP);
  l[i] = inc;
  return { list: l, closed: true };
}

/** The open subset, newest first (the Admin desk renders these; closed = history). PURE. */
export function openIncidents(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && x.status === 'open').sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
}
