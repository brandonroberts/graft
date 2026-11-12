// How a patch variant is actually applied at install time, per package manager.
//
// Variants are always package-relative git patches (the format pnpm and bun write). Each
// applier wires the package manager so that the *selected* variant is applied, and reports
// any configuration that would apply something else or fail silently:
//
//   pnpm           patchedDependencies (name-only key) + ignorePatchFailures: false
//   bun            package.json patchedDependencies["<pkg>@<installed>"]; bun silently ignores
//                  name-only keys and keys for other versions, so the key tracks the version
//   yarn           (default for yarn 2+ / berry, Plug'n'Play or node-modules) package.json
//                  resolutions["<pkg>"] = "patch:<pkg>@npm%3A<version>#./<variant>"; yarn applies
//                  the patch while fetching, records it in yarn.lock, and fails on a bad hunk
//   vendor         (default for upm; works with any package manager that supports overrides)
//                  pristine + variant built into .grafts/.vendor/<pkg>-<version>.tgz, installed
//                  through overrides/resolutions and the root's own dependency
//   graft          (default for npm < 12, yarn classic, anything with node_modules + postinstall)
//                  Graft applies the variants itself: `graft apply --installed` in postinstall;
//                  refused under Plug'n'Play (no node_modules to patch)
//   patch-package  (opt-in) a generated <pkg>+<version>.patch in a graft-owned dir, applied by
//                  `patch-package --error-on-fail --error-on-warn` in postinstall; without those
//                  flags patch-package exits 0 on a failed patch (outside CI)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { detectPackageManager, findPnpRuntime, type Project, type UpstreamSource } from '@graftsync/core';
import { configurePnpmPatch, findPnpmWorkspaceRoot, pnpmConfigProblems } from './pnpm.js';
import { vendorConfigure, vendorProblems } from './vendor.js';

export type ApplierName =
  | 'pnpm'
  | 'npm'
  | 'bun'
  | 'yarn'
  | 'graft'
  | 'patch-package'
  | 'vendor'
  | 'cargo-vendor'
  | 'go-replace'
  | 'wheel-vendor';

/** `mechanisms.patch.applier`: a name (npm), or a name per ecosystem (`{ "npm": "vendor", "cargo": "cargo-vendor" }`). */
export type ApplierConfig = string | Partial<Record<string, string>>;

export interface ApplierContext {
  /** Pristine upstream contents, for appliers that build the patched package themselves. */
  upstream?: UpstreamSource;
  /** The project (ecosystem options, cache directory). */
  project?: Project;
}

export interface PatchApplier {
  name: ApplierName;
  /** Problems that would make the package manager apply something other than `variantPath`, or fail silently. */
  problems(root: string, pkg: string, version: string, variantPath: string, ctx?: ApplierContext): Promise<string[]>;
  /**
   * Wire the package manager to apply `variantPath` to `pkg@version` on the next install.
   * `install: 'reinstall'` means a targeted `add pkg@version` would undo the wiring.
   */
  configure(
    root: string,
    pkg: string,
    version: string,
    variantPath: string,
    ctx?: ApplierContext,
  ): Promise<{ files: string[]; install?: 'reinstall' }>;
}

/** Appliers of the ecosystems other than npm, and each one's default. Registered by their modules. */
const OTHER_ECOSYSTEMS: Record<string, { default: string; appliers: Record<string, PatchApplier> }> = {};

export function registerEcosystemAppliers(ecosystem: string, defaultName: string, appliers: PatchApplier[]): void {
  OTHER_ECOSYSTEMS[ecosystem] = { default: defaultName, appliers: Object.fromEntries(appliers.map((a) => [a.name, a])) };
}

/**
 * Pick the applier: explicit config wins, then the ecosystem's tooling (for npm, the package
 * manager). A string config names npm's applier; an object names one per ecosystem.
 */
export function selectApplier(root: string, config?: ApplierConfig, ecosystem = 'npm'): PatchApplier {
  const configured = typeof config === 'string' ? (ecosystem === 'npm' ? config : undefined) : config?.[ecosystem];
  if (ecosystem !== 'npm') {
    const eco = OTHER_ECOSYSTEMS[ecosystem];
    if (!eco) throw new Error(`the patch mechanism has no applier for the ${ecosystem} ecosystem`);
    const applier = eco.appliers[configured ?? eco.default];
    if (!applier) throw new Error(`unknown ${ecosystem} patch applier "${configured}" (expected ${Object.keys(eco.appliers).join(' | ')})`);
    return applier;
  }
  const pm = detectPackageManager(root);
  // npm 12+ patches natively; older npm silently ignores patchedDependencies, so it gets the built-in applier.
  const npmDefault = pm === 'npm' && (npmMajor(root) ?? 0) >= NPM_NATIVE_PATCH_MAJOR ? 'npm' : 'graft';
  const name = (configured ??
    { pnpm: 'pnpm', npm: npmDefault, bun: 'bun', yarn: 'graft', 'yarn-berry': 'yarn', upm: 'vendor' }[pm]) as ApplierName;
  const applier = APPLIERS[name];
  if (!applier)
    throw new Error(`unknown patch applier "${configured}" (expected pnpm | npm | bun | yarn | graft | patch-package | vendor)`);
  return applier;
}

