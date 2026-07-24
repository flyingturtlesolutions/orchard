/**
 * Core/catalogConformance.js — Rail A-0a: structural conformance over the leg catalogs (v2.74.1725). PURE.
 *
 * Spec: docs/DESIGN_hardening_ladder.md §1 (the checks, per subject) · docs/HANDOFF_hardening_arc.md §3 (the
 * stage). The rail's claim is narrow and honest: the DECLARATIONS the router depends on are well-formed. It says
 * nothing about whether a leg is picked correctly (B.5/C) or works live (never tested here).
 *
 * Every auditor is data-in → violations-out (an array of human-readable strings, empty = clean), so the test
 * layer can run each one twice: over the REAL catalog (expect clean — born green) and over a SYNTHETIC bad entry
 * (expect flagged — the test-the-test: a conformance check that has never been seen red is a hope, not a check).
 *
 * Born-green provenance (calibrated 2026-07-23 before freezing): 18/18 write recipes already declared both gate
 * axes (closed by hand after v1686), 39/39 verifyIdentity recipes had probes, palette enum was closed — and the
 * params check found 27/84 params WITHOUT an explicit `required`, backfilled `required: false` in the same
 * commit (behavior-neutral: consumers read `p.required` truthily — connectorLeg.js/groundFacts.js). That find is
 * this rail working at build time.
 *
 * Deliberately NOT here (undecidable → §4.3's human audit): name-similarity between legs. Any threshold either
 * flakes inside the pure rail or is toothless.
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Every `write: true` recipe declares BOTH gate axes, as booleans. The exact v1686 gap, kept closed. PURE. */
export function auditGateAxes(recipes) {
  const out = [];
  for (const r of (Array.isArray(recipes) ? recipes : [])) {
    if (!r || !r.write) continue;
    if (typeof r.reversible !== 'boolean') out.push(`${r.id}: write leg missing boolean \`reversible\``);
    if (typeof r.outward !== 'boolean') out.push(`${r.id}: write leg missing boolean \`outward\``);
  }
  return out;
}

/** Every `verifyIdentity: true` recipe names its `identityProbe` endpoint (the 200+anon-sentinel trap needs a
 *  target). PURE. */
export function auditIdentity(recipes) {
  const out = [];
  for (const r of (Array.isArray(recipes) ? recipes : [])) {
    if (!r || !r.verifyIdentity) continue;
    if (!_str(r.identityProbe)) out.push(`${r.id}: verifyIdentity leg missing \`identityProbe\``);
  }
  return out;
}

/** Router-legibility, the DECIDABLE half: unique ids · non-empty `does` (the router reads it) · every param
 *  named + an EXPLICIT boolean `required` (present, not inferred — absence once hid intent, 27 found 2026-07-23).
 *  PURE. */
export function auditRecipeLegibility(recipes) {
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(recipes) ? recipes : [])) {
    if (!r) continue;
    const id = _str(r.id) || '(unnamed)';
    if (seen.has(id)) out.push(`${id}: duplicate recipe id`);
    seen.add(id);
    if (!_str(r.does)) out.push(`${id}: empty \`does\` — the decomposer's ground-facts + answer surfaces read it (interpret renders NAME only as of v1751 — see findings; rendering does there is an open cost/aim decision)`);
    for (const p of (Array.isArray(r.params) ? r.params : [])) {
      if (!p || !_str(p.name)) { out.push(`${id}: unnamed param`); continue; }
      if (typeof p.required !== 'boolean') out.push(`${id}.${p.name}: \`required\` must be an explicit boolean`);
    }
  }
  return out;
}

// The palette's own safety vocabulary (distinct from rideRecipe's SAFETY_CLASSES — the two-enums correction,
// DESIGN_hardening_ladder.md §1: per subject, never conflated).
export const PALETTE_SAFETY = Object.freeze(['auto', 'confirm', 'gated']);

// What "write-shaped" means for a self/builtin leg, as DATA (the check's own registry, exported so the seal test
// and future legibility passes read the same vocabulary). "open" is deliberately absent: OPEN_CASE/OPEN_URL are
// local/reversible openers, and PP-3 records why a case stays cheap.
export const WRITE_VERB_RE = /\b(create|close|delete|update|send|write|add|remove|set|assign|submit)\b/i;

/** Is this leg WRITE-SHAPED (a write verb in its key or name)? PURE. Keys use underscores (`CLOSE_CASE`), and
 *  underscore is a word character — `\bclose\b` can never match inside it — so separators normalize to spaces
 *  first. (Found by this file's own test-the-test: the raw regex passed on names and silently missed every key.) */
export function isWriteShaped(leg) {
  const hay = `${_str(leg && leg.key)} ${_str(leg && leg.name)}`.replace(/[_-]+/g, ' ');
  return WRITE_VERB_RE.test(hay);
}

/** Palette/builtin legs: `safety` present and in-enum · non-empty `does` · a WRITE-SHAPED leg (by key+name verb)
 *  is never `'auto'`. PURE. */
export function auditPaletteSafety(legs) {
  const out = [];
  for (const l of (Array.isArray(legs) ? legs : [])) {
    if (!l) continue;
    const key = _str(l.key) || '(unnamed)';
    if (!PALETTE_SAFETY.includes(l.safety)) out.push(`${key}: safety "${l.safety}" not in {${PALETTE_SAFETY.join(', ')}}`);
    if (!_str(l.does)) out.push(`${key}: empty \`does\``);
    if (isWriteShaped(l) && l.safety === 'auto') {
      out.push(`${key}: write-shaped leg must not be safety:'auto'`);
    }
  }
  return out;
}

/** The whole A-0a sweep in one call — {violations, counts} for a dashboard or a one-line log. PURE. */
export function runCatalogAudit({ recipes = [], legs = [] } = {}) {
  const violations = [
    ...auditGateAxes(recipes),
    ...auditIdentity(recipes),
    ...auditRecipeLegibility(recipes),
    ...auditPaletteSafety(legs),
  ];
  return {
    violations,
    counts: {
      recipes: (recipes || []).length,
      writes: (recipes || []).filter((r) => r && r.write).length,
      legs: (legs || []).length,
      violations: violations.length,
    },
  };
}
