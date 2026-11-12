// Python packages from PyPI (or another index), installed by uv or pip.
//
//   pristine   the published wheel (what gets installed into site-packages), downloaded with
//              `pip download --no-deps --only-binary :all:` (the project's pip configuration and
//              index apply) and extracted; its filename is kept for the vendored wheel. The
//              sdist is a different artifact (source layout, a build step): grafts on source
//              belong in the fork mechanism.
//   versions   the index's JSON API (`<index>/<name>/json`), yanked releases skipped
//   installed  the project's interpreter: importlib.metadata's version and site-packages dir
//   install    uv: `uv lock --upgrade-package <name>==<version>` + `uv sync`;
//              pip: `python -m pip install <name>==<version>`
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pep440Scheme } from '@graftsync/spec';
import { ecosystemOptions, type Ecosystem } from '../ecosystem.js';
import { GraftError } from '../errors.js';
import type { Project } from '../project.js';
import type { InstalledPackage, PackageVersions, UpstreamSource } from '../upstream.js';
import { readZip } from '../zip.js';
import { channelTags, fetchText, tool } from './util.js';

export interface PypiOptions extends Record<string, unknown> {
  /** The project's interpreter. Default: `.venv/bin/python` (or `.venv\Scripts\python.exe`) if present, else `python3`. */
  python?: string;
  /** The index's JSON API base, for `outdated` and `replay`. Default: `https://pypi.org/pypi`. */
  index?: string;
  /** Download the wheel for this platform tag (packages with platform wheels only), e.g. `manylinux_2_28_x86_64`. */
  platform?: string;
  /** pip projects: the requirements file the applier edits. Default: `requirements.txt`. */
  requirements?: string;
}

/** PEP 503 normalized project name (`Typing_Extensions` → `typing-extensions`). */
export const pypiName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');
/** The distribution part of a wheel filename (`typing-extensions` → `typing_extensions`). */
export const wheelDistName = (name: string) => pypiName(name).replace(/-/g, '_');

export function pypiOptions(project: Project): PypiOptions {
  return ecosystemOptions<PypiOptions>(project, 'pypi');
}

/** The project's Python interpreter. */
export function pythonFor(project: Project): string {
  const configured = pypiOptions(project).python;
  if (configured) return path.isAbsolute(configured) || !configured.includes('/') ? configured : path.resolve(project.root, configured);
  for (const p of ['.venv/bin/python', '.venv/Scripts/python.exe'])
    if (existsSync(path.join(project.root, p))) return path.join(project.root, p);
  return 'python3';
}

/** The tool that manages the project's Python dependencies. */
export function detectPythonTool(root: string): 'uv' | 'poetry' | 'pip' {
  if (existsSync(path.join(root, 'uv.lock'))) return 'uv';
  if (existsSync(path.join(root, 'poetry.lock'))) return 'poetry';
  return 'pip';
}

const INSTALLED_SCRIPT = `
import json, sys
from importlib import metadata
try:
    d = metadata.distribution(sys.argv[1])
except metadata.PackageNotFoundError:
    print("null")
    sys.exit(0)
print(json.dumps({"version": d.version, "dir": str(d.locate_file(""))}))
`;

/** A pip that can download: the project's interpreter's, else python3's. */
async function pipCommand(project: Project): Promise<string[]> {
  const python = pythonFor(project);
  for (const py of [python, 'python3']) {
    try {
      await tool(py, ['-m', 'pip', '--version'], { cwd: project.root });
      return [py, '-m', 'pip'];
    } catch {
      // try the next interpreter
    }
  }
  throw new GraftError('pip was not found (Graft uses `pip download` to fetch pristine wheels); install pip for python3', 'upstream/fetch');
}

export class PypiUpstreamSource implements UpstreamSource {
  constructor(private readonly project: Project) {}

  installSpec(pkg: string, version: string): string {
    return `${pkg}==${version}`;
  }

  async installed(pkg: string): Promise<InstalledPackage | undefined> {
    const python = pythonFor(this.project);
    const { stdout } = await tool(python, ['-c', INSTALLED_SCRIPT, pkg], { cwd: this.project.root, code: 'pypi/installed' });
    const info = JSON.parse(stdout.trim()) as { version: string; dir: string } | null;
    return info ? { version: info.version, dir: info.dir } : undefined;
  }

  /** The cached pristine wheel's filename for `pkg@version` (resolving it first). */
  async wheelName(pkg: string, version: string): Promise<string> {
    const dir = await this.resolve(pkg, version);
    return (await readFile(`${dir}.wheel`, 'utf8')).trim();
  }

