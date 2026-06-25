// Core/userCatalog.js — CV-5 (v2.74.1173): user-authored apps (DESIGN_conversations.md §9). PURE.
//
// A "custom app" is a user `AppDefinition` (source:'user') saved to a personal catalog, shown in the gallery under
// "Your apps" and instantiated exactly like a builtin (same shape → `appFromDefinition`). v1 creation path = the
// MVP "promote-a-chat": capture the CURRENT conversation's seed (+ name) into a def. The IL-driven questionnaire +
// IL distillation of a chat into a seed are CV-5-full (the live wiring assembles + persists; this is the schema/
// list math). User defs are UNTRUSTED-authored vs builtins, but the seed is the user's OWN (trusted) — gating is
// unchanged (the seed sets focus, never widens tool access, §6).

import { normalizeAppDefinition } from './appDef.js';

/** Derive a stable, namespaced app id from a name. PURE. Returns '' when the name has no usable characters. */
export function slugifyAppId(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base ? `user-${base}` : '';
}

/**
 * Assemble + normalize a user AppDefinition. PURE. Needs a name (→ id) and a seed (the app's goal). Returns the
 * normalized def (source:'user'), or null if either is missing.
 */
export function userAppDefinition({ name, seed, archetype = null, icon = null, config = null } = {}) {
  const id = slugifyAppId(name);
  if (!id || !String(seed || '').trim()) return null;
  return normalizeAppDefinition({ id, name: String(name).trim(), seed, archetype, icon, defaultConfig: config, version: 1, source: 'user' });
}

/**
 * AP-4 (v2.74.1211) — mint a CONFIGURED, durable app definition from a just-set-up instance. PURE. Unlike
 * `userAppDefinition` (seed only), this carries the instance's TYPE + object model + bound SETUP + its durable
 * per-instance `instanceId` + the `presetId` it specialized — so re-creating it from the gallery restores the SAME
 * app (its learning lives under instanceId) and SKIPS setup. The id is unique per name+site so two configs of one
 * preset don't collide. Returns null without a name/seed.
 */
export function configuredAppDefinition({ name, seed, type = null, objectModel = null, archetype = null, icon = null, config = null, setup = null, presetId = null, instanceId = null } = {}) {
  const base = slugifyAppId(name);
  const host = (setup && setup.target && setup.target.label) ? slugifyAppId(setup.target.label).replace(/^user-/, '') : '';
  const id = base ? (host ? `${base}-${host}` : base) : '';
  if (!id || !String(seed || '').trim()) return null;
  return normalizeAppDefinition({
    id, name: String(name).trim(), seed, type, objectModel, archetype, icon,
    defaultConfig: config, setup, presetId, instanceId, version: 1, source: 'user',
  });
}

/** Add (or REPLACE same-id) a def in the catalog list. PURE — returns a new array, newest last. */
export function addUserDef(list, def) {
  if (!def || !def.id) return Array.isArray(list) ? [...list] : [];
  const kept = (Array.isArray(list) ? list : []).filter((d) => d && d.id !== def.id);
  return [...kept, def];
}

/** Remove a def by id. PURE. */
export function removeUserDef(list, id) {
  const key = String(id || '');
  return (Array.isArray(list) ? list : []).filter((d) => d && d.id !== key);
}

/** Normalize + drop unusable entries from a persisted catalog blob. PURE. */
export function listUserDefs(list) {
  return (Array.isArray(list) ? list : []).map(normalizeAppDefinition).filter(Boolean);
}
