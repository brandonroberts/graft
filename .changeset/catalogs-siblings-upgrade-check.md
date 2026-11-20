---
'@graftsync/core': patch
---

- `npm`: detect workspace manifests referencing a package via pnpm `catalog:` / `catalog:<name>` when its catalog entry does not pin the installed version (e.g. a range like `>=24.0.0 <25.0.0`) and fail loudly with `install/catalog` instead of running `pnpm update` and overwriting `catalog:` references with literal versions (#55).
- `ecosystems`: add sibling detection and multi-package upgrades for Cargo (`cargo metadata` `repository`), Go (`go list -m -json all` repository module prefix), and PyPI (`pyproject.toml`/requirements + `importlib.metadata` `Project-URL`/`Home-page`) so companion packages released together move with the rootstock (#56).
- `sync`: add optional `needsAgentIf` (`exists`, `output`, and/or `command`) on `.grafts/config.json` `upgrade` entries to detect upgrade commands that exit 0 while leaving unfinished work (e.g. Nx agentic migrate runs), marking grafts `needs-agent` (exit code 1) instead of `green` (#57).
