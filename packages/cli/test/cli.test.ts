import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Runs the built CLI (`pnpm build` first; CI builds before testing).
const BIN = path.resolve(import.meta.dirname, '../dist/bin.js');

const PRISTINE = 'const a = 1\nconst b = 2\nmodule.exports = { a, b }\n';
const V2 = 'const a = 1\nmodule.exports = { a }\n';
const PATCH_V1 =
  'diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1,3 +1,4 @@\n const a = 1\n const b = 2\n+const c = 3\n module.exports = { a, b }\n';
const PATCH_V2 =
  'diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1,2 +1,3 @@\n const a = 1\n+const c = 3\n module.exports = { a }\n';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-cli-'));
  for (const [v, code] of [
    ['1.0.0', PRISTINE],
    ['2.0.0', V2],
  ] as const) {
    const dir = path.join(root, 'upstream', v);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.js'), code);
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'lib', version: v }));
  }
  // "Installed" copy, and upstream fetched from local directories instead of the registry.
  await mkdir(path.join(root, 'node_modules/lib'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/lib/package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));
  await writeFile(path.join(root, 'node_modules/lib/index.js'), PRISTINE);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { lib: '1.0.0' } }));
  const g = path.join(root, '.grafts/add-c');
  await mkdir(path.join(g, 'variants'), { recursive: true });
  await writeFile(path.join(root, '.grafts/config.json'), JSON.stringify({ upstream: { lib: 'file:../upstream/{version}' } }));
  await writeFile(path.join(g, 'variants/v1.patch'), PATCH_V1);
  await writeFile(
    path.join(g, 'graft.md'),
    `---\nid: add-c\nrootstock: { package: lib, verified: 1.0.0 }\nmechanism: patch\nvariants:\n  - range: ">=1.0.0"\n    module: ./variants/v1.patch\n---\n## Why\nAdds c.\n## Invariants\n- c is 3\n## Where to look\nThe constants.\n## Anchors\nThe const block.\n## History\n- created\n`,
  );
  const graft = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args, '--root', root], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  return { root, g, graft };
}

