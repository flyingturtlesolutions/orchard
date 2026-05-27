/**
 * @file chat.js
 * @description Agent HUB — Chat consumer interface.
 * Pure consumer of CapabilityAPI via ChatAPI. Drives the empty state,
 * message rendering, capability drawer, and progress indicators.
 * @version 2.13.0
 */

import { installGlobalErrorHandlers } from './Core/ErrorCapture.js';
// v2.74.188 — Capture uncaught errors / unhandled promise rejections
// in this page so they surface in the Studio Logs tab.
installGlobalErrorHandlers('chat', window);

import { ChatAPI } from './Services/ChatAPI.js';
import { ConversationStore } from './Services/ConversationStore.js';
import { $, escHtml, escAttr, toast, relTime } from './shared.js';
import { isSafeStrategyResultHtml, looksLikeStrategyResultHtml } from './Services/Chat/strategyResultHtml.js';
import { renderMarkdown, wireCodeCopyButtons } from './markdown.js';
import { createParamForm, promptForParams } from './Services/ParamForm.js';

// ─── Conversation state ──────────────────────────────────────────────────────
// `_currentConversationId` is null before the first user message of a new
// conversation. On first send we create one. On "new conversation" we reset
// to null — deferring creation keeps empty conversations out of the index.

let _currentConversationId = null;

// v2.74.106 — Single-flight guard for conversation creation. Two parallel
// callers (e.g. double-clicked suggestion cards) could both see
// _currentConversationId === null, both start ConversationStore.create(),
// and the second would clobber the first's id — orphaning the first
// conversation with no persisted messages. The guard collapses concurrent
// calls onto one creation promise.
let _ensureConversationPromise = null;

/**
 * Lazily create the current conversation if one isn't active, returns the id.
 * Called just-in-time when we're about to persist a real message.
 */
async function _ensureConversation() {
  if (_currentConversationId) return _currentConversationId;
  if (_ensureConversationPromise) return _ensureConversationPromise;
  _ensureConversationPromise = (async () => {
    const conv = await ConversationStore.create();
    _currentConversationId = conv.id;
    return conv.id;
  })();
  try {
    return await _ensureConversationPromise;
  } finally {
    _ensureConversationPromise = null;
  }
}

/** Clear the in-memory "current" pointer without deleting anything. */
function _clearCurrentConversation() {
  _currentConversationId = null;
}

/**
 * Generate a title for the current conversation once, based on the first
 * user message. Called after the first completion event — by then we have
 * at least one user + one assistant message persisted. No-op if the
 * conversation already has a user-set title (anything other than the default).
 */
async function _maybeGenerateTitle() {
  if (!_currentConversationId) return;
  const conv = await ConversationStore.load(_currentConversationId);
  if (!conv) return;
  // Only auto-title if we're still at the default. If the user renamed,
  // respect that.
  if (conv.title !== 'New conversation') return;
  const firstUserMsg = conv.messages.find(m => m.role === 'user');
  if (!firstUserMsg) return;

  try {
    const title = await ChatAPI.generateTitle(firstUserMsg.body);
    if (title) {
      await ConversationStore.setTitle(_currentConversationId, title);
    }
  } catch (err) {
    console.warn('[chat] title generation failed:', err.message);
  }
}

// ─── Studio launcher ─────────────────────────────────────────────────────────

// v2.27.0 — Opens Studio in a new tab, or focuses an existing Studio tab if
// one is already open. Replaces the earlier Lab switch — the sidepanel is now
// chat-only, and authoring happens in Studio (a browser tab).
$('btn-open-studio')?.addEventListener('click', async () => {
  const studioUrl = chrome.runtime.getURL('studio.html');
  try {
    const tabs = await chrome.tabs.query({ url: studioUrl });
    if (tabs.length > 0) {
      const tab = tabs[0];
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
    await chrome.tabs.create({ url: studioUrl, active: true });
  } catch (err) {
    toast(`Couldn't open Studio: ${err.message}`, 'err');
  }
});

// ─── Hide panel (v2.71.4) ────────────────────────────────────────────────────
// Closes the side panel without affecting running invocations. The strategies
// continue executing in the service worker. User reopens via the extension
// toolbar icon, which restores the chat panel and (via _resumeRunningInvocations
// in init) reattaches running-state UI to in-flight bubbles.
$('btn-hide-panel')?.addEventListener('click', () => {
  // window.close() in a side panel context closes only this panel.
  // Tested working as of Chrome 120+. chrome.sidePanel.close() also works
  // but is more recent and requires permission considerations; window.close
  // is the simpler portable form.
  window.close();
});

// ─── New conversation ────────────────────────────────────────────────────────

$('btn-new-conversation').addEventListener('click', async () => {
  if (_activeInvocations.size > 0) {
    if (!confirm('Active invocations are in progress. Start a new conversation anyway?')) return;
  }
  _clearCurrentConversation();
  _resetConversation();
  // v2.71.8 — Re-render suggestion cards so user sees the available
  // capability list. Pre-v2.71.8 the empty state appeared but with no
  // cards (subtitle/cards retained their stale state from rehydration).
  await renderSuggestionCards();
  _closeHistory();
});

// ─── History sidebar ─────────────────────────────────────────────────────────

$('btn-history').addEventListener('click', async () => {
  await _openHistory();
});

$('btn-close-history').addEventListener('click', _closeHistory);
$('history-overlay').addEventListener('click', _closeHistory);

async function _openHistory() {
  $('history-sidebar').classList.remove('hidden');
  $('history-overlay').classList.remove('hidden');
  await _renderHistoryList();
}

function _closeHistory() {
  $('history-sidebar').classList.add('hidden');
  $('history-overlay').classList.add('hidden');
}

async function _renderHistoryList() {
  const container = $('history-list');
  container.innerHTML = '';

  const conversations = await ConversationStore.list();
  if (conversations.length === 0) {
    container.innerHTML = '<div class="history-empty">No conversations yet.</div>';
    return;
  }

  conversations.forEach(conv => {
    const item = document.createElement('div');
    item.className = `history-item${conv.id === _currentConversationId ? ' active' : ''}`;
    item.dataset.conversationId = conv.id;
    item.innerHTML = `
      <div class="history-item-title">${escHtml(conv.title)}</div>
      <div class="history-item-meta">${relTime(conv.updatedAt)}</div>
      <button class="history-item-delete" title="Delete">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
        </svg>
      </button>`;

    // Click anywhere on the item (except delete) loads the conversation
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.history-item-delete')) return;
      if (conv.id === _currentConversationId) { _closeHistory(); return; }
      if (_activeInvocations.size > 0) {
        if (!confirm('Active invocations are in progress. Switch conversations anyway?')) return;
      }
      const full = await ConversationStore.load(conv.id);
      if (full) {
        await _rehydrateConversation(full);
        // v2.71.4 — Resume running invocations belonging to the just-loaded
        // conversation, mirroring init flow.
        await _resumeRunningInvocations();
        _closeHistory();
      }
    });

    item.querySelector('.history-item-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${conv.title}"?`)) return;
      await ConversationStore.delete(conv.id);
      if (conv.id === _currentConversationId) {
        _clearCurrentConversation();
        _resetConversation();
        // v2.74.106 — Mirror the "New conversation" button: after wiping
        // the active conversation, re-render suggestion cards so the empty
        // state actually shows something. Pre-fix, deleting the active
        // conversation left an empty-state shell with stale or absent
        // suggestion cards (the "new conversation" path always re-rendered,
        // but the delete path only called _resetConversation).
        await renderSuggestionCards();
      }
      await _renderHistoryList();
    });

    container.appendChild(item);
  });
}

function _resetConversation() {
  // v2.74.107 — Cancel any open param-form (inline) or param-modal (modal)
  // dialogs before wiping the message container. Without this, an awaiter
  // sitting inside _promptForMissingParams or runTaskCapability's form
  // mount would hang forever — its Submit/Cancel buttons are about to be
  // detached from the DOM along with #messages.innerHTML. Clicking the
  // form's own Cancel button programmatically resolves its promise with
  // null, releasing the awaiter and letting it take its cancellation
  // branch (`if (!collected) return;`).
  _cancelOpenParamForms();
  $('messages').innerHTML = '';
  $('messages').classList.add('hidden');
  $('empty-state').classList.remove('hidden');
  $('input-status').textContent = '';
  $('input-status').className = 'input-status';
}

