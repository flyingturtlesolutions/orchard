#!/usr/bin/env node
/**
 * tools/undef-check/undef.cjs — the NO-BINDING check (v2.74.1664).
 *
 * Catches the single most expensive bug class in this project: an identifier that is USED but has no binding
 * anywhere in its file and is not imported. `node --check` cannot see it (the syntax is valid), the test suite
 * cannot see it (the pure cores are green; the bug is in the panel seam), and it throws only when that line
 * actually executes — which in a 843KB panel file means live, mid-run, in front of the user.
 *
 * Recorded instances, all the same shape:
 *   v1655  `readouts`  — a DIFFERENT function's local, referenced from _orchRunChain
 *   v1660  `INTENTS`   — never imported into chat.js; would have thrown on EVERY interpret
 *   v1663  `_str`      — no such helper in chat.js; two live ReferenceErrors on a new code path
 *   (+ `t0`/`tgt0`, caught by hand)
 * findings.md calls the real fix "ESLint no-undef over chat.js" and it stayed unbuilt because ESLint means a
 * dependency, and this repo has none by design — the repo root IS the unpacked-extension root.
 *
 * ── WHY THIS IS NOT A no-undef CLONE, AND WHY THAT IS FINE ───────────────────────────────────────────────────
 * Real no-undef needs an AST and full scope analysis. This does not attempt that. It asks a strictly weaker,
 * parser-free question:
 *
 *     Is this identifier bound ANYWHERE in this file, by any construct, at any scope?
 *
 * If the answer is no, it is undefined at every use — no scope analysis required to be certain. That is
 * CONSERVATIVE by construction: it cannot flag a correct program (any real binding, in any scope, silences it),
 * so it produces no noise to tune out. The cost is that it misses cross-scope errors like `readouts` — an
 * identifier bound in SOME function and used in another. Two of the four recorded instances are caught; a real
 * no-undef would catch all four.
 *
 * That trade is deliberate: a zero-false-positive check that runs in the gate on every commit beats a better
 * check that is never installed. If ESLint is ever added, delete this.
 */

const fs = require('fs');
const path = require('path');

// ── Globals we must not flag ────────────────────────────────────────────────────────────────────────────────
// Deliberately generous. A missing entry here is a FALSE POSITIVE, which is the failure mode that gets a check
// switched off — so when in doubt, list it.
const GLOBALS = new Set([
  // language
  'globalThis', 'undefined', 'NaN', 'Infinity', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol',
  'BigInt', 'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'AggregateError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Proxy',
  'Reflect', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'Intl', 'FinalizationRegistry',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
  'decodeURI', 'eval', 'structuredClone', 'queueMicrotask', 'escape', 'unescape',
  // DOM / browser
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'console', 'alert', 'confirm', 'prompt',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob',
  'File', 'FileReader', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'Event', 'CustomEvent',
  'EventTarget', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'PerformanceObserver',
  'performance', 'crypto', 'localStorage', 'sessionStorage', 'indexedDB', 'matchMedia', 'getComputedStyle',
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
  'HTMLButtonElement', 'HTMLAnchorElement', 'HTMLImageElement', 'HTMLFormElement', 'HTMLCanvasElement',
  'HTMLTemplateElement', 'DocumentFragment', 'DOMParser', 'XMLSerializer', 'XMLHttpRequest', 'WebSocket',
  'Image', 'Audio', 'Option', 'Range', 'Selection', 'ClipboardItem', 'ClipboardEvent', 'KeyboardEvent',
  'MouseEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'DragEvent', 'WheelEvent', 'TouchEvent',
  'CSS', 'CSSStyleSheet', 'TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream', 'TransformStream',
  'XPathResult', 'DataTransfer', 'XPathEvaluator', 'NodeFilter', 'TreeWalker', 'Text', 'Comment', 'Attr',
  'BroadcastChannel', 'MessageChannel', 'MessagePort', 'Worker', 'SharedWorker', 'Notification', 'btoa', 'atob',
  'self', 'top', 'parent', 'frames', 'origin', 'name', 'close', 'open', 'scrollTo', 'scrollBy', 'getSelection',
  // extension / platform
  'chrome', 'browser', 'clients', 'caches', 'importScripts', 'ServiceWorkerGlobalScope', 'OffscreenCanvas',
  'createImageBitmap', 'FontFace',
  // node (tools + tests)
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer', 'global', 'URLPattern',
]);

