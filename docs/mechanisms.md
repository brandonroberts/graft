# Mechanisms and ecosystems

Graft supports two mechanisms — `patch` (diffs against published packages across npm, Cargo, Go and PyPI) and `fork` (commits on a fork of the upstream repository, either packed as a dependency or verified in place in repo mode).

The normative contract is in [`spec.md`](spec.md).

## `patch` (any package manager)

Variants are git-style `.patch` files with package-relative paths, the format `pnpm patch-commit` and `bun patch --commit` write. The same variant works with every package manager. Graft picks an *applier* from the project's package manager. An explicit `packageManager` in `package.json` wins. Otherwise Graft goes by lockfiles in the order **pnpm, npm, upm**, then yarn and bun, and falls back to **npm** when there's no signal. yarn 2+ (berry) is told apart from yarn classic by `packageManager: yarn@2+`, a `.yarnrc.yml` or `.pnp.cjs` next to `yarn.lock`, or berry's `__metadata:` lockfile header. To force an applier, set `{ "mechanisms": { "patch": { "applier": "vendor" } } }` (or `pnpm`, `npm`, `bun`, `yarn`, `graft`, `patch-package`) in `.grafts/config.json`.

| Package manager | Default applier |
|---|---|
| pnpm | `pnpm` (native) |
| npm ≥ 12 | `npm` (native) |
| npm < 12, yarn classic | `graft` (built-in) |
| yarn 2+ (berry), Plug'n'Play or `nodeLinker: node-modules` | `yarn` (native `patch:` protocol) |
| upm | `vendor` |
| bun | `bun` (native) |

