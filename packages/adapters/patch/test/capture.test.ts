import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addGraft, captureVariant, Project, type UpstreamSource } from '@graftsync/core';
import { parsePatchFile, patchAdapter, patchTarget } from '../src/index.js';

/** Pristine lib@1.0.0, and an installed copy in node_modules that the test edits. */
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-capture-'));
  const pristine = path.join(root, 'pristine');
  await mkdir(path.join(pristine, 'lib'), { recursive: true });
  await writeFile(path.join(pristine, 'package.json'), `${JSON.stringify({ name: 'lib', version: '1.0.0', main: 'index.js' }, null, 2)}\n`);
  await writeFile(path.join(pristine, 'index.js'), "const a = require('./lib/a')\nmodule.exports = { a }\n");
  await writeFile(path.join(pristine, 'lib/a.js'), 'module.exports = 1\n');
  await writeFile(path.join(pristine, 'lib/old.js'), 'module.exports = "old"\n');
  const installed = path.join(root, 'app/node_modules/lib');
  await cp(pristine, installed, { recursive: true });
  const app = path.join(root, 'app');
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app', dependencies: { lib: '1.0.0' } }));
  const upstream: UpstreamSource = {
    resolve: async () => pristine,
    installed: async () => ({ version: '1.0.0', dir: installed }),
    versions: async () => ({ versions: ['1.0.0'], distTags: { latest: '1.0.0' } }),
    installSpec: (pkg, v) => `${pkg}@${v}`,
  };
  const project = await Project.open({ root: app, adapters: [patchAdapter], upstream });
  await addGraft(project, { id: 'add-b', package: 'lib', mechanism: 'patch', targets: ['index.js'] });
  return { root, app, installed, project, graftDir: path.join(app, '.grafts/add-b') };
}

describe('graft capture (patch)', () => {
  it('refuses when the installed copy is unchanged', async () => {
    const { project } = await setup();
    await expect(captureVariant(project, 'add-b')).rejects.toThrow(/identical to the published package/);
  });

  it('replaces the scaffold stub with the installed changes: edits, new and deleted files', async () => {
    const { project, installed, graftDir } = await setup();
    await writeFile(
      path.join(installed, 'index.js'),
      "const a = require('./lib/a')\nconst b = require('./lib/b')\nmodule.exports = { a, b }\n",
    );
    await writeFile(path.join(installed, 'lib/b.js'), 'module.exports = 2\n');
    await rm(path.join(installed, 'lib/old.js'));
    // Bookkeeping a package manager adds to package.json is not a modification.
    const pj = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
    await writeFile(
      path.join(installed, 'package.json'),
      JSON.stringify({ ...pj, _resolved: 'https://registry/lib-1.0.0.tgz', _integrity: 'sha512-x' }),
    );

    const result = await captureVariant(project, 'add-b');
    expect(result).toMatchObject({ module: './variants/v1.patch', replacedStub: true, version: '1.0.0' });
    const patch = await readFile(path.join(graftDir, 'variants/v1.patch'), 'utf8');
    expect(patch.startsWith('diff --git a/index.js b/index.js\n')).toBe(true);
    const files = parsePatchFile(patch).map((p) => [
      patchTarget(p),
      p.oldFile === null ? 'create' : p.newFile === null ? 'delete' : 'modify',
    ]);
    expect(files).toEqual([
      ['index.js', 'modify'],
      ['lib/b.js', 'create'],
      ['lib/old.js', 'delete'],
    ]);
    expect(await readFile(path.join(graftDir, 'graft.md'), 'utf8')).toContain(
      'Captured ./variants/v1.patch from the installed lib@1.0.0 with `graft capture`',
    );
    const anchors = await patchAdapter.checkAnchors(project.context(await project.get('add-b')), '1.0.0');
    expect(anchors.anchors.every((a) => a.matched)).toBe(true);
  });

  it('adds a new variant (never editing the existing one) once a real variant exists', async () => {
    const { project, installed, graftDir } = await setup();
    await writeFile(path.join(installed, 'lib/a.js'), 'module.exports = 10\n');
    await captureVariant(project, 'add-b');
    const first = await readFile(path.join(graftDir, 'variants/v1.patch'), 'utf8');

    await writeFile(path.join(installed, 'lib/a.js'), 'module.exports = 11\n');
    const result = await captureVariant(project, 'add-b');
    expect(result).toMatchObject({ module: './variants/v1.0.0.patch', replacedStub: false, range: '>=1.0.0' });
    expect(await readFile(path.join(graftDir, 'variants/v1.patch'), 'utf8')).toBe(first); // untouched
    expect(await readFile(path.join(graftDir, 'variants/v1.0.0.patch'), 'utf8')).toContain('+module.exports = 11');
    const graft = await project.get('add-b');
    expect(project.selectVariant(graft, '1.0.0')?.module).toBe('./variants/v1.0.0.patch');
  });

  it('refuses an installed copy that is exactly pristine + the selected variant (no new change)', async () => {
    const { project, installed, graftDir } = await setup();
    await writeFile(path.join(installed, 'lib/a.js'), 'module.exports = 10\n');
    await captureVariant(project, 'add-b');
    // Nothing edited since: capturing again would register a duplicate of v1.patch.
    await expect(captureVariant(project, 'add-b')).rejects.toThrow(
      /exactly the published package \+ \.\/variants\/v1\.patch, so there is no new change/,
    );
    expect(await readFile(path.join(graftDir, 'graft.md'), 'utf8')).not.toContain('v1.0.0.patch');
  });

  it('refuses binary changes', async () => {
    const { project, installed } = await setup();
    await writeFile(path.join(installed, 'logo.png'), Buffer.from([0x89, 0x50, 0, 1, 2]));
    await expect(captureVariant(project, 'add-b')).rejects.toThrow(/binary files differ .*logo\.png/);
  });
});
