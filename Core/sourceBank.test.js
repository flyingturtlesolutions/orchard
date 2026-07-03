// Core/sourceBank.test.js — GD-7e (v2.74.1330): page → banked SOURCE + the trusted ref resolution (§8.7.1).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pageToSource, sourcesForPrompt, mergedRefMap, resolveMediaRefs, SOURCE_TEXT_MAX } from './sourceBank.js';

const PAGE = {
  title: 'How to reset your hub', url: 'https://help.x.com/hub-reset',
  text: 'Hold the pinhole for 10 seconds…',
  images: [{ src: 'https://cdn.x.com/pinhole.png', alt: 'the pinhole location' }, { src: 'http://insecure.example/a.png', alt: 'nope' }],
  videos: [{ src: 'https://www.youtube.com/embed/abc123', label: 'walkthrough' }],
};

describe('sourceBank — pageToSource (mint refs over a trusted extraction)', () => {
  it('mints kb:<seq>#imgN/#vidN refs, https-only, and keeps the ref→url map OFF the prompt view', () => {
    const s = pageToSource(PAGE, { seq: 7 });
    assert.equal(s.id, 'kb:7');
    assert.deepEqual(s.media.map((m) => m.ref), ['kb:7#img1', 'kb:7#vid1']);   // the http:// image never minted a ref
    assert.equal(s.refs['kb:7#img1'].url, 'https://cdn.x.com/pinhole.png');
    assert.equal(s.media[0].label, 'the pinhole location');
    const slim = sourcesForPrompt([s]);
    assert.equal(slim[0].title, 'How to reset your hub');
    assert.ok(!('refs' in slim[0]) && !('url' in slim[0]));                    // no URLs reach the model
    assert.ok(!JSON.stringify(slim).includes('cdn.x.com'));
  });
  it('dedups media, caps counts, bounds text; empty extraction → null', () => {
    const many = { title: 't', text: 'x'.repeat(SOURCE_TEXT_MAX + 500),
      images: Array.from({ length: 20 }, (_, i) => ({ src: `https://c.x/${i % 10}.png`, alt: '' })) };
    const s = pageToSource(many, { seq: 1 });
    assert.equal(s.text.length, SOURCE_TEXT_MAX);
    assert.equal(s.media.length, 8);                                           // deduped to 10 uniques, capped at 8
    assert.equal(pageToSource({ title: 'empty' }, { seq: 2 }), null);
    assert.equal(pageToSource(null), null);
  });
});

describe('sourceBank — resolveMediaRefs (the trusted render-side resolution)', () => {
  const map = mergedRefMap([pageToSource(PAGE, { seq: 7 })]);
  it('sets src from the TRUSTED map for image + video refs; the ref stays for later adapters', () => {
    const spec = { blocks: [
      { kind: 'image', mediaRef: 'kb:7#img1', alt: 'pinhole' },
      { kind: 'video', ref: 'kb:7#vid1', label: 'walkthrough' },               // raw (pre-normalize) `ref` also resolves
      { kind: 'markdown', text: 'untouched' },
    ] };
    const out = resolveMediaRefs(spec, map);
    assert.equal(out.blocks[0].src, 'https://cdn.x.com/pinhole.png');
    assert.equal(out.blocks[0].mediaRef, 'kb:7#img1');
    assert.equal(out.blocks[1].src, 'https://www.youtube.com/embed/abc123');
    assert.equal(out.blocks[2].text, 'untouched');
  });
  it('an unknown ref stays unresolved (lowers to a visible placeholder, never invented)', () => {
    const out = resolveMediaRefs({ blocks: [{ kind: 'image', mediaRef: 'kb:9#img9', alt: 'x' }] }, map);
    assert.equal(out.blocks[0].src, undefined);
  });
  it('a non-https map entry never resolves (belt on the belt)', () => {
    const out = resolveMediaRefs({ blocks: [{ kind: 'image', mediaRef: 'kb:1#img1' }] }, { 'kb:1#img1': { url: 'javascript:alert(1)', kind: 'image' } });
    assert.equal(out.blocks[0].src, undefined);
  });
  it('v1341 (review G) — mergedRefMap: the NEWEST source wins a ref collision (the bank is newest-first)', () => {
    const newest = { refs: { 'kb:7#img1': { url: 'https://new.example/a.png', kind: 'image' } } };
    const oldest = { refs: { 'kb:7#img1': { url: 'https://old.example/a.png', kind: 'image' }, 'kb:6#img1': { url: 'https://old.example/b.png', kind: 'image' } } };
    const map = mergedRefMap([newest, oldest]);   // newest-first, as stored
    assert.equal(map['kb:7#img1'].url, 'https://new.example/a.png');
    assert.equal(map['kb:6#img1'].url, 'https://old.example/b.png');   // non-colliding entries all survive
  });
});

