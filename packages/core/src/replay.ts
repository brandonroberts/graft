import { summarizeMisses } from './operations.js';
import type { Project } from './project.js';
import type { AnchorReport, ApplyResult } from './types.js';

export interface ReplayEntry {
  version: string;
  variant: string | null;
  /** True when anchors match and the variant applies (static checks only; nothing is installed). */
  ok: boolean;
  summary: string;
  anchors?: AnchorReport;
  apply?: ApplyResult;
}

export interface ReplayOptions {
  /** Only versions in this range (default: every published version). */
  range?: string;
  /** Include prereleases (default false). */
  prerelease?: boolean;
  onProgress?: (entry: ReplayEntry) => void;
}

/**
 * Replay a graft's static checks across published upstream versions. Used to find the
 * real boundaries of each variant and as the sync-loop eval from the design brief.
 */
export async function replay(project: Project, id: string, options: ReplayOptions = {}): Promise<ReplayEntry[]> {
  const graft = await project.get(id);
  const adapter = project.adapterFor(graft);
  const ctx = project.context(graft);
  const scheme = project.schemeFor(graft);
  const { versions } = await project.upstreamFor(graft).versions(graft.frontmatter.rootstock.package);
  const list = versions
    .filter((v) => scheme.valid(v) && (options.prerelease || !scheme.isPrerelease(v)))
    .filter((v) => !options.range || scheme.satisfies(v, options.range))
    .sort(scheme.compare);
  const entries: ReplayEntry[] = [];
  for (const version of list) {
    const variant = project.selectVariant(graft, version);
    const entry: ReplayEntry = { version, variant: variant?.module ?? null, ok: false, summary: '' };
    if (!variant) {
      entry.summary = 'no variant covers this version';
    } else {
      entry.anchors = await adapter.checkAnchors(ctx, version);
      if (!entry.anchors.ok) entry.summary = summarizeMisses(entry.anchors);
      else {
        entry.apply = await adapter.apply(ctx, { version });
        entry.ok = entry.apply.ok;
        entry.summary = entry.ok
          ? 'ok'
          : [...entry.apply.errors, ...entry.apply.files.filter((f) => f.error).map((f) => `${f.file}: ${f.error}`)].join('; ');
      }
    }
    entries.push(entry);
    options.onProgress?.(entry);
  }
  return entries;
}
