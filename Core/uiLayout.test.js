// Core/uiLayout.test.js — the deterministic appearance rung (v2.74.1965).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { layoutReport, formatLayoutMarker } from './uiLayout.js';

// A clean, well-rendered connector list reply: fits, 6 rows, styled mono chips with a background, real list.
const CLEAN = { clientWidth: 320, scrollWidth: 318, rows: 6, chips: 6, bold: 7, listStyled: true,
  chipFont: 'ui-monospace, SFMono-Regular, monospace', chipBg: 'rgb(240, 240, 240)' };

describe('uiLayout — layoutReport', () => {
  it('a clean styled reply has NO flags', () => {
    const r = layoutReport(CLEAN);
    assert.deepEqual(r.flags, []);
    assert.equal(r.overflow, false);
    assert.equal(r.chipStyled, true);
    assert.equal(r.rows, 6);
  });

  it('content wider than the panel → overflow flag (the "cut off" bug)', () => {
    const r = layoutReport({ ...CLEAN, clientWidth: 320, scrollWidth: 400 });
    assert.equal(r.overflow, true);
    assert.ok(r.flags.includes('overflow'));
  });

  it('sub-pixel width diff is NOT an overflow (tolerance)', () => {
    assert.equal(layoutReport({ ...CLEAN, clientWidth: 320, scrollWidth: 321 }).overflow, false);
  });

  it('chips present but chat.css did not style them → chip-unstyled (the L2 CSS gap, caught without a screenshot)', () => {
    const noMono = layoutReport({ ...CLEAN, chipFont: 'Arial, sans-serif' });
    assert.equal(noMono.chipStyled, false);
    assert.ok(noMono.flags.includes('chip-unstyled'));
    const noBg = layoutReport({ ...CLEAN, chipBg: 'rgba(0, 0, 0, 0)' });   // transparent = unstyled
    assert.ok(noBg.flags.includes('chip-unstyled'));
  });

  it('no chips → chip styling is n/a, not a flag (a single-record reply)', () => {
    const r = layoutReport({ clientWidth: 320, scrollWidth: 300, rows: 0, chips: 0, bold: 1, listStyled: false });
    assert.deepEqual(r.flags, []);
    assert.equal(r.chipStyled, false);   // false, but not flagged
  });
});

describe('uiLayout — formatLayoutMarker', () => {
  it('a clean reply renders a flag-free LAYOUT ▸ line', () => {
    const line = formatLayoutMarker('reply', layoutReport(CLEAN));
    assert.match(line, /^LAYOUT ▸ reply rows=6 chips=6 bold=7 overflow=no chip-styled=yes list=yes$/);
  });
  it('problems surface as a ⚠ suffix', () => {
    const line = formatLayoutMarker('reply', layoutReport({ ...CLEAN, scrollWidth: 500, chipFont: 'Arial' }));
    assert.match(line, /overflow=YES/);
    assert.match(line, /chip-styled=NO/);
    assert.match(line, /⚠ overflow,chip-unstyled$/);
  });
  it('no chips → chip-styled=n/a', () => {
    const line = formatLayoutMarker('reply', layoutReport({ clientWidth: 320, scrollWidth: 300, rows: 0, chips: 0, bold: 1 }));
    assert.match(line, /chip-styled=n\/a/);
  });
});
