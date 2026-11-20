import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  distinctiveText,
  GraftError,
  isHashedChunkRename,
  rankFilesByContent,
  readInstalledFiles,
  renderPatch,
  scopeFileDiff,
  type AnchorReport,
  type AnchorResult,
  type ApplyResult,
  type Graft,
  type GraftContext,
  type MechanismAdapter,
  type ResolvedVariant,
  type ScopedDiff,
  type ScopedFileDiff,
} from '@graftsync/core';
import {
  applyFilePatch,
  describeHunk,
  locateHunk,
  normalizeLf,
  parsePatchFile,
  patchHasCr,
  patchTarget,
  reverseFilePatch,
  type FilePatch,
} from './patchfile.js';
import { selectApplier, type ApplierConfig } from './appliers.js';
import { applyToInstalledCopy, findInstalledCopies } from './installed.js';
import { captureInstalledChanges } from './capture.js';
import { pnpmPackageExtensionWarnings } from './pnpm.js';
import type { Project } from '@graftsync/core';

/** The applier for a graft (config `mechanisms.patch.applier`, else from its ecosystem's tooling). */
const applierFor = (project: Project, graft: Graft) =>
  selectApplier(
    project.root,
    project.config.mechanisms?.patch?.applier as ApplierConfig | undefined,
    graft.frontmatter.rootstock.ecosystem,
  );

export const MECHANISM = 'patch';

async function loadPatch(graft: Graft, variant: ResolvedVariant): Promise<FilePatch[]> {
  if (!existsSync(variant.path)) throw new GraftError(`graft "${graft.id}": variant ${variant.module} not found`, 'variant/not-found');
  if (!variant.path.endsWith('.patch') && !variant.path.endsWith('.diff')) {
    throw new GraftError(`graft "${graft.id}": patch variants must be .patch or .diff files (got ${variant.module})`, 'variant/invalid');
  }
  let patches: FilePatch[];
  try {
    patches = parsePatchFile(await readFile(variant.path, 'utf8'));
  } catch (err) {
    throw new GraftError(`graft "${graft.id}": could not parse ${variant.module}: ${(err as Error).message}`, 'variant/invalid');
  }
  if (!patches.length || patches.every((p) => p.hunks.length === 0 && p.oldFile !== null && p.newFile !== null)) {
    throw new GraftError(`graft "${graft.id}": ${variant.module} contains no hunks; a graft must never apply nothing`, 'variant/empty');
  }
  for (const p of patches) {
    const t = patchTarget(p);
    if (path.isAbsolute(t) || t.split('/').includes('..')) {
      throw new GraftError(`graft "${graft.id}": ${variant.module} touches ${t}, outside the package`, 'variant/invalid');
    }
  }
  return patches;
}

async function readIn(dir: string, file: string): Promise<string | undefined> {
  const full = path.join(dir, file);
  return existsSync(full) ? readFile(full, 'utf8') : undefined;
}

interface HunkOffsetLimit {
  limit: number;
  applier: string;
}

/** Anchors of a patch: every hunk must fit exactly (and within the applier's offset window); created files must not already exist. */
function hunkAnchors(patch: FilePatch, content: string | undefined, maxOffset?: HunkOffsetLimit): AnchorResult[] {
  const file = patchTarget(patch);
  if (patch.oldFile === null) {
    return [
      {
        name: `${file}#create`,
        file,
        description: `creates ${file}`,
        matched: content === undefined,
        error: content === undefined ? undefined : 'file already exists upstream (the graft may have been upstreamed)',
      },
    ];
  }
  if (patch.newFile === null && patch.hunks.length === 0) {
    return [
      {
        name: `${file}#delete`,
        file,
        description: `deletes ${file}`,
        matched: content !== undefined,
        error: content === undefined ? 'file already absent upstream (the graft may have been upstreamed)' : undefined,
      },
    ];
  }
  return patch.hunks.map((hunk, i) => {
    const base = { name: `${file}#${i + 1}`, file, description: describeHunk(hunk) };
    if (content === undefined) return { ...base, matched: false, error: 'file missing' };
    const m = locateHunk(content, hunk);
    if (!m.occurrences) return { ...base, matched: false, error: 'context or removed lines not found' };
    const drift = m.offset ? `found ${m.offset > 0 ? '+' : ''}${m.offset} lines from the header position` : undefined;
    if (m.offset !== undefined && maxOffset && Math.abs(m.offset) > maxOffset.limit) {
      return {
        ...base,
        matched: false,
        location: { line: m.line!, column: 1, start: 0, end: 0 },
        error: `${drift} (exceeds ${maxOffset.applier}'s ±${maxOffset.limit}-line hunk offset limit; rebase into a new variant)`,
      };
    }
    return {
      ...base,
      matched: true,
      location: { line: m.line!, column: 1, start: 0, end: 0 },
      error: drift,
    };
  });
}