describe('graft CLI: bookkeeping commands', () => {
  it('show prints the intent, variants and the selected variant', async () => {
    const { graft } = await fixture();
    const r = graft('show', 'add-c', '--json');
    expect(r.code).toBe(0);
    const v = r.json();
    expect(v.sections.Invariants).toBe('- c is 3');
    expect(v.installed).toBe('1.0.0');
    expect(v.selectedForInstalled).toBe('./variants/v1.patch');
    expect(v.variants[0].path).toMatch(/variants\/v1\.patch$/);
    expect(graft('show', 'nope').code).toBe(2);
  });

  it('preview writes the patched files for inspection', async () => {
    const { root, graft } = await fixture();
    const out = path.join(root, 'preview');
    const r = graft('preview', 'add-c', '--out', out);
    expect(r.code).toBe(0);
    expect(await readFile(path.join(out, 'index.js'), 'utf8')).toContain('const c = 3');
    expect(graft('preview', 'add-c', '--version', '2.0.0').code).toBe(1); // v1 no longer fits 2.0.0
  });

  it('variant add registers a new variant, narrowing older ranges, verified against anchors', async () => {
    const { g, graft } = await fixture();
    await writeFile(path.join(g, 'variants/v2.patch'), PATCH_V2);
    const r = graft(
      'variant',
      'add',
      'add-c',
      '--range',
      '>=2.0.0',
      '--module',
      './variants/v2.patch',
      '--verify-version',
      '2.0.0',
      '--note',
      'upstream removed b.',
      '--json',
    );
    expect(r.code).toBe(0);
    expect(r.json().narrowed).toEqual([{ module: './variants/v1.patch', from: '>=1.0.0', to: '>=1.0.0 <2.0.0' }]);
    const md = await readFile(path.join(g, 'graft.md'), 'utf8');
    expect(md).toContain('./variants/v2.patch');
    expect(md).toMatch(/Added variant \.\/variants\/v2\.patch for ">=2\.0\.0".*upstream removed b\./);

    // Existing variants are never re-registered; a variant that doesn't match is refused and rolled back.
    expect(graft('variant', 'add', 'add-c', '--range', '>=3.0.0', '--module', './variants/v1.patch').err).toMatch(
      /never edit an existing variant/,
    );
    await writeFile(path.join(g, 'variants/bad.patch'), PATCH_V1);
    const outside = graft('variant', 'add', 'add-c', '--range', '>=3.0.0', '--module', './variants/bad.patch', '--verify-version', '2.0.0');
    expect(outside.code).toBe(2);
    expect(outside.err).toMatch(/verify version 2\.0\.0 is not in the new variant's range/);
    expect(await readFile(path.join(g, 'graft.md'), 'utf8')).not.toContain('bad.patch');
  });

  it('variant add rolls back a variant whose anchors miss at the verify version', async () => {
    const { g, graft } = await fixture();
    await writeFile(path.join(g, 'variants/bad.patch'), PATCH_V1); // v1's context no longer exists in 2.0.0
    const before = await readFile(path.join(g, 'graft.md'), 'utf8');
    const r = graft('variant', 'add', 'add-c', '--range', '>=2.0.0', '--module', './variants/bad.patch', '--verify-version', '2.0.0');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/does not match lib@2\.0\.0/);
    expect(await readFile(path.join(g, 'graft.md'), 'utf8')).toBe(before);
  });

  it('variant add --no-narrow refuses an overlapping range instead of narrowing', async () => {
    const { g, graft } = await fixture();
    await writeFile(path.join(g, 'variants/v2.patch'), PATCH_V2);
    const r = graft('variant', 'add', 'add-c', '--range', '>=2.0.0', '--module', './variants/v2.patch', '--no-narrow');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/overlaps existing variant/);
  });

  it('check fails on an invalid graft instead of skipping it', async () => {
    const { graft, g } = await fixture();
    const md = await readFile(path.join(g, 'graft.md'), 'utf8');
    await writeFile(path.join(g, 'graft.md'), md.replace('## Anchors\nThe const block.\n', ''));
    const r = graft('check', '--json');
    expect(r.code).toBe(1);
    expect(r.json()).toEqual([
      expect.objectContaining({ graft: 'add-c', ok: false, errors: [expect.stringMatching(/invalid graft\.md: .*Anchors/)] }),
    ]);
  });

  it('mark sets status / verified and appends History, and rejects bad input', async () => {
    const { g, graft } = await fixture();
    const r = graft('mark', 'add-c', '--status', 'upstreamed', '--history', 'lib 3.0 ships this natively.', '--json');
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: 'add-c', status: 'upstreamed', verified: '1.0.0' });
    const md = await readFile(path.join(g, 'graft.md'), 'utf8');
    expect(md).toContain('status: upstreamed');
    expect(md).toMatch(/- \d{4}-\d{2}-\d{2}: lib 3\.0 ships this natively\./);
    expect(graft('mark', 'add-c', '--status', 'bogus').code).toBe(2);
    expect(graft('mark', 'add-c', '--verified', 'not-a-version').code).toBe(2);
    expect(graft('mark', 'add-c').err).toMatch(/nothing to change/);
    expect(existsSync(path.join(g, 'graft.md'))).toBe(true);
  });
});

describe('graft init --agent', () => {
  const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [BIN, 'init', ...args, '--root', cwd], { encoding: 'utf8' });

  it('fails without creating anything when no agent skills folder is detected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-init-'));
    const r = run(root, '--agent');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no agent skills folder found.*--skills-dir/);
    expect(existsSync(path.join(root, '.grafts'))).toBe(false);
  });

  it('installs into the detected agent folder, or into --skills-dir', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graft-init-'));
    await mkdir(path.join(root, '.cursor'));
    const r = run(root, '--agent');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('.cursor/skills (agent folder)');
    expect(existsSync(path.join(root, '.cursor/skills/graft-sync/SKILL.md'))).toBe(true);
    expect(existsSync(path.join(root, '.grafts'))).toBe(true);
    expect(existsSync(path.join(root, '.claude'))).toBe(false);

    const explicit = run(root, '--agent', '--skills-dir', '.agents/skills,.codex/skills');
    expect(explicit.status).toBe(0);
    expect(existsSync(path.join(root, '.agents/skills/graft-sync/SKILL.md'))).toBe(true);
    expect(existsSync(path.join(root, '.codex/skills/graft-sync/SKILL.md'))).toBe(true);
  });
});

