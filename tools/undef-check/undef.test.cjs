// Verify the checker against the FOUR recorded bugs + false-positive traps.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkFile } = require('./undef.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undef-'));
const run = (name, src) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, src);
  return checkFile(p).findings.map((b) => b.name);
};

let fails = 0;
const expect = (label, got, wantIncludes, wantExcludes = []) => {
  const missing = wantIncludes.filter((w) => !got.includes(w));
  const extra = wantExcludes.filter((w) => got.includes(w));
  const ok = !missing.length && !extra.length;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (missing.length) console.log(`        did NOT catch: ${missing.join(', ')}`);
  if (extra.length) console.log(`        FALSE POSITIVE: ${extra.join(', ')}   (all flagged: ${got.join(', ')})`);
};

// ── the four recorded bugs ──────────────────────────────────────────────
expect('v1663 `_str` — no such helper in chat.js',
  run('a.js', `
import { foo } from './x.js';
async function _runBranchClause(br) {
  const cField = _str(br.field);
  return cField;
}
`), ['_str']);

expect('v1660 `INTENTS` — never imported',
  run('b.js', `
import { normalizeInterpretDecision } from './interpret.js';
function log(d) {
  const known = INTENTS.includes(d.intent);
  return known;
}
`), ['INTENTS']);

expect('v1663 `_str` inside a TEMPLATE HOLE (where the real ones were)',
  run('c.js', `
const x = 1;
function f(a) { return \`value: \${_missingHelper(a)} end\`; }
`), ['_missingHelper']);

expect('a typo\'d call',
  run('d.js', `
function realName() { return 1; }
function g() { return realNam(); }
`), ['realNam']);

// ── false-positive traps: each MUST stay silent ─────────────────────────
expect('imports of every form are bindings',
  run('e.js', `
import A from './a.js';
import { b, c as d } from './b.js';
import * as ns from './c.js';
console.log(A, b, d, ns);
`), [], ['A', 'b', 'c', 'd', 'ns']);

expect('destructuring, params, catch, class methods, arrows',
  run('f.js', `
const { alpha, beta: gamma } = obj0;
const [one, two] = arr0;
function h(p1, { p2 }, ...rest) { return p1 + p2 + rest.length; }
const arrow = (q1, q2) => q1 + q2;
const single = z => z * 2;
class K { constructor(m) { this.m = m; } meth(n) { return n; } }
try { h(1, {p2:2}); } catch (err) { console.log(err); }
console.log(alpha, gamma, one, two, arrow, single, K);
const obj0 = {}, arr0 = [];
`), [], ['alpha', 'beta', 'gamma', 'one', 'two', 'p1', 'p2', 'rest', 'q1', 'q2', 'z', 'm', 'n', 'err', 'K', 'obj0', 'arr0']);

expect('property access + object keys are not uses',
  run('g.js', `
const o = { key: 1, other: 2 };
console.log(o.key, o.other, o?.missingProp);
const s = { nested: { deep: 3 } };
console.log(s.nested.deep);
`), [], ['key', 'other', 'missingProp', 'nested', 'deep']);

expect('identifiers inside STRINGS and COMMENTS are not uses',
  run('h.js', `
// notAnIdentifier should be ignored
/* alsoNotReal here */
const s1 = 'stringGhost';
const s2 = "anotherGhost";
const s3 = \`templateGhost literal\`;
console.log(s1, s2, s3);
`), [], ['notAnIdentifier', 'alsoNotReal', 'stringGhost', 'anotherGhost', 'templateGhost']);

expect('regex literals are not scanned for identifiers',
  run('i.js', `
const re = /regexGhost[a-z]+/g;
const re2 = new RegExp('x');
const div = 10 / 2 / 1;
console.log(re, re2, div);
`), [], ['regexGhost']);

expect('globals and chrome APIs are known',
  run('j.js', `
chrome.storage.local.get('k');
document.querySelector('#x');
console.log(JSON.stringify({}), Math.max(1,2), Promise.resolve(), crypto.randomUUID());
setTimeout(() => {}, 10);
`), [], ['chrome', 'document', 'console', 'JSON', 'Math', 'Promise', 'crypto', 'setTimeout']);

console.log(`\n${fails === 0 ? 'ALL FIXTURES PASS' : fails + ' FIXTURE(S) FAILED'}`);
process.exit(fails ? 1 : 0);
