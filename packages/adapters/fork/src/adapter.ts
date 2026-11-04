// The fork mechanism: a graft whose modification lives as commits on a fork of the upstream
// source repository, on top of an upstream release tag.
//
// A variant is a small JSON file `{ "ref": "<fork branch, tag or sha>", "base": "<upstream
// version the commits sit on>" }`. The graft's change is the fork's diff `tag(base)..ref`; every
// hunk is an anchor, located in the upstream *source* at `tag(target)` (fuzz 0). For a version,
// Graft rebases that diff onto the target tag, runs the optional build, packs the package with
// `npm pack`, and installs it through the vendored-tarball override (lockfile-recorded, works
// with every package manager). Graft never pushes to the fork.
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  type AnchorReport,
  type AnchorResult,
  type ApplyResult,
  type Graft,
  type GraftContext,
  type MechanismAdapter,
  type Project,
  type ResolvedVariant,
  type ScopedDiff,
  type ScopedFileDiff,
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
import { checkout, diff, ensureRepo, resolveForkRef, resolveTag, showFile } from './git.js';

export const MECHANISM = 'fork';

export interface ForkVariant {
  /** Fork branch, fork tag, or commit holding the modification. */
  ref: string;
  /** Upstream version whose tag the modification's commits are based on. */
  base: string;
}

function forkConfig(graft: Graft): ForkConfig {
  const cfg = graft.frontmatter.fork;
  if (!cfg) throw new GraftError(`graft "${graft.id}": mechanism "fork" needs a \`fork:\` block ({ repo, upstream, tag })`, 'fork/config');
  return cfg;
}

const tagFor = (cfg: ForkConfig, version: string) => cfg.tag.replaceAll('{version}', version);
const inPkg = (cfg: ForkConfig, file: string) => (cfg.dir ? `${cfg.dir.replace(/\/+$/, '')}/${file}` : file);
const repoDir = (project: Project, graft: Graft) => path.join(project.cacheDir, 'fork', graft.id);

async function loadVariant(graft: Graft, variant: ResolvedVariant): Promise<ForkVariant> {
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
  if (typeof v.base !== 'string' || !semver.valid(v.base)) {
    throw new GraftError(`graft "${graft.id}": ${variant.module} must give "base", the upstream version the fork's commits sit on`, 'variant/invalid');
  }
  return { ref: v.ref, base: v.base };
}

async function upstreamRev(dir: string, cfg: ForkConfig, version: string): Promise<string> {
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

interface ForkChange {
  variant: ForkVariant;
  patches: FilePatch[];
  baseTag: string;
}

/** The graft's change: the fork's diff from its base tag to its ref, as file patches. */
async function forkChange(project: Project, graft: Graft, ref: ResolvedVariant): Promise<ForkChange> {
  const cfg = forkConfig(graft);
  const variant = await loadVariant(graft, ref);
  const dir = repoDir(project, graft);
  await ensureRepo(dir, cfg.repo, cfg.upstream);
  const baseRev = await upstreamRev(dir, cfg, variant.base);
  const refRev = await resolveForkRef(dir, variant.ref);
  if (!refRev) throw new GraftError(`graft "${graft.id}": fork ref "${variant.ref}" not found in ${cfg.repo}`, 'fork/no-ref');
  const patches = parsePatchFile(await diff(dir, baseRev, refRev, cfg.dir)).filter((p) => p.hunks.length > 0 || p.oldFile === null || p.newFile === null);
  if (!patches.length) {
    throw new GraftError(`graft "${graft.id}": fork ref "${variant.ref}" has no changes on top of ${tagFor(cfg, variant.base)}; a graft must never apply nothing`, 'fork/empty');
  }
  return { variant, patches, baseTag: tagFor(cfg, variant.base) };
}

/** Rebase the fork's change onto the target tag in a fresh checkout (the caller disposes it). */
async function materialize(project: Project, graft: Graft, version: string, change: ForkChange) {
  const cfg = forkConfig(graft);
  const dir = repoDir(project, graft);
  const co = await checkout(dir, await upstreamRev(dir, cfg, version));
  const pkgDir = cfg.dir ? path.join(co.path, cfg.dir) : co.path;
  const r = await applyToInstalledCopy({ dir: pkgDir, version }, change.patches);
  if (r.action !== 'patched') {
    await co.dispose();
    throw new GraftError(
      `graft "${graft.id}": the fork's change (${change.variant.ref} on ${change.baseTag}) does not rebase onto ${tagFor(cfg, version)}: ${r.reason ?? r.action}`,
      'fork/rebase',
    );
  }
  return { pkgDir, files: r.files, dispose: co.dispose };
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
    return { ...base, matched: true, location: { line: m.line!, column: 1, start: 0, end: 0 } };
  });
}

export function createForkAdapter(): MechanismAdapter {
  return {
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
        if (absorbed) evidence.push(`${file}: upstream ${tagFor(cfg, version)} already contains the fork's change`);
      }
      if (absorbed && report.anchors.some((a) => !a.matched)) report.upstreamed = { evidence };

      const installed = await project.upstream.installed(pkg);
      if (installed?.version === version && report.anchors.every((a) => a.matched)) {
        const vctx = vendorContext(project);
        report.errors.push(
          ...(await vendoredTarballProblems(vctx, pkg, version, tarballBuilder(project, graft, version, change), `the fork's ${change.variant.ref} rebased onto ${tagFor(cfg, version)}`)),
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
      const version = options.version ?? (await project.installedVersion(pkg));
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
      const dir = repoDir(project, graft);
      await ensureRepo(dir, cfg.repo, cfg.upstream);
      const [fromRev, toRev] = [await upstreamRev(dir, cfg, from), await upstreamRev(dir, cfg, to)];
      const fromVariant = project.selectVariant(graft, from);
      const patches = fromVariant ? (await forkChange(project, graft, fromVariant).catch(() => undefined))?.patches ?? [] : [];
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
      const label = (v: string) => `${pkg}@${v} (${tagFor(cfg, v)})`;
      return { graft: graft.id, package: pkg, from, to, files, patch: renderPatch(files, { from: label(from), to: label(to) }) };
    },

    async beforeInstall(ctx: GraftContext, version: string) {
      const { project, graft } = ctx;
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

    variantTemplate() {
      return `${JSON.stringify({ ref: 'TODO', base: 'TODO' }, null, 2)}\n`;
    },

    scaffoldFrontmatter() {
      return { fork: { repo: 'TODO: git URL of your fork', upstream: 'TODO: git URL of the upstream repo', tag: 'v{version}' } };
    },
  };
}

export const forkAdapter = createForkAdapter();
