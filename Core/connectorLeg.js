// Core/connectorLeg.js — project a connector tool into an OfferedLeg (DESIGN_connectors.md §4–5). CX-1.
//
// PURE: no chrome / DOM / LLM / storage. Two sources, one uniform leg:
//   • recipeToLeg  — a session-ride recipe (origin · endpoint · param-spec) → a CLIENT-side connector leg
//                    (rides the user's existing browser session; execPlan §7 routes it to INVOKE_SESSION)
//   • mcpToolToLeg — an MCP tool descriptor (name · description · inputSchema · annotations) → a CLOUD-broker leg
//                    (OAuth from a proxy vault; execPlan §7 routes it to INVOKE_CONNECTOR)
// Both yield a `connector`-domain leg that palette.js#toOfferedLeg passes through unchanged (key+domain+source
// present), carrying `paramSchema` (the §12 binding fix — the router needs types/required/enum, not just names)
// and `tool.impl` ('session' | 'oauth') so dispatch picks the right channel.
//
// Safety (§9): hints may only RAISE caution. A self-declared readOnlyHint drops to 'auto' ONLY for a TRUSTED
// (curated-catalog) tool; an untrusted tool floors at 'confirm' no matter what it claims; destructiveHint always
// raises to 'gated'. That one rule is what stops a mislabeled write from running unconfirmed.

const _str = (x) => (typeof x === 'string' ? x.trim() : '');

/**
 * Build a connector leg key. When `host` is set, suffix it so two connected instances of the same app don't collide.
 * PURE. @param {{ account?:string, app:string, id:string, host?:string }} p
 */
export function connectorLegKey({ account = 'me', app, id, host = '' } = {}) {
  const base = `${account}.${app}.${id}`;
  const h = _str(host).toLowerCase().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return h ? `${base}@${h}` : base;
}

/**
 * Safety class from a tool's self-declared hints + whether the SOURCE is trusted (curated catalog). PURE.
 * Hints can only raise caution; an untrusted read never drops below 'confirm'. (§9)
 *
 * PP-3 (v2.74.1661) — the OUTWARD axis. DESIGN_peritem_pipeline.md §4 proposed adding BOTH `reversible` and
 * `outward` and deriving `gate = outward || !reversible`. Reading the codebase first (per §9.4, which suspected
 * exactly this) showed that only HALF of that is a real gap:
 *
 *   `reversible` ALREADY EXISTS, twice over. `destructive` is used as precisely `!reversible` — Core/proposals.js
 *   renders a non-destructive proposal to the user as the literal word "reversible" — and `reversible` is also
 *   already a live boolean on the capability side (Core/orchMatch.js → sg.js → chat.js's auto-fire veto). Adding
 *   a third spelling would give one predicate three names, which is the §7.3 failure this project keeps hitting.
 *
 *   `outward` has NO name anywhere. It is currently smuggled in by mislabeling outward legs as `destructive`:
 *   aw_send_sms is flagged destructive while destroying nothing, with a comment explaining that an SMS "can't be
 *   unsent". The cost of having no word for it is visible one entry away — `add_comment` with public:true replies
 *   to the CUSTOMER, is equally unsendable, and sits at single-click 'confirm' because it is merely a write.
 *
 * So: `outward` is added, `reversible` is NOT. And the axis is RAISE-ONLY, deliberately — §4's literal
 * `gate = outward || !reversible` would LOWER shopify_create_customer / create_order / add_tags / create_user
 * from today's 'confirm' floor to un-gated, across the whole system, as a side effect of a per-item pipeline
 * change. The user's policy (drafts and profile-creation un-gated) is about what a PIPELINE may do unattended,
 * and belongs at the pipeline's own gate — not in the global classifier every existing surface reads.
 */
export function hintToSafety({ readOnlyHint = false, destructiveHint = false, outward = false } = {}, trusted = false) {
  if (destructiveHint || outward) return 'gated';   // raise — always honored. Outward = leaves our boundary, can't be unsent.
  if (trusted && readOnlyHint) return 'auto';       // lower — only for a vetted read
  return 'confirm';                                  // floor — writes, and untrusted reads
}

