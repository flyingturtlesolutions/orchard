// Core/unconnectedCapability.test.js — UC-1 (v2.74.1957). The live 19:11 miss is the first test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { absentTargetLegs, unconnectedNote } from './unconnectedCapability.js';

const UPS = 'gnd_ups';
const armed = [{ id: 'ups_track', name: 'Track a UPS package' }, { id: 'ups_recent', name: 'Recently tracked' }];
const shopifyLeg = { groundId: 'gnd_shopify', key: 'me.shopify.shopify_order' };
const upsLeg = { tool: { groundId: UPS }, key: 'me.ups.ups_track' };

describe('absentTargetLegs — the live 19:11 case', () => {
  it('fires when the target ground has armed legs and NONE are in the palette', () => {
    const a = absentTargetLegs({ groundId: UPS, paletteLegs: [shopifyLeg, shopifyLeg], armedRecipes: armed });
    assert.equal(a.groundId, UPS);
    assert.equal(a.count, 2);
    assert.deepEqual(a.names, ['Track a UPS package', 'Recently tracked']);
  });

  it('stays QUIET when the ground IS represented — the connected case', () => {
    assert.equal(absentTargetLegs({ groundId: UPS, paletteLegs: [shopifyLeg, upsLeg], armedRecipes: armed }), null);
  });

  it('reads the groundId off leg.tool as well as the leg itself (both projections occur)', () => {
    assert.equal(absentTargetLegs({ groundId: UPS, paletteLegs: [{ groundId: UPS }], armedRecipes: armed }), null);
    assert.equal(absentTargetLegs({ groundId: UPS, paletteLegs: [{ tool: { groundId: UPS } }], armedRecipes: armed }), null);
  });

  it('ONE present leg is enough to stay quiet — a partial palette is a different problem', () => {
    // Firing on partial coverage would nag during normal use, and an honest warning that cries wolf gets skipped.
    assert.equal(absentTargetLegs({ groundId: UPS, paletteLegs: [upsLeg], armedRecipes: armed }), null);
  });
});

describe('absentTargetLegs — when it must say nothing', () => {
  it('no resolved target', () => {
    assert.equal(absentTargetLegs({ groundId: null, paletteLegs: [], armedRecipes: armed }), null);
    assert.equal(absentTargetLegs({ groundId: '', paletteLegs: [], armedRecipes: armed }), null);
  });

  it('the ground has no armed legs — nothing to miss', () => {
    assert.equal(absentTargetLegs({ groundId: UPS, paletteLegs: [shopifyLeg], armedRecipes: [] }), null);
  });

  it('tolerates junk without throwing on a routing hot path', () => {
    assert.equal(absentTargetLegs(), null);
    assert.equal(absentTargetLegs({}), null);
    assert.equal(absentTargetLegs({ groundId: UPS, paletteLegs: null, armedRecipes: null }), null);
    assert.equal(absentTargetLegs({ groundId: UPS, paletteLegs: [null, undefined, 3], armedRecipes: armed }).count, 2);
  });
});

describe('unconnectedNote — what the user is told instead of a silent substitution', () => {
  it('names the site, the capabilities, and the one action that fixes it', () => {
    const n = unconnectedNote(absentTargetLegs({ groundId: UPS, paletteLegs: [shopifyLeg], armedRecipes: armed }), 'www.ups.com');
    assert.match(n, /^ups\.com has 2 capabilities/);
    assert.match(n, /Track a UPS package/);
    assert.match(n, /aren't connected in this conversation/);
    assert.match(n, /Connect ups\.com to this conversation/);
  });

  it('never claims to have done anything', () => {
    const n = unconnectedNote({ count: 1, names: ['Track'] }, 'www.ups.com');
    assert.doesNotMatch(n, /\b(I ran|I opened|connected it|done)\b/i);
  });

  it('agrees in number, and degrades gracefully with no names or host', () => {
    assert.match(unconnectedNote({ count: 1, names: [] }, 'x.io'), /1 capability set up, but/);
    assert.match(unconnectedNote({ count: 5, names: [] }, ''), /^that site has 5 capabilities/);
  });

  it('returns null when there is nothing absent', () => {
    assert.equal(unconnectedNote(null, 'www.ups.com'), null);
    assert.equal(unconnectedNote({ count: 0, names: [] }, 'www.ups.com'), null);
  });
});
