# Test harness (CR-I1)

Runs the `Core/*.test.js` + `Services/*.test.js` suite on **Node 16** (this machine runs 16.15.1, which has
neither the `--test` runner nor the `node:test` builtin — both arrived in 16.17/18).

- `shim.mjs` — a tiny `node:test` stand-in: `describe`/`it`/hooks collect a suite tree; `__run()` executes it.
- `loader.mjs` — ESM hooks: redirects `node:test` imports to the shim, and force-loads the repo's `.js` files
  as ES modules (the extension authors ESM but ships no `"type": "module"`, so bare Node would parse `.js` as CJS).
- `runner.mjs` — imports each test file given on argv, runs the collected tree, prints `N passing, M failing`,
  exits non-zero on failure.

Run it:

```
npm test
```

(or directly: `node --experimental-loader ./tools/test-harness/loader.mjs ./tools/test-harness/runner.mjs Core/*.test.js Services/*.test.js`)

History: this harness lived in `%TEMP%\ahub-harness\` (outside the repo, one disk-cleanup from vanishing) until
v2.74.926. If the machine's Node ever moves to ≥18, `node --test` can replace all of this — the test files
import from `node:test` and need no changes.
