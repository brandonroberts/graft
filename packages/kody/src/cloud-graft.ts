// Pure-JS repo-mode Graft `fork` evaluator for Kody Cloud (workerd).
// Operates strictly on an in-memory GitObjectStore — zero `node:*` imports, zero host commands.
import { applyPatch, reversePatch, structuredPatch, type StructuredPatch, type StructuredPatchHunk } from 'diff';
import semver from 'semver';
import { GraftDocumentEditor, parseGraft, versionScheme, type ForkConfig, type ParsedGraft } from '@graftsync/spec';
import { decodeUtf8, GitObjectStore, isBinaryContent, walkCommitTree, type GitFileEntry } from './git-objects.ts';
import { merge3 } from './merge3.ts';

const WORKTREE = '@worktree';
const VERIFIED = '@verified';

interface ForkVariant {
  ref: string;
  base: string;
}

interface FilePatch {
  oldFile: string | null;
  newFile: string | null;
  hunks: StructuredPatchHunk[];
  raw: StructuredPatch;
}

interface BinaryChange {
  file: string;
  baseOid?: string;
  refOid?: string;
  refMode?: string;
}

interface ModeChange {
  file: string;
  executable: boolean;
}

export interface CloudAnchorResult {
  name: string;
  file: string;
  description: string;
  matched: boolean;
  line?: number;
  error?: string;
}

export interface LoadedCloudGraft {
  id: string;
  graftMdPath: string;
  graftMdText: string;
  parsed: ParsedGraft;
  forkConfig: ForkConfig;
  variantModule: string;
  variantRange: string;
  variant: ForkVariant;
}

export interface CloudGraftEvalResult {
  outcome: 'green' | 'needs-agent' | 'skipped-no-graft' | 'error';
  graftId?: string;
  upstreamUrl?: string;
  /** Materialized file map for the green merge commit or `-agent` branch commit. */
  resultFiles?: Map<string, GitFileEntry>;
  /** Resolved upstream target commit OID (40-char). */
  targetCommitOid?: string;
  conflicts: string[];
  reasons: string[];
  warnings: string[];
  likelyUpstreamed?: boolean;
  reportMd?: string;
}

/** Error subclass for tooling/environment/config errors (`outcome: 'error'`, never `needs-agent`). */
export class CloudGraftToolingError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'CloudGraftToolingError';
    this.code = code;
  }
}

const normalizeLf = (s: string): string => s.replace(/\r\n/g, '\n');

const patchHasCr = (patch: FilePatch): boolean => patch.hunks.some((h) => h.lines.some((l) => l.endsWith('\r')));

function patchToLf(raw: StructuredPatch): StructuredPatch {
  return {
    ...raw,
    hunks: raw.hunks.map((h) => ({ ...h, lines: h.lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)) })),
  };
}

const patchTarget = (p: FilePatch): string => (p.oldFile ?? p.newFile)!;

function describeHunk(hunk: StructuredPatchHunk): string {
  const first = hunk.lines.find((l) => l[0] === '+' || l[0] === '-') ?? '';
  const text = first.slice(1).trim();
  return `${first[0] === '-' ? 'replaces' : 'adds'} \`${text.length > 70 ? `${text.slice(0, 67)}…` : text}\``;
}

