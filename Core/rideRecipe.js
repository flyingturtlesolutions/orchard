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
  const rec = {
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
  // v2.74.1432 — carry the FULL transport + human-page + digest markers so a SEEDED record (the Overview/workbench path,
  // which invokes via harvestedRecipeLegs → recipeToLeg) is invocation-COMPLETE — not just the catalog-invoked connector
  // (an app selecting a curated leg reads the entry DIRECTLY, so it never noticed the loss). WAS lossy: itemUrl/write/gql/
  // csrf/… were dropped, so a seeded ground lost "show X" (itemUrl) and every non-Zendesk-shaped transport marker. This is
  // the root of the "re-learn per ride" churn (see Invariant #3). Additive: a field absent on the entry stays absent on the
  // record (no empty keys), so a plain Zendesk-read record is byte-identical to before.
  if (e.write === true) rec.write = true;
  if (e.destructive === true) rec.destructive = true;                 // kept explicit too (safetyClass already encodes it)
  if (e.gql === true) rec.gql = true;
  if (e.shopProbe === true) rec.shopProbe = true;
  if (e.verifyIdentity === true) rec.verifyIdentity = true;
  if (e.urlParam && typeof e.urlParam === 'object') rec.urlParam = e.urlParam;
  if (e.pulse != null) rec.pulse = e.pulse;
  if (e.drill && typeof e.drill === 'object') rec.drill = e.drill;
  if (e.resolve && typeof e.resolve === 'object') rec.resolve = e.resolve;   // CX-9b (v1434) — per-param resolve specs
  if (e.identityGql && typeof e.identityGql === 'object') rec.identityGql = e.identityGql;   // v1479 — {me} from a GraphQL identity read (endpoint/body/idPath) when the REST probe can't (agent-id vs user-id)
  for (const k of ['itemUrl', 'listUrl', 'bodyType', 'contentType', 'identityProbe', 'probeAccept', 'persistedOp', 'csrf', 'autoRequires', 'capClass']) {   // DK-2 — capClass:'presence' survives the seeded path too; CP-1 — probeAccept (json-liveness) rides the seeded path (Invariant #3 hop 1)
    if (e[k] != null && e[k] !== '') rec[k] = e[k];
  }
  if (e.requestHeaders && typeof e.requestHeaders === 'object') rec.requestHeaders = e.requestHeaders;
  return rec;
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

/**
 * Project the curated catalog into answer-prompt ride records for an app's CONNECTED sites. PURE. IL_ANSWER used to
 * read only the active-tab Ground — so a freshly-connected site (e.g. workspace.aircall.io) showed zero RIDE legs
 * until you visited it and minted a Ground. Interpret already projects these via connectorLegsForConnections; this
 * closes the same gap for "what can you do?" prose.
 */
export function curatedRidesForConnections(connections, catalog) {
  const out = [];
  const seen = new Set();
  for (const c of (Array.isArray(connections) ? connections : [])) {
    const origin = String((c && c.origin) || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    if (!origin) continue;
    for (const r of seedFromCatalog(catalog, { origin })) {
      const k = `${r.origin}|${r.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

/** Merge curated connection rides with per-Ground stored rides for IL_ANSWER. Stored wins on origin|id (user state). PURE. */
export function mergeRideCatalogForAnswer(curated, stored) {
  const byKey = new Map();
  for (const r of (Array.isArray(curated) ? curated : [])) { if (r && r.id) byKey.set(`${r.origin || ''}|${r.id}`, r); }
  for (const r of (Array.isArray(stored) ? stored : [])) { if (r && r.id) byKey.set(`${r.origin || ''}|${r.id}`, r); }
  return [...byKey.values()];
}

// User-owned fields are PRESERVED across a re-seed / re-harvest; mechanical fields come from the incoming record.
// RH-1a (v2.74.1566, DESIGN_route_heal.md §3.1) — the route-heal runtime state (lastOkAt/missStreak/driftSuspect/
// driftAt, stamped by INVOKE_SESSION + SESSION_REPLAY via Core/routeHeal.js) is user-state-class: a curated
// catalog refresh must never erase the proof-of-life stamp or the drift evidence.
// RH-1c (v2.74.1567) — the heal lifecycle rides too: `healProposal` (the pending HITL diff), `healOverride` (an
// APPLIED heal's shadow — see mergeRecipes), `healedAt`.
const _USER_FIELDS = ['name', 'does', 'enabled', 'reviewState', 'safetyClass', 'trust', 'lastOkAt', 'missStreak', 'driftSuspect', 'driftAt', 'healProposal', 'healOverride', 'healedAt'];

/**
 * Merge `incoming` into `existing` BY id, PRESERVING user state. PURE. Mechanical fields (method/endpoint/params/body/
 * provenance) come from `incoming` (a curated re-seed or fresh harvest may refresh them); the user fields above are kept
 * from `existing`. Existing records absent from `incoming` (e.g. harvested ones during a curated re-seed) are kept. So
 * the one function serves BOTH "re-seed the catalog" and "add a harvested recipe".
 *
 * RH-1c (v2.74.1567, DESIGN_route_heal.md §3.5 durability) — an APPLIED heal on a CURATED record must survive this
 * merge's mechanical refresh (which would silently restore the catalog's still-broken shape on every read).
 * `healOverride` re-asserts the healed endpoint/requestHeaders/params over the incoming record — until the CATALOG
 * ITSELF catches up (incoming endpoint + requestHeaders equal the override's), at which point the override drops
 * and the shipped fix, with its richer curated param specs, takes over.
 */
export function mergeRecipes(existing, incoming) {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const byId = new Map(ex.map((r) => [r.id, r]));
  const out = []; const seen = new Set();
  for (const r of inc) {
    const prior = byId.get(r.id);
    if (prior) {
      const keep = {}; for (const k of _USER_FIELDS) if (prior[k] !== undefined) keep[k] = prior[k];
      const ov = keep.healOverride;
      if (ov && typeof ov === 'object') {
        const kk = ['endpoint', 'requestHeaders'].filter((k) => ov[k] !== undefined);
        const caughtUp = kk.length > 0 && kk.every((k) => JSON.stringify(r[k]) === JSON.stringify(ov[k]));
        if (caughtUp) { delete keep.healOverride; delete keep.healedAt; out.push({ ...r, ...keep }); }
        else out.push({ ...r, ...keep, ...ov });
      } else out.push({ ...r, ...keep });
    }
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

/**
 * CX-9r (v2.74.1463) — CATALOG-ARMED origins: hosts (typically from OPEN TABS) that match a curated `appHost`
 * become routable WITHOUT a Ground. The Ground is user-state's home (disable/reject/trust, harvested additions) —
 * not a reachability gate: a curated, pre-accepted leg needs only a logged-in tab at dispatch, and the Ground
 * materializes lazily on first panel read/edit. `covered` hosts (already ride-armed via a real Ground's stored
 * records) are skipped, so stored user state always outranks the catalog projection.
 * @param {string[]} hosts     candidate hosts (e.g. every open http(s) tab's host)
 * @param {Array}    catalog   CONNECTOR_RECIPES
 * @param {string[]} [covered] hosts already served by a ride-armed Ground
 * @returns {Array<{gid:null, host:string, texts:string[]}>} entries shaped for the DOMAIN-MATCH vocab index
 */
export function catalogArmedEntries(hosts, catalog, covered = []) {
  const cov = new Set((Array.isArray(covered) ? covered : []).map((h) => String(h || '').toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const raw of (Array.isArray(hosts) ? hosts : [])) {
    const host = String(raw || '').toLowerCase();
    if (!host || seen.has(host) || cov.has(host)) continue;
    seen.add(host);
    const entries = (Array.isArray(catalog) ? catalog : []).filter((e) => e && e.appHost && originMatchesAppHost(host, e.appHost));
    if (!entries.length) continue;
    out.push({ gid: null, host, texts: entries.map((e) => `${e.name || ''} ${e.does || ''}`) });
  }
  return out;
}
