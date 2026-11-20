import { existsSync, readFileSync } from 'node:fs';
import { glob, readFile, writeFile } from 'node:fs/promises';
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
    optionalDependencies?: Record<string, string>;
  };
  const pm = detectPackageManager(root);
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const all = [{ pkg, spec }, ...also];
  const specs = (entries: typeof all) => entries.map((e) => quote(e.spec)).join(' ');
  const fieldOf = (name: string): 'dep' | 'dev' | 'opt' =>
    manifest.devDependencies?.[name] ? 'dev' : manifest.optionalDependencies?.[name] ? 'opt' : 'dep';
  // npm, yarn classic, bun and upm add to one dependency field per command.
  const byField = (add: (field: 'dep' | 'dev' | 'opt', list: string) => string) =>
    (['dep', 'dev', 'opt'] as const)
      .map((field) => ({ field, entries: all.filter((e) => fieldOf(e.pkg) === field) }))
      .filter(({ entries }) => entries.length)
      .map(({ field, entries }) => add(field, specs(entries)))
      .join(' && ');
  const command = {
    // `update -r` bumps the package wherever it is already declared (workspace-aware)
    // instead of adding it to the root manifest.
    pnpm: `pnpm update -r ${specs(all)}`,
    yarn: byField((field, list) => `yarn add ${field === 'dev' ? '-D ' : field === 'opt' ? '-O ' : ''}${list}`),
    // berry: `up` bumps the package in every workspace that declares it, keeping its field.
    'yarn-berry': `yarn up ${specs(all)}`,
    bun: byField((field, list) => `bun add ${field === 'dev' ? '-d ' : field === 'opt' ? '--optional ' : ''}${list}`),
    upm: byField((field, list) => `upm add ${field === 'dev' ? '--dev ' : field === 'opt' ? '--optional ' : ''}${list}`),
    npm: byField((field, list) => `npm install ${field === 'dev' ? '--save-dev ' : field === 'opt' ? '--save-optional ' : ''}${list}`),
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

/** Nearest directory at or above `from` containing `filename`, or undefined. */
function findUp(from: string, filename: string): string | undefined {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, filename))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Nearest workspace/install root at or above `from` (pnpm-workspace.yaml, lockfile, or package.json). */
function workspaceRoot(from: string): string {
  const pnpm = findUp(from, 'pnpm-workspace.yaml');
  if (pnpm) return pnpm;
  let dir = path.resolve(from);
  let fallback: string | undefined;
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) fallback ??= dir;
    if (
      ['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'upm.lock', 'pnpm-lock.yaml'].some((f) => existsSync(path.join(dir, f)))
    )
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return fallback ?? path.resolve(from);
    dir = parent;
  }
}

const DECLARED_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

async function manifestDeclares(dir: string, pkg: string): Promise<boolean> {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return false;
  try {
    const json = JSON.parse(await readFile(file, 'utf8')) as Record<string, Record<string, string> | undefined>;
    return DECLARED_FIELDS.some((field) => json[field] !== undefined && Object.hasOwn(json[field]!, pkg));
  } catch {
    return false;
  }
}

async function workspaceManifestDirs(root: string, extraDirs: string[] = []): Promise<string[]> {
  const wsRoot = workspaceRoot(root);
  const dirs = new Set<string>([path.resolve(root), wsRoot, ...extraDirs.map((d) => path.resolve(d))]);

  const patterns: string[] = [];
  const pnpmWs = path.join(wsRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWs)) {
    try {
      const doc = parseDocument(await readFile(pnpmWs, 'utf8'));
      const pkgs = doc.get('packages');
      if (pkgs && typeof pkgs === 'object' && 'toJSON' in pkgs) {
        const list = (pkgs as { toJSON: () => unknown }).toJSON();
        if (Array.isArray(list)) patterns.push(...list.filter((p): p is string => typeof p === 'string'));
      }
    } catch {
      // unreadable workspace file
    }
  }
  const rootPkg = path.join(wsRoot, 'package.json');
  if (existsSync(rootPkg)) {
    try {
      const json = JSON.parse(await readFile(rootPkg, 'utf8')) as { workspaces?: string[] | { packages?: string[] } };
      const ws = Array.isArray(json.workspaces) ? json.workspaces : json.workspaces?.packages;
      if (Array.isArray(ws)) patterns.push(...ws.filter((p): p is string => typeof p === 'string'));
    } catch {
      // unreadable manifest
    }
  }
  const include = patterns.filter((p) => p && !p.startsWith('!'));
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  for (const pattern of include) {
    const normalized = pattern.replace(/\/+$/, '');
    const manifestGlob = normalized === '.' ? 'package.json' : `${normalized}/package.json`;
    for await (const match of glob(manifestGlob, { cwd: wsRoot, exclude: ['**/node_modules/**', ...exclude] })) {
      dirs.add(path.resolve(wsRoot, path.dirname(match)));
    }
  }
  return [...dirs];
}

