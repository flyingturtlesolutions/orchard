// Core/panelConformance.test.js — PS-10 (v2.74.1772, DESIGN_panel_surfaces.md §6.3): text-level conformance
// checks over chat.js. These are the grep-class invariants the ladder established — each one is a contract a
// NEW code path can silently break with no runtime error (the _DECISION_RE failure family). Hard asserts for
// what the PS rungs made true; console.warn advisories for the aspirational rest. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const chat = readFileSync(join(root, 'chat.js'), 'utf8');

// Slice a top-level function's source: from its declaration to the next column-0 declaration/comment block.
function fnSource(name) {
  const re = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const m = re.exec(chat);
  if (!m) return null;
  const rest = chat.slice(m.index + 1);
  const end = rest.search(/^(?:async function |function |const |let |\/\/ ─|\/\/ ──)/m);
  return chat.slice(m.index, end > 0 ? m.index + 1 + end : undefined);
}

describe('panelConformance — §2.2 migrated views stay off the transcript', () => {
  // The overlay BODY renderers must never append chat bubbles — a bubble from a view is the one-shot-surface
  // regression the whole migration exists to kill. (The entry functions keep their no-desk guard bubble —
  // "Open a view first…" IS conversation.)
  // Exception (§9): a RUN handler may append its run bubble — but only after closing the surface it lives on
  // (releaseSurface for an overlay, _closeRail for a Rail row — run output streams into the thread it
  // revealed). Textual proxy: every appendMessage must have one of those closes in the preceding handler span.
  for (const name of ['_railWorkflowRow', '_railParkedRow', '_renderRoutinesBody', '_showKeepAliveBody', '_listCasesMsg']) {
    it(`${name} appends into the thread only after closing its surface`, () => {
      const src = fnSource(name);
      assert.ok(src, `${name} not found — if renamed, update this test`);
      for (const m of [...src.matchAll(/appendMessage\(/g)]) {
        const before = src.slice(Math.max(0, m.index - 600), m.index);
        assert.ok(before.includes('releaseSurface(') || before.includes('_closeRail('), `${name} appends a bubble while its surface is up — close it first (§9) or render in place`);
      }
    });
  }
});

describe('panelConformance — §4 the composer is claimed, never hand-locked', () => {
  it('chat-input.disabled is written ONLY by claimComposer/releaseComposer', () => {
    // every `.disabled =` write on the chat input, wherever the element ref came from
    const writes = [...chat.matchAll(/(?:\$\('chat-input'\)|inp)\.disabled\s*=/g)].length;
    const claimSrc = (fnSource('claimComposer') || '') + (fnSource('releaseComposer') || '');
    const inClaim = [...claimSrc.matchAll(/inp\.disabled\s*=/g)].length;
    // _wfRenderPage etc. must go through claimComposer — a new direct write is the anonymous-lock bug (§13 r6)
    assert.equal(writes, inClaim, `found ${writes - inClaim} chat-input.disabled write(s) outside claim/releaseComposer`);
  });
  // CF-3.11 (chat-tab review) — PLACEHOLDER writes are claim-owned too: the wizard's direct writes made the
  // claim record and the visible placeholder diverge (invisible to the disabled-only test), and focusForAssistant's
  // raw write shipped a mode with no chip and no escape. Both spellings the codebase has used are covered;
  // `inp.placeholder` on OTHER created inputs is out of scope by the distinct `$('chat-input')`/`_inp` prefixes.
  // KNOWN GAP (CF verify): the sanctioned writer's own idiom — `const inp = $('chat-input'); inp.placeholder =` —
  // is uncountable at text level (created-<input> locals named `inp` write placeholders legitimately), so a future
  // raw write copying THAT spelling slips this gate. Binding-aware coverage would need the undef-checker's parser.
  it('chat-input.placeholder is written ONLY by claimComposer/releaseComposer', () => {
    const direct = [...chat.matchAll(/\$\('chat-input'\)\.placeholder\s*=/g)].length
      + [...chat.matchAll(/_inp\.placeholder\s*=/g)].length;
    assert.equal(direct, 0, `found ${direct} raw chat-input placeholder write(s) — route them through claimComposer (placeholder option) or releaseComposer`);
  });
});

describe('panelConformance — §5 icon buttons carry labels', () => {
  it('no _mkIconBtn call passes an empty/absent aria-label', () => {
    const calls = [...chat.matchAll(/_mkIconBtn\(\s*'[^']+'\s*,/g)];
    assert.ok(calls.length >= 5, 'expected the PS-2 chip cluster to exist');
    const bad = [...chat.matchAll(/_mkIconBtn\(\s*'[^']+'\s*,\s*(?:''|null|undefined)\s*[,)]/g)];
    assert.equal(bad.length, 0, `${bad.length} _mkIconBtn call(s) with an empty label — the aria-label is REQUIRED (§5)`);
  });
  it('openPanelOverlay is always called with an id', () => {
    for (const c of [...chat.matchAll(/(?<!function )openPanelOverlay\(\{\s*([^}]{0,40})/g)]) {
      assert.ok(/^id:/.test(c[1].trim()), `openPanelOverlay call without a leading id near "${c[1].slice(0, 30)}"`);
    }
  });
});

describe('panelConformance — §8.2 row actions are derived, not enumerated', () => {
  it('_isRowActionTarget derives from [data-row-action] (the allowlist stays dead)', () => {
    const m = /const _isRowActionTarget = [^;]+;/.exec(chat);
    assert.ok(m, '_isRowActionTarget not found');
    assert.ok(m[0].includes("closest('[data-row-action]')"), 'derivation replaced by something else');
    assert.ok(!m[0].includes('.rail-item-delete'), 'the class allowlist crept back — stamp data-row-action instead');
  });
  it('the known Rail action classes all stamp data-row-action', () => {
    for (const cls of ['rail-item-cases', 'rail-item-subtask', 'rail-item-wf', 'rail-item-preview', 'rail-item-delete']) {
      for (const m of [...chat.matchAll(new RegExp(`<button class="${cls}[" ]`, 'g'))]) {
        const tag = chat.slice(m.index, chat.indexOf('>', m.index));
        assert.ok(tag.includes('data-row-action'), `<button class="${cls}"> without data-row-action — it will also select the row`);
      }
    }
  });
});

describe('panelConformance — advisories (warn, not fail)', () => {
  it('surveys copy that tells the user to re-type a command (should be zero doors-by-typing)', () => {
    const hits = [...chat.matchAll(/[Rr]e-type `/g)].length;
    if (hits > 0) console.warn(`  [advisory] ${hits} "re-type \`…\`" copy string(s) remain — views should re-open themselves (§2.2)`);
  });
  it('surveys emoji in icon-button labels outside the registry', () => {
    const hits = [...chat.matchAll(/_mkBtn\('[▶⚡⏱📜🗑]/g)].length;
    if (hits > 0) console.warn(`  [advisory] ${hits} emoji-chrome button(s) remain — migrate to _mkIconBtn (§5)`);
  });
});
