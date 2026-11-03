import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ACTIVE_STATUSES } from '@graft/spec';
import { GraftError } from './errors.js';
import { installPackage } from './install.js';
import { runOracle, type OracleResult } from './oracle.js';
import { summarizeMisses, updateGraft } from './operations.js';
import type { Project } from './project.js';
import type { AnchorReport, ApplyResult, Graft, ResolvedVariant } from './types.js';

export type SyncOutcome = 'green' | 'needs-agent' | 'skipped' | 'error';

export interface SyncGraftResult {
  id: string;
  package: string;
  /** rootstock.verified before this sync. */
  from: string;
  /** Version synced against. */
  to?: string;
  outcome: SyncOutcome;
  /** Why the graft needs an agent, was skipped, or errored. */
  reasons: string[];
  variant?: ResolvedVariant | null;
  anchors?: AnchorReport;
  apply?: ApplyResult;
  oracle?: OracleResult;
  /** Scoped upstream diff (from → to) written for the agent path. */
  diffPath?: string;
  /** True when graft.md was updated (verified bumped / status set to applied). */
  updated?: boolean;
}

export interface SyncTarget {
  package: string;
  version: string;
  installedBefore?: string;
  installCommand?: string;
}

export interface SyncReport {
  generatedAt: string;
  root: string;
  targets: SyncTarget[];
  grafts: SyncGraftResult[];
  /** 0 all green, 1 one or more grafts need agent attention, 2 tooling error. */
  exitCode: 0 | 1 | 2;
  /** Paths of the written JSON and markdown reports. */
  reportFiles?: { json: string; markdown: string };
}

export interface SyncOptions {
  /** Target upstream version (default: installed version). Requires a single package. */
  version?: string;
  /** Restrict to grafts on this upstream package. */
  package?: string;
  /** Restrict to these graft ids. */
  ids?: string[];
  /** Install the target version when it differs from the installed one. */
  install?: boolean;
  /** Do not modify graft.md files on green. */
  dryRun?: boolean;
  /** Write `.grafts/.report/sync.{json,md}` (default true). */
  writeReport?: boolean;
  onOutput?: (chunk: string) => void;
  onProgress?: (message: string) => void;
}

/**
 * The cheap path: deterministic re-verification of every graft against an upstream version.
 * Grafts whose anchors, apply step, or oracle fail are marked `needs-agent` with full context.
 */
