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

const PROTOCOL_V = 1;
const HOST_NAME = 'com.orchard.devbridge';
const SETTING_KEY = 'settings:devBridge';
const MODEL_SETTING_KEY = 'settings:devBridgeModel';   // v2.74.976 — which model the bridge's claude runs as
const MODEL_ALIASES = ['default', 'fable', 'opus', 'sonnet', 'haiku'];   // MUST stay ⊆ the host's ALLOWED_MODELS table
const TURNS_SETTING_KEY = 'settings:devBridgeTurns';   // v2.74.978 — per-run --max-turns budget (the runaway guard)
const TURNS_DEFAULT = 25;   // v2.74.979 — the value when unset; NO artificial ceiling/floor (the host only checks it's a positive int)
const APPLIED_SIG_KEY = 'settings:devBridgeAppliedSig';   // v2.74.980 — the working-tree signature as of the last reload (the "applied" baseline)
const LAST_SESSION_KEY = 'settings:devBridgeLastSession';   // v2.74.985 — the prior run's claude session id; `dev:` resumes it (conversation by default)

// The decisions filter — VERBATIM from studio.js _DECISION_RE (the source of truth; keep in sync until
// a shared extraction). Filters the session's log entries down to the signal-only story view that the
// gl convention prefers.
const DECISION_RE = /(▶ RUN |[✓✗] RUN |COMPREHEND_CROSS_GROUND ▸|T3X resolve ▸|T3X bind ▸|_bind ▸|GROUNDS ▸|ROUTE ▸|HANDOFF ▸|postcond ▸|ORCH_MATCH ▸|ORCH_MATCH_GLOBAL ▸|DETECT_DUPLICATE_GROUNDS ▸|MERGE_GROUNDS ▸|mergeGround |Ground saved:|Ground deleted:|→ (?:auto|propose|miss)\/|RUN_OBSERVATION|RUN_BEST_OBSERVATION|ORCH_RECORD_ALIAS|ORCH_ADMIN ▸|REPLAY_SG_CAPABILITY —|— bindings:|CLICK caused navigation|WALK ▸|LOOP ▸|ORCH_PLAN ▸|OPEN_URL_NEW_TAB —|REVERIFY_SG_CAPABILITY —|ROUTE_ASK "|bindClauseParams →|locale-fresh-skip|locale-trust:|EXPLORE_PAGE_STRUCTURE done|RUN_SG_TRIAL|INTERACTION_MONITOR_START|INTENT_MENU ▸|RICH_INTENTS ▸|ACCEPT_SG_TRIAL|INTERACTION_OUTCOMES ▸|proposeRichIntents —|ensureGroundForUrl|EXPLORE ▸|STOP ▸)/;

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

function _short(s, n = 60) { const t = String(s ?? ''); return t.length > n ? `…${t.slice(-(n - 1))}` : t; }

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
  // v2.74.985 — the last run's session id, so `dev:` CONTINUES the conversation by default. Persisted so
  // it survives a panel close. `dev: new` / `dev: reset` clear it to start a fresh thread.
  const getLastSession = async () => {
    try { const v = (await chrome.storage.local.get(LAST_SESSION_KEY))[LAST_SESSION_KEY]; return /^[0-9a-f-]{36}$/i.test(v) ? v : null; } catch { return null; }
  };
  const setLastSession = async (s) => { try { await chrome.storage.local.set({ [LAST_SESSION_KEY]: String(s ?? '') }); } catch { /* */ } };
  const clearLastSession = async () => { try { await chrome.storage.local.remove(LAST_SESSION_KEY); } catch { /* */ } };
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

  function _persistBlocks(msg, blocks) {
    if (!persistMessage) return;
    try { persistMessage(msg, { role: 'assistant', body: _blocksToMarkdown(blocks), markdown: true, devBridge: true })?.catch?.(() => { /* */ }); } catch { /* */ }
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
      _persistBlocks(run.msg, run.blocks);
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
    if (!run.replay) _persistBlocks(run.msg, run.blocks);   // v2.74.987/.993 — capture terminal blocks (replay views are transient)
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
      if (run) {
        endRun(/not found|forbidden/i.test(err)
          ? `✗ bridge host not reachable (${err}). Run bridge/install.ps1 once, then reload the extension.`
          : `✗ bridge port closed${err ? ` — ${err}` : ''} (a started run continues detached; journal in logs/bridge/).`);
      }
    });
    return port;
  }

  function onHostMsg(m) {
    if (!m || m.v !== PROTOCOL_V) return;
    switch (m.type) {
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
        if (sid && !run?.replay) setLastSession(sid);   // v2.74.1000 — viewing history must not change the resume target
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

  function startRun(payload, headline) {
    const r = _beginRunBubble(headline);
    r.pendingPayload = payload;
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

  async function buildDecisionsAttachment() {
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
    const decisions = entries.filter((e) => DECISION_RE.test(String(e.message ?? '')));
    if (!decisions.length) return null;
    return { kind: 'decisions-trace', filename: `orchard-logs-decisions-${_stamp()}.txt`, content: decisions.map(_fmtEntry).join('\n') };
  }

  /**
   * The chat send-path hook. Returns true when the text was a bridge verb (handled here, never routed).
   * MUST be called synchronously from the send gesture for `dev: on` (the permission request needs it).
   */
  async function maybeHandle(text) {
    const t = String(text ?? '').trim();
    const isDevVerb = /^dev:/i.test(t);
    const lower = t.toLowerCase().replace(/\s+/g, ' ');

    if (lower === 'dev: on' || lower === 'dev:on') {
      // Permission request FIRST — before any await — while the user-gesture token is live (§11).
      let granted = false;
      try { granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] }); } catch { granted = false; }
      appendMessage({ role: 'user', body: t });
      if (!granted) { devBubble('✗ nativeMessaging permission declined — the bridge stays off.'); return true; }
      await setEnabled(true);
      emitReload({ enabled: true });   // reveal the header reload icon
      refreshReloadState();            // and arm it if the tree is already dirty
      devBubble('✓ dev bridge ON — `gl`, `bug: <what broke>` and `dev: <ask>` now route to Claude Code on this repo.\nIf the host isn’t installed yet: run bridge/install.ps1 once, then reload the extension.');
      return true;
    }
    if (lower === 'dev: off' || lower === 'dev:off') {
      appendMessage({ role: 'user', body: t });
      await setEnabled(false);
      disconnect();
      emitReload({ enabled: false, available: false, files: [] });   // hide the header reload icon
      devBubble('dev bridge OFF.');
      return true;
    }

    const enabled = await getEnabled();
    if (!enabled) {
      if (isDevVerb) { appendMessage({ role: 'user', body: t }); devBubble('dev bridge is off — type `dev: on` to enable it.'); return true; }
      return false;   // 'gl' (or anything else) falls through to the normal pipeline when the bridge is off
    }

    // DB-3 (v2.74.992, spec §7.1) — `dev: pause` (and the kept `dev: cancel` alias): the Esc-analog.
    // Kills the process but keeps the session; the done handler then frames it as paused and the next
    // `dev: <redirect>` resumes it with a correction (resume-with-redirect — already the default for any
    // `dev:` since .985). Marking run.pausing distinguishes this from an unexpected host-lost.
    if (lower === 'dev: pause' || lower === 'dev: cancel') {
      appendMessage({ role: 'user', body: t });
      if (run) run.pausing = true;
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'pause' }); } catch { /* */ }
      if (!run) devBubble('nothing is running to pause.');
      return true;
    }

    // DB-3 (v2.74.1000) — `dev: history` (alias `dev: runs`): list recent runs; tap one to replay it
    // read-only. The host reads the journals in logs/bridge/; the reply renders via the `history` case.
    if (lower === 'dev: history' || lower === 'dev: runs') {
      appendMessage({ role: 'user', body: t });
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'history' }); } catch { devBubble('✗ could not reach the bridge host.'); }
      return true;
    }

    // v2.74.976 — `dev: model` shows the current pick; `dev: model <alias>` sets it (next run uses it).
    if (lower === 'dev: model' || /^dev: model /.test(lower)) {
      appendMessage({ role: 'user', body: t });
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
      appendMessage({ role: 'user', body: t });
      const arg = lower === 'dev: turns' ? '' : lower.slice('dev: turns '.length).trim();
      const cur = await getTurns();
      if (!arg) { devBubble(`bridge turn budget: ${cur} (the runaway cap). Set with \`dev: turns <n>\` — ~25 for a fix, ~50 for a feature, higher for a big task.`); return true; }
      const n = Math.floor(Number(arg));
      if (!Number.isFinite(n) || n < 1) { devBubble('turns must be a positive whole number.'); return true; }
      await setTurns(n);
      devBubble(`bridge turn budget → ${n}. Takes effect on the next run.`);
      return true;
    }

    if (lower === 'gl') {
      appendMessage({ role: 'user', body: t });
      if (run) { devBubble('a bridge run is already live — `dev: pause` to stop it.'); return true; }
      const att = await buildDecisionsAttachment();
      const model = await getModel();
      const maxTurns = await getTurns();
      startRun(
        { v: PROTOCOL_V, type: 'run', verb: 'gl', attachments: att ? [att] : [], model, maxTurns },
        att ? `gl · shipping ${att.filename} + analyzing…` : 'gl · no decision lines this session — analyzing the newest trace already in logs/run/…',
      );
      return true;
    }

    // DB-2 (v2.74.988) — `bug: <what broke>`: the fix path. Ships the newest decisions trace (same
    // attachment `gl` builds) plus the user's report; the host composes report + trace pointer + version
    // line, and the DB-2 allowlist lets the run verify itself with `npm test`. Never commits (no git).
    // A fresh report each time → no resume; the run's session is still recorded (done handler) so a
    // follow-up `dev: <reply>` continues the same fix thread.
    if (/^bug:/i.test(t)) {
      appendMessage({ role: 'user', body: t });
      const report = t.slice(t.indexOf(':') + 1).trim();
      if (!report) { devBubble('usage: `bug: <what broke / what you saw>` — ships the newest trace + your report to a verified fix run.'); return true; }
      if (run) { devBubble('a bridge run is already live — `dev: pause` to stop it.'); return true; }
      const att = await buildDecisionsAttachment();
      const model = await getModel();
      const maxTurns = await getTurns();
      startRun(
        { v: PROTOCOL_V, type: 'run', verb: 'bug', text: report, attachments: att ? [att] : [], model, maxTurns },
        att ? `bug · ${_short(report, 56)} (+ ${att.filename})` : `bug · ${_short(report, 70)}`,
      );
      return true;
    }

    // v2.74.985 — `dev: reset` drops the conversation thread (next `dev:` starts fresh), no run.
    if (lower === 'dev: reset') {
      appendMessage({ role: 'user', body: t });
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
      appendMessage({ role: 'user', body: t });
      if (!ask) { devBubble('usage: `dev: <reply>` (continues / resumes the thread) · `dev: new <task>` (fresh) · `gl` · `bug: <what broke>` · `dev: pause` (stop, keep session) · `dev: history` (recent runs) · `dev: model|turns <…>` · `dev: reset` · `dev: off`'); return true; }
      if (run) { devBubble('a bridge run is already live — `dev: pause` to stop it.'); return true; }
      const model = await getModel();
      const maxTurns = await getTurns();
      const resumeSessionId = isNew ? null : await getLastSession();
      if (isNew) await clearLastSession();   // the fresh run will record its own session on done
      const payload = { v: PROTOCOL_V, type: 'run', verb: 'dev', text: ask, model, maxTurns };
      if (resumeSessionId) payload.resumeSessionId = resumeSessionId;
      startRun(payload, `dev${resumeSessionId ? ' (continuing)' : isNew ? ' (new thread)' : ''} · ${_short(ask, 80)}`);
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

  return { maybeHandle, onReloadState, refreshReloadState, reloadExtension };
}
