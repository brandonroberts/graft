# Graft — Build Handoff

> Agent-first tooling for keeping local modifications to upstream software in sync, automatically.

## 1. Problem

Teams modify upstream dependencies through patch files, vendored copies, build transforms, and forks. All of these store the modification as a diff or as code shaped to a specific upstream version. When upstream changes, the modification breaks, and a human has to notice, understand what moved, and fix it.

Coding agents can do the fixing, but nothing triggers them, nothing tells them *why* the modification exists, and nothing defines "still correct." Graft supplies those three things.

## 2. Core Concepts

- **Graft**: one local modification to an upstream package. Described by an intent file.
- **Rootstock**: the upstream package and the last version the graft was verified against.
- **Intent**: natural-language description of what the modification does and why, written for an agent to act on.
- **Mechanism**: how the modification is applied (build transform, patch file, vendored source, fork).
- **Anchors**: what the mechanism matches on in upstream code, and why each was chosen.
- **Variant**: a mechanism implementation valid for a specific upstream version range.
- **Oracle**: the command that verifies the graft's invariants still hold. The definition of a successful sync.

## 3. Goals and Non-Goals

**Goals**

- An open, agent-readable spec for describing grafts.
- Deterministic tooling that applies grafts, detects breakage, and scopes upstream changes.
- A sync loop that resolves most upstream bumps with no human or agent involvement, and hands the rest to any coding agent with full context.
- Agent-agnostic: works with Claude Code, Codex, or any agent that can use MCP tools or a CLI.

**Non-goals**

- Graft does not ship its own agent or call an LLM.
- No hosted service.
- No multi-ecosystem support in v1 (npm only).
- No automatic detection that upstream has absorbed a graft (humans mark `upstreamed` for now).
- No dependency ordering between overlapping grafts in v1 (apply in directory order).

## 4. Architecture

```
packages/
  spec/        # graft file schema, parser, validator
  core/        # deterministic operations, adapter interface
  adapters/
    vite-transform/   # v1
    patch/            # v1.1 (pnpm patch / patch-package)
  vite/        # runtime Vite plugin that loads transform grafts
  cli/         # `graft` command for humans and CI
  mcp/         # MCP server exposing core operations as agent tools
  skill/       # SKILL.md teaching agents the sync loop
  action/      # GitHub Action
```

Rule: **all logic lives in `core` and adapters.** CLI and MCP are thin front-ends over the same functions with identical behavior.

### Suggested stack

- TypeScript, pnpm workspaces, Node 20+
- Frontmatter: `gray-matter`; schema validation via a Standard Schema-compatible library
- npm tarball fetching: `pacote`
- Diffing: `diff` (jsdiff)
- AST matching: `oxc-parser` (or Babel) + `magic-string`
- Semver ranges: `semver`
- MCP: `@modelcontextprotocol/sdk`
- CLI: `citty` or `commander`

## 5. The Graft Spec

### Layout

```
.grafts/
  <graft-id>/
    graft.md          # intent file (frontmatter + body)
    variants/         # mechanism implementations, one per version range
      v20.ts
      v21.ts
    cache/            # cached derived artifacts (e.g. .patch files)
```

### `graft.md` frontmatter (illustrative)

```yaml
---
id: request-retry
rootstock:
  package: "example-http-lib"
  verified: "4.2.0"
mechanism: vite-transform
targets:
  - "dist/index.mjs"
variants:
  - range: ">=3.0.0 <4.0.0"
    module: ./variants/v3.ts
  - range: ">=4.0.0"
    module: ./variants/v4.ts
oracle:
  command: "pnpm test:grafts:request-retry"
  modes: [dev, build]
status: applied   # applied | conflicted | upstreamed | obsolete
---
```

### `graft.md` body (required sections)

```markdown
## Why
What the modification enables and why upstream doesn't do it.

## Invariants
Observable behaviors that must hold. These are what the oracle tests.

## Where to look
The upstream area involved, described by behavior, not file path.

## Anchors
What each variant matches on, and why that anchor was chosen.

## History
Short log of variants added and what changed upstream each time.
```

The body is written for an agent. "Where to look" and "Anchors" must let an agent re-locate the right code after upstream refactors.

## 6. Adapter Interface

```ts
interface MechanismAdapter {
  name: string;

  /** Apply the matching variant for the resolved upstream version. */
  apply(ctx: GraftContext): Promise<ApplyResult>;

  /** Report which anchors match/miss in the target upstream version. */
  checkAnchors(ctx: GraftContext, version: string): Promise<AnchorReport>;

  /** Diff only the upstream regions this graft targets, between two versions. */
  scopeDiff(ctx: GraftContext, from: string, to: string): Promise<ScopedDiff>;

  /** Register a new variant for a version range. Never edits existing variants. */
  recordVariant(ctx: GraftContext, variant: VariantInput): Promise<void>;
}
```

### Adapter requirements (all mechanisms)

1. **Fail loudly on no-match.** A graft that silently applies nothing is the worst failure mode. Missing anchors must be an error.
2. **Anchor by behavior.** Prefer stable exported symbols over code shapes; never regex on formatting.
3. **Add variants, don't rewrite.** Older supported version ranges keep their variants and tests.
4. **Diff what the mechanism sees.** For transforms, diff published artifacts, not upstream source.

### `vite-transform` adapter specifics

- `scopeDiff` fetches both versions' tarballs via `pacote` and diffs only the `targets` files, narrowed to regions around known anchors.
- Variants are modules exporting `{ anchors, transform(code, id) }` using AST matching + `magic-string`.
- `checkAnchors` runs each anchor's matcher against the target files without transforming.
- Must cover both Vite dev (dep optimizer prebundling may change what the transform sees) and production build.

