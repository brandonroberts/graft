import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { semverScheme } from '@graftsync/spec';
import { extract as tarExtract } from 'tar';
import { parseDocument } from 'yaml';
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

export interface InstalledLookupOptions {
  /**
   * Directory to resolve `pkg` from before falling back to `resolveFrom[pkg]` / project root.
   * Used when resolving a sibling or workspace-local dependency relative to a rootstock's directory.
   */
  from?: string;
  /**
   * When true, return `undefined` instead of throwing `upstream/ambiguous-installed` if pnpm's
   * virtual store contains multiple active versions and no direct `node_modules` copy matched.
   */
  allowAmbiguous?: boolean;
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
  installed(pkg: string, options?: InstalledLookupOptions): Promise<InstalledPackage | undefined>;
  /**
   * Every installed copy of `pkg` across the project (primary copy first, then any nested copies),
   * deduplicated by real path. Ecosystems without nested copy trees omit this.
   */
  installedCopies?(pkg: string, options?: InstalledLookupOptions): Promise<InstalledPackage[]>;
  /** Published versions and dist-tags. */
  versions(pkg: string): Promise<PackageVersions>;
  /** Spec to pass to a package manager to install `pkg@version` (e.g. `pkg@1.2.3`). */
  installSpec(pkg: string, version: string): string;
}

/**
 * Merge `resolveFrom` and `ecosystems.npm.resolveFrom` (`ecosystems.npm` wins), resolving
 * every path against `root`. Single source of truth for workspace-scoped npm resolution.
 */
export function npmResolveFrom(
  config: { resolveFrom?: Record<string, string>; ecosystems?: Partial<Record<string, Record<string, unknown>>> },
  root: string,
): Record<string, string> {
  const own = (config.ecosystems?.npm as { resolveFrom?: Record<string, string> } | undefined)?.resolveFrom;
  const merged = { ...config.resolveFrom, ...own };
  return Object.fromEntries(Object.entries(merged).map(([pkg, dir]) => [pkg, path.resolve(root, dir)]));
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

async function probePnp(
  runtime: string,
  query: { pkg?: string; issuer?: string; dir?: string; files?: string[] },
): Promise<PnpProbe | null> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['-r', runtime, '-e', PNP_PROBE, JSON.stringify({ files: [], ...query })],
    {
      cwd: path.dirname(runtime),
      maxBuffer: 256 * 1024 * 1024,
    },
  );
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
 * Versions of `pkg` currently active in `<storeDir>/lock.yaml`'s `packages:` section, or
 * undefined if the lockfile isn't present or lists no entries for `pkg`. Filters out stale
 * unreferenced directories that `pnpm update` leaves behind in `node_modules/.pnpm/`.
 */
export function activePnpmLockVersions(storeDir: string, pkg: string): Set<string> | undefined {
  const lockFile = path.join(storeDir, 'lock.yaml');
  if (!existsSync(lockFile)) return undefined;
  let text: string;
  try {
    text = readFileSync(lockFile, 'utf8');
  } catch {
    return undefined;
  }
  const prefix = `${pkg}@`;
  const versions = new Set<string>();
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (!inPackages) {
      if (line === 'packages:') inPackages = true;
      continue;
    }
    if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t') break;
    if (!line.startsWith('  ') || line[2] === ' ') continue;
    let key = line.slice(2).trim();
    if (key.endsWith(':')) key = key.slice(0, -1).trim();
    if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
      key = key.slice(1, -1);
    }
    if (key.startsWith('/')) key = key.slice(1);
    if (!key.startsWith(prefix)) continue;
    const ver = key.slice(prefix.length).split(/[_(]/, 1)[0];
    if (ver) versions.add(ver);
  }
  return versions.size ? versions : undefined;
}

/**
 * Look up a transitive package inside pnpm's virtual store (`node_modules/.pnpm/`), walking up
 * from `from` to the nearest `.pnpm` directory. Returns the package when one distinct version is
 * installed; throws `upstream/ambiguous-installed` when multiple distinct versions are present
 * (unless `allowAmbiguous` is set, in which case returns `undefined`).
 */
