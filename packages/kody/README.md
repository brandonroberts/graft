# @brandontroberts/sync-fork

Kody package for keeping forked Kody community packages in sync with upstream using [Graft](https://github.com/brandonroberts/graft).

## Intent

Keep local customizations on forked Kody community packages working across upstream republishes without hand-porting diffs or losing track of why each fork diverged. When an upstream listing republishes, this package runs Graft's deterministic repo-mode `fork` sync on your Kody Execution Context, adopts clean merges with full upstream git ancestry, and hands conflicts to your coding agent (either on demand or automatically via `agentCommand`) with a scoped upstream diff and `.grafts/` Invariants.

## Quick start — hand it to your coding agent

Paste this once into Claude Code, Codex, Cursor, or any coding agent connected to Kody MCP:

````text
Set up Sync Fork (/@brandontroberts/sync-fork) in my Kody account so my forked
Kody community packages stay in sync with upstream automatically.

1. Check my Kody Execution Contexts (`executionContextList`). If I don't have one
   ready with `kody auth setup-git` and host commands enabled, give me the exact
   one-time command(s) to run on my machine and wait for me.
2. Fork `/@brandontroberts/sync-fork` into my org (`communityFork`), publish it,
   enable its `community.fork.upstream_updated` subscription (`enablementEnable`),
   and route that subscription to my Execution Context (`automationExecutionSet`
   with `context: "<my-context>"`, `whenOffline: "queue"`, `queueMinutes: 1440`).
3. List my forked community packages (`packageList`), diff each against its
   upstream listing, and ask me which ones to keep in sync and how (`branch`,
   `push`, or `publish`, plus an optional `testCommand` or `agentCommand` for
   conflicts).
4. For each fork I pick:
   - scaffold `.grafts/upstream-sync/graft.md` via `graft add --mechanism fork --in-place`
     at its `origin_commit` (using `npx -y @graftsync/cli@latest` if `graft` is not installed),
   - fill in Why, Invariants, Where to look, and Anchors (never write `kody:` +
     another user's `@scope/` in `graft.md`),
   - verify `graft sync` and the fork's tests pass, commit, push, publish, and save
     its policy via `setPolicy`.
5. Smoke-test one onboarded fork via `packageSubscriptionDispatch` and confirm
   `getRun()` shows `outcome: "green"`, `warnings: []`, and a populated `reportMd`,
   and that the `./emit-sync-completed` cloud workflow completed.
6. Summarize what was set up and how conflicts will be handled.
````

No global `graft` install is required — if `graft` is not on `PATH`, the package automatically falls back to `npx -y @graftsync/cli@latest`.

## How it works

1. Each forked Kody package you want managed commits `.grafts/upstream-sync/graft.md` (with **Why**, **Invariants**, **Where to look**, **Anchors**, **History**) and `.grafts/upstream-sync/variants/fork.json` (`{ "ref": "@worktree", "base": "@verified" }`). Forks without `.grafts/` are safely skipped (`skipped-no-graft`).
2. When an upstream listing republishes, Kody delivers `community.fork.upstream_updated` to `./src/on-upstream-updated.ts` on your Execution Context (`requires: ["fs"]`, `whenOffline: "queue"`, `queueMinutes: 1440` — skips Kody cloud). If your Execution Context isn't in your org's default fallback chain, pin it explicitly with `automationExecutionSet`.
3. The handler resolves your fork's scoped name via `packageGet`, clones/fetches over HTTPS (`kody auth setup-git`), runs `graft sync --version <ver>+<pinned_commit> --json` directly via `kody.command.run({ file, args })` (falling back to `npx -y @graftsync/cli@latest` when `graft` is not on `PATH`), and stores `.grafts/.report/sync.md` (`reportMd`) in `packageStorage()` for every run.
4. **Green (exit `0`):** adopts Graft's materialized result as a two-parent merge commit (keeping upstream's `pinned_commit` in git history), runs an optional `testCommand`, and pushes according to the fork's policy (`branch` by default, or `push` / `publish`).
5. **Conflicts (`needs-agent`, exit `1`):**
   - If `agentCommand` is set, adopts the conflict-marked `-agent` branch, runs `agentCommand` with `GRAFT_PROMPT_FILE` and `GRAFT_REPORT_MD`, verifies no conflict markers remain, then **re-runs `graft sync`** (and `testCommand`) before concluding the merge and pushing — never trusting the agent blindly.
   - Otherwise (or if the agent did not resolve cleanly), pushes `graft/agent-<short-sha>` and saves conflicting paths + `reportMd` in `packageStorage()`.
6. **Tooling errors (exit `2`):** records the failure loudly in `packageStorage()` and never pushes or publishes.
7. **Completion event:** after persisting the run, emits `@brandontroberts/sync-fork.completed` (directly on cloud, or by scheduling `./emit-sync-completed` on Kody Cloud via `workflows.create` when running on a local Execution Context, where Kody disables `events.dispatch`).

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
| `testCommand` | unset | Optional shell command run in the fork checkout before pushing a green merge (e.g. `node --test test/*.test.ts`); failures abort the push and mark `needs-agent` |
| `agentCommand` | unset | Optional coding-agent shell command run on `needs-agent` (e.g. `claude -p "$(cat "$GRAFT_PROMPT_FILE")"`). Receives `GRAFT_PROMPT_FILE`, `GRAFT_REPORT_MD`, `GRAFT_REPORT_JSON`, `GRAFT_TARGET_VERSION`, `GRAFT_CONFLICTS`, `GRAFT_FORK_ID`, `GRAFT_UPSTREAM_ID`. Always re-verified with `graft sync` + `testCommand` |
| `graftCommand` | auto (`graft`, else `npx -y @graftsync/cli@latest`) | Override how Graft is invoked on the Execution Context |
| `workspaceRoot` | `~/.cache/kody-graft` | Directory on the Execution Context where full fork clones are cached |
| `pushAgentBranch` | `true` | Push `graft/agent-<sha>` with conflict markers on `needs-agent` |
| `allowZeroConflictPackageJson` | `false` | Opt-in: when the only missed anchor is `package.json` (e.g. upstream bumped `"version"` inside `-U3` context of `communityFork`'s `"name"` rewrite) and git's 3-way merge has zero conflicts, adopt the merge and re-verify with `graft sync` |

## When a conflict needs your agent

If you don't set `agentCommand`, hand any `needs-agent` run to your agent:

```text
Check `listRuns` on `@<you>/sync-fork` and resolve the `needs-agent` sync for
`@<you>/<leaf>` following the `sync-fork` skill. Preserve every Invariant in
`graft.md`, verify with `graft sync` and the package's tests, and summarize what
changed before publishing.
```

## Exports

- `setPolicy` / `getPolicy` / `listPolicies` / `deletePolicy` — manage per-fork sync policies in `packageStorage()`
- `listRuns` / `getRun` — inspect recent sync runs, conflicts, `agentRan`, `approvalUrl`, and `.grafts/.report/sync.md` (`reportMd`)
- `syncFork` — trigger a manual sync for a fork against a specific upstream commit SHA
- `./on-upstream-updated` — subscription handler for `community.fork.upstream_updated`
- `./emit-sync-completed` — Kody Cloud workflow export scheduled by `./on-upstream-updated` to dispatch `@brandontroberts/sync-fork.completed` from local Execution Context runs

## Emitted events

- `@brandontroberts/sync-fork.completed` — subscribe from any email/Discord/notifier package in your org to get alerts on green syncs, `needs-agent` conflicts, approval URLs, or errors. Emitted via `./emit-sync-completed` on Kody Cloud after every Execution Context run.

## Publishing from this repository

Trigger the manual **Release Kody package** workflow (`.github/workflows/release-kody.yml`) from the Actions tab (or `gh workflow run release-kody.yml`). It runs `packages/kody` tests and `kody dev check --offline`, mints an Artifacts git remote via `packageGetGitRemote`, pushes the `packages/kody` subtree, and runs `kody package publish`.

Required repository secret: `KODY_API_TOKEN` (a user-owned `kody_at_…` token with `package:read`, `package:write`, and `package:create` scopes).

## License

MIT
