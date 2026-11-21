---
'@graftsync/core': patch
---

Clear `uv`'s cache (`uv cache clean`) and pass `--reinstall-package` for vendored wheels to `uv sync` in `pypiEcosystem.reinstall` so `graft apply` always restores modified site-packages (including hardlinked same-filesystem caches) or rebuilt same-version wheels into `.venv` (#95).
