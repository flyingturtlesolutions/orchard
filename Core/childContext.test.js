// Core/childContext.test.js — CV-4-reduce: rendering an app's own sub-tasks into an LLM block. node --test. PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderSubTasksBlock } from './childContext.js';

describe('renderSubTasksBlock — the <SUB_TASKS> data block', () => {
  it('renders one row per child (title + status + latest-result peek), fenced as data', () => {
    const block = renderSubTasksBlock([
      { title: '#64775 Switches no longer working', status: 'done', summary: 'Billing dispute — refund issued.' },
      { title: '#64776 App crash', status: 'needs-you', summary: 'Drafted a reply; awaiting your approval.' },
    ]);
    assert.match(block, /<SUB_TASKS/);
    assert.match(block, /- #64775 Switches no longer working \[done\] — Billing dispute/);
    assert.match(block, /- #64776 App crash \[needs-you\] — Drafted a reply/);
    assert.match(block, /<\/SUB_TASKS>/);
  });

  it('omits status/peek when absent; a child with neither title nor summary is dropped', () => {
    const block = renderSubTasksBlock([{ title: 'just a title' }, { status: 'idle' }, {}]);
    assert.match(block, /- just a title/);
    assert.doesNotMatch(block, /\[/);                 // no status bracket rendered
    assert.equal(block.split('\n').filter((l) => l.startsWith('- ')).length, 1, 'only the titled child renders');
  });

  it('empty / non-array / all-blank → "" (caller omits the block)', () => {
    assert.equal(renderSubTasksBlock([]), '');
    assert.equal(renderSubTasksBlock(null), '');
    assert.equal(renderSubTasksBlock([{}, { foo: 1 }]), '');
  });

  it('caps at 50 rows with a "+N more" note (no silent truncation)', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ title: `child ${i}` }));
    const block = renderSubTasksBlock(many);
    const rows = block.split('\n').filter((l) => l.startsWith('- '));
    assert.equal(rows.length, 51);                    // 50 + the "…and N more"
    assert.match(block, /…and 10 more/);
  });
});
