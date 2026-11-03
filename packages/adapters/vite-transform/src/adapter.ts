import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  findFilesMentioning,
  GraftError,
  lineColumn,
  renderPatch,
  scopeFileDiff,
  type AnchorRegion,
  type AnchorReport,
  type ApplyResult,
  type Graft,
  type GraftContext,
  type MechanismAdapter,
  type Project,
  type ResolvedVariant,
  type ScopedDiff,
  type ScopedFileDiff,
} from '@graft/core';
import { locateAnchors, transformTarget, type LocatedAnchor } from './transform.js';
import { variantProblems, type Variant } from './variant.js';

export const MECHANISM = 'vite-transform';

export function targetsOf(graft: Graft): string[] {
  const targets = graft.frontmatter.targets ?? [];
  if (!targets.length) throw new GraftError(`graft "${graft.id}": vite-transform grafts must list \`targets\``, 'graft/no-targets');
  return targets;
}

/** Import and shape-check a variant module. */
export async function loadVariant(project: Project, graft: Graft, ref: ResolvedVariant): Promise<Variant> {
  let mod: unknown;
  try {
    mod = await project.loadModule(ref.path);
  } catch (err) {
    throw new GraftError(`graft "${graft.id}": could not load variant ${ref.module}: ${(err as Error).message}`, 'variant/load');
  }
  const problems = variantProblems(mod, targetsOf(graft));
  if (problems.length) {
    throw new GraftError(`graft "${graft.id}": invalid variant ${ref.module}:\n  - ${problems.join('\n  - ')}`, 'variant/invalid');
  }
  // Plain objects are accepted too; defineVariant() only adds type safety.
  return mod as Variant;
}

async function readTarget(dir: string, file: string): Promise<string | undefined> {
  const full = path.join(dir, file);
  return existsSync(full) ? readFile(full, 'utf8') : undefined;
}

const span = (code: string, a: LocatedAnchor): [number, number] | undefined =>
  a.location ? [a.location.line, lineColumn(code, a.location.end).line] : undefined;

