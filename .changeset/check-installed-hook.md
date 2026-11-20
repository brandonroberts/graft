---
'@graftsync/core': minor
'@graftsync/adapter-patch': minor
'@graftsync/adapter-fork': minor
---

Split installed configuration and installed-copy verification out of `MechanismAdapter.checkAnchors` into a dedicated optional `checkInstalled?(ctx, version)` hook (#61):

- `checkAnchors(ctx, version)` is now strictly static (pristine upstream only), so `graft replay`, `graft variant add --verify-version`, and generator regeneration on an already-installed version no longer fail on unapplied local applier config.
- `graft check`, `graft status`, `graft apply`, and `graft sync` (when verifying or after installing a target) invoke `checkInstalled` and continue to fail loudly when applier config or installed files do not match the selected variant.
- **Breaking for direct adapter callers:** code calling `patchAdapter.checkAnchors` or `forkAdapter.checkAnchors` directly now gets static anchor checks only; use `@graftsync/core`'s `checkAnchors(project, id, version)` (or `checkGraftWithInstalled`) / `adapter.checkInstalled` to include installed verification.
