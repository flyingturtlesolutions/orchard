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

// ── VT-2c (v2.74.1583) — the rolling outcome TALLY: per-ground per-day {ok,auth,miss,other} counts, the funnel's ──
// one new write path. This is the metric class the binary drift flag can't carry (a ground at 82% is telling you
// something "shape ok" can't) — success RATES + failure MIX for the dashboard, body-blind by construction (counts
// only; no params, no bodies, no asks). Book shape: { [groundId]: { 'YYYY-MM-DD': {ok,auth,miss,other} } }.

export const TALLY_CLASSES = ['ok', 'auth', 'miss', 'other'];
export const TALLY_KEEP_DAYS = 14;    // two windows of the 7d rate — enough for a delta, small enough to never matter

/** The tally class of one funnel outcome — the classifier's partition mapped to the four counted buckets. PURE.
 * `gatedMiss` = a route-miss shape seen while the REGISTRY says signed-out (the 404-on-anonymous class): counted
 * as AUTH (the cause), never as route evidence — the same honesty rule the recipe tick applies. */
export function tallyClassOf({ ok = false, auth = null, drift = null, gatedMiss = false } = {}) {
  if (ok) return 'ok';
  if (auth === 'signed-out' || auth === 'wrong-account') return 'auth';
  if (drift === 'miss') return gatedMiss ? 'auth' : 'miss';
  return 'other';
}

/** Local-date day key for a timestamp. PURE (now injected). */
export function tallyDayKey(now) {
  const d = new Date(Number(now) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Tick one outcome into the book — copy-on-write; prunes entries older than keepDays as it goes. PURE. */
export function tallyTick(book, { groundId, cls, now = 0, keepDays = TALLY_KEEP_DAYS } = {}) {
  const b = (book && typeof book === 'object') ? book : {};
  const gid = String(groundId || '');
  if (!gid || !TALLY_CLASSES.includes(cls)) return b;
  const day = tallyDayKey(now);
  const floor = tallyDayKey(Number(now) - keepDays * 86400e3);
  const next = {};
  for (const [g, days] of Object.entries(b)) {
    if (!days || typeof days !== 'object') continue;
    const kept = {};
    for (const [k, v] of Object.entries(days)) if (k >= floor && v && typeof v === 'object') kept[k] = v;
    if (Object.keys(kept).length) next[g] = kept;
  }
  const gDays = { ...(next[gid] || {}) };
  const cell = { ok: 0, auth: 0, miss: 0, other: 0, ...(gDays[day] || {}) };
  cell[cls] = (Number(cell[cls]) || 0) + 1;
  gDays[day] = cell;
  next[gid] = gDays;
  return next;
}

/** Sum a window: groundIds = one id, an array, or null for ALL grounds. PURE.
 * @returns {{ total:number, ok:number, auth:number, miss:number, other:number, rate:number|null }} */
export function tallySummary(book, groundIds, { now = 0, days = 7 } = {}) {
  const b = (book && typeof book === 'object') ? book : {};
  const ids = groundIds == null ? Object.keys(b) : (Array.isArray(groundIds) ? groundIds : [groundIds]).map(String);
  const floor = tallyDayKey(Number(now) - days * 86400e3);
  const sum = { total: 0, ok: 0, auth: 0, miss: 0, other: 0, rate: null };
  for (const gid of ids) {
    const gDays = b[gid];
    if (!gDays || typeof gDays !== 'object') continue;
    for (const [k, v] of Object.entries(gDays)) {
      if (k < floor || !v || typeof v !== 'object') continue;
      for (const c of TALLY_CLASSES) sum[c] += Number(v[c]) || 0;
    }
  }
  sum.total = sum.ok + sum.auth + sum.miss + sum.other;
  sum.rate = sum.total ? sum.ok / sum.total : null;
  return sum;
}

/** Per-day rollup across grounds for the trend chart, oldest→newest, days with runs only. PURE.
 * @returns {Array<{day:string, total:number, ok:number}>} */
export function tallyByDay(book, groundIds, { now = 0, days = 14 } = {}) {
  const b = (book && typeof book === 'object') ? book : {};
  const ids = groundIds == null ? Object.keys(b) : (Array.isArray(groundIds) ? groundIds : [groundIds]).map(String);
  const floor = tallyDayKey(Number(now) - days * 86400e3);
  const byDay = new Map();
  for (const gid of ids) {
    const gDays = b[gid];
    if (!gDays || typeof gDays !== 'object') continue;
    for (const [k, v] of Object.entries(gDays)) {
      if (k < floor || !v || typeof v !== 'object') continue;
      const cell = byDay.get(k) || { day: k, total: 0, ok: 0 };
      for (const c of TALLY_CLASSES) cell.total += Number(v[c]) || 0;
      cell.ok += Number(v.ok) || 0;
      byDay.set(k, cell);
    }
  }
  return [...byDay.values()].filter((d) => d.total > 0).sort((a, b2) => (a.day < b2.day ? -1 : 1));
}
