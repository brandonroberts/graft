---
'@graftsync/core': patch
---

Resolve workspace sibling candidates from `resolveFrom[pkg]` first (and ignore unrelated multi-version `.pnpm` ambiguities) in `findSiblings`, and run `resolveUpgrade` and sibling checks before `beforeInstall` in `sync` so pre-install errors never leave package-manager config mutated (#89).
