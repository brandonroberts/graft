// The fork mechanism: a graft whose modification lives as commits on a fork of the upstream
// source repository, on top of an upstream release tag.
//
// A variant is a small JSON file `{ "ref": "<fork branch, tag or sha>", "base": "<upstream
// version the commits sit on>" }`. The graft's change is the fork's diff `tag(base)..ref`; every
// hunk is an anchor, located in the upstream *source* at `tag(target)` (fuzz 0). For a version,
// Graft rebases that diff onto the target tag, runs the optional build, packs the package with
// `npm pack`, and installs it through the vendored-tarball override (lockfile-recorded, works
// with every package manager). Graft never pushes to the fork.
//
// Repo mode (`fork.install: none`): the fork is the product itself (a translated docs site, a
// patched tool run from source), not a dependency. Nothing is installed; the graft is
// standalone, and a green sync keeps the rebased checkout as the local branch
// `graft/<id>/<version>` in the cache clone. `base` may then also be any upstream commit or ref,
// since such forks often sit on a commit between releases.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPatch, reversePatch } from 'diff';
import semver from 'semver';
import {
  distinctiveText,
  GraftError,
  rankFilesByContent,
  readInstalledFiles,
  renderPatch,
  runCommand,
  scopeFileDiff,
  updateGraft,
  type AnchorReport,
  type AnchorResult,
  type ApplyResult,
  type Graft,
  type GraftContext,
  type AgentStart,
  type GraftUpdate,
  type MechanismAdapter,
  Project,
  type ResolvedVariant,
  type ScopedDiff,
  type ScopedFileDiff,
  type Workspace,
} from '@graftsync/core';
import type { ForkConfig } from '@graftsync/spec';
import {
  applyToInstalledCopy,
  describeHunk,
  installVendoredTarball,
  locateHunk,
  manifestRoot,
  parsePatchFile,
  patchTarget,
  tarballContents,
  vendoredTarballProblems,
  vendorFileName,
  VENDOR_DIR,
  type FilePatch,
  type TarballBuilder,
  type VendorContext,
} from '@graftsync/adapter-patch';
import { binaryChanges, blobId, checkout, commitTo, diff, ensureRepo, git, mergeToBranch, modeChanges, readBlob, replaceSubtree, upstreamTags, resolveForkRef, resolveTag, resolveUpstreamRef, showFile } from './git.js';

export const MECHANISM = 'fork';

export interface ForkVariant {
  /**
   * Fork branch, fork tag, or commit holding the modification; or `@worktree`: the project's own
   * checkout, uncommitted changes included (repo mode, with the graft living in the fork).
   */
  ref: string;
  /**
   * Upstream version whose tag the modification's commits are based on. In repo mode
   * (`fork.install: none`) it may also be any upstream commit, tag or branch, or `@verified`:
   * the graft's `rootstock.verified` (a version or `version+commit`).
   */
  base: string;
}

/** Variant ref: the project's checkout, working tree included (the graft lives in the fork). */
export const WORKTREE = '@worktree';
/** Variant base: the upstream at `rootstock.verified`. */
export const VERIFIED = '@verified';

function forkConfig(graft: Graft): ForkConfig {
  const cfg = graft.frontmatter.fork;
  if (!cfg) throw new GraftError(`graft "${graft.id}": mechanism "fork" needs a \`fork:\` block ({ repo, upstream, tag })`, 'fork/config');
  return cfg;
}

const tagFor = (cfg: ForkConfig, version: string) => cfg.tag.replaceAll('{version}', version);

/**
 * The upstream commit a target version names through semver build metadata, e.g.
 * `22.3.0-next.3+57905ca4e6` (version 22.3.0-next.3 for variant ranges, at commit 57905ca4e6):
 * repo mode can then sync to any upstream commit, not just release tags.
 */
const commitOf = (version: string): string | undefined => {
  const build = semver.parse(version)?.build ?? [];
  return build.length === 1 && /^[0-9a-f]{7,40}$/i.test(build[0]!) ? build[0] : undefined;
};
/** How a target version is shown: its tag, or the commit it names. */
const targetLabel = (cfg: ForkConfig, version: string) => {
  const sha = commitOf(version);
  return sha ? `commit ${sha}` : tagFor(cfg, version);
};
const inPkg = (cfg: ForkConfig, file: string) => (cfg.dir ? `${cfg.dir.replace(/\/+$/, '')}/${file}` : file);
const repoDir = (project: Project, graft: Graft) => path.join(project.cacheDir, 'fork', graft.id);
const isStandalone = (graft: Graft) => graft.frontmatter.fork?.install === 'none';
const resultBranch = (graft: Graft, version: string) => `graft/${graft.id}/${version}`;

