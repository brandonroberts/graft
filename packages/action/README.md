# Graft sync GitHub Action

First runs **`graft check`** on the installed tree, then polls npm dist-tags for each graft's rootstock package (or, for [repo-mode forks](#repo-mode-forks-that-are-the-product), the upstream's git tags or a tracked branch). When there's a newer version, it runs
Graft's deterministic first pass and then does one of the following:

| `graft sync` result | Action |
|---|---|
| ✅ every graft green (anchors match, oracle passes) | Opens a **PR** with the dependency bump and the updated `graft.md` files |
| 🛠️ needs an agent, `agent-command` set | Runs your agent with the report and the skill (the agent drives Graft through its CLI). Then **re-runs `graft sync`** itself, never trusting the agent's word. Green → PR (with the agent's description). Still failing → **draft PR** |
| 🛠️ needs an agent, no agent (or nothing to commit) | Opens an **issue** with the sync report, once per package@version |
| ❌ tooling error | Fails the job for that package and still processes the others |

Each package@version gets its own branch (`graft/sync-<package>-<version>`). A branch or issue that already exists is skipped, so the action is safe to run on a schedule.

## `graft check`

Before touching any branch, the action checks the project as the workflow installed it. For every active graft:
- **the package-manager configuration** must apply the selected variant;
- **anchors** must match;
- **each patched file in `node_modules`** must equal pristine upstream + that variant.

This catches grafts that were silently dropped: an `--ignore-scripts` install, a stale vendored tarball, a hand-edited lock, a patch reverted by a "repair" pass.

- `check: fail` (default) annotates each problem and fails the job, after the sync work is done.
- `check: warn` annotates only. `check: off` skips it.
- `sync: false` runs only the check. Use that in ordinary CI right after installing:

```yaml
      - run: npm ci --ignore-scripts
      - uses: brandonroberts/graft/packages/action@main
        with:
          sync: false        # just verify the installed grafts
```

## Usage

```yaml
name: Graft sync
on:
  schedule: [{ cron: '23 7 * * 1' }]
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
  issues: write
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci            # the project must depend on @graftsync/cli
      - uses: brandonroberts/graft/packages/action@main
```

Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**.

## Repo mode (forks that are the product)

For a `fork` graft with `install: none` that lives in the fork itself (e.g. a translated docs site), the action:

- finds the target with `graft outdated`: the newest upstream release tag, or the tip of `fork.track` as `<version>+<commit>`;
- runs `graft sync --version <target> --id <graft>` (nothing is installed);
- **green:** takes Graft's rebased result (`graft/<id>/<version>` in the cache clone) as the whole tree of the PR branch, graft.md included, and opens a PR;
- **conflicts:** takes Graft's `-agent` branch (git's merge, conflict markers in the listed files, graft.md at the new version). With `agent-command`, the agent resolves the markers in place and the action re-runs `graft sync`; green → PR with Graft's result. Otherwise → a **draft PR** listing the files to resolve.

The project must gitignore `.grafts/.cache/` and `.grafts/.report/`.

## Handing failures to an agent

`agent-command` is any shell command. The action doesn't assume a particular agent. The command runs on the sync branch with these variables set:

| Variable | Contents |
|---|---|
| `GRAFT_PROMPT_FILE` | The task, written for an agent |
| `GRAFT_SKILL_PATH` | The `graft-sync` SKILL.md |
| `GRAFT_COMMAND` | How to run the graft CLI (the `graft-command` input) |
| `GRAFT_REPORT_MD`, `GRAFT_REPORT_JSON` | The sync report |
| `GRAFT_PR_BODY_FILE` | Where the agent writes the PR description |
| `GRAFT_PACKAGE`, `GRAFT_TARGET_VERSION`, `GRAFT_BRANCH` | What's being synced |

Example with Claude Code. Adjust the flags to your agent and your CLI version:

```yaml
      - uses: brandonroberts/graft/packages/action@main
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          agent-command: >
            npx -y @anthropic-ai/claude-code -p "$(cat "$GRAFT_PROMPT_FILE")"
            --append-system-prompt "$(cat "$GRAFT_SKILL_PATH")"
            --permission-mode acceptEdits
            --allowedTools "Bash($GRAFT_COMMAND:*)"
```

The agent must not commit, push or open PRs. The action does that after re-verifying the agent's work.

## Inputs

| Input | Default | |
|---|---|---|
| `github-token` | `${{ github.token }}` | Used by `gh` for PRs and issues |
| `working-directory` | `.` | Directory containing `.grafts/` |
| `graft-command` | `npx --no-install graft` | How to run the CLI |
| `tags` | `latest,next,rc,beta` | Dist-tags to consider. The highest newer version wins, so prereleases are preferred |
| `packages` | all | Restrict to these rootstock packages |
| `agent-command` | — | See above |
| `on-needs-agent` | `report` | `report`: a draft PR if there are changes, otherwise an issue. `skip`: job summary only |
| `install-command` | from lockfile | Reinstall used between packages |
| `base-branch` | checked-out branch | PR base |
| `branch-prefix` | `graft/sync-` | |
| `labels` | — | Labels for PRs and issues; they must already exist |
| `commit-author` | `github-actions[bot]` | |
| `skill-path` | bundled `SKILL.md` | |
| `dry-run` | `false` | Run sync without pushing or opening anything |
| `check` | `fail` | `fail`, `warn` or `off`: run `graft check` on the installed tree first |
| `sync` | `true` | `false` runs only the check |

## Outputs

- `check`: the JSON check result (`ok`, per-graft reports, failures), or `null` when the check is off.
- `results`: a JSON array with one entry per package: `outcome` (`pr`, `draft-pr`, `issue`, `skipped-existing`, `up-to-date`, `no-changes`, `needs-agent`, or `error`), versions, the link, and reasons.
- `pull-requests`: a JSON array of the PR URLs that were opened.

A summary table is also written to the job summary.
