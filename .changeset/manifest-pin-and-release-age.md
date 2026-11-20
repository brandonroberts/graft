---
'@graftsync/core': patch
---

- `npm`: when `sync --install` bumps a top-level override/resolution for a direct dependency, also update matching pinned dependency specifiers (`1.0.0`, `^1.0.0`, `~1.0.0`, `=1.0.0`) across workspace `package.json` manifests so exact-pinned specs don't stay stale behind the override (#74).
- `npm`: respect `.npmrc` `min-release-age` (days) and `pnpm-workspace.yaml` `minimumReleaseAge` (minutes, with `minimumReleaseAgeExclude`) in `NpmUpstreamSource.versions`, filtering out releases newer than the cooldown and falling back `latest` to the highest eligible stable version so `graft outdated` matches what `npm pack` and pnpm will install (#75).
