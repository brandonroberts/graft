// Graft's built-in patch applier: apply variants directly to installed package copies.
//
// Runs from the project's postinstall (`graft apply --installed`), so it must be:
//   - offline: it patches the installed file itself, never fetching pristine upstream;
//   - idempotent: a file the patch no longer fits but whose *reverse* fits is already patched;
//   - store-safe: package managers hardlink files from a global store (pnpm, bun, some npm
//     setups), so files are replaced by rename (new inode), never edited in place;
//   - strict: anything that does not fit fails the install.
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { reversePatch, applyPatch } from 'diff';
import type { InstalledCopyResult } from '@graftsync/core';
import { patchTarget, type FilePatch } from './patchfile.js';

export interface InstalledCopy {
  dir: string;
  version: string;
}

/**
 * Every installed copy of `pkg` under `root`'s node_modules tree (hoisted and nested),
 * deduplicated by real path. pnpm's virtual store (`.pnpm`) is skipped: pnpm patches natively.
 */
export async function findInstalledCopies(root: string, pkg: string, maxDepth = 12): Promise<InstalledCopy[]> {
  const copies = new Map<string, InstalledCopy>();
  const visited = new Set<string>();
  const visit = async (nodeModules: string, depth: number): Promise<void> => {
    if (depth > maxDepth || !existsSync(nodeModules)) return;
    const real = await realpath(nodeModules);
    if (visited.has(real)) return;
    visited.add(real);
    const candidate = path.join(nodeModules, pkg, 'package.json');
    if (existsSync(candidate)) {
      const dir = await realpath(path.dirname(candidate));
      const { version } = JSON.parse(await readFile(candidate, 'utf8')) as { version?: string };
      if (version && !copies.has(dir)) copies.set(dir, { dir, version });
    }
    const entries = await readdir(nodeModules, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // .bin, .cache, .pnpm, .package-lock.json …
      const names = e.name.startsWith('@')
        ? (await readdir(path.join(nodeModules, e.name)).catch(() => [])).map((n) => `${e.name}/${n}`)
        : [e.name];
      for (const name of names) await visit(path.join(nodeModules, name, 'node_modules'), depth + 1);
    }
  };
  await visit(path.join(root, 'node_modules'), 0);
  return [...copies.values()];
}

/** Replace `file` with `content` through a new inode (never writes into a hardlinked store file). */
export async function writeNewInode(file: string, content: string): Promise<void> {
  const previous = await stat(file).catch(() => undefined);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.graft-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content);
  if (previous) await chmod(tmp, previous.mode & 0o7777);
  await rename(tmp, file);
}

type Planned = { file: string; content?: string; remove?: boolean; already?: boolean };

/**
 * Plan (and then apply) one variant to one installed copy. All files are checked before any is
 * written, so a copy is never left half-patched.
 */
export async function applyToInstalledCopy(
  copy: InstalledCopy,
  patches: FilePatch[],
): Promise<Pick<InstalledCopyResult, 'action' | 'files' | 'reason'>> {
  const plan: Planned[] = [];
  for (const p of patches) {
    const target = patchTarget(p);
    const file = path.join(copy.dir, target);
    const exists = existsSync(file) && (await lstat(file)).isFile();
    const content = exists ? await readFile(file, 'utf8') : undefined;
    if (p.oldFile === null) {
      // Creates a file.
      const created = applyPatch('', p.raw, { fuzzFactor: 0 });
      if (created === false) return { action: 'failed', files: [], reason: `${target}: cannot build the created file` };
      if (content === undefined) plan.push({ file, content: created });
      else if (content === created) plan.push({ file, already: true });
      else return { action: 'failed', files: [], reason: `${target} already exists upstream with different content` };
      continue;
    }
    if (content === undefined) {
      if (p.newFile === null) {
        plan.push({ file, already: true }); // deletion already done
        continue;
      }
      return { action: 'failed', files: [], reason: `${target} is missing in the installed copy` };
    }
    const forward = applyPatch(content, p.raw, { fuzzFactor: 0 });
    if (forward !== false) {
      plan.push(p.newFile === null ? { file, remove: true } : { file: path.join(copy.dir, p.newFile), content: forward });
      if (p.newFile && p.newFile !== target) plan.push({ file, remove: true });
      continue;
    }
    if (applyPatch(content, reversePatch(p.raw), { fuzzFactor: 0 }) !== false) {
      plan.push({ file, already: true });
      continue;
    }
    return {
      action: 'failed',
      files: [],
      reason: `${target}: the patch does not apply to the installed copy (and it is not already applied)`,
    };
  }
  const writes = plan.filter((x) => !x.already);
  for (const w of writes) {
    if (w.remove) await rm(w.file, { force: true });
    else await writeNewInode(w.file, w.content!);
  }
  const files = plan.map((x) => path.relative(copy.dir, x.file).split(path.sep).join('/'));
  return { action: writes.length ? 'patched' : 'already-patched', files };
}
