/**
 * @file ProcedureBuilder.js
 * @module Services/ProcedureBuilder
 * @version 2.19.0
 *
 * Transforms a Trace (Layer 1 — raw walk output) into a Procedure (Layer 2 —
 * runtime-executable step list). Applies deterministic refactoring rules:
 *
 *   - Deduplicate consecutive identical steps
 *   - Insert WAIT_FOR before every CLICK using the click's selector
 *   - Insert BLUR after every TYPE (except when followed by autocomplete WAIT_FOR)
 *   - Insert WAIT_FOR_GONE + WAIT_FOR between CLICKs that trigger transitions
 *   - Rewrite brittle Angular-generated IDs to structural patterns
 *   - Consolidate consecutive WAITs
 *   - Drop WAITs that precede a WAIT_FOR on the same region
 *
 * The builder is pure — given the same trace and rule set, produces the same
 * procedure. Re-runnable whenever rules improve.
 */

import { Logger } from '../Core/Logger.js';

export class ProcedureBuilder {
  /**
   * Build a Procedure from a Trace.
   * @param {Object} trace - { rawJson, fillerValues, ... }
   * @param {Object} [options] - Build options (reserved for future use)
   * @returns {{ rawJson: string, meta: Object, changes: string[] }}
   */
  static build(trace, options = {}) {
    if (!trace?.rawJson) {
      throw new Error('ProcedureBuilder.build: trace.rawJson is required');
    }

    const original = JSON.parse(trace.rawJson);
    const changes  = [];

    // Pass 5b — detect branch-annotated Trace. A step with `_branch` belongs
    // to a named branch; trunk steps have no `_branch` field. If any step is
    // branched, we build a tree Procedure (DETECT node); otherwise the
    // original linear pipeline runs unchanged (zero regression).
    const hasBranches = Array.isArray(original) && original.some(s => s && typeof s === 'object' && s._branch);

    if (hasBranches) {
      return ProcedureBuilder.#buildBranchedProcedure(original, trace, options);
    }

    // Rule passes — each returns { steps, changes } and is independently testable
    let steps = [...original];

    // Pass 1 — Deduplicate consecutive identical steps
    const dedup = ProcedureBuilder.#deduplicateConsecutive(steps);
    steps = dedup.steps;
    changes.push(...dedup.changes);

    // Pass 2 — Insert WAIT_FOR before every CLICK using the click's selector
    const waitBefore = ProcedureBuilder.#insertWaitForBeforeClick(steps);
    steps = waitBefore.steps;
    changes.push(...waitBefore.changes);

    // Pass 3 — Insert BLUR after every TYPE (skipping autocomplete patterns)
    const blurAfter = ProcedureBuilder.#insertBlurAfterType(steps);
    steps = blurAfter.steps;
    changes.push(...blurAfter.changes);

    // Pass 4 — Insert WAIT_FOR_GONE between consecutive CLICKs on the same
    // selector — confirms page transition started before next WAIT_FOR
    const waitGone = ProcedureBuilder.#insertWaitForGone(steps);
    steps = waitGone.steps;
    changes.push(...waitGone.changes);

    // Pass 5 — Rewrite framework-generated IDs to stable structural patterns
    const stable = ProcedureBuilder.#rewriteBrittleSelectors(steps);
    steps = stable.steps;
    changes.push(...stable.changes);

    // Pass 6 — Consolidate consecutive WAITs and drop redundant WAIT-before-WAIT_FOR
    const consolidated = ProcedureBuilder.#consolidateWaits(steps);
    steps = consolidated.steps;
    changes.push(...consolidated.changes);

    // Extract params from the final step list
    const paramSet = new Set();
    steps.forEach(s => {
      for (const m of (s.value ?? '').matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) paramSet.add(m[1]);
    });

    // Re-number steps sequentially regardless of what rules did
    steps = steps.map((s, i) => ({ ...s, step: i + 1 }));

    const rawJson = JSON.stringify(steps);
    const meta    = {
      groundType : 'task',
      params     : [...paramSet],
      stepCount  : steps.length,
      originalCount: original.length,
      sourceTrace: trace.walkedAt ?? null,
      builderVersion: "2.6.7",
      changes,
    };

    Logger.info('ProcedureBuilder', `Built procedure — ${original.length} trace steps → ${steps.length} procedure steps, ${changes.length} transformations`, {
      changes: changes.slice(0, 10),
    });

    return { rawJson, meta, changes };
  }

