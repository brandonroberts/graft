// Graft GitHub Action: poll upstream dist-tags, run the deterministic first pass, open PRs, and
// hand grafts that need an agent to a configurable agent command. Uses only Node builtins and
// the git / gh CLIs, so it runs from a checkout of this repository with no build step.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_AUTHOR = 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>';

/** Normalize raw action inputs (strings from action.yml) into options. */
export function parseInputs(raw = {}) {
  const str = (k, d = '') => (raw[k] ?? '').toString().trim() || d;
  const list = (k) => str(k).split(/[\s,]+/).filter(Boolean);
  const bool = (k, d = false) => (raw[k] === undefined || raw[k] === '' ? d : /^(true|1|yes)$/i.test(String(raw[k])));
  const onNeedsAgent = str('on-needs-agent', 'report');
  if (!['report', 'skip'].includes(onNeedsAgent)) throw new Error(`on-needs-agent must be report or skip (got ${onNeedsAgent})`);
  const check = str('check', 'fail');
  if (!['fail', 'warn', 'off'].includes(check)) throw new Error(`check must be fail, warn or off (got ${check})`);
  return {
    check,
    sync: bool('sync', true),
    graftCommand: str('graft-command', 'npx --no-install graft'),
    agentCommand: str('agent-command'),
    installCommand: str('install-command'),
    tags: list('tags'),
    packages: list('packages'),
    baseBranch: str('base-branch'),
    branchPrefix: str('branch-prefix', 'graft/sync-'),
    labels: list('labels'),
    onNeedsAgent,
    author: str('commit-author', DEFAULT_AUTHOR),
    dryRun: bool('dry-run'),
    skillPath: str('skill-path'),
  };
}

/** Run a shell command (user-supplied commands may contain pipes, env, etc.). */
export function sh(command, { cwd, env, onOutput } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      onOutput?.(String(d));
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      onOutput?.(String(d));
    });
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const slug = (s) => s.replace(/^@/, '').replace(/[^a-zA-Z0-9.-]+/g, '-');

/** yarn 2+ (berry) rather than yarn classic: `packageManager: yarn@2+`, `.yarnrc.yml`, a PnP runtime, or berry's lockfile header. */
export function isYarnBerry(cwd) {
  try {
    const declared = /^yarn@(\d+)/.exec(String(JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')).packageManager ?? ''));
    if (declared) return Number(declared[1]) >= 2;
  } catch {
    // no readable manifest
  }
  if (['.yarnrc.yml', '.pnp.cjs', '.pnp.js'].some((f) => existsSync(path.join(cwd, f)))) return true;
  try {
    return /^__metadata:/m.test(readFileSync(path.join(cwd, 'yarn.lock'), 'utf8').slice(0, 4096));
  } catch {
    return false;
  }
}

/** Detect a reinstall command from the lockfile, used to reset node_modules between candidates. */
export function detectInstallCommand(cwd) {
  // Same precedence as Graft core: pnpm, npm, upm, then yarn and bun; npm when nothing says otherwise.
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
  if (existsSync(path.join(cwd, 'package-lock.json')) || existsSync(path.join(cwd, 'npm-shrinkwrap.json'))) return 'npm ci';
  if (existsSync(path.join(cwd, 'upm.lock'))) return 'upm install --frozen-lockfile';
  // yarn 2+ (berry) has no --frozen-lockfile; its equivalent is --immutable.
  if (existsSync(path.join(cwd, 'yarn.lock'))) return isYarnBerry(cwd) ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
  if (existsSync(path.join(cwd, 'bun.lock')) || existsSync(path.join(cwd, 'bun.lockb'))) return 'bun install --frozen-lockfile';
  return 'npm install';
}

/** Markdown PR body for one candidate. */
export function renderPrBody({ candidate, report, agentBody, outcome }) {
  const lines = [];
  if (agentBody?.trim()) {
    lines.push(agentBody.trim(), '');
  } else {
    lines.push(`## Graft sync: ${candidate.package} ${candidate.verified} → ${candidate.version}`, '');
  }
  lines.push(candidate.standalone ? `Upstream \`${candidate.package}\` at \`${candidate.version}\` (${candidate.tag}); this branch is the fork rebased onto it.` : `Upstream \`${candidate.package}@${candidate.version}\` (dist-tag \`${candidate.tag}\`).`, '');
  if (outcome === 'needs-agent') {
    lines.push('> [!WARNING]', '> One or more grafts still fail on this version. The details below say which, and why; the graft-sync skill describes how to finish the job.', '');
  }
  if (report) {
    lines.push('| Graft | Verified → Target | Outcome |', '|---|---|---|');
    for (const g of report.grafts) lines.push(`| ${g.id} | ${g.from} → ${g.to ?? '?'} | ${g.outcome} |`);
    lines.push('');
    for (const g of report.grafts.filter((g) => g.outcome !== 'green' && g.outcome !== 'skipped')) {
      lines.push(`<details><summary>${g.id}: ${g.outcome}${g.likelyUpstreamed ? ' (likely upstreamed)' : ''}</summary>`, '');
      if (g.likelyUpstreamed) lines.push(`**Likely upstreamed:** \`${g.package}@${g.to}\` already contains this graft's change. Confirm, then set its status to \`upstreamed\`.`, '');
      for (const r of g.reasons ?? []) lines.push(`- ${r}`);
      if (g.agentStart?.conflicts?.length) lines.push('', `Conflict markers to resolve on this branch: ${g.agentStart.conflicts.map((f) => `\`${f}\``).join(', ')}. Then run \`graft sync --version ${candidate.version}\`; it verifies the branch in place.`);
      lines.push('', '</details>', '');
    }
  }
  lines.push(
    '---',
    candidate.standalone
      ? (outcome === 'green'
        ? "_Opened by the [Graft](https://github.com/brandonroberts/graft) GitHub Action. This branch is the fork's change rebased onto the new upstream; Graft checked that it still applies, not how it behaves. Let your CI run and review the diff before merging._"
        : "_Opened by the [Graft](https://github.com/brandonroberts/graft) GitHub Action. This branch holds git's merge of the fork's change onto the new upstream; finish it before merging._")
      : "_Opened by the [Graft](https://github.com/brandonroberts/graft) GitHub Action. Graft checked that each graft still fits the new version and installs; it doesn't check behavior. Let your CI run and review the variant diffs before merging._",
  );
  return lines.join('\n');
}

