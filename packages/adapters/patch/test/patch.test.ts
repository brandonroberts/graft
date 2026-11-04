import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addGraft, DirectoryUpstreamSource, Project, projectStatus, recordVariant, sync, updateGraft, type MechanismAdapter } from '@graftsync/core';
import { configurePnpmPatch, patchAdapter, pnpmConfigProblems } from '../src/index.js';

const V1 = `const a = 1\nconst b = 2\nmodule.exports = { a, b }\n`;
const V2 = `// moved down one line\n${V1}`; // same anchors, shifted
const V3 = `const a = 1\nmodule.exports = { a }\n`; // anchor gone
const PATCH = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1,3 +1,4 @@
 const a = 1
 const b = 2
+const c = 3
 module.exports = { a, b }
`;

async function fixture(installed: string, oracle = 'node -e "process.exit(0)"') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-patch-'));
  const up: Record<string, string> = {};
  for (const [v, code] of [['1.0.0', V1], ['1.1.0', V2], ['2.0.0', V3]] as const) {
    const dir = path.join(root, 'upstream', v);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.js'), code);
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'lib', version: v }));
    up[v] = dir;
  }
  const g = path.join(root, '.grafts', 'add-c');
  await mkdir(path.join(g, 'variants'), { recursive: true });
  await writeFile(path.join(g, 'variants', 'v1.patch'), PATCH);
  await writeFile(
    path.join(g, 'graft.md'),
    `---\nid: add-c\nrootstock: { package: lib, verified: 1.0.0 }\nmechanism: patch\nvariants:\n  - range: ">=1.0.0"\n    module: ./variants/v1.patch\noracle: { command: '${oracle}' }\n---\n## Why\nw\n## Invariants\ni\n## Where to look\nl\n## Anchors\na\n## History\n- created\n`,
  );
  await writeFile(
    path.join(root, 'pnpm-workspace.yaml'),
    `packages: []\nignorePatchFailures: false\npatchedDependencies:\n  lib: .grafts/add-c/variants/v1.patch\n`,
  );
  const upstream = new DirectoryUpstreamSource({ lib: up }, { lib: installed });
  const project = await Project.open({ root, adapters: [patchAdapter], upstream });
  return { root, project, graft: await project.get('add-c'), upstream };
}

describe('patch adapter', () => {
  it('matches hunks (tolerating offsets) and applies', async () => {
    const { project, graft } = await fixture('1.0.0');
    const ctx = project.context(graft);
    for (const v of ['1.0.0', '1.1.0']) {
      const report = await patchAdapter.checkAnchors(ctx, v);
      expect(report.ok, JSON.stringify(report)).toBe(true);
    }
    const applied = await patchAdapter.apply(ctx, { version: '1.1.0' });
    expect(applied.ok).toBe(true);
  });

  it('fails loudly when a hunk no longer fits', async () => {
    const { project, graft } = await fixture('1.0.0');
    const report = await patchAdapter.checkAnchors(project.context(graft), '2.0.0');
    expect(report.ok).toBe(false);
    expect(report.anchors[0]).toMatchObject({ name: 'index.js#1', matched: false });
    const applied = await patchAdapter.apply(project.context(graft), { version: '2.0.0' });
    expect(applied.ok).toBe(false);
  });

  it('flags pnpm configs that would apply the wrong patch or fail silently', async () => {
    const { root } = await fixture('1.0.0');
    const variant = path.join(root, '.grafts/add-c/variants/v1.patch');
    expect(await pnpmConfigProblems(root, 'lib', variant)).toEqual([]);
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), `packages: []\npatchedDependencies:\n  lib@1.0.0: other.patch\n`);
    const problems = await pnpmConfigProblems(root, 'lib', variant);
    expect(problems.join('\n')).toMatch(/ignorePatchFailures/);
    expect(problems.join('\n')).toMatch(/version-pinned/);
  });

  it('scopes the upstream diff to patched regions', async () => {
    const { project, graft } = await fixture('1.0.0');
    const diff = await patchAdapter.scopeDiff(project.context(graft), '1.0.0', '2.0.0');
    expect(diff.files[0]?.status).toBe('modified');
    expect(diff.patch).toContain('-const b = 2');
  });
});

