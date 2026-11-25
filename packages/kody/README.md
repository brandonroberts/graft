# @brandonroberts/graft-sync

Kody package for keeping forked Kody community packages in sync with upstream using [Graft](https://github.com/brandonroberts/graft).

## Intent

Keep local customizations on forked Kody community packages working across upstream republishes without hand-porting diffs or losing track of why each fork diverged. When an upstream listing republishes, this package runs Graft's deterministic repo-mode `fork` sync on your Kody Execution Context, adopts clean merges with full upstream git ancestry, and hands conflicts to your coding agent with a scoped upstream diff and `.grafts/` Invariants.

## How it works

1. Each forked Kody package you want managed commits `.grafts/upstream-sync/graft.md` (with **Why**, **Invariants**, **Where to look**, **Anchors**, **History**) and `.grafts/upstream-sync/variants/fork.json` (`{ "ref": "@worktree", "base": "@verified" }`).
2. When the upstream listing owner republishes, Kody delivers `community.fork.upstream_updated` to `./src/on-upstream-updated.ts` on your Execution Context (`whenOffline: "queue"`, no cloud fallback).
3. The handler clones/fetches your fork over HTTPS (`kody auth setup-git`), checks for `.grafts/`, and runs `graft sync --version <ver>+<pinned_commit> --json` directly via `kody.command.run({ file, args })` (no custom host runner script needed).
4. **Green (exit `0`):** adopts Graft's materialized result as a two-parent merge commit (keeping upstream's `pinned_commit` in git history), runs an optional `testCommand`, and pushes according to the fork's policy (`branch` by default, or `push` / `publish`).
5. **Conflicts (`needs-agent`, exit `1`):** pushes the conflict-marked `-agent` branch (`graft/agent-<short-sha>`), saves `.grafts/.report/sync.md` and conflicting paths in `packageStorage()`, and emits `@brandonroberts/graft.sync.completed` so notifier packages or agents can pick it up.
6. **Tooling errors (exit `2`):** records the failure loudly in `packageStorage()` and never pushes or publishes.

## Execution Context prerequisites

Run once on the machine registered as your Kody Execution Context:

```sh
kody login
kody auth setup-git
kody connect --name my-dev-box
kody context commands on
npm install -g @graftsync/cli
```

Then route this package's `community.fork.upstream_updated` subscription to your Execution Context (via the Kody UI or `automationExecutionSet`).

## Onboarding a forked Kody package

Right after forking a community package (`communityFork`), clone your fork locally and scaffold its in-place repo-mode graft:

```sh
git clone https://kody.codes/@you/<leaf>.git
cd <leaf>
npx -y @graftsync/cli@latest add upstream-sync \
  --package @origin/<leaf> \
  --mechanism fork \
  --in-place \
  --upstream https://kody.codes/@origin/<leaf>.git \
  --track main \
  --version 0.0.0+<origin_commit>
```

> **Important:** Never write `kody:` followed by another user's `@scope/` inside `graft.md` — Kody's publish cross-scope scan checks docs too. Use plain `@origin/<leaf>` and `https://kody.codes/@origin/<leaf>.git`.

Fill in `## Why`, `## Invariants`, `## Where to look`, and `## Anchors`, make sure `.grafts/.cache/` and `.grafts/.report/` are gitignored (created by `graft init` / `graft add`), verify with `graft sync`, and push.

## Policies (`setPolicy`)

| Field | Default | Meaning |
|---|---|---|
| `mode` | `'branch'` | `'branch'` pushes `graft/sync-<sha>`; `'push'` pushes to the default branch; `'publish'` pushes and calls `packagePublishExternalPush` (respecting `locked_at` approval URLs) |
| `testCommand` | unset | Optional shell command run in the fork checkout before pushing a green merge (e.g. `npm test`); failures abort the push and mark `needs-agent` |
| `graftCommand` | `['graft']` | Override how Graft is invoked on the Execution Context (e.g. `['npx', '-y', '@graftsync/cli@latest']`) |
| `workspaceRoot` | `~/.cache/kody-graft` | Directory on the Execution Context where full fork clones are cached |
| `pushAgentBranch` | `true` | Push `graft/agent-<sha>` with conflict markers on `needs-agent` |
| `allowZeroConflictPackageJson` | `false` | Opt-in: when the only missed anchor is `package.json` (e.g. upstream bumped `"version"` right next to `communityFork`'s `"name"` rewrite) and git's 3-way merge has zero conflicts, adopt the merge and re-verify with `graft sync` |

## Exports

- `setPolicy` / `getPolicy` / `listPolicies` / `deletePolicy` — manage per-fork sync policies in `packageStorage()`
- `listRuns` / `getRun` — inspect recent sync runs, conflicts, `approvalUrl`, and `.grafts/.report/sync.md`
- `syncFork` — trigger a manual sync for a fork against a specific upstream commit SHA

## Emitted events

- `@brandonroberts/graft.sync.completed` — subscribe from any email/Discord/notifier package in your org to get alerts on green syncs, `needs-agent` conflicts, approval URLs, or errors.

## License

MIT
