---
id: pacote-esm
rootstock:
  package: pacote
  verified: 22.0.1
mechanism: patch
targets:
  - package.json
  - lib/index.js
variants:
  - range: ">=22.0.1"
    module: ./variants/v22.patch
oracle:
  command: node .grafts/pacote-esm/oracle.mjs
  modes: [esm, cjs]
status: applied
---

## Why

pacote is CommonJS only. Its `module.exports` is also an object of inline arrow functions,
which Node's CommonJS export detection cannot see, so `import { extract } from 'pacote'`
is `undefined`. That trap caused a real bug in `@graft/core`. This graft converts pacote
itself to native ESM with real named exports. It is part of Graft's dogfood validation
(see semver-esm). pacote's own dependencies stay CommonJS; they are not part of this graft.

`@graft/core` still uses pacote's default import, because published consumers will not
have this patch.

## Invariants

- Every module of pacote itself (`lib/`, `bin/`) that loads, through `import` or
  `require()`, is evaluated as ESM.
- `import * as ns from 'pacote'` has a named export for every key of the public API. Each
  is identical to `default[key]` and to `require('pacote')[key]`, and `tarball.stream` and
  `tarball.file` still exist.
- Deep requires keep returning the old values: `require('pacote/lib/fetcher.js').get` is
  a function.
- The API works end to end on local specs. `manifest('file:<dir>')` returns the manifest.
  For a local tarball (`file:<pkg>.tgz`), `extract` writes its files and `tarball` returns a
  Buffer whose integrity matches `manifest()._integrity`. (Directory specs need an Arborist
  constructor to pack; that is pacote's own requirement, not this graft's.) The `pacote`
  CLI still runs as a program.

## Where to look

Every `.js` file in `lib/` (fetcher classes, `index.js` public API, `util/`) and
`bin/index.js`, which uses the `module === require.main` idiom to decide whether to run.
The package's version is read with `require('../package.json')` in `lib/registry.js`,
`lib/remote.js` and `bin/index.js`.

## Anchors

- `package.json#1`: inserts `"type": "module"` before the `"files"` array, so the hunk's
  context never includes `"version"`.
- Per file: its `require` lines and its `module.exports = …` statement. In `bin/index.js`,
  `require.main` is rewritten to a check of `process.argv[1]` against
  `import.meta.filename`, anchored on the `if (module === require.main)` line.

## History

- 2026-11-04: Supersedes the former `pacote-esm-named-exports` graft (2026-11-03), which
  only reshaped `module.exports` in `lib/index.js` so Node could detect named exports.
  That variant applied cleanly to every release from 18.0.5 to 22.0.1. Replaced by a
  full ESM conversion of pacote@22.0.1 (15 files converted).
  Replaying the full conversion across 20.0.0 to 22.0.0, it applies to 22.0.0 and 22.0.1.
  21.x misses the `lib/dir.js` hunks, because 22.0.0 rewrote the directory fetcher (it now
  requires an Arborist constructor).
