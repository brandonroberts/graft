import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GraftError } from './errors.js';
import { runCommand } from './oracle.js';

export type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun';

/** Detect the package manager from lockfiles, walking up from `root`. */
export function detectPackageManager(root: string): PackageManager {
  let dir = path.resolve(root);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock'))) return 'bun';
    if (existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
    const parent = path.dirname(dir);
    if (parent === dir) return 'npm';
    dir = parent;
  }
}

/** Install `spec` (e.g. `lib@1.2.3`) into the project, keeping it in the same dependency field. */
export async function installPackage(root: string, pkg: string, spec: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  const dev = !!manifest.devDependencies?.[pkg];
  const pm = detectPackageManager(root);
  const quoted = `'${spec.replaceAll("'", "'\\''")}'`;
  const command = {
    pnpm: `pnpm add ${dev ? '-D ' : ''}${quoted}`,
    yarn: `yarn add ${dev ? '-D ' : ''}${quoted}`,
    bun: `bun add ${dev ? '-d ' : ''}${quoted}`,
    npm: `npm install ${dev ? '--save-dev ' : ''}${quoted}`,
  }[pm];
  const result = await runCommand(command, { cwd: root, timeoutMs: 10 * 60_000 });
  if (!result.passed) throw new GraftError(`\`${command}\` failed:\n${result.output}`, 'install/failed');
  return command;
}
