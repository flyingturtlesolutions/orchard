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
import { decomposeAsk, isCompoundAsk, looksComplex, isForeachAsk, namesMultipleSites, namesAnySite } from './Core/orchChain.js';   // ORCH-X — decompose / complexity gate + foreach routing; namesMultipleSites/namesAnySite — cross-site pre-filters (T3X)
import { walkPlan } from './Core/orchRun.js';   // ORCH-L — the pure control-flow interpreter (foreach / loop / gate)
import { isConditionalAsk, evaluatePredicate } from './Core/orchAnalyze.js';   // ORCH-A — predicate → gate (conditional routing + the analysis)
import { comprehend } from './Core/orchComprehend.js';   // ORCH-CB — substrate-free shape comprehension (cold-ground decompose)
import { renderCriteria } from './Core/orchVisual.js';   // ORCH-CB — search params → criteria for a visual condition's prompt
import { classifyFeedback } from './Core/orchFeedback.js'; // ORCH-FB — recognize corrective feedback (LLM refines)
import { parseAdminCommand, parseDedupCommand } from './Core/orchAdmin.js';    // ORCH-ADMIN — management commands (clear/delete); dedup — find duplicate Grounds
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

// v2.74.818 — write a decision line (e.g. the ROUTE a turn took + its cues) into the background's PERSISTED ring
// buffer, so a chat-side routing decision shows in the downloaded trace (the sidepanel's own console isn't logged).
const _orchLog = (line) => { try { _orchReq('ORCH_LOG', { line: String(line) }); } catch { /* never let a log break a turn */ } };

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

// A 👍 / 👎 / remove bar shown after a run completes, so the action is reinforceable OR correctable IN CHAT (no
// Studio). 👍 (affirm) is symmetric to 👎: it confirms the ask→capability alias and emits a POSITIVE outcome that
// feedbackLearn turns into a relevance boost for similar future asks — the flywheel, made explicit.
function _orchFeedbackBar(msg) {
  const bar = _orchActionBar(msg);
  bar.appendChild(_mkBtn('👍 Right', () => { _orchFeedbackFlow(appendMessage({ role: 'assistant', body: '' }), { kind: 'affirm' }); }));
  bar.appendChild(_mkBtn('👎 Wrong', () => { _orchFeedbackFlow(appendMessage({ role: 'assistant', body: '' }), { kind: 'reject_run' }); }));
  bar.appendChild(_mkBtn('🗑 Remove', () => { _orchFeedbackFlow(appendMessage({ role: 'assistant', body: '' }), { kind: 'retract' }); }));
}

// ── ORCH-X — semantic plan over capabilities ────────────────────────────────────────────────────────────────
// A complex single sentence ("search SWE jobs in minneapolis posted last 7 days") is decomposed by the LLM into
// ORDERED capability-routed steps WITH bindings (ORCH_PLAN), then confirmed + run. Unlike the lexical chain, the
// steps are already resolved (capabilityId + bindings) — no per-step re-match.
function _orchConfirmPlan(msg, { tabId, groundId, steps, gaps = [], ask = '', savedComposite = false }) {
  const fmt = (b) => Object.keys(b || {}).length ? ` (${Object.entries(b).map(([k, v]) => `${k}=${v}`).join(', ')})` : '';
  const label = (b) => b.kind === 'wait' ? `let it settle (${Math.round((b.ms || 0) / 100) / 10}s)` : (b.intent || b.clause || b.kind);
  const byId = new Map((steps || []).map((s) => [s && s.id, s]));
  // A gate's CONDITION machinery (the observe it tests + the analyze that judges it) is shown INLINE on the gate
  // line, not as its own numbered steps — so a conditional reads as one "if … : …" rather than three.
  const consumed = new Set();
  for (const s of (steps || [])) { if (s && s.kind === 'gate') { const an = byId.get(s.over); if (an) { consumed.add(an.id); if (an.over) consumed.add(an.over); } } }
  let n = 0;
  const lines = [];
  for (const s of (steps || [])) {
    if (!s || consumed.has(s.id)) continue;
    n++;
    if (s.kind === 'foreach' || s.kind === 'loop') {
      lines.push(`${n}. for each item: ${(s.body || []).map(label).filter(Boolean).join(' → ')}${s.collect ? ` (collect ${s.collect})` : ''}`);
    } else if (s.kind === 'gate') {
      const an = byId.get(s.over);
      const cond = (an && (an.intent || an.clause)) || 'it applies';
      lines.push(`${n}. if ${cond}: ${(s.body || []).map((b) => b.intent || b.clause).filter(Boolean).join(' → ')}`);
    } else {
      lines.push(`${n}. ${s.intent || s.clause || s.kind || 'step'}${fmt(s.bindings)}`);
    }
  }
  const list = lines.join('\n');
  const shown = n;   // the number of USER-VISIBLE steps (gate machinery folded in)
  const head = steps.length ? `${savedComposite ? 'Saved as one — ' : ''}I’ll do ${shown} step${shown > 1 ? 's' : ''} in order:\n${list}` : 'I don’t have a saved capability for this yet — I can try to work it out from the page.';
  // HONEST partial coverage — name the constraints no capability covers; we'll TRY them via the NL fallback after.
  const gapNote = gaps.length ? `\n\n⚠ Not saved yet: ${gaps.join(', ')} — I’ll try ${gaps.length > 1 ? 'these' : 'this'} from the page after.` : '';
  _setMessageBody(msg, head + gapNote);
  const bar = _orchActionBar(msg);
  if (steps.length) bar.appendChild(_mkBtn(shown > 1 ? `Run all ${shown}` : 'Run it', () => { bar.remove(); _orchRunPlan(msg, { tabId, groundId, steps, gaps, ask, savedComposite }); }));
  else if (gaps.length) bar.appendChild(_mkBtn('✨ Try to work it out', () => { bar.remove(); _orchTryGaps(msg, { tabId, groundId, gaps }); }));
  bar.appendChild(_mkBtn('Cancel', () => { bar.remove(); _setMessageBody(msg, 'Okay — cancelled.'); }));
}

// Run a READ step the SAME way the single-ask path does — REUSE the stable observation read backends, don't
// reimplement: the manual Studio observation (RUN_BEST_OBSERVATION) first, then the captured one
// (RUN_OBSERVATION). Returns the value string, or null when nothing read.
async function _orchReadValue({ tabId, groundId, ask, capabilityId }) {
  if (ask) {
    const mo = await _orchReq('RUN_BEST_OBSERVATION', { tabId, ask });
    if (mo && mo.matched && mo.ok && String(mo.value || '').trim()) return String(mo.value).trim();
  }
  if (capabilityId) {
    const r = await _orchReq('RUN_OBSERVATION', { tabId, groundId, capabilityId });
    if (r && r.success !== false && r.ok !== false && String(r.value || '').trim()) return String(r.value).trim();
  }
  return null;
}

// ORCH-L — run a plan IR with CONTROL-FLOW nodes (foreach/loop/gate) via the pure interpreter (walkPlan). The
// executor is thin glue over the EXISTING handlers — no new runtime: a fragment → REPLAY_SG_CAPABILITY; a
// foreach/loop DRIVER observe → RUN_OBSERVATION_LIST (count the list's items); a leaf read → RUN_OBSERVATION with
// a positional `fromIndex` for the Nth item. Collected outputs (the per-iteration lists) are shown inline.
async function _orchRunPlanIR(msg, { tabId, groundId, plan }) {
  const driverIds = new Set();   // observe ids a foreach/loop iterates over → must return items, not a scalar
  const _scan = (steps) => { for (const s of (steps || [])) { if (s && (s.kind === 'foreach' || s.kind === 'loop') && s.over) driverIds.add(s.over); if (s && Array.isArray(s.body)) _scan(s.body); } };
  _scan(plan && plan.steps);
  // ORCH-CB — the plan's search PARAMS (upstream fragment bindings) become the CRITERIA a VISUAL condition uses to
  // judge MATCH ("are there jobs matching 'osidndhdnd'?"), not mere presence. Ignored by DOM reads.
  const _planBindings = {};
  const _collectBindings = (steps) => { for (const s of (steps || [])) { if (!s) continue; if (s.kind === 'fragment' && s.bindings && typeof s.bindings === 'object') Object.assign(_planBindings, s.bindings); if (Array.isArray(s.body)) _collectBindings(s.body); } };
  _collectBindings(plan && plan.steps);
  const _criteria = renderCriteria(_planBindings);
  const exec = {
    fragment: async (step, scope) => {
      // clickItem — the per-item ACTION of a click-in-place foreach: CLICK the current item's selector. The SETTLE
      // is a separate `wait` node (lifted right after this), so the panel/inline content loads before the body's
      // read — pacing is a first-class node, not a sleep buried in the click. (A normal fragment REPLAYs its cap.)
      if (step.clickItem) {
        const sel = scope && scope.item && scope.item.selector;
        if (!sel) return { ok: false, error: 'no per-item selector to click (re-capture the list by pointing at one item)' };
        const res = await _orchReq('CLICK_SELECTOR', { tabId, selector: sel });
        return { ok: !!(res && res.success !== false && res.ok !== false), error: res && res.error };
      }
      // A normal fragment passes its OWN bindings (string values) — never the raw scope item object.
      const res = await _orchReq('REPLAY_SG_CAPABILITY', { tabId, groundId, capabilityId: step.capabilityId, paramValues: (step.bindings && typeof step.bindings === 'object') ? step.bindings : {} });
      return { ok: !!(res && res.success !== false && res.ran !== false && res.ok !== false), error: res && (res.error || res.reason) };
    },
    observe: async (step, scope) => {
      if (driverIds.has(step.id)) {
        const res = await _orchReq('RUN_OBSERVATION_LIST', { tabId, groundId, capabilityId: step.capabilityId });
        return { ok: !!(res && res.success !== false), items: (res && res.items) || [], value: (res && res.count) || 0, error: res && res.error };
      }
      // Three read modes: POSITIONAL → the Nth list item (read-collection, archetype + index=iteration). FIXED →
      // re-read the observation's single selector (click-in-place: the per-item click updated a panel IN PLACE, so
      // the value is at a fixed location, NOT the frozen archetype index). Plain → the captured read as-is.
      const override = (step.positional && Number.isInteger(scope.index)) ? { fromIndex: scope.index }
        : (step.fixed ? { fixed: true } : {});
      const res = await _orchReq('RUN_OBSERVATION', { tabId, groundId, capabilityId: step.capabilityId, ...override, ...(_criteria ? { criteria: _criteria } : {}) });
      const ok = !!(res && res.success !== false && res.ok !== false);
      // FAIL-SAFE gate condition: an `optional` read (a gate's condition) that can't read anything means "nothing
      // found" — return an EMPTY result (count 0) so the predicate is false and the gate stays CLOSED, rather than
      // aborting the plan. (A condition you can't observe is NOT a met condition — e.g. a zero-results search.)
      if (!ok && step.optional) return { ok: true, value: '', items: [], count: 0, empty: true };
      // Carry items + an explicit count (a list/count/VISUAL condition observation) so a downstream predicate
      // analysis tests the real set — a VISUAL read returns the model's count, which must win over items.length
      // (its single "0" item means zero results, not one).
      return { ok, value: ok ? String(res.value || '').trim() : null, items: (res && Array.isArray(res.items)) ? res.items : undefined, count: (res && Number.isInteger(res.count)) ? res.count : undefined, error: res && (res.reason || res.error) };
    },
    // PREDICATE analysis (ORCH-A) — evaluate the condition over the upstream observation's result. Deterministic
    // (the §6 connection: a predicate output drives a gate). `over` = the produced observe result.
    analyze: async (step, over) => {
      const input = { value: over && over.value, items: over && over.items, count: (over && Number.isInteger(over.count)) ? over.count : ((over && Array.isArray(over.items)) ? over.items.length : undefined) };
      const value = step.predicate ? evaluatePredicate(step.predicate, input) : !!(over && over.value);
      return { ok: true, value };
    },
    // A SETTLE node — let the live page quiesce after a click before the read fires (the detail pane / inline
    // content loads async). A fixed floor from the node's `ms`. (`forSelector` is reserved for an adaptive
    // poll-until-present; it needs a content-script round-trip the chat path doesn't have yet, so the floor stands.)
    wait: async (step) => {
      const ms = Number.isFinite(step.ms) ? Math.max(0, step.ms) : 800;
      await new Promise((r) => setTimeout(r, ms));
      return { ok: true };
    },
  };
  _setMessageBody(msg, 'Running…');
  const env = await walkPlan(plan, exec);
  const outs = (env && env.outputs) ? Object.entries(env.outputs) : [];
  const gate = (env && Array.isArray(env.trace)) ? env.trace.find((t) => t.kind === 'gate') : null;
  if (outs.length) {
    _setMessageBody(msg, outs.map(([k, v]) => Array.isArray(v) ? `${k} (${v.length}):\n${v.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}` : `${k}: ${v}`).join('\n\n'));
  } else if (gate) {
    // PREDICATE → GATE: report the analysis decision — did the conditional action run, or was it skipped?
    _setMessageBody(msg, !(env && env.ok) ? `Couldn’t complete that${env && env.error ? ` — ${env.error}` : ''}.`
      : gate.pass ? 'The condition held — I ran it.' : 'The condition didn’t hold — I left it alone.');
  } else {
    _setMessageBody(msg, (env && env.ok) ? 'Done.' : `Couldn’t complete that${env && env.error ? ` — ${env.error}` : ''}.`);
  }
  // T2 — a control-flow run (a collection foreach OR a conditional gate) can be PROMOTED to a durable composite.
  // Offer the save on the same message. (Skipped on a replay of an already-saved composite — plan.savedComposite.)
  const hasCF = (plan && Array.isArray(plan.steps)) && plan.steps.some((s) => s && (s.kind === 'foreach' || s.kind === 'loop' || s.kind === 'gate'));
  if (env && env.ok && (outs.length || hasCF) && !(plan && plan.savedComposite)) {
    _orchOfferSaveCompound(msg, { tabId, groundId, ask: (plan && plan.goal) || '', steps: plan && plan.steps, plan });
  }
  return env;
}

