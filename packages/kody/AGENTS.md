# AGENTS.md

Guidance for coding agents working with `@brandontroberts/graft-sync`.

## What this package does

- Subscribes to `community.fork.upstream_updated` and runs Graft's repo-mode `fork` sync on the owner's Kody Execution Context via `kody.command.run({ file, args })`.
- Stores per-fork policies (`fork_policies`) and sync run history (`sync_runs`) in `packageStorage()`.
- Emits `@brandontroberts/graft.sync.completed` after every run.

## Rules

- **No `node:*` imports in `src/`.** Kody bundles `src/` for `workerd`; all host operations go through `CommandRunner` (`kody.command.run`).
- **Keep `src/sync.ts` and `src/storage.ts` pure/injectable** so Vitest can test them directly against real `git`, real `graft`, and real SQLite without Kody cloud.
- **No cross-scope `kody:` strings** anywhere in source or docs (Kody's publish check scans docs too).
- **Never claim behavior was verified unless `testCommand` or the project's tests ran and passed.** Graft checks fit, not behavior.
- **Fail loudly.** Missing commits, git errors, or failed tests must never silently push or publish.