/** A git URL as is; anything else is a local path, resolved against the project root. */
const remoteUrl = (project: Project, url: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/\s]+@[^/\s:]+:/.test(url) ? url : path.resolve(project.root, url);

/**
 * How to adopt a repo-mode result into the fork's branch: as a merge of the upstream commit it
 * sits on (so the fork keeps upstream in its history), with the result's tree.
 */
const adoptHint = (cache: string, branch: string, upstream: string) =>
  `adopt it as a merge of upstream: \`git fetch ${cache} ${branch} && git merge --no-ff --no-commit -s ours --allow-unrelated-histories ${upstream} && git read-tree -u --reset FETCH_HEAD\`, then commit`;

/** True when `fork.repo` is the project's own checkout (`repo: .`): the graft lives in the fork. */
function graftLivesInFork(project: Project, graft: Graft): boolean {
  const url = remoteUrl(project, forkConfig(graft).repo);
  if (!path.isAbsolute(url)) return false;
  try {
    return realpathSync(url) === realpathSync(project.root);
  } catch {
    return false;
  }
}

/** The project's graft files (without caches and reports), relative to the grafts directory. */
async function graftFiles(project: Project): Promise<{ rel: string; abs: string; executable: boolean }[]> {
  const skip = new Set(['.cache', '.report', '.vendor']);
  const out: { rel: string; abs: string; executable: boolean }[] = [];
  const walk = async (dir: string, rel: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!rel && skip.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) out.push({ rel: r, abs, executable: ((await stat(abs)).mode & 0o111) !== 0 });
    }
  };
  await walk(project.graftsDir, '');
  return out;
}

/**
 * `@worktree`: commit the project's working tree (tracked and new files, minus `.grafts/` and
 * ignored files) as an unreferenced snapshot on top of HEAD, without touching the index or
 * HEAD, and fetch it into the cache clone.
 */
async function snapshotWorktree(project: Project, graft: Graft, dir: string): Promise<string> {
  if (!graftLivesInFork(project, graft)) {
    throw new GraftError(`graft "${graft.id}": "${WORKTREE}" needs the graft to live in the fork (fork.repo: ".")`, 'variant/invalid');
  }
  const root = project.root;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'graft-snapshot-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    const head = (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).stdout.trim();
    if (head) await git(root, ['read-tree', head], { env });
    await git(root, ['add', '-A', '--', '.', ':(top,exclude).grafts'], { env });
    const tree = (await git(root, ['write-tree'], { env })).stdout.trim();
    const commit = (
      await git(root, ['-c', 'user.name=graft', '-c', 'user.email=graft@localhost', 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'graft: working tree snapshot'])
    ).stdout.trim();
    const ref = `refs/graft/worktree/${graft.id}`;
    await git(root, ['update-ref', ref, commit]);
    await git(dir, ['fetch', '--quiet', '--force', 'fork', `+${ref}:refs/graft-worktree/${graft.id}`]);
    return commit;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** True when the variant selected for `version` is relative to `rootstock.verified` in the graft's own fork. */
async function relativeToVerified(project: Project, graft: Graft, version: string): Promise<boolean> {
  if (!isStandalone(graft) || !graftLivesInFork(project, graft)) return false;
  const ref = project.selectVariant(graft, version);
  return !!ref && (await loadVariant(graft, ref).catch(() => undefined))?.base === VERIFIED;
}

/**
 * The project's graft files with `update` applied to `graft`'s graft.md, in a scratch copy (the
 * project itself is untouched). The caller disposes the copy.
 */
async function updatedGraftFiles(project: Project, graft: Graft, adapter: MechanismAdapter, update: GraftUpdate | undefined) {
  if (!update) return { files: await graftFiles(project), dispose: async () => {} };
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'graft-copy-'));
  const rel = path.relative(project.root, project.graftsDir);
  for (const f of await graftFiles(project)) {
    const dest = path.join(tmp, rel, f.rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(f.abs, dest);
  }
  const copy = await Project.open({ root: tmp, adapters: [adapter] });
  await updateGraft(copy, graft.id, update);
  return { files: await graftFiles(copy), dispose: () => rm(tmp, { recursive: true, force: true }) };
}

async function fetchRepos(project: Project, graft: Graft): Promise<string> {
  const cfg = forkConfig(graft);
  const dir = repoDir(project, graft);
  await ensureRepo(dir, remoteUrl(project, cfg.repo), remoteUrl(project, cfg.upstream));
  return dir;
}

