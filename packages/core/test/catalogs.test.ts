import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DirectoryUpstreamSource,
  findPnpmCatalogReferences,
  npmEcosystem,
  Project,
  updatePnpmCatalogs,
  updatePnpmPackageExtensions,
} from '../src/index.js';

const WORKSPACE = `packages:
  - packages/*
# Nx moves as one
catalog:
  nx: 24.0.0 # pinned
  '@nx/vite': ^24.0.0
  other: 1.0.0
catalogs:
  peerCompat:
    '@nx/vite': '>=22.0.0 <25.0.0'
  legacy:
    nx: ~24.0.0
`;

describe('pnpm catalogs', () => {
  it("moves the entries pinning the installed version, keeping prefixes, comments and other catalogs' ranges", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-catalogs-'));
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), WORKSPACE);
    const app = path.join(root, 'packages', 'app');
    await mkdir(app, { recursive: true });
    const moved = await updatePnpmCatalogs(app, [
      { pkg: 'nx', from: '24.0.0', to: '24.0.6' },
      { pkg: '@nx/vite', from: '24.0.0', to: '24.0.6' },
      { pkg: 'not-in-a-catalog', from: '1.0.0', to: '1.1.0' },
    ]);
    expect(moved.sort()).toEqual(['@nx/vite', 'nx']);
    expect(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      WORKSPACE.replace('nx: 24.0.0 # pinned', 'nx: 24.0.6 # pinned')
        .replace("'@nx/vite': ^24.0.0", "'@nx/vite': ^24.0.6")
        .replace('nx: ~24.0.0', 'nx: ~24.0.6'),
    );
  });

  it('does nothing without a pnpm-workspace.yaml or a matching entry', async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), 'graft-catalogs-'));
    expect(await updatePnpmCatalogs(bare, [{ pkg: 'nx', from: '24.0.0', to: '24.0.6' }])).toEqual([]);
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-catalogs-'));
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), WORKSPACE);
    expect(await updatePnpmCatalogs(root, [{ pkg: 'other', from: '0.9.0', to: '1.1.0' }])).toEqual([]);
    expect(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(WORKSPACE);
  });

  it('refuses to run pnpm update when a catalog:-referenced package does not pin the installed version (#55)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-catalogs-range-'));
    const ws = `packages:
  - packages/*
catalog:
  nx: '>=24.0.0 <25.0.0'
  '@nx/vite': 24.0.0
catalogs:
  named:
    helper: '>=1.0.0 <2.0.0'
`;
    await mkdir(path.join(root, 'packages/app'), { recursive: true });
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), ws);
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', packageManager: 'pnpm@10.28.0' }));
    const appPkg = JSON.stringify({
      name: 'app',
      dependencies: { nx: 'catalog:', '@nx/vite': 'catalog:', helper: 'catalog:named' },
    });
    await writeFile(path.join(root, 'packages/app/package.json'), appPkg);

    expect(await findPnpmCatalogReferences(root, 'nx')).toEqual([
      { file: 'packages/app/package.json', field: 'dependencies', catalog: '' },
    ]);
    expect(await findPnpmCatalogReferences(root, 'helper')).toEqual([
      { file: 'packages/app/package.json', field: 'dependencies', catalog: 'named' },
    ]);

    const up = async (name: string, version: string) => {
      const dir = path.join(root, 'up', name.replace('/', '+'), version);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
      return dir;
    };
    const upstream = new DirectoryUpstreamSource(
      {
        nx: { '24.0.0': await up('nx', '24.0.0'), '24.0.6': await up('nx', '24.0.6') },
        '@nx/vite': { '24.0.0': await up('@nx/vite', '24.0.0'), '24.0.6': await up('@nx/vite', '24.0.6') },
        helper: { '1.2.0': await up('helper', '1.2.0'), '1.3.0': await up('helper', '1.3.0') },
      },
      { nx: '24.0.0', '@nx/vite': '24.0.0', helper: '1.2.0' },
    );
    const project = await Project.open({ root, adapters: [], upstream });

    // Range in default catalog (even alongside a movable sibling): fails loudly with install/catalog
    // and leaves BOTH pnpm-workspace.yaml and package.json untouched.
    await expect(npmEcosystem.install(project, 'nx', '24.0.6', ['@nx/vite'])).rejects.toMatchObject({
      code: 'install/catalog',
      message: expect.stringMatching(/packages\/app\/package\.json.*catalog:.*>=24\.0\.0 <25\.0\.0/),
    });
    expect(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(ws);
    expect(await readFile(path.join(root, 'packages/app/package.json'), 'utf8')).toBe(appPkg);

    // Range in named catalog also fails loudly with install/catalog.
    await expect(npmEcosystem.install(project, 'helper', '1.3.0')).rejects.toMatchObject({
      code: 'install/catalog',
      message: expect.stringMatching(/catalog:named.*catalogs\.named\["helper"\] = ">=1\.0\.0 <2\.0\.0"/),
    });
  });
});

