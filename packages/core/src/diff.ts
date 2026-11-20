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
  /** New path when diffing a renamed file (e.g. a content-hashed bundler chunk). */
  newFile?: string;
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
  const { file, newFile, oldText, newText, regions } = options;
  const renamed = newFile && newFile !== file ? { newFile } : {};
  const window = options.window ?? 40;
  if (oldText === undefined && newText === undefined) {
    return { file, ...renamed, status: 'removed', totalHunks: 0, hunks: [], narrowed: false };
  }
  const status: ScopedFileDiff['status'] =
    oldText === undefined ? 'added' : newText === undefined ? 'removed' : oldText === newText ? 'unchanged' : 'modified';
  if (status === 'unchanged') return { file, ...renamed, status, totalHunks: 0, hunks: [], narrowed: true };

  const patch = structuredPatch(file, newFile ?? file, oldText ?? '', newText ?? '', '', '', {
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
    return { file, ...renamed, status, totalHunks: hunks.length, hunks, narrowed: false };
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
  return { file, ...renamed, status, totalHunks: hunks.length, hunks: hunks.filter((h) => h.anchors.length > 0), narrowed: true };
}

/** Render scoped file diffs as a unified patch. */
export function renderPatch(files: ScopedFileDiff[], labels: { from: string; to: string }): string {
  const out: string[] = [];
  for (const f of files) {
    const renamed = Boolean(f.newFile && f.newFile !== f.file);
    if (f.status === 'unchanged' && !renamed) continue;
    out.push(`--- a/${f.file}\t(${labels.from})`, `+++ b/${f.newFile ?? f.file}\t(${labels.to})`);
    if (renamed) out.push(`# renamed: ${f.file} -> ${f.newFile}`);
    if (f.status === 'removed' && f.hunks.length === 0) out.push(`# target removed in ${labels.to}`);
    if (f.narrowed && f.hunks.length < f.totalHunks) {
      out.push(`# narrowed: showing ${f.hunks.length} of ${f.totalHunks} hunks (those near anchors)`);
    }
    for (const h of f.hunks) {
      const note = h.anchors.length ? ` anchors: ${h.anchors.join(', ')}` : '';
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${note}`, ...h.lines);
    }
    if (f.candidates?.length) {
      out.push(
        `# candidate files in ${labels.to} that contain the removed target's patched code (best match first):`,
        ...f.candidates.map((c) => `#   ${c}`),
      );
    }
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

const CHUNK_EXT_RE = /^(.*?)(\.d\.[cm]?ts|\.[cm]?[jt]sx?|\.css)$/;
const CHUNK_HASH_RE = /^(.+?)([.-])([A-Za-z0-9_-]{6,32})$/;
const looksLikeContentHash = (s: string) => /\d/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s));

/**
 * True when `oldFile` and `newFile` are content-hashed bundler chunks with the same directory,
 * stem, separator, and extension (e.g. `dist/chunks/cac.CLrZKo1g.js` → `dist/chunks/cac.BYbt0aJp.js`
 * or `dist/chunks/plugin.d.C8mmycim.d.ts` → `dist/chunks/plugin.d.LRFSN46m.d.ts`) (#80).
 */
export function isHashedChunkRename(oldFile: string, newFile: string): boolean {
  if (oldFile === newFile) return false;
  if (path.posix.dirname(oldFile) !== path.posix.dirname(newFile)) return false;
  const oldExt = CHUNK_EXT_RE.exec(path.posix.basename(oldFile));
  const newExt = CHUNK_EXT_RE.exec(path.posix.basename(newFile));
  if (!oldExt || !newExt || oldExt[2] !== newExt[2]) return false;
  const oldParts = CHUNK_HASH_RE.exec(oldExt[1]!);
  const newParts = CHUNK_HASH_RE.exec(newExt[1]!);
  if (!oldParts || !newParts) return false;
  return (
    oldParts[1] === newParts[1] &&
    oldParts[2] === newParts[2] &&
    oldParts[3] !== newParts[3] &&
    looksLikeContentHash(oldParts[3]!) &&
    looksLikeContentHash(newParts[3]!)
  );
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

const KEYWORDS = new Set(
  'this that from with true false null undefined const function return export import default async await else case break continue throw catch finally typeof instanceof void delete while switch class extends super static yield require module exports Object Array String Number Boolean Promise prototype length push call apply bind then value'.split(
    ' ',
  ),
);

/**
 * Distinctive text in some source lines, for finding where removed code moved: trimmed lines
 * worth matching (not blank, not bare punctuation like `}` or `});`, at least 8 characters, and
 * containing an identifier) and identifiers of 4+ characters that are not common keywords.
 */
export function distinctiveText(lines: string[]): { lines: string[]; identifiers: string[] } {
  const keptLines = new Set<string>();
  const identifiers = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    const ids = (line.match(/[A-Za-z_$][\w$]{3,}/g) ?? []).filter((id) => !KEYWORDS.has(id));
    for (const id of ids) identifiers.add(id);
    if (line.length >= 8 && /[A-Za-z_$][\w$]{2,}/.test(line)) keptLines.add(line);
  }
  // Longer lines are more distinctive; check them first.
  return { lines: [...keptLines].sort((a, b) => b.length - a.length), identifiers: [...identifiers] };
}

export interface RankFilesOptions {
  /** Trimmed lines to look for (each counts once per file). */
  lines: string[];
  /** Identifiers to look for; break ties between files matching the same number of lines. */
  identifiers?: string[];
  /** Maximum files returned. Default 10. */
  limit?: number;
  /** File name pattern to scan. Default: JavaScript (.js/.cjs/.mjs). */
  include?: RegExp;
  /** Paths (relative to `dir`) to skip. */
  exclude?: string[];
}

/**
 * Rank files under `dir` (excluding node_modules and dot-directories) by how many of `lines`
 * they contain, then by how many identifiers. Files matching nothing are left out.
 */
export async function rankFilesByContent(dir: string, options: RankFilesOptions): Promise<string[]> {
  const wantedLines = options.lines.filter((l) => l.trim().length > 0);
  const wantedIds = (options.identifiers ?? []).filter((s) => s.length >= 4);
  if (!wantedLines.length && !wantedIds.length) return [];
  const include = options.include ?? CODE_EXT;
  const exclude = new Set(options.exclude ?? []);
  const scored: { file: string; lines: number; ids: number }[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) await walk(child);
      } else if (include.test(e.name) && !exclude.has(child)) {
        const text = await readFile(path.join(dir, child), 'utf8').catch(() => '');
        if (!text) continue;
        const lines = wantedLines.filter((l) => text.includes(l)).length;
        const ids = wantedIds.filter((s) => text.includes(s)).length;
        if (lines || ids) scored.push({ file: child, lines, ids });
      }
    }
  };
  await walk('');
  scored.sort((a, b) => b.lines - a.lines || b.ids - a.ids || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return scored.slice(0, options.limit ?? 10).map((s) => s.file);
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
