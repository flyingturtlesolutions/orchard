// Core/tier3.test.js — T3X-2 cross-Ground lowering (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkflowRecord, wireCrossGroundData, buildGapRepairs, planCompensation } from './tier3.js';

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

  it('a T1 FRAGMENT sub-intent → step.capabilityKind "fragment"; an absent kind defaults to "strategy"', () => {
    const r = buildWorkflowRecord({ id: 'wf', intent: 'x', resolved: [
      { id: 's0', clause: 'search jobs on indeed', groundId: 'gnd_li', capabilityId: 'frag_1', capabilityKind: 'fragment', params: [] },
      { id: 's1', clause: 'save it to notion',     groundId: 'gnd_no', capabilityId: 'strat_2', params: [] },   // no kind → default
    ] });
    assert.equal(r.workflow.steps[0].capabilityKind, 'fragment', 'a bare T1 Fragment step is flagged for run-time wrap');
    assert.equal(r.workflow.steps[0].workflowId, 'frag_1', 'the dispatch id is the Fragment id');
    assert.equal(r.workflow.steps[1].capabilityKind, 'strategy', 'absent capabilityKind → strategy (back-compat with old records)');
  });

  it('an IRREVERSIBLE consumer (reversible:false) stamps the step; reversible/absent leaves it off', () => {
    const r = buildWorkflowRecord({ id: 'wf', intent: 'x', resolved: [
      { id: 's0', clause: 'search jazz singer jobs', groundId: 'gnd_in', capabilityId: 'frag_1', params: [], reversible: true },
      { id: 's1', clause: 'apply to the top job',    groundId: 'gnd_in', capabilityId: 'strat_2', params: [], reversible: false },
      { id: 's2', clause: 'save it to notion',       groundId: 'gnd_no', capabilityId: 'strat_3', params: [] },   // no flag
    ] });
    assert.equal(r.workflow.steps[0].reversible, undefined, 'a reversible step carries no flag (lean record)');
    assert.equal(r.workflow.steps[1].reversible, false, 'the irreversible apply step is stamped so a saved re-run/executor can gate it');
    assert.equal(r.workflow.steps[2].reversible, undefined, 'an absent flag defaults to reversible (no stamp)');
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

  // DF read→write — the CONTRACT the data-flow binder must feed: an upstream READ whose only product is a declared
  // output (no params, e.g. an observation exposing `cap.output`) + a downstream WRITE with a reference param ⇒ the
  // lowered Workflow's write step gets a scope_binding and surfaces NO Workflow input for it.
  // (docs/DESIGN_t3_dataflow_gap.md §3. The runtime + this wiring are ready; the binder surfaces outputs + antecedent.)
  // v2.74.789/792 — the READ step is OBSERVATION-NATIVE: it carries `outputName` (the scope key the value lands
  // under) and its `antecedentCapabilityId` (the prerequisite ACTION — the search — the executor REPLAYS, as a
  // capability, before the read). It does NOT carry `observe` (the wrap-as-Strategy route was removed); the read
  // runs via RUN_OBSERVATION and the antecedent via REPLAY_SG_CAPABILITY.
  it('DF read→write: an upstream read output → the write step is a scope_binding (no Workflow input)', () => {
    const resolved = [
      { id: 's0', clause: 'get the top job link on linkedin', groundId: 'gnd_li', capabilityId: 'obs_top_job', capabilityKind: 'observation', params: [], outputs: ['job_url'], antecedentCapabilityId: 'cap_search_jobs', antecedentParamBindings: { SEARCH: { kind: 'literal', value: 'react' } } },
      { id: 's1', clause: 'save it to notion',                 groundId: 'gnd_no', capabilityId: 'strat_save', capabilityKind: 'strategy', params: ['URL'], dependsOn: ['s0'] },
    ];
    wireCrossGroundData(resolved);
    assert.deepEqual(resolved[1].scopeReads, { URL: 'job_url' }, 'the write consumes the read’s output by reference');
    const { workflow, runnable } = buildWorkflowRecord({ id: 'wf', intent: 'x', resolved });
    assert.equal(runnable, true);
    assert.equal(workflow.steps[0].capabilityKind, 'observation', 'the read step dispatches observation-native');
    assert.equal(workflow.steps[0].outputName, 'job_url', 'the read emits its value under outputName for downstream scope_binding');
    assert.equal(workflow.steps[0].antecedentCapabilityId, 'cap_search_jobs', 'the prerequisite ACTION (the search) the executor replays before the read');
    assert.deepEqual(workflow.steps[0].antecedentParamBindings, { SEARCH: { kind: 'literal', value: 'react' } }, 'the antecedent’s own param bindings ride on the step');
    assert.equal(workflow.steps[0].observe, undefined, 'no embedded observe — the read runs via RUN_OBSERVATION, not a wrapped Strategy');
    assert.deepEqual(workflow.steps[1].paramBindings.URL, { kind: 'scope_binding', name: 'job_url' }, 'URL flows from the upstream read, not from the user');
    assert.deepEqual(workflow.params, [], 'no URL Workflow input — the value comes across Grounds');
  });

  // v2.74.803 (Step 2b) — the cross-Ground data hand-off must bind a PLAIN param (a search box), not only url/email/id
  // refs: "search Pixabay for the title you read" → the read's output flows into Pixabay's search param.
  it('DF read→search: a NON-ref search param binds the sole upstream output it dependsOn', () => {
    const r = wireCrossGroundData([
      { id: 's0', params: [], outputs: ['top_job_title'] },                                  // the Indeed read
      { id: 's1', params: ['SEARCH_FOR_FREE_IMAGES_VIDEOS_MUSIC_MORE'], dependsOn: ['s0'] },  // the Pixabay search
    ]);
    assert.deepEqual(r[1].scopeReads, { SEARCH_FOR_FREE_IMAGES_VIDEOS_MUSIC_MORE: 'top_job_title' },
      'the search box consumes the read output across Grounds, though it is not a url/email/id ref');
  });

  it('DF read→search: a stated literal on the consumer still wins over the hand-off (explicit value beats the read)', () => {
    const r = wireCrossGroundData([
      { id: 's0', params: [], outputs: ['top_job_title'] },
      { id: 's1', params: ['SEARCH'], dependsOn: ['s0'], stated: { search: 'cats' } },
    ]);
    assert.deepEqual(r[1].literals, { SEARCH: 'cats' }, 'a stated value is a literal');
    assert.equal(r[1].scopeReads.SEARCH, undefined, 'no scope_binding when the user gave an explicit value');
  });

  it('DF read→search: AMBIGUOUS (2 dep outputs, 2 open plain params, no shared token) → no blind guess', () => {
    const r = wireCrossGroundData([
      { id: 's0', params: [], outputs: ['title', 'company'] },
      { id: 's1', params: ['SEARCH', 'CATEGORY'], dependsOn: ['s0'] },
    ]);
    assert.equal(r[1].scopeReads.SEARCH, undefined, 'sole-dep guard (1 dep ↔ 1 slot) does not fire → no guess');
    assert.equal(r[1].scopeReads.CATEGORY, undefined);
  });
});

