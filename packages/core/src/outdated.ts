import semver from 'semver';
import { ACTIVE_STATUSES } from '@graftsync/spec';
import type { Project } from './project.js';

export interface OutdatedEntry {
  package: string;
  grafts: string[];
  /** Lowest rootstock.verified among the package's grafts. */
  verified: string;
  installed?: string;
  distTags: Record<string, string>;
  /** Highest dist-tagged version (among `tags`) newer than every graft's verified version, if any. */
  candidate?: { version: string; tag: string };
  /** A standalone graft (one entry per graft): the candidate comes from its mechanism, not npm. */
  standalone?: boolean;
}

export interface OutdatedOptions {
  /** Dist-tags to consider. Defaults to latest, next, rc, beta (not canary). Prereleases are preferred. */
  tags?: string[];
}

// canary is excluded by default: canaries are typically published per commit, which would churn PRs.
const DEFAULT_TAGS = ['latest', 'next', 'rc', 'beta'];

/** For each rootstock package, find a newer upstream version to sync against. */
export async function outdated(project: Project, options: OutdatedOptions = {}): Promise<OutdatedEntry[]> {
  const tags = options.tags?.length ? options.tags : DEFAULT_TAGS;
  const { grafts } = await project.loadAll();
  const byPackage = new Map<string, typeof grafts>();
  // Standalone grafts track a source repository, not an npm package with dist-tags.
  for (const g of grafts.filter((g) => ACTIVE_STATUSES.includes(g.frontmatter.status) && !project.isStandalone(g))) {
    const list = byPackage.get(g.frontmatter.rootstock.package) ?? [];
    list.push(g);
    byPackage.set(g.frontmatter.rootstock.package, list);
  }
  const entries: OutdatedEntry[] = [];
  for (const [pkg, list] of byPackage) {
    const verified = list.map((g) => g.frontmatter.rootstock.verified).sort(semver.compare)[0]!;
    const newest = list.map((g) => g.frontmatter.rootstock.verified).sort(semver.rcompare)[0]!;
    const { distTags } = await project.upstream.versions(pkg);
    let candidate: OutdatedEntry['candidate'];
    for (const tag of tags) {
      const v = distTags[tag];
      if (!v || !semver.valid(v) || !semver.gt(v, newest)) continue;
      if (!candidate || semver.gt(v, candidate.version)) candidate = { version: v, tag };
    }
    entries.push({
      package: pkg,
      grafts: list.map((g) => g.id),
      verified,
      installed: await project.installedVersion(pkg),
      distTags,
      candidate,
    });
  }
  // Standalone grafts: their mechanism knows where upstream versions come from (e.g. git tags).
  for (const g of grafts.filter((g) => ACTIVE_STATUSES.includes(g.frontmatter.status) && project.isStandalone(g))) {
    const candidate = await project.adapterFor(g).newerVersion?.(project.context(g));
    entries.push({
      package: g.frontmatter.rootstock.package,
      grafts: [g.id],
      verified: g.frontmatter.rootstock.verified,
      distTags: {},
      candidate,
      standalone: true,
    });
  }
  return entries;
}
