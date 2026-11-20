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

  it('bumps matching overrides for a direct dependency AND still runs the package manager update (#71)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-direct-override-'));
    await mkdir(path.join(root, 'packages/vitest'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', packageManager: 'pnpm@11.0.0' }));
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), `packages:\n  - packages/*\noverrides:\n  acorn: 8.11.3\n`);
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    await writeFile(path.join(root, 'packages/vitest/package.json'), JSON.stringify({ name: 'vitest', dependencies: { acorn: '8.11.3' } }));
    const v1 = path.join(root, 'up/8.11.3');
    const v2 = path.join(root, 'up/8.12.0');
    await mkdir(v1, { recursive: true });
    await mkdir(v2, { recursive: true });
    await writeFile(path.join(v1, 'package.json'), JSON.stringify({ name: 'acorn', version: '8.11.3' }));
    await writeFile(path.join(v2, 'package.json'), JSON.stringify({ name: 'acorn', version: '8.12.0' }));

    // Put a fake `pnpm` on PATH that records the args it was called with and verifies the override was already bumped.
    const binDir = path.join(root, 'fake-bin');
    const logFile = path.join(root, 'pnpm.log');
    await mkdir(binDir, { recursive: true });
    const fakePnpm = path.join(binDir, 'pnpm');
    await writeFile(fakePnpm, `#!/bin/sh\ncat "${path.join(root, 'pnpm-workspace.yaml')}" > "${logFile}.ws"\necho "$@" > "${logFile}"\n`, {
      mode: 0o755,
    });

    const upstream = new DirectoryUpstreamSource({ acorn: { '8.11.3': v1, '8.12.0': v2 } }, { acorn: '8.11.3' });
    const project = await Project.open({ root, adapters: [], upstream });

    const prevPath = process.env.PATH ?? '';
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    try {
      const cmd = await npmEcosystem.install(project, 'acorn', '8.12.0');
      expect(cmd).toContain("set acorn@8.12.0 in pnpm-workspace.yaml's overrides");
      expect(cmd).toContain('set acorn@8.12.0 in packages/vitest/package.json');
      expect(cmd).toContain("pnpm update -r 'acorn@8.12.0'");
    } finally {
      process.env.PATH = prevPath;
    }

    // Both override and exact-pinned workspace manifest were bumped BEFORE pnpm ran,
    // and pnpm update -r was still invoked.
    expect(await readFile(`${logFile}.ws`, 'utf8')).toContain('acorn: 8.12.0');
    expect(JSON.parse(await readFile(path.join(root, 'packages/vitest/package.json'), 'utf8')).dependencies.acorn).toBe('8.12.0');
    expect((await readFile(logFile, 'utf8')).trim()).toBe('update -r acorn@8.12.0');
  });

  it('updateDeclaredNpmSpecs updates matching pinned specs and leaves ranges/catalog:/workspace: intact (#74)', async () => {
    const { updateDeclaredNpmSpecs } = await import('../src/index.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-decl-specs-'));
    await mkdir(path.join(root, 'packages/a'), { recursive: true });
    await mkdir(path.join(root, 'packages/b'), { recursive: true });
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', devDependencies: { acorn: '^8.11.3' } }, null, 2) + '\n',
    );
    await writeFile(
      path.join(root, 'packages/a/package.json'),
      JSON.stringify(
        { name: 'a', dependencies: { acorn: '8.11.3', other: 'catalog:' }, optionalDependencies: { foo: '~1.0.0' } },
        null,
        4,
      ) + '\n',
    );
    await writeFile(
      path.join(root, 'packages/b/package.json'),
      JSON.stringify({ name: 'b', dependencies: { acorn: '>=8.0.0 <9', foo: '0.9.0' } }, null, 2) + '\n',
    );

    const res = await updateDeclaredNpmSpecs(root, [
      { pkg: 'acorn', from: '8.11.3', to: '8.12.0' },
      { pkg: 'foo', from: '1.0.0', to: '1.1.0' },
    ]);
    expect(res.moved.sort()).toEqual(['acorn', 'foo']);
    expect(res.files.sort()).toEqual(['package.json', 'packages/a/package.json']);
    expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).devDependencies.acorn).toBe('^8.12.0');
    const aText = await readFile(path.join(root, 'packages/a/package.json'), 'utf8');
    expect(aText).toContain('    "acorn": "8.12.0"'); // preserves 4-space indent
    expect(JSON.parse(aText).optionalDependencies.foo).toBe('~1.1.0');
    expect(JSON.parse(await readFile(path.join(root, 'packages/b/package.json'), 'utf8')).dependencies).toEqual({
      acorn: '>=8.0.0 <9',
      foo: '0.9.0',
    });
  });
});
