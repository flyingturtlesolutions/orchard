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
import { planAssistantTurn } from './Core/orchTurn.js';   // ORCH-C — grounded turn-brain (decision → say + action)
import { decomposeAsk, looksComplex } from './Core/orchChain.js';   // ORCH-X — decompose / complexity gate for the LLM planner
import { classifyFeedback } from './Core/orchFeedback.js'; // ORCH-FB — recognize corrective feedback (LLM refines)
import { parseAdminCommand } from './Core/orchAdmin.js';    // ORCH-ADMIN — management commands (clear/delete)
import { classifyReadAsk } from './Core/observe.js';        // OBS-READ — is the ask a question (a read)?

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

// Delete ALL conversations from the history menu (confirm first; this can't be undone). Wipes the active
// conversation too, then resets to the empty state — mirrors the per-item delete's active-conversation path.
$('btn-delete-all-conversations').addEventListener('click', async () => {
  const list = await ConversationStore.list();
  if (!list.length) return;
  if (!confirm(`Delete all ${list.length} conversation${list.length === 1 ? '' : 's'}? This can't be undone.`)) return;
  await ConversationStore.deleteAll();
  _clearCurrentConversation();
  _resetConversation();
  await renderSuggestionCards();
  await _renderHistoryList();
});

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

// ── ORCH-C — grounded conversational turn ───────────────────────────────────────────────────────────────
// Page-scoped HIT/MISS over the DEMONSTRATED library (Core/orchMatch via ORCH_MATCH). Tried BEFORE the legacy
// ChatAPI.match: on a grounded HIT we run/confirm/disambiguate here; on any MISS or error we return false and
// the existing routed flow takes over unchanged. The grounded substrate and the legacy capabilities coexist.
const _orchReq = (type, payload) => new Promise((resolve) => {
  let done = false;
  const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 120000);
  try {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve(chrome.runtime.lastError ? null : res);
    });
  } catch { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
});

async function _orchActiveTab() {
  try { const tabs = await chrome.tabs.query({ active: true, currentWindow: true }); return (tabs && tabs[0]) || null; }
  catch { return null; }
}

// REPLAY a grounded capability and report the outcome in `msg`. On success, records the ask as a confirmation
// (ORCH-D/G flywheel: alias accretion + health → future auto-fire). NO LLM in this path.
async function _orchRun(msg, { groundId, capabilityId, intent, paramValues, tabId, ask, params }) {
  _setMessageBody(msg, `Running “${intent || 'it'}”…`);
  const res = await _orchReq('REPLAY_SG_CAPABILITY', { tabId, groundId, capabilityId, paramValues });
  if (!res || res.success === false) {
    _setMessageBody(msg, `That didn’t run${res && res.error ? ` — ${res.error}` : ''}.`);
    _orchOfferRecord(msg, { groundId, tabId, ask, label: '● Show me the right way' });
  } else if (res.ran === false) {
    if (res.pruned) {   // the matched capability turned out orphaned → treat as a NEW request, not "it was deleted"
      _setMessageBody(msg, `I don’t have a way to do that here yet — want to show me?`);
      _orchOfferRecord(msg, { groundId, tabId, ask, label: '● Show me how' });
    } else {
      _setMessageBody(msg, res.reason || 'Couldn’t run on this page — make sure you’re on the right page.');
    }
  } else if (res.ok) {
    _setMessageBody(msg, `Done — ran “${intent || 'it'}”.`);
    _orchReq('ORCH_RECORD_ALIAS', { groundId, capabilityId, phrase: ask });   // confirm → flywheel
    _lastOrch = { groundId, capabilityId, tabId, ask, intent, bindings: paramValues || {}, params: params || null };
    _orchFeedbackBar(msg);   // ORCH-FB — 👎 / Remove: correct a wrong run in chat, no Studio
  } else {
    _setMessageBody(msg, `That didn’t work as expected${res.reason ? ` — ${res.reason}` : ''}.`);
    _orchOfferRecord(msg, { groundId, tabId, ask, label: '● Show me the right way' });
  }
}

function _orchActionBar(msg) {
  const bar = document.createElement('div');
  bar.className = 'orch-actions';
  msg.querySelector('.message-content').appendChild(bar);
  return bar;
}

// ── ORCH-FB — corrective feedback ───────────────────────────────────────────────────────────────────────────
// The LAST grounded action, so free-text feedback ("not that" / "that's wrong" / "delete it" / "wrong category,
// should be Vectors") and the 👎 controls know WHAT to correct. Set on every confirm/run; cleared after retract.
let _lastOrch = null;
const _mkBtn = (label, fn) => { const b = document.createElement('button'); b.className = 'btn-secondary tiny'; b.type = 'button'; b.textContent = label; b.addEventListener('click', fn); return b; };

