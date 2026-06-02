// Core/trialSynth.test.js — SG-RES-2b unit tests (node --test). PURE: synthetic roles, no page, no LLM.
//
// Node 16.15.1 has no `node:test` runner on this box; run via the temp-dir ESM harness (copy Core/*,
// import synthesizeTrialOp, assert). These cases document the contract.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeTrialOp } from './trialSynth.js';

describe('synthesizeTrialOp — revealed-option WAIT_FOR carries identity (SG-RES-2b)', () => {
  // Indeed pay: the filter button reveals a <ul role=listbox> popover in a BODY PORTAL; the option's captured
  // positional selector (rooted in the pill-list subtree) never matches at runtime, so a selector-only
  // WAIT_FOR burned its full 8s timeout and the dropdown dismissed during the stall — starving the CLICK's
  // role+name recovery. 2b carries the option's role + accessibleName on the WAIT_FOR so the wait returns the
  // instant the option mounts by IDENTITY (selector OR description — either wins), keeping the popover open.
  const locale = { features: {
    trig: { id: 'trig', kind: 'disclosure', label: 'Pay', selector: '#salaryType_filter_button', interaction: { pattern: 'click', effect: 'reveal' } },
    opt:  { id: 'opt', kind: 'action', label: '$20.00+/hour', selector: 'ul.yosegi > div:nth-of-type(1) > ul > li:nth-of-type(2)', hidden: true, revealedBy: 'trig', interaction: { pattern: 'click', effect: 'none' } },
    upd:  { id: 'upd', kind: 'action', label: 'Update', selector: 'button.update', interaction: { pattern: 'click', effect: 'submit' } },
  } };
  const roles = [
    { role: 'Pay filter', featureId: 'trig', selector: '#salaryType_filter_button', landmark: { role: 'button', accessibleName: 'Pay', selector: '#salaryType_filter_button' } },
    { role: '$20.00+/hour', featureId: 'opt', selector: 'ul.yosegi > div:nth-of-type(1) > ul > li:nth-of-type(2)', hidden: true, revealedBy: 'Pay filter', landmark: { role: 'option', accessibleName: '$20.00+/hour', selector: 'ul.yosegi > div:nth-of-type(1) > ul > li:nth-of-type(2)' } },
    { role: 'Update', featureId: 'upd', selector: 'button.update', landmark: { role: 'button', accessibleName: 'Update', selector: 'button.update' } },
  ];

  it('attaches role+name (waitFor) to the revealed option WAIT_FOR, retaining the selector', () => {
    const op = synthesizeTrialOp({ groundedIntent: 'filter by pay', roles, locale });
    const waits = op.actions.filter((a) => a.action === 'WAIT_FOR');
    assert.equal(waits.length, 1);
    assert.equal(waits[0].selector, 'ul.yosegi > div:nth-of-type(1) > ul > li:nth-of-type(2)');
    assert.deepEqual(waits[0].waitFor, { role: 'option', accessibleName: '$20.00+/hour' });
    assert.equal(waits[0].optional, true);
  });

  it('orders trigger CLICK → WAIT_FOR option → option CLICK', () => {
    const op = synthesizeTrialOp({ groundedIntent: 'filter by pay', roles, locale });
    const seq = op.actions.map((a) => `${a.action}:${a.selector || a.value || ''}`);
    const iTrig = seq.findIndex((s) => s.startsWith('CLICK:#salaryType_filter_button'));
    const iWait = seq.findIndex((s) => s.startsWith('WAIT_FOR'));
    const iOpt  = seq.findIndex((s) => s.includes('li:nth-of-type(2)') && s.startsWith('CLICK'));
    assert.ok(iTrig >= 0 && iWait > iTrig && iOpt > iWait, `expected trigger → wait → option, got ${seq.join(' | ')}`);
  });

  it('a revealed role WITHOUT a landmark falls back to a selector-only WAIT_FOR', () => {
    const locale2 = { features: {
      trig: { id: 'trig', kind: 'disclosure', label: 'Menu', selector: '#menu', interaction: { pattern: 'click', effect: 'reveal' } },
      opt:  { id: 'opt', kind: 'action', label: 'Item', selector: '#menu + ul > li', hidden: true, revealedBy: 'trig', interaction: { pattern: 'click', effect: 'none' } },
    } };
    const roles2 = [
      { role: 'Menu', featureId: 'trig', selector: '#menu' },
      { role: 'Item', featureId: 'opt', selector: '#menu + ul > li', hidden: true, revealedBy: 'Menu' },
    ];
    const op = synthesizeTrialOp({ groundedIntent: 'open menu item', roles: roles2, locale: locale2 });
    const waits = op.actions.filter((a) => a.action === 'WAIT_FOR');
    assert.equal(waits.length, 1);
    assert.equal(waits[0].selector, '#menu + ul > li');
    assert.equal(waits[0].waitFor, undefined);
  });
});
