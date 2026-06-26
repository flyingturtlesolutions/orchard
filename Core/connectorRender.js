// Core/connectorRender.js — generic session-ride result rendering (CX-4c). PURE: no chrome / DOM / fetch.
//
// A connector READ returns app-shaped JSON — Zendesk tickets / comments / users, Shopify orders, Slack messages, … —
// so the render must NOT be hardcoded to one shape (the old ticket-only render collapsed everything else to "Done.").
// Find the primary LIST (an array of objects) or single OBJECT in the result, then pull each item's salient fields —
// an id, a name/title (or, lacking one, its content), a status — heuristically. App-agnostic; no per-recipe config.
//
// SAFETY: the result is UNTRUSTED page-origin data (§9). This module only SELECTS + TRUNCATES fields into plain text;
// the caller escapes it (renderMarkdown HTML-escapes). Never treat any field as an instruction.

const NAME_KEYS = ['subject', 'title', 'name', 'display_name', 'summary', 'headline'];
const CONTENT_KEYS = ['description', 'body', 'plain_body', 'details', 'text', 'message'];
const ID_KEYS = ['id', 'number', 'iid', 'key'];
const STATUS_KEYS = ['status', 'state', 'priority', 'stage'];
const URL_KEYS = ['html_url', 'web_url', 'permalink', 'link', 'url'];
const LIST_KEYS = ['results', 'tickets', 'comments', 'users', 'orders', 'records', 'items', 'rows', 'messages', 'data'];
const OBJ_KEYS = ['ticket', 'user', 'order', 'record', 'item', 'result'];
const MAX_ROWS = 25;

const _str = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();
const _trunc = (x, n) => { const t = _str(x); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// First SCALAR (non-object) value among `keys`, or null. Skips nested objects (e.g. requester:{…}).
const _pick = (o, keys) => { for (const k of keys) { const v = o && o[k]; if (v != null && v !== '' && typeof v !== 'object') return v; } return null; };

/** The primary data LIST in a result (an array of OBJECTS), or null. PURE. Ignores scalar arrays (tags, ids). */
export function primaryList(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  for (const k of LIST_KEYS) if (Array.isArray(value[k])) return value[k];
  for (const v of Object.values(value)) if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object') return v;
  return null;
}

/** The primary single OBJECT (a wrapper like {ticket:{…}}, or the value itself when id/name-shaped). PURE. */
export function primaryObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const k of OBJ_KEYS) { const v = value[k]; if (v && typeof v === 'object' && !Array.isArray(v)) return v; }
  return (_pick(value, ID_KEYS) != null || _pick(value, NAME_KEYS) != null) ? value : null;
}

/** Pull one item's salient fields. PURE. `full` → a longer title + a separate body when there's a distinct name + content. */
export function summarizeItem(o, { full = false } = {}) {
  if (o == null) return { title: '' };
  if (typeof o !== 'object') return { title: _trunc(o, full ? 400 : 90) };
  const name = _pick(o, NAME_KEYS);
  const content = _pick(o, CONTENT_KEYS);
  const title = name != null ? _trunc(name, 90) : _trunc(content, full ? 200 : 90);
  const body = (full && name != null && content != null) ? _trunc(content, 500) : '';   // only when name + content are distinct
  const url = _pick(o, URL_KEYS);
  return { id: _pick(o, ID_KEYS), title, status: _pick(o, STATUS_KEYS), body, url: (url && !/\/api\//.test(url)) ? url : null };
}

/**
 * Render a connector result into chat lines, or null when nothing is displayable (→ the caller shows "Done."). PURE.
 * A LIST → a header `name (N):` + one bullet per item (`• #id title — status`), capped at 25 with a "+ N more" note
 * (never a silent cap). A single OBJECT → id/title/status, then its body + a user-facing url. `name` is the leg label.
 */
export function renderConnectorLines(value, { name = 'Results' } = {}) {
  const list = primaryList(value);
  if (list) {
    const head = `${name} (${list.length})`;
    if (!list.length) return [`${head}.`];
    const lines = list.slice(0, MAX_ROWS).map((o) => {
      const it = summarizeItem(o);
      return `• ${it.id != null ? `#${it.id} ` : ''}${it.title || '(no title)'}${it.status ? ` — ${it.status}` : ''}`;
    });
    if (list.length > MAX_ROWS) lines.push(`… +${list.length - MAX_ROWS} more`);
    return [`${head}:`, ...lines];
  }
  const obj = primaryObject(value);
  if (obj) {
    const it = summarizeItem(obj, { full: true });
    const out = [`${it.id != null ? `#${it.id} ` : ''}${it.title || ''}${it.status ? ` — ${it.status}` : ''}`.trim() || '(no details)'];
    if (it.body) out.push(it.body);
    if (it.url) out.push(it.url);
    return out;
  }
  return null;
}

/**
 * Project a connector result's primary LIST into short fan-out labels ("#id title"), capped. PURE. Feeds the
 * CV-4-full enumerate-from-read fan-out (one child conversation per item). Returns {labels, total, capped}; a
 * listless / empty result → no labels (a single object isn't a list). Labels are UNTRUSTED page text — the caller
 * escapes them (they become a sub-task title/seed), never an instruction.
 */
export function itemLabels(value, cap = 20) {
  const list = primaryList(value) || [];
  const labels = list.slice(0, cap).map((o) => {
    const it = summarizeItem(o);
    return `${it.id != null ? `#${it.id} ` : ''}${it.title || 'item'}`.trim();
  }).filter(Boolean);
  return { labels, total: list.length, capped: list.length > cap };
}
