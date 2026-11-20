import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addGraft,
  checkAnchors,
  DirectoryUpstreamSource,
  isHashedChunkRename,
  Project,
  projectStatus,
  recordVariant,
  renderSyncMarkdown,
  replay,
  sync,
  updateGraft,
  type MechanismAdapter,
} from '@graftsync/core';
import {
  applyToInstalledCopy,
  configurePnpmPatch,
  installedPnpmVersions,
  patchAdapter,
  pnpmApplier,
  pnpmConfigProblems,
  pnpmMajor,
  pnpmPackageExtensionWarnings,
} from '../src/index.js';

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

async function fixture(installed: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-patch-'));
  const up: Record<string, string> = {};
  for (const [v, code] of [
    ['1.0.0', V1],
    ['1.1.0', V2],
    ['2.0.0', V3],
  ] as const) {
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
    `---\nid: add-c\nrootstock: { package: lib, verified: 1.0.0 }\nmechanism: patch\nvariants:\n  - range: ">=1.0.0"\n    module: ./variants/v1.patch\n---\n## Why\nw\n## Invariants\ni\n## Where to look\nl\n## Anchors\na\n## History\n- created\n`,
  );
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'pnpm@10.28.0' }));
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
  it('is green and bumps verified when the anchors hold and the variant applies', async () => {
    const { project, root } = await fixture('1.1.0');
    const report = await sync(project, { writeReport: false });
    expect(report.exitCode).toBe(0);
    expect(report.grafts[0]).toMatchObject({ outcome: 'green', updated: true });
    expect(await readFile(path.join(root, '.grafts/add-c/graft.md'), 'utf8')).toContain('verified: 1.1.0');
  });

  it('a dry run against an uninstalled version runs the static checks only and records nothing (#51)', async () => {
    const { project, root } = await fixture('1.0.0');
    const report = await sync(project, { version: '1.1.0', dryRun: true, writeReport: false });
    expect(report.exitCode, JSON.stringify(report.grafts)).toBe(0);
    expect(report.targets[0]?.installCommand).toBeUndefined();
    expect(report.grafts[0]).toMatchObject({ outcome: 'green' });
    expect(report.grafts[0]!.reasons.join('\n')).toMatch(/static checks only: lib@1\.1\.0 is not installed \(installed: 1\.0\.0\)/);
    expect(await readFile(path.join(root, '.grafts/add-c/graft.md'), 'utf8')).toContain('verified: 1.0.0');
    // A broken target still fails the static checks in a dry run.
    expect((await sync(project, { version: '2.0.0', dryRun: true, writeReport: false })).grafts[0]?.outcome).toBe('needs-agent');
    // Without --dry-run it still needs --install.
    expect((await sync(project, { version: '1.1.0', writeReport: false })).exitCode).toBe(2);
  });

  it('hands off to an agent without installing when anchors miss', async () => {
    const { project } = await fixture('1.0.0');
    const report = await sync(project, { version: '2.0.0', install: true });
    expect(report.exitCode).toBe(1);
    expect(report.targets[0]?.installCommand).toBeUndefined();
    expect(report.grafts[0]?.outcome).toBe('needs-agent');
    expect(await readFile(report.grafts[0]!.diffPath!, 'utf8')).toContain('-const b = 2');
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
    expect(md).toMatch(/Next: .*`graft mark add-c --status upstreamed/);
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

const V3_PATCH = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1,2 +1,3 @@
 const a = 1
+const c = 3
 module.exports = { a }
`;

/** Fixture whose graft has a generator; target 2.0.0 is installed and the v1 variant misses there. */
async function generatorFixture(opts: { generator?: string; patch?: string } = {}) {
  const { root } = await fixture('2.0.0');
  // Use Graft's built-in applier so the installed-version checks don't depend on pnpm wiring.
  await writeFile(path.join(root, '.grafts/config.json'), JSON.stringify({ mechanisms: { patch: { applier: 'graft' } } }));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'app', scripts: { postinstall: 'graft apply --installed' }, devDependencies: { '@graftsync/cli': '*' } }),
  );
  await writeFile(path.join(root, 'v3.patch'), opts.patch ?? V3_PATCH);
  // Copies the prepared patch to {out}, and checks the environment it is given.
  await writeFile(
    path.join(root, 'gen.mjs'),
    `import { copyFileSync } from 'node:fs';
const [version, out] = process.argv.slice(2);
if (version !== process.env.GRAFT_UPSTREAM_VERSION || process.env.GRAFT_PACKAGE !== 'lib' || process.env.GRAFT_ID !== 'add-c') process.exit(9);
if (!process.env.GRAFT_VARIANT_OUT.endsWith(out)) process.exit(8);
copyFileSync('v3.patch', out);
`,
  );
  const file = path.join(root, '.grafts/add-c/graft.md');
  const md = (await readFile(file, 'utf8')).replace(
    /^variants:/m,
    `generator: { command: '${opts.generator ?? 'node gen.mjs {version} {out}'}' }\nvariants:`,
  );
  await writeFile(file, md);
  const upstream = new DirectoryUpstreamSource(
    { lib: Object.fromEntries(['1.0.0', '1.1.0', '2.0.0'].map((v) => [v, path.join(root, 'upstream', v)])) },
    { lib: '2.0.0' },
  );
  const project = await Project.open({ root, adapters: [patchAdapter], upstream });
  return { root, project, file, original: md };
}

