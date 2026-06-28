/**
 * @file Sidepanel/modes/ground-view.js
 * @description Read-only Ground browse view. Mirrors Studio's Ground card
 * layout — header (name + url + collapse), then per-section rows for
 * Fragments, Assertions, Perspectives, Observations, and Analyses — minus
 * the Strategies section and the per-row edit / view-json affordances.
 *
 * Per-section + Add buttons launch the sidepanel-authorable flows
 * (fragment-author, observation-author, perspective-capture). Assertion /
 * Analysis authoring lives in Studio, so those entries are read-only
 * here.
 *
 * Background contract:
 *   GET_GROUND_LIBRARY — returns every Ground with its Fragment /
 *                        Assertion / Perspective / Observation / Analysis
 *                        lists in one round trip.
 *
 * Mode lifecycle:
 *   mount   — fetch the library, render, wire collapse + add buttons.
 *   unmount — drop the mount element's contents, clear listeners.
 *
 * @module Sidepanel/modes/ground-view
 */

import { toast } from '../shell-api.js';
import { matchGroundForUrl } from '../../Core/GroundMatcher.js';
// v2.74.982 — Shared sidepanel launcher used by the header's chat icon to
// swap the panel back to chat.html (window-scoped), mirroring Studio's
// Chat button. Displaces any prior per-tab override so the swap is immediate.
import { openSidepanelHere } from '../../shared.js';

const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escAttr = escHtml;

// §18 — fetch the Ground's ride-recipe collection (GET_RIDE_RECIPES — seeded from the curated catalog on first access)
// for the panel's glance card. Best-effort → [] on any failure.
async function _fetchRideRecipes(groundId, origin) {
  try {
    const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'GET_RIDE_RECIPES', payload: { groundId, origin } }, r));
    return (res && res.success && Array.isArray(res.recipes)) ? res.recipes : [];
  } catch { return []; }
}

// §18 — one recipe row for the panel, mirroring the fragment ENTRY (gv-entry: name + chips + description). UNTRUSTED →
// escaped. A `pending` recipe now carries ✓ accept / ✕ reject buttons (promotion FROM the panel; v2.74.1277) — wired in
// the post-render pass, carrying their own groundId so the handler is self-contained.
function _renderRideEntry(r, groundId) {
  const badge = r.safetyClass === 'destructive' ? '🔴' : (r.safetyClass === 'gated' ? '🟡' : '🟢');
  const off = (r.enabled === false) ? ' gv-ride-off' : '';
  const pend = (r.reviewState === 'pending') ? '<span class="gv-ride-pending">pending</span>' : '';
  const prov = (r.provenance && r.provenance !== 'curated') ? `<span class="gv-ride-prov">${escHtml(r.provenance)}</span>` : '';
  const review = (r.reviewState === 'pending')
    ? `<button class="btn-secondary gv-ride-act" data-gv-ride-op="review" data-gv-ride-val="accept" data-gv-ride-id="${escAttr(r.id || '')}" data-gv-ride-gid="${escAttr(groundId || '')}" type="button" title="Accept — make this recipe armable">✓</button>`
      + `<button class="btn-secondary gv-ride-act" data-gv-ride-op="review" data-gv-ride-val="reject" data-gv-ride-id="${escAttr(r.id || '')}" data-gv-ride-gid="${escAttr(groundId || '')}" type="button" title="Reject">✕</button>`
    : '';
  return `
    <div class="fragment-row gv-entry gv-ride-entry${off}">
      <div class="fragment-row-main">
        <span class="gv-ride-badge" title="${escAttr(r.safetyClass || 'auto')}">${badge}</span>
        <span class="fragment-name">${escHtml(r.name || r.id || '')}</span>
        <span class="gv-ride-method">${escHtml(String(r.method || 'GET'))}</span>
        ${prov}${pend}
        ${review ? `<span class="gv-ride-actions">${review}</span>` : ''}
      </div>
      ${r.does ? `<div class="fragment-desc" style="white-space:pre-line">${escHtml(r.does)}</div>` : ''}
    </div>`;
}

// §18 — the RIDE class card for the panel: mirrors the fragments section card (through _renderSection — same collapse
// chevron, head, count, list). PROMOTABLE here now (v2.74.1277): per-recipe ✓/✕ + a head "✓ N reads" bulk-accept for the
// pending GETs (auto-safe; writes still need an individual ✓). The empty/seed flow is handled by GET_RIDE_RECIPES upstream.
function _renderRideCard(recipes, groundId) {
  const list = Array.isArray(recipes) ? recipes : [];
  const pending = list.filter((r) => r && r.reviewState === 'pending').length;
  const pendingReads = list.filter((r) => r && r.reviewState === 'pending' && r.safetyClass === 'auto').length;
  const bulkBtn = pendingReads > 0
    ? `<button class="btn-secondary gv-ride-bulk" data-gv-ride-bulk="${escAttr(groundId)}" type="button" title="Accept all pending reads (GETs) — makes them armable. Writes still need an individual ✓.">✓ ${pendingReads} read${pendingReads === 1 ? '' : 's'}</button>`
    : '';
  // §19 (passive toggle v2.74.1284) — Forage is an ARM/BANK toggle: 1st click arms passive capture on your LIVE logged-in
  // tab, you navigate your app (its API reads — incl. cross-origin — are captured), 2nd click banks them `pending`. This is
  // the robust path for static SPAs whose nav can't be driven synthetically. Label reflects the armed state.
  const armed = _forageArmed.has(groundId);
  const forageBtn = `<button class="btn-secondary gv-ride-forage${armed ? ' gv-ride-forage-armed' : ''}" data-gv-ride-forage="${escAttr(groundId)}" type="button" title="${armed ? 'Foraging — navigate your app to capture its reads, then click to BANK them.' : 'Forage — arm passive capture on your logged-in tab; navigate your app, then click again to bank the API reads it makes.'}">⛏ ${armed ? 'Foraging — bank' : 'Forage'}</button>`;
  const headExtra = `${bulkBtn}${forageBtn}`;
  return _renderSection({
    key: 'recipes',
    label: 'Ride · Recipes',
    count: pending ? `${list.length} · ${pending} pending` : list.length,
    headExtra,
    groundId,
    emptyMsg: 'No ride recipes — connect a session-ride app, or harvest them.',
    entries: list.slice(0, 60).map((r) => _renderRideEntry(r, groundId)),
  });
}

let _mountEl = null;
// v2.74.31 — Per-section collapse state. Map<groundId, Set<sectionKey>>
// — sectionKey is one of 'fragments' | 'assertions' | 'perspectives' |
// 'observations' | 'analyses'. Ephemeral; lost on unmount.
// v2.74.35 — Ground-level collapse retired: the Ground card no longer
// holds the section cards inside it (each section is a free-floating
// sibling card with its own collapse), so a card-wide collapse no
// longer makes sense.
const _collapsedSections = new Map();
// v2.74.434 — siteMap viewer open-state per groundId (was the GroundMap
// viewer). Ephemeral; lost on unmount.
const _openSiteMaps = new Set();
// Cache the most recently fetched siteMap per groundId so the toggle
// handler can rebuild the viewer without another round trip to
// GET_GROUND_LIBRARY.
const _siteMapCache = new Map();
// v2.74.42 — Discovery-in-progress tracking. While a groundId is in this
// set, _renderList shows the indeterminate-loading view instead of the
// section list. Discovery broadcasts (DISCOVERY_COMPLETE / FAILED)
// remove the entry and trigger a re-render.
const _discoveryRunning = new Set();
// §19 (v2.74.1281; passive toggle v2.74.1284) — which grounds have a PASSIVE forage ARMED (the "⛏ Forage" Ride-card button
// is a toggle: arm → the user navigates their app → bank). A groundId sits here between the arm click and the bank's
// FORAGE_COMPLETE, driving the button label (⛏ Forage ↔ ⛏ Foraging — bank). Ephemeral; lost on unmount, like _discoveryRunning.
const _forageArmed = new Set();
// §20 (v2.74.1293) — grounds whose PERSISTENT ride auth-capture we've armed this mount (fire-once). When a matched Ground
// has an ACCEPTED harvested (header-replay) recipe, arm capture on its live tab so the page-local token stays fresh for
// SESSION_REPLAY (the SPA self-refreshes its Bearer; we keep grabbing the latest). Consent-gated background-side.
const _rideCaptureArmed = new Set();
function _maybeArmRideCapture(ground, recipes) {
  try {
    if (!ground || _rideCaptureArmed.has(ground.id)) return;
    const armable = (Array.isArray(recipes) ? recipes : []).some((r) => r && r.provenance === 'harvested' && r.reviewState === 'accepted' && r.enabled !== false);
    if (!armable) return;
    _rideCaptureArmed.add(ground.id);
    let host = ''; try { host = new URL(ground.url || ground.origin || '').host; } catch { host = String(ground.origin || ''); }
    if (!host) return;
    const q = typeof _windowId === 'number' ? { active: true, windowId: _windowId } : { active: true, currentWindow: true };
    chrome.tabs.query(q, (tabs) => {
      const t = Array.isArray(tabs) && tabs[0];   // matched ⟹ the active tab IS this Ground's tab
      const tabId = t && typeof t.id === 'number' ? t.id : null;
      chrome.runtime.sendMessage({ type: 'ARM_RIDE_CAPTURE', payload: { host, tabId } }, () => { void chrome.runtime.lastError; });
    });
  } catch { /* never break the render on the arm */ }
}
// v2.74.42 — Collapse state for the matched-Ground header card.
const _collapsedHeader = new Set();
// v2.74.866 — Collapse state for the Landmarks card (monitoring registry view),
// keyed by groundId. Ephemeral; lost on unmount. Default collapsed=false.
const _collapsedLandmarks = new Set();
// v2.74.29 — Tab-change listeners. Hold references so unmount can detach
// them cleanly. _refreshTimer coalesces bursts (SPA navigations fire many
// tabs.onUpdated events in quick succession).
let _tabListeners = null;
let _refreshTimer = null;
// v2.74.30 — Pin the panel to its own Chrome window. The sidepanel is
// per-window (Chrome hosts one panel slot per window); we only care
// about tab activity inside this window. Captured once on mount.
let _windowId = null;

