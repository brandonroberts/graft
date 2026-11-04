import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addGraft, DirectoryUpstreamSource, Project, recordVariant, sync } from '@graftsync/core';
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

describe('detecting an upstreamed graft', () => {
  const PATCHED = `const a = 1\nconst b = 2\nconst c = 3\nmodule.exports = { a, b }\n`;
  const TWO_HUNKS = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1,3 +1,4 @@
 const a = 1
 const b = 2
+const c = 3
 module.exports = { a, b }
@@ -5,3 +6,4 @@
 function f() {}
 function g() {}
+function h() {}
 module.exports.f = f
`;

  async function withV2(content: string, patch?: string) {
    const fx = await fixture('1.0.0');
    if (patch) await writeFile(path.join(fx.root, '.grafts/add-c/variants/v1.patch'), patch);
    await writeFile(path.join(fx.root, 'upstream', '2.0.0', 'index.js'), content);
    return fx;
  }

  it('flags a graft whose change upstream already contains', async () => {
    const { project, graft } = await withV2(PATCHED);
    const report = await patchAdapter.checkAnchors(project.context(graft), '2.0.0');
    expect(report.ok).toBe(false);
    expect(report.upstreamed?.evidence.join('\n')).toMatch(/index\.js: all 1 hunk/);

    const result = await sync(project, { version: '2.0.0' });
    const g = result.grafts[0]!;
    expect(g).toMatchObject({ outcome: 'needs-agent', likelyUpstreamed: true });
    expect(g.reasons[0]).toMatch(/upstream lib@2\.0\.0 already contains this graft's change; confirm and set status: upstreamed/);
    const md = await readFile(result.reportFiles!.markdown, 'utf8');
    expect(md).toContain('likely upstreamed');
    expect(md).toMatch(/Next: .*`update_status`.*`upstreamed`/);
    expect(await readFile(path.join(project.root, '.grafts/add-c/graft.md'), 'utf8')).not.toContain('status: upstreamed');
  });

  it('flags a created file that upstream now ships with identical content', async () => {
    const created = `diff --git a/extra.js b/extra.js
new file mode 100644
--- /dev/null
+++ b/extra.js
@@ -0,0 +1 @@
+module.exports = 42
`;
    const { project, graft, root } = await withV2(V3, created);
    await writeFile(path.join(root, 'upstream', '2.0.0', 'extra.js'), 'module.exports = 42\n');
    const report = await patchAdapter.checkAnchors(project.context(graft), '2.0.0');
    expect(report.upstreamed?.evidence[0]).toMatch(/extra\.js already exists/);
    await writeFile(path.join(root, 'upstream', '2.0.0', 'extra.js'), 'module.exports = 43\n');
    expect((await patchAdapter.checkAnchors(project.context(graft), '2.0.0')).upstreamed).toBeUndefined();
  });

  it('does not flag partial absorption (only some hunks upstream)', async () => {
    const tail = `function f() {}\nfunction g() {}\nmodule.exports.f = f\n`;
    const { project, graft } = await withV2(PATCHED + tail, TWO_HUNKS);
    const report = await patchAdapter.checkAnchors(project.context(graft), '2.0.0');
    expect(report.ok).toBe(false);
    expect(report.upstreamed).toBeUndefined();
    const result = await sync(project, { version: '2.0.0', writeReport: false });
    expect(result.grafts[0]).toMatchObject({ outcome: 'needs-agent' });
    expect(result.grafts[0]?.likelyUpstreamed).toBeUndefined();
  });

  it('does not flag a version that simply moved the anchors', async () => {
    const { project, graft } = await fixture('1.0.0');
    expect((await patchAdapter.checkAnchors(project.context(graft), '2.0.0')).upstreamed).toBeUndefined();
  });
});

describe('onboarding a new graft (found by testing against a real project)', () => {
  it('scaffolds a .patch variant for the patch mechanism, which fails loudly until written', async () => {
    const { project, root } = await fixture('1.0.0');
    const files = await addGraft(project, { id: 'new-one', package: 'lib', mechanism: 'patch' });
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
