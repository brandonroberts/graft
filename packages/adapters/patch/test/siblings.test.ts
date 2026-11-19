import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSiblings, NpmUpstreamSource, Project, repositoryKey, sync, type PackageVersions } from '@graftsync/core';
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

/** Real npm installs from local directories; published versions are whatever directories exist. */
class LocalRegistry extends NpmUpstreamSource {
  constructor(
    root: string,
    specs: Record<string, string>,
    private readonly published: Record<string, string[]>,
  ) {
    super({ root, cacheDir: path.join(root, '.grafts/.cache'), specs });
  }
  override async resolve(pkg: string, version: string): Promise<string> {
    return path.join(path.dirname(this.root), 'pkgs', `${pkg}-${version}`);
  }
  override async versions(pkg: string): Promise<PackageVersions> {
    return { versions: this.published[pkg] ?? [], distTags: {} };
  }
  private get root() {
    return (this as unknown as { options: { root: string } }).options.root;
  }
}

const KIT = { lib: 'github:acme/kit', plugin: { type: 'git', url: 'git+https://github.com/acme/kit.git' }, old: 'acme/kit' };

async function fixture(published: Record<string, string[]>, config: (pkgs: string) => Record<string, unknown> = () => ({})) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'graft-siblings-'));
  const pkgs = path.join(base, 'pkgs');
  const make = async (name: string, version: string, repository: unknown) => {
    const dir = path.join(pkgs, `${name}-${version}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js', repository }));
    await writeFile(path.join(dir, 'index.js'), V1);
  };
  for (const v of ['1.0.0', '1.1.0']) {
    await make('lib', v, KIT.lib);
    await make('plugin', v, KIT.plugin);
    await make('other', v, 'acme/other');
  }
  await make('old', '0.9.0', KIT.old); // same repository, different version: not a sibling
  const root = path.join(base, 'app');
  const dep = (name: string, v: string) => `file:${path.join(pkgs, `${name}-${v}`)}`;
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'app',
      dependencies: { lib: dep('lib', '1.0.0'), other: dep('other', '1.0.0') },
      devDependencies: { plugin: dep('plugin', '1.0.0'), old: dep('old', '0.9.0') },
    }),
  );
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'pipe' });

  const g = path.join(root, '.grafts', 'add-c');
  await mkdir(path.join(g, 'variants'), { recursive: true });
  await writeFile(path.join(g, 'variants', 'v1.patch'), PATCH);
  await writeFile(
    path.join(g, 'graft.md'),
    `---\nid: add-c\nrootstock: { package: lib, verified: 1.0.0 }\nmechanism: patch\nvariants:\n  - range: ">=1.0.0"\n    module: ./variants/v1.patch\n---\n## Why\nw\n## Invariants\ni\n## Where to look\nl\n## Anchors\na\n## History\n- created\n`,
  );
  await writeFile(
    path.join(root, '.grafts', 'config.json'),
    JSON.stringify({ mechanisms: { patch: { applier: 'graft' } }, ...config(pkgs) }),
  );
  const specs = Object.fromEntries(['lib', 'plugin', 'other', 'old'].map((n) => [n, `file:${path.join(pkgs, `${n}-{version}`)}`]));
  const project = await Project.open({ root, adapters: [patchAdapter], upstream: new LocalRegistry(root, specs, published) });
  const version = async (name: string) =>
    JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version as string;
  return { root, project, version };
}

describe('packages released with the rootstock (siblings)', () => {
  // The graft applier patches from afterInstall; the project's postinstall would need the graft CLI.
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.npm_config_ignore_scripts;
    process.env.npm_config_ignore_scripts = 'true';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.npm_config_ignore_scripts;
    else process.env.npm_config_ignore_scripts = saved;
  });

  it('reduces repository fields to one key', () => {
    for (const r of [
      'github:acme/kit',
      'acme/kit',
      'git+https://github.com/acme/kit.git',
      { url: 'https://github.com/Acme/kit/' },
      'git@github.com:acme/kit.git',
      'ssh://git@github.com/acme/kit',
      'git://github.com/acme/kit.git',
    ]) {
      expect(repositoryKey(r), JSON.stringify(r)).toBe('github.com/acme/kit');
    }
    expect(repositoryKey('gitlab:acme/kit')).toBe('gitlab.com/acme/kit');
    expect(repositoryKey(undefined)).toBeUndefined();
    expect(repositoryKey({})).toBeUndefined();
  });

  it('finds declared dependencies from the same repository at the same installed version', async () => {
    const { project } = await fixture({});
    expect(await findSiblings(project, 'lib')).toEqual(['plugin']);
    expect(await findSiblings(project, 'other')).toEqual([]);
  });

  it('sync --install moves them with the rootstock, in its dependency field, and leaves the rest alone', async () => {
    const { project, root, version } = await fixture({ lib: ['1.0.0', '1.1.0'], plugin: ['1.0.0', '1.1.0'] });
    const report = await sync(project, { version: '1.1.0', install: true, writeReport: false });
    expect(report.exitCode, JSON.stringify(report.grafts)).toBe(0);
    expect(report.targets[0]).toMatchObject({ siblings: ['plugin'] });
    expect(report.targets[0]!.installCommand).toMatch(/npm install .*lib-1\.1\.0.* && npm install --save-dev .*plugin-1\.1\.0/);
    expect([await version('lib'), await version('plugin'), await version('other'), await version('old')]).toEqual([
      '1.1.0',
      '1.1.0',
      '1.0.0',
      '0.9.0',
    ]);
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.devDependencies.plugin).toContain('plugin-1.1.0');
    expect(manifest.dependencies.plugin).toBeUndefined();
    expect(await readFile(path.join(root, 'node_modules/lib/index.js'), 'utf8')).toContain('const c = 3'); // the graft applied
  });

  it("leaves siblings to the project's upgrade command when it sets one", async () => {
    let upgrade = '';
    const { project, version } = await fixture({ lib: ['1.0.0', '1.1.0'], plugin: ['1.0.0'] }, (pkgs) => {
      upgrade = `npm install --ignore-scripts ${path.join(pkgs, 'lib-{version}')}`;
      return { upgrade: { lib: upgrade } };
    }); // plugin@1.1.0 is "unpublished": only the upgrade command decides
    const report = await sync(project, { version: '1.1.0', install: true, writeReport: false });
    expect(report.exitCode, JSON.stringify(report.grafts)).toBe(0);
    expect(report.targets[0]!.siblings).toBeUndefined();
    expect(report.targets[0]!.installCommand).toBe(upgrade.replace('{version}', '1.1.0'));
    expect([await version('lib'), await version('plugin')]).toEqual(['1.1.0', '1.0.0']);
  });

  it('fails loudly, installing nothing, when a sibling is not published at the target', async () => {
    const { project, version } = await fixture({ lib: ['1.0.0', '1.1.0'], plugin: ['1.0.0'] });
    const report = await sync(project, { version: '1.1.0', install: true, writeReport: false });
    expect(report.exitCode).toBe(2);
    expect(report.grafts[0]!.reasons.join('\n')).toMatch(
      /plugin is released with lib \(same repository, installed at 1\.0\.0\) but not published at 1\.1\.0/,
    );
    expect([await version('lib'), await version('plugin')]).toEqual(['1.0.0', '1.0.0']);
  });
});
