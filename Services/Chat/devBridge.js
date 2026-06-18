// Services/Chat/devBridge.js — DB-1b (v2.74.973): the PANEL half of the dev bridge
// (docs/DESIGN_dev_bridge.md §3-§7, §11). One strippable module: everything dev-bridge in the panel
// lives here, behind the 'devBridge' setting + the OPTIONAL nativeMessaging permission, so the release
// posture (§11) is a configuration decision — drop this module + the optional permission and the
// feature never existed.
//
// TRUST RULES (§5), enforced here:
//   • Verbs are USER-TYPED only (`dev: on|off`, `dev: <ask>`, `gl`) — nothing composes or auto-sends a
//     bridge prompt; the module is unreachable from the ask pipeline when disabled.
//   • Everything the host streams back renders as PLAIN TEXT (never markdown/html) — a run's output can
//     echo page-derived strings, and this surface must not interpret them.
//   • The permission is requested ONLY on `dev: on`, first thing, while the user-gesture token is live.
//   • Commits stay human: the host's allowlist has no git; this module offers no such verb either.
//
// Protocol: versioned {v:1} envelopes (§11) — Chrome's native-messaging port does the framing.

import { ConversationStore, devResumeSession } from '../ConversationStore.js';   // v2.74.1022 `gch`; v2.74.1034 (DBR-2) per-conversation resume

const PROTOCOL_V = 1;
const HOST_NAME = 'com.orchard.devbridge';
const SETTING_KEY = 'settings:devBridge';
const MODEL_SETTING_KEY = 'settings:devBridgeModel';   // v2.74.976 — which model the bridge's claude runs as
const MODEL_ALIASES = ['default', 'fable', 'opus', 'sonnet', 'haiku'];   // MUST stay ⊆ the host's ALLOWED_MODELS table
const TURNS_SETTING_KEY = 'settings:devBridgeTurns';   // v2.74.978 — per-run --max-turns budget (the runaway guard)
const TURNS_DEFAULT = 25;   // v2.74.979 — the value when unset; NO artificial ceiling/floor (the host only checks it's a positive int)
const APPLIED_SIG_KEY = 'settings:devBridgeAppliedSig';   // v2.74.980 — the working-tree signature as of the last reload (the "applied" baseline)
const LAST_SESSION_KEY = 'settings:devBridgeLastSession';   // v2.74.985 — the prior run's claude session id; `dev:` resumes it (conversation by default)
const RELAY_SETTING_KEY = 'settings:devBridgeRelay';   // v2.74.1002 — DB-3 permission relay opt-in (PreToolUse hook → inline approve/deny)

// The decisions filter — VERBATIM from studio.js _DECISION_RE (the source of truth; keep in sync until
// a shared extraction). Filters the session's log entries down to the signal-only story view that the
// gl convention prefers. v2.74.1022 — re-synced to studio.js (added FOCUS ▸ / CLARIFY ▸ / CLOSE_TABS ▸).
const DECISION_RE = /(▶ RUN |[✓✗] RUN |COMPREHEND_CROSS_GROUND ▸|T3X resolve ▸|T3X bind ▸|_bind ▸|GROUNDS ▸|ROUTE ▸|HANDOFF ▸|postcond ▸|ORCH_MATCH ▸|ORCH_MATCH_GLOBAL ▸|DETECT_DUPLICATE_GROUNDS ▸|MERGE_GROUNDS ▸|mergeGround |Ground saved:|Ground deleted:|→ (?:auto|propose|miss)\/|RUN_OBSERVATION|RUN_BEST_OBSERVATION|ORCH_RECORD_ALIAS|ORCH_ADMIN ▸|REPLAY_SG_CAPABILITY —|— bindings:|CLICK caused navigation|WALK ▸|LOOP ▸|ORCH_PLAN ▸|OPEN_URL_NEW_TAB —|REVERIFY_SG_CAPABILITY —|ROUTE_ASK "|bindClauseParams →|locale-fresh-skip|locale-trust:|EXPLORE_PAGE_STRUCTURE done|RUN_SG_TRIAL|INTERACTION_MONITOR_START|INTENT_MENU ▸|RICH_INTENTS ▸|ACCEPT_SG_TRIAL|INTERACTION_OUTCOMES ▸|proposeRichIntents —|ensureGroundForUrl|EXPLORE ▸|STOP ▸|FOCUS ▸|CLARIFY ▸|CLOSE_TABS ▸|DEVBR ▸|LT ▸|CONCERN ▸)/;

function _fmtEntry(entry) {
  const time = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
    : '—';
  let line = `${time} ${String(entry.level ?? '').padEnd(5)} ${String(entry.source ?? '').padEnd(20)} ${entry.message ?? ''}`;
  if (entry.data !== null && entry.data !== undefined) {
    try {
      const dataStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2);
      line += `\n  ${dataStr.replace(/\n/g, '\n  ')}`;
    } catch { /* skip */ }
  }
  return line;
}

function _stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// v2.74.1022 — chat transcript formatter for `gch` — mirrors studio.js formatConversationAsText.
function _fmtConv(conv) {
  const when = (ts) => ts ? new Date(ts).toLocaleString('en-US', { hour12: false }) : '—';
  const lines = [`# ${conv.title ?? 'Untitled'}`, `created ${when(conv.createdAt)} · updated ${when(conv.updatedAt)} · ${(conv.messages ?? []).length} message(s)`, ''];
  for (const m of (conv.messages ?? [])) {
    lines.push(`## ${String(m.role ?? '?')} — ${when(m.ts)}`);
    lines.push(String(m.body ?? ''));
    if (m.outcome && m.outcome.label) lines.push(`_outcome: ${m.outcome.label}${m.outcome.detail ? ' — ' + m.outcome.detail : ''}_`);
    lines.push('');
  }
  return lines.join('\n');
}

function _short(s, n = 60) { const t = String(s ?? ''); return t.length > n ? `…${t.slice(-(n - 1))}` : t; }

// DBR-4 (v2.74.1036, DESIGN §4) — the `lt` live-test verb matcher. PURE + exported for unit tests. Matches on
// the WHOLE trimmed message (case-insensitive, inner whitespace collapsed): only the bare tokens fire, so a
// longer sentence merely CONTAINING "live test" (e.g. "can you live test the search box?") is NOT a match and
// flows to Claude as a normal prompt. Whole-message-only is what makes the trigger safe (DESIGN §4, the `lt`
// keyword decision). The caller gates this on a dev conversation — non-dev conversations never intercept.
export function isLiveTest(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return t === 'lt' || t === 'live' || t === 'live test' || t === 'livetest';
}

// v2.74.1043 (DESIGN §4 guardrail) — the FORCE variant: a bare lt token with a trailing `!` or ` force`
// ("lt!", "lt force", "live test!", …). It means "switch anyway, past the behind-main warning" (single-tree
// `lt` reloads the WHOLE extension onto the branch, so a branch behind main reverts the panel itself — the
// default `lt` warns + refuses; this is the explicit override). Same whole-message discipline as isLiveTest:
// a sentence merely containing "force"/"!" does NOT match. PURE + exported for unit tests. Disjoint from
// isLiveTest (the bare tokens never carry the suffix), so the caller can OR the two safely.
export function isLiveTestForce(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const m = t.match(/^(.*?)\s*(?:!|force)$/);   // strip a trailing `!` or the word `force`
  if (!m) return false;
  const base = m[1].trim();
  return base === 'lt' || base === 'live' || base === 'live test' || base === 'livetest';
}

/**
 * Factory — chat.js hands in its rendering helpers (avoids any import cycle into the panel).
 * @param {{appendMessage: Function, setMessageBody: Function, mkBtn: Function, persistMessage?: Function, decorateBubble?: Function, renderMarkdown?: Function, wireCodeCopyButtons?: Function}} deps
 */
