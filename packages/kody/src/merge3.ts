// Pure-JS 3-way line merge emitting standard Git conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`).
import { diffArrays } from 'diff';

export interface Merge3Result {
  content: string;
  conflicted: boolean;
}

interface BaseEdit {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

function splitLinesPreservingNewline(text: string): string[] {
  if (text.length === 0) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function computeEdits(baseLines: string[], sideLines: string[]): BaseEdit[] {
  const parts = diffArrays(baseLines, sideLines);
  const edits: BaseEdit[] = [];
  let basePos = 0;
  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      basePos += part.value.length;
      i++;
      continue;
    }
    const baseStart = basePos;
    let baseEnd = basePos;
    const replacement: string[] = [];
    while (i < parts.length && (parts[i]!.added || parts[i]!.removed)) {
      const p = parts[i]!;
      if (p.removed) {
        baseEnd += p.value.length;
      } else if (p.added) {
        replacement.push(...p.value);
      }
      i++;
    }
    edits.push({ baseStart, baseEnd, lines: replacement });
    basePos = baseEnd;
  }
  return edits;
}

function applyRegionEdits(baseLines: string[], regionStart: number, regionEnd: number, edits: BaseEdit[]): string[] {
  const out: string[] = [];
  let pos = regionStart;
  for (const e of edits) {
    if (e.baseStart > pos) out.push(...baseLines.slice(pos, e.baseStart));
    out.push(...e.lines);
    pos = e.baseEnd;
  }
  if (pos < regionEnd) out.push(...baseLines.slice(pos, regionEnd));
  return out;
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function ensureTrailingNewline(lines: string[]): string[] {
  if (lines.length === 0) return [];
  const last = lines.at(-1)!;
  if (last.endsWith('\n')) return lines;
  return [...lines.slice(0, -1), `${last}\n`];
}

/**
 * Three-way merge `theirs` (fork) onto `ours` (target upstream) relative to `base` (verified upstream).
 * Matches Git's rule that overlapping or adjacent edits conflict, while non-touching edits merge cleanly.
 */
export function merge3(base: string, ours: string, theirs: string, labels: { ours?: string; theirs?: string } = {}): Merge3Result {
  if (ours === theirs) return { content: ours, conflicted: false };
  if (ours === base) return { content: theirs, conflicted: false };
  if (theirs === base) return { content: ours, conflicted: false };

  const baseLines = splitLinesPreservingNewline(base);
  const oursLines = splitLinesPreservingNewline(ours);
  const theirsLines = splitLinesPreservingNewline(theirs);

  const oursEdits = computeEdits(baseLines, oursLines);
  const theirsEdits = computeEdits(baseLines, theirsLines);

  const oursLabel = labels.ours ?? 'upstream';
  const theirsLabel = labels.theirs ?? 'fork';

  const out: string[] = [];
  let basePos = 0;
  let oi = 0;
  let ti = 0;
  let conflicted = false;

  while (oi < oursEdits.length || ti < theirsEdits.length) {
    const nextO = oursEdits[oi];
    const nextT = theirsEdits[ti];
    const start = Math.min(nextO ? nextO.baseStart : Number.POSITIVE_INFINITY, nextT ? nextT.baseStart : Number.POSITIVE_INFINITY);

    if (start > basePos) {
      out.push(...baseLines.slice(basePos, start));
      basePos = start;
    }

    const regionO: BaseEdit[] = [];
    const regionT: BaseEdit[] = [];
    let regionEnd = start;

    // Seed with the earliest edit(s) starting at `start`.
    if (nextO && nextO.baseStart === start) {
      regionO.push(nextO);
      regionEnd = Math.max(regionEnd, nextO.baseEnd);
      oi++;
    }
    if (nextT && nextT.baseStart === start) {
      regionT.push(nextT);
      regionEnd = Math.max(regionEnd, nextT.baseEnd);
      ti++;
    }

    // Expand the region while any edit from either side overlaps or touches `[start, regionEnd]`.
    let expanded = true;
    while (expanded) {
      expanded = false;
      while (oi < oursEdits.length && oursEdits[oi]!.baseStart <= regionEnd) {
        const e = oursEdits[oi]!;
        regionO.push(e);
        regionEnd = Math.max(regionEnd, e.baseEnd);
        oi++;
        expanded = true;
      }
      while (ti < theirsEdits.length && theirsEdits[ti]!.baseStart <= regionEnd) {
        const e = theirsEdits[ti]!;
        regionT.push(e);
        regionEnd = Math.max(regionEnd, e.baseEnd);
        ti++;
        expanded = true;
      }
    }

    if (regionO.length > 0 && regionT.length === 0) {
      out.push(...applyRegionEdits(baseLines, start, regionEnd, regionO));
    } else if (regionT.length > 0 && regionO.length === 0) {
      out.push(...applyRegionEdits(baseLines, start, regionEnd, regionT));
    } else {
      const oSlice = applyRegionEdits(baseLines, start, regionEnd, regionO);
      const tSlice = applyRegionEdits(baseLines, start, regionEnd, regionT);
      if (sameLines(oSlice, tSlice)) {
        out.push(...oSlice);
      } else {
        conflicted = true;
        out.push(`<<<<<<< ${oursLabel}\n`);
        out.push(...ensureTrailingNewline(oSlice));
        out.push('=======\n');
        out.push(...ensureTrailingNewline(tSlice));
        out.push(`>>>>>>> ${theirsLabel}\n`);
      }
    }
    basePos = regionEnd;
  }

  if (basePos < baseLines.length) {
    out.push(...baseLines.slice(basePos));
  }

  return { content: out.join(''), conflicted };
}
