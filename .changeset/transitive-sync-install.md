---
'@graftsync/core': minor
---

Stop silently promoting transitive npm dependencies into root `dependencies` during `sync --install` (#63):

- When a rootstock package is not declared in `dependencies`, `devDependencies`, or `optionalDependencies` of any workspace manifest (and not in a pnpm catalog), Graft now checks for an existing top-level override/resolution (`overrides` in `pnpm-workspace.yaml` or `package.json`, `pnpm.overrides`, or `resolutions`) pinning the installed version.
- If a matching override pins the installed version, Graft updates it (preserving prefixes, comments, and formatting) and runs a bare reinstall.
- Otherwise, Graft fails loudly with `install/transitive` instead of running `bun add` / `npm install` / `yarn add` into root `dependencies` (or running `pnpm update -r` / `yarn up` that leaves it behind).
- `installPackage` also preserves `optionalDependencies` when upgrading a direct optional dependency.
