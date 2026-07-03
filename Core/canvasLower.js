// Core/canvasLower.js — GD-1 (v2.74.1320). The per-surface LOWERINGS of a CanvasSpec (DESIGN_canvas.md §8.3):
// ONE markdown-subset parser feeds three targets — Google Docs batchUpdate (the preview), semantic HTML (the
// delivery payload for Zendesk html_body / Gmail MIME), and plain text (the graceful degrade). Because every
// target lowers from the SAME parsed model, preview/delivery parity is a unit test, not a hope.
//
// The DELIVERABLE vocabulary (the compose block) is the delivery-safe subset: paragraphs, bold/italic, links,
// bulleted/numbered lists. Presentation-only blocks may also use headings (Docs renders them; they never ship).
// ESCAPE-FIRST extends to the HTML lowering: interpolated values are escaped, hrefs sanitized to https?: only.
//
// PURE: no clock/DOM/LLM/network. The Docs indices are UTF-16 code units (JS .length matches). @module Core/canvasLower

// ── The markdown-subset parser (shared by every lowering) ─────────────────────────────────
// Model: Block = { type:'p'|'h'|'ul'|'ol', level?:2|3, runs?:Run[], items?:Run[][] };
//        Run = { text, bold?, italic?, link? } | { text(alt), image:<ref-or-https> }  (GD-7h inline media)

import { sanitizeMediaRef } from './canvasSpec.js';   // GD-7h — inline image targets: trusted refs (model path) or https (trusted app-defined text)

const _HREF_OK = /^https?:\/\//i;
const _HTTPS_ONLY = /^https:\/\/[^\s]+$/i;

/**
 * Parse inline runs: **bold**, *italic* / _italic_, [text](url), and GD-7h inline images `![alt](target)` where
 * target is a trusted media REF (`kb:…`/`attachment:…`/`capture:…` — the model's only legal form; resolved from the
 * banked map at lowering) or an https URL (trusted app-defined text; the compose path strips minted URLs before
 * this ever runs). An invalid target degrades to the alt TEXT — never a broken/unsafe image. PURE.
 */
export function parseInline(text) {
  const runs = [];
  let s = String(text ?? '');
  const push = (t, style = {}) => { if (t) runs.push({ text: t, ...style }); };
  while (s.length) {
    const mImg  = s.match(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/);
    const mLink = s.match(/(?<!!)\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/);   // url may carry one paren-nested group (e.g. javascript:alert(1) — sanitized away, but consumed whole)
    const mBold = s.match(/\*\*([^*]+)\*\*/);
    // v2.74.1341 (review G) — word-boundary guards (markdown.js semantics): a mid-word `_`/`*` is NOT emphasis, so
    // `file_name_v2` / snake_case identifiers / underscored URLs survive a SHIPPED draft intact.
    const mItal = s.match(/(?:(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<!\w)_([^_\n]+?)_(?!\w))/);
    const cands = [
      mImg  ? { idx: mImg.index, m: mImg, kind: 'image' } : null,
      mLink ? { idx: mLink.index, m: mLink, kind: 'link' } : null,
      mBold ? { idx: mBold.index, m: mBold, kind: 'bold' } : null,
      mItal ? { idx: mItal.index, m: mItal, kind: 'italic' } : null,
    ].filter(Boolean).sort((a, b) => a.idx - b.idx);
    if (!cands.length) { push(s); break; }
    const c = cands[0];
    push(s.slice(0, c.idx));
    if (c.kind === 'image') {
      const target = sanitizeMediaRef(c.m[2]) || (_HTTPS_ONLY.test(c.m[2]) ? c.m[2] : '');
      if (target) runs.push({ text: c.m[1] || 'image', image: target });
      else push(c.m[1]);                                       // bad target → the alt text, never an image
    } else if (c.kind === 'link') {
      const url = c.m[2];
      // v2.74.1336 — a link target may also be a trusted REF (`[title](kb:7)` = source attribution): the run keeps
      // the ref and the LOWERING resolves it from the banked map (unresolved → plain text). Raw non-https? → text.
      push(c.m[1], (_HREF_OK.test(url) || sanitizeMediaRef(url)) ? { link: url } : {});
    } else if (c.kind === 'bold') {
      push(c.m[1], { bold: true });
    } else {
      push(c.m[1] ?? c.m[2], { italic: true });
    }
    s = s.slice(c.idx + c.m[0].length);
  }
  return runs;
}

