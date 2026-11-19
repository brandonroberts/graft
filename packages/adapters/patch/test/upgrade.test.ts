import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DirectoryUpstreamSource, Project, sync, type InstalledPackage } from '@graftsync/core';
import { patchAdapter } from '../src/index.js';

const V1 = `const a = 1\nconst b = 2\nmodule.exports = { a, b }\n`;
const PATCH = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1,3 +1,4 @@
 const a = 1
 const b = 2
+const c = 3
 module.exports = { a, b }
`;

/** Upstream whose "installed" version is whatever the project's upgrade command wrote to installed.txt. */
class CommandInstalledSource extends DirectoryUpstreamSource {
  constructor(
    dirs: Record<string, Record<string, string>>,
    private readonly root: string,
  ) {
    super(dirs, { lib: '1.0.0' });
  }
  override async installed(pkg: string): Promise<InstalledPackage | undefined> {
    const file = path.join(this.root, 'installed.txt');
    if (!existsSync(file)) return super.installed(pkg);
    const version = readFileSync(file, 'utf8').trim().split('@').pop()!;
    return { version, dir: await this.resolve(pkg, version) };
  }
}

async function fixture(config: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-upgrade-'));
  const dirs: Record<string, string> = {};
  for (const v of ['1.0.0', '1.0.5', '1.1.0']) {
    const dir = path.join(root, 'upstream', v);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.js'), V1);
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'lib', version: v }));
    dirs[v] = dir;
  }
  const g = path.join(root, '.grafts', 'add-c');
  await mkdir(path.join(g, 'variants'), { recursive: true });
  await writeFile(path.join(g, 'variants', 'v1.patch'), PATCH);
  await writeFile(
    path.join(g, 'graft.md'),
    `---\nid: add-c\nrootstock: { package: lib, verified: 1.0.0 }\nmechanism: patch\nvariants:\n  - range: ">=1.0.0"\n    module: ./variants/v1.patch\n---\n## Why\nw\n## Invariants\ni\n## Where to look\nl\n## Anchors\na\n## History\n- created\n`,
  );
  await writeFile(path.join(root, '.grafts', 'config.json'), JSON.stringify(config));
  await writeFile(
    path.join(root, 'pnpm-workspace.yaml'),
    `packages: []\nignorePatchFailures: false\npatchedDependencies:\n  lib: .grafts/add-c/variants/v1.patch\n`,
  );
  const project = await Project.open({ root, adapters: [patchAdapter], upstream: new CommandInstalledSource({ lib: dirs }, root) });
  const verified = async () => (await readFile(path.join(g, 'graft.md'), 'utf8')).match(/verified: (\S+) \}/)![1];
  return { root, project, verified };
}

const write = (content: string) => `node -e "require('fs').writeFileSync('installed.txt', '${content}')"`;

describe("sync --install with the project's upgrade command", () => {
  it('runs it, with {package} and {version} filled in, instead of the single-package install', async () => {
    const { project, root, verified } = await fixture({ upgrade: { lib: write('{package}@{version}') } });
    const report = await sync(project, { version: '1.1.0', install: true, writeReport: false });
    expect(report.exitCode, JSON.stringify(report.grafts)).toBe(0);
    expect(report.targets[0]?.installCommand).toBe(write('lib@1.1.0'));
    expect(await readFile(path.join(root, 'installed.txt'), 'utf8')).toBe('lib@1.1.0');
    expect(report.grafts[0]).toMatchObject({ outcome: 'green' });
    expect(await verified()).toBe('1.1.0');
  });

  it('prefers an <ecosystem>:<name> key over a bare name', async () => {
    const { project } = await fixture({ upgrade: { lib: 'exit 9 {version}', 'npm:lib': write('{version}') } });
    const report = await sync(project, { version: '1.1.0', install: true, writeReport: false });
    expect(report.exitCode).toBe(0);
    expect(report.targets[0]?.installCommand).toBe(write('1.1.0'));
  });

  it('lets ecosystems.<name>.upgrade win over the top-level map, and rejects a malformed one', async () => {
    const { project } = await fixture({
      upgrade: { 'npm:lib': 'exit 9 {version}' },
      ecosystems: { npm: { upgrade: { lib: write('{version}') } } },
    });
    const report = await sync(project, { version: '1.1.0', install: true, writeReport: false });
    expect(report.exitCode, JSON.stringify(report.grafts)).toBe(0);
    expect(report.targets[0]?.installCommand).toBe(write('1.1.0'));

    const other = await fixture({ upgrade: { lib: write('{version}') }, ecosystems: { cargo: { upgrade: { lib: 'exit 9 {version}' } } } });
    expect((await sync(other.project, { version: '1.1.0', install: true, writeReport: false })).exitCode).toBe(0); // another ecosystem's map

    const malformed = await fixture({ ecosystems: { npm: { upgrade: 'pnpm up' } } });
    const bad = await sync(malformed.project, { version: '1.1.0', install: true, writeReport: false });
    expect(bad.exitCode).toBe(2);
    expect(bad.grafts[0]!.reasons.join('\n')).toMatch(/ecosystems\.npm\.upgrade must be an object of commands/);

    const noVersion = await fixture({ ecosystems: { npm: { upgrade: { lib: write('1.1.0') } } } });
    const nv = await sync(noVersion.project, { version: '1.1.0', install: true, writeReport: false });
    expect(nv.grafts[0]!.reasons.join('\n')).toMatch(/ecosystems\.npm\.upgrade\["lib"\] must be a command containing \{version\}/);
  });

  it('fails loudly, recording nothing, when the command fails or installs another version', async () => {
    const failing = await fixture({ upgrade: { lib: `node -e "console.error('migration blew up'); process.exit(4)" {version}` } });
    const report = await sync(failing.project, { version: '1.1.0', install: true, writeReport: false });
    expect(report.exitCode).toBe(2);
    expect(report.grafts[0]).toMatchObject({ outcome: 'error' });
    expect(report.grafts[0]!.reasons.join('\n')).toMatch(/upgrade command .* failed \(exit 4\):[\s\S]*migration blew up/);
    expect(await failing.verified()).toBe('1.0.0');

    const wrong = await fixture({ upgrade: { lib: `${write('1.0.5')} # {version}` } });
    const off = await sync(wrong.project, { version: '1.1.0', install: true, writeReport: false });
    expect(off.exitCode).toBe(2);
    expect(off.grafts[0]!.reasons.join('\n')).toMatch(/found version 1\.0\.5, expected 1\.1\.0/);
    expect(await wrong.verified()).toBe('1.0.0');
  });

  it('rejects a command without {version}, before running it', async () => {
    const { project, root } = await fixture({ upgrade: { lib: write('1.1.0') } });
    const report = await sync(project, { version: '1.1.0', install: true, writeReport: false });
    expect(report.exitCode).toBe(2);
    expect(report.grafts[0]!.reasons.join('\n')).toMatch(/upgrade\["lib"\] must be a command containing \{version\}/);
    expect(existsSync(path.join(root, 'installed.txt'))).toBe(false);
  });
});
