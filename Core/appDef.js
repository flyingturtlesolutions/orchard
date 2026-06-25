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
export const ARCHETYPES = ['operator', 'monitor', 'executor'];   // the RUN-shape (how it works); see APP_TYPES for the OBJECT-model
export const SOURCES = ['builtin', 'user', 'shared'];
// OM (object-model) — the abstract, friendly catalog TYPES (what the app works ON), orthogonal to the archetype
// (how it runs). 'inbox' = a queue of stateful objects (emails, tickets); 'watcher' = a stream of signals to flag;
// 'concierge' = a goal taken to the finish line. The 6 named apps are PRESETS that specialize a type.
export const APP_TYPES = ['inbox', 'watcher', 'concierge'];
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

/**
 * Normalize an app's OBJECT MODEL (OM) — what the app works ON. PURE. Needs a `noun` (else null). Shape:
 *   { noun, plural, states[], actions[], transitions:[{verb,to}] }
 * `states` are the lifecycle + the queue's views (e.g. open / pending / closed); `actions` operate on an item
 * WITHOUT changing state (read, reply, draft); each `transition` is a verb → target state, so a POSTCONDITION is
 * derivable for free ("after `close`, the <noun> is `closed`") — which the trial gate can verify. Lists are
 * trimmed, de-duped, capped.
 */
export function normalizeObjectModel(om) {
  const m = (om && typeof om === 'object') ? om : null;
  if (!m) return null;
  const noun = _str(m.noun);
  if (!noun) return null;
  const list = (a) => (Array.isArray(a) ? [...new Set(a.map(_str).filter(Boolean))] : []).slice(0, 16);
  const transitions = (Array.isArray(m.transitions) ? m.transitions : [])
    .map((t) => { const verb = _str(t && t.verb); const to = _str(t && t.to); return (verb && to) ? { verb, to } : null; })
    .filter(Boolean).slice(0, 16);
  return { noun, plural: _str(m.plural) || `${noun}s`, states: list(m.states), actions: list(m.actions), transitions };
}

/**
 * Render an object model as a compact, prompt-ready DATA block — the app's schema (what it works on) for the LLM's
 * context. PURE. '' when there's no usable model. So the reasoner knows the exact state vocabulary ("mark it
 * 'pending'") and which verbs change state (→ postconditions). The live wiring fences this as inert DATA.
 */
export function describeObjectModel(om) {
  const m = normalizeObjectModel(om);
  if (!m) return '';
  const parts = [`Objects: ${m.plural} (each one a "${m.noun}").`];
  if (m.states.length) parts.push(`States (also the views): ${m.states.join(' · ')}.`);
  if (m.actions.length) parts.push(`Actions (no state change): ${m.actions.join(' · ')}.`);
  if (m.transitions.length) parts.push(`State changes: ${m.transitions.map((t) => `${t.verb} → ${t.to}`).join(' · ')}.`);
  return parts.join('\n');
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
    // OM (v2.74.1198) — the abstract object-model TYPE ('inbox'|'watcher'|'concierge') + the object model it works
    // on. A preset specializes a type by binding the noun/states; null on a plain user app (learned at runtime).
    type: APP_TYPES.includes(d.type) ? d.type : null,
    objectModel: normalizeObjectModel(d.objectModel),
    // CV-5b (v2.74.1183) — role-specific STARTER asks shown in the app's empty state (the gallery passes the def
    // straight to _createAppConversation, so these render without threading through the conversation record). PURE:
    // trim, drop blanks, cap at 4 so a malformed catalog entry can't flood the UI.
    starters: Array.isArray(d.starters) ? d.starters.map(_str).filter(Boolean).slice(0, 4) : [],
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

// Classifiers over a conversation record. PURE. CV-4 (v2.74.1171) — recognize BOTH the pure schema form (kind:'app')
// AND the live-stored form: ConversationStore coerces kind:'app'→'agent' (apps are identified by `appId`, not kind),
// so classify by parentId/appId, not kind. A sub-task is anything with a parentId; an app has an appId (or kind:'app')
// and no parent. Backward-compatible with the CV-1 kind:'app' fixtures.
export const isOverview = (conv) => !!conv && conv.id === OVERVIEW_ID;
export const isSubTask  = (conv) => !!conv && !!_str(conv.parentId);
export const isApp      = (conv) => !!conv && !isOverview(conv) && !_str(conv.parentId) && (conv.kind === 'app' || !!_str(conv.appId));
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

/**
 * Fan-out (CV-4, §6): project a list of item labels into sub-task conversation specs under `app`. PURE. Each item
 * → `subTaskFromApp(app, "<framed item>")` with the item as the title; dedupes case-insensitively. Returns [] when
 * `app` is not a valid parent (the one-level cap — a sub-task can't fan out) or there are no items.
 */
export function planSubTasks(app, items) {
  if (!isApp(app)) return [];
  const list = (Array.isArray(items) ? items : []).map(_str).filter(Boolean);
  const seen = new Set();
  const specs = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const spec = subTaskFromApp(app, `This sub-task handles: ${item}. Apply the app's instructions to this specific item.`);
    if (spec) specs.push({ ...spec, title: item.slice(0, 60) });
  }
  return specs;
}

/** The reserved Overview conversation-extension fields. PURE. Fixed id, agent kind, system-default seed (null). */
export function overviewShape() {
  return { id: OVERVIEW_ID, kind: 'agent', title: 'Overview', seed: null };
}