/**
 * Parse the markdown SUBSET into blocks. GD-7h (v2.74.1335): headings + inline image refs are DELIVERABLE now —
 * Zendesk html_body / Gmail HTML render both (the old "degrade headings in deliverable" was scoped to a surface
 * assumption that was simply wrong). `deliverable` is kept for callers but no longer changes parsing; per-surface
 * loss (plain-text delivery) is handled by that lowering + named by validateDeliverable. PURE.
 */
export function parseMd(text, { deliverable = false } = {}) {
  void deliverable;
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let para = [];   // accumulating plain lines
  let list = null; // { type:'ul'|'ol', items:[] }
  const flushPara = () => { if (para.length) { blocks.push({ type: 'p', runs: parseInline(para.join(' ')) }); para = []; } };
  const flushList = () => { if (list && list.items.length) blocks.push(list); list = null; };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    if (h) { flushPara(); flushList(); blocks.push({ type: 'h', level: h[1].length, runs: parseInline(h[2]) }); continue; }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) { flushPara(); if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; } list.items.push(parseInline(ul[1])); continue; }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) { flushPara(); if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; } list.items.push(parseInline(ol[1])); continue; }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return blocks;
}

/** The two-tier vocabulary rule, machine-checked: what a DELIVERABLE text would lose in delivery. PURE.
 * GD-7h: headings + ref-images are deliverable (html_body renders them; PLAIN-TEXT delivery degrades — named at
 * the confirm bar, not here). Tables remain out; a URL-target image is flagged (refs-not-URLs). */
export function validateDeliverable(text) {
  const violations = [];
  const s = String(text ?? '');
  if (/!\[[^\]]*\]\(https?:[^)]*\)/.test(s)) violations.push('image with a URL target (use a media ref from the banked menu)');
  if (/^\s*\|.*\|\s*$/m.test(s)) violations.push('table (not deliverable)');
  return { ok: violations.length === 0, violations };
}

// GD-7h — resolve an inline image TARGET to a fetchable https uri: already-https (trusted app-defined text) passes
// through; a media ref resolves from the TRUSTED banked map; anything else → '' (the caller degrades visibly). PURE.
function _resolveMediaTarget(target, refMap) {
  const t = String(target ?? '');
  if (_HTTPS_ONLY.test(t)) return t;
  const hit = refMap && typeof refMap === 'object' ? refMap[t] : null;
  return (hit && _HTTPS_ONLY.test(String(hit.url ?? ''))) ? String(hit.url) : '';
}

// ── Lowering 1: semantic HTML (the DELIVERY payload) — escape-first ───────────────────────
const _esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// v2.74.1336 — resolve a LINK target: a direct http(s) url passes; a trusted ref (kb:7 — source attribution)
// resolves from the banked map; anything else → '' (renders as plain text). PURE.
function _resolveLinkTarget(target, refMap) {
  const t = String(target ?? '');
  if (_HREF_OK.test(t)) return t;
  return _resolveMediaTarget(t, refMap);
}

function _runsToHtml(runs, refMap) {
  return runs.map((r) => {
    if (r.image) {   // GD-7h — inline image: resolved from the trusted map → <img>; unresolved → a visible marker
      const uri = _resolveMediaTarget(r.image, refMap);
      return uri ? `<img src="${_esc(uri)}" alt="${_esc(r.text)}">` : _esc(`[image: ${r.text || 'image'}]`);
    }
    let t = _esc(r.text);
    if (r.bold) t = `<strong>${t}</strong>`;
    if (r.italic) t = `<em>${t}</em>`;
    if (r.link) {
      const href = _resolveLinkTarget(r.link, refMap);
      if (href) t = `<a href="${_esc(href)}">${t}</a>`;
    }
    return t;
  }).join('');
}

/** Markdown-subset → semantic HTML (p/h2/h3/strong/em/a/ul/ol/li + GD-7h ref-resolved <img>). PURE, escape-first. */
export function mdToHtml(text, { deliverable = false, refMap = null } = {}) {
  return parseMd(text, { deliverable }).map((b) => {
    if (b.type === 'p') return `<p>${_runsToHtml(b.runs, refMap)}</p>`;
    if (b.type === 'h') return `<h${b.level}>${_runsToHtml(b.runs, refMap)}</h${b.level}>`;
    const tag = b.type === 'ul' ? 'ul' : 'ol';
    return `<${tag}>${b.items.map((i) => `<li>${_runsToHtml(i, refMap)}</li>`).join('')}</${tag}>`;
  }).join('');
}

