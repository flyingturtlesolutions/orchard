// Core/caseClause.test.js — PP-3 (v2.74.1686): the per-item CASE clause.
//
// The load-bearing properties are two: what the model CANNOT say (no system, no record, no invented contents),
// and that an EMPTY prior set is a named stop. The second is the one the live trace needed — a branch narrowed to
// 0, the next step ran anyway, and an outward Zendesk write was dispatched twice.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCaseVerdict, casePreflight, caseRecord, caseTally, CASE_WINDOW, CASE_SCOPES,
} from './caseClause.js';

describe('caseClause — the shape is minimal, and that is the design', () => {
  it('an EMPTY object is a valid verdict — nothing here can be underspecified', () => {
    const v = normalizeCaseVerdict({});
    assert.equal(v.kind, 'case');
    assert.equal(v.scope, 'item');
    assert.equal(v.cap, 0);
    assert.equal(v.title, '');
  });

  it('null ONLY for a non-object, so a caller can tell "dropped in transit" from "thin answer"', () => {
    for (const bad of [null, undefined, 'open a case', 42, []]) assert.equal(normalizeCaseVerdict(bad), null);
    assert.ok(normalizeCaseVerdict({}));
  });

  it('carries NO target, NO record and NO contents, whatever the model puts in', () => {
    // A case is the artifact a human reviews INSTEAD of re-reading the source. Anything invented here is read as
    // established fact by the one person positioned to catch it.
    const v = normalizeCaseVerdict({
      scope: 'item', title: 'Replacement review',
      system: 'zendesk', leg: 'zendesk_create_ticket', target: { system: 'zendesk' },
      note: 'two switches', body: 'Needs 2 switches', fields: { qty: 2 }, record: { id: 7 },
    });
    assert.deepEqual(Object.keys(v).sort(), ['cap', 'kind', 'scope', 'title', 'why']);
    assert.equal(JSON.stringify(v).includes('zendesk'), false);
    assert.equal(JSON.stringify(v).includes('two switches'), false);
    assert.equal(JSON.stringify(v).includes('qty'), false);
  });

  it('scope defaults to per-ITEM, and an unknown scope does not become a run case', () => {
    // N cases when one was wanted is noise a person closes; one case when N were wanted destroys the per-row
    // review surface. The defaults lean to the recoverable mistake.
    assert.equal(normalizeCaseVerdict({ scope: 'run' }).scope, 'run');
    assert.equal(normalizeCaseVerdict({ scope: 'ITEM' }).scope, 'item');
    for (const bad of ['summary', 'all', '', null, 7, {}]) assert.equal(normalizeCaseVerdict({ scope: bad }).scope, 'item');
    assert.deepEqual(CASE_SCOPES, ['item', 'run']);
  });

  it('cap is bounded and title is clamped', () => {
    assert.equal(normalizeCaseVerdict({ cap: 5 }).cap, 5);
    assert.equal(normalizeCaseVerdict({ cap: 999 }).cap, CASE_WINDOW);
    assert.equal(normalizeCaseVerdict({ cap: -3 }).cap, 0);
    assert.equal(normalizeCaseVerdict({ cap: 'lots' }).cap, 0);
    assert.equal(normalizeCaseVerdict({ title: 'x'.repeat(400) }).title.length, 120);
  });
});

describe('caseClause — an empty prior set is a NAMED stop, not a fall-through', () => {
  it('THE LIVE BUG: zero candidates → no-candidates, never ok', () => {
    // `BRANCH ▸ narrowed prior → 0 of 1`, and the next step still resolved a write leg on another ground and
    // dispatched it twice. A step with nothing to do must stop by name.
    assert.deepEqual(casePreflight({ items: [] }), { ok: false, reason: 'no-candidates' });
    assert.deepEqual(casePreflight({}), { ok: false, reason: 'no-candidates' });
    assert.deepEqual(casePreflight({ items: null }), { ok: false, reason: 'no-candidates' });
  });

  it('per-item scope opens one case per row; run scope opens exactly one', () => {
    const rows = [{}, {}, {}];
    assert.equal(casePreflight({ items: rows, scope: 'item' }).count, 3);
    const r = casePreflight({ items: rows, scope: 'run' });
    assert.equal(r.count, 1);
    assert.equal(r.subjects, 3, 'a run case still reports how many items it covers');
  });

  it('flags truncation for per-item, and never for a single run case', () => {
    const many = Array.from({ length: CASE_WINDOW + 5 }, () => ({}));
    assert.equal(casePreflight({ items: many, scope: 'item' }).capped, true);
    assert.equal(casePreflight({ items: many, scope: 'run' }).capped, false);
  });
});

describe('caseClause — a case records what RAN, and names what it could not', () => {
  const stages = (...names) => names.map((n) => ({ name: n, verdict: 'ok', detail: '' }));

  it('renders the stages that actually produced something', () => {
    const r = caseRecord({}, { stages: [{ name: 'branch', verdict: 'arm', detail: 'replacement requested' }] });
    assert.deepEqual(r.lines, ['branch → arm (replacement requested)']);
    assert.equal(r.gap, '');
  });

  it('THE HONESTY CASE: asked to list a NUMBER when no step ever read one → the gap is named', () => {
    // The live ask was "create a new case listing the number and type of replacement" against a run whose only
    // stage was `branch`. Branch sorts; it does not count. A case that silently omitted this reads as "there were
    // none" to the one person able to catch it.
    const r = caseRecord({}, { asked: 'listing the number and type of replacement', stages: stages('branch') });
    assert.match(r.gap, /no step read/);
  });

  it('and stays quiet once a reading stage HAS run', () => {
    for (const s of ['fieldread', 'map', 'upsert']) {
      assert.equal(caseRecord({}, { asked: 'listing the number of replacements', stages: stages('branch', s) }).gap, '',
        `${s} is a reading stage — no gap to report`);
    }
  });

  it('does not cry gap when no detail was asked for', () => {
    assert.equal(caseRecord({}, { asked: 'open a case for each', stages: stages('branch') }).gap, '');
  });

  it('degenerate input does not throw', () => {
    for (const bad of [undefined, null, {}]) assert.doesNotThrow(() => caseRecord(bad, bad || {}));
    assert.deepEqual(caseRecord({}, {}).lines, []);
  });
});

describe('caseClause — the tally names every class including the zeroes', () => {
  it('reports opened / updated / already-open / failed', () => {
    const t = caseTally({ opened: 2, updated: 1, alreadyOpen: 3, failed: 0 });
    assert.match(t, /2 opened/);
    assert.match(t, /1 updated/);
    assert.match(t, /3 already open/);
    assert.match(t, /0 couldn’t save/);
  });

  it('ALREADY-OPEN is its own class — §5.7 says a re-run skips, and a skip is not a failure', () => {
    const t = caseTally({ alreadyOpen: 4 });
    assert.match(t, /4 already open/);
    assert.match(t, /0 couldn’t save/);
  });

  it('states truncation rather than implying coverage', () => {
    assert.match(caseTally({ opened: 24, capped: true, total: 40 }), /first 24 of 40/);
    assert.ok(!/first/.test(caseTally({ opened: 3, total: 3 })));
  });

  it('an empty run still reads honestly, and singular/plural agree', () => {
    assert.match(caseTally({}), /0 cases —/);
    assert.match(caseTally({ opened: 1 }), /1 case —/);
  });
});
