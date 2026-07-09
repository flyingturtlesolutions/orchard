// Core/manualRecipe.js — OV-5 (v2.74.1413, DESIGN_overview.md §3): validate + normalize a MANUALLY-authored ride
// recipe (the workbench's "add a leg by hand" path — the no-code replacement for hand-editing CONNECTOR_RECIPES).
// PURE. A manual recipe lands `reviewState: 'pending'` + `provenance: 'manual'` + low trust — it must be TESTED and
// VERIFIED before an app can consume it (verified = armed + reviewed + enabled). The safety class is DERIVED from the
// method (never the untrusted name — the §9 rule): GET → auto, other → gated, destructive → destructive.
//
// @module Core/manualRecipe

import { safetyClassForMethod } from './rideRecipe.js';

const _METHODS = /^(GET|POST|PUT|PATCH|DELETE)$/;
const _slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'leg';

/**
 * Validate + normalize a manual ride-recipe input into a storable record. PURE.
 * @param {object} input  { name, method, endpoint, does?, params?[{name,type?,required?,gid?}], body?, destructive?, id? }
 * @param {{ groundId?:string, origin?:string }} [ctx]
 * @returns {{ ok:boolean, errors:string[], recipe:(object|null) }}
 */
export function buildManualRecipe(input = {}, { groundId = '', origin = '' } = {}) {
  const inp = (input && typeof input === 'object') ? input : {};
  const errors = [];
  const name = String(inp.name || '').trim();
  if (!name) errors.push('a name is required');
  const method = String(inp.method || 'GET').trim().toUpperCase();
  if (!_METHODS.test(method)) errors.push('method must be GET, POST, PUT, PATCH, or DELETE');
  const endpoint = String(inp.endpoint || '').trim();
  if (!endpoint || endpoint[0] !== '/') errors.push('endpoint must be a path starting with "/"');
  const params = Array.isArray(inp.params)
    ? inp.params.filter((p) => p && p.name).map((p) => {
      const o = { name: String(p.name).trim(), type: String(p.type || 'string') };
      if (p.required) o.required = true;
      if (p.gid) o.gid = String(p.gid);
      return o;
    })
    : [];
  const destructive = inp.destructive === true;
  if (errors.length) return { ok: false, errors, recipe: null };
  const recipe = {
    id: String(inp.id || '').trim() || _slug(name),
    groundId: String(groundId || ''),
    origin: String(origin || inp.origin || ''),
    name,
    does: String(inp.does || '').trim(),
    method,
    endpoint,
    params,
    body: (inp.body && typeof inp.body === 'object') ? inp.body : null,
    provenance: 'manual',
    safetyClass: safetyClassForMethod(method, { destructive }),
    trust: 0.5,                 // user-authored = lower confidence than a curated leg (trust 1)
    enabled: true,
    reviewState: 'pending',     // a manual leg is UNVERIFIED until it's tested + accepted
    ...(destructive ? { destructive: true } : {}),
  };
  return { ok: true, errors: [], recipe };
}

/**
 * Parse a compact one-line leg spec into a buildManualRecipe input. PURE. Format:
 *   `<Name> | <METHOD> <endpoint>`   e.g.  `Read ticket | GET /api/v2/tickets/{id}.json`
 * Params are lifted from `{placeholder}` tokens in the endpoint (each required). Returns null on a malformed spec.
 * @returns {{ name:string, method:string, endpoint:string, params:Array }|null}
 */
export function parseLegSpec(text) {
  const s = String(text || '').trim();
  const bar = s.indexOf('|');
  if (bar < 0) return null;
  const name = s.slice(0, bar).trim();
  const m = s.slice(bar + 1).trim().match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i);
  if (!name || !m) return null;
  const endpoint = m[2];
  const params = [...new Set((endpoint.match(/\{([a-zA-Z_][\w-]*)\}/g) || []).map((x) => x.slice(1, -1)))]
    .map((n) => ({ name: n, required: true }));
  return { name, method: m[1].toUpperCase(), endpoint, params };
}