async function mount(_payload, mountEl) {
  _mountEl = mountEl;
  _mountEl.innerHTML = `
    <div class="gv-shell">
      <div class="gv-header">
        <div class="gv-header-titles">
          <span class="gv-header-title">Ground</span>
          <span class="gv-header-sub">author fragments, observations &amp; more</span>
        </div>
        <!-- v2.74.982 — Header affordances mirroring the chat side panel's
             toolbar order (chat-launcher · Studio · Hide). The chat icon
             takes the slot the chat panel gives its "Open Ground" button —
             navigation to the sibling surface — then Open Studio and Hide
             panel in the same right-aligned positions. -->
        <div class="gv-header-actions">
          <button class="icon-btn" id="gv-btn-open-chat" title="Open chat (side panel)">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <button class="icon-btn" id="gv-btn-open-studio" title="Open Studio (authoring tab)">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 3h7v7"/>
              <path d="M10 14L21 3"/>
              <path d="M21 14v7H3V3h7"/>
            </svg>
          </button>
          <button class="icon-btn" id="gv-btn-hide-panel" title="Hide panel (running tasks continue)">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="gv-feed" data-gv="feed">
        <div class="gv-feed-head">
          <span class="gv-feed-dot" data-gv="feed-dot"></span>
          <span class="gv-feed-title">Live interactions</span>
          <span class="gv-feed-status" data-gv="feed-status">off</span>
          <button class="gv-feed-clear" data-gv="feed-clear" type="button">clear</button>
        </div>
        <ul class="gv-feed-list" data-gv="feed-list">
          <li class="gv-feed-empty">Enable live monitoring in Studio → Settings, then interact with this page.</li>
        </ul>
      </div>
      <div class="gv-list" data-gv="list">
        <div class="gv-loading">Loading…</div>
      </div>
    </div>
  `;
  // v2.74.30 — Pin to the sidepanel's own window. Subsequent active-tab
  // lookups and listener filtering all key off this id.
  try {
    const win = await chrome.windows.getCurrent();
    _windowId = win?.id ?? null;
  } catch {
    _windowId = null;
  }
  _wireTabListeners();
  _wireFeed();
  _wireHeaderActions();
  await _renderList();
}

// v2.74.982 — Header toolbar handlers (chat launcher · Studio · Hide panel),
// mirroring the chat side panel's equivalent buttons in chat.js.
//   chat   → swap the panel back to chat.html (window-scoped) via the shared
//            launcher. chrome.sidePanel.open needs a user gesture, and the
//            click is it; openSidepanelHere awaits internally.
//   studio → focus an existing Studio tab or open one (same as chat.js's
//            btn-open-studio).
//   hide   → window.close() closes only this side panel; running invocations
//            continue in the service worker (same as chat.js's btn-hide-panel).
function _wireHeaderActions() {
  if (!_mountEl) return;
  _mountEl.querySelector('#gv-btn-open-chat')?.addEventListener('click', async () => {
    try {
      await openSidepanelHere('chat.html');
    } catch (err) {
      toast(`Couldn't open chat: ${err?.message ?? 'unknown'}`, 'err');
    }
  });
  _mountEl.querySelector('#gv-btn-open-studio')?.addEventListener('click', async () => {
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
      toast(`Couldn't open Studio: ${err?.message ?? 'unknown'}`, 'err');
    }
  });
  _mountEl.querySelector('#gv-btn-hide-panel')?.addEventListener('click', () => {
    window.close();
  });
}

// ── Live interaction feed (monitoring) ───────────────────────────────────────
const _IM_FEED_CAP = 60;
function _imFeedRow(p) {
  if (!_mountEl || !p) return;
  const list = _mountEl.querySelector('[data-gv="feed-list"]'); if (!list) return;
  const empty = list.querySelector('.gv-feed-empty'); if (empty) empty.remove();
  const dot = _mountEl.querySelector('[data-gv="feed-dot"]'); if (dot) dot.classList.add('gv-feed-dot--live');
  const status = _mountEl.querySelector('[data-gv="feed-status"]'); if (status && status.textContent !== 'monitoring') status.textContent = 'monitoring';
  const lm = (Array.isArray(p.landmarks) && p.landmarks.length) ? p.landmarks[0] : null;
  let t = '';
  try { const d = new Date(p.ts); t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; } catch {}
  const what = lm ? escHtml(lm) : (p.name ? '&ldquo;' + escHtml(p.name) + '&rdquo;' : '&lsaquo;' + escHtml(p.tag || '?') + '&rsaquo;');
  const li = document.createElement('li');
  li.className = `gv-feed-row gv-feed-row--${escAttr(p.status || 'miss')}`;
  li.innerHTML =
    `<span class="gv-feed-verb">${escHtml(p.verb || p.kind || '')}</span>` +
    `<span class="gv-feed-arrow">→</span>` +
    `<span class="gv-feed-what">${what}</span>` +
    `<span class="gv-feed-badge">${escHtml(p.status || '')}</span>` +
    `<span class="gv-feed-time">${escHtml(t)}</span>`;
  list.insertBefore(li, list.firstChild);
  while (list.children.length > _IM_FEED_CAP) list.removeChild(list.lastChild);
}
async function _wireFeed() {
  if (!_mountEl) return;
  const clear = _mountEl.querySelector('[data-gv="feed-clear"]');
  if (clear) clear.addEventListener('click', () => {
    const list = _mountEl?.querySelector('[data-gv="feed-list"]');
    if (list) list.innerHTML = '<li class="gv-feed-empty">Cleared — interact with the page for live events.</li>';
  });
  try {
    const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'GET_MONITOR_CONSENT' }, (x) => r(x)));
    const on = !!(res?.success && res.trackEnabled);
    const dot = _mountEl?.querySelector('[data-gv="feed-dot"]');
    const status = _mountEl?.querySelector('[data-gv="feed-status"]');
    if (dot) dot.classList.toggle('gv-feed-dot--live', on);
    if (status) status.textContent = on ? 'monitoring' : 'off';
  } catch {}
}

async function unmount() {
  _unwireTabListeners();
  if (_mountEl) _mountEl.innerHTML = '';
  _mountEl = null;
  _windowId = null;
  _collapsedSections.clear();
  _openSiteMaps.clear();
  _siteMapCache.clear();
  _discoveryRunning.clear();
  _collapsedHeader.clear();
  _collapsedLandmarks.clear();
}

// v2.74.29 — Wire tab listeners so the panel re-renders whenever the
// active page in THIS window changes:
//   tabs.onActivated — user clicked a different tab in our window.
//   tabs.onUpdated   — active tab's URL changed (incl. SPA pushState).
// Both funnel through a 120 ms debounced trigger so a navigation that
// fires multiple onUpdated events in a burst causes one re-render.
// v2.74.30 — Filter events to _windowId so activity in OTHER Chrome
// windows doesn't poke this panel. The sidepanel is per-window — each
// window has its own panel slot and shows its own active tab's Ground.
function _wireTabListeners() {
  if (_tabListeners) return;
  const trigger = () => {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => {
      _refreshTimer = null;
      _renderList().catch(() => {});
    }, 120);
  };
  const onActivated = (info) => {
    if (_windowId != null && info?.windowId !== _windowId) return;
    trigger();
  };
  const onUpdated = (_tabId, changeInfo, tab) => {
    // Only care about URL changes in the active tab of our window —
    // title/favicon updates and background-tab navigations shouldn't
    // cause a re-render.
    if (!changeInfo?.url) return;
    if (_windowId != null && tab?.windowId !== _windowId) return;
    if (tab && tab.active === false) return;
    trigger();
  };
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  _tabListeners = { onActivated, onUpdated };
}

function _unwireTabListeners() {
  if (_refreshTimer) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }
  if (!_tabListeners) return;
  try { chrome.tabs.onActivated.removeListener(_tabListeners.onActivated); } catch {}
  try { chrome.tabs.onUpdated.removeListener(_tabListeners.onUpdated); } catch {}
  _tabListeners = null;
}

