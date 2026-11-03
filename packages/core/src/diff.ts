import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { structuredPatch } from 'diff';
import type { DiffHunk, ScopedFileDiff } from './types.js';

/** A region of interest for narrowing a diff, typically one located anchor. */
export interface AnchorRegion {
  name: string;
  /** 1-based inclusive line span in the old version, if the anchor was located there. */
  old?: [number, number];
  /** 1-based inclusive line span in the new version, if the anchor was located there. */
  new?: [number, number];
  /** Identifiers/strings that identify the anchor; hunks mentioning them are kept. */
  symbols?: string[];
}

export interface ScopeFileOptions {
  file: string;
  oldText: string | undefined;
  newText: string | undefined;
  regions: AnchorRegion[];
  /** Lines of slack around anchor spans when deciding if a hunk is "near". Default 40. */
  window?: number;
  /** Context lines in each hunk. Default 3. */
  context?: number;
}

const overlaps = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];

/** Diff one target file and keep only hunks near or mentioning the given anchor regions. */
export function scopeFileDiff(options: ScopeFileOptions): ScopedFileDiff {
  const { file, oldText, newText, regions } = options;
  const window = options.window ?? 40;
  if (oldText === undefined && newText === undefined) {
    return { file, status: 'removed', totalHunks: 0, hunks: [], narrowed: false };
  }
  const status: ScopedFileDiff['status'] =
    oldText === undefined ? 'added' : newText === undefined ? 'removed' : oldText === newText ? 'unchanged' : 'modified';
  if (status === 'unchanged') return { file, status, totalHunks: 0, hunks: [], narrowed: true };

  const patch = structuredPatch(file, file, oldText ?? '', newText ?? '', '', '', {
    context: options.context ?? 3,
  });
  const hunks: DiffHunk[] = patch.hunks.map((h) => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
    anchors: [],
  }));

  const located = regions.some((r) => r.old || r.new || r.symbols?.length);
  if (!located || status !== 'modified') {
    return { file, status, totalHunks: hunks.length, hunks, narrowed: false };
  }

  for (const hunk of hunks) {
    const oldSpan: [number, number] = [hunk.oldStart, hunk.oldStart + Math.max(hunk.oldLines - 1, 0)];
    const newSpan: [number, number] = [hunk.newStart, hunk.newStart + Math.max(hunk.newLines - 1, 0)];
    const changed = hunk.lines.filter((l) => l[0] === '+' || l[0] === '-').join('\n');
    for (const region of regions) {
      const near =
        (region.old && overlaps(oldSpan, [region.old[0] - window, region.old[1] + window])) ||
        (region.new && overlaps(newSpan, [region.new[0] - window, region.new[1] + window]));
      const mentions = region.symbols?.some((s) => s && changed.includes(s));
      if (near || mentions) hunk.anchors.push(region.name);
    }
  }
  return { file, status, totalHunks: hunks.length, hunks: hunks.filter((h) => h.anchors.length > 0), narrowed: true };
}

/** Render scoped file diffs as a unified patch. */
export function renderPatch(files: ScopedFileDiff[], labels: { from: string; to: string }): string {
  const out: string[] = [];
  for (const f of files) {
    if (f.status === 'unchanged') continue;
    out.push(`--- a/${f.file}\t(${labels.from})`, `+++ b/${f.file}\t(${labels.to})`);
    if (f.status === 'removed' && f.hunks.length === 0) out.push(`# target removed in ${labels.to}`);
    if (f.narrowed && f.hunks.length < f.totalHunks) {
      out.push(`# narrowed: showing ${f.hunks.length} of ${f.totalHunks} hunks (those near anchors)`);
    }
    for (const h of f.hunks) {
      const note = h.anchors.length ? ` anchors: ${h.anchors.join(', ')}` : '';
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${note}`, ...h.lines);
    }
    if (f.candidates?.length) {
      out.push(`# candidate files in ${labels.to} mentioning anchor symbols:`, ...f.candidates.map((c) => `#   ${c}`));
    }
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

const CODE_EXT = /\.(c|m)?js$/;

/** Find files under `dir` (excluding node_modules) whose text contains any of `symbols`. */
export async function findFilesMentioning(dir: string, symbols: string[], limit = 10): Promise<string[]> {
  const wanted = symbols.filter((s) => s.length >= 3);
  if (!wanted.length) return [];
  const hits: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (hits.length >= limit) return;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) await walk(child);
      } else if (CODE_EXT.test(e.name)) {
        const text = await readFile(path.join(dir, child), 'utf8').catch(() => '');
        if (wanted.some((s) => text.includes(s))) hits.push(child);
      }
    }
  };
  await walk('');
  return hits;
}

/** 1-based line and column of a UTF-16 offset. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: offset - last };
}
