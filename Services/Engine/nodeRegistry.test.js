// Services/Engine/nodeRegistry.test.js — CR-X1a registry tests (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NODE_TYPES, describeNode, childLists } from './nodeRegistry.js';

describe('nodeRegistry — the strategy node-type single source (CR-X1a)', () => {
  it('NODE_TYPES: the 12 canonical types, frozen', () => {
    assert.deepEqual([...NODE_TYPES].sort(), [
      'detect', 'foreach', 'fragment', 'in_new_tab', 'loop', 'navigate',
      'observation', 'pause', 'scroll', 'sieve', 'try', 'wait',
    ]);
    assert.ok(Object.isFrozen(NODE_TYPES));
  });

  it('describeNode: every canonical type gets a non-empty label; null/unknown degrade', () => {
    for (const type of NODE_TYPES) {
      const label = describeNode({ type });
      assert.equal(typeof label, 'string');
      assert.ok(label.length > 0, `${type} → empty label`);
    }
    assert.equal(describeNode(null), '?');
    assert.equal(describeNode({ type: 'martian' }), 'martian');   // fall-through echoes the type
  });

  it('describeNode: the parameterized labels read their fields', () => {
    assert.equal(describeNode({ type: 'foreach', over: 'ROWS', as: 'row' }), 'FOREACH ROWS as row');
    assert.equal(describeNode({ type: 'sieve', source: 'A', output: 'B' }), 'SIEVE A → B');
    assert.equal(describeNode({ type: 'detect', branches: [{}, {}] }), 'DETECT (2 branch(es))');
    assert.equal(describeNode({ type: 'scroll', distance: { kind: 'literal', value: 2 } }), 'SCROLL by 2 viewport(s)');
    assert.equal(describeNode({ type: 'scroll', distance: { kind: 'strategy_param', name: 'N' } }), 'SCROLL by {{N}} viewport(s)');
  });

  it('childLists: container types expose every body-shaped list in walk order', () => {
    const body = [{ type: 'wait' }];
    const recover = [{ type: 'pause' }];
    assert.deepEqual(childLists({ type: 'foreach', body }), [body]);
    assert.deepEqual(childLists({ type: 'loop', body }), [body]);
    assert.deepEqual(childLists({ type: 'try', body, recover }), [body, recover]);
    const b1 = [{ type: 'fragment' }]; const b2 = [{ type: 'scroll' }]; const dflt = [{ type: 'wait' }];
    assert.deepEqual(
      childLists({ type: 'detect', branches: [{ body: b1 }, { body: b2 }], default: dflt }),
      [b1, b2, dflt],
    );
    const trigger = { type: 'fragment', fragmentId: 'f1' };
    assert.deepEqual(childLists({ type: 'in_new_tab', trigger, body }), [[trigger], body]);
  });

  it('childLists: leaves return []; missing lists become empty arrays, never null', () => {
    for (const type of ['fragment', 'wait', 'pause', 'sieve', 'navigate', 'scroll', 'observation']) {
      assert.deepEqual(childLists({ type }), [], `${type} should have no child lists`);
    }
    assert.deepEqual(childLists({ type: 'foreach' }), [[]]);
    assert.deepEqual(childLists({ type: 'try' }), [[], []]);
    assert.deepEqual(childLists({ type: 'in_new_tab' }), [[], []], 'null trigger → empty first list');
    assert.deepEqual(childLists(null), []);
  });
});