function handleEvent(message) {
  // Refresh on relevant storage broadcasts so newly authored entries
  // (saved Fragment, Observation, etc.) appear without a manual reload.
  if (!message) return;
  if (message.type === 'INTERACTION_FEED') { _imFeedRow(message.payload); return; }   // live monitoring feed
  if (message.type === 'STORAGE_CHANGED') {
    _renderList().catch(() => {});
    return;
  }
  // v2.74.42 — Discovery broadcasts gate the indeterminate-spinner view.
  // PROGRESS is a no-op for display (the user requested a simple
  // in-flight indicator with no per-page text); COMPLETE / FAILED clear
  // the running flag and re-render the panel.
  if (message.type === 'DISCOVERY_PROGRESS') return;
  if (message.type === 'DISCOVERY_COMPLETE') {
    const { groundId, pageCount, aborted, drift } = message.payload ?? {};
    if (!_discoveryRunning.has(groundId)) return;
    _discoveryRunning.delete(groundId);
    // v2.74.450 — drift (§8): show what (re-)discovery changed.
    const driftTxt = drift && (drift.added || drift.statusChanged || drift.removed)
      ? ` · ${drift.added} new${drift.statusChanged ? `, ${drift.statusChanged} changed` : ''}${drift.removed ? `, ${drift.removed} removed` : ''}`
      : '';
    toast(aborted
      ? `Discovery aborted — kept partial map (${pageCount} pages)`
      : `Discovery complete — mapped ${pageCount} page${pageCount === 1 ? '' : 's'}${driftTxt}`);
    _renderList().catch(() => {});
    return;
  }
  if (message.type === 'DISCOVERY_FAILED') {
    const { groundId, error } = message.payload ?? {};
    if (!_discoveryRunning.has(groundId)) return;
    _discoveryRunning.delete(groundId);
    toast(`Discovery failed: ${error ?? 'unknown'}`, 'err');
    _renderList().catch(() => {});
  }
  // §19 (passive toggle v2.74.1284) — a passive forage BANKED (or armForage failed → disarmed). Clear the armed state +
  // TOAST the result for a user-initiated toggle; ALWAYS re-render so the freshly-banked pending recipes + the reset button
  // label show in the Ride card. (The Discovery auto-chain's one-shot forage also lands here — silent refresh, no toast.)
  if (message.type === 'FORAGE_COMPLETE') {
    const { groundId, banked, captures, error, disarmed } = message.payload ?? {};
    if (_forageArmed.has(groundId)) {
      _forageArmed.delete(groundId);
      if (error) toast(`Forage couldn't arm: ${error}`, 'err');
      else if (disarmed) toast('Forage stopped', 'err');
      else toast(`Foraged ${captures ?? 0} read${captures === 1 ? '' : 's'} → banked ${banked ?? 0} recipe${banked === 1 ? '' : 's'}`);
    }
    _renderList().catch(() => {});
    return;
  }
}

// v2.74.28 — Normalize a URL down to a comparable host. Strips a leading
// "www." so "www.pixabay.com" and "pixabay.com" match each other. Returns
// null for non-http(s) URLs (chrome://, chrome-extension://, file://,
// about:blank) where domain matching doesn't make sense.
function _normalizeHost(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase();
    return h.startsWith('www.') ? h.slice(4) : h;
  } catch {
    return null;
  }
}

// v2.74.326 — GROUND_SPEC § 3 spec-strict URL-pattern matching. The
// library entry whose Ground's urlPatterns match the tab URL wins
// (most-specific-wins, alphabetical-by-id tiebreak). NOTE: spec-strict
// means a bare-origin Ground (`https://site.com`) matches ONLY that exact
// URL — author the pattern as `https://site.com/*` to match all paths, or
// `https://*.site.com/*` for subdomains. (Replaces the old host/subdomain
// heuristic per the user's spec-strict decision.)
function _findMatchingGround(tabUrl, grounds) {
  const hit = matchGroundForUrl(tabUrl, grounds.map(e => e.ground).filter(Boolean));
  if (!hit) return null;
  return grounds.find(e => e.ground?.id === hit.ground.id) ?? null;
}

async function _getActiveTabUrl() {
  // v2.74.30 — Query the active tab in OUR window (the one hosting this
  // sidepanel). Falls back to lastFocusedWindow if _windowId wasn't
  // captured (unusual — mount captures it before the first render).
  try {
    const queryOpts = _windowId != null
      ? { active: true, windowId: _windowId }
      : { active: true, lastFocusedWindow: true };
    const [tab] = await chrome.tabs.query(queryOpts);
    return tab?.url ?? null;
  } catch {
    return null;
  }
}

async function _renderList() {
  const list = _mountEl?.querySelector('[data-gv="list"]');
  if (!list) return;

  // Fetch the library + active tab URL in parallel. The library is the
  // single source of truth for what Grounds exist; the tab URL drives
  // which one (if any) gets shown.
  let res, tabUrl;
  try {
    [res, tabUrl] = await Promise.all([
      new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_GROUND_LIBRARY' }, resolve)),
      _getActiveTabUrl(),
    ]);
  } catch (e) {
    list.innerHTML = `<div class="gv-empty">Failed to load: ${escHtml(e?.message ?? 'unknown')}</div>`;
    return;
  }
  if (!res?.success) {
    list.innerHTML = `<div class="gv-empty">Failed to load: ${escHtml(res?.error ?? 'unknown')}</div>`;
    return;
  }

  const grounds = res.grounds ?? [];

  // No usable tab URL (chrome://, extension page, blank tab) — nothing to
  // match against. Tell the user, don't render a stale list.
  if (!_normalizeHost(tabUrl)) {
    list.innerHTML = `<div class="gv-empty">Open a regular web page (http/https) to author its Ground.</div>`;
    return;
  }

  const matched = _findMatchingGround(tabUrl, grounds);
  if (matched) {
    // v2.74.434 — Cache the fetched siteMap so the toggle handler can
    // re-render the viewer without another GET_GROUND_LIBRARY trip.
    if (matched.siteMap) _siteMapCache.set(matched.ground.id, matched.siteMap);
    const hasMap = !!(matched.siteMapStats && matched.siteMapStats.nodes > 0);
    // v2.74.866 — Fetch the Ground's registry landmarks (the set live
    // monitoring resolves interactions against — NOT carried by
    // GET_GROUND_LIBRARY). Rendered as a Landmarks card in every matched
    // path so a 0-landmark Ground visibly explains why monitoring misses.
    const landmarks = await _fetchLandmarks(matched.ground.id);
    // v2.74.867 — proposed-landmark tally across the Ground's Perspectives
    // (each Perspective's landmarks[] is a node tree of {ref:uid} pointers).
    // These are PROPOSALS — the verified registry records monitoring resolves
    // against are minted only at Resolve→Accept. Surfacing the gap (verified 0
    // vs proposed N) is what answers "perspectives show landmarks but the card
    // shows 0": they're unverified pointers, not verified registry entries.
    const proposedLm = (matched.perspectives || []).reduce(
      (s, p) => s + (Array.isArray(p.landmarks) ? p.landmarks.length : 0), 0);
    const lmHtml = _renderLandmarksCard(landmarks, matched.ground.id, proposedLm);
    // §18 — the RIDE class glance card (a free-floating sibling card, like Landmarks). Fetch-then-render mirrors the
    // Landmarks pattern. Display-only here; full edit is in Studio's Ride section (per the spec — panel glances, Studio edits).
    let _rideOrigin = '';
    try { _rideOrigin = new URL(matched.ground.url || matched.ground.origin || '').host; } catch { _rideOrigin = String(matched.ground.origin || ''); }
    const _rideRecipes = await _fetchRideRecipes(matched.ground.id, _rideOrigin);
    _maybeArmRideCapture(matched.ground, _rideRecipes);   // §20 — keep the token fresh while the user is in a connected ride app
    const rideHtml = _renderRideCard(_rideRecipes, matched.ground.id);
    // v2.74.42 — Section list is gated on a mapped Ground (siteMap present).
    // While discovery is in flight, show the indeterminate loading
    // indicator. When a Ground exists but has no map yet, show a
    // Discover prompt instead of empty section cards.
    if (_discoveryRunning.has(matched.ground.id)) {
      list.innerHTML = _renderHeaderOnly(matched) + lmHtml + rideHtml + _renderDiscoveringBlock();
      _wireHeaderHandlers(matched);
      _wireLandmarksCard();
    } else if (hasMap) {
      list.innerHTML = _renderGroundCard(matched, lmHtml) + rideHtml;
      _wireHandlers([matched]);
      _wireLandmarksCard();
    } else {
      list.innerHTML = _renderHeaderOnly(matched) + lmHtml + rideHtml + _renderUndiscoveredBlock(matched.ground.id);
      _wireHeaderHandlers(matched);
      _wireDiscoverPromptHandler(matched.ground);
      _wireLandmarksCard();
    }
  } else {
    list.innerHTML = _renderNewGroundCard(tabUrl);
    _wireNewGroundHandlers(tabUrl);
  }
}

// v2.74.42 — Render only the matched Ground's header card (no section
// list, no map viewer). Used by the discovering / undiscovered render
// paths. Mirrors the structure produced by _renderGroundCard's header
// segment, so handler wiring (collapse toggle, map-badge click) works
// identically.
function _renderHeaderOnly(entry) {
  const { ground, siteMap, siteMapStats } = entry;
  const collapsed = _collapsedHeader.has(ground.id);
  const collapsedClass = collapsed ? ' gv-ground-card-collapsed' : '';
  const chevron = collapsed ? '▸' : '▾';
  const hasMap = !!(siteMapStats && siteMapStats.nodes > 0);
  const mapBadge = hasMap
    ? `<button class="groundmap-badge" type="button"
               data-gv-toggle-map="${escAttr(ground.id)}"
               title="Site map — ${siteMapStats.modeled} modeled · ${siteMapStats.discovered} discovered${siteMapStats.stub ? ` · ${siteMapStats.stub} stub` : ''} · ${siteMapStats.edges} edge(s) — click to view">🗺 ${siteMapStats.nodes} node${siteMapStats.nodes === 1 ? '' : 's'}</button>`
    : '';
  const aliasTags = Array.isArray(ground.aliases) && ground.aliases.length > 0
    ? `<div class="ground-alias-tags">${ground.aliases.map(a => `<span class="ground-alias-tag">${escHtml(a)}</span>`).join('')}</div>`
    : '';
  const metaRow = (mapBadge || aliasTags)
    ? `<div class="ground-group-meta">${mapBadge}${aliasTags}</div>`
    : '';
  const descRow = (ground.description && typeof ground.description === 'string' && ground.description.trim())
    ? `<div class="gv-ground-description">${escHtml(ground.description.trim())}</div>`
    : '';
  const mapOpen = hasMap && _openSiteMaps.has(ground.id);
  const viewerHtml = hasMap
    ? (mapOpen
        ? `<div class="groundmap-viewer gv-groundmap-viewer" data-gv-gm-viewer="${escAttr(ground.id)}">${_renderSiteMapHtml(siteMap)}</div>`
        : `<div class="groundmap-viewer gv-groundmap-viewer hidden" data-gv-gm-viewer="${escAttr(ground.id)}"></div>`)
    : '';
  // v2.74.43 — Header restructured so url / meta / description align to
  // the left edge of the header instead of sitting in a column indented
  // by the chevron. Only the name shares the row with the chevron; the
  // other fields are full-width block children below.
  return `
    <section class="ground-card gv-ground-card${collapsedClass}" data-gv-gid="${escAttr(ground.id)}">
      <div class="ground-group-header gv-ground-header">
        <div class="gv-ground-header-top">
          <button class="gv-ground-collapse-toggle" type="button"
                  data-gv-toggle-header="${escAttr(ground.id)}"
                  title="Collapse / expand Ground header"
                  aria-expanded="${collapsed ? 'false' : 'true'}">
            <span class="gv-ground-collapse-chevron">${chevron}</span>
          </button>
          <span class="ground-group-name">${escHtml(ground.name ?? 'Unnamed Ground')}</span>
        </div>
        <span class="ground-group-url">${escHtml(ground.url ?? '')}</span>
        ${metaRow}
        ${descRow}
      </div>
      ${viewerHtml}
    </section>
  `;
}

