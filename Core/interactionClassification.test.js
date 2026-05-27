// Core/interactionClassification.test.js — C0 unit tests (node --test)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  semanticVerb,
  selectorSpecificityScore,
  scoreMatch,
  rankMatches,
  classifyResolved,
  classifyInteraction,
  validateResolvedInteraction,
} from './interactionClassification.js';

function raw(overrides = {}) {
  return {
    id: 'raw_1',
    ts: 1000,
    tabId: 1,
    frameId: 0,
    url: 'https://example.com/search',
    interactionKind: 'click',
    ...overrides,
  };
}

function resolved(overrides = {}) {
  const r = raw(overrides.raw);
  return {
    raw: overrides.raw === undefined ? r : { ...r, ...overrides.raw },
    groundId: 'gnd_ex',
    resolutionStatus: 'hit',
    matches: [],
    activePerspectiveIds: [],
    ...overrides,
  };
}

describe('semanticVerb', () => {
  it('maps search-query + type', () => {
    assert.equal(semanticVerb('type', 'search-query'), 'enter-search-query');
  });

  it('falls back to base click', () => {
    assert.equal(semanticVerb('click', 'unknown-role'), 'click');
  });

  it('maps navigate', () => {
    assert.equal(semanticVerb('navigate'), 'navigate');
  });
});

describe('selectorSpecificityScore', () => {
  it('prefers id selector', () => {
    assert.ok(selectorSpecificityScore('#submit-btn') > selectorSpecificityScore('.btn'));
  });
});

describe('rankMatches', () => {
  it('prefers active perspective (T3)', () => {
    const matches = [
      { landmarkUid: 'lmk_a', perspectiveId: 'per_off', role: 'primary-action', selectorUsed: '#a', confidence: 0.9 },
      { landmarkUid: 'lmk_b', perspectiveId: 'per_on', role: 'primary-action', selectorUsed: '.b', confidence: 0.5 },
    ];
    const ranked = rankMatches(matches, {
      activePerspectiveIds: ['per_on'],
      interactionKind: 'click',
    });
    assert.equal(ranked[0].perspectiveId, 'per_on');
  });

  it('is stable on tie (T10)', () => {
    const matches = [
      { landmarkUid: 'lmk_z', perspectiveId: 'per_1', selectorUsed: '.z', confidence: 0.5 },
      { landmarkUid: 'lmk_a', perspectiveId: 'per_2', selectorUsed: '.a', confidence: 0.5 },
    ];
    const a = rankMatches(matches, { interactionKind: 'click' });
    const b = rankMatches(matches, { interactionKind: 'click' });
    assert.deepEqual(a.map((x) => x.landmarkUid), b.map((x) => x.landmarkUid));
  });
});

describe('classifyResolved', () => {
  it('T1 hit search-query type', () => {
    const c = classifyResolved(resolved({
      resolutionStatus: 'hit',
      matches: [{
        landmarkUid: 'lmk_q',
        perspectiveId: 'per_search',
        role: 'search-query',
        selectorUsed: '[name="q"]',
        confidence: 1,
      }],
      raw: raw({ interactionKind: 'type' }),
    }));
    assert.equal(c.tier, 'substrate');
    assert.equal(c.primary.semanticVerb, 'enter-search-query');
  });

  it('T2 hit unknown role click', () => {
    const c = classifyResolved(resolved({
      resolutionStatus: 'hit',
      matches: [{
        landmarkUid: 'lmk_x',
        perspectiveId: 'per_1',
        role: 'widget',
        selectorUsed: '.x',
        confidence: 1,
      }],
    }));
    assert.equal(c.primary.semanticVerb, 'click');
  });

  it('T4 miss', () => {
    const c = classifyResolved(resolved({ resolutionStatus: 'miss', matches: [] }));
    assert.equal(c.tier, 'unresolved');
    assert.equal(c.unresolvedReason, 'miss');
  });

  it('T5 suppressed', () => {
    const c = classifyResolved(resolved({ resolutionStatus: 'suppressed' }));
    assert.equal(c.unresolvedReason, 'suppressed');
  });

  it('T6 no ground', () => {
    const c = classifyResolved(resolved({ groundId: null }));
    assert.equal(c.unresolvedReason, 'no-ground');
  });

  it('T7 navigate is browser tier despite matches', () => {
    const c = classifyResolved(resolved({
      raw: raw({ interactionKind: 'navigate' }),
      matches: [{
        landmarkUid: 'lmk_x',
        perspectiveId: 'per_1',
        selectorUsed: '#x',
        confidence: 1,
      }],
    }));
    assert.equal(c.tier, 'browser');
    assert.equal(c.browserContext, 'navigate');
    assert.equal(c.primary, undefined);
  });

  it('T8 tab-activate', () => {
    const c = classifyResolved(resolved({
      raw: raw({ interactionKind: 'tab-activate' }),
    }));
    assert.equal(c.browserContext, 'tab-switch');
  });

  it('T3 ambiguous with candidates', () => {
    const c = classifyResolved(resolved({
      resolutionStatus: 'ambiguous',
      activePerspectiveIds: ['per_active'],
      matches: [
        { landmarkUid: 'lmk_1', perspectiveId: 'per_other', selectorUsed: '#id', confidence: 0.99 },
        { landmarkUid: 'lmk_2', perspectiveId: 'per_active', selectorUsed: '.weak', confidence: 0.4 },
      ],
    }));
    assert.equal(c.tier, 'substrate');
    assert.ok(c.candidates.length >= 2);
    assert.equal(c.primary.perspectiveId, 'per_active');
  });

  it('T11 recent perspective tie-break', () => {
    const c = classifyResolved(resolved({
      resolutionStatus: 'ambiguous',
      matches: [
        { landmarkUid: 'lmk_a', perspectiveId: 'per_a', selectorUsed: '.a', confidence: 0.5 },
        { landmarkUid: 'lmk_b', perspectiveId: 'per_b', selectorUsed: '.b', confidence: 0.5 },
      ],
    }), {
      recentEvents: [{
        classification: { primary: { perspectiveId: 'per_b' } },
      }],
    });
    assert.equal(c.primary.perspectiveId, 'per_b');
  });

  it('T12 hit with empty matches', () => {
    const c = classifyResolved(resolved({ resolutionStatus: 'hit', matches: [] }));
    assert.equal(c.tier, 'unresolved');
    assert.equal(c.unresolvedReason, 'miss');
  });
});

describe('classifyInteraction', () => {
  it('returns full event with schema', () => {
    const ev = classifyInteraction(resolved({
      resolutionStatus: 'hit',
      matches: [{
        landmarkUid: 'lmk_1',
        perspectiveId: 'per_1',
        role: 'primary-action',
        selectorUsed: '#btn',
        confidence: 1,
      }],
    }), { siteMapNode: { archetypeId: 'arch_search' } });
    assert.equal(ev.schema, 1);
    assert.equal(ev.classification.tier, 'substrate');
    assert.equal(ev.classification.page.archetypeId, 'arch_search');
    assert.ok(validateResolvedInteraction(resolved({
      resolutionStatus: 'hit',
      matches: [{ landmarkUid: 'lmk_1', perspectiveId: 'per_1', selectorUsed: '#x', confidence: 1 }],
    })));
  });

  it('throws on invalid resolved', () => {
    assert.throws(() => classifyInteraction({}));
  });
});
