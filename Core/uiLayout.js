// Core/uiLayout.js — UI-VERIFICATION, the DETERMINISTIC appearance rung (v2.74.1965).
//
// "Does it look right" as a TEXT marker instead of a screenshot. The app MEASURES its own rendered reply (chat.js
// reads getBoundingClientRect + getComputedStyle off the live bubble) and this PURE module turns those numbers into a
// LAYOUT ▸ line. Appearance correctness — did content OVERFLOW the panel, how many ROWS actually rendered, and did
// chat.css actually STYLE the markdown (the id chips are monospace + have a chip background) — becomes a gl grep:
// greppable, diffable, fleet-safe (numbers, no pixels), and joined to SHAPE ▸ by sitting on the same turn.
//
// This is the same move Fix A's SHAPE ▸ marker makes — the app narrating its own UI outcome as text — one rung
// deeper (decision → measured layout). The ONLY thing it cannot judge is TASTE ("does it read WELL"); that residual
// is a later, on-demand, by-hand screenshot, not this harness.
//
// PURE: no DOM, no chrome, no clock. chat.js does the impure reading and passes plain numbers/strings here.

const _OVERFLOW_TOL = 2;   // px — sub-pixel rounding is not a clip; a real horizontal overflow exceeds this
const _MONO_RE = /mono|consol|courier|menlo|monaco|ui-monospace/i;
const _isMono = (font) => _MONO_RE.test(String(font || ''));
// A styled chip has a non-transparent background. Treat fully-transparent (or empty) as UNSTYLED.
const _hasBg = (bg) => {
  const s = String(bg || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return !!s && s !== 'transparent' && s !== 'rgba(0, 0, 0, 0)';
};

/**
 * Turn measured reply metrics → a layout verdict. PURE.
 * @param {{ clientWidth?:number, scrollWidth?:number, rows?:number, chips?:number, bold?:number,
 *           listStyled?:boolean, chipFont?:string, chipBg?:string }} m  the impure measurements from chat.js
 * @returns {{ overflow:boolean, rows:number, chips:number, bold:number, chipStyled:boolean, listStyled:boolean, flags:string[] }}
 */
export function layoutReport(m = {}) {
  const rows = m.rows | 0, chips = m.chips | 0, bold = m.bold | 0;
  const overflow = (Number(m.scrollWidth) || 0) > (Number(m.clientWidth) || 0) + _OVERFLOW_TOL;
  const chipStyled = chips > 0 && _isMono(m.chipFont) && _hasBg(m.chipBg);   // did chat.css actually style the <code> chips?
  const listStyled = !!m.listStyled;
  const flags = [];
  if (overflow) flags.push('overflow');                       // content clipped past the panel — the "cut off" bug
  if (chips > 0 && !chipStyled) flags.push('chip-unstyled');  // the L2 CSS gap: chips rendered but chat.css didn't style them
  return { overflow, rows, chips, bold, chipStyled, listStyled, flags };
}

/** Format the LAYOUT ▸ marker line. PURE. `ctx` labels the surface (e.g. 'reply'). */
export function formatLayoutMarker(ctx, r) {
  const chip = r.chips > 0 ? (r.chipStyled ? 'yes' : 'NO') : 'n/a';
  return `LAYOUT ▸ ${String(ctx || 'ui')} rows=${r.rows} chips=${r.chips} bold=${r.bold} overflow=${r.overflow ? 'YES' : 'no'}`
    + ` chip-styled=${chip} list=${r.listStyled ? 'yes' : 'no'}`
    + (r.flags.length ? ` ⚠ ${r.flags.join(',')}` : '');
}