/**
 * Reduce a JSON Schema to the binding-relevant skeleton the router needs: per-property {type, enum?} + required[].
 * Drops descriptions/titles/nested verbosity (the §12 prune). PURE, shallow — enough for flat tool args.
 */
export function pruneSchema(inputSchema) {
  const s = (inputSchema && typeof inputSchema === 'object') ? inputSchema : {};
  const props = (s.properties && typeof s.properties === 'object') ? s.properties : {};
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    const p = (v && typeof v === 'object') ? v : {};
    const slot = {};
    if (p.type) slot.type = p.type;
    if (Array.isArray(p.enum)) slot.enum = p.enum.slice(0, 50);   // cap a pathological enum
    if (p.format) slot.format = String(p.format);   // v2.74.1317 — format survives the prune (date-time grounding: the binder must KNOW a field wants ISO 8601)
    out[k] = slot;
  }
  return { type: 'object', properties: out, required: Array.isArray(s.required) ? s.required.slice() : [] };
}

/**
 * v2.74.1928 — ONE normalizer for a `drill.also` entry, both forms. PURE.
 *   'vs_task_contacts'                                        → { id: 'vs_task_contacts' }
 *   { id, from, param, pick:{field,equals}, extract:[{from,as,pattern}] }  → the same, validated
 * `from`/`param` re-key the sidecar off a DIFFERENT row field than the primary drill's join value. `pick`
 * selects one row of the sidecar result by field value (never by position — a timeline is newest-first and
 * ties exist). `extract` writes captured prose into named fields: `pattern` is a curated regex applied to the
 * picked row's `from` field, `as` names the field it becomes; with no pattern the value is copied verbatim
 * (a boolean like attributeToUser rides that path). Returns null for junk so a bad entry drops loudly-in-tests
 * rather than half-existing.
 */
function _alsoEntry(x) {
  if (typeof x === 'string' || typeof x === 'number') { const id = _str(x); return id ? { id } : null; }
  if (!x || typeof x !== 'object') return null;
  const id = _str(x.id);
  if (!id) return null;
  const out = { id };
  if (_str(x.from)) out.from = _str(x.from);
  if (_str(x.param)) out.param = _str(x.param);
  if (x.pick && typeof x.pick === 'object' && _str(x.pick.field)) {
    out.pick = { field: _str(x.pick.field), equals: _str(x.pick.equals) };
  }
  if (Array.isArray(x.extract)) {
    const ex = x.extract
      .filter((e) => e && typeof e === 'object' && _str(e.from) && _str(e.as))
      .map((e) => ({ from: _str(e.from), as: _str(e.as), ...(_str(e.pattern) ? { pattern: _str(e.pattern).slice(0, 200) } : {}) }))
      .slice(0, 6);
    if (ex.length) out.extract = ex;
  }
  return out;
}

// A recipe's own param list → the same {type:object, properties, required} skeleton. PURE.
function recipeParamSchema(params) {
  const properties = {};
  const required = [];
  for (const p of (Array.isArray(params) ? params : [])) {
    const name = p && ((typeof p === 'string') ? p : p.name);
    if (!name) continue;
    const slot = {};
    if (p && p.type) slot.type = p.type;
    if (p && Array.isArray(p.enum)) slot.enum = p.enum.slice(0, 50);
    if (p && p.gid) slot.gid = String(p.gid);   // CX-7c — the Shopify resource Kind; coerceParams wraps a bare id into a gid
    // CX-9f (v2.74.1439) — a short per-param HINT the interpret palette renders, so the BINDER knows the slot's
    // semantics (live: `address {type:string}` was bound "greensboro" once and skipped once — a bare name+type gives
    // the router nothing to bind BY). Curated text, capped; rendered through sanitizeToolString like every tool string.
    if (p && p.hint) slot.hint = String(p.hint).slice(0, 140);
    // v2.74.1925 (review) — HOP 3 for the machine-bind declaration. `machineOnly`/`fromField` (v1922) rode hop 1
    // fine (recipeFromCatalogEntry copies `params` whole) and died HERE: the projected leg carries param NAMES on
    // `leg.params` and this schema — there is no `tool.params` for a reader to find (the v1854/v1864 inert-reader
    // class, invariant #3's field-reader hop). The consumer reads leg.paramSchema.properties.<name>.fromField.
    if (p && p.machineOnly === true) slot.machineOnly = true;
    if (p && p.fromField) slot.fromField = String(p.fromField);
    properties[name] = slot;
    if (p && p.required) required.push(name);
  }
  return { type: 'object', properties, required };
}

