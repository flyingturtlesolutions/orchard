// Core/orchAdmin.js — ORCH-ADMIN: parse management/admin commands typed into the chat. PURE.
//
// Beyond running page tasks, the chat doubles as a console for managing the library itself — bulk-deleting
// artifacts (so a bad batch no longer needs a manual Studio cleanup) and clearing the conversation. These are
// DESTRUCTIVE, so the parser only RECOGNIZES the command; the chat always COUNTS + CONFIRMS before the background
// executes the (hard, cascading) delete via the same StorageManager primitives Studio uses.
//
//   parseAdminCommand(text) → { isAdmin, command:'clear_chat'|'delete', kinds:[], scope:'chat'|'ground'|'all' }
//
// A delete needs a PLURAL artifact noun ("delete all fragments"), so "delete that fragment" (a singular reference)
// is NOT a bulk command — it falls through to the corrective-feedback layer (retract one). Scope defaults to the
// current Ground; "everywhere / all grounds / globally" widens it to every Ground.
//
// @module Core/orchAdmin
// @version 2.74.773

const _CLEAR_CHAT = /^\s*(?:please\s+)?(clear|reset|wipe)\s+(?:the\s+|this\s+)?(chat|conversation|messages|message history|history|screen|window|transcript)\b/i;
const _DEL_VERB   = /\b(delete|remove|wipe|purge|drop|erase|nuke|clear)\b/i;

// PLURAL artifact nouns only — a bulk command targets a class, not one item. "capabilities" is the umbrella for
// the ACTIONABLE capability kinds — a bare-T1 Fragment AND a multi-step Strategy (a user-facing capability can be
// either, T1-as-first-class) — so it matches BOTH (not just strategies, which would skip every bare Fragment).
const _KIND_PATTERNS = [
  { kind: 'fragments',    re: /\b(fragments|capabilities)\b/i },
  { kind: 'strategies',   re: /\b(strategies|capabilities)\b/i },
  { kind: 'observations', re: /\bobservations\b/i },
  { kind: 'perspectives', re: /\bperspectives\b/i },
  // v2.74.811 — workflows are CROSS-Ground (saved cross-site recipes). Recognized explicitly ("delete all workflows")
  // and deleted GLOBALLY by the handler. Deliberately NOT in _ALL_KINDS, so "wipe the ground"/"everything" — a
  // per-Ground sweep — does NOT also nuke every cross-Ground workflow. Plural only (a singular "delete that workflow"
  // is a corrective reference, not a bulk command).
  { kind: 'workflows',    re: /\bworkflows\b/i },
];
const _ALL_KINDS  = Object.freeze(['fragments', 'strategies', 'observations', 'perspectives']);
const _EVERYTHING = /\b(everything|all artifacts|the (whole|entire) (ground|library|lot)|wipe (the )?(ground|library)|all of it)\b/i;
const _SCOPE_ALL  = /\b(every ?where|all grounds|all sites|all locales|globally|across all)\b/i;

// LIST (v2.74.819) — the READ complement to delete: "what's in my library?". Recognized by an explicit list/show
// verb, OR a possessive "do I have / my …" framing, OR "what can you do" — so a SEARCH like "what sites have jobs"
// (no list verb, no possessive) is NOT hijacked. Target: grounds | capabilities | workflows.
function _listTarget(s) {
  const explicit = /\b(list|show|display)\b/i.test(s);
  const possessive = /\b(my|do i have|i have|are there)\b/i.test(s);
  const whatCanIDo = /\bwhat can (?:you|i) do\b/i.test(s);
  if (!(explicit || possessive || whatCanIDo)) return null;
  if (/\b(grounds?|sites?|domains?)\b/i.test(s)) return 'grounds';
  if (/\b(workflows?|recipes?)\b/i.test(s)) return 'workflows';
  if (whatCanIDo || /\b(capabilit|abilit|skill|fragment|strateg|observation)/i.test(s)) return 'capabilities';   // prefix-match (capabilit→capabilities, strateg→strategies)
  return null;
}

// RENAME (v2.74.819) — give a Ground a readable name. v1: ground only ("rename this ground to X"). The name is the
// trailing "to/as <name>"; without one, the chat prompts for it.
function _parseRename(s) {
  if (!/\brename\b|\bre-?name\b/i.test(s)) return null;
  if (!/\b(ground|site)\b/i.test(s)) return null;
  const m = s.match(/\b(?:to|as)\s+["“]?(.+?)["”]?\s*$/i);
  return { name: m ? m[1].trim() : '' };
}
const _PRUNE_RE  = /\b(prune|clean\s?up|clear\s?out|tidy|garbage\s?collect)\b/i;
const _ORPHAN_RE = /\b(orphan|orphaned|dead|broken|stale|dangling)\b/i;
const _STATS_RE  = /\b(stats|statistics)\b|\blibrary (overview|summary)\b/i;

