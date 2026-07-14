// Core/federate.js — DK-4 (DESIGN_desks.md §6): the federated cross-site queue. PURE: no chrome / DOM / fetch.
//
// A role-scoped Desk holds MANY connected queues at once. The real unit of work is cross-site: a customer CALLS
// (Aircall) about a WARRANTY (VendorSuite) on an ORDER (Shopify), tracked as a TICKET (Zendesk). This module takes
// the WorkItems a sweep read from every connection (DK-3's normalizer) and UNIONS them into ISSUES by shared
// correlation key (email / phone / order-no) — a call ⇄ warranty ⇄ ticket ⇄ order sharing a key are ONE issue.
//
// EXACT grouping only (§9 — start exact, no fuzzy near-matches); corrKeys are already typed + normalized by DK-3
// (`email:` / `phone:` / `order:`). Union is TRANSITIVE: if A↔B share a phone and B↔C share an email, A/B/C are one
// issue. An item with no corrKeys is its own singleton issue (still surfaced as work, just not linked).

import { toWorkItems } from './connectorRender.js';

/**
 * Group WorkItems into ISSUES by shared corrKeys (transitive union-find). PURE. Each issue:
 *   { id, corrKeys[] (merged, sorted), sources[] (distinct, sorted), items[], crossSite (sources.length > 1) }
 * Deterministic order: cross-site issues first, then larger issues, then by first corrKey; ids assigned i1..iN AFTER
 * sorting (so the id reflects the stable order, not input order).
 */
export function groupIntoIssues(workItems) {
  const items = (Array.isArray(workItems) ? workItems : []).filter((w) => w && typeof w === 'object');
  const parent = items.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const firstForKey = new Map();
  items.forEach((w, i) => {
    for (const k of (Array.isArray(w.corrKeys) ? w.corrKeys : [])) {
      if (firstForKey.has(k)) union(firstForKey.get(k), i); else firstForKey.set(k, i);
    }
  });
  const groups = new Map();
  items.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  const issues = [];
  for (const idxs of groups.values()) {
    const its = idxs.map((i) => items[i]);
    const corrKeys = [...new Set(its.flatMap((w) => (Array.isArray(w.corrKeys) ? w.corrKeys : [])))].sort();
    const sources = [...new Set(its.map((w) => w.source).filter(Boolean))].sort();
    issues.push({ corrKeys, sources, items: its, crossSite: sources.length > 1 });
  }
  issues.sort((a, b) =>
    (Number(b.crossSite) - Number(a.crossSite)) ||
    (b.items.length - a.items.length) ||
    (String(a.corrKeys[0] || '')).localeCompare(String(b.corrKeys[0] || '')));
  issues.forEach((iss, i) => { iss.id = `i${i + 1}`; });
  return issues;
}

/**
 * Federate a sweep's executed reads into issues. `results` = [{ key, params, value }] (the panel's per-leg read
 * outputs); `sourceOf(result)` names the connection a result came from (default: the host tail of the leg key,
 * "aw_open_conversations@workspace.aircall.io" → "workspace.aircall.io"). PURE. Returns { items, issues, crossSite }.
 */
export function federateResults(results, { sourceOf } = {}) {
  const src = typeof sourceOf === 'function' ? sourceOf : _hostFromKey;
  const items = [];
  for (const r of (Array.isArray(results) ? results : [])) {
    const source = String(src(r) || '');
    const value = (r && typeof r === 'object' && 'value' in r) ? r.value : r;
    items.push(...toWorkItems(value, { source }));
  }
  const issues = groupIntoIssues(items);
  return { items, issues, crossSite: issues.filter((i) => i.crossSite).length };
}

const _hostFromKey = (r) => { const k = String((r && r.key) || ''); const at = k.indexOf('@'); return at >= 0 ? k.slice(at + 1) : k; };

/**
 * Compact lines describing the CROSS-SITE issues (single-source issues add nothing to the propose think — they ARE
 * the per-connection queue the reads already show). For the propose prompt block + the trace. PURE. Capped.
 */
export function issueLines(issues, { max = 12, perIssue = 8 } = {}) {
  const cross = (Array.isArray(issues) ? issues : []).filter((i) => i && i.crossSite).slice(0, max);
  const lines = [];
  for (const iss of cross) {
    lines.push(`ISSUE ${iss.id} (${iss.corrKeys.join(', ')}) — ${iss.items.length} items across ${iss.sources.join(', ')}:`);
    for (const w of iss.items.slice(0, perIssue)) {
      lines.push(`  - ${w.source || '?'}: #${w.id || '?'} "${String(w.subject || '').slice(0, 60)}"${w.state ? ` [${w.state}]` : ''}`);
    }
  }
  return lines;
}

/** The corrKey KINDS present in the cross-site issues (email/phone/order), for a compact trace tag. PURE. */
export function crossSiteKinds(issues) {
  const kinds = new Set();
  for (const iss of (Array.isArray(issues) ? issues : [])) {
    if (!iss || !iss.crossSite) continue;
    for (const k of (iss.corrKeys || [])) kinds.add(String(k).split(':')[0]);
  }
  return [...kinds].sort();
}