const posix = (p: string) => p.split(path.sep).join('/');
const keyIsFor = (key: string, pkg: string) => key === pkg || (key.startsWith(`${pkg}@`) && key.length > pkg.length + 1);

/** Nearest directory at or above `from` with a package.json (the install root). */
export function manifestRoot(from: string): string {
  let dir = path.resolve(from);
  let found: string | undefined;
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) found ??= dir;
    if (
      ['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'upm.lock', 'pnpm-lock.yaml'].some((f) => existsSync(path.join(dir, f)))
    )
      return dir;
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

/** npm gained native `patchedDependencies` in v12. Earlier versions ignore the field silently. */
export const NPM_NATIVE_PATCH_MAJOR = 12;

const npmVersionCache = new Map<string, number | undefined>();

/**
 * Major version of npm for this project: the `packageManager` field ("npm@12.2.1") when the
 * root declares one, otherwise the `npm` on PATH.
 */
export function npmMajor(root: string): number | undefined {
  const installRoot = manifestRoot(root);
  if (npmVersionCache.has(installRoot)) return npmVersionCache.get(installRoot);
  let version: string | undefined;
  try {
    const declared = /^npm@(\d+)/.exec(
      String(JSON.parse(readFileSync(path.join(installRoot, 'package.json'), 'utf8')).packageManager ?? ''),
    );
    version = declared?.[1];
  } catch {
    // no readable manifest
  }
  if (!version) {
    const r = spawnSync('npm', ['--version'], { cwd: installRoot, encoding: 'utf8', shell: process.platform === 'win32' });
    version = r.status === 0 ? /^(\d+)/.exec(r.stdout.trim())?.[1] : undefined;
  }
  const major = version ? Number(version) : undefined;
  npmVersionCache.set(installRoot, major);
  return major;
}

/**
 * npm 12+ native patches: root package.json `patchedDependencies[<pkg>]` (name-only key) →
 * variant. npm applies patches during install (also with --ignore-scripts), records their hash
 * in package-lock.json, and fails the install on a patch that does not apply or matches nothing.
 */
export const npmApplier: PatchApplier = {
  name: 'npm',
  async problems(root, pkg, _version, variantPath) {
    const installRoot = manifestRoot(root);
    const problems: string[] = [];
    const major = npmMajor(root);
    if (major === undefined || major < NPM_NATIVE_PATCH_MAJOR) {
      problems.push(
        `npm ${major ?? '(not found)'} ignores patchedDependencies silently; native npm patches need npm >= ${NPM_NATIVE_PATCH_MAJOR} (use the "graft" or "vendor" applier otherwise)`,
      );
    }
    const { json } = await readManifest(installRoot);
    const entries = Object.entries((json.patchedDependencies ?? {}) as Record<string, string>).filter(([k]) => keyIsFor(k, pkg));
    const expected = posix(path.relative(installRoot, variantPath));
    if (!entries.some(([k]) => k === pkg))
      problems.push(`package.json patchedDependencies has no "${pkg}" entry (expected "${pkg}": "${expected}")`);
    for (const [k, p] of entries) {
      if (k !== pkg)
        problems.push(`package.json patchedDependencies["${k}"] is version-specific; graft manages ${pkg} with a name-only key`);
      else if (path.resolve(installRoot, p) !== path.resolve(variantPath))
        problems.push(`package.json patchedDependencies["${pkg}"] points to ${p}, but the selected variant is ${expected}`);
    }
    return problems;
  },
  async configure(root, pkg, _version, variantPath) {
    const major = npmMajor(root);
    if (major === undefined || major < NPM_NATIVE_PATCH_MAJOR) {
      throw new Error(
        `npm ${major ?? '(not found)'} ignores patchedDependencies silently; the "npm" applier needs npm >= ${NPM_NATIVE_PATCH_MAJOR}`,
      );
    }
    const installRoot = manifestRoot(root);
    const m = await readManifest(installRoot);
    const patched = (m.json.patchedDependencies ??= {}) as Record<string, string>;
    for (const k of Object.keys(patched)) if (keyIsFor(k, pkg)) delete patched[k];
    patched[pkg] = posix(path.relative(installRoot, variantPath));
    await writeManifest(m);
    return { files: [m.file] };
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
      problems.push(
        `package.json patchedDependencies has no "${expectedKey}" entry (expected "${expectedKey}": "${expectedPath}"); bun ignores keys for other versions and name-only keys`,
      );
    }
    for (const [k, p] of entries) {
      if (k !== expectedKey)
        problems.push(`package.json patchedDependencies["${k}"] does not match the installed ${pkg}@${version}; bun silently skips it`);
      else if (path.resolve(installRoot, p) !== path.resolve(variantPath))
        problems.push(`package.json patchedDependencies["${k}"] points to ${p}, but the selected variant is ${expectedPath}`);
    }
    return problems;
  },
  async configure(root, pkg, version, variantPath) {
    const installRoot = manifestRoot(root);
    const m = await readManifest(installRoot);
    const patched = (m.json.patchedDependencies ??= {}) as Record<string, string>;
    for (const k of Object.keys(patched)) if (keyIsFor(k, pkg)) delete patched[k];
    patched[`${pkg}@${version}`] = posix(path.relative(installRoot, variantPath));
    await writeManifest(m);
    return { files: [m.file] };
  },
};

