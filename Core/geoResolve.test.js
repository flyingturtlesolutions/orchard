// Core/geoResolve.test.js — v2.74.2063: the pure GEO name→code table (DESIGN_resolve.md §10.5 item 3).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stateToCode, countryToISO, STATE_NAME_TO_CODE, COUNTRY_TO_ISO } from './geoResolve.js';

describe('geoResolve — stateToCode (US state NAME → 2-letter code)', () => {
  it('resolves a plain state name', () => {
    assert.equal(stateToCode('Georgia'), 'GA');
    assert.equal(stateToCode('California'), 'CA');
  });
  it('is case-insensitive', () => {
    assert.equal(stateToCode('georgia'), 'GA');
    assert.equal(stateToCode('NORTH CAROLINA'), 'NC');
  });
  it('resolves multi-word names', () => {
    assert.equal(stateToCode('North Carolina'), 'NC');
    assert.equal(stateToCode('New York'), 'NY');
    assert.equal(stateToCode('District of Columbia'), 'DC');
  });
  it('resolves the populated territories', () => {
    assert.equal(stateToCode('Puerto Rico'), 'PR');
    assert.equal(stateToCode('Guam'), 'GU');
  });
  it('is IDEMPOTENT — an already-2-letter code returns itself, uppercased', () => {
    assert.equal(stateToCode('GA'), 'GA');
    assert.equal(stateToCode('ga'), 'GA');
    assert.equal(stateToCode('nc'), 'NC');
  });
  it('returns empty on a miss (never the input)', () => {
    assert.equal(stateToCode('nope'), '');
    assert.equal(stateToCode('Freedonia'), '');
    assert.equal(stateToCode('ZZ'), '');
    assert.equal(stateToCode(''), '');
    assert.equal(stateToCode(null), '');
  });
});

describe('geoResolve — countryToISO (country NAME → ISO alpha-2)', () => {
  it('resolves a plain country name', () => {
    assert.equal(countryToISO('United States'), 'US');
    assert.equal(countryToISO('Canada'), 'CA');
  });
  it('resolves the common United States aliases', () => {
    assert.equal(countryToISO('USA'), 'US');
    assert.equal(countryToISO('U.S.'), 'US');
    assert.equal(countryToISO('United States of America'), 'US');
    assert.equal(countryToISO('America'), 'US');
  });
  it('is case-insensitive', () => {
    assert.equal(countryToISO('canada'), 'CA');
    assert.equal(countryToISO('MEXICO'), 'MX');
  });
  it('is IDEMPOTENT — an ISO code returns itself, uppercased', () => {
    assert.equal(countryToISO('US'), 'US');
    assert.equal(countryToISO('us'), 'US');
    assert.equal(countryToISO('CA'), 'CA');
  });
  it('returns empty on a miss (never the input)', () => {
    assert.equal(countryToISO('nope'), '');
    assert.equal(countryToISO('ZZ'), '');
    assert.equal(countryToISO(''), '');
    assert.equal(countryToISO(undefined), '');
  });
});

describe('geoResolve — tables are frozen normalized-key maps', () => {
  it('STATE_NAME_TO_CODE keys are normalized (lowercase, single-spaced)', () => {
    assert.equal(STATE_NAME_TO_CODE['north carolina'], 'NC');
    assert.equal(Object.isFrozen(STATE_NAME_TO_CODE), true);
  });
  it('COUNTRY_TO_ISO keys are normalized', () => {
    assert.equal(COUNTRY_TO_ISO['united states'], 'US');
    assert.equal(Object.isFrozen(COUNTRY_TO_ISO), true);
  });
});