- **Native appliers (pnpm, npm ≥ 12, bun, yarn 2+):** the package manager applies the patch and records it in its lockfile. They're preferred where they exist. npm 12's is the strictest: a patch that doesn't apply, *or matches no installed package*, fails the install; it also applies with `--ignore-scripts`, and the lockfile records the patch. npm before 12 ignores `patchedDependencies` *silently*, so Graft checks the npm version (`packageManager`, else `npm --version`) and refuses the `npm` applier below 12.
- **yarn 2+ (`yarn`):** Graft writes a name-only root resolution, `"resolutions": { "<pkg>": "patch:<pkg>@npm%3A<version>#./.grafts/<id>/variants/<variant>.patch" }`, and sets the root's own declared range to the version. yarn applies the patch while fetching, so it needs no install scripts, and it works under Plug'n'Play and `nodeLinker: node-modules` alike. The patched package gets its own checksum in `yarn.lock`, so `yarn install --immutable` fails when the variant changes without a reinstall, and a hunk that doesn't apply fails the install. The resolution pins the version, so on an upgrade `sync` rewrites it and runs a bare `yarn install`. Graft reports other resolutions of the package (`<pkg>@npm:^2`, `foo/<pkg>`) and a `patch:` dependency left by `yarn patch-commit`, because they'd compete with Graft's. yarn classic has no `patch:` protocol, so this applier refuses it.
- **The vendored override applier (`vendor`):** the default for upm, and the most universal option. It works with any package manager that supports `file:` overrides, with no install hooks at all. Graft builds *pristine upstream + the selected variant* into `.grafts/.vendor/<pkg>-<version>.tgz` and commits it. It then points the package manager at that tarball through its overrides (npm, bun and upm `overrides`, yarn `resolutions`, pnpm's overrides) and through the root's own dependency. The package manager installs the patched package as an ordinary dependency:
  - **in the lockfile:** recorded there with the tarball's integrity;
  - **durable:** it survives fresh installs, `--ignore-scripts`, and verify/"repair" passes;
  - **tree-wide:** it reaches every copy in the dependency tree.

  Tarballs are reproducible, with sorted entries and fixed timestamps and owners. Graft only rewrites one when its *contents* change, so lockfile integrity stays stable. On an upgrade it rebuilds from the new pristine version and asks `sync` for a bare reinstall, because a targeted `add <pkg>@<version>` would undo the override. The cost: tarballs are committed binary files, and the root dependency reads `file:.grafts/.vendor/…` instead of a version range.
- **The built-in applier (`graft`):** the default for npm before 12 and yarn classic, and usable with any package manager that installs into `node_modules` and runs the project's `postinstall`. Under yarn Plug'n'Play there's no `node_modules` to patch, so Graft refuses it (and `patch-package`) there with an error that names the `yarn` and `vendor` appliers. `graft apply --installed` runs in `postinstall` and patches every installed copy of the package that a variant covers, hoisted or nested. It is:
  - **offline:** it patches the installed file itself;
  - **idempotent:** a file whose *reverse* patch fits is already patched;
  - **store-safe:** it replaces files by rename (a new inode) instead of editing in place. pnpm, bun and some npm setups hardlink `node_modules` files to a shared global store, so editing in place would patch every project on the machine;
  - **strict:** it fails the install if the copy the project resolves isn't covered, or any patch doesn't fit, and it never leaves a copy half-patched.

  `sync --install` also runs it right after installing, because package managers don't run the project's `postinstall` on a targeted install.

| Package manager | How the selected variant is applied | Silent failure Graft prevents |
|---|---|---|
| pnpm | `pnpm-workspace.yaml` `patchedDependencies[<pkg>]` (name-only key by default; `<pkg>@<installed>` when `mechanisms.patch.pinKeys: true` or other versions of `<pkg>` are installed in the workspace) | On pnpm < 11, without `ignorePatchFailures: false` a patch that stops applying is only a *warning* and the package installs unmodified (pnpm 11+ fails by default and removed the setting). When another version of the package exists in `.pnpm` (or `pinKeys: true`), Graft pins `<pkg>@<installed>`, rewrites it on upgrade, and rejects `allowUnusedPatches: true` / `allowNonAppliedPatches: true` so pnpm cannot silently skip a stale key |
| bun | `package.json` `patchedDependencies["<pkg>@<installed>"]` | bun ignores name-only keys and keys for other versions, so an upgrade installs unpatched. Graft rewrites the key before every version change |
| npm ≥ 12 (`npm`, native) | `package.json` `patchedDependencies[<pkg>]` (name-only key, or `<pkg>@<installed>` when `mechanisms.patch.pinKeys: true`) | npm < 12 ignores the field, so the project would install unpatched with no error. Graft refuses the native applier below npm 12 and falls back to the built-in one |
| npm < 12, yarn classic, anything else (`graft`, built-in) | `graft apply --installed` in `postinstall` | npm and pnpm skip the project's `postinstall` on a targeted install (`npm install ms@2.1.3`), so `sync --install` applies the variant itself after installing |
| yarn 2+ (`yarn`, native) | `package.json` `resolutions[<pkg>]` = `patch:<pkg>@npm%3A<version>#./<variant>` | The resolution pins the version: left behind on an upgrade, it keeps installing the old patched version while `package.json` asks for the new one. Graft rewrites it before every version change. Its name-only key also reaches copies that other packages depend on (verified on `ms` under `debug`) |
| upm, or anything with overrides (`vendor`) | `.grafts/.vendor/<pkg>-<version>.tgz` via overrides + the root dependency | upm never runs the project's `postinstall`, and `upm install --verify` silently "repairs" patched files. npm resolves `file:` overrides relative to each *dependent* and keeps stale nested lock entries, so Graft uses npm's `$<pkg>` reference and drops the package's lock entries before reinstalling |
| opt-in (`patch-package`) | A generated `.grafts/.patch-package/<pkg>+<version>.patch` (paths rewritten for patch-package), applied by `patch-package --patch-dir .grafts/.patch-package --error-on-fail --error-on-warn` in `postinstall` | Plain `patch-package` exits 0 on a failed patch outside CI, and only warns on a version mismatch. Graft renames the derived file on every version change and re-runs the bare install that triggers `postinstall` |

- **Anchors:** every hunk is an anchor. Its context and removed lines must appear exactly in the target version's file, with no fuzz, though the line position may shift. A file the patch creates must not already exist upstream.
- **Config checks:** at the installed version, `graft check` reports any configuration that would apply something other than the selected variant, or fail silently. `graft apply` and `sync --install` write the configuration.
- **Installed-copy check:** at the installed version, `graft check` also compares each patched file in `node_modules` with *pristine upstream + the selected variant*. It fails if they differ, whatever the configuration says. With Graft's built-in `graft` applier (`graft apply --installed`), `graft check` verifies every covered nested copy under `node_modules` as well (using each copy's matching variant) and warns about uncovered nested copies. Under yarn Plug'n'Play, Graft resolves the installed package through the project's `.pnp.cjs` and reads its files out of yarn's zip cache with the PnP runtime (in a child `node -r .pnp.cjs`). If that runtime can't run, `graft check` prints a warning ("cannot verify installed files … under Plug'n'Play") instead of claiming the files were checked.