/**
 * v2.74.1854 — the PRE-FLIGHT required-param check (live 205935: "list all available products" bound query:""
 * and the call was SPENT before Shopify's "Variable $q of type String! … invalid value" came back). The A-0a
 * discipline made `required` an explicit boolean on every catalog param precisely so it is knowable BEFORE the
 * wire — this is the first runtime reader. PURE. Returns the names of declared `required === true` params whose
 * bound value is missing or blank (after trim). Strict `=== true` matches the house convention
 * (driveArtifacts paramSchema does the same), so drive/taught params with required:false — where blank is a
 * CONTRACT ("" skips the label-click, "" means current division) — can never false-positive. The urlParam slot
 * (e.g. {handle}) is excluded: the EXECUTOR fills it from the ride tab, never the binder.
 */
/*
 * v2.74.1864 — IT ALSO HAS TO READ A LEG. Shipped at v1854 reading only `tool.params` — an array of {name,
 * required} that exists on a RECIPE and NOWHERE on a projected leg (recipeToLeg puts param NAMES on `leg.params`
 * and the requirements in `leg.paramSchema.required`). Both live callers pass `leg.tool || leg`, so `declared`
 * was `[]` and the gate returned "nothing missing" for every connector leg it has ever guarded. Caught only when
 * the v1863 redirect's status probe silently did nothing (gl 182219) and the executor's own endpoint guard
 * blocked instead — the FOURTH declared-thing-with-no-working-reader this week, and the one that was hiding
 * inside a fix for the same class. Now normalizes: recipe shape (params[{name,required}]) OR leg shape
 * (paramSchema.required), reading `urlParam` from whichever level carries it.
 */
/**
 * v2.74.2021 — EVERY param def a WRITE fill needs, in one shape. Live 14:22/14:32: `_runWriteClause` read
 * `createLeg.tool.params` (recipe shape) on a projected leg — recipeToLeg puts NAMES on `leg.params` and
 * required on `paramSchema`, so `tool.params` is undefined, the fill loop never ran, fillBody sent
 * `{operationName:'CustomerCreate'}` with no variables → Shopify `CustomerInput! … Expected value to not be null`.
 * Same inert-reader class as v1854/v1864. PURE. Returns [{name, required, …}] for both recipe and leg shapes.
 */
export function legParamDefs(legOrRecipe) {
  const o = (legOrRecipe && typeof legOrRecipe === 'object') ? legOrRecipe : null;
  if (!o) return [];
  const tool = (o.tool && typeof o.tool === 'object') ? o.tool : {};
  const objParams = [tool.params, o.params].find((p) => Array.isArray(p) && p.some((x) => x && typeof x === 'object' && x.name));
  if (objParams) {
    return objParams.filter((p) => p && p.name).map((p) => ({ ...p, name: String(p.name), required: p.required === true }));
  }
  const names = Array.isArray(o.params) ? o.params.filter((n) => typeof n === 'string' && n) : [];
  const schema = o.paramSchema || tool.paramSchema || {};
  const req = new Set((Array.isArray(schema.required) ? schema.required : []).map(String));
  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
  return names.map((n) => ({ name: String(n), required: req.has(String(n)), ...(props[n] && typeof props[n] === 'object' ? props[n] : {}) }));
}

