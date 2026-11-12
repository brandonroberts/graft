# Proposal: ecosystems beyond npm

> **Status: implemented for the `patch` mechanism** ([#26](https://github.com/brandonroberts/graft/issues/26)).
> The normative text is now [`spec.md`](spec.md) (§2.1, §4.1, §7 and §10). This page keeps the
> proposal as written, followed by what changed during implementation (§8).

## 1. Goal

Graft's dependency mode (`patch`, and `fork` with `fork.install: package`) works only for npm
packages today. Repo-mode forks (`fork.install: none`) already work for any git repository.
This proposal adds other package ecosystems to dependency mode, starting with Cargo, then Go,
then Python. The format and the sync loop stay the same, and every existing `graft.md` stays
valid without edits.

It's written now because the spec is about to freeze (#6). The one spec change that every
ecosystem needs, `rootstock.ecosystem`, should be reserved in v1 so that adding ecosystems
later is additive rather than a v2.

## 2. Where npm is assumed today

| Layer | npm assumption | Code |
|---|---|---|
| Spec | `rootstock.verified` and `variants[].range` are node-semver; `rootstock.package` is an npm name | `packages/spec/src/schema.ts`, `parse.ts` (`semver.valid`, `validRange`, `intersects`, `satisfies`) |
| Pristine upstream | `npm pack` of `pkg@version`; `package.json` at the root is the sanity check | `NpmUpstreamSource.resolve` in `packages/core/src/upstream.ts` |
| Versions | `npm view <pkg> versions dist-tags` | `NpmUpstreamSource.versions`; `outdated.ts` reads dist-tags |
| Installed copy | `node_modules/<pkg>/package.json` walking up, or PnP | `findInstalledPackage`, `readInstalledFiles` |
| Package manager | `package.json` `packageManager`, then npm-family lockfiles | `detectPackageManager` in `packages/core/src/install.ts` |
| Install | `pnpm update` / `npm install` / `yarn up` / `bun add` / upm | `installPackage`, `reinstall` |
| Appliers | seven npm-family appliers | `packages/adapters/patch/src/appliers.ts`, `vendor.ts`, `pnpm.ts` |
| Fork, package mode | `npm pack`, then the `vendor` applier's override logic | `packages/adapters/fork/src/adapter.ts` (`fork/pack`) |
| Grouping | sync, `outdated` and `graft/duplicate-rootstock` key on the package name alone | `sync.ts`, `outdated.ts`, `Project.duplicateRootstocks` |

What is **not** npm-specific:
- the patch format (git-style, package-relative, every hunk an anchor, fuzz 0) and its
  apply/anchor/scoped-diff code;
- the fork mechanism's rebase, anchors on upstream source, `-agent` branches and repo mode;
- the intent body, variants, status, generators, reports, exit codes, the Action and the skill's
  loop.

So the work is in three places: the spec (naming the ecosystem and its version scheme), core
(an `Ecosystem` interface that `NpmUpstreamSource` and `install.ts` move behind), and one set of
appliers per ecosystem.

## 3. Spec changes

### 3.1 `rootstock.ecosystem`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `rootstock.ecosystem` | `npm` \| `cargo` \| `go` \| `pypi` | no | `npm` | The package ecosystem `rootstock.package` belongs to. Selects the version scheme (§3.2), where pristine upstream comes from, and which appliers exist. |

- `rootstock.package` is a name **in that ecosystem**: an npm name, a crate name, a Go module
  path (`golang.org/x/text`; a `/v2` major is a different module, so a different rootstock), or
  a PyPI project name (compared normalized per PEP 503).
- For a standalone graft (repo mode) the field is ignored, as `package` already is.
- New diagnostic: `frontmatter/unknown-ecosystem` (error), for a value no registered ecosystem
  has, mirroring `frontmatter/unknown-mechanism`.
- Ecosystems are listed in the spec. Unlike mechanisms they aren't plugins (see §7, question 1).

**For the v1 freeze:** add the field with npm as the only accepted value. The schema and
diagnostic are then stable, and each ecosystem lands as an additive minor release.

### 3.2 Version schemes

`verified` and `range` are validated, compared and intersected by the ecosystem's scheme:

| Ecosystem | Scheme | `verified` written as | `range` written as |
|---|---|---|---|
| npm | semver (node-semver) | `4.2.0` | node-semver range, `includePrerelease` (today's rules) |
| cargo | semver | `1.0.19` | node-semver range (not Cargo's caret-by-default requirement syntax; one range syntax for every semver ecosystem) |
| go | semver with the `v` prefix | `v0.14.0`, `v0.0.0-20240101120000-abcdef123456`, `v2.1.0+incompatible` | node-semver range; the `v` is optional in ranges |
| pypi | PEP 440 | `2.31.0`, `1.0.post1`, `2.0rc1` | PEP 440 specifier set: `>=2.0,<3` |

- Go pseudo-versions are semver prereleases and order by timestamp, and `+incompatible` is
  build metadata, so node-semver handles both once the `v` is stripped. The `X+<sha>` build
  metadata that repo mode uses keeps working.
- PEP 440 is the only new syntax. The spec package needs `valid`, `satisfies` (prereleases
  included, as today) and an **intersection test** for `variants/overlap`. `packaging` has no
  intersection, so we'd write one over the specifier set's intervals. Epochs, `.post` and
  `.dev` order per PEP 440. The `-0` floor convention becomes `>=2.0.dev0` for pypi.
- Validation stays one table: `variants/overlap`, `variants/verified-uncovered` and the schema
  errors are reported with the scheme's own syntax in the message.

### 3.3 `.grafts/config.json`

`upstream` and `resolveFrom` are npm concepts (spec templates, `node_modules` resolution). They
move under a per-ecosystem key, and the top-level keys stay as aliases for `ecosystems.npm`:

```json
{
  "ecosystems": {
    "npm":   { "upstream": { "lib": "file:../mirror/lib-{version}" }, "resolveFrom": { "semver": "packages/core" } },
    "cargo": { "manifest": "Cargo.toml" },
    "go":    { "module": "." },
    "pypi":  { "python": ".venv/bin/python", "platform": "manylinux_2_28_x86_64" }
  },
  "mechanisms": { "patch": { "applier": { "npm": "patch-package", "cargo": "cargo-vendor" } } }
}
```

`mechanisms.patch.applier` keeps accepting a string, which means npm. The object form selects
an applier per ecosystem. An applier that doesn't belong to the graft's ecosystem is an error.

### 3.4 Package-manager detection (§8) becomes per ecosystem

Each ecosystem detects its own tool, so a repository with both `package.json` and `Cargo.toml`
works: an npm graft uses §8 as written, and a cargo graft uses Cargo's rules. §8 becomes "npm
detection", plus a short section per ecosystem.

### 3.5 Grouping keys

Sync groups, `outdated` entries and `graft/duplicate-rootstock` key on
`(ecosystem, package)`, not `package`, so an npm `ms` and a crate `ms` never collide.
Reports (`sync.json`, `outdated --json`) gain an `ecosystem` field on each entry. This is
additive for JSON consumers.

## 4. Core: the `Ecosystem` interface

`UpstreamSource` already has the right shape (`resolve`, `installed`, `versions`, `installSpec`).
The proposal puts it, detection and installation behind one object per ecosystem:

```ts
interface Ecosystem {
  name: 'npm' | 'cargo' | 'go' | 'pypi';
  scheme: VersionScheme;                      // from @graftsync/spec: valid, satisfies, intersects, compare
  /** Pristine published contents, installed copies, published versions. */
  upstream(project: Project): UpstreamSource;
  /** The tool that manages this ecosystem's dependencies in the project, e.g. 'pnpm', 'cargo', 'uv'. */
  detect(root: string): string;
  /** Install exactly `pkg@version`; returns the command run (for the report). */
  install(root: string, pkg: string, version: string): Promise<string>;
  /** Re-resolve after appliers changed configuration. */
  reinstall(root: string): Promise<string>;
}
```

- `PackageVersions.distTags` stays. Ecosystems without dist-tags synthesize `latest` (newest
  stable) and `next` (newest prerelease), so `outdated` doesn't change.
- `Project.upstream` stays (npm) for compatibility; `Project.upstreamFor(graft)` and
  `Project.ecosystemFor(graft)` are what core and the adapters switch to. About 35 lines in
  core, `adapter-patch` and `adapter-fork` (`project.upstream.*`, `installedVersion`,
  `detectPackageManager`).
- `MechanismAdapter` is unchanged: its four required members and the existing optional hooks
  are enough. Appliers are internal to `adapter-patch`, keyed by ecosystem.
- `DirectoryUpstreamSource` (tests, offline evals) takes an ecosystem name so the same
  fixtures can test every ecosystem's sync logic without a registry.

## 5. Ecosystems

Each section answers the same questions: what is the pristine artifact, where do versions come
from, how is the installed copy found, how is a patch applied, and **how could that apply fail
silently**. The silent failures below were each reproduced with the real tool on 2026-11-12
(cargo 1.97, go 1.24, pip 24, uv 0.11, poetry 2.4).

### 5.1 Cargo

- **Pristine artifact:** the published `.crate` (a gzipped tar). Cargo has no "download one
  crate" command, so Graft resolves `<crate> = "=<version>"` in a throwaway manifest, runs
  `cargo fetch` (which applies the project's `.cargo/config.toml` registries, mirrors and auth,
  the way npm applies `.npmrc`), and extracts the `.crate` from Cargo's registry cache.
  - The published `Cargo.toml` is **normalized** by `cargo publish` (the author's file is kept
    as `Cargo.toml.orig`). Variants patch the published files, per the "diff what the mechanism
    sees" rule. Agents need to know this, so the skill should say it.
- **Versions:** the registry's sparse index (`index.crates.io/<prefix>/<crate>`), one JSON line
  per version, yanked flagged. Yanked versions are never candidates.
- **Installed copy:** `cargo metadata --format-version 1` gives each package's version, source
  and `manifest_path`. Registry sources are shared, extracted copies in `~/.cargo/registry/src`.
- **Appliers.** Cargo has no native patch files, so the default is a vendor applier:
  - `cargo-vendor` (default): pristine + variant written to `.grafts/.vendor/<crate>-<version>/`
    (a directory, committed), and the workspace root's `Cargo.toml` gets
    `[patch.crates-io] <crate> = { path = ".grafts/.vendor/<crate>-<version>" }` (edited
    comment-preserving, like `pnpm-workspace.yaml` today). Other registries use
    `[patch.<registry>]`.
  - **Silent failure:** when the vendored version doesn't match what the lockfile resolves,
    `cargo build` **exits 0**. It prints a warning ("patch … was not used in the crate graph")
    and records the patch under `[[patch.unused]]` in `Cargo.lock`. The applier's `problems()`
    therefore fails on any `[[patch.unused]]` entry for the crate, and `graft check` fails
    unless `cargo metadata` shows the crate's source as the vendored path at the variant's
    version.
  - A project that uses `cargo vendor` with source replacement can't also `[patch]` the same
    crate from a path in every configuration; refuse with a reason until it's tested.
- **Install:** `cargo update -p <crate> --precise <version>`.
- **Fork, package mode:** `cargo package --no-verify` instead of `npm pack`, checked to produce
  `<crate>-<version>.crate`, extracted into `.grafts/.vendor/`, then the same `[patch]` wiring.
- **Real-tool tests:** a fixture crate depending on a small, stable crate (`itoa`), across a
  version bump that keeps the hunks (green) and one that moves them (needs-agent), plus the
  unused-patch failure path.

### 5.2 Go modules

- **Pristine artifact:** `go mod download -json <module>@<version>` returns `Dir`, the
  extracted module in the module cache. It's verified against `go.sum` and the checksum
  database, and it's read-only. This is a stronger pristine guarantee than npm has. It follows
  the project's `GOPROXY`, `GOPRIVATE` and `GONOSUMDB`.
- **Versions:** `go list -m -versions <module>`; `go list -m -json <module>@latest`. Retracted
  versions are excluded.
- **Installed copy:** `go list -m -json <module>` from the main module: `Version`, `Dir`, and
  `Replace` when one applies.
- **Appliers:**
  - `go-replace` (default): pristine + variant written to
    `.grafts/.vendor/<escaped-module>@<version>/` (committed), and `go.mod` gets
    `replace <module> <version> => ./.grafts/.vendor/<escaped-module>@<version>`. The replace is
    **version-qualified**, so after a bump it stops applying and `graft check` catches it, instead
    of silently applying an old variant to new code.
  - **Silent failure:** a version-qualified `replace` that doesn't match the selected version
    is **silently ignored**: `go build` exits 0 and uses the module cache. The applier fails
    unless `go list -m -json <module>` shows `Replace.Dir` equal to the vendored directory.
  - `replace` is honored only in the main module's `go.mod` (or `go.work`). Detection uses
    `go env GOWORK`: in a workspace the replace goes in `go.work`.
  - Projects that commit `vendor/` (`go mod vendor`): the replaced directory is what gets
    vendored, so `vendor/modules.txt` must show the replacement. Check it rather than assume.
- **Install:** `go get <module>@<version>` (which updates `go.mod` and `go.sum`).
- **Fork, package mode:** no pack step is needed: the rebased checkout's module directory is
  the replacement, copied into `.grafts/.vendor/`.
- **Real-tool tests:** `golang.org/x/text` (small API surface, frequent releases), with the
  mismatched-replace failure path, and a `go.work` fixture.

### 5.3 Python (PyPI)

The largest step, for three reasons: the version scheme (§3.2), the choice of artifact, and no
package manager that applies patches (pip 24, uv 0.11 and poetry 2.4 have no patch command).

- **Pristine artifact:** the **wheel**, because that is what gets installed into
  `site-packages`. Fetched with `pip download --no-deps --only-binary :all: <name>==<version>`
  (or `uv`, if that's the project's tool), following the project's index configuration.
  - Pure-Python wheels (`py3-none-any`) are the target. For packages that publish only
    platform wheels, `ecosystems.pypi.platform` pins the tag whose wheel is the pristine
    artifact; the patch must touch only files that are identical across the platform wheels
    (checked, not assumed).
  - The sdist is a different artifact (source layout, a build step). Grafts on source belong in
    the `fork` mechanism, not `patch`.
- **Versions:** the PyPI JSON API (`/pypi/<name>/json`), or the simple API (PEP 691) for
  private indexes. Yanked releases are never candidates.
- **Installed copy:** the project's interpreter (`ecosystems.pypi.python`, else `.venv`, else
  `python3`) runs `importlib.metadata.distribution(name)` to get the version and files.
  Installed files are compared to pristine + variant as npm's are. `RECORD`'s hashes describe
  the pristine wheel, so a patched file is expected to differ from `RECORD`.
- **Appliers:**
  - `wheel-vendor` (default): pristine wheel + variant repacked as
    `.grafts/.vendor/<name>-<version>-<tags>.whl` (committed, `RECORD` regenerated), and the
    project points at it: `[tool.uv.sources]` for uv, a `path` dependency for poetry, a direct
    reference (`name @ file:…`) in requirements files for pip. The version stays `<version>`,
    not a local version label: resolvers treat `+local` as a different version and would
    re-resolve away from it.
  - **Silent failure to rule out first:** whether uv and poetry re-read a path wheel whose
    contents changed under the same filename, or keep a cached build. This is untested; the
    applier must hash the vendored wheel into its name or check the installed files, whichever
    the test shows is needed.
  - `graft` (opt-in): patch `site-packages` after install (`graft apply --installed`). Python has
    no `postinstall` hook, so this only works if the project's own setup runs it after every
    `pip install` / `uv sync`. `graft check` in CI is the backstop. Not a default.
- **Install:** `uv add <name>==<version>` / `poetry add <name>@<version>` / an edited pin plus
  `pip install`, by detected tool (`uv.lock`, `poetry.lock`, then `requirements*.txt`).
- **Fork, package mode:** `python -m build --wheel` (or `uv build --wheel`), checked to produce
  `<name>-<version>-*.whl`, then the `wheel-vendor` wiring.

## 6. Rollout

Each phase is one change set with tests against the real tool, the docs updated in the same
commit (spec, README, skill, handoff), and a real project checked where possible.

1. **Reserve the field (with the v1 freeze).** `rootstock.ecosystem` (npm only),
   `frontmatter/unknown-ecosystem`, the `Ecosystem` interface with npm moved behind it,
   `(ecosystem, package)` grouping, the `ecosystem` field in reports. No behavior change; the
   existing suite and the dogfood grafts are the proof.
2. **Cargo.** `CargoUpstreamSource`, `cargo-vendor`, fork package mode via `cargo package`.
   Tests: green bump, needs-agent bump, `[[patch.unused]]`, tampered installed copy, a workspace
   with several members.
3. **Go.** Module-cache source, `go-replace`, `go.work`, `vendor/`. Tests as for Cargo, plus
   the silently ignored replace.
4. **PyPI.** PEP 440 scheme in `@graftsync/spec` (with its own overlap tests), wheel source,
   `wheel-vendor` for uv, poetry and pip. Start by testing the cached-wheel question in §5.3.

`graft capture` follows each ecosystem where there's an editable installed copy: Cargo
(`~/.cargo/registry/src`, shared, so capture must warn that the edit affects every project) and
Python (`site-packages`). Go's module cache is read-only, so there's nothing to capture.

## 7. Open questions

1. **Are ecosystems plugins?** Mechanisms are registered adapters. Ecosystems could be too
   (a registry of `Ecosystem` objects), but every one needs spec text for its version scheme
   and silent failures. Proposal: listed in the spec, implemented in core, no plugin API yet.
2. **One package per graft across ecosystems.** A change that spans an npm package and the
   crate it wraps via napi is two grafts. Same answer as the existing open question.
3. **Cargo's range syntax.** Using node-semver ranges for Cargo keeps one syntax for semver
   ecosystems but differs from what Rust users write in `Cargo.toml` (`1.0` means `^1.0`).
   Explicit ranges in `graft.md` are less surprising than Cargo's implicit caret; open to the
   other choice.
4. **Python platform wheels.** Is "patch only files identical across the platform wheels"
   enough, or should a graft be able to carry a variant per platform tag?
5. **Ecosystem names.** `pypi` (the registry) rather than `python` or `pip` (one of three
   tools), and `cargo` rather than `crates` or `rust`. These follow the
   [package-URL](https://github.com/package-url/purl-spec) types (`npm`, `cargo`, `golang`,
   `pypi`) except `go`; adopting `golang` instead would make a later purl export trivial.

## 8. What implementation changed

- **The uv / pip question (§5.3)** was tested first. uv pins a path wheel's hash in `uv.lock`
  and fails `uv sync` loudly on a changed wheel, but a plain `uv lock` keeps the old hash, so
  reinstall runs `uv lock --upgrade-package <name>`. pip treats a changed wheel of the same name
  and version as "already satisfied", exits 0 and keeps the old code: a silent failure, so
  reinstall force-reinstalls the vendored wheels, and the installed-files check catches the
  rest. The wheel keeps its published filename (no hash in the name was needed).
- **Go's vendored directory** is `<module, / as +>-<version>`, not `…@<version>`: in `go.work`,
  `go work edit` reads the `@` as a version.
- **Go installs with `go get`**, not a bare reinstall: for a new version the `require` must move,
  and the version-qualified replace then applies.
- **PEP 440 matching** follows Python's `packaging` 26, which compares `<V` and `>V` against the
  exact version rather than its base release (older `packaging` differed on post- and
  prereleases). Verified on a 21 × 21 version/specifier matrix.
- **The Go version scheme** is node-semver itself (it accepts the `v`), plus a
  `normalizeVersion` hook on `Ecosystem` so `--version 0.11.0` means `v0.11.0`.
- **Deferred:** poetry, uv for transitive dependencies, the `fork` mechanism's package mode
  outside npm (it refuses with `fork/ecosystem`).
- **`graft capture`** works in every ecosystem, on what the tool actually uses: cargo's and go's
  vendored copy (or cargo's registry source; go's read-only module cache is refused with
  directions), and the wheel's own files in site-packages. Go modules turned out capturable after
  all, through the replacement directory.
- **Open questions (§7)** were answered as proposed: ecosystems are listed in the spec and
  implemented in core (no plugin API); Cargo uses node-semver ranges; a pypi graft patches one
  wheel (`ecosystems.pypi.platform` picks it); the names are `npm`, `cargo`, `go`, `pypi`.
