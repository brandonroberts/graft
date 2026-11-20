// Packages released together with a rootstock (npm): the project's dependencies that come from
// the same repository at the same version, e.g. `@nx/angular` and `@nx/vite` with `nx`. Moving
// the rootstock alone would leave them on the old version (spec §6).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GraftError } from './errors.js';
import type { Project } from './project.js';
import { findInstalledPackage, readInstalledFiles, type InstalledPackage, type UpstreamSource } from './upstream.js';

type Manifest = { repository?: string | { url?: string }; [field: string]: unknown };

/**
 * A repository field reduced to `host/owner/repo`, so `git+https://github.com/o/r.git`,
 * `git@github.com:o/r`, `github:o/r` and `o/r` compare equal. Undefined without one.
 */
export function repositoryKey(repository: Manifest['repository']): string | undefined {
  const raw = (typeof repository === 'string' ? repository : repository?.url)?.trim();
  if (!raw) return undefined;
  let url = raw
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const shorthand = /^(?:(github|gitlab|bitbucket):)?([\w.-]+)\/([\w.-]+)$/.exec(url);
  if (shorthand)
    return `${shorthand[1] === 'gitlab' ? 'gitlab.com' : shorthand[1] === 'bitbucket' ? 'bitbucket.org' : 'github.com'}/${shorthand[2]}/${shorthand[3]}`.toLowerCase();
  url = url
    .replace(/^[\w+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/^((?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/[^/]+\/[^/]+)\/(?:tree|blob|src)\/.*$/i, '$1');
  return url.toLowerCase();
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

async function declared(dir: string): Promise<string[]> {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return [];
  const manifest = JSON.parse(await readFile(file, 'utf8')) as Manifest;
  return DEPENDENCY_FIELDS.flatMap((field) => Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}));
}

async function manifestOf(installed: InstalledPackage): Promise<Manifest | undefined> {
  const text = (await readInstalledFiles(installed, ['package.json']))['package.json'];
  return text === undefined ? undefined : (JSON.parse(text) as Manifest);
}

/**
 * Resolve a sibling candidate's installed copy: when declared in `fromDir` (`resolveFrom[pkg]`),
 * resolve from that directory first so isolated pnpm workspaces find the exact copy `fromDir`
 * depends on instead of falling back to an ambiguous `.pnpm` scan (#89). Unrelated candidates that
 * remain ambiguous in `.pnpm` are skipped rather than aborting another package's upgrade.
 */
async function resolveCandidate(
  upstream: UpstreamSource,
  name: string,
  fromDir: string | undefined,
  inFrom: boolean,
): Promise<InstalledPackage | undefined> {
  if (inFrom && fromDir) {
    try {
      const local = await findInstalledPackage(name, fromDir);
      if (local) return local;
    } catch (err) {
      if (!(err instanceof GraftError && err.code === 'upstream/ambiguous-installed')) throw err;
    }
  }
  try {
    return await upstream.installed(name);
  } catch (err) {
    if (err instanceof GraftError && err.code === 'upstream/ambiguous-installed') return undefined;
    throw err;
  }
}

/**
 * The npm packages released together with `pkg`: declared by the project (its root manifest, and
 * the `resolveFrom` directory's for `pkg`), installed at `pkg`'s installed version, with the same
 * repository. Empty when `pkg` isn't installed or has no repository field.
 */
export async function findSiblings(project: Project, pkg: string): Promise<string[]> {
  const upstream = project.upstreamFor('npm');
  const root = await upstream.installed(pkg);
  if (!root) return [];
  const key = repositoryKey((await manifestOf(root))?.repository);
  if (!key) return [];
  const own = (project.config.ecosystems?.npm as { resolveFrom?: Record<string, string> } | undefined)?.resolveFrom?.[pkg];
  const from = own ?? project.config.resolveFrom?.[pkg];
  const fromDir = from ? path.resolve(project.root, from) : undefined;
  const fromNames = new Set(fromDir ? await declared(fromDir) : []);
  const names = new Set([...(await declared(project.root)), ...fromNames]);
  names.delete(pkg);
  const siblings: string[] = [];
  for (const name of [...names].sort()) {
    const installed = await resolveCandidate(upstream, name, fromDir, fromNames.has(name));
    if (installed?.version !== root.version) continue;
    if (repositoryKey((await manifestOf(installed))?.repository) === key) siblings.push(name);
  }
  return siblings;
}