  /**
   * Pass 5b — Build a branched Procedure from a branch-annotated Trace.
   *
   * Trace layout after a Fork-enabled Walk:
   *   [ trunk steps... , branched steps... ]
   * Each branched step carries `_branch: "label"`. Trunk steps have no
   * `_branch` field. All branch-tagged steps share the same fork point —
   * the first step index with a `_branch` annotation.
   *
   * Output: a tree Procedure. Trunk steps are flat at the top; a DETECT
   * node follows, containing one body per branch. Each body's steps run
   * through the six refactoring rules independently.
   *
   * Conditions for the DETECT branches are filled in post-build by
   * AnthropicService.generateDetectConditions. This method emits the node
   * with stub conditions ({ type: 'selector_present', selector: '' });
   * the caller replaces them with real conditions before persisting.
   *
   * @private
   * @returns {{ rawJson: string, meta: Object, changes: string[] }}
   */
  static #buildBranchedProcedure(original, trace, options) {
    const changes = [];

    // Partition into trunk + named branches
    const trunk     = [];
    const byBranch  = new Map();   // label → array of steps
    for (const s of original) {
      if (s._branch) {
        if (!byBranch.has(s._branch)) byBranch.set(s._branch, []);
        byBranch.get(s._branch).push(s);
      } else {
        trunk.push(s);
      }
    }
    changes.push(`detected ${byBranch.size} branch(es): ${[...byBranch.keys()].join(', ')}`);

    // Apply rule pipeline to a step array (reused for trunk + each branch)
    const applyRules = (steps, label) => {
      const local = [];
      let cur     = [...steps].map(s => { const { _branch: _drop, ...rest } = s; return rest; });

      const r1 = ProcedureBuilder.#deduplicateConsecutive(cur);      cur = r1.steps; local.push(...r1.changes);
      const r2 = ProcedureBuilder.#insertWaitForBeforeClick(cur);    cur = r2.steps; local.push(...r2.changes);
      const r3 = ProcedureBuilder.#insertBlurAfterType(cur);         cur = r3.steps; local.push(...r3.changes);
      const r4 = ProcedureBuilder.#insertWaitForGone(cur);           cur = r4.steps; local.push(...r4.changes);
      const r5 = ProcedureBuilder.#rewriteBrittleSelectors(cur);     cur = r5.steps; local.push(...r5.changes);
      const r6 = ProcedureBuilder.#consolidateWaits(cur);            cur = r6.steps; local.push(...r6.changes);

      // Renumber locally so each branch's step indices start at 1
      cur = cur.map((s, i) => ({ ...s, step: i + 1 }));
      changes.push(...local.map(c => `[${label}] ${c}`));
      return cur;
    };

    const trunkProcessed = applyRules(trunk, 'trunk');
    const branchNodes    = [];
    for (const [label, steps] of byBranch) {
      const branchSteps = applyRules(steps, label);
      branchNodes.push({
        label,
        // Stub condition — replaced by condition synthesis post-build
        condition: { type: 'selector_present', selector: '' },
        body     : branchSteps,
      });
    }

    // Assemble the tree: trunk steps followed by a DETECT node. The resulting
    // array IS the Procedure root (Pass 3 allows trunk-as-array with embedded
    // tree nodes); SchemaValidator handles this shape.
    const detectNode = {
      type     : 'DETECT',
      branches : branchNodes,
    };
    const tree = [...trunkProcessed, detectNode];

