// Core/route.test.js — R-1 pure router cascade (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { route } from './route.js';

const cap  = (id, name) => ({ kind: 'capability', capabilityId: id, name });
const prim = (op, name) => ({ kind: 'primitive', op, name });
const TOOLS = [cap('cap_search', 'Search for videos'), prim('OPEN_URL', 'Open URL'), prim('CLICK', 'Click')];

describe('route — front-door cascade (pure, injected deps)', () => {
  it('empty ask -> clarify, touches no dep', async () => {
    let touched = false;
    const d = await route('   ', { lookupAlias: async () => { touched = true; return null; } });
    assert.equal(d.action, 'clarify');
    assert.equal(d.reason, 'empty-ask');
    assert.equal(touched, false);
  });

  it('Tier-0 alias hit -> replay, with ZERO router call (no LLM on the warm path)', async () => {
    let routerCalled = false;
    const d = await route('search for videos', {
      lookupAlias: async () => ({ capabilityId: 'cap_search', name: 'Search for videos' }),
      retrieveTools: async () => TOOLS,
      callRouter: async () => { routerCalled = true; return null; },
    });
    assert.equal(d.action, 'replay');
    assert.equal(d.confidence, 1);
    assert.equal(d.reason, 'alias-hit');
    assert.equal(d.tool.capabilityId, 'cap_search');
    assert.equal(routerCalled, false);
  });

  it('alias key is normalized (trim + lowercase + collapse spaces) before lookup', async () => {
    let seen = null;
    await route('  GO   to   Pixabay  ', { lookupAlias: async (n) => { seen = n; return null; }, callRouter: async () => null });
    assert.equal(seen, 'go to pixabay');
  });

  it('cold: LLM selects a PRIMITIVE -> primitive (the "go to pixabay -> OPEN_URL" fix)', async () => {
    const d = await route('go to pixabay home page', {
      lookupAlias: async () => null,
      retrieveTools: async () => TOOLS,
      callRouter: async () => ({ tool: 'OPEN_URL', params: { url: 'https://pixabay.com' }, confidence: 0.95 }),
    });
    assert.equal(d.action, 'primitive');
    assert.equal(d.tool.op, 'OPEN_URL');
    assert.equal(d.params.url, 'https://pixabay.com');
    assert.equal(d.lowConfidence, false);
  });

  it('cold: LLM selects a saved CAPABILITY -> replay, params bound', async () => {
    const d = await route('find videos of cats', {
      retrieveTools: async () => TOOLS,
      callRouter: async () => ({ tool: { capabilityId: 'cap_search' }, params: { q: 'cats' }, confidence: 0.8 }),
    });
    assert.equal(d.action, 'replay');
    assert.equal(d.tool.capabilityId, 'cap_search');
    assert.equal(d.params.q, 'cats');
  });

  it('gap: needs_demonstration -> demonstrate', async () => {
    const d = await route('do a barrel roll', { retrieveTools: async () => TOOLS, callRouter: async () => ({ needs_demonstration: true, confidence: 0.2 }) });
    assert.equal(d.action, 'demonstrate');
    assert.equal(d.tool, null);
  });

  it('gap: null tool -> demonstrate', async () => {
    const d = await route('x', { retrieveTools: async () => TOOLS, callRouter: async () => ({ tool: null, confidence: 0.3 }) });
    assert.equal(d.action, 'demonstrate');
  });

  it('compound: needs_decompose -> decompose with subAsks (gates the workflow path)', async () => {
    const d = await route('search cats then download the first', {
      retrieveTools: async () => TOOLS,
      callRouter: async () => ({ needs_decompose: true, subAsks: ['search cats', 'download first'], confidence: 0.7 }),
    });
    assert.equal(d.action, 'decompose');
    assert.deepEqual(d.subAsks, ['search cats', 'download first']);
  });

  it('anti-hallucination: a tool NOT in the candidate set -> demonstrate (never dispatch an un-offered tool)', async () => {
    const d = await route('x', { retrieveTools: async () => TOOLS, callRouter: async () => ({ tool: 'NONEXISTENT_OP', confidence: 0.9 }) });
    assert.equal(d.action, 'demonstrate');
    assert.equal(d.reason, 'tool-not-in-palette');
  });

  it('no callRouter -> clarify(no-router) carrying the candidates', async () => {
    const d = await route('x', { retrieveTools: async () => TOOLS });
    assert.equal(d.action, 'clarify');
    assert.equal(d.reason, 'no-router');
    assert.equal(d.candidates.length, 3);
  });

  it('callRouter throws -> clarify(router-failed)', async () => {
    const d = await route('x', { retrieveTools: async () => TOOLS, callRouter: async () => { throw new Error('boom'); } });
    assert.equal(d.action, 'clarify');
    assert.equal(d.reason, 'router-failed');
  });

  it('retrieveTools throws -> candidates [] but the route still proceeds to the LLM', async () => {
    const d = await route('go home', {
      retrieveTools: async () => { throw new Error('x'); },
      callRouter: async ({ tools }) => { assert.deepEqual(tools, []); return { tool: null, confidence: 0.1 }; },
    });
    assert.equal(d.action, 'demonstrate');
  });

  it('low confidence still dispatches but flags lowConfidence for the caller', async () => {
    const d = await route('go to pixabay', {
      retrieveTools: async () => TOOLS,
      callRouter: async () => ({ tool: 'OPEN_URL', params: {}, confidence: 0.2 }),
    }, { minConfidence: 0.4 });
    assert.equal(d.action, 'primitive');
    assert.equal(d.lowConfidence, true);
  });
});
