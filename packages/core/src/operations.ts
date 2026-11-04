import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { GRAFT_STATUSES, GraftDocumentEditor, type GraftStatus } from '@graftsync/spec';
import { GraftError } from './errors.js';
import type { Project } from './project.js';
import { reinstall } from './install.js';
import type { GraftUpdate, InstalledApplyReport, AnchorReport, ApplyOptions, ApplyResult, Graft, ScopedDiff, VariantInput } from './types.js';

/** Resolve a version argument, defaulting to the installed version of the graft's rootstock. */
export async function resolveVersion(project: Project, graft: Graft, version?: string): Promise<string> {
  if (version) {
    if (!semver.valid(version)) throw new GraftError(`"${version}" is not a valid semver version`, 'version/invalid');
    return version;
  }
  const installed = await project.currentVersion(graft);
  if (!installed) {
    throw new GraftError(
      `${graft.frontmatter.rootstock.package} is not installed; pass an explicit version`,
      'upstream/not-installed',
    );
  }
  return installed;
}

export async function checkAnchors(project: Project, id: string, version?: string): Promise<AnchorReport> {
  const graft = await project.get(id);
  const v = await resolveVersion(project, graft, version);
  return project.adapterFor(graft).checkAnchors(project.context(graft), v);
}

export async function applyGraft(project: Project, id: string, options: ApplyOptions = {}): Promise<ApplyResult> {
  const graft = await project.get(id);
  const version = await resolveVersion(project, graft, options.version);
  return project.adapterFor(graft).apply(project.context(graft), { ...options, version });
}

export async function scopeDiff(project: Project, id: string, from?: string, to?: string): Promise<ScopedDiff> {
  const graft = await project.get(id);
  const f = from ?? graft.frontmatter.rootstock.verified;
  const t = await resolveVersion(project, graft, to);
  return project.adapterFor(graft).scopeDiff(project.context(graft), f, t);
}

async function editGraft(graft: Graft, edit: (doc: GraftDocumentEditor) => void): Promise<string> {
  const original = await readFile(graft.file, 'utf8');
  const doc = new GraftDocumentEditor(original);
  edit(doc);
  await writeFile(graft.file, doc.toString());
  return original;
}

export interface UpdateStatusInput extends GraftUpdate {
  status?: GraftStatus;
}

export async function updateGraft(project: Project, id: string, input: UpdateStatusInput): Promise<Graft> {
  const graft = await project.get(id, { allowConflicts: true });
  if (input.status && !GRAFT_STATUSES.includes(input.status)) {
    throw new GraftError(`invalid status "${input.status}" (expected ${GRAFT_STATUSES.join(' | ')})`, 'status/invalid');
  }
  if (input.verified && !semver.valid(input.verified)) {
    throw new GraftError(`"${input.verified}" is not a valid semver version`, 'version/invalid');
  }
  await editGraft(graft, (doc) => {
    if (input.status) doc.setStatus(input.status);
    if (input.verified) doc.setVerified(input.verified);
    if (input.history) doc.appendHistory(input.history);
  });
  return project.get(id, { allowConflicts: true });
}

/** Append `<extra>` to every comparator set of `range` (handles `||` unions). */
function capRange(range: string, upperExclusive: string): string {
  return range
    .split('||')
    .map((set) => `${set.trim()} <${upperExclusive}`.trim())
    .join(' || ');
}

function isSatisfiable(range: string): boolean {
  const min = semver.minVersion(range);
  return !!min && semver.satisfies(min, range, { includePrerelease: true });
}

export interface RecordVariantOptions {
  /** Refuse to record unless all anchors match at this version (the record is rolled back). */
  verifyVersion?: string;
  /** Extra text for the History entry (what moved upstream, how the variant differs). */
  note?: string;
}

export interface RecordVariantResult {
  graft: Graft;
  /** Existing variants whose ranges were narrowed: index → new range. */
  narrowed: { module: string; from: string; to: string }[];
  anchors?: AnchorReport;
}

/**
 * Register a new variant for a version range. Never edits existing variant modules;
 * may narrow open-ended ranges of existing variants so ranges stay disjoint.
 */
