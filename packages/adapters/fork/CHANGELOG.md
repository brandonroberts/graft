# @graftsync/adapter-fork

## 0.3.5

### Patch Changes

- Updated dependencies [c1bfbe0]
  - @graftsync/adapter-patch@0.3.5
  - @graftsync/core@0.3.5
  - @graftsync/spec@0.3.5

## 0.3.4

### Patch Changes

- Detect obsolete grafts whose variants still apply cleanly: default-on nearby-upstream-change detection (filtering version-only manifest bumps) and opt-in without-variant `probe` in `graft.md` (`graft sync --probe-obsolete`, Action `probe-obsolete`) (#98).
- Unwrap npm 12+ array-wrapped `npm view --json` output and fail loudly on empty or unexpected shapes so `graft outdated` never silently reports up-to-date (#99).
- Add customizable `pr-title` input to the GitHub Action and follow repository PR/issue guidelines (#101).
- Updated dependencies
  - @graftsync/core@0.3.4
  - @graftsync/spec@0.3.4
  - @graftsync/adapter-patch@0.3.4

## 0.3.3

### Patch Changes

- 0d49fad: Report fork adapter fetch, git, partial-clone, and config failures (`fork/partial-clone`, `fork/git`, `fork/config`, `fork/ecosystem`) as tooling errors (`outcome: 'error'`, exit code `2`) instead of `needs-agent`, and detect `file://` local partial clones in `refusePartialClone`.
- Updated dependencies [746f00b]
- Updated dependencies [7452f67]
- Updated dependencies [0d49fad]
- Updated dependencies [47af9b4]
- Updated dependencies [c7eb007]
- Updated dependencies [08f9cfc]
  - @graftsync/core@0.3.3
  - @graftsync/adapter-patch@0.3.3
  - @graftsync/spec@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies [724daa3]
- Updated dependencies [52333b5]
  - @graftsync/core@0.3.2
  - @graftsync/adapter-patch@0.3.2
  - @graftsync/spec@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [bd3a743]
  - @graftsync/core@0.3.1
  - @graftsync/adapter-patch@0.3.1
  - @graftsync/spec@0.3.1

## 0.3.0

### Minor Changes

- f5b9f1b: Split installed configuration and installed-copy verification out of `MechanismAdapter.checkAnchors` into a dedicated optional `checkInstalled?(ctx, version)` hook (#61):
  
  - `checkAnchors(ctx, version)` is now strictly static (pristine upstream only), so `graft replay`, `graft variant add --verify-version`, and generator regeneration on an already-installed version no longer fail on unapplied local applier config.
  - `graft check`, `graft status`, `graft apply`, and `graft sync` (when verifying or after installing a target) invoke `checkInstalled` and continue to fail loudly when applier config or installed files do not match the selected variant.
  - **Breaking for direct adapter callers:** code calling `patchAdapter.checkAnchors` or `forkAdapter.checkAnchors` directly now gets static anchor checks only; use `@graftsync/core`'s `checkAnchors(project, id, version)` (or `checkGraftWithInstalled`) / `adapter.checkInstalled` to include installed verification.

### Patch Changes

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
  - @graftsync/adapter-patch@0.3.0
  - @graftsync/spec@0.3.0

## 0.2.9

### Patch Changes

- Updated dependencies [b0c2b99]
- Updated dependencies [c701de8]
  - @graftsync/core@0.2.9
  - @graftsync/adapter-patch@0.2.9
  - @graftsync/spec@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies [cb41451]
- Updated dependencies [e33f389]
- Updated dependencies [462aa7d]
  - @graftsync/core@0.2.8
  - @graftsync/adapter-patch@0.2.8
  - @graftsync/spec@0.2.8

## 0.2.7

### Patch Changes

- Updated dependencies [fe5bad8]
- Updated dependencies [072ebd8]
  - @graftsync/core@0.2.7
  - @graftsync/adapter-patch@0.2.7
  - @graftsync/spec@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @graftsync/adapter-patch@0.2.6
  - @graftsync/core@0.2.6
  - @graftsync/spec@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies
  - @graftsync/adapter-patch@0.2.5
  - @graftsync/core@0.2.5
  - @graftsync/spec@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [34a5106]
  - @graftsync/core@0.2.4
  - @graftsync/adapter-patch@0.2.4
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
  - @graftsync/adapter-patch@0.2.3

## 0.2.2

### Patch Changes

- 6dd050f: Repo mode, in place: after resolving a prepared `-agent` branch, the green sync's report now says to take its result with `git read-tree` (the checkout is already merging that upstream, so a second `git merge` is refused), so the commit records graft.md as `applied` instead of leaving it `conflicted`. The needs-agent report's "Next" line no longer tells you to write a new variant for a graft whose variant is permanent (`@worktree` / `@verified`); it gives the resolve, re-sync, take, commit steps (`agentStart.next`).
- Updated dependencies [6dd050f]
  - @graftsync/core@0.2.2
  - @graftsync/adapter-patch@0.2.2
  - @graftsync/spec@0.2.2

## 0.2.1

### Patch Changes

- 275c71b: Repo mode: a result's fetchable ref (`materialized.fetch`, `agentStart`) now names the upstream commit it sits on (`upstream`), and the report's adopt command, the README, the skill and the Action adopt it as a merge of that commit with the result's tree. Before, adopting by tree swap left upstream out of the fork's history, so a fork that also merges upstream itself replayed it on its next merge (#22). A local `fork.repo` or `upstream` that is a partial clone is now refused with `fork/partial-clone`, naming the cause, instead of git's "repository corruption" error (#23).
- Updated dependencies [275c71b]
  - @graftsync/core@0.2.1
  - @graftsync/adapter-patch@0.2.1
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
  - @graftsync/adapter-patch@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [3a0ffbb]
  - @graftsync/core@0.1.2
  - @graftsync/adapter-patch@0.1.2
  - @graftsync/spec@0.1.2

## 0.1.1

### Patch Changes

- `graft add --mechanism fork --in-place` scaffolds a repo-mode graft from inside a fork that is the product: `repo: .`, `install: none`, the upstream from the checkout's `upstream` remote (or `--upstream`), the permanent `{ "@worktree", "@verified" }` variant, and an oracle run from `$GRAFT_DIR`. `--repo-mode`, `--fork-repo`, `--tag` and `--track` fill in the rest.
- Generators can report that upstream already does what the graft did: exit `GRAFT_EXIT_UPSTREAMED` (3) and `graft sync` reports the graft as likely upstreamed instead of a plain needs-agent.
- A failed generator is reported with its error message, not the tail of its stack trace.
- Missed anchors are summarized per file in sync reports, with long lists cut.
- The graft-sync skill covers scaffolding in-place repo-mode grafts.
- Updated dependencies
  - @graftsync/core@0.1.1
  - @graftsync/adapter-patch@0.1.1
  - @graftsync/spec@0.1.1
