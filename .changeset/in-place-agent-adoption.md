---
"@graftsync/core": patch
"@graftsync/adapter-fork": patch
"@graftsync/skill": patch
---

Repo mode, in place: after resolving a prepared `-agent` branch, the green sync's report now says to take its result with `git read-tree` (the checkout is already merging that upstream, so a second `git merge` is refused), so the commit records graft.md as `applied` instead of leaving it `conflicted`. The needs-agent report's "Next" line no longer tells you to write a new variant for a graft whose variant is permanent (`@worktree` / `@verified`); it gives the resolve, re-sync, take, commit steps (`agentStart.next`).