describe('sync regenerates generated variants', () => {
  it('regenerates, registers, and verifies a variant when the old one no longer fits', async () => {
    const { project, root, file } = await generatorFixture();
    const report = await sync(project, { writeReport: false });
    expect(report.exitCode, JSON.stringify(report.grafts[0]?.reasons)).toBe(0);
    expect(report.grafts[0]).toMatchObject({
      outcome: 'green',
      updated: true,
      regenerated: { module: './variants/v2.0.0.patch', command: 'node gen.mjs 2.0.0 .grafts/add-c/variants/v2.0.0.patch' },
    });
    const md = await readFile(file, 'utf8');
    expect(md).toContain('verified: 2.0.0');
    expect(md).toContain('range: ">=1.0.0 <2.0.0"');
    expect(md).toMatch(/module: \.\/variants\/v2\.0\.0\.patch/);
    expect(md).toContain('Regenerated by `node gen.mjs 2.0.0 .grafts/add-c/variants/v2.0.0.patch` for lib@2.0.0');
    expect(await readFile(path.join(root, '.grafts/add-c/variants/v2.0.0.patch'), 'utf8')).toBe(V3_PATCH);
    expect(renderSyncMarkdown(report)).toContain('./variants/v2.0.0.patch');
  });

  it('hands off to an agent, explaining why, when the generator fails', async () => {
    const { project, root, file, original } = await generatorFixture({ generator: 'node -e "process.exit(4)" {out}' });
    const report = await sync(project, { writeReport: false });
    expect(report.grafts[0]?.outcome).toBe('needs-agent');
    expect(report.grafts[0]?.regenerated).toBeUndefined();
    expect(report.grafts[0]?.reasons.join('\n')).toMatch(/generator `node -e "process.exit\(4\)" .*` failed \(exit 4\)/);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(existsSync(path.join(root, '.grafts/add-c/variants/v2.0.0.patch'))).toBe(false);
  });

  it('reports the error message, not the stack trace under it, when the generator throws', async () => {
    const { project, root } = await generatorFixture({ generator: 'node throws.mjs {out}' });
    await writeFile(path.join(root, 'throws.mjs'), "throw new TypeError('no CommonJS left to convert');\n");
    const report = await sync(project, { writeReport: false });
    const reasons = report.grafts[0]?.reasons.join('\n') ?? '';
    expect(reasons).toMatch(/failed \(exit 1\): TypeError: no CommonJS left to convert/);
    expect(reasons).not.toMatch(/Node\.js v|\bat /);
  });

  it('a generator exiting GRAFT_EXIT_UPSTREAMED marks the graft likely upstreamed', async () => {
    const { project, root, file, original } = await generatorFixture({ generator: 'node upstreamed.mjs {out}' });
    await writeFile(
      path.join(root, 'upstreamed.mjs'),
      "console.error('lib ships it now');\nprocess.exit(Number(process.env.GRAFT_EXIT_UPSTREAMED));\n",
    );
    const report = await sync(project, { writeReport: false });
    const g = report.grafts[0]!;
    expect(g).toMatchObject({ outcome: 'needs-agent', likelyUpstreamed: true });
    expect(g.reasons[0]).toMatch(
      /upstream lib@2\.0\.0 already does what this graft did, says its generator .* \(lib ships it now\); confirm and set status: upstreamed/,
    );
    expect(renderSyncMarkdown(report)).toContain('likely upstreamed');
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(existsSync(path.join(root, '.grafts/add-c/variants/v2.0.0.patch'))).toBe(false);
  });

  it('rolls back a regenerated variant that still does not fit', async () => {
    const { project, root, file, original } = await generatorFixture({ patch: PATCH.replace('const b = 2', 'const zzz = 2') });
    const report = await sync(project, { writeReport: false });
    expect(report.grafts[0]?.outcome).toBe('needs-agent');
    expect(report.grafts[0]?.reasons.join('\n')).toMatch(/wrote \.\/variants\/v2\.0\.0\.patch, but it could not be registered/);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(existsSync(path.join(root, '.grafts/add-c/variants/v2.0.0.patch'))).toBe(false);
  });

  it('only generates into the report directory on a dry run', async () => {
    const { project, root, file, original } = await generatorFixture();
    const report = await sync(project, { writeReport: false, dryRun: true });
    expect(report.grafts[0]).toMatchObject({ outcome: 'green', regenerated: { module: '../.report/add-c/regenerated/v2.0.0.patch' } });
    expect(report.grafts[0]?.updated).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(existsSync(path.join(root, '.grafts/add-c/variants/v2.0.0.patch'))).toBe(false);
    expect(existsSync(path.join(root, '.grafts/.report/add-c/regenerated/v2.0.0.patch'))).toBe(true);
  });
});