### `@graft/vite` runtime plugin

- Loads all `vite-transform` grafts from `.grafts/`.
- Resolves the installed upstream version and selects the variant by range.
- Throws at build/dev start if no variant matches the installed version or any anchor misses.

## 7. CLI

| Command | Behavior |
|---|---|
| `graft init` | Create `.grafts/` and a starter graft. |
| `graft add <id>` | Scaffold `graft.md`, a variant stub, and an oracle test stub. |
| `graft status` | List grafts, rootstock versions, status, and anchor health against installed versions. |
| `graft check [--version X]` | Run anchor checks against installed or specified upstream version. |
| `graft diff <id> <from> <to>` | Print the scoped upstream diff. |
| `graft sync [--version X]` | Run the cheap path (below). Writes a JSON + markdown report. |
| `graft verify <id>` | Run the graft's oracle in all configured modes. |

Exit codes: `0` all green, `1` one or more grafts need agent attention, `2` tooling error. Reports go to `.grafts/.report/` for CI and agents to consume.

## 8. MCP Server Tools

| Tool | Purpose |
|---|---|
| `list_grafts` | All grafts with status and rootstock. |
| `read_graft` | Full intent file plus variant list. |
| `check_anchors` | Anchor report for a graft at a version. |
| `scope_diff` | Scoped upstream diff between two versions. |
| `apply_cached` | Apply existing variants to a version and report results. |
| `run_oracle` | Run the oracle; return pass/fail per mode with output. |
| `record_variant` | Register a variant module the agent wrote for a version range. |
| `update_status` | Set graft status and append a History entry. |

The agent writes variant code with its own editing tools. MCP tools provide context, verification, and bookkeeping only.

## 9. The Sync Loop

Triggered by a new upstream version (prerelease preferred).

1. **Cheap path (deterministic, `graft sync`)**
   1. For each graft, resolve the variant for the new version.
   2. Run `checkAnchors`. Any miss → mark for agent path.
   3. Apply and run the oracle in all modes. Any failure → mark for agent path.
   4. All green → bump `rootstock.verified`, open PR.
2. **Agent path (skill-driven)**
   1. Agent reads the graft, the anchor report, the failing oracle output, and the scoped diff.
   2. Agent locates the new equivalent code by behavior, writes a new variant for the new range.
   3. Agent runs `check_anchors` and `run_oracle` until green.
   4. Agent records the variant, appends History, opens a PR explaining what moved upstream and how the graft adapted.
   5. If invariants can't be satisfied: set `status: conflicted`, open a draft PR naming the failing invariant and what was tried.

## 10. Skill File (`packages/skill/SKILL.md`)

Teaches any agent:

- What grafts are and how to read `graft.md`.
- Always run the cheap path first; never re-derive what already passes.
- Never edit an existing variant; add a new one for the new range.
- Treat Invariants as the contract and the oracle as the only proof.
- How to write the PR description: what changed upstream, which anchors moved, how the new variant differs.
- When to stop and mark `conflicted` instead of forcing a pass.

## 11. CI Action

- Scheduled workflow polls npm dist-tags (`latest`, `next`, RC) for each rootstock package.
- On a newer version: run `graft sync`.
- Exit `0` → open PR. Exit `1` → invoke the repo's configured agent with the MCP server and skill loaded, passing the report.
- Agent invocation is configurable; the action does not assume a specific agent.

## 12. Milestones

**M0 — Spec and skeleton**
Schema, parser, validator, adapter interface, `graft init/add/status`.

**M1 — `vite-transform` adapter with a design partner**
- Pick one real project that already modifies a dependency via a Vite transform.
- Capture the modification as a graft: write Why/Invariants/Where to look/Anchors with that project's maintainer.
- Migrate the transform to AST anchors with fail-loud no-match.
- Wrap it as the variant for the currently supported upstream range.
- Build an invariant-driven e2e oracle that runs in both dev and build.
- Ship `@graft/vite`.

**M2 — Cheap path in CI**
`graft check/diff/sync/verify`, reports, GitHub Action opening PRs on green.

**M3 — Agent path**
MCP server, skill file, action handoff to agent.
Eval: replay the upstream package's historical prereleases against the graft and measure results.

**M4 — `patch` adapter with a second, unrelated project**
Proves the abstraction generalizes. Only then freeze spec v1.

## 13. Success Metrics

- % of upstream bumps resolved by the cheap path alone.
- % of agent-path syncs that land green without human edits.
- **Silent drift rate**: agent-derived variants that passed the oracle but changed behavior (found via manual review during eval). This measures whether the oracle is strong enough to trust unattended.
- Lead time: days between upstream prerelease and a green graft PR.

## 14. Risks

- **Weak oracles** let agents produce passing-but-wrong variants. Mitigation: invariant-driven e2e tests, review of agent PRs during eval.
- **Premature generalization** encodes the first design partner's shape into the spec. Mitigation: don't freeze the spec until M4.
- **Incumbents** (Renovate, Dependabot) add agent-driven patch rebasing. Mitigation: the open spec; make them consumers of graft files.

## 15. Open Questions

- Package and org name availability (`graft` on npm, GitHub, domain).
- Do adopters consume `@graft/vite` directly, or keep their own plugins that load graft variants?
- Can one graft target multiple upstream packages, or is that two grafts?
- How should overlapping grafts declare ordering once v1's directory order is insufficient?
- Should the intent spec support upstream-authored migration notes that agents read during sync?