async function loadVariant(graft: Graft, variant: ResolvedVariant): Promise<ForkVariant> {
  const standalone = isStandalone(graft);
  if (!existsSync(variant.path)) throw new GraftError(`graft "${graft.id}": variant ${variant.module} not found`, 'variant/not-found');
  let v: Partial<ForkVariant>;
  try {
    v = JSON.parse(await readFile(variant.path, 'utf8')) as Partial<ForkVariant>;
  } catch (err) {
    throw new GraftError(`graft "${graft.id}": ${variant.module} is not valid JSON: ${(err as Error).message}`, 'variant/invalid');
  }
  if (typeof v.ref !== 'string' || !v.ref || v.ref === 'TODO') {
    throw new GraftError(`graft "${graft.id}": ${variant.module} must name the fork ref holding the modification ("ref")`, 'variant/invalid');
  }
  if (!standalone && (v.ref === WORKTREE || v.base === VERIFIED)) {
    throw new GraftError(`graft "${graft.id}": ${variant.module}: "${WORKTREE}" and "${VERIFIED}" are for repo mode (fork.install: none)`, 'variant/invalid');
  }
  if (typeof v.base !== 'string' || !v.base || v.base === 'TODO' || (!standalone && !semver.valid(v.base))) {
    throw new GraftError(
      `graft "${graft.id}": ${variant.module} must give "base", the upstream version${standalone ? ' (or commit)' : ''} the fork's commits sit on`,
      'variant/invalid',
    );
  }
  return { ref: v.ref, base: v.base };
}

async function upstreamRev(dir: string, cfg: ForkConfig, version: string): Promise<string> {
  const sha = commitOf(version);
  if (sha) {
    const rev = await resolveUpstreamRef(dir, sha);
    if (!rev) throw new GraftError(`upstream commit ${sha} (from version ${version}) not found in ${cfg.upstream}`, 'fork/no-commit');
    return rev;
  }
  const tag = tagFor(cfg, version);
  const rev = await resolveTag(dir, tag);
  if (!rev) {
    throw new GraftError(
      `upstream tag "${tag}" not found in ${cfg.upstream} for version ${version}` +
        (cfg.tag === 'v{version}' ? ' (if upstream tags releases without a "v", set fork.tag: "{version}")' : ''),
      'fork/no-tag',
    );
  }
  return rev;
}

/** A binary file the fork changes; it carries over only where upstream left the file as it was at base. */
interface BinaryChange {
  file: string;
  /** Blob at the base (undefined: the fork creates it). */
  baseOid?: string;
  /** Blob at the fork ref (undefined: the fork deletes it). */
  refOid?: string;
}

interface ForkChange {
  variant: ForkVariant;
  patches: FilePatch[];
  binaries: BinaryChange[];
  /** Executable bits the fork sets or clears. */
  modes: { file: string; executable: boolean }[];
  refRev: string;
  /** The base as shown to people: its tag, or the commit/ref given. */
  baseTag: string;
}

/** The upstream commit a variant's base names: a version's tag, or (repo mode) any upstream ref. */
async function baseRevision(dir: string, graft: Graft, base: string): Promise<{ rev: string; label: string }> {
  const cfg = forkConfig(graft);
  if (base === VERIFIED) {
    const verified = graft.frontmatter.rootstock.verified;
    return { rev: await upstreamRev(dir, cfg, verified), label: `${targetLabel(cfg, verified)} (verified)` };
  }
  if (semver.valid(base) && (!isStandalone(graft) || (await resolveTag(dir, tagFor(cfg, base))))) {
    return { rev: await upstreamRev(dir, cfg, base), label: tagFor(cfg, base) };
  }
  const rev = await resolveUpstreamRef(dir, base);
  if (!rev) throw new GraftError(`graft "${graft.id}": base "${base}" is neither a tag nor a commit in ${cfg.upstream}`, 'fork/no-base');
  return { rev, label: base };
}

