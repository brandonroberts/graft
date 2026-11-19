---
'@graftsync/skill': patch
'@graftsync/cli': patch
---

The README and skill now recommend a plain `graft check` step in CI (no third-party action needed), pinning the GitHub Action to a release tag with the CLI at the same version, and `tags: latest` when only stable upstream releases should get sync PRs.
