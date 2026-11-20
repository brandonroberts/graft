import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findInstalledPackage, NpmUpstreamSource } from '../src/upstream.js';

/** A packed `lib@1.0.0` tarball in a temp dir (made with npm itself, offline). */
async function packedLib() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-upstream-'));
  const src = path.join(root, 'src');
  await mkdir(path.join(src, 'lib'), { recursive: true });
  await writeFile(path.join(src, 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0', main: 'index.js' }));
  await writeFile(path.join(src, 'index.js'), "module.exports = require('./lib/a')\n");
  await writeFile(path.join(src, 'lib/a.js'), 'module.exports = 1\n');
  execFileSync('npm', ['pack', src, '--pack-destination', root], { cwd: root, stdio: 'pipe' });
  return root;
}

describe('NpmUpstreamSource (fetching through npm)', () => {
  it('extracts the pristine contents of a spec with npm pack, and caches them', async () => {
    const root = await packedLib();
    const cacheDir = path.join(root, 'cache');
    const source = new NpmUpstreamSource({ root, cacheDir, specs: { lib: 'file:lib-{version}.tgz' }, specBase: root });
    const dir = await source.resolve('lib', '1.0.0');
    expect(dir).toBe(path.join(cacheDir, 'upstream', 'lib@1.0.0'));
    expect(JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')).version).toBe('1.0.0');
    expect(await readFile(path.join(dir, 'lib/a.js'), 'utf8')).toBe('module.exports = 1\n');
    expect(existsSync(`${dir}.tmp-${process.pid}`)).toBe(false); // no leftovers
    // Cached: the tarball can go away.
    await writeFile(path.join(root, 'lib-1.0.0.tgz'), 'not a tarball');
    expect(await source.resolve('lib', '1.0.0')).toBe(dir);
  });

  it('still fetches through npm when package.json pins another package manager via devEngines (#58)', async () => {
    const root = await packedLib();
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'pnpm-app',
        devEngines: { packageManager: { name: 'pnpm', version: '11.24.0', onFail: 'error' } },
      }),
    );
    const cacheDir = path.join(root, 'cache');
    const source = new NpmUpstreamSource({ root, cacheDir, specs: { lib: 'file:lib-{version}.tgz' }, specBase: root });
    const dir = await source.resolve('lib', '1.0.0');
    expect(JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')).version).toBe('1.0.0');
  });

  it('fails with the reason npm gives', async () => {
    const root = await packedLib();
    const source = new NpmUpstreamSource({
      root,
      cacheDir: path.join(root, 'cache'),
      specs: { lib: 'file:missing-{version}.tgz' },
      specBase: root,
    });
    await expect(source.resolve('lib', '1.0.0')).rejects.toThrow(/could not fetch file:.*missing-1\.0\.0\.tgz: .+/);
    expect(existsSync(path.join(root, 'cache/upstream/lib@1.0.0'))).toBe(false);
  });
});

describe('findInstalledPackage (pnpm virtual store fallback, #59)', () => {
  it('finds unhoisted transitive unscoped and scoped packages in node_modules/.pnpm', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-pnpm-store-'));
    const unscoped = path.join(root, 'node_modules/.pnpm/adm-zip@0.6.1_patch_hash=abc/node_modules/adm-zip');
    const scoped = path.join(root, 'node_modules/.pnpm/@scope+pkg@2.1.0_peer@1.0.0/node_modules/@scope/pkg');
    await mkdir(unscoped, { recursive: true });
    await mkdir(scoped, { recursive: true });
    await writeFile(path.join(unscoped, 'package.json'), JSON.stringify({ name: 'adm-zip', version: '0.6.1' }));
    await writeFile(path.join(scoped, 'package.json'), JSON.stringify({ name: '@scope/pkg', version: '2.1.0' }));

    expect(await findInstalledPackage('adm-zip', root)).toEqual({ version: '0.6.1', dir: await realpath(unscoped) });
    expect(await findInstalledPackage('@scope/pkg', root)).toEqual({ version: '2.1.0', dir: await realpath(scoped) });
    expect(await findInstalledPackage('missing-pkg', root)).toBeUndefined();
  });

  it('fails loudly when multiple distinct versions exist in node_modules/.pnpm, unless directly resolvable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-pnpm-store-'));
    const v1 = path.join(root, 'node_modules/.pnpm/lib@1.0.0/node_modules/lib');
    const v2 = path.join(root, 'node_modules/.pnpm/lib@2.0.0/node_modules/lib');
    await mkdir(v1, { recursive: true });
    await mkdir(v2, { recursive: true });
    await writeFile(path.join(v1, 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));
    await writeFile(path.join(v2, 'package.json'), JSON.stringify({ name: 'lib', version: '2.0.0' }));

    await expect(findInstalledPackage('lib', root)).rejects.toThrow(/multiple versions of lib .*1\.0\.0, 2\.0\.0.*resolveFrom/);

    // A workspace package that resolves its own copy directly still wins cleanly.
    const app = path.join(root, 'apps/web');
    const direct = path.join(app, 'node_modules/lib');
    await mkdir(direct, { recursive: true });
    await writeFile(path.join(direct, 'package.json'), JSON.stringify({ name: 'lib', version: '2.0.0' }));
    expect(await findInstalledPackage('lib', app)).toEqual({ version: '2.0.0', dir: await realpath(direct) });
  });
});
