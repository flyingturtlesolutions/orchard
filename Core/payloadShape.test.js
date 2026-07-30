// Core/payloadShape.test.js — the keys-only response shape line (v2.74.1872). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { payloadPaths, payloadShapeLine } from './payloadShape.js';

// The payload this exists for — the one I claimed three times carried `access.DefaultDivision.Id` without ever
// having seen it. (Structure from the HAR scrub; values fabricated.)
const STATE = {
  access: {
    DefaultDivision: { Id: 32, Name: 'Raleigh', Code: '495' },
    Hubs: [{ Name: 'Carolinas', Divisions: [{ Id: 32, Code: '495', Name: 'Raleigh' }, { Id: 37, Code: '210', Name: 'Charlotte North' }] }],
    Permissions: ['warranty.read', 'warranty.write'],
  },
  announcements: [],
};

describe('payloadShape — structure', () => {
  const { paths } = payloadPaths(STATE);
  it('reaches the field the whole six-pass diagnosis turned on', () => {
    assert.ok(paths.includes('access.DefaultDivision.Id:number'), paths.join(' · '));
    assert.ok(paths.includes('access.DefaultDivision.Name:string'));
  });
  it('reports an array’s LENGTH and descends element 0 only — one shape, not 121 repeats', () => {
    assert.ok(paths.some((p) => p.startsWith('access.Hubs[1].Divisions[2].Id')), paths.join(' · '));
    assert.equal(paths.filter((p) => p.includes('Divisions')).length, 3);
  });
  it('an empty array is still structure', () => {
    assert.ok(paths.includes('announcements[0]'));
    assert.ok(paths.includes('access.Permissions[2]:string'));
  });
});

describe('payloadShape — privacy', () => {
  it('emits paths and leaf TYPES, never a value', () => {
    const line = payloadShapeLine('vs_state', STATE);
    for (const v of ['Raleigh', 'Charlotte North', '495', '210', 'Carolinas', 'warranty.read', '32', '37']) {
      assert.ok(!line.includes(v), `leaked a value: ${v} — ${line}`);
    }
    assert.ok(line.startsWith('PAYLOAD ▸ [vs_state] '));
  });
  it('masks PII-shaped KEYS — a map keyed by email/phone/id would emit it as a path segment', () => {
    const keyed = { byEmail: { 'destinyrfinch@gmail.com': { ok: true } }, byPhone: { '+1 919 555 0134': { ok: true } }, byId: { 10835071: { ok: true } }, plain: { Name: 'x' } };
    const kp = payloadPaths(keyed).paths.join(' · ');
    assert.doesNotMatch(kp, /destinyrfinch|gmail|919|10835071/);
    assert.equal(kp.match(/«id»/g).length, 3);
    assert.ok(kp.includes('plain.Name:string'));
  });
});

describe('payloadShape — honest caps', () => {
  it('a stopped descent reports a key count instead of pretending to be a leaf', () => {
    assert.match(payloadPaths({ a: { b: { c: { d: { e: { f: 1 } } } } } }, { maxDepth: 3 }).paths[0], /\{\d+\}$/);
  });
  it('the count is of what EXISTS, not of what was printed', () => {
    const wide = {}; for (let i = 0; i < 100; i++) wide[`k${i}`] = i;
    const w = payloadPaths(wide, { maxPaths: 10 });
    assert.equal(w.paths.length, 10);
    assert.equal(w.truncated, true);
    assert.equal(w.total, 100);           // the work ceiling is separate from the print cap, so this stays exact
    assert.equal(w.stopped, false);
    assert.ok(payloadShapeLine('x', wide, { maxPaths: 10 }).endsWith('…+90 more'));
  });
  it('a walk that hit the work ceiling says the remainder is a floor, not a count', () => {
    // 6000 leaves > WORK_MAX (5000): `total` can no longer be exact, and the line must not claim it is
    const huge = {}; for (let i = 0; i < 6000; i++) huge[`k${i}`] = i;
    const h = payloadPaths(huge, { maxPaths: 5 });
    assert.equal(h.stopped, true);
    assert.match(payloadShapeLine('x', huge, { maxPaths: 5 }), /\+ more \(walk capped\)$/);
  });
});

describe('payloadShape — degenerate input', () => {
  it('declines a reply with no shape rather than emitting a meaningless line', () => {
    assert.equal(payloadShapeLine('x', null), null);
    assert.equal(payloadShapeLine('x', 'a string'), null);
    assert.equal(payloadShapeLine('x', undefined), null);
  });
  it('never throws on a bare leaf', () => {
    assert.equal(payloadPaths(undefined).paths.length, 1);
  });
});
