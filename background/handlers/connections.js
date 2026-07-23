/**
 * @file background/handlers/connections.js
 * @description CP-1/2 (v2.74.1506) — the CONNECTIONS domain: the auth-presence registry (one store, many signals,
 * single writer) + the open-tab heartbeat. The MATH is pure (Core/connectionPresence.js); this is the I/O — the
 * chained read-modify-write (CR-ST1 pattern), the transition broadcast + `CONN ▸` trace, the CONN_* handlers, and
 * the `conn:heartbeat` alarm. Probing itself stays in the connector domain (CONN_PROBE_ORIGIN — it owns the tab
 * fetch machinery); this module only decides WHO to probe and records what came back.
 *
 * PRIVACY: identityName is display-only (the Overview card); logs carry origins + status tokens, never identities.
 */

import { Logger } from '../../Core/Logger.js';
import { REG_KEY, authSignal, applySignal, heartbeatTargets, pickSignInTab } from '../../Core/connectionPresence.js';
import { signInLandingPath } from '../../Core/connectorRecipes.js';   // v1701 — the human console path (Zendesk agent = /agent), so a fresh sign-in tab reaches the agent auth, not the help centre

// VT-4 (v2.74.1572, DESIGN_vitals.md §3.2) — SW-side transition subscribers (the CONN_STATUS_CHANGED broadcast
// does not reach the SW's own listeners): vitals registers here at wiring time (background.js) to open/close
// presence incidents and fire the signed-out→fresh catch-up. Best-effort; a listener can never break the write.
const _transitionListeners = [];
export function registerConnTransitionListener(fn) { if (typeof fn === 'function') _transitionListeners.push(fn); }

// v2.74.1687 — CONN_FOCUS reloads the tab it focuses, debounced per tab so a re-entrant focus cannot wipe a
// half-typed login form. SW-memory only: an idle restart forgets it, and the worst case of forgetting is one
// extra reload of a page the user just landed on — strictly better than persisting state for a 10s window.
const FOCUS_RELOAD_DEBOUNCE_MS = 10_000;
const _focusReloadAt = new Map();   // tabId → last reload stamp
const _originTab = new Map();       // v2.74.1702 — origin → the tab this origin's sign-in last used (reuse over recreate)
try { chrome.tabs.onRemoved.addListener((tabId) => { _focusReloadAt.delete(tabId); for (const [o, id] of _originTab) { if (id === tabId) _originTab.delete(o); } }); } catch { /* */ }

// ── the registry store (chained read-modify-write; single writer) ─────────────────────────────────────────────────
let _chain = Promise.resolve();
async function _read() {
  try { const got = await chrome.storage.local.get(REG_KEY); return got?.[REG_KEY] || {}; } catch { return {}; }
}
export async function readConnRegistry() { return _read(); }

/**
 * THE single write door: normalize the signal, apply it, persist, and on a REAL transition (→signed-out /
 * →wrong-account / back→fresh) log `CONN ▸` + broadcast CONN_STATUS_CHANGED (the open panel refreshes its card).
 * Fire-and-forget safe; never throws.
 */
export function reportAuthSignal(raw) {
  const sig = authSignal({ ...raw, at: (raw && raw.at) || Date.now() });
  if (!sig) return Promise.resolve(null);
  const step = _chain.then(async () => {
    const before = await _read();
    // Write-coalesce: an unchanged status re-verified within 30s skips the write (an each-mode fan-out fires a
    // fresh signal per ride — 121 identical writes would be pure churn). A status CHANGE always writes.
    const prev = before[sig.origin];
    if (prev && prev.status === sig.status && (sig.at - (prev.lastVerifiedAt || 0)) < 30_000) return null;
    const { registry, transition } = applySignal(before, sig);
    try { await chrome.storage.local.set({ [REG_KEY]: registry }); } catch { /* */ }
    if (transition) {
      try { Logger.info('conn', `CONN ▸ ${transition.origin} ${transition.from} → ${transition.to}${transition.cause ? ` (${transition.cause})` : ''} [${transition.source}]`); } catch { /* */ }
      try { chrome.runtime.sendMessage({ type: 'CONN_STATUS_CHANGED', origin: transition.origin, from: transition.from, to: transition.to, cause: transition.cause || null }, () => { void chrome.runtime.lastError; }); } catch { /* */ }
      for (const fn of _transitionListeners) { try { fn(transition); } catch { /* VT-4 — a subscriber never breaks the write */ } }
    }
    return transition;
  }).catch(() => null);
  _chain = step.then(() => {}, () => {});
  return step;
}

