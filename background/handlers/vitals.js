// background/handlers/vitals.js — Ground Vitals (DESIGN_vitals.md, VT-0..VT-4): the I/O half of the subsystem.
// Owns: the transport-general LEG-OUTCOME FUNNEL (`reportLegOutcome` — the ONE call every executor makes; it
// classifies presence → drift in order and applies the ticks), the SCHEDULER (one `vitals:tick` alarm — the
// window is the cadence, the tick is just the scanner; absorbs the old `conn:heartbeat`), the DAILY VISIT
// (per ride-armed ground: canary read through the NORMAL executor — its §16 ephemeral-tab machinery + belts do
// the rest; result discarded), the one-shot CONFIRM re-probe, the signed-out→fresh CATCH-UP (VT-4), and the
// INCIDENT store the Admin desk renders (VT-2). Heal machinery stays owned by its substrates — this module
// schedules detection and records incidents; it never re-implements a heal (spec §1 boundary).
//
// Wiring: `initVitals(ctx)` from background.js with { invokeSgHandler, readRideRecipes, writeRideRecipes,
// readConnRegistry, reportAuthSignal }; `onConnTransition` registered with connections.js' transition listeners.
// Everything is fail-safe: vitals must never break the call (or the boot) it observes.

import { Logger } from '../../Core/Logger.js';
import { StorageManager } from '../../Services/StorageManager.js';
import { classifyLegOutcome, pickCanary, dueForDaily, upsertIncident, resolveIncident, openIncidents } from '../../Core/vitals.js';
import { tickOk, tickRouteMiss } from '../../Core/routeHeal.js';
import { heartbeatTargets } from '../../Core/connectionPresence.js';
import { armable } from '../../Core/rideRecipe.js';
import { recipeToLeg } from '../../Core/connectorLeg.js';
import { planExec } from '../../Core/execPlan.js';

const TICK_ALARM = 'vitals:tick';
const CONFIRM_PREFIX = 'vitals:confirm:';
const LAST_DAILY_KEY = 'vitals:lastDaily';
const SETTINGS_KEY = 'settings:vitals';
const INC_KEY = 'vitals:incidents';

let _ctx = null;

async function _settings() {
  let s = {};
  try { s = (await chrome.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY] || {}; } catch { /* */ }
  return {
    enabled: s.enabled !== false,                                   // the subsystem master switch
    presenceWindowMin: Number(s.presenceWindowMin) > 0 ? Number(s.presenceWindowMin) : 30,   // spec §5: 30–60min open-tab
    dailyWindowH: Number(s.dailyWindowH) > 0 ? Number(s.dailyWindowH) : 24,
    ephemeral: s.ephemeral !== false,                               // the closed-tab tier (spec §11: on-with-notice; the visit logs itself)
  };
}

