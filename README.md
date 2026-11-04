# Graft

Agent-first tooling for keeping local modifications to upstream software in sync, automatically.

Teams modify upstream dependencies with patch files, vendored copies, build transforms and forks. Each of these stores the change as a diff, or as code written against one specific upstream version. When upstream releases a new version, the modification breaks. A person then has to notice, work out what moved and fix it.

Coding agents can do that fix. What's missing is something to start them, a record of *why* the modification exists, and a definition of "still correct". Graft supplies all three:

- an open spec for describing each modification (`graft.md`),
- deterministic tooling that re-verifies modifications against new upstream versions,
- a hand-off to any coding agent, with full context, for the cases the tooling can't resolve on its own.

Graft does not ship its own agent or call an LLM, and there is no hosted service.

> **Status: early development.** The spec, core, `patch` mechanism and `graft` CLI work. Graft keeps its own CommonJS dependencies converted to native ESM through its own sync loop ([dogfood](#dogfood-validation)). The MCP server, skill and GitHub Action are built. See [Roadmap](#roadmap).

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

```
.grafts/
  config.json            # optional: upstream source overrides and resolveFrom (see below)
  <graft-id>/
    graft.md             # intent file (frontmatter + body)
    variants/            # one mechanism implementation per upstream version range
    cache/               # cached derived artifacts
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
graft init [--package <pkg>]          # create .grafts/ (and a starter graft)
graft add <id> --package <pkg>        # scaffold graft.md, a variant stub, an oracle stub
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

This repo uses both on itself: [`.mcp.json`](.mcp.json) registers the server, and [`.claude/skills/graft-sync`](.claude/skills/graft-sync/SKILL.md) links the skill.

## GitHub Action

[`packages/action`](packages/action) runs the loop on a schedule:
1. Poll each rootstock package's npm dist-tags.
2. Run `graft sync --install` on a branch per package@version.
3. If green, open a PR.
4. If a graft needs an agent, run your `agent-command` (with the prompt, skill, MCP config and report), then re-run `sync` on the agent's work. Green opens a PR; still failing opens a draft PR. With no agent, or nothing to commit, it opens an issue with the report.

```yaml
      - uses: brandonroberts/graft/packages/action@main
        with:
          agent-command: ''   # optional: any agent CLI; see packages/action/README.md
```

This repo runs it on itself weekly ([`.github/workflows/graft-sync.yml`](.github/workflows/graft-sync.yml)). Its first real (dry) run found yaml **3.0.0-2** on `next`. That release is native ESM, so the `yaml-esm` patch correctly no longer applies, because upstream has absorbed the graft. The action routes that to a human through an issue.

## Mechanisms

### `patch` (pnpm)

Variants are git-style `.patch` files, as written by `pnpm patch-commit`, and pnpm applies them at install time through `patchedDependencies`.

- **Anchors:** every hunk is an anchor. Its context and removed lines must appear exactly in the target version's file, with no fuzz, though the line position may shift. A file the patch creates must not already exist upstream.
- **Config checks:** `graft check` also verifies that `pnpm-workspace.yaml` points `patchedDependencies[<pkg>]` (name-only key) at the variant selected for the installed version. It also verifies `ignorePatchFailures: false`. Without that setting, pnpm only *warns* when a patch stops applying and installs the package unmodified. `sync --install` writes both settings before installing.

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

## Roadmap

- **M0 — Spec and skeleton:** schema, parser, validator, adapter interface, `graft init/add/status`. *(Done.)*
- **M1 — First mechanism adapter, with a design partner.** Capture one real modification as a graft, with an oracle driven by its invariants. *(The `patch` adapter is done and dogfooded on pacote, semver and yaml; an external design partner is still to come.)*
- **M2 — Deterministic first pass in CI:** `graft check/diff/sync/verify`, reports, and a GitHub Action that opens PRs when everything passes. *(Done.)*
- **M3 — Agent path:** MCP server, skill file, and the action's hand-off to an agent. Evaluated by replaying historical prereleases. *(The MCP server, skill and Action hand-off are done; the historical-prerelease eval is pending.)*
- **M4 — Second, unrelated mechanism,** to prove the abstraction generalizes. Spec v1 is frozen only after this.

The original design brief is in [`docs/handoff.md`](docs/handoff.md). Since that brief was written, the Vite transform adapter and the `@graft/vite` runtime plugin it describes have been taken out of scope.

## License

MIT
