/**
 * @file ConversationStore.js
 * @module ConversationStore
 * @version 2.19.0
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

function _touchIndex(id, updatedAt) {
  return _serializeIndexOp(async () => {
    const index = await _readIndex();
    const entry = index.find(e => e.id === id);
    if (entry) {
      entry.updatedAt = updatedAt;
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

/** @typedef {{ id: string, title: string, updatedAt: number }} ConversationSummary */
/** @typedef {{
 *    id: string, role: 'user'|'assistant'|'system',
 *    body: string, markdown?: boolean, html?: boolean, attribution?: string,
 *    invocationId?: string, ts: number,
 *    outcome?: { kind: string, label: string, detail: string }
 *  }} PersistedMessage */
/* v2.74.109 — `html?: boolean` added to the typedef. Strategy result cards
 * (handleInvocationCompleted in chat.js) write pre-built HTML and set the
 * flag so _rehydrateConversation knows to use innerHTML on re-render. The
 * flag was being persisted in practice but the typedef hadn't kept up. */
/** @typedef {{
 *    id: string, title: string, createdAt: number, updatedAt: number,
 *    messages: PersistedMessage[]
 *  }} Conversation */

export const ConversationStore = {

  // ─── Index operations ───────────────────────────────────────────────────

  /**
   * List all conversations sorted by updatedAt descending (newest first).
   * @returns {Promise<ConversationSummary[]>}
   */
  async list() {
    const index = await _readIndex();
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
  async create({ title = 'New conversation' } = {}) {
    const id = crypto.randomUUID();
    const now = Date.now();
    const conv = { id, title, createdAt: now, updatedAt: now, messages: [] };
    await chrome.storage.local.set({ [convKey(id)]: conv });
    await _addToIndex({ id, title, updatedAt: now });
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
   * @param {string} conversationId
   * @param {string} messageId
   * @param {Partial<PersistedMessage>} updates
   */
  async updateMessage(conversationId, messageId, updates) {
    const conv = await ConversationStore.load(conversationId);
    if (!conv) throw new Error(`Conversation ${conversationId} not found`);
    const idx = conv.messages.findIndex(m => m.id === messageId);
    if (idx === -1) {
      // v2.74.109 — Append fallback is intentional (matches the docstring),
      // but warn-log so a typo'd messageId or stale ref doesn't silently
      // duplicate-create messages. Current callers (chat._persistMessageUpdate)
      // always reuse a stable dataset.messageId — if this fires in practice,
      // it points at a real caller bug.
      console.warn(`[ConversationStore] updateMessage: no message ${messageId} in ${conversationId}, appending instead`);
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
    await _touchIndex(conversationId, conv.updatedAt);
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
   * Delete a conversation and its index entry.
   * @param {string} id
   */
  async delete(id) {
    // v2.74.109 — Index filter now goes through the serialized helper so
    // a concurrent _addToIndex/_touchIndex from another async chain can't
    // clobber the delete with its own snapshot-based write.
    await chrome.storage.local.remove(convKey(id));
    await _removeFromIndex(id);
  },
};
