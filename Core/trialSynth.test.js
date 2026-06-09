// Core/trialSynth.test.js — SG-RES-2b unit tests (node --test). PURE: synthetic roles, no page, no LLM.
//
// Node 16.15.1 has no `node:test` runner on this box; run via the temp-dir ESM harness (copy Core/*,
// import synthesizeTrialOp, assert). These cases document the contract.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeTrialOp, classifyTrialSafety } from './trialSynth.js';

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

describe('synthesizeTrialOp — Enter-submits a filled search form with no submit button (v2.74.879)', () => {
  // Pixabay-style search: a text input that commits on Enter, with NO submit <button>. Core/bind finds no
  // effect:submit feature to add, so without this the op TYPEs the query and never sends it — the live
  // "type 'fable' → stay on '/' → url_matches('/videos/') fails" gap from the decisions trace.
  const searchLocale = { features: {
    q: { id: 'q', kind: 'input', label: 'Search', selector: 'input#search', fieldType: 'text', interaction: { pattern: 'type', effect: 'none' } },
  } };
  const searchRoles = [
    { role: 'Search', featureId: 'q', selector: 'input#search', kind: 'input', landmark: { role: 'searchbox', accessibleName: 'Search', selector: 'input#search' } },
  ];

  it('appends ONE ENTER on the last text input when no submit control was bound', () => {
    const op = synthesizeTrialOp({ groundedIntent: 'search for videos about fable', roles: searchRoles, locale: searchLocale });
    const seq = op.actions.map((a) => a.action);
    assert.ok(seq.includes('TYPE'), `expected a TYPE, got ${seq.join(',')}`);
    const enters = op.actions.filter((a) => a.action === 'ENTER');
    assert.equal(enters.length, 1, `expected exactly one ENTER, got ${seq.join(',')}`);
    assert.equal(enters[0].selector, 'input#search');
    assert.ok(seq.lastIndexOf('ENTER') > seq.indexOf('TYPE'), `ENTER must follow the TYPE, got ${seq.join(',')}`);
    assert.equal(enters[0].landmark.accessibleName, 'Search');   // carries identity for probe-or-recover
  });

  it('does NOT append ENTER when a real submit button was bound (the button commits)', () => {
    const locale = { features: {
      q:   { id: 'q', kind: 'input', label: 'Search', selector: 'input#search', fieldType: 'text', interaction: { pattern: 'type', effect: 'none' } },
      btn: { id: 'btn', kind: 'action', label: 'Search', selector: 'button#go', interaction: { pattern: 'click', effect: 'submit' } },
    } };
    const roles = [
      { role: 'Search', featureId: 'q', selector: 'input#search', kind: 'input' },
      { role: 'Go', featureId: 'btn', selector: 'button#go', kind: 'action' },
    ];
    const op = synthesizeTrialOp({ groundedIntent: 'search for videos', roles, locale });
    assert.equal(op.actions.filter((a) => a.action === 'ENTER').length, 0);
    assert.ok(op.actions.some((a) => a.action === 'CLICK' && a.selector === 'button#go'));
  });

  it('does NOT append ENTER when the act navigates away (no form to submit)', () => {
    const locale = { features: {
      q:   { id: 'q', kind: 'input', label: 'Search', selector: 'input#search', fieldType: 'text', interaction: { pattern: 'type', effect: 'none' } },
      nav: { id: 'nav', kind: 'navigation', label: 'Videos', selector: 'a#videos', href: '/videos/', interaction: { pattern: 'click', effect: 'navigate' } },
    } };
    const roles = [
      { role: 'Search', featureId: 'q', selector: 'input#search', kind: 'input' },
      { role: 'Videos', featureId: 'nav', selector: 'a#videos', kind: 'navigation' },
    ];
    const op = synthesizeTrialOp({ groundedIntent: 'go to videos', roles, locale });
    assert.equal(op.actions.filter((a) => a.action === 'ENTER').length, 0);
  });

  it('does NOT append ENTER for a select-only fill (Enter is not a dropdown submit)', () => {
    const locale = { features: {
      sel: { id: 'sel', kind: 'input', label: 'Category', selector: 'select#cat', fieldType: 'select', interaction: { pattern: 'select', effect: 'none' } },
    } };
    const roles = [ { role: 'Category', featureId: 'sel', selector: 'select#cat', kind: 'input', fieldType: 'select' } ];
    const op = synthesizeTrialOp({ groundedIntent: 'choose category', roles, locale });
    assert.equal(op.actions.filter((a) => a.action === 'ENTER').length, 0);
    assert.ok(op.actions.some((a) => a.action === 'SELECT'));
  });
});

describe('classifyTrialSafety — a terminal ENTER is the commit (v2.74.879)', () => {
  it('defers an irreversible Enter-submit (swaps the ENTER for a reachability EXTRACT)', () => {
    const draft = { actions: [
      { action: 'TYPE', selector: 'input#email', value: 'x' },
      { action: 'ENTER', selector: 'input#email', landmark: { role: 'textbox', accessibleName: 'Email', selector: 'input#email' } },
    ] };
    const res = classifyTrialSafety('subscribe to the newsletter', draft);
    assert.equal(res.safetyClass, 'irreversible');
    assert.deepEqual(res.deferred, ['input#email']);
    assert.equal(res.actions.filter((a) => a.action === 'ENTER').length, 0, 'the ENTER must be deferred, not fired');
    const probe = res.actions.find((a) => a.target === 'TRIAL_TERMINAL');
    assert.ok(probe && probe.action === 'EXTRACT' && probe.selector === 'input#email');
  });

  it('keeps a reversible search Enter-submit (runs in full)', () => {
    const draft = { actions: [
      { action: 'TYPE', selector: 'input#q', value: 'fable' },
      { action: 'ENTER', selector: 'input#q' },
    ] };
    const res = classifyTrialSafety('search for videos about fable', draft);
    assert.equal(res.safetyClass, 'reversible');
    assert.deepEqual(res.deferred, []);
    assert.equal(res.actions.filter((a) => a.action === 'ENTER').length, 1, 'a reversible Enter-submit is kept');
  });
});
