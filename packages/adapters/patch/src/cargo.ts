// The cargo-vendor applier: pristine crate + the selected variant, committed as
// .grafts/.vendor/<crate>-<version>/, and wired in with the workspace root's
//
//   [patch.crates-io]
//   <crate> = { path = ".grafts/.vendor/<crate>-<version>" }
//
// Cargo has no patch files. Its silent failure: a [patch] whose version doesn't match what the
// lockfile resolves is NOT used, yet `cargo build` exits 0 with only a warning and records it under
// [[patch.unused]] in Cargo.lock. So problems() fails on that entry, and on any resolution where
// cargo metadata doesn't show the crate coming from the vendored directory.
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cargoManifest,
  cargoMetadata,
  ecosystemOptions,
  GraftError,
  posixPath,
  tool,
  type CargoOptions,
  type Project,
} from '@graftsync/core';
import type { ApplierContext, PatchApplier } from './appliers.js';
import { getTomlValue, inlineTableString, setTomlValue } from './toml.js';
import { otherVendoredDirs, patchedDirProblems, writePatchedDir } from './vendor-dir.js';

export const VENDOR_DIR_NAME = '.vendor';

const need = (ctx: ApplierContext | undefined) => {
  if (!ctx?.project || !ctx.upstream)
    throw new GraftError('the cargo-vendor applier needs the project and its upstream source', 'applier/context');
  return { project: ctx.project, upstream: ctx.upstream };
};

/** The workspace root manifest, where [patch] must live. */
export async function cargoWorkspaceManifest(project: Project): Promise<string> {
  const manifest = cargoManifest(project);
  if (!existsSync(manifest)) throw new GraftError(`no Cargo manifest at ${manifest} (set ecosystems.cargo.manifest)`, 'cargo/manifest');
  const { stdout } = await tool('cargo', ['locate-project', '--workspace', '--message-format', 'plain', '--manifest-path', manifest], {
    cwd: path.dirname(manifest),
    code: 'cargo/manifest',
  });
  return stdout.trim();
}

const patchTable = (project: Project) => `patch.${ecosystemOptions<CargoOptions>(project, 'cargo').registry ?? 'crates-io'}`;
export const cargoVendorDir = (project: Project, crate: string, version: string) =>
  path.join(project.graftsDir, VENDOR_DIR_NAME, `${crate}-${version}`);

/** Crate names listed under [[patch.unused]] in a Cargo.lock. */
export function unusedPatches(lock: string): { name: string; version?: string }[] {
  const out: { name: string; version?: string }[] = [];
  for (const block of lock.split(/^\[\[/m).slice(1)) {
    if (!block.startsWith('patch.unused]]')) continue;
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    if (name) out.push({ name, version: /^version = "([^"]+)"/m.exec(block)?.[1] });
  }
  return out;
}

export const cargoVendorApplier: PatchApplier = {
  name: 'cargo-vendor',
  async problems(_root, crate, version, variantPath, ctx) {
    const { project, upstream } = need(ctx);
    const problems: string[] = [];
    const ws = await cargoWorkspaceManifest(project);
    const wsDir = path.dirname(ws);
    const dest = cargoVendorDir(project, crate, version);
    const rel = posixPath(path.relative(wsDir, dest));
    problems.push(...(await patchedDirProblems(await upstream.resolve(crate, version), variantPath, dest, rel)));

    const table = patchTable(project);
    const declared = inlineTableString(getTomlValue(await readFile(ws, 'utf8'), table, crate), 'path');
    if (!declared) problems.push(`${path.basename(ws)} has no [${table}] entry for ${crate} (expected ${crate} = { path = "${rel}" })`);
    else if (path.resolve(wsDir, declared) !== dest)
      problems.push(`${path.basename(ws)} [${table}] ${crate} points to ${declared}, not ${rel}`);

    const lockFile = path.join(wsDir, 'Cargo.lock');
    const unused = existsSync(lockFile) ? unusedPatches(await readFile(lockFile, 'utf8')).filter((u) => u.name === crate) : [];
    for (const u of unused) {
      problems.push(
        `Cargo.lock lists the patch for ${crate}${u.version ? ` ${u.version}` : ''} under [[patch.unused]]: cargo is NOT using the patched crate (it only warns, and exits 0); the vendored version must match what the project's requirements resolve`,
      );
    }
    const copies = (await cargoMetadata(ws)).packages.filter((p) => p.name === crate);
    if (!copies.some((p) => p.source === null && path.dirname(p.manifest_path) === dest && p.version === version)) {
      const now = copies.map((p) => `${p.version} from ${p.source ?? path.dirname(p.manifest_path)}`).join(', ') || 'nothing';
      problems.push(`cargo resolves ${crate} to ${now}, not the patched ${version} in ${rel}`);
    }
    for (const d of await otherVendoredDirs(path.dirname(dest), `${crate}-`, path.basename(dest))) {
      problems.push(`${posixPath(path.relative(wsDir, path.join(path.dirname(dest), d)))} is for another version of ${crate}; remove it`);
    }
    return problems;
  },
  async configure(_root, crate, version, variantPath, ctx) {
    const { project, upstream } = need(ctx);
    const ws = await cargoWorkspaceManifest(project);
    const dest = cargoVendorDir(project, crate, version);
    await writePatchedDir(await upstream.resolve(crate, version), variantPath, dest);
    for (const d of await otherVendoredDirs(path.dirname(dest), `${crate}-`, path.basename(dest))) {
      await rm(path.join(path.dirname(dest), d), { recursive: true, force: true });
    }
    const rel = posixPath(path.relative(path.dirname(ws), dest));
    const text = await readFile(ws, 'utf8');
    const next = setTomlValue(text, patchTable(project), crate, `{ path = ${JSON.stringify(rel)} }`, path.basename(ws));
    if (next !== text) await writeFile(ws, next);
    // Cargo re-resolves to the vendored path on its next command (the ecosystem's reinstall).
    return { files: [dest, ws], install: 'reinstall' };
  },
};
