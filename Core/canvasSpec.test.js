// Core/canvasSpec.test.js — CA-1 (v2.74.1204): the pure Canvas render-spec.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_KINDS, sanitizeImageSrc, normalizeBlock, normalizeCanvasSpec, newCanvasSpec, canvasDocId,
  diffSpec, editableBlocks, composeContent, setBlockText,
} from './canvasSpec.js';

describe('canvasSpec — sanitizeImageSrc (the image safety gate)', () => {
  it('allows https and data:image raster', () => {
    assert.equal(sanitizeImageSrc('https://cdn.example.com/shot.png'), 'https://cdn.example.com/shot.png');
    assert.equal(sanitizeImageSrc('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(sanitizeImageSrc('data:image/jpeg;base64,/9j/4AAQ'), 'data:image/jpeg;base64,/9j/4AAQ');
  });
  it('DROPS every unsafe scheme → empty string', () => {
    assert.equal(sanitizeImageSrc('javascript:alert(1)'), '');
    assert.equal(sanitizeImageSrc('data:text/html,<script>alert(1)</script>'), '');
    assert.equal(sanitizeImageSrc('data:image/svg+xml,<svg onload=alert(1)>'), '');   // SVG can carry script — rejected
    assert.equal(sanitizeImageSrc('http://insecure.example.com/x.png'), '');          // plain http rejected
    assert.equal(sanitizeImageSrc('  JAVASCRIPT:alert(1)'), '');                       // trim + case-insensitive
    assert.equal(sanitizeImageSrc(''), '');
    assert.equal(sanitizeImageSrc(null), '');
  });
});

describe('canvasSpec — normalizeBlock (closed vocabulary)', () => {
  it('an unknown kind is DROPPED (the safety property)', () => {
    assert.equal(normalizeBlock({ kind: 'html', text: '<script>x</script>' }), null);
    assert.equal(normalizeBlock({ kind: 'iframe', src: 'https://evil' }), null);
    assert.equal(normalizeBlock(null), null);
    for (const k of BLOCK_KINDS) assert.ok(k !== 'html' && k !== 'iframe');   // sanity: no executable kind in v1
  });
  it('markdown carries raw text (escaped at render, not here)', () => {
    const b = normalizeBlock({ id: 'b1', kind: 'markdown', text: '# Hi <b>there</b>' });
    assert.equal(b.text, '# Hi <b>there</b>');
    assert.equal(b.effect, 'none');
  });
  it('metric keeps a numeric or preformatted value + optional delta', () => {
    assert.equal(normalizeBlock({ kind: 'metric', label: 'Net worth', value: 1204.5, delta: -12 }).value, 1204.5);
    assert.equal(normalizeBlock({ kind: 'metric', label: 'Net worth', value: '$1,204.50' }).value, '$1,204.50');
    assert.equal('delta' in normalizeBlock({ kind: 'metric', label: 'x', value: 1 }), false);   // delta omitted when absent
    assert.equal(normalizeBlock({ kind: 'metric', label: 'x', value: {} }).value, '');           // object value → ''
  });
  it('chart requires a data spec; chartType is vetted', () => {
    assert.equal(normalizeBlock({ kind: 'chart', chartType: 'line' }), null);                    // no data → drop
    const c = normalizeBlock({ kind: 'chart', chartType: 'pyramid', data: { series: [1, 2] }, options: { stacked: true } });
    assert.equal(c.chartType, 'line');                                                            // unknown type → default
    assert.deepEqual(c.data, { series: [1, 2] });
    assert.deepEqual(c.options, { stacked: true });
  });
  it('image with an unsafe/empty src is DROPPED, not rendered blank', () => {
    assert.equal(normalizeBlock({ kind: 'image', src: 'javascript:alert(1)' }), null);
    assert.equal(normalizeBlock({ kind: 'image', src: '' }), null);
    const ok = normalizeBlock({ kind: 'image', src: 'https://x/y.png', alt: 'a screenshot' });
    assert.equal(ok.src, 'https://x/y.png');
    assert.equal(ok.alt, 'a screenshot');
  });
  it('compose is always editable and carries its ref', () => {
    const b = normalizeBlock({ kind: 'compose', text: 'Hi there', ref: 'ticket-1234' });
    assert.equal(b.editable, true);
    assert.equal(b.ref, 'ticket-1234');
    assert.equal(normalizeBlock({ kind: 'compose' }).ref, null);
  });
});

describe('canvasSpec — normalizeCanvasSpec', () => {
  it('is defensive and filters bad blocks', () => {
    const s = normalizeCanvasSpec({ anchor: { appId: 'finance', conversationId: 'c1' }, title: 'HUD',
      blocks: [{ kind: 'metric', label: 'x', value: 1 }, { kind: 'bogus' }, null, { kind: 'image', src: 'http://no' }] });
    assert.equal(s.blocks.length, 1);                 // only the valid metric survives
    assert.equal(s.anchor.appId, 'finance');
    assert.equal(s.rev, 0);
  });
  it('newCanvasSpec starts empty at rev 0', () => {
    const s = newCanvasSpec({ anchor: { appId: 'a' }, title: 'T' });
    assert.deepEqual(s.blocks, []);
    assert.equal(s.anchor.conversationId, null);
  });
});

describe('canvasSpec — diffSpec (the renderer animation input)', () => {
  const m = (id, value, delta) => ({ id, kind: 'metric', label: 'v', value, ...(delta != null ? { delta } : {}) });
  it('added / removed by id', () => {
    const prev = newCanvasSpec({ blocks: [m('a', 1)] });
    const next = newCanvasSpec({ blocks: [m('a', 1), m('b', 2)] });
    const d = diffSpec(prev, next);
    assert.deepEqual(d.added.map((x) => x.id), ['b']);
    assert.equal(d.removed.length, 0);
    assert.equal(d.changed.length, 0);
  });
  it('a metric value change is `changed` (same id, different content)', () => {
    const d = diffSpec(newCanvasSpec({ blocks: [m('a', 1)] }), newCanvasSpec({ blocks: [m('a', 2)] }));
    assert.equal(d.changed.length, 1);
    assert.equal(d.changed[0].id, 'a');
    assert.equal(d.changed[0].next.value, 2);
  });
  it('same content at a new index is `moved`, not `changed`', () => {
    const prev = newCanvasSpec({ blocks: [m('a', 1), m('b', 2)] });
    const next = newCanvasSpec({ blocks: [m('b', 2), m('a', 1)] });
    const d = diffSpec(prev, next);
    assert.equal(d.changed.length, 0);
    assert.equal(d.moved.length, 2);
    assert.deepEqual(d.moved.find((x) => x.id === 'a'), { id: 'a', from: 0, to: 1 });
  });
  it('chart data compares key-order-insensitively (no false `changed`)', () => {
    const c1 = { id: 'c', kind: 'chart', data: { a: 1, b: 2 } };
    const c2 = { id: 'c', kind: 'chart', data: { b: 2, a: 1 } };
    assert.equal(diffSpec(newCanvasSpec({ blocks: [c1] }), newCanvasSpec({ blocks: [c2] })).changed.length, 0);
  });
  it('id-less blocks can\'t be tracked → next added, prev removed', () => {
    const d = diffSpec(newCanvasSpec({ blocks: [{ kind: 'markdown', text: 'old' }] }),
                       newCanvasSpec({ blocks: [{ kind: 'markdown', text: 'new' }] }));
    assert.equal(d.added.length, 1);
    assert.equal(d.removed.length, 1);
    assert.equal(d.changed.length, 0);
  });
});

describe('canvasSpec — compose lifecycle', () => {
  const spec = newCanvasSpec({ blocks: [
    { id: 'ctx', kind: 'markdown', text: 'the ticket' },
    { id: 'd1', kind: 'compose', text: 'draft one', ref: 'ticket-1' },
    { id: 'd2', kind: 'compose', text: 'draft two', ref: 'ticket-2' },
  ] });
  it('editableBlocks returns only compose blocks', () => {
    assert.deepEqual(editableBlocks(spec).map((b) => b.id), ['d1', 'd2']);
  });
  it('composeContent reads by ref, or the first when ref omitted, null when none', () => {
    assert.equal(composeContent(spec, 'ticket-2'), 'draft two');
    assert.equal(composeContent(spec), 'draft one');
    assert.equal(composeContent(newCanvasSpec({ blocks: [{ id: 'x', kind: 'markdown', text: 'y' }] })), null);
  });
  it('setBlockText edits a compose/markdown block; no-op elsewhere or on a missing id', () => {
    const edited = setBlockText(spec, 'd1', 'EDITED');
    assert.equal(composeContent(edited, 'ticket-1'), 'EDITED');
    assert.deepEqual(setBlockText(spec, 'nope', 'x'), spec);                       // missing id → equal doc
    const withMetric = newCanvasSpec({ blocks: [{ id: 'mm', kind: 'metric', label: 'l', value: 1 }] });
    assert.deepEqual(setBlockText(withMetric, 'mm', 'x'), withMetric);            // metric isn't text-bearing → no-op
  });
});

describe('canvasSpec — canvasDocId (anchor → storage key)', () => {
  it('keys by conversation, then app, then scratch', () => {
    assert.equal(canvasDocId({ appId: 'finance', conversationId: 'c1' }), 'conv-c1');   // conversation wins
    assert.equal(canvasDocId({ appId: 'finance' }), 'app-finance');
    assert.equal(canvasDocId({}), 'scratch');
    assert.equal(canvasDocId(null), 'scratch');
  });
});

describe('canvasSpec — GD-7e media refs + video (§8.7, refs-not-URLs)', () => {
  it('sanitizeMediaRef: attachment:/capture:/kb: shapes pass; anything else is rejected', async () => {
    const { sanitizeMediaRef } = await import('./canvasSpec.js');
    assert.equal(sanitizeMediaRef('kb:123#img2'), 'kb:123#img2');
    assert.equal(sanitizeMediaRef('attachment:az-9'), 'attachment:az-9');
    assert.equal(sanitizeMediaRef('capture:step.3'), 'capture:step.3');
    assert.equal(sanitizeMediaRef('https://evil.example/x.png'), '');
    assert.equal(sanitizeMediaRef('kb:'), '');
    assert.equal(sanitizeMediaRef(''), '');
  });
  it('image: a valid mediaRef with NO src now survives (adapter resolves later); neither → drop', () => {
    const b = normalizeBlock({ kind: 'image', ref: 'kb:1#img1', alt: 'reset pinhole' });
    assert.equal(b.mediaRef, 'kb:1#img1'); assert.equal(b.src, undefined);
    assert.equal(normalizeBlock({ kind: 'image', alt: 'x' }), null);
  });
  it('video: https src OR mediaRef; javascript:/data:/neither → drop; label carried', () => {
    assert.equal(normalizeBlock({ kind: 'video', src: 'https://help.x.com/v.mp4', label: 'demo' }).src, 'https://help.x.com/v.mp4');
    assert.equal(normalizeBlock({ kind: 'video', ref: 'kb:1#vid1' }).mediaRef, 'kb:1#vid1');
    assert.equal(normalizeBlock({ kind: 'video', src: 'javascript:alert(1)' }), null);
    assert.equal(normalizeBlock({ kind: 'video', src: 'data:video/mp4;base64,AAAA' }), null);
    assert.ok(BLOCK_KINDS.includes('video'));
  });
  it('stripMintedMedia: an LLM-minted remote src is stripped (ref survives; src-only block drops whole); data: raster + non-media blocks untouched', async () => {
    const { stripMintedMedia } = await import('./canvasSpec.js');
    const spec = { title: 'T', blocks: [
      { kind: 'image', src: 'https://exfil.example/x.png?data=secret', ref: 'kb:1#img1', alt: 'a' },
      { kind: 'image', src: 'https://exfil.example/y.png', alt: 'b' },
      { kind: 'image', src: 'data:image/png;base64,AAAA', alt: 'c' },
      { kind: 'video', src: 'https://exfil.example/v.mp4', label: 'd' },
      { kind: 'markdown', text: 'see https://ok.example (prose, untouched)' },
    ] };
    const out = stripMintedMedia(spec);
    assert.equal(out.blocks.length, 3);                       // b (src-only image) + d (src-only video) dropped whole
    assert.equal(out.blocks[0].src, undefined);               // a: minted src stripped…
    assert.equal(out.blocks[0].ref, 'kb:1#img1');             // …the trusted ref survives
    assert.equal(out.blocks[1].src, 'data:image/png;base64,AAAA');   // inline raster (no network) kept
    assert.match(out.blocks[2].text, /ok\.example/);          // prose never touched
  });
});
