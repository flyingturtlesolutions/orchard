// Core/canvasSpec.js — CA-1 (DESIGN_canvas.md §4): the pure render-spec behind the Canvas (an app's optional
// PRESENTATION plane — a roomy tab the app pushes a view to via the `display`/`compose` legs). PURE: no chrome /
// DOM / LLM / clock / random — headless-testable.
//
// A CanvasSpec is the materialized view the app pushed: { anchor:{appId,conversationId}, title, blocks[], rev }.
// `rev` is a monotonic revision STAMPED BY CanvasStore on write (the pure layer never reads a clock).
//
// Blocks are a CLOSED, safe-by-construction vocabulary (§5 — the canvas keeps the injection boundary by VOCABULARY,
// not by escaping alone). Every kind renders through a safe path; untrusted data (scraped HTML, customer text,
// account numbers) is always a VALUE inside the spec, NEVER executable:
//   • markdown — { text }                     → rendered escape-first (markdown.js) by CA-5; stored raw here.
//   • metric   — { label, value, delta? }     → a HUD tile; value is a number or a preformatted string.
//   • chart    — { chartType, data, options? }→ a vetted chart lib reads the DATA SPEC; never code/eval.
//   • image    — { src, alt }                 → <img>; src sanitized to https:/data:image-raster ONLY.
//   • compose  — { text, editable, ref }       → an editable region; `ref` ties it back so a capability can read
//                                                its current content (composeContent) — the canvas owns NO send.
// An unknown kind is DROPPED (not rendered) — that drop is the safety property, so do not loosen it casually.

//   • table    — { headers[], rows[][] }        → a data table; cells are STRINGS or one of the closed CELL shapes
//                                                 ({chip,tone} · {bar,label} · {mix:{ok,auth,miss,other}} ·
//                                                 {dot,label} · {text,sub,mono}) — enums clamped, numbers bounded,
//                                                 strings escaped at render (VT-2d/2e — the dashboard grid).
//   • cards    — { items:[{tone,title,when,body,marker}] } → severity-striped cards (incidents/heals; VT-2e).
// Any block may carry `help` (≤240 chars) — the renderer shows it as a hover ⓘ, never content.
export const BLOCK_KINDS = ['markdown', 'metric', 'chart', 'image', 'video', 'compose', 'table', 'cards'];
export const EFFECTS = ['none', 'fade', 'typewriter', 'count'];        // optional render hints; the canvas owns motion defaults
export const CHART_TYPES = ['line', 'bar', 'area', 'pie', 'scatter'];  // the vetted set CA-5's lib understands

const _str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
const _oneOf = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

// VT-2e — one TABLE CELL of the closed union. PURE. An unrecognized object collapses to '' (never rendered raw).
function _tableCell(c) {
  if (c == null) return '';
  if (typeof c !== 'object') return _str(c);
  if (c.chip != null) return { chip: _str(c.chip).slice(0, 40), tone: _oneOf(c.tone, ['ok', 'warn', 'danger', 'violet', 'mute'], 'mute') };
  if (c.bar != null) {
    const v = Number(c.bar);
    return { bar: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0, label: _str(c.label).slice(0, 24) };
  }
  if (c.mix != null && typeof c.mix === 'object') {
    const m = {};
    for (const k of ['ok', 'auth', 'miss', 'other']) m[k] = Math.max(0, Math.floor(Number(c.mix[k]) || 0));
    return { mix: m };
  }
  if (c.dot != null) return { dot: _oneOf(c.dot, ['in', 'out', 'unknown'], 'unknown'), label: _str(c.label).slice(0, 40) };
  if (c.text != null) {
    const cell = { text: _str(c.text).slice(0, 120) };
    if (c.sub != null && _str(c.sub).trim()) cell.sub = _str(c.sub).slice(0, 80);
    if (c.mono) cell.mono = true;
    return cell;
  }
  return '';
}

/**
 * The image-src safety gate (§5). PURE. Returns a SAFE src or '' (an empty src → the block is dropped, never an
 * unsafe image rendered). Allows ONLY remote https and inline data: RASTER images — never javascript:, never
 * data:text/html, never http:, never data:image/svg+xml (SVG can carry script in some sinks; raster cannot).
 */
