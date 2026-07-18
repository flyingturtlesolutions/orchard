// Core/chatVoice.js — v2.74.1591: ONE human voice for machine outcomes in chat (user directive: "do a user
// friendly formatting pass on all chats — most are just awful"). The reply strings were interpolating RAW
// internals — error slugs ("vitals-dashboard-failed", "http-500", "no-content-script"), third-person catalog
// verbs after "Couldn't" ("Couldn't Returns the warranty task contacts"), and whole leg names where a noun
// belongs ("this find a shopify customer by email"). These transforms live HERE (pure, tested) and every chat
// surface goes through them; LOGS keep the machine grammar — traces are for diagnosis, chat is for people.

const _CODE_WORDS = {
  'no-content-script': 'the page wasn’t reachable — refresh the site’s tab',
  'no-tab': 'that site isn’t open in a tab',
  'no-app-tab': 'that site isn’t open in a tab',
  'no-reply': 'the site didn’t answer',
  'no-response': 'the site didn’t answer',
  'timeout': 'it timed out',
  'timed-out': 'it timed out',
  'session-expired': 'the session looks signed out',
  'signed-out': 'the session looks signed out',
  'not-armed': 'that read isn’t armed yet',
  'not-connected': 'that site isn’t connected yet',
  'cancelled': 'it was cancelled',
  'canceled': 'it was cancelled',
  'non-json': 'the site answered with a page instead of data (usually a sign-in screen)',
  'no-json-liveness': 'the session check failed',
  'op-hash-stale': 'the site rotated its query id — one fresh by-hand run re-banks it',
};

/**
 * Turn a machine error (slug, http code, or already-human text) into a plain phrase. PURE.
 * Unknown human-looking text passes through UNTOUCHED — the translation is never lossy.
 */
export function friendlyError(err, fallback = 'something went wrong') {
  const s = String(err == null ? '' : err).trim();
  if (!s) return fallback;
  const low = s.toLowerCase();
  const m = low.match(/^http[-_ ]?(\d{3})$/) || low.match(/^(\d{3})$/);
  if (m) {
    const n = Number(m[1]);
    if (n === 401 || n === 403) return `the site said you’re signed out (${n})`;
    if (n === 404 || n === 410) return `the site couldn’t find that page (${n})`;
    if (n === 429) return `the site rate-limited us (429)`;
    if (n >= 500) return `the site had a server error (${n})`;
    return `the site answered ${n}`;
  }
  if (_CODE_WORDS[low]) return _CODE_WORDS[low];
  if (low.includes('timed out') || low.includes('timeout')) return 'it timed out';
  // an internal kebab/underscore slug ("vitals-dashboard-failed") → plain words; real sentences pass through
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(low)) return low.replace(/[-_]+/g, ' ');
  return s;
}

// Third-person catalog verbs → base form, so "Couldn’t ${phrase}" reads as a sentence
// ("Returns the warranty task contacts" → "return the warranty task contacts"). MAP-ONLY — no generic
// s-stripping (it would mangle "status", "search across…"); an unmapped head just lowercases (acronyms keep).
const _VERB_BASE = {
  returns: 'return', gets: 'get', lists: 'list', shows: 'show', finds: 'find', creates: 'create',
  searches: 'search', opens: 'open', reads: 'read', fetches: 'fetch', updates: 'update', sends: 'send',
  checks: 'check', pulls: 'pull', looks: 'look', runs: 'run', counts: 'count', gives: 'give',
  loads: 'load', adds: 'add', posts: 'post', writes: 'write', edits: 'edit', deletes: 'delete',
};

/** A leg/capability name as an INFINITIVE action phrase ("couldn’t <this>"). PURE. */
export function actionPhrase(name, fallback = 'do that') {
  const n = String(name || '').trim();
  if (!n) return fallback;
  const words = n.split(/\s+/);
  const head = words[0];
  const isAcronym = head.length >= 2 && head === head.toUpperCase() && /[A-Z]/.test(head);
  const low = head.toLowerCase();
  words[0] = _VERB_BASE[low] || (isAcronym ? head : low);
  return words.join(' ');
}

/** A SHORT noun for a record, from a leg name ("find a shopify customer by email" → "shopify customer";
 * "Warranty task details" → "warranty task"). Falls back rather than parroting a whole verb phrase. PURE. */
export function recordNounWord(name, fallback = 'record') {
  let s = String(name || '').toLowerCase().replace(/\s+details?$/i, '').trim();
  if (!s) return fallback;
  s = s.replace(/^(find|get|search|show|list|read|fetch|pull|open|look\s*up|returns?|gets?|lists?|shows?|finds?|searches|reads?|fetches)\b\s*/i, '');
  s = s.replace(/^(a|an|the|my|this|that)\b\s*/i, '');
  s = s.replace(/\s+(by|for|from|in|on|of|with|across)\b.*$/i, '');
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return fallback;
  return words.join(' ');
}
