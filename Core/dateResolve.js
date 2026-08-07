// Core/dateResolve.js — RC-validate slice B (DATE): a PURE phrase → concrete-date resolver (DESIGN_resolve.md §10.5).
// v2.74.2063.
//
// PURE + deterministic: no chrome / DOM / fetch / Date.now. The reference clock is INJECTED as `nowIso` — the
// Core/trigger.js discipline (every fn takes `now`, none reads the clock), so the SAME phrase against the SAME
// nowIso is byte-identical every run. A relative phrase with no clock is unresolvable → `{ unknown }` (never guess).
//
// Verdict vocabulary MIRRORS resolveEnumValue (Core/connectorRecipes.js): a resolvable phrase returns a concrete
// value, an unresolvable one returns `{ unknown }` so a caller can REFUSE rather than pass a phrase the site would
// silently drop / mis-filter. A relative RANGE ('this week', 'last month') surfaces `{ from, to }` and lets the OP
// pick the bound — placing an end HERE would silently mis-filter, the exact silent-wrong class this belt exists to
// kill (a `>`/`>=` picks `from`, a `<`/`<=` picks `to`; a bare equality range is left for the caller to refuse).
//
// Shape: { iso, grain }            — a single concrete day (a bare ISO, today/yesterday/tomorrow, a weekday name)
//        { from, to, grain }       — a bounded range (this/last week · this/last month · this/last year · a month)
//        { from, grain }           — an OPEN lower bound ('since X')
//        { unknown }               — unresolved (garbage, or a relative phrase with no clock)

const _MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const _WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const _pad = (n) => String(n).padStart(2, '0');
const _iso = (d) => `${d.getUTCFullYear()}-${_pad(d.getUTCMonth() + 1)}-${_pad(d.getUTCDate())}`;
const _utc = (y, m, d) => new Date(Date.UTC(y, m, d));   // m is 0-based; Date.UTC normalizes month/day overflow
const _addDays = (d, n) => _utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n);

// A bare ISO date, optionally with a time part we discard (the marker's grain is 'date'). Calendar-validated below.
const _ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// Parse the INJECTED clock (an ISO string or a Date). Returns a Date or null — never reads the real clock.
function _parseNow(nowIso) {
  if (nowIso instanceof Date) return Number.isNaN(nowIso.getTime()) ? null : nowIso;
  const s = String(nowIso == null ? '' : nowIso).trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

const _norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Resolve a date PHRASE to a concrete ISO value against an INJECTED clock. PURE. `opts` is reserved (forwarded to the
 * recursive 'since' resolution) — a future weekStart/timezone knob lands here without a signature change.
 */
export function resolveDatePhrase(phrase, nowIso, opts = {}) {
  const raw = String(phrase == null ? '' : phrase).trim();
  if (!raw) return { unknown: true };

  // A bare ISO date resolves WITHOUT the clock (deterministic passthrough). Calendar-validate so '2026-13-45' is
  // unknown rather than echoed as a bogus bound.
  const isoM = raw.match(_ISO_DATE);
  if (isoM) {
    const yy = +isoM[1], mm = +isoM[2], dd = +isoM[3];
    const d = _utc(yy, mm - 1, dd);
    if (d.getUTCFullYear() === yy && d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd) return { iso: _iso(d), grain: 'date' };
    return { unknown: true };
  }

  const now = _parseNow(nowIso);
  if (!now) return { unknown: true };   // relative phrases require the clock — never guess without it
  const p = _norm(raw);

  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const dow = now.getUTCDay();

  if (p === 'today') return { iso: _iso(now), grain: 'date' };
  if (p === 'yesterday') return { iso: _iso(_addDays(now, -1)), grain: 'date' };
  if (p === 'tomorrow') return { iso: _iso(_addDays(now, 1)), grain: 'date' };

  // this/last week — ISO week, Monday-start.
  const toMonday = (dow + 6) % 7;
  const thisMonday = _addDays(now, -toMonday);
  if (p === 'this week') return { from: _iso(thisMonday), to: _iso(_addDays(thisMonday, 6)), grain: 'week' };
  if (p === 'last week') { const m = _addDays(thisMonday, -7); return { from: _iso(m), to: _iso(_addDays(m, 6)), grain: 'week' }; }

  if (p === 'this month') return { from: _iso(_utc(y, mo, 1)), to: _iso(_addDays(_utc(y, mo + 1, 1), -1)), grain: 'month' };
  if (p === 'last month') return { from: _iso(_utc(y, mo - 1, 1)), to: _iso(_addDays(_utc(y, mo, 1), -1)), grain: 'month' };

  if (p === 'this year') return { from: _iso(_utc(y, 0, 1)), to: _iso(_utc(y, 11, 31)), grain: 'year' };
  if (p === 'last year') return { from: _iso(_utc(y - 1, 0, 1)), to: _iso(_utc(y - 1, 11, 31)), grain: 'year' };

  // last/past N days → [now - N, now].
  const dM = p.match(/^(?:last|past)\s+(\d{1,4})\s+days?$/);
  if (dM) { const n = Number(dM[1]); if (n > 0) return { from: _iso(_addDays(now, -n)), to: _iso(now), grain: 'date' }; }

  // 'since X' → an OPEN lower bound: resolve X and surface its start (from, else the single day) with no upper end.
  const sM = p.match(/^since\s+(.+)$/);
  if (sM) {
    const inner = resolveDatePhrase(sM[1], nowIso, opts);
    if (inner && (inner.from || inner.iso)) return { from: inner.from || inner.iso, grain: inner.grain || 'date' };
    return { unknown: true };
  }

  // a bare weekday → the most recent occurrence on/before now (a single day).
  const wIdx = _WEEKDAYS.indexOf(p);
  if (wIdx >= 0) { const back = (dow - wIdx + 7) % 7; return { iso: _iso(_addDays(now, -back)), grain: 'date' }; }

  // a bare month name (optionally with a 4-digit year) → that month's range.
  const moM = p.match(/^([a-z]+)(?:\s+(\d{4}))?$/);
  if (moM) {
    const mi = _MONTHS.indexOf(moM[1]);
    if (mi >= 0) { const yr = moM[2] ? Number(moM[2]) : y; return { from: _iso(_utc(yr, mi, 1)), to: _iso(_addDays(_utc(yr, mi + 1, 1), -1)), grain: 'month' }; }
  }

  return { unknown: true };
}
