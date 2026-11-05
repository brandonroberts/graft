import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs module without type declarations
import { detectInstallCommand, parseInputs, renderPrBody, runAction, sh } from '../src/sync-action.mjs';

const FAKE_GRAFT = path.join(import.meta.dirname, 'fake-graft.mjs');

type Scenario = { outdated: unknown[]; sync: Record<string, string>; issues?: { title: string; url: string }[]; check?: 'ok' | 'fail' | 'error'; refusePr?: 'actions' | 'other'; noUpstream?: boolean; changeUpstream?: boolean };

function setup(scenario: Scenario) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'graft-action-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.log');
  const scenarioFile = path.join(root, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  writeFileSync(log, '');
  mkdirSync(bin);
  // Fake gh: records calls, returns URLs.
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, 'utf8'));
const args = process.argv.slice(2);
const bodyIdx = args.indexOf('--body-file');
fs.appendFileSync(process.env.FAKE_LOG, 'gh ' + JSON.stringify(args) + '\\n');
if (bodyIdx !== -1) fs.appendFileSync(process.env.FAKE_LOG, 'BODY ' + JSON.stringify(fs.readFileSync(args[bodyIdx + 1], 'utf8')) + '\\n');
if (args[0] === 'pr' && args[1] === 'create' && s.refusePr === 'actions') { console.error('pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)'); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'create' && s.refusePr === 'other') { console.error('pull request create failed: GraphQL: Head sha cannot be blank'); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/o/r/pull/' + (fs.readFileSync(process.env.FAKE_LOG, 'utf8').split('pr\\",\\"create').length - 1));
if (args[0] === 'issue' && args[1] === 'list') console.log(JSON.stringify(s.issues || []));
if (args[0] === 'issue' && args[1] === 'create') console.log('https://github.com/o/r/issues/7');
`,
  );
  chmodSync(path.join(bin, 'gh'), 0o755);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(path.join(work, '.gitignore'), '.grafts/.report/\n');
  git(work, 'add', '-A');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');

  const outputs: Record<string, string> = {};
  let summary = '';
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_SCENARIO: scenarioFile, FAKE_LOG: log };
  const run = (inputs: Record<string, string> = {}) =>
    runAction(parseInputs({ 'graft-command': `node ${FAKE_GRAFT}`, 'install-command': 'true', ...inputs }), {
      cwd: work,
      sh: (cmd: string, opts: { env?: Record<string, string> } = {}) => sh(cmd, { ...opts, env: { ...env, ...opts.env } }),
      log: () => {},
      writeOutput: (k: string, v: string) => (outputs[k] = v),
      writeSummary: (md: string) => (summary += md),
      tmpDir: path.join(root, 'tmp'),
      actionPath: path.join(import.meta.dirname, '..'),
      env: { GITHUB_REPOSITORY: 'o/r', GITHUB_SERVER_URL: 'https://github.com' },
    });
  const calls = () => readFileSync(log, 'utf8');
  const remoteBranches = () => git(work, 'ls-remote', '--heads', 'origin').trim();
  return { work, run, calls, outputs, summary: () => summary, remoteBranches, git: (...a: string[]) => git(work, ...a) };
}

const entry = (pkg: string, version: string) => ({ package: pkg, grafts: [`${pkg}-graft`], verified: '1.0.0', distTags: { latest: version }, candidate: { version, tag: 'latest' } });

describe('graft GitHub Action', () => {
  it('opens a PR when the deterministic first pass is green, and skips up-to-date packages', async () => {
    const t = setup({ outdated: [entry('lib', '1.1.0'), { package: 'other', grafts: ['o'], verified: '2.0.0', distTags: {} }], sync: { lib: 'green' } });
    const { results, failed } = await t.run({ labels: 'deps' });
    expect(failed).toBe(false);
    expect(results.find((r: any) => r.package === 'lib')).toMatchObject({ outcome: 'pr', pullRequest: 'https://github.com/o/r/pull/1', branch: 'graft/sync-lib-1.1.0' });
    expect(results.find((r: any) => r.package === 'other')).toMatchObject({ outcome: 'up-to-date' });
    expect(t.calls()).toMatch(/graft sync --json --version 1\.1\.0 --package lib --install/);
    const create = t.calls().split('\n').find((l) => l.includes('"create"'))!;
    expect(create).toContain('"--label","deps"');
    expect(create).not.toContain('--draft');
    expect(t.remoteBranches()).toContain('refs/heads/graft/sync-lib-1.1.0');
    expect(t.git('show', 'origin/graft/sync-lib-1.1.0:.grafts/lib-graft/graft.md')).toContain('verified: 1.1.0');
    expect(t.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(JSON.parse(t.outputs['pull-requests']!)).toEqual(['https://github.com/o/r/pull/1']);
    expect(t.summary()).toContain('| lib | 1.0.0 → 1.1.0 | ✅ pr |');
  });

  it('opens an issue (once) when grafts need an agent and none is configured', async () => {
    const t = setup({ outdated: [entry('lib', '2.0.0')], sync: { lib: 'needs-agent' } });
    const first = await t.run();
    expect(first.results[0]).toMatchObject({ outcome: 'issue', issue: 'https://github.com/o/r/issues/7' });
    expect(t.calls()).toContain('anchors: lib/index.js#1 missed');
    expect(t.remoteBranches()).not.toContain('graft/sync-lib');

    const again = setup({ outdated: [entry('lib', '2.0.0')], sync: { lib: 'needs-agent' }, issues: [{ title: 'graft: sync lib to 2.0.0 (needs attention)', url: 'https://github.com/o/r/issues/7' }] });
    const second = await again.run();
    expect(second.results[0]).toMatchObject({ outcome: 'skipped-existing', issue: 'https://github.com/o/r/issues/7' });
    expect(again.calls()).not.toContain('"issue","create"');
  });

  it('hands off to the agent, re-verifies its work, and uses its PR description', async () => {
    const t = setup({ outdated: [entry('lib', '2.0.0')], sync: { lib: 'needs-agent' } });
    const agent = `test -f "$GRAFT_PROMPT_FILE" && test -n "$GRAFT_COMMAND" && test -f "$GRAFT_SKILL_PATH" && grep -q "Do NOT commit" "$GRAFT_PROMPT_FILE" && touch .agent-fixed && printf '## Graft sync: lib 1.0.0 → 2.0.0\\nAgent wrote a v2 variant.' > "$GRAFT_PR_BODY_FILE"`;
    const { results } = await t.run({ 'agent-command': agent });
    expect(results[0]).toMatchObject({ outcome: 'pr', agent: true, agentExitCode: 0, syncExitCode: 0 });
    expect(t.calls().match(/graft sync/g)).toHaveLength(2); // before and after the agent
    expect(t.calls()).toContain('Agent wrote a v2 variant.');
    expect(t.git('show', '--stat', 'origin/graft/sync-lib-2.0.0')).toContain('.agent-fixed');
  });

  it('opens a draft PR when the agent made changes but grafts still fail', async () => {
    const t = setup({ outdated: [entry('lib', '2.0.0')], sync: { lib: 'needs-agent' } });
    const { results } = await t.run({ 'agent-command': 'echo partial > notes.txt; exit 3' });
    expect(results[0]).toMatchObject({ outcome: 'draft-pr', agentExitCode: 3 });
    expect(results[0].reasons.join('\n')).toMatch(/agent command exited 3/);
    expect(t.calls().split('\n').find((l) => l.includes('"pr","create"'))).toContain('--draft');
  });

  const repoEntry = (version: string) => ({ package: 'docs', grafts: ['tr'], verified: '1.0.0', distTags: {}, candidate: { version, tag: `v${version}` }, standalone: true });

  it('repo mode: adopts Graft\'s rebased result into the PR branch, with no install', async () => {
    const t = setup({ outdated: [repoEntry('1.1.0')], sync: { tr: 'repo-green' } });
    const { results, failed } = await t.run({ 'install-command': 'echo REINSTALL >> "$FAKE_LOG"' });
    expect(failed).toBe(false);
    expect(results[0]).toMatchObject({ outcome: 'pr', branch: 'graft/sync-docs-1.1.0' });
    expect(t.calls()).toMatch(/graft sync --json --version 1\.1\.0 --id tr\n/);
    expect(t.calls()).not.toContain('REINSTALL');
    expect(t.git('show', 'origin/graft/sync-docs-1.1.0:content/page.md')).toBe('çevrildi 1.1.0\n');
    expect(t.git('show', 'origin/graft/sync-docs-1.1.0:.grafts/tr/graft.md')).toContain('verified: 1.1.0');
    expect(t.calls()).toContain('this branch is the fork rebased onto it');
    // A merge of the upstream commit the result sits on, with the result's tree: the fork keeps
    // upstream in its history. (Here the fork's main is behind upstream: still a merge, not a fast-forward.)
    const pr = 'origin/graft/sync-docs-1.1.0';
    const upstream = t.git('rev-parse', 'refs/fake-upstream/1.1.0').trim();
    expect(t.git('rev-list', '--parents', '-n1', pr).trim().split(' ').slice(1)).toEqual([t.git('rev-parse', 'main').trim(), upstream]);
    expect(t.git('rev-parse', `${pr}^{tree}`)).toBe(t.git('rev-parse', 'graft/tr/1.1.0^{tree}'));
  });

  it('repo mode: a fork that has diverged from upstream gets a real merge commit (#22)', async () => {
    const t = setup({ outdated: [repoEntry('1.1.0')], sync: { tr: 'repo-green' } });
    writeFileSync(path.join(t.work, 'fork.txt'), 'fork work\n');
    t.git('add', '-A');
    t.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fork work');
    t.git('push', '-q', 'origin', 'main');
    const { results } = await t.run();
    expect(results[0]).toMatchObject({ outcome: 'pr' });
    const pr = 'origin/graft/sync-docs-1.1.0';
    const upstream = t.git('rev-parse', 'refs/fake-upstream/1.1.0').trim();
    expect(t.git('rev-list', '--parents', '-n1', pr).trim().split(' ').slice(1)).toEqual([t.git('rev-parse', 'main').trim(), upstream]);
    // Upstream is now in the fork's history: a later `git merge upstream` has nothing to replay.
    expect(t.git('merge-base', pr, upstream).trim()).toBe(upstream);
    expect(t.git('show', `${pr}:upstream.txt`)).toBe('upstream 1.1.0\n');
  });

  it('repo mode: a result without an upstream commit is adopted as a plain commit, as before', async () => {
    const t = setup({ outdated: [repoEntry('1.1.0')], sync: { tr: 'repo-green' }, noUpstream: true });
    const { results } = await t.run();
    expect(results[0]).toMatchObject({ outcome: 'pr' });
    expect(t.git('rev-list', '--parents', '-n1', 'origin/graft/sync-docs-1.1.0').trim().split(' ')).toHaveLength(2);
  });

  it('repo mode: without an agent, opens a draft PR holding git\'s merge with conflict markers', async () => {
    const t = setup({ outdated: [repoEntry('2.0.0')], sync: { tr: 'repo-conflict' } });
    const { results } = await t.run();
    expect(results[0]).toMatchObject({ outcome: 'draft-pr' });
    expect(t.git('show', 'origin/graft/sync-docs-2.0.0:content/page.md')).toContain('<<<<<<<');
    expect(t.git('show', 'origin/graft/sync-docs-2.0.0:.grafts/tr/graft.md')).toContain('status: conflicted');
    expect(t.calls()).toContain('Conflict markers to resolve on this branch: `content/page.md`');
  });

  it('repo mode: the agent resolves the markers in place, Graft re-verifies, and the PR carries the result', async () => {
    const t = setup({ outdated: [repoEntry('2.0.0')], sync: { tr: 'repo-conflict' } });
    const agent = `grep -q "These files still have conflict markers: content/page.md" "$GRAFT_PROMPT_FILE" && grep -q "checks the working tree in place" "$GRAFT_PROMPT_FILE" && grep -q "with the project.s own tests" "$GRAFT_PROMPT_FILE" && printf 'Yeni Türkçe.\\n' > content/page.md`;
    const { results } = await t.run({ 'agent-command': agent });
    expect(results[0]).toMatchObject({ outcome: 'pr', agent: true, agentExitCode: 0, syncExitCode: 0 });
    expect(t.git('show', 'origin/graft/sync-docs-2.0.0:content/page.md')).toBe('Yeni Türkçe.\n');
    expect(t.git('show', 'origin/graft/sync-docs-2.0.0:.grafts/tr/graft.md')).toContain('status: applied');
    // The merge begun when the -agent branch was adopted is the one committed.
    const upstream = t.git('rev-parse', 'refs/fake-upstream/2.0.0').trim();
    expect(t.git('rev-list', '--parents', '-n1', 'origin/graft/sync-docs-2.0.0').trim().split(' ').slice(1)).toEqual([t.git('rev-parse', 'main').trim(), upstream]);
  });

  it('repo mode: fails loudly when the re-verified result sits on a different upstream than the merge begun for the agent', async () => {
    const t = setup({ outdated: [repoEntry('2.0.0')], sync: { tr: 'repo-conflict' }, changeUpstream: true });
    const { results, failed } = await t.run({ 'agent-command': `printf 'Yeni Türkçe.\\n' > content/page.md` });
    expect(failed).toBe(true);
    expect(results[0]).toMatchObject({ outcome: 'error' });
    expect(results[0].reasons.join('\n')).toMatch(/already merging [0-9a-f]{40}, not upstream [0-9a-f]{40}/);
    expect(t.remoteBranches()).not.toContain('graft/sync-docs-2.0.0');
  });

  it('when Actions may not open PRs, pushes the branch and opens an issue with a one-click PR link instead', async () => {
    const t = setup({ outdated: [entry('lib', '1.1.0')], sync: { lib: 'green' }, refusePr: 'actions' });
    const { results, failed } = await t.run();
    expect(failed).toBe(false);
    expect(results[0]).toMatchObject({
      outcome: 'pr-refused-issue',
      issue: 'https://github.com/o/r/issues/7',
      compareUrl: 'https://github.com/o/r/compare/main...graft%2Fsync-lib-1.1.0?expand=1',
    });
    expect(t.remoteBranches()).toContain('refs/heads/graft/sync-lib-1.1.0'); // the work is there
    const issueBody = t.calls().split('\n').filter((l) => l.startsWith('BODY ')).pop()!;
    expect(issueBody).toContain('GitHub Actions may not open pull requests in this repository');
    expect(issueBody).toContain('[Open the pull request](https://github.com/o/r/compare/main...graft%2Fsync-lib-1.1.0?expand=1)');
    expect(issueBody).toContain('github-token');
    expect(t.summary()).toContain('📝 pr-refused-issue');
  });

  it('a draft PR that may not be opened says so in its issue; other gh failures stay errors', async () => {
    const draft = setup({ outdated: [entry('lib', '2.0.0')], sync: { lib: 'needs-agent' }, refusePr: 'actions' });
    const r = await draft.run({ 'agent-command': 'echo partial > notes.txt; exit 3' });
    expect(r.results[0]).toMatchObject({ outcome: 'pr-refused-issue' });
    expect(draft.calls()).toContain('(as a draft: grafts still need attention)');

    const other = setup({ outdated: [entry('lib', '1.1.0')], sync: { lib: 'green' }, refusePr: 'other' });
    const o = await other.run();
    expect(o.failed).toBe(true);
    expect(o.results[0].outcome).toBe('error');
    expect(o.results[0].reasons.join('\n')).toContain("Head sha cannot be blank");
  });

  it('skips packages whose sync branch already exists, and isolates tooling errors', async () => {
    const t = setup({ outdated: [entry('bad', '3.0.0'), entry('lib', '1.1.0')], sync: { bad: 'error', lib: 'green' } });
    t.git('push', '-q', 'origin', 'main:graft/sync-lib-1.1.0');
    const { results, failed } = await t.run();
    expect(failed).toBe(true);
    expect(results.find((r: any) => r.package === 'bad')).toMatchObject({ outcome: 'error' });
    expect(results.find((r: any) => r.package === 'bad').reasons.join('\n')).toContain('registry unreachable');
    expect(results.find((r: any) => r.package === 'lib')).toMatchObject({ outcome: 'skipped-existing' });
    expect(t.calls()).not.toContain('"pr","create"');
  });

  it('dry run pushes nothing', async () => {
    const t = setup({ outdated: [entry('lib', '1.1.0')], sync: { lib: 'green' } });
    const { results } = await t.run({ 'dry-run': 'true' });
    expect(results[0]).toMatchObject({ outcome: 'would-open-pr' });
    expect(t.remoteBranches()).not.toContain('graft/sync');
    expect(existsSync(path.join(t.work, '.grafts/lib-graft/graft.md'))).toBe(false); // back on main, clean
  });

  it('refuses to sync over uncommitted work, dry run included, and leaves it in place (#24)', async () => {
    for (const inputs of [{}, { 'dry-run': 'true' }]) {
      const t = setup({ outdated: [entry('lib', '1.1.0')], sync: { lib: 'green' } });
      writeFileSync(path.join(t.work, 'package.json'), JSON.stringify({ name: 'app', edited: true }));
      mkdirSync(path.join(t.work, '.github/workflows'), { recursive: true });
      writeFileSync(path.join(t.work, '.github/workflows/new.yml'), 'name: new\n');
      await expect(t.run(inputs)).rejects.toThrow(
        /the working tree has uncommitted changes or untracked files: package\.json, \.github\/workflows\/new\.yml\. Syncing switches branches/,
      );
      expect(t.calls()).not.toContain('graft sync');
      expect(t.git('branch', '--list', 'graft/*').trim()).toBe('');
      expect(readFileSync(path.join(t.work, 'package.json'), 'utf8')).toContain('"edited":true');
      expect(readFileSync(path.join(t.work, '.github/workflows/new.yml'), 'utf8')).toBe('name: new\n');
    }
  });

  it('ignored files, check-only runs and up-to-date runs do not need a clean tree', async () => {
    const dirtyWork = (t: ReturnType<typeof setup>) => writeFileSync(path.join(t.work, 'notes.txt'), 'mine\n');
    const ignored = setup({ outdated: [entry('lib', '1.1.0')], sync: { lib: 'green' } });
    mkdirSync(path.join(ignored.work, '.grafts/.report'), { recursive: true });
    writeFileSync(path.join(ignored.work, '.grafts/.report/sync.md'), 'old report\n');
    expect((await ignored.run()).results[0]).toMatchObject({ outcome: 'pr' });

    const checkOnly = setup({ outdated: [entry('lib', '1.1.0')], sync: { lib: 'green' }, check: 'ok' });
    dirtyWork(checkOnly);
    expect((await checkOnly.run({ sync: 'false' })).failed).toBe(false);
    expect(readFileSync(path.join(checkOnly.work, 'notes.txt'), 'utf8')).toBe('mine\n');

    const upToDate = setup({ outdated: [{ package: 'lib', grafts: ['lib-graft'], verified: '1.1.0', distTags: { latest: '1.1.0' } }], sync: {} });
    dirtyWork(upToDate);
    expect((await upToDate.run()).results[0]).toMatchObject({ outcome: 'up-to-date' });
    expect(readFileSync(path.join(upToDate.work, 'notes.txt'), 'utf8')).toBe('mine\n');
  });

  it('renders PR bodies with per-graft failure details', () => {
    const body = renderPrBody({
      candidate: { package: 'lib', verified: '1.0.0', version: '2.0.0', tag: 'next' },
      outcome: 'needs-agent',
      report: { grafts: [{ id: 'g', from: '1.0.0', to: '2.0.0', outcome: 'needs-agent', reasons: ['anchors: anchor "index.js#1" missed in index.js'] }] },
    });
    expect(body).toContain('## Graft sync: lib 1.0.0 → 2.0.0');
    expect(body).toContain('dist-tag `next`');
    expect(body).toContain('anchor "index.js#1" missed in index.js');
    expect(body).toContain('[!WARNING]');
    expect(body).toContain("it doesn't check behavior"); // Graft doesn't claim to have verified behavior
  });

  it('calls out a graft that upstream has likely absorbed', () => {
    const body = renderPrBody({
      candidate: { package: 'lib', verified: '1.0.0', version: '2.0.0', tag: 'latest' },
      outcome: 'needs-agent',
      report: { grafts: [{ id: 'g', package: 'lib', from: '1.0.0', to: '2.0.0', outcome: 'needs-agent', likelyUpstreamed: true, reasons: ['upstream lib@2.0.0 already contains this graft\'s change'] }] },
    });
    expect(body).toContain('g: needs-agent (likely upstreamed)');
    expect(body).toContain('**Likely upstreamed:** `lib@2.0.0`');
  });
});

describe('graft check in the Action', () => {
  it('runs graft check first and reports a passing check', async () => {
    const t = setup({ outdated: [entry('lib', '1.1.0')], sync: { lib: 'green' }, check: 'ok' });
    const { failed, check } = await t.run();
    expect(failed).toBe(false);
    expect(check.ok).toBe(true);
    const calls = t.calls().split('\n');
    expect(calls.findIndex((l) => l.includes('graft check --json'))).toBeLessThan(calls.findIndex((l) => l.includes('graft outdated')));
    expect(t.summary()).toContain('| lib-graft | lib@1.0.0 | ./variants/v1.patch | ✅ applied |');
    expect(JSON.parse(t.outputs.check!).ok).toBe(true);
  });

  it('fails the job (after still doing the sync work) when grafts are not applied', async () => {
    const t = setup({ outdated: [entry('lib', '1.1.0')], sync: { lib: 'green' }, check: 'fail' });
    const { failed, results, check } = await t.run();
    expect(failed).toBe(true);
    expect(results.find((r: any) => r.package === 'lib').outcome).toBe('pr'); // sync still ran
    expect(check.failures[0]).toMatch(/lib-graft \(lib@1\.0\.0\): installed lib@1\.0\.0 index\.js is not patched/);
    expect(t.summary()).toContain('❌ 1 problem(s)');
    expect(t.summary()).toContain('The job fails because the installed tree does not match the grafts.');
  });

  it('treats a tooling error as a failed check, and warn mode does not fail the job', async () => {
    const errored = setup({ outdated: [], sync: {}, check: 'error' });
    const e = await errored.run();
    expect(e.failed).toBe(true);
    expect(e.check.failures[0]).toMatch(/check --json` failed: graft: lib is not installed/);

    const warned = setup({ outdated: [], sync: {}, check: 'fail' });
    expect((await warned.run({ check: 'warn' })).failed).toBe(false);
    expect(warned.summary()).toContain('Reported as a warning');
  });

  it('check-only mode (sync: false) never polls upstream or touches git', async () => {
    const t = setup({ outdated: [entry('lib', '1.1.0')], sync: { lib: 'green' }, check: 'fail' });
    const { failed, results } = await t.run({ sync: 'false' });
    expect(failed).toBe(true);
    expect(results).toEqual([]);
    expect(t.calls()).not.toContain('graft outdated');
    expect(t.calls()).not.toContain('graft sync');
    expect(t.remoteBranches()).not.toContain('graft/sync');
    expect(t.outputs.results).toBe('[]');
  });

  it('check: off skips it entirely', async () => {
    const t = setup({ outdated: [], sync: {}, check: 'fail' });
    const { failed, check } = await t.run({ check: 'off' });
    expect(failed).toBe(false);
    expect(check).toBeUndefined();
    expect(t.calls()).not.toContain('graft check');
  });
});

describe('detectInstallCommand', () => {
  const dir = (files: Record<string, string>) => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'graft-action-pm-'));
    for (const [f, c] of Object.entries(files)) writeFileSync(path.join(d, f), c);
    return d;
  };

  it('uses --frozen-lockfile for yarn classic and --immutable for yarn 2+', () => {
    expect(detectInstallCommand(dir({ 'yarn.lock': '# yarn lockfile v1\n' }))).toBe('yarn install --frozen-lockfile');
    expect(detectInstallCommand(dir({ 'yarn.lock': '__metadata:\n  version: 8\n' }))).toBe('yarn install --immutable');
    expect(detectInstallCommand(dir({ 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: pnp\n' }))).toBe('yarn install --immutable');
    expect(detectInstallCommand(dir({ 'yarn.lock': '', 'package.json': '{"packageManager":"yarn@4.18.1"}' }))).toBe('yarn install --immutable');
    expect(detectInstallCommand(dir({ 'yarn.lock': '', 'package.json': '{"packageManager":"yarn@1.22.22"}' }))).toBe('yarn install --frozen-lockfile');
  });
});
