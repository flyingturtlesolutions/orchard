// Core/conversationPeek.js — a deterministic "quick peek" into a conversation for the drawer's under-the-name
// preview (v2.74.1217): the most recent substantive user/assistant message, stripped to plain text + length-capped.
// PURE: no chrome / DOM / LLM. The renderer escapes the string (it's untrusted message text) and CSS clamps it to
// 3 lines. This is the deterministic baseline — a recent-activity peek; an LLM-synthesized "direction summary" can
// later replace the stored string IN PLACE (same index field, same render slot) without touching the display path.

const _collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Strip light markdown + any HTML to readable plain text. PURE. Heading/blockquote/bullet markers are removed only
 * at LINE START, so an inline `#1` ticket reference (or a mid-line `>`) survives intact.
 */
export function peekText(body) {
  let s = String(body || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');            // fenced code blocks → drop
  s = s.replace(/<[^>]+>/g, ' ');                   // HTML tags → space (defence-in-depth; the render also escapes)
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');      // images → drop
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');    // links → their visible text (url dropped)
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');         // ATX heading markers (line-start only — keeps inline `#1`)
  s = s.replace(/^\s{0,3}>\s+/gm, '');              // blockquote markers (line-start)
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, '');          // list bullets (line-start)
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');          // bold
  s = s.replace(/\*([^*\n]+)\*/g, '$1');            // italic
  s = s.replace(/`([^`]+)`/g, '$1');                // inline code
  return _collapse(s);
}

/**
 * The conversation's "where it stands" peek, plain-text + capped, or ''. PURE. v2.74.1225 — prefers the LAST LLM
 * (assistant) reply: that's the conversation's current state, and it's stable while you type the next ask. Falls back
 * to the last user message only when there's no assistant reply yet (a fresh ask), so the card is never blank. Skips
 * system/thinking/empty messages. The cap is generous (the drawer clamps to 3 lines, expanding to the full text on
 * hover — so this is the hover payload).
 */
export function conversationPeek(messages, { maxChars = 400 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {            // the last LLM reply wins
    const m = list[i];
    if (!m || m.role !== 'assistant') continue;
    const text = peekText(m.body);
    if (text) return text.slice(0, maxChars);
  }
  for (let i = list.length - 1; i >= 0; i--) {            // none yet → the last user ask, so the card isn't blank
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    const text = peekText(m.body);
    if (text) return text.slice(0, maxChars);
  }
  return '';
}