  async resolve(pkg: string, version: string): Promise<string> {
    const dest = path.join(this.project.cacheDir, 'upstream', 'pypi', `${pypiName(pkg)}@${version}`);
    if (existsSync(`${dest}.wheel`) && existsSync(dest)) return dest;
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    try {
      await mkdir(path.join(tmp, 'dl'), { recursive: true });
      const pip = await pipCommand(this.project);
      const platform = pypiOptions(this.project).platform;
      const args = [
        ...pip.slice(1),
        'download',
        '--no-deps',
        '--only-binary',
        ':all:',
        '--disable-pip-version-check',
        '--dest',
        path.join(tmp, 'dl'),
      ];
      if (platform) args.push('--platform', platform);
      args.push(`${pkg}==${version}`);
      await tool(pip[0]!, args, { cwd: this.project.root, code: 'upstream/fetch' });
      const wheel = (await readdir(path.join(tmp, 'dl'))).find((f) => f.endsWith('.whl'));
      if (!wheel)
        throw new Error('pip downloaded no wheel (Graft patches the wheel; a package with only an sdist needs the fork mechanism)');
      const out = path.join(tmp, 'package');
      for (const e of readZip(await readFile(path.join(tmp, 'dl', wheel)))) {
        const file = path.join(out, e.name);
        if (!file.startsWith(out + path.sep)) throw new Error(`wheel entry ${e.name} is outside the archive`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, e.data, e.mode ? { mode: e.mode } : undefined);
      }
      await rm(dest, { recursive: true, force: true });
      await mkdir(path.dirname(dest), { recursive: true });
      await rename(out, dest);
      await writeFile(`${dest}.wheel`, `${wheel}\n`);
    } catch (err) {
      throw new GraftError(`could not fetch ${pkg}==${version}: ${(err as Error).message}`, 'upstream/fetch', { cause: err });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    return dest;
  }

  async versions(pkg: string): Promise<PackageVersions> {
    const base = (pypiOptions(this.project).index ?? 'https://pypi.org/pypi').replace(/\/+$/, '');
    try {
      const info = JSON.parse(await fetchText(`${base}/${encodeURIComponent(pkg)}/json`)) as {
        releases?: Record<string, { yanked?: boolean }[]>;
      };
      const versions = Object.entries(info.releases ?? {})
        .filter(([v, files]) => pep440Scheme.valid(v) && files.length && !files.every((f) => f.yanked))
        .map(([v]) => v);
      return { versions, distTags: channelTags(versions, pep440Scheme) };
    } catch (err) {
      throw new GraftError(`could not read versions of ${pkg}: ${(err as Error).message}`, 'upstream/versions', { cause: err });
    }
  }
}

/** Names of the projects vendored as wheels under .grafts/.vendor/. */
async function vendoredWheels(project: Project): Promise<{ file: string; name: string }[]> {
  const dir = path.join(project.graftsDir, '.vendor');
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => f.endsWith('.whl')).map((f) => ({ file: path.join(dir, f), name: f.split('-')[0]! }));
}

export const pypiEcosystem: Ecosystem = {
  name: 'pypi',
  scheme: pep440Scheme,
  createUpstream: (project) => new PypiUpstreamSource(project),
  detect: (root) => detectPythonTool(root),
  async install(project, pkg, version) {
    const which = detectPythonTool(project.root);
    if (which === 'uv') {
      await tool('uv', ['lock', '--upgrade-package', `${pkg}==${version}`], { cwd: project.root, code: 'install/failed' });
      await tool('uv', ['sync'], { cwd: project.root, code: 'install/failed' });
      return `uv lock --upgrade-package ${pkg}==${version} && uv sync`;
    }
    if (which === 'poetry') {
      await tool('poetry', ['add', `${pkg}@${version}`], { cwd: project.root, code: 'install/failed' });
      return `poetry add ${pkg}@${version}`;
    }
    const python = pythonFor(project);
    await tool(python, ['-m', 'pip', 'install', `${pkg}==${version}`], { cwd: project.root, code: 'install/failed' });
    return `${python} -m pip install ${pkg}==${version}`;
  },
  async reinstall(project) {
    const which = detectPythonTool(project.root);
    const wheels = await vendoredWheels(project);
    if (which === 'uv') {
      // uv pins a path wheel's hash in uv.lock; a rebuilt wheel needs its entry refreshed.
      const upgrade = wheels.flatMap((w) => ['--upgrade-package', w.name]);
      await tool('uv', ['lock', ...upgrade], { cwd: project.root, code: 'install/failed' });
      await tool('uv', ['sync'], { cwd: project.root, code: 'install/failed' });
      return `uv lock ${upgrade.join(' ')} && uv sync`.replace('  ', ' ');
    }
    if (which === 'poetry') {
      await tool('poetry', ['install'], { cwd: project.root, code: 'install/failed' });
      return 'poetry install';
    }
    const python = pythonFor(project);
    const commands: string[] = [];
    const requirements = path.resolve(project.root, pypiOptions(project).requirements ?? 'requirements.txt');
    if (existsSync(requirements)) {
      await tool(python, ['-m', 'pip', 'install', '-r', requirements], { cwd: project.root, code: 'install/failed' });
      commands.push(`${python} -m pip install -r ${path.relative(project.root, requirements)}`);
    }
    // pip keeps an installed copy of the same name and version ("already satisfied") even when the
    // wheel's contents changed, silently. Force the vendored wheels in.
    if (wheels.length) {
      const args = ['-m', 'pip', 'install', '--force-reinstall', '--no-deps', ...wheels.map((w) => w.file)];
      await tool(python, args, { cwd: project.root, code: 'install/failed' });
      commands.push(
        `${python} -m pip install --force-reinstall --no-deps ${wheels.map((w) => path.relative(project.root, w.file)).join(' ')}`,
      );
    }
    return commands.join(' && ') || 'nothing to reinstall';
  },
};
