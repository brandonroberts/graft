---
'@graftsync/core': patch
'@graftsync/cli': patch
'@graftsync/skill': patch
---

`.grafts/config.json` takes an `upgrade` command per rootstock package (`{version}` and `{package}` substituted). `graft sync --install` runs it instead of its single-package install, for upgrades that move companion packages or run migrations (`nx migrate`, `ng update`). A failing command, or one that leaves another version installed, is an error. The skill and the setup prompt now ask how the package is upgraded by hand.
