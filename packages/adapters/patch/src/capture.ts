// `graft capture` for the patch mechanism: the difference between the installed copy of a package
// (edited by hand or by an agent) and the pristine published contents of that version, as a
// package-relative git-style patch: the same format the variants use.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { GraftError, type GraftContext } from '@graftsync/core';
import { applyFilePatch, parsePatchFile, patchTarget } from './patchfile.js';

/** Files of a package directory, relative and sorted; nested `node_modules` are not the package. */
async function packageFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') out.push(...(await packageFiles(dir, child)));
    } else if (e.isFile()) out.push(child);
  }
  return out.sort();
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

/** The installed copy's changes against pristine `version`, as a patch. Throws if there are none. */
export async function captureInstalledChanges(ctx: GraftContext, version: string): Promise<string> {
  const { project, graft } = ctx;
  const pkg = graft.frontmatter.rootstock.package;
  const ecosystem = graft.frontmatter.rootstock.ecosystem;
  if (ecosystem !== 'npm' && ecosystem !== 'cargo') {
    throw new GraftError(
      `graft capture works on an editable installed copy (npm's node_modules, cargo's registry sources); ${ecosystem} has none — write the patch against the pristine package instead`,
      'capture/unsupported',
    );
  }
  const upstream = project.upstreamFor(graft);
  const installed = await upstream.installed(pkg);
  if (!installed)
    throw new GraftError(`${pkg} is not installed; install it and make your change in node_modules first`, 'capture/not-installed');
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
  const [before, after] = [await packageFiles(pristineDir), await packageFiles(installed.dir)];
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
    if (file === 'package.json' && a && b && samePackageJson(oldText, newText)) continue;
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
