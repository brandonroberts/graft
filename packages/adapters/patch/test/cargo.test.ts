// The cargo ecosystem and its cargo-vendor applier, against real cargo and crates.io (`itoa`, a
// small crate with frequent releases). Skipped where cargo isn't installed.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyToProject, checkAnchors, outdated, Project, sparseIndexPath, sync } from '@graftsync/core';
import {
  getTomlValue,
  inlineTableString,
  patchAdapter,
  removeTomlValue,
  selectApplier,
  setTomlValue,
  unusedPatches,
} from '../src/index.js';

describe('TOML editing', () => {
  const CARGO = `# app
[package]
name = "app" # trailing comment
version = "0.1.0"

[dependencies]
itoa = "1.0"
`;

  it('adds a table at the end, then sets and replaces a key, keeping comments', () => {
    let t = setTomlValue(CARGO, 'patch.crates-io', 'itoa', '{ path = "a" }');
    expect(t).toBe(`${CARGO}\n[patch.crates-io]\nitoa = { path = "a" }\n`);
    t = setTomlValue(t, 'patch.crates-io', 'itoa', '{ path = "b" }');
    t = setTomlValue(t, 'patch.crates-io', 'serde', '{ path = "s" }');
    expect(t).toContain('name = "app" # trailing comment');
    expect(getTomlValue(t, 'patch.crates-io', 'itoa')).toBe('{ path = "b" }');
    expect(inlineTableString(getTomlValue(t, 'patch."crates-io"', 'serde'), 'path')).toBe('s');
    expect(removeTomlValue(removeTomlValue(t, 'patch.crates-io', 'itoa'), 'patch.crates-io', 'serde')).toBe(CARGO);
  });

  it('refuses layouts it cannot edit safely', () => {
    expect(() =>
      setTomlValue(`${CARGO}\n[patch]\ncrates-io.itoa = { path = "x" }\n`, 'patch.crates-io', 'itoa', '{}', 'Cargo.toml'),
    ).toThrow(/dotted keys or an inline table/);
    expect(() =>
      setTomlValue(`${CARGO}\n[patch.crates-io]\nitoa = { path = "x",\n  features = [] }\n`, 'patch.crates-io', 'itoa', '{}', 'Cargo.toml'),
    ).toThrow(/spans several lines/);
  });
});

describe('cargo helpers', () => {
  it('finds sparse-index paths and unused patches', () => {
    expect(['a', 'ab', 'syn', 'itoa', 'Serde'].map(sparseIndexPath)).toEqual(['1/a', '2/ab', '3/s/syn', 'it/oa/itoa', 'se/rd/serde']);
    const lock = `version = 4\n\n[[package]]\nname = "itoa"\nversion = "1.0.19"\n\n[[patch.unused]]\nname = "itoa"\nversion = "1.0.18"\n`;
    expect(unusedPatches(lock)).toEqual([{ name: 'itoa', version: '1.0.18' }]);
  });
});

const hasCargo = spawnSync('cargo', ['--version']).status === 0;

// Built from lines: a blank context line is a single space, which editors and formatters strip.
const PATCH = [
  'diff --git a/src/lib.rs b/src/lib.rs',
  '--- a/src/lib.rs',
  '+++ b/src/lib.rs',
  '@@ -91,6 +91,11 @@ impl Clone for Buffer {',
  '     }',
  ' }',
  ' ',
  '+/// Added by a graft.',
  "+pub fn grafted() -> &'static str {",
  '+    "grafted"',
  '+}',
  '+',
  ' impl Buffer {',
  "     /// This is a cheap operation; you don't need to worry about reusing buffers",
  '     /// for efficiency.',
  '',
].join('\n');

