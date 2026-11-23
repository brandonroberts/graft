import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findInstalledPackage, NpmUpstreamSource } from '../src/upstream.js';

/** A packed `lib@1.0.0` tarball in a temp dir (made with npm itself, offline). */
async function packedLib() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-upstream-'));
  const src = path.join(root, 'src');
  await mkdir(path.join(src, 'lib'), { recursive: true });
  await writeFile(path.join(src, 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0', main: 'index.js' }));
  await writeFile(path.join(src, 'index.js'), "module.exports = require('./lib/a')\n");
  await writeFile(path.join(src, 'lib/a.js'), 'module.exports = 1\n');
  execFileSync('npm', ['pack', src, '--pack-destination', root], { cwd: root, stdio: 'pipe' });
  return root;
}

describe('NpmUpstreamSource (fetching through npm)', () => {
  it('extracts the pristine contents of a spec with npm pack, and caches them', async () => {
    const root = await packedLib();
    const cacheDir = path.join(root, 'cache');
    const source = new NpmUpstreamSource({ root, cacheDir, specs: { lib: 'file:lib-{version}.tgz' }, specBase: root });
    const dir = await source.resolve('lib', '1.0.0');
    expect(dir).toBe(path.join(cacheDir, 'upstream', 'lib@1.0.0'));
    expect(JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')).version).toBe('1.0.0');
    expect(await readFile(path.join(dir, 'lib/a.js'), 'utf8')).toBe('module.exports = 1\n');
    expect(existsSync(`${dir}.tmp-${process.pid}`)).toBe(false); // no leftovers
    // Cached: the tarball can go away.
    await writeFile(path.join(root, 'lib-1.0.0.tgz'), 'not a tarball');
    expect(await source.resolve('lib', '1.0.0')).toBe(dir);
  });

  it('still fetches through npm when package.json pins another package manager via devEngines (#58)', async () => {
    const root = await packedLib();
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'pnpm-app',
        devEngines: { packageManager: { name: 'pnpm', version: '11.24.0', onFail: 'error' } },
      }),
    );
    const cacheDir = path.join(root, 'cache');
    const source = new NpmUpstreamSource({ root, cacheDir, specs: { lib: 'file:lib-{version}.tgz' }, specBase: root });
    const dir = await source.resolve('lib', '1.0.0');
    expect(JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')).version).toBe('1.0.0');
  });

  it('fails with the reason npm gives', async () => {
    const root = await packedLib();
    const source = new NpmUpstreamSource({
      root,
      cacheDir: path.join(root, 'cache'),
      specs: { lib: 'file:missing-{version}.tgz' },
      specBase: root,
    });
    await expect(source.resolve('lib', '1.0.0')).rejects.toThrow(/could not fetch file:.*missing-1\.0\.0\.tgz: .+/);
    expect(existsSync(path.join(root, 'cache/upstream/lib@1.0.0'))).toBe(false);
  });
});

