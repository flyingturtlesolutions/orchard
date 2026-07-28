// tools/trace-lint/lint.test.cjs — standalone self-test (plain assert, outside the npm glob — toolchain).
// Run: node tools/trace-lint/lint.test.cjs
'use strict';
const assert = require('assert');
const { lintText } = require('./lint.cjs');

// FOUNDING FIXTURE — the real 07-27 14:38 shape: a 121-division RIDE_EACH tally with NO terminal receipt.
const silent = [
  '14:38:35.443 DEBUG background           Message: INVOKE_SESSION',
  '14:38:35.644 INFO  ride                 INVOKE ▸ vendorsuite.drhorton.com GET [vs_warranty_tasks] → ok array[0]',
  '14:38:53.584 INFO  background           RIDE_EACH ▸ vs_warranty_tasks × 121 (1–121 of 121) → 121 ok, 0 failed, 13 row(s)',
  '14:45:39.616 DEBUG background           Message: WORKFLOW_PARKED',
].join('\n');
const v1 = lintText(silent);
assert.strictEqual(v1.length, 1, `expected exactly the ride-each violation, got ${JSON.stringify(v1)}`);
assert.strictEqual(v1[0].rule, 'ride-each-receipt');
assert.strictEqual(v1[0].line, 3);

// The same window WITH the v1856 receipt line → clean.
const healed = silent + '\n14:38:53.590 INFO  background           RIDE_EACH ▸ rendered 13 row(s) · 5/121 division group(s)';
assert.strictEqual(lintText(healed).length, 0, 'the rendered receipt heals the founding fixture');

// CROSS-TURN CONTAMINATION (the second live calibration): a LATER unrelated drill-open line must NOT absorb the
// fan's missing receipt — exactly how the real 175701 trace first linted clean (the 14:47 turn paid the 14:38 debt).
const contaminated = silent + '\n14:47:37.892 INFO  background           RIDE_DRILL ▸ vs_warranty_tasks → on-site open (match "4886921")';
assert.strictEqual(lintText(contaminated).length, 1, 'an unrelated turn must not pay the fan’s receipt debt');
// …while the fan's OWN drill-filter line is a legitimate receipt:
const drillFiltered = silent + '\n14:38:53.590 INFO  background           RIDE_DRILL ▸ vs_warranty_tasks each-filter "4886921" → 1 hit(s) in 1/5 division(s)';
assert.strictEqual(lintText(drillFiltered).length, 0);

// invoke-session: dispatch without any outcome line → flagged; with an INVOKE verdict → clean.
const dangling = 'x DEBUG background Message: INVOKE_SESSION\ny DEBUG background Message: PANEL_PING';
assert.strictEqual(lintText(dangling).length, 1);
assert.strictEqual(lintText(dangling)[0].rule, 'invoke-session-concludes');
const concluded = 'x DEBUG background Message: INVOKE_SESSION\ny INFO ride INVOKE ▸ admin.shopify.com POST [shopify_customer_by_email] → ok object{2}';
assert.strictEqual(lintText(concluded).length, 0);
// v2.74.1857 — the blocked family is a legal receipt (the gl 103120 catch: a bare early exit; every exit now
// names itself as `INVOKE ▸ blocked <error> …`).
const blocked = 'x DEBUG background Message: INVOKE_SESSION\ny INFO ride INVOKE ▸ blocked no-authenticated-tab @vendorsuite.drhorton.com [vs_warranty_tasks]';
assert.strictEqual(lintText(blocked).length, 0, 'a blocked exit is a receipt');

// interleaved same-rule spans resolve FIFO: two dispatches, two verdicts → clean; two dispatches, one → 1 flag.
const two = ['a Message: INVOKE_SESSION', 'b Message: INVOKE_SESSION', 'c INVOKE ▸ h GET [x] → ok', 'd INVOKE ▸ h GET [y] → ok'].join('\n');
assert.strictEqual(lintText(two).length, 0);
const twoOne = ['a Message: INVOKE_SESSION', 'b Message: INVOKE_SESSION', 'c INVOKE ▸ h GET [x] → ok'].join('\n');
assert.strictEqual(lintText(twoOne).length, 1);

// workflow replay without any receipt → flagged; BOTH real receipt shapes heal it:
// the 09:43 no-effect shape (SPAN skip + RUN backstop) and the 13:50 effectful shape (STEP ▸ 2/2 — the rule's
// first draft demanded RUN ▸ always and false-flagged two perfectly-narrated replays; calibrated on live traces).
const wfSilent = 'a WORKFLOW ▸ replay — 2 pinned · 0 from text';
assert.strictEqual(lintText(wfSilent).length, 1);
const wfHonest = wfSilent + '\nb SPAN ▸ STEP · SKIPPED · cause=no-bound-connection\nc RUN ▸ no-effect — nothing was created';
assert.strictEqual(lintText(wfHonest).length, 0);
const wfEffectful = wfSilent + '\nb STEP ▸ 2/2 fanout · rows 3→3 · cases 3 new/0 updated/0 skipped · ok';
assert.strictEqual(lintText(wfEffectful).length, 0, 'STEP ▸ is the effectful receipt');

// drive invoke: the 20:31 22s-silence shape → flagged; with the v1798 section-wait line → clean.
const drvSilent = 'a Message: INVOKE_DRIVE_ARTIFACT';
assert.strictEqual(lintText(drvSilent).length, 1);
const drvSpoke = drvSilent + '\nb DRIVE ▸ section-wait TIMEOUT (12s) — want=#warranty';
assert.strictEqual(lintText(drvSpoke).length, 0);

console.log('lint.test.cjs — all assertions passed');
