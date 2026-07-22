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
import { REG_KEY, authSignal, applySignal, heartbeatTargets } from '../../Core/connectionPresence.js';

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
try { chrome.tabs.onRemoved.addListener((tabId) => _focusReloadAt.delete(tabId)); } catch { /* */ }

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

/** The CONN_* handler map (merged into the SW dispatch like every domain). */
export function createConnectionsHandlers({ invokeSgHandler } = {}) {
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
          const hit = tabs.find((t) => { try { return t && !t.discarded && new URL(t.url).host.toLowerCase() === origin; } catch { return false; } });
          let reloaded = false;
          if (hit) {
            await chrome.tabs.update(hit.id, { active: true });
            try { await chrome.windows.update(hit.windowId, { focused: true }); } catch { /* */ }
            // v2.74.1687 — FOCUS WAS NOT ENOUGH, and the asymmetry was the tell: the no-tab branch below calls
            // `tabs.create`, which loads fresh, so a MISSING tab behaved correctly while an OPEN one did not.
            // Focusing an existing tab left the user staring at the stale signed-out render they were already
            // signed out on — the session had expired underneath a page rendered before it did. The button says
            // "Sign in"; landing on a dead page that needs a manual F5 first is the button not doing its job.
            //
            // DEBOUNCED, because this is the one flow where a stray reload is expensive: the user is typing
            // CREDENTIALS. A re-entrant CONN_FOCUS (double-click, a second warning line, the Connections card
            // firing alongside a desk warning) would wipe a half-filled login form. Within the window we focus
            // and leave the page alone — they are already looking at the live page we would have loaded.
            const last = _focusReloadAt.get(hit.id) || 0;
            if (Date.now() - last > FOCUS_RELOAD_DEBOUNCE_MS) {
              _focusReloadAt.set(hit.id, Date.now());
              try { await chrome.tabs.reload(hit.id); reloaded = true; } catch { /* a reload failure must not fail the focus */ }
            }
          } else {
            await chrome.tabs.create({ url: `https://${origin}/`, active: true });
          }
          try { Logger.info('conn', `CONN ▸ focus ${origin} → ${hit ? (reloaded ? 'focused + reloaded' : 'focused (reload debounced)') : 'opened'}`); } catch { /* */ }
          sendResponse({ success: true, opened: !hit, reloaded });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'focus-failed' }); }
      })();
      return true;
    },
  };
}

// CP-2's `conn:heartbeat` alarm is RETIRED (VT-1, v2.74.1570, DESIGN_vitals.md §4) — the vitals scheduler
// (`vitals:tick`, background/handlers/vitals.js) absorbed it: same open-tab + staleness-gated probing through
// CONN_PROBE_ORIGIN, now under the one clock owner (initVitals clears the old alarm registration on boot).
