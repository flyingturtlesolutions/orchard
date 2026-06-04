// Core/orchRoute.js — ORCH-CB slice 2: the deterministic SHAPE router (the front door of comprehension).
//
// Comprehension splits into SHAPE (syntactic, stable → here, deterministic) and MEANING (semantic, novel → the
// LLM / intent-driven pipeline, later). This module owns the SHAPE half: given an ask, decide its OUTERMOST
// structure and hand a comprehender (slice 3) the precomputed signals so it never re-derives them ("don't
// re-derive what you already know"). PURE — no DOM / chrome / LLM. See docs/DESIGN_comprehension_split.md §1, §5.
//
//   routeShape(ask) → { shape, signals }
//
// PRECEDENCE (outermost-wins). The comprehenders RECURSE, so the router only picks the TOP-LEVEL shape; a nested
// structure is re-routed when its comprehender processes the sub-clause.
//   1. a LEADING conditional ("if/when/unless …, do X") → conditional — the condition gates everything after it.
//   2. a quantifier ("…of each", "click each …")        → foreach     — the loop dominates a TRAILING conditional.
//   3. any other conditional ("do X unless Y")           → conditional.
//   4. a compound ask (>1 clause)                        → sequence.
//   5. a single read ("the salary", "how many?")         → read.
//   6. otherwise                                          → action.
// Example of why the order matters:
//   "if there are jobs, click each"        → conditional (consequent "click each" recurses → foreach)
//   "click each job and if remote, save"   → foreach     (body "if remote, save" recurses → conditional)
//
// @module Core/orchRoute
// @version 2.74.735

import { isForeachAsk, decomposeAsk } from './orchChain.js';
import { isConditionalAsk } from './orchAnalyze.js';
import { classifyReadAsk } from './observe.js';

/** The shapes a comprehender handles — one per top-level structure. */
export const SHAPES = Object.freeze(['conditional', 'foreach', 'sequence', 'read', 'action']);

// A conditional keyword at the START of the ask: the condition governs (gates) the whole rest of the sentence, so
// it's the OUTERMOST structure even when the consequent itself quantifies ("if there are jobs, click each").
const _LEADING_CONDITIONAL = /^\s*(?:please\s+|also\s+|then\s+|now\s+)?(if|when|whenever|unless|once|in case)\b/i;

/**
 * Route an ask to its top-level comprehension SHAPE, with the deterministic signals already computed. PURE.
 * @param {string} ask
 * @returns {{shape:('conditional'|'foreach'|'sequence'|'read'|'action'), signals:{
 *   leadingConditional:boolean, isConditional:boolean, isForeach:boolean, isCompound:boolean, isRead:boolean,
 *   readClass:object, clauses:Array<{text:string,connective:(string|null)}>}}}
 */
export function routeShape(ask) {
  const a = String(ask || '');
  const clauses = decomposeAsk(a);
  const readClass = classifyReadAsk(a);
  const signals = {
    leadingConditional: _LEADING_CONDITIONAL.test(a),
    isConditional: isConditionalAsk(a),
    isForeach: isForeachAsk(a),
    isCompound: clauses.length > 1,
    isRead: !!(readClass && readClass.isRead),
    readClass,
    clauses,
  };
  let shape;
  if (signals.leadingConditional) shape = 'conditional';       // 1 — the condition gates the rest
  else if (signals.isForeach) shape = 'foreach';                // 2 — the loop outranks a trailing conditional
  else if (signals.isConditional) shape = 'conditional';        // 3 — a trailing/guard conditional
  else if (signals.isCompound) shape = 'sequence';              // 4 — an ordered compound
  else if (signals.isRead) shape = 'read';                      // 5 — a single read
  else shape = 'action';                                        // 6 — a single action
  return { shape, signals };
}
