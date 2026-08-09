/**
 * OPEN_DESK's matcher (v2.74.2104, DESIGN_exerciser_mvp.md §5b.1).
 *
 * The tests are weighted toward REFUSAL, because a miss is loud and harmless while a wrong match is silent and
 * sends every subsequent step of a test to the wrong desk.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchDesk, deskRefusal } from './deskMatch.js';

const DESKS = [
  { id: 'c1', title: 'Warranty' },
  { id: 'c2', title: 'Call Manager' },
  { id: 'c3', title: 'VendorSuite Ops' },
];

describe('matchDesk — hits', () => {
  it('matches exactly, ignoring case and punctuation', () => {
    assert.equal(matchDesk('warranty', DESKS).desk.id, 'c1');
    assert.equal(matchDesk('  WARRANTY ', DESKS).desk.id, 'c1');
    assert.equal(matchDesk('call-manager', DESKS).how, 'exact');
  });

  it('matches a unique prefix', () => {
    const r = matchDesk('vendor', DESKS);
    assert.equal(r.ok, true);
    assert.equal(r.desk.id, 'c3');
    assert.equal(r.how, 'prefix');
  });

  it('falls through to a unique contains', () => {
    const r = matchDesk('ops', DESKS);
    assert.equal(r.ok, true);
    assert.equal(r.how, 'contains');
  });

  it('prefers EXACT over a prefix that also matches', () => {
    const desks = [{ id: 'a', title: 'Call' }, { id: 'b', title: 'Call Manager' }];
    assert.equal(matchDesk('call', desks).desk.id, 'a');
  });
});

describe('matchDesk — refusals (the load-bearing half)', () => {
  it('refuses an unknown name and names what EXISTS', () => {
    const r = matchDesk('shipping', DESKS);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-match');
    assert.deepEqual(r.candidates, ['Warranty', 'Call Manager', 'VendorSuite Ops']);
  });

  it('refuses an ambiguous prefix rather than taking the first', () => {
    const desks = [{ id: 'a', title: 'Warranty North' }, { id: 'b', title: 'Warranty South' }];
    const r = matchDesk('warranty', desks);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ambiguous');
    assert.deepEqual(r.candidates, ['Warranty North', 'Warranty South']);
  });

  it('refuses DUPLICATE exact titles — a coin flip must not be recorded as a decision', () => {
    const desks = [{ id: 'a', title: 'Warranty' }, { id: 'b', title: 'warranty' }];
    assert.equal(matchDesk('warranty', desks).reason, 'ambiguous');
  });

  it('refuses an empty name, and an empty desk list', () => {
    assert.equal(matchDesk('', DESKS).reason, 'no-name');
    assert.equal(matchDesk('warranty', []).reason, 'none');
    assert.equal(matchDesk('warranty', null).reason, 'none');
  });

  it('never guesses by edit distance — a typo is a MISS, not a near-match', () => {
    assert.equal(matchDesk('warrenty', DESKS).ok, false);
    assert.equal(matchDesk('waranty', DESKS).ok, false);
  });

  it('ignores untitled desks rather than matching them', () => {
    const r = matchDesk('warranty', [{ id: 'x', title: '' }, { id: 'c1', title: 'Warranty' }]);
    assert.equal(r.desk.id, 'c1');
  });
});

describe('deskRefusal — a refusal names the alternatives', () => {
  it('lists the desks on a miss', () => {
    const msg = deskRefusal(matchDesk('shipping', DESKS), 'shipping');
    assert.match(msg, /don't have a desk called "shipping"/);
    assert.match(msg, /Warranty/);
    assert.match(msg, /Call Manager/);
  });

  it('asks which on an ambiguity', () => {
    const desks = [{ id: 'a', title: 'Warranty North' }, { id: 'b', title: 'Warranty South' }];
    const msg = deskRefusal(matchDesk('warranty', desks), 'warranty');
    assert.match(msg, /More than one desk matches/);
    assert.match(msg, /Warranty North/);
  });

  it('handles the no-desks and no-name cases without inventing a list', () => {
    assert.match(deskRefusal(matchDesk('x', []), 'x'), /no desks yet/);
    assert.match(deskRefusal(matchDesk('', DESKS), ''), /Which desk\?/);
  });

  it('bounds the list it reads back', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, title: `Desk ${i}` }));
    const msg = deskRefusal(matchDesk('nope', many), 'nope');
    assert.equal((msg.match(/\*\*/g) || []).length / 2, 8);
  });
});
