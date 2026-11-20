import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DirectoryUpstreamSource, isDeclaredNpmDependency, npmEcosystem, Project, updatePackageOverrides } from '../src/index.js';

describe('transitive npm dependencies (#63)', () => {
  it('detects declared dependencies across root, extraDirs, pnpm-workspace.yaml and package.json workspaces', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-declared-'));
    await mkdir(path.join(root, 'packages/app'), { recursive: true });
    await mkdir(path.join(root, 'apps/web'), { recursive: true });
    await mkdir(path.join(root, 'extra/sub'), { recursive: true });
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'root',
        dependencies: { direct: '1.0.0' },
        devDependencies: { devdep: '1.0.0' },
        optionalDependencies: { optdep: '1.0.0' },
        workspaces: ['apps/*'],
      }),
    );
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(path.join(root, 'packages/app/package.json'), JSON.stringify({ name: 'app', dependencies: { wsPnpm: '1.0.0' } }));
    await writeFile(path.join(root, 'apps/web/package.json'), JSON.stringify({ name: 'web', devDependencies: { wsPkg: '1.0.0' } }));
    await writeFile(path.join(root, 'extra/sub/package.json'), JSON.stringify({ name: 'sub', dependencies: { fromExtra: '1.0.0' } }));

    expect(await isDeclaredNpmDependency(root, 'direct')).toBe(true);
    expect(await isDeclaredNpmDependency(root, 'devdep')).toBe(true);
    expect(await isDeclaredNpmDependency(root, 'optdep')).toBe(true);
    expect(await isDeclaredNpmDependency(root, 'wsPnpm')).toBe(true);
    expect(await isDeclaredNpmDependency(root, 'wsPkg')).toBe(true);
    expect(await isDeclaredNpmDependency(root, 'fromExtra', [path.join(root, 'extra/sub')])).toBe(true);
    expect(await isDeclaredNpmDependency(root, 'transitive-only')).toBe(false);
  });

  it('updates existing pinned overrides/resolutions while keeping prefixes, comments, and complex rules intact', async () => {
    // pnpm-workspace.yaml overrides
    const pnpmRoot = await mkdtemp(path.join(os.tmpdir(), 'graft-ov-pnpm-'));
    const ws = `packages:\n  - packages/*\noverrides:\n  # pin for patch\n  adm-zip: 0.6.1\n  foo: ^1.0.0\n  bar: ">=1.0.0 <2.0.0"\n  "parent>baz": 1.0.0\n`;
    await writeFile(path.join(pnpmRoot, 'pnpm-workspace.yaml'), ws);
    await writeFile(path.join(pnpmRoot, 'package.json'), JSON.stringify({ name: 'pnpm-app' }));

    const r1 = await updatePackageOverrides(pnpmRoot, 'pnpm', [
      { pkg: 'adm-zip', from: '0.6.1', to: '0.6.2' },
      { pkg: 'foo', from: '1.0.0', to: '1.1.0' },
      { pkg: 'bar', from: '1.0.0', to: '1.1.0' },
      { pkg: 'baz', from: '1.0.0', to: '1.1.0' },
    ]);
    expect(r1.moved.sort()).toEqual(['adm-zip', 'foo']);
    expect(r1.locations).toEqual(["pnpm-workspace.yaml's overrides"]);
    expect(await readFile(path.join(pnpmRoot, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      ws.replace('adm-zip: 0.6.1', 'adm-zip: 0.6.2').replace('foo: ^1.0.0', 'foo: ^1.1.0'),
    );

    // npm/bun package.json overrides
    const bunRoot = await mkdtemp(path.join(os.tmpdir(), 'graft-ov-bun-'));
    await writeFile(
      path.join(bunRoot, 'package.json'),
      `${JSON.stringify({ name: 'bun-app', overrides: { 'undici-types': '7.24.6', other: '>=1.0.0' } }, null, 2)}\n`,
    );
    const r2 = await updatePackageOverrides(bunRoot, 'bun', [
      { pkg: 'undici-types', from: '7.24.6', to: '7.24.7' },
      { pkg: 'other', from: '1.0.0', to: '1.1.0' },
    ]);
    expect(r2).toEqual({ moved: ['undici-types'], locations: ['package.json overrides'] });
    expect(JSON.parse(await readFile(path.join(bunRoot, 'package.json'), 'utf8')).overrides).toEqual({
      'undici-types': '7.24.7',
      other: '>=1.0.0',
    });

    // yarn resolutions
    const yarnRoot = await mkdtemp(path.join(os.tmpdir(), 'graft-ov-yarn-'));
    await writeFile(
      path.join(yarnRoot, 'package.json'),
      `${JSON.stringify({ name: 'yarn-app', resolutions: { ms: '~2.1.2' } }, null, 2)}\n`,
    );
    const r3 = await updatePackageOverrides(yarnRoot, 'yarn', [{ pkg: 'ms', from: '2.1.2', to: '2.1.3' }]);
    expect(r3).toEqual({ moved: ['ms'], locations: ['package.json resolutions'] });
    expect(JSON.parse(await readFile(path.join(yarnRoot, 'package.json'), 'utf8')).resolutions).toEqual({ ms: '~2.1.3' });
  });

  it('refuses to promote an unpinned transitive dependency into root dependencies (install/transitive)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-transitive-fail-'));
    const pkgJson = `${JSON.stringify({ name: 'app', devDependencies: { parent: '^1.0.0' } }, null, 2)}\n`;
    await writeFile(path.join(root, 'package.json'), pkgJson);
    await writeFile(path.join(root, 'bun.lock'), '');
    const v1 = path.join(root, 'up/1.0.0');
    const v2 = path.join(root, 'up/1.1.0');
    await mkdir(v1, { recursive: true });
    await mkdir(v2, { recursive: true });
    await writeFile(path.join(v1, 'package.json'), JSON.stringify({ name: 'undici-types', version: '1.0.0' }));
    await writeFile(path.join(v2, 'package.json'), JSON.stringify({ name: 'undici-types', version: '1.1.0' }));

    const upstream = new DirectoryUpstreamSource({ 'undici-types': { '1.0.0': v1, '1.1.0': v2 } }, { 'undici-types': '1.0.0' });
    const project = await Project.open({ root, adapters: [], upstream });

    await expect(npmEcosystem.install(project, 'undici-types', '1.1.0')).rejects.toThrow(
      /undici-types is a transitive dependency .* Pin it in overrides, configure an `upgrade` command/,
    );
    // package.json must remain untouched.
    expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe(pkgJson);
  });
});
