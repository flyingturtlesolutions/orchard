// assets/icons.js — PS-4 (v2.74.1765, DESIGN_panel_surfaces.md §5): the ONE icon registry.
// Inline SVG only: viewBox 24, fill:none, stroke:currentColor, width 2, round caps/joins — the family the Rail
// subtask button and the v1745 history arrow established. Chrome uses THESE via _mkIconBtn (aria-label REQUIRED);
// emoji stay legal in CONTENT (agent copy), banned in chrome. Dismiss metaphors are FIXED (§5.4):
//   collapse (down arrow) = close an overlay, revealing what's beneath
//   x                      = cancel/destroy the thing itself
//   back (chevron-left)    = navigate within a stacked flow
const _svg = (inner, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const Icons = {
  run:         (s) => _svg('<polygon points="6 4 20 12 6 20 6 4"/>', s),
  pause:       (s) => _svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>', s),   // WFP-3 — the ▶⇄⏸ run-state swap (innerHTML only; data-icon stays "run")
  edit:        (s) => _svg('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>', s),   // WFG-1e — ✎ opens the builder pre-loaded
  runHeadless: (s) => _svg('<polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>', s),
  schedule:    (s) => _svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/>', s),
  history:     (s) => _svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/><polyline points="12 7 12 12 15 14"/>', s),
  // AU-2 (v2.74.2147) — "view this record on the site it lives on". VIEW, not navigate: the record is already
  // real and elsewhere; the eye says look at it where it is. Same 24-box / width-2 / round-cap family as the rest.
  eye:         (s) => _svg('<path d="M1.6 12S5 5.5 12 5.5 22.4 12 22.4 12 19 18.5 12 18.5 1.6 12 1.6 12z"/><circle cx="12" cy="12" r="3.2"/>', s),
  trash:       (s) => _svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>', s),
  collapse:    (s) => _svg('<line x1="12" y1="5" x2="12" y2="19"/><polyline points="5 12 12 19 19 12"/>', s),
  back:        (s) => _svg('<polyline points="15 18 9 12 15 6"/>', s),
  x:           (s) => _svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', s),
  plus:        (s) => _svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', s),
  workflow:    (s) => _svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h7a1 1 0 0 1 1 1V14"/><path d="M14 17.5H7a1 1 0 0 1-1-1V10"/>', s),
  home:        (s) => _svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>', s),
  rebuild:     (s) => _svg('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><polyline points="21 3 21 9 15 9"/>', s),
  cases:       (s) => _svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', s),
};
