// The vendored override applier: build pristine upstream + the selected variant into a
// tarball committed under .grafts/.vendor/, and point the package manager's overrides (and
// the root's own dependency) at it. The package manager then installs the patched package as
// an ordinary dependency: recorded with its integrity in the lockfile, surviving fresh
// installs, `--ignore-scripts`, and "repair"/verify passes, with no install hooks at all.
// It is the only applier that works with upm, which never runs the project's postinstall and
// repairs edited package files.
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { create as tarCreate, list as tarList } from 'tar';
import { detectPackageManager, type UpstreamSource } from '@graftsync/core';
import { applyToInstalledCopy } from './installed.js';
import { parsePatchFile } from './patchfile.js';
import { WORKSPACE_FILE } from './pnpm.js';

export const VENDOR_DIR = '.grafts/.vendor';
/** Fixed mtime for every tarball entry, so rebuilding identical contents gives identical bytes. */
const FIXED_MTIME = new Date('2000-01-01T00:00:00Z');
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

export const vendorFileName = (pkg: string, version: string) => `${pkg.replace('/', '+')}-${version}.tgz`;
const vendorPrefix = (pkg: string) => `${pkg.replace('/', '+')}-`;
const posix = (p: string) => p.split(path.sep).join('/');

async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, child)));
    else if (e.isFile()) out.push(child);
  }
  return out.sort();
}

/** Contents of a .tgz as path → bytes (for content, not byte, comparison across platforms). */
export async function tarballContents(file: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  await tarList({
    file,
    onReadEntry: (entry) => {
      const chunks: Buffer[] = [];
      entry.on('data', (c: Buffer) => chunks.push(c));
      entry.on('end', () => {
        if (entry.type === 'File') entries.set(entry.path, Buffer.concat(chunks));
      });
    },
  });
  return entries;
}

const sameContents = (a: Map<string, Buffer>, b: Map<string, Buffer>) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k)?.equals(v));

/** Build pristine + variant into a temp .tgz; returns its path (caller removes the temp dir). */
export async function buildVendorTarball(pristineDir: string, variantPath: string): Promise<{ file: string; tmp: string }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'graft-vendor-'));
  const stage = path.join(tmp, 'package');
  await cp(pristineDir, stage, { recursive: true });
  const result = await applyToInstalledCopy({ dir: stage, version: '' }, parsePatchFile(await readFile(variantPath, 'utf8')));
  if (result.action !== 'patched') {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(`cannot build the vendored package: ${result.reason ?? `variant ${result.action}`}`);
  }
  const files = (await listFiles(stage)).map((f) => `package/${f}`);
  const file = path.join(tmp, 'vendor.tgz');
  await tarCreate({ gzip: true, file, cwd: tmp, portable: true, mtime: FIXED_MTIME }, files);
  return { file, tmp };
}

async function readManifest(installRoot: string) {
  const file = path.join(installRoot, 'package.json');
  const text = await readFile(file, 'utf8');
  return { file, text, json: JSON.parse(text) as Record<string, any> };
}

async function writeManifest(m: { file: string; text: string; json: Record<string, unknown> }) {
  const indent = /^[ \t]+/m.exec(m.text)?.[0] ?? '  ';
  const next = `${JSON.stringify(m.json, null, indent)}\n`;
  if (next !== m.text) await writeFile(m.file, next);
}

/** Where this package manager reads overrides from. */
function overrideLocation(installRoot: string): { kind: 'overrides' | 'resolutions' | 'pnpm-json' | 'pnpm-yaml' } {
  const pm = detectPackageManager(installRoot);
  if (pm === 'yarn' || pm === 'yarn-berry') return { kind: 'resolutions' };
  if (pm === 'pnpm') return { kind: existsSync(path.join(installRoot, WORKSPACE_FILE)) ? 'pnpm-yaml' : 'pnpm-json' };
  return { kind: 'overrides' }; // npm, bun, upm
}

/**
 * The override value. npm resolves a `file:` override relative to each *consuming* package
 * (node_modules/<dependent>/…), so for npm the override references the root's own dependency
 * (`$<pkg>`), which npm resolves against the root.
 */
const overrideValue = (installRoot: string, pkg: string, spec: string) => (detectPackageManager(installRoot) === 'npm' ? `$${pkg}` : spec);

async function readOverride(installRoot: string, json: Record<string, any>, pkg: string): Promise<string | undefined> {
  const loc = overrideLocation(installRoot);
  if (loc.kind === 'overrides') return json.overrides?.[pkg];
  if (loc.kind === 'resolutions') return json.resolutions?.[pkg];
  if (loc.kind === 'pnpm-json') return json.pnpm?.overrides?.[pkg];
  const doc = parseDocument(await readFile(path.join(installRoot, WORKSPACE_FILE), 'utf8'));
  return doc.getIn(['overrides', pkg]) as string | undefined;
}

const lockKeyIsFor = (key: string, pkg: string) => key === `node_modules/${pkg}` || key.endsWith(`/node_modules/${pkg}`);

