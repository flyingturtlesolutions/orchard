// Core/vitals.test.js — VT-0: the leg-outcome partition, canary selection, windows, incident transforms. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyLegOutcome, pickCanary, dueForDaily, upsertIncident, resolveIncident, openIncidents, INCIDENT_CAP, EVIDENCE_CAP,
  tallyClassOf, tallyDayKey, tallyTick, tallySummary, tallyByDay, TALLY_KEEP_DAYS } from './vitals.js';

const NOW = 1750000000000;

describe('vitals — classifyLegOutcome (the partition contract, spec §3.3)', () => {
  it('success is evidence for BOTH beliefs: fresh + drift-ok', () => {
    assert.deepEqual(classifyLegOutcome({ ok: true }), { auth: 'fresh', drift: 'ok' });
  });
  it('a signed-out outcome is auth evidence and NEVER drift evidence (the ordering rule, spec §3.1)', () => {
    assert.deepEqual(classifyLegOutcome({ ok: false, status: 401 }), { auth: 'signed-out', drift: null });
    assert.deepEqual(classifyLegOutcome({ ok: false, error: 'session-expired' }), { auth: 'signed-out', drift: null });
    assert.deepEqual(classifyLegOutcome({ ok: false, error: 'non-json' }), { auth: 'signed-out', drift: null });
  });
  it('a 403 with CSRF involved is NOT signed-out (stale token) and not a route miss either', () => {
    assert.deepEqual(classifyLegOutcome({ ok: false, status: 403, csrfInvolved: true }), { auth: null, drift: null });
    assert.deepEqual(classifyLegOutcome({ ok: false, status: 403, csrfInvolved: false }), { auth: 'signed-out', drift: null });
  });
  it('a 404-empty is drift evidence; a 404 with a structured body is neither belief’s evidence', () => {
    assert.deepEqual(classifyLegOutcome({ ok: false, status: 404, jsonBody: false }), { auth: null, drift: 'miss' });
    assert.deepEqual(classifyLegOutcome({ ok: false, error: 'http-404', jsonBody: true }), { auth: null, drift: null });
  });
  it('rewritten failures (graphql-error / op-hash-stale) and 5xx are no evidence at all', () => {
    for (const error of ['graphql-error', 'op-hash-stale', 'http-500', 'http-502']) {
      assert.deepEqual(classifyLegOutcome({ ok: false, error }), { auth: null, drift: null }, error);
    }
  });
  it('non-ride transports pass through as no-evidence until VT-6/7 bind them (day-one generality)', () => {
    assert.deepEqual(classifyLegOutcome({ transport: 'drive', ok: false, status: 404 }), { auth: null, drift: null });
    assert.deepEqual(classifyLegOutcome({ transport: 'broker', ok: true }), { auth: null, drift: null });
  });
});

describe('vitals — pickCanary (spec §6 discipline)', () => {
  const BASE = { enabled: true, reviewState: 'accepted', method: 'GET', origin: 'x.test' };
  it('rejects placeholders, required params, writes, unproven, and non-armable; prefers pulse > curated > freshest', () => {
    const recs = [
      { ...BASE, id: 'ph', provenance: 'curated', endpoint: '/api/t/{id}' },                                   // placeholder → out
      { ...BASE, id: 'req', provenance: 'curated', endpoint: '/api/t', params: [{ name: 'q', required: true }] }, // required param → out
      { ...BASE, id: 'wr', provenance: 'curated', endpoint: '/api/t', method: 'POST', write: true },           // write → out
      { ...BASE, id: 'unproven', provenance: 'harvested', endpoint: '/api/u' },                                // never worked → out
      { ...BASE, id: 'pend', provenance: 'curated', endpoint: '/api/p', reviewState: 'pending' },              // not armable → out
      { ...BASE, id: 'okA', provenance: 'curated', endpoint: '/api/a' },
      { ...BASE, id: 'okPulse', provenance: 'curated', endpoint: '/api/b', pulse: 60 },
      { ...BASE, id: 'okHarv', provenance: 'harvested', endpoint: '/api/c', lastOkAt: NOW },
    ];
    assert.equal(pickCanary(recs).id, 'okPulse', 'pulse-marked wins (the digest legs are canary-shaped)');
    assert.equal(pickCanary(recs.filter((r) => r.id !== 'okPulse')).id, 'okA', 'then curated');
    assert.equal(pickCanary(recs.filter((r) => !r.id.startsWith('ok') || r.id === 'okHarv')).id, 'okHarv', 'a proven harvested read qualifies');
    assert.equal(pickCanary([recs[0], recs[1], recs[2]]), null, 'no safe canary → null (say so, never improvise params)');
  });
});

