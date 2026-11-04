import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DirectoryUpstreamSource } from '@graftsync/core';
import { buildVendorTarball, selectApplier, tarballContents, vendorApplier } from '../src/index.js';

const PRISTINE = 'const a = 1\nconst b = 2\nmodule.exports = { a, b }\n';
const PATCH = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1,3 +1,4 @@
 const a = 1
 const b = 2
+const c = 3
 module.exports = { a, b }
`;

async function setup(lockfile: string, extra: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-vendor-'));
  const up: Record<string, string> = {};
  for (const v of ['1.0.0', '1.1.0']) {
    const dir = path.join(root, 'upstream', v);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'lib', version: v }));
    await writeFile(path.join(dir, 'index.js'), PRISTINE);
    up[v] = dir;
  }
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'app', dependencies: { lib: '^1.0.0' } }, null, 2)}\n`);
  await writeFile(path.join(root, lockfile), '');
  for (const [f, c] of Object.entries(extra)) await writeFile(path.join(root, f), c);
  const variant = path.join(root, '.grafts/g/variants/v1.patch');
  await mkdir(path.dirname(variant), { recursive: true });
  await writeFile(variant, PATCH);
  const upstream = new DirectoryUpstreamSource({ lib: up });
  const manifest = () => JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  return { root, variant, upstream, manifest };
}

describe('vendor applier', () => {
  it('builds reproducible tarballs of pristine + variant', async () => {
    const { variant, upstream } = await setup('package-lock.json');
    const a = await buildVendorTarball(await upstream.resolve('lib', '1.0.0'), variant);
    const b = await buildVendorTarball(await upstream.resolve('lib', '1.0.0'), variant);
    expect(readFileSync(a.file).equals(readFileSync(b.file))).toBe(true);
    const contents = await tarballContents(a.file);
    expect([...contents.keys()]).toEqual(['package/index.js', 'package/package.json']);
    expect(contents.get('package/index.js')!.toString()).toContain('const c = 3');
  });

  it('is the default for upm and points overrides + the root dependency at the tarball', async () => {
    const { root, variant, upstream, manifest } = await setup('upm.lock');
    expect(selectApplier(root).name).toBe('vendor');
    const before = (await vendorApplier.problems(root, 'lib', '1.0.0', variant, { upstream })).join('\n');
    expect(before).toMatch(/\.grafts\/\.vendor\/lib-1\.0\.0\.tgz is missing/);
    expect(before).toMatch(/overrides\["lib"\] must be "file:\.grafts\/\.vendor\/lib-1\.0\.0\.tgz"/);
    const r = await vendorApplier.configure(root, 'lib', '1.0.0', variant, { upstream });
    expect(r.install).toBe('reinstall');
    expect(manifest().overrides).toEqual({ lib: 'file:.grafts/.vendor/lib-1.0.0.tgz' });
    expect(manifest().dependencies).toEqual({ lib: 'file:.grafts/.vendor/lib-1.0.0.tgz' });
    expect(await vendorApplier.problems(root, 'lib', '1.0.0', variant, { upstream })).toEqual([]);
  });

  it('keeps tarball bytes when contents are unchanged, replaces them on upgrade, flags staleness', async () => {
    const { root, variant, upstream, manifest } = await setup('package-lock.json');
    await vendorApplier.configure(root, 'lib', '1.0.0', variant, { upstream });
    const first = await readFile(path.join(root, '.grafts/.vendor/lib-1.0.0.tgz'));
    await vendorApplier.configure(root, 'lib', '1.0.0', variant, { upstream });
    expect((await readFile(path.join(root, '.grafts/.vendor/lib-1.0.0.tgz'))).equals(first)).toBe(true);

    await vendorApplier.configure(root, 'lib', '1.1.0', variant, { upstream });
    expect(await readdir(path.join(root, '.grafts/.vendor'))).toEqual(['lib-1.1.0.tgz']);
    // npm resolves file: overrides relative to each dependent, so it references the root dep.
    expect(manifest().overrides.lib).toBe('$lib');
    expect(manifest().dependencies.lib).toBe('file:.grafts/.vendor/lib-1.1.0.tgz');

    await writeFile(variant, PATCH.replace('const c = 3', 'const c = 4'));
    expect((await vendorApplier.problems(root, 'lib', '1.1.0', variant, { upstream })).join('\n')).toMatch(/lib-1\.1\.0\.tgz is stale/);
  });

  it('adds a root dependency for npm when the package is only transitive', async () => {
    const { root, variant, upstream, manifest } = await setup('package-lock.json');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { other: '1.0.0' } }));
    await vendorApplier.configure(root, 'lib', '1.0.0', variant, { upstream });
    expect(manifest().dependencies).toEqual({ other: '1.0.0', lib: 'file:.grafts/.vendor/lib-1.0.0.tgz' });
    expect(manifest().overrides).toEqual({ lib: '$lib' });
    expect(await vendorApplier.problems(root, 'lib', '1.0.0', variant, { upstream })).toEqual([]);
  });

  it('drops stale npm lock entries (root and nested) so npm re-resolves them to the vendored package', async () => {
    const { root, variant, upstream } = await setup('package-lock.json');
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/lib': { version: '1.0.0', resolved: 'https://registry.npmjs.org/lib/-/lib-1.0.0.tgz' },
        'node_modules/dep/node_modules/lib': { version: '1.1.0', resolved: 'https://registry.npmjs.org/lib/-/lib-1.1.0.tgz' },
        'node_modules/dep': { version: '1.0.0' },
        'node_modules/libx': { version: '1.0.0' },
      },
    };
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock, null, 2));
    await vendorApplier.configure(root, 'lib', '1.0.0', variant, { upstream });
    const after = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    expect(Object.keys(after.packages)).toEqual(['', 'node_modules/dep', 'node_modules/libx']);

    // A lock that pins a nested registry copy is reported.
    after.packages['node_modules/dep/node_modules/lib'] = { version: '1.1.0', resolved: 'https://registry.npmjs.org/lib/-/lib-1.1.0.tgz' };
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(after, null, 2));
    expect((await vendorApplier.problems(root, 'lib', '1.0.0', variant, { upstream })).join('\n')).toMatch(
      /package-lock\.json still locks node_modules\/dep\/node_modules\/lib/,
    );
  });

  it('uses yarn resolutions and pnpm-workspace.yaml overrides', async () => {
    const yarn = await setup('yarn.lock');
    await vendorApplier.configure(yarn.root, 'lib', '1.0.0', yarn.variant, { upstream: yarn.upstream });
    expect(yarn.manifest().resolutions).toEqual({ lib: 'file:.grafts/.vendor/lib-1.0.0.tgz' });

    const pnpm = await setup('pnpm-lock.yaml', { 'pnpm-workspace.yaml': 'packages: []\npatchedDependencies:\n  lib: old.patch\n' });
    await vendorApplier.configure(pnpm.root, 'lib', '1.0.0', pnpm.variant, { upstream: pnpm.upstream });
    const yaml = await readFile(path.join(pnpm.root, 'pnpm-workspace.yaml'), 'utf8');
    expect(yaml).toContain('lib: file:.grafts/.vendor/lib-1.0.0.tgz');
    expect(yaml).not.toContain('old.patch'); // the competing native patch is removed
    expect(await vendorApplier.problems(pnpm.root, 'lib', '1.0.0', pnpm.variant, { upstream: pnpm.upstream })).toEqual([]);
  });
});
