import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectSkillsDirs, setupAgent } from '../src/index.js';

const SKILL = '---\nname: graft-sync\ndescription: test\n---\n# Graft sync\n';
async function project(dirs: string[] = [], manifest: Record<string, unknown> = { name: 'app' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graft-agent-'));
  for (const d of dirs) await mkdir(path.join(root, d), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  return root;
}
const rel = (root: string, files: { file: string; action: string }[]) => files.map((f) => [path.relative(root, f.file), f.action]);

describe('detecting agent skills folders', () => {
  it('uses every existing skills folder', async () => {
    const root = await project(['.claude/skills', '.agents/skills', '.cursor']);
    expect(detectSkillsDirs(root)).toEqual([
      { dir: '.claude/skills', reason: 'existing skills folder' },
      { dir: '.agents/skills', reason: 'existing skills folder' },
    ]);
  });

  it("falls back to agent folders' skills/ subfolder", async () => {
    const root = await project(['.cursor', '.codex']);
    expect(detectSkillsDirs(root)).toEqual([
      { dir: '.codex/skills', reason: 'agent folder' },
      { dir: '.cursor/skills', reason: 'agent folder' },
    ]);
  });

  it('does not treat .github alone as an agent (most repos have it for workflows)', async () => {
    expect(detectSkillsDirs(await project(['.github/workflows']))).toEqual([]);
    expect(detectSkillsDirs(await project(['.github/skills']))).toEqual([{ dir: '.github/skills', reason: 'existing skills folder' }]);
  });
});

describe('setupAgent (graft init --agent)', () => {
  it('installs the skill into every detected skills folder', async () => {
    const root = await project(['.claude/skills', '.agents/skills']);
    const r = await setupAgent(root, { skill: SKILL });
    expect(rel(root, r.files)).toEqual([
      ['.claude/skills/graft-sync/SKILL.md', 'created'],
      ['.agents/skills/graft-sync/SKILL.md', 'created'],
    ]);
    expect(await readFile(path.join(root, '.agents/skills/graft-sync/SKILL.md'), 'utf8')).toBe(SKILL);
    expect(r.notes.join('\n')).toMatch(/add @graftsync\/cli as a devDependency/);
  });

  it('fails instead of guessing when no agent is detected, and honors an explicit folder', async () => {
    const root = await project();
    await expect(setupAgent(root, { skill: SKILL })).rejects.toThrow(/no agent skills folder found.*--skills-dir/);
    expect(existsSync(path.join(root, '.claude'))).toBe(false);
    const r = await setupAgent(root, { skill: SKILL, skillsDirs: ['.agents/skills/'] });
    expect(r.skillsDirs).toEqual([{ dir: '.agents/skills', reason: 'requested' }]);
    expect(rel(root, r.files)).toEqual([['.agents/skills/graft-sync/SKILL.md', 'created']]);
  });

  it('is idempotent and updates the skill when Graft ships a new one', async () => {
    const root = await project(['.cursor'], { name: 'app', devDependencies: { '@graftsync/cli': '0.1.0' } });
    expect(rel(root, (await setupAgent(root, { skill: SKILL })).files)).toEqual([['.cursor/skills/graft-sync/SKILL.md', 'created']]);
    const again = await setupAgent(root, { skill: SKILL });
    expect(again.files.map((f) => f.action)).toEqual(['unchanged']);
    expect(again.skillsDirs).toEqual([{ dir: '.cursor/skills', reason: 'existing skills folder' }]); // created last time
    expect(again.notes).toEqual([]);
    expect((await setupAgent(root, { skill: `${SKILL}\nnew\n` })).files[0]!.action).toBe('updated');
  });
});