/** The graft's change: the fork's diff from its base tag to its ref, as file patches. */
async function forkChange(project: Project, graft: Graft, ref: ResolvedVariant): Promise<ForkChange> {
  const cfg = forkConfig(graft);
  const variant = await loadVariant(graft, ref);
  const dir = await fetchRepos(project, graft);
  const base = await baseRevision(dir, graft, variant.base);
  const refRev = variant.ref === WORKTREE ? await snapshotWorktree(project, graft, dir) : await resolveForkRef(dir, variant.ref);
  if (!refRev) throw new GraftError(`graft "${graft.id}": fork ref "${variant.ref}" not found in ${cfg.repo}`, 'fork/no-ref');
  const binaryFiles = new Set(await binaryChanges(dir, base.rev, refRev, cfg.dir));
  const patches = parsePatchFile(await diff(dir, base.rev, refRev, cfg.dir)).filter(
    (p) => !binaryFiles.has(patchTarget(p)) && (p.hunks.length > 0 || p.oldFile === null || p.newFile === null),
  );
  const binaries: BinaryChange[] = [];
  for (const file of binaryFiles) {
    binaries.push({ file, baseOid: await blobId(dir, base.rev, inPkg(cfg, file)), refOid: await blobId(dir, refRev, inPkg(cfg, file)) });
  }
  const modes = await modeChanges(dir, base.rev, refRev, cfg.dir);
  if (!patches.length && !binaries.length && !modes.length) {
    throw new GraftError(`graft "${graft.id}": fork ref "${variant.ref}" has no changes on top of ${base.label}; a graft must never apply nothing`, 'fork/empty');
  }
  return { variant, patches, binaries, modes, refRev, baseTag: base.label };
}

/** Rebase the fork's change onto the target tag in a fresh checkout (the caller disposes it). */
async function materialize(project: Project, graft: Graft, version: string, change: ForkChange) {
  const cfg = forkConfig(graft);
  const dir = repoDir(project, graft);
  const targetRev = await upstreamRev(dir, cfg, version);
  const co = await checkout(dir, targetRev);
  const pkgDir = cfg.dir ? path.join(co.path, cfg.dir) : co.path;
  const fail = async (reason: string): Promise<never> => {
    await co.dispose();
    throw new GraftError(
      `graft "${graft.id}": the fork's change (${change.variant.ref} on ${change.baseTag}) does not rebase onto ${targetLabel(cfg, version)}: ${reason}`,
      'fork/rebase',
    );
  };
  const files: string[] = [];
  if (change.patches.length) {
    const r = await applyToInstalledCopy({ dir: pkgDir, version }, change.patches);
    if (r.action !== 'patched') await fail(r.reason ?? r.action);
    files.push(...r.files);
  }
  for (const b of change.binaries) {
    if ((await blobId(dir, targetRev, inPkg(cfg, b.file))) !== b.baseOid) await fail(`${b.file}: binary file changed upstream since the base`);
    const dest = path.join(pkgDir, b.file);
    if (b.refOid) {
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, await readBlob(dir, change.refRev, inPkg(cfg, b.file)));
    } else {
      await rm(dest, { force: true });
    }
    files.push(b.file);
  }
  for (const m of change.modes) {
    const file = path.join(pkgDir, m.file);
    if (!existsSync(file)) continue;
    const mode = (await stat(file)).mode;
    await chmod(file, m.executable ? mode | 0o111 : mode & ~0o111);
    if (!files.includes(m.file)) files.push(m.file);
  }
  return { root: co.path, pkgDir, files, targetRev, dispose: co.dispose };
}

/** A builder that rebases, builds and packs the fork for `version` into a temp dir. */
function tarballBuilder(project: Project, graft: Graft, version: string, change: ForkChange): TarballBuilder {
  return async () => {
    const cfg = forkConfig(graft);
    const tree = await materialize(project, graft, version, change);
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'graft-fork-pack-'));
    try {
      if (cfg.build) {
        const b = await runCommand(cfg.build, { cwd: tree.pkgDir, timeoutMs: (cfg.timeout ?? 1800) * 1000 });
        if (!b.passed) throw new GraftError(`graft "${graft.id}": fork build \`${cfg.build}\` failed (exit ${b.exitCode}):\n${b.output.slice(-3000)}`, 'fork/build');
      }
      // Scripts are not run: `fork.build` is where building happens, explicitly.
      const pack = await runCommand(`npm pack --ignore-scripts --json --pack-destination '${tmp.replaceAll("'", "'\\''")}'`, { cwd: tree.pkgDir, timeoutMs: 10 * 60_000, maxOutput: 2_000_000 });
      if (!pack.passed) throw new GraftError(`graft "${graft.id}": npm pack failed:\n${pack.output.slice(-3000)}`, 'fork/pack');
      const json = pack.output.slice(pack.output.indexOf('['));
      const [info] = JSON.parse(json) as { filename: string; name: string; version: string }[];
      if (!info) throw new GraftError(`graft "${graft.id}": npm pack printed no package`, 'fork/pack');
      const pkg = graft.frontmatter.rootstock.package;
      if (info.name !== pkg || info.version !== version) {
        throw new GraftError(
          `graft "${graft.id}": ${tagFor(cfg, version)} packs as ${info.name}@${info.version}, not ${pkg}@${version}; check fork.tag and fork.dir`,
          'fork/pack-mismatch',
        );
      }
      return { file: path.join(tmp, info.filename.replace(/^@/, '').replace('/', '-')), tmp };
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    } finally {
      await tree.dispose();
    }
  };
}