// v2.74.42 — Indeterminate spinner shown while discovery is running.
// No progress text — the user requested a simple "in flight" indicator.
function _renderDiscoveringBlock() {
  return `
    <div class="gv-discovering">
      <div class="gv-spinner" aria-label="Discovering…" role="status"></div>
      <span class="gv-discovering-label">Discovering…</span>
    </div>
  `;
}

// v2.74.42 — Inline prompt when a Ground exists but discovery has not
// run yet (or failed). Surfaces a Discover button so the user can
// kick off the crawl without leaving the sidepanel.
function _renderUndiscoveredBlock(groundId) {
  return `
    <div class="gv-undiscovered">
      <p class="gv-undiscovered-hint">Run Discover to crawl this site and reveal its Fragments / Observations sections.</p>
      <button class="btn-secondary gv-undiscovered-btn" type="button"
              data-gv-discover-existing="${escAttr(groundId)}">🔍 Discover</button>
    </div>
  `;
}

// v2.74.28 — Inline "create Ground" card for when the active tab's
// domain doesn't match any existing Ground. Pre-fills the URL field.
// v2.74.36 — Save button replaced with Discover (mirrors Studio's
// per-Ground Discover button). Clicking saves the Ground record and
// then starts a structural-map discovery — same flow Studio runs.
// Progress and result are shown inline in the card.
// v2.74.41 — URL field shows the ROOT origin of the current tab (e.g.
// https://www.facilitron.com/) rather than the full deep URL. Name is
// optional — when blank, the Discover-time site-summary call fills it
// (along with aliases and a description) automatically.
function _renderNewGroundCard(tabUrl) {
  const rootUrl = _rootUrlOf(tabUrl) ?? tabUrl;
  // v2.74.334 — Default the seed to a whole-site glob (`<root>/*`) so the new
  // Ground matches every page on the site, not just the exact root. Spec-
  // strict matching (v2.74.326) means a bare URL matches ONLY that page.
  const seedPattern = (typeof rootUrl === 'string' && rootUrl)
    ? (rootUrl.endsWith('/') ? `${rootUrl}*` : `${rootUrl}/*`)
    : rootUrl;
  return `
    <section class="ground-card gv-new-ground-card">
      <div class="ground-group-header gv-new-ground-header">
        <div class="ground-group-info">
          <span class="ground-group-name">New Ground</span>
          <span class="ground-group-url">No Ground matches this page yet.</span>
        </div>
      </div>
      <div class="gv-new-ground-body">
        <label class="gv-new-ground-field">
          <span class="gv-new-ground-label">Name <span class="gv-new-ground-hint">(optional — auto-filled by Discover)</span></span>
          <input type="text" data-gv-new="name" maxlength="80"
                 placeholder="leave blank to let Discover fill this in" />
        </label>
        <label class="gv-new-ground-field">
          <span class="gv-new-ground-label">URL pattern <span class="gv-new-ground-hint"><code>/*</code> = all pages; <code>*.site.com/*</code> = subdomains</span></span>
          <input type="text" data-gv-new="url" value="${escAttr(seedPattern)}" placeholder="https://example.com/*" />
        </label>
        <div class="gv-new-ground-actions">
          <button class="btn-secondary" data-gv-new="discover" type="button"
                  title="Save this Ground and discover its structural map (read-only crawl on the current tab)">🔍 Discover</button>
        </div>
      </div>
    </section>
  `;
}

// v2.74.41 — Root origin of a URL with trailing slash, suitable as a
// Ground seed URL. e.g.
//   https://www.facilitron.com/facilities-for-rent → https://www.facilitron.com/
// Returns null for non-http(s) URLs.
function _rootUrlOf(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}/`;
  } catch {
    return null;
  }
}

function _wireNewGroundHandlers(_tabUrl) {
  const nameEl     = _mountEl?.querySelector('[data-gv-new="name"]');
  const urlEl      = _mountEl?.querySelector('[data-gv-new="url"]');
  const discoverEl = _mountEl?.querySelector('[data-gv-new="discover"]');
  if (!nameEl || !urlEl || !discoverEl) return;
  nameEl.focus();
  discoverEl.addEventListener('click', async () => {
    const name = nameEl.value.trim();
    const url  = urlEl.value.trim();
    // v2.74.41 — Name is optional. Discover's site-summary call fills
    // name + aliases + description on completion. URL is still required
    // (it's the seed for the crawl).
    if (!url) { toast('Enter a URL', 'err'); urlEl.focus(); return; }
    try { new URL(url); } catch {
      toast('That does not look like a valid URL', 'err');
      urlEl.focus();
      return;
    }
    discoverEl.disabled = true;
    discoverEl.textContent = 'Saving…';
    const id = `gnd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ground = {
      id, url, name, aliases: [], description: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const saveRes = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'SAVE_GROUND', payload: { ground } }, resolve);
    });
    if (!saveRes?.success) {
      toast(`Save failed: ${saveRes?.error ?? 'unknown'}`, 'err');
      discoverEl.disabled = false;
      discoverEl.textContent = '🔍 Discover';
      return;
    }
    // v2.74.42 — Hand off to the shared kickoff. It runs the API-key
    // check, marks _discoveryRunning, re-renders into the spinner
    // view, then dispatches START_DISCOVERY. Replaces the inline
    // progress strip the new-ground card used to render.
    await _kickoffDiscovery(id);
  });
}

// v2.74.35 — The Ground header card and the five section cards are now
// independent sibling sections — none of the sections are nested inside
// the Ground header. The Ground card just shows name + url; the
// per-section cards (Fragments, Assertions, Perspectives, Observations,
// Analyses) live below as free-floating cards with their own collapse
// chevron, list of items, and (where applicable) right-aligned + Add
// footer. Mirrors the fragment-author sidepanel pattern.
// v2.74.434 — Header card surfaces a 🗺 siteMap node-count badge + alias tags,
// mirroring Studio's ground header. The badge is a clickable button that toggles
// an inline siteMap viewer (node list) beneath the header.
function _renderGroundCard(entry, landmarksHtml = '') {
  const { ground, fragments, assertions, perspectives, observations, analyses } = entry;
  // v2.74.42 — Header card is now collapsible; the chevron + body
  // logic was hoisted into _renderHeaderOnly so the discovering /
  // undiscovered render paths can reuse it.
  const headerHtml = _renderHeaderOnly(entry);
  return `
    ${headerHtml}

    ${landmarksHtml}

    ${_renderSection({
      key: 'fragments',
      label: 'Fragments',
      count: fragments.length,
      addLabel: '+ Fragment',
      addKind: 'fragment',
      groundId: ground.id,
      groundUrl: ground.url,
      emptyMsg: 'No Fragments yet — record page-state transitions as reusable units.',
      entries: fragments.map(f => _renderFragmentEntry(f, fragments)),
    })}

    ${_renderSection({
      key: 'assertions',
      label: 'Assertions',
      count: assertions.length,
      // v2.74.53 — + Assert opens assertion-author sidepanel mode.
      addLabel: '+ Assert',
      addKind: 'assertion',
      groundId: ground.id,
      emptyMsg: 'No assertions yet.',
      entries: assertions.map(p => _renderAssertionEntry(p)),
    })}

    ${_renderSection({
      key: 'perspectives',
      label: 'Perspectives',
      count: perspectives.length,
      // v2.74.392 — + Perspective opens a BLANK perspective-capture draft. Authoring is
      // the description-first propose→resolve→auto-structure flow; the legacy
      // Claude auto-suggested-landmarks path was removed.
      addLabel: '+ Perspective',
      addKind: 'perspective',
      groundId: ground.id,
      emptyMsg: 'No Perspectives yet — verified DOM landmark records for kinds of pages.',
      entries: perspectives.map(l => _renderPerspectiveEntry(l)),
    })}

    ${_renderSection({
      key: 'observations',
      label: 'Observations',
      count: observations.length,
      addLabel: '+ Observation',
      addKind: 'observation',
      groundId: ground.id,
      groundUrl: ground.url,
      emptyMsg: 'No Observations yet — page → data extraction primitives.',
      entries: observations.map(o => _renderObservationEntry(o)),
    })}

    ${_renderSection({
      key: 'analyses',
      label: 'Analyses',
      count: analyses.length,
      // v2.74.53 — + Analyze opens analysis-author sidepanel mode.
      addLabel: '+ Analyze',
      addKind: 'analysis',
      groundId: ground.id,
      emptyMsg: 'No Analyses yet.',
      entries: analyses.map(a => _renderAnalysisEntry(a)),
    })}
  `;
}

