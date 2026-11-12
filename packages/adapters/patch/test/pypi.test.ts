// The pypi ecosystem and its wheel-vendor applier, against real pip / uv and PyPI (`packaging`, a
// pure-Python wheel with regular releases). Each part is skipped where its tool is missing.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyToProject, checkAnchors, outdated, Project, readZip, sync, writeZip } from '@graftsync/core';
import { patchAdapter, selectApplier } from '../src/index.js';

describe('zip', () => {
  it('round-trips entries with their modes', () => {
    const entries = [
      { name: 'pkg/__init__.py', data: Buffer.from('x = 1\n') },
      { name: 'pkg-1.0.data/scripts/run', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
      { name: 'pkg-1.0.dist-info/RECORD', data: Buffer.alloc(0) },
    ];
    const zip = writeZip(entries);
    expect(writeZip(entries).equals(zip)).toBe(true); // deterministic
    expect(readZip(zip).map((e) => [e.name, e.data.toString(), e.mode])).toEqual([
      ['pkg/__init__.py', 'x = 1\n', 0o644],
      ['pkg-1.0.data/scripts/run', '#!/bin/sh\n', 0o755],
      ['pkg-1.0.dist-info/RECORD', '', 0o644],
    ]);
  });
});

const hasPip = spawnSync('python3', ['-m', 'pip', '--version']).status === 0 && spawnSync('python3', ['-m', 'venv', '--help']).status === 0;
const hasUv = spawnSync('uv', ['--version']).status === 0;
const env = { ...process.env, UV_NATIVE_TLS: undefined, PIP_DISABLE_PIP_VERSION_CHECK: '1' };

// Built from lines: a blank context line is a single space, which editors and formatters strip.
const PATCH = [
  'diff --git a/packaging/__init__.py b/packaging/__init__.py',
  '--- a/packaging/__init__.py',
  '+++ b/packaging/__init__.py',
  '@@ -13,3 +13,5 @@',
  ' ',
  ' __license__ = "BSD-2-Clause or Apache-2.0"',
  ' __copyright__ = "2014 %s" % __author__',
  '+',
  '+GRAFTED = "grafted"',
  '',
].join('\n');

async function writeGraft(root: string) {
  const g = path.join(root, '.grafts', 'packaging-grafted');
  await mkdir(path.join(g, 'variants'), { recursive: true });
  await writeFile(path.join(g, 'variants', 'v24.patch'), PATCH);
  await writeFile(
    path.join(g, 'graft.md'),
    `---\nid: packaging-grafted\nrootstock: { package: packaging, ecosystem: pypi, verified: "24.0" }\nmechanism: patch\nvariants:\n  - range: ">=24.dev0"\n    module: ./variants/v24.patch\n---\n## Why\nw\n## Invariants\npackaging.GRAFTED == "grafted"\n## Where to look\nl\n## Anchors\na\n## History\n- created\n`,
  );
  return Project.open({ root, adapters: [patchAdapter] });
}

const grafted = (root: string) =>
  execFileSync(
    path.join(root, '.venv/bin/python'),
    ['-c', 'import packaging, importlib.metadata as m; print(getattr(packaging, "GRAFTED", "-"), m.version("packaging"))'],
    {
      encoding: 'utf8',
      env,
    },
  ).trim();

describe.skipIf(!hasPip)('wheel-vendor applier with pip (real pip, PyPI)', () => {
  it('installs the patched wheel from requirements.txt, syncs, and catches a dropped patch', { timeout: 240_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-pip-'));
    execFileSync('python3', ['-m', 'venv', '.venv'], { cwd: root, env });
    await writeFile(path.join(root, 'requirements.txt'), '# deps\npackaging==24.0  # pinned\n');
    execFileSync(path.join(root, '.venv/bin/python'), ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'], { cwd: root, env });
    const project = await writeGraft(root);
    expect(selectApplier(root, undefined, 'pypi').name).toBe('wheel-vendor');
    expect(await project.installedVersion('packaging', 'pypi')).toBe('24.0');

    const applied = await applyToProject(project);
    expect(applied.errors).toEqual([]);
    expect(applied.anchors[0]!.ok).toBe(true);
    expect(await readFile(path.join(root, 'requirements.txt'), 'utf8')).toBe(
      '# deps\n./.grafts/.vendor/packaging-24.0-py3-none-any.whl  # pinned\n',
    );
    expect(grafted(root)).toBe('grafted 24.0');

    const report = await sync(project, { version: '24.1', install: true });
    expect(report.grafts[0]).toMatchObject({ outcome: 'green', ecosystem: 'pypi', from: '24.0', to: '24.1' });
    expect(grafted(root)).toBe('grafted 24.1');

    // pip reinstalling the published wheel drops the patch, and pip says nothing about it.
    execFileSync(path.join(root, '.venv/bin/python'), ['-m', 'pip', 'install', '-q', '--force-reinstall', '--no-deps', 'packaging==24.1'], {
      cwd: root,
      env,
    });
    const dropped = await checkAnchors(project, 'packaging-grafted');
    expect(dropped.ok).toBe(false);
    expect(dropped.errors.join('\n')).toMatch(/installed packaging@24\.1 packaging\/__init__\.py is not patched/);

    const [entry] = await outdated(project);
    expect(entry).toMatchObject({ package: 'packaging', ecosystem: 'pypi', verified: '24.1' });
    expect(Number(entry!.distTags.latest!.split('.')[0])).toBeGreaterThanOrEqual(25);
  });
});

describe.skipIf(!hasUv)('wheel-vendor applier with uv (real uv, PyPI)', () => {
  it('points [tool.uv.sources] at the patched wheel, syncs, and catches a stale lock', { timeout: 240_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-uv-'));
    execFileSync('uv', ['init', '-q', '--app', '--name', 'app', '--no-workspace'], { cwd: root, env });
    execFileSync('uv', ['add', '-q', 'packaging==24.0'], { cwd: root, env });
    const project = await writeGraft(root);

    const before = await checkAnchors(project, 'packaging-grafted');
    expect(before.errors.join('\n')).toMatch(/no \[tool\.uv\.sources\] entry for packaging/);
    const applied = await applyToProject(project);
    expect(applied.errors).toEqual([]);
    expect(applied.installCommand).toBe('uv lock --upgrade-package packaging && uv sync');
    expect(applied.anchors[0]!.ok).toBe(true);
    expect(await readFile(path.join(root, 'pyproject.toml'), 'utf8')).toContain(
      '[tool.uv.sources]\npackaging = { path = ".grafts/.vendor/packaging-24.0-py3-none-any.whl" }',
    );
    expect(grafted(root)).toBe('grafted 24.0');

    const report = await sync(project, { version: '24.1', install: true });
    expect(report.grafts[0]).toMatchObject({ outcome: 'green', from: '24.0', to: '24.1' });
    expect(grafted(root)).toBe('grafted 24.1');

    // A wheel rebuilt by hand: stale, and uv.lock pins the old build's hash.
    const wheel = path.join(root, '.grafts/.vendor/packaging-24.1-py3-none-any.whl');
    const entries = readZip(await readFile(wheel)).map((e) =>
      e.name === 'packaging/__init__.py' ? { ...e, data: Buffer.concat([e.data, Buffer.from('# edited\n')]) } : e,
    );
    await writeFile(wheel, writeZip(entries));
    const stale = (await checkAnchors(project, 'packaging-grafted')).errors.join('\n');
    expect(stale).toMatch(/packaging-24\.1-py3-none-any\.whl is stale/);
    expect(stale).toMatch(/uv\.lock pins another build/);
  });
});
