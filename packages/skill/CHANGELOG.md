# @graftsync/skill

## 0.2.4

### Patch Changes

`graft capture` works for Cargo, Go and PyPI grafts.

- cargo: captures the copy cargo builds, the vendored crate after `graft apply` (or the registry source); `target/` and `.cargo-ok` are ignored.
- go: captures the module's replacement directory, the vendored module after `graft apply` or any directory a `replace` points at. The read-only module cache is refused with `capture/read-only`, saying where to edit instead. Variant files are named `v0.11.0.patch`, not `vv0.11.0.patch`.
- pypi: captures the wheel's own files in site-packages (its top-level packages and modules, including files added there), never the rest of site-packages, `.dist-info`, `.data` or `__pycache__`.
- In every ecosystem, capture refuses an installed copy that is exactly pristine + the selected variant (`capture/no-changes`), instead of registering a duplicate of that variant.

## 0.2.3

### Patch Changes

Patch grafts for Rust crates, Go modules and Python packages (#26).

- `rootstock.ecosystem` (`npm` by default, so existing grafts are unchanged; `cargo`, `go`, `pypi`), with `frontmatter/unknown-ecosystem` for anything else. Versions and ranges use the ecosystem's scheme: semver for npm, cargo and go (the `v` optional), PEP 440 for pypi.
- cargo: the published `.crate` is the pristine artifact; the `cargo-vendor` applier commits the patched crate under `.grafts/.vendor/` and adds `[patch.crates-io]`, and `graft check` fails on `[[patch.unused]]`, which cargo only warns about.
- go: the module cache's verified copy is the pristine artifact; the `go-replace` applier commits the patched module and sets a version-qualified `replace` (go.mod or go.work), and `graft check` fails when the go command ignores it.
- pypi: the published wheel is the pristine artifact; the `wheel-vendor` applier commits the patched wheel and points `[tool.uv.sources]` (uv) or the requirements file (pip) at it, reinstalling so that neither tool keeps a stale copy silently. Poetry isn't supported yet.
- `graft add --ecosystem` and `graft sync --ecosystem`, per-ecosystem options under `ecosystems` in `.grafts/config.json`, and `mechanisms.patch.applier` per ecosystem. Reports and `outdated` carry the ecosystem. The `fork` mechanism's package mode stays npm only (`fork/ecosystem`).

## 0.2.2

### Patch Changes

- 6dd050f: Repo mode, in place: after resolving a prepared `-agent` branch, the green sync's report now says to take its result with `git read-tree` (the checkout is already merging that upstream, so a second `git merge` is refused), so the commit records graft.md as `applied` instead of leaving it `conflicted`. The needs-agent report's "Next" line no longer tells you to write a new variant for a graft whose variant is permanent (`@worktree` / `@verified`); it gives the resolve, re-sync, take, commit steps (`agentStart.next`).

## 0.2.1

### Patch Changes

- 275c71b: Repo mode: a result's fetchable ref (`materialized.fetch`, `agentStart`) now names the upstream commit it sits on (`upstream`), and the report's adopt command, the README, the skill and the Action adopt it as a merge of that commit with the result's tree. Before, adopting by tree swap left upstream out of the fork's history, so a fork that also merges upstream itself replayed it on its next merge (#22). A local `fork.repo` or `upstream` that is a partial clone is now refused with `fork/partial-clone`, naming the cause, instead of git's "repository corruption" error (#23).

## 0.2.0

### Minor Changes

**Breaking:** Graft no longer runs an oracle. `graft sync` checks that each graft still fits (anchors, apply) and installs, and records it; verifying behavior is the agent's job, with the project's own tests.

- The `oracle` frontmatter field is gone. An existing `oracle:` block is ignored with the warning `frontmatter/oracle-ignored`: move the check into the project's tests and say under Invariants which tests cover each one.
- `graft verify` is removed, and `graft add` no longer scaffolds `oracle.mjs` (or takes `--modes`). `runOracle` is gone from core; `runCommand` now lives in `command.ts`.
- Sync reports no oracle output; a standalone (repo-mode) graft's result is reported as `materialized` (with a `fetch` ref) instead of under `oracle`.
- The graft-sync skill makes verification explicit: prove every Invariant with the project's tests before recording a variant, add a test where none covers one, never weaken a test.
- The GitHub Action's PRs say Graft checked fit, not behavior, and its agent prompts ask the agent to verify the Invariants with the project's tests and report how.
- Fix: `graft check` fails on an invalid graft instead of silently skipping it (it reported only valid grafts, so CI passed).

## 0.1.2

### Patch Changes

- `graft capture <id>`: write your edit of the installed package as the graft's variant (the diff against the published package). It replaces the untouched scaffold stub, or adds a new variant once a real one exists, and keeps it only if it applies to the pristine version.
- Smaller install: pristine packages are fetched with the project's own npm (`npm pack`, `npm view`, honoring its `.npmrc`) instead of pacote. `@graftsync/cli` now installs 18 packages instead of 103.
- The graft-sync skill covers browser oracles: fail on console errors and 5xx responses too, since frameworks catch errors and only log them.

## 0.1.1

### Patch Changes

- `graft add --mechanism fork --in-place` scaffolds a repo-mode graft from inside a fork that is the product: `repo: .`, `install: none`, the upstream from the checkout's `upstream` remote (or `--upstream`), the permanent `{ "@worktree", "@verified" }` variant, and an oracle run from `$GRAFT_DIR`. `--repo-mode`, `--fork-repo`, `--tag` and `--track` fill in the rest.
- Generators can report that upstream already does what the graft did: exit `GRAFT_EXIT_UPSTREAMED` (3) and `graft sync` reports the graft as likely upstreamed instead of a plain needs-agent.
- A failed generator is reported with its error message, not the tail of its stack trace.
- Missed anchors are summarized per file in sync reports, with long lists cut.
- The graft-sync skill covers scaffolding in-place repo-mode grafts.
