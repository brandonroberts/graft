// Same-named packages in two ecosystems are separate rootstocks: sync groups and filters them apart.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DirectoryUpstreamSource, Project, sync } from '@graftsync/core';
import { patchAdapter } from '../src/index.js';

const PATCH = [
  'diff --git a/index.js b/index.js',
  '--- a/index.js',
  '+++ b/index.js',
  '@@ -1,1 +1,2 @@',
  ' const a = 1',
  '+const b = 2',
  '',
].join('\n');

async function graft(root: string, id: string, ecosystem: string) {
  const dir = path.join(root, '.grafts', id);
  await mkdir(path.join(dir, 'variants'), { recursive: true });
  await writeFile(path.join(dir, 'variants', 'v1.patch'), PATCH);
  await writeFile(
    path.join(dir, 'graft.md'),
    `---\nid: ${id}\nrootstock: { package: lib, ecosystem: ${ecosystem}, verified: 1.0.0 }\nmechanism: patch\nvariants:\n  - range: ">=1.0.0"\n    module: ./variants/v1.patch\n---\n## Why\nw\n## Invariants\ni\n## Where to look\nl\n## Anchors\na\n## History\n- h\n`,
  );
}

describe('ecosystems in sync', () => {
  it('keeps same-named packages of different ecosystems apart, and filters by ecosystem', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-eco-'));
    const up = path.join(root, 'upstream');
    await mkdir(up);
    await writeFile(path.join(up, 'index.js'), 'const a = 1\n');
    await graft(root, 'npm-lib', 'npm');
    await graft(root, 'crate-lib', 'cargo');
    const source = () => new DirectoryUpstreamSource({ lib: { '1.0.0': up, '1.1.0': up } });
    const project = await Project.open({ root, adapters: [patchAdapter], upstream: source(), upstreams: { cargo: source() } });

    // Both grafts patch "lib" with the patch mechanism (one graft per package), yet neither is a duplicate.
    expect((await project.loadAll()).invalid).toEqual([]);

    // One --version for two packages named "lib" is ambiguous until the ecosystem says which.
    await expect(sync(project, { version: '1.1.0', package: 'lib', dryRun: true, writeReport: false })).rejects.toThrow(
      /ambiguous: selected grafts target cargo:lib, lib/,
    );
    const report = await sync(project, { version: '1.1.0', package: 'lib', ecosystem: 'cargo', dryRun: true, writeReport: false });
    expect(report.grafts.map((g) => [g.id, g.ecosystem])).toEqual([['crate-lib', 'cargo']]);
    expect(report.targets).toEqual([expect.objectContaining({ package: 'lib', ecosystem: 'cargo', version: '1.1.0' })]);
  });
});
