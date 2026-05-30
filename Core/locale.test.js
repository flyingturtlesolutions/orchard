// Core/locale.test.js — SG-0.5-F1 unit tests (node --test). PURE: synthetic Locale models.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveDisclosureGoals, mergeDepthFromControls } from './locale.js';

const disc = (id, label, reveals) => ({ id, kind: 'disclosure', label, selector: `#${id}`, reveals, interaction: { pattern: 'click', effect: 'reveal' } });
const opt = (id, label, by, kind = 'action') => ({ id, kind, label, selector: `#${id}`, hidden: true, revealedBy: by, interaction: { pattern: kind === 'input' ? 'type' : 'click', effect: 'none' } });

describe('deriveDisclosureGoals — one goal per disclosure-unit (SG-0.5-F1)', () => {
  it('emits a goal = disclosure + its actionable revealed options (excludes content regions)', () => {
    const model = {
      features: {
        payDisc: disc('payDisc', 'Pay', 'layer_pay'),
        o15: opt('o15', '$15+', 'payDisc'), o20: opt('o20', '$20+', 'payDisc'), upd: opt('upd', 'Update', 'payDisc'),
        note: { id: 'note', kind: 'region', label: 'note', selector: '.note', hidden: true, revealedBy: 'payDisc' },  // not actionable
      },
      layers: { layer_pay: { id: 'layer_pay', kind: 'dropdown', openedBy: 'payDisc', features: ['o15', 'o20', 'upd', 'note'] } },
    };
    const goals = deriveDisclosureGoals(model);
    assert.equal(goals.length, 1);
    assert.equal(goals[0].label, 'Pay');
    assert.deepEqual(goals[0].achievableVia.sort(), ['o15', 'o20', 'payDisc', 'upd'], 'disclosure + its options; the content region excluded');
  });

  it('emits a SEPARATE goal per filter dropdown (no lumping)', () => {
    const model = {
      features: {
        payDisc: disc('payDisc', 'Pay', 'layer_pay'), p1: opt('p1', '$20+', 'payDisc'),
        dateDisc: disc('dateDisc', 'Date posted', 'layer_date'), d1: opt('d1', 'Last 24 hours', 'dateDisc'),
      },
      layers: {
        layer_pay: { id: 'layer_pay', openedBy: 'payDisc', features: ['p1'] },
        layer_date: { id: 'layer_date', openedBy: 'dateDisc', features: ['d1'] },
      },
    };
    const goals = deriveDisclosureGoals(model);
    assert.equal(goals.length, 2);
    assert.deepEqual(goals.map((g) => g.label).sort(), ['Date posted', 'Pay']);
    const pay = goals.find((g) => g.label === 'Pay');
    assert.deepEqual(pay.achievableVia.sort(), ['p1', 'payDisc']);
  });

  it('skips a disclosure that reveals nothing actionable', () => {
    const model = {
      features: {
        d: disc('d', 'Info', 'layer_info'),
        text: { id: 'text', kind: 'region', label: 'help', selector: '.help', hidden: true, revealedBy: 'd' },
      },
      layers: { layer_info: { id: 'layer_info', openedBy: 'd', features: ['text'] } },
    };
    assert.deepEqual(deriveDisclosureGoals(model), []);
  });

  it('skips a disclosure with no reveals layer, and an unlabelled disclosure', () => {
    const model = {
      features: {
        noReveal: { id: 'noReveal', kind: 'disclosure', label: 'X', selector: '#x' },          // no reveals
        unlabelled: disc('unlabelled', '', 'layer_u'), u1: opt('u1', 'opt', 'unlabelled'),
      },
      layers: { layer_u: { id: 'layer_u', openedBy: 'unlabelled', features: ['u1'] } },
    };
    assert.deepEqual(deriveDisclosureGoals(model), []);
  });

  it('returns [] for an empty / malformed model', () => {
    assert.deepEqual(deriveDisclosureGoals(null), []);
    assert.deepEqual(deriveDisclosureGoals({ features: {} }), []);
  });
});

describe('mergeDepthFromControls — revealed commit typing (SG-0.5-F3)', () => {
  it('types a revealed "Update"/"Apply"/"Save" action as effect:submit; Reset/options stay none', () => {
    const model = { features: { payBtn: { id: 'payBtn', kind: 'action', label: 'Pay filter', selector: '#pay' } }, layers: {} };
    const controls = [{
      selector: '#pay', label: 'Pay filter', observation: 'reveal', overlay: true,
      revealed: [
        { selector: '#o20', role: 'option', label: '$20+' },
        { selector: '#upd', role: 'button', label: 'Update' },
        { selector: '#rst', role: 'button', label: 'Reset' },
      ],
    }];
    mergeDepthFromControls(model, controls);
    const byLabel = Object.fromEntries(Object.values(model.features).filter((f) => f.hidden).map((f) => [f.label, f]));
    assert.equal(byLabel['Update'].interaction.effect, 'submit', 'the commit is typed submit');
    assert.equal(byLabel['Reset'].interaction.effect, 'none', 'reset is not a commit');
    assert.equal(byLabel['$20+'].interaction.effect, 'none', 'an option is not a commit');
    // and the disclosure linkage is still intact
    assert.equal(byLabel['Update'].revealedBy, model.features.payBtn.id);
    assert.equal(model.features.payBtn.kind, 'disclosure');
  });
});