// v2.74.107 — Helper for #4: programmatically cancel any open param forms.
// Used by _resetConversation and _rehydrateConversation so a conversation
// switch / new-conversation action doesn't strand awaiters behind detached
// DOM. The Submit/Cancel handlers in ParamForm.js call `settle(null)` on
// cancel — same path the user would take, so the awaiter receives the
// already-handled `null` value and falls into its cancellation branch.
function _cancelOpenParamForms() {
  document.querySelectorAll('.param-form, .param-modal').forEach((form) => {
    form.querySelector('[data-action="cancel"]')?.click();
  });
}

function _enterConversation() {
  $('empty-state').classList.add('hidden');
  $('messages').classList.remove('hidden');
}

// v2.74.106 — Scroll-to-bottom that respects user intent. If the user has
// scrolled up to read prior messages, don't yank them back to the bottom on
// every progress event. Only auto-scroll when they're already near the
// bottom (within NEAR_BOTTOM_PX of it). 96px is a touch over one message
// height — generous enough that an arriving message visible mostly above
// the fold still counts as "near bottom" and keeps tracking.
const NEAR_BOTTOM_PX = 96;
function _isNearBottom() {
  const c = $('conversation');
  if (!c) return true;
  return c.scrollHeight - c.scrollTop - c.clientHeight <= NEAR_BOTTOM_PX;
}
function _scrollToBottomIfNearBottom() {
  if (!_isNearBottom()) return;
  const c = $('conversation');
  if (c) c.scrollTop = c.scrollHeight;
}

// ─── Active invocation tracking ──────────────────────────────────────────────

const _activeInvocations = new Set();

function _trackInvocation(invocationId) {
  _activeInvocations.add(invocationId);
  _updateRunningStatus();
}

function _untrackInvocation(invocationId) {
  _activeInvocations.delete(invocationId);
  _updateRunningStatus();
}

function _updateRunningStatus() {
  const status = $('input-status');
  const n = _activeInvocations.size;
  if (n === 0) {
    if (status.classList.contains('running')) {
      status.textContent = '';
      status.className = 'input-status';
    }
  } else {
    status.textContent = n === 1 ? '1 capability running…' : `${n} capabilities running…`;
    status.className = 'input-status running';
  }
}

// ─── Message rendering ───────────────────────────────────────────────────────

/**
 * Append a message to the conversation. Returns the message element.
 *
 * Persistence:
 *  - `role: 'user'` messages auto-persist immediately (final state).
 *  - `role: 'thinking'` messages do NOT persist — they're transient UI. They
 *    transition to 'assistant'/'system' via _persistMessageUpdate() once
 *    the invocation completes.
 *  - The returned element has a `data-message-id` attribute used as the
 *    persistence key for future updates.
 */
function appendMessage({ role, body, attribution, id, skipPersist = false }) {
  // v2.74.107 — skipPersist explicit in the signature (was previously read
  // off `arguments[0].skipPersist`, which worked but hid the contract from
  // readers of the function header). Callers: appendMessage(..., skipPersist:
  // true) is set by _rehydrateConversation for messages already in storage
  // to avoid re-persisting them on re-render.
  _enterConversation();

  const messages = $('messages');
  const msg = document.createElement('div');
  msg.className = `message ${role}`;
  if (id) msg.id = id;

  // Every message gets a stable message-id for persistence. For in-flight
  // messages we derive it from the invocation id (passed in as `id` as
  // `msg-<invocationId>`); for user messages we generate a fresh one.
  const messageId = id ? id.replace(/^msg-/, '') : crypto.randomUUID();
  msg.dataset.messageId = messageId;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'user' ? 'You' : '◈';

  const content = document.createElement('div');
  content.className = 'message-content';

  if (attribution) {
    const attr = document.createElement('div');
    attr.className = 'message-attribution';
    attr.textContent = attribution;
    content.appendChild(attr);
  }

  const bodyEl = document.createElement('div');
  bodyEl.className = 'message-body';
  bodyEl.textContent = body;
  content.appendChild(bodyEl);

  msg.appendChild(avatar);
  msg.appendChild(content);
  messages.appendChild(msg);

  // v2.74.106 — Conditional scroll: don't yank the user back to the bottom
  // if they've scrolled up to read prior messages. User-sent messages get an
  // unconditional scroll though — sending always scrolls back to the
  // conversation tail, matching every other chat product's behavior.
  if (role === 'user') {
    $('conversation').scrollTop = $('conversation').scrollHeight;
  } else {
    _scrollToBottomIfNearBottom();
  }

  // User messages are final state on append — persist immediately. Thinking
  // messages wait for completion. Assistant/system messages from re-render
  // already exist in storage — the { skipPersist } opt-out avoids duplicates.
  if (role === 'user' && !skipPersist) {
    _persistMessageUpdate(msg, { role, body, attribution }).catch(err =>
      console.warn('[chat] failed to persist user message:', err.message)
    );
  }

  return msg;
}

/**
 * Write a message's current state to the store. Works for both "create"
 * (first persist for this messageId) and "update" (in-flight becomes final).
 *
 * Safe to call repeatedly — the store handles upsert semantics. No-op if
 * no conversation has been created yet (shouldn't happen in practice since
 * _ensureConversation runs before sends).
 */
async function _persistMessageUpdate(msgEl, fields) {
  const convId = await _ensureConversation();
  const messageId = msgEl.dataset.messageId;
  if (!messageId) return;
  const existing = {
    id        : messageId,
    ts        : Number(msgEl.dataset.ts) || Date.now(),
    role      : fields.role,
    body      : fields.body,
    markdown  : fields.markdown ?? false,
    // v2.29.0.2 — Persist the html flag. Strategy-completion messages carry
    // pre-built HTML that must be re-rendered as markup on rehydrate (see
    // _rehydrateConversation). Without this line the flag was silently
    // dropped, causing reloaded conversations to show raw angle-bracketed
    // markup as text in the bubble. My v2.28.5 fix added the READ branch
    // for pm.html but the WRITE side was still broken.
    html      : fields.html ?? false,
  };
  if (fields.attribution) existing.attribution = fields.attribution;
  if (fields.outcome)     existing.outcome     = fields.outcome;
  if (fields.invocationId) existing.invocationId = fields.invocationId;

  // Track ts on the DOM so subsequent updates don't bump it
  if (!msgEl.dataset.ts) msgEl.dataset.ts = existing.ts;

  try {
    await ConversationStore.updateMessage(convId, messageId, existing);
  } catch (err) {
    console.warn('[chat] persist failed:', err.message);
  }
}

/**
 * Set the body of a message. When `markdown` is true, the text is rendered
 * as markdown (headers, lists, code, links, emphasis). For plain text updates
 * (transient "Thinking…" states, user messages), pass markdown: false.
 */
function _setMessageBody(msg, text, { markdown = false, html = false } = {}) {
  const body = msg.querySelector('.message-body');
  if (markdown) {
    body.innerHTML = renderMarkdown(text);
    body.classList.add('md-rendered');
    wireCodeCopyButtons(body);
  } else if (html) {
    if (isSafeStrategyResultHtml(text)) {
      body.innerHTML = text;
    } else {
      console.warn('[chat] blocked unsafe strategy-result HTML; showing plain text');
      body.textContent = typeof text === 'string' ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    }
    body.classList.remove('md-rendered');
  } else {
    body.textContent = text;
    body.classList.remove('md-rendered');
  }
}

/**
 * @param {HTMLElement} msgEl
 * @param {{ body: string, markdown?: boolean, html?: boolean, attribution?: string|null, invocationId?: string }} fields
 */
async function _finalizeAssistantBubble(msgEl, fields) {
  msgEl.classList.remove('thinking');
  await _persistMessageUpdate(msgEl, {
    role: 'assistant',
    outcome: null,
    markdown: false,
    html: false,
    attribution: null,
    invocationId: undefined,
    ...fields,
  });
}

function _addCancelButton(msg, invocationId) {
  if (msg.querySelector('.message-cancel')) return;
  const btn = document.createElement('button');
  btn.className = 'message-cancel';
  btn.title = 'Cancel';
  btn.textContent = '×';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    try { await ChatAPI.cancel(invocationId); }
    catch (err) { toast(`Cancel failed: ${err.message}`, 'err'); btn.disabled = false; }
  });
  msg.appendChild(btn);
}

function _removeCancelButton(msg) {
  msg.querySelector('.message-cancel')?.remove();
}