async function _registry() { try { return (await _ctx.readConnRegistry()) || {}; } catch { return {}; } }
async function _presenceStatus(origin) {
  const o = String(origin || '').toLowerCase();
  if (!o) return null;
  const e = (await _registry())[o];
  return (e && e.status) || null;
}
async function _openOrigins() {
  try {
    const tabs = await chrome.tabs.query({});
    return [...new Set(tabs.filter((t) => t && !t.discarded && /^https?:\/\//i.test(t.url || ''))
      .map((t) => { try { return new URL(t.url).host.toLowerCase(); } catch { return null; } })
      .filter(Boolean))];
  } catch { return []; }
}

// ── the incident store (VT-2) — chained RMW over the pure transforms; broadcast so an open panel refreshes ─────────
let _incChain = Promise.resolve();
function _mutateIncidents(fn) {
  const step = _incChain.then(async () => {
    let list = [];
    try { list = (await chrome.storage.local.get(INC_KEY))?.[INC_KEY] || []; } catch { /* */ }
    const r = fn(Array.isArray(list) ? list : []);
    try { await chrome.storage.local.set({ [INC_KEY]: r.list }); } catch { /* */ }
    return r;
  }).catch(() => ({ list: [], opened: false, closed: false }));
  _incChain = step.then(() => {}, () => {});
  return step;
}
async function readIncidents() {
  try { const l = (await chrome.storage.local.get(INC_KEY))?.[INC_KEY]; return Array.isArray(l) ? l : []; } catch { return []; }
}
function _broadcastVitals() {
  try { chrome.runtime.sendMessage({ type: 'VITALS_CHANGED' }, () => { void chrome.runtime.lastError; }); } catch { /* */ }
}
async function _openIncident(fields) {
  const r = await _mutateIncidents((l) => upsertIncident(l, { ...fields, now: Date.now() }));
  if (r.opened) { try { Logger.info('conn', `VITALS ▸ incident open [${fields.cls}] ${fields.subject}`); } catch { /* */ } }
  _broadcastVitals();
}
async function _closeIncident(fields) {
  const r = await _mutateIncidents((l) => resolveIncident(l, { ...fields, now: Date.now() }));
  if (r.closed) { try { Logger.info('conn', `VITALS ▸ incident closed [${fields.cls}] ${fields.subject}`); } catch { /* */ } }
  if (r.closed) _broadcastVitals();
}

// ── VT-0 — the outcome funnel: presence → drift, in order; the ONE call per executor ───────────────────────────────
/**
 * @param {object} evt { transport, ok, status, error, jsonBody, csrfInvolved, origin, groundId, recipeId,
 *                       probePath, probeHeaders, probeAccept }  (probe fields: the registry's spec self-heal rides along)
 * @returns {Promise<null | { auth: string|null, suspect: boolean, becameSuspect: boolean }>}
 */
export async function reportLegOutcome(evt) {
  try {
    if (!_ctx) return null;
    const { transport = 'ride', ok = false, status = null, error = '', jsonBody = false, csrfInvolved = false,
      origin = '', groundId = null, recipeId = null, probePath = null, probeHeaders = null, probeAccept = null } = evt || {};
    const cls = classifyLegOutcome({ transport, ok, status, error, jsonBody, csrfInvolved });
    if (cls.auth && origin && typeof _ctx.reportAuthSignal === 'function') {
      void _ctx.reportAuthSignal({
        origin, status: cls.auth, source: 'ride',
        cause: cls.auth === 'signed-out' ? (String(error || '') || (status ? `http-${status}` : null)) : null,
        probePath, probeHeaders, probeAccept,
      });
    }
    let suspect = false, becameSuspect = false;
    if (groundId && recipeId && cls.drift !== null) {
      // spec §3.1 — the reactive half of presence-gates-drift: refuse route-miss evidence while the REGISTRY
      // says the session is out (the 404-on-anonymous class — a logged-out app must never read as drift).
      let gated = false;
      if (cls.drift === 'miss') {
        const ps = await _presenceStatus(origin);
        gated = ps === 'signed-out' || ps === 'wrong-account';
      }
      if (!gated) {
        const list = await _ctx.readRideRecipes(groundId);
        const i = Array.isArray(list) ? list.findIndex((r) => r && r.id === recipeId) : -1;
        if (i >= 0) {
          const t = cls.drift === 'ok' ? tickOk(list[i], Date.now()) : tickRouteMiss(list[i], Date.now());
          if (t) {
            const next = list.slice(); next[i] = t.record;
            await _ctx.writeRideRecipes(groundId, next);
            suspect = t.record.driftSuspect === true;
            becameSuspect = !!t.becameSuspect;
            if (t.becameSuspect) {
              Logger.info('ride', `HEAL ▸ suspect ${recipeId} (${origin} ${status || error || '?'} ×${t.streak}) — the request shape may have changed`);
              void _openIncident({ cls: 'drift', subject: recipeId, origin, groundId, recipeId, name: list[i].name || recipeId,
                title: `“${list[i].name || recipeId}” on ${origin} may have changed its request shape`, line: `${status || error || '?'} ×${t.streak}` });
            } else if (t.cleared) {
              Logger.info('ride', `HEAL ▸ cleared ${recipeId} (${origin} verified ok)`);
              void _closeIncident({ cls: 'drift', subject: recipeId, line: 'verified ok' });
            }
          } else if (cls.drift === 'ok') {
            suspect = list[i].driftSuspect === true;   // throttled stamp — state unchanged
          }
        }
      }
    }
    return { auth: cls.auth, suspect, becameSuspect };
  } catch { /* the funnel must never break the call it observes */ }
  return null;
}

// ── VT-4 — presence transitions: incidents + the signed-out→fresh catch-up ─────────────────────────────────────────
export function onConnTransition(tr) {
  try {
    if (!tr || !tr.origin) return;
    if (tr.to === 'signed-out' || tr.to === 'wrong-account') {
      void _openIncident({ cls: 'presence', subject: tr.origin, origin: tr.origin,
        title: `${tr.origin} ${tr.to === 'wrong-account' ? 'is signed in as the wrong account' : 'looks signed out'}`,
        line: `${tr.from} → ${tr.to}${tr.cause ? ` (${tr.cause})` : ''}` });
    } else if (tr.to === 'fresh') {
      void _closeIncident({ cls: 'presence', subject: tr.origin, line: 'signed in again' });
      void _recoveryCatchUp(tr.origin);   // spec §3.2 — the deferred checks fire on the RECOVERY transition, not the next alarm
    }
  } catch { /* */ }
}

async function _recoveryCatchUp(origin) {
  try {
    if (!_ctx) return;
    const s = await _settings(); if (!s.enabled) return;
    const o = String(origin || '').toLowerCase();
    for (const g of await _vitalsGrounds()) {
      if (g.host !== o) continue;
      if (!dueForDaily(g.armed, Date.now(), s.dailyWindowH * 3600e3)) continue;
      const canary = pickCanary(g.armed); if (!canary) continue;
      const r = await _runCanary(g.groundId, canary);
      Logger.info('conn', `VITALS ▸ catch-up ${g.host} after sign-in → canary [${canary.id}] ${r && r.success ? 'ok' : `FAIL ${(r && r.error) || '?'}`}`);
    }
  } catch { /* */ }
}

// ── VT-1/VT-3 — the scheduler + the sweeps ─────────────────────────────────────────────────────────────────────────
export function initVitals(ctx) {
  _ctx = (ctx && typeof ctx === 'object') ? ctx : null;
  try { chrome.alarms.clear('conn:heartbeat'); } catch { /* absorbed (VT-1) — one clock owner */ }
  try { chrome.alarms.create(TICK_ALARM, { periodInMinutes: 20 }); } catch { /* */ }
  try {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm || !alarm.name) return;
      if (alarm.name === TICK_ALARM) { _tick().catch(() => { /* */ }); }
      else if (alarm.name.startsWith(CONFIRM_PREFIX)) { _confirmFire(alarm.name.slice(CONFIRM_PREFIX.length)).catch(() => { /* */ }); }
    });
  } catch { /* */ }
  // launch = an immediate tick-if-due (spec §4): the SW boots dozens of times a day, so the tick itself is
  // window-gated — a boot inside every window is a no-op. Small delay lets the boot finish wiring.
  try { setTimeout(() => { _tick().catch(() => { /* */ }); }, 5000); } catch { /* */ }
}

