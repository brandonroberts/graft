// A package ecosystem (npm, cargo, go, pypi): where pristine upstream packages come from, how
// versions are compared, how the installed copy is found, and how a version is installed.
// Mechanisms stay ecosystem-agnostic: they reach all of this through `project.upstreamFor(graft)`
// and `project.ecosystemFor(graft)`.
import type { EcosystemName, VersionScheme } from '@graftsync/spec';
import type { Project } from './project.js';
import type { UpstreamSource } from './upstream.js';

export interface Ecosystem {
  name: EcosystemName;
  /** How versions and variant ranges are validated and compared. */
  scheme: VersionScheme;
  /** The ecosystem's canonical spelling of a version (Go: `0.14.0` → `v0.14.0`). */
  normalizeVersion?(version: string): string;
  /** Pristine published contents, installed copies and published versions, for this project. */
  createUpstream(project: Project): UpstreamSource;
  /** The tool that manages this ecosystem's dependencies in the project (e.g. `pnpm`, `cargo`, `uv`). */
  detect(root: string): string;
  /** Install exactly `pkg@version`; returns the command(s) run. Throws (`install/failed`) on failure. */
  install(project: Project, pkg: string, version: string): Promise<string>;
  /** Re-resolve the project's dependencies after an applier changed configuration; returns the command(s) run. */
  reinstall(project: Project): Promise<string>;
}

/** The ecosystem's options from `.grafts/config.json` (`ecosystems.<name>`). */
export function ecosystemOptions<T extends Record<string, unknown>>(project: Project, name: EcosystemName): Partial<T> {
  return (project.config.ecosystems?.[name] ?? {}) as Partial<T>;
}
