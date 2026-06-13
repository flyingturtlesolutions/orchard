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
const MAX_RENDER_LINES = 100;   // a long run keeps the tail; the journal on disk is the full record

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
 * @param {{appendMessage: Function, setMessageBody: Function, mkBtn: Function}} deps
 */
export function createDevBridge({ appendMessage, setMessageBody, mkBtn }) {
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

  function devBubble(initial) {
    const msg = appendMessage({ role: 'assistant', body: '' });
    try { msg.style.borderLeft = '3px solid #c9a227'; msg.dataset.devBridge = '1'; } catch { /* */ }
    const lines = initial ? [initial] : [];
    setMessageBody(msg, lines.join('\n'));
    return { msg, lines };
  }
  function pushLine(text) {
    if (!run) return;
    run.lines.push(text);
    if (run.lines.length > MAX_RENDER_LINES) run.lines = [`… (${run.lines.length - MAX_RENDER_LINES + 1} earlier lines — full journal in logs/bridge/)`, ...run.lines.slice(-MAX_RENDER_LINES)];
    setMessageBody(run.msg, run.lines.join('\n'));
  }
  function endRun(finalLine) {
    if (!run) return;
    if (finalLine) pushLine(finalLine);
    try { run.bar?.remove(); } catch { /* */ }
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
        if (run && run.pendingPayload) { const p = run.pendingPayload; run.pendingPayload = null; port.postMessage(p); pushLine(`claude ${m.claudeVersion} · ${m.repoRoot}`); }
        break;
      case 'started':
        pushLine(`▶ run started (pid ${m.pid}${m.resumed ? `, ↻ resumed ${String(m.resumed).slice(0, 8)}` : ''}${m.model && m.model !== 'default' ? `, model ${m.model}` : ''}${m.maxTurns ? `, ≤${m.maxTurns} turns` : ''}, journal logs/bridge/${m.journal})`);
        break;
      case 'event': {
        const ev = m.ev || {};
        if (ev.type === 'system' && ev.subtype === 'init') {
          if (run) run.sessionId = ev.session_id ?? null;
          pushLine(`session ${String(ev.session_id ?? '').slice(0, 8)} · ${ev.model ?? ''}`);
        } else if (ev.type === 'assistant') {
          for (const block of (ev.message?.content ?? [])) {
            if (block.type === 'text' && block.text?.trim()) pushLine(block.text.trim());
            else if (block.type === 'tool_use') {
              const arg = block.input?.file_path ?? block.input?.pattern ?? block.input?.command ?? '';
              pushLine(`  ▸ ${block.name}${arg ? ` ${_short(arg)}` : ''}`);
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
        const bits = [
          r.subtype === 'success' ? '✓ done' : `✗ ${r.subtype ?? 'ended'}`,
          r.numTurns != null ? `${r.numTurns} turns` : null,
          r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : null,
          r.costUsd != null ? `$${Number(r.costUsd).toFixed(2)}` : null,
        ].filter(Boolean).join(' · ');
        // v2.74.985 — remember this run's session so the NEXT `dev:` continues it by default (the
        // bridge is a conversation; `dev: new` starts a fresh thread). Capture from the result, else the
        // init event the run streamed.
        const sid = r.sessionId || run?.sessionId || null;
        if (sid) setLastSession(sid);
        const resume = sid ? `\ncontinue in terminal: claude --resume ${sid}` : '';
        endRun(`${bits}${resume}`);
        break;
      }
      case 'error':
        endRun(`✗ bridge error: ${m.code}${m.message ? ` — ${m.message}` : ''}${m.code === 'busy' ? ' (one run at a time; "dev: cancel" to stop it)' : ''}`);
        break;
      default: break;
    }
  }

  function startRun(payload, headline) {
    const { msg, lines } = devBubble(headline);
    run = { msgEl: msg, msg, lines, bar: null, sessionId: null, pendingPayload: payload };
    const bar = document.createElement('div');
    bar.appendChild(mkBtn('Stop bridge run', () => { try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'cancel' }); } catch { /* */ } }));
    msg.appendChild(bar);
    run.bar = bar;
    try {
      ensurePort().postMessage({ v: PROTOCOL_V, type: 'preflight' });   // run is posted on preflight-ok
    } catch (e) {
      endRun(`✗ could not reach the bridge host: ${e.message}. Run bridge/install.ps1, then reload.`);
    }
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
      devBubble('✓ dev bridge ON — `gl` and `dev: <ask>` now route to Claude Code on this repo.\nIf the host isn’t installed yet: run bridge/install.ps1 once, then reload the extension.');
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

    if (lower === 'dev: cancel') {
      appendMessage({ role: 'user', body: t });
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'cancel' }); } catch { /* */ }
      if (!run) devBubble('cancel sent.');
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
      if (run) { devBubble('a bridge run is already live — `dev: cancel` to stop it.'); return true; }
      const att = await buildDecisionsAttachment();
      const model = await getModel();
      const maxTurns = await getTurns();
      startRun(
        { v: PROTOCOL_V, type: 'run', verb: 'gl', attachments: att ? [att] : [], model, maxTurns },
        att ? `gl · shipping ${att.filename} + analyzing…` : 'gl · no decision lines this session — analyzing the newest trace already in logs/run/…',
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
      if (!ask) { devBubble('usage: `dev: <reply>` (continues the thread) · `dev: new <task>` (fresh) · `gl` · `dev: model|turns <…>` · `dev: reset` · `dev: cancel` · `dev: off`'); return true; }
      if (run) { devBubble('a bridge run is already live — `dev: cancel` to stop it.'); return true; }
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

  // chat.js calls this once at startup: register the icon's state listener, then push current state
  // (visibility from the persisted setting) and arm the dot if the tree is already dirty.
  async function onReloadState(fn) {
    reloadListener = typeof fn === 'function' ? fn : null;
    const enabled = await getEnabled();
    emitReload({ enabled });
    if (enabled) refreshReloadState();
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