async function findInPnpmStore(pkg: string, from: string, allowAmbiguous = false): Promise<InstalledPackage | undefined> {
  let dir = path.resolve(from);
  let pnpmDir: string | undefined;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.pnpm');
    if (existsSync(candidate)) {
      pnpmDir = candidate;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  const active = activePnpmLockVersions(pnpmDir, pkg);
  const prefix = `${pkg.replace('/', '+')}@`;
  const entries = (await readdir(pnpmDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => e.name)
    .sort();
  const byVersion = new Map<string, string>();
  for (const entry of entries) {
    const pkgJson = path.join(pnpmDir, entry, 'node_modules', pkg, 'package.json');
    if (!existsSync(pkgJson)) continue;
    try {
      const json = JSON.parse(await readFile(pkgJson, 'utf8')) as { name?: string; version?: string };
      if (json.version && (!json.name || json.name === pkg) && (!active || active.has(json.version)) && !byVersion.has(json.version)) {
        byVersion.set(json.version, await realpath(path.dirname(pkgJson)));
      }
    } catch {
      // ignore unreadable entries
    }
  }
  if (byVersion.size === 0) return undefined;
  if (byVersion.size > 1) {
    if (allowAmbiguous) return undefined;
    const versions = [...byVersion.keys()].sort().join(', ');
    throw new GraftError(
      `multiple versions of ${pkg} are installed in pnpm's store (${versions}); set resolveFrom["${pkg}"] in .grafts/config.json to the directory that resolves the copy you want`,
      'upstream/ambiguous-installed',
    );
  }
  const [[version, resolvedDir]] = [...byVersion.entries()] as [[string, string]];
  return { version, dir: resolvedDir };
}

/**
 * Resolve `pkg` directly from `from` (via Yarn Plug'n'Play or walking up `node_modules/<pkg>/package.json`)
 * without falling back to pnpm's virtual store.
 */
export async function findDirectInstalledPackage(pkg: string, from: string): Promise<InstalledPackage | undefined> {
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
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Finds the installed `pkg` as seen from `from`: through the Plug'n'Play runtime when the
 * project has one (yarn 2+ `.pnp.cjs`), otherwise `node_modules/<pkg>/package.json` walking up,
 * falling back to pnpm's virtual store (`node_modules/.pnpm/`) for unhoisted transitive packages.
 */
export async function findInstalledPackage(
  pkg: string,
  from: string,
  options?: { allowAmbiguous?: boolean },
): Promise<InstalledPackage | undefined> {
  return (await findDirectInstalledPackage(pkg, from)) ?? findInPnpmStore(pkg, from, options?.allowAmbiguous);
}

/**
 * Every installed copy of `pkg` under one or more roots' `node_modules` trees (hoisted and nested),
 * deduplicated by real path. pnpm's virtual store (`.pnpm`) is skipped: pnpm patches natively.
 */
export async function findInstalledCopies(roots: string | string[], pkg: string, maxDepth = 12): Promise<InstalledPackage[]> {
  const rootList = Array.isArray(roots) ? roots : [roots];
  const copies = new Map<string, InstalledPackage>();
  const visited = new Set<string>();
  const visit = async (nodeModules: string, depth: number): Promise<void> => {
    if (depth > maxDepth || !existsSync(nodeModules)) return;
    const real = await realpath(nodeModules);
    if (visited.has(real)) return;
    visited.add(real);
    const candidate = path.join(nodeModules, pkg, 'package.json');
    if (existsSync(candidate)) {
      try {
        const dir = await realpath(path.dirname(candidate));
        const { version } = JSON.parse(await readFile(candidate, 'utf8')) as { version?: string };
        if (version && !copies.has(dir)) copies.set(dir, { dir, version });
      } catch {
        // ignore unreadable manifests
      }
    }
    const entries = await readdir(nodeModules, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // .bin, .cache, .pnpm, .package-lock.json …
      const names = e.name.startsWith('@')
        ? (await readdir(path.join(nodeModules, e.name)).catch(() => [])).map((n) => `${e.name}/${n}`)
        : [e.name];
      for (const name of names) await visit(path.join(nodeModules, name, 'node_modules'), depth + 1);
    }
  };
  for (const root of rootList) await visit(path.join(path.resolve(root), 'node_modules'), 0);
  return [...copies.values()];
}

function uniqueDirs(dirs: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    if (!d) continue;
    const resolved = path.resolve(d);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
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
      // A project pinned to another package manager (Corepack or devEngines.packageManager)
      // or with a .npmrc min-release-age must not stop us from asking npm for read-only
      // registry metadata/tarballs (cooldown filtering happens in versions(), and installs
      // still enforce the project's policy).
      env: {
        ...process.env,
        COREPACK_ENABLE_STRICT: '0',
        npm_config_force: 'true',
        npm_config_min_release_age: '0',
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
      },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string; code?: string };
    if (e.code === 'ENOENT') throw new Error('npm was not found on PATH (Graft uses it to fetch pristine packages)', { cause: err });
    const detail = (e.stderr || e.message)
      .trim()
      .split('\n')
      .filter((l) => !/^npm (notice|warn)/.test(l))
      .slice(-3)
      .join(' ');
    throw new Error(detail || e.message, { cause: err });
  }
}

/** JSON from npm's stdout, ignoring any lines printed before it. */
const npmJson = (stdout: string): unknown =>
  JSON.parse(stdout.slice(Math.min(...['[', '{'].map((c) => stdout.indexOf(c)).filter((i) => i >= 0))));

/**
 * Combine a primary installed copy with every copy found under `roots`' `node_modules` trees,
 * keeping `primary` first and deduplicating by real path.
 */
export async function mergeInstalledCopies(
  primary: InstalledPackage,
  roots: (string | undefined)[],
  pkg: string,
): Promise<InstalledPackage[]> {
  if (primary.pnp) return [primary];
  const primaryReal = await realpath(primary.dir).catch(() => path.resolve(primary.dir));
  const copies = await findInstalledCopies(uniqueDirs(roots), pkg);
  const seen = new Set<string>([primaryReal]);
  const rest: InstalledPackage[] = [];
  for (const copy of copies) {
    const real = await realpath(copy.dir).catch(() => path.resolve(copy.dir));
    if (seen.has(real)) continue;
    seen.add(real);
    rest.push(copy);
  }
  return [primary, ...rest];
}

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

  async installed(pkg: string, options?: InstalledLookupOptions): Promise<InstalledPackage | undefined> {
    const roots = uniqueDirs([options?.from, this.options.resolveFrom?.[pkg], this.options.root]);
    for (const dir of roots) {
      const direct = await findDirectInstalledPackage(pkg, dir);
      if (direct) return direct;
    }
    return findInPnpmStore(pkg, roots[0] ?? this.options.root, options?.allowAmbiguous);
  }

  async installedCopies(pkg: string, options?: InstalledLookupOptions): Promise<InstalledPackage[]> {
    const primary = await this.installed(pkg, options);
    if (!primary) return [];
    return mergeInstalledCopies(primary, [this.options.root, this.options.resolveFrom?.[pkg], options?.from], pkg);
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
      const policy = readNpmReleaseAgePolicy(this.options.root);
      const hasCooldown = (policy.npmMs ?? 0) > 0 || (policy.pnpmMs ?? 0) > 0;
      const fields = hasCooldown ? ['versions', 'dist-tags', 'time'] : ['versions', 'dist-tags'];
      const parsed = parseNpmViewVersions(npmJson(await npm(['view', pkg, ...fields, '--json'], this.options.root)));
      return hasCooldown ? filterVersionsByReleaseAge(pkg, parsed, policy) : { versions: parsed.versions, distTags: parsed.distTags };
    } catch (err) {
      throw new GraftError(`could not read versions of ${pkg}: ${(err as Error).message}`, 'upstream/versions');
    }
  }
}