describe('onboarding a new graft (found by testing against a real project)', () => {
  it('scaffolds a .patch variant for the patch mechanism, which fails loudly until written', async () => {
    const { project, root } = await fixture('1.0.0');
    const files = await addGraft(project, { id: 'new-one', package: 'other-lib', version: '1.0.0', mechanism: 'patch' });
    expect(files.some((f) => f.endsWith(path.join('variants', 'v1.patch')))).toBe(true);
    const report = await patchAdapter.checkAnchors(project.context(await project.get('new-one')), '1.0.0');
    expect(report.errors.join('\n')).toMatch(/contains no hunks/);
    expect(await readFile(path.join(root, '.grafts/new-one/graft.md'), 'utf8')).not.toContain('oracle');
    expect(files.some((f) => f.includes('oracle'))).toBe(false);
  });

  it('flags and removes pnpm.patchedDependencies entries that pnpm patch-commit writes to package.json', async () => {
    const { root } = await fixture('1.0.0');
    const variant = path.join(root, '.grafts/add-c/variants/v1.patch');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify(
        { name: 'app', pnpm: { overrides: { x: '1' }, patchedDependencies: { 'lib@1.0.0': 'patches/lib@1.0.0.patch', other: 'o.patch' } } },
        null,
        2,
      ),
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

describe('checkInstalled separation (#61)', () => {
  it('replay and recordVariant --verify-version stay static on the installed version, while check and sync still fail loudly', async () => {
    const { project, root } = await fixture('1.1.0');
    // Break the local pnpm wiring so the installed 1.1.0 copy is NOT configured for the patch.
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n');

    // Static replay passes 1.0.0 and 1.1.0 (fails 2.0.0 on the real anchor miss).
    const entries = await replay(project, 'add-c');
    expect(entries.map((e) => [e.version, e.ok])).toEqual([
      ['1.0.0', true],
      ['1.1.0', true],
      ['2.0.0', false],
    ]);

    // Registering a new variant verified against the already-installed 1.1.0 succeeds before `graft apply`.
    await writeFile(path.join(root, '.grafts/add-c/variants/v1.1.patch'), PATCH);
    await expect(
      recordVariant(project, 'add-c', { range: '>=1.1.0', module: './variants/v1.1.patch' }, { verifyVersion: '1.1.0' }),
    ).resolves.toBeDefined();

    // `graft check` and `graft sync` at the installed version still fail loudly via checkInstalled.
    const checked = await checkAnchors(project, 'add-c');
    expect(checked.ok).toBe(false);
    expect(checked.errors.join('\n')).toMatch(/ignorePatchFailures/);

    const synced = await sync(project, { writeReport: false });
    expect(synced.exitCode).toBe(1);
    expect(synced.grafts[0]?.outcome).toBe('needs-agent');
    expect(synced.grafts[0]?.reasons.join('\n')).toMatch(/ignorePatchFailures/);
  });
});

describe('CRLF upstream files with LF patches (#67)', () => {
  async function crlfFixture(installedContent: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-crlf-'));
    const v1 = path.join(root, 'upstream/1.0.0');
    const v2 = path.join(root, 'upstream/2.0.0');
    const v3 = path.join(root, 'upstream/3.0.0');
    const installedDir = path.join(root, 'node_modules/lib');
    for (const dir of [v1, v2, v3, installedDir]) await mkdir(dir, { recursive: true });
    const crlfV1 = V1.replace(/\n/g, '\r\n');
    const crlfPatched = `const a = 1\r\nconst b = 2\r\nconst c = 3\r\nmodule.exports = { a, b }\r\n`;
    await writeFile(path.join(v1, 'index.js'), crlfV1);
    await writeFile(path.join(v1, 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));
    await writeFile(path.join(v2, 'index.js'), crlfPatched);
    await writeFile(path.join(v2, 'package.json'), JSON.stringify({ name: 'lib', version: '2.0.0' }));
    await writeFile(path.join(v3, 'index.js'), V3.replace(/\n/g, '\r\n'));
    await writeFile(path.join(v3, 'package.json'), JSON.stringify({ name: 'lib', version: '3.0.0' }));
    await writeFile(path.join(installedDir, 'index.js'), installedContent);
    await writeFile(path.join(installedDir, 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));

    const g = path.join(root, '.grafts/add-c');
    await mkdir(path.join(g, 'variants'), { recursive: true });
    await writeFile(path.join(g, 'variants/v1.patch'), PATCH);
    await writeFile(
      path.join(g, 'graft.md'),
      `---
id: add-c
rootstock:
  package: lib
  verified: 1.0.0
mechanism: patch
variants:
  - range: '>=1.0.0'
    module: ./variants/v1.patch
---
## Why
w
## Invariants
i
## Where to look
l
## Anchors
a
## History
- created
`,
    );
    await writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      `packages: []\npatchedDependencies:\n  lib: .grafts/add-c/variants/v1.patch\nignorePatchFailures: false\n`,
    );
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'pnpm@10.28.0' }));
    const upstream = new DirectoryUpstreamSource({ lib: { '1.0.0': v1, '2.0.0': v2, '3.0.0': v3 } }, { lib: '1.0.0' });
    upstream.installed = async (pkg) => (pkg === 'lib' ? { version: '1.0.0', dir: installedDir } : undefined);
    const project = await Project.open({ root, adapters: [patchAdapter], upstream });
    return { root, project, installedDir, crlfV1, crlfPatched };
  }

  it('matches anchors, applies preserving CRLF, detects upstreamed, and tolerates mixed CRLF/LF installed copies', async () => {
    // Mixed CRLF/LF as written by pnpm when applying an LF patch to a CRLF file.
    const mixedInstalled = `const a = 1\r\nconst b = 2\r\nconst c = 3\nmodule.exports = { a, b }\r\n`;
    const { project, installedDir, crlfV1, crlfPatched } = await crlfFixture(mixedInstalled);
    const graft = await project.get('add-c');

    const checked = await checkAnchors(project, 'add-c');
    expect(checked.ok).toBe(true);
    expect(checked.errors).toEqual([]);

    const applied = await patchAdapter.apply(project.context(graft));
    expect(applied.ok).toBe(true);

    // Upstreamed detection still works on CRLF files.
    const absorbed = await patchAdapter.checkAnchors(project.context(graft), '2.0.0');
    expect(absorbed.ok).toBe(false);
    expect(absorbed.upstreamed?.evidence.length).toBeGreaterThan(0);

    // Genuine anchor miss still fails on CRLF files.
    const missed = await patchAdapter.checkAnchors(project.context(graft), '3.0.0');
    expect(missed.ok).toBe(false);
    expect(missed.upstreamed).toBeUndefined();

    // Built-in postinstall applier handles CRLF cleanly and is idempotent.
    await writeFile(path.join(installedDir, 'index.js'), crlfV1);
    const patches = (await import('../src/index.js')).parsePatchFile(PATCH);
    const first = await applyToInstalledCopy({ dir: installedDir, version: '1.0.0' }, patches);
    expect(first.action).toBe('patched');
    expect(await readFile(path.join(installedDir, 'index.js'), 'utf8')).toBe(crlfPatched);
    const second = await applyToInstalledCopy({ dir: installedDir, version: '1.0.0' }, patches);
    expect(second.action).toBe('already-patched');
  });

  it('still fails checkInstalled when a CRLF installed file is unpatched or altered', async () => {
    const unpatchedCrlf = V1.replace(/\n/g, '\r\n');
    const { project } = await crlfFixture(unpatchedCrlf);
    const checked = await checkAnchors(project, 'add-c');
    expect(checked.ok).toBe(false);
    expect(checked.errors.join('\n')).toMatch(/is not patched/);
  });
});

