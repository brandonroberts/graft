---
name: graft-sync
description: Keep local modifications ("grafts") to upstream npm packages working when upstream releases a new version. Use when a repo has a `.grafts/` directory and an upstream dependency was bumped, `graft sync` reported `needs-agent`, a graft's anchors miss or its oracle fails, or you are asked to sync, repair, add, or retire a graft.
---

# Graft sync

A **graft** is one local modification to an upstream package, described by
`.grafts/<id>/graft.md`. The repo's grafts are the contract between the people who wrote
them and you. Your job when upstream moves is to make each graft hold again — or to say
clearly that it can't.

Full format and tooling contract: the Graft spec in the Graft repository,
https://github.com/brandonroberts/graft/blob/main/docs/spec.md

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

Everything goes through the `graft` CLI (`npx graft …`, `pnpm exec graft …`, or however the
project runs it). Every command takes `--json` for machine-readable output and `--root` for
the project root. Exit codes: `0` ok, `1` something needs attention, `2` tooling error.

| Step | Command |
|---|---|
| Overview | `graft status` |
| Deterministic first pass | `graft sync [--version X] [--install]` |
| Read intent + variants (and which variant the installed version selects) | `graft show <id>` |
| Anchor report | `graft check <id> [--version X]` |
| What moved upstream | `graft diff <id> [from] [to]` |
| Apply a variant to pristine upstream, for inspection | `graft preview <id> [--version X] [--out dir]` |
| Register a new variant | `graft variant add <id> --range R --module ./variants/… --verify-version X --note "…"` |
| Wire the package manager to the selected variants + reinstall | `graft apply` |
| Prove it | `graft verify <id>` |
| Status, verified version, History | `graft mark <id> [--status S] [--verified X] [--history "…"]` |
| Where a variant fits across published versions | `graft replay <id> [--range R]` |

Reports from `sync` land in `.grafts/.report/` (`sync.md`, `sync.json`, and per graft
`diff.patch` and `applied/`).

## The loop

1. **Run the deterministic first pass first.** `graft sync --version X --install`.
   Never re-derive what already passes. Green grafts are done — `sync` already bumped
   `verified` and wrote History. Only grafts marked `needs-agent` are yours.
2. **Gather context for each `needs-agent` graft**, in this order:
   `graft show <id>` → the reasons in the sync report → `graft check <id> --version <target>` →
   `graft diff <id>` (from `verified` to the target) → the failing oracle output, if the oracle ran.
3. **Locate the new equivalent code by behavior.** Use *Where to look* and *Anchors*, then
   the scoped diff. If a target file was removed or renamed, search the new version's
   published files for the behavior (the pristine copy is under `.grafts/.cache/upstream/`). Upstream
   renames and moves are normal; the behavior is what you are re-finding.
4. **Write a new variant for the new range** with your own editing tools, inside the graft's
   directory (e.g. `variants/v5.patch`). See *Mechanisms* below.
5. **Iterate until the patch applies cleanly** to the pristine target, which `sync`/`check`
   cached under `.grafts/.cache/upstream/<pkg>@<target>/`. For example, run
   `git apply --check <variant>` inside that directory. Registration (next step) is the final
   anchor check.
6. **Register it:** `graft variant add <id> --range '>=<target>' --module ./variants/<file>
   --verify-version <target> --note "<what moved upstream and how the variant differs>"`. It
   refuses (and rolls back) if the anchors don't match at the target. Older open-ended ranges
   are narrowed automatically; existing variant files are never touched. Then
   `graft check <id> --version <target>` should be clean.
7. **Prove it:** re-run `graft sync --version <target> --install`. With anchors now matching,
   it wires the package manager to the new variant, installs the target, and runs the oracle
   in every mode; on green it sets `verified` and status `applied`. (Or install yourself, run
   `graft verify <id>`, then `graft mark <id> --status applied --verified <target>`.)
8. **Finish:** open a PR (see below).

## Adding a new graft

When asked to capture a modification as a graft (new, or migrating an existing patch):

1. **Scaffold:** `graft init --agent` (once; it also installs this skill), then `graft add <id> --package <pkg> --target <file>`.
   This creates `graft.md`, an empty variant stub (which fails loudly until written), and an
   oracle stub that exits 1.
2. **Write the intent first,** with the person who owns the modification if you can: *Why*,
   the *Invariants* (observable behaviors, one per bullet), *Where to look* (by behavior), and
   *Anchors* (what the variant matches on and why).
