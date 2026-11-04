import { linkSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyInstalled, DirectoryUpstreamSource, Project } from '@graftsync/core';
import { applyToInstalledCopy, findInstalledCopies, graftApplier, parsePatchFile, patchAdapter, selectApplier } from '../src/index.js';

const PRISTINE = 'const a = 1\nconst b = 2\nmodule.exports = { a, b }\n';
const PATCHED = 'const a = 1\nconst b = 2\nconst c = 3\nmodule.exports = { a, b }\n';
const PATCH = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1,3 +1,4 @@
 const a = 1
 const b = 2
+const c = 3
 module.exports = { a, b }
`;
const TWO_FILES = `${PATCH}diff --git a/other.js b/other.js
--- a/other.js
+++ b/other.js
@@ -1,1 +1,1 @@
-old
+new
`;

async function installTree(layout: Record<string, { version: string; code?: string; other?: string }>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-installed-'));
  for (const [rel, { version, code = PRISTINE, other }] of Object.entries(layout)) {
    const dir = path.join(root, rel);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'lib', version }));
    await writeFile(path.join(dir, 'index.js'), code);
    if (other !== undefined) await writeFile(path.join(dir, 'other.js'), other);
  }
  return root;
}

describe('built-in applier: one installed copy', () => {
  it('patches, then is idempotent', async () => {
    const root = await installTree({ 'node_modules/lib': { version: '1.0.0' } });
    const copy = { dir: path.join(root, 'node_modules/lib'), version: '1.0.0' };
    const patches = parsePatchFile(PATCH);
    expect(await applyToInstalledCopy(copy, patches)).toMatchObject({ action: 'patched', files: ['index.js'] });
    expect(await readFile(path.join(copy.dir, 'index.js'), 'utf8')).toBe(PATCHED);
    expect(await applyToInstalledCopy(copy, patches)).toMatchObject({ action: 'already-patched' });
    expect(await readFile(path.join(copy.dir, 'index.js'), 'utf8')).toBe(PATCHED);
  });

  it('never writes into a hardlinked store file (new inode instead)', async () => {
    const root = await installTree({ 'node_modules/lib': { version: '1.0.0' } });
    const store = path.join(root, 'store-index.js');
    await writeFile(store, PRISTINE);
    const installed = path.join(root, 'node_modules/lib/index.js');
    await import('node:fs/promises').then((fs) => fs.rm(installed));
    linkSync(store, installed); // what pnpm / bun / npm-with-cache do
    const mode = statSync(installed).mode;
    await applyToInstalledCopy({ dir: path.dirname(installed), version: '1.0.0' }, parsePatchFile(PATCH));
    expect(await readFile(store, 'utf8')).toBe(PRISTINE); // the shared store is untouched
    expect(await readFile(installed, 'utf8')).toBe(PATCHED);
    expect(statSync(installed).ino).not.toBe(statSync(store).ino);
    expect(statSync(installed).mode).toBe(mode);
  });

  it('writes nothing when any file of the variant does not fit', async () => {
    const root = await installTree({ 'node_modules/lib': { version: '1.0.0', other: 'unexpected\n' } });
    const dir = path.join(root, 'node_modules/lib');
    const r = await applyToInstalledCopy({ dir, version: '1.0.0' }, parsePatchFile(TWO_FILES));
    expect(r.action).toBe('failed');
    expect(r.reason).toMatch(/other\.js: the patch does not apply/);
    expect(await readFile(path.join(dir, 'index.js'), 'utf8')).toBe(PRISTINE); // not half-patched
  });
});

describe('built-in applier: the whole project', () => {
  async function setupProject(layout: Parameters<typeof installTree>[0], primaryVersion: string) {
    const root = await installTree(layout);
    const g = path.join(root, '.grafts/add-c');
    await mkdir(path.join(g, 'variants'), { recursive: true });
    await writeFile(path.join(g, 'variants/v1.patch'), PATCH);
    await writeFile(
      path.join(g, 'graft.md'),
      `---\nid: add-c\nrootstock: { package: lib, verified: 1.0.0 }\nmechanism: patch\nvariants:\n  - range: ">=1.0.0 <2.0.0"\n    module: ./variants/v1.patch\n---\n## Why\nw\n## Invariants\ni\n## Where to look\nl\n## Anchors\na\n## History\n- h\n`,
    );
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', scripts: { postinstall: 'graft apply --installed' }, devDependencies: { '@graftsync/cli': '0.1.0' } }));
    await writeFile(path.join(root, 'package-lock.json'), '{}');
    const primaryDir = path.join(root, 'node_modules/lib');
    const upstream = new DirectoryUpstreamSource({ lib: { [primaryVersion]: primaryDir } }, { lib: primaryVersion });
    return { root, project: await Project.open({ root, adapters: [patchAdapter], upstream }) };
  }

  it('patches every covered copy, warns about uncovered nested copies', async () => {
    const { root, project } = await setupProject(
      {
        'node_modules/lib': { version: '1.0.0' },
        'node_modules/dep/node_modules/lib': { version: '1.5.0' },
        'node_modules/old/node_modules/lib': { version: '0.9.0' },
      },
      '1.0.0',
    );
    expect((await findInstalledCopies(root, 'lib')).map((c) => c.version).sort()).toEqual(['0.9.0', '1.0.0', '1.5.0']);
    const { reports, ok } = await applyInstalled(project);
    expect(ok).toBe(true);
    const byVersion = Object.fromEntries(reports[0]!.copies.map((c) => [c.version, c.action]));
    expect(byVersion).toEqual({ '1.0.0': 'patched', '1.5.0': 'patched', '0.9.0': 'skipped' });
    expect(reports[0]!.warnings.join('\n')).toMatch(/lib@0\.9\.0 .* left unmodified/);
    expect(await readFile(path.join(root, 'node_modules/old/node_modules/lib/index.js'), 'utf8')).toBe(PRISTINE);
  });

  it('fails when no variant covers the copy the project resolves', async () => {
    const { project } = await setupProject({ 'node_modules/lib': { version: '2.0.0' } }, '2.0.0');
    const { reports, ok } = await applyInstalled(project);
    expect(ok).toBe(false);
    expect(reports[0]!.errors.join('\n')).toMatch(/no variant of graft "add-c" covers lib@2\.0\.0/);
  });

  it('is the default applier for npm and checks its postinstall', async () => {
    const { root } = await setupProject({ 'node_modules/lib': { version: '1.0.0' } }, '1.0.0');
    expect(selectApplier(root).name).toBe('graft');
    expect(await graftApplier.problems(root, 'lib', '1.0.0', '')).toEqual([]);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    const problems = (await graftApplier.problems(root, 'lib', '1.0.0', '')).join('\n');
    expect(problems).toMatch(/postinstall must run `graft apply --installed`/);
    expect(problems).toMatch(/@graftsync\/cli must be a \(dev\)dependency/);
    await graftApplier.configure(root, 'lib', '1.0.0', '');
    expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).scripts.postinstall).toBe('graft apply --installed');
    // Switching from the patch-package applier removes its step and generated files.
    await mkdir(path.join(root, '.grafts/.patch-package'), { recursive: true });
    await writeFile(path.join(root, '.grafts/.patch-package/lib+1.0.0.patch'), 'x');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', scripts: { postinstall: 'node a.js && patch-package --patch-dir .grafts/.patch-package --error-on-fail --error-on-warn' } }));
    await graftApplier.configure(root, 'lib', '1.0.0', '');
    expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).scripts.postinstall).toBe('node a.js && graft apply --installed');
    expect(await readFile(path.join(root, '.grafts/.patch-package/lib+1.0.0.patch'), 'utf8').catch(() => 'gone')).toBe('gone');
  });
});
