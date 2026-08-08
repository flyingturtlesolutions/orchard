// Core/neckRegistry.test.js — the NECK-REGISTRY SEAL (Stage 7 slice 1, v2.74.1734).
//
// The sensor is the SOURCE ITSELF: every `role: 'routing', operation: '<op>'` pair in
// Services/AnthropicService.js must have exactly one registry row, and every row must still exist in the
// source — a new routing-tagged model call without a graded row is red, a stale row is red. This makes "which
// necks have gates" a DERIVED fact with SEALED judgment (the grade), per the amended DESIGN_decision_gate.md §3.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { NECKS, NECK_GRADES, NECK_GATES, necksByGate, owedNecks } from './neckRegistry.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(REPO, 'Services', 'AnthropicService.js'), 'utf8');
const derivedOps = [...new Set([...SRC.matchAll(/role: 'routing', operation: '([a-z-]+)'/g)].map((m) => m[1]))].sort();

describe('neckRegistry — the seal: derived routing-tagged operations ⟷ graded rows, exact parity', () => {
  it('every routing-tagged operation in the source has a registry row (a new neck without a grade is red)', () => {
    const rows = new Set(NECKS.map((n) => n.operation));
    const missing = derivedOps.filter((op) => !rows.has(op));
    assert.deepEqual(missing, [], `ungraded routing-tagged operations: ${missing.join(' · ')} — add a row to Core/neckRegistry.js`);
  });

  it('every registry row still exists in the source (a stale row is red — the registry cannot outlive the code)', () => {
    const ops = new Set(derivedOps);
    const stale = NECKS.map((n) => n.operation).filter((op) => !ops.has(op));
    assert.deepEqual(stale, [], `rows for vanished operations: ${stale.join(' · ')}`);
  });

  it('the derivation actually derived (the sensor is not vacuous)', () => {
    assert.ok(derivedOps.length >= 15, `expected the routing-tagged family (~15); got ${derivedOps.length}`);
  });
});

describe('neckRegistry — row discipline', () => {
  it('every row: known grade, known gate, a non-empty why, no duplicate operations', () => {
    const seen = new Set();
    for (const n of NECKS) {
      assert.ok(!seen.has(n.operation), `duplicate row ${n.operation}`);
      seen.add(n.operation);
      assert.ok(NECK_GRADES.includes(n.grade), `${n.operation}: unknown grade ${n.grade}`);
      assert.ok(NECK_GATES.includes(n.gate), `${n.operation}: unknown gate ${n.gate}`);
      assert.ok(n.why && n.why.length > 10, `${n.operation}: a row without a why is a silent judgment`);
    }
  });

  it('a ROUTING-grade neck can never be waived — built or owed only (the load-bearing rule)', () => {
    for (const n of NECKS.filter((x) => x.grade === 'routing')) {
      assert.ok(n.gate === 'built' || n.gate === 'owed', `${n.operation} is routing-grade yet ${n.gate}`);
    }
  });

  it('every BUILT row names its suite, and that suite file exists', () => {
    for (const n of necksByGate('built')) {
      assert.ok(n.suite, `${n.operation}: built without naming its suite`);
      assert.ok(fs.existsSync(path.join(REPO, n.suite)), `${n.operation}: suite ${n.suite} does not exist`);
    }
  });

  it('ALL NINE routing-grade necks are gated; the owed list is EMPTY (v1734 Stage 7; step-il retired 2026-08-07; branch-extract added v2.74.2106)', () => {
    assert.deepEqual(necksByGate('built').map((n) => n.operation).sort(),
      ['branch-classify', 'branch-extract', 'decompose-steps', 'interpret', 'judge-match', 'match-workflow', 'route-ask', 'seed-directives', 'sweep-reads']);
    assert.deepEqual(owedNecks(), [], 'a future routing-grade neck starts life on this list — the seal forces the row, this assertion forces the shrink');
  });

  it('the case-brief correction is recorded: routing-TAGGED, presentation-GRADED', () => {
    const cb = NECKS.find((n) => n.operation === 'case-brief');
    assert.equal(cb.grade, 'presentation');
    assert.ok(derivedOps.includes('case-brief'), 'the tag really is routing — which is why the grade must be sealed judgment');
  });
});
