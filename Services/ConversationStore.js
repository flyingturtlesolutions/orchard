/**
 * @file ConversationStore.js
 * @module ConversationStore
 *
 * Persistence for chat conversations. Each conversation is stored as
 * `conv:<id>` in chrome.storage.local. A separate `conv:index` maintains
 * the ordered list of conversation metadata (id, title, updatedAt) for
 * fast history rendering without loading every body.
 *
 * Design:
 *  - Writes are fire-and-forget awaitable — callers don't have to handle
 *    failures in the happy path, but can if they want.
 *  - The index is the source of truth for "what conversations exist and
 *    in what order." Body reads are on-demand.
 *  - Messages are full objects including markdown flag, outcome, attribution,
 *    and invocationId — everything needed to re-render a completed message.
 *  - In-flight messages (role: 'thinking', no final body yet) are intentionally
 *    NOT persisted. They're transient UI state that dies with the panel.
 */

import { conversationPeek } from '../Core/conversationPeek.js';   // v2.74.1217 — the drawer's under-the-name "quick peek", mirrored into the index on every message finalize

const INDEX_KEY = 'conv:index';

function convKey(id) { return `conv:${id}`; }

// ─── Internal index maintenance helpers ─────────────────────────────────────
// These are module-private — not exported. The public API goes through
// the ConversationStore object below.

// v2.74.109 — Serialize all index read-modify-write ops behind a chain
// promise. Pre-fix, every helper followed the pattern `read → mutate → write`
// without coordination; two callers awaiting `_readIndex()` would each see
// the same snapshot and the second writer would clobber the first's
// modifications. The chain collapses concurrent ops to sequential within
// this page. (Cross-page races — chat sidepanel + studio tab + background
// SW all writing — would still need a CAS retry loop, which isn't worth
// the surface today.)
//
// Pattern: each op runs inside `_serializeIndexOp(() => ...)`, which queues
// it after any in-flight index op. The catch in the chain prevents one
// rejected op from poisoning the queue for subsequent ones.
let _indexChain = Promise.resolve();
function _serializeIndexOp(fn) {
  const next = _indexChain.then(() => fn());
  _indexChain = next.catch(() => {}); // swallow rejections in the chain link
  return next;                         // but propagate them to the caller
}

let _instanceMirrorHealed = false;   // FL-6c (v2.74.1357) — the list() index self-heal runs once per context

async function _readIndex() {
  const data = await chrome.storage.local.get(INDEX_KEY);
  return data[INDEX_KEY] ?? [];
}

async function _writeIndex(index) {
  await chrome.storage.local.set({ [INDEX_KEY]: index });
}

function _addToIndex(entry) {
  return _serializeIndexOp(async () => {
    const index = await _readIndex();
    index.push(entry);
    await _writeIndex(index);
  });
}

// v2.74.1217 — `summary` (optional): the drawer "quick peek". Mirrored alongside updatedAt on every message
// finalize so the app-row preview renders from the index (no body load). `undefined` leaves it untouched.
function _touchIndex(id, updatedAt, summary) {
  return _serializeIndexOp(async () => {
    const index = await _readIndex();
    const entry = index.find(e => e.id === id);
    if (entry) {
      entry.updatedAt = updatedAt;
      if (summary !== undefined) entry.summary = summary;
      await _writeIndex(index);
    }
  });
}

function _updateIndexTitle(id, title, updatedAt) {
  return _serializeIndexOp(async () => {
    const index = await _readIndex();
    const entry = index.find(e => e.id === id);
    if (entry) {
      entry.title = title;
      entry.updatedAt = updatedAt;
      await _writeIndex(index);
    }
  });
}

// v2.74.109 — Used by delete() so the index filter+write is on the same
// serialized chain as adds/touches/title-updates.
function _removeFromIndex(id) {
  return _serializeIndexOp(async () => {
    const index = (await _readIndex()).filter(e => e.id !== id);
    await _writeIndex(index);
  });
}