describe('graft sync: output of the commands it runs', () => {
  it("streams an upgrade command's output to stderr, also with --json, and --quiet silences it", async () => {
    const { root, graft } = await fixture();
    const v11 = path.join(root, 'upstream', '1.1.0');
    await mkdir(v11, { recursive: true });
    await writeFile(path.join(v11, 'index.js'), PRISTINE);
    await writeFile(path.join(v11, 'package.json'), JSON.stringify({ name: 'lib', version: '1.1.0' }));
    // "Installs" upstream/<version> into node_modules/lib, saying so.
    await writeFile(
      path.join(root, 'upgrade.js'),
      [
        "const fs = require('fs');",
        'const v = process.argv[2];',
        "console.log('migrating lib to ' + v);",
        "for (const f of ['index.js', 'package.json']) fs.copyFileSync('upstream/' + v + '/' + f, 'node_modules/lib/' + f);",
      ].join('\n'),
    );
    await writeFile(
      path.join(root, '.grafts/config.json'),
      JSON.stringify({ upstream: { lib: 'file:../upstream/{version}' }, upgrade: { lib: 'node upgrade.js {version}' } }),
    );
    const r = graft('sync', '--version', '1.1.0', '--install', '--json');
    expect(r.code, r.err).toBe(0);
    expect(r.json().targets[0].installCommand).toBe('node upgrade.js 1.1.0');
    expect(r.err).toContain('migrating lib to 1.1.0');
    expect(r.json().targets[0].installOutput).toBe('migrating lib to 1.1.0'); // and its tail is in the report

    await writeFile(path.join(root, 'node_modules/lib/package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));
    const quiet = graft('sync', '--version', '1.1.0', '--install', '--json', '--quiet');
    expect(quiet.code, quiet.err).toBe(0);
    expect(quiet.err).not.toContain('migrating');
  });

  it('rejects unknown CLI flags and unexpected positional arguments with exit 2 (#80)', async () => {
    const { graft } = await fixture();

    const unknownLong = graft('diff', 'add-c', '--from=1.0.0', '--to=2.0.0');
    expect(unknownLong.code).toBe(2);
    expect(unknownLong.err).toContain('unknown option "--from"');

    const unknownShort = graft('status', '-z');
    expect(unknownShort.code).toBe(2);
    expect(unknownShort.err).toContain('unknown option "-z"');

    const extraPos = graft('sync', 'add-c', '--dry-run');
    expect(extraPos.code).toBe(2);
    expect(extraPos.err).toContain('unexpected argument: "add-c"');

    // Negated boolean flags and string option values starting with "-" remain valid.
    const negated = graft('sync', '--dry-run', '--no-quiet', '--json');
    expect(negated.code).not.toBe(2);
    expect(negated.err).not.toContain('unknown option');
    const dashVal = graft('mark', 'add-c', '--history', '- noted change');
    expect(dashVal.code, dashVal.err).toBe(0);
  });

  it('fails loudly in graft apply when a graft.md is invalid or an id is unknown (#85)', async () => {
    const { root, graft } = await fixture();
    await mkdir(path.join(root, '.grafts/broken'), { recursive: true });
    await writeFile(
      path.join(root, '.grafts/broken/graft.md'),
      '---\nid: broken\nrootstock:\n  package: @scope/pkg\n  verified: 1.0.0\nmechanism: patch\n---\n',
    );

    // Whole-project apply reports the invalid graft and exits 2 instead of silently skipping it.
    const all = graft('apply', '--no-install', '--json');
    expect(all.code).toBe(2);
    expect(all.json().errors).toEqual([
      expect.objectContaining({ id: 'broken', error: expect.stringMatching(/invalid graft\.md:.*not valid YAML/) }),
    ]);

    // Targeting the invalid graft explicitly also fails with exit 2.
    const oneInvalid = graft('apply', 'broken', '--no-install', '--json');
    expect(oneInvalid.code).toBe(2);
    expect(oneInvalid.json().errors[0]).toMatchObject({ id: 'broken' });

    // Targeting only the valid graft ignores unrelated invalid grafts (no tooling error).
    const oneValid = graft('apply', 'add-c', '--no-install', '--json');
    expect(oneValid.code).not.toBe(2);
    expect(oneValid.json().errors).toEqual([]);
    expect(oneValid.json().configured).toEqual([expect.objectContaining({ id: 'add-c' })]);

    // Unknown graft IDs fail loudly instead of silently doing nothing.
    const missing = graft('apply', 'does-not-exist', '--no-install', '--json');
    expect(missing.code).toBe(2);
    expect(missing.json().errors).toEqual([{ id: 'does-not-exist', error: 'no graft "does-not-exist"' }]);

    // apply --installed filters invalid grafts by id and reports unknown ids.
    const installedMissing = graft('apply', '--installed', 'does-not-exist', '--json');
    expect(installedMissing.code).toBe(1);
    expect(installedMissing.json().reports).toEqual([
      expect.objectContaining({ graft: 'does-not-exist', errors: ['no graft "does-not-exist"'] }),
    ]);
  });
});
