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
 */
export function hintToSafety({ readOnlyHint = false, destructiveHint = false } = {}, trusted = false) {
  if (destructiveHint) return 'gated';            // raise — always honored
  if (trusted && readOnlyHint) return 'auto';     // lower — only for a vetted read
  return 'confirm';                                // floor — writes, and untrusted reads
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
    properties[name] = slot;
    if (p && p.required) required.push(name);
  }
  return { type: 'object', properties, required };
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
    safety: hintToSafety({ readOnlyHint: !write, destructiveHint: r.destructive === true }, trusted),
    tool: {
      impl: 'session', account, app,
      recipeId: id,   // v2.74.1340 (review A/§18) — the BARE stored id: the arm guard matches per-Ground records by THIS, never the prefixed leg.key
      origin: origin || null, appHost: appHost || null,
      itemUrl: _str(r.itemUrl) || null,   // FL-1c (v2.74.1347) — the object's HUMAN page template (ground-truth links)
      listUrl: _str(r.listUrl) || null,   // FL-1d (v2.74.1349) — the COLLECTION's human page ("show me" after a list read)
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
        ...(Array.isArray(r.drill.also) ? { also: r.drill.also.filter((x) => _str(x)).slice(0, 4) } : {}),   // v2.74.1559 — sidecar reads the dossier pulls with the same join id (invariant #3: hop 3 rebuilds drill field-by-field)
      } : null,
      // CX-9b (v2.74.1434) — per-param `resolve` specs (human value → canonical id via one of the app's own reads;
      // Core/rideParamResolve.js). The panel dispatch resolves BEFORE the executor, so both transports benefit.
      resolve: (r.resolve && typeof r.resolve === 'object') ? r.resolve : null,
      autoRequires: _str(r.autoRequires) || null,
      endpoint, method: _str(r.method).toUpperCase() || 'GET',
      // CX-7 — a GraphQL READ is a POST with a body (the query document), so the body threads for gql recipes too
      body: ((write || r.gql === true) && r.body && typeof r.body === 'object') ? r.body : null,
      bodyType: _str(r.bodyType) || (write && r.body ? 'json' : null),         // v1342 — json | form | raw (fillWriteBody)
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