// v2.74.1034 (DBR-2) — merge arbitrary index-entry fields (e.g. dev `status`, `updatedAt`) on the serialized
// chain, so patchMeta's index mirror can't race a concurrent add/touch/title-update.
function _updateIndexMeta(id, patch) {
  return _serializeIndexOp(async () => {
    const index = await _readIndex();
    const entry = index.find(e => e.id === id);
    if (entry) { Object.assign(entry, patch); await _writeIndex(index); }
  });
}

// v2.74.1034 (DBR-2) — derive a valid, collision-resistant dev branch name from a seed (title / first ask).
// PURE. Shape: `dev/<slug>-<shortid>` — slug = alnum-hyphen, leading-alnum, capped; shortid = 8 hex from a
// uuid. By construction passes bridge/gitOps.cjs `validateBranchName` (dev/…, no `..`, no metacharacters).
export function deriveBranchName(seed) {
  let slug = String(seed || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // any run of non-alnum → a single hyphen (no `--`, no dots → no `..`)
    .replace(/^-+|-+$/g, '')        // trim leading/trailing hyphens
    .slice(0, 32).replace(/^-+|-+$/g, '');
  if (!slug || !/^[a-z0-9]/.test(slug)) slug = slug ? ('x-' + slug) : 'x';   // must start alphanumeric
  const shortid = String(crypto.randomUUID()).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  return `dev/${slug}-${shortid}`;
}

// v2.74.1034 (DBR-2) — the resume target for a dev conversation is ITS OWN session (replaces the global
// `settings:devBridgeLastSession`). PURE: returns the conversation's sessionId, or null. Non-dev → null.
export function devResumeSession(conv) {
  return (conv && conv.kind === 'dev' && typeof conv.sessionId === 'string' && conv.sessionId) ? conv.sessionId : null;
}

// v2.74.1035 (DBR-3, DESIGN §9 "persistence pinning") — which conversation a message persists to. An explicit
// `fields.conversationId` PINS the write to that conversation (a dev run streams over time; the user may switch
// away — without pinning its blocks would leak into whatever's now active, resolved via _ensureConversation).
// Falls back to the active conversation id. PURE.
export function persistTargetId(fields, currentId) {
  return (fields && typeof fields.conversationId === 'string' && fields.conversationId) ? fields.conversationId : (currentId || null);
}

/** @typedef {{ id: string, title: string, updatedAt: number, kind?: 'agent'|'dev', status?: 'active'|'merged'|'abandoned' }} ConversationSummary */
/* v2.74.1029 — `kind?` added (default 'agent' when absent). v2.74.1034 (DBR-2) — `status?` mirrored for dev. */
/** @typedef {{
 *    id: string, role: 'user'|'assistant'|'system',
 *    body: string, markdown?: boolean, html?: boolean, attribution?: string,
 *    invocationId?: string, ts: number,
 *    outcome?: { kind: string, label: string, detail: string },
 *    devBridge?: boolean
 *  }} PersistedMessage */
/* v2.74.987 — `devBridge?: boolean` added. Dev-bridge bubbles (Claude Code
 * replies, Services/Chat/devBridge.js) persist with this flag so _rehydrate-
 * Conversation restores their amber identity and — per the bridge trust rule —
 * keeps their body on the PLAIN-TEXT path (never the markdown/html render). */
/* v2.74.109 — `html?: boolean` added to the typedef. Strategy result cards
 * (handleInvocationCompleted in chat.js) write pre-built HTML and set the
 * flag so _rehydrateConversation knows to use innerHTML on re-render. The
 * flag was being persisted in practice but the typedef hadn't kept up. */
/** @typedef {{
 *    id: string, title: string, createdAt: number, updatedAt: number,
 *    kind?: 'agent'|'dev', messages: PersistedMessage[],
 *    branch?: string|null, concern?: string|null, sessionId?: string|null,
 *    status?: 'active'|'merged'|'abandoned', mergedAt?: number, mergeCommit?: string
 *  }} Conversation */
/* v2.74.1034 (DBR-2, DESIGN §2/§9) — dev-conversation branch metadata fields. */

export const ConversationStore = {

  // ─── Index operations ───────────────────────────────────────────────────

  /**
   * List all conversations sorted by updatedAt descending (newest first).
   * @returns {Promise<ConversationSummary[]>}
   */
  async list() {
    const index = await _readIndex();
    // FL-6c (v2.74.1357) — one-time self-heal: mirror instanceId into agent app entries created before the
    // mirror existed, so the Rail's pending-proposals chip never needs a body load. Best-effort; a failed heal
    // just leaves the chip absent until the next context start (the #164 self-heal pattern).
    if (!_instanceMirrorHealed) {
      _instanceMirrorHealed = true;
      const missing = index.filter((e) => e && e.kind !== 'dev' && e.appId && !e.instanceId);
      if (missing.length) {
        try {
          const got = await chrome.storage.local.get(missing.map((e) => convKey(e.id)));
          const fixes = new Map();
          for (const e of missing) { const c = got[convKey(e.id)]; if (c && c.instanceId) fixes.set(e.id, c.instanceId); }
          if (fixes.size) {
            await _serializeIndexOp(async () => {
              const idx = await _readIndex();
              for (const e of idx) if (fixes.has(e.id) && !e.instanceId) e.instanceId = fixes.get(e.id);
              await _writeIndex(idx);
            });
            for (const e of index) if (fixes.has(e.id) && !e.instanceId) e.instanceId = fixes.get(e.id);   // this return reflects the heal too
          }
        } catch { /* */ }
      }
    }
    return [...index].sort((a, b) => b.updatedAt - a.updatedAt);
  },

  /**
   * Get the most recently updated conversation summary, or null.
   * @returns {Promise<ConversationSummary|null>}
   */
  async mostRecent() {
    const list = await ConversationStore.list();
    return list[0] ?? null;
  },

  // ─── Conversation CRUD ──────────────────────────────────────────────────

  /**
   * Create a new conversation. Returns the full record.
   * @param {{ title?: string }} [init]
   * @returns {Promise<Conversation>}
   */
  async create({ id: explicitId = null, title = 'New conversation', kind = 'agent', branch = null, concern = null, sessionId = null, status = 'active', seed = null, surface = null, appId = null, appVersion = null, parentId = null, icon = null, config = null, presetId = null, instanceId = null, pinned = false } = {}) {
    // v2.74.1234 — an explicit id mints a RESERVED conversation (the persistent Overview owns OVERVIEW_ID). The caller
    // is responsible for get-or-create (don't create over an existing id); a random uuid is the default.
    const id = (typeof explicitId === 'string' && explicitId) ? explicitId : crypto.randomUUID();
    const now = Date.now();
    // v2.74.1029 — `kind`: 'agent' (the website-operating assistant, the default) or 'dev' (a Claude Code
    // dev-bridge thread). Stored on the body AND mirrored into the index entry so history rendering, the
    // active-conversation routing, and the `gch` dev-exclusion can all read it without a body load.
    const k = kind === 'dev' ? 'dev' : 'agent';
    const conv = { id, title, kind: k, createdAt: now, updatedAt: now, messages: [] };
    // v2.74.1034 (DBR-2, DESIGN §2/§9) — dev conversations carry branch metadata: the git branch they own,
    // their `concern` (scope), their Claude Code `sessionId` (per-conversation resume), and lifecycle `status`.
    if (k === 'dev') {
      conv.branch = branch;
      conv.concern = concern;
      conv.sessionId = sessionId;
      conv.status = (status === 'merged' || status === 'abandoned') ? status : 'active';
      if (seed != null) conv.seed = String(seed);   // v2.74.1053 (DBR-P3-1) — a split-seeded conversation: chat.js pre-fills the input from this on first open, then clears it
      conv.surface = surface === 'high' ? 'high' : 'low';   // v2.74.1147 (surfaces §2.2) — the dev surface's altitude; default low (= today's dev behaviour)
    }
    // CV-3c (v2.74.1168, DESIGN_conversations.md §5/§7) — an AGENT conversation can be an APP (a seeded, identified
    // track) or a SUB-TASK (`parentId` → its app). Persist seed + app identity on the body so a reopen restores them
    // (_rehydrateConversation reads conv.seed); mirror the grouping keys (appId/parentId/icon) into the index so the
    // drawer accordion builds without a body load. Fixes the latent CV-3b gap: create() stored seed for dev ONLY and
    // patchMeta() dropped appId/icon/config, so a gallery app persisted NEITHER its seed nor its identity.
    if (k === 'agent') {
      if (seed != null) conv.seed = String(seed);
      if (appId) conv.appId = appId;
      if (appVersion != null) conv.appVersion = appVersion;
      if (parentId) conv.parentId = parentId;
      if (icon) conv.icon = icon;
      if (config && typeof config === 'object') conv.config = config;
      if (presetId) conv.presetId = presetId;                          // AP-0 (v2.74.1211) — the generic TEMPLATE this app instance came from (object-model / canvas resolve through it)
      if (appId) conv.instanceId = instanceId || crypto.randomUUID();  // AP-0 — per-INSTANCE identity; goal memory keys by THIS, not the shared appId/type (re-create passes the saved id so memory persists)
      if (pinned) conv.pinned = true;                                  // AP-1 — pinned apps sort to the top of the drawer
    }
    await chrome.storage.local.set({ [convKey(id)]: conv });
    const entry = { id, title, kind: k, updatedAt: now };
    if (k === 'dev') { entry.status = conv.status; entry.surface = conv.surface; }   // mirror status + surface so list()/history (the drawer badge) read them without a body load
    if (conv.appId) entry.appId = conv.appId;          // CV-3c — accordion grouping keys, index-mirrored
    if (conv.parentId) entry.parentId = conv.parentId;
    if (conv.icon) entry.icon = conv.icon;
    if (conv.pinned) entry.pinned = true;              // AP-1 — index-mirrored so drawerTree sorts pinned-first without a body load
    if (conv.instanceId) entry.instanceId = conv.instanceId;   // FL-6c (v2.74.1357) — mirrored so the Rail's pending-proposals chip counts without a body load
    await _addToIndex(entry);
    return conv;
  },

  /**
   * v2.74.1034 (DBR-2) — patch a dev conversation's metadata (branch / concern / sessionId / status /
   * mergedAt / mergeCommit). Bumps updatedAt and mirrors `status` (+ title) into the index. Idempotent;
   * no-op (returns null) if the conversation is gone (mirrors updateMessage's delete-race narrowing).
   * @param {string} id
   * @param {{branch?:string, concern?:string, sessionId?:string, status?:string, mergedAt?:number, mergeCommit?:string, title?:string, syncedMain?:string, surface?:string}} fields
   * @returns {Promise<Conversation|null>}
   */
  async patchMeta(id, fields = {}) {
    const conv = await ConversationStore.load(id);
    if (!conv) return null;
    // v2.74.1045 (DBR-P2-2) — `syncedMain`: the `main` commit this branch last synced onto (feeds the P2-5 merge freshness check).
    // v2.74.1053 (DBR-P3-1) — `seed`: the split-seed prompt; cleared (→ null) by chat.js once pre-filled into the input.
    for (const k of ['branch', 'concern', 'sessionId', 'status', 'mergedAt', 'mergeCommit', 'title', 'syncedMain', 'seed', 'titledByLlm', 'surface', 'appId', 'appVersion', 'parentId', 'icon', 'config', 'pinned', 'instanceId', 'presetId']) {   // .1102 — titledByLlm; .1147 — surface (the dev altitude; WITHOUT this, `surface high` silently dropped the field and never activated the high surface); .1168 (CV-3c) — app identity (appId/appVersion/parentId/icon) + tighten-only config; .1211 (AP-0/1) — pinned + per-instance identity (instanceId/presetId)
      if (k in fields) conv[k] = fields[k];
    }
    conv.updatedAt = Date.now();
    const stillExists = await ConversationStore.load(id);   // narrow the delete-then-patch race (see updateMessage)
    if (!stillExists) return null;
    await chrome.storage.local.set({ [convKey(id)]: conv });
    const patch = { updatedAt: conv.updatedAt };
    if ('status' in fields) patch.status = conv.status;
    if ('title' in fields) patch.title = conv.title;
    if ('surface' in fields) patch.surface = conv.surface;   // v2.74.1147 — mirror the altitude so the drawer badge updates without a body load
    if ('appId' in fields) patch.appId = conv.appId;          // CV-3c (v2.74.1168) — mirror the accordion grouping keys
    if ('parentId' in fields) patch.parentId = conv.parentId;
    if ('icon' in fields) patch.icon = conv.icon;
    if ('pinned' in fields) patch.pinned = conv.pinned;       // AP-1 (v2.74.1211) — mirror so the drawer re-sorts pinned-first without a body load
    if ('instanceId' in fields) patch.instanceId = conv.instanceId;   // FL-6c (v2.74.1357) — mirror for the Rail's pending chip
    await _updateIndexMeta(id, patch);
    return conv;
  },

  /**
   * v2.74.1354 — CLEAR a conversation's message history ("clear chat"). The ENTITY keeps everything else —
   * id, seed, config, app identity (appId/instanceId/presetId), pin — so an app conversation restarts fresh
   * without losing its constitution, connections, learned memory, or pending proposals (those live in their
   * own instance-keyed stores). The index summary peek resets so the Rail row stops showing the wiped thread.
   * @param {string} id
   * @returns {Promise<Conversation|null>} the cleared conversation, or null if it vanished.
   */
  async clearMessages(id) {
    const conv = await ConversationStore.load(id);
    if (!conv) return null;
    conv.messages = [];
    conv.updatedAt = Date.now();
    const stillExists = await ConversationStore.load(id);   // narrow the delete-then-clear race (mirrors patchMeta)
    if (!stillExists) return null;
    await chrome.storage.local.set({ [convKey(id)]: conv });
    await _updateIndexMeta(id, { updatedAt: conv.updatedAt, summary: '' });
    return conv;
  },

  /**
   * Load a conversation by id.
   * @param {string} id
   * @returns {Promise<Conversation|null>}
   */
  async load(id) {
    if (!id) return null;
    const data = await chrome.storage.local.get(convKey(id));
    return data[convKey(id)] ?? null;
  },

  /**
   * Update an existing message by id. Used when an in-flight message
   * transitions to a completed state (thinking → final body + outcome).
   * Idempotent — if no message with that id exists, appends instead.
   * v2.74.970 — pass { upsert: true } when append-on-miss is the CALLER'S DESIGN: chat's CR-U1
   * finalize (.938) persists assistant bubbles only at their TERMINAL text, so the FIRST persist of
   * every grounded reply misses by construction — the v2.74.109 warn assumed any miss was a caller
   * bug and fired on every boot reply / walk recap (5 sightings, gl 094214→182702). Without the flag
   * a miss still appends but WARN-logs — that path now genuinely indicates a typo'd or stale
   * messageId (the legacy invocation finalize in background.js updates a previously-persisted
   * placeholder, so a miss THERE is a real anomaly).
   * @param {string} conversationId
   * @param {string} messageId
   * @param {Partial<PersistedMessage>} updates
   * @param {{upsert?: boolean}} [opts]
   */
  async updateMessage(conversationId, messageId, updates, { upsert = false } = {}) {
    const conv = await ConversationStore.load(conversationId);
    if (!conv) throw new Error(`Conversation ${conversationId} not found`);
    const idx = conv.messages.findIndex(m => m.id === messageId);
    if (idx === -1) {
      // v2.74.109, narrowed at v2.74.970 — with declared upserts split out (the CR-U1 first-persist
      // false positive), a warn here points at a REAL stale ref / duplicate-create risk.
      if (!upsert) console.warn(`[ConversationStore] updateMessage: no message ${messageId} in ${conversationId}, appending instead`);
      conv.messages.push({ id: messageId, ts: Date.now(), ...updates });
    } else {
      conv.messages[idx] = { ...conv.messages[idx], ...updates };
    }
    conv.updatedAt = Date.now();
    // v2.74.109 — Re-check existence right before writing. Narrows the
    // delete-then-update race window: pre-fix, an in-flight updateMessage
    // could resurrect a conversation body whose delete had completed
    // between our load() and set(), leaving an orphan body with no index
    // entry. The re-check doesn't fully close the window (delete could
    // still slot in between this check and the set call) but the residual
    // window is microseconds versus the original "anytime during the call".
    const stillExists = await ConversationStore.load(conversationId);
    if (!stillExists) throw new Error(`Conversation ${conversationId} not found`);
    await chrome.storage.local.set({ [convKey(conversationId)]: conv });
    // v2.74.1217 — refresh the drawer "quick peek" from the now-current message list (the most recent substantive
    // line). Cheap + pure; mirrored into the index so app-row previews render without a body load.
    await _touchIndex(conversationId, conv.updatedAt, conversationPeek(conv.messages));
  },

  /**
   * Update the title of a conversation.
   * @param {string} conversationId
   * @param {string} title
   */
  async setTitle(conversationId, title) {
    const conv = await ConversationStore.load(conversationId);
    if (!conv) return;
    // v2.74.109 — Coerce + truncate + fallback. The auto-title generator
    // (ChatAPI.generateTitle) usually emits a short string, but a malformed
    // model response could return null/undefined or a runaway long string.
    // The index is read on every history render — a 100KB title would
    // bloat every list() call forever. Cap at 200 chars (matches the
    // visible truncation in the history sidebar) and fall back to a
    // sensible default if empty post-trim.
    const safeTitle = String(title ?? '').slice(0, 200).trim() || 'Untitled';
    conv.title = safeTitle;
    conv.updatedAt = Date.now();
    await chrome.storage.local.set({ [convKey(conversationId)]: conv });
    await _updateIndexTitle(conversationId, safeTitle, conv.updatedAt);
  },

  /**
   * Delete a conversation and its index entry. AP-3 (v2.74.1211) — CASCADE: deleting an APP also removes its
   * sub-task children (any conversation whose `parentId` is this id), so children never orphan. One op on the
   * serialized index chain (a concurrent add/touch can't clobber it). Goal memory is KEPT (a re-created app stays
   * smart, §10) — clearing it is a separate, deliberate action, not a side effect of delete.
   * @param {string} id
   * @returns {Promise<number>} how many conversations were removed (the app + its children)
   */
  async delete(id) {
    return _serializeIndexOp(async () => {
      const index = await _readIndex();
      const arr = Array.isArray(index) ? index : [];
      const childIds = arr.filter((e) => e && e.parentId === id).map((e) => e.id);
      const ids = [id, ...childIds];
      await chrome.storage.local.remove(ids.map(convKey));
      await _writeIndex(arr.filter((e) => e && !ids.includes(e.id)));
      return ids.length;
    });
  },

  /**
   * Delete ALL conversations and clear the index. Runs on the serialized index chain so it can't race a
   * concurrent add/touch/title-update. Returns how many were removed.
   * @returns {Promise<number>}
   */
  async deleteAll() {
    return _serializeIndexOp(async () => {
      const index = await _readIndex();
      const ids = (Array.isArray(index) ? index : []).map((e) => e && e.id).filter(Boolean);
      if (ids.length) await chrome.storage.local.remove(ids.map(convKey));
      await _writeIndex([]);
      return ids.length;
    });
  },
};