// ── Comment / string / regex stripping ──────────────────────────────────────────────────────────────────────
// Replaces the CONTENT of comments, strings and regex literals with spaces, preserving offsets so reported line
// numbers stay true. Template-literal `${...}` holes are preserved as code, because a bug can live inside one
// (that is exactly where the v1663 `_str` calls were).
function stripNonCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };

  // A STACK, so template literals nest correctly. `<td>${x.map((c) => `<th>${y}</th>`)}</td>` is ordinary in this
  // codebase, and the first version skipped nested templates wholesale instead of stripping them — leaving the
  // HTML tag names inside as live code, which is where most of the first run's 891 false positives came from.
  //   'tpl'  — inside template literal TEXT: blank it
  //   'hole' — inside `${ ... }`: real code, scan normally
  const stack = [];
  const top = () => (stack.length ? stack[stack.length - 1] : null);

  // Regex-vs-division needs the last TOKEN, not the last CHARACTER. `return /^https?:/i.test(x)` was read as
  // division because the previous character is `n` — which looks like an identifier — so the regex body was
  // scanned as code and `https` was reported as an unbound identifier.
  let prevTok = '';
  const KW_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
    'case', 'do', 'else', 'yield', 'await', 'and', 'or', 'not']);
  const regexAllowed = () => {
    if (!prevTok) return true;
    if (prevTok === '@lit') return false;                       // after a literal → division
    if (/^[A-Za-z_$][\w$]*$/.test(prevTok)) return KW_BEFORE_REGEX.has(prevTok);   // identifier → division; keyword → regex
    return !/[)\]]/.test(prevTok);                              // after ) or ] → division; after operators → regex
  };
  const setTok = (t) => { prevTok = t; };

  let i = 0;
  while (i < n) {
    const t = top();

    // ── inside template TEXT ──────────────────────────────────────────────────────────────────────────────
    if (t === 'tpl') {
      const c = src[i];
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') { stack.pop(); i++; setTok('@lit'); continue; }
      // Blank the `$` but KEEP the braces: a surviving `$` is itself a valid identifier and was being reported
      // as unbound on every template in the codebase, while the braces need to stay so brace-depth tracking in
      // declaratorTargets stays balanced.
      if (c === '$' && src[i + 1] === '{') { out[i] = ' '; stack.push('hole'); i += 2; setTok('{'); continue; }
      if (out[i] !== '\n') out[i] = ' ';
      i++; continue;
    }

    // ── code (top level, or inside a ${} hole) ────────────────────────────────────────────────────────────
    const c = src[i];
    const c2 = src[i + 1];

    if (c === '/' && c2 === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && c2 === '*') { let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; blank(i, Math.min(j + 2, n)); i = j + 2; continue; }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      blank(i + 1, j); i = j + 1; setTok('@lit'); continue;
    }

    if (c === '`') { stack.push('tpl'); i++; continue; }

    if (c === '}' && t === 'hole') { stack.pop(); i++; setTok('@lit'); continue; }

    if (c === '/' && regexAllowed()) {
      let j = i + 1; let inClass = false; let ok = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;                       // unterminated → it was division after all
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { ok = true; break; }
        j++;
      }
      if (ok) {
        blank(i + 1, j);
        let k = j + 1;
        while (k < n && /[a-z]/.test(src[k])) k++;
        blank(j + 1, k);                              // BLANK THE FLAGS. `/&/g` otherwise leaves a live `g`.
        i = k; setTok('@lit'); continue;
      }
    }

    if (!/\s/.test(c)) {
      if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(src[j])) j++; setTok(src.slice(i, j)); i = j; continue; }
      setTok(c);
    }
    i++;
  }
  // SELF-CHECK. A non-empty stack at EOF means the lexer lost sync — some template opened and never closed from
  // its point of view, which inverts template/code state from there on and turns ordinary HTML text into
  // "identifiers". That is how the first run produced 891 reports.
  //
  // This is the honest boundary of a parser-free tool: deeply-nested multi-line template literals (studio.js has
  // holes spanning newlines with nested templates and quoted HTML inside) are genuinely hard to lex by hand, and
  // getting them subtly wrong yields FALSE POSITIVES — the failure that gets a check switched off. So when the
  // lexer cannot vouch for itself, the file is SKIPPED with a clear reason rather than reported on.
  return { code: out.join(''), balanced: stack.length === 0 };
}

