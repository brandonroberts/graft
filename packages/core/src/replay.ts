import semver from 'semver';
import { summarizeMisses } from './operations.js';
import type { Project } from './project.js';
import type { AnchorReport, ApplyResult } from './types.js';

export interface ReplayEntry {
  version: string;
  variant: string | null;
  /** True when anchors match and the variant applies (static checks only; no install, no oracle). */
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
  const { versions } = await project.upstream.versions(graft.frontmatter.rootstock.package);
  const list = versions
    .filter((v) => semver.valid(v) && (options.prerelease || !semver.prerelease(v)))
    .filter((v) => !options.range || semver.satisfies(v, options.range, { includePrerelease: !!options.prerelease }))
    .sort(semver.compare);
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
        entry.summary = entry.ok ? 'ok' : [...entry.apply.errors, ...entry.apply.files.filter((f) => f.error).map((f) => `${f.file}: ${f.error}`)].join('; ');
      }
    }
    entries.push(entry);
    options.onProgress?.(entry);
  }
  return entries;
}
