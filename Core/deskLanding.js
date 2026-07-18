// Core/deskLanding.js — DL-1 (v2.74.1600): the desk LAUNCH page, assembled PURE.
//
// What a desk shows when you open it fresh (no operator asks yet): a welcome head (name + role message +
// description) and QUICK-ACTION cards. The v1577 no-inventions rule is STRUCTURAL here — every card comes from a
// PROVEN source the caller passes in: this desk's saved workflows (run-verified chains) and the alias ledger
// (tested asks, verbatim, desk-scoped by host). Nothing is composed or imagined; a desk with nothing proven gets
// an honest "just ask" message and zero cards, never a fabricated menu. The Admin desk appends its three operator
// commands (deterministic doors, always live) and flags `vitalsAfter` so the panel keeps its vitals card BELOW
// the actions. The panel renders this verbatim; all selection/ordering/caps live here where they're testable.

export const LANDING_MAX_CARDS = 6;
export const LANDING_MAX_WORKFLOWS = 4;

const _host = (s) => String(s || '').toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').trim();
const _hostMatches = (h, hosts) => { const n = _host(h); return !!n && hosts.some((d) => n === d || n.endsWith(`.${d}`) || d.endsWith(`.${n}`)); };

/**
 * @param {{ title?:string, description?:string, isAdmin?:boolean,
 *   workflows?:Array<{id?:string, appId?:string, name?:string, ask?:string, subAsks?:string[], runs?:number, at?:number}>,
 *   aliases?:Array<{ask?:string, host?:string, at?:number}>,
 *   deskHosts?:string[] }} p
 * @returns {{ heading:string, message:string, sub:string|null,
 *   cards:Array<{kind:'workflow'|'ask'|'command', title:string, sub:string, wf?:object, ask?:string, command?:string}>,
 *   vitalsAfter:boolean }}
 */
export function buildDeskLanding({ title = '', description = '', isAdmin = false, workflows = [], aliases = [], deskHosts = [] } = {}) {
  const heading = String(title || '').trim() || (isAdmin ? 'Admin desk' : 'This desk');
  const cards = [];

  // 1) Saved workflows — run-verified chains; most-used first, then newest. The card carries the RECORD (the
  //    panel replays it through the existing chain runner — the same path as the `workflows` view's ▶ Run).
  const wfs = (Array.isArray(workflows) ? workflows : [])
    .filter((w) => w && (w.ask || w.name))
    .sort((a, b) => ((b.runs || 0) - (a.runs || 0)) || ((b.at || 0) - (a.at || 0)))
    .slice(0, LANDING_MAX_WORKFLOWS);
  for (const w of wfs) {
    const steps = Array.isArray(w.subAsks) ? w.subAsks.length : 0;
    cards.push({ kind: 'workflow', title: String(w.name || w.ask).slice(0, 70), sub: `${steps || '?'} step${steps === 1 ? '' : 's'}${w.runs ? ` · run ${w.runs}×` : ''} · saved workflow`, wf: w });
  }

  // 2) Tested asks from the alias ledger — VERBATIM (never rephrased), newest first, scoped to the desk's own
  //    hosts when it has connections (an unconfigured desk sees the newest regardless). Deduped against the
  //    workflow asks and within.
  const hosts = (Array.isArray(deskHosts) ? deskHosts : []).map(_host).filter(Boolean);
  const seen = new Set(cards.map((c) => String((c.wf && c.wf.ask) || '').trim().toLowerCase()).filter(Boolean));
  const askCap = isAdmin ? 3 : LANDING_MAX_CARDS;   // admin keeps room for its three commands
  for (const a of (Array.isArray(aliases) ? aliases : []).filter((x) => x && x.ask).sort((x, y) => ((y.at || 0) - (x.at || 0)))) {
    if (cards.length >= askCap) break;
    if (hosts.length && !_hostMatches(a.host, hosts)) continue;
    const k = String(a.ask).trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    cards.push({ kind: 'ask', title: `“${String(a.ask).slice(0, 70)}”`, sub: `tested${a.host ? ` · ${_host(a.host)}` : ''}`, ask: String(a.ask) });
  }

  // 3) The Admin desk's operator commands — deterministic doors, always live (not capability claims).
  if (isAdmin) {
    cards.push({ kind: 'command', command: 'show dashboard', title: 'Open the vitals dashboard', sub: 'connections · rides · incidents, live' });
    cards.push({ kind: 'command', command: 'check-now', title: 'Check everything now', sub: 'probe sessions + run due canaries' });
    cards.push({ kind: 'command', command: 'keepalive', title: 'Keep-alive…', sub: 'per-site session pings while you work' });
  }

  const message = isAdmin
    ? 'Your operations console — I watch your connections and rides on a clock, and open a case here when something needs you.'
    : cards.length
      ? 'Ready when you are — run a proven action below, or just ask.'
      : 'Nothing proven here yet — just ask; I learn each task the first time and recall it when you ask again.';

  return { heading, message, sub: String(description || '').trim() || null, cards, vitalsAfter: isAdmin === true };
}