// v2.74.31 — Each section is its own collapsible card. Chevron toggle on
// the left of the head row hides the body. Collapse state tracked per
// (groundId, sectionKey) in _collapsedSections so toggling one section
// doesn't affect others.
// v2.74.35 — + Add moved out of the head row and into a right-aligned
// footer beneath the entries (mirrors the fragment-author + Action / pre
// & post + Add pattern).
function _renderSection({ key, label, count, addLabel, addKind, addButtons, headExtra, groundId, groundUrl, emptyMsg, entries }) {
  const body = entries.length === 0
    ? `<span class="empty-state small">${escHtml(emptyMsg)}</span>`
    : entries.join('');
  // v2.74.43 — A section can declare either a single {addLabel, addKind}
  // (most sections) or an array of `addButtons` (Perspectives, which offers
  // + Manual / + Auto). The latter wins when present.
  const buttons = Array.isArray(addButtons) && addButtons.length > 0
    ? addButtons
    : (addLabel ? [{ label: addLabel, kind: addKind }] : []);
  const addFooter = buttons.length > 0
    ? `<div class="gv-section-card-footer">${
        buttons.map(b => `
          <button class="btn-secondary fa-add-condition-btn"
                  data-gv-add="${escAttr(b.kind)}"
                  data-gid="${escAttr(groundId)}"
                  data-gurl="${escAttr(groundUrl ?? '')}"
                  type="button">${escHtml(b.label)}</button>`).join('')
      }</div>`
    : '';
  const collapsed = _collapsedSections.get(groundId)?.has(key) ?? false;
  const collapsedClass = collapsed ? ' gv-section-card-collapsed' : '';
  const glyph = collapsed ? '▸' : '▾';
  return `
    <section class="gv-section-card${collapsedClass}"
             data-gv-section-card="${escAttr(key)}"
             data-gv-section-gid="${escAttr(groundId)}">
      <div class="gv-section-card-head">
        <button class="gv-section-collapse-toggle"
                data-gv-section-toggle="${escAttr(key)}"
                data-gv-section-gid="${escAttr(groundId)}"
                type="button" title="Collapse / expand ${escAttr(label.toLowerCase())}"
                aria-expanded="${collapsed ? 'false' : 'true'}">
          <span class="gv-section-collapse-chevron">${glyph}</span>
        </button>
        <span class="ground-section-label">${escHtml(label)}</span>
        <span class="ground-section-count">${count}</span>
        ${headExtra || ''}
      </div>
      <div class="gv-section-card-body">
        ${body}
        ${addFooter}
      </div>
    </section>
  `;
}

// ─── Per-entry renderers ─────────────────────────────────────────────────
// Read-only: name + meta summary + optional description. No edit, no view-
// json, no per-row action buttons.

// v2.74.35 — Each entry now carries a ✕ delete button in its top-right
// corner (.gv-entry-delete). The delete button is wired in
// _wireHandlers; clicking dispatches the right DELETE_X message and
// re-renders the list.

function _deleteBtn(kind, id, name) {
  return `<button class="gv-entry-delete btn-action danger"
                  data-gv-del="${escAttr(kind)}"
                  data-gv-del-id="${escAttr(id)}"
                  data-gv-del-name="${escAttr(name ?? '')}"
                  type="button" title="Delete">✕</button>`;
}

// v2.74.47 — Edit button for entry rows that support inline editing.
// Mirrors Studio's fragment-row ✎ pattern (top-right action area, to
// the left of the ✕ delete). Currently used by perspective entries; can be
// reused for other entry kinds later.
function _editBtn(kind, id, name) {
  return `<button class="gv-entry-edit btn-action"
                  data-gv-edit="${escAttr(kind)}"
                  data-gv-edit-id="${escAttr(id)}"
                  data-gv-edit-name="${escAttr(name ?? '')}"
                  type="button" title="Edit">✎</button>`;
}

function _renderFragmentEntry(f, allFragments) {
  const tier = f.authoringTier ?? 'T3';
  const antecedentName = f.antecedentFragmentId
    ? (allFragments.find(x => x.id === f.antecedentFragmentId)?.name ?? '?')
    : null;
  return `
    <div class="fragment-row gv-entry">
      ${_editBtn('fragment', f.id, f.name)}
      ${_deleteBtn('fragment', f.id, f.name)}
      <div class="fragment-row-main">
        <span class="fragment-name">${escHtml(f.name ?? 'Unnamed')}</span>
        <span class="fragment-tier tier-${escAttr(tier.toLowerCase())}">${escHtml(tier)}</span>
        <span class="fragment-health health-${escAttr(f.healthStatus ?? 'untested')}">${escHtml(f.healthStatus ?? 'untested')}</span>
      </div>
      ${f.description ? `<div class="fragment-desc" style="white-space:pre-line">${escHtml(f.description)}</div>` : ''}
      ${antecedentName ? `<div class="fragment-antecedent-indicator">↑ after <strong>${escHtml(antecedentName)}</strong></div>` : ''}
      <div class="fragment-row-actions">
        <span class="fragment-meta">${(f.preconditions?.length ?? 0)} pre · ${(f.postconditions?.length ?? 0)} post · ${(f.params?.length ?? 0)} param${(f.params?.length === 1) ? '' : 's'}</span>
      </div>
    </div>`;
}

function _renderAssertionEntry(p) {
  const cs = p.body?.conditions ?? [];
  const mode = p.body?.match ?? 'all';
  const condSummary = cs.length === 0 ? '(empty)'
    : cs.length === 1 ? '1 condition'
    : mode === 'k_of_n' ? `${p.body?.count ?? '?'} of ${cs.length} conditions`
    : `${cs.length} conditions ${mode === 'any' ? 'OR' : 'AND'}`;
  return `
    <div class="assertion-row gv-entry">
      ${_deleteBtn('assertion', p.id, p.name)}
      <div class="assertion-row-main">
        <span class="assertion-name">${escHtml(p.name ?? 'Unnamed')}</span>
        <span class="assertion-summary">${escHtml(condSummary)}</span>
      </div>
      ${p.description ? `<div class="assertion-desc">${escHtml(p.description)}</div>` : ''}
    </div>`;
}

function _renderPerspectiveEntry(l) {
  const lmCount = Array.isArray(l.landmarks) ? l.landmarks.length : 0;
  return `
    <div class="perspective-row gv-entry">
      ${_editBtn('perspective', l.id, l.name)}
      ${_deleteBtn('perspective', l.id, l.name)}
      <div class="perspective-row-main">
        <span class="perspective-name">${escHtml(l.name ?? 'Unnamed')}</span>
        <span class="perspective-summary">${lmCount} landmark${lmCount === 1 ? '' : 's'}</span>
      </div>
      ${l.description ? `<div class="perspective-desc">${escHtml(l.description)}</div>` : ''}
    </div>`;
}

function _renderObservationEntry(o) {
  const impl = o.implementations?.[0] ?? {};
  const tier = impl.tier ?? 'cache';
  const extracts = Array.isArray(impl.extracts) ? impl.extracts : [];
  const outputSummary = extracts.length === 0
    ? '<em>no extracts</em>'
    : extracts.map(ex =>
        `<span class="observation-output">${escHtml(ex.output ?? '?')}<span class="observation-output-shape">:${escHtml(ex.shape ?? '?')}</span></span>`
      ).join(' ');
  return `
    <div class="observation-row gv-entry">
      ${_editBtn('observation', o.id, o.name)}
      ${_deleteBtn('observation', o.id, o.name)}
      <div class="observation-row-main">
        <span class="observation-name">${escHtml(o.name ?? 'Unnamed')}</span>
        <span class="observation-shape">${escHtml(tier === 'cache' ? 'T1' : 'T3')}</span>
        <span class="observation-extract-count">${extracts.length} extract${extracts.length === 1 ? '' : 's'}</span>
      </div>
      <div class="observation-outputs">${outputSummary}</div>
      ${o.description ? `<div class="observation-desc">${escHtml(o.description)}</div>` : ''}
    </div>`;
}

function _renderAnalysisEntry(a) {
  const impl0 = Array.isArray(a.implementations) && a.implementations.length > 0
    ? a.implementations[0]
    : null;
  const tier = impl0?.tier ?? 'cache';
  const paramsCount = Array.isArray(a.params) ? a.params.length : 0;
  const ops = impl0?.body?.operations ?? impl0?.operations ?? a.operations;
  const opsCount = Array.isArray(ops) ? ops.length : 0;
  const metaText = tier === 'frontier'
    ? `frontier · ${paramsCount} param${paramsCount === 1 ? '' : 's'}`
    : `${opsCount} op${opsCount === 1 ? '' : 's'} · ${paramsCount} param${paramsCount === 1 ? '' : 's'}`;
  return `
    <div class="analysis-row gv-entry">
      ${_deleteBtn('analysis', a.id, a.name)}
      <div class="analysis-row-main">
        <span class="analysis-name">${escHtml(a.name ?? 'Unnamed')}</span>
      </div>
      ${a.description ? `<div class="analysis-desc">${escHtml(a.description)}</div>` : ''}
      <div class="analysis-row-actions">
        <span class="analysis-meta">${escHtml(metaText)}</span>
      </div>
    </div>`;
}

// ─── Landmarks card (monitoring registry view) ───────────────────────────
// v2.74.866 — The Ground's registry landmarks are the set live monitoring
// resolves interactions against (LandmarkResolver.listLandmarksForGround —
// every saved landmark with a selector). They are NOT carried by
// GET_GROUND_LIBRARY (which returns Fragments / Perspectives / …), so the
// panel fetches them on demand via LIST_LANDMARKS_FOR_GROUND. A 0-landmark
// Ground is the usual reason every monitored interaction resolves to 'miss'.

async function _fetchLandmarks(groundId) {
  try {
    const res = await new Promise((r) =>
      chrome.runtime.sendMessage({ type: 'LIST_LANDMARKS_FOR_GROUND', payload: { groundId } }, r));
    return Array.isArray(res?.landmarks) ? res.landmarks : [];
  } catch {
    return [];
  }
}

