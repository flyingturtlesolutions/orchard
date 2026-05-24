/**
 * popup.js — extension icon dropdown menu.
 *
 * v2.72.50 (Stage 1) — Two entry points: Studio (full-page tab) and Chat
 * (side panel). The debugger entry was removed; debugging is no longer
 * a top-level surface but a sidepanel mode launched contextually from
 * Studio (▶ on a strategy, + Perspective on a ground, etc.). Perspective capture,
 * strategy debug, and future modes (fragment walk, observation trace)
 * all launch from Studio.
 */

document.getElementById('pop-studio').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
  window.close();
});

document.getElementById('pop-chat').addEventListener('click', async () => {
  // Switch the side panel to chat.html and open it on the active tab.
  // Stage 3 of the multi-mode-sidepanel refactor will collapse chat.html
  // into the shell as a chat mode; until then, chat keeps its own HTML.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) {
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'chat.html',
      enabled: true,
    });
    await chrome.sidePanel.open({ tabId: tab.id });
  }
  window.close();
});

// v2.74.27 — Ground entry. Opens the standard sidepanel.html and switches
// the shell into the 'ground-view' mode (a read-only browse view that
// mirrors Studio's Ground card layout, minus Strategies and per-row
// edit/json buttons).
//
// v2.74.30 — Uses WINDOW-scoped setOptions + open instead of per-tab so
// the panel persists when the user switches tabs in the same window.
// Per-tab scoping (the pattern Chat uses) tears the panel down on tab
// switch and falls back to the manifest default (chat.html), which broke
// the "update Ground when the active tab changes" UX. Mirrors the
// Studio launchers (BEGIN_FRAGMENT_AUTHOR etc.) which all use this
// window-scoped pattern.
//
// v2.74.125 — Bug fix: opening Ground after Chat used to no-op visually.
// Chat's launcher sets a PER-TAB override (`setOptions({tabId, path:
// 'chat.html'})`). Per Chrome's sidePanel API, per-tab overrides take
// precedence over window-scoped settings on that tab. The Ground
// launcher previously only set the window-scoped path, so on a tab that
// had Chat open, the per-tab `chat.html` kept winning and Ground never
// appeared. Fix: ALSO override the active tab's per-tab path to
// `sidepanel.html` so Ground displaces Chat on the current tab. The
// window-scoped path is kept too so other tabs in the window pick up
// Ground when activated.
document.getElementById('pop-ground').addEventListener('click', async () => {
  try {
    // Window-scoped first — applies to every tab in this window that
    // doesn't have a per-tab override of its own. Preserves the v2.74.30
    // tab-tracking behavior.
    await chrome.sidePanel.setOptions({
      path: 'sidepanel.html',
      enabled: true,
    });
    // Then override the active tab specifically so any prior Chat
    // launch's per-tab `chat.html` setting is displaced.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) {
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: 'sidepanel.html',
        enabled: true,
      });
    }
    const win = await chrome.windows.getCurrent();
    if (win?.id != null) {
      await chrome.sidePanel.open({ windowId: win.id });
    }
  } catch (e) {
    console.warn('[popup] ground: sidePanel.open failed', e?.message);
  }
  chrome.runtime.sendMessage({
    type: 'REQUEST_SIDEPANEL_MODE',
    payload: { mode: 'ground-view', payload: {} },
  });
  window.close();
});
