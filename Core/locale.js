// Core/locale.js — Locale (Perspective capability catalog) builder + query API.
//
// See PAGEMODEL_SPEC.md. A Locale is the intent-independent capability catalog
// of ONE page archetype: Features (units of capability) organized into Layers and
// serving Goals. This module is PURE (no chrome / DOM deps) so it can run in the
// background, the sidepanel, and node unit tests alike. The content script emits
// RAW features (read-only enumeration, L0); `buildLocale` assembles them into
// the queryable artifact; downstream calls the query API rather than walking the
// raw object.
//
// v2.74.475 — Graph edges: `localeEdges` materializes the typed edge set (reveals /
// contains / enables / leadsTo) from the denormalized node fields, plus edgesFrom /
// edgesTo / edgesByKind selectors and `pathToGoal` (depth-aware goal traversal). The
// Locale's "small graph" (PAGEMODEL_SPEC § 1) becomes traversable, not just per-kind
// queryable. (Build slice 1 baseline: schema + builder + query API + L0 assembly.)

export const LOCALE_SCHEMA = 2;

export const FEATURE_KINDS = Object.freeze([
  'input', 'action', 'disclosure', 'navigation', 'collection', 'region', 'composite',
]);

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Assemble a Locale from raw enumerated features + capture meta.
 * @param {Array<object>} rawFeatures  feature objects (must carry a stable `id`)
 * @param {object} meta  { url, urlPattern?, title, viewport, scrollHeight, enumeratedAt, fidelity? }
 * @returns {object} Locale
 */
export function buildLocale(rawFeatures, meta = {}) {
  const features = {};
  for (const f of Array.isArray(rawFeatures) ? rawFeatures : []) {
    if (f && typeof f.id === 'string' && f.id) features[f.id] = f;
  }
  const surfaceFeatureIds = Object.keys(features);
  const layers = {
    surface: { id: 'surface', kind: 'surface', openedBy: null, overlay: false, features: surfaceFeatureIds },
  };
  const goals = {};
  return {
    schema: LOCALE_SCHEMA,
    url: meta.url ?? '',
    urlPattern: meta.urlPattern ?? meta.url ?? '',
    title: meta.title ?? '',
    viewport: meta.viewport ?? null,
    scrollHeight: meta.scrollHeight ?? null,
    features,
    layers,
    goals,
    index: buildIndex(features),
    coverage: {
      fidelity: meta.fidelity ?? 'L0',
      driftHash: driftHash(features),
      lastExploredAt: meta.enumeratedAt ?? Date.now(),
      bands: meta.bands ?? null,
      featureCount: surfaceFeatureIds.length,
      capped: meta.capped ?? false,   // EX-3 — enumeration hit FEATURE_CAP (catalog is truncated/incomplete)
    },
  };
}

/** Denormalized indices for cheap queries (PAGEMODEL_SPEC § 2). */
export function buildIndex(features) {
  const byKind = {};
  const byGoal = {};
  const triggers = [];
  for (const f of Object.values(features || {})) {
    if (!f) continue;
    (byKind[f.kind] ||= []).push(f.id);
    for (const g of f.goals || []) (byGoal[g] ||= []).push(f.id);
    if (f.kind === 'disclosure' && f.reveals) triggers.push({ featureId: f.id, revealsLayerId: f.reveals });
  }
  // EX-2 (v2.74.846) — DETERMINISTIC ordering. Features arrive in Object.values insertion order, which varies run-to-run
  // (lazy-load + band-scan timing), and synthesizeGoals SLICES these arrays — so an unsorted index yields a different
  // goal catalog (→ different goals) for the SAME page. Sort every index array by id so two enumerations of an unchanged
  // page produce an identical index → identical goals: the precondition for cache-replay (EX-4) and honest drift.
  for (const arr of Object.values(byKind)) arr.sort();
  for (const arr of Object.values(byGoal)) arr.sort();
  triggers.sort((a, b) => (a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0));
  return { byKind, byGoal, triggers };
}

// ─── Query API (PAGEMODEL_SPEC § 7) ─────────────────────────────────────────────
// Downstream SELECTS from the catalog; it never walks the raw artifact.

/** All features of a kind. */
export function featuresByKind(model, kind) {
  return (model?.index?.byKind?.[kind] || []).map((id) => model.features[id]).filter(Boolean);
}

/**
 * Rank features that could fill a named role (fuzzy: label/role/kind token overlap
 * + kind affinity). Returns selection-ready rows, best first.
 */