describe('vitals — dueForDaily', () => {
  it('due when no armable read succeeded within the window; fresh evidence suppresses', () => {
    const W = 24 * 3600e3;
    assert.equal(dueForDaily([{ lastOkAt: NOW - W - 1 }], NOW, W), true);
    assert.equal(dueForDaily([{ lastOkAt: NOW - 3600e3 }], NOW, W), false);
    assert.equal(dueForDaily([{}], NOW, W), true, 'never-succeeded counts as stale');
  });
});

describe('vitals — incidents (one open per (class, subject); evidence appends; verify closes)', () => {
  it('open → append (no case-spam) → resolve → reopen is a NEW incident', () => {
    let r = upsertIncident([], { cls: 'presence', subject: 'x.test', origin: 'x.test', title: 'x.test looks signed out', line: 'fresh → signed-out', now: NOW });
    assert.equal(r.opened, true);
    r = upsertIncident(r.list, { cls: 'presence', subject: 'x.test', line: 'still signed out', now: NOW + 1000 });
    assert.equal(r.opened, false, 'flapping appends to the ONE open case');
    assert.equal(r.list.length, 1);
    assert.equal(r.list[0].evidence.length, 2);
    const c = resolveIncident(r.list, { cls: 'presence', subject: 'x.test', line: 'signed in again', now: NOW + 2000 });
    assert.equal(c.closed, true);
    assert.equal(c.list[0].status, 'closed');
    assert.equal(openIncidents(c.list).length, 0, 'closed = history, not attention');
    const again = upsertIncident(c.list, { cls: 'presence', subject: 'x.test', title: 't', now: NOW + 3000 });
    assert.equal(again.opened, true, 'a recurrence after resolution is a new incident (new timeline)');
    assert.equal(again.list.length, 2);
  });
  it('drift and presence incidents on the same subject-ish keys stay distinct; resolve without an open is a no-op', () => {
    let r = upsertIncident([], { cls: 'drift', subject: 'recipe_x', groundId: 'g1', recipeId: 'recipe_x', name: 'Read X', title: 'Read X may have drifted', now: NOW });
    r = upsertIncident(r.list, { cls: 'presence', subject: 'x.test', origin: 'x.test', title: 'signed out', now: NOW });
    assert.equal(openIncidents(r.list).length, 2);
    assert.equal(resolveIncident(r.list, { cls: 'drift', subject: 'other' }).closed, false);
  });
  it('evidence and list caps hold (closed age out first; open never dropped)', () => {
    let l = [];
    for (let i = 0; i < INCIDENT_CAP + 10; i++) {
      const r1 = upsertIncident(l, { cls: 'drift', subject: `r${i}`, title: 't', now: NOW + i });
      l = resolveIncident(r1.list, { cls: 'drift', subject: `r${i}`, now: NOW + i }).list;
    }
    const r = upsertIncident(l, { cls: 'presence', subject: 'keep', title: 'k', now: NOW + 99999 });
    assert.ok(r.list.length <= INCIDENT_CAP + 1);
    assert.ok(r.list.some((x) => x.subject === 'keep' && x.status === 'open'));
    let one = upsertIncident([], { cls: 'presence', subject: 's', title: 't', line: 'e0', now: NOW });
    for (let i = 1; i < EVIDENCE_CAP + 5; i++) one = upsertIncident(one.list, { cls: 'presence', subject: 's', line: `e${i}`, now: NOW + i });
    assert.equal(one.list[0].evidence.length, EVIDENCE_CAP, 'evidence keeps the newest CAP entries');
    assert.equal(one.list[0].evidence[EVIDENCE_CAP - 1].line, `e${EVIDENCE_CAP + 4}`, 'the newest line survives the cap');
  });
});

