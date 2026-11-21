import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DirectoryUpstreamSource, Project, sync, WorkspaceSnapshot, type GraftContext, type MechanismAdapter } from '../src/index.js';

describe('WorkspaceSnapshot', () => {
  it('restores modified/deleted files, removes newly created files, and reconciles captured directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-snap-'));
    const existing = path.join(root, 'package.json');
    const deleted = path.join(root, 'pnpm-lock.yaml');
    const created = path.join(root, 'pnpm-workspace.yaml');
    const untouched = path.join(root, 'untouched.json');
    const vendorDir = path.join(root, '.grafts/.vendor');
    const patchPkgDir = path.join(root, '.grafts/.patch-package');

    await mkdir(vendorDir, { recursive: true });
    await writeFile(existing, '{"name":"app","version":"1.0.0"}\n');
    await writeFile(deleted, 'lockfileVersion: 9.0\n');
    await writeFile(untouched, '{"keep":true}\n');
    await writeFile(path.join(vendorDir, 'keep-1.0.0.tgz'), Buffer.from([1, 2, 3, 4]));

    const snap = new WorkspaceSnapshot();
    await snap.captureFiles([existing, deleted, created, untouched]);
    await snap.captureDir(vendorDir);
    await snap.captureDir(patchPkgDir);

    // Mutate everything except `untouched`.
    await writeFile(existing, '{"name":"app","version":"2.0.0"}\n');
    await rm(deleted);
    await writeFile(created, 'patchedDependencies:\n  lib: a.patch\n');
    await writeFile(path.join(vendorDir, 'keep-1.0.0.tgz'), Buffer.from([9, 9]));
    await writeFile(path.join(vendorDir, 'new-2.0.0.tgz'), Buffer.from([7, 7]));
    await mkdir(path.join(patchPkgDir, 'nested'), { recursive: true });
    await writeFile(path.join(patchPkgDir, 'nested/lib+2.0.0.patch'), 'diff\n');

    const restored = await snap.restore();
    expect(restored).not.toContain(untouched);
    expect(restored).toContain(existing);
    expect(restored).toContain(deleted);
    expect(restored).toContain(created);
    expect(restored).toContain(patchPkgDir);

    expect(await readFile(existing, 'utf8')).toBe('{"name":"app","version":"1.0.0"}\n');
    expect(await readFile(deleted, 'utf8')).toBe('lockfileVersion: 9.0\n');
    expect(existsSync(created)).toBe(false);
    expect(existsSync(patchPkgDir)).toBe(false);
    expect(await readFile(path.join(vendorDir, 'keep-1.0.0.tgz'))).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(existsSync(path.join(vendorDir, 'new-2.0.0.tgz'))).toBe(false);
  });
});

function makeAdapter(hooks: Partial<MechanismAdapter> = {}): MechanismAdapter {
  return {
    name: 'mock',
    variantExtension: '.txt',
    async checkAnchors({ graft }, version) {
      return {
        graft: graft.id,
        package: graft.frontmatter.rootstock.package,
        version: version ?? graft.frontmatter.rootstock.verified,
        variant: { range: '>=1.0.0', module: './variants/v1.txt', path: path.join(graft.dir, 'variants/v1.txt') },
        anchors: [{ name: 'a', file: 'index.js', matched: true }],
        errors: [],
        ok: true,
      };
    },
    async apply({ graft }, options) {
      return {
        graft: graft.id,
        version: options?.version ?? graft.frontmatter.rootstock.verified,
        variant: { range: '>=1.0.0', module: './variants/v1.txt', path: path.join(graft.dir, 'variants/v1.txt') },
        files: [{ file: 'index.js', changed: true }],
        errors: [],
        ok: true,
      };
    },
    async scopeDiff({ graft }, from, to) {
      return { graft: graft.id, package: graft.frontmatter.rootstock.package, from, to, files: [], patch: '' };
    },
    ...hooks,
  };
}