/** Prompt for a repo-mode graft (the fork is the product): resolve the merged branch in place. */
export function renderStandaloneAgentPrompt({ candidate, report, files }) {
  const needs = report.grafts.filter((g) => g.outcome === 'needs-agent');
  const conflicts = needs.flatMap((g) => g.agentStart?.conflicts ?? []);
  return `Graft sync needs an agent.

Upstream ${candidate.package} moved to ${candidate.version} (${candidate.tag}); this repository is a fork of it, verified against ${candidate.verified}.
The working tree on branch ${files.branch} already holds git's merge of the fork's change onto ${candidate.version}, and the graft files say so.
${conflicts.length ? `These files still have conflict markers: ${conflicts.join(', ')}.` : 'It merged without conflicts, but sync could not finish: read the reasons in the report.'}

Follow the graft-sync skill: ${files.skill}
The sync report is at ${files.reportMarkdown} (JSON: ${files.reportJson}); what upstream changed in the files the fork touches is in .grafts/.report/<id>/diff.patch.
Drive Graft with its CLI, \`${files.graftCommand}\` (also in $GRAFT_COMMAND).

- Resolve every conflict by behavior: keep upstream's new content and re-apply the fork's change to it (the graft's Why / Invariants say what that means here). Remove every marker.
- Verify the graft's Invariants with the project's own tests (and add a test where none covers one): upstream changes that merged cleanly can still break an invariant. Graft only checks that the change fits.
- Then run \`${files.graftCommand} sync --version ${candidate.version}\`; it checks the working tree in place.
- Do NOT commit, push, or open a pull request; the action does that after re-verifying your work. Do not edit variants.
- If an invariant cannot be satisfied, mark the graft conflicted (\`mark <id> --status conflicted --history "…"\`) instead of forcing a pass.
- Write the pull request description to ${files.prBody}, including how you verified the Invariants.
`;
}

