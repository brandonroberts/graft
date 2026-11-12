import path from 'node:path';
import { semverScheme } from '@graftsync/spec';
import type { Ecosystem } from '../ecosystem.js';
import { detectPackageManager, installPackage, reinstall } from '../install.js';
import { NpmUpstreamSource } from '../upstream.js';

/** npm packages, installed by pnpm, npm, yarn, bun or upm (spec §8). */
export const npmEcosystem: Ecosystem = {
  name: 'npm',
  scheme: semverScheme,
  createUpstream(project) {
    // `ecosystems.npm` wins; the top-level `upstream` / `resolveFrom` keys are its aliases.
    const own = (project.config.ecosystems?.npm ?? {}) as { upstream?: Record<string, string>; resolveFrom?: Record<string, string> };
    const specs = { ...project.config.upstream, ...own.upstream };
    const resolveFrom = { ...project.config.resolveFrom, ...own.resolveFrom };
    return new NpmUpstreamSource({
      root: project.root,
      cacheDir: project.cacheDir,
      specs,
      specBase: project.graftsDir,
      resolveFrom: Object.fromEntries(Object.entries(resolveFrom).map(([pkg, dir]) => [pkg, path.resolve(project.root, dir)])),
    });
  },
  detect: (root) => detectPackageManager(root),
  install: (project, pkg, version) => installPackage(project.root, pkg, project.upstreamFor('npm').installSpec(pkg, version)),
  reinstall: (project) => reinstall(project.root),
};
