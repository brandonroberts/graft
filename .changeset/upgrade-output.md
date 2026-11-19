---
'@graftsync/core': patch
'@graftsync/cli': patch
---

`graft sync` streams an `upgrade` command's output, as it does a generator's, to stderr, also with `--json` (stdout stays the JSON report; `--quiet` silences it). The GitHub Action shows each `graft sync`'s progress and command output in a collapsible log group.