export function sanitizeImageSrc(src) {
  const s = _str(src).trim();
  if (!s) return '';
  if (/^https:\/\/[^\s]+$/i.test(s)) return s;
  if (/^data:image\/(png|jpe?g|gif|webp|avif);[a-z0-9.+=/-]*,/i.test(s)) return s;
  return '';
}

/**
 * GD-7e (§8.7) — the trusted-media REF gate: `attachment:<id>` (a connector-read attachment) · `capture:<id>` (an
 * Orchard page screenshot) · `kb:<articleId>[#media]` (a banked KB article's enumerated media). PURE. Returns the
 * ref or '' (invalid shape → dropped). Refs are NAMES into the trusted store — the adapter resolves them at render;
 * the composing model can only pick from an enumerated menu, never mint a URL (the exfil-beacon rule).
 */
export function sanitizeMediaRef(ref) {
  const s = _str(ref).trim();
  return /^(attachment|capture|kb):[A-Za-z0-9][A-Za-z0-9_.:#\/-]{0,200}$/.test(s) ? s : '';
}

/** The {appId, conversationId} anchor — who owns this canvas (conversationId null → an app-level standing canvas). PURE. */
function _anchor(raw) {
  const a = (raw && typeof raw === 'object') ? raw : {};
  return { appId: _str(a.appId) || null, conversationId: _str(a.conversationId) || null };
}

/**
 * Normalize one raw block to the closed vocabulary. PURE. null for an unusable/unknown-kind block (the drop IS the
 * safety property). Per-kind required fields are enforced: a chart with no data, or an image with an unsafe/empty
 * src, is DROPPED rather than rendered blank/unsafe.
 */
export function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!BLOCK_KINDS.includes(raw.kind)) return null;                 // closed vocabulary — unknown kinds never render
  const base = { id: _str(raw.id), kind: raw.kind, effect: _oneOf(raw.effect, EFFECTS, 'none') };
  const help = _str(raw.help).trim();
  if (help) base.help = help.slice(0, 240);                         // VT-2e — the hover ⓘ; a VALUE, never markup

  if (raw.kind === 'markdown') return { ...base, text: _str(raw.text) };

  if (raw.kind === 'metric') {
    const value = (typeof raw.value === 'number') ? raw.value : (typeof raw.value === 'string') ? raw.value : '';
    const block = { ...base, label: _str(raw.label), value };
    if (raw.delta != null && raw.delta !== '') block.delta = (typeof raw.delta === 'number') ? raw.delta : _str(raw.delta);
    if (raw.sub != null && _str(raw.sub).trim()) block.sub = _str(raw.sub).slice(0, 80);   // VT-2e — the tile's small context line
    return block;
  }

  if (raw.kind === 'table') {
    // VT-2d/2e — cells are a CLOSED union (plain string, or one of five typed shapes with clamped enums/numbers
    // and sliced strings — nothing executable survives as a value), bounded 60 rows × 12 cols so an LLM-authored
    // table can't balloon the spec. No rows → drop (the safety default).
    const headers = (Array.isArray(raw.headers) ? raw.headers : []).slice(0, 12).map(_str);
    const rows = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, 60)
      .map((r) => (Array.isArray(r) ? r.slice(0, 12).map(_tableCell) : null))
      .filter((r) => r && r.length);
    if (!rows.length) return null;
    return { ...base, headers, rows };
  }

  if (raw.kind === 'cards') {
    // VT-2e — severity-striped cards (the dashboard's incidents/heals). Tones are a closed enum; every field a
    // sliced string. A titleless item drops; an itemless block drops.
    const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 12).map((it) => {
      if (!it || typeof it !== 'object') return null;
      const title = _str(it.title).slice(0, 120);
      if (!title) return null;
      const card = { tone: _oneOf(it.tone, ['open', 'heal', 'closed', 'info'], 'info'), title };
      if (_str(it.when).trim()) card.when = _str(it.when).slice(0, 40);
      if (_str(it.body).trim()) card.body = _str(it.body).slice(0, 400);
      if (_str(it.marker).trim()) card.marker = _str(it.marker).slice(0, 80);
      return card;
    }).filter(Boolean);
    if (!items.length) return null;
    return { ...base, items };
  }

  if (raw.kind === 'chart') {
    const data = (raw.data && typeof raw.data === 'object') ? raw.data : null;
    if (!data) return null;                                         // a chart with no data spec renders nothing → drop
    const block = { ...base, chartType: _oneOf(raw.chartType, CHART_TYPES, 'line'), data };
    if (raw.options && typeof raw.options === 'object') block.options = raw.options;   // opaque JSON; CA-5 treats as data, never eval
    return block;
  }

  if (raw.kind === 'image') {
    const src = sanitizeImageSrc(raw.src);
    const ref = sanitizeMediaRef(raw.mediaRef ?? raw.ref);          // GD-7e — a trusted-store ref (adapter-resolved at render)
    if (!src && !ref) return null;                                  // neither a safe src NOR a valid ref → drop
    return { ...base, ...(src ? { src } : {}), ...(ref ? { mediaRef: ref } : {}), alt: _str(raw.alt) };
  }

  if (raw.kind === 'video') {
    // GD-7e — video: an https URL (a hosted/KB video page or file) or a trusted-store ref. No data:/blob: (size +
    // provenance); a backend that can't embed degrades it to a LINK (canvasLower profiles — the §8.3 named downgrade).
    const src = /^https:\/\/[^\s]+$/i.test(_str(raw.src).trim()) ? _str(raw.src).trim() : '';
    const ref = sanitizeMediaRef(raw.mediaRef ?? raw.ref);
    if (!src && !ref) return null;
    return { ...base, ...(src ? { src } : {}), ...(ref ? { mediaRef: ref } : {}), label: _str(raw.label || raw.alt) };
  }

  // compose — the only editable kind; carries `ref` so the act layer can read its content (composeContent)
  return { ...base, text: _str(raw.text), editable: true, ref: _str(raw.ref) || null };
}

