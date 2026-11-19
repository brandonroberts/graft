import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/index.js';

/** Running: signalable and, on Linux, not a zombie (killed but not yet reaped by its new parent). */
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') return true;
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z';
  } catch {
    return false;
  }
};

describe('runCommand', () => {
  it('on timeout stops everything the command started, not just its shell', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'graft-command-'));
    // A shell running node, which starts a grandchild that writes its pid and keeps the output pipe open.
    await writeFile(
      path.join(dir, 'grandchild.js'),
      `require('fs').writeFileSync(require('path').join(__dirname, 'pid'), String(process.pid));\nsetTimeout(() => {}, 60000);\n`,
    );
    await writeFile(
      path.join(dir, 'parent.js'),
      `require('child_process').spawn(process.execPath, [require('path').join(__dirname, 'grandchild.js')], { stdio: 'inherit' });\nsetTimeout(() => {}, 60000);\n`,
    );
    const result = await runCommand(`node parent.js && echo never`, { cwd: dir, timeoutMs: 1_000 });
    expect(result).toMatchObject({ passed: false, timedOut: true });
    expect(result.durationMs).toBeLessThan(10_000);
    const grandchild = Number(readFileSync(path.join(dir, 'pid'), 'utf8'));
    for (let i = 0; i < 30 && running(grandchild); i++) await new Promise((r) => setTimeout(r, 100));
    expect(running(grandchild)).toBe(false);
  });
});
