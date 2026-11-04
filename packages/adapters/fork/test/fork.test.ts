import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { addGraft, DirectoryUpstreamSource, Project, sync } from '@graftsync/core';
import { tarballContents } from '@graftsync/adapter-patch';
import { forkAdapter, resetFetchCache } from '../src/index.js';

const V1 = 'const a = 1\nconst b = 2\nmodule.exports = { a, b }\n';
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });

/** Upstream repo with tags v1.0.0..v3.0.0 and a fork with the change on branch graft-1.x. */
async function repos(opts: { forkChange?: (code: string) => string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-fork-'));
  const upstream = path.join(root, 'upstream');
  await mkdir(upstream);
  gitIn(upstream, 'init', '-q');
  const release = async (version: string, code: string) => {
    await writeFile(path.join(upstream, 'index.js'), code);
    await writeFile(path.join(upstream, 'package.json'), JSON.stringify({ name: 'lib', version }, null, 2));
    gitIn(upstream, 'add', '-A');
    gitIn(upstream, 'commit', '-q', '-m', `release ${version}`);
    gitIn(upstream, 'tag', `v${version}`);
  };
  await release('1.0.0', V1);
  await release('1.1.0', `// moved down one line\n${V1}`);
  await release('2.0.0', 'const a = 1\nmodule.exports = { a }\n');
  await release('3.0.0', 'const a = 1\nconst b = 2\nconst c = 3\nmodule.exports = { a, b }\n');

  const fork = path.join(root, 'fork');
  gitIn(root, 'clone', '-q', upstream, fork);
  gitIn(fork, 'checkout', '-q', '-b', 'graft-1.x', 'v1.0.0');
  const change = opts.forkChange ?? ((c: string) => c.replace('const b = 2\n', 'const b = 2\nconst c = 3\n'));
  await writeFile(path.join(fork, 'index.js'), change(V1));
  gitIn(fork, 'commit', '-q', '-am', 'add c');
  return { root, upstream, fork };
}

async function setup(opts: { tag?: string; build?: string; ref?: string } = {}) {
  const r = await repos();
  const app = path.join(r.root, 'app');
  const g = path.join(app, '.grafts/add-c');
  await mkdir(path.join(g, 'variants'), { recursive: true });
  await writeFile(path.join(g, 'variants/v1.json'), JSON.stringify({ ref: opts.ref ?? 'graft-1.x', base: '1.0.0' }));
  const fork = { repo: `file://${r.fork}`, upstream: `file://${r.upstream}`, tag: opts.tag ?? 'v{version}', ...(opts.build ? { build: opts.build } : {}) };
  await writeFile(
    path.join(g, 'graft.md'),
    `---\nid: add-c\nrootstock: { package: lib, verified: 1.0.0 }\nmechanism: fork\nfork: ${JSON.stringify(fork)}\nvariants:\n  - range: ">=1.0.0"\n    module: ./variants/v1.json\n---\n## Why\nAdds c.\n## Invariants\n- c is 3\n## Where to look\nThe constants.\n## Anchors\nThe const block.\n## History\n- created\n`,
  );
  await writeFile(path.join(app, 'package.json'), `${JSON.stringify({ name: 'app', packageManager: 'npm@10.9.9', dependencies: { lib: '1.0.0' } }, null, 2)}\n`);
  const installed = path.join(app, 'node_modules/lib');
  await mkdir(installed, { recursive: true });
  await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));
  await writeFile(path.join(installed, 'index.js'), V1);
  const upstreamSource = new DirectoryUpstreamSource({ lib: { '1.0.0': installed } }, { lib: '1.0.0' });
  const p = await Project.open({ root: app, adapters: [forkAdapter], upstream: upstreamSource });
  return { ...r, app, g, project: p, graft: await p.get('add-c') };
}

beforeEach(() => resetFetchCache());

