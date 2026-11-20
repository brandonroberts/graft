---
'@graftsync/core': patch
---

Report invalid `graft.md` files and unknown graft IDs as errors in `applyToProject` (`graft apply`) and `applyInstalled` (`graft apply --installed`) instead of silently skipping them (#85).