describe('sync with the patch adapter', () => {
  it('is green and bumps verified when anchors hold and the oracle passes', async () => {
    const { project, root } = await fixture('1.1.0');
    const report = await sync(project, { writeReport: false });
    expect(report.exitCode).toBe(0);
    expect(report.grafts[0]).toMatchObject({ outcome: 'green', updated: true });
    expect(await readFile(path.join(root, '.grafts/add-c/graft.md'), 'utf8')).toContain('verified: 1.1.0');
  });

  it('hands off to an agent without installing when anchors miss', async () => {
    const { project } = await fixture('1.0.0');
    const report = await sync(project, { version: '2.0.0', install: true });
    expect(report.exitCode).toBe(1);
    expect(report.targets[0]?.installCommand).toBeUndefined();
    expect(report.grafts[0]?.outcome).toBe('needs-agent');
    expect(await readFile(report.grafts[0]!.diffPath!, 'utf8')).toContain('-const b = 2');
  });

  it('needs an agent when the oracle fails', async () => {
    const { project } = await fixture('1.1.0', 'node -e "process.exit(3)"');
    const report = await sync(project, { writeReport: false });
    expect(report.grafts[0]).toMatchObject({ outcome: 'needs-agent' });
    expect(report.grafts[0]?.oracle?.modes[0]?.exitCode).toBe(3);
  });

  it('records a new variant and narrows the open-ended range', async () => {
    const { project, root } = await fixture('1.0.0');
    const v2 = path.join(root, '.grafts/add-c/variants/v2.patch');
    await writeFile(v2, PATCH.replace(' const b = 2\n', '').replace('@@ -1,3 +1,4 @@', '@@ -1,2 +1,3 @@').replace('{ a, b }', '{ a }'));
    const result = await recordVariant(project, 'add-c', { range: '>=2.0.0', module: './variants/v2.patch' }, { verifyVersion: '2.0.0' });
    expect(result.narrowed).toEqual([{ module: './variants/v1.patch', from: '>=1.0.0', to: '>=1.0.0 <2.0.0' }]);
    expect(project.selectVariant(result.graft, '2.0.0')?.module).toBe('./variants/v2.patch');
  });
});

describe('onboarding a new graft (found by testing against a real project)', () => {
  it('scaffolds a .patch variant for the patch mechanism, which fails loudly until written', async () => {
    const { project, root } = await fixture('1.0.0');
    const files = await addGraft(project, { id: 'new-one', package: 'other-lib', version: '1.0.0', mechanism: 'patch' });
    expect(files.some((f) => f.endsWith(path.join('variants', 'v1.patch')))).toBe(true);
    const report = await patchAdapter.checkAnchors(project.context(await project.get('new-one')), '1.0.0');
    expect(report.errors.join('\n')).toMatch(/contains no hunks/);
    expect(await readFile(path.join(root, '.grafts/new-one/graft.md'), 'utf8')).toContain('- default');
  });

  it('flags and removes pnpm.patchedDependencies entries that pnpm patch-commit writes to package.json', async () => {
    const { root } = await fixture('1.0.0');
    const variant = path.join(root, '.grafts/add-c/variants/v1.patch');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'app', pnpm: { overrides: { x: '1' }, patchedDependencies: { 'lib@1.0.0': 'patches/lib@1.0.0.patch', other: 'o.patch' } } }, null, 2),
    );
    expect((await pnpmConfigProblems(root, 'lib', variant)).join('\n')).toMatch(/package\.json pnpm\.patchedDependencies\["lib@1\.0\.0"\]/);
    await configurePnpmPatch(root, 'lib', variant);
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.pnpm).toEqual({ overrides: { x: '1' }, patchedDependencies: { other: 'o.patch' } });
    expect(await pnpmConfigProblems(root, 'lib', variant)).toEqual([]);
  });
});

