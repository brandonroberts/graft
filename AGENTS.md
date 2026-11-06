# AGENTS.md

Guidance for coding agents working **on Graft itself**. To *use* Graft in another project, read
the [`graft-sync` skill](packages/skill/SKILL.md) and the README's "hand it to your coding
agent" prompts instead.

Graft keeps local modifications to upstream software ("grafts") working across upstream
releases. Before changing anything, read these:
- [`docs/handoff.md`](docs/handoff.md): current state, decisions, open work.
- [`docs/spec.md`](docs/spec.md): the normative format and tooling contract.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm build                                   # tsc -b (TypeScript 7)
pnpm test                                    # vitest: unit, CLI, Action (real git, fake gh), yarn/PnP fixtures
node packages/cli/dist/bin.js check          # the dogfood grafts must be applied
node packages/cli/dist/bin.js sync --quiet   # and green
pnpm test:grafts                             # and still behave like the pristine packages
pnpm lint                                    # oxlint, warnings fail
pnpm format:check                            # oxfmt; `pnpm format` rewrites
```

- **CI** runs the build, tests and graft checks on Node 22, 24 and 26, and lint and format once on Node 24. Run them all before every push.
- **Lint and format:** oxlint (`.oxlintrc.json`) and oxfmt (`.oxfmtrc.json`: 140 columns, single quotes). oxfmt skips Markdown, HTML, `pnpm-lock.yaml` and `.grafts/`; oxlint skips the generated variants.
- **Build first:** tests and the CLI use `dist/`, so rebuild before running them.
- **Running one package's tests:** `cd packages/<pkg> && npx vitest run [-t "<name>"]`.

## Layout

| Path | What |
|---|---|
| `packages/spec` | `graft.md` schema (zod), parser, validator, comment-preserving YAML editor |
| `packages/core` | Project loading, the `MechanismAdapter` interface, sync, scoped diffs, outdated, replay, scaffold, capture |
| `packages/adapters/patch` | The `patch` mechanism and its appliers (pnpm, npm ≥ 12, bun, yarn berry, built-in `graft`, patch-package, vendor) |
| `packages/adapters/fork` | The `fork` mechanism, including repo mode (`fork.install: none`) |
| `packages/cli` | The `graft` CLI, a thin front-end |
| `packages/skill` | `SKILL.md`, which teaches agents to use Graft |
| `packages/action` | The GitHub Action: plain ESM `.mjs`, no build step, private, used from `main` |
| `tools/cjs-to-esm` | Generator for the dogfood grafts |
| `.grafts/` | This repo's own grafts: pacote, semver and yaml converted to native ESM; their behavior checks are `check.mjs`, run by `pnpm test:grafts` |
| `examples/angular-tr` | A repo-mode setup tested against a real fork |

## Rules

### Code

- **Logic lives in core and the adapters.** The CLI and the Action only call them. Agents drive Graft through the CLI, and every command takes `--json`.
- **ESM only.** Packages export only `import` conditions. Node `^22.22.2 || ^24.15.0 || >=26`.
- **Fail loudly.** A graft must never silently apply nothing.
  - A missed anchor, an unsupported case, or a package manager that would drop a patch is an error with a reason, never a warning or a pass.
  - When you find a silent failure mode, add a check for it.
- **Graft checks fit, not behavior.** Sync proves a graft still fits and installs; there is no runtime check (the oracle was removed in 0.2). Behavior is verified by the agent with the project's own tests. Never let Graft output claim it verified behavior, and never weaken a test to make a graft pass.
- **Never edit an existing variant.** Add a new one (`graft variant add`). This applies to the dogfood grafts in `.grafts/` too; regenerate those with their generator.
- **Diff what the mechanism sees.** Work on the pristine artifact (the published tarball, or the upstream source tag), never on the installed copy.
- **New adapter behavior goes behind optional hooks** on `MechanismAdapter`. Keep the four required members (`name`, `apply`, `checkAnchors`, `scopeDiff`) stable. The spec is near freeze (#6), so discuss interface changes there first.

### Tests

- **Test with real tools.** Tests run real `git` and real package managers on temporary fixtures; the Action's tests use a fake `gh` and a fake `graft`.
  - Prove a fix on a real project too when you can.
  - Earlier real targets: `ms` across pnpm, npm, yarn, bun and upm; `vercel/ms` as a fork; angular-tr against real angular/angular.
  - Record what you verified in the commit message.
- **Every behavior change gets a test,** including the failure path.

### Docs

Keep these in step with the code, in the same commit:
- the spec (normative: every diagnostic code, hook and environment variable);
- the README;
- the skill, for anything an agent using Graft must do differently;
- the Action README, for Action behavior;
- the handoff, for state and decisions.

## Gotchas this repo has hit

- **YAML in test fixtures.** Fixture frontmatter is often built with single-quoted YAML. A `'` inside a command breaks it, so put scripts in files instead.
- **Fake `gh` and `graft` scripts** are written from TypeScript template literals. `\'` becomes `'` there and breaks the generated script.
- **Shell commands blocked by the safety check.** Heredocs containing `rm -rf` patterns or `$${…}` get blocked. Use the Write/Edit tools, and `"${VAR:?}"` in `rm` paths.
- **`graft.md` edits must keep comments and formatting.** Go through `GraftDocumentEditor` / `updateGraft`, never string-replace YAML.
- **Repo mode (fork):**
  - Checks that compare "before" with "after" (like `examples/angular-tr`'s `check-pages.mjs`) must baseline on the fork's last commit (`HEAD`), not the working tree: after an `-agent` branch is adopted, the working tree *is* the result.
- **npm stages new publishes** for a few minutes. Don't treat `npm view` returning 404 right after a publish as failure.
- **GitHub Actions status can lag** during incidents, showing `queued` for runs that already finished. Check job step timestamps before assuming anything is stuck.

## Commits, branches and releases

- **Commit messages:** an imperative subject (an optional `area:` prefix is fine), then a body saying *what* and *why*, and what was verified. Reference issues (`Closes #N`). Never put model names or IDs in commits, code or docs.
- **Commit trailers:** follow the attribution instructions you're given.
- **Don't push automatically.** Commit locally and stop. Push only when the person you're working for explicitly asks, and only to the branch they name.
  - Contributors work on a branch and open a pull request. Only the maintainer lands changes on `main`, and CI must be green first.
  - Never push to `main`, tags, other people's forks or upstream repositories unless the maintainer asks.
  - Graft itself never pushes on a user's behalf either.
- **Releases (Changesets):** all `@graftsync/*` packages share one version.
  1. Add `.changeset/*.md`. While in 0.x, `minor` means breaking and `patch` means everything else.
  2. Run `pnpm version-packages`. Check the generated CHANGELOGs for nested bullets.
  3. Commit and push.
  4. Run the **Release** workflow manually. It publishes without provenance, then tags `v<version>` and creates the GitHub release from `packages/cli/CHANGELOG.md`. Re-running it backfills a missing tag.
  5. Publishing is irreversible: confirm with the maintainer first.
- **The sync workflow** (`.github/workflows/graft-sync.yml`) and Release are manual-trigger only. Don't add schedules unless asked.
- **GitHub posts:** comment on issues and PRs only when asked or when it records a result. Close issues with a comment saying what was done and verified.
