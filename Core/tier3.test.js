// Core/tier3.test.js — T3X-2 cross-Ground lowering (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkflowRecord, wireCrossGroundData } from './tier3.js';

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

describe('tier3 — T3X wireCrossGroundData (cross-Ground data-flow floor)', () => {
  it('a downstream reference param binds to an upstream output (URL ← job_url)', () => {
    const r = wireCrossGroundData([
      { id: 's0', params: ['KEYWORD'], outputs: ['job_url'] },
      { id: 's1', params: ['URL', 'TITLE'], dependsOn: ['s0'] },
    ]);
    assert.deepEqual(r[1].scopeReads, { URL: 'job_url' }, 'URL is reference-type + shares "url" with job_url');
    assert.equal(r[1].scopeReads.TITLE, undefined, 'TITLE is not a reference param → stays a Workflow input');
    assert.deepEqual(r[0].scopeReads, {}, 's0 has no upstream → no reads');
  });

  it('a STATED value becomes a literal (matched by name / shared token)', () => {
    const r = wireCrossGroundData([{ id: 's0', params: ['KEYWORD'], stated: { keyword: 'senior software engineer' }, outputs: ['job_url'] }]);
    assert.deepEqual(r[0].literals, { KEYWORD: 'senior software engineer' });
  });

  it('end-to-end: wire → buildWorkflowRecord emits literal + scope_binding + the one true Workflow input', () => {
    const resolved = [
      { id: 's0', clause: 'find a senior job on linkedin', groundId: 'gnd_li', capabilityId: 'strat_li', params: ['KEYWORD'], stated: { keyword: 'senior software engineer' }, outputs: ['job_url'] },
      { id: 's1', clause: 'save it to notion', groundId: 'gnd_no', capabilityId: 'strat_no', params: ['URL', 'TITLE'], dependsOn: ['s0'] },
    ];
    wireCrossGroundData(resolved);
    const { workflow } = buildWorkflowRecord({ id: 'wf', intent: 'x', resolved });
    assert.deepEqual(workflow.steps[0].paramBindings.KEYWORD, { kind: 'literal', value: 'senior software engineer' });
    assert.deepEqual(workflow.steps[1].paramBindings.URL, { kind: 'scope_binding', name: 'job_url' });
    assert.deepEqual(workflow.steps[1].paramBindings.TITLE, { kind: 'strategy_param', name: 'TITLE' });
    assert.deepEqual(workflow.params.map((p) => p.name), ['TITLE'], 'only TITLE remains a Workflow input');
  });

  it('no upstream output → a reference param stays unbound (a Workflow input)', () => {
    assert.deepEqual(wireCrossGroundData([{ id: 's0', params: ['URL'] }])[0].scopeReads, {});
  });

  it('a shared-token producer wins over an unrelated reference output', () => {
    const r = wireCrossGroundData([
      { id: 's0', params: [], outputs: ['user_id', 'job_url'] },
      { id: 's1', params: ['URL'], dependsOn: ['s0'] },
    ]);
    assert.deepEqual(r[1].scopeReads, { URL: 'job_url' }, 'URL matches job_url by token, not user_id');
  });

  it('AMBIGUOUS: a ref param + TWO unrelated ref outputs (no shared token) → no guess', () => {
    const r = wireCrossGroundData([
      { id: 's0', params: [], outputs: ['user_id', 'order_number'] },
      { id: 's1', params: ['EMAIL'], dependsOn: ['s0'] },
    ]);
    assert.equal(r[1].scopeReads.EMAIL, undefined, 'two ref outputs, none token-matching EMAIL → unbound, not a wrong guess');
  });

  it('a SINGLE unambiguous reference output binds a ref param with no token overlap', () => {
    const r = wireCrossGroundData([
      { id: 's0', params: [], outputs: ['job_url'] },
      { id: 's1', params: ['LINK'], dependsOn: ['s0'] },
    ]);
    assert.deepEqual(r[1].scopeReads, { LINK: 'job_url' }, 'lone reference output → bound');
  });
});
