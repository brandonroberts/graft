import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { ACTIVE_STATUSES } from '@graftsync/spec';
import { GraftError } from './errors.js';
import { installPackage, reinstall } from './install.js';
import { runCommand, runOracle, type OracleResult } from './oracle.js';
import { recordVariant, summarizeMisses, updateGraft } from './operations.js';
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
  /**
   * True when the target version already contains this graft's change (see
   * `AnchorReport.upstreamed`). The outcome stays `needs-agent`: a human confirms and sets
   * `status: upstreamed`.
   */
  likelyUpstreamed?: boolean;
  /**
   * Set when the graft's `generator` wrote a new variant for the target version. `module` is
   * relative to the graft directory. `rolledBack` is true when the regenerated variant was
   * removed again because it did not hold (static checks, install, or oracle).
   */
  regenerated?: { module: string; command: string; rolledBack?: boolean };
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
    // A graft with a `generator` that fails them gets a regenerated variant first.
    const staged: { graft: Graft; result: SyncGraftResult; rollback?: Rollback }[] = [];
    for (const graft of pkgGrafts) {
      log(`checking ${graft.id} against ${pkg}@${version}`);
      let entry: (typeof staged)[number];
      try {
        const generator = !!graft.frontmatter.generator;
        const result = await staticCheck(project, graft, version, !generator);
        entry = { graft, result };
        if (generator && result.outcome === 'needs-agent') {
          const regen = await tryRegenerate(project, graft, version, result, options);
          if (regen.ok) entry = regen;
          else await markNeedsAgent(project, graft, result);
        }
      } catch (err) {
        entry = { graft, result: { ...base(graft), outcome: 'error', reasons: [(err as Error).message] } };
      }
      staged.push(entry);
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
          let bare = false;
          for (const s of ready) {
            const r = await project.adapterFor(s.graft).beforeInstall?.(project.context(s.graft), version);
            if (r && r.install === 'reinstall') bare = true;
          }
          log(`installing ${pkg}@${version}`);
          target.installCommand = bare ? await reinstall(project.root) : await installPackage(project.root, pkg, project.upstream.installSpec(pkg, version));
          const now = await project.installedVersion(pkg);
          if (now !== version) installError = `installed ${pkg} but found version ${now ?? 'none'}, expected ${version}`;
          else for (const s of ready) await project.adapterFor(s.graft).afterInstall?.(project.context(s.graft), version);
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

    // A regenerated variant that the oracle did not prove is never left registered.
    for (const s of staged.filter((s) => s.rollback && s.result.outcome !== 'green')) {
      s.result.reasons.push(await s.rollback!(target.installCommand !== undefined));
      if (s.result.regenerated) s.result.regenerated.rolledBack = true;
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

async function staticCheck(project: Project, graft: Graft, version: string, mark = true): Promise<SyncGraftResult> {
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
    if (result.anchors.upstreamed) {
      result.likelyUpstreamed = true;
      result.reasons.unshift(
        `upstream ${fm.rootstock.package}@${version} already contains this graft's change; confirm and set status: upstreamed (${result.anchors.upstreamed.evidence.join('; ')})`,
      );
    }
  }

  if (result.variant && result.anchors?.ok) {
    result.apply = await adapter.apply(ctx, { version, outDir: path.join(project.reportDir, graft.id, 'applied') });
    if (!result.apply.ok) {
      result.reasons.push(
        `apply: ${[...result.apply.errors, ...result.apply.files.filter((f) => f.error).map((f) => `${f.file}: ${f.error}`)].join('; ')}`,
      );
    }
  }

  if (result.reasons.length) {
    result.outcome = 'needs-agent';
    if (mark) await markNeedsAgent(project, graft, result);
  }
  return result;
}

/** Undo a registered regenerated variant. Returns a sentence for the sync report. */
type Rollback = (installed: boolean) => Promise<string>;

const shellArg = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/**
 * Run the graft's `generator` to write a variant for `version`, register it (unless dry-run),
 * and re-run the static checks with it. On any failure everything is undone and `failed`
 * gets a reason explaining what the generator did; the caller then hands off to an agent.
 */
async function tryRegenerate(
  project: Project,
  graft: Graft,
  version: string,
  failed: SyncGraftResult,
  options: SyncOptions,
): Promise<{ ok: true; graft: Graft; result: SyncGraftResult; rollback?: Rollback } | { ok: false }> {
  const generator = graft.frontmatter.generator!;
  const pkg = graft.frontmatter.rootstock.package;
  const log = options.onProgress ?? (() => {});
  const name = `v${version}${project.adapterFor(graft).variantExtension ?? '.ts'}`;
  const keptDir = path.join(project.reportDir, graft.id, 'regenerated');
  let out = path.join(options.dryRun ? keptDir : path.join(graft.dir, 'variants'), name);
  for (let n = 2; !options.dryRun && existsSync(out); n++) out = path.join(graft.dir, 'variants', name.replace(/(\.[^.]+)?$/, `-${n}$1`));
  const rel = path.relative(graft.dir, out).split(path.sep).join('/');
  const module = rel.startsWith('../') ? rel : `./${rel}`;
  const command = generator.command
    .replaceAll('{version}', version)
    .replaceAll('{out}', shellArg(path.relative(project.root, out).split(path.sep).join('/')));
  const fail = async (why: string, keep = false) => {
    let kept = '';
    if (keep && existsSync(out) && !options.dryRun) {
      await mkdir(keptDir, { recursive: true });
      await copyFile(out, path.join(keptDir, path.basename(out)));
      kept = ` (kept for review at ${path.relative(project.root, path.join(keptDir, path.basename(out)))})`;
    }
    if (!options.dryRun) await rm(out, { force: true });
    failed.reasons.push(`generator \`${command}\` ${why}${kept}`);
    return { ok: false as const };
  };

  log(`regenerating ${graft.id} for ${pkg}@${version}`);
  await mkdir(path.dirname(out), { recursive: true });
  if (options.dryRun) await rm(out, { force: true }); // a stale dry-run output must not count
  const run = await runCommand(command, {
    cwd: project.root,
    env: {
      GRAFT_ID: graft.id,
      GRAFT_DIR: graft.dir,
      GRAFT_PACKAGE: pkg,
      GRAFT_UPSTREAM_VERSION: version,
      GRAFT_VARIANT_OUT: out,
    },
    timeoutMs: (generator.timeout ?? 600) * 1000,
    onOutput: options.onOutput,
  });
  if (!run.passed) {
    const tail = run.output.trim().split('\n').slice(-3).join(' / ');
    return fail(`failed (${run.timedOut ? 'timed out' : `exit ${run.exitCode}`})${tail ? `: ${tail}` : ''}`);
  }
  if (!existsSync(out)) return fail(`exited 0 but did not write ${module}`);

  const prerelease = semver.prerelease(version);
  const range = prerelease ? `>=${semver.major(version)}.${semver.minor(version)}.${semver.patch(version)}-0` : `>=${version}`;
  const original = await readFile(graft.file, 'utf8');
  const restore = () => writeFile(graft.file, original);
  let candidate: Graft;
  let rollback: Rollback | undefined;
  if (options.dryRun) {
    candidate = { ...graft, frontmatter: { ...graft.frontmatter, variants: [{ range, module }] } };
  } else {
    try {
      candidate = (
        await recordVariant(project, graft.id, { range, module }, {
          verifyVersion: version,
          note: `Regenerated by \`${command}\` for ${pkg}@${version}.`,
        })
      ).graft;
    } catch (err) {
      await restore();
      return fail(`wrote ${module}, but it could not be registered: ${(err as Error).message}`, true);
    }
    rollback = async (installed) => {
      await restore();
      const kept = path.join(keptDir, path.basename(out));
      await mkdir(keptDir, { recursive: true });
      await copyFile(out, kept);
      await rm(out, { force: true });
      let note = `regenerated variant ${module} rolled back: graft.md restored, variant moved to ${path.relative(project.root, kept)} for review`;
      if (installed) {
        // The package manager was pointed at the removed file; point it back at the previous variant.
        try {
          const restored = await project.get(graft.id);
          await project.adapterFor(restored).beforeInstall?.(project.context(restored), version);
          note += '; package-manager configuration re-pointed at the previous variant (the installed tree still has the regenerated one)';
        } catch (err) {
          note += `; could not re-point the package manager at a previous variant: ${(err as Error).message}`;
        }
      }
      return note;
    };
  }

  let result: SyncGraftResult;
  try {
    result = await staticCheck(project, candidate, version, false);
  } catch (err) {
    result = { ...failed, outcome: 'error', reasons: [(err as Error).message] };
  }
  if (result.outcome !== 'green') {
    if (!options.dryRun) await restore();
    return fail(`wrote ${module}, but it still fails static checks: ${result.reasons.join('; ')}`, true);
  }
  result.regenerated = { module, command };
  log(`regenerated ${graft.id}: ${module}`);
  return { ok: true, graft: candidate, result, rollback };
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
          ? result.regenerated
            ? `Verified against ${fm.rootstock.package}@${version} by \`graft sync\` with regenerated variant ${result.regenerated.module}.`
            : `Verified against ${fm.rootstock.package}@${version} by \`graft sync\` (cheap path, variant ${result.variant!.module} unchanged).`
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
  for (const g of report.grafts) {
    const regen = g.regenerated ? (g.regenerated.rolledBack ? ' (regeneration rolled back)' : ' (variant regenerated)') : '';
    lines.push(`| ${g.id} | ${g.package} | ${g.from} → ${g.to ?? '?'} | ${ICON[g.outcome]} ${g.outcome}${g.likelyUpstreamed ? ' (likely upstreamed)' : ''}${regen} |`);
  }
  lines.push('');
  const regenerated = report.grafts.filter((g) => g.regenerated && !g.regenerated.rolledBack);
  if (regenerated.length) {
    lines.push('Regenerated variants (review them before merging):', '');
    for (const g of regenerated) lines.push(`- ${g.id}: \`${g.regenerated!.module}\` by \`${g.regenerated!.command}\``);
    lines.push('');
  }
  for (const g of report.grafts.filter((g) => g.outcome === 'needs-agent' || g.outcome === 'error')) {
    lines.push(`## ${g.id} — ${g.outcome}${g.likelyUpstreamed ? ' (likely upstreamed)' : ''}`, '');
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
    if (g.outcome === 'needs-agent' && g.likelyUpstreamed) {
      lines.push(
        `Next: upstream ${g.package}@${g.to} appears to already contain this graft's change. Confirm it (the invariants hold on pristine upstream, e.g. run the oracle without the graft), then run \`graft mark ${g.id} --status upstreamed --history "…"\` to set \`.grafts/${g.id}/graft.md\` to \`upstreamed\` with a History entry. Do not write a new variant.`,
        '',
      );
    } else if (g.outcome === 'needs-agent') {
      lines.push(
        `Next: follow the graft sync skill — read \`.grafts/${g.id}/graft.md\`, write a new variant for ${g.package}@${g.to}, and verify with the oracle.`,
        '',
      );
    }
  }
  return lines.join('\n');
}
