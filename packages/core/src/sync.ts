import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ACTIVE_STATUSES } from '@graftsync/spec';
import { GraftError } from './errors.js';
import { runCommand } from './command.js';
import { checkUpgradeNeedsAgent, resolveUpgrade, runUpgrade } from './install.js';
import { recordVariant, summarizeMisses, updateGraft } from './operations.js';
import type { Project } from './project.js';
import { snapshotInstallConfig, type WorkspaceSnapshot } from './snapshot.js';
import type { AgentStart, AnchorReport, ApplyResult, FetchableRef, Graft, GraftUpdate, ResolvedVariant } from './types.js';
import { npmResolveFrom } from './upstream.js';

export type SyncOutcome = 'green' | 'needs-agent' | 'skipped' | 'error';

export interface SyncGraftResult {
  id: string;
  package: string;
  /** The rootstock's ecosystem (`npm`, `cargo`, `go`, `pypi`). */
  ecosystem?: string;
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
  /** For a standalone graft: the materialized result (e.g. the rebased fork) and how to fetch it. */
  materialized?: { description?: string; fetch?: FetchableRef };
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
   * removed again because it did not hold (static checks or install).
   */
  regenerated?: { module: string; command: string; rolledBack?: boolean };
  /** Where the agent can start (from the mechanism's `prepareAgent`, e.g. a branch with conflict markers). */
  agentStart?: AgentStart;
  /** True when the verification was recorded in the materialized result, not in graft.md (see `recordsInResult`). */
  recordedInResult?: boolean;
}

export interface SyncTarget {
  package: string;
  ecosystem?: string;
  version: string;
  installedBefore?: string;
  installCommand?: string;
  /** Packages released together with this one (same repository and version), installed at `version` with it. */
  siblings?: string[];
  /** The last lines of the project's `upgrade` command's output, when one ran (§6). */
  installOutput?: string;
  /** True for a standalone graft's target: nothing is installed; the result is materialized instead. */
  standalone?: boolean;
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
  /** Restrict to grafts whose rootstock is in this ecosystem (`npm`, `cargo`, `go`, `pypi`). */
  ecosystem?: string;
  /** Restrict to these graft ids. */
  ids?: string[];
  /** Install the target version when it differs from the installed one. */
  install?: boolean;
  /** Do not modify graft.md files on green. */
  dryRun?: boolean;
  /** Write `.grafts/.report/sync.{json,md}` (default true). */
  writeReport?: boolean;
  /** Output of the commands sync runs on the project's behalf: generators and `upgrade` commands. */
  onOutput?: (chunk: string) => void;
  onProgress?: (message: string) => void;
}

