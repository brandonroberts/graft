import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { extract as tarExtract } from 'tar';
import { GraftError } from './errors.js';

export interface InstalledPackage {
  version: string;
  /**
   * Real path of the installed package directory. Under Plug'n'Play this can be a path inside
   * a zip archive (e.g. `~/.yarn/berry/cache/<pkg>-npm-<version>-<hash>.zip/node_modules/<pkg>/`),
   * readable only through the PnP runtime: use {@link readInstalledFiles}.
   */
  dir: string;
  /** The Plug'n'Play runtime (`.pnp.cjs`) the package was resolved through, if any. */
  pnp?: string;
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

/** The Plug'n'Play runtime (yarn 2+ `.pnp.cjs`) governing `from`, walking up; undefined without PnP. */
export function findPnpRuntime(from: string): string | undefined {
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, '.pnp.cjs');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Runs under `node -r <.pnp.cjs>`, so `fs` reads through PnP's zip layer. Given a package name
// and an issuer it resolves the package directory; given a directory it reads from it. Prints
// { dir, version, files: { [rel]: string | null } }, or null when the package does not resolve.
const PNP_PROBE = `
const fs = require('fs'), path = require('path');
const { pkg, issuer, dir: given, files } = JSON.parse(process.argv[1]);
let dir = given;
if (!dir) { try { dir = require('pnpapi').resolveToUnqualified(pkg, issuer); } catch { dir = null; } }
if (!dir) { process.stdout.write('null'); process.exit(0); }
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
const out = { dir, version: JSON.parse(read('package.json') || '{}').version || null, files: {} };
for (const f of files) out.files[f] = read(f);
process.stdout.write(JSON.stringify(out));
`;

interface PnpProbe {
  dir: string;
  version: string | null;
  files: Record<string, string | null>;
}

async function probePnp(runtime: string, query: { pkg?: string; issuer?: string; dir?: string; files?: string[] }): Promise<PnpProbe | null> {
  const { stdout } = await promisify(execFile)(process.execPath, ['-r', runtime, '-e', PNP_PROBE, JSON.stringify({ files: [], ...query })], {
    cwd: path.dirname(runtime),
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(stdout) as PnpProbe | null;
}

/**
 * Read files of an installed package (paths relative to its directory). Works for plain
 * directories and, through the PnP runtime, for packages stored in yarn's zip cache. A missing
 * file reads as undefined; failing to run the PnP runtime throws.
 */
export async function readInstalledFiles(installed: InstalledPackage, files: string[]): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  if (!installed.pnp) {
    for (const f of files) {
      const full = path.join(installed.dir, f);
      out[f] = existsSync(full) ? await readFile(full, 'utf8') : undefined;
    }
    return out;
  }
  const probe = await probePnp(installed.pnp, { dir: installed.dir, files });
  if (!probe) throw new Error(`could not read ${installed.dir} through the Plug'n'Play runtime ${installed.pnp}`);
  for (const f of files) out[f] = probe.files[f] ?? undefined;
  return out;
}

/**
 * Finds the installed `pkg` as seen from `from`: through the Plug'n'Play runtime when the
 * project has one (yarn 2+ `.pnp.cjs`), otherwise `node_modules/<pkg>/package.json` walking up.
 */
export async function findInstalledPackage(pkg: string, from: string): Promise<InstalledPackage | undefined> {
  const pnp = findPnpRuntime(from);
  if (pnp) {
    const probe = await probePnp(pnp, { pkg, issuer: `${path.resolve(from)}${path.sep}` }).catch(() => null);
    if (probe?.version) return { version: probe.version, dir: probe.dir, pnp };
  }
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

/**
 * Run the project's npm, from the project root, so the project's `.npmrc` applies (registries,
 * scoped registries, auth, proxies). Asking npm itself keeps Graft's own dependencies small.
 */
async function npm(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)('npm', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5 * 60_000,
      shell: process.platform === 'win32',
      // A project pinned to another package manager must not stop us from asking npm.
      env: { ...process.env, COREPACK_ENABLE_STRICT: '0', npm_config_update_notifier: 'false', npm_config_fund: 'false' },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string; code?: string };
    if (e.code === 'ENOENT') throw new Error('npm was not found on PATH (Graft uses it to fetch pristine packages)');
    const detail = (e.stderr || e.message).trim().split('\n').filter((l) => !/^npm (notice|warn)/.test(l)).slice(-3).join(' ');
    throw new Error(detail || e.message);
  }
}

/** JSON from npm's stdout, ignoring any lines printed before it. */
const npmJson = (stdout: string): unknown => JSON.parse(stdout.slice(Math.min(...['[', '{'].map((c) => stdout.indexOf(c)).filter((i) => i >= 0))));

/** Default source: pristine package contents from the npm registry (fetched by npm), cached per version. */
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
      // npm downloads the tarball (through its own cache) without running any scripts.
      await mkdir(path.join(tmp, 'tgz'), { recursive: true });
      await npm(['pack', spec, '--json', '--ignore-scripts', '--pack-destination', path.join(tmp, 'tgz')], this.options.root);
      const tgz = (await readdir(path.join(tmp, 'tgz'))).find((f) => f.endsWith('.tgz'));
      if (!tgz) throw new Error('npm pack wrote no tarball');
      const out = path.join(tmp, 'package');
      await mkdir(out);
      await tarExtract({ file: path.join(tmp, 'tgz', tgz), cwd: out, strip: 1 });
      if (!existsSync(path.join(out, 'package.json'))) throw new Error('the tarball has no package.json');
      await rm(dest, { recursive: true, force: true });
      await rename(out, dest);
      await rm(tmp, { recursive: true, force: true });
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw new GraftError(`could not fetch ${spec}: ${(err as Error).message}`, 'upstream/fetch');
    }
    return dest;
  }

  async versions(pkg: string): Promise<PackageVersions> {
    try {
      const info = npmJson(await npm(['view', pkg, 'versions', 'dist-tags', '--json'], this.options.root)) as {
        versions?: string | string[];
        'dist-tags'?: Record<string, string>;
      };
      const versions = typeof info.versions === 'string' ? [info.versions] : (info.versions ?? []);
      return { versions, distTags: { ...info['dist-tags'] } };
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