export function missingRequiredParams(legOrRecipe, params = {}) {
  const o = (legOrRecipe && typeof legOrRecipe === 'object') ? legOrRecipe : null;
  if (!o) return [];
  const tool = (o.tool && typeof o.tool === 'object') ? o.tool : o;
  const urlP = (tool.urlParam && tool.urlParam.name) || (o.urlParam && o.urlParam.name) || null;
  const objParams = [o.params, tool.params].find((p) => Array.isArray(p) && p.some((x) => x && typeof x === 'object' && x.name));
  let names;
  if (objParams) names = objParams.filter((p) => p && p.required === true && p.name).map((p) => p.name);
  else {
    const schema = o.paramSchema || tool.paramSchema;
    names = (schema && Array.isArray(schema.required)) ? schema.required.filter(Boolean) : [];
  }
  // v2.74.1864 — a param with a declared `resolve` spec is NEVER "missing" when blank: blank is its documented
  // value ("division optional — blank = your current one") and rideParamResolve fills it from `defaultPath`.
  // This mattered the moment the reader above started working: `divisionId` is declared required:true, so the
  // flagship "get open warranty tasks" would have been blocked by its own pre-flight gate. The urlParam slot is
  // excluded for the same reason one level down — the executor fills it from the ride tab.
  const resolved = (tool.resolve && typeof tool.resolve === 'object') ? tool.resolve : (o.resolve && typeof o.resolve === 'object' ? o.resolve : null);
  const out = [];
  for (const name of names) {
    if (name === urlP) continue;
    if (resolved && Object.prototype.hasOwnProperty.call(resolved, name)) continue;
    const v = (params && typeof params === 'object') ? params[name] : undefined;
    if (v == null || String(v).trim() === '') out.push(name);
  }
  return out;
}

/**
 * v2.74.1911 — the IDENTIFIER-PROVENANCE gate. Live 125712: "what is the sku of the smart switch gen 2?" routed
 * to shopify_product_by_sku with params {"sku":"DK-SW-02"} — the router's own `why` said it outright: *"Gen 2
 * typically corresponds to DK-SW-02 based on Deako's naming pattern"*. Params are bound by GENERATION, so nothing
 * structural stops the model "extracting" a value from its own world-knowledge; the leg then spends a real call
 * on a key that exists nowhere and the miss renders as "no such product" — with the invented key never shown.
 * Same honesty family as the count/scope rules, one rung deeper: an identifier the conversation never contained
 * is a FABRICATION, not an extraction.
 *
 * PURE. Returns [{name, value}] for every bound identifier-class param whose value appears NOWHERE in
 * `contextText` (ask + recent turns + focus labels/values, caller-assembled). Class is name-shaped:
 *   · hard-id terms (sku/id/number/email/handle/sha/…) → gated;
 *   · a BARE entity noun (order/task/ticket/claim/job/…) → gated (those params take numbers/ids);
 *   · any open descriptor in the name (query/status/type/name/…) → NEVER gated — free-word params are
 *     legitimately paraphrased ("do we sell dimmers" → query:"dimmer").
 * resolve-marked params are skipped (their fill layers — defaultPath, context division, human→id mapping — are
 * provenance-clean by construction), and so is the urlParam slot (executor-filled). Matching is case-insensitive
 * with an alphanumeric-collapse fallback so "DK-SW-02" is found in "dk sw 02"; a value too short to judge
 * (<2 alnum chars) passes.
 */
