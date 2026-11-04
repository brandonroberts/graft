---
name: graft-sync
description: Keep local modifications ("grafts") to upstream npm packages working when upstream releases a new version. Use when a repo has a `.grafts/` directory and an upstream dependency was bumped, `graft sync` reported `needs-agent`, a graft's anchors miss or its oracle fails, or you are asked to sync, repair, add, or retire a graft.
---

# Graft sync

A **graft** is one local modification to an upstream package, described by
`.grafts/<id>/graft.md`. The repo's grafts are the contract between the people who wrote
them and you. Your job when upstream moves is to make each graft hold again — or to say
clearly that it can't.

## What a graft is made of

`graft.md` frontmatter:

- `rootstock.package` / `rootstock.verified` — upstream package and the last version the
  oracle passed against.
- `mechanism` — how it is applied (e.g. `patch`: a pnpm `patchedDependencies` patch file).
- `variants` — one implementation per upstream version range (`range` + `module` path).
  Ranges are disjoint; exactly one variant applies to any version.
- `oracle` — the command that proves the invariants hold, run once per `mode`
  (with `GRAFT_MODE` and `GRAFT_UPSTREAM_VERSION` set).
- `status` — `applied` | `conflicted` | `upstreamed` | `obsolete`.

Body sections, all required — read them before touching anything:

- **Why** — what the modification enables and why upstream doesn't do it.
- **Invariants** — observable behaviors that must hold. **This is the contract.**
- **Where to look** — the upstream area, described by behavior so you can re-find it after
  a refactor. Trust this over file paths.
- **Anchors** — what each variant matches on and why it was chosen.
- **History** — what changed upstream each time and how the graft adapted.

## Tools

Use the `graft` MCP server if it is connected; otherwise the `graft` CLI. They are the same
operations.

| Step | MCP tool | CLI |
|---|---|---|
| Overview | `list_grafts` | `graft status` |
| Deterministic first pass | `sync` | `graft sync [--version X] [--install]` |
| Read intent + variants | `read_graft` | open `.grafts/<id>/graft.md` |
| Anchor report | `check_anchors` | `graft check <id> --version X` |
| What moved upstream | `scope_diff` | `graft diff <id> [from] [to]` |
| Try existing variants | `apply_cached` | — |
| Wire the package manager to the selected variants + reinstall | `apply_to_project` | `graft apply` |
| Prove it | `run_oracle` | `graft verify <id>` |
| Register a new variant | `record_variant` | — |
| Status + History | `update_status` | — |

Reports from `sync` land in `.grafts/.report/` (`sync.md`, `sync.json`, and per graft
`diff.patch` and `applied/`).

## The loop

1. **Run the deterministic first pass first.** `sync` (or `graft sync --version X --install`).
   Never re-derive what already passes. Green grafts are done — `sync` already bumped
   `verified` and wrote History. Only grafts marked `needs-agent` are yours.
2. **Gather context for each `needs-agent` graft**, in this order:
   `read_graft` → the reasons in the sync report → `check_anchors` at the target version →
   `scope_diff` from `verified` to the target → the failing oracle output, if the oracle ran.
3. **Locate the new equivalent code by behavior.** Use *Where to look* and *Anchors*, then
   the scoped diff. If a target file was removed or renamed, search the new version's
   published files for the behavior (the pristine copy is under `.grafts/.cache/upstream/`). Upstream
   renames and moves are normal; the behavior is what you are re-finding.
4. **Write a new variant for the new range** with your own editing tools, inside the graft's
   directory (e.g. `variants/v5.patch`). See *Mechanisms* below.
5. **Iterate until anchors match:** `check_anchors` with the target version after every edit.
   It is fast and checks pristine upstream contents.
6. **Register it:** `record_variant` with `range`, `module`, `verifyVersion` (the target
   version), and a `note` saying what moved upstream and how the variant differs. Older
   open-ended ranges are narrowed automatically; existing variant files are never touched.
7. **Prove it:** re-run `sync` for the target version with `install: true`
   (`graft sync --version X --install`). With anchors now matching, it wires the package
   manager to the new variant, installs the target, and runs the oracle in every mode; on
   green it sets `verified` and status `applied`. (Or install yourself, `run_oracle`, then
   `update_status` with `status: applied` and `verified: <target>`.)
8. **Finish:** open a PR (see below).

## Adding a new graft

When asked to capture a modification as a graft (new, or migrating an existing patch):

1. **Scaffold:** `graft init` (once), then `graft add <id> --package <pkg> --target <file>`.
   This creates `graft.md`, an empty variant stub (which fails loudly until written), and an
   oracle stub that exits 1.
2. **Write the intent first,** with the person who owns the modification if you can: *Why*,
   the *Invariants* (observable behaviors, one per bullet), *Where to look* (by behavior), and
   *Anchors* (what the variant matches on and why).
3. **Write the variant.** For `patch`: run `pnpm patch <pkg>@<installed>`, make the change in the
   printed directory, then run `pnpm patch-commit <dir> --patches-dir <tmp>`. Move the generated
   file onto the scaffolded `variants/v<major>.patch`. `pnpm patch-commit` may also write a
   version-pinned entry to `package.json`; the next step replaces it.
4. **Apply it:** `apply_to_project` / `graft apply`. This points the package manager at the
   variant, reinstalls, and re-checks anchors.
5. **Write the oracle** so it fails before the modification and passes after. Check that it
   fails without the graft. An oracle that can't fail proves nothing. Test the Invariants,
   plus at least one pre-existing behavior the graft must not break.