export async function sync(project: Project, options: SyncOptions = {}): Promise<SyncReport> {
  const log = options.onProgress ?? (() => {});
  const { grafts, invalid } = await project.loadAll();
  const results: SyncGraftResult[] = invalid.map((g) => ({
    id: g.id,
    package: '?',
    from: '?',
    outcome: 'error' as const,
    reasons: g.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
  }));

  let selected = grafts.filter(
    (g) =>
      (!options.ids?.length || options.ids.includes(g.id)) &&
      (!options.package || g.frontmatter.rootstock.package === options.package),
  );
  if (options.ids?.length) {
    for (const id of options.ids) {
      if (!grafts.some((g) => g.id === id) && !invalid.some((g) => g.id === id)) {
        throw new GraftError(`no graft "${id}"`, 'graft/not-found');
      }
    }
  }

  for (const g of selected.filter((g) => !ACTIVE_STATUSES.includes(g.frontmatter.status))) {
    results.push({
      id: g.id,
      package: g.frontmatter.rootstock.package,
      from: g.frontmatter.rootstock.verified,
      outcome: 'skipped',
      reasons: [`status is ${g.frontmatter.status}`],
    });
  }
  selected = selected.filter((g) => ACTIVE_STATUSES.includes(g.frontmatter.status));

  const packages = [...new Set(selected.map((g) => g.frontmatter.rootstock.package))];
  if (options.version && packages.length > 1) {
    throw new GraftError(
      `--version is ambiguous: selected grafts target ${packages.join(', ')}; pass a package filter`,
      'sync/ambiguous-version',
    );
  }

  const targets: SyncTarget[] = [];
  for (const pkg of packages) {
    const pkgGrafts = selected.filter((g) => g.frontmatter.rootstock.package === pkg);
    const installedBefore = await project.installedVersion(pkg);
    const version = options.version ?? installedBefore;
    const base = (g: Graft): SyncGraftResult => ({
      id: g.id,
      package: pkg,
      from: g.frontmatter.rootstock.verified,
      to: version,
      outcome: 'green',
      reasons: [],
    });
    if (!version) {
      for (const g of pkgGrafts) results.push({ ...base(g), outcome: 'error', reasons: [`${pkg} is not installed and no --version was given`] });
      continue;
    }
    const target: SyncTarget = { package: pkg, version, installedBefore };
    targets.push(target);

    // Phase 1: static checks (variant, anchors, apply) against the fetched target version.
    // These run before anything is installed, so a broken graft never breaks the install.
    const staged: { graft: Graft; result: SyncGraftResult }[] = [];
    for (const graft of pkgGrafts) {
      log(`checking ${graft.id} against ${pkg}@${version}`);
      let result: SyncGraftResult;
      try {
        result = await staticCheck(project, graft, version);
      } catch (err) {
        result = { ...base(graft), outcome: 'error', reasons: [(err as Error).message] };
      }
      staged.push({ graft, result });
    }
    const ready = staged.filter((s) => s.result.outcome === 'green');

    // Phase 2: install the target version if needed.
    let installError: string | undefined;
    if (installedBefore !== version && ready.length) {
      if (ready.length !== staged.length) {
        for (const s of ready) {
          s.result.outcome = 'skipped';
          s.result.reasons.push(`oracle not run: ${pkg}@${version} was not installed because other grafts on ${pkg} need attention first`);
        }
      } else if (!options.install) {
        installError = `${pkg}@${version} is not installed (installed: ${installedBefore ?? 'none'}); the oracle must run against the target version — rerun with --install`;
      } else {
        try {
          for (const s of ready) await project.adapterFor(s.graft).beforeInstall?.(project.context(s.graft), version);
          log(`installing ${pkg}@${version}`);
          target.installCommand = await installPackage(project.root, pkg, project.upstream.installSpec(pkg, version));
          const now = await project.installedVersion(pkg);
          if (now !== version) installError = `installed ${pkg} but found version ${now ?? 'none'}, expected ${version}`;
        } catch (err) {
          installError = (err as Error).message;
        }
      }
    }
    if (installError) {
      for (const s of ready) {
        s.result.outcome = 'error';
        s.result.reasons.push(installError);
      }
    }

    // Phase 3: the oracle, the only proof that a graft still holds.
    for (const s of ready.filter((s) => s.result.outcome === 'green')) {
      log(`running oracle for ${s.graft.id}`);
      try {
        await finish(project, s.graft, s.result, options);
      } catch (err) {
        s.result.outcome = 'error';
        s.result.reasons.push((err as Error).message);
      }
    }
    results.push(...staged.map((s) => s.result));
  }

  const order = new Map([...grafts, ...invalid].map((g, i) => [g.id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const exitCode: SyncReport['exitCode'] = results.some((r) => r.outcome === 'error')
    ? 2
    : results.some((r) => r.outcome === 'needs-agent')
      ? 1
      : 0;
  const report: SyncReport = { generatedAt: new Date().toISOString(), root: project.root, targets, grafts: results, exitCode };
  if (options.writeReport !== false) report.reportFiles = await writeSyncReport(project, report);
  return report;
}

async function staticCheck(project: Project, graft: Graft, version: string): Promise<SyncGraftResult> {
  const adapter = project.adapterFor(graft);
  const ctx = project.context(graft);
  const fm = graft.frontmatter;
  const result: SyncGraftResult = {
    id: graft.id,
    package: fm.rootstock.package,
    from: fm.rootstock.verified,
    to: version,
    outcome: 'green',
    reasons: [],
  };

  result.variant = project.selectVariant(graft, version);
  if (!result.variant) result.reasons.push(`no variant covers ${fm.rootstock.package}@${version}`);

  if (result.variant) {
    result.anchors = await adapter.checkAnchors(ctx, version);
    if (!result.anchors.ok) result.reasons.push(`anchors: ${summarizeMisses(result.anchors)}`);
  }

  if (result.variant && result.anchors?.ok) {
    result.apply = await adapter.apply(ctx, { version, outDir: path.join(project.reportDir, graft.id, 'applied') });
    if (!result.apply.ok) {
      result.reasons.push(
        `apply: ${[...result.apply.errors, ...result.apply.files.filter((f) => f.error).map((f) => `${f.file}: ${f.error}`)].join('; ')}`,
      );
    }
  }

  if (result.reasons.length) await markNeedsAgent(project, graft, result);
  return result;
}

async function markNeedsAgent(project: Project, graft: Graft, result: SyncGraftResult): Promise<void> {
  result.outcome = 'needs-agent';
  const fm = graft.frontmatter;
  if (!result.to || fm.rootstock.verified === result.to) return;
  try {
    const diff = await project.adapterFor(graft).scopeDiff(project.context(graft), fm.rootstock.verified, result.to);
    const dir = path.join(project.reportDir, graft.id);
    await mkdir(dir, { recursive: true });
    result.diffPath = path.join(dir, 'diff.patch');
    await writeFile(result.diffPath, diff.patch || '# no differences in target files\n');
    await writeFile(path.join(dir, 'diff.json'), JSON.stringify(diff, null, 2));
  } catch (err) {
    result.reasons.push(`scoped diff unavailable: ${(err as Error).message}`);
  }
}

async function finish(project: Project, graft: Graft, result: SyncGraftResult, options: SyncOptions): Promise<void> {
  const fm = graft.frontmatter;
  const version = result.to!;
  result.oracle = await runOracle(project, graft, { version, onOutput: options.onOutput });
  if (!result.oracle.passed) {
    const failed = result.oracle.modes.filter((m) => !m.passed).map((m) => m.mode);
    result.reasons.push(`oracle failed in mode(s): ${failed.join(', ') || '(no modes)'}`);
    await markNeedsAgent(project, graft, result);
    return;
  }
  if (!options.dryRun && (fm.rootstock.verified !== version || fm.status !== 'applied')) {
    await updateGraft(project, graft.id, {
      verified: version,
      status: 'applied',
      history:
        fm.rootstock.verified !== version
          ? `Verified against ${fm.rootstock.package}@${version} by \`graft sync\` (cheap path, variant ${result.variant!.module} unchanged).`
          : `Re-verified against ${fm.rootstock.package}@${version}; status set to applied.`,
    });
    result.updated = true;
  }
}

async function writeSyncReport(project: Project, report: SyncReport): Promise<{ json: string; markdown: string }> {
  await mkdir(project.reportDir, { recursive: true });
  const json = path.join(project.reportDir, 'sync.json');
  const markdown = path.join(project.reportDir, 'sync.md');
  await writeFile(json, JSON.stringify(report, null, 2));
  await writeFile(markdown, renderSyncMarkdown(report, project.root));
  return { json, markdown };
}

const ICON: Record<SyncOutcome, string> = { green: '✅', 'needs-agent': '🛠️', skipped: '⏭️', error: '❌' };

export function renderSyncMarkdown(report: SyncReport, root: string = report.root): string {
  const rel = (p: string) => path.relative(root, p) || '.';
  const lines: string[] = ['# Graft sync report', '', `Generated ${report.generatedAt}. Exit code **${report.exitCode}**.`, ''];
  if (report.targets.length) {
    lines.push('| Package | Target | Installed before |', '|---|---|---|');
    for (const t of report.targets) lines.push(`| ${t.package} | ${t.version} | ${t.installedBefore ?? '—'} |`);
    lines.push('');
  }
  lines.push('| Graft | Package | Verified → Target | Outcome |', '|---|---|---|---|');
  for (const g of report.grafts) lines.push(`| ${g.id} | ${g.package} | ${g.from} → ${g.to ?? '?'} | ${ICON[g.outcome]} ${g.outcome} |`);
  lines.push('');
  for (const g of report.grafts.filter((g) => g.outcome === 'needs-agent' || g.outcome === 'error')) {
    lines.push(`## ${g.id} — ${g.outcome}`, '');
    for (const r of g.reasons) lines.push(`- ${r}`);
    lines.push('');
    if (g.variant) lines.push(`Selected variant: \`${g.variant.module}\` (\`${g.variant.range}\`)`, '');
    const missed = g.anchors?.anchors.filter((a) => !a.matched) ?? [];
    if (missed.length) {
      lines.push('Missed anchors:', '');
      for (const a of missed) lines.push(`- \`${a.name}\` in \`${a.file}\`${a.description ? ` — ${a.description}` : ''}${a.error ? ` (${a.error})` : ''}`);
      lines.push('');
    }
    for (const m of g.oracle?.modes.filter((m) => !m.passed) ?? []) {
      lines.push(`Oracle output (${m.mode}, exit ${m.exitCode}):`, '', '```', m.output.trim().slice(-4000), '```', '');
    }
    if (g.diffPath) lines.push(`Scoped upstream diff: \`${rel(g.diffPath)}\``, '');
    if (g.outcome === 'needs-agent') {
      lines.push(
        `Next: follow the graft sync skill — read \`.grafts/${g.id}/graft.md\`, write a new variant for ${g.package}@${g.to}, and verify with the oracle.`,
        '',
      );
    }
  }
  return lines.join('\n');
}
