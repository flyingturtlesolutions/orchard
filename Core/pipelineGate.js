/**
 * Core/pipelineGate.js — the PIPELINE's own gate (v2.74.1665). Pure.
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §4 (the gate + its ⚠ build-time amendment) · §9.4 (`reversible` is a
 * third name for `destructive`) · §10.1 (adopt, don't undo).
 *
 * ── WHY THE RULE LIVES HERE AND NOT IN `hintToSafety` ────────────────────────────────────────────────────────
 * §4 states the policy as `gate = outward || !reversible`, and at v2.74.1661 that was deliberately NOT applied
 * to the global classifier, because applied there it LOWERS: `shopify_create_customer`, `shopify_create_order`,
 * `add_tags`, `create_user` and `set_ticket_requester` are all `reversible:true, outward:false`, and every one of
 * them floors at `confirm` today via `hintToSafety` plus a fail-closed executor belt. Shipping the rule globally
 * would have un-gated that entire class across every existing surface as a side effect of a per-item change.
 *
 * The user's policy — "profile creation is un-gated, it's a system-internal reversible step" — is a statement
 * about what a PIPELINE may do unattended inside a reviewed run, with a trial, a case and a tally around it. It
 * is not a request to lower the floor for every ad-hoc write in the product. So the relaxation lives here, where
 * that context exists, and `hintToSafety` keeps its floor. Two gates, deliberately, with different scopes.
 *
 * ── DEFAULTS FAIL CLOSED, AND THIS IS THE ONE THAT MUST ─────────────────────────────────────────────────────
 * §4: "an undeclared write is an unreviewed write, and the failure is SILENT — the action simply happens."
 * Every other unknown in this design surfaces as a visible gap; this one does not. So an action that declares
 * NEITHER axis is treated as `outward:true, reversible:false` → gated. Declaring the axes is part of adding a
 * write, not an enhancement.
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));
const _arr = (v) => (Array.isArray(v) ? v : []);

/** What the gate can decide. `refused` is for actions the pipeline may never take unattended at all. */
export const GATE_DECISIONS = Object.freeze(['auto', 'queued', 'refused']);

/**
 * Classes that stay human-click-only regardless of the axes — the standing rule the catalog already encodes by
 * EXCLUSION ("money / inventory mutations stay navigate-only human-clicks, never a recipe"). Encoded rather than
 * assumed, so a pipeline cannot reach them by declaring a friendly-looking pair of booleans.
 */
export const NEVER_UNATTENDED = Object.freeze(['money', 'inventory', 'credential', 'destructive']);

/**
 * Decide one action. PURE.
 *
 * @param {Object} action
 * @param {string}  action.what          human label
 * @param {boolean} [action.reversible]  can WE undo it, without a third party?
 * @param {boolean} [action.outward]     does it leave our boundary (email sent, order confirmed, message posted)?
 * @param {string}  [action.klass]       one of NEVER_UNATTENDED, when it applies
 * @returns {{decision:string, why:string}}
 */
export function gateAction(action = {}) {
  const what = _str(action.what) || 'this action';
  const klass = _str(action.klass).toLowerCase();

  if (klass && NEVER_UNATTENDED.includes(klass)) {
    return { decision: 'refused', why: `${klass} stays a human click — never unattended` };
  }

  // The fail-closed default. `undefined` is UNDECLARED, which is not the same as `false`; only an explicit
  // declaration can relax the gate, so a missing axis can never quietly permit a write.
  const declaredOutward = typeof action.outward === 'boolean';
  const declaredReversible = typeof action.reversible === 'boolean';
  if (!declaredOutward || !declaredReversible) {
    return { decision: 'queued', why: `${what} does not declare reversible/outward — an undeclared write is an unreviewed write` };
  }

  if (action.outward) return { decision: 'queued', why: `${what} leaves our boundary and cannot be unsent` };
  if (!action.reversible) return { decision: 'queued', why: `${what} cannot be undone by us` };
  return { decision: 'auto', why: `${what} is internal and reversible` };
}

/**
 * Composite: an action made of members takes the STRICTEST member's decision, and never its own independent
 * declaration. This is the `driveArtifacts` lesson ("tier-2 params derive as the UNION of the composed tier-1
 * entries") applied to safety: an UPSERT containing a gated create is gated, and cannot declare itself auto.
 */
export function gateComposite(members = [], { what = 'this step' } = {}) {
  const list = _arr(members);
  if (!list.length) return { decision: 'queued', why: `${what} has no declared members — nothing to derive safety from` };
  const results = list.map((m) => gateAction(m));
  const refused = results.find((r) => r.decision === 'refused');
  if (refused) return { decision: 'refused', why: refused.why };
  const queued = results.find((r) => r.decision === 'queued');
  if (queued) return { decision: 'queued', why: queued.why };
  return { decision: 'auto', why: `${what}: every member is internal and reversible` };
}

/**
 * Apply the gate across one item's planned actions, in declaration order.
 * Returns each action's decision plus whether the ITEM as a whole can proceed unattended.
 */
export function gateItem(actions = []) {
  const decided = _arr(actions).map((a) => ({ ...a, ...gateAction(a) }));
  const blocked = decided.filter((d) => d.decision !== 'auto');
  return {
    actions: decided,
    unattended: blocked.length === 0,
    queued: decided.filter((d) => d.decision === 'queued').length,
    refused: decided.filter((d) => d.decision === 'refused').length,
  };
}

/** The §5.5 gate line, one per action. Every decision is reported — including the autos. */
export function gateLine(itemLabel, action, result) {
  return `GATE   ▸ item=${_str(itemLabel) || '?'} ${_str(action && action.what) || 'action'} → ${result.decision}${result.decision === 'auto' ? '' : `(${result.why})`}`;
}

/** Honest tally, zeroes included. */
export function gateTally(results) {
  const list = _arr(results);
  const n = { auto: 0, queued: 0, refused: 0 };
  for (const r of list) if (n[r.decision] !== undefined) n[r.decision]++;
  return `${list.length} action${list.length === 1 ? '' : 's'} — ${n.auto} auto · ${n.queued} queued for approval · ${n.refused} refused`;
}