Each row of the table was verified against the real package manager on a real project (`ms`): install, `graft apply`, `sync`, an upgrade to a new `ms` version with `--install`, and a tampered install. The built-in applier was also verified on npm, yarn 1.22, bun, and pnpm (forced via the config override), including a second install to check idempotency. Under pnpm, every file in the content-addressed store still matched its hash afterwards. The vendored override applier was verified on upm (its default) and, forced, on npm, yarn 1.22, pnpm and bun. Each run covered a fresh install, a real upgrade, and a fresh install after the upgrade; npm also covered `--ignore-scripts`, and upm `install --verify`. The silent failures in the table are each package manager's real behavior today: pnpm 10.28, bun 1.4.4, patch-package 8.0.1, upm 1.5.1.

yarn 4.18 was verified the same way, under both Plug'n'Play and `nodeLinker: node-modules`, with the `yarn` applier (its default) and, forced, `vendor`. Each run covered `graft check` before and after `graft apply`, the patched behavior through `yarn node`, a fresh `yarn install --immutable` after clearing the install state and the cache, `sync --version 2.1.3 --install`, and a tampered install (resolution removed), which `graft check` caught; with the `yarn` applier it also caught the unpatched installed file, read from inside the zip cache under PnP. The `graft` applier was confirmed to be refused under PnP. Known gaps for yarn 2+:

- The built-in `graft` and `patch-package` appliers aren't supported under Plug'n'Play. They weren't re-verified on yarn 2+ with `nodeLinker: node-modules` either; use `yarn` or `vendor` there.
- The `yarn` applier assumes the package comes from the npm registry (`npm:` protocol). Packages from git, `file:` or `workspace:` sources need `vendor`, or a hand-written resolution.
- With yarn 2+, `sync --install` bumps a package with `yarn up`, which fails for a package no workspace declares. For a grafted package that doesn't matter: the `yarn` and `vendor` appliers pin it with a resolution and `sync` runs a bare `yarn install` instead.

### Installs that skip scripts

`--ignore-scripts` skips `postinstall`, and with it the built-in and patch-package appliers. The native and vendored appliers don't depend on scripts. Run `graft check` in CI after installing (the GitHub Action also does this before syncing). It compares installed files with pristine upstream + the selected variant, so it fails the build however the patch was skipped.

### Packages released together (siblings) and `resolveFrom`

`sync --install` also moves the project's declared dependencies from the upstream package's repository at its installed version — across npm (`repository`, e.g. `@nx/angular` with `nx`, resolved from `resolveFrom` in workspaces), Cargo (`cargo metadata` `repository`, including transitive exact-version `=<version>` lockstep crates such as `serde` → `serde_core` → `serde_derive`, updated atomically), Go (module repository prefix, e.g. `go.opentelemetry.io/otel/sdk` with `go.opentelemetry.io/otel`), and PyPI (`Project-URL` / `Home-page`, e.g. `opentelemetry-*`). If a sibling isn't published at the new version, sync fails before modifying package-manager config instead of leaving it behind. An `upgrade` command (below) replaces this. With pnpm catalogs, Graft updates catalog entries pinning the installed version in `pnpm-workspace.yaml` rather than the manifests, and fails loudly (`install/catalog`) if a `catalog:`-referenced package uses a complex range it cannot safely rewrite rather than letting `pnpm update` overwrite `catalog:` with a literal version.

In a monorepo where the upstream package is declared by a workspace package rather than the root, tell Graft where to resolve it from in `.grafts/config.json`:

```json
{ "resolveFrom": { "semver": "packages/spec", "yaml": "packages/spec" } }
```

### Upgrades that are more than a version bump

If upgrading the package by hand means more than installing the new versions (running migrations, say), give Graft the command you'd run, with `{version}` filled in at sync time:

```json
{ "upgrade": { "nx": "pnpm nx migrate {version} && pnpm install --no-frozen-lockfile && pnpm nx migrate --run-migrations --if-exists" } }
```