// v2.39.0 — Debug controls moved out of chat into the dedicated debugger
// surface (debugger.html / debugger.js). Chat is now a pure consumer of
// capabilities — no debug state, no run controls. Strategies launched from
// chat without debug mode just stream progress to the chat-message bubble
// as before; debug-mode launches open the debugger panel separately.

// ─── Suggestion cards (empty state) ──────────────────────────────────────────

async function renderSuggestionCards() {
  const container = $('suggestion-cards');
  const subtitle  = $('empty-state-subtitle');
  container.innerHTML = '';

  const capabilities = await ChatAPI.listCapabilities({ status: 'ready' });

  if (capabilities.length === 0) {
    subtitle.innerHTML = 'No capabilities available yet. Open Studio to set up your first Ground and author a Fragment. ' +
      '<button class="inline-studio-btn" id="btn-empty-open-studio">Open Studio →</button>';
    // Wire the inline button to trigger the same launcher as the header icon
    $('btn-empty-open-studio')?.addEventListener('click', () => {
      $('btn-open-studio')?.click();
    });
    return;
  }

  subtitle.textContent = capabilities.length === 1
    ? '1 capability is ready. Try it below or describe what you need.'
    : `${capabilities.length} capabilities are ready. Try one below or describe what you need.`;

  // Show up to 4 suggestion cards in the empty state
  capabilities.slice(0, 4).forEach(cap => {
    const card = document.createElement('button');
    card.className = 'suggestion-card';
    card.dataset.capabilityId = cap.id;
    card.innerHTML = `
      <div class="suggestion-card-name">${escHtml(cap.name)}</div>
      ${cap.summary ? `<div class="suggestion-card-summary">${escHtml(cap.summary)}</div>` : ''}
      <div class="suggestion-card-meta">
        <span class="suggestion-card-kind">${cap.kind === 'task' ? 'Task' : 'Assistant'}</span>
      </div>`;
    card.addEventListener('click', () => {
      cap.kind === 'task' ? runTaskCapability(cap) : focusForAssistant(cap);
    });
    container.appendChild(card);
  });
}

function focusForAssistant(cap) {
  $('chat-input').placeholder = `Ask ${cap.name}…`;
  $('chat-input').focus();
  // Stash the assistant id so the next send routes to it directly
  $('chat-input').dataset.targetCapabilityId = cap.id;
  $('chat-input').dataset.targetCapabilityName = cap.name;
}

// ─── Capability drawer ──────────────────────────────────────────────────────

$('btn-toggle-drawer').addEventListener('click', () => {
  $('capability-drawer').classList.toggle('hidden');
  if (!$('capability-drawer').classList.contains('hidden')) {
    renderCapabilityList();
  }
});

$('btn-close-drawer').addEventListener('click', () => {
  $('capability-drawer').classList.add('hidden');
});

async function renderCapabilityList() {
  const list = $('capability-list');
  list.innerHTML = '';

  const capabilities = await ChatAPI.listCapabilities();

  if (capabilities.length === 0) {
    list.innerHTML = '<div class="capability-item-summary">No capabilities yet. Open Studio to add one.</div>';
    return;
  }

  capabilities.forEach(cap => {
    const ready    = cap.status === 'ready';
    const isRunning = _isCapabilityRunning(cap.id);
    const item = document.createElement('button');
    item.className = `capability-item${isRunning ? ' running' : ''}`;
    item.disabled  = !ready;
    item.dataset.capabilityId = cap.id;

    item.innerHTML = `
      <div class="capability-item-name">
        ${escHtml(cap.name)}
        ${isRunning ? '<span class="running-dot"></span>' : ''}
      </div>
      ${cap.summary ? `<div class="capability-item-summary">${escHtml(cap.summary)}</div>` : ''}`;

    if (ready) {
      item.addEventListener('click', () => {
        $('capability-drawer').classList.add('hidden');
        cap.kind === 'task' ? runTaskCapability(cap) : focusForAssistant(cap);
      });
    }
    list.appendChild(item);
  });
}

function _isCapabilityRunning(capabilityId) {
  return [..._activeInvocations].some(id => {
    const msg = document.getElementById(`msg-${id}`);
    return msg?.dataset.capabilityId === capabilityId;
  });
}

// ─── Task capability invocation (with optional param form) ──────────────────

async function runTaskCapability(cap) {
  // Re-fetch full descriptor in case parameters changed
  const fullCap = await ChatAPI.getCapability(cap.id);
  if (!fullCap) { toast(`Capability not found: ${cap.id}`, 'err'); return; }

  const params = _descriptorParamsToArray(fullCap.parameters);
  if (params.length === 0) {
    // No params — run immediately. Debug controls live in the debugger
    // surface; chat is a pure consumer.
    _executeTask(fullCap, {});
    return;
  }

  // v2.74.65 — typed-input param form. Lives in Services/ParamForm.js so the
  // same controls (text / number / checkbox / file) render here, in the
  // missing-param modal, and in Studio's invocation flow.
  // v2.74.107 — Cancel any existing inline form first (in addition to
  // removing it from DOM) so the previous awaiter sees `null` and exits
  // cleanly. Pre-fix, clicking a second suggestion card while the first
  // form was open just .remove()'d the form, stranding the first awaiter
  // on a promise that would never resolve.
  _enterConversation();
  const messages = $('messages');
  _cancelOpenParamForms();
  document.querySelector('.param-form')?.remove();

  const { element, promise } = createParamForm(params, {
    title:       `Run ${fullCap.name}`,
    submitLabel: 'Run',
    variant:     'inline',
  });
  messages.appendChild(element);
  $('conversation').scrollTop = $('conversation').scrollHeight;

  const values = await promise;
  element.remove();
  if (values === null) return;        // user cancelled
  _executeTask(fullCap, values);
}

/**
 * Convert the descriptor's parameters dict (keyed by name) into the canonical
 * array shape that ParamForm expects: [{name, kind, type, required, ...}].
 *
 * Pre-v2.74.65 descriptors stored only {type:'string', description, required}
 * per name; current descriptors carry the full typed-input shape. This adapter
 * tolerates both so existing-in-storage strategies keep working until
 * normalizeStrategyParams next touches them.
 */
function _descriptorParamsToArray(paramsDict) {
  if (!paramsDict || typeof paramsDict !== 'object') return [];
  const out = [];
  for (const [name, def] of Object.entries(paramsDict)) {
    const type = ['string', 'number', 'boolean', 'file'].includes(def?.type) ? def.type : 'string';
    const required = def?.required !== false;
    const kind = def?.kind === 'list' ? 'list' : 'scalar';
    const entry = { name, kind, type, required };
    if (type === 'file') {
      entry.accept = def?.accept ?? '';
      entry.parse  = def?.parse  ?? 'auto';
      if (Number.isFinite(def?.maxBytes)) entry.maxBytes = def.maxBytes;
    }
    if (def?.default !== undefined) entry.default = def.default;
    out.push(entry);
  }
  return out;
}

// v2.39.0 — _showDebugChoiceForNoParams removed. Chat doesn't show a debug
// toggle — debug is the debugger surface's concern. Chat-launched runs always
// run live; users seeking a debugger should pick the Debugger entry from the
// extension icon menu, or use Studio's ▶ which launches under the debugger.

async function _executeTask(cap, paramValues) {
  const invocationId = crypto.randomUUID();
  const msg = appendMessage({
    role: 'thinking',
    body: 'Starting…',
    attribution: cap.name,
    id: `msg-${invocationId}`,
  });
  msg.dataset.capabilityId = cap.id;

  // v2.71.10 (Bug W fix) — Ensure a conversation exists before invoke so
  // background-side terminal-event persistence has a conversationId to
  // route to. Pre-v2.71.10, first-message invocations passed conversationId:
  // null to background, which then skipped persistence entirely. If the
  // user hid the panel mid-strategy, the result was silently lost forever.
  const conversationId = await _ensureConversation();

  try {
    await ChatAPI.invoke(cap.id, { params: paramValues }, { invocationId, conversationId });
    _trackInvocation(invocationId);
    _addCancelButton(msg, invocationId);
    _refreshRunningBar();
  } catch (err) {
    msg.classList.remove('thinking');
    msg.classList.add('error');
    _setMessageBody(msg, err?.message ?? 'Failed to run task.');
  }
}

// ─── Send chat message — routed via match() unless target is set ────────────

