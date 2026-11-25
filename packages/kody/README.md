# @brandontroberts/sync-fork

Kody package for keeping forked Kody community packages in sync with upstream using [Graft](https://github.com/brandonroberts/graft) — **natively in Kody Cloud** (`workerd`) by default, with optional Execution Context delegation when you configure host shell commands (`testCommand` or `agentCommand`).

## Intent

Keep local customizations on forked Kody community packages working across upstream republishes without hand-porting diffs, running a local daemon, or losing track of why each fork diverged. When an upstream listing republishes, this package runs Graft's deterministic repo-mode `fork` sync directly in Kody Cloud over Git Smart HTTP (`kody.packageGetGitRemote`), adopts clean merges with full upstream two-parent git ancestry, and pushes conflict-marked `-agent` branches with a scoped upstream diff and `.grafts/` Invariants when an agent is needed.

## Quick start — hand it to your coding agent

Paste this once into Claude Code, Codex, Cursor, or any coding agent connected to Kody MCP (no Execution Context required):

````text
Set up Sync Fork (/@brandontroberts/sync-fork) in my Kody account so my forked
Kody community packages stay in sync with upstream automatically in Kody Cloud.

1. Fork `/@brandontroberts/sync-fork` into my org (`communityFork`), publish it,
   and enable its `community.fork.upstream_updated` subscription (`enablementEnable`).
   No Execution Context is needed unless I later configure `testCommand` or `agentCommand`.
2. List my forked community packages (`packageList`), diff each against its
   upstream listing, and ask me which ones to keep in sync and how (`branch`,
   `push`, or `publish`, plus optional `allowZeroConflictPackageJson`, or
   optional Execution Context `testCommand` / `agentCommand`).
3. For each fork I pick:
   - run the fork's tests first and fix any `communityFork` rewrite bugs before
     baselining it,
   - scaffold `.grafts/upstream-sync/graft.md` via `graft add --mechanism fork --in-place`
     at its `origin_commit` (using `npx -y @graftsync/cli@latest` if `graft` is not installed),
   - fill in Why, Invariants, Where to look, and Anchors (never write `kody:` +
     another user's `@scope/` in `graft.md`),
   - verify `graft sync` and the fork's tests pass, commit, push, publish, and save
     its policy via `setPolicy`.
4. Smoke-test one onboarded fork via `packageSubscriptionDispatch` and confirm
   `getRun()` shows `outcome: "green"`, `warnings: []`, and a populated `reportMd`,
   running directly in Kody Cloud.
5. Summarize what was set up and how conflicts will be handled.
````

## How it works

1. Each forked Kody package you want managed commits `.grafts/upstream-sync/graft.md` (with **Why**, **Invariants**, **Where to look**, **Anchors**, **History**) and `.grafts/upstream-sync/variants/fork.json` (`{ "ref": "@worktree", "base": "@verified" }`). Forks without `.grafts/` are safely skipped (`skipped-no-graft`).
2. When an upstream listing republishes, Kody delivers `community.fork.upstream_updated` to `./src/on-upstream-updated.ts` **in Kody Cloud** by default (no local machine required).
3. **Cloud path (default):**
   - Resolves your fork's scoped name via `packageGet` and mints a short-lived scoped write remote via `packageGetGitRemote`.
   - Fetches both your fork and the upstream public listing (`https://kody.codes/@<origin>/<leaf>.git`) in memory over Git Smart HTTP v1.
   - Evaluates Graft's repo-mode `fork` rules natively in `workerd` (fuzz-0 hunk anchors, boundary-line checks, binary/executable-mode changes, likely-upstreamed detection, and comment-preserving `GraftDocumentEditor` updates).
   - **Green:** creates a two-parent merge commit (keeping upstream's `pinned_commit` in git history, using your Kody `git_author`), pushes according to policy (`branch` by default, or `push` / `publish`), stores `reportMd` in `packageStorage()`, and dispatches `@brandontroberts/sync-fork.completed` directly.
   - **Conflicts (`needs-agent`):** performs a 3-way merge with conflict markers, updates `graft.md` to `status: conflicted`, pushes `graft/agent-<short-sha>`, saves `conflicts` + scoped diff (`reportMd`) in `packageStorage()`, and emits `@brandontroberts/sync-fork.completed`.
   - **Tooling errors:** fails loudly, records `outcome: "error"` in `packageStorage()`, and never pushes or publishes.
4. **Optional Execution Context path (`testCommand`, `agentCommand`, or `execution: "context"`):**
   - When a fork's policy configures host shell commands (`testCommand` or `agentCommand`) or sets `execution: "context"`, `./on-upstream-updated` automatically schedules `./sync-on-context` via `workflows.create` (using `executionContext` if named, else `requires: ["fs"]` with `whenOffline: "queue"`, `queueMinutes: 1440`).
   - On the Execution Context, `./sync-on-context` runs `graft sync --json` (falling back to `npx -y @graftsync/cli@latest`), optional `agentCommand` (always re-verified with `graft sync`), and optional `testCommand`, then schedules `./emit-sync-completed` on Kody Cloud to dispatch `@brandontroberts/sync-fork.completed`.
   - Host commands are never silently skipped: if scheduling `./sync-on-context` fails, the run records `outcome: "error"` loudly.

## Optional Execution Context setup (only for `testCommand` / `agentCommand`)

Skip this unless you configure `testCommand`, `agentCommand`, or `execution: "context"` on a fork policy:

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
| `execution` | `'cloud'` | `'cloud'` runs natively in Kody Cloud (`workerd`); `'context'` delegates to an Execution Context via `./sync-on-context`. Automatically `'context'` when `testCommand` or `agentCommand` is set |
| `executionContext` | unset | Optional named Execution Context for `./sync-on-context` delegation (defaults to `requires: ["fs"]`) |
| `testCommand` | unset | Optional host shell command run on an Execution Context before pushing a green merge (e.g. `node --test test/*.test.ts`); failures abort the push and mark `needs-agent` |
| `agentCommand` | unset | Optional local coding-agent command run on an Execution Context on `needs-agent` (use full binary path + headless edit flags, e.g. `/path/to/claude -p "$(cat "$GRAFT_PROMPT_FILE")" --permission-mode acceptEdits`). Always re-verified with `graft sync` + `testCommand` |
| `graftCommand` | auto (`graft`, else `npx -y @graftsync/cli@latest`) | Override how Graft is invoked on an Execution Context |
| `workspaceRoot` | `~/.cache/kody-graft` | Directory on an Execution Context where full fork clones are cached |
| `pushAgentBranch` | `true` | Push `graft/agent-<sha>` with conflict markers on `needs-agent` |
| `allowZeroConflictPackageJson` | `false` | Opt-in: when the only missed anchor is `package.json` (e.g. upstream bumped `"version"` inside `-U3` context of `communityFork`'s `"name"` rewrite) and 3-way merge has zero conflicts, adopt the merge cleanly |

## When a conflict needs your agent

Hand any `needs-agent` run to your coding agent:

```text
Check `listRuns` on `@<you>/sync-fork` and resolve the `needs-agent` sync for
`@<you>/<leaf>` following the `sync-fork` skill. Preserve every Invariant in
`graft.md`, verify with `graft sync` and the package's tests, and summarize what
changed before publishing.
```

## Exports

- `setPolicy` / `getPolicy` / `listPolicies` / `deletePolicy` — manage per-fork sync policies in `packageStorage()`
- `listRuns` / `getRun` — inspect recent sync runs, conflicts, `agentRan`, `approvalUrl`, and `.grafts/.report/sync.md` (`reportMd`)
- `syncFork` — trigger a manual sync for a fork against a specific upstream commit SHA (runs in Kody Cloud by default)
- `./on-upstream-updated` — Kody Cloud subscription handler for `community.fork.upstream_updated`
- `./sync-on-context` — Execution Context workflow export scheduled automatically when a fork configures `testCommand`, `agentCommand`, or `execution: "context"`
- `./emit-sync-completed` — Kody Cloud workflow export scheduled by Execution Context runs to dispatch `@brandontroberts/sync-fork.completed`

## Emitted events

- `@brandontroberts/sync-fork.completed` — subscribe from any email/Discord/notifier package in your org to get alerts on green syncs, `needs-agent` conflicts, approval URLs, or errors. Dispatched directly in Kody Cloud (or via `./emit-sync-completed` after Execution Context runs).

## Publishing from this repository

Trigger the manual **Release Kody package** workflow (`.github/workflows/release-kody.yml`) from the Actions tab (or `gh workflow run release-kody.yml`). It runs `packages/kody` tests and `kody dev check --offline`, mints an Artifacts git remote via `packageGetGitRemote`, pushes the `packages/kody` subtree, and runs `kody package publish`.

Required repository secret: `KODY_API_TOKEN` (a user-owned `kody_at_…` token with `package:read`, `package:write`, and `package:create` scopes).

## License

MIT