export function featuresForRole(model, role, { kind = null } = {}) {
  const want = tokens(role);
  const affinity = kindAffinityForRole(role);
  const pool = Object.values(model?.features || {}).filter((f) => f && (!kind || f.kind === kind));
  return pool
    .map((f) => ({ f, score: matchScore(want, affinity, f) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => ({
      id: x.f.id,
      kind: x.f.kind,
      label: x.f.label,
      selector: x.f.selector,
      location: x.f.location ?? null,
      scrollToY: x.f.location?.scrollToY ?? null,
      verified: !!x.f.selectorVerified,
      score: round2(x.score),
    }));
}

/**
 * Flat verified-selector hints over the WHOLE page (not just poked controls).
 * Back-compat shape for resolveRoles' KNOWN VERIFIED SELECTORS block.
 */
export function knownSelectors(model) {
  return Object.values(model?.features || {})
    .filter((f) => f && f.selector)
    .map((f) => ({
      label: f.label || '', role: f.a11yRole || f.kind, selector: f.selector, verified: !!f.selectorVerified,
      // v2.74.447 — other-language labels (cross-locale harvest) so resolve matches any language.
      aliases: f.labelsByLocale ? Object.values(f.labelsByLocale).filter((l) => l && l !== f.label) : [],
    }));
}

/** Scroll offset to bring a feature into view (kills "viewport = canonical"). */
export function scrollTargetFor(model, featureId) {
  return model?.features?.[featureId]?.location?.scrollToY ?? null;
}

/** Content collections (cards/tiles/rows) — the repeating-block features. */
export function collections(model) {
  return featuresByKind(model, 'collection');
}

/** Best disclosure feature matching a trigger label (reveal-resolve). */
export function disclosureFor(model, triggerLabel) {
  const want = tokens(triggerLabel);
  const pool = featuresByKind(model, 'disclosure');
  let best = null;
  let bestScore = 0;
  for (const f of pool) {
    const s = overlap(want, labelTokens(f));   // any-language trigger label
    if (s > bestScore) { bestScore = s; best = f; }
  }
  if (!best) return null;
  const layer = best.reveals ? model.layers?.[best.reveals] ?? null : null;
  return { trigger: best, layer, close: layer?.close ?? null };
}

/** Structured goals (composed elsewhere; here just the local goals). */
export function goals(model) {
  return Object.values(model?.goals || {});
}

// ─── Internals ──────────────────────────────────────────────────────────────

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length > 1);
}

function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  let n = 0;
  for (const t of a) if (set.has(t)) n++;
  return n;
}

// v2.74.447 — Language-agnostic label tokens: the primary label PLUS every harvested
// locale label (labelsByLocale, from the cross-locale alignment). So a role/intent in
// ANY language matches — "Suche" hits a feature whose primary label is "Search".
function labelTokens(f) {
  const toks = tokens(f && f.label);
  const byLoc = f && f.labelsByLocale;
  if (byLoc) {
    const seen = new Set(toks);
    for (const lbl of Object.values(byLoc)) {
      for (const t of tokens(lbl)) if (!seen.has(t)) { seen.add(t); toks.push(t); }
    }
  }
  return toks;
}

// Map role-name hints → the kind we'd expect to fill them. Role names are
// head-final English compounds ("search-SUBMIT", "collection-CARD", "result-ITEM"),
// so the LAST token decides the kind; earlier tokens are qualifiers. We check the
// head token first, then fall back to any token. (Without head-first, "search-
// submit" would match input on "search" before action on "submit".)
const KIND_HINTS = Object.freeze({
  input:      ['input', 'field', 'box', 'search', 'query', 'textarea', 'email', 'password', 'textbox', 'combobox', 'searchbox'],
  action:     ['submit', 'button', 'btn', 'action', 'cta', 'go', 'apply', 'confirm', 'add', 'buy', 'signin', 'login'],
  navigation: ['link', 'nav', 'menuitem', 'breadcrumb', 'tab'],
  collection: ['card', 'tile', 'item', 'result', 'cell', 'row', 'product', 'listing', 'thumb', 'gallery', 'collection', 'grid'],
  disclosure: ['dropdown', 'menu', 'filter', 'expand', 'disclosure', 'accordion', 'toggle', 'flyout', 'popover', 'more'],
  region:     ['header', 'footer', 'sidebar', 'region', 'section', 'banner', 'main', 'aside'],
});
function kindAffinityForRole(role) {
  const toks = tokens(role);
  if (!toks.length) return null;
  const head = toks[toks.length - 1];                       // head-final: the last token is the noun
  for (const [kind, hints] of Object.entries(KIND_HINTS)) if (hints.includes(head)) return kind;
  for (const t of toks) for (const [kind, hints] of Object.entries(KIND_HINTS)) if (hints.includes(t)) return kind;
  return null;
}

function matchScore(wantTokens, affinity, f) {
  let score = 0;
  score += overlap(wantTokens, labelTokens(f)) * 2;        // label match is strong (any language)
  score += overlap(wantTokens, tokens(f.a11yRole || '')); // a11y role token
  score += overlap(wantTokens, tokens(f.kind));            // literal kind word in the role name
  if (affinity && f.kind === affinity) score += 1.5;       // kind affinity bonus
  // A bare affinity match (no token overlap) still surfaces a candidate, weakly.
  if (score === 0 && affinity && f.kind === affinity) score = 0.5;
  return score;
}