describe('pnpm packageExtensions (#79)', () => {
  it('renames exact-pinned keys in pnpm-workspace.yaml and package.json preserving comments and bare entries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-pkgext-'));
    const ws = `packages:
  - .
packageExtensions:
  # keep acorn attached
  "playwright-core@1.64.1":
    dependencies:
      acorn: 8.19.0
  # bare key applies to all versions
  baileys:
    peerDependenciesMeta:
      sharp:
        optional: true
  "@scope/pkg@1.0.0":
    dependencies:
      extra: 1.0.0
`;
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), ws);
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          name: 'app',
          pnpm: {
            packageExtensions: {
              'other@2.0.0': { dependencies: { helper: '1.0.0' } },
              'other@2.1.0': { dependencies: { helper: '2.0.0' } },
              'foo@1.0.0': { dependencies: { bar: '1.0.0' } },
            },
          },
        },
        null,
        2,
      ) + '\n',
    );

    const res = await updatePnpmPackageExtensions(root, [
      { pkg: 'playwright-core', from: '1.64.1', to: '1.65.0' },
      { pkg: 'baileys', from: '7.0.0-rc14', to: '7.0.0' },
      { pkg: '@scope/pkg', from: '1.0.0', to: '1.1.0' },
      { pkg: 'other', from: '2.0.0', to: '2.1.0' },
      { pkg: 'foo', from: '1.0.0', to: '1.2.0' },
    ]);
    expect(res.blocked).toEqual([]);
    expect(res.renamed.map((r) => `${r.fromKey} -> ${r.toKey}`).sort()).toEqual([
      '@scope/pkg@1.0.0 -> @scope/pkg@1.1.0',
      'foo@1.0.0 -> foo@1.2.0',
      'playwright-core@1.64.1 -> playwright-core@1.65.0',
    ]);

    const afterWs = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    expect(afterWs).toContain('# keep acorn attached');
    expect(afterWs).toContain('"playwright-core@1.65.0":');
    expect(afterWs).toContain('"@scope/pkg@1.1.0":');
    expect(afterWs).not.toContain('playwright-core@1.64.1');
    expect(afterWs).toContain('baileys:');

    const afterPkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(Object.keys(afterPkg.pnpm.packageExtensions)).toEqual(['other@2.0.0', 'other@2.1.0', 'foo@1.2.0']);
  });

  it('fails loudly with install/package-extensions when a range-pinned key matches from but not to', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-pkgext-range-'));
    const ws = `packages:
  - .
packageExtensions:
  "playwright-core@^1.64.0":
    dependencies:
      acorn: 8.19.0
`;
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), ws);
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'app', packageManager: 'pnpm@12.15.0', dependencies: { 'playwright-core': '1.64.1' } }),
    );
    const up = async (version: string) => {
      const dir = path.join(root, 'up', version);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'playwright-core', version }));
      return dir;
    };
    const upstream = new DirectoryUpstreamSource(
      { 'playwright-core': { '1.64.1': await up('1.64.1'), '2.0.0': await up('2.0.0') } },
      { 'playwright-core': '1.64.1' },
    );
    const project = await Project.open({ root, adapters: [], upstream });

    await expect(npmEcosystem.install(project, 'playwright-core', '2.0.0')).rejects.toMatchObject({
      code: 'install/package-extensions',
      message: expect.stringMatching(/playwright-core@\^1\.64\.0.*matches 1\.64\.1 but not 2\.0\.0/),
    });
    expect(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(ws);
  });
});