describe('zero-byte deleted and created files (#69)', () => {
  const DELETE_EMPTY_PATCH = `diff --git a/empty.txt b/empty.txt
deleted file mode 100644
index e69de29..0000000
`;
  const CREATE_EMPTY_PATCH = `diff --git a/created.txt b/created.txt
new file mode 100644
index 0000000..e69de29
`;

  async function zeroByteFixture(patchText: string, upstreamFiles: Record<string, string>, installedFiles: Record<string, string>) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-zerobyte-'));
    const v1 = path.join(root, 'upstream/1.0.0');
    const installedDir = path.join(root, 'node_modules/lib');
    await mkdir(v1, { recursive: true });
    await mkdir(installedDir, { recursive: true });
    await writeFile(path.join(v1, 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));
    await writeFile(path.join(installedDir, 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));
    for (const [f, content] of Object.entries(upstreamFiles)) await writeFile(path.join(v1, f), content);
    for (const [f, content] of Object.entries(installedFiles)) await writeFile(path.join(installedDir, f), content);

    const g = path.join(root, '.grafts/empty-op');
    await mkdir(path.join(g, 'variants'), { recursive: true });
    await writeFile(path.join(g, 'variants/v1.patch'), patchText);
    await writeFile(
      path.join(g, 'graft.md'),
      `---
id: empty-op
rootstock:
  package: lib
  verified: 1.0.0
mechanism: patch
variants:
  - range: '>=1.0.0'
    module: ./variants/v1.patch
---
## Why
w
## Invariants
i
## Where to look
l
## Anchors
a
## History
- created
`,
    );
    await writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      `packages: []\npatchedDependencies:\n  lib: .grafts/empty-op/variants/v1.patch\nignorePatchFailures: false\n`,
    );
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'pnpm@10.28.0' }));
    const upstream = new DirectoryUpstreamSource({ lib: { '1.0.0': v1 } }, { lib: '1.0.0' });
    upstream.installed = async (pkg) => (pkg === 'lib' ? { version: '1.0.0', dir: installedDir } : undefined);
    const project = await Project.open({ root, adapters: [patchAdapter], upstream });
    return { root, project, installedDir };
  }

  it('supports zero-byte deleted files in checkAnchors, apply, applyToInstalledCopy, and checkInstalled', async () => {
    const { project, installedDir } = await zeroByteFixture(DELETE_EMPTY_PATCH, { 'empty.txt': '' }, {});
    const graft = await project.get('empty-op');

    const checked = await checkAnchors(project, 'empty-op');
    expect(checked.ok).toBe(true);
    expect(checked.anchors).toMatchObject([{ name: 'empty.txt#delete', matched: true }]);

    const applied = await patchAdapter.apply(project.context(graft));
    expect(applied.ok).toBe(true);
    expect(applied.files).toEqual([{ file: 'empty.txt', changed: true }]);

    // Built-in applier deletes the file and is idempotent.
    await writeFile(path.join(installedDir, 'empty.txt'), '');
    const patches = (await import('../src/index.js')).parsePatchFile(DELETE_EMPTY_PATCH);
    const first = await applyToInstalledCopy({ dir: installedDir, version: '1.0.0' }, patches);
    expect(first.action).toBe('patched');
    expect(existsSync(path.join(installedDir, 'empty.txt'))).toBe(false);
    const second = await applyToInstalledCopy({ dir: installedDir, version: '1.0.0' }, patches);
    expect(second.action).toBe('already-patched');
  });

  it('fails checkInstalled when a deleted zero-byte file is still present, and flags upstreamed when already absent', async () => {
    const stillThere = await zeroByteFixture(DELETE_EMPTY_PATCH, { 'empty.txt': '' }, { 'empty.txt': '' });
    const checked = await checkAnchors(stillThere.project, 'empty-op');
    expect(checked.ok).toBe(false);
    expect(checked.errors.join('\n')).toMatch(/empty\.txt was not deleted/);

    const alreadyGone = await zeroByteFixture(DELETE_EMPTY_PATCH, {}, {});
    const staticCheck = await patchAdapter.checkAnchors(alreadyGone.project.context(await alreadyGone.project.get('empty-op')), '1.0.0');
    expect(staticCheck.ok).toBe(false);
    expect(staticCheck.upstreamed?.evidence.join('\n')).toMatch(/empty\.txt/);

    // pnpm patch-commit also writes hunkless `deleted file mode` for non-empty deleted files (e.g. CHANGELOG.md).
    const nonEmpty = await zeroByteFixture(DELETE_EMPTY_PATCH, { 'empty.txt': '# Changelog\nline 2\n' }, {});
    const nonEmptyCheck = await checkAnchors(nonEmpty.project, 'empty-op');
    expect(nonEmptyCheck.ok).toBe(true);
    expect((await patchAdapter.apply(nonEmpty.project.context(await nonEmpty.project.get('empty-op')))).ok).toBe(true);
  });

  it('supports zero-byte created files and fails if the file already exists upstream', async () => {
    const { project, installedDir } = await zeroByteFixture(CREATE_EMPTY_PATCH, {}, { 'created.txt': '' });
    const graft = await project.get('empty-op');
    expect((await checkAnchors(project, 'empty-op')).ok).toBe(true);
    expect((await patchAdapter.apply(project.context(graft))).ok).toBe(true);

    // Missing from installed copy fails checkInstalled.
    const missingInstalled = await zeroByteFixture(CREATE_EMPTY_PATCH, {}, {});
    expect((await checkAnchors(missingInstalled.project, 'empty-op')).ok).toBe(false);

    // Already exists upstream fails checkAnchors.
    const existsUpstream = await zeroByteFixture(CREATE_EMPTY_PATCH, { 'created.txt': '' }, { 'created.txt': '' });
    const checkUp = await patchAdapter.checkAnchors(existsUpstream.project.context(await existsUpstream.project.get('empty-op')), '1.0.0');
    expect(checkUp.ok).toBe(false);

    // Built-in applier creates the empty file idempotently.
    const patches = (await import('../src/index.js')).parsePatchFile(CREATE_EMPTY_PATCH);
    const targetDir = path.join(installedDir, '../fresh');
    await mkdir(targetDir, { recursive: true });
    expect((await applyToInstalledCopy({ dir: targetDir, version: '1.0.0' }, patches)).action).toBe('patched');
    expect(await readFile(path.join(targetDir, 'created.txt'), 'utf8')).toBe('');
    expect((await applyToInstalledCopy({ dir: targetDir, version: '1.0.0' }, patches)).action).toBe('already-patched');
  });
});