const _ID_OPEN_RE = /(^|-)(query|text|word|words|search|term|name|title|status|type|kind|filter|sort|tag|label|note|reason|description|section|find|division|market|state|city|address)(s)?(-|$)/;
const _ID_HARD_RE = /(^|-)(sku|id|gid|uid|guid|number|num|no|email|handle|sha|hash|token|code|tracking|phone|zip|postal)(s)?(-|$)/;   // v1911-b — 'gid' (customer_gid was the primary identifier of two write legs and sailed through ungated)
const _ID_ENTITY = new Set(['order', 'task', 'ticket', 'claim', 'job', 'invoice', 'po', 'customer']);
// v1911-b (review) — element-wise containment. String([64776,64777]) is '64776,64777', which can never appear in
// "merge tickets 64776 and 64777" — an array-valued identifier param (the catalog's merge source_ids) is judged
// per ELEMENT. And a digits-only value gets an E.164 allowance: the model legitimately normalizes "(555) 123-4567"
// to "+15551234567" (the catalog's own hints invite it), so a >10-digit value passes when its national 10-digit
// tail is present.
function _containedIn(hay, hayAl, v) {
  const vl = String(v).trim().toLowerCase();
  const vAl = vl.replace(/[^a-z0-9]+/g, '');
  if (vAl.length < 2) return true;
  if (hay.includes(vl) || hayAl.includes(vAl)) return true;
  if (/^\d+$/.test(vAl) && vAl.length > 10 && hayAl.includes(vAl.slice(-10))) return true;
  return false;
}
export function identifierClassParam(name) {
  const n = String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (!n) return false;
  if (_ID_OPEN_RE.test(n)) return false;
  if (_ID_HARD_RE.test(n)) return true;
  return _ID_ENTITY.has(n);
}
export function inventedIdentifierParams(legOrRecipe, params = {}, contextText = '') {
  const o = (legOrRecipe && typeof legOrRecipe === 'object') ? legOrRecipe : null;
  if (!o || !params || typeof params !== 'object') return [];
  const tool = (o.tool && typeof o.tool === 'object') ? o.tool : o;
  const urlP = (tool.urlParam && tool.urlParam.name) || (o.urlParam && o.urlParam.name) || null;
  const resolved = (tool.resolve && typeof tool.resolve === 'object') ? tool.resolve : (o.resolve && typeof o.resolve === 'object' ? o.resolve : null);
  const hay = String(contextText || '').toLowerCase();
  const hayAl = hay.replace(/[^a-z0-9]+/g, '');
  const out = [];
  for (const [name, raw] of Object.entries(params)) {
    if (raw == null || typeof raw === 'boolean') continue;
    if (name === urlP) continue;
    if (resolved && Object.prototype.hasOwnProperty.call(resolved, name)) continue;
    if (!identifierClassParam(name)) continue;
    const vals = (Array.isArray(raw) ? raw : [raw]).filter((x) => x != null && typeof x !== 'object' && typeof x !== 'boolean').map((x) => String(x).trim()).filter(Boolean);
    const missing = vals.filter((x) => !_containedIn(hay, hayAl, x));
    if (missing.length) out.push({ name, value: missing.join(', ') });
  }
  return out;
}

/**
 * A session-ride recipe → a client-side connector leg. A recipe is a curated (or later learned) endpoint binding:
 *   { id, name, does, app, origin, endpoint, method?('GET'), write?(false), destructive?(false),
 *     body?(write body TEMPLATE — fillBody substitutes its {param}s), params?:[{name,type?,enum?,required?}] }
 * The call rides the user's existing browser session — no credential. PURE. Returns null on an incomplete recipe.
 */