async function syncFixture(options: {
  config?: Record<string, unknown>;
  pnpmWorkspace?: string;
  packageJson?: Record<string, unknown>;
  adapter?: MechanismAdapter;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-sync-rollback-'));
  const v1 = path.join(root, 'upstream/lib-1.0.0');
  const v2 = path.join(root, 'upstream/lib-2.0.0');
  await mkdir(v1, { recursive: true });
  await mkdir(v2, { recursive: true });
  await writeFile(path.join(v1, 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));
  await writeFile(path.join(v2, 'package.json'), JSON.stringify({ name: 'lib', version: '2.0.0' }));

  const graftDir = path.join(root, '.grafts/tweak');
  await mkdir(path.join(graftDir, 'variants'), { recursive: true });
  await writeFile(path.join(graftDir, 'variants/v1.txt'), 'ok\n');
  await writeFile(
    path.join(graftDir, 'graft.md'),
    [
      '---',
      'id: tweak',
      'rootstock: { package: lib, verified: 1.0.0 }',
      'mechanism: mock',
      'variants:',
      '  - range: ">=1.0.0"',
      '    module: ./variants/v1.txt',
      '---',
      '## Why',
      'w',
      '## Invariants',
      'i',
      '## Where to look',
      'l',
      '## Anchors',
      'a',
      '## History',
      '- init',
      '',
    ].join('\n'),
  );
  if (options.config) await writeFile(path.join(root, '.grafts/config.json'), JSON.stringify(options.config));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify(options.packageJson ?? { name: 'app', dependencies: { lib: '1.0.0' } }, null, 2) + '\n',
  );
  if (options.pnpmWorkspace !== undefined) await writeFile(path.join(root, 'pnpm-workspace.yaml'), options.pnpmWorkspace);

  const upstream = new DirectoryUpstreamSource({ lib: { '1.0.0': v1, '2.0.0': v2 } }, { lib: '1.0.0' });
  const project = await Project.open({ root, adapters: [options.adapter ?? makeAdapter()], upstream });
  return { root, project, upstream };
}

