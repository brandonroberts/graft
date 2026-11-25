---
name: graft-sync
description: Onboard forked Kody community packages into Graft repo mode and resolve needs-agent sync runs from @brandonroberts/graft-sync.
---

# Graft Sync for Kody Forks

Use this skill when:
1. Setting up Graft on a forked Kody community package so future upstream updates stay in sync.
2. Resolving a `needs-agent` run reported by `@brandonroberts/graft-sync` (`listRuns` / `getRun`).

## 1. Onboarding a forked Kody package

1. Clone the fork locally (`kody auth setup-git` must already be configured):
   ```sh
   git clone https://kody.codes/@<you>/<leaf>.git
   cd <leaf>
   ```
2. Find the upstream `origin_commit` (from `packageGet` or the listing's `pinned_commit` when forked).
3. Scaffold the permanent in-place repo-mode graft:
   ```sh
   npx -y @graftsync/cli@latest add upstream-sync \
     --package @<origin>/<leaf> \
     --mechanism fork \
     --in-place \
     --upstream https://kody.codes/@<origin>/<leaf>.git \
     --track main \
     --version 0.0.0+<origin_commit>
   ```
4. Edit `.grafts/upstream-sync/graft.md`:
   - Fill in **Why** (the `communityFork` scope/topic rewrites plus your behavioral customizations), **Invariants** (observable behaviors + which tests cover them), **Where to look** (by behavior, not line numbers), and **Anchors**.
   - **Never write `kody:` followed by another user's `@scope/`** inside `graft.md` — Kody's publish cross-scope check scans docs too. Use plain `@<origin>/<leaf>` and `https://kody.codes/@<origin>/<leaf>.git`.
5. Run `graft sync` until it exits `0`, confirm `.grafts/.cache/` and `.grafts/.report/` are gitignored, commit, push, and publish.
6. Optionally configure a policy with `setPolicy({ forkKodyId: '@<you>/<leaf>', mode: 'branch' | 'push' | 'publish', testCommand: '...' })`.

## 2. Resolving a `needs-agent` run

1. Read the run with `getRun({ id })` — inspect `conflicts`, `reasons`, `branch` (`graft/agent-<sha>`), and `reportMd` (`.grafts/.report/sync.md`).
2. Read the fork's `.grafts/upstream-sync/graft.md` (**Why** and **Invariants**).
3. In a full local clone of the fork:
   - Fetch the pushed `-agent` branch (`git fetch origin <branch>`) and start the open merge onto upstream's `toCommit`:
     ```sh
     git merge --no-ff --no-commit -s ours --allow-unrelated-histories <toCommit>
     git read-tree -u --reset FETCH_HEAD
     ```
   - Resolve conflict markers in the listed files while preserving every Invariant. Do not weaken tests.
   - Re-verify in place with `graft sync --version <targetVersion>` (keep the permanent `./variants/fork.json` variant; do not write a new one).
   - Once green, take the verified tree (which records `status: applied` in `graft.md`) into the open merge:
     ```sh
     git fetch .grafts/.cache/fork/upstream-sync graft/upstream-sync/<targetVersion>
     git read-tree -u --reset FETCH_HEAD
     ```
   - Run the fork's own tests to prove every Invariant holds, commit to conclude the merge, push, and publish (`packagePublishExternalPush` or `repoPublishSession` with `absorbed_upstream_commit: <toCommit>`).
4. If an Invariant can no longer hold, mark the graft `conflicted` (`graft mark upstream-sync --status conflicted`) and explain why instead of forcing a pass.
