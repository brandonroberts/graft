---
'@graftsync/core': patch
---

Pass `--reinstall-package` for vendored wheels to `uv sync` in `pypiEcosystem.reinstall` so `graft apply` always restores modified site-packages or rebuilt same-version wheels into `.venv` (#95).
