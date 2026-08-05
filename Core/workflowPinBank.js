// Core/workflowPinBank.js — v2.74.2038/2039: post-▶ pin banking seam (index then text find). Chat feeds
// wf.subAsks (2039 fixed the lowercase typo that always refused no-ranSteps with empty asks).

import { stepProvenance } from './workflowWizard.js';
import { workflowTier } from './workflowTier.js';

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** Warranty preset subasks — shared fixture for cause tests. */
export const WARRANTY_SUBASKS = [
  'get all new warranty tasks across every division',
  'for each task, find the homeowner\'s Shopify customer account',
  'create a Shopify customer for each one with no match, using the homeowner\'s name, phone, email and property address',
];

/**
 * Today's assign: ranSteps[i] OR find by clause/intent === subask text. PURE.
 * Index wins when slot i is occupied — even if the kind is wrong for that subask.
 */
export function pickRanStep(ranSteps, subaskText, index) {
  const list = Array.isArray(ranSteps) ? ranSteps : [];
  const text = String(subaskText ?? '');
  const at = list[index];
  if (at) return at;
  return list.find((r) => r && String(r.clause || r.intent || '') === text) || null;
}

/** Body-blind presence bit for one ranStep / clause. */
function _bits(o, keys) {
  if (!o || typeof o !== 'object') return keys.map((k) => `${k[0]}:!`).join('');
  return keys.map(([k, short]) => `${short}:${_str(o[k]) ? '+' : '!'}`).join('');
}

/**
 * Presence dump across raw ranSteps (kinds in order). No values/PII.
 * e.g. `ride:c+g|map:c+g+v|write:c+g`
 */
export function ranPresence(ranSteps) {
  const list = Array.isArray(ranSteps) ? ranSteps : [];
  return list.map((r) => {
    const kind = _str(r && r.kind) || '?';
    if (kind === 'map') return `map:${_bits(r, [['capabilityId', 'c'], ['groundId', 'g'], ['valueParam', 'v']])}`;
    if (kind === 'write') return `write:${_bits(r, [['capabilityId', 'c'], ['groundId', 'g']])}`;
    if (kind === 'connector' || kind === 'ride') return `ride:${_bits(r, [['capabilityId', 'c'], ['groundId', 'g']])}`;
    return `${kind}:·`;
  }).join('|');
}

function _mapComplete(clause) {
  return !!(clause && clause.kind === 'map' && _str(clause.capabilityId) && _str(clause.groundId) && _str(clause.valueParam));
}

function _rideComplete(clause) {
  const k = clause && clause.kind;
  return !!((k === 'connector' || k === 'ride') && _str(clause.capabilityId) && _str(clause.groundId));
}

/**
 * Pure decision mirror of chat `_wfPersistPinsFromRun` (pre-write).
 * @param {{ subasks:string[], ranSteps:Array, recordExists?:boolean|'other-only' }} p
 * @returns {{ refuse:string, steps:Array, pinnedCount:number, tier:string, ranPresence:string }}
 */
export function evaluatePinBank({ subasks, ranSteps, recordExists = true } = {}) {
  const presence = ranPresence(ranSteps);
  if (!Array.isArray(ranSteps) || !ranSteps.length) {
    return { refuse: 'no-ranSteps', steps: [], pinnedCount: 0, tier: 'panel', ranPresence: presence };
  }
  const asks = Array.isArray(subasks) ? subasks.map(_str).filter(Boolean) : [];
  if (asks.length < 2) {
    return { refuse: 'no-ranSteps', steps: [], pinnedCount: 0, tier: 'panel', ranPresence: presence };
  }

  const now = 0;
  const steps = asks.map((text, i) => {
    const ran = pickRanStep(ranSteps, text, i);
    const prov = ran ? stepProvenance(ran, text, '', now) : { text, via: { kind: null, host: null, name: null }, bankedAt: now };
    return { text, via: prov.via, bankedAt: prov.bankedAt || now, ...(prov.clause ? { clause: prov.clause } : {}) };
  });

  const hasMapPin = steps.some((s) => _mapComplete(s.clause));
  const hasRidePin = steps.some((s) => _rideComplete(s.clause));
  const pinnedCount = steps.filter((s) => s.clause && (s.clause.capabilityId || s.clause.kind)).length;
  const tier = workflowTier({ steps });

  if (!hasMapPin) {
    return { refuse: 'map-fields', steps, pinnedCount, tier, ranPresence: presence };
  }
  if (!hasRidePin) {
    return { refuse: 'ride-incomplete', steps, pinnedCount, tier, ranPresence: presence };
  }
  if (recordExists === false || recordExists === 'other-only') {
    return { refuse: 'update-miss', steps, pinnedCount, tier, ranPresence: presence };
  }
  // In-memory would bank; live path may still normalize-dropped / tier-panel after write.
  return { refuse: tier === 'sw' ? 'ok-ready' : 'tier-panel', steps, pinnedCount, tier, ranPresence: presence };
}

/** After storage read-back: refine ok-ready → ok | normalize-dropped | tier-panel | update-miss. PURE. */
export function refinePinBankAfterStore(decision, storedWf) {
  const d = decision && typeof decision === 'object' ? decision : {};
  if (d.refuse !== 'ok-ready') return d;
  if (!storedWf) return { ...d, refuse: 'update-miss', storedPinned: 0 };
  const stSteps = Array.isArray(storedWf.steps) ? storedWf.steps : [];
  const storedPinned = stSteps.filter((s) => s && s.clause && (s.clause.capabilityId || s.clause.kind)).length;
  const tier = workflowTier(storedWf);
  if (storedPinned === 0) return { ...d, refuse: 'normalize-dropped', storedPinned, tier };
  if (tier !== 'sw') return { ...d, refuse: 'tier-panel', storedPinned, tier };
  return { ...d, refuse: 'ok', storedPinned, tier };
}
