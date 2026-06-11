// Core/orchTemplate.js — ORCH-X T2: cross-argument REBIND for composites.
//
// A composite saved for "search for ANDROID jobs and if any, sort" should also serve "search for SOFTWARE jobs …"
// — same SHAPE, different ARGUMENT. Today each keyword saves its OWN composite (an exact-alias cache only hits the
// identical ask). This generalizes the T2 cache across arguments, deterministically (no LLM):
//   • buildCompositeTemplate(ask, bindings) — at SAVE, replace each bound param VALUE that appears in the ask with a
//     {PARAM} hole → a reusable template ("search for {SEARCH_…} jobs and if any, sort").
//   • matchTemplate(ask, template)          — at MATCH, fit a new ask to the template, capturing the hole values as
//     fresh bindings ({SEARCH_…: 'software'}). Null when it doesn't fit.
//   • rebindSteps(steps, bindings)          — apply those bindings to the composite's IR (overwrite the frozen
//     fragment bindings) so it runs with the new argument.
//
// PURE: no DOM / chrome / LLM. A T2 cache hit that survives a changed argument.
//
// @module Core/orchTemplate

const _esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Template an ask by replacing each bound param VALUE (that appears in the ask) with a {PARAM} placeholder. PURE.
 * Longest values first (so a longer value isn't partially eaten by a shorter one). A param whose value is NOT in
 * the ask (a default/prior binding) is left fixed. Returns { template, slots:[paramName…] }.
 * @param {string} ask
 * @param {object} bindings  param → value
 * @returns {{template:string, slots:string[]}}
 */
export function buildCompositeTemplate(ask, bindings) {
  let template = String(ask || '');
  const slots = [];
  const entries = Object.entries((bindings && typeof bindings === 'object') ? bindings : {})
    .filter(([, v]) => v != null && String(v).trim().length >= 2)
    .sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [param, value] of entries) {
    if (template.includes(`{${param}}`)) continue;
    const v = String(value).trim();
    let re;
    try { re = new RegExp(`\\b${_esc(v)}\\b`, 'i'); } catch { continue; }
    if (re.test(template)) { template = template.replace(re, `{${param}}`); slots.push(param); }
  }
  return { template, slots };
}

/**
 * Fit a new ask to a template, capturing the hole values as bindings. PURE. {PARAM} → a non-greedy capture; the
 * literal text between holes must match exactly (case-insensitive). Returns the captured bindings, or null when the
 * ask doesn't fit the template (or the template has no holes).
 * @param {string} ask
 * @param {string} template
 * @returns {(object|null)}
 */
export function matchTemplate(ask, template) {
  const t = String(template || '');
  if (!/\{[A-Za-z0-9_]+\}/.test(t)) return null;
  const params = [];
  let pattern = '^\\s*';
  for (const part of t.split(/(\{[A-Za-z0-9_]+\})/)) {
    const m = part.match(/^\{([A-Za-z0-9_]+)\}$/);
    if (m) { params.push(m[1]); pattern += '(.+?)'; }
    else pattern += _esc(part);
  }
  pattern += '\\s*$';
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { return null; }
  const mm = String(ask || '').match(re);
  if (!mm) return null;
  const bindings = {};
  params.forEach((p, i) => { const val = (mm[i + 1] || '').trim(); if (val) bindings[p] = val; });
  return Object.keys(bindings).length ? bindings : null;
}

/**
 * Rebind a composite's IR: overwrite each fragment's bindings with the new values (only params the fragment already
 * has). PURE — returns a new step tree, the input untouched. Descends into control-flow bodies.
 * @param {object[]} steps
 * @param {object} bindings  param → new value
 * @returns {object[]}
 */
export function rebindSteps(steps, bindings) {
  const b = (bindings && typeof bindings === 'object') ? bindings : {};
  const walk = (arr) => (Array.isArray(arr) ? arr : []).map((s) => {
    if (!s || typeof s !== 'object') return s;
    let next = s;
    if (s.kind === 'fragment' && s.bindings && typeof s.bindings === 'object') {
      let changed = false;
      const nb = { ...s.bindings };
      for (const k of Object.keys(nb)) {
        if (b[k] != null && String(b[k]).trim() && nb[k] !== b[k]) { nb[k] = b[k]; changed = true; }
      }
      if (changed) next = { ...s, bindings: nb };
    }
    if (Array.isArray(next.body)) next = { ...next, body: walk(next.body) };
    return next;
  });
  return walk(steps);
}