6. **Prove it:** `run_oracle` / `graft verify <id>`, then `graft sync` (green).
7. **Find the variant's real range:** `graft replay <id>` checks every published version.
   Record what you learn in *History*.

## Rules

- **Never edit an existing variant.** Older version ranges keep their variants and tests.
  Write a new file for the new range. `record_variant` refuses to re-register a file.
- **The Invariants are the contract and the oracle is the only proof.** Anchors matching or a
  clean apply is not success; a passing oracle is.
- **Never weaken the oracle** to get green: don't skip, loosen, or delete checks, and don't
  change Invariants to match what you built. If an invariant is genuinely obsolete, say so
  and ask a human.
- **Never set `verified`** to a version the oracle has not passed against.
- **Fail loudly.** A graft that silently applies nothing is the worst outcome. Anchors must
  match exactly once; don't add fuzz, catch-alls, or "skip if not found" logic.
- **Anchor by behavior.** Prefer stable exported names, public API lists, and user-facing
  strings over incidental code shape. Never anchor on formatting.
- Keep each change to what the failure needs. Don't refactor other grafts or upstream code.

## Version ranges

- Start the new variant at the target version. For a prerelease target, use the `-0` floor so
  prereleases select it: `>=5.0.0-0`.
- Leave it open-ended (`>=5.0.0-0`) unless you know where it stops applying.
- Older open-ended ranges get capped below the new floor by `record_variant`
  (`>=4.0.0` → `>=4.0.0 <5.0.0-0`).

## Mechanisms

### `patch` (pnpm, bun, npm/yarn via patch-package)

- A variant is a git-style patch (`diff --git a/<file> b/<file>`, paths relative to the
  package root). Every hunk is an anchor: its context and removed lines must appear exactly
  in the target version (position may shift; no fuzz). Files the patch creates must not
  already exist upstream. The same variant works with every package manager.
- Make one with the project's package manager: `pnpm patch <pkg>@<version>` then
  `pnpm patch-commit <dir> --patches-dir <tmp>`, `npm patch <pkg>` then `npm patch commit <dir>`
  (npm 12+), or `bun patch <pkg>` then `bun patch --commit node_modules/<pkg>`. Move the generated file into the graft's
  `variants/`. For npm, diff a pristine copy (under `.grafts/.cache/upstream/`) against your
  modified copy, using package-relative paths.
- Don't hand-edit the package manager's patch configuration. `graft apply` / `apply_to_project`
  wires the selected variant: pnpm `patchedDependencies`, npm 12+ `patchedDependencies` (name-only
  key), bun's version-pinned key, or (npm < 12, yarn and others) Graft's built-in applier,
  `graft apply --installed` in `postinstall`. The
  built-in applier is offline, idempotent, and never edits store-shared files in place.
  With upm (or the `vendor` applier forced in `.grafts/config.json`), Graft builds a patched
  tarball under `.grafts/.vendor/` and points overrides and the root dependency at it. Commit
  that tarball; never edit it by hand. `graft check` rebuilds it and reports a stale one.
  `graft sync --install` rewires it for the new version before installing. At the installed
  version, `check_anchors` reports any configuration that would apply something else or fail
  silently, and any patched file in `node_modules` that doesn't match pristine upstream + the
  variant.
- Keep hunk context away from lines that change every release (`"version"` in package.json).
- If the graft's *Where to look* or History names a generator for its variants (e.g.
  `tools/cjs-to-esm/make-variant.mjs`), regenerate the variant with it against the new
  version, then review the result rather than hand-patching the old one.

## When to stop: `conflicted`

Stop and mark the graft `conflicted` (via `update_status`, with a History entry) when:

- the behavior the graft modifies no longer exists upstream, or upstream changed it in a way
  that makes an invariant impossible or contradictory;
- you cannot make the oracle pass in every mode without weakening it;
- upstream now does what the graft did — say so; a human decides whether to mark it
  `upstreamed`.

Name the failing invariant, what moved upstream, and what you tried. Open a **draft** PR with
the same information. Don't leave a half-working variant registered: if you recorded one that
doesn't pass, say so explicitly in History and the PR.

## Running inside the Graft GitHub Action

When the action invokes you, `GRAFT_PROMPT_FILE` holds your task, and the environment points
at everything else: `GRAFT_SKILL_PATH` (this file), `GRAFT_MCP_CONFIG` (the graft MCP server),
`GRAFT_REPORT_MD` / `GRAFT_REPORT_JSON` (the sync report), `GRAFT_PACKAGE`,
`GRAFT_TARGET_VERSION`, and `GRAFT_BRANCH` (already checked out).

- Do **not** commit, push, or open a pull request. The action re-runs `graft sync` on your
  work and opens the PR itself: a normal PR only if the oracle passes, otherwise a draft.
- Write the PR description (format below) to `GRAFT_PR_BODY_FILE`.

## PR description

```markdown
## Graft sync: <package> <verified> → <target>

| Graft | Outcome |
|---|---|
| <id> | ✅ deterministic first pass / 🛠️ new variant / ❌ conflicted |

### <id>
**What changed upstream:** <the behavior-level change, citing the scoped diff>
**Anchors that moved:** <anchor names, and where they went>
**New variant:** `variants/<file>` for `<range>` — <how it differs from the previous variant>
**Proof:** oracle passed in <modes> against <package>@<target>
```

For a conflicted graft, replace *New variant* and *Proof* with **Failing invariant**,
**What was tried**, and **What a human needs to decide**.
