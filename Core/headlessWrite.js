// Core/headlessWrite.js — CD-1a phase 2: headless WRITE with pipelineGate (product 2026-08-05).
// Internal + reversible → auto (create customer, draft order). Outward / undeclared → park.

import { writePreflight } from './writeClause.js';
import { resolveWriteValue, prepareShopifyCustomerCreateParams } from './writeMap.js';
import { gateActionForLeg } from './pipelineGate.js';
import { legParamDefs, recipeToLeg } from './connectorLeg.js';
import { armable } from './rideRecipe.js';
import { invokeRideRecipe } from './rideStep.js';

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
  state = null, invoke = null, readRecipes = null, reporter = null, runId = '',
} = {}) {
  const pin = _pinOf(clause);
  if (!pin || _str(pin.kind) !== 'write') return { ok: false, error: 'not-write' };

  const misses = Array.isArray(state && state.lastMisses) ? state.lastMisses : [];
  const srcLeg = (state && state.lastMapLeg) || null;
  const lookup = (state && state.lastMapLookup) || null;
  const mapRan = !!(state && (state.lastMapRan || state.lastMapLookup));

  if (!misses.length) {
    if (mapRan) {
      return {
        ok: true,
        value: { kind: 'write', noop: true, created: 0, why: 'nothing to create — every row matched' },
        state: { ...(state || {}), lastStopWhy: 'nothing to create — every row matched', lastWriteCounts: { created: 0 } },
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

  const createLeg = recipeToLeg({ ...rec, groundId }, { account: 'me', trusted: true });
  if (!createLeg) return { ok: false, error: 'write-no-leg' };

  const gate = gateActionForLeg(createLeg);
  if (gate.decision === 'refused') return { ok: false, error: `write-refused: ${gate.why}` };

  if (gate.decision === 'queued') {
    // Outward / undeclared — park for Approve (§8, amended: only non-auto).
    if (reporter && typeof reporter.gate === 'function') {
      try { await reporter.gate({ preview: { targetId, count: misses.length, why: gate.why } }); } catch { /* */ }
    }
    return {
      park: true,
      parkedRunId: runId,
      value: { kind: 'writePreview', targetId, count: misses.length, why: gate.why },
      state,
    };
  }

  // AUTO — internal + reversible
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

    const r = await invokeRideRecipe(rec, groundId, { invoke, params, literalSafeParams: true });
    if (r && r.ok) {
      created++;
      createdLabels.push(_rowLabel(row));
    } else failed++;
  }

  const counts = { created, unfillable, failed, queued: 0 };
  return {
    ok: true,
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