async function cargoProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-cargo-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'Cargo.toml'),
    `# the app\n[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nitoa = "1.0"\n`,
  );
  await writeFile(path.join(root, 'src/main.rs'), 'fn main() { println!("{} {}", itoa::grafted(), itoa::Buffer::new().format(7)); }\n');
  const cargo = (...args: string[]) => execFileSync('cargo', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  cargo('generate-lockfile', '-q');
  cargo('update', '-q', '-p', 'itoa', '--precise', '1.0.17');
  const g = path.join(root, '.grafts', 'itoa-grafted');
  await mkdir(path.join(g, 'variants'), { recursive: true });
  await writeFile(path.join(g, 'variants', 'v1.patch'), PATCH);
  await writeFile(
    path.join(g, 'graft.md'),
    `---\nid: itoa-grafted\nrootstock: { package: itoa, ecosystem: cargo, verified: 1.0.17 }\nmechanism: patch\nvariants:\n  - range: ">=1.0.0-0"\n    module: ./variants/v1.patch\n---\n## Why\nw\n## Invariants\nitoa::grafted() returns "grafted" (src/main.rs)\n## Where to look\nl\n## Anchors\na\n## History\n- created\n`,
  );
  const project = await Project.open({ root, adapters: [patchAdapter] });
  return { root, project, cargo };
}

describe.skipIf(!hasCargo)('cargo-vendor applier (real cargo, crates.io)', () => {
  it('vendors the patched crate, syncs to a new release, and catches every way the patch can go unused', { timeout: 240_000 }, async () => {
    const { root, project, cargo } = await cargoProject();
    expect(selectApplier(root, undefined, 'cargo').name).toBe('cargo-vendor');
    expect(await project.installedVersion('itoa', 'cargo')).toBe('1.0.17');

    // Before `graft apply`: the anchors fit, but nothing patches the installed crate.
    const before = await checkAnchors(project, 'itoa-grafted');
    expect(before.anchors.every((a) => a.matched)).toBe(true);
    expect(before.errors.join('\n')).toMatch(/has no \[patch\.crates-io\] entry for itoa/);
    expect(before.ok).toBe(false);

    const applied = await applyToProject(project);
    expect(applied.errors).toEqual([]);
    expect(applied.installCommand).toMatch(/^cargo fetch/);
    expect(applied.anchors[0]!.ok).toBe(true);
    const manifest = await readFile(path.join(root, 'Cargo.toml'), 'utf8');
    expect(manifest).toContain('# the app');
    expect(manifest).toContain('[patch.crates-io]\nitoa = { path = ".grafts/.vendor/itoa-1.0.17" }');
    // The build really uses the patched crate.
    expect(cargo('run', '-q').trim()).toBe('grafted 7');

    // A new release whose code still fits: sync re-vendors it and cargo follows.
    const report = await sync(project, { version: '1.0.18', install: true });
    expect(report.grafts[0]).toMatchObject({ outcome: 'green', ecosystem: 'cargo', from: '1.0.17', to: '1.0.18' });
    expect(await project.installedVersion('itoa', 'cargo')).toBe('1.0.18');
    expect(await readFile(path.join(root, 'Cargo.toml'), 'utf8')).toContain('itoa = { path = ".grafts/.vendor/itoa-1.0.18" }');
    expect((await checkAnchors(project, 'itoa-grafted')).ok).toBe(true);

    // A vendored file edited by hand is not pristine + variant.
    await appendFile(path.join(root, '.grafts/.vendor/itoa-1.0.18/src/udiv128.rs'), '// edited\n');
    expect((await checkAnchors(project, 'itoa-grafted')).errors.join('\n')).toMatch(/itoa-1\.0\.18 is stale: src\/udiv128\.rs/);
    await applyToProject(project);
    expect((await checkAnchors(project, 'itoa-grafted')).ok).toBe(true);

    // The silent failure: a requirement the vendored version can't meet. cargo only warns and
    // records [[patch.unused]]; graft check must fail.
    await writeFile(
      path.join(root, 'Cargo.toml'),
      (await readFile(path.join(root, 'Cargo.toml'), 'utf8')).replace('itoa = "1.0"', 'itoa = "=1.0.19"'),
    );
    cargo('fetch', '-q');
    expect(await readFile(path.join(root, 'Cargo.lock'), 'utf8')).toContain('[[patch.unused]]');
    const unused = await checkAnchors(project, 'itoa-grafted');
    expect(unused.ok).toBe(false);
    expect(unused.errors.join('\n')).toMatch(/\[\[patch\.unused\]\]: cargo is NOT using the patched crate/);
    expect(unused.errors.join('\n')).toMatch(/installed itoa@1\.0\.19 src\/lib\.rs is not patched/);

    const [entry] = await outdated(project);
    expect(entry).toMatchObject({ package: 'itoa', ecosystem: 'cargo', verified: '1.0.18' });
    expect(entry!.distTags.latest).toMatch(/^1\./);
  });
});
