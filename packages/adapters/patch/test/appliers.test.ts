import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bunApplier, patchPackageApplier, patchPackageFileName, selectApplier, toPatchPackageFormat } from '../src/index.js';

const VARIANT = 'diff --git a/index.js b/index.js\nindex 111..222 100644\n--- a/index.js\n+++ b/index.js\n@@ -1,2 +1,3 @@\n a\n+b\n c\n';

async function project(manifest: Record<string, unknown>, lockfile?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-appliers-'));
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (lockfile) await writeFile(path.join(root, lockfile), '');
  const variant = path.join(root, '.grafts/g/variants/v1.patch');
  await mkdir(path.dirname(variant), { recursive: true });
  await writeFile(variant, VARIANT);
  return { root, variant, manifest: async () => JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) };
}

describe('applier selection', () => {
  it('follows packageManager, then lockfiles, then the config override', async () => {
    expect(selectApplier((await project({ packageManager: 'bun@1.4.4' })).root).name).toBe('bun');
    expect(selectApplier((await project({}, 'bun.lock')).root).name).toBe('bun');
    expect(selectApplier((await project({}, 'package-lock.json')).root).name).toBe('patch-package');
    expect(selectApplier((await project({}, 'yarn.lock')).root).name).toBe('patch-package');
    expect(selectApplier((await project({}, 'pnpm-lock.yaml')).root).name).toBe('pnpm');
    expect(selectApplier((await project({}, 'bun.lock')).root, 'patch-package').name).toBe('patch-package');
  });
});

describe('bun applier', () => {
  it('pins the key to the installed version and flags keys bun would silently skip', async () => {
    const p = await project({ name: 'app', patchedDependencies: { lib: 'old.patch', 'other@1.0.0': 'o.patch' } }, 'bun.lock');
    const problems = (await bunApplier.problems(p.root, 'lib', '1.2.0', p.variant)).join('\n');
    expect(problems).toMatch(/no "lib@1\.2\.0" entry/);
    expect(problems).toMatch(/\["lib"\] does not match the installed lib@1\.2\.0; bun silently skips it/);
    await bunApplier.configure(p.root, 'lib', '1.2.0', p.variant);
    expect((await p.manifest()).patchedDependencies).toEqual({ 'other@1.0.0': 'o.patch', 'lib@1.2.0': '.grafts/g/variants/v1.patch' });
    expect(await bunApplier.problems(p.root, 'lib', '1.2.0', p.variant)).toEqual([]);
    // An upgrade must move the key, or bun installs the new version unpatched.
    expect((await bunApplier.problems(p.root, 'lib', '1.3.0', p.variant)).join('\n')).toMatch(/no "lib@1\.3\.0" entry/);
  });
});

describe('patch-package applier', () => {
  it('converts variants to patch-package paths and names files the way patch-package does', () => {
    const out = toPatchPackageFormat(VARIANT, '@scope/lib');
    expect(out).toContain('diff --git a/node_modules/@scope/lib/index.js b/node_modules/@scope/lib/index.js');
    expect(out).toContain('--- a/node_modules/@scope/lib/index.js');
    expect(out).toContain('+++ b/node_modules/@scope/lib/index.js');
    expect(out).not.toContain('index 111..222');
    expect(patchPackageFileName('@scope/lib', '1.2.0')).toBe('@scope+lib+1.2.0.patch');
  });

  it('writes the derived patch and a strict postinstall, and detects drift', async () => {
    const p = await project({ name: 'app', scripts: { postinstall: 'node setup.js && patch-package' }, devDependencies: { 'patch-package': '8.0.1' } }, 'package-lock.json');
    await mkdir(path.join(p.root, 'patches'));
    await writeFile(path.join(p.root, 'patches/lib+1.0.0.patch'), 'x');
    const before = (await patchPackageApplier.problems(p.root, 'lib', '1.2.0', p.variant)).join('\n');
    expect(before).toMatch(/postinstall must run `patch-package --patch-dir \.grafts\/\.patch-package --error-on-fail --error-on-warn`/);
    expect(before).toMatch(/lib\+1\.2\.0\.patch is missing/);
    expect(before).toMatch(/patches\/lib\+1\.0\.0\.patch also patches lib/);

    await patchPackageApplier.configure(p.root, 'lib', '1.2.0', p.variant);
    expect((await p.manifest()).scripts.postinstall).toBe('node setup.js && patch-package && patch-package --patch-dir .grafts/.patch-package --error-on-fail --error-on-warn');
    expect(await readFile(path.join(p.root, '.grafts/.patch-package/lib+1.2.0.patch'), 'utf8')).toBe(toPatchPackageFormat(VARIANT, 'lib'));

    // Upgrading renames the derived file; editing the variant makes it stale.
    await patchPackageApplier.configure(p.root, 'lib', '1.3.0', p.variant);
    const after = await patchPackageApplier.problems(p.root, 'lib', '1.3.0', p.variant);
    expect(after.filter((x) => !x.startsWith('patches/'))).toEqual([]);
    await writeFile(p.variant, VARIANT.replace('+b', '+B'));
    expect((await patchPackageApplier.problems(p.root, 'lib', '1.3.0', p.variant)).join('\n')).toMatch(/is stale/);
  });

  it('requires the strict flags, because plain patch-package exits 0 on a failed patch', async () => {
    const p = await project({ name: 'app', scripts: { postinstall: 'patch-package --patch-dir .grafts/.patch-package' }, devDependencies: { 'patch-package': '8.0.1' } }, 'package-lock.json');
    const problems = (await patchPackageApplier.problems(p.root, 'lib', '1.0.0', p.variant)).join('\n');
    expect(problems).toMatch(/must pass --error-on-fail/);
    expect(problems).toMatch(/must pass --error-on-warn/);
  });
});
