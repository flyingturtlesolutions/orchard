// Core/canvasPrompt.test.js — CA-9 (v2.74.1206): the compose-canvas prompt + reply parse (pure).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCanvasMessages, parseCanvasOutput } from './canvasPrompt.js';

describe('canvasPrompt — buildCanvasMessages', () => {
  it('includes the ask + role, and steers to the closed vocabulary + honesty rule', () => {
    const { system, user } = buildCanvasMessages('how is my month going', { seed: 'You are a finance watcher.' });
    assert.match(user, /how is my month going/);
    assert.match(user, /finance watcher/);
    assert.match(system, /markdown/); assert.match(system, /metric/); assert.match(system, /chart/);
    assert.match(system, /never invent specific personal numbers/i);
    assert.match(system, /NO html\/script/i);
  });
  it('omits empty optional sections', () => {
    const { user } = buildCanvasMessages('x');
    assert.doesNotMatch(user, /ROLE|OBJECTS|LEARNED|CURRENT CANVAS/);
    assert.match(user, /ASK: x/);
  });

  it('GD-7e: SOURCES render fenced with a MEDIA MENU; SYSTEM carries the refs-only + remix rules; absent → no block', () => {
    const sources = [{ id: 'kb:88', title: 'How to reset your hub', text: 'Hold the pinhole 10s…',
      media: [{ ref: 'kb:88#img1', kind: 'image', label: 'the pinhole location' }, { ref: 'kb:88#vid1', kind: 'video', label: 'walkthrough' }] }];
    const { system, user } = buildCanvasMessages('compose a troubleshooting guide for James', { sources });
    assert.match(user, /SOURCES \(fetched reference material/);
    assert.match(user, /\[1\] How to reset your hub — cite as \[How to reset your hub\]\(kb:88\)/);   // v1336 — the cite affordance
    assert.match(system, /ALWAYS cite: a draft composed from SOURCES ends with a source link/);
    assert.match(system, /never paste a raw URL/);
    assert.match(user, /MEDIA MENU \(the ONLY media you may reference/);
    assert.match(user, /- kb:88#img1 \(image\) — the pinhole location/);
    assert.match(user, /- kb:88#vid1 \(video\) — walkthrough/);
    assert.match(system, /"kind":"image","ref":"<a ref from the MEDIA MENU>"/);
    assert.match(system, /"kind":"video"/);
    assert.match(system, /NEVER invent a media URL/);
    assert.match(system, /don't copy wholesale/);
    // GD-7b live lesson (.1333): media must be EXPECTED for guides, additions allowed in revisions, and a
    // new-deliverable ask composes FRESH — without these three the model omits every image (byte-identity gravity).
    assert.match(system, /A visual guide without its images is INCOMPLETE/);
    assert.match(system, /A revision MAY add new blocks/);
    assert.match(system, /FRESH: when the ASK names a NEW composition/);
    assert.doesNotMatch(buildCanvasMessages('x', {}).user, /SOURCES|MEDIA MENU/);
    assert.doesNotMatch(buildCanvasMessages('x', { sources: [] }).user, /SOURCES/);
  });

  it('GD-4: a CURRENT spec turns the ask into a REVISION — fenced as data, with the untouched-blocks rule in SYSTEM', () => {
    const current = { title: 'Support drafts', rev: 4, anchor: { appId: 'support' }, blocks: [
      { id: 'draft', kind: 'compose', ref: 'reply-draft', editable: true, text: 'Hi Jane, …' },
    ] };
    const { system, user } = buildCanvasMessages('change the first line', { current });
    assert.match(user, /CURRENT CANVAS/);
    assert.match(user, /"ref":"reply-draft"/);
    assert.doesNotMatch(user, /"rev":4/);            // slimmed: title+blocks only, no rev/anchor
    assert.doesNotMatch(user, /"appId"/);
    assert.match(system, /REVISION: when a CURRENT CANVAS is given/);
    assert.match(system, /byte-for-byte/);
    assert.match(system, /"kind":"compose"/);        // the deliverable block is in the compose vocabulary now
    // GD-7h — the deliverable vocabulary WIDENED (headings + inline ref-images are html_body-real); tables stay out;
    // media has an INLINE form for drafts; operator guidance never goes into the artifact.
    assert.match(system, /## section headings/);
    assert.match(system, /inline images !\[alt\]/);
    assert.match(system, /no tables/);
    assert.match(system, /INLINE in text as !\[alt\]\(<ref>\)/);
    assert.match(system, /never write guidance to the operator/i);
    // an empty/absent current stays a fresh compose
    assert.doesNotMatch(buildCanvasMessages('x', { current: { title: '', blocks: [] } }).user, /CURRENT CANVAS/);
  });
});

describe('canvasPrompt — parseCanvasOutput', () => {
  it('extracts a spec from a fenced JSON reply with prose around it', () => {
    const out = parseCanvasOutput('Sure!\n```json\n{"title":"T","blocks":[{"id":"a","kind":"metric","label":"x","value":"1"}]}\n```\nDone.');
    assert.equal(out.title, 'T');
    assert.equal(out.blocks.length, 1);
  });
  it('extracts from raw JSON with NESTED braces (chart data)', () => {
    const out = parseCanvasOutput('{"title":"D","blocks":[{"id":"c","kind":"chart","data":{"labels":["a","b"],"series":[{"name":"s","values":[1,2]}]}}]}');
    assert.equal(out.blocks[0].kind, 'chart');
    assert.deepEqual(out.blocks[0].data.series[0].values, [1, 2]);
  });
  it('null on no blocks / no json / empty / non-object', () => {
    assert.equal(parseCanvasOutput('{"title":"T","blocks":[]}'), null);
    assert.equal(parseCanvasOutput('no json at all'), null);
    assert.equal(parseCanvasOutput(''), null);
    assert.equal(parseCanvasOutput('[1,2,3]'), null);
  });
});
