import semver from 'semver';
import { defaultPolicy, getForkPolicy, saveSyncRun } from './storage.js';
import type {
  CommandRunner,
  CommunityForkUpstreamUpdatedEvent,
  ExternalPublisher,
  ForkPolicy,
  GraftSyncJsonReport,
  StorageBucket,
  SyncEventEmitter,
  SyncRunRecord,
} from './types.js';

const KODY_ID_RE = /^@[a-z0-9._-]+\/[a-z0-9._-]+$/i;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const DEFAULT_KODY_ORIGIN = 'https://kody.codes';
const MAX_REPORT_CHARS = 64_000;

export interface SyncDependencies {
  command: CommandRunner;
  storage?: StorageBucket;
  publisher?: ExternalPublisher;
  emitter?: SyncEventEmitter;
  /** Resolve a package UUID to its scoped `@owner/leaf` name when `event.fork.kody_id` is a bare leaf. */
  resolvePackageName?: (packageId: string) => Promise<string | undefined>;
  /** Override policy instead of reading from `storage` (useful for tests or manual runs). */
  policy?: ForkPolicy;
  /** Override the fork's git URL (defaults to `${kodyOrigin}/${fork.kody_id}.git`). */
  forkGitUrl?: string;
  /** Override timestamp generator (for deterministic tests). */
  now?: () => Date;
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[/\\]+$/, '') : p.replace(/^[/\\]+|[/\\]+$/g, '')))
    .filter(Boolean)
    .join('/');
}

function failMessage(label: string, res: { exitCode: number | null; timedOut: boolean; stderr: string; stdout: string }): string {
  const detail = (res.stderr || res.stdout).trim().split('\n').slice(-6).join('\n');
  const status = res.timedOut ? 'timed out' : `exit ${String(res.exitCode)}`;
  return `${label} failed (${status})${detail ? `: ${detail}` : ''}`;
}

async function execOrThrow(
  command: CommandRunner,
  label: string,
  input: { file: string; args: string[]; cwd?: string; timeoutMs?: number },
): Promise<string> {
  const res = await command.run({ timeoutMs: 120_000, ...input });
  if (res.timedOut || res.exitCode !== 0) throw new Error(failMessage(label, res));
  return res.stdout;
}

async function resolveWorkspaceRoot(command: CommandRunner, policy: ForkPolicy): Promise<string> {
  if (policy.workspaceRoot) return policy.workspaceRoot;
  const home = (
    await execOrThrow(command, 'resolve home directory', {
      file: 'node',
      args: ['-p', 'require("node:os").homedir()'],
      timeoutMs: 15_000,
    })
  ).trim();
  if (!home) throw new Error('Could not resolve Execution Context home directory; set workspaceRoot on the fork policy');
  return joinPath(home, '.cache', 'kody-graft');
}

async function ensureDir(command: CommandRunner, dir: string): Promise<void> {
  await execOrThrow(command, `mkdir ${dir}`, {
    file: 'node',
    args: ['-e', 'require("node:fs").mkdirSync(process.argv[1], { recursive: true })', dir],
    timeoutMs: 15_000,
  });
}

async function readTextIfExists(command: CommandRunner, filePath: string): Promise<string | undefined> {
  const res = await command.run({
    file: 'node',
    args: [
      '-e',
      'const fs=require("node:fs"); if (fs.existsSync(process.argv[1])) process.stdout.write(fs.readFileSync(process.argv[1],"utf8").slice(0, Number(process.argv[2])))',
      filePath,
      String(MAX_REPORT_CHARS),
    ],
    timeoutMs: 15_000,
  });
  if (res.timedOut || res.exitCode !== 0 || !res.stdout) return undefined;
  return res.stdout;
}

