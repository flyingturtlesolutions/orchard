// Core/decisionMarkers.test.js — CW-3a (DESIGN_cloud_logs.md ruling 8): the marker manifest. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DECISION_MARKERS, buildDecisionRegExp, metricMarkers } from './decisionMarkers.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe('decisionMarkers — the manifest', () => {
  it('keys are unique and every src compiles as a regex fragment', () => {
    const keys = new Set();
    for (const m of DECISION_MARKERS) {
      assert.ok(m.key && !keys.has(m.key), `duplicate/empty key: ${m.key}`);
      keys.add(m.key);
      assert.doesNotThrow(() => new RegExp(m.src), `src does not compile: ${m.key}`);
    }
  });

  it('buildDecisionRegExp matches the marker families the decisions view lives on', () => {
    const re = buildDecisionRegExp();
    for (const line of [
      'ROUTE ▸ front-door claim',
      'WORKFLOW ▸ banked "get open tasks"',
      'CADENCE ▸ fired wf_abc (due 2m)',
      'HEAL ▸ suspect vendorsuite.drhorton.com',
      'VITALS ▸ case opened — [presence] deako.zendesk.com',
      'TARGET ▸ resolve "show tickets" → desk',
      'SHIPPER ▸ gap — dropped 12 events (quota)',
      '▶ RUN capability x',
    ]) assert.ok(re.test(line), `should match: ${line}`);
    for (const line of [
      'Message: VITALS_BADGE',
      'API call success — 174 chars',
      'plain prose with no marker',
    ]) assert.ok(!re.test(line), `should NOT match: ${line}`);
  });

  it('the metric subset is non-empty and every entry carries a pattern (the generator consumes this)', () => {
    const mm = metricMarkers();
    assert.ok(mm.length >= 4, 'heal/cadence/vitals/shipper at minimum');
    for (const m of mm) assert.ok(m.key && Array.isArray(m.patterns) && m.patterns.length && m.patterns.every((p) => typeof p === 'string' && !/[%|()\\]/.test(p)), `metric entry needs LITERAL patterns (CloudWatch filter syntax): ${m.key}`);
  });

  it('studio.js DERIVES its filter from the manifest (the hand-list stays dead — invariant #1 restructured)', () => {
    const studio = readFileSync(join(root, 'studio.js'), 'utf8');
    assert.ok(studio.includes('buildDecisionRegExp()'), 'studio must call the derivation');
    assert.ok(!/const _DECISION_RE = \/\(/.test(studio), 'the literal regex must not return');
  });

  it('advisory — ▸-style marker stems in chat.js/background missing from the manifest (add them THERE)', () => {
    const stems = new Set(DECISION_MARKERS.map((m) => m.src.replace(/\\/g, '').split('▸')[0].trim()).filter(Boolean));
    const missing = new Set();
    for (const f of ['chat.js', 'background.js']) {
      const src = readFileSync(join(root, f), 'utf8');
      for (const m of src.matchAll(/`([A-Z_]{2,20}) {0,3}▸/g)) {
        if (!stems.has(m[1])) missing.add(m[1]);
      }
    }
    if (missing.size) console.warn(`  [advisory] marker stems not in Core/decisionMarkers.js: ${[...missing].join(', ')} — a decisions download cannot see them`);
  });
});
