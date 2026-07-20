// Core/deskLanding.js — DL-1 (v2.74.1600, page shape corrected v1602): the desk LAUNCH page, assembled PURE.
//
// The user's spec (v1602, verbatim-shaped): (1) the header is a WELCOME message ("What would you like to do?"),
// not the desk name; (2) no "Connected to…" chatter — ONE subheader describes the desk INCLUDING its connections;
// (3) the cards are WORKFLOWS — and when none is banked yet, exactly one "＋ Workflow" card; (4) the subheader is
// a real subheader, not muted gray fine print (the panel styles it so); (5) the Front desk's "choose a desk" page
// is the analogy. Launch STATE (v1601): a work desk at its +desk birth and reopens before its first operator ask;
// Admin/Front at app first-launch or after history delete. The no-inventions rule stays structural: workflow
// cards come only from the caller's saved-workflow records (run-verified); the Admin desk's cards are its three
// deterministic operator commands, with the vitals card kept BELOW (`vitalsAfter`).

export const LANDING_GREETING = 'What would you like to do?';
export const LANDING_MAX_WORKFLOWS = 6;

// Does the description already NAME the connections? (The Warranty preset's description says "…across VendorSuite,
// Zendesk, Shopify, and HubSpot…" — appending a connections line under it would read as duplication.) A label
// counts as named when any of its words (>3 chars) appears in the description.
export function descNamesConnections(description, labels) {
  const d = String(description || '').toLowerCase();
  if (!d) return false;
  const ls = (Array.isArray(labels) ? labels : []).filter(Boolean);
  if (!ls.length) return false;
  return ls.some((l) => String(l).toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 3 && d.includes(w)));
}

/**
 * @param {{ title?:string, description?:string, isAdmin?:boolean,
 *   workflows?:Array<{id?:string, appId?:string, name?:string, ask?:string, subAsks?:string[], runs?:number, at?:number}>,
 *   connections?:string[] }} p   connections = the desk's connection LABELS (or hosts)
 * @returns {{ heading:string, sub:string|null, connections:string|null,
 *   cards:Array<{kind:'workflow'|'new-workflow'|'command', title:string, sub:string, wf?:object, command?:string}>,
 *   vitalsAfter:boolean }}
 */
export function buildDeskLanding({ title = '', description = '', isAdmin = false, workflows = [], connections = [] } = {}) {
  const name = String(title || '').trim() || (isAdmin ? 'Admin desk' : '');
  // v1603 (live: "sub header has no description") — the Admin desk is not a catalog desk, so it has no
  // description SOURCE; it owns its operator description here.
  const desc = String(description || '').trim()
    || (isAdmin ? 'watches your connections, ride health, and open cases across every connected site.' : '');
  const labels = (Array.isArray(connections) ? connections : []).map((c) => String(c || '').trim()).filter(Boolean);

  // The SUBHEADER: "<Name> — <description>" (the desk, described); connections join it as a second line only
  // when the description doesn't already name them (or there is no description at all).
  const subBody = desc || (labels.length ? `Connected to ${labels.join(', ')}.` : '');
  const sub = name && subBody ? `${name} — ${subBody}` : (subBody || name || null);
  const connLine = (labels.length && desc && !descNamesConnections(desc, labels)) ? labels.join(' · ') : null;

  const cards = [];
  if (isAdmin) {
    // The Admin desk's quick actions ARE its operator commands (deterministic doors, always live).
    cards.push({ kind: 'command', command: 'show dashboard', title: 'Open the vitals dashboard', sub: 'connections · rides · incidents, live' });
    cards.push({ kind: 'command', command: 'check-now', title: 'Check everything now', sub: 'probe sessions + run due canaries' });
    cards.push({ kind: 'command', command: 'keepalive', title: 'Keep-alive…', sub: 'per-site session pings while you work' });
  } else {
    const wfs = (Array.isArray(workflows) ? workflows : [])
      .filter((w) => w && (w.ask || w.name))
      .sort((a, b) => ((b.runs || 0) - (a.runs || 0)) || ((b.at || 0) - (a.at || 0)))
      .slice(0, LANDING_MAX_WORKFLOWS);
    for (const w of wfs) {
      const steps = Array.isArray(w.subAsks) ? w.subAsks.length : 0;
      cards.push({ kind: 'workflow', title: String(w.name || w.ask).slice(0, 70), sub: `${steps || '?'} step${steps === 1 ? '' : 's'}${w.runs ? ` · run ${w.runs}×` : ''}`, wf: w });
    }
    if (!cards.length) cards.push({ kind: 'new-workflow', title: '＋ Workflow', sub: 'save a multi-step task you run often' });
  }

  return { heading: LANDING_GREETING, sub, connections: connLine, cards, vitalsAfter: isAdmin === true };
}
