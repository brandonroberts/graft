---
name: graft-sync
description: Set up @brandontroberts/graft-sync in Kody, onboard forked Kody community packages into Graft repo mode, configure sync policies (including agentCommand), and resolve needs-agent sync runs.
---

# Graft Sync for Kody Forks

Use this skill when:
1. Setting up Graft Sync in a user's Kody account for the first time.
2. Onboarding forked Kody community packages into Graft repo mode.
3. Resolving a `needs-agent` run reported by `graft-sync` (`listRuns` / `getRun`).

## 1. Account setup (first time)

1. Check Execution Contexts (`executionContextList`). Verify one context is online with host commands enabled (`commands.enabled`) and `kody auth setup-git` configured.
   - If not, give the user the exact one-time commands to run on their machine (`kody login`, `kody auth setup-git`, `kody connect --name <name>`, `kody context commands on`) and wait — only the machine owner can turn host commands on.
2. Fork `/@brandontroberts/graft-sync` into the user's org (`communityFork`), review, and publish it (becomes `@<you>/graft-sync`).
3. Route `@<you>/graft-sync`'s `community.fork.upstream_updated` subscription to the user's Execution Context with `automationExecutionSet`.
4. No global `graft` install is required: `@<you>/graft-sync` uses `graft` when on `PATH` and automatically falls back to `npx -y @graftsync/cli@latest`.

## 2. Onboarding forked Kody packages

1. List forked packages (`packageList`), inspect how each diverges from its upstream listing, and confirm with the user which forks to track and what policy each should use (`branch` default, `push`, or `publish`, plus optional `testCommand`, `agentCommand`, or `allowZeroConflictPackageJson`).
2. For each selected fork:
   - Clone locally (`git clone https://kody.codes/@<you>/<leaf>.git`).
   - Find its `origin_commit` (from `packageGet` or the listing's `pinned_commit` when forked).
   - Scaffold the permanent in-place repo-mode graft:
     ```sh
     npx -y @graftsync/cli@latest add upstream-sync \
       --package @<origin>/<leaf> \
       --mechanism fork \
       --in-place \
       --upstream https://kody.codes/@<origin>/<leaf>.git \
       --track main \
       --version 0.0.0+<origin_commit>
     ```
   - Edit `.grafts/upstream-sync/graft.md`:
     - Fill in **Why** (the `communityFork` scope/topic rewrites plus behavioral customizations), **Invariants** (observable behaviors + which tests cover them), **Where to look** (by behavior, not line numbers), and **Anchors**.
     - **Never write `kody:` followed by another user's `@scope/`** inside `graft.md` — Kody's publish cross-scope check scans docs too. Use plain `@<origin>/<leaf>` and `https://kody.codes/@<origin>/<leaf>.git`.
   - Run `npx -y @graftsync/cli@latest sync` until it exits `0`, confirm `.grafts/.cache/` and `.grafts/.report/` are gitignored, commit, push, and publish.
   - Save the chosen policy via `setPolicy({ forkKodyId: '@<you>/<leaf>', ... })`.

## 3. Resolving a `needs-agent` run

1. Read the run with `getRun({ id })` — inspect `conflicts`, `reasons`, `branch` (`graft/agent-<sha>`), and `reportMd` (`.grafts/.report/sync.md`).
2. Read the fork's `.grafts/upstream-sync/graft.md` (**Why** and **Invariants**).
3. In a full local clone of the fork:
   - Fetch the pushed `-agent` branch (`git fetch origin <branch>`) and start the open merge onto upstream's `toCommit`:
     ```sh
     git merge --no-ff --no-commit -s ours --allow-unrelated-histories <toCommit>
     git read-tree -u --reset FETCH_HEAD
     ```
   - Resolve conflict markers in the listed files while preserving every Invariant. Do not weaken tests.
   - Re-verify in place with `npx -y @graftsync/cli@latest sync --version <targetVersion>` (keep the permanent `./variants/fork.json` variant; do not write a new one).
   - Once green, take the verified tree (which records `status: applied` in `graft.md`) into the open merge:
     ```sh
     git fetch .grafts/.cache/fork/upstream-sync graft/upstream-sync/<targetVersion>
     git read-tree -u --reset FETCH_HEAD
     ```
   - Run the fork's own tests to prove every Invariant holds, commit to conclude the merge, push, and publish (`packagePublishExternalPush` or `repoPublishSession` with `absorbed_upstream_commit: <toCommit>`).
4. If an Invariant can no longer hold, mark the graft `conflicted` (`graft mark upstream-sync --status conflicted`) and explain why instead of forcing a pass.