/** Prompt handed to the agent command (also exported as GRAFT_PROMPT_FILE). */
export function renderAgentPrompt({ candidate, report, files }) {
  const needs = report.grafts.filter((g) => g.outcome === 'needs-agent').map((g) => g.id);
  return `Graft sync needs an agent.

Upstream ${candidate.package} was released as ${candidate.version} (dist-tag "${candidate.tag}"); the grafts were verified against ${candidate.verified}.
The deterministic first pass could not re-verify these grafts: ${needs.join(', ')}.

Follow the graft-sync skill: ${files.skill}
The sync report is at ${files.reportMarkdown} (JSON: ${files.reportJson}); scoped upstream diffs are under .grafts/.report/<id>/diff.patch.
Drive Graft with its CLI, \`${files.graftCommand}\` (also in $GRAFT_COMMAND; every command takes --json): \`check\`, \`diff\`, \`show\`, \`preview\`, \`capture\`, \`variant add\`, \`apply\`, \`sync\`, \`mark\`.

You are running inside the Graft GitHub Action on branch ${files.branch}:
- Do NOT commit, push, or open a pull request; the action does that after re-verifying your work.
- Make the grafts pass for ${candidate.package}@${candidate.version} by adding new variants (never edit existing ones), registering them with \`variant add --verify-version ${candidate.version}\`, and checking them with \`${files.graftCommand} sync --version ${candidate.version} --package ${candidate.package} --install\`.
- Verify each graft's Invariants with the project's own tests at ${candidate.version} (add a test where none covers one). Graft only checks that a variant fits and installs; the behavior is yours to prove.
- If an invariant cannot be satisfied, mark the graft conflicted (\`mark <id> --status conflicted --history "…"\`) instead of forcing a pass.
- Write the pull request description (the skill's format, including how you verified the Invariants) to ${files.prBody}.
`;
}

/** gh's way of saying GitHub Actions (or this token) may not open pull requests here. */
export const isPrRefusal = (output) =>
  /not permitted to create or approve pull requests|Resource not accessible by integration|HTTP 403|must have (push|write) access/i.test(output);

/** https://github.com/<owner>/<repo>, from the Actions environment or the origin remote. */
export function repoWebUrl(env, originUrl) {
  if (env.GITHUB_REPOSITORY) return `${(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '')}/${env.GITHUB_REPOSITORY}`;
  const m = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(originUrl ?? '');
  return m ? `https://github.com/${m[1]}` : undefined;
}

/**
 * Run the action. `deps` is injectable for tests: { sh, git, gh, log, writeOutput, writeSummary, tmpDir, cwd }.
 */