async function _tick() {
  if (!_ctx) return;
  const s = await _settings(); if (!s.enabled) return;
  await _presenceSweep(s);
  let last = 0;
  try { last = Number((await chrome.storage.local.get(LAST_DAILY_KEY))?.[LAST_DAILY_KEY] || 0); } catch { /* */ }
  if (Date.now() - last >= s.dailyWindowH * 3600e3) {
    try { await chrome.storage.local.set({ [LAST_DAILY_KEY]: Date.now() }); } catch { /* */ }   // stamp at START (double-run guard across SW restarts)
    await _dailySweep(s);
  }
}

// The absorbed open-tab heartbeat: probe only probe-bearing, stale-enough, OPEN-tab origins (organic evidence
// suppresses — an actively-used app is never probed). Probing stays in the connector domain (CONN_PROBE_ORIGIN).
async function _presenceSweep(s) {
  try {
    const [registry, open] = await Promise.all([_registry(), _openOrigins()]);
    const targets = heartbeatTargets(registry, open, { now: Date.now(), minAgeMs: s.presenceWindowMin * 60e3, cap: 4 });
    if (!targets.length) return;
    let probed = 0;
    for (const t of targets) {
      try {
        const r = await _ctx.invokeSgHandler('CONN_PROBE_ORIGIN', { origin: t.origin, probePath: t.probePath, probeHeaders: t.probeHeaders, probeAccept: t.probeAccept, source: 'heartbeat' });
        if (r && r.success !== false) probed++;
      } catch { /* per-origin best-effort */ }
    }
    Logger.info('conn', `VITALS ▸ presence probed ${probed}/${targets.length} open-tab origin(s)`);
  } catch { /* */ }
}

