import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NpmUpstreamSource } from '../src/upstream.js';

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

  it('fails with the reason npm gives', async () => {
    const root = await packedLib();
    const source = new NpmUpstreamSource({ root, cacheDir: path.join(root, 'cache'), specs: { lib: 'file:missing-{version}.tgz' }, specBase: root });
    await expect(source.resolve('lib', '1.0.0')).rejects.toThrow(/could not fetch file:.*missing-1\.0\.0\.tgz: .+/);
    expect(existsSync(path.join(root, 'cache/upstream/lib@1.0.0'))).toBe(false);
  });
});
