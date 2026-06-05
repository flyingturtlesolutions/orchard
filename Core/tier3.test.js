// Core/tier3.test.js — T3X-2 cross-Ground lowering (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkflowRecord } from './tier3.js';

describe('tier3 — T3X-2 buildWorkflowRecord (cross-Ground recursion lowering)', () => {
  const resolved = [
    { id: 's0', clause: 'find a senior job', groundId: 'gnd_li', groundUrl: 'https://www.linkedin.com/', capabilityId: 'strat_li_search', capabilityName: 'Search jobs', params: ['KEYWORD'], literals: { KEYWORD: 'senior engineer' }, produces: ['job_url'] },
    { id: 's1', clause: 'save it to notion', groundId: 'gnd_notion', groundUrl: 'https://www.notion.so/', capabilityId: 'strat_notion_save', capabilityName: 'Save a page', params: ['URL', 'TITLE'], scopeReads: { URL: 'job_url' } },
  ];

  it('two Grounds → a Workflow chaining two Strategy steps; crossGround marked; per-step Ground url', () => {
    const { workflow, gaps, runnable } = buildWorkflowRecord({ id: 'wf1', intent: 'find a senior job and save it to notion', resolved });
    assert.equal(runnable, true);
    assert.deepEqual(gaps, []);
    assert.equal(workflow.steps.length, 2);
    assert.equal(workflow.crossGround, true);
    assert.deepEqual(workflow.groundIds, ['gnd_li', 'gnd_notion']);
    assert.equal(workflow.steps[0].type, 'workflow', 'a `workflow` step dispatches a Strategy (legacy step name)');
    assert.equal(workflow.steps[0].workflowId, 'strat_li_search');
    assert.equal(workflow.steps[1].groundUrl, 'https://www.notion.so/', 'each step carries its Ground entry url for the hop');
  });

  it('paramBindings: literal (stated) / scope_binding (cross-step) / strategy_param (workflow input)', () => {
    const { workflow } = buildWorkflowRecord({ id: 'wf1', intent: 'x', resolved });
    assert.deepEqual(workflow.steps[0].paramBindings.KEYWORD, { kind: 'literal', value: 'senior engineer' });
    assert.deepEqual(workflow.steps[1].paramBindings.URL, { kind: 'scope_binding', name: 'job_url' }, 'consumes the upstream output by name');
    assert.deepEqual(workflow.steps[1].paramBindings.TITLE, { kind: 'strategy_param', name: 'TITLE' }, 'unbound → a Workflow input');
    assert.deepEqual(workflow.params.map((p) => p.name), ['TITLE'], 'only the unbound TITLE surfaces as a Workflow param');
  });

  it('an unbound sub-intent → a gap; not runnable; only bound sub-intents become steps', () => {
    const r = buildWorkflowRecord({ id: 'wf2', intent: 'x', resolved: [resolved[0], { id: 's1', clause: 'do the thing', groundId: 'gnd_x' }] });
    assert.equal(r.runnable, false);
    assert.equal(r.gaps.length, 1);
    assert.equal(r.gaps[0].id, 's1');
    assert.equal(r.workflow.steps.length, 1);
  });

  it('all sub-intents on ONE Ground → crossGround false', () => {
    const same = [
      { id: 's0', clause: 'a', groundId: 'gnd_li', capabilityId: 'c0', params: [] },
      { id: 's1', clause: 'b', groundId: 'gnd_li', capabilityId: 'c1', params: [] },
    ];
    const { workflow } = buildWorkflowRecord({ id: 'wf3', intent: 'x', resolved: same });
    assert.equal(workflow.crossGround, false);
    assert.deepEqual(workflow.groundIds, ['gnd_li']);
  });

  it('no id / no sub-intents → null', () => {
    assert.equal(buildWorkflowRecord({ id: '', resolved }).workflow, null);
    assert.equal(buildWorkflowRecord({ id: 'wf', resolved: [] }).workflow, null);
  });
});
