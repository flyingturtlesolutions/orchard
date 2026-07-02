// Core/canvasLower.test.js — GD-1 (v2.74.1320): the per-surface lowerings of a CanvasSpec (DESIGN_canvas.md §8.3).
// One parser, three targets — the PARITY tests are the format-fidelity contract made executable. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseInline, parseMd, validateDeliverable, mdToHtml, mdToText, specToDocsRequests, specDeliverableHtml, specDeliverableText } from './canvasLower.js';

const MD = 'Hi **Jane**,\n\nWe looked into *the issue* — see [the fix](https://help.x.com/fix).\n\n- restart the hub\n- re-pair the switch\n\nThanks!';

describe('canvasLower — the markdown-subset parser', () => {
  it('inline: bold / italic / links parse into runs; non-https hrefs are sanitized to plain text', () => {
    assert.deepEqual(parseInline('a **b** c'), [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' c' }]);
    assert.deepEqual(parseInline('x [ok](https://a.b) y'), [{ text: 'x ' }, { text: 'ok', link: 'https://a.b' }, { text: ' y' }]);
    assert.deepEqual(parseInline('[evil](javascript:alert(1))'), [{ text: 'evil' }]);   // href dropped, text kept
    assert.deepEqual(parseInline('_i_'), [{ text: 'i', italic: true }]);
  });
  it('blocks: paragraphs split on blank lines; ul/ol group; headings parse (and DEGRADE in deliverable mode)', () => {
    const b = parseMd('## Title\n\npara\n\n- a\n- b\n\n1. one\n2. two');
    assert.deepEqual(b.map((x) => x.type), ['h', 'p', 'ul', 'ol']);
    assert.equal(b[0].level, 2);
    assert.equal(b[2].items.length, 2);
    const d = parseMd('## Title\n\npara', { deliverable: true });
    assert.deepEqual(d.map((x) => x.type), ['p', 'p']);   // heading degrades, never upgrades what delivery can't ship
  });
  it('validateDeliverable names what delivery would lose (the two-tier rule, machine-checked)', () => {
    assert.equal(validateDeliverable(MD).ok, true);
    const v = validateDeliverable('# H\n\n![img](https://x/y.png)\n\n| a | b |');
    assert.equal(v.ok, false);
    assert.equal(v.violations.length, 3);
  });
});

describe('canvasLower — HTML lowering (the delivery payload, escape-first)', () => {
  it('emits semantic tags and ESCAPES interpolated values (the injection boundary extends here)', () => {
    const html = mdToHtml('Hello **<script>alert(1)</script>** & "co"', { deliverable: true });
    assert.match(html, /<strong>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/strong>/);
    assert.match(html, /&amp; &quot;co&quot;/);
    assert.doesNotMatch(html, /<script>/);
  });
  it('lists + links render; the full fixture round-trips', () => {
    const html = mdToHtml(MD, { deliverable: true });
    assert.match(html, /<p>Hi <strong>Jane<\/strong>,<\/p>/);
    assert.match(html, /<a href="https:\/\/help\.x\.com\/fix">the fix<\/a>/);
    assert.match(html, /<ul><li>restart the hub<\/li><li>re-pair the switch<\/li><\/ul>/);
  });
  it('plain-text degrade keeps list shape, drops emphasis', () => {
    const t = mdToText(MD);
    assert.match(t, /Hi Jane,/);
    assert.match(t, /- restart the hub\n- re-pair the switch/);
    assert.doesNotMatch(t, /\*\*/);
  });
});

describe('canvasLower — Docs lowering (the preview)', () => {
  const spec = { title: 'Ticket #64775', blocks: [
    { id: 'ctx', kind: 'markdown', text: '## Context\n\nCustomer reports **hub offline**.' },
    { id: 'm1', kind: 'metric', label: 'Open tickets', value: 7 },
    { id: 'draft', kind: 'compose', ref: 'reply-64775', text: MD, editable: true },
  ] };

  it('replace-body: clears {1, bodyEndIndex-1} first when the doc has content; indices stay coherent', () => {
    const { requests } = specToDocsRequests(spec, { bodyEndIndex: 120 });
    assert.deepEqual(requests[0].deleteContentRange.range, { startIndex: 1, endIndex: 119 });
    const fresh = specToDocsRequests(spec, { bodyEndIndex: 1 });
    assert.ok(!fresh.requests.some((r) => r.deleteContentRange), 'an empty doc skips the clear');
    // every styling range must sit inside inserted text
    let insertedEnd = 1;
    for (const r of fresh.requests) {
      if (r.insertText) insertedEnd = Math.max(insertedEnd, r.insertText.location.index + r.insertText.text.length);
      const range = (r.updateTextStyle || r.updateParagraphStyle || r.createParagraphBullets || {}).range;
      if (range) { assert.ok(range.startIndex >= 1 && range.endIndex <= insertedEnd, JSON.stringify(r)); }
    }
    assert.equal(fresh.endIndex, insertedEnd);
  });
  it('headings style as HEADING_n; bold/link style ranges land; lists get one bullet-preset request each', () => {
    const { requests } = specToDocsRequests(spec);
    assert.ok(requests.some((r) => r.updateParagraphStyle && r.updateParagraphStyle.paragraphStyle.namedStyleType === 'HEADING_2'));
    assert.ok(requests.some((r) => r.updateTextStyle && r.updateTextStyle.textStyle.bold === true));
    assert.ok(requests.some((r) => r.updateTextStyle && r.updateTextStyle.textStyle.link && r.updateTextStyle.textStyle.link.url === 'https://help.x.com/fix'));
    assert.equal(requests.filter((r) => r.createParagraphBullets).length, 1);
    assert.ok(requests.some((r) => r.insertText && /Open tickets: 7/.test(r.insertText.text)));
  });
});

describe('canvasLower — PARITY (preview ⇄ delivery: the WYSIWYG contract, executable)', () => {
  it('the compose block lowers with the SAME structure in Docs and HTML (paragraphs, list items, bold/link runs)', () => {
    const spec = { blocks: [{ id: 'd', kind: 'compose', ref: 'r', text: MD }] };
    const docs = specToDocsRequests(spec).requests;
    const html = specDeliverableHtml(spec, 'r');
    // list items: Docs inserts one paragraph per item under one bullet request ⇄ HTML <li> count
    const liCount = (html.match(/<li>/g) || []).length;
    const bulletReq = docs.find((r) => r.createParagraphBullets);
    assert.equal(liCount, 2);
    assert.ok(bulletReq, 'docs lowering produced a list');
    // bold runs: docs bold ranges ⇄ html <strong> occurrences
    assert.equal(docs.filter((r) => r.updateTextStyle && r.updateTextStyle.textStyle.bold).length, (html.match(/<strong>/g) || []).length);
    // links: same url in both lowerings
    const docLink = docs.find((r) => r.updateTextStyle && r.updateTextStyle.textStyle.link);
    assert.match(html, new RegExp(docLink.updateTextStyle.textStyle.link.url.replace(/[/.]/g, '\\$&')));
  });
  it('deliverable extractors read the SPEC (never a doc): html + text + ref addressing + null when absent', () => {
    const spec = { blocks: [{ id: 'a', kind: 'markdown', text: 'x' }, { id: 'd', kind: 'compose', ref: 'r2', text: 'Hi **there**' }] };
    assert.match(specDeliverableHtml(spec), /<strong>there<\/strong>/);
    assert.equal(specDeliverableText(spec, 'r2'), 'Hi there');
    assert.equal(specDeliverableHtml(spec, 'missing'), null);
    assert.equal(specDeliverableHtml({ blocks: [] }), null);
  });
});
