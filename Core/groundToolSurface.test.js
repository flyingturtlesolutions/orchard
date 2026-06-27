// Core/groundToolSurface.test.js — the tri-class per-Ground tool-surface model (§18 slice 3). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { recipeRow, rideSection, groundToolSurface } from './groundToolSurface.js';

const RECIPES = [
  { id: 'delete_ticket', name: 'Delete', method: 'DELETE', safetyClass: 'destructive', provenance: 'curated', enabled: true, reviewState: 'accepted', trust: 1 },
  { id: 'my_open_tickets', name: 'My open tickets', method: 'GET', safetyClass: 'auto', provenance: 'curated', enabled: true, reviewState: 'accepted', trust: 1 },
  { id: 'harvest_x', name: 'Recent activity', method: 'GET', safetyClass: 'auto', provenance: 'harvested', enabled: true, reviewState: 'pending', trust: 0.3 },
  { id: 'add_comment', name: 'Comment', method: 'PUT', safetyClass: 'gated', provenance: 'curated', enabled: false, reviewState: 'accepted', trust: 1 },
];

describe('groundToolSurface — recipeRow', () => {
  it('projects display fields + computes armable', () => {
    assert.equal(recipeRow(RECIPES[1]).armable, true);                    // enabled + accepted
    assert.equal(recipeRow(RECIPES[2]).armable, false);                   // harvested + pending → blocked
    assert.equal(recipeRow(RECIPES[3]).armable, false);                   // disabled
    assert.equal(recipeRow(RECIPES[2]).provenance, 'harvested');
  });
});

describe('groundToolSurface — rideSection', () => {
  it('sorts safest-first, counts, pending, by-safety histogram', () => {
    const s = rideSection(RECIPES);
    assert.equal(s.type, 'recipes');
    assert.equal(s.count, 4);
    assert.equal(s.pending, 1);                                           // the harvested one
    assert.deepEqual(s.bySafety, { auto: 2, gated: 1, destructive: 1 });
    assert.equal(s.entries[0].safetyClass, 'auto');                       // auto sorts first
    assert.equal(s.entries[s.entries.length - 1].safetyClass, 'destructive');  // destructive last
  });
});

describe('groundToolSurface — tri-class envelope', () => {
  it('drive / ride / broker in order; ride carries pending; broker placeholder when empty; drive sums section counts', () => {
    const drive = [
      { type: 'fragments', label: 'Fragments', count: 12, entries: [] },
      { type: 'perspectives', label: 'Perspectives', count: 4, entries: [] },
    ];
    const surface = groundToolSurface({ driveSections: drive, recipes: RECIPES, brokerSections: [] });
    assert.deepEqual(surface.classes.map((c) => c.key), ['drive', 'ride', 'broker']);   // order = class hierarchy
    assert.equal(surface.classes[0].count, 16);                          // 12 + 4
    assert.equal(surface.classes[1].count, 4);                           // ride recipes
    assert.equal(surface.classes[1].pending, 1);                         // the pending badge
    assert.equal(surface.classes[2].placeholder, true);                 // broker empty
    assert.equal(surface.classes[2].count, 0);
  });
  it('empty input → three classes, all zero, broker placeholder', () => {
    const s = groundToolSurface({});
    assert.equal(s.classes.length, 3);
    assert.equal(s.classes[1].count, 0);
    assert.equal(s.classes[2].placeholder, true);
  });
});
