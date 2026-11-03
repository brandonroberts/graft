import type { Diagnostic, GraftFrontmatter, Section, VariantRef } from '@graft/spec';
import type { Project } from './project.js';

/** A graft loaded from `.grafts/<id>/graft.md`. */
export interface Graft {
  id: string;
  /** Absolute path of the graft directory. */
  dir: string;
  /** Absolute path of graft.md. */
  file: string;
  frontmatter: GraftFrontmatter;
  body: string;
  sections: Section[];
  diagnostics: Diagnostic[];
}

/** A graft directory that failed to parse. */
export interface InvalidGraft {
  id: string;
  dir: string;
  file: string;
  diagnostics: Diagnostic[];
}

export interface GraftContext {
  project: Project;
  graft: Graft;
}

export interface ResolvedVariant extends VariantRef {
  /** Absolute path of the variant module. */
  path: string;
}

export interface AnchorResult {
  /** Anchor name as declared by the variant. */
  name: string;
  /** Target file (relative to the package root) the anchor is matched in. */
  file: string;
  matched: boolean;
  description?: string;
  /** 1-based line/column of the match, when matched. */
  location?: { line: number; column: number; start: number; end: number };
  /** Why the anchor missed, or why it could not be evaluated. */
  error?: string;
}

export interface AnchorReport {
  graft: string;
  package: string;
  version: string;
  /** Variant selected for `version`, or null when no variant range matches. */
  variant: ResolvedVariant | null;
  anchors: AnchorResult[];
  /** Problems not tied to a single anchor (missing variant, missing target, load error). */
  errors: string[];
  ok: boolean;
}

export interface AppliedFile {
  file: string;
  changed: boolean;
  /** Where the transformed output was written, if an output directory was requested. */
  outputPath?: string;
  error?: string;
}

export interface ApplyResult {
  graft: string;
  version: string;
  variant: ResolvedVariant | null;
  files: AppliedFile[];
  errors: string[];
  ok: boolean;
}

export interface ApplyOptions {
  /** Upstream version to apply against. Defaults to the installed version. */
  version?: string;
  /** Write transformed files here (mirrors package layout) for inspection. */
  outDir?: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Unified-diff lines, each prefixed with ' ', '+' or '-'. */
  lines: string[];
  /** Anchor names this hunk is near or mentions. */
  anchors: string[];
}

export interface ScopedFileDiff {
  file: string;
  status: 'modified' | 'unchanged' | 'added' | 'removed';
  /** Total hunks in the full file diff. */
  totalHunks: number;
  /** Hunks kept after narrowing to anchor regions. */
  hunks: DiffHunk[];
  /** False when no anchor could be located and the full diff is returned. */
  narrowed: boolean;
  /** For removed targets: files in the new version that contain anchor symbols. */
  candidates?: string[];
}

export interface ScopedDiff {
  graft: string;
  package: string;
  from: string;
  to: string;
  files: ScopedFileDiff[];
  /** Unified patch text of the kept hunks, ready to show an agent. */
  patch: string;
}

export interface VariantInput {
  range: string;
  /** Module path relative to the graft directory (e.g. ./variants/v5.ts). */
  module: string;
  /**
   * Narrow open-ended ranges of existing variants that overlap the new range
   * (e.g. ">=4.0.0" becomes ">=4.0.0 <5.0.0-0"). Variant modules are never edited.
   * Defaults to true.
   */
  narrow?: boolean;
}

/** A mechanism (build transform, patch file, vendored copy, fork) that applies grafts. */
export interface MechanismAdapter {
  name: string;
  /** Apply the matching variant for the resolved upstream version. */
  apply(ctx: GraftContext, options?: ApplyOptions): Promise<ApplyResult>;
  /** Report which anchors match/miss in the target upstream version. */
  checkAnchors(ctx: GraftContext, version: string): Promise<AnchorReport>;
  /** Diff only the upstream regions this graft targets, between two versions. */
  scopeDiff(ctx: GraftContext, from: string, to: string): Promise<ScopedDiff>;
  /** Validate a new variant module before it is registered. Throw to reject. */
  validateVariant?(ctx: GraftContext, variant: ResolvedVariant): Promise<void>;
  /** Scaffold a variant module stub. Returns file contents. */
  variantTemplate?(graft: { id: string; targets?: string[]; package: string }): string;
}