/**
 * The cheap path: deterministic re-verification of every graft against an upstream version.
 * Grafts whose anchors or apply step fail are marked `needs-agent` with full context. Sync checks
 * that a graft still fits and installs; verifying behavior is the agent's job (see the skill).
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
      (!options.package || g.frontmatter.rootstock.package === options.package) &&
      (!options.ecosystem || g.frontmatter.rootstock.ecosystem === options.ecosystem),
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
      ecosystem: g.frontmatter.rootstock.ecosystem,
      from: g.frontmatter.rootstock.verified,
      outcome: 'skipped',
      reasons: [`status is ${g.frontmatter.status}`],
    });
  }
  selected = selected.filter((g) => ACTIVE_STATUSES.includes(g.frontmatter.status));

  const packages = [...new Set(selected.map((g) => packageLabel(g)))];
  if (options.version && packages.length > 1) {
    throw new GraftError(
      `--version is ambiguous: selected grafts target ${packages.join(', ')}; pass a package (and ecosystem) filter`,
      'sync/ambiguous-version',
    );
  }

  // Grafts on the same installed package sync together (one install). A standalone graft
  // installs nothing, so it is its own group, and defaults to re-verifying its verified version.
  const groups = new Map<string, Graft[]>();
  for (const g of selected) {
    const key = project.isStandalone(g) ? `\0${g.id}` : `${g.frontmatter.rootstock.ecosystem}\0${g.frontmatter.rootstock.package}`;
    groups.set(key, [...(groups.get(key) ?? []), g]);
  }

  const targets: SyncTarget[] = [];
  for (const pkgGrafts of groups.values()) {
    const pkg = pkgGrafts[0]!.frontmatter.rootstock.package;
    const ecosystem = pkgGrafts[0]!.frontmatter.rootstock.ecosystem;
    const standalone = project.isStandalone(pkgGrafts[0]!);
    const installedBefore = standalone ? undefined : await project.installedVersion(pkg, ecosystem);
    const eco = project.ecosystemFor(ecosystem);
    const requested = options.version && eco.normalizeVersion ? eco.normalizeVersion(options.version) : options.version;
    const version = requested ?? (standalone ? pkgGrafts[0]!.frontmatter.rootstock.verified : installedBefore);
    const base = (g: Graft): SyncGraftResult => ({
      id: g.id,
      package: pkg,
      ecosystem,
      from: g.frontmatter.rootstock.verified,
      to: version,
      outcome: 'green',
      reasons: [],
    });
    if (!version) {
      for (const g of pkgGrafts)
        results.push({ ...base(g), outcome: 'error', reasons: [`${pkg} is not installed and no --version was given`] });
      continue;
    }
    if (!project.schemeFor(ecosystem).valid(version)) {
      for (const g of pkgGrafts)
        results.push({ ...base(g), outcome: 'error', reasons: [`"${version}" is not a valid ${ecosystem} version`] });
      continue;
    }
    const target: SyncTarget = { package: pkg, ecosystem, version, installedBefore, ...(standalone ? { standalone: true } : {}) };
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
    let installSnapshot: WorkspaceSnapshot | undefined;
    let workspaceRolledBack = false;
    if (!standalone && installedBefore !== version && ready.length) {
      if (ready.length !== staged.length) {
        for (const s of ready) {
          s.result.outcome = 'skipped';
          s.result.reasons.push(`not recorded: ${pkg}@${version} was not installed because other grafts on ${pkg} need attention first`);
        }
      } else if (!options.install && options.dryRun) {
        // A dry run without an install checks only what can be checked against the pristine
        // target (variant, anchors, apply), and records nothing either way.
        for (const s of ready) {
          s.result.reasons.push(
            `static checks only: ${pkg}@${version} is not installed (installed: ${installedBefore ?? 'none'}); add --install to install it`,
          );
        }
      } else if (!options.install) {
        installError = `${pkg}@${version} is not installed (installed: ${installedBefore ?? 'none'}); rerun with --install to install it and record the graft against it (or --dry-run for the static checks only)`;
      } else {
        try {
          // Resolve any custom upgrade command and validate siblings BEFORE beforeInstall mutates
          // package-manager config (e.g. pnpm-workspace.yaml), so pre-install errors never leave
          // the workspace config out of sync with the installed tree (#89).
          const upgrade = resolveUpgrade(project.config, ecosystem, pkg, version);
          // Without an upgrade command, packages released together with this one move with it, or
          // the project ends up with mismatched versions (e.g. `nx` upgraded, `@nx/angular` left behind).
          const siblings = upgrade ? [] : ((await eco.siblings?.(project, pkg)) ?? []);
          if (siblings.length) {
            target.siblings = siblings;
            const upstream = project.upstreamFor(ecosystem);
            const unpublished: string[] = [];
            for (const s of siblings) if (!(await upstream.versions(s)).versions.includes(version)) unpublished.push(s);
            if (unpublished.length) {
              throw new GraftError(
                `${unpublished.join(', ')} ${unpublished.length === 1 ? 'is' : 'are'} released with ${pkg} (same repository, installed at ${installedBefore}) but not published at ${version}; upgrading ${pkg} alone would leave ${unpublished.length === 1 ? 'it' : 'them'} behind`,
                'install/sibling-unpublished',
              );
            }
          }
          // Snapshot manifests, package-manager config, lockfiles, and applier artifacts before
          // any mutation so a failure at any step leaves the workspace config clean.
          installSnapshot = await snapshotInstallConfig(project, ecosystem);
          let bare = false;
          for (const s of ready) {
            const r = await project.adapterFor(s.graft).beforeInstall?.(project.context(s.graft), version);
            if (r && r.install === 'reinstall') bare = true;
          }
          if (upgrade && bare) {
            throw new GraftError(
              `.grafts/config.json sets an upgrade command for ${pkg}, but its graft installs ${pkg} from a vendored build (fork package mode); remove the upgrade command`,
              'config/upgrade-unsupported',
            );
          }
          let upgradeOutput = '';
          if (upgrade) {
            log(`upgrading ${pkg} to ${version} (up to ${upgrade.timeoutMinutes} min): ${upgrade.command}`);
            // Keep the end of the output in the report: the command may have left work for an agent
            // (nx's agentic mode run from inside one prints a runbook and exits 0).
            const capture = (chunk: string) => {
              upgradeOutput = (upgradeOutput + chunk).slice(-64_000);
              options.onOutput?.(chunk);
            };
            try {
              target.installCommand = await runUpgrade(project.root, upgrade.command, upgrade.timeoutMinutes, capture);
            } finally {
              target.installOutput = outputTail(upgradeOutput);
            }
          } else {
            log(`installing ${pkg}@${version}${siblings.length ? ` with ${siblings.join(', ')}` : ''}`);
            const commands: string[] = [];
            // A bare reinstall (the adapter pins the package itself) still needs the siblings moved first.
            if (bare && siblings.length) commands.push(await eco.install(project, siblings[0]!, version, siblings.slice(1)));
            commands.push(bare ? await eco.reinstall(project) : await eco.install(project, pkg, version, siblings));
            target.installCommand = commands.join(' && ');
          }
          const now = await project.installedVersion(pkg, ecosystem);
          const siblingFrom = ecosystem === 'npm' ? npmResolveFrom(project.config, project.root)[pkg] : undefined;
          const behind: string[] = [];
          for (const s of siblings) {
            const v = await project.installedVersion(s, ecosystem, siblingFrom ? { from: siblingFrom } : undefined);
            if (v !== version) behind.push(`${s}@${v ?? 'none'}`);
          }
          if (now !== version) installError = `installed ${pkg} but found version ${now ?? 'none'}, expected ${version}`;
          else if (behind.length)
            installError = `installed ${pkg}@${version} but its siblings are at ${behind.join(', ')}, expected ${version}`;
          else {
            for (const s of ready) await project.adapterFor(s.graft).afterInstall?.(project.context(s.graft), version);
            if (upgrade?.needsAgentIf) {
              const check = await checkUpgradeNeedsAgent(project.root, upgrade.needsAgentIf, upgradeOutput);
              if (check.matched) {
                const detail = check.reasons.join('; ');
                for (const s of ready) {
                  s.result.outcome = 'needs-agent';
                  s.result.reasons.push(
                    `upgrade command \`${upgrade.command}\` left unfinished work for an agent (${detail}); finish the remaining steps before recording the graft`,
                  );
                  s.result.agentStart = {
                    description: `upgrade command \`${upgrade.command}\` installed ${pkg}@${version} but left work unfinished (${detail})`,
                    next: `finish the remaining steps left by \`${upgrade.command}\` (see its output above), verify the project's tests, and rerun \`graft sync\` to record the graft.`,
                  };
                }
              }
            }
          }
        } catch (err) {
          installError = (err as Error).message;
        }
      }
    } else if (!standalone && installedBefore === version && ready.length && ready.some((s) => s.result.regenerated) && options.install) {
      // A generator produced a new variant for the already-installed version: wire the package
      // manager to it and reinstall so the installed tree uses the new variant.
      try {
        installSnapshot = await snapshotInstallConfig(project, ecosystem);
        for (const s of ready) await project.adapterFor(s.graft).beforeInstall?.(project.context(s.graft), version);
        target.installCommand = await eco.reinstall(project);
        for (const s of ready) await project.adapterFor(s.graft).afterInstall?.(project.context(s.graft), version);
      } catch (err) {
        installError = (err as Error).message;
      }
    }
    if (installError) {
      if (installSnapshot) {
        try {
          const restored = await installSnapshot.restore();
          workspaceRolledBack = true;
          if (restored.length) log(`rolled back ${restored.length} modified file(s) after install failure`);
        } catch (err) {
          installError += `; rollback failed: ${(err as Error).message}`;
        }
      }
      for (const s of ready) {
        s.result.outcome = 'error';
        s.result.reasons.push(installError);
      }
    }

    // Verify that the installed configuration and files actually apply the selected variant when
    // verifying the already-installed version (skipped on dry-run regeneration, which doesn't install).
    const checkInstalledNow = !standalone && !installError && installedBefore === version;
    if (checkInstalledNow) {
      for (const s of ready.filter((s) => s.result.outcome === 'green')) {
        if (s.result.regenerated && options.dryRun) continue;
        const adapter = project.adapterFor(s.graft);
        if (!adapter.checkInstalled) continue;
        const installed = await adapter.checkInstalled(project.context(s.graft), version);
        if (installed.warnings?.length && s.result.anchors) {
          (s.result.anchors.warnings ??= []).push(...installed.warnings);
        }
        if (installed.errors.length) {
          if (s.result.anchors) {
            s.result.anchors.errors.push(...installed.errors);
            s.result.anchors.ok = false;
          }
          s.result.reasons.push(`anchors: ${installed.errors.join('; ')}`);
          s.result.outcome = 'needs-agent';
          await markNeedsAgent(project, s.graft, s.result);
        }
      }
    }

    // Phase 3: record the result (and, for standalone grafts, materialize it).
    for (const s of ready.filter((s) => s.result.outcome === 'green')) {
      try {
        await finish(project, s.graft, s.result, options);
      } catch (err) {
        s.result.outcome = 'error';
        s.result.reasons.push((err as Error).message);
      }
    }

    // A regenerated variant that did not end green is never left registered.
    for (const s of staged.filter((s) => s.rollback && s.result.outcome !== 'green')) {
      s.result.reasons.push(await s.rollback!(target.installCommand !== undefined && !workspaceRolledBack));
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
    ecosystem: fm.rootstock.ecosystem,
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

/**
 * Exit code with which a generator says upstream already does what the graft did (e.g. the
 * package now ships the modification itself), so no variant is needed. Sync then reports the
 * graft as likely upstreamed. Also exported to generators as GRAFT_EXIT_UPSTREAMED.
 */