function locateHunk(content: string, hunk: StructuredPatchHunk): { line?: number; offset?: number; occurrences: number } {
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

function applyFilePatch(content: string, patch: FilePatch): string | false {
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

function reverseFilePatch(content: string, patch: FilePatch): string | false {
  if (patch.hunks.length === 0) return false;
  const direct = applyPatch(content, reversePatch(patch.raw), { fuzzFactor: 0 });
  if (direct !== false) return direct;
  if (!content.includes('\r\n') && !patchHasCr(patch)) return false;
  return applyPatch(normalizeLf(content), reversePatch(patchToLf(patch.raw)), { fuzzFactor: 0 });
}

/**
 * Matches `packages/adapters/fork/src/adapter.ts#touchesNewUpstreamLines`:
 * A hunk with no context on the first or last line of the file misses if upstream added lines
 * immediately before/after it.
 */
function touchesNewUpstreamLines(content: string, hunk: StructuredPatchHunk, line: number): 'before' | 'after' | undefined {
  const body = hunk.lines.filter((l) => l[0] !== '\\');
  if (!body.some((l) => l[0] !== ' ')) return undefined;
  if (body[0]![0] !== ' ' && hunk.oldStart <= 1 && line > 1) return 'before';
  const oldLen = body.filter((l) => l[0] === ' ' || l[0] === '-').length;
  const total = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  if (body.at(-1)![0] !== ' ' && line + oldLen - 1 < total) return 'after';
  return undefined;
}

function hunkAnchors(patch: FilePatch, content: string | undefined): CloudAnchorResult[] {
  const file = patchTarget(patch);
  if (patch.oldFile === null) {
    return [
      {
        name: `${file}#create`,
        file,
        description: `creates ${file}`,
        matched: content === undefined,
        ...(content === undefined ? {} : { error: 'file already exists upstream' }),
      },
    ];
  }
  if (patch.newFile === null && patch.hunks.length === 0) {
    return [
      {
        name: `${file}#delete`,
        file,
        description: `deletes ${file}`,
        matched: content !== undefined,
        ...(content !== undefined ? {} : { error: 'file missing upstream' }),
      },
    ];
  }
  return patch.hunks.map((hunk, i) => {
    const base = { name: `${file}#${i + 1}`, file, description: describeHunk(hunk) };
    if (content === undefined) return { ...base, matched: false, error: 'file missing upstream' };
    const m = locateHunk(content, hunk);
    if (!m.occurrences) return { ...base, matched: false, error: 'context or removed lines not found' };
    const edge = touchesNewUpstreamLines(content, hunk, m.line!);
    if (edge) {
      return {
        ...base,
        matched: false,
        line: m.line,
        error: `upstream added lines right ${edge} the change`,
      };
    }
    return { ...base, matched: true, line: m.line };
  });
}

function commitOfVersion(version: string): string | undefined {
  const build = semver.parse(version)?.build ?? [];
  return build.length === 1 && /^[0-9a-f]{7,40}$/i.test(build[0]!) ? build[0] : undefined;
}

function resolveRelativePath(baseDir: string, rel: string): string {
  const parts = [...baseDir.split('/').filter(Boolean), ...rel.split('/').filter(Boolean)];
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '.') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  return stack.join('/');
}

function readBlobBytes(store: GitObjectStore, entry?: GitFileEntry): Uint8Array | undefined {
  if (!entry) return undefined;
  const obj = store.get(entry.oid);
  if (!obj || obj.type !== 'blob') return undefined;
  return obj.data;
}

function readBlobText(store: GitObjectStore, entry?: GitFileEntry): string | undefined {
  const bytes = readBlobBytes(store, entry);
  return bytes ? decodeUtf8(bytes) : undefined;
}

function isGraftInternalPath(filePath: string): boolean {
  return filePath === '.grafts' || filePath.startsWith('.grafts/');
}

function isGraftEphemeralPath(filePath: string): boolean {
  return filePath.startsWith('.grafts/.cache/') || filePath.startsWith('.grafts/.report/') || filePath.startsWith('.grafts/.vendor/');
}

/**
 * Inspect `forkFiles` and load the active repo-mode `fork` graft, if any.
 * Returns `undefined` when the fork has no `.grafts/` directory (caller records `skipped-no-graft`).
 */
export function loadRepoModeGraftFromTree(
  store: GitObjectStore,
  forkFiles: Map<string, GitFileEntry>,
  targetVersion: string,
): LoadedCloudGraft | undefined {
  const hasAnyGraftFile = [...forkFiles.keys()].some((p) => p.startsWith('.grafts/') && !isGraftEphemeralPath(p));
  if (!hasAnyGraftFile) return undefined;

  const graftMdPaths = [...forkFiles.keys()].filter((p) => /^\.grafts\/[^/.][^/]*\/graft\.md$/.test(p)).sort();
  if (graftMdPaths.length === 0) return undefined;

  const activeForkGrafts: LoadedCloudGraft[] = [];
  for (const graftMdPath of graftMdPaths) {
    const id = graftMdPath.split('/')[1]!;
    const text = readBlobText(store, forkFiles.get(graftMdPath));
    if (text === undefined) {
      throw new CloudGraftToolingError(`Could not read ${graftMdPath} from fork tree`, 'graft/read');
    }
    const parsed = parseGraft(text, { directoryName: id });
    if (!parsed.ok || !parsed.graft) {
      const msgs = parsed.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `${d.code}: ${d.message}`)
        .join('; ');
      throw new CloudGraftToolingError(`Invalid ${graftMdPath}: ${msgs}`, 'graft/invalid');
    }
    const fm = parsed.graft.frontmatter;
    if (fm.status === 'upstreamed' || fm.status === 'obsolete') continue;
    if (fm.mechanism !== 'fork' || fm.fork?.install !== 'none') {
      throw new CloudGraftToolingError(
        `graft "${id}": Kody Cloud sync only supports repo-mode fork grafts (mechanism: fork, fork.install: none)`,
        'fork/config',
      );
    }

    const scheme = versionScheme(fm.rootstock.ecosystem);
    const matchedVariant = fm.variants.find((v) => scheme.satisfies(targetVersion, v.range));
    if (!matchedVariant) {
      throw new CloudGraftToolingError(`graft "${id}": no variant covers ${fm.rootstock.package}@${targetVersion}`, 'variant/none');
    }

    const variantPath = resolveRelativePath(`.grafts/${id}`, matchedVariant.module);
    const variantText = readBlobText(store, forkFiles.get(variantPath));
    if (variantText === undefined) {
      throw new CloudGraftToolingError(`graft "${id}": variant ${matchedVariant.module} not found at ${variantPath}`, 'variant/not-found');
    }
    let parsedVariant: Partial<ForkVariant>;
    try {
      parsedVariant = JSON.parse(variantText) as Partial<ForkVariant>;
    } catch (err) {
      throw new CloudGraftToolingError(
        `graft "${id}": ${matchedVariant.module} is not valid JSON: ${(err as Error).message}`,
        'variant/invalid',
      );
    }
    if (
      typeof parsedVariant.ref !== 'string' ||
      !parsedVariant.ref ||
      parsedVariant.ref === 'TODO' ||
      typeof parsedVariant.base !== 'string' ||
      !parsedVariant.base ||
      parsedVariant.base === 'TODO'
    ) {
      throw new CloudGraftToolingError(`graft "${id}": ${matchedVariant.module} must provide valid "ref" and "base"`, 'variant/invalid');
    }

    activeForkGrafts.push({
      id,
      graftMdPath,
      graftMdText: text,
      parsed: parsed.graft,
      forkConfig: fm.fork,
      variantModule: matchedVariant.module,
      variantRange: matchedVariant.range,
      variant: { ref: parsedVariant.ref, base: parsedVariant.base },
    });
  }

  if (activeForkGrafts.length === 0) return undefined;
  if (activeForkGrafts.length > 1) {
    throw new CloudGraftToolingError(
      `Multiple active repo-mode fork grafts found (${activeForkGrafts.map((g) => g.id).join(', ')}); expected one`,
      'fork/multiple',
    );
  }
  return activeForkGrafts[0]!;
}

