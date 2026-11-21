import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cargoEcosystem,
  declaredPypiDependencies,
  findCargoSiblings,
  findGoSiblings,
  findPypiSiblings,
  goEcosystem,
  goRepoKey,
  parseGoListJsonStream,
  Project,
  pypiEcosystem,
  pypiRepoKey,
  repositoryKey,
} from '../src/index.js';

describe('siblings outside npm: Cargo, Go, PyPI (#56)', () => {
  it('normalizes repository keys for monorepo URLs, Go module paths, and PyPI metadata', () => {
    expect(repositoryKey('https://github.com/acme/kit/tree/main/crates/kit')).toBe('github.com/acme/kit');
    expect(repositoryKey('git+https://github.com/acme/kit.git')).toBe('github.com/acme/kit');

    expect(goRepoKey('github.com/acme/kit')).toBe('github.com/acme/kit');
    expect(goRepoKey('github.com/acme/kit/sub/v2')).toBe('github.com/acme/kit');
    expect(goRepoKey('golang.org/x/tools/gopls')).toBe('golang.org/x/tools');
    expect(goRepoKey('go.opentelemetry.io/otel')).toBe('go.opentelemetry.io/otel');
    expect(goRepoKey('go.opentelemetry.io/otel/sdk')).toBe('go.opentelemetry.io/otel');
    expect(goRepoKey('gopkg.in/yaml.v3')).toBe('gopkg.in/yaml');
    expect(goRepoKey('gopkg.in/ini.v1')).toBe('gopkg.in/ini');

    expect(
      pypiRepoKey(['Homepage, https://example.com', 'Repository, https://github.com/acme/kit/tree/main/pkg-a'], 'https://other.invalid'),
    ).toBe('github.com/acme/kit');
    expect(pypiRepoKey(['Source Code, https://github.com/acme/kit.git'])).toBe('github.com/acme/kit');
    expect(pypiRepoKey([], 'https://github.com/acme/kit')).toBe('github.com/acme/kit');
    expect(pypiRepoKey([], 'UNKNOWN')).toBeUndefined();

    expect(parseGoListJsonStream('{"Path":"a","Version":"v1.0.0"}\n{"Path":"b","Version":"v1.0.0","Indirect":true}\n')).toEqual([
      { Path: 'a', Version: 'v1.0.0' },
      { Path: 'b', Version: 'v1.0.0', Indirect: true },
    ]);
  });

  it('finds Cargo siblings with real `cargo metadata` (same repository and version, directly declared)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-cargo-siblings-'));
    const makeCrate = async (dir: string, name: string, version: string, repo: string, deps = '') => {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(
        path.join(dir, 'Cargo.toml'),
        `[package]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\nedition = "2021"\nrepository = ${JSON.stringify(repo)}\n${deps ? `\n[dependencies]\n${deps}\n` : ''}`,
      );
      await writeFile(path.join(dir, 'src/lib.rs'), '');
    };
    const crates = path.join(root, 'vendor');
    await makeCrate(path.join(crates, 'kit-internal'), 'kit-internal', '1.0.0', 'https://github.com/acme/kit');
    await makeCrate(path.join(crates, 'kit-core'), 'kit-core', '1.0.0', 'https://github.com/acme/kit');
    await makeCrate(
      path.join(crates, 'kit'),
      'kit',
      '1.0.0',
      'https://github.com/acme/kit',
      'kit-internal = { path = "../kit-internal" }\nkit-core = { version = "=1.0.0", path = "../kit-core" }',
    );
    await makeCrate(path.join(crates, 'kit-macros'), 'kit-macros', '1.0.0', 'https://github.com/acme/kit.git');
    await makeCrate(path.join(crates, 'kit-old'), 'kit-old', '0.9.0', 'https://github.com/acme/kit');
    await makeCrate(path.join(crates, 'other'), 'other', '1.0.0', 'https://github.com/acme/other');

    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(
      path.join(root, 'Cargo.toml'),
      `[package]
name = "app"
version = "0.1.0"
edition = "2021"

[dependencies]
kit = { path = "vendor/kit" }
kit-macros = { path = "vendor/kit-macros" }
kit-old = { path = "vendor/kit-old" }
other = { path = "vendor/other" }
`,
    );
    await writeFile(path.join(root, 'src/lib.rs'), '');

    const project = await Project.open({ root, adapters: [] });
    // kit-macros (declared, same repo, same version) and kit-core (transitive exact-version
    // `=1.0.0` lockstep dep, #93) match; kit-old (different version), other (different repo),
    // and kit-internal (loose transitive helper) are excluded.
    expect(await findCargoSiblings(project, 'kit')).toEqual(['kit-core', 'kit-macros']);
    expect(await findCargoSiblings(project, 'other')).toEqual([]);
  });

  it('finds Go siblings with real `go list -m -json all` and passes them together to `go get`', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-go-siblings-'));
    const makeMod = async (dir: string, modPath: string) => {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'go.mod'), `module ${modPath}\n\ngo 1.21\n`);
      await writeFile(path.join(dir, 'lib.go'), 'package lib\n');
    };
    const mods = path.join(root, 'mods');
    await makeMod(path.join(mods, 'kit'), 'github.com/acme/kit');
    await makeMod(path.join(mods, 'kit-sub'), 'github.com/acme/kit/sub');
    await makeMod(path.join(mods, 'kit-old'), 'github.com/acme/kit/old');
    await makeMod(path.join(mods, 'kit-ind'), 'github.com/acme/kit/ind');
    await makeMod(path.join(mods, 'other'), 'github.com/acme/other');

    await writeFile(
      path.join(root, 'go.mod'),
      `module example.com/app

go 1.21

require (
	github.com/acme/kit v1.0.0
	github.com/acme/kit/sub v1.0.0
	github.com/acme/kit/old v0.9.0
	github.com/acme/other v1.0.0
)

require github.com/acme/kit/ind v1.0.0 // indirect

replace (
	github.com/acme/kit v1.0.0 => ./mods/kit
	github.com/acme/kit/sub v1.0.0 => ./mods/kit-sub
	github.com/acme/kit/old v0.9.0 => ./mods/kit-old
	github.com/acme/kit/ind v1.0.0 => ./mods/kit-ind
	github.com/acme/other v1.0.0 => ./mods/other
)
`,
    );

    const project = await Project.open({ root, adapters: [] });
    expect(await findGoSiblings(project, 'github.com/acme/kit')).toEqual(['github.com/acme/kit/sub']);
    expect(await findGoSiblings(project, 'github.com/acme/other')).toEqual([]);

    // Verify goEcosystem.install passes all modules in one `go get` call.
    const binDir = path.join(root, 'fake-bin');
    const logFile = path.join(root, 'go.log');
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, 'go'), `#!/bin/sh\necho "$@" > "${logFile}"\n`, { mode: 0o755 });
    const prevPath = process.env.PATH ?? '';
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    try {
      const cmd = await goEcosystem.install(project, 'github.com/acme/kit', '1.1.0', ['github.com/acme/kit/sub']);
      expect(cmd).toBe('go get github.com/acme/kit@v1.1.0 github.com/acme/kit/sub@v1.1.0');
    } finally {
      process.env.PATH = prevPath;
    }
    expect((await readFile(logFile, 'utf8')).trim()).toBe('get github.com/acme/kit@v1.1.0 github.com/acme/kit/sub@v1.1.0');
  });

  it('finds PyPI siblings with real Python importlib.metadata and upgrades them together', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-pypi-siblings-'));
    const site = path.join(root, 'site');
    const makeDist = async (name: string, version: string, metaLines: string[]) => {
      const distInfo = path.join(site, `${name.replace(/-/g, '_')}-${version}.dist-info`);
      await mkdir(distInfo, { recursive: true });
      await writeFile(
        path.join(distInfo, 'METADATA'),
        [`Metadata-Version: 2.1`, `Name: ${name}`, `Version: ${version}`, ...metaLines, ''].join('\n'),
      );
    };
    await makeDist('kit', '1.0.0', ['Project-URL: Repository, https://github.com/acme/kit']);
    await makeDist('kit-ext', '1.0.0', ['Project-URL: Source Code, https://github.com/acme/kit/tree/main/ext']);
    await makeDist('kit-old', '0.9.0', ['Project-URL: Repository, https://github.com/acme/kit']);
    await makeDist('kit-transitive', '1.0.0', ['Project-URL: Repository, https://github.com/acme/kit']);
    await makeDist('other', '1.0.0', ['Home-page: https://github.com/acme/other']);

    await writeFile(
      path.join(root, 'pyproject.toml'),
      `[project]
name = "app"
version = "0.1.0"
dependencies = [
  "kit==1.0.0",
  "kit_ext>=1.0.0",
  "other==1.0.0",
]

[project.optional-dependencies]
dev = ["kit-old==0.9.0"]
`,
    );

    const project = await Project.open({ root, adapters: [] });
    expect([...(await declaredPypiDependencies(project))].sort()).toEqual(['kit', 'kit-ext', 'kit-old', 'other']);

    const prevPyPath = process.env.PYTHONPATH;
    process.env.PYTHONPATH = prevPyPath ? `${site}${path.delimiter}${prevPyPath}` : site;
    try {
      expect(await findPypiSiblings(project, 'kit')).toEqual(['kit-ext']);
      expect(await findPypiSiblings(project, 'other')).toEqual([]);
    } finally {
      if (prevPyPath === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = prevPyPath;
    }

    // Verify uv install upgrades rootstock + siblings together in one `uv lock` call.
    await writeFile(path.join(root, 'uv.lock'), '');
    const binDir = path.join(root, 'fake-bin');
    const logFile = path.join(root, 'uv.log');
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, 'uv'), `#!/bin/sh\necho "$@" >> "${logFile}"\n`, { mode: 0o755 });
    const prevPath = process.env.PATH ?? '';
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    try {
      const cmd = await pypiEcosystem.install(project, 'kit', '1.1.0', ['kit-ext']);
      expect(cmd).toBe('uv lock --upgrade-package kit==1.1.0 --upgrade-package kit-ext==1.1.0 && uv sync');
    } finally {
      process.env.PATH = prevPath;
    }
    expect((await readFile(logFile, 'utf8')).trim().split('\n')).toEqual([
      'lock --upgrade-package kit==1.1.0 --upgrade-package kit-ext==1.1.0',
      'sync',
    ]);

    // Verify pip install bumps exact == pins in requirements.txt so a subsequent reinstall does not downgrade.
    const pipRoot = await mkdtemp(path.join(os.tmpdir(), 'graft-pip-siblings-'));
    await writeFile(path.join(pipRoot, 'requirements.txt'), 'kit==1.0.0 # main\nkit-ext==1.0.0\nother==1.0.0\n');
    const pipBin = path.join(pipRoot, 'fake-bin');
    const pipLog = path.join(pipRoot, 'pip.log');
    await mkdir(pipBin, { recursive: true });
    const fakePy = path.join(pipBin, 'python3');
    await writeFile(fakePy, `#!/bin/sh\necho "$@" > "${pipLog}"\n`, { mode: 0o755 });
    await mkdir(path.join(pipRoot, '.grafts'), { recursive: true });
    await writeFile(path.join(pipRoot, '.grafts/config.json'), JSON.stringify({ ecosystems: { pypi: { python: fakePy } } }));
    const pipProject = await Project.open({ root: pipRoot, adapters: [] });
    await pypiEcosystem.install(pipProject, 'kit', '1.1.0', ['kit-ext']);
    expect(await readFile(path.join(pipRoot, 'requirements.txt'), 'utf8')).toBe('kit==1.1.0 # main\nkit-ext==1.1.0\nother==1.0.0\n');
    expect((await readFile(pipLog, 'utf8')).trim()).toBe('-m pip install kit==1.1.0 kit-ext==1.1.0');
  });

  it('updates Cargo siblings atomically dependents-first (ignoring dev-dep cycles) with per-crate fallback (#56, #93)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-cargo-install-'));
    await writeFile(path.join(root, 'Cargo.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n');
    const binDir = path.join(root, 'fake-bin');
    const logFile = path.join(root, 'cargo.log');
    await mkdir(binDir, { recursive: true });
    // Fake cargo: `metadata` reports `kit` depending on `kit-macros`, and `kit-macros` having a
    // dev-dependency back on `kit` (which must not break dependents-first ordering).
    const metaJson = JSON.stringify({
      workspace_root: root,
      workspace_members: ['app#0.1.0'],
      packages: [
        {
          id: 'app#0.1.0',
          name: 'app',
          version: '0.1.0',
          source: null,
          manifest_path: path.join(root, 'Cargo.toml'),
          dependencies: [{ name: 'kit' }, { name: 'kit-macros' }],
        },
        {
          id: 'kit#1.0.0',
          name: 'kit',
          version: '1.0.0',
          source: 'registry+x',
          manifest_path: '/r/kit/Cargo.toml',
          dependencies: [{ name: 'kit-macros', req: '=1.0.0', kind: null }],
        },
        {
          id: 'kit-macros#1.0.0',
          name: 'kit-macros',
          version: '1.0.0',
          source: 'registry+x',
          manifest_path: '/r/kit-macros/Cargo.toml',
          dependencies: [{ name: 'kit', req: '^1', kind: 'dev' }],
        },
      ],
    });
    await writeFile(path.join(root, 'meta.json'), metaJson);
    await writeFile(
      path.join(binDir, 'cargo'),
      `#!/bin/sh\nif [ "$1" = "metadata" ]; then cat "${path.join(root, 'meta.json')}"; exit 0; fi\necho "$@" >> "${logFile}"\n`,
      { mode: 0o755 },
    );

    const project = await Project.open({ root, adapters: [] });
    const prevPath = process.env.PATH ?? '';
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    try {
      // Pass kit-macros first; atomic update lists `kit` before `kit-macros` and follows with `fetch`.
      await cargoEcosystem.install(project, 'kit-macros', '1.1.0', ['kit']);
      const calls = (await readFile(logFile, 'utf8')).trim().split('\n');
      expect(calls[0]).toContain('-p kit@1.0.0 -p kit-macros@1.0.0 --precise 1.1.0');
      expect(calls[1]).toMatch(/^fetch --manifest-path /);

      // When multi-`-p` fails (older Cargo), falls back to per-crate dependents-first updates.
      await writeFile(logFile, '');
      await writeFile(
        path.join(binDir, 'cargo'),
        [
          '#!/bin/sh',
          `if [ "$1" = "metadata" ]; then cat "${path.join(root, 'meta.json')}"; exit 0; fi`,
          'case "$*" in *"-p kit@1.0.0 -p kit-macros@1.0.0"*) echo "multiple -p unsupported" >&2; exit 1 ;; esac',
          `echo "$@" >> "${logFile}"`,
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      await cargoEcosystem.install(project, 'kit-macros', '1.1.0', ['kit']);
      const fallback = (await readFile(logFile, 'utf8')).trim().split('\n');
      expect(fallback[0]).toContain('-p kit@1.0.0 --precise 1.1.0');
      expect(fallback[1]).toContain('-p kit-macros@1.0.0 --precise 1.1.0');
      expect(fallback[2]).toMatch(/^fetch --manifest-path /);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