// v2.74.1341 (review G) — ID HYGIENE: diffSpec tracks blocks by id, and the live renderer patches DOM nodes by
// `[data-id]`. An id-LESS block used to land in added+removed on every diff (its node vanished on live update),
// and DUPLICATE ids patched the wrong node. Materialize a deterministic positional fallback (`_b<i>` — stable for
// the same array, so an unchanged id-less block diffs to nothing) and de-dupe collisions (`x`, `x~2`, …). PURE.
function _hygieneIds(blocks) {
  const used = new Set();
  return blocks.map((b, i) => {
    let id = b.id || `_b${i}`;
    if (used.has(id)) { let n = 2; while (used.has(`${id}~${n}`)) n++; id = `${id}~${n}`; }
    used.add(id);
    return (id === b.id) ? b : { ...b, id };
  });
}

/** Normalize a whole spec (defensive — survives a partial/legacy stored shape). PURE. Bad blocks are filtered out. */
export function normalizeCanvasSpec(raw) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  return {
    anchor: _anchor(d.anchor),
    title: _str(d.title),
    blocks: _hygieneIds((Array.isArray(d.blocks) ? d.blocks : []).map(normalizeBlock).filter(Boolean)),
    rev: Number.isFinite(d.rev) ? d.rev : 0,
  };
}

/** A fresh spec for an anchor. PURE. (rev starts at 0; CanvasStore bumps it on each write.) */
export function newCanvasSpec({ anchor = {}, title = '', blocks = [] } = {}) {
  return normalizeCanvasSpec({ anchor, title, blocks, rev: 0 });
}

/**
 * GD-7e (§8.7, refs-not-URLs) — tighten an LLM-AUTHORED spec before it enters the render path: a MINTED remote
 * media URL is stripped (an LLM-authored image/video URL is an exfiltration beacon — data rides the query string
 * the moment a surface fetches it). Kept: trusted-store refs (`mediaRef`) and inline data: raster (no network).
 * A media block left with neither is dropped whole. Applied ONLY where model output enters (COMPOSE_CANVAS);
 * app-defined presentation blocks (trusted config) keep their https srcs. PURE.
 */