// Apply a correction to the last action (button → fixed `kind`; typed → `text` for the LLM wrapper to interpret),
// render the result, and offer the right next step. de_alias/demote/retract are persisted in the background.
async function _orchFeedbackFlow(msg, { kind = '', text = '' } = {}) {
  const ctx = _lastOrch;
  if (!ctx) { _setMessageBody(msg, 'Nothing recent to correct — ask me something first.'); return; }
  _setMessageBody(msg, 'Noting that…');
  const res = await _orchReq('ORCH_FEEDBACK', { groundId: ctx.groundId, capabilityId: ctx.capabilityId, ask: ctx.ask, kind, text, context: { intent: ctx.intent, ask: ctx.ask, bindings: ctx.bindings, params: ctx.params } });
  if (!res || res.success === false) { _setMessageBody(msg, `Couldn’t apply that${res && res.error ? ` — ${res.error}` : ''}.`); return; }
  _setMessageBody(msg, res.say || 'Done.');
  const fu = res.followup;
  if (fu === 'rerun' && res.correction) {                       // wrong_value → re-run with the corrected binding
    await _orchRun(appendMessage({ role: 'assistant', body: '' }), { groundId: ctx.groundId, tabId: ctx.tabId, capabilityId: ctx.capabilityId, intent: ctx.intent, ask: ctx.ask, paramValues: { ...(ctx.bindings || {}), ...res.correction } });
  } else if (fu === 'fix_or_retract') {
    const bar = _orchActionBar(msg);
    bar.appendChild(_mkBtn('● Show me the right way', () => { bar.remove(); _orchRecordFlow(msg, { groundId: ctx.groundId, tabId: ctx.tabId, ask: ctx.ask }); }));
    bar.appendChild(_mkBtn('🗑 Remove it', () => { bar.remove(); _orchFeedbackFlow(appendMessage({ role: 'assistant', body: '' }), { kind: 'retract' }); }));
  } else if (fu === 'record' || fu === 'alternatives') {
    _orchOfferRecord(msg, { groundId: ctx.groundId, tabId: ctx.tabId, ask: ctx.ask, label: '● Show me the right way' });
  }
  if (kind === 'retract' || res.applied?.includes('retract')) _lastOrch = null;
}

// A thumbs-down / remove bar shown after a run completes, so a wrong action is correctable IN CHAT (no Studio).
function _orchFeedbackBar(msg) {
  const bar = _orchActionBar(msg);
  bar.appendChild(_mkBtn('👎 Wrong', () => { _orchFeedbackFlow(appendMessage({ role: 'assistant', body: '' }), { kind: 'reject_run' }); }));
  bar.appendChild(_mkBtn('🗑 Remove', () => { _orchFeedbackFlow(appendMessage({ role: 'assistant', body: '' }), { kind: 'retract' }); }));
}

// ── ORCH-X — semantic plan over capabilities ────────────────────────────────────────────────────────────────
// A complex single sentence ("search SWE jobs in minneapolis posted last 7 days") is decomposed by the LLM into
// ORDERED capability-routed steps WITH bindings (ORCH_PLAN), then confirmed + run. Unlike the lexical chain, the
// steps are already resolved (capabilityId + bindings) — no per-step re-match.
function _orchConfirmPlan(msg, { tabId, groundId, steps, gaps = [] }) {
  const fmt = (b) => Object.keys(b || {}).length ? ` (${Object.entries(b).map(([k, v]) => `${k}=${v}`).join(', ')})` : '';
  const list = steps.map((s, i) => `${i + 1}. ${s.intent}${fmt(s.bindings)}`).join('\n');
  const head = steps.length ? `I’ll do ${steps.length} step${steps.length > 1 ? 's' : ''} in order:\n${list}` : 'I don’t have a saved capability for this yet — I can try to work it out from the page.';
  // HONEST partial coverage — name the constraints no capability covers; we'll TRY them via the NL fallback after.
  const gapNote = gaps.length ? `\n\n⚠ Not saved yet: ${gaps.join(', ')} — I’ll try ${gaps.length > 1 ? 'these' : 'this'} from the page after.` : '';
  _setMessageBody(msg, head + gapNote);
  const bar = _orchActionBar(msg);
  if (steps.length) bar.appendChild(_mkBtn(steps.length > 1 ? `Run all ${steps.length}` : 'Run it', () => { bar.remove(); _orchRunPlan(msg, { tabId, groundId, steps, gaps }); }));
  else if (gaps.length) bar.appendChild(_mkBtn('✨ Try to work it out', () => { bar.remove(); _orchTryGaps(msg, { tabId, groundId, gaps }); }));
  bar.appendChild(_mkBtn('Cancel', () => { bar.remove(); _setMessageBody(msg, 'Okay — cancelled.'); }));
}