export async function runAction(options, deps) {
  const { cwd, log } = deps;
  const run = (command, extra = {}) => deps.sh(command, { cwd, ...extra });
  const git = async (...args) => {
    const r = await deps.sh(`git ${args.map(quote).join(' ')}`, { cwd });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
    return r.stdout.trim();
  };
  /** Open an issue once per title. Returns { url, existing }. */
  const openIssue = async (title, body, file) => {
    const existing = await run(`gh issue list --state open --search ${quote(`in:title "${title}"`)} --json title,url`);
    const open = existing.code === 0 ? JSON.parse(existing.stdout || '[]').find((i) => i.title === title) : undefined;
    if (open) return { url: open.url, existing: true };
    const bodyFile = path.join(deps.tmpDir, file);
    await writeFile(bodyFile, body);
    const issue = await run([`gh issue create --title ${quote(title)} --body-file ${quote(bodyFile)}`, ...options.labels.map((l) => `--label ${quote(l)}`)].join(' '));
    if (issue.code !== 0) throw new Error(`gh issue create failed: ${issue.stderr || issue.stdout}`);
    return { url: issue.stdout.trim().split('\n').pop(), existing: false };
  };
  const [authorName, authorEmail] = (() => {
    const m = /^(.*?)\s*<(.+)>$/.exec(options.author);
    return m ? [m[1], m[2]] : [options.author, 'graft@users.noreply.github.com'];
  })();

  // 1. Check the project as the workflow installed it, before any branch is touched: are the
  //    grafts actually applied (config, anchors, installed files = pristine + variant)?
  const check = options.check === 'off' ? undefined : await runCheck(options, run);
  const checkFailed = !!check && !check.ok;
  if (check) {
    const level = options.check === 'fail' ? 'error' : 'warning';
    for (const f of check.failures) log(`::${level} title=graft check::${f.replaceAll('\n', ' ')}`);
    if (check.ok) log(`graft: check passed (${check.reports.length} graft(s) applied as selected)`);
  }
  if (!options.sync) {
    await deps.writeOutput('check', JSON.stringify(check ?? null));
    await deps.writeOutput('results', '[]');
    await deps.writeOutput('pull-requests', '[]');
    await deps.writeSummary(check ? renderCheck(check, options.check) : '');
    return { results: [], check, failed: options.check === 'fail' && checkFailed };
  }

  // 2. Sync: look for newer upstream versions and propose them.
  const base = options.baseBranch || (await git('rev-parse', '--abbrev-ref', 'HEAD'));
  const reinstall = options.installCommand || detectInstallCommand(cwd);
  const skill = options.skillPath || path.resolve(deps.actionPath ?? '.', '../skill/SKILL.md');
  await mkdir(deps.tmpDir, { recursive: true });

  const outdatedCmd = `${options.graftCommand} outdated --json${options.tags.length ? ` --tags ${quote(options.tags.join(','))}` : ''}`;
  const outdated = await run(outdatedCmd);
  if (outdated.code !== 0) throw new Error(`\`${outdatedCmd}\` failed (exit ${outdated.code}):\n${outdated.stderr || outdated.stdout}`);
  const entries = JSON.parse(outdated.stdout);
  const candidates = entries
    .filter((e) => e.candidate && (!options.packages.length || options.packages.includes(e.package)))
    .map((e) => ({ package: e.package, version: e.candidate.version, tag: e.candidate.tag, verified: e.verified, grafts: e.grafts, standalone: !!e.standalone }));

  const results = entries
    .filter((e) => !e.candidate && (!options.packages.length || options.packages.includes(e.package)))
    .map((e) => ({ package: e.package, from: e.verified, outcome: 'up-to-date' }));
  if (!candidates.length) log('graft: all rootstock packages are up to date');

  // Syncing switches branches and resets the working tree (`checkout -f`, `clean -fd`), and
  // commits everything it finds with `add -A`. On anything but a clean checkout that would
  // silently discard work, or carry stray files into the sync PR (#24), so refuse first.
  if (candidates.length) {
    const tmpRel = path.relative(cwd, deps.tmpDir).split(path.sep).join('/');
    const tmpTop = tmpRel && !tmpRel.startsWith('..') ? tmpRel.split('/')[0] : undefined;
    const status = await run('git status --porcelain --untracked-files=all');
    if (status.code !== 0) throw new Error(`git status failed: ${status.stderr || status.stdout}`);
    const pending = status.stdout
      .split('\n')
      .filter((l) => l.trim() && !(tmpTop && (l.slice(3) === tmpTop || l.slice(3).startsWith(`${tmpTop}/`))));
    if (pending.length) {
      const shown = pending.slice(0, 10).map((l) => l.slice(3)).join(', ');
      throw new Error(
        `the working tree has uncommitted changes or untracked files: ${shown}${pending.length > 10 ? ` and ${pending.length - 10} more` : ''}. ` +
          'Syncing switches branches and resets the working tree, so it would discard them (or commit them into a sync PR). ' +
          'Commit, stash or gitignore them, or run the action on a fresh checkout, as in CI.',
      );
    }
  }

  let dirty = false;
  for (const candidate of candidates) {
    const result = { package: candidate.package, from: candidate.verified, to: candidate.version, tag: candidate.tag, outcome: 'error', reasons: [] };
    results.push(result);
    const branch = `${options.branchPrefix}${slug(candidate.package)}-${candidate.version}`;
    result.branch = branch;
    log(`graft: ${candidate.package} ${candidate.verified} → ${candidate.version} (${candidate.tag}) on ${branch}`);
    try {
      const remote = await run(`git ls-remote --exit-code --heads origin ${quote(branch)}`);
      if (remote.code === 0) {
        result.outcome = 'skipped-existing';
        result.reasons.push(`branch ${branch} already exists on origin`);
        continue;
      }

      if (dirty) {
        await git('checkout', '-f', base);
        await git('clean', '-fd');
        // A repo-mode graft installs nothing, so there is nothing to reset for it.
        if (!candidate.standalone) {
          const r = await run(reinstall);
          if (r.code !== 0) throw new Error(`\`${reinstall}\` failed:\n${r.stderr || r.stdout}`);
        }
      }
      dirty = true;
      await git('checkout', '-B', branch, base);

      const syncCmd = candidate.standalone
        ? `${options.graftCommand} sync --json --version ${quote(candidate.version)} --id ${quote(candidate.grafts.join(','))}`
        : `${options.graftCommand} sync --json --version ${quote(candidate.version)} --package ${quote(candidate.package)} --install`;
      // Repo mode: Graft leaves its result (or, for an agent, git's merge with conflict markers)
      // as a branch in its cache clone; the PR branch takes that whole tree. When Graft names the
      // upstream commit the result sits on, the commit is a merge of it (with the result's tree),
      // so the fork keeps upstream in its history, as `git merge upstream/main` would.
      const adopt = async (ref) => {
        await git('fetch', '--quiet', ref.repo, ref.ref);
        if (ref.upstream) {
          const merging = (await run('git rev-parse -q --verify MERGE_HEAD')).stdout.trim();
          if (!merging) await git('-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'merge', '--quiet', '--no-ff', '--no-commit', '-s', 'ours', '--allow-unrelated-histories', ref.upstream);
          else if (merging !== ref.upstream) throw new Error(`adopting ${ref.ref}: already merging ${merging}, not upstream ${ref.upstream}`);
        }
        await git('read-tree', '-u', '--reset', 'FETCH_HEAD');
      };
      const adoptFrom = async (report, code) => {
        if (!candidate.standalone) return;
        const g = report.grafts.find((x) => x.outcome !== 'skipped');
        if (code === 0 && g?.materialized?.fetch) await adopt(g.materialized.fetch);
        else if (code === 1 && g?.agentStart?.ref) await adopt(g.agentStart);
      };
      const syncOnce = async () => {
        const r = await run(syncCmd);
        let report;
        try {
          report = JSON.parse(r.stdout);
        } catch {
          throw new Error(`\`${syncCmd}\` did not print a JSON report (exit ${r.code}):\n${(r.stderr || r.stdout).slice(-4000)}`);
        }
        return { code: r.code, report };
      };

      let { code, report } = await syncOnce();
      result.syncExitCode = code;
      if (code === 2) {
        result.reasons.push(...report.grafts.filter((g) => g.outcome === 'error').flatMap((g) => g.reasons));
        throw new Error(`graft sync reported a tooling error for ${candidate.package}@${candidate.version}`);
      }
      await adoptFrom(report, code);

      let agentBody;
      if (code === 1 && options.agentCommand) {
        const files = {
          skill,
          reportJson: path.join(cwd, '.grafts/.report/sync.json'),
          reportMarkdown: path.join(cwd, '.grafts/.report/sync.md'),
          prBody: path.join(deps.tmpDir, `pr-body-${slug(candidate.package)}.md`),
          prompt: path.join(deps.tmpDir, `prompt-${slug(candidate.package)}.md`),
          graftCommand: options.graftCommand,
          branch,
        };
        await writeFile(files.prompt, (candidate.standalone ? renderStandaloneAgentPrompt : renderAgentPrompt)({ candidate, report, files }));
        log(`graft: handing ${candidate.package}@${candidate.version} to the agent`);
        const agent = await run(options.agentCommand, {
          env: {
            GRAFT_PROMPT_FILE: files.prompt,
            GRAFT_SKILL_PATH: files.skill,
            GRAFT_COMMAND: options.graftCommand,
            GRAFT_REPORT_JSON: files.reportJson,
            GRAFT_REPORT_MD: files.reportMarkdown,
            GRAFT_PR_BODY_FILE: files.prBody,
            GRAFT_PACKAGE: candidate.package,
            GRAFT_TARGET_VERSION: candidate.version,
            GRAFT_BRANCH: branch,
          },
          onOutput: deps.streamAgent ? (c) => process.stdout.write(c) : undefined,
        });
        result.agentExitCode = agent.code;
        if (agent.code !== 0) result.reasons.push(`agent command exited ${agent.code}`);
        // Never trust the agent's word: re-run the deterministic pass on its work.
        ({ code, report } = await syncOnce());
        result.syncExitCode = code;
        if (code === 2) throw new Error(`graft sync reported a tooling error after the agent ran`);
        // Green: take Graft's result (it records the verification). Still failing: keep the agent's work.
        if (code === 0) await adoptFrom(report, code);
        if (existsSync(files.prBody)) agentBody = await readFile(files.prBody, 'utf8');
        result.agent = true;
      }

      const outcome = code === 0 ? 'green' : 'needs-agent';
      result.grafts = report.grafts.map((g) => ({ id: g.id, outcome: g.outcome }));
      if (outcome === 'needs-agent') result.reasons.push(...report.grafts.filter((g) => g.outcome === 'needs-agent').map((g) => `${g.id}: ${g.reasons.join('; ')}`));
      if (outcome === 'needs-agent' && options.onNeedsAgent === 'skip') {
        result.outcome = 'needs-agent';
        continue;
      }

      const tmpRel = path.relative(cwd, deps.tmpDir).split(path.sep).join('/');
      const changed = (await git('status', '--porcelain'))
        .split('\n')
        .filter((l) => l.trim() && !(tmpRel && !tmpRel.startsWith('..') && l.slice(3).startsWith(tmpRel.split('/')[0])))
        .length > 0;
      const title = `graft: sync ${candidate.package} to ${candidate.version}${outcome === 'needs-agent' ? ' (needs attention)' : ''}`;
      const body = renderPrBody({ candidate, report, agentBody, outcome });
      if (!changed && outcome === 'green') {
        result.outcome = 'no-changes';
        result.reasons.push('sync made no file changes; nothing to propose');
        continue;
      }
      if (!changed) {
        // Static checks failed, so nothing was installed and there is nothing to commit:
        // hand off through an issue carrying the report (once per package@version).
        if (options.dryRun) {
          result.outcome = 'would-open-issue';
          result.body = body;
          continue;
        }
        const issue = await openIssue(title, body, `issue-${slug(candidate.package)}.md`);
        result.issue = issue.url;
        if (issue.existing) {
          result.outcome = 'skipped-existing';
          result.reasons.push(`issue already open: ${issue.url}`);
        } else result.outcome = 'issue';
        continue;
      }
      if (options.dryRun) {
        result.outcome = outcome === 'green' ? 'would-open-pr' : 'would-open-draft-pr';
        result.body = body;
        continue;
      }
      await git('add', '-A');
      if (tmpRel && !tmpRel.startsWith('..')) await run(`git reset -q -- ${quote(tmpRel.split('/')[0])}`);
      await deps.sh(`git -c user.name=${quote(authorName)} -c user.email=${quote(authorEmail)} commit -q -m ${quote(title)} -m ${quote(`Upstream ${candidate.package}@${candidate.version} (${candidate.tag}). Generated by graft sync.`)}`, { cwd }).then((r) => {
        if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr}`);
      });
      await git('push', '-u', 'origin', branch);
      const bodyFile = path.join(deps.tmpDir, `body-${slug(candidate.package)}.md`);
      await writeFile(bodyFile, body);
      const pr = await run(
        ['gh pr create', `--base ${quote(base)}`, `--head ${quote(branch)}`, `--title ${quote(title)}`, `--body-file ${quote(bodyFile)}`, outcome === 'needs-agent' ? '--draft' : '', ...options.labels.map((l) => `--label ${quote(l)}`)].filter(Boolean).join(' '),
      );
      if (pr.code !== 0 && isPrRefusal(`${pr.stderr}\n${pr.stdout}`)) {
        // Actions (or this token) may not open PRs here. The work is pushed; hand it over through
        // an issue with a one-click link to open the PR, rather than failing.
        const web = repoWebUrl(deps.env ?? process.env, (await run('git remote get-url origin')).stdout.trim());
        const compare = web ? `${web}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1` : undefined;
        const note = [
          '> [!NOTE]',
          `> GitHub Actions may not open pull requests in this repository, so the change is on branch \`${branch}\`.`,
          compare ? `> **[Open the pull request](${compare})**${outcome === 'needs-agent' ? ' (as a draft: grafts still need attention)' : ''}.` : `> Open a pull request from \`${branch}\` into \`${base}\`${outcome === 'needs-agent' ? ' (as a draft: grafts still need attention)' : ''}.`,
          '> To let the action open pull requests itself, allow it under Settings → Actions → General, or pass a GitHub App token or a fine-grained PAT as `github-token` (PRs opened with those also trigger CI).',
          '',
        ].join('\n');
        const issue = await openIssue(title, `${note}\n${body}`, `pr-refused-${slug(candidate.package)}.md`);
        result.issue = issue.url;
        result.compareUrl = compare;
        result.outcome = 'pr-refused-issue';
        result.reasons.push(`pull request not allowed from Actions; branch ${branch} pushed, ${issue.existing ? 'issue already open' : 'issue opened'}: ${issue.url}`);
        continue;
      }
      if (pr.code !== 0) throw new Error(`gh pr create failed: ${pr.stderr || pr.stdout}`);
      result.pullRequest = pr.stdout.trim().split('\n').pop();
      result.outcome = outcome === 'green' ? 'pr' : 'draft-pr';
    } catch (err) {
      result.outcome = 'error';
      result.reasons.push(err.message);
      log(`graft: ${candidate.package}@${candidate.version} failed: ${err.message}`);
    }
  }

  if (dirty) {
    // Leave the workspace on the base branch with no files left over from sync runs.
    await run(`git checkout -f ${quote(base)}`);
    await run('git clean -fd');
  }
  await deps.writeOutput('check', JSON.stringify(check ?? null));
  await deps.writeOutput('results', JSON.stringify(results));
  await deps.writeOutput('pull-requests', JSON.stringify(results.filter((r) => r.pullRequest).map((r) => r.pullRequest)));
  await deps.writeSummary((check ? renderCheck(check, options.check) : '') + renderSummary(results));
  return { results, check, failed: results.some((r) => r.outcome === 'error') || (options.check === 'fail' && checkFailed) };
}

