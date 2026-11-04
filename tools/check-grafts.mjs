// `pnpm test:grafts`: this repo's own verification of its dogfood grafts. Graft checks that each
// graft still fits its upstream; whether the converted packages still behave like the originals
// is the project's to test, here with each graft's check.mjs in both module modes.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const grafts = path.join(root, '.grafts');
const checks = readdirSync(grafts, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(path.join(grafts, e.name, 'check.mjs')))
  .map((e) => e.name);
let failed = 0;
for (const id of checks) {
  for (const mode of ['esm', 'cjs']) {
    const r = spawnSync(process.execPath, [path.join(grafts, id, 'check.mjs')], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, GRAFT_ID: id, GRAFT_DIR: path.join(grafts, id), GRAFT_MODE: mode },
    });
    if (r.status !== 0) {
      failed++;
      console.error(`✗ ${id} (${mode}) exited ${r.status}`);
    }
  }
}
console.log(failed ? `${failed} graft check(s) failed` : `✓ ${checks.length} graft(s) checked in esm and cjs`);
process.exit(failed ? 1 : 0);
