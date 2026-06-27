// Core/presetAbstractPrompt.test.js — §10.2: the pure build + parse for the distill-up abstraction. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildPresetAbstractMessages, parsePresetAbstractOutput } from './presetAbstractPrompt.js';

describe('presetAbstractPrompt — buildPresetAbstractMessages', () => {
  it('renders the type + the instance rule (trigger optional)', () => {
    const { system, user } = buildPresetAbstractMessages({ trigger: 'before refunding', body: 'check Acme window' }, 'support');
    assert.match(system, /STRIP every instance-specific/);
    assert.match(user, /TYPE: support/);
    assert.match(user, /when: before refunding/);
    assert.match(user, /rule: check Acme window/);
  });
  it('omits the when-line when there is no trigger; defaults the type to "app"', () => {
    const { user } = buildPresetAbstractMessages({ body: 'always greet by name' }, '');
    assert.doesNotMatch(user, /when:/);
    assert.match(user, /TYPE: app/);
  });
});

describe('presetAbstractPrompt — parsePresetAbstractOutput', () => {
  it('ok:true with a body → {trigger, body}', () => {
    assert.deepEqual(parsePresetAbstractOutput('{"ok":true,"trigger":"before refunds","body":"verify eligibility"}'),
      { trigger: 'before refunds', body: 'verify eligibility' });
  });
  it('a null / "null" trigger collapses to null (an always-on rule)', () => {
    assert.deepEqual(parsePresetAbstractOutput('{"ok":true,"trigger":null,"body":"x"}'), { trigger: null, body: 'x' });
    assert.deepEqual(parsePresetAbstractOutput('{"ok":true,"trigger":"null","body":"x"}'), { trigger: null, body: 'x' });
  });
  it('ok:false / no body / unparseable → null (declined or failed — nothing rises)', () => {
    assert.equal(parsePresetAbstractOutput('{"ok":false}'), null);
    assert.equal(parsePresetAbstractOutput('{"ok":true,"body":"  "}'), null);
    assert.equal(parsePresetAbstractOutput('not json'), null);
    assert.equal(parsePresetAbstractOutput(''), null);
  });
});