/**
 * Parse the JSON output of `npm view <pkg> versions dist-tags [time] --json`.
 * npm < 12 returns `{ versions, "dist-tags", time? }`, whereas npm 12+ wraps the object in a
 * single-element array `[{ versions, "dist-tags", time? }]`. Fails loudly on unexpected/empty
 * shapes so registry format changes never silently look "up to date".
 */
export function parseNpmViewVersions(raw: unknown): {
  versions: string[];
  distTags: Record<string, string>;
  time?: Record<string, string>;
} {
  const entry = Array.isArray(raw) ? raw.at(-1) : raw;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('npm view returned an unexpected JSON shape (expected an object or non-empty array of objects)');
  }
  const info = entry as {
    versions?: string | string[];
    'dist-tags'?: Record<string, string>;
    time?: Record<string, string>;
  };
  const versions = typeof info.versions === 'string' ? [info.versions] : Array.isArray(info.versions) ? info.versions : [];
  const distTags =
    info['dist-tags'] && typeof info['dist-tags'] === 'object' && !Array.isArray(info['dist-tags']) ? { ...info['dist-tags'] } : {};
  if (!versions.length && !Object.keys(distTags).length) {
    throw new Error('npm view returned no versions or dist-tags');
  }
  const time = info.time && typeof info.time === 'object' && !Array.isArray(info.time) ? { ...info.time } : undefined;
  return { versions, distTags, ...(time ? { time } : {}) };
}

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