// ── Lowering 2: plain text (the degrade — lists keep shape, emphasis drops, media named) ───
export function mdToText(text) {
  const runText = (rs) => rs.map((r) => (r.image ? `[image: ${r.text || 'image'}]` : r.text)).join('');
  return parseMd(text, { deliverable: true }).map((b) => {
    if (b.type === 'p' || b.type === 'h') return runText(b.runs);
    const mark = (i) => (b.type === 'ul' ? '- ' : `${i + 1}. `);
    return b.items.map((runs, i) => mark(i) + runText(runs)).join('\n');
  }).join('\n\n');
}

// ── Lowering 3: Google Docs batchUpdate (the PREVIEW) ─────────────────────────────────────
// Docs body starts at index 1; a replace-body render deletes {1, bodyEndIndex-1} first (the final newline is
// undeletable). Every paragraph inserts as `text\n`; styles apply as ranges over the inserted text; a list applies
// one createParagraphBullets over its whole range. Indices are UTF-16 units — JS String.length is exact.
const _BULLET_PRESET = { ul: 'BULLET_DISC_CIRCLE_SQUARE', ol: 'NUMBERED_DECIMAL_ALPHA_ROMAN' };

function _lowerBlocksToDocs(blocks, startIndex, requests, { refMap = null, onDegrade = null, noImages = false } = {}) {
  let idx = startIndex;
  const insert = (text) => { requests.push({ insertText: { location: { index: idx }, text } }); idx += text.length; };
  const styleRuns = (runs, atStart) => {
    let off = atStart;
    for (const r of runs) {
      const len = r.text.length;
      const textStyle = {};
      const fields = [];
      if (r.bold) { textStyle.bold = true; fields.push('bold'); }
      if (r.italic) { textStyle.italic = true; fields.push('italic'); }
      const _lurl = r.link ? _resolveLinkTarget(r.link, refMap) : '';   // v1336 — a kb: source ref resolves to the article url
      if (_lurl) { textStyle.link = { url: _lurl }; fields.push('link'); }
      if (fields.length && len) requests.push({ updateTextStyle: { range: { startIndex: off, endIndex: off + len }, textStyle, fields: fields.join(',') } });
      off += len;
    }
    return off;
  };
  // GD-7h — emit one PARAGRAPH (runs + trailing \n). Image-less paragraphs take the fast path — ONE insertText of
  // `text\n` + per-run styles, byte-identical to the pre-GD-7h output. A paragraph WITH inline images partitions at
  // each image run: text segments insert+style as before; a resolved image emits insertInlineImage (ONE index unit);
  // an unresolved ref degrades to a visible marker + the honesty report.
  const emitPara = (runs) => {
    const at = idx;
    if (!runs.some((r) => r.image)) {
      const text = runs.map((r) => r.text).join('');
      insert(text + '\n');
      styleRuns(runs, at);
      return at;
    }
    let seg = [];
    const flushSeg = () => {
      if (!seg.length) return;
      const t = seg.map((r) => r.text).join('');
      const segAt = idx;
      insert(t);
      styleRuns(seg, segAt);
      seg = [];
    };
    for (const r of runs) {
      if (!r.image) { seg.push(r); continue; }
      flushSeg();
      const uri = noImages ? '' : _resolveMediaTarget(r.image, refMap);
      if (uri) {
        requests.push({ insertInlineImage: { location: { index: idx }, uri, objectSize: { width: { magnitude: 440, unit: 'PT' } } } });
        idx += 1;
      } else {
        insert(`[image: ${r.text || 'image'}]`);
        if (typeof onDegrade === 'function') onDegrade('image', 'placeholder');
      }
    }
    flushSeg();
    insert('\n');
    return at;
  };
  for (const b of blocks) {
    if (b.type === 'p' || b.type === 'h') {
      const at = emitPara(b.runs);
      if (b.type === 'h' && idx - 1 > at) requests.push({ updateParagraphStyle: { range: { startIndex: at, endIndex: idx - 1 }, paragraphStyle: { namedStyleType: `HEADING_${b.level}` }, fields: 'namedStyleType' } });
    } else {
      const listStart = idx;
      for (const runs of b.items) emitPara(runs);
      if (idx > listStart) requests.push({ createParagraphBullets: { range: { startIndex: listStart, endIndex: idx - 1 }, bulletPreset: _BULLET_PRESET[b.type] } });
    }
  }
  return idx;
}

