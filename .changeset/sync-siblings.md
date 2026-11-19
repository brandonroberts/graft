---
'@graftsync/core': patch
'@graftsync/cli': patch
---

`graft sync --install` moves an npm package's siblings with it: the project's dependencies from the same repository at the same installed version (e.g. the `@nx/*` packages with `nx`). A sibling not published at the target version is an error (`install/sibling-unpublished`) instead of being left behind. With pnpm catalogs, sync updates the catalog entries in `pnpm-workspace.yaml` instead of running `pnpm update`, which replaced the manifests' `catalog:` references with literal versions.