async function detectDefaultBranch(command: CommandRunner, repoDir: string): Promise<string> {
  const sym = await command.run({
    file: 'git',
    args: ['-C', repoDir, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
    timeoutMs: 15_000,
  });
  if (!sym.timedOut && sym.exitCode === 0) {
    const branch = sym.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    if (branch) return branch;
  }
  const head = await command.run({
    file: 'git',
    args: ['-C', repoDir, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
    timeoutMs: 15_000,
  });
  if (!head.timedOut && head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim();
  return 'main';
}

async function ensureCleanClone(command: CommandRunner, repoDir: string, forkUrl: string): Promise<string> {
  const probe = await command.run({
    file: 'git',
    args: ['-C', repoDir, 'rev-parse', '--is-inside-work-tree'],
    timeoutMs: 15_000,
  });
  if (probe.timedOut || probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
    const parent = repoDir.slice(0, repoDir.lastIndexOf('/'));
    if (parent) await ensureDir(command, parent);
    await execOrThrow(command, `git clone ${forkUrl}`, {
      file: 'git',
      args: ['clone', '--no-single-branch', forkUrl, repoDir],
      timeoutMs: 120_000,
    });
    return detectDefaultBranch(command, repoDir);
  }
  // Ensure remote URL matches, clear any interrupted merge, and reset to origin's default branch.
  await execOrThrow(command, 'git remote set-url origin', {
    file: 'git',
    args: ['-C', repoDir, 'remote', 'set-url', 'origin', forkUrl],
    timeoutMs: 15_000,
  });
  await command.run({ file: 'git', args: ['-C', repoDir, 'merge', '--abort'], timeoutMs: 15_000 });
  await execOrThrow(command, 'git fetch origin', {
    file: 'git',
    args: ['-C', repoDir, 'fetch', '--prune', 'origin'],
    timeoutMs: 120_000,
  });
  const defaultBranch = await detectDefaultBranch(command, repoDir);
  await execOrThrow(command, `git checkout ${defaultBranch}`, {
    file: 'git',
    args: ['-C', repoDir, 'checkout', '-B', defaultBranch, `origin/${defaultBranch}`],
    timeoutMs: 30_000,
  });
  await execOrThrow(command, 'git reset --hard', {
    file: 'git',
    args: ['-C', repoDir, 'reset', '--hard', `origin/${defaultBranch}`],
    timeoutMs: 30_000,
  });
  // `git clean -fd` preserves .gitignore'd entries like `.grafts/.cache/`.
  await execOrThrow(command, 'git clean -fd', {
    file: 'git',
    args: ['-C', repoDir, 'clean', '-fd'],
    timeoutMs: 30_000,
  });
  return defaultBranch;
}

function parseGraftReport(stdout: string): GraftSyncJsonReport | undefined {
  const start = stdout.indexOf('{');
  if (start < 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start)) as GraftSyncJsonReport;
  } catch {
    return undefined;
  }
}

async function writeText(command: CommandRunner, filePath: string, content: string): Promise<void> {
  await execOrThrow(command, `write ${filePath}`, {
    file: 'node',
    args: [
      '-e',
      'const fs=require("node:fs"),p=require("node:path"); fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true}); fs.writeFileSync(process.argv[1], process.argv[2]);',
      filePath,
      content,
    ],
    timeoutMs: 15_000,
  });
}

async function resolveGraftCommand(command: CommandRunner, policy: ForkPolicy): Promise<string[]> {
  if (policy.graftCommand?.length) return policy.graftCommand;
  const probe = await command.run({ file: 'graft', args: ['--version'], timeoutMs: 10_000 });
  if (!probe.timedOut && probe.exitCode === 0) return ['graft'];
  return ['npx', '-y', '@graftsync/cli@latest'];
}

async function runGraftSync(
  command: CommandRunner,
  repoDir: string,
  targetVersion: string,
  graftCmd: string[],
): Promise<{
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  report?: GraftSyncJsonReport;
}> {
  const [file, ...prefixArgs] = graftCmd;
  const res = await command.run({
    file: file!,
    args: [...prefixArgs, 'sync', '--version', targetVersion, '--json'],
    cwd: repoDir,
    timeoutMs: 180_000,
  });
  return { ...res, report: parseGraftReport(res.stdout) };
}

function isZeroConflictPackageJsonOnly(report: GraftSyncJsonReport): boolean {
  const needing = report.grafts.filter((g) => g.outcome === 'needs-agent');
  if (needing.length !== 1) return false;
  const g = needing[0]!;
  if (!g.anchors || g.anchors.errors.length > 0) return false;
  const missed = g.anchors.anchors.filter((a) => !a.matched);
  if (!missed.length || !missed.every((a) => a.file === 'package.json')) return false;
  const start = g.agentStart;
  return Boolean(start?.repo && start.ref && start.upstream && Array.isArray(start.conflicts) && start.conflicts.length === 0);
}

async function openAgentMerge(
  command: CommandRunner,
  repoDir: string,
  start: { repo: string; ref: string; upstream: string },
): Promise<void> {
  await execOrThrow(command, 'git fetch -agent branch', {
    file: 'git',
    args: ['-C', repoDir, 'fetch', '--quiet', start.repo, start.ref],
    timeoutMs: 60_000,
  });
  await execOrThrow(command, 'git merge upstream (-agent branch)', {
    file: 'git',
    args: ['-C', repoDir, 'merge', '--no-ff', '--no-commit', '-s', 'ours', '--allow-unrelated-histories', start.upstream],
    timeoutMs: 60_000,
  });
  await execOrThrow(command, 'git read-tree -agent branch', {
    file: 'git',
    args: ['-C', repoDir, 'read-tree', '-u', '--reset', 'FETCH_HEAD'],
    timeoutMs: 60_000,
  });
}

async function abortAndReset(command: CommandRunner, repoDir: string, defaultBranch: string): Promise<void> {
  await command.run({ file: 'git', args: ['-C', repoDir, 'merge', '--abort'], timeoutMs: 15_000 });
  await execOrThrow(command, 'git reset after aborted merge', {
    file: 'git',
    args: ['-C', repoDir, 'reset', '--hard', `origin/${defaultBranch}`],
    timeoutMs: 30_000,
  });
  await execOrThrow(command, 'git clean after aborted merge', {
    file: 'git',
    args: ['-C', repoDir, 'clean', '-fd'],
    timeoutMs: 30_000,
  });
}

function buildAgentPrompt(input: {
  forkKodyId: string;
  upstreamKodyId: string;
  targetVersion: string;
  conflicts: string[];
  reportPath: string;
}): string {
  const conflictList = input.conflicts.length
    ? input.conflicts.map((f) => `- ${f}`).join('\n')
    : '- (none; check missed anchors in sync.md)';
  return [
    `\`graft sync\` reported \`needs-agent\` while syncing ${input.forkKodyId} to ${input.upstreamKodyId}@${input.targetVersion}.`,
    '',
    `Read \`${input.reportPath}\` and \`.grafts/upstream-sync/graft.md\` (especially Why and Invariants).`,
    'This working tree already has the open merge with conflict markers in place:',
    conflictList,
    '',
    'Instructions:',
    '1. Resolve the conflict markers (or missed anchors) while preserving every Invariant in `graft.md`.',
    '2. Keep the permanent `./variants/fork.json` variant — do not write a new variant.',
    "3. Never write `kody:` followed by another user's `@scope/` inside `graft.md` or docs.",
    `4. Verify with \`graft sync --version ${input.targetVersion}\` and the package's tests without weakening them.`,
    '5. Do not commit or push — leave the resolved working tree ready for Graft to re-verify and conclude the merge.',
    '',
  ].join('\n');
}

async function adoptAndCommit(
  command: CommandRunner,
  repoDir: string,
  fetch: { repo: string; ref: string; upstream: string },
  message: string,
  alreadyMerging = false,
): Promise<string> {
  await execOrThrow(command, 'git fetch materialized graft result', {
    file: 'git',
    args: ['-C', repoDir, 'fetch', '--quiet', fetch.repo, fetch.ref],
    timeoutMs: 60_000,
  });
  if (!alreadyMerging) {
    await execOrThrow(command, 'git merge upstream commit', {
      file: 'git',
      args: ['-C', repoDir, 'merge', '--no-ff', '--no-commit', '-s', 'ours', '--allow-unrelated-histories', fetch.upstream],
      timeoutMs: 60_000,
    });
  }
  await execOrThrow(command, 'git read-tree result', {
    file: 'git',
    args: ['-C', repoDir, 'read-tree', '-u', '--reset', 'FETCH_HEAD'],
    timeoutMs: 60_000,
  });
  await execOrThrow(command, 'git commit adopted sync', {
    file: 'git',
    args: ['-C', repoDir, 'commit', '--no-verify', '-m', message],
    timeoutMs: 30_000,
  });
  return (await execOrThrow(command, 'git rev-parse HEAD', { file: 'git', args: ['-C', repoDir, 'rev-parse', 'HEAD'] })).trim();
}

/**
 * Run a deterministic Graft sync for one `community.fork.upstream_updated` event on a Kody
 * Execution Context, persist the run record (when `storage` is given), and optionally publish or
 * emit a downstream completion event.
 */
export async function syncForkFromUpstreamEvent(event: CommunityForkUpstreamUpdatedEvent, deps: SyncDependencies): Promise<SyncRunRecord> {
  const now = (deps.now ?? (() => new Date()))();
  let forkKodyId = event.fork.kody_id;
  if (!KODY_ID_RE.test(forkKodyId) && event.fork.package_id && deps.resolvePackageName) {
    const resolved = await deps.resolvePackageName(event.fork.package_id);
    if (resolved) forkKodyId = resolved;
  }
  const upstreamKodyId = event.listing.name || event.listing.kody_id;
  const toCommit = event.current.pinned_commit;
  const fromCommit = event.fork.origin_commit || event.previous.pinned_commit || '';

  if (!KODY_ID_RE.test(forkKodyId)) throw new Error(`Invalid fork kody_id: "${forkKodyId}"`);
  if (!COMMIT_SHA_RE.test(toCommit)) throw new Error(`Invalid upstream pinned_commit: "${toCommit}"`);

  const shortSha = toCommit.slice(0, 12);
  const baseVer = semver.valid(event.current.package_version ?? '') ?? '0.0.0';
  const targetVersion = `${baseVer}+${toCommit}`;

  const policy = deps.policy ?? (deps.storage ? await getForkPolicy(deps.storage, forkKodyId) : undefined) ?? defaultPolicy(forkKodyId);

  const runId = `${event.event_id || 'manual'}-${shortSha}-${now.getTime()}`;
  const record: SyncRunRecord = {
    id: runId,
    eventId: event.event_id,
    forkKodyId,
    upstreamKodyId,
    fromCommit,
    toCommit,
    targetVersion,
    outcome: 'error',
    mode: policy.mode,
    conflicts: [],
    reasons: [],
    warnings: [],
    createdAt: now.toISOString(),
  };

  const finalize = async (): Promise<SyncRunRecord> => {
    if (deps.storage) await saveSyncRun(deps.storage, record);
    if (deps.emitter) {
      try {
        await deps.emitter.emit(record);
      } catch (err) {
        record.warnings.push(`downstream event emission failed: ${(err as Error).message}`);
        if (deps.storage) await saveSyncRun(deps.storage, record);
      }
    }
    return record;
  };

  try {
    const workspaceRoot = await resolveWorkspaceRoot(deps.command, policy);
    const [scope, leaf] = forkKodyId.split('/') as [string, string];
    const repoDir = joinPath(workspaceRoot, scope, leaf);
    const origin = (policy.kodyOrigin ?? DEFAULT_KODY_ORIGIN).replace(/\/+$/, '');
    const forkUrl = deps.forkGitUrl ?? `${origin}/${forkKodyId}.git`;

    const defaultBranch = await ensureCleanClone(deps.command, repoDir, forkUrl);

    // Non-grafted forks are ignored cleanly instead of erroring.
    const graftFiles = (
      await execOrThrow(deps.command, 'git ls-files .grafts/', {
        file: 'git',
        args: ['-C', repoDir, 'ls-files', '--', '.grafts/'],
        timeoutMs: 15_000,
      })
    ).trim();
    if (!graftFiles) {
      record.outcome = 'skipped-no-graft';
      record.reasons.push('fork does not contain .grafts/; skipping');
      return finalize();
    }

    const graftCmd = await resolveGraftCommand(deps.command, policy);
    let syncRun = await runGraftSync(deps.command, repoDir, targetVersion, graftCmd);
    let alreadyMerging = false;

    // Optional Kody-side workaround: zero-conflict package.json adjacency (e.g. version bump next to name rewrite).
    if (syncRun.exitCode === 1 && policy.allowZeroConflictPackageJson && syncRun.report && isZeroConflictPackageJsonOnly(syncRun.report)) {
      const start = syncRun.report.grafts.find((g) => g.outcome === 'needs-agent')!.agentStart!;
      await openAgentMerge(deps.command, repoDir, { repo: start.repo!, ref: start.ref!, upstream: start.upstream! });
      const recheck = await runGraftSync(deps.command, repoDir, targetVersion, graftCmd);
      if (recheck.exitCode === 0) {
        syncRun = recheck;
        alreadyMerging = true;
        record.warnings.push('adopted zero-conflict package.json merge and re-verified with graft sync');
      } else {
        await abortAndReset(deps.command, repoDir, defaultBranch);
      }
    }

    // Optional local coding agent hand-off on `needs-agent`: adopt `-agent` branch, run agentCommand,
    // then ALWAYS re-verify with `graft sync` (never trust the agent blindly).
    if (syncRun.exitCode === 1 && policy.agentCommand && syncRun.report) {
      const needing = syncRun.report.grafts.filter((g) => g.outcome === 'needs-agent');
      const start = needing.find((g) => g.agentStart?.repo && g.agentStart.ref && g.agentStart.upstream)?.agentStart;
      if (start?.repo && start.ref && start.upstream) {
        const reportMdPath = joinPath(repoDir, '.grafts', '.report', 'sync.md');
        const reportJsonPath = joinPath(repoDir, '.grafts', '.report', 'sync.json');
        const promptPath = joinPath(repoDir, '.grafts', '.report', 'agent-prompt.md');
        const conflicts = [...new Set(needing.flatMap((g) => g.agentStart?.conflicts ?? []))];
        await openAgentMerge(deps.command, repoDir, { repo: start.repo, ref: start.ref, upstream: start.upstream });
        await writeText(
          deps.command,
          promptPath,
          buildAgentPrompt({ forkKodyId, upstreamKodyId, targetVersion, conflicts, reportPath: reportMdPath }),
        );
        const agentRes = await deps.command.run({
          command: policy.agentCommand,
          cwd: repoDir,
          timeoutMs: 600_000,
          env: {
            GRAFT_PROMPT_FILE: promptPath,
            GRAFT_REPORT_MD: reportMdPath,
            GRAFT_REPORT_JSON: reportJsonPath,
            GRAFT_TARGET_VERSION: targetVersion,
            GRAFT_CONFLICTS: conflicts.join(','),
            GRAFT_FORK_ID: forkKodyId,
            GRAFT_UPSTREAM_ID: upstreamKodyId,
          },
        });
        record.agentRan = true;
        if (agentRes.timedOut || agentRes.exitCode !== 0) {
          record.warnings.push(failMessage(`agentCommand \`${policy.agentCommand}\``, agentRes));
          await abortAndReset(deps.command, repoDir, defaultBranch);
        } else {
          // Verify no conflict markers remain in tracked files (`read-tree` staged the markers
          // into the index, so `git diff --check` alone would miss them) and `graft sync` passes.
          const markers = await deps.command.run({
            file: 'git',
            args: ['-C', repoDir, 'grep', '-n', '-E', '^(<{7} |={7}$|>{7} )'],
            timeoutMs: 15_000,
          });
          const hasMarkers = markers.exitCode === 0 && markers.stdout.trim().length > 0;
          const recheck = hasMarkers ? undefined : await runGraftSync(deps.command, repoDir, targetVersion, graftCmd);
          if (!hasMarkers && recheck?.exitCode === 0 && recheck.report) {
            syncRun = recheck;
            alreadyMerging = true;
          } else {
            record.warnings.push(
              hasMarkers
                ? 'agentCommand exited 0 but left conflict markers in the working tree; aborting'
                : 'agentCommand exited 0 but re-running graft sync was still not green; aborting',
            );
            await abortAndReset(deps.command, repoDir, defaultBranch);
          }
        }
      }
    }

    if (syncRun.exitCode === 0 && syncRun.report) {
      const green = syncRun.report.grafts.find((g) => g.outcome === 'green' && g.materialized?.fetch);
      const fetch = green?.materialized?.fetch;
      if (!fetch?.repo || !fetch.ref || !fetch.upstream) {
        record.outcome = 'error';
        record.reasons.push('graft sync exited 0 but returned no fetchable repo-mode fork result');
        return finalize();
      }

      const commitSha = await adoptAndCommit(
        deps.command,
        repoDir,
        { repo: fetch.repo, ref: fetch.ref, upstream: fetch.upstream },
        `chore(graft): sync ${upstreamKodyId} to ${shortSha}`,
        alreadyMerging,
      );

      if (policy.testCommand) {
        const testRes = await deps.command.run({
          command: policy.testCommand,
          cwd: repoDir,
          timeoutMs: 300_000,
        });
        if (testRes.timedOut || testRes.exitCode !== 0) {
          await execOrThrow(deps.command, 'git reset after test failure', {
            file: 'git',
            args: ['-C', repoDir, 'reset', '--hard', `origin/${defaultBranch}`],
            timeoutMs: 30_000,
          });
          record.outcome = 'needs-agent';
          record.reasons.push(failMessage(`testCommand \`${policy.testCommand}\``, testRes));
          return finalize();
        }
      }

      const targetBranch = policy.mode === 'branch' ? `graft/sync-${shortSha}` : defaultBranch;
      const pushArgs =
        policy.mode === 'branch'
          ? ['-C', repoDir, 'push', '--force-with-lease', 'origin', `HEAD:refs/heads/${targetBranch}`]
          : ['-C', repoDir, 'push', 'origin', `HEAD:refs/heads/${targetBranch}`];
      await execOrThrow(deps.command, `git push ${targetBranch}`, {
        file: 'git',
        args: pushArgs,
        timeoutMs: 60_000,
      });

      record.outcome = 'green';
      record.branch = targetBranch;
      record.commit = commitSha;

      if (policy.mode === 'publish') {
        if (!deps.publisher) {
          record.warnings.push('policy mode is "publish" but no publisher was provided; commit was pushed without publishing');
        } else {
          const pubInput = event.fork.package_id ? { package_id: event.fork.package_id } : { kody_id: forkKodyId };
          const pub = await deps.publisher.publish(pubInput);
          record.publishStatus = pub.status;
          if (pub.approval_url) record.approvalUrl = pub.approval_url;
          if (pub.status !== 'published' && pub.status !== 'already_published' && pub.status !== 'dispatched') {
            record.warnings.push(`publish returned status "${pub.status}"${pub.error ? `: ${pub.error}` : ''}`);
          }
        }
      }
      return finalize();
    }

    if (syncRun.exitCode === 1 && syncRun.report) {
      record.outcome = 'needs-agent';
      const needing = syncRun.report.grafts.filter((g) => g.outcome === 'needs-agent');
      record.reasons = needing.flatMap((g) => g.reasons);
      record.conflicts = [...new Set(needing.flatMap((g) => g.agentStart?.conflicts ?? []))];
      record.reportMd = await readTextIfExists(deps.command, joinPath(repoDir, '.grafts', '.report', 'sync.md'));

      const start = needing.find((g) => g.agentStart?.repo && g.agentStart?.ref)?.agentStart;
      if (policy.pushAgentBranch !== false && start?.repo && start.ref) {
        const agentBranch = `graft/agent-${shortSha}`;
        await execOrThrow(deps.command, 'git fetch -agent branch for push', {
          file: 'git',
          args: ['-C', repoDir, 'fetch', '--quiet', start.repo, start.ref],
          timeoutMs: 60_000,
        });
        await execOrThrow(deps.command, `git push ${agentBranch}`, {
          file: 'git',
          args: ['-C', repoDir, 'push', '--force-with-lease', 'origin', `FETCH_HEAD:refs/heads/${agentBranch}`],
          timeoutMs: 60_000,
        });
        record.branch = agentBranch;
      }
      return finalize();
    }

    // Exit 2 (tooling error) or unexpected non-JSON failure.
    record.outcome = 'error';
    const reportReasons = syncRun.report?.grafts.flatMap((g) => (g.outcome === 'error' ? g.reasons : [])) ?? [];
    record.reasons = reportReasons.length ? reportReasons : [failMessage('graft sync', syncRun)];
    return finalize();
  } catch (err) {
    record.outcome = 'error';
    record.reasons.push((err as Error).message);
    return finalize();
  }
}
