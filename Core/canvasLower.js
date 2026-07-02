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
// Model: Block = { type:'p'|'h'|'ul'|'ol', level?:2|3, runs?:Run[], items?:Run[][] }; Run = { text, bold?, italic?, link? }

const _HREF_OK = /^https?:\/\//i;

/** Parse inline runs: **bold**, *italic* / _italic_, [text](url). Nested emphasis inside links is flattened. PURE. */
export function parseInline(text) {
  const runs = [];
  let s = String(text ?? '');
  const push = (t, style = {}) => { if (t) runs.push({ text: t, ...style }); };
  while (s.length) {
    const mLink = s.match(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/);   // url may carry one paren-nested group (e.g. javascript:alert(1) — sanitized away, but consumed whole)
    const mBold = s.match(/\*\*([^*]+)\*\*/);
    const mItal = s.match(/(?:\*([^*]+)\*|_([^_]+)_)/);
    const cands = [
      mLink ? { idx: mLink.index, m: mLink, kind: 'link' } : null,
      mBold ? { idx: mBold.index, m: mBold, kind: 'bold' } : null,
      mItal ? { idx: mItal.index, m: mItal, kind: 'italic' } : null,
    ].filter(Boolean).sort((a, b) => a.idx - b.idx);
    if (!cands.length) { push(s); break; }
    const c = cands[0];
    push(s.slice(0, c.idx));
    if (c.kind === 'link') {
      const url = c.m[2];
      push(c.m[1], _HREF_OK.test(url) ? { link: url } : {});   // a non-https? href renders as plain text (sanitized away)
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
 * Parse the markdown SUBSET into blocks. `deliverable:true` = the delivery-safe vocabulary — headings degrade to
 * plain paragraphs (never silently upgrade what a target can't ship). PURE.
 */
export function parseMd(text, { deliverable = false } = {}) {
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
    if (h && !deliverable) { flushPara(); flushList(); blocks.push({ type: 'h', level: h[1].length, runs: parseInline(h[2]) }); continue; }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) { flushPara(); if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; } list.items.push(parseInline(ul[1])); continue; }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) { flushPara(); if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; } list.items.push(parseInline(ol[1])); continue; }
    flushList();
    para.push(h ? h[2] : line);   // deliverable heading degrades to a plain paragraph line
  }
  flushPara(); flushList();
  return blocks;
}

/** The two-tier vocabulary rule, machine-checked: what a DELIVERABLE text would lose in delivery. PURE. */
export function validateDeliverable(text) {
  const violations = [];
  const s = String(text ?? '');
  if (/^#{1,6}\s/m.test(s)) violations.push('heading (degrades to plain paragraph on delivery)');
  if (/!\[[^\]]*\]\([^)]*\)/.test(s)) violations.push('image (not deliverable)');
  if (/^\s*\|.*\|\s*$/m.test(s)) violations.push('table (not deliverable)');
  return { ok: violations.length === 0, violations };
}

// ── Lowering 1: semantic HTML (the DELIVERY payload) — escape-first ───────────────────────
const _esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function _runsToHtml(runs) {
  return runs.map((r) => {
    let t = _esc(r.text);
    if (r.bold) t = `<strong>${t}</strong>`;
    if (r.italic) t = `<em>${t}</em>`;
    if (r.link && _HREF_OK.test(r.link)) t = `<a href="${_esc(r.link)}">${t}</a>`;
    return t;
  }).join('');
}

/** Markdown-subset → semantic HTML (p/strong/em/a/ul/ol/li[/h2/h3 unless deliverable]). PURE, escape-first. */
export function mdToHtml(text, { deliverable = false } = {}) {
  return parseMd(text, { deliverable }).map((b) => {
    if (b.type === 'p') return `<p>${_runsToHtml(b.runs)}</p>`;
    if (b.type === 'h') return `<h${b.level}>${_runsToHtml(b.runs)}</h${b.level}>`;
    const tag = b.type === 'ul' ? 'ul' : 'ol';
    return `<${tag}>${b.items.map((i) => `<li>${_runsToHtml(i)}</li>`).join('')}</${tag}>`;
  }).join('');
}

// ── Lowering 2: plain text (the degrade — lists keep shape, emphasis drops) ────────────────
export function mdToText(text) {
  return parseMd(text, { deliverable: true }).map((b) => {
    if (b.type === 'p') return b.runs.map((r) => r.text).join('');
    const mark = (i) => (b.type === 'ul' ? '- ' : `${i + 1}. `);
    return b.items.map((runs, i) => mark(i) + runs.map((r) => r.text).join('')).join('\n');
  }).join('\n\n');
}

// ── Lowering 3: Google Docs batchUpdate (the PREVIEW) ─────────────────────────────────────
// Docs body starts at index 1; a replace-body render deletes {1, bodyEndIndex-1} first (the final newline is
// undeletable). Every paragraph inserts as `text\n`; styles apply as ranges over the inserted text; a list applies
// one createParagraphBullets over its whole range. Indices are UTF-16 units — JS String.length is exact.
const _BULLET_PRESET = { ul: 'BULLET_DISC_CIRCLE_SQUARE', ol: 'NUMBERED_DECIMAL_ALPHA_ROMAN' };