function resolveUpstreamCommit(
  store: GitObjectStore,
  upstreamRefs: Map<string, string>,
  cfg: ForkConfig,
  spec: string,
  codeOnMissing: 'fork/no-base' | 'fork/no-commit',
): string {
  const fromBuild = commitOfVersion(spec);
  if (fromBuild) {
    const resolved = store.resolveCommitPrefix(fromBuild);
    if (resolved) return resolved;
    throw new CloudGraftToolingError(`upstream commit ${fromBuild} (from ${spec}) not found in ${cfg.upstream}`, codeOnMissing);
  }
  const tagName = cfg.tag.replaceAll('{version}', spec);
  for (const candidate of [`refs/tags/${tagName}`, `refs/tags/${spec}`, `refs/heads/${spec}`]) {
    const oid = upstreamRefs.get(candidate);
    if (oid) {
      const commit = store.peelToCommit(oid);
      if (commit) return commit;
    }
  }
  const byPrefix = store.resolveCommitPrefix(spec);
  if (byPrefix) return byPrefix;
  throw new CloudGraftToolingError(`upstream ref "${spec}" not found in ${cfg.upstream}`, codeOnMissing);
}

function inSubdir(dir: string | undefined, relPath: string): string {
  if (!dir) return relPath;
  const clean = dir.replace(/^\/+|\/+$/g, '');
  return clean ? `${clean}/${relPath}` : relPath;
}

