// Core/accept.test.js — PB-7 acceptance-bundle builders. Run: node Core/accept.test.js
// (Node 16 locally has no `node --test`; this is a plain assert script. CI may also `node --test` it.)
import assert from 'node:assert';
import {
  canAccept, buildCapabilityAcceptance, buildTrialTrace, buildAcceptance,
  mintCapabilityId, mintTrialRef, ACCEPT_SCHEMA,
} from './accept.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok  -', name); };

const specComplete = {
  intent: 'apply to this job', shape: 'complete', target: 'job application',
  safety: 'irreversible', decidedBy: 'llm',
  subGoals: [
    { id: 'provide-identity', label: 'Provide identity', shape: 'act', scope: 'required', dependsOn: [] },
    { id: 'attach-resume', label: 'Attach resume', shape: 'act', scope: 'required', dependsOn: [] },
  ],
};
const coverComplete = {
  shape: 'complete', complete: true, completionCount: 12, operableCount: 12,
  inoperable: [], orphanRequired: [], hasSuccessAction: true,
  successAction: { id: 'submit1', label: 'Submit Application' },
  reason: '12 required field(s) operable + success action present',
};
const roles = [
  { role: 'firstName', selector: 'input[name="firstName"]', featureId: 'w4d17t', multiplicity: 'one', kind: 'input' },
  { role: 'resume', selector: 'input[aria-label="file-input"]', featureId: 'u6wiqi', multiplicity: 'one', kind: 'input', fieldType: 'file', hidden: true, revealedBy: 'upload-trigger' },
  { role: 'submit', selector: null, featureId: '12wwujm', multiplicity: 'one', kind: 'action' },
];
const trialPass = { verdict: 'trial-pass', score: 1, vector: { resolvedCompleteness: 1, effectMatch: 1, terminalReachable: 1 }, evidence: ['Ran 13 step(s), no errors', 'Reached terminal action (submit) — not fired'] };
const trialFail = { verdict: 'trial-fail', score: 0.3, vector: { effectMatch: 0 }, evidence: ['Run failed'] };
const rawResult = { success: true, stepResults: [{ success: true, actionsRun: 13, actions: [
  { action: 'TYPE', selector: 'input[name="firstName"]', outcome: 'success' },
  { action: 'SET_FILE', selector: 'input[aria-label="file-input"]', outcome: 'success' },
] }] };

// ── the accept gate ──────────────────────────────────────────────────────────
test('canAccept blocks a trial-fail', () => {
  const g = canAccept({ trial: trialFail, cover: coverComplete, spec: specComplete });
  assert.equal(g.ok, false);
});
test('canAccept blocks an incomplete completion intent even on a pass', () => {
  const g = canAccept({ trial: trialPass, cover: { ...coverComplete, complete: false, reason: '2 fields not operable' }, spec: specComplete });
  assert.equal(g.ok, false);
  assert.match(g.reason, /not covered/);
});
test('canAccept passes a complete + trial-pass', () => {
  const g = canAccept({ trial: trialPass, cover: coverComplete, spec: specComplete });
  assert.equal(g.ok, true);
});
test('canAccept passes an act intent on a pass alone (no completeness gate)', () => {
  const actSpec = { shape: 'act', subGoals: [] };
  const actCover = { shape: 'act', complete: true, requiredSubGoals: [], unmetSubGoals: [], reason: 'no required sub-goals' };
  const g = canAccept({ trial: trialPass, cover: actCover, spec: actSpec });
  assert.equal(g.ok, true);
});