export function stripMintedMedia(spec) {
  const d = (spec && typeof spec === 'object') ? spec : {};
  // GD-7h — INLINE images in markdown/compose TEXT get the same belt: `![alt](target)` keeps only trusted-REF
  // targets (the model's sole legal form); a minted URL/other target collapses to the alt text. Block-level media
  // below unchanged. Trusted app-defined specs never pass through here, so their https inline images survive.
  const stripText = (t) => _str(t).replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g,
    (m, alt, target) => (sanitizeMediaRef(target) ? m : (alt || '')));
  const blocks = (Array.isArray(d.blocks) ? d.blocks : []).map((b) => {
    if (!b) return b;
    if ((b.kind === 'markdown' || b.kind === 'compose') && typeof b.text === 'string') return { ...b, text: stripText(b.text) };
    if (b.kind !== 'image' && b.kind !== 'video') return b;
    const src = _str(b.src).trim();
    if (!/^https:\/\//i.test(src)) return b;                        // no remote src → nothing to strip
    const { src: _drop, ...rest } = b;
    return (rest.mediaRef || rest.ref) ? rest : null;               // ref survives; a src-only minted block drops whole
  }).filter(Boolean);
  return { ...d, blocks };
}

/**
 * A STABLE doc id from the anchor (the per-canvas storage key — CA-3). PURE. Keyed by conversation (a per-task
 * deliverable, e.g. the support guide) then app (a standing dashboard, e.g. the finance HUD), then a global scratch.
 */
export function canvasDocId(anchor) {
  const a = _anchor(anchor);
  if (a.conversationId) return `conv-${a.conversationId}`;
  if (a.appId) return `app-${a.appId}`;
  return 'scratch';
}

// Key-order-insensitive deep-equal so a re-serialized chart `data`/`options` object doesn't read as "changed". PURE.
function _deepEq(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!_deepEq(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k) || !_deepEq(a[k], b[k])) return false; }
  return true;
}

/**
 * Diff two specs by STABLE block id — the renderer's animation input (§2.5: a HUD value ticks, a digest item slides
 * in). PURE. A block matched by id whose content differs is `changed`; same content at a new index is `moved`; an
 * id-less block can't be tracked across revisions, so next's are `added` and prev's are `removed` (replace, no
 * animation). @returns {{added:Block[], removed:Block[], changed:{id,prev,next}[], moved:{id,from,to}[]}}
 */
export function diffSpec(prev, next) {
  const p = normalizeCanvasSpec(prev);
  const n = normalizeCanvasSpec(next);
  const indexById = (blocks) => new Map(blocks.map((b, i) => [b.id, { b, i }]).filter((e) => e[0]));
  const pById = indexById(p.blocks);
  const nById = indexById(n.blocks);
  const added = [], removed = [], changed = [], moved = [];

  for (const b of n.blocks) if (!b.id) added.push(b);              // untrackable → always re-added
  for (const b of p.blocks) if (!b.id) removed.push(b);           // untrackable → always re-removed
  for (const [id, { b, i }] of nById) {
    const pe = pById.get(id);
    if (!pe) added.push(b);
    else if (!_deepEq(pe.b, b)) changed.push({ id, prev: pe.b, next: b });
    else if (pe.i !== i) moved.push({ id, from: pe.i, to: i });
  }
  for (const [id, e] of pById) if (!nById.has(id)) removed.push(e.b);
  return { added, removed, changed, moved };
}

/** The editable (compose) blocks of a spec. PURE. */
export function editableBlocks(spec) {
  return normalizeCanvasSpec(spec).blocks.filter((b) => b.kind === 'compose');
}

/**
 * The current content of a compose region — the referenceable VALUE the act layer reads when the user says "send it"
 * (§2.6; the send itself is an app capability through the CX-6a gate, never the canvas). PURE. Matches by `ref`, or
 * the first compose block when ref is omitted. null when there's no compose block.
 */
export function composeContent(spec, ref = null) {
  const composes = editableBlocks(spec);
  if (!composes.length) return null;
  const r = _str(ref);
  const match = r ? composes.find((b) => b.ref === r) : composes[0];
  return match ? match.text : null;
}

/** Replace a text-bearing block's text (the user edited a compose/markdown region in the canvas). PURE, copy-on-write.
 * No-op on a non-text block or a missing id. The renderer writes the result back through CanvasStore. */
export function setBlockText(spec, id, text) {
  const s = normalizeCanvasSpec(spec);
  const bid = _str(id);
  let changed = false;
  const blocks = s.blocks.map((b) => {
    if (b.id !== bid || (b.kind !== 'compose' && b.kind !== 'markdown')) return b;
    changed = true;
    return { ...b, text: _str(text) };
  });
  return changed ? { ...s, blocks } : s;
}