/** Every ground holding ≥1 armable ride recipe, with its (modal) host + the armable set. */
async function _vitalsGrounds() {
  const out = [];
  try {
    const grounds = await StorageManager.getAllGrounds();
    for (const g of (Array.isArray(grounds) ? grounds : [])) {
      const gid = g && (g.id || g.groundId); if (!gid) continue;
      let recs = []; try { recs = (await _ctx.readRideRecipes(gid)) || []; } catch { recs = []; }
      const armed = recs.filter((r) => r && armable(r) && r.origin);
      if (!armed.length) continue;
      const counts = {};
      for (const r of armed) { const o = String(r.origin).toLowerCase(); counts[o] = (counts[o] || 0) + 1; }
      const host = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      out.push({ groundId: gid, host, armed });
    }
  } catch { /* */ }
  return out;
}

async function _hostHasTab(host) {
  try { const tabs = await chrome.tabs.query({ url: [`*://${host}/*`] }); return (tabs || []).length > 0; } catch { return false; }
}

// The canary runs through the NORMAL executor (recipeToLeg → planExec → INVOKE_SESSION): the §16 ephemeral-tab
// cold start, the arm guard, the belts, and the VT-0 funnel all apply unchanged — the sweep is JUST a caller.
// The result VALUE is discarded here (spec §6: the sweep wants the verdict, never the data).
async function _runCanary(groundId, rec) {
  try {
    const leg = recipeToLeg({ ...rec, groundId }, { account: 'me', trusted: true });
    if (!leg || !leg.tool) return null;
    const plan = planExec(leg, {}, {});
    if (!plan || plan.ok === false || plan.channel !== 'INVOKE_SESSION') return null;
    const r = await _ctx.invokeSgHandler('INVOKE_SESSION', plan.payload);
    return r ? { success: r.success !== false, error: r.error || null, status: r.status || null } : null;
  } catch { return null; }
}

async function _dailySweep(s) {
  const gs = await _vitalsGrounds();
  let visited = 0, deferred = 0, fresh = 0, noCanary = 0;
  for (const g of gs) {
    try {
      if (!dueForDaily(g.armed, Date.now(), s.dailyWindowH * 3600e3)) { fresh++; continue; }   // organic evidence within the window
      const ps = await _presenceStatus(g.host);
      if (ps === 'signed-out' || ps === 'wrong-account') { deferred++; continue; }   // spec §3.2 — deferred(signed-out); the presence incident already stands; the catch-up fires on recovery
      const canary = pickCanary(g.armed);
      if (!canary) { noCanary++; Logger.info('conn', `VITALS ▸ visit ${g.host} skip — no canary (no params-free proven read)`); continue; }
      if (!s.ephemeral && !(await _hostHasTab(g.host))) { deferred++; continue; }    // closed-tab tier off → open-tab grounds only
      const r = await _runCanary(g.groundId, canary);
      visited++;
      Logger.info('conn', `VITALS ▸ visit ${g.host} canary [${canary.id}] → ${r && r.success ? 'ok' : `FAIL ${(r && r.error) || 'no-reply'}`} (ground ${g.groundId})`);
      // A route-miss-shaped failure gets ONE same-day confirm (spec §4): ×2 crosses the suspect threshold in
      // ~45min instead of two daily ticks. One-shot; never re-armed by the confirm itself.
      if (r && r.success === false && /^http-(404|405|410)$/.test(String(r.error || ''))) {
        try {
          const name = CONFIRM_PREFIX + g.groundId;
          const existing = await chrome.alarms.get(name);
          if (!existing) chrome.alarms.create(name, { delayInMinutes: 45 });
        } catch { /* */ }
      }
      await new Promise((res) => setTimeout(res, 1500));   // politeness spacing between visits
    } catch { /* per-ground best-effort */ }
  }
  Logger.info('conn', `VITALS ▸ daily sweep: ${gs.length} ground(s) — ${visited} visited, ${fresh} fresh, ${deferred} deferred, ${noCanary} no-canary`);
}

