import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DirectoryUpstreamSource,
  GraftError,
  Project,
  renderSyncMarkdown,
  sync,
  type InstalledPackage,
  type MechanismAdapter,
  type UpstreamSource,
} from '@graftsync/core';
import { patchAdapter } from '../src/index.js';

const PKG_455 = `{
  "name": "radar-sdk-js",
  "version": "4.5.5",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "license": "MIT"
}
`;

// Version-only bump right next to "main" — must NOT trigger nearbyChanges.
const PKG_456 = `{
  "name": "radar-sdk-js",
  "version": "4.5.6",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "license": "MIT"
}
`;

// Upstream adds "exports" in the same region as our "main" patch — MUST trigger nearbyChanges.
const PKG_520 = `{
  "name": "radar-sdk-js",
  "version": "5.2.0",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs"
    }
  },
  "license": "MIT"
}
`;

const RADAR_PATCH = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -2,4 +2,5 @@
   "name": "radar-sdk-js",
   "version": "4.5.5",
+  "main": "dist/index.cjs",
   "module": "dist/index.mjs",
   "types": "dist/index.d.ts",
`;

// Patch that does not anchor on "version" so it applies cleanly to 4.5.5, 4.5.6, and 5.2.0.
const RADAR_PATCH_STABLE = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -4,2 +4,3 @@
   "module": "dist/index.mjs",
+  "main": "dist/index.cjs",
   "types": "dist/index.d.ts",
`;