function _renderLandmarksCard(landmarks, groundId, proposedCount = 0) {
  const list = Array.isArray(landmarks) ? landmarks : [];
  const collapsed = _collapsedLandmarks.has(groundId);
  const collapsedClass = collapsed ? ' gv-section-card-collapsed' : '';
  const glyph = collapsed ? '▸' : '▾';
  const emptyMsg = proposedCount > 0
    ? `<strong>0 verified</strong> landmarks — but this Ground's Perspectives reference <strong>${proposedCount}</strong> <em>proposed</em> landmark${proposedCount === 1 ? '' : 's'}. Those are unverified <code>{ref}</code> pointers; the selectors monitoring needs are minted only when you <strong>Resolve → Accept</strong> a Perspective. Verify one and this card (and the feed) start filling in.`
    : `No landmarks in this Ground's registry yet. Live monitoring resolves interactions against saved landmarks — until one exists here, every interaction is a <strong>miss</strong>. Run <strong>Explore → Resolve</strong> on a page, then <strong>Accept</strong> a Perspective, to populate it.`;
  const body = list.length === 0
    ? `<span class="empty-state small gv-lm-empty">${emptyMsg}</span>`
    : list.map(_renderLandmarkEntry).join('');
  return `
    <section class="gv-section-card gv-lm-card${collapsedClass}" data-gv-lm-card="${escAttr(groundId)}">
      <div class="gv-section-card-head">
        <button class="gv-section-collapse-toggle" type="button"
                data-gv-lm-toggle="${escAttr(groundId)}"
                title="Collapse / expand landmarks"
                aria-expanded="${collapsed ? 'false' : 'true'}">
          <span class="gv-section-collapse-chevron">${glyph}</span>
        </button>
        <span class="ground-section-label">Landmarks</span>
        <span class="ground-section-count">${list.length}</span>
      </div>
      <div class="gv-section-card-body">${body}</div>
    </section>
  `;
}

function _renderLandmarkEntry(l) {
  const role = l.a11yRole || l.alias || '—';
  const name = l.accessibleName || (Array.isArray(l.aliases) && l.aliases[0]) || '';
  const score = l.score || '';
  const scoreClass = score === 'ready' ? 'ready' : (score === 'mismatch' ? 'mismatch' : 'unknown');
  const sel = l.selector || '';
  const unlinked = l.perspectiveId ? '' : `<span class="gv-lm-tag" title="not referenced by a saved Perspective — still watched by monitoring">unlinked</span>`;
  return `
    <div class="gv-lm-row gv-entry">
      <div class="gv-lm-row-main">
        <span class="gv-lm-role">${escHtml(role)}</span>
        ${name ? `<span class="gv-lm-name">${escHtml(name)}</span>` : ''}
        ${score ? `<span class="gv-lm-score gv-lm-score--${scoreClass}">${escHtml(score)}</span>` : ''}
        ${unlinked}
      </div>
      ${sel ? `<div class="gv-lm-sel" title="${escAttr(sel)}">${escHtml(sel)}</div>` : ''}
    </div>`;
}

// Wires the Landmarks card's collapse chevron. Dedicated attribute
// (data-gv-lm-toggle) so it never collides with the generic section-toggle
// wiring in _wireHandlers — called in every matched render path.
function _wireLandmarksCard() {
  if (!_mountEl) return;
  _mountEl.querySelectorAll('[data-gv-lm-toggle]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const gid = btn.dataset.gvLmToggle;
      const card = btn.closest('.gv-lm-card');
      if (!card) return;
      const collapsed = card.classList.toggle('gv-section-card-collapsed');
      if (collapsed) _collapsedLandmarks.add(gid);
      else            _collapsedLandmarks.delete(gid);
      btn.setAttribute('aria-expanded', String(!collapsed));
      const chev = btn.querySelector('.gv-section-collapse-chevron');
      if (chev) chev.textContent = collapsed ? '▸' : '▾';
    });
  });
}

// ─── Handlers ────────────────────────────────────────────────────────────

function _wireHandlers(grounds) {
  if (!_mountEl) return;

  // v2.74.42 — Header collapse + map-badge toggle wiring also runs in
  // the header-only render paths. _wireHeaderHandlers is the shared
  // subset; _wireHandlers calls it first, then layers per-section
  // / per-entry handlers on top.
  for (const entry of grounds) _wireHeaderHandlers(entry);

  // v2.74.31 — Per-section collapse toggles. State lives in
  // _collapsedSections keyed by groundId so per-section collapse
  // survives a re-render driven by a tab change or a storage update.
  _mountEl.querySelectorAll('[data-gv-section-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.gvSectionToggle;
      const gid = btn.dataset.gvSectionGid;
      const card = btn.closest('.gv-section-card');
      const collapsed = card.classList.toggle('gv-section-card-collapsed');
      let set = _collapsedSections.get(gid);
      if (!set) { set = new Set(); _collapsedSections.set(gid, set); }
      if (collapsed) set.add(key);
      else            set.delete(key);
      btn.setAttribute('aria-expanded', String(!collapsed));
      const chev = btn.querySelector('.gv-section-collapse-chevron');
      if (chev) chev.textContent = collapsed ? '▸' : '▾';
    });
  });

  // + Add buttons. Each opens a sidepanel-authorable flow; the
  // requested mode replaces this ground-view mode in the shell, so
  // returning to the browse view requires re-opening Ground from the
  // extension icon.
  _mountEl.querySelectorAll('[data-gv-add]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.gvAdd;
      const gid  = btn.dataset.gid;
      const gurl = btn.dataset.gurl || null;
      await _launchAuthoring(kind, gid, gurl);
    });
  });

  // v2.74.47 — Per-entry ✎ edit buttons.
  //   perspective      → BEGIN_PERSPECTIVE_CAPTURE with prefilledPerspective (verified
  //                 state + urlPattern + authoredBy preserved)
  //   fragment    → BEGIN_FRAGMENT_AUTHOR in rewalk-mode with the saved
  //                 rawJson parsed into prefilledActions (mirrors Studio's
  //                 re-walk dispatch)
  //   observation → BEGIN_OBSERVATION_AUTHOR with the existing
  //                 observationId so the author mode loads the saved
  //                 record (v2.74.142 — matches Studio's walk-observation
  //                 dispatch). Existing extracts surface via the JSON
  //                 modal; the live-page authoring re-walks them.
  _mountEl.querySelectorAll('[data-gv-edit]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const kind = btn.dataset.gvEdit;
      const id   = btn.dataset.gvEditId;
      if (kind === 'perspective') {
        await _editPerspective(id, grounds);
        return;
      }
      if (kind === 'fragment') {
        await _editFragment(id, grounds);
        return;
      }
      if (kind === 'observation') {
        await _editObservation(id, grounds);
        return;
      }
    });
  });

  // v2.74.35 — Per-entry ✕ delete buttons. Maps the entry kind to its
  // DELETE_X background message + id field. Confirms before destructive
  // action; re-renders the list after success so the row vanishes.
  _mountEl.querySelectorAll('[data-gv-del]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const kind = btn.dataset.gvDel;
      const id   = btn.dataset.gvDelId;
      const name = btn.dataset.gvDelName || id;
      if (!confirm(`Delete ${kind} "${name}"? This cannot be undone.`)) return;
      btn.disabled = true;
      const res = await _deleteEntry(kind, id);
      if (!res?.success) {
        toast(`Delete failed: ${res?.error ?? 'unknown'}`, 'err');
        btn.disabled = false;
        return;
      }
      toast(`${kind.charAt(0).toUpperCase()}${kind.slice(1)} "${name}" deleted`);
      // Re-render — STORAGE_CHANGED would catch this too, but a direct
      // call keeps the response immediate.
      await _renderList();
    });
  });

  // §18 (v2.74.1277) — Ride recipe PROMOTION from the panel (no longer Studio-only). Per-recipe ✓ accept / ✕ reject →
  // EDIT_RIDE_RECIPE review; the head "✓ N reads" → BULK_REVIEW_RIDE_RECIPES (auto/GET only — writes never bulk). Each
  // carries its own groundId; on success a full re-render reflects the new reviewState (and the recipe becomes armable).
  _mountEl.querySelectorAll('[data-gv-ride-op]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      const value = btn.dataset.gvRideVal;
      const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'EDIT_RIDE_RECIPE', payload: { groundId: btn.dataset.gvRideGid, id: btn.dataset.gvRideId, op: 'review', value } }, r));
      if (res?.success) { toast(`Recipe ${value === 'accept' ? 'accepted' : 'rejected'}`); await _renderList(); }
      else { toast(`Failed: ${res?.error ?? 'unknown'}`, 'err'); btn.disabled = false; }
    });
  });
  _mountEl.querySelectorAll('[data-gv-ride-bulk]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'BULK_REVIEW_RIDE_RECIPES', payload: { groundId: btn.dataset.gvRideBulk, scope: 'reads' } }, r));
      if (res?.success) { toast(`Accepted ${res.accepted} read${res.accepted === 1 ? '' : 's'}`); await _renderList(); }
      else { toast(`Bulk accept failed: ${res?.error ?? 'unknown'}`, 'err'); btn.disabled = false; }
    });
  });
  // §19 (passive toggle v2.74.1284) — "⛏ Forage" toggles passive capture. ARM (1st click): pass the panel's ACTIVE (logged-
  // in) tab as sessionTabId; background arms the tee on it. The user then navigates their app — its API reads (incl. cross-
  // origin) are captured. BANK (2nd click): background drains + banks `pending`, broadcasting FORAGE_COMPLETE.
  _mountEl.querySelectorAll('[data-gv-ride-forage]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      const groundId = btn.dataset.gvRideForage;
      let sessionTabId = null;
      try {
        const q = typeof _windowId === 'number' ? { active: true, windowId: _windowId } : { active: true, currentWindow: true };
        const [t] = await chrome.tabs.query(q);
        sessionTabId = typeof t?.id === 'number' ? t.id : null;
      } catch { /* */ }
      const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'FORAGE', payload: { groundId, sessionTabId } }, r));
      if (res?.success && res.armed) { _forageArmed.add(groundId); toast('Foraging — your app tab reloads to capture; open a few sections, then click ⛏ to bank'); await _renderList(); }
      else if (res?.success && res.banking) { toast('Banking foraged reads…'); /* FORAGE_COMPLETE finishes + re-renders */ }
      else { _forageArmed.delete(groundId); toast(`Forage: ${res?.error ?? 'failed'}`, 'err'); btn.disabled = false; }
    });
  });
}