export function recipeToLeg(recipe, { account = 'me', trusted = false } = {}) {
  const r = (recipe && typeof recipe === 'object') ? recipe : null;
  if (!r) return null;
  const id = _str(r.id) || _str(r.name);
  const app = _str(r.app);
  const origin = _str(r.origin);
  const appHost = _str(r.appHost);                       // §13/§14 — origin derived from the open *.appHost tab
  const endpoint = _str(r.endpoint);
  if (!id || !app || !endpoint || !(origin || appHost)) return null;   // origin OR appHost
  const params = Array.isArray(r.params) ? r.params : [];
  const write = r.write === true;
  const host = origin || _str(r.host);
  return {
    key: connectorLegKey({ account, app, id, host }),
    name: r.name ?? id,
    does: r.does ?? null,
    mode: write ? 'act' : 'ask',
    domain: 'connector',
    source: 'builtin',
    params: params.map((p) => (p && p.name) || p).filter(Boolean),
    paramSchema: recipeParamSchema(params),
    // PP-3 (v2.74.1661) — `outward` rides here as hop 3 of the invariant-#3 threading (recipeFromCatalogEntry →
    // harvestedRecipeLegs' spread → recipeToLeg). This is THE field-reader: a marker not read here is silently
    // dropped on the SEEDED path while the curated path keeps working, which is the exact failure mode that
    // invariant records ("the curated app worked, the forged/seeded Ground silently lost the marker").
    safety: hintToSafety({ readOnlyHint: !write, destructiveHint: r.destructive === true, outward: r.outward === true }, trusted),
    tool: {
      impl: 'session', account, app,
      // PP-4 (v2.74.1680) — Invariant #3 hop 3 for the pipeline gate's axes. They ride onto the LEG (not into
      // `hintToSafety`, which stays raise-only and keeps its global `confirm` floor) because the two gates have
      // different scopes: `hintToSafety` decides what an ad-hoc write needs, `pipelineGate` decides what a
      // reviewed per-item RUN may do unattended. `undefined` means UNDECLARED and gates — only an explicit
      // boolean can relax anything.
      reversible: (typeof r.reversible === 'boolean') ? r.reversible : undefined,
      outward: (typeof r.outward === 'boolean') ? r.outward : (r.outward === true ? true : undefined),
      recipeId: id,   // v2.74.1340 (review A/§18) — the BARE stored id: the arm guard matches per-Ground records by THIS, never the prefixed leg.key
      origin: origin || null, appHost: appHost || null,
      itemUrl: _str(r.itemUrl) || null,   // FL-1c (v2.74.1347) — the object's HUMAN page template (ground-truth links)
      listUrl: _str(r.listUrl) || null,   // FL-1d (v2.74.1349) — the COLLECTION's human page ("show me" after a list read)
      // CX-9k (v2.74.1617) — the row's HUMAN display-id key(s), preference-ordered; the renderer tries these before
      // its generic first-…Number scan (VS warranty rows led with the per-home "01" claim sequence). String → [string].
      displayId: (Array.isArray(r.displayId) && r.displayId.some((x) => _str(x))) ? r.displayId.filter((x) => _str(x)).slice(0, 4) : (_str(r.displayId) ? [_str(r.displayId)] : null),
      // PM (v2.74.1633) — the recipe's CROSS-SYSTEM join key(s), preference-ordered: which field of a row reliably
      // identifies the same subject on ANOTHER system (Invariant #3 hop 3). Consumed by the map before its heuristics.
      // PM-6 (v1639) — the per-TARGET write field map: {<targetLegId>: {<param>: <path|{contact,type}|{literal}>}}.
      // Declared on the SOURCE recipe because only the source knows that its homeowner lives under a contact role.
      writeMap: (r.writeMap && typeof r.writeMap === 'object' && !Array.isArray(r.writeMap)) ? r.writeMap : null,
      joinKey: Array.isArray(r.joinKey) ? (r.joinKey.filter((x) => _str(x) || (x && typeof x === 'object' && _str(x.type))).slice(0, 12) || null) : (_str(r.joinKey) ? [_str(r.joinKey)] : null),   // PM-7 — rungs may be field NAMES or {contact,type} selectors
      // FL-8d (v2.74.1359; object form v1375) — the read's generic digest semantics {kind, scope, status}; the
      // fleet digest keys on THIS, never a recipe id. A legacy string pulse normalizes to {kind}.
      pulse: (r.pulse && typeof r.pulse === 'object') ? r.pulse : (_str(r.pulse) ? { kind: _str(r.pulse) } : null),
      // FL-10 (v2.74.1383) — drill declaration (list rows → evidence via the named comments read) + the
      // evidence gate on unattended writes. Recipe DATA; the fleet harness only reads these markers.
      // CX-9b (v2.74.1434) — drill grew the JOIN fields (param/from/matchOn/label: list row → the details read,
      // matched on a bound ask-param). Additive — fleet consumers read only `.via`.
      drill: (r.drill && typeof r.drill === 'object' && _str(r.drill.via)) ? {
        via: _str(r.drill.via),
        ...(_str(r.drill.param) ? { param: _str(r.drill.param) } : {}),
        ...(_str(r.drill.from) ? { from: _str(r.drill.from) } : {}),
        ...(_str(r.drill.matchOn) ? { matchOn: _str(r.drill.matchOn) } : {}),
        ...(Array.isArray(r.drill.label) ? { label: r.drill.label.filter((x) => _str(x)).slice(0, 10) } : {}),
        // v2.74.1559 — sidecar reads: the dossier pulls with the same join id (invariant #3: hop 3 rebuilds drill
        // field-by-field). v2.74.1928 — an entry may now be an OBJECT that RE-KEYS itself: `{id, from, param}`
        // when the sidecar's join value is a different field from the primary drill's (the timeline needs the
        // row's internal gid, while the primary joins on the order NUMBER — passing the number 404s), plus
        // optional `pick` (select ONE row of the sidecar's result by field value) and `extract` (write matched
        // prose into named fields the later clauses can read). The old bare-string form is unchanged.
        // ⚠ The previous line was `.filter((x) => _str(x))`, which stringifies an object to '' and DROPPED it —
        // silently, and only on the SEEDED path (hop 1 copies `drill` whole, so the curated twin kept working).
        // That is the invariant-#3 "works curated, dies seeded" class this very comment warns about, caught in
        // review before it shipped. Normalize both forms here so every projection carries the same shape.
        ...(Array.isArray(r.drill.also) ? { also: r.drill.also.map(_alsoEntry).filter(Boolean).slice(0, 4) } : {}),
      } : null,
      // CX-9b (v2.74.1434) — per-param `resolve` specs (human value → canonical id via one of the app's own reads;
      // Core/rideParamResolve.js). The panel dispatch resolves BEFORE the executor, so both transports benefit.
      resolve: (r.resolve && typeof r.resolve === 'object') ? r.resolve : null,
      autoRequires: _str(r.autoRequires) || null,
      endpoint, method: _str(r.method).toUpperCase() || 'GET',
      // CX-7 — a GraphQL READ is a POST with a body (the query document), so the body threads for gql recipes too
      // v2.74.1936 — a NON-GET READ may carry a body. The condition was `write || gql`, which encodes "a POST
      // with a body is either a write or a GraphQL document" — true of every ground until UPS, whose reads are
      // plain-JSON POSTs (`{"TrackingNumber":["1Z…"]}`). The leg projected with body:null and would have POSTed
      // an empty request. Same root assumption as the mode bug one hop up (harvestedRecipeLegs), caught by the
      // same probe. A GET still projects null — a declared body on a non-GET is intentional by construction.
      body: ((write || r.gql === true || String(r.method || 'GET').toUpperCase() !== 'GET') && r.body && typeof r.body === 'object') ? r.body : null,
      bodyType: _str(r.bodyType) || ((r.body && String(r.method || 'GET').toUpperCase() !== 'GET') ? 'json' : null),         // v1342 — json | form | raw (fillWriteBody); v1936 — any non-GET body defaults json, not writes only
      contentType: _str(r.contentType) || null,
      verifyIdentity: r.verifyIdentity === true,
      identityProbe: _str(r.identityProbe) || null,
      probeAccept: r.probeAccept === 'json' ? 'json' : null,   // CP-1 — the json-liveness probe kind (Invariant #3 hop 3)
      identityGql: (r.identityGql && typeof r.identityGql === 'object') ? r.identityGql : null,   // v1479 — {me} via a GraphQL identity read (the working transport → the AGENT id)
      capClass: _str(r.capClass) || null,   // DK-2 (v1482) — 'presence' = operator state (availability/roster/set), not queue-work; the queue sweep excludes it (§5). Invariant #3 hop 3.
      // CX-7 (v2.74.1386) — the Shopify-class transport markers: gql (POST body is a GraphQL document; a READ-ONLY
      // document may run unconfirmed — validated at both belts), csrf 'sniff' (token captured off the SPA's own
      // requests, no meta tag), urlParam (fill e.g. {handle} from the ride tab's URL — never from the model).
      gql: r.gql === true,
      csrf: _str(r.csrf) || null,
      urlParam: (r.urlParam && typeof r.urlParam === 'object' && _str(r.urlParam.name) && _str(r.urlParam.pattern)) ? { name: _str(r.urlParam.name), pattern: _str(r.urlParam.pattern) } : null,
      persistedOp: _str(r.persistedOp) || null,   // CX-7b — {op_sha} fills from the per-origin op bank (sniffed, never curated/model data)
      // v2.74.1936 — CROSS-HOST API + the token's header NAME. Every ground until UPS put its API on the same
      // origin as the page it rides; UPS's page is www.ups.com and its API is webapis.ups.com (same SITE, so
      // the page's own fetch is allowed — this leg does exactly what the SPA does). `csrfHeader` defaults to
      // x-csrf-token at the executor, so every existing recipe is byte-identical.
      apiHost: _str(r.apiHost) || null,
      listPath: _str(r.listPath) || null,   // v1936 — where this response's ROWS live, when heuristics can't reach them (a status envelope)
      // v2.74.2002 (Invariant #3 hop 3) — the DISPLAY projection: which of this record's fields are worth showing,
      // and which nested array renders as a chain. Carried whole, like `drill` — hand-picking a subset of a
      // structured marker is what created the `also`/`joinKey`/`matchOn` incidents.
      display: (r.display && typeof r.display === 'object' && !Array.isArray(r.display)) ? { ...r.display } : null,
      csrfHeader: _str(r.csrfHeader) || null,
      // v2.74.1955 — CSRF FROM THE COOKIE. Proven live 2026-08-02 18:41: `X-XSRF-TOKEN-ST` is readable from
      // document.cookie, a request carrying it returns 200, and the identical request with NO token returns 401 —
      // so 401 is this endpoint's "bad or missing token" and our failures were a wrong-token problem, not a
      // headers or cookies problem. Header-sniffing only ever sees the SPA's ECHO of this cookie, and only while
      // the app happens to be firing requests; worse, it cannot tell two apps apart on one host (webapis.ups.com
      // serves /track and /ship under SEPARATE data-protection key rings, and a ship token cannot decrypt at
      // track). The cookie NAME differs per app, so a cookie-sourced token is app-correct BY CONSTRUCTION.
      csrfCookie: _str(r.csrfCookie) || null,
      // HZ-1 (v2.74.1956) — the SOURCE's retention window. Read by the answer path (Core/sourceHorizon.js), never
      // by the executor: it shapes what an EMPTY result is allowed to claim, and must never gate the call itself.
      retention: (r.retention && typeof r.retention === 'object') ? { ...r.retention } : null,
      shopProbe: r.shopProbe === true,             // CX-7c — run the `{shop{name}}` liveness probe before the call
      requestHeaders: (r.requestHeaders && typeof r.requestHeaders === 'object') ? r.requestHeaders : null,
    },
  };
}

