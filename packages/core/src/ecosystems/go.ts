// Go modules.
//
//   pristine   `go mod download -json <module>@<version>`: the module cache's extracted copy,
//              verified against go.sum and the checksum database and read-only. It follows the
//              project's GOPROXY / GOPRIVATE / GONOSUMDB (the environment). Run outside any
//              module, so the project's go.mod and go.sum are never touched.
//   versions   `go list -m -versions` (retracted versions excluded by the go command)
//   installed  `go list -m -json <module>` from the main module: Version, and Replace.Dir or Dir
//   install    `go get <module>@<version>`; reinstall: `go mod vendor` when the project vendors,
//              else `go mod download`
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { semverScheme } from '@graftsync/spec';
import { ecosystemOptions, type Ecosystem } from '../ecosystem.js';
import { GraftError } from '../errors.js';
import type { Project } from '../project.js';
import type { InstalledPackage, PackageVersions, UpstreamSource } from '../upstream.js';
import { channelTags, tool } from './util.js';

export interface GoOptions extends Record<string, unknown> {
  /** The main module's directory (with go.mod), relative to the project root. Default: the root. */
  module?: string;
}

export interface GoListModule {
  Path: string;
  Version?: string;
  Dir?: string;
  Replace?: { Path: string; Version?: string; Dir?: string };
}

/** The main module's directory (absolute). */
export function goModuleDir(project: Project): string {
  return path.resolve(project.root, ecosystemOptions<GoOptions>(project, 'go').module ?? '.');
}

/** Go versions carry a `v` prefix; accept them without it. */
export const goVersion = (v: string) => (v.startsWith('v') ? v : `v${v}`);

/** Run the go command outside any module (for downloads and version lists). */
async function goOutsideModule(args: string[], code: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'graft-go-'));
  try {
    return await tool('go', args, { cwd: dir, env: { GO111MODULE: 'on', GOFLAGS: process.env.GOFLAGS ?? '' }, code });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `go list -m -json <module>` in the main module, or undefined when it isn't in the build list. */
export async function goListModule(moduleDir: string, mod: string): Promise<GoListModule | undefined> {
  if (!existsSync(path.join(moduleDir, 'go.mod'))) return undefined;
  try {
    const { stdout } = await tool('go', ['list', '-m', '-json', mod], { cwd: moduleDir, code: 'go/list' });
    return JSON.parse(stdout) as GoListModule;
  } catch (err) {
    if (/not a known dependency|no required module|not in the main module|matched no packages/i.test((err as Error).message))
      return undefined;
    throw err;
  }
}

export class GoUpstreamSource implements UpstreamSource {
  constructor(private readonly project: Project) {}

  installSpec(pkg: string, version: string): string {
    return `${pkg}@${goVersion(version)}`;
  }

  async installed(pkg: string): Promise<InstalledPackage | undefined> {
    const m = await goListModule(goModuleDir(this.project), pkg);
    if (!m?.Version) return undefined;
    const dir = m.Replace?.Dir ?? m.Dir ?? (await this.resolve(pkg, m.Version));
    return { version: m.Version, dir };
  }

  async resolve(pkg: string, version: string): Promise<string> {
    const v = goVersion(version);
    try {
      const { stdout } = await goOutsideModule(['mod', 'download', '-json', `${pkg}@${v}`], 'upstream/fetch');
      const info = JSON.parse(stdout) as { Dir?: string; Error?: string };
      if (info.Error) throw new Error(info.Error);
      if (!info.Dir || !existsSync(info.Dir)) throw new Error('the go command reported no module directory');
      return info.Dir;
    } catch (err) {
      throw new GraftError(`could not fetch ${pkg}@${v}: ${(err as Error).message}`, 'upstream/fetch', { cause: err });
    }
  }

  async versions(pkg: string): Promise<PackageVersions> {
    try {
      const { stdout } = await goOutsideModule(['list', '-m', '-versions', '-json', pkg], 'upstream/versions');
      const versions = (JSON.parse(stdout) as { Versions?: string[] }).Versions ?? [];
      return { versions, distTags: channelTags(versions, semverScheme) };
    } catch (err) {
      throw new GraftError(`could not read versions of ${pkg}: ${(err as Error).message}`, 'upstream/versions', { cause: err });
    }
  }
}

export const goEcosystem: Ecosystem = {
  name: 'go',
  scheme: semverScheme,
  normalizeVersion: goVersion,
  createUpstream: (project) => new GoUpstreamSource(project),
  detect: () => 'go',
  async install(project, pkg, version) {
    const dir = goModuleDir(project);
    const args = ['get', `${pkg}@${goVersion(version)}`];
    await tool('go', args, { cwd: dir, code: 'install/failed' });
    return `go ${args.join(' ')}${await vendorAgain(dir)}`;
  },
  async reinstall(project) {
    const dir = goModuleDir(project);
    const vendored = await vendorAgain(dir);
    if (vendored) return vendored.slice(4);
    await tool('go', ['mod', 'download'], { cwd: dir, code: 'install/failed' });
    return 'go mod download';
  },
};

/** Projects that commit vendor/ need it rebuilt for a new version or replacement. */
async function vendorAgain(dir: string): Promise<string> {
  if (!existsSync(path.join(dir, 'vendor', 'modules.txt'))) return '';
  await tool('go', ['mod', 'vendor'], { cwd: dir, code: 'install/failed' });
  return ' && go mod vendor';
}