async function sendChatMessage() {
  const input    = $('chat-input');
  const text     = input.value.trim();
  if (!text) return;

  // Was this composed against a specific assistant capability via focusForAssistant?
  const targetId   = input.dataset.targetCapabilityId;
  const targetName = input.dataset.targetCapabilityName;

  input.value = '';
  delete input.dataset.targetCapabilityId;
  delete input.dataset.targetCapabilityName;
  input.placeholder = 'Message Agent HUB…';
  _autosizeInput();
  $('btn-chat-send').disabled = true;

  appendMessage({ role: 'user', body: text });

  if (targetId) {
    // Direct invocation against a specific assistant
    await _invokeAssistant({ id: targetId, name: targetName }, text);
    return;
  }

  // Routed flow — semantic match then invoke
  const status = $('input-status');
  status.textContent = 'Routing…';
  status.className = 'input-status routing';

  const thinkingMsg = appendMessage({ role: 'thinking', body: 'Thinking…' });

  let matches;
  try {
    matches = await ChatAPI.match(text, { limit: 5, minConfidence: 0.2 });
  } catch (err) {
    thinkingMsg.classList.add('error');
    const body = err?.message ?? 'Routing failed.';
    _setMessageBody(thinkingMsg, body);
    await _finalizeAssistantBubble(thinkingMsg, { body, attribution: null });
    status.textContent = '';
    status.className = 'input-status';
    return;
  }

  if (!matches.length) {
    const body = "I don't have a capability that matches your question yet. Try opening Studio to add one, or browse available capabilities.";
    _setMessageBody(thinkingMsg, body);
    await _finalizeAssistantBubble(thinkingMsg, { body, attribution: null });
    status.textContent = '';
    status.className = 'input-status';
    return;
  }

  const best = matches[0];
  const invocationId = crypto.randomUUID();
  thinkingMsg.id = `msg-${invocationId}`;
  thinkingMsg.dataset.capabilityId = best.capabilityId;

  // Add attribution
  const attr = document.createElement('div');
  attr.className = 'message-attribution';
  attr.textContent = `${best.name} · ${Math.round(best.confidence * 100)}% match`;
  thinkingMsg.querySelector('.message-content').prepend(attr);
  _setMessageBody(thinkingMsg, 'Working on it…');

  status.textContent = '';
  status.className = 'input-status';

  // Pass C — if this is a Strategy with declared params, extract them from the
  // user's message before invoking. Missing params trigger a fill-in modal.
  let paramValues = {};
  try {
    const cap = await ChatAPI.getCapability(best.capabilityId);
    const declaredParams = cap?.parameters ? Object.keys(cap.parameters) : [];
    if (declaredParams.length > 0) {
      _setMessageBody(thinkingMsg, 'Reading your request…');
      const extracted = await ChatAPI.extractStrategyParams(best.capabilityId, text);
      paramValues = { ...extracted.params };
      if (extracted.missing.length > 0) {
        // Prompt the user to fill the missing params
        const collected = await _promptForMissingParams(cap.name, extracted.missing, cap.parameters);
        if (!collected) {
          // User cancelled
          thinkingMsg.classList.remove('thinking');
          _setMessageBody(thinkingMsg, 'Cancelled.');
          return;
        }
        paramValues = { ...paramValues, ...collected };
      }
      _setMessageBody(thinkingMsg, 'Working on it…');
    }
  } catch (err) {
    console.warn('[chat] param extraction failed:', err);
    // Continue to invoke without params — the Strategy may still work, or
    // the engine will surface a clearer error from substitution.
  }

  // v2.71.10 (Bug W fix) — Ensure conversation before invoke; see _executeTask.
  const conversationId = await _ensureConversation();

  try {
    await ChatAPI.invoke(best.capabilityId, { question: text, params: paramValues }, { invocationId, conversationId });
    _trackInvocation(invocationId);
    _addCancelButton(thinkingMsg, invocationId);
  } catch (err) {
    thinkingMsg.classList.remove('thinking');
    thinkingMsg.classList.add('error');
    _setMessageBody(thinkingMsg, err?.message ?? 'Failed to invoke capability.');
  }
}

/**
 * Pass C — Prompt the user to fill in missing strategy params.
 *
 * Shows a modal dialog with one typed control per missing param. Returns the
 * user's values as { NAME: value } on submit, or null on cancel.
 *
 * v2.74.65 — Delegates to Services/ParamForm.js so file / number / boolean
 * inputs work the same here as in runTaskCapability. The full param
 * descriptors come from the capability so types are preserved (rather than
 * defaulting every missing param to a text box).
 *
 * @param {string} strategyName
 * @param {string[]} missing - param names needing values
 * @param {Object} [paramsDict] - cap.parameters dict; used to resolve types
 * @returns {Promise<Object|null>}
 */
function _promptForMissingParams(strategyName, missing, paramsDict = {}) {
  // Reuse the descriptor-dict adapter, but restrict to missing names only.
  // Names without a descriptor default to required string inputs (matches
  // historical behavior for untyped strategies).
  const full = _descriptorParamsToArray(paramsDict);
  const byName = new Map(full.map(p => [p.name, p]));
  const params = missing.map(name => byName.get(name) || {
    name, kind: 'scalar', type: 'string', required: true,
  });

  return promptForParams(params, {
    title: `${strategyName} needs a bit more info`,
    hint:  'Fill in the values below to continue.',
    submitLabel: 'Run',
  });
}

// v2.74.65 — _esc removed; the inline modal HTML it served was retired when
// _promptForMissingParams switched to Services/ParamForm.js. escHtml from
// shared.js covers any remaining needs in this file.

async function _invokeAssistant(cap, question) {
  const invocationId = crypto.randomUUID();
  const msg = appendMessage({
    role: 'thinking',
    body: 'Thinking…',
    attribution: cap.name,
    id: `msg-${invocationId}`,
  });
  msg.dataset.capabilityId = cap.id;

  // v2.71.10 (Bug W fix) — Ensure conversation before invoke; see _executeTask.
  const conversationId = await _ensureConversation();

  try {
    await ChatAPI.invoke(cap.id, { question }, { invocationId, conversationId });
    _trackInvocation(invocationId);
    _addCancelButton(msg, invocationId);
    _refreshRunningBar();
  } catch (err) {
    msg.classList.remove('thinking');
    msg.classList.add('error');
    _setMessageBody(msg, err?.message ?? 'Failed to send.');
  }
}

// ─── Termination cleanup ─────────────────────────────────────────────────────

function _finalizeMessage(invocationId, msg) {
  _untrackInvocation(invocationId);
  _removeCancelButton(msg);
  msg.classList.remove('thinking');
  // v2.74.106 — Conditional scroll: a strategy completing while the user is
  // scrolled up reading history shouldn't yank them down. They'll see the
  // running bar / status indicator update; their scroll position is theirs.
  _scrollToBottomIfNearBottom();
}

// ─── Invocation event handlers ───────────────────────────────────────────────

/**
 * v2.39.0 — Handle invocation.started for invocations launched outside chat.
 * Debug-mode invocations are owned by the debugger panel and are skipped here.
 * Non-debug orphan invocations get a chat message so their progress is visible.
 */
function handleInvocationStarted(event) {
  const { invocationId, capabilityName, debugMode } = event;
  // Chat-initiated invocations are already tracked; their chat message
  // exists. Nothing to do.
  if (_activeInvocations.has(invocationId)) return;
  // v2.39.0 — Debug-mode invocations are owned by the debugger surface.
  // Chat ignores them entirely. The user is not in the chat panel anyway —
  // studio's ▶ opens the debugger panel before the invocation starts.
  if (debugMode && debugMode !== 'off') return;

  // Orphan non-debug invocation — make a chat message for it. (Rare —
  // mostly chat tracks its own invocations explicitly.)
  _enterConversation();
  const msg = appendMessage({
    role: 'thinking',
    body: 'Running…',
    attribution: capabilityName ?? 'Capability',
    id: `msg-${invocationId}`,
  });
  msg.dataset.capabilityId = event.capabilityId ?? '';
  _trackInvocation(invocationId);
  _addCancelButton(msg, invocationId);
}

