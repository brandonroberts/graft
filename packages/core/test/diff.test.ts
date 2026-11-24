import { describe, expect, it } from 'vitest';
import { scopeFileDiff } from '../src/diff.js';

describe('scopeFileDiff', () => {
  it('handles large bundled files with high edit distance quickly via git diff fast path', () => {
    // >128 KB combined with thousands of changed lines (mirrors element-plus dist/index.full.mjs).
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (let i = 1; i <= 6000; i++) {
      if (i === 3000) {
        oldLines.push('const useLockscreen = () => { removeClass(document.body); };');
        newLines.push('const useLockscreen = () => { if (typeof document === "undefined") return; removeClass(document.body); };');
      } else if (i % 20 === 0) {
        oldLines.push(`const oldHelper_${i} = "payload_${i}_v1_padding_text";`);
        newLines.push(`const newHelper_${i} = "payload_${i}_v2_changed_padding";`);
      } else {
        oldLines.push(`const stable_${i} = ${i};`);
        newLines.push(`const stable_${i} = ${i};`);
      }
    }
    const oldText = `${oldLines.join('\n')}\n`;
    const newText = `${newLines.join('\n')}\n`;
    expect(oldText.length + newText.length).toBeGreaterThan(128 * 1024);

    const start = Date.now();
    const scoped = scopeFileDiff({
      file: 'dist/index.full.mjs',
      oldText,
      newText,
      regions: [{ name: 'dist/index.full.mjs#1', old: [3000, 3000], new: [3000, 3000] }],
      window: 10,
    });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(5000);
    expect(scoped.status).toBe('modified');
    expect(scoped.narrowed).toBe(true);
    expect(scoped.totalHunks).toBeGreaterThan(100);
    expect(scoped.hunks.length).toBeGreaterThan(0);
    expect(scoped.hunks.length).toBeLessThan(scoped.totalHunks);
    expect(scoped.hunks.some((h) => h.lines.some((l) => l.includes('typeof document === "undefined"')))).toBe(true);
  });
});
