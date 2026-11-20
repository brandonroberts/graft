# @graftsync/core

## 0.3.1

### Patch Changes

- bd3a743: Harden patch checks, release-age filtering, pnpm `packageExtensions`, scoped diffs, and CLI argument validation (from validating against `openclaw/openclaw`):
  
  - Enforce applier hunk offset limits (±20 lines for `pnpm`, `yarn`, and `patch-package`) in `checkAnchors` and `apply` so patches that drift past the package manager's search window report `needs-agent` instead of failing during install (#77).
  - Parse `.npmrc` `min-release-age-exclude[]`, let `pnpm-workspace.yaml` `minimumReleaseAge` / `minimumReleaseAgeExclude` govern over `.npmrc` when configured, and pass `npm_config_min_release_age=0` to read-only `npm pack` / `npm view` calls (#78).
  - Rename exact-pinned pnpm `packageExtensions` keys on upgrade, fail loudly (`install/package-extensions`) when a range-pinned key stops matching the target version, and warn in `graft check` when a stale version-pinned `packageExtensions` key matches no installed version (#79).
  - Match renamed content-hashed bundler chunks (e.g. `dist/chunks/cac.<hash>.js`) in `graft diff` so scoped diffs compare old→new chunks instead of dumping the entire file as deleted, and reject unknown CLI flags and unexpected positional arguments with exit code 2 (#80).
- @graftsync/spec@0.3.1

## 0.3.0

### Minor Changes

- f5b9f1b: Split installed configuration and installed-copy verification out of `MechanismAdapter.checkAnchors` into a dedicated optional `checkInstalled?(ctx, version)` hook (#61):
  
  - `checkAnchors(ctx, version)` is now strictly static (pristine upstream only), so `graft replay`, `graft variant add --verify-version`, and generator regeneration on an already-installed version no longer fail on unapplied local applier config.
  - `graft check`, `graft status`, `graft apply`, and `graft sync` (when verifying or after installing a target) invoke `checkInstalled` and continue to fail loudly when applier config or installed files do not match the selected variant.
  - **Breaking for direct adapter callers:** code calling `patchAdapter.checkAnchors` or `forkAdapter.checkAnchors` directly now gets static anchor checks only; use `@graftsync/core`'s `checkAnchors(project, id, version)` (or `checkGraftWithInstalled`) / `adapter.checkInstalled` to include installed verification.
- 5718e30: Stop silently promoting transitive npm dependencies into root `dependencies` during `sync --install` (#63):
  
  - When a rootstock package is not declared in `dependencies`, `devDependencies`, or `optionalDependencies` of any workspace manifest (and not in a pnpm catalog), Graft now checks for an existing top-level override/resolution (`overrides` in `pnpm-workspace.yaml` or `package.json`, `pnpm.overrides`, or `resolutions`) pinning the installed version.
  - If a matching override pins the installed version, Graft updates it (preserving prefixes, comments, and formatting) and runs a bare reinstall.
  - Otherwise, Graft fails loudly with `install/transitive` instead of running `bun add` / `npm install` / `yarn add` into root `dependencies` (or running `pnpm update -r` / `yarn up` that leaves it behind).
  - `installPackage` also preserves `optionalDependencies` when upgrading a direct optional dependency.

### Patch Changes

- 842a720: - `npm`: detect workspace manifests referencing a package via pnpm `catalog:` / `catalog:<name>` when its catalog entry does not pin the installed version (e.g. a range like `>=24.0.0 <25.0.0`) and fail loudly with `install/catalog` instead of running `pnpm update` and overwriting `catalog:` references with literal versions (#55).
  - `ecosystems`: add sibling detection and multi-package upgrades for Cargo (`cargo metadata` `repository`), Go (`go list -m -json all` repository module prefix), and PyPI (`pyproject.toml`/requirements + `importlib.metadata` `Project-URL`/`Home-page`) so companion packages released together move with the rootstock (#56).
  - `sync`: add optional `needsAgentIf` (`exists`, `output`, and/or `command`) on `.grafts/config.json` `upgrade` entries to detect upgrade commands that exit 0 while leaving unfinished work (e.g. Nx agentic migrate runs), marking grafts `needs-agent` (exit code 1) instead of `green` (#57).
- 0e2644f: - `npm`: when `sync --install` bumps a top-level override/resolution for a direct dependency, also update matching pinned dependency specifiers (`1.0.0`, `^1.0.0`, `~1.0.0`, `=1.0.0`) across workspace `package.json` manifests so exact-pinned specs don't stay stale behind the override (#74).
  - `npm`: respect `.npmrc` `min-release-age` (days) and `pnpm-workspace.yaml` `minimumReleaseAge` (minutes, with `minimumReleaseAgeExclude`) in `NpmUpstreamSource.versions`, filtering out releases newer than the cooldown and falling back `latest` to the highest eligible stable version so `graft outdated` matches what `npm pack` and pnpm will install (#75).
- ae39fce: - `patch`: accept LF patches against CRLF upstream files across anchor checks, `apply`, `applyToInstalledCopy`, and `checkInstalled` (tolerating mixed CRLF/LF output produced by pnpm) while preserving strict matching when a patch explicitly contains CR (#67).
  - `pnpm`: pin `patchedDependencies` to `<pkg>@<installed>` when multiple distinct versions of `<pkg>` are installed in `node_modules/.pnpm`, avoiding broken installs on unrelated versions in multi-version workspaces (#68).
  - `patch`: support hunkless deleted and created files (`deleted file mode` / `new file mode` with 0 hunks, as written by `pnpm patch-commit` and `git diff`) in parsing, anchor checks, `apply`, `applyToInstalledCopy`, and `checkInstalled`, and report a non-empty error if a file patch makes no changes (#69).
  - `pnpm`: detect pnpm major version (`packageManager`, `devEngines.packageManager`, or `pnpm --version`) and skip requiring/writing `ignorePatchFailures: false` on pnpm 11+, where the setting was removed and patch failures fail installs by default (#70).
  - `core`: bump matching top-level overrides/resolutions for direct dependencies as well as transitive ones during `sync --install` so an override pinning the old version does not hold back a direct dependency upgrade, and filter `node_modules/.pnpm` scans against `node_modules/.pnpm/lock.yaml` so unpruned directories left by `pnpm update` do not trigger false `upstream/ambiguous-installed` errors (#71).
- 8c078e8: - `upstream`: pass `npm_config_force=true` when calling `npm view`/`npm pack` so repos declaring `devEngines.packageManager` (e.g. pnpm with `onFail: "error"`) do not fail with `EBADDEVENGINES` (#58).
  - `upstream`: fall back to pnpm's virtual store (`node_modules/.pnpm/`) in `findInstalledPackage` for unhoisted transitive dependencies, failing loudly with `upstream/ambiguous-installed` when multiple distinct versions are installed (#59).
  - `fork`: fall back to ephemeral `commit-tree` parents in `mergeToBranch` when `git merge-tree` lacks `--merge-base` (git 2.38–2.39) (#60).
  - `patch`: ignore crates.io publish/vendor metadata (`.cargo_vcs_info.json`, `Cargo.toml.orig`, `.cargo-checksum.json`) during `graft capture` for Cargo crates (#62).
- @graftsync/spec@0.3.0

## 0.2.9

### Patch Changes

- b0c2b99: `graft sync --dry-run` against a version that isn't installed (and without `--install`) now runs the static checks (variant, anchors, apply) and reports their result, as its error message promised, instead of failing every graft with "rerun with --install … (or --dry-run)".
- c701de8: The sync report keeps the end of an `upgrade` command's output (`installOutput` in `sync.json`, a section of `sync.md`), and the skill tells agents to read it even when sync is green: a tool can exit 0 and leave work for an agent, as `nx migrate --agentic` does when it runs inside one.
- Updated dependencies
  - @graftsync/spec@0.2.9

## 0.2.8

### Patch Changes

- cb41451: The `upgrade` command can also be set per ecosystem, as `ecosystems.<name>.upgrade` in `.grafts/config.json`, like the other per-ecosystem options. It wins over the top-level `upgrade` map.
- e33f389: `graft sync` streams an `upgrade` command's output, as it does a generator's, to stderr, also with `--json` (stdout stays the JSON report; `--quiet` silences it). The GitHub Action shows each `graft sync`'s progress and command output in a collapsible log group.
- 462aa7d: An `upgrade` entry can be `{ "command": …, "timeoutMinutes": 90 }` for upgrades that take longer than the default 30 minutes. Command timeouts now stop everything the command started: before, only its shell was killed, so a timed-out install, generator or fork build kept running and Graft waited for it.
- Updated dependencies
  - @graftsync/spec@0.2.8

## 0.2.7

### Patch Changes

- fe5bad8: `graft sync --install` moves an npm package's siblings with it: the project's dependencies from the same repository at the same installed version (e.g. the `@nx/*` packages with `nx`). A sibling not published at the target version is an error (`install/sibling-unpublished`) instead of being left behind. With pnpm catalogs, sync updates the catalog entries in `pnpm-workspace.yaml` instead of running `pnpm update`, which replaced the manifests' `catalog:` references with literal versions.
- 072ebd8: `.grafts/config.json` takes an `upgrade` command per rootstock package (`{version}` and `{package}` substituted). `graft sync --install` runs it instead of its single-package install, for upgrades that move companion packages or run migrations (`nx migrate`, `ng update`). A failing command, or one that leaves another version installed, is an error. The skill and the setup prompt now ask how the package is upgraded by hand.
- Updated dependencies
  - @graftsync/spec@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @graftsync/spec@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies
  - @graftsync/spec@0.2.5

## 0.2.4

### Patch Changes

`graft capture` works for Cargo, Go and PyPI grafts.

- cargo: captures the copy cargo builds, the vendored crate after `graft apply` (or the registry source); `target/` and `.cargo-ok` are ignored.
- go: captures the module's replacement directory, the vendored module after `graft apply` or any directory a `replace` points at. The read-only module cache is refused with `capture/read-only`, saying where to edit instead. Variant files are named `v0.11.0.patch`, not `vv0.11.0.patch`.
- pypi: captures the wheel's own files in site-packages (its top-level packages and modules, including files added there), never the rest of site-packages, `.dist-info`, `.data` or `__pycache__`.
- In every ecosystem, capture refuses an installed copy that is exactly pristine + the selected variant (`capture/no-changes`), instead of registering a duplicate of that variant.
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

## 0.2.2

### Patch Changes

- 6dd050f: Repo mode, in place: after resolving a prepared `-agent` branch, the green sync's report now says to take its result with `git read-tree` (the checkout is already merging that upstream, so a second `git merge` is refused), so the commit records graft.md as `applied` instead of leaving it `conflicted`. The needs-agent report's "Next" line no longer tells you to write a new variant for a graft whose variant is permanent (`@worktree` / `@verified`); it gives the resolve, re-sync, take, commit steps (`agentStart.next`).
- @graftsync/spec@0.2.2

## 0.2.1

### Patch Changes

- 275c71b: Repo mode: a result's fetchable ref (`materialized.fetch`, `agentStart`) now names the upstream commit it sits on (`upstream`), and the report's adopt command, the README, the skill and the Action adopt it as a merge of that commit with the result's tree. Before, adopting by tree swap left upstream out of the fork's history, so a fork that also merges upstream itself replayed it on its next merge (#22). A local `fork.repo` or `upstream` that is a partial clone is now refused with `fork/partial-clone`, naming the cause, instead of git's "repository corruption" error (#23).
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
  - @graftsync/spec@0.2.0

## 0.1.2

### Patch Changes

- `graft capture <id>`: write your edit of the installed package as the graft's variant (the diff against the published package). It replaces the untouched scaffold stub, or adds a new variant once a real one exists, and keeps it only if it applies to the pristine version.
- Smaller install: pristine packages are fetched with the project's own npm (`npm pack`, `npm view`, honoring its `.npmrc`) instead of pacote. `@graftsync/cli` now installs 18 packages instead of 103.
- The graft-sync skill covers browser oracles: fail on console errors and 5xx responses too, since frameworks catch errors and only log them.
- @graftsync/spec@0.1.2

## 0.1.1

### Patch Changes

- `graft add --mechanism fork --in-place` scaffolds a repo-mode graft from inside a fork that is the product: `repo: .`, `install: none`, the upstream from the checkout's `upstream` remote (or `--upstream`), the permanent `{ "@worktree", "@verified" }` variant, and an oracle run from `$GRAFT_DIR`. `--repo-mode`, `--fork-repo`, `--tag` and `--track` fill in the rest.
- Generators can report that upstream already does what the graft did: exit `GRAFT_EXIT_UPSTREAMED` (3) and `graft sync` reports the graft as likely upstreamed instead of a plain needs-agent.
- A failed generator is reported with its error message, not the tail of its stack trace.
- Missed anchors are summarized per file in sync reports, with long lists cut.
- The graft-sync skill covers scaffolding in-place repo-mode grafts.
- @graftsync/spec@0.1.1
