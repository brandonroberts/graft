---
'@graftsync/adapter-patch': patch
---

Verify nested `node_modules` copies in `graft check` / `graft sync` when using Graft's built-in `graft` applier (`graft apply --installed`): covered nested copies are verified against their matching variant (failing loudly if unpatched or unapplicable), and uncovered nested copies emit a warning (#87).