describe('findInstalledPackage (pnpm virtual store fallback, #59)', () => {
  it('finds unhoisted transitive unscoped and scoped packages in node_modules/.pnpm', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-pnpm-store-'));
    const unscoped = path.join(root, 'node_modules/.pnpm/adm-zip@0.6.1_patch_hash=abc/node_modules/adm-zip');
    const scoped = path.join(root, 'node_modules/.pnpm/@scope+pkg@2.1.0_peer@1.0.0/node_modules/@scope/pkg');
    await mkdir(unscoped, { recursive: true });
    await mkdir(scoped, { recursive: true });
    await writeFile(path.join(unscoped, 'package.json'), JSON.stringify({ name: 'adm-zip', version: '0.6.1' }));
    await writeFile(path.join(scoped, 'package.json'), JSON.stringify({ name: '@scope/pkg', version: '2.1.0' }));

    expect(await findInstalledPackage('adm-zip', root)).toEqual({ version: '0.6.1', dir: await realpath(unscoped) });
    expect(await findInstalledPackage('@scope/pkg', root)).toEqual({ version: '2.1.0', dir: await realpath(scoped) });
    expect(await findInstalledPackage('missing-pkg', root)).toBeUndefined();
  });

  it('fails loudly when multiple distinct versions exist in node_modules/.pnpm, unless directly resolvable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-pnpm-store-'));
    const v1 = path.join(root, 'node_modules/.pnpm/lib@1.0.0/node_modules/lib');
    const v2 = path.join(root, 'node_modules/.pnpm/lib@2.0.0/node_modules/lib');
    await mkdir(v1, { recursive: true });
    await mkdir(v2, { recursive: true });
    await writeFile(path.join(v1, 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));
    await writeFile(path.join(v2, 'package.json'), JSON.stringify({ name: 'lib', version: '2.0.0' }));

    await expect(findInstalledPackage('lib', root)).rejects.toThrow(/multiple versions of lib .*1\.0\.0, 2\.0\.0.*resolveFrom/);

    // A workspace package that resolves its own copy directly still wins cleanly.
    const app = path.join(root, 'apps/web');
    const direct = path.join(app, 'node_modules/lib');
    await mkdir(direct, { recursive: true });
    await writeFile(path.join(direct, 'package.json'), JSON.stringify({ name: 'lib', version: '2.0.0' }));
    expect(await findInstalledPackage('lib', app)).toEqual({ version: '2.0.0', dir: await realpath(direct) });
  });

  it('ignores stale unpruned directories in node_modules/.pnpm when .pnpm/lock.yaml lists only the active version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-pnpm-stale-'));
    const oldDir = path.join(root, 'node_modules/.pnpm/acorn@8.11.3/node_modules/acorn');
    const newDir = path.join(root, 'node_modules/.pnpm/acorn@8.12.0/node_modules/acorn');
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    await writeFile(path.join(oldDir, 'package.json'), JSON.stringify({ name: 'acorn', version: '8.11.3' }));
    await writeFile(path.join(newDir, 'package.json'), JSON.stringify({ name: 'acorn', version: '8.12.0' }));
    await writeFile(
      path.join(root, 'node_modules/.pnpm/lock.yaml'),
      `lockfileVersion: '9.0'\n\npackages:\n  acorn@8.12.0:\n    resolution: {integrity: sha512-abc}\n\nsnapshots:\n  acorn@8.12.0: {}\n`,
    );

    expect(await findInstalledPackage('acorn', root)).toEqual({ version: '8.12.0', dir: await realpath(newDir) });

    // When both versions ARE active in lock.yaml, still fail loudly.
    await writeFile(
      path.join(root, 'node_modules/.pnpm/lock.yaml'),
      `lockfileVersion: '9.0'\n\npackages:\n  acorn@8.11.3:\n    resolution: {integrity: sha512-old}\n  acorn@8.12.0:\n    resolution: {integrity: sha512-abc}\n`,
    );
    await expect(findInstalledPackage('acorn', root)).rejects.toThrow(/multiple versions of acorn .*8\.11\.3, 8\.12\.0/);
  });

  it('NpmUpstreamSource.installed supports workspace-scoped { from } and { allowAmbiguous }', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-upstream-opts-'));
    const app = path.join(root, 'packages/app');
    const appPlugin = path.join(app, 'node_modules/plugin');
    const p1 = path.join(root, 'node_modules/.pnpm/plugin@1.0.0/node_modules/plugin');
    const p2 = path.join(root, 'node_modules/.pnpm/plugin@2.0.0/node_modules/plugin');
    const o1 = path.join(root, 'node_modules/.pnpm/other@1.0.0/node_modules/other');
    const o2 = path.join(root, 'node_modules/.pnpm/other@2.0.0/node_modules/other');
    for (const d of [appPlugin, p1, p2, o1, o2]) await mkdir(d, { recursive: true });
    await writeFile(path.join(appPlugin, 'package.json'), JSON.stringify({ name: 'plugin', version: '1.0.0' }));
    await writeFile(path.join(p1, 'package.json'), JSON.stringify({ name: 'plugin', version: '1.0.0' }));
    await writeFile(path.join(p2, 'package.json'), JSON.stringify({ name: 'plugin', version: '2.0.0' }));
    await writeFile(path.join(o1, 'package.json'), JSON.stringify({ name: 'other', version: '1.0.0' }));
    await writeFile(path.join(o2, 'package.json'), JSON.stringify({ name: 'other', version: '2.0.0' }));

    const source = new NpmUpstreamSource({ root, cacheDir: path.join(root, 'cache') });
    // Default lookup from root hits pnpm store ambiguity.
    await expect(source.installed('plugin')).rejects.toThrow(/multiple versions of plugin/);
    // Workspace-scoped `from` resolves the exact local copy cleanly.
    expect(await source.installed('plugin', { from: app })).toEqual({ version: '1.0.0', dir: await realpath(appPlugin) });
    // `allowAmbiguous` returns undefined for ambiguous store-only packages instead of throwing.
    expect(await source.installed('other', { from: app, allowAmbiguous: true })).toBeUndefined();
    await expect(source.installed('other', { from: app })).rejects.toThrow(/multiple versions of other/);
  });

  it('NpmUpstreamSource.installedCopies returns primary first and discovers nested copies across root and resolveFrom', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-upstream-copies-'));
    const ws = path.join(root, 'packages/app');
    const primary = path.join(ws, 'node_modules/jsdom');
    const wsNested = path.join(ws, 'node_modules/jest-env/node_modules/jsdom');
    const rootNested = path.join(root, 'node_modules/legacy/node_modules/jsdom');
    for (const d of [primary, wsNested, rootNested]) await mkdir(d, { recursive: true });
    await writeFile(path.join(primary, 'package.json'), JSON.stringify({ name: 'jsdom', version: '27.4.0' }));
    await writeFile(path.join(wsNested, 'package.json'), JSON.stringify({ name: 'jsdom', version: '26.1.0' }));
    await writeFile(path.join(rootNested, 'package.json'), JSON.stringify({ name: 'jsdom', version: '25.0.0' }));

    const source = new NpmUpstreamSource({
      root,
      cacheDir: path.join(root, 'cache'),
      resolveFrom: { jsdom: ws },
    });
    const copies = await source.installedCopies('jsdom');
    expect(copies[0]).toEqual({ version: '27.4.0', dir: await realpath(primary) });
    expect(
      copies
        .slice(1)
        .map((c) => c.version)
        .sort(),
    ).toEqual(['25.0.0', '26.1.0']);
  });
});

