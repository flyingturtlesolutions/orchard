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

/**
 * Recognize an admin/management command. PURE. Returns isAdmin:false for an ordinary ask (the normal turn path is
 * untouched). A delete requires a plural artifact noun (or "everything"); scope defaults to 'ground'.
 * @param {string} text
 * @returns {{isAdmin:boolean, command?:string, kinds?:string[], scope?:string, confidence?:number}}
 */
export function parseAdminCommand(text) {
  const s = String(text || '').trim();
  if (!s) return { isAdmin: false };
  if (_CLEAR_CHAT.test(s)) return { isAdmin: true, command: 'clear_chat', kinds: [], scope: 'chat', confidence: 0.95 };
  if (!_DEL_VERB.test(s)) return { isAdmin: false };
  let kinds = [];
  if (_EVERYTHING.test(s)) kinds = _ALL_KINDS.slice();
  else for (const p of _KIND_PATTERNS) if (p.re.test(s)) kinds.push(p.kind);
  if (!kinds.length) return { isAdmin: false };   // "delete that" / no plural kind → not a bulk command (→ feedback)
  const scope = _SCOPE_ALL.test(s) ? 'all' : 'ground';
  return { isAdmin: true, command: 'delete', kinds: Array.from(new Set(kinds)), scope, confidence: 0.9 };
}

/** The artifact kinds a bulk delete can target (the matcher/storage entity names). PURE constant. */
export const ADMIN_KINDS = _ALL_KINDS;
