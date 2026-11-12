# @graftsync/adapter-patch

## 0.2.4

### Patch Changes

`graft capture` works for Cargo, Go and PyPI grafts.

- cargo: captures the copy cargo builds, the vendored crate after `graft apply` (or the registry source); `target/` and `.cargo-ok` are ignored.
- go: captures the module's replacement directory, the vendored module after `graft apply` or any directory a `replace` points at. The read-only module cache is refused with `capture/read-only`, saying where to edit instead. Variant files are named `v0.11.0.patch`, not `vv0.11.0.patch`.
- pypi: captures the wheel's own files in site-packages (its top-level packages and modules, including files added there), never the rest of site-packages, `.dist-info`, `.data` or `__pycache__`.
- In every ecosystem, capture refuses an installed copy that is exactly pristine + the selected variant (`capture/no-changes`), instead of registering a duplicate of that variant.
- Updated dependencies [34a5106]
  - @graftsync/core@0.2.4
  - @graftsync/spec@0.2.4

## 0.2.3

### Patch Changes

Patch grafts for Rust crates, Go modules and Python packages (#26).

- `rootstock.ecosystem` (`npm` by default, so existing grafts are unchanged; `cargo`, `go`, `pypi`), with `frontmatter/unknown-ecosystem` for anything else. Versions and ranges use the ecosystem's scheme: semver for npm, cargo and go (the `v` optional), PEP 440 for pypi.
- cargo: the published `.crate` is the pristine artifact; the `cargo-vendor` applier commits the patched crate under `.grafts/.vendor/` and adds `[patch.crates-io]`, and `graft check` fails on `[[patch.unused]]`, which cargo only warns about.
- go: the module cache's verified copy is the pristine artifact; the `go-replace` applier commits the patched module and sets a version-qualified `replace` (go.mod or go.work), and `graft check` fails when the go command ignores it.
- pypi: the published wheel is the pristine artifact; the `wheel-vendor` applier commits the patched wheel and points `[tool.uv.sources]` (uv) or the requirements file (pip) at it, reinstalling so that neither tool keeps a stale copy silently. Poetry isn't supported yet.
- `graft add --ecosystem` and `graft sync --ecosystem`, per-ecosystem options under `ecosystems` in `.grafts/config.json`, and `mechanisms.patch.applier` per ecosystem. Reports and `outdated` carry the ecosystem. The `fork` mechanism's package mode stays npm only (`fork/ecosystem`).
- Updated dependencies [9572014]
  - @graftsync/spec@0.2.3
  - @graftsync/core@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [6dd050f]
  - @graftsync/core@0.2.2
  - @graftsync/spec@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [275c71b]
  - @graftsync/core@0.2.1
  - @graftsync/spec@0.2.1

## 0.2.0

### Minor Changes

**Breaking:** Graft no longer runs an oracle. `graft sync` checks that each graft still fits (anchors, apply) and installs, and records it; verifying behavior is the agent's job, with the project's own tests.

- The `oracle` frontmatter field is gone. An existing `oracle:` block is ignored with the warning `frontmatter/oracle-ignored`: move the check into the project's tests and say under Invariants which tests cover each one.
- `graft verify` is removed, and `graft add` no longer scaffolds `oracle.mjs` (or takes `--modes`). `runOracle` is gone from core; `runCommand` now lives in `command.ts`.
- Sync reports no oracle output; a standalone (repo-mode) graft's result is reported as `materialized` (with a `fetch` ref) instead of under `oracle`.
- The graft-sync skill makes verification explicit: prove every Invariant with the project's tests before recording a variant, add a test where none covers one, never weaken a test.
- The GitHub Action's PRs say Graft checked fit, not behavior, and its agent prompts ask the agent to verify the Invariants with the project's tests and report how.
- Fix: `graft check` fails on an invalid graft instead of silently skipping it (it reported only valid grafts, so CI passed).

### Patch Changes

- Updated dependencies [be04dca]
  - @graftsync/core@0.2.0
  - @graftsync/spec@0.2.0

## 0.1.2

### Patch Changes

- `graft capture <id>`: write your edit of the installed package as the graft's variant (the diff against the published package). It replaces the untouched scaffold stub, or adds a new variant once a real one exists, and keeps it only if it applies to the pristine version.
- Smaller install: pristine packages are fetched with the project's own npm (`npm pack`, `npm view`, honoring its `.npmrc`) instead of pacote. `@graftsync/cli` now installs 18 packages instead of 103.
- The graft-sync skill covers browser oracles: fail on console errors and 5xx responses too, since frameworks catch errors and only log them.
- Updated dependencies [3a0ffbb]
  - @graftsync/core@0.1.2
  - @graftsync/spec@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @graftsync/core@0.1.1
  - @graftsync/spec@0.1.1