describe('pnpm 11+ and multi-version workspaces (#68, #70)', () => {
  it('skips ignorePatchFailures on pnpm >= 11 (packageManager or devEngines) and enforces it on pnpm 10 (#70)', async () => {
    const root11 = await mkdtemp(path.join(os.tmpdir(), 'graft-pnpm11-'));
    const variant11 = path.join(root11, '.grafts/fix/variants/v1.patch');
    await writeFile(path.join(root11, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'pnpm@11.28.6' }));
    await writeFile(path.join(root11, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\nignorePatchFailures: false\n');
    expect(pnpmMajor(root11)).toBe(11);

    await configurePnpmPatch(root11, 'lib', variant11, '1.0.0');
    const ws11 = await readFile(path.join(root11, 'pnpm-workspace.yaml'), 'utf8');
    expect(ws11).not.toContain('ignorePatchFailures');
    expect(await pnpmConfigProblems(root11, 'lib', variant11, '1.0.0')).toEqual([]);

    // devEngines.packageManager also detected.
    const root12 = await mkdtemp(path.join(os.tmpdir(), 'graft-pnpm12-'));
    await writeFile(
      path.join(root12, 'package.json'),
      JSON.stringify({ name: 'app', devEngines: { packageManager: { name: 'pnpm', version: '^12.0.0' } } }),
    );
    expect(pnpmMajor(root12)).toBe(12);

    // pnpm 10 still requires and writes ignorePatchFailures: false.
    const root10 = await mkdtemp(path.join(os.tmpdir(), 'graft-pnpm10-'));
    const variant10 = path.join(root10, '.grafts/fix/variants/v1.patch');
    await writeFile(path.join(root10, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'pnpm@10.28.0' }));
    await writeFile(path.join(root10, 'pnpm-workspace.yaml'), 'packages: []\npatchedDependencies:\n  lib: .grafts/fix/variants/v1.patch\n');
    expect(pnpmMajor(root10)).toBe(10);
    expect((await pnpmConfigProblems(root10, 'lib', variant10, '1.0.0')).join('\n')).toMatch(/ignorePatchFailures/);
    await configurePnpmPatch(root10, 'lib', variant10, '1.0.0');
    expect(await readFile(path.join(root10, 'pnpm-workspace.yaml'), 'utf8')).toContain('ignorePatchFailures: false');
    expect(await pnpmConfigProblems(root10, 'lib', variant10, '1.0.0')).toEqual([]);
  });

  it('pins patchedDependencies to pkg@version when multiple versions exist in node_modules/.pnpm (#68)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-pnpm-multi-'));
    const variant = path.join(root, '.grafts/cac-fix/variants/v6.patch');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'pnpm@11.28.6' }));
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await mkdir(path.join(root, 'node_modules/.pnpm/cac@6.7.14_patch_hash=abc'), { recursive: true });
    await mkdir(path.join(root, 'node_modules/.pnpm/cac@7.1.0'), { recursive: true });
    await mkdir(path.join(root, 'node_modules/.pnpm/@scope+pkg@1.0.0_react@19.0.0'), { recursive: true });
    await mkdir(path.join(root, 'node_modules/.pnpm/@scope+pkg@2.0.0'), { recursive: true });

    expect(installedPnpmVersions(root, 'cac')).toEqual(['6.7.14', '7.1.0']);
    expect(installedPnpmVersions(root, '@scope/pkg')).toEqual(['1.0.0', '2.0.0']);

    // A name-only key is flagged as conflicting with the other installed version.
    await writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\npatchedDependencies:\n  cac: .grafts/cac-fix/variants/v6.patch\n',
    );
    const nameOnlyProblems = await pnpmApplier.problems(root, 'cac', '6.7.14', variant);
    expect(nameOnlyProblems.join('\n')).toMatch(/name-only key.*7\.1\.0.*cac@6\.7\.14/);

    // configure rewrites it to cac@6.7.14.
    await pnpmApplier.configure(root, 'cac', '6.7.14', variant);
    const ws = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    expect(ws).toContain('cac@6.7.14: .grafts/cac-fix/variants/v6.patch');
    expect(ws).not.toMatch(/\n\s*cac:/);
    expect(await pnpmApplier.problems(root, 'cac', '6.7.14', variant)).toEqual([]);

    // Upgrading to a new version flags the old pinned key and rewrites cleanly.
    expect((await pnpmApplier.problems(root, 'cac', '6.7.15', variant)).join('\n')).toMatch(/does not match cac@6\.7\.15/);
    await pnpmApplier.configure(root, 'cac', '6.7.15', variant);
    expect(await pnpmApplier.problems(root, 'cac', '6.7.15', variant)).toEqual([]);

    // Single-version workspace still uses name-only keys even when configuring a new target version.
    await mkdir(path.join(root, 'node_modules/.pnpm/acorn@8.11.3'), { recursive: true });
    const acornVariant = path.join(root, '.grafts/acorn-fix/variants/v8.patch');
    await pnpmApplier.configure(root, 'acorn', '8.12.0', acornVariant);
    expect(await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).toContain('acorn: .grafts/acorn-fix/variants/v8.patch');
    expect(await pnpmApplier.problems(root, 'acorn', '8.12.0', acornVariant)).toEqual([]);
  });

  it('warns when pnpm packageExtensions has stale version-pinned keys (#79)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-pnpm-ext-warn-'));
    await writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - .\npackageExtensions:\n  "playwright-core@1.64.1":\n    dependencies:\n      acorn: 8.19.0\n  baileys:\n    peerDependenciesMeta:\n      sharp:\n        optional: true\n',
    );
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'pnpm@12.15.0' }));

    // Matching version: no warning.
    expect(await pnpmPackageExtensionWarnings(root, 'playwright-core', '1.64.1')).toEqual([]);
    // Bare key: covers every version, no warning.
    expect(await pnpmPackageExtensionWarnings(root, 'baileys', '7.0.0')).toEqual([]);
    // Upgraded version with stale pin: warns loudly.
    const warnings = await pnpmPackageExtensionWarnings(root, 'playwright-core', '1.65.0');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/playwright-core@1\.64\.1.*does not match installed playwright-core@1\.65\.0/);

    // If the older version is also still installed in .pnpm, no false warning.
    await mkdir(path.join(root, 'node_modules/.pnpm/playwright-core@1.64.1'), { recursive: true });
    await mkdir(path.join(root, 'node_modules/.pnpm/playwright-core@1.65.0'), { recursive: true });
    expect(await pnpmPackageExtensionWarnings(root, 'playwright-core', '1.65.0')).toEqual([]);
  });
});

