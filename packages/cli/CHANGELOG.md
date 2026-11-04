# @graftsync/cli

## 0.1.1

### Patch Changes

- `graft add --mechanism fork --in-place` scaffolds a repo-mode graft from inside a fork that is the product: `repo: .`, `install: none`, the upstream from the checkout's `upstream` remote (or `--upstream`), the permanent `{ "@worktree", "@verified" }` variant, and an oracle run from `$GRAFT_DIR`. `--repo-mode`, `--fork-repo`, `--tag` and `--track` fill in the rest.
- Generators can report that upstream already does what the graft did: exit `GRAFT_EXIT_UPSTREAMED` (3) and `graft sync` reports the graft as likely upstreamed instead of a plain needs-agent.
- A failed generator is reported with its error message, not the tail of its stack trace.
- Missed anchors are summarized per file in sync reports, with long lists cut.
- The graft-sync skill covers scaffolding in-place repo-mode grafts.
- `graft --version` reports the CLI's real version (it was hard-coded as 0.1.0).
- Updated dependencies
  - @graftsync/core@0.1.1
  - @graftsync/adapter-fork@0.1.1
  - @graftsync/skill@0.1.1
  - @graftsync/adapter-patch@0.1.1
  - @graftsync/spec@0.1.1
