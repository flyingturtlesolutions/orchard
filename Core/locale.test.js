// Core/locale.test.js — SG-0.5-F1 unit tests (node --test). PURE: synthetic Locale models.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveDisclosureGoals, mergeDepthFromControls, buildIndex, buildLocale, driftHashFromRaw, localeTrust } from './locale.js';

describe('localeTrust — EX-5 pure authoring-trust gate', () => {
  // A healthy, fully-explored Locale: many features, goals, depth, not capped, not aborted.
  const healthy = () => ({
    features: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, { id: `f${i}`, kind: 'action' }])),
    goals: { g1: {}, g2: {} },
    coverage: { fidelity: 'L2', capped: false, featureCount: 8 },
  });
  const structOk = { stats: { aborted: null, candidates: 12, controlsTried: 5 } };

  it('a healthy fully-explored Locale is trusted + safeToAuthor', () => {
    const t = localeTrust(healthy(), structOk);
    assert.equal(t.tier, 'trusted');
    assert.equal(t.safeToAuthor, true);
    assert.equal(t.score, 1);
    assert.deepEqual(t.reasons, []);
  });
  it('an ABORTED sweep drops trust (high-severity reason) and is no longer trusted', () => {
    const t = localeTrust(healthy(), { stats: { aborted: 'navigation-unrecovered' } });
    assert.ok(t.score <= 0.5);
    assert.notEqual(t.tier, 'trusted');
    assert.ok(t.reasons.some((r) => r.code === 'sweep-aborted' && r.severity === 'high'));
  });
  it('aborted + capped + no goals stacks into untrusted / not safeToAuthor', () => {
    const m = healthy(); m.goals = {}; m.coverage.capped = true;
    const t = localeTrust(m, { stats: { aborted: 'navigation-unrecovered' } });
    assert.equal(t.tier, 'untrusted');
    assert.equal(t.safeToAuthor, false);
    assert.ok(t.reasons.some((r) => r.code === 'enumerate-capped'));
    assert.ok(t.reasons.some((r) => r.code === 'no-goals'));
  });
  it('a barely-enumerated page (<3 features) is penalized for too-few-features', () => {
    const t = localeTrust({ features: { a: { id: 'a' } }, goals: { g: {} }, coverage: { fidelity: 'L2', featureCount: 1 } }, structOk);
    assert.ok(t.reasons.some((r) => r.code === 'too-few-features'));
    assert.notEqual(t.tier, 'trusted');
  });
  it('a flat (L0, no depth) page with goals stays trusted — depth is only a mild signal', () => {
    const m = healthy(); m.coverage.fidelity = 'L0';
    const t = localeTrust(m, structOk);
    assert.ok(t.reasons.some((r) => r.code === 'no-depth' && r.severity === 'low'));
    assert.equal(t.tier, 'trusted');   // 1 - 0.1 = 0.9 ≥ 0.7
  });
  it('falls back to counting model.features when coverage.featureCount is absent', () => {
    const m = healthy(); delete m.coverage.featureCount;
    assert.equal(localeTrust(m, structOk).signals.featureCount, 8);
  });
  it('degrades gracefully: null model → untrusted/no-model, missing structure tolerated', () => {
    const nm = localeTrust(null);
    assert.equal(nm.tier, 'untrusted');
    assert.equal(nm.safeToAuthor, false);
    assert.equal(nm.reasons[0].code, 'no-model');
    // structure omitted entirely (aborted unknown) — still scores the model
    const t = localeTrust(healthy());
    assert.equal(t.tier, 'trusted');
    assert.equal(t.signals.aborted, null);
  });
});

describe('driftHashFromRaw — EX-4 pre-sweep fingerprint ≡ buildLocale stamp', () => {
  const raw = [
    { id: 'a1', kind: 'action', label: 'Search', selector: '#s' },
    { id: 'b2', kind: 'input', label: 'Keywords', selector: '#k' },
  ];
  it('equals buildLocale(...).coverage.driftHash for the same raw features (the freshness contract)', () => {
    // If these ever diverge the short-circuit silently never fires (or fires wrongly).
    assert.equal(driftHashFromRaw(raw), buildLocale(raw, {}).coverage.driftHash);
  });
  it('is insertion-order independent (same id-set → same hash)', () => {
    assert.equal(driftHashFromRaw(raw), driftHashFromRaw([raw[1], raw[0]]));
  });
  it('changes when the feature id-set changes (real content drift, not just count)', () => {
    const drifted = [raw[0], { id: 'c3', kind: 'input', label: 'Location', selector: '#loc' }];  // same length, different id
    assert.notEqual(driftHashFromRaw(raw), driftHashFromRaw(drifted));
  });
  it('ignores malformed entries (missing / non-string id) exactly like buildLocale', () => {
    assert.equal(driftHashFromRaw([...raw, { kind: 'x' }, null, { id: 42 }]), driftHashFromRaw(raw));
  });
  it('returns a stable hash for empty / null input', () => {
    assert.equal(driftHashFromRaw([]), driftHashFromRaw(null));
  });
});

describe('buildLocale — EX-3 coverage.capped passthrough', () => {
  it('stamps coverage.capped from meta.capped (default false)', () => {
    assert.equal(buildLocale([], { capped: true }).coverage.capped, true);
    assert.equal(buildLocale([], {}).coverage.capped, false);
  });
});

describe('buildLocale — G1-2 groundId binding', () => {
  it('stamps groundId from meta (default null)', () => {
    assert.equal(buildLocale([], { groundId: 'gnd_abc' }).groundId, 'gnd_abc');
    assert.equal(buildLocale([], {}).groundId, null);
    assert.equal(buildLocale([]).groundId, null);
  });
});

describe('buildIndex — EX-2 deterministic ordering (insertion-order independent)', () => {
  const F = (id, kind, goals = []) => ({ id, kind, goals, label: id });
  const a = { f3: F('f3', 'action', ['g2']), f1: F('f1', 'action', ['g1']), f2: F('f2', 'input', ['g1']) };  // insertion: f3,f1,f2
  const b = { f1: F('f1', 'action', ['g1']), f2: F('f2', 'input', ['g1']), f3: F('f3', 'action', ['g2']) };  // insertion: f1,f2,f3
  it('byKind + byGoal arrays are sorted by id → identical index regardless of feature insertion order', () => {
    const ia = buildIndex(a), ib = buildIndex(b);
    assert.deepEqual(ia.byKind, ib.byKind);
    assert.deepEqual(ia.byGoal, ib.byGoal);
    assert.deepEqual(ia.byKind.action, ['f1', 'f3']);   // sorted, not insertion order (f3 inserted first in `a`)
    assert.deepEqual(ia.byGoal.g1, ['f1', 'f2']);
  });
  it('triggers are sorted by featureId', () => {
    const m = { d2: { id: 'd2', kind: 'disclosure', reveals: 'L2', goals: [] }, d1: { id: 'd1', kind: 'disclosure', reveals: 'L1', goals: [] } };
    assert.deepEqual(buildIndex(m).triggers.map((t) => t.featureId), ['d1', 'd2']);
  });
});

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
