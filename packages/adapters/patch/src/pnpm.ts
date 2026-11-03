import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';

export const WORKSPACE_FILE = 'pnpm-workspace.yaml';

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

export interface PnpmPatchState {
  workspaceRoot: string;
  /** Value of patchedDependencies keys that apply to `pkg` (name-only or name@version). */
  entries: { key: string; path: string }[];
  ignorePatchFailures: unknown;
}

const keyMatches = (key: string, pkg: string) => key === pkg || (key.startsWith(`${pkg}@`) && key.length > pkg.length + 1);

export async function readPnpmPatchState(root: string, pkg: string): Promise<PnpmPatchState | undefined> {
  const workspaceRoot = findPnpmWorkspaceRoot(root);
  if (!workspaceRoot) return undefined;
  const doc = parseDocument(await readFile(path.join(workspaceRoot, WORKSPACE_FILE), 'utf8'));
  const patched = (doc.get('patchedDependencies', false) as { toJSON?: () => unknown } | undefined)?.toJSON?.() as
    | Record<string, string>
    | undefined;
  return {
    workspaceRoot,
    entries: Object.entries(patched ?? {})
      .filter(([key]) => keyMatches(key, pkg))
      .map(([key, p]) => ({ key, path: p })),
    ignorePatchFailures: doc.get('ignorePatchFailures'),
  };
}

/** Problems that would make pnpm apply something other than `variantPath` to `pkg`, or fail silently. */
export async function pnpmConfigProblems(root: string, pkg: string, variantPath: string): Promise<string[]> {
  const state = await readPnpmPatchState(root, pkg);
  if (!state) return [`no ${WORKSPACE_FILE} found; the patch mechanism applies grafts through pnpm patchedDependencies`];
  const problems: string[] = [];
  const expected = relativePosix(state.workspaceRoot, variantPath);
  if (state.ignorePatchFailures !== false) {
    problems.push(`${WORKSPACE_FILE} must set \`ignorePatchFailures: false\`, otherwise pnpm only warns when a patch stops applying`);
  }
  if (!state.entries.length) problems.push(`patchedDependencies has no entry for ${pkg} (expected ${pkg}: ${expected})`);
  for (const e of state.entries) {
    if (e.key !== pkg) problems.push(`patchedDependencies["${e.key}"] is version-pinned; graft manages ${pkg} with a name-only key`);
    else if (path.resolve(state.workspaceRoot, e.path) !== path.resolve(variantPath)) {
      problems.push(`patchedDependencies["${pkg}"] points to ${e.path}, but the selected variant is ${expected}`);
    }
  }
  return problems;
}

/** Point patchedDependencies[pkg] at `variantPath` and enforce ignorePatchFailures: false. Preserves comments. */
export async function configurePnpmPatch(root: string, pkg: string, variantPath: string): Promise<{ file: string; changed: boolean }> {
  const workspaceRoot = findPnpmWorkspaceRoot(root);
  if (!workspaceRoot) throw new Error(`no ${WORKSPACE_FILE} found above ${root}`);
  const file = path.join(workspaceRoot, WORKSPACE_FILE);
  const before = await readFile(file, 'utf8');
  const doc = parseDocument(before);
  const patched = doc.get('patchedDependencies', true) as { items?: { key: unknown }[] } | undefined;
  for (const item of patched?.items ?? []) {
    const key = String((item.key as { value?: unknown })?.value ?? item.key);
    if (key !== pkg && keyMatches(key, pkg)) doc.deleteIn(['patchedDependencies', key]);
  }
  doc.setIn(['patchedDependencies', pkg], relativePosix(workspaceRoot, variantPath));
  doc.set('ignorePatchFailures', false);
  const after = doc.toString();
  if (after !== before) await writeFile(file, after);
  return { file, changed: after !== before };
}

function relativePosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}