describe('release-age cooldown filtering (.npmrc min-release-age / pnpm minimumReleaseAge, #75)', () => {
  it('reads .npmrc min-release-age (days) and pnpm-workspace.yaml minimumReleaseAge (minutes) + excludes', async () => {
    const { matchesReleaseAgeExclude, readNpmReleaseAgePolicy } = await import('../src/upstream.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-release-age-'));
    const sub = path.join(root, 'packages/app');
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(root, '.npmrc'), '# comment\nregistry=https://registry.npmjs.org/\nmin-release-age=7 # 7 days\n');
    await writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      `minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - '@scope/*'\n  - 'foo@1.2.3'\npackages:\n  - packages/*\n`,
    );

    const policy = readNpmReleaseAgePolicy(sub);
    expect(policy).toEqual({
      npmMs: 7 * 24 * 60 * 60_000,
      pnpmMs: 10080 * 60_000,
      pnpmExclude: ['@scope/*', 'foo@1.2.3'],
    });

    expect(matchesReleaseAgeExclude('@scope/*', '@scope/pkg', '1.0.0')).toBe(true);
    expect(matchesReleaseAgeExclude('@scope/*', '@other/pkg', '1.0.0')).toBe(false);
    expect(matchesReleaseAgeExclude('foo@1.2.3', 'foo', '1.2.3')).toBe(true);
    expect(matchesReleaseAgeExclude('foo@1.2.3', 'foo', '1.2.4')).toBe(false);
    expect(matchesReleaseAgeExclude('bar', 'bar', '9.9.9')).toBe(true);
  });

  it('filters recent versions, falls back latest to newest eligible stable, and respects excludes', async () => {
    const { filterVersionsByReleaseAge } = await import('../src/upstream.js');
    const now = Date.parse('2026-11-20T00:00:00.000Z');
    const data = {
      versions: ['15.3.0', '15.4.0', '15.4.1', '15.5.0', '16.0.0-beta.1'],
      distTags: { latest: '15.5.0', next: '16.0.0-beta.1' },
      time: {
        '15.3.0': '2026-01-01T00:00:00.000Z',
        '15.4.0': '2026-10-01T00:00:00.000Z',
        '15.4.1': '2026-11-10T00:00:00.000Z', // 10 days old (eligible)
        '15.5.0': '2026-11-18T00:00:00.000Z', // 2 days old (blocked)
        '16.0.0-beta.1': '2026-11-19T00:00:00.000Z', // 1 day old (blocked)
      },
    };

    const filtered = filterVersionsByReleaseAge('@sinonjs/fake-timers', data, { npmMs: 7 * 24 * 60 * 60_000 }, now);
    expect(filtered.versions).toEqual(['15.3.0', '15.4.0', '15.4.1']);
    expect(filtered.distTags).toEqual({ latest: '15.4.1' });

    // pnpm exclusion exempts the package when only pnpm minimumReleaseAge is set.
    const exempted = filterVersionsByReleaseAge(
      '@sinonjs/fake-timers',
      data,
      { pnpmMs: 10080 * 60_000, pnpmExclude: ['@sinonjs/fake-timers@15.5.0'] },
      now,
    );
    expect(exempted.versions).toContain('15.5.0');
    expect(exempted.distTags.latest).toBe('15.5.0');
    expect(exempted.distTags.next).toBeUndefined();
  });

  it('NpmUpstreamSource.versions queries `time` only when a cooldown is configured and filters recent releases', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-npm-age-'));
    await writeFile(path.join(root, '.npmrc'), 'min-release-age=7\n');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    const binDir = path.join(root, 'fake-bin');
    const logFile = path.join(root, 'npm.log');
    await mkdir(binDir, { recursive: true });
    const recentIso = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    const oldIso = new Date(Date.now() - 20 * 24 * 60 * 60_000).toISOString();
    const payload = JSON.stringify({
      versions: ['1.0.0', '1.1.0'],
      'dist-tags': { latest: '1.1.0' },
      time: { '1.0.0': oldIso, '1.1.0': recentIso },
    });
    await writeFile(path.join(root, 'view.json'), payload);
    await writeFile(path.join(binDir, 'npm'), `#!/bin/sh\necho "$@" > "${logFile}"\ncat "${path.join(root, 'view.json')}"\n`, {
      mode: 0o755,
    });

    const source = new NpmUpstreamSource({ root, cacheDir: path.join(root, 'cache') });
    const prevPath = process.env.PATH ?? '';
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    try {
      const res = await source.versions('demo');
      expect(res).toEqual({ versions: ['1.0.0'], distTags: { latest: '1.0.0' } });
    } finally {
      process.env.PATH = prevPath;
    }
    expect((await readFile(logFile, 'utf8')).trim()).toBe('view demo versions dist-tags time --json');
  });

  it('parses .npmrc min-release-age-exclude[] and lets pnpm minimumReleaseAgeExclude govern over .npmrc (#78)', async () => {
    const { filterVersionsByReleaseAge, readNpmReleaseAgePolicy } = await import('../src/upstream.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-npmrc-excl-'));
    await writeFile(
      path.join(root, '.npmrc'),
      [
        'min-release-age=7',
        'min-release-age-exclude[]=@openai/codex',
        'min-release-age-exclude[]=@openai/codex-*',
        'min-release-age-exclude=bare-pkg@2.0.0',
      ].join('\n') + '\n',
    );
    const npmOnly = readNpmReleaseAgePolicy(root);
    expect(npmOnly).toEqual({
      npmMs: 7 * 24 * 60 * 60_000,
      npmExclude: ['@openai/codex', '@openai/codex-*', 'bare-pkg@2.0.0'],
    });

    const now = Date.parse('2026-11-20T00:00:00.000Z');
    const data = {
      versions: ['1.0.0', '2.0.0'],
      distTags: { latest: '2.0.0' },
      time: {
        '1.0.0': '2026-10-01T00:00:00.000Z',
        '2.0.0': '2026-11-19T00:00:00.000Z', // 1 day old
      },
    };
    expect(filterVersionsByReleaseAge('@openai/codex-cli', data, npmOnly, now).distTags.latest).toBe('2.0.0');
    expect(filterVersionsByReleaseAge('bare-pkg', data, npmOnly, now).distTags.latest).toBe('2.0.0');
    expect(filterVersionsByReleaseAge('other-pkg', data, npmOnly, now).distTags.latest).toBe('1.0.0');

    // When pnpm-workspace.yaml also sets minimumReleaseAge, its exclusions govern over .npmrc.
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - "@solidjs/*"\n');
    const both = readNpmReleaseAgePolicy(root);
    expect(filterVersionsByReleaseAge('@solidjs/web', data, both, now).distTags.latest).toBe('2.0.0');
    expect(filterVersionsByReleaseAge('other-pkg', data, both, now).distTags.latest).toBe('1.0.0');
  });

  it('passes npm_config_min_release_age=0 to read-only npm pack so .npmrc cooldowns do not break checks (#78)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-pack-age-'));
    await writeFile(path.join(root, '.npmrc'), 'min-release-age=7\n');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    const binDir = path.join(root, 'fake-bin');
    const envLog = path.join(root, 'env.log');
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, 'npm'), `#!/bin/sh\necho "age=$npm_config_min_release_age" > "${envLog}"\nexit 1\n`, { mode: 0o755 });
    const source = new NpmUpstreamSource({ root, cacheDir: path.join(root, 'cache') });
    const prevPath = process.env.PATH ?? '';
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    try {
      await expect(source.resolve('@solidjs/web', '2.0.3')).rejects.toThrow(/could not fetch/);
    } finally {
      process.env.PATH = prevPath;
    }
    expect((await readFile(envLog, 'utf8')).trim()).toBe('age=0');
  });

  it('unwraps npm 12 array-wrapped `npm view --json` output and fails loudly on empty/unexpected shapes', async () => {
    const { parseNpmViewVersions } = await import('../src/upstream.js');
    // npm < 12 object shape
    expect(parseNpmViewVersions({ versions: ['1.0.0', '1.1.0'], 'dist-tags': { latest: '1.1.0' } })).toEqual({
      versions: ['1.0.0', '1.1.0'],
      distTags: { latest: '1.1.0' },
    });
    // npm 12+ single-element array shape
    expect(parseNpmViewVersions([{ versions: ['58.0.23', '58.0.26'], 'dist-tags': { latest: '58.0.26', next: '58.0.11' } }])).toEqual({
      versions: ['58.0.23', '58.0.26'],
      distTags: { latest: '58.0.26', next: '58.0.11' },
    });
    // Unexpected or empty shapes fail loudly instead of silently returning distTags: {}
    expect(() => parseNpmViewVersions([])).toThrow(/unexpected JSON shape/);
    expect(() => parseNpmViewVersions({})).toThrow(/no versions or dist-tags/);
    expect(() => parseNpmViewVersions([{}])).toThrow(/no versions or dist-tags/);
  });
});
