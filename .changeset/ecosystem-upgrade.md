---
'@graftsync/core': patch
'@graftsync/cli': patch
---

The `upgrade` command can also be set per ecosystem, as `ecosystems.<name>.upgrade` in `.grafts/config.json`, like the other per-ecosystem options. It wins over the top-level `upgrade` map.