describe('vitals — the VT-2c rolling tally (rates the binary drift flag cannot carry)', () => {
  it('tallyClassOf maps the partition to the four buckets — and a GATED miss counts as auth (the cause)', () => {
    assert.equal(tallyClassOf({ ok: true }), 'ok');
    assert.equal(tallyClassOf({ ok: false, auth: 'signed-out' }), 'auth');
    assert.equal(tallyClassOf({ ok: false, auth: 'wrong-account' }), 'auth');
    assert.equal(tallyClassOf({ ok: false, drift: 'miss' }), 'miss');
    assert.equal(tallyClassOf({ ok: false, drift: 'miss', gatedMiss: true }), 'auth', 'the 404-on-anonymous class is auth evidence, never route evidence');
    assert.equal(tallyClassOf({ ok: false, auth: null, drift: null }), 'other');
  });
  it('tallyTick increments per-ground per-day, copy-on-write, and prunes beyond the keep window', () => {
    let book = tallyTick({}, { groundId: 'g1', cls: 'ok', now: NOW });
    const day = tallyDayKey(NOW);
    assert.equal(book.g1[day].ok, 1);
    const before = JSON.stringify(book);
    book = tallyTick(book, { groundId: 'g1', cls: 'miss', now: NOW });
    assert.equal(book.g1[day].ok, 1);
    assert.equal(book.g1[day].miss, 1);
    assert.equal(JSON.stringify(JSON.parse(before).g1[day]), JSON.stringify({ ok: 1, auth: 0, miss: 0, other: 0 }), 'prior book untouched (copy-on-write)');
    // an entry older than the keep window is pruned by the next tick
    const old = tallyTick({}, { groundId: 'g1', cls: 'ok', now: NOW - (TALLY_KEEP_DAYS + 2) * 86400e3 });
    const merged = { g1: { ...old.g1, ...book.g1 } };
    const next = tallyTick(merged, { groundId: 'g2', cls: 'auth', now: NOW });
    assert.equal(Object.keys(next.g1).length, 1, 'the stale day aged out');
    assert.equal(next.g2[day].auth, 1);
  });
  it('ignores an unknown class or a missing ground (no accidental buckets)', () => {
    assert.deepEqual(tallyTick({}, { groundId: 'g1', cls: 'weird', now: NOW }), {});
    assert.deepEqual(tallyTick({}, { cls: 'ok', now: NOW }), {});
  });
  it('tallySummary windows + rates; groundIds = one, many, or ALL (null)', () => {
    let book = {};
    for (let i = 0; i < 3; i++) book = tallyTick(book, { groundId: 'g1', cls: 'ok', now: NOW - i * 86400e3 });
    book = tallyTick(book, { groundId: 'g1', cls: 'auth', now: NOW });
    book = tallyTick(book, { groundId: 'g2', cls: 'ok', now: NOW });
    book = tallyTick(book, { groundId: 'g1', cls: 'ok', now: NOW - 9 * 86400e3 });   // outside the 7d window
    const one = tallySummary(book, 'g1', { now: NOW, days: 7 });
    assert.equal(one.total, 4);
    assert.equal(one.ok, 3);
    assert.equal(one.auth, 1);
    assert.ok(Math.abs(one.rate - 0.75) < 1e-9);
    const all = tallySummary(book, null, { now: NOW, days: 7 });
    assert.equal(all.total, 5, 'g2 joins the all-grounds sum; the 9d-old run stays outside');
    assert.equal(tallySummary({}, null, { now: NOW }).rate, null, 'no runs → rate null (never a fake 100%)');
  });
  it('tallyByDay rolls up per day, oldest→newest, and skips empty days', () => {
    let book = {};
    book = tallyTick(book, { groundId: 'g1', cls: 'ok', now: NOW - 2 * 86400e3 });
    book = tallyTick(book, { groundId: 'g2', cls: 'miss', now: NOW - 2 * 86400e3 });
    book = tallyTick(book, { groundId: 'g1', cls: 'ok', now: NOW });
    const days = tallyByDay(book, null, { now: NOW, days: 14 });
    assert.equal(days.length, 2);
    assert.ok(days[0].day < days[1].day, 'oldest first');
    assert.deepEqual({ total: days[0].total, ok: days[0].ok }, { total: 2, ok: 1 }, 'cross-ground rollup on the shared day');
  });
});
