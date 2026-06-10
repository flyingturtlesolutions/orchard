// shim.mjs — a tiny `node:test` stand-in for Node 16 (no built-in runner here).
// Provides describe/it/hooks; collects a suite tree; __run() executes it and reports.
// PURE test-harness glue — committed under tools/test-harness/ (CR-I1, v2.74.926); was in the OS temp dir.

const root = { name: '', tests: [], suites: [], before: [], after: [], beforeEach: [], afterEach: [], parent: null };
let current = root;

export function describe(name, fn) {
  const suite = { name, tests: [], suites: [], before: [], after: [], beforeEach: [], afterEach: [], parent: current };
  current.suites.push(suite);
  const prev = current;
  current = suite;
  try { if (fn) fn.call(suite); } finally { current = prev; }
}
describe.skip = function (name) { /* registered as skipped suite: just ignore */ };
describe.only = describe;

export function it(name, fn) { current.tests.push({ name, fn, skip: false }); }
it.skip = function (name, fn) { current.tests.push({ name, fn, skip: true }); };
it.todo = it.skip;
it.only = it;
export const test = it;

export function before(fn) { current.before.push(fn); }
export function after(fn) { current.after.push(fn); }
export function beforeEach(fn) { current.beforeEach.push(fn); }
export function afterEach(fn) { current.afterEach.push(fn); }

let passed = 0, failed = 0, skipped = 0;
const failures = [];

async function runSuite(suite, ancestorBeforeEach, ancestorAfterEach, prefix) {
  const beforeEachChain = [...ancestorBeforeEach, ...suite.beforeEach];           // outermost → innermost
  const afterEachChain = [...suite.afterEach, ...ancestorAfterEach];              // innermost → outermost
  for (const b of suite.before) await b();
  for (const t of suite.tests) {
    const full = (prefix ? prefix + ' › ' : '') + t.name;
    if (t.skip) { skipped++; continue; }
    try {
      for (const be of beforeEachChain) await be();
      await t.fn();
      passed++;
    } catch (e) {
      failed++;
      failures.push({ full, err: e });
    } finally {
      try { for (const ae of afterEachChain) await ae(); } catch { /* ignore afterEach errors */ }
    }
  }
  for (const child of suite.suites) {
    await runSuite(child, beforeEachChain, afterEachChain, (prefix ? prefix + ' › ' : '') + child.name);
  }
  for (const a of suite.after) await a();
}

export async function __run() {
  await runSuite(root, [], [], '');
  return { passed, failed, skipped, failures };
}

export default { describe, it, test, before, after, beforeEach, afterEach };