export async function recordVariant(
  project: Project,
  id: string,
  input: VariantInput,
  options: RecordVariantOptions = {},
): Promise<RecordVariantResult> {
  const graft = await project.get(id);
  const opts = { includePrerelease: true };
  if (!semver.validRange(input.range, opts)) {
    throw new GraftError(`"${input.range}" is not a valid semver range`, 'variant/invalid-range');
  }
  // Verifying at a version outside the new range would check whichever *other* variant covers
  // that version, and pass without ever looking at the new one.
  if (options.verifyVersion && !semver.satisfies(options.verifyVersion, input.range, opts)) {
    throw new GraftError(
      `verify version ${options.verifyVersion} is not in the new variant's range "${input.range}"; verify at a version the variant covers`,
      'variant/verify-out-of-range',
    );
  }
  const modulePath = path.resolve(graft.dir, input.module);
  if (!modulePath.startsWith(graft.dir + path.sep)) {
    throw new GraftError(`variant module must live inside ${graft.dir}`, 'variant/outside-graft');
  }
  if (!existsSync(modulePath)) throw new GraftError(`variant module not found: ${modulePath}`, 'variant/not-found');
  const moduleRef = `./${path.relative(graft.dir, modulePath).split(path.sep).join('/')}`;
  const variants = graft.frontmatter.variants;
  if (variants.some((v) => path.resolve(graft.dir, v.module) === modulePath)) {
    throw new GraftError(
      `${moduleRef} is already registered; never edit an existing variant — write a new module for the new range`,
      'variant/exists',
    );
  }

  const narrow = input.narrow ?? true;
  const updates = new Map<number, string>();
  const narrowed: RecordVariantResult['narrowed'] = [];
  const newMin = semver.minVersion(input.range);
  variants.forEach((v, i) => {
    if (!semver.intersects(v.range, input.range, opts)) return;
    const capped = newMin ? capRange(v.range, newMin.version) : undefined;
    if (!narrow || !capped || !isSatisfiable(capped) || semver.intersects(capped, input.range, opts)) {
      throw new GraftError(
        `range "${input.range}" overlaps existing variant ${v.module} ("${v.range}") and cannot be narrowed automatically; choose a disjoint range`,
        'variant/overlap',
      );
    }
    updates.set(i, capped);
    narrowed.push({ module: v.module, from: v.range, to: capped });
  });

  await project.adapterFor(graft).validateVariant?.(project.context(graft), {
    range: input.range,
    module: moduleRef,
    path: modulePath,
  });

  const history =
    `Added variant ${moduleRef} for "${input.range}".` +
    (narrowed.length ? ` Narrowed ${narrowed.map((n) => `${n.module} to "${n.to}"`).join(', ')}.` : '') +
    (options.note ? ` ${options.note}` : '');
  const original = await editGraft(graft, (doc) => {
    doc.addVariant({ range: input.range, module: moduleRef }, updates);
    doc.appendHistory(history);
  });

  let anchors: AnchorReport | undefined;
  try {
    const updated = await project.get(id);
    if (options.verifyVersion) {
      anchors = await project.adapterFor(updated).checkAnchors(project.context(updated), options.verifyVersion);
      if (!anchors.ok) {
        throw new GraftError(
          `variant does not match ${updated.frontmatter.rootstock.package}@${options.verifyVersion}: ${summarizeMisses(anchors)}`,
          'variant/anchors-miss',
        );
      }
    }
    return { graft: updated, narrowed, anchors };
  } catch (err) {
    await writeFile(graft.file, original);
    throw err;
  }
}

/** One line for a report: errors, then missed anchors grouped by file (long lists are cut). */
export function summarizeMisses(report: AnchorReport, maxFiles = 10): string {
  const missed = report.anchors.filter((a) => !a.matched);
  const byFile = new Map<string, typeof missed>();
  for (const a of missed) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a]);
  const files = [...byFile].map(([file, anchors]) => {
    const why = [...new Set(anchors.map((a) => a.error).filter(Boolean))].join(', ');
    const names = anchors.map((a) => (a.name.startsWith(`${file}#`) ? a.name.slice(file.length) : `"${a.name}"`)).join(' ');
    return `${file} ${names}${why ? ` (${why})` : ''}`;
  });
  const parts = [...report.errors];
  if (missed.length === 1) parts.push(`anchor "${missed[0]!.name}" missed in ${missed[0]!.file}${missed[0]!.error ? ` (${missed[0]!.error})` : ''}`);
  else if (missed.length) {
    const shown = files.slice(0, maxFiles).join('; ');
    const more = files.length > maxFiles ? `; and ${files.length - maxFiles} more file(s)` : '';
    parts.push(`${missed.length} anchors missed in ${files.length} file(s): ${shown}${more}`);
  }
  return parts.join('; ') || 'ok';
}