3. **Write the variant.** For `patch`: run `pnpm patch <pkg>@<installed>`, make the change in the
   printed directory, then run `pnpm patch-commit <dir> --patches-dir <tmp>`. Move the generated
   file onto the scaffolded `variants/v<major>.patch`. `pnpm patch-commit` may also write a
   version-pinned entry to `package.json`; the next step replaces it.
4. **Apply it:** `graft apply`. This points the package manager at the
   variant, reinstalls, and re-checks anchors.
5. **Write the oracle** so it fails before the modification and passes after. Check that it
   fails without the graft. An oracle that can't fail proves nothing. Test the Invariants,
   plus at least one pre-existing behavior the graft must not break.
6. **Prove it:** `graft verify <id>`, then `graft sync` (green).
7. **Find the variant's real range:** `graft replay <id>` checks every published version.
   Record what you learn in *History*.

## Rules

- **Never edit an existing variant.** Older version ranges keep their variants and tests.
  Write a new file for the new range. `graft variant add` refuses to re-register a file.
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
- Older open-ended ranges get capped below the new floor by `graft variant add`
  (`>=4.0.0` → `>=4.0.0 <5.0.0-0`).

## Mechanisms

### `patch` (any package manager)

- A variant is a git-style patch (`diff --git a/<file> b/<file>`, paths relative to the
  package root). Every hunk is an anchor: its context and removed lines must appear exactly
  in the target version (position may shift; no fuzz). Files the patch creates must not
  already exist upstream. The same variant works with every package manager.
- Make one with the project's package manager: `pnpm patch <pkg>@<version>` then
  `pnpm patch-commit <dir> --patches-dir <tmp>`, `npm patch <pkg>` then `npm patch commit <dir>`
  (npm 12+), or `bun patch <pkg>` then `bun patch --commit node_modules/<pkg>`. Move the generated file into the graft's
  `variants/`. For npm, diff a pristine copy (under `.grafts/.cache/upstream/`) against your
  modified copy, using package-relative paths.
- Don't hand-edit the package manager's patch configuration. `graft apply`
  wires the selected variant: pnpm `patchedDependencies`, npm 12+ `patchedDependencies` (name-only
  key), bun's version-pinned key, or (npm < 12, yarn and others) Graft's built-in applier,
  `graft apply --installed` in `postinstall`. The
  built-in applier is offline, idempotent, and never edits store-shared files in place.
  With upm (or the `vendor` applier forced in `.grafts/config.json`), Graft builds a patched
  tarball under `.grafts/.vendor/` and points overrides and the root dependency at it. Commit
  that tarball; never edit it by hand. `graft check` rebuilds it and reports a stale one.
  `graft sync --install` rewires it for the new version before installing. At the installed
  version, `graft check` reports any configuration that would apply something else or fail
  silently, and any patched file in `node_modules` that doesn't match pristine upstream + the
  variant.
- Keep hunk context away from lines that change every release (`"version"` in package.json).
- If the graft's variants are generated, give it a `generator: { command }` in its
  frontmatter (`{version}` and `{out}` are substituted; e.g.
  `node tools/cjs-to-esm/make-variant.mjs semver {version} {out}`). `graft sync` then
  regenerates and registers a variant itself when the old one misses, and keeps it only if
  the oracle passes. If sync still hands the graft to you, its reasons say what the generator
  did; the rejected output is under `.grafts/.report/<id>/regenerated/`. Fix the generator
  or review that output rather than hand-patching the old variant.

## When to stop: `conflicted`

Stop and mark the graft `conflicted` (`graft mark <id> --status conflicted --history "…"`) when:

- the behavior the graft modifies no longer exists upstream, or upstream changed it in a way
  that makes an invariant impossible or contradictory;
- you cannot make the oracle pass in every mode without weakening it;
- upstream now does what the graft did — say so; a human decides whether to mark it
  `upstreamed`. Graft detects the common case for you: when the variant no longer applies
  but upstream already contains its change (for patches, the reverse patch applies cleanly),
  sync reports the graft as **likely upstreamed** (`likelyUpstreamed: true`, and
  `upstreamed.evidence` from `graft check --json`). Then don't write a new variant:
  confirm the invariants hold on pristine upstream, and recommend (or, if asked, apply with
  `graft mark <id> --status upstreamed --history "…"`) the `upstreamed` status with a History entry citing the version.

Name the failing invariant, what moved upstream, and what you tried. Open a **draft** PR with
the same information. Don't leave a half-working variant registered: if you recorded one that
doesn't pass, say so explicitly in History and the PR.

## Running inside the Graft GitHub Action

When the action invokes you, `GRAFT_PROMPT_FILE` holds your task, and the environment points
at everything else: `GRAFT_SKILL_PATH` (this file), `GRAFT_COMMAND` (how to run the CLI),
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
