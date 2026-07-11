// Core/driveArtifacts.js — the BUILT-IN DRIVE catalog + per-Ground drive-artifact model (v2.74.1454).
//
// Heterogeneous legs, the tri-class model's payoff: on one site, RIDE handles quick retrieval (credential-free
// API replay) and DRIVE handles visual review + further action (landmark-backed clicks on the live page). Ride
// is built-in (CONNECTOR_RECIPES), so drive must be too — but a Drive capability is landmark-backed, and a
// built-in artifact is authored with NO live DOM, so it cannot ship a verified landmark. The answer is the
// PS-3 doctrine ("stage, verify-on-first-use", Core/synthFromGap.js): each catalog step ships a best-known
// SELECTOR GUESS plus a PROTO identity (role + accessibleName, no verified selector). On FIRST invoke the
// artifact HYDRATES — the live page is probed (LANDMARK_PROBE_OR_RECOVER, selector-first then identity
// recovery), the same library entities a taught capability produces are composed (Fragment(s) + Strategy +
// sgCapability, steps carrying INLINE SG-LM-3 landmarks so replay self-heals), persisted marked
// trial.verdict:'observed' — and that first run IS the visible trial: a clean pass promotes to 'trial-pass'.
//
// TIERS mirror specs/TIER_MODEL.md: a tier-1 entry is ONE reusable fragment (select a division, open a status
// tab, open a task row); a tier-2 entry COMPOSES tier-1 ids into a Strategy that REFERENCES their fragments
// (the T1→T2 reuse — hydrating the composite hydrates its fragments as standalone capabilities too).
//
// The per-Ground model mirrors Core/rideRecipe.js exactly: seeded by origin from this catalog, merged on read
// (mechanical fields refresh, user state preserved — and HYDRATION stamps preserved, the Invariant-#3 analogue:
// a catalog re-seed must never orphan an already-hydrated capability). PURE: no chrome / DOM / LLM / clock;
// `now` + `newId` are injected into the builders.

import { originMatchesAppHost, armable } from './rideRecipe.js';
export { originMatchesAppHost, armable };