export function createDevBridge({ appendMessage, setMessageBody, mkBtn, persistMessage, decorateBubble, renderMarkdown, wireCodeCopyButtons, getScrollContainer }) {
  let port = null;
  let run = null;   // { msgEl, lines: string[], bar: Element|null, sessionId: string|null }

  // DB-2 (v2.74.975) — reload-icon state (spec §5). The header icon (owned by chat.js) subscribes via
  // onReloadState; we push it `enabled` (dev mode on/off → show/hide) and `available` (changes are PENDING
  // a reload → light the dot).
  //
  // v2.74.980 fix — `available` means "changed SINCE the last reload", not "tree is dirty". The original
  // code lit the dot from `files.length > 0`, on the (wrong) assumption that a reload would reset it: but
  // a reload doesn't commit, so the tree stays dirty and onReloadState's startup diffstat re-arms the dot
  // immediately — the icon looked identical before and after a reload and never cleared. The fix gates the
  // dot on `sig !== appliedSig`, where `appliedSig` (persisted) is the tree signature stamped at the last
  // reload. After a reload the post-reload signature matches the baseline → dot clears; the next edit
  // changes the signature → dot re-arms. `sig` is carried in state so reloadExtension can stamp it.
  let reloadListener = null;
  let reloadState = { enabled: false, available: false, files: [], sig: '' };
  function emitReload(patch) {
    reloadState = { ...reloadState, ...patch };
    try { reloadListener?.({ ...reloadState }); } catch { /* a UI throw must not break the bridge */ }
  }

  const getEnabled = async () => {
    try { return (await chrome.storage.local.get(SETTING_KEY))[SETTING_KEY] === true; } catch { return false; }
  };
  const setEnabled = async (v) => { try { await chrome.storage.local.set({ [SETTING_KEY]: v === true }); } catch { /* */ } };
  // v2.74.976 — the bridge model preference (an ALIAS; the host maps it to a real id via its own
  // allowlist — the panel never sends a model NAME, so there is no command-line surface here either).
  const getModel = async () => {
    try { const v = (await chrome.storage.local.get(MODEL_SETTING_KEY))[MODEL_SETTING_KEY]; return MODEL_ALIASES.includes(v) ? v : 'default'; } catch { return 'default'; }
  };
  const setModel = async (v) => { try { await chrome.storage.local.set({ [MODEL_SETTING_KEY]: v }); } catch { /* */ } };
  // v2.74.978 — the per-run turn budget. Any positive integer; the default applies only when unset/invalid.
  const getTurns = async () => {
    try { const v = Math.floor(Number((await chrome.storage.local.get(TURNS_SETTING_KEY))[TURNS_SETTING_KEY])); return (Number.isFinite(v) && v >= 1) ? v : TURNS_DEFAULT; } catch { return TURNS_DEFAULT; }
  };
  const setTurns = async (n) => { try { await chrome.storage.local.set({ [TURNS_SETTING_KEY]: n }); } catch { /* */ } };
  // v2.74.1002 — DB-3 permission relay opt-in. When on, runs load the relay settings file (PreToolUse hook
  // → the panel approves/denies each non-safe tool); when off, the proven DB-2 static allowlist is used.
  const getRelay = async () => { try { return (await chrome.storage.local.get(RELAY_SETTING_KEY))[RELAY_SETTING_KEY] === true; } catch { return false; } };
  const setRelay = async (v) => { try { await chrome.storage.local.set({ [RELAY_SETTING_KEY]: v === true }); } catch { /* */ } };
  // v2.74.985 — the last run's session id, so `dev:` CONTINUES the conversation by default. Persisted so
  // it survives a panel close. `dev: new` / `dev: reset` clear it to start a fresh thread.
  const getLastSession = async () => {
    try { const v = (await chrome.storage.local.get(LAST_SESSION_KEY))[LAST_SESSION_KEY]; return /^[0-9a-f-]{36}$/i.test(v) ? v : null; } catch { return null; }
  };
  const setLastSession = async (s) => { try { await chrome.storage.local.set({ [LAST_SESSION_KEY]: String(s ?? '') }); } catch { /* */ } };
  const clearLastSession = async () => { try { await chrome.storage.local.remove(LAST_SESSION_KEY); } catch { /* */ } };
  // v2.74.1034 (DBR-2) — the resume target for a dev conversation is its OWN session (per-conversation), via
  // devResumeSession on the conversation record; falls back to null if the conversation/session is gone.
  const _convResume = async (id) => { try { return devResumeSession(await ConversationStore.load(id)); } catch { return null; } };
  // DBR-5 (v2.74.1037, DESIGN §8.2) — trim an ask to a one-line concern LABEL (collapse whitespace, cap length).
  const _conciseConcern = (ask) => String(ask ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  // DBR-5 fix (v2.74.1038) — a QUESTION/STATUS ask ("is the build complete?", "what's left?") is a query, not a
  // scope of work. Defaulting a concern from one pins the conversation to "assess", and since the host re-injects
  // that concern as a "work ONLY on …" guardrail on EVERY spawn, it then OVERRIDES later BUILD asks — the
  // dev-bridge looped on itself, re-reporting "DBR-6 not built" and never building it (even on an explicit "yes").
  // So an interrogative first ask does NOT seed a concern: the run stays unconstrained (pre-DBR-5 behaviour) until
  // a real task or an explicit `dev: concern <scope>`. A false-skip is safe — it just means no scope guardrail for
  // that run. See logs/run/findings.md.
  const _looksLikeQuestion = (ask) => {
    const s = String(ask ?? '').trim();
    return /\?\s*$/.test(s)
      || /^(is|are|was|were|do|does|did|can|could|should|would|will|has|have|what|which|who|whose|when|where|why|how)\b/i.test(s);
  };
  // DBR-5 — the concern DEFAULTS to the first real (non-question) ask. Capture it on the dev conversation once
  // (never overwrite an existing/edited concern), and return the EFFECTIVE concern for THIS spawn so the run
  // payload carries it. Pass `ask` for a real task (sets it if unset & not a question); null just reads it.
  // The host builds the scope contract from this and re-injects on every spawn (initial + resume).
  const _ensureConcern = async (id, ask = null) => {
    if (!id) return null;
    try {
      const conv = await ConversationStore.load(id);
      if (!conv || conv.kind !== 'dev') return null;
      let concern = typeof conv.concern === 'string' ? conv.concern.trim() : '';
      if (!concern && ask && !_looksLikeQuestion(ask)) {
        concern = _conciseConcern(ask);
        if (concern) await ConversationStore.patchMeta(id, { concern }).catch(() => { /* */ });
      }
      return concern || null;
    } catch { return null; }
  };
  // v2.74.980 — the working-tree signature stamped at the last reload (the "applied" baseline). Persisted
  // so it survives the chrome.runtime.reload() that the reload icon triggers — that survival is the whole
  // point: the post-reload diffstat compares against it to decide whether anything is still pending.
  const getAppliedSig = async () => {
    try { const v = (await chrome.storage.local.get(APPLIED_SIG_KEY))[APPLIED_SIG_KEY]; return typeof v === 'string' ? v : ''; } catch { return ''; }
  };
  const setAppliedSig = async (s) => { try { await chrome.storage.local.set({ [APPLIED_SIG_KEY]: String(s ?? '') }); } catch { /* */ } };

  // ── Run-follow scroll (v2.74.995) ────────────────────────────────────────────────────────────────
  // The chat's near-bottom heuristic (96px) breaks for the bridge: a single streamed block (a long
  // text / tool / thinking block) is routinely TALLER than that, so right after one big block the view
  // is no longer "near bottom" and following silently stops — which is why auto-scroll appeared dead.
  // Instead we keep our own follow flag: it stays true while the view sits at the bottom and only flips
  // off when the USER scrolls up; on every streamed block we re-anchor the run footer (the working…/
  // Pause line, which is the last element in the bubble) into view by pinning the scroll to the bottom.
  let _follow = true;
  let _scrollWired = false;
  const _scroller = () => { try { return getScrollContainer ? getScrollContainer() : null; } catch { return null; } };
  const _atBottom = (c) => !c || (c.scrollHeight - c.scrollTop - c.clientHeight) <= 140;
  function _wireFollow() {
    if (_scrollWired) return;
    const c = _scroller();
    if (!c) return;
    _scrollWired = true;
    // A user scroll recomputes follow; a programmatic scroll-to-bottom lands at the bottom so follow
    // stays true (no feedback loop). Appending a block does NOT fire 'scroll', so big blocks can't flip it.
    c.addEventListener('scroll', () => { _follow = _atBottom(c); }, { passive: true });
  }
  function _anchor() {
    if (!_follow) return;
    const c = _scroller();
    if (c) c.scrollTop = c.scrollHeight;   // footer bar is the last child → pins working…/Pause at the bottom
  }

  // ── Rich rendering (v2.74.993) — mirror Claude Code's desktop formatting ──────────────────────────
  // Each stream event becomes a styled BLOCK in the bubble's .message-body, instead of the old plain-text
  // line dump: assistant prose → markdown (code fences, lists, bold — via the SAME injection-safe
  // renderMarkdown the chat uses; it HTML-escapes first, so a run echoing page-derived strings still
  // can't inject), tool calls → compact chips (glyph · name · arg), thinking → a dim aside, run meta →
  // subtle lines, the result → a footer. Persistence serializes the blocks back to markdown (stored with
  // { markdown:true, devBridge:true }) so a reloaded run re-renders with the same look via the existing
  // pm.markdown rehydrate branch. The on-disk journal stays the full record; the bubble caps its history.
  const MAX_BLOCKS = 80;
  const TOOL_GLYPH = { Read: '▤', Edit: '✎', MultiEdit: '✎', Write: '✎', NotebookEdit: '✎', Bash: '▶', Grep: '⌕', Glob: '⌕', Task: '⛬', WebFetch: '⤓', WebSearch: '⌕' };
  const _glyph = (name) => TOOL_GLYPH[name] || '▸';

  function _blockNode(b) {
    const el = document.createElement('div');
    el.className = `dev-blk dev-blk-${b.kind}`;
    if (b.kind === 'text') {
      el.innerHTML = renderMarkdown ? renderMarkdown(b.text || '') : '';
      if (!renderMarkdown) el.textContent = b.text || '';   // defensive: no renderer injected
      try { wireCodeCopyButtons?.(el); } catch { /* */ }
    } else if (b.kind === 'tool') {
      const g = document.createElement('span'); g.className = 'dev-tool-icon'; g.textContent = _glyph(b.name);
      const n = document.createElement('span'); n.className = 'dev-tool-name'; n.textContent = b.name || 'tool';
      el.appendChild(g); el.appendChild(n);
      if (b.arg) { const a = document.createElement('span'); a.className = 'dev-tool-arg'; a.textContent = b.arg; el.appendChild(a); }
    } else if (b.kind === 'result') {
      el.classList.add(b.ok ? 'ok' : 'err');
      el.textContent = b.text || '';
    } else {            // meta · thinking — plain text, styled dim
      el.textContent = b.text || '';
    }
    return el;
  }

  // Serialize blocks → markdown for persistence (tool chips become inline-code; meta/thinking dim italic).
  function _blocksToMarkdown(blocks) {
    return (blocks || []).map((b) => {
      if (b.kind === 'text') return b.text || '';
      if (b.kind === 'tool') return '`' + _glyph(b.name) + ' ' + (b.name || 'tool') + '`' + (b.arg ? ' `' + b.arg + '`' : '');
      if (b.kind === 'result') return '**' + (b.text || '') + '**';
      return '_' + (b.text || '') + '_';   // meta · thinking
    }).map((s) => String(s).trim()).filter(Boolean).join('\n\n');
  }

  // v2.74.1035 (DBR-3, DESIGN §9) — `conversationId` PINS the write to the run's originating dev conversation.
  // A run streams over time; if the user switches conversations mid-run, the unpinned path persisted its blocks
  // into whatever was active (the leak). Run-path callers pass run.conversationId; standalone bubbles (created
  // synchronously in the active conversation) omit it and use the active conversation.
  function _persistBlocks(msg, blocks, conversationId = null) {
    if (!persistMessage) return;
    const fields = { role: 'assistant', body: _blocksToMarkdown(blocks), markdown: true, devBridge: true };
    if (conversationId) fields.conversationId = conversationId;
    try { persistMessage(msg, fields)?.catch?.(() => { /* */ }); } catch { /* */ }
  }

  // Create a dev bubble. `initial` (if any) renders as a markdown text block. Returns the handle the run
  // streams into; standalone status/error bubbles just use it once.
  function devBubble(initial, { persist = true } = {}) {
    const msg = appendMessage({ role: 'assistant', body: '' });
    const bodyEl = msg.querySelector('.message-body');
    // .md-rendered on the body makes the chat's markdown CSS apply to the text blocks rendered inside it.
    if (bodyEl) { bodyEl.textContent = ''; bodyEl.classList.add('md-rendered'); }
    // v2.74.990 — shared decorator: amber identity + the collapse header. Live bubbles start expanded
    // (you watch them stream); rehydrate is what collapses long past runs. Falls back to the inline
    // amber border if no decorator was injected (older host wiring).
    if (decorateBubble) decorateBubble(msg, { collapsed: false });
    else { try { msg.style.borderLeft = '3px solid #c9a227'; msg.dataset.devBridge = '1'; } catch { /* */ } }
    const blocks = [];
    if (initial) { const b = { kind: 'text', text: initial }; blocks.push(b); bodyEl?.appendChild(_blockNode(b)); }
    if (persist) _persistBlocks(msg, blocks);   // v2.74.1000 — history replay bubbles are transient (not persisted)
    try { _anchor(); } catch { /* */ }   // v2.74.995 — keep the new bubble's tail in view
    return { msg, bodyEl, blocks };
  }

  // Append a streamed block to the active run. Caps the rendered history (journal on disk is the full record).
  const _PERSIST_THROTTLE_MS = 2000;
  function _emit(b) {
    if (!run || !run.bodyEl) return;
    run.blocks.push(b);
    run.bodyEl.appendChild(_blockNode(b));
    while (run.blocks.length > MAX_BLOCKS) {
      run.blocks.shift();
      if (run.bodyEl.firstChild) run.bodyEl.removeChild(run.bodyEl.firstChild);
    }
    // v2.74.999 (DB-3) — persist a snapshot AS the run streams (throttled), not only at endRun. The
    // child does NOT survive a panel close / extension reload on Windows (verified — see findings), so
    // live-reattach can't continue a run; instead a mid-run close now leaves a useful PARTIAL transcript
    // in the conversation (rehydrated on reopen), and `dev:` resumes the session from there. Throttled so
    // a fast run doesn't hammer chrome.storage; endRun still does the final, complete persist.
    const now = Date.now();
    if (!run.replay && (!run._lastPersist || (now - run._lastPersist) >= _PERSIST_THROTTLE_MS)) {
      run._lastPersist = now;
      _persistBlocks(run.msg, run.blocks, run.conversationId);   // v2.74.1035 (DBR-3) — pin to the originating conversation
    }
    // v2.74.995 — re-anchor the run footer (working…/Pause) so the latest block stays in view, unless
    // the user has scrolled up. Block-size-agnostic (unlike the chat's 96px near-bottom heuristic).
    try { _anchor(); } catch { /* */ }
  }

  // End the run. `final` may be a block object or a string (→ an error result block).
  function endRun(final) {
    if (!run) return;
    if (run.tick) { try { clearInterval(run.tick); } catch { /* */ } run.tick = null; }   // v2.74.989 — stop the elapsed ticker
    if (final) _emit(typeof final === 'string' ? { kind: 'result', ok: false, text: final } : final);
    try { run.bar?.remove(); } catch { /* */ }
    if (!run.replay) _persistBlocks(run.msg, run.blocks, run.conversationId);   // v2.74.987/.993 terminal blocks; .1035 pinned
    run = null;
  }

  function disconnect() {
    try { port?.disconnect(); } catch { /* */ }
    port = null;
  }

  function ensurePort() {
    if (port) return port;
    port = chrome.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener(onHostMsg);
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || '';
      port = null;
      _failPendingGit('bridge port closed');   // v2.74.1034 (DBR-2) — don't leave git RPCs hanging on disconnect
      if (run) {
        endRun(/not found|forbidden/i.test(err)
          ? `✗ bridge host not reachable (${err}). Run bridge/install.ps1 once, then reload the extension.`
          : `✗ bridge port closed${err ? ` — ${err}` : ''} (a started run continues detached; journal in logs/bridge/).`);
      }
    });
    return port;
  }

  // v2.74.1034 (DBR-2) — panel→host git RPC. Posts {type:'git', op, params, reqId}; resolves on the matching
  // git-result. The host enforces the §3 allowlist (parameter-validated argv → spawn shell-free; dev-branch
  // write guard) — the panel only relays. Correlated by reqId and safety-timed so a dead host can't hang a caller.
  let _gitSeq = 0;
  const _gitPending = new Map();
  function _failPendingGit(reason) { for (const resolve of _gitPending.values()) { try { resolve({ ok: false, error: reason }); } catch { /* */ } } _gitPending.clear(); }
  function gitOp(op, params = {}) {
    return new Promise((resolve) => {
      const reqId = 'g' + (++_gitSeq);
      _gitPending.set(reqId, resolve);
      const done = (r) => { if (_gitPending.has(reqId)) { _gitPending.delete(reqId); resolve(r); } };
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'git', op, params, reqId }); }
      catch (e) { done({ ok: false, error: 'host unreachable: ' + ((e && e.message) || e) }); return; }
      setTimeout(() => done({ ok: false, error: 'git op timed out' }), 20000);
    });
  }

  function onHostMsg(m) {
    if (!m || m.v !== PROTOCOL_V) return;
    switch (m.type) {
      case 'git-result': { const resolve = _gitPending.get(m.reqId); if (resolve) { _gitPending.delete(m.reqId); resolve(m); } break; }   // v2.74.1034 (DBR-2)
      case 'preflight':
        if (!m.ok) { endRun(`✗ preflight failed: ${m.error}`); break; }
        if (run && run.pendingPayload) { const p = run.pendingPayload; run.pendingPayload = null; port.postMessage(p); _emit({ kind: 'meta', text: `claude ${m.claudeVersion} · ${m.repoRoot}` }); }
        break;
      case 'started':
        _emit({ kind: 'meta', text: `▶ run started (pid ${m.pid}${m.resumed ? `, ↻ resumed ${String(m.resumed).slice(0, 8)}` : ''}${m.model && m.model !== 'default' ? `, model ${m.model}` : ''}${m.maxTurns ? `, ≤${m.maxTurns} turns` : ''}, journal logs/bridge/${m.journal})` });
        break;
      case 'event': {
        const ev = m.ev || {};
        if (ev.type === 'system' && ev.subtype === 'init') {
          if (run) run.sessionId = ev.session_id ?? null;
          _emit({ kind: 'meta', text: `session ${String(ev.session_id ?? '').slice(0, 8)} · ${ev.model ?? ''}` });
        } else if (ev.type === 'assistant') {
          for (const block of (ev.message?.content ?? [])) {
            if (block.type === 'text' && block.text?.trim()) _emit({ kind: 'text', text: block.text.trim() });
            else if (block.type === 'thinking' && block.thinking?.trim()) _emit({ kind: 'thinking', text: block.thinking.trim() });
            else if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
              // v2.74.1024 — SURFACE Claude's questions. Pre-.1024 this rendered as a bare "AskUserQuestion"
              // chip (the arg pick below has none of its fields) so the question + options VANISHED — the
              // "chat doesn't surface claude code questions" bug. Headless `claude -p` can't take an
              // interactive answer mid-run, so render the question as plain text and tell the user to reply
              // with `dev: <choice>` (which resumes the session so Claude sees the answer).
              // v2.74.1025 (DB-4) — when the relay is ON, the PreToolUse hook ALSO sends an interactive
              // `approval` (question) frame → _emitQuestion renders option buttons that PAUSE the run. Skip
              // this static text then (avoid a double); only render it as the relay-OFF fallback.
              const qs = Array.isArray(block.input?.questions) ? block.input.questions : [];
              const lines = ['❓ Claude is asking:'];
              for (const q of qs) {
                lines.push(`• ${String(q.question ?? q.header ?? '').trim()}`);
                for (const o of (Array.isArray(q.options) ? q.options : [])) lines.push(`    – ${String(o.label ?? '').trim()}${o.description ? ` — ${String(o.description).trim()}` : ''}`);
              }
              lines.push('↳ answer with `dev: <your choice>`.');
              getRelay().then((on) => { if (!on) _emit({ kind: 'text', text: lines.join('\n') }); }).catch(() => _emit({ kind: 'text', text: lines.join('\n') }));
            }
            else if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
              // v2.74.1024 — surface the proposed plan (was a content-less chip too).
              _emit({ kind: 'text', text: `📋 Claude proposed a plan:\n${String(block.input?.plan ?? '').trim()}\n↳ approve with \`dev: yes\`, or redirect with \`dev: <changes>\`.` });
            }
            else if (block.type === 'tool_use') {
              const arg = block.input?.file_path ?? block.input?.pattern ?? block.input?.command ?? '';
              _emit({ kind: 'tool', name: block.name, arg: arg ? _short(arg, 80) : '' });
            }
          }
        }
        break;
      }
      case 'diffstat': {
        const files = Array.isArray(m.files) ? m.files : [];
        const sig = typeof m.sig === 'string' ? m.sig : '';
        // v2.74.980 — PENDING = dirty AND the signature differs from the last-reloaded baseline. On first
        // use (no baseline persisted) appliedSig is '' so a dirty tree still arms the dot — honest: there
        // are uncommitted changes a reload would apply. After a reload the signatures match → dot clears.
        getAppliedSig().then((applied) => emitReload({ available: files.length > 0 && sig !== applied, files, sig }));
        break;
      }
      case 'done': {
        // A run may have edited the repo — re-check the working tree so the reload icon arms (spec §5).
        refreshReloadState();
        const r = m.result || {};
        // v2.74.985 — remember this run's session so the NEXT `dev:` continues it by default (the
        // bridge is a conversation; `dev: new` starts a fresh thread). Capture from the result, else the
        // init event the run streamed. This is also what makes resume-after-pause work.
        const sid = r.sessionId || run?.sessionId || null;
        // v2.74.1034 (DBR-2) — record the session on the OWNING dev conversation (per-conversation resume),
        // falling back to the legacy global key only when the run isn't bound to a conversation.
        if (sid && !run?.replay) {
          if (run?.conversationId) ConversationStore.patchMeta(run.conversationId, { sessionId: sid }).catch(() => { /* */ });
          else setLastSession(sid);
        }
        // DB-3 (v2.74.992, spec §7.1) — a user-initiated PAUSE arrives here as the host-lost `done` that
        // follows the kill. Frame it as paused (the Esc-analog: resume with a redirect), NOT an error.
        if (run?.pausing) {
          endRun({ kind: 'result', ok: true, text: sid
            ? '⏸ paused — session kept. `dev: <your redirect>` to resume with a correction, or `dev:` to continue as-is.'
            : '⏸ paused before a session id arrived — nothing to resume; start a fresh run.' });
          break;
        }
        const ok = r.subtype === 'success';
        const bits = [
          ok ? '✓ done' : `✗ ${r.subtype ?? 'ended'}`,
          r.numTurns != null ? `${r.numTurns} turns` : null,
          r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : null,
          r.costUsd != null ? `$${Number(r.costUsd).toFixed(2)}` : null,
        ].filter(Boolean).join(' · ');
        const resume = sid ? `\ncontinue in terminal: claude --resume ${sid}` : '';
        endRun({ kind: 'result', ok, text: `${bits}${resume}` });
        break;
      }
      case 'status': {
        // DB-3 (v2.74.999) — startup reattach probe answered. If a run is still alive (the host is now
        // re-tailing its journal) and this panel has no run of its own, build a bubble for the replay.
        if (m.active && !run) startReattach(`↻ reattaching to a run still in progress (pid ${m.pid ?? '?'})…`);
        break;
      }
      case 'history':   // DB-3 (v2.74.1000) — list of recent runs → clickable, replay-on-tap
        renderHistory(Array.isArray(m.runs) ? m.runs : []);
        break;
      case 'approval':  // DB-3 (v2.74.1002) — the run wants a non-safe tool → inline Allow/Deny
        // v2.74.1025 (DB-4) — an AskUserQuestion relay → interactive question card (pause-for-reply), not Allow/Deny.
        if (m.tool === 'AskUserQuestion') _emitQuestion(m); else _emitApproval(m);
        break;
      case 'error':
        endRun(`✗ bridge error: ${m.code}${m.message ? ` — ${m.message}` : ''}${m.code === 'busy' ? ' (one run at a time; "dev: pause" to stop it)' : ''}`);
        break;
      default: break;
    }
  }

  // Build the live run bubble + footer (spinner · ticking elapsed · Pause). Shared by a normal run and a
  // reattach (v2.74.999). The caller posts preflight/run (normal) or nothing (reattach — the host is
  // already re-tailing the journal and will stream events straight into this bubble).
  function _beginRunBubble(headline, { reattach = false } = {}) {
    _follow = true;       // v2.74.995 — a fresh run follows from the top; the user can scroll up to stop it
    _wireFollow();        // attach the one scroll listener (idempotent) now that the panel is up
    const { msg, bodyEl, blocks } = devBubble(headline);
    run = { msgEl: msg, msg, bodyEl, blocks, bar: null, sessionId: null, pendingPayload: null, tick: null, reattach };
    // v2.74.989 — run footer: an amber spinner + a ticking "working… Ns" label give a live "still going"
    // signal during the silent gaps between stream events (a long tool call, model thinking). Removed at
    // endRun. v2.74.992 — "Pause" (the Esc-analog): kills the process but keeps the session; run.pausing
    // tells the done handler to frame the resulting host-lost as a pause, not an error.
    const bar = document.createElement('div');
    bar.className = 'dev-run-bar';
    const spinner = document.createElement('span');
    spinner.className = 'dev-run-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const status = document.createElement('span');
    status.className = 'dev-run-status';
    const label = reattach ? 'reattached · working…' : 'working…';
    status.textContent = label;
    bar.appendChild(spinner);
    bar.appendChild(status);
    bar.appendChild(mkBtn('Pause', () => { if (run) run.pausing = true; try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'pause' }); } catch { /* */ } }));
    // v2.74.991 — append into .message-content (the vertical text column), NOT the message row.
    const _content = msg.querySelector('.message-content') || msg;
    _content.appendChild(bar);
    run.bar = bar;
    try { _anchor(); } catch { /* */ }   // v2.74.995 — pin the working…/Pause footer into view immediately
    const startedAt = Date.now();
    run.tick = setInterval(() => {
      const s = Math.round((Date.now() - startedAt) / 1000);
      status.textContent = `${reattach ? 'reattached · ' : ''}working… ${s}s`;
    }, 1000);
    return run;
  }

  function startRun(payload, headline, opts = {}) {
    const r = _beginRunBubble(headline);
    r.pendingPayload = payload;
    r.conversationId = opts.conversationId || null;   // v2.74.1034 (DBR-2) — bind the run to its dev conversation
    try {
      ensurePort().postMessage({ v: PROTOCOL_V, type: 'preflight' });   // run is posted on preflight-ok
    } catch (e) {
      endRun(`✗ could not reach the bridge host: ${e.message}. Run bridge/install.ps1, then reload.`);
    }
  }

  // DB-3 (v2.74.999) — reattach to a run still alive after a panel close / extension reload. The host's
  // status handler is already re-tailing the journal, so we just build a bubble for the replayed events
  // to land in. NOTE: best-effort — the claude child usually does NOT survive host death on Windows
  // (verified), so this fires only where survival holds; the robust path is the throttled mid-run persist
  // (a partial transcript on reopen) + `dev:` resume.
  function startReattach(headline) {
    _beginRunBubble(headline, { reattach: true });
  }

  // ── Run history (v2.74.1000, DB-3) ───────────────────────────────────────────────────────────────
  const _clock = (ts) => { try { return new Date(Number(ts)).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return ''; } };

  // Replay a past run read-only: a minimal bubble the host's `history-open` events render into. No footer/
  // spinner/Pause (the run is finished) and NOT persisted (a transient view; re-open via `dev: history`).
  function startReplay(headline) {
    _beginReplayBubble(headline);
  }
  function _beginReplayBubble(headline) {
    _follow = true; _wireFollow();
    const { msg, bodyEl, blocks } = devBubble(headline, { persist: false });
    run = { msgEl: msg, msg, bodyEl, blocks, bar: null, sessionId: null, pendingPayload: null, tick: null, replay: true };
  }

  // ── Permission relay (v2.74.1002, DB-3) ──────────────────────────────────────────────────────────
  // The host forwards a non-safe tool request as an `approval` frame; render an inline Allow/Deny card in
  // the active run bubble. The host writes the decision back to the hook, which is blocked polling for it.
  function _approvalSummary(tool, input) {
    input = input || {};
    if (tool === 'Bash') return input.command || '(no command)';
    const v = input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.command ?? '';
    return v ? String(v) : JSON.stringify(input).slice(0, 200);
  }
  function _emitApproval(m) {
    const hostEl = (run && run.bodyEl) || devBubble('', { persist: false }).bodyEl;
    if (!hostEl) return;
    const card = document.createElement('div');
    card.className = 'dev-approval';
    const q = document.createElement('div'); q.className = 'dev-approval-q';
    q.textContent = `Approve  ${m.tool || 'tool'} ?`;
    const detail = document.createElement('div'); detail.className = 'dev-approval-detail';
    detail.textContent = _approvalSummary(m.tool, m.input);
    const actions = document.createElement('div'); actions.className = 'dev-approval-actions';
    let decided = false;
    const decide = (decision) => {
      if (decided) return; decided = true;
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'approval-decision', id: m.id, decision }); } catch { /* */ }
      actions.remove();
      const verdict = document.createElement('span');
      verdict.className = `dev-approval-verdict ${decision}`;
      verdict.textContent = decision === 'allow' ? '✓ allowed' : '✗ denied';
      card.appendChild(verdict);
    };
    actions.appendChild(mkBtn('Allow', () => decide('allow')));
    actions.appendChild(mkBtn('Deny', () => decide('deny')));
    card.appendChild(q); card.appendChild(detail); card.appendChild(actions);
    hostEl.appendChild(card);
    try { _anchor(); } catch { /* */ }
  }

  // v2.74.1025 (DB-4) — interactive QUESTION card. The PreToolUse hook relayed an AskUserQuestion and is
  // BLOCKING; render each question with option buttons, collect the user's pick(s), then send the answer
  // back as an `approval-decision` whose `reason` carries the answer — the hook returns it to Claude (as a
  // deny reason) and the PAUSED run continues. All text via textContent (trust rule §5 — never HTML).
  function _emitQuestion(m) {
    const hostEl = (run && run.bodyEl) || devBubble('', { persist: false }).bodyEl;
    if (!hostEl) return;
    const questions = Array.isArray(m.input?.questions) ? m.input.questions : [];
    const card = document.createElement('div');
    card.className = 'dev-approval dev-question';
    const head = document.createElement('div'); head.className = 'dev-approval-q'; head.textContent = '❓ Claude is asking:';
    card.appendChild(head);
    // selections[i] = Set of chosen labels for question i
    const selections = questions.map(() => new Set());
    let sent = false;
    const submit = () => {
      if (sent) return;
      if (selections.some((s) => s.size === 0)) return;   // every question needs an answer
      sent = true;
      const summary = questions.map((q, i) => `${String(q.header || q.question || `Q${i + 1}`).trim()}: ${[...selections[i]].join(', ')}`).join(' · ');
      const reason = `[dev-bridge] The user answered in the panel — ${summary}. Use these answers and continue; do NOT call AskUserQuestion again for them.`;
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'approval-decision', id: m.id, decision: 'deny', reason }); } catch { /* */ }
      card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const verdict = document.createElement('div'); verdict.className = 'dev-approval-verdict allow';
      verdict.textContent = `✓ answered — ${summary}`;
      card.appendChild(verdict);
      try { _anchor(); } catch { /* */ }
    };
    questions.forEach((q, i) => {
      const block = document.createElement('div'); block.className = 'dev-question-block';
      const qt = document.createElement('div'); qt.className = 'dev-approval-detail';
      qt.textContent = String(q.question || q.header || '').trim();
      block.appendChild(qt);
      const opts = document.createElement('div'); opts.className = 'dev-approval-actions';
      const btns = [];
      (Array.isArray(q.options) ? q.options : []).forEach((o) => {
        const label = String(o.label ?? '').trim();
        if (!label) return;
        const b = mkBtn(o.description ? `${label} — ${_short(String(o.description), 60)}` : label, () => {
          if (sent) return;
          if (q.multiSelect) {
            if (selections[i].has(label)) { selections[i].delete(label); b.classList.remove('sel'); }
            else { selections[i].add(label); b.classList.add('sel'); }
          } else {
            selections[i].clear(); selections[i].add(label);
            btns.forEach((x) => x.classList.remove('sel')); b.classList.add('sel');
            // single question + single-select → one click answers (Claude-chat feel)
            if (questions.length === 1) { submit(); return; }
          }
        });
        b.dataset.label = label; btns.push(b); opts.appendChild(b);
      });
      block.appendChild(opts); card.appendChild(block);
    });
    // Submit button for multi-select / multi-question cases (single-select single-question auto-submits above).
    if (!(questions.length === 1 && !questions[0]?.multiSelect)) {
      const actions = document.createElement('div'); actions.className = 'dev-approval-actions';
      actions.appendChild(mkBtn('Send answer ▸', submit));
      card.appendChild(actions);
    }
    hostEl.appendChild(card);
    try { _anchor(); } catch { /* */ }
  }

  // Render the `history` reply: a clickable list of recent runs; a row replays that journal read-only.
  function renderHistory(runs) {
    const msg = appendMessage({ role: 'assistant', body: '' });
    const bodyEl = msg.querySelector('.message-body');
    if (bodyEl) bodyEl.textContent = '';
    if (decorateBubble) decorateBubble(msg, { collapsed: false });
    else { try { msg.style.borderLeft = '3px solid #c9a227'; msg.dataset.devBridge = '1'; } catch { /* */ } }
    const wrap = document.createElement('div');
    wrap.className = 'dev-history';
    const head = document.createElement('div');
    head.className = 'dev-history-head';
    head.textContent = runs.length ? `Recent runs (${runs.length}) — tap to replay` : 'No runs recorded yet.';
    wrap.appendChild(head);
    for (const r of runs) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'dev-history-row';
      const stateCls = r.subtype === 'success' ? 'ok' : (r.subtype === 'incomplete' ? 'warn' : 'err');
      const v = document.createElement('span'); v.className = 'dev-history-verb'; v.textContent = r.verb || '?';
      const p = document.createElement('span'); p.className = 'dev-history-prev'; p.textContent = r.promptPreview || '(no preview)';
      const meta = document.createElement('span'); meta.className = `dev-history-meta ${stateCls}`;
      meta.textContent = [_clock(r.startedAt), r.numTurns != null ? `${r.numTurns}t` : '', r.costUsd != null ? `$${Number(r.costUsd).toFixed(2)}` : '', r.subtype].filter(Boolean).join(' · ');
      row.appendChild(v); row.appendChild(p); row.appendChild(meta);
      row.addEventListener('click', () => {
        if (run) { devBubble('a run is live — `dev: pause` it first.'); return; }
        startReplay(`↩ replaying ${r.verb || 'run'} · ${_short(r.promptPreview || r.journal, 60)}`);
        try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'history-open', journal: r.journal }); }
        catch { endRun('✗ could not reach the host to replay this run.'); }
      });
      wrap.appendChild(row);
    }
    bodyEl?.appendChild(wrap);
    try { _anchor(); } catch { /* */ }
  }

  // v2.74.1022 — the session's log entries (since logger:sessionStart), shared by the full + decisions builders.
  async function _sessionEntries() {
    let entries = [];
    try {
      const res = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_LOGS' }, (r) => { void chrome.runtime.lastError; resolve(r); }));
      entries = Array.isArray(res?.entries) ? res.entries : [];
    } catch { /* */ }
    try {
      const sess = await chrome.storage.local.get('logger:sessionStart');
      const start = sess?.['logger:sessionStart'];
      if (start) entries = entries.filter((e) => (e.timestamp ?? '') >= start);
    } catch { /* */ }
    return entries;
  }

  // v2.74.1022 — `gl` ships the FULL trace (was decisions-only pre-.1022, mismatching the terminal `gl`).
  async function buildFullTraceAttachment() {
    const entries = await _sessionEntries();
    if (!entries.length) return null;
    return { kind: 'full-trace', filename: `orchard-logs-${_stamp()}.txt`, content: entries.map(_fmtEntry).join('\n') };
  }

  async function buildDecisionsAttachment() {
    const entries = await _sessionEntries();
    const decisions = entries.filter((e) => DECISION_RE.test(String(e.message ?? '')));
    if (!decisions.length) return null;
    return { kind: 'decisions-trace', filename: `orchard-logs-decisions-${_stamp()}.txt`, content: decisions.map(_fmtEntry).join('\n') };
  }

  // v2.74.1022 — `gch` ships the chat transcript: non-dev conversations since the SHARED boundary
  // (settings:lastChatExport — same key the Studio grab uses), oldest→newest, advancing the boundary so
  // the next grab (bridge OR manual) doesn't re-ship them. Dev-bridge chats excluded whole.
  async function buildChatsAttachment() {
    const KEY = 'settings:lastChatExport';
    let summaries = [];
    try { summaries = await ConversationStore.list(); } catch { return null; }
    if (!summaries.length) return null;
    const now = Date.now();
    let since = 0;
    try { const s = await chrome.storage.local.get(KEY); since = s?.[KEY] ?? 0; } catch { /* */ }
    // v2.74.1029 — a `kind:'dev'` conversation is excluded WHOLE (its messages are Claude Code, not user
    // chat) — same intent as the per-message devBridge filter below, but catches an empty/user-only dev thread.
    const candidates = summaries.filter((s) => (s.updatedAt ?? 0) > since && s.kind !== 'dev').sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
    if (!candidates.length) return null;
    const convs = [];
    for (const s of candidates) {
      let conv = null;
      try { conv = await ConversationStore.load(s.id); } catch { /* */ }
      if (!conv) continue;
      if ((conv.messages ?? []).some((m) => m.devBridge)) continue;   // dev chats excluded whole
      convs.push(conv);
    }
    try { await chrome.storage.local.set({ [KEY]: now }); } catch { /* */ }   // advance boundary regardless of dev-filtering
    if (!convs.length) return null;
    return { kind: 'chats', filename: `orchard-chats-${_stamp()}.txt`, content: convs.map(_fmtConv).join(`\n${'─'.repeat(60)}\n\n`) };
  }

  /**
   * The chat send-path hook. Returns true when the text was a bridge verb (handled here, never routed).
   * MUST be called synchronously from the send gesture for `dev: on` (the permission request needs it).
   */
  async function maybeHandle(text, opts = {}) {
    // v2.74.1029 — `devConversation`: the caller is a DEV conversation (the conversations-menu surface that
    // replaces the `dev:` prefix). `skipEcho`: the panel already rendered the user's bubble with the original
    // text, so don't echo it again here. Both default off → every existing call site behaves exactly as before.
    const devConv = opts.devConversation === true;
    const skipEcho = opts.skipEcho === true;
    const convId = opts.conversationId || null;   // v2.74.1034 (DBR-2) — the dev conversation this run belongs to
    let t = String(text ?? '').trim();
    // DBR-4 (v2.74.1036, DESIGN §4) — `lt` live-test. Dev-conversation only, WHOLE-message match, intercepted
    // HERE — before the bare-text→`dev:` normalization below — so it never gets rewritten to `dev: lt` and
    // forwarded to Claude. Switches the loaded tree to this conversation's branch and reloads the extension.
    if (devConv && (isLiveTest(t) || isLiveTestForce(t))) {
      if (!skipEcho) appendMessage({ role: 'user', body: t });
      await _liveTest(convId, { force: isLiveTestForce(t) });   // v2.74.1043 — `lt!`/`lt force` skips the behind-main warning
      return true;
    }
    // Inside a dev conversation, bare input IS a dev command: a standalone log verb (gl/gc/gch) or a
    // `bug:`/`dev:` prefix is taken verbatim; anything else (a sub-verb like `pause`/`history`/`model …`, or
    // a plain task) is normalized to the `dev: …` form so the existing branch table handles it unchanged —
    // the user never types `dev:`.
    if (devConv && t) {
      const head = t.toLowerCase();
      const standalone = head === 'gl' || head === 'gc' || head === 'gch' || /^bug:/i.test(t) || /^dev:/i.test(t);
      if (!standalone) t = `dev: ${t}`;
    }
    const echoUser = () => { if (!skipEcho) appendMessage({ role: 'user', body: t }); };
    const isDevVerb = /^dev:/i.test(t);
    const lower = t.toLowerCase().replace(/\s+/g, ' ');

    if (lower === 'dev: on' || lower === 'dev:on') {
      // Permission request FIRST — before any await — while the user-gesture token is live (§11).
      let granted = false;
      try { granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] }); } catch { granted = false; }
      echoUser();
      if (!granted) { devBubble('✗ nativeMessaging permission declined — the bridge stays off.'); return true; }
      await setEnabled(true);
      emitReload({ enabled: true });   // reveal the header reload icon
      refreshReloadState();            // and arm it if the tree is already dirty
      devBubble('✓ dev bridge ON — `gl` (full trace), `gc` (decisions), `gch` (chats), `bug: <what broke>` and `dev: <ask>` now route to Claude Code on this repo.\nIf the host isn’t installed yet: run bridge/install.ps1 once, then reload the extension.');
      return true;
    }
    if (lower === 'dev: off' || lower === 'dev:off') {
      echoUser();
      await setEnabled(false);
      disconnect();
      emitReload({ enabled: false, available: false, files: [] });   // hide the header reload icon
      devBubble('dev bridge OFF.');
      return true;
    }

    const enabled = await getEnabled();
    if (!enabled) {
      // v2.74.1029 — a dev conversation whose bridge got turned off (e.g. via `dev: off`) re-enables by
      // starting a fresh dev conversation (the permission request needs that click gesture).
      if (isDevVerb || devConv) { echoUser(); devBubble('dev bridge is off — open the conversations menu and start a new dev conversation to re-enable it.'); return true; }
      return false;   // 'gl' (or anything else) falls through to the normal pipeline when the bridge is off
    }

    // DB-3 (v2.74.992, spec §7.1) — `dev: pause` (and the kept `dev: cancel` alias): the Esc-analog.
    // Kills the process but keeps the session; the done handler then frames it as paused and the next
    // `dev: <redirect>` resumes it with a correction (resume-with-redirect — already the default for any
    // `dev:` since .985). Marking run.pausing distinguishes this from an unexpected host-lost.
    if (lower === 'dev: pause' || lower === 'dev: cancel') {
      echoUser();
      if (run) run.pausing = true;
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'pause' }); } catch { /* */ }
      if (!run) devBubble('nothing is running to pause.');
      return true;
    }

    // DB-3 (v2.74.1000) — `dev: history` (alias `dev: runs`): list recent runs; tap one to replay it
    // read-only. The host reads the journals in logs/bridge/; the reply renders via the `history` case.
    if (lower === 'dev: history' || lower === 'dev: runs') {
      echoUser();
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'history' }); } catch { devBubble('✗ could not reach the bridge host.'); }
      return true;
    }

    // DB-3 (v2.74.1002) — `dev: relay` shows the state; `dev: relay on|off` toggles the permission relay.
    // ON → each run gates non-safe tools through an inline Allow/Deny in the panel (a PreToolUse hook);
    // OFF → the static DB-2 allowlist (safe tools only; anything else auto-denied). Safe tier auto-allows
    // either way. Takes effect on the next run.
    if (lower === 'dev: relay' || /^dev: relay /.test(lower)) {
      echoUser();
      const arg = lower === 'dev: relay' ? '' : lower.slice('dev: relay '.length).trim();
      if (!arg) { devBubble(`permission relay: ${(await getRelay()) ? 'ON — non-safe tools prompt for Allow/Deny' : 'OFF — non-safe tools auto-denied (DB-2 allowlist)'}.\ntoggle with \`dev: relay on|off\`.`); return true; }
      if (arg !== 'on' && arg !== 'off') { devBubble('usage: `dev: relay on` or `dev: relay off`.'); return true; }
      await setRelay(arg === 'on');
      devBubble(`permission relay → ${arg.toUpperCase()}. Takes effect on the next run.${arg === 'on' ? ' Non-safe tools (git, network, plain shell…) will ask you inline.' : ''}`);
      return true;
    }

    // v2.74.976 — `dev: model` shows the current pick; `dev: model <alias>` sets it (next run uses it).
    if (lower === 'dev: model' || /^dev: model /.test(lower)) {
      echoUser();
      const arg = lower === 'dev: model' ? '' : lower.slice('dev: model '.length).trim();
      const cur = await getModel();
      if (!arg) { devBubble(`bridge model: ${cur}\nchange with \`dev: model <${MODEL_ALIASES.join('|')}>\` (default = your Claude Code setting).`); return true; }
      if (!MODEL_ALIASES.includes(arg)) { devBubble(`unknown model "${arg}" — choose one of: ${MODEL_ALIASES.join(', ')}.`); return true; }
      await setModel(arg);
      devBubble(`bridge model → ${arg}${arg === 'default' ? ' (your Claude Code default)' : ''}. Takes effect on the next \`gl\` / \`dev:\` run.`);
      return true;
    }

    // v2.74.978 — `dev: turns` shows the budget; `dev: turns <n>` sets it (any positive integer, no cap).
    if (lower === 'dev: turns' || /^dev: turns /.test(lower)) {
      echoUser();
      const arg = lower === 'dev: turns' ? '' : lower.slice('dev: turns '.length).trim();
      const cur = await getTurns();
      if (!arg) { devBubble(`bridge turn budget: ${cur} (the runaway cap). Set with \`dev: turns <n>\` — ~25 for a fix, ~50 for a feature, higher for a big task.`); return true; }
      const n = Math.floor(Number(arg));
      if (!Number.isFinite(n) || n < 1) { devBubble('turns must be a positive whole number.'); return true; }
      await setTurns(n);
      devBubble(`bridge turn budget → ${n}. Takes effect on the next run.`);
      return true;
    }

    // DBR-5 (v2.74.1037, DESIGN §8.2) — `dev: concern` shows this conversation's scope; `dev: concern <text>`
    // edits it. The concern defaults to the first ask (captured on dispatch); editing it changes the scope
    // contract the host re-injects on the NEXT spawn. (DBR-6 surfaces the same edit in the header.)
    if (lower === 'dev: concern' || /^dev: concern /.test(lower)) {
      echoUser();
      const arg = t.replace(/^dev:\s*concern\b/i, '').trim();   // from the ORIGINAL-case text — concerns are prose
      if (!convId) { devBubble('the concern is per dev conversation — open a dev conversation to set one.'); return true; }
      if (!arg) {
        const cur = await _ensureConcern(convId, null);
        devBubble(cur ? `scope (concern): ${cur}\nedit with \`dev: concern <new scope>\` — applies to the next run.` : 'no concern set yet — it defaults to your first task here. Set one now with `dev: concern <scope>`.');
        return true;
      }
      const concern = _conciseConcern(arg);
      await ConversationStore.patchMeta(convId, { concern }).catch(() => { /* */ });
      devBubble(`scope (concern) → ${concern}. Applies to the next run.`);
      return true;
    }

    // v2.74.1022 — gl (FULL trace), gc (decisions), gch (chats) — each ships the matching attachment to
    // Claude Code over native messaging (no manual Download). The host writes it into logs/run/ and the
    // run's prompt is the bare shorthand; the repo's standing convention does the analysis.
    if (lower === 'gl' || lower === 'gc' || lower === 'gch') {
      echoUser();
      if (run) { devBubble('a bridge run is already live — `dev: pause` to stop it.'); return true; }
      const att = lower === 'gl' ? await buildFullTraceAttachment()
                : lower === 'gc' ? await buildDecisionsAttachment()
                : await buildChatsAttachment();
      const model = await getModel();
      const maxTurns = await getTurns();
      const nothing = lower === 'gch' ? 'no new chat activity this session' : lower === 'gc' ? 'no decision lines this session' : 'no log lines this session';
      startRun(
        { v: PROTOCOL_V, type: 'run', verb: lower, attachments: att ? [att] : [], model, maxTurns, relay: await getRelay() },
        att ? `${lower} · shipping ${att.filename} + analyzing…` : `${lower} · ${nothing} — analyzing the newest already in logs/run/…`,
        { conversationId: convId },
      );
      return true;
    }

    // DB-2 (v2.74.988) — `bug: <what broke>`: the fix path. Ships the newest decisions trace (same
    // attachment `gl` builds) plus the user's report; the host composes report + trace pointer + version
    // line, and the DB-2 allowlist lets the run verify itself with `npm test`. Never commits (no git).
    // A fresh report each time → no resume; the run's session is still recorded (done handler) so a
    // follow-up `dev: <reply>` continues the same fix thread.
    if (/^bug:/i.test(t)) {
      echoUser();
      const report = t.slice(t.indexOf(':') + 1).trim();
      if (!report) { devBubble('usage: `bug: <what broke / what you saw>` — ships the newest trace + your report to a verified fix run.'); return true; }
      if (run) { devBubble('a bridge run is already live — `dev: pause` to stop it.'); return true; }
      const att = await buildDecisionsAttachment();
      const model = await getModel();
      const maxTurns = await getTurns();
      const bugPayload = { v: PROTOCOL_V, type: 'run', verb: 'bug', text: report, attachments: att ? [att] : [], model, maxTurns, relay: await getRelay() };
      // DBR-5 (DESIGN §8.2) — a bug run codes against the branch too, so it carries the same scope contract;
      // if this is the conversation's first task, the report seeds the concern.
      const bugConcern = await _ensureConcern(convId, report);
      if (bugConcern) bugPayload.concern = bugConcern;
      startRun(
        bugPayload,
        att ? `bug · ${_short(report, 56)} (+ ${att.filename})` : `bug · ${_short(report, 70)}`,
        { conversationId: convId },
      );
      return true;
    }

    // v2.74.985 — `dev: reset` drops the conversation thread (next `dev:` starts fresh), no run.
    if (lower === 'dev: reset') {
      echoUser();
      await clearLastSession();
      devBubble('thread cleared — the next `dev:` starts a fresh conversation.');
      return true;
    }

    if (isDevVerb) {
      // v2.74.985 — `dev: new <task>` forces a FRESH session (a new, unrelated direction); plain
      // `dev: <reply>` CONTINUES the prior session by default — the bridge is a conversation. (Other
      // `dev: <sub>` verbs were matched above, so only a real ask reaches here.)
      const rest = t.slice(t.indexOf(':') + 1).trim();
      const isNew = /^new\b/i.test(rest);
      const ask = isNew ? rest.replace(/^new\b[:\s]*/i, '').trim() : rest;
      echoUser();
      if (!ask) { devBubble('usage: `dev: <reply>` (continues / resumes the thread) · `dev: new <task>` (fresh) · `gl` (full trace) · `gc` (decisions) · `gch` (chats) · `bug: <what broke>` · `dev: pause` (stop, keep session) · `dev: history` (recent runs) · `dev: relay on|off` (inline approvals) · `dev: concern [<scope>]` (show/edit scope) · `dev: model|turns <…>` · `dev: reset` · `dev: off`'); return true; }
      if (run) { devBubble('a bridge run is already live — `dev: pause` to stop it.'); return true; }
      const model = await getModel();
      const maxTurns = await getTurns();
      // v2.74.1034 (DBR-2) — resume THIS dev conversation's session (per-conversation), not the global key.
      let resumeSessionId = null;
      if (!isNew) resumeSessionId = convId ? await _convResume(convId) : await getLastSession();
      if (isNew) { if (convId) await ConversationStore.patchMeta(convId, { sessionId: null }).catch(() => { /* */ }); else await clearLastSession(); }
      const payload = { v: PROTOCOL_V, type: 'run', verb: 'dev', text: ask, model, maxTurns, relay: await getRelay() };
      if (resumeSessionId) payload.resumeSessionId = resumeSessionId;
      // DBR-5 (DESIGN §8.2) — capture the concern from the first ask, then carry it so the host re-injects the
      // scope contract on this spawn (fresh AND resume). The concern is per-conversation/branch, so `dev: new`
      // (a fresh SESSION on the same branch) keeps it; it's only seeded if none exists yet.
      const concern = await _ensureConcern(convId, ask);
      if (concern) payload.concern = concern;
      startRun(payload, `dev${resumeSessionId ? ' (continuing)' : isNew ? ' (new thread)' : ''} · ${_short(ask, 80)}`, { conversationId: convId });
      return true;
    }

    return false;
  }

  // DB-2 — ask the host for the working-tree diffstat; the `diffstat` reply (onHostMsg) updates the icon.
  // No-op when the bridge is off, or when the host is unreachable (not installed) — the icon just stays
  // un-armed; a started run is unaffected since diffstat is a standalone host verb.
  async function refreshReloadState() {
    if (!(await getEnabled())) return;
    try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'diffstat' }); } catch { /* host not reachable */ }
  }

  // DB-3 (v2.74.999) — on startup, ask the host whether a run is still alive so the panel can reattach
  // (status active:true → the host re-tails its journal → the `status` handler builds a replay bubble).
  // No-op when off / host unreachable. Best-effort: see startReattach — the child usually dies with the host.
  async function _probeActiveRun() {
    if (!(await getEnabled())) return;
    try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'status' }); } catch { /* host not reachable */ }
  }

  // chat.js calls this once at startup: register the icon's state listener, then push current state
  // (visibility from the persisted setting) and arm the dot if the tree is already dirty.
  async function onReloadState(fn) {
    reloadListener = typeof fn === 'function' ? fn : null;
    const enabled = await getEnabled();
    emitReload({ enabled });
    if (enabled) { refreshReloadState(); _probeActiveRun(); }
  }

  // The reload action itself — restarts the WHOLE extension (the spec's "Apply & Reload"), which closes
  // the panel; the user reopens via the toolbar icon. Committing stays human (terminal `cp`/`bcp`).
  // v2.74.980 — stamp the current tree signature as the applied baseline BEFORE reloading (await, so it's
  // durably persisted before the process restarts). After the reload, the post-reload diffstat matches
  // this baseline and the dot clears; the next edit changes the signature and re-arms it.
  async function reloadExtension() {
    try { await setAppliedSig(reloadState.sig || ''); } catch { /* */ }
    try { chrome.runtime.reload(); } catch { /* */ }
  }

  // DBR-4 (v2.74.1036, DESIGN §4) — replace a devBubble's body with a single text block (the lt status line is
  // optimistic; on failure we rewrite it in place). Mirrors devBubble's render + persist so the message reads
  // the same after the swap.
  function _setBubble(b, text) {
    try {
      if (!b || !b.bodyEl) return;
      b.bodyEl.textContent = '';
      const block = { kind: 'text', text };
      b.blocks.length = 0; b.blocks.push(block);
      b.bodyEl.appendChild(_blockNode(block));
      _persistBlocks(b.msg, b.blocks);
    } catch { /* a render throw must not break the flow */ }
  }

  // DBR-4 (v2.74.1036, DESIGN §4) — the `lt` flow: WIP-commit the CURRENT branch (so the tree is clean for the
  // switch) → host `git switch` the loaded folder to THIS dev conversation's branch → reload the extension,
  // which re-reads the now-swapped files. All git is host-side, parameter-validated (§3); the panel only relays
  // via gitOp. Phase 1 is single-tree + serial — no worktree/preview yet (those are Phase 4). The reload CLOSES
  // the panel (reopen via the toolbar icon to see the branch live), so this is the last thing the flow does.
  async function _liveTest(convId, opts = {}) {
    const force = opts.force === true;
    let branch = null;
    try { branch = convId ? ((await ConversationStore.load(convId)) || {}).branch || null : null; } catch { branch = null; }
    if (!branch) { devBubble('✗ `lt` — no branch is recorded for this dev conversation, so there’s nothing to live-test.'); return; }
    // v2.74.1043 (DESIGN §4 guardrail) — single-tree `lt` does a full reload onto the branch, so a branch BEHIND
    // main reverts the WHOLE panel to that older code: you silently lose newer panel features (e.g. the DBR-5/DBR-6
    // concern + dev header). Warn + refuse by default; `lt!`/`lt force` overrides. Uses the same read-only
    // `aheadBehind` op the DBR-6 header uses (`git rev-list --left-right --count main...<branch>` → "<behind>\t<ahead>",
    // so parts[0] is how far the branch is BEHIND main). Fails OPEN: a host that's unreachable or an unparseable
    // answer must NOT block `lt` — only a confidently-positive behind count refuses.
    if (!force) {
      let behind = 0;
      try {
        const ab = await gitOp('aheadBehind', { a: 'main', b: branch });
        if (ab && ab.ok && typeof ab.stdout === 'string') behind = Number(ab.stdout.trim().split(/\s+/)[0]) || 0;
      } catch { behind = 0; }
      if (behind > 0) {
        devBubble(`⚠ \`lt\` — \`${branch}\` is ${behind} commit${behind === 1 ? '' : 's'} behind \`main\`. Switching reloads the **whole** extension onto that older code, so newer panel features (e.g. the dev header / concern) will disappear until you switch back. Type \`lt!\` to switch anyway, or bring the branch up to date with \`main\` first (Phase 2 \`sync\`).`);
        return;
      }
    }
    const bubble = devBubble(`↻ switching to \`${branch}\` and reloading…`);
    // 1) checkpoint the CURRENT branch so `git switch` has a clean tree — but only when we're ON a dev branch.
    // The host commit-guard refuses to commit on main (correct — never commit to main), so on a non-dev branch
    // commitWip returns "not on a dev branch". That is NOT fatal (v2.74.1040 fix — the old code aborted on it, so
    // `lt` could never bootstrap from main): we never checkpoint main; instead switch directly when the tree is
    // clean, and refuse with a clear next step when it's dirty (don't carry uncommitted work across the switch).
    const wip = await gitOp('commitWip', { message: `lt → ${branch}` });
    const guardBlocked = wip && !wip.ok && /not on a dev branch/i.test(String(wip.error || ''));
    if ((!wip || !wip.ok) && !guardBlocked) { _setBubble(bubble, `✗ \`lt\` — couldn’t checkpoint the current branch: ${(wip && wip.error) || 'host unreachable'}. Not switching.`); return; }
    if (guardBlocked) {
      let dirty = false;
      try { const st = await gitOp('status'); dirty = !!(st && st.ok && (st.dirty === true || (typeof st.porcelain === 'string' && st.porcelain.trim()) || (Array.isArray(st.changed) && st.changed.length) || (typeof st.changed === 'number' && st.changed > 0))); } catch { dirty = false; }
      if (dirty) { _setBubble(bubble, `✗ \`lt\` — the loaded tree is on a non-dev branch (e.g. main) with uncommitted changes, so it can’t live-test \`${branch}\` cleanly. Commit or stash your changes first (the bridge never commits to main), then \`lt\`.`); return; }
      // clean non-dev branch → no checkpoint needed; fall through to the switch.
    }
    // 2) switch the loaded folder to this conversation's branch (lt:true → the host logs the LT ▸ decision marker).
    const sw = await gitOp('switch', { branch, lt: true });
    if (!sw || !sw.ok) { _setBubble(bubble, `✗ \`lt\` — couldn’t switch to \`${branch}\`: ${(sw && sw.error) || 'host unreachable'}.`); return; }
    // 3) reload so Chrome re-reads the swapped files (stamps the applied baseline first, then restarts).
    await reloadExtension();
  }

  // v2.74.1029 — enable the bridge for a NEW dev conversation. The conversations-menu "New dev conversation"
  // button calls this FIRST in its click handler (before any other await) so the nativeMessaging permission
  // request stays gesture-bound — exactly as `dev: on` did (§11/§12). Returns whether the permission was
  // granted; on grant it flips the setting and reveals/arms the reload icon. This is the ONLY enable path now
  // (the `dev: on` verb is unreachable from a normal conversation — the bridge is dev-conversation-only).
  async function enable() {
    let granted = false;
    try { granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] }); } catch { granted = false; }
    if (!granted) return false;
    await setEnabled(true);
    emitReload({ enabled: true });   // reveal the header reload icon
    refreshReloadState();            // and arm it if the tree is already dirty
    return true;
  }

  return { maybeHandle, enable, gitOp, onReloadState, refreshReloadState, reloadExtension };
}