/**
 * Run `graft check --json` against the installed tree. Never throws: a tooling error (exit 2,
 * or output that is not a JSON report) is itself a failed check.
 */
export async function runCheck(options, run) {
  const command = `${options.graftCommand} check --json`;
  const r = await run(command);
  let reports;
  try {
    reports = JSON.parse(r.stdout);
    if (!Array.isArray(reports)) throw new Error('not an array');
  } catch {
    const detail = (r.stderr || r.stdout).trim().split('\n').slice(-5).join(' ') || `exit ${r.code}`;
    return { ok: false, exitCode: r.code, reports: [], failures: [`\`${command}\` failed: ${detail}`] };
  }
  const failures = [];
  const rows = reports.map((rep) => {
    const problems = [
      ...(rep.errors ?? []),
      ...(rep.anchors ?? []).filter((a) => !a.matched).map((a) => `anchor ${a.name} missed in ${a.file}${a.error ? ` (${a.error})` : ''}`),
    ];
    for (const p of problems) failures.push(`${rep.graft} (${rep.package}@${rep.version}): ${p}`);
    return { graft: rep.graft, package: rep.package, version: rep.version, variant: rep.variant?.module ?? null, ok: !!rep.ok && problems.length === 0, problems };
  });
  return { ok: r.code === 0 && rows.every((x) => x.ok), exitCode: r.code, reports: rows, failures };
}

