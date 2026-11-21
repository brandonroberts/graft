# Agents, CLI and Invariants

Agents drive Graft through the same `graft` CLI people use. Every command takes `--json` and `--root`, and exits `0` ok, `1` needs attention, or `2` tooling error.

## Concepts

| Term | Meaning |
|---|---|
| **Graft** | One local modification to an upstream package, described by a `graft.md` intent file. |
| **Rootstock** | The upstream package, and the last version the graft was verified against. |
| **Intent** | A plain-language description of what the modification does and why, written so an agent can act on it. |
| **Mechanism** | How the modification is applied: a patch file, a vendored copy or a fork, for example. |
| **Anchors** | What the mechanism matches on in the upstream code, and why each anchor was chosen. |
| **Variant** | One implementation of the mechanism, valid for a range of upstream versions. |
| **Invariants** | The observable behaviors the graft guarantees, and which of the project's tests cover them. Graft checks that a graft still *fits*; whoever changes it verifies the Invariants. |

## Writing Invariants

The Invariants are the contract, so make them checkable:
- **One observable behavior per bullet,** and name the test that covers it. If no test does, add one to the project's suite, and show it fails without the graft.
- **Test what the graft changes, not the whole stack.** For a patch that stops a dependency loading Node polyfills, assert it doesn't load them; you don't need a browser.
- **Browser tests fail on console errors and 5xx responses too,** not only uncaught exceptions: Angular, React and Vue catch errors and only log them.

## Agent CLI commands

Beyond `status`, `check`, `diff`, `apply` and `sync`, these commands cover the agent workflow:

| Command | Purpose |
|---|---|
| `graft show <id>` | The intent (all body sections), variants with resolved paths, and the variant selected for the installed version |
| `graft capture <id> [--version X]` | Write your edit of the installed package as the variant: the diff against the published package. Replaces the untouched scaffold stub, or adds a new variant (`>=X`) if a real one exists; refuses a copy that is exactly pristine + the selected variant (no new change); rolls back unless it applies to pristine `X` |
| `graft preview <id> [--version X] [--out dir]` | Apply a graft's variant to pristine upstream and write the modified files for inspection; installs nothing |
| `graft variant add <id> --range R --module M [--verify-version X] [--note "…"]` | Register a new variant. Never edits existing variants. Narrows overlapping open-ended ranges (`--no-narrow` refuses instead). With `--verify-version`, rolls back unless every anchor matches there (the version must be inside the new range) |
| `graft mark <id> [--status S] [--verified X] [--history "…"]` | Set status and `verified`, and append a History entry |

## The `graft-sync` skill

The [skill](../packages/skill/SKILL.md) (`graft-sync`) teaches any agent the loop and its rules:
- run the deterministic first pass first;
- read the intent before changing anything;
- never edit an existing variant;
- treat the Invariants as the contract, and verify them with the project's tests;
- never weaken a test to make a graft pass;
- know when to stop and mark `conflicted`;
- write the PR description in the given format.

To set it up in a project, run **`graft init --agent`**. It installs the skill as `graft-sync/SKILL.md` into the skills folders the project's agents already use, from the `@graftsync/skill` package:
- every existing skills folder among `.claude/skills`, `.agents/skills`, `.codex/skills`, `.cursor/skills`, `.gemini/skills` and `.github/skills`;
- failing that, `skills/` under each existing agent folder (`.claude/`, `.agents/`, `.codex/`, `.cursor/`, `.gemini/`). `.github/` alone doesn't count, since most repos have it just for workflows;
- with no agent detected, it stops before creating anything and asks for `--skills-dir <path>` (comma-separated for several), rather than guessing. `--skills-dir` always overrides detection.

Re-running updates the skill when Graft ships a new version. It also notes if `@graftsync/cli` isn't a dependency yet.

The CLI runs in the agent's shell, so it inherits the usual proxy settings (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, and `NODE_EXTRA_CA_CERTS` for a proxy that re-signs TLS). Pristine npm packages are fetched by the project's own `npm` (run from the project root, so its `.npmrc` registries, scoped registries and auth apply), which must be on `PATH`.

This repo uses it on itself: [`.claude/skills/graft-sync`](../.claude/skills/graft-sync/SKILL.md) links the skill.