// ── GD-7a (§8.7): per-backend CAPABILITY PROFILES + the honest-degradation report ──────────
// A backend declares which block kinds render NATIVELY and how the rest DEGRADE. One spec, per-surface lowerings;
// a degrade is NAMED in the render response (→ the panel line) — never a silent downgrade (§8.3). `tab` is our own
// renderer (everything native); `gdoc` degrades media until GD-7b's insertInlineImage lands. Unknown backend → null
// (no claim — callers treat as no-report, not as "all native").
export const BACKEND_PROFILES = {
  tab:  { native: ['markdown', 'metric', 'chart', 'image', 'video', 'compose'], degrade: {} },
  // GD-7b (v2.74.1333) — image is NATIVE on gdoc (insertInlineImage) when its src resolved from the trusted map;
  // an UNRESOLVED ref still placeholders (specToDocsRequests reports actuals per block, not this static claim).
  gdoc: { native: ['markdown', 'metric', 'compose', 'image'],
          degrade: { chart: 'placeholder', video: 'link' } },
};
export function backendProfile(backend) { return BACKEND_PROFILES[backend] || null; }

/** The §8.3 honesty report: which of THIS spec's blocks degrade on THIS backend, as [{kind, as}]. PURE. */
export function degradationsFor(spec, backend) {
  const prof = backendProfile(backend);
  if (!prof) return [];
  const out = [];
  const seen = new Set();
  for (const b of ((spec && Array.isArray(spec.blocks)) ? spec.blocks : [])) {
    const as = b && prof.degrade[b.kind];
    if (as && !seen.has(b.kind)) { seen.add(b.kind); out.push({ kind: b.kind, as }); }
  }
  return out;
}

/**
 * Lower a CanvasSpec to a replace-body Docs batchUpdate. Blocks: markdown → styled prose (full vocabulary);
 * compose → a "Reply" section (DELIVERABLE vocabulary, so the preview shows exactly what ships); metric →
 * "label: value" line; video → a LINK line (Docs cannot embed video — the §8.3 named degrade); image/chart →
 * text placeholders (inline images are GD-7b). PURE. `degraded` = the honesty report for the panel line.
 * @param {{ title?:string, blocks?:Array }} spec
 * @param {{ bodyEndIndex?:number }} [opts]  the live doc's current body end (from documents.get); >2 ⇒ clear first
 * @returns {{ requests:Array, endIndex:number, degraded:Array<{kind:string, as:string}> }}
 */
