import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DirectoryUpstreamSource, Project } from '@graft/core';
import { patchAdapter } from '@graft/adapter-patch';
import { createGraftServer } from '../src/index.js';

const V1 = 'const a = 1\nconst b = 2\nmodule.exports = { a, b }\n';
const V2 = 'const a = 1\nmodule.exports = { a }\n';
const PATCH_V1 = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1,3 +1,4 @@
 const a = 1
 const b = 2
+const c = 3
 module.exports = { a, b }
`;
const PATCH_V2 = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1,2 +1,3 @@
 const a = 1
+const c = 3
 module.exports = { a }
`;

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-mcp-'));
  const dirs: Record<string, string> = {};
  for (const [v, code] of [['1.0.0', V1], ['2.0.0', V2]] as const) {
    const dir = path.join(root, 'upstream', v);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.js'), code);
    dirs[v] = dir;
  }
  const g = path.join(root, '.grafts', 'add-c');
  await mkdir(path.join(g, 'variants'), { recursive: true });
  await writeFile(path.join(g, 'variants', 'v1.patch'), PATCH_V1);
  await writeFile(
    path.join(g, 'graft.md'),
    `---\nid: add-c\nrootstock: { package: lib, verified: 1.0.0 }\nmechanism: patch\nvariants:\n  - range: ">=1.0.0"\n    module: ./variants/v1.patch\noracle: { command: 'node -e "process.exit(0)"' }\n---\n## Why\nAdds c.\n## Invariants\n- c is 3\n## Where to look\nThe module's constants.\n## Anchors\nThe const block.\n## History\n- created\n`,
  );
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\nignorePatchFailures: false\npatchedDependencies:\n  lib: .grafts/add-c/variants/v1.patch\n');
  const upstream = new DirectoryUpstreamSource({ lib: dirs }, { lib: '1.0.0' });
  const server = createGraftServer({ openProject: () => Project.open({ root, adapters: [patchAdapter], upstream }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent?: any };
    return { error: r.isError ? r.content[0]!.text : undefined, data: r.structuredContent, text: r.content[0]!.text };
  };
  return { root, g, upstream, call };
}

describe('graft MCP server', () => {
  it('exposes the handoff tool set', async () => {
    const { call } = await setup();
    const listed = await call('list_grafts');
    expect(listed.data.grafts[0]).toMatchObject({ id: 'add-c', package: 'lib', verified: '1.0.0', installed: '1.0.0' });
    expect(listed.data.grafts[0].anchors.ok).toBe(true);
  });

  it('drives the agent path end to end', async () => {
    const { g, upstream, call } = await setup();

    // Deterministic first pass: upstream 2.0.0 moved the anchor.
    const synced = await call('sync', { version: '2.0.0' });
    expect(synced.data.exitCode).toBe(1);
    expect(synced.data.grafts[0].outcome).toBe('needs-agent');

    // Context: intent, anchor report, scoped diff.
    const graft = await call('read_graft', { id: 'add-c' });
    expect(graft.data.sections.Invariants).toBe('- c is 3');
    const anchors = await call('check_anchors', { id: 'add-c', version: '2.0.0' });
    expect(anchors.data.ok).toBe(false);
    const diff = await call('scope_diff', { id: 'add-c', to: '2.0.0' });
    expect(diff.data.patch).toContain('-const b = 2');

    // The agent writes a new variant with its own tools, then registers it.
    await writeFile(path.join(g, 'variants', 'v2.patch'), PATCH_V2);
    const recorded = await call('record_variant', { id: 'add-c', range: '>=2.0.0', module: './variants/v2.patch', verifyVersion: '2.0.0', note: 'upstream removed b.' });
    expect(recorded.error).toBeUndefined();
    expect(recorded.data.narrowed).toEqual([{ module: './variants/v1.patch', from: '>=1.0.0', to: '>=1.0.0 <2.0.0' }]);
    expect((await call('apply_cached', { id: 'add-c', version: '2.0.0' })).data.ok).toBe(true);

    // Verify with the oracle on the installed new version, then bookkeeping.
    upstream.setInstalled('lib', '2.0.0');
    expect((await call('run_oracle', { id: 'add-c' })).data.passed).toBe(true);
    const updated = await call('update_status', { id: 'add-c', status: 'applied', verified: '2.0.0', history: 'Synced to 2.0.0.' });
    expect(updated.data).toMatchObject({ status: 'applied', verified: '2.0.0' });

    const md = await readFile(path.join(g, 'graft.md'), 'utf8');
    expect(md).toContain('verified: 2.0.0');
    expect(md).toContain('./variants/v2.patch');
    expect(md).toMatch(/Added variant \.\/variants\/v2\.patch for ">=2\.0\.0"\. Narrowed .* upstream removed b\./);
    expect(md).toContain('Synced to 2.0.0.');
  });

  it('refuses to edit existing variants or record variants that do not match', async () => {
    const { g, call } = await setup();
    const again = await call('record_variant', { id: 'add-c', range: '>=3.0.0', module: './variants/v1.patch' });
    expect(again.error).toMatch(/already registered; never edit an existing variant/);

    await writeFile(path.join(g, 'variants', 'bad.patch'), PATCH_V1);
    const bad = await call('record_variant', { id: 'add-c', range: '>=2.0.0', module: './variants/bad.patch', verifyVersion: '2.0.0' });
    expect(bad.error).toMatch(/does not match lib@2\.0\.0/);
    expect(await readFile(path.join(g, 'graft.md'), 'utf8')).not.toContain('bad.patch'); // rolled back
  });

  it('reports errors as tool errors, not crashes', async () => {
    const { call } = await setup();
    expect((await call('read_graft', { id: 'missing' })).error).toMatch(/no graft "missing"/);
    expect((await call('update_status', { id: 'add-c', verified: 'not-a-version' })).error).toMatch(/not a valid semver/);
  });
});
