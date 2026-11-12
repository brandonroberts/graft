// The wheel-vendor applier: pristine wheel + the selected variant, repacked (RECORD regenerated)
// as .grafts/.vendor/<the published wheel's filename>, and the project pointed at it:
//
//   uv    pyproject.toml  [tool.uv.sources] <name> = { path = ".grafts/.vendor/<wheel>" }
//         (uv applies sources to direct dependencies only); uv.lock pins the wheel's hash
//   pip   the requirements file's line for the package becomes ./.grafts/.vendor/<wheel>
//
// The version stays the published one (a +local label would be a different version to resolvers).
// Silent failures: pip keeps an installed copy of the same name and version ("already satisfied")
// even when the wheel changed, and exits 0; uv refuses a changed wheel loudly (hash mismatch) but
// keeps the old hash on a plain `uv lock`. So reinstall forces the wheels in, and Graft's own
// installed-files check (pristine + variant) is the backstop either way.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  detectPythonTool,
  GraftError,
  posixPath,
  pypiName,
  pypiOptions,
  readZip,
  wheelDistName,
  writeZip,
  type Project,
  type PypiUpstreamSource,
  type ZipEntry,
} from '@graftsync/core';
import type { ApplierContext, PatchApplier } from './appliers.js';
import { getTomlTableBody, getTomlValue, inlineTableString, setTomlValue } from './toml.js';
import { buildPatchedDir, treeFiles } from './vendor-dir.js';

const need = (ctx: ApplierContext | undefined) => {
  if (!ctx?.project || !ctx.upstream)
    throw new GraftError('the wheel-vendor applier needs the project and its upstream source', 'applier/context');
  if (!('wheelName' in ctx.upstream)) throw new GraftError('the wheel-vendor applier needs the PyPI upstream source', 'applier/context');
  return { project: ctx.project, upstream: ctx.upstream as PypiUpstreamSource };
};

const vendorDir = (project: Project) => path.join(project.graftsDir, '.vendor');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();
const recordHash = (b: Buffer) => `sha256=${sha256(b).toString('base64url')}`;

/** Pristine wheel + variant, as wheel bytes (RECORD regenerated, deterministic). */
export async function buildPatchedWheel(pristineDir: string, variantPath: string): Promise<Buffer> {
  const built = await buildPatchedDir(pristineDir, variantPath);
  try {
    const files = await treeFiles(built.dir);
    const record = files.find((f) => /^[^/]+\.dist-info\/RECORD$/.test(f));
    if (!record) throw new Error('the wheel has no .dist-info/RECORD');
    const distInfo = record.slice(0, -'RECORD'.length);
    // .dist-info last, RECORD last of all (the wheel spec's recommended order).
    const order = [...files.filter((f) => !f.startsWith(distInfo)), ...files.filter((f) => f.startsWith(distInfo) && f !== record)];
    const entries: ZipEntry[] = [];
    const rows: string[] = [];
    for (const f of order) {
      const data = await readFile(path.join(built.dir, f));
      const mode = (await stat(path.join(built.dir, f))).mode & 0o777;
      entries.push({ name: f, data, mode: mode & 0o111 ? 0o755 : 0o644 });
      rows.push(`${f.includes(',') ? JSON.stringify(f) : f},${recordHash(data)},${data.length}`);
    }
    rows.push(`${record},,`);
    entries.push({ name: record, data: Buffer.from(`${rows.join('\n')}\n`) });
    return writeZip(entries);
  } finally {
    await rm(built.tmp, { recursive: true, force: true });
  }
}

/** Do two wheels hold the same files with the same bytes? */
function sameWheel(a: Buffer, b: Buffer): boolean {
  const [x, y] = [readZip(a), readZip(b)];
  const map = new Map(y.map((e) => [e.name, e.data]));
  return x.length === y.length && x.every((e) => map.get(e.name)?.equals(e.data));
}

/** Other versions' vendored wheels of the same project. */
async function otherWheels(project: Project, pkg: string, keep: string): Promise<string[]> {
  const dir = vendorDir(project);
  if (!existsSync(dir)) return [];
  const prefix = `${wheelDistName(pkg)}-`;
  return (await readdir(dir)).filter((f) => f.endsWith('.whl') && f !== keep && f.toLowerCase().startsWith(prefix.toLowerCase()));
}

