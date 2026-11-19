import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { updatePnpmCatalogs } from '../src/index.js';

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
});