export function createViteTransformAdapter(): MechanismAdapter {
  const adapter: MechanismAdapter = {
    name: MECHANISM,

    async checkAnchors(ctx: GraftContext, version: string): Promise<AnchorReport> {
      const { project, graft } = ctx;
      const pkg = graft.frontmatter.rootstock.package;
      const report: AnchorReport = { graft: graft.id, package: pkg, version, variant: null, anchors: [], errors: [], ok: false };
      report.variant = project.selectVariant(graft, version);
      if (!report.variant) {
        report.errors.push(`no variant covers ${pkg}@${version}`);
        return report;
      }
      const targets = targetsOf(graft);
      let variant: Variant;
      let dir: string;
      try {
        variant = await loadVariant(project, graft, report.variant);
        dir = await project.upstream.resolve(pkg, version);
      } catch (err) {
        report.errors.push((err as Error).message);
        return report;
      }
      for (const file of targets) {
        const code = await readTarget(dir, file);
        if (code === undefined) {
          report.errors.push(`target ${file} does not exist in ${pkg}@${version}`);
          for (const [name, a] of Object.entries(variant.anchors)) {
            if ((a.file ?? targets[0]) === file || targets.length === 1) {
              report.anchors.push({ name, file, matched: false, description: a.description, error: 'target file missing' });
            }
          }
          continue;
        }
        try {
          report.anchors.push(...locateAnchors(variant, targets, file, code).map(({ node: _node, ...rest }) => rest));
        } catch (err) {
          report.errors.push((err as Error).message);
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
      const targets = targetsOf(graft);
      let variant: Variant;
      let dir: string;
      try {
        variant = await loadVariant(project, graft, result.variant);
        dir = await project.upstream.resolve(pkg, version);
      } catch (err) {
        result.errors.push((err as Error).message);
        return result;
      }
      for (const file of targets) {
        const code = await readTarget(dir, file);
        if (code === undefined) {
          result.files.push({ file, changed: false, error: `target does not exist in ${pkg}@${version}` });
          continue;
        }
        try {
          const out = transformTarget({ graftId: graft.id, variant, targets, file, code, id: path.join(dir, file), version });
          const entry: ApplyResult['files'][number] = { file, changed: true };
          if (options.outDir) {
            entry.outputPath = path.join(options.outDir, file);
            await mkdir(path.dirname(entry.outputPath), { recursive: true });
            await writeFile(entry.outputPath, out.code);
          }
          result.files.push(entry);
        } catch (err) {
          result.files.push({ file, changed: false, error: (err as Error).message });
        }
      }
      result.ok = result.errors.length === 0 && result.files.every((f) => f.changed && !f.error);
      return result;
    },

    async scopeDiff(ctx: GraftContext, from: string, to: string): Promise<ScopedDiff> {
      const { project, graft } = ctx;
      const pkg = graft.frontmatter.rootstock.package;
      const targets = targetsOf(graft);
      const [fromDir, toDir] = await Promise.all([project.upstream.resolve(pkg, from), project.upstream.resolve(pkg, to)]);
      const load = async (version: string) => {
        const ref = project.selectVariant(graft, version);
        return ref ? loadVariant(project, graft, ref).catch(() => undefined) : undefined;
      };
      const fromVariant = await load(from);
      const toVariant = await load(to);
      const files: ScopedFileDiff[] = [];
      for (const file of targets) {
        const [oldText, newText] = await Promise.all([readTarget(fromDir, file), readTarget(toDir, file)]);
        const regions = new Map<string, AnchorRegion>();
        const region = (name: string) => regions.get(name) ?? regions.set(name, { name, symbols: [] }).get(name)!;
        const tryLocate = (variant: Variant | undefined, code: string | undefined) => {
          if (!variant || code === undefined) return [];
          try {
            return locateAnchors(variant, targets, file, code);
          } catch {
            return [];
          }
        };
        for (const variant of [fromVariant, toVariant]) {
          for (const [name, def] of Object.entries(variant?.anchors ?? {})) {
            if ((def.file ?? (targets.length === 1 ? targets[0] : undefined)) === file) region(name).symbols!.push(...def.symbols);
          }
          for (const a of tryLocate(variant, oldText)) if (a.matched) region(a.name).old ??= span(oldText!, a);
          for (const a of tryLocate(variant, newText)) if (a.matched) region(a.name).new ??= span(newText!, a);
        }
        const diff = scopeFileDiff({ file, oldText, newText, regions: [...regions.values()] });
        if (diff.status === 'removed') {
          diff.candidates = await findFilesMentioning(toDir, [...regions.values()].flatMap((r) => r.symbols ?? []));
        }
        files.push(diff);
      }
      return { graft: graft.id, package: pkg, from, to, files, patch: renderPatch(files, { from: `${pkg}@${from}`, to: `${pkg}@${to}` }) };
    },

    async validateVariant(ctx: GraftContext, variant: ResolvedVariant): Promise<void> {
      await loadVariant(ctx.project, ctx.graft, variant);
    },

    variantTemplate({ package: pkg, targets }) {
      const target = targets?.[0] ?? 'dist/index.js';
      return `import { defineVariant, exportedFunction } from '@graft/adapter-vite-transform';

// Variant for ${pkg}. Anchors locate upstream code by behavior; every anchor must
// match exactly once in ${target} or the build fails loudly.
export default defineVariant({
  anchors: {
    // TODO: anchor on a stable exported symbol, e.g. the function you modify.
    target: exportedFunction('TODO_exportName', {
      description: 'the upstream function this graft modifies',
    }),
  },
  transform({ s, anchors }) {
    // Edit through MagicString so source maps stay correct, e.g.:
    // s.appendLeft(anchors.target.end, '\\n/* graft */');
    void s;
    void anchors;
    throw new Error('variant not implemented');
  },
});
`;
    },
  };
  return adapter;
}

export const viteTransformAdapter = createViteTransformAdapter();