describe('tier3 — Q3 buildGapRepairs (unbound sub-intent → actionable repair hint)', () => {
  const groundsById = { gnd_li: { name: 'LinkedIn' }, gnd_notion: { site: 'Notion' } };

  it('a Ground resolved but NO Strategy matched → an author-strategy repair on that Ground', () => {
    const repairs = buildGapRepairs(
      [{ id: 's1', clause: 'save it to notion', groundId: 'gnd_notion' }],   // no capabilityId → gap
      groundsById,
    );
    assert.equal(repairs.length, 1);
    assert.equal(repairs[0].kind, 'author-strategy');
    assert.equal(repairs[0].groundName, 'Notion');
    assert.match(repairs[0].message, /record one there/);
  });

  it('NO Ground at all → a resolve-ground repair', () => {
    const repairs = buildGapRepairs([{ id: 's2', clause: 'do the abstract thing' }], groundsById);
    assert.equal(repairs[0].kind, 'resolve-ground');
    assert.equal(repairs[0].groundId, null);
    assert.match(repairs[0].message, /which site/);
  });

  it('BOUND sub-intents are not gaps (no repair emitted)', () => {
    const repairs = buildGapRepairs(
      [{ id: 's0', clause: 'a', groundId: 'gnd_li', capabilityId: 'strat_x' }],
      groundsById,
    );
    assert.deepEqual(repairs, []);
  });

  it('accepts a Map for groundsById; tolerates empty / non-array', () => {
    const repairs = buildGapRepairs(
      [{ id: 's1', clause: 'x', groundId: 'gnd_li' }],
      new Map([['gnd_li', { name: 'LinkedIn' }]]),
    );
    assert.equal(repairs[0].groundName, 'LinkedIn');
    assert.deepEqual(buildGapRepairs(null, {}), []);
    assert.deepEqual(buildGapRepairs([{ id: 's', groundId: 'gnd_unknown' }], {})[0].groundName, 'gnd_unknown', 'falls back to the id when no record');
  });
});

describe('tier3 — Q5 planCompensation (saga undo for a failed cross-Ground Workflow)', () => {
  const steps = [
    { workflowId: 'strat_create_order', groundId: 'gnd_shop', compensateWith: 'strat_cancel_order' },
    { workflowId: 'strat_reserve_seat', groundId: 'gnd_air',  compensateWith: 'strat_release_seat' },
    { workflowId: 'strat_notify',       groundId: 'gnd_mail' },   // no compensation declared
  ];

  it('undoes COMMITTED steps in REVERSE order; skips steps with no compensateWith', () => {
    const plan = planCompensation(steps, [0, 1]);   // steps 0 and 1 committed, then step 2 failed
    assert.deepEqual(plan, [
      { stepIndex: 1, workflowId: 'strat_release_seat', undoes: 'strat_reserve_seat', groundId: 'gnd_air' },
      { stepIndex: 0, workflowId: 'strat_cancel_order', undoes: 'strat_create_order', groundId: 'gnd_shop' },
    ]);
  });

  it('only the committed steps are compensated (an uncommitted step has no effect to undo)', () => {
    const plan = planCompensation(steps, [0]);   // only step 0 committed
    assert.deepEqual(plan.map((p) => p.stepIndex), [0]);
  });

  it('a step that committed but declares no compensation is left as-is (its effect stands)', () => {
    const plan = planCompensation(steps, [0, 1, 2]);   // all three committed
    assert.deepEqual(plan.map((p) => p.stepIndex), [1, 0], 'step 2 has no compensateWith → not in the plan');
  });

  it('no compensable steps → empty plan (back-compat: a Workflow with no saga is a no-op)', () => {
    assert.deepEqual(planCompensation([{ workflowId: 'a' }, { workflowId: 'b' }], [0, 1]), []);
    assert.deepEqual(planCompensation(steps, []), [], 'nothing committed → nothing to undo');
    assert.deepEqual(planCompensation(null, null), []);
  });
});
