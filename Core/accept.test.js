// Core/accept.test.js — SG-LM-4 promotion builders. Run: node Core/accept.test.js
// (Node 16 has no `node --test`; this is a plain assert script.)
import assert from 'node:assert';
import {
  canAccept, buildLandmarkRecords, buildPerspectiveRecord, buildPerspectivePredicates, buildResultsLandmarkRecord, buildOutcomePerspective, buildCapabilityAcceptance,
  buildTrialTrace, buildAcceptance, landmarkRefActions, buildParamSchema, buildTerminalDescriptor,
  mintCapabilityId, mintLandmarkUid, mintPerspectiveId, ACCEPT_SCHEMA,
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
  reason: '12 required field(s) operable + success action present',
};
// roles carry a proto-landmark (SG-LM-2). file input has no recoverable role → no landmark.
const roles = [
  { role: 'firstName', selector: 'input[name="firstName"]', featureId: 'w4d17t', multiplicity: 'one', kind: 'input',
    landmark: { role: 'textbox', accessibleName: 'First name', hierarchicalContext: null, selector: 'input[name="firstName"]' } },
  { role: 'resume', selector: 'input[aria-label="file-input"]', featureId: 'u6wiqi', multiplicity: 'one', kind: 'input', fieldType: 'file',
    landmark: null },
  { role: 'submit', selector: 'button.s', featureId: '12wwujm', multiplicity: 'one', kind: 'action',
    landmark: { role: 'button', accessibleName: 'Submit Application', hierarchicalContext: null, selector: 'button.s' } },
];
const trialPass = { verdict: 'trial-pass', score: 1, vector: { resolvedCompleteness: 1, effectMatch: 1, terminalReachable: 1 }, evidence: ['Ran 13 step(s), no errors'] };
const trialFail = { verdict: 'trial-fail', score: 0.3, vector: { effectMatch: 0 }, evidence: ['Run failed'] };
const rawResult = { success: true, stepResults: [{ success: true, actionsRun: 13, actions: [
  { action: 'TYPE', selector: 'input[name="firstName"]', outcome: 'success' },
] }] };
const base = { intent: 'apply to this job', spec: specComplete, cover: coverComplete, roles, trial: trialPass, result: rawResult, groundId: 'gnd_1', localeUrl: 'https://x/careers/56', acceptedAt: 1000 };

// ── gate ──
test('canAccept blocks a trial-fail', () => { assert.equal(canAccept({ trial: trialFail, cover: coverComplete, spec: specComplete }).ok, false); });
test('canAccept blocks an incomplete completion intent on a pass', () => {
  assert.equal(canAccept({ trial: trialPass, cover: { ...coverComplete, complete: false, reason: 'x' }, spec: specComplete }).ok, false);
});
test('canAccept passes a complete + trial-pass', () => { assert.equal(canAccept({ trial: trialPass, cover: coverComplete, spec: specComplete }).ok, true); });

// ── landmark promotion ──
test('buildLandmarkRecords mints a landmark per recoverable role (file w/o role excluded)', () => {
  const lms = buildLandmarkRecords({ roles, groundId: 'gnd_1', localeUrl: 'u', acceptedAt: 1000 });
  assert.equal(lms.length, 2);                       // firstName + submit; resume (no landmark) excluded
  const byRole = Object.fromEntries(lms.map(l => [l.role, l]));
  assert.equal(byRole.firstName.record.a11yRole, 'textbox');
  assert.equal(byRole.firstName.record.accessibleName, 'First name');
  assert.equal(byRole.firstName.record.alias, 'firstName');
  assert.equal(byRole.firstName.record.lifecycle, 'fresh');
  assert.equal(byRole.firstName.record.groundId, 'gnd_1');
  assert.equal(byRole.submit.record.a11yRole, 'button');
  assert.ok(byRole.firstName.uid.startsWith('lmk_sg_'));
});
test('landmark uid is stable for the same identity', () => {
  const lm = { role: 'button', accessibleName: 'Sign in', selector: 'b.x' };
  assert.equal(mintLandmarkUid('g', 'u', lm), mintLandmarkUid('g', 'u', lm));
  assert.notEqual(mintLandmarkUid('g', 'u', lm), mintLandmarkUid('g', 'u2', lm));
});