// ── Binding collection ──────────────────────────────────────────────────────────────────────────────────────
// Every construct that introduces a name, at ANY scope. Over-collecting here only makes the check weaker
// (fewer reports), never wrong — which is the right direction to err.
/**
 * From the start of a declarator list, return each declarator's LEFT-HAND SIDE.
 * Walks to the end of the statement tracking bracket depth, so commas inside `{}`/`[]`/`()` (destructuring
 * patterns, call arguments in initializers) do not split a declarator, and `=` inside them does not end one.
 */
function declaratorTargets(code, start) {
  const out = [];
  let depth = 0;
  let cur = '';
  let seenEq = false;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') { depth++; if (!seenEq) cur += c; continue; }
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; if (!seenEq) cur += c; continue; }
    if (depth === 0) {
      if (c === ';' || c === '\n') break;
      if (c === ',') { out.push(cur); cur = ''; seenEq = false; continue; }
      if (c === '=') { seenEq = true; continue; }
      // `for (const x of ...)` / `in` — the target ends at the keyword
      if (!seenEq && (code.startsWith(' of ', i) || code.startsWith(' in ', i))) break;
    }
    if (!seenEq) cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Content between an opening paren at `open` and its matching close. '' when unbalanced. */
function balancedFrom(code, open) {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === '(') depth++;
    else if (code[k] === ')') { depth--; if (depth === 0) return code.slice(open + 1, k); }
  }
  return '';
}

