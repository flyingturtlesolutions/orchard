// Core/sourceBank.js — GD-7e live half (DESIGN_canvas.md §8.7.1): page → banked SOURCE artifact. PURE.
//
// The KB-remix workflow's first hop: a fetched/extracted page (a KB article) becomes a SELF-CONTAINED source —
// bounded text for the compose prompt + an ENUMERATED media menu (`kb:<seq>#img1` …) + the ref→url map the
// renderer resolves from. The refs-not-URLs rule lives here: the composing model only ever sees REFS + labels
// (never URLs — the menu is the whole legal namespace); resolution back to a URL happens from THIS trusted map,
// after the compose path has stripped anything the model minted (canvasSpec.stripMintedMedia).
//
// PURE: no chrome / DOM / clock — the caller extracts the raw page (content script) and owns `seq` (a stored
// counter). @module Core/sourceBank

const _str = (v) => (typeof v === 'string' ? v.trim() : '');
const _HTTPS = /^https:\/\/[^\s]+$/i;

export const SOURCE_TEXT_MAX = 6000;
export const SOURCE_IMAGES_MAX = 8;
export const SOURCE_VIDEOS_MAX = 4;

/**
 * Normalize an extracted page into a banked source. PURE.
 * @param {{ title?:string, url?:string, text?:string, images?:Array<{src,alt}>, videos?:Array<{src,label}> }} raw
 * @param {{ seq?:number }} [opts]  the per-app source counter (caller-owned; keys the kb: refs)
 * @returns {{ id:string, seq:number, title:string, url:string, text:string,
 *             media:Array<{ref:string,kind:'image'|'video',label:string}>,   // the PROMPT menu (no URLs)
 *             refs:Object<string,{url:string,kind:string,label:string}> } | null}   // the trusted resolve map
 */
export function pageToSource(raw, { seq = 1 } = {}) {
  const d = (raw && typeof raw === 'object') ? raw : null;
  if (!d) return null;
  const n = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 1;
  const id = `kb:${n}`;
  const title = _str(d.title).slice(0, 200) || 'page';
  const url = _HTTPS.test(_str(d.url)) ? _str(d.url).slice(0, 600) : '';
  const text = _str(d.text).replace(/\n{3,}/g, '\n\n').slice(0, SOURCE_TEXT_MAX);
  const media = [];
  const refs = {};
  const seen = new Set();
  let i = 0;
  for (const img of (Array.isArray(d.images) ? d.images : [])) {
    if (i >= SOURCE_IMAGES_MAX) break;
    const src = _str(img && img.src);
    if (!_HTTPS.test(src) || seen.has(src)) continue;   // https-only + dedup — a non-https/duplicate never mints a ref
    seen.add(src); i++;
    const ref = `${id}#img${i}`;
    const label = _str(img.alt).slice(0, 120) || `image ${i}`;
    media.push({ ref, kind: 'image', label });
    refs[ref] = { url: src.slice(0, 600), kind: 'image', label };
  }
  let v = 0;
  for (const vid of (Array.isArray(d.videos) ? d.videos : [])) {
    if (v >= SOURCE_VIDEOS_MAX) break;
    const src = _str(vid && vid.src);
    if (!_HTTPS.test(src) || seen.has(src)) continue;
    seen.add(src); v++;
    const ref = `${id}#vid${v}`;
    const label = _str(vid.label).slice(0, 120) || `video ${v}`;
    media.push({ ref, kind: 'video', label });
    refs[ref] = { url: src.slice(0, 600), kind: 'video', label };
  }
  if (!text && !media.length) return null;   // an empty extraction banks nothing
  // v2.74.1336 — the source's OWN id is a resolvable ref too: `[title](kb:7)` in composed text lowers to a link to
  // the article (source attribution without the model ever handling the raw URL — refs-not-URLs, uniform).
  if (url) refs[id] = { url, kind: 'source', label: title };
  return { id, seq: n, title, url, text, media, refs };
}

/**
 * v2.74.1336 — the ATTRIBUTION BELT: a draft composed from banked sources must carry a source link ("source link
 * should always be included"). The prompt STEERS the model to cite via `[title](<source id>)`; this pure pass
 * GUARANTEES it — when no compose/markdown text cites ANY banked source id, append a `Source:` line to the first
 * compose block (the deliverable). Deterministic app plumbing, like the typographic default — not model output.
 * No banked sources / no compose block / already cited → spec unchanged. PURE.
 */
export function ensureSourceAttribution(spec, banked) {
  const d = (spec && typeof spec === 'object') ? spec : {};
  const list = (Array.isArray(banked) ? banked : []).filter((s) => s && s.id && s.url);
  if (!list.length || !Array.isArray(d.blocks)) return d;
  const texts = d.blocks.filter((b) => b && (b.kind === 'compose' || b.kind === 'markdown') && typeof b.text === 'string');
  const cited = texts.some((b) => list.some((s) => b.text.includes(`](${s.id})`) || b.text.includes(`](${s.id}#`)));
  if (cited) return d;
  const composeIx = d.blocks.findIndex((b) => b && b.kind === 'compose' && typeof b.text === 'string');
  if (composeIx < 0) return d;
  const s = list[0];   // newest-first per the bank — the likeliest brief
  // v2.74.1340 (review F) — the TITLE is untrusted page text landing in a SHIPPED draft: a `]`/`(` in it could
  // forge a link to an attacker URL ("]​(https://evil…"). Escape markdown link metachars before interpolating.
  const safeTitle = String(s.title || 'source').replace(/([\\\[\]()])/g, '\\$1');
  const blocks = d.blocks.map((b, i) => (i === composeIx ? { ...b, text: `${b.text}\n\nSource: [${safeTitle}](${s.id})` } : b));
  return { ...d, blocks };
}

/** The prompt-facing slim view of banked sources (id + title + text + the ref menu — NO URLs reach the model;
 * the id is the CITE target, `[title](kb:7)`, resolved to the article url at lowering). PURE. */
export function sourcesForPrompt(banked) {
  return (Array.isArray(banked) ? banked : [])
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({ id: s.id || '', title: s.title || '', text: s.text || '', media: Array.isArray(s.media) ? s.media : [] }));
}

/** Merge the kept sources' ref maps into one resolve map (newest wins a collision). PURE. */
export function mergedRefMap(banked) {
  const out = {};
  for (const s of (Array.isArray(banked) ? banked : [])) {
    if (s && s.refs && typeof s.refs === 'object') Object.assign(out, s.refs);
  }
  return out;
}

/**
 * Resolve a spec's media REFS to srcs from the TRUSTED map (the render-side half of refs-not-URLs). PURE.
 * A block with `mediaRef` (or a raw `ref` on an image/video) gets `src` set from the map when the entry is https;
 * the ref STAYS on the block (a later adapter, e.g. gdoc insertInlineImage, re-resolves). Unknown refs are left
 * untouched (they lower to placeholders — visible, never invented). Non-media blocks pass through unchanged.
 */
export function resolveMediaRefs(spec, refMap) {
  const d = (spec && typeof spec === 'object') ? spec : {};
  const map = (refMap && typeof refMap === 'object') ? refMap : {};
  const blocks = (Array.isArray(d.blocks) ? d.blocks : []).map((b) => {
    if (!b || (b.kind !== 'image' && b.kind !== 'video')) return b;
    const ref = _str(b.mediaRef || b.ref);
    const hit = ref && map[ref];
    if (!hit || !_HTTPS.test(_str(hit.url))) return b;
    return { ...b, mediaRef: ref, src: _str(hit.url) };
  });
  return { ...d, blocks };
}