// ── lean CapabilityAcceptance ──────────────────────────────────────────────────
test('buildCapabilityAcceptance carries the replayable essence, no raw blobs', () => {
  const cap = buildCapabilityAcceptance({ intent: 'apply to this job', spec: specComplete, cover: coverComplete, roles, trial: trialPass, groundId: 'gnd_1', localeUrl: 'https://x/careers/56', acceptedAt: 1000 });
  assert.equal(cap.schema, ACCEPT_SCHEMA);
  assert.equal(cap.kind, 'substrate-capability');
  assert.equal(cap.id, mintCapabilityId('apply to this job', 'gnd_1', 'https://x/careers/56'));
  assert.equal(cap.shape, 'complete');
  assert.equal(cap.safety, 'irreversible');
  assert.equal(cap.binding.length, 3);
  assert.equal(cap.binding[0].selector, 'input[name="firstName"]');
  assert.equal(cap.binding[1].hidden, true);
  assert.equal(cap.binding[1].revealedBy, 'upload-trigger');
  // self-contained replay: kind + fieldType carried through to the saved capability
  assert.equal(cap.binding[1].kind, 'input');
  assert.equal(cap.binding[1].fieldType, 'file');
  assert.equal(cap.binding[2].kind, 'action');
  assert.equal(cap.cover.complete, true);
  assert.equal(cap.cover.completionCount, 12);
  assert.equal(cap.trial.verdict, 'trial-pass');
  assert.ok(cap.trial.trialRef.startsWith('trial_'));
  assert.equal(cap.lifecycle, 'fresh');
  // no heavy fields leaked into the lean record
  assert.equal(cap.intentSpec, undefined);
  assert.equal(cap.steps, undefined);
});
test('id is stable for the same (intent, ground, locale)', () => {
  const a = mintCapabilityId('X', 'g', 'u');
  const b = mintCapabilityId('X', 'g', 'u');
  const c = mintCapabilityId('X', 'g', 'u2');
  assert.equal(a, b);
  assert.notEqual(a, c);
});
test('intent is matched case-insensitively for the id', () => {
  assert.equal(mintCapabilityId('Apply To This Job', 'g', 'u'), mintCapabilityId('apply to this job', 'g', 'u'));
});

// ── heavy trialTrace ────────────────────────────────────────────────────────────
test('buildTrialTrace keeps the full proof + compact steps + links to capability', () => {
  const selection = {
    matches: { 'provide-identity': ['w4d17t'] },
    orphanRequired: [{ id: 'orphan1' }],
    boundary: { requiredFields: [{ id: 'w4d17t' }, { id: 'orphan1' }], successAction: { id: 'submit1' } },
  };
  const trace = buildTrialTrace({ capabilityId: 'cap_x', trialRef: 'trial_x', intent: 'apply', spec: specComplete, selection, cover: coverComplete, roles, trial: trialPass, result: rawResult, groundId: 'g', localeUrl: 'u', acceptedAt: 2000 });
  assert.equal(trace.schema, ACCEPT_SCHEMA);
  assert.equal(trace.capabilityId, 'cap_x');
  assert.equal(trace.trialRef, 'trial_x');
  assert.deepEqual(trace.intentSpec, specComplete);        // full spec retained
  assert.deepEqual(trace.selection.orphanRequired, ['orphan1']);   // lean: ids only
  assert.deepEqual(trace.selection.boundary.requiredFields, ['w4d17t', 'orphan1']);
  assert.equal(trace.trial.evidence.length, 2);
  assert.equal(trace.steps.length, 2);
  assert.equal(trace.steps[1].action, 'SET_FILE');
});

// ── one-call convenience ──────────────────────────────────────────────────────
test('buildAcceptance gates then returns both linked artifacts', () => {
  const r = buildAcceptance({ intent: 'apply', spec: specComplete, cover: coverComplete, roles, trial: trialPass, result: rawResult, groundId: 'g', localeUrl: 'u', acceptedAt: 3000 });
  assert.equal(r.ok, true);
  assert.equal(r.capability.trial.trialRef, r.trace.trialRef);   // linked
  assert.equal(r.trace.capabilityId, r.capability.id);
});
test('buildAcceptance refuses to build when the gate blocks', () => {
  const r = buildAcceptance({ intent: 'apply', spec: specComplete, cover: coverComplete, roles, trial: trialFail });
  assert.equal(r.ok, false);
  assert.equal(r.capability, undefined);
});

console.log(`\n${passed} passed`);
