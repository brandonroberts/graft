import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { GraftError } from './errors.js';
import { runCommand } from './command.js';

/** `yarn` is yarn classic (1.x); `yarn-berry` is yarn 2+ (Plug'n'Play or `nodeLinker: node-modules`). */
export type PackageManager = 'pnpm' | 'yarn' | 'yarn-berry' | 'npm' | 'bun' | 'upm';

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

/**
 * Is the yarn project in `dir` yarn 2+ (berry)? Berry projects carry a `.yarnrc.yml` or a
 * Plug'n'Play runtime (`.pnp.cjs`), and berry's yarn.lock starts with a `__metadata:` block;
 * yarn classic has none of these.
 */
export function isYarnBerry(dir: string): boolean {
  if (['.yarnrc.yml', '.pnp.cjs', '.pnp.js'].some((f) => existsSync(path.join(dir, f)))) return true;
  try {
    return /^__metadata:/m.test(readFileSync(path.join(dir, 'yarn.lock'), 'utf8').slice(0, 4096));
  } catch {
    return false;
  }
}

/** The package manager Graft assumes when a project gives no signal. */
export const DEFAULT_PACKAGE_MANAGER: PackageManager = 'npm';

/**
 * Detect the package manager, walking up from `root`. In each directory: an explicit
 * package.json `packageManager` (e.g. "pnpm@10.28.0") wins; otherwise lockfiles in the order
 * pnpm, npm, upm, yarn, bun. With no signal anywhere, npm. yarn is `yarn-berry` for
 * `packageManager: yarn@2+`, or a yarn.lock next to berry's markers (see {@link isYarnBerry}).
 */
export function detectPackageManager(root: string): PackageManager {
  let dir = path.resolve(root);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const declared = /^(pnpm|yarn|npm|bun|upm)@(\d+)?/.exec(String(JSON.parse(readFileSync(manifest, 'utf8')).packageManager ?? ''));
        if (declared?.[1] === 'yarn') return (declared[2] ? Number(declared[2]) >= 2 : isYarnBerry(dir)) ? 'yarn-berry' : 'yarn';
        if (declared) return declared[1] as PackageManager;
      } catch {
        // unreadable manifest: fall through to lockfile detection
      }
    }
    for (const [pm, files] of LOCKFILE_PRECEDENCE) {
      if (files.some((f) => existsSync(path.join(dir, f)))) return pm === 'yarn' && isYarnBerry(dir) ? 'yarn-berry' : pm;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return DEFAULT_PACKAGE_MANAGER;
    dir = parent;
  }
}

/**
 * Install `spec` (e.g. `lib@1.2.3`), and any `also` packages with it in the same install, each
 * kept in the manifest(s) and dependency field that already declare it.
 */
export async function installPackage(root: string, pkg: string, spec: string, also: { pkg: string; spec: string }[] = []): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  const pm = detectPackageManager(root);
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const all = [{ pkg, spec }, ...also];
  const specs = (entries: typeof all) => entries.map((e) => quote(e.spec)).join(' ');
  // npm, yarn classic, bun and upm add to one dependency field per command.
  const byField = (add: (dev: boolean, list: string) => string) =>
    [false, true]
      .map((dev) => all.filter((e) => !!manifest.devDependencies?.[e.pkg] === dev))
      .filter((entries) => entries.length)
      .map((entries) => add(!!manifest.devDependencies?.[entries[0]!.pkg], specs(entries)))
      .join(' && ');
  const command = {
    // `update -r` bumps the package wherever it is already declared (workspace-aware)
    // instead of adding it to the root manifest.
    pnpm: `pnpm update -r ${specs(all)}`,
    yarn: byField((dev, list) => `yarn add ${dev ? '-D ' : ''}${list}`),
    // berry: `up` bumps the package in every workspace that declares it, keeping its field.
    'yarn-berry': `yarn up ${specs(all)}`,
    bun: byField((dev, list) => `bun add ${dev ? '-d ' : ''}${list}`),
    upm: byField((dev, list) => `upm add ${dev ? '--dev ' : ''}${list}`),
    npm: byField((dev, list) => `npm install ${dev ? '--save-dev ' : ''}${list}`),
  }[pm];
  const result = await runCommand(command, { cwd: root, timeoutMs: 10 * 60_000 });
  if (!result.passed) throw new GraftError(`\`${command}\` failed:\n${result.output}`, 'install/failed');
  // npm and yarn classic run the project's own lifecycle scripts (e.g. a patch-package
  // postinstall) only on a bare install, not when adding a specific package.
  if (pm === 'npm' || pm === 'yarn') return `${command} && ${await reinstall(root)}`;
  return command;
}