describe('sync --install transactional rollback', () => {
  it('reverts beforeInstall config edits and newly created applier artifacts when install fails', async () => {
    const adapter = makeAdapter({
      async beforeInstall({ project }: GraftContext, version: string) {
        // Simulate an applier mutating pnpm-workspace.yaml, package.json, and creating .grafts/.patch-package.
        await writeFile(
          path.join(project.root, 'pnpm-workspace.yaml'),
          `patchedDependencies:\n  lib@${version}: .grafts/tweak/variants/v1.txt\n`,
        );
        await writeFile(
          path.join(project.root, 'package.json'),
          JSON.stringify({ name: 'app', dependencies: { lib: version } }, null, 2) + '\n',
        );
        await mkdir(path.join(project.root, '.grafts/.patch-package'), { recursive: true });
        await writeFile(path.join(project.root, '.grafts/.patch-package/lib+2.0.0.patch'), 'patch\n');
      },
    });
    const beforeWs = 'patchedDependencies:\n  lib@1.0.0: .grafts/tweak/variants/v1.txt\n';
    const { root, project } = await syncFixture({
      pnpmWorkspace: beforeWs,
      config: { upgrade: { lib: 'node -e "process.exit(5)" {version}' } },
      adapter,
    });
    const beforePkg = await readFile(path.join(root, 'package.json'), 'utf8');

    const report = await sync(project, { version: '2.0.0', install: true, writeReport: false });
    expect(report.exitCode).toBe(2);
    expect(report.grafts[0]?.outcome).toBe('error');
    // Every mutation made by beforeInstall is rolled back verbatim.
    expect(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(beforeWs);
    expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe(beforePkg);
    expect(existsSync(path.join(root, '.grafts/.patch-package'))).toBe(false);
  });

  it('reverts beforeInstall mutations when config/upgrade-unsupported rejects a vendored/bare-reinstall graft', async () => {
    const adapter = makeAdapter({
      async beforeInstall({ project }: GraftContext, version: string) {
        await mkdir(path.join(project.root, '.grafts/.vendor'), { recursive: true });
        await writeFile(path.join(project.root, '.grafts/.vendor/lib-2.0.0.tgz'), 'tgz');
        await writeFile(
          path.join(project.root, 'package.json'),
          JSON.stringify({ name: 'app', overrides: { lib: `file:.grafts/.vendor/lib-${version}.tgz` } }) + '\n',
        );
        return { install: 'reinstall' as const };
      },
    });
    const { root, project } = await syncFixture({
      config: { upgrade: { lib: 'echo {version}' } },
      adapter,
    });
    const beforePkg = await readFile(path.join(root, 'package.json'), 'utf8');

    const report = await sync(project, { version: '2.0.0', install: true, writeReport: false });
    expect(report.exitCode).toBe(2);
    expect(report.grafts[0]!.reasons.join('\n')).toMatch(/vendored build/);
    expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe(beforePkg);
    expect(existsSync(path.join(root, '.grafts/.vendor'))).toBe(false);
  });

  it('reverts config edits when post-install version verification or afterInstall fails', async () => {
    const adapter = makeAdapter({
      async beforeInstall({ project }: GraftContext, version: string) {
        await writeFile(
          path.join(project.root, 'pnpm-workspace.yaml'),
          `patchedDependencies:\n  lib@${version}: .grafts/tweak/variants/v1.txt\n`,
        );
      },
      async afterInstall() {
        throw new Error('postinstall apply blew up');
      },
    });
    const { root, project, upstream } = await syncFixture({
      config: { upgrade: { lib: 'node -e "process.exit(0)" {version}' } },
      adapter,
    });
    // Case 1: post-install version check fails (still 1.0.0 instead of 2.0.0) -> newly created pnpm-workspace.yaml is removed.
    const rMismatch = await sync(project, { version: '2.0.0', install: true, writeReport: false });
    expect(rMismatch.exitCode).toBe(2);
    expect(rMismatch.grafts[0]!.reasons.join('\n')).toMatch(/found version 1\.0\.0, expected 2\.0\.0/);
    expect(existsSync(path.join(root, 'pnpm-workspace.yaml'))).toBe(false);

    // Case 2: version moves to 2.0.0, then afterInstall throws -> pnpm-workspace.yaml is still rolled back.
    const beforeWs = 'patchedDependencies:\n  lib@1.0.0: .grafts/tweak/variants/v1.txt\n';
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), beforeWs);
    const prevInstalled = upstream.installed.bind(upstream);
    let calls = 0;
    upstream.installed = async (pkg) => {
      calls += 1;
      if (calls === 1) return prevInstalled(pkg);
      return { version: '2.0.0', dir: path.join(root, 'upstream/lib-2.0.0') };
    };
    const rAfter = await sync(project, { version: '2.0.0', install: true, writeReport: false });
    expect(rAfter.exitCode).toBe(2);
    expect(rAfter.grafts[0]!.reasons.join('\n')).toMatch(/postinstall apply blew up/);
    expect(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(beforeWs);
  });

  it('does NOT roll back when an upgrade command succeeds and needsAgentIf hands off to an agent', async () => {
    const adapter = makeAdapter({
      async beforeInstall({ project }: GraftContext, version: string) {
        await writeFile(
          path.join(project.root, 'pnpm-workspace.yaml'),
          `patchedDependencies:\n  lib@${version}: .grafts/tweak/variants/v1.txt\n`,
        );
      },
    });
    const { root, project, upstream } = await syncFixture({
      pnpmWorkspace: 'patchedDependencies:\n  lib@1.0.0: .grafts/tweak/variants/v1.txt\n',
      config: {
        upgrade: {
          lib: {
            command: "node -e \"require('fs').writeFileSync('migrations.json', '{}')\" {version}",
            needsAgentIf: { exists: 'migrations.json' },
          },
        },
      },
      adapter,
    });
    const prevInstalled = upstream.installed.bind(upstream);
    let calls = 0;
    upstream.installed = async (pkg) => {
      calls += 1;
      if (calls === 1) return prevInstalled(pkg);
      return { version: '2.0.0', dir: path.join(root, 'upstream/lib-2.0.0') };
    };

    const report = await sync(project, { version: '2.0.0', install: true, writeReport: false });
    expect(report.exitCode).toBe(1);
    expect(report.grafts[0]?.outcome).toBe('needs-agent');
    expect(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).toContain('lib@2.0.0');
    expect(existsSync(path.join(root, 'migrations.json'))).toBe(true);
  });
});
