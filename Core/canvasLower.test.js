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
  it('blocks: paragraphs split on blank lines; ul/ol group; headings parse in BOTH modes (GD-7h: html_body renders them)', () => {
    const b = parseMd('## Title\n\npara\n\n- a\n- b\n\n1. one\n2. two');
    assert.deepEqual(b.map((x) => x.type), ['h', 'p', 'ul', 'ol']);
    assert.equal(b[0].level, 2);
    assert.equal(b[2].items.length, 2);
    const d = parseMd('## Title\n\npara', { deliverable: true });
    assert.deepEqual(d.map((x) => x.type), ['h', 'p']);   // GD-7h — deliverable headings are real (Zendesk/Gmail render them)
  });
  it('GD-7h inline images: ref/https targets parse to image runs; a bad target degrades to the alt TEXT', () => {
    assert.deepEqual(parseInline('see ![pinhole](kb:1#img2) here'),
      [{ text: 'see ' }, { text: 'pinhole', image: 'kb:1#img2' }, { text: ' here' }]);
    assert.deepEqual(parseInline('![shot](https://cdn.x/a.png)'), [{ text: 'shot', image: 'https://cdn.x/a.png' }]);
    assert.deepEqual(parseInline('![evil](javascript:alert(1))'), [{ text: 'evil' }]);   // never an image
    assert.deepEqual(parseInline('a [link](https://a.b) and ![img](kb:1#img1)'),
      [{ text: 'a ' }, { text: 'link', link: 'https://a.b' }, { text: ' and ' }, { text: 'img', image: 'kb:1#img1' }]);
  });
  it('validateDeliverable: tables + URL-target images flagged; headings + ref-images are deliverable now (GD-7h)', () => {
    assert.equal(validateDeliverable(MD).ok, true);
    assert.equal(validateDeliverable('## H\n\n![img](kb:1#img1)').ok, true);
    const v = validateDeliverable('![img](https://x/y.png)\n\n| a | b |');
    assert.equal(v.ok, false);
    assert.equal(v.violations.length, 2);
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

describe('canvasLower — GD-7a backend profiles + honest degradation (§8.7)', () => {
  it('profiles: tab renders everything native; gdoc images native (GD-7b), chart/video degrade; unknown backend → null', async () => {
    const { backendProfile } = await import('./canvasLower.js');
    assert.ok(backendProfile('tab').native.includes('video'));
    assert.ok(backendProfile('gdoc').native.includes('image'));
    assert.deepEqual(backendProfile('gdoc').degrade, { chart: 'placeholder', video: 'link' });
    assert.equal(backendProfile('notion'), null);
  });

  it('GD-7b: a resolved image lowers to insertInlineImage (bounded width, ONE index unit + newline); unresolved → placeholder + honest degrade', () => {
    const spec = { blocks: [
      { kind: 'image', src: 'https://cdn.x.com/pinhole.png', mediaRef: 'kb:1#img1', alt: 'pinhole' },
      { kind: 'image', mediaRef: 'kb:1#img9', alt: 'unresolved' },
      { kind: 'markdown', text: 'after' },
    ] };
    const { requests, degraded } = specToDocsRequests(spec, { bodyEndIndex: 1 });
    const img = requests.find((r) => r.insertInlineImage);
    assert.equal(img.insertInlineImage.uri, 'https://cdn.x.com/pinhole.png');
    assert.equal(img.insertInlineImage.location.index, 1);
    assert.equal(img.insertInlineImage.objectSize.width.magnitude, 440);
    const nl = requests.find((r) => r.insertText && r.insertText.text === '\n');
    assert.equal(nl.insertText.location.index, 2);                             // image = ONE index unit
    assert.ok(requests.some((r) => r.insertText && r.insertText.text === '[image: unresolved]\n' && r.insertText.location.index === 3));
    assert.deepEqual(degraded, [{ kind: 'image', as: 'placeholder' }]);        // the RESOLVED image is native — no false degrade
  });
  it('degradationsFor reports ONLY the kinds this spec actually uses, deduped', async () => {
    const { degradationsFor } = await import('./canvasLower.js');
    const spec = { blocks: [{ kind: 'markdown', text: 'x' }, { kind: 'video', src: 'https://v.example/a' }, { kind: 'video', src: 'https://v.example/b' }] };
    assert.deepEqual(degradationsFor(spec, 'gdoc'), [{ kind: 'video', as: 'link' }]);
    assert.deepEqual(degradationsFor(spec, 'tab'), []);
    assert.deepEqual(degradationsFor(spec, 'nope'), []);
  });
  it('GD-7h: inline ![alt](ref) in compose text lowers to insertInlineImage mid-flow (indices coherent); unresolved → marker + degrade; html/text lowerings match', () => {
    const refMap = { 'kb:1#img1': { url: 'https://cdn.x.com/pinhole.png', kind: 'image', label: 'pinhole' } };
    const spec = { blocks: [{ id: 'd', kind: 'compose', ref: 'r', text: 'Press ![pinhole](kb:1#img1) firmly.\n\nThen ![missing](kb:9#img9) retry.' }] };
    const { requests, degraded, endIndex } = specToDocsRequests(spec, { bodyEndIndex: 1, refMap });
    const img = requests.find((r) => r.insertInlineImage);
    assert.equal(img.insertInlineImage.uri, 'https://cdn.x.com/pinhole.png');
    // 'Reply\n'(6) + 'Press '(6) → image at 1+6+6=13; the following segment ' firmly.' inserts at 14 (image = 1 unit)
    assert.equal(img.insertInlineImage.location.index, 13);
    assert.ok(requests.some((r) => r.insertText && r.insertText.text === ' firmly.' && r.insertText.location.index === 14));
    assert.ok(requests.some((r) => r.insertText && r.insertText.text === '[image: missing]'));   // unresolved ref → visible marker
    assert.deepEqual(degraded, [{ kind: 'image', as: 'placeholder' }]);
    // styling ranges still sit inside the inserted body (index-accounting invariant survives inline media)
    for (const r of requests) {
      const range = (r.updateTextStyle || r.updateParagraphStyle || r.createParagraphBullets || {}).range;
      if (range) assert.ok(range.startIndex >= 1 && range.endIndex <= endIndex, JSON.stringify(r));
    }
    const html = specDeliverableHtml(spec, 'r', { refMap });
    assert.match(html, /<img src="https:\/\/cdn\.x\.com\/pinhole\.png" alt="pinhole">/);
    assert.match(html, /\[image: missing\]/);
    assert.match(specDeliverableText(spec, 'r'), /\[image: pinhole\]/);      // plain-text delivery names the loss
  });

  it('v1336 source attribution: a [title](kb:N) link resolves to the ARTICLE url in Docs + HTML; unresolved → plain text', () => {
    const refMap = { 'kb:7': { url: 'https://help.x.com/hub-reset', kind: 'source', label: 'How to reset your hub' } };
    const spec = { blocks: [{ kind: 'compose', ref: 'r', text: 'Do the thing.\n\nSource: [How to reset your hub](kb:7)' }] };
    const { requests } = specToDocsRequests(spec, { bodyEndIndex: 1, refMap });
    const link = requests.find((q) => q.updateTextStyle && q.updateTextStyle.textStyle.link);
    assert.equal(link.updateTextStyle.textStyle.link.url, 'https://help.x.com/hub-reset');
    assert.match(specDeliverableHtml(spec, 'r', { refMap }), /<a href="https:\/\/help\.x\.com\/hub-reset">How to reset your hub<\/a>/);
    // no map → the citation degrades to plain text (never a dead/invented link)
    const bare = specToDocsRequests(spec, { bodyEndIndex: 1 });
    assert.ok(!bare.requests.some((q) => q.updateTextStyle && q.updateTextStyle.textStyle.link));
    assert.doesNotMatch(specDeliverableHtml(spec, 'r'), /<a /);
  });

  it('GD-7h: deliverable headings style as HEADING_n inside the compose section + <h2> in delivery HTML', () => {
    const spec = { blocks: [{ id: 'd', kind: 'compose', ref: 'r', text: '## Network checks\n\nVerify the bridge.' }] };
    const { requests } = specToDocsRequests(spec, { bodyEndIndex: 1 });
    const h = requests.filter((r) => r.updateParagraphStyle && r.updateParagraphStyle.paragraphStyle.namedStyleType === 'HEADING_2');
    assert.equal(h.length, 2);                                               // the Reply marker + the deliverable's own ##
    assert.match(specDeliverableHtml(spec, 'r'), /<h2>Network checks<\/h2>/);
  });

  it('v1332 typographic default: ONE whole-body spaceBelow pass rides every non-empty render (the wall-of-text fix)', () => {
    const { requests, endIndex } = specToDocsRequests({ blocks: [{ kind: 'markdown', text: 'one\n\ntwo' }] }, { bodyEndIndex: 1 });
    const sp = requests.filter((r) => r.updateParagraphStyle && r.updateParagraphStyle.fields === 'spaceBelow');
    assert.equal(sp.length, 1);
    assert.deepEqual(sp[0].updateParagraphStyle.range, { startIndex: 1, endIndex });
    assert.equal(sp[0].updateParagraphStyle.paragraphStyle.spaceBelow.magnitude, 10);
    assert.equal(specToDocsRequests({ blocks: [] }).requests.length, 0);   // empty spec → no styling pass
  });

  it('video lowering: an https src becomes a ▶-labelled LINK line; a ref-only video a placeholder; degraded rides the return', () => {
    const spec = { blocks: [
      { kind: 'video', src: 'https://help.x.com/v.mp4', label: 'pairing demo' },
      { kind: 'video', mediaRef: 'kb:1#vid1', label: 'reset walkthrough' },
    ] };
    const { requests, degraded } = specToDocsRequests(spec, { bodyEndIndex: 1 });
    const texts = requests.filter((r) => r.insertText).map((r) => r.insertText.text);
    assert.ok(texts.some((t) => t.startsWith('▶ pairing demo')));
    const link = requests.find((r) => r.updateTextStyle && r.updateTextStyle.textStyle.link);
    assert.equal(link.updateTextStyle.textStyle.link.url, 'https://help.x.com/v.mp4');
    assert.ok(texts.some((t) => t === '[video: reset walkthrough]\n'));
    assert.deepEqual(degraded, [{ kind: 'video', as: 'link' }, { kind: 'video', as: 'placeholder' }]);   // per-block actuals (GD-7b)
  });
});

describe('canvasLower — v1337 noInlineImages (the protected-source degrade-retry)', () => {
  it('every image (block src, inline ref, inline direct-https) lowers to a placeholder; links + text keep', () => {
    const refMap = { 'kb:1#img1': { url: 'https://cdn.x/p.png', kind: 'image' }, 'kb:1': { url: 'https://help.x/a', kind: 'source' } };
    const spec = { blocks: [
      { kind: 'image', src: 'https://cdn.x/block.png', alt: 'block shot' },
      { kind: 'compose', ref: 'r', text: 'Step ![inline](kb:1#img1) and ![direct](https://cdn.x/d.png).\n\nSource: [guide](kb:1)' },
    ] };
    const { requests, degraded } = specToDocsRequests(spec, { bodyEndIndex: 1, refMap, noInlineImages: true });
    assert.ok(!requests.some((q) => q.insertInlineImage), 'no image request survives the degrade-retry');
    const texts = requests.filter((q) => q.insertText).map((q) => q.insertText.text).join('');
    assert.match(texts, /\[image: block shot\]/);
    assert.match(texts, /\[image: inline\]/);
    assert.match(texts, /\[image: direct\]/);
    assert.deepEqual(degraded, [{ kind: 'image', as: 'placeholder' }]);
    const link = requests.find((q) => q.updateTextStyle && q.updateTextStyle.textStyle.link);
    assert.equal(link.updateTextStyle.textStyle.link.url, 'https://help.x/a');   // the source attribution still resolves
  });
});
