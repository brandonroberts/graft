---
'@graftsync/core': patch
'@graftsync/adapter-patch': patch
---

Include transitive exact-version (`=<version>`, non-dev) lockstep dependencies from the same repository in `findCargoSiblings` (such as `serde_core` with `serde`), ignore dev-dependencies in `orderCargoUpdates`, and update patched Cargo crates and their siblings atomically in one `cargo update -p … --precise` call (#93).