async function makeProject(opts: {
  versions: Record<string, Record<string, string>>;
  installedVersion: string;
  verified: string;
  patch: string;
  probe?: string;
  applyToNodeModules?: boolean;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-obsolete-'));
  const up: Record<string, string> = {};
  for (const [v, files] of Object.entries(opts.versions)) {
    const dir = path.join(root, 'upstream', v);
    await mkdir(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    up[v] = dir;
  }

  // Install a real copy in node_modules/radar-sdk-js so withPristine can swap it on disk.
  const nmDir = path.join(root, 'node_modules', 'radar-sdk-js');
  await mkdir(nmDir, { recursive: true });
  for (const [rel, content] of Object.entries(opts.versions[opts.installedVersion]!)) {
    const full = path.join(nmDir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  const gDir = path.join(root, '.grafts', 'radar-main');
  await mkdir(path.join(gDir, 'variants'), { recursive: true });
  await writeFile(path.join(root, '.grafts', 'config.json'), JSON.stringify({ mechanisms: { patch: { applier: 'graft' } } }));
  await writeFile(path.join(gDir, 'variants', 'v4.patch'), opts.patch);
  const probeLine = opts.probe ? `\nprobe: ${JSON.stringify(opts.probe)}` : '';
  await writeFile(
    path.join(gDir, 'graft.md'),
    `---\nid: radar-main\nrootstock: { package: radar-sdk-js, verified: ${opts.verified} }\nmechanism: patch\nvariants:\n  - range: ">=4.0.0"\n    module: ./variants/v4.patch${probeLine}\n---\n## Why\nCJS resolution\n## Invariants\n- Resolves under CJS\n## Where to look\npackage.json\n## Anchors\npackage.json#1\n## History\n- created\n`,
  );
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'app', devDependencies: { '@graftsync/cli': '0.3.3' }, scripts: { postinstall: 'graft apply --installed' } }),
  );

  const baseUpstream = new DirectoryUpstreamSource({ 'radar-sdk-js': up }, { 'radar-sdk-js': opts.installedVersion });
  const upstream: UpstreamSource = {
    resolve: (pkg, v) => baseUpstream.resolve(pkg, v),
    installed: async (pkg) => (pkg === 'radar-sdk-js' ? { dir: nmDir, version: opts.installedVersion } : undefined),
    versions: (pkg) => baseUpstream.versions(pkg),
  };
  const project = await Project.open({ root, adapters: [patchAdapter], upstream });
  const graft = await project.get('radar-main');
  const applied = await patchAdapter.applyInstalled!(project.context(graft));
  expect(applied.errors).toEqual([]);
  return { root, project, nmDir, upstream };
}

describe('nearby upstream change detection (Part B)', () => {
  it('flags non-trivial upstream changes near anchors (e.g. exports added near main) while staying green', async () => {
    const { project } = await makeProject({
      versions: {
        '4.5.5': { 'package.json': PKG_455 },
        '5.2.0': { 'package.json': PKG_520 },
      },
      installedVersion: '4.5.5',
      verified: '4.5.5',
      patch: RADAR_PATCH_STABLE,
    });
    const report = await sync(project, { version: '5.2.0', dryRun: true });
    expect(report.exitCode).toBe(0);
    const g = report.grafts[0]!;
    expect(g.outcome).toBe('green');
    expect(g.nearbyChanges).toBeDefined();
    expect(g.nearbyChanges!.files).toEqual(['package.json']);
    expect(g.nearbyChanges!.hunks).toBeGreaterThan(0);
    expect(g.nearbyChanges!.diffPath).toBeTruthy();
    expect(existsSync(g.nearbyChanges!.diffPath!)).toBe(true);
    const md = renderSyncMarkdown(report);
    expect(md).toContain('(nearby upstream changes)');
    expect(md).toContain('Nearby upstream changes');
  });

  it('ignores version-only bumps in package.json right next to the patched region', async () => {
    const { project } = await makeProject({
      versions: {
        '4.5.5': { 'package.json': PKG_455 },
        '4.5.6': { 'package.json': PKG_456 },
      },
      installedVersion: '4.5.5',
      verified: '4.5.5',
      patch: RADAR_PATCH_STABLE,
    });
    const report = await sync(project, { version: '4.5.6', dryRun: true });
    expect(report.exitCode).toBe(0);
    expect(report.grafts[0]!.outcome).toBe('green');
    expect(report.grafts[0]!.nearbyChanges).toBeUndefined();
  });

  it('ignores upstream changes far from the variant hunks and locates drifted hunks accurately', async () => {
    const filler = Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};`).join('\n');
    const v1 = `// header\n${filler}\nconst target = 1;\nconst after = 2;\n`;
    const v2Far = `// header changed\n${filler}\nconst target = 1;\nconst after = 2;\n`;
    const v2Near = `// header\n${filler}\nconst target = 1;\nconst after = 2;\nconst nearbyFix = true;\n`;
    // Authored against line 1 (drifted by 31 lines in v1/v2!)
    const driftedPatch = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1,2 +1,3 @@
 const target = 1;
+const patched = true;
 const after = 2;
`;
    const farProj = await makeProject({
      versions: {
        '4.5.5': { 'package.json': PKG_455, 'index.js': v1 },
        '4.6.0': { 'package.json': PKG_456, 'index.js': v2Far },
      },
      installedVersion: '4.5.5',
      verified: '4.5.5',
      patch: driftedPatch,
    });
    const farReport = await sync(farProj.project, { version: '4.6.0', dryRun: true });
    expect(farReport.grafts[0]!.outcome).toBe('green');
    expect(farReport.grafts[0]!.nearbyChanges).toBeUndefined();

    const nearProj = await makeProject({
      versions: {
        '4.5.5': { 'package.json': PKG_455, 'index.js': v1 },
        '4.6.0': { 'package.json': PKG_456, 'index.js': v2Near },
      },
      installedVersion: '4.5.5',
      verified: '4.5.5',
      patch: driftedPatch,
    });
    const nearReport = await sync(nearProj.project, { version: '4.6.0', dryRun: true });
    expect(nearReport.grafts[0]!.outcome).toBe('green');
    expect(nearReport.grafts[0]!.nearbyChanges?.files).toEqual(['index.js']);
  });
});

describe('without-variant obsolescence probe (Part A)', () => {
  it('reports needed when probe fails on pristine upstream and passes with variant, and restores patched files', async () => {
    const probeScript = 'probe-check.mjs';
    const { root, project, nmDir } = await makeProject({
      versions: { '4.5.5': { 'package.json': PKG_455 } },
      installedVersion: '4.5.5',
      verified: '4.5.5',
      patch: RADAR_PATCH,
      probe: `node ${probeScript}`,
    });
    await writeFile(
      path.join(root, probeScript),
      `import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('node_modules/radar-sdk-js/package.json', 'utf8'));
if (!pkg.main && !pkg.exports?.['.']?.require) process.exit(1);
`,
    );

    // Without --probe-obsolete on same version: probe does NOT run (only run when needed).
    const skippedProbe = await sync(project);
    expect(skippedProbe.exitCode).toBe(0);
    expect(skippedProbe.grafts[0]!.probe).toBeUndefined();

    // With --probe-obsolete: probe runs with & without variant.
    const report = await sync(project, { probeObsolete: true });
    expect(report.exitCode).toBe(0);
    const g = report.grafts[0]!;
    expect(g.outcome).toBe('green');
    expect(g.likelyObsolete).toBeUndefined();
    expect(g.probe?.status).toBe('needed');
    expect(g.probe?.withVariant.passed).toBe(true);
    expect(g.probe?.withoutVariant?.passed).toBe(false);

    // Installed file MUST be restored to patched state after probe.
    const installedPkg = JSON.parse(await readFile(path.join(nmDir, 'package.json'), 'utf8'));
    expect(installedPkg.main).toBe('dist/index.cjs');
  });

  it('flags likelyObsolete (report-only, green) when probe passes on pristine upstream too', async () => {
    const probeScript = 'probe-check.mjs';
    const { root, project, nmDir } = await makeProject({
      versions: { '5.2.0': { 'package.json': PKG_520 } },
      installedVersion: '5.2.0',
      verified: '5.2.0',
      patch: RADAR_PATCH_STABLE,
      probe: `node ${probeScript}`,
    });
    await writeFile(
      path.join(root, probeScript),
      `import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('node_modules/radar-sdk-js/package.json', 'utf8'));
if (!pkg.main && !pkg.exports?.['.']?.require) process.exit(1);
`,
    );

    const report = await sync(project, { probeObsolete: true });
    expect(report.exitCode).toBe(0);
    const g = report.grafts[0]!;
    expect(g.outcome).toBe('green');
    expect(g.likelyObsolete).toBe(true);
    expect(g.probe?.status).toBe('likely-obsolete');
    expect(g.probe?.withVariant.passed).toBe(true);
    expect(g.probe?.withoutVariant?.passed).toBe(true);

    const md = renderSyncMarkdown(report);
    expect(md).toContain('(likely obsolete)');
    expect(md).toContain('Likely obsolete');
    expect(md).toContain('graft mark radar-main --status obsolete');

    // Installed file restored to patched state.
    const installedPkg = JSON.parse(await readFile(path.join(nmDir, 'package.json'), 'utf8'));
    expect(installedPkg.main).toBe('dist/index.cjs');
  });

  it('short-circuits on with-variant failure, marks needs-agent (exit 1), and does not bump verified', async () => {
    const probeScript = 'probe-fail.mjs';
    const counterFile = 'runs.txt';
    const { root, project } = await makeProject({
      versions: { '4.5.5': { 'package.json': PKG_455 } },
      installedVersion: '4.5.5',
      verified: '4.5.5',
      patch: RADAR_PATCH,
      probe: `node ${probeScript}`,
    });
    await writeFile(
      path.join(root, probeScript),
      `import { appendFileSync } from 'node:fs';
appendFileSync('${counterFile}', process.env.GRAFT_PROBE_MODE + '\\n');
console.error('Error: invariant broken');
process.exit(1);
`,
    );

    const report = await sync(project, { probeObsolete: true });
    expect(report.exitCode).toBe(1);
    const g = report.grafts[0]!;
    expect(g.outcome).toBe('needs-agent');
    expect(g.probe?.status).toBe('failed');
    expect(g.probe?.withVariant.passed).toBe(false);
    expect(g.probe?.withoutVariant).toBeUndefined();
    expect(g.reasons.join('\n')).toContain('failed with variant applied');

    // Short-circuited: only ran once (with-variant), never swapped to without-variant.
    const runs = (await readFile(path.join(root, counterFile), 'utf8')).trim().split('\n');
    expect(runs).toEqual(['with-variant']);
  });

  it('does not run probe on --dry-run', async () => {
    const { project } = await makeProject({
      versions: { '4.5.5': { 'package.json': PKG_455 } },
      installedVersion: '4.5.5',
      verified: '4.5.5',
      patch: RADAR_PATCH,
      probe: 'node -e "process.exit(1)"',
    });
    const report = await sync(project, { probeObsolete: true, dryRun: true });
    expect(report.exitCode).toBe(0);
    expect(report.grafts[0]!.probe).toBeUndefined();
  });

  it('fails loudly (exit 2) when the mechanism does not support withPristine', async () => {
    const { root, upstream } = await makeProject({
      versions: { '4.5.5': { 'package.json': PKG_455 } },
      installedVersion: '4.5.5',
      verified: '4.5.5',
      patch: RADAR_PATCH,
      probe: 'node -e "process.exit(0)"',
    });
    const noPristineAdapter: MechanismAdapter = {
      name: 'patch',
      apply: patchAdapter.apply,
      checkAnchors: patchAdapter.checkAnchors,
      scopeDiff: patchAdapter.scopeDiff,
    };
    const project = await Project.open({ root, adapters: [noPristineAdapter], upstream });
    const report = await sync(project, { probeObsolete: true });
    expect(report.exitCode).toBe(2);
    expect(report.grafts[0]!.outcome).toBe('error');
    expect(report.grafts[0]!.reasons.join('\n')).toContain('not supported');
  });

  it('fails loudly under Yarn PnP when withPristine is called', async () => {
    const { root, project } = await makeProject({
      versions: { '4.5.5': { 'package.json': PKG_455 } },
      installedVersion: '4.5.5',
      verified: '4.5.5',
      patch: RADAR_PATCH,
      probe: 'node -e "process.exit(0)"',
    });
    const pnpProject = Object.assign(Object.create(Object.getPrototypeOf(project)), project, {
      installedCopies: async (): Promise<InstalledPackage[]> => [
        { dir: path.join(root, '.yarn/cache/radar.zip'), version: '4.5.5', pnp: { manifest: '.pnp.cjs', locator: 'radar@4.5.5' } },
      ],
    }) as Project;
    const graft = await project.get('radar-main');
    await expect(patchAdapter.withPristine!(pnpProject.context(graft), '4.5.5', async () => 'ok')).rejects.toThrow(GraftError);
  });
});
