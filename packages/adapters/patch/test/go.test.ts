// The go ecosystem and its go-replace applier, against the real go command and the module proxy
// (golang.org/x/sync, a small module with regular releases). Skipped where go isn't installed.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyToProject, captureVariant, checkAnchors, outdated, Project, sync } from '@graftsync/core';
import { patchAdapter, selectApplier } from '../src/index.js';

const hasGo = spawnSync('go', ['version']).status === 0;
const MOD = 'golang.org/x/sync';

// Built from lines: a blank context line is a single space, which editors and formatters strip.
const PATCH = [
  'diff --git a/errgroup/errgroup.go b/errgroup/errgroup.go',
  '--- a/errgroup/errgroup.go',
  '+++ b/errgroup/errgroup.go',
  '@@ -60,6 +60,9 @@ func (g *Group) Wait() error {',
  '\treturn g.err',
  ' }',
  ' ',
  '+// Grafted reports that this errgroup carries a graft.',
  '+func (g *Group) Grafted() string { return "grafted" }',
  '+',
  ' // Go calls the given function in a new goroutine.',
  ' // It blocks until the new goroutine can be added without the number of',
  ' // active goroutines in the group exceeding the configured limit.',
  '',
]
  .join('\n')
  .replace('\n\treturn g.err', '\n \treturn g.err');

async function goProject(dir?: string) {
  const root = dir ?? (await mkdtemp(path.join(os.tmpdir(), 'graft-go-')));
  await mkdir(root, { recursive: true });
  const go = (...args: string[]) => execFileSync('go', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  await writeFile(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.22\n');
  await writeFile(
    path.join(root, 'main.go'),
    'package main\n\nimport (\n\t"fmt"\n\n\t"golang.org/x/sync/errgroup"\n)\n\nfunc main() { var g errgroup.Group; fmt.Println(g.Grafted()) }\n',
  );
  go('get', `${MOD}@v0.10.0`);
  const g = path.join(root, '.grafts', 'sync-grafted');
  await mkdir(path.join(g, 'variants'), { recursive: true });
  await writeFile(path.join(g, 'variants', 'v0.patch'), PATCH);
  await writeFile(
    path.join(g, 'graft.md'),
    `---\nid: sync-grafted\nrootstock: { package: ${MOD}, ecosystem: go, verified: v0.10.0 }\nmechanism: patch\nvariants:\n  - range: ">=0.10.0 <0.23.0"\n    module: ./variants/v0.patch\n---\n## Why\nw\n## Invariants\nGroup.Grafted() returns "grafted" (main.go)\n## Where to look\nl\n## Anchors\na\n## History\n- created\n`,
  );
  const project = await Project.open({ root, adapters: [patchAdapter] });
  return { root, project, go };
}

describe.skipIf(!hasGo)('go-replace applier (real go, module proxy)', () => {
  it(
    'replaces the module with the patched copy, syncs to a new release, and catches an ignored replace',
    { timeout: 240_000 },
    async () => {
      const { root, project, go } = await goProject();
      expect(selectApplier(root, undefined, 'go').name).toBe('go-replace');
      expect(await project.installedVersion(MOD, 'go')).toBe('v0.10.0');

      // The module cache is read-only and pristine: capture says where to edit instead.
      await expect(captureVariant(project, 'sync-grafted')).rejects.toThrow(/module cache, which is read-only and pristine/);

      const before = await checkAnchors(project, 'sync-grafted');
      expect(before.anchors.every((a) => a.matched)).toBe(true);
      expect(before.errors.join('\n')).toMatch(/go\.mod has no `replace golang\.org\/x\/sync v0\.10\.0 =>/);

      const applied = await applyToProject(project);
      expect(applied.errors).toEqual([]);
      expect(applied.anchors[0]!.ok).toBe(true);
      expect(await readFile(path.join(root, 'go.mod'), 'utf8')).toContain(
        'replace golang.org/x/sync v0.10.0 => ./.grafts/.vendor/golang.org+x+sync-v0.10.0',
      );
      expect(go('run', '.').trim()).toBe('grafted');

      // `0.11.0` without the v: Go versions are normalized. go get moves the require; the replace follows.
      const report = await sync(project, { version: '0.11.0', install: true });
      expect(report.grafts[0]).toMatchObject({ outcome: 'green', ecosystem: 'go', from: 'v0.10.0', to: 'v0.11.0' });
      const mod = await readFile(path.join(root, 'go.mod'), 'utf8');
      expect(mod).toContain('require golang.org/x/sync v0.11.0');
      expect(mod).toContain('replace golang.org/x/sync v0.11.0 => ./.grafts/.vendor/golang.org+x+sync-v0.11.0');
      expect(mod).not.toContain('v0.10.0');
      expect(go('run', '.').trim()).toBe('grafted');

      // graft capture: edit the vendored module (what the replace points at); the variant file has no double v.
      const errgroup = path.join(root, '.grafts/.vendor/golang.org+x+sync-v0.11.0/errgroup/errgroup.go');
      await writeFile(errgroup, (await readFile(errgroup, 'utf8')).replace('return "grafted" }', 'return "grafted, captured" }'));
      expect(await captureVariant(project, 'sync-grafted')).toMatchObject({ module: './variants/v0.11.0.patch', range: '>=0.11.0' });
      await applyToProject(project);
      expect((await checkAnchors(project, 'sync-grafted')).ok).toBe(true);
      expect(go('run', '.').trim()).toBe('grafted, captured');

      // A release where errgroup's code moved: the variant no longer fits, so it needs an agent.
      const moved = await sync(project, { version: 'v0.23.0', dryRun: true, install: true });
      expect(moved.grafts[0]!.outcome).toBe('needs-agent');

      // The silent failure: the require moves on, the version-qualified replace no longer applies.
      go('get', `${MOD}@v0.12.0`);
      const ignored = await checkAnchors(project, 'sync-grafted');
      expect(ignored.ok).toBe(false);
      expect(ignored.errors.join('\n')).toMatch(/uses golang\.org\/x\/sync v0\.12\.0 from .*sync@v0\.12\.0, not the patched v0\.12\.0/);
      // (The installed copy is the module cache itself, the pristine copy, so the go command's own
      // answer is what proves it unpatched.)

      const [entry] = await outdated(project);
      expect(entry).toMatchObject({ package: MOD, ecosystem: 'go', verified: 'v0.11.0' });
      expect(entry!.candidate?.version).toMatch(/^v0\./);
    },
  );

  it('puts the replace in go.work in a workspace', { timeout: 120_000 }, async () => {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'graft-gowork-'));
    const { root, project, go } = await goProject(path.join(ws, 'app'));
    execFileSync('go', ['work', 'init', './app'], { cwd: ws });
    expect((await applyToProject(project)).anchors[0]!.ok).toBe(true);
    expect(await readFile(path.join(ws, 'go.work'), 'utf8')).toContain(
      'replace golang.org/x/sync v0.10.0 => ./app/.grafts/.vendor/golang.org+x+sync-v0.10.0',
    );
    expect(await readFile(path.join(root, 'go.mod'), 'utf8')).not.toContain('replace');
    expect(go('run', '.').trim()).toBe('grafted');
  });
});
