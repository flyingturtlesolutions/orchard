// Core/rideParamResolve.js — declarative ride-recipe param RESOLUTION + row filtering (CX-9b, v2.74.1434). PURE.
//
// The ID-layer fix the VendorSuite live test surfaced: users speak MARKET language ("Atlanta West", "210"), the API
// speaks internal ids (83). A recipe declares HOW a param resolves via one of the app's own reads (the `resolve`
// marker), and this module maps a human value → the canonical id against that read's reply. The identity-probe
// precedent (`verifyIdentity` → args.me) generalized to data: marker on the recipe, mechanism in code, nothing
// app-specific here. Also `filterRowsByText` — the deterministic row join the `drill` marker uses (address → row →
// TaskId): CODE matches rows, the model never joins.
//
// The `resolve` spec (per param, on the recipe):
//   { via: '/api/VendorSuite/State',            // the app's own read that carries the mapping (same-origin GET)
//     defaultPath: 'access.DefaultDivision.Id', // value when the ask bound nothing (the user's current context)
//     lists: ['currentHub.Divisions', 'access.Hubs[].Divisions'],   // where the candidate rows live ([] = flatten)
//     match: ['Code', 'Name'],                  // fields a HUMAN value matches, in precedence order
//     id: 'Id', label: 'Name' }                 // the canonical field the param takes + the honest display name

/** Walk a dotted path, flattening any `[]` segment (a.b[].c → c of every row of every a.b). PURE. */
export function getPath(obj, path) {
  let cur = [obj];
  for (const seg of String(path || '').split('.').filter(Boolean)) {
    const flat = seg.endsWith('[]');
    const key = flat ? seg.slice(0, -2) : seg;
    const next = [];
    for (const o of cur) {
      const v = (o && typeof o === 'object') ? o[key] : undefined;
      if (v === undefined) continue;
      if (flat && Array.isArray(v)) next.push(...v);
      else next.push(v);
    }
    cur = next;
    if (!cur.length) return undefined;
  }
  return cur.length > 1 ? cur : cur[0];
}

// Candidate rows from every `lists` path, flattened + deduped by the id field. PURE.
function _rows(state, spec) {
  const out = []; const seen = new Set();
  for (const p of (Array.isArray(spec.lists) ? spec.lists : [])) {
    let v = getPath(state, p);
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) v = [v];
    for (const row of v.flat(2)) {
      if (!row || typeof row !== 'object') continue;
      const id = row[spec.id];
      if (id === undefined || id === null || seen.has(String(id))) continue;
      seen.add(String(id)); out.push(row);
    }
  }
  return out;
}

const _norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const _label = (row, spec) => String(row[spec.label] != null ? row[spec.label] : row[spec.id]);

/**
 * Resolve one param value against a `resolve` spec + the via-read's reply. PURE.
 *   raw missing/empty → { value, label } from defaultPath (the user's current context).
 *   raw matches a row's match-field (precedence order; case-insensitive; Name also contains-matches) → that row's id.
 *   raw matches DIFFERENT rows on different fields (a Code that is also another row's Id) → { ambiguous, candidates }
 *     — never silently pick; the caller asks. A same-row multi-hit is NOT ambiguous.
 *   raw matches nothing → { unknown, candidates } (closest Name contains-hits, capped) for an honest ask-back.
 *   No spec / no usable state → null (caller proceeds unresolved — never blocks on the resolver's own failure).
 */
export function resolveRideParam(spec, raw, state) {
  if (!spec || typeof spec !== 'object' || !spec.id || !state || typeof state !== 'object') return null;
  const rows = _rows(state, spec);
  const has = raw !== undefined && raw !== null && String(raw).trim() !== '';
  // DK-7 (v2.74.1488) — the "each" mode: same spec, same via-read, different CARDINALITY. When the recipe OPTS IN
  // (spec.each: true) and the model bound the each-sentinel ("for each division…" → divisionId:"each"), return the
  // FULL candidate list instead of matching one — the dispatcher fans the leg out over it (reads only, capped).
  // Interpretation stays with the model (it binds the sentinel); enumeration + iteration stay deterministic. A spec
  // without each:true treats "each" like any other unknown value (honest ask-back) — tighten by default. Note: a
  // row literally NAMED "All"/"Each" is shadowed on an each-enabled spec — acceptable, the collective sense wins.
  if (has && spec.each === true && /^(each|every|all)$/.test(_norm(raw))) {
    // DK-7b (v2.74.1489) — eachCap guards the ENUMERATION (an absurd state can't mint a 10k list); the EXECUTION
    // budget is the dispatcher's window (16 per pass + "continue" — live: 121 divisions, and the old cap-16 here
    // made rows 17+ structurally unreachable).
    const cap = (Number.isFinite(spec.eachCap) && spec.eachCap > 0) ? spec.eachCap : 200;
    const values = rows.slice(0, cap).map((r) => ({ value: r[spec.id], label: _label(r, spec) }));
    if (!values.length) return { unknown: true, candidates: [] };   // enumerable but EMPTY state → honest ask-back, never a silent no-op
    return { each: true, values, total: rows.length, capped: rows.length > values.length };
  }
  if (!has) {
    const dv = spec.defaultPath ? getPath(state, spec.defaultPath) : undefined;
    if (dv === undefined || dv === null) return null;
    const row = rows.find((r) => String(r[spec.id]) === String(dv));
    return { value: dv, label: row ? _label(row, spec) : String(dv), defaulted: true };
  }
  const q = _norm(raw);
  const fields = (Array.isArray(spec.match) && spec.match.length) ? spec.match : ['Name'];
  const hits = [];   // one entry per matched ROW (field precedence = order found)
  for (const f of fields) {
    for (const row of rows) {
      if (_norm(row[f]) !== q) continue;
      if (!hits.some((h) => h.row === row)) hits.push({ row, field: f });
    }
  }
  // the param given as the canonical id itself passes through (checked AFTER match fields: a "210" that is a Code
  // must resolve as the market number even if some other division's Id is 210 — that collision is ambiguity below)
  const idRow = rows.find((r) => _norm(r[spec.id]) === q);
  if (idRow && !hits.some((h) => h.row === idRow)) hits.push({ row: idRow, field: spec.id });
  if (hits.length === 1) return { value: hits[0].row[spec.id], label: _label(hits[0].row, spec) };
  if (hits.length > 1) return { ambiguous: true, candidates: hits.map((h) => ({ value: h.row[spec.id], label: _label(h.row, spec), matched: h.field })) };
  // nothing exact — offer the closest Name contains-hits so the ask-back is useful, not a dead end
  const near = rows.filter((r) => _norm(_label(r, spec)).includes(q) || q.includes(_norm(_label(r, spec)))).slice(0, 5)
    .map((r) => ({ value: r[spec.id], label: _label(r, spec) }));
  return { unknown: true, candidates: near };
}

/**
 * Deterministic row filter for the drill join (address → task row). PURE. A row matches when EVERY normalized token
 * of `text` appears in the row's joined `fields` text ("123 main st" hits "123 Main Street NW" — 'st' rides inside
 * 'street'). Returns the matching rows (caller decides: 1 → drill, 0/many → honest ask-back).
 */
export function filterRowsByText(rows, fields, text) {
  const toks = _norm(text).split(' ').filter(Boolean);
  if (!toks.length) return [];
  const fs = Array.isArray(fields) ? fields : [];
  const out = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row || typeof row !== 'object') continue;
    const hay = _norm(fs.map((f) => row[f]).filter((v) => v != null).join(' '));
    if (hay && toks.every((t) => hay.includes(t))) out.push(row);
  }
  return out;
}