async function _orchRunPlan(msg, { tabId, groundId, steps, gaps = [] }) {
  const total = steps.length;
  for (let i = 0; i < total; i++) {
    const s = steps[i];
    _setMessageBody(msg, `Step ${i + 1} of ${total}: “${s.intent}”…`);
    const res = await _orchReq('REPLAY_SG_CAPABILITY', { tabId, groundId, capabilityId: s.capabilityId, paramValues: (s.bindings && typeof s.bindings === 'object') ? s.bindings : {} });
    if (!res || res.success === false || res.ran === false || res.ok === false) {
      const why = (res && (res.error || res.reason)) ? ` — ${res.error || res.reason}` : '';
      _setMessageBody(msg, `Step ${i + 1} (“${s.intent}”) didn’t run${why}.`);
      _orchOfferRecord(msg, { groundId, tabId, ask: s.clause || s.intent, label: '● Show me the right way' });
      return;
    }
    _orchReq('ORCH_RECORD_ALIAS', { groundId, capabilityId: s.capabilityId, phrase: s.clause || s.intent });   // flywheel per step
    await new Promise((r) => setTimeout(r, 800));   // settle between steps (navigation / render)
  }
  // NL FALLBACK — the parts no saved capability covered now run through the NL pipeline ON THE RESULTING PAGE
  // (where the filters live). Offer rather than auto-run (precision-first: an unproven plan touching the page).
  if (gaps.length) {
    _setMessageBody(msg, `${total ? `Ran ${total} step${total > 1 ? 's' : ''}. ` : ''}I haven’t saved: ${gaps.join(', ')} — try to work ${gaps.length > 1 ? 'them' : 'it'} out from the page?`);
    const bar = _orchActionBar(msg);
    bar.appendChild(_mkBtn(`✨ Try ${gaps.length > 1 ? 'them' : 'it'}`, () => { bar.remove(); _orchTryGaps(appendMessage({ role: 'assistant', body: '' }), { tabId, groundId, gaps }); }));
    bar.appendChild(_mkBtn('● Show me instead', () => { bar.remove(); _orchRecordFlow(appendMessage({ role: 'assistant', body: '' }), { groundId, tabId, ask: gaps[0] }); }));
    return;
  }
  _setMessageBody(msg, `Done — ran all ${total} steps.`);
}

// ── ORCH-X NL FALLBACK — resolve a gap fresh from the page (the NL pipeline), promote it on a verified pass ─────
// A gap (a constraint with no saved capability) runs through RUN_SG_TRIAL[tier2] = comprehend → match to the
// Locale → bind → execute on the live tab → POSTCONDITION-verify. On a verified pass we ACCEPT it (promote to a
// durable capability), so next time it's a CACHE HIT. On any failure (no Locale / unmatched / postcondition not
// held) it falls to "show me the right way". This is the "capabilities as cache, NL as compiler" loop closing.
async function _orchTryGaps(msg, { tabId, groundId, gaps }) {
  for (let i = 0; i < gaps.length; i++) {
    const m = i === 0 ? msg : appendMessage({ role: 'assistant', body: '' });
    await _orchNlFallback(m, { tabId, groundId, ask: gaps[i] });
  }
}

async function _orchNlFallback(msg, { tabId, groundId, ask }) {
  _setMessageBody(msg, `Working out “${ask}” from the page…`);
  const res = await _orchReq('RUN_SG_TRIAL', { tabId, groundId, intent: ask, tier2: true });
  if (!res || res.success === false) {
    _setMessageBody(msg, `I couldn’t work out “${ask}”${res && res.error ? ` — ${res.error}` : ''}.`);
    _orchOfferRecord(msg, { groundId, tabId, ask, label: '● Show me the right way' });
    return false;
  }
  const passed = !!(res.tier2Score && res.tier2Score.verdict === 'tier2-pass' && res.acceptEligible);
  if (!passed) {
    _setMessageBody(msg, `I tried, but couldn’t confirm “${ask}” worked here — want to show me?`);
    _orchOfferRecord(msg, { groundId, tabId, ask, label: '● Show me the right way' });
    return false;
  }
  // Verified pass → PROMOTE to a durable capability (cache fill) + seed the alias so the next ask is instant.
  let saved = '';
  try {
    const acc = await _orchReq('ACCEPT_SG_TRIAL', { groundId, tabId });
    const capId = acc && acc.success && acc.accepted && ((acc.capability && acc.capability.id) || acc.capabilityId);
    if (capId) { _orchReq('ORCH_RECORD_ALIAS', { groundId, capabilityId: capId, phrase: ask }); saved = ' — saved for next time'; }
  } catch { /* */ }
  _setMessageBody(msg, `Done — worked out “${ask}” from the page${saved}.`);
  return true;
}