function stripSubdir(dir: string | undefined, fullPath: string): string | undefined {
  if (!dir) return fullPath;
  const clean = dir.replace(/^\/+|\/+$/g, '');
  if (!clean) return fullPath;
  const prefix = `${clean}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : undefined;
}

function buildScopedDiffSection(
  patches: FilePatch[],
  store: GitObjectStore,
  baseFiles: Map<string, GitFileEntry>,
  targetFiles: Map<string, GitFileEntry>,
  cfg: ForkConfig,
  fromLabel: string,
  toLabel: string,
): string {
  const touched = new Set<string>(patches.map((p) => p.oldFile).filter((f): f is string => Boolean(f)));
  const out: string[] = [];
  for (const file of [...touched].sort()) {
    const full = inSubdir(cfg.dir, file);
    const oldText = readBlobText(store, baseFiles.get(full));
    const newText = readBlobText(store, targetFiles.get(full));
    if (oldText === newText) continue;
    const filePatch = patches.find((p) => p.oldFile === file);
    const regions = (filePatch?.hunks ?? []).map((h, i) => {
      const oldM = oldText !== undefined ? locateHunk(oldText, h) : undefined;
      const newM = newText !== undefined ? locateHunk(newText, h) : undefined;
      const oldStart = oldM && oldM.occurrences > 0 && oldM.line ? oldM.line : h.oldStart;
      const span = Math.max(h.oldLines - 1, 0);
      return {
        name: `${file}#${i + 1}`,
        old: [oldStart, oldStart + span] as [number, number],
        new: newM && newM.occurrences > 0 && newM.line ? ([newM.line, newM.line + span] as [number, number]) : undefined,
      };
    });

    const diffPatch = structuredPatch(`a/${file}`, `b/${file}`, oldText ?? '', newText ?? '', '', '', { context: 3 });
    const window = 10;
    const overlaps = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];
    const kept = diffPatch.hunks.filter((h) => {
      if (regions.length === 0 || oldText === undefined || newText === undefined) return true;
      const oldSpan: [number, number] = [h.oldStart, h.oldStart + Math.max(h.oldLines - 1, 0)];
      const newSpan: [number, number] = [h.newStart, h.newStart + Math.max(h.newLines - 1, 0)];
      return regions.some(
        (r) =>
          overlaps(oldSpan, [r.old[0] - window, r.old[1] + window]) || (r.new && overlaps(newSpan, [r.new[0] - window, r.new[1] + window])),
      );
    });
    if (!kept.length && oldText !== undefined && newText !== undefined) continue;
    out.push(`--- a/${file}\t(${fromLabel})`, `+++ b/${file}\t(${toLabel})`);
    if (newText === undefined) out.push(`# target removed in ${toLabel}`);
    if (kept.length < diffPatch.hunks.length) {
      out.push(`# narrowed: showing ${kept.length} of ${diffPatch.hunks.length} hunks (those near anchors)`);
    }
    for (const h of kept) {
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines);
    }
  }
  return out.join('\n');
}

function renderCloudReportMd(input: {
  generatedAt: string;
  graft: LoadedCloudGraft;
  targetVersion: string;
  outcome: 'green' | 'needs-agent' | 'error';
  reasons: string[];
  anchors: CloudAnchorResult[];
  likelyUpstreamed: boolean;
  conflicts: string[];
  scopedDiff: string;
  branch?: string;
}): string {
  const icon = input.outcome === 'green' ? '✅' : input.outcome === 'needs-agent' ? '🛠️' : '❌';
  const fm = input.graft.parsed.frontmatter;
  const exitCode = input.outcome === 'green' ? 0 : input.outcome === 'needs-agent' ? 1 : 2;
  const tag = input.likelyUpstreamed ? ' (likely upstreamed)' : '';
  const lines: string[] = [
    '# Graft sync report',
    '',
    `Generated ${input.generatedAt} (Kody Cloud). Exit code **${exitCode}**.`,
    '',
    '| Graft | Package | Verified → Target | Outcome |',
    '|---|---|---|---|',
    `| ${input.graft.id} | ${fm.rootstock.package} | ${fm.rootstock.verified} → ${input.targetVersion} | ${icon} ${input.outcome}${tag} |`,
    '',
  ];
  if (input.outcome !== 'green') {
    lines.push(`## ${input.graft.id} — ${input.outcome}${tag}`, '');
    for (const r of input.reasons) lines.push(`- ${r}`);
    lines.push('');
    lines.push(`Selected variant: \`${input.graft.variantModule}\` (\`${input.graft.variantRange}\`)`, '');
    const missed = input.anchors.filter((a) => !a.matched);
    if (missed.length) {
      lines.push('Missed anchors:', '');
      for (const a of missed) {
        lines.push(`- \`${a.name}\` in \`${a.file}\` — ${a.description}${a.error ? ` (${a.error})` : ''}`);
      }
      lines.push('');
    }
    if (input.conflicts.length) {
      lines.push(`Conflicts (git markers left in place on \`${input.branch ?? 'agent branch'}\`):`, '');
      for (const c of input.conflicts) lines.push(`- \`${c}\``);
      lines.push('');
    }
    if (input.scopedDiff.trim()) {
      lines.push('### Scoped upstream diff', '', '```diff', input.scopedDiff.trimEnd(), '```', '');
    }
    if (input.likelyUpstreamed) {
      lines.push(
        `Next: upstream ${fm.rootstock.package}@${input.targetVersion} appears to already contain this graft's change. Confirm the Invariants hold on pristine upstream, then mark \`.grafts/${input.graft.id}/graft.md\` as \`upstreamed\`.`,
        '',
      );
    } else if (input.outcome === 'needs-agent') {
      lines.push(
        `Next: check out the pushed agent branch, resolve ${input.conflicts.length ? 'the conflict markers in the listed files' : 'the missed anchors'} while preserving every Invariant in \`.grafts/${input.graft.id}/graft.md\`, verify with \`graft sync --version ${input.targetVersion}\` and the package's tests, then commit and push.`,
        '',
      );
    }
  }
  return lines.join('\n');
}