const vendorContext = (project: Project): VendorContext => ({ graftRoot: project.root, installRoot: manifestRoot(project.root) });

/**
 * A hunk whose change is the very first or last line of the file at the base (no context on
 * that side) gives no evidence about lines upstream has since added there: they sit right
 * against the change (e.g. the fork rewrote a whole page and upstream appended a section).
 * git's merge treats such touching edits as a conflict; so does this. Returns where the new
 * lines are, or undefined.
 */
function touchesNewUpstreamLines(content: string, hunk: FilePatch['hunks'][number], line: number): 'before' | 'after' | undefined {
  const body = hunk.lines.filter((l) => l[0] !== '\\');
  if (!body.some((l) => l[0] !== ' ')) return undefined;
  if (body[0]![0] !== ' ' && hunk.oldStart <= 1 && line > 1) return 'before';
  const oldLen = body.filter((l) => l[0] === ' ' || l[0] === '-').length;
  const total = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  if (body.at(-1)![0] !== ' ' && line + oldLen - 1 < total) return 'after';
  return undefined;
}

/** Anchors for one file patch against the target tag's source. */
function hunkAnchors(patch: FilePatch, content: string | undefined): AnchorResult[] {
  const file = patchTarget(patch);
  if (patch.oldFile === null) {
    return [{ name: `${file}#create`, file, description: `creates ${file}`, matched: content === undefined, error: content === undefined ? undefined : 'file already exists upstream' }];
  }
  return patch.hunks.map((hunk, i) => {
    const base = { name: `${file}#${i + 1}`, file, description: describeHunk(hunk) };
    if (content === undefined) return { ...base, matched: false, error: 'file missing upstream' };
    const m = locateHunk(content, hunk);
    if (!m.occurrences) return { ...base, matched: false, error: 'context or removed lines not found' };
    const edge = touchesNewUpstreamLines(content, hunk, m.line!);
    if (edge) return { ...base, matched: false, error: `upstream added lines right ${edge} the change`, location: { line: m.line!, column: 1, start: 0, end: 0 } };
    return { ...base, matched: true, location: { line: m.line!, column: 1, start: 0, end: 0 } };
  });
}

