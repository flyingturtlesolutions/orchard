// Core/catalogConformance.test.js — Rail A-0a (v2.74.1725): the catalog conformance gate, born green.
//
// Two assertions per check, per docs/HANDOFF_hardening_arc.md §3:
//   1. the REAL catalog is clean (the gate — keeps once-bled gaps closed);
//   2. a SYNTHETIC bad entry is flagged (the test-the-test — a check never seen red is a hope, not a check).
// The synthetic entries live here permanently: the red-proof is not a one-off during development, it is a
// standing proof the auditor can still fire.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  auditGateAxes, auditIdentity, auditRecipeLegibility, auditPaletteSafety, runCatalogAudit,
  PALETTE_SAFETY, WRITE_VERB_RE, isWriteShaped,
} from './catalogConformance.js';
import { CONNECTOR_RECIPES } from './connectorRecipes.js';
import { BUILTIN_LEGS } from './palette.js';
import { SAFETY_CLASSES, safetyClassForMethod } from './rideRecipe.js';

describe('catalogConformance — the REAL catalog is clean (A-0a born green, kept green)', () => {
  it('gate axes: every write recipe declares boolean reversible AND outward (the v1686 gap, closed)', () => {
    assert.deepEqual(auditGateAxes(CONNECTOR_RECIPES), []);
    // and the check is actually LOOKING at something — the catalog does carry writes
    assert.ok(CONNECTOR_RECIPES.filter((r) => r.write).length >= 10, 'the write population the check guards');
  });

  it('identity: every verifyIdentity recipe names its identityProbe', () => {
    assert.deepEqual(auditIdentity(CONNECTOR_RECIPES), []);
    assert.ok(CONNECTOR_RECIPES.filter((r) => r.verifyIdentity).length >= 10);
  });

  it('legibility: unique ids, non-empty does, every param carries an EXPLICIT boolean required', () => {
    // 27/84 params lacked the boolean when this check was calibrated (2026-07-23); backfilled required:false in
    // the same commit — behavior-neutral (consumers read p.required truthily). This keeps the declaration honest.
    assert.deepEqual(auditRecipeLegibility(CONNECTOR_RECIPES), []);
  });

  it('palette: safety present + in-enum, does present, no write-shaped self leg is auto', () => {
    assert.deepEqual(auditPaletteSafety(BUILTIN_LEGS), []);
  });

  it('the aggregate sweep is clean and counts what it swept', () => {
    const { violations, counts } = runCatalogAudit({ recipes: CONNECTOR_RECIPES, legs: BUILTIN_LEGS });
    assert.deepEqual(violations, []);
    assert.equal(counts.recipes, CONNECTOR_RECIPES.length);
    assert.equal(counts.legs, BUILTIN_LEGS.length);
    assert.equal(counts.violations, 0);
  });
});

