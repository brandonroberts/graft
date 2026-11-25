# @brandonroberts/graft-sync

Kody package for keeping forked Kody community packages in sync with upstream using [Graft](https://github.com/brandonroberts/graft).

## Intent

Keep local customizations on forked Kody community packages working across upstream republishes without hand-porting diffs or losing track of why each fork diverged. When an upstream listing republishes, this package runs Graft's deterministic repo-mode `fork` sync on your Kody Execution Context, adopts clean merges with full upstream git ancestry, and hands conflicts to your coding agent (either on demand or automatically via `agentCommand`) with a scoped upstream diff and `.grafts/` Invariants.

## Quick start — hand it to your coding agent

Paste this once into Claude Code, Codex, Cursor, or any coding agent connected to Kody MCP:

````text
Set up Graft Sync (/@brandonroberts/graft-sync) in my Kody account so my forked
Kody community packages stay in sync with upstream automatically.

1. Check my Kody Execution Contexts (`executionContextList`). If I don't have one
   ready with `kody auth setup-git` and host commands enabled, give me the exact
   one-time command(s) to run on my machine and wait for me.
2. Fork `/@brandonroberts/graft-sync` into my org (`communityFork`), publish it,
   and bind its `community.fork.upstream_updated` subscription to my Execution
   Context (`automationExecutionSet`).
3. List my forked community packages (`packageList`), diff each against its
   upstream listing, and ask me which ones to keep in sync and how (`branch`,
   `push`, or `publish`, plus an optional `testCommand` or `agentCommand` for
   conflicts).
4. For each fork I pick:
   - scaffold `.grafts/upstream-sync/graft.md` via `graft add --mechanism fork --in-place`
     at its `origin_commit` (using `npx -y @graftsync/cli@latest` if `graft` is not installed),
   - fill in Why, Invariants, Where to look, and Anchors (never write `kody:` +
     another user's `@scope/` in `graft.md`),
   - verify `graft sync` is green, push, publish, and save its policy via `setPolicy`.
5. Summarize what was set up and how conflicts will be handled.
````

No global `graft` install is required — if `graft` is not on `PATH`, the package automatically falls back to `npx -y @graftsync/cli@latest`.

## How it works

1. Each forked Kody package you want managed commits `.grafts/upstream-sync/graft.md` (with **Why**, **Invariants**, **Where to look**, **Anchors**, **History**) and `.grafts/upstream-sync/variants/fork.json` (`{ "ref": "@worktree", "base": "@verified" }`). Forks without `.grafts/` are safely skipped (`skipped-no-graft`).
2. When an upstream listing republishes, Kody delivers `community.fork.upstream_updated` to `./src/on-upstream-updated.ts` on your Execution Context (`whenOffline: "queue"`, no cloud fallback).
3. The handler clones/fetches your fork over HTTPS (`kody auth setup-git`) and runs `graft sync --version <ver>+<pinned_commit> --json` directly via `kody.command.run({ file, args })` (no custom host runner script needed).
4. **Green (exit `0`):** adopts Graft's materialized result as a two-parent merge commit (keeping upstream's `pinned_commit` in git history), runs an optional `testCommand`, and pushes according to the fork's policy (`branch` by default, or `push` / `publish`).
5. **Conflicts (`needs-agent`, exit `1`):**
   - If `agentCommand` is set, adopts the conflict-marked `-agent` branch, runs `agentCommand` with `GRAFT_PROMPT_FILE` and `GRAFT_REPORT_MD`, then **re-runs `graft sync`** (and `testCommand`) before concluding the merge and pushing — never trusting the agent blindly.
   - Otherwise (or if the agent did not resolve cleanly), pushes `graft/agent-<short-sha>`, saves `.grafts/.report/sync.md` and conflicting paths in `packageStorage()`, and emits `@brandonroberts/graft.sync.completed`.
6. **Tooling errors (exit `2`):** records the failure loudly in `packageStorage()` and never pushes or publishes.

## Manual Execution Context setup (one-time)

Only needed if your machine isn't already connected as a Kody Execution Context with host commands enabled:

```sh
kody login
kody auth setup-git
kody connect --name my-dev-box
kody context commands on
```

> **Important:** Never write `kody:` followed by another user's `@scope/` inside `graft.md` — Kody's publish cross-scope scan checks docs too. Use plain `@origin/<leaf>` and `https://kody.codes/@origin/<leaf>.git`.

## Policies (`setPolicy`)

| Field | Default | Meaning |
|---|---|---|
| `mode` | `'branch'` | `'branch'` pushes `graft/sync-<sha>`; `'push'` pushes to the default branch; `'publish'` pushes and calls `packagePublishExternalPush` (respecting `locked_at` approval URLs) |
| `testCommand` | unset | Optional shell command run in the fork checkout before pushing a green merge (e.g. `npm test`); failures abort the push and mark `needs-agent` |
| `agentCommand` | unset | Optional coding-agent shell command run on `needs-agent` (e.g. `claude -p "$(cat "$GRAFT_PROMPT_FILE")"`). Receives `GRAFT_PROMPT_FILE`, `GRAFT_REPORT_MD`, `GRAFT_REPORT_JSON`, `GRAFT_TARGET_VERSION`, `GRAFT_CONFLICTS`, `GRAFT_FORK_ID`, `GRAFT_UPSTREAM_ID`. Always re-verified with `graft sync` + `testCommand` |
| `graftCommand` | auto (`graft`, else `npx -y @graftsync/cli@latest`) | Override how Graft is invoked on the Execution Context |
| `workspaceRoot` | `~/.cache/kody-graft` | Directory on the Execution Context where full fork clones are cached |
| `pushAgentBranch` | `true` | Push `graft/agent-<sha>` with conflict markers on `needs-agent` |
| `allowZeroConflictPackageJson` | `false` | Opt-in: when the only missed anchor is `package.json` (e.g. upstream bumped `"version"` inside `-U3` context of `communityFork`'s `"name"` rewrite) and git's 3-way merge has zero conflicts, adopt the merge and re-verify with `graft sync` |

## When a conflict needs your agent

If you don't set `agentCommand`, hand any `needs-agent` run to your agent:

```text
Check `listRuns` on `@<you>/graft-sync` and resolve the `needs-agent` sync for
`@<you>/<leaf>` following the `graft-sync` skill. Preserve every Invariant in
`graft.md`, verify with `graft sync` and the package's tests, and summarize what
changed before publishing.
```

## Exports

- `setPolicy` / `getPolicy` / `listPolicies` / `deletePolicy` — manage per-fork sync policies in `packageStorage()`
- `listRuns` / `getRun` — inspect recent sync runs, conflicts, `agentRan`, `approvalUrl`, and `.grafts/.report/sync.md`
- `syncFork` — trigger a manual sync for a fork against a specific upstream commit SHA

## Emitted events

- `@brandonroberts/graft.sync.completed` — subscribe from any email/Discord/notifier package in your org to get alerts on green syncs, `needs-agent` conflicts, approval URLs, or errors.

## Publishing from this repository

Trigger the manual **Release Kody package** workflow (`.github/workflows/release-kody.yml`) from the Actions tab (or `gh workflow run release-kody.yml`). It runs `packages/kody` tests and `kody dev check`, pushes the `packages/kody` subtree to `https://kody.codes/@brandonroberts/graft-sync.git`, and runs `kody package publish`.

Required repository secret: `KODY_API_TOKEN` (a user-owned `kody_at_…` token with `package:read` and `package:write` scopes).

## License

MIT
