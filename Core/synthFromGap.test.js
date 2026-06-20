// Core/synthFromGap.test.js — PS-3 compose an UNVERIFIED capability from a harvested gap (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildHarvestCapability } from './synthFromGap.js';

const GAP = {
  key: 'subscribe to the channel', intent: 'Subscribe to the channel', verbHint: 'click', status: 'harvested',
  fulfillment: { role: 'button', accessibleName: 'Subscribe', tagName: 'button' },
};
const build = () => {
  let n = 0;
  return buildHarvestCapability(
    { gap: GAP, selector: '#subscribe-btn', localeUrl: 'https://youtube.com/watch', groundId: 'gr1' },
    { now: 100, newId: () => `id${(n += 1)}` },
  );
};

describe('synthFromGap — stage an unverified capability from a harvested gap (pure)', () => {
  it('returns null on missing gap / fulfillment / selector / name', () => {
    assert.equal(buildHarvestCapability({}, {}), null);
    assert.equal(buildHarvestCapability({ gap: { intent: 'x' }, selector: '#a', groundId: 'g' }, {}), null);          // no fulfillment
    assert.equal(buildHarvestCapability({ gap: GAP, groundId: 'g' }, {}), null);                                      // no selector
    assert.equal(buildHarvestCapability({ gap: { intent: 'x', fulfillment: { role: 'button' } }, selector: '#a', groundId: 'g' }, {}), null);  // no accessibleName
  });

  it('composes Landmark + Perspective + Fragment + Capability with the unverified markers', () => {
    const r = build();
    assert.ok(r && r.capability && r.fragment && r.perspective && r.landmarks.length === 1);
    const { capability: cap, fragment: frag } = r;
    assert.equal(cap.intent, 'Subscribe to the channel');
    assert.equal(cap.shape, 'observed');
    assert.equal(cap.source, 'harvested');
    assert.equal(cap.trial.verdict, 'observed');          // UNVERIFIED — not 'trial-pass'
    assert.equal(cap.trial.score, null);
    assert.equal(cap.synthesized, true);
    assert.equal(cap.groundId, 'gr1');
    assert.equal(cap.localeUrl, 'https://youtube.com/watch');
    assert.equal(cap.fragmentId, frag.id);                // single-fragment T1 (no strategyId)
    assert.equal(cap.strategyId, undefined);
    assert.equal(cap.perspectiveId, r.perspective.id);
    assert.deepEqual(cap.params, []);                     // param-free single click
  });

  it('LINKAGE: the fragment step references the SAME landmark uid the record carries', () => {
    const r = build();
    const uid = r.landmarks[0].uid;
    assert.ok(uid, 'landmark minted a uid');
    assert.equal(r.fragment.actions.length, 1);
    assert.equal(r.fragment.actions[0].action, 'CLICK');
    assert.equal(r.fragment.actions[0].landmarkRef.uid, uid, 'the step landmarkRef resolves to the minted landmark');
    assert.deepEqual(cap_landmarks(r), [uid]);            // capability + perspective both point at the same uid
    assert.ok(r.perspective.landmarkRefs.includes(uid));
  });

  it('is value-free: the CLICK step carries no typed value', () => {
    const r = build();
    assert.equal('value' in r.fragment.actions[0], false);
    assert.equal(r.landmarks[0].lifecycle, 'fresh');      // selector-proven, behaviour unverified
    assert.equal(r.landmarks[0].source, 'harvested');
  });

  it('the composed capability stays matcher-findable (regression: activeness + candidate + non-orphan gates)', () => {
    const cap = build().capability;
    assert.equal(cap.retracted, undefined);                // isActiveCapability (orchFeedback): not retracted
    assert.equal(cap.disabled, undefined);                 // ...not disabled → ACTIVE (source/verdict are NOT gated)
    assert.notEqual(cap.kind, 'observation');              // _bind's candidate filter routes it to the action pool
    assert.ok(cap.fragmentId && !cap.strategyId);          // bare T1 → non-orphan once its Fragment is saved (listFragments)
  });

  it('falls back to the gap expectedIdentity.role when the captured fulfillment has no role (the .1127 native-button miss)', () => {
    const gap = { intent: 'Subscribe to the channel', fulfillment: { accessibleName: 'Subscribe to Random Edits.', tagName: 'button' }, expectedIdentity: { role: 'button', namePattern: 'subscribe' } };
    const r = buildHarvestCapability({ gap, selector: '#sub', localeUrl: 'https://youtube.com', groundId: 'gr1' }, { now: 1, newId: () => 'id' });
    assert.ok(r, 'composes even though the fulfillment has no role');
    assert.equal(r.landmarks[0].a11yRole, 'button');       // recovered from the enumerated guess, so probe-or-recover can find it on replay
  });
});

function cap_landmarks(r) { return r.capability.landmarkUids; }