async function _orchRunPlan(msg, { tabId, groundId, steps, gaps = [], ask = '', savedComposite = false }) {
  // ORCH-L — a plan carrying control-flow nodes runs through the interpreter, not the flat sequence runner.
  if (Array.isArray(steps) && steps.some((s) => s && (s.kind === 'foreach' || s.kind === 'loop' || s.kind === 'gate'))) {
    return _orchRunPlanIR(msg, { tabId, groundId, plan: { goal: ask, steps, savedComposite } });
  }
  const total = steps.length;
  const readouts = [];
  for (let i = 0; i < total; i++) {
    const s = steps[i];
    _setMessageBody(msg, `Step ${i + 1} of ${total}: “${s.intent}”…`);
    // A READ step (observation) returns a VALUE — run it through the observation read path, not REPLAY (an
    // observation has no strategy, so REPLAY errors "no saved strategy or binding").
    if (s.kind === 'observation') {
      const val = await _orchReadValue({ tabId, groundId, ask: s.clause || s.intent, capabilityId: s.capabilityId });
      if (val == null) { _setMessageBody(msg, `Step ${i + 1} (“${s.intent}”) couldn’t read a value here.`); _orchOfferRecord(msg, { groundId, tabId, ask: s.clause || s.intent, label: '● Show me this step' }); return; }
      readouts.push(val);
      _orchReq('ORCH_RECORD_ALIAS', { groundId, capabilityId: s.capabilityId, phrase: s.clause || s.intent });
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
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
    _setMessageBody(msg, `${readouts.length ? readouts.join('\n') + '\n\n' : ''}${total ? `Ran ${total} step${total > 1 ? 's' : ''}. ` : ''}I haven’t saved: ${gaps.join(', ')} — try to work ${gaps.length > 1 ? 'them' : 'it'} out from the page?`);
    const bar = _orchActionBar(msg);
    bar.appendChild(_mkBtn(`✨ Try ${gaps.length > 1 ? 'them' : 'it'}`, () => { bar.remove(); _orchTryGaps(appendMessage({ role: 'assistant', body: '' }), { tabId, groundId, gaps }); }));
    bar.appendChild(_mkBtn('● Show me instead', () => { bar.remove(); _orchRecordFlow(appendMessage({ role: 'assistant', body: '' }), { groundId, tabId, ask: gaps[0] }); }));
    return;
  }
  _setMessageBody(msg, readouts.length ? readouts.join('\n') : `Done — ran all ${total} steps.`);
  // T2 — a fresh compound that ran cleanly (no gaps) can be PROMOTED to a durable composite (cache hit next time).
  if (!savedComposite && !gaps.length) _orchOfferSaveCompound(msg, { tabId, groundId, ask, steps });
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

async function _orchNlFallback(msg, { tabId, groundId, ask, onAuthored = null }) {
  _setMessageBody(msg, `Working out “${ask}” from the page…`);
  const res = await _orchReq('RUN_SG_TRIAL', { tabId, groundId, intent: ask, tier2: true });
  if (!res || res.success === false) {
    _setMessageBody(msg, `I couldn’t work out “${ask}”${res && res.error ? ` — ${res.error}` : ''}.`);
    _orchOfferRecord(msg, { groundId, tabId, ask, label: '● Show me the right way', onAuthored });
    return false;
  }
  const passed = !!(res.tier2Score && res.tier2Score.verdict === 'tier2-pass' && res.acceptEligible);
  if (!passed) {
    _setMessageBody(msg, `I tried, but couldn’t confirm “${ask}” worked here — want to show me?`);
    _orchOfferRecord(msg, { groundId, tabId, ask, label: '● Show me the right way', onAuthored });
    return false;
  }
  // Verified pass → PROMOTE to a durable capability (cache fill) + seed the alias so the next ask is instant.
  let saved = '';
  let capId = null;
  try {
    const acc = await _orchReq('ACCEPT_SG_TRIAL', { groundId, tabId });
    capId = acc && acc.success && acc.accepted && ((acc.capability && acc.capability.id) || acc.capabilityId);
    if (capId) { _orchReq('ORCH_RECORD_ALIAS', { groundId, capabilityId: capId, phrase: ask }); saved = ' — saved for next time'; }
  } catch { /* */ }
  _setMessageBody(msg, `Done — worked out “${ask}” from the page${saved}.`);
  // A caller (e.g. the cross-Ground gap→teach flow) folds back here once a Strategy is authored on this Ground.
  if (typeof onAuthored === 'function' && capId) { try { onAuthored({ capabilityId: capId, groundId, ask, via: 'trial' }); } catch { /* */ } }
  return true;
}

// ── OBS-READ — observations (the KNOW half) ─────────────────────────────────────────────────────────────────
// A question ("how many results?") is answered by READING the page, not acting on it. You author an observation
// by POINTING at the value (the picker); running it EXTRACTs + returns the value inline. A read has no side
// effect, so it auto-runs without a confirm gate.

// Heal a stale-tab content-script port (the tab's been open since an extension reload) by PING-then-reinject,
// so START_PICK / EXTRACT actually reach the page instead of being silently dropped (the picker not appearing).
async function _orchEnsureCS(tabId) {
  if (typeof tabId !== 'number') return false;
  const ping = () => new Promise((r) => { try { chrome.tabs.sendMessage(tabId, { type: 'PING' }, (p) => { void chrome.runtime.lastError; r(!!(p && (p.ready || p.success))); }); } catch { r(false); } });
  if (await ping()) return true;
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['ContentScripts/contentScript.js'] }); } catch { /* */ }
  for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 250)); if (await ping()) return true; }
  return false;
}