// ── perspective ──
test('buildPerspectiveRecord composes the landmark uids, authoredBy model', () => {
  const p = buildPerspectiveRecord({ intent: 'apply to this job', spec: specComplete, groundId: 'gnd_1', localeUrl: 'u', landmarkUids: ['lmk_sg_a', 'lmk_sg_b'], acceptedAt: 1000 });
  assert.equal(p.id, mintPerspectiveId('apply to this job', 'gnd_1', 'u'));
  assert.deepEqual(p.landmarkRefs, ['lmk_sg_a', 'lmk_sg_b']);
  assert.equal(p.authoredBy, 'model');
  // a Perspective is the substrate SELECTION, not the Fragment — its name is distinct (· landmarks), not the bare intent
  assert.equal(p.name, 'apply to this job · landmarks');
  assert.equal(p.intent, 'apply to this job', 'the intent field stays the bare intent (used for the id/matching)');
  assert.equal(p.groundId, 'gnd_1');
  // b3 — the perspective carries an activation predicate tree (else it would be vacuously always-active)
  assert.ok(Array.isArray(p.predicates) && p.predicates.length === 1, 'predicates synthesized');
  assert.equal(p.predicates[0].operator, 'and');
  assert.equal(p.predicates[0].children[0].kind, 'urlMatches');
  assert.deepEqual(p.predicates[0].children[1].children.map((c) => c.target), ['lmk_sg_a', 'lmk_sg_b']);
});

test('buildPerspectiveRecord — query noise in the localeUrl does NOT fork the perspective id (dedup)', () => {
  const a = buildPerspectiveRecord({ intent: 'search jobs', groundId: 'g', localeUrl: 'https://x.com/jobs?q=writer&l=remote&vjk=abc', landmarkUids: ['u1'] });
  const b = buildPerspectiveRecord({ intent: 'search jobs', groundId: 'g', localeUrl: 'https://x.com/jobs?q=philosopher&l=mpls&vjk=def', landmarkUids: ['u1'] });
  assert.equal(a.id, b.id, 'same intent + ground + PAGE → one perspective id regardless of query string');
  assert.equal(a.localeUrl, 'https://x.com/jobs', 'stored localeUrl is canonical (origin+pathname), not a query instance');
  assert.equal(a.name, 'search jobs · landmarks', 'distinct from the fragment name');
});

// ── b3: perspective activation predicate ──
test('buildPerspectivePredicates: and(urlMatches, or(landmarkExists)) with url-only + single-landmark + empty variants', () => {
  const full = buildPerspectivePredicates({ localeUrl: 'https://x/jobs?q=a#top', landmarkUids: ['u1', 'u2'] });
  assert.equal(full[0].operator, 'and');
  assert.equal(full[0].children[0].kind, 'urlMatches');
  assert.equal(full[0].children[0].pattern, 'https://x/jobs', 'url scope strips query/hash');
  assert.equal(full[0].children[1].operator, 'or');
  const one = buildPerspectivePredicates({ localeUrl: 'https://x/jobs', landmarkUids: ['u1'] });
  assert.equal(one[0].children[1].kind, 'landmarkExists', 'single landmark → bare leaf, not an or');
  assert.deepEqual(buildPerspectivePredicates({ localeUrl: 'https://x/jobs', landmarkUids: [] }),
    [{ kind: 'urlMatches', pattern: 'https://x/jobs', mode: 'contains' }], 'no substrate → url-only bootstrap rung');
  assert.deepEqual(buildPerspectivePredicates({}), [], 'nothing grounded → empty (always-active back-compat)');
});

