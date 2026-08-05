// Core/headlessMap.js — CD-1a phase 2: headless MAP (DESIGN_cadence.md §11.3).
// Pinned, LLM-free: target capabilityId + groundId + valueParam banked at qualify; fire re-runs the lookup
// over prior rows via INVOKE_SESSION. Fail closed on missing pin / drift — never INTERPRET_ASK.

import { rowsOf } from './headlessClause.js';
import { ladderValues, normalizeRungs } from './peritemMap.js';
import { rowsFromValue } from './connectorRender.js';
import { armable } from './rideRecipe.js';
import { recipeToLeg } from './connectorLeg.js';
import { invokeRideRecipe } from './rideStep.js';

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
export async function runMapStep(clause, { state = null, invoke = null, readRecipes = null } = {}) {
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

  const tgtLeg = recipeToLeg({ ...rec, groundId }, { account: 'me', trusted: true });
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
    for (const v of vals) {
      used = v;
      const r = await invokeRideRecipe(rec, groundId, {
        invoke,
        params: { ...baseParams, [valueParam]: v },
        literalSafeParams: true,
      });
      if (!r || !r.ok) { failed++; continue; }
      if (_lookupHit(r.value)) { hit = r.value; break; }
    }
    if (hit) {
      matched++;
      joined.push({ row, match: hit, value: used });
    } else {
      noMatch++;
      misses.push({ row, label: _rowLabel(row), value: used, matched: false });
      joined.push({ row, match: null, value: used });
    }
  }

  const counts = { total: cap, matched, noMatch, noField, failed };
  const lookup = {
    leg: tgtLeg,
    baseParams,
    valueParam,
    groundId,
  };
  return {
    ok: true,
    value: { kind: 'map', joined, counts },
    state: {
      ...(state || {}),
      lastValue: joined,
      lastMisses: misses,
      lastMapLeg: sourceLeg,
      lastMapLookup: lookup,
      lastMapSystem: _str(pin.system) || '',
      lastMapCounts: counts,
      lastMapRan: true,
    },
  };
}