// ── OBS-READ — observations (the KNOW half) ─────────────────────────────────────────────────────────────────
// A question ("how many results?") is answered by READING the page, not acting on it. You author an observation
// by POINTING at the value (the picker); running it EXTRACTs + returns the value inline. A read has no side
// effect, so it auto-runs without a confirm gate.

// Activate the element picker and resolve with the user's PICK_RESULT (or null on cancel/timeout).
function _orchPickOnce({ tabId }) {
  return new Promise((resolve) => {
    const sessionId = `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); chrome.runtime.onMessage.removeListener(onMsg); resolve(v); };
    const onMsg = (m) => { if (m && m.type === 'PICK_RESULT' && m.sessionId === sessionId) finish(m); };
    const timer = setTimeout(() => finish(null), 120000);
    // PICK_RESULT arrives back over runtime.onMessage (a content script can only runtime.sendMessage to the
    // extension); but START_PICK must be delivered TO the content script, which is tabs.sendMessage, not runtime.
    chrome.runtime.onMessage.addListener(onMsg);
    try { chrome.tabs.sendMessage(tabId, { type: 'START_PICK', payload: { sessionId, mode: 'target' } }, () => void chrome.runtime.lastError); }
    catch { finish(null); }
  });
}

// Capture an observation: point at the value → persist it for this read-ask.
async function _orchObserveCapture(msg, { groundId, tabId, ask }) {
  _setMessageBody(msg, '◎ Point at the value I should read on the page…');
  const picked = await _orchPickOnce({ tabId });
  if (!picked || !picked.selector || picked.error) { _setMessageBody(msg, `Didn’t catch that${picked && picked.error ? ` (${picked.error})` : ''} — ask again to retry.`); return; }
  _setMessageBody(msg, 'Saving what to read…');
  const res = await _orchReq('OBSERVE_CAPTURE', { tabId, groundId, ask, selector: picked.selector, label: picked.label || '', outputType: classifyReadAsk(ask).outputType });
  _setMessageBody(msg, (res && res.success && res.capability)
    ? `Got it — I’ll read that for “${ask}”. Ask again and I’ll fetch the value.`
    : `Couldn’t set that up${res && res.error ? ` — ${res.error}` : ''}.`);
}

// Run an observation: EXTRACT + show the value inline.
async function _orchRunObservation(msg, { groundId, tabId, capabilityId, intent, ask }) {
  _setMessageBody(msg, `Reading “${intent || 'it'}”…`);
  const res = await _orchReq('RUN_OBSERVATION', { tabId, groundId, capabilityId });
  if (!res || res.success === false) { _setMessageBody(msg, `Couldn’t read that${res && res.error ? ` — ${res.error}` : ''}.`); return; }
  if (res.ok === false) { _setMessageBody(msg, res.reason || 'Couldn’t read that on this page.'); return; }
  const v = String(res.value || '').trim();
  _setMessageBody(msg, v ? v.slice(0, 800) : '(nothing found there)');
  if (ask) _orchReq('ORCH_RECORD_ALIAS', { groundId, capabilityId, phrase: ask });   // confirm → flywheel
}

// ── ORCH-ADMIN — management commands from chat ──────────────────────────────────────────────────────────────
// "clear chat" resets the current conversation view (history is kept, non-destructive). A bulk DELETE always
// COUNTS first and shows an explicit confirm — these are hard, cascading deletes (the same ones Studio runs).
function _orchClearChat() {
  try { const m = $('messages'); if (m) m.innerHTML = ''; } catch { /* */ }
  _clearCurrentConversation();   // start fresh on the next message; the old conversation stays in history
  _lastOrch = null;
  appendMessage({ role: 'assistant', body: 'Chat cleared. (Past conversations are still in history.)' });
}

async function _orchAdminFlow(admin) {
  const tab = await _orchActiveTab();
  const msg = appendMessage({ role: 'assistant', body: 'Checking the library…' });
  const c = await _orchReq('ORCH_ADMIN', { tabId: tab && tab.id, op: 'count', kinds: admin.kinds, scope: admin.scope });
  if (!c || c.success === false) { _setMessageBody(msg, `Couldn’t read the library${c && c.error ? ` — ${c.error}` : ''}.`); return; }
  const present = Object.entries(c.counts || {}).filter(([, n]) => n > 0);
  if (!present.length) {
    _setMessageBody(msg, admin.scope === 'all'
      ? `Nothing to delete — no ${admin.kinds.join(' / ')} in any ground.`
      : `Nothing to delete here — no ${admin.kinds.join(' / ')} on this site${c.grounds ? '' : ' (this page isn’t in the library)'}.`);
    return;
  }
  const parts = present.map(([k, n]) => `${n} ${k}`).join(', ');
  const where = admin.scope === 'all' ? `across ALL ${c.grounds} ground(s)` : 'on this site';
  _setMessageBody(msg, `⚠️ This will permanently delete ${parts} ${where}. This can’t be undone.`);
  const bar = _orchActionBar(msg);
  bar.appendChild(_mkBtn(`Delete ${c.total}`, async () => {
    bar.remove(); _setMessageBody(msg, 'Deleting…');
    const d = await _orchReq('ORCH_ADMIN', { tabId: tab && tab.id, op: 'delete', kinds: admin.kinds, scope: admin.scope });
    if (d && d.success) { const dp = Object.entries(d.counts || {}).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', '); _setMessageBody(msg, `Deleted ${dp || 'nothing'}.`); _lastOrch = null; }
    else _setMessageBody(msg, `Delete failed${d && d.error ? ` — ${d.error}` : ''}.`);
  }));
  bar.appendChild(_mkBtn('Cancel', () => { bar.remove(); _setMessageBody(msg, 'Cancelled — nothing was deleted.'); }));
}

// ORCH-X — confirm a COMPOUND ask as an ordered chain, then run it. One confirmation covers the whole chain.
function _orchConfirmChain(msg, { tabId, clauses, firstMatch }) {
  const list = clauses.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
  _setMessageBody(msg, `That’s a few steps — I’ll do them in order:\n${list}`);
  const bar = _orchActionBar(msg);
  const go = document.createElement('button'); go.className = 'btn-secondary tiny'; go.type = 'button'; go.textContent = `Run all ${clauses.length}`;
  const cancel = document.createElement('button'); cancel.className = 'btn-secondary tiny'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  bar.appendChild(go); bar.appendChild(cancel);
  go.addEventListener('click', () => { bar.remove(); _orchRunChain(msg, { tabId, clauses, firstMatch }); });
  cancel.addEventListener('click', () => { bar.remove(); _setMessageBody(msg, 'Okay — cancelled.'); });
}

// Run a decomposed chain JIT: match EACH clause against the page state AT THAT POINT (so a clause on the
// post-navigation page resolves correctly), REPLAY it, settle, next. A mid-chain MISS/failure pauses and offers
// to record just that clause. The first clause reuses the match already computed to probe the Ground (no re-LLM).
async function _orchRunChain(msg, { tabId, clauses, firstMatch }) {
  const total = clauses.length;
  for (let i = 0; i < total; i++) {
    const clause = clauses[i];
    _setMessageBody(msg, `Step ${i + 1} of ${total}: “${clause.text}”…`);
    const m = (i === 0 && firstMatch) ? firstMatch : await _orchReq('ORCH_MATCH', { tabId, ask: clause.text });
    if (!m || !m.capabilityId || m.decision === 'miss') {
      _setMessageBody(msg, i > 0
        ? `Ran ${i} of ${total}. I don’t know how to “${clause.text}” on this page yet.`
        : `I don’t know how to “${clause.text}” on this page yet.`);
      _orchOfferRecord(msg, { groundId: m && m.groundId, tabId, ask: clause.text, label: '● Show me this step' });
      return;
    }
    const res = await _orchReq('REPLAY_SG_CAPABILITY', { tabId, groundId: m.groundId, capabilityId: m.capabilityId, paramValues: (m.bindings && typeof m.bindings === 'object') ? m.bindings : {} });
    if (!res || res.success === false || res.ran === false || res.ok === false) {
      const why = (res && (res.error || res.reason)) ? ` — ${res.error || res.reason}` : '';
      _setMessageBody(msg, `Step ${i + 1} (“${clause.text}”) didn’t run${why}.`);
      _orchOfferRecord(msg, { groundId: m.groundId, tabId, ask: clause.text, label: '● Show me the right way' });
      return;
    }
    _orchReq('ORCH_RECORD_ALIAS', { groundId: m.groundId, capabilityId: m.capabilityId, phrase: clause.text });   // flywheel per clause
    await new Promise((r) => setTimeout(r, 800));   // settle between steps (navigation / render)
  }
  _setMessageBody(msg, `Done — ran all ${total} steps.`);
}

// A "show me" record button (offered on a grounded MISS or after a failed run). No groundId → no-op.
function _orchOfferRecord(msg, { groundId, tabId, ask, label = '● Show me' }) {
  if (!groundId) return;
  const bar = _orchActionBar(msg);
  const rec = document.createElement('button'); rec.className = 'btn-secondary tiny'; rec.type = 'button'; rec.textContent = label;
  bar.appendChild(rec);
  rec.addEventListener('click', () => { bar.remove(); _orchRecordFlow(msg, { groundId, tabId, ask }); });
}

// Conversational fillers are never page tasks — skip the grounded matcher so "yes"/"ok" don't match a capability.
const _ORCH_FILLER = /^(y|n|yes|no|ok|okay|sure|yep|yeah|nope|nah|thanks|thank you|ty|hi|hello|hey|nvm|never ?mind|stop|cancel|wait|done)\b[\s!.?]*$/i;

// Returns true if the grounded library handled the turn (HIT); false to fall through to the legacy matcher.
async function _tryGroundedTurn(text) {
  // ORCH-FB — a corrective reply about the LAST action ("not that" / "nope" / "that's wrong" / "delete it" /
  // "wrong category, should be Vectors") wins OVER the filler guard, so a bare "nope"/"nah" after a run is a
  // rejection, not swallowed as chit-chat. Only when there's a last action to correct; the background's LLM
  // wrapper (interpretFeedback) refines the kind + extracts any wrong_value (lexical kind is the fallback).
  const _fb = classifyFeedback(text);
  if (_lastOrch && _fb.isFeedback) {
    await _orchFeedbackFlow(appendMessage({ role: 'assistant', body: '' }), { text, kind: _fb.kind });
    return true;
  }
  if (_ORCH_FILLER.test(String(text).trim())) return false;   // "yes"/"ok"/… → conversation, not a page task

  // ORCH-ADMIN — management commands ("clear chat", "delete all fragments on this ground") run BEFORE matching.
  // A bulk delete counts + confirms first. "delete that" (singular) is NOT admin → it falls to the feedback path.
  const admin = parseAdminCommand(text);
  if (admin.isAdmin) {
    if (admin.command === 'clear_chat') _orchClearChat();
    else await _orchAdminFlow(admin);
    return true;
  }

  const tab = await _orchActiveTab();
  if (!tab || typeof tab.id !== 'number') return false;

  // ORCH-X — a COMPOUND ask ("search for x AND filter by y") is DECOMPOSED and CHAINED over existing
  // capabilities, instead of being matched as one (unfindable) atomic intent. We probe the Ground with the
  // first clause (reused as step 1's match); no Ground → fall through to the legacy matcher.
  const clauses = decomposeAsk(text);
  if (clauses.length > 1) {
    const probe = appendMessage({ role: 'thinking', body: 'Checking this page…' });
    const m0 = await _orchReq('ORCH_MATCH', { tabId: tab.id, ask: clauses[0].text });
    if (!m0 || !m0.groundId) { probe.remove(); return false; }
    probe.classList.remove('thinking'); probe.classList.add('assistant');
    _orchConfirmChain(probe, { tabId: tab.id, clauses, firstMatch: m0 });
    return true;
  }

  // ORCH-X — a COMPLEX single sentence ("search SWE jobs in minneapolis posted last 7 days") spans multiple
  // capabilities with no connective for decomposeAsk to split on. Ask the LLM PLANNER to route it over the
  // recorded capabilities; if it decomposes into >1 step, confirm + chain. 0–1 steps → fall through to the
  // single matcher (so simple asks pay no extra LLM call — the looksComplex gate guards it).
  if (looksComplex(text)) {
    const probe = appendMessage({ role: 'thinking', body: 'Working out the steps…' });
    const plan = await _orchReq('ORCH_PLAN', { tabId: tab.id, ask: text });
    const pSteps = (plan && plan.success && Array.isArray(plan.steps)) ? plan.steps : [];
    const pGaps = (plan && Array.isArray(plan.gaps)) ? plan.gaps : [];
    // Take over when it's genuinely multi-step, OR when it's one step but the ask has constraints no capability
    // covers (so we surface the gap honestly instead of an over-confident "covers this" single match).
    if (pSteps.length > 1 || (pSteps.length === 1 && pGaps.length > 0)) {
      probe.classList.remove('thinking'); probe.classList.add('assistant');
      _orchConfirmPlan(probe, { tabId: tab.id, groundId: plan.groundId, steps: pSteps, gaps: pGaps });
      return true;
    }
    probe.remove();
  }

  const thinking = appendMessage({ role: 'thinking', body: 'Checking this page…' });
  const m = await _orchReq('ORCH_MATCH', { tabId: tab.id, ask: text });
  if (!m || m.success === false) { thinking.remove(); return false; }
  // No Ground for this page → the site isn't in the library; let the legacy matcher try. A grounded MISS
  // (the page IS known, just no capability for this ask) falls through to the "show me?" record offer below.
  if (m.decision === 'miss' && !m.groundId) { thinking.remove(); return false; }

  const turn = planAssistantTurn(m);
  const ctx = { groundId: m.groundId, tabId: tab.id, ask: text, intent: m.candidate && m.candidate.intent, paramValues: (m.bindings && typeof m.bindings === 'object') ? m.bindings : {}, params: m.candidate && m.candidate.params };
  thinking.classList.remove('thinking');
  thinking.classList.add('assistant');

  // OBS-READ — an OBSERVATION hit just READS the page (no side effect) → auto-run and show the value inline.
  if (m.candidate && m.candidate.kind === 'observation') {
    await _orchRunObservation(thinking, { groundId: m.groundId, tabId: tab.id, capabilityId: m.capabilityId, intent: m.candidate.intent, ask: text });
    return true;
  }

  // PRECISION-FIRST (v1): only a previously-confirmed EXACT-ALIAS match runs without asking. Every other hit
  // CONFIRMS first — a wrong match is one tap from "Not that", never a silent action on the page.
  if (turn.action === 'run' && turn.reason === 'alias-exact') {
    _setMessageBody(thinking, turn.say);
    await _orchRun(thinking, { ...ctx, capabilityId: m.capabilityId });
    return true;
  }
  if (turn.action === 'run' || turn.action === 'confirm') {
    const name = (m.candidate && m.candidate.intent) || 'that';
    _setMessageBody(thinking, (turn.action === 'confirm' && turn.irreversible) ? turn.say : `I think “${name}” covers this — want me to run it?`);
    const bar = _orchActionBar(thinking);
    const yes = document.createElement('button'); yes.className = 'btn-secondary tiny'; yes.type = 'button'; yes.textContent = turn.irreversible ? 'Yes, go ahead' : 'Run it';
    const no  = document.createElement('button'); no.className  = 'btn-secondary tiny'; no.type  = 'button'; no.textContent = 'Not that';
    bar.appendChild(yes); bar.appendChild(no);
    _lastOrch = { groundId: m.groundId, capabilityId: m.capabilityId, tabId: tab.id, ask: text, intent: (m.candidate && m.candidate.intent), bindings: ctx.paramValues, params: m.candidate && m.candidate.params };
    yes.addEventListener('click', () => { bar.remove(); _orchRun(thinking, { ...ctx, capabilityId: m.capabilityId }); });
    // "Not that" → ORCH-FB reject_match: de-alias the wrong ask + demote the capability (it stops being suggested
    // for this), then offer to teach the right thing. No more orphaned wrong matches needing a Studio delete.
    no.addEventListener('click', () => { bar.remove(); _orchFeedbackFlow(thinking, { kind: 'reject_match' }); });
    return true;
  }
  if (turn.action === 'disambiguate') {
    _setMessageBody(thinking, turn.say);
    const bar = _orchActionBar(thinking);
    for (const opt of (turn.options || [])) {
      const b = document.createElement('button'); b.className = 'btn-secondary tiny'; b.type = 'button'; b.textContent = opt.intent || opt.id;
      b.addEventListener('click', () => { bar.remove(); _orchRun(thinking, { ...ctx, capabilityId: opt.id, intent: opt.intent, paramValues: {} }); });
      bar.appendChild(b);
    }
    return true;
  }
  if (turn.action === 'record') {
    // OBS-READ — a QUESTION with no observation yet: offer to capture one by POINTING at the value, instead of
    // (or alongside) recording an action demonstration.
    if (classifyReadAsk(text).isRead) {
      _setMessageBody(thinking, 'I can read that for you — point me at it on the page.');
      const bar = _orchActionBar(thinking);
      bar.appendChild(_mkBtn('◎ Point me at it', () => { bar.remove(); _orchObserveCapture(thinking, { groundId: m.groundId, tabId: tab.id, ask: text }); }));
      bar.appendChild(_mkBtn('● Show me actions instead', () => { bar.remove(); _orchRecordFlow(thinking, { groundId: m.groundId, tabId: tab.id, ask: text }); }));
      return true;
    }
    // ORCH-X NL fallback — no saved capability, but the page is Explored: offer to work it out FRESH from the
    // page (RUN_SG_TRIAL) before falling to "show me". Precision-first: the user opts in (an unproven plan).
    _setMessageBody(thinking, `I don’t have that saved here. I can try to work it out from the page, or you can show me.`);
    const rbar = _orchActionBar(thinking);
    rbar.appendChild(_mkBtn('✨ Try it from the page', () => { rbar.remove(); _orchNlFallback(thinking, { groundId: m.groundId, tabId: tab.id, ask: text }); }));
    rbar.appendChild(_mkBtn('● Show me', () => { rbar.remove(); _orchRecordFlow(thinking, { groundId: m.groundId, tabId: tab.id, ask: text }); }));
    return true;
  }
  if (turn.action === 'navigate') { _setMessageBody(thinking, turn.say); return true; }
  thinking.remove();
  return false;
}

// ORCH-C — record a demonstration from chat (MISS → "show me"), reusing the OBS recorder handlers, then derive
// a durable capability. On success, seeds the original ask as an alias so the next ask HITS. NO LLM grounding.
async function _orchRecordFlow(msg, { groundId, tabId, ask }) {
  const start = await _orchReq('RECORD_START_SESSION', { tabId });
  if (!start || start.success === false) { _setMessageBody(msg, 'Couldn’t start recording on this page.'); return; }
  _setMessageBody(msg, 'Recording — do the task on the page, then click Stop & save.');
  // KEEP THE SERVICE WORKER ALIVE for the duration of the demo — the SAME mechanism the proven sg-trial
  // recorder uses. Without it the MV3 background idles between actions; a click that NAVIGATES then loses its
  // in-flight INTERACTION_RECORD when Chrome has to wake the SW (the unloading page drops it). That is exactly
  // why the chat record "invariably skipped" the navigating category step while the polled recorder never did.
  // Cap the keepalive so an ABANDONED demo (panel closed / navigated away without Stop) can't pin the worker
  // awake forever — auto-stops after ~10 min of pings.
  let _kaTicks = 0;
  const _keepAlive = setInterval(() => {
    if (++_kaTicks > 400) { clearInterval(_keepAlive); return; }
    try { chrome.runtime.sendMessage({ type: 'GET_RECORDING' }, () => void chrome.runtime.lastError); } catch { /* */ }
  }, 1500);
  const bar = _orchActionBar(msg);
  const stop = document.createElement('button'); stop.className = 'btn-secondary tiny'; stop.type = 'button'; stop.textContent = '■ Stop & save';
  bar.appendChild(stop);
  stop.addEventListener('click', async () => {
    clearInterval(_keepAlive);
    stop.disabled = true; bar.remove();
    _setMessageBody(msg, 'Saving what you showed me…');
    const stopped = await _orchReq('RECORD_STOP_SESSION', { tabId });
    const trace = (stopped && Array.isArray(stopped.trace)) ? stopped.trace : null;
    if (!trace || !trace.length) { _setMessageBody(msg, 'I didn’t capture any actions — try again.'); return; }
    const res = await _orchReq('DERIVE_OBSERVED_CAPABILITY', { groundId, trace });
    if (res && res.success && res.capability) {
      _setMessageBody(msg, `Got it — I learned “${res.capability.intent}”. Ask me again and I’ll do it.`);
      _orchReq('ORCH_RECORD_ALIAS', { groundId, capabilityId: res.capability.id, phrase: ask });   // so the next ask hits
    } else {
      _setMessageBody(msg, `I couldn’t turn that into a capability${res && res.error ? ` — ${res.error}` : ''}.`);
    }
  });
}

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

  // ORCH-C — grounded pre-check: does the demonstrated, page-grounded library already cover this? On a HIT we
  // run/confirm/disambiguate here; on a MISS or any error we fall through to the legacy ChatAPI.match below.
  try {
    if (await _tryGroundedTurn(text)) { $('btn-chat-send').disabled = false; return; }
  } catch (e) { try { console.warn('[chat] grounded pre-check fell through:', e?.message); } catch { /* */ } }

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

