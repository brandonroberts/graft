// Graft GitHub Action: poll upstream dist-tags, run the deterministic first pass, open PRs, and
// hand grafts that need an agent to a configurable agent command. Uses only Node builtins and
// the git / gh CLIs, so it runs from a checkout of this repository with no build step.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
    mcpCommand: str('mcp-command', 'npx --no-install graft-mcp'),
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

/** Detect a reinstall command from the lockfile, used to reset node_modules between candidates. */
export function detectInstallCommand(cwd) {
  // Same precedence as Graft core: pnpm, npm, upm, then yarn and bun; npm when nothing says otherwise.
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
  if (existsSync(path.join(cwd, 'package-lock.json')) || existsSync(path.join(cwd, 'npm-shrinkwrap.json'))) return 'npm ci';
  if (existsSync(path.join(cwd, 'upm.lock'))) return 'upm install --frozen-lockfile';
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn install --frozen-lockfile';
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
  lines.push(`Upstream \`${candidate.package}@${candidate.version}\` (dist-tag \`${candidate.tag}\`).`, '');
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
      const failed = (g.oracle?.modes ?? []).filter((m) => !m.passed);
      for (const m of failed) lines.push('', `Oracle output (${m.mode}):`, '', '```', String(m.output ?? '').trim().slice(-3000), '```');
      lines.push('', '</details>', '');
    }
  }
  lines.push('---', '_Opened by the [Graft](https://github.com/brandonroberts/graft) GitHub Action. Graft verified this change with each graft\'s oracle; review the variant diffs before merging._');
  return lines.join('\n');
}

/** Prompt handed to the agent command (also exported as GRAFT_PROMPT_FILE). */
export function renderAgentPrompt({ candidate, report, files }) {
  const needs = report.grafts.filter((g) => g.outcome === 'needs-agent').map((g) => g.id);
  return `Graft sync needs an agent.

Upstream ${candidate.package} was released as ${candidate.version} (dist-tag "${candidate.tag}"); the grafts were verified against ${candidate.verified}.
The deterministic first pass could not re-verify these grafts: ${needs.join(', ')}.

Follow the graft-sync skill: ${files.skill}
The sync report is at ${files.reportMarkdown} (JSON: ${files.reportJson}); scoped upstream diffs are under .grafts/.report/<id>/diff.patch.
The graft MCP server is configured in ${files.mcpConfig}; the CLI is \`${files.graftCommand}\`.

You are running inside the Graft GitHub Action on branch ${files.branch}:
- Do NOT commit, push, or open a pull request; the action does that after re-verifying your work.
- Make the grafts pass for ${candidate.package}@${candidate.version} by adding new variants (never edit existing ones), registering them, and proving them with the oracle (\`${files.graftCommand} sync --version ${candidate.version} --package ${candidate.package} --install\`).
- If an invariant cannot be satisfied, mark the graft conflicted with a History entry instead of forcing a pass.
- Write the pull request description (the skill's format) to ${files.prBody}.
`;
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
    .map((e) => ({ package: e.package, version: e.candidate.version, tag: e.candidate.tag, verified: e.verified, grafts: e.grafts }));

  const results = entries
    .filter((e) => !e.candidate && (!options.packages.length || options.packages.includes(e.package)))
    .map((e) => ({ package: e.package, from: e.verified, outcome: 'up-to-date' }));
  if (!candidates.length) log('graft: all rootstock packages are up to date');

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
        const r = await run(reinstall);
        if (r.code !== 0) throw new Error(`\`${reinstall}\` failed:\n${r.stderr || r.stdout}`);
      }
      dirty = true;
      await git('checkout', '-B', branch, base);

      const syncCmd = `${options.graftCommand} sync --json --version ${quote(candidate.version)} --package ${quote(candidate.package)} --install`;
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

      let agentBody;
      if (code === 1 && options.agentCommand) {
        const files = {
          skill,
          reportJson: path.join(cwd, '.grafts/.report/sync.json'),
          reportMarkdown: path.join(cwd, '.grafts/.report/sync.md'),
          mcpConfig: path.join(deps.tmpDir, 'graft-mcp.json'),
          prBody: path.join(deps.tmpDir, `pr-body-${slug(candidate.package)}.md`),
          prompt: path.join(deps.tmpDir, `prompt-${slug(candidate.package)}.md`),
          graftCommand: options.graftCommand,
          branch,
        };
        const [mcpCmd, ...mcpArgs] = options.mcpCommand.split(/\s+/);
        await writeFile(files.mcpConfig, JSON.stringify({ mcpServers: { graft: { command: mcpCmd, args: [...mcpArgs, '--root', cwd] } } }, null, 2));
        await writeFile(files.prompt, renderAgentPrompt({ candidate, report, files }));
        log(`graft: handing ${candidate.package}@${candidate.version} to the agent`);
        const agent = await run(options.agentCommand, {
          env: {
            GRAFT_PROMPT_FILE: files.prompt,
            GRAFT_SKILL_PATH: files.skill,
            GRAFT_MCP_CONFIG: files.mcpConfig,
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
        const existing = await run(`gh issue list --state open --search ${quote(`in:title "${title}"`)} --json title,url`);
        const open = existing.code === 0 ? JSON.parse(existing.stdout || '[]').find((i) => i.title === title) : undefined;
        if (open) {
          result.outcome = 'skipped-existing';
          result.issue = open.url;
          result.reasons.push(`issue already open: ${open.url}`);
          continue;
        }
        const bodyFile = path.join(deps.tmpDir, `issue-${slug(candidate.package)}.md`);
        await writeFile(bodyFile, body);
        const issue = await run([`gh issue create --title ${quote(title)} --body-file ${quote(bodyFile)}`, ...options.labels.map((l) => `--label ${quote(l)}`)].join(' '));
        if (issue.code !== 0) throw new Error(`gh issue create failed: ${issue.stderr || issue.stdout}`);
        result.issue = issue.stdout.trim().split('\n').pop();
        result.outcome = 'issue';
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

const ICON = { pr: '✅', 'draft-pr': '🛠️', issue: '🛠️', 'would-open-issue': '🛠️ (dry run)', 'needs-agent': '🛠️', 'skipped-existing': '⏭️', 'up-to-date': '✔️', 'no-changes': '➖', 'would-open-pr': '✅ (dry run)', 'would-open-draft-pr': '🛠️ (dry run)', error: '❌' };

export function renderSummary(results) {
  const lines = ['## Graft sync', '', '| Package | Verified → Candidate | Outcome | Link |', '|---|---|---|---|'];
  for (const r of results) lines.push(`| ${r.package} | ${r.from} → ${r.to ?? '—'} | ${ICON[r.outcome] ?? ''} ${r.outcome} | ${r.pullRequest ?? r.issue ?? ''} |`);
  const notes = results.filter((r) => r.reasons?.length);
  for (const r of notes) lines.push('', `**${r.package}**`, ...r.reasons.map((x) => `- ${x.split('\n')[0]}`));
  return `${lines.join('\n')}\n`;
}
