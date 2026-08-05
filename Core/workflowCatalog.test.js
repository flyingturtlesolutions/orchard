/**
 * WFG-1 (DESIGN_workflows.md §8) — the workflow-template catalog: shape validity, the ≥2-step floor, unique ids,
 * membership filter, and by-id lookup. PURE module — no chrome/DOM/LLM.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_PRESETS, normalizeWorkflowPreset, galleryWorkflows, workflowPreset } from './workflowCatalog.js';

// The shipped set is EMPTY by direction (v2.74.2009) and grows back one hand-built template at a time, so these
// assertions are written to hold at zero AND at N: they never assert a COUNT, only that whatever ships is valid.
// Adding a preset therefore needs no test edit — it is covered by the floor, the id uniqueness and the lookup on
// arrival. The shape/rejection rules below run on fixtures, so they keep their teeth with the catalog empty.
describe('workflowCatalog — the shipped templates', () => {
  it('drops nothing silently: every shipped preset is gallery-valid', () => {
    assert.equal(galleryWorkflows().length, WORKFLOW_PRESETS.length, 'a shipped preset failed normalization and vanished from the gallery');
  });

  it('every template obeys the ≥2-step workflow floor and carries an umbrella ask + name', () => {
    for (const p of galleryWorkflows()) {
      assert.ok(p.id && p.name && p.ask, `id/name/ask present: ${p.id}`);
      assert.ok(Array.isArray(p.subAsks) && p.subAsks.length >= 2, `≥2 steps: ${p.id}`);
      assert.equal(p.schema, 1, 'templates are phrasing-only (schema 1)');
      assert.ok(p.subAsks.every((s) => typeof s === 'string' && s.trim()), `no blank steps: ${p.id}`);
    }
  });

  it('ids are unique (the gallery keys off id)', () => {
    const ids = galleryWorkflows().map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate template id');
  });
});

describe('workflowCatalog — normalizeWorkflowPreset', () => {
  it('rejects the malformed: missing fields, <2 steps, non-objects', () => {
    assert.equal(normalizeWorkflowPreset(null), null);
    assert.equal(normalizeWorkflowPreset({}), null);
    assert.equal(normalizeWorkflowPreset({ id: 'x', name: 'X', ask: 'do x', subAsks: ['only one'] }), null, '<2 steps → null (the floor)');
    assert.equal(normalizeWorkflowPreset({ id: 'x', name: 'X', ask: '', subAsks: ['a', 'b'] }), null, 'no ask → null');
    assert.equal(normalizeWorkflowPreset({ name: 'X', ask: 'do x', subAsks: ['a', 'b'] }), null, 'no id → null');
  });

  it('trims, drops blank steps, and forces schema 1 + a null suits when absent', () => {
    const p = normalizeWorkflowPreset({ id: '  t  ', name: ' T ', ask: ' go ', subAsks: [' a ', '', '  ', ' b '], schema: 9 });
    assert.equal(p.id, 't');
    assert.equal(p.name, 'T');
    assert.equal(p.ask, 'go');
    assert.deepEqual(p.subAsks, ['a', 'b'], 'blank steps dropped, ends trimmed');
    assert.equal(p.schema, 1, 'schema is forced to 1');
    assert.equal(p.suits, null, 'absent suits normalizes to null');
  });

  it('keeps a well-formed suits object but rejects an array', () => {
    assert.deepEqual(normalizeWorkflowPreset({ id: 't', name: 'T', ask: 'go', subAsks: ['a', 'b'], suits: { types: ['inbox'] } }).suits, { types: ['inbox'] });
    assert.equal(normalizeWorkflowPreset({ id: 't', name: 'T', ask: 'go', subAsks: ['a', 'b'], suits: ['inbox'] }).suits, null);
  });
});

describe('workflowCatalog — workflowPreset(id)', () => {
  it('resolves every shipped id and returns null for the unknown/empty', () => {
    for (const p of galleryWorkflows()) assert.equal(workflowPreset(p.id).name, p.name, `shipped id must resolve: ${p.id}`);
    assert.equal(workflowPreset('nope-not-a-template'), null);
    assert.equal(workflowPreset(''), null);
    assert.equal(workflowPreset(null), null);
  });
});
