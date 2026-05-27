/**
 * @file Services/StorageManager.js
 * @description Persistent data layer wrapping chrome.storage.local. Manages all
 * structured data for the extension: Grounds and the artifacts authored on
 * them. Provides a clean async/await API so callers never interact with the
 * raw Chrome storage API directly, keeping serialisation, key namespacing,
 * and schema migration concerns contained in a single module.
 *
 * ── ARCHITECTURE: PRIMITIVES AND VOCABULARY ──────────────────────────────
 *
 * The system has two categories of authored artifact, and the distinction
 * is architecturally load-bearing.
 *
 * **Primitives** (invocable artifacts with contracts):
 *
 *   Fragment     — page-state transition; a sequence of DOM actions. Pre/post
 *                  describe page state before and after.
 *   Observation  — page → data; reads page state into named scope bindings.
 *                  Pre/post describe input page state and output binding shape.
 *   Analysis     — data → data; transforms scope bindings (filter / sort /
 *                  template / frontier compose). Pre/post describe input
 *                  binding shape and output binding shape.
 *   Strategy     — orchestrator; composes primitives into a goal-directed
 *                  procedure. Pre/post describe entry page+scope state and
 *                  exit page+scope state. Goal carries semantic intent.
 *
 *   All four primitives share a common contract surface:
 *     name + description (or goal, for strategies) + pre + post + params
 *   The contract is everything composers need. Internals (rawJson actions,
 *   selector + fields, operations array, fragmentSteps tree) are opaque to
 *   composers; they're the primitive's own business.
 *
 *   All four primitives can be authored at tiers (cache vs frontier). Tier
 *   applies both to authoring (was the primitive hand-written or model-
 *   generated?) and to runtime (does it execute deterministically or invoke
 *   a model?). These are dual axes of the same tier system.
 *
 * **Vocabulary** (saved expressions referenced by primitive contracts):
 *
 *   Assertion    — a named condition expression. Body = {match, conditions}
 *                  using the existing condition vocabulary. Assertions are
 *                  pure logical assertions: evaluated at primitive entry/exit
 *                  against scope and/or live page, returning boolean. They
 *                  have name + description + body; they do NOT have pre/post.
 *                  They aren't invoked black-box; they're inlined into other
 *                  artifacts' pre/post envelopes via assertion_ref flattening.
 *
 *   Perspective       — a verified DOM landmark record. Captures "this kind of
 *                  page exists; here are its structural elements" with
 *                  per-landmark verification metadata (matched count, sample
 *                  HTML, when verified, against what URL). Authored once
 *                  with live DOM verification; re-verifiable to detect
 *                  drift. Referenced from primitive contracts via the
 *                  `perspective_ref` condition type. The Ground accumulates
 *                  Perspectives as a DOM lexicon that downstream primitive
 *                  auto-authoring composes from.
 *
 *   Vocabulary differs from primitives in four load-bearing ways:
 *     - Validation: vocabulary is flattened/resolved into containing
 *       primitives at evaluation time; primitives validate stand-alone.
 *     - Composer interface: composers reference vocabulary as building
 *       blocks of contracts, not as artifacts to invoke.
 *     - Lifecycle: vocabulary has authoring tiers (T1 hand-write vs T3
 *       model-write) but no runtime tiers.
 *     - Contract surface: vocabulary has no pre/post; primitives do.
 *
 *   Assertion vs Perspective (distinction within vocabulary):
 *     - Assertion is a logical function (no persistent verification);
 *       evaluated fresh each time against current state. The thing you
 *       reference when you want "this must be true *right now*."
 *     - Perspective is a structural record (persistent verification with
 *       metadata); represents stable page structure. The thing you
 *       reference when you want "this primitive runs on *that kind of
 *       page*."
 *     Both can be referenced from a primitive's pre/post: `perspective_ref`
 *     for "what kind of page" and `assertion_ref` for logical conditions
 *     (often over scope). They compose naturally.
 *
 * **Test for whether a distinction deserves type-system status:** ask
 * whether anything behaves differently across the two sides. Validation,
 * composer interface, lifecycle, code paths. If at least one differs, the
 * distinction is load-bearing and earns a name. If none differ, the
 * distinction is descriptive but not architectural.
 *
 *   Primitive vs vocabulary passes all four (above). Cache vs frontier
 *   tiering passes all four. Pure vs compound strategy (a strategy that
 *   only calls F/O/A vs one that calls other strategies) passes NONE: the
 *   contract is identical, the validation is identical, the composer
 *   reads them uniformly. So we don't name that distinction. The fact
 *   that strategies close under composition (Strategy + Strategy →
 *   Strategy, while F + F → Strategy not Fragment) is structurally
 *   interesting but doesn't surface as a typed property. It will become
 *   relevant when CALL_STRATEGY ships and we need cycle detection in the
 *   strategy call graph — at that point the relevant concept is the
 *   call-graph as a whole, not pure-vs-compound as a per-artifact label.
 *
 * ── STORAGE KEY NAMESPACE ────────────────────────────────────────────────
 *
 *   grounds:<id>             — Ground configuration record
 *   fragments:<id>           — Fragment record (primitive)
 *   observations:<id>        — Observation record (primitive)
 *   analyses:<id>            — Analysis record (primitive)
 *   strategies:<id>          — Strategy record (primitive)
 *   assertions:<id>          — Assertion record (vocabulary; logical assertion)
 *   perspectives:<id>             — Perspective record (vocabulary; verified DOM landmarks)
 *   results:<jobId>          — Test result record
 *   <kind>:index:<groundId>  — Per-Ground index of artifact ids
 *   meta:index               — Master index of Ground ids
 *   meta:results_index       — Ordered list of completed jobIds
 *
 * @module Services/StorageManager
 * @author Agent HUB
 * @version 2.72.28
 */

import { Logger } from '../Core/Logger.js';
import { maybeReadPartition, maybeListPartition } from './Storage/PartitionRead.js';
import {
  maybeWritePartitionPrimary,
  maybeRemovePartitionPrimary,
  maybeClearGroundPartitionPrimary,
} from './Storage/PartitionWrite.js';
// v2.74.332 — PERSPECTIVE_SPEC § 3 Layer 2 composition (nodes + flat mirror).
import { deriveLandmarkNodes, flattenLandmarkNodes } from '../Core/perspectiveComposition.js';
import { normalizeStrategyParams } from './StrategyTree.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const KEY_GROUND_INDEX   = 'meta:index';
const KEY_RESULTS_INDEX  = 'meta:results_index';
const MAX_RESULTS_STORED = 500;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} UrlPattern
 * @property {string}  pattern      - Pattern text (GROUND_SPEC § 3).
 * @property {boolean} isPrimary    - Primary pattern (display + conflict res.).
 * @property {('glob'|'regex'|'template')} [patternKind] - Defaults to 'glob'.
 */

/**
 * Ground — Tier 2 affordance (GROUND_SPEC § 6). The user's automation
 * surface for one site, composing Perspectives.
 *
 * v2.74.325 — Shape aligned to GROUND_SPEC. Legacy mirrors `url` and
 * `aiName` are retained for back-compat readers and `aliases` is kept as a
 * tolerated non-spec extension; both are produced by #normalizeGroundRecord.
 *
 * @typedef {Object} Ground
 * @property {string}        id          - 'gnd_<uid>' for new grounds; legacy ids preserved.
 * @property {string}        name        - User-authored display name.
 * @property {UrlPattern[]}  urlPatterns - Patterns identifying this Ground.
 * @property {string[]}      perspectiveIds   - Ordered composition (read-time projection of perspectives:index).
 * @property {{createdAt:number, updatedAt:number, lifecycle:('draft'|'active'|'deprecated')}} metadata
 * @property {string}        [url]       - Navigable mirror of the primary pattern (wildcards stripped); legacy readers + tab-open consumers.
 * @property {string}        [aiName]    - DEPRECATED mirror = name (legacy readers).
 * @property {string[]}      [aliases]   - Non-spec extension (site-name aliases from Discovery).
 */

/**
 * @typedef {Object} Question
 * @property {string} id        - UUID-like unique identifier.
 * @property {string} text      - Question text (max 100 chars).
 * @property {number} createdAt - Unix timestamp (ms).
 */

/**
 * @typedef {Object} Template
 * @property {string}   groundId    - The Ground this template belongs to.
 * @property {string}   rawJson     - The Phase 2 interaction step JSON string.
 * @property {string}   preambleJson- The Phase 1 navigation step JSON string (may be empty array).
 * @property {Object}   meta        - Execution context: frameSwitches, handoff, waitFlags.
 * @property {Object}   anchors     - generationIndicator + responseContainer + responseElement selectors.
 * @property {number}   generatedAt - Unix timestamp (ms).
 * @property {string}   llmModel    - Model used for generation.
 * @property {number}   turnsUsed   - Total turns across both phases.
 */

// ─── StorageManager class ─────────────────────────────────────────────────────

/**
 * @class StorageManager
 * @classdesc Stateless static service providing CRUD operations over chrome.storage.local.
 */
export class StorageManager {

  // ── Private: Raw storage helpers ──────────────────────────────────────────

