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

/**
 * v2.74.1862 — ROUTER LEGIBILITY. `interpretPrompt` renders `detail:` from the does-head under a 140-char budget
 * (split on ' — ', whole segments only), so a long `does` reaches the router as a FRAGMENT — measured 2026-07-28:
 * 22 of 60 entries clipped, 2,541 authored chars invisible, two of them the direct cause of live failures (a 500,
 * and four runs of count-asks pulling the wrong leg). Authoring into an invisible field is undetectable by every
 * other check here, because they all read the catalog against ITSELF rather than against what the router receives.
 *
 * The rule: a clipped `does` must declare a `routerHint` (Core/routerHints.js). Both directions — a hint for a
 * recipe that no longer exists is rot, and is also a violation. Mirrors the does-head accumulate EXACTLY; if that
 * render changes, this must change with it (they are the same contract, stated twice on purpose — one enforces).
 */
export function auditRouterLegibility(recipes, hints = {}) {
  const out = [];
  const ids = new Set();
  for (const r of (Array.isArray(recipes) ? recipes : [])) {
    if (!r || !r.id) continue;
    ids.add(String(r.id));
    const does = String(r.does || '');
    if (!does) continue;
    const segs = does.split(' — ');
    let head = segs[0] || '';
    for (let i = 1; i < segs.length && (head.length + 3 + segs[i].length) <= 140; i++) head += ` — ${segs[i]}`;
    const hint = Object.prototype.hasOwnProperty.call(hints, r.id) ? String(hints[r.id] || '') : '';
    if (head.length < does.length && !hint) out.push(`${r.id}: \`does\` is clipped to ${head.length}/${does.length} chars at the router — declare a routerHint`);
    if (hint && hint.length > 140) out.push(`${r.id}: routerHint is ${hint.length} chars — over the 140 budget it exists to fit`);
  }
  for (const id of Object.keys(hints || {})) {
    if (!ids.has(String(id))) out.push(`routerHint "${id}" names no recipe — rot`);
  }
  return out;
}

/** The whole A-0a sweep in one call — {violations, counts} for a dashboard or a one-line log. PURE. */
/**
 * v2.74.1877 — SYNTH READINESS. The synthetic-leg family generates from the entity graph the `drill` block already
 * declares, and generation cannot CREATE readiness — it makes readiness visible. This reports, per entity, what a
 * generated `find` would still be missing, so "can we find a Zendesk ticket by number?" is a catalog fact rather
 * than something you discover when a generated leg answers nothing.
 *
 * Reported as ROT, not violations: an unready entity is not a defect, it is an undeclared opportunity. The one
 * exception that IS a violation is a declared `coverage` on a recipe with no drill — a coverage claim about a
 * corpus nothing scans is unfalsifiable, and an unfalsifiable claim about completeness is the class this whole
 * family had to be protected from.
 */
export function auditSynthEntities(recipes, { entitiesFrom, findReadiness } = {}) {
  if (typeof entitiesFrom !== 'function' || typeof findReadiness !== 'function') return [];
  const out = [];
  for (const r of (Array.isArray(recipes) ? recipes : [])) {
    if (r && r.coverage && !(r.drill && r.drill.via)) {
      out.push({ rule: 'synth-coverage-without-drill', id: r.id, why: `declares coverage:'${r.coverage}' but has no drill — nothing scans it, so the claim can never be checked` });
    }
  }
  for (const e of entitiesFrom(recipes)) {
    const { ready, missing } = findReadiness(e);
    if (ready) continue;
    out.push({ rule: 'synth-not-ready', id: e.key, rot: true, why: `no generated find (${e.paths.length} access path(s)): ${missing.join(' · ')}` });
  }
  return out;
}

export function runCatalogAudit({ recipes = [], legs = [], hints = {}, synth = null } = {}) {
  const violations = [
    // synth readiness rides along when the caller supplies the entity layer — injected rather than imported so
    // this module stays dependency-free and the audit list stays one place.
    ...(synth ? auditSynthEntities(recipes, synth) : []),
    ...auditGateAxes(recipes),
    ...auditIdentity(recipes),
    ...auditRecipeLegibility(recipes),
    ...auditPaletteSafety(legs),
    ...auditRouterLegibility(recipes, hints),
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
