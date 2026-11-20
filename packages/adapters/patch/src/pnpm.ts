import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { activePnpmLockVersions } from '@graftsync/core';
import { parseDocument } from 'yaml';

export const WORKSPACE_FILE = 'pnpm-workspace.yaml';

/** pnpm 11 removed `ignorePatchFailures` and fails on patch errors by default. */
export const PNPM_STRICT_PATCH_MAJOR = 11;

const pnpmCliVersionCache = new Map<string, number | undefined>();

/** Nearest directory at or above `from` containing pnpm-workspace.yaml. */
export function findPnpmWorkspaceRoot(from: string): string | undefined {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, WORKSPACE_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Major version of pnpm for this project: `packageManager` ("pnpm@11.28.6") or
 * `devEngines.packageManager` in the workspace root's package.json, otherwise `pnpm --version`.
 */
export function pnpmMajor(root: string): number | undefined {
  const workspaceRoot = findPnpmWorkspaceRoot(root) ?? path.resolve(root);
  for (const dir of workspaceRoot === path.resolve(root) ? [workspaceRoot] : [workspaceRoot, path.resolve(root)]) {
    try {
      const json = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        packageManager?: unknown;
        devEngines?: { packageManager?: { name?: unknown; version?: unknown } | { name?: unknown; version?: unknown }[] };
      };
      const pm = /^pnpm@(\d+)/.exec(String(json.packageManager ?? ''))?.[1];
      if (pm) return Number(pm);
      const devPm = json.devEngines?.packageManager;
      const entries = Array.isArray(devPm) ? devPm : devPm ? [devPm] : [];
      const pnpmEntry = entries.find((e) => e && typeof e === 'object' && e.name === 'pnpm');
      const devVer =
        pnpmEntry && typeof pnpmEntry.version === 'string' ? /^(?:\^|~|>=|=)?\s*(\d+)/.exec(pnpmEntry.version.trim())?.[1] : undefined;
      if (devVer) return Number(devVer);
    } catch {
      // no readable manifest here
    }
  }
  if (pnpmCliVersionCache.has(workspaceRoot)) return pnpmCliVersionCache.get(workspaceRoot);
  const r = spawnSync('pnpm', ['--version'], { cwd: workspaceRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  const cliVer = r.status === 0 ? /^(\d+)/.exec(r.stdout.trim())?.[1] : undefined;
  const major = cliVer ? Number(cliVer) : undefined;
  pnpmCliVersionCache.set(workspaceRoot, major);
  return major;
}

/** Distinct active installed versions of `pkg` present in `<workspaceRoot>/node_modules/.pnpm`. */
export function installedPnpmVersions(workspaceRoot: string, pkg: string): string[] {
  const storeDir = path.join(workspaceRoot, 'node_modules', '.pnpm');
  if (!existsSync(storeDir)) return [];
  const active = activePnpmLockVersions(storeDir, pkg);
  const prefix = `${pkg.replace('/', '+')}@`;
  const versions = new Set<string>();
  try {
    for (const entry of readdirSync(storeDir)) {
      if (!entry.startsWith(prefix)) continue;
      const version = entry.slice(prefix.length).split(/[_(]/, 1)[0];
      if (version && (!active || active.has(version))) versions.add(version);
    }
  } catch {
    return [];
  }
  return [...versions].sort();
}

export interface PnpmPatchState {
  workspaceRoot: string;
  /** Value of patchedDependencies keys that apply to `pkg` (name-only or name@version). */
  entries: { key: string; path: string }[];
  ignorePatchFailures: unknown;
  /**
   * Entries for `pkg` in the root package.json's `pnpm.patchedDependencies` (where
   * `pnpm patch-commit` writes when that field exists). pnpm honors these too.
   */
  manifestEntries: { key: string; path: string }[];
}

async function readManifest(workspaceRoot: string): Promise<{ file: string; text: string; json: Record<string, any> } | undefined> {
  const file = path.join(workspaceRoot, 'package.json');
  if (!existsSync(file)) return undefined;
  const text = await readFile(file, 'utf8');
  return { file, text, json: JSON.parse(text) };
}

const keyMatches = (key: string, pkg: string) => key === pkg || (key.startsWith(`${pkg}@`) && key.length > pkg.length + 1);

function pnpmPatchKey(workspaceRoot: string, pkg: string, version?: string): { key: string; otherVersions: string[] } {
  const installed = version ? installedPnpmVersions(workspaceRoot, pkg) : [];
  if (version && installed.length > 1) {
    return { key: `${pkg}@${version}`, otherVersions: installed.filter((v) => v !== version) };
  }
  return { key: pkg, otherVersions: [] };
}

export async function readPnpmPatchState(root: string, pkg: string): Promise<PnpmPatchState | undefined> {
  const workspaceRoot = findPnpmWorkspaceRoot(root);
  if (!workspaceRoot) return undefined;
  const doc = parseDocument(await readFile(path.join(workspaceRoot, WORKSPACE_FILE), 'utf8'));
  const patched = (doc.get('patchedDependencies', false) as { toJSON?: () => unknown } | undefined)?.toJSON?.() as
    | Record<string, string>
    | undefined;
  const manifest = await readManifest(workspaceRoot);
  const fromManifest = (manifest?.json.pnpm?.patchedDependencies ?? {}) as Record<string, string>;
  return {
    workspaceRoot,
    entries: Object.entries(patched ?? {})
      .filter(([key]) => keyMatches(key, pkg))
      .map(([key, p]) => ({ key, path: p })),
    ignorePatchFailures: doc.get('ignorePatchFailures'),
    manifestEntries: Object.entries(fromManifest)
      .filter(([key]) => keyMatches(key, pkg))
      .map(([key, p]) => ({ key, path: p })),
  };
}

/** Problems that would make pnpm apply something other than `variantPath` to `pkg`, or fail silently. */
export async function pnpmConfigProblems(root: string, pkg: string, variantPath: string, version?: string): Promise<string[]> {
  const state = await readPnpmPatchState(root, pkg);
  if (!state) return [`no ${WORKSPACE_FILE} found; pnpm applies grafts through its patchedDependencies — run \`graft apply\` to create it`];
  const problems: string[] = [];
  const expected = relativePosix(state.workspaceRoot, variantPath);
  const major = pnpmMajor(state.workspaceRoot);
  if ((major === undefined || major < PNPM_STRICT_PATCH_MAJOR) && state.ignorePatchFailures !== false) {
    problems.push(`${WORKSPACE_FILE} must set \`ignorePatchFailures: false\`, otherwise pnpm only warns when a patch stops applying`);
  }
  const { key: expectedKey, otherVersions } = pnpmPatchKey(state.workspaceRoot, pkg, version);
  const pinned = expectedKey !== pkg;
  if (!state.entries.length) {
    problems.push(
      pinned
        ? `patchedDependencies has no entry for ${expectedKey} (expected ${expectedKey}: ${expected}); other versions of ${pkg} (${otherVersions.join(', ')}) are also installed in this workspace`
        : `patchedDependencies has no entry for ${pkg} (expected ${pkg}: ${expected})`,
    );
  }
  for (const e of state.manifestEntries) {
    problems.push(
      `package.json pnpm.patchedDependencies["${e.key}"] (${e.path}) also patches ${pkg}; graft manages it in ${WORKSPACE_FILE} — run \`graft apply\` to move it`,
    );
  }
  for (const e of state.entries) {
    if (e.key !== expectedKey) {
      if (pinned && e.key === pkg) {
        problems.push(
          `patchedDependencies["${pkg}"] is a name-only key, but other versions of ${pkg} (${otherVersions.join(', ')}) are installed in this workspace; pin it as "${expectedKey}" — run \`graft apply\``,
        );
      } else if (pinned) {
        problems.push(`patchedDependencies["${e.key}"] does not match ${expectedKey}; run \`graft apply\` to update it`);
      } else {
        problems.push(`patchedDependencies["${e.key}"] is version-pinned; graft manages ${pkg} with a name-only key`);
      }
    } else if (path.resolve(state.workspaceRoot, e.path) !== path.resolve(variantPath)) {
      problems.push(`patchedDependencies["${expectedKey}"] points to ${e.path}, but the selected variant is ${expected}`);
    }
  }
  return problems;
}

/**
 * Point patchedDependencies at `variantPath` (using a name-only key, or `pkg@version` when other
 * versions of `pkg` are installed in the workspace) and enforce `ignorePatchFailures: false` on
 * pnpm < 11. Preserves comments.
 */
export async function configurePnpmPatch(
  root: string,
  pkg: string,
  variantPath: string,
  version?: string,
): Promise<{ file: string; changed: boolean }> {
  // A project can be pnpm (e.g. via packageManager) without a workspace file yet.
  // pnpm 10+ accepts a settings-only pnpm-workspace.yaml for a single-package project.
  const workspaceRoot = findPnpmWorkspaceRoot(root) ?? path.resolve(root);
  const file = path.join(workspaceRoot, WORKSPACE_FILE);
  const before = existsSync(file) ? await readFile(file, 'utf8') : '';
  const doc = parseDocument(before);
  const { key: expectedKey } = pnpmPatchKey(workspaceRoot, pkg, version);
  const patched = doc.get('patchedDependencies', true) as { items?: { key: unknown }[] } | undefined;
  for (const item of patched?.items ?? []) {
    const key = String((item.key as { value?: unknown })?.value ?? item.key);
    if (key !== expectedKey && keyMatches(key, pkg)) doc.deleteIn(['patchedDependencies', key]);
  }
  doc.setIn(['patchedDependencies', expectedKey], relativePosix(workspaceRoot, variantPath));
  const major = pnpmMajor(workspaceRoot);
  if (major === undefined || major < PNPM_STRICT_PATCH_MAJOR) {
    doc.set('ignorePatchFailures', false);
  } else if (doc.get('ignorePatchFailures') === false) {
    doc.delete('ignorePatchFailures');
  }
  const after = doc.toString();
  if (after !== before) await writeFile(file, after);

  // Remove competing entries `pnpm patch-commit` may have written to package.json.
  let manifestChanged = false;
  const manifest = await readManifest(workspaceRoot);
  const patchedInManifest = manifest?.json.pnpm?.patchedDependencies as Record<string, string> | undefined;
  if (manifest && patchedInManifest) {
    for (const key of Object.keys(patchedInManifest)) {
      if (keyMatches(key, pkg)) {
        delete patchedInManifest[key];
        manifestChanged = true;
      }
    }
    if (manifestChanged) {
      if (!Object.keys(patchedInManifest).length) delete manifest.json.pnpm.patchedDependencies;
      if (!Object.keys(manifest.json.pnpm).length) delete manifest.json.pnpm;
      const indent = /^[ \t]+/m.exec(manifest.text)?.[0] ?? '  ';
      await writeFile(manifest.file, `${JSON.stringify(manifest.json, null, indent)}\n`);
    }
  }
  return { file, changed: after !== before || manifestChanged };
}

function relativePosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}