async function _confirmFire(groundId) {
  try {
    if (!_ctx) return;
    const s = await _settings(); if (!s.enabled) return;
    let recs = []; try { recs = (await _ctx.readRideRecipes(groundId)) || []; } catch { return; }
    const armed = recs.filter((r) => r && armable(r) && r.origin);
    const canary = pickCanary(armed); if (!canary) return;
    const host = String(canary.origin || '').toLowerCase();
    const ps = await _presenceStatus(host);
    if (ps === 'signed-out' || ps === 'wrong-account') return;
    const r = await _runCanary(groundId, canary);
    Logger.info('conn', `VITALS ▸ confirm ${host} canary [${canary.id}] → ${r && r.success ? 'ok' : `FAIL ${(r && r.error) || 'no-reply'}`} (ground ${groundId})`);
  } catch { /* */ }
}

// ── VT-2 — the handlers the Admin desk renders from ────────────────────────────────────────────────────────────────
export function createVitalsHandlers() {
  return {
    // The full vitals picture: the presence registry + incidents + a per-ground shape rollup (counts + names only).
    VITALS_STATUS: (_payload, _sender, sendResponse) => {
      (async () => {
        try {
          const registry = await _registry();
          const incidents = await readIncidents();
          const grounds = (await _vitalsGrounds()).map((g) => ({
            groundId: g.groundId, host: g.host, armed: g.armed.length,
            driftSuspects: g.armed.filter((r) => r.driftSuspect === true).length,
            proposals: g.armed.filter((r) => r.healProposal).length,
            lastOkAt: Math.max(0, ...g.armed.map((r) => Number(r.lastOkAt) || 0)) || null,
            suspects: g.armed.filter((r) => r.driftSuspect === true).slice(0, 6).map((r) => ({ id: r.id, name: r.name || r.id, hasProposal: !!r.healProposal })),
          }));
          sendResponse({ success: true, registry, incidents, grounds, now: Date.now() });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'vitals-status-failed' }); }
      })();
      return true;
    },
    // The cheap attention count (the Front-desk chip + per-desk pointers): open incidents only, one storage read.
    VITALS_BADGE: (_payload, _sender, sendResponse) => {
      (async () => {
        try { const open = openIncidents(await readIncidents()); sendResponse({ success: true, open: open.length }); }
        catch { sendResponse({ success: true, open: 0 }); }
      })();
      return true;
    },
    // "Check now" from the Admin desk: presence with no age gate + the daily sweep regardless of the last stamp
    // (per-ground organic-evidence gating still applies — fresh is fresh).
    VITALS_CHECK_NOW: (_payload, _sender, sendResponse) => {
      (async () => {
        try {
          const s = await _settings();
          await _presenceSweep({ ...s, presenceWindowMin: 0 });
          try { await chrome.storage.local.set({ [LAST_DAILY_KEY]: Date.now() }); } catch { /* */ }
          await _dailySweep(s);
          sendResponse({ success: true });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'vitals-check-failed' }); }
      })();
      return true;
    },
  };
}
