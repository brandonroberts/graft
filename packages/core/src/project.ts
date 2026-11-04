import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createJiti } from 'jiti';
import { ACTIVE_STATUSES, parseGraft, selectVariant, type Diagnostic, type VariantRef } from '@graftsync/spec';
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
  /**
   * Per-package directory, relative to the project root, whose node_modules resolution
   * determines the installed version (e.g. `{ "pacote": "packages/core" }` in a monorepo).
   */
  resolveFrom?: Record<string, string>;
  /** Mechanism-specific options, e.g. `{ "patch": { "applier": "patch-package" } }`. */
  mechanisms?: Record<string, Record<string, unknown>>;
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
        resolveFrom: Object.fromEntries(
          Object.entries(config.resolveFrom ?? {}).map(([pkg, dir]) => [pkg, path.resolve(this.root, dir)]),
        ),
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
    const duplicates = this.duplicateRootstocks(grafts);
    if (!duplicates.size) return { grafts, invalid };
    for (const graft of grafts) {
      const diagnostic = duplicates.get(graft.id);
      if (!diagnostic) continue;
      invalid.push({ id: graft.id, dir: graft.dir, file: graft.file, diagnostics: [...graft.diagnostics, diagnostic] });
    }
    invalid.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { grafts: grafts.filter((g) => !duplicates.has(g.id)), invalid };
  }

  /**
   * Active grafts whose mechanism allows only one graft per package (e.g. one
   * patchedDependencies entry or one vendored tarball) and that share a rootstock package
   * would silently overwrite each other. Returns an error diagnostic per offending graft id.
   */
  private duplicateRootstocks(grafts: Graft[]): Map<string, Diagnostic> {
    const byKey = new Map<string, Graft[]>();
    for (const g of grafts) {
      const fm = g.frontmatter;
      if (!ACTIVE_STATUSES.includes(fm.status) || !this.adapters.get(fm.mechanism)?.exclusivePerPackage) continue;
      const key = `${fm.mechanism}\0${fm.rootstock.package}`;
      byKey.set(key, [...(byKey.get(key) ?? []), g]);
    }
    const out = new Map<string, Diagnostic>();
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      for (const g of group) {
        const others = group.filter((o) => o !== g).map((o) => `"${o.id}"`).join(', ');
        const { mechanism, rootstock } = g.frontmatter;
        out.set(g.id, {
          severity: 'error',
          code: 'graft/duplicate-rootstock',
          path: 'rootstock.package',
          message:
            `graft "${g.id}" and ${others} both patch ${rootstock.package} with the ${mechanism} mechanism, which applies ` +
            `only one graft per package, so one would silently overwrite the other. Merge them into one graft ` +
            `(a single variant can contain patches for several files), or mark one obsolete.`,
        });
      }
    }
    return out;
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

  /**
   * Load one graft by id. Throws a GraftError listing diagnostics if it is invalid, including
   * when it conflicts with another graft on the same package (unless `allowConflicts`, used
   * by bookkeeping edits such as marking one of the conflicting grafts obsolete).
   */
  async get(id: string, options: { allowConflicts?: boolean } = {}): Promise<Graft> {
    const file = path.join(this.graftsDir, id, GRAFT_FILE);
    if (!existsSync(file)) throw new GraftError(`no graft "${id}" (expected ${file})`, 'graft/not-found');
    let result = await this.loadFile(id, file);
    if ('frontmatter' in result && !options.allowConflicts && this.adapters.get(result.frontmatter.mechanism)?.exclusivePerPackage) {
      const { invalid } = await this.loadAll();
      const conflict = invalid.find((g) => g.id === id && g.diagnostics.some((d) => d.code === 'graft/duplicate-rootstock'));
      if (conflict) result = conflict;
    }
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

  /** True when the graft installs nothing into the project (see `MechanismAdapter.standalone`). */
  isStandalone(graft: Graft): boolean {
    return this.adapterFor(graft).standalone?.(graft) ?? false;
  }

  /**
   * The upstream version a graft currently applies to: the installed version of its rootstock,
   * or for standalone grafts (nothing installed) the last verified version.
   */
  async currentVersion(graft: Graft): Promise<string | undefined> {
    return this.isStandalone(graft) ? graft.frontmatter.rootstock.verified : this.installedVersion(graft.frontmatter.rootstock.package);
  }

  async installedVersion(pkg: string): Promise<string | undefined> {
    return (await this.upstream.installed(pkg))?.version;
  }
}
