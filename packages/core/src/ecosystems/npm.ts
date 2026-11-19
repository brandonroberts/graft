import path from 'node:path';
import { semverScheme } from '@graftsync/spec';
import type { Ecosystem } from '../ecosystem.js';
import { runCommand } from '../command.js';
import { GraftError } from '../errors.js';
import { detectPackageManager, installPackage, reinstall, updatePnpmCatalogs } from '../install.js';
import { findSiblings } from '../siblings.js';
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
  async install(project, pkg, version, siblings = []) {
    const upstream = project.upstreamFor('npm');
    let names = [pkg, ...siblings];
    const steps: string[] = [];
    if (detectPackageManager(project.root) === 'pnpm') {
      const updates: { pkg: string; from: string; to: string }[] = [];
      for (const name of names) {
        const from = (await upstream.installed(name))?.version;
        if (from) updates.push({ pkg: name, from, to: version });
      }
      const moved = await updatePnpmCatalogs(project.root, updates);
      if (moved.length) {
        steps.push(`set ${moved.map((n) => `${n}@${version}`).join(', ')} in pnpm-workspace.yaml's catalog`);
        names = names.filter((n) => !moved.includes(n));
        if (!names.length) {
          const command = 'pnpm install --no-frozen-lockfile';
          const result = await runCommand(command, { cwd: project.root, timeoutMs: 10 * 60_000 });
          if (!result.passed) throw new GraftError(`\`${command}\` failed:\n${result.output}`, 'install/failed');
          return [...steps, command].join(' && ');
        }
      }
    }
    const [first, ...rest] = names.map((n) => ({ pkg: n, spec: upstream.installSpec(n, version) }));
    steps.push(await installPackage(project.root, first!.pkg, first!.spec, rest));
    return steps.join(' && ');
  },
  siblings: (project, pkg) => findSiblings(project, pkg),
  reinstall: (project) => reinstall(project.root),
};