/** Reinstall the project's dependencies (so package-manager patch config takes effect). */
export async function reinstall(root: string): Promise<string> {
  const command = {
    pnpm: 'pnpm install',
    yarn: 'yarn install',
    'yarn-berry': 'yarn install',
    bun: 'bun install',
    upm: 'upm install',
    npm: 'npm install',
  }[detectPackageManager(root)];
  const result = await runCommand(command, { cwd: root, timeoutMs: 10 * 60_000 });
  if (!result.passed) throw new GraftError(`\`${command}\` failed:\n${result.output}`, 'install/failed');
  return command;
}

/**
 * pnpm catalogs: point the entries (default `catalog` and named `catalogs`) that pin a package's
 * previously installed version at its new one, keeping the range prefix (`^24.0.0` → `^24.0.6`)
 * and the file's comments. Entries pinning something else (e.g. a peer range) are left alone.
 * Returns the packages whose catalog entries moved. `pnpm update` can't be used for these: it
 * replaces the `catalog:` references in the manifests with the literal version.
 */
export async function updatePnpmCatalogs(root: string, updates: { pkg: string; from: string; to: string }[]): Promise<string[]> {
  let dir = path.resolve(root);
  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
  const file = path.join(dir, 'pnpm-workspace.yaml');
  const before = await readFile(file, 'utf8');
  const doc = parseDocument(before);
  const catalogs: (string | number)[][] = [['catalog']];
  const named = doc.getIn(['catalogs']) as { items?: { key: unknown }[] } | undefined;
  for (const item of named?.items ?? []) catalogs.push(['catalogs', String((item.key as { value?: unknown })?.value ?? item.key)]);
  const moved = new Set<string>();
  for (const { pkg, from, to } of updates) {
    for (const at of catalogs) {
      const value = doc.getIn([...at, pkg]);
      const m = typeof value === 'string' ? /^([~^=]?)(.*)$/.exec(value) : null;
      if (!m || m[2] !== from) continue;
      doc.setIn([...at, pkg], `${m[1]}${to}`);
      moved.add(pkg);
    }
  }
  const after = doc.toString();
  if (after !== before) await writeFile(file, after);
  return [...moved];
}

/**
 * The project's own upgrade command for `pkg` (`.grafts/config.json` `upgrade`), with
 * `{package}` and `{version}` substituted, or undefined when the project has none.
 * A key `<ecosystem>:<name>` wins over a bare name. Throws `config/invalid` for a command
 * without `{version}`: it couldn't install the version being synced.
 */
export function upgradeCommand(
  upgrade: Record<string, unknown> | undefined,
  ecosystem: string,
  pkg: string,
  version: string,
): string | undefined {
  const key = upgrade && `${ecosystem}:${pkg}` in upgrade ? `${ecosystem}:${pkg}` : pkg;
  const template = upgrade?.[key];
  if (template === undefined) return undefined;
  if (typeof template !== 'string' || !template.includes('{version}')) {
    throw new GraftError(`.grafts/config.json: upgrade["${key}"] must be a command containing {version}`, 'config/invalid');
  }
  return template.replaceAll('{package}', pkg).replaceAll('{version}', version);
}

/** Run a project's upgrade command from the project root. Throws `install/failed` with its output on failure. */
export async function runUpgrade(root: string, command: string): Promise<string> {
  const result = await runCommand(command, { cwd: root, timeoutMs: 30 * 60_000 });
  if (!result.passed) {
    const why = result.timedOut ? 'timed out after 30 minutes' : `exit ${result.exitCode}`;
    throw new GraftError(`upgrade command \`${command}\` failed (${why}):\n${result.output}`, 'install/failed');
  }
  return command;
}
