import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_SKILL_PATH, setupAgent } from '../src/index.js';

const SKILL = '---\nname: graft-sync\ndescription: test\n---\n# Graft sync\n';
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'graft-agent-'));
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));

describe('setupAgent (graft init --agent)', () => {
  it('registers the MCP server and installs the skill', async () => {
    const root = await tmp();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', devDependencies: { '@graftsync/cli': '0.1.0' } }));
    const r = await setupAgent(root, { skill: SKILL });
    expect(r.files.map((f) => [path.relative(root, f.file), f.action])).toEqual([
      ['.mcp.json', 'created'],
      [AGENT_SKILL_PATH, 'created'],
    ]);
    expect(await json(path.join(root, '.mcp.json'))).toEqual({
      mcpServers: { graft: { command: 'npx', args: ['--no-install', 'graft-mcp', '--root', '.'] } },
    });
    expect(await readFile(path.join(root, AGENT_SKILL_PATH), 'utf8')).toBe(SKILL);
    expect(r.notes.join('\n')).toMatch(/add @graftsync\/mcp as devDependencies/);
  });

  it('merges with existing servers, keeps an existing graft entry, and is idempotent', async () => {
    const root = await tmp();
    await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    await setupAgent(root, { skill: SKILL });
    expect(Object.keys((await json(path.join(root, '.mcp.json'))).mcpServers)).toEqual(['other', 'graft']);

    const custom = { mcpServers: { graft: { command: 'node', args: ['bin.js'], env: { HTTPS_PROXY: 'http://proxy' } } } };
    await writeFile(path.join(root, '.mcp.json'), JSON.stringify(custom));
    const again = await setupAgent(root, { skill: SKILL });
    expect(again.files.map((f) => f.action)).toEqual(['kept', 'unchanged']);
    expect(await json(path.join(root, '.mcp.json'))).toEqual(custom);

    const updated = await setupAgent(root, { skill: `${SKILL}\nnew section\n` });
    expect(updated.files[1]!.action).toBe('updated');
  });

  it('refuses to overwrite an .mcp.json it cannot parse', async () => {
    const root = await tmp();
    await writeFile(path.join(root, '.mcp.json'), '{ not json');
    await expect(setupAgent(root, { skill: SKILL })).rejects.toThrow(/not valid JSON.*not overwriting/);
    expect(await readFile(path.join(root, '.mcp.json'), 'utf8')).toBe('{ not json');
  });
});
