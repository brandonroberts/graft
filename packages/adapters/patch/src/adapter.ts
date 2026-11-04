import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GraftError,
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
import { configurePnpmPatch, pnpmConfigProblems } from './pnpm.js';

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

export function createPatchAdapter(): MechanismAdapter {
  return {
    name: MECHANISM,
    variantExtension: '.patch',

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
        dir = await project.upstream.resolve(pkg, version);
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
      if (version === (await project.installedVersion(pkg))) {
        report.errors.push(...(await pnpmConfigProblems(project.root, pkg, report.variant.path)));
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
      let patches: FilePatch[];
      let dir: string;
      try {
        patches = await loadPatch(graft, result.variant);
        dir = await project.upstream.resolve(pkg, version);
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
      const [fromDir, toDir] = await Promise.all([project.upstream.resolve(pkg, from), project.upstream.resolve(pkg, to)]);
      const fromVariant = project.selectVariant(graft, from);
      const patches = fromVariant ? await loadPatch(graft, fromVariant).catch(() => []) : [];
      const touched = new Set<string>([...(graft.frontmatter.targets ?? []), ...patches.map((p) => p.oldFile).filter((f): f is string => !!f)]);
      const files: ScopedFileDiff[] = [];
      for (const file of touched) {
        const [oldText, newText] = await Promise.all([readIn(fromDir, file), readIn(toDir, file)]);
        const filePatch = patches.find((p) => p.oldFile === file);
        const regions = (filePatch?.hunks ?? []).map((h, i) => ({
          name: `${file}#${i + 1}`,
          old: [h.oldStart, h.oldStart + Math.max(h.oldLines - 1, 0)] as [number, number],
        }));
        files.push(scopeFileDiff({ file, oldText, newText, regions, window: 10 }));
      }
      return { graft: graft.id, package: pkg, from, to, files, patch: renderPatch(files, { from: `${pkg}@${from}`, to: `${pkg}@${to}` }) };
    },

    async beforeInstall(ctx: GraftContext, version: string): Promise<void> {
      const variant = ctx.project.selectVariant(ctx.graft, version);
      if (!variant) throw new GraftError(`graft "${ctx.graft.id}": no variant covers ${version}`, 'variant/none');
      await configurePnpmPatch(ctx.project.root, ctx.graft.frontmatter.rootstock.package, variant.path);
    },

    async validateVariant(ctx: GraftContext, variant: ResolvedVariant): Promise<void> {
      await loadPatch(ctx.graft, variant);
    },

    variantTemplate({ package: pkg }) {
      return `# Replace this file with the patch for ${pkg}.
# Create it with:  pnpm patch ${pkg}   (edit the printed directory)
#            then: pnpm patch-commit <dir> --patches-dir <this graft>/variants
# and move/rename the generated file here.
`;
    },
  };
}

export const patchAdapter = createPatchAdapter();
