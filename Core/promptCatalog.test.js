// Core/promptCatalog.test.js — v2.74.1710: the LIVE system-prompt catalog for Studio's Docs tab.
//
// The load-bearing property is ANTI-DRIFT: the catalog's text is the builder's OWN output, not a copy — so a
// change to a prompt is a change to the Docs tab, and the modern family can never silently fall out of the list.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { livePromptCatalog, livePromptTexts, livePromptMeta } from './promptCatalog.js';
import { buildStepsMessages } from './stepsPrompt.js';

describe('promptCatalog — the modern prompt family is present and LIVE', () => {
  it('every entry carries render metadata AND non-empty live text', () => {
    const cat = livePromptCatalog();
    assert.ok(cat.length >= 15, `expected the modern family (~15); got ${cat.length}`);
    for (const e of cat) {
      assert.ok(e.id && e.label && e.badge && e.desc, `entry missing metadata: ${JSON.stringify(e)}`);
      assert.ok(typeof e.system === 'string' && e.system.length > 50, `${e.id} has no live text`);
    }
  });

  it('the decomposer entry is the LIVE prompt, not a snapshot (the whole point)', () => {
    // Equality with the builder's own output is the anti-drift guarantee: edit stepsPrompt.js and this moves with it.
    const live = livePromptTexts().decomposeSteps;
    const fromBuilder = buildStepsMessages('get the open tasks and show each one in a new case', { host: 'example.com' }).system;
    assert.equal(live, fromBuilder);
  });

  it('the decomposer includes text added in v1709 — a snapshot would not have it', () => {
    assert.match(livePromptTexts().decomposeSteps, /FEWEST steps/);
    assert.match(livePromptTexts().decomposeSteps, /BUT THESE ARE ONE STEP/);
  });

  it('ids are unique, so the merge into the snapshot map is unambiguous', () => {
    const ids = livePromptCatalog().map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('livePromptMeta strips the text (it is the render registry, not the payload)', () => {
    const meta = livePromptMeta();
    assert.equal(meta.length, livePromptCatalog().length);
    for (const m of meta) assert.ok(!('system' in m) && m.id && m.label && m.badge && m.desc);
  });

  it('livePromptTexts is a {id: text} map covering every entry with text', () => {
    const map = livePromptTexts();
    for (const e of livePromptCatalog()) assert.equal(map[e.id], e.system);
  });

  it('badges are drawn from the known Studio set', () => {
    const known = new Set(['walk', 'discovery', 'profiling', 'routing', 'authoring', 'observation', 'recovery', 'frontier', 'misc']);
    for (const e of livePromptCatalog()) assert.ok(known.has(e.badge), `unknown badge ${e.badge} on ${e.id}`);
  });
});
