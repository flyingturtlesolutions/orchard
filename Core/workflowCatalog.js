// WFG-1 (DESIGN_workflows.md §8) — curated WORKFLOW TEMPLATES for the workflow gallery.
//
// A template is NOT a saved workflow record: it pre-fills the authoring flow's `ask` + steps, and the user still
// runs the plan gate and approves each step (so no clause ever banks unapproved — the PP-0c safety argument holds).
// This mirrors Core/appCatalog.js: a flat registry + a one-field membership filter (`galleryWorkflows`), so
// promoting a template into the gallery is a single data edit.
//
// PURE — no chrome.*, no DOM, no LLM, no storage. `suits` is ADVISORY only (a hint for pre-selecting a matching
// view in the gallery's "add to which view?" step); it never gates execution.

const _str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));

// The starter set (WFG-1, DESIGN_workflows.md §8, open decision B): generic, editable templates. The `ask` is the
// UMBRELLA intent (recall matches against this); `subAsks` are the curated steps that land on the plan gate. Every
// entry MUST carry ≥2 subAsks — the WF-1 workflow floor (a 1-step "workflow" is just an action).
export const WORKFLOW_PRESETS = [
  {
    id: 'daily-digest',
    name: 'Daily digest of new items',
    description: 'Pull what came in since yesterday and summarize it.',
    ask: 'list the items created or updated since yesterday and summarize each one',
    subAsks: [
      'get the items created or updated since yesterday',
      'summarize each one in a sentence',
    ],
    suits: { types: ['inbox', 'watcher'] },
    schema: 1,
  },
  {
    id: 'triage-incoming',
    name: 'Triage & tag incoming',
    description: 'Go through untriaged items and set a priority on each.',
    ask: 'go through the items that have not been triaged yet and tag each by priority',
    subAsks: [
      'get the items that have not been triaged yet',
      'for each item, decide a priority and apply the matching tag',
    ],
    suits: { types: ['inbox'] },
    schema: 1,
  },
  {
    id: 'weekly-summary',
    name: 'Weekly summary',
    description: 'What closed this week, what is still open, in one short brief.',
    ask: 'summarize what closed in the last 7 days and what is still open',
    subAsks: [
      'get the items closed in the last 7 days',
      'get the items still open',
      'write a short summary of both',
    ],
    suits: { types: ['inbox', 'watcher'] },
    schema: 1,
  },
  {
    id: 'follow-up-stalled',
    name: 'Follow up on stalled items',
    description: 'Find items with no recent activity and draft a nudge for each.',
    ask: 'find the open items with no activity in 3 days and draft a follow-up for each',
    subAsks: [
      'get the open items with no update in the last 3 days',
      'draft a follow-up message for each one',
    ],
    suits: { types: ['inbox'] },
    schema: 1,
  },
];

/** Validate + shape one template. Returns null when it can't be a gallery card (missing id/name/ask, or the
 *  <2-step floor). PURE. */
export function normalizeWorkflowPreset(p) {
  if (!p || typeof p !== 'object') return null;
  const id = _str(p.id).trim();
  const name = _str(p.name).trim();
  const ask = _str(p.ask).trim();
  const subAsks = (Array.isArray(p.subAsks) ? p.subAsks : []).map((s) => _str(s).trim()).filter(Boolean);
  if (!id || !name || !ask || subAsks.length < 2) return null;   // the WF-1 workflow floor
  return {
    id,
    name,
    description: _str(p.description).trim(),
    ask,
    subAsks,
    suits: (p.suits && typeof p.suits === 'object' && !Array.isArray(p.suits)) ? p.suits : null,
    schema: 1,
  };
}

/** The gallery's card list: every valid template. Membership = presence in WORKFLOW_PRESETS (one data edit adds
 *  one). PURE. */
export function galleryWorkflows() {
  return WORKFLOW_PRESETS.map(normalizeWorkflowPreset).filter(Boolean);
}

/** One template by id, or null. PURE. */
export function workflowPreset(id) {
  const k = _str(id).trim();
  if (!k) return null;
  return galleryWorkflows().find((p) => p.id === k) || null;
}
