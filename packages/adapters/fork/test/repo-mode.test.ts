// Repo mode (`fork.install: none`): a fork that is the product itself, shaped like a translated
// docs site (e.g. erkamyaman/angular-tr). The graft lives in the fork's own checkout, its base
// is an upstream commit between releases. Sync checks that the translation still fits; whether
// the result is all Turkish is the agent's to verify.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { addGraft, outdated, Project, sync } from '@graftsync/core';
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

async function setup(opts: { inPlace?: boolean; track?: string } = {}) {
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
  // inPlace: one permanent variant, "this checkout vs. the upstream it last verified".
  await writeFile(path.join(g, 'variants/v1.json'), JSON.stringify(opts.inPlace ? { ref: '@worktree', base: '@verified' } : { ref: 'turkish-doc', base }));
  const verified = opts.inPlace ? `1.0.0+${base.slice(0, 12)}` : '1.0.0';
  const forkCfg = { repo: '.', upstream: `file://${upstream}`, install: 'none', ...(opts.track ? { track: opts.track } : {}) };
  await writeFile(
    path.join(g, 'graft.md'),
    `---\nid: tr\nrootstock: { package: docs, verified: ${verified} }\nmechanism: fork\nfork: ${JSON.stringify(forkCfg)}\nvariants:\n  - range: ">=1.0.0"\n    module: ./variants/v1.json\n---\n## Why\nTurkish docs.\n## Invariants\n- No English prose.\n## Where to look\ncontent/\n## Anchors\nEvery translated paragraph.\n## History\n- created\n`,
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
    expect(g.materialized?.description).toContain('graft/tr/1.0.1');

    const cache = path.join(fork, '.grafts/.cache/fork/tr');
    const branch = 'graft/tr/1.0.1';
    expect(gitIn(cache, 'show', `${branch}:content/guide.md`)).toContain('Bileşenler');
    expect(gitIn(cache, 'show', `${branch}:README.md`)).toBe('upstream 1.0.1\n');
    expect(execFileSync('git', ['show', `${branch}:logo.png`], { cwd: cache })).toEqual(LOGO_TR);
    expect(gitIn(cache, 'rev-parse', `${branch}^`).trim()).toBe(gitIn(cache, 'rev-parse', 'v1.0.1^{commit}').trim());
    // The graft lives in the fork (repo: .): the result carries its files, with the new verification.
    expect(gitIn(cache, 'show', `${branch}:.grafts/tr/graft.md`)).toMatch(/verified: 1\.0\.1/);
    expect(gitIn(cache, 'ls-tree', '-r', '--name-only', branch)).not.toMatch(/\.grafts\/\.(cache|report)\//);
    expect(gitIn(cache, 'ls-tree', branch, 'tools/check.sh')).toMatch(/^100755 /); // executable bit carried over
    // Nothing but the fork's change and the new release differ from the fork itself.
    expect(gitIn(cache, 'diff', '--name-only', branch, 'fork/turkish-doc', '--', '.', ':(exclude).grafts', ':(exclude).gitignore').trim()).toBe('README.md');

    expect(await readFile(path.join(fork, '.grafts/tr/graft.md'), 'utf8')).toMatch(/verified: 1\.0\.1/);
    expect(await readFile(report.reportFiles!.markdown, 'utf8')).toContain('Materialized results');
  });

  it('defaults to re-verifying the verified version', async () => {
    const { project } = await setup();
    const report = await sync(project);
    expect(report.targets[0]?.version).toBe('1.0.0');
    expect(report.exitCode).toBe(0);
    expect(report.grafts[0]?.materialized?.description).toContain('graft/tr/1.0.0');
  });

  it('is green when the change still fits, even if upstream English merged in (behavior is for the agent to check)', async () => {
    const { project, fork } = await setup();
    const report = await sync(project, { version: '1.1.0' });
    expect(report.exitCode, JSON.stringify(report.grafts)).toBe(0);
    const cache = path.join(fork, '.grafts/.cache/fork/tr');
    // The result carries upstream's new English paragraph next to the translation.
    expect(gitIn(cache, 'show', 'graft/tr/1.1.0:content/deploy.md')).toContain('The new flag writes the output to a different folder.');
  });

  it('hands a conflicting upstream edit to an agent with the scoped upstream diff', async () => {
    const { project, fork } = await setup();
    const report = await sync(project, { version: '1.2.0' });
    expect(report.exitCode).toBe(1);
    const g = report.grafts[0]!;
    expect(g.outcome).toBe('needs-agent');
    const patch = await readFile(g.diffPath!, 'utf8');
    expect(patch).toContain('+Templates bind data and events to the view.');
    // The agent starts from git's merge of the translation onto the new tag, markers in place.
    expect(g.agentStart?.description).toMatch(/graft\/tr\/1\.2\.0-agent.*conflict markers in 1 file\(s\): content\/guide\.md/);
    expect(g.agentStart).toMatchObject({ ref: 'graft/tr/1.2.0-agent', conflicts: ['content/guide.md'] });
    const cache = path.join(fork, '.grafts/.cache/fork/tr');
    const merged = gitIn(cache, 'show', 'graft/tr/1.2.0-agent:content/guide.md');
    expect(merged).toContain('<<<<<<<');
    expect(merged).toContain('Templates bind data and events to the view.');
    expect(merged).toContain('Şablonlar veriyi görünüme bağlar.');
    expect(gitIn(cache, 'show', 'graft/tr/1.2.0-agent:content/deploy.md')).toContain('Yayınlamadan'); // clean files are merged
    expect(gitIn(cache, 'rev-parse', 'graft/tr/1.2.0-agent^').trim()).toBe(gitIn(cache, 'rev-parse', 'v1.2.0^{commit}').trim());
  });

  it('syncs to an upstream commit between releases, named by semver build metadata', async () => {
    const { project, fork, upstream } = await setup();
    gitIn(upstream, 'checkout', '-q', 'v1.0.1');
    await writeFile(path.join(upstream, 'README.md'), 'upstream main after 1.0.1\n');
    gitIn(upstream, 'commit', '-q', '-am', 'main moves on');
    const sha = gitIn(upstream, 'rev-parse', 'HEAD').trim().slice(0, 12);
    gitIn(upstream, 'branch', '-f', 'main', 'HEAD');
    gitIn(upstream, 'checkout', '-q', 'main');
    const version = `1.0.1+${sha}`;
    const report = await sync(project, { version });
    expect(report.exitCode, JSON.stringify(report.grafts)).toBe(0);
    const cache = path.join(fork, '.grafts/.cache/fork/tr');
    const branch = `graft/tr/${version}`;
    expect(gitIn(cache, 'rev-parse', `${branch}^`).trim().startsWith(sha)).toBe(true);
    expect(gitIn(cache, 'show', `${branch}:README.md`)).toBe('upstream main after 1.0.1\n');
    expect(await readFile(path.join(fork, '.grafts/tr/graft.md'), 'utf8')).toContain(`verified: ${version}`);
    expect((await sync(project, { version: '1.0.1+deadbeef00' })).grafts[0]?.reasons.join('\n')).toMatch(/upstream commit deadbeef00 .* not found/);
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

describe('fork repo mode, in place (@worktree / @verified)', () => {
  // Adopt a result the way the docs and the Action do: a merge of the upstream commit it sits on,
  // with the result's tree. `commit: false` leaves the merge open (an agent resolves first).
  const adopt = (fork: string, start: { ref?: string; upstream?: string } | undefined, opts: { commit?: boolean } = {}) => {
    expect(start?.upstream).toMatch(/^[0-9a-f]{40}$/);
    gitIn(fork, 'fetch', '-q', '.grafts/.cache/fork/tr', start!.ref!);
    gitIn(fork, 'merge', '-q', '--no-ff', '--no-commit', '-s', 'ours', '--allow-unrelated-histories', start!.upstream!);
    gitIn(fork, 'read-tree', '-u', '--reset', 'FETCH_HEAD');
    if (opts.commit !== false) gitIn(fork, 'commit', '-q', '-m', `adopt ${start!.ref}`);
  };
  const parents = (dir: string, rev = 'HEAD') => gitIn(dir, 'rev-list', '--parents', '-n1', rev).trim().split(' ').slice(1);

  it('records a green sync in the result, not the checkout; adopting it moves the fork forward', async () => {
    const { project, fork } = await setup({ inPlace: true });
    const before = await readFile(path.join(fork, '.grafts/tr/graft.md'), 'utf8');
    const report = await sync(project, { version: '1.0.1' });
    expect(report.exitCode, JSON.stringify(report.grafts)).toBe(0);
    expect(report.grafts[0]).toMatchObject({ outcome: 'green', recordedInResult: true });
    const v101 = gitIn(path.join(fork, '.grafts/.cache/fork/tr'), 'rev-parse', 'v1.0.1^{commit}').trim();
    // The result sits on upstream 1.0.1, and the report names that commit for the adoption.
    expect(report.grafts[0]?.materialized?.fetch).toEqual({ repo: '.grafts/.cache/fork/tr', ref: 'graft/tr/1.0.1', upstream: v101 });
    expect(report.grafts[0]?.materialized?.description).toContain(`git merge --no-ff --no-commit -s ours --allow-unrelated-histories ${v101} && git read-tree -u --reset FETCH_HEAD`);
    // The checkout still is the fork at its old base, and says so.
    expect(await readFile(path.join(fork, '.grafts/tr/graft.md'), 'utf8')).toBe(before);
    const forkHead = gitIn(fork, 'rev-parse', 'HEAD').trim();
    adopt(fork, report.grafts[0]?.materialized?.fetch);
    expect(await readFile(path.join(fork, '.grafts/tr/graft.md'), 'utf8')).toMatch(/verified: 1\.0\.1/);
    expect(await readFile(path.join(fork, 'README.md'), 'utf8')).toBe('upstream 1.0.1\n');
    // A merge: the fork keeps its own history and now has upstream 1.0.1 in it too (#22).
    expect(parents(fork)).toEqual([forkHead, v101]);
    expect(gitIn(fork, 'rev-parse', 'HEAD^{tree}').trim()).toBe(gitIn(fork, 'rev-parse', 'FETCH_HEAD^{tree}').trim());
    expect(gitIn(fork, 'merge-base', 'HEAD', v101).trim()).toBe(v101);
    // The same permanent variant now describes the adopted fork: re-verifying is green.
    const again = await sync(await Project.open({ root: fork, adapters: [forkAdapter] }));
    expect(again.targets[0]?.version).toBe('1.0.1');
    expect(again.exitCode, JSON.stringify(again.grafts)).toBe(0);
  });

  it('includes uncommitted work in the change', async () => {
    const { project, fork, graft } = await setup({ inPlace: true });
    await writeFile(path.join(fork, 'content/new.md'), '# Yeni sayfa\n');
    const r = await forkAdapter.checkAnchors(project.context(graft), '1.0.1');
    expect(r.anchors.map((a) => a.name)).toContain('content/new.md#create');
  });

  it('a conflict leaves a branch that verifies in place once the agent resolves it', async () => {
    const { project, fork } = await setup({ inPlace: true });
    const report = await sync(project, { version: '1.2.0' });
    expect(report.exitCode).toBe(1);
    const v120 = gitIn(path.join(fork, '.grafts/.cache/fork/tr'), 'rev-parse', 'v1.2.0^{commit}').trim();
    expect(report.grafts[0]?.agentStart).toMatchObject({ ref: 'graft/tr/1.2.0-agent', conflicts: ['content/guide.md'], upstream: v120 });
    expect(report.grafts[0]?.agentStart?.description).toContain(`--allow-unrelated-histories ${v120} && git read-tree -u --reset FETCH_HEAD`);
    const forkHead = gitIn(fork, 'rev-parse', 'HEAD').trim();
    adopt(fork, report.grafts[0]?.agentStart, { commit: false });
    const md = await readFile(path.join(fork, '.grafts/tr/graft.md'), 'utf8');
    expect(md).toMatch(/verified: 1\.2\.0/);
    expect(md).toMatch(/status: conflicted/);
    // The "agent": resolve the markers by translating upstream's new sentence.
    const guide = await readFile(path.join(fork, 'content/guide.md'), 'utf8');
    await writeFile(path.join(fork, 'content/guide.md'), guide.replace(/<<<<<<<[^]*?>>>>>>>[^\n]*\n/, 'Şablonlar veriyi ve olayları görünüme bağlar.\n'));
    // Upstream English that merged cleanly (from 1.1.0) is not a conflict; the agent translates it too.
    const deploy = await readFile(path.join(fork, 'content/deploy.md'), 'utf8');
    await writeFile(path.join(fork, 'content/deploy.md'), deploy.replace('The new flag writes the output to a different folder.', 'Yeni bayrak çıktıyı farklı bir klasöre yazar.'));
    const fixed = await sync(await Project.open({ root: fork, adapters: [forkAdapter] }));
    expect(fixed.targets[0]?.version).toBe('1.2.0');
    expect(fixed.exitCode, JSON.stringify(fixed.grafts)).toBe(0);
    const cache = path.join(fork, '.grafts/.cache/fork/tr');
    expect(gitIn(cache, 'show', 'graft/tr/1.2.0:.grafts/tr/graft.md')).toMatch(/status: applied/);
    expect(gitIn(cache, 'show', 'graft/tr/1.2.0:content/guide.md')).toContain('olayları');
    // Committing the resolved work concludes the merge begun on adoption.
    gitIn(fork, 'add', '-A');
    gitIn(fork, 'commit', '-q', '-m', 'sync upstream 1.2.0');
    expect(parents(fork)).toEqual([forkHead, v120]);
  });

  it('refuses a fork checkout that is a partial clone, saying so instead of git\'s "corruption" error (#23)', async () => {
    const { root, fork } = await setup({ inPlace: true });
    gitIn(fork, 'config', 'uploadpack.allowFilter', 'true');
    const partial = path.join(root, 'partial');
    gitIn(root, 'clone', '-q', '--filter=blob:none', '--branch', 'turkish-doc', `file://${fork}`, partial);
    expect(gitIn(partial, 'config', '--get', 'remote.origin.promisor').trim()).toBe('true');
    const project = await Project.open({ root: partial, adapters: [forkAdapter] });
    const report = await sync(project, { version: '1.0.1' });
    expect(report.exitCode).not.toBe(0);
    expect(report.grafts[0]?.outcome).not.toBe('green');
    const reasons = report.grafts[0]!.reasons.join('\n');
    expect(reasons).toMatch(/the fork repository .*partial is a partial clone \(--filter=blob:none\)/);
    expect(reasons).toMatch(/Use a full clone \(a shallow one is fine\)/);
    expect(reasons).not.toMatch(/corruption/);
  });

  it('a shallow fork checkout still syncs', async () => {
    const { root, fork } = await setup({ inPlace: true });
    const shallow = path.join(root, 'shallow');
    gitIn(root, 'clone', '-q', '--depth=1', '--branch', 'turkish-doc', `file://${fork}`, shallow);
    const report = await sync(await Project.open({ root: shallow, adapters: [forkAdapter] }), { version: '1.0.1' });
    expect(report.exitCode, JSON.stringify(report.grafts)).toBe(0);
  });

  it('outdated offers the newest upstream tag, or the tip of a tracked branch', async () => {
    const tags = await setup({ inPlace: true });
    expect((await outdated(tags.project)).find((e) => e.standalone)).toMatchObject({ grafts: ['tr'], candidate: { version: '1.2.0', tag: 'v1.2.0' } });
    const tracked = await setup({ inPlace: true, track: 'main' });
    const tip = gitIn(tracked.upstream, 'rev-parse', 'main').trim();
    expect((await outdated(tracked.project))[0]?.candidate).toEqual({ version: `1.2.0+${tip.slice(0, 12)}`, tag: 'branch main' });
  });
});

describe('graft add for repo mode', () => {
  it('scaffolds an in-place graft from inside the fork that is valid and syncs as is', async () => {
    const { fork, upstream, base } = await setup({ inPlace: true });
    await rm(path.join(fork, '.grafts/tr'), { recursive: true });
    gitIn(fork, 'remote', 'add', 'upstream', `file://${upstream}`);
    const project = await Project.open({ root: fork, adapters: [forkAdapter] });
    const version = `1.0.0+${base.slice(0, 12)}`;
    await addGraft(project, { id: 'tr2', package: 'docs', version, mechanism: 'fork', options: { inPlace: true } });

    const md = await readFile(path.join(fork, '.grafts/tr2/graft.md'), 'utf8');
    expect(md).toContain('repo: .');
    expect(md).toContain(`upstream: file://${upstream}`); // from the checkout's upstream remote
    expect(md).toContain('install: none');
    expect(md).not.toContain('oracle');
    expect(md).toContain(`verified: ${version}`);
    expect(JSON.parse(await readFile(path.join(fork, '.grafts/tr2/variants/v1.json'), 'utf8'))).toEqual({ ref: '@worktree', base: '@verified' });
    const { invalid } = await project.loadAll();
    expect(invalid).toEqual([]);

    const report = await sync(project);
    expect(report.exitCode, JSON.stringify(report.grafts)).toBe(0);
  });

  it('repo mode without in place keeps the fork and variant to fill in', async () => {
    const { fork } = await setup();
    const project = await Project.open({ root: fork, adapters: [forkAdapter] });
    await addGraft(project, { id: 'other', package: 'tool', version: '2.0.0', mechanism: 'fork', options: { repoMode: true, upstream: 'https://example.com/tool.git', track: 'main' } });
    const md = await readFile(path.join(fork, '.grafts/other/graft.md'), 'utf8');
    expect(md).toMatch(/repo: "?TODO/);
    expect(md).toContain('upstream: https://example.com/tool.git');
    expect(md).toContain('track: main');
    expect(md).toContain('install: none');
  });
});