function _lowerBlocksToDocs(blocks, startIndex, requests) {
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
      if (r.link && _HREF_OK.test(r.link)) { textStyle.link = { url: r.link }; fields.push('link'); }
      if (fields.length && len) requests.push({ updateTextStyle: { range: { startIndex: off, endIndex: off + len }, textStyle, fields: fields.join(',') } });
      off += len;
    }
    return off;
  };
  for (const b of blocks) {
    if (b.type === 'p' || b.type === 'h') {
      const text = b.runs.map((r) => r.text).join('');
      const at = idx;
      insert(text + '\n');
      styleRuns(b.runs, at);
      if (b.type === 'h') requests.push({ updateParagraphStyle: { range: { startIndex: at, endIndex: at + text.length }, paragraphStyle: { namedStyleType: `HEADING_${b.level}` }, fields: 'namedStyleType' } });
    } else {
      const listStart = idx;
      for (const runs of b.items) {
        const text = runs.map((r) => r.text).join('');
        const at = idx;
        insert(text + '\n');
        styleRuns(runs, at);
      }
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
  gdoc: { native: ['markdown', 'metric', 'compose'],
          degrade: { image: 'placeholder', chart: 'placeholder', video: 'link' } },
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
export function specToDocsRequests(spec, { bodyEndIndex = 1 } = {}) {
  const requests = [];
  if (bodyEndIndex > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: bodyEndIndex - 1 } } });
  let idx = 1;
  const blocks = (spec && Array.isArray(spec.blocks)) ? spec.blocks : [];
  for (const blk of blocks) {
    if (!blk || typeof blk !== 'object') continue;
    if (blk.kind === 'markdown') {
      idx = _lowerBlocksToDocs(parseMd(blk.text), idx, requests);
    } else if (blk.kind === 'compose') {
      const at = idx;
      requests.push({ insertText: { location: { index: idx }, text: 'Reply\n' } });
      idx += 'Reply\n'.length;
      requests.push({ updateParagraphStyle: { range: { startIndex: at, endIndex: at + 'Reply'.length }, paragraphStyle: { namedStyleType: 'HEADING_2' }, fields: 'namedStyleType' } });
      idx = _lowerBlocksToDocs(parseMd(blk.text, { deliverable: true }), idx, requests);   // the preview = the delivery vocabulary
    } else if (blk.kind === 'metric') {
      const line = `${blk.label ?? ''}: ${blk.value ?? ''}${blk.delta != null ? ` (${blk.delta})` : ''}\n`;
      requests.push({ insertText: { location: { index: idx }, text: line } });
      idx += line.length;
    } else if (blk.kind === 'image') {
      const line = `[image: ${blk.alt || 'image'}]\n`;   // GD-7b upgrades a resolvable src/ref to insertInlineImage
      requests.push({ insertText: { location: { index: idx }, text: line } });
      idx += line.length;
    } else if (blk.kind === 'video') {
      // GD-7e — Docs cannot embed video: an https src lowers to a styled LINK line; a ref-only video (unresolved
      // until the GD-7b adapter hop) lowers to a placeholder. Either way it's in `degraded` (video → link).
      const label = blk.label || 'video';
      if (blk.src) {
        const at = idx;
        const text = `▶ ${label}\n`;
        requests.push({ insertText: { location: { index: idx }, text } });
        requests.push({ updateTextStyle: { range: { startIndex: at, endIndex: at + text.length - 1 }, textStyle: { link: { url: blk.src } }, fields: 'link' } });
        idx += text.length;
      } else {
        const line = `[video: ${label}]\n`;
        requests.push({ insertText: { location: { index: idx }, text: line } });
        idx += line.length;
      }
    } else if (blk.kind === 'chart') {
      const line = `[chart: ${blk.chartType ?? 'chart'}]\n`;
      requests.push({ insertText: { location: { index: idx }, text: line } });
      idx += line.length;
    }
  }
  return { requests, endIndex: idx, degraded: degradationsFor(spec, 'gdoc') };
}

// ── The delivery extractors (from the SPEC — never from the rendered doc) ─────────────────
function _composeBlock(spec, ref = null) {
  const blocks = (spec && Array.isArray(spec.blocks)) ? spec.blocks : [];
  return blocks.find((b) => b && b.kind === 'compose' && (!ref || b.ref === ref)) || null;
}
/** The deliverable as semantic HTML (Zendesk html_body / Gmail MIME). Null when no compose block. PURE. */
export function specDeliverableHtml(spec, ref = null) {
  const b = _composeBlock(spec, ref);
  return b ? mdToHtml(b.text, { deliverable: true }) : null;
}
/** The deliverable as plain text (the Drive-fill degrade). Null when no compose block. PURE. */
export function specDeliverableText(spec, ref = null) {
  const b = _composeBlock(spec, ref);
  return b ? mdToText(b.text) : null;
}
