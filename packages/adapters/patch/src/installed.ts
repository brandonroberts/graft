// Graft's built-in patch applier: apply variants directly to installed package copies.
//
// Runs from the project's postinstall (`graft apply --installed`), so it must be:
//   - offline: it patches the installed file itself, never fetching pristine upstream;
//   - idempotent: a file the patch no longer fits but whose *reverse* fits is already patched;
//   - store-safe: package managers hardlink files from a global store (pnpm, bun, some npm
//     setups), so files are replaced by rename (new inode), never edited in place;
//   - strict: anything that does not fit fails the install.
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findInstalledCopies, type InstalledCopyResult, type InstalledPackage } from '@graftsync/core';
import { applyFilePatch, patchTarget, reverseFilePatch, type FilePatch } from './patchfile.js';

export type InstalledCopy = Pick<InstalledPackage, 'dir' | 'version'>;
export { findInstalledCopies };

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
      const created = applyFilePatch('', p);
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
    const forward = applyFilePatch(content, p);
    if (forward !== false) {
      plan.push(p.newFile === null ? { file, remove: true } : { file: path.join(copy.dir, p.newFile), content: forward });
      if (p.newFile && p.newFile !== target) plan.push({ file, remove: true });
      continue;
    }
    if (reverseFilePatch(content, p) !== false) {
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
