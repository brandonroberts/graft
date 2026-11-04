# Graft — Handoff

> Agent-first tooling for keeping local modifications to upstream software in sync, automatically.

This is the current handoff for the project as built (November 2026). It replaces the original design brief, which is in git history ([`docs/handoff.md` at `458f321`](https://github.com/brandonroberts/graft/blob/458f321/docs/handoff.md)). The *Decisions since the original brief* section lists every place the build differs from that plan, with the reason. The normative format is in [`docs/spec.md`](spec.md) (draft v1).

## 1. Problem

Teams modify upstream dependencies through patch files, vendored copies, build transforms and forks. All of these store the modification as a diff, or as code shaped to one upstream version. When upstream changes, the modification breaks, and a person has to notice, understand what moved and fix it.

Coding agents can do the fixing, but nothing triggers them, nothing tells them *why* the modification exists, and nothing defines "still correct". Graft supplies those three things: a scheduled trigger (the GitHub Action), the intent (`graft.md`), and the definition of success (the oracle).

## 2. Core concepts

- **Graft:** one local modification to an upstream package, described by `.grafts/<id>/graft.md`.
- **Rootstock:** the upstream package and the last version the graft was verified against (`rootstock.verified`).
- **Intent:** the `graft.md` body: Why, Invariants, Where to look, Anchors, History. It's written for an agent to act on.
- **Mechanism:** how the modification is applied. Two exist: `patch` (a diff against the published package) and `fork` (commits on a fork of the upstream source repo).
- **Applier:** for the `patch` mechanism, how a package manager is made to apply the patch (§6).
- **Anchors:** what a variant matches on in upstream code. For patches, every hunk is an anchor.
- **Variant:** one implementation of the mechanism for a version range. Variants are added, never edited.
- **Oracle:** the command that proves the Invariants still hold, run once per mode. It is the only definition of success.
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
- npm ecosystem only.
- No ordering between overlapping grafts. Two active patch grafts on one package are now an error instead (§6).
- Graft never sets `upstreamed` itself; it only *flags* likely absorption for a person to confirm.

## 4. Architecture

```
packages/
  spec/             @graftsync/spec           graft.md schema (zod), parser, validator, comment-preserving editor
  core/             @graftsync/core           project loading, adapter interface, upstream sources, oracle runner,
                                              scoped diffs, sync, replay, outdated, record/update, init/add, applyInstalled
  adapters/patch/   @graftsync/adapter-patch  the patch mechanism and its appliers
  adapters/fork/    @graftsync/adapter-fork   the fork mechanism: rebase a fork's commits per upstream tag, build, pack
  cli/              @graftsync/cli            the `graft` command, for people, CI and agents
  skill/            @graftsync/skill          SKILL.md teaching agents the sync loop through the CLI
  action/           (private)                 composite GitHub Action, plain ESM .mjs, no build step
tools/cjs-to-esm/                             converter used as the generator for the dogfood grafts
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
oracle: { command: "node .grafts/request-retry/oracle.mjs", modes: [esm, cjs], timeout: 600 }
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
- an unknown mechanism;
- two active patch grafts on the same package.

Variant selection is the first range that satisfies the version, prereleases included; use a `-0` floor for prerelease targets. Registering a variant narrows overlapping open-ended older ranges and never edits existing variants. A verify version must lie inside the new range.

The oracle runs once per mode, through a shell in the project root, with these environment variables set:
- `GRAFT_ID`, `GRAFT_DIR` and `GRAFT_MODE`;
- `GRAFT_PACKAGE` and `GRAFT_UPSTREAM_VERSION`.

Exit 0 is a pass.

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
  validateVariant?(ctx, variant): Promise<void>;
  exclusivePerPackage?: boolean;                                // patch: one graft per package
  variantExtension?: string;                                    // patch: '.patch'
  variantTemplate?(graft): string;
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

### The `fork` mechanism

The modification lives as commits on a fork (`fork: { repo, upstream, tag, dir?, build? }`). A variant is a JSON file `{ ref, base }`; the change is the fork's diff `tag(base)..ref`.

- **Anchors:** its hunks, located in the upstream *source* at `tag(version)`. "Likely upstreamed" uses the reverse diff.
- **Installing a version:**
  1. Rebase the diff onto the target tag in a fresh checkout.
  2. Run `build`, if set.
  3. `npm pack --ignore-scripts`, checking that it packs as `<package>@<version>`.
  4. Commit the tarball as `.grafts/.vendor/<pkg>-<version>.tgz` and install it through the same override logic as the `vendor` applier (shared code).
- **Graft never pushes to the fork.**
- **Agent path:** on a conflict, the agent re-applies the change on a new fork branch cut from the new tag, then registers a new variant.

Verified against the real `vercel/ms` repo, with a local fork, on npm and pnpm:
- `sync --version 2.1.3 --install` rebased the fork from 2.1.2 automatically and went green;
- fresh installs keep the build;
- a tampered install is caught.

**Repo mode** (`fork.install: none`, #16) covers forks that are the product (e.g. [angular-tr](https://github.com/erkamyaman/angular-tr), the Turkish angular.dev):
- The graft is *standalone* (new optional adapter hooks `standalone` / `workspace`): nothing is installed, the current version is `verified`, and `sync` runs the oracle in the rebased checkout, keeping the result as the local branch `graft/<id>/<version>` in the cache clone.
- `base` may be any upstream commit; `fork.repo` may be a local path (`.`); `.grafts/` is excluded; binary files and executable bits carry over.
- Hunks at the start or end of a file miss when upstream added lines right against them, matching git's merge.
- On angular-tr's real trees: a byte-identical result at its base, and exactly git's 7 conflicting files onto `v22.3.0-next.3`, with a 364-line scoped diff for the agent.

## 7. CLI

| Command | Behavior |
|---|---|
| `graft init [--package P] [--agent] [--skills-dir D]` | Create `.grafts/`. With `--agent`, install the skill into the project's agent skills folders (detected; fails rather than guesses) |
| `graft add <id> --package P [--target F]` | Scaffold `graft.md`, a variant stub that fails loudly, and an oracle stub that exits 1 |
| `graft status` · `graft check [<id>] [--version X]` | Anchor, config and installed-copy health |
| `graft show <id>` | Intent sections, variants with resolved paths, the variant selected for the installed version |
| `graft diff <id> [from] [to]` | Scoped upstream diff |
| `graft preview <id> [--version X] [--out D]` | Apply a variant to pristine upstream and write the files for inspection |
| `graft variant add <id> --range R --module M [--verify-version X] [--note N] [--no-narrow]` | Register a variant |
| `graft apply [<id>]` · `graft apply --installed` | Wire the package manager to the selected variants and reinstall · the built-in applier |
| `graft verify <id>` | Run the oracle in all modes |
| `graft mark <id> [--status S] [--verified X] [--history H]` | Bookkeeping |
| `graft sync [--version X] [--install] [--dry-run]` | The deterministic first pass; writes `.grafts/.report/sync.{json,md}` |
| `graft outdated` · `graft replay <id> [--range R]` | Newer dist-tagged versions (latest, next, rc, beta; not canary) · static checks across every published version |

All commands take `--json` and `--root`. Exit codes: `0` ok, `1` needs attention, `2` tooling error.

## 8. The sync loop

1. **Deterministic first pass** (`graft sync`), per package:
   1. **Static checks** against the pristine target: variant selection, anchors, apply. If they fail and the graft has a `generator`, it regenerates a variant, registers it, and re-checks.
   2. **Install** (`--install`), only if every graft on that package passed its static checks. Before installing, `beforeInstall` rewires the applier.
   3. **Oracle** in every mode.

   Green grafts get `verified` bumped and a History entry. Everything else is `needs-agent`, with reasons and a scoped diff, flagged "likely upstreamed" when that applies. A regenerated variant that doesn't end green is rolled back.
2. **Agent path,** taught by the skill:
   1. Read the intent with `graft show`, the anchor report, the diff and the oracle output.
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

Existing branches and issues are skipped. This repo's workflow (`.github/workflows/graft-sync.yml`) is manual-trigger only.

## 10. Dogfood

Graft keeps three of its own CommonJS dependencies converted to native ESM, as real grafts in `.grafts/`, verified in CI:

| Graft | Variant | Oracle |
|---|---|---|
| `pacote-esm` | 15 files converted | named exports, `require()` compatibility, `manifest`/`extract`/`tarball`, the CLI |
| `semver-esm` | 50 files | 14,060-case comparison against pristine CommonJS |
| `yaml-esm` | 75 files | comparison against pristine `dist/`, including `!!binary` and warnings |

`tools/cjs-to-esm` is their `generator`. It keeps live bindings, makes export-then-require cycles lazy, avoids the dual-package hazard via `createRequire`, and refuses unfaithful cases. Every oracle uses `module.registerHooks` to fail if anything loads as CommonJS. yaml 3.0.0-2 (on `next`) is already native ESM, so `yaml-esm` will be flagged "likely upstreamed" when 3.x lands.

## 11. Decisions since the original brief

| Original plan | Now | Why |
|---|---|---|
| `vite-transform` adapter + `@graft/vite` plugin as v1 | Removed; `patch` is the only mechanism | Out of scope by maintainer decision |
| `@graft/*` npm scope | `@graftsync/*` | `@graft` is owned by an existing npm org |
| `gray-matter` for frontmatter | `yaml` Document API | Tool edits must keep the YAML comments people wrote |
| MCP server exposing the core operations | Built, then removed; agents use the CLI (`show`, `preview`, `variant add`, `mark` added for parity) | One interface to maintain; any agent with a shell can use it. It's in git history if it's needed again |
| `apply(ctx)` | `apply(ctx, { version, outDir })` plus install hooks | Applying needs a version, and appliers need to act around installs |
| `patch` adapter = pnpm patch / patch-package | Six appliers (§6) | Each package manager drops patches silently in a different way; the defaults are the safe native option where one exists |
| Sync: anchors, then apply, then oracle against the *installed* target | Static checks against the *pristine* target before installing | A graft that no longer fits must never break the install, and the installed copy is already patched |
| Humans mark `upstreamed` | Still, but Graft flags likely absorption | Cheap, deterministic signal (the reverse patch applies) |
| Agent-only handling of every non-green sync | Optional `generator` regenerates mechanical variants first | Generated variants (e.g. the ESM conversions) break on most releases and need no judgment |
| "Second mechanism" left for M4 | `fork` mechanism built | Forks are a common way teams carry modifications, and they test the abstraction: anchors on upstream *source* tags instead of the published package |
| Scheduled Action + publish on push | Both manual-trigger only | Maintainer preference: no unattended PRs, issues or publishes yet |
| Node 20+ | Node ≥ 22.22 / 24.15 / 26, ESM only, TypeScript 7 | Dependency requirements (pacote 22, vitest 5); Node 20 is end-of-life |

## 12. Milestones

| Milestone | Status |
|---|---|
| M0: spec and skeleton | Done (spec draft v1 in `docs/spec.md`) |
| M1: first mechanism with a design partner | `patch` done and dogfooded on pacote/semver/yaml and tested on real `ms` projects across pnpm, npm 10/12, yarn 1/4 (PnP and node-modules), bun and upm. **Design partner pending (#5)** |
| M2: deterministic pass in CI | Done: CLI, reports, `graft check` in CI, the Action. **First real Action run pending (#3)** |
| M3: agent path | CLI commands, skill and Action hand-off done. **Real-agent evaluation pending (#4)** |
| M4: second, unrelated mechanism | The `fork` mechanism is done (#15), through the same adapter interface; it needed only small optional hooks (`scaffoldFrontmatter`, a `fork:` frontmatter block). **Freezing spec v1 is still open (#6)** |

## 13. Success metrics (unchanged)

- % of upstream bumps resolved by the deterministic pass alone (now including generator regeneration);
- % of agent-path syncs that land green without human edits;
- silent drift rate: variants that pass the oracle but change behavior;
- lead time from an upstream prerelease to a green graft PR.

## 14. Risks

- **Weak oracles** let agents produce passing-but-wrong variants. Mitigation: invariant-driven oracles, differential oracles where possible (as in the dogfood), and review during the eval.
- **Package-manager drift.** The silent failures in §6 are each tool's real behavior as of pnpm 10.28, npm 12.2, bun 1.4, yarn 4.18 and upm 1.5. New versions can change them. `graft check` (installed-copy comparison) in CI is the backstop.
- **Premature generalization.** The spec mustn't be frozen before a second mechanism exists (#6).
- **Incumbents** (Renovate, Dependabot) adding agent-driven patch rebasing. Mitigation: the open spec; make them consumers of graft files.

## 15. Open work

- **#1:** publish 0.1.0. The org and `NPM_TOKEN` are ready; run the Release workflow manually.
- **#3:** first real run of the sync Action. It needs "Allow GitHub Actions to create and approve pull requests".
- **#4:** real-agent evaluation (needs agent and API credentials). This is the most important unanswered question.
- **#5:** a design partner.
- **#6:** freeze spec v1, now that a second mechanism (`fork`, #15, with repo mode #16) exists. Review whether the adapter interface held up for both.
- **angular-tr as a live test case:** run repo mode on the real fork with its maintainer (their `list-untranslated.sh` plus the docs build as the oracle). Not contacted yet.
- **Known gaps:**
  - regeneration when the target is already installed under pnpm falls back to an agent;
  - the built-in and patch-package appliers are untested on yarn 2+ with node-modules;
  - the skills-folder list in `graft init --agent` comes from my knowledge, not each agent's docs;
  - the Action README's Claude Code `--allowedTools` example is untested.
- **Open questions carried over:**
  - Can one graft target several packages, or is that two grafts? (Today: one package per graft, one patch graft per package.)
  - Should upstream-authored migration notes feed the agent?

## 16. Working in this repo

```sh
pnpm install --frozen-lockfile
pnpm build                                   # tsc -b
pnpm test                                    # vitest (unit, CLI, Action with real git, yarn/PnP fixtures)
node packages/cli/dist/bin.js check          # the dogfood grafts must be applied
node packages/cli/dist/bin.js sync --quiet   # and green
```

- **CI** (`.github/workflows/ci.yml`) runs exactly that on Node 22 and 24 for every push and PR.
- **Releases** use Changesets. All `@graftsync/*` packages are versioned together. The Release workflow is run manually; see the README's *Releasing* section.
- **Dogfood:** `pnpm install` applies the dogfood patches through pnpm. Don't edit a variant by hand; regenerate with the generator, or add a new variant with `graft variant add`.