describe('catalogConformance — TEST-THE-TEST: every check proven able to fire (standing red-proof)', () => {
  it('a write recipe missing an axis is flagged, per missing axis', () => {
    const bad = [{ id: 'x_write', write: true, reversible: true }];               // outward missing
    const v = auditGateAxes(bad);
    assert.equal(v.length, 1);
    assert.match(v[0], /outward/);
    assert.equal(auditGateAxes([{ id: 'y', write: true }]).length, 2, 'both axes missing → two violations');
    assert.deepEqual(auditGateAxes([{ id: 'r', write: false }]), [], 'a read is exempt');
  });

  it('a verifyIdentity recipe without a probe is flagged', () => {
    assert.match(auditIdentity([{ id: 'x_vi', verifyIdentity: true }])[0], /identityProbe/);
    assert.deepEqual(auditIdentity([{ id: 'ok', verifyIdentity: true, identityProbe: '/api/me' }]), []);
  });

  it('legibility flags: duplicate id · empty does · unnamed param · non-boolean/missing required', () => {
    const dup = auditRecipeLegibility([{ id: 'a', does: 'x' }, { id: 'a', does: 'y' }]);
    assert.ok(dup.some((s) => /duplicate/.test(s)));
    assert.ok(auditRecipeLegibility([{ id: 'b', does: '' }]).some((s) => /does/.test(s)));
    assert.ok(auditRecipeLegibility([{ id: 'c', does: 'x', params: [{ type: 'string' }] }]).some((s) => /unnamed/.test(s)));
    assert.ok(auditRecipeLegibility([{ id: 'd', does: 'x', params: [{ name: 'p' }] }]).some((s) => /explicit boolean/.test(s)));
    assert.ok(auditRecipeLegibility([{ id: 'e', does: 'x', params: [{ name: 'p', required: 'yes' }] }]).some((s) => /explicit boolean/.test(s)),
      'a truthy STRING is not a declaration');
  });

  it('palette flags: out-of-enum safety · missing safety · empty does · write-shaped auto', () => {
    assert.ok(auditPaletteSafety([{ key: 'K', name: 'k', does: 'x', safety: 'forbidden' }]).some((s) => /not in/.test(s)));
    assert.ok(auditPaletteSafety([{ key: 'K2', name: 'k', does: 'x' }]).some((s) => /not in/.test(s)), 'absent safety is out-of-enum too');
    assert.ok(auditPaletteSafety([{ key: 'K3', name: 'k', does: '', safety: 'auto' }]).some((s) => /does/.test(s)));
    const v = auditPaletteSafety([{ key: 'CLOSE_THING', name: 'Close a thing', does: 'closes', safety: 'auto' }]);
    assert.ok(v.some((s) => /write-shaped/.test(s)), 'a close-verb leg on auto must fire');
    assert.deepEqual(auditPaletteSafety([{ key: 'CLOSE_OK', name: 'Close a thing', does: 'closes', safety: 'confirm' }]), [],
      'the same leg on confirm is clean');
  });
});

describe('catalogConformance — the safety DERIVATION and enums stay closed (the per-subject split)', () => {
  it('safetyClassForMethod floors every non-GET at gated (fail-closed by construction)', () => {
    assert.equal(safetyClassForMethod('GET'), 'auto');
    assert.equal(safetyClassForMethod('get'), 'auto');
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal(safetyClassForMethod(m), 'gated', m);
    assert.equal(safetyClassForMethod(undefined), 'auto', 'absent method reads as GET');
    assert.equal(safetyClassForMethod('DELETE', { destructive: true }), 'destructive', 'the destructive override outranks');
    assert.equal(safetyClassForMethod('GET', { destructive: true }), 'destructive', 'destructive wins even over a GET');
  });

  it('the two safety enums stay THEIR shapes — never merged (the two-enums correction)', () => {
    assert.deepEqual([...SAFETY_CLASSES], ['auto', 'gated', 'destructive']);
    assert.ok(Object.isFrozen(SAFETY_CLASSES));
    assert.deepEqual([...PALETTE_SAFETY], ['auto', 'confirm', 'gated']);
    assert.ok(Object.isFrozen(PALETTE_SAFETY));
    // the deliberate difference IS the assertion: confirm exists only on the palette; destructive only per-Ground
    assert.ok(!SAFETY_CLASSES.includes('confirm') && !PALETTE_SAFETY.includes('destructive'));
  });

  it('isWriteShaped sees verbs in UNDERSCORE keys — the raw regex cannot (its own test-the-test find)', () => {
    // `\bclose\b` can never match inside CLOSE_CASE (underscore is a word char) — the first draft of this suite
    // shipped exactly that miss and THIS test caught it. isWriteShaped normalizes separators first.
    assert.ok(!WRITE_VERB_RE.test('CLOSE_CASE'), 'the raw regex misses underscore keys — documented limitation');
    assert.ok(isWriteShaped({ key: 'CLOSE_CASE' }), 'the auditor helper does not');
    assert.ok(isWriteShaped({ key: 'X', name: 'Delete a record' }), 'name verbs still count');
    assert.ok(!isWriteShaped({ key: 'OPEN_CASE', name: 'Open a case' }), '"open" deliberately absent — a case stays cheap (PP-3)');
    assert.ok(!isWriteShaped({ key: 'REVIEW_QUEUE', name: 'Review queue' }), 'review is analysis, not a write');
  });
});
