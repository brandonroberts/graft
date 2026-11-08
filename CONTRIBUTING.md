# Contributing to Graft

Thanks for helping. Graft is in early development, and the spec is close to freezing ([#6](https://github.com/brandonroberts/graft/issues/6)), so open an issue before starting anything large: a new mechanism, a change to `MechanismAdapter`, or a change to the `graft.md` format.

## Setup

You need Node 22.22+, 24.15+ or 26+, and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm build                                   # tests and the CLI run from dist/, so build first
pnpm test
node packages/cli/dist/bin.js check          # this repo's own grafts must be applied
node packages/cli/dist/bin.js sync --quiet   # and green
pnpm test:grafts                             # and still behave like the pristine packages
pnpm lint
pnpm format:check                            # `pnpm format` fixes it
```

CI runs all of these. Run them before you open a pull request.

## What we look for

[`AGENTS.md`](AGENTS.md) has the full rules (they apply to people too). The ones that come up most:

- **Fail loudly.** A graft must never silently apply nothing. A missed anchor, an unsupported case, or a package manager that would drop a patch is an error with a reason.
- **Graft checks fit, not behavior.** Nothing Graft prints may claim it verified behavior.
- **Logic lives in core and the adapters.** The CLI and the Action only call them.
- **Test with real tools.** Tests run real `git` and real package managers on temporary fixtures. Every behavior change gets a test, including the failure path.
- **Never edit an existing variant,** including the dogfood grafts in `.grafts/`. Regenerate those with `tools/cjs-to-esm`.
- **Keep the docs in step** in the same change: the spec, the README, the skill, the Action README and the handoff, wherever they describe what you changed.

[`docs/handoff.md`](docs/handoff.md) explains the current design and why it is the way it is. [`docs/spec.md`](docs/spec.md) is the normative format.

## Pull requests

- One change per pull request, with a description of what changed, why, and how you verified it (which commands, and any real project you tried it on).
- Add a changeset for anything that affects a published package: `pnpm changeset`. While Graft is 0.x, `minor` means breaking and `patch` means everything else.
- Only the maintainer merges to `main`, and only with CI green.

## Reporting bugs

Use the bug report template, and include the `graft` version, your package manager and its version, and the `--json` output of the failing command. Report security issues the same way; [`SECURITY.md`](SECURITY.md) says what to include.
