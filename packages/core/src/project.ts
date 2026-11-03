import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createJiti } from 'jiti';
import { parseGraft, selectVariant, type VariantRef } from '@graft/spec';
import { GraftError } from './errors.js';
import type { Graft, GraftContext, InvalidGraft, MechanismAdapter, ResolvedVariant } from './types.js';
import { NpmUpstreamSource, type UpstreamSource } from './upstream.js';

export const GRAFTS_DIR = '.grafts';
export const GRAFT_FILE = 'graft.md';
export const CONFIG_FILE = 'config.json';

/** Optional `.grafts/config.json`. */
export interface ProjectConfig {
  /** Per-package upstream spec templates, e.g. `{ "lib": "file:../mirror/lib-{version}" }`. */
  upstream?: Record<string, string>;
}

export interface ProjectOptions {
  /** Project root (directory containing `.grafts/`). */
  root: string;
  adapters: MechanismAdapter[];
  /** Override the upstream source (defaults to installed packages + npm registry). */
  upstream?: UpstreamSource;
}

export class Project {
  readonly root: string;
  readonly graftsDir: string;
  readonly cacheDir: string;
  readonly reportDir: string;
  readonly upstream: UpstreamSource;
  readonly config: ProjectConfig;
  private readonly adapters = new Map<string, MechanismAdapter>();
  private readonly jiti;

  private constructor(options: ProjectOptions, config: ProjectConfig) {
    this.root = path.resolve(options.root);
    this.graftsDir = path.join(this.root, GRAFTS_DIR);
    this.cacheDir = path.join(this.graftsDir, '.cache');
    this.reportDir = path.join(this.graftsDir, '.report');
    this.config = config;
    for (const adapter of options.adapters) this.adapters.set(adapter.name, adapter);
    this.upstream =
      options.upstream ??
      new NpmUpstreamSource({
        root: this.root,
        cacheDir: this.cacheDir,
        specs: config.upstream,
        specBase: this.graftsDir,
      });
    // No module cache: agents edit variants and re-check within one long-lived process.
    this.jiti = createJiti(path.join(this.root, 'noop.js'), { moduleCache: false, fsCache: false });
  }

  static async open(options: ProjectOptions): Promise<Project> {
    const configPath = path.join(path.resolve(options.root), GRAFTS_DIR, CONFIG_FILE);
    let config: ProjectConfig = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(await readFile(configPath, 'utf8')) as ProjectConfig;
      } catch (err) {
        throw new GraftError(`invalid ${configPath}: ${(err as Error).message}`, 'config/invalid');
      }
    }
    return new Project(options, config);
  }

  /** Walk up from `from` to find the nearest directory containing `.grafts/`. */
  static findRoot(from: string): string | undefined {
    let dir = path.resolve(from);
    for (;;) {
      if (existsSync(path.join(dir, GRAFTS_DIR))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }

  /** The registered adapter for a mechanism name, if any. */
  adapter(name: string): MechanismAdapter | undefined {
    return this.adapters.get(name);
  }

  get adapterNames(): string[] {
    return [...this.adapters.keys()];
  }

  /** Load every graft in directory order. Invalid grafts are returned separately, never dropped. */
  async loadAll(): Promise<{ grafts: Graft[]; invalid: InvalidGraft[] }> {
    const grafts: Graft[] = [];
    const invalid: InvalidGraft[] = [];
    if (!existsSync(this.graftsDir)) return { grafts, invalid };
    const entries = (await readdir(this.graftsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    for (const id of entries) {
      const file = path.join(this.graftsDir, id, GRAFT_FILE);
      if (!existsSync(file)) continue;
      const result = await this.loadFile(id, file);
      if ('frontmatter' in result) grafts.push(result);
      else invalid.push(result);
    }
    return { grafts, invalid };
  }

  private async loadFile(id: string, file: string): Promise<Graft | InvalidGraft> {
    const dir = path.dirname(file);
    const parsed = parseGraft(await readFile(file, 'utf8'), { directoryName: id });
    const diagnostics = [...parsed.diagnostics];
    if (parsed.graft && !this.adapters.has(parsed.graft.frontmatter.mechanism)) {
      diagnostics.push({
        severity: 'error',
        code: 'frontmatter/unknown-mechanism',
        path: 'mechanism',
        message: `unknown mechanism "${parsed.graft.frontmatter.mechanism}" (available: ${this.adapterNames.join(', ')})`,
      });
    }
    if (!parsed.graft || diagnostics.some((d) => d.severity === 'error')) {
      return { id, dir, file, diagnostics };
    }
    return { id, dir, file, ...parsed.graft, diagnostics };
  }

  /** Load one graft by id. Throws a GraftError listing diagnostics if it is invalid. */
  async get(id: string): Promise<Graft> {
    const file = path.join(this.graftsDir, id, GRAFT_FILE);
    if (!existsSync(file)) throw new GraftError(`no graft "${id}" (expected ${file})`, 'graft/not-found');
    const result = await this.loadFile(id, file);
    if (!('frontmatter' in result)) {
      const errors = result.diagnostics.filter((d) => d.severity === 'error').map((d) => `  - ${d.message}`);
      throw new GraftError(`graft "${id}" is invalid:\n${errors.join('\n')}`, 'graft/invalid');
    }
    return result;
  }

  adapterFor(graft: Graft): MechanismAdapter {
    const adapter = this.adapters.get(graft.frontmatter.mechanism);
    if (!adapter) throw new GraftError(`unknown mechanism "${graft.frontmatter.mechanism}"`, 'adapter/unknown');
    return adapter;
  }

  context(graft: Graft): GraftContext {
    return { project: this, graft };
  }

  resolveVariant(graft: Graft, ref: VariantRef): ResolvedVariant {
    return { ...ref, path: path.resolve(graft.dir, ref.module) };
  }

  /** The variant valid for `version`, or null. */
  selectVariant(graft: Graft, version: string): ResolvedVariant | null {
    const ref = selectVariant(graft.frontmatter.variants, version);
    return ref ? this.resolveVariant(graft, ref) : null;
  }

  /** Import a module (TS or JS) fresh from disk. */
  async loadModule<T = unknown>(file: string): Promise<T> {
    if (!existsSync(file)) throw new GraftError(`module not found: ${file}`, 'module/not-found');
    return this.jiti.import<T>(file, { default: true });
  }

  async installedVersion(pkg: string): Promise<string | undefined> {
    return (await this.upstream.installed(pkg))?.version;
  }
}
