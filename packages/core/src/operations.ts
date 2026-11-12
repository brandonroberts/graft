import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GRAFT_STATUSES, GraftDocumentEditor, type GraftStatus } from '@graftsync/spec';
import { GraftError } from './errors.js';
import type { Project } from './project.js';
import type {
  GraftUpdate,
  InstalledApplyReport,
  AnchorReport,
  ApplyOptions,
  ApplyResult,
  Graft,
  ScopedDiff,
  VariantInput,
} from './types.js';

/** Resolve a version argument, defaulting to the installed version of the graft's rootstock. */
export async function resolveVersion(project: Project, graft: Graft, version?: string): Promise<string> {
  if (version) {
    version = project.ecosystemFor(graft).normalizeVersion?.(version) ?? version;
    const scheme = project.schemeFor(graft);
    if (!scheme.valid(version)) throw new GraftError(`"${version}" is not a valid ${schemeLabel(scheme.name)} version`, 'version/invalid');
    return version;
  }
  const installed = await project.currentVersion(graft);
  if (!installed) {
    throw new GraftError(`${graft.frontmatter.rootstock.package} is not installed; pass an explicit version`, 'upstream/not-installed');
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
  const scheme = project.schemeFor(graft);
  if (input.verified && !scheme.valid(input.verified)) {
    throw new GraftError(`"${input.verified}" is not a valid ${schemeLabel(scheme.name)} version`, 'version/invalid');
  }
  await editGraft(graft, (doc) => {
    if (input.status) doc.setStatus(input.status);
    if (input.verified) doc.setVerified(input.verified);
    if (input.history) doc.appendHistory(input.history);
  });
  return project.get(id, { allowConflicts: true });
}

const schemeLabel = (name: string) => (name === 'pep440' ? 'PEP 440' : 'semver');

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
  const scheme = project.schemeFor(graft);
  if (!scheme.validRange(input.range)) {
    throw new GraftError(`"${input.range}" is not a valid ${schemeLabel(scheme.name)} range`, 'variant/invalid-range');
  }
  // Verifying at a version outside the new range would check whichever *other* variant covers
  // that version, and pass without ever looking at the new one.
  if (options.verifyVersion && !scheme.satisfies(options.verifyVersion, input.range)) {
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
  const newMin = scheme.minVersion(input.range);
  variants.forEach((v, i) => {
    if (!scheme.intersects(v.range, input.range)) return;
    const capped = newMin ? scheme.capBelow(v.range, newMin) : undefined;
    if (!narrow || !capped || !scheme.satisfiable(capped) || scheme.intersects(capped, input.range)) {
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
  if (missed.length === 1)
    parts.push(`anchor "${missed[0]!.name}" missed in ${missed[0]!.file}${missed[0]!.error ? ` (${missed[0]!.error})` : ''}`);
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
  ecosystem?: string;
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
      ecosystem: fm.rootstock.ecosystem,
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
  configured: { id: string; package: string; ecosystem?: string; version: string; variant: string }[];
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
    (g) =>
      (g.frontmatter.status === 'applied' || g.frontmatter.status === 'conflicted') && (!options.ids?.length || options.ids.includes(g.id)),
  );
  for (const graft of selected) {
    const pkg = graft.frontmatter.rootstock.package;
    try {
      const version = await resolveVersion(project, graft);
      const variant = project.selectVariant(graft, version);
      if (!variant) throw new GraftError(`no variant covers ${pkg}@${version}`, 'variant/none');
      await project.adapterFor(graft).beforeInstall?.(project.context(graft), version);
      result.configured.push({
        id: graft.id,
        package: pkg,
        ecosystem: graft.frontmatter.rootstock.ecosystem,
        version,
        variant: variant.module,
      });
    } catch (err) {
      result.errors.push({ id: graft.id, error: (err as Error).message });
    }
  }
  if (options.install !== false && result.configured.length) {
    // One reinstall per ecosystem whose configuration changed (npm, cargo, go, pypi).
    const ecosystems = [...new Set(result.configured.map((c) => c.ecosystem ?? 'npm'))];
    const commands: string[] = [];
    for (const name of ecosystems) commands.push(await project.ecosystemFor(name).reinstall(project));
    result.installCommand = commands.join(' && ');
  }
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
export async function applyInstalled(
  project: Project,
  options: { ids?: string[] } = {},
): Promise<{ reports: InstalledApplyReport[]; ok: boolean }> {
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
      reports.push({
        graft: graft.id,
        package: graft.frontmatter.rootstock.package,
        copies: [],
        errors: [(err as Error).message],
        warnings: [],
      });
    }
  }
  return { reports, ok: reports.every((r) => r.errors.length === 0) };
}

export interface CaptureResult {
  graft: string;
  version: string;
  /** Variant module written, relative to the graft directory. */
  module: string;
  /** True when it replaced the untouched scaffold stub; false when it was added as a new variant. */
  replacedStub: boolean;
  /** For a new variant: the range it was registered for. */
  range?: string;
  /** The captured variant applied to the pristine package (static check; nothing is installed). */
  apply: ApplyResult;
}

/**
 * `graft capture`: record the change made to the installed copy of a graft's package as a
 * variant. Replaces the selected variant only while it is still the scaffold stub; otherwise adds
 * a new variant for `>=version` (never editing an existing one). Rolls back unless the captured
 * variant applies to the pristine package at `version`. (Not the installed-copy checks: the
 * package manager still points at the previous variant until `graft apply`.)
 */
export async function captureVariant(project: Project, id: string, options: { version?: string } = {}): Promise<CaptureResult> {
  const graft = await project.get(id);
  const adapter = project.adapterFor(graft);
  if (!adapter.capture)
    throw new GraftError(`mechanism "${adapter.name}" can't capture a variant from an installed copy`, 'capture/unsupported');
  const version = await resolveVersion(project, graft, options.version);
  const content = await adapter.capture(project.context(graft), version);
  const fm = graft.frontmatter;
  const scaffold = {
    id: graft.id,
    package: fm.rootstock.package,
    ecosystem: fm.rootstock.ecosystem,
    targets: fm.targets,
    root: project.root,
    options: {},
  };

  const selected = project.selectVariant(graft, version);
  const current = selected && existsSync(selected.path) ? await readFile(selected.path, 'utf8') : undefined;
  const isStub =
    current !== undefined &&
    (current === adapter.variantTemplate?.(scaffold) || current.split('\n').every((l) => !l.trim() || l.startsWith('#')));

  const verify = async () => {
    const fresh = await project.get(id);
    const result = await project.adapterFor(fresh).apply(project.context(fresh), { version });
    if (!result.ok) {
      const why = [...result.errors, ...result.files.filter((f) => f.error).map((f) => `${f.file}: ${f.error}`)].join('; ');
      throw new GraftError(`the captured variant does not apply to pristine ${fm.rootstock.package}@${version}: ${why}`, 'capture/apply');
    }
    return result;
  };

  if (selected && isStub) {
    await writeFile(selected.path, content);
    try {
      const apply = await verify();
      await updateGraft(project, id, {
        history: `Captured ${selected.module} from the installed ${fm.rootstock.package}@${version} with \`graft capture\`.`,
      });
      return { graft: id, version, module: selected.module, replacedStub: true, apply };
    } catch (err) {
      await writeFile(selected.path, current);
      throw err;
    }
  }

  // A real variant exists: add a new one for this version onwards.
  const ext = adapter.variantExtension ?? '.patch';
  let rel = `variants/v${version}${ext}`;
  for (let n = 2; existsSync(path.join(graft.dir, rel)); n++) rel = `variants/v${version}-${n}${ext}`;
  const module = `./${rel}`;
  const range = project.schemeFor(graft).from(version);
  await mkdir(path.dirname(path.join(graft.dir, rel)), { recursive: true });
  await writeFile(path.join(graft.dir, rel), content);
  const original = await readFile(graft.file, 'utf8');
  try {
    await recordVariant(
      project,
      id,
      { range, module },
      { note: `Captured from the installed ${fm.rootstock.package}@${version} with \`graft capture\`.` },
    );
    const apply = await verify();
    return { graft: id, version, module, replacedStub: false, range, apply };
  } catch (err) {
    await writeFile(graft.file, original);
    await rm(path.join(graft.dir, rel), { force: true });
    throw err;
  }
}
