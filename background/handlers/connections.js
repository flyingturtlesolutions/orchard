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
import { REG_KEY, authSignal, applySignal, heartbeatTargets, pickSignInTab, presenceOf } from '../../Core/connectionPresence.js';
import { gate as presenceGate } from '../../Core/presence.js';   // PR-2 (v2.74.1839, DESIGN_presence.md §2.1) — the two load-bearing asymmetries live in Core, tested
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

// v2.74.1705/1706 — EVENT-DRIVEN re-verify, BOTH directions: don't wait ~20 min for the next presence tick after
// the connection state changes under a tab. Loading a page on a connected origin re-probes THAT origin, and the
// transition (if any) drives the incident — CLOSED on fresh (sign-in → case auto-dismisses, v1703), OPENED on
// signed-out (an expiry the poll would otherwise miss until its next tick). This is the user-side twin of the
// ride funnel, which already opens/closes incidents the instant an ORCHARD ride sees the auth flip (VT-0,
// connector.js). The 20-min sweep shrinks to the backstop for a session that dies with NO ride and NO visit — the
// one case with no event to hang off.
//
// v1706 removed the `=== 'fresh'` half of the guard: probing only not-fresh origins caught sign-IN but was blind
// to expiry-on-load. We still skip UNCONNECTED origins (a navigation anywhere else is a cheap lookup and returns),
// and debounce 5s per origin (one load fires several `complete` events across redirects). Note: a site that hard-
// redirects to a login HOST on expiry (the tab leaves the origin) is not caught here — its host is not in the
// registry — but the ride funnel and the next return-to-origin load both catch it.
function _wireConnReverify(invokeSgHandler) {
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
        if (!e || !e.status) return;   // CONNECTED origins only (fresh OR not) — the flip in either direction matters
        const last = _reprobeAt.get(host) || 0;
        if (Date.now() - last < 5_000) return;
        _reprobeAt.set(host, Date.now());
        const targets = heartbeatTargets(reg, [host], { now: Date.now(), minAgeMs: 0, cap: 1 });
        if (targets.length) await _probeTargets(invokeSgHandler, targets);   // → reportAuthSignal → transition → incident opened/closed
      })().catch(() => { /* a re-probe is best-effort */ });
    });
  } catch { /* tabs.onUpdated unavailable — the sweep still catches it, just slower */ }
}

// PR-1 (v2.74.1839, DESIGN_presence.md §3) — COOKIE invalidation: the third event source, next to the tab-load
// re-verify above and the ride funnel. It exists for exactly the gap the v1706 comment names: a session that
// expires with NO tab load and NO ride — the cookie removal IS the event, and the poll would sleep through it.
//
// Division of labour with the tab-load wire: sign-IN always loads pages, so that direction is already covered;
// this listener acts on the REMOVAL direction only (`removed === true` — expiry/deletion/eviction).
//
// ENVELOPE ONLY (§5): domain + cause. The cookie's VALUE is never read, stored, logged, or passed on — reading
// it grants no new capability (the browser already attaches it to every ride) but creates a portable credential.
// The record goes out of scope inside this listener; nothing downstream receives it.
//
// This never DECIDES sign-out (Core/presence.invalidate semantics: a cookie change is not evidence, only doubt):
// it marks the moment and hands off to the SAME probe funnel every other signal uses — the probe's transition is
// what opens the incident. Only a fresh belief is worth invalidating; 30s/host debounce absorbs analytics churn.
function _wireCookieInvalidate(invokeSgHandler) {
  try {
    if (!chrome.cookies || !chrome.cookies.onChanged || typeof invokeSgHandler !== 'function') return;
    const _at = new Map();   // host → last invalidation stamp
    chrome.cookies.onChanged.addListener((info) => {
      if (!info || info.removed !== true) return;
      const d = String((info.cookie && info.cookie.domain) || '').replace(/^\./, '').toLowerCase();
      if (!d) return;
      const cause = String(info.cause || 'removed');
      (async () => {
        const reg = await _read();
        const key = Object.keys(reg).find((h) => h === d || h.endsWith('.' + d) || d.endsWith('.' + h));
        if (!key || presenceOf(reg[key], Date.now()) !== 'fresh') return;   // only fresh→stale is news
        const last = _at.get(key) || 0;
        if (Date.now() - last < 30_000) return;
        _at.set(key, Date.now());
        Logger.info('conn', `PRESENCE ▸ ${key} · stale · cookie ${cause} → re-probe`);
        const open = await _openOrigins();
        const targets = heartbeatTargets(reg, open.filter((o) => o === key), { now: Date.now(), minAgeMs: 0, cap: 1 });
        if (targets.length) await _probeTargets(invokeSgHandler, targets);   // no open tab → no probe, ever; the sweep backstop covers it
      })().catch(() => { /* best-effort — the sweep still catches it, just slower */ });
    });
  } catch { /* cookies API unavailable (permission not granted yet) — behaviour is exactly pre-PR-1 */ }
}