export function createForkAdapter(): MechanismAdapter {
  const adapter: MechanismAdapter = {
    name: MECHANISM,
    variantExtension: '.json',
    exclusivePerPackage: true,

    async checkAnchors(ctx: GraftContext, version: string): Promise<AnchorReport> {
      const { project, graft } = ctx;
      const pkg = graft.frontmatter.rootstock.package;
      const report: AnchorReport = { graft: graft.id, package: pkg, version, variant: null, anchors: [], errors: [], ok: false };
      report.variant = project.selectVariant(graft, version);
      if (!report.variant) {
        report.errors.push(`no variant covers ${pkg}@${version}`);
        return report;
      }
      let change: ForkChange;
      let targetRev: string;
      try {
        change = await forkChange(project, graft, report.variant);
        targetRev = await upstreamRev(repoDir(project, graft), forkConfig(graft), version);
      } catch (err) {
        report.errors.push((err as Error).message);
        return report;
      }
      const cfg = forkConfig(graft);
      const evidence: string[] = [];
      let absorbed = true;
      for (const p of change.patches) {
        const file = patchTarget(p);
        const content = await showFile(repoDir(project, graft), targetRev, inPkg(cfg, file));
        const anchors = hunkAnchors(p, content);
        report.anchors.push(...anchors);
        if (content !== undefined && p.oldFile && anchors.every((a) => a.matched) && applyPatch(content, p.raw, { fuzzFactor: 0 }) === false) {
          report.errors.push(`${file}: hunks match individually but the change does not apply as a whole`);
        }
        // Upstream already contains this file's change?
        if (p.oldFile === null) absorbed &&= content !== undefined && applyPatch('', p.raw, { fuzzFactor: 0 }) === content;
        else if (p.newFile === null) absorbed &&= content === undefined;
        else absorbed &&= content !== undefined && applyPatch(content, reversePatch(p.raw), { fuzzFactor: 0 }) !== false;
        if (absorbed) evidence.push(`${file}: upstream ${targetLabel(cfg, version)} already contains the fork's change`);
      }
      for (const b of change.binaries) {
        const oid = await blobId(repoDir(project, graft), targetRev, inPkg(cfg, b.file));
        const matched = oid === b.baseOid;
        report.anchors.push({
          name: `${b.file}#binary`,
          file: b.file,
          description: b.refOid ? (b.baseOid ? `replaces binary ${b.file}` : `creates binary ${b.file}`) : `deletes binary ${b.file}`,
          matched,
          ...(matched ? {} : { error: 'binary file changed upstream since the base' }),
        });
        absorbed &&= oid === b.refOid;
        if (oid === b.refOid) evidence.push(`${b.file}: upstream ${targetLabel(cfg, version)} already has the fork's version`);
      }
      if (absorbed && report.anchors.some((a) => !a.matched)) report.upstreamed = { evidence };

      const installed = isStandalone(graft) ? undefined : await project.upstream.installed(pkg);
      if (installed?.version === version && report.anchors.every((a) => a.matched)) {
        const vctx = vendorContext(project);
        report.errors.push(
          ...(await vendoredTarballProblems(vctx, pkg, version, tarballBuilder(project, graft, version, change), `the fork's ${change.variant.ref} rebased onto ${targetLabel(cfg, version)}`)),
        );
        // Whatever the configuration says, the installed files must be the vendored package's.
        const tarball = path.join(vctx.graftRoot, VENDOR_DIR, vendorFileName(pkg, version));
        if (existsSync(tarball)) {
          const expected = await tarballContents(tarball);
          // package.json is skipped: some package managers rewrite it on install (the version is
          // already checked); every other packed file must be byte-identical.
          const files = [...expected.keys()]
            .filter((k) => k.startsWith('package/') && k !== 'package/package.json')
            .map((k) => k.slice('package/'.length));
          const actual = await readInstalledFiles(installed, files);
          for (const f of files) {
            if (actual[f] !== expected.get(`package/${f}`)!.toString('utf8')) {
              report.errors.push(`installed ${pkg}@${version} ${f} is not the vendored fork build; run \`graft apply\` (or reinstall)`);
            }
          }
        }
      }
      report.ok = report.errors.length === 0 && report.anchors.every((a) => a.matched);
      return report;
    },

    async apply(ctx: GraftContext, options = {}): Promise<ApplyResult> {
      const { project, graft } = ctx;
      const pkg = graft.frontmatter.rootstock.package;
      const version = options.version ?? (await project.currentVersion(graft));
      const result: ApplyResult = { graft: graft.id, version: version ?? '?', variant: null, files: [], errors: [], ok: false };
      if (!version) {
        result.errors.push(`${pkg} is not installed`);
        return result;
      }
      result.variant = project.selectVariant(graft, version);
      if (!result.variant) {
        result.errors.push(`no variant covers ${pkg}@${version}`);
        return result;
      }
      try {
        const change = await forkChange(project, graft, result.variant);
        const tree = await materialize(project, graft, version, change);
        try {
          for (const file of tree.files) {
            const entry: ApplyResult['files'][number] = { file, changed: true };
            if (options.outDir && existsSync(path.join(tree.pkgDir, file))) {
              entry.outputPath = path.join(options.outDir, file);
              await mkdir(path.dirname(entry.outputPath), { recursive: true });
              await cp(path.join(tree.pkgDir, file), entry.outputPath);
            }
            result.files.push(entry);
          }
        } finally {
          await tree.dispose();
        }
      } catch (err) {
        result.errors.push((err as Error).message);
      }
      result.ok = result.errors.length === 0 && result.files.length > 0;
      return result;
    },

    async scopeDiff(ctx: GraftContext, from: string, to: string): Promise<ScopedDiff> {
      const { project, graft } = ctx;
      const cfg = forkConfig(graft);
      const pkg = graft.frontmatter.rootstock.package;
      const dir = await fetchRepos(project, graft);
      const label = (v: string) => `${pkg}@${v} (${targetLabel(cfg, v)})`;
      const fromVariant = project.selectVariant(graft, from);
      const fromChange = fromVariant ? await forkChange(project, graft, fromVariant).catch(() => undefined) : undefined;
      const patches = fromChange?.patches ?? [];
      // Upstream's changes are diffed from the fork's base, which is what the change's hunks are
      // relative to (in repo mode often a commit, not the verified version's tag).
      const fromBase = fromChange ? await baseRevision(dir, graft, fromChange.variant.base) : undefined;
      const fromRev = fromBase?.rev ?? (await upstreamRev(dir, cfg, from));
      const fromLabel = fromBase ? `${pkg} fork base (${fromBase.label})` : label(from);
      const toRev = await upstreamRev(dir, cfg, to);
      const touched = new Set<string>([...(graft.frontmatter.targets ?? []), ...patches.map((p) => p.oldFile).filter((f): f is string => !!f)]);
      const files: ScopedFileDiff[] = [];
      let toTree: Awaited<ReturnType<typeof checkout>> | undefined;
      try {
        for (const file of touched) {
          const [oldText, newText] = [await showFile(dir, fromRev, inPkg(cfg, file)), await showFile(dir, toRev, inPkg(cfg, file))];
          const filePatch = patches.find((p) => p.oldFile === file);
          const regions = (filePatch?.hunks ?? []).map((h, i) => ({
            name: `${file}#${i + 1}`,
            old: [h.oldStart, h.oldStart + Math.max(h.oldLines - 1, 0)] as [number, number],
          }));
          const scoped = scopeFileDiff({ file, oldText, newText, regions, window: 10 });
          if (scoped.status === 'removed' && filePatch?.hunks.length) {
            toTree ??= await checkout(dir, toRev);
            const text = distinctiveText(filePatch.hunks.flatMap((h) => h.lines.filter((l) => l[0] === ' ' || l[0] === '-').map((l) => l.slice(1))));
            const candidates = await rankFilesByContent(cfg.dir ? path.join(toTree.path, cfg.dir) : toTree.path, { ...text });
            if (candidates.length) scoped.candidates = candidates;
          }
          files.push(scoped);
        }
      } finally {
        await toTree?.dispose();
      }
      return { graft: graft.id, package: pkg, from, to, files, patch: renderPatch(files, { from: fromLabel, to: label(to) }) };
    },

    standalone: isStandalone,

    async workspace(ctx: GraftContext, version: string): Promise<Workspace> {
      const { project, graft } = ctx;
      const variant = project.selectVariant(graft, version);
      if (!variant) throw new GraftError(`graft "${graft.id}": no variant covers ${version}`, 'variant/none');
      const change = await forkChange(project, graft, variant);
      const tree = await materialize(project, graft, version, change);
      const branch = resultBranch(graft, version);
      try {
        await commitTo(tree.root, branch, `${graft.id}: ${change.variant.ref} (on ${change.baseTag}) rebased onto ${targetLabel(forkConfig(graft), version)}\n\nMaterialized by graft; not pushed.`);
      } catch (err) {
        await tree.dispose();
        throw err;
      }
      const cache = path.relative(project.root, repoDir(project, graft)) || '.';
      return {
        dir: tree.pkgDir,
        result: `branch \`${branch}\` in ${cache}, on upstream ${tree.targetRev.slice(0, 12)} (${adoptHint(cache, branch, tree.targetRev)})`,
        fetch: { repo: cache, ref: branch, upstream: tree.targetRev },
        dispose: tree.dispose,
      };
    },

    async recordsInResult(ctx: GraftContext, version: string) {
      return relativeToVerified(ctx.project, ctx.graft, version);
    },

    async afterVerified(ctx: GraftContext, version: string, update?: GraftUpdate) {
      // Repo mode with the graft living in the fork: the result carries the graft's own files
      // (with the verification recorded), so adopting it keeps them, and keeps them true.
      const { project, graft } = ctx;
      if (!isStandalone(graft) || !graftLivesInFork(project, graft)) return;
      const dir = repoDir(project, graft);
      const branch = resultBranch(graft, version);
      if (!(await resolveForkRef(dir, `refs/heads/${branch}`))) return;
      const copy = await updatedGraftFiles(project, graft, adapter, update);
      try {
        await replaceSubtree(dir, branch, path.relative(project.root, project.graftsDir).split(path.sep).join('/'), copy.files);
      } finally {
        await copy.dispose();
      }
    },

    async prepareAgent(ctx: GraftContext, version: string): Promise<AgentStart | undefined> {
      const { project, graft } = ctx;
      const variant = project.selectVariant(graft, version) ?? project.selectVariant(graft, graft.frontmatter.rootstock.verified);
      if (!variant) return undefined;
      const change = await forkChange(project, graft, variant);
      const dir = repoDir(project, graft);
      const target = await upstreamRev(dir, forkConfig(graft), version);
      const base = await baseRevision(dir, graft, change.variant.base);
      const branch = `${resultBranch(graft, version)}-agent`;
      const label = targetLabel(forkConfig(graft), version);
      const conflicts = await mergeToBranch(
        dir,
        base.rev,
        target,
        change.refRev,
        branch,
        `${graft.id}: ${change.variant.ref} (on ${change.baseTag}) merged onto ${label} for an agent\n\nPrepared by graft; not pushed.`,
      );
      if (await relativeToVerified(project, graft, version)) {
        // The branch is the fork at the new upstream: its graft.md says so (status conflicted until
        // the agent resolves it), so `graft sync` on it verifies the agent's work in place.
        const copy = await updatedGraftFiles(project, graft, adapter, {
          verified: version,
          status: conflicts.length ? 'conflicted' : graft.frontmatter.status,
          history: `Merged onto ${label} by \`graft sync\`${conflicts.length ? `; conflicts to resolve in ${conflicts.join(', ')}` : ''}.`,
        });
        try {
          await replaceSubtree(dir, branch, path.relative(project.root, project.graftsDir).split(path.sep).join('/'), copy.files);
        } finally {
          await copy.dispose();
        }
      }
      const cache = path.relative(project.root, dir) || '.';
      const where = `branch \`${branch}\` in ${cache} (${adoptHint(cache, branch, target)}): git's merge of the fork's change onto ${label}`;
      return {
        repo: cache,
        ref: branch,
        upstream: target,
        conflicts,
        description: conflicts.length
          ? `${where}, with conflict markers in ${conflicts.length} file(s): ${conflicts.join(', ')}`
          : `${where}; it merges without conflicts, so check the anchors that missed`,
      };
    },

    async newerVersion(ctx: GraftContext) {
      const { project, graft } = ctx;
      if (!isStandalone(graft)) return undefined;
      const cfg = forkConfig(graft);
      const dir = await fetchRepos(project, graft);
      const verified = graft.frontmatter.rootstock.verified;
      const verifiedRev = await upstreamRev(dir, cfg, verified).catch(() => undefined);
      if (cfg.track) {
        // Follow a branch: its tip, labelled with the version in its package.json (else the newest tag).
        const tip = await resolveUpstreamRef(dir, cfg.track);
        if (!tip || tip === verifiedRev) return undefined;
        let version = semver.valid(JSON.parse((await showFile(dir, tip, inPkg(cfg, 'package.json')).catch(() => undefined)) ?? '{}').version ?? '');
        version ??= (await upstreamTags(dir, cfg.tag)).at(-1) ?? semver.parse(verified)!.version;
        return { version: `${version}+${tip.slice(0, 12)}`, tag: `branch ${cfg.track}` };
      }
      const newer = (await upstreamTags(dir, cfg.tag)).filter((v) => semver.gt(v, verified));
      const version = newer.at(-1);
      return version ? { version, tag: tagFor(cfg, version) } : undefined;
    },

    async beforeInstall(ctx: GraftContext, version: string) {
      const { project, graft } = ctx;
      if (isStandalone(graft)) throw new GraftError(`graft "${graft.id}": fork.install is "none"; nothing is installed`, 'fork/standalone');
      if (commitOf(version)) throw new GraftError(`graft "${graft.id}": commit targets (${version}) are only for repo mode (fork.install: none); installs need a release tag`, 'fork/commit-target');
      const variant = project.selectVariant(graft, version);
      if (!variant) throw new GraftError(`graft "${graft.id}": no variant covers ${version}`, 'variant/none');
      const change = await forkChange(project, graft, variant);
      await installVendoredTarball(vendorContext(project), graft.frontmatter.rootstock.package, version, tarballBuilder(project, graft, version, change));
      // A targeted `add <pkg>@<version>` would replace the vendored override.
      return { install: 'reinstall' as const };
    },

    async validateVariant(ctx: GraftContext, variant: ResolvedVariant): Promise<void> {
      await forkChange(ctx.project, ctx.graft, variant);
    },

    variantTemplate({ options }) {
      // In place, the variant never changes: this checkout against the upstream it last verified.
      const variant = options.inPlace ? { ref: WORKTREE, base: VERIFIED } : { ref: 'TODO', base: 'TODO' };
      return `${JSON.stringify(variant, null, 2)}\n`;
    },

    scaffoldFrontmatter({ root, options }) {
      const inPlace = options.inPlace === true;
      const str = (k: string) => (typeof options[k] === 'string' ? (options[k] as string) : undefined);
      // In place, the fork is this checkout: its `upstream` git remote (if any) names the upstream.
      const upstreamRemote = inPlace ? spawnSync('git', ['remote', 'get-url', 'upstream'], { cwd: root, encoding: 'utf8' }) : undefined;
      const upstream = str('upstream') ?? (upstreamRemote?.status === 0 ? upstreamRemote.stdout.trim() : undefined) ?? 'TODO: git URL of the upstream repo';
      const fork: Record<string, unknown> = {
        repo: str('repo') ?? (inPlace ? '.' : 'TODO: git URL of your fork'),
        upstream,
        tag: str('tag') ?? 'v{version}',
      };
      if (inPlace || options.repoMode === true) fork.install = 'none';
      if (str('track')) fork.track = str('track');
      return { fork };
    },
  };
  return adapter;
}

export const forkAdapter = createForkAdapter();
