// Core/appDef.js — conversations-as-apps: the AppDefinition + app / sub-task shapes (DESIGN_conversations.md §5). CV-1.
// v2.74.1161.
//
// PURE: no chrome / DOM / LLM / storage. This slice is the schema + the pure transforms:
//   • normalizeAppDefinition — validate/normalize a catalog entry
//   • appFromDefinition       — copy-on-add: definition → the new app's conversation-extension fields (decision #4)
//   • subTaskFromApp          — a child conversation under an app: parentId + seed composition + inherited config
//   • composeSeed             — a sub-task's effective seed = app seed ∘ sub-task seed (§6)
//   • normalizeConfig / tightenConfig — the tighten-only config floor (§8): a child may only NARROW, never loosen
//   • the reserved Overview (fixed id, undeletable) + isOverview/isApp/isSubTask/canDelete classifiers
// The live wiring (ConversationStore records, the IL context thread CV-2, the drawer accordion CV-3) is later slices.
//
// One-level cap (decision #9): depth is exactly Overview → app → sub-task. A sub-task is a LEAF — `subTaskFromApp`
// refuses a parent that is itself a sub-task (or the Overview), so sub-sub-tasks can't be minted.

const _str = (x) => (typeof x === 'string' ? x.trim() : '');

export const OVERVIEW_ID = 'overview';                 // the reserved, undeletable general-assistant conversation
export const ARCHETYPES = ['operator', 'monitor', 'executor'];
export const SOURCES = ['builtin', 'user', 'shared'];
export const WRITE_POLICIES = ['gated', 'never'];      // 'gated' = the default; 'never' = the tightening (read-only)

const _archetype = (a) => (ARCHETYPES.includes(a) ? a : null);
const _source = (s) => (SOURCES.includes(s) ? s : 'user');   // unknown source → treat as untrusted 'user'

/** Normalize an app `config` to the tighten-only shape. PURE. Unknown `writePolicy` → the default 'gated'. */
export function normalizeConfig(config) {
  const c = (config && typeof config === 'object') ? config : {};
  return { writePolicy: WRITE_POLICIES.includes(c.writePolicy) ? c.writePolicy : 'gated' };
}

/** Combine a parent config with a child's — the child may only TIGHTEN, never loosen the floor. PURE. (§8) */
export function tightenConfig(parent, child) {
  const p = normalizeConfig(parent), k = normalizeConfig(child);
  return { writePolicy: (p.writePolicy === 'never' || k.writePolicy === 'never') ? 'never' : 'gated' };
}

/** Validate + normalize an AppDefinition (catalog entry). PURE. Returns the normalized def, or null if unusable. */
export function normalizeAppDefinition(def) {
  const d = (def && typeof def === 'object') ? def : null;
  if (!d) return null;
  const id = _str(d.id);
  const name = _str(d.name);
  const seed = _str(d.seed);
  if (!id || !name || !seed) return null;              // an app needs an id, a name, and a goal seed
  return {
    id, name, seed,
    description: _str(d.description) || null,
    icon: _str(d.icon) || null,
    archetype: _archetype(d.archetype),
    defaultConfig: normalizeConfig(d.defaultConfig),
    version: Number.isFinite(d.version) ? d.version : 1,
    source: _source(d.source),
  };
}

/**
 * Copy-on-add: project an AppDefinition into the conversation-extension fields for a NEW app. PURE.
 * The caller (ConversationStore.create) stamps id + timestamps; this is the app-specific shape only. The `seed`
 * is COPIED so later edits are local + immediate (decision #8); `appVersion` lets a newer builtin offer "re-pull."
 * Returns null on an unusable definition.
 */
export function appFromDefinition(def) {
  const d = normalizeAppDefinition(def);
  if (!d) return null;
  return {
    kind: 'app',
    appId: d.id,
    appVersion: d.version,
    title: d.name,
    icon: d.icon,
    seed: d.seed,
    config: normalizeConfig(d.defaultConfig),
  };
}

// Classifiers over a conversation record. PURE.
export const isOverview = (conv) => !!conv && conv.id === OVERVIEW_ID;
export const isSubTask  = (conv) => !!conv && conv.kind === 'app' && !!_str(conv.parentId);
export const isApp      = (conv) => !!conv && conv.kind === 'app' && !_str(conv.parentId) && !isOverview(conv);
/** The Overview is reserved and cannot be deleted (decision #5 / §2). PURE. */
export const canDelete  = (conv) => !!conv && !isOverview(conv);

/** Compose a sub-task's effective seed: the app's seed (role/policy) ∘ the sub-task's own seed (the item). PURE. (§6) */
export function composeSeed(appSeed, subSeed) {
  return [_str(appSeed), _str(subSeed)].filter(Boolean).join('\n\n');
}

/**
 * Sub-task shape: a child conversation under an app. PURE. Enforces the ONE-LEVEL cap (decision #9) — the parent
 * must be a real app (never a sub-task or the Overview), so sub-sub-tasks can't be minted. Inherits the app's
 * `config` (a child can never be looser) and composes the seed. Returns the conversation-extension fields, or null
 * if `app` is not a valid parent.
 */
export function subTaskFromApp(app, subSeed) {
  const a = (app && typeof app === 'object') ? app : null;
  if (!a || !_str(a.id) || !isApp(a)) return null;     // parent must be a real app, not a sub-task / overview
  return {
    kind: 'app',
    parentId: _str(a.id),
    appId: _str(a.appId) || _str(a.id),
    title: _str(subSeed).slice(0, 60) || 'sub-task',
    config: normalizeConfig(a.config),
    seed: composeSeed(a.seed, subSeed),
  };
}

/** The reserved Overview conversation-extension fields. PURE. Fixed id, agent kind, system-default seed (null). */
export function overviewShape() {
  return { id: OVERVIEW_ID, kind: 'agent', title: 'Overview', seed: null };
}