export interface GraftStatusEntry {
  id: string;
  package: string;
  mechanism: string;
  status: GraftStatus;
  verified: string;
  installed?: string;
  /** Anchor health against the installed version; absent for inactive grafts or when not installed. */
  anchors?: AnchorReport;
  error?: string;
}

/** Status of every graft, with anchor health against installed versions. */
export async function projectStatus(project: Project): Promise<{
  grafts: GraftStatusEntry[];
  invalid: { id: string; errors: string[] }[];
}> {
  const { grafts, invalid } = await project.loadAll();
  const entries: GraftStatusEntry[] = [];
  for (const graft of grafts) {
    const fm = graft.frontmatter;
    const entry: GraftStatusEntry = {
      id: graft.id,
      package: fm.rootstock.package,
      mechanism: fm.mechanism,
      status: fm.status,
      verified: fm.rootstock.verified,
      installed: await project.currentVersion(graft),
    };
    if (entry.installed && (fm.status === 'applied' || fm.status === 'conflicted')) {
      try {
        entry.anchors = await project.adapterFor(graft).checkAnchors(project.context(graft), entry.installed);
      } catch (err) {
        entry.error = (err as Error).message;
      }
    }
    entries.push(entry);
  }
  return {
    grafts: entries,
    invalid: invalid.map((g) => ({
      id: g.id,
      errors: g.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
    })),
  };
}

export interface ApplyToProjectResult {
  /** Grafts whose package-manager configuration was pointed at their selected variant. */
  configured: { id: string; package: string; version: string; variant: string }[];
  /** Reinstall command that was run, if any. */
  installCommand?: string;
  /** Anchor reports at the installed versions, after configuring and reinstalling. */
  anchors: AnchorReport[];
  errors: { id: string; error: string }[];
}

/**
 * Make the project actually use its grafts: point the package manager at the variant selected
 * for each installed version (e.g. pnpm patchedDependencies), reinstall, and re-check anchors.
 */
export async function applyToProject(project: Project, options: { ids?: string[]; install?: boolean } = {}): Promise<ApplyToProjectResult> {
  const { grafts } = await project.loadAll();
  const result: ApplyToProjectResult = { configured: [], anchors: [], errors: [] };
  const selected = grafts.filter(
    (g) => (g.frontmatter.status === 'applied' || g.frontmatter.status === 'conflicted') && (!options.ids?.length || options.ids.includes(g.id)),
  );
  for (const graft of selected) {
    const pkg = graft.frontmatter.rootstock.package;
    try {
      const version = await resolveVersion(project, graft);
      const variant = project.selectVariant(graft, version);
      if (!variant) throw new GraftError(`no variant covers ${pkg}@${version}`, 'variant/none');
      await project.adapterFor(graft).beforeInstall?.(project.context(graft), version);
      result.configured.push({ id: graft.id, package: pkg, version, variant: variant.module });
    } catch (err) {
      result.errors.push({ id: graft.id, error: (err as Error).message });
    }
  }
  if (options.install !== false && result.configured.length) result.installCommand = await reinstall(project.root);
  for (const c of result.configured) {
    const graft = await project.get(c.id);
    result.anchors.push(await project.adapterFor(graft).checkAnchors(project.context(graft), c.version));
  }
  return result;
}

/**
 * Apply every active graft directly to the installed packages (Graft's built-in applier, run
 * from postinstall). Offline and idempotent; returns per-graft reports.
 */
export async function applyInstalled(project: Project, options: { ids?: string[] } = {}): Promise<{ reports: InstalledApplyReport[]; ok: boolean }> {
  const { grafts, invalid } = await project.loadAll();
  const reports: InstalledApplyReport[] = invalid.map((g) => ({
    graft: g.id,
    package: '?',
    copies: [],
    errors: g.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
    warnings: [],
  }));
  for (const graft of grafts) {
    if (graft.frontmatter.status !== 'applied' && graft.frontmatter.status !== 'conflicted') continue;
    if (options.ids?.length && !options.ids.includes(graft.id)) continue;
    const adapter = project.adapterFor(graft);
    if (!adapter.applyInstalled) continue;
    try {
      reports.push(await adapter.applyInstalled(project.context(graft)));
    } catch (err) {
      reports.push({ graft: graft.id, package: graft.frontmatter.rootstock.package, copies: [], errors: [(err as Error).message], warnings: [] });
    }
  }
  return { reports, ok: reports.every((r) => r.errors.length === 0) };
}