/**
 * Appliers that patch files under node_modules after install cannot work under yarn
 * Plug'n'Play, where packages stay in zip archives and there is no node_modules.
 */
function pnpRefusal(installRoot: string, applier: string): string | undefined {
  const pnp = findPnpRuntime(installRoot);
  if (!pnp) return undefined;
  return `the "${applier}" applier patches node_modules, but this project uses yarn Plug'n'Play (${pnp}); use the "yarn" applier (yarn's patch: protocol, the default for yarn 2+) or "vendor", or set \`nodeLinker: node-modules\` in .yarnrc.yml`;
}

/** yarn 2+ `patch:` descriptor applying `relPatch` (posix, relative to the project root) to `pkg@version` from npm. */
export function yarnPatchSpec(pkg: string, version: string, relPatch: string): string {
  const rel = relPatch.startsWith('../') ? relPatch : `./${relPatch}`;
  return `patch:${pkg}@npm%3A${version}#${rel}`;
}

/** Resolution keys other than the name-only one that also select `pkg` (e.g. `ms@npm:^2`, `foo/ms`, `**\/ms@^2`). */
const otherResolutionKeys = (resolutions: Record<string, string>, pkg: string) =>
  Object.keys(resolutions).filter((k) => k !== pkg && (keyIsFor(k, pkg) || k.endsWith(`/${pkg}`) || k.includes(`/${pkg}@`)));

