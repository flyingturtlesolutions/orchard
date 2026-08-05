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

// The shipped set (WFG-1, DESIGN_workflows.md §8, decision B). EMPTY BY DIRECTION (v2.74.2009): the four generic
// starters ("Daily digest of new items", "Triage & tag incoming", "Weekly summary", "Follow up on stalled items")
// were guesses at what a template should be; they are removed so each one can be built and proven individually.
// The gallery drops its template section while this is empty and offers only "+ Custom workflow…" + "Your workflows".
//
// To add one, append an entry here — that is the whole edit (membership is presence, `galleryWorkflows`):
//   { id: 'kebab-id', name: 'Shown on the card', description: 'One line under the name',
//     ask: 'the UMBRELLA intent — recall matches against THIS, not the name',
//     subAsks: ['first curated step', 'second curated step'],   // ≥2: the WF-1 workflow floor
//     suits: { types: ['inbox'] },                              // ADVISORY only, or omit
//     schema: 1 }
export const WORKFLOW_PRESETS = [
  // v2.74.2023 — the FIRST hand-built template, landed only after every step verified LIVE (2026-08-05): the
  // read at conf 1 (13:00Z), the per-task map binding its own collection and matching 16/2/0 (14:05Z), and the
  // create landing `1 created, 0 blocked` with the new customer matching on re-lookup (14:45–14:49Z). The
  // spec's "get homeowner contacts" step is NOT a separate subAsk — contact enrichment rides the map's
  // drill+sidecar (v1899), proven in the same traces. Phrasings below are the PROVEN ones from the live runs;
  // reword only against a new trace, never for style.
  {
    id: 'warranty-shopify-customers',
    name: 'Warranty → Shopify customers',
    description: 'Find each new warranty task\'s homeowner in Shopify; create customers for the ones missing.',
    ask: 'sync new warranty homeowners into Shopify customers',
    subAsks: [
      'get all new warranty tasks across every division',
      'for each task, find the homeowner\'s Shopify customer account',
      'create a Shopify customer for each one with no match, using the homeowner\'s name, phone, email and property address',
    ],
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