/**
 * npm keeps nested copies already in package-lock.json and, when it later applies the
 * override to them, resolves the root-relative `file:` path relative to the dependent
 * (ENOENT). Dropping every locked entry for `pkg` makes npm re-resolve them all to the
 * vendored package. Returns the lockfile path if it changed.
 */
async function pruneNpmLock(installRoot: string, pkg: string): Promise<string | undefined> {
  const file = path.join(installRoot, 'package-lock.json');
  if (!existsSync(file)) return undefined;
  const text = await readFile(file, 'utf8');
  let lock: { packages?: Record<string, unknown>; dependencies?: Record<string, unknown> };
  try {
    lock = JSON.parse(text);
  } catch {
    return undefined;
  }
  let changed = false;
  for (const key of Object.keys(lock.packages ?? {})) {
    if (lockKeyIsFor(key, pkg)) {
      delete lock.packages![key];
      changed = true;
    }
  }
  if (lock.dependencies?.[pkg]) {
    delete lock.dependencies[pkg];
    changed = true;
  }
  if (!changed) return undefined;
  const indent = /^[ \t]+/m.exec(text)?.[0] ?? '  ';
  await writeFile(file, `${JSON.stringify(lock, null, indent)}\n`);
  return file;
}

/** package-lock.json entries for `pkg` that are not the vendored tarball. */
async function strayNpmLockEntries(installRoot: string, pkg: string, spec: string): Promise<string[]> {
  const file = path.join(installRoot, 'package-lock.json');
  if (!existsSync(file)) return [];
  try {
    const lock = JSON.parse(await readFile(file, 'utf8')) as { packages?: Record<string, { resolved?: string }> };
    return Object.entries(lock.packages ?? {})
      .filter(([key, entry]) => lockKeyIsFor(key, pkg) && entry.resolved !== spec)
      .map(([key, entry]) => `${key} (${entry.resolved ?? 'unresolved'})`);
  } catch {
    return [];
  }
}

export interface VendorContext {
  upstream?: UpstreamSource;
  /** Directory containing .grafts/ (the vendored tarballs live under it). */
  graftRoot: string;
  /** Directory with the package.json that declares overrides (install root). */
  installRoot: string;
}

/** Builds the expected tarball into a temp dir (the caller removes `tmp`). */
export type TarballBuilder = () => Promise<{ file: string; tmp: string }>;

export async function vendorProblems(ctx: VendorContext, pkg: string, version: string, variantPath: string): Promise<string[]> {
  const build = ctx.upstream ? async () => buildVendorTarball(await ctx.upstream!.resolve(pkg, version), variantPath) : undefined;
  return vendoredTarballProblems(ctx, pkg, version, build, `pristine ${pkg}@${version} + ${posix(path.relative(ctx.installRoot, variantPath))}`);
}

/**
 * Problems with installing `pkg@version` from a vendored tarball through overrides: the
 * tarball is missing or stale (when `build` is given, its contents must equal a fresh build,
 * described by `expected`), overrides / root dependency / npm lock entries point elsewhere, or
 * a competing patch is configured. Shared by the vendor applier and the fork mechanism.
 */
export async function vendoredTarballProblems(
  ctx: VendorContext,
  pkg: string,
  version: string,
  build: TarballBuilder | undefined,
  expected: string,
): Promise<string[]> {
  const { installRoot } = ctx;
  const problems: string[] = [];
  const vendorDir = path.join(ctx.graftRoot, VENDOR_DIR);
  const tarball = path.join(vendorDir, vendorFileName(pkg, version));
  const spec = `file:${posix(path.relative(installRoot, tarball))}`;
  const { json } = await readManifest(installRoot);

  if (!existsSync(tarball)) {
    problems.push(`${posix(path.relative(installRoot, tarball))} is missing; run \`graft apply\``);
  } else if (build) {
    const built = await build().catch((err: Error) => err);
    if (built instanceof Error) problems.push(built.message);
    else {
      try {
        if (!sameContents(await tarballContents(built.file), await tarballContents(tarball))) {
          problems.push(`${posix(path.relative(installRoot, tarball))} is stale (it is not ${expected}); run \`graft apply\``);
        }
      } finally {
        await rm(built.tmp, { recursive: true, force: true });
      }
    }
  }
  const override = await readOverride(installRoot, json, pkg);
  const expectedOverride = overrideValue(installRoot, pkg, spec);
  const where = { overrides: 'package.json overrides', resolutions: 'package.json resolutions', 'pnpm-json': 'package.json pnpm.overrides', 'pnpm-yaml': `${WORKSPACE_FILE} overrides` }[overrideLocation(installRoot).kind];
  if (override !== expectedOverride) problems.push(`${where}["${pkg}"] must be "${expectedOverride}"${override ? ` (is "${override}")` : ''}`);
  if (expectedOverride.startsWith('$') && !DEP_FIELDS.some((f) => json[f]?.[pkg] !== undefined)) {
    problems.push(`package.json must declare ${pkg} as a dependency ("${spec}") for npm's "$${pkg}" override reference`);
  }
  if (detectPackageManager(installRoot) === 'npm') {
    for (const entry of await strayNpmLockEntries(installRoot, pkg, spec)) {
      problems.push(`package-lock.json still locks ${entry} instead of the vendored package; run \`graft apply\``);
    }
  }
  for (const field of DEP_FIELDS) {
    const declared = json[field]?.[pkg];
    if (declared !== undefined && declared !== spec) {
      const why = detectPackageManager(installRoot) === 'npm' ? '; npm refuses an override that differs from a direct dependency' : '';
      problems.push(`package.json ${field}["${pkg}"] must be "${spec}" (is "${declared}")${why}`);
    }
  }
  if (existsSync(vendorDir)) {
    for (const f of (await readdir(vendorDir)).filter((f) => f.startsWith(vendorPrefix(pkg)) && /^\d/.test(f.slice(vendorPrefix(pkg).length)) && f !== path.basename(tarball))) {
      problems.push(`${VENDOR_DIR}/${f} is for another version of ${pkg}; remove it`);
    }
  }
  if (Object.keys(json.patchedDependencies ?? {}).some((k) => k === pkg || k.startsWith(`${pkg}@`))) {
    problems.push(`package.json patchedDependencies also patches ${pkg}; the vendored package already contains the patch — remove the entry`);
  }
  return problems;
}

