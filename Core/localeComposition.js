/**
 * @file Core/localeComposition.js
 * @description LOCALE_SPEC § 3 "Layer 2" composition helpers. Pure,
 * storage-free.
 *
 * A Locale's composition is a tree of `LandmarkNode`s ({ ref, role?,
 * multiplicity?, contains?, alternatives?, references?, triggers?,
 * derivedFrom?, ... }) plus cross-cutting overlays (groupings, sequences).
 * This module owns the canonical-shape derivation + the node-tree → flat-UID
 * flatten that every consumer needs, so the storage layer and (later)
 * authoring/runtime agree without drifting.
 *
 * Phase A (v2.74.332) introduces the shape: nodes are flat `{ ref }` until
 * relationship authoring (Phase B) and LLM structured proposal (Phase C)
 * land. A flat `landmarkRefs` mirror (= full flatten of the node tree) is
 * kept alongside for back-compat consumers during the transition.
 *
 * @module Core/localeComposition
 * @version 2.74.332
 */

/**
 * Flatten a LandmarkNode tree to an ordered, de-duplicated list of landmark
 * UIDs. Walks `contains` and `alternatives` recursively (the two
 * containment-shaped relationships); cross-link relationships (`references`,
 * `triggers`, `derivedFrom`) are NOT followed — they point at landmarks that
 * appear elsewhere in the tree as their own nodes.
 *
 * @param {Array} nodes  LandmarkNode[]
 * @returns {string[]}   ordered unique UIDs
 */
export function flattenLandmarkNodes(nodes, _out, _seen) {
  const out  = _out  ?? [];
  const seen = _seen ?? new Set();
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const ref = (n && typeof n.ref === 'string' && n.ref) ? n.ref : null;
    if (ref && !seen.has(ref)) { seen.add(ref); out.push(ref); }
    if (Array.isArray(n?.contains))     flattenLandmarkNodes(n.contains, out, seen);
    if (Array.isArray(n?.alternatives)) flattenLandmarkNodes(n.alternatives, out, seen);
  }
  return out;
}

// True when an array is already LandmarkNode-shaped. Each item is either a
// landmark node (string `ref`) or a v2.74.365 VIRTUAL container node (`virtual:
// true` with `contains`) — a structural wrapper (modal/menu) that holds
// landmarks but wasn't itself captured. Distinguishes the Layer 2 shape from
// legacy embedded landmark records (which carry `uid` + `selector`, no `ref`).
export function isLandmarkNodeArray(arr) {
  return Array.isArray(arr) && arr.length > 0
    && arr.every(n => n && ((typeof n.ref === 'string' && n.ref) || (n.virtual === true && Array.isArray(n.contains))));
}

/**
 * Derive the canonical LandmarkNode[] for a Locale record from whatever
 * shape it currently has:
 *   - already LandmarkNode[] ({ref}) → preserved verbatim (keeps structure)
 *   - legacy embedded full records ({uid, selector, …}) → flat {ref:uid} nodes
 *   - legacy flat landmarkRefs:[uid] → flat {ref:uid} nodes
 *   - nothing → []
 *
 * @param {object} loc  Locale record
 * @returns {Array}     LandmarkNode[]
 */
export function deriveLandmarkNodes(loc) {
  if (!loc || typeof loc !== 'object') return [];
  const lms = loc.landmarks;
  if (isLandmarkNodeArray(lms)) return lms;
  if (Array.isArray(lms) && lms.length) {
    // Legacy embedded full landmark records (pre-Phase-2 shape).
    const embedded = lms.filter(n => n && typeof n.uid === 'string' && n.uid);
    if (embedded.length) return embedded.map(n => ({ ref: n.uid }));
  }
  if (Array.isArray(loc.landmarkRefs)) {
    return loc.landmarkRefs.filter(u => typeof u === 'string' && u).map(u => ({ ref: u }));
  }
  return [];
}

/**
 * The flat, ordered, unique landmark UIDs for a Locale — the canonical way
 * for consumers to ask "which landmarks does this Locale compose?" regardless
 * of internal node structure. Prefers the node tree; falls back to the
 * landmarkRefs mirror, then legacy embedded records.
 *
 * @param {object} loc  Locale record
 * @returns {string[]}
 */
export function localeLandmarkUids(loc) {
  if (!loc || typeof loc !== 'object') return [];
  if (isLandmarkNodeArray(loc.landmarks)) return flattenLandmarkNodes(loc.landmarks);
  if (Array.isArray(loc.landmarkRefs)) return loc.landmarkRefs.filter(u => typeof u === 'string' && u);
  if (Array.isArray(loc.landmarks)) {
    return loc.landmarks.filter(n => n && typeof n.uid === 'string' && n.uid).map(n => n.uid);
  }
  return [];
}
