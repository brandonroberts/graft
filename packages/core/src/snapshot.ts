// Transactional file/directory snapshot for `sync --install`: captures workspace manifests,
// package-manager config, lockfiles, and graft-owned applier artifacts before `beforeInstall`
// runs, and restores them verbatim if any install step fails so a failed sync never leaves
// the working tree half-mutated.
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workspaceManifestDirs, workspaceRoot } from './install.js';
import type { Project } from './project.js';
import { npmResolveFrom } from './upstream.js';

const NPM_LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'upm.lock'];

async function walkFiles(dir: string, out: Map<string, Buffer>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkFiles(full, out);
    } else if (e.isFile()) {
      out.set(full, await readFile(full));
    }
  }
}

async function listFiles(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, out);
    else if (e.isFile() || e.isSymbolicLink()) out.push(full);
  }
  return out;
}

async function pruneEmptyDirs(dir: string, keepRoot: boolean): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory()) await pruneEmptyDirs(path.join(dir, e.name), false);
  }
  if (!keepRoot) {
    const remaining = await readdir(dir).catch(() => []);
    if (remaining.length === 0) await rm(dir, { recursive: true, force: true });
  }
}

export class WorkspaceSnapshot {
  private readonly files = new Map<string, Buffer | null>();
  private readonly dirs = new Map<string, Map<string, Buffer> | null>();

  /** Capture each file's current bytes (or `null` if absent). Already-captured paths keep their initial state. */
  async captureFiles(paths: Iterable<string>): Promise<void> {
    for (const p of paths) {
      const abs = path.resolve(p);
      if (this.files.has(abs)) continue;
      const st = await lstat(abs).catch(() => undefined);
      if (!st) {
        this.files.set(abs, null);
      } else if (st.isFile()) {
        this.files.set(abs, await readFile(abs));
      }
    }
  }

  /** Capture every regular file under `dir` recursively (or `null` if `dir` does not exist). */
  async captureDir(dir: string): Promise<void> {
    const abs = path.resolve(dir);
    if (this.dirs.has(abs)) return;
    const st = await lstat(abs).catch(() => undefined);
    if (!st || !st.isDirectory()) {
      this.dirs.set(abs, null);
      return;
    }
    const entries = new Map<string, Buffer>();
    await walkFiles(abs, entries);
    this.dirs.set(abs, entries);
  }

  /**
   * Restore every captured file and directory to its snapshot state, only touching paths whose
   * contents actually diverged. Returns the absolute paths restored or removed.
   */
  async restore(): Promise<string[]> {
    const restored: string[] = [];
    for (const [file, original] of this.files) {
      if (original === null) {
        if (existsSync(file)) {
          await rm(file, { force: true });
          restored.push(file);
        }
      } else {
        const current = await readFile(file).catch(() => undefined);
        if (!current || !current.equals(original)) {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, original);
          restored.push(file);
        }
      }
    }
    for (const [dir, originalMap] of this.dirs) {
      if (originalMap === null) {
        if (existsSync(dir)) {
          await rm(dir, { recursive: true, force: true });
          restored.push(dir);
        }
        continue;
      }
      if (existsSync(dir)) {
        for (const currentFile of await listFiles(dir)) {
          if (!originalMap.has(currentFile)) {
            await rm(currentFile, { force: true });
            restored.push(currentFile);
          }
        }
      } else {
        await mkdir(dir, { recursive: true });
      }
      for (const [file, original] of originalMap) {
        const current = await readFile(file).catch(() => undefined);
        if (!current || !current.equals(original)) {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, original);
          restored.push(file);
        }
      }
      await pruneEmptyDirs(dir, true);
    }
    return restored;
  }
}

/**
 * Snapshot the manifests, package-manager configs, lockfiles, and graft-owned applier directories
 * that `beforeInstall` / `eco.install` / `eco.reinstall` may touch for `ecosystem`.
 */
export async function snapshotInstallConfig(project: Project, ecosystem: string, extraDirs: string[] = []): Promise<WorkspaceSnapshot> {
  const snap = new WorkspaceSnapshot();
  await snap.captureDir(path.join(project.root, '.grafts', '.vendor'));
  await snap.captureDir(path.join(project.root, '.grafts', '.patch-package'));

  if (ecosystem === 'npm') {
    const wsRoot = workspaceRoot(project.root);
    if (wsRoot !== project.root) {
      await snap.captureDir(path.join(wsRoot, '.grafts', '.vendor'));
      await snap.captureDir(path.join(wsRoot, '.grafts', '.patch-package'));
    }
    const resolveFromDirs = Object.values(npmResolveFrom(project.config, project.root));
    const manifestDirs = await workspaceManifestDirs(project.root, [...resolveFromDirs, ...extraDirs]);
    const files = manifestDirs.map((d) => path.join(d, 'package.json'));
    for (const dir of new Set([project.root, wsRoot])) {
      files.push(path.join(dir, 'pnpm-workspace.yaml'));
      for (const lock of NPM_LOCKFILES) files.push(path.join(dir, lock));
    }
    await snap.captureFiles(files);
  } else if (ecosystem === 'cargo') {
    const cargoCfg = project.config.ecosystems?.cargo as { manifest?: string } | undefined;
    const manifest = path.resolve(project.root, cargoCfg?.manifest ?? 'Cargo.toml');
    const dirs = new Set<string>([project.root, path.dirname(manifest)]);
    let dir = path.dirname(manifest);
    for (;;) {
      if (existsSync(path.join(dir, 'Cargo.toml'))) dirs.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const files: string[] = [];
    for (const d of dirs) files.push(path.join(d, 'Cargo.toml'), path.join(d, 'Cargo.lock'));
    await snap.captureFiles(files);
  } else if (ecosystem === 'go') {
    const goCfg = project.config.ecosystems?.go as { module?: string } | undefined;
    const modDir = path.resolve(project.root, goCfg?.module ?? '.');
    const files: string[] = [];
    for (const d of new Set([project.root, modDir])) files.push(path.join(d, 'go.mod'), path.join(d, 'go.sum'));
    await snap.captureFiles(files);
  } else if (ecosystem === 'pypi') {
    const pypiCfg = project.config.ecosystems?.pypi as { requirements?: string } | undefined;
    const req = path.resolve(project.root, pypiCfg?.requirements ?? 'requirements.txt');
    await snap.captureFiles([
      path.join(project.root, 'pyproject.toml'),
      path.join(project.root, 'requirements.txt'),
      req,
      path.join(project.root, 'uv.lock'),
      path.join(project.root, 'poetry.lock'),
    ]);
  }

  return snap;
}