function handleInvocationProgress(event) {
  const msg = document.getElementById(`msg-${event.invocationId}`);
  if (!msg) return;

  // v2.39.0 — paused/resumed events flow to the debugger surface, not chat.
  // Chat does not show these phases anymore.
  if (event.phase === 'paused' || event.phase === 'resumed') return;

  // Pass C — Fragment-aware progress rendering. Events fire with
  // { step, total, phase: 'fragment_start'|..., fragmentName, message }.
  // Show both a progress bar and the current fragment's name.
  let progress = msg.querySelector('.message-progress');
  if (!progress) {
    progress = document.createElement('div');
    progress.className = 'message-progress';
    progress.innerHTML = `
      <div class="progress-track"><div class="progress-fill"></div></div>
      <span class="progress-label"></span>`;
    msg.querySelector('.message-content').appendChild(progress);
  }

  const fill  = progress.querySelector('.progress-fill');
  const label = progress.querySelector('.progress-label');

  const step  = event.step  ?? 0;
  const total = event.total ?? 0;
  const frag  = event.fragmentName ?? '';
  const phase = event.phase ?? '';

  if (total > 0) {
    const pct = Math.round((step / total) * 100);
    fill.style.width = `${pct}%`;
  }

  const isError = phase === 'fragment_failed' || phase === 'fragment_post_failed';
  fill.className = `progress-fill${isError ? ' error' : ''}`;

  // Pass Cα — Surface skipped steps in the progress label so the user
  // understands why a step flashed past. Otherwise the label just shows
  // "Step 2/3: Open detail" and disappears when the next fragment starts,
  // which looks like the step was done conventionally.
  if (phase === 'fragment_skipped' && frag) {
    label.textContent = `Step ${step}/${total}: ${frag} — skipped (already done)`;
  } else if (total > 0 && frag) {
    label.textContent = `Step ${step}/${total}: ${frag}`;
  } else if (event.message) {
    label.textContent = event.message;
  }
}

async function handleInvocationCompleted(event) {
  const msg = document.getElementById(`msg-${event.invocationId}`);
  if (!msg) {
    // v2.74.106 — Bubble may be missing because the user switched
    // conversations mid-run (rehydrate wipes #messages). Still untrack
    // the invocation so _activeInvocations doesn't leak — otherwise
    // _updateRunningStatus shows a stale "1 capability running…" and the
    // switch-conversation guard fires false positives indefinitely.
    _untrackInvocation(event.invocationId);
    return;
  }

  const result      = event.result ?? {};
  const stepResults = Array.isArray(result.stepResults) ? result.stepResults : [];
  // E1 (v2.26.0) — Final Strategy scope. Includes input params (echoed back)
  // plus any values written by EXTRACT actions during execution. Tagged-value
  // shape: { name: { kind: 'scalar', value }, ... }.
  const extractedValues = result.extractedValues && typeof result.extractedValues === 'object'
    ? result.extractedValues
    : {};

  msg.querySelector('.message-progress')?.remove();

  // Try to fetch the capability descriptor for resultTemplate. Don't block on
  // failure — fall back to default rendering if the lookup fails.
  let resultTemplate = '';
  try {
    const cap = event.capabilityId ? await ChatAPI.getCapability(event.capabilityId) : null;
    resultTemplate = cap?.resultTemplate ?? '';
  } catch { /* leave empty, use default rendering */ }

  // Pass C — Strategy result rendering. Strategies emit a list of
  // { fragmentName, success, actionsRun, error } per step. Success = every
  // step succeeded (or was skipped because already-done). Render a checklist
  // + summary.
  // Pass Cα — "success" now includes skipped steps (postconditions already
  // held at entry). Count them separately in the summary so the user knows
  // what actually ran vs what was a no-op.
  const ranSteps     = stepResults.filter(r => r.success && !r.skipped);
  const skippedSteps = stepResults.filter(r => r.skipped);
  const failedSteps  = stepResults.filter(r => !r.success);

  let summaryLine;
  if (stepResults.length === 0) {
    summaryLine = `${event.capabilityName} completed.`;
  } else if (failedSteps.length === 0) {
    const skipNote = skippedSteps.length > 0 ? ` (${skippedSteps.length} skipped)` : '';
    summaryLine = `${event.capabilityName} completed — ${ranSteps.length + skippedSteps.length}/${stepResults.length} step${stepResults.length === 1 ? '' : 's'}${skipNote}.`;
  } else {
    summaryLine = `${event.capabilityName} — ${ranSteps.length + skippedSteps.length}/${stepResults.length} step${stepResults.length === 1 ? '' : 's'} succeeded.`;
  }

  // E1 (v2.26.0) — If the Strategy declared a resultTemplate, use it as the
  // primary headline; the step checklist still renders below for context.
  // Templates substitute {{NAME}} from the final scope. Undefined names are
  // left in the output literally — caught at authoring time as a composition
  // warning, not silently dropped.
  let templatedHeadline = '';
  if (resultTemplate.trim()) {
    templatedHeadline = applyResultTemplate(resultTemplate, extractedValues);
  }

  // Step checklist — v2.29.4 (Pass E2-5) now groups FOREACH iterations
  // under a summary row. See renderStepResults below.
  const stepsHtml = renderStepResults(stepResults);

  // E1 (v2.26.0) — Extracted-values panel. Only shown when the Strategy
  // captured something beyond its input params. Lists each name + value.
  // Renders below the step checklist; with a resultTemplate the headline
  // already says what the user cares about, this is the detail view.
  const extractedHtml = renderExtractedValuesPanel(extractedValues);

  const headline = templatedHeadline || summaryLine;
  const subline  = templatedHeadline ? `<div class="strategy-result-subline">${escHtml(summaryLine)}</div>` : '';
  const finalBody = `<div class="strategy-result-headline">${escHtml(headline)}</div>${subline}${stepsHtml}${extractedHtml}`;

  // headline contains user-visible text only; we already escHtml'd it
  _setMessageBody(msg, finalBody, { html: true });

  // Persist the final state
  const attribution = msg.querySelector('.message-attribution')?.textContent ?? null;
  _persistMessageUpdate(msg, {
    role: 'assistant',
    body: finalBody,
    markdown: false,
    html: true,
    attribution,
    outcome: null,
    invocationId: event.invocationId,
  }).then(() => _maybeGenerateTitle())
    .catch(err => console.warn('[chat] persist completion failed:', err.message));

  _finalizeMessage(event.invocationId, msg);
}

/**
 * E1 (v2.26.0) — Substitute {{NAME}} placeholders in the template using
 * tagged values from the scope. Unknown names are left in place (literal
 * `{{X}}` in the output) so the user notices.
 *
 * v2.74.107 — The regex matches UPPER_SNAKE only (`[A-Z][A-Z0-9_]*`). This
 * is intentional and matches the convention enforced by the
 * normalizeStrategyParams pipeline; lowercase / camelCase placeholders
 * (`{{userName}}`, `{{name}}`) deliberately fall through as literal text
 * rather than silently failing to substitute. If a strategy author writes a
 * camelCase placeholder, they'll see it in the output and know to rename.
 */
function applyResultTemplate(template, extractedValues) {
  return String(template).replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (match, name) => {
    const v = extractedValues[name];
    if (v == null) return match;
    if (typeof v === 'string') return v;
    if (v.kind === 'scalar') return String(v.value ?? '');
    if (v.kind === 'list')   return (v.items ?? []).map(it => it?.value ?? '').join(', ');
    if (v.kind === 'element') return v.selector ?? '';
    return String(v);
  });
}

/**
 * v2.29.4 (Pass E2-5) — Group FOREACH iteration rows under a summary row.
 *
 * Engine tags stepResults entries produced inside a FOREACH body with:
 *   iteration: { index, count, variable, over, topLevelIndex }
 *
 * Contiguous entries sharing the same topLevelIndex form a group. We emit:
 *   - One summary row:   "FOREACH over JOBS — 3/3 iterations succeeded" (or
 *                        "2/3 succeeded" with a failure count when mixed)
 *   - Nested iteration rows indented, one per body-fragment execution.
 *
 * Auto-behavior: groups where every iteration succeeded render collapsed
 * (summary only). Groups with any failure render expanded so the user
 * immediately sees where it went wrong. (No toggle in E2-5 — purely
 * automatic. Click-to-expand is a later enhancement.)
 *
 * Top-level rows (no iteration tag) render as before.
 */
