# Example: angular-tr, a translated fork kept in sync

[angular-tr](https://github.com/erkamyaman/angular-tr) is the community Turkish translation of
angular.dev. It's a full fork of angular/angular whose change is the translation: about 460 pages
under `adev/src/content`, the site's UI strings, and a few repository files. Its maintainer
re-syncs it with upstream by hand, roughly monthly.

This folder is a drop-in Graft setup for it, tested against the real repository with the
published `@graftsync/cli@0.1.0`. Copy it into the fork's root:

```
.grafts/
  .gitignore                 # .cache/ and .report/
  angular-tr/
    graft.md                 # intent: Why / Invariants / Where to look / Anchors / History
    variants/v22.json        # { "ref": "@worktree", "base": "@verified" }, permanent
    oracle.mjs               # the translation check (below)
.github/workflows/graft-sync.yml
```

and, optionally, `graft init --agent --skills-dir .agent/skills` to put the `graft-sync` skill next
to the repo's own `tr-contributor` skill.

To start from scratch instead, scaffold the same frontmatter and variant from the fork's checkout
(with an `upstream` remote pointing at angular/angular), then write the body and the oracle:

```bash
npx -y @graftsync/cli@latest add angular-tr --package angular --mechanism fork --in-place \
  --version 22.3.0-next.2+e36a63e20e30
```

## How it's set up

- **Repo mode, in place.** `fork: { repo: ., upstream: angular/angular, install: none }`: the
  graft lives in the fork, nothing is installed, and the single variant means *this checkout
  against the upstream it last verified*. `rootstock.verified` is `22.3.0-next.2+e36a63e20e30`,
  the upstream commit the fork's last sync was based on (it syncs to `main`, between releases).
- **The oracle** (`oracle.mjs`, mode `pages`) runs in the rebased checkout. For every page the
  fork had translated (as last committed, against the upstream it was verified on), the result
  must:
  - not be identical to upstream's English;
  - have no more English headings or English prose lines (verbatim upstream lines, outside code)
    than before;
  - keep upstream's shape (headings, code blocks, `<docs-*>` elements) wherever it had it, so a
    translation that drops upstream's new section fails;
  - and contain no conflict markers.

  The docs build (`pnpm bazel build //adev:build`, which catches broken heading links) would be
  a good second mode, but it needs a full install per run.
- **The workflow** runs the [Graft Action](../../packages/action) manually (a schedule is
  commented out). Graft runs from npm via `npx`, so the fork's `package.json` is untouched.

## What happened on the real repository

All runs on a shallow clone (like `actions/checkout`), fork at `7421917`, upstream angular/angular:

| Step | Result | Time |
|---|---|---|
| `graft check` (first run: fetches angular/angular, ~680 MB) | 2,834 anchors, all match | 1m56s |
| `graft sync` (re-verify the current base, oracle included) | green: 392 translated pages checked | 25s |
| `graft outdated` | offers `22.3.0-next.3` (from upstream's tags) | 3s |
| `graft sync --version 22.3.0-next.3` | needs-agent: 7 files conflict, the same 7 `git apply --3way` reports; 364-line scoped diff; `-agent` branch with markers in just those 7 | 20s |
| A careless "agent": keep the Turkish side of every conflict, then `graft sync` | **caught**: `deploy.md` gained 5 English headings and 18 English prose lines that merged in cleanly; `ssr.md` and `locale-id.md` lost upstream's new sections (structure no longer matches) | 18s |
| The Action, dry run | would open a **draft PR** `graft/sync-angular-22.3.0-next.3` with git's merge and the 7 files to translate | 1m |

What the oracle can't see: an upstream *wording* change inside a paragraph that the conflict
resolution replaced with the old Turkish. Those files are exactly the ones listed in the PR, so a
reviewer (or the agent's own diff) is the check there.

## The monthly flow, with this setup

1. Run the **Graft sync** workflow (or it runs on its schedule).
2. **Green** (no translated page touched upstream): a PR with the fork rebased onto the new
   release, `graft.md` already saying so. Review and merge.
3. **Conflicts**: a draft PR with git's merge; conflict markers only in the listed files, and
   `graft.md` at the new version with `status: conflicted`. Translate those files (by hand, a
   contributor, or `agent-command`), push to the PR branch, run `graft sync --version <X>` to
   prove it, and merge.