    // Extract params from every step across trunk + branches
    const paramSet = new Set();
    const visit = (node) => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== 'object') return;
      if (node.type === 'DETECT') { (node.branches ?? []).forEach(b => visit(b.body)); return; }
      if (node.type === 'FOR_EACH') { visit(node.body); return; }
      if (node.type === 'SEQUENCE') { visit(node.body); return; }
      for (const m of (node.value ?? '').matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) paramSet.add(m[1]);
    };
    visit(tree);

    const rawJson = JSON.stringify(tree);
    const meta    = {
      groundType    : 'task',
      params        : [...paramSet],
      stepCount     : trunkProcessed.length, // trunk steps before DETECT
      branchCount   : branchNodes.length,
      branches      : branchNodes.map(b => b.label),
      originalCount : original.length,
      sourceTrace   : trace.walkedAt ?? null,
      builderVersion: '2.6.7',
      changes,
      // Flag for downstream callers: conditions are stubs awaiting synthesis
      needsConditionSynthesis: true,
    };

    Logger.info('ProcedureBuilder', `Built branched procedure — ${trunk.length} trunk + ${branchNodes.length} branch(es), ${changes.length} transformations`);

    return { rawJson, meta, changes };
  }

  /**
   * Rule: consolidate consecutive WAITs and drop WAITs that precede a WAIT_FOR.
   *
   * Three transformations:
   *   1. Consecutive WAITs → single WAIT with summed duration
   *   2. WAIT immediately before WAIT_FOR → drop the WAIT (WAIT_FOR polls itself)
   *   3. WAIT with value "0" or empty → drop
   *
   * Autocomplete WAITs are preserved — these are TYPE → WAIT → WAIT_FOR patterns
   * where the WAIT intentionally delays before polling, giving the autocomplete
   * time to trigger. Detected by the preceding step being TYPE.
   *
   * @private
   * @param {Array} steps
   * @returns {{ steps: Array, changes: string[] }}
   */
  static #consolidateWaits(steps) {
    const out     = [];
    const changes = [];

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];

      if (s.action !== 'WAIT') { out.push(s); continue; }

      const ms = parseInt(s.value, 10) || 0;
      if (ms <= 0) {
        changes.push(`consolidate-waits: dropped zero-duration WAIT`);
        continue;
      }

      // Consolidate with previous WAIT if present
      const prev = out[out.length - 1];
      if (prev?.action === 'WAIT') {
        const combined = (parseInt(prev.value, 10) || 0) + ms;
        changes.push(`consolidate-waits: merged WAIT ${prev.value} + WAIT ${s.value} = ${combined}`);
        out[out.length - 1] = { ...prev, value: String(combined) };
        continue;
      }

      // Drop WAIT-before-WAIT_FOR UNLESS it's an autocomplete delay
      // (autocomplete pattern: prev step was TYPE, next is WAIT_FOR on a
      // different selector — the WAIT gives autocomplete time to render)
      const next = steps[i + 1];
      if (next?.action === 'WAIT_FOR') {
        const isAutocompleteDelay =
          prev?.action === 'TYPE' &&
          next.selector !== prev.selector;
        if (!isAutocompleteDelay) {
          changes.push(`consolidate-waits: dropped WAIT ${s.value} before WAIT_FOR "${(next.selector || '').slice(0, 40)}"`);
          continue;
        }
      }

      out.push(s);
    }

    return { steps: out, changes };
  }

  /**
   * Rule: rewrite framework-generated brittle IDs to stable structural patterns.
   *
   * Frameworks that auto-increment IDs per component instance (Angular, Material,
   * CDK overlays) produce selectors like "#ngb-typeahead-17-0" that vary across
   * sessions. This rule detects known patterns and rewrites them to attribute
   * selectors that survive the counter variation.
   *
   * Known patterns:
   *   #ngb-typeahead-N-M     → [id^='ngb-typeahead-'][id$='-M']
   *   #mat-option-N          → [id^='mat-option-']
   *   #mat-autocomplete-N    → [id^='mat-autocomplete-']
   *   #cdk-overlay-N         → [id^='cdk-overlay-']
   *   #mat-select-N          → [id^='mat-select-']
   *
   * For #ngb-typeahead-N-M the trailing digit (M) is preserved because it
   * identifies which suggestion in the list (0 = first, 1 = second, etc).
   *
   * @private
   * @param {Array} steps
   * @returns {{ steps: Array, changes: string[] }}
   */
  static #rewriteBrittleSelectors(steps) {
    const changes = [];

    const patterns = [
      // #ngb-typeahead-17-0 → [id^='ngb-typeahead-'][id$='-0']
      { re: /^#ngb-typeahead-\d+-(\d+)$/, replace: (m) => `[id^='ngb-typeahead-'][id$='-${m[1]}']`, name: 'ngb-typeahead' },
      // #mat-option-17 → [id^='mat-option-']
      { re: /^#mat-option-\d+$/,          replace: ()  => `[id^='mat-option-']`,                   name: 'mat-option' },
      // #mat-autocomplete-17 → [id^='mat-autocomplete-']
      { re: /^#mat-autocomplete-\d+$/,    replace: ()  => `[id^='mat-autocomplete-']`,             name: 'mat-autocomplete' },
      // #cdk-overlay-17 → [id^='cdk-overlay-']
      { re: /^#cdk-overlay-\d+$/,         replace: ()  => `[id^='cdk-overlay-']`,                  name: 'cdk-overlay' },
      // #mat-select-17 → [id^='mat-select-']
      { re: /^#mat-select-\d+$/,          replace: ()  => `[id^='mat-select-']`,                   name: 'mat-select' },
      // #mat-tab-label-17-0 → [id^='mat-tab-label-'][id$='-0']
      { re: /^#mat-tab-label-\d+-(\d+)$/, replace: (m) => `[id^='mat-tab-label-'][id$='-${m[1]}']`, name: 'mat-tab-label' },
      // #a11y-N → [id^='a11y-']   (some component libs)
      { re: /^#a11y-\d+$/,                replace: ()  => `[id^='a11y-']`,                         name: 'a11y' },
    ];

    const rewriteOne = (selector) => {
      if (!selector) return selector;
      for (const p of patterns) {
        const m = selector.match(p.re);
        if (m) {
          const replaced = p.replace(m);
          return { replaced, name: p.name };
        }
      }
      return null;
    };

    const out = steps.map(s => {
      if (!s.selector) return s;
      const r = rewriteOne(s.selector);
      if (!r) return s;
      changes.push(`stable-selector: ${s.action} "${s.selector}" → "${r.replaced}" (${r.name})`);
      return { ...s, selector: r.replaced };
    });

    return { steps: out, changes };
  }

  /**
   * Rule: insert WAIT_FOR_GONE after CLICKs that are followed (eventually) by
   * another CLICK on the same selector. This indicates a wizard-style flow
   * where the same button ID appears on consecutive pages — WAIT_FOR_GONE
   * confirms the current page's button has disappeared before the next
   * WAIT_FOR polls for the next page's button.
   *
   * Only inserts when the same selector is clicked again later in the steps,
   * since that's the only case where WAIT_FOR needs help distinguishing pages.
   *
   * @private
   * @param {Array} steps
   * @returns {{ steps: Array, changes: string[] }}
   */
  static #insertWaitForGone(steps) {
    const out         = [];
    const changes     = [];
    const DEFAULT_TIMEOUT = '5000';

    // Build a lookup of future CLICK selectors for each index
    const clickSelectorsAfter = steps.map((_, i) =>
      new Set(
        steps.slice(i + 1)
          .filter(s => s.action === 'CLICK' && s.selector?.trim())
          .map(s => s.selector)
      )
    );

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      out.push(s);

      if (s.action !== 'CLICK' || !s.selector?.trim()) continue;

      // Only insert WAIT_FOR_GONE if the same selector is clicked again later
      if (!clickSelectorsAfter[i].has(s.selector)) continue;

      // Skip if the next step is already a WAIT_FOR_GONE on this selector
      const next = steps[i + 1];
      if (next?.action === 'WAIT_FOR_GONE' && next.selector === s.selector) continue;

      out.push({
        action  : 'WAIT_FOR_GONE',
        selector: s.selector,
        value   : DEFAULT_TIMEOUT,
        step    : 0,
      });
      changes.push(`wait-for-gone: inserted after CLICK "${s.selector.slice(0, 40)}" — same selector clicked again later`);
    }
    return { steps: out, changes };
  }

  /**
   * Rule: insert BLUR after every TYPE on the same selector.
   * Commits form values to Angular/React/Vue reactive form models.
   * Skips two cases:
   *   - A BLUR on the same selector already follows (within 2 steps)
   *   - Autocomplete pattern detected: next TYPE is followed by a CLICK on a
   *     distinctive autocomplete-suggestion selector. For these the BLUR
   *     should go AFTER the suggestion CLICK, not immediately after TYPE.
   * @private
   * @param {Array} steps
   * @returns {{ steps: Array, changes: string[] }}
   */
  static #insertBlurAfterType(steps) {
    const out     = [];
    const changes = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      out.push(s);
      if (s.action !== 'TYPE' || !s.selector || !s.selector.trim()) continue;

      // Lookahead: already has BLUR on same selector in next 2 steps?
      const next1 = steps[i + 1];
      const next2 = steps[i + 2];
      const alreadyBlurred =
        (next1?.action === 'BLUR' && next1.selector === s.selector) ||
        (next2?.action === 'BLUR' && next2.selector === s.selector);
      if (alreadyBlurred) continue;

      // Autocomplete detection: look ahead a few steps for a CLICK on a
      // suggestion-like selector. If found, skip BLUR here — it should be
      // inserted after the suggestion CLICK (handled by an autocomplete-aware
      // pass, or the user will add it manually).
      const isAutocompleteAhead = ProcedureBuilder.#isAutocompletePattern(steps, i);
      if (isAutocompleteAhead) {
        changes.push(`blur-after-type: skipped BLUR after TYPE "${s.selector.slice(0, 40)}" — autocomplete pattern detected`);
        continue;
      }

      out.push({
        action  : 'BLUR',
        selector: s.selector,
        value   : '',
        step    : 0,
      });
      changes.push(`blur-after-type: inserted BLUR after TYPE "${s.selector.slice(0, 40)}"`);
    }
    return { steps: out, changes };
  }

  /**
   * Detects if a TYPE step at index i is IMMEDIATELY followed by an autocomplete
   * pattern: WAIT (or WAIT_FOR) then CLICK on a suggestion-like selector.
   * Only considers the next 1-3 steps — further ahead means the autocomplete
   * belongs to a different field.
   * @private
   */
  static #isAutocompletePattern(steps, typeIdx) {
    // Must have WAIT or WAIT_FOR immediately after TYPE (gives autocomplete time to render)
    const next = steps[typeIdx + 1];
    if (!next || (next.action !== 'WAIT' && next.action !== 'WAIT_FOR')) return false;

    // Within 2 more steps, expect a CLICK on a suggestion-like selector
    for (let j = typeIdx + 2; j < Math.min(steps.length, typeIdx + 4); j++) {
      const s = steps[j];
      if (s.action === 'TYPE') return false; // different field — not an autocomplete
      if (s.action !== 'CLICK') continue;
      const sel = s.selector ?? '';
      if (/typeahead|suggest|autocomplete|mat-option|cdk-overlay/i.test(sel)) return true;
      if (/\[id[\^$]?=/.test(sel) && /-0'?\]/.test(sel))                       return true;
      return false; // CLICK but not on a suggestion — not autocomplete
    }
    return false;
  }

  /**
   * Rule: insert WAIT_FOR before every CLICK using the click's selector.
   * Prevents clicks from firing before the target element has rendered.
   * Skips if the preceding step is already a WAIT_FOR on the same selector,
   * or a WAIT_FOR_GONE (which is typically followed by its own WAIT_FOR).
   * Skips CLICKs with empty selectors.
   * @private
   * @param {Array} steps
   * @returns {{ steps: Array, changes: string[] }}
   */
  static #insertWaitForBeforeClick(steps) {
    const out        = [];
    const changes    = [];
    const DEFAULT_TIMEOUT = '10000';
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.action === 'CLICK' && s.selector && s.selector.trim()) {
        const prev = out[out.length - 1];
        const alreadyGuarded =
          (prev?.action === 'WAIT_FOR' && prev.selector === s.selector) ||
          prev?.action === 'WAIT_FOR_GONE';
        if (!alreadyGuarded) {
          out.push({
            action  : 'WAIT_FOR',
            selector: s.selector,
            value   : DEFAULT_TIMEOUT,
            step    : 0, // re-numbered at the end
          });
          changes.push(`wait-before-click: inserted WAIT_FOR "${s.selector.slice(0, 40)}" before step ${s.step}`);
        }
      }
      out.push(s);
    }
    return { steps: out, changes };
  }

  /**
   * Rule: remove consecutive identical steps.
   * Two steps are "identical" if they share action, selector, and value.
   *
   * CLICK duplicates are NOT auto-dropped because wizard flows legitimately
   * have multiple Continue clicks on the same selector. Instead, they're
   * flagged in changes so the user can review and manually remove retries.
   *
   * Other duplicates (WAIT, WAIT_FOR, EXTRACT, SELECT, TYPE, BLUR) are dropped.
   *
   * @private
   * @param {Array} steps
   * @returns {{ steps: Array, changes: string[] }}
   */
  static #deduplicateConsecutive(steps) {
    const out     = [];
    const changes = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const prev = out[out.length - 1];
      const isDuplicate = prev && prev.action === s.action && prev.selector === s.selector && (prev.value ?? '') === (s.value ?? '');

      if (!isDuplicate) { out.push(s); continue; }

      if (s.action === 'CLICK') {
        // Keep CLICK duplicates — may be wizard pattern — but flag for review
        out.push(s);
        changes.push(`review-click: consecutive duplicate CLICK "${(s.selector || '').slice(0, 40)}" preserved — may be retry loop, review manually`);
      } else {
        changes.push(`dedup: dropped duplicate ${s.action} "${(s.selector || '').slice(0, 40)}"`);
      }
    }
    return { steps: out, changes };
  }
}
