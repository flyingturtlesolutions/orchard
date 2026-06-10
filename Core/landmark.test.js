// Core/landmark.test.js — SG-LM-2. Plain-assert (Node 16 has no node:test). Run: node Core/landmark.test.js
import assert from 'node:assert';
import { featureToProtoLandmark, protoLandmarkFallback } from './landmark.js';
import { selectionToTrialRoles } from './bind.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok  -', name); };

const feat = (over) => ({ id: 'f1', kind: 'action', label: 'Sign in', a11yRole: null, selector: 'button.x', ...over });

// ── role derivation (recovery REQUIRES a role; most plain elements have none) ──
test('button kind → role "button"', () => {
  const lm = featureToProtoLandmark(feat({ kind: 'action', label: 'Sign in', selector: 'button.x' }));
  assert.equal(lm.role, 'button');
  assert.equal(lm.accessibleName, 'Sign in');
  assert.deepEqual(lm.candidates, ['button.x']);
  assert.equal(lm.hierarchicalContext, null);
});
test('navigation kind → role "link"', () => {
  assert.equal(featureToProtoLandmark(feat({ kind: 'navigation' })).role, 'link');
});
test('input kind → role "textbox"', () => {
  assert.equal(featureToProtoLandmark(feat({ kind: 'input', label: 'Email' })).role, 'textbox');
});
test('select kind → role "combobox"', () => {
  assert.equal(featureToProtoLandmark(feat({ kind: 'select', label: 'Country' })).role, 'combobox');
});
test('input + fieldType select → role "combobox"', () => {
  assert.equal(featureToProtoLandmark(feat({ kind: 'input' }), 'select').role, 'combobox');
});
test('file → role null (no recoverable role)', () => {
  assert.equal(featureToProtoLandmark(feat({ kind: 'file' })).role, null);
  assert.equal(featureToProtoLandmark(feat({ kind: 'input' }), 'file').role, null);
});
test('explicit a11yRole wins over kind derivation', () => {
  assert.equal(featureToProtoLandmark(feat({ kind: 'action', a11yRole: 'menuitem' })).role, 'menuitem');
});
test('collection/region → role null (selector-only recovery)', () => {
  assert.equal(featureToProtoLandmark(feat({ kind: 'collection' })).role, null);
  assert.equal(featureToProtoLandmark(feat({ kind: 'region' })).role, null);
});
test('no label → accessibleName null', () => {
  assert.equal(featureToProtoLandmark(feat({ label: '' })).accessibleName, null);
});

// ── fallback descriptor (LANDMARK_PROBE_OR_RECOVER payload) ──
test('protoLandmarkFallback returns {role,accessibleName,hierarchicalContext} when role present', () => {
  const lm = featureToProtoLandmark(feat({ kind: 'action', label: 'Sign in' }));
  assert.deepEqual(protoLandmarkFallback(lm), { role: 'button', accessibleName: 'Sign in', hierarchicalContext: null });
});
test('protoLandmarkFallback returns null when there is no role (nothing to recover with)', () => {
  const lm = featureToProtoLandmark(feat({ kind: 'collection', label: 'Results' }));
  assert.equal(protoLandmarkFallback(lm), null);
});

// ── bind attaches the proto-landmark onto each bound role ──
test('selectionToTrialRoles carries role.landmark with derived role + accessibleName', () => {
  const submit = { id: 'go', label: 'Sign in', kind: 'action', selector: 'button.x', interaction: { pattern: 'click', effect: 'submit' } };
  const sel = { boundary: { requiredFields: [
    { id: 'email', label: 'Email', kind: 'input', required: true, selector: '#email', interaction: { pattern: 'type' } },
  ], successAction: submit } };
  const roles = selectionToTrialRoles({ shape: 'complete' }, sel);
  const byId = Object.fromEntries(roles.map(r => [r.featureId, r]));
  assert.equal(byId.email.landmark.role, 'textbox');
  assert.equal(byId.email.landmark.accessibleName, 'Email');
  assert.equal(byId.email.landmark.selector, '#email');
  assert.equal(byId.go.landmark.role, 'button');
  assert.equal(byId.go.landmark.accessibleName, 'Sign in');
});

console.log(`\n${passed} passed`);


// CR-B2 (v2.74.935) — typeable disclosure recovers as combobox
test('disclosure + fieldType text → role "combobox" (CR-B2)', () => {
  const lm = featureToProtoLandmark({ selector: 'input[name="q"]', label: 'Job title keywords', kind: 'disclosure' }, 'text');
  assert.equal(lm.role, 'combobox');
});
test('plain disclosure stays "button"; explicit a11yRole always wins (CR-B2)', () => {
  assert.equal(featureToProtoLandmark({ selector: '#pay', label: 'Pay', kind: 'disclosure' }, null).role, 'button');
  assert.equal(featureToProtoLandmark({ selector: '#x', label: 'X', kind: 'disclosure', a11yRole: 'searchbox' }, 'text').role, 'searchbox');
});