/**
 * True when `pkg` is declared in `dependencies`, `devDependencies`, or `optionalDependencies`
 * of the project root, any `extraDirs` (e.g. `resolveFrom`), or any workspace package listed in
 * `pnpm-workspace.yaml` or `package.json` `workspaces`.
 */
export async function isDeclaredNpmDependency(root: string, pkg: string, extraDirs: string[] = []): Promise<boolean> {
  for (const dir of await workspaceManifestDirs(root, extraDirs)) {
    if (await manifestDeclares(dir, pkg)) return true;
  }
  return false;
}

export interface PnpmCatalogRef {
  /** Workspace-relative path to the package.json referencing the catalog. */
  file: string;
  field: (typeof DECLARED_FIELDS)[number];
  /** Empty string for the default `catalog`, or the named catalog under `catalogs`. */
  catalog: string;
}

/**
 * Find every `catalog:` / `catalog:<name>` declaration of `pkg` across workspace manifests.
 * Used to prevent `pnpm update` from silently replacing `catalog:` references with literals (#55).
 */
export async function findPnpmCatalogReferences(root: string, pkg: string, extraDirs: string[] = []): Promise<PnpmCatalogRef[]> {
  const wsRoot = workspaceRoot(root);
  const refs: PnpmCatalogRef[] = [];
  for (const dir of await workspaceManifestDirs(root, extraDirs)) {
    const file = path.join(dir, 'package.json');
    if (!existsSync(file)) continue;
    try {
      const json = JSON.parse(await readFile(file, 'utf8')) as Record<string, Record<string, unknown> | undefined>;
      for (const field of DECLARED_FIELDS) {
        const spec = json[field]?.[pkg];
        if (typeof spec === 'string' && spec.startsWith('catalog:')) {
          const rel = path.relative(wsRoot, file).split(path.sep).join('/') || 'package.json';
          refs.push({ file: rel, field, catalog: spec.slice('catalog:'.length) });
        }
      }
    } catch {
      // ignore unreadable manifest
    }
  }
  return refs;
}

/** Read a single catalog entry from the nearest `pnpm-workspace.yaml`, or undefined if absent. */
export async function readPnpmCatalogValue(root: string, pkg: string, catalog = ''): Promise<unknown> {
  const dir = findUp(root, 'pnpm-workspace.yaml');
  if (!dir) return undefined;
  const doc = parseDocument(await readFile(path.join(dir, 'pnpm-workspace.yaml'), 'utf8'));
  return doc.getIn(catalog ? ['catalogs', catalog, pkg] : ['catalog', pkg]);
}

/** Rewrite a pinned version string (`1.0.0`, `^1.0.0`, `~1.0.0`, `=1.0.0`) from `from` to `to`, keeping its prefix. */
function bumpPinnedVersion(value: unknown, from: string, to: string): string | undefined {
  const m = typeof value === 'string' ? /^([~^=]?)(.*)$/.exec(value) : null;
  return m && m[2] === from ? `${m[1]}${to}` : undefined;
}

/**
 * Update declared dependency entries (`dependencies`, `devDependencies`, `optionalDependencies`)
 * across workspace manifests that pin `from` (`1.0.0`, `^1.0.0`, `~1.0.0`, `=1.0.0`) to `to`,
 * keeping prefixes and JSON indentation. Complex ranges and `catalog:` references are left alone (#74).
 */
export async function updateDeclaredNpmSpecs(
  root: string,
  updates: { pkg: string; from: string; to: string }[],
  extraDirs: string[] = [],
): Promise<{ moved: string[]; files: string[] }> {
  const moved = new Set<string>();
  const files = new Set<string>();
  if (!updates.length) return { moved: [], files: [] };
  const wsRoot = workspaceRoot(root);
  for (const dir of await workspaceManifestDirs(root, extraDirs)) {
    const file = path.join(dir, 'package.json');
    if (!existsSync(file)) continue;
    let before: string;
    let json: Record<string, Record<string, unknown> | undefined>;
    try {
      before = await readFile(file, 'utf8');
      json = JSON.parse(before) as Record<string, Record<string, unknown> | undefined>;
    } catch {
      continue;
    }
    let changed = false;
    for (const field of DECLARED_FIELDS) {
      const map = json[field];
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      for (const { pkg, from, to } of updates) {
        const next = bumpPinnedVersion(map[pkg], from, to);
        if (!next) continue;
        map[pkg] = next;
        moved.add(pkg);
        changed = true;
      }
    }
    if (changed) {
      const indent = /^[ \t]+/m.exec(before)?.[0] ?? '  ';
      await writeFile(file, `${JSON.stringify(json, null, indent)}\n`);
      files.add(path.relative(wsRoot, file).split(path.sep).join('/') || 'package.json');
    }
  }
  return { moved: [...moved], files: [...files] };
}