export function renderCheck(check, mode) {
  const lines = ['## Graft check', ''];
  if (!check.reports.length && check.failures.length) {
    lines.push(`❌ ${check.failures[0]}`, '');
    return `${lines.join('\n')}\n`;
  }
  if (!check.reports.length) return `${[...lines, 'No active grafts.', ''].join('\n')}\n`;
  lines.push('| Graft | Installed | Variant | Result |', '|---|---|---|---|');
  for (const r of check.reports) lines.push(`| ${r.graft} | ${r.package}@${r.version} | ${r.variant ?? '—'} | ${r.ok ? '✅ applied' : `❌ ${r.problems.length} problem(s)`} |`);
  const bad = check.reports.filter((r) => !r.ok);
  for (const r of bad) lines.push('', `**${r.graft}**`, ...r.problems.map((p) => `- ${p.split('\n')[0]}`));
  if (bad.length) {
    lines.push('', mode === 'fail' ? 'The job fails because the installed tree does not match the grafts.' : '_Reported as a warning (`check: warn`)._');
  }
  return `${lines.join('\n')}\n\n`;
}

const ICON = { 'pr-refused-issue': '📝', pr: '✅', 'draft-pr': '🛠️', issue: '🛠️', 'would-open-issue': '🛠️ (dry run)', 'needs-agent': '🛠️', 'skipped-existing': '⏭️', 'up-to-date': '✔️', 'no-changes': '➖', 'would-open-pr': '✅ (dry run)', 'would-open-draft-pr': '🛠️ (dry run)', error: '❌' };

export function renderSummary(results) {
  const lines = ['## Graft sync', '', '| Package | Verified → Candidate | Outcome | Link |', '|---|---|---|---|'];
  for (const r of results) lines.push(`| ${r.package} | ${r.from} → ${r.to ?? '—'} | ${ICON[r.outcome] ?? ''} ${r.outcome} | ${r.pullRequest ?? r.issue ?? ''} |`);
  const notes = results.filter((r) => r.reasons?.length);
  for (const r of notes) lines.push('', `**${r.package}**`, ...r.reasons.map((x) => `- ${x.split('\n')[0]}`));
  return `${lines.join('\n')}\n`;
}