/**
 * An MCP tool descriptor → a cloud-broker connector leg. The MCP server's tool list IS a palette (1:1). The call
 * goes through the proxy with OAuth from a vault. PURE. Returns null without a server + tool name.
 *   mcpTool { name, description, inputSchema, annotations:{readOnlyHint?, destructiveHint?} }
 */
export function mcpToolToLeg(mcpTool, { account = 'me', server, trusted = false } = {}) {
  const m = (mcpTool && typeof mcpTool === 'object') ? mcpTool : null;
  if (!m) return null;
  const name = _str(m.name);
  const srv = _str(server);
  if (!name || !srv) return null;
  const ann = (m.annotations && typeof m.annotations === 'object') ? m.annotations : {};
  const schema = (m.inputSchema && typeof m.inputSchema === 'object') ? m.inputSchema : { type: 'object', properties: {} };
  return {
    key: `${account}.${srv}.${name}`,
    name,
    does: m.description ?? null,
    mode: ann.readOnlyHint ? 'ask' : 'act',
    domain: 'connector',
    source: 'builtin',
    params: Object.keys(schema.properties || {}),
    paramSchema: pruneSchema(schema),
    safety: hintToSafety(ann, trusted),
    tool: { impl: 'oauth', account, server: srv, name },
  };
}
