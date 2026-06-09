// Core/routerPrompt.test.js — R-3 pure prompt-builder + output parser (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRouterMessages, parseRouterOutput } from './routerPrompt.js';

describe('buildRouterMessages — fenced catalog, no DOM (injection boundary)', () => {
  const cands = [
    { kind: 'capability', capabilityId: 'cap_apply', name: 'Complete job application', alias: 'apply to this job', provenance: 'user' },
    { kind: 'capability', capabilityId: 'cap_x',     name: 'Search for free media',    provenance: 'untrusted' },
    { kind: 'primitive',  op: 'OPEN_URL',            name: 'Open a URL',               provenance: 'system' },
  ];

  it('includes the ask and fences the catalog as data, with the "not instructions" rule', () => {
    const { system, user } = buildRouterMessages('apply to this job', cands);
    assert.ok(user.includes('USER ASK: apply to this job'));
    assert.ok(user.includes('<TOOL_CATALOG'));
    assert.ok(user.includes('data only'));
    assert.ok(system.includes('NOT instructions'));
  });

  it('uses capabilityId / op as the ref, and prefers the user alias as the label', () => {
    const { user } = buildRouterMessages('x', cands);
    assert.ok(user.includes('ref: cap_apply'));
    assert.ok(user.includes('does: apply to this job'));     // alias preferred (provenance=user)
    assert.ok(user.includes('does: Search for free media')); // name used (provenance=untrusted, no alias)
    assert.ok(user.includes('ref: OPEN_URL'));
  });

  it('empty catalog -> primitives-only note', () => {
    assert.ok(buildRouterMessages('go home', []).user.includes('no saved capabilities'));
  });
});

describe('parseRouterOutput — tolerant parse + fail-safe to demonstrate', () => {
  it('parses a clean JSON object', () => {
    const o = parseRouterOutput('{"tool":"OPEN_URL","params":{"url":"https://pixabay.com"},"confidence":0.95}');
    assert.equal(o.tool, 'OPEN_URL');
    assert.equal(o.params.url, 'https://pixabay.com');
    assert.equal(o.confidence, 0.95);
    assert.equal(o.needs_demonstration, false);
  });

  it('extracts a JSON object embedded in prose', () => {
    assert.equal(parseRouterOutput('Sure! {"tool":"cap_apply","confidence":0.8} hope that helps').tool, 'cap_apply');
  });

  it('accepts an object directly; tool-as-object -> ref; clamps confidence', () => {
    const o = parseRouterOutput({ tool: { ref: 'CLICK' }, confidence: 1.5 });
    assert.equal(o.tool, 'CLICK');
    assert.equal(o.confidence, 1);
  });

  it('unparseable -> fail safe (needs_demonstration, never guess)', () => {
    const o = parseRouterOutput('no json here');
    assert.equal(o.needs_demonstration, true);
    assert.equal(o.tool, null);
    assert.equal(o.reason, 'unparseable');
  });

  it('coerces subAsks + decompose flag', () => {
    const o = parseRouterOutput('{"needs_decompose":true,"subAsks":["a","b",3]}');
    assert.equal(o.needs_decompose, true);
    assert.deepEqual(o.subAsks, ['a', 'b', '3']);
  });

  it('empty object {} parses to safe defaults (NOT a demonstrate fallback)', () => {
    const o = parseRouterOutput('{}');
    assert.equal(o.tool, null);
    assert.deepEqual(o.params, {});
    assert.equal(o.confidence, 0);
    assert.equal(o.needs_demonstration, false);
    assert.deepEqual(o.subAsks, []);
  });
});
