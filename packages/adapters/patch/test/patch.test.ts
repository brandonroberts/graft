import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DirectoryUpstreamSource, Project, recordVariant, sync } from '@graft/core';
import { patchAdapter, pnpmConfigProblems } from '../src/index.js';

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
