// Core/payloadShape.js — v2.74.1872 — the KEYS-ONLY payload line: close the blind spot that made a render bug
// look like a routing bug for five passes.
//
// THE GAP. Every read concludes as `INVOKE ▸ … → ok object{2}` — a top-level shape summary and nothing else.
// The trace is dense with DECISIONS (route · leg · params · transport · grade) and carries no structure at all
// about what came BACK. So for the whole class "correct fetch, wrong field reaches prose" the instrument is
// blind by construction, and the diagnosis defaults to whatever stage can't be seen. I asserted three times
// that `vs_state` "carries access.DefaultDivision.Id" — inferred from a FIXTURE I wrote myself, never once
// observed. This is the line that would have settled it in one read.
//
// PRIVACY: PATHS AND TYPES ONLY, never a value. The type of a leaf (`Id:number`) is structure; its content is
// not, and content is what the llm-privacy doctrine fences. Two residual leaks are handled explicitly:
//   • a map KEYED by PII (`{ "a@b.com": {...} }`) would emit the address as a path segment → masked.
//   • an id-shaped key (a long digit run) is equally identifying → masked.
// Everything here goes to the LOCAL trace ring, never to a model.

const _PII_KEY = /@|^\+?\d[\d\s()-]{6,}$|^\d{7,}$|^[0-9a-f]{16,}$/i;
const _maskKey = (k) => (_PII_KEY.test(String(k)) ? '«id»' : String(k).slice(0, 40));

function _leafType(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'bool';
  return typeof v;
}

/**
 * The response's SHAPE as dotted paths. Arrays report their LENGTH and are descended through element 0 only
 * (a 121-element list has one shape, not 121). Depth- and count-capped; the cap is reported rather than
 * silently truncating — a shape that says "40 paths" when there were 400 is the same lie the tally lines used
 * to tell. PURE. Returns { paths: string[], truncated: boolean, total: number }.
 */
// The walk is bounded by NODES VISITED, not by paths printed — those are different jobs. `maxPaths` caps what
// is SHOWN; this caps the work a pathological payload can cost. Keeping them separate is what lets `total` stay
// an exact count of what exists in every ordinary case, which is the property the whole line rests on: a shape
// that reports 44 when there were 400 tells the same lie the receipt-less tallies used to.
const WORK_MAX = 5000;

export function payloadPaths(value, { maxDepth = 5, maxPaths = 44 } = {}) {
  const paths = [];
  let total = 0;
  let visited = 0;
  let stopped = false;
  const walk = (v, prefix, depth) => {
    if (stopped) return;
    if (++visited > WORK_MAX) { stopped = true; return; }
    if (v === null || typeof v !== 'object') {
      total++;
      if (paths.length < maxPaths) paths.push(`${prefix}:${_leafType(v)}`);
      return;
    }
    if (Array.isArray(v)) {
      const head = `${prefix}[${v.length}]`;
      if (!v.length) { total++; if (paths.length < maxPaths) paths.push(head); return; }
      if (depth >= maxDepth) { total++; if (paths.length < maxPaths) paths.push(head); return; }
      // an array and its element are the SAME structural level — the key that named the array already spent the
      // hop. Charging depth twice made `access.Hubs[].Divisions[]` bottom out one level above the leaf, which is
      // exactly where the interesting field lives in every nested-list payload this exists to show.
      walk(v[0], head, depth);
      return;
    }
    const keys = Object.keys(v);
    if (!keys.length) { total++; if (paths.length < maxPaths) paths.push(`${prefix}{}`); return; }
    if (depth >= maxDepth) { total++; if (paths.length < maxPaths) paths.push(`${prefix}{${keys.length}}`); return; }
    for (const k of keys) walk(v[k], prefix ? `${prefix}.${_maskKey(k)}` : _maskKey(k), depth + 1);
  };
  walk(value, '', 0);
  return { paths, truncated: total > paths.length, total, stopped };
}

/** The trace line. `PAYLOAD ▸ [recipeId] a.b:number · a.c[12].Name:string · …+9 more`. PURE. */
export function payloadShapeLine(recipeId, value, opts) {
  if (!value || typeof value !== 'object') return null;   // a scalar/null reply has no shape worth a line (`:null` says nothing)
  const { paths, truncated, total, stopped } = payloadPaths(value, opts);
  if (!paths.length) return null;
  // when the WORK ceiling stopped the walk, `total` is a floor rather than a count — say which it is.
  const more = truncated ? ` · …+${total - paths.length}${stopped ? '+ more (walk capped)' : ' more'}` : '';
  return `PAYLOAD ▸ [${recipeId || '?'}] ${paths.join(' · ')}${more}`;
}