/** host of an origin/url — lowercased, no scheme / trailing slash. PURE. */
function _host(origin) { return String(origin || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase(); }

// ── The curated catalog ───────────────────────────────────────────────────────────────────────────────────
// Authoring format per entry:
//   id/app/appHost/name/does  — identity + coaching text (same contract as CONNECTOR_RECIPES)
//   tier                      — 1 (one fragment) | 2 (composes tier-1 ids)
//   sectionPath               — the human page the artifact lives on (the nav-THEN-drive composition, v1453)
//   params                    — [{name (UPPER_SNAKE — a {{NAME}} template slot), enum?, hint?, required?}]
//   steps (tier 1)            — [{action, selector (best-known GUESS), proto:{role, accessibleName}?, value?}]
//                               proto is the recovery identity; an empty {{PARAM}} label SKIPS its click.
//   compose (tier 2)          — ordered tier-1 ids; params derive as the union of the composed entries'.
//   write                     — true → safetyClass 'gated' (slice 1 ships READ-shaped review flows only).

const VSD = Object.freeze({ app: 'vendorsuite', appHost: 'vendorsuite.drhorton.com', sectionPath: '/#warranty', catalogVersion: 3 });
// Live DOM (v1456): `#divisionMenu` is the OPEN dropdown list (`ul.item-list` of divisions), NOT the header toggle.
// The toggle is the sibling `.self-stretch…pointer-select` showing the current division name + chevron.
const VSD_DIVISION_TOGGLE = '.flex.align-center:has(#divisionMenu) > .self-stretch.flex.align-center.pointer-select';

export const DRIVE_ARTIFACTS = Object.freeze([
  // F1 — atomic: wait for header chrome, click the division TOGGLE (not #divisionMenu — that's the list panel),
  // then pick a row inside #divisionMenu by label ("Atlanta West" matches "Atlanta West - 210 All" via contains).
  { ...VSD, id: 'vsd_select_division', tier: 1, name: 'Pick a division on the page',
    does: 'on the live VendorSuite warranty page, open the division menu and click a division by its NAME — a visual step (changes what the page shows), returns no data',
    params: [{ name: 'DIVISION', hint: 'the division name (e.g. "Atlanta West") — matches the menu row that contains it; blank keeps the current one' }],
    steps: [
      { action: 'WAIT_FOR', selector: '#divisionMenu', value: '15000' },
      { action: 'CLICK', selector: VSD_DIVISION_TOGGLE },
      { action: 'CLICK_BY_LABEL', selector: '#divisionMenu', value: '{{DIVISION}}' },
    ] },
  // F2 — atomic: open one of the warranty status tabs (label-scoped click — no brittle tablist proto).
  { ...VSD, id: 'vsd_open_status_tab', tier: 1, name: 'Open a warranty status tab',
    does: 'click the new / open / fixed / closed status tab on the live VendorSuite warranty page — a visual step, returns no data',
    params: [{ name: 'STATUS', enum: ['new', 'open', 'fixed', 'closed'], hint: 'which status tab to open' }],
    steps: [
      { action: 'WAIT_FOR', selector: '.nav-tabs, [role="tablist"]', value: '12000', optional: true },
      { action: 'CLICK_BY_LABEL', selector: 'body', value: '{{STATUS}}' },
    ] },
  // F3 — atomic: open ONE task row by visible text (the durable form of v1453's generic text-click).
  { ...VSD, id: 'vsd_open_task_row', tier: 1, name: 'Open a warranty task row',
    does: 'open ONE task on the live VendorSuite warranty list by clicking its row — identify it by the street address exactly as the list shows it, or the task number',
    params: [{ name: 'FIND', hint: 'the row text to click — a street address as displayed, or a task/claim number' }],
    steps: [
      { action: 'WAIT_FOR', selector: 'table, [role="grid"], [role="table"]', value: '12000', optional: true },
      { action: 'CLICK_BY_LABEL', selector: 'body', value: '{{FIND}}' },
    ] },
  // S1 — composite: the visual-review flow (the drive twin of the vs_warranty_tasks ride drill).
  { ...VSD, id: 'vsd_review_warranty_task', tier: 2, compose: ['vsd_select_division', 'vsd_open_status_tab', 'vsd_open_task_row'],
    name: 'Review a warranty task on the page',
    does: 'OPEN the live VendorSuite site and visually walk to one warranty task — pick the division, open the status tab, open the task row. Use this to SHOW/REVIEW a task on screen (so you can eyeball or act on it); use the warranty-task data reads to ANSWER questions.' },
]);

// ── Catalog → per-Ground record (hop 1 of the seeded path) ────────────────────────────────────────────────

/**
 * Project one curated DRIVE_ARTIFACTS entry into a per-Ground record. PURE. Curated → trusted (trust 1),
 * `accepted`, `enabled`; safetyClass 'auto' for a click/nav review flow, 'gated' when the entry declares
 * `write:true` (slice 2). Steps + params + compose ride WHOLE onto the record — the record must stay
 * invocation-complete on the seeded path (the ride Invariant-#3 lesson, applied from day one here).
 * Tier-2 params derive as the UNION of the composed tier-1 entries' params (catalog-derived, no drift).
 */
export function driveFromCatalogEntry(entry, { groundId = '', origin = '', catalog = DRIVE_ARTIFACTS } = {}) {
  const e = (entry && typeof entry === 'object') ? entry : {};
  const rec = {
    id: String(e.id || ''),
    groundId: String(groundId || ''),
    origin: _host(origin) || _host(e.appHost),
    name: String(e.name || e.id || ''),
    does: String(e.does || ''),
    tier: e.tier === 2 ? 2 : 1,
    provenance: 'curated',
    safetyClass: e.write === true ? 'gated' : 'auto',
    trust: 1,
    enabled: true,
    reviewState: 'accepted',
  };
  if (e.sectionPath) rec.sectionPath = String(e.sectionPath);
  if (e.catalogVersion != null) rec.catalogVersion = Number(e.catalogVersion);
  if (Array.isArray(e.compose)) rec.compose = e.compose.slice();
  if (Array.isArray(e.steps)) rec.steps = e.steps.map((s) => {
    const step = { ...s };
    if (s && s.proto) step.proto = { ...s.proto };
    else delete step.proto;
    return step;
  });
  let params = Array.isArray(e.params) ? e.params : null;
  if (!params && rec.tier === 2 && rec.compose) {
    params = []; const seen = new Set();
    for (const cid of rec.compose) {
      const c = (Array.isArray(catalog) ? catalog : []).find((x) => x && x.id === cid);
      for (const p of (c && Array.isArray(c.params) ? c.params : [])) {
        if (p && p.name && !seen.has(p.name)) { seen.add(p.name); params.push({ ...p }); }
      }
    }
  }
  rec.params = (params || []).map((p) => ({ ...p }));
  return rec;
}

/**
 * Seed a Ground's drive-artifact collection from the catalog: entries whose `appHost` matches the origin,
 * projected to records. PURE. The bridge from the global catalog → the per-Ground collection (mirrors ride).
 */
export function seedFromCatalog(catalog, { groundId = '', origin = '' } = {}) {
  const list = Array.isArray(catalog) ? catalog : [];
  return list
    .filter((e) => e && originMatchesAppHost(origin, e.appHost))
    .map((e) => driveFromCatalogEntry(e, { groundId, origin, catalog: list }));
}

// User-owned fields survive a re-seed; HYDRATION stamps survive too — a catalog refresh must NEVER orphan an
// already-hydrated capability (the drive analogue of ride's Invariant #3: the seeded path is the one that breaks).
const _USER_FIELDS = ['name', 'does', 'enabled', 'reviewState', 'safetyClass', 'trust'];
const _HYDRATION_FIELDS = ['capabilityId', 'fragmentId', 'strategyId', 'hydratedAt', 'hydratedCatalogVersion'];

/**
 * Merge `incoming` (a curated re-seed) into `existing` BY id, preserving user state + hydration stamps. PURE.
 * Mechanical fields (steps/params/compose/sectionPath/tier/catalogVersion) refresh from `incoming`; existing
 * records absent from `incoming` are kept. Hydration stamps survive ONLY when `hydratedCatalogVersion` matches
 * the incoming `catalogVersion` — a catalog step fix (bump catalogVersion) invalidates stale first-use entities
 * so the next invoke re-hydrates from the corrected steps (the v1455 live lesson: wrong protos frozen bad fragments).
 */
export function mergeArtifacts(existing, incoming) {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const byId = new Map(ex.map((r) => [r.id, r]));
  const out = []; const seen = new Set();
  for (const r of inc) {
    const prior = byId.get(r.id);
    if (prior) {
      const keep = {};
      for (const k of _USER_FIELDS) if (prior[k] !== undefined) keep[k] = prior[k];
      const merged = { ...r, ...keep };
      const verMatch = Number(prior.hydratedCatalogVersion || 0) === Number(r.catalogVersion || 0);
      if (verMatch) {
        for (const k of _HYDRATION_FIELDS) if (prior[k] !== undefined) merged[k] = prior[k];
      }
      out.push(merged);
    } else out.push(r);
    seen.add(r.id);
  }
  for (const r of ex) if (!seen.has(r.id)) out.push(r);
  return out;
}

// ── Record → OfferedLeg (hop 3: the palette projection) ───────────────────────────────────────────────────

/**
 * Project a Ground's ARMABLE drive artifacts to interpret palette legs, next to its ride legs (heterogeneous
 * legs: ride ANSWERS, drive SHOWS). PURE. `domain:'connector'` + `tool.impl:'drive'` — the chat dispatch
 * branches on the impl marker (the v1453 sectionNav precedent), navigates to `sectionPath`, then invokes.
 * The §18-style arm guard applies (enabled + accepted only); dedup via `seenKeys`.
 */
export function seededDriveLegs(records, { host = '', groundId = '', seenKeys = null } = {}) {
  const out = [];
  for (const r of (Array.isArray(records) ? records : [])) {
    if (!r || !armable(r)) continue;
    const key = `me.drive.${r.id}@${host}`;
    if (seenKeys) { if (seenKeys.has(key)) continue; seenKeys.add(key); }
    const params = Array.isArray(r.params) ? r.params : [];
    const properties = {};
    for (const p of params) {
      if (!p || !p.name) continue;
      const prop = { type: 'string' };
      if (Array.isArray(p.enum)) prop.enum = p.enum.slice();
      if (p.hint) prop.hint = String(p.hint);
      properties[p.name] = prop;
    }
    out.push({
      key, name: r.name, does: r.does,
      mode: 'act', domain: 'connector', source: 'builtin',
      safety: r.safetyClass === 'auto' ? 'auto' : 'gated',
      params: params.map((p) => p && p.name).filter(Boolean),
      paramSchema: { type: 'object', properties, required: params.filter((p) => p && p.required === true).map((p) => p.name) },
      tool: {
        impl: 'drive', driveId: r.id,
        origin: r.origin || host, groundId: String(groundId || ''),
        sectionPath: r.sectionPath || '/', tier: r.tier || 1,
        hydrated: !!r.capabilityId,
      },
    });
  }
  return out;
}

// ── Hydration builders (record + live-probe results → the library entities) ──────────────────────────────

/** Capability record shared shape — mirrors the observed/harvested caps (synthFromGap / DERIVE), UNVERIFIED
 *  until the first-use run passes. PURE. */
function _driveCapability(rec, { groundId, localeUrl, now, id, fragmentId = null, strategyId = null, fragmentIds = null, params = [] }) {
  const cap = {
    id, groundId,
    intent: rec.name, description: rec.does || rec.name,
    shape: 'observed', source: 'curated-drive',
    localeUrl: localeUrl || '', perspectiveId: null,
    landmarkUids: [],
    params: params.map((n) => ({ name: n, label: String(n).toLowerCase().replace(/_/g, ' '), used: true, value: '' })),
    aliases: [], phases: [rec.name], binding: [],
    synthesized: true, createdAt: now,
    trial: { score: null, verdict: 'observed', trialRef: null },
  };
  if (strategyId) { cap.strategyId = strategyId; cap.fragmentIds = Array.isArray(fragmentIds) ? fragmentIds.slice() : []; }
  else { cap.fragmentId = fragmentId; cap.fragmentIds = [fragmentId]; }
  return cap;
}

/**
 * Build a tier-1 artifact's Fragment + capability from its record and the live-probe results. PURE
 * (`now`/`newId` injected; the handler does the probes + saves). Steps keep INLINE SG-LM-3 landmarks
 * (role + accessibleName + the resolved-or-guessed selector) so replay self-heals via probe-or-recover.
 * `resolvedSelectors` maps step index → the probe-resolved selector (overrides the catalog guess).
 * @returns {{fragment:object, capability:object}|null}
 */
const _INTERACTIVE = new Set(['CLICK', 'CLICK_BY_LABEL', 'TYPE', 'SELECT', 'SET_FILE', 'KEY']);
const _PACING_SKIP = new Set(['WAIT', 'WAIT_FOR', 'WAIT_FOR_GONE', 'NAVIGATE', 'SCROLL_TO']);

export function buildDriveFragment(rec, { groundId = '', localeUrl = '', now = 0, newId = () => 'id', resolvedSelectors = {} } = {}) {
  if (!rec || !groundId || !Array.isArray(rec.steps) || !rec.steps.length) return null;
  const declared = (Array.isArray(rec.params) ? rec.params : []).map((p) => p && p.name).filter(Boolean);
  const actions = [];
  rec.steps.forEach((s, i) => {
    const selector = resolvedSelectors[i] || s.selector || '';
    const a = { action: s.action, selector };
    if (s.value != null) a.value = String(s.value);
    if (s.optional === true) a.optional = true;
    if (s.proto && (s.proto.role || s.proto.accessibleName)) {
      a.landmark = { role: s.proto.role ?? null, accessibleName: s.proto.accessibleName ?? null, selector: selector || null, hierarchicalContext: null };
    }
    // Human-cadence pacing after SPA settle steps — not before WAIT_FOR (which IS the settle).
    if (_INTERACTIVE.has(s.action)) {
      const prev = actions[actions.length - 1];
      actions.push((!actions.length || (prev && _PACING_SKIP.has(prev.action)))
        ? { action: 'WAIT', value: 1200, jitter: 600 }
        : { action: 'WAIT', value: 350, jitter: 750 });
    }
    actions.push(a);
  });
  const used = declared.filter((n) => actions.some((a) => typeof a.value === 'string' && a.value.includes(`{{${n}}}`)));
  const fragmentId = newId();
  const fragment = {
    id: fragmentId, groundId,
    name: String(rec.name || rec.id).slice(0, 80),
    description: rec.does || rec.name,
    rawJson: JSON.stringify(actions),
    params: used,
    preconditions: [], postconditions: [],
    healthStatus: 'untested', lastExecutedAt: null,
    synthesized: true, createdAt: now, updatedAt: now,
  };
  const capability = _driveCapability(rec, { groundId, localeUrl, now, id: newId(), fragmentId, params: used });
  return { fragment, capability };
}

/**
 * Build a tier-2 artifact's Strategy + capability, REFERENCING the composed tier-1 fragments (the T1→T2
 * reuse — no fragment duplication). PURE. `composed` = ordered [{fragmentId, params:[names the FRAGMENT
 * declares]}]; each fragment param binds `{kind:'strategy_param'}` so values flow scope → fragment at replay.
 * @returns {{strategy:object, capability:object}|null}
 */
export function buildDriveStrategy(rec, composed, { groundId = '', localeUrl = '', now = 0, newId = () => 'id' } = {}) {
  if (!rec || !groundId || !Array.isArray(composed) || !composed.length) return null;
  const usedNames = [];
  const fragmentSteps = composed.map((c) => {
    const paramBindings = {};
    for (const n of (Array.isArray(c.params) ? c.params : [])) {
      paramBindings[n] = { kind: 'strategy_param', name: n };
      if (!usedNames.includes(n)) usedNames.push(n);
    }
    return { type: 'fragment', fragmentId: c.fragmentId, paramBindings };
  });
  const strategyId = newId();
  const strategy = {
    id: strategyId, groundId,
    name: String(rec.name || rec.id).slice(0, 80),
    goal: rec.does || rec.name,
    // required:false — an unbound param substitutes '' and its label-click SKIPS (the v2.74.877 contract),
    // so "review the open tasks" without a division still walks as far as it can.
    params: usedNames.map((n) => ({ name: n, kind: 'scalar', type: 'string', required: false, label: String(n).toLowerCase().replace(/_/g, ' '), default: '' })),
    fragmentSteps, aliases: [], outcomeSignal: null,
    synthesized: true, createdAt: now, updatedAt: now,
  };
  const capability = _driveCapability(rec, { groundId, localeUrl, now, id: newId(), strategyId, fragmentIds: composed.map((c) => c.fragmentId), params: usedNames });
  return { strategy, capability };
}
