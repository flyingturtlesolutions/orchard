// Core/orchComprehend.js — ORCH-CB slice 3: the COMPREHENDERS — ask → a PlanShape of unbound, effect-tagged slots.
//
// Comprehension yields the plan SHAPE from the ask ALONE — no substrates, no page. The router (orchRoute) picks the
// top-level shape; a per-shape comprehender builds the slot tree, REUSING the proven lifts (liftConditional) by
// feeding them effect-classified clause-slots instead of LLM-bound steps. Every leaf is tagged with its work-kind
// (read/act/reason) and bind scope (locale/ground/global), and carries `capabilityId:null` (a gap until BIND fills
// it — slice 4). PURE — no DOM / chrome / LLM. See docs/DESIGN_comprehension_split.md §1, §3, §5.
//
//   comprehend(ask) → { shape, steps:Slot[], escalate:boolean }
//
// `escalate:true` means the deterministic floor got the SHAPE but the MEANING decomposition is semantic (e.g. a
// foreach's implicit collection + body split) → the caller should prefer the LLM (ORCH_PLAN/intent-driven). The
// floor still returns a best-effort flat decomposition so an empty ground can show gaps either way.
//
// @module Core/orchComprehend
// @version 2.74.736

import { decomposeAsk, liftConditional } from './orchChain.js';
import { classifyReadAsk } from './observe.js';
import { effectForKind } from './orchPlan.js';
import { routeShape } from './orchRoute.js';

const _COND_KW = /\b(if|when|whenever|unless|once|in case)\b/i;

/** Split a conditional ask into { head, condition, consequent }. PURE. Handles "KW <cond>, <consequent>" (leading,
 *  optional HEAD before the keyword) and "<consequent> KW <cond>" (trailing). Returns null when it can't split. */
function _splitConditional(ask) {
  const a = String(ask || '').trim();
  const m = a.match(_COND_KW);
  if (!m) return null;
  const pre = a.slice(0, m.index).trim();
  const post = a.slice(m.index + m[0].length).trim();
  const comma = post.indexOf(',');
  if (comma >= 0) {
    return {
      head: pre.replace(/[,;]\s*$/, '').replace(/\s*\b(and|then)\b\s*$/i, '').trim(),
      condition: post.slice(0, comma).trim(),
      consequent: post.slice(comma + 1).trim(),
    };
  }
  if (pre) return { head: '', condition: post, consequent: pre.replace(/[,;]\s*$/, '').trim() };
  return null;
}

// A lift-input pseudo-step from a clause (the ORCH_PLAN convention: kind 'observation' for a read, null for an
// act). The lifts read this and emit proper IR leaves (observe/fragment). `read` forces the classification.
function _liftInput(text, read) {
  const rc = classifyReadAsk(text);
  const isRead = read == null ? !!rc.isRead : read;
  return { clause: text, intent: text, capabilityId: null, kind: isRead ? 'observation' : null, outputType: isRead ? (rc.outputType || 'scalar') : null };
}

// A proper IR leaf slot (observe for a read, fragment for an act) directly from a clause.
function _leaf(text, id, readOverride) {
  const rc = classifyReadAsk(text);
  const isRead = readOverride == null ? !!rc.isRead : readOverride;
  return isRead
    ? { kind: 'observe', id, capabilityId: null, outputType: rc.outputType || 'scalar', intent: text, clause: text }
    : { kind: 'fragment', id, capabilityId: null, intent: text, clause: text };
}

function _roleFromId(id) {
  const s = String(id || '');
  if (s.startsWith('head')) return 'head';
  if (s === 'cond') return 'condition';
  if (s === 'pred') return 'predicate';
  if (s.startsWith('act')) return 'consequent';
  if (s.startsWith('each_') || s === 'driver') return 'driver';
  return 'step';
}

// Tag every leaf with effect (read/act/reason) + scope (default ground; slice 4+ may widen) + role. Recurses into
// control-flow bodies. Mutates in place (the steps are freshly built). PURE apart from that mutation.
function _tag(steps) {
  for (const s of (Array.isArray(steps) ? steps : [])) {
    if (!s) continue;
    if (s.kind === 'foreach' || s.kind === 'loop' || s.kind === 'gate') {
      s.scope = s.scope || 'ground';
      if (Array.isArray(s.body)) _tag(s.body);
    } else if (s.kind === 'wait') {
      // structural pacing — no effect/scope
    } else {
      const eff = effectForKind(s.kind);
      if (eff) s.effect = s.effect || eff;
      s.scope = s.scope || 'ground';
      s.role = s.role || _roleFromId(s.id);
    }
  }
  return steps;
}

function _comprehendConditional(ask) {
  const split = _splitConditional(ask);
  if (!split || !split.condition || !split.consequent) return null;
  const ps = [];
  if (split.head) for (const c of decomposeAsk(split.head)) ps.push(_liftInput(c.text, false));
  ps.push(_liftInput(split.condition, true));                                 // the condition is, by shape, a read
  for (const c of decomposeAsk(split.consequent)) ps.push(_liftInput(c.text, false));
  if (ps.length < 2) return null;
  const lifted = liftConditional(ps, ask);
  return lifted.lifted ? lifted.steps : null;
}

function _comprehendSequence(ask) {
  return decomposeAsk(ask).map((c, i) => _leaf(c.text, `s${i}`));
}

/**
 * Comprehend an ask into a PlanShape (unbound, effect-tagged slots). PURE — substrate-free. Reuses liftConditional
 * for the conditional shape; foreach escalates (semantic body split) with a best-effort flat decomposition.
 * @param {string} ask
 * @returns {{shape:string, steps:object[], escalate:boolean}}
 */
export function comprehend(ask) {
  const { shape } = routeShape(ask);
  let steps = null;
  let escalate = false;
  if (shape === 'conditional') {
    steps = _comprehendConditional(ask) || _comprehendSequence(ask);
  } else if (shape === 'foreach') {
    steps = _comprehendSequence(ask);   // the collection/body split is MEANING → defer to the LLM
    escalate = true;
  } else if (shape === 'sequence') {
    steps = _comprehendSequence(ask);
  } else if (shape === 'read') {
    steps = [_leaf(String(ask || ''), 's0', true)];
  } else {
    steps = [_leaf(String(ask || ''), 's0', false)];
  }
  return { shape, steps: _tag(steps), escalate };
}
