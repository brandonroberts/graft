---
'@graftsync/adapter-patch': patch
'@graftsync/skill': patch
---

Support opt-in version-pinned `patchedDependencies` keys (`mechanisms.patch.pinKeys: true` in `.grafts/config.json`) for the `pnpm` and `npm` (>= 12) patch appliers, and reject `allowUnusedPatches: true` / `allowNonAppliedPatches: true` in `pnpm` configs whenever keys are version-pinned (#83).