function renderStepResults(stepResults) {
  if (!Array.isArray(stepResults) || stepResults.length === 0) return '';

  // Pass 1: partition into segments. Each segment is either {kind:'single', row}
  // or {kind:'group', topLevelIndex, rows:[...], variable, over, totalCount}.
  const segments = [];
  let i = 0;
  while (i < stepResults.length) {
    const r = stepResults[i];
    if (r?.iteration && typeof r.iteration.topLevelIndex === 'number') {
      // Collect the contiguous run with the same topLevelIndex
      const topIdx = r.iteration.topLevelIndex;
      const rows = [];
      while (i < stepResults.length
             && stepResults[i]?.iteration
             && stepResults[i].iteration.topLevelIndex === topIdx) {
        rows.push(stepResults[i]);
        i++;
      }
      segments.push({
        kind: 'group',
        topLevelIndex: topIdx,
        rows,
        variable: rows[0].iteration.variable ?? '?',
        over: rows[0].iteration.over ?? '?',
        totalCount: rows[0].iteration.count ?? rows.length,
      });
    } else {
      segments.push({ kind: 'single', row: r, originalIndex: i });
      i++;
    }
  }

  // Pass 2: render. We number display step positions based on original
  // stepResults indices for singles (+1) and for groups, on the first
  // iteration row's original index (+1). Matches what users see in progress.
  let topStep = 1;       // human-facing step number, incremented per segment
  const html = segments.map((seg) => {
    if (seg.kind === 'single') {
      const r = seg.row;
      const cls = r.skipped ? 'skipped' : (r.success ? 'success' : 'error');
      const icon = r.skipped ? '◌' : (r.success ? '✓' : '✕');
      const meta = r.skipped
        ? `<span class="step-skip">${escHtml(r.skipReason ?? 'already done')}</span>`
        : (r.actionsRun != null
            ? `<span class="step-actions">${r.actionsRun} action${r.actionsRun === 1 ? '' : 's'}</span>`
            : '');
      const step = topStep++;
      return `
        <div class="strategy-result-step ${cls}">
          <span class="step-num">${step}</span>
          <span class="step-icon">${icon}</span>
          <span class="step-name">${escHtml(r.fragmentName ?? '?')}</span>
          ${meta}
          ${r.success ? '' : `<span class="step-error">${escHtml(r.error ?? 'failed')}</span>`}
        </div>`;
    }

    // Group (FOREACH)
    const successCount = seg.rows.filter(r => r.success).length;
    const failCount    = seg.rows.length - successCount;
    const groupSucceeded = failCount === 0;
    const step = topStep++;
    const summaryCls = groupSucceeded ? 'success' : 'error';
    const summaryIcon = groupSucceeded ? '✓' : '✕';
    const summaryLabel = groupSucceeded
      ? `FOREACH ${escHtml(seg.over)} — ${seg.rows.length}/${seg.totalCount} iteration${seg.rows.length === 1 ? '' : 's'} succeeded`
      : `FOREACH ${escHtml(seg.over)} — ${successCount}/${seg.rows.length} succeeded, ${failCount} failed`;

    const showIterations = !groupSucceeded;   // auto-expand on failure
    const iterationRows = showIterations
      ? seg.rows.map((r) => {
          const cls = r.skipped ? 'skipped' : (r.success ? 'success' : 'error');
          const icon = r.skipped ? '◌' : (r.success ? '✓' : '✕');
          const meta = r.skipped
            ? `<span class="step-skip">${escHtml(r.skipReason ?? 'already done')}</span>`
            : (r.actionsRun != null
                ? `<span class="step-actions">${r.actionsRun} action${r.actionsRun === 1 ? '' : 's'}</span>`
                : '');
          // Drop the "(iteration N/M)" suffix — the iteration.index + the
          // visual grouping already convey this.
          const displayName = String(r.fragmentName ?? '?').replace(/\s*\(iteration \d+\/\d+\)\s*$/, '');
          const iterIdx = r.iteration?.index ?? '?';
          return `
            <div class="strategy-result-step ${cls} foreach-iteration-row">
              <span class="step-iter-num">${iterIdx}</span>
              <span class="step-icon">${icon}</span>
              <span class="step-name">${escHtml(displayName)}</span>
              ${meta}
              ${r.success ? '' : `<span class="step-error">${escHtml(r.error ?? 'failed')}</span>`}
            </div>`;
        }).join('')
      : '';

    return `
      <div class="strategy-result-step foreach-summary ${summaryCls}">
        <span class="step-num">${step}</span>
        <span class="step-icon">${summaryIcon}</span>
        <span class="step-name">${summaryLabel}</span>
      </div>
      ${iterationRows ? `<div class="foreach-iteration-list">${iterationRows}</div>` : ''}`;
  }).join('');

  return `<div class="strategy-result-steps">${html}</div>`;
}

/**
 * E1 (v2.26.0) — Render an inline panel listing each extracted value as
 * NAME: value. Returns empty string when there's nothing to show. Skips
 * scalar values that exactly match the result template's substitution
 * targets to avoid duplication — the template already showed them.
 */
function renderExtractedValuesPanel(extractedValues) {
  const names = Object.keys(extractedValues);
  if (names.length === 0) return '';
  const rows = names.map(name => {
    const v = extractedValues[name];
    let displayValue;
    if (v == null) {
      displayValue = '<em class="empty-marker">empty</em>';
    } else if (typeof v === 'string') {
      displayValue = escHtml(v);
    } else if (v.kind === 'scalar') {
      displayValue = escHtml(String(v.value ?? ''));
    } else if (v.kind === 'list') {
      const items = v.items ?? [];
      displayValue = `<ul class="extracted-list">${items.map(it => `<li>${escHtml(String(it?.value ?? ''))}</li>`).join('')}</ul>`;
    } else if (v.kind === 'element') {
      displayValue = `<code>${escHtml(v.selector ?? '?')}</code>`;
    } else {
      displayValue = escHtml(String(v));
    }
    return `<div class="extracted-row"><code class="extracted-name">${escHtml(name)}</code><span class="extracted-value">${displayValue}</span></div>`;
  }).join('');
  return `<div class="strategy-extracted-panel"><div class="strategy-extracted-head">Captured</div>${rows}</div>`;
}

function _appendOutcomeCard(msg, { kind, label, detail }) {
  const card = document.createElement('div');
  card.className = `outcome-card ${kind}`;
  card.innerHTML = `
    <div class="outcome-label">${escHtml(label)}</div>
    <div class="outcome-snippet">${escHtml(detail)}</div>`;
  msg.querySelector('.message-content').appendChild(card);
}

function handleInvocationFailed(event) {
  const msg = document.getElementById(`msg-${event.invocationId}`);
  if (!msg) {
    // v2.74.106 — See handleInvocationCompleted; untrack on orphan.
    _untrackInvocation(event.invocationId);
    return;
  }

  msg.querySelector('.message-progress')?.remove();
  // v2.71.8 — Body says short status; outcome.detail carries the error.
  // Pre-v2.71.8 both contained the error text, producing visible duplicate
  // text in the bubble (body + outcome card showing the same string).
  const errorDetail = event.error ?? 'The task failed unexpectedly.';
  const attribution = msg.querySelector('.message-attribution')?.textContent ?? '';
  const bodyText = `${attribution || 'Task'} failed.`;
  _setMessageBody(msg, bodyText);
  msg.classList.add('error');
  const outcome = { kind: 'error', label: 'Failed', detail: errorDetail };
  _appendOutcomeCard(msg, outcome);

  _persistMessageUpdate(msg, {
    role: 'system',
    body: bodyText,
    attribution,
    outcome,
    invocationId: event.invocationId,
  }).catch(err => console.warn('[chat] persist failure failed:', err.message));

  _finalizeMessage(event.invocationId, msg);
}

function handleInvocationCancelled(event) {
  const msg = document.getElementById(`msg-${event.invocationId}`);
  if (!msg) {
    // v2.74.106 — See handleInvocationCompleted; untrack on orphan.
    _untrackInvocation(event.invocationId);
    return;
  }

  msg.querySelector('.message-progress')?.remove();
  _setMessageBody(msg, 'Cancelled.');

  const attribution = msg.querySelector('.message-attribution')?.textContent ?? null;
  _persistMessageUpdate(msg, {
    role: 'system',
    body: 'Cancelled.',
    attribution,
    invocationId: event.invocationId,
  }).catch(err => console.warn('[chat] persist cancel failed:', err.message));

  _finalizeMessage(event.invocationId, msg);
}

// ─── ChatAPI event subscription ──────────────────────────────────────────────

ChatAPI.onEvent((event) => {
  switch (event.type) {
    case 'capability.registry_changed':
      renderSuggestionCards().catch(() => {});
      if (!$('capability-drawer').classList.contains('hidden')) {
        renderCapabilityList().catch(() => {});
      }
      SlashPicker.refresh();
      break;
    case 'invocation.progress':   handleInvocationProgress(event); break;
    case 'invocation.completed':  handleInvocationCompleted(event); _refreshRunningBar(); break;
    case 'invocation.failed':     handleInvocationFailed(event); _refreshRunningBar(); break;
    case 'invocation.cancelled':  handleInvocationCancelled(event); _refreshRunningBar(); break;
    // v2.39.0 — orphan invocations (e.g. studio ▶) get a chat message
    // unless they're in debug mode (those go to the debugger surface).
    // v2.71.7 — Refresh transport bar on lifecycle changes.
    case 'invocation.started':    handleInvocationStarted(event); _refreshRunningBar(); break;
  }
});