// ── b5: outcome (SPA results region) landmark ──
test('buildResultsLandmarkRecord — verified outcome landmark; selector-only AND recoverable (role+name) variants', () => {
  // b5a — selector-only (a bare results <div>): tracked + verified, uid keyed on selector with null role/name
  const bare = buildResultsLandmarkRecord({ settleSelector: '#results', groundId: 'g', localeUrl: 'u', acceptedAt: 1000 });
  assert.equal(bare.selector, '#results');
  assert.equal(bare.lifecycle, 'verified');
  assert.equal(bare.verifiedBy, 'demonstration');
  assert.equal(bare.outcome, true);
  assert.equal(bare.a11yRole, null);
  assert.equal(bare.alias, 'results region');
  assert.equal(bare.uid, mintLandmarkUid('g', 'u', { role: null, accessibleName: null, selector: '#results' }));
  // b5b — recoverable (role + accessibleName captured): probe-or-recover identity, alias from the name
  const rec = buildResultsLandmarkRecord({ settleSelector: '#results', role: 'region', accessibleName: 'Search results', text: '120 jobs', groundId: 'g', localeUrl: 'u', acceptedAt: 1000 });
  assert.equal(rec.a11yRole, 'region');
  assert.equal(rec.accessibleName, 'Search results');
  assert.equal(rec.textContent, '120 jobs');
  assert.equal(rec.alias, 'Search results', 'recoverable → alias from the accessible name');
  assert.equal(rec.uid, mintLandmarkUid('g', 'u', { role: 'region', accessibleName: 'Search results', selector: '#results' }));
  assert.notEqual(rec.uid, bare.uid, 'identity-keyed uid differs from the selector-only one');
  assert.equal(buildResultsLandmarkRecord({ settleSelector: '   ', groundId: 'g' }), null, 'blank selector → null');
  assert.equal(buildResultsLandmarkRecord({}), null, 'no settle region → null');
});

test('buildOutcomePerspective — a distinct outcome perspective + a perspective_ref postcondition', () => {
  const r = buildOutcomePerspective({ intent: 'search jobs', groundId: 'g', localeUrl: 'https://x/jobs', resultsUid: 'lmk_sg_results', discriminator: '0', acceptedAt: 1000 });
  assert.deepEqual(r.perspective.landmarkRefs, ['lmk_sg_results'], 'outcome perspective = just the results landmark');
  assert.ok(/results/.test(r.perspective.name), 'named as the results perspective');
  assert.notEqual(r.perspective.id, mintPerspectiveId('search jobs', 'g', 'https://x/jobs'), 'distinct id from the operative perspective');
  // the postcondition is perspective_ref(outcome) in a match:'all' envelope (which perspective_ref requires);
  // for a single landmark it expands to selector_present on that selector → behaviourally the prior check
  assert.deepEqual(r.postcondition, { match: 'all', conditions: [{ type: 'perspective_ref', perspectiveId: r.perspective.id }], source: 'outcome-perspective' });
  // and the outcome perspective carries a b3 activation predicate (urlMatches scope ∧ landmarkExists results)
  assert.ok(Array.isArray(r.perspective.predicates) && r.perspective.predicates.length === 1);
  assert.equal(buildOutcomePerspective({ intent: 'x', groundId: 'g' }), null, 'no results uid → null');
});

// ── lean capability points at the saved entities (no flat binding) ──
test('buildCapabilityAcceptance references perspectiveId + landmarkUids; transitional binding carries the landmark', () => {
  const cap = buildCapabilityAcceptance({ ...base, perspectiveId: 'persp_sg_x', landmarkUids: ['lmk_sg_a'] });
  assert.equal(cap.schema, ACCEPT_SCHEMA);
  assert.equal(cap.kind, 'substrate-capability');
  assert.equal(cap.perspectiveId, 'persp_sg_x');
  assert.deepEqual(cap.landmarkUids, ['lmk_sg_a']);
  // transitional replay binding (SG-LM-5 migrates replay to the perspective, then drops this)
  assert.equal(cap.binding.length, 3);
  assert.equal(cap.binding[0].landmark.role, 'textbox');   // binding carries the recoverable landmark
  assert.equal(cap.trial.verdict, 'trial-pass');
  assert.ok(cap.trial.trialRef.startsWith('trial_'));
});