export async function vendorConfigure(ctx: VendorContext, pkg: string, version: string, variantPath: string): Promise<{ files: string[] }> {
  if (!ctx.upstream) throw new Error('the vendor applier needs the upstream source to build the patched package');
  const upstream = ctx.upstream;
  return installVendoredTarball(ctx, pkg, version, async () => buildVendorTarball(await upstream.resolve(pkg, version), variantPath));
}

/**
 * Commit a freshly built tarball as `.grafts/.vendor/<pkg>-<version>.tgz` (keeping the old bytes
 * when contents are unchanged, so lockfile integrity is stable), remove other versions' tarballs,
 * and point overrides, the root dependency and npm's lockfile at it. Shared by the vendor applier
 * and the fork mechanism.
 */
export async function installVendoredTarball(ctx: VendorContext, pkg: string, version: string, build: TarballBuilder): Promise<{ files: string[] }> {
  const { installRoot } = ctx;
  const vendorDir = path.join(ctx.graftRoot, VENDOR_DIR);
  await mkdir(vendorDir, { recursive: true });
  const tarball = path.join(vendorDir, vendorFileName(pkg, version));
  const built = await build();
  try {
    // Keep the existing bytes when contents are unchanged, so the lockfile's integrity is stable.
    if (!existsSync(tarball) || !sameContents(await tarballContents(built.file), await tarballContents(tarball))) {
      await rename(built.file, tarball).catch(async () => writeFile(tarball, await readFile(built.file)));
    }
  } finally {
    await rm(built.tmp, { recursive: true, force: true });
  }
  for (const f of await readdir(vendorDir)) {
    if (f.startsWith(vendorPrefix(pkg)) && /^\d/.test(f.slice(vendorPrefix(pkg).length)) && f !== path.basename(tarball)) await rm(path.join(vendorDir, f));
  }

  const spec = `file:${posix(path.relative(installRoot, tarball))}`;
  const m = await readManifest(installRoot);
  let declared = false;
  for (const field of DEP_FIELDS) {
    if (m.json[field]?.[pkg] !== undefined) {
      m.json[field][pkg] = spec;
      declared = true;
    }
  }
  const value = overrideValue(installRoot, pkg, spec);
  // npm's `$pkg` reference needs a root dependency; add one when the package is only transitive.
  if (value.startsWith('$') && !declared) (m.json.dependencies ??= {})[pkg] = spec;
  const loc = overrideLocation(installRoot);
  if (loc.kind === 'overrides') (m.json.overrides ??= {})[pkg] = value;
  if (loc.kind === 'resolutions') (m.json.resolutions ??= {})[pkg] = spec;
  if (loc.kind === 'pnpm-json') ((m.json.pnpm ??= {}).overrides ??= {})[pkg] = spec;
  const pd = m.json.patchedDependencies as Record<string, string> | undefined;
  if (pd) {
    for (const k of Object.keys(pd)) if (k === pkg || k.startsWith(`${pkg}@`)) delete pd[k];
    if (!Object.keys(pd).length) delete m.json.patchedDependencies;
  }
  await writeManifest(m);
  const files = [tarball, m.file];
  if (detectPackageManager(installRoot) === 'npm') {
    const lock = await pruneNpmLock(installRoot, pkg);
    if (lock) files.push(lock);
  }
  if (loc.kind === 'pnpm-yaml') {
    const yamlFile = path.join(installRoot, WORKSPACE_FILE);
    const doc = parseDocument(await readFile(yamlFile, 'utf8'));
    doc.setIn(['overrides', pkg], spec);
    for (const key of Object.keys((doc.get('patchedDependencies') as { toJSON?: () => object } | undefined)?.toJSON?.() ?? {})) {
      if (key === pkg || key.startsWith(`${pkg}@`)) doc.deleteIn(['patchedDependencies', key]);
    }
    await writeFile(yamlFile, doc.toString());
    files.push(yamlFile);
  }
  return { files };
}