function summarizeMisses(anchors: CloudAnchorResult[], errors: string[]): string {
  const byFile = new Map<string, number>();
  for (const a of anchors) {
    if (!a.matched) byFile.set(a.file, (byFile.get(a.file) ?? 0) + 1);
  }
  const parts = [...byFile.entries()].map(([f, n]) => `${f} (${n} missed)`);
  if (errors.length) parts.push(...errors);
  return parts.join(', ');
}

function isZeroConflictPackageJsonOnly(anchors: CloudAnchorResult[], errors: string[]): boolean {
  if (errors.length > 0) return false;
  const missed = anchors.filter((a) => !a.matched);
  return missed.length > 0 && missed.every((a) => a.file === 'package.json');
}

/**
 * Evaluate a repo-mode `fork` graft in memory against `forkHead` and `targetVersion`, returning
 * either the green merged tree or the conflict-marked `-agent` tree plus a Graft markdown report.
 */
export async function evaluateRepoModeGraftInCloud(input: {
  store: GitObjectStore;
  graft: LoadedCloudGraft;
  forkHead: string;
  forkRefs: Map<string, string>;
  upstreamRefs: Map<string, string>;
  targetVersion: string;
  allowZeroConflictPackageJson: boolean;
  now: Date;
}): Promise<CloudGraftEvalResult> {
  const { store, graft, forkHead, forkRefs, upstreamRefs, targetVersion, allowZeroConflictPackageJson, now } = input;
  const cfg = graft.forkConfig;
  const fm = graft.parsed.frontmatter;
  const dateStr = now.toISOString().slice(0, 10);

  // Resolve refCommit (usually `@worktree` -> forkHead), baseCommit (usually `@verified`), and targetCommit.
  let refCommit: string | undefined;
  if (graft.variant.ref === WORKTREE) {
    refCommit = forkHead;
  } else {
    const candidateRef =
      forkRefs.get(`refs/heads/${graft.variant.ref}`) ?? forkRefs.get(`refs/tags/${graft.variant.ref}`) ?? forkRefs.get(graft.variant.ref);
    refCommit = candidateRef ? store.peelToCommit(candidateRef) : store.resolveCommitPrefix(graft.variant.ref);
  }
  if (!refCommit) {
    throw new CloudGraftToolingError(`graft "${graft.id}": fork ref "${graft.variant.ref}" not found`, 'fork/no-ref');
  }

  const baseSpec = graft.variant.base === VERIFIED ? fm.rootstock.verified : graft.variant.base;
  const baseCommit = resolveUpstreamCommit(store, upstreamRefs, cfg, baseSpec, 'fork/no-base');
  const targetCommit = resolveUpstreamCommit(store, upstreamRefs, cfg, targetVersion, 'fork/no-commit');

  const baseFiles = walkCommitTree(store, baseCommit);
  const forkFiles = walkCommitTree(store, refCommit);
  const targetFiles = walkCommitTree(store, targetCommit);

  // Compute the fork's change `base -> fork`, excluding `.grafts/`.
  const allFullPaths = new Set<string>([...baseFiles.keys(), ...forkFiles.keys()]);
  const patches: FilePatch[] = [];
  const binaries: BinaryChange[] = [];
  const modes: ModeChange[] = [];

  for (const fullPath of [...allFullPaths].sort()) {
    if (isGraftInternalPath(fullPath)) continue;
    const relPath = stripSubdir(cfg.dir, fullPath);
    if (!relPath) continue;
    const baseEntry = baseFiles.get(fullPath);
    const forkEntry = forkFiles.get(fullPath);
    if (baseEntry && forkEntry && baseEntry.oid === forkEntry.oid) {
      if (baseEntry.mode !== forkEntry.mode && /^100(644|755)$/.test(forkEntry.mode)) {
        modes.push({ file: relPath, executable: forkEntry.mode === '100755' });
      }
      continue;
    }

    const baseBytes = readBlobBytes(store, baseEntry);
    const forkBytes = readBlobBytes(store, forkEntry);
    const binary = (baseBytes && isBinaryContent(baseBytes)) || (forkBytes && isBinaryContent(forkBytes));
    if (binary) {
      binaries.push({ file: relPath, baseOid: baseEntry?.oid, refOid: forkEntry?.oid, refMode: forkEntry?.mode });
    } else {
      const baseText = baseBytes ? decodeUtf8(baseBytes) : undefined;
      const forkText = forkBytes ? decodeUtf8(forkBytes) : undefined;
      const raw = structuredPatch(
        baseText === undefined ? '/dev/null' : `a/${relPath}`,
        forkText === undefined ? '/dev/null' : `b/${relPath}`,
        baseText ?? '',
        forkText ?? '',
        '',
        '',
        { context: 3 },
      );
      patches.push({
        oldFile: baseText === undefined ? null : relPath,
        newFile: forkText === undefined ? null : relPath,
        hunks: raw.hunks,
        raw,
      });
    }

    if (
      forkEntry &&
      /^100(644|755)$/.test(forkEntry.mode) &&
      forkEntry.mode !== baseEntry?.mode &&
      (baseEntry !== undefined || forkEntry.mode === '100755')
    ) {
      modes.push({ file: relPath, executable: forkEntry.mode === '100755' });
    }
  }

  if (!patches.length && !binaries.length && !modes.length) {
    throw new CloudGraftToolingError(
      `graft "${graft.id}": fork ref "${graft.variant.ref}" has no changes on top of ${baseSpec}; a graft must never apply nothing`,
      'fork/empty',
    );
  }

  // Check anchors and likely-upstreamed against targetFiles.
  const anchors: CloudAnchorResult[] = [];
  const anchorErrors: string[] = [];
  const upstreamedEvidence: string[] = [];
  let absorbed = true;

  for (const p of patches) {
    const file = patchTarget(p);
    const targetText = readBlobText(store, targetFiles.get(inSubdir(cfg.dir, file)));
    const fileAnchors = hunkAnchors(p, targetText);
    anchors.push(...fileAnchors);
    if (targetText !== undefined && p.oldFile && fileAnchors.every((a) => a.matched) && applyFilePatch(targetText, p) === false) {
      anchorErrors.push(`${file}: hunks match individually but the change does not apply as a whole`);
    }
    if (p.oldFile === null) {
      absorbed &&= targetText !== undefined && applyFilePatch('', p) === targetText;
    } else if (p.newFile === null) {
      absorbed &&= targetText === undefined;
    } else {
      absorbed &&= targetText !== undefined && reverseFilePatch(targetText, p) !== false;
    }
    if (absorbed) {
      upstreamedEvidence.push(`${file}: upstream ${targetCommit.slice(0, 12)} already contains the fork's change`);
    }
  }

  for (const b of binaries) {
    const targetOid = targetFiles.get(inSubdir(cfg.dir, b.file))?.oid;
    const matched = targetOid === b.baseOid;
    anchors.push({
      name: `${b.file}#binary`,
      file: b.file,
      description: b.refOid ? (b.baseOid ? `replaces binary ${b.file}` : `creates binary ${b.file}`) : `deletes binary ${b.file}`,
      matched,
      ...(matched ? {} : { error: 'binary file changed upstream since the base' }),
    });
    absorbed &&= targetOid === b.refOid;
    if (targetOid === b.refOid) {
      upstreamedEvidence.push(`${b.file}: upstream ${targetCommit.slice(0, 12)} already has the fork's version`);
    }
  }

  const likelyUpstreamed = absorbed && anchors.some((a) => !a.matched);
  let allOk = anchorErrors.length === 0 && anchors.every((a) => a.matched);
  const warnings: string[] = [];
  let mergedPackageJsonOverride: string | undefined;

  // Optional Kody workaround: zero-conflict `package.json` adjacency (e.g., version bump next to name rewrite).
  if (!allOk && allowZeroConflictPackageJson && isZeroConflictPackageJsonOnly(anchors, anchorErrors)) {
    const pkgFull = inSubdir(cfg.dir, 'package.json');
    const basePkg = readBlobText(store, baseFiles.get(pkgFull));
    const targetPkg = readBlobText(store, targetFiles.get(pkgFull));
    const forkPkg = readBlobText(store, forkFiles.get(pkgFull));
    if (basePkg !== undefined && targetPkg !== undefined && forkPkg !== undefined) {
      const m = merge3(basePkg, targetPkg, forkPkg, { ours: `upstream ${targetCommit.slice(0, 12)}`, theirs: 'fork' });
      if (!m.conflicted) {
        mergedPackageJsonOverride = m.content;
        allOk = true;
        warnings.push('adopted zero-conflict package.json merge and re-verified with graft sync');
      }
    }
  }

  const attachGraftDir = async (
    destFiles: Map<string, GitFileEntry>,
    update: { verified: string; status: string; history: string },
  ): Promise<void> => {
    for (const k of destFiles.keys()) {
      if (isGraftInternalPath(k)) destFiles.delete(k);
    }
    for (const [p, entry] of forkFiles) {
      if (!isGraftInternalPath(p) || isGraftEphemeralPath(p)) continue;
      if (p === graft.graftMdPath) {
        const editor = new GraftDocumentEditor(graft.graftMdText);
        editor.setVerified(update.verified);
        editor.setStatus(update.status);
        editor.appendHistory(update.history, dateStr);
        const updatedOid = await store.writeBlob(editor.toString());
        destFiles.set(p, { mode: entry.mode, oid: updatedOid });
      } else {
        destFiles.set(p, entry);
      }
    }
  };

  if (allOk) {
    const resultFiles = new Map<string, GitFileEntry>(targetFiles);
    for (const p of patches) {
      const file = patchTarget(p);
      const full = inSubdir(cfg.dir, file);
      if (file === 'package.json' && mergedPackageJsonOverride !== undefined) {
        const existingMode = targetFiles.get(full)?.mode ?? forkFiles.get(full)?.mode ?? '100644';
        resultFiles.set(full, { mode: existingMode, oid: await store.writeBlob(mergedPackageJsonOverride) });
        continue;
      }
      if (p.oldFile === null) {
        const forkEntry = forkFiles.get(full)!;
        resultFiles.set(full, { mode: forkEntry.mode, oid: forkEntry.oid });
      } else if (p.newFile === null) {
        resultFiles.delete(full);
      } else {
        const targetEntry = targetFiles.get(full)!;
        const targetText = readBlobText(store, targetEntry)!;
        const patched = applyFilePatch(targetText, p);
        if (patched === false) {
          throw new CloudGraftToolingError(`graft "${graft.id}": failed to apply patch to ${file}`, 'fork/rebase');
        }
        resultFiles.set(full, { mode: targetEntry.mode, oid: await store.writeBlob(patched) });
      }
    }
    for (const b of binaries) {
      const full = inSubdir(cfg.dir, b.file);
      if (b.refOid) {
        resultFiles.set(full, { mode: b.refMode ?? targetFiles.get(full)?.mode ?? '100644', oid: b.refOid });
      } else {
        resultFiles.delete(full);
      }
    }
    for (const m of modes) {
      const full = inSubdir(cfg.dir, m.file);
      const cur = resultFiles.get(full);
      if (cur) resultFiles.set(full, { mode: m.executable ? '100755' : '100644', oid: cur.oid });
    }

    const historyNote =
      fm.rootstock.verified !== targetVersion
        ? `Verified against ${fm.rootstock.package}@${targetVersion} by \`graft sync\` (cheap path, variant ${graft.variantModule} unchanged).`
        : `Re-verified against ${fm.rootstock.package}@${targetVersion}; status set to applied.`;
    await attachGraftDir(resultFiles, { verified: targetVersion, status: 'applied', history: historyNote });

    const reportMd = renderCloudReportMd({
      generatedAt: now.toISOString(),
      graft,
      targetVersion,
      outcome: 'green',
      reasons: [],
      anchors,
      likelyUpstreamed: false,
      conflicts: [],
      scopedDiff: '',
    });

    return {
      outcome: 'green',
      graftId: graft.id,
      upstreamUrl: cfg.upstream,
      resultFiles,
      targetCommitOid: targetCommit,
      conflicts: [],
      reasons: [],
      warnings,
      reportMd,
    };
  }

  // Needs-agent path: build 3-way merged `-agent` tree with conflict markers + scoped upstream diff.
  const agentFiles = new Map<string, GitFileEntry>();
  const conflicts: string[] = [];
  const allMergePaths = new Set<string>([...baseFiles.keys(), ...targetFiles.keys(), ...forkFiles.keys()]);

  for (const fullPath of [...allMergePaths].sort()) {
    if (isGraftInternalPath(fullPath)) continue;
    const baseE = baseFiles.get(fullPath);
    const oursE = targetFiles.get(fullPath);
    const theirsE = forkFiles.get(fullPath);

    const oursSameAsBase = oursE?.oid === baseE?.oid && oursE?.mode === baseE?.mode;
    const theirsSameAsBase = theirsE?.oid === baseE?.oid && theirsE?.mode === baseE?.mode;
    const oursSameAsTheirs = oursE?.oid === theirsE?.oid && oursE?.mode === theirsE?.mode;

    if (oursSameAsTheirs) {
      if (oursE) agentFiles.set(fullPath, oursE);
      continue;
    }
    if (oursSameAsBase) {
      if (theirsE) agentFiles.set(fullPath, theirsE);
      continue;
    }
    if (theirsSameAsBase) {
      if (oursE) agentFiles.set(fullPath, oursE);
      continue;
    }

    // Both sides changed differently from base.
    if (!oursE || !theirsE) {
      // Modify/delete conflict.
      conflicts.push(fullPath);
      if (theirsE) agentFiles.set(fullPath, theirsE);
      else if (oursE) agentFiles.set(fullPath, oursE);
      continue;
    }

    const baseB = readBlobBytes(store, baseE);
    const oursB = readBlobBytes(store, oursE)!;
    const theirsB = readBlobBytes(store, theirsE)!;
    if ((baseB && isBinaryContent(baseB)) || isBinaryContent(oursB) || isBinaryContent(theirsB)) {
      conflicts.push(fullPath);
      agentFiles.set(fullPath, theirsE);
      continue;
    }

    const m = merge3(baseB ? decodeUtf8(baseB) : '', decodeUtf8(oursB), decodeUtf8(theirsB), {
      ours: `upstream ${targetCommit.slice(0, 12)}`,
      theirs: 'fork',
    });
    if (m.conflicted) conflicts.push(fullPath);
    const mergedOid = await store.writeBlob(m.content);
    agentFiles.set(fullPath, { mode: theirsE.mode, oid: mergedOid });
  }

  const label = `commit ${targetCommit.slice(0, 12)}`;
  await attachGraftDir(agentFiles, {
    verified: targetVersion,
    status: conflicts.length > 0 ? 'conflicted' : fm.status,
    history: `Merged onto ${label} by \`graft sync\`${conflicts.length ? `; conflicts to resolve in ${conflicts.join(', ')}` : ''}.`,
  });

  const reasons: string[] = [];
  if (likelyUpstreamed) {
    reasons.push(
      `upstream ${fm.rootstock.package}@${targetVersion} already contains this graft's change; confirm and set status: upstreamed (${upstreamedEvidence.join('; ')})`,
    );
  }
  reasons.push(`anchors: ${summarizeMisses(anchors, anchorErrors)}`);

  const scopedDiff = buildScopedDiffSection(
    patches,
    store,
    baseFiles,
    targetFiles,
    cfg,
    `${fm.rootstock.package} fork base (${baseSpec})`,
    `${fm.rootstock.package}@${targetVersion}`,
  );

  const reportMd = renderCloudReportMd({
    generatedAt: now.toISOString(),
    graft,
    targetVersion,
    outcome: 'needs-agent',
    reasons,
    anchors,
    likelyUpstreamed,
    conflicts,
    scopedDiff,
    branch: `graft/agent-${targetCommit.slice(0, 12)}`,
  });

  return {
    outcome: 'needs-agent',
    graftId: graft.id,
    upstreamUrl: cfg.upstream,
    resultFiles: agentFiles,
    targetCommitOid: targetCommit,
    conflicts,
    reasons,
    warnings,
    likelyUpstreamed,
    reportMd,
  };
}
