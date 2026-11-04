// How a patch variant is actually applied at install time, per package manager.
//
// Variants are always package-relative git patches (the format pnpm and bun write). Each
// applier wires the package manager so that the *selected* variant is applied, and reports
// any configuration that would apply something else or fail silently:
//
//   pnpm           patchedDependencies (name-only key) + ignorePatchFailures: false
//   bun            package.json patchedDependencies["<pkg>@<installed>"]; bun silently ignores
//                  name-only keys and keys for other versions, so the key tracks the version
//   patch-package  (npm, yarn classic) a generated <pkg>+<version>.patch in a graft-owned dir,
//                  applied by `patch-package --error-on-fail --error-on-warn` in postinstall;
//                  without those flags patch-package exits 0 on a failed patch (outside CI)
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { detectPackageManager } from '@graftsync/core';
import { configurePnpmPatch, findPnpmWorkspaceRoot, pnpmConfigProblems } from './pnpm.js';

export type ApplierName = 'pnpm' | 'bun' | 'patch-package';

export interface PatchApplier {
  name: ApplierName;
  /** Problems that would make the package manager apply something other than `variantPath`, or fail silently. */
  problems(root: string, pkg: string, version: string, variantPath: string): Promise<string[]>;
  /** Wire the package manager to apply `variantPath` to `pkg@version` on the next install. */
  configure(root: string, pkg: string, version: string, variantPath: string): Promise<{ files: string[] }>;
}

/** Pick the applier: explicit config wins, then the project's package manager. */
export function selectApplier(root: string, configured?: string): PatchApplier {
  const name = (configured ?? { pnpm: 'pnpm', bun: 'bun', npm: 'patch-package', yarn: 'patch-package' }[detectPackageManager(root)]) as ApplierName;
  const applier = APPLIERS[name];
  if (!applier) throw new Error(`unknown patch applier "${configured}" (expected pnpm | bun | patch-package)`);
  return applier;
}

const posix = (p: string) => p.split(path.sep).join('/');
const keyIsFor = (key: string, pkg: string) => key === pkg || (key.startsWith(`${pkg}@`) && key.length > pkg.length + 1);

/** Nearest directory at or above `from` with a package.json (the install root). */
function manifestRoot(from: string): string {
  let dir = path.resolve(from);
  let found: string | undefined;
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) found ??= dir;
    if (['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock'].some((f) => existsSync(path.join(dir, f)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return found ?? path.resolve(from);
    dir = parent;
  }
}

async function readManifest(root: string) {
  const file = path.join(root, 'package.json');
  const text = await readFile(file, 'utf8');
  return { file, text, json: JSON.parse(text) as Record<string, any> };
}

async function writeManifest(m: { file: string; text: string; json: Record<string, unknown> }) {
  const indent = /^[ \t]+/m.exec(m.text)?.[0] ?? '  ';
  const next = `${JSON.stringify(m.json, null, indent)}\n`;
  if (next !== m.text) await writeFile(m.file, next);
  return next !== m.text;
}

export const pnpmApplier: PatchApplier = {
  name: 'pnpm',
  problems: (root, pkg, _version, variantPath) => pnpmConfigProblems(root, pkg, variantPath),
  async configure(root, pkg, _version, variantPath) {
    const r = await configurePnpmPatch(root, pkg, variantPath);
    return { files: [r.file] };
  },
};

export const bunApplier: PatchApplier = {
  name: 'bun',
  async problems(root, pkg, version, variantPath) {
    const installRoot = manifestRoot(root);
    const { json } = await readManifest(installRoot);
    const entries = Object.entries((json.patchedDependencies ?? {}) as Record<string, string>).filter(([k]) => keyIsFor(k, pkg));
    const expectedKey = `${pkg}@${version}`;
    const expectedPath = posix(path.relative(installRoot, variantPath));
    const problems: string[] = [];
    if (!entries.some(([k]) => k === expectedKey)) {
      problems.push(`package.json patchedDependencies has no "${expectedKey}" entry (expected "${expectedKey}": "${expectedPath}"); bun ignores keys for other versions and name-only keys`);
    }
    for (const [k, p] of entries) {
      if (k !== expectedKey) problems.push(`package.json patchedDependencies["${k}"] does not match the installed ${pkg}@${version}; bun silently skips it`);
      else if (path.resolve(installRoot, p) !== path.resolve(variantPath)) problems.push(`package.json patchedDependencies["${k}"] points to ${p}, but the selected variant is ${expectedPath}`);
    }
    return problems;
  },
  async configure(root, pkg, version, variantPath) {
    const installRoot = manifestRoot(root);
    const m = await readManifest(installRoot);
    const patched = ((m.json.patchedDependencies ??= {}) as Record<string, string>);
    for (const k of Object.keys(patched)) if (keyIsFor(k, pkg)) delete patched[k];
    patched[`${pkg}@${version}`] = posix(path.relative(installRoot, variantPath));
    await writeManifest(m);
    return { files: [m.file] };
  },
};

export const PATCH_PACKAGE_DIR = '.grafts/.patch-package';
const PATCH_PACKAGE_FLAGS = ['--error-on-fail', '--error-on-warn'];
const patchPackageCommand = (dir: string) => `patch-package --patch-dir ${dir} ${PATCH_PACKAGE_FLAGS.join(' ')}`;
/** patch-package's file name for pkg@version (`@scope/name` → `@scope+name`). */
export const patchPackageFileName = (pkg: string, version: string) => `${pkg.replace('/', '+')}+${version}.patch`;

/** Convert a package-relative variant into patch-package's format (paths under node_modules/<pkg>/). */
export function toPatchPackageFormat(variant: string, pkg: string): string {
  const prefix = `node_modules/${pkg}/`;
  return variant
    .split('\n')
    .filter((line) => !line.startsWith('index '))
    .map((line) => {
      let m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m) return `diff --git a/${prefix}${m[1]} b/${prefix}${m[2]}`;
      m = /^(---|\+\+\+) ([ab])\/(.+)$/.exec(line);
      if (m) return `${m[1]} ${m[2]}/${prefix}${m[3]}`;
      return line;
    })
    .join('\n');
}

