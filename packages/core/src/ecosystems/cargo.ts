// Cargo (crates.io and other Cargo registries).
//
//   pristine   the published .crate, fetched by cargo itself (`cargo fetch` of a throwaway manifest
//              under .grafts/.cache, so the project's .cargo/config.toml registries, mirrors and
//              auth apply) and extracted from cargo's registry cache. Its Cargo.toml is the
//              normalized one `cargo publish` wrote (the author's is Cargo.toml.orig).
//   versions   the registry's sparse index (index.crates.io), yanked versions skipped
//   installed  `cargo metadata`: the package's version and manifest directory
//   install    `cargo update -p <crate>@<installed> --precise <version>`; reinstall: `cargo fetch`
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extract as tarExtract } from 'tar';
import { semverScheme } from '@graftsync/spec';
import { ecosystemOptions, type Ecosystem } from '../ecosystem.js';
import { GraftError } from '../errors.js';
import type { Project } from '../project.js';
import type { InstalledPackage, PackageVersions, UpstreamSource } from '../upstream.js';
import { cacheDir, channelTags, fetchText, tool } from './util.js';

export interface CargoOptions extends Record<string, unknown> {
  /** The workspace (or package) manifest, relative to the project root. Default: `Cargo.toml`. */
  manifest?: string;
  /** Sparse index base URL for `outdated` and `replay`. Default: `https://index.crates.io`. */
  index?: string;
  /** The registry name `[patch.<registry>]` uses. Default: `crates-io`. */
  registry?: string;
}

export interface CargoPackage {
  name: string;
  version: string;
  /** `registry+…`, `git+…`, or null for a path dependency (e.g. a vendored, patched crate). */
  source: string | null;
  manifest_path: string;
}

/** The project's Cargo manifest (absolute). */
export function cargoManifest(project: Project): string {
  return path.resolve(project.root, ecosystemOptions<CargoOptions>(project, 'cargo').manifest ?? 'Cargo.toml');
}

/** `cargo metadata` for a manifest: every package in the resolved graph. */
export async function cargoMetadata(manifest: string): Promise<{ packages: CargoPackage[]; workspace_root: string }> {
  const { stdout } = await tool('cargo', ['metadata', '--format-version', '1', '--manifest-path', manifest], {
    cwd: path.dirname(manifest),
    code: 'cargo/metadata',
  });
  return JSON.parse(stdout);
}

/** The sparse-index path of a crate (`it/oa/itoa`, `3/s/syn`, `1/a`). */
export function sparseIndexPath(name: string): string {
  const n = name.toLowerCase();
  if (n.length <= 2) return `${n.length}/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

/** Where cargo keeps the downloaded .crate for an extracted registry source (`…/registry/src/<index>/<c>-<v>/`). */
function crateFileFor(manifestPath: string): string {
  const dir = path.dirname(manifestPath);
  const index = path.dirname(dir);
  const registry = path.dirname(path.dirname(index));
  return path.join(registry, 'cache', path.basename(index), `${path.basename(dir)}.crate`);
}

export class CargoUpstreamSource implements UpstreamSource {
  constructor(private readonly project: Project) {}

  private get options(): CargoOptions {
    return ecosystemOptions<CargoOptions>(this.project, 'cargo');
  }

  installSpec(pkg: string, version: string): string {
    return `${pkg}@${version}`;
  }

  async installed(pkg: string): Promise<InstalledPackage | undefined> {
    const manifest = cargoManifest(this.project);
    if (!existsSync(manifest)) return undefined;
    const copies = (await cargoMetadata(manifest)).packages.filter((p) => p.name === pkg);
    if (!copies.length) return undefined;
    // A patched (path) copy is the one the graft applies to; otherwise the newest.
    const pick = copies.find((p) => p.source === null) ?? copies.sort((a, b) => semverScheme.compare(b.version, a.version))[0]!;
    return { version: pick.version, dir: path.dirname(pick.manifest_path) };
  }

  async resolve(pkg: string, version: string): Promise<string> {
    const dest = path.join(this.project.cacheDir, 'upstream', 'cargo', `${pkg}@${version}`);
    return cacheDir(dest, 'Cargo.toml', async (tmp) => {
      // A throwaway package inside the project, so cargo reads the project's .cargo/config.toml;
      // its own [workspace] keeps it out of the project's workspace.
      const probe = path.join(tmp, '.probe');
      await mkdir(path.join(probe, 'src'), { recursive: true });
      await writeFile(
        path.join(probe, 'Cargo.toml'),
        `[package]\nname = "graft-fetch"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[workspace]\n\n[dependencies]\n${JSON.stringify(pkg)} = ${JSON.stringify(`=${version}`)}\n`,
      );
      await writeFile(path.join(probe, 'src', 'lib.rs'), '');
      const manifest = path.join(probe, 'Cargo.toml');
      await tool('cargo', ['fetch', '--manifest-path', manifest], { cwd: probe, code: 'upstream/fetch' });
      const found = (await cargoMetadata(manifest)).packages.find((p) => p.name === pkg && p.version === version && p.source);
      if (!found) throw new GraftError(`cargo fetched no ${pkg}@${version}`, 'upstream/fetch');
      const crate = crateFileFor(found.manifest_path);
      if (!existsSync(crate))
        throw new GraftError(`cargo's registry cache has no ${path.basename(crate)} (expected ${crate})`, 'upstream/fetch');
      // The .crate, not the extracted registry source: that copy is shared and may have been edited.
      await tarExtract({ file: crate, cwd: tmp, strip: 1 });
      await rm(probe, { recursive: true, force: true });
    }).catch((err: Error) => {
      throw err instanceof GraftError && err.code === 'upstream/fetch'
        ? new GraftError(`could not fetch ${pkg}@${version} from the Cargo registry: ${err.message}`, 'upstream/fetch', { cause: err })
        : err;
    });
  }

  async versions(pkg: string): Promise<PackageVersions> {
    const base = (this.options.index ?? 'https://index.crates.io').replace(/\/+$/, '');
    try {
      const lines = (await fetchText(`${base}/${sparseIndexPath(pkg)}`)).split('\n').filter(Boolean);
      const entries = lines.map((l) => JSON.parse(l) as { vers: string; yanked?: boolean });
      const versions = entries.filter((e) => !e.yanked).map((e) => e.vers);
      return { versions, distTags: channelTags(versions, semverScheme) };
    } catch (err) {
      throw new GraftError(`could not read versions of ${pkg}: ${(err as Error).message}`, 'upstream/versions', { cause: err });
    }
  }
}

export const cargoEcosystem: Ecosystem = {
  name: 'cargo',
  scheme: semverScheme,
  createUpstream: (project) => new CargoUpstreamSource(project),
  detect: () => 'cargo',
  async install(project, pkg, version) {
    const manifest = cargoManifest(project);
    const installed = await project.upstreamFor('cargo').installed(pkg);
    if (!installed) throw new GraftError(`${pkg} is not a dependency of ${manifest}`, 'install/failed');
    const args = ['update', '--manifest-path', manifest, '-p', `${pkg}@${installed.version}`, '--precise', version];
    await tool('cargo', args, { cwd: path.dirname(manifest), code: 'install/failed' });
    return `cargo ${args.join(' ')}`;
  },
  async reinstall(project) {
    const manifest = cargoManifest(project);
    const args = ['fetch', '--manifest-path', manifest];
    await tool('cargo', args, { cwd: path.dirname(manifest), code: 'install/failed' });
    return `cargo ${args.join(' ')}`;
  },
};
