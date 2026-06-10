// loader.mjs — ESM hooks for Node 16:
//  • resolve: redirect `node:test` → our shim (Node 16 has no node:test).
//  • load:    force local `.js` files to load as ES modules (the repo authors ESM but, being a
//             browser extension, ships no package.json "type":"module", so Node would treat .js as CJS).
// Everything else (node:assert/strict, .mjs, .json) falls through to the defaults.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const shimUrl = new URL('./shim.mjs', import.meta.url).href;

export async function resolve(specifier, context, defaultResolve) {
  if (specifier === 'node:test' || specifier === 'test' || specifier === 'node:test/reporters') {
    return { url: shimUrl, shortCircuit: true };
  }
  return defaultResolve(specifier, context);
}

export async function load(url, context, defaultLoad) {
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module', source, shortCircuit: true };
  }
  return defaultLoad(url, context);
}