describe('sourceBank — v1336 source attribution (the "source link always included" guarantee)', () => {
  const banked = [pageToSource(PAGE, { seq: 7 })];
  it('the source id is a resolvable ref to the ARTICLE url (cite without the model touching URLs)', () => {
    assert.equal(banked[0].refs['kb:7'].url, 'https://help.x.com/hub-reset');
    assert.equal(banked[0].refs['kb:7'].kind, 'source');
    assert.equal(sourcesForPrompt(banked)[0].id, 'kb:7');                    // the prompt sees the id, never the url
    assert.ok(!JSON.stringify(sourcesForPrompt(banked)).includes('help.x.com'));
  });
  it('ensureSourceAttribution: appends "Source: [title](kb:N)" to the compose block when NO banked source is cited', async () => {
    const { ensureSourceAttribution } = await import('./sourceBank.js');
    const spec = { blocks: [{ kind: 'markdown', text: 'ctx' }, { kind: 'compose', ref: 'r', text: 'Hi James, do the thing.' }] };
    const out = ensureSourceAttribution(spec, banked);
    assert.match(out.blocks[1].text, /\n\nSource: \[How to reset your hub\]\(kb:7\)$/);
    assert.equal(out.blocks[0].text, 'ctx');                                 // only the compose block gains the line
  });
  it('v1340 (review F): markdown metachars in the untrusted TITLE are escaped — a `](` title cannot forge a link in the shipped draft', async () => {
    const { ensureSourceAttribution, pageToSource } = await import('./sourceBank.js');
    const evil = pageToSource({ title: 'help](https://evil.example/x) [pwn', url: 'https://help.x.com/a', text: 'body' }, { seq: 3 });
    const out = ensureSourceAttribution({ blocks: [{ kind: 'compose', ref: 'r', text: 'Hi.' }] }, [evil]);
    const line = out.blocks[0].text.split('\n').pop();
    assert.ok(!line.includes('](https://evil.example/x)'));                       // the forged link target is dead
    assert.match(line, /^Source: \[help\\\]\\\(https:\/\/evil\.example\/x\\\) \\\[pwn\]\(kb:3\)$/);   // metachars escaped, cite target intact
  });
  it('already-cited / no compose block / no banked sources → spec unchanged', async () => {
    const { ensureSourceAttribution } = await import('./sourceBank.js');
    const cited = { blocks: [{ kind: 'compose', ref: 'r', text: 'See [the guide](kb:7) for more.' }] };
    assert.equal(ensureSourceAttribution(cited, banked).blocks[0].text, cited.blocks[0].text);
    const citedViaMedia = { blocks: [{ kind: 'compose', ref: 'r', text: 'Press ![pinhole](kb:7#img1) now.' }] };
    assert.equal(ensureSourceAttribution(citedViaMedia, banked).blocks[0].text, citedViaMedia.blocks[0].text);
    const noCompose = { blocks: [{ kind: 'markdown', text: 'x' }] };
    assert.deepEqual(ensureSourceAttribution(noCompose, banked), noCompose);
    const spec = { blocks: [{ kind: 'compose', ref: 'r', text: 'Hi.' }] };
    assert.deepEqual(ensureSourceAttribution(spec, []), spec);
  });
});
