import { applyPatch, parsePatch, type StructuredPatch, type StructuredPatchHunk } from 'diff';

export interface FilePatch {
  /** Path relative to the package root, or null for a created file. */
  oldFile: string | null;
  /** Path relative to the package root, or null for a deleted file. */
  newFile: string | null;
  hunks: StructuredPatchHunk[];
  raw: StructuredPatch;
}

const strip = (name: string | undefined): string | null => {
  if (!name || name === '/dev/null') return null;
  return name.replace(/^[ab]\//, '').replace(/\t.*$/, '');
};

/** Parse a git-style unified patch (as written by `pnpm patch-commit` or `git diff`). */
export function parsePatchFile(text: string): FilePatch[] {
  return parsePatch(text)
    .filter((p) => p.hunks.length > 0 || p.oldFileName || p.newFileName)
    .map((raw) => ({ oldFile: strip(raw.oldFileName), newFile: strip(raw.newFileName), hunks: raw.hunks, raw }));
}

/** The file a patch entry reads from (or creates). */
export const patchTarget = (p: FilePatch): string => (p.oldFile ?? p.newFile)!;

export interface HunkMatch {
  /** 1-based line where the hunk's old side was found. */
  line?: number;
  /** Distance from the line stated in the hunk header. */
  offset?: number;
  /** Number of places the hunk's old side occurs. */
  occurrences: number;
}

/** Locate a hunk's old side (context + removed lines) exactly in `content`. */
export function locateHunk(content: string, hunk: StructuredPatchHunk): HunkMatch {
  const oldLines = hunk.lines.filter((l) => l[0] === ' ' || l[0] === '-').map((l) => l.slice(1));
  const lines = content.split('\n');
  if (oldLines.length === 0) return { line: hunk.oldStart, offset: 0, occurrences: 1 };
  const hits: number[] = [];
  outer: for (let i = 0; i + oldLines.length <= lines.length; i++) {
    for (let j = 0; j < oldLines.length; j++) if (lines[i + j] !== oldLines[j]) continue outer;
    hits.push(i + 1);
  }
  if (!hits.length) return { occurrences: 0 };
  const best = hits.reduce((a, b) => (Math.abs(b - hunk.oldStart) < Math.abs(a - hunk.oldStart) ? b : a));
  return { line: best, offset: best - hunk.oldStart, occurrences: hits.length };
}

/** Apply one file's patch with no fuzz. Returns false if any hunk does not fit exactly. */
export function applyFilePatch(content: string, patch: FilePatch): string | false {
  return applyPatch(content, patch.raw, { fuzzFactor: 0 });
}

/** Short human description of a hunk: its first changed line. */
export function describeHunk(hunk: StructuredPatchHunk): string {
  const first = hunk.lines.find((l) => l[0] === '+' || l[0] === '-') ?? '';
  const text = first.slice(1).trim();
  return `${first[0] === '-' ? 'replaces' : 'adds'} \`${text.length > 70 ? `${text.slice(0, 67)}…` : text}\``;
}
