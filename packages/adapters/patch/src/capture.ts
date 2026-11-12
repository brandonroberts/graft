// `graft capture` for the patch mechanism: the difference between the installed copy of a package
// (edited by hand or by an agent) and the pristine published contents of that version, as a
// package-relative git-style patch: the same format the variants use.
//
// What "the installed copy" is depends on the ecosystem:
//   npm    node_modules/<pkg> (or the PnP-free install)
//   cargo  the copy cargo resolves: the vendored, patched crate after `graft apply`, else the
//          registry source (shared by every project on the machine)
//   go     the module's replacement directory: the vendored, patched module after `graft apply`, or
//          any directory a replace points at. The module cache itself is read-only pristine.
//   pypi   the distribution's files in site-packages: the wheel's top-level packages and modules
//          (installers rewrite .dist-info and place .data elsewhere, so those aren't compared)
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { GraftError, type GraftContext } from '@graftsync/core';
import { applyFilePatch, parsePatchFile, patchTarget } from './patchfile.js';

/** Directories and files that are never part of the package as published. */
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'target']);
const skipFile = (name: string) => name === '.cargo-ok' || name.endsWith('.pyc');

/** Files of a package directory, relative and sorted (build output and caches left out). */
async function packageFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await packageFiles(dir, child)));
    } else if (e.isFile() && !skipFile(e.name)) out.push(child);
  }
  return out.sort();
}

const isWheelMetadata = (f: string) => /^[^/]+\.(dist-info|data)\//.test(f);

/**
 * A wheel's files as installed: the pristine wheel's own top-level packages and modules, walked in
 * site-packages (so files added or removed there count), and never the rest of site-packages.
 */
async function wheelFiles(pristineDir: string, sitePackages: string): Promise<{ before: string[]; after: string[] }> {
  const before = (await packageFiles(pristineDir)).filter((f) => !isWheelMetadata(f));
  const roots = [...new Set(before.map((f) => f.split('/')[0]!))];
  const after: string[] = [];
  for (const root of roots) {
    const full = path.join(sitePackages, root);
    if (!existsSync(full)) continue;
    if ((await stat(full)).isDirectory()) after.push(...(await packageFiles(sitePackages, root)));
    else after.push(root);
  }
  return { before, after: after.sort() };
}

const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

/**
 * Package managers and older npm/yarn add bookkeeping fields (`_resolved`, `_integrity`, …) to an
 * installed package.json. Those are not a modification; anything else in it is.
 */
function samePackageJson(pristine: string, installed: string): boolean {
  try {
    const strip = (s: string) =>
      JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(s) as object).filter(([k]) => !k.startsWith('_'))));
    return strip(pristine) === strip(installed);
  } catch {
    return pristine === installed;
  }
}

/** What a patch variant makes of pristine: file → content (null: deleted). Undefined if it isn't a patch that applies. */
async function variantResult(pristineDir: string, variantPath: string): Promise<Map<string, string | null> | undefined> {
  if (!/\.(patch|diff)$/.test(variantPath)) return undefined;
  const patches = parsePatchFile(await readFile(variantPath, 'utf8'));
  if (!patches.some((p) => p.hunks.length)) return undefined; // the scaffold stub
  const out = new Map<string, string | null>();
  for (const p of patches) {
    const original = p.oldFile ? await readFile(path.join(pristineDir, p.oldFile), 'utf8').catch(() => undefined) : '';
    const result = original === undefined ? false : applyFilePatch(original, p);
    if (result === false) return undefined;
    if (p.oldFile && p.newFile !== p.oldFile) out.set(p.oldFile, null);
    if (p.newFile) out.set(p.newFile, result);
  }
  return out;
}

