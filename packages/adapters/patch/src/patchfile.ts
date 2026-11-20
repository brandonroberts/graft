import { applyPatch, parsePatch, reversePatch, type StructuredPatch, type StructuredPatchHunk } from 'diff';

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

/** Normalize Windows CRLF line endings to LF. */
export const normalizeLf = (s: string): string => s.replace(/\r\n/g, '\n');

/** True when any hunk line in `patch` explicitly ends with CR (`\r`). */
export const patchHasCr = (patch: FilePatch): boolean => patch.hunks.some((h) => h.lines.some((l) => l.endsWith('\r')));

function patchToLf(raw: StructuredPatch): StructuredPatch {
  return {
    ...raw,
    hunks: raw.hunks.map((h) => ({ ...h, lines: h.lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)) })),
  };
}

/** Parse a git-style unified patch (as written by `pnpm patch-commit` or `git diff`). */
export function parsePatchFile(text: string): FilePatch[] {
  return parsePatch(text)
    .filter((p) => p.hunks.length > 0 || p.oldFileName || p.newFileName)
    .map((raw) => {
      const git = raw as StructuredPatch & { isCreate?: boolean; isDelete?: boolean };
      return {
        oldFile: git.isCreate ? null : strip(raw.oldFileName),
        newFile: git.isDelete ? null : strip(raw.newFileName),
        hunks: raw.hunks,
        raw,
      };
    });
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

/** Locate a hunk's old side (context + removed lines) exactly in `content` (tolerating CRLF vs LF). */
export function locateHunk(content: string, hunk: StructuredPatchHunk): HunkMatch {
  const rawOld = hunk.lines.filter((l) => l[0] === ' ' || l[0] === '-').map((l) => l.slice(1));
  const hunkHasCr = rawOld.some((l) => l.endsWith('\r'));
  const oldLines = hunkHasCr ? rawOld : rawOld.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const lines = (hunkHasCr ? content : normalizeLf(content)).split('\n');
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

/** Apply one file's patch with no fuzz (handling CRLF upstream files and hunkless creates/deletes). */
export function applyFilePatch(content: string, patch: FilePatch): string | false {
  if (patch.hunks.length === 0) {
    if (patch.oldFile === null || patch.newFile === null) return '';
    return false;
  }
  const direct = applyPatch(content, patch.raw, { fuzzFactor: 0 });
  if (direct !== false) return direct;
  if (!content.includes('\r\n') && !patchHasCr(patch)) return false;
  const applied = applyPatch(normalizeLf(content), patchToLf(patch.raw), { fuzzFactor: 0 });
  if (applied === false) return false;
  return content.includes('\r\n') ? applied.replace(/\n/g, '\r\n') : applied;
}

/** Apply the reverse of one file's patch with no fuzz (CRLF-aware). */
export function reverseFilePatch(content: string, patch: FilePatch): string | false {
  if (patch.hunks.length === 0) return false;
  const direct = applyPatch(content, reversePatch(patch.raw), { fuzzFactor: 0 });
  if (direct !== false) return direct;
  if (!content.includes('\r\n') && !patchHasCr(patch)) return false;
  return applyPatch(normalizeLf(content), reversePatch(patchToLf(patch.raw)), { fuzzFactor: 0 });
}

/** Short human description of a hunk: its first changed line. */
export function describeHunk(hunk: StructuredPatchHunk): string {
  const first = hunk.lines.find((l) => l[0] === '+' || l[0] === '-') ?? '';
  const text = first.slice(1).trim();
  return `${first[0] === '-' ? 'replaces' : 'adds'} \`${text.length > 70 ? `${text.slice(0, 67)}…` : text}\``;
}
