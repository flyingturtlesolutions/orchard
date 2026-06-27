// Core/rideRecipe.js — the per-Ground RIDE-RECIPE model (DESIGN_connectors.md §18, v2.74.1268). The data-model shift:
// ride recipes move from ONE global static catalog (CONNECTOR_RECIPES, matched by origin at RUNTIME) to a PER-GROUND
// collection — the shape `sgCapabilities` already has — so they can be displayed/edited per Ground and HARVESTED into
// (§17). A Ground's recipes = the curated catalog (seeded by origin) ∪ its harvested/demonstrated ones, each carrying
// provenance, a METHOD-derived safetyClass (§9), a trust score (GA-3), `enabled`, and a `reviewState` (the GA-4
// pending→accept gate). PURE: no chrome / DOM / LLM / clock. The catalog is INJECTED so this module stays decoupled
// from connectorRecipes.js (the storage slice passes CONNECTOR_RECIPES in).

export const PROVENANCE = Object.freeze(['curated', 'harvested', 'demonstrated']);
export const REVIEW_STATES = Object.freeze(['pending', 'accepted', 'rejected']);
export const SAFETY_CLASSES = Object.freeze(['auto', 'gated', 'destructive']);

const _SAFETY_RANK = { auto: 0, gated: 1, destructive: 2 };
/** Strictness rank of a safety class (auto < gated < destructive). PURE. Unknown → -1. */
export function safetyRank(cls) { return Object.prototype.hasOwnProperty.call(_SAFETY_RANK, cls) ? _SAFETY_RANK[cls] : -1; }

/**
 * The §9 safety class for an HTTP method. PURE. GET → 'auto' (a read, runs unattended); a `destructive` recipe (DELETE /
 * merge / mark-as-spam) → 'destructive'; any other non-GET → 'gated' (a write, fail-closed HITL). The METHOD is the
 * classifier — a harvested recipe is classed exactly the way the curated catalog is, NEVER by its (untrusted) name.
 */
export function safetyClassForMethod(method, { destructive = false } = {}) {
  if (destructive) return 'destructive';
  return String(method || 'GET').toUpperCase() === 'GET' ? 'auto' : 'gated';
}

