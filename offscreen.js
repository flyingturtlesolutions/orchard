/**
 * @file offscreen.js
 * @description Offscreen document worker for the click_copy extraction
 * shape. Reads navigator.clipboard.readText() on demand from background.
 *
 * v2.74.220 — Introduced to work around Chrome's focus requirement on
 * Clipboard.readText() in MV3. Content scripts and the side panel
 * can't reliably read the clipboard during sidepanel-initiated verify
 * because their documents lack OS focus. Offscreen documents created
 * with reasons:['CLIPBOARD'] are the canonical MV3 escape hatch — they
 * have clipboard access without focus.
 *
 * Message contract:
 *   { type: 'OFFSCREEN_READ_CLIPBOARD' }  →
 *     { success: true,  text: '<clipboard contents>' }
 *     { success: false, error: '<failure reason>' }
 *
 * Only handles its own message type — ignores everything else so the
 * background's own runtime.onMessage handlers can coexist on the same
 * sendMessage broadcast.
 *
 * @module offscreen
 * @version 2.74.220
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'OFFSCREEN_READ_CLIPBOARD') return false;
  try {
    // v2.74.221 — Use the textarea + execCommand('paste') pattern. The
    // initial v2.74.220 attempt called navigator.clipboard.readText()
    // directly in the offscreen doc, but Chrome still rejected it
    // with "Document is not focused" — offscreen documents are
    // background contexts that don't get OS focus automatically.
    //
    // The blessed MV3 pattern (per Chrome's official offscreen-
    // clipboard sample) is:
    //   1. Create a hidden textarea
    //   2. Focus it (an element having focus satisfies the document-
    //      has-focus check)
    //   3. Run execCommand('paste') — deprecated but still supported
    //      and uniquely works in this context
    //   4. Read textarea.value
    // This works regardless of whether the side panel, tab, or any
    // other UI has OS-level focus. The clipboardRead permission +
    // the offscreen doc's CLIPBOARD reason are what authorize the
    // read; the textarea is the focus surface required by the API.
    const textarea = document.createElement('textarea');
    // Off-screen positioning so we don't briefly paint the input.
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    textarea.setAttribute('aria-hidden', 'true');
    document.body.appendChild(textarea);
    textarea.focus();
    const ok = document.execCommand('paste');
    const text = textarea.value;
    textarea.remove();
    if (ok) {
      sendResponse({ success: true, text: text ?? '' });
    } else {
      sendResponse({
        success: false,
        error: 'offscreen execCommand("paste") returned false — clipboard may be empty or read was blocked',
      });
    }
  } catch (err) {
    sendResponse({
      success: false,
      error: `offscreen clipboard read failed: ${err?.message ?? String(err)}`,
    });
  }
  return false;   // synchronous response — sendResponse already called
});