export const GENERATOR_EXIT_UPSTREAMED = 3;

/** Terminal escape sequences (colors, cursor movement), to strip from captured output. */
const TERMINAL_ESCAPES = new RegExp(String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]`, 'g');

/** The last 80 lines (at most 8,000 characters) of a command's output, without terminal escapes. */
export function outputTail(output: string): string | undefined {
  const plain = output
    .replace(TERMINAL_ESCAPES, '')
    .replace(/\r(?!\n)/g, '\n')
    .trimEnd();
  if (!plain) return undefined;
  return plain.split('\n').slice(-80).join('\n').slice(-8_000);
}

/**
 * The part of a failed command's output worth one line in a report: the last error message
 * (e.g. `Error: …`), not the stack trace under it; otherwise the last lines that aren't stack.
 */
export function errorSummary(output: string): string {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const noise = (l: string) =>
    /^at\s/.test(l) || /^Node\.js v\d/.test(l) || /^\^+$/.test(l) || /^throw\b/.test(l) || /^file:\/\/.*:\d+$/.test(l);
  const errors = lines.filter((l) => /(^|\b)([A-Z]\w*Error|Error|error)(\s*\[[^\]]*\])?:\s/.test(l));
  if (errors.length)
    return errors
      .at(-1)!
      .replace(/^.*?\b((?:[A-Z]\w*)?Error(\s*\[[^\]]*\])?:\s)/, '$1')
      .slice(0, 500);
  return lines
    .filter((l) => !noise(l))
    .slice(-3)
    .join(' / ')
    .slice(0, 500);
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
      GRAFT_EXIT_UPSTREAMED: String(GENERATOR_EXIT_UPSTREAMED),
    },
    timeoutMs: (generator.timeout ?? 600) * 1000,
    onOutput: options.onOutput,
  });
  if (!run.timedOut && run.exitCode === GENERATOR_EXIT_UPSTREAMED) {
    // Not a failure: upstream already does what the graft did. A human confirms and retires it.
    if (!options.dryRun) await rm(out, { force: true });
    const said = errorSummary(run.output);
    failed.likelyUpstreamed = true;
    failed.reasons.unshift(
      `upstream ${pkg}@${version} already does what this graft did, says its generator \`${command}\`${said ? ` (${said})` : ''}; confirm and set status: upstreamed`,
    );
    return { ok: false };
  }
  if (!run.passed) {
    const summary = errorSummary(run.output);
    return fail(`failed (${run.timedOut ? 'timed out' : `exit ${run.exitCode}`})${summary ? `: ${summary}` : ''}`);
  }
  if (!existsSync(out)) return fail(`exited 0 but did not write ${module}`);

  const range = project.schemeFor(graft).from(version);
  const original = await readFile(graft.file, 'utf8');
  const restore = () => writeFile(graft.file, original);
  let candidate: Graft;
  let rollback: Rollback | undefined;
  if (options.dryRun) {
    candidate = { ...graft, frontmatter: { ...graft.frontmatter, variants: [{ range, module }] } };
  } else {
    try {
      candidate = (
        await recordVariant(
          project,
          graft.id,
          { range, module },
          {
            verifyVersion: version,
            note: `Regenerated by \`${command}\` for ${pkg}@${version}.`,
          },
        )
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
  const prepare = project.adapterFor(graft).prepareAgent;
  if (result.to && prepare && !result.agentStart) {
    try {
      result.agentStart = await prepare(project.context(graft), result.to);
    } catch (err) {
      result.reasons.push(`no starting point for the agent: ${(err as Error).message}`);
    }
  }
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
  const adapter = project.adapterFor(graft);
  const ctx = project.context(graft);
  // A standalone graft's result is the upstream with the graft applied (e.g. the fork rebased onto
  // the target): materialize it for the user (or the Action) to take.
  if (project.isStandalone(graft) && adapter.workspace) {
    try {
      const ws = await adapter.workspace(ctx, version);
      result.materialized = { description: ws.result, fetch: ws.fetch };
      await ws.dispose();
    } catch (err) {
      if (
        err instanceof GraftError &&
        (err.code === 'fork/partial-clone' ||
          err.code === 'fork/git' ||
          err.code === 'fork/config' ||
          err.code === 'fork/ecosystem' ||
          err.code === 'config/invalid' ||
          err.code === 'upstream/fetch')
      ) {
        throw err;
      }
      result.reasons.push(`could not materialize ${fm.rootstock.package}@${version} with the graft applied: ${(err as Error).message}`);
      await markNeedsAgent(project, graft, result);
      return;
    }
  }
  if (options.dryRun) return;
  let update: GraftUpdate | undefined;
  if (fm.rootstock.verified !== version || fm.status !== 'applied') {
    update = {
      verified: version,
      status: 'applied',
      history:
        fm.rootstock.verified !== version
          ? result.regenerated
            ? `Verified against ${fm.rootstock.package}@${version} by \`graft sync\` with regenerated variant ${result.regenerated.module}.`
            : `Verified against ${fm.rootstock.package}@${version} by \`graft sync\` (cheap path, variant ${result.variant!.module} unchanged).`
          : `Re-verified against ${fm.rootstock.package}@${version}; status set to applied.`,
    };
  }
  const inResult = (await adapter.recordsInResult?.(ctx, version)) ?? false;
  if (update && !inResult) {
    await updateGraft(project, graft.id, update);
    result.updated = true;
  }
  if (inResult) result.recordedInResult = true;
  await adapter.afterVerified?.(project.context(inResult ? graft : await project.get(graft.id)), version, inResult ? update : undefined);
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
    for (const t of report.targets)
      lines.push(`| ${t.package} | ${t.version} | ${t.standalone ? 'n/a (standalone)' : (t.installedBefore ?? '—')} |`);
    lines.push('');
    for (const t of report.targets.filter((t) => t.siblings?.length))
      lines.push(`Released with ${t.package}, so moved with it: ${t.siblings!.map((n) => `\`${n}\``).join(', ')}.`, '');
    for (const t of report.targets.filter((t) => t.installOutput))
      lines.push(
        `### Output of \`${t.installCommand ?? 'the upgrade command'}\` (last lines)`,
        '',
        'Read it: a tool may have left work for an agent here (e.g. migrations to apply).',
        '',
        '````text',
        t.installOutput!,
        '````',
        '',
      );
  }
  lines.push('| Graft | Package | Verified → Target | Outcome |', '|---|---|---|---|');
  for (const g of report.grafts) {
    const regen = g.regenerated ? (g.regenerated.rolledBack ? ' (regeneration rolled back)' : ' (variant regenerated)') : '';
    lines.push(
      `| ${g.id} | ${g.package} | ${g.from} → ${g.to ?? '?'} | ${ICON[g.outcome]} ${g.outcome}${g.likelyUpstreamed ? ' (likely upstreamed)' : ''}${regen} |`,
    );
  }
  lines.push('');
  const results = report.grafts.filter((g) => g.outcome === 'green' && g.materialized?.description);
  if (results.length) {
    lines.push('Materialized results (Graft never pushes; take them from here):', '');
    for (const g of results) lines.push(`- ${g.id} @ ${g.to}: ${g.materialized!.description}`);
    lines.push('');
  }
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
      for (const a of missed)
        lines.push(`- \`${a.name}\` in \`${a.file}\`${a.description ? ` — ${a.description}` : ''}${a.error ? ` (${a.error})` : ''}`);
      lines.push('');
    }
    if (g.diffPath) lines.push(`Scoped upstream diff: \`${rel(g.diffPath)}\``, '');
    if (g.agentStart) lines.push(`Start from: ${g.agentStart.description}`, '');
    if (g.outcome === 'needs-agent' && g.likelyUpstreamed) {
      lines.push(
        `Next: upstream ${g.package}@${g.to} appears to already contain this graft's change. Confirm it (the Invariants hold on pristine upstream: run the project's tests without the graft), then run \`graft mark ${g.id} --status upstreamed --history "…"\` to set \`.grafts/${g.id}/graft.md\` to \`upstreamed\` with a History entry. Do not write a new variant.`,
        '',
      );
    } else if (g.outcome === 'needs-agent' && g.agentStart?.next) {
      lines.push(`Next: ${g.agentStart.next}`, '');
    } else if (g.outcome === 'needs-agent') {
      lines.push(
        `Next: follow the graft sync skill — read \`.grafts/${g.id}/graft.md\`, write a new variant for ${g.package}@${g.to}, and verify the Invariants with the project's tests.`,
        '',
      );
    }
  }
  return lines.join('\n');
}

/** A package as reports name it: `pkg`, or `ecosystem:pkg` outside npm. */
function packageLabel(g: Graft): string {
  const { ecosystem, package: pkg } = g.frontmatter.rootstock;
  return ecosystem === 'npm' ? pkg : `${ecosystem}:${pkg}`;
}
