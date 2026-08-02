// Core/synthEntity.js — v2.74.1877 — THE ENTITY LAYER the synthetic legs generate from.
//
// The insight that makes this cheap: the entity graph ALREADY EXISTS in the catalog, as the `drill` block.
// `drill: { via, param, from, matchOn, label[], also[] }` already declares the detail leg, the join key, the
// free-text slot, the searchable fields and the children. Nothing new has to be invented — this module just reads
// that as a role assignment.
//
// ENTITY ≠ RECIPE, and the catalog proves it. Five Zendesk recipes (`my_open_tickets`, `my_pending_tickets`,
// `all_open_tickets`, `unassigned_tickets`, `tickets_last_day`) all carry `drill: { via: 'ticket_comments' }` —
// they are five ACCESS PATHS to one entity, not five entities. Keying a generator on recipes would emit five
// near-identical `find` legs and hand the router the job of telling them apart. So the entity key is `drill.via`
// and the collection recipes are its access paths. 60 ride recipes → ~7 with drills → ~3 entities.
//
// ── COVERAGE: the declaration without which this family industrialises a bug ──────────────────────────────────
// VendorSuite's `(division × status)` axes PARTITION the corpus: every task sits in exactly one cell, so a
// complete scan honestly justifies "isn't in any of them" — that is why `findVerdict`'s `none` outcome is sound
// there. But `shopify_orders_queue` is "Open unfulfilled Shopify orders" — a SELECTION — and Zendesk's five views
// are overlapping selections that neither individually nor unioned constitute the ticket corpus. Generating a
// find over those with the same verdict code would return a confident "isn't in any of them" about a corpus it
// never saw: the exact false-negative class fixed at v1874/v1876, newly wrong, on two sites at once.
// So coverage is DECLARED, it defaults to the conservative reading, and `none` is structurally unreachable
// without it. Read from the CATALOG by recipe id — never off the leg — so no new leg field exists and invariant
// #3's three hops do not apply; an unknown/harvested recipe simply gets the safe answer.

export const COVERAGE = Object.freeze({ PARTITION: 'partition', SELECTION: 'selection' });

const _str = (v) => (v == null ? '' : String(v).trim());

/**
 * Group a catalog into ENTITIES, keyed by `drill.via`. PURE.
 * Returns [{ key, detailId, joinFrom, joinParam, matchOn, labels, children, paths: [{ id, name, coverage, axes }] }]
 * where `axes` are the recipe's enumerable params (a `resolve` spec with `each: true`) — the scan's dimensions.
 */
export function entitiesFrom(recipes) {
  const byVia = new Map();
  for (const r of (Array.isArray(recipes) ? recipes : [])) {
    const d = r && r.drill;
    if (!d || !_str(d.via)) continue;
    const key = _str(d.via);
    if (!byVia.has(key)) {
      byVia.set(key, { key, detailId: key, joinFrom: '', joinParam: '', matchOn: '', labels: [], children: [], paths: [] });
    }
    const e = byVia.get(key);
    // The richest access path wins the shared fields — a minimal drill (Zendesk's bare `{via}`) must not blank out
    // a sibling's fully-declared one, and a fully-declared path must not be diluted by a bare one.
    if (!e.joinFrom && _str(d.from)) e.joinFrom = _str(d.from);
    if (!e.joinParam && _str(d.param)) e.joinParam = _str(d.param);
    if (!e.matchOn && _str(d.matchOn)) e.matchOn = _str(d.matchOn);
    if (!e.labels.length && Array.isArray(d.label)) e.labels = d.label.filter(Boolean).slice();
    // v2.74.1930 — an `also` entry may be a bare id OR a re-keying object ({id, from, param, pick, extract} —
    // v1928). `children` is a list of RECIPE IDS by contract, so read the id off either form: pushing the raw
    // object made `includes` never dedupe (object identity) and handed consumers a record where they expect a
    // string. Caught by applying the VendorSuite synthetic-leg audit to the new Shopify sidecar.
    for (const c of (Array.isArray(d.also) ? d.also : [])) {
      const cid = _str(typeof c === 'string' ? c : (c && c.id));
      if (cid && !e.children.includes(cid)) e.children.push(cid);
    }
    e.paths.push({
      id: _str(r.id),
      name: _str(r.name),
      coverage: (r.coverage === COVERAGE.PARTITION || r.coverage === COVERAGE.SELECTION) ? r.coverage : null,
      axes: _axesOf(r),
    });
  }
  return [...byVia.values()];
}

