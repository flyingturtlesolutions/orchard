// Core/presetMemory.js — the TWO-TIER learning model (DESIGN_apps_learning.md §10). PURE: no chrome / clock / LLM.
//
// Two stores of goalMemory items (Core/goalMemory.js):
//   • INSTANCE memory (per configured app, private): the specifics — facts about THIS app's KB/site. Stays local.
//   • PRESET memory (per type, the shared template): generalizable BEHAVIOR RULES — "how to be a good <type>" —
//     accrued across instances and SEEDED into every new one, so a day-100 preset instantiates smarter than day-1.
//
// The instance↔preset split rides the existing belief/delta line: a BELIEF is a fact (instance-private — "Acme is
// enterprise"); a DELTA is a behavior rule (generalizable — "confirm resolution before closing"). So ONLY DELTAS
// rise, and only at the `canonical` tier (HITL-confirmed, §7) — the same promotion gate, applied to crossing the
// instance→preset boundary. The body must still be ABSTRACTED (specifics stripped) by an LLM step before it lands on
// the shared preset (the caller does that — §10.2); THIS module decides WHAT is eligible and HOW seeding works. The
// logic is identical whether the preset store is local or federated — federation is just whether it syncs (§10.3).

import { normalizeMemoryItem } from './goalMemory.js';

/** Eligible to RISE from an instance to its preset? PURE. A canonical (HITL-confirmed) behavior RULE only — never a
 * belief/fact (instance-private), never an unconfirmed rule. The body still needs abstraction before it's stored. */
export function isPromotableToPreset(item) {
  const i = normalizeMemoryItem(item);
  return !!(i && i.kind === 'delta' && i.tier === 'canonical');
}

/** The instance rules eligible to rise (the distill-up CANDIDATES). PURE. The caller abstracts + strips each before
 * merging into the preset store. */
export function promotableToPreset(instanceItems) {
  return (Array.isArray(instanceItems) ? instanceItems : []).filter(isPromotableToPreset);
}

/**
 * Seed a NEW instance from the preset's accrued rules + the preset's hand-authored BASELINE. PURE. Each becomes a
 * starting DELTA at the 'confirmed' tier — trusted (it came from the vetted preset) but NOT the instance's own
 * `canonical`, so it won't immediately re-promote UP; the instance must independently re-earn canonical through its
 * own use. Provenance 'preset-baseline' makes the audit show where a rule came from. De-duped by trigger|body.
 * ONLY behavior rules (deltas) seed — a preset never plants facts into an instance.
 */
export function seedInstanceFromPreset(presetItems, { baseline = [] } = {}) {
  const out = []; const seen = new Set();
  const src = [...(Array.isArray(baseline) ? baseline : []), ...(Array.isArray(presetItems) ? presetItems : [])];
  for (const raw of src) {
    const i = normalizeMemoryItem(raw);
    if (!i || i.kind !== 'delta' || !i.body) continue;
    const key = `${(i.trigger || '').toLowerCase()}|${i.body.toLowerCase()}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ kind: 'delta', trigger: i.trigger || null, body: i.body, epistemic: 'inferred',
               confidence: 0.8, tier: 'confirmed', provenance: 'preset-baseline' });
  }
  return out;
}

// ─── §10.2 distill UP (instance → preset) ─────────────────────────────────────────────────────────────────────────

/** The preset store's goalMemory key for a type. PURE. Single-sourced: seed-down READS it, distill-up WRITES it. */
export function presetMemoryKey(presetId) {
  const id = String(presetId == null ? '' : presetId).trim();
  return id ? `preset:${id}` : '';
}

/**
 * The instance deltas eligible to OFFER for distill-up, or []. PURE. A corroborated behavior RULE at tier `confirmed`
 * (the ratchet's earned ceiling) that did NOT come down from the preset — `preset-baseline` / `distilled-up` never
 * re-rises (already shared; re-rising would loop). `canonical` is excluded too: canonizing the instance copy is exactly
 * how a rule is MARKED done once it rises (the caller does that on confirm), so canonical = already-shared. Beliefs
 * (facts) are structurally barred (kind !== delta) — that IS the privacy boundary (§10). Carries the store `id` through
 * so the caller can canonize that exact item. The caller LLM-abstracts each, the user CONFIRMS (the §7 gate, applied to
 * crossing into the shared preset), then it's merged up + the instance copy canonized.
 */
export function distillCandidates(instanceItems) {
  return (Array.isArray(instanceItems) ? instanceItems : [])
    .map((raw) => { const i = normalizeMemoryItem(raw); return i ? { ...i, id: (raw && raw.id) || null } : null; })
    .filter((i) => i && i.kind === 'delta' && i.tier === 'confirmed'
      && i.provenance !== 'preset-baseline' && i.provenance !== 'distilled-up');
}

/**
 * Shape an ABSTRACTED rule (the caller's LLM stripped instance specifics) into a PRESET delta to merge up, or null.
 * PURE. Lands `canonical` (it crossed the HITL gate → vetted) with provenance `distilled-up` (the audit shows it rose
 * from an instance, vs `preset-baseline` hand-authored). The store (recordGoalItem on the preset key) content-dedups.
 */
export function presetRuleFromAbstract({ trigger = null, body = '' } = {}) {
  const b = String(body || '').trim();
  if (!b) return null;
  const t = String(trigger || '').trim() || null;
  return { kind: 'delta', trigger: t, body: b, epistemic: 'inferred', confidence: 0.85, tier: 'canonical', provenance: 'distilled-up' };
}
