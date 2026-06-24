// Core/writeGate.js — CV-6 (v2.74.1172): the per-app write gate (DESIGN_conversations.md §8). PURE.
//
// An app's `config.writePolicy` can only TIGHTEN the global floor (decision #2). v1 enforces the read-only
// tightening: `writePolicy:'never'` (a strict monitor — e.g. Financial / Research) blocks any ACT (a state-changing
// run), allowing only READS (observations). `'gated'` (the default) defers to the existing per-action confirm /
// money=human-click gates. A sub-task INHERITS its app's policy (tighten-only, §6), so the gate just reads the
// CURRENT track's config. This is the ENFORCED form of the §8 promise — "a per-app 'strict security' that's only
// prose is not a boundary; writePolicy is the enforced version."

import { normalizeConfig } from './appDef.js';

export const ACTION_EFFECTS = ['read', 'act', 'money'];

/**
 * Decide whether an action is permitted under a track's config. PURE.
 * @param {object} config   the track's app config ({ writePolicy }) — a sub-task carries its app's (tightened) copy
 * @param {{ effect?: 'read'|'act'|'money' }} [action]   the action's effect class (default 'act' — the strict side)
 * @returns {{ allowed: boolean, reason: string, policy: string }}
 */
export function evaluateAction(config, action = {}) {
  const policy = normalizeConfig(config).writePolicy;                            // 'gated' | 'never'
  const effect = ACTION_EFFECTS.includes(action && action.effect) ? action.effect : 'act';
  if (effect === 'read') return { allowed: true, reason: 'read', policy };       // reads are always allowed
  if (policy === 'never') return { allowed: false, reason: 'read-only', policy };// a read-only app blocks acts + money
  return { allowed: true, reason: 'gated', policy };                             // 'gated' — confirm / money-human-click handle the rest
}

/** Convenience: is a state-changing ACT allowed under this config? PURE. (Reads never reach this — they bypass the gate.) */
export function actAllowed(config) {
  return evaluateAction(config, { effect: 'act' }).allowed;
}
