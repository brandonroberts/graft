import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs module without type declarations
import { detectInstallCommand, parseInputs, renderPrBody, runAction, sh } from '../src/sync-action.mjs';

const FAKE_GRAFT = path.join(import.meta.dirname, 'fake-graft.mjs');

type Scenario = { outdated: unknown[]; sync: Record<string, string>; issues?: { title: string; url: string }[]; check?: 'ok' | 'fail' | 'error' };

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
    const agent = `test -f "$GRAFT_PROMPT_FILE" && test -f "$GRAFT_MCP_CONFIG" && test -f "$GRAFT_SKILL_PATH" && grep -q "Do NOT commit" "$GRAFT_PROMPT_FILE" && touch .agent-fixed && printf '## Graft sync: lib 1.0.0 → 2.0.0\\nAgent wrote a v2 variant.' > "$GRAFT_PR_BODY_FILE"`;
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

  it('renders PR bodies with per-graft failure details', () => {
    const body = renderPrBody({
      candidate: { package: 'lib', verified: '1.0.0', version: '2.0.0', tag: 'next' },
      outcome: 'needs-agent',
      report: { grafts: [{ id: 'g', from: '1.0.0', to: '2.0.0', outcome: 'needs-agent', reasons: ['oracle failed in mode(s): esm'], oracle: { modes: [{ mode: 'esm', passed: false, output: 'AssertionError: boom' }] } }] },
    });
    expect(body).toContain('## Graft sync: lib 1.0.0 → 2.0.0');
    expect(body).toContain('dist-tag `next`');
    expect(body).toContain('AssertionError: boom');
    expect(body).toContain('[!WARNING]');
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
