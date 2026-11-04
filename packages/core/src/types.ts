import type { Diagnostic, GraftFrontmatter, Section, VariantRef } from '@graftsync/spec';
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
  /** Checks that could not be made (e.g. installed files unreadable); they do not fail the report. */
  warnings?: string[];
  ok: boolean;
}

export interface AppliedFile {
  file: string;
  changed: boolean;
  /** Where the modified output was written, if an output directory was requested. */
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
  /** Write modified files here (mirrors package layout) for inspection. */
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

export interface BeforeInstallResult {
  /**
   * 'reinstall': the mechanism already pointed the package manager at the target (e.g. a
   * vendored tarball override), so run a bare install instead of `add <pkg>@<version>`,
   * which would replace that configuration.
   */
  install?: 'reinstall';
}

/** One installed copy of the rootstock package, as handled by `applyInstalled`. */
export interface InstalledCopyResult {
  /** Real path of the installed package directory. */
  dir: string;
  version: string;
  /** True for the copy the project itself resolves (the one the oracle exercises). */
  primary: boolean;
  action: 'patched' | 'already-patched' | 'skipped' | 'failed';
  /** Files written (or that were already patched). */
  files: string[];
  variant?: string;
  /** Why it was skipped or failed. */
  reason?: string;
}

export interface InstalledApplyReport {
  graft: string;
  package: string;
  copies: InstalledCopyResult[];
  /** Failures that must fail the install (primary copy uncovered, a patch that does not fit…). */
  errors: string[];
  /** Non-fatal notes (e.g. a nested copy of another version that no variant covers). */
  warnings: string[];
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
  /**
   * Prepare the package manager to apply the variant for `version` on the next install
   * (e.g. point pnpm patchedDependencies at it). Called by `sync --install` before installing.
   */
  beforeInstall?(ctx: GraftContext, version: string): Promise<void | BeforeInstallResult>;
  /**
   * Called by `sync --install` right after installing `version`. Mechanisms that apply
   * themselves (rather than through the package manager) do so here, because package
   * managers do not reliably run the project's lifecycle scripts on a targeted install.
   */
  afterInstall?(ctx: GraftContext, version: string): Promise<void>;
  /**
   * Apply the selected variants directly to the installed package copies (run from the
   * project's postinstall). Must be idempotent, work offline, and never modify files shared
   * with a package-manager store (write new inodes).
   */
  applyInstalled?(ctx: GraftContext): Promise<InstalledApplyReport>;
  /** Validate a new variant module before it is registered. Throw to reject. */
  validateVariant?(ctx: GraftContext, variant: ResolvedVariant): Promise<void>;
  /** File extension of variant modules, used when scaffolding (e.g. `.patch`). Default `.ts`. */
  variantExtension?: string;
  /** Scaffold a variant module stub. Returns file contents. */
  variantTemplate?(graft: { id: string; targets?: string[]; package: string }): string;
}