It may run for 30 minutes; for a longer one (an upgrade that runs an agent, say) write `{ "command": "…", "timeoutMinutes": 90 }`. Graft runs it from the project root instead of its own install, fails with its output if it fails, then checks that the package really is at the new version. Whatever the command changes (lockfile, migrated files) goes into the sync PR. It works in every ecosystem. To scope a command to one ecosystem, put it under `ecosystems`, like the other per-ecosystem options (`{ "ecosystems": { "cargo": { "upgrade": { "itoa": "…" } } } }`), or use a `"cargo:itoa"`-style key. The `ecosystems` entry wins.

The end of the command's output is kept in the sync report (`sync.md`, and `installOutput` in `sync.json`): read it. A tool can exit 0 and still leave work behind. For example, `nx migrate --run-migrations --agentic` run from inside an AI agent session doesn't start its own agent; it prints steps for the calling agent and leaves the migrations unapplied. Add `needsAgentIf` (`exists`, `output`, and/or `command`) to turn that into a `needs-agent` hand-off (exit code 1, `verified` not bumped) instead of a false green:

```json
{
  "upgrade": {
    "nx": {
      "command": "pnpm nx migrate {version} && pnpm nx migrate --run-migrations --agentic",
      "timeoutMinutes": 60,
      "needsAgentIf": { "exists": [".nx/migrate-runs/*/run.json", "migrations.json"] }
    }
  }
}
```

## Other ecosystems: Cargo, Go, PyPI

A graft's `rootstock.ecosystem` (default `npm`) says where its package comes from. `patch` grafts work the same way in every ecosystem: the variant is a git-style patch against the **published** artifact, every hunk is an anchor, and `graft apply` / `sync --install` wire it in. What differs is the artifact, the version syntax and how the tool is made to use the patched package. None of these tools applies patch files itself, so each applier commits *pristine upstream + the variant* under `.grafts/.vendor/` (never edit it by hand; `graft check` rebuilds it and reports a stale one) and points the tool's own override mechanism at it.

| Ecosystem | Pristine artifact (what anchors and diffs read) | Versions and ranges | Applier: how the patched package is used | Silent failure Graft prevents |
|---|---|---|---|---|
| `cargo` | the published `.crate`, fetched by cargo (project `.cargo/config.toml` applies); its `Cargo.toml` is the normalized one | semver: `1.0.19`, `>=1.0.0 <2.0.0` | `cargo-vendor`: `.grafts/.vendor/<crate>-<version>/` + `[patch.crates-io] <crate> = { path = … }` in the workspace root manifest (comments kept) | A `[patch]` whose version doesn't match what the requirements resolve is *not used*, yet cargo exits 0 with only a warning and records it under `[[patch.unused]]`. `graft check` fails on that entry and unless `cargo metadata` shows the vendored copy |
| `go` | the module cache's verified, read-only copy (`go mod download`) | semver with `v`: `v0.14.0`; ranges `>=0.14.0`; a version without `v` is normalized | `go-replace`: `.grafts/.vendor/<module>-<version>/` + a *version-qualified* `replace` in `go.mod` (or `go.work`), via `go mod edit` | A replace for a version that isn't selected is ignored and `go build` exits 0. `graft check` fails unless `go list -m` shows the vendored copy; `sync --install` moves the `require` with `go get` |
| `pypi` | the published wheel, from `pip download` | PEP 440: `"24.0"` (quoted in YAML), `>=24.dev0`, `>=2.0,<3`, `~=2.31` | `wheel-vendor`: the wheel repacked (RECORD regenerated, same filename and version) as `.grafts/.vendor/<wheel>`, + `[tool.uv.sources]` (uv) or the requirements-file line (pip). Poetry isn't supported yet | pip treats a rebuilt wheel of the same version as "already satisfied", exits 0 and keeps the old code; uv keeps a stale wheel hash on a plain `uv lock`, skips reinstalling same-version wheels without `--reinstall-package`, and hardlinks `.venv` files to its cache on same-filesystem installs. Graft reinstalls with `--force-reinstall` / `uv cache clean` + `uv lock --upgrade-package` + `uv sync --reinstall-package`, and `graft check` compares site-packages with pristine + variant |

```sh
graft add itoa-fast --package itoa --ecosystem cargo          # version: the installed one
graft add sync-trace --package golang.org/x/sync --ecosystem go
graft add pkg-fix --package packaging --ecosystem pypi
# write the variant (paths relative to the published package), then:
graft apply && graft check
graft sync --version 1.0.18 --install                         # go: --version 0.11.0 works too
```

