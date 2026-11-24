---
'@graftsync/adapter-fork': patch
'@graftsync/core': patch
---

Harden commit-only repo-mode forks (#107): fall back cleanly in `newerVersion` when upstream `package.json` is malformed JSON or has a non-string `version`; report `fork/no-commit` and `fork/no-base` as tooling errors (`outcome: 'error'`, exit code `2`) instead of `needs-agent`; and scaffold `graft add --mechanism fork --in-place` with `./variants/fork.json`, an all-version range (`>=0.0.0-0` / `>=0.dev0`), and no redundant `fork.tag` when `--track` is set without `--tag`.
