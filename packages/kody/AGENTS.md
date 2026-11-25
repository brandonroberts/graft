# AGENTS.md

Guidance for coding agents working with `@brandontroberts/sync-fork`.

## What this package does

- Subscribes to `community.fork.upstream_updated` and runs Graft's repo-mode `fork` sync **natively in Kody Cloud (`workerd`) by default** over Git Smart HTTP v1 (`kody.packageGetGitRemote` + public upstream `.git` remote), with no Execution Context required.
- Automatically delegates forks that configure host shell commands (`testCommand`, `agentCommand`, or `execution: 'context'`) to `./sync-on-context` on an Execution Context via `workflows.create`.
- Stores per-fork policies (`fork_policies`) and sync run history (`sync_runs`, including `reportMd`) in `packageStorage()`.
- Emits `@brandontroberts/sync-fork.completed` after every run (directly on Kody Cloud, or via `./emit-sync-completed` from Execution Context runs).

## Rules

- **No `node:*` imports in `src/`.** Kody bundles `src/` for `workerd`; cloud git/graft operations live in pure JS (`git-objects.ts`, `git-http.ts`, `merge3.ts`, `cloud-graft.ts`, `cloud-sync.ts`) and host operations go through `CommandRunner` (`kody.command.run`).
- **Use `.ts` extensions on relative imports in `src/`.** Kody resolves relative module specifiers verbatim against workspace files (`./storage.ts`, never `./storage.js`).
- **Only published npm dependencies in `package.json`.** Because `packages/kody` is published via `git subtree split`, never use `workspace:*` in `packages/kody/package.json`.
- **Keep `src/cloud-sync.ts`, `src/cloud-graft.ts`, `src/git-http.ts`, `src/route.ts`, `src/sync.ts`, `src/storage.ts`, and `src/completion-event.ts` pure/injectable** so Vitest can test them directly against real `git` (including real `git upload-pack` / `git receive-pack` HTTP), real `graft`, and real SQLite without Kody cloud.
- **No cross-scope `kody:` strings** anywhere in source or docs (Kody's publish check scans docs too).
- **Never claim behavior was verified unless `testCommand` or the project's tests ran and passed.** Graft checks fit, not behavior.
- **Fail loudly.** Missing commits, git errors, failed tests, or unschedulable host-command policies must never silently push, publish, or skip checks.
