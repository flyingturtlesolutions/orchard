// Core/headlessWrite.js — CD-1a phase 2: headless WRITE with pipelineGate (product 2026-08-05).
// Internal + reversible → auto (create customer, draft order). Outward / undeclared → park.

import { writePreflight } from './writeClause.js';
import { resolveWriteValue, prepareShopifyCustomerCreateParams } from './writeMap.js';
import { gateActionForLeg } from './pipelineGate.js';
import { legParamDefs } from './connectorLeg.js';
import { armable } from './rideRecipe.js';
import { invokeRideRecipe, projectRideLeg } from './rideStep.js';

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));
const WRITE_CAP = 25;

function _pinOf(clause) {
  const p = clause && (clause.pinned || clause.clause);
  return (p && typeof p === 'object') ? p : null;
}

function _rowLabel(row) {
  if (!row || typeof row !== 'object') return 'row';
  for (const k of ['label', 'name', 'Name', 'title', 'TaskNumber', 'email', 'Email']) {
    if (_str(row[k])) return _str(row[k]).slice(0, 60);
  }
  return 'row';
}

/**
 * Run ONE write step headless from prior map misses.
 * @returns {{ok?, value?, state?, error?, park?, parkedRunId?}}
 */
export async function runWriteStep(clause, {
  state = null, invoke = null, readRecipes = null, reporter = null, runId = '', onRow = null,
} = {}) {
  const pin = _pinOf(clause);
  if (!pin || _str(pin.kind) !== 'write') return { ok: false, error: 'not-write' };
  let humanApproved = false;   // v2.74.2043 — set only when a person cleared THIS write at the gate below

  const misses = Array.isArray(state && state.lastMisses) ? state.lastMisses : [];
  const srcLeg = (state && state.lastMapLeg) || null;
  const lookup = (state && state.lastMapLookup) || null;
  const mapRan = !!(state && (state.lastMapRan || state.lastMapLookup));

  if (!misses.length) {
    if (mapRan) {
      // v2.74.2044 — a partial-failure map (some lookups errored, every COMPLETED one matched) must not claim
      // "every row matched": the failed rows were never verified either way.
      const _mf = Number(state && state.lastMapCounts && state.lastMapCounts.failed) || 0;
      const _why = _mf > 0
        ? `nothing to create — every completed lookup matched (${_mf} lookup${_mf === 1 ? '' : 's'} failed)`
        : 'nothing to create — every row matched';
      return {
        ok: true,
        value: { kind: 'write', noop: true, created: 0, why: _why },
        state: { ...(state || {}), lastStopWhy: _why, lastWriteCounts: { created: 0 } },
      };
    }
    return { ok: false, error: 'no-misses' };
  }

  const pf = writePreflight({ misses, sourceLeg: srcLeg, want: (clause && clause.text) || '' });
  const targetId = pf.ok ? pf.targetId : (_str(pin.capabilityId) || '');
  if (!targetId) return { ok: false, error: pf.reason || 'no-write-target' };

  const groundId = _str((lookup && lookup.groundId) || pin.groundId);
  if (!groundId) return { ok: false, error: 'write-no-ground' };

  let recs = [];
  try { recs = (typeof readRecipes === 'function' ? await readRecipes(groundId) : []) || []; } catch { recs = []; }
  const rec = recs.find((r) => r && (r.id === targetId || r.id === _str(pin.capabilityId)));
  if (!rec || !armable(rec)) return { ok: false, error: 'write-recipe-gone' };

  const createLeg = projectRideLeg(rec, groundId);   // v2.74.2047 — the one SW projection (raw recipeToLeg lost seeded records)
  if (!createLeg) return { ok: false, error: 'write-no-leg' };

  let gate = gateActionForLeg(createLeg);

  // v2.74.2043 — UNATTENDED WRITE AUTHORITY IS CURATED-ONLY.
  //
  // Core/pipelineGate.NEVER_UNATTENDED (money / inventory / credential / destructive) is unreachable in
  // production: `gateActionForLeg(leg, {what})` has no `klass` parameter, so nothing can ever populate the one
  // check that has no exceptions. Today that is safe only BY ACCIDENT — money and inventory legs are held out of
  // the catalog by exclusion, and no forging path (manualRecipe / recipeFromObservedWrite / recipeFromHarvest)
  // declares `reversible`/`outward` at all, so a forged recipe fails closed to `queued` for want of a declaration.
  //
  // That accident has an expiry date, and invariant #3 IS the expiry date: its whole discipline is that recipe
  // fields must propagate to seeded/harvested Grounds. The day a generalizer copies `reversible:true,
  // outward:false` off an observed write — exactly what §17's crawl-as-generalizer is for — unattended write
  // authority arrives for a recipe no human ever reviewed, and nothing in the gate would notice.
  //
  // So the unattended path additionally requires CURATED provenance: a write that runs with nobody watching must
  // be one that shipped in the catalog and was reviewed by a person who is not the machine that harvested it.
  // Harvested / demonstrated / provenance-less recipes are not refused — they PARK, which is the existing
  // human-approval path, so nothing becomes unreachable; it stops being automatic.
  //
  // Scoped here rather than inside `gateActionForLeg` on purpose: this landing opens the headless write door, and
  // widening the shared gate in the same commit would silently retier the PANEL's write path (chat.js
  // `_runWriteClause`, which executes gate-`auto` rows inline with a human present and has no park path to fall
  // back to). One door at a time.
  if (gate.decision === 'auto' && _str(rec.provenance) !== 'curated') {
    gate = {
      decision: 'queued',
      why: `${rec.name || targetId} is ${_str(rec.provenance) ? `a ${_str(rec.provenance)} recipe` : 'a recipe with no declared provenance'} — only a curated catalog write runs unattended`,
    };
  }
  // v2.74.2043 — the gate verdict rides every return so the SW can speak it (`GATE   ▸`, Core/decisionMarkers.js).
  // Core stays Logger-free: the caller logs. Without this the single most consequential decision in a headless run
  // — auto vs park vs refuse — left no trace at all, and a park was indistinguishable from a failure in `gc`.
  const _gate = { decision: gate.decision, why: gate.why, targetId };
  if (gate.decision === 'refused') return { ok: false, error: `write-refused: ${gate.why}`, gate: _gate };

  if (gate.decision === 'queued') {
    // Outward / undeclared — park for Approve (§8, amended: only non-auto).
    //
    // v2.74.2043 — TWO defects fixed here, both silent.
    // (1) SHAPE: the preview was wrapped in `{preview:…}` while Core/rideStep.js:99 passes it DIRECTLY. The
    //     accumulator stores whatever it is given, so cadence banked `{preview:{preview:{…}}}` and the panel's
    //     park card (chat.js `_railParkedRow`) read `prev.recipe || prev.step` off the WRAPPER — every parked
    //     write rendered as a nameless "a write step" with no target and no row count. A human cannot approve
    //     what the card will not name, which makes the §8 HITL surface worse than useless.
    // (2) RETURN: the gate's verdict was awaited and DISCARDED, so this always parked. Core/rideStep.js:101
    //     already honors it. The consequence was that makeResumeReporter's one-approval contract
    //     (Core/runDriver.js:148-151) had no effect on a write step: ✓ Approve re-fired the run, the resume
    //     reporter returned `true`, and this parked it again — forever, with no way through.
    // The fail-safe is UNCHANGED and still structural: no reporter, a throwing reporter, or ANY non-`true`
    // verdict parks. Only an explicit `true` — which only makeResumeReporter produces, and only once, after a
    // human clicked — proceeds.
    const preview = { kind: 'write', targetId, recipe: rec.name || targetId, count: misses.length, why: gate.why };
    let decision = 'park';
    try {
      decision = (reporter && typeof reporter.gate === 'function') ? await reporter.gate(preview) : 'park';
    } catch { decision = 'park'; }
    if (decision !== true) {
      return {
        park: true,
        parkedRunId: runId,
        value: { kind: 'writePreview', ...preview },
        state,
        gate: _gate,
      };
    }
    // approved by a human (§8: one approval per write) — fall through and execute exactly this write.
    humanApproved = true;
  }

  // AUTO — internal + reversible — or a queued write a human just approved (above).
  const declared = pf.declared || null;
  const use = misses.slice(0, WRITE_CAP);
  const paramDefs = legParamDefs(createLeg);
  let created = 0, unfillable = 0, failed = 0;
  const createdLabels = [];

  for (const m of use) {
    const row = m && m.row;
    const filled = {};
    const missing = [];
    for (const pd of paramDefs) {
      const pname = (pd && pd.name) || pd;
      if (!pname) continue;
      const v = resolveWriteValue(row, pname, declared);
      if (v) filled[pname] = v;
      else if (pd && pd.required) missing.push(pname);
    }
    if (missing.length) { unfillable++; continue; }

    const params = (targetId === 'shopify_create_customer' || /shopify_create_customer/i.test(targetId))
      ? prepareShopifyCustomerCreateParams(filled)
      : filled;

    // v2.74.2043 — carry the AUTHORITY that cleared this write to the executor belt (Core/rideStep.stampWriteAuthority):
    // `gate` (decision 'auto') → gateCleared; a human's ✓ Approve → confirmed. Without one of these the belt refuses.
    const r = await invokeRideRecipe(rec, groundId, { invoke, params, literalSafeParams: true, gate, humanApproved });
    if (r && r.ok) {
      created++;
      createdLabels.push(_rowLabel(row));
    } else failed++;
    // v2.74.2047 — per-create progress beat (the cadence heartbeat; same rationale as headlessMap's onRow).
    if (typeof onRow === 'function') { try { onRow(created + failed + unfillable, use.length); } catch { /* */ } }
  }

  const counts = { created, unfillable, failed, queued: 0 };
  return {
    ok: true,
    gate: _gate,
    value: { kind: 'write', ...counts },
    state: {
      ...(state || {}),
      lastWriteCounts: counts,
      lastHistoryItems: [
        ...(Array.isArray(state && state.lastHistoryItems) ? state.lastHistoryItems : []),
        ...createdLabels.map((label) => ({ kind: 'created', label })),
      ],
    },
  };
}