// --- pip: requirements files --------------------------------------------------------------------

const REQ_NAME = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@ ]|$)/;

/** Does a requirements line install `pkg` (by name, or as one of its wheels)? */
function requirementIsFor(line: string, pkg: string): boolean {
  const t = line.replace(/\s+#.*$/, '').trim();
  if (!t || t.startsWith('#') || t.startsWith('-')) return false;
  if (t.endsWith('.whl'))
    return path
      .basename(t)
      .toLowerCase()
      .startsWith(`${wheelDistName(pkg).toLowerCase()}-`);
  const m = REQ_NAME.exec(t);
  return !!m && pypiName(m[1]!) === pypiName(pkg);
}

function requirementsFile(project: Project): string {
  return path.resolve(project.root, pypiOptions(project).requirements ?? 'requirements.txt');
}

// --- uv: pyproject.toml and uv.lock -------------------------------------------------------------

/** Is `pkg` among [project] dependencies (where uv applies tool.uv.sources)? */
function isDirectDependency(pyproject: string, pkg: string): boolean {
  const body = getTomlTableBody(pyproject, 'project') ?? '';
  const start = body.search(/^\s*dependencies\s*=\s*\[/m);
  if (start < 0) return false;
  const list = body.slice(start, body.indexOf(']', body.indexOf('[', start)) + 1);
  return [...list.matchAll(/["']([^"']+)["']/g)].some((m) => {
    const name = REQ_NAME.exec(m[1]!)?.[1];
    return !!name && pypiName(name) === pypiName(pkg);
  });
}

/** uv.lock's entry for `pkg`: its source path and wheel hash. */
function uvLockEntry(lock: string, pkg: string): { path?: string; hash?: string; version?: string } | undefined {
  for (const block of lock.split(/^\[\[package\]\]$/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    if (!name || pypiName(name) !== pypiName(pkg)) continue;
    return {
      version: /^version = "([^"]+)"/m.exec(block)?.[1],
      path: /^source = \{ path = "([^"]+)" \}/m.exec(block)?.[1],
      hash: /hash = "sha256:([0-9a-f]+)"/.exec(block)?.[1],
    };
  }
  return undefined;
}