/** Project release-age cooldown settings from `.npmrc` and `pnpm-workspace.yaml` (#75, #78). */
export interface NpmReleaseAgePolicy {
  /** Cooldown from `.npmrc` (`min-release-age`, days) or `npm_config_min_release_age`, in ms. */
  npmMs?: number;
  /** Exemption patterns from `.npmrc` `min-release-age-exclude[]` / `min-release-age-exclude`. */
  npmExclude?: string[];
  /** Cooldown from `pnpm-workspace.yaml` (`minimumReleaseAge`, minutes), in ms. */
  pnpmMs?: number;
  /** Exemption patterns from `pnpm-workspace.yaml` `minimumReleaseAgeExclude`. */
  pnpmExclude?: string[];
}

function parseNpmrcReleaseAge(text: string): { days?: number; exclude: string[] } {
  let days: number | undefined;
  const exclude: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const stripVal = (s: string) =>
      s
        .replace(/\s+[#;].*$/, '')
        .trim()
        .replace(/^["']|["']$/g, '');
    const mDays = /^min-release-age\s*=\s*(.+)$/.exec(line);
    if (mDays) {
      const value = stripVal(mDays[1]!);
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) days = n;
      else if (value === '0' || value === 'false') days = 0;
      continue;
    }
    const mExcl = /^min-release-age-exclude(?:\[\])?\s*=\s*(.+)$/.exec(line);
    if (mExcl) {
      const value = stripVal(mExcl[1]!);
      if (value) exclude.push(value);
    }
  }
  return { days, exclude };
}

const PROJECT_BOUNDARIES = ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', '.git'];

/**
 * Read the project's npm/pnpm release-age cooldown settings walking up from `root` to the
 * workspace/project root (stopping at the first `.git` or lockfile/workspace boundary).
 */
export function readNpmReleaseAgePolicy(root: string): NpmReleaseAgePolicy {
  const policy: NpmReleaseAgePolicy = {};
  const envRaw = process.env.npm_config_min_release_age;
  if (envRaw !== undefined && envRaw.trim() !== '') {
    const n = Number(envRaw.trim());
    if (Number.isFinite(n) && n > 0) policy.npmMs = n * DAY_MS;
  }

  let dir = path.resolve(root);
  for (;;) {
    if (policy.npmMs === undefined || policy.npmExclude === undefined) {
      const npmrc = path.join(dir, '.npmrc');
      if (existsSync(npmrc)) {
        try {
          const parsed = parseNpmrcReleaseAge(readFileSync(npmrc, 'utf8'));
          if (policy.npmMs === undefined && parsed.days !== undefined) policy.npmMs = parsed.days > 0 ? parsed.days * DAY_MS : 0;
          if (policy.npmExclude === undefined && parsed.exclude.length) policy.npmExclude = parsed.exclude;
        } catch {
          // ignore unreadable .npmrc
        }
      }
    }
    if (policy.pnpmMs === undefined) {
      const ws = path.join(dir, 'pnpm-workspace.yaml');
      if (existsSync(ws)) {
        try {
          const doc = parseDocument(readFileSync(ws, 'utf8'));
          const mins = Number(doc.get('minimumReleaseAge'));
          if (Number.isFinite(mins) && mins > 0) policy.pnpmMs = mins * MINUTE_MS;
          const exclude = doc.get('minimumReleaseAgeExclude');
          if (exclude && typeof exclude === 'object' && 'toJSON' in exclude) {
            const list = (exclude as { toJSON: () => unknown }).toJSON();
            if (Array.isArray(list)) policy.pnpmExclude = list.filter((s): s is string => typeof s === 'string');
          }
        } catch {
          // ignore unreadable workspace file
        }
      }
    }
    const atBoundary = PROJECT_BOUNDARIES.some((f) => existsSync(path.join(dir, f)));
    const parent = path.dirname(dir);
    if (atBoundary || parent === dir) break;
    dir = parent;
  }
  return policy;
}

/** True when a `minimumReleaseAgeExclude` / `min-release-age-exclude[]` pattern (`pkg`, `pkg@version`, `@scope/*`, `pkg@1.*`) matches `pkg@version`. */
export function matchesReleaseAgeExclude(pattern: string, pkg: string, version: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  const hasVersion = trimmed.indexOf('@', 1) > 0;
  const target = hasVersion ? `${pkg}@${version}` : pkg;
  if (!trimmed.includes('*')) return target === trimmed;
  const re = new RegExp(`^${trimmed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
  return re.test(target);
}

/**
 * Filter npm `versions` and `distTags` by a project's release-age cooldown policy (#75, #78).
 * When `pnpm-workspace.yaml` sets `minimumReleaseAge`, pnpm's cooldown and exclusions govern
 * (so `.npmrc` settings kept for npm consumers do not override `minimumReleaseAgeExclude`).
 * When `latest` is blocked by the cooldown, falls back to the highest eligible stable version
 * `<= latest` so `graft outdated` only recommends versions the package manager will accept.
 */
export function filterVersionsByReleaseAge(
  pkg: string,
  data: { versions: string[]; distTags: Record<string, string>; time?: Record<string, string> },
  policy: NpmReleaseAgePolicy,
  nowMs: number = Date.now(),
): PackageVersions {
  const time = data.time ?? {};
  const isEligible = (v: string): boolean => {
    const pnpmExcluded = (policy.pnpmExclude ?? []).some((pat) => matchesReleaseAgeExclude(pat, pkg, v));
    const npmExcluded = (policy.npmExclude ?? []).some((pat) => matchesReleaseAgeExclude(pat, pkg, v));
    const cooldownMs = policy.pnpmMs !== undefined ? (pnpmExcluded ? 0 : policy.pnpmMs) : npmExcluded ? 0 : (policy.npmMs ?? 0);
    if (cooldownMs <= 0) return true;
    const raw = time[v];
    if (!raw) return true;
    const publishedMs = Date.parse(raw);
    if (!Number.isFinite(publishedMs)) return true;
    return nowMs - publishedMs >= cooldownMs;
  };

  const versions = data.versions.filter(isEligible);
  const distTags: Record<string, string> = {};
  for (const [tag, v] of Object.entries(data.distTags)) {
    if (isEligible(v)) {
      distTags[tag] = v;
    } else if (tag === 'latest') {
      const fallback = versions
        .filter((cand) => {
          if (!semverScheme.valid(cand) || cand.split('+', 1)[0]!.includes('-')) return false;
          return !semverScheme.valid(v) || semverScheme.compare(cand, v) <= 0;
        })
        .sort((a, b) => semverScheme.compare(b, a))[0];
      if (fallback) distTags.latest = fallback;
    }
  }
  return { versions, distTags };
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
