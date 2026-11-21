---
'@graftsync/core': patch
'@graftsync/adapter-patch': patch
---

Add transactional `WorkspaceSnapshot` rollback around `sync --install` (so failures in `beforeInstall`, `eco.install`, `afterInstall`, or post-install version verification never leave workspace manifests, package-manager config, lockfiles, or applier artifacts half-mutated) and unify workspace-scoped / multi-copy package resolution (`UpstreamSource.installed(pkg, { from, allowAmbiguous })`, `UpstreamSource.installedCopies`, `Project.installedCopies`, and `npmResolveFrom`) across `sync`, `checkInstalled`, `applyInstalled`, `siblings`, and `ecosystems/npm`.
