// Core/updateSignal.test.js — SU-2 (DESIGN_self_update.md §3.3) pure signal logic. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cmpVersion, evaluateReady, evaluateBoot, formatReady, formatApplied, updaterLine, shouldRelay } from './updateSignal.js';

describe('updateSignal — cmpVersion', () => {
  it('compares numerically, not lexically', () => {
    assert.equal(cmpVersion('2.74.2224', '2.74.2223'), 1);
    assert.equal(cmpVersion('2.74.9', '2.74.10'), -1);   // 9 < 10
    assert.equal(cmpVersion('2.74.2224', '2.74.2224'), 0);
    assert.equal(cmpVersion('3.0.0', '2.99.99'), 1);
  });
});

describe('updateSignal — evaluateReady (the arm decision)', () => {
  const loaded = '2.74.2224';
  it('absent/reject poll ({ok:false}) → no arm, no log (unmanaged install stays inert)', () => {
    assert.deepEqual(evaluateReady({ ok: false }, loaded, []), { arm: false, armVersion: null, log: null });
    assert.deepEqual(evaluateReady(null, loaded, []), { arm: false, armVersion: null, log: null });
  });
  it('equal version → no arm (up to date)', () => {
    assert.deepEqual(evaluateReady({ ok: true, version: loaded }, loaded, []), { arm: false, armVersion: null, log: null });
  });
  it('newer, first seen → ARM + a ready log', () => {
    const r = evaluateReady({ ok: true, version: '2.74.2225' }, loaded, []);
    assert.equal(r.arm, true);
    assert.equal(r.armVersion, '2.74.2225');
    assert.deepEqual(r.log, { kind: 'ready', disk: '2.74.2225', loaded });
  });
  it('newer, already seen → ARM but NO re-log (persisted seen-set defeats cold-boot re-logging)', () => {
    const r = evaluateReady({ ok: true, version: '2.74.2225' }, loaded, new Set(['2.74.2225']));
    assert.equal(r.arm, true);
    assert.equal(r.log, null);
  });
  it('OLDER disk (force-pushed-back fleet) → never arm; log ready-older instead (ruling 3)', () => {
    const r = evaluateReady({ ok: true, version: '2.74.2200' }, loaded, []);
    assert.equal(r.arm, false);
    assert.deepEqual(r.log, { kind: 'ready-older', disk: '2.74.2200', loaded });
  });
  it('seen works as an array too', () => {
    assert.equal(evaluateReady({ ok: true, version: '2.74.2225' }, loaded, ['2.74.2225']).log, null);
  });
});

describe('updateSignal — evaluateBoot (the applied beacon)', () => {
  it('changed version → applied', () => {
    assert.deepEqual(evaluateBoot('2.74.2224', '2.74.2225'), { changed: true, from: '2.74.2224', to: '2.74.2225' });
  });
  it('same version → no beacon', () => {
    assert.equal(evaluateBoot('2.74.2225', '2.74.2225').changed, false);
  });
  it('no prior lastRunVersion (first boot) → applied with from=null', () => {
    assert.deepEqual(evaluateBoot(undefined, '2.74.2225'), { changed: true, from: null, to: '2.74.2225' });
  });
  it('no loaded version → no beacon (defensive)', () => {
    assert.equal(evaluateBoot('x', undefined).changed, false);
  });
});

describe('updateSignal — line formatters (must match the decisionMarkers src prefixes)', () => {
  it('ready / ready-older', () => {
    assert.equal(formatReady({ kind: 'ready', disk: '2.74.2225', loaded: '2.74.2224' }), 'UPDATE ▸ ready v2.74.2225 (loaded v2.74.2224)');
    assert.ok(formatReady({ kind: 'ready-older', disk: '2.74.2200', loaded: '2.74.2224' }).startsWith('UPDATE ▸ ready-older '));
  });
  it('applied — with and without a known from, lag known/unknown', () => {
    assert.equal(formatApplied('2.74.2224', '2.74.2225', 3), 'UPDATE ▸ applied v2.74.2225 from v2.74.2224 lag=3m');
    assert.equal(formatApplied(null, '2.74.2225', null), 'UPDATE ▸ applied v2.74.2225 lag=unknown');
  });
  it('updater heartbeat carries head/state/fetchOk/age/guid', () => {
    const line = updaterLine({ head: 'abc1234', state: 'ok', fetchOk: true, at: 100, guid: 'G1' }, 340);
    assert.ok(line.startsWith('UPDATE ▸ updater '));
    assert.match(line, /head=abc1234/);
    assert.match(line, /state=ok/);
    assert.match(line, /fetchOk=true/);
    assert.match(line, /age=4m/);      // (340-100)/60 = 4
    assert.match(line, /guid=G1/);
  });
  it('updater line derives state=error from fetchOk=false when state is missing, and null on empty', () => {
    assert.match(updaterLine({ head: 'x', fetchOk: false }), /state=error/);
    assert.equal(updaterLine(null), null);
  });
  it('formatReady strips non-version chars from a hostile version (no log-line injection)', () => {
    const line = formatReady({ kind: 'ready', disk: '9\n2026\ninject', loaded: '2.74.2224' });
    assert.ok(!/\n/.test(line), 'no embedded newline');
    assert.equal(line, 'UPDATE ▸ ready v92026 (loaded v2.74.2224)');
  });
  it('updaterLine strips newlines/injection from head/state/guid', () => {
    const line = updaterLine({ head: 'abc\nEVIL ▸ forged', state: 'ok', fetchOk: true, at: 100, guid: 'G1\nx' }, 160);
    assert.ok(!/\n/.test(line), 'no embedded newline in the relay line');
    assert.match(line, /guid=G1x/);
  });
});

describe('updateSignal — shouldRelay (heartbeat throttle)', () => {
  const cur = { state: 'ok', fetchOk: true, head: 'abc' };
  it('no prior → relay', () => assert.equal(shouldRelay(null, cur), true));
  it('unchanged within 24h → skip', () => assert.equal(shouldRelay({ ...cur }, cur, 1000, 1000 + 3600), false));
  it('state change → relay', () => assert.equal(shouldRelay({ ...cur, state: 'refused:dirty' }, cur), true));
  it('head change → relay', () => assert.equal(shouldRelay({ ...cur, head: 'zzz' }, cur), true));
  it('fetchOk flip → relay', () => assert.equal(shouldRelay({ ...cur, fetchOk: false }, cur), true));
  it('>24h since last relay → relay even if unchanged', () => assert.equal(shouldRelay({ ...cur }, cur, 1000, 1000 + 25 * 3600), true));
});