/**
 * Evidence that `dir` (pristine upstream) already contains every change of `patches`, or
 * undefined if any file patch is not fully absorbed: modified files must take the reverse patch
 * with no fuzz, created files must exist with identical content, deleted files must be gone.
 */
async function upstreamedEvidence(dir: string, patches: FilePatch[]): Promise<string[] | undefined> {
  const evidence: string[] = [];
  for (const p of patches) {
    if (p.oldFile === null) {
      const content = await readIn(dir, p.newFile!);
      const expected = applyFilePatch('', p);
      if (content === undefined || expected === false || content !== expected) return undefined;
      evidence.push(`${p.newFile} already exists with the content this graft creates`);
    } else if (p.newFile === null) {
      if ((await readIn(dir, p.oldFile)) !== undefined) return undefined;
      evidence.push(`${p.oldFile}, which this graft deletes, is already gone`);
    } else {
      const content = await readIn(dir, p.newFile);
      if (content === undefined || !p.hunks.length || reverseFilePatch(content, p) === false) return undefined;
      evidence.push(`${p.newFile}: all ${p.hunks.length} hunk(s) already present (the reverse patch applies with no fuzz)`);
    }
  }
  return evidence.length ? evidence : undefined;
}

export function createPatchAdapter(): MechanismAdapter {
  return {
    name: MECHANISM,
    variantExtension: '.patch',
    // One patchedDependencies entry / one vendored tarball per package.
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
      let patches: FilePatch[];
      let dir: string;
      let maxOffset: HunkOffsetLimit | undefined;
      try {
        patches = await loadPatch(graft, report.variant);
        dir = await project.upstreamFor(graft).resolve(pkg, version);
        const applier = applierFor(project, graft);
        if (applier.maxHunkOffset !== undefined) maxOffset = { limit: applier.maxHunkOffset, applier: applier.name };
      } catch (err) {
        report.errors.push((err as Error).message);
        return report;
      }
      for (const p of patches) {
        const content = await readIn(dir, patchTarget(p));
        const anchors = hunkAnchors(p, content, maxOffset);
        report.anchors.push(...anchors);
        // Hunks can each fit yet fail together (ordering); confirm the whole file applies.
        if (content !== undefined && p.oldFile && anchors.every((a) => a.matched) && applyFilePatch(content, p) === false) {
          report.errors.push(`${patchTarget(p)}: hunks match individually but the patch does not apply as a whole`);
        }
      }
      // A variant that no longer fits may simply be upstream's own change now: detect absorption.
      if (!report.anchors.every((a) => a.matched)) {
        const evidence = await upstreamedEvidence(dir, patches);
        if (evidence) report.upstreamed = { evidence };
      }
      report.ok = report.errors.length === 0 && report.anchors.every((a) => a.matched);
      return report;
    },

    async checkInstalled(ctx: GraftContext, version: string) {
      const { project, graft } = ctx;
      const pkg = graft.frontmatter.rootstock.package;
      const variant = project.selectVariant(graft, version);
      if (!variant) return { errors: [] };
      const upstream = project.upstreamFor(graft);
      const installed = await upstream.installed(pkg);
      if (installed?.version !== version) return { errors: [] };
      const applier = applierFor(project, graft);
      const errors = await applier.problems(project.root, pkg, version, variant.path, { upstream, project });
      const warnings: string[] = applier.name === 'pnpm' ? await pnpmPackageExtensionWarnings(project.root, pkg, version) : [];
      // Whatever the configuration says, check what actually got installed: each patched file
      // must equal pristine upstream + this variant. Catches patches dropped silently.
      // Under Plug'n'Play the installed copy lives in a zip archive, read through the PnP runtime.
      let patches: FilePatch[];
      let dir: string;
      try {
        patches = await loadPatch(graft, variant);
        dir = await upstream.resolve(pkg, version);
      } catch {
        return { errors };
      }
      if (installed.dir !== dir) {
        const targets = [...new Set(patches.map((p) => p.newFile ?? p.oldFile!).filter(Boolean))];
        let actual: Record<string, string | undefined> | undefined;
        try {
          actual = await readInstalledFiles(installed, targets);
        } catch (err) {
          warnings.push(
            `cannot verify installed files of ${pkg}@${version}${installed.pnp ? " under Plug'n'Play" : ''} (${(err as Error).message}); the package-manager configuration was checked, the installed contents were not`,
          );
        }
        for (const p of actual ? patches : []) {
          if (!p.newFile) {
            if (p.oldFile && actual![p.oldFile] !== undefined) {
              errors.push(
                `installed ${pkg}@${version} ${p.oldFile} was not deleted by ${variant.module}; run \`graft apply\` (or reinstall)`,
              );
            }
            continue;
          }
          const pristine = p.oldFile ? await readIn(dir, p.oldFile) : '';
          const expected = pristine === undefined ? false : applyFilePatch(pristine, p);
          if (expected === false) continue;
          const got = actual![p.newFile];
          const crlfTolerant = Boolean(pristine?.includes('\r\n') && !patchHasCr(p));
          const same = got === expected || (crlfTolerant && got !== undefined && normalizeLf(got) === normalizeLf(expected));
          if (!same) {
            errors.push(
              `installed ${pkg}@${version} ${p.newFile} is not patched with ${variant.module}; run \`graft apply\` (or reinstall)`,
            );
          }
        }
      }
      return { errors, ...(warnings.length ? { warnings } : {}) };
    },

    async apply(ctx: GraftContext, options = {}): Promise<ApplyResult> {
      const { project, graft } = ctx;
      const pkg = graft.frontmatter.rootstock.package;
      const version = options.version ?? (await project.installedVersion(pkg, graft.frontmatter.rootstock.ecosystem));
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
      let patches: FilePatch[];
      let dir: string;
      let maxOffset: HunkOffsetLimit | undefined;
      try {
        patches = await loadPatch(graft, result.variant);
        dir = await project.upstreamFor(graft).resolve(pkg, version);
        const applier = applierFor(project, graft);
        if (applier.maxHunkOffset !== undefined) maxOffset = { limit: applier.maxHunkOffset, applier: applier.name };
      } catch (err) {
        result.errors.push((err as Error).message);
        return result;
      }
      for (const p of patches) {
        const file = patchTarget(p);
        const content = await readIn(dir, file);
        if (maxOffset && p.oldFile !== null && content !== undefined) {
          const exceeded = p.hunks
            .map((h, i) => ({ index: i + 1, match: locateHunk(content, h) }))
            .find((x) => x.match.occurrences > 0 && x.match.offset !== undefined && Math.abs(x.match.offset) > maxOffset!.limit);
          if (exceeded) {
            const off = exceeded.match.offset!;
            result.files.push({
              file,
              changed: false,
              error: `hunk #${exceeded.index} shifted by ${off > 0 ? '+' : ''}${off} lines (exceeds ${maxOffset.applier}'s ±${maxOffset.limit}-line offset limit)`,
            });
            continue;
          }
        }
        let output: string | false;
        if (p.oldFile === null) output = content === undefined ? applyFilePatch('', p) : false;
        else output = content === undefined ? false : applyFilePatch(content, p);
        if (output === false) {
          result.files.push({ file, changed: false, error: content === undefined && p.oldFile ? 'file missing' : 'patch does not apply' });
          continue;
        }
        const changed = p.oldFile === null || p.newFile === null || output !== content;
        const entry: ApplyResult['files'][number] = {
          file: p.newFile ?? file,
          changed,
          ...(changed ? {} : { error: 'patch made no changes' }),
        };
        if (options.outDir && p.newFile) {
          entry.outputPath = path.join(options.outDir, p.newFile);
          await mkdir(path.dirname(entry.outputPath), { recursive: true });
          await writeFile(entry.outputPath, output);
        }
        result.files.push(entry);
      }
      result.ok = result.errors.length === 0 && result.files.every((f) => f.changed && !f.error);
      return result;
    },

    async scopeDiff(ctx: GraftContext, from: string, to: string): Promise<ScopedDiff> {
      const { project, graft } = ctx;
      const pkg = graft.frontmatter.rootstock.package;
      const upstream = project.upstreamFor(graft);
      const [fromDir, toDir] = await Promise.all([upstream.resolve(pkg, from), upstream.resolve(pkg, to)]);
      const fromVariant = project.selectVariant(graft, from);
      const patches = fromVariant ? await loadPatch(graft, fromVariant).catch(() => []) : [];
      const touched = new Set<string>([
        ...(graft.frontmatter.targets ?? []),
        ...patches.map((p) => p.oldFile).filter((f): f is string => !!f),
      ]);
      const files: ScopedFileDiff[] = [];
      for (const file of touched) {
        const [oldText, newText] = await Promise.all([readIn(fromDir, file), readIn(toDir, file)]);
        const filePatch = patches.find((p) => p.oldFile === file);
        const regions = (filePatch?.hunks ?? []).map((h, i) => ({
          name: `${file}#${i + 1}`,
          old: [h.oldStart, h.oldStart + Math.max(h.oldLines - 1, 0)] as [number, number],
        }));
        if (oldText !== undefined && newText === undefined && filePatch?.hunks.length) {
          // Point at where the patched code went: files in `to` holding the hunks' old side.
          const text = distinctiveText(
            filePatch.hunks.flatMap((h) => h.lines.filter((l) => l[0] === ' ' || l[0] === '-').map((l) => l.slice(1))),
          );
          const ext = path.extname(file);
          const include = ext && !/^\.(c|m)?js$/.test(ext) ? new RegExp(`(\\.(c|m)?js|${ext.replace('.', '\\.')})$`) : undefined;
          const candidates = await rankFilesByContent(toDir, { ...text, include });
          const renamed = candidates.find((c) => isHashedChunkRename(file, c));
          const renamedText = renamed ? await readIn(toDir, renamed) : undefined;
          if (renamed && renamedText !== undefined) {
            const renamedRegions = filePatch.hunks.map((h, i) => {
              const m = locateHunk(renamedText, h);
              return {
                name: `${file}#${i + 1}`,
                old: [h.oldStart, h.oldStart + Math.max(h.oldLines - 1, 0)] as [number, number],
                ...(m.occurrences > 0 && m.line ? { new: [m.line, m.line + Math.max(h.oldLines - 1, 0)] as [number, number] } : {}),
              };
            });
            files.push(scopeFileDiff({ file, newFile: renamed, oldText, newText: renamedText, regions: renamedRegions, window: 10 }));
            continue;
          }
          const scoped = scopeFileDiff({ file, oldText, newText, regions, window: 10 });
          if (candidates.length) scoped.candidates = candidates;
          files.push(scoped);
          continue;
        }
        files.push(scopeFileDiff({ file, oldText, newText, regions, window: 10 }));
      }
      return { graft: graft.id, package: pkg, from, to, files, patch: renderPatch(files, { from: `${pkg}@${from}`, to: `${pkg}@${to}` }) };
    },

    async applyInstalled(ctx: GraftContext) {
      const { project, graft } = ctx;
      const pkg = graft.frontmatter.rootstock.package;
      const report = {
        graft: graft.id,
        package: pkg,
        copies: [] as import('@graftsync/core').InstalledCopyResult[],
        errors: [] as string[],
        warnings: [] as string[],
      };
      if (graft.frontmatter.rootstock.ecosystem !== 'npm') {
        report.errors.push(
          `graft "${graft.id}": the built-in postinstall applier patches node_modules (npm only); ${graft.frontmatter.rootstock.ecosystem} grafts are applied by \`graft apply\``,
        );
        return report;
      }
      const primary = await project.upstreamFor(graft).installed(pkg);
      if (!primary) {
        report.warnings.push(`${pkg} is not installed; nothing to apply`);
        return report;
      }
      if (primary.pnp) {
        report.errors.push(
          `${pkg} is installed through yarn Plug'n'Play (${primary.dir}); Graft's built-in applier patches node_modules and cannot patch PnP's zip cache — use the "yarn" applier (default for yarn 2+) or "vendor"`,
        );
        return report;
      }
      const copies = await findInstalledCopies(project.root, pkg);
      if (!copies.some((c) => c.dir === primary.dir)) copies.unshift({ dir: primary.dir, version: primary.version });
      for (const copy of copies) {
        const isPrimary = copy.dir === primary.dir;
        const variant = project.selectVariant(graft, copy.version);
        const base = { dir: copy.dir, version: copy.version, primary: isPrimary, files: [] as string[] };
        if (!variant) {
          const reason = `no variant of graft "${graft.id}" covers ${pkg}@${copy.version}`;
          report.copies.push({ ...base, action: isPrimary ? 'failed' : 'skipped', reason });
          (isPrimary ? report.errors : report.warnings).push(isPrimary ? reason : `${reason} (nested copy at ${copy.dir} left unmodified)`);
          continue;
        }
        let patches: FilePatch[];
        try {
          patches = await loadPatch(graft, variant);
        } catch (err) {
          report.copies.push({ ...base, action: 'failed', variant: variant.module, reason: (err as Error).message });
          report.errors.push((err as Error).message);
          continue;
        }
        const r = await applyToInstalledCopy(copy, patches);
        report.copies.push({ ...base, ...r, variant: variant.module });
        if (r.action === 'failed') report.errors.push(`graft "${graft.id}": ${pkg}@${copy.version} at ${copy.dir}: ${r.reason}`);
      }
      return report;
    },

    async afterInstall(ctx: GraftContext): Promise<void> {
      if (applierFor(ctx.project, ctx.graft).name !== 'graft') return; // the package manager applied it
      const report = await this.applyInstalled!(ctx);
      if (report.errors.length) throw new GraftError(report.errors.join('; '), 'apply/installed');
    },

    async beforeInstall(ctx: GraftContext, version: string) {
      const variant = ctx.project.selectVariant(ctx.graft, version);
      if (!variant) throw new GraftError(`graft "${ctx.graft.id}": no variant covers ${version}`, 'variant/none');
      const r = await applierFor(ctx.project, ctx.graft).configure(
        ctx.project.root,
        ctx.graft.frontmatter.rootstock.package,
        version,
        variant.path,
        {
          upstream: ctx.project.upstreamFor(ctx.graft),
          project: ctx.project,
        },
      );
      return r.install ? { install: r.install } : undefined;
    },

    async validateVariant(ctx: GraftContext, variant: ResolvedVariant): Promise<void> {
      await loadPatch(ctx.graft, variant);
    },

    capture: captureInstalledChanges,

    variantTemplate({ id, package: pkg, ecosystem }: { id: string; package: string; ecosystem?: string }) {
      const where: Record<string, string> = {
        npm: `edit ${pkg} in node_modules, then run  graft capture ${id}\n# (it writes the difference from the published package here).`,
        cargo: `edit ${pkg}'s registry source (cargo metadata shows its manifest_path), then run  graft capture ${id}\n# (it writes the difference from the published .crate here; that copy is shared by every project).`,
      };
      return `# Replace this file with the patch for ${pkg}: a git-style diff with paths relative to the
# published package (a/<file>, b/<file>).
# ${where[ecosystem ?? 'npm'] ?? `diff a pristine copy (in .grafts/.cache/upstream/${ecosystem}/ after \`graft check\`) against your edited one.`}
`;
    },
  };
}

export const patchAdapter = createPatchAdapter();