/**
 * Update existing top-level override/resolution entries that pin a package's previously
 * installed version (`1.0.0`, `^1.0.0`, `~1.0.0`, `=1.0.0`) to its new version, keeping prefixes,
 * comments and formatting. Complex ranges or nested selectors are left alone.
 */
export async function updatePackageOverrides(
  root: string,
  pm: PackageManager,
  updates: { pkg: string; from: string; to: string }[],
): Promise<{ moved: string[]; locations: string[] }> {
  const moved = new Set<string>();
  const locations = new Set<string>();
  if (!updates.length) return { moved: [], locations: [] };
  const wsRoot = workspaceRoot(root);

  if (pm === 'pnpm') {
    const wsFile = path.join(wsRoot, 'pnpm-workspace.yaml');
    if (existsSync(wsFile)) {
      const before = await readFile(wsFile, 'utf8');
      const doc = parseDocument(before);
      for (const { pkg, from, to } of updates) {
        const next = bumpPinnedVersion(doc.getIn(['overrides', pkg]), from, to);
        if (!next) continue;
        doc.setIn(['overrides', pkg], next);
        moved.add(pkg);
        locations.add("pnpm-workspace.yaml's overrides");
      }
      const after = doc.toString();
      if (after !== before) await writeFile(wsFile, after);
    }
  }

  const manifestFile = path.join(wsRoot, 'package.json');
  if (existsSync(manifestFile)) {
    const before = await readFile(manifestFile, 'utf8');
    const json = JSON.parse(before) as Record<string, unknown>;
    const target: { map: Record<string, unknown> | undefined; label: string } =
      pm === 'pnpm'
        ? {
            map: (json.pnpm as Record<string, unknown> | undefined)?.overrides as Record<string, unknown> | undefined,
            label: 'package.json pnpm.overrides',
          }
        : pm === 'yarn' || pm === 'yarn-berry'
          ? { map: json.resolutions as Record<string, unknown> | undefined, label: 'package.json resolutions' }
          : { map: json.overrides as Record<string, unknown> | undefined, label: 'package.json overrides' };
    let changed = false;
    if (target.map && typeof target.map === 'object' && !Array.isArray(target.map)) {
      for (const { pkg, from, to } of updates) {
        const next = bumpPinnedVersion(target.map[pkg], from, to);
        if (!next) continue;
        target.map[pkg] = next;
        moved.add(pkg);
        locations.add(target.label);
        changed = true;
      }
    }
    if (changed) {
      const indent = /^[ \t]+/m.exec(before)?.[0] ?? '  ';
      await writeFile(manifestFile, `${JSON.stringify(json, null, indent)}\n`);
    }
  }

  return { moved: [...moved], locations: [...locations] };
}

/**
 * pnpm catalogs: point the entries (default `catalog` and named `catalogs`) that pin a package's
 * previously installed version at its new one, keeping the range prefix (`^24.0.0` → `^24.0.6`)
 * and the file's comments. Entries pinning something else (e.g. a peer range) are left alone.
 * Returns the packages whose catalog entries moved. `pnpm update` can't be used for these: it
 * replaces the `catalog:` references in the manifests with the literal version.
 */
export async function updatePnpmCatalogs(
  root: string,
  updates: { pkg: string; from: string; to: string }[],
  options: { dryRun?: boolean } = {},
): Promise<string[]> {
  const dir = findUp(root, 'pnpm-workspace.yaml');
  if (!dir) return [];
  const file = path.join(dir, 'pnpm-workspace.yaml');
  const before = await readFile(file, 'utf8');
  const doc = parseDocument(before);
  const catalogs: (string | number)[][] = [['catalog']];
  const named = doc.getIn(['catalogs']) as { items?: { key: unknown }[] } | undefined;
  for (const item of named?.items ?? []) catalogs.push(['catalogs', String((item.key as { value?: unknown })?.value ?? item.key)]);
  const moved = new Set<string>();
  for (const { pkg, from, to } of updates) {
    for (const at of catalogs) {
      const next = bumpPinnedVersion(doc.getIn([...at, pkg]), from, to);
      if (!next) continue;
      doc.setIn([...at, pkg], next);
      moved.add(pkg);
    }
  }
  const after = doc.toString();
  if (!options.dryRun && after !== before) await writeFile(file, after);
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
  return topLevelUpgrade(upgrade, ecosystem, pkg, version)?.command;
}

