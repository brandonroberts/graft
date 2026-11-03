# Graft

Agent-first tooling for keeping local modifications to upstream software in sync, automatically.

Teams modify upstream dependencies with patch files, vendored copies, build transforms and forks. Each of these stores the change as a diff, or as code written against one specific upstream version. When upstream releases a new version, the modification breaks. A person then has to notice, work out what moved and fix it.

Coding agents can do that fix. What's missing is something to start them, a record of *why* the modification exists, and a definition of "still correct". Graft supplies all three:

- an open spec for describing each modification (`graft.md`),
- deterministic tooling that re-verifies modifications against new upstream versions,
- a hand-off to any coding agent, with full context, for the cases the tooling can't resolve on its own.

Graft does not ship its own agent or call an LLM, and there is no hosted service.

> **Status: early development (M0 in progress).** The spec and core libraries exist. No mechanism adapter, CLI or MCP server has shipped yet. See [Roadmap](#roadmap).

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
  config.json            # optional: per-package upstream source overrides
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

Reports go to `.grafts/.report/sync.json` and `sync.md`. Exit codes: `0` all green, `1` one or more grafts need an agent, `2` tooling error.

## Packages

| Package | State | Purpose |
|---|---|---|
| [`@graft/spec`](packages/spec) | ✅ implemented | `graft.md` schema (zod), parser and validator, comment-preserving editor, starter template. |
| [`@graft/core`](packages/core) | ✅ implemented | See the list below. |
| `@graft/cli` | 🚧 scaffold only | `graft` command for humans and CI. |
| `@graft/mcp` | 🚧 scaffold only | MCP server exposing the core operations as agent tools. |
| `packages/skill` | 📝 planned | `SKILL.md` teaching agents the sync loop. |
| `packages/action` | 📝 planned | GitHub Action: poll npm dist-tags, run sync, open PRs or hand off to an agent. |
| `patch` adapter | 📝 planned | First mechanism: pnpm patch / patch-package. |

`@graft/core` contains:

- the `MechanismAdapter` interface and the project loader,
- upstream sources: the installed copy, the npm registry via pacote, or local directories,
- the oracle runner,
- scoped diffs,
- `recordVariant`, which narrows ranges and never edits existing variants,
- status, `sync`, `init`/`add` scaffolding, and `outdated`.

All logic lives in `core` and the adapters. The CLI and MCP server are thin front-ends over the same functions and behave identically.

### Writing a mechanism adapter

A mechanism plugs in by implementing `MechanismAdapter` from `@graft/core`:

```ts
interface MechanismAdapter {
  name: string;
  apply(ctx: GraftContext, options?: ApplyOptions): Promise<ApplyResult>;
  checkAnchors(ctx: GraftContext, version: string): Promise<AnchorReport>;
  scopeDiff(ctx: GraftContext, from: string, to: string): Promise<ScopedDiff>;
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
```

## Roadmap

- **M0 — Spec and skeleton:** schema, parser, validator, adapter interface, `graft init/add/status`. *(The libraries are done; the CLI is pending.)*
- **M1 — First mechanism adapter, with a design partner.** Capture one real modification as a graft, with an oracle driven by its invariants.
- **M2 — Deterministic first pass in CI:** `graft check/diff/sync/verify`, reports, and a GitHub Action that opens PRs when everything passes.
- **M3 — Agent path:** MCP server, skill file, and the action's hand-off to an agent. Evaluated by replaying historical prereleases.
- **M4 — Second, unrelated mechanism,** to prove the abstraction generalizes. Spec v1 is frozen only after this.

The original design brief is in [`docs/handoff.md`](docs/handoff.md). Since that brief was written, the Vite transform adapter and the `@graft/vite` runtime plugin it describes have been taken out of scope.

## License

MIT
