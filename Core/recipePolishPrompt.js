// Core/recipePolishPrompt.js — §17 (DESIGN_connectors.md): the LLM POLISH stage for a harvested ride-recipe. The
// crawl-as-generalizer (recipeFromHarvest.js) emits a STRUCTURALLY correct proto with a placeholder name
// ("GET /api/v2/tickets/{id}.json") and an empty `does`; this names it ("Read a ticket"), writes one line of `does`,
// and suggests clearer param names ({id} → ticketId). The OBS-4 analog (LLM name/intent + param generalization), for
// the network twin. Cheap tier — small bounded input.
//
// PRIVACY-FIRST by construction (DESIGN_llm_privacy.md): the only thing sent is the endpoint's TEMPLATE — method, the
// path with real ids ALREADY collapsed to {params}, and param types. There is NO instance data: no real ids (templated
// away by the generalizer), no record bodies, no PII. This is the safest possible LLM input — purely structural.
//
// SAFE-MERGE (applyPolish): the LLM only relabels. method / endpoint STRUCTURE / safetyClass / provenance / reviewState
// / trust / enabled / id are NEVER read from the polish — they are preserved from the proto. A param rename is applied
// positionally and keeps the endpoint's {placeholder} in sync (single-pass map replace — collision-safe); any mismatch
// falls back to name+does only. So a hostile/garbled polish can at worst mislabel — it can't change what the recipe DOES
// or its safety. PURE: no chrome / DOM / LLM / clock.

const _str = (v) => (typeof v === 'string' ? v.trim() : '');

// A safe identifier for a param name: letters/digits, must START with a letter. '' if it can't be made one.
const _slugId = (s) => {
  const t = String(s || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-zA-Z]/.test(t) ? t.slice(0, 40) : '';
};

const _SYSTEM = `You label a REST API endpoint so a person can recognize it in a list. You are given the STRUCTURE of one endpoint a tool harvested from a web app: its HTTP method, a templated path (real ids already replaced by {params}), and the param types. There is NO real data here — only the shape.

Reply with ONLY a JSON object:
{"name":"<2-5 word human label>","does":"<one plain sentence: what calling this returns or does>","params":["<one name per {param}, in order>"]}

RULES:
- name: a short noun phrase someone scanning a list would understand — "Read a ticket", "Search tickets", "Delete a ticket". Read the method's intent: GET = read/list, POST = create, PUT/PATCH = update, DELETE = delete.
- does: one plain sentence. Don't just restate the URL.
- params: one clear name per {param}, IN ORDER (e.g. {id} under /tickets → "ticketId"). The array length MUST equal the number of {params} given. Identifiers only (start with a letter). If a param is already well named, keep it.
- Output JSON only. There is no real data to leak; never invent endpoints, fields, or values.`;

/**
 * Build the polish messages. PURE. Sends ONLY the structural template (method, templated endpoint, param types, app
 * host) — no instance data ever leaves here. `recipe` is a proto from recipesFromHarvest.
 * @param {{ method?:string, endpoint?:string, params?:Array<{name:string,type:string}>, appHost?:string }} recipe
 * @returns {{ system:string, user:string }}
 */
export function buildRecipePolishMessages(recipe = {}) {
  const r = (recipe && typeof recipe === 'object') ? recipe : {};
  const payload = {
    method: String(r.method || 'GET').toUpperCase(),
    endpoint: String(r.endpoint || ''),
    params: (Array.isArray(r.params) ? r.params : []).map((p) => ({ name: String((p && p.name) || ''), type: String((p && p.type) || 'string') })),
    app: String(r.appHost || ''),
  };
  const user = `ENDPOINT (structure only — no real data):\n${JSON.stringify(payload)}`;
  return { system: _SYSTEM, user };
}

// First balanced top-level {…} object (string/escape-aware), JSON-parsed. PURE. null if none / invalid.
function _firstJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/**
 * Parse the polish output → { name, does, params } | null. PURE. Tolerates prose around the JSON. Caps lengths. `params`
 * is the ordered list of suggested names (validated/zipped later by applyPolish). null when nothing usable parsed.
 * @param {string} text
 * @returns {{ name:string, does:string, params:string[] } | null}
 */
export function parseRecipePolishOutput(text) {
  const obj = _firstJson(text);
  if (!obj || typeof obj !== 'object') return null;
  const name = _str(obj.name).slice(0, 80);
  const does = _str(obj.does).slice(0, 200);
  const params = Array.isArray(obj.params) ? obj.params.map((p) => _str(p)) : [];
  if (!name && !does && !params.some(Boolean)) return null;
  return { name, does, params };
}

/**
 * Apply a polish onto a proto-recipe — the SAFE relabel. PURE. Overwrites ONLY name / does, and (positionally, when the
 * count matches and every name is a valid unique identifier) the param names — keeping each endpoint {placeholder} in
 * sync via a SINGLE-PASS map replace (collision-safe: each placeholder resolves independently, so a new name colliding
 * with another param's old name can't double-apply). method / safetyClass / provenance / reviewState / trust / enabled /
 * id are taken from the proto and NEVER from the polish, so a bad polish can at most mislabel.
 * @param {object} recipe a proto from recipesFromHarvest
 * @param {{ name?:string, does?:string, params?:string[] } | null} polish
 * @returns {object} a new recipe
 */
export function applyPolish(recipe, polish) {
  const r = (recipe && typeof recipe === 'object') ? recipe : {};
  const p = (polish && typeof polish === 'object') ? polish : {};
  const out = { ...r };
  const name = _str(p.name);
  const does = _str(p.does);
  if (name) out.name = name.slice(0, 80);
  if (does) out.does = does.slice(0, 200);

  const curr = Array.isArray(r.params) ? r.params : [];
  const names = Array.isArray(p.params) ? p.params : [];
  if (curr.length && names.length === curr.length) {
    const next = []; const seen = new Set(); let ok = true;
    for (let i = 0; i < curr.length; i++) {
      const nm = _slugId(names[i]);
      if (!nm || seen.has(nm)) { ok = false; break; }   // invalid or duplicate name → skip the rename entirely
      seen.add(nm); next.push({ ...curr[i], name: nm });
    }
    if (ok) {
      const rename = new Map(curr.map((c, i) => [String(c.name), next[i].name]));
      out.endpoint = String(r.endpoint || '').replace(/\{([^}]+)\}/g, (m, key) => (rename.has(key) ? `{${rename.get(key)}}` : m));
      out.params = next;
    }
  }
  return out;
}