// A recipe's scan dimensions: params whose `resolve` spec opted into enumeration. `status` is an axis too — it is
// an enum on the param itself rather than a resolve spec — so both forms are collected.
function _axesOf(recipe) {
  const out = [];
  const res = (recipe && recipe.resolve && typeof recipe.resolve === 'object') ? recipe.resolve : {};
  for (const [name, spec] of Object.entries(res)) {
    if (spec && spec.each === true) out.push({ name, kind: 'enumerable', via: _str(spec.via) });
  }
  for (const p of (Array.isArray(recipe && recipe.params) ? recipe.params : [])) {
    if (p && Array.isArray(p.enum) && p.enum.length) out.push({ name: _str(p.name), kind: 'enum', values: p.enum.map(String) });
  }
  return out;
}

/** The entity a given collection recipe belongs to, plus that recipe's own access path. PURE. Null if none. */
export function entityFor(recipeId, recipes) {
  const id = _str(recipeId);
  if (!id) return null;
  for (const e of entitiesFrom(recipes)) {
    const path = e.paths.find((p) => p.id === id);
    if (path) return { ...e, path };
  }
  return null;
}

/**
 * THE COVERAGE READ, and the reason this module exists. PURE.
 * `partition` ONLY when the access path says so explicitly. Everything else — a selection, an undeclared recipe,
 * a harvested leg the catalog has never seen — resolves to `selection`, which makes the definite negative
 * structurally unreachable. Fail-safe by construction: forgetting to declare costs a weaker sentence, never a
 * false one.
 */
export function coverageOf(recipeId, recipes) {
  const e = entityFor(recipeId, recipes);
  return (e && e.path && e.path.coverage === COVERAGE.PARTITION) ? COVERAGE.PARTITION : COVERAGE.SELECTION;
}

/**
 * Is this entity ready for a generated `find`? PURE. Returns { ready, missing: [reasons] }.
 * Generation cannot CREATE readiness — it makes readiness visible. Zendesk's ticket entity carries only
 * `drill: {via}`: no `matchOn` to bind a query to, no `label[]` to search, no `from` to join back with. That is a
 * catalog fact worth reporting in the audit rather than discovering when a generated leg answers nothing.
 */
export function findReadiness(entity) {
  const e = entity || {};
  const missing = [];
  if (!_str(e.matchOn)) missing.push('drill.matchOn — no slot to bind the query to');
  if (!(Array.isArray(e.labels) && e.labels.length)) missing.push('drill.label[] — no fields to search');
  if (!_str(e.joinFrom)) missing.push('drill.from — no key to join a hit back to the detail read');
  const paths = Array.isArray(e.paths) ? e.paths : [];
  if (!paths.some((p) => (p.axes || []).length)) missing.push('no enumerable/enum axis — nothing to scan over');
  if (!paths.some((p) => p.coverage)) missing.push('coverage undeclared — a find would only ever be able to say "not in what I read"');
  return { ready: missing.length === 0, missing };
}

// The router reads `does` through an accumulate budget (~140 chars before the distinguishing clause is clipped —
// the v1861 live defect, where a refusal clause I had just written never reached the model). A GENERATED does has
// to fit by construction, so the budget is asserted here rather than hoped for.
export const DOES_BUDGET = 140;

/**
 * The declarative descriptor for an entity's `find` leg. PURE — it describes, it does not execute.
 * Its consumer today is `_synthTaskFind` (chat.js), which reads `matchOn`/`labels`/`axes`/`coverage` from here
 * instead of being handed them ad hoc by the drill site: that is what stops the executor being VendorSuite-shaped
 * and makes a second site a DECLARATION rather than a code change. Null when the entity isn't ready.
 */
export function findLegDescriptor(entity, { noun = 'record' } = {}) {
  const r = findReadiness(entity);
  if (!r.ready) return null;
  const e = entity;
  const best = e.paths.find((p) => p.coverage === COVERAGE.PARTITION) || e.paths.find((p) => p.coverage) || e.paths[0];
  const does = `find a ${noun} by any identifier you have — ${e.labels.slice(0, 3).join(', ')} — across every ${(best.axes[0] && best.axes[0].name) || 'scope'}`.slice(0, DOES_BUDGET);
  return {
    id: `${best.id}__find`,
    name: `Find a ${noun}`,
    does,
    synthetic: 'find',
    over: best.id,
    detailId: e.detailId,
    joinFrom: e.joinFrom,
    joinParam: e.joinParam,
    matchOn: e.matchOn,
    labels: e.labels.slice(),
    axes: best.axes.slice(),
    coverage: best.coverage || COVERAGE.SELECTION,
    params: [
      { name: 'q', type: 'string', required: true, hint: `the identifier or text to look for — ${e.labels.slice(0, 4).join(', ')}` },
      ...best.axes.map((a) => ({ name: a.name, type: 'string', required: false, hint: `optional: pin the search to one ${a.name}` })),
    ],
  };
}