/** The installed copy's changes against pristine `version`, as a patch. Throws if there are none. */
export async function captureInstalledChanges(ctx: GraftContext, version: string): Promise<string> {
  const { project, graft } = ctx;
  const pkg = graft.frontmatter.rootstock.package;
  const ecosystem = graft.frontmatter.rootstock.ecosystem;
  const upstream = project.upstreamFor(graft);
  const installed = await upstream.installed(pkg);
  if (!installed)
    throw new GraftError(
      `${pkg} is not installed; install it and edit the installed copy first${ecosystem === 'npm' ? ' (node_modules)' : ''}`,
      'capture/not-installed',
    );
  if (installed.version !== version) {
    throw new GraftError(
      `installed ${pkg} is ${installed.version}, not ${version}; capture works on the installed copy`,
      'capture/version',
    );
  }
  if (installed.pnp) {
    throw new GraftError(`${pkg} is installed through Plug'n'Play (read-only zip); capture needs a node_modules install`, 'capture/pnp');
  }
  const pristineDir = await upstream.resolve(pkg, version);
  if (ecosystem === 'go' && path.resolve(installed.dir) === path.resolve(pristineDir)) {
    throw new GraftError(
      `${pkg}@${version} resolves to the module cache, which is read-only and pristine; edit a replacement instead: ` +
        `\`graft apply\` vendors the module (the replace in go.mod points at .grafts/.vendor/), or copy it and point a \`replace\` at the copy. Edit that, then capture`,
      'capture/read-only',
    );
  }
  const { before, after } =
    ecosystem === 'pypi'
      ? await wheelFiles(pristineDir, installed.dir)
      : { before: await packageFiles(pristineDir), after: await packageFiles(installed.dir) };
  const files = [...new Set([...before, ...after])].sort();
  const parts: string[] = [];
  const binary: string[] = [];
  for (const file of files) {
    const a = before.includes(file) ? await readFile(path.join(pristineDir, file)) : undefined;
    const b = after.includes(file) ? await readFile(path.join(installed.dir, file)) : undefined;
    if (a && b && a.equals(b)) continue;
    if ((a && isBinary(a)) || (b && isBinary(b))) {
      binary.push(file);
      continue;
    }
    const [oldText, newText] = [a?.toString('utf8') ?? '', b?.toString('utf8') ?? ''];
    if (ecosystem === 'npm' && file === 'package.json' && a && b && samePackageJson(oldText, newText)) continue;
    const patch = createTwoFilesPatch(a ? `a/${file}` : '/dev/null', b ? `b/${file}` : '/dev/null', oldText, newText, '', '', {
      context: 3,
    });
    // createTwoFilesPatch starts with a "====" separator line; git-style headers name the file.
    parts.push(`diff --git a/${file} b/${file}\n${patch.replace(/^=+\n/, '')}`);
  }
  if (binary.length) {
    throw new GraftError(
      `binary files differ from pristine ${pkg}@${version}: ${binary.join(', ')}; a patch variant can't carry them (use the fork mechanism)`,
      'capture/binary',
    );
  }
  if (!parts.length) {
    throw new GraftError(
      `the installed ${pkg}@${version} is identical to the published package; make your change in ${installed.dir} first`,
      'capture/no-changes',
    );
  }
  const content = parts.join('');

  // An installed copy that is exactly pristine + the selected variant holds no new change: capturing
  // it would register a duplicate of that variant (and block the next capture at this version).
  const selected = project.selectVariant(graft, version);
  if (selected && existsSync(selected.path)) {
    const expected = await variantResult(pristineDir, selected.path).catch(() => undefined);
    if (expected) {
      let same = true;
      for (const file of files) {
        const want = expected.has(file)
          ? expected.get(file)
          : before.includes(file)
            ? await readFile(path.join(pristineDir, file), 'utf8')
            : null;
        const have = after.includes(file) ? await readFile(path.join(installed.dir, file), 'utf8') : null;
        if (want !== have) {
          same = false;
          break;
        }
      }
      if (same) {
        throw new GraftError(
          `the installed ${pkg}@${version} is exactly the published package + ${selected.module}, so there is no new change to capture; edit ${installed.dir} first`,
          'capture/no-changes',
        );
      }
    }
  }

  // The captured patch must reproduce the installed copy exactly from pristine.
  for (const p of parsePatchFile(content)) {
    const file = patchTarget(p);
    const original = p.oldFile ? await readFile(path.join(pristineDir, file), 'utf8') : '';
    const result = applyFilePatch(original, p);
    const expected = p.newFile ? await readFile(path.join(installed.dir, p.newFile), 'utf8') : '';
    if (result === false || (p.newFile !== null && result !== expected)) {
      throw new GraftError(`internal: the captured patch does not reproduce ${file}; please report this`, 'capture/roundtrip');
    }
  }
  return content;
}