// v2.74.434 — Toggle the inline siteMap viewer for a ground (was the GroundMap
// viewer). Open state in _openSiteMaps persists across re-renders so the viewer
// doesn't snap shut on a STORAGE_CHANGED tick.
function _toggleSiteMapViewer(groundId) {
  const viewer = _mountEl?.querySelector(`[data-gv-gm-viewer="${CSS.escape(groundId)}"]`);
  if (!viewer) return;
  if (_openSiteMaps.has(groundId)) {
    _openSiteMaps.delete(groundId);
    viewer.classList.add('hidden');
    viewer.innerHTML = '';
    return;
  }
  const siteMap = _siteMapCache.get(groundId);
  if (!siteMap) return;
  _openSiteMaps.add(groundId);
  viewer.innerHTML = _renderSiteMapHtml(siteMap);
  viewer.classList.remove('hidden');
}

// v2.74.434 — Render the Ground siteMap (GROUND_SPEC § 7) as a node list,
// mirroring Studio's "Site Map" section. Reuses the .sitemap-* classes in
// sidepanel.css. Modeled nodes (● — captured Locales) first, then discovered
// (○ — nav destinations / crawled pages), capped at 20.
function _renderSiteMapHtml(siteMap) {
  const nodes = siteMap?.nodes ? Object.values(siteMap.nodes) : [];
  if (nodes.length === 0) return '<div class="gm-empty">No site map yet.</div>';
  // String-strip the origin (NOT new URL — patterns contain {id} which URL would %7B-encode).
  const shortPath = (pat) => (pat || '').replace(/^https?:\/\/[^/]+/i, '') || '/';
  const modeled = nodes.filter(n => n.status === 'modeled');
  const discovered = nodes.filter(n => n.status === 'discovered');
  const stub = nodes.filter(n => n.status !== 'modeled' && n.status !== 'discovered');
  const edges = Array.isArray(siteMap.edges) ? siteMap.edges.length : 0;
  const pagesTotal = nodes.reduce((s, n) => s + (n.instanceCount || 0), 0);
  const nodeRow = (n) => `
      <div class="sitemap-node sitemap-${escAttr(n.status)}">
        <span class="sitemap-node-status">${n.status === 'modeled' ? '●' : (n.status === 'discovered' ? '◐' : '○')}</span>
        <span class="sitemap-node-name" title="${escAttr(n.urlPattern || '')}">${escHtml(n.name || shortPath(n.urlPattern || ''))}</span>
        <span class="sitemap-node-meta">${escHtml(shortPath(n.urlPattern || ''))}${n.instanceCount > 1 ? ` · ×${n.instanceCount}` : ''}${n.goals?.length ? ` · ${n.goals.length} goal(s)` : ''}</span>
      </div>`;
  // v2.74.442 — Coverage (slice 5): proportional modeled/discovered/stub bar + "% modeled".
  const total = nodes.length;
  const pct = total ? Math.round((modeled.length / total) * 100) : 0;
  const localesCount = new Set(nodes.flatMap(n => n.locales || [])).size;
  const seg = (n, color) => (total && n) ? `<span style="display:inline-block;height:100%;width:${(n / total * 100).toFixed(1)}%;background:${color}"></span>` : '';
  const coverageHtml = total ? `
    <div class="sitemap-coverage" title="${modeled.length} modeled · ${discovered.length} discovered · ${stub.length} stub of ${total} archetypes">
      <div style="display:flex;height:6px;border-radius:3px;overflow:hidden;background:rgba(127,127,127,.18);margin:2px 0 4px">${seg(modeled.length, '#3fb950')}${seg(discovered.length, '#d29922')}${seg(stub.length, '#6e7681')}</div>
      <div style="font-size:11px;opacity:.75"><strong>${pct}% modeled</strong> · ${modeled.length}/${total} archetypes · ${edges} edge(s)${pagesTotal > total ? ` · ~${pagesTotal} pages` : ''}${localesCount > 1 ? ` · 🌐 ${localesCount} langs` : ''}</div>
    </div>` : '';
  // v2.74.439 — render stubs too (capped), so a sitemap-ingested ground shows its
  // known archetypes immediately instead of an empty list under "N stub".
  return `
    ${coverageHtml}
    <div class="sitemap-nodes">${modeled.map(nodeRow).join('')}${discovered.slice(0, 20).map(nodeRow).join('')}${discovered.length > 20 ? `<div class="empty-state small">+${discovered.length - 20} more discovered</div>` : ''}${stub.slice(0, 25).map(nodeRow).join('')}${stub.length > 25 ? `<div class="empty-state small">+${stub.length - 25} more stub</div>` : ''}</div>`;
}

// v2.74.42 — Header-card handlers (collapse chevron + map-badge toggle).
// Run for every render path that shows a Ground header — full view,
// discovering view, undiscovered view. Idempotent.
function _wireHeaderHandlers(entry) {
  const { ground } = entry;
  // Map-badge toggle (when a siteMap exists).
  _mountEl.querySelectorAll(`[data-gv-toggle-map="${CSS.escape(ground.id)}"]`).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _toggleSiteMapViewer(ground.id);
    });
  });
  // Header collapse toggle. Hides url + meta + description while
  // keeping name + chevron visible (same UX as the section card
  // chevrons elsewhere in the sidepanel).
  _mountEl.querySelectorAll(`[data-gv-toggle-header="${CSS.escape(ground.id)}"]`).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.gv-ground-card');
      const collapsed = card.classList.toggle('gv-ground-card-collapsed');
      if (collapsed) _collapsedHeader.add(ground.id);
      else            _collapsedHeader.delete(ground.id);
      btn.setAttribute('aria-expanded', String(!collapsed));
      const chev = btn.querySelector('.gv-ground-collapse-chevron');
      if (chev) chev.textContent = collapsed ? '▸' : '▾';
    });
  });
}

// v2.74.42 — Wire the inline Discover button shown when a Ground exists
// but has no map yet. Reuses the same kickoff logic as the new-ground
// card's Discover handler (saves nothing — the Ground already exists).
function _wireDiscoverPromptHandler(ground) {
  const btn = _mountEl?.querySelector(`[data-gv-discover-existing="${CSS.escape(ground.id)}"]`);
  if (!btn) return;
  btn.addEventListener('click', () => _kickoffDiscovery(ground.id));
}

// v2.74.42 — Shared kickoff: API-key check, mark _discoveryRunning,
// dispatch START_DISCOVERY with existingTabId, then re-render so the
// indeterminate spinner replaces the prompt. Used by both the new-ground
// card's Discover button (after it persists the Ground) and the
// undiscovered-prompt's Discover button.
async function _kickoffDiscovery(groundId) {
  const keyRes = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'CHECK_API_KEY' }, resolve);
  });
  if (!keyRes?.hasKey) {
    toast('Sign in to the cloud or add an Anthropic API key in Studio Settings', 'err');
    return;
  }
  const tab = await _getActiveTabForLaunch();
  const existingTabId = tab?.id ?? null;
  _discoveryRunning.add(groundId);
  await _renderList();   // swap to the spinner view immediately
  chrome.runtime.sendMessage({
    type: 'START_DISCOVERY',
    payload: { groundId, existingTabId },
  }, (res) => {
    if (!res?.success) {
      _discoveryRunning.delete(groundId);
      toast(`Discovery failed: ${res?.error ?? 'unknown'}`, 'err');
      _renderList().catch(() => {});
    }
  });
}

// v2.74.59 — Edit Perspective. Looks the existing record up from the
// in-memory grounds list, dispatches BEGIN_PERSPECTIVE_CAPTURE with the
// full record as prefilledPerspective (verified state + urlPattern +
// authoredBy preserved).
async function _editPerspective(id, grounds) {
  let perspective = null;
  let groundId = null;
  for (const entry of grounds) {
    const found = entry.perspectives?.find(l => l.id === id);
    if (found) { perspective = found; groundId = entry.ground.id; break; }
  }
  if (!perspective || !groundId) {
    toast('Perspective not found', 'err');
    return;
  }
  const tab = await _getActiveTabForLaunch();
  const existingTabId = tab?.id ?? null;
  chrome.runtime.sendMessage({
    type: 'BEGIN_PERSPECTIVE_CAPTURE',
    payload: {
      groundId,
      existingTabId,
      returnTo: 'ground-view',
      prefilledPerspective: {
        // v2.74.275 — Legacy embedded landmarks[] + urlPattern fields
        // removed. Pass through landmarkRefs[] (registry uids) and
        // predicates only.
        id          : perspective.id,
        name        : perspective.name        ?? '',
        description : perspective.description ?? '',
        authoredBy  : perspective.authoredBy  ?? 'human',
        landmarkRefs: Array.isArray(perspective.landmarkRefs) ? perspective.landmarkRefs : [],
        // v2.74.349 — Pass the structured composition + overlays so the
        // structure review / judgment-aware Re-structure / role authoring
        // round-trip on edit (perspective-capture only treats it as structure when
        // it's non-trivial — see prefill). landmarks is a LandmarkNode[].
        landmarks   : Array.isArray(perspective.landmarks) ? perspective.landmarks : null,
        groupings   : Array.isArray(perspective.groupings) ? perspective.groupings : null,
        sequences   : Array.isArray(perspective.sequences) ? perspective.sequences : null,
        predicates  : perspective.predicates ?? [],
        iframeContexts: Array.isArray(perspective.iframeContexts) ? perspective.iframeContexts : [],
      },
    },
  });
}

