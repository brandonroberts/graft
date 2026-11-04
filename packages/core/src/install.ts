import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GraftError } from './errors.js';
import { runCommand } from './oracle.js';

export type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun' | 'upm';

/**
 * Precedence when a directory has several lockfiles: pnpm first, then npm, then upm.
 * yarn and bun remain supported after those. A project with no signal at all is npm.
 */
const LOCKFILE_PRECEDENCE: [PackageManager, string[]][] = [
  ['pnpm', ['pnpm-lock.yaml', 'pnpm-workspace.yaml']],
  ['npm', ['package-lock.json', 'npm-shrinkwrap.json']],
  ['upm', ['upm.lock']],
  ['yarn', ['yarn.lock']],
  ['bun', ['bun.lock', 'bun.lockb']],
];

/** The package manager Graft assumes when a project gives no signal. */
export const DEFAULT_PACKAGE_MANAGER: PackageManager = 'npm';

/**
 * Detect the package manager, walking up from `root`. In each directory: an explicit
 * package.json `packageManager` (e.g. "pnpm@10.28.0") wins; otherwise lockfiles in the order
 * pnpm, npm, upm, yarn, bun. With no signal anywhere, npm.
 */
export function detectPackageManager(root: string): PackageManager {
  let dir = path.resolve(root);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const declared = /^(pnpm|yarn|npm|bun|upm)@/.exec(String(JSON.parse(readFileSync(manifest, 'utf8')).packageManager ?? ''));
        if (declared) return declared[1] as PackageManager;
      } catch {
        // unreadable manifest: fall through to lockfile detection
      }
    }
    for (const [pm, files] of LOCKFILE_PRECEDENCE) {
      if (files.some((f) => existsSync(path.join(dir, f)))) return pm;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return DEFAULT_PACKAGE_MANAGER;
    dir = parent;
  }
}

/** Install `spec` (e.g. `lib@1.2.3`), keeping it in the manifest(s) and dependency field that already declare it. */
export async function installPackage(root: string, pkg: string, spec: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  const dev = !!manifest.devDependencies?.[pkg];
  const pm = detectPackageManager(root);
  const quoted = `'${spec.replaceAll("'", "'\\''")}'`;
  const command = {
    // `update -r` bumps the package wherever it is already declared (workspace-aware)
    // instead of adding it to the root manifest.
    pnpm: `pnpm update -r ${quoted}`,
    yarn: `yarn add ${dev ? '-D ' : ''}${quoted}`,
    bun: `bun add ${dev ? '-d ' : ''}${quoted}`,
    upm: `upm add ${dev ? '--dev ' : ''}${quoted}`,
    npm: `npm install ${dev ? '--save-dev ' : ''}${quoted}`,
  }[pm];
  const result = await runCommand(command, { cwd: root, timeoutMs: 10 * 60_000 });
  if (!result.passed) throw new GraftError(`\`${command}\` failed:\n${result.output}`, 'install/failed');
  // npm and yarn run the project's own lifecycle scripts (e.g. a patch-package postinstall)
  // only on a bare install, not when adding a specific package.
  if (pm === 'npm' || pm === 'yarn') return `${command} && ${await reinstall(root)}`;
  return command;
}

/** Reinstall the project's dependencies (so package-manager patch config takes effect). */
export async function reinstall(root: string): Promise<string> {
  const command = { pnpm: 'pnpm install', yarn: 'yarn install', bun: 'bun install', upm: 'upm install', npm: 'npm install' }[detectPackageManager(root)];
  const result = await runCommand(command, { cwd: root, timeoutMs: 10 * 60_000 });
  if (!result.passed) throw new GraftError(`\`${command}\` failed:\n${result.output}`, 'install/failed');
  return command;
}