describe('applier hunk offset limits (#77)', () => {
  it('fails checkAnchors, apply, and sync when hunk drift exceeds pnpm ±20-line limit, and passes within ±20 or under graft applier', async () => {
    const { root, upstream } = await fixture('1.0.0');
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'pnpm@12.15.0' }));

    const makeShifted = async (version: string, extraLines: number) => {
      const dir = path.join(root, 'upstream', version);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'lib', version }));
      const pad = Array.from({ length: extraLines }, (_, i) => `// pad ${i + 1}`).join('\n') + '\n';
      await writeFile(path.join(dir, 'index.js'), pad + V1);
      (upstream as unknown as { dirs: Record<string, Record<string, string>> }).dirs.lib![version] = dir;
    };
    await makeShifted('1.1.0', 20);
    await makeShifted('1.2.0', 22);

    const project = await Project.open({ root, adapters: [patchAdapter], upstream });
    const graft = await project.get('add-c');

    // +20 lines: right at pnpm's limit, still passes.
    const at20 = await patchAdapter.checkAnchors(project.context(graft), '1.1.0');
    expect(at20.ok).toBe(true);
    expect(at20.anchors[0]?.error).toContain('+20 lines');
    const apply20 = await patchAdapter.apply(project.context(graft), { version: '1.1.0' });
    expect(apply20.ok).toBe(true);

    // +22 lines: exceeds pnpm's ±20-line limit, fails checkAnchors, apply, and sync --dry-run.
    const at22 = await patchAdapter.checkAnchors(project.context(graft), '1.2.0');
    expect(at22.ok).toBe(false);
    expect(at22.anchors[0]?.matched).toBe(false);
    expect(at22.anchors[0]?.location?.line).toBe(23);
    expect(at22.anchors[0]?.error).toMatch(/\+22 lines.*pnpm.*±20-line hunk offset limit/);

    const apply22 = await patchAdapter.apply(project.context(graft), { version: '1.2.0' });
    expect(apply22.ok).toBe(false);
    expect(apply22.files[0]?.error).toMatch(/\+22 lines.*pnpm.*±20-line offset limit/);

    const report = await sync(project, { version: '1.2.0', dryRun: true, writeReport: false });
    expect(report.exitCode).toBe(1);
    expect(report.grafts[0]?.outcome).toBe('needs-agent');

    // Under Graft's own built-in applier (unlimited offset), +22 lines still succeeds.
    await writeFile(path.join(root, '.grafts/config.json'), JSON.stringify({ mechanisms: { patch: { applier: 'graft' } } }));
    const graftApplierProject = await Project.open({ root, adapters: [patchAdapter], upstream });
    const graftGraft = await graftApplierProject.get('add-c');
    expect((await patchAdapter.checkAnchors(graftApplierProject.context(graftGraft), '1.2.0')).ok).toBe(true);
    expect((await patchAdapter.apply(graftApplierProject.context(graftGraft), { version: '1.2.0' })).ok).toBe(true);
  });
});