/** Condition(s) checked after an upgrade command succeeds to detect unfinished work for an agent (#57). */
export interface UpgradeNeedsAgentIf {
  /** Glob pattern(s) relative to the project root; triggers if any matching path exists after the upgrade. */
  exists?: string[];
  /** Regular expression tested against the upgrade command's ANSI-stripped output. */
  output?: string;
  /** Shell command run from the project root ({package}/{version} filled in); triggers if it exits 0. */
  command?: string;
}

/** A project's upgrade for one package: the command to run, how long it may take, and optional hand-off checks. */
export interface Upgrade {
  command: string;
  timeoutMinutes: number;
  needsAgentIf?: UpgradeNeedsAgentIf;
}

/** How long an upgrade command may run when its entry doesn't say. */
export const DEFAULT_UPGRADE_TIMEOUT_MINUTES = 30;

function topLevelUpgrade(upgrade: Record<string, unknown> | undefined, ecosystem: string, pkg: string, version: string) {
  const key = upgrade && `${ecosystem}:${pkg}` in upgrade ? `${ecosystem}:${pkg}` : pkg;
  return fillUpgrade(upgrade?.[key], `upgrade["${key}"]`, pkg, version);
}

const NEEDS_AGENT_KEYS = new Set(['exists', 'output', 'command']);

function parseNeedsAgentIf(raw: unknown, where: string, pkg: string, version: string): UpgradeNeedsAgentIf | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GraftError(
      `.grafts/config.json: ${where}.needsAgentIf must be an object with at least one of "exists", "output", or "command"`,
      'config/invalid',
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!NEEDS_AGENT_KEYS.has(key)) {
      throw new GraftError(
        `.grafts/config.json: ${where}.needsAgentIf has unknown key "${key}" (expected "exists", "output", or "command")`,
        'config/invalid',
      );
    }
  }
  const parsed: UpgradeNeedsAgentIf = {};
  if (obj.exists !== undefined) {
    const list = typeof obj.exists === 'string' ? [obj.exists] : Array.isArray(obj.exists) ? obj.exists : undefined;
    if (!list || !list.length || !list.every((s): s is string => typeof s === 'string' && s.trim().length > 0)) {
      throw new GraftError(
        `.grafts/config.json: ${where}.needsAgentIf.exists must be a non-empty glob string or array of glob strings`,
        'config/invalid',
      );
    }
    parsed.exists = list;
  }
  if (obj.output !== undefined) {
    if (typeof obj.output !== 'string' || !obj.output.length) {
      throw new GraftError(
        `.grafts/config.json: ${where}.needsAgentIf.output must be a non-empty regular expression string`,
        'config/invalid',
      );
    }
    try {
      RegExp(obj.output);
    } catch (err) {
      throw new GraftError(
        `.grafts/config.json: ${where}.needsAgentIf.output is not a valid regular expression: ${(err as Error).message}`,
        'config/invalid',
      );
    }
    parsed.output = obj.output;
  }
  if (obj.command !== undefined) {
    if (typeof obj.command !== 'string' || !obj.command.trim().length) {
      throw new GraftError(`.grafts/config.json: ${where}.needsAgentIf.command must be a non-empty command string`, 'config/invalid');
    }
    parsed.command = obj.command.replaceAll('{package}', pkg).replaceAll('{version}', version);
  }
  if (!parsed.exists && !parsed.output && !parsed.command) {
    throw new GraftError(
      `.grafts/config.json: ${where}.needsAgentIf must specify at least one of "exists", "output", or "command"`,
      'config/invalid',
    );
  }
  return parsed;
}

/**
 * An upgrade entry, either a command string or `{ command, timeoutMinutes?, needsAgentIf? }`, with
 * `{package}` and `{version}` filled in. `config/invalid` for a command without `{version}`, a bad
 * timeout, or a malformed `needsAgentIf`.
 */