/**
 * Recognize an admin/management command. PURE. Returns isAdmin:false for an ordinary ask (the normal turn path is
 * untouched). A delete requires a plural artifact noun (or "everything"); scope defaults to 'ground'. LIST (read),
 * dedupe, and clear are also admin commands.
 * @param {string} text
 * @returns {{isAdmin:boolean, command?:string, kinds?:string[], target?:string, scope?:string, confidence?:number}}
 */
export function parseAdminCommand(text) {
  const s = String(text || '').trim();
  if (!s) return { isAdmin: false };
  if (_CLEAR_CHAT.test(s)) return { isAdmin: true, command: 'clear_chat', kinds: [], scope: 'chat', confidence: 0.95 };
  // RENAME a Ground — checked BEFORE LIST: "rename this ground to My Notion" contains "ground" + "my", which the
  // LIST possessive heuristic would otherwise mis-read as "list grounds".
  const rn = _parseRename(s);
  if (rn) return { isAdmin: true, command: 'rename', target: 'ground', name: rn.name, scope: 'ground', confidence: 0.9 };
  const lt = _listTarget(s);   // v2.74.819 — LIST (read) recognized BEFORE the delete gate
  if (lt) return { isAdmin: true, command: 'list', target: lt, scope: _SCOPE_ALL.test(s) ? 'all' : 'ground', confidence: 0.9 };
  // PRUNE orphaned capabilities — caught BEFORE the delete gate so "remove/delete dead capabilities" prunes only the
  // orphans instead of falling through to a delete-ALL-capabilities.
  if (_ORPHAN_RE.test(s) && (_PRUNE_RE.test(s) || _DEL_VERB.test(s))) return { isAdmin: true, command: 'prune', scope: _SCOPE_ALL.test(s) ? 'all' : 'ground', confidence: 0.85 };
  if (_PRUNE_RE.test(s) && /\bcapabilit/i.test(s)) return { isAdmin: true, command: 'prune', scope: _SCOPE_ALL.test(s) ? 'all' : 'ground', confidence: 0.8 };
  // STATS — library overview
  if (_STATS_RE.test(s)) return { isAdmin: true, command: 'stats', scope: 'all', confidence: 0.85 };
  if (!_DEL_VERB.test(s)) return { isAdmin: false };
  let kinds = [];
  if (_EVERYTHING.test(s)) kinds = _ALL_KINDS.slice();
  else for (const p of _KIND_PATTERNS) if (p.re.test(s)) kinds.push(p.kind);
  if (!kinds.length) return { isAdmin: false };   // "delete that" / no plural kind → not a bulk command (→ feedback)
  const scope = _SCOPE_ALL.test(s) ? 'all' : 'ground';
  return { isAdmin: true, command: 'delete', kinds: Array.from(new Set(kinds)), scope, confidence: 0.9 };
}

/**
 * Recognize a "find / merge duplicate Grounds" request. The same logical site can spawn multiple Grounds —
 * subdomain variants (app.x.com + www.x.com) or a brand under two TLDs (notion.com + notion.so) — splitting
 * capabilities and breaking active-tab-scoped delete. PURE: the chat detects, lists the clusters, and merges
 * only on explicit confirm. Requires a Ground/site noun; "merge/find" need an explicit duplicate word, while
 * "dedupe/consolidate" imply it. ("merge grounds" alone is left ambiguous — not hijacked.)
 * @param {string} text
 * @returns {{isDedup:boolean, confidence?:number}}
 */
export function parseDedupCommand(text) {
  const s = String(text || '').trim();
  if (!s) return { isDedup: false };
  if (!/\b(grounds?|sites?|domains?|locales?)\b/i.test(s)) return { isDedup: false };
  if (/\b(dedupe|de-dupe|deduplicate|consolidate)\b/i.test(s)) return { isDedup: true, confidence: 0.95 };
  if (/\b(merge|combine|unify|find|show|list)\b/i.test(s) && /\b(duplicate|duplicates|dupes?|redundant)\b/i.test(s)) {
    return { isDedup: true, confidence: 0.9 };
  }
  return { isDedup: false };
}

/** The artifact kinds a bulk delete can target (the matcher/storage entity names). PURE constant. */
export const ADMIN_KINDS = _ALL_KINDS;
