// Repo mode (`fork.install: none`): a fork that is the product itself, shaped like a translated
// docs site (e.g. erkamyaman/angular-tr). The graft lives in the fork's own checkout, its base
// is an upstream commit between releases, and the oracle checks for leftover English.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Project, runOracle, sync } from '@graftsync/core';
import { forkAdapter, resetFetchCache } from '../src/index.js';

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });

const GUIDE = `# Guide

Components are the building blocks of the app.

\`\`\`ts
const x = 1;
\`\`\`

Templates bind data to the view.
`;
const OTHER = `# Deploy

Build the app before you deploy it.

\`\`\`sh
ng build
\`\`\`
`;
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 4]);
const LOGO_TR = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9, 0, 4]);

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-repo-'));
  const upstream = path.join(root, 'upstream');
  await mkdir(path.join(upstream, 'content'), { recursive: true });
  gitIn(upstream, 'init', '-q');
  const commit = async (files: Record<string, string | Buffer>, message: string, tag?: string) => {
    for (const [f, c] of Object.entries(files)) await writeFile(path.join(upstream, f), c);
    gitIn(upstream, 'add', '-A');
    gitIn(upstream, 'commit', '-q', '-m', message);
    if (tag) gitIn(upstream, 'tag', tag);
    return gitIn(upstream, 'rev-parse', 'HEAD').trim();
  };
  await commit({ 'content/guide.md': GUIDE, 'content/deploy.md': OTHER, 'logo.png': LOGO, 'README.md': 'upstream\n' }, 'release', 'v1.0.0');
  const base = await commit({ 'README.md': 'upstream, between releases\n' }, 'docs on main');

  // The fork: a checkout of upstream at `base`, translated, with its graft in the same repo.
  const fork = path.join(root, 'fork');
  gitIn(root, 'clone', '-q', upstream, fork);
  gitIn(fork, 'checkout', '-q', '-b', 'turkish-doc', base);
  await writeFile(path.join(fork, 'content/guide.md'), GUIDE.replace('Components are the building blocks of the app.', 'Bileşenler uygulamanın yapı taşlarıdır.').replace('Templates bind data to the view.', 'Şablonlar veriyi görünüme bağlar.'));
  await writeFile(path.join(fork, 'content/deploy.md'), OTHER.replace('Build the app before you deploy it.', 'Yayınlamadan önce uygulamayı derleyin.'));
  await writeFile(path.join(fork, 'logo.png'), LOGO_TR);
  await mkdir(path.join(fork, 'tools'));
  await writeFile(path.join(fork, 'tools/check.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const g = path.join(fork, '.grafts/tr');
  await mkdir(path.join(g, 'variants'), { recursive: true });
  await writeFile(path.join(fork, '.gitignore'), '.grafts/.cache/\n.grafts/.report/\n');
  await writeFile(path.join(g, 'variants/v1.json'), JSON.stringify({ ref: 'turkish-doc', base }));
  await writeFile(
    path.join(g, 'graft.md'),
    `---\nid: tr\nrootstock: { package: docs, verified: 1.0.0 }\nmechanism: fork\nfork: ${JSON.stringify({ repo: '.', upstream: `file://${upstream}`, install: 'none' })}\nvariants:\n  - range: ">=1.0.0"\n    module: ./variants/v1.json\noracle: { command: "! grep -rqw -e the -e The content" }\n---\n## Why\nTurkish docs.\n## Invariants\n- No English prose.\n## Where to look\ncontent/\n## Anchors\nEvery translated paragraph.\n## History\n- created\n`,
  );
  gitIn(fork, 'add', '-A');
  gitIn(fork, 'commit', '-q', '-m', 'translate');

  // Upstream releases after the fork's base.
  await commit({ 'README.md': 'upstream 1.0.1\n' }, 'readme only', 'v1.0.1');
  await commit({ 'content/deploy.md': `${OTHER}\nThe new flag writes the output to a different folder.\n` }, 'english appended after untranslated context', 'v1.1.0');
  await commit({ 'content/guide.md': GUIDE.replace('Templates bind data to the view.', 'Templates bind data and events to the view.') }, 'edit a translated sentence', 'v1.2.0');

  const project = await Project.open({ root: fork, adapters: [forkAdapter] });
  return { root, upstream, fork, base, project, graft: await project.get('tr') };
}

beforeEach(() => resetFetchCache());

describe('fork repo mode (install: none)', () => {
  it('is standalone: its current version is the verified one, and anchors (text and binary) come from the fork in its own repo', async () => {
    const { project, graft } = await setup();
    expect(project.isStandalone(graft)).toBe(true);
    expect(await project.currentVersion(graft)).toBe('1.0.0');
    const r = await forkAdapter.checkAnchors(project.context(graft), '1.0.1');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const names = r.anchors.map((a) => a.name);
    expect(names).toContain('logo.png#binary');
    expect(names.some((n) => n.startsWith('content/guide.md#'))).toBe(true);
    expect(names.some((n) => n.startsWith('.grafts'))).toBe(false); // the fork's own graft files are not part of the change

    const at12 = await forkAdapter.checkAnchors(project.context(graft), '1.2.0');
    expect(at12.ok).toBe(false);
    expect(at12.anchors.filter((a) => !a.matched).map((a) => a.file)).toEqual(['content/guide.md']);
  });

  it('syncs green without installing anything and keeps the rebased result as a local branch', async () => {
    const { project, fork } = await setup();
    const report = await sync(project, { version: '1.0.1' });
    expect(report.exitCode, JSON.stringify(report.grafts)).toBe(0);
    expect(report.targets[0]).toMatchObject({ package: 'docs', version: '1.0.1', standalone: true });
    expect(report.targets[0]?.installCommand).toBeUndefined();
    const g = report.grafts[0]!;
    expect(g.outcome).toBe('green');
    expect(g.oracle?.workspace).toContain('graft/tr/1.0.1');

    const cache = path.join(fork, '.grafts/.cache/fork/tr');
    const branch = 'graft/tr/1.0.1';
    expect(gitIn(cache, 'show', `${branch}:content/guide.md`)).toContain('Bileşenler');
    expect(gitIn(cache, 'show', `${branch}:README.md`)).toBe('upstream 1.0.1\n');
    expect(execFileSync('git', ['show', `${branch}:logo.png`], { cwd: cache })).toEqual(LOGO_TR);
    expect(gitIn(cache, 'rev-parse', `${branch}^`).trim()).toBe(gitIn(cache, 'rev-parse', 'v1.0.1^{commit}').trim());
    expect(gitIn(cache, 'ls-tree', '-r', '--name-only', branch)).not.toContain('.grafts');
    expect(gitIn(cache, 'ls-tree', branch, 'tools/check.sh')).toMatch(/^100755 /); // executable bit carried over
    // Nothing but the fork's change and the new release differ from the fork itself.
    expect(gitIn(cache, 'diff', '--name-only', branch, 'fork/turkish-doc', '--', '.', ':(exclude).grafts', ':(exclude).gitignore').trim()).toBe('README.md');

    expect(await readFile(path.join(fork, '.grafts/tr/graft.md'), 'utf8')).toMatch(/verified: 1\.0\.1/);
    expect(await readFile(report.reportFiles!.markdown, 'utf8')).toContain('Materialized results');
  });

  it('defaults to re-verifying the verified version, and `verify` runs the oracle in the workspace', async () => {
    const { project, graft } = await setup();
    const report = await sync(project);
    expect(report.targets[0]?.version).toBe('1.0.0');
    expect(report.exitCode).toBe(0);
    const oracle = await runOracle(project, graft);
    expect(oracle.passed).toBe(true);
    expect(oracle.workspace).toContain('graft/tr/1.0.0');
  });

  it('catches upstream English that applies cleanly, through the oracle', async () => {
    const { project } = await setup();
    const report = await sync(project, { version: '1.1.0' });
    expect(report.exitCode).toBe(1);
    const g = report.grafts[0]!;
    expect(g.outcome).toBe('needs-agent');
    expect(g.anchors?.ok).toBe(true); // the change still rebases...
    expect(g.reasons.join('\n')).toMatch(/oracle failed/); // ...but the result is not Turkish
  });

  it('hands a conflicting upstream edit to an agent with the scoped upstream diff', async () => {
    const { project } = await setup();
    const report = await sync(project, { version: '1.2.0' });
    expect(report.exitCode).toBe(1);
    const g = report.grafts[0]!;
    expect(g.outcome).toBe('needs-agent');
    const patch = await readFile(g.diffPath!, 'utf8');
    expect(patch).toContain('+Templates bind data and events to the view.');
  });

  it('treats upstream lines added right against a change at the end of a file as a conflict (like git)', async () => {
    const { project, graft, upstream } = await setup();
    // guide.md's translated last line had no trailing context; upstream appends a section.
    await writeFile(path.join(upstream, 'content/guide.md'), `${GUIDE}\n## Policies\n\nThe team decides.\n`);
    gitIn(upstream, 'commit', '-q', '-am', 'append');
    gitIn(upstream, 'tag', 'v1.4.0');
    const r = await forkAdapter.checkAnchors(project.context(graft), '1.4.0');
    expect(r.ok).toBe(false);
    expect(r.anchors.filter((a) => !a.matched)).toEqual([expect.objectContaining({ file: 'content/guide.md', error: 'upstream added lines right after the change' })]);
  });

  it('a binary file changed upstream since the base does not carry over silently', async () => {
    const { project, graft, upstream } = await setup();
    await writeFile(path.join(upstream, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 7, 7, 7, 0, 4]));
    gitIn(upstream, 'commit', '-q', '-am', 'new logo');
    gitIn(upstream, 'tag', 'v1.3.0');
    const r = await forkAdapter.checkAnchors(project.context(graft), '1.3.0');
    expect(r.anchors.find((a) => a.name === 'logo.png#binary')).toMatchObject({ matched: false, error: 'binary file changed upstream since the base' });
  });

  it('accepts a commit as base only in repo mode', async () => {
    const { project, fork } = await setup();
    const md = path.join(fork, '.grafts/tr/graft.md');
    await writeFile(md, (await readFile(md, 'utf8')).replace(',"install":"none"', ''));
    const graft = await project.get('tr');
    const r = await forkAdapter.checkAnchors(project.context(graft), '1.0.1');
    expect(r.errors[0]).toMatch(/must give "base", the upstream version the fork/);
  });
});
