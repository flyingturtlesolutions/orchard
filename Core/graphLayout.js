// Core/graphLayout.js — pure layered layout for the Locale graph (PAGEMODEL_SPEC § 1).
//
// The Locale is "a small graph" (Feature / Layer / Goal nodes joined by typed edges).
// This computes a deterministic 3-column layout so a renderer can be a dumb draw:
//
//   col 0  Layers      (surface + revealed depth)
//   col 1  Features     (sub-banded by kind: region→navigation→input→action→…)
//   col 2  Goals
//
// matching the natural edge flow — `reveals` (disclosure→layer) points col1→col0,
// `contains` (layer→feature) col0→col1, `enables` (feature→goal) col1→col2. The
// `leadsTo` edge is cross-page (its target is a URL, not a node here) so it is NOT
// drawn — the siteMap reconciliation / gap count surfaces it elsewhere. Edges whose
// endpoints aren't both positioned (e.g. collection→members, to=null) are dropped and
// counted. Output carries absolute coords + a viewBox. PURE, no DOM. Deterministic.
//
// @module Core/graphLayout

const FEATURE_KIND_RANK = Object.freeze({
  region: 0, navigation: 1, input: 2, action: 3, disclosure: 4, collection: 5, composite: 6,
});

/** Column index for a node: layers left (0), features middle (1), goals right (2). */
function columnOf(node) {
  if (!node) return 1;
  if (node.kind === 'layer') return 0;
  if (node.kind === 'goal') return 2;
  return 1;
}

/**
 * Lay out a Locale graph into positioned nodes + edges.
 * @param {{nodes?:Array<{id:string,kind:string,label?:string}>, edges?:Array<{from:string,to:string,kind:string}>}} graph
 * @param {object} [opts]  colGap, rowGap, padX, padY, nodeR overrides
 * @returns {{ width:number, height:number, columns:string[],
 *             nodes:Array<{id,kind,label,x,y,r,col}>,
 *             edges:Array<{from,to,kind,x1,y1,x2,y2}>, dropped:number }}
 */
export function layoutLocaleGraph(graph, opts = {}) {
  const colGap = opts.colGap ?? 230;
  const rowGap = opts.rowGap ?? 44;
  const padX   = opts.padX   ?? 100;
  const padY   = opts.padY   ?? 26;
  const nodeR  = opts.nodeR  ?? 7;

  const inNodes = Array.isArray(graph?.nodes) ? graph.nodes.filter((n) => n && n.id) : [];
  const inEdges = Array.isArray(graph?.edges) ? graph.edges : [];

  const columns = [[], [], []];
  for (const n of inNodes) columns[columnOf(n)].push(n);

  const byLabel = (a, b) => String(a.label || '').localeCompare(String(b.label || ''));
  // Features: group by kind (stable visual banding), then label.
  columns[1].sort((a, b) =>
    ((FEATURE_KIND_RANK[a.kind] ?? 9) - (FEATURE_KIND_RANK[b.kind] ?? 9)) || byLabel(a, b));
  columns[0].sort(byLabel);
  columns[2].sort(byLabel);

  const maxRows = Math.max(1, columns[0].length, columns[1].length, columns[2].length);
  const totalH = maxRows * rowGap;

  const pos = new Map();
  columns.forEach((col, ci) => {
    const offY = padY + (totalH - col.length * rowGap) / 2;   // vertically center each column
    col.forEach((n, ri) => pos.set(n.id, { x: padX + ci * colGap, y: offY + ri * rowGap + rowGap / 2 }));
  });

  const nodes = [];
  for (const n of inNodes) {
    const p = pos.get(n.id);
    if (p) nodes.push({ id: n.id, kind: n.kind, label: n.label || '', x: p.x, y: p.y, r: nodeR, col: columnOf(n) });
  }

  const edges = [];
  let dropped = 0;
  for (const e of inEdges) {
    if (!e || e.kind === 'leadsTo') { if (e && e.kind === 'leadsTo') dropped++; continue; }
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) { dropped++; continue; }   // collection→members (to=null) and dangling refs
    edges.push({ from: e.from, to: e.to, kind: e.kind, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }

  return {
    width: padX * 2 + 2 * colGap,
    height: padY * 2 + totalH,
    columns: ['layers', 'features', 'goals'],
    nodes,
    edges,
    dropped,
  };
}