// v2.74.59 — Edit Fragment. Looks the existing record up from the
// in-memory grounds list, parses its rawJson into prefilledActions,
// and dispatches BEGIN_FRAGMENT_AUTHOR with isRewalk=true. Mirrors
// Studio's rewalkFragment dispatch so the same fragment-author
// re-walk path runs (existing actions repopulate the list with
// verified=null; user re-verifies any rows that still apply).
async function _editFragment(id, grounds) {
  let fragment = null;
  let groundUrl = null;
  let groundId = null;
  for (const entry of grounds) {
    const found = entry.fragments?.find(f => f.id === id);
    if (found) {
      fragment = found;
      groundId = entry.ground.id;
      groundUrl = entry.ground.url;
      break;
    }
  }
  if (!fragment || !groundId) {
    toast('Fragment not found', 'err');
    return;
  }
  let prefilledActions = null;
  if (fragment.rawJson) {
    try {
      const parsed = JSON.parse(fragment.rawJson);
      if (Array.isArray(parsed)) prefilledActions = parsed;
    } catch (e) {
      toast(`Could not parse fragment rawJson: ${e.message}`, 'err');
      return;
    }
  }
  const tab = await _getActiveTabForLaunch();
  const existingTabId = tab?.id ?? null;
  chrome.runtime.sendMessage({
    type: 'BEGIN_FRAGMENT_AUTHOR',
    payload: {
      fragmentId : fragment.id,
      groundId,
      groundUrl  : fragment.startUrl ?? groundUrl,
      name       : '',                 // mode reads rewalkName for the banner
      description: '',
      pageClass  : fragment.pageClass ?? null,
      isRewalk   : true,
      antecedentFragmentId    : fragment.antecedentFragmentId    ?? null,
      antecedentParamBindings : fragment.antecedentParamBindings ?? null,
      prefilledActions,
      // v2.74.185 — Carry the saved pre/post conditions into the editor.
      // Previously omitted, so fragment-author would show an empty
      // pre/post list on edit-open and then auto-overwrite via
      // _capturePreconditions / _capturePostconditions — the saved
      // values weren't even visible to the author, and re-saving
      // could silently replace them with newly-captured ones.
      prefilledPreconditions  : Array.isArray(fragment.preconditions)  ? fragment.preconditions  : [],
      prefilledPostconditions : Array.isArray(fragment.postconditions) ? fragment.postconditions : [],
      rewalkName        : fragment.name,
      rewalkDescription : fragment.description,
      existingTabId,
      returnTo: 'ground-view',
    },
  });
}

// Edit Observation — opens the saved record in observation-author mode
// for in-place editing. Mirrors the fragment ✎ pattern.
//
// v2.74.143 — Initial wiring (passed only name + description). That left
// the mode opening with empty extracts / preconditions / postconditions
// — looked indistinguishable from a fresh New Observation form.
// v2.74.149 — Forward the full record so the mode actually seeds the
// saved state: extracts (from implementations[0].extracts),
// preconditions, postconditions. Save reuses the existing observationId
// so the persisted record is overwritten in place, not duplicated.
//
// NB: this differs from the "walk" semantics on Studio's observation row
// (studio.js → walk-observation), which intentionally re-authors
// extracts from scratch and leaves the saved values reachable only via
// the JSON modal. Edit is for in-place tweaks; Walk is for re-recording.
async function _editObservation(id, grounds) {
  let observation = null;
  let groundId = null;
  let groundUrl = null;
  for (const entry of grounds) {
    const found = entry.observations?.find(o => o.id === id);
    if (found) {
      observation = found;
      groundId = entry.ground.id;
      groundUrl = entry.ground.url;
      break;
    }
  }
  if (!observation || !groundId) {
    toast('Observation not found', 'err');
    return;
  }

  // Pull extracts from the canonical post-v2.72.11 location
  // (implementations[0].extracts). Fall back to the top-level legacy
  // `extracts` field for records that haven't yet been migrated.
  const impl0 = Array.isArray(observation.implementations) && observation.implementations.length > 0
    ? observation.implementations[0] : null;
  const savedExtracts = Array.isArray(impl0?.extracts)
    ? impl0.extracts
    : (Array.isArray(observation.extracts) ? observation.extracts : []);

  // v2.74.158 — Frontier-tier observations can't be edited in the
  // sidepanel observation-author mode (that mode authors cache-tier
  // extracts only — selectors, rects, etc.). The previous Edit pencil
  // silently routed frontier records through it, and the mode's save
  // path then hardcoded `tier: 'cache'`, downgrading the record on
  // every save. Block here with a toast pointing to Studio's full
  // observation editor, which DOES handle both tiers.
  const savedTier = impl0?.tier ?? observation.tier ?? 'cache';
  if (savedTier === 'frontier') {
    toast('Frontier-tier Observations must be edited in Studio (Ground card → ✎ Edit).', 'warn');
    return;
  }

  const tab = await _getActiveTabForLaunch();
  const existingTabId = tab?.id ?? null;

  chrome.runtime.sendMessage({
    type: 'BEGIN_OBSERVATION_AUTHOR',
    payload: {
      observationId: observation.id,
      groundId,
      groundUrl,
      name        : observation.name        ?? '',
      description : observation.description ?? '',
      // Full-record seed — observation-author's mount reads these to
      // pre-populate the draft instead of starting empty.
      prefilledExtracts      : savedExtracts,
      prefilledPreconditions : Array.isArray(observation.preconditions)  ? observation.preconditions  : [],
      prefilledPostconditions: Array.isArray(observation.postconditions) ? observation.postconditions : [],
      // Tier carries forward — frontier-tier records mustn't be reopened
      // as cache and vice versa.
      tier        : impl0?.tier ?? observation.tier ?? 'cache',
      existingTabId,
      returnTo: 'ground-view',
    },
  });
}

async function _deleteEntry(kind, id) {
  // Mapping: kind → { messageType, idField }
  const map = {
    fragment   : { type: 'DELETE_FRAGMENT',    field: 'fragmentId'    },
    assertion  : { type: 'DELETE_ASSERTION',   field: 'assertionId'   },
    perspective     : { type: 'DELETE_PERSPECTIVE',      field: 'perspectiveId'      },
    observation: { type: 'DELETE_OBSERVATION', field: 'observationId' },
    analysis   : { type: 'DELETE_ANALYSIS',    field: 'analysisId'    },
  };
  const m = map[kind];
  if (!m) return { success: false, error: `unknown entry kind: ${kind}` };
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: m.type, payload: { [m.field]: id } }, resolve);
  });
}

// v2.74.31 — Look up the active tab in this sidepanel's window and pass
// its id as existingTabId to the BEGIN_X message. Background reuses that
// tab instead of opening a fresh one at the Ground's stored URL, so
// authoring starts on the page the user is currently looking at.
async function _getActiveTabForLaunch() {
  if (_windowId == null) return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId: _windowId });
    return tab ?? null;
  } catch {
    return null;
  }
}

async function _launchAuthoring(kind, groundId, groundUrl) {
  const tab = await _getActiveTabForLaunch();
  const existingTabId = tab?.id ?? null;

  // v2.74.33 — returnTo tells the launched mode to come BACK to the
  // Ground sidepanel on Save / Cancel instead of exiting to Studio.
  const returnTo = 'ground-view';

  if (kind === 'fragment') {
    const fragmentId = `frag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    chrome.runtime.sendMessage({
      type: 'BEGIN_FRAGMENT_AUTHOR',
      payload: {
        fragmentId, groundId, groundUrl,
        name: '', description: '', pageClass: null, isRewalk: false,
        antecedentFragmentId: null, antecedentParamBindings: null,
        existingTabId, returnTo,
      },
    });
    return;
  }
  if (kind === 'observation') {
    const observationId = `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    chrome.runtime.sendMessage({
      type: 'BEGIN_OBSERVATION_AUTHOR',
      payload: { observationId, groundId, groundUrl, name: '', description: '', existingTabId, returnTo },
    });
    return;
  }
  if (kind === 'perspective') {
    chrome.runtime.sendMessage({
      type: 'BEGIN_PERSPECTIVE_CAPTURE',
      payload: { groundId, existingTabId, returnTo },
    });
    return;
  }
  // v2.74.53 — + Assert / + Analyze. Each dispatches a BEGIN_*_AUTHOR
  // background message; background sets the sidepanel mode and the
  // shell mounts the corresponding authoring panel. Same returnTo
  // convention as the other Ground-launched flows.
  if (kind === 'assertion') {
    chrome.runtime.sendMessage({
      type: 'BEGIN_ASSERTION_AUTHOR',
      payload: { groundId, existingTabId, returnTo },
    });
    return;
  }
  if (kind === 'analysis') {
    chrome.runtime.sendMessage({
      type: 'BEGIN_ANALYSIS_AUTHOR',
      payload: { groundId, existingTabId, returnTo },
    });
    return;
  }
  toast(`Authoring "${kind}" lives in Studio`, 'warn');
}

// v2.74.392 — _autoDiscoverPerspective removed: "+ Perspective" no longer Claude-suggests
// landmarks; it opens a blank draft (the description-first propose→resolve→
// auto-structure flow does the authoring).

export default { name: 'ground-view', mount, unmount, handleEvent };