function fillUpgrade(entry: unknown, where: string, pkg: string, version: string): Upgrade | undefined {
  if (entry === undefined) return undefined;
  const object = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined;
  const template = object ? object.command : entry;
  if (typeof template !== 'string' || !template.includes('{version}')) {
    throw new GraftError(
      `.grafts/config.json: ${where} must be a command containing {version}, or { "command": …, "timeoutMinutes": … }`,
      'config/invalid',
    );
  }
  const timeoutMinutes = object?.timeoutMinutes ?? DEFAULT_UPGRADE_TIMEOUT_MINUTES;
  if (typeof timeoutMinutes !== 'number' || !(timeoutMinutes > 0)) {
    throw new GraftError(`.grafts/config.json: ${where}.timeoutMinutes must be a positive number of minutes`, 'config/invalid');
  }
  const needsAgentIf = object ? parseNeedsAgentIf(object.needsAgentIf, where, pkg, version) : undefined;
  return {
    command: template.replaceAll('{package}', pkg).replaceAll('{version}', version),
    timeoutMinutes,
    ...(needsAgentIf ? { needsAgentIf } : {}),
  };
}

/**
 * The project's upgrade command for `pkg` in `ecosystem`: `ecosystems.<ecosystem>.upgrade[pkg]`
 * wins, as `ecosystems.npm.upstream` wins over `upstream`; then the top-level `upgrade` map
 * (see {@link upgradeCommand}). An entry is a command string or `{ command, timeoutMinutes?, needsAgentIf? }`.
 */
export function resolveUpgrade(
  config: { upgrade?: Record<string, unknown>; ecosystems?: Partial<Record<string, Record<string, unknown>>> },
  ecosystem: string,
  pkg: string,
  version: string,
): Upgrade | undefined {
  const own = config.ecosystems?.[ecosystem]?.upgrade;
  if (own !== undefined && (typeof own !== 'object' || own === null || Array.isArray(own))) {
    throw new GraftError(`.grafts/config.json: ecosystems.${ecosystem}.upgrade must be an object of commands`, 'config/invalid');
  }
  const scoped = own as Record<string, unknown> | undefined;
  if (scoped && pkg in scoped) return fillUpgrade(scoped[pkg], `ecosystems.${ecosystem}.upgrade["${pkg}"]`, pkg, version);
  return topLevelUpgrade(config.upgrade, ecosystem, pkg, version);
}

/**
 * Run a project's upgrade command from the project root, streaming its output to `onOutput`.
 * Throws `install/failed` with its output on failure or timeout.
 */
export async function runUpgrade(
  root: string,
  command: string,
  timeoutMinutes: number = DEFAULT_UPGRADE_TIMEOUT_MINUTES,
  onOutput?: (chunk: string) => void,
): Promise<string> {
  const result = await runCommand(command, { cwd: root, timeoutMs: timeoutMinutes * 60_000, onOutput });
  if (!result.passed) {
    const why = result.timedOut ? `timed out after ${timeoutMinutes} minutes` : `exit ${result.exitCode}`;
    throw new GraftError(`upgrade command \`${command}\` failed (${why}):\n${result.output}`, 'install/failed');
  }
  return command;
}

const ANSI_ESCAPES = new RegExp(String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]`, 'g');

/**
 * Evaluate an upgrade entry's `needsAgentIf` checks after the upgrade command succeeded (#57).
 * Returns the matched reasons (empty when no check triggered). Throws `install/failed` if a
 * `needsAgentIf.command` times out or cannot be executed (exit 126/127) so broken checks fail loudly.
 */
export async function checkUpgradeNeedsAgent(
  root: string,
  check: UpgradeNeedsAgentIf,
  rawOutput: string,
): Promise<{ matched: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  if (check.exists) {
    const matchedPaths: string[] = [];
    for (const pattern of check.exists) {
      for await (const match of glob(pattern, { cwd: root })) {
        matchedPaths.push(match.split(path.sep).join('/'));
        if (matchedPaths.length >= 5) break;
      }
    }
    if (matchedPaths.length) reasons.push(`found ${matchedPaths.map((p) => `\`${p}\``).join(', ')}`);
  }
  if (check.output) {
    const plain = rawOutput.replace(ANSI_ESCAPES, '');
    if (new RegExp(check.output).test(plain)) reasons.push(`output matched /${check.output}/`);
  }
  if (check.command) {
    const r = await runCommand(check.command, { cwd: root, timeoutMs: 60_000 });
    if (r.timedOut || r.exitCode === 126 || r.exitCode === 127) {
      const why = r.timedOut ? 'timed out' : `exit ${r.exitCode}`;
      throw new GraftError(`upgrade needsAgentIf command \`${check.command}\` failed to run (${why}):\n${r.output}`, 'install/failed');
    }
    if (r.passed) {
      const note = r.output
        .replace(ANSI_ESCAPES, '')
        .trim()
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-1)[0];
      reasons.push(`check \`${check.command}\` matched${note ? ` (${note.slice(0, 200)})` : ''}`);
    }
  }
  return { matched: reasons.length > 0, reasons };
}
