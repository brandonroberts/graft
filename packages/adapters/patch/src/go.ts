// The go-replace applier: pristine module + the selected variant, committed as
// .grafts/.vendor/<module with / as +>-<version>/ (no `@`: go.work would read it as a version), and wired in with a version-qualified replace in
// the main module's go.mod (or go.work, in a workspace):
//
//   replace <module> <version> => ./.grafts/.vendor/<module>@<version>
//
// Version-qualified, so after a bump it stops applying and the check says so, instead of silently
// applying an old variant to new code. The go command's silent failure is exactly that: a replace
// for a version that isn't selected is ignored and `go build` exits 0. So problems() fails unless
// `go list -m` shows the replacement directory in use, and checks vendor/modules.txt when the
// project vendors.
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { goListModule, goModuleDir, goVersion, GraftError, posixPath, tool, type Project } from '@graftsync/core';
import type { ApplierContext, PatchApplier } from './appliers.js';
import { otherVendoredDirs, patchedDirProblems, writePatchedDir } from './vendor-dir.js';

const need = (ctx: ApplierContext | undefined) => {
  if (!ctx?.project || !ctx.upstream)
    throw new GraftError('the go-replace applier needs the project and its upstream source', 'applier/context');
  return { project: ctx.project, upstream: ctx.upstream };
};

const escaped = (mod: string) => mod.replaceAll('/', '+');
export const goVendorDir = (project: Project, mod: string, version: string) =>
  path.join(project.graftsDir, '.vendor', `${escaped(mod)}-${goVersion(version)}`);

interface Replace {
  Old: { Path: string; Version?: string };
  New: { Path: string; Version?: string };
}

/** Where replaces live: go.work in a workspace, else the main module's go.mod. */
async function replaceFile(moduleDir: string): Promise<{ kind: 'mod' | 'work'; file: string }> {
  if (!existsSync(path.join(moduleDir, 'go.mod')))
    throw new GraftError(`no go.mod in ${moduleDir} (set ecosystems.go.module)`, 'go/module');
  const { stdout } = await tool('go', ['env', 'GOWORK'], { cwd: moduleDir, code: 'go/env' });
  const work = stdout.trim();
  return work && work !== 'off' ? { kind: 'work', file: work } : { kind: 'mod', file: path.join(moduleDir, 'go.mod') };
}

async function readReplaces(target: { kind: 'mod' | 'work'; file: string }): Promise<Replace[]> {
  const { stdout } = await tool('go', [target.kind, 'edit', '-json', target.file], { cwd: path.dirname(target.file), code: 'go/edit' });
  return (JSON.parse(stdout) as { Replace?: Replace[] | null }).Replace ?? [];
}

const relFrom = (dir: string, dest: string) => {
  const rel = posixPath(path.relative(dir, dest));
  return rel.startsWith('../') ? rel : `./${rel}`;
};

export const goReplaceApplier: PatchApplier = {
  name: 'go-replace',
  async problems(_root, mod, version, variantPath, ctx) {
    const { project, upstream } = need(ctx);
    const v = goVersion(version);
    const moduleDir = goModuleDir(project);
    const target = await replaceFile(moduleDir);
    const dest = goVendorDir(project, mod, v);
    const rel = relFrom(path.dirname(target.file), dest);
    const problems = await patchedDirProblems(await upstream.resolve(mod, v), variantPath, dest, rel);
    if (existsSync(dest) && !existsSync(path.join(dest, 'go.mod')))
      problems.push(`${rel} has no go.mod; the go command refuses a replacement directory without one`);

    const where = path.basename(target.file);
    const replaces = (await readReplaces(target)).filter((r) => r.Old.Path === mod);
    const ours = replaces.find((r) => r.Old.Version === v);
    if (!ours) problems.push(`${where} has no \`replace ${mod} ${v} => ${rel}\``);
    else if (path.resolve(path.dirname(target.file), ours.New.Path) !== dest)
      problems.push(`${where} replaces ${mod} ${v} with ${ours.New.Path}, not ${rel}`);
    for (const r of replaces.filter((r) => r !== ours)) {
      problems.push(
        r.Old.Version
          ? `${where} also replaces ${mod} ${r.Old.Version} (another version); remove it`
          : `${where} replaces every version of ${mod} (${r.New.Path}); graft manages ${mod} with a version-qualified replace — remove it`,
      );
    }

    const used = await goListModule(moduleDir, mod);
    if (!used?.Replace?.Dir || path.resolve(moduleDir, used.Replace.Dir) !== dest || used.Version !== v) {
      problems.push(
        `the go command uses ${mod} ${used?.Version ?? '(none)'} from ${used?.Replace?.Dir ?? used?.Dir ?? 'nowhere'}, not the patched ${v} in ${rel} (a replace for a version that isn't selected is ignored silently)`,
      );
    }
    const modulesTxt = path.join(moduleDir, 'vendor', 'modules.txt');
    if (existsSync(modulesTxt) && !(await readFile(modulesTxt, 'utf8')).includes(`# ${mod} ${v} => ${relFrom(moduleDir, dest)}`)) {
      problems.push(`vendor/modules.txt does not vendor the patched ${mod} ${v}; run \`go mod vendor\``);
    }
    for (const d of await otherVendoredDirs(path.dirname(dest), `${escaped(mod)}-`, path.basename(dest))) {
      problems.push(`${relFrom(path.dirname(target.file), path.join(path.dirname(dest), d))} is for another version of ${mod}; remove it`);
    }
    return problems;
  },
  async configure(_root, mod, version, variantPath, ctx) {
    const { project, upstream } = need(ctx);
    const v = goVersion(version);
    const target = await replaceFile(goModuleDir(project));
    const dest = goVendorDir(project, mod, v);
    await writePatchedDir(await upstream.resolve(mod, v), variantPath, dest);
    if (!existsSync(path.join(dest, 'go.mod'))) {
      throw new GraftError(`${mod}@${v} has no go.mod, and the go command refuses a replacement directory without one`, 'go/no-go-mod');
    }
    for (const d of await otherVendoredDirs(path.dirname(dest), `${escaped(mod)}-`, path.basename(dest))) {
      await rm(path.join(path.dirname(dest), d), { recursive: true, force: true });
    }
    const drops = (await readReplaces(target))
      .filter((r) => r.Old.Path === mod)
      .map((r) => `-dropreplace=${r.Old.Version ? `${mod}@${r.Old.Version}` : mod}`);
    const args = [target.kind, 'edit', ...drops, `-replace=${mod}@${v}=${relFrom(path.dirname(target.file), dest)}`, target.file];
    await tool('go', args, { cwd: path.dirname(target.file), code: 'go/edit' });
    // No bare reinstall: for a new version the require must move too, which `go get` (the
    // ecosystem's targeted install) does, and the version-qualified replace then applies.
    return { files: [dest, target.file] };
  },
};