function round2(n) { return Math.round(n * 100) / 100; }

/** Stable, order-independent hash of the feature id set (drift detection). */
export function driftHash(features) {
  const ids = Object.keys(features || {}).sort();
  let h = 5381;
  const s = ids.join('|');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * EX-4 (Win C) — drift hash computed directly from a RAW enumerate feature LIST
 * (the array `enumeratePage` returns), identical to what
 * `buildLocale(rawFeatures).coverage.driftHash` stamps. Lets the Explore handler
 * fingerprint a cheap pre-sweep enumerate and compare it against a cached
 * Locale's stored hash WITHOUT building the whole model — the precondition for
 * the freshness short-circuit (skip the poke sweep + LLM goal synthesis when the
 * page's feature id-set is unchanged). Feature ids are content hashes of
 * kind|label|selector, so this is a real change detector, not a count. Mirrors
 * buildLocale's id extraction (valid string `id` only, last-wins dedup) EXACTLY
 * so the pre-check hash and the stamped hash can never diverge.
 */
export function driftHashFromRaw(rawFeatures) {
  const features = {};
  for (const f of Array.isArray(rawFeatures) ? rawFeatures : []) {
    if (f && typeof f.id === 'string' && f.id) features[f.id] = f;
  }
  return driftHash(features);
}

/**
 * EX-5 (critic #4) — score how TRUSTWORTHY a freshly-built Locale is to author
 * capabilities from, PURELY from already-captured data (no LLM, no DOM). The
 * auto-explore orchestrator (EX-6) gates on this so an UNATTENDED run never mints
 * capabilities at scale from a page that was half-explored, truncated, aborted,
 * or barely enumerated (the failure the critic flagged: `aborted` is recorded but
 * never gates; null goals are swallowed silently).
 *
 * Inputs (both optional; degrades gracefully):
 *   model      — the built Locale (reads coverage.{capped,fidelity,featureCount},
 *                features, goals)
 *   structure  — the sweep artifact (reads stats.{aborted,candidates,controlsTried})
 *
 * Returns { score:0..1, tier:'trusted'|'partial'|'untrusted', safeToAuthor:boolean,
 *           reasons:[{code,severity,detail}], signals:{…} }. Deterministic.
 * `safeToAuthor` is the gate: false only for 'untrusted' — 'partial' is allowed
 * but the reasons say why, so a caller can choose to be stricter.
 */
export function localeTrust(model, structure = null) {
  if (!model || typeof model !== 'object') {
    return {
      score: 0, tier: 'untrusted', safeToAuthor: false,
      reasons: [{ code: 'no-model', severity: 'fatal', detail: 'no Locale model' }],
      signals: { featureCount: 0, goalCount: 0, fidelity: 'L0', capped: false, aborted: null, candidates: null, controlsTried: null },
    };
  }
  const cov = model.coverage || {};
  const stats = (structure && structure.stats) || {};
  const featureCount = Number.isFinite(cov.featureCount) ? cov.featureCount : Object.keys(model.features || {}).length;
  const goalCount = Object.keys(model.goals || {}).length;
  const fidelity = cov.fidelity || 'L0';
  const capped = !!cov.capped;
  const aborted = stats.aborted || null;

  const reasons = [];
  let score = 1;
  const penalize = (amount, code, severity, detail) => { score -= amount; reasons.push({ code, severity, detail }); };

  if (aborted)          penalize(0.5, 'sweep-aborted',   'high',   `depth sweep aborted (${aborted}) — page only partially explored`);
  if (capped)           penalize(0.3, 'enumerate-capped','high',   'enumeration hit the feature cap — catalog is truncated');
  if (featureCount < 3) penalize(0.4, 'too-few-features','high',   `only ${featureCount} feature(s) enumerated — page may be blank/loading/error`);
  if (goalCount === 0)  penalize(0.3, 'no-goals',        'medium', 'no goals synthesized — nothing for authoring to target');
  if (fidelity === 'L0')penalize(0.1, 'no-depth',        'low',    'fidelity L0 — no disclosure depth explored (flat page or sweep skipped)');

  score = Math.max(0, Math.min(1, round2(score)));
  const tier = score >= 0.7 ? 'trusted' : score >= 0.4 ? 'partial' : 'untrusted';
  return {
    score, tier, safeToAuthor: tier !== 'untrusted', reasons,
    signals: { featureCount, goalCount, fidelity, capped, aborted, candidates: stats.candidates ?? null, controlsTried: stats.controlsTried ?? null },
  };
}

function hashId(s) {
  const str = String(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function selectorTier(sel) {
  if (!sel) return 'positional';
  if (/(^|\s|>)#[A-Za-z]/.test(sel)) return 'id';
  if (/\[data-/.test(sel)) return 'data';
  if (/\[aria-|\[role=/.test(sel)) return 'aria';
  if (/:nth-|:first-|:last-|>\s|\+\s|~\s/.test(sel)) return 'positional';
  if (/\./.test(sel)) return 'class';
  return 'semantic';
}

// ─── L1 depth (PAGEMODEL_SPEC § 4, § 8) ─────────────────────────────────────────

/**
 * v2.74.404 — Merge the pageStructure poke→reveal sweep into the model as Layer
 * nodes, WITHOUT re-poking (the Explore sweep already captured what each
 * disclosure reveals). Each control with `observation:'reveal'` + revealed
 * children becomes a `disclosure` trigger whose `reveals` points at a Layer
 * holding those revealed features (tagged `hidden` + `revealedBy`). Pure — runs
 * over the cached `structure.controls`. Upgrades the model to fidelity L1.
 *
 * Control shape (from contentScript explore): { selector, role, label, haspopup,
 *   observation, overlay, revealed:[{selector, role, label}] }.
 */
export function mergeDepthFromControls(model, controls) {
  if (!model || !model.features || !Array.isArray(controls)) return model;
  const features = model.features;
  const layers = model.layers || (model.layers = {});
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // Index existing CONTROL-ish features (so a poked control maps to its L0 entry).
  const bySelector = new Map();
  const byLabel = new Map();
  for (const f of Object.values(features)) {
    if (f.kind === 'collection' || f.kind === 'region') continue;
    if (f.selector && !bySelector.has(f.selector)) bySelector.set(f.selector, f);
    const k = norm(f.label);
    if (k && !byLabel.has(k)) byLabel.set(k, f);
  }
  // v2.74.428 — Type a revealed child by its role/tagName. The poke snapshot
  // reports tagNames ("input", "a") as well as ARIA roles ("textbox", "link"), so
  // match both — otherwise modal inputs/links fell through to 'action' (a password
  // field typed 'action' won't rank for an '…-input' role). Mirrors how L0
  // enumeration types these kinds.
  const revealKindOf = (role) => {
    const r = String(role || '').toLowerCase().trim();
    if (/textbox|combobox|searchbox|textarea|(^|[^a-z])input([^a-z]|$)/.test(r)) return 'input';
    if (/(^|[^a-z])(a|link)([^a-z]|$)/.test(r)) return 'navigation';
    return 'action';
  };

  for (const c of controls) {
    if (!c || c.observation !== 'reveal' || !Array.isArray(c.revealed) || !c.revealed.length) continue;
    // v2.74.406 — Skip CONTENT-SWAP false disclosures: a non-overlay "reveal" that
    // surfaces only 1 new element is almost always a carousel advance / tab swap
    // (e.g. a next/prev arrow whose "revealed" child is just the next slide), not a
    // menu/panel disclosure. Real disclosures are overlays or reveal several items.
    if (!c.overlay && c.revealed.length < 2) continue;
    // Find the disclosure feature this control corresponds to (selector, then label).
    let trigger = (c.selector && bySelector.get(c.selector)) || (c.label && byLabel.get(norm(c.label))) || null;
    if (trigger) {
      trigger.kind = 'disclosure';
      trigger.interaction = { pattern: 'click', effect: 'reveal' };
      trigger.selectorVerified = true;
      trigger.evidence = { ...(trigger.evidence || {}), method: 'poke' };
    } else {
      const tid = hashId('disc|' + (c.role || '') + '|' + (c.label || '') + '|' + (c.selector || ''));
      trigger = {
        id: tid, kind: 'disclosure', label: (c.label || '').toString().slice(0, 80), a11yRole: c.role || null,
        selector: c.selector || '', selectorKind: selectorTier(c.selector), selectorVerified: true,
        location: null, interaction: { pattern: 'click', effect: 'reveal' },
        confidence: 0.7, evidence: { method: 'poke', observedAt: Date.now() },
      };
      features[tid] = trigger;
    }

    const layerId = 'layer_' + trigger.id;
    const overlay = !!c.overlay;
    const layer = { id: layerId, kind: overlay ? 'modal' : 'dropdown', openedBy: trigger.id, overlay, features: [], close: null };
    for (const rv of c.revealed.slice(0, 30)) {
      if (!rv || !rv.selector) continue;
      const cid = hashId('revealed|' + (rv.role || '') + '|' + (rv.label || '') + '|' + rv.selector);
      if (!features[cid]) {
        const kind = revealKindOf(rv.role);
        // SG-0.5-F3 (v2.74.638) — a revealed ACTION whose label is a COMMIT word (Update/Apply/Done/Save)
        // IS the panel's commit; capture it as effect:'submit', not 'none'. The reveal pass was typing every
        // non-nav revealed control 'none', so a filter dropdown's "Update" looked like a plain click — the
        // filter goal had no submit (goalHasSubmit=false) and goal-grounded binding dropped the commit, so a
        // filter trial opened + selected but never APPLIED. Reset/Clear aren't submit words → stay 'none'.
        const revEffect = kind === 'navigation' ? 'navigate' : (kind === 'action' && _isSubmitLabel(rv.label) ? 'submit' : 'none');
        features[cid] = {
          id: cid, kind,
          label: (rv.label || '').toString().slice(0, 80), a11yRole: rv.role || null,
          selector: rv.selector, selectorKind: selectorTier(rv.selector), selectorVerified: true,
          hidden: true, revealedBy: trigger.id,
          interaction: { pattern: kind === 'input' ? 'type' : 'click', effect: revEffect },
          confidence: 0.7, evidence: { method: 'poke', observedAt: Date.now() },
        };
      }
      if (!layer.features.includes(cid)) layer.features.push(cid);
    }
    if (layer.features.length) {
      layers[layerId] = layer;
      trigger.reveals = layerId;
    }
  }

  dedupeOverlayLayers(model);
  model.index = buildIndex(model.features);
  if (model.coverage) model.coverage.fidelity = 'L1';
  return model;
}

/**
 * v2.74.407 — Consolidate OVERLAY layers that are really the same overlay opened
 * from several triggers (e.g. Pixabay's auth modal reached via Log in / Join /
 * Upload, each capturing a different tab → login vs signup fields). Merge layers
 * that share members (by selector) into one, union their features, and repoint
 * every trigger's `reveals` at the survivor — so 3 layers collapse to 1 richer
 * layer that all 3 triggers open. Only OVERLAY layers (modals) are considered;
 * in-place dropdowns are trigger-specific and left alone.
 */
export function dedupeOverlayLayers(model) {
  if (!model || !model.layers || !model.features) return model;
  const layers = model.layers;
  const ids = Object.keys(layers).filter((id) => id !== 'surface' && layers[id].overlay);
  const selSet = (layer) => new Set((layer.features || []).map((fid) => model.features[fid]?.selector).filter(Boolean));
  const kept = [];
  for (const id of ids) {
    const layer = layers[id];
    const sig = selSet(layer);
    let target = null;
    for (const k of kept) {
      const ksig = selSet(layers[k]);
      let inter = 0;
      for (const s of sig) if (ksig.has(s)) inter++;
      const minSize = Math.min(sig.size, ksig.size) || 1;
      if (inter >= 3 || inter / minSize >= 0.5) { target = k; break; }   // same overlay
    }
    if (target) {
      const kl = layers[target];
      const kSel = new Set(kl.features.map((fid) => model.features[fid]?.selector));
      for (const fid of layer.features) {
        const sel = model.features[fid]?.selector;
        if (sel && !kSel.has(sel)) { kl.features.push(fid); kSel.add(sel); }
      }
      if (layer.openedBy && model.features[layer.openedBy]) model.features[layer.openedBy].reveals = target;
      // re-point the hidden children's revealedBy stays valid (they keep their own trigger);
      delete layers[id];
    } else {
      kept.push(id);
    }
  }
  // Orphan cleanup: drop hidden features no surviving layer references.
  const ref = new Set();
  for (const lid of Object.keys(layers)) for (const fid of layers[lid].features) ref.add(fid);
  for (const fid of Object.keys(model.features)) {
    const f = model.features[fid];
    if (f && f.hidden && !ref.has(fid)) delete model.features[fid];
  }
  return model;
}

/**
 * v2.74.408 — L2: attach synthesized Goals (PAGEMODEL_SPEC § 5). Each raw goal
 * carries { label, description, achievableVia:[featureId] }; this assigns a stable
 * id, drops dangling feature refs, backlinks `feature.goals`, rebuilds the index
 * (so `byGoal` populates), and upgrades fidelity to L2. Pure.
 */
export function attachGoals(model, goals) {
  if (!model || !model.features || !Array.isArray(goals)) return model;
  model.goals = model.goals || {};
  for (const g of goals) {
    if (!g || !g.label) continue;
    const via = (Array.isArray(g.achievableVia) ? g.achievableVia : []).filter((fid) => model.features[fid]);
    const id = 'goal_' + hashId(g.label + '|' + via.join(','));
    model.goals[id] = {
      id, label: String(g.label).slice(0, 60),
      description: g.description ? String(g.description).slice(0, 200) : '',
      achievableVia: via,
      confidence: typeof g.confidence === 'number' ? g.confidence : 0.6,
    };
    for (const fid of via) {
      const f = model.features[fid];
      f.goals = f.goals || [];
      if (!f.goals.includes(id)) f.goals.push(id);
    }
  }
  model.index = buildIndex(model.features);
  if (model.coverage && Object.keys(model.goals).length) model.coverage.fidelity = 'L2';
  return model;
}

/**
 * SG-0.5-F1 — derive a GOAL per DISCLOSURE-UNIT (a dropdown/menu/filter + the options it reveals). PURE.
 *
 * The LLM L2 pass (AnthropicService.synthesizeGoals) mis-models filter panels two ways: it LUMPS many
 * filter dropdowns into one coarse "filter jobs" goal (the 3-8 goal cap), and it references the dropdown
 * TRIGGERS, not the options inside them — so a filter goal ends up shared across filters AND missing its
 * own options + commit (the live Indeed pay-filter goal = 7 dropdown disclosures, no brackets, no Update).
 *
 * But the reveal pass already captured the structure deterministically: a disclosure's `reveals` points at
 * a Layer whose `features` ARE the revealed options (each `hidden`, `revealedBy` = the disclosure). This
 * walks that structure to emit ONE clean, complete goal per disclosure-unit — achievableVia = the
 * disclosure + its actionable revealed options (inputs/actions, incl. an in-panel Update/Apply). The caller
 * merges these into model.goals ALONGSIDE the LLM goals (via attachGoals), giving Select/bind a fine-grained
 * "filter by pay" / "filter by date" goal to resolve to instead of the coarse lump.
 *
 * @param {object} model  a Locale with features + layers (post L1 reveal).
 * @returns {Array<{label:string, description:string, achievableVia:string[]}>}
 */
export function deriveDisclosureGoals(model) {
  if (!model || !model.features || typeof model.features !== 'object') return [];
  const feats = model.features;
  const layers = (model.layers && typeof model.layers === 'object') ? model.layers : {};
  const out = [];
  for (const f of Object.values(feats)) {
    if (!f || f.kind !== 'disclosure' || !f.selector || !f.reveals) continue;
    const label = (f.label && String(f.label).trim()) || '';
    if (!label) continue;                                  // an unlabelled dropdown makes no useful goal
    const layer = layers[f.reveals];
    const childIds = (layer && Array.isArray(layer.features)) ? layer.features : [];
    // The actionable options the dropdown reveals — inputs or clickable actions (incl. an in-panel
    // Update/Apply). Content regions / non-actionable reveals are not part of the operable goal.
    const options = childIds.filter((cid) => { const c = feats[cid]; return c && c.selector && c.decoy !== true && (c.kind === 'input' || c.kind === 'action'); });
    if (!options.length) continue;                         // reveals nothing to act on → not a filter/menu goal
    out.push({
      label: label.slice(0, 60),
      description: `Open "${label}" and choose from its options`.slice(0, 200),
      achievableVia: [f.id, ...options],
    });
  }
  return out;
}

// ─── Composites (PAGEMODEL_SPEC § 3 `parts` / the within-Locale `partOf` edge) ──────
// A composite Feature groups controls that act as ONE capability — the canonical case is a
// search box (input + submit) or a form (≥2 inputs + submit). The page model doesn't emit
// composites directly, so we DERIVE them conservatively from the enumerated features: within
// a spatial group (a depth layer, else a scroll band), pair input(s) with a nearby submit
// control. Conservative on purpose — only a labelled submit (or, for multi-field forms, any
// nearby action) forms a composite, so we don't fabricate spurious groupings. PURE.

// SG-2/PROVISIONAL (DESIGN_substrate_grounded_capabilities §4.6) — identifying the
// success action by label words is a SEMANTIC verdict; Select (LLM) is the authority
// and picks it from the captured {kind,label,effect} facts. This lexical set is the
// no-LLM DEFAULT for composite derivation only; do NOT extend per-site.
const _SUBMIT_WORDS = new Set([
  'go', 'search', 'submit', 'apply', 'find', 'send', 'subscribe', 'save', 'update',
  'continue', 'next', 'signin', 'login', 'signup', 'register', 'ok', 'enter', 'add',
]);
function _isSubmitLabel(label) {
  const toks = tokens(label);
  return toks.some((t) => _SUBMIT_WORDS.has(t));
}
/** Centre-distance proximity; missing geometry (e.g. modal features) trusts group membership. */
function _near(a, b, maxPx) {
  const ra = a && a.location && a.location.absRect, rb = b && b.location && b.location.absRect;
  if (!ra || !rb) return true;
  const dx = (ra.x + (ra.w || 0) / 2) - (rb.x + (rb.w || 0) / 2);
  const dy = (ra.y + (ra.h || 0) / 2) - (rb.y + (rb.h || 0) / 2);
  return Math.hypot(dx, dy) <= maxPx;
}

/** Spatial groups to look for composites in: each non-surface layer, plus surface features by band. */
function _compositeGroups(model) {
  const features = model.features || {};
  const layers = model.layers || {};
  const groups = [];
  for (const lid of Object.keys(layers)) {
    if (lid === 'surface') continue;
    groups.push((layers[lid].features || []).map((fid) => features[fid]).filter(Boolean));
  }
  const surface = (layers.surface && layers.surface.features ? layers.surface.features : [])
    .map((fid) => features[fid]).filter(Boolean);
  const byBand = new Map();
  for (const f of surface) {
    const b = f.location && f.location.band;
    if (b == null) continue;
    if (!byBand.has(b)) byBand.set(b, []);
    byBand.get(b).push(f);
  }
  for (const arr of byBand.values()) groups.push(arr);
  return groups;
}

/**
 * v2.74.495 — Derive composite Features (input(s) + submit) and attach them with `parts`,
 * so the within-Locale `partOf` edge is real (localeEdges emits it). Conservative: a labelled
 * submit forms a composite with the inputs near it; a multi-input group forms one with any
 * nearby action. Idempotent (composite id is a stable hash of its sorted parts). Rebuilds the
 * index. PURE.
 *
 * @param {object} model  a Locale (post enumerate / depth merge)
 * @param {{maxPx?:number}} [opts]  proximity radius in absolute px (default 280)
 */
export function attachComposites(model, { maxPx = 280 } = {}) {
  if (!model || !model.features) return model;
  const features = model.features;
  for (const group of _compositeGroups(model)) {
    const inputs = group.filter((f) => f.kind === 'input');
    if (!inputs.length) continue;
    const acts = group.filter((f) => f.kind === 'action');
    if (!acts.length) continue;
    // Pick the submit — a GENUINE submit only: an action the form oracle tagged
    // effect:'submit', or one with a submit-word label, near an input. v2.74.563 —
    // we no longer fall back to "any nearby action" for multi-input groups: that
    // mis-paired a form's inputs with an unrelated toggle (e.g. "View Job
    // Description") whenever the real submit hadn't been captured. Now that the
    // form pass captures the default-submit <button> (effect:'submit'), the correct
    // action is available and the loose fallback is pure risk.
    const _isSubmitAct = (a) => (a.interaction && a.interaction.effect === 'submit') || _isSubmitLabel(a.label);
    const submit = acts.find((a) => _isSubmitAct(a) && inputs.some((i) => _near(i, a, maxPx)));
    if (!submit) continue;
    const partInputs = inputs.filter((i) => _near(i, submit, maxPx));
    if (!partInputs.length) continue;
    const parts = [...partInputs.map((i) => i.id), submit.id];
    const id = 'composite_' + hashId(parts.slice().sort().join(','));
    if (features[id]) continue;   // idempotent
    const label = (partInputs.length >= 2
      ? `${submit.label || 'Submit'} form`
      : (partInputs[0].label || submit.label || 'form')).toString().slice(0, 60);
    features[id] = {
      id, kind: 'composite', label, a11yRole: 'group',
      selector: null, parts,
      location: partInputs[0].location || submit.location || null,
      confidence: 0.5,
      synthesized: true,
      evidence: { method: 'derived', observedAt: Date.now() },
    };
  }
  model.index = buildIndex(model.features);
  return model;
}

// ─── Graph edges (PAGEMODEL_SPEC § 1) ───────────────────────────────────────────
// A Locale is conceptually "a small graph" — Feature / Layer / Goal nodes joined by
// typed edges. Storage keeps those edges DENORMALIZED as fields on the nodes they
// leave (`disclosure.reveals`, `layer.features`, `collection.members`, `feature.goals`,
// `navigation.href`), which is cheap to write but means every consumer re-walks a
// different field by hand. These functions MATERIALIZE the unified typed edge set so
// downstream can traverse the graph directly (studio viz, goal→control path-finding,
// the future composite/workflow layer) — the § 7 "query it, don't walk it" contract,
// extended from per-kind lookups (byKind/byGoal/triggers) to full graph traversal.
//
// Computed on demand (not stored on the model): the edge set is a projection of the
// node fields, and those fields mutate across build slices (mergeDepthFromControls,
// attachGoals); deriving lazily keeps a single source of truth. PURE.

/**
 * Same-origin test for a `leadsTo` destination, resolving relative hrefs against the
 * Locale's own URL. Defensive: malformed/empty URLs are treated as not-same-origin
 * rather than throwing.
 */
function _sameOrigin(base, href) {
  try { return new URL(href, base || undefined).origin === new URL(base).origin; }
  catch { return false; }
}

/**
 * Materialize the Locale's typed edge set (PAGEMODEL_SPEC § 1).
 *
 * Edge kinds emitted (each edge: { from, to, kind, ...payload }):
 *   - `reveals`  disclosure feature → the layer it opens (to = layerId)
 *   - `contains` layer → each member feature (to = featureId); AND
 *                collection feature → its repeating members (to = null, `members` payload —
 *                members are a {itemSelector,count} descriptor, not first-class nodes)
 *   - `enables`  feature → a goal it helps achieve (to = goalId)
 *   - `leadsTo`  navigation feature → its destination URL (to = url, `sameOrigin` payload;
 *                also surfaced as a GROUND.siteMap edge — § 1)
 *   - `partOf`   composite feature → each of its part features (to = featureId) — the
 *                within-Locale composite flow (e.g. a search box → its input + submit),
 *                derived by attachComposites. Cross-Locale flows live ABOVE the Locale
 *                (Workflows, Core/workflows.js).
 *
 * @param {object} model  a Locale
 * @returns {Array<{from:string, to:(string|null), kind:string}>}
 */
export function localeEdges(model) {
  const edges = [];
  if (!model) return edges;
  const features = model.features || {};
  const layers = model.layers || {};
  const goals = model.goals || {};
  const base = model.url || model.urlPattern || '';

  // reveals: disclosure → layer (only when the target layer actually exists)
  for (const f of Object.values(features)) {
    if (f && f.kind === 'disclosure' && f.reveals && layers[f.reveals]) {
      edges.push({ from: f.id, to: f.reveals, kind: 'reveals' });
    }
  }

  // contains: layer → member feature (the surface layer included)
  for (const layer of Object.values(layers)) {
    if (!layer || !Array.isArray(layer.features)) continue;
    for (const fid of layer.features) {
      if (features[fid]) edges.push({ from: layer.id, to: fid, kind: 'contains' });
    }
  }
  // contains: collection → its repeating members (descriptor, not nodes)
  for (const f of Object.values(features)) {
    if (f && f.kind === 'collection' && f.members && f.members.itemSelector) {
      edges.push({
        from: f.id, to: null, kind: 'contains',
        members: { itemSelector: f.members.itemSelector, count: f.members.count ?? null },
      });
    }
  }

  // enables: feature → goal (iterate the feature side so dangling refs are dropped)
  for (const f of Object.values(features)) {
    if (!f || !Array.isArray(f.goals)) continue;
    for (const gid of f.goals) if (goals[gid]) edges.push({ from: f.id, to: gid, kind: 'enables' });
  }

  // leadsTo: navigation → destination URL (the Locale-local half of the siteMap edge)
  for (const f of Object.values(features)) {
    if (f && f.kind === 'navigation' && f.href) {
      edges.push({ from: f.id, to: f.href, kind: 'leadsTo', sameOrigin: _sameOrigin(base, f.href) });
    }
  }

  // partOf: composite → each part feature (within-Locale composite flow; attachComposites)
  for (const f of Object.values(features)) {
    if (f && f.kind === 'composite' && Array.isArray(f.parts)) {
      for (const pid of f.parts) if (features[pid]) edges.push({ from: f.id, to: pid, kind: 'partOf' });
    }
  }

  return edges;
}

/** Edges leaving a node id (feature or layer). Pass precomputed `edges` to avoid recompute. */
export function edgesFrom(model, nodeId, edges = null) {
  return (edges || localeEdges(model)).filter((e) => e.from === nodeId);
}

/** Edges entering a node id (feature, layer, goal, or URL). Pass precomputed `edges` to avoid recompute. */
export function edgesTo(model, nodeId, edges = null) {
  return (edges || localeEdges(model)).filter((e) => e.to === nodeId);
}

/** All edges of one kind. Pass precomputed `edges` to avoid recompute. */
export function edgesByKind(model, kind, edges = null) {
  return (edges || localeEdges(model)).filter((e) => e.kind === kind);
}

/**
 * The realizable-goal traversal: for a goal, the ordered control plan that accounts
 * for DEPTH — a feature hidden behind a disclosure needs its trigger CLICKED first.
 * Returns `{ goalId, label, steps }` where each step is a featureId plus, when that
 * feature is `hidden`, the `revealedBy` trigger that must precede it. This is the
 * graph traversal capabilitySynth's flat fills-before-acts ordering can't do on its
 * own — it threads goal → enables⁻¹ → (reveals trigger) → feature. Pure.
 *
 * @returns {{ goalId:string, label:string, steps:Array<{featureId:string, trigger:(string|null), hidden:boolean}> }|null}
 */
export function pathToGoal(model, goalId) {
  const goal = model?.goals?.[goalId];
  if (!goal) return null;
  const features = model.features || {};
  const steps = [];
  for (const fid of Array.isArray(goal.achievableVia) ? goal.achievableVia : []) {
    const f = features[fid];
    if (!f) continue;
    const hidden = !!f.hidden;
    const trigger = hidden && f.revealedBy && features[f.revealedBy] ? f.revealedBy : null;
    steps.push({ featureId: fid, trigger, hidden });
  }
  return { goalId, label: goal.label || '', steps };
}
