---
'@graftsync/core': patch
'@graftsync/adapter-patch': patch
'@graftsync/cli': patch
---

Harden patch checks, release-age filtering, pnpm `packageExtensions`, scoped diffs, and CLI argument validation (from validating against `openclaw/openclaw`):

- Enforce applier hunk offset limits (±20 lines for `pnpm`, `yarn`, and `patch-package`) in `checkAnchors` and `apply` so patches that drift past the package manager's search window report `needs-agent` instead of failing during install (#77).
- Parse `.npmrc` `min-release-age-exclude[]`, let `pnpm-workspace.yaml` `minimumReleaseAge` / `minimumReleaseAgeExclude` govern over `.npmrc` when configured, and pass `npm_config_min_release_age=0` to read-only `npm pack` / `npm view` calls (#78).
- Rename exact-pinned pnpm `packageExtensions` keys on upgrade, fail loudly (`install/package-extensions`) when a range-pinned key stops matching the target version, and warn in `graft check` when a stale version-pinned `packageExtensions` key matches no installed version (#79).
- Match renamed content-hashed bundler chunks (e.g. `dist/chunks/cac.<hash>.js`) in `graft diff` so scoped diffs compare old→new chunks instead of dumping the entire file as deleted, and reject unknown CLI flags and unexpected positional arguments with exit code 2 (#80).
