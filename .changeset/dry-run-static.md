---
'@graftsync/core': patch
'@graftsync/cli': patch
---

`graft sync --dry-run` against a version that isn't installed (and without `--install`) now runs the static checks (variant, anchors, apply) and reports their result, as its error message promised, instead of failing every graft with "rerun with --install … (or --dry-run)".
