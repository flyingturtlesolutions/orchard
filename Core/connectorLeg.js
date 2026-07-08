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
      endpoint, method: _str(r.method).toUpperCase() || 'GET',
      body: (write && r.body && typeof r.body === 'object') ? r.body : null,   // write body TEMPLATE; the executor fillBody()s it
      bodyType: _str(r.bodyType) || (write && r.body ? 'json' : null),         // v1342 — json | form | raw (fillWriteBody)
      contentType: _str(r.contentType) || null,
      verifyIdentity: r.verifyIdentity === true,
      identityProbe: _str(r.identityProbe) || null,
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