describe('hashed bundler chunk renames in scoped diff (#80)', () => {
  it('recognizes hashed bundler chunk renames without false positives on normal words', () => {
    expect(isHashedChunkRename('dist/chunks/cac.CLrZKo1g.js', 'dist/chunks/cac.BYbt0aJp.js')).toBe(true);
    expect(isHashedChunkRename('dist/chunks/plugin.d.C8mmycim.d.ts', 'dist/chunks/plugin.d.LRFSN46m.d.ts')).toBe(true);
    expect(isHashedChunkRename('dist/chunk-a1b2c3d4.mjs', 'dist/chunk-e5f6a7b8.mjs')).toBe(true);
    expect(isHashedChunkRename('dist/foo.client.js', 'dist/foo.server.js')).toBe(false);
    expect(isHashedChunkRename('dist/chunks/cac.CLrZKo1g.js', 'lib/chunks/cac.BYbt0aJp.js')).toBe(false);
    expect(isHashedChunkRename('dist/chunks/cac.CLrZKo1g.js', 'dist/chunks/run.BYbt0aJp.js')).toBe(false);
  });

  it('diffs a renamed hashed chunk against its new counterpart instead of dumping the whole file as deleted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-chunk-rename-'));
    const body = (extra: string) =>
      [
        ...Array.from({ length: 30 }, (_, i) => `const top${i} = ${i};`),
        'function parseArgs(argv) {',
        '  const flag = argv[0];',
        `  return flag${extra};`,
        '}',
        ...Array.from({ length: 30 }, (_, i) => `const bot${i} = ${i};`),
      ].join('\n') + '\n';

    const v1 = path.join(root, 'up/1.0.0');
    const v2 = path.join(root, 'up/1.1.0');
    await mkdir(path.join(v1, 'dist/chunks'), { recursive: true });
    await mkdir(path.join(v2, 'dist/chunks'), { recursive: true });
    await writeFile(path.join(v1, 'package.json'), JSON.stringify({ name: 'bundler-lib', version: '1.0.0' }));
    await writeFile(path.join(v2, 'package.json'), JSON.stringify({ name: 'bundler-lib', version: '1.1.0' }));
    await writeFile(path.join(v1, 'dist/chunks/cac.CLrZKo1g.js'), body(''));
    await writeFile(path.join(v2, 'dist/chunks/cac.BYbt0aJp.js'), body(' ?? ""').replace('const top0 = 0;', 'const top0 = 999;'));

    const gDir = path.join(root, '.grafts/cac-fix');
    await mkdir(path.join(gDir, 'variants'), { recursive: true });
    await writeFile(
      path.join(gDir, 'variants/v1.patch'),
      [
        'diff --git a/dist/chunks/cac.CLrZKo1g.js b/dist/chunks/cac.CLrZKo1g.js',
        '--- a/dist/chunks/cac.CLrZKo1g.js',
        '+++ b/dist/chunks/cac.CLrZKo1g.js',
        '@@ -31,4 +31,4 @@',
        ' function parseArgs(argv) {',
        '   const flag = argv[0];',
        '-  return flag;',
        '+  return flag.trim();',
        ' }',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(gDir, 'graft.md'),
      `---
id: cac-fix
rootstock:
  package: bundler-lib
  verified: 1.0.0
mechanism: patch
status: applied
variants:
  - range: ">=1.0.0"
    module: ./variants/v1.patch
---
## Why
Trim parsed flag.
## Invariants
Parsed flags are trimmed.
## Where to look
The parseArgs helper in the cac chunk.
## Anchors
The parseArgs return statement.
## History
- 2026-01-01: created
`,
    );

    const upstream = new DirectoryUpstreamSource({ 'bundler-lib': { '1.0.0': v1, '1.1.0': v2 } }, { 'bundler-lib': '1.0.0' });
    const project = await Project.open({ root, adapters: [patchAdapter], upstream });
    const graft = await project.get('cac-fix');
    const diff = await patchAdapter.scopeDiff(project.context(graft), '1.0.0', '1.1.0');

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({
      file: 'dist/chunks/cac.CLrZKo1g.js',
      newFile: 'dist/chunks/cac.BYbt0aJp.js',
      status: 'modified',
      totalHunks: 2,
      narrowed: true,
    });
    expect(diff.files[0]!.hunks).toHaveLength(1);
    expect(diff.patch).toContain('--- a/dist/chunks/cac.CLrZKo1g.js\t(bundler-lib@1.0.0)');
    expect(diff.patch).toContain('+++ b/dist/chunks/cac.BYbt0aJp.js\t(bundler-lib@1.1.0)');
    expect(diff.patch).toContain('# renamed: dist/chunks/cac.CLrZKo1g.js -> dist/chunks/cac.BYbt0aJp.js');
    expect(diff.patch).toContain('# narrowed: showing 1 of 2 hunks');
    expect(diff.patch).not.toContain('const top0 = 999');
  });
});
