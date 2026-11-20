import path from 'node:path';
import { semverScheme } from '@graftsync/spec';
import type { Ecosystem } from '../ecosystem.js';
import { runCommand } from '../command.js';
import { GraftError } from '../errors.js';
import {
  detectPackageManager,
  installPackage,
  isDeclaredNpmDependency,
  reinstall,
  updatePackageOverrides,
  updatePnpmCatalogs,
} from '../install.js';
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
    const pm = detectPackageManager(project.root);
    const own = (project.config.ecosystems?.npm ?? {}) as { resolveFrom?: Record<string, string> };
    const resolveFrom = { ...project.config.resolveFrom, ...own.resolveFrom };
    let names = [pkg, ...siblings];
    const steps: string[] = [];

    const installedVersions = new Map<string, string>();
    for (const name of names) {
      const from = (await upstream.installed(name))?.version;
      if (from) installedVersions.set(name, from);
    }
    const updates = names.filter((n) => installedVersions.has(n)).map((n) => ({ pkg: n, from: installedVersions.get(n)!, to: version }));

    if (pm === 'pnpm' && updates.length) {
      const moved = await updatePnpmCatalogs(project.root, updates);
      if (moved.length) {
        steps.push(`set ${moved.map((n) => `${n}@${version}`).join(', ')} in pnpm-workspace.yaml's catalog`);
        names = names.filter((n) => !moved.includes(n));
      }
    }

    // Transitive dependencies (not declared in any workspace manifest) must not be passed to
    // `<pm> add`/`install` (which promotes them to root dependencies) or `pnpm update -r` /
    // `yarn up` (which leaves them behind). Bump an existing override/resolution that pins the
    // installed version, or fail loudly (#63).
    if (names.length) {
      const transitive: string[] = [];
      for (const name of names) {
        const extra = resolveFrom[name] ? [path.resolve(project.root, resolveFrom[name])] : [];
        if (!(await isDeclaredNpmDependency(project.root, name, extra))) transitive.push(name);
      }
      if (transitive.length) {
        const transitiveUpdates = transitive
          .filter((n) => installedVersions.has(n))
          .map((n) => ({ pkg: n, from: installedVersions.get(n)!, to: version }));
        const { moved, locations } = await updatePackageOverrides(project.root, pm, transitiveUpdates);
        if (moved.length) {
          steps.push(`set ${moved.map((n) => `${n}@${version}`).join(', ')} in ${locations.join(' and ')}`);
          names = names.filter((n) => !moved.includes(n));
        }
        const remaining = transitive.filter((n) => !moved.includes(n));
        if (remaining.length) {
          const field = pm === 'yarn' || pm === 'yarn-berry' ? 'resolutions' : 'overrides';
          const list = remaining.join(', ');
          const plural = remaining.length > 1;
          throw new GraftError(
            `${list} ${plural ? 'are transitive dependencies' : 'is a transitive dependency'} (not declared in dependencies, devDependencies or optionalDependencies of any workspace manifest, and no matching top-level ${field} entry pins the installed version); upgrading ${plural ? 'them' : 'it'} with ${pm} would promote ${plural ? 'them' : 'it'} into root dependencies or leave ${plural ? 'them' : 'it'} behind. Pin ${plural ? 'them' : 'it'} in ${field}, configure an \`upgrade\` command in .grafts/config.json, or use the \`vendor\` applier`,
            'install/transitive',
          );
        }
      }
    }

    if (!names.length) {
      if (pm === 'pnpm') {
        const command = 'pnpm install --no-frozen-lockfile';
        const result = await runCommand(command, { cwd: project.root, timeoutMs: 10 * 60_000 });
        if (!result.passed) throw new GraftError(`\`${command}\` failed:\n${result.output}`, 'install/failed');
        return [...steps, command].join(' && ');
      }
      steps.push(await reinstall(project.root));
      return steps.join(' && ');
    }

    const [first, ...rest] = names.map((n) => ({ pkg: n, spec: upstream.installSpec(n, version) }));
    steps.push(await installPackage(project.root, first!.pkg, first!.spec, rest));
    return steps.join(' && ');
  },
  siblings: (project, pkg) => findSiblings(project, pkg),
  reinstall: (project) => reinstall(project.root),
};
