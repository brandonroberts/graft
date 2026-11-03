# Graft

Agent-first tooling for keeping local modifications to upstream software in sync, automatically.

Teams modify upstream dependencies with patch files, vendored copies, build transforms and forks. Each of these stores the change as a diff, or as code written against one specific upstream version. When upstream releases a new version, the modification breaks. A person then has to notice, work out what moved and fix it.

Coding agents can do that fix. What's missing is something to start them, a record of *why* the modification exists, and a definition of "still correct". Graft supplies all three:

- an open spec for describing each modification (`graft.md`),
- deterministic tooling that re-verifies modifications against new upstream versions,
- a hand-off to any coding agent, with full context, for the cases the tooling can't resolve on its own.

Graft does not ship its own agent or call an LLM, and there is no hosted service.

> **Status: early development.** The spec, core, `patch` mechanism and `graft` CLI work, and Graft keeps a real modification to one of its own dependencies in sync ([dogfood](#dogfood-validation)). The MCP server, skill file and GitHub Action are not built yet. See [Roadmap](#roadmap).

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

1. **Deterministic first pass (`sync` in `@graft/core`).** For each active graft, the tool:
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

## Mechanisms

### `patch` (pnpm)

Variants are git-style `.patch` files, as written by `pnpm patch-commit`, and pnpm applies them at install time through `patchedDependencies`.

- **Anchors:** every hunk is an anchor. Its context and removed lines must appear exactly in the target version's file, with no fuzz, though the line position may shift. A file the patch creates must not already exist upstream.
- **Config checks:** `graft check` also verifies that `pnpm-workspace.yaml` points `patchedDependencies[<pkg>]` (name-only key) at the variant selected for the installed version. It also verifies `ignorePatchFailures: false`. Without that setting, pnpm only *warns* when a patch stops applying and installs the package unmodified. `sync --install` writes both settings before installing.

In a monorepo where the upstream package is declared by a workspace package rather than the root, tell Graft where to resolve it from in `.grafts/config.json`:

```json
{ "resolveFrom": { "pacote": "packages/core" } }
```

## Dogfood validation

Graft validates itself on its own CommonJS dependencies. [`.grafts/pacote-esm-named-exports`](.grafts/pacote-esm-named-exports/graft.md) is a real patch to `pacote`. pacote builds `module.exports` from inline arrow functions, which Node's CommonJS detection can't see, so `import { extract } from 'pacote'` is `undefined`. The patch turns the export object into shorthand properties so every export is available as a named ESM import. Its oracle checks that in both `esm` and `cjs` modes.

What the dogfood run has exercised, against real published pacote versions:

- `graft replay` across every release since 15.0.0: the variant applies to 18.0.5 through 22.0.1, and 18.0.4 and earlier would need their own variant.
- `graft sync --version 22.0.0 --install` and back to 22.0.1: the version changes, pnpm applies the patch, and the oracle passes.
- `graft sync --version 18.0.4 --install`: nothing is installed, the graft is handed to an agent, and the scoped diff shows exactly what moved upstream.

`@graft/core` still uses pacote's default import, because published consumers don't have this patch. semver and yaml, the other CommonJS dependencies, already expose working named imports, so they have no ESM graft.

## Packages

| Package | State | Purpose |
|---|---|---|
| [`@graft/spec`](packages/spec) | ✅ implemented | `graft.md` schema (zod), parser and validator, comment-preserving editor, starter template. |
| [`@graft/core`](packages/core) | ✅ implemented | See the list below. |
| [`@graft/cli`](packages/cli) | ✅ implemented | `graft` command for humans and CI. |
| `@graft/mcp` | 🚧 scaffold only | MCP server exposing the core operations as agent tools. |
| `packages/skill` | 📝 planned | `SKILL.md` teaching agents the sync loop. |
| `packages/action` | 📝 planned | GitHub Action: poll npm dist-tags, run sync, open PRs or hand off to an agent. |
| [`@graft/adapter-patch`](packages/adapters/patch) | ✅ implemented | First mechanism: pnpm `patchedDependencies`. |

`@graft/core` contains:

- the `MechanismAdapter` interface and the project loader,
- upstream sources: pristine package contents from the npm registry via pacote (cached), or local directories,
- the oracle runner,
- scoped diffs,
- `recordVariant`, which narrows ranges and never edits existing variants,
- status, `sync`, `init`/`add` scaffolding, `outdated`, and `replay`.

All logic lives in `core` and the adapters. The CLI and MCP server are thin front-ends over the same functions and behave identically.

### Writing a mechanism adapter

A mechanism plugs in by implementing `MechanismAdapter` from `@graft/core`:

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
- **M1 — First mechanism adapter, with a design partner.** Capture one real modification as a graft, with an oracle driven by its invariants. *(The `patch` adapter is done and dogfooded on pacote; an external design partner is still to come.)*
- **M2 — Deterministic first pass in CI:** `graft check/diff/sync/verify`, reports, and a GitHub Action that opens PRs when everything passes. *(The CLI and reports are done; the Action is pending.)*
- **M3 — Agent path:** MCP server, skill file, and the action's hand-off to an agent. Evaluated by replaying historical prereleases.
- **M4 — Second, unrelated mechanism,** to prove the abstraction generalizes. Spec v1 is frozen only after this.

The original design brief is in [`docs/handoff.md`](docs/handoff.md). Since that brief was written, the Vite transform adapter and the `@graft/vite` runtime plugin it describes have been taken out of scope.

## License

MIT