// ─── Input behavior ──────────────────────────────────────────────────────────

// ─── Slash command picker ───────────────────────────────────────────────────
//
// When the input value starts with `/`, we intercept the flow:
//   - Show a picker above the input with capabilities filtered by the text
//     after the slash.
//   - Arrow keys move selection. Enter picks. Escape dismisses.
//   - Picking a task capability invokes it directly (with param form if
//     needed). Picking an assistant capability consumes the `/xyz` token
//     and leaves the input focused and targeted to that assistant.
//   - If the user types `/xyz` and hits Enter with no selectable match,
//     the text is sent normally through match() as a fallback — we don't
//     want to trap users in a broken state.
//
// The picker only activates when `/` is the FIRST character of the input.
// `/` in the middle of a message (URLs, dates, paths) is not a command.

const SlashPicker = (() => {
  let _candidates = [];   // filtered capabilities currently shown
  let _selected   = 0;    // index into _candidates
  let _allCaps    = null; // cached capability list (ready only)

  function isActive() {
    return !$('slash-picker').classList.contains('hidden');
  }

  function isSlashQuery(text) {
    return text.startsWith('/');
  }

  async function _getCapabilities() {
    if (!_allCaps) {
      _allCaps = await ChatAPI.listCapabilities({ status: 'ready' });
    }
    return _allCaps;
  }

  /** Invalidate the cache — called when capability registry changes. */
  function refresh() {
    _allCaps = null;
    if (isActive()) {
      update($('chat-input').value);
    }
  }

  /**
   * Rank capabilities for a given query string (text after the slash).
   * Empty query returns all; otherwise filters and ranks by match quality.
   */
  function _rank(caps, query) {
    if (!query) return [...caps];
    const q = query.toLowerCase();
    return caps
      .map(cap => {
        const name = (cap.name ?? '').toLowerCase();
        const id   = (cap.id ?? '').toLowerCase();
        let score;
        if (name.startsWith(q))      score = 3;
        else if (name.includes(q))   score = 2;
        else if (id.includes(q))     score = 1;
        else                         score = 0;
        return { cap, score, name };
      })
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map(entry => entry.cap);
  }

  /** Highlight the matched substring in a capability name. */
  function _highlight(name, query) {
    if (!query) return escHtml(name);
    const lower = name.toLowerCase();
    const q = query.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx === -1) return escHtml(name);
    return (
      escHtml(name.slice(0, idx)) +
      `<mark>${escHtml(name.slice(idx, idx + q.length))}</mark>` +
      escHtml(name.slice(idx + q.length))
    );
  }

  async function _render() {
    const list = $('slash-picker-list');
    list.innerHTML = '';

    const inputValue = $('chat-input').value;
    const query = inputValue.startsWith('/') ? inputValue.slice(1) : '';

    if (_candidates.length === 0) {
      list.innerHTML = `<div class="slash-picker-empty">No capability matches "/${escHtml(query)}". Press Enter to send as a regular message.</div>`;
      return;
    }

    _candidates.forEach((cap, idx) => {
      const item = document.createElement('button');
      item.className = `slash-item${idx === _selected ? ' selected' : ''}`;
      item.dataset.idx = idx;
      item.innerHTML = `
        <div class="slash-item-kind ${cap.kind === 'task' ? 'task' : 'ai'}">
          ${cap.kind === 'task' ? 'T' : 'AI'}
        </div>
        <div class="slash-item-content">
          <div class="slash-item-name">${_highlight(cap.name, query)}</div>
          ${cap.summary ? `<div class="slash-item-summary">${escHtml(cap.summary)}</div>` : ''}
        </div>`;
      item.addEventListener('mouseenter', () => {
        _selected = idx;
        _updateSelection();
      });
      item.addEventListener('click', (e) => {
        e.preventDefault();
        _selected = idx;
        select();
      });
      list.appendChild(item);
    });
  }

  function _updateSelection() {
    const items = $('slash-picker-list').querySelectorAll('.slash-item');
    items.forEach((item, idx) => {
      item.classList.toggle('selected', idx === _selected);
      if (idx === _selected) {
        item.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  /** Called on every input event. Opens, updates, or closes the picker. */
  async function update(inputValue) {
    if (!isSlashQuery(inputValue)) {
      close();
      return;
    }
    $('slash-picker').classList.remove('hidden');

    const query = inputValue.slice(1);
    const caps = await _getCapabilities();
    _candidates = _rank(caps, query);
    _selected   = 0;
    await _render();
  }

  function close() {
    $('slash-picker').classList.add('hidden');
    _candidates = [];
    _selected   = 0;
  }

  function moveSelection(delta) {
    if (_candidates.length === 0) return;
    _selected = (_selected + delta + _candidates.length) % _candidates.length;
    _updateSelection();
  }

  /** Invoke the currently selected capability. Returns true if consumed. */
  function select() {
    if (_candidates.length === 0) return false;
    const cap = _candidates[_selected];
    close();

    if (cap.kind === 'task') {
      // Clear input; runTaskCapability handles param form or direct invoke
      $('chat-input').value = '';
      _autosizeInput();
      $('btn-chat-send').disabled = true;
      runTaskCapability(cap);
    } else {
      // Assistant — set up targeted send, clear the /xyz token
      $('chat-input').value = '';
      _autosizeInput();
      $('btn-chat-send').disabled = true;
      focusForAssistant(cap);
    }
    return true;
  }

  return { isActive, update, close, moveSelection, select, refresh };
})();

// ─── Input behavior ──────────────────────────────────────────────────────────

function _autosizeInput() {
  const input = $('chat-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}

$('chat-input').addEventListener('input', () => {
  _autosizeInput();
  const value = $('chat-input').value;
  const hasText = value.trim().length > 0;
  $('btn-chat-send').disabled = !hasText;
  SlashPicker.update(value);
});

$('chat-input').addEventListener('keydown', (e) => {
  // Slash picker keyboard handling takes precedence when active
  if (SlashPicker.isActive()) {
    if (e.key === 'ArrowDown') { e.preventDefault(); SlashPicker.moveSelection(1);  return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); SlashPicker.moveSelection(-1); return; }
    if (e.key === 'Escape')    { e.preventDefault(); SlashPicker.close();           return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // If a capability matches, consume the Enter. Otherwise fall through
      // to send the literal text (which starts with /) as a regular message.
      if (SlashPicker.select()) return;
      // No match — close picker and send as regular message
      SlashPicker.close();
      if (!$('btn-chat-send').disabled) sendChatMessage();
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!$('btn-chat-send').disabled) sendChatMessage();
  }
});

$('btn-chat-send').addEventListener('click', sendChatMessage);

// ─── Init ────────────────────────────────────────────────────────────────────

(async function init() {
  // Attempt to restore the most recent conversation. If none exists, the
  // empty state remains and we show suggestion cards.
  try {
    const recent = await ConversationStore.mostRecent();
    if (recent) {
      const conv = await ConversationStore.load(recent.id);
      if (conv && conv.messages.length > 0) {
        await _rehydrateConversation(conv);
        // v2.71.4 — Resume running invocations. If a strategy was launched
        // and the panel was hidden mid-run, reopening should show the
        // running bubble + cancel button (not a stuck completed state).
        // Background continues persisting terminal events to ConversationStore;
        // any invocation that's already terminal has its result message in
        // the rehydrated conversation already.
        await _resumeRunningInvocations();
      } else {
        await renderSuggestionCards();
      }
    } else {
      await renderSuggestionCards();
    }
  } catch (err) {
    console.warn('[chat] init restore failed:', err.message);
    await renderSuggestionCards();
  }

  // v2.71.7 — Refresh transport bar at end of init regardless of conversation
  // state. Bar shows global running state — present even on an empty/new
  // conversation surface so user always sees their running strategies.
  await _refreshRunningBar();

  $('chat-input').focus();
})();

/**
 * v2.71.4 — Re-attach running-state UI to bubbles whose invocation is still
 * in flight. Called after rehydrateConversation on init, and when switching
 * to a different conversation via the history sidebar.
 *
 * Logic: query all running invocations from CapabilityAPI. For each one
 * whose bubble exists in the current DOM (id matches `msg-<invocationId>`),
 * mark the bubble as thinking and attach a cancel button. Live event
 * handlers (handleInvocationProgress / Completed / Failed / Cancelled)
 * continue to update the bubble normally as events arrive.
 *
 * Invocations belonging to other conversations are ignored — their messages
 * aren't in the current DOM. If the user switches to that conversation,
 * this function runs again and picks them up.
 */
async function _resumeRunningInvocations() {
  let running;
  try {
    running = await ChatAPI.listInvocations({ status: 'running' });
  } catch (err) {
    console.warn('[chat] failed to list running invocations:', err.message);
    return;
  }
  if (!Array.isArray(running) || running.length === 0) return;

  for (const inv of running) {
    if (!inv.invocationId) continue;
    if (inv.conversationId && inv.conversationId !== _currentConversationId) {
      // Belongs to a different conversation; skip.
      continue;
    }
    let msg = document.getElementById(`msg-${inv.invocationId}`);
    if (!msg) {
      // v2.71.5 — Bubble doesn't exist because thinking-state messages
      // don't persist (see persistence rules near appendMessage). On
      // panel reopen mid-run, the user's invoking message is in the
      // conversation but the strategy's thinking bubble was lost.
      // Synthesize one so the user can see the running state and
      // cancel. The bubble will be replaced/finalized by live event
      // handlers (handleInvocationCompleted/Failed/Cancelled) when the
      // invocation terminates.
      msg = appendMessage({
        role        : 'thinking',
        body        : 'Working on it…',
        attribution : inv.capabilityName ?? '',
        id          : `msg-${inv.invocationId}`,
      });
      // Live handlers route by capabilityId for resultTemplate lookup;
      // stash it on the bubble.
      if (inv.capabilityId) msg.dataset.capabilityId = inv.capabilityId;
    }
    msg.classList.add('thinking');
    _setMessageBody(msg, 'Working on it…');
    _trackInvocation(inv.invocationId);
    _addCancelButton(msg, inv.invocationId);
  }
}

// v2.71.7 — Running-invocations transport bar.
// Sticky bar at the top of chat showing all running invocations with
// capability name, elapsed time, and stop button. Visible whenever
// invocations are active; hidden otherwise.
//
// Rendering strategy: full rerender on lifecycle events (cheap — one or two
// rows typically). Time counter ticks every second via a single setInterval
// while bar is visible.
//
// Data source: ChatAPI.listInvocations({status:'running'}). Cached state
// _runningBarState keeps rendered ids so we don't double-rebuild on every
// tick — only the elapsed text updates per tick.

const _runningBarState = {
  invocations: new Map(),  // invocationId → { capabilityName, startedAt }
  tickInterval: null,
  // v2.71.10 (Bug R fix) — Single-flight guard. inFlight=true while a refresh
  // is awaiting listInvocations response. Subsequent calls during that window
  // just set pending=true; at the end of the in-flight refresh, if pending,
  // we re-run once. Prevents out-of-order async responses from overwriting
  // fresh data with stale data.
  inFlight: false,
  pending: false,
};

async function _refreshRunningBar() {
  // v2.71.10 (Bug R fix) — Single-flight. If a refresh is already in flight,
  // mark pending and return; the running refresh will pick this up at end.
  if (_runningBarState.inFlight) {
    _runningBarState.pending = true;
    return;
  }
  _runningBarState.inFlight = true;
  try {
    await _refreshRunningBarOnce();
  } finally {
    _runningBarState.inFlight = false;
  }
  // If a refresh was requested while we were awaiting, re-run once. We use
  // a one-shot pending flag rather than a loop so multiple queued requests
  // collapse to a single follow-up.
  if (_runningBarState.pending) {
    _runningBarState.pending = false;
    // Schedule rather than recurse — keeps stack flat under burst load.
    setTimeout(() => _refreshRunningBar().catch(() => {}), 0);
  }
}

async function _refreshRunningBarOnce() {
  const bar = $('running-bar');
  if (!bar) return;

  let running;
  try {
    running = await ChatAPI.listInvocations({ status: 'running' });
  } catch (err) {
    console.warn('[chat] running-bar refresh failed:', err.message);
    return;
  }
  if (!Array.isArray(running)) running = [];

  if (running.length === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    _runningBarState.invocations.clear();
    if (_runningBarState.tickInterval) {
      clearInterval(_runningBarState.tickInterval);
      _runningBarState.tickInterval = null;
    }
    return;
  }

  // Update cached state — preserve existing entries, add new ones, drop gone.
  const seen = new Set();
  for (const inv of running) {
    if (!inv.invocationId) continue;
    seen.add(inv.invocationId);
    if (!_runningBarState.invocations.has(inv.invocationId)) {
      _runningBarState.invocations.set(inv.invocationId, {
        capabilityName: inv.capabilityName ?? 'Capability',
        startedAt     : inv.startedAt ?? Date.now(),
      });
    }
  }
  for (const id of [..._runningBarState.invocations.keys()]) {
    if (!seen.has(id)) _runningBarState.invocations.delete(id);
  }

  // Render. One row per invocation.
  bar.innerHTML = [..._runningBarState.invocations.entries()].map(([id, info]) => {
    const elapsed = _formatElapsed(Date.now() - info.startedAt);
    return `
      <div class="running-row" data-invocation-id="${escAttr(id)}">
        <span class="running-pulse-dot"></span>
        <span class="running-name" title="${escAttr(info.capabilityName)}">${escHtml(info.capabilityName)}</span>
        <span class="running-elapsed" data-elapsed-for="${escAttr(id)}">${escHtml(elapsed)}</span>
        <button class="running-stop icon-btn" data-stop-invocation="${escAttr(id)}" title="Stop ${escAttr(info.capabilityName)}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="1"/>
          </svg>
        </button>
      </div>`;
  }).join('');
  bar.classList.remove('hidden');

  // Wire stop buttons (full rerender invalidates handlers each time).
  bar.querySelectorAll('[data-stop-invocation]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.stopInvocation;
      btn.disabled = true;
      try {
        await ChatAPI.cancel(id);
      } catch (err) {
        toast(`Stop failed: ${err.message}`, 'err');
        btn.disabled = false;
      }
    });
  });

  // Start/keep the elapsed-time tick interval while bar is visible.
  if (!_runningBarState.tickInterval) {
    _runningBarState.tickInterval = setInterval(_tickRunningBarElapsed, 1000);
  }
}

function _tickRunningBarElapsed() {
  const bar = $('running-bar');
  if (!bar || bar.classList.contains('hidden')) return;
  for (const [id, info] of _runningBarState.invocations) {
    const el = bar.querySelector(`[data-elapsed-for="${CSS.escape(id)}"]`);
    if (el) el.textContent = _formatElapsed(Date.now() - info.startedAt);
  }
}

function _formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm}m`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Re-render a persisted conversation into the DOM, preserving message ids
 * and state. Called on init (restore most recent) and when switching
 * conversations via the history sidebar (Pass 2).
 */
async function _rehydrateConversation(conv) {
  // v2.74.107 — Cancel any open param forms before swapping conversations.
  // Same rationale as _resetConversation: prevents awaiters from hanging
  // on detached buttons after the messages wipe. Modal forms (rendered to
  // body) also get cancelled since the awaiter callback would still try to
  // update the now-detached thinkingMsg.
  _cancelOpenParamForms();
  _currentConversationId = conv.id;
  _enterConversation();
  $('messages').innerHTML = '';

  for (const pm of conv.messages) {
    const dom = appendMessage({
      role        : pm.role,
      body        : pm.body,
      attribution : pm.attribution,
      id          : pm.invocationId ? `msg-${pm.invocationId}` : null,
      // Skip auto-persist — we're rehydrating from storage, not creating new
      skipPersist : true,
    });
    dom.dataset.messageId = pm.id;
    dom.dataset.ts        = pm.ts;

    if (pm.markdown) {
      _setMessageBody(dom, pm.body, { markdown: true });
    } else if (pm.html || looksLikeStrategyResultHtml(pm.body)) {
      _setMessageBody(dom, pm.body, { html: true });
    }
    if (pm.outcome) {
      _appendOutcomeCard(dom, pm.outcome);
    }
    if (pm.role === 'system') {
      dom.classList.add(pm.outcome?.kind === 'error' ? 'error' : '');
    }
  }
}

