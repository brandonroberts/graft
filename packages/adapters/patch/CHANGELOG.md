# @graftsync/adapter-patch

## 0.3.4

### Patch Changes

- Detect obsolete grafts whose variants still apply cleanly: default-on nearby-upstream-change detection (filtering version-only manifest bumps) and opt-in without-variant `probe` in `graft.md` (`graft sync --probe-obsolete`, Action `probe-obsolete`) (#98).
- Unwrap npm 12+ array-wrapped `npm view --json` output and fail loudly on empty or unexpected shapes so `graft outdated` never silently reports up-to-date (#99).
- Add customizable `pr-title` input to the GitHub Action and follow repository PR/issue guidelines (#101).
- Updated dependencies
  - @graftsync/core@0.3.4
  - @graftsync/spec@0.3.4

## 0.3.3

### Patch Changes

- 746f00b: Include transitive exact-version (`=<version>`, non-dev) lockstep dependencies from the same repository in `findCargoSiblings` (such as `serde_core` with `serde`), ignore dev-dependencies in `orderCargoUpdates`, and update patched Cargo crates and their siblings atomically in one `cargo update -p … --precise` call (#93).
- 7452f67: Verify nested `node_modules` copies in `graft check` / `graft sync` when using Graft's built-in `graft` applier (`graft apply --installed`): covered nested copies are verified against their matching variant (failing loudly if unpatched or unapplicable), and uncovered nested copies emit a warning (#87).
- c7eb007: Add transactional `WorkspaceSnapshot` rollback around `sync --install` (so failures in `beforeInstall`, `eco.install`, `afterInstall`, or post-install version verification never leave workspace manifests, package-manager config, lockfiles, or applier artifacts half-mutated) and unify workspace-scoped / multi-copy package resolution (`UpstreamSource.installed(pkg, { from, allowAmbiguous })`, `UpstreamSource.installedCopies`, `Project.installedCopies`, and `npmResolveFrom`) across `sync`, `checkInstalled`, `applyInstalled`, `siblings`, and `ecosystems/npm`.
- Updated dependencies [746f00b]
- Updated dependencies [0d49fad]
- Updated dependencies [47af9b4]
- Updated dependencies [c7eb007]
- Updated dependencies [08f9cfc]
  - @graftsync/core@0.3.3
  - @graftsync/spec@0.3.3

## 0.3.2

### Patch Changes

- 52333b5: Support opt-in version-pinned `patchedDependencies` keys (`mechanisms.patch.pinKeys: true` in `.grafts/config.json`) for the `pnpm` and `npm` (>= 12) patch appliers, and reject `allowUnusedPatches: true` / `allowNonAppliedPatches: true` in `pnpm` configs whenever keys are version-pinned (#83).
- Updated dependencies [724daa3]
  - @graftsync/core@0.3.2
  - @graftsync/spec@0.3.2

## 0.3.1

### Patch Changes

- bd3a743: Harden patch checks, release-age filtering, pnpm `packageExtensions`, scoped diffs, and CLI argument validation (from validating against `openclaw/openclaw`):
  
  - Enforce applier hunk offset limits (±20 lines for `pnpm`, `yarn`, and `patch-package`) in `checkAnchors` and `apply` so patches that drift past the package manager's search window report `needs-agent` instead of failing during install (#77).
  - Parse `.npmrc` `min-release-age-exclude[]`, let `pnpm-workspace.yaml` `minimumReleaseAge` / `minimumReleaseAgeExclude` govern over `.npmrc` when configured, and pass `npm_config_min_release_age=0` to read-only `npm pack` / `npm view` calls (#78).
  - Rename exact-pinned pnpm `packageExtensions` keys on upgrade, fail loudly (`install/package-extensions`) when a range-pinned key stops matching the target version, and warn in `graft check` when a stale version-pinned `packageExtensions` key matches no installed version (#79).
  - Match renamed content-hashed bundler chunks (e.g. `dist/chunks/cac.<hash>.js`) in `graft diff` so scoped diffs compare old→new chunks instead of dumping the entire file as deleted, and reject unknown CLI flags and unexpected positional arguments with exit code 2 (#80).
- Updated dependencies [bd3a743]
  - @graftsync/core@0.3.1
  - @graftsync/spec@0.3.1

## 0.3.0

### Minor Changes

- f5b9f1b: Split installed configuration and installed-copy verification out of `MechanismAdapter.checkAnchors` into a dedicated optional `checkInstalled?(ctx, version)` hook (#61):
  
  - `checkAnchors(ctx, version)` is now strictly static (pristine upstream only), so `graft replay`, `graft variant add --verify-version`, and generator regeneration on an already-installed version no longer fail on unapplied local applier config.
  - `graft check`, `graft status`, `graft apply`, and `graft sync` (when verifying or after installing a target) invoke `checkInstalled` and continue to fail loudly when applier config or installed files do not match the selected variant.
  - **Breaking for direct adapter callers:** code calling `patchAdapter.checkAnchors` or `forkAdapter.checkAnchors` directly now gets static anchor checks only; use `@graftsync/core`'s `checkAnchors(project, id, version)` (or `checkGraftWithInstalled`) / `adapter.checkInstalled` to include installed verification.

### Patch Changes

- ae39fce: - `patch`: accept LF patches against CRLF upstream files across anchor checks, `apply`, `applyToInstalledCopy`, and `checkInstalled` (tolerating mixed CRLF/LF output produced by pnpm) while preserving strict matching when a patch explicitly contains CR (#67).
  - `pnpm`: pin `patchedDependencies` to `<pkg>@<installed>` when multiple distinct versions of `<pkg>` are installed in `node_modules/.pnpm`, avoiding broken installs on unrelated versions in multi-version workspaces (#68).
  - `patch`: support hunkless deleted and created files (`deleted file mode` / `new file mode` with 0 hunks, as written by `pnpm patch-commit` and `git diff`) in parsing, anchor checks, `apply`, `applyToInstalledCopy`, and `checkInstalled`, and report a non-empty error if a file patch makes no changes (#69).
  - `pnpm`: detect pnpm major version (`packageManager`, `devEngines.packageManager`, or `pnpm --version`) and skip requiring/writing `ignorePatchFailures: false` on pnpm 11+, where the setting was removed and patch failures fail installs by default (#70).
  - `core`: bump matching top-level overrides/resolutions for direct dependencies as well as transitive ones during `sync --install` so an override pinning the old version does not hold back a direct dependency upgrade, and filter `node_modules/.pnpm` scans against `node_modules/.pnpm/lock.yaml` so unpruned directories left by `pnpm update` do not trigger false `upstream/ambiguous-installed` errors (#71).
- 8c078e8: - `upstream`: pass `npm_config_force=true` when calling `npm view`/`npm pack` so repos declaring `devEngines.packageManager` (e.g. pnpm with `onFail: "error"`) do not fail with `EBADDEVENGINES` (#58).
  - `upstream`: fall back to pnpm's virtual store (`node_modules/.pnpm/`) in `findInstalledPackage` for unhoisted transitive dependencies, failing loudly with `upstream/ambiguous-installed` when multiple distinct versions are installed (#59).
  - `fork`: fall back to ephemeral `commit-tree` parents in `mergeToBranch` when `git merge-tree` lacks `--merge-base` (git 2.38–2.39) (#60).
  - `patch`: ignore crates.io publish/vendor metadata (`.cargo_vcs_info.json`, `Cargo.toml.orig`, `.cargo-checksum.json`) during `graft capture` for Cargo crates (#62).
- Updated dependencies [842a720]
- Updated dependencies [f5b9f1b]
- Updated dependencies [0e2644f]
- Updated dependencies [ae39fce]
- Updated dependencies [5718e30]
- Updated dependencies [8c078e8]
  - @graftsync/core@0.3.0
  - @graftsync/spec@0.3.0

## 0.2.9

### Patch Changes

- Updated dependencies [b0c2b99]
- Updated dependencies [c701de8]
  - @graftsync/core@0.2.9
  - @graftsync/spec@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies [cb41451]
- Updated dependencies [e33f389]
- Updated dependencies [462aa7d]
  - @graftsync/core@0.2.8
  - @graftsync/spec@0.2.8

## 0.2.7

### Patch Changes

- Updated dependencies [fe5bad8]
- Updated dependencies [072ebd8]
  - @graftsync/core@0.2.7
  - @graftsync/spec@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @graftsync/core@0.2.6
  - @graftsync/spec@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies
  - @graftsync/core@0.2.5
  - @graftsync/spec@0.2.5

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
