import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { GraftError } from './errors.js';

export interface InstalledPackage {
  version: string;
  /** Real path of the installed package directory. */
  dir: string;
}

export interface PackageVersions {
  versions: string[];
  distTags: Record<string, string>;
}

/** Where upstream package contents come from. Swappable for tests and private mirrors. */
export interface UpstreamSource {
  /** Directory containing the pristine published contents of `pkg@version` (package.json at its root). */
  resolve(pkg: string, version: string): Promise<string>;
  /** The version installed in the project, if any. */
  installed(pkg: string): Promise<InstalledPackage | undefined>;
  /** Published versions and dist-tags. */
  versions(pkg: string): Promise<PackageVersions>;
  /** Spec to pass to a package manager to install `pkg@version` (e.g. `pkg@1.2.3`). */
  installSpec(pkg: string, version: string): string;
}

export interface NpmUpstreamOptions {
  /** Project root; installed packages are looked up from here. */
  root: string;
  /** Directory for extracted tarballs. */
  cacheDir: string;
  /**
   * Per-package spec templates overriding the registry, with `{version}` substituted,
   * e.g. `{ "my-lib": "file:../mirror/my-lib-{version}.tgz" }`. Relative `file:` paths
   * resolve against `specBase`.
   */
  specs?: Record<string, string>;
  specBase?: string;
  /**
   * Per-package directory (absolute) to resolve the installed copy from, for monorepos
   * where the dependency is declared by a workspace package rather than the root.
   */
  resolveFrom?: Record<string, string>;
}

/** Finds `node_modules/<pkg>/package.json` walking up from `from`. */
export async function findInstalledPackage(pkg: string, from: string): Promise<InstalledPackage | undefined> {
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(candidate)) {
      const json = JSON.parse(await readFile(candidate, 'utf8')) as { version?: string };
      if (json.version) return { version: json.version, dir: await realpath(path.dirname(candidate)) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Default source: pristine package contents from the npm registry (via pacote), cached per version. */
export class NpmUpstreamSource implements UpstreamSource {
  constructor(private readonly options: NpmUpstreamOptions) {}

  private spec(pkg: string, version: string): string {
    const template = this.options.specs?.[pkg];
    if (!template) return `${pkg}@${version}`;
    let spec = template.replaceAll('{version}', version);
    if (spec.startsWith('file:')) {
      const p = spec.slice(5);
      spec = `file:${path.resolve(this.options.specBase ?? this.options.root, p)}`;
    }
    return spec;
  }

  installSpec(pkg: string, version: string): string {
    const spec = this.spec(pkg, version);
    return spec.startsWith('file:') ? `${pkg}@${spec}` : spec;
  }

  async installed(pkg: string): Promise<InstalledPackage | undefined> {
    return findInstalledPackage(pkg, this.options.resolveFrom?.[pkg] ?? this.options.root);
  }

  async resolve(pkg: string, version: string): Promise<string> {
    // Always the pristine published contents, never the installed copy: mechanisms such as
    // patches modify the installed copy, and anchors must be checked against upstream as published.
    const spec = this.spec(pkg, version);
    if (spec.startsWith('file:')) {
      const p = spec.slice(5);
      if ((await stat(p).catch(() => null))?.isDirectory()) return p;
    }

    const dest = path.join(this.options.cacheDir, 'upstream', `${pkg.replace('/', '+')}@${version}`);
    if (existsSync(path.join(dest, 'package.json'))) return dest;
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    try {
      const { default: pacote } = await import('pacote');
      await pacote.extract(spec, tmp, { cache: path.join(this.options.cacheDir, 'pacote') });
      await rm(dest, { recursive: true, force: true });
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw new GraftError(`could not fetch ${spec}: ${(err as Error).message}`, 'upstream/fetch');
    }
    return dest;
  }

  async versions(pkg: string): Promise<PackageVersions> {
    try {
      const { default: pacote } = await import('pacote');
      const packument = await pacote.packument(pkg, { cache: path.join(this.options.cacheDir, 'pacote') });
      return { versions: Object.keys(packument.versions), distTags: { ...packument['dist-tags'] } };
    } catch (err) {
      throw new GraftError(`could not read versions of ${pkg}: ${(err as Error).message}`, 'upstream/versions');
    }
  }
}

/** A source backed by local directories, one per version. Useful for tests and offline evals. */
export class DirectoryUpstreamSource implements UpstreamSource {
  constructor(
    /** `{ [pkg]: { [version]: absoluteDir } }` */
    private readonly dirs: Record<string, Record<string, string>>,
    private readonly installedVersions: Record<string, string> = {},
    private readonly distTags: Record<string, Record<string, string>> = {},
  ) {}

  async resolve(pkg: string, version: string): Promise<string> {
    const dir = this.dirs[pkg]?.[version];
    if (!dir) throw new GraftError(`no local directory for ${pkg}@${version}`, 'upstream/fetch');
    return dir;
  }

  async installed(pkg: string): Promise<InstalledPackage | undefined> {
    const version = this.installedVersions[pkg];
    if (!version) return undefined;
    return { version, dir: await this.resolve(pkg, version) };
  }

  setInstalled(pkg: string, version: string): void {
    this.installedVersions[pkg] = version;
  }

  async versions(pkg: string): Promise<PackageVersions> {
    return { versions: Object.keys(this.dirs[pkg] ?? {}), distTags: this.distTags[pkg] ?? {} };
  }

  installSpec(pkg: string, version: string): string {
    return `${pkg}@${version}`;
  }
}
