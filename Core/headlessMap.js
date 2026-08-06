// Core/headlessMap.js — CD-1a phase 2: headless MAP (DESIGN_cadence.md §11.3).
// Pinned, LLM-free: target capabilityId + groundId + valueParam banked at qualify; fire re-runs the lookup
// over prior rows via INVOKE_SESSION. Fail closed on missing pin / drift — never INTERPRET_ASK.

import { rowsOf } from './headlessClause.js';
import { ladderValues, normalizeRungs } from './peritemMap.js';
import { rowsFromValue } from './connectorRender.js';
import { armable } from './rideRecipe.js';
import { invokeRideRecipe, projectRideLeg } from './rideStep.js';

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

function _pinOf(clause) {
  const p = clause && (clause.pinned || clause.clause);
  return (p && typeof p === 'object') ? p : null;
}

function _rowLabel(row) {
  if (!row || typeof row !== 'object') return 'row';
  for (const k of ['label', 'name', 'Name', 'title', 'Title', 'TaskNumber', 'email', 'Email']) {
    if (_str(row[k])) return _str(row[k]).slice(0, 60);
  }
  return 'row';
}

/** Join values for one row: explicit itemField, else source joinKey ladder, else empty. */
function _joinValues(row, pin, sourceLeg) {
  const field = _str(pin.itemField);
  if (field && row && typeof row === 'object' && row[field] != null && _str(row[field])) {
    return [_str(row[field])];
  }
  const jk = sourceLeg && sourceLeg.tool && sourceLeg.tool.joinKey;
  const rungs = normalizeRungs(jk);
  if (rungs && rungs.length) {
    const vals = ladderValues(row, rungs);
    if (Array.isArray(vals) && vals.length) return vals.map(_str).filter(Boolean);
  }
  return [];
}

function _lookupHit(value) {
  const rows = rowsFromValue(value);
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Run ONE banked map step headless.
 * @param {object} clause  replayPlan clause; pin: { kind:'map', system, capabilityId, groundId, valueParam, itemField?, bindings? }
 * @param {{ state?:object, invoke?:Function, readRecipes?:Function }} io
 */
export async function runMapStep(clause, { state = null, invoke = null, readRecipes = null, onRow = null } = {}) {
  const pin = _pinOf(clause);
  if (!pin || _str(pin.kind) !== 'map') return { ok: false, error: 'not-map' };
  const capId = _str(pin.capabilityId);
  const groundId = _str(pin.groundId);
  const valueParam = _str(pin.valueParam);
  if (!capId || !groundId || !valueParam) return { ok: false, error: 'map-not-banked' };

  const rows = rowsOf(state && state.lastValue);
  if (!rows || !rows.length) return { ok: false, error: 'no-prior-rows' };

  let recs = [];
  try { recs = (typeof readRecipes === 'function' ? await readRecipes(groundId) : []) || []; } catch { recs = []; }
  const rec = recs.find((r) => r && r.id === capId);
  if (!rec) return { ok: false, error: 'target-gone' };
  if (!armable(rec)) return { ok: false, error: 'target-not-armed' };

  const tgtLeg = projectRideLeg(rec, groundId);   // v2.74.2047 — the one SW projection (raw recipeToLeg lost seeded records)
  if (!tgtLeg) return { ok: false, error: 'no-target-leg' };

  const baseParams = (pin.bindings && typeof pin.bindings === 'object') ? { ...pin.bindings } : {};
  const sourceLeg = (state && state.lastLeg) || (state && state.lastMapLeg) || null;
  const joined = [];
  const misses = [];
  let matched = 0, noMatch = 0, noField = 0, failed = 0;
  const cap = Math.max(1, Math.min(Number(pin.cap) || 40, rows.length));

  for (let i = 0; i < cap; i++) {
    const row = rows[i];
    const vals = _joinValues(row, pin, sourceLeg);
    if (!vals.length) {
      noField++;
      misses.push({ row, label: _rowLabel(row), value: '', matched: false });
      joined.push({ row, match: null, value: '' });
      continue;
    }
    let hit = null;
    let used = '';
    let rowFailed = false;   // v2.74.2044 — some value's INVOKE failed (http-4xx/5xx/timeout); distinct from an empty result
    for (const v of vals) {
      used = v;
      const r = await invokeRideRecipe(rec, groundId, {
        invoke,
        params: { ...baseParams, [valueParam]: v },
        literalSafeParams: true,
      });
      if (!r || !r.ok) { rowFailed = true; continue; }
      if (_lookupHit(r.value)) { hit = r.value; break; }
    }
    if (hit) {
      matched++;
      joined.push({ row, match: hit, value: used });
    } else if (rowFailed) {
      // v2.74.2044 — a FAILED lookup is NOT a no-match. Pre-2044 this row fell into `misses`, and
      // Core/headlessWrite consumes lastMisses verbatim: one rate-limited run auto-CREATED records (gate-'auto')
      // for rows that were never missing, or inflated the parked preview a human then approved. Unknown ≠ absent —
      // the row stays OUT of the write set and tallies `failed` ONCE (per row, not per ladder value).
      failed++;
      joined.push({ row, match: null, value: used, lookupFailed: true });
    } else {
      noMatch++;
      misses.push({ row, label: _rowLabel(row), value: used, matched: false });
      joined.push({ row, match: null, value: used });
    }
    // v2.74.2047 — per-row progress beat: the cadence host keeps the in-flight run marker alive across a long
    // lookup chain (the same heartbeat the each sweep uses — a 121-row map exceeds the 5-min died-window too).
    if (typeof onRow === 'function') { try { onRow(i + 1, cap); } catch { /* a beat must never break the map */ } }
  }

  const counts = { total: cap, matched, noMatch, noField, failed };
  const lookup = {
    leg: tgtLeg,
    baseParams,
    valueParam,
    groundId,
  };
  const nextState = {
    ...(state || {}),
    lastValue: joined,
    lastMisses: misses,
    lastMapLeg: sourceLeg,
    lastMapLookup: lookup,
    lastMapSystem: _str(pin.system) || '',
    lastMapCounts: counts,
    lastMapRan: true,
  };
  // v2.74.2044 — failures with NO completed verdict (nothing matched, nothing verifiably missing) mean the lookup
  // LAYER is down (auth / rate-limit), not that the data is absent. Surface it as a step failure and STOP the
  // chain: without `stop`, runDriver continues and the write step reads `lastMisses:[] + lastMapRan` as the
  // all-matched noop — a lying "every row matched" in run history. With partial signal (some matched / verified
  // no-match) the run stays ok: the write set holds only VERIFIED misses, and counts.failed carries the rest.
  if (failed > 0 && matched === 0 && noMatch === 0) {
    return { ok: false, error: 'lookup-failed', stop: true, state: nextState };
  }
  return {
    ok: true,
    value: { kind: 'map', joined, counts },
    state: nextState,
  };
}