/** The CONN_* handler map (merged into the SW dispatch like every domain). */
export function createConnectionsHandlers({ invokeSgHandler } = {}) {
  _wireConnReverify(invokeSgHandler);
  _wireCookieInvalidate(invokeSgHandler);
  return {
    // The registry, verbatim (statuses + ages; identityName is display-only). The panel renders the Overview card.
    CONN_LIST: (_payload, _sender, sendResponse) => {
      _read().then((registry) => sendResponse({ success: true, registry, now: Date.now() }));
      return true;
    },
    // PR-2 (v2.74.1839, DESIGN_presence.md §3) — the point-of-use consult. ONE belief: this reads the SAME
    // registry the Admin desk renders, which is the whole point (live 07-27 09:44 — presence said fresh, the
    // work's gate consulted a different store and refused four runs over a minute).
    //
    //   fresh          → proceed, NO probe (zero added latency on the common path — §2.1)
    //   else, open tab → ONE probe, 4s cap; the re-read registry is the verdict
    //   probe fails / no tab / inconclusive → PROCEED and let the real request arbitrate: a failed probe is
    //     evidence about the network, not the session (a csrf prewarm took 10s live on 07-27 00:11), and a
    //     stale NEGATIVE refusing work that would succeed is the exact failure this spec exists to prevent.
    //   Only a CONFIRMED signed-out (or wrong-account — acting as the wrong identity is worse than not acting)
    //     returns proceed:false.
    // `readOnly: true` skips the probe entirely — PR-3's per-item consult uses it between fan-out items.
    PRESENCE_CHECK: (payload, _sender, sendResponse) => {
      (async () => {
        const host = String(payload?.host || '').toLowerCase();
        const readOnly = !!payload?.readOnly;
        const now = Date.now();
        const reg = await _read();
        const key = host ? Object.keys(reg).find((h) => h === host || h.endsWith('.' + host) || host.endsWith('.' + h)) : null;
        const raw = key ? presenceOf(reg[key], now) : 'unknown';
        let state = raw === 'wrong-account' ? 'signed-out' : raw;
        let confirmed = null;
        if (!readOnly && state !== 'fresh' && key) {
          const open = await _openOrigins();
          const targets = heartbeatTargets(reg, open.filter((o) => o === key), { now, minAgeMs: 0, cap: 1 });
          if (targets.length) {
            try {
              await Promise.race([_probeTargets(invokeSgHandler, targets), new Promise((r) => setTimeout(r, 4000))]);
              const after = presenceOf((await _read())[key], Date.now());
              confirmed = after === 'fresh' ? true : ((after === 'signed-out' || after === 'wrong-account') ? false : 'failed');
              state = after === 'wrong-account' ? 'signed-out' : after;
            } catch { confirmed = 'failed'; }
          } else {
            confirmed = 'failed';   // no open tab → no probe, ever — proceed, the request arbitrates
          }
        }
        const v = presenceGate({ state, checkedAt: (key && reg[key] && reg[key].lastVerifiedAt) || null }, { confirmed });
        Logger.info('conn', `PRESENCE ▸ ${key || host || '?'} · ${state} · ${v.reason}`);
        sendResponse({ success: true, host: key || host, state, proceed: v.proceed, reason: v.reason });
      })().catch((e) => { try { sendResponse({ success: false, error: (e && e.message) || String(e) }); } catch { /* */ } });
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
            if (pick.action === 'focus') {
              // v2.74.1707 — the target is ALREADY a sign-in page: focus only, never mutate. Reloading/navigating
              // would restart the login and wipe a half-typed password (the debounce window is shorter than a
              // person types).
              outcome = 'reused (focus — already signing in)';
            } else {
              const last = _focusReloadAt.get(pick.tabId) || 0;
              if (Date.now() - last > FOCUS_RELOAD_DEBOUNCE_MS) {
                _focusReloadAt.set(pick.tabId, Date.now());
                try {
                  if (pick.action === 'navigate') { await chrome.tabs.update(pick.tabId, { url: `https://${origin}${landing}` }); outcome = 'reused + navigated'; }
                  else { await chrome.tabs.reload(pick.tabId); outcome = 'reused + reloaded'; }
                } catch { outcome = 'reused (mutate failed)'; /* a reload/navigate failure must not fail the focus */ }
              } else { outcome = 'reused (debounced)'; }
            }
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