export const patchPackageApplier: PatchApplier = {
  name: 'patch-package',
  async problems(root, pkg, version, variantPath) {
    const installRoot = manifestRoot(root);
    const dir = path.join(installRoot, PATCH_PACKAGE_DIR);
    const { json } = await readManifest(installRoot);
    const problems: string[] = [];
    const postinstall: string = json.scripts?.postinstall ?? '';
    const ours = postinstall.split(/&&|;/).map((s) => s.trim()).find((s) => /\bpatch-package\b/.test(s) && s.includes(PATCH_PACKAGE_DIR));
    if (!ours) problems.push(`package.json scripts.postinstall must run \`${patchPackageCommand(PATCH_PACKAGE_DIR)}\``);
    else for (const flag of PATCH_PACKAGE_FLAGS) if (!ours.includes(flag)) problems.push(`postinstall's patch-package call must pass ${flag}; without it a failed patch exits 0 and installs the package unmodified`);
    if (!json.devDependencies?.['patch-package'] && !json.dependencies?.['patch-package']) problems.push('patch-package must be a devDependency');

    const expectedFile = path.join(dir, patchPackageFileName(pkg, version));
    const prefix = patchPackageFileName(pkg, '').replace(/\.patch$/, '');
    const ownFiles = existsSync(dir) ? (await readdir(dir)).filter((f) => f.startsWith(prefix) && /^\d/.test(f.slice(prefix.length))) : [];
    if (!existsSync(expectedFile)) {
      problems.push(`${posix(path.relative(installRoot, expectedFile))} is missing; run \`graft apply\``);
    } else if ((await readFile(expectedFile, 'utf8')) !== toPatchPackageFormat(await readFile(variantPath, 'utf8'), pkg)) {
      problems.push(`${posix(path.relative(installRoot, expectedFile))} is stale (it no longer matches ${posix(path.relative(installRoot, variantPath))}); run \`graft apply\``);
    }
    for (const f of ownFiles.filter((f) => f !== path.basename(expectedFile))) problems.push(`${PATCH_PACKAGE_DIR}/${f} is for another version of ${pkg}; remove it`);
    // A plain `patch-package` call (default patches/ dir) patching the same package would compete.
    const defaultDir = path.join(installRoot, 'patches');
    if (/\bpatch-package\b(?![^&;]*--patch-dir)/.test(postinstall) && existsSync(defaultDir)) {
      for (const f of (await readdir(defaultDir)).filter((f) => f.startsWith(prefix) && /^\d/.test(f.slice(prefix.length)))) {
        problems.push(`patches/${f} also patches ${pkg}; graft manages ${pkg} in ${PATCH_PACKAGE_DIR} — remove it`);
      }
    }
    return problems;
  },
  async configure(root, pkg, version, variantPath) {
    const installRoot = manifestRoot(root);
    const dir = path.join(installRoot, PATCH_PACKAGE_DIR);
    await mkdir(dir, { recursive: true });
    const prefix = patchPackageFileName(pkg, '').replace(/\.patch$/, '');
    for (const f of await readdir(dir)) if (f.startsWith(prefix) && /^\d/.test(f.slice(prefix.length))) await rm(path.join(dir, f));
    const file = path.join(dir, patchPackageFileName(pkg, version));
    await writeFile(file, toPatchPackageFormat(await readFile(variantPath, 'utf8'), pkg));

    const m = await readManifest(installRoot);
    const scripts = ((m.json.scripts ??= {}) as Record<string, string>);
    const command = patchPackageCommand(PATCH_PACKAGE_DIR);
    const parts = (scripts.postinstall ?? '').split('&&').map((s) => s.trim()).filter(Boolean);
    const i = parts.findIndex((p) => /\bpatch-package\b/.test(p) && p.includes(PATCH_PACKAGE_DIR));
    if (i === -1) parts.push(command);
    else parts[i] = command;
    scripts.postinstall = parts.join(' && ');
    await writeManifest(m);
    return { files: [file, m.file] };
  },
};

const APPLIERS: Record<ApplierName, PatchApplier> = { pnpm: pnpmApplier, bun: bunApplier, 'patch-package': patchPackageApplier };

export { findPnpmWorkspaceRoot };