// Origins with a LIVE http(s) tab open right now (probes ride tabs; no tab → no probe, ever).
async function _openOrigins() {
  try {
    const tabs = await chrome.tabs.query({});
    return [...new Set(tabs.filter((t) => t && !t.discarded && /^https?:\/\//i.test(t.url || ''))
      .map((t) => { try { return new URL(t.url).host.toLowerCase(); } catch { return null; } })
      .filter(Boolean))];
  } catch { return []; }
}

async function _probeTargets(invokeSgHandler, targets) {
  let probed = 0;
  for (const t of targets) {
    try {
      const r = await invokeSgHandler('CONN_PROBE_ORIGIN', { origin: t.origin, probePath: t.probePath, probeHeaders: t.probeHeaders, probeAccept: t.probeAccept });
      if (r && r.success !== false) probed++;
    } catch { /* per-origin best-effort */ }
  }
  return probed;
}

// v2.74.1705 — EVENT-DRIVEN re-verify: don't wait ~20 min for the next presence tick after a human signs in.
// Signing in NAVIGATES the tab (site → SSO → back to the app), so when a tab finishes loading on an origin the
// registry currently believes is signed-out, re-probe THAT origin immediately. A fresh probe closes the incident,
// which auto-dismisses its case (v1703) within seconds instead of a sweep away. Guarded to not-fresh origins
// (a navigation to a healthy site costs a cheap registry lookup and returns) and debounced per origin (a sign-in
// flow fires several `complete` events across its redirects).
function _wireSignInReverify(invokeSgHandler) {
  if (typeof invokeSgHandler !== 'function') return;
  const _reprobeAt = new Map();   // origin → last re-probe stamp
  try {
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      if (!changeInfo || changeInfo.status !== 'complete' || !tab || !tab.url) return;
      let host = ''; try { host = new URL(tab.url).host.toLowerCase(); } catch { return; }
      if (!host) return;
      (async () => {
        const reg = await _read();
        const e = reg[host];
        if (!e || !e.status || e.status === 'fresh') return;   // only a signed-out / wrong-account origin
        const last = _reprobeAt.get(host) || 0;
        if (Date.now() - last < 5_000) return;
        _reprobeAt.set(host, Date.now());
        const targets = heartbeatTargets(reg, [host], { now: Date.now(), minAgeMs: 0, cap: 1 });
        if (targets.length) await _probeTargets(invokeSgHandler, targets);   // fresh → reportAuthSignal → incident closes → case dismisses
      })().catch(() => { /* a re-probe is best-effort */ });
    });
  } catch { /* tabs.onUpdated unavailable — the sweep still catches it, just slower */ }
}

/** The CONN_* handler map (merged into the SW dispatch like every domain). */
export function createConnectionsHandlers({ invokeSgHandler } = {}) {
  _wireSignInReverify(invokeSgHandler);
  return {
    // The registry, verbatim (statuses + ages; identityName is display-only). The panel renders the Overview card.
    CONN_LIST: (_payload, _sender, sendResponse) => {
      _read().then((registry) => sendResponse({ success: true, registry, now: Date.now() }));
      return true;
    },
    // On-demand refresh ("Check now" / Overview open): probe every probe-bearing origin with an open tab, no age gate.
    CONN_CHECK: (_payload, _sender, sendResponse) => {
      (async () => {
        const [registry, open] = await Promise.all([_read(), _openOrigins()]);
        const targets = heartbeatTargets(registry, open, { now: Date.now(), minAgeMs: 0, cap: 8 });
        const probed = await _probeTargets(invokeSgHandler, targets);
        sendResponse({ success: true, probed, registry: await _read(), now: Date.now() });
      })();
      return true;
    },
    // Focus (or open) the origin's tab so the HUMAN signs in — §16: a tab inherits auth, never creates it; Orchard
    // never touches credentials. The next probe/ride marks it fresh.
    CONN_FOCUS: (payload, _sender, sendResponse) => {
      (async () => {
        const origin = String(payload?.origin || '').trim().toLowerCase();
        if (!origin) { sendResponse({ success: false, error: 'no-origin' }); return; }
        try {
          const tabs = await chrome.tabs.query({});
          const landing = signInLandingPath(origin);
          // v2.74.1702 — REUSE over recreate. The host-only match (v1687) missed an expired tab already REDIRECTED
          // to the branded sign-in host (support.<x>.com/auth/…), so it spawned a DUPLICATE — and every repeat
          // click another. `pickSignInTab` reclaims, most-specific first: a live on-origin tab (RELOAD — keeps its
          // deep `return_to`), the tab this origin's sign-in last used wherever it has since drifted (NAVIGATE
          // back to the console), or a sign-in page whose `return_to` still names the origin (the drifted
          // ORIGINAL, reclaimed on the first click). Only a genuine no-tab case opens fresh.
          //
          // DEBOUNCED (v1687): the user is typing CREDENTIALS — a re-entrant focus (double-click, a second warning
          // line, the Connections card firing alongside a desk warning) must not reload/navigate a half-filled
          // login form out from under them. Within the window we focus and leave the page alone.
          const pick = pickSignInTab(tabs, origin, _originTab.get(origin));
          let outcome;
          if (pick) {
            const t = tabs.find((x) => x.id === pick.tabId);
            await chrome.tabs.update(pick.tabId, { active: true });
            try { if (t) await chrome.windows.update(t.windowId, { focused: true }); } catch { /* */ }
            _originTab.set(origin, pick.tabId);
            const last = _focusReloadAt.get(pick.tabId) || 0;
            if (Date.now() - last > FOCUS_RELOAD_DEBOUNCE_MS) {
              _focusReloadAt.set(pick.tabId, Date.now());
              try {
                if (pick.action === 'navigate') { await chrome.tabs.update(pick.tabId, { url: `https://${origin}${landing}` }); outcome = 'reused + navigated'; }
                else { await chrome.tabs.reload(pick.tabId); outcome = 'reused + reloaded'; }
              } catch { outcome = 'reused (mutate failed)'; /* a reload/navigate failure must not fail the focus */ }
            } else { outcome = 'reused (debounced)'; }
          } else {
            const created = await chrome.tabs.create({ url: `https://${origin}${landing}`, active: true });
            if (created && created.id != null) _originTab.set(origin, created.id);
            outcome = `opened ${landing}`;
          }
          try { Logger.info('conn', `CONN ▸ focus ${origin} → ${outcome}`); } catch { /* */ }
          sendResponse({ success: true, reused: !!pick });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'focus-failed' }); }
      })();
      return true;
    },
  };
}

// CP-2's `conn:heartbeat` alarm is RETIRED (VT-1, v2.74.1570, DESIGN_vitals.md §4) — the vitals scheduler
// (`vitals:tick`, background/handlers/vitals.js) absorbed it: same open-tab + staleness-gated probing through
// CONN_PROBE_ORIGIN, now under the one clock owner (initVitals clears the old alarm registration on boot).
