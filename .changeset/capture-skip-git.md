---
'@graftsync/adapter-patch': patch
---

Skip `.git` directories and `.git` gitdir files in `graft capture` so capturing from git-sourced dependencies (such as Cargo `[patch.crates-io]` git checkouts, Go `replace` clones, or submodules/worktrees) does not fail on `.git/index` or `.git/objects/pack/*` (#103).