describe('fork mechanism: anchors against upstream source tags', () => {
  it("locates the fork's hunks in later tags, and fails loudly where they no longer fit", async () => {
    const { project, graft } = await setup();
    const ctx = project.context(graft);
    const at11 = await forkAdapter.checkAnchors(ctx, '1.1.0');
    expect(at11.ok, JSON.stringify(at11)).toBe(true);
    expect(at11.anchors[0]).toMatchObject({ name: 'index.js#1', matched: true, location: { line: 2 } });
    const at2 = await forkAdapter.checkAnchors(ctx, '2.0.0');
    expect(at2.ok).toBe(false);
    expect(at2.anchors[0]).toMatchObject({ matched: false, error: 'context or removed lines not found' });
    expect(at2.upstreamed).toBeUndefined();
  });

  it('flags a tag that already contains the change as likely upstreamed', async () => {
    const { project, graft } = await setup();
    const at3 = await forkAdapter.checkAnchors(project.context(graft), '3.0.0');
    expect(at3.ok).toBe(false);
    expect(at3.upstreamed?.evidence[0]).toMatch(/v3\.0\.0 already contains the fork's change/);
  });

  it('reports missing tags (with a hint), unknown refs, and forks with no changes', async () => {
    const noV = await setup({ tag: 'v{version}' });
    expect((await forkAdapter.checkAnchors(noV.project.context(noV.graft), '9.9.9')).errors[0]).toMatch(/tag "v9\.9\.9" not found/);
    const bare = await setup({ tag: '{version}' });
    expect((await forkAdapter.checkAnchors(bare.project.context(bare.graft), '1.1.0')).errors[0]).toMatch(/tag "1\.0\.0" not found/);
    const badRef = await setup({ ref: 'nope' });
    expect((await forkAdapter.checkAnchors(badRef.project.context(badRef.graft), '1.1.0')).errors[0]).toMatch(/fork ref "nope" not found/);
    const empty = await setup({ ref: 'v1.0.0' });
    expect((await forkAdapter.checkAnchors(empty.project.context(empty.graft), '1.1.0')).errors[0]).toMatch(/has no changes on top of v1\.0\.0/);
  });
});

describe('fork mechanism: rebase, build, pack and install', () => {
  it('previews the rebased files', async () => {
    const { project, graft, root } = await setup();
    const out = path.join(root, 'preview');
    const r = await forkAdapter.apply(project.context(graft), { version: '1.1.0', outDir: out });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await readFile(path.join(out, 'index.js'), 'utf8')).toBe(`// moved down one line\n${V1.replace('const b = 2\n', 'const b = 2\nconst c = 3\n')}`);
  });

  it('packs the rebased fork into a vendored tarball and points npm at it', async () => {
    const { project, graft, app } = await setup({ build: `node -e "require('fs').writeFileSync('BUILT.txt', 'yes')"` });
    const r = await forkAdapter.beforeInstall!(project.context(graft), '1.1.0');
    expect(r).toEqual({ install: 'reinstall' });
    const tarball = path.join(app, '.grafts/.vendor/lib-1.1.0.tgz');
    const contents = await tarballContents(tarball);
    expect(contents.get('package/index.js')!.toString()).toContain('const c = 3');
    expect(contents.get('package/index.js')!.toString()).toContain('// moved down one line');
    expect(contents.get('package/BUILT.txt')!.toString()).toBe('yes');
    expect(JSON.parse(contents.get('package/package.json')!.toString()).version).toBe('1.1.0');
    const manifest = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'));
    expect(manifest.dependencies.lib).toBe('file:.grafts/.vendor/lib-1.1.0.tgz');
    expect(manifest.overrides).toEqual({ lib: '$lib' });

    // Upgrading replaces the tarball.
    await forkAdapter.beforeInstall!(project.context(graft), '1.0.0');
    expect(await readdir(path.join(app, '.grafts/.vendor'))).toEqual(['lib-1.0.0.tgz']);
  });

  it('fails loudly when the build fails or the tag packs as a different version', async () => {
    const failing = await setup({ build: 'node -e "process.exit(3)"' });
    await expect(forkAdapter.beforeInstall!(failing.project.context(failing.graft), '1.1.0')).rejects.toThrow(/fork build .* failed \(exit 3\)/);
    const conflict = await setup();
    await expect(forkAdapter.beforeInstall!(conflict.project.context(conflict.graft), '2.0.0')).rejects.toThrow(/does not rebase onto v2\.0\.0/);
  });

  it('at the installed version, checks the vendored build and the installed files', async () => {
    const { project, graft, app } = await setup();
    const ctx = project.context(graft);
    const before = await forkAdapter.checkAnchors(ctx, '1.0.0');
    expect(before.errors.join('\n')).toMatch(/lib-1\.0\.0\.tgz is missing/);
    await forkAdapter.beforeInstall!(ctx, '1.0.0');
    const after = await forkAdapter.checkAnchors(ctx, '1.0.0');
    // Configured, but node_modules still holds the pristine copy.
    expect(after.errors.join('\n')).toMatch(/installed lib@1\.0\.0 index\.js is not the vendored fork build/);
    await writeFile(path.join(app, 'node_modules/lib/index.js'), V1.replace('const b = 2\n', 'const b = 2\nconst c = 3\n'));
    expect((await forkAdapter.checkAnchors(ctx, '1.0.0')).ok).toBe(true);
  });
});

describe('fork mechanism: sync, scoped diffs, validation', () => {
  it('hands a conflicting upstream release to an agent with the scoped upstream git diff', async () => {
    const { project } = await setup();
    const report = await sync(project, { version: '2.0.0', install: true });
    expect(report.exitCode).toBe(1);
    expect(report.targets[0]?.installCommand).toBeUndefined(); // nothing installed
    const g = report.grafts[0]!;
    expect(g.outcome).toBe('needs-agent');
    const patch = await readFile(g.diffPath!, 'utf8');
    expect(patch).toContain('-const b = 2');
    expect(patch).toContain('lib@2.0.0 (v2.0.0)');
  });

  it('requires a fork block, and scaffolds one with a JSON variant', async () => {
    const { app, g, project } = await setup();
    const md = (await readFile(path.join(g, 'graft.md'), 'utf8')).replace(/^fork: .*\n/m, '');
    await writeFile(path.join(g, 'graft.md'), md);
    const { invalid } = await project.loadAll();
    expect(invalid[0]?.diagnostics.map((d) => d.code)).toContain('frontmatter/fork-missing');

    const files = await addGraft(project, { id: 'other', package: 'other-lib', version: '2.1.0', mechanism: 'fork' });
    expect(files.some((f) => f.endsWith(path.join('variants', 'v2.json')))).toBe(true);
    const scaffolded = await readFile(path.join(app, '.grafts/other/graft.md'), 'utf8');
    expect(scaffolded).toMatch(/fork:\n {2}repo: "?TODO/);
    expect(existsSync(path.join(app, '.grafts/other/variants/v2.json'))).toBe(true);
  });
});
