// Core/observedTrace.test.js — OBS-1 unit tests (node --test). PURE: synthetic captured parts.
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness. These document the contract.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRawAction, classifyKind, scrubValue, isSensitiveField, coalesce, REDACTED } from './observedTrace.js';

describe('observedTrace — classify + scrub (OBS-1)', () => {
  it('classifyKind: click on an option is a SELECT; a plain button is a click', () => {
    assert.equal(classifyKind('click', { role: 'option' }), 'select');
    assert.equal(classifyKind('click', { tagName: 'BUTTON', role: 'button' }), 'click');
    assert.equal(classifyKind('input', { tagName: 'INPUT' }), 'type');
    assert.equal(classifyKind('input', { tagName: 'SELECT' }), 'select');
    assert.equal(classifyKind('submit', {}), 'submit');
  });

  it('sensitive fields redact the value; ordinary fields keep it', () => {
    assert.equal(isSensitiveField({ type: 'password' }), true);
    assert.equal(isSensitiveField({ name: 'cc-number' }), true);
    assert.equal(isSensitiveField({ accessibleName: 'Security code (CVV)' }), true);
    assert.equal(isSensitiveField({ name: 'q', accessibleName: 'Search' }), false);
    assert.equal(scrubValue('hunter2', { type: 'password' }), REDACTED);
    assert.equal(scrubValue('android dev', { name: 'q' }), 'android dev');
  });
});

describe('observedTrace — buildRawAction + coalesce (OBS-1)', () => {
  it('a typed search input → kind type with the value + element identity', () => {
    const a = buildRawAction({ ts: 1, url: 'https://x/jobs', domKind: 'input', value: 'test', target: { tagName: 'INPUT', role: 'textbox', accessibleName: 'Job title', selector: 'input[name=q]', name: 'q' } });
    assert.equal(a.kind, 'type');
    assert.equal(a.value, 'test');
    assert.equal(a.target.accessibleName, 'Job title');
    assert.equal(a.target.selector, 'input[name=q]');
  });

  it('a clicked dropdown option → kind select with the option label as value', () => {
    const a = buildRawAction({ domKind: 'click', value: '$20.00+/hour', target: { tagName: 'LI', role: 'option', accessibleName: '$20.00+/hour', selector: '#pay>li:nth-of-type(2)' } });
    assert.equal(a.kind, 'select');
    assert.equal(a.value, '$20.00+/hour');
  });

  it('a navigate action carries from/to', () => {
    const a = buildRawAction({ domKind: 'navigate', url: 'https://x/jobs?q=test', from: 'https://x' });
    assert.equal(a.kind, 'navigate');
    assert.equal(a.to, 'https://x/jobs?q=test');
    assert.equal(a.from, 'https://x');
  });

  it('coalesce collapses a keystroke burst into one TYPE (final value) and re-sequences', () => {
    const raw = ['t', 'te', 'test'].map((v) => buildRawAction({ domKind: 'input', value: v, target: { tagName: 'INPUT', selector: '#q' } }))
      .concat(buildRawAction({ domKind: 'click', target: { tagName: 'BUTTON', role: 'button', selector: '#go' } }));
    const c = coalesce(raw);
    assert.equal(c.length, 2);
    assert.equal(c[0].kind, 'type');
    assert.equal(c[0].value, 'test');
    assert.equal(c[1].kind, 'click');
    assert.deepEqual(c.map((a) => a.seq), [0, 1]);
  });

  it('coalesce dedupes a repeated navigation', () => {
    const raw = [
      buildRawAction({ domKind: 'navigate', url: 'https://x/jobs?q=test' }),
      buildRawAction({ domKind: 'navigate', url: 'https://x/jobs?q=test' }),
    ];
    assert.equal(coalesce(raw).length, 1);
  });
});