// ── one-call: gate → all linked artifacts ──
test('buildAcceptance returns capability + perspective + landmarks + trace, all linked', () => {
  const r = buildAcceptance(base);
  assert.equal(r.ok, true);
  assert.equal(r.landmarks.length, 2);
  assert.equal(r.capability.perspectiveId, r.perspective.id);
  assert.deepEqual(r.capability.landmarkUids, r.landmarks.map(l => l.uid));
  assert.deepEqual(r.perspective.landmarkRefs, r.landmarks.map(l => l.uid));
  assert.equal(r.capability.trial.trialRef, r.trace.trialRef);
  assert.equal(r.trace.perspectiveId, r.perspective.id);
  assert.deepEqual(r.trace.intentSpec, specComplete);   // heavy trace keeps the full spec
});
// ── SG-LM-5: action → landmarkRef conversion for the persisted Fragment ──
test('landmarkRefActions rewrites inline landmark → registry landmarkRef (uid matches the saved landmark)', () => {
  const lm = { role: 'button', accessibleName: 'Submit Application', hierarchicalContext: null, selector: 'button.s' };
  const actions = [
    { action: 'TYPE', selector: 'input[name="firstName"]', value: 'test', landmark: { role: 'textbox', accessibleName: 'First name', selector: 'input[name="firstName"]' } },
    { action: 'SET_FILE', selector: 'input[aria-label="file-input"]', value: 'trial-upload.pdf' },  // no landmark
    { action: 'EXTRACT', selector: 'button.s', target: 'TRIAL_TERMINAL', landmark: lm },             // deferred submit
  ];
  const steps = landmarkRefActions(actions, 'gnd_1', 'u');
  assert.equal(steps[0].landmarkRef.uid, mintLandmarkUid('gnd_1', 'u', { role: 'textbox', accessibleName: 'First name', selector: 'input[name="firstName"]' }));
  assert.equal(steps[0].landmark, undefined);          // inline landmark stripped
  assert.equal(steps[0].action, 'TYPE');
  assert.equal(steps[1].landmarkRef, undefined);        // no recoverable landmark → plain selector
  assert.equal(steps[1].selector, 'input[aria-label="file-input"]');
  assert.equal(steps[2].landmarkRef.uid, mintLandmarkUid('gnd_1', 'u', lm));   // matches the saved landmark uid
  assert.equal(steps[2].target, 'TRIAL_TERMINAL');
});

// ── SG-INV-1: param schema + deferred-terminal capture (data-only foundation for Invocation) ──
test('buildParamSchema picks only fillable input roles, with fill op + landmark uid', () => {
  const params = buildParamSchema({ roles, groundId: 'gnd_1', localeUrl: 'u' });
  assert.equal(params.length, 2);                                   // firstName + resume; submit (action) excluded
  const byKey = Object.fromEntries(params.map(p => [p.key, p]));
  assert.ok(byKey.firstname);
  assert.equal(byKey.firstname.label, 'First name');                // from the landmark's accessibleName
  assert.equal(byKey.firstname.fillOp, 'text');
  assert.equal(byKey.firstname.selector, 'input[name="firstName"]');
  assert.equal(byKey.firstname.landmarkUid, mintLandmarkUid('gnd_1', 'u', roles[0].landmark));
  assert.equal(byKey.firstname.required, true);
  assert.equal(byKey.resume.fillOp, 'file');                        // fieldType:'file' → file op
  assert.equal(byKey.resume.label, 'resume');                       // no landmark → role name
  assert.equal(byKey.resume.landmarkUid, null);                     // file input has no recoverable landmark
});
test('buildTerminalDescriptor captures the deferred commit (never armed); null when nothing deferred', () => {
  const t = buildTerminalDescriptor({ roles, deferred: ['button.s'], safetyClass: 'irreversible', groundId: 'gnd_1', localeUrl: 'u' });
  assert.equal(t.role, 'submit');
  assert.equal(t.selector, 'button.s');
  assert.equal(t.safetyClass, 'irreversible');
  assert.equal(t.armed, false);                                     // data model never arms a submit by default
  assert.equal(t.landmark.accessibleName, 'Submit Application');
  assert.equal(t.landmarkUid, mintLandmarkUid('gnd_1', 'u', roles[2].landmark));
  assert.equal(buildTerminalDescriptor({ roles, deferred: [] }), null);
});
test('buildCapabilityAcceptance attaches params + terminal (terminal null without a deferred commit)', () => {
  const armedCap = buildCapabilityAcceptance({ ...base, deferred: ['button.s'], safetyClass: 'irreversible', perspectiveId: 'p', landmarkUids: [] });
  assert.equal(armedCap.params.length, 2);
  assert.equal(armedCap.terminal.role, 'submit');
  assert.equal(armedCap.terminal.armed, false);
  const noTermCap = buildCapabilityAcceptance({ ...base, perspectiveId: 'p', landmarkUids: [] });
  assert.equal(noTermCap.params.length, 2);
  assert.equal(noTermCap.terminal, null);                           // reversible/read op → no deferred terminal
});

test('buildAcceptance refuses on a failing trial', () => {
  const r = buildAcceptance({ ...base, trial: trialFail });
  assert.equal(r.ok, false);
  assert.equal(r.capability, undefined);
  assert.equal(r.perspective, undefined);
});

console.log(`\n${passed} passed`);