  /**
   * Reads one or more keys from chrome.storage.local.
   * @private
   * @param {string|string[]} keys
   * @returns {Promise<Object>}
   */
  static #get(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
   * Writes key-value pairs to chrome.storage.local.
   * @private
   * @param {Object} items
   * @returns {Promise<void>}
   */
  static #set(items) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(items, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Removes keys from chrome.storage.local.
   * @private
   * @param {string|string[]} keys
   * @returns {Promise<void>}
   */
  static #remove(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  /** @private @returns {Promise<string[]>} */
  static async #getGroundIndex() {
    const data = await StorageManager.#get(KEY_GROUND_INDEX);
    return data[KEY_GROUND_INDEX] ?? [];
  }

  /** @private @returns {Promise<string[]>} */
  static async #getResultsIndex() {
    const data = await StorageManager.#get(KEY_RESULTS_INDEX);
    return data[KEY_RESULTS_INDEX] ?? [];
  }

  // ── v2.74.119 — Serialized index mutation ──────────────────────────────
  //
  // Every per-entity index (fragments:index:<gid>, strategies:index:<gid>,
  // workflows:index, etc.) used to follow this pattern at the call site:
  //
  //   const data = await #get(indexKey);
  //   const index = data[indexKey] ?? [];
  //   if (!index.includes(id)) { index.push(id); await #set({ [indexKey]: index }); }
  //
  // With no coordination, two concurrent saves of different ids both
  // snapshot the same index, both push their own id, the second writer
  // clobbers the first's addition. The blast radius: ~16 save/delete
  // sites for the 8 entity types (Fragment / Analysis / Observation /
  // Assertion / Perspective / Path / Strategy / Workflow), plus the Ground
  // index and the test-results index.
  //
  // Same shape and same fix as ConversationStore's v2.74.109 work:
  // serialize ALL index reads-modify-writes behind a single chain
  // promise so concurrent ops queue rather than interleave. JS is
  // single-threaded so the chain only matters at await boundaries —
  // but that's exactly when the races happen.
  //
  // The chain is module-global. Different keys could safely interleave
  // (they touch independent storage rows), but a per-key chain map adds
  // complexity for no realistic win — even busy pages don't burn enough
  // cycles on index ops for the global serialization to matter.
  //
  // The .catch() on the chain link absorbs rejections so one failed op
  // doesn't poison the queue; the rejection still propagates to the
  // caller via the returned promise.
  static #indexChain = Promise.resolve();
  static #serializeIndexOp(fn) {
    const next = StorageManager.#indexChain.then(() => fn());
    StorageManager.#indexChain = next.catch(() => {});
    return next;
  }

  /**
   * Add `id` to the array stored at `key` if not already present.
   * Atomic read-modify-write through the serialized chain.
   * @private
   */
  static #addToIndex(key, id) {
    return StorageManager.#serializeIndexOp(async () => {
      const data = await StorageManager.#get(key);
      const index = Array.isArray(data[key]) ? data[key] : [];
      if (index.includes(id)) return;
      index.push(id);
      await StorageManager.#set({ [key]: index });
    });
  }

  /**
   * Remove `id` from the array stored at `key`. Atomic through the chain.
   * @private
   */
  static #removeFromIndex(key, id) {
    return StorageManager.#serializeIndexOp(async () => {
      const data = await StorageManager.#get(key);
      const index = Array.isArray(data[key]) ? data[key] : [];
      const next = index.filter(x => x !== id);
      await StorageManager.#set({ [key]: next });
    });
  }

  // ── Grounds ───────────────────────────────────────────────────────────────

  /**
   * Persists a new Ground record.
   * @param {Ground} ground
   * @returns {Promise<void>}
   * @throws {Error} On storage write failure.
   */
  /**
   * v2.74.325 — GROUND_SPEC § 6 shape normalization. Upgrades any ground
   * record (legacy "AI product" shape or partial) to the spec shape on
   * read AND write, without a destructive migration:
   *   - name           canonical display name (legacy `aiName` kept as a
   *                    deprecated mirror so existing readers keep working)
   *   - urlPatterns[]  {pattern, isPrimary, patternKind} (legacy single
   *                    `url` kept as a deprecated mirror = primary pattern)
   *   - metadata       { createdAt, updatedAt, lifecycle }
   *   - aliases        preserved as a tolerated non-spec extension
   *
   * `perspectiveIds[]` and the *effective* lifecycle are populated by the read
   * path (getGround / getAllGrounds) from the per-Ground perspectives index —
   * the composition source of truth that already maintains membership and
   * order — so they never drift. They are intentionally NOT persisted here
   * (stripped) to avoid a stale second copy.
   *
   * DEVIATIONS (see SPEC_DEV): existing ids are NOT re-keyed to `gnd_<uid>`
   * (only new grounds get the prefix; re-keying would rewrite groundId on
   * every perspective/fragment/landmark/strategy + all per-Ground index keys),
   * and urlPatterns is single-entry (driven by the one editable `url`)
   * until the URL-pattern-matcher slice adds multi-pattern authoring.
   */
  // v2.74.328 — Derive a NAVIGABLE URL from a (possibly glob/template)
  // pattern by cutting everything from the first wildcard onward. Used for
  // the `url` mirror so the many `chrome.tabs.create({url: ground.url})` /
  // openTab consumers open a real page, not a literal `/*` path. Returns ''
  // when no navigable prefix exists (e.g. a host-wildcard `https://*.x.com/*`).
  static #navigableUrlFromPattern(pattern) {
    let s = String(pattern ?? '').trim();
    if (!s) return '';
    const wildIdx = s.search(/[*?{]/);
    if (wildIdx !== -1) s = s.slice(0, wildIdx);
    if (!s) return '';
    try { return new URL(s).href; } catch { return ''; }
  }

  static #normalizeGroundRecord(g) {
    if (!g || typeof g !== 'object') return g;
    const now = Date.now();
    // perspectiveIds is a read-time projection — never persist it.
    const { perspectiveIds: _derivedPerspectiveIds, ...base } = g;
    const name = (typeof base.name === 'string' && base.name.trim())
      ? base.name
      : (typeof base.aiName === 'string' && base.aiName.trim() ? base.aiName : 'Ground');
    // v2.74.328 — urlPatterns is authoritative when present (spread-writers
    // such as Discovery / updateGround preserve it). Form + create writers
    // send only `url` (the authored pattern string) with no urlPatterns →
    // build the pattern from it. The stored `url` mirror (below) is the
    // NAVIGABLE form — wildcards stripped — NOT the raw pattern, so the many
    // `tabs.create({url: ground.url})` / openTab consumers don't navigate to
    // a literal `/*`. The Studio edit form prefills its URL field from
    // urlPatterns[0].pattern (the real pattern), not from this mirror.
    const url = (typeof base.url === 'string' && base.url.trim()) ? base.url.trim() : '';
    const primaryOf = (pats) => pats?.find(p => p?.isPrimary)?.pattern ?? pats?.[0]?.pattern ?? '';
    const urlPatterns = (Array.isArray(base.urlPatterns) && base.urlPatterns.length)
      ? base.urlPatterns.slice()
      : (url ? [{ pattern: url, isPrimary: true, patternKind: 'glob' }] : []);
    const primary = primaryOf(urlPatterns) || url || '';
    const navigableUrl = StorageManager.#navigableUrlFromPattern(primary);
    const createdAt = base.metadata?.createdAt ?? base.createdAt ?? now;
    // Take whichever updatedAt is fresher: callers may bump the top-level
    // mirror (Studio form, Discovery spread) OR metadata.updatedAt
    // (updateGround). Whichever is newer wins so a bump is never lost.
    const updatedAt = Math.max(
      Number(base.metadata?.updatedAt) || 0,
      Number(base.updatedAt) || 0,
    ) || now;
    return {
      ...base,
      id        : base.id,
      name,
      aiName    : name,                    // deprecated mirror (legacy readers)
      urlPatterns,
      url       : navigableUrl,            // navigable mirror (wildcards stripped) — legacy readers + tab-open consumers
      aliases   : Array.isArray(base.aliases) ? base.aliases : [],
      metadata  : {
        createdAt,
        updatedAt,
        // Effective lifecycle is set in the read path from perspective presence;
        // only 'deprecated' (a future slice) is meaningfully persisted.
        lifecycle: base.metadata?.lifecycle ?? null,
      },
      // v2.74.329 — GROUND_SPEC § 5 derived-intent fields. Defaulted so the
      // shape is always present; populated by the derivation pipeline
      // (DERIVE_GROUND_DESCRIPTION). descriptionOverride null = use derived.
      derivedDescription   : typeof base.derivedDescription === 'string' ? base.derivedDescription : '',
      derivedAt            : Number(base.derivedAt) || 0,
      derivationVersion    : Number(base.derivationVersion) || 0,
      derivationInputsHash : typeof base.derivationInputsHash === 'string' ? base.derivationInputsHash : '',
      descriptionOverride  : typeof base.descriptionOverride === 'string' ? base.descriptionOverride : null,
      createdAt,                           // top-level mirrors (legacy readers)
      updatedAt,
    };
  }

  static async saveGround(ground) {
    // v2.74.325 — Normalize to GROUND_SPEC § 6 shape on write so every
    // writer (Studio form, GroundManager.create, SAVE_GROUND, Discovery)
    // produces a spec-shaped record regardless of what it passed in.
    const normalized = StorageManager.#normalizeGroundRecord(ground);
    await maybeWritePartitionPrimary('ground', /** @type {Record<string, unknown>} */ (normalized));
    // v2.74.119 — Serialized index add (Ground index).
    await StorageManager.#addToIndex(KEY_GROUND_INDEX, normalized.id);
    await StorageManager.#set({ [`grounds:${normalized.id}`]: normalized });
    Logger.info('StorageManager', `Ground saved: ${normalized.id} ("${normalized.name}")`);
  }

  /**
   * Retrieves a single Ground by ID.
   *
   * Ground is now a pure URL/domain container — task-specific fields
   * (taskSteps, taskDesc, outcomeSignal, aiName, uiType, type) have
   * moved to the Path entity keyed by pathId. See getPath().
   *
   * @param {string} pathId
   * @returns {Promise<Ground|null>}
   */
  static async getGround(groundId) {
    let raw = await maybeReadPartition('ground', groundId);
    if (!raw) {
      const data = await StorageManager.#get(`grounds:${groundId}`);
      raw = data[`grounds:${groundId}`] ?? null;
    }
    if (!raw) return null;
    const g = StorageManager.#normalizeGroundRecord(raw);
    // v2.74.325 — Populate perspectiveIds (ordered composition) + effective
    // lifecycle from the per-Ground perspectives index. The index is the
    // composition source of truth, so this never drifts.
    let perspectiveIds = [];
    const partitionPerspectives = await maybeListPartition('perspective', groundId);
    if (partitionPerspectives !== null) {
      perspectiveIds = partitionPerspectives.map((p) => String(p.id || '')).filter(Boolean);
    } else {
      try {
        const idxKey  = `perspectives:index:${groundId}`;
        const idxData = await StorageManager.#get(idxKey);
        if (Array.isArray(idxData[idxKey])) perspectiveIds = idxData[idxKey];
      } catch { /* default [] */ }
    }
    g.perspectiveIds = perspectiveIds;
    g.metadata.lifecycle = (g.metadata.lifecycle === 'deprecated')
      ? 'deprecated'
      : (perspectiveIds.length > 0 ? 'active' : 'draft');
    return g;
  }

  /**
   * Retrieves all stored Grounds in insertion order.
   * @returns {Promise<Ground[]>}
   */
  static async getAllGrounds() {
    const index = await StorageManager.#getGroundIndex();
    if (index.length === 0) return [];
    // v2.74.325 — Batch-read the ground records AND each ground's perspectives
    // index in one storage call, then normalize + project perspectiveIds /
    // effective lifecycle (GROUND_SPEC § 6).
    const groundKeys    = index.map((id) => `grounds:${id}`);
    const perspectiveIdxKeys = index.map((id) => `perspectives:index:${id}`);
    const data = await StorageManager.#get([...groundKeys, ...perspectiveIdxKeys]);
    return index
      .map((id) => data[`grounds:${id}`])
      .filter(Boolean)
      .map(raw => {
        const g = StorageManager.#normalizeGroundRecord(raw);
        const idxKey = `perspectives:index:${g.id}`;
        const perspectiveIds = Array.isArray(data[idxKey]) ? data[idxKey] : [];
        g.perspectiveIds = perspectiveIds;
        g.metadata.lifecycle = (g.metadata.lifecycle === 'deprecated')
          ? 'deprecated'
          : (perspectiveIds.length > 0 ? 'active' : 'draft');
        return g;
      });
  }

  /**
   * Updates an existing Ground record (partial update via spread merge).
   * @param {string} pathId
   * @param {Partial<Ground>} patch
   * @returns {Promise<Ground|null>} The updated record, or null if not found.
   */
  static async updateGround(groundId, patch) {
    const existing = await StorageManager.getGround(groundId);
    if (!existing) {
      Logger.warn('StorageManager', `updateGround: Ground ${groundId} not found`);
      return null;
    }
    // v2.74.325 — Merge then normalize so the persisted record stays
    // GROUND_SPEC-shaped (urlPatterns rebuilt if `url` changed; derived
    // perspectiveIds stripped; metadata.updatedAt bumped).
    const now = Date.now();
    const mergedRaw = {
      ...existing, ...patch, id: groundId,
      metadata: { ...(existing.metadata || {}), ...(patch.metadata || {}), updatedAt: now },
    };
    const updated = StorageManager.#normalizeGroundRecord(mergedRaw);
    await maybeWritePartitionPrimary('ground', /** @type {Record<string, unknown>} */ (updated));
    await StorageManager.#set({ [`grounds:${groundId}`]: updated });
    Logger.info('StorageManager', `Ground updated: ${groundId}`);
    return StorageManager.getGround(groundId);
  }

  /**
   * Deletes a Ground and all associated Templates, Questions, and Results.
   * @param {string} pathId
   * @returns {Promise<void>}
   */
  static async deleteGround(groundId) {
    // v2.74.119 — Index update goes through the serialized chain;
    // cascade remove/set calls below are key-independent so they remain
    // outside the chain.
    //
    // v2.74.327 — Full Tier-1 cascade (GROUND_SPEC § 11 reference
    // integrity). Previously only Fragments + Strategies cascaded, which
    // left this Ground's Perspectives, Observations, Analyses, and Assertions
    // orphaned in storage (their `<kind>:index:<groundId>` keys + records
    // pointed at a deleted Ground, polluting getAll* and risking dangling
    // references). All per-Ground Tier-1 artifacts are now removed.
    //
    // Landmarks are intentionally PRESERVED per GROUND_SPEC § 11 ("v1:
    // orphaned landmarks remain in storage for user-initiated cleanup; no
    // auto-cleanup") — the per-Ground landmark registry
    // (landmarks:index:<groundId> + landmarks:<uid>) is left in place.
    await maybeClearGroundPartitionPrimary(groundId);
    //
    // (Soft-delete / deprecate lifecycle — GROUND_SPEC § 9 — is a separate
    // deferred slice; this remains a hard delete with a complete cascade.)
    const idxKeys = {
      fragments   : `fragments:index:${groundId}`,
      strategies  : `strategies:index:${groundId}`,
      perspectives     : `perspectives:index:${groundId}`,
      observations: `observations:index:${groundId}`,
      analyses    : `analyses:index:${groundId}`,
      assertions  : `assertions:index:${groundId}`,
    };
    const idxData = await StorageManager.#get(Object.values(idxKeys));
    const idsFor  = (k) => (Array.isArray(idxData[idxKeys[k]]) ? idxData[idxKeys[k]] : []);
    const fragmentIds    = idsFor('fragments');
    const strategyIds    = idsFor('strategies');
    const perspectiveIds      = idsFor('perspectives');
    const observationIds = idsFor('observations');
    const analysisIds    = idsFor('analyses');
    const assertionIds   = idsFor('assertions');

    const recordKeys  = [
      ...fragmentIds.map(id => `fragments:${id}`),
      // v2.74.22 — `fragment-walk:${id}` keys removed: AI-walked path is
      // gone and these were never written by the new T1 author flow.
      ...strategyIds.map(id => `strategies:${id}`),
      ...strategyIds.map(id => `strategy-walk:${id}`),
      ...perspectiveIds.map(id => `perspectives:${id}`),
      ...observationIds.map(id => `observations:${id}`),
      ...analysisIds.map(id => `analyses:${id}`),
      ...assertionIds.map(id => `assertions:${id}`),
    ];

    const indexAndMetaKeys = [
      `grounds:${groundId}`,
      idxKeys.fragments,
      idxKeys.strategies,
      idxKeys.perspectives,
      idxKeys.observations,
      idxKeys.analyses,
      idxKeys.assertions,
      `groundmap:${groundId}`,
      // v2.74.463 — per-ground siteMap + OUTCOMES keys (replaced the single-aggregate scheme).
      `siteMap:${groundId}`,
      `outcomes:${groundId}`,
      // v2.74.481 — per-ground hoisted chrome set (GROUND_SPEC § 4).
      `chrome:${groundId}`,
      // Pre-migration cleanup — harmless if already absent
      `paths:index:${groundId}`,
    ];

    await StorageManager.#removeFromIndex(KEY_GROUND_INDEX, groundId);
    if (recordKeys.length > 0) await StorageManager.#remove(recordKeys);
    await StorageManager.#remove(indexAndMetaKeys);

    // v2.74.460 — also prune the per-ground siteMap + OUTCOMES stream. These live as
    // sub-keys of single aggregate objects (`siteMapCache` / `outcomesStream`, owned by
    // background.js) rather than their own storage keys, so the cascade above missed them:
    // it removed the LEGACY `groundmap:<id>` key but not these newer ones. A deleted ground's
    // siteMap (often multi-MB) was therefore left ORPHANED in storage — deleting every ground
    // still left chrome.storage.local full (the bug behind the kQuotaBytes failures). Read-
    // modify-write each aggregate, dropping this ground's entry. Best-effort + key-independent.
    // v2.74.481 — `localeCache` is the SAME orphan-leak class: it's an aggregate
    // ({ [groundId]: { [url]: Locale } }) owned by background.js, never pruned here, so a
    // deleted ground's Locales (the bulk of its model) lingered. Prune it alongside the rest.
    let sitemapPruned = false;
    for (const aggKey of ['siteMapCache', 'outcomesStream', 'localeCache']) {
      try {
        const got = await StorageManager.#get([aggKey]);
        const agg = got?.[aggKey];
        if (agg && typeof agg === 'object' && Object.prototype.hasOwnProperty.call(agg, groundId)) {
          delete agg[groundId];
          await StorageManager.#set({ [aggKey]: agg });
          if (aggKey === 'siteMapCache') sitemapPruned = true;
        }
      } catch (e) { Logger.warn('StorageManager', `deleteGround: could not prune ${aggKey}: ${e.message}`); }
    }

    Logger.info('StorageManager',
      `Ground deleted: ${groundId} (cascade removed ${fragmentIds.length} fragment(s), ` +
      `${strategyIds.length} strategy/ies, ${perspectiveIds.length} perspective(s), ` +
      `${observationIds.length} observation(s), ${analysisIds.length} analysis/es, ` +
      `${assertionIds.length} assertion(s)${sitemapPruned ? ', siteMap pruned' : ''}; ` +
      `landmarks preserved per GROUND_SPEC § 11)`);
  }

  // ── Paths ─────────────────────────────────────────────────────────────────
  //
  // A Path is a named capability on a Ground. One Ground has many Paths.
  // The three layers (Trace/Procedure/Intent) all belong to a Path.
  //
  // Storage:
  //   paths:<pathId>            — the Path record (Intent lives in here)
  //   paths:index:<groundId>    — ordered list of pathIds for a Ground
  //   trace:<pathId>            — Layer 1
  //   procedure:<pathId>        — Layer 2
  //   template:<pathId>         — legacy mirror of procedure (kept until Pass 3)
  //   template_status:<pathId>  — status flag for walk completion
  //   questions:<pathId>        — sample questions per Path
  //   profile:<pathId>          — generated profile for routing

  /**
   * Saves a new Path record. Caller provides the full shape including id.
   * @param {Object} path - { id, pathId, name, aiName, type, taskSteps, taskDesc,
   *                          outcomeSignal, aliases, uiType, createdAt, updatedAt }
   */
  static async savePath(path) {
    if (!path?.id || !path?.groundId) {
      throw new Error('savePath requires { id, groundId }');
    }
    // v2.74.119 — Serialized index add via #addToIndex.
    const indexKey = `paths:index:${path.groundId}`;
    await StorageManager.#addToIndex(indexKey, path.id);
    await StorageManager.#set({ [`paths:${path.id}`]: path });
    Logger.info('StorageManager', `Path saved: ${path.id} ("${path.name ?? path.aiName}") on ground ${path.groundId}`);
  }

  /**
   * Retrieves a single Path by ID.
   * @param {string} pathId
   * @returns {Promise<Object|null>}
   */
  static async getPath(pathId) {
    const data = await StorageManager.#get(`paths:${pathId}`);
    const p    = data[`paths:${pathId}`] ?? null;
    if (p && !Array.isArray(p.aliases))   p.aliases   = [];
    if (p && !Array.isArray(p.taskSteps)) p.taskSteps = [];
    if (p && p.outcomeSignal === undefined) p.outcomeSignal = null;
    if (p && !p.type) p.type = 'ai';
    return p;
  }

  /**
   * Lists the pathIds belonging to a Ground, in insertion order.
   * @param {string} pathId
   * @returns {Promise<string[]>}
   */
  static async listPathIds(groundId) {
    const key = `paths:index:${groundId}`;
    const data = await StorageManager.#get(key);
    return data[key] ?? [];
  }

  /**
   * Lists the full Path records belonging to a Ground, in insertion order.
   * @param {string} pathId
   * @returns {Promise<Object[]>}
   */
  static async listPaths(groundId) {
    const ids = await StorageManager.listPathIds(groundId);
    if (ids.length === 0) return [];
    const keys = ids.map(id => `paths:${id}`);
    const data = await StorageManager.#get(keys);
    return ids
      .map(id => data[`paths:${id}`])
      .filter(Boolean)
      .map(p => ({
        ...p,
        aliases   : Array.isArray(p.aliases)   ? p.aliases   : [],
        taskSteps : Array.isArray(p.taskSteps) ? p.taskSteps : [],
      }));
  }

  /**
   * Retrieves all Paths across all Grounds. Used by the capability registry.
   * @returns {Promise<Object[]>}
   */
  static async getAllPaths() {
    const grounds = await StorageManager.getAllGrounds();
    const paths = [];
    for (const g of grounds) {
      const gpaths = await StorageManager.listPaths(g.id);
      paths.push(...gpaths);
    }
    return paths;
  }

  /**
   * Updates an existing Path (partial update via spread merge).
   * @param {string} pathId
   * @param {Object} patch
   * @returns {Promise<Object|null>}
   */
  static async updatePath(pathId, patch) {
    const existing = await StorageManager.getPath(pathId);
    if (!existing) {
      Logger.warn('StorageManager', `updatePath: Path ${pathId} not found`);
      return null;
    }
    const updated = { ...existing, ...patch, id: pathId, updatedAt: Date.now() };
    await StorageManager.#set({ [`paths:${pathId}`]: updated });
    Logger.info('StorageManager', `Path updated: ${pathId}`);
    return updated;
  }

  /**
   * Deletes a Path and all its associated data (Trace, Procedure, Template,
   * Questions, Profile, Test Results). Removes it from its Ground's index.
   * @param {string} pathId
   * @returns {Promise<void>}
   */
  static async deletePath(pathId) {
    const path = await StorageManager.getPath(pathId);
    if (!path) {
      Logger.warn('StorageManager', `deletePath: Path ${pathId} not found`);
      return;
    }
    // v2.74.119 — Serialized index removal via #removeFromIndex.
    const indexKey = `paths:index:${path.groundId}`;
    await StorageManager.#removeFromIndex(indexKey, pathId);

    // Remove path record + all layer data
    await StorageManager.#remove([
      `paths:${pathId}`,
      `trace:${pathId}`,
      `procedure:${pathId}`,
      `template:${pathId}`,
      `template_status:${pathId}`,
      `template_error:${pathId}`,
      `questions:${pathId}`,
      `profile:${pathId}`,
      `authoring-session:${pathId}`,
    ]);
    Logger.info('StorageManager', `Path deleted: ${pathId} (cascade removed all layer data)`);
  }

  // ── Questions ─────────────────────────────────────────────────────────────

  /**
   * Returns all questions for a Ground, ordered by creation time.
   * @param {string} pathId
   * @returns {Promise<Question[]>}
   */
  static async getQuestions(pathId) {
    const data = await StorageManager.#get(`questions:${pathId}`);
    return data[`questions:${pathId}`] ?? [];
  }

  /**
   * Appends a new question to a Ground's question list.
   * @param {string}   pathId
   * @param {Question} question
   * @returns {Promise<Question[]>} Updated question list.
   * @throws {RangeError} When the question text exceeds 100 characters.
   */
  static async addQuestion(pathId, question) {
    if (question.text.length > 100) {
      throw new RangeError(
        `Question text exceeds maximum length (${question.text.length} > 100 chars)`
      );
    }
    const existing = await StorageManager.getQuestions(pathId);
    existing.push(question);
    await StorageManager.#set({ [`questions:${pathId}`]: existing });
    Logger.info('StorageManager', `Question added to ground ${pathId}: "${question.text}"`);
    return existing;
  }

  /**
   * Updates a specific question within a Ground's question list.
   * @param {string} pathId
   * @param {string} questionId
   * @param {string} newText - Replacement text (max 100 chars).
   * @returns {Promise<Question[]>} Updated question list.
   * @throws {RangeError} On text length violation.
   * @throws {Error}      When the question is not found.
   */
  static async updateQuestion(pathId, questionId, newText) {
    if (newText.length > 100) {
      throw new RangeError(`Question text exceeds maximum length (${newText.length} > 100 chars)`);
    }
    const questions = await StorageManager.getQuestions(pathId);
    const idx = questions.findIndex((q) => q.id === questionId);
    if (idx === -1) throw new Error(`Question ${questionId} not found in ground ${pathId}`);

    questions[idx] = { ...questions[idx], text: newText };
    await StorageManager.#set({ [`questions:${pathId}`]: questions });
    Logger.info('StorageManager', `Question ${questionId} updated`);
    return questions;
  }

  /**
   * Removes a specific question from a Ground's question list.
   * @param {string} pathId
   * @param {string} questionId
   * @returns {Promise<Question[]>} Updated question list.
   */
  static async deleteQuestion(pathId, questionId) {
    const questions = await StorageManager.getQuestions(pathId);
    const filtered  = questions.filter((q) => q.id !== questionId);
    await StorageManager.#set({ [`questions:${pathId}`]: filtered });
    Logger.info('StorageManager', `Question ${questionId} deleted from ground ${pathId}`);
    return filtered;
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  /**
   * Saves (upserts) an LLM-generated or walk-discovered template for a Ground.
   * The `meta` field encodes the execution context proven during walk discovery
   * (frame URLs, wait requirements) so ExecutionEngine can replay the exact path.
   * Also sets template status to 'ready'.
   *
   * @param {Template} template
   * @returns {Promise<void>}
   */
  static async saveTemplate(template) {
    // Backwards-compatible: write to legacy template key + mirror to new
    // trace and procedure keys so the three-layer model is populated.
    await StorageManager.#set({ [`template:${template.groundId}`]: template });
    await StorageManager.setTemplateStatus(template.groundId, 'ready');

    // Layer 1 — Trace (immutable record of what the walk produced)
    await StorageManager.saveTrace(template.groundId, {
      rawJson      : template.rawJson,
      fillerValues : template.meta?.fillerValues ?? {},
      turnsUsed    : template.turnsUsed ?? template.meta?.turnsUsed ?? 0,
      walkedAt     : template.generatedAt ?? Date.now(),
      llmModel     : template.llmModel ?? 'claude-sonnet-4-5',
    });

    // Layer 2 — Procedure (runtime-executable, initially pass-through from trace)
    await StorageManager.saveProcedure(template.groundId, {
      rawJson      : template.rawJson,
      meta         : template.meta ?? null,
      anchors      : template.anchors ?? {},
      preambleJson : template.preambleJson ?? '[]',
      builtAt      : Date.now(),
      sourceTraceAt: template.generatedAt ?? Date.now(),
    });

    Logger.info('StorageManager', `Template saved for ground ${template.groundId}`, {
      hasMeta: !!template.meta,
      frameSwitches: template.meta?.frameSwitches?.length ?? 0,
    });
  }

  /**
   * Layer 1 — Trace storage.
   * Immutable record of what a walk produced. Keyed by pathId.
   * (A single Ground can have many Paths; each Path has its own Trace.)
   * @param {string} pathId
   * @param {Object} trace - { rawJson, fillerValues, turnsUsed, walkedAt, llmModel }
   */
  static async saveTrace(pathId, trace) {
    await StorageManager.#set({
      [`trace:${pathId}`]: { ...trace, pathId, savedAt: Date.now() },
    });
    Logger.info('StorageManager', `Trace saved for path ${pathId}`);
  }

  /** @param {string} pathId @returns {Promise<Object|null>} */
  static async getTrace(pathId) {
    const data = await StorageManager.#get(`trace:${pathId}`);
    return data[`trace:${pathId}`] ?? null;
  }

  /**
   * Layer 2 — Procedure storage.
   * Runtime-executable step list, refactored from the trace via ProcedureBuilder.
   * @param {string} pathId
   * @param {Object} procedure - { rawJson, meta, anchors, preambleJson, builtAt }
   */
  static async saveProcedure(pathId, procedure) {
    await StorageManager.#set({
      [`procedure:${pathId}`]: { ...procedure, pathId, savedAt: Date.now() },
    });
    Logger.info('StorageManager', `Procedure saved for path ${pathId}`);
  }

  /** @param {string} pathId @returns {Promise<Object|null>} */
  static async getProcedure(pathId) {
    const data = await StorageManager.#get(`procedure:${pathId}`);
    return data[`procedure:${pathId}`] ?? null;
  }

  /**
   * Saves a partial template — confirmed steps so far from an incomplete walk.
   * Sets status to 'partial'. Used for incremental discovery / continuation.
   * @param {Object} template - Same shape as saveTemplate but incomplete.
   * @returns {Promise<void>}
   */
  static async savePartialTemplate(template) {
    const key = template.pathId ?? template.groundId;  // backcompat during refactor
    await StorageManager.#set({ [`template:${key}`]: template });
    await StorageManager.setTemplateStatus(key, 'partial');
    Logger.info('StorageManager', `Partial template saved for path ${key}`, {
      steps: template.meta?.confirmedCount ?? 0,
    });
  }

  /**
   * Retrieves the template for a Ground.
   * @param {string} pathId
   * @returns {Promise<Template|null>}
   */
  static async getTemplate(pathId) {
    const data = await StorageManager.#get(`template:${pathId}`);
    return data[`template:${pathId}`] ?? null;
  }

  /**
   * Sets the template generation status for a Ground.
   * @param {string} pathId
   * @param {'none'|'generating'|'ready'|'error'|'partial'} status
   * @returns {Promise<void>}
   */
  static async setTemplateStatus(pathId, status) {
    await StorageManager.#set({ [`template_status:${pathId}`]: status });
  }

  /**
   * Gets the template generation status for a Ground.
   * @param {string} pathId
   * @returns {Promise<'none'|'generating'|'ready'|'error'>}
   */
  static async getTemplateStatus(pathId) {
    const data = await StorageManager.#get(`template_status:${pathId}`);
    return data[`template_status:${pathId}`] ?? 'none';
  }

  /**
   * Stores the last error message from a failed template generation attempt.
   * Pass null to clear it after a successful generation.
   * @param {string}      pathId
   * @param {string|null} errorMessage
   * @returns {Promise<void>}
   */
  static async setTemplateError(pathId, errorMessage) {
    const key = `template_error:${pathId}`;
    if (errorMessage === null) {
      await StorageManager.#remove(key);
    } else {
      await StorageManager.#set({ [key]: errorMessage });
    }
  }

  /**
   * Retrieves the last template generation error for a ground, if any.
   * @param {string} pathId
   * @returns {Promise<string|null>}
   */
  static async getTemplateError(pathId) {
    const data = await StorageManager.#get(`template_error:${pathId}`);
    return data[`template_error:${pathId}`] ?? null;
  }

  /**
   * Gets template statuses for multiple grounds in one storage read.
   * @param {string[]} pathIds
   * @returns {Promise<Record<string, string>>}
   */
  static async getTemplateStatuses(pathIds) {
    if (pathIds.length === 0) return {};
    const keys = pathIds.map((id) => `template_status:${id}`);
    const data = await StorageManager.#get(keys);
    const out  = {};
    for (const id of pathIds) {
      out[id] = data[`template_status:${id}`] ?? 'none';
    }
    return out;
  }

  // ── Test Results ──────────────────────────────────────────────────────────

  /**
   * Persists a completed TestResult and appends its jobId to the chronological index.
   * Trims the index to MAX_RESULTS_STORED, removing oldest entries and their data.
   *
   * @param {import('./ExecutionEngine.js').JobResult} result
   * @returns {Promise<void>}
   */
  static async saveTestResult(result) {
    let index = await StorageManager.#getResultsIndex();

    index.push(result.jobId);
    await StorageManager.#set({ [`results:${result.jobId}`]: result });

    // Trim oldest results when over the limit
    if (index.length > MAX_RESULTS_STORED) {
      const overflow   = index.splice(0, index.length - MAX_RESULTS_STORED);
      const staleKeys  = overflow.map((id) => `results:${id}`);
      await StorageManager.#remove(staleKeys);
      Logger.info('StorageManager', `Trimmed ${overflow.length} old result(s)`);
    }

    await StorageManager.#set({ [KEY_RESULTS_INDEX]: index });
    Logger.info('StorageManager', `Test result saved: ${result.jobId} (${result.passed ? 'PASS' : 'FAIL'})`);
  }

  /**
   * Retrieves all stored test results in chronological completion order.
   * @returns {Promise<import('./ExecutionEngine.js').JobResult[]>}
   */
  static async getAllResults() {
    const index = await StorageManager.#getResultsIndex();
    if (index.length === 0) return [];
    const keys = index.map((id) => `results:${id}`);
    const data = await StorageManager.#get(keys);
    return index.map((id) => data[`results:${id}`]).filter(Boolean);
  }

  /**
   * Retrieves the N most recent test results.
   * @param {number} [limit=50]
   * @returns {Promise<import('./ExecutionEngine.js').JobResult[]>}
   */
  static async getRecentResults(limit = 50) {
    const index = await StorageManager.#getResultsIndex();
    const recent = index.slice(-limit);
    if (recent.length === 0) return [];
    const keys = recent.map((id) => `results:${id}`);
    const data = await StorageManager.#get(keys);
    return recent.map((id) => data[`results:${id}`]).filter(Boolean);
  }

  /**
   * Clears all stored test results and their index.
   * @returns {Promise<void>}
   */
  static async clearAllResults() {
    const index = await StorageManager.#getResultsIndex();
    const keys  = index.map((id) => `results:${id}`);
    await StorageManager.#remove([...keys, KEY_RESULTS_INDEX]);
    Logger.warn('StorageManager', `Cleared ${index.length} test result(s)`);
  }

  // ── Ground Profiles ───────────────────────────────────────────────────────

  /**
   * Saves a capability profile for a ground. Called progressively —
   * each call replaces the stored profile so partial profiles are always
   * retrievable if the profiling pass is interrupted.
   *
   * @param {string} pathId
   * @param {Object} profile
   * @returns {Promise<void>}
   */
  static async saveProfile(pathId, profile) {
    await StorageManager.#set({
      [`profile:${pathId}`]: { ...profile, pathId, updatedAt: Date.now() },
    });
    Logger.info('StorageManager', `Profile saved for path ${pathId}`, {
      exchanges: profile.sampleExchanges?.length ?? 0,
    });
  }

  /** @param {string} pathId @returns {Promise<Object|null>} */
  static async getProfile(pathId) {
    const data = await StorageManager.#get(`profile:${pathId}`);
    return data[`profile:${pathId}`] ?? null;
  }

  /** @returns {Promise<Object[]>} Profiles for all paths across all grounds. */
  static async getAllProfiles() {
    const grounds = await StorageManager.getAllGrounds();
    const allPathIds = [];
    for (const g of grounds) {
      allPathIds.push(...(await StorageManager.listPathIds(g.id)));
    }
    if (!allPathIds.length) return [];
    const data = await StorageManager.#get(allPathIds.map(id => `profile:${id}`));
    return allPathIds.map(id => data[`profile:${id}`]).filter(Boolean);
  }

  /**
   * Sets the profiling status for a ground card indicator.
   * @param {string} pathId
   * @param {'idle'|'running'|'complete'|'error'} status
   * @param {number} [progress=0] - Questions answered so far.
   * @param {number} [total=0]    - Total questions planned.
   */
  static async setProfilingStatus(groundId, status, progress = 0, total = 0) {
    await StorageManager.#set({
      [`profile_status:${groundId}`]: { status, progress, total, updatedAt: Date.now() },
    });
  }

  /** @param {string} pathId @returns {Promise<{status:string,progress:number,total:number}|null>} */
  static async getProfilingStatus(groundId) {
    const data = await StorageManager.#get(`profile_status:${groundId}`);
    return data[`profile_status:${groundId}`] ?? null;
  }

  /** Deletes the profile and status for a ground. */
  static async deleteProfile(groundId) {
    await StorageManager.#remove([`profile:${groundId}`, `profile_status:${groundId}`]);
    Logger.info('StorageManager', `Profile deleted for ground ${groundId}`);
  }

  // ── DOM Snapshots (audit) ─────────────────────────────────────────────────

  /**
   * Saves the canonical DOM snapshots captured during walk discovery.
   * One snapshot per frame tier — top frame, panel shell, widget iframe.
   * Stored for auditing: verifies elements are reduced to structural
   * attributes only, with no PII visible text content.
   *
   * @param {string}   pathId
   * @param {Array<{ depth: number, frameUrl: string|null, frameId: number, snapshot: string }>} snapshots
   * @returns {Promise<void>}
   */
  static async saveSnapshots(groundId, snapshots) {
    await StorageManager.#set({
      [`snapshots:${groundId}`]: { groundId, snapshots, savedAt: Date.now() },
    });
    Logger.info('StorageManager', `Snapshots saved for ground ${groundId} (${snapshots.length} tiers)`);
  }

  /**
   * Retrieves the DOM snapshots for a ground.
   * @param {string} pathId
   * @returns {Promise<{ snapshots: Array, savedAt: number }|null>}
   */
  static async getSnapshots(groundId) {
    const data = await StorageManager.#get(`snapshots:${groundId}`);
    return data[`snapshots:${groundId}`] ?? null;
  }

  // ── Ground Map — RETIRED (v2.74.434) ─────────────────────────────────────
  //
  // The persisted GroundMap (a per-Ground crawl record) was subsumed by the
  // Ground siteMap (GROUND_SPEC § 7), stored in background.js under the
  // `siteMapCache` key and read via the GET_SITEMAP message. DiscoveryService
  // now returns the crawled `pages` directly; background folds them into the
  // siteMap via SiteMap.siteMapFromCrawl. The save/get/deleteGroundMap methods
  // and the `groundmap:*` storage keys are gone.

  // ── Authoring Session (Pass 5b) ──────────────────────────────────────────
  //
  // An authoring session captures in-flight walk state so a crashed or
  // interrupted walk can resume without losing confirmed work. Keyed by
  // pathId. Flushed by TemplateWalker after each confirmed step. Deleted
  // when a walk completes successfully or is explicitly abandoned.
  //
  // Shape: {
  //   pathId, startedAt, updatedAt,
  //   confirmedSteps: [...],          // steps confirmed so far (with _branch tags)
  //   activeBranchLabel: string|null, // active branch at time of flush
  //   forkPoints: [...],              // forks declared so far
  //   fillerValues: {},               // filler values used for params
  //   turn: number                    // walk turn counter
  // }

  static async saveAuthoringSession(pathId, session) {
    await StorageManager.#set({
      [`authoring-session:${pathId}`]: { ...session, pathId, updatedAt: Date.now() },
    });
  }

  /** @param {string} pathId @returns {Promise<Object|null>} */
  static async getAuthoringSession(pathId) {
    const data = await StorageManager.#get(`authoring-session:${pathId}`);
    return data[`authoring-session:${pathId}`] ?? null;
  }

  /** @param {string} pathId */
  static async deleteAuthoringSession(pathId) {
    await StorageManager.#remove([`authoring-session:${pathId}`]);
  }

  // ── Migration to Path model (v2.14.0) ────────────────────────────────────
  //
  // Ground and Path are now separate entities. The three layers (Trace,
  // Procedure, Intent) belong to Path, not Ground. Storage keys for
  // trace/procedure/template/questions/profile now expect a pathId.
  //
  // Since the Ground/Path split is structural, existing walks cannot be
  // automatically upgraded — the Ground was previously assumed to own
  // exactly one task. Rather than guess, we drop walk-related data and
  // require re-walking. Grounds themselves (URL + domain) are kept.
  //
  // Task-specific fields (taskSteps, taskDesc, outcomeSignal, aliases,
  // uiType, type, aiName) are scrubbed from Grounds — those now belong
  // to Paths, which users create fresh.
  //
  // Runs once, guarded by a migration marker. Safe to invoke on every
  // startup; it's a no-op after the first success.

  static async migrateToPathModel() {
    const MARKER_KEY = 'migration:v2.14.0-ground-path-split';
    const data = await StorageManager.#get(MARKER_KEY);
    if (data[MARKER_KEY] === true) return; // already migrated

    // Extra safety: if any Path records already exist, the migration has
    // effectively been completed (or this is a post-migration install with
    // a missing marker). Running it anyway would wipe trace:/procedure:
    // keys that now belong to real Paths. Instead, just set the marker.
    const all = await new Promise((resolve) => chrome.storage.local.get(null, resolve));
    const hasPathRecords = Object.keys(all).some(k => k.startsWith('paths:') && !k.startsWith('paths:index:'));
    if (hasPathRecords) {
      Logger.info('StorageManager', 'Migration skipped — Path records already exist');
      await StorageManager.#set({ [MARKER_KEY]: true });
      return;
    }

    Logger.info('StorageManager', 'Running v2.14.0 Ground/Path migration…');

    // Scan all keys in local storage, collect those that are walk-related
    const toRemove = [];
    for (const key of Object.keys(all)) {
      if (
        key.startsWith('trace:') ||
        key.startsWith('procedure:') ||
        key.startsWith('template:') ||
        key.startsWith('template_status:') ||
        key.startsWith('template_error:') ||
        key.startsWith('questions:') ||
        key.startsWith('profile:') ||
        key.startsWith('snapshots:') ||
        key.startsWith('result:')
      ) {
        toRemove.push(key);
      }
    }

    // Scrub task-specific fields from existing Grounds, keeping URL/aliases.
    const groundIds = await StorageManager.#getGroundIndex();
    for (const gid of groundIds) {
      const g = all[`grounds:${gid}`];
      if (!g) continue;
      const scrubbed = {
        id        : g.id,
        url       : g.url,
        name      : g.name ?? g.aiName ?? 'Ground',
        aliases   : Array.isArray(g.aliases) ? g.aliases : [],
        createdAt : g.createdAt ?? Date.now(),
        updatedAt : Date.now(),
      };
      await StorageManager.#set({ [`grounds:${gid}`]: scrubbed });
    }

    if (toRemove.length > 0) {
      await StorageManager.#remove(toRemove);
    }

    await StorageManager.#set({ [MARKER_KEY]: true });
    Logger.info('StorageManager',
      `Migration complete — scrubbed ${groundIds.length} grounds, removed ${toRemove.length} legacy keys`);
  }

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ Pass A — FRAGMENT & STRATEGY MODEL (v2.21.0)                         ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  //
  // A Fragment is a page-state-transition unit — a deterministic DOM action
  // sequence with pre/post conditions. Scoped to a Ground. Reusable across
  // Strategies. Shape:
  //
  //   {
  //     id, groundId, name, description,
  //     preconditions  : [{type, selector?, pattern?, value?}, ...],
  //     postconditions : [{type, selector?, pattern?, value?}, ...],
  //     rawJson        : JSON string — linear DOM action sequence
  //     params         : [PARAM_NAME, ...]
  //     pageClass      : string|null — author label for a kind of page
  //     healthStatus   : 'ready'|'stale'|'broken'|'untested'
  //     lastExecutedAt : timestamp|null
  //     createdAt, updatedAt
  //   }
  //
  // A Strategy is a goal decomposition tree with Fragment references and
  // control flow. Scoped to a Ground. Shape:
  //
  //   {
  //     id, groundId, name, goal, aliases,
  //     plan           : StrategyNode (tree with FragmentRef leaves)
  //     params         : [PARAM_NAME, ...]   — union of referenced Fragments
  //     outcomeSignal  : string|null
  //     createdAt, updatedAt
  //   }
  //
  // StrategyNode is one of:
  //   { type: 'fragment', fragmentId, paramBindings?: {...} }
  //   { type: 'sequence', body: StrategyNode[] }
  //   { type: 'iterate',  source: {...}, body: StrategyNode[] }
  //   { type: 'detect',   branches: [{condition, body}, ...], default?: StrategyNode[] }

  // ── Fragments ────────────────────────────────────────────────────────────

  // v2.72.26 (Pass 14b) — Fragment migration is now a no-op for the produces
  // field. Pass 14 introduced a fragment.produces contract derived from
  // rawJson (EXTRACT/ENUMERATE/EMIT outputs). That violated the architectural
  // principle: a primitive's contract is name + description + pre/post +
  // params; internals (rawJson actions, including legacy scope-writing ones)
  // are opaque to composers.
  //
  // EXTRACT/ENUMERATE/EMIT are legacy Fragment actions migrating to
  // Observations (the page→data primitive). Surfacing them as a
  // Fragment-level contract encoded the wrong concept and risked nudging
  // authors toward storing data extraction in Fragments rather than
  // migrating to Observations.
  //
  // Behavior now: strip the produces field on read (one-time cleanup of
  // pre-existing records). Don't add it on save. Strategy-editor walkers
  // that need to know "does this fragment have legacy scope-writing
  // actions" walk rawJson directly (the pre-Pass-14 behavior).
  //
  // Pure function over (fragment) — no side effects.
  static #migrateFragmentShape(fragment) {
    if (!fragment || typeof fragment !== 'object') return fragment;
    if ('produces' in fragment) {
      const { produces, ...rest } = fragment;
      return rest;
    }
    return fragment;
  }

  static async saveFragment(fragment) {
    if (!fragment?.id || !fragment?.groundId) {
      throw new Error('saveFragment requires { id, groundId }');
    }
    // B1 guard: if this id already exists under a different Ground, refuse —
    // moving a Fragment between Grounds is not a first-class operation and
    // would leave a stale index entry on the original Ground.
    const existing = await StorageManager.getFragment(fragment.id);
    if (existing && existing.groundId !== fragment.groundId) {
      throw new Error(`Fragment ${fragment.id} already exists on ground ${existing.groundId}; cannot reassign to ${fragment.groundId}`);
    }
    // v2.72.26 (Pass 14b) — strip Pass 14's produces field. The save shape
    // is name/description/pre/post/params/rawJson — that's the Fragment
    // contract. Internals are opaque.
    const migrated = StorageManager.#migrateFragmentShape(fragment);
    const toSave = { ...migrated, updatedAt: Date.now() };
    await maybeWritePartitionPrimary('fragment', toSave);
    // v2.74.119 — Serialized index add.
    const indexKey = `fragments:index:${migrated.groundId}`;
    await StorageManager.#addToIndex(indexKey, migrated.id);
    await StorageManager.#set({
      [`fragments:${migrated.id}`]: toSave,
    });
    Logger.info('StorageManager', `Fragment saved: ${migrated.id} (${migrated.name ?? 'unnamed'}) on ground ${migrated.groundId}`);
  }

  static async getFragment(fragmentId) {
    const fromPartition = await maybeReadPartition('fragment', fragmentId);
    if (fromPartition) {
      return StorageManager.#migrateFragmentShape(fromPartition);
    }
    const data = await StorageManager.#get(`fragments:${fragmentId}`);
    const fragment = data[`fragments:${fragmentId}`] ?? null;
    if (!fragment) return null;
    // v2.72.26 (Pass 14b) — strip stale produces field on read.
    return StorageManager.#migrateFragmentShape(fragment);
  }

  static async listFragments(groundId) {
    const fromPartition = await maybeListPartition('fragment', groundId);
    if (fromPartition !== null) {
      return fromPartition
        .filter(Boolean)
        .map((f) => StorageManager.#migrateFragmentShape(f));
    }
    const indexKey = `fragments:index:${groundId}`;
    const indexData = await StorageManager.#get(indexKey);
    const ids = indexData[indexKey] ?? [];
    if (ids.length === 0) return [];
    const keys = ids.map(id => `fragments:${id}`);
    const data = await new Promise(res => chrome.storage.local.get(keys, res));
    // B2: surface index/record drift. A missing record for an indexed id
    // indicates an incomplete delete or storage corruption — log it so the
    // problem doesn't stay invisible.
    const missing = ids.filter(id => !data[`fragments:${id}`]);
    if (missing.length > 0) {
      Logger.warn('StorageManager', `listFragments(${groundId}): index has ${missing.length} id(s) with no matching record — ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
    }
    return ids.map(id => data[`fragments:${id}`]).filter(Boolean).map(f => {
      // v2.72.26 (Pass 14b) — strip stale produces field on read.
      return StorageManager.#migrateFragmentShape(f);
    });
  }

  static async getAllFragments() {
    const groundIds = await StorageManager.#getGroundIndex();
    const all = [];
    for (const gid of groundIds) {
      const frags = await StorageManager.listFragments(gid);
      all.push(...frags);
    }
    return all;
  }

  static async deleteFragment(fragmentId) {
    const frag = await StorageManager.getFragment(fragmentId);
    if (!frag) return;
    await maybeRemovePartitionPrimary('fragment', /** @type {Record<string, unknown>} */ (frag));
    // v2.74.119 — Serialized index removal.
    const indexKey = `fragments:index:${frag.groundId}`;
    await StorageManager.#removeFromIndex(indexKey, fragmentId);
    // v2.74.22 — `fragment-walk:${id}` no longer cleaned up: AI-walked
    // path is gone and that key was never written by the T1 author flow.
    await StorageManager.#remove([`fragments:${fragmentId}`]);
    Logger.info('StorageManager', `Fragment deleted: ${fragmentId}`);
  }

  static async updateFragment(fragmentId, patch) {
    const existing = await StorageManager.getFragment(fragmentId);
    if (!existing) throw new Error(`Fragment ${fragmentId} not found`);
    const updated = { ...existing, ...patch, id: existing.id, groundId: existing.groundId, updatedAt: Date.now() };
    await maybeWritePartitionPrimary('fragment', updated);
    await StorageManager.#set({ [`fragments:${fragmentId}`]: updated });
    Logger.info('StorageManager', `Fragment updated: ${fragmentId}`);
    return updated;
  }

  // ── Analyses (v2.62.0 — data-ops library) ────────────────────────────────
  //
  // Analyses are named, parameterizable definitions of data operations
  // (filter / sort / take / future ops). Stored Ground-scoped, mirroring
  // the Fragment pattern. A strategy will reference an Analysis by id and
  // bind its params at strategy-edit time (Iteration B). Iteration A only
  // covers storage + the editor in isolation.
  //
  // User-authored Analyses live here. Built-in Analyses (shipped with the
  // extension) live in Services/BuiltinAnalyses.js as code; the studio
  // displays both in a single library list.

  /**
   * v2.66.0 (Pass 3a) — Migrate a stored Analysis record from legacy
   * single-body shape to layered implementations shape. Idempotent.
   *
   * Legacy:  { ..., operations: [...] }
   * New:     { ..., implementations: [{tier: 'cache', operations: [...]}] }
   *
   * Applied at every read site (get, list) and defensively at save. The
   * legacy `operations` field is removed after migration to canonicalize
   * storage. Built-ins ship with the new shape directly; this only
   * affects user-authored Analyses created before v2.66.0.
   *
   * v2.70.0 — Now also wraps legacy pre/post flat arrays into the
   * assertion envelope shape `{match: 'all', conditions: [...]}`. This is
   * idempotent — already-wrapped envelopes pass through unchanged. Lets
   * Analysis pre/post share the same shape as Fragment pre/post and
   * strategy DETECT/LOOP/WAIT_FOR/TRY conditions.
   */
  static #migrateAnalysisShape(analysis) {
    if (!analysis || typeof analysis !== 'object') return analysis;

    // Step 1: Tier shape — implementations vs legacy top-level operations.
    let migrated;
    if (Array.isArray(analysis.implementations) && analysis.implementations.length > 0) {
      // Already in new shape; strip stale top-level operations.
      if ('operations' in analysis) {
        const { operations, ...rest } = analysis;
        migrated = rest;
      } else {
        migrated = analysis;
      }
    } else {
      // Legacy: lift operations into a single cache implementation.
      const operations = Array.isArray(analysis.operations) ? analysis.operations : [];
      const { operations: _drop, ...rest } = analysis;
      migrated = {
        ...rest,
        implementations: [{ tier: 'cache', operations }],
      };
    }

    // Step 1.5 (v2.72.16, Pass 7a): lift impl[0].operations under body
    // envelope: implementations[0].body = {kind: 'operations', operations: [...]}.
    // Cache-tier implementations only — frontier-tier impls have no body
    // (the LLM IS the body, no operations to wrap).
    //
    // Idempotent: impls already carrying a `body` field pass through
    // unchanged. Records produced by Pass 7a save flow write canonical
    // body envelope directly; this migration covers reads of pre-7a records.
    migrated = {
      ...migrated,
      implementations: migrated.implementations.map(impl => {
        if (!impl || typeof impl !== 'object') return impl;
        // Already in new shape — pass through.
        if (impl.body && typeof impl.body === 'object') return impl;
        // Frontier tier never had operations on it; nothing to wrap.
        if (impl.tier === 'frontier') return impl;
        // Cache tier (or default): wrap any top-level operations into body.
        const ops = Array.isArray(impl.operations) ? impl.operations : [];
        const { operations: _drop, ...implRest } = impl;
        return {
          ...implRest,
          body: { kind: 'operations', operations: ops },
        };
      }),
    };

    // Step 2 (v2.70.0): pre/post envelope shape. Wrap legacy flat arrays
    // into {match, conditions} assertion envelope.
    const wrapEnvelope = (v) => {
      if (!v) return { match: 'all', conditions: [] };
      // Already an envelope.
      if (typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.conditions)) {
        return {
          match: v.match === 'any' ? 'any' : (v.match === 'k_of_n' ? 'k_of_n' : 'all'),
          conditions: v.conditions,
          ...(typeof v.count === 'number' ? { count: v.count } : {}),
        };
      }
      // Legacy flat array.
      if (Array.isArray(v)) {
        return { match: 'all', conditions: v };
      }
      return { match: 'all', conditions: [] };
    };

    return {
      ...migrated,
      preconditions:  wrapEnvelope(migrated.preconditions),
      postconditions: wrapEnvelope(migrated.postconditions),
    };
  }

  static async saveAnalysis(analysis) {
    if (!analysis?.id || !analysis?.groundId) {
      throw new Error('saveAnalysis requires { id, groundId }');
    }
    const existing = await StorageManager.getAnalysis(analysis.id);
    if (existing && existing.groundId !== analysis.groundId) {
      throw new Error(`Analysis ${analysis.id} already exists on ground ${existing.groundId}; cannot reassign to ${analysis.groundId}`);
    }
    // v2.74.119 — Serialized index add.
    const indexKey = `analyses:index:${analysis.groundId}`;
    await StorageManager.#addToIndex(indexKey, analysis.id);
    // v2.66.0 (Pass 3a) — Defensive migration on save. Catches drafts that
    // somehow still carry legacy `operations` field; ensures persisted
    // records are always in new shape.
    const migrated = StorageManager.#migrateAnalysisShape(analysis);
    const toSave = { ...migrated, updatedAt: Date.now() };
    await maybeWritePartitionPrimary('analysis', toSave);
    await StorageManager.#set({
      [`analyses:${analysis.id}`]: toSave,
    });
    Logger.info('StorageManager', `Analysis saved: ${analysis.id} (${analysis.name ?? 'unnamed'}) on ground ${analysis.groundId}`);
  }

  static async getAnalysis(analysisId) {
    const fromPartition = await maybeReadPartition('analysis', analysisId);
    if (fromPartition) return StorageManager.#migrateAnalysisShape(fromPartition);
    const data = await StorageManager.#get(`analyses:${analysisId}`);
    const raw = data[`analyses:${analysisId}`] ?? null;
    return raw ? StorageManager.#migrateAnalysisShape(raw) : null;
  }

  static async listAnalyses(groundId) {
    const fromPartition = await maybeListPartition('analysis', groundId);
    if (fromPartition !== null) {
      return fromPartition
        .filter(Boolean)
        .map((a) => StorageManager.#migrateAnalysisShape(a));
    }
    const indexKey = `analyses:index:${groundId}`;
    const indexData = await StorageManager.#get(indexKey);
    const ids = indexData[indexKey] ?? [];
    if (ids.length === 0) return [];
    const keys = ids.map(id => `analyses:${id}`);
    const data = await new Promise(res => chrome.storage.local.get(keys, res));
    const missing = ids.filter(id => !data[`analyses:${id}`]);
    if (missing.length > 0) {
      Logger.warn('StorageManager', `listAnalyses(${groundId}): index has ${missing.length} id(s) with no matching record — ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
    }
    return ids.map(id => data[`analyses:${id}`]).filter(Boolean).map(StorageManager.#migrateAnalysisShape);
  }

  // v2.74.74 — Cross-Ground analyses listing. Mirrors getAllStrategies.
  // Strategies' Analysis-step pickers consume this to show the full
  // catalog (Ground-scoped, plus builtins which the caller can prepend).
  static async getAllAnalyses() {
    const groundIds = await StorageManager.#getGroundIndex();
    const all = [];
    for (const gid of groundIds) {
      const list = await StorageManager.listAnalyses(gid);
      all.push(...list);
    }
    return all;
  }

  static async deleteAnalysis(analysisId) {
    const analysis = await StorageManager.getAnalysis(analysisId);
    if (!analysis) return;
    await maybeRemovePartitionPrimary('analysis', /** @type {Record<string, unknown>} */ (analysis));
    // v2.74.119 — Serialized index removal.
    const indexKey = `analyses:index:${analysis.groundId}`;
    await StorageManager.#removeFromIndex(indexKey, analysisId);
    await StorageManager.#remove([`analyses:${analysisId}`]);
    Logger.info('StorageManager', `Analysis deleted: ${analysisId}`);
  }

  static async updateAnalysis(analysisId, patch) {
    const existing = await StorageManager.getAnalysis(analysisId);
    if (!existing) throw new Error(`Analysis ${analysisId} not found`);
    const merged = { ...existing, ...patch, id: existing.id, groundId: existing.groundId, updatedAt: Date.now() };
    const updated = StorageManager.#migrateAnalysisShape(merged);
    await maybeWritePartitionPrimary('analysis', updated);
    await StorageManager.#set({ [`analyses:${analysisId}`]: updated });
    Logger.info('StorageManager', `Analysis updated: ${analysisId}`);
    return updated;
  }

  // ─── v2.65.0 (Pass 2) — Observation storage ────────────────────────────
  //
  // Foundation only. Observations are the third primitive (Fragment /
  // Observation / Analysis). They observe page state and produce data
  // into scope — the page→data direction. EXTRACT and ENUMERATE today
  // live as Fragment actions; eventually they migrate to Observations.
  //
  // Pass 2 ships storage + library section + design doc. NO authoring
  // flow, NO runtime path, NO strategy DSL changes, NO migration. The
  // visible result: Observations exist as registered records in storage
  // and as a section in the Ground card. Strategies cannot reference
  // them yet.
  //
  // Storage shape minimal for v1:
  //   {
  //     id, groundId, name, description,
  //     shape: 'text' | 'attribute' | 'list_of_records' | 'raw_html' | …
  //   }
  //
  // Shape is the architecturally significant field — it determines
  // authoring flow (per-shape forms), runtime extraction logic, and
  // post-condition vocabulary. Committing it in storage from day one
  // makes future iterations cleaner. Detailed implementation fields
  // (target selector, field selectors, etc.) are added per-shape when
  // authoring flow lands.

  // v2.72.11 (Pass 8) — Observation tier shape migration. (Originally
  // lifted top-level target/extract/fields under implementations[0] with
  // tier='cache'.)
  // v2.74.15 (Ship A) — Observation refactor introduced a new shape:
  //   implementations: [{ tier, extracts: [{shape, target, output, ...}, ...] }]
  // Per the Ship A plan, no migration is performed. Old observations
  // pass through as-is (they may fail to load/run in the new code paths,
  // and authors are expected to re-author or wipe).
  //
  // v2.74.131 — Active again. The observation-shape split (scalar →
  // text + attribute, raw_text folded into text) needs in-place
  // rewriting on read so authors editing an old observation see it as
  // the new shape names. Migration is read-only here — the storage
  // record stays in the old shape until the next saveObservation
  // through the form (which will write the new shape because the form
  // operates on this migrated copy).
  //
  // Walks implementations[0].extracts and rewrites each extract's shape
  // field plus shape-specific sub-fields. Idempotent — already-new
  // shapes pass through unchanged.
  static #migrateObservationShape(obs) {
    if (!obs || typeof obs !== 'object') return obs;
    const impls = Array.isArray(obs.implementations) ? obs.implementations : null;
    if (!impls || impls.length === 0) return obs;
    const impl0 = impls[0];
    if (!impl0 || !Array.isArray(impl0.extracts)) return obs;

    const newExtracts = impl0.extracts.map((ex) => {
      if (!ex || typeof ex !== 'object') return ex;
      // raw_text → text (functionally identical: el.textContent.trim()).
      if (ex.shape === 'raw_text') {
        const { extract, ...rest } = ex;
        return { ...rest, shape: 'text' };
      }
      // scalar → text (when extract.kind === 'text') or attribute (kind === 'attribute').
      if (ex.shape === 'scalar') {
        const kind = ex.extract?.kind ?? 'text';
        if (kind === 'attribute') {
          const attrName = ex.extract?.attr ?? ex.extract?.name ?? '';
          const { extract, ...rest } = ex;
          return { ...rest, shape: 'attribute', attribute: attrName };
        }
        const { extract, ...rest } = ex;
        return { ...rest, shape: 'text' };
      }
      return ex;
    });

    // Only rewrite when at least one extract actually changed.
    const changed = newExtracts.some((ex, i) => ex !== impl0.extracts[i]);
    if (!changed) return obs;

    return {
      ...obs,
      implementations: [
        { ...impl0, extracts: newExtracts },
        ...impls.slice(1),
      ],
    };
  }

  static async saveObservation(observation) {
    if (!observation?.id || !observation?.groundId) {
      throw new Error('saveObservation requires { id, groundId }');
    }
    const existing = await StorageManager.getObservation(observation.id);
    if (existing && existing.groundId !== observation.groundId) {
      throw new Error(`Observation ${observation.id} already exists on ground ${existing.groundId}; cannot reassign to ${observation.groundId}`);
    }
    // v2.72.11 (Pass 8) — defensive migration on save. The form writes the
    // new shape directly, but anything bypassing the form (JSON modal,
    // direct API, migration tool) gets canonicalized here.
    const migrated = StorageManager.#migrateObservationShape(observation);
    const toSave = { ...migrated, updatedAt: Date.now() };
    await maybeWritePartitionPrimary('observation', toSave);
    // v2.74.119 — Serialized index add.
    const indexKey = `observations:index:${migrated.groundId}`;
    await StorageManager.#addToIndex(indexKey, migrated.id);
    await StorageManager.#set({
      [`observations:${migrated.id}`]: toSave,
    });
    Logger.info('StorageManager', `Observation saved: ${migrated.id} (${migrated.name ?? 'unnamed'}) on ground ${migrated.groundId}`);
  }

  static async getObservation(observationId) {
    const fromPartition = await maybeReadPartition('observation', observationId);
    if (fromPartition) return StorageManager.#migrateObservationShape(fromPartition);
    const data = await StorageManager.#get(`observations:${observationId}`);
    const raw = data[`observations:${observationId}`] ?? null;
    return raw ? StorageManager.#migrateObservationShape(raw) : null;
  }

  static async listObservations(groundId) {
    const fromPartition = await maybeListPartition('observation', groundId);
    if (fromPartition !== null) {
      return fromPartition
        .map((raw) => (raw ? StorageManager.#migrateObservationShape(raw) : null))
        .filter(Boolean);
    }
    const indexKey = `observations:index:${groundId}`;
    const indexData = await StorageManager.#get(indexKey);
    const ids = indexData[indexKey] ?? [];
    if (ids.length === 0) return [];
    const keys = ids.map(id => `observations:${id}`);
    const data = await new Promise(res => chrome.storage.local.get(keys, res));
    const missing = ids.filter(id => !data[`observations:${id}`]);
    if (missing.length > 0) {
      Logger.warn('StorageManager', `listObservations(${groundId}): index has ${missing.length} id(s) with no matching record — ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
    }
    // v2.72.11 (Pass 8) — apply migration per record.
    return ids.map(id => {
      const raw = data[`observations:${id}`];
      return raw ? StorageManager.#migrateObservationShape(raw) : null;
    }).filter(Boolean);
  }

  static async deleteObservation(observationId) {
    const observation = await StorageManager.getObservation(observationId);
    if (!observation) return;
    await maybeRemovePartitionPrimary('observation', /** @type {Record<string, unknown>} */ (observation));
    // v2.74.119 — Serialized index removal.
    const indexKey = `observations:index:${observation.groundId}`;
    await StorageManager.#removeFromIndex(indexKey, observationId);
    await StorageManager.#remove([`observations:${observationId}`]);
    Logger.info('StorageManager', `Observation deleted: ${observationId}`);
  }

  // ─── v2.42.0 (Pass M2) — Named assertion storage ──────────────────────
  // Same shape as fragments: records keyed by id, per-ground index.
  //
  //   {
  //     id, groundId, name, description?,
  //     body: { match: 'all'|'any', conditions: [...] },   // a Assertion
  //     createdAt, updatedAt
  //   }
  //
  // Assertions are scoped to a ground (consistent with fragments — a
  // selector that means something on Indeed doesn't on LinkedIn). The
  // body is a Assertion per Services/Assertion.js, so it can contain
  // primitive conditions or `assertion_ref` references to other named
  // assertions on the same ground.
  //
  // v2.72.28 (Pass 16) — Assertion authoring metadata.
  //   authoredBy: 'human' | 'model'  — diagnostic; tells the library card
  //                                    whether to show a "generated" badge
  //   authoredAt: timestamp           — when authoring occurred
  // Assertions are vocabulary, not primitives. Runtime tier doesn't apply
  // (assertions always evaluate deterministically once flattened). These
  // fields are diagnostic only — the runtime evaluator never reads them.
  // Migration on read defaults authoredBy='human' and authoredAt=updatedAt
  // for records saved before this pass.
  static #migrateAssertionShape(assertion) {
    if (!assertion || typeof assertion !== 'object') return assertion;
    if (typeof assertion.authoredBy === 'string' && assertion.authoredBy) {
      return assertion;
    }
    return {
      ...assertion,
      authoredBy: 'human',
      authoredAt: assertion.authoredAt ?? assertion.updatedAt ?? Date.now(),
    };
  }

  static async saveAssertion(assertion) {
    if (!assertion?.id || !assertion?.groundId) {
      throw new Error('saveAssertion requires { id, groundId }');
    }
    if (!assertion?.name || !String(assertion.name).trim()) {
      throw new Error('saveAssertion requires a non-empty name');
    }
    const existing = await StorageManager.getAssertion(assertion.id);
    if (existing && existing.groundId !== assertion.groundId) {
      throw new Error(`Assertion ${assertion.id} already exists on ground ${existing.groundId}; cannot reassign to ${assertion.groundId}`);
    }
    // v2.74.119 — Serialized index add.
    const indexKey = `assertions:index:${assertion.groundId}`;
    await StorageManager.#addToIndex(indexKey, assertion.id);
    const now = Date.now();
    // v2.72.28 (Pass 16) — default authoredBy to 'human' on save when not
    // explicitly set; the studio Generate path sets 'model' explicitly.
    const authoredBy = (assertion.authoredBy === 'model') ? 'model' : 'human';
    const authoredAt = assertion.authoredAt ?? now;
    const toSave = {
      ...assertion,
      authoredBy,
      authoredAt,
      createdAt: assertion.createdAt ?? now,
      updatedAt: now,
    };
    await maybeWritePartitionPrimary('assertion', toSave);
    await StorageManager.#set({
      [`assertions:${assertion.id}`]: toSave,
    });
    Logger.info('StorageManager', `Assertion saved: ${assertion.id} (${assertion.name}) on ground ${assertion.groundId} [${authoredBy}]`);
  }

  static async getAssertion(assertionId) {
    const fromPartition = await maybeReadPartition('assertion', assertionId);
    if (fromPartition) return StorageManager.#migrateAssertionShape(fromPartition);
    const data = await StorageManager.#get(`assertions:${assertionId}`);
    const pred = data[`assertions:${assertionId}`] ?? null;
    return pred ? StorageManager.#migrateAssertionShape(pred) : null;
  }

  static async listAssertions(groundId) {
    const fromPartition = await maybeListPartition('assertion', groundId);
    if (fromPartition !== null) {
      return fromPartition
        .filter(Boolean)
        .map((p) => StorageManager.#migrateAssertionShape(p));
    }
    const indexKey = `assertions:index:${groundId}`;
    const indexData = await StorageManager.#get(indexKey);
    const ids = indexData[indexKey] ?? [];
    if (ids.length === 0) return [];
    const keys = ids.map(id => `assertions:${id}`);
    const data = await new Promise(res => chrome.storage.local.get(keys, res));
    const missing = ids.filter(id => !data[`assertions:${id}`]);
    if (missing.length > 0) {
      Logger.warn('StorageManager', `listAssertions(${groundId}): index has ${missing.length} id(s) with no matching record — ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
    }
    return ids.map(id => data[`assertions:${id}`]).filter(Boolean)
      .map(p => StorageManager.#migrateAssertionShape(p));
  }

  static async deleteAssertion(assertionId) {
    const pred = await StorageManager.getAssertion(assertionId);
    if (!pred) return;
    await maybeRemovePartitionPrimary('assertion', /** @type {Record<string, unknown>} */ (pred));
    // v2.74.119 — Serialized index removal.
    const indexKey = `assertions:index:${pred.groundId}`;
    await StorageManager.#removeFromIndex(indexKey, assertionId);
    await StorageManager.#remove([`assertions:${assertionId}`]);
    Logger.info('StorageManager', `Assertion deleted: ${assertionId}`);
  }

  static async updateAssertion(assertionId, patch) {
    const existing = await StorageManager.getAssertion(assertionId);
    if (!existing) throw new Error(`Assertion ${assertionId} not found`);
    const updated = {
      ...existing, ...patch,
      id: existing.id, groundId: existing.groundId,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    await maybeWritePartitionPrimary('assertion', updated);
    await StorageManager.#set({ [`assertions:${assertionId}`]: updated });
    Logger.info('StorageManager', `Assertion updated: ${assertionId}`);
    return updated;
  }

  // ── Perspectives ─────────────────────────────────────────────────────────────
  //
  // v2.72.29 (Pass 17) — Perspectives are verified DOM landmark records.
  // Architecturally, they're the persistent form of "this kind of page
  // exists; here are its structural elements." Authored once with live
  // DOM verification; re-verifiable to detect drift; referenced by other
  // primitives' contracts via the `perspective_ref` condition type.
  //
  // Storage shape:
  //   {
  //     id, groundId, name, description,
  //     urlPattern,           — substring or /regex/ match against URL
  //     landmarks: [          — array of named verified selectors
  //       { role, selector, verified: { verifiedAt, verifiedAgainstUrl,
  //                                     matchedCount, sampleHtml } }
  //     ],
  //     authoredBy, authoredAt, createdAt, updatedAt
  //   }
  //
  // See StorageManager top-of-file architectural docstring for the
  // primitive/vocabulary distinction and where Perspectives fit.
  // v2.74.332 — PERSPECTIVE_SPEC § 3 Layer 2 composition. Ensure `landmarks` is a
  // LandmarkNode[] (canonical) and `landmarkRefs` is its flat-UID mirror.
  // Builds nodes from legacy `landmarkRefs[uid]` (or legacy embedded full
  // records) when the record predates Layer 2; preserves authored structure
  // when nodes already carry relationships. Used on read (migrate) AND write
  // (save/update) so the persisted shape converges.
  static #withPerspectiveComposition(loc) {
    if (!loc || typeof loc !== 'object') return loc;
    const nodes = deriveLandmarkNodes(loc);
    return {
      ...loc,
      landmarks: nodes,
      landmarkRefs: flattenLandmarkNodes(nodes),
      // v2.74.335 — PERSPECTIVE_SPEC § 12 lifecycle. Perspectives are saved=active;
      // only the 'deprecated' soft-delete state is meaningfully persisted.
      lifecycle: loc.lifecycle === 'deprecated' ? 'deprecated' : 'active',
    };
  }

  static #migratePerspectiveShape(loc) {
    if (!loc || typeof loc !== 'object') return loc;
    // Composition normalization runs unconditionally (independent of the
    // authoredBy back-compat check below).
    const composed = StorageManager.#withPerspectiveComposition(loc);
    if (typeof composed.authoredBy === 'string' && composed.authoredBy) return composed;
    return {
      ...composed,
      authoredBy: 'human',
      authoredAt: composed.authoredAt ?? composed.updatedAt ?? Date.now(),
    };
  }

  static async savePerspective(perspective) {
    if (!perspective?.id || !perspective?.groundId) {
      throw new Error('savePerspective requires { id, groundId }');
    }
    if (!perspective?.name || !String(perspective.name).trim()) {
      throw new Error('savePerspective requires a non-empty name');
    }
    const existing = await StorageManager.getPerspective(perspective.id);
    if (existing && existing.groundId !== perspective.groundId) {
      throw new Error(`Perspective ${perspective.id} already exists on ground ${existing.groundId}; cannot reassign to ${perspective.groundId}`);
    }
    // v2.74.119 — Serialized index add.
    const indexKey = `perspectives:index:${perspective.groundId}`;
    await StorageManager.#addToIndex(indexKey, perspective.id);
    const now = Date.now();
    const authoredBy = (perspective.authoredBy === 'model') ? 'model' : 'human';
    const authoredAt = perspective.authoredAt ?? now;
    // v2.74.332 — Persist the canonical Layer 2 composition: LandmarkNode[]
    // + the flat landmarkRefs mirror, regardless of which shape the caller
    // passed (perspective-capture writes landmarkRefs and drops landmarks).
    const composed = StorageManager.#withPerspectiveComposition(perspective);
    const toSave = {
      ...composed,
      authoredBy,
      authoredAt,
      createdAt: perspective.createdAt ?? now,
      updatedAt: now,
    };
    await maybeWritePartitionPrimary('perspective', toSave);
    await StorageManager.#set({
      [`perspectives:${perspective.id}`]: toSave,
    });
    Logger.info('StorageManager', `Perspective saved: ${perspective.id} (${perspective.name}) on ground ${perspective.groundId} [${authoredBy}, ${(composed.landmarks ?? []).length} landmark node(s)]`);
  }

  static async getPerspective(perspectiveId) {
    const fromPartition = await maybeReadPartition('perspective', perspectiveId);
    if (fromPartition) return StorageManager.#migratePerspectiveShape(fromPartition);
    const data = await StorageManager.#get(`perspectives:${perspectiveId}`);
    const loc = data[`perspectives:${perspectiveId}`] ?? null;
    return loc ? StorageManager.#migratePerspectiveShape(loc) : null;
  }

  static async listPerspectives(groundId) {
    const fromPartition = await maybeListPartition('perspective', groundId);
    if (fromPartition !== null) {
      return fromPartition
        .filter(Boolean)
        .map((l) => StorageManager.#migratePerspectiveShape(l));
    }
    const indexKey = `perspectives:index:${groundId}`;
    const indexData = await StorageManager.#get(indexKey);
    const ids = indexData[indexKey] ?? [];
    if (ids.length === 0) return [];
    const keys = ids.map(id => `perspectives:${id}`);
    const data = await new Promise(res => chrome.storage.local.get(keys, res));
    const missing = ids.filter(id => !data[`perspectives:${id}`]);
    if (missing.length > 0) {
      Logger.warn('StorageManager', `listPerspectives(${groundId}): index has ${missing.length} id(s) with no matching record — ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
    }
    return ids.map(id => data[`perspectives:${id}`]).filter(Boolean)
      .map(l => StorageManager.#migratePerspectiveShape(l));
  }

  static async deletePerspective(perspectiveId) {
    const loc = await StorageManager.getPerspective(perspectiveId);
    if (!loc) return;
    await maybeRemovePartitionPrimary('perspective', /** @type {Record<string, unknown>} */ (loc));
    // v2.74.119 — Serialized index removal.
    const indexKey = `perspectives:index:${loc.groundId}`;
    await StorageManager.#removeFromIndex(indexKey, perspectiveId);
    await StorageManager.#remove([`perspectives:${perspectiveId}`]);
    Logger.info('StorageManager', `Perspective deleted: ${perspectiveId}`);
  }

  static async updatePerspective(perspectiveId, patch) {
    const existing = await StorageManager.getPerspective(perspectiveId);
    if (!existing) throw new Error(`Perspective ${perspectiveId} not found`);
    // v2.74.332 — Re-normalize composition after merge (a patch may change
    // landmarks/landmarkRefs; keep nodes + mirror consistent).
    const updated = StorageManager.#withPerspectiveComposition({
      ...existing, ...patch,
      id: existing.id, groundId: existing.groundId,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    });
    await maybeWritePartitionPrimary('perspective', updated);
    await StorageManager.#set({ [`perspectives:${perspectiveId}`]: updated });
    Logger.info('StorageManager', `Perspective updated: ${perspectiveId}`);
    return updated;
  }

  // ─── v2.74.240 — Landmark registry (Phase 2 of substrate spec) ───
  //
  // Top-level per-Ground registry indexed by UID. Mirrors the perspective
  // storage pattern:
  //   landmarks:index:{groundId}  → ordered list of UIDs in that ground
  //   landmarks:{uid}             → full landmark record
  //
  // Same-UID writes intentionally OVERWRITE — per the spec, two
  // landmarks with the same canonical inputs ARE the same landmark.
  // Save semantics: last-write-wins. Cross-perspective sharing (multiple
  // Perspectives referencing the same UID) gets one canonical record.

  static async saveLandmark(landmark) {
    if (!landmark?.uid)      throw new Error('saveLandmark requires { uid }');
    if (!landmark?.groundId) throw new Error('saveLandmark requires { groundId }');
    const existing = await StorageManager.getLandmark(landmark.uid);
    if (existing && existing.groundId !== landmark.groundId) {
      // v2.74.341 — Canonical UIDs are global (same element → same UID), but
      // a landmark record is bound to one Ground. When the existing record's
      // Ground was DELETED (orphaned — GROUND_SPEC § 11 preserves landmark
      // records on ground delete), RE-HOME the landmark to the new Ground
      // rather than refusing. This realizes § 11's intent: "recreate a
      // similar Ground for the same site → captured landmarks can be reused."
      // Only refuse when the old Ground still EXISTS (a genuine live
      // cross-Ground conflict the per-Ground registry model doesn't support).
      const oldGround = await StorageManager.getGround(existing.groundId);
      if (oldGround) {
        throw new Error(`Landmark ${landmark.uid} already exists on ground ${existing.groundId}; cannot reassign to ${landmark.groundId}`);
      }
      try {
        await StorageManager.#removeFromIndex(`landmarks:index:${existing.groundId}`, landmark.uid);
      } catch { /* old index already gone — fine */ }
      Logger.info('StorageManager', `Landmark ${landmark.uid} re-homed from orphaned ground ${existing.groundId} → ${landmark.groundId}`);
    }
    const indexKey = `landmarks:index:${landmark.groundId}`;
    await StorageManager.#addToIndex(indexKey, landmark.uid);
    const now = Date.now();
    const merged = {
      ...landmark,
      createdAt : existing?.createdAt ?? landmark.createdAt ?? now,
      updatedAt : now,
      lifecycle : landmark.lifecycle ?? existing?.lifecycle ?? 'fresh',
    };
    await maybeWritePartitionPrimary('landmark', merged);
    await StorageManager.#set({ [`landmarks:${landmark.uid}`]: merged });
    Logger.debug('StorageManager', `Landmark saved: ${landmark.uid} (a11yRole=${landmark.a11yRole ?? '?'}, alias=${landmark.alias ?? '?'}, name="${(landmark.accessibleName ?? '').slice(0, 40)}") on ground ${landmark.groundId}`);
    return merged;
  }

  static async getLandmark(uid) {
    const fromPartition = await maybeReadPartition('landmark', uid);
    if (fromPartition) return fromPartition;
    const data = await StorageManager.#get(`landmarks:${uid}`);
    return data[`landmarks:${uid}`] ?? null;
  }

  /**
   * Fetch multiple landmarks by UID in one read. Returns an object
   * map { uid → landmark|null } preserving order of the input array.
   * Missing UIDs map to null so callers can detect orphan refs.
   */
  static async getLandmarks(uids) {
    if (!Array.isArray(uids) || uids.length === 0) return {};
    const keys = uids.map(uid => `landmarks:${uid}`);
    const data = await new Promise(res => chrome.storage.local.get(keys, res));
    const out = {};
    for (const uid of uids) out[uid] = data[`landmarks:${uid}`] ?? null;
    return out;
  }

  static async listLandmarksForGround(groundId) {
    const fromPartition = await maybeListPartition('landmark', groundId);
    if (fromPartition !== null) return fromPartition.filter(Boolean);
    const indexKey = `landmarks:index:${groundId}`;
    const indexData = await StorageManager.#get(indexKey);
    const uids = indexData[indexKey] ?? [];
    if (uids.length === 0) return [];
    const keys = uids.map(u => `landmarks:${u}`);
    const data = await new Promise(res => chrome.storage.local.get(keys, res));
    const missing = uids.filter(u => !data[`landmarks:${u}`]);
    if (missing.length > 0) {
      Logger.warn('StorageManager', `listLandmarksForGround(${groundId}): index has ${missing.length} uid(s) with no matching record`);
    }
    return uids.map(u => data[`landmarks:${u}`]).filter(Boolean);
  }

  static async deleteLandmark(uid) {
    const lm = await StorageManager.getLandmark(uid);
    if (!lm) return;
    await maybeRemovePartitionPrimary('landmark', /** @type {Record<string, unknown>} */ (lm));
    const indexKey = `landmarks:index:${lm.groundId}`;
    await StorageManager.#removeFromIndex(indexKey, uid);
    await StorageManager.#remove([`landmarks:${uid}`]);
    Logger.info('StorageManager', `Landmark deleted: ${uid} on ground ${lm.groundId}`);
  }

  static async updateLandmark(uid, patch) {
    const existing = await StorageManager.getLandmark(uid);
    if (!existing) throw new Error(`Landmark ${uid} not found`);
    const updated = {
      ...existing, ...patch,
      uid       : existing.uid,
      groundId  : existing.groundId,
      createdAt : existing.createdAt,
      updatedAt : Date.now(),
    };
    await maybeWritePartitionPrimary('landmark', updated);
    await StorageManager.#set({ [`landmarks:${uid}`]: updated });
    Logger.debug('StorageManager', `Landmark updated: ${uid}`);
    return updated;
  }

  /**
   * Pass B+ — Resolve the full antecedent chain for a Fragment.
   *
   * A Fragment may reference an antecedent Fragment that must run first to
   * establish the starting state. That antecedent may itself have an
   * antecedent, and so on. This method walks the chain transitively and
   * returns the ordered list [root ancestor, ..., direct antecedent] —
   * the list does NOT include `fragmentId` itself.
   *
   * Detects cycles. If a cycle is found, throws. The caller should reject
   * antecedent selections that would introduce a cycle at form-save time,
   * but this is the last line of defense at walk-time.
   *
   * If a referenced fragmentId doesn't resolve (orphan reference), that's
   * treated as a hard error — the chain is broken.
   *
   * @param {string} fragmentId
   * @returns {Promise<Array<Object>>} Fragment records in replay order.
   *          Empty array means this Fragment has no antecedent.
   */
  static async resolveAntecedentChain(fragmentId) {
    const chain = [];
    const visited = new Set([fragmentId]);
    let cursor = fragmentId;

    while (true) {
      const frag = await StorageManager.getFragment(cursor);
      if (!frag) throw new Error(`Antecedent chain broken: Fragment ${cursor} not found`);
      const next = frag.antecedentFragmentId ?? null;
      if (!next) break;
      if (visited.has(next)) {
        throw new Error(`Antecedent chain cycle detected: ${next} revisited`);
      }
      visited.add(next);
      const antecedent = await StorageManager.getFragment(next);
      if (!antecedent) throw new Error(`Antecedent chain broken: Fragment ${next} not found`);
      chain.unshift(antecedent);   // insert at front so order is root → direct antecedent
      cursor = next;
    }

    return chain;
  }

  /**
   * Pass B+ — Check whether making `candidateAntecedentId` the antecedent of
   * `fragmentId` would introduce a cycle. Used by the Fragment form to reject
   * invalid antecedent selections before save.
   *
   * Returns true if the choice is safe (no cycle), false otherwise.
   *
   * @param {string} fragmentId - the Fragment being edited (may be a brand-new id not yet persisted)
   * @param {string} candidateAntecedentId
   */
  static async wouldCreateCycle(fragmentId, candidateAntecedentId) {
    if (!candidateAntecedentId) return false;
    if (candidateAntecedentId === fragmentId) return true;

    // Walk up from candidateAntecedentId; if we ever reach fragmentId, there's a cycle
    const visited = new Set();
    let cursor = candidateAntecedentId;
    while (cursor) {
      if (visited.has(cursor)) return true;   // pre-existing cycle in the data
      if (cursor === fragmentId)   return true;
      visited.add(cursor);
      const frag = await StorageManager.getFragment(cursor);
      if (!frag) return false;   // broken chain — not a cycle we're introducing
      cursor = frag.antecedentFragmentId ?? null;
    }
    return false;
  }

  // v2.72.24 (Pass 13) — Strategy pre/post envelope migration. Mirrors the
  // Analysis envelope. Strategies authored before this pass have no
  // preconditions or postconditions field; default to empty envelopes.
  // Records that already have envelopes pass through unchanged. Records
  // that have flat condition arrays (theoretical, none today) get wrapped.
  // Idempotent.
  //
  // v2.72.27 (Pass 15) — Also lift fragmentSteps under an implementations
  // envelope for tier infrastructure. Legacy strategies (top-level
  // fragmentSteps array, no implementations) get:
  //   {implementations: [{tier: 'cache', body: {tree: {fragmentSteps}}}]}
  // Top-level fragmentSteps is also kept as a mirror so consumers reading
  // strategy.fragmentSteps continue to work. The envelope is the new
  // canonical store; mirror is updated from envelope on read.
  // Idempotent: records already with implementations pass through (mirror
  // resync'd from body.tree).
  static #migrateStrategyShape(strategy) {
    if (!strategy || typeof strategy !== 'object') return strategy;
    const wrapEnvelope = (v) => {
      if (!v) return { match: 'all', conditions: [] };
      if (typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.conditions)) {
        return {
          match: v.match === 'any' ? 'any' : (v.match === 'k_of_n' ? 'k_of_n' : 'all'),
          conditions: v.conditions,
          ...(typeof v.count === 'number' ? { count: v.count } : {}),
        };
      }
      if (Array.isArray(v)) {
        return { match: 'all', conditions: v };
      }
      return { match: 'all', conditions: [] };
    };

    // Step 1: pre/post envelope wrap (Pass 13 behavior)
    const result = {
      ...strategy,
      preconditions:  wrapEnvelope(strategy.preconditions),
      postconditions: wrapEnvelope(strategy.postconditions),
    };

    // Step 2: implementations envelope (Pass 15 behavior)
    let implementations = Array.isArray(strategy.implementations) && strategy.implementations.length > 0
      ? strategy.implementations
      : null;
    if (!implementations) {
      // Legacy: lift top-level fragmentSteps to cache-tier body.tree.
      const steps = Array.isArray(strategy.fragmentSteps) ? strategy.fragmentSteps : [];
      implementations = [{
        tier: 'cache',
        body: { tree: { fragmentSteps: steps } },
      }];
    }
    result.implementations = implementations;

    // Step 3: synthesize the top-level fragmentSteps mirror from the
    // canonical envelope. For cache-tier impls with body.tree.fragmentSteps,
    // mirror them. For frontier-tier (no body.tree), mirror is empty.
    const impl0 = implementations[0];
    if (impl0?.tier === 'cache' && Array.isArray(impl0?.body?.tree?.fragmentSteps)) {
      result.fragmentSteps = impl0.body.tree.fragmentSteps;
    } else {
      result.fragmentSteps = [];
    }

    return result;
  }

  // ── Strategies ───────────────────────────────────────────────────────────

  static async saveStrategy(strategy) {
    if (!strategy?.id || !strategy?.groundId) {
      throw new Error('saveStrategy requires { id, groundId }');
    }
    // B1 guard: same as saveFragment — refuse cross-Ground id reuse.
    const existing = await StorageManager.getStrategy(strategy.id);
    if (existing && existing.groundId !== strategy.groundId) {
      throw new Error(`Strategy ${strategy.id} already exists on ground ${existing.groundId}; cannot reassign to ${strategy.groundId}`);
    }
    // v2.72.24 (Pass 13) — defensive migration on save. Form writes envelope
    // shape directly; this canonicalizes anything bypassing the form.
    const migrated = StorageManager.#migrateStrategyShape(strategy);
    // v2.74.119 — Serialized index add.
    const indexKey = `strategies:index:${migrated.groundId}`;
    await StorageManager.#addToIndex(indexKey, migrated.id);
    await StorageManager.#set({
      [`strategies:${migrated.id}`]: { ...migrated, updatedAt: Date.now() },
    });
    Logger.info('StorageManager', `Strategy saved: ${migrated.id} (${migrated.name ?? 'unnamed'}) on ground ${migrated.groundId}`);
  }

  static async getStrategy(strategyId) {
    const data = await StorageManager.#get(`strategies:${strategyId}`);
    const strategy = data[`strategies:${strategyId}`] ?? null;
    if (strategy) {
      // v2.59.0 — load-time params normalization. Legacy strategies stored
      // params as ['NAME', ...]; canonical form is [{name, kind}, ...].
      // Normalizing here means every consumer sees the canonical shape.
      strategy.params = normalizeStrategyParams(strategy.params);
      // v2.72.24 (Pass 13) — pre/post envelopes on read.
      // v2.72.27 (Pass 15) — implementations envelope on read; fragmentSteps
      // mirror refreshed from body.tree so consumers reading top-level
      // fragmentSteps continue to work.
      const migrated = StorageManager.#migrateStrategyShape(strategy);
      strategy.preconditions  = migrated.preconditions;
      strategy.postconditions = migrated.postconditions;
      strategy.implementations = migrated.implementations;
      strategy.fragmentSteps = migrated.fragmentSteps;
    }
    return strategy;
  }

  static async listStrategies(groundId) {
    const indexKey = `strategies:index:${groundId}`;
    const indexData = await StorageManager.#get(indexKey);
    const ids = indexData[indexKey] ?? [];
    if (ids.length === 0) return [];
    const keys = ids.map(id => `strategies:${id}`);
    const data = await new Promise(res => chrome.storage.local.get(keys, res));
    // B2: surface index/record drift.
    const missing = ids.filter(id => !data[`strategies:${id}`]);
    if (missing.length > 0) {
      Logger.warn('StorageManager', `listStrategies(${groundId}): index has ${missing.length} id(s) with no matching record — ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
    }
    return ids.map(id => data[`strategies:${id}`]).filter(Boolean).map(s => {
      // v2.59.0 — same load-time normalization as getStrategy.
      s.params = normalizeStrategyParams(s.params);
      // v2.72.24 (Pass 13) + v2.72.27 (Pass 15) — full migration.
      const migrated = StorageManager.#migrateStrategyShape(s);
      s.preconditions  = migrated.preconditions;
      s.postconditions = migrated.postconditions;
      s.implementations = migrated.implementations;
      s.fragmentSteps = migrated.fragmentSteps;
      return s;
    });
  }

  static async getAllStrategies() {
    const groundIds = await StorageManager.#getGroundIndex();
    const all = [];
    for (const gid of groundIds) {
      const strs = await StorageManager.listStrategies(gid);
      all.push(...strs);
    }
    return all;
  }

  static async deleteStrategy(strategyId) {
    const strat = await StorageManager.getStrategy(strategyId);
    if (!strat) return;
    // v2.74.119 — Serialized index removal.
    const indexKey = `strategies:index:${strat.groundId}`;
    await StorageManager.#removeFromIndex(indexKey, strategyId);
    await StorageManager.#remove([`strategies:${strategyId}`, `strategy-walk:${strategyId}`]);
    Logger.info('StorageManager', `Strategy deleted: ${strategyId}`);
  }

  static async updateStrategy(strategyId, patch) {
    const existing = await StorageManager.getStrategy(strategyId);
    if (!existing) throw new Error(`Strategy ${strategyId} not found`);
    const updated = { ...existing, ...patch, id: existing.id, groundId: existing.groundId, updatedAt: Date.now() };
    await StorageManager.#set({ [`strategies:${strategyId}`]: updated });
    return updated;
  }

  // ── Workflows (v2.74.70) ─────────────────────────────────────────────────
  //
  // Workflows are a top-level entity — they do NOT belong to a Ground.
  // Conceptually a Workflow composes one or more Strategies (potentially
  // across different Grounds) into a higher-level orchestration. The first
  // shipped pass keeps the body minimal:
  //
  //   {
  //     id, name, description,
  //     steps: [],          // future: [{strategyId, paramBindings}, ...]
  //     createdAt, updatedAt
  //   }
  //
  // Storage layout mirrors Strategies but without the per-Ground index:
  //   workflows:index   → string[] of workflow ids
  //   workflows:<id>    → record
  //
  // No migration is needed — pre-v2.74.70 storage has no workflows: keys,
  // listWorkflows() returns [] on a missing index and authoring builds the
  // index lazily on first save.

  static async saveWorkflow(workflow) {
    if (!workflow?.id) throw new Error('saveWorkflow requires { id }');
    // v2.74.119 — Serialized index add.
    const indexKey = 'workflows:index';
    await StorageManager.#addToIndex(indexKey, workflow.id);
    // updatedAt always stamped here; createdAt preserved if present.
    // v2.74.72 — params normalized through the canonical typed-input shape
    // so hand-edited / legacy records reach storage in the form the
    // invocation runtime expects.
    const existing = (await StorageManager.#get(`workflows:${workflow.id}`))[`workflows:${workflow.id}`];
    const record = {
      ...workflow,
      steps     : Array.isArray(workflow.steps) ? workflow.steps : [],
      params    : normalizeStrategyParams(workflow.params),
      createdAt : workflow.createdAt ?? existing?.createdAt ?? Date.now(),
      updatedAt : Date.now(),
    };
    await StorageManager.#set({ [`workflows:${workflow.id}`]: record });
    Logger.info('StorageManager', `Workflow saved: ${record.id} (${record.name ?? 'unnamed'})`);
    return record;
  }

  static async getWorkflow(workflowId) {
    const data = await StorageManager.#get(`workflows:${workflowId}`);
    const w = data[`workflows:${workflowId}`] ?? null;
    // v2.74.72 — load-time params normalization. Mirrors getStrategy.
    if (w) w.params = normalizeStrategyParams(w.params);
    return w;
  }

  static async listWorkflows() {
    const indexKey = 'workflows:index';
    const indexData = await StorageManager.#get(indexKey);
    const ids = indexData[indexKey] ?? [];
    if (ids.length === 0) return [];
    const keys = ids.map(id => `workflows:${id}`);
    const data = await new Promise(res => chrome.storage.local.get(keys, res));
    const missing = ids.filter(id => !data[`workflows:${id}`]);
    if (missing.length > 0) {
      Logger.warn('StorageManager', `listWorkflows: index has ${missing.length} id(s) with no matching record — ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
    }
    return ids.map(id => data[`workflows:${id}`]).filter(Boolean).map(w => {
      // v2.74.72 — load-time params normalization. Mirrors listStrategies.
      w.params = normalizeStrategyParams(w.params);
      return w;
    });
  }

  static async deleteWorkflow(workflowId) {
    // v2.74.119 — Serialized index removal.
    const indexKey = 'workflows:index';
    await StorageManager.#removeFromIndex(indexKey, workflowId);
    await StorageManager.#remove([
      `workflows:${workflowId}`,
      // v2.74.98 — Clean up debugger-persisted breakpoints when the
      // Strategy is deleted. Leaving them would orphan storage and could
      // bind to a future Strategy that happens to recycle the UUID.
      `strategy-breakpoints:${workflowId}`,
    ]);
    Logger.info('StorageManager', `Workflow deleted: ${workflowId}`);
  }

  // ── v2.74.98 — Persistent Strategy debugger breakpoints ────────────────
  //
  // Per-Strategy `number[]` of top-level step indices where the debugger
  // should pause. Stored under `strategy-breakpoints:<workflowId>`.
  // Loaded by the INVOKE_WORKFLOW handler at run start, mutated as the
  // user clicks gutters in the workflow-debug sidepanel, persisted on
  // every mutation so iterative debugging keeps its breakpoints.
  //
  // Cleanup: deleteWorkflow above removes the record alongside the
  // Strategy itself.

  static async getStrategyBreakpoints(workflowId) {
    if (!workflowId) return [];
    const key = `strategy-breakpoints:${workflowId}`;
    const data = await StorageManager.#get(key);
    const list = data[key];
    if (!Array.isArray(list)) return [];
    // v2.74.100 — Breakpoints store as PATH strings ("0", "2.body.1", …)
    // to support nested control-flow targets. Backward-compat: legacy
    // records were `number[]` of top-level indices; coerce each entry to
    // a string so "2" continues to address top-level step idx 2.
    return list
      .filter(v => typeof v === 'string' || Number.isInteger(v))
      .map(v => String(v));
  }

  static async saveStrategyBreakpoints(workflowId, paths) {
    if (!workflowId) return;
    const key = `strategy-breakpoints:${workflowId}`;
    // Accept either string paths or numeric indices (back-compat with old
    // callers). Dedupe; sort lexicographically so the storage record is
    // stable for diff-friendliness.
    const clean = Array.from(
      new Set(
        (paths ?? [])
          .filter(p => typeof p === 'string' || Number.isInteger(p))
          .map(p => String(p))
          .filter(p => p.length > 0)
      )
    ).sort();
    if (clean.length === 0) {
      await StorageManager.#remove([key]);
    } else {
      await StorageManager.#set({ [key]: clean });
    }
  }

  // ── Walk session state ───────────────────────────────────────────────────
  //
  // v2.74.22 — Fragment walk helpers (saveFragmentWalk / getFragmentWalk /
  // deleteFragmentWalk) removed alongside the AI-walked path. Strategy
  // walks still need session state so those helpers stay.

  static async saveStrategyWalk(strategyId, state) {
    await StorageManager.#set({
      [`strategy-walk:${strategyId}`]: { ...state, strategyId, updatedAt: Date.now() },
    });
  }
  static async getStrategyWalk(strategyId) {
    const data = await StorageManager.#get(`strategy-walk:${strategyId}`);
    return data[`strategy-walk:${strategyId}`] ?? null;
  }
  static async deleteStrategyWalk(strategyId) {
    await StorageManager.#remove([`strategy-walk:${strategyId}`]);
  }

  // ── Wipe-and-reset migration to v2.21.0 ──────────────────────────────────
  //
  // User decision: Path-era data is discarded. No backward compatibility.
  // Preserved: Grounds, conversations, API key, preferences.
  // Wiped: all paths:*, trace:*, procedure:*, template:*, questions:*,
  //        profile:*, snapshots:*, authoring-session:*, template_status:*,
  //        template_error:*, paths:index:*, result:*, the old v2.14.0 marker.
  //
  // Runs once, guarded by the v2.21.0 marker. Safe to invoke at every startup.

  static async migrateToFragmentModel() {
    const MARKER_KEY = 'migration:v2.21.0-fragment-strategy-split';
    const data = await StorageManager.#get(MARKER_KEY);
    if (data[MARKER_KEY] === true) return { ran: false, keysRemoved: 0 };

    Logger.info('StorageManager', 'Running v2.21.0 Fragment/Strategy migration — wiping Path-era data…');

    const all = await new Promise((resolve) => chrome.storage.local.get(null, resolve));
    const toRemove = [];
    for (const key of Object.keys(all)) {
      if (
        key.startsWith('paths:') ||
        key.startsWith('trace:') ||
        key.startsWith('procedure:') ||
        key.startsWith('template:') ||
        key.startsWith('template_status:') ||
        key.startsWith('template_error:') ||
        key.startsWith('questions:') ||
        key.startsWith('profile:') ||
        key.startsWith('profiling_status:') ||
        key.startsWith('snapshots:') ||
        key.startsWith('authoring-session:') ||
        key.startsWith('result:') ||
        key === 'migration:v2.14.0-ground-path-split'
      ) {
        toRemove.push(key);
      }
    }

    if (toRemove.length > 0) {
      await StorageManager.#remove(toRemove);
    }

    await StorageManager.#set({ [MARKER_KEY]: true });
    Logger.info('StorageManager', `v2.21.0 migration complete — removed ${toRemove.length} Path-era keys`);
    return { ran: true, keysRemoved: toRemove.length };
  }

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║ v2.72.48 — Predicate → Assertion rename migration.                       ║
  // ║                                                                          ║
  // ║ Renamed in code:                                                         ║
  // ║   - kind: 'predicate' records  → kind: 'assertion'                       ║
  // ║   - predicates:* storage keys  → assertions:*                            ║
  // ║   - predicate_ref condition    → assertion_ref                           ║
  // ║   - predicateId field on conds → assertionId                             ║
  // ║                                                                          ║
  // ║ Migration walks every record in storage that could contain refs:         ║
  // ║   - Top-level predicate records → renamed to assertions                  ║
  // ║   - Strategy.fragmentSteps.{steps,branches}: condition envelopes         ║
  // ║   - Strategy.preconditions / .postconditions                             ║
  // ║   - Fragment.preconditions / .postconditions                             ║
  // ║   - Observation.preconditions / .postconditions                          ║
  // ║   - Analysis.preconditions / .postconditions                             ║
  // ║                                                                          ║
  // ║ Before any writes: a backup snapshot is stored at                        ║
  // ║ `__migration_backup_v2_72_48_assertion_rename`. If migration fails,      ║
  // ║ a manual restore is possible via that key.                               ║
  // ║                                                                          ║
  // ║ Idempotent — guarded by marker key.                                      ║
  // ╚══════════════════════════════════════════════════════════════════════════╝

  static async migrateToAssertionRename() {
    const MARKER_KEY = 'migration:v2.72.48-assertion-rename';
    const BACKUP_KEY = '__migration_backup_v2_72_48_assertion_rename';
    const data = await StorageManager.#get(MARKER_KEY);
    if (data[MARKER_KEY] === true) return { ran: false };

    const all = await new Promise((resolve) => chrome.storage.local.get(null, resolve));

    // Detect whether migration is needed. Two signals:
    //   1. Any 'predicates:*' key
    //   2. Any condition with type === 'predicate_ref' nested in primitives
    let hasOldKeys = Object.keys(all).some(k => k.startsWith('predicates:'));
    if (!hasOldKeys) {
      // Quick scan of all values for any 'predicate_ref' string occurrence —
      // a deep walk is overkill; a string-include check on the whole blob
      // is correct enough for a marker decision.
      const blob = JSON.stringify(all);
      hasOldKeys = blob.includes('"predicate_ref"') || blob.includes('"predicateId"');
    }
    if (!hasOldKeys) {
      // Nothing to migrate. Mark complete and exit.
      await StorageManager.#set({ [MARKER_KEY]: true });
      return { ran: false };
    }

    Logger.info('StorageManager', 'Running v2.72.48 Predicate→Assertion rename migration…');

    // Snapshot first so a botched migration can be restored.
    await StorageManager.#set({ [BACKUP_KEY]: all });
    Logger.info('StorageManager', `Backup written to "${BACKUP_KEY}" (${Object.keys(all).length} keys)`);

    // Walk + rewrite. Mutates a working copy; final state written in one batch.
    const writes = {};
    const removes = [];

    // 1. Rename top-level predicate records.
    for (const key of Object.keys(all)) {
      if (key.startsWith('predicates:')) {
        const newKey = 'assertions:' + key.slice('predicates:'.length);
        const value = all[key];
        if (value && typeof value === 'object') {
          // Update kind on the record itself if present.
          if (value.kind === 'predicate') value.kind = 'assertion';
          // Recursive rewrite of any predicate_ref → assertion_ref inside body.
          StorageManager.#renameAssertionRefsInPlace(value);
        }
        writes[newKey] = value;
        removes.push(key);
      }
    }

    // 2. Rewrite refs in primitive records (fragments, observations, analyses,
    //    strategies). Iterate all keys; for each that's a primitive, walk
    //    pre/post envelopes and step conditions.
    const primitivePrefixes = ['fragments:', 'observations:', 'analyses:', 'strategies:'];
    for (const key of Object.keys(all)) {
      // Skip index keys — they store arrays of ids, no refs to rewrite.
      if (key.includes(':index:')) continue;
      if (!primitivePrefixes.some(p => key.startsWith(p))) continue;
      const value = all[key];
      if (!value || typeof value !== 'object') continue;
      const before = JSON.stringify(value);
      StorageManager.#renameAssertionRefsInPlace(value);
      const after = JSON.stringify(value);
      if (before !== after) {
        writes[key] = value;
      }
    }

    // 3. Apply.
    if (Object.keys(writes).length > 0) {
      await StorageManager.#set(writes);
    }
    if (removes.length > 0) {
      await StorageManager.#remove(removes);
    }
    await StorageManager.#set({ [MARKER_KEY]: true });

    Logger.info(
      'StorageManager',
      `v2.72.48 migration complete — renamed ${removes.length} predicate records, updated ${Object.keys(writes).length - removes.length} primitive records with refs`
    );
    return { ran: true, recordsRenamed: removes.length, refsUpdated: Object.keys(writes).length - removes.length };
  }

  /**
   * v2.72.48 — Recursively walk a value, rewriting `predicate_ref` condition
   * types and `predicateId` field names to their assertion equivalents.
   * Mutates in place. Handles arrays + objects + nested envelopes.
   */
  static #renameAssertionRefsInPlace(value) {
    if (Array.isArray(value)) {
      for (const item of value) {
        StorageManager.#renameAssertionRefsInPlace(item);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;

    // Rename type field if it's the old condition type.
    if (value.type === 'predicate_ref') {
      value.type = 'assertion_ref';
    }
    // Rename predicateId → assertionId if present (and assertionId not already set).
    if (Object.prototype.hasOwnProperty.call(value, 'predicateId')) {
      if (!Object.prototype.hasOwnProperty.call(value, 'assertionId')) {
        value.assertionId = value.predicateId;
      }
      delete value.predicateId;
    }
    // Recurse into all object values.
    for (const k of Object.keys(value)) {
      StorageManager.#renameAssertionRefsInPlace(value[k]);
    }
  }
}
