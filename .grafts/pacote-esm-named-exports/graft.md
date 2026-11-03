---
id: pacote-esm-named-exports
rootstock:
  package: pacote
  verified: 22.0.1
mechanism: patch
targets:
  - lib/index.js
variants:
  - range: ">=18.0.5"
    module: ./variants/v18.patch
oracle:
  command: node .grafts/pacote-esm-named-exports/oracle.mjs
  modes: [esm, cjs]
status: applied
---

## Why

pacote is CommonJS-only. Node exposes a CommonJS module's exports as named ESM
exports only when its `cjs-module-lexer` can statically detect them. pacote builds
`module.exports` from an object literal whose `resolve`, `extract`, `manifest` and
`packument` values are inline arrow functions, which the lexer does not detect. As a
result `import { extract } from 'pacote'` binds `undefined` and only the default import
works. That trap caused a real bug in `@graft/core`.

This graft is Graft's own dogfood validation: it keeps a real modification to a real
CommonJS upstream in sync through the sync loop. `@graft/core` itself still uses the
default import, because published consumers will not have this patch.

## Invariants

- In ESM, `import * as ns from 'pacote'` exposes every own key of the CommonJS
  `module.exports` object as a named export, including any keys upstream adds later.
- Each named export is the identical value (`===`) to the CommonJS property, and the
  default export is the CommonJS `module.exports` object itself.
- `require('pacote')` behaves exactly as upstream: same keys, and `tarball.stream` /
  `tarball.file` still exist.
- Deep requires such as `require('pacote/lib/fetcher.js')` keep working (no `exports`
  map is introduced).
- The named exports actually work: `manifest('file:<dir>')` resolves a local package's
  manifest through the named ESM binding.

## Where to look

The package's main entry module (`main` in pacote's package.json), at the very end:
the single statement that assigns `module.exports` and lists the public API (the
fetcher classes plus the `resolve` / `extract` / `manifest` / `packument` / `tarball`
helpers that each call `get(spec, opts)`).

## Anchors

- `lib/index.js#1`: the `module.exports = { … }` object literal, plus the three
  `tarball` lines just above it as leading context. The patch hoists the inline arrow
  functions into named `const`s and turns the object into shorthand properties, the
  form the lexer recognizes. This anchor is chosen because the public API list is the
  part pacote's maintainers change least. If upstream converts more helpers to
  variables (as it did for `tarball` in 18.0.5), the hunk stops matching and the sync
  loop hands the graft to an agent instead of silently skipping it.

## History

- 2026-11-03: Graft created against pacote@22.0.1. Replaying every release from 15.0.0
  onward: the v18 variant applies cleanly, with no line offset, to 18.0.5 through
  22.0.1. 18.0.4 and earlier define `tarball` inline in the export object and would
  need their own variant.
