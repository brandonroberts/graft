# Graft

Agent-first tooling for keeping local modifications to upstream software in sync, automatically.

Teams modify upstream dependencies with patch files, vendored copies, build transforms and forks. Each of these stores the change as a diff, or as code written against one specific upstream version. When upstream releases a new version, the modification breaks. A person then has to notice, work out what moved and fix it.

Coding agents can do that fix. What's missing is something to start them, a record of *why* the modification exists, and a definition of "still correct". Graft supplies all three:

- an open spec for describing each modification (`graft.md`),
- deterministic tooling that re-verifies modifications against new upstream versions,
- a hand-off to any coding agent, with full context, for the cases the tooling can't resolve on its own.

Graft does not ship its own agent or call an LLM, and there is no hosted service.

The format and tooling contract are specified in [`docs/spec.md`](docs/spec.md) (draft v1).

> **Status: early development.** The spec, core, `patch` mechanism and `graft` CLI work. Graft keeps its own CommonJS dependencies converted to native ESM through its own sync loop ([dogfood](#dogfood-validation)). The MCP server, skill and GitHub Action are built. See [Roadmap](#roadmap).

## Quick start

The flow below has been tested end to end on a real project (`ms`, adding a `fortnight` unit) with pnpm, bun and npm. The packages aren't on npm yet; until they are, install `@graftsync/cli` from packed tarballs. With bun, make the patch with `bun patch ms` / `bun patch --commit`. With npm or yarn, make it any way you like, for example by diffing a pristine copy against your edit. Graft's built-in applier applies it from `postinstall` (`graft apply` sets that up), so no extra dependency is needed.

```sh
pnpm add -D @graftsync/cli @graftsync/mcp
pnpm exec graft init --agent                                      # .grafts/, plus the MCP server and skill for agents
pnpm exec graft add ms-fortnight --package ms --target index.js   # graft.md + variant stub + oracle stub
pnpm patch ms@2.1.2                                               # edit the printed directory
pnpm patch-commit <dir> --patches-dir .grafts/tmp                 # then move the .patch onto variants/v2.patch
pnpm exec graft apply                                             # wire pnpm to the variant, reinstall, check anchors
# write Why / Invariants / Where to look / Anchors, and an oracle that fails without the graft
pnpm exec graft verify ms-fortnight
pnpm exec graft sync                                              # green
pnpm exec graft replay ms-fortnight                               # which published versions the variant fits
pnpm exec graft sync --version 2.1.3 --install                    # a real upgrade: install, verify, bump
```

## Concepts

| Term | Meaning |
|---|---|
| **Graft** | One local modification to an upstream package, described by a `graft.md` intent file. |
| **Rootstock** | The upstream package, and the last version the graft was verified against. |
| **Intent** | A plain-language description of what the modification does and why, written so an agent can act on it. |
| **Mechanism** | How the modification is applied: a patch file, a vendored copy or a fork, for example. |
| **Anchors** | What the mechanism matches on in the upstream code, and why each anchor was chosen. |
| **Variant** | One implementation of the mechanism, valid for a range of upstream versions. |
| **Oracle** | The command that checks the graft's invariants still hold. Passing it is what counts as a successful sync. |

## Graft layout

The full, normative description of this layout and of `graft.md` is in [`docs/spec.md`](docs/spec.md).

```
.grafts/
  config.json            # optional: upstream source overrides and resolveFrom (see below)
  <graft-id>/
    graft.md             # intent file (frontmatter + body)
    variants/            # one mechanism implementation per upstream version range
  .cache/                # fetched upstream tarballs (gitignored)
  .report/               # sync reports for CI and agents (gitignored)
```

### `graft.md`

```markdown
---
id: request-retry
rootstock:
  package: example-http-lib
  verified: 4.2.0
mechanism: patch
targets:
  - dist/index.mjs
variants:
  - range: ">=3.0.0 <4.0.0"
    module: ./variants/v3.patch
  - range: ">=4.0.0"
    module: ./variants/v4.patch
oracle:
  command: pnpm test:grafts:request-retry
  modes: [default]
status: applied   # applied | conflicted | upstreamed | obsolete
---

## Why
What the modification enables and why upstream doesn't do it.

## Invariants
Observable behaviors that must hold. These are what the oracle tests.

## Where to look
The upstream area involved, described by behavior, not file path.

## Anchors
What each variant matches on, and why that anchor was chosen.

## History
- 2026-11-03: Graft created against example-http-lib@4.2.0.
```

The validator enforces:

- the frontmatter schema, with valid semver versions and ranges,
- all five body sections (an empty section is a warning, a missing one is an error),
- `id` matching the directory name,
- variant ranges that don't overlap, so every version selects exactly one variant.

It also warns when `rootstock.verified` isn't covered by any variant. Prerelease versions are included when matching ranges.

## The sync loop

1. **Deterministic first pass (`sync` in `@graftsync/core`).** For each active graft, the tool:
   1. selects the variant for the target version,
   2. checks its anchors,
   3. applies it,
   4. runs the oracle in every configured mode.

   If all of that passes, it bumps `rootstock.verified` and appends a History entry. Anything that fails is marked `needs-agent`, and a scoped upstream diff is written next to the report.
2. **Agent path.** The agent reads the graft, the anchor report, the failing oracle output and the scoped diff. It writes a *new* variant for the new range, then records the variant. Existing variants are never edited: older ranges are narrowed instead. If the invariants can't be met, the agent marks the graft `conflicted`.

`sync` checks before it installs. Variant selection, anchors and apply run against the pristine published contents of the target version. The target is installed (with `--install`) only if every graft on that package passes, so a graft that no longer fits never breaks the install. The oracle then runs against the installed target.

Reports go to `.grafts/.report/sync.json` and `sync.md`. Exit codes: `0` all green, `1` one or more grafts need an agent, `2` tooling error.

## CLI

```sh
graft init [--package <pkg>] [--agent] # create .grafts/ (a starter graft; agent setup)
graft add <id> --package <pkg>        # scaffold graft.md, a variant stub, an oracle stub
graft apply [<id>]                    # wire the package manager to selected variants, reinstall
graft status                          # grafts, versions, status, anchor health
graft check [<id>] [--version X]      # anchor report against installed or X
graft diff <id> [<from>] [<to>]       # scoped upstream diff
graft sync [--version X] [--install]  # deterministic first pass; writes the report
graft verify <id>                     # run the oracle in all modes
graft outdated                        # newer dist-tagged upstream versions
graft replay <id> [--range R]         # static checks across every published version
```

Every command takes `--json` and `--root`.

## Agents: MCP server and skill

`graft-mcp` (from `@graftsync/mcp`) is a stdio MCP server over the same core operations as the CLI. It gives an agent context, verification and bookkeeping. The agent writes variant files with its own editing tools.

| Tool | Purpose |
|---|---|
| `list_grafts` | All grafts with status, rootstock and installed versions, and anchor health |
| `read_graft` | The full intent file, variants with resolved paths, and the variant selected for the installed version |
| `check_anchors` | Anchor report for a graft at a version (pristine upstream contents) |
| `scope_diff` | Upstream diff between two versions, narrowed to the graft's anchors |
| `apply_cached` | Apply existing variants to a version; modified files are written for inspection |
| `apply_to_project` | Point the package manager at each graft's selected variant, reinstall, and re-check anchors |
| `run_oracle` | Run the oracle in every mode; pass/fail and output per mode |
| `record_variant` | Register a new variant for a range. Never edits existing variants; can require anchors to match first |
| `update_status` | Set status and verified, and append History |
| `sync` | The deterministic first pass (with `install`), returning the report |

```json
{ "mcpServers": { "graft": { "command": "npx", "args": ["graft-mcp", "--root", "."] } } }
```

The [skill](packages/skill/SKILL.md) (`graft-sync`) teaches any agent the loop and its rules:
- run the deterministic first pass first;
- read the intent before changing anything;
- never edit an existing variant;
- treat the Invariants as the contract and the oracle as the only proof;
- never weaken the oracle;
- know when to stop and mark `conflicted`;
- write the PR description in the given format.

To set both up in a project, run **`graft init --agent`**. It:
- registers the server as `graft` in `.mcp.json` (`npx --no-install graft-mcp --root .`), merged with any servers already there. An existing `graft` entry is kept, since it may carry custom `env` such as proxy settings, and an `.mcp.json` that isn't valid JSON is never overwritten;
- installs the skill at `.claude/skills/graft-sync/SKILL.md`, from the `@graftsync/skill` package. Re-running updates the skill when Graft's version changes;
- notes if `@graftsync/cli` or `@graftsync/mcp` isn't a dependency yet.

For agents that don't read `.mcp.json`, point them at the same command and skill file.

**Behind a proxy.** MCP clients start stdio servers with only a small, safe set of environment variables (such as `PATH` and `HOME`), not your shell's full environment. Proxy settings therefore don't reach `graft-mcp`, and its registry fetches (pristine upstream contents, published versions) fail. Add them to the `env` block of the `graft` entry in `.mcp.json`:

```json
{
  "mcpServers": {
    "graft": {
      "command": "npx",
      "args": ["--no-install", "graft-mcp", "--root", "."],
      "env": {
        "HTTPS_PROXY": "http://proxy.example.com:8080",
        "HTTP_PROXY": "http://proxy.example.com:8080",
        "NO_PROXY": "localhost,127.0.0.1",
        "NODE_EXTRA_CA_CERTS": "/path/to/corporate-ca.pem"
      }
    }
  }
}
```

`NODE_EXTRA_CA_CERTS` is only needed when the proxy re-signs TLS with its own CA. Re-running `graft init --agent` keeps an existing `graft` entry, so this `env` survives.

This repo uses both on itself: [`.mcp.json`](.mcp.json) registers the server, and [`.claude/skills/graft-sync`](.claude/skills/graft-sync/SKILL.md) links the skill.

## GitHub Action

[`packages/action`](packages/action) runs the loop, from a scheduled or manually triggered workflow. It first runs `graft check` on the installed tree, and fails the job by default if any graft isn't actually applied. With `sync: false` it does only that, which suits ordinary CI right after install. Then:
1. Poll each rootstock package's npm dist-tags.
2. Run `graft sync --install` on a branch per package@version.
3. If green, open a PR.
4. If a graft needs an agent, run your `agent-command` (with the prompt, skill, MCP config and report), then re-run `sync` on the agent's work. Green opens a PR; still failing opens a draft PR. With no agent, or nothing to commit, it opens an issue with the report.

```yaml
      - uses: brandonroberts/graft/packages/action@main
        with:
          agent-command: ''   # optional: any agent CLI; see packages/action/README.md
```

This repo runs it on itself, triggered manually ([`.github/workflows/graft-sync.yml`](.github/workflows/graft-sync.yml)). Its first real (dry) run found yaml **3.0.0-2** on `next`. That release is native ESM, so the `yaml-esm` patch correctly no longer applies, because upstream has absorbed the graft. The action routes that to a human through an issue.

## Mechanisms

### `patch` (any package manager)

Variants are git-style `.patch` files with package-relative paths, the format `pnpm patch-commit` and `bun patch --commit` write. The same variant works with every package manager. Graft picks an *applier* from the project's package manager. An explicit `packageManager` in package.json wins. Otherwise Graft goes by lockfiles in the order **pnpm, npm, upm**, then yarn and bun, and falls back to **npm** when there's no signal. To force an applier, set `{ "mechanisms": { "patch": { "applier": "vendor" } } }` (or `pnpm`, `npm`, `bun`, `graft`, `patch-package`) in `.grafts/config.json`.

| Package manager | Default applier |
|---|---|
| pnpm | `pnpm` (native) |
| npm ≥ 12 | `npm` (native) |
| npm < 12, yarn classic | `graft` (built-in) |
| upm | `vendor` |
| bun | `bun` (native) |

- **Native appliers (pnpm, npm ≥ 12, bun):** the package manager applies the patch and records it in its lockfile. They're preferred where they exist. npm 12's is the strictest: a patch that doesn't apply, *or matches no installed package*, fails the install; it also applies with `--ignore-scripts`, and the lockfile records the patch. npm before 12 ignores `patchedDependencies` *silently*, so Graft checks the npm version (`packageManager`, else `npm --version`) and refuses the `npm` applier below 12.
- **The vendored override applier (`vendor`):** the default for upm, and the most universal option. It works with any package manager that supports `file:` overrides, with no install hooks at all. Graft builds *pristine upstream + the selected variant* into `.grafts/.vendor/<pkg>-<version>.tgz` and commits it. It then points the package manager at that tarball through its overrides (npm, bun and upm `overrides`, yarn `resolutions`, pnpm's overrides) and through the root's own dependency. The package manager installs the patched package as an ordinary dependency:
  - **in the lockfile:** recorded there with the tarball's integrity;
  - **durable:** it survives fresh installs, `--ignore-scripts`, and verify/"repair" passes;
  - **tree-wide:** it reaches every copy in the dependency tree.

  Tarballs are reproducible, with sorted entries and fixed timestamps and owners. Graft only rewrites one when its *contents* change, so lockfile integrity stays stable. On an upgrade it rebuilds from the new pristine version and asks `sync` for a bare reinstall, because a targeted `add <pkg>@<version>` would undo the override. The cost: tarballs are committed binary files, and the root dependency reads `file:.grafts/.vendor/…` instead of a version range.
- **The built-in applier (`graft`):** the default for npm before 12 and yarn classic, and usable with any package manager that installs into `node_modules` and runs the project's `postinstall`. `graft apply --installed` runs in `postinstall` and patches every installed copy of the package that a variant covers, hoisted or nested. It is:
  - **offline:** it patches the installed file itself;
  - **idempotent:** a file whose *reverse* patch fits is already patched;
  - **store-safe:** it replaces files by rename (a new inode) instead of editing in place. pnpm, bun and some npm setups hardlink `node_modules` files to a shared global store, so editing in place would patch every project on the machine;
  - **strict:** it fails the install if the copy the project resolves isn't covered, or any patch doesn't fit, and it never leaves a copy half-patched.

  `sync --install` also runs it right after installing, because package managers don't run the project's `postinstall` on a targeted install.

| Package manager | How the selected variant is applied | Silent failure Graft prevents |
|---|---|---|
| pnpm | `pnpm-workspace.yaml` `patchedDependencies[<pkg>]` (name-only key) | Without `ignorePatchFailures: false`, a patch that stops applying is only a *warning*, and the package installs unmodified |
| bun | `package.json` `patchedDependencies["<pkg>@<installed>"]` | bun ignores name-only keys and keys for other versions, so an upgrade installs unpatched. Graft rewrites the key before every version change |
| npm ≥ 12 (`npm`, native) | package.json `patchedDependencies[<pkg>]` (name-only key) | npm < 12 ignores the field, so the project would install unpatched with no error. Graft refuses the native applier below npm 12 and falls back to the built-in one |
| npm < 12, yarn classic, anything else (`graft`, built-in) | `graft apply --installed` in `postinstall` | npm and pnpm skip the project's `postinstall` on a targeted install (`npm install ms@2.1.3`), so `sync --install` applies the variant itself after installing |
| upm, or anything with overrides (`vendor`) | `.grafts/.vendor/<pkg>-<version>.tgz` via overrides + the root dependency | upm never runs the project's `postinstall`, and `upm install --verify` silently "repairs" patched files. npm resolves `file:` overrides relative to each *dependent* and keeps stale nested lock entries, so Graft uses npm's `$<pkg>` reference and drops the package's lock entries before reinstalling |
| opt-in (`patch-package`) | A generated `.grafts/.patch-package/<pkg>+<version>.patch` (paths rewritten for patch-package), applied by `patch-package --patch-dir .grafts/.patch-package --error-on-fail --error-on-warn` in `postinstall` | Plain `patch-package` exits 0 on a failed patch outside CI, and only warns on a version mismatch. Graft renames the derived file on every version change and re-runs the bare install that triggers `postinstall` |

- **Anchors:** every hunk is an anchor. Its context and removed lines must appear exactly in the target version's file, with no fuzz, though the line position may shift. A file the patch creates must not already exist upstream.
- **Config checks:** at the installed version, `graft check` reports any configuration that would apply something other than the selected variant, or fail silently. `graft apply` and `sync --install` write the configuration.
- **Installed-copy check:** at the installed version, `graft check` also compares each patched file in `node_modules` with *pristine upstream + the selected variant*. It fails if they differ, whatever the configuration says.

Each row of the table was verified against the real package manager on a real project (`ms`): install, `graft apply`, `sync`, an upgrade to a new `ms` version with `--install`, and a tampered install. The built-in applier was also verified on npm, yarn 1.22, bun, and pnpm (forced via the config override), including a second install to check idempotency. Under pnpm, every file in the content-addressed store still matched its hash afterwards. The vendored override applier was verified on upm (its default) and, forced, on npm, yarn 1.22, pnpm and bun. Each run covered a fresh install, a real upgrade, and a fresh install after the upgrade; npm also covered `--ignore-scripts`, and upm `install --verify`. The silent failures in the table are each package manager's real behavior today: pnpm 10.28, bun 1.4.4, patch-package 8.0.1, upm 1.5.1.

**Installs that skip scripts.** `--ignore-scripts` skips `postinstall`, and with it the built-in and patch-package appliers. The native and vendored appliers don't depend on scripts. Run `graft check` in CI after installing. The GitHub Action does this by default; use `sync: false` for check-only. It compares installed files with pristine upstream + the selected variant, so it fails the build however the patch was skipped.

In a monorepo where the upstream package is declared by a workspace package rather than the root, tell Graft where to resolve it from in `.grafts/config.json`:

```json
{ "resolveFrom": { "pacote": "packages/core", "yaml": "packages/spec" } }
```

## Dogfood validation

Graft validates itself on its own CommonJS dependencies. Three grafts convert **pacote**, **semver** and **yaml** to native ESM in this repo, so no CommonJS loads from those packages. Each is a whole-package `patch` variant. Graft's own build, tests and CLI run on the converted packages.

| Graft | Package | Files converted | Oracle |
|---|---|---|---|
| [`semver-esm`](.grafts/semver-esm/graft.md) | semver 7.8.6 | 50 | Differential test against the pristine CommonJS release: 14,060 cases over every public function and class |
| [`yaml-esm`](.grafts/yaml-esm/graft.md) | yaml 2.9.1 | 75 | Differential test against pristine `dist/`: parse/stringify, documents, YAML 1.1 types (`!!binary` stays a `Buffer`), errors and warnings, lexer/CST |
| [`pacote-esm`](.grafts/pacote-esm/graft.md) | pacote 22.0.1 | 15 | Named exports, `require()` compatibility, `manifest`/`extract`/`tarball` end to end, and the CLI |

Every oracle runs in `esm` and `cjs` modes. It uses Node's `module.registerHooks` to record the format of every module loaded from the package, and fails if any loaded as CommonJS.

The variants are generated by [`tools/cjs-to-esm`](tools/cjs-to-esm) from the pristine tarball:

```sh
node tools/cjs-to-esm/make-variant.mjs <package> <version> .grafts/<id>/variants/<name>.patch
```

Each graft declares that command as its `generator:` (with `{version}` and `{out}` placeholders), so when a release makes the variant miss, `graft sync` regenerates and registers a new variant itself, and keeps it only if the oracle passes. Otherwise it rolls back and hands the graft to an agent.

The converter keeps the CommonJS semantics that consumers can observe:

- Each file's `module.exports` value is exported as `default`, as named exports, and as `'module.exports'`, so `require()` from CommonJS (Node's require-ESM support) still returns the same value. pacote's CommonJS dependencies keep using ESM semver this way.
- Top-level relative requires become live `import` bindings.
- A require that sits in a cycle *after* `module.exports =` becomes a lazy, on-demand require. This is the CommonJS export-then-require idiom: semver's Range/Comparator pair, and pacote's Fetcher base requiring its subclasses.
- Requires of *other* packages stay `require()` calls through `createRequire`, so a dual package such as minipass is never loaded twice.
- The converter refuses to convert, loudly, anything it can't translate faithfully.

What the dogfood run found:

- **Real bugs, caught by the oracles before anything was committed:** minipass's dual-package entry; pacote's export-then-require cycle (`Fetcher` used before initialization); and the converter turning `new X(…)` into `new getter()(…)` (4,390 semver mismatches).
- **`graft replay` with the ranges widened:** yaml's variant applies unchanged to 2.8.0 through 2.9.1. semver's applies only to 7.8.6, because 7.8.6 added a file and changed `range.js`. pacote's applies to 22.x, because 22.0.0 rewrote `lib/dir.js`. Those releases go to the agent path instead of being silently mis-patched.
- **Earlier dogfood, against real releases:** `graft sync --install` across pacote versions, and a hand-off to an agent with no install when the patch no longer fit.

`@graftsync/core` still imports these packages in ways that work without the patches, because published consumers don't have them.

## Packages

| Package | State | Purpose |
|---|---|---|
| [`@graftsync/spec`](packages/spec) | ✅ implemented | `graft.md` schema (zod), parser and validator, comment-preserving editor, starter template. |
| [`@graftsync/core`](packages/core) | ✅ implemented | See the list below. |
| [`@graftsync/cli`](packages/cli) | ✅ implemented | `graft` command for humans and CI. |
| [`@graftsync/mcp`](packages/mcp) | ✅ implemented | MCP server (`graft-mcp`) exposing the core operations as agent tools. |
| [`@graftsync/skill`](packages/skill) | ✅ implemented | [`SKILL.md`](packages/skill/SKILL.md) teaching agents the sync loop. |
| [`packages/action`](packages/action) | ✅ implemented | GitHub Action: poll npm dist-tags, run sync, open PRs, and hand failures to your agent. |
| [`@graftsync/adapter-patch`](packages/adapters/patch) | ✅ implemented | First mechanism: pnpm `patchedDependencies`. |

`@graftsync/core` contains:

- the `MechanismAdapter` interface and the project loader,
- upstream sources: pristine package contents from the npm registry via pacote (cached), or local directories,
- the oracle runner,
- scoped diffs,
- `recordVariant`, which narrows ranges and never edits existing variants,
- status, `sync`, `init`/`add` scaffolding, `outdated`, and `replay`.

All logic lives in `core` and the adapters. The CLI and MCP server are thin front-ends over the same functions and behave identically.

### Writing a mechanism adapter

A mechanism plugs in by implementing `MechanismAdapter` from `@graftsync/core`:

```ts
interface MechanismAdapter {
  name: string;
  apply(ctx: GraftContext, options?: ApplyOptions): Promise<ApplyResult>;
  checkAnchors(ctx: GraftContext, version: string): Promise<AnchorReport>;
  scopeDiff(ctx: GraftContext, from: string, to: string): Promise<ScopedDiff>;
  beforeInstall?(ctx: GraftContext, version: string): Promise<void>;
  validateVariant?(ctx: GraftContext, variant: ResolvedVariant): Promise<void>;
  variantTemplate?(graft: { id: string; targets?: string[]; package: string }): string;
}
```

Every adapter must follow these rules:

1. **Fail loudly on no-match.** An anchor that's missing or matches ambiguously is an error. A graft must never silently apply nothing.
2. **Anchor by behavior.** Prefer stable exported symbols over the shape of the code, and never match on formatting.
3. **Add variants, don't rewrite them.** Older version ranges keep their variants and tests.
4. **Diff what the mechanism sees.** Diff published artifacts, not upstream source.

## Development

Requires Node 22.22+, 24.15+, or 26+ and pnpm 10. All Graft packages are ESM only: import them with `import`; `require()` is not supported.

```sh
pnpm install
pnpm build      # tsc -b across the workspace
pnpm test       # vitest
pnpm graft status
```

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets). All `@graftsync/*` packages are versioned together.

1. With a user-facing change, run `pnpm changeset`, pick a bump, describe the change, and commit the generated `.changeset/*.md` with your PR.
2. On every push to `main`, the Release workflow (`.github/workflows/release.yml`) opens or updates a "Version packages" PR that bumps versions and writes changelogs (`pnpm version-packages`).
3. Merging that PR runs `pnpm release` (build, then `changeset publish`), which publishes every version not yet on npm, with provenance, and tags it.

Two one-time steps need a maintainer before anything is published (until then the workflow skips the release step):

- Create the `graftsync` organization on npm.
- Add an npm automation token that can publish to it as the `NPM_TOKEN` repository secret.

The packages start at 0.1.0, which is not on npm yet, so the first run after those steps publishes 0.1.0 as is.

## Roadmap

- **M0 — Spec and skeleton:** schema, parser, validator, adapter interface, `graft init/add/status`. *(Done.)*
- **M1 — First mechanism adapter, with a design partner.** Capture one real modification as a graft, with an oracle driven by its invariants. *(The `patch` adapter is done and dogfooded on pacote, semver and yaml; an external design partner is still to come.)*
- **M2 — Deterministic first pass in CI:** `graft check/diff/sync/verify`, reports, and a GitHub Action that opens PRs when everything passes. *(Done.)*
- **M3 — Agent path:** MCP server, skill file, and the action's hand-off to an agent. Evaluated by replaying historical prereleases. *(The MCP server, skill and Action hand-off are done; the historical-prerelease eval is pending.)*
- **M4 — Second, unrelated mechanism,** to prove the abstraction generalizes. Spec v1 is frozen only after this.

The original design brief is in [`docs/handoff.md`](docs/handoff.md). Since that brief was written, the Vite transform adapter and the `@graft/vite` runtime plugin it describes have been taken out of scope.

## License

MIT
