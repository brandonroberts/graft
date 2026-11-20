---
'@graftsync/core': patch
'@graftsync/adapter-patch': patch
---

- `patch`: accept LF patches against CRLF upstream files across anchor checks, `apply`, `applyToInstalledCopy`, and `checkInstalled` (tolerating mixed CRLF/LF output produced by pnpm) while preserving strict matching when a patch explicitly contains CR (#67).
- `pnpm`: pin `patchedDependencies` to `<pkg>@<installed>` when multiple distinct versions of `<pkg>` are installed in `node_modules/.pnpm`, avoiding broken installs on unrelated versions in multi-version workspaces (#68).
- `patch`: support hunkless deleted and created files (`deleted file mode` / `new file mode` with 0 hunks, as written by `pnpm patch-commit` and `git diff`) in parsing, anchor checks, `apply`, `applyToInstalledCopy`, and `checkInstalled`, and report a non-empty error if a file patch makes no changes (#69).
- `pnpm`: detect pnpm major version (`packageManager`, `devEngines.packageManager`, or `pnpm --version`) and skip requiring/writing `ignorePatchFailures: false` on pnpm 11+, where the setting was removed and patch failures fail installs by default (#70).
- `core`: bump matching top-level overrides/resolutions for direct dependencies as well as transitive ones during `sync --install` so an override pinning the old version does not hold back a direct dependency upgrade, and filter `node_modules/.pnpm` scans against `node_modules/.pnpm/lock.yaml` so unpruned directories left by `pnpm update` do not trigger false `upstream/ambiguous-installed` errors (#71).