/** Root dependency specs the yarn applier rewrites: plain versions/ranges, `patch:` specs, and vendored tarballs. */
function yarnDeclaredSpec(declared: string, version: string): string | undefined {
  const plain = /^([~^]?)\d[^\s|<>=]*$/.exec(declared);
  if (plain) return `${plain[1]}${version}`;
  if (declared.startsWith('patch:') || (declared.startsWith('file:') && declared.includes('.grafts/.vendor/'))) return version;
  return undefined;
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/**
 * yarn 2+ native patches through the `patch:` protocol: a name-only root resolution
 * `"<pkg>": "patch:<pkg>@npm%3A<version>#./<variant>"` makes every copy of `pkg` resolve to
 * `pkg@version` with the variant applied, under Plug'n'Play and `nodeLinker: node-modules`
 * alike. yarn applies the patch at fetch time (no install scripts), stores the patched
 * package with its own checksum in yarn.lock, and fails the install on a hunk that does not
 * apply. Like `vendor`, the resolution pins the version, so a bare reinstall follows.
 */
export const yarnApplier: PatchApplier = {
  name: 'yarn',
  async problems(root, pkg, version, variantPath) {
    const installRoot = manifestRoot(root);
    const problems: string[] = [];
    if (detectPackageManager(installRoot) !== 'yarn-berry') {
      problems.push('the "yarn" applier needs yarn 2+ (berry); yarn classic has no patch: protocol (use the "graft" or "vendor" applier)');
    }
    const { json } = await readManifest(installRoot);
    const resolutions = (json.resolutions ?? {}) as Record<string, string>;
    const expected = yarnPatchSpec(pkg, version, posix(path.relative(installRoot, variantPath)));
    if (resolutions[pkg] !== expected)
      problems.push(`package.json resolutions["${pkg}"] must be "${expected}"${resolutions[pkg] ? ` (is "${resolutions[pkg]}")` : ''}`);
    for (const k of otherResolutionKeys(resolutions, pkg)) {
      problems.push(
        `package.json resolutions["${k}"] also resolves ${pkg} and can select an unpatched copy; graft manages ${pkg} with the name-only resolution — remove it`,
      );
    }
    for (const field of DEP_FIELDS) {
      const declared = json[field]?.[pkg];
      if (typeof declared === 'string' && declared.startsWith('patch:')) {
        problems.push(
          `package.json ${field}["${pkg}"] is a patch: descriptor ("${declared}"); graft patches ${pkg} through resolutions — set it to "${version}"`,
        );
      }
    }
    return problems;
  },
  async configure(root, pkg, version, variantPath) {
    const installRoot = manifestRoot(root);
    if (detectPackageManager(installRoot) !== 'yarn-berry') {
      throw new Error(
        'the "yarn" applier needs yarn 2+ (berry); yarn classic has no patch: protocol (use the "graft" or "vendor" applier)',
      );
    }
    const m = await readManifest(installRoot);
    const resolutions = (m.json.resolutions ??= {}) as Record<string, string>;
    for (const k of Object.keys(resolutions)) if (k !== pkg && keyIsFor(k, pkg)) delete resolutions[k];
    resolutions[pkg] = yarnPatchSpec(pkg, version, posix(path.relative(installRoot, variantPath)));
    for (const field of DEP_FIELDS) {
      const declared = m.json[field]?.[pkg];
      const next = typeof declared === 'string' ? yarnDeclaredSpec(declared, version) : undefined;
      if (next) m.json[field][pkg] = next;
    }
    await writeManifest(m);
    return { files: [m.file], install: 'reinstall' };
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
    const refusal = pnpRefusal(installRoot, 'patch-package');
    if (refusal) problems.push(refusal);
    const postinstall: string = json.scripts?.postinstall ?? '';
    const ours = postinstall
      .split(/&&|;/)
      .map((s) => s.trim())
      .find((s) => /\bpatch-package\b/.test(s) && s.includes(PATCH_PACKAGE_DIR));
    if (!ours) problems.push(`package.json scripts.postinstall must run \`${patchPackageCommand(PATCH_PACKAGE_DIR)}\``);
    else
      for (const flag of PATCH_PACKAGE_FLAGS)
        if (!ours.includes(flag))
          problems.push(
            `postinstall's patch-package call must pass ${flag}; without it a failed patch exits 0 and installs the package unmodified`,
          );
    if (!json.devDependencies?.['patch-package'] && !json.dependencies?.['patch-package'])
      problems.push('patch-package must be a devDependency');

    const expectedFile = path.join(dir, patchPackageFileName(pkg, version));
    const prefix = patchPackageFileName(pkg, '').replace(/\.patch$/, '');
    const ownFiles = existsSync(dir) ? (await readdir(dir)).filter((f) => f.startsWith(prefix) && /^\d/.test(f.slice(prefix.length))) : [];
    if (!existsSync(expectedFile)) {
      problems.push(`${posix(path.relative(installRoot, expectedFile))} is missing; run \`graft apply\``);
    } else if ((await readFile(expectedFile, 'utf8')) !== toPatchPackageFormat(await readFile(variantPath, 'utf8'), pkg)) {
      problems.push(
        `${posix(path.relative(installRoot, expectedFile))} is stale (it no longer matches ${posix(path.relative(installRoot, variantPath))}); run \`graft apply\``,
      );
    }
    for (const f of ownFiles.filter((f) => f !== path.basename(expectedFile)))
      problems.push(`${PATCH_PACKAGE_DIR}/${f} is for another version of ${pkg}; remove it`);
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
    const refusal = pnpRefusal(installRoot, 'patch-package');
    if (refusal) throw new Error(refusal);
    const dir = path.join(installRoot, PATCH_PACKAGE_DIR);
    await mkdir(dir, { recursive: true });
    const prefix = patchPackageFileName(pkg, '').replace(/\.patch$/, '');
    for (const f of await readdir(dir)) if (f.startsWith(prefix) && /^\d/.test(f.slice(prefix.length))) await rm(path.join(dir, f));
    const file = path.join(dir, patchPackageFileName(pkg, version));
    await writeFile(file, toPatchPackageFormat(await readFile(variantPath, 'utf8'), pkg));

    const m = await readManifest(installRoot);
    const scripts = (m.json.scripts ??= {}) as Record<string, string>;
    const command = patchPackageCommand(PATCH_PACKAGE_DIR);
    const parts = (scripts.postinstall ?? '')
      .split('&&')
      .map((s) => s.trim())
      .filter(Boolean);
    const i = parts.findIndex((p) => /\bpatch-package\b/.test(p) && p.includes(PATCH_PACKAGE_DIR));
    if (i === -1) parts.push(command);
    else parts[i] = command;
    scripts.postinstall = parts.join(' && ');
    await writeManifest(m);
    return { files: [file, m.file] };
  },
};

export const GRAFT_POSTINSTALL = 'graft apply --installed';

/** Is our postinstall step present? */
const hasGraftPostinstall = (postinstall: string) =>
  postinstall.split(/&&|;/).some((s) => s.trim() === GRAFT_POSTINSTALL || /\bgraft apply --installed\b/.test(s));

export const graftApplier: PatchApplier = {
  name: 'graft',
  async problems(root, pkg) {
    const installRoot = manifestRoot(root);
    const { json } = await readManifest(installRoot);
    const problems: string[] = [];
    const refusal = pnpRefusal(installRoot, 'graft');
    if (refusal) problems.push(refusal);
    const postinstall: string = json.scripts?.postinstall ?? '';
    if (!hasGraftPostinstall(postinstall))
      problems.push(`package.json scripts.postinstall must run \`${GRAFT_POSTINSTALL}\` (Graft's built-in applier)`);
    if (!json.devDependencies?.['@graftsync/cli'] && !json.dependencies?.['@graftsync/cli'])
      problems.push('@graftsync/cli must be a (dev)dependency so postinstall can run `graft`');
    // Competing appliers for the same package would double-apply or fail.
    const prefix = patchPackageFileName(pkg, '').replace(/\.patch$/, '');
    for (const dir of [PATCH_PACKAGE_DIR, 'patches']) {
      const full = path.join(installRoot, dir);
      if (!existsSync(full)) continue;
      for (const f of (await readdir(full)).filter((f) => f.startsWith(prefix) && /^\d/.test(f.slice(prefix.length)))) {
        problems.push(`${dir}/${f} also patches ${pkg} (patch-package); graft applies ${pkg} itself — remove it`);
      }
    }
    if (Object.keys((json.patchedDependencies ?? {}) as Record<string, string>).some((k) => keyIsFor(k, pkg))) {
      problems.push(`package.json patchedDependencies also patches ${pkg}; graft applies ${pkg} itself — remove the entry`);
    }
    return problems;
  },
  async configure(root, pkg) {
    const installRoot = manifestRoot(root);
    const refusal = pnpRefusal(installRoot, 'graft');
    if (refusal) throw new Error(refusal);
    // Remove graft-owned patch-package artifacts for this package (switching appliers).
    const dir = path.join(installRoot, PATCH_PACKAGE_DIR);
    const prefix = patchPackageFileName(pkg, '').replace(/\.patch$/, '');
    if (existsSync(dir))
      for (const f of await readdir(dir)) if (f.startsWith(prefix) && /^\d/.test(f.slice(prefix.length))) await rm(path.join(dir, f));
    const m = await readManifest(installRoot);
    const scripts = (m.json.scripts ??= {}) as Record<string, string>;
    const parts = (scripts.postinstall ?? '')
      .split('&&')
      .map((x) => x.trim())
      .filter(Boolean)
      // Drop the patch-package step Graft itself added (switching from the patch-package applier).
      .filter((x) => !(/\bpatch-package\b/.test(x) && x.includes(PATCH_PACKAGE_DIR)));
    if (!parts.some(hasGraftPostinstall)) parts.push(GRAFT_POSTINSTALL);
    scripts.postinstall = parts.join(' && ');
    await writeManifest(m);
    return { files: [m.file] };
  },
};

export const vendorApplier: PatchApplier = {
  name: 'vendor',
  problems: (root, pkg, version, variantPath, ctx) =>
    vendorProblems({ upstream: ctx?.upstream, graftRoot: root, installRoot: manifestRoot(root) }, pkg, version, variantPath),
  async configure(root, pkg, version, variantPath, ctx) {
    const r = await vendorConfigure(
      { upstream: ctx?.upstream, graftRoot: root, installRoot: manifestRoot(root) },
      pkg,
      version,
      variantPath,
    );
    return { ...r, install: 'reinstall' };
  },
};

const APPLIERS: Partial<Record<ApplierName, PatchApplier>> = {
  pnpm: pnpmApplier,
  npm: npmApplier,
  bun: bunApplier,
  yarn: yarnApplier,
  graft: graftApplier,
  'patch-package': patchPackageApplier,
  vendor: vendorApplier,
};

export { findPnpmWorkspaceRoot };
