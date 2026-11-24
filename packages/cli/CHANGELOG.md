# @graftsync/cli

## 0.3.5

### Patch Changes

- c1bfbe0: Skip `.git` directories and `.git` gitdir files in `graft capture` so capturing from git-sourced dependencies (such as Cargo `[patch.crates-io]` git checkouts, Go `replace` clones, or submodules/worktrees) does not fail on `.git/index` or `.git/objects/pack/*` (#103, #104).
- Updated dependencies [c1bfbe0]
  - @graftsync/adapter-patch@0.3.5
  - @graftsync/adapter-fork@0.3.5
  - @graftsync/core@0.3.5
  - @graftsync/skill@0.3.5
  - @graftsync/spec@0.3.5

## 0.3.4

### Patch Changes

- Detect obsolete grafts whose variants still apply cleanly: default-on nearby-upstream-change detection (filtering version-only manifest bumps) and opt-in without-variant `probe` in `graft.md` (`graft sync --probe-obsolete`, Action `probe-obsolete`) (#98).
- Unwrap npm 12+ array-wrapped `npm view --json` output and fail loudly on empty or unexpected shapes so `graft outdated` never silently reports up-to-date (#99).
- Add customizable `pr-title` input to the GitHub Action and follow repository PR/issue guidelines (#101).
- Updated dependencies
  - @graftsync/core@0.3.4
  - @graftsync/spec@0.3.4
  - @graftsync/skill@0.3.4
  - @graftsync/adapter-patch@0.3.4
  - @graftsync/adapter-fork@0.3.4

## 0.3.3

### Patch Changes

- 7452f67: Verify nested `node_modules` copies in `graft check` / `graft sync` when using Graft's built-in `graft` applier (`graft apply --installed`): covered nested copies are verified against their matching variant (failing loudly if unpatched or unapplicable), and uncovered nested copies emit a warning (#87, #88).
- 47af9b4: Resolve workspace sibling candidates from `resolveFrom[pkg]` first (ignoring unrelated multi-version `.pnpm` ambiguities) in `findSiblings`, and run `resolveUpgrade` and sibling checks before `beforeInstall` in `sync` so pre-install errors never leave package-manager config mutated (#89, #90).
- c7eb007: Add transactional `WorkspaceSnapshot` rollback around `sync --install` (so install or post-install verification failures never leave manifests, package-manager config, lockfiles, or vendored artifacts half-mutated) and unify workspace-scoped / multi-copy package resolution across `sync`, `checkInstalled`, `applyInstalled`, `siblings`, and `ecosystems/npm` (#91).
- 0d49fad: Report fork adapter fetch, git, partial-clone, and config failures (`fork/partial-clone`, `fork/git`, `fork/config`, `fork/ecosystem`) as tooling errors (`outcome: 'error'`, exit code `2`) instead of `needs-agent`, and detect `file://` local partial clones (#92).
- 746f00b: Include transitive exact-version (`=<version>`, non-dev) lockstep dependencies from the same repository in `findCargoSiblings` (such as `serde_core` with `serde`), ignore dev-dependencies in `orderCargoUpdates`, and update patched Cargo crates and their siblings atomically in one `cargo update -p … --precise` call (#93, #94).
- 08f9cfc: Clear `uv`'s cache (`uv cache clean`) and pass `--reinstall-package` for vendored wheels to `uv sync` in `pypiEcosystem.reinstall` so `graft apply` always restores modified site-packages (including hardlinked same-filesystem caches) or rebuilt same-version wheels into `.venv` (#95, #96).
- Updated dependencies [746f00b]
- Updated dependencies [7452f67]
- Updated dependencies [0d49fad]
- Updated dependencies [47af9b4]
- Updated dependencies [c7eb007]
- Updated dependencies [08f9cfc]
  - @graftsync/core@0.3.3
  - @graftsync/adapter-patch@0.3.3
  - @graftsync/adapter-fork@0.3.3
  - @graftsync/skill@0.3.3
  - @graftsync/spec@0.3.3

## 0.3.2

### Patch Changes

- 52333b5: Support opt-in version-pinned `patchedDependencies` keys (`mechanisms.patch.pinKeys: true` in `.grafts/config.json`) for the `pnpm` and `npm` (>= 12) patch appliers, and reject `allowUnusedPatches: true` / `allowNonAppliedPatches: true` in `pnpm` configs whenever keys are version-pinned (#83, #84).
- 724daa3: Report invalid `graft.md` files and unknown graft IDs as errors in `graft apply` (`applyToProject`) and `graft apply --installed` (`applyInstalled`) instead of silently skipping them (#85, #86).
- Updated dependencies [724daa3]
- Updated dependencies [52333b5]
  - @graftsync/core@0.3.2
  - @graftsync/adapter-patch@0.3.2
  - @graftsync/skill@0.3.2
  - @graftsync/adapter-fork@0.3.2
  - @graftsync/spec@0.3.2

## 0.3.1

### Patch Changes

- GitHub Action: default commit, PR, and issue titles to `build: graft sync {package} to {version}{status}` (keeping backwards-compatible deduplication for legacy `graft: sync ...` issues), add customizable `issue-title` input with safe placeholder templating and branch-marker deduplication, and add `on-unchanged: skip | pr` (default `skip`) so unchanged dependency grafts skip upgrades and PRs until a graft actually needs work (#82).
- bd3a743: Harden patch checks, release-age filtering, pnpm `packageExtensions`, scoped diffs, and CLI argument validation (from validating against `openclaw/openclaw`):
  
  - Enforce applier hunk offset limits (±20 lines for `pnpm`, `yarn`, and `patch-package`) in `checkAnchors` and `apply` so patches that drift past the package manager's search window report `needs-agent` instead of failing during install (#77).
  - Parse `.npmrc` `min-release-age-exclude[]`, let `pnpm-workspace.yaml` `minimumReleaseAge` / `minimumReleaseAgeExclude` govern over `.npmrc` when configured, and pass `npm_config_min_release_age=0` to read-only `npm pack` / `npm view` calls (#78).
  - Rename exact-pinned pnpm `packageExtensions` keys on upgrade, fail loudly (`install/package-extensions`) when a range-pinned key stops matching the target version, and warn in `graft check` when a stale version-pinned `packageExtensions` key matches no installed version (#79).
  - Match renamed content-hashed bundler chunks (e.g. `dist/chunks/cac.<hash>.js`) in `graft diff` so scoped diffs compare old→new chunks instead of dumping the entire file as deleted, and reject unknown CLI flags and unexpected positional arguments with exit code 2 (#80).
- Updated dependencies [bd3a743]
  - @graftsync/core@0.3.1
  - @graftsync/adapter-patch@0.3.1
  - @graftsync/adapter-fork@0.3.1
  - @graftsync/skill@0.3.1
  - @graftsync/spec@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [842a720]
- Updated dependencies [f5b9f1b]
- Updated dependencies [0e2644f]
- Updated dependencies [ae39fce]
- Updated dependencies [5718e30]
- Updated dependencies [8c078e8]
  - @graftsync/core@0.3.0
  - @graftsync/adapter-patch@0.3.0
  - @graftsync/adapter-fork@0.3.0
  - @graftsync/skill@0.3.0
  - @graftsync/spec@0.3.0

## 0.2.9

### Patch Changes

- b0c2b99: `graft sync --dry-run` against a version that isn't installed (and without `--install`) now runs the static checks (variant, anchors, apply) and reports their result, as its error message promised, instead of failing every graft with "rerun with --install … (or --dry-run)".
- c701de8: The sync report keeps the end of an `upgrade` command's output (`installOutput` in `sync.json`, a section of `sync.md`), and the skill tells agents to read it even when sync is green: a tool can exit 0 and leave work for an agent, as `nx migrate --agentic` does when it runs inside one.
- Updated dependencies [b0c2b99]
- Updated dependencies [c701de8]
  - @graftsync/core@0.2.9
  - @graftsync/skill@0.2.9
  - @graftsync/adapter-fork@0.2.9
  - @graftsync/adapter-patch@0.2.9
  - @graftsync/spec@0.2.9

## 0.2.8

### Patch Changes

- cb41451: The `upgrade` command can also be set per ecosystem, as `ecosystems.<name>.upgrade` in `.grafts/config.json`, like the other per-ecosystem options. It wins over the top-level `upgrade` map.
- e33f389: `graft sync` streams an `upgrade` command's output, as it does a generator's, to stderr, also with `--json` (stdout stays the JSON report; `--quiet` silences it). The GitHub Action shows each `graft sync`'s progress and command output in a collapsible log group.
- 462aa7d: An `upgrade` entry can be `{ "command": …, "timeoutMinutes": 90 }` for upgrades that take longer than the default 30 minutes. Command timeouts now stop everything the command started: before, only its shell was killed, so a timed-out install, generator or fork build kept running and Graft waited for it.
- Updated dependencies [cb41451]
- Updated dependencies [e33f389]
- Updated dependencies [462aa7d]
  - @graftsync/core@0.2.8
  - @graftsync/adapter-fork@0.2.8
  - @graftsync/adapter-patch@0.2.8
  - @graftsync/skill@0.2.8
  - @graftsync/spec@0.2.8

## 0.2.7

### Patch Changes

- fe5bad8: `graft sync --install` moves an npm package's siblings with it: the project's dependencies from the same repository at the same installed version (e.g. the `@nx/*` packages with `nx`). A sibling not published at the target version is an error (`install/sibling-unpublished`) instead of being left behind. With pnpm catalogs, sync updates the catalog entries in `pnpm-workspace.yaml` instead of running `pnpm update`, which replaced the manifests' `catalog:` references with literal versions.
- 072ebd8: `.grafts/config.json` takes an `upgrade` command per rootstock package (`{version}` and `{package}` substituted). `graft sync --install` runs it instead of its single-package install, for upgrades that move companion packages or run migrations (`nx migrate`, `ng update`). A failing command, or one that leaves another version installed, is an error. The skill and the setup prompt now ask how the package is upgraded by hand.
- Updated dependencies [fe5bad8]
- Updated dependencies [072ebd8]
  - @graftsync/core@0.2.7
  - @graftsync/skill@0.2.7
  - @graftsync/adapter-fork@0.2.7
  - @graftsync/adapter-patch@0.2.7
  - @graftsync/spec@0.2.7

## 0.2.6

### Patch Changes

- GitHub Action (pin `packages/action@v0.2.6`): sync commits and pushes no longer run the repository's git hooks, so a commitlint `commit-msg` hook no longer blocks them (#32). A sync branch that an earlier run pushed but couldn't open a pull request for is now resumed on the next run instead of being skipped forever (#33).
- 76609ec: The README and skill now recommend a plain `graft check` step in CI (no third-party action needed), pinning the GitHub Action to a release tag with the CLI at the same version, and `tags: latest` when only stable upstream releases should get sync PRs.
- a35120e: The setup prompt and the skill's "Adding a new graft" steps now ask the developer whether to automate re-verification with the Graft GitHub Action, and say how to set up the workflow, the CI check and the GitHub-side settings.
- Updated dependencies [76609ec]
- Updated dependencies [a35120e]
  - @graftsync/skill@0.2.6
  - @graftsync/adapter-fork@0.2.6
  - @graftsync/adapter-patch@0.2.6
  - @graftsync/core@0.2.6
  - @graftsync/spec@0.2.6

## 0.2.5

### Patch Changes

- ba04a59: The README on npm shows its workflow image again. The packed README pointed images at the release tag, which the Release workflow creates only after publishing, so npmjs.com's first fetch of the image (which it caches) was a 404. Images now point at the published commit, which is on GitHub before the publish; links still point at the tag.
- Updated dependencies
  - @graftsync/adapter-fork@0.2.5
  - @graftsync/adapter-patch@0.2.5
  - @graftsync/core@0.2.5
  - @graftsync/skill@0.2.5
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
  - @graftsync/adapter-patch@0.2.4
  - @graftsync/skill@0.2.4
  - @graftsync/adapter-fork@0.2.4
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
  - @graftsync/adapter-fork@0.2.3
  - @graftsync/skill@0.2.3

## 0.2.2

### Patch Changes

- ef6a008: The npm package now includes the project README, with its links pointing at the release's tag on GitHub.
- Updated dependencies [6dd050f]
  - @graftsync/core@0.2.2
  - @graftsync/adapter-fork@0.2.2
  - @graftsync/skill@0.2.2
  - @graftsync/adapter-patch@0.2.2
  - @graftsync/spec@0.2.2

## 0.2.1

### Patch Changes

Repo mode keeps upstream in the fork's history, and refuses partial clones with a clear reason.

- A repo-mode result (`materialized.fetch`, `agentStart`) now names the upstream commit it sits on (`upstream`). The report's adopt command, the README, the skill and the GitHub Action adopt it as a merge of that commit, with the result's tree. Adopting by tree swap left upstream out of the fork's history, so a fork that also merges upstream itself replayed it on its next merge and hit the resolved conflicts again (#22).
- A local `fork.repo` or `upstream` that is a partial clone (`--filter=blob:none`) is refused with `fork/partial-clone`, naming the cause and the fix, instead of git's "repository corruption" error after a full fetch attempt (#23). Shallow clones still work.
- Updated dependencies [275c71b]
  - @graftsync/core@0.2.1
  - @graftsync/adapter-fork@0.2.1
  - @graftsync/skill@0.2.1
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
  - @graftsync/adapter-fork@0.2.0
  - @graftsync/skill@0.2.0

## 0.1.2

### Patch Changes

- `graft capture <id>`: write your edit of the installed package as the graft's variant (the diff against the published package). It replaces the untouched scaffold stub, or adds a new variant once a real one exists, and keeps it only if it applies to the pristine version.
- Smaller install: pristine packages are fetched with the project's own npm (`npm pack`, `npm view`, honoring its `.npmrc`) instead of pacote. `@graftsync/cli` now installs 18 packages instead of 103.
- The graft-sync skill covers browser oracles: fail on console errors and 5xx responses too, since frameworks catch errors and only log them.
- Updated dependencies [3a0ffbb]
  - @graftsync/core@0.1.2
  - @graftsync/adapter-patch@0.1.2
  - @graftsync/skill@0.1.2
  - @graftsync/adapter-fork@0.1.2
  - @graftsync/spec@0.1.2

## 0.1.1

### Patch Changes

- `graft add --mechanism fork --in-place` scaffolds a repo-mode graft from inside a fork that is the product: `repo: .`, `install: none`, the upstream from the checkout's `upstream` remote (or `--upstream`), the permanent `{ "@worktree", "@verified" }` variant, and an oracle run from `$GRAFT_DIR`. `--repo-mode`, `--fork-repo`, `--tag` and `--track` fill in the rest.
- Generators can report that upstream already does what the graft did: exit `GRAFT_EXIT_UPSTREAMED` (3) and `graft sync` reports the graft as likely upstreamed instead of a plain needs-agent.
- A failed generator is reported with its error message, not the tail of its stack trace.
- Missed anchors are summarized per file in sync reports, with long lists cut.
- The graft-sync skill covers scaffolding in-place repo-mode grafts.
- `graft --version` reports the CLI's real version (it was hard-coded as 0.1.0).
- Updated dependencies
  - @graftsync/core@0.1.1
  - @graftsync/adapter-fork@0.1.1
  - @graftsync/skill@0.1.1
  - @graftsync/adapter-patch@0.1.1
  - @graftsync/spec@0.1.1
