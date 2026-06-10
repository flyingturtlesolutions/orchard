// runner.mjs — imports each test file (argv), then runs the collected suite tree via the shim.
// The loader rewrites `node:test` → shim.mjs, so the test files' registrations and our __run()
// share one module instance. Exit code reflects pass/fail.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { __run } from 'node:test';   // ← rewritten to the shim by loader.mjs

// CR-I1 (v2.74.926) — expand simple one-level globs (`Core/*.test.js`) ourselves: `npm test` on Windows
// runs scripts via cmd.exe, which passes the pattern through literally (bash expanded it for us before).
function expandArg(a) {
  if (!a.includes('*')) return [a];
  const dir = path.dirname(a);
  const re = new RegExp('^' + path.basename(a).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  try { return readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f)); }
  catch { return []; }
}

const files = process.argv.slice(2).flatMap(expandArg);
if (!files.length) { console.error('usage: runner.mjs <test-file...>'); process.exit(2); }

for (const f of files) {
  const abs = path.isAbsolute(f) ? f : path.resolve(process.cwd(), f);
  try {
    await import(pathToFileURL(abs).href);
  } catch (e) {
    console.error('✗ failed to import', f);
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }
}

const { passed, failed, skipped, failures } = await __run();

for (const { full, err } of failures) {
  console.log('✗ ' + full);
  const msg = (err && err.message) ? err.message : String(err);
  console.log('    ' + msg.split('\n').join('\n    '));
  if (err && err.stack) {
    const frames = err.stack.split('\n').filter((l) => /\.test\.js|\/Core\/|\\Core\\/.test(l)).slice(0, 2);
    for (const fr of frames) console.log('    ' + fr.trim());
  }
}

const skipNote = skipped ? `, ${skipped} skipped` : '';
console.log(`\n${passed} passing, ${failed} failing${skipNote}`);
process.exit(failed ? 1 : 0);
