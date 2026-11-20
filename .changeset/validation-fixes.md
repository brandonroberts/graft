---
'@graftsync/core': patch
'@graftsync/adapter-patch': patch
'@graftsync/adapter-fork': patch
---

- `upstream`: pass `npm_config_force=true` when calling `npm view`/`npm pack` so repos declaring `devEngines.packageManager` (e.g. pnpm with `onFail: "error"`) do not fail with `EBADDEVENGINES` (#58).
- `upstream`: fall back to pnpm's virtual store (`node_modules/.pnpm/`) in `findInstalledPackage` for unhoisted transitive dependencies, failing loudly with `upstream/ambiguous-installed` when multiple distinct versions are installed (#59).
- `fork`: fall back to ephemeral `commit-tree` parents in `mergeToBranch` when `git merge-tree` lacks `--merge-base` (git 2.38–2.39) (#60).
- `patch`: ignore crates.io publish/vendor metadata (`.cargo_vcs_info.json`, `Cargo.toml.orig`, `.cargo-checksum.json`) during `graft capture` for Cargo crates (#62).