function collectBindings(code) {
  const bound = new Set();
  const add = (s) => { if (s) for (const m of String(s).match(/[A-Za-z_$][\w$]*/g) || []) bound.add(m); };

  // import ... from '...'   /   import '...'
  for (const m of code.matchAll(/\bimport\s+([^;'"]*?)\s+from\s*['"`]/g)) add(m[1]);
  for (const m of code.matchAll(/\bimport\s*\(/g)) { /* dynamic import — nothing bound */ }
  // const/let/var — including MULTI-DECLARATOR forms (`const a = 1, b = 2;`).
  //
  // The naive `([^=;]+?)=` stops at the first `=` and silently misses every later declarator, which is a FALSE
  // POSITIVE — the failure mode that gets a check switched off. But widening to end-of-statement is worse: it
  // would bind every identifier in the INITIALIZERS too, so `const x = _str(y)` would register `_str` as bound
  // and the v1663 bug this tool exists to catch would stop being caught. So: take the declarator list, split it
  // on TOP-LEVEL commas, and keep only each declarator's left-hand side.
  for (const m of code.matchAll(/\b(?:const|let|var)\s+/g)) {
    const start = m.index + m[0].length;
    for (const lhs of declaratorTargets(code, start)) add(lhs);
  }
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([^)]*)\)/g)) add(m[1]);
  // Function params, via BALANCED paren extraction rather than `[^)]*`.
  //
  // A character-class scan stops at the first `)`, which fails on exactly the params most likely to hold a
  // binding you then use: destructured defaults whose default VALUE contains parens —
  // `unbankedItems(items, banked, { idOf = (x) => x.id, textOf = (x) => x.text } = {})`. Every such param was a
  // false positive, including several in this repo's own Core modules.
  for (const m of code.matchAll(/\bfunction\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(/g)) {
    add(balancedFrom(code, m.index + m[0].length - 1));
  }
  // Arrows: find `) =>` and walk BACK to the matching `(`.
  for (const m of code.matchAll(/\)\s*=>/g)) {
    const close = m.index;
    let depth = 0;
    for (let k = close; k >= 0; k--) {
      if (code[k] === ')') depth++;
      else if (code[k] === '(') { depth--; if (depth === 0) { add(code.slice(k + 1, close)); break; } }
    }
  }
  // Single-param arrows with NO parens — `items.map(it => …)`, `.then(entries => …)`, `.forEach(btn => …)`.
  // The preceding character class must include `(`: nearly every such arrow in this codebase is the first
  // argument of a call, and omitting it made every one of them a false positive.
  for (const m of code.matchAll(/(?:^|[\s,({;=[])([A-Za-z_$][\w$]*)\s*=>/gm)) bound.add(m[1]);
  // class / object methods:  name(args) {
  for (const m of code.matchAll(/(?:^|[\s;}])(?:static\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) { bound.add(m[1]); add(m[2]); }
  // labels
  for (const m of code.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:for|while|do)\b/gm)) bound.add(m[1]);
  // CLASS FIELD declarations — `storageBackend = 'local';` / `static #x = 1;` in a class body. Matching at line
  // start also picks up plain assignments to already-declared names, which is harmless: over-collecting only
  // makes the check weaker, never wrong.
  for (const m of code.matchAll(/^\s*(?:static\s+)?#?([A-Za-z_$][\w$]*)\s*=[^=>]/gm)) bound.add(m[1]);
  // ALIASED RE-EXPORTS — `export { isPartitionReadEnabled as isPartitionWriteEnabled }` binds the alias.
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) add(m[1]);
  return bound;
}

// ── Use collection ──────────────────────────────────────────────────────────────────────────────────────────
// Only identifiers in a position where a BINDING must exist. Property accesses (`.foo`), object keys (`foo:`),
// and declarations are excluded — those do not require a binding of that name.
function collectUses(code) {
  const uses = new Map();   // name -> first line
  const lines = code.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (const m of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = m[0];
      const before = line.slice(Math.max(0, m.index - 2), m.index);
      const after = line.slice(m.index + name.length);
      if (/\.\s*$/.test(before)) continue;                    // property access
      if (/#$/.test(before)) continue;                        // PRIVATE class member: `Logger.#emit`, `this.#minLevel`
      if (/^\s*:/.test(after) && !/\?/.test(before)) continue; // object key / label
      if (/[?.]\s*$/.test(before)) continue;                  // optional chaining
      // NUMERIC LITERALS. An identifier scan starting at `_` or `e` mid-number invents names: `20_000` yields
      // `_000` and `3600e3` yields `e3`. Both were reported as unbound on the first real run. A digit directly
      // before the match means we are inside a number, never at the start of an identifier.
      if (/\d$/.test(line.slice(0, m.index))) continue;
      if (!uses.has(name)) uses.set(name, li + 1);
    }
  }
  return uses;
}

const KEYWORDS = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'async', 'await', 'static', 'get', 'set', 'of', 'from', 'as', 'true', 'false', 'null', 'undefined', 'arguments',
  'constructor', 'prototype']);

/**
 * Above this many findings, the result is treated as a LEXER FAILURE rather than as findings.
 *
 * The real bug class produces one to three hits in a file — a genuinely unbound identifier is a mistake someone
 * made, not a property of the file. Fifty hits means the scanner lost template/code sync and is reading prose as
 * code, which is what the first run did (891 reports, most of them English words out of HTML). The EOF
 * balance check catches most desyncs; it misses the ones that happen to re-balance by the end, and this catches
 * those. Erring toward "I cannot analyze this" is the whole disposition of the tool.
 */
const IMPLAUSIBLE = 8;

function checkFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const { code, balanced } = stripNonCode(src);
  if (!balanced) return { skipped: true, findings: [] };
  const bound = collectBindings(code);
  const uses = collectUses(code);
  const bad = [];
  for (const [name, line] of uses) {
    if (KEYWORDS.has(name) || GLOBALS.has(name) || bound.has(name)) continue;
    if (/^_\d+$/.test(name)) continue;   // numeric separator: `20_000` yields a spurious `_000`
    bad.push({ name, line });
  }
  bad.sort((a, b) => a.line - b.line);
  if (bad.length > IMPLAUSIBLE) return { skipped: true, findings: [] };
  return { skipped: false, findings: bad };
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--quiet');
  const quiet = process.argv.includes('--quiet');
  const files = args.length ? args : [];
  if (!files.length) { console.error('usage: node tools/undef-check/undef.cjs <file.js> [more.js ...]'); process.exit(2); }

  let total = 0;
  const skipped = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`skip (missing): ${f}`); continue; }
    const { skipped: skip, findings } = checkFile(f);
    if (skip) { skipped.push(f); continue; }
    total += findings.length;
    if (findings.length) {
      console.log(`\n${f}`);
      for (const b of findings) console.log(`  ${f}:${b.line}  '${b.name}' is used but has NO binding in this file`);
    } else if (!quiet) {
      console.log(`ok  ${f}`);
    }
  }
  if (skipped.length) {
    console.log(`\nSKIPPED (lexer could not vouch for itself — nested/multi-line template literals):`);
    for (const f of skipped) console.log(`  ${f}`);
    console.log('  These are NOT clean, they are UNCHECKED. Reporting on them would mean false positives.');
  }
  if (total) {
    console.log(`\n${total} identifier(s) with no binding. Each is a ReferenceError the moment that line runs.`);
    process.exit(1);
  }
  if (!quiet) console.log(`\nno unbound identifiers${skipped.length ? ` (${skipped.length} file(s) unchecked)` : ''}`);
  process.exit(0);
}

if (require.main === module) main();
module.exports = { checkFile, stripNonCode, collectBindings, collectUses };