export const wheelVendorApplier: PatchApplier = {
  name: 'wheel-vendor',
  async problems(_root, pkg, version, variantPath, ctx) {
    const { project, upstream } = need(ctx);
    const problems: string[] = [];
    const wheelName = await upstream.wheelName(pkg, version);
    const wheel = path.join(vendorDir(project), wheelName);
    const rel = posixPath(path.relative(project.root, wheel));
    if (!existsSync(wheel)) problems.push(`${rel} is missing; run \`graft apply\``);
    else {
      const fresh = await buildPatchedWheel(await upstream.resolve(pkg, version), variantPath).catch((err: Error) => err);
      if (fresh instanceof Error) problems.push(fresh.message);
      else if (!sameWheel(fresh, await readFile(wheel)))
        problems.push(
          `${rel} is stale (it is not the pristine wheel + ${posixPath(path.relative(project.root, variantPath))}); run \`graft apply\``,
        );
    }
    for (const f of await otherWheels(project, pkg, wheelName))
      problems.push(`.grafts/.vendor/${f} is for another version of ${pkg}; remove it`);

    const which = detectPythonTool(project.root);
    if (which === 'poetry') problems.push('the wheel-vendor applier supports uv and pip projects; poetry is not supported yet');
    if (which === 'uv') {
      const pyproject = await readFile(path.join(project.root, 'pyproject.toml'), 'utf8');
      const declared = inlineTableString(getTomlValue(pyproject, 'tool.uv.sources', pkg), 'path');
      if (!isDirectDependency(pyproject, pkg))
        problems.push(`${pkg} is not in [project] dependencies; uv applies [tool.uv.sources] to direct dependencies only`);
      if (!declared) problems.push(`pyproject.toml has no [tool.uv.sources] entry for ${pkg} (expected ${pkg} = { path = "${rel}" })`);
      else if (path.resolve(project.root, declared) !== wheel)
        problems.push(`pyproject.toml [tool.uv.sources] ${pkg} points to ${declared}, not ${rel}`);
      const lock = existsSync(path.join(project.root, 'uv.lock'))
        ? uvLockEntry(await readFile(path.join(project.root, 'uv.lock'), 'utf8'), pkg)
        : undefined;
      if (!lock?.path || path.resolve(project.root, lock.path) !== wheel)
        problems.push(`uv.lock does not lock ${pkg} to ${rel}; run \`graft apply\``);
      else if (existsSync(wheel) && lock.hash !== sha256(await readFile(wheel)).toString('hex')) {
        problems.push(`uv.lock pins another build of ${rel} (hash mismatch; \`uv sync\` would fail); run \`graft apply\``);
      }
    }
    if (which === 'pip') {
      const file = requirementsFile(project);
      const lines = existsSync(file) ? (await readFile(file, 'utf8')).split('\n') : [];
      const expected = posixPath(path.relative(path.dirname(file), wheel));
      const ours = lines.filter((l) => requirementIsFor(l, pkg));
      const target = (l: string) => path.resolve(path.dirname(file), l.replace(/\s+#.*$/, '').trim());
      if (!ours.some((l) => target(l) === wheel)) {
        problems.push(
          `${path.basename(file)} must install ${pkg} from ./${expected}${ours.length ? ` (it has: ${ours.map((l) => l.trim()).join(', ')})` : ''}`,
        );
      }
      for (const l of ours.filter((l) => target(l) !== wheel)) {
        if (ours.some((o) => target(o) === wheel))
          problems.push(`${path.basename(file)} also installs ${pkg} as \`${l.trim()}\`; remove it`);
      }
    }
    return problems;
  },
  async configure(_root, pkg, version, variantPath, ctx) {
    const { project, upstream } = need(ctx);
    const which = detectPythonTool(project.root);
    if (which === 'poetry')
      throw new GraftError('the wheel-vendor applier supports uv and pip projects; poetry is not supported yet', 'applier/unsupported');
    const wheelName = await upstream.wheelName(pkg, version);
    const wheel = path.join(vendorDir(project), wheelName);
    const built = await buildPatchedWheel(await upstream.resolve(pkg, version), variantPath);
    await mkdir(vendorDir(project), { recursive: true });
    if (!existsSync(wheel) || !sameWheel(built, await readFile(wheel))) await writeFile(wheel, built);
    for (const f of await otherWheels(project, pkg, wheelName)) await rm(path.join(vendorDir(project), f), { force: true });
    const files = [wheel];

    if (which === 'uv') {
      const file = path.join(project.root, 'pyproject.toml');
      const text = await readFile(file, 'utf8');
      if (!isDirectDependency(text, pkg)) {
        throw new GraftError(
          `${pkg} is not in [project] dependencies; uv applies [tool.uv.sources] to direct dependencies only — add it there first`,
          'applier/uv-transitive',
        );
      }
      const rel = posixPath(path.relative(project.root, wheel));
      const next = setTomlValue(text, 'tool.uv.sources', pkg, `{ path = ${JSON.stringify(rel)} }`, 'pyproject.toml');
      if (next !== text) await writeFile(file, next);
      files.push(file);
    } else {
      const file = requirementsFile(project);
      const lines = existsSync(file) ? (await readFile(file, 'utf8')).replace(/\n$/, '').split('\n') : [];
      const line = `./${posixPath(path.relative(path.dirname(file), wheel))}`;
      const at = lines.findIndex((l) => requirementIsFor(l, pkg));
      const kept = lines.filter((l, i) => i === at || !requirementIsFor(l, pkg));
      // Keep the replaced line's trailing comment.
      if (at >= 0) kept[kept.indexOf(lines[at]!)] = `${line}${/\s+#.*$/.exec(lines[at]!)?.[0] ?? ''}`;
      else kept.push(line);
      await writeFile(file, `${kept.filter((l, i) => l || i < kept.length - 1).join('\n')}\n`);
      files.push(file);
    }
    return { files, install: 'reinstall' };
  },
};
