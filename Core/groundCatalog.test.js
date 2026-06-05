// Core/groundCatalog.test.js — T3X-1 ground resolution (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildGroundCatalog, matchGrounds, resolveGround, pickValidGround } from './groundCatalog.js';

const GROUNDS = [
  { id: 'gnd_linkedin', name: 'LinkedIn', aliases: ['jobs'], url: 'https://www.linkedin.com/', derivedDescription: 'professional network; find and apply to jobs' },
  { id: 'gnd_notion',   name: 'Notion',   aliases: [],       url: 'https://www.notion.so/',    derivedDescription: 'notes and documents workspace' },
  { id: 'gnd_indeed',   name: 'Indeed',   aliases: [],       url: 'https://www.indeed.com/',   derivedDescription: 'job search board' },
];
const CAPS = { gnd_notion: ['Save a page', 'Create a note'], gnd_linkedin: ['Search jobs', 'Apply to a job'] };

describe('groundCatalog — T3X-1 ground resolution (intent → which site)', () => {
  const cat = buildGroundCatalog(GROUNDS, CAPS);

  it('buildGroundCatalog projects host/name/aliases/description/caps into terms', () => {
    const ln = cat.find((e) => e.groundId === 'gnd_linkedin');
    assert.ok(ln.hostTokens.includes('linkedin'), 'host token = linkedin (no www/tld)');
    assert.ok(ln.terms.includes('jobs') && ln.terms.includes('apply'), 'alias + cap labels folded into terms');
    assert.ok(!ln.hostTokens.includes('com'), 'tld dropped');
  });

  it('a NAMED site wins by host-name hit (the strong signal)', () => {
    const r = matchGrounds('save this to notion', cat);
    assert.equal(r[0].groundId, 'gnd_notion');
    assert.equal(r[0].hostHit, true);
    assert.ok(r[0].score > 1, 'host hit boosts above generic overlap');
  });

  it('resolves a Ground from a CAPABILITY-goal match (no host name)', () => {
    const r = matchGrounds('save a note', cat);
    assert.equal(r[0].groundId, 'gnd_notion', 'matched via the "Save a page"/"Create a note" cap labels');
  });

  it('resolveGround: clear winner → resolved; ambiguous pair → ambiguous; nothing → miss', () => {
    assert.equal(resolveGround('save it to notion', cat).decision, 'resolved');
    assert.equal(resolveGround('xyzzy nonsense', cat).decision, 'miss');
    // "find a job" matches BOTH job boards (linkedin + indeed) → ambiguous (ask "which site?")
    const amb = resolveGround('find a job', cat);
    assert.ok(['ambiguous', 'resolved'].includes(amb.decision));
    assert.ok(amb.candidates.length >= 1);
  });

  it('empty / stop-word-only ask → no match', () => {
    assert.equal(matchGrounds('', cat).length, 0);
    assert.equal(resolveGround('the to a', cat).decision, 'miss');
  });

  it('buildGroundCatalog tolerates id|groundId, url|urlPatterns, missing fields', () => {
    const c = buildGroundCatalog([
      { groundId: 'g1', urlPatterns: ['https://x.com/*'] },
      { id: 'g2' },
      null,
      { name: 'no id — skipped' },
    ]);
    assert.deepEqual(c.map((e) => e.groundId), ['g1', 'g2'], 'null + id-less entries skipped');
  });

  it('Q2 pickValidGround snaps an LLM choice to a real Ground (closed-set; never invents)', () => {
    assert.equal(pickValidGround('gnd_notion', cat), 'gnd_notion');
    assert.equal(pickValidGround('gnd_hallucinated', cat), null, 'an invented id → null');
    assert.equal(pickValidGround('null', cat), null, 'the literal "null" → null');
    assert.equal(pickValidGround('', cat), null);
    assert.equal(pickValidGround(null, cat), null);
    assert.equal(pickValidGround('gnd_notion', []), null, 'empty catalog → null');
  });
});