Ecosystem options go under `ecosystems` in `.grafts/config.json`: `cargo.manifest` (default `Cargo.toml`), `cargo.index`, `cargo.registry` (default `crates-io`); `go.module` (the main module's directory); `pypi.python` (default `.venv/bin/python`, else `python3`), `pypi.index`, `pypi.platform` (for packages with only platform wheels), `pypi.requirements` (default `requirements.txt`). `outdated` reports `latest` (newest stable) and `next` (newest prerelease) for these ecosystems, which have no dist-tags. `graft capture` works in every ecosystem: edit what the tool actually uses and capture it. For cargo and go that's the vendored copy `graft apply` wrote under `.grafts/.vendor/` (before that, cargo's shared registry source; go's module cache is read-only, so capture says to vendor or `replace` first); for pypi it's the package in site-packages. `graft apply` then rebuilds the vendored copy from pristine + the new variant.

Each applier is tested in CI with the real tool against its registry (`itoa` on cargo, `golang.org/x/sync` including `go.work` and `go mod vendor` on go, and `packaging` on both pip and uv), and has also been live-validated against real upstream repositories: Cargo on `BurntSushi/ripgrep` (10 workspace crates: `anyhow`, `serde` with transitive lockstep siblings `serde_core`/`serde_derive`, `cargo check --workspace`, rollback), Go on `caddyserver/caddy` (`cobra`, OpenTelemetry 3-sibling discovery, rollback), `junegunn/fzf` (`golang.org/x/term`, `go build`/`go test`, `graft capture`), and `spf13/cobra` (`pflag`, `go-md2man/v2`, `go.yaml.in/yaml/v3`, `go test ./...`), and PyPI/`uv` on `pallets/flask` (`click`, `werkzeug`, 494 `pytest` tests, `graft capture`, rollback). Repo-mode forks (`fork.install: none`) already work for any language; the `fork` mechanism's package mode (`npm pack`) is npm only and refuses other ecosystems (`fork/ecosystem`). See [`ecosystems.md`](ecosystems.md) for the design notes.

## `fork` (modification kept as commits on a fork)

For teams that maintain their change as commits on a fork of the upstream source repository, rebased for each upstream release.

```yaml
mechanism: fork
fork:
  repo: https://github.com/acme/ms.git        # the fork
  upstream: https://github.com/vercel/ms.git  # the upstream source
  tag: "{version}"                            # upstream release tag (default "v{version}")
  build: npm ci && npm run build              # optional, before packing; dir: for monorepos
variants:
  - range: ">=2.1.2"
    module: ./variants/v2.json                # { "ref": "graft/fortnight", "base": "2.1.2" }
```

- **The change** is the fork's diff from `tag(base)` to `ref`. Every hunk is an anchor, located in the upstream *source* at the target version's tag (fuzz 0), and checked for "likely upstreamed".
- **Installing a version:**
  1. Graft rebases that diff onto the target tag in a fresh checkout.
  2. It runs `build`, if set.
  3. It runs `npm pack`, checking that the result packs as `<package>@<version>`.
  4. It commits the tarball as `.grafts/.vendor/<pkg>-<version>.tgz` and installs it through overrides and the root dependency, the same way as the `vendor` applier.

  This works with every package manager and is recorded in the lockfile. Graft never pushes to the fork.
- **An upstream release the fork's commits still apply to** goes through `sync` with no agent: rebase, pack, install, green.
- **A conflict** becomes `needs-agent`, with the scoped upstream `git diff`. The agent rebases the fork branch onto the new tag *in the fork*, then registers a new variant: `graft variant add <id> --range '>=X' --module ./variants/vX.json --verify-version X`.
- **At the installed version,** `graft check` rebuilds the tarball and compares it, and also compares installed files with it.

Verified end to end against the real `vercel/ms` repository with a local fork (a `fortnight` unit), on npm and pnpm:
- `apply` and a fresh install;
- `sync --version 2.1.3 --install`, which rebased the fork from `2.1.2` onto `2.1.3` automatically;
- a tampered install, which `graft check` caught.

### Repo mode: the fork is the product

Some forks aren't dependencies at all: a translated docs site, a tool run from source. With `install: none`, nothing is packed or installed. `sync` rebases the fork's change onto the target tag in a fresh checkout, then leaves the result as the local branch `graft/<id>/<version>` in `.grafts/.cache/fork/<id>` for you to fetch. The graft can live in the fork itself (`repo: .`), and `base` may be any upstream commit, because these forks often sit between releases.

Scaffold it from inside the fork with `graft add <id> --package <name> --mechanism fork --in-place --version <upstream version>`: it writes `repo: .`, `install: none`, the upstream from the checkout's `upstream` git remote (or `--upstream <url>`), and the variant below. `--repo-mode` alone sets `install: none` for a fork kept elsewhere; `--fork-repo`, `--tag` and `--track` fill in the rest.

When the graft lives in the fork itself, use one permanent variant, `{ "ref": "@worktree", "base": "@verified" }`: the change is *this checkout* (uncommitted work included) against *the upstream it last verified*. It never needs a new variant, because the base moves with `verified`:

```yaml
rootstock: { package: angular, verified: 22.3.0-next.2+e36a63e20e }   # a release, or release+commit
mechanism: fork
fork:
  repo: .                                   # the graft lives in the fork
  upstream: https://github.com/angular/angular.git
  install: none
  track: main                               # optional: follow main's tip instead of release tags
variants:
  - { range: ">=22.0.0-0", module: ./variants/fork.json }   # { "ref": "@worktree", "base": "@verified" }
```

- **Commit targets.** `graft sync --version 22.3.0-next.3+57905ca4e6` syncs to that upstream commit. The version part is what variant ranges match; the build metadata names the commit.
- **The checkout stays true until you adopt.** A green sync records the new `verified` in the result branch, not in your checkout (which is still the fork at its old base). Adopt it as a merge of the upstream commit it sits on (the report names it), with the result's tree, so the fork keeps upstream in its history, as `git merge upstream/main` would: `git fetch .grafts/.cache/fork/<id> graft/<id>/<version> && git merge --no-ff --no-commit -s ours --allow-unrelated-histories <upstream commit> && git read-tree -u --reset FETCH_HEAD && git commit`. (A plain tree swap would drop upstream from the fork's history: a later `git merge upstream` would replay it and conflict again where it was resolved.)
- **A starting point for the agent.** On `needs-agent`, Graft prepares `graft/<id>/<version>-agent`: git's merge of the change onto the target, with conflict markers only in the files that conflict (the report lists them), and `graft.md` already at the new version with `status: conflicted`. Adopt it the same way (without the commit), resolve the markers, and run `graft sync`: it checks the working tree in place. The green sync records `status: applied` in its result only, so take the result's tree into the open merge as its report says (`git fetch <cache> <result> && git read-tree -u --reset FETCH_HEAD`; a second `git merge` would be refused), verify with the project's checks, and commit, which concludes the merge. The variant is permanent, so the report's "Next" line says to keep it rather than write a new one.
- **Finding new versions.** `graft outdated` offers the newest upstream release tag, or with `fork.track` the branch tip as `<version>+<commit>`.
- **Automated.** The [GitHub Action](../packages/action) does all of this: it adopts green results into a PR, and for conflicts either runs your agent on the merged branch (then re-verifies) or opens a draft PR with the markers.

A ready-to-use setup for it, with a translation check for agents and a workflow, is in [`examples/angular-tr`](../examples/angular-tr). Checked against the real [angular-tr](https://github.com/erkamyaman/angular-tr) (the Turkish angular.dev translation: 525 files over upstream, including 461 pages). The checks below ran on a local, history-free copy of its trees:
- **At its own base,** `sync` materialized a tree identical to the fork's branch (text, a binary image, an executable bit).
- **Onto `v22.3.0-next.3`** (also given as the commit `22.3.0-next.3+<sha>`), 2,833 hunks were checked. The 7 files that miss are exactly the ones `git apply --3way` conflicts on, and the prepared `-agent` branch has conflict markers in just those 7. One is a page the fork rewrote whole, where upstream appended a section right after it. The agent is handed a 364-line diff of what upstream changed in the 10 translated files it touched; the full upstream diff for that range is about 51,000 changed lines.
- **Upstream English that rebases cleanly** into a translated page (a 63-line addition to `i18n/deploy.md`) is not a conflict, so sync can't see it; the example's translation check (`check-pages.mjs`), which the agent runs, does.