export function specToDocsRequests(spec, { bodyEndIndex = 1, refMap = null, noInlineImages = false } = {}) {
  const requests = [];
  if (bodyEndIndex > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: bodyEndIndex - 1 } } });
  let idx = 1;
  const bodyStart = idx;
  // GD-7b — `degraded` reports ACTUALS per block (an image with a resolved src is native; only unresolved refs
  // placeholder), so the §8.3 honesty line never claims a downgrade that didn't happen (or hides one that did).
  const degraded = [];
  const _deg = (kind, as) => { if (!degraded.some((d) => d.kind === kind && d.as === as)) degraded.push({ kind, as }); };
  // GD-7h — inline ![alt](ref) images resolve from the trusted map. v1337 `noInlineImages` — the degrade-retry
  // after a surface REFUSES image fetches (a protected source 403s Google's fetcher and fails the whole atomic
  // batchUpdate): every image (block + inline, ref OR direct-https) lowers to a placeholder instead, honestly
  // reported — while LINKS (incl. the source attribution) keep resolving from the same map.
  const _mdOpts = { refMap, onDegrade: _deg, noImages: noInlineImages };
  const blocks = (spec && Array.isArray(spec.blocks)) ? spec.blocks : [];
  for (const blk of blocks) {
    if (!blk || typeof blk !== 'object') continue;
    if (blk.kind === 'markdown') {
      idx = _lowerBlocksToDocs(parseMd(blk.text), idx, requests, _mdOpts);
    } else if (blk.kind === 'compose') {
      const at = idx;
      requests.push({ insertText: { location: { index: idx }, text: 'Reply\n' } });
      idx += 'Reply\n'.length;
      requests.push({ updateParagraphStyle: { range: { startIndex: at, endIndex: at + 'Reply'.length }, paragraphStyle: { namedStyleType: 'HEADING_2' }, fields: 'namedStyleType' } });
      idx = _lowerBlocksToDocs(parseMd(blk.text, { deliverable: true }), idx, requests, _mdOpts);   // the preview = the delivery vocabulary
    } else if (blk.kind === 'metric') {
      const line = `${blk.label ?? ''}: ${blk.value ?? ''}${blk.delta != null ? ` (${blk.delta})` : ''}\n`;
      requests.push({ insertText: { location: { index: idx }, text: line } });
      idx += line.length;
    } else if (blk.kind === 'image') {
      if (!noInlineImages && blk.src && /^https:\/\//i.test(blk.src)) {
        // GD-7b (v2.74.1333) — NATIVE inline image: the src came from the TRUSTED banked map (resolveMediaRefs) or
        // an app-defined block; Google fetches the uri itself (public KB CDNs qualify). One index unit + a newline;
        // width capped so a full-res screenshot doesn't overflow the page (height keeps aspect).
        requests.push({ insertInlineImage: { location: { index: idx }, uri: blk.src, objectSize: { width: { magnitude: 440, unit: 'PT' } } } });
        idx += 1;
        requests.push({ insertText: { location: { index: idx }, text: '\n' } });
        idx += 1;
      } else {
        const line = `[image: ${blk.alt || 'image'}]\n`;   // unresolved ref → a visible placeholder, and SAY so
        requests.push({ insertText: { location: { index: idx }, text: line } });
        idx += line.length;
        _deg('image', 'placeholder');
      }
    } else if (blk.kind === 'video') {
      // Docs cannot embed video: an https src lowers to a styled LINK line; an unresolved ref to a placeholder.
      const label = blk.label || 'video';
      if (blk.src) {
        const at = idx;
        const text = `▶ ${label}\n`;
        requests.push({ insertText: { location: { index: idx }, text } });
        requests.push({ updateTextStyle: { range: { startIndex: at, endIndex: at + text.length - 1 }, textStyle: { link: { url: blk.src } }, fields: 'link' } });
        idx += text.length;
        _deg('video', 'link');
      } else {
        const line = `[video: ${label}]\n`;
        requests.push({ insertText: { location: { index: idx }, text: line } });
        idx += line.length;
        _deg('video', 'placeholder');
      }
    } else if (blk.kind === 'chart') {
      const line = `[chart: ${blk.chartType ?? 'chart'}]\n`;
      requests.push({ insertText: { location: { index: idx }, text: line } });
      idx += line.length;
      _deg('chart', 'placeholder');
    }
  }
  // v2.74.1332 — TYPOGRAPHIC DEFAULT (the renderer owns formatting, §8.3): one whole-body paragraph-spacing pass
  // so the Doc reads like a set document, not a wall of text. The live .1331 lesson: documents.create defaults to
  // spaceBelow 0, the spec has NO spacing vocabulary, and parseMd collapses blank-line padding — so "add spacing"
  // asks could not render. fields limited to spaceBelow — named heading styles keep their own space-above.
  if (idx > bodyStart) {
    requests.push({ updateParagraphStyle: { range: { startIndex: bodyStart, endIndex: idx },
      paragraphStyle: { spaceBelow: { magnitude: 10, unit: 'PT' } }, fields: 'spaceBelow' } });
  }
  return { requests, endIndex: idx, degraded };
}

// ── The delivery extractors (from the SPEC — never from the rendered doc) ─────────────────
function _composeBlock(spec, ref = null) {
  const blocks = (spec && Array.isArray(spec.blocks)) ? spec.blocks : [];
  return blocks.find((b) => b && b.kind === 'compose' && (!ref || b.ref === ref)) || null;
}
/** The deliverable as semantic HTML (Zendesk html_body / Gmail MIME). Null when no compose block. PURE.
 * GD-7h — pass `refMap` so inline media refs resolve to <img> at delivery (same trusted map as the Doc preview). */
export function specDeliverableHtml(spec, ref = null, { refMap = null } = {}) {
  const b = _composeBlock(spec, ref);
  return b ? mdToHtml(b.text, { deliverable: true, refMap }) : null;
}
/** The deliverable as plain text (the Drive-fill degrade). Null when no compose block. PURE. */
export function specDeliverableText(spec, ref = null) {
  const b = _composeBlock(spec, ref);
  return b ? mdToText(b.text) : null;
}