/** host of an origin/url — lowercased, no scheme / trailing slash. PURE. */
function _host(origin) { return String(origin || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase(); }

/** Does `origin` ride `appHost` — same host or a subdomain (deako.zendesk.com → zendesk.com)? PURE. */
export function originMatchesAppHost(origin, appHost) {
  const h = _host(origin); const ah = String(appHost || '').toLowerCase();
  return !!ah && (h === ah || h.endsWith('.' + ah));
}

/**
 * Project one curated CONNECTOR_RECIPES entry into a per-Ground record. PURE. Curated → trusted (trust 1), `accepted`,
 * `enabled`. The safetyClass is method-derived (the catalog's `destructive` flag carries through).
 * @returns {object} a ride-recipe record
 */
export function recipeFromCatalogEntry(entry, { groundId = '', origin = '' } = {}) {
  const e = (entry && typeof entry === 'object') ? entry : {};
  return {
    id: String(e.id || ''),
    groundId: String(groundId || ''),
    origin: _host(origin) || _host(e.appHost),
    name: String(e.name || e.id || ''),
    does: String(e.does || ''),
    method: String(e.method || 'GET').toUpperCase(),
    endpoint: String(e.endpoint || ''),
    params: Array.isArray(e.params) ? e.params : [],
    body: e.body != null ? e.body : null,
    provenance: 'curated',
    safetyClass: safetyClassForMethod(e.method, { destructive: !!e.destructive }),
    trust: 1,
    enabled: true,
    reviewState: 'accepted',
  };
}

/**
 * Seed a Ground's collection from the curated catalog: the entries whose `appHost` matches the Ground's origin,
 * projected to records. PURE (catalog INJECTED). The bridge from the global catalog → the per-Ground collection.
 */
export function seedFromCatalog(catalog, { groundId = '', origin = '' } = {}) {
  return (Array.isArray(catalog) ? catalog : [])
    .filter((e) => e && originMatchesAppHost(origin, e.appHost))
    .map((e) => recipeFromCatalogEntry(e, { groundId, origin }));
}

// User-owned fields are PRESERVED across a re-seed / re-harvest; mechanical fields come from the incoming record.
const _USER_FIELDS = ['name', 'does', 'enabled', 'reviewState', 'safetyClass', 'trust'];

/**
 * Merge `incoming` into `existing` BY id, PRESERVING user state. PURE. Mechanical fields (method/endpoint/params/body/
 * provenance) come from `incoming` (a curated re-seed or fresh harvest may refresh them); the user fields above are kept
 * from `existing`. Existing records absent from `incoming` (e.g. harvested ones during a curated re-seed) are kept. So
 * the one function serves BOTH "re-seed the catalog" and "add a harvested recipe".
 */
export function mergeRecipes(existing, incoming) {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const byId = new Map(ex.map((r) => [r.id, r]));
  const out = []; const seen = new Set();
  for (const r of inc) {
    const prior = byId.get(r.id);
    if (prior) { const keep = {}; for (const k of _USER_FIELDS) if (prior[k] !== undefined) keep[k] = prior[k]; out.push({ ...r, ...keep }); }
    else out.push(r);
    seen.add(r.id);
  }
  for (const r of ex) if (!seen.has(r.id)) out.push(r);
  return out;
}

/** Enable / disable a recipe. PURE. */
export function setEnabled(recipe, enabled) { return { ...recipe, enabled: !!enabled }; }

/** Review verdict: 'accept' → accepted; 'reject' → rejected (terminal — not armable, not re-suggested by harvest). PURE. */
export function review(recipe, decision) {
  const next = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : recipe.reviewState;
  return { ...recipe, reviewState: next };
}

/**
 * TIGHTEN a recipe's safety class — tighten ONLY (auto→gated→destructive). PURE. A loosening (gated→auto, or promoting a
 * write to auto) is REFUSED (returns the recipe unchanged): the safety model is one-way per §9/§18. Equal class → no-op.
 */
export function downgradeSafety(recipe, to) {
  return (safetyRank(to) > safetyRank(recipe && recipe.safetyClass)) ? { ...recipe, safetyClass: to } : recipe;
}

/** Edit the display fields. PURE. Only name/does are user-editable; mechanical fields are catalog/harvest-owned. */
export function editMeta(recipe, { name, does } = {}) {
  return { ...recipe, name: name != null ? String(name) : recipe.name, does: does != null ? String(does) : recipe.does };
}

/**
 * The ARM GUARD (the §18 teeth). PURE. A recipe is armable as a tool ONLY when `enabled` AND `accepted` — a `pending`
 * harvested recipe or a `rejected`/disabled one is NEVER armable. (A gated/destructive recipe still passes its run-time
 * HITL ON TOP of this; armability is the static review+enabled gate, enforced at the connector dispatch.)
 */
export function armable(recipe) {
  return !!(recipe && recipe.enabled && recipe.reviewState === 'accepted');
}

/**
 * BULK-accept every PENDING READ recipe (safetyClass 'auto' = a GET, the §9 unattended-safe class) in one pass. PURE.
 * Writes (`gated`) and destructive recipes are NEVER bulk-accepted — they stay per-recipe HITL, so a harvest can't arm a
 * write en masse. Already-accepted/rejected and non-pending records pass through untouched. Returns { recipes, accepted }
 * (accepted = how many flipped). The cheap "30 harvested GETs, one click" path; non-GETs still need an individual ✓.
 */
export function acceptPendingReads(recipes) {
  const list = Array.isArray(recipes) ? recipes : [];
  let accepted = 0;
  const out = list.map((r) => {
    if (r && r.reviewState === 'pending' && r.safetyClass === 'auto') { accepted++; return { ...r, reviewState: 'accepted' }; }
    return r;
  });
  return { recipes: out, accepted };
}