describe('scoped diff for a removed target', () => {
  it('points to the files the patched code moved to', async () => {
    const { project, graft, root } = await fixture('1.0.0');
    const v3 = path.join(root, 'upstream', '3.0.0');
    await mkdir(path.join(v3, 'dist'), { recursive: true });
    await mkdir(path.join(v3, 'lib'), { recursive: true });
    await writeFile(path.join(v3, 'package.json'), JSON.stringify({ name: 'lib', version: '3.0.0', main: 'dist/main.js' }));
    await writeFile(path.join(v3, 'dist', 'main.js'), `'use strict'\n${V1}`);
    await writeFile(path.join(v3, 'lib', 'util.js'), `const a = 1\n}\n`); // a weaker match
    await writeFile(path.join(v3, 'lib', 'noise.js'), `}\n\nfunction other() {}\n`); // trivial lines only
    (project.upstream as unknown as { dirs: Record<string, Record<string, string>> }).dirs.lib!['3.0.0'] = v3;
    const diff = await patchAdapter.scopeDiff(project.context(graft), '1.0.0', '3.0.0');
    const file = diff.files.find((f) => f.file === 'index.js')!;
    expect(file.status).toBe('removed');
    expect(file.candidates).toEqual(['dist/main.js', 'lib/util.js']);
    expect(diff.patch).toMatch(/# candidate files in lib@3\.0\.0[^\n]*\n#   dist\/main\.js\n#   lib\/util\.js/);
  });
});

describe('two grafts on the same package', () => {
  async function withSecond(status = 'applied', mechanism = 'patch') {
    const fx = await fixture('1.0.0');
    const g = path.join(fx.root, '.grafts', 'add-d');
    await mkdir(path.join(g, 'variants'), { recursive: true });
    await writeFile(path.join(g, 'variants', 'v1.patch'), PATCH.replace('const c = 3', 'const d = 4'));
    await writeFile(
      path.join(g, 'graft.md'),
      (await readFile(path.join(fx.root, '.grafts/add-c/graft.md'), 'utf8'))
        .replace('id: add-c', 'id: add-d')
        .replace('mechanism: patch', `mechanism: ${mechanism}\nstatus: ${status}`),
    );
    return fx;
  }

  it('marks both invalid in loadAll, get, status and sync', async () => {
    const { project } = await withSecond();
    const { grafts, invalid } = await project.loadAll();
    expect(grafts).toEqual([]);
    expect(invalid.map((g) => g.id)).toEqual(['add-c', 'add-d']);
    const diag = invalid[0]!.diagnostics.find((d) => d.code === 'graft/duplicate-rootstock');
    expect(diag?.message).toMatch(/"add-c" and "add-d" both patch lib/);
    expect(diag?.message).toMatch(/Merge them into one graft/);
    expect(invalid[1]!.diagnostics.some((d) => d.code === 'graft/duplicate-rootstock' && d.message.includes('"add-c"'))).toBe(true);
    await expect(project.get('add-c')).rejects.toThrow(/both patch lib/);
    await expect(project.get('add-d')).rejects.toThrow(/"add-c"/);
    const status = await projectStatus(project);
    expect(status.invalid.map((i) => i.id)).toEqual(['add-c', 'add-d']);
    const report = await sync(project, { writeReport: false });
    expect(report.exitCode).not.toBe(0);
  });

  it('can be resolved by marking one obsolete, and refuses to scaffold a duplicate', async () => {
    const { project } = await withSecond();
    await updateGraft(project, 'add-d', { status: 'obsolete' });
    expect((await project.loadAll()).invalid).toEqual([]);
    expect((await project.get('add-c')).id).toBe('add-c');
    await expect(addGraft(project, { id: 'add-e', package: 'lib', mechanism: 'patch' })).rejects.toThrow(/"add-c" already patches lib/);
  });

  it('ignores inactive grafts and mechanisms that allow several grafts per package', async () => {
    const { project } = await withSecond('upstreamed');
    expect((await project.loadAll()).invalid).toEqual([]);
    const other: MechanismAdapter = { ...patchAdapter, name: 'multi', exclusivePerPackage: false };
    const fx = await withSecond('applied', 'multi');
    const p2 = await Project.open({ root: fx.root, adapters: [patchAdapter, other], upstream: fx.upstream });
    const { grafts, invalid } = await p2.loadAll();
    expect(invalid).toEqual([]);
    expect(grafts.map((g) => g.id)).toEqual(['add-c', 'add-d']);
  });
});
