import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatch, reversePatch } from 'diff';
import {
  distinctiveText,
  GraftError,
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
import { applyFilePatch, describeHunk, locateHunk, parsePatchFile, patchTarget, type FilePatch } from './patchfile.js';
import { selectApplier, type ApplierConfig } from './appliers.js';
import { applyToInstalledCopy, findInstalledCopies } from './installed.js';
import { captureInstalledChanges } from './capture.js';
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
  if (!patches.length || patches.every((p) => p.hunks.length === 0)) {
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

/** Anchors of a patch: every hunk must fit exactly; created files must not already exist. */
function hunkAnchors(patch: FilePatch, content: string | undefined): AnchorResult[] {
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
  return patch.hunks.map((hunk, i) => {
    const base = { name: `${file}#${i + 1}`, file, description: describeHunk(hunk) };
    if (content === undefined) return { ...base, matched: false, error: 'file missing' };
    const m = locateHunk(content, hunk);
    if (!m.occurrences) return { ...base, matched: false, error: 'context or removed lines not found' };
    return {
      ...base,
      matched: true,
      location: { line: m.line!, column: 1, start: 0, end: 0 },
      error: m.offset ? `found ${m.offset > 0 ? '+' : ''}${m.offset} lines from the header position` : undefined,
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
      if (content === undefined || content !== applyPatch('', p.raw, { fuzzFactor: 0 })) return undefined;
      evidence.push(`${p.newFile} already exists with the content this graft creates`);
    } else if (p.newFile === null) {
      if ((await readIn(dir, p.oldFile)) !== undefined) return undefined;
      evidence.push(`${p.oldFile}, which this graft deletes, is already gone`);
    } else {
      const content = await readIn(dir, p.newFile);
      if (content === undefined || !p.hunks.length || applyPatch(content, reversePatch(p.raw), { fuzzFactor: 0 }) === false)
        return undefined;
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
      try {
        patches = await loadPatch(graft, report.variant);
        dir = await project.upstreamFor(graft).resolve(pkg, version);
      } catch (err) {
        report.errors.push((err as Error).message);
        return report;
      }
      for (const p of patches) {
        const content = await readIn(dir, patchTarget(p));
        report.anchors.push(...hunkAnchors(p, content));
        // Hunks can each fit yet fail together (ordering); confirm the whole file applies.
        if (content !== undefined && p.oldFile && hunkAnchors(p, content).every((a) => a.matched) && applyFilePatch(content, p) === false) {
          report.errors.push(`${patchTarget(p)}: hunks match individually but the patch does not apply as a whole`);
        }
      }
      // A variant that no longer fits may simply be upstream's own change now: detect absorption.
      if (!report.anchors.every((a) => a.matched)) {
        const evidence = await upstreamedEvidence(dir, patches);
        if (evidence) report.upstreamed = { evidence };
      }
      const upstream = project.upstreamFor(graft);
      const installed = await upstream.installed(pkg);
      if (installed?.version === version) {
        report.errors.push(
          ...(await applierFor(project, graft).problems(project.root, pkg, version, report.variant.path, { upstream, project })),
        );
        // Whatever the configuration says, check what actually got installed: each patched file
        // must equal pristine upstream + this variant. Catches patches dropped silently.
        // Under Plug'n'Play the installed copy lives in a zip archive, read through the PnP runtime.
        if (report.anchors.every((a) => a.matched) && installed.dir !== dir) {
          const targets = patches.filter((p) => p.newFile).map((p) => p.newFile!);
          let actual: Record<string, string | undefined> | undefined;
          try {
            actual = await readInstalledFiles(installed, targets);
          } catch (err) {
            (report.warnings ??= []).push(
              `cannot verify installed files of ${pkg}@${version}${installed.pnp ? " under Plug'n'Play" : ''} (${(err as Error).message}); the package-manager configuration was checked, the installed contents were not`,
            );
          }
          for (const p of actual ? patches : []) {
            if (!p.newFile) continue;
            const pristine = p.oldFile ? await readIn(dir, p.oldFile) : '';
            const expected = pristine === undefined ? false : applyFilePatch(pristine, p);
            if (expected !== false && actual![p.newFile] !== expected) {
              report.errors.push(
                `installed ${pkg}@${version} ${p.newFile} is not patched with ${report.variant.module}; run \`graft apply\` (or reinstall)`,
              );
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
      try {
        patches = await loadPatch(graft, result.variant);
        dir = await project.upstreamFor(graft).resolve(pkg, version);
      } catch (err) {
        result.errors.push((err as Error).message);
        return result;
      }
      for (const p of patches) {
        const file = patchTarget(p);
        const content = await readIn(dir, file);
        let output: string | false;
        if (p.oldFile === null) output = content === undefined ? applyFilePatch('', p) : false;
        else output = content === undefined ? false : applyFilePatch(content, p);
        if (output === false) {
          result.files.push({ file, changed: false, error: content === undefined && p.oldFile ? 'file missing' : 'patch does not apply' });
          continue;
        }
        const entry: ApplyResult['files'][number] = { file: p.newFile ?? file, changed: output !== content };
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
        const scoped = scopeFileDiff({ file, oldText, newText, regions, window: 10 });
        if (scoped.status === 'removed' && filePatch?.hunks.length) {
          // Point at where the patched code went: files in `to` holding the hunks' old side.
          const text = distinctiveText(
            filePatch.hunks.flatMap((h) => h.lines.filter((l) => l[0] === ' ' || l[0] === '-').map((l) => l.slice(1))),
          );
          const ext = path.extname(file);
          const include = ext && !/^\.(c|m)?js$/.test(ext) ? new RegExp(`(\\.(c|m)?js|${ext.replace('.', '\\.')})$`) : undefined;
          const candidates = await rankFilesByContent(toDir, { ...text, include });
          if (candidates.length) scoped.candidates = candidates;
        }
        files.push(scoped);
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
