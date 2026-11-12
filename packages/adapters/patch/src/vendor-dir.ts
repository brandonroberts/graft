// Vendored, patched package directories: pristine upstream + the selected variant, committed under
// .grafts/.vendor/<name>-<version>/ and pointed at by the ecosystem's own override (Cargo's
// [patch], Go's replace). Shared by the cargo-vendor and go-replace appliers.
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyToInstalledCopy } from './installed.js';
import { parsePatchFile } from './patchfile.js';

/** Files of a directory, relative (posix) and sorted. */
export async function treeFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await treeFiles(dir, child)));
    else if (e.isFile()) out.push(child);
  }
  return out.sort();
}

/** Paths that differ between two trees (missing on either side, or different bytes). */
export async function treeDifferences(a: string, b: string): Promise<string[]> {
  const [fa, fb] = await Promise.all([treeFiles(a), treeFiles(b)]);
  const all = [...new Set([...fa, ...fb])].sort();
  const out: string[] = [];
  for (const f of all) {
    if (!fa.includes(f) || !fb.includes(f)) out.push(f);
    else if (!(await readFile(path.join(a, f))).equals(await readFile(path.join(b, f)))) out.push(f);
  }
  return out;
}

/** Make a copied tree writable (Go's module cache is read-only, and `cp` keeps modes). */
async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, ((await stat(dir)).mode & 0o7777) | 0o200);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await makeWritable(p);
    else if (e.isFile()) await chmod(p, ((await stat(p)).mode & 0o7777) | 0o200);
  }
}

/** Build pristine + variant into a temp directory; returns it (the caller removes `tmp`). */
export async function buildPatchedDir(pristineDir: string, variantPath: string): Promise<{ dir: string; tmp: string }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'graft-vendor-dir-'));
  const dir = path.join(tmp, 'package');
  await cp(pristineDir, dir, { recursive: true });
  await makeWritable(dir);
  const result = await applyToInstalledCopy({ dir, version: '' }, parsePatchFile(await readFile(variantPath, 'utf8')));
  if (result.action !== 'patched') {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(`cannot build the vendored package: ${result.reason ?? `variant ${result.action}`}`);
  }
  return { dir, tmp };
}

/**
 * Replace `dest` with a fresh pristine + variant build, unless it already has exactly that content.
 * Returns true when `dest` changed.
 */
export async function writePatchedDir(pristineDir: string, variantPath: string, dest: string): Promise<boolean> {
  const built = await buildPatchedDir(pristineDir, variantPath);
  try {
    if (existsSync(dest) && !(await treeDifferences(built.dir, dest)).length) return false;
    await rm(dest, { recursive: true, force: true });
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(built.dir, dest).catch(async () => cp(built.dir, dest, { recursive: true }));
    return true;
  } finally {
    await rm(built.tmp, { recursive: true, force: true });
  }
}

/** Problems with a vendored directory: missing, or not pristine + variant. */
export async function patchedDirProblems(pristineDir: string, variantPath: string, dest: string, label: string): Promise<string[]> {
  if (!existsSync(dest)) return [`${label} is missing; run \`graft apply\``];
  const built = await buildPatchedDir(pristineDir, variantPath).catch((err: Error) => err);
  if (built instanceof Error) return [built.message];
  try {
    const diff = await treeDifferences(built.dir, dest);
    return diff.length
      ? [
          `${label} is stale: ${diff.slice(0, 5).join(', ')}${diff.length > 5 ? ` and ${diff.length - 5} more` : ''} differ from pristine + the variant; run \`graft apply\``,
        ]
      : [];
  } finally {
    await rm(built.tmp, { recursive: true, force: true });
  }
}

/** Other versions' vendored directories for the same package (`<prefix><digit>…`), to remove. */
export async function otherVendoredDirs(vendorDir: string, prefix: string, keep: string): Promise<string[]> {
  if (!existsSync(vendorDir)) return [];
  return (await readdir(vendorDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name !== keep && e.name.startsWith(prefix) && /^v?\d/.test(e.name.slice(prefix.length)))
    .map((e) => e.name);
}