// Activate the element picker and resolve with the user's PICK_RESULT (or null on cancel/timeout).
function _orchPickOnce({ tabId }) {
  return new Promise((resolve) => {
    const sessionId = `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); chrome.runtime.onMessage.removeListener(onMsg); resolve(v); };
    const onMsg = (m) => { if (m && m.type === 'PICK_RESULT' && m.sessionId === sessionId) finish(m); };
    const timer = setTimeout(() => finish(null), 120000);
    // PICK_RESULT arrives back over runtime.onMessage (a content script can only runtime.sendMessage to the
    // extension); START_PICK must be delivered TO the content script (tabs.sendMessage) — and the script must be
    // ALIVE (re-injected if the tab is stale), or the message is dropped and the picker silently never appears.
    chrome.runtime.onMessage.addListener(onMsg);
    _orchEnsureCS(tabId).then(() => {
      // Use the EXACT pick payload Studio's observation-author sends (Sidepanel/modes/ObservationAuthor/picker.js
      // startPick). The missing `labelMode:'single'` was the whole bug: without it the picker WALKS UP to the card
      // CONTAINER and synthesizes a brittle `div.cardOutline…` selector, instead of staying on the exact element
      // clicked and producing the stable `[aria-label=…]` selector Studio gets. Same click, different element.
      try { chrome.tabs.sendMessage(tabId, { type: 'START_PICK', payload: { sessionId, mode: 'target', containerSelector: '', multiCandidate: false, labelMode: 'single' } }, () => void chrome.runtime.lastError); }
      catch { finish(null); }
    });
  });
}

// Capture an observation: point at the value → persist it for this read-ask.
async function _orchObserveCapture(msg, { groundId, tabId, ask, onAuthored = null }) {
  // For a LIST read ("the title of each…"), the pick must be ONE ITEM (so its archetype matches every item) — NOT
  // the surrounding container. Guide the user accordingly; otherwise the capture reads the whole list as one blob.
  const _isList = classifyReadAsk(ask).outputType === 'list';
  // v2.74.834 — echo WHAT to point at (strip the read verb) so a re-teach for "read the company" says "point at the
  // COMPANY" — not a generic "point at the value" that led to picking the wrong element (the title). Falls back to the
  // generic prompt for count/predicate questions where a single noun label doesn't fit.
  const _what = String(ask || '').trim().replace(/^\s*(please\s+|can you\s+|could you\s+)?(read|get|grab|fetch|note|jot|record|copy|show(?:\s+me)?|display|extract|see|view|tell\s+me|give\s+me)\s+/i, '').replace(/[?.!]+$/, '').trim();
  const _ptLabel = (_what && !/^(how|what|which|is|are|does|do|can|could|will|when|where|why)\b/i.test(_what))
    ? (/^(the|its|their|a|an|this|that)\b/i.test(_what) ? _what : `the ${_what}`)
    : 'the value to read';
  _setMessageBody(msg, _isList ? `◎ Point at ONE of ${_ptLabel} (e.g. the FIRST) — I’ll read them all.` : `◎ Point at ${_ptLabel} on the page…`);
  const picked = await _orchPickOnce({ tabId });
  if (!picked || !picked.selector || picked.error) { _setMessageBody(msg, `Didn’t catch that${picked && picked.error ? ` (${picked.error})` : ''} — ask again to retry.`); return; }
  // A LIST read needs a per-ITEM pick. If the click landed on a list CONTAINER (ul/ol/table…), reading it gives
  // the whole list as one blob (and the archetype matches sibling containers, not items) — re-prompt for a single
  // item rather than capture a coarse observation.
  if (_isList && new Set(['ul', 'ol', 'table', 'tbody', 'thead', 'dl', 'select', 'nav', 'main']).has(String(picked.tagName || '').toLowerCase())) {
    _setMessageBody(msg, 'That landed on the whole list — point at just ONE item (e.g. the first job’s TITLE link) and I’ll read them all.');
    const bar = _orchActionBar(msg);
    bar.appendChild(_mkBtn('◎ Try again', () => { bar.remove(); _orchObserveCapture(msg, { groundId, tabId, ask, onAuthored }); }));
    return;
  }
  _setMessageBody(msg, 'Saving what to read…');
  const lmk = (picked.landmark && typeof picked.landmark === 'object') ? picked.landmark : null;
  // Positional/archetype selector for list-item reads ("the first/Nth …"), when present.
  const archetype = (picked.archetype && typeof picked.archetype === 'object') ? picked.archetype : null;
  // Send BOTH the synthesized selector (often a stable [aria-label=…], the one Studio keeps) AND the positional
  // structural class-chain. OBSERVE_CAPTURE VERIFIES each on the live page at capture and STORES whichever
  // actually re-reads — so we never persist a selector that can't reproduce the value the picker just held
  // (Indeed mutates the structural classes, so that one fails even on an immediate re-read; the aria-label one
  // survives). This replaces the old "always prefer structural" choice that stored the brittle one.
  const res = await _orchReq('OBSERVE_CAPTURE', { tabId, groundId, ask, selector: picked.selector || picked.structuralSelector, structuralSelector: picked.structuralSelector || null, label: picked.label || '', role: (lmk && lmk.role) || '', landmark: lmk, archetype, tagName: picked.tagName || '', outputType: classifyReadAsk(ask).outputType });
  // VERIFY-AT-CAPTURE — surface the value the picker SAW right now (the same re-read the next ask will do). If the
  // stored selector reproduces it → show it immediately. If not → say so plainly instead of silently deferring a
  // read that will return nothing (this is the "the text should be visible somewhere" instinct, made real).
  if (res && res.success && res.capability) {
    // T3X-DF — surface the inferred ANTECEDENT (the search the user just ran here, now this read's prerequisite). So
    // when this read is reused on ANOTHER Ground (a cross-Ground workflow), the user knows it'll re-run that step first.
    const ante = (res.capability && res.capability.antecedent) || null;
    const anteNote = ante ? ` (When I use this read on another site, I’ll re-run your last step here first${ante.label ? ` — “${String(ante.label).slice(0, 60)}”` : ''}.)` : '';
    if (res.verifiedValue) _setMessageBody(msg, `Got it — I read “${String(res.verifiedValue).slice(0, 300)}”. Ask again and I’ll fetch it live.${anteNote}`);
    else _setMessageBody(msg, `Saved — but when I re-read it just now I got nothing back. The picker saw ${res.sawText ? `“${String(res.sawText).slice(0, 120)}”` : 'a value'}, but the stored selector can’t reproduce it on this page (details in the log). Point me at it again, or use a Studio observation for a stable selector.${anteNote}`);
    // v2.74.830 — fold back to the cross-Ground gap→teach loop (advance + re-check) once the observation is saved,
    // the same way the action trial/record paths do via onAuthored.
    if (typeof onAuthored === 'function') { try { onAuthored({ capabilityId: res.capability.id, groundId, ask, via: 'observe', value: res.verifiedValue }); } catch { /* */ } }
  } else {
    _setMessageBody(msg, `Couldn’t set that up${res && res.error ? ` — ${res.error}` : ''}.`);
  }
}

// ORCH-CB — capture a VISUAL observation: screenshot the page + a vision description, so a SEMANTIC read (one a
// selector can't answer — "are there ACTUAL results, or just suggestions / a 'no matches' banner?") is grounded in
// what Claude SEES. Reused as a gate CONDITION: ground "are there any jobs" visually once, and the gate reads it
// correctly even when decoys share the archetype. (A DOM read stays the default for precise per-item values.)
async function _orchVisualCapture(msg, { groundId, tabId, ask }) {
  _setMessageBody(msg, '📷 Looking at the page…');
  const outputType = classifyReadAsk(ask).outputType === 'list' ? 'list' : 'count';
  const res = await _orchReq('CAPTURE_VISUAL_OBSERVATION', { tabId, groundId, ask, outputType });
  if (!res || res.success === false || !res.capability) { _setMessageBody(msg, `Couldn’t set up a visual read${res && res.error ? ` — ${res.error}` : ''}.`); return; }
  const v = res.verify;
  _setMessageBody(msg, `Saved a visual read — I’ll look at the page to answer this.${v ? ` (Right now I see ${v.count}.)` : ''}`);
  _orchFeedbackBar(msg);
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
  // ORCH-FB — a read is correctable/affirmable IN CHAT too: 👍 reinforces "this is the right value to read",
  // 👎/🗑 demote or retract a wrong read. Setting _lastOrch also lets a typed "yes/that's wrong" land on it.
  _lastOrch = { groundId, capabilityId, tabId, ask, intent, bindings: {}, params: null };
  _orchFeedbackBar(msg);
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

// DEDUP — detect Grounds that are the SAME site (subdomain variants, or a brand under two TLDs like
// notion.com + notion.so), list them with where capabilities live, and offer a per-cluster confirmed Merge
// (MERGE_GROUNDS → move capabilities + artifacts onto one Ground, drop the empty sibling; nothing is lost).
async function _orchDedupFlow() {
  const msg = appendMessage({ role: 'assistant', body: 'Scanning your Grounds for duplicates…' });
  const r = await _orchReq('DETECT_DUPLICATE_GROUNDS', {});
  if (!r || r.success === false) { _setMessageBody(msg, `Couldn’t scan Grounds${r && r.error ? ` — ${r.error}` : ''}.`); return; }
  const clusters = Array.isArray(r.clusters) ? r.clusters : [];
  if (!clusters.length) {
    _setMessageBody(msg, `No duplicates — your ${r.groundCount || 0} Ground${r.groundCount === 1 ? '' : 's'} are all distinct sites.`);
    return;
  }
  const lines = clusters.map((c, i) => {
    const tag = c.confidence === 'host' ? 'same site' : 'same brand — confirm';
    const gs = c.grounds.map((g) => `${g.host || g.name}${g.capabilityCount ? ` · ${g.capabilityCount} cap${g.capabilityCount === 1 ? '' : 's'}` : ' · empty'}`).join('  +  ');
    return `${i + 1}. “${c.key}” (${tag})\n   ${gs}`;
  });
  _setMessageBody(msg, `Found ${clusters.length} duplicate cluster${clusters.length === 1 ? '' : 's'} across ${r.groundCount} Ground${r.groundCount === 1 ? '' : 's'}:\n\n${lines.join('\n')}\n\nMerge consolidates a cluster onto one Ground — moves the capabilities, drops the empty sibling. Nothing is lost.`);
  const bar = _orchActionBar(msg);
  clusters.forEach((c) => {
    bar.appendChild(_mkBtn(`Merge “${c.key}”`, async () => {
      const m2 = appendMessage({ role: 'assistant', body: `Merging “${c.key}” onto one Ground…` });
      const res = await _orchReq('MERGE_GROUNDS', { groundIds: c.grounds.map((g) => g.id) });
      if (res && res.success) {
        _setMessageBody(m2, `✓ Merged “${c.key}” → ${res.canonicalHost || 'one Ground'}: moved ${res.movedCapabilities} capabilit${res.movedCapabilities === 1 ? 'y' : 'ies'}, removed ${res.absorbed} duplicate Ground${res.absorbed === 1 ? '' : 's'}.`);
      } else {
        _setMessageBody(m2, `Couldn’t merge “${c.key}”${res && res.error ? ` — ${res.error}` : ''}.`);
      }
    }));
  });
  bar.appendChild(_mkBtn('Not now', () => { bar.remove(); }));
}

// LIST (v2.74.819) — the READ complement to delete: show what's in the library — Grounds (host + cap count),
// capabilities (intent + kind, this site or everywhere), or saved cross-Ground workflows.
async function _orchListFlow(admin) {
  const tab = await _orchActiveTab();
  const msg = appendMessage({ role: 'assistant', body: 'Reading your library…' });
  const r = await _orchReq('ORCH_LIST', { target: admin.target, scope: admin.scope, tabId: tab && tab.id });
  if (!r || r.success === false) { _setMessageBody(msg, `Couldn’t read the library${r && r.error ? ` — ${r.error}` : ''}.`); return; }
  const items = Array.isArray(r.items) ? r.items : [];
  if (admin.target === 'grounds') {
    if (!items.length) { _setMessageBody(msg, 'No Grounds yet — explore a site to create one.'); return; }
    const lines = items.map((g, i) => `${i + 1}. ${g.host || g.name} — ${g.capabilityCount} cap${g.capabilityCount === 1 ? '' : 's'}`);
    _setMessageBody(msg, `${items.length} Ground${items.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
    return;
  }
  if (admin.target === 'workflows') {
    if (!items.length) { _setMessageBody(msg, 'No saved workflows yet.'); return; }
    const lines = items.map((w, i) => `${i + 1}. ${w.name} — ${w.steps} step${w.steps === 1 ? '' : 's'}${w.grounds > 1 ? `, ${w.grounds} sites` : ''}`);
    _setMessageBody(msg, `${items.length} saved workflow${items.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
    return;
  }
  // capabilities — grouped by host
  if (!items.length) {
    _setMessageBody(msg, admin.scope === 'all' ? 'No capabilities anywhere yet — teach one by demonstrating it.' : 'No capabilities on this site yet — teach one, or try “list capabilities everywhere”.');
    return;
  }
  // v2.74.820 — a header + a row per capability with an Enable/Disable toggle (the matcher excludes a disabled one).
  _setMessageBody(msg, `${items.length} capabilit${items.length === 1 ? 'y' : 'ies'}${admin.scope === 'all' ? ' across all sites' : ' here'}:`);
  const content = msg.querySelector('.message-content');
  const bar = _orchActionBar(msg);
  const _fmt = (c) => `${c.intent} · ${c.kind}${c.host && admin.scope === 'all' ? ` · ${c.host}` : ''}${c.disabled ? '  (disabled)' : ''}`;
  for (const c of items) {
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px;';
    const label = document.createElement('span');
    const restyle = () => { label.style.cssText = 'flex:1;' + (c.disabled ? 'opacity:0.5;text-decoration:line-through;' : ''); label.textContent = _fmt(c); };
    restyle();
    const btn = _mkBtn(c.disabled ? 'Enable' : 'Disable', async () => {
      btn.disabled = true;
      const r = await _orchReq('SET_CAPABILITY_ACTIVE', { groundId: c.groundId, capabilityId: c.id, active: !!c.disabled });
      if (r && r.success) { c.disabled = r.disabled; restyle(); btn.textContent = c.disabled ? 'Enable' : 'Disable'; }
      btn.disabled = false;
    });
    row.appendChild(label); row.appendChild(btn); content.insertBefore(row, bar);
  }
  bar.appendChild(_mkBtn('Done', () => { bar.remove(); }));
}

// RENAME (v2.74.819) — name the active-tab Ground. The name comes from the command ("…to X") or a prompt.
async function _orchRenameFlow(admin) {
  const tab = await _orchActiveTab();
  const msg = appendMessage({ role: 'assistant', body: '' });
  const doRename = async (name) => {
    _setMessageBody(msg, 'Renaming…');
    const r = await _orchReq('RENAME_GROUND', { name, tabId: tab && tab.id });
    _setMessageBody(msg, (r && r.success) ? `✓ Renamed this Ground to “${r.name}”.` : `Couldn’t rename${r && r.error ? ` — ${r.error}` : ''}.`);
  };
  if (admin.name) { await doRename(admin.name); return; }
  _setMessageBody(msg, 'What should I name this Ground?');
  const bar = _orchActionBar(msg);
  const content = msg.querySelector('.message-content');
  const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'e.g. Work Notion'; inp.style.cssText = 'flex:1;font-size:12px;padding:2px 6px;';
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:6px;margin:4px 0;'; row.appendChild(inp); content.insertBefore(row, bar);
  bar.appendChild(_mkBtn('Rename', async () => { const v = inp.value.trim(); if (!v) return; bar.remove(); row.remove(); await doRename(v); }));
  bar.appendChild(_mkBtn('Cancel', () => { bar.remove(); row.remove(); _setMessageBody(msg, 'Okay — not renamed.'); }));
}

// PRUNE (v2.74.819) — remove orphaned capabilities (dead — their backing Strategy/Fragment is gone). Safe cleanup.
async function _orchPruneFlow(admin) {
  const tab = await _orchActiveTab();
  const msg = appendMessage({ role: 'assistant', body: 'Pruning orphaned capabilities…' });
  const r = await _orchReq('PRUNE_ORPHANS', { scope: admin.scope, tabId: tab && tab.id });
  if (r && r.success) {
    _setMessageBody(msg, r.removed
      ? `✓ Removed ${r.removed} orphaned capabilit${r.removed === 1 ? 'y' : 'ies'} (their backing strategy was gone)${admin.scope === 'all' ? ' across all sites' : ' here'}.`
      : `No orphaned capabilities${admin.scope === 'all' ? '' : ' here'} — nothing to prune.`);
  } else _setMessageBody(msg, `Couldn’t prune${r && r.error ? ` — ${r.error}` : ''}.`);
}

// STATS (v2.74.819) — a one-glance library overview.
async function _orchStatsFlow() {
  const msg = appendMessage({ role: 'assistant', body: 'Tallying your library…' });
  const r = await _orchReq('STATS', {});
  if (!r || r.success === false) { _setMessageBody(msg, `Couldn’t read the library${r && r.error ? ` — ${r.error}` : ''}.`); return; }
  _setMessageBody(msg, `Library: ${r.grounds} Ground${r.grounds === 1 ? '' : 's'} · ${r.capabilities} capabilit${r.capabilities === 1 ? 'y' : 'ies'}${r.orphans ? ` (${r.orphans} orphaned — try “prune orphans”)` : ''} · ${r.workflows} saved workflow${r.workflows === 1 ? '' : 's'}.`);
}

// ORCH-X — confirm a COMPOUND ask as an ordered chain, then run it. One confirmation covers the whole chain.
function _orchConfirmChain(msg, { tabId, clauses, firstMatch, ask = '' }) {
  const list = clauses.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
  _setMessageBody(msg, `That’s a few steps — I’ll do them in order:\n${list}`);
  const bar = _orchActionBar(msg);
  const go = document.createElement('button'); go.className = 'btn-secondary tiny'; go.type = 'button'; go.textContent = `Run all ${clauses.length}`;
  const cancel = document.createElement('button'); cancel.className = 'btn-secondary tiny'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  bar.appendChild(go); bar.appendChild(cancel);
  go.addEventListener('click', () => { bar.remove(); _orchRunChain(msg, { tabId, clauses, firstMatch, ask }); });
  cancel.addEventListener('click', () => { bar.remove(); _setMessageBody(msg, 'Okay — cancelled.'); });
}

// Run a decomposed chain JIT: match EACH clause against the page state AT THAT POINT (so a clause on the
// post-navigation page resolves correctly), REPLAY it, settle, next.
//
// AUTHOR-AS-YOU-GO (Option 1): a mid-chain MISS or failed run no longer ABANDONS the chain. It offers
// "● Show me this step"; a successful demo PERFORMS that clause live (so the page is already in its post-state),
// records it for promotion, and RESUMES the chain from the NEXT clause. So a fully-cold compound becomes a guided
// sequence — demo, continue, demo, continue — and ends with a runnable, promotable whole. The demonstrated clause
// is NOT re-run on resume (that would double-apply a toggle like a filter); we trust the demo left the page settled.
// `startIndex`/`state` carry the resume point + accumulated readouts/ranSteps across demos; the first clause reuses
// the match already computed to probe the Ground (no re-LLM).
async function _orchRunChain(msg, { tabId, clauses, firstMatch, ask = '', startIndex = 0, state = null }) {
  const total = clauses.length;
  const st = state || { readouts: [], ranSteps: [], chainGroundId: null };   // T2 — resolved steps for promotion
  const _record = (m, clause, kind) => { st.ranSteps.push({ capabilityId: m.capabilityId, bindings: (m.bindings && typeof m.bindings === 'object') ? m.bindings : {}, kind: kind || (m.candidate && m.candidate.kind) || null, clause: clause.text, intent: (m.candidate && m.candidate.intent) || clause.text }); st.chainGroundId = m.groundId; };
  // The demo of clause i performed it live → record the new capability for promotion, then continue from i+1.
  const _resumeAfterDemo = (i, clause, gid) => (cap) => {
    if (cap && cap.id) st.ranSteps.push({ capabilityId: cap.id, bindings: {}, kind: cap.kind || null, clause: clause.text, intent: cap.intent || clause.text });
    if (gid) st.chainGroundId = gid;
    _orchRunChain(appendMessage({ role: 'assistant', body: '' }), { tabId, clauses, firstMatch: null, ask, startIndex: i + 1, state: st });
  };
  for (let i = startIndex; i < total; i++) {
    const clause = clauses[i];
    _setMessageBody(msg, `Step ${i + 1} of ${total}: “${clause.text}”…`);
    const m = (i === 0 && firstMatch) ? firstMatch : await _orchReq('ORCH_MATCH', { tabId, ask: clause.text });
    if (!m || !m.capabilityId || m.decision === 'miss') {
      const gid = (m && m.groundId) || st.chainGroundId;
      if (!gid) { _setMessageBody(msg, `Ran ${i} of ${total}. I don’t know how to “${clause.text}” here, and I don’t have this site mapped to learn it.`); return; }
      _setMessageBody(msg, `Step ${i + 1} of ${total}: I don’t know how to “${clause.text}” on this page yet — show me this step and I’ll keep going.`);
      _orchOfferRecord(msg, { groundId: gid, tabId, ask: clause.text, label: '● Show me this step', onAuthored: _resumeAfterDemo(i, clause, gid) });
      return;
    }
    // A READ clause (observation) returns a VALUE — run it through the observation read path, not REPLAY.
    if (m.candidate && m.candidate.kind === 'observation') {
      const val = await _orchReadValue({ tabId, groundId: m.groundId, ask: clause.text, capabilityId: m.capabilityId });
      if (val == null) { _setMessageBody(msg, `Step ${i + 1} of ${total}: couldn’t read “${clause.text}” here — show me this step and I’ll keep going.`); _orchOfferRecord(msg, { groundId: m.groundId, tabId, ask: clause.text, label: '● Show me this step', onAuthored: _resumeAfterDemo(i, clause, m.groundId) }); return; }
      st.readouts.push(val); _record(m, clause, 'observation');
      _orchReq('ORCH_RECORD_ALIAS', { groundId: m.groundId, capabilityId: m.capabilityId, phrase: clause.text });
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    const res = await _orchReq('REPLAY_SG_CAPABILITY', { tabId, groundId: m.groundId, capabilityId: m.capabilityId, paramValues: (m.bindings && typeof m.bindings === 'object') ? m.bindings : {} });
    if (!res || res.success === false || res.ran === false || res.ok === false) {
      const why = (res && (res.error || res.reason)) ? ` — ${res.error || res.reason}` : '';
      _setMessageBody(msg, `Step ${i + 1} (“${clause.text}”) didn’t run${why} — show me the right way and I’ll keep going.`);
      _orchOfferRecord(msg, { groundId: m.groundId, tabId, ask: clause.text, label: '● Show me the right way', onAuthored: _resumeAfterDemo(i, clause, m.groundId) });
      return;
    }
    _record(m, clause);
    _orchReq('ORCH_RECORD_ALIAS', { groundId: m.groundId, capabilityId: m.capabilityId, phrase: clause.text });   // flywheel per clause
    await new Promise((r) => setTimeout(r, 800));   // settle between steps (navigation / render)
  }
  _setMessageBody(msg, st.readouts.length ? st.readouts.join('\n') : `Done — ran all ${total} steps.`);
  // T2 — the whole compound ran cleanly → offer to promote it to a durable composite (cache hit next time).
  _orchOfferSaveCompound(msg, { tabId, groundId: st.chainGroundId, ask, steps: st.ranSteps });
}

// A "show me" record button (offered on a grounded MISS or after a failed run). No groundId → no-op.
// `onAuthored` (optional) fires with the derived capability after a successful demo — the chain runner uses it to
// RESUME a cold compound from the next clause instead of dead-ending at the gap.
function _orchOfferRecord(msg, { groundId, tabId, ask, label = '● Show me', onAuthored = null }) {
  if (!groundId) return;
  const bar = _orchActionBar(msg);
  const rec = document.createElement('button'); rec.className = 'btn-secondary tiny'; rec.type = 'button'; rec.textContent = label;
  bar.appendChild(rec);
  rec.addEventListener('click', () => { bar.remove(); _orchRecordFlow(msg, { groundId, tabId, ask, onAuthored }); });
}

// ORCH-X T2 — after a compound ask runs successfully, offer to PROMOTE it into a durable composite (a T2
// artifact) so the SAME ask is a one-step cache hit next time (ACCEPT_COMPOUND). Reuses the saved-step list — no
// re-record. ≥2 steps + a known ground required.
function _orchOfferSaveCompound(msg, { tabId, groundId, ask, steps, plan = null }) {
  if (!groundId || !ask) return;
  // A CONTROL-FLOW run (foreach/loop/gate) is savable as a quantified T2 artifact — its IR steps go up whole (the
  // foreach node has no capabilityId, so the legacy ≥2-capability filter doesn't apply). A FLAT compound needs ≥2
  // capability-backed steps.
  const cf = Array.isArray(steps) && steps.some((s) => s && (s.kind === 'foreach' || s.kind === 'loop' || s.kind === 'gate'));
  const usable = cf ? steps : (Array.isArray(steps) ? steps : []).filter((s) => s && s.capabilityId);
  if (!cf && usable.length < 2) return;
  const label = cf ? '💾 Remember this (for each…)' : '💾 Remember these steps';
  const bar = _orchActionBar(msg);
  bar.appendChild(_mkBtn(label, async () => {
    bar.remove();
    const r = await _orchReq('ACCEPT_COMPOUND', { tabId, groundId, ask, steps: usable, ...(cf && plan ? { plan } : {}) });
    if (!(r && r.success && r.capability)) { appendMessage({ role: 'assistant', body: `Couldn’t save${r && r.error ? ` — ${r.error}` : ''}.` }); return; }
    // CONVERGE — a control-flow composite ALSO promotes to a CANONICAL Strategy: Studio-visible, ParamForm-
    // launchable, run by the one ExecutionEngine. Best-effort + additive — a promote miss (visual condition,
    // unresolved leaf) leaves the chat composite exactly as-is (it still runs via the ORCH interpreter).
    let extra = '';
    if (r.capability.controlFlow && r.capability.id) {
      try {
        const p = await _orchReq('PROMOTE_COMPOSITE_STRATEGY', { tabId, groundId, capabilityId: r.capability.id });
        if (p && p.success && p.promoted && !p.alreadyPromoted) {
          const ps = (Array.isArray(p.params) ? p.params : []).map((x) => x && x.name).filter(Boolean);
          extra = `\n\n📚 Also saved as a Strategy — review & launch it in Studio${ps.length ? ` (${ps.length} param${ps.length > 1 ? 's' : ''}: ${ps.join(', ')})` : ''}.`;
        }
      } catch { /* promote is best-effort; the composite still runs regardless */ }
    }
    appendMessage({ role: 'assistant', body: `Saved — next time “${ask}” runs in one step.${extra}` });
  }));
}

// ORCH-CB — COLD ground: the LLM planner couldn't bind a plan, but a STRUCTURED ask still has shape. Comprehend it
// from the ask ALONE (substrate-free) and show it as a plan-to-learn — every part a gap — instead of collapsing to
// one unmatched blob. Renders the conditional/foreach structure; offers to work it out from the page or be shown.
function _orchOfferComprehended(msg, { tabId, groundId, ask, comp }) {
  const steps = (comp && Array.isArray(comp.steps)) ? comp.steps : [];
  const byId = new Map(steps.map((s) => [s && s.id, s]));
  const consumed = new Set();   // a gate's condition machinery renders INLINE on the gate line
  for (const s of steps) if (s && s.kind === 'gate') { const an = byId.get(s.over); if (an) { consumed.add(an.id); if (an.over) consumed.add(an.over); } }
  let n = 0;
  const lines = [];
  for (const s of steps) {
    if (!s || consumed.has(s.id)) continue;
    n++;
    if (s.kind === 'gate') { const an = byId.get(s.over); lines.push(`${n}. if ${(an && an.intent) || 'it applies'}: ${(s.body || []).map((b) => b.intent || b.clause).filter(Boolean).join(' → ')}`); }
    else if (s.kind === 'foreach' || s.kind === 'loop') { lines.push(`${n}. for each item: ${(s.body || []).map((b) => b.intent || b.clause).filter(Boolean).join(' → ')}`); }
    else lines.push(`${n}. ${s.intent || s.clause || s.kind}`);
  }
  _setMessageBody(msg, `Here’s how I read that — I don’t have ${lines.length > 1 ? 'these steps' : 'this'} saved on this page yet:\n${lines.join('\n')}`);
  const bar = _orchActionBar(msg);
  bar.appendChild(_mkBtn('✨ Try it from the page', () => { bar.remove(); _orchTryGaps(appendMessage({ role: 'assistant', body: '' }), { tabId, groundId, gaps: [ask] }); }));
  bar.appendChild(_mkBtn('● Show me', () => { bar.remove(); _orchRecordFlow(appendMessage({ role: 'assistant', body: '' }), { groundId, tabId, ask }); }));
}

// ── T3X — cross-Ground WORKFLOW proposal ────────────────────────────────────────────────────────────────────
// T3X live-fix (v2.74.793) — SINGLE-Ground fallback for a site-named ask the within-Ground cascade couldn't run
// (the side panel is on a different site / a blank tab than the named Ground). Resolves the ask the cross-Ground way
// (COMPREHEND_CROSS_GROUND HOPS to the named Ground at run time) and OFFERS the workflow ONLY when it's runnable —
// so "search react jobs on indeed" works off-Indeed, while a named site with no matching capability declines and
// falls through to the normal "show me" / record offer. Returns true iff it took over (appended a workflow offer).
// T3X live-fix (v2.74.794) — a cross-Ground comprehension is WORTH SHOWING when ≥1 sub-intent actually BOUND to a
// capability (the workflow has a runnable step), even if others are gaps — the offer renders ✓/⚠ per step and turns
// each gap into a "teach it there" action. An all-gap result (nothing bound) is NOT worth a workflow card; it falls
// through to the normal record offer. PURE.
function _xgHasBoundStep(cg) {
  return !!(cg && cg.success !== false && cg.workflow && Array.isArray(cg.workflow.steps) && cg.workflow.steps.length >= 1);
}
function _xgHasGap(cg) {
  return !!((Array.isArray(cg && cg.gaps) && cg.gaps.length) || (Array.isArray(cg && cg.repairs) && cg.repairs.length));
}

async function _tryCrossGroundFallback(ask, existingMsg = null) {
  // Reuse the caller's in-flight bubble (so there's a spinner during the LLM call + no empty double-bubble); else
  // append a fresh one. On a decline we DON'T remove a reused bubble — the caller falls through and overwrites it.
  const probe = existingMsg || appendMessage({ role: 'thinking', body: 'Looking across your sites…' });
  probe.classList.remove('assistant'); probe.classList.add('thinking'); _setMessageBody(probe, 'Looking across your sites…');
  let cg = null;
  try { cg = await _orchReq('COMPREHEND_CROSS_GROUND', { ask }); } catch { if (!existingMsg) probe.remove(); return false; }
  // Offer a runnable workflow OR an honest PARTIAL (some steps bound + a gap to teach) — not only the fully-bound case.
  if (!_xgHasBoundStep(cg)) { if (!existingMsg) probe.remove(); return false; }
  probe.classList.remove('thinking'); probe.classList.add('assistant');
  _orchOfferWorkflow(probe, { ask, res: cg });
  return true;
}

// T3X-IND (v2.74.795) — the ask points at the CURRENT page/site ("filter remote jobs HERE"), so it should stay
// scoped to this tab — don't fan out to other Grounds. PURE lexical guard for the global-match gate.
function _isPageReferential(ask) {
  return /\b(here|this page|this site|on this page|on this site|current page|on screen|on the page)\b/i.test(String(ask || ''));
}

// T3X-IND (v2.74.795) — MAKE THE CHAT INDEPENDENT of the current tab. A GENERAL request that didn't match the
// current page is matched across ALL Grounds (ORCH_MATCH_GLOBAL). 1 Ground → offer to run it there; ≥2 → SAY SO and
// let the user pick (we don't guess which site). 0 → fall through to the normal record offer. Reuses the caller's
// in-flight bubble. Returns true iff it took over.
async function _tryGlobalMatch(ask, existingMsg = null, excludeGroundId = null) {
  const probe = existingMsg || appendMessage({ role: 'thinking', body: 'Checking your other sites…' });
  probe.classList.remove('assistant'); probe.classList.add('thinking'); _setMessageBody(probe, 'Checking your other sites…');
  let r = null;
  try { r = await _orchReq('ORCH_MATCH_GLOBAL', { ask }); } catch { if (!existingMsg) probe.remove(); return false; }
  let hits = (r && Array.isArray(r.hits)) ? r.hits : [];
  if (excludeGroundId) hits = hits.filter((h) => h && h.groundId !== excludeGroundId);   // v2.74.801 — never offer to run on the Ground that just missed
  if (!hits.length) { if (!existingMsg) probe.remove(); return false; }
  probe.classList.remove('thinking'); probe.classList.add('assistant');
  if (hits.length === 1) {
    const h = hits[0];
    const name = h.groundName || 'another site';
    _setMessageBody(probe, `Not on this page — but I can do that on ${name}. Run it there?`);
    const bar = _orchActionBar(probe);
    bar.appendChild(_mkBtn(`▶ Run on ${name}`, () => { bar.remove(); _orchRunOnGround(appendMessage({ role: 'assistant', body: '' }), { ask, hit: h }); }));
    bar.appendChild(_mkBtn('Not now', () => { bar.remove(); }));
    return true;
  }
  // ≥2 — SAY SO (per the interim spec: surface the ambiguity, don't pick). One button per site → run on the chosen one.
  _setMessageBody(probe, `That works on a few of your sites — ${hits.map((h) => h.groundName).join(', ')}. Which one?`);
  const bar = _orchActionBar(probe);
  for (const h of hits) bar.appendChild(_mkBtn(h.groundName || 'that site', () => { bar.remove(); _orchRunOnGround(appendMessage({ role: 'assistant', body: '' }), { ask, hit: h }); }));
  return true;
}

// T3X-IND — run a globally-matched capability on its (non-current) Ground: build a 1-step Workflow on that Ground
// (BUILD_SG_ON_GROUND_WORKFLOW binds the ask's values + lowers it), then save+invoke it via the existing run path
// (which HOPS to the Ground and runs). So "search jazz singer jobs" off-Indeed runs on Indeed without leaving chat.
async function _orchRunOnGround(msg, { ask, hit }) {
  _setMessageBody(msg, `Setting up on ${hit.groundName}…`);
  const b = await _orchReq('BUILD_SG_ON_GROUND_WORKFLOW', { ask, groundId: hit.groundId, capabilityId: hit.capabilityId });
  if (!b || b.success === false || !b.workflow) { _setMessageBody(msg, `Couldn’t set that up${b && b.error ? ` — ${b.error}` : ''}.`); return; }
  _orchRunWorkflow(msg, { workflow: b.workflow, ask });
}

// T3X-IND (v2.74.798) — open a Ground in a foreground tab and wait for it to settle, so a chain can run there.
function _openGroundTab(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    let tab = null;
    try { chrome.tabs.create({ url, active: true }, (t) => { void chrome.runtime.lastError; tab = t || null; afterCreate(); }); }
    catch { resolve(null); return; }
    function afterCreate() {
      if (!tab || typeof tab.id !== 'number') { resolve(null); return; }
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        try { chrome.tabs.onUpdated.removeListener(onU); } catch (_) { /* */ }
        // brief settle so the page's JS initializes before the chain starts typing
        setTimeout(() => resolve(tab), 600);
      };
      const onU = (id, info) => { if (id === tab.id && info.status === 'complete') finish(); };
      try { chrome.tabs.onUpdated.addListener(onU); } catch (_) { /* */ }
      try { chrome.tabs.get(tab.id, (t) => { void chrome.runtime.lastError; if (t && t.status === 'complete') finish(); }); } catch (_) { /* */ }
      setTimeout(finish, 15000);
    }
  });
}

// T3X-IND (v2.74.798) — COMPOUND off-Ground ask ("search jazz singer jobs … AND retrieve the first title", asked
// when the side panel is on a non-Ground page). The first clause can't run on the current tab, so resolve its Ground
// globally (on the PRIMARY/action clause) and run the WHOLE chain THERE: open the Ground in a foreground tab, then
// _orchRunChain on it (which runs clauses sequentially on one tab — preserving the search→results→read page state).
// 1 Ground → offer; ≥2 → the user picks. 0 → fall through. Reuses the caller's in-flight bubble.
async function _tryGlobalChain(ask, clauses, existingMsg = null) {
  const probe = existingMsg || appendMessage({ role: 'thinking', body: 'Checking your other sites…' });
  probe.classList.remove('assistant'); probe.classList.add('thinking'); _setMessageBody(probe, 'Checking your other sites…');
  let r = null;
  try { r = await _orchReq('ORCH_MATCH_GLOBAL', { ask: clauses[0].text }); } catch { if (!existingMsg) probe.remove(); return false; }
  const hits = (r && Array.isArray(r.hits)) ? r.hits : [];
  if (!hits.length) { if (!existingMsg) probe.remove(); return false; }
  probe.classList.remove('thinking'); probe.classList.add('assistant');
  const stepList = clauses.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
  const run = async (hit) => {
    const name = hit.groundName || 'that site';
    _setMessageBody(probe, `Opening ${name} and running ${clauses.length} steps…`);
    const tab = await _openGroundTab(hit.groundUrl);
    if (!tab) { _setMessageBody(probe, `Couldn’t open ${name}.`); return; }
    _orchRunChain(probe, { tabId: tab.id, clauses, firstMatch: null, ask });
  };
  if (hits.length === 1) {
    const h = hits[0]; const name = h.groundName || 'another site';
    _setMessageBody(probe, `That’s ${clauses.length} steps I can do on ${name}:\n${stepList}\nOpen ${name} and run them?`);
    const bar = _orchActionBar(probe);
    bar.appendChild(_mkBtn(`▶ Run on ${name}`, () => { bar.remove(); run(h); }));
    bar.appendChild(_mkBtn('Not now', () => { bar.remove(); }));
    return true;
  }
  _setMessageBody(probe, `A few of your sites can do this:\n${stepList}\n— ${hits.map((h) => h.groundName).join(', ')}. Which one?`);
  const bar = _orchActionBar(probe);
  for (const h of hits) bar.appendChild(_mkBtn(h.groundName || 'that site', () => { bar.remove(); run(h); }));
  return true;
}

// Render a comprehended cross-site Workflow (COMPREHEND_CROSS_GROUND): the per-site steps (✓ bound / ⚠ a gap),
// any GAPS (Q3 repairs — what to teach and where) and ASSUMPTIONS (Q2 ambiguities the resolver had to guess), then
// Run / Save controls. Precision-first: nothing runs or persists until the user acts.
const _wfSite = (r) => (r && (r.groundName || r.groundId)) || '';
// "SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY" → "Search job title keywords or company" — a readable field label.
const _humanizeParam = (n) => String(n || '').replace(/_/g, ' ').trim().toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
function _orchOfferWorkflow(msg, { ask, res }) {
  const wf = (res && res.workflow) || {};
  const resolved = Array.isArray(res && res.resolved) ? res.resolved : [];
  const repairs = Array.isArray(res && res.repairs) ? res.repairs : [];
  const ambiguities = Array.isArray(res && res.ambiguities) ? res.ambiguities : [];

  // v2.74.813 — a bound IRREVERSIBLE consumer (apply/submit/post/buy — reversible===false from the cross-Ground bind)
  // can't ride the single card-confirm silently the way a search/read can. Mark it 🔒 in the step list, warn in the
  // body, and make the run an EXPLICIT "includes a 🔒 step" click — the workflow-card parallel to single-ask "Yes, go ahead".
  const _irr = (r) => !!(r && r.capabilityId && r.reversible === false);
  const irreversible = resolved.filter(_irr);
  const lines = resolved.map((r, i) => {
    const site = _wfSite(r);
    const mark = (r && r.capabilityId) ? (_irr(r) ? '🔒 ' : '') : '⚠ ';
    return `${i + 1}. ${mark}${(r && r.clause) || 'do it'}${site ? ` · on ${site}` : ''}`;
  });
  const sites = Array.from(new Set(resolved.map(_wfSite).filter(Boolean)));
  let body = `This spans ${sites.length} site${sites.length === 1 ? '' : 's'}${sites.length ? ` (${sites.join(' → ')})` : ''}:\n${lines.join('\n')}`;
  if (irreversible.length) body += `\n\n🔒 ${irreversible.length === 1 ? 'One step can’t' : `${irreversible.length} steps can’t`} be undone (submit/apply/post). Review before you run.`;
  if (repairs.length) body += `\n\nI can’t do ${repairs.length === 1 ? 'one part' : `${repairs.length} parts`} yet:\n` + repairs.map((p) => `• ${p.message}`).join('\n');
  if (ambiguities.length) body += `\n\nAssumed: ` + ambiguities.map((a) => `“${a.clause}” → ${(a.candidates && a.candidates[0] && a.candidates[0].name) || 'a site'}`).join('; ');
  _setMessageBody(msg, body);

  const bar = _orchActionBar(msg);
  // v2.74.831 — PRIMARY: walk the plan IN ORDER on one foreground tab — run bound steps, teach gaps IN PLACE on the
  // warm page the prior steps left (so a read gap has a result to point at), narrating each. Handles a partial plan
  // (some gaps) without the cold "teach all first, then run" detour. The atomic Run/Save below stay as options.
  if (resolved.length) {
    bar.appendChild(_mkBtn('▶ Run & teach in order', () => {
      bar.remove(); msg.querySelectorAll('.orch-wf-param').forEach((r) => r.remove());
      _orchLog(`WALK ▸ start — ${resolved.length} step(s)`);   // v2.74.832
      _orchWalkWorkflow(resolved, { ask }).catch((e) => _orchLog(`WALK ▸ start ERROR: ${(e && e.message) || e}`));   // surface a swallowed rejection
    }));
  }
  if (res && res.runnable && wf.id) {
    // Editable inputs for the Workflow's still-UNBOUND params (values the binder bound from the clause are already
    // step LITERALS and aren't shown here). Prefilled empty; whatever's typed is passed as paramValues on Run, so a
    // run can't silently search empty. If the LLM value-binder was unavailable, EVERY param shows here as a fallback.
    const content = msg.querySelector('.message-content');
    const pinputs = [];
    for (const p of (Array.isArray(wf.params) ? wf.params : [])) {
      const name = p && p.name; if (!name) continue;
      const row = document.createElement('div'); row.className = 'orch-wf-param'; row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0;';
      const lab = document.createElement('span'); lab.textContent = _humanizeParam(name); lab.style.cssText = 'font-size:11px;opacity:0.75;min-width:96px;';
      const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = _humanizeParam(name); inp.style.cssText = 'flex:1;font-size:12px;padding:2px 6px;';
      row.appendChild(lab); row.appendChild(inp); content.insertBefore(row, bar);
      pinputs.push({ name, inp, row });
    }
    bar.appendChild(_mkBtn(irreversible.length ? '▶ Run (includes a 🔒 step)' : '▶ Run it', () => {
      const paramValues = {};
      for (const { name, inp } of pinputs) { const v = inp.value.trim(); if (v) paramValues[name] = v; }
      bar.remove(); pinputs.forEach(({ row }) => row.remove());
      _orchRunWorkflow(appendMessage({ role: 'assistant', body: '' }), { workflow: wf, ask, paramValues });
    }));
    bar.appendChild(_mkBtn('🔖 Save for later', () => { bar.remove(); _orchSaveWorkflow(appendMessage({ role: 'assistant', body: '' }), { workflow: wf }); }));
    return;
  }
  // Not runnable → each AUTHOR-STRATEGY gap becomes a "teach it on that site" action (Q3 gap→capture): teaching the
  // Strategy there, then folding back, can make the workflow runnable. A RESOLVE-GROUND gap (no site) stays text.
  const subById = new Map(resolved.map((r) => [r && r.id, r]));
  // v2.74.828 — collect the teachable gaps, then offer ONE flow that walks them IN TURN (teach step 1 → next → … →
  // re-check), instead of N disconnected buttons where teaching one stranded the rest (which read as "the run ended").
  const teachable = [];
  for (const p of repairs) {
    if (!p || p.kind !== 'author-strategy' || !p.groundId) continue;
    const sub = subById.get(p.subIntentId);
    const groundUrl = sub && sub.groundUrl;
    if (!groundUrl) continue;   // no entry url → can’t open the site; the repair stays guidance text above
    teachable.push({ groundId: p.groundId, groundName: p.groundName, groundUrl, clause: p.clause });
  }
  if (teachable.length) {
    bar.appendChild(_mkBtn(`● Teach the ${teachable.length === 1 ? 'missing step' : `${teachable.length} missing steps`}`,
      () => { bar.remove(); _orchTeachGapsInTurn(teachable, { ask, total: teachable.length }); }));
  }
  bar.appendChild(_mkBtn(teachable.length ? 'Not now' : 'Got it', () => { bar.remove(); }));
}

// ── v2.74.831 — IN-ORDER "run-or-teach" WALK ───────────────────────────────────────────────────────────────────
// The fix for "teach is out of context + no feedback": instead of "teach all gaps cold, then run", walk the resolved
// sub-intents in TOPO order on ONE foreground tab (reused per Ground), narrating each step. A BOUND step RUNS (a read's
// value flows into the chat-side `scope` for downstream steps); a GAP is TAUGHT IN PLACE — on the warm page the prior
// steps left, so "read the company" has a search result to point at. Continuation-style (each step advances the next on
// completion) so an interactive teach fits the same flow as an automatic run. Data hand-off uses the literals/scopeReads
// wireCrossGroundData already filled. Foreground so the user can see + demonstrate.
const _wfNames = (arr) => (Array.isArray(arr) ? arr : []).map((p) => (typeof p === 'string' ? p : (p && p.name))).filter(Boolean);

// Open the step's Ground in a FOREGROUND tab; REUSE it across consecutive steps on the same Ground (the warm page).
async function _walkEnsureTab(st, si) {
  if (st.tabId != null && st.ground === si.groundId) { try { await chrome.tabs.update(st.tabId, { active: true }); } catch { /* */ } return st.tabId; }
  try { const t = await chrome.tabs.create({ url: si.groundUrl || undefined, active: true }); st.tabId = (t && typeof t.id === 'number') ? t.id : null; st.ground = si.groundId; }
  catch { st.tabId = null; }
  if (st.tabId != null) await _orchWaitTabReady(st.tabId);
  return st.tabId;
}

// Resolve a step's params from the chat-side scope: a STATED literal, else an upstream output via scopeReads (the hand-off).
function _walkResolveParams(si, scope) {
  const out = {};
  for (const p of _wfNames(si.params)) {
    if (si.literals && si.literals[p] != null && si.literals[p] !== '') out[p] = si.literals[p];
    else if (si.scopeReads && si.scopeReads[p] && scope[si.scopeReads[p]] != null) out[p] = scope[si.scopeReads[p]];
  }
  return out;
}

async function _orchWalkWorkflow(resolved, { ask = '' } = {}) {
  const steps = (Array.isArray(resolved) ? resolved : []).filter(Boolean);
  if (!steps.length) return;
  await _walkStep(steps, 0, { scope: {}, tabId: null, ground: null, total: steps.length }, ask);
}

async function _walkStep(steps, i, st, ask) {
  const next = () => _walkStep(steps, i + 1, st, ask);
  if (i >= steps.length) {
    _orchLog(`WALK ▸ done — ${st.total} step(s)`);   // v2.74.832
    _setMessageBody(appendMessage({ role: 'assistant', body: '' }), `✓ Finished — walked all ${st.total} step${st.total === 1 ? '' : 's'} in order.`);
    return;
  }
  const si = steps[i];
  const isRead = (si.capabilityKind === 'observation') || (!si.capabilityId && classifyReadAsk(si.clause || '').isRead);
  const m = appendMessage({ role: 'assistant', body: '' });
  // v2.74.832 — TRACE the walk to the ring buffer (the .818 ORCH_LOG pass-through) so a `gl` can SEE the
  // doing→teach→doing sequence, AND a try/catch surfaces a throw that would otherwise die silently (the un-awaited
  // _orchWalkWorkflow rejection = the "indeed opens and nothing" report).
  try {
    const kind = si.capabilityId ? (isRead ? 'read' : 'run') : 'teach';
    _orchLog(`WALK ▸ step ${i + 1}/${st.total} · ${kind} "${String(si.clause || '').slice(0, 40)}" on ${si.groundName || '?'} (cap=${si.capabilityId ? String(si.capabilityId).slice(-6) : 'gap'})`);
    const verb = si.capabilityId ? (isRead ? 'reading' : 'running') : 'teaching';
    _setMessageBody(m, `Step ${i + 1}/${st.total} · ${verb} “${si.clause || 'this'}”${si.groundName ? ` on ${si.groundName}` : ''}…`);

    const tab = await _walkEnsureTab(st, si);
    const advance = (value) => { if (value != null && value !== '') for (const o of _wfNames(si.outputs)) st.scope[o] = value; next(); };
    if (tab == null) {
      _orchLog(`WALK ▸ step ${i + 1} · NO TAB for ${si.groundName || '?'}`);
      _setMessageBody(m, `Step ${i + 1}/${st.total} · couldn’t open ${si.groundName || 'the site'}.`);
      const bar = _orchActionBar(m); bar.appendChild(_mkBtn('Skip ▸', () => { bar.remove(); next(); })); bar.appendChild(_mkBtn('Stop', () => { bar.remove(); }));
      return;
    }

    if (si.capabilityId) {
      // ── BOUND → RUN it ──
      if (isRead) {
        const r = await _orchReq('RUN_OBSERVATION', { tabId: tab, groundId: si.groundId, capabilityId: si.capabilityId });
        if (r && r.ok && r.value != null) { _orchLog(`WALK ▸ step ${i + 1} · read OK → "${String(r.value).slice(0, 40)}"`); _setMessageBody(m, `Step ${i + 1}/${st.total} · read “${si.clause}” → “${String(r.value).slice(0, 160)}”.`); advance(r.value); }
        else { _orchLog(`WALK ▸ step ${i + 1} · read MISS [${r ? `ran=${r.ran} ok=${r.ok}${r.reason ? ` ${String(r.reason).slice(0, 40)}` : ''}` : 'null/timeout'}]`); _setMessageBody(m, `Step ${i + 1}/${st.total} · couldn’t read “${si.clause}” here${r && r.reason ? ` (${r.reason})` : ''}.`); _walkReteach(m, si, st, next); }
      } else {
        const r = await _orchReq('REPLAY_SG_CAPABILITY', { tabId: tab, groundId: si.groundId, capabilityId: si.capabilityId, paramValues: _walkResolveParams(si, st.scope) });
        if (r && r.ok) { _orchLog(`WALK ▸ step ${i + 1} · ran OK`); _setMessageBody(m, `Step ${i + 1}/${st.total} · ran “${si.capabilityName || si.clause}”.`); advance(); }
        else { _orchLog(`WALK ▸ step ${i + 1} · run FAIL [${r ? `success=${r.success} ran=${r.ran} ok=${r.ok}${r.error ? ` err="${String(r.error).slice(0, 50)}"` : ''}${r.reason ? ` ${String(r.reason).slice(0, 40)}` : ''}` : 'null/timeout'}]`); _setMessageBody(m, `Step ${i + 1}/${st.total} · “${si.capabilityName || si.clause}” didn’t complete${r && (r.error || r.reason) ? ` (${r.error || r.reason})` : ''}.`); _walkReteach(m, si, st, next); }
      }
    } else {
      // ── GAP → TEACH it in place (the prior steps warmed the page) ──
      _setMessageBody(m, `Step ${i + 1}/${st.total} · ${isRead ? '◎ point at the value to read for' : '● show me how to'} “${si.clause}” on ${si.groundName || 'the site'}.`);
      let done = false; const finish = (value) => { if (done) return; done = true; _orchLog(`WALK ▸ step ${i + 1} · taught (${isRead ? 'observe' : 'action'})`); advance(value); };
      if (isRead) _orchObserveCapture(appendMessage({ role: 'assistant', body: '' }), { groundId: si.groundId, tabId: tab, ask: si.clause, onAuthored: (r) => finish(r && r.value) });
      else _orchNlFallback(appendMessage({ role: 'assistant', body: '' }), { tabId: tab, groundId: si.groundId, ask: si.clause, onAuthored: () => finish() });
      const bar = _orchActionBar(m);
      bar.appendChild(_mkBtn('Skip ▸', () => { bar.remove(); finish(); }));
      bar.appendChild(_mkBtn('Stop', () => { bar.remove(); done = true; }));
    }
  } catch (e) {
    _orchLog(`WALK ▸ step ${i + 1} ERROR: ${(e && e.message) || e}`);   // v2.74.832 — was dying silently
    try { _setMessageBody(m, `Step ${i + 1}/${st.total} hit an error: ${(e && e.message) || e}. Stopped — re-run to retry.`); } catch { /* */ }
  }
}

// A bound step that didn't run/read → re-teach it IN PLACE (the page is already in the right state), skip, or stop.
function _walkReteach(m, si, st, next) {
  const isRead = (si.capabilityKind === 'observation') || classifyReadAsk(si.clause || '').isRead;
  let done = false; const fin = (v) => { if (done) return; done = true; if (v != null && v !== '') for (const o of _wfNames(si.outputs)) st.scope[o] = v; next(); };
  const bar = _orchActionBar(m);
  bar.appendChild(_mkBtn(isRead ? '◎ Re-teach the read' : '● Re-teach it', () => {
    bar.remove();
    if (isRead) _orchObserveCapture(appendMessage({ role: 'assistant', body: '' }), { groundId: si.groundId, tabId: st.tabId, ask: si.clause, onAuthored: (r) => fin(r && r.value) });
    else _orchNlFallback(appendMessage({ role: 'assistant', body: '' }), { tabId: st.tabId, groundId: si.groundId, ask: si.clause, onAuthored: () => fin() });
    const b2 = _orchActionBar(m); b2.appendChild(_mkBtn('Skip ▸', () => { b2.remove(); fin(); }));
  }));
  bar.appendChild(_mkBtn('Skip ▸', () => { bar.remove(); next(); }));
  bar.appendChild(_mkBtn('Stop', () => { bar.remove(); }));
}

// SAVE the previewed Workflow (the exact record shown — no re-decompose), so it can be re-run anytime.
async function _orchSaveWorkflow(msg, { workflow }) {
  _setMessageBody(msg, 'Saving…');
  const saved = await _orchReq('SAVE_WORKFLOW', { workflow });
  _setMessageBody(msg, (saved && saved.success !== false && saved.workflow)
    ? `Saved “${workflow.name || 'workflow'}” — you can run it anytime.`
    : `Couldn’t save${saved && saved.error ? ` — ${saved.error}` : ''}.`);
}

// RUN the previewed Workflow EPHEMERALLY (v2.74.810): invoke the workflow INLINE — no SAVE — so a one-off Run doesn't
// leave a duplicate library record (every Run used to persist a fresh wf_ because INVOKE_WORKFLOW ran by id). The user
// keeps a workflow explicitly via "Save for later". INVOKE_WORKFLOW runs the inline object — its steps dispatch
// already-saved capabilities. Reports the outcome; surfaces saga COMPENSATION (Q5) when a mid-journey failure rolled
// committed steps back.
async function _orchRunWorkflow(msg, { workflow, ask, paramValues = {} }) {
  _setMessageBody(msg, 'Running across your sites…');
  // paramValues fill the Workflow's still-unbound inputs (the editable card); the binder's clause literals are
  // already baked into the steps, so a run uses the right keyword even when paramValues is empty.
  const res = await _orchReq('INVOKE_WORKFLOW', { workflow, paramValues: (paramValues && typeof paramValues === 'object') ? paramValues : {} });
  if (res === null) {   // _orchReq timed out — the run may still be going (cross-site runs can be long)
    _setMessageBody(msg, 'Still working on it — this one’s taking a while. I’ll leave it running; check the tabs it opened.');
    return;
  }
  if (res.success === false) {
    let m = `That didn’t finish${res.error ? ` — ${res.error}` : ''}.`;
    if (Array.isArray(res.compensation) && res.compensation.length) {
      const undone = res.compensation.filter((c) => c && c.success).length;
      m += ` Rolled back ${undone}/${res.compensation.length} completed step${res.compensation.length === 1 ? '' : 's'}.`;
    }
    _setMessageBody(msg, m);
    return;
  }
  const n = Array.isArray(workflow.groundIds) ? workflow.groundIds.length : 0;
  _setMessageBody(msg, `Done — ran “${workflow.name || ask || 'the workflow'}”${n ? ` across ${n} site${n === 1 ? '' : 's'}` : ''}.`);
}

// Resolve once the new tab finishes loading (so a trial doesn't fire on a blank page). Proceeds anyway after a cap.
function _orchWaitTabReady(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      try {
        chrome.tabs.get(tabId, (t) => {
          if (chrome.runtime.lastError || !t) return resolve(false);
          if (t.status === 'complete') return resolve(true);
          if (Date.now() - start > timeoutMs) return resolve(true);
          setTimeout(tick, 300);
        });
      } catch { resolve(false); }
    };
    tick();
  });
}

// Q3 gap→capture — TEACH the missing Strategy on its own Ground, then FOLD BACK into the cross-site workflow.
// Opens the gap's site in a new tab, tries to synthesize the capability from the page (NL-trial), and falls back to
// "show me" (manual demo). EITHER success path fires onAuthored → re-comprehends the ORIGINAL ask so the freshly
// authored Strategy closes the gap and the workflow re-renders (now bound, maybe runnable). A manual ↻ button is the
// safety net for a demo the user finishes later.
// v2.74.828 — TEACH EACH MISSING STEP IN TURN. Walk the gap queue: teach the head; the user advances ("Next step ▸",
// or auto-advance when the NL synth authors) regardless of whether THIS gap actually saved — so one hard gap can't
// strand the rest (the "run ends after one teach" report). After the last, re-check the WHOLE workflow once.
async function _orchTeachGapsInTurn(queue, { ask, total }) {
  if (!queue.length) { await _orchRecheckWorkflow(ask); return; }
  const step = (total || queue.length) - queue.length + 1;
  const g = queue[0];
  const m = appendMessage({ role: 'assistant', body: '' });
  _setMessageBody(m, `Teaching step ${step} of ${total || queue.length}: “${g.clause}” on ${g.groundName || 'the site'}.`);
  await _orchTeachGap(m, { ...g, ask, advance: () => _orchTeachGapsInTurn(queue.slice(1), { ask, total }) });
}

async function _orchTeachGap(msg, { groundId, groundName, groundUrl, clause, ask, advance = null }) {
  _setMessageBody(msg, `Opening ${groundName || 'the site'} to learn “${clause}”…`);
  // v2.74.828 — in SEQUENCE mode (advance set) move on ONCE whether the NL synth authored, a manual demo saved, or the
  // user skips; idempotent so an auto-advance and a button click can't double-step.
  let advanced = false;
  const go = () => { if (advanced || !advance) return; advanced = true; advance(); };
  let tab = null;
  try { tab = await chrome.tabs.create({ url: groundUrl, active: true }); } catch { /* */ }
  if (!tab || typeof tab.id !== 'number') {
    _setMessageBody(msg, `Couldn’t open ${groundName || 'that site'}.`);
    if (advance) { const b = _orchActionBar(msg); b.appendChild(_mkBtn('Skip → next step', () => { b.remove(); go(); })); }
    return;
  }
  await _orchWaitTabReady(tab.id);
  // v2.74.830 — a READ gap ("read the company", "note its price") is an OBSERVATION — point at the VALUE to read, NOT
  // a "do the task" recording. Honor the SAME classifyReadAsk oracle comprehension used to set the step's effect, so
  // the teach matches the gap's KIND. (Was: every gap went to the action trial+record, demanding an action even for a
  // read — the brittleness the user hit.)
  const isRead = classifyReadAsk(clause).isRead;
  const onAuthored = advance ? go : (() => _orchRecheckWorkflow(ask, groundName, clause));
  _setMessageBody(msg, `On ${groundName || 'the site'} — ${isRead ? 'point at the value to read for' : 'learning'} “${clause}”.${advance ? '' : ' I’ll re-check the workflow once it’s saved.'}`);
  if (isRead) {
    // OBSERVATION teach — point at the value on the page; saving the observation makes the read step bindable.
    await _orchObserveCapture(appendMessage({ role: 'assistant', body: '' }), { groundId, tabId: tab.id, ask: clause, onAuthored });
  } else {
    // ACTION teach — NL-trial first (synthesize from the page); on failure it offers manual record. Both fold back.
    await _orchNlFallback(appendMessage({ role: 'assistant', body: '' }), { tabId: tab.id, groundId, ask: clause, onAuthored });
  }
  if (advance) {
    if (!advanced) { const bar = _orchActionBar(msg); bar.appendChild(_mkBtn('Next step ▸', () => { bar.remove(); go(); })); }   // manual advance when the synth didn't author
  } else {
    const bar = _orchActionBar(msg);
    bar.appendChild(_mkBtn('↻ Re-check workflow', () => { bar.remove(); _orchRecheckWorkflow(ask, groundName, clause); }));
  }
}

// Re-comprehend the original cross-site ask after a gap was taught; render the updated card. The new Strategy is now
// in the catalog, so the previously-⚠ step should bind. PURE re-run of COMPREHEND_CROSS_GROUND (save:false preview).
async function _orchRecheckWorkflow(ask, groundName = '', clause = '') {
  const msg = appendMessage({ role: 'assistant', body: 'Re-checking the workflow…' });
  const cg = await _orchReq('COMPREHEND_CROSS_GROUND', { ask });
  if (!cg || cg.success === false) { _setMessageBody(msg, `Couldn’t re-check${cg && cg.error ? ` — ${cg.error}` : ''}.`); return; }
  const stillGaps = Array.isArray(cg.repairs) && cg.repairs.length > 0;
  const head = clause ? `Learned “${clause}”${groundName ? ` on ${groundName}` : ''}. ` : '';
  _setMessageBody(msg, head + (cg.runnable ? 'The workflow’s ready now.' : (stillGaps ? 'One step still needs teaching:' : 'Here’s the updated plan:')));
  _orchOfferWorkflow(appendMessage({ role: 'assistant', body: '' }), { ask, res: cg });
}

// Conversational fillers are never page tasks — skip the grounded matcher so "yes"/"ok" don't match a capability.
const _ORCH_FILLER = /^(y|n|yes|no|ok|okay|sure|yep|yeah|nope|nah|thanks|thank you|ty|hi|hello|hey|nvm|never ?mind|stop|cancel|wait|done)\b[\s!.?]*$/i;

// T3X — a cross-SITE handoff cue: a connective + a transfer verb + a destination preposition ("… and save it TO
// Notion"). A cheap precision gate so only plausibly cross-Ground asks pay the COMPREHEND_CROSS_GROUND LLM call;
// the background still confirms the ask resolves to ≥2 distinct Grounds before the chat commits the turn.
const _CROSS_SITE_CUE = /\b(?:and|then|&|,)\b[\s\S]*\b(?:save|add|post|send|put|create|share|copy|paste|export|sync|log|record|store|bookmark|email|message|dm|tweet|publish|upload|attach|schedule|draft)\b[\s\S]*\b(?:to|into|onto|on|in)\b/i;

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
    _orchLog(`ROUTE ▸ "${String(text).slice(0, 50)}" → admin/${admin.command}`);   // v2.74.818
    if (admin.command === 'clear_chat') _orchClearChat();
    else if (admin.command === 'list') await _orchListFlow(admin);     // v2.74.819 — read complement to delete
    else if (admin.command === 'rename') await _orchRenameFlow(admin); // v2.74.819 — name a Ground
    else if (admin.command === 'prune') await _orchPruneFlow(admin);   // v2.74.819 — remove orphaned capabilities
    else if (admin.command === 'stats') await _orchStatsFlow();        // v2.74.819 — library overview
    else await _orchAdminFlow(admin);
    return true;
  }

  // DEDUP — "dedupe grounds" / "merge duplicate sites": detect Grounds that are the same site (read-only).
  if (parseDedupCommand(text).isDedup) { _orchLog(`ROUTE ▸ "${String(text).slice(0, 50)}" → dedup`); await _orchDedupFlow(); return true; }   // v2.74.818

  const tab = await _orchActiveTab();
  if (!tab || typeof tab.id !== 'number') return false;
  // v2.74.818 — the grounded route + active-tab Ground host; the downstream COMPREHEND_CROSS_GROUND / ORCH_MATCH(_GLOBAL)
  // line then shows which grounded sub-path ran, so a turn's full route reads in two lines.
  _orchLog(`ROUTE ▸ "${String(text).slice(0, 50)}" → grounded [tab=${(() => { try { return new URL(tab.url).hostname; } catch { return '?'; } })()}]`);

  // ORCH-X T2 CACHE — a COMPOUND ask the user already saved as a composite (a T2 artifact) runs ATOMICALLY: no
  // re-decompose, no per-clause re-match. Cheap lexical lookup (NO LLM), gated to compound-ish asks so a simple
  // ask pays nothing. This is "compound intents are T2 artifacts" — a discrete intent is a T1 cache hit; a
  // compound intent, once promoted, is a T2 cache hit.
  if (isCompoundAsk(text) || looksComplex(text)) {
    const mc = await _orchReq('MATCH_COMPOSITE', { tabId: tab.id, ask: text });
    if (mc && mc.matched && Array.isArray(mc.steps) && mc.steps.length) {
      const probe = appendMessage({ role: 'assistant', body: '' });
      _orchConfirmPlan(probe, { tabId: tab.id, groundId: mc.groundId, steps: mc.steps, gaps: [], ask: text, savedComposite: true });
      return true;
    }
  }

  // T3X — a CROSS-SITE intent spans MULTIPLE Grounds, so it can't bind to the active page. Two shapes trigger it:
  // a DATA HANDOFF ("find a job on LinkedIn and save it to Notion" — _CROSS_SITE_CUE) AND an independent SEQUENCE
  // ("search Indeed then search Pixabay" — namesMultipleSites: a connective + ≥2 distinct site references, which
  // the transfer-verb cue misses). Either way we comprehend it into a WORKFLOW that composes one Strategy per
  // Ground (COMPREHEND_CROSS_GROUND, T3). We COMMIT the turn only when it resolves to ≥2 distinct Grounds — a
  // single-Ground result (or the within-task multi-phase fallback) falls through to the within-Ground cascade
  // unchanged, so a wrongly-triggered ask costs one comprehend and is harmless. Save:false — this is a PREVIEW.
  // T3X live-fix (v2.74.793) — track whether the cross-Ground comprehension already ran this turn, so the
  // single-Ground fallback at the bottom doesn't redundantly re-attempt (and re-pay the LLM) what just failed here.
  let _xgTried = false;
  if (isCompoundAsk(text) && (_CROSS_SITE_CUE.test(text) || namesMultipleSites(text))) {
    const probe = appendMessage({ role: 'thinking', body: 'Looking across your sites…' });
    const cg = await _orchReq('COMPREHEND_CROSS_GROUND', { ask: text });
    _xgTried = true;
    const grounds = new Set(((cg && Array.isArray(cg.resolved)) ? cg.resolved : []).map((r) => r && r.groundId).filter(Boolean));
    // Commit to the cross-Ground card for a real multi-Ground plan (≥2 Grounds), OR a PARTIAL one worth showing
    // (≥1 step bound + a gap to teach — e.g. Indeed ✓ but Pixabay not a Ground yet): surface the honest plan with
    // the gap + repair instead of a flat "no capability". A single fully-bound Ground with no gap still falls
    // through to the within-Ground cascade so a within-site ask isn't hijacked.
    if (_xgHasBoundStep(cg) && (grounds.size >= 2 || _xgHasGap(cg))) {
      probe.classList.remove('thinking'); probe.classList.add('assistant');
      _orchOfferWorkflow(probe, { ask: text, res: cg });
      return true;
    }
    probe.remove();   // nothing bound / no gap to show → let the within-Ground cascade handle it unchanged
  }

  // ORCH-X — a COMPOUND ask ("search for x AND filter by y") is DECOMPOSED and CHAINED over existing
  // capabilities, instead of being matched as one (unfindable) atomic intent. We probe the Ground with the
  // first clause (reused as step 1's match); no Ground → fall through to the legacy matcher.
  // A FOREACH ask ("…of each", "click each result…") is NOT a flat chain — it routes to the LLM planner so
  // liftControlFlow can lift it into a foreach. Skip the lexical chain for these.
  const clauses = decomposeAsk(text);
  if (clauses.length > 1 && !isForeachAsk(text) && !isConditionalAsk(text)) {
    const probe = appendMessage({ role: 'thinking', body: 'Checking this page…' });
    const m0 = await _orchReq('ORCH_MATCH', { tabId: tab.id, ask: clauses[0].text });
    if (!m0 || !m0.groundId) {
      // T3X live-fix (v2.74.793) — the FIRST clause names a Ground we're not on ("search react jobs on indeed, …"),
      // so the within-Ground chain can't even start. Resolve the whole ask the cross-Ground way before giving up.
      if (namesAnySite(text) && !_xgTried && await _tryCrossGroundFallback(text, probe)) return true;
      // T3X-IND (v2.74.798) — COMPOUND off-Ground, no site named ("search jazz singer jobs … and retrieve the first
      // title" from a non-Ground tab): resolve the Ground globally (on the first/action clause) and run the whole
      // chain there. This is the "compound + independence" case.
      if (!namesAnySite(text) && !_isPageReferential(text) && await _tryGlobalChain(text, clauses, probe)) return true;
      probe.remove(); return false;
    }
    probe.classList.remove('thinking'); probe.classList.add('assistant');
    _orchConfirmChain(probe, { tabId: tab.id, clauses, firstMatch: m0, ask: text });
    return true;
  }

  // ORCH-X — a COMPLEX single sentence ("search SWE jobs in minneapolis posted last 7 days") spans multiple
  // capabilities with no connective for decomposeAsk to split on. Ask the LLM PLANNER to route it over the
  // recorded capabilities; if it decomposes into >1 step, confirm + chain. 0–1 steps → fall through to the
  // single matcher (so simple asks pay no extra LLM call — the looksComplex gate guards it).
  if (looksComplex(text) || isForeachAsk(text) || isConditionalAsk(text)) {
    const probe = appendMessage({ role: 'thinking', body: 'Working out the steps…' });
    const plan = await _orchReq('ORCH_PLAN', { tabId: tab.id, ask: text });
    const pSteps = (plan && plan.success && Array.isArray(plan.steps)) ? plan.steps : [];
    const pGaps = (plan && Array.isArray(plan.gaps)) ? plan.gaps : [];
    // Take over when it's genuinely multi-step, OR when it's one step but the ask has constraints no capability
    // covers (so we surface the gap honestly instead of an over-confident "covers this" single match).
    if (pSteps.length > 1 || (pSteps.length === 1 && pGaps.length > 0)) {
      probe.classList.remove('thinking'); probe.classList.add('assistant');
      _orchConfirmPlan(probe, { tabId: tab.id, groundId: plan.groundId, steps: pSteps, gaps: pGaps, ask: text });
      return true;
    }
    // ORCH-CB — the planner found nothing to bind (a COLD ground), but a STRUCTURED ask still decomposes.
    // Comprehend the shape from the ask alone (substrate-free), then BIND it against whatever's recorded via the
    // lexical floor (ORCH_BIND, no LLM). Fully bound → confirm + run (the floor recovered matches the conservative
    // planner missed); partial / empty → show the structure as a plan-to-learn, every missing part a gap.
    const comp = comprehend(text);
    if (comp && Array.isArray(comp.steps) && comp.steps.length > 1) {
      const bound = await _orchReq('ORCH_BIND', { tabId: tab.id, groundId: (plan && plan.groundId) || null, shape: comp });
      const bgid = (bound && bound.groundId) || (plan && plan.groundId) || null;
      probe.classList.remove('thinking'); probe.classList.add('assistant');
      if (bound && bound.success && bound.bound && Array.isArray(bound.steps) && !comp.escalate) {
        _orchConfirmPlan(probe, { tabId: tab.id, groundId: bgid, steps: bound.steps, gaps: [], ask: text });   // fully bound → run
      } else {
        _orchOfferComprehended(probe, { tabId: tab.id, groundId: bgid, ask: text, comp: (bound && Array.isArray(bound.steps) && bound.steps.length) ? { steps: bound.steps } : comp });
      }
      return true;
    }
    probe.remove();
  }

  const thinking = appendMessage({ role: 'thinking', body: 'Checking this page…' });
  // OBS-READ bridge — a QUESTION first consults the user's MANUAL (Studio-authored) Observations, which live in a
  // DIFFERENT store than the ORCH matcher's lightweight captured ones. Without this the chat ignores a rich
  // hand-authored read and offers to capture a new (often more brittle) one. A confident match RUNS and shows the
  // value — reads are reversible, so auto-running is safe — preferring the authored read over a fresh capture.
  // T3X live-fix (v2.74.793) — only short-circuit to a single read for a SIMPLE read ask. A COMPOUND ask ("search
  // …, take the top title, and search …") contains a read CLAUSE but is a multi-step ACTION sequence — answering it
  // with one stale observation value (the bug: a 3-site ask returned a lone job title) is wrong. Let it fall through
  // to the chain / cross-Ground fallback instead.
  if (classifyReadAsk(text).isRead && !isCompoundAsk(text)) {
    const mo = await _orchReq('RUN_BEST_OBSERVATION', { tabId: tab.id, ask: text });
    if (mo && mo.matched && mo.ok && String(mo.value || '').trim()) {
      thinking.classList.remove('thinking'); thinking.classList.add('assistant');
      _setMessageBody(thinking, String(mo.value).trim().slice(0, 800));
      return true;
    }
  }
  const m = await _orchReq('ORCH_MATCH', { tabId: tab.id, ask: text });
  if (!m || m.success === false) {
    if (namesAnySite(text) && !_xgTried && await _tryCrossGroundFallback(text, thinking)) return true;   // T3X — "…on indeed" off-Indeed: resolve + run there
    thinking.remove();
    return false;
  }
  // No Ground for this page → the site isn't in the library; let the legacy matcher try. A grounded MISS
  // (the page IS known, just no capability for this ask) falls through to the "show me?" record offer below.
  // T3X live-fix (v2.74.793) — BUT if the ask NAMES a site (e.g. the side panel is on a blank tab and the user
  // says "search react jobs on indeed"), resolve it to that Ground and run there before giving up.
  if (m.decision === 'miss' && !m.groundId) {
    if (namesAnySite(text) && !_xgTried && await _tryCrossGroundFallback(text, thinking)) return true;
    // T3X-IND — no Ground for this tab + a GENERAL request → match across ALL Grounds (independent chat): 1 → run
    // there, ≥2 → ask which. A page-referential or site-named ask is handled above; this is the "do it anywhere" case.
    if (!namesAnySite(text) && !_isPageReferential(text) && await _tryGlobalMatch(text, thinking)) return true;
    thinking.remove();
    return false;
  }

  // v2.74.801 — a GROUNDED miss whose ask NAMES another of your Grounds ("search pixabay for X" while on Indeed):
  // match that other site and offer to run it THERE, instead of offering to teach it on THIS (wrong) site. The
  // background sets m.otherGround ONLY when the ask references a DIFFERENT known Ground, so a generic "show me here"
  // miss is untouched. Confirm-first; _isPageReferential keeps "…here" on this tab; the current Ground is excluded
  // from the offer. Falls through to the teach-here record offer below if nothing matches on the named site.
  if (m.decision === 'miss' && m.otherGround && !_isPageReferential(text)
      && await _tryGlobalMatch(text, thinking, m.groundId)) return true;

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
    // T3X live-fix (v2.74.793) — this page is a Ground but has no capability for the ask. If the ask NAMES a site
    // (e.g. you're on LinkedIn and say "search react jobs on indeed"), resolve it to THAT Ground and run there,
    // rather than offering to record it here on the wrong site. Falls through to the record offers (which overwrite
    // this bubble) if it can't.
    if (namesAnySite(text) && !_xgTried && await _tryCrossGroundFallback(text, thinking)) return true;
    // T3X-IND — this page is a Ground but can't do the ask, and it's a GENERAL request (not page-referential): the
    // chat is independent of the tab, so match across your OTHER Grounds before offering to record it here. 1 → run
    // there, ≥2 → ask which. Falls through to the record offers (which overwrite this bubble) if nothing matches.
    if (!namesAnySite(text) && !_isPageReferential(text) && await _tryGlobalMatch(text, thinking)) return true;
    // OBS-READ — a QUESTION with no observation yet: offer to capture one by POINTING at the value, instead of
    // (or alongside) recording an action demonstration.
    if (classifyReadAsk(text).isRead) {
      _setMessageBody(thinking, classifyReadAsk(text).outputType === 'list'
        ? 'I can read those — point me at ONE of them (the first) and I’ll read them all.'
        : 'I can read that for you — point me at it on the page.');
      const bar = _orchActionBar(thinking);
      bar.appendChild(_mkBtn('◎ Point me at it', () => { bar.remove(); _orchObserveCapture(thinking, { groundId: m.groundId, tabId: tab.id, ask: text }); }));
      bar.appendChild(_mkBtn('📷 Let me look at it', () => { bar.remove(); _orchVisualCapture(thinking, { groundId: m.groundId, tabId: tab.id, ask: text }); }));
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
async function _orchRecordFlow(msg, { groundId, tabId, ask, onAuthored = null }) {
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
      _orchReq('ORCH_RECORD_ALIAS', { groundId, capabilityId: res.capability.id, phrase: ask });   // so the next ask hits
      // When a caller wants to CONTINUE after the demo (the chain runner resuming a cold compound), hand back the
      // derived capability instead of the dead-end "ask me again" copy — the chain picks up from the next clause.
      if (typeof onAuthored === 'function') {
        _setMessageBody(msg, `Got it — learned “${res.capability.intent}”. Continuing…`);
        onAuthored(res.capability);
      } else {
        _setMessageBody(msg, `Got it — I learned “${res.capability.intent}”. Ask me again and I’ll do it.`);
      }
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

