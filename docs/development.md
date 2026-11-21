# Development, architecture and releases

Contributions are welcome: see [`CONTRIBUTING.md`](../CONTRIBUTING.md), and report security issues by opening an issue ([`SECURITY.md`](../SECURITY.md)). For the current project state, design decisions and open work, see [`handoff.md`](handoff.md).

## Packages

| Package | State | Purpose |
|---|---|---|
| [`@graftsync/spec`](../packages/spec) | ✅ implemented | `graft.md` schema (zod), parser and validator, comment-preserving editor, starter template. |
| [`@graftsync/core`](../packages/core) | ✅ implemented | See the list below. |
| [`@graftsync/cli`](../packages/cli) | ✅ implemented | `graft` command for humans and CI. |
| [`@graftsync/skill`](../packages/skill) | ✅ implemented | [`SKILL.md`](../packages/skill/SKILL.md) teaching agents the sync loop. |
| [`packages/action`](../packages/action) | ✅ implemented | GitHub Action: poll upstream versions, run sync, open PRs, and hand failures to your agent. |
| [`@graftsync/adapter-patch`](../packages/adapters/patch) | ✅ implemented | The `patch` mechanism and its appliers (pnpm, npm, bun, yarn, built-in, patch-package, vendor, cargo-vendor, go-replace, wheel-vendor). |
| [`@graftsync/adapter-fork`](../packages/adapters/fork) | ✅ implemented | The `fork` mechanism: commits on a fork, rebased, built and packed per upstream version, or (repo mode) rebased and verified in place. |

`@graftsync/core` contains:

- the `MechanismAdapter` and `Ecosystem` interfaces and the project loader,
- upstream sources for npm, Cargo, Go, PyPI and local directories,
- the command runner (generators, installs, fork builds),
- scoped diffs and transactional workspace rollback,
- `recordVariant`, which narrows ranges and never edits existing variants,
- status, `sync`, `init`/`add` scaffolding, `outdated`, and `replay`.

All logic lives in `core` and the adapters. The CLI is a thin front-end over those functions; the GitHub Action and agents drive Graft through it.

## Writing a mechanism adapter

A mechanism plugs in by implementing `MechanismAdapter` from `@graftsync/core`:

```ts
interface MechanismAdapter {
  name: string;
  apply(ctx: GraftContext, options?: ApplyOptions): Promise<ApplyResult>;
  checkAnchors(ctx: GraftContext, version: string): Promise<AnchorReport>;
  checkInstalled?(ctx: GraftContext, version: string): Promise<InstalledCheckReport>;
  scopeDiff(ctx: GraftContext, from: string, to: string): Promise<ScopedDiff>;
  beforeInstall?(ctx: GraftContext, version: string): Promise<void | { install?: 'reinstall' }>;
  afterInstall?(ctx: GraftContext, version: string): Promise<void>;
  applyInstalled?(ctx: GraftContext): Promise<InstalledApplyReport>;
  validateVariant?(ctx: GraftContext, variant: ResolvedVariant): Promise<void>;
  exclusivePerPackage?: boolean;
  variantExtension?: string;
  variantTemplate?(graft: { id: string; targets?: string[]; package: string }): string;
  scaffoldFrontmatter?(graft: { id: string; package: string; version: string }): Record<string, unknown>;
}
```

Every adapter must follow these rules:

1. **Fail loudly on no-match.** An anchor that's missing or matches ambiguously is an error. A graft must never silently apply nothing.
2. **Anchor by behavior.** Prefer stable exported symbols over the shape of the code, and never match on formatting.
3. **Add variants, don't rewrite them.** Older version ranges keep their variants and tests.
4. **Diff what the mechanism sees.** Work on the pristine upstream artifact the mechanism modifies, never the installed copy: the published package for `patch`, the upstream source at the release tag for `fork`.

## Local setup

Requires Node 22.22+, 24.15+, or 26+ and pnpm 10. All Graft packages are ESM only: import them with `import`; `require()` is not supported.

```sh
pnpm install
pnpm build      # tsc -b across the workspace
pnpm test       # vitest
pnpm lint       # oxlint
pnpm format     # oxfmt (pnpm format:check in CI)
pnpm graft status
```

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets). All `@graftsync/*` packages are versioned together.

1. With a user-facing change, run `pnpm changeset`, pick a bump, describe the change, and commit the generated `.changeset/*.md` with your PR.
2. When you want to release, run the **Release** workflow manually from the Actions tab (or `gh workflow run release.yml`). It doesn't run on push. With pending changesets, it opens or updates a "Version packages" PR that bumps versions and writes changelogs (`pnpm version-packages`).
3. Merge that PR, then run **Release** again. With no changesets pending, it runs `pnpm release` (build, then `changeset publish`), which publishes every version not yet on npm. It then tags the release once, `v<version>` (the `@graftsync/*` packages share one version), and creates its GitHub release from the CLI's changelog. Re-running Release tags a published version that has no tag yet.

The CLI package ships the root `README.md`: packing `@graftsync/cli` writes it into the package with its relative links pointed at the release's `v<version>` tag on GitHub, and its images at the packed commit (`tools/package-readme`), and fails on a link to a path that doesn't exist. Images can't wait for the tag: Release tags only after publishing, and npmjs.com fetches and caches README images when it first renders the package.

Prerequisites (done): the `graftsync` npm organization exists, and an npm token that can publish to it is set as the `NPM_TOKEN` repository secret. Without the secret, the workflow skips the release step.

## Roadmap

- **M0 — Spec and skeleton:** schema, parser, validator, adapter interface, `graft init/add/status`. *(Done.)*
- **M1 — First mechanism adapter, with a design partner.** Capture one real modification as a graft, with Invariants its project's tests cover. *(The `patch` adapter is done and dogfooded on pacote, semver and yaml; an external design partner is still to come.)*
- **M2 — Deterministic first pass in CI:** `graft check/diff/sync/verify`, reports, and a GitHub Action that opens PRs when everything passes. *(Done.)*
- **M3 — Agent path:** agent-facing CLI commands, skill file, and the action's hand-off to an agent. Evaluated by replaying historical prereleases. *(The CLI commands, skill and Action hand-off are done; the historical-prerelease eval is pending. The brief's MCP server was built and then removed: agents use the CLI.)*
- **M4 — Second, unrelated mechanism,** to prove the abstraction generalizes. Spec v1 is frozen only after this. *(The `fork` mechanism is done: git commits on a fork, rebased, built and packed per upstream version, using the same adapter interface. Freezing spec v1 is still open.)*
