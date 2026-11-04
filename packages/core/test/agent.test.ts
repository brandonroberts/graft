import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_SKILL_PATH, setupAgent } from '../src/index.js';

const SKILL = '---\nname: graft-sync\ndescription: test\n---\n# Graft sync\n';
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'graft-agent-'));

describe('setupAgent (graft init --agent)', () => {
  it('installs the skill and notes a missing CLI dependency', async () => {
    const root = await tmp();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    const r = await setupAgent(root, { skill: SKILL });
    expect(r.files.map((f) => [path.relative(root, f.file), f.action])).toEqual([[AGENT_SKILL_PATH, 'created']]);
    expect(await readFile(path.join(root, AGENT_SKILL_PATH), 'utf8')).toBe(SKILL);
    expect(r.notes.join('\n')).toMatch(/add @graftsync\/cli as a devDependency/);
  });

  it('is idempotent and updates the skill when Graft ships a new one', async () => {
    const root = await tmp();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', devDependencies: { '@graftsync/cli': '0.1.0' } }));
    await setupAgent(root, { skill: SKILL });
    const again = await setupAgent(root, { skill: SKILL });
    expect(again.files.map((f) => f.action)).toEqual(['unchanged']);
    expect(again.notes.join('\n')).not.toMatch(/devDependency/);
    const updated = await setupAgent(root, { skill: `${SKILL}\nnew section\n` });
    expect(updated.files[0]!.action).toBe('updated');
  });
});
