# Graft — Handoff

> Agent-first tooling for keeping local modifications to upstream software in sync, automatically.

This is the current handoff for the project as built (November 2026, after the 0.1.1 release). It replaces the original design brief, which is in git history ([`docs/handoff.md` at `458f321`](https://github.com/brandonroberts/graft/blob/458f321/docs/handoff.md)). The *Decisions since the original brief* section lists every place the build differs from that plan, with the reason. The normative format is in [`docs/spec.md`](spec.md) (draft v1, ready to freeze: #6).

## 1. Problem

Teams modify upstream dependencies through patch files, vendored copies, build transforms and forks. All of these store the modification as a diff, or as code shaped to one upstream version. When upstream changes, the modification breaks, and a person has to notice, understand what moved and fix it.

Coding agents can do the fixing, but nothing triggers them and nothing tells them *why* the modification exists or what must stay true. Graft supplies the trigger (the GitHub Action) and the intent (`graft.md`, with its Invariants), and checks mechanically whether each modification still fits. Verifying behavior is the agent's job, with the project's own tests (there is no Graft-run oracle since 0.2).

## 2. Core concepts

- **Graft:** one local modification to an upstream package, described by `.grafts/<id>/graft.md`.
- **Rootstock:** the upstream package, its ecosystem (`rootstock.ecosystem`: npm, cargo, go or pypi) and the last version the graft was verified against (`rootstock.verified`).
- **Intent:** the `graft.md` body: Why, Invariants, Where to look, Anchors, History. It's written for an agent to act on.
- **Mechanism:** how the modification is applied. Two exist: `patch` (a diff against the published package) and `fork` (commits on a fork of the upstream source repo).
- **Applier:** for the `patch` mechanism, how a package manager is made to apply the patch (§6).
- **Anchors:** what a variant matches on in upstream code. For patches, every hunk is an anchor.
- **Variant:** one implementation of the mechanism for a version range. Variants are added, never edited.
- **Invariants:** the observable behaviors a graft guarantees, and which of the project's tests cover them. Sync checks fit; whoever changes a graft verifies the Invariants.
- **Generator:** optional. A command that produces variants mechanically, so `sync` can regenerate one without an agent.

## 3. Goals and non-goals

**Goals (unchanged):**
- an open, agent-readable spec;
- deterministic tooling that applies grafts, detects breakage and scopes upstream changes;
- a sync loop that resolves most upstream bumps with no person or agent involved, and hands the rest to any agent with full context;
- agent-agnostic.

**Non-goals:**
- Graft doesn't ship an agent or call an LLM.
- No hosted service.
- Package ecosystems beyond npm, Cargo, Go and PyPI (#26) for installed dependencies. (A fork in repo mode is any git repository, so the product can be a docs site or a tool in any language.)
- No ordering between overlapping grafts. Two active `patch` (or two `fork`) grafts on one package are an error instead (§6).
- Graft never sets `upstreamed` itself; it only *flags* likely absorption for a person to confirm.

## 4. Architecture

```
packages/
  spec/             @graftsync/spec           graft.md schema (zod), parser, validator, comment-preserving editor
  core/             @graftsync/core           project loading, adapter interface, upstream sources, command runner,
                                              scoped diffs, sync, replay, outdated, record/update, init/add, applyInstalled
  adapters/patch/   @graftsync/adapter-patch  the patch mechanism and its appliers
  adapters/fork/    @graftsync/adapter-fork   the fork mechanism: rebase a fork's commits per upstream tag; build and
                                              pack, or (repo mode) verify the rebased checkout in place
  cli/              @graftsync/cli            the `graft` command, for people, CI and agents
  skill/            @graftsync/skill          SKILL.md teaching agents the sync loop through the CLI
  action/           (private)                 composite GitHub Action, plain ESM .mjs, no build step; used from main
tools/cjs-to-esm/                             converter used as the generator for the dogfood grafts
examples/angular-tr/                          a drop-in repo-mode setup for a real fork, tested against it (§6)
.grafts/                                      this repo's own grafts (dogfood, §10)
```

Rules:
- **Logic lives in core and adapters.** The CLI is a thin front-end, and the Action and agents drive Graft through it.
- **ESM only:** packages export only `import` conditions.
- **Requirements:** Node `^22.22.2 || ^24.15.0 || >=26`, TypeScript 7 (`tsc -b`), vitest.

## 5. The graft format

[`docs/spec.md`](spec.md) defines it precisely. In summary:

```yaml
---
id: request-retry
rootstock: { package: example-http-lib, verified: 4.2.0 }
mechanism: patch
targets: [dist/index.mjs]            # optional
variants:
  - range: ">=3.0.0 <4.0.0"
    module: ./variants/v3.patch
  - range: ">=4.0.0-0"
    module: ./variants/v4.patch
generator: { command: "node tools/make-variant.mjs example-http-lib {version} {out}" }   # optional
status: applied                      # applied | conflicted | upstreamed | obsolete
---
## Why / ## Invariants / ## Where to look / ## Anchors / ## History
```

Validation fails loudly on:
- a missing body section;
- an `id` that doesn't match its directory;
- overlapping variant ranges, compared with prereleases included;
- a duplicate variant module;
- an unknown mechanism, or `mechanism: fork` without a `fork:` block;
- two active grafts on the same package whose mechanism allows only one (`patch`, `fork`).

Variant selection is the first range that satisfies the version, prereleases included; use a `-0` floor for prerelease targets. Registering a variant narrows overlapping open-ended older ranges and never edits existing variants. A verify version must lie inside the new range.

There is no oracle (removed in 0.2): sync checks that a graft still fits and installs, and the agent verifies the Invariants with the project's tests. A leftover `oracle:` block is ignored with a warning.

## 6. Mechanism adapters

```ts
interface MechanismAdapter {
  name: string;
  apply(ctx, options?): Promise<ApplyResult>;                 // apply to pristine upstream (optionally write files)
  checkAnchors(ctx, version): Promise<AnchorReport>;           // + config and installed-copy checks at the installed version
  scopeDiff(ctx, from, to): Promise<ScopedDiff>;               // upstream diff narrowed to anchors; candidates for removed files
  beforeInstall?(ctx, version): Promise<void | { install?: 'reinstall' }>;
  afterInstall?(ctx, version): Promise<void>;
  applyInstalled?(ctx): Promise<InstalledApplyReport>;         // the built-in postinstall applier
  // Standalone grafts (fork repo mode): nothing installed; a green sync materializes a workspace.
  standalone?(graft): boolean;
  workspace?(ctx, version): Promise<Workspace>;                 // { dir, result?, fetch?, dispose }
  recordsInResult?(ctx, version): Promise<boolean>;            // record a green sync in the result, not graft.md
  afterVerified?(ctx, version, update?): Promise<void>;
  newerVersion?(ctx): Promise<{ version, tag } | undefined>;   // `outdated` without dist-tags
  prepareAgent?(ctx, version): Promise<AgentStart | undefined>; // e.g. the -agent branch with conflict markers
  validateVariant?(ctx, variant): Promise<void>;
  exclusivePerPackage?: boolean;                                // patch, fork: one graft per package
  variantExtension?: string;                                    // patch: '.patch', fork: '.json'
  variantTemplate?(input): string;                              // input: id, package, targets, root, modes, options
  scaffoldFrontmatter?(input): Record<string, unknown>;         // e.g. the fork: block (graft add flags)
}
```

Every adapter must:
1. **fail loudly on no-match;**
2. **anchor by behavior;**
3. **add variants, never rewrite them;**
4. **diff what the mechanism sees.** Upstream content always comes from the **pristine published tarball**, never the installed copy, because appliers modify the installed copy.

### The `patch` mechanism

Variants are git-style patches with package-relative paths. Each hunk must fit exactly (fuzz 0; the position may shift). A file the patch creates must not already exist upstream. The same variant works with every package manager; the *applier* decides how it is applied:

| Package manager | Default applier | How | Silent failure Graft guards against |
|---|---|---|---|
| pnpm | `pnpm` | `pnpm-workspace.yaml` `patchedDependencies[pkg]` + `ignorePatchFailures: false` | without that setting, a failed patch is only a warning |
| npm ≥ 12 | `npm` | root `patchedDependencies[pkg]` (native) | npm < 12 ignores the field silently, so the version is checked |
| npm < 12, yarn classic | `graft` (built-in) | `graft apply --installed` in `postinstall`: offline, idempotent (reverse-patch check), hardlink-safe (new inode), every installed copy | targeted installs skip `postinstall`, so `sync` applies the patch itself after installing |
| yarn 2+ | `yarn` | root `resolutions` → `patch:` protocol | built-in and patch-package appliers are refused under PnP |
| bun | `bun` | `patchedDependencies["pkg@installed"]` | bun ignores other keys, so the key is rewritten on every upgrade |
| upm | `vendor` | pristine + variant built into `.grafts/.vendor/<pkg>-<v>.tgz`; overrides and the root dependency point at it | upm never runs `postinstall`, and `--verify` "repairs" patched files |
| (opt-in) | `patch-package` | generated file + `--error-on-fail --error-on-warn` | plain patch-package exits 0 on a failed patch |

**How the package manager is detected:**
- an explicit `packageManager` field wins;
- otherwise lockfiles, in the order pnpm, npm, upm, then yarn (classic or berry) and bun;
- with no signal, npm.

`mechanisms.patch.applier` in `.grafts/config.json` overrides the choice.

**Checks that apply whatever the applier:** at the installed version, `graft check` compares installed files with *pristine + variant*, reading through PnP's zip cache where needed. It catches dropped patches, including installs with `--ignore-scripts`.

**Other patch-mechanism behavior:**
- **Likely upstreamed:** when the reverse patch applies to the pristine target, the graft is flagged "likely upstreamed".
- **Removed files:** the scoped diff lists candidate files a removed target's code moved to.

### Ecosystems (#26)

`rootstock.ecosystem` (default `npm`, so existing grafts are unchanged) selects an `Ecosystem` in core: a version scheme (semver for npm, cargo and go; PEP 440 for pypi, implemented in `@graftsync/spec` and checked against Python's `packaging` 26), the pristine source, the installed-copy lookup, and install/reinstall. Mechanisms reach it through `project.upstreamFor(graft)`, `ecosystemFor` and `schemeFor`; `project.upstream` stays as npm's source. Sync, `outdated` and `graft/duplicate-rootstock` key on `(ecosystem, package)`. The `patch` adapter picks appliers per ecosystem; none of these tools applies patch files, so each applier commits pristine + variant under `.grafts/.vendor/` and points the tool's own override at it:

| Ecosystem | Pristine | Applier | Silent failure it checks for |
|---|---|---|---|
| cargo | the `.crate` via `cargo fetch` of a throwaway package under `.grafts/.cache` | `cargo-vendor`: vendored dir + `[patch.crates-io]` (line-based TOML editor, comments kept) | `[[patch.unused]]` (cargo exits 0); `cargo metadata` must show the vendored copy |
| go | `go mod download` (verified, read-only module cache), run outside the module | `go-replace`: vendored dir + version-qualified `replace` (go.mod or go.work) | a replace for an unselected version is ignored (go build exits 0); `go list -m` must show it |
| pypi | the wheel via `pip download`, extracted with a built-in zip reader | `wheel-vendor`: repacked wheel + `[tool.uv.sources]` (uv, direct deps only) or the requirements line (pip) | pip's "already satisfied" for a rebuilt wheel (exit 0); uv's stale hash on a plain `uv lock` |

Verified with cargo 1.97, go 1.24, pip 24 and uv 0.11 against the real registries (`itoa`, `golang.org/x/sync`, `packaging`); the tests repeat it where the tool is installed (CI's runners have cargo, go and pip, not uv). The `fork` mechanism's package mode (`npm pack`) is npm only (`fork/ecosystem`). The proposal and its findings are in [`ecosystems.md`](ecosystems.md).

### The `fork` mechanism

The modification lives as commits on a fork (`fork: { repo, upstream, tag, dir?, build? }`). A variant is a JSON file `{ ref, base }`; the change is the fork's diff `tag(base)..ref`.

- **Anchors:** its hunks, located in the upstream *source* at `tag(version)`. "Likely upstreamed" uses the reverse diff.
- **Installing a version:**
  1. Rebase the diff onto the target tag in a fresh checkout.
  2. Run `build`, if set.
  3. `npm pack --ignore-scripts`, checking that it packs as `<package>@<version>`.
  4. Commit the tarball as `.grafts/.vendor/<pkg>-<version>.tgz` and install it through the same override logic as the `vendor` applier (shared code).
- **Graft never pushes to the fork.**
- **Agent path:** on a conflict, sync prepares `graft/<id>/<version>-agent` in the cache clone: git's merge of the change onto the target, with conflict markers in just the conflicting files. The agent resolves them on a fork branch, then registers a new variant.

Verified against the real `vercel/ms` repo, with a local fork, on npm and pnpm:
- `sync --version 2.1.3 --install` rebased the fork from 2.1.2 automatically and went green;
- fresh installs keep the build;
- a tampered install is caught.

**Repo mode** (`fork.install: none`, #16) covers forks that are the product (e.g. [angular-tr](https://github.com/erkamyaman/angular-tr), the Turkish angular.dev):
- The graft is *standalone* (new optional adapter hooks `standalone` / `workspace`): nothing is installed, the current version is `verified`, and a green `sync` keeps the rebased checkout as its result: as the local branch `graft/<id>/<version>` in the cache clone.
- `base` may be any upstream commit; `fork.repo` may be a local path (`.`); `.grafts/` is excluded; binary files and executable bits carry over.
- Hunks at the start or end of a file miss when upstream added lines right against them, matching git's merge.
- Targets can be upstream commits (`X+<sha>`, semver build metadata); a green result carries the fork's own `.grafts/`; a needs-agent sync prepares `graft/<id>/<version>-agent`, git's merge with conflict markers (new hooks `afterVerified` / `prepareAgent`).
- In place: one permanent variant `{ "ref": "@worktree", "base": "@verified" }`; a green sync records the verification in the result only (`recordsInResult`), and the `-agent` branch's graft.md is at the target (status conflicted), so it verifies in place. `outdated` lists repo-mode grafts from upstream tags or `fork.track` (`newerVersion`). The Action adopts results and agent branches into PRs, as a **merge** of the upstream commit the result sits on (named as `upstream` in the report), so the fork keeps upstream in its history (#22).
- A local `fork.repo` (or `upstream`) that is a partial clone is refused with `fork/partial-clone` instead of git's "repository corruption" error (#23). Like other fetch failures it reports as `needs-agent`, not as a tooling error.
- Scaffold: `graft add <id> --package <name> --mechanism fork --in-place --version <X[+sha]>` from the fork's checkout (upstream from its `upstream` remote).
- On angular-tr's real trees: a byte-identical result at its base, and exactly git's 7 conflicting files onto `v22.3.0-next.3`, with a 364-line scoped diff for the agent.
- [`examples/angular-tr`](../examples/angular-tr) is a drop-in setup, tested with the published CLI on a shallow clone against real angular/angular. Its `check-pages.mjs` (run by the agent, and in PR checks) fails when a translated page reverts to English, gains English headings or prose, loses upstream structure, or keeps conflict markers, baselined on the fork's last commit. It caught a careless conflict resolution (English merged cleanly into `deploy.md`, sections dropped from `ssr.md` and `locale-id.md`). What no check catches: an upstream wording change inside a paragraph replaced by stale Turkish.
- Also run on [ScriptedAlchemy/t3code](https://github.com/ScriptedAlchemy/t3code), a product fork of pingdotgg/t3code that merges upstream every day or two. A fork like this always takes the agent path.
  - First run (435 commits ahead, 1,635 files): in place at the merge base, `check` matched 3,975 anchors (20s). `sync` to upstream main 240 commits later was needs-agent, with markers in exactly git's 50 conflicting files (42s); even +5 commits conflicts in 2. It showed that adopting by tree swap dropped upstream from the fork's history (fixed in #22) and that partial clones failed cryptically (#23).
  - Rechecked 2026-11-10 (577 commits ahead, 1,811 files): `check` matched 5,018 anchors in 1,823 files (72s with the first upstream fetch, 12s after). `outdated` offered main's tip, 118 commits on. `sync` to it was needs-agent in 26s: 67 anchors missed in 38 files, and the `-agent` branch had markers in exactly the 28 files `git merge-tree` reports. The scoped diff was 139 files and 1,895 changed lines, against about 250,000 in upstream's full diff. After resolving, `sync` in place was green (36s), and the adopted commit's parents were the fork and upstream, with a clean `merge-tree` against upstream main and `check` green (13s). It found two gaps in the manual flow, now fixed: the needs-agent "Next" line said to write a new variant for the permanent in-place one, and committing after the green sync left graft.md `conflicted` (take the green result's tree into the open merge with `git read-tree`; the report now says so).

## 7. CLI

| Command | Behavior |
|---|---|
| `graft init [--package P] [--agent] [--skills-dir D]` | Create `.grafts/`. With `--agent`, install the skill into the project's agent skills folders (detected; fails rather than guesses) |
| `graft add <id> --package P [--target F] [--mechanism fork [--in-place \| --repo-mode] [--upstream U] [--fork-repo R] [--tag T] [--track B]]` | Scaffold `graft.md` and a variant stub that fails loudly; fork flags fill in the `fork:` block |
| `graft status` · `graft check [<id>] [--version X]` | Anchor, config and installed-copy health |
| `graft show <id>` | Intent sections, variants with resolved paths, the variant selected for the installed version |
| `graft diff <id> [from] [to]` | Scoped upstream diff |
| `graft preview <id> [--version X] [--out D]` | Apply a variant to pristine upstream and write the files for inspection |
| `graft capture <id> [--version X]` | Write the edit of the installed package as the variant (diff against pristine); replaces the scaffold stub or adds a new variant |
| `graft variant add <id> --range R --module M [--verify-version X] [--note N] [--no-narrow]` | Register a variant |
| `graft apply [<id>]` · `graft apply --installed` | Wire the package manager to the selected variants and reinstall · the built-in applier |
| `graft mark <id> [--status S] [--verified X] [--history H]` | Bookkeeping |
| `graft sync [--version X] [--install] [--dry-run]` | The deterministic first pass; writes `.grafts/.report/sync.{json,md}` |
| `graft outdated` · `graft replay <id> [--range R]` | Newer dist-tagged versions (latest, next, rc, beta; not canary), or for repo-mode forks the newest upstream tag or `fork.track` tip · static checks across every published version |

All commands take `--json` and `--root`. Exit codes: `0` ok, `1` needs attention, `2` tooling error.

## 8. The sync loop

1. **Deterministic first pass** (`graft sync`), per package:
   1. **Static checks** against the pristine target: variant selection, anchors, apply. If they fail and the graft has a `generator`, it regenerates a variant, registers it, and re-checks. A generator that exits `GRAFT_EXIT_UPSTREAMED` (3) says upstream already does the graft's job; the graft is then flagged "likely upstreamed".
   2. **Install** (`--install`), only if every graft on that package passed its static checks. Before installing, `beforeInstall` rewires the applier.
   3. **Record** (and, for repo mode, materialize the result). No tests run: behavior is the agent's, and the project CI's, to check.

   Green grafts get `verified` bumped and a History entry (in place, in the materialized result). Everything else is `needs-agent`, with reasons (missed anchors grouped by file), a scoped diff, a starting point from the adapter (`agentStart`) and the "likely upstreamed" flag when that applies. A regenerated variant that doesn't end green is rolled back. Standalone grafts sync on their own, with no install.
2. **Agent path,** taught by the skill:
   1. Read the intent with `graft show`, the anchor report and the diff.
   2. Write a new variant.
   3. Register it with `graft variant add --verify-version`.
   4. Prove it with `graft sync --install`.
   5. Write the PR description.
   6. If an invariant can't be satisfied, `graft mark --status conflicted` and a draft PR.

## 9. GitHub Action (`packages/action`)

1. **Check:** `graft check` on the installed tree (`check: fail | warn | off`). With `sync: false`, it only checks, for ordinary CI.
2. **Poll:** dist-tags, one branch per package@version.
3. **Sync:** `graft sync --install`.
   - **Green:** a PR.
   - **Needs an agent, with `agent-command` set:** run the agent with `GRAFT_PROMPT_FILE`, `GRAFT_SKILL_PATH`, `GRAFT_COMMAND`, the report paths and `GRAFT_PR_BODY_FILE`. Then **re-run sync** rather than trusting the agent. Green opens a PR; still failing opens a draft PR.
   - **Nothing to commit:** an issue, created only once.
   - **Repo-mode forks:** sync by graft id with no install; the PR branch takes Graft's rebased result (green) or the `-agent` branch (conflicts; the agent resolves in place, or a draft PR lists the files).
   - **PRs refused** (Actions may not open PRs, #18): the branch is pushed and an issue links a one-click compare page; not an error. A GitHub App token or fine-grained PAT as `github-token` avoids that and makes the PRs trigger CI.

Existing branches and issues are skipped. When there is something to sync, the action first requires a clean working tree (#24). Its branch switching and `checkout -f` / `clean -fd` otherwise discarded uncommitted work, even in `dry-run` (found running it locally on the blog), and `add -A` would commit stray files into the sync PR. This repo's workflow (`.github/workflows/graft-sync.yml`) is manual-trigger only. Its first real run (#3) found `yaml@3.0.0-2` and opened #17.

## 10. Dogfood

Graft keeps three of its own CommonJS dependencies converted to native ESM, as real grafts in `.grafts/`, verified in CI:

| Graft | Variant | Check (`pnpm test:grafts`) |
|---|---|---|
| `pacote-esm` | 15 files converted | named exports, `require()` compatibility, `manifest`/`extract`/`tarball`, the CLI |
| `semver-esm` | 50 files | 14,060-case comparison against pristine CommonJS |
| `yaml-esm` | 75 files | comparison against pristine `dist/`, including `!!binary` and warnings |

`tools/cjs-to-esm` is their `generator`. It keeps live bindings, makes export-then-require cycles lazy, avoids the dual-package hazard via `createRequire`, and refuses unfaithful cases. Every check uses `module.registerHooks` to fail if anything loads as CommonJS. yaml 3.0.0-2 (on `next`) is already native ESM: the generator exits `GRAFT_EXIT_UPSTREAMED`, so sync flags `yaml-esm` "likely upstreamed" (#17). When 3.0.0 is stable: upgrade Graft's `yaml`, confirm, mark it `upstreamed` and remove it.

## 11. Decisions since the original brief

| Original plan | Now | Why |
|---|---|---|
| `vite-transform` adapter + `@graft/vite` plugin as v1 | Removed; `patch` is the only mechanism | Out of scope by maintainer decision |
| `@graft/*` npm scope | `@graftsync/*` | `@graft` is owned by an existing npm org |
| `gray-matter` for frontmatter | `yaml` Document API | Tool edits must keep the YAML comments people wrote |
| MCP server exposing the core operations | Built, then removed; agents use the CLI (`show`, `preview`, `variant add`, `mark` added for parity) | One interface to maintain; any agent with a shell can use it. It's in git history if it's needed again |
| `apply(ctx)` | `apply(ctx, { version, outDir })` plus install hooks | Applying needs a version, and appliers need to act around installs |
| `patch` adapter = pnpm patch / patch-package | Six appliers (§6) | Each package manager drops patches silently in a different way; the defaults are the safe native option where one exists |
| Sync: anchors, then apply, then an oracle against the *installed* target | Static checks against the *pristine* target before installing | A graft that no longer fits must never break the install, and the installed copy is already patched |
| Humans mark `upstreamed` | Still, but Graft flags likely absorption | Cheap, deterministic signal (the reverse patch applies) |
| Agent-only handling of every non-green sync | Optional `generator` regenerates mechanical variants first | Generated variants (e.g. the ESM conversions) break on most releases and need no judgment |
| "Second mechanism" left for M4 | `fork` mechanism built | Forks are a common way teams carry modifications, and they test the abstraction: anchors on upstream *source* tags instead of the published package |
| Scheduled Action + publish on push | Both manual-trigger only | Maintainer preference: no unattended PRs, issues or publishes yet |
| Node 20+ | Node ≥ 22.22 / 24.15 / 26, ESM only, TypeScript 7; CI on 22, 24 and 26 with Node 24 action runtimes | Dependency requirements (vitest 5); Node 20 is end-of-life |
| pacote for pristine packages | The project's own `npm` (`npm pack`, `npm view`) | pacote was 92 of the CLI's 103 packages (#20); npm also applies the project's `.npmrc`. The CLI installs 18 packages |
| Adopt a repo-mode result by tree swap | A merge of the upstream commit the result sits on, with the result's tree (#22) | Forks that sync by merging (t3code) need upstream in their history, or the next manual merge replays it |
| npm packages only | `rootstock.ecosystem`: npm, cargo, go, pypi (#26) | The format and sync loop were never npm-specific; only the pristine source, versions, installed copy and appliers were. Each new ecosystem lands behind the `Ecosystem` interface without touching `MechanismAdapter` |
| Forks as dependencies only | Repo mode: forks that are the product, verified in place with one permanent variant (`@worktree` / `@verified`) | Translated docs sites and the like are long-lived forks with no consumer to install into (angular-tr) |
| The oracle: a per-graft command, run by sync, as the only proof | Removed (0.2). Sync checks fit (anchors, apply, install); the agent verifies the Invariants with the project's own tests | Projects already have verification tests, and a separate oracle duplicated them heavily (the blog's needed Playwright, a build and a dev server). Behavior belongs to the project's tests and CI; Graft's job is the mechanical part |
| Publish with provenance, tags per package | No provenance; one `v<version>` tag and GitHub release per release | Maintainer preference; the packages share one version |

## 12. Milestones

| Milestone | Status |
|---|---|
| M0: spec and skeleton | Done (spec draft v1 in `docs/spec.md`) |
| M1: first mechanism with a design partner | `patch` done and dogfooded on pacote/semver/yaml and tested on real `ms` projects across pnpm, npm 10/12, yarn 1/4 (PnP and node-modules), bun and upm. **Design partner pending (#5)** |
| M2: deterministic pass in CI | Done: CLI, reports, `graft check` in CI, the Action, its first real run (#3, which produced #17) |
| M3: agent path | CLI commands, skill and Action hand-off done. **Real-agent evaluation pending (#4)** |
| M4: second, unrelated mechanism | Done: `fork` (#15) with repo mode (#16), through the same adapter interface plus optional hooks. Spec reviewed and brought in line with the code; **freezing v1 is the open decision (#6)** |

## 13. Success metrics (unchanged)

- % of upstream bumps resolved by the deterministic pass alone (now including generator regeneration);
- % of agent-path syncs that land green without human edits;
- silent drift rate: variants that fit but change behavior (caught later, or not, by project tests);
- lead time from an upstream prerelease to a green graft PR.

## 14. Risks

- **Unverified behavior.** With no oracle, a variant that fits can still be wrong, and an agent can skip verifying. Mitigation: Invariants that name the tests covering them, the skill's rules (verify before recording, never weaken a test), project CI on every sync PR, differential tests where possible (as in the dogfood), and review during the eval.
- **Package-manager drift.** The silent failures in §6 are each tool's real behavior as of pnpm 10.28, npm 12.2, bun 1.4, yarn 4.18, upm 1.5, cargo 1.97, go 1.24, pip 24 and uv 0.11. New versions can change them. `graft check` (installed-copy comparison) in CI is the backstop.
- **Premature generalization.** A second mechanism now exists; the remaining risk is freezing hooks that only repo mode uses (#6).
- **Incumbents** (Renovate, Dependabot) adding agent-driven patch rebasing. Mitigation: the open spec; make them consumers of graft files.

## 15. Open work

**Released:** 0.1.0 and 0.1.1 are on npm (`@graftsync/*`, tags `v0.1.0`, `v0.1.1`). #1, #3, #15, #16 and #18 are done.

- **#4:** real-agent evaluation (needs agent and API credentials). This is the most important unanswered question. angular-tr's 7 conflicting pages are a ready test case.
- **#5:** a design partner. angular-tr is ready to pitch (`examples/angular-tr`, 0.1.1); contacting its maintainer is the owner's call.
- **#6:** freeze spec v1. The spec matches the code; the decision is whether to keep the repo-mode hooks flat or group them (see the spec review in #6).
- **#26, ecosystems beyond npm:** cargo, go and pypi are implemented for the `patch` mechanism (§6, [`ecosystems.md`](ecosystems.md)). Not yet: poetry (refused with a reason), uv for transitive dependencies (`[tool.uv.sources]` applies to direct ones only), `graft capture` for go and pypi, the `fork` mechanism's package mode outside npm (`cargo package`, a module copy, a wheel build), uv in CI (its tests are skipped there), and freezing `rootstock.ecosystem` into spec v1 (#6).
- **#17:** waiting for yaml 3.0.0 stable (retire `yaml-esm`).
- **Known gaps:**
  - regeneration when the target is already installed under pnpm falls back to an agent;
  - the built-in and patch-package appliers are untested on yarn 2+ with node-modules;
  - the skills-folder list in `graft init --agent` comes from my knowledge, not each agent's docs;
  - the Action's Claude Code `agent-command` example is untested;
  - repo mode fetches the whole upstream (angular/angular: ~680 MB, ~1 min) on every Action run; a cache or a partial clone would help;
  - fetch failures in the fork adapter (including `fork/partial-clone`) report as `needs-agent`, not `error`, so the Action may hand an environment problem to the agent;
  - the angular-tr example's `check-pages.mjs` doesn't run the docs build (it needs a full install).
- **Open questions carried over:**
  - Can one graft target several packages, or is that two grafts? (Today: one package per graft, one patch graft per package.)
  - Should upstream-authored migration notes feed the agent?
  - `graft capture` for forks (today it captures `patch` grafts from `node_modules`; a fork's change is its commits already).

## 16. Working in this repo

Agents working on Graft itself: see [`AGENTS.md`](../AGENTS.md) (commands, rules, gotchas, release flow).

```sh
pnpm install --frozen-lockfile
pnpm build                                   # tsc -b
pnpm test                                    # vitest (unit, CLI, Action with real git, yarn/PnP fixtures)
node packages/cli/dist/bin.js check          # the dogfood grafts must be applied
node packages/cli/dist/bin.js sync --quiet   # and green
pnpm test:grafts                             # and still behave like the pristine packages
pnpm lint                                    # oxlint, warnings fail
pnpm format:check                            # oxfmt; `pnpm format` rewrites
```

- **CI** (`.github/workflows/ci.yml`) runs the build, tests and graft checks on Node 22, 24 and 26 for every push and PR, and lint and format once on Node 24.
- **Releases** use Changesets; all `@graftsync/*` packages share one version. Add a changeset, version (`pnpm version-packages`, or let the Release workflow open a "Version packages" PR), then run **Release** manually: it publishes (npm stages new publishes for a few minutes), then tags `v<version>` and creates the GitHub release from the CLI changelog. Re-running Release backfills a missing tag. See the README's *Releasing* section. `@graftsync/cli` ships the root README: its `prepack` writes it in with links pointed at the `v<version>` tag (`tools/package-readme`), so those links resolve once Release has tagged.
- **Dogfood:** `pnpm install` applies the dogfood patches through pnpm. Don't edit a variant by hand; regenerate with the generator, or add a new variant with `graft variant add`.
